// 评测集档案：把「文本 / 文本图像 / NSFW 实拍图像」拆成互相独立的数据集。
//
// 约定：
// - text        ：纯文本评测集（data/eval），所有 provider 可跑；
// - text-image  ：文本渲染截图评测集（data/images），当前仅 cloudflare（clef-omni）可跑；
// - nsfw-image  ：真实 NSFW 等实拍图像评测集（data/real-images，本地导入、不入库），
//                 当前仅 cloudflare（clef-omni）可跑；
// - custom      ：显式 DATASET_PATH 指向的第三方/临时数据集，按样本是否含 image 推断模态。
//
// 本模块只依赖 Node 内置模块，供 env / server / CLI 共用，避免循环依赖。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const TEXT_DATASET_ID = 'text';
export const DEFAULT_DATASET_ID = TEXT_DATASET_ID;

export const DATASET_PROFILES = Object.freeze([
  Object.freeze({
    id: 'text',
    name: '文本评测集',
    kind: 'text',
    modality: 'text',
    relPath: 'data/eval/samples.jsonl',
    imagesRelPath: null,
    providers: null,
    committed: true,
    localOnly: false,
    description: '825 条中文文本审核样本（8 类），纯文本基线',
    labelMode: 'taxonomy',
  }),
  Object.freeze({
    id: 'text-image',
    name: '文本图像评测集',
    kind: 'text-image',
    modality: 'image',
    relPath: 'data/images/samples.jsonl',
    imagesRelPath: 'data/images',
    providers: Object.freeze(['cloudflare']),
    committed: true,
    localOnly: false,
    description: '120 条聊天/帖子截图（8 类 × 15），测图内文字审核',
    labelMode: 'taxonomy',
  }),
  Object.freeze({
    id: 'unsafebench',
    name: 'UnsafeBench 图像安全评测集',
    kind: 'unsafebench',
    modality: 'image',
    relPath: 'data/real-images/unsafebench/samples.jsonl',
    imagesRelPath: 'data/real-images/unsafebench',
    providers: Object.freeze(['cloudflare']),
    committed: false,
    localOnly: true,
    labelMode: 'binary',
    description: 'UnsafeBench 真实/AI 生成图像，safe/unsafe 二分类（本地导入）',
  }),
  Object.freeze({
    id: 'nsfw-image',
    name: 'NSFW 实拍图像评测集',
    kind: 'nsfw-image',
    modality: 'image',
    relPath: 'data/real-images/samples.jsonl',
    imagesRelPath: 'data/real-images',
    providers: Object.freeze(['cloudflare']),
    committed: false,
    localOnly: true,
    description: '本地导入的真实 NSFW 等实拍图像，图片不入库',
    labelMode: 'taxonomy',
  }),
]);

const PROFILE_BY_ID = new Map(DATASET_PROFILES.map((profile) => [profile.id, profile]));

export function profileById(id) {
  return PROFILE_BY_ID.get(String(id || '').trim()) || null;
}

/** 路径是否正好对应某个内置档案（用于把 DATASET_PATH 映射回数据集 id） */
export function profileByDatasetPath(filePath) {
  if (!filePath) return null;
  const target = path.resolve(String(filePath));
  for (const profile of DATASET_PROFILES) {
    if (path.resolve(ROOT, profile.relPath) === target) return profile;
  }
  return null;
}

export function resolveDatasetPaths(profile) {
  return {
    path: path.resolve(ROOT, profile.relPath),
    imagesDir: profile.imagesRelPath
      ? path.resolve(ROOT, profile.imagesRelPath)
      : path.dirname(path.resolve(ROOT, profile.relPath)),
  };
}

/** 档案的公开元数据（不含绝对路径），供 API/前端展示 */
export function publicProfile(profile, extra = {}) {
  return {
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    modality: profile.modality,
    description: profile.description,
    committed: profile.committed === true,
    localOnly: profile.localOnly === true,
    providers: profile.providers ? [...profile.providers] : null,
    labelMode: profile.labelMode === 'binary' ? 'binary' : 'taxonomy',
    labels: profile.labelMode === 'binary' ? ['safe', 'unsafe'] : null,
    ...extra,
  };
}

export function datasetFilesExist(profile) {
  if (!profile) return false;
  return fs.existsSync(resolveDatasetPaths(profile).path);
}

export { ROOT as DATASETS_ROOT };
