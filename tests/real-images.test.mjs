import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { importRealImages } from '../scripts/import_real_images.mjs';

const FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-images-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(t, labelsWriter) {
  const root = tempDir(t);
  const src = path.join(root, 'src');
  const out = path.join(root, 'out');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'a.png'), FIXTURE_PNG);
  fs.writeFileSync(path.join(src, 'b.png'), FIXTURE_PNG);
  const labelsPath = path.join(root, 'labels.csv');
  fs.writeFileSync(labelsPath, labelsWriter(src));
  return { root, src, out, labelsPath };
}

test('真实图像导入：CSV 生成可被 dataset 加载的清单', (t) => {
  const { src, out, labelsPath } = setup(
    t,
    () =>
      'file,violation,category,sensitive,source_detail\n' +
      'a.png,1,sexual,1,"自建 NSFW / 明确裸露"\n' +
      'b.png,0,safe,0,自建 NSFW / 正常\n',
  );

  const summary = importRealImages({ srcDir: src, labelsPath, outDir: out });
  assert.equal(summary.total, 2);
  assert.equal(summary.sensitive, 1);
  assert.deepEqual(summary.stats, { sexual: 1, safe: 1 });

  const samples = fs
    .readFileSync(path.join(out, 'samples.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(samples.length, 2);
  assert.equal(samples[0].id, 'real-0001');
  assert.equal(samples[0].image, 'real-0001.png');
  assert.equal(samples[0].text, '这是一张用户上传的图片，请审核图片中的内容。');
  assert.equal(samples[0].source, 'real');
  assert.equal(samples[0].sensitive, true);
  assert.deepEqual(samples[0].gold, { violation: true, categories: ['sexual'] });
  assert.equal(samples[0].source_detail, '自建 NSFW / 明确裸露');
  assert.deepEqual(samples[1].gold, { violation: false, categories: ['safe'] });
  assert.equal(samples[1].sensitive, false);

  assert.ok(fs.existsSync(path.join(out, 'real-0001.png')));
  assert.ok(fs.existsSync(path.join(out, 'real-0002.png')));
  assert.ok(!fs.existsSync(path.join(out, 'a.png')));
});

test('真实图像导入：JSONL 标注，sexual 缺省 sensitive=true，violation=0 强制 safe', (t) => {
  const root = tempDir(t);
  const src = path.join(root, 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'a.png'), FIXTURE_PNG);
  fs.writeFileSync(path.join(src, 'b.png'), FIXTURE_PNG);
  const labelsPath = path.join(root, 'labels.jsonl');
  fs.writeFileSync(
    labelsPath,
    [
      JSON.stringify({ file: 'a.png', violation: 1, category: 'sexual' }),
      JSON.stringify({ file: 'b.png', violation: 0, category: 'insult' }),
    ].join('\n'),
  );
  const out = path.join(root, 'out');

  const summary = importRealImages({ srcDir: src, labelsPath, outDir: out });
  assert.equal(summary.total, 2);
  const samples = fs
    .readFileSync(path.join(out, 'samples.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(samples[0].sensitive, true);
  assert.equal(samples[0].gold.categories[0], 'sexual');
  assert.deepEqual(samples[1].gold, { violation: false, categories: ['safe'] });
  assert.equal(samples[1].sensitive, false);
});

test('真实图像导入：类别非法 / violation=1 选 safe 报错', (t) => {
  const { src, out, labelsPath } = setup(t, () => 'file,violation,category\n' + 'a.png,1,safe\n');
  assert.throws(() => importRealImages({ srcDir: src, labelsPath, outDir: out }), /category 非法/);
});

test('真实图像导入：伪装扩展名报错', (t) => {
  const root = tempDir(t);
  const src = path.join(root, 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'fake.webp'), FIXTURE_PNG);
  const labelsPath = path.join(root, 'labels.csv');
  fs.writeFileSync(labelsPath, 'file,violation,category\nfake.webp,1,insult\n');
  const out = path.join(root, 'out');
  assert.throws(() => importRealImages({ srcDir: src, labelsPath, outDir: out }), /扩展名与内容不一致/);
});

test('真实图像导入：非图片内容报错', (t) => {
  const root = tempDir(t);
  const src = path.join(root, 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'notes.png'), 'not an image');
  const labelsPath = path.join(root, 'labels.csv');
  fs.writeFileSync(labelsPath, 'file,violation,category\nnotes.png,1,insult\n');
  const out = path.join(root, 'out');
  assert.throws(() => importRealImages({ srcDir: src, labelsPath, outDir: out }), /不是有效图片/);
});

test('真实图像导入：超过大小上限报错', (t) => {
  const { src, out, labelsPath } = setup(t, () => 'file,violation,category\n' + 'a.png,1,insult\n');
  assert.throws(
    () => importRealImages({ srcDir: src, labelsPath, outDir: out, maxBytes: 10 }),
    /超过大小上限/,
  );
});

test('真实图像导入：重复图片 / 路径越界 / 输出目录非空均报错', (t) => {
  const { root, src, out, labelsPath } = setup(
    t,
    () => 'file,violation,category\n' + 'a.png,1,insult\na.png,0,safe\n',
  );
  assert.throws(() => importRealImages({ srcDir: src, labelsPath, outDir: out }), /图片重复/);

  const traversalLabels = path.join(root, 'labels-traversal.csv');
  fs.writeFileSync(traversalLabels, 'file,violation,category\n../escape.png,1,insult\n');
  assert.throws(
    () => importRealImages({ srcDir: src, labelsPath: traversalLabels, outDir: out }),
    /图片路径越界/,
  );

  const okLabels = path.join(root, 'labels-ok.csv');
  fs.writeFileSync(okLabels, 'file,violation,category\na.png,1,insult\n');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'keep.txt'), 'x');
  assert.throws(
    () => importRealImages({ srcDir: src, labelsPath: okLabels, outDir: out }),
    /输出目录非空/,
  );
  const summary = importRealImages({ srcDir: src, labelsPath: okLabels, outDir: out, force: true });
  assert.equal(summary.total, 1);
  assert.ok(fs.existsSync(path.join(out, 'keep.txt')));
});

test('真实图像导入：--limit 只导入前 n 条', (t) => {
  const { src, out, labelsPath } = setup(
    t,
    () => 'file,violation,category\n' + 'a.png,1,insult\nb.png,0,safe\n',
  );
  const summary = importRealImages({ srcDir: src, labelsPath, outDir: out, limit: 1 });
  assert.equal(summary.total, 1);
  assert.equal(summary.stats.insult, 1);
});
