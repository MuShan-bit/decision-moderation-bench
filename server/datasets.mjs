// 评测集选择与校验：把档案（dataset-profiles）与真实样本加载组合起来。
//
// 核心规则：
// - 文本评测集可用任意 provider；
// - 图像评测集（text-image / unsafebench / nsfw-image / 自定义含 image 的集合）当前只允许 cloudflare（clef-omni）；
// - NSFW 实拍图像集只在本地存在（data/real-images 不入库），未导入时给出可执行的修复提示。

import fs from 'node:fs';
import path from 'node:path';

import { getDataset } from './dataset.mjs';
import {
  DATASET_PROFILES,
  DEFAULT_DATASET_ID,
  profileById,
  profileByDatasetPath,
  publicProfile,
  resolveDatasetPaths,
} from './dataset-profiles.mjs';

const IMAGE_PROVIDERS = Object.freeze(['cloudflare']);

function datasetError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function profilesForConfig(cfg) {
  const known = profileById(cfg?.dataset);
  if (known) return known;
  return profileByDatasetPath(cfg?.datasetPath);
}

function inferModality(samples) {
  return samples.some((sample) => sample && sample.image) ? 'image' : 'text';
}

function summarize(selection) {
  return {
    id: selection.id,
    name: selection.name,
    kind: selection.kind,
    modality: selection.modality,
    description: selection.description,
    labelMode: selection.labelMode,
    labels: selection.labels ? [...selection.labels] : null,
    committed: selection.committed === true,
    localOnly: selection.localOnly === true,
    providers: selection.providers ? [...selection.providers] : null,
    available: selection.available,
    sampleCount: selection.available ? selection.sampleCount : 0,
    imageCount: selection.available ? selection.imageCount : 0,
    fallback: selection.fallback === true,
    invalidLines: selection.invalidLines || 0,
  };
}

/** 单个数据集的公开元数据（供 API 返回，不含绝对路径） */
export function publicDatasetInfo(selection) {
  return summarize(selection);
}

function unavailableHint(id) {
  if (id === 'nsfw-image') {
    return '先运行 node scripts/import_real_images.mjs --src <图片目录> --labels <标注文件> 导入本地实拍图像（图片不入库）';
  }
  if (id === 'text-image') {
    return '仓库缺少 data/images/samples.jsonl，请检查数据文件是否完整';
  }
  if (id === 'unsafebench') {
    return '先运行 python3 scripts/prepare_unsafebench.py --parquet data/raw/unsafebench/data/test-00000-of-00001.parquet 生成本地二分类图像集（图片不入库）';
  }
  return '请检查 DATASET_PATH / DATASET 配置';
}

/** 基于档案或自定义路径构造一个选择对象（不加载样本） */
function buildSelection(cfg, { id, name, kind, modality, description, providers, path: filePath, imagesDir, committed, localOnly, labelMode }) {
  const available = Boolean(filePath) && fs.existsSync(filePath);
  let dataset = null;
  if (available) {
    dataset = getDataset({ filePath, labelMode });
    // 文件存在但坏行全被跳过时 getDataset 会回退到内置样本：此时视为不可用
    if (dataset.fallback || !dataset.samples.length) dataset = null;
  }
  const usable = Boolean(dataset);
  const samples = usable ? dataset.samples : [];
  const resolvedModality = modality || inferModality(samples);
  const resolvedProviders = providers || (resolvedModality === 'image' ? [...IMAGE_PROVIDERS] : null);
  return {
    id,
    name,
    kind,
    modality: resolvedModality,
    description,
    labelMode: labelMode === 'binary' ? 'binary' : 'taxonomy',
    labels: labelMode === 'binary' ? ['safe', 'unsafe'] : null,
    providers: resolvedProviders,
    committed: committed === true,
    localOnly: localOnly === true,
    available: usable,
    fallback: dataset ? dataset.fallback === true : false,
    path: filePath,
    imagesDir: imagesDir || (filePath ? path.dirname(filePath) : null),
    samples,
    sampleCount: samples.length,
    imageCount: samples.filter((sample) => sample && sample.image).length,
    invalidLines: dataset?.invalidLines || 0,
    error: usable ? null : dataset?.error || (available ? '数据集无有效样本' : `数据集文件不存在：${filePath}`),
  };
}

function selectionFromProfile(cfg, profile) {
  const paths = resolveDatasetPaths(profile);
  // 环境变量 IMAGES_DIR 对该档案生效（同路径时）
  const imagesDir = paths.path === cfg.datasetPath ? cfg.imagesDir : paths.imagesDir;
  return buildSelection(cfg, {
    ...publicProfile(profile),
    path: paths.path,
    imagesDir,
  });
}

