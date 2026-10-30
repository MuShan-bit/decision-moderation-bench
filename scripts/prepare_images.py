#!/usr/bin/env python3
"""把文本审核样本渲染成"用户聊天截图 / 帖子截图"，产出图像审核评测集。

仅数据准备脚本（运行时项目仍零依赖），只依赖 Pillow + 标准库。

用法：
  python3 scripts/prepare_images.py
  python3 scripts/prepare_images.py --per-category 15 --seed 42
  python3 scripts/prepare_images.py --eval data/eval/samples.jsonl --out data/images

产物（<out>/ 下）：
  <id>.png            每条样本一张 640 宽、480-720 高的 PNG 截图（图内只有版式文本）
  samples.jsonl       图像评测清单（含 image / content_text）
  text_baseline.jsonl 纯文本对照清单（同 id、同原始文本、同 gold）
  README.md           数据集卡

约定：
  - 选样按类别独立确定性抽样（seed 固定），类别桶互斥；
  - 原始文本 100% 完整渲染、不截断：字号 14-20 动态选择 + 图片高度 480-720 自适应；
  - 逐字字体回退（主字体缺字时用符号/emoji 字体补），仍无法渲染的候选样本在抽样阶段剔除；
  - 聊天类（cold / toxincn / spam）用聊天气泡版式，其余（nsfw / safetyprompts）用帖子卡片版式；
  - 同 seed 重跑结果一致（选样与 Pillow 渲染均为确定性的）。
"""

from __future__ import annotations

import argparse
import json
import random
import zlib
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Sequence, Tuple

from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent

DEFAULT_EVAL = REPO_ROOT / "data" / "eval" / "samples.jsonl"
DEFAULT_OUT = REPO_ROOT / "data" / "images"
DEFAULT_PER_CATEGORY = 15
DEFAULT_SEED = 42

# 类别顺序固定，保证抽样与清单顺序可复现
CATEGORY_ORDER: Tuple[str, ...] = (
    "insult",
    "hate",
    "sexual",
    "violence",
    "illegal",
    "spam",
    "privacy",
    "safe",
)

# 版式：聊天 vs 帖子（按原始 source 决定）
CHAT_SOURCES = frozenset({"cold", "toxincn", "spam"})
POST_SOURCES = frozenset({"nsfw", "safetyprompts"})

TEXT_CHAT = "这是一张用户聊天截图，请审核图片中的内容。"
TEXT_POST = "这是一张用户发布的帖子截图，请审核图片中的内容。"

# 画布与排版
WIDTH = 640
TOP_BAR_H = 60
MIN_HEIGHT = 480
MAX_HEIGHT = 720
OUTER_MARGIN = 24

FONT_SIZES = (20, 19, 18, 17, 16, 15, 14)  # 由大到小尝试
MIN_FONT_SIZE = 14

PRIMARY_FONT = "/System/Library/Fonts/STHeiti Medium.ttc"
PRIMARY_FONT_INDEX = 1  # STHeiti Medium.ttc 含 Heiti TC(0) / Heiti SC(1)，简体用 SC
# 逐字回退字体：主字体缺字（如 ☀ / ₫ / emoji）时按顺序找第一个有该字形的字体
FALLBACK_FONTS: Tuple[Tuple[str, int], ...] = (
    ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 0),
    ("/System/Library/Fonts/Apple Symbols.ttf", 0),
    ("/System/Library/Fonts/Apple Color Emoji.ttc", 0),
    ("/System/Library/Fonts/Supplemental/Songti.ttc", 0),
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", 0),
)

# 配色
COLOR_BG = (255, 255, 255)
COLOR_TOPBAR_TEXT = (48, 49, 51)
COLOR_TOPBAR_SUB = (153, 161, 170)
COLOR_DIVIDER = (233, 235, 238)
COLOR_BUBBLE_BG = (242, 243, 245)
COLOR_BUBBLE_EDGE = (230, 233, 237)
COLOR_CARD_EDGE = (230, 232, 235)
COLOR_TEXT = (23, 24, 26)
COLOR_NICK = (90, 96, 104)
COLOR_AVATAR_BG = (199, 209, 220)
COLOR_AVATAR_FG = (247, 250, 253)

