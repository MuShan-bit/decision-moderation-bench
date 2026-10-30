<p align="center">
  <img src="docs/assets/logo.svg" width="96" height="96" alt="内容审核跑分台 logo">
</p>

<h1 align="center">内容审核跑分台</h1>

<p align="center">
  <b>Decision Models Moderation Bench</b><br>
  多模型决策审核评测 · 跑分 / 历史记录 / 模型对比
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-3DA639?logo=opensourceinitiative&logoColor=white"></a>
  <a href="https://github.com/MuShan-bit/decision-moderation-bench/actions/workflows/test.yml"><img alt="tests workflow" src="https://github.com/MuShan-bit/decision-moderation-bench/actions/workflows/test.yml/badge.svg"></a>
  <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-339933">
  <img alt="dependencies: 0" src="https://img.shields.io/badge/dependencies-0-brightgreen">
  <img alt="tests: 84 passed" src="https://img.shields.io/badge/tests-84%20passed-brightgreen">
  <img alt="providers: dashscope / bamboonode / jev / cloudflare / mock" src="https://img.shields.io/badge/providers-dashscope%20%7C%20bamboonode%20%7C%20jev%20%7C%20cloudflare%20%7C%20mock-5eead4">
  <a href="https://github.com/MuShan-bit/decision-moderation-bench"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-decision--moderation--bench-181717?logo=github"></a>
</p>

一个可运行的**多模型中文内容审核跑分平台**：自带 **825 条带金标文本评测集 + 120 条图像评测集**、深色 Web 控制台（跑分 / 历史记录 / 模型对比 / 样本浏览器 / 单条体验）、CLI 跑分器和完整评测报告。

真实调用 TypeSafe **System One / typed-decision** 决策模型（百炼 `decision-model-preview`、BambooNode `startlux-decision-27b-autothink`、Jev `jev-preview`、Cloudflare Workers AI `clef-omni`），同一批样本、同一套决策逻辑下横向对比**准确率、F1、延迟与吞吐**；`clef-omni` 同时支持**文本与截图图像**输入；零 npm 运行时依赖，离线可用 mock provider 演示。

> 完整方法论、消融、错误分析与复现命令见 **[REPORT.md](REPORT.md)**；接口与数据结构契约见 **[docs/CONTRACT.md](docs/CONTRACT.md)**。

## ✨ 功能

- **多 Provider，同一套协议**：`dashscope`（百炼 DashScope）、`bamboonode`（StartLux）、`jev`（Jev 官方网关）、`cloudflare`（Cloudflare Workers AI `clef-omni`）、`mock`（离线规则模拟）
- **多模态图像审核**：`clef-omni` 支持把截图作为图片输入（请求体 `images[]`），内置 **120 条**图像评测集（8 类 × 15）与同批文本对照；`GET /api/images/<basename>` 同源提供样本图，样本浏览器直接展示并支持敏感图片打码；真实 NSFW 实拍图可通过 `scripts/import_real_images.mjs` 本地导入（图片不入库）
- **Provider → Model 级联**：前端只展示当前 provider 可用的模型，后端对跨 provider 的模型组合直接返回 `400 MODEL_NOT_ALLOWED`
- **可复现评测集**：5 个公开中文数据集、固定 `seed=42`、金标全部来自原始标签映射，数据统计与局限见 [data/README.md](data/README.md)
- **跑分记录按模型分组 + 分页 / 删除**：每次跑分独立保存为 `results/<runId>.json`，每页 6 条，可翻页查看或删除；删除 latest 会自动回退到上一条
- **模型对比视图**：勾选 2–6 条记录，并排比较质量指标、P50/P95、吞吐、分类别 F1；样本数/并发不同会自动提示不可直接比较
- **完整可视化**：准确率/P/R/F1、延迟直方图、混淆矩阵、分类别 F1、来源细分、逐条样本浏览器、单条文本体验
- **零依赖**：后端 `node:http` + 全局 `fetch`，前端原生 HTML/CSS/JS + 内联 SVG 图表；无 CDN、无构建步骤
- **离线可跑**：未配置真实 Key 时自动降级 `mock`，界面明确标注「模拟模式」，不会把模拟结果当真实结果

## 🖼️ 界面预览

