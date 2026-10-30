// 跑分引擎 + 指标计算 + 结果持久化（零依赖）。
// 结果结构见 docs/CONTRACT.md 第 6 节；records 保留原文 text（前端样本浏览器需要）。
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './lib/env.mjs';
import { abortError } from './lib/limiter.mjs';
import { VIOLATION_CODES, isCorrect, isCategoryHit } from './moderation.mjs';

export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 16;
const RUN_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** 图片扩展名 -> MIME；clef-omni 支持 png/jpeg/webp */
const IMAGE_MIME = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
});

/** 读取图像样本为 clef-omni images[] 所需的 {content_type, base64}（按文件名缓存） */
function loadImagePayload(imagesDir, name, cache) {
  if (cache.has(name)) return cache.get(name);
  const safeName = path.basename(String(name));
  const ext = path.extname(safeName).toLowerCase();
  const content_type = IMAGE_MIME[ext];
  if (!content_type) throw new Error(`不支持的图片扩展名：${safeName}`);
  const filePath = path.join(imagesDir, safeName);
  const base64 = fs.readFileSync(filePath).toString('base64');
  const payload = { content_type, base64 };
  cache.set(name, payload);
  return payload;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 线性插值分位数（sorted 升序） */
export function quantile(sortedValues, q) {
  const list = sortedValues;
  if (!Array.isArray(list) || list.length === 0) return 0;
  const pos = Math.min(1, Math.max(0, q)) * (list.length - 1);
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return list[lower];
  const weight = pos - lower;
  return list[lower] * (1 - weight) + list[upper] * weight;
}

function safeRate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function prf(tp, fp, fn) {
  const precision = safeRate(tp, tp + fp);
  const recall = safeRate(tp, tp + fn);
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
}

/**
 * 计算契约第 6 节 metrics。
 * 口径：valid = 有合法 prediction 且无 error 的记录；accuracy/P/R/F1 只在 valid 上算。
 * parseFail = parseError=true；errors = 上游/网络错误的记录。
 */
export function computeMetrics(records, meta = {}) {
  const list = Array.isArray(records) ? records : [];
  const total = list.length;

  let valid = 0;
  let parseFail = 0;
  let errorCount = 0;
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;

  const latencies = [];
  const tokenTotals = { prompt: 0, completion: 0, total: 0, count: 0 };
  const categoryStats = new Map(
    VIOLATION_CODES.map((code) => [
      code,
      { tp: 0, fp: 0, fn: 0, support: 0, predicted: 0 },
    ]),
  );
  const sourceStats = new Map();

  for (const record of list) {
    const gold = record?.gold || {};
    const goldViolation = gold.violation === true;
    const goldCategories = Array.isArray(gold.categories) ? gold.categories : [];

    const source = record?.source || 'unknown';
    if (!sourceStats.has(source)) {
      sourceStats.set(source, {
        total: 0,
        valid: 0,
        parseFail: 0,
        errors: 0,
        tp: 0,
        tn: 0,
        fp: 0,
        fn: 0,
      });
    }
    const sourceStat = sourceStats.get(source);
    sourceStat.total += 1;

    // support 统计所有样本的 gold（不受预测有效性影响）
    for (const code of new Set(goldCategories)) {
      const stat = categoryStats.get(code);
      if (stat) stat.support += 1;
    }

    const prediction = record?.prediction;
    const predValid =
      prediction &&
      (prediction.violation === 0 || prediction.violation === 1) &&
      !record?.error;

    if (!predValid) {
      // parseError 优先：解析失败记录也可能带 error 说明文字
      if (record?.parseError) {
        parseFail += 1;
        sourceStat.parseFail += 1;
      } else if (record?.error) {
        errorCount += 1;
        sourceStat.errors += 1;
      } else {
        parseFail += 1;
        sourceStat.parseFail += 1;
      }
      continue;
    }

    valid += 1;
    sourceStat.valid += 1;

    if (Number.isFinite(record.latencyMs)) latencies.push(record.latencyMs);
    if (record.tokens && Number.isFinite(record.tokens.total)) {
      tokenTotals.prompt += Number(record.tokens.prompt) || 0;
      tokenTotals.completion += Number(record.tokens.completion) || 0;
      tokenTotals.total += Number(record.tokens.total) || 0;
      tokenTotals.count += 1;
    }

    const predViolation = prediction.violation === 1;

    if (goldViolation && predViolation) {
      tp += 1;
      sourceStat.tp += 1;
    } else if (!goldViolation && !predViolation) {
      tn += 1;
      sourceStat.tn += 1;
    } else if (!goldViolation && predViolation) {
      fp += 1;
      sourceStat.fp += 1;
    } else {
      fn += 1;
      sourceStat.fn += 1;
    }

    const predCategories = new Set(
      Array.isArray(prediction.categories) ? prediction.categories : [],
    );
    for (const [code, stat] of categoryStats) {
      const goldHas = goldViolation && goldCategories.includes(code);
      const predHas = predViolation && predCategories.has(code);
      if (goldHas && predHas) stat.tp += 1;
      else if (goldHas) stat.fn += 1;
      else if (predHas) stat.fp += 1;
      if (predHas) stat.predicted += 1;
    }
  }

  const binaryRates = prf(tp, fp, fn);
  const binary = {
    total,
    valid,
    parseFail,
    errors: errorCount,
    accuracy: round(safeRate(tp + tn, valid)),
    precision: round(binaryRates.precision),
    recall: round(binaryRates.recall),
    f1: round(binaryRates.f1),
    tp,
    tn,
    fp,
    fn,
    parseSuccessRate: round(safeRate(total - parseFail, total)),
  };

  const perCategory = {};
  let macroSum = 0;
  let macroCount = 0;
  let microTp = 0;
  let microFp = 0;
  let microFn = 0;

  for (const code of VIOLATION_CODES) {
    const stat = categoryStats.get(code);
    const rates = prf(stat.tp, stat.fp, stat.fn);
    perCategory[code] = {
      precision: round(rates.precision),
      recall: round(rates.recall),
      f1: round(rates.f1),
      support: stat.support,
      predicted: stat.predicted,
      tp: stat.tp,
      fp: stat.fp,
      fn: stat.fn,
    };
    if (stat.support > 0 || stat.predicted > 0) {
      macroSum += rates.f1;
      macroCount += 1;
    }
    microTp += stat.tp;
    microFp += stat.fp;
    microFn += stat.fn;
  }

  const micro = prf(microTp, microFp, microFn);

  latencies.sort((a, b) => a - b);
  const latencyCount = latencies.length;
  const latencySum = latencies.reduce((acc, value) => acc + value, 0);
  const startedMs = meta.startedAt ? Date.parse(meta.startedAt) : NaN;
  const finishedMs = meta.finishedAt ? Date.parse(meta.finishedAt) : NaN;
  const wallMs =
    Number.isFinite(startedMs) && Number.isFinite(finishedMs) && finishedMs >= startedMs
      ? finishedMs - startedMs
      : latencySum;

  const latency = {
    count: latencyCount,
    mean: round(latencyCount ? latencySum / latencyCount : 0, 1),
    p50: round(quantile(latencies, 0.5), 1),
    p90: round(quantile(latencies, 0.9), 1),
    p95: round(quantile(latencies, 0.95), 1),
    p99: round(quantile(latencies, 0.99), 1),
    min: latencyCount ? latencies[0] : 0,
    max: latencyCount ? latencies[latencyCount - 1] : 0,
    totalWallMs: Math.round(wallMs),
    throughputRps: round(wallMs > 0 ? total / (wallMs / 1000) : 0, 2),
  };

  const tokens = {
    prompt: tokenTotals.prompt,
    completion: tokenTotals.completion,
    total: tokenTotals.total,
    avgTotal: round(tokenTotals.count ? tokenTotals.total / tokenTotals.count : 0, 1),
  };

  const bySource = {};
  for (const [source, stat] of sourceStats) {
    const rates = prf(stat.tp, stat.fp, stat.fn);
    bySource[source] = {
      total: stat.total,
      valid: stat.valid,
      parseFail: stat.parseFail,
      errors: stat.errors,
      accuracy: round(safeRate(stat.tp + stat.tn, stat.valid)),
      precision: round(rates.precision),
      recall: round(rates.recall),
      f1: round(rates.f1),
    };
  }

  const worst = list
    .filter((record) => record && (record.correct === false || record.error || record.parseError))
    .sort((a, b) => (Number(b.latencyMs) || 0) - (Number(a.latencyMs) || 0))
    .slice(0, 20)
    .map((record) => ({
      id: record.id,
      text: record.text,
      source: record.source,
      gold: record.gold,
      pred: record.prediction,
      latencyMs: record.latencyMs,
      parseError: record.parseError === true,
      error: record.error || null,
    }));

  return {
    binary,
    macroCategoryF1: round(macroCount ? macroSum / macroCount : 0),
    microCategoryF1: round(micro.f1),
    perCategory,
    latency,
    tokens,
    bySource,
    confusion: { tp, tn, fp, fn },
    worst,
  };
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 生成 `bench-YYYYMMDD-HHmmss`（本地时间） */
export function makeRunId(date = new Date()) {
  return [
    'bench',
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`,
    `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`,
  ].join('-');
}

/** 避免同一秒并发撞 id；taken 可传入正在运行的 runId 集合 */
export function nextRunId(resultsDir = getConfig().resultsDir, taken = null) {
  const base = makeRunId();
  let candidate = base;
  let suffix = 1;
  for (;;) {
    const fileExists = fs.existsSync(path.join(resultsDir, `${candidate}.json`));
    const isTaken = taken && typeof taken.has === 'function' && taken.has(candidate);
    if (!fileExists && !isTaken) return candidate;
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
}

function assertSafeRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId) || runId === 'latest') {
    throw new Error(`非法的 runId：${String(runId)}`);
  }
}

function atomicWriteFile(targetPath, content) {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  );
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, targetPath);
}

/**
 * 写 results/<runId>.json 并复制到 results/latest.json。
 * 记录里只有样本原文/模型输出/指标，不含任何 API Key。
 */
export function writeResult(result, resultsDir = getConfig().resultsDir) {
  if (!result || typeof result !== 'object') throw new Error('writeResult 需要 result 对象');
  assertSafeRunId(result.runId);
  const dir = resultsDir || getConfig().resultsDir;
  fs.mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(result, null, 2);
  const filePath = path.join(dir, `${result.runId}.json`);
  const latestPath = path.join(dir, 'latest.json');
  atomicWriteFile(filePath, json);
  atomicWriteFile(latestPath, json);
  return { filePath, latestPath, bytes: Buffer.byteLength(json) };
}

export function readResult(runId, resultsDir = getConfig().resultsDir) {
  assertSafeRunId(runId);
  const dir = resultsDir || getConfig().resultsDir;
  let text;
  try {
    text = fs.readFileSync(path.join(dir, `${runId}.json`), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(text);
}

/**
 * 删除一条历史跑分。
 * - 校验 runId，避免路径穿越；
 * - 若删除的是 latest.json 指向的记录，自动把 latest 回退到剩余最新一条（没有则删除 latest.json）。
 * @returns {{deleted:boolean, latestResultId:string|null, latestUpdated:boolean}}
 */
export function deleteResult(runId, resultsDir = getConfig().resultsDir) {
  assertSafeRunId(runId);
  const dir = resultsDir || getConfig().resultsDir;
  const filePath = path.join(dir, `${runId}.json`);
  const latestPath = path.join(dir, 'latest.json');

  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const latest = readLatestResult(dir);
      return { deleted: false, latestResultId: latest?.runId ?? null, latestUpdated: false };
    }
    throw error;
  }

  let latestResultId = readLatestResult(dir)?.runId ?? null;
  let latestUpdated = false;
  if (latestResultId === runId) {
    const remaining = listResults(dir, { limit: 0 });
    let next = null;
    for (const run of remaining) {
      try {
        next = readResult(run.runId, dir);
        break;
      } catch {
        // 损坏文件跳过，继续找下一条可读结果
      }
    }
    if (next) {
      atomicWriteFile(latestPath, JSON.stringify(next, null, 2));
      latestResultId = next.runId;
    } else {
      try {
        fs.unlinkSync(latestPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      latestResultId = null;
    }
    latestUpdated = true;
  }

  return { deleted: true, latestResultId, latestUpdated };
}

/**
 * 列出历史跑分（只返回摘要，不加载 records），按结束时间倒序。
 * 用于前端「跑分记录 / 多模型对比」；损坏/非跑分 JSON 会跳过。
 */
export function listResults(resultsDir = getConfig().resultsDir, { limit = 100 } = {}) {
  const dir = resultsDir || getConfig().resultsDir;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const runs = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name === 'latest.json' || name.startsWith('.')) continue;
    const fileRunId = name.slice(0, -5);
    if (!RUN_ID_RE.test(fileRunId)) continue;
    let result;
    try {
      result = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue; // 半写入/损坏文件：跳过，不影响其它记录
    }
    if (!result || typeof result !== 'object') continue;
    const m = result.metrics || {};
    const b = m.binary || {};
    const lat = m.latency || {};
    const tok = m.tokens || {};
    runs.push({
      runId: result.runId || fileRunId,
      provider: result.provider || '—',
      model: result.model || '—',
      simulated: result.simulated === true,
      startedAt: result.startedAt || null,
      finishedAt: result.finishedAt || null,
      sampleCount: Array.isArray(result.records) ? result.records.length : 0,
      datasetTotal: result.config?.datasetTotal ?? null,
      limit: result.config?.limit ?? null,
      concurrency: result.config?.concurrency ?? null,
      datasetFallback: result.datasetFallback === true,
      accuracy: b.accuracy ?? 0,
      precision: b.precision ?? 0,
      recall: b.recall ?? 0,
      f1: b.f1 ?? 0,
      macroF1: m.macroCategoryF1 ?? 0,
      microF1: m.microCategoryF1 ?? 0,
      tp: b.tp ?? 0,
      tn: b.tn ?? 0,
      fp: b.fp ?? 0,
      fn: b.fn ?? 0,
      parseFail: b.parseFail ?? 0,
      errors: b.errors ?? 0,
      p50: lat.p50 ?? 0,
      p90: lat.p90 ?? 0,
      p95: lat.p95 ?? 0,
      p99: lat.p99 ?? 0,
      mean: lat.mean ?? 0,
      max: lat.max ?? 0,
      throughputRps: lat.throughputRps ?? 0,
      totalWallMs: lat.totalWallMs ?? 0,
      tokensTotal: tok.total ?? 0,
      tokensAvg: tok.avgTotal ?? 0,
      perCategory: m.perCategory && typeof m.perCategory === 'object' ? m.perCategory : {},
    });
  }
  runs.sort((a, b) => String(b.finishedAt || b.startedAt || '').localeCompare(String(a.finishedAt || a.startedAt || '')));
  return Number.isInteger(limit) && limit > 0 ? runs.slice(0, limit) : runs;
}

export function readLatestResult(resultsDir = getConfig().resultsDir) {
  const dir = resultsDir || getConfig().resultsDir;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
}

export function hasLatestResult(resultsDir = getConfig().resultsDir) {
  const dir = resultsDir || getConfig().resultsDir;
  return fs.existsSync(path.join(dir, 'latest.json'));
}

/** 返回已有 resultId 列表（新 -> 旧） */
export function listResultIds(resultsDir = getConfig().resultsDir) {
  const dir = resultsDir || getConfig().resultsDir;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith('.json') && name !== 'latest.json')
    .map((name) => name.slice(0, -5))
    .filter((id) => RUN_ID_RE.test(id))
    .sort()
    .reverse();
}

function buildRecord(sample, response) {
  const prediction =
    response?.verdict && typeof response.verdict === 'object' ? response.verdict : null;
  const gold = {
    violation: sample.gold.violation,
    categories: [...sample.gold.categories],
  };
  const record = {
    id: sample.id,
    text: sample.text,
    source: sample.source,
    sensitive: sample.sensitive === true,
    gold,
    prediction,
    correct: prediction ? isCorrect(gold, prediction) : false,
    categoryHit: prediction ? isCategoryHit(gold, prediction) : false,
    latencyMs: Math.max(0, Math.round(Number(response?.latencyMs) || 0)),
    tokens: response?.tokens ?? null,
    parseError: response?.parseError === true,
    error: response?.error ?? null,
    raw: typeof response?.raw === 'string' ? response.raw : '',
  };
  if (sample.source_detail !== undefined) record.source_detail = sample.source_detail;
  if (sample.image) record.image = sample.image;
  return record;
}

/**
 * 并发跑分。
 * @param {{
 *   samples: Array<object>,
 *   provider: {name: string, model: string, simulated?: boolean, judge: Function},
 *   limit?: number,
 *   concurrency?: number,
 *   runId?: string,
 *   resultsDir?: string,
 *   imagesDir?: string,
 *   onProgress?: (progress: {done: number, total: number, record: object}) => void,
 *   signal?: AbortSignal,
 *   datasetFallback?: boolean,
 * }} options
 */
export async function runBenchmark(options = {}) {
  const {
    samples,
    provider,
    limit,
    concurrency = DEFAULT_CONCURRENCY,
    runId,
    onProgress,
    signal,
  } = options;

  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error('没有可跑分的样本（数据集为空）');
  }
  if (!provider || typeof provider.judge !== 'function') {
    throw new Error('runBenchmark 需要合法的 provider.judge');
  }

  const cfg = getConfig();
  const resultsDir = options.resultsDir || cfg.resultsDir;
  const imagesDir = options.imagesDir || cfg.imagesDir;
  const datasetTotal = samples.length;
  const requestedLimit =
    limit === undefined || limit === null ? datasetTotal : Math.floor(Number(limit));
  if (!Number.isFinite(requestedLimit) || requestedLimit < 1) {
    throw new Error('limit 必须是正整数');
  }
  const total = Math.min(requestedLimit, datasetTotal);
  const selected = samples.slice(0, total);
  const imageCount = selected.filter((sample) => sample && sample.image).length;
  // 图像样本需要 provider 支持多模态输入；文本 provider 混跑会产生误导性结果，直接拒绝
  if (imageCount > 0 && provider.supportsImages !== true) {
    throw new Error(
      `选中样本含 ${imageCount} 条图像样本，但 provider ${provider.name || ''} 不支持图片输入；请使用 cloudflare（clef-omni）`,
    );
  }
  const poolSize = Math.min(
    MAX_CONCURRENCY,
    Math.max(1, Math.floor(Number(concurrency) || DEFAULT_CONCURRENCY)),
  );
  const finalRunId =
    runId ||
    nextRunId(resultsDir, options.takenRunIds || null);

  const startedAt = new Date().toISOString();
  const records = new Array(total);
  const imageCache = new Map();
  let done = 0;
  let cursor = 0;

  async function worker() {
    for (;;) {
      if (signal?.aborted) throw abortError(signal.reason);
      const index = cursor;
      cursor += 1;
      if (index >= total) return;

      const sample = selected[index];
      let response;
      let images;
      try {
        images = sample.image ? [loadImagePayload(imagesDir, sample.image, imageCache)] : undefined;
        response = await provider.judge(sample.text, { sample, signal, images });
      } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) throw abortError(signal?.reason);
        const imageFailed = Boolean(sample.image && !images);
        response = {
          verdict: null,
          parseError: false,
          error: imageFailed
            ? `图片读取失败：${error?.message || error}`
            : `调用异常：${error?.message || error}`,
          raw: '',
          latencyMs: 0,
          tokens: null,
        };
      }

      records[index] = buildRecord(sample, response);
      done += 1;
      if (typeof onProgress === 'function') {
        try {
          onProgress({ done, total, record: records[index] });
        } catch {
          // 进度回调异常不应中断跑分
        }
      }
    }
  }

  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  const finishedAt = new Date().toISOString();
  const metrics = computeMetrics(records, {
    startedAt,
    finishedAt,
    provider: provider.name,
    model: provider.model,
  });

  const result = {
    runId: finalRunId,
    startedAt,
    finishedAt,
    provider: provider.name,
    model: provider.model,
    simulated: provider.simulated === true,
    config: {
      concurrency: poolSize,
      limit: total,
      datasetTotal,
      modality: imageCount > 0 ? 'image' : 'text',
      imageCount,
    },
    datasetFallback: options.datasetFallback === true,
    records,
    metrics,
  };

  writeResult(result, resultsDir);
  return result;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 导出 CSV（不含 BOM；BOM 由 HTTP 层按需加） */
export function resultToCsv(result) {
  const header = [
    'id',
    'source',
    'sensitive',
    'gold_violation',
    'gold_categories',
    'pred_violation',
    'pred_categories',
    'severity',
    'confidence',
    'correct',
    'categoryHit',
    'latencyMs',
    'tokens_total',
    'parseError',
    'error',
    'reason',
    'text',
    'image',
  ];
  const lines = [header.join(',')];
  for (const record of result?.records || []) {
    const row = [
      record.id,
      record.source,
      record.sensitive,
      record.gold?.violation,
      (record.gold?.categories || []).join(';'),
      record.prediction?.violation,
      (record.prediction?.categories || []).join(';'),
      record.prediction?.severity,
      record.prediction?.confidence,
      record.correct,
      record.categoryHit,
      record.latencyMs,
      record.tokens?.total,
      record.parseError,
      record.error,
      record.prediction?.reason,
      record.text,
      record.image,
    ];
    lines.push(row.map(csvCell).join(','));
  }
  return lines.join('\r\n');
}
