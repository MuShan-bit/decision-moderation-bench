// 图像样本支持：dataset 校验 / System One payload / Cloudflare 图片透传 / 跑分读取与 CSV。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeSample } from '../server/dataset.mjs';
import { buildSystemOnePayload } from '../server/providers/systemone.mjs';
import { createCloudflareProvider } from '../server/providers/cloudflare.mjs';
import { runBenchmark, resultToCsv } from '../server/benchmark.mjs';

const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';

function makeSample(overrides = {}) {
  return {
    id: 'cold-0001',
    text: '这是一张用户聊天截图，请审核图片中的内容。',
    source: 'cold',
    source_detail: 'COLD test / race / fg=1（图像版）',
    origin: 'human',
    sensitive: false,
    gold: { violation: true, categories: ['insult'] },
    ...overrides,
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function cloudflareAnswers(category = 'safe') {
  const probabilities = {
    safe: category === 'safe' ? 0.9 : 0.05,
    insult: category === 'insult' ? 0.9 : 0.01,
    hate: 0.01,
    sexual: 0.01,
    violence: 0.01,
    illegal: 0.01,
    spam: 0.01,
    privacy: 0.01,
  };
  return {
    model: 'clef-omni',
    answers: {
      category: { type: 'choice', choice: category, probabilities, confidence: 0.9 },
      severity: {
        type: 'score',
        score: category === 'safe' ? 0 : 2,
        legend: {},
        probabilities: {},
        confidence: 0.9,
      },
      attack: { type: 'noul', noul: 0.01 },
      harmful: { type: 'noul', noul: 0.01 },
    },
    usage: { input_tokens: 1000, output_tokens: 0 },
  };
}

test('normalizeSample：接受 basename 图片并保留 image 字段', () => {
  for (const name of ['img-cold-0001.png', 'a.jpg', 'b.jpeg', 'c.webp', 'UPPER.PNG']) {
    const sample = normalizeSample(makeSample({ image: name }));
    assert.equal(sample.image, name);
  }
  // 未提供 image / 空字符串：保持纯文本样本
  assert.equal(normalizeSample(makeSample()).image, undefined);
  assert.equal(normalizeSample(makeSample({ image: '' })).image, undefined);
  assert.equal(normalizeSample(makeSample({ image: '   ' })).image, undefined);
});

test('normalizeSample：拒绝目录穿越 / 非法扩展名 / 超长图片名', () => {
  const badNames = [
    '../secret.png',
    'dir/a.png',
    '/etc/passwd',
    'a.gif',
    'a.png.exe',
    'a b.png',
    `${'x'.repeat(130)}.png`,
  ];
  for (const name of badNames) {
    assert.equal(normalizeSample(makeSample({ image: name })), null, `应拒绝 ${name}`);
  }
  assert.equal(normalizeSample(makeSample({ image: 42 })), null);
});

test('buildSystemOnePayload：images 非空时附带图片并切换为图片措辞', () => {
  const textPayload = buildSystemOnePayload('测试文本', {});
  assert.equal(textPayload.images, undefined);
  assert.match(textPayload.questions.category.instructions, /文本/);

  const image = { content_type: 'image/png', base64: 'aGVsbG8=' };
  const imagePayload = buildSystemOnePayload('这是一张用户聊天截图', { images: [image] });
  assert.deepEqual(imagePayload.images, [image]);
  assert.match(imagePayload.questions.category.instructions, /图片/);
  assert.match(imagePayload.questions.severity.instructions, /图片/);
  assert.match(imagePayload.questions.attack.instructions, /图片/);
  assert.match(imagePayload.questions.harmful.instructions, /图片/);

  // 空/非法 images 不产生 images 字段，保持纯文本协议
  const empty = buildSystemOnePayload('测试文本', { images: [{ base64: '' }, null, 'x'] });
  assert.equal(empty.images, undefined);
});

test('cloudflare provider：supportsImages 且 judge 把 images 透传到请求体', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return jsonResponse({ result: cloudflareAnswers('insult'), success: true, errors: [], messages: [] });
  };
  const provider = createCloudflareProvider({
    apiToken: 'cf_test_token',
    accountId: ACCOUNT_ID,
    fetchImpl,
  });
  assert.equal(provider.supportsImages, true);

  const images = [{ content_type: 'image/png', base64: 'aGVsbG8=' }];
  const response = await provider.judge('这是一张用户聊天截图', { images });
  assert.equal(response.error, null);
  assert.deepEqual(response.verdict.categories, ['insult']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.images, images);
  assert.match(calls[0].body.questions.category.instructions, /图片/);
});

