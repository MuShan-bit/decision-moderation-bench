// 数据集加载（data/eval/samples.jsonl）+ 内置兜底样本。
// 关键点：数据工程师可能还没产出 samples.jsonl —— 服务必须照常启动，
// 此时用 10 条内置样本兜底，并在 API 响应里明确标注 fallback。
import fs from 'node:fs';
import { getConfig } from './lib/env.mjs';
import { BINARY_UNSAFE_CODE, TAXONOMY_CODES, isBinaryLabelMode } from './moderation.mjs';

/** 图片样本文件名白名单：只允许 basename（png/jpg/jpeg/webp），防止目录穿越 */
const IMAGE_NAME_RE = /^[A-Za-z0-9._-]+\.(png|jpe?g|webp)$/i;
const MAX_IMAGE_NAME_LENGTH = 128;

function normalizeImageName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (!name || name.length > MAX_IMAGE_NAME_LENGTH) return null;
  if (!IMAGE_NAME_RE.test(name)) return null;
  return name;
}

/**
 * 内置兜底样本：仅用于数据集尚未生成时的 demo/自测，
 * 通过 source="builtin" 与数据集的 cold/toxincn/... 明确区分。
 */
export const BUILTIN_SAMPLES = Object.freeze([
  {
    id: 'builtin-0001',
    text: '据当地媒体报道，警方通报了这起案件，目前正在进一步调查中。',
    source: 'builtin',
    source_detail: '内置兜底 / safe / 新闻转述',
    origin: 'human',
    sensitive: false,
    gold: { violation: false, categories: ['safe'] },
  },
  {
    id: 'builtin-0002',
    text: '你这个蠢货，连这么简单的事都做不好，真是个废物。',
    source: 'builtin',
    source_detail: '内置兜底 / insult',
    origin: 'human',
    sensitive: false,
    gold: { violation: true, categories: ['insult'] },
  },
  {
    id: 'builtin-0003',
    text: '那个地方来的人都是骗子和小偷，最好离他们远一点。',
    source: 'builtin',
    source_detail: '内置兜底 / hate',
    origin: 'human',
    sensitive: false,
    gold: { violation: true, categories: ['hate'] },
  },
  {
    id: 'builtin-0004',
    text: '加微信 abc12345 领取内部优惠券，日赚三百，名额有限先到先得！',
    source: 'builtin',
    source_detail: '内置兜底 / spam',
    origin: 'human',
    sensitive: false,
    gold: { violation: true, categories: ['spam'] },
  },
  {
    id: 'builtin-0005',
    text: '出售各类仿真枪和管制刀具，需要的私聊，货到付款。',
    source: 'builtin',
    source_detail: '内置兜底 / illegal',
    origin: 'human',
    sensitive: false,
    gold: { violation: true, categories: ['illegal'] },
  },
  {
    id: 'builtin-0006',
    text: '我知道你家在哪，再敢多嘴我就让你见不到明天的太阳。',
    source: 'builtin',
    source_detail: '内置兜底 / violence',
    origin: 'human',
    sensitive: false,
    gold: { violation: true, categories: ['violence'] },
  },
  {
    id: 'builtin-0007',
    text: '把他的身份证号、手机号和家庭住址都发出来，让大家都认识认识这个人。',
    source: 'builtin',
    source_detail: '内置兜底 / privacy',
    origin: 'human',
    sensitive: false,
    gold: { violation: true, categories: ['privacy'] },
  },
  {
    id: 'builtin-0008',
    text: '她的身材太火辣了，照片看得让人浮想联翩。',
    source: 'builtin',
    source_detail: '内置兜底 / sexual',
    origin: 'human',
    sensitive: true,
    gold: { violation: true, categories: ['sexual'] },
  },
  {
    id: 'builtin-0009',
    text: '请问这条地铁线路的末班车是几点？谢谢。',
    source: 'builtin',
    source_detail: '内置兜底 / safe',
    origin: 'human',
    sensitive: false,
    gold: { violation: false, categories: ['safe'] },
  },
  {
    id: 'builtin-0010',
    text: '论文讨论了网络暴力对青少年的影响，并提出了若干预防建议。',
    source: 'builtin',
    source_detail: '内置兜底 / safe / 学术讨论',
    origin: 'human',
    sensitive: false,
    gold: { violation: false, categories: ['safe'] },
  },
].map((s) => Object.freeze({ ...s, gold: Object.freeze(s.gold) })));

