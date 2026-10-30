// Cloudflare Workers AI clef-omni provider 单元测试：endpoint 拼接、响应信封解包、裁决归一化与错误文本。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCloudflareEndpoint,
  createCloudflareProvider,
  unwrapCloudflareResponse,
  DEFAULT_MODEL,
  MODEL_PATH,
} from '../server/providers/cloudflare.mjs';

const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('buildCloudflareEndpoint：默认拼 Workers AI run endpoint', () => {
  assert.equal(
    buildCloudflareEndpoint({ accountId: ACCOUNT_ID }),
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${MODEL_PATH}`,
  );
  // 自定义 baseUrl 会去掉尾部斜杠
  assert.equal(
    buildCloudflareEndpoint({ accountId: ACCOUNT_ID, baseUrl: 'https://proxy.example.com/client/v4/' }),
    `https://proxy.example.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${MODEL_PATH}`,
  );
  // 已是完整 endpoint 时原样返回
  const full = 'https://proxy.example.com/ai/run/@cf/cloudflare/clef-omni';
  assert.equal(buildCloudflareEndpoint({ accountId: ACCOUNT_ID, baseUrl: full }), full);
  assert.throws(() => buildCloudflareEndpoint({}), /CLOUDFLARE_ACCOUNT_ID/);
});

test('unwrapCloudflareResponse：去掉 {result,success,errors,messages} 信封', () => {
  const result = { model: DEFAULT_MODEL, answers: {}, usage: { input_tokens: 1, output_tokens: 0 } };
  assert.deepEqual(
    unwrapCloudflareResponse({ result, success: true, errors: [], messages: [] }),
    result,
  );
  // 失败响应原样返回，供错误文本提取
  const failure = { result: null, success: false, errors: [{ code: 10000, message: 'Authentication error' }] };
  assert.deepEqual(unwrapCloudflareResponse(failure), failure);
  // 非信封结构原样返回
  assert.deepEqual(unwrapCloudflareResponse({ answers: {} }), { answers: {} });
  assert.equal(unwrapCloudflareResponse(null), null);
});

test('cloudflare provider：请求 Workers AI endpoint 并把 answers 归一化为裁决', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({
      result: {
        model: 'clef-omni',
        answers: {
          category: {
            type: 'choice',
            choice: 'insult',
            probabilities: {
              safe: 0.05,
              insult: 0.8,
              hate: 0.05,
              sexual: 0.02,
              violence: 0.02,
              illegal: 0.03,
              spam: 0.02,
              privacy: 0.01,
            },
            confidence: 0.8,
          },
          severity: {
            type: 'score',
            score: 2.2,
            legend: { 0: '正常', 1: '轻微', 2: '明显', 3: '严重' },
            probabilities: { 0: 0.05, 1: 0.15, 2: 0.7, 3: 0.1 },
            confidence: 0.7,
          },
          attack: { type: 'noul', noul: 0.9 },
          harmful: { type: 'noul', noul: 0.1 },
        },
        usage: { input_tokens: 250, output_tokens: 0 },
      },
      success: true,
      errors: [],
      messages: [],
    });
  };

  const provider = createCloudflareProvider({
    apiToken: 'cf-test-token',
    accountId: ACCOUNT_ID,
    fetchImpl,
  });
  const out = await provider.judge('你这个蠢货，真是个废物。');

  assert.equal(provider.name, 'cloudflare');
  assert.equal(provider.model, 'clef-omni');
  assert.equal(provider.simulated, false);
  assert.equal(out.parseError, false);
  assert.equal(out.error, null);
  assert.equal(out.simulated, false);
  assert.deepEqual(out.verdict.categories, ['insult']);
  assert.equal(out.verdict.violation, 1);
  assert.equal(out.verdict.severity, 2);
  assert.equal(out.verdict.confidence, 0.8);
  assert.equal(out.tokens.prompt, 250);
  assert.equal(out.tokens.completion, 0);
  assert.equal(out.tokens.total, 250);
  assert.equal(out.attempts, 1);

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${MODEL_PATH}`,
  );
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer cf-test-token');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'clef-omni');
  assert.equal(body.state, '你这个蠢货，真是个废物。');
  assert.deepEqual(Object.keys(body.questions).sort(), ['attack', 'category', 'harmful', 'severity']);
  // choice 的问题必须带 2-255 个选项（clef-omni 输入 schema 要求）
  assert.equal(Object.keys(body.questions.category.criteria).length, 8);
  assert.equal(body.questions.severity.criteria.length, 4);
});

test('cloudflare provider：Cloudflare 错误信封的 message 进入错误文本且不重试 4xx', async () => {
  let calls = 0;
  const provider = createCloudflareProvider({
    apiToken: 'bad-token',
    accountId: ACCOUNT_ID,
    maxRetries: 3,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(
        {
          result: null,
          success: false,
          errors: [{ code: 10000, message: 'Authentication error' }],
          messages: [],
        },
        401,
      );
    },
  });
  const out = await provider.judge('测试文本');
  assert.equal(out.verdict, null);
  assert.equal(out.parseError, false);
  assert.equal(out.status, 401);
  assert.match(out.error, /Authentication error/);
  assert.equal(calls, 1);
});

test('cloudflare provider：HTTP 200 但 success=false 时返回真实错误而不是解析失败', async () => {
  const provider = createCloudflareProvider({
    apiToken: 'token',
    accountId: ACCOUNT_ID,
    fetchImpl: async () =>
      jsonResponse({
        result: null,
        success: false,
        errors: [{ code: 3040, message: 'Model execution failed' }],
        messages: [],
      }),
  });
  const out = await provider.judge('测试文本');
  assert.equal(out.verdict, null);
  assert.equal(out.status, 200);
  assert.match(out.error, /Model execution failed/);
});

test('cloudflare provider：缺少 token 时给出明确错误', () => {
  assert.throws(
    () => createCloudflareProvider({ accountId: ACCOUNT_ID }),
    /CLOUDFLARE_API_TOKEN/,
  );
});