function makeFakeProvider() {
  const captured = [];
  return {
    captured,
    provider: {
      name: 'fake',
      model: 'fake-image-v1',
      simulated: false,
      supportsImages: true,
      async judge(text, ctx = {}) {
        captured.push({ text, images: ctx.images });
        return {
          verdict: {
            violation: 0,
            categories: ['safe'],
            severity: 0,
            confidence: 0.99,
            reason: '测试',
          },
          parseError: false,
          error: null,
          raw: '',
          tokens: { prompt: 10, completion: 0, total: 10 },
          latencyMs: 3,
        };
      },
    },
  };
}

function withTempEnv(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlab-image-'));
  return Promise.resolve(fn(dir)).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('runBenchmark：读取图片文件、把 images 传给 provider、记录 image 并进入 CSV', async () => {
  await withTempEnv(async (dir) => {
    const imagesDir = path.join(dir, 'images');
    const resultsDir = path.join(dir, 'results');
    fs.mkdirSync(imagesDir, { recursive: true });
    const bytes = Buffer.from('fake-image-bytes');
    fs.writeFileSync(path.join(imagesDir, 'img-cold-0001.png'), bytes);

    const { captured, provider } = makeFakeProvider();
    const samples = [
      normalizeSample(makeSample({ id: 'img-cold-0001', image: 'img-cold-0001.png' })),
      normalizeSample(
        makeSample({
          id: 'cold-0002',
          text: '这是纯文本样本，不应携带 images',
          gold: { violation: false, categories: ['safe'] },
        }),
      ),
    ];

    const result = await runBenchmark({
      samples,
      provider,
      concurrency: 1,
      runId: 'img-test-run',
      resultsDir,
      imagesDir,
    });

    assert.equal(result.config.modality, 'image');
    assert.equal(result.config.imageCount, 1);
    assert.equal(result.records[0].image, 'img-cold-0001.png');
    assert.equal(result.records[1].image, undefined);
    assert.deepEqual(captured[0].images, [
      { content_type: 'image/png', base64: bytes.toString('base64') },
    ]);
    assert.equal(captured[1].images, undefined);

    const csv = resultToCsv(result);
    const lines = csv.split(/\r?\n/);
    assert.ok(lines[0].endsWith(',image'));
    assert.ok(lines[1].endsWith(',img-cold-0001.png'));
    assert.ok(lines[2].endsWith(','));
  });
});

test('runBenchmark：provider 不支持图片时拒绝跑分', async () => {
  const { provider } = makeFakeProvider();
  provider.supportsImages = false;
  const samples = [normalizeSample(makeSample({ image: 'img-cold-0001.png' }))];
  await assert.rejects(
    () =>
      runBenchmark({
        samples,
        provider,
        runId: 'img-unsupported',
        resultsDir: path.join(os.tmpdir(), `modlab-img-unsupported-${Date.now()}`),
        imagesDir: os.tmpdir(),
      }),
    /不支持图片输入/,
  );
});

test('runBenchmark：图片文件缺失时记为单条错误，不中断整轮', async () => {
  await withTempEnv(async (dir) => {
    const { provider } = makeFakeProvider();
    const samples = [
      normalizeSample(makeSample({ id: 'img-missing', image: 'missing.png' })),
      normalizeSample(
        makeSample({
          id: 'cold-0002',
          text: '正常文本样本',
          gold: { violation: false, categories: ['safe'] },
        }),
      ),
    ];
    const result = await runBenchmark({
      samples,
      provider,
      concurrency: 1,
      runId: 'img-missing-run',
      resultsDir: path.join(dir, 'results'),
      imagesDir: path.join(dir, 'images'),
    });
    assert.match(result.records[0].error, /图片读取失败/);
    assert.equal(result.records[0].prediction, null);
    assert.equal(result.records[1].error, null);
    assert.equal(result.metrics.binary.errors, 1);
  });
});
