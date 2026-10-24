// HTTP 服务：零依赖 node:http，提供 public/ 静态资源 + 契约第 4 节全部 /api 路由。
// 设计要点：
// - 数据集缺失时照常启动（内置兜底样本），数据文件出现后自动热加载；
// - 跑分任务异步执行，进度可轮询；结果文件由 benchmark 模块原子写入；
// - 静态文件做路径归一化，杜绝目录穿越；任何响应都是 JSON（静态资源除外）。
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadEnv, getConfig } from './lib/env.mjs';
import { getDataset, filterSamples } from './dataset.mjs';
import { taxonomyConfig } from './moderation.mjs';
import {
  PROVIDER_NAMES,
  createProvider,
  providerModels,
  resolveModelForProvider,
  normalizeProviderName,
  ProviderConfigError,
} from './providers/index.mjs';
import {
  runBenchmark,
  nextRunId,
  readResult,
  readLatestResult,
  listResults,
  deleteResult,
  hasLatestResult,
  resultToCsv,
  MAX_CONCURRENCY,
  DEFAULT_CONCURRENCY,
} from './benchmark.mjs';

loadEnv();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const MAX_BODY_BYTES = 1_000_000;
const MAX_TEXT_LENGTH = 8000;
const MAX_JOBS_KEPT = 60;

/** 运行中的跑分任务（进程内） */
const benchmarkJobs = new Map();
/** provider 实例缓存（复用并发限制器） */
const providerCache = new Map();
/** /api/config 的 latestResultId 缓存 */
const latestResultCache = { mtimeMs: -1, size: -1, runId: null };

class HttpError extends Error {
  constructor(status, message, code = 'HTTP_ERROR') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload ?? null), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

async function readJsonBody(req, { allowEmpty = true } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, '请求体过大（上限 1MB）', 'BODY_TOO_LARGE');
    }
    chunks.push(chunk);
  }
  if (size === 0) {
    if (allowEmpty) return {};
    throw new HttpError(400, '缺少请求体', 'EMPTY_BODY');
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) {
    if (allowEmpty) return {};
    throw new HttpError(400, '缺少请求体', 'EMPTY_BODY');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON', 'INVALID_JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, '请求体必须是 JSON 对象', 'INVALID_BODY');
  }
  return parsed;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, '路径编码非法', 'INVALID_PATH');
  }
}

function parseIntegerParam(value, fallback, min, max) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function getProviderFor(providerName, model) {
  const cfg = getConfig();
  const cacheKey = `${providerName}|${model || ''}`;
  if (providerCache.has(cacheKey)) return providerCache.get(cacheKey);

  let provider;
  try {
    const common = {
      provider: providerName,
      model,
      concurrency: MAX_CONCURRENCY,
      ensemble: cfg.systemoneEnsemble,
      timeoutMs: cfg.timeoutMs,
      maxRetries: cfg.maxRetries,
      latencyScale: cfg.mockLatencyScale,
    };
    // 不同真实 provider 的 endpoint / 凭据来源不同，不能混用
    provider =
      providerName === 'bamboonode'
        ? createProvider({
            ...common,
            apiKey: cfg.bamboonodeApiKey,
            baseUrl: cfg.bamboonodeBaseUrl,
          })
        : providerName === 'jev'
          ? createProvider({
              ...common,
              apiKey: cfg.jevApiKey,
              baseUrl: cfg.jevBaseUrl,
            })
          : createProvider({
              ...common,
              apiKey: cfg.apiKey,
              workspaceId: cfg.workspaceId,
              region: cfg.systemoneRegion,
              systemoneBaseUrl: cfg.systemoneBaseUrl,
            });
  } catch (error) {
    if (error instanceof ProviderConfigError) {
      throw new HttpError(400, error.message, error.code);
    }
    throw error;
  }
  providerCache.set(cacheKey, provider);
  return provider;
}

