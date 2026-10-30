# 评测数据集说明（data/eval）

本目录是「内容审核跑分台」使用的**带金标中文评测集**，由 `scripts/prepare_data.py` 从 5 个公开数据集按固定规则、固定随机种子（`seed=42`）生成，可完全重复。

- `samples.jsonl`：825 条样本，每行一个 JSON
- `stats.json`：总量 / 来源 / 类别 / 违规比例等统计
- 原文只做过滤、去重、截断，**不改写、不伪造**；金标全部来自各数据集**原生标签的映射**。
- 本目录是 `text` 档案；截图图像见 `data/images/`（`text-image`，仅 clef-omni），本地 NSFW 实拍图见 `data/real-images/`（`nsfw-image`，不入库），UnsafeBench 二分类图像集见 `data/real-images/unsafebench/`（`unsafebench`，不入库）。档案定义与 provider 约束见 `server/dataset-profiles.mjs` 与根 README「数据集档案」一节。

> UnsafeBench 的 parquet 放在 `data/raw/unsafebench/`（不入库），用 `python3 scripts/prepare_unsafebench.py` 抽取本地图片与 `samples.jsonl`；该数据集需遵守其 DUA，仅用于研究/评测，不重新分发图片。

## 1. 规模与分布

| 指标 | 值 |
| --- | --- |
| 总样本 | **825** |
| 违规 / 正常 | 525（63.6%）/ 300（36.4%） |
| 平均文本长度 | 54 字（p50 34，p95 299，max 300） |
| 重复文本 | 0（按 `text.strip()` 全局精确去重） |

按类别：

| 类别 | safe | insult | hate | sexual | violence | illegal | spam | privacy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 数量 | 300 | 195 | 115 | 45 | 35 | 40 | 70 | 25 |

按来源：

| 来源 | cold | toxincn | spam | safetyprompts | nsfw |
| --- | --- | --- | --- | --- | --- |
| 数量 | 320 | 240 | 120 | 100 | 45 |

## 2. 数据来源

| source | 数据集 | 原始标签 | origin | 用途 |
| --- | --- | --- | --- | --- |
| `cold` | [COLD](https://github.com/thu-coai/COLD) 中文攻击性言论（EMNLP 2022） | `label` 0/1，`fine-grained-label` 0–3 | human | 辱骂 / 歧视 / 正常 |
| `toxincn` | ToxiCN 中文毒性评论（ACL 2023） | `toxic_type` 0/1/2 | human | 隐晦辱骂 / 仇恨 |
| `spam` | 中文垃圾短信（SMS Spam Collection 中文版） | `label` 0/1 | human | 广告 / 垃圾推广 / 正常 |
| `safetyprompts` | [Safety-Prompts](https://github.com/thu-coai/Safety-Prompts) 典型安全场景 | 场景目录 | benchmark-augmented | 违法 / 暴力 / 隐私 |
| `nsfw` | `Richarddzz/NSFW-Chinese-Adult-Image-Caption`（Hugging Face） | 图片描述文本 | caption | 色情低俗（图片描述，`sensitive=true`） |

原始文件缓存在 `data/raw/`（`safety_typical_safety_scenarios.json` 为 45MB 原始场景集；`nsfw_captions/` 为首次运行从 HF 拉取的描述文本）。这些数据集仅用于本地评测，版权归各自作者所有；本仓库不重新分发原始数据集。

## 3. 字段定义

```json
{
  "id": "cold-0037",
  "text": "……",
  "source": "cold",
  "source_detail": "COLD test / region / fg=1",
  "origin": "human",
  "sensitive": false,
  "gold": { "violation": true, "categories": ["insult"] }
}
```

- `id`：`{source}-{4位序号}`，全局唯一
- `source`：`cold` / `toxincn` / `spam` / `safetyprompts` / `nsfw`
- `origin`：`human`（真实用户文本）/ `benchmark-augmented`（公开评测集）/ `caption`（图片描述）
- `sensitive`：色情/边缘样本为 `true`，Web 端默认打码，点击后显示
- `gold.violation`：二分类金标；`gold.categories`：单标签类别（`safe` 为唯一非违规类别）
- `source_detail`：来源细分（COLD 主题、Safety-Prompts 场景目录、ToxiCN 类型等）

## 4. 金标映射规则

规则集中在 `scripts/prepare_data.py` 的 `SOURCE_ORIGIN` / 各类 `map_*` 函数中，并在 `stats.json.goldRules` 中留档：

- **COLD**：`label=0` 或 `fine-grained-label=3`（anti-bias）→ `safe`；`fg=1`（攻击个人）→ `insult`；`fg=2`（攻击群体）→ `hate`
- **ToxiCN**：`toxic_type=0` → `safe`；`1`（一般冒犯）→ `insult`；`2`（仇恨言论）→ `hate`；优先长度 12–200 的样本
- **spam_olivi**：`label=1` → `spam`；`label=0` → `safe`；过滤畸形行、乱码、纯符号
- **Safety-Prompts**：`Crimes_And_Illegal_Activities` 中**明确违法请求意图** → `illegal`（排除防御性/科普式问法）；`Physical_Harm` + `Mental_Health` 中明确自残/自杀/暴力伤害 → `violence`；`Privacy_And_Property` 中明确索取/窃取/泄露隐私 → `privacy`
- **NSFW 描述**：成人图片中文描述 → `sexual`，`sensitive=true`，截断到前 300 字符
- 去重、过滤空文本/纯符号/URL/乱码/过短文本（`<8` 字，垃圾短信 `<5`），最后用 `seed=42` 打乱

## 5. 已知局限（报告解读时必看）

1. **金标是数据集原生标签的映射，不是独立人工复核**；ToxiCN 的“毒性”与 COLD 的“攻击性”定义并不完全等同，边界样本存在标签噪声（例如反讽、口头禅式贬损、单纯吐槽）。
2. **Safety-Prompts 是模型增强的公开评测集**，文本偏“教科书式”违法请求，真实分布会更隐蔽。
3. **NSFW 为图片自动生成描述的截断文本**（前 300 字），部分样本的敏感信息出现在截断之后，模型可能只看到构图描述 → sexual 召回偏低有数据成分。
4. **spam 数据集含大量乱码/谐音变体**，人类也难判断；`spam` 类指标波动大。
5. 违规比例 63.6% 高于真实业务（真实业务通常 1%–10%），因此**准确率不能直接外推到线上**；请同时看精确率/召回率与按来源细分。
6. 本数据集只用于**相对比较**（同一批数据、同一金标下比较模型/配置），不作为绝对能力结论。

## 6. 复现

```bash
# 纯 Python 标准库，无需 pip 安装
python3 scripts/prepare_data.py
# 输出 data/eval/samples.jsonl + data/eval/stats.json，并内置自检：
#   无重复 text / 字段齐全 / 配额与统计一致 / violation 比例在 55~65%
```

自检通过时打印 `total=825 violation=525 (63.64%) safe=300 avg_len=54`。
