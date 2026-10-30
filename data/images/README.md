# 图像审核评测集（data/images）

## 用途

把 `data/eval/samples.jsonl` 中的纯文本审核样本渲染成"用户聊天截图 / 用户发布的帖子截图"，
用于评估 **多模态** 内容审核模型（如 Cloudflare clef-omni）在"图内文字"上的
违规判定能力，并与同一批样本的纯文本基座（`text_baseline.jsonl`）对照。

**本数据集只有"图内文字"**：图片是程序渲染的 UI 截图，不含真实 NSFW / 暴力 /
血腥实拍图像。它测量的是"模型能否读取截图里的文字并做出审核判断"，
不是"模型能否识别真实违规图像"，两者不能互相替代。

## 类别分布

共 **120** 条 / 8 类，每类 15 条，样本互斥（同一原样本只出现一次）。

| 类别 | 条数 |
| --- | --- |
| insult | 15 |
| hate | 15 |
| sexual | 15 |
| violence | 15 |
| illegal | 15 |
| spam | 15 |
| privacy | 15 |
| safe | 15 |
| **合计** | **120** |

来源分布（决定版式）：

| 来源 | 条数 | 版式 |
| --- | --- | --- |
| cold | 27 |
| spam | 19 |
| toxincn | 14 |
| nsfw | 15 |
| safetyprompts | 45 |
| **合计** | **120** | — |

版式：聊天类 `cold` / `toxincn` / `spam` 用聊天气泡截图（60 条），
`nsfw` / `safetyprompts` 用帖子卡片截图（60 条）。

## 字段

`samples.jsonl`（图像版）：

| 字段 | 说明 |
| --- | --- |
| `id` | `img-<原样本 id>` |
| `image` | PNG 文件名（仅 basename，相对本目录） |
| `text` | 发给模型的 neutral 提示语（聊天版 / 帖子版） |
| `source` / `source_detail` / `origin` / `sensitive` | 沿用原样本，`source_detail` 末尾加"（图像版）" |
| `gold` | 与原样本完全一致：`{"violation": bool, "categories": [...]}` |
| `content_text` | 原始文本（即图中渲染的文字，便于人工核对，跑分时不应发给模型） |

`text_baseline.jsonl`（纯文本对照版）：同 `id`、同 `text`（原始文本）、同
`source/source_detail/origin/sensitive/gold`，**不含** `image` / `content_text`。

## 生成

```bash
# 需要 Pillow（仅数据准备阶段；项目运行时仍零依赖）
python3 scripts/prepare_images.py

# 可选参数（默认值即本数据集配置）
python3 scripts/prepare_images.py \
  --eval data/eval/samples.jsonl --out data/images --per-category 15 --seed 42
```

> macOS 上若 `python3 -c "import PIL"` 失败，可先 `python3 -m pip install pillow`
> 或改用项目环境中的 Python（本仓库生成时使用的是 DSH 运行时自带 Python）。

- 字体：主字体为 /System/Library/Fonts/STHeiti Medium.ttc（index=1）（Heiti SC 字形）。逐字缺字回退链（按优先级取第一个
  有该字形的字体，缺失文件自动跳过）：
  - `/System/Library/Fonts/STHeiti Medium.ttc（index=1）`
  - `/System/Library/Fonts/Supplemental/Arial Unicode.ttf（index=0）`
  - `/System/Library/Fonts/Apple Symbols.ttf（index=0）`
  - `/System/Library/Fonts/Apple Color Emoji.ttc（index=0）`
  - `/System/Library/Fonts/Supplemental/Songti.ttc（index=0）`
  - `/System/Library/Fonts/Hiragino Sans GB.ttc（index=0）`
- 抽样时只选"所有字符都能渲染"的候选样本；本次生成因缺字跳过 6 条候选。
- 尺寸：宽 640，高 480-720 自适应；字号 14-20 按文本长度动态选择，
  按像素宽度换行（含中英文混排禁则），保证原始文本 **100% 完整可见、不截断**
  （sexual 类约 300 字也完整渲染）。
- 复现性：`--seed 42` 固定抽样，Pillow 渲染确定性；同 seed 重跑输出逐字节一致。

## 跑分

```bash
# 图像版（需要 provider 侧支持把 image 字段作为图片输入，例如 cloudflare clef-omni）
node scripts/benchmark.mjs --provider cloudflare --dataset text-image

# 纯文本对照（同一批样本的原始文本）
node scripts/benchmark.mjs --provider cloudflare --dataset data/images/text_baseline.jsonl
```

图像模式由跑分引擎读取 `image`（默认相对数据集目录，可用 `IMAGES_DIR` / `--images-dir` 覆盖）
并转 base64 放进 `judge` 的 `ctx.images`；目前仅 `cloudflare`（clef-omni）声明支持图片输入，
其余 provider 跑本清单会返回 `IMAGE_UNSUPPORTED`（避免产生误导性分数）。
评估结果见仓库根 [README.md](../../README.md) 的「图像审核评测」一节。

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