# PNG 体积控制：截图是"纯色 UI + 抗锯齿文字"，把颜色收敛到按 UI 定制的 16 色调色板，
# 既保持可读性又把单张压到 < 100KB（输出仍是 RGB PNG，只是颜色数收敛）。
PNG_PALETTE = (
    (255, 255, 255),
    (248, 249, 250),
    (242, 243, 245),
    (238, 240, 242),
    (232, 234, 237),
    (226, 229, 233),
    (214, 220, 226),
    (247, 250, 253),
    (199, 209, 220),
    (180, 188, 198),
    (150, 158, 168),
    (120, 128, 138),
    (96, 102, 110),
    (64, 68, 74),
    (48, 49, 51),
    (23, 24, 26),
)

# 简单禁则：行首不出现收尾标点，行尾不出现起首标点
FORBIDDEN_LINE_START = frozenset("。，、；：？！）】》」』”’%…·,.;:?!)]}")
FORBIDDEN_LINE_END = frozenset("（【《「『“‘([{")

# 用于探测"缺字"（notdef）的私用区/未分配码位
_NOTDEF_PROBES = ("\ue000", "\ue001", "\uf8ff", "\U0010fffd")


# ---------------------------------------------------------------------------
# 字体：主字体 + 逐字回退
# ---------------------------------------------------------------------------


def _mask_signature(font: ImageFont.FreeTypeFont, ch: str) -> Tuple[Tuple[int, int], bytes]:
    mask = font.getmask(ch)
    return (mask.size, bytes(mask))


def resolve_font() -> Tuple[str, int]:
    """主字体：STHeiti Medium.ttc（Heiti SC）；文件缺失时回退 Arial Unicode / Songti。"""
    candidates: Tuple[Tuple[str, int], ...] = (
        (PRIMARY_FONT, PRIMARY_FONT_INDEX),
        ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 0),
        ("/System/Library/Fonts/Supplemental/Songti.ttc", 0),
    )
    for path, index in candidates:
        if not Path(path).is_file():
            continue
        try:
            ImageFont.truetype(path, 20, index=index)
            return path, index
        except OSError:
            continue
    raise SystemExit("找不到可用的中文字体（已尝试 STHeiti / Arial Unicode / Songti）")


class FontBook:
    """按字号缓存字体，并提供逐字回退与像素级测宽。"""

    def __init__(self) -> None:
        primary = resolve_font()
        chain: List[Tuple[str, int]] = [primary]
        for path, index in FALLBACK_FONTS:
            if Path(path).is_file() and (path, index) != primary:
                chain.append((path, index))
        self.chain = tuple(chain)
        self._fonts: Dict[Tuple[str, int, int], ImageFont.FreeTypeFont] = {}
        self._notdef: Dict[Tuple[str, int], set] = {}
        self._has_glyph: Dict[Tuple[str, int, str], bool] = {}
        self._advance: Dict[Tuple[str, int, str], float] = {}
        self._font_for: Dict[Tuple[int, str], Optional[ImageFont.FreeTypeFont]] = {}

    # -- 字体对象 ---------------------------------------------------------
    def get(self, path: str, index: int, size: int) -> ImageFont.FreeTypeFont:
        key = (path, index, size)
        font = self._fonts.get(key)
        if font is None:
            font = ImageFont.truetype(path, size, index=index)
            self._fonts[key] = font
        return font

    def primary(self, size: int) -> ImageFont.FreeTypeFont:
        path, index = self.chain[0]
        return self.get(path, index, size)

    def _notdef_signatures(self, path: str, index: int) -> set:
        key = (path, index)
        sigs = self._notdef.get(key)
        if sigs is None:
            probe = self.get(path, index, 20)
            sigs = {_mask_signature(probe, ch) for ch in _NOTDEF_PROBES}
            self._notdef[key] = sigs
        return sigs

    def has_glyph(self, path: str, index: int, ch: str) -> bool:
        key = (path, index, ch)
        cached = self._has_glyph.get(key)
        if cached is None:
            font = self.get(path, index, 20)
            cached = _mask_signature(font, ch) not in self._notdef_signatures(path, index)
            self._has_glyph[key] = cached
        return cached

    # -- 逐字字体选择 -----------------------------------------------------
    def font_for(self, ch: str, size: int) -> Optional[ImageFont.FreeTypeFont]:
        """返回能渲染该字符的字体；回退链全部缺字时返回 None。"""
        cache_key = (size, ch)
        if cache_key in self._font_for:
            return self._font_for[cache_key]
        chosen: Optional[ImageFont.FreeTypeFont] = None
        for path, index in self.chain:
            if self.has_glyph(path, index, ch):
                chosen = self.get(path, index, size)
                break
        self._font_for[cache_key] = chosen
        return chosen

    def renderable(self, text: str) -> bool:
        """文本中每个可见字符都有字形可用（换行符除外）。"""
        return all(ch in "\n\r" or self.font_for(ch, 20) is not None for ch in text)

    def advance(self, ch: str, size: int) -> float:
        key = (size, ch)
        width = self._advance.get(key)  # type: ignore[assignment]
        if width is None:
            font = self.font_for(ch, size) or self.primary(size)
            width = font.getlength(ch)
            self._advance[key] = width
        return width

    def measure(self, text: str, size: int) -> float:
        return sum(self.advance(ch, size) for ch in text)

    def runs(self, line: str, size: int) -> List[Tuple[str, ImageFont.FreeTypeFont]]:
        """把一行切成"同一字体"的连续片段，用于逐段绘制。"""
        out: List[Tuple[str, ImageFont.FreeTypeFont]] = []
        buf: List[str] = []
        current: Optional[ImageFont.FreeTypeFont] = None
        for ch in line:
            font = self.font_for(ch, size) or self.primary(size)
            if font is not current:
                if buf and current is not None:
                    out.append(("".join(buf), current))
                buf = []
                current = font
            buf.append(ch)
        if buf and current is not None:
            out.append(("".join(buf), current))
        return out


