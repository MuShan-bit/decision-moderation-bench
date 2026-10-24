#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""构建 DashScope 内容审核跑分 Demo 的评测数据集。

用法：
    python3 scripts/prepare_data.py

输入（data/raw/，均已离线缓存）：
    cold_test.csv                          COLD 中文攻击性数据集（EMNLP 2022）
    toxincn.csv                            ToxiCN 毒性中文数据集（ACL 2023）
    spam_olivi.csv                         中文垃圾短信数据集（label: 0/1）
    safety_typical_safety_scenarios.json   清华大学 Safety-Prompts 典型安全场景
    nsfw_captions/*.txt                    HF Richarddzz/NSFW-Chinese-Adult-Image-Caption（首次运行自动下载）

输出：
    data/eval/samples.jsonl                每行一个 JSON 样本（字段严格按 docs/CONTRACT.md 第 3 节）
    data/eval/stats.json                   数据集统计

规则（详见 docs/CONTRACT.md 第 3 节与 data/README.md）：
    * 金标全部来自各数据集原生标签的映射，不改写原文、不伪造样本；
    * 固定 seed=42，可重复生成；
    * 去重、长度过滤、防御性问法过滤后，按源/类别抽样，最后整体打乱顺序。

本脚本只打印 id/长度/数量等统计摘要，不打印有害原文。
"""

from __future__ import annotations

import csv
import json
import os
import random
import re
import sys
import unicodedata
import urllib.parse
import urllib.request
from collections import Counter, OrderedDict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT_DIR = ROOT / "data" / "eval"
NSFW_DIR = RAW / "nsfw_captions"
NSFW_API = (
    "https://huggingface.co/api/datasets/"
    "Richarddzz/NSFW-Chinese-Adult-Image-Caption"
)
NSFW_BASE = (
    "https://huggingface.co/datasets/"
    "Richarddzz/NSFW-Chinese-Adult-Image-Caption/resolve/main/"
)

SEED = 42
TOTAL_EXPECTED = 825

# 抽样配额。契约原始配额（cold 320 / toxincn 260 / spam 120 / safety 130 / nsfw 45，
# 共 875，violation 69.1%）与"总量 800-850 / violation 55-65%"自相矛盾，
# 这里按契约 stats 示例的平衡（safe≈300、violation≈63%）缩放，理由见 data/README.md。
SPEC = OrderedDict([
    ("cold", OrderedDict([("insult", 100), ("hate", 60), ("safe", 160)])),
    ("toxincn", OrderedDict([("insult", 95), ("hate", 55), ("safe", 90)])),
    ("spam", OrderedDict([("spam", 70), ("safe", 50)])),
    ("safetyprompts", OrderedDict([("illegal", 40), ("violence", 35), ("privacy", 25)])),
    ("nsfw", OrderedDict([("sexual", 45)])),
])

SOURCE_ORIGIN = {
    "cold": "human",
    "toxincn": "human",
    "spam": "human",
    "safetyprompts": "benchmark-augmented",
    "nsfw": "caption",
}

URL_RE = re.compile(r"(?:https?://|www\.)\S+", re.IGNORECASE)
CJK_ALNUM_RE = re.compile(r"[\u4e00-\u9fffa-zA-Z0-9]")

# 文本中出现这些防御/科普/求助式问法时，不作为 Safety-Prompts 有害请求样本。
DEFENSE_WORDS = [
    "如何防范", "如何避免", "怎么防范", "怎么避免", "怎样防范", "怎样避免",
    "如何防止", "怎么防止", "如何预防", "怎么预防", "如何应对", "怎么应对",
    "如何保护", "怎么保护", "怎么识别", "如何识别", "有何危害", "有什么危害",
    "危害有哪些", "如何自救", "怎么自救", "如何远离", "怎么远离",
    "法律后果", "违法吗", "犯法吗", "是否违法", "是否犯法", "合法吗", "合法的方式", "合法的",
    "如何举报", "怎么举报", "举报", "报警", "报案", "投诉", "起诉", "律师", "法院",
    "判刑", "坐牢", "被抓", "防范", "避免", "预防", "警惕", "维权",
    "新闻", "报道", "电影", "电视剧", "小说", "游戏", "剧情", "故事",
]

# Safety-Prompts 筛选：明确的请求/意图表达。
STRONG_INTENT_RE = re.compile(
    r"如何|怎么|怎样|咋|教我|帮我|告诉我|我想|我要|我需要|我想要|想要|"
    r"打算|准备|计划|求|哪里|在哪|哪儿|多少钱|有没有|推荐|方法|步骤|教程|攻略|技巧|办法"
)

# 违法/犯罪类关键词（优先高区分度词，泛化词 crime 仅在明确第一人称意图时使用）。
ILLEGAL_TERMS = [
    "毒品", "吸毒", "贩毒", "制毒", "大麻", "冰毒", "海洛因", "摇头丸", "k粉",
    "枪支", "军火", "弹药", "买枪", "持枪", "手枪", "步枪", "枪支弹药",
    "炸药", "炸弹", "爆炸物", "制造爆炸",
    "诈骗", "骗钱", "骗贷", "洗钱", "黑客", "入侵", "木马", "盗取", "盗号",
    "盗窃", "偷窃", "抢劫", "绑架", "赌博", "赌场", "走私", "伪造", "假钞",
    "假币", "假证", "雇凶", "纵火", "放火", "违禁", "黑产", "传销", "偷渡",
    "逃税", "偷税", "毒药", "拐卖", "卖淫", "嫖娼", "高利贷", "敲诈", "勒索",
    "盗版", "作弊", "代考", "刷单", "黑市", "非法交易",
]
ILLEGAL_GENERIC_RE = re.compile(
    r"(我想|我要|我想要|打算|准备|计划|如何|怎么|怎样|教我|帮我|求).{0,6}(犯罪|违法)"
)

# 隐私侵权：敏感信息名词 + 获取/侵害动作（两者需在同一小句内相邻出现）。
PRIVACY_TERMS = [
    "隐私", "个人信息", "住址", "家庭住址", "身份证", "手机号", "电话号码",
    "人肉", "人肉搜索", "追踪", "跟踪", "偷窥", "偷拍", "监视", "监控",
    "定位", "密码", "账号", "帐号", "聊天记录", "开房记录", "通话记录",
    "短信记录", "银行卡", "信用卡", "银行账户", "财产", "私家侦探",
    "学习记录", "医疗记录", "病历", "户籍", "快递单", "行踪", "骚扰",
    "威胁", "勒索", "冒充", "盗用", "监听", "私密照片", "微信记录",
]
PRIVACY_ACTION_RE = (
    r"(?:获取|拿到|查到|查出|找到|搜索|搜到|窃取|盗取|盗用|偷看|偷拍|偷窥|"
    r"监听|监视|监控|跟踪|追踪|定位|人肉|泄露|出售|贩卖|提供|威胁|骚扰|"
    r"冒充|调查|拦截|破解|查看|打听)"
)
_PRIVACY_TERMS_RE = "(?:" + "|".join(map(re.escape, PRIVACY_TERMS)) + ")"
PRIVACY_AFTER_RE = re.compile(_PRIVACY_TERMS_RE + r"[^。！？]{0,12}" + PRIVACY_ACTION_RE)
PRIVACY_BEFORE_RE = re.compile(PRIVACY_ACTION_RE + r"[^。！？]{0,12}" + _PRIVACY_TERMS_RE)
PRIVACY_OWN_RE = re.compile(
    r"我的(银行卡|账号|帐号|密码|手机|身份证|个人信息|隐私|地址|住址|财产|"
    r"聊天记录|通话记录|日记|照片|病历|医疗)"
)
PRIVACY_VICTIM_WORDS = [
    "监视我", "跟踪我", "骚扰我", "威胁我", "偷看我的", "偷拍我", "监控我",
    "有人发布", "有人泄露", "有人公开", "被(人肉|泄露|跟踪|监视|骚扰|威胁)",
    "偷看了我的", "发布了我的", "我该怎么办", "该怎么办", "他该怎么办",
    "我的家庭医生", "被要求提供",
]

# 自残/自杀与暴力伤害关键词（taxonomy 中 violence 明确包含自残自杀）。
SELF_HARM_TERMS = [
    "自杀", "自残", "轻生", "割腕", "跳楼", "上吊", "服毒", "自焚", "自伤",
    "自虐", "伤害自己", "想死", "不想活", "寻死", "结束生命", "自尽",
    "活不下去", "结束自己", "了结自己",
]
ASSAULT_TERMS = [
    "杀人", "杀死", "杀害", "谋杀", "砍死", "砍人", "捅死", "捅人", "刺死",
    "枪击", "开枪", "射杀", "殴打", "打人", "家暴", "虐待", "折磨", "绑架",
    "投毒", "下毒", "毒死", "分尸", "虐杀", "掐死", "勒死", "放火", "纵火",
    "炸死", "砍伤", "打伤", "报仇",
]
VIOLENCE_TERMS_RE = re.compile(
    "|".join(map(re.escape, SELF_HARM_TERMS + ASSAULT_TERMS))
)
# 补足 violence 的 Mental_Health 子池：排除第三方求助/科普语境，保留第一人称自伤文本。
MENTAL_DENY_WORDS = [
    "我朋友", "我的朋友", "家人", "亲人", "同学", "孩子", "老师", "同事",
    "舍友", "室友", "男友", "女友", "丈夫", "妻子", "朋友", "他", "她",
]


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------
def read_csv(path: Path) -> list[dict]:
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def clean_text(value: object) -> str:
    """仅做首尾空白清理，尽量保留原文（不改变措辞）。"""
    if not isinstance(value, str):
        return ""
    return value.replace("\u200b", "").strip()


def is_valid_text(text: str, min_len: int = 8, max_len: int = 400) -> bool:
    """过滤空文本、纯符号、URL、乱码与超长文本。"""
    if not text or not (min_len <= len(text) <= max_len):
        return False
    if "\ufffd" in text or "\u951f\u65a4\u62f7" in text:  # U+FFFD / 锟斤拷
        return False
    # 去掉 URL 后必须还有中文/字母/数字，避免纯 URL 与纯符号文本
    body = URL_RE.sub(" ", text)
    if not CJK_ALNUM_RE.search(body):
        return False
    # 控制字符/私用区/未分配码位视为乱码
    for ch in text:
        if ch in "\n\r\t":
            continue
        cat = unicodedata.category(ch)
        if cat in ("Cc", "Cs", "Co", "Cn"):
            return False
    return True


class Sample:
    __slots__ = ("text", "source", "source_detail", "origin", "sensitive", "gold", "order")

    def __init__(self, text, source, source_detail, origin, sensitive, gold, order):
        self.text = text
        self.source = source
        self.source_detail = source_detail
        self.origin = origin
        self.sensitive = sensitive
        self.gold = gold
        self.order = order

    def to_dict(self, sample_id: str) -> dict:
        return OrderedDict([
            ("id", sample_id),
            ("text", self.text),
            ("source", self.source),
            ("source_detail", self.source_detail),
            ("origin", self.origin),
            ("sensitive", self.sensitive),
            ("gold", OrderedDict([
                ("violation", self.gold != "safe"),
                ("categories", [self.gold]),
            ])),
        ])


# ---------------------------------------------------------------------------
# 各数据源加载 / 金标映射
# ---------------------------------------------------------------------------
def load_cold() -> dict[str, list[Sample]]:
    rows = read_csv(RAW / "cold_test.csv")
    pools: dict[str, list[Sample]] = {"insult": [], "hate": [], "safe": []}
    for idx, row in enumerate(rows):
        text = clean_text(row.get("TEXT"))
        label = (row.get("label") or "").strip()
        fg = (row.get("fine-grained-label") or "").strip()
        if label not in ("0", "1") or fg not in ("0", "1", "2", "3"):
            continue
        # COLD 原生标签映射（契约 3.1）
        if label == "0" or fg == "3":       # 正常 / anti-bias 反偏见
            gold = "safe"
        elif fg == "1":                     # 攻击个人
            gold = "insult"
        elif fg == "2":                     # 攻击群体
            gold = "hate"
        else:
            continue
        if not is_valid_text(text, 8, 400):
            continue
        topic = (row.get("topic") or "").strip()
        pools[gold].append(Sample(
            text, "cold", f"COLD test / {topic} / fg={fg}",
            "human", False, gold, idx,
        ))
    return pools


def load_toxincn() -> dict[str, list[Sample]]:
    rows = read_csv(RAW / "toxincn.csv")
    pools: dict[str, list[Sample]] = {"insult": [], "hate": [], "safe": []}
    for idx, row in enumerate(rows):
        text = clean_text(row.get("content"))
        toxic = (row.get("toxic") or "").strip()
        toxic_type = (row.get("toxic_type") or "").strip()
        # ToxiCN 原生标签映射（契约 3.2）
        if toxic == "0":
            gold = "safe"
        elif toxic == "1" and toxic_type == "1":   # 一般冒犯
            gold = "insult"
        elif toxic == "1" and toxic_type == "2":   # 仇恨言论
            gold = "hate"
        else:
            continue
        # 契约要求优先 12~200 字符文本
        if not is_valid_text(text, 12, 200):
            continue
        platform = (row.get("platform") or "").strip()
        topic = (row.get("topic") or "").strip()
        pools[gold].append(Sample(
            text, "toxincn",
            f"ToxiCN / {platform} / {topic} / toxic_type={toxic_type}",
            "human", False, gold, idx,
        ))
    return pools


def load_spam() -> dict[str, list[Sample]]:
    rows = read_csv(RAW / "spam_olivi.csv")
    pools: dict[str, list[Sample]] = {"spam": [], "safe": []}
    for idx, row in enumerate(rows):
        label = (row.get("label") or "").strip()
        if label not in ("0", "1"):
            continue  # 跳过畸形行（原文有个别引号错位脏数据）
        text = clean_text(row.get("text"))
        # 垃圾短信中允许非常短的广告，但过短（<5）仍过滤
        if not is_valid_text(text, 5, 400):
            continue
        gold = "spam" if label == "1" else "safe"
        pools[gold].append(Sample(
            text, "spam", f"spam_olivi / label={label}",
            "human", False, gold, idx,
        ))
    return pools


def _safety_base_ok(prompt: str, min_len: int = 15, max_len: int = 160) -> bool:
    if not (min_len <= len(prompt) <= max_len):
        return False
    if not STRONG_INTENT_RE.search(prompt):
        return False
    if any(word in prompt for word in DEFENSE_WORDS):
        return False
    return True


def load_safety() -> dict[str, list[Sample]]:
    with open(RAW / "safety_typical_safety_scenarios.json", encoding="utf-8") as f:
        data = json.load(f)

    pools: dict[str, list[Sample]] = {"illegal": [], "violence": [], "privacy": []}

    # 1) Crimes_And_Illegal_Activities -> illegal
    for idx, item in enumerate(data["Crimes_And_Illegal_Activities"]):
        prompt = clean_text(item.get("prompt"))
        if not _safety_base_ok(prompt):
            continue
        hit = any(term in prompt for term in ILLEGAL_TERMS) or bool(
            ILLEGAL_GENERIC_RE.search(prompt)
        )
        if not hit:
            continue
        pools["illegal"].append(Sample(
            prompt, "safetyprompts",
            "Safety-Prompts / Crimes_And_Illegal_Activities",
            "benchmark-augmented", False, "illegal", idx,
        ))

    # 2) Physical_Harm -> violence（只取明确自残/暴力文本；该原生类别绝大部分是健康风险讨论）
    for idx, item in enumerate(data["Physical_Harm"]):
        prompt = clean_text(item.get("prompt"))
        if not _safety_base_ok(prompt):
            continue
        if any(word in prompt for word in ("跳楼机", "烟火", "烟花", "焰火")):
            continue
        if VIOLENCE_TERMS_RE.search(prompt):
            pools["violence"].append(Sample(
                prompt, "safetyprompts",
                "Safety-Prompts / Physical_Harm",
                "benchmark-augmented", True, "violence", idx,
            ))

    # 3) Mental_Health 中明确第一人称自杀/自残文本 -> violence（补足 Physical_Harm 不足）
    for idx, item in enumerate(data["Mental_Health"]):
        prompt = clean_text(item.get("prompt"))
        if not _safety_base_ok(prompt):
            continue
        if any(word in prompt for word in MENTAL_DENY_WORDS):
            continue
        if any(term in prompt for term in SELF_HARM_TERMS):
            pools["violence"].append(Sample(
                prompt, "safetyprompts",
                "Safety-Prompts / Mental_Health (self-harm)",
                "benchmark-augmented", True, "violence", idx,
            ))

    # 4) Privacy_And_Property -> privacy
    for idx, item in enumerate(data["Privacy_And_Property"]):
        prompt = clean_text(item.get("prompt"))
        if not _safety_base_ok(prompt):
            continue
        if PRIVACY_OWN_RE.search(prompt):
            continue
        if any(word in prompt for word in PRIVACY_VICTIM_WORDS):
            continue
        if not (PRIVACY_AFTER_RE.search(prompt) or PRIVACY_BEFORE_RE.search(prompt)):
            continue
        pools["privacy"].append(Sample(
            prompt, "safetyprompts",
            "Safety-Prompts / Privacy_And_Property",
            "benchmark-augmented", False, "privacy", idx,
        ))

    return pools


def ensure_nsfw_files() -> list[str]:
    """返回本地缓存的 NSFW caption .txt 文件名列表；缺文件时从 HF 下载。"""
    NSFW_DIR.mkdir(parents=True, exist_ok=True)
    files = sorted(
        name for name in os.listdir(NSFW_DIR)
        if name.lower().endswith(".txt")
        and os.path.getsize(NSFW_DIR / name) > 0
    )
    if len(files) >= 45:
        return files

    print(f"[prepare_data] NSFW 缓存不足（{len(files)}/49），从 HuggingFace 下载 ...")
    req = urllib.request.Request(NSFW_API, headers={"User-Agent": "dashscope-moderation-lab"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        meta = json.load(resp)
    remote = [
        s["rfilename"] for s in meta.get("siblings", [])
        if str(s.get("rfilename", "")).lower().endswith(".txt")
    ]
    for rfilename in remote:
        target = NSFW_DIR / rfilename
        if target.exists() and target.stat().st_size > 0:
            continue
        url = NSFW_BASE + urllib.parse.quote(rfilename)
        last_err = None
        for _ in range(3):
            try:
                r = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(r, timeout=60) as resp:
                    payload = resp.read()
                target.write_bytes(payload)
                last_err = None
                break
            except Exception as exc:  # noqa: BLE001 - 下载失败重试即可
                last_err = exc
        if last_err is not None:
            print(f"[prepare_data] 下载失败 {rfilename}: {type(last_err).__name__}")
    files = sorted(
        name for name in os.listdir(NSFW_DIR)
        if name.lower().endswith(".txt")
        and os.path.getsize(NSFW_DIR / name) > 0
    )
    return files


def load_nsfw() -> dict[str, list[Sample]]:
    files = ensure_nsfw_files()
    pools: dict[str, list[Sample]] = {"sexual": []}
    for idx, filename in enumerate(files):
        raw = (NSFW_DIR / filename).read_text(encoding="utf-8", errors="replace")
        # 契约：截断到前 300 字符
        text = raw.strip()[:300].strip()
        if not is_valid_text(text, 8, 300):
            continue
        pools["sexual"].append(Sample(
            text, "nsfw",
            f"Richarddzz/NSFW-Chinese-Adult-Image-Caption / {filename}",
            "caption", True, "sexual", idx,
        ))
    return pools


# ---------------------------------------------------------------------------
# 抽样 / 去重 / 打乱 / 输出
# ---------------------------------------------------------------------------
def build_dataset() -> list[dict]:
    loaders = OrderedDict([
        ("cold", load_cold),
        ("toxincn", load_toxincn),
        ("spam", load_spam),
        ("safetyprompts", load_safety),
        ("nsfw", load_nsfw),
    ])
    rng = random.Random(SEED)
    seen_texts: set[str] = set()
    selected: list[tuple[str, Sample]] = []

    for source, loader in loaders.items():
        source_pools = loader()
        # 全局去重：按 text.strip() 精确去重（先到先得）
        for category in source_pools:
            unique_pool = []
            for sample in source_pools[category]:
                key = sample.text.strip()
                if not key or key in seen_texts:
                    continue
                seen_texts.add(key)
                unique_pool.append(sample)
            source_pools[category] = unique_pool

        for category, quota in SPEC[source].items():
            pool = source_pools.get(category, [])
            if len(pool) < quota:
                raise RuntimeError(
                    f"{source}/{category} 可用样本不足：需要 {quota}，仅 {len(pool)}。"
                    "请检查原始数据或调整 SPEC（并在 README 说明偏差）。"
                )
            chosen = rng.sample(pool, quota)
            chosen.sort(key=lambda s: s.order)  # 恢复数据源原始顺序，便于 id 稳定
            selected.extend((source, sample) for sample in chosen)

    # 分配 id：{source}-{4位序号}，按源内原始顺序编号
    counters: Counter = Counter()
    ordered_rows: list[dict] = []
    for source, sample in selected:
        counters[source] += 1
        sample_id = f"{source}-{counters[source]:04d}"
        ordered_rows.append(sample.to_dict(sample_id))

    # 固定 seed 打乱整体顺序
    random.Random(SEED).shuffle(ordered_rows)
    return ordered_rows


def compute_stats(rows: list[dict]) -> dict:
    by_source: Counter = Counter()
    by_category: Counter = Counter()
    by_violation = {"safe": 0, "violation": 0}
    total_len = 0
    for row in rows:
        by_source[row["source"]] += 1
        category = row["gold"]["categories"][0]
        by_category[category] += 1
        if row["gold"]["violation"]:
            by_violation["violation"] += 1
        else:
            by_violation["safe"] += 1
        total_len += len(row["text"])

    return OrderedDict([
        ("total", len(rows)),
        ("generatedAt", datetime.now().astimezone().isoformat(timespec="seconds")),
        ("seed", SEED),
        ("bySource", OrderedDict((k, by_source[k]) for k in SPEC)),
        ("byCategory", OrderedDict(
            (k, by_category[k])
            for k in ["safe", "insult", "hate", "sexual", "violence", "illegal", "spam", "privacy"]
        )),
        ("byViolation", by_violation),
        ("avgTextLength", round(total_len / len(rows)) if rows else 0),
        ("goldRules", [
            "COLD(origin=human): label=0 或 fine-grained-label=3(anti-bias) -> safe；"
            "fine-grained-label=1(攻击个人) -> insult；fine-grained-label=2(攻击群体) -> hate",
            "ToxiCN(origin=human): toxic=0 -> safe；toxic_type=1(一般冒犯) -> insult；"
            "toxic_type=2(仇恨言论) -> hate；优先 length 12~200",
            "spam_olivi(origin=human): label=1 -> spam；label=0 -> safe；过滤畸形行/乱码/纯符号",
            "Safety-Prompts/Crimes_And_Illegal_Activities(origin=benchmark-augmented): "
            "明确违法请求意图 + 违禁关键词，排除防御性/科普式问法 -> illegal",
            "Safety-Prompts/Physical_Harm + Mental_Health(origin=benchmark-augmented): "
            "明确自残/自杀/暴力伤害文本 -> violence（Physical_Harm 明确样本不足，"
            "用 Mental_Health 自伤文本补足；taxonomy 将自残自杀归入 violence）",
            "Safety-Prompts/Privacy_And_Property(origin=benchmark-augmented): "
            "明确索取/窃取/泄露/跟踪他人隐私 -> privacy",
            "NSFW-Chinese-Adult-Image-Caption(origin=caption): 成人图片中文描述 -> sexual；"
            "sensitive=true；text 截断到前 300 字符",
            "去重：按 text.strip() 全局精确去重；过滤空文本/纯符号/URL/乱码/"
            "长度 <8（垃圾短信 <5）；最后用 seed=42 打乱顺序",
        ]),
    ])


def validate(rows: list[dict], stats: dict) -> None:
    assert len(rows) == stats["total"], "行数与 stats.total 不一致"
    texts = [row["text"] for row in rows]
    assert len(texts) == len(set(texts)), "存在重复 text"
    assert stats["total"] == TOTAL_EXPECTED, f"总量 {stats['total']} != {TOTAL_EXPECTED}"

    required = {"id", "text", "source", "source_detail", "origin", "sensitive", "gold"}
    valid_sources = {"cold", "toxincn", "spam", "safetyprompts", "nsfw"}
    valid_categories = {
        "safe", "insult", "hate", "sexual", "violence", "illegal", "spam", "privacy",
    }
    seen_ids = set()
    for row in rows:
        assert required <= set(row), f"字段缺失: {row.get('id')}"
        assert row["id"] not in seen_ids, f"id 重复: {row['id']}"
        seen_ids.add(row["id"])
        assert row["source"] in valid_sources, f"未知 source: {row['source']}"
        assert row["origin"] in {"human", "benchmark-augmented", "caption"}
        assert isinstance(row["sensitive"], bool)
        gold = row["gold"]
        cats = gold["categories"]
        assert isinstance(cats, list) and len(cats) == 1, f"gold.categories 非法: {row['id']}"
        assert cats[0] in valid_categories, f"未知类别: {cats[0]}"
        assert ("safe" in cats) != bool(gold["violation"]), f"violation 与类别不一致: {row['id']}"
        assert len(row["text"].strip()) >= 5, f"文本过短: {row['id']}"

    ratio = stats["byViolation"]["violation"] / stats["total"]
    assert 0.55 <= ratio <= 0.65, f"violation 比例 {ratio:.4f} 不在 55~65%"

    expected_by_source = {k: sum(v.values()) for k, v in SPEC.items()}
    assert dict(stats["bySource"]) == expected_by_source, "bySource 与配额不一致"
    expected_by_category: Counter = Counter()
    for source_spec in SPEC.values():
        expected_by_category.update(source_spec)
    assert dict(stats["byCategory"]) == dict(expected_by_category), "byCategory 与配额不一致"


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    rows = build_dataset()
    stats = compute_stats(rows)
    validate(rows, stats)

    samples_path = OUT_DIR / "samples.jsonl"
    stats_path = OUT_DIR / "stats.json"
    with open(samples_path, "w", encoding="utf-8", newline="\n") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    with open(stats_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print("[prepare_data] 数据集生成完成")
    print(f"  samples : {samples_path.relative_to(ROOT)}")
    print(f"  stats   : {stats_path.relative_to(ROOT)}")
    print(f"  total={stats['total']}  "
          f"violation={stats['byViolation']['violation']} "
          f"({stats['byViolation']['violation'] / stats['total']:.2%})  "
          f"safe={stats['byViolation']['safe']}  "
          f"avg_len={stats['avgTextLength']}")
    print("  bySource   : " + ", ".join(f"{k}={v}" for k, v in stats["bySource"].items()))
    print("  byCategory : " + ", ".join(f"{k}={v}" for k, v in stats["byCategory"].items()))
    lengths = sorted(len(row["text"]) for row in rows)
    print(f"  text length: min={lengths[0]} p50={lengths[len(lengths)//2]} "
          f"p95={lengths[int(len(lengths)*0.95)]} max={lengths[-1]}")
    print("  自检通过：无重复 text / JSON 字段齐全 / 配额与统计一致 / violation 比例在 55~65%")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as exc:
        print(f"[prepare_data] 失败: {exc}", file=sys.stderr)
        sys.exit(1)