### 跑分总览

![跑分总览](docs/assets/overview.png)

### 跑分控制

![跑分控制](docs/assets/run-controls.png)

### 跑分记录（按模型分组，支持分页与删除）

![跑分记录](docs/assets/history.png)

### 模型对比

勾选任意 2–6 条记录后自动生成；表格最优值标 ★，并附质量、延迟/吞吐与分类别对比。

![模型对比](docs/assets/compare.png)

### 指标图表

![延迟分布与混淆矩阵](docs/assets/latency-confusion.png)

![分类别 F1](docs/assets/category-f1.png)

![来源细分](docs/assets/source-table.png)

### 样本浏览器

支持判错/违规/正常筛选、类别过滤、原文搜索；敏感文本/图片默认打码。

![样本浏览器](docs/assets/samples.png)

### 单条体验

直接粘贴文本调用 `/api/moderate`，查看违规判定、类别、严重度、置信度与原始响应。

![单条体验](docs/assets/moderate.png)

> 完整页面长图：[docs/assets/dashboard.png](docs/assets/dashboard.png)

## 📊 模型测评结果

评测条件：**825 条**中文带金标样本（违规 63.6%）、同一套「4 问 + 阈值」决策逻辑；2026-10-30 通过 Web 控制台全量复测（`dashscope` 并发 **16**，其余模型并发 **4**）。准确率 / F1 与并发无关；延迟与吞吐受并发影响，横向比较吞吐时请注意并发差异。

> 本次为 4 个真实 provider 的完整复测：百炼、StartLux、Jev 与 Cloudflare `clef-omni`；逐条结果写入本地 `results/`（`*.json` 不入库）。[REPORT.md](REPORT.md) 记录的是 2026-10-23/24 的首次评测，本节以 2026-10-30 复测结果为准。

| 模型 | Provider | 并发 | 准确率 | 精确率 | 召回率 | F1 | P50 延迟 | P95 延迟 | 吞吐 | 825 条总耗时 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `decision-model-preview` | 百炼 `dashscope` | 16 | 73.2% | 83.5% | 72.2% | 0.774 | **130ms** | 5.80s | 21.67 req/s | **38.1s** |
| `startlux-decision-27b-autothink` | BambooNode `bamboonode` | 4 | **83.8%** | **86.5%** | 88.2% | **0.874** | 1.69s | 11.34s | 1.13 req/s | 12m7s |
| `jev-preview` | Jev / TypeSafe `jev` | 4 | 79.9% | 80.6% | **90.1%** | 0.851 | 343ms | **384ms** | 11.13 req/s | 74.1s |
| `clef-omni` | Cloudflare Workers AI `cloudflare` | 4 | 78.3% | 85.7% | 79.1% | 0.823 | 431ms | 480ms | 8.96 req/s | 92.1s |

- **StartLux 质量最高**：准确率 **83.8%**、F1 **0.874**，比百炼 **+10.5pt / +10.0pt**；补强了百炼最弱的 hate（F1 0.228 → 0.550）与 spam（0.326 → 0.875）。代价是延迟最高（P50 1.69s、P95 11.34s、max 60.8s）与并发 4 下吞吐最低（1.13 req/s）。
- **Cloudflare `clef-omni` 首次全量跑分**：准确率 **78.3%**、精确率 **85.7%**（仅次于 StartLux）、召回率 79.1%、F1 **0.823**；误杀 FP 仅 **69** 为四者最低。分类别上 spam（F1 **0.882**）与 illegal（**0.874**）为四者最高，hate（0.478）优于百炼、弱于 StartLux / Jev；P50 431ms、P95 480ms，尾延迟仅次于 Jev。
- **Jev 召回率最高**：准确率 79.9%、F1 0.851，召回率 **90.1%** 为四者最高，误杀 FP 114；P50 343ms、P95 **384ms** 为四者最稳，并发 4 下吞吐 11.13 req/s。
- **速度呈现清晰取舍**：百炼 P50 **130ms** 最快，但 P95 5.80s（并发 16 下吞吐 21.67 req/s）；Jev 与 `clef-omni` 的 P95 分别为 384ms / 480ms，尾延迟显著优于 StartLux 的 11.34s。
- 解析失败与调用错误均为 **0**；tokens：百炼 473,090（573/条），StartLux 784,334（951/条，含 completion 84,371），Jev 1,041,957（1,263/条，含 completion 100,903），`clef-omni` 767,615（930/条，completion 0）。
- 200 条样本档复测：百炼 ensemble **73.5%**、StartLux **85.0%**，与全量结论一致；百炼纯 argmax 仅 **61.5%**（消融详见报告）。
- Jev 本次使用 `jev-preview`（1.14）跑全量；`jev-latest`（1.13 stable）也可用 `node scripts/benchmark.mjs --provider jev --model jev-latest --concurrency 4` 跑同一套评测。

