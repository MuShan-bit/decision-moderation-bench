// provider 工厂、Provider→Model 级联与 System One payload 的单元测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVIDER_NAMES,
  MOCK_MODEL,
  providerModels,
  resolveModelForProvider,
  buildDecisionEndpoint,
  createProvider,
  ProviderConfigError,
} from '../server/providers/index.mjs';
import { buildSystemOnePayload } from '../server/providers/systemone.mjs';
import { DEFAULT_BAMBOONODE_MODELS, DEFAULT_JEVMODEL_MODELS } from '../server/lib/env.mjs';

const CFG = {
  models: ['decision-model-preview'],
  model: 'decision-model-preview',
  bamboonodeModels: ['startlux-decision-27b-autothink'],
  jevModels: ['jev-preview', 'jev-latest'],
};

const isProviderError = (code) => (error) => error instanceof ProviderConfigError && error.code === code;

test('provider 列表：systemone + bamboonode + jev + mock', () => {
  assert.deepEqual([...PROVIDER_NAMES], ['systemone', 'bamboonode', 'jev', 'mock']);
});

test('providerModels 给出级联映射', () => {
  assert.deepEqual(providerModels(CFG), {
    systemone: ['decision-model-preview'],
    bamboonode: ['startlux-decision-27b-autothink'],
    jev: ['jev-preview', 'jev-latest'],
    mock: ['mock-rule-v1'],
  });
  // 未传外部模型时使用默认网关模型
  assert.deepEqual(providerModels({ models: ['x'] }).bamboonode, [...DEFAULT_BAMBOONODE_MODELS]);
  assert.deepEqual(providerModels({ models: ['x'] }).jev, [...DEFAULT_JEVMODEL_MODELS]);
});

test('resolveModelForProvider：缺省取该 provider 的默认模型', () => {
  assert.equal(resolveModelForProvider('systemone', '', CFG), 'decision-model-preview');
  assert.equal(resolveModelForProvider('bamboonode', '', CFG), 'startlux-decision-27b-autothink');
  assert.equal(resolveModelForProvider('jev', '', CFG), 'jev-preview');
  assert.equal(resolveModelForProvider('mock', '', CFG), MOCK_MODEL);
});

test('resolveModelForProvider：拒绝跨 provider 的模型组合', () => {
  assert.throws(
    () => resolveModelForProvider('mock', 'decision-model-preview', CFG),
    isProviderError('MODEL_NOT_ALLOWED'),
  );
  assert.throws(
    () => resolveModelForProvider('systemone', 'mock-rule-v1', CFG),
    isProviderError('MODEL_NOT_ALLOWED'),
  );
  assert.throws(
    () => resolveModelForProvider('bamboonode', 'decision-model-preview', CFG),
    isProviderError('MODEL_NOT_ALLOWED'),
  );
  assert.throws(
    () => resolveModelForProvider('jev', 'startlux-decision-27b-autothink', CFG),
    isProviderError('MODEL_NOT_ALLOWED'),
  );
  assert.throws(() => resolveModelForProvider('dashscope', '', CFG), isProviderError('UNKNOWN_PROVIDER'));
});

test('buildDecisionEndpoint：/v1 补 /systemone，已带则不重复', () => {
  assert.equal(
    buildDecisionEndpoint('https://api.bamboonode.dev/v1/'),
    'https://api.bamboonode.dev/v1/systemone',
  );
  assert.equal(
    buildDecisionEndpoint('https://api.bamboonode.dev/v1/systemone'),
    'https://api.bamboonode.dev/v1/systemone',
  );
  assert.equal(buildDecisionEndpoint(''), '');
});

test('createProvider：jev 使用官方网关 key / endpoint / 模型', () => {
  const provider = createProvider({
    provider: 'jev',
    apiKey: 'jevm-test',
    baseUrl: 'https://api.typesafe.ai/v1',
    model: 'jev-preview',
  });
  assert.equal(provider.name, 'jev');
  assert.equal(provider.model, 'jev-preview');
  assert.equal(provider.endpoint, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(provider.simulated, false);
});

test('createProvider：bamboonode 使用网关 key / endpoint / 模型', () => {
  const provider = createProvider({
    provider: 'bamboonode',
    apiKey: 'sk-test',
    baseUrl: 'https://api.bamboonode.dev/v1',
    model: 'typesafe/jev-1.14',
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => '' }),
  });
  assert.equal(provider.name, 'bamboonode');
  assert.equal(provider.model, 'typesafe/jev-1.14');
  assert.equal(provider.endpoint, 'https://api.bamboonode.dev/v1/systemone');
  assert.equal(provider.simulated, false);
});

test('createProvider：缺 key/workspace 给出明确错误码', () => {
  assert.throws(() => createProvider({ provider: 'dashscope' }), isProviderError('UNKNOWN_PROVIDER'));
  assert.throws(() => createProvider({ provider: 'systemone', apiKey: '' }), isProviderError('MISSING_API_KEY'));
  assert.throws(
    () => createProvider({ provider: 'systemone', apiKey: 'sk-test' }),
    isProviderError('MISSING_WORKSPACE'),
  );
  assert.throws(
    () => createProvider({ provider: 'bamboonode', apiKey: '' }),
    isProviderError('MISSING_API_KEY'),
  );
  assert.throws(() => createProvider({ provider: 'jev', apiKey: '' }), isProviderError('MISSING_API_KEY'));
});

test('createProvider：mock 不依赖 key，模型固定为 mock-rule-v1', () => {
  const provider = createProvider({ provider: 'mock' });
  assert.equal(provider.name, 'mock');
  assert.equal(provider.model, MOCK_MODEL);
  assert.equal(provider.simulated, true);
});

test('System One payload 的 model 可覆盖，问题数随 ensemble 变化', () => {
  const ensemble = buildSystemOnePayload('测试文本', { model: 'typesafe/jev-1.14' });
  assert.equal(ensemble.model, 'typesafe/jev-1.14');
  assert.equal(ensemble.state, '测试文本');
  assert.deepEqual(Object.keys(ensemble.questions).sort(), ['attack', 'category', 'harmful', 'severity']);

  const pure = buildSystemOnePayload('测试文本', { ensemble: false, model: 'x' });
  assert.deepEqual(Object.keys(pure.questions).sort(), ['category', 'severity']);
  assert.equal(pure.model, 'x');
});