/** 归一化一条原始样本；非法返回 null。binary 模式只保留 safe/unsafe，忽略细分类别 */
export function normalizeSample(raw, options = {}) {
  const binary = isBinaryLabelMode(options.labelMode);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const text = typeof raw.text === 'string' ? raw.text : '';
  if (!id || !text.trim()) return null;

  const goldIn = raw.gold && typeof raw.gold === 'object' ? raw.gold : null;
  if (!goldIn) return null;

  // 可选图像样本：image 只接受同目录下的 basename（png/jpg/jpeg/webp），否则视为坏行；
  // 空字符串/纯空白视为未提供 image（纯文本样本）。
  let image = null;
  if (raw.image !== undefined && raw.image !== null) {
    if (typeof raw.image !== 'string') return null;
    const trimmedImage = raw.image.trim();
    if (trimmedImage !== '') {
      image = normalizeImageName(trimmedImage);
      if (!image) return null;
    }
  }

  let violation;
  if (goldIn.violation === true || goldIn.violation === 1 || goldIn.violation === 'true') {
    violation = true;
  } else if (
    goldIn.violation === false ||
    goldIn.violation === 0 ||
    goldIn.violation === 'false'
  ) {
    violation = false;
  } else {
    return null;
  }

  let categories;
  if (binary) {
    // 二分类数据集只有 safe / unsafe；原始细分类别不参与金标
    categories = violation ? [BINARY_UNSAFE_CODE] : ['safe'];
  } else {
    categories = Array.isArray(goldIn.categories)
      ? goldIn.categories
          .filter((c) => typeof c === 'string')
          .map((c) => c.trim().toLowerCase())
          .filter((c) => TAXONOMY_CODES.includes(c))
      : [];

    if (!violation) {
      categories = ['safe'];
    } else {
      categories = [...new Set(categories.filter((c) => c !== 'safe'))];
      if (!categories.length) return null;
    }
  }

  const sample = {
    ...raw,
    id,
    text,
    source: typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : 'unknown',
    origin:
      typeof raw.origin === 'string' && raw.origin.trim() ? raw.origin.trim() : 'unknown',
    sensitive: raw.sensitive === true,
    gold: { violation, categories: [...new Set(categories)] },
  };
  if (typeof raw.source_detail === 'string') sample.source_detail = raw.source_detail;
  if (image) sample.image = image;
  else delete sample.image;

  return sample;
}

/** 读取 jsonl 文件；坏行跳过并计数 */
export function readSamplesFile(filePath, options = {}) {
  const content = fs.readFileSync(filePath, 'utf8');
  const samples = [];
  let invalidLines = 0;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const sample = normalizeSample(JSON.parse(line), options);
      if (sample) samples.push(sample);
      else invalidLines += 1;
    } catch {
      invalidLines += 1;
    }
  }
  return { samples, invalidLines };
}

const cache = new Map();

function statSafe(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function fallbackDataset(filePath, error, invalidLines = 0) {
  return {
    samples: [...BUILTIN_SAMPLES],
    fallback: true,
    builtin: true,
    error,
    invalidLines,
    path: filePath,
  };
}

/**
 * 获取数据集（带缓存，文件变更后自动重新加载）。
 * samples.jsonl 不存在或没有有效样本时返回内置兜底样本（fallback=true）。
 */
export function getDataset(options = {}) {
  const filePath = options.filePath || getConfig().datasetPath;
  const labelMode = options.labelMode === 'binary' ? 'binary' : 'taxonomy';
  const cacheKey = `${filePath}|${labelMode}`;
  const stat = statSafe(filePath);

  if (!stat || !stat.isFile()) {
    cache.delete(cacheKey);
    return fallbackDataset(filePath, `数据集文件不存在：${filePath}（当前使用内置兜底样本）`);
  }

  const cached = cache.get(cacheKey);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.dataset;
  }

  try {
    const { samples, invalidLines } = readSamplesFile(filePath, { labelMode });
    let dataset;
    if (!samples.length) {
      dataset = fallbackDataset(
        filePath,
        `数据集无有效样本：${filePath}（当前使用内置兜底样本）`,
        invalidLines,
      );
    } else {
      dataset = {
        samples,
        fallback: false,
        builtin: false,
        error: null,
        invalidLines,
        path: filePath,
      };
    }
    cache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, dataset });
    return dataset;
  } catch (error) {
    cache.delete(filePath);
    return fallbackDataset(
      filePath,
      `读取数据集失败：${error?.message || error}（当前使用内置兜底样本）`,
    );
  }
}

/** 仅供测试：清空缓存 */
export function resetDatasetCache() {
  cache.clear();
}

/**
 * 过滤样本。
 * @param {Array} samples
 * @param {{filter?: string, category?: string, q?: string, errorIds?: Set<string>}} opts
 */
export function filterSamples(samples, opts = {}) {
  const filter = typeof opts.filter === 'string' ? opts.filter : 'all';
  const category = typeof opts.category === 'string' ? opts.category.trim() : '';
  const keyword = typeof opts.q === 'string' ? opts.q.trim().toLowerCase() : '';
  const errorIds = opts.errorIds instanceof Set ? opts.errorIds : null;

  return samples.filter((sample) => {
    if (filter === 'violation' && !sample.gold.violation) return false;
    if (filter === 'safe' && sample.gold.violation) return false;
    if (filter === 'error' && !(errorIds && errorIds.has(sample.id))) return false;
    if (category && !(sample.gold.categories || []).includes(category)) return false;
    if (keyword && !String(sample.text).toLowerCase().includes(keyword)) return false;
    return true;
  });
}