### 分类别 F1 对比（825 条）

| 类别 | 支持数 | 百炼 `decision-model-preview` | StartLux | Jev `jev-preview` | Cloudflare `clef-omni` |
| --- | ---: | ---: | ---: | ---: | ---: |
| 辱骂攻击 insult | 195 | 0.639 | **0.724** | 0.682 | 0.639 |
| 歧视仇恨 hate | 115 | 0.228 | **0.550** | 0.525 | 0.478 |
| 色情低俗 sexual | 45 | 0.714 | 0.774 | **0.791** | 0.691 |
| 暴力血腥 violence | 35 | **0.879** | 0.790 | 0.781 | 0.756 |
| 违法犯罪 illegal | 40 | 0.804 | 0.854 | 0.822 | **0.874** |
| 广告垃圾 spam | 70 | 0.326 | 0.875 | 0.828 | **0.882** |
| 隐私侵权 privacy | 25 | 0.571 | **0.714** | 0.650 | **0.714** |

> 加粗为该类别最高 F1；privacy 由 StartLux 与 `clef-omni` 并列最高。

> 数据口径：金标来自公开数据集原生标签映射，并非独立人工复核；违规比例 63.6% 高于真实业务，准确率不能直接外推到线上。详见 [REPORT.md](REPORT.md) 与 [data/README.md](data/README.md)。

### 图像审核评测（clef-omni 多模态，120 条截图）

`clef-omni` 同时支持图片输入。仓库新增一套**图像评测集**：从 `data/eval/samples.jsonl` 按类别分层抽样 **120 条**（8 类 × 15，`seed=42`），把原文渲染成「聊天/帖子截图」（图内文字即待审核内容），用同一套「4 问 + 阈值」逻辑在**图片输入**下评测，并与**同一批样本的原始文本**做对照。数据集与生成方式见 [data/images/README.md](data/images/README.md)。

评测条件：120 条（违规 105 / 正常 15）、`clef-omni`、并发 4、2026-10-30 一次运行；截图为 640 宽自适应 PNG（120 张，合计 2.5MB），文本对照使用同 id 原文。

| 输入模式 | 准确率 | 精确率 | 召回率 | F1 | macro F1 | P50 | P95 | 吞吐 | 120 条总耗时 | tokens/条 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 文本（对照） | **83.3%** | 96.7% | **83.8%** | **0.898** | **0.737** | **433ms** | **573ms** | **8.12 req/s** | **14.8s** | 938 |
| 图像（截图） | 75.8% | 96.3% | 75.2% | 0.845 | 0.666 | 508ms | 628ms | 7.07 req/s | 17.0s | 1,234 |

- 纯图片输入准确率 **-7.5pt**、F1 **-5.3pt**；120 条全部有效，解析失败/调用错误均为 **0**，精确率 96.3%（仅 3 条误杀）——`clef-omni` 能稳定读取截图文字并输出结构化判定，但隐晦/短文本的召回下降。
- 分类别看，下降集中在 **insult（0.522 → 0.381）**、**spam（0.846 → 0.720）**、**sexual（0.875 → 0.750）**、**hate（0.462 → 0.364）**；violence（0.903 → 0.867）、illegal（0.857 → 0.882）、privacy（0.696 → 0.696）基本持平——短辱骂、谐音/黑话与长 NSFW 描述更依赖逐字文本语义。
- 图像 token 成本更高：平均 **1,234 tokens/条**（文本 938，**+31.6%**）；P50 508ms（文本 433ms，+75ms），吞吐 -13%。
- **局限**：图像集目前只覆盖“图内文字”，截图由文本样本渲染，不含真实 NSFW / 暴力 / 血腥实拍图，因此不能据此评价模型对真实违规图像内容的识别能力；真实图片评测需另行引入合规图像集。

