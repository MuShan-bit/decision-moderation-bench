// 零依赖 .env 读取 + 运行配置。只读取 .env，绝不写回。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_DATASET_ID,
  profileByDatasetPath,
  profileById,
  resolveDatasetPaths,
} from '../dataset-profiles.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根目录（server/lib/env.mjs -> ../../） */
export const ROOT = path.resolve(HERE, '..', '..');

export const DEFAULT_MODELS = Object.freeze(['decision-model-preview']);
export const DEFAULT_PROVIDER = 'dashscope';
export const DEFAULT_MODEL = 'decision-model-preview';
export const CONCURRENCY_OPTIONS = Object.freeze([1, 2, 4, 8, 16]);

// BambooNode 网关：OpenAI 兼容 + System One（typed-decision）接口，托管 Jev / StartLux 决策模型。
// 网关 /api/pricing 目前可用的决策模型：typesafe/jev-1.13、typesafe/jev-1.14、
// startlux-decision-27b-autothink。接口需要 BAMBOONODE_API_KEY。
export const DEFAULT_BAMBOONODE_BASE_URL = 'https://api.bamboonode.dev/v1';
export const DEFAULT_BAMBOONODE_MODELS = Object.freeze(['startlux-decision-27b-autothink']);

// Jev / TypeSafe 官方网关（System One 协议）：POST https://api.typesafe.ai/v1/systemone
// 模型：jev-preview（1.14.0，最新）/ jev-latest（1.13.0，stable）。
export const DEFAULT_JEVMODEL_BASE_URL = 'https://api.typesafe.ai/v1';
export const DEFAULT_JEVMODEL_MODELS = Object.freeze(['jev-preview', 'jev-latest']);

// Cloudflare Workers AI（clef-omni，System One typed-decision 协议）：
//   POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/@cf/cloudflare/clef-omni
// 文档：https://developers.cloudflare.com/workers-ai/models/clef-omni/
// 需要 CLOUDFLARE_API_TOKEN（Workers AI - Read/Edit 权限）与 CLOUDFLARE_ACCOUNT_ID。
// 响应包在 Cloudflare 标准信封 {result,success,errors,messages} 中，result 为 {model,answers,usage}。
export const DEFAULT_CLOUDFLARE_BASE_URL = 'https://api.cloudflare.com/client/v4';
export const DEFAULT_CLOUDFLARE_MODELS = Object.freeze(['clef-omni']);

