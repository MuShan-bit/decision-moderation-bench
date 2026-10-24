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
  <img alt="Node.js >= 20" src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white">
  <img alt="dependencies: 0" src="https://img.shields.io/badge/dependencies-0-brightgreen">
  <img alt="tests: 57 passed" src="https://img.shields.io/badge/tests-57%20passed-brightgreen">
  <img alt="providers: systemone / bamboonode / jev / mock" src="https://img.shields.io/badge/providers-systemone%20%7C%20bamboonode%20%7C%20jev%20%7C%20mock-5eead4">
  <a href="https://github.com/MuShan-bit/decision-moderation-bench"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-decision--moderation--bench-181717?logo=github"></a>
</p>

一个可运行的**多模型中文内容审核跑分平台**：自带 **825 条带金标评测集**、深色 Web 控制台（跑分 / 历史记录 / 模型对比 / 样本浏览器 / 单条体验）、CLI 跑分器和完整评测报告。

真实调用 TypeSafe **System One / typed-decision** 决策模型（百炼 `decision-model-preview`、BambooNode `startlux-decision-27b-autothink`，并已接入 Jev 官方网关），同一批样本、同一套决策逻辑下横向对比**准确率、F1、延迟与吞吐**；零 npm 运行时依赖，离线可用 mock provider 演示。

> 完整方法论、消融、错误分析与复现命令见 **[REPORT.md](REPORT.md)**；接口与数据结构契约见 **[docs/CONTRACT.md](docs/CONTRACT.md)**。

## ✨ 功能

- **多 Provider，同一套协议**：`systemone`（百炼）、`bamboonode`（StartLux）、`jev`（Jev 官方网关）、`mock`（离线规则模拟）
- **Provider → Model 级联**：前端只展示当前 provider 可用的模型，后端对跨 provider 的模型组合直接返回 `400 MODEL_NOT_ALLOWED`
- **可复现评测集**：5 个公开中文数据集、固定 `seed=42`、金标全部来自原始标签映射，数据统计与局限见 [data/README.md](data/README.md)
- **跑分记录按模型分组**：每次跑分独立保存为 `results/<runId>.json`，不再只保留最新一次
- **模型对比视图**：勾选 2–6 条记录，并排比较质量指标、P50/P95、吞吐、分类别 F1；样本数/并发不同会自动提示不可直接比较
- **完整可视化**：准确率/P/R/F1、延迟直方图、混淆矩阵、分类别 F1、来源细分、逐条样本浏览器、单条文本体验
- **零依赖**：后端 `node:http` + 全局 `fetch`，前端原生 HTML/CSS/JS + 内联 SVG 图表；无 CDN、无构建步骤
- **离线可跑**：未配置真实 Key 时自动降级 `mock`，界面明确标注「模拟模式」，不会把模拟结果当真实结果

## 🖼️ 界面预览

### 跑分总览

![跑分总览](docs/assets/overview.png)

### 跑分控制

![跑分控制](docs/assets/run-controls.png)

### 跑分记录（按模型分组）

![跑分记录](docs/assets/history.png)

### 模型对比

勾选任意 2–6 条记录后自动生成；表格最优值标 ★，并附质量、延迟/吞吐与分类别对比。

![模型对比](docs/assets/compare.png)

### 指标图表

![延迟分布与混淆矩阵](docs/assets/latency-confusion.png)

![分类别 F1](docs/assets/category-f1.png)

![来源细分](docs/assets/source-table.png)

### 样本浏览器

支持判错/违规/正常筛选、类别过滤、原文搜索；敏感文本默认打码。

![样本浏览器](docs/assets/samples.png)

### 单条体验

直接粘贴文本调用 `/api/moderate`，查看违规判定、类别、严重度、置信度与原始响应。

![单条体验](docs/assets/moderate.png)

> 完整页面长图：[docs/assets/dashboard.png](docs/assets/dashboard.png)

## 📊 模型测评结果

评测条件：**825 条**中文带金标样本（违规 63.6%）、并发 **4**、同一套「4 问 + 阈值」决策逻辑、2026-10-23 实测。

| 模型 | Provider | 准确率 | 精确率 | 召回率 | F1 | P50 延迟 | P95 延迟 | 吞吐 | 825 条总耗时 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `decision-model-preview` | 百炼 `systemone` | 73.2% | 83.5% | 72.2% | 0.774 | **130ms** | **1.94s** | **11.03 req/s** | **74.8s** |
| `startlux-decision-27b-autothink` | BambooNode `bamboonode` | **83.8%** | **86.5%** | **88.2%** | **0.874** | 1.53s | 7.98s | 1.58 req/s | 8m41s |
| `jev-preview` / `jev-latest` | Jev 官方 `jev` | 已接入 | — | — | — | — | — | — | 本次环境 Key 返回 `401`，待补 |