```bash
# 图像版（clef-omni；imagesDir 默认取数据集所在目录）
node scripts/benchmark.mjs --provider cloudflare --model clef-omni \
  --dataset data/images/samples.jsonl --concurrency 4

# 同批样本的纯文本对照
node scripts/benchmark.mjs --provider cloudflare --model clef-omni \
  --dataset data/images/text_baseline.jsonl --concurrency 4
```

| 类别 | 支持数 | 图像输入 F1 | 文本对照 F1 | Δ |
| --- | ---: | ---: | ---: | ---: |
| 辱骂攻击 insult | 15 | 0.381 | 0.522 | -0.141 |
| 歧视仇恨 hate | 15 | 0.364 | 0.462 | -0.098 |
| 色情低俗 sexual | 15 | 0.750 | 0.875 | -0.125 |
| 暴力血腥 violence | 15 | 0.867 | 0.903 | -0.037 |
| 违法犯罪 illegal | 15 | 0.882 | 0.857 | +0.025 |
| 广告垃圾 spam | 15 | 0.720 | 0.846 | -0.126 |
| 隐私侵权 privacy | 15 | 0.696 | 0.696 | 0.000 |

> 图像集每类仅 15 条，单类 F1 波动较大，结论以整体方向与 120 条总量为准。

### 真实图像评测（NSFW 等，本地导入，不入库）

上面的截图集只能测“图内文字”，**真实 NSFW / 暴力 / 血腥照片**的识别需要真实图像。但公开仓库不适合直接提交这类图片（GitHub 使用政策 + 版权/数据集许可证限制），因此这里做成**本地真实图像集**：图片只保存在本地 `data/real-images/`（已加入 `.gitignore`，不会入库），仓库提供导入与校验工具。

1. 准备图片 + 人工标注（来源与许可证由使用者确认；多数 NSFW 数据集仅限研究用途）。标注 CSV 表头：

   ```csv
   file,violation,category,sensitive,source_detail
   0001.jpg,1,sexual,1,自建 NSFW / 明确裸露
   0002.jpg,0,safe,0,自建 NSFW / 正常
   ```

   `file` 为相对图片目录的路径；`violation=1` 时 `category` 必须是违规类别，`0` 时强制为 safe；`sensitive` 缺省时 sexual 自动打码；也支持 JSONL（字段同名）。

2. 导入并校验（扩展名/魔数一致、单张 ≤4MiB、类别合法、路径不越界，生成后用正式 dataset 加载器再校验一遍）：

   ```bash
   node scripts/import_real_images.mjs \
     --src /path/to/nsfw-eval/images --labels /path/to/nsfw-eval/labels.csv
   # 输出 data/real-images/samples.jsonl + 复制后的图片
   ```

3. 跑分（与截图集完全同一套判定逻辑）：

   ```bash
   node scripts/benchmark.mjs --provider cloudflare --model clef-omni \
     --dataset data/real-images/samples.jsonl --concurrency 2
   # Web 端：DATASET_PATH=data/real-images/samples.jsonl npm start
   ```

- 建议 **≥100 张**、正负样本均衡（正常图也要有），并覆盖不同来源/构图；小样本或单一来源的准确率波动大，不宜外推。
- 由于真实图片不入库，本 README 的「图像评测」表格仍指**截图集**；真实图像跑分结果请在本地记录（可另附报告，但不要提交原图）。
- 若真实图像集里同时包含图内文字截图与实拍图，`modality` 仍统一记为 image，逐条结果里的 `source_detail` 可用于区分来源。

## 🚀 快速开始

要求：**Node.js ≥ 20**（项目在 v24 验证），无需 `npm install`。

```bash
git clone https://github.com/MuShan-bit/decision-moderation-bench.git
cd decision-moderation-bench

cp .env.example .env
# 编辑 .env，按需填写：
#   DASHSCOPE_API_KEY + SYSTEMONE_WORKSPACE_ID   # 百炼 dashscope
#   BAMBOONODE_API_KEY                           # BambooNode / StartLux
#   JEVMODEL_API_KEY                             # Jev 官方网关
#   CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID # Cloudflare Workers AI clef-omni

npm start
# 打开 http://127.0.0.1:8788
```