# ---------------------------------------------------------------------------
# 文本换行
# ---------------------------------------------------------------------------


def _iter_tokens(text: str) -> Iterable[str]:
    """把文本拆成换行单元：CJK 与符号逐字，ASCII 单词/数字整体保留。"""
    buf: List[str] = []
    for ch in text:
        if ch.isascii() and (ch.isalnum() or ch in "._-/:@+%'"):
            buf.append(ch)
            continue
        if buf:
            yield "".join(buf)
            buf = []
        yield ch
    if buf:
        yield "".join(buf)


def _wrap_paragraph(para: str, measure: Callable[[str], float],
                    max_width: float) -> List[str]:
    lines: List[str] = []
    cur: List[str] = []
    cur_width = 0.0

    def flush() -> None:
        nonlocal cur, cur_width
        if cur:
            lines.append("".join(cur))
            cur = []
            cur_width = 0.0

    for token in _iter_tokens(para):
        token_width = measure(token)
        if token_width > max_width:
            # 单个超宽 token（极长的无空格串）逐字拆开
            for ch in token:
                ch_width = measure(ch)
                if cur and cur_width + ch_width > max_width:
                    flush()
                cur.append(ch)
                cur_width += ch_width
            continue
        if not cur:
            cur.append(token)
            cur_width = token_width
            continue
        if cur_width + token_width <= max_width:
            cur.append(token)
            cur_width += token_width
            continue
        # 超宽，需要换行；先做禁则修正（把上一行末字一起带到下一行）
        carry: List[str] = []
        if token in FORBIDDEN_LINE_START and len(cur) > 1:
            carry.append(cur.pop())
        elif cur[-1] in FORBIDDEN_LINE_END and len(cur) > 1:
            carry.append(cur.pop())
        flush()
        cur = carry + [token]
        cur_width = measure("".join(cur))
    flush()
    return lines


def wrap_text(text: str, measure: Callable[[str], float], max_width: float) -> List[str]:
    """按像素宽度贪心换行，保证每行实际宽度 <= max_width 且不丢任何字符。"""
    lines: List[str] = []
    for para in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if not para:
            lines.append("")
            continue
        lines.extend(_wrap_paragraph(para, measure, max_width))
    # 去掉尾部空行（尾部换行不承载可见文本）
    while lines and not lines[-1]:
        lines.pop()
    return lines


# ---------------------------------------------------------------------------
# 版式尺寸计算
# ---------------------------------------------------------------------------


class LayoutPlan:
    """一次渲染的排版结果：字号、行、画布高度。"""

    __slots__ = ("font_size", "line_height", "lines", "text_width", "height", "layout",
                 "source_text")

    def __init__(self, layout: str, font_size: int, line_height: int, lines: List[str],
                 text_width: int, height: int, source_text: str) -> None:
        self.layout = layout
        self.font_size = font_size
        self.line_height = line_height
        self.lines = lines
        self.text_width = text_width
        self.height = height
        self.source_text = source_text


CHAT_TEXT_WIDTH = WIDTH - 72 - OUTER_MARGIN - 32  # 气泡内文本宽 = 512
POST_TEXT_WIDTH = 608 - 48  # 卡片内文本宽 = 560
POST_HEADER_H = 40
POST_CARD_PAD = 24
POST_HEADER_GAP = 16
CHAT_AVATAR_R = 20
POST_AVATAR_R = 18