/** 极简 dotenv 解析：支持注释、引号、行内 # 注释 */
export function parseDotEnv(content) {
  const out = Object.create(null);
  for (const line of String(content ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

let envLoaded = false;

/**
 * 载入 .env（幂等）。已存在的进程环境变量优先，不会被 .env 覆盖。
 * 这是唯一读取 .env 的地方，rest 代码只通过 getConfig() 拿值。
 */
export function loadEnv({ filePath = process.env.DOTENV_PATH || path.join(ROOT, '.env'), override = false } = {}) {
  if (envLoaded && !override) return;
  envLoaded = true;
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return; // .env 不存在是允许的（mock 模式 / 环境变量直传）
  }
  const parsed = parseDotEnv(content);
  for (const [key, value] of Object.entries(parsed)) {
    const current = process.env[key];
    if (override || current === undefined || current === '') process.env[key] = value;
  }
}

/** 仅供测试：允许重新载入 .env */
export function resetEnvCache() {
  envLoaded = false;
}

function toInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toFloat(value, fallback) {
  const n = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : fallback;
}

function normalizeBaseUrl(value, fallback) {
  const text = String(value ?? '').trim() || fallback;
  return text.replace(/\/+$/, '');
}

function parseList(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return [...fallback];
  const list = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : [...fallback];
}

/**
 * 读取运行配置（每次调用都从 process.env 现取，方便测试与热改）。
 * 注意：返回对象含明文 apiKey，禁止整体打印 / 写入文件。
 */
export function getConfig(env = process.env) {
  const models = parseList(env.MODERATION_MODELS, DEFAULT_MODELS);
  const model = (env.MODERATION_MODEL || '').trim() || models[0] || DEFAULT_MODEL;
  if (!models.includes(model)) models.unshift(model);

  const requestedProvider = String(env.MODERATION_PROVIDER ?? '').trim();
  const normalizedProvider = requestedProvider === 'systemone' ? 'dashscope' : requestedProvider;
  const configuredProvider = ['dashscope', 'bamboonode', 'jev', 'cloudflare', 'mock'].includes(
    normalizedProvider,
  )
    ? normalizedProvider
    : DEFAULT_PROVIDER;
  const apiKey = String(env.DASHSCOPE_API_KEY ?? '').trim();
  const workspaceId = String(
    env.SYSTEMONE_WORKSPACE_ID || env.BAILIAN_WORKSPACE_ID || env.DASHSCOPE_WORKSPACE_ID || '',
  ).trim();
  const systemoneRegion = String(env.SYSTEMONE_REGION ?? '').trim() || 'cn-beijing';
  const systemoneBaseUrl = String(env.SYSTEMONE_BASE_URL ?? '').trim();
  const systemoneEnsemble = String(env.SYSTEMONE_ENSEMBLE ?? '').trim() !== '0';
  const bamboonodeBaseUrl = normalizeBaseUrl(env.BAMBOONODE_BASE_URL, DEFAULT_BAMBOONODE_BASE_URL);
  const bamboonodeApiKey = String(env.BAMBOONODE_API_KEY ?? '').trim();
  const bamboonodeModels = parseList(env.BAMBOONODE_MODELS, DEFAULT_BAMBOONODE_MODELS);
  const jevBaseUrl = normalizeBaseUrl(env.JEVMODEL_BASE_URL || env.JEV_BASE_URL, DEFAULT_JEVMODEL_BASE_URL);
  const jevApiKey = String(env.JEVMODEL_API_KEY || env.JEV_API_KEY || '').trim();
  const jevModels = parseList(env.JEVMODEL_MODELS || env.JEV_MODELS, DEFAULT_JEVMODEL_MODELS);
  const cloudflareBaseUrl = normalizeBaseUrl(
    env.CLOUDFLARE_BASE_URL,
    DEFAULT_CLOUDFLARE_BASE_URL,
  );
  const cloudflareApiToken = String(
    env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_AUTH_TOKEN || '',
  ).trim();
  const cloudflareAccountId = String(env.CLOUDFLARE_ACCOUNT_ID ?? '').trim();
  const cloudflareModels = parseList(env.CLOUDFLARE_MODELS, DEFAULT_CLOUDFLARE_MODELS);
  // 真实 provider 缺少 Key/Workspace 时回退 mock，保证离线也能打开 demo；显式指定时 API 仍会报配置缺失。
  const providerReady =
    configuredProvider === 'dashscope'
      ? Boolean(apiKey && (workspaceId || systemoneBaseUrl))
      : configuredProvider === 'bamboonode'
        ? Boolean(bamboonodeApiKey)
        : configuredProvider === 'jev'
          ? Boolean(jevApiKey)
          : configuredProvider === 'cloudflare'
            ? Boolean(cloudflareApiToken && cloudflareAccountId)
            : true;
  const effectiveProvider = providerReady ? configuredProvider : 'mock';

  const resultsDir = env.RESULTS_DIR
    ? path.resolve(ROOT, String(env.RESULTS_DIR))
    : path.join(ROOT, 'results');

  // 评测集选择：
  // - DATASET=text / text-image / nsfw-image 使用内置档案路径；
  // - DATASET_PATH 显式指向自定义数据集（若正好等于内置档案则映射回该 id）；
  // - 两者都未设置时默认 text（data/eval）。
  const datasetEnvId = String(env.DATASET ?? '').trim();
  const datasetProfile = datasetEnvId ? profileById(datasetEnvId) : null;
  const datasetPath = env.DATASET_PATH
    ? path.resolve(ROOT, String(env.DATASET_PATH))
    : datasetProfile
      ? resolveDatasetPaths(datasetProfile).path
      : resolveDatasetPaths(profileById(DEFAULT_DATASET_ID)).path;
  const matchedProfile =
    profileByDatasetPath(datasetPath) || (env.DATASET_PATH ? null : datasetProfile);
  const datasetId = matchedProfile?.id || 'custom';
  const datasetEnvError =
    datasetEnvId && !profileById(datasetEnvId)
      ? `未知 DATASET：${datasetEnvId}（可选 text / text-image / nsfw-image）；已${env.DATASET_PATH ? '忽略并使用 DATASET_PATH' : '回退到 text'}`
      : null;
  // 图像样本默认与数据集清单同目录（image 字段只存 basename），可用 IMAGES_DIR 覆盖
  const imagesDir = env.IMAGES_DIR
    ? path.resolve(ROOT, String(env.IMAGES_DIR))
    : matchedProfile?.imagesRelPath
      ? resolveDatasetPaths(matchedProfile).imagesDir
      : path.dirname(datasetPath);
  const publicDir = env.PUBLIC_DIR
    ? path.resolve(ROOT, String(env.PUBLIC_DIR))
    : path.join(ROOT, 'public');

  return {
    root: ROOT,
    port: toInt(env.PORT, 8788),
    host: String(env.HOST ?? '').trim() || '127.0.0.1',
    apiKey,
    apiKeyConfigured: Boolean(apiKey),
    workspaceId,
    workspaceConfigured: Boolean(workspaceId),
    systemoneRegion,
    systemoneBaseUrl,
    systemoneEnsemble,
    bamboonodeBaseUrl,
    bamboonodeApiKey,
    bamboonodeApiKeyConfigured: Boolean(bamboonodeApiKey),
    bamboonodeModels,
    jevBaseUrl,
    jevApiKey,
    jevApiKeyConfigured: Boolean(jevApiKey),
    jevModels,
    cloudflareBaseUrl,
    cloudflareApiToken,
    cloudflareApiTokenConfigured: Boolean(cloudflareApiToken),
    cloudflareAccountId,
    cloudflareAccountIdConfigured: Boolean(cloudflareAccountId),
    cloudflareModels,
    model,
    models,
    provider: configuredProvider,
    effectiveProvider,
    timeoutMs: Math.max(1000, toInt(env.MODERATION_TIMEOUT_MS, 20000)),
    maxRetries: Math.max(0, toInt(env.MODERATION_MAX_RETRIES, 3)),
    concurrencyOptions: [...CONCURRENCY_OPTIONS],
    mockLatencyScale: Math.max(0, toFloat(env.MOCK_LATENCY_SCALE, 1)),
    resultsDir,
    dataset: datasetId,
    datasetEnvError,
    datasetPath,
    imagesDir,
    publicDir,
  };
}

/** 安全版配置（apiKey 脱敏），用于日志/调试 */
export function redactConfig(cfg = getConfig()) {
  return {
    ...cfg,
    apiKey: cfg.apiKey ? '***configured***' : '',
    bamboonodeApiKey: cfg.bamboonodeApiKey ? '***configured***' : '',
    jevApiKey: cfg.jevApiKey ? '***configured***' : '',
    workspaceId: cfg.workspaceId ? '***configured***' : '',
    cloudflareApiToken: cfg.cloudflareApiToken ? '***configured***' : '',
    cloudflareAccountId: cfg.cloudflareAccountId ? '***configured***' : '',
    apiKeyConfigured: Boolean(cfg.apiKey),
    workspaceConfigured: Boolean(cfg.workspaceId),
    cloudflareApiTokenConfigured: Boolean(cfg.cloudflareApiToken),
    cloudflareAccountIdConfigured: Boolean(cfg.cloudflareAccountId),
  };
}