没有 Key 也能启动：自动使用 `mock` provider，界面显示「模拟模式」。

### 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DASHSCOPE_API_KEY` | 跑 `dashscope` 必填 | 阿里云百炼 API Key |
| `SYSTEMONE_WORKSPACE_ID` | 跑 `dashscope` 必填 | 百炼 workspace id，默认域名 `https://{id}.cn-beijing.maas.aliyuncs.com` |
| `SYSTEMONE_REGION` | 否 | 默认 `cn-beijing` |
| `BAMBOONODE_API_KEY` | 跑 `bamboonode` 必填 | BambooNode 网关 Key |
| `BAMBOONODE_BASE_URL` | 否 | 默认 `https://api.bamboonode.dev/v1` |
| `BAMBOONODE_MODELS` | 否 | 默认 `startlux-decision-27b-autothink`（逗号分隔） |
| `JEVMODEL_API_KEY` | 跑 `jev` 必填 | Jev / TypeSafe 官方网关 Key |
| `JEVMODEL_BASE_URL` | 否 | 默认 `https://api.typesafe.ai/v1` |
| `JEVMODEL_MODELS` | 否 | 默认 `jev-preview,jev-latest` |
| `CLOUDFLARE_API_TOKEN` | 跑 `cloudflare` 必填 | Cloudflare API Token，需 Workers AI - Read/Edit 权限（`CLOUDFLARE_AUTH_TOKEN` 为兼容别名） |
| `CLOUDFLARE_ACCOUNT_ID` | 跑 `cloudflare` 必填 | Cloudflare Account ID（Workers AI 页面获取） |
| `CLOUDFLARE_BASE_URL` | 否 | 默认 `https://api.cloudflare.com/client/v4` |
| `CLOUDFLARE_MODELS` | 否 | 默认 `clef-omni` |
| `MODERATION_PROVIDER` | 否 | 默认 `dashscope`；可选 `dashscope` / `bamboonode` / `jev` / `cloudflare` / `mock` |
| `MODERATION_MODEL` | 否 | 默认 `decision-model-preview` |
| `PORT` / `HOST` | 否 | 默认 `8788` / `127.0.0.1` |
| `RESULTS_DIR` | 否 | 结果目录，默认 `results/` |
| `IMAGES_DIR` | 否 | 图像样本目录；默认与 `DATASET_PATH` 同目录（图像数据集 `data/images/samples.jsonl` 会自动用同目录图片） |

> ⚠️ `.env` 已被 `.gitignore` 忽略，请勿把 Key 提交到仓库。前端与 API 均不会回显 Key。

## 🧪 数据集

> 仓库包含用于内容安全评测的敏感文本样本；Web 端对敏感样本默认打码，请按研究/评测目的使用。

- [data/eval/samples.jsonl](data/eval/samples.jsonl)：**825 条**文本，违规 525 / 正常 300，平均 54 字，零重复
- [data/images/samples.jsonl](data/images/samples.jsonl)：**120 条**图像评测集（8 类 × 15，聊天/帖子截图，2026-10-30 生成，`seed=42`）；同目录 `text_baseline.jsonl` 为同批样本文本对照；`scripts/prepare_images.py` 可复现（数据准备需 Pillow，运行时不依赖）
- 来源：COLD 320、ToxiCN 240、垃圾短信 120、Safety-Prompts 100、NSFW 图片描述 45
- 生成：`python3 scripts/prepare_data.py`（纯标准库，固定 `seed=42`）
- 原始数据集缓存在 `data/raw/`，**不纳入仓库**（遵循上游分发条款）；重新生成需按 [data/README.md](data/README.md) 准备原始文件
- 生成结果：`data/eval/samples.jsonl` + `data/eval/stats.json`

## 🖥️ Web 使用