function resolveProviderName(requested) {
  const cfg = getConfig();
  const name = normalizeProviderName(
    requested === undefined || requested === null || requested === ''
      ? cfg.effectiveProvider
      : String(requested).trim(),
  );
  if (!PROVIDER_NAMES.includes(name)) {
    throw new HttpError(
      400,
      `不支持的 provider：${name}（可选 ${PROVIDER_NAMES.join(' / ')}）`,
      'UNKNOWN_PROVIDER',
    );
  }
  if (name === 'dashscope') {
    if (!cfg.apiKey) {
      throw new HttpError(
        400,
        'DASHSCOPE_API_KEY 未配置，无法使用 dashscope；请改用 mock，或在 .env 中配置真实 Key',
        'MISSING_API_KEY',
      );
    }
    if (!cfg.workspaceId && !cfg.systemoneBaseUrl) {
      throw new HttpError(
        400,
        'SYSTEMONE_WORKSPACE_ID 未配置，无法使用 dashscope；请配置业务空间 ID 或 SYSTEMONE_BASE_URL',
        'MISSING_WORKSPACE',
      );
    }
  } else if (name === 'bamboonode' && !cfg.bamboonodeApiKey) {
    throw new HttpError(
      400,
      'BAMBOONODE_API_KEY 未配置，无法使用 StartLux 决策模型；请在 .env 中配置该网关的 Key',
      'MISSING_API_KEY',
    );
  } else if (name === 'jev' && !cfg.jevApiKey) {
    throw new HttpError(
      400,
      'JEVMODEL_API_KEY 未配置，无法使用 Jev 官方网关；请在 .env 中配置该 Key',
      'MISSING_API_KEY',
    );
  }
  return name;
}

/** 根据 provider 解析模型：缺省用该 provider 默认模型，跨 provider 的模型直接 400 */
function resolveModelName(providerName, requested) {
  const cfg = getConfig();
  try {
    return resolveModelForProvider(providerName, requested, cfg);
  } catch (error) {
    if (error instanceof ProviderConfigError) {
      throw new HttpError(400, error.message, error.code);
    }
    throw error;
  }
}

function latestResultId(cfg = getConfig()) {
  const file = path.join(cfg.resultsDir, 'latest.json');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (latestResultCache.mtimeMs === stat.mtimeMs && latestResultCache.size === stat.size) {
    return latestResultCache.runId;
  }
  const result = readLatestResult(cfg.resultsDir);
  latestResultCache.mtimeMs = stat.mtimeMs;
  latestResultCache.size = stat.size;
  latestResultCache.runId = result?.runId ?? null;
  return latestResultCache.runId;
}

