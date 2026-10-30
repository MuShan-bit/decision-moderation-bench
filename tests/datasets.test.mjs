// 数据集档案 / provider 约束单元测试
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  assertDatasetModel,
  assertDatasetProvider,
  defaultDatasetId,
  listDatasetSummaries,
  resolveDatasetSelection,
} from '../server/datasets.mjs';
import {
  DATASET_PROFILES,
  profileById,
  resolveDatasetPaths,
} from '../server/dataset-profiles.mjs';
import { ROOT } from '../server/lib/env.mjs';

const TEXT_PATH = resolveDatasetPaths(profileById('text')).path;
const TEXT_IMAGE_PATH = resolveDatasetPaths(profileById('text-image')).path;

function cfgFor(filePath, imagesDir = path.dirname(filePath)) {
  const profile = DATASET_PROFILES.find((item) => resolveDatasetPaths(item).path === filePath);
  return {
    dataset: profile ? profile.id : 'custom',
    datasetPath: filePath,
    imagesDir,
  };
}

test('数据集档案：text / text-image / unsafebench / nsfw-image 四个独立档案', () => {
  assert.deepEqual(
    DATASET_PROFILES.map((item) => item.id),
    ['text', 'text-image', 'unsafebench', 'nsfw-image'],
  );
  assert.equal(profileById('text').modality, 'text');
  assert.equal(profileById('text-image').modality, 'image');
  assert.deepEqual(profileById('text-image').providers, ['cloudflare']);
  assert.equal(profileById('nsfw-image').localOnly, true);
  assert.equal(profileById('nsfw-image').committed, false);
  assert.equal(profileById('unsafebench').labelMode, 'binary');
  assert.equal(profileById('unsafebench').localOnly, true);
});

test('默认数据集：按 DATASET_PATH 映射到内置档案，否则 custom', () => {
  assert.equal(defaultDatasetId(cfgFor(TEXT_PATH)), 'text');
  assert.equal(defaultDatasetId(cfgFor(TEXT_IMAGE_PATH)), 'text-image');
  assert.equal(defaultDatasetId(cfgFor('/tmp/not-a-known-dataset.jsonl')), 'custom');
});

test('文本评测集：可用任意 provider，无图片输入限制', () => {
  const selection = resolveDatasetSelection(cfgFor(TEXT_PATH), 'text');
  assert.equal(selection.id, 'text');
  assert.equal(selection.modality, 'text');
  assert.equal(selection.imageCount, 0);
  assert.ok(selection.sampleCount > 100);
  assert.doesNotThrow(() => assertDatasetProvider(selection, 'mock'));
  assert.doesNotThrow(() => assertDatasetProvider(selection, 'dashscope'));
});

test('文本图像评测集：120 条图像，仅允许 cloudflare', () => {
  const selection = resolveDatasetSelection(cfgFor(TEXT_PATH), 'text-image');
  assert.equal(selection.id, 'text-image');
  assert.equal(selection.modality, 'image');
  assert.equal(selection.sampleCount, 120);
  assert.equal(selection.imageCount, 120);
  assert.deepEqual(selection.providers, ['cloudflare']);
  assert.doesNotThrow(() => assertDatasetProvider(selection, 'cloudflare'));
  assert.throws(() => assertDatasetProvider(selection, 'mock'), /仅允许 cloudflare/);
  assert.throws(() => assertDatasetProvider(selection, 'dashscope'), /IMAGE_UNSUPPORTED|仅允许/);
  assert.doesNotThrow(() => assertDatasetModel(selection, 'clef-omni'));
  assert.throws(() => assertDatasetModel(selection, 'decision-model-preview'), /仅允许 clef-omni/);
});

test('NSFW 实拍图像集：本地未导入时给出可执行提示', () => {
  const nsfwPath = resolveDatasetPaths(profileById('nsfw-image')).path;
  if (fs.existsSync(nsfwPath)) {
    const selection = resolveDatasetSelection(cfgFor(TEXT_PATH), 'nsfw-image');
    assert.equal(selection.id, 'nsfw-image');
    assert.equal(selection.modality, 'image');
    return;
  }
  assert.throws(
    () => resolveDatasetSelection(cfgFor(TEXT_PATH), 'nsfw-image'),
    (error) => error.code === 'DATASET_UNAVAILABLE' && /真实图像|NSFW/.test(error.message),
  );
});