1. **配置跑分**：选择样本数、并发、Provider、Model（Model 随 Provider 级联）；
2. **开始跑分**：任务异步执行，进度条实时更新；完成后展示 KPI、延迟直方图、混淆矩阵、分类别 F1、来源细分；
3. **查看历史**：「跑分记录」按 `provider/model` 分组，点「查看」切换到任意一次结果；
4. **模型对比**：勾选 2–6 条记录，自动出现对比表与图表；样本数/并发不同会提示不可直接比较；
5. **样本浏览器**：筛选判错/违规/正常、按类别过滤、搜索原文，敏感文本/图片默认打码；
6. **单条体验**：粘贴文本调用 `/api/moderate` 查看 verdict；
7. **导出**：当前结果可导出 CSV（含逐条预测、延迟、tokens 与原文）。

## ⌨️ CLI 跑分

```bash
# 全部 825 条，并发 4
node scripts/benchmark.mjs --provider dashscope --model decision-model-preview --concurrency 4

# StartLux（BambooNode）
node scripts/benchmark.mjs --provider bamboonode --model startlux-decision-27b-autothink --concurrency 4

# Jev 官方网关
node scripts/benchmark.mjs --provider jev --model jev-preview --concurrency 4

# Cloudflare Workers AI clef-omni
node scripts/benchmark.mjs --provider cloudflare --model clef-omni --concurrency 4

# clef-omni 图像评测（120 条截图；自动从数据集同目录读取图片）
node scripts/benchmark.mjs --provider cloudflare --model clef-omni \
  --dataset data/images/samples.jsonl --concurrency 4

# 同批样本的纯文本对照
node scripts/benchmark.mjs --provider cloudflare --model clef-omni \
  --dataset data/images/text_baseline.jsonl --concurrency 4
# 图片与清单不同目录时可加 --images-dir <dir>

# 快速冒烟 / 指定输出目录 / 关闭 ensemble
node scripts/benchmark.mjs --provider dashscope --limit 20 --concurrency 2 --out /tmp/bench
node scripts/benchmark.mjs --provider dashscope --limit 200 --pure
```

结果写入 `results/<runId>.json`，同时更新 `results/latest.json`。`--out` 可指定其他目录，避免覆盖主结果。

## 🔌 HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查、provider/model、Key 配置状态 |
| GET | `/api/config` | providers、provider→models 级联、taxonomy、并发选项 |
| GET | `/api/dataset?offset=&limit=&filter=&category=&q=` | 数据集分页/过滤/搜索（图像样本带 `image` 字段） |
| GET | `/api/images/:basename` | 图像样本文件（仅白名单扩展名 + basename，防目录穿越） |
| POST | `/api/benchmark` | 创建跑分任务（202 + runId） |
| GET | `/api/benchmark/:runId` | 查询任务进度/状态 |
| GET | `/api/results?page=&pageSize=` | 历史跑分分页摘要列表（按结束时间倒序，默认每页 10 条） |
| GET | `/api/results/latest` | 最新一次完整结果 |
| GET | `/api/results/:runId` | 指定跑分完整结果 |
| DELETE | `/api/results/:runId` | 删除一条跑分；删除 latest 时自动回退 |
| GET | `/api/results/:runId/export.csv` | 导出 CSV |
| POST | `/api/moderate` | 单条文本审核 |

完整字段与错误码见 [docs/CONTRACT.md](docs/CONTRACT.md)。

## 🗂️ 目录结构

```
├── public/                 # 原生 HTML/CSS/JS 控制台
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── server/                 # 零依赖 Node 服务
│   ├── index.mjs           # HTTP 服务 / 路由 / 静态资源
│   ├── benchmark.mjs       # 跑分引擎 / 指标 / 结果持久化
│   ├── dataset.mjs         # 数据集加载
│   ├── moderation.mjs      # taxonomy / 判定与阈值
│   ├── providers/          # dashscope / bamboonode / jev / cloudflare / mock
│   └── lib/                # env / limiter
├── scripts/
│   ├── prepare_data.py     # 文本数据集构建（Python 标准库）
│   ├── prepare_images.py   # 图像评测集渲染（Python + Pillow，仅数据准备）
│   ├── import_real_images.mjs # 本地真实图像导入（NSFW 等，图片不入库）
│   └── benchmark.mjs       # CLI 跑分器
├── data/
│   ├── eval/               # 825 条文本样本 + stats（入库）
│   ├── images/             # 120 条图像评测集 + 文本对照（入库）
│   └── raw/                # 上游原始数据（不入库）
├── results/                # 跑分结果（*.json 不入库）
├── docs/                   # 契约 + 截图
├── tests/                  # node:test（84 个）
├── REPORT.md               # 完整评测报告
├── LICENSE                 # MIT
└── package.json
```