- **StartLux 质量更高**：准确率 **+10.6pt**、F1 **+10.0pt**、召回率 **+16.0pt**，尤其补强了百炼最弱的 hate（F1 0.228 → 0.550）与 spam（0.326 → 0.875）。
- **百炼速度快一个数量级**：P50 **130ms vs 1.53s（×11.8）**，吞吐 **11.03 vs 1.58 req/s（÷7.0）**，更适合高吞吐一审。
- 解析失败与调用错误均为 **0**；tokens：百炼 473,090（573/条），StartLux 699,963（848/条）。
- 200 条样本档复测：百炼 ensemble **73.5%**、StartLux **85.0%**，与全量结论一致；百炼纯 argmax 仅 **61.5%**（消融详见报告）。
- Jev 官方网关已支持 `provider=jev` 与模型别名 `jev-preview` / `jev-latest`，但当前环境的 `JEVMODEL_API_KEY` 被官方网关拒绝（`401 Missing or invalid API key`），因此不列结果；换有效 Key 后执行 `node scripts/benchmark.mjs --provider jev --model jev-preview --concurrency 4` 即可补齐。

### 分类别 F1 对比（825 条）

| 类别 | 支持数 | 百炼 `decision-model-preview` | StartLux | 提升 |
| --- | ---: | ---: | ---: | ---: |
| 辱骂攻击 insult | 195 | 0.639 | **0.724** | +0.085 |
| 歧视仇恨 hate | 115 | 0.228 | **0.550** | **+0.322** |
| 色情低俗 sexual | 45 | 0.714 | **0.774** | +0.060 |
| 暴力血腥 violence | 35 | **0.879** | 0.790 | −0.089 |
| 违法犯罪 illegal | 40 | 0.804 | **0.854** | +0.050 |
| 广告垃圾 spam | 70 | 0.326 | **0.875** | **+0.549** |
| 隐私侵权 privacy | 25 | 0.571 | **0.714** | +0.143 |

> 数据口径：金标来自公开数据集原生标签映射，并非独立人工复核；违规比例 63.6% 高于真实业务，准确率不能直接外推到线上。详见 [REPORT.md](REPORT.md) 与 [data/README.md](data/README.md)。

## 🚀 快速开始

要求：**Node.js ≥ 20**（项目在 v24 验证），无需 `npm install`。

```bash
git clone https://github.com/MuShan-bit/decision-moderation-bench.git
cd decision-moderation-bench

cp .env.example .env
# 编辑 .env，按需填写：
#   DASHSCOPE_API_KEY + SYSTEMONE_WORKSPACE_ID   # 百炼 systemone
#   BAMBOONODE_API_KEY                           # BambooNode / StartLux
#   JEVMODEL_API_KEY                             # Jev 官方网关

npm start
# 打开 http://127.0.0.1:8788
```

没有 Key 也能启动：自动使用 `mock` provider，界面显示「模拟模式」。

### 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DASHSCOPE_API_KEY` | 跑 `systemone` 必填 | 阿里云百炼 API Key |
| `SYSTEMONE_WORKSPACE_ID` | 跑 `systemone` 必填 | 百炼 workspace id，默认域名 `https://{id}.cn-beijing.maas.aliyuncs.com` |
| `SYSTEMONE_REGION` | 否 | 默认 `cn-beijing` |
| `BAMBOONODE_API_KEY` | 跑 `bamboonode` 必填 | BambooNode 网关 Key |
| `BAMBOONODE_BASE_URL` | 否 | 默认 `https://api.bamboonode.dev/v1` |
| `BAMBOONODE_MODELS` | 否 | 默认 `startlux-decision-27b-autothink`（逗号分隔） |
| `JEVMODEL_API_KEY` | 跑 `jev` 必填 | Jev 官方网关 Key（<https://jevmodel.org/dashboard/> 创建） |
| `JEVMODEL_BASE_URL` | 否 | 默认 `https://jevmodel.org/v1` |
| `JEVMODEL_MODELS` | 否 | 默认 `jev-preview,jev-latest` |
| `MODERATION_PROVIDER` | 否 | 默认 `systemone`；可选 `systemone` / `bamboonode` / `jev` / `mock` |
| `MODERATION_MODEL` | 否 | 默认 `decision-model-preview` |
| `PORT` / `HOST` | 否 | 默认 `8788` / `127.0.0.1` |
| `RESULTS_DIR` | 否 | 结果目录，默认 `results/` |

> ⚠️ `.env` 已被 `.gitignore` 忽略，请勿把 Key 提交到仓库。前端与 API 均不会回显 Key。

## 🧪 数据集

> 仓库包含用于内容安全评测的敏感文本样本；Web 端对敏感样本默认打码，请按研究/评测目的使用。

- [data/eval/samples.jsonl](data/eval/samples.jsonl)：**825 条**，违规 525 / 正常 300，平均 54 字，零重复
- 来源：COLD 320、ToxiCN 240、垃圾短信 120、Safety-Prompts 100、NSFW 图片描述 45
- 生成：`python3 scripts/prepare_data.py`（纯标准库，固定 `seed=42`）
- 原始数据集缓存在 `data/raw/`，**不纳入仓库**（遵循上游分发条款）；重新生成需按 [data/README.md](data/README.md) 准备原始文件
- 生成结果：`data/eval/samples.jsonl` + `data/eval/stats.json`

## 🖥️ Web 使用

