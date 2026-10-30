#!/usr/bin/env node
// 跑分 CLI：复用 server/benchmark.mjs。
// 用法：node scripts/benchmark.mjs --provider mock --limit 30 --concurrency 2
import path from 'node:path';
import { loadEnv, getConfig, ROOT } from '../server/lib/env.mjs';
import { profileById } from '../server/dataset-profiles.mjs';
import {
  assertDatasetModel,
  assertDatasetProvider,
  resolveCustomDataset,
  resolveDatasetSelection,
} from '../server/datasets.mjs';
import {
  createProvider,
  PROVIDER_NAMES,
  resolveModelForProvider,
  normalizeProviderName,
} from '../server/providers/index.mjs';
import {
  runBenchmark,
  nextRunId,
  MAX_CONCURRENCY,
  DEFAULT_CONCURRENCY,
} from '../server/benchmark.mjs';

loadEnv();

const HELP = `内容审核跑分 CLI（零依赖）

用法：
  node scripts/benchmark.mjs [options]

选项：
  -n, --limit <n>          参与跑分的样本数（默认：全部）
  -c, --concurrency <n>    并发数 1-${MAX_CONCURRENCY}（默认：${DEFAULT_CONCURRENCY}）
  -p, --provider <name>    provider：${PROVIDER_NAMES.join(' | ')}（默认取 .env MODERATION_PROVIDER，否则 dashscope）
  -m, --model <name>       模型名（默认取该 provider 的默认模型；bamboonode 可选 typesafe/jev-1.14 等）
      --dataset <name|path> 数据集：text（默认文本）/ text-image（截图）/ nsfw-image（本地实拍）/ 自定义 jsonl 路径
      --images-dir <dir>   图像样本目录（默认：数据集所在目录）
      --out <dir>          结果输出目录（默认 results/）
      --pure               决策模型消融：关闭 attack/harmful 组合，仅 category 做 argmax
      --json               只输出最终 result JSON（便于脚本处理）
  -h, --help               显示帮助

示例：
  node scripts/benchmark.mjs --provider mock --limit 30 --concurrency 2
  node scripts/benchmark.mjs --provider dashscope --model decision-model-preview --limit 200 --concurrency 4
  node scripts/benchmark.mjs --provider bamboonode --model startlux-decision-27b-autothink --limit 200 --concurrency 4
  node scripts/benchmark.mjs --provider jev --model jev-preview --limit 200 --concurrency 4
  node scripts/benchmark.mjs --provider cloudflare --model clef-omni --limit 200 --concurrency 4
  node scripts/benchmark.mjs --provider cloudflare --model clef-omni --dataset text-image --concurrency 4
  node scripts/benchmark.mjs --provider cloudflare --model clef-omni --dataset nsfw-image --concurrency 2
  node scripts/benchmark.mjs --provider cloudflare --model clef-omni --dataset data/images/text_baseline.jsonl --concurrency 4
`;

function fail(message) {
  console.error(`[benchmark] 错误：${message}`);
  process.exit(1);
}

export function parseArgs(argv) {
  const options = { limit: null, concurrency: null, provider: null, model: null, pure: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eqIndex = arg.indexOf('=');
    const flag = eqIndex >= 0 ? arg.slice(0, eqIndex) : arg;
    const inlineValue = eqIndex >= 0 ? arg.slice(eqIndex + 1) : null;

    const takeValue = (name) => {
      if (inlineValue !== null) return inlineValue;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) fail(`${name} 缺少参数值`);
      i += 1;
      return next;
    };

    switch (flag) {
      case '--pure':
        options.pure = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-n':
      case '--limit':
        options.limit = takeValue('--limit');
        break;
      case '-c':
      case '--concurrency':
        options.concurrency = takeValue('--concurrency');
        break;
      case '-p':
      case '--provider':
        options.provider = takeValue('--provider');
        break;
      case '-m':
      case '--model':
        options.model = takeValue('--model');
        break;
      case '--dataset':
        options.dataset = takeValue('--dataset');
        break;
      case '--images-dir':
        options.imagesDir = takeValue('--images-dir');
        break;
      case '--out':
        options.out = takeValue('--out');
        break;
      case '--json':
        options.json = true;
        break;
      default:
        fail(`未知参数：${arg}（用 --help 查看用法）`);
    }
  }
  return options;
}

function formatPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(2)}%`;
}

function formatMs(value) {
  return `${Number(value || 0).toFixed(1)}ms`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const cfg = getConfig();
  const providerName = normalizeProviderName((args.provider || cfg.effectiveProvider || 'dashscope').trim());
  if (!PROVIDER_NAMES.includes(providerName)) {
    fail(`不支持的 provider：${providerName}（可选 ${PROVIDER_NAMES.join(' / ')}）`);
  }
  if (providerName === 'dashscope' && !cfg.apiKey) {
    fail('DASHSCOPE_API_KEY 未配置，无法使用 dashscope；请改用 --provider mock');
  }
  if (providerName === 'dashscope' && !cfg.workspaceId && !cfg.systemoneBaseUrl) {
    fail('SYSTEMONE_WORKSPACE_ID 未配置，无法使用 dashscope；请配置业务空间 ID 或 --provider mock');
  }
  if (providerName === 'bamboonode' && !cfg.bamboonodeApiKey) {
    fail('BAMBOONODE_API_KEY 未配置，无法使用 StartLux 决策模型；请在 .env 中配置该网关的 Key');
  }
  if (providerName === 'jev' && !cfg.jevApiKey) {
    fail('JEVMODEL_API_KEY 未配置，无法使用 Jev 官方网关；请在 .env 中配置该 Key');
  }
  if (providerName === 'cloudflare' && !cfg.cloudflareApiToken) {
    fail('CLOUDFLARE_API_TOKEN 未配置，无法使用 Cloudflare Workers AI clef-omni；请在 .env 中配置 API Token');
  }
  if (providerName === 'cloudflare' && !cfg.cloudflareAccountId) {
    fail('CLOUDFLARE_ACCOUNT_ID 未配置，无法使用 Cloudflare Workers AI；请在 .env 中配置 Account ID');
  }

  let model;
  try {
    // 级联校验：模型必须属于当前 provider（dashscope → decision-model-preview；mock → mock-rule-v1）
    model = resolveModelForProvider(providerName, args.model, cfg);
  } catch (error) {
    fail(error.message);
  }

  const limit = args.limit === null ? null : Number(args.limit);
  if (limit !== null && (!Number.isFinite(limit) || limit < 1)) {
    fail('--limit 必须是正整数');
  }
  const concurrency =
    args.concurrency === null ? DEFAULT_CONCURRENCY : Number(args.concurrency);
  if (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    fail(`--concurrency 必须是 1-${MAX_CONCURRENCY} 的整数`);
  }

  // 数据集：支持内置档案名（text / text-image / nsfw-image）或自定义 jsonl 路径
  let selection;
  try {
    const preset = args.dataset && profileById(args.dataset);
    selection = preset
      ? resolveDatasetSelection(cfg, args.dataset)
      : args.dataset
        ? resolveCustomDataset(
            path.resolve(ROOT, args.dataset),
            args.imagesDir ? path.resolve(ROOT, args.imagesDir) : null,
          )
        : resolveDatasetSelection(cfg, null);
    if (args.imagesDir) selection.imagesDir = path.resolve(ROOT, args.imagesDir);
    assertDatasetProvider(selection, providerName);
    assertDatasetModel(selection, model);
  } catch (error) {
    fail(error.message);
  }
  const dataset = { samples: selection.samples, fallback: selection.available !== true };
  const datasetPath = selection.path;
  if (!dataset.samples.length) fail('数据集为空，无法跑分');
  const imagesDir = selection.imagesDir;

  const resultsDir = args.out ? path.resolve(ROOT, args.out) : cfg.resultsDir;

  const providerOptions = {
    provider: providerName,
    model,
    concurrency,
    ensemble: args.pure ? false : undefined,
    timeoutMs: cfg.timeoutMs,
    maxRetries: cfg.maxRetries,
    latencyScale: cfg.mockLatencyScale,
  };
  const provider =
    providerName === 'bamboonode'
      ? createProvider({
          ...providerOptions,
          apiKey: cfg.bamboonodeApiKey,
          baseUrl: cfg.bamboonodeBaseUrl,
        })
      : providerName === 'jev'
        ? createProvider({
            ...providerOptions,
            apiKey: cfg.jevApiKey,
            baseUrl: cfg.jevBaseUrl,
          })
        : providerName === 'cloudflare'
          ? createProvider({
              ...providerOptions,
              apiToken: cfg.cloudflareApiToken,
              accountId: cfg.cloudflareAccountId,
              baseUrl: cfg.cloudflareBaseUrl,
            })
          : createProvider({
              ...providerOptions,
              apiKey: cfg.apiKey,
              workspaceId: cfg.workspaceId,
              region: cfg.systemoneRegion,
              systemoneBaseUrl: cfg.systemoneBaseUrl,
            });

  const total = limit === null ? dataset.samples.length : Math.min(limit, dataset.samples.length);
  const runId = nextRunId(resultsDir);

  if (!args.json) {
    console.log('=== 内容审核跑分 ===');
    console.log(`runId      : ${runId}`);
    console.log(`provider   : ${provider.name}${provider.simulated ? '  ⚠️ 模拟模式（结果非真实模型输出）' : ''}`);
    console.log(`model      : ${provider.model}`);
    console.log(`样本       : ${total} / ${dataset.samples.length}（并发 ${concurrency}）`);
    console.log(
      `数据集     : ${selection.id} · ${selection.name}（${selection.kind}）`,
    );
    console.log(
      `数据集路径 : ${
        dataset.fallback
          ? `内置兜底样本（${selection.error}）`
          : datasetPath
      }`,
    );
    const imageCount = dataset.samples.slice(0, total).filter((sample) => sample.image).length;
    if (imageCount > 0) {
      console.log(`图像样本   : ${imageCount}（图片目录 ${imagesDir}）`);
    }
    console.log('------------------------------');
  }

  const startedAtWall = Date.now();
  let lastPrint = 0;
  const result = await runBenchmark({
    samples: dataset.samples,
    provider,
    model,
    limit: total,
    concurrency,
    runId,
    resultsDir,
    imagesDir,
    datasetMeta: {
      id: selection.id,
      name: selection.name,
      kind: selection.kind,
      modality: selection.modality,
    },
    datasetFallback: dataset.fallback === true,
    takenRunIds: new Set([runId]),
    onProgress: ({ done, total: all }) => {
      if (args.json) return;
      const now = Date.now();
      if (done < all && now - lastPrint < 120) return;
      lastPrint = now;
      const percent = ((done / all) * 100).toFixed(1);
      process.stdout.write(`\r进度 ${done}/${all}（${percent}%）   `);
    },
  });
  if (!args.json) process.stdout.write('\r\x1b[K');

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const { metrics } = result;
  const { binary, latency, tokens } = metrics;
  console.log('=== 跑分完成 ===');
  console.log(
    `准确率 ${formatPercent(binary.accuracy)} | 精确率 ${formatPercent(
      binary.precision,
    )} | 召回率 ${formatPercent(binary.recall)} | F1 ${formatPercent(binary.f1)}`,
  );
  console.log(
    `样本 ${binary.total} | 有效 ${binary.valid} | 解析失败 ${binary.parseFail} | 调用错误 ${binary.errors}`,
  );
  console.log(
    `TP ${binary.tp} / TN ${binary.tn} / FP ${binary.fp} / FN ${binary.fn} | macroF1 ${metrics.macroCategoryF1} | microF1 ${metrics.microCategoryF1}`,
  );
  console.log(
    `延迟 mean ${formatMs(latency.mean)} p50 ${formatMs(latency.p50)} p90 ${formatMs(
      latency.p90,
    )} p95 ${formatMs(latency.p95)} p99 ${formatMs(latency.p99)} max ${formatMs(latency.max)}`,
  );
  console.log(
    `吞吐 ${latency.throughputRps} req/s | 总耗时 ${(latency.totalWallMs / 1000).toFixed(
      2,
    )}s | tokens ${tokens.total}（平均 ${tokens.avgTotal}）`,
  );
  console.log(`结果已写入：${path.join(resultsDir, `${runId}.json`)}`);
  console.log(`同时更新：${path.join(resultsDir, 'latest.json')}`);
  console.log(`实际用时：${((Date.now() - startedAtWall) / 1000).toFixed(2)}s`);
}

main().catch((error) => {
  console.error(`[benchmark] 失败：${error?.message || error}`);
  process.exitCode = 1;
});
