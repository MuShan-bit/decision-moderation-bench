// 数据集加载 / 兜底样本 / 过滤 单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BUILTIN_SAMPLES,
  normalizeSample,
  readSamplesFile,
  getDataset,
  filterSamples,
  resetDatasetCache,
} from '../server/dataset.mjs';

function makeSample(overrides = {}) {
  return {
    id: 'cold-0001',
    text: '示例用户文本内容足够长',
    source: 'cold',
    source_detail: 'COLD test / race / fg=1',
    origin: 'human',
    sensitive: false,
    gold: { violation: true, categories: ['insult'] },
    ...overrides,
  };
}

test('内置兜底样本：10 条、id 唯一、gold 合法', () => {
  assert.equal(BUILTIN_SAMPLES.length, 10);
  assert.equal(new Set(BUILTIN_SAMPLES.map((s) => s.id)).size, 10);
  for (const sample of BUILTIN_SAMPLES) {
    assert.ok(sample.id.startsWith('builtin-'));
    assert.equal(sample.source, 'builtin');
    assert.ok(sample.text.length >= 8);
    if (sample.gold.violation) {
      assert.ok(sample.gold.categories.length > 0);
      assert.ok(!sample.gold.categories.includes('safe'));
    } else {
      assert.deepEqual(sample.gold.categories, ['safe']);
    }
  }
  assert.ok(BUILTIN_SAMPLES.some((s) => s.gold.violation));
  assert.ok(BUILTIN_SAMPLES.some((s) => !s.gold.violation));
});

test('normalizeSample：合法 / gold 归一化 / 非法拒绝', () => {
  const ok = normalizeSample(makeSample());
  assert.equal(ok.id, 'cold-0001');
  assert.deepEqual(ok.gold, { violation: true, categories: ['insult'] });
  assert.equal(ok.source_detail, 'COLD test / race / fg=1');

  const safeWithBadCats = normalizeSample(
    makeSample({ gold: { violation: false, categories: ['insult'] } }),
  );
  assert.deepEqual(safeWithBadCats.gold, { violation: false, categories: ['safe'] });

  const mixed = normalizeSample(
    makeSample({ gold: { violation: true, categories: ['safe', 'hate', 'nope'] } }),
  );
  assert.deepEqual(mixed.gold.categories, ['hate']);

  assert.equal(normalizeSample(null), null);
  assert.equal(normalizeSample({}), null);
  assert.equal(normalizeSample(makeSample({ id: '' })), null);
  assert.equal(normalizeSample(makeSample({ text: '   ' })), null);
  assert.equal(normalizeSample(makeSample({ gold: { violation: true, categories: [] } })), null);
  assert.equal(
    normalizeSample(makeSample({ gold: { violation: 'maybe', categories: [] } })),
    null,
  );

  const sensitive = normalizeSample(makeSample({ sensitive: true }));
  assert.equal(sensitive.sensitive, true);
});

test('readSamplesFile：跳过坏行并计数', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlab-ds-'));
  const file = path.join(dir, 'samples.jsonl');
  try {
    fs.writeFileSync(
      file,
      [
        JSON.stringify(makeSample({ id: 'cold-0001' })),
        'not-json',
        '',
        JSON.stringify(makeSample({ id: 'cold-0002', text: '第二条正常样本文本' })),
        JSON.stringify({ id: 'bad', text: '' }),
        JSON.stringify(makeSample({ id: 'cold-0003', text: '第三条正常样本文本' })),
      ].join('\n'),
    );
    const { samples, invalidLines } = readSamplesFile(file);
    assert.equal(samples.length, 3);
    assert.equal(invalidLines, 2);
    assert.deepEqual(
      samples.map((s) => s.id),
      ['cold-0001', 'cold-0002', 'cold-0003'],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getDataset：文件缺失 -> 内置兜底', () => {
  resetDatasetCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlab-miss-'));
  try {
    const dataset = getDataset({ filePath: path.join(dir, 'not-exist.jsonl') });
    assert.equal(dataset.fallback, true);
    assert.equal(dataset.samples.length, 10);
    assert.equal(dataset.samples[0].source, 'builtin');
    assert.match(dataset.error, /不存在/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getDataset：正常加载 + 文件变化后自动重载', () => {
  resetDatasetCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlab-load-'));
  const file = path.join(dir, 'samples.jsonl');
  try {
    fs.writeFileSync(
      file,
      [
        JSON.stringify(makeSample({ id: 'cold-0001', text: '第一条样本文本够长' })),
        JSON.stringify(makeSample({ id: 'cold-0002', text: '第二条样本文本够长' })),
      ].join('\n'),
    );
    const first = getDataset({ filePath: file });
    assert.equal(first.fallback, false);
    assert.equal(first.samples.length, 2);
    assert.equal(first.invalidLines, 0);

    // 内容变化（size 变化）后应自动重载
    fs.writeFileSync(
      file,
      [
        JSON.stringify(makeSample({ id: 'cold-0001', text: '第一条样本文本够长' })),
        JSON.stringify(makeSample({ id: 'cold-0002', text: '第二条样本文本够长' })),
        JSON.stringify(makeSample({ id: 'cold-0003', text: '第三条新增样本文本' })),
      ].join('\n'),
    );
    const second = getDataset({ filePath: file });
    assert.equal(second.samples.length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getDataset：空文件 -> 兜底', () => {
  resetDatasetCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlab-empty-'));
  const file = path.join(dir, 'samples.jsonl');
  try {
    fs.writeFileSync(file, '\n\n');
    const dataset = getDataset({ filePath: file });
    assert.equal(dataset.fallback, true);
    assert.equal(dataset.samples.length, 10);
    assert.match(dataset.error, /无有效样本/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('filterSamples：filter / category / q / errorIds', () => {
  const samples = [
    makeSample({ id: 'a-1', text: '辱骂内容示例', gold: { violation: true, categories: ['insult'] } }),
    makeSample({ id: 'a-2', text: '正常内容示例', gold: { violation: false, categories: ['safe'] } }),
    makeSample({ id: 'a-3', text: '广告推广内容', gold: { violation: true, categories: ['spam'] } }),
    makeSample({ id: 'a-4', text: '另一条正常内容', gold: { violation: false, categories: ['safe'] } }),
  ];
  assert.equal(filterSamples(samples, { filter: 'all' }).length, 4);
  assert.equal(filterSamples(samples, { filter: 'violation' }).length, 2);
  assert.equal(filterSamples(samples, { filter: 'safe' }).length, 2);
  assert.deepEqual(
    filterSamples(samples, { filter: 'all', category: 'spam' }).map((s) => s.id),
    ['a-3'],
  );
  assert.deepEqual(
    filterSamples(samples, { filter: 'all', q: '正常' }).map((s) => s.id),
    ['a-2', 'a-4'],
  );
  assert.deepEqual(
    filterSamples(samples, { filter: 'error', errorIds: new Set(['a-1', 'a-3']) }).map(
      (s) => s.id,
    ),
    ['a-1', 'a-3'],
  );
  assert.equal(filterSamples(samples, { filter: 'error' }).length, 0);
});