1. **配置跑分**：选择样本数、并发、Provider、Model（Model 随 Provider 级联）；
2. **开始跑分**：任务异步执行，进度条实时更新；完成后展示 KPI、延迟直方图、混淆矩阵、分类别 F1、来源细分；
3. **查看历史**：「跑分记录」按 `provider/model` 分组，点「查看」切换到任意一次结果；
4. **模型对比**：勾选 2–6 条记录，自动出现对比表与图表；样本数/并发不同会提示不可直接比较；
5. **样本浏览器**：筛选判错/违规/正常、按类别过滤、搜索原文，敏感文本默认打码；
6. **单条体验**：粘贴文本调用 `/api/moderate` 查看 verdict；
7. **导出**：当前结果可导出 CSV（含逐条预测、延迟、tokens 与原文）。

## ⌨️ CLI 跑分

```bash
# 全部 825 条，并发 4
node scripts/benchmark.mjs --provider systemone --model decision-model-preview --concurrency 4

# StartLux（BambooNode）
node scripts/benchmark.mjs --provider bamboonode --model startlux-decision-27b-autothink --concurrency 4

# Jev 官方网关
node scripts/benchmark.mjs --provider jev --model jev-preview --concurrency 4

# 快速冒烟 / 指定输出目录 / 关闭 ensemble
node scripts/benchmark.mjs --provider systemone --limit 20 --concurrency 2 --out /tmp/bench
node scripts/benchmark.mjs --provider systemone --limit 200 --pure
```

结果写入 `results/<runId>.json`，同时更新 `results/latest.json`。`--out` 可指定其他目录，避免覆盖主结果。

## 🔌 HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查、provider/model、Key 配置状态 |
| GET | `/api/config` | providers、provider→models 级联、taxonomy、并发选项 |
| GET | `/api/dataset?offset=&limit=&filter=&category=&q=` | 数据集分页/过滤/搜索 |
| POST | `/api/benchmark` | 创建跑分任务（202 + runId） |
| GET | `/api/benchmark/:runId` | 查询任务进度/状态 |
| GET | `/api/results` | 历史跑分摘要列表（按结束时间倒序） |
| GET | `/api/results/latest` | 最新一次完整结果 |
| GET | `/api/results/:runId` | 指定跑分完整结果 |
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
│   ├── providers/          # systemone / bamboonode / jev / mock
│   └── lib/                # env / limiter
├── scripts/
│   ├── prepare_data.py     # 数据集构建（Python 标准库）
│   └── benchmark.mjs       # CLI 跑分器
├── data/
│   ├── eval/               # 825 条样本 + stats（入库）
│   └── raw/                # 上游原始数据（不入库）
├── results/                # 跑分结果（*.json 不入库）
├── docs/                   # 契约 + 截图
├── tests/                  # node:test（57 个）
├── REPORT.md               # 完整评测报告
├── LICENSE                 # MIT
└── package.json
```

## ✅ 测试

```bash
npm test          # node --test tests/  → 57 个测试
```

覆盖：taxonomy/解析、env 配置与回退、mock 跑分端到端、指标计算、HTTP 全部端点、Provider/Model 级联、历史结果摘要、静态资源与路径穿越防护。

## 🧠 设计说明

- 所有真实 provider 都实现同一套 `judge(text)` 契约：`POST <endpoint>/systemone`，请求体 `{model, state, questions}`，返回结构化 `answers` 与 token 用量；
- 单次跑分对每个样本发 **4 个问题**（分类、攻击性、危害性、严重度），再按阈值组合成最终 verdict；`--pure` 可退化为 2 问 argmax 做消融；
- 指标包含二分类 P/R/F1、Wilson 置信区间、分类别 macro/micro F1、来源细分、延迟分位数与吞吐；
- 结果以 JSON 落盘，历史记录接口只返回摘要，前端对比视图无需加载逐条样本。

### 已知局限

- StartLux 的 P50 约 1.5s、P95 约 8s，明显慢于百炼决策模型，生产使用时需更长超时与重试预算；
- 评测集是公开数据集的标签映射，不是独立人工复核；类别定义与真实业务存在差异；
- Jev 官方网关本次因 Key 无效未取得结果；
- 当前是单机 Demo 定位，未包含登录、多租户、任务队列与限流等生产化能力。

## 📄 License

- **代码**：MIT，见 [LICENSE](LICENSE)
- **数据集**：COLD、ToxiCN、Safety-Prompts、中文垃圾短信、NSFW 图片描述，版权归各自作者所有；本仓库仅包含按固定规则生成的评测样本，不分发上游原始文件，详见 [data/README.md](data/README.md)
- **模型输出/跑分结果**：仅用于研究与评测展示，不代表模型官方结论

## 🙏 致谢

- [TypeSafe System One](https://typesafe.ai/) · [StartLux DecisionPivot](https://github.com/StartLuxLabs/DecisionPivot) · 阿里云百炼 · BambooNode · Jev
- COLD / ToxiCN / Safety-Prompts / 中文垃圾短信 / NSFW 数据集作者
- 所有指标与截图均由本项目脚本真实运行生成