def plan_layout(text: str, layout: str, fonts: FontBook) -> LayoutPlan:
    """选最大可容纳字号（14-20），并算出画布高度（480-720）。"""
    text_width = CHAT_TEXT_WIDTH if layout == "chat" else POST_TEXT_WIDTH
    for size in FONT_SIZES:
        measure = (lambda s, size=size: fonts.measure(s, size))
        lines = wrap_text(text, measure, text_width)
        line_height = int(round(size * 1.6))
        text_h = len(lines) * line_height
        if layout == "chat":
            bubble_h = 14 + text_h + 14
            content_h = (TOP_BAR_H + OUTER_MARGIN
                         + max(2 * CHAT_AVATAR_R + 4, bubble_h) + OUTER_MARGIN)
        else:
            card_h = POST_CARD_PAD + POST_HEADER_H + POST_HEADER_GAP + text_h + POST_CARD_PAD
            content_h = TOP_BAR_H + OUTER_MARGIN + card_h + OUTER_MARGIN
        if content_h <= MAX_HEIGHT:
            height = max(MIN_HEIGHT, content_h)
            return LayoutPlan(layout, size, line_height, lines, text_width, height, text)
    # 兜底：最小字号 + 上限高度（正常不会走到，assert_rendered 会兜住溢出）
    measure = (lambda s: fonts.measure(s, MIN_FONT_SIZE))
    lines = wrap_text(text, measure, text_width)
    line_height = int(round(MIN_FONT_SIZE * 1.6))
    return LayoutPlan(layout, MIN_FONT_SIZE, line_height, lines, text_width, MAX_HEIGHT, text)


# ---------------------------------------------------------------------------
# 绘制基础件
# ---------------------------------------------------------------------------