## ✅ 测试

```bash
npm test          # node --test tests/  → 84 个测试
```

覆盖：taxonomy/解析、env 配置与回退、mock 跑分端到端、指标计算、HTTP 全部端点、Provider/Model 级联、Cloudflare clef-omni endpoint/信封解包/错误处理、图像样本 dataset 校验/多模态 payload/图片读取与 CSV、`/api/images` 路由与 `IMAGE_UNSUPPORTED` 防护、真实图像导入校验（格式/大小/类别/路径）、历史结果摘要/分页/删除、静态资源与路径穿越防护。

## 🧠 设计说明

- 所有真实 provider 都实现同一套 `judge(text)` 契约：`POST <endpoint>`，请求体 `{model, state, questions}`，返回结构化 `answers` 与 token 用量；Cloudflare Workers AI 走同一协议，只是响应包在 `{result,success,errors,messages}` 信封里，由 `server/providers/cloudflare.mjs` 解包并复用同一套解析/阈值逻辑；
- 图像样本在数据集里用可选 `image` 字段（纯文件名）声明；跑分引擎读取图片转成 `{content_type, base64}`，作为 `judge(text, {images})` 的 `ctx.images` 传入，provider 在请求体附带 `images[]` 并把 instructions 切换为图片措辞；`supportsImages !== true` 的 provider 遇到图像样本会被拒绝（`400 IMAGE_UNSUPPORTED`），避免产生误导性分数；
- 单次跑分对每个样本发 **4 个问题**（分类、攻击性、危害性、严重度），再按阈值组合成最终 verdict；`--pure` 可退化为 2 问 argmax 做消融；
- 指标包含二分类 P/R/F1、Wilson 置信区间、分类别 macro/micro F1、来源细分、延迟分位数与吞吐；
- 结果以 JSON 落盘，历史记录接口只返回摘要，前端对比视图无需加载逐条样本。

### 已知局限

- StartLux 的 P50 约 1.7s、P95 约 11.3s（并发 4），明显慢于其他模型，生产使用时需更长超时与重试预算；
- 评测集是公开数据集的标签映射，不是独立人工复核；类别定义与真实业务存在差异；
- Jev 仅跑了 `jev-preview`，`jev-latest` 未跑；
- Cloudflare `clef-omni` 本次仅做默认「4 问 + 阈值」评测，未做 `--pure` 消融；
- 图像评测集当前只覆盖“图内文字”（120 条截图，8 类 × 15），不含真实 NSFW / 暴力实拍图；单类 15 条使分类别 F1 波动较大，不能据此评价模型对真实违规图像内容的识别能力；
- `clef-omni` 图像模式仅测了单图 + 多题组合，未覆盖多图、视频、音频输入；
- 百炼复测使用并发 16，与其余模型的并发 4 不同，吞吐数字不可直接横比；
- 当前是单机 Demo 定位，未包含登录、多租户、任务队列与限流等生产化能力。

## 📄 License

- **代码**：MIT，见 [LICENSE](LICENSE)
- **数据集**：COLD、ToxiCN、Safety-Prompts、中文垃圾短信、NSFW 图片描述，版权归各自作者所有；本仓库仅包含按固定规则生成的评测样本，不分发上游原始文件，详见 [data/README.md](data/README.md)
- **模型输出/跑分结果**：仅用于研究与评测展示，不代表模型官方结论

## 🙏 致谢

- [TypeSafe System One](https://typesafe.ai/) · [StartLux DecisionPivot](https://github.com/StartLuxLabs/DecisionPivot) · 阿里云百炼 · BambooNode · Jev · [Cloudflare Workers AI clef-omni](https://developers.cloudflare.com/workers-ai/models/clef-omni/)
- COLD / ToxiCN / Safety-Prompts / 中文垃圾短信 / NSFW 数据集作者
- 所有指标与截图均由本项目脚本真实运行生成