function pruneJobs() {
  if (benchmarkJobs.size <= MAX_JOBS_KEPT) return;
  for (const [runId, state] of benchmarkJobs) {
    if (state.status === 'done' || state.status === 'error') {
      benchmarkJobs.delete(runId);
      if (benchmarkJobs.size <= MAX_JOBS_KEPT - 10) break;
    }
  }
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

function handleHealth(req, res) {
  const cfg = getConfig();
  const dataset = getDataset({ filePath: cfg.datasetPath });
  sendJson(res, 200, {
    ok: true,
    provider: cfg.effectiveProvider,
    model: resolveModelForProvider(cfg.effectiveProvider, '', cfg),
    dataset: {
      total: dataset.samples.length,
      fallback: dataset.fallback === true,
      error: dataset.error || null,
      invalidLines: dataset.invalidLines || 0,
    },
    apiKeyConfigured: cfg.apiKeyConfigured,
    workspaceConfigured: cfg.workspaceConfigured,
    bamboonodeKeyConfigured: cfg.bamboonodeApiKeyConfigured,
    jevKeyConfigured: cfg.jevApiKeyConfigured,
    hasResults: hasLatestResult(cfg.resultsDir),
    uptimeMs: Math.round(process.uptime() * 1000),
  });
}

function handleConfig(req, res) {
  const cfg = getConfig();
  const dataset = getDataset({ filePath: cfg.datasetPath });
  sendJson(res, 200, {
    providers: [...PROVIDER_NAMES],
    models: cfg.models,
    // 级联筛选：前端切换 provider 时只展示 providerModels[provider] 里的模型
    providerModels: providerModels(cfg),
    defaultProvider: cfg.effectiveProvider,
    defaultModel: resolveModelForProvider(cfg.effectiveProvider, '', cfg),
    taxonomy: taxonomyConfig(),
    concurrencyOptions: cfg.concurrencyOptions,
    latestResultId: latestResultId(cfg),
    datasetTotal: dataset.samples.length,
    datasetFallback: dataset.fallback === true,
    limits: {
      maxLimit: dataset.samples.length,
      maxConcurrency: MAX_CONCURRENCY,
      maxTextLength: MAX_TEXT_LENGTH,
    },
  });
}

function handleDataset(req, res, url) {
  const cfg = getConfig();
  const dataset = getDataset({ filePath: cfg.datasetPath });
  const params = url.searchParams;

  const filter = (params.get('filter') || 'all').trim();
  const allowedFilters = ['all', 'violation', 'safe', 'error'];
  if (!allowedFilters.includes(filter)) {
    throw new HttpError(
      400,
      `filter 必须是 ${allowedFilters.join(' / ')} 之一`,
      'INVALID_FILTER',
    );
  }
  const offset = parseIntegerParam(params.get('offset'), 0, 0, 10_000_000);
  const limit = parseIntegerParam(params.get('limit'), 50, 1, 500);
  const category = (params.get('category') || '').trim();
  const keyword = (params.get('q') || '').trim();

  let errorIds = null;
  if (filter === 'error') {
    const latest = readLatestResult(cfg.resultsDir);
    errorIds = new Set(
      (latest?.records || [])
        .filter((record) => record.parseError || record.error)
        .map((record) => record.id),
    );
  }

  const filtered = filterSamples(dataset.samples, {
    filter,
    category,
    q: keyword,
    errorIds,
  });

  sendJson(res, 200, {
    total: filtered.length,
    items: filtered.slice(offset, offset + limit),
    offset,
    limit,
    filter,
    datasetTotal: dataset.samples.length,
    fallback: dataset.fallback === true,
    error: dataset.error || null,
    invalidLines: dataset.invalidLines || 0,
  });
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function handleResultsList(req, res, url) {
  const cfg = getConfig();
  let runs = [];
  try {
    runs = listResults(cfg.resultsDir, { limit: 0 });
  } catch (error) {
    throw new HttpError(500, `读取跑分记录失败：${error.message}`, 'RESULT_LIST_ERROR');
  }
  const pageSize = clampInt(url.searchParams.get('pageSize'), 10, 1, 50);
  const total = runs.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(clampInt(url.searchParams.get('page'), 1, 1, Number.MAX_SAFE_INTEGER), totalPages);
  const start = (page - 1) * pageSize;
  sendJson(res, 200, {
    total,
    page,
    pageSize,
    totalPages,
    latestResultId: latestResultId(cfg),
    runs: runs.slice(start, start + pageSize),
  });
}

function handleDeleteResult(req, res, runId) {
  const cfg = getConfig();
  try {
    const info = deleteResult(runId, cfg.resultsDir);
    if (!info.deleted) throw new HttpError(404, `结果不存在：${runId}`, 'RESULT_NOT_FOUND');
    latestResultCache.mtimeMs = -1;
    latestResultCache.size = -1;
    latestResultCache.runId = null;
    sendJson(res, 200, { ok: true, runId, latestResultId: info.latestResultId ?? null });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (String(error?.message || '').startsWith('非法的 runId')) {
      throw new HttpError(400, error.message, 'INVALID_RUN_ID');
    }
    throw new HttpError(500, `删除结果失败：${error.message}`, 'RESULT_DELETE_ERROR');
  }
}

function handleResultsLatest(req, res) {
  const cfg = getConfig();
  const result = readLatestResult(cfg.resultsDir);
  sendJson(res, 200, result ?? null);
}

function handleResultById(req, res, runId) {
  const cfg = getConfig();
  let result;
  try {
    result = readResult(runId, cfg.resultsDir);
  } catch (error) {
    throw new HttpError(500, `读取结果失败：${error.message}`, 'RESULT_READ_ERROR');
  }
  if (!result) throw new HttpError(404, `结果不存在：${runId}`, 'RESULT_NOT_FOUND');
  sendJson(res, 200, result);
}

function handleExportCsv(req, res, runId) {
  const cfg = getConfig();
  const result = readResult(runId, cfg.resultsDir);
  if (!result) throw new HttpError(404, `结果不存在：${runId}`, 'RESULT_NOT_FOUND');
  const csv = `\ufeff${resultToCsv(result)}`;
  const body = Buffer.from(csv, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Length': body.length,
    'Content-Disposition': `attachment; filename="${runId}.csv"`,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function handleStartBenchmark(req, res) {
  return (async () => {
    const cfg = getConfig();
    const body = await readJsonBody(req);
    const dataset = getDataset({ filePath: cfg.datasetPath });

    if (!dataset.samples.length) {
      throw new HttpError(400, '数据集为空，无法跑分', 'EMPTY_DATASET');
    }

    const providerName = resolveProviderName(body.provider);

    let requestedLimit = dataset.samples.length;
    if (body.limit !== undefined && body.limit !== null && body.limit !== '') {
      const n = Number(body.limit);
      if (!Number.isFinite(n) || n < 1) {
        throw new HttpError(400, 'limit 必须是正整数（省略表示全部样本）', 'INVALID_LIMIT');
      }
      requestedLimit = Math.floor(n);
    }
    const total = Math.min(requestedLimit, dataset.samples.length);

    let concurrency = DEFAULT_CONCURRENCY;
    if (body.concurrency !== undefined && body.concurrency !== null && body.concurrency !== '') {
      const n = Number(body.concurrency);
      if (!Number.isFinite(n) || n < 1 || n > MAX_CONCURRENCY) {
        throw new HttpError(
          400,
          `concurrency 必须是 1-${MAX_CONCURRENCY} 的整数`,
          'INVALID_CONCURRENCY',
        );
      }
      concurrency = Math.floor(n);
    }

    const model = resolveModelName(providerName, body.model);

    const jobRunId = nextRunId(
      cfg.resultsDir,
      new Set([...benchmarkJobs.keys()]),
    );
    const startedAt = new Date().toISOString();
    const state = {
      runId: jobRunId,
      status: 'queued',
      done: 0,
      total,
      resultId: null,
      error: null,
      startedAt,
      finishedAt: null,
      provider: providerName,
      model,
      simulated: providerName === 'mock',
      config: { concurrency, limit: total, datasetTotal: dataset.samples.length },
    };
    benchmarkJobs.set(jobRunId, state);

    setImmediate(async () => {
      state.status = 'running';
      try {
        const provider = getProviderFor(providerName, model);
        const result = await runBenchmark({
          samples: dataset.samples,
          provider,
          model,
          limit: total,
          concurrency,
          runId: jobRunId,
          resultsDir: cfg.resultsDir,
          datasetFallback: dataset.fallback === true,
          onProgress: ({ done }) => {
            state.done = done;
          },
        });
        state.status = 'done';
        state.done = total;
        state.resultId = result.runId;
        state.finishedAt = result.finishedAt;
        state.metrics = {
          accuracy: result.metrics?.binary?.accuracy,
          f1: result.metrics?.binary?.f1,
          parseFail: result.metrics?.binary?.parseFail,
        };
      } catch (error) {
        state.status = 'error';
        state.error = error?.message || String(error);
        state.finishedAt = new Date().toISOString();
        // eslint-disable-next-line no-console
        console.error(`[benchmark] ${jobRunId} 失败:`, error?.stack || error);
      } finally {
        pruneJobs();
      }
    });

    sendJson(res, 202, {
      runId: jobRunId,
      status: 'queued',
      total,
      provider: providerName,
      model,
      simulated: providerName === 'mock',
    });
  })();
}

function benchmarkStatusPayload(state) {
  const now = Date.now();
  const startMs = Date.parse(state.startedAt);
  const endMs = state.finishedAt ? Date.parse(state.finishedAt) : now;
  return {
    runId: state.runId,
    status: state.status,
    done: state.done,
    total: state.total,
    resultId: state.resultId,
    error: state.error,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    elapsedMs:
      Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0,
    provider: state.provider,
    model: state.model,
    simulated: state.simulated === true,
    config: state.config,
    metrics: state.metrics || undefined,
  };
}

function handleBenchmarkStatus(req, res, runId) {
  const state = benchmarkJobs.get(runId);
  if (state) {
    sendJson(res, 200, benchmarkStatusPayload(state));
    return;
  }
  // 服务重启后仍可从结果文件恢复状态
  const cfg = getConfig();
  const result = readResult(runId, cfg.resultsDir);
  if (!result) throw new HttpError(404, `跑分任务不存在：${runId}`, 'JOB_NOT_FOUND');
  const startMs = Date.parse(result.startedAt);
  const endMs = Date.parse(result.finishedAt);
  sendJson(res, 200, {
    runId,
    status: 'done',
    done: result.records?.length ?? 0,
    total: result.config?.limit ?? result.records?.length ?? 0,
    resultId: runId,
    error: null,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    elapsedMs:
      Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0,
    provider: result.provider,
    model: result.model,
    simulated: result.simulated === true,
    config: result.config,
    metrics: result.metrics
      ? {
          accuracy: result.metrics.binary?.accuracy,
          f1: result.metrics.binary?.f1,
          parseFail: result.metrics.binary?.parseFail,
        }
      : undefined,
  });
}

function handleModerate(req, res) {
  return (async () => {
    const body = await readJsonBody(req);
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) {
      throw new HttpError(400, '缺少 text 字段或文本为空', 'EMPTY_TEXT');
    }
    if (text.length > MAX_TEXT_LENGTH) {
      throw new HttpError(
        400,
        `文本过长（最多 ${MAX_TEXT_LENGTH} 字符）`,
        'TEXT_TOO_LONG',
      );
    }

    const cfg = getConfig();
    const providerName = resolveProviderName(body.provider);
    const model = resolveModelName(providerName, body.model);
    const provider = getProviderFor(providerName, model);

    const response = await provider.judge(text, {});
    if (!response.verdict && response.error) {
      sendJson(res, 502, {
        error: response.error,
        code: 'UPSTREAM_ERROR',
        provider: providerName,
        model: provider.model,
        parseError: response.parseError === true,
        raw: response.raw ?? '',
        latencyMs: response.latencyMs ?? 0,
      });
      return;
    }

    sendJson(res, 200, {
      verdict: response.verdict,
      latencyMs: response.latencyMs ?? 0,
      provider: providerName,
      model: provider.model,
      parseError: response.parseError === true,
      raw: response.raw ?? '',
      tokens: response.tokens ?? null,
      simulated: providerName === 'mock' || response.simulated === true,
    });
  })();
}

async function handleApi(req, res, url) {
  const method = req.method || 'GET';
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/api/health') return handleHealth(req, res);
  if (method === 'GET' && pathname === '/api/config') return handleConfig(req, res);
  if (method === 'GET' && pathname === '/api/dataset') return handleDataset(req, res, url);
  if (method === 'GET' && pathname === '/api/results') {
    return handleResultsList(req, res, url);
  }
  if (method === 'GET' && pathname === '/api/results/latest') {
    return handleResultsLatest(req, res);
  }
  if (method === 'DELETE' && pathname.startsWith('/api/results/')) {
    let match = pathname.match(/^\/api\/results\/([^/]+)$/);
    if (match) return handleDeleteResult(req, res, safeDecode(match[1]));
  }
  if (method === 'POST' && pathname === '/api/benchmark') {
    return handleStartBenchmark(req, res);
  }
  if (method === 'POST' && pathname === '/api/moderate') return handleModerate(req, res);

  let match = pathname.match(/^\/api\/results\/([^/]+)\/export\.csv$/);
  if (method === 'GET' && match) {
    return handleExportCsv(req, res, safeDecode(match[1]));
  }
  match = pathname.match(/^\/api\/results\/([^/]+)$/);
  if (method === 'GET' && match) {
    return handleResultById(req, res, safeDecode(match[1]));
  }
  match = pathname.match(/^\/api\/benchmark\/([^/]+)$/);
  if (method === 'GET' && match) {
    return handleBenchmarkStatus(req, res, safeDecode(match[1]));
  }

  throw new HttpError(404, `接口不存在：${method} ${pathname}`, 'NOT_FOUND');
}

// ---------------------------------------------------------------------------
// 静态资源
// ---------------------------------------------------------------------------

const INDEX_PLACEHOLDER = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>前端尚未就绪</title>
<style>body{font-family:system-ui,-apple-system,"PingFang SC",sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}main{max-width:640px;padding:32px;border:1px solid #334155;border-radius:16px;background:#111c33}h1{font-size:20px;margin-top:0}code{background:#1e293b;padding:2px 6px;border-radius:6px}a{color:#38bdf8}p{line-height:1.7}</style>
</head><body><main>
<h1>前端页面尚未就绪</h1>
<p><code>public/index.html</code> 还不存在（前端由 frontend-dev 并行生成）。</p>
<p>后端 API 已可用：<a href="/api/health">/api/health</a> · <a href="/api/config">/api/config</a> · <a href="/api/dataset">/api/dataset</a></p>
<p>页面将在 3 秒后自动重试…</p>
</main><script>setTimeout(() => location.reload(), 3000)</script></body></html>`;

async function serveStatic(req, res, url) {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    throw new HttpError(405, `静态资源不支持 ${method}`, 'METHOD_NOT_ALLOWED');
  }

  let pathname = safeDecode(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  if (pathname.includes('\0')) throw new HttpError(400, '非法路径', 'INVALID_PATH');

  const cfg = getConfig();
  const publicDir = cfg.publicDir;
  const filePath = path.resolve(publicDir, `.${pathname}`);
  const relative = path.relative(publicDir, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new HttpError(403, '禁止访问该路径', 'FORBIDDEN');
  }

  let stat = null;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    stat = null;
  }

  let finalPath = filePath;
  let finalStat = stat;
  if (finalStat?.isDirectory()) {
    finalPath = path.join(finalPath, 'index.html');
    try {
      finalStat = await fsp.stat(finalPath);
    } catch {
      finalStat = null;
    }
  }

  if (!finalStat?.isFile()) {
    if (pathname === '/index.html') {
      const body = Buffer.from(INDEX_PLACEHOLDER, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      res.end(method === 'HEAD' ? undefined : body);
      return;
    }
    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    throw new HttpError(404, `静态文件不存在：${pathname}`, 'NOT_FOUND');
  }

  const data = await fsp.readFile(finalPath);
  const ext = path.extname(finalPath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
  });
  res.end(method === 'HEAD' ? undefined : data);
}

// ---------------------------------------------------------------------------
// 请求入口
// ---------------------------------------------------------------------------

function handleError(res, error) {
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
    return;
  }
  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  if (error?.name === 'AbortError') {
    sendJson(res, 499, { error: '请求已取消', code: 'ABORTED' });
    return;
  }
  // eslint-disable-next-line no-console
  console.error('[server] 未处理异常:', error?.stack || error);
  sendJson(res, 500, { error: '服务器内部错误', code: 'INTERNAL_ERROR' });
}

async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url || '/', 'http://127.0.0.1');
  } catch {
    throw new HttpError(400, '非法请求 URL', 'INVALID_URL');
  }
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    await handleApi(req, res, url);
    return;
  }
  await serveStatic(req, res, url);
}

/**
 * 启动 HTTP 服务。
 * @param {{port?: number, host?: string}} options port=0 时由系统分配
 */
export async function startServer(options = {}) {
  loadEnv();
  const cfg = getConfig();
  const port = options.port === undefined ? cfg.port : options.port;
  const host = options.host || cfg.host;

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => handleError(res, error));
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${host}:${actualPort}`;
  return { server, url, port: actualPort, host, config: cfg };
}

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(path.resolve(entry)).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  startServer()
    .then(({ server, url, config }) => {
      const dataset = getDataset({ filePath: config.datasetPath });
      // eslint-disable-next-line no-console
      console.log(`[server] 监听 ${url}`);
      // eslint-disable-next-line no-console
      console.log(
        `[server] 默认 provider=${config.effectiveProvider} model=${config.model} | DASHSCOPE_API_KEY ${
          config.apiKeyConfigured ? '已配置' : '未配置（自动回退 mock）'
        }`,
      );
      // eslint-disable-next-line no-console
      console.log(
        `[server] 数据集 ${dataset.samples.length} 条${
          dataset.fallback ? `（内置兜底样本：${dataset.error}）` : `（${dataset.path}）`
        }`,
      );

      const shutdown = (signal) => {
        // eslint-disable-next-line no-console
        console.log(`\n[server] 收到 ${signal}，正在关闭…`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1500).unref();
      };
      process.once('SIGINT', () => shutdown('SIGINT'));
      process.once('SIGTERM', () => shutdown('SIGTERM'));
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error('[server] 启动失败:', error?.message || error);
      process.exitCode = 1;
    });
}

export const __testing = {
  benchmarkJobs,
  HttpError,
};