def draw_avatar(img: Image.Image, cx: int, cy: int, r: int) -> None:
    """画一个默认头像圆点（圆底 + 简易人形剪影），不含任何文字。"""
    ss = 4  # 超采样，圆形边缘更干净
    size = r * 2 * ss
    avatar = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(avatar)
    d.ellipse((0, 0, size - 1, size - 1), fill=(*COLOR_AVATAR_BG, 255))
    head_r = int(size * 0.19)
    head_cx, head_cy = size // 2, int(size * 0.38)
    d.ellipse(
        (head_cx - head_r, head_cy - head_r, head_cx + head_r, head_cy + head_r),
        fill=(*COLOR_AVATAR_FG, 255),
    )
    body_w = int(size * 0.56)
    body_h = int(size * 0.42)
    body_top = int(size * 0.60)
    d.ellipse(
        (size // 2 - body_w // 2, body_top, size // 2 + body_w // 2, body_top + body_h),
        fill=(*COLOR_AVATAR_FG, 255),
    )
    # 用圆做遮罩，裁掉溢出的身体
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    avatar.putalpha(mask)
    avatar = avatar.resize((r * 2, r * 2), Image.LANCZOS)
    img.paste(avatar, (cx - r, cy - r), avatar)


def sample_clock(seed_text: str) -> str:
    """按样本 id 派生一个确定性时间（仅版式装饰，不涉及真实信息）。"""
    crc = zlib.crc32(seed_text.encode("utf-8")) & 0xFFFFFFFF
    hour = 8 + crc % 14  # 08:00 - 21:59
    minute = (crc // 14) % 60
    return f"{hour:02d}:{minute:02d}"


def draw_top_bar(d: ImageDraw.ImageDraw, title: str, clock: str, fonts: FontBook) -> None:
    d.rectangle((0, 0, WIDTH, TOP_BAR_H), fill=COLOR_BG)
    d.text((OUTER_MARGIN - 4, TOP_BAR_H / 2), title, font=fonts.primary(16),
           fill=COLOR_TOPBAR_TEXT, anchor="lm")
    d.text((WIDTH - OUTER_MARGIN + 4, TOP_BAR_H / 2), clock, font=fonts.primary(14),
           fill=COLOR_TOPBAR_SUB, anchor="rm")
    d.line((0, TOP_BAR_H, WIDTH, TOP_BAR_H), fill=COLOR_DIVIDER, width=1)


def draw_text_block(d: ImageDraw.ImageDraw, plan: LayoutPlan, fonts: FontBook,
                    x: int, y: int, fill: Tuple[int, int, int]) -> None:
    """逐行、逐字体片段绘制；x 按实际 advance 累加，保证不重叠不溢出。"""
    for i, line in enumerate(plan.lines):
        if not line:
            continue
        cursor = float(x)
        line_y = y + i * plan.line_height
        for run_text, font in fonts.runs(line, plan.font_size):
            d.text((cursor, line_y), run_text, font=font, fill=fill)
            cursor += font.getlength(run_text)


# ---------------------------------------------------------------------------
# 两种版式
# ---------------------------------------------------------------------------


def render_chat(plan: LayoutPlan, clock: str, img: Image.Image, fonts: FontBook) -> None:
    d = ImageDraw.Draw(img)
    draw_top_bar(d, "群聊 · 用户消息", clock, fonts)

    bubble_left = 72
    bubble_right = WIDTH - OUTER_MARGIN
    bubble_top = TOP_BAR_H + OUTER_MARGIN
    text_h = len(plan.lines) * plan.line_height
    bubble_h = 14 + text_h + 14
    bubble_bottom = bubble_top + bubble_h

    d.rounded_rectangle(
        (bubble_left, bubble_top, bubble_right, bubble_bottom),
        radius=12, fill=COLOR_BUBBLE_BG, outline=COLOR_BUBBLE_EDGE, width=1,
    )
    draw_avatar(img, bubble_left - 32, bubble_top + CHAT_AVATAR_R + 2, CHAT_AVATAR_R)

    draw_text_block(d, plan, fonts, x=bubble_left + 16, y=bubble_top + 14, fill=COLOR_TEXT)


def render_post(plan: LayoutPlan, clock: str, img: Image.Image, fonts: FontBook) -> None:
    d = ImageDraw.Draw(img)
    draw_top_bar(d, "帖子 · 用户发布", clock, fonts)

    card_left = 16
    card_right = WIDTH - 16
    card_top = TOP_BAR_H + OUTER_MARGIN
    text_h = len(plan.lines) * plan.line_height
    card_h = POST_CARD_PAD + POST_HEADER_H + POST_HEADER_GAP + text_h + POST_CARD_PAD
    d.rounded_rectangle(
        (card_left, card_top, card_right, card_top + card_h),
        radius=14, fill=COLOR_BG, outline=COLOR_CARD_EDGE, width=1,
    )

    avatar_cx = card_left + POST_CARD_PAD + POST_AVATAR_R
    avatar_cy = card_top + POST_CARD_PAD + POST_AVATAR_R
    draw_avatar(img, avatar_cx, avatar_cy, POST_AVATAR_R)
    d.text((avatar_cx + POST_AVATAR_R + 10, avatar_cy), "匿名用户",
           font=fonts.primary(16), fill=COLOR_NICK, anchor="lm")

    draw_text_block(
        d, plan, fonts,
        x=card_left + POST_CARD_PAD,
        y=card_top + POST_CARD_PAD + POST_HEADER_H + POST_HEADER_GAP,
        fill=COLOR_TEXT,
    )


def build_palette_image() -> Image.Image:
    flat: List[int] = []
    for color in PNG_PALETTE:
        flat.extend(color)
    flat.extend([0, 0, 0] * (256 - len(PNG_PALETTE)))
    palette = Image.new("P", (1, 1))
    palette.putpalette(flat)
    return palette


PALETTE_IMAGE = build_palette_image()


def flatten_to_palette(img: Image.Image) -> Image.Image:
    """把 RGB 截图映射到 UI 调色板再转回 RGB（不改尺寸、不抖动，文字边缘保持干净）。"""
    return img.quantize(palette=PALETTE_IMAGE, dither=Image.Dither.NONE).convert("RGB")


def assert_rendered(plan: LayoutPlan, img: Image.Image, fonts: FontBook) -> None:
    """不变量：换行没有丢字符；每行不超宽；文本块完整落在画布内。"""
    joined = "".join(plan.lines)
    expected = plan.source_text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "")
    if joined != expected:
        raise AssertionError("换行丢字：渲染文本与原始文本不一致")
    for line in plan.lines:
        width = fonts.measure(line, plan.font_size)
        if line and width > plan.text_width + 0.5:
            raise AssertionError(f"行超宽：{width:.1f} > {plan.text_width}")
    if plan.layout == "chat":
        block_bottom = (TOP_BAR_H + OUTER_MARGIN + 14
                        + len(plan.lines) * plan.line_height + 14)
    else:
        block_bottom = (TOP_BAR_H + OUTER_MARGIN + POST_CARD_PAD + POST_HEADER_H
                        + POST_HEADER_GAP + len(plan.lines) * plan.line_height + POST_CARD_PAD)
    if block_bottom > img.height:
        raise AssertionError(f"文本溢出画布：{block_bottom} > {img.height}")


def render_sample(text: str, layout: str, clock: str, fonts: FontBook) -> Image.Image:
    plan = plan_layout(text, layout, fonts)
    img = Image.new("RGB", (WIDTH, plan.height), COLOR_BG)
    if layout == "chat":
        render_chat(plan, clock, img, fonts)
    else:
        render_post(plan, clock, img, fonts)
    assert_rendered(plan, img, fonts)
    return flatten_to_palette(img)


# ---------------------------------------------------------------------------
# 选样与清单
# ---------------------------------------------------------------------------


def load_samples(path: Path) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise SystemExit(f"{path}:{lineno} JSON 解析失败：{exc}") from exc
            if not row.get("id") or not isinstance(row.get("text"), str):
                raise SystemExit(f"{path}:{lineno} 缺少 id/text 字段")
            rows.append(row)
    return rows


def sample_by_category(rows: Sequence[Dict[str, Any]], per_category: int, seed: int,
                       fonts: FontBook) -> Tuple[List[Dict[str, Any]], int]:
    """按类别独立确定性抽样，类别桶互斥。

    只从"所有字符都能渲染"的候选里抽，避免缺字（如系统字体不支持的异体字）落到图上。
    """
    used: set = set()
    picked: List[Dict[str, Any]] = []
    skipped = 0
    for category in CATEGORY_ORDER:
        candidates = sorted(
            (r for r in rows if category in r.get("gold", {}).get("categories", [])),
            key=lambda r: str(r["id"]),
        )
        available: List[Dict[str, Any]] = []
        for row in candidates:
            if row["id"] in used:
                continue
            if not fonts.renderable(row["text"]):
                skipped += 1
                continue
            available.append(row)
        if len(available) < per_category:
            raise SystemExit(
                f"类别 {category} 可用样本不足：需要 {per_category}，只有 {len(available)}"
            )
        rng = random.Random(f"{seed}:{category}")
        chosen = rng.sample(available, per_category)
        for row in chosen:
            used.add(row["id"])
            picked.append(row)
    picked.sort(key=lambda r: str(r["id"]))
    return picked, skipped


def layout_for_source(source: str) -> str:
    if source in CHAT_SOURCES:
        return "chat"
    if source in POST_SOURCES:
        return "post"
    return "chat"


def build_image_record(row: Dict[str, Any]) -> Dict[str, Any]:
    layout = layout_for_source(str(row.get("source", "")))
    gold = row.get("gold") or {}
    return {
        "id": f"img-{row['id']}",
        "image": f"img-{row['id']}.png",
        "text": TEXT_CHAT if layout == "chat" else TEXT_POST,
        "source": row.get("source", ""),
        "source_detail": f"{row.get('source_detail', '')}（图像版）",
        "origin": row.get("origin", ""),
        "sensitive": bool(row.get("sensitive", False)),
        "gold": {
            "violation": bool(gold.get("violation", False)),
            "categories": list(gold.get("categories") or []),
        },
        "content_text": row["text"],
    }


def build_text_record(row: Dict[str, Any]) -> Dict[str, Any]:
    gold = row.get("gold") or {}
    return {
        "id": f"img-{row['id']}",
        "text": row["text"],
        "source": row.get("source", ""),
        "source_detail": row.get("source_detail", ""),
        "origin": row.get("origin", ""),
        "sensitive": bool(row.get("sensitive", False)),
        "gold": {
            "violation": bool(gold.get("violation", False)),
            "categories": list(gold.get("categories") or []),
        },
    }


def write_jsonl(path: Path, records: Iterable[Dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8") as fh:
        for record in records:
            fh.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")))
            fh.write("\n")


# ---------------------------------------------------------------------------
# README（数据集卡）
# ---------------------------------------------------------------------------


def build_readme(dist: Dict[str, int], source_dist: Dict[str, int], per_category: int,
                 seed: int, out_rel: str, eval_rel: str, font_path: str,
                 font_chain: Sequence[str], skipped: int) -> str:
    total = sum(dist.values())
    rows = "\n".join(f"| {cat} | {dist.get(cat, 0)} |" for cat in CATEGORY_ORDER)
    source_rows = "\n".join(
        f"| {src} | {source_dist.get(src, 0)} |"
        for src in (*sorted(CHAT_SOURCES), *sorted(POST_SOURCES))
        if source_dist.get(src)
    )
    chat_total = sum(source_dist.get(src, 0) for src in CHAT_SOURCES)
    post_total = sum(source_dist.get(src, 0) for src in POST_SOURCES)
    chain_text = "\n".join(f"  - `{p}`" for p in font_chain)
    return f"""# 图像审核评测集（data/images）

## 用途

把 `{eval_rel}` 中的纯文本审核样本渲染成"用户聊天截图 / 用户发布的帖子截图"，
用于评估 **多模态** 内容审核模型（如 Cloudflare clef-omni）在"图内文字"上的
违规判定能力，并与同一批样本的纯文本基座（`text_baseline.jsonl`）对照。

**本数据集只有"图内文字"**：图片是程序渲染的 UI 截图，不含真实 NSFW / 暴力 /
血腥实拍图像。它测量的是"模型能否读取截图里的文字并做出审核判断"，
不是"模型能否识别真实违规图像"，两者不能互相替代。

## 类别分布

共 **{total}** 条 / {len(CATEGORY_ORDER)} 类，每类 {per_category} 条，样本互斥（同一原样本只出现一次）。

| 类别 | 条数 |
| --- | --- |
{rows}
| **合计** | **{total}** |

来源分布（决定版式）：

| 来源 | 条数 | 版式 |
| --- | --- | --- |
{source_rows}
| **合计** | **{total}** | — |

版式：聊天类 `cold` / `toxincn` / `spam` 用聊天气泡截图（{chat_total} 条），
`nsfw` / `safetyprompts` 用帖子卡片截图（{post_total} 条）。

## 字段

`samples.jsonl`（图像版）：

| 字段 | 说明 |
| --- | --- |
| `id` | `img-<原样本 id>` |
| `image` | PNG 文件名（仅 basename，相对本目录） |
| `text` | 发给模型的 neutral 提示语（聊天版 / 帖子版） |
| `source` / `source_detail` / `origin` / `sensitive` | 沿用原样本，`source_detail` 末尾加"（图像版）" |
| `gold` | 与原样本完全一致：`{{"violation": bool, "categories": [...]}}` |
| `content_text` | 原始文本（即图中渲染的文字，便于人工核对，跑分时不应发给模型） |

`text_baseline.jsonl`（纯文本对照版）：同 `id`、同 `text`（原始文本）、同
`source/source_detail/origin/sensitive/gold`，**不含** `image` / `content_text`。

## 生成

```bash
# 需要 Pillow（仅数据准备阶段；项目运行时仍零依赖）
python3 scripts/prepare_images.py

# 可选参数（默认值即本数据集配置）
python3 scripts/prepare_images.py \\
  --eval {eval_rel} --out {out_rel} --per-category {per_category} --seed {seed}
```

- 字体：主字体为 {font_path}（Heiti SC 字形）。逐字缺字回退链（按优先级取第一个
  有该字形的字体，缺失文件自动跳过）：
{chain_text}
- 抽样时只选"所有字符都能渲染"的候选样本；本次生成因缺字跳过 {skipped} 条候选。
- 尺寸：宽 {WIDTH}，高 {MIN_HEIGHT}-{MAX_HEIGHT} 自适应；字号 14-20 按文本长度动态选择，
  按像素宽度换行（含中英文混排禁则），保证原始文本 **100% 完整可见、不截断**
  （sexual 类约 300 字也完整渲染）。
- 复现性：`--seed {seed}` 固定抽样，Pillow 渲染确定性；同 seed 重跑输出逐字节一致。

## 跑分

```bash
# 图像版（需要 provider 侧支持把 image 字段作为图片输入，例如 cloudflare clef-omni）
node scripts/benchmark.mjs --provider cloudflare --dataset {out_rel}/samples.jsonl

# 纯文本对照（同一批样本的原始文本）
node scripts/benchmark.mjs --provider cloudflare --dataset {out_rel}/text_baseline.jsonl
```

图像模式依赖 provider 读取 `image`（相对数据集目录）并转 base64 直传；
若当前 provider 尚未接入图像输入，只会把 `text` 里的 neutral 提示语发给模型，
此时结果应视为管线连通性检查，而非图像审核结论。

## 局限性

1. **仅覆盖"图内文字"审核**：不含真实 NSFW / 暴力 / 血腥 / 违法商品实拍图，
   不能据此评价模型对真实图像内容的识别能力。
2. 版式只有聊天气泡与帖子卡片两种，字体、颜色、分辨率单一；对真实截图多样性
   （深色模式、表情包、多图、截断长图）覆盖不足。
3. 每条样本只对应一个主类别（与原数据集一致），多标签、灰区样本覆盖有限。
4. `sexual` 类原文本为成人图片中文描述，渲染后同样含敏感文字，仅用于审核评测，
   请勿对外传播；数据集不含真实个人信息（原样本已脱敏，渲染未新增）。
5. 单张 PNG 均 < 200KB、整目录 < 4MB，为便于提交与并发上传做了体积控制
   （16 色 UI 调色板），不追求还原真实手机截图的视觉细节。
"""


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="把文本审核样本渲染成聊天/帖子截图，产出图像审核评测集。",
    )
    parser.add_argument("--eval", default=str(DEFAULT_EVAL),
                        help=f"输入样本 jsonl（默认 {DEFAULT_EVAL}）")
    parser.add_argument("--out", default=str(DEFAULT_OUT),
                        help=f"输出目录（默认 {DEFAULT_OUT}）")
    parser.add_argument("--per-category", type=int, default=DEFAULT_PER_CATEGORY,
                        help=f"每类抽样条数（默认 {DEFAULT_PER_CATEGORY}）")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED,
                        help=f"抽样随机种子（默认 {DEFAULT_SEED}）")
    return parser.parse_args(argv)


def rel_to_root(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    eval_path = Path(args.eval)
    out_dir = Path(args.out)
    if args.per_category < 1:
        raise SystemExit("--per-category 必须 >= 1")

    rows = load_samples(eval_path)
    fonts = FontBook()
    picked, skipped = sample_by_category(rows, args.per_category, args.seed, fonts)

    out_dir.mkdir(parents=True, exist_ok=True)
    image_records: List[Dict[str, Any]] = []
    text_records: List[Dict[str, Any]] = []
    expected_names = set()
    for row in picked:
        layout = layout_for_source(str(row.get("source", "")))
        clock = sample_clock(str(row["id"]))
        img = render_sample(row["text"], layout, clock, fonts)
        name = f"img-{row['id']}.png"
        expected_names.add(name)
        img.save(out_dir / name, format="PNG", optimize=True, compress_level=9)
        image_records.append(build_image_record(row))
        text_records.append(build_text_record(row))

    # 清理上次生成但本次不再需要的图片（只动本脚本命名规则的 PNG）
    stale = [p for p in out_dir.glob("img-*.png") if p.name not in expected_names]
    for path in stale:
        path.unlink()

    write_jsonl(out_dir / "samples.jsonl", image_records)
    write_jsonl(out_dir / "text_baseline.jsonl", text_records)

    dist: Dict[str, int] = {}
    source_dist: Dict[str, int] = {}
    for row in picked:
        for cat in (row.get("gold") or {}).get("categories") or []:
            dist[cat] = dist.get(cat, 0) + 1
        src = str(row.get("source", ""))
        source_dist[src] = source_dist.get(src, 0) + 1

    readme = build_readme(
        dist=dist,
        source_dist=source_dist,
        per_category=args.per_category,
        seed=args.seed,
        out_rel=rel_to_root(out_dir),
        eval_rel=rel_to_root(eval_path),
        font_path=f"{fonts.chain[0][0]}（index={fonts.chain[0][1]}）",
        font_chain=[f"{path}（index={index}）" for path, index in fonts.chain],
        skipped=skipped,
    )
    (out_dir / "README.md").write_text(readme, encoding="utf-8")

    sizes = [p.stat().st_size for p in out_dir.glob("img-*.png")]
    total_bytes = sum(sizes)
    print(f"[prepare_images] 输入      : {eval_path}（{len(rows)} 条，缺字跳过 {skipped} 条候选）")
    print(f"[prepare_images] 抽样      : {len(picked)} 条 / {len(CATEGORY_ORDER)} 类，seed={args.seed}")
    for cat in CATEGORY_ORDER:
        print(f"[prepare_images]   {cat:<8}: {dist.get(cat, 0)}")
    print(f"[prepare_images] 输出目录  : {out_dir}")
    print(f"[prepare_images] 图片      : {len(sizes)} 张，"
          f"平均 {total_bytes / max(1, len(sizes)) / 1024:.1f} KB，"
          f"最大 {max(sizes) / 1024:.1f} KB，合计 {total_bytes / 1024:.1f} KB")
    print(f"[prepare_images] 字体      : {fonts.chain[0][0]}（index={fonts.chain[0][1]}），"
          f"回退 {len(fonts.chain) - 1} 个")
    print(f"[prepare_images] 清理过期图片: {len(stale)} 张")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
