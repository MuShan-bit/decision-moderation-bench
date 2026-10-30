// 二分类（safe / unsafe）测评支持：请求体、响应解析、数据集归一化与指标。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSystemOnePayload,
  parseSystemOneResponse,
} from '../server/providers/systemone.mjs';
import { createCloudflareProvider } from '../server/providers/cloudflare.mjs';
import { createMockProvider } from '../server/providers/mock.mjs';
import { normalizeSample } from '../server/dataset.mjs';
import { computeMetrics } from '../server/benchmark.mjs';

const IMAGE = {
  content_type: 'image/jpeg',
  base64: Buffer.from('fake-image').toString('base64'),
};

test('二分类请求体：只发送 safety choice，不再发送细分类别/严重度', () => {
  const payload = buildSystemOnePayload('这是一张图片', { model: 'clef-omni', labelMode: 'binary' });
  assert.equal(payload.model, 'clef-omni');
  assert.deepEqual(Object.keys(payload.questions), ['safety']);
  assert.equal(payload.questions.safety.type, 'choice');
  assert.deepEqual(Object.keys(payload.questions.safety.criteria), ['safe', 'unsafe']);
  assert.equal(payload.images, undefined);

  const withImage = buildSystemOnePayload('图片', {
    model: 'clef-omni',
    labelMode: 'binary',
    images: [IMAGE],
  });
  assert.deepEqual(Object.keys(withImage.questions), ['safety']);
  assert.match(withImage.questions.safety.instructions, /图片/);
  assert.deepEqual(withImage.images, [IMAGE]);
});

test('二分类响应解析：choice / 概率回退 / 非法选项', () => {
  const unsafe = parseSystemOneResponse(
    {
      answers: {
        safety: {
          choice: 'unsafe',
          confidence: 0.87,
          probabilities: { safe: 0.13, unsafe: 0.87 },
        },
      },
    },
    { labelMode: 'binary' },
  );
  assert.equal(unsafe.error, null);
  assert.equal(unsafe.verdict.violation, 1);
  assert.deepEqual(unsafe.verdict.categories, ['unsafe']);
  assert.equal(unsafe.verdict.confidence, 0.87);

  const safe = parseSystemOneResponse(
    {
      answers: {
        safety: {
          probabilities: { safe: 0.91, unsafe: 0.09 },
        },
      },
    },
    { labelMode: 'binary' },
  );
  assert.equal(safe.verdict.violation, 0);
  assert.deepEqual(safe.verdict.categories, ['safe']);

  const invalid = parseSystemOneResponse(
    { answers: { safety: { choice: 'sexual', probabilities: { sexual: 0.6, violence: 0.4 } } } },
    { labelMode: 'binary' },
  );
  assert.equal(invalid.verdict, null);
  assert.match(invalid.error, /二分类选项非法/);
});

test('Cloudflare provider：binary 请求体与响应端到端', async () => {
  let requestBody = null;
  const provider = createCloudflareProvider({
    apiToken: 'test-token',
    accountId: 'test-account',
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            answers: {
              safety: {
                choice: 'unsafe',
                confidence: 0.8,
                probabilities: { safe: 0.2, unsafe: 0.8 },
              },
            },
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });

  const response = await provider.judge('这是一张图片', {
    labelMode: 'binary',
    images: [IMAGE],
  });
  assert.deepEqual(Object.keys(requestBody.questions), ['safety']);
  assert.equal(requestBody.questions.safety.criteria.unsafe !== undefined, true);
  assert.equal(requestBody.images.length, 1);
  assert.equal(response.verdict.violation, 1);
  assert.deepEqual(response.verdict.categories, ['unsafe']);
  assert.equal(response.error, null);
});

test('mock provider：binary 模式只输出 safe / unsafe', async () => {
  const provider = createMockProvider({ latencyScale: 0 });
  const safe = await provider.judge('今天天气不错', { labelMode: 'binary' });
  assert.deepEqual(safe.verdict.categories, ['safe']);
  const unsafe = await provider.judge('出售毒品和枪支', { labelMode: 'binary' });
  assert.equal(unsafe.verdict.violation, 1);
  assert.deepEqual(unsafe.verdict.categories, ['unsafe']);
});

test('数据集归一化：binary 模式接受 unsafe，taxonomy 模式拒绝', () => {
  const raw = {
    id: 'ub-0001',
    image: 'ub-0001.jpg',
    text: '请判断图片是否安全',
    source: 'unsafebench',
    gold: { violation: 1, categories: ['unsafe'] },
  };
  const binary = normalizeSample(raw, { labelMode: 'binary' });
  assert.deepEqual(binary.gold.categories, ['unsafe']);
  assert.equal(normalizeSample(raw), null);

  const safe = normalizeSample(
    { ...raw, gold: { violation: 0, categories: ['safe'] } },
    { labelMode: 'binary' },
  );
  assert.deepEqual(safe.gold.categories, ['safe']);
});

test('二分类指标：perCategory.unsafe 的 F1 即 binary F1', () => {
  const records = [
    {
      id: 'ub-0001',
      source: 'unsafebench',
      gold: { violation: false, categories: ['safe'] },
      prediction: { violation: 0, categories: ['safe'], confidence: 0.9 },
      correct: true,
      latencyMs: 100,
      tokens: { total: 10 },
    },
    {
      id: 'ub-0002',
      source: 'unsafebench',
      gold: { violation: true, categories: ['unsafe'] },
      prediction: { violation: 1, categories: ['unsafe'], confidence: 0.8 },
      correct: true,
      latencyMs: 120,
      tokens: { total: 12 },
    },
  ];
  const metrics = computeMetrics(records, { labelMode: 'binary' });
  assert.equal(metrics.binary.accuracy, 1);
  assert.equal(metrics.perCategory.unsafe.support, 1);
  assert.equal(metrics.perCategory.unsafe.predicted, 1);
  assert.equal(metrics.perCategory.unsafe.f1, 1);
  assert.equal(metrics.macroCategoryF1, 1);
  assert.equal(metrics.microCategoryF1, 1);
  assert.equal(metrics.perCategory.insult, undefined);
});