test('UnsafeBench 二分类集：binary labelMode、safe/unsafe 金标、仅 cloudflare', () => {
  const samplePath = resolveDatasetPaths(profileById('unsafebench')).path;
  if (!fs.existsSync(samplePath)) return;
  const selection = resolveDatasetSelection(cfgFor(TEXT_PATH), 'unsafebench');
  assert.equal(selection.id, 'unsafebench');
  assert.equal(selection.labelMode, 'binary');
  assert.deepEqual(selection.labels, ['safe', 'unsafe']);
  assert.equal(selection.modality, 'image');
  assert.ok(selection.sampleCount >= 2);
  assert.ok(selection.samples.every((sample) =>
    sample.gold.categories.length === 1 &&
    ['safe', 'unsafe'].includes(sample.gold.categories[0])));
  assert.deepEqual(selection.providers, ['cloudflare']);
  assert.doesNotThrow(() => assertDatasetProvider(selection, 'cloudflare'));
  assert.throws(() => assertDatasetProvider(selection, 'mock'), /仅允许 cloudflare/);
});

test('未知数据集 / 自定义路径缺失：明确报错', () => {
  assert.throws(
    () => resolveDatasetSelection(cfgFor(TEXT_PATH), 'not-a-dataset'),
    (error) => error.code === 'UNKNOWN_DATASET',
  );
  assert.throws(
    () => resolveDatasetSelection(cfgFor('/tmp/missing-samples.jsonl'), null),
    (error) => error.code === 'DATASET_UNAVAILABLE',
  );
});

test('数据集列表：内置档案 + 自定义集，元数据含模态/provider 约束', () => {
  const summaries = listDatasetSummaries(cfgFor(TEXT_PATH));
  const byId = Object.fromEntries(summaries.map((item) => [item.id, item]));
  assert.equal(byId.text.available, true);
  assert.equal(byId['text-image'].available, true);
  assert.equal(byId['text-image'].providers[0], 'cloudflare');
  assert.equal(byId['nsfw-image'].available, fs.existsSync(resolveDatasetPaths(profileById('nsfw-image')).path));
  assert.equal(byId.unsafebench.labelMode, 'binary');
  assert.deepEqual(byId.unsafebench.labels, ['safe', 'unsafe']);
  assert.equal('imageCount' in byId.text, true);
  assert.equal(byId.text.sampleCount > 0, true);

  const customSummaries = listDatasetSummaries(cfgFor('/tmp/custom-samples.jsonl'));
  assert.equal(customSummaries.some((item) => item.id === 'custom'), true);
  assert.equal(customSummaries.find((item) => item.id === 'custom').available, false);
});

test('自定义图像数据集：按样本推断 image 模态并限制 provider', () => {
  const root = fs.mkdtempSync(path.join(ROOT, '.tmp-dataset-test-'));
  try {
    const imagePath = path.join(root, 'samples.jsonl');
    fs.writeFileSync(
      imagePath,
      JSON.stringify({
        id: 'img-test-1',
        image: 'test.png',
        text: '这是一张用户上传的图片，请审核图片中的内容。',
        source: 'test',
        origin: 'human',
        sensitive: false,
        gold: { violation: true, categories: ['sexual'] },
      }) + '\n',
    );
    fs.writeFileSync(path.join(root, 'test.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const selection = resolveDatasetSelection(cfgFor(imagePath, root), null);
    assert.equal(selection.id, 'custom');
    assert.equal(selection.modality, 'image');
    assert.deepEqual(selection.providers, ['cloudflare']);
    assert.doesNotThrow(() => assertDatasetProvider(selection, 'cloudflare'));
    assert.throws(() => assertDatasetProvider(selection, 'jev'), /仅允许 cloudflare/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