function selectionFromCustom(cfg) {
  return buildSelection(cfg, {
    id: 'custom',
    name: '自定义数据集',
    kind: 'custom',
    modality: null,
    description: '通过 DATASET_PATH 指定的数据集',
    providers: null,
    labelMode: 'taxonomy',
    path: cfg.datasetPath,
    imagesDir: cfg.imagesDir,
    committed: false,
    localOnly: true,
  });
}

/** 当前配置对应的默认数据集 id */
export function defaultDatasetId(cfg) {
  return profilesForConfig(cfg)?.id || 'custom';
}

/** 当前配置对应的默认数据集（已加载样本） */
export function getDefaultDataset(cfg) {
  const profile = profilesForConfig(cfg);
  return profile ? selectionFromProfile(cfg, profile) : selectionFromCustom(cfg);
}

/**
 * 解析请求的数据集：不传 id 时用配置默认值；支持 text / text-image / unsafebench / nsfw-image / custom。
 * 不可用或未知时抛错（error.status / error.code 供 HTTP 层使用）。
 */
export function resolveDatasetSelection(cfg, requestedId) {
  const id = String(requestedId ?? '').trim();
  if (!id) {
    const selection = getDefaultDataset(cfg);
    if (!selection.available) {
      throw datasetError(
        `默认数据集不可用：${selection.error || '未知原因'}`,
        'DATASET_UNAVAILABLE',
      );
    }
    return selection;
  }
  if (id === 'custom') {
    const selection = selectionFromCustom(cfg);
    if (!selection.available) {
      throw datasetError(
        `自定义数据集不可用：${selection.error}`,
        'DATASET_UNAVAILABLE',
      );
    }
    return selection;
  }
  const profile = profileById(id);
  if (!profile) {
    throw datasetError(
      `未知数据集：${id}（可选：${DATASET_PROFILES.map((item) => item.id).join(' / ')} / custom）`,
      'UNKNOWN_DATASET',
    );
  }
  const selection = selectionFromProfile(cfg, profile);
  if (!selection.available) {
    throw datasetError(
      `数据集「${profile.name}」不可用：${unavailableHint(profile.id)}`,
      'DATASET_UNAVAILABLE',
    );
  }
  return selection;
}

/** 列出内置档案 + 当前自定义数据集，供前端数据集选择器使用 */
export function listDatasetSummaries(cfg) {
  const summaries = DATASET_PROFILES.map((profile) => summarize(selectionFromProfile(cfg, profile)));
  const profile = profilesForConfig(cfg);
  if (!profile) summaries.push(summarize(selectionFromCustom(cfg)));
  return summaries;
}

/** 自定义数据集路径（CLI 的 --dataset <path> 或临时文件） */
export function resolveCustomDataset(filePath, imagesDir) {
  const selection = buildSelection(
    {},
    {
      id: 'custom',
      name: '自定义数据集',
      kind: 'custom',
      modality: null,
      description: '自定义路径数据集',
      providers: null,
      labelMode: 'taxonomy',
      path: path.resolve(filePath),
      imagesDir: imagesDir ? path.resolve(imagesDir) : path.dirname(path.resolve(filePath)),
      committed: false,
      localOnly: true,
    },
  );
  if (!selection.available) {
    throw datasetError(`自定义数据集不可用：${selection.error}`, 'DATASET_UNAVAILABLE');
  }
  return selection;
}

/** 图像数据集当前只允许 cloudflare（clef-omni）；文本数据集不限制 provider */
export function assertDatasetProvider(dataset, providerName) {
  if (!dataset.providers || !dataset.providers.length) return;
  if (dataset.providers.includes(providerName)) return;
  throw datasetError(
    `数据集「${dataset.name}」是图像评测集，当前仅允许 ${dataset.providers.join(' / ')}（clef-omni）；provider ${providerName} 不支持图片输入`,
    'IMAGE_UNSUPPORTED',
  );
}

/** 图像数据集进一步锁定 clef-omni 模型，避免 future 模型列表扩张后误用 */
export function assertDatasetModel(dataset, model) {
  if (!dataset.providers || !dataset.providers.length) return;
  if (String(model || '').includes('clef-omni')) return;
  throw datasetError(
    `数据集「${dataset.name}」是图像评测集，当前仅允许 clef-omni 模型；model ${model || '（默认）'} 不支持图片输入`,
    'IMAGE_UNSUPPORTED',
  );
}

export { DEFAULT_DATASET_ID, IMAGE_PROVIDERS };
