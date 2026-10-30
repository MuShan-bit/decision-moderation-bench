// 配置 / .env 解析 单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDotEnv, getConfig, redactConfig, ROOT } from '../server/lib/env.mjs';
import path from 'node:path';

test('parseDotEnv：注释 / 空行 / 引号 / 行内注释', () => {
  const parsed = parseDotEnv(
    [
      '# comment',
      '',
      'A=1',
      'B = hello world ',
      'C="quoted value"',
      "D='single'",
      'E=value # inline comment',
      'INVALID LINE',
      '=nokey',
      'F=',
    ].join('\n'),
  );
  assert.equal(parsed.A, '1');
  assert.equal(parsed.B, 'hello world');
  assert.equal(parsed.C, 'quoted value');
  assert.equal(parsed.D, 'single');
  assert.equal(parsed.E, 'value');
  assert.equal(parsed.F, '');
  assert.equal(parsed['INVALID LINE'], undefined);
});

test('getConfig：默认值', () => {
  const cfg = getConfig({});
  assert.equal(cfg.port, 8788);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.provider, 'dashscope');
  assert.equal(cfg.effectiveProvider, 'mock'); // 无 key/workspace 自动回退
  assert.equal(cfg.model, 'decision-model-preview');
  assert.equal(cfg.timeoutMs, 20000);
  assert.equal(cfg.maxRetries, 3);
  assert.deepEqual(cfg.concurrencyOptions, [1, 2, 4, 8, 16]);
  assert.equal(cfg.resultsDir, path.join(ROOT, 'results'));
  assert.equal(cfg.datasetPath, path.join(ROOT, 'data', 'eval', 'samples.jsonl'));
  assert.equal(cfg.publicDir, path.join(ROOT, 'public'));
  assert.ok(cfg.models.includes('decision-model-preview'));
  assert.deepEqual(cfg.models, ['decision-model-preview']);
  assert.equal(cfg.workspaceConfigured, false);
  assert.equal(cfg.bamboonodeBaseUrl, 'https://api.bamboonode.dev/v1');
  assert.deepEqual(cfg.bamboonodeModels, ['startlux-decision-27b-autothink']);
  assert.equal(cfg.bamboonodeApiKeyConfigured, false);
  assert.equal(cfg.jevBaseUrl, 'https://api.typesafe.ai/v1');
  assert.deepEqual(cfg.jevModels, ['jev-preview', 'jev-latest']);
  assert.equal(cfg.jevApiKeyConfigured, false);
  assert.equal(cfg.cloudflareBaseUrl, 'https://api.cloudflare.com/client/v4');
  assert.deepEqual(cfg.cloudflareModels, ['clef-omni']);
  assert.equal(cfg.cloudflareApiTokenConfigured, false);
  assert.equal(cfg.cloudflareAccountIdConfigured, false);
});

test('getConfig：DATASET 档案选择与未知值回退', () => {
  assert.equal(getConfig({}).dataset, 'text');
  const textImage = getConfig({ DATASET: 'text-image' });
  assert.equal(textImage.dataset, 'text-image');
  assert.equal(textImage.datasetPath, path.join(ROOT, 'data', 'images', 'samples.jsonl'));
  assert.equal(textImage.imagesDir, path.join(ROOT, 'data', 'images'));
  assert.equal(textImage.datasetEnvError, null);

  const nsfw = getConfig({ DATASET: 'nsfw-image' });
  assert.equal(nsfw.dataset, 'nsfw-image');
  assert.equal(nsfw.imagesDir, path.join(ROOT, 'data', 'real-images'));

  // DATASET_PATH 优先于 DATASET（未知档案只告警，不改变显式路径）
  const custom = getConfig({ DATASET: 'text-image', DATASET_PATH: 'tmp/data.jsonl' });
  assert.equal(custom.datasetPath, path.resolve(ROOT, 'tmp/data.jsonl'));
  assert.equal(custom.dataset, 'custom');
  assert.equal(custom.imagesDir, path.dirname(path.resolve(ROOT, 'tmp/data.jsonl')));

  const unknown = getConfig({ DATASET: 'not-a-dataset' });
  assert.equal(unknown.dataset, 'text');
  assert.match(unknown.datasetEnvError, /未知 DATASET/);
});

test('getConfig：从 env 覆盖 + 模型补齐', () => {
  const cfg = getConfig({
    DASHSCOPE_API_KEY: 'sk-test-123',
    MODERATION_MODEL: 'custom-chat-model',
    MODERATION_MODELS: 'custom-chat-model,custom-chat-2',
    MODERATION_PROVIDER: 'mock',
    PORT: '9001',
    HOST: '0.0.0.0',
    RESULTS_DIR: 'tmp-results',
    DATASET_PATH: 'tmp/data.jsonl',
    MOCK_LATENCY_SCALE: '0',
  });
  assert.equal(cfg.port, 9001);
  assert.equal(cfg.host, '0.0.0.0');
  assert.equal(cfg.provider, 'mock');
  assert.equal(cfg.effectiveProvider, 'mock');
  assert.equal(cfg.model, 'custom-chat-model');
  assert.deepEqual(cfg.models, ['custom-chat-model', 'custom-chat-2']);
  assert.equal(cfg.apiKeyConfigured, true);
  assert.equal(cfg.bamboonodeApiKeyConfigured, false);
  assert.equal(cfg.mockLatencyScale, 0);
  assert.equal(cfg.resultsDir, path.resolve(ROOT, 'tmp-results'));
  assert.equal(cfg.datasetPath, path.resolve(ROOT, 'tmp/data.jsonl'));
});

test('getConfig：bamboonode provider / key / 模型列表', () => {
  const cfg = getConfig({
    MODERATION_PROVIDER: 'bamboonode',
    BAMBOONODE_API_KEY: 'bn-test-key',
    BAMBOONODE_BASE_URL: 'https://api.bamboonode.dev/v1/',
    BAMBOONODE_MODELS: 'typesafe/jev-1.13, typesafe/jev-1.14',
  });
  assert.equal(cfg.provider, 'bamboonode');
  assert.equal(cfg.effectiveProvider, 'bamboonode');
  assert.equal(cfg.bamboonodeApiKeyConfigured, true);
  assert.equal(cfg.bamboonodeBaseUrl, 'https://api.bamboonode.dev/v1');
  assert.deepEqual(cfg.bamboonodeModels, ['typesafe/jev-1.13', 'typesafe/jev-1.14']);

  // 显式 bamboonode 但没有 key → 回退 mock（前端仍会给出明确配置错误）
  const fallback = getConfig({ MODERATION_PROVIDER: 'bamboonode' });
  assert.equal(fallback.effectiveProvider, 'mock');
});

test('getConfig：jev 官方网关 key / provider 回退', () => {
  const cfg = getConfig({
    MODERATION_PROVIDER: 'jev',
    JEVMODEL_API_KEY: 'jevm-test-key',
    JEVMODEL_BASE_URL: 'https://api.typesafe.ai/v1/',
    JEVMODEL_MODELS: 'jev-latest',
  });
  assert.equal(cfg.provider, 'jev');
  assert.equal(cfg.effectiveProvider, 'jev');
  assert.equal(cfg.jevApiKeyConfigured, true);
  assert.equal(cfg.jevBaseUrl, 'https://api.typesafe.ai/v1');
  assert.deepEqual(cfg.jevModels, ['jev-latest']);

  const fallback = getConfig({ MODERATION_PROVIDER: 'jev' });
  assert.equal(fallback.effectiveProvider, 'mock');
});

test('getConfig：cloudflare Workers AI token / account / provider 回退', () => {
  const cfg = getConfig({
    MODERATION_PROVIDER: 'cloudflare',
    CLOUDFLARE_API_TOKEN: 'cf-test-token',
    CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    CLOUDFLARE_BASE_URL: 'https://api.cloudflare.com/client/v4/',
    CLOUDFLARE_MODELS: 'clef-omni',
  });
  assert.equal(cfg.provider, 'cloudflare');
  assert.equal(cfg.effectiveProvider, 'cloudflare');
  assert.equal(cfg.cloudflareApiTokenConfigured, true);
  assert.equal(cfg.cloudflareAccountIdConfigured, true);
  assert.equal(cfg.cloudflareBaseUrl, 'https://api.cloudflare.com/client/v4');
  assert.deepEqual(cfg.cloudflareModels, ['clef-omni']);

  // 显式 cloudflare 但缺 token 或 account → 回退 mock（前端仍会给出明确配置错误）
  assert.equal(getConfig({ MODERATION_PROVIDER: 'cloudflare' }).effectiveProvider, 'mock');
  assert.equal(
    getConfig({ MODERATION_PROVIDER: 'cloudflare', CLOUDFLARE_API_TOKEN: 't' }).effectiveProvider,
    'mock',
  );
  // CLOUDFLARE_AUTH_TOKEN 作为兼容别名
  const alias = getConfig({
    MODERATION_PROVIDER: 'cloudflare',
    CLOUDFLARE_AUTH_TOKEN: 'cf-auth-token',
    CLOUDFLARE_ACCOUNT_ID: 'acc',
  });
  assert.equal(alias.effectiveProvider, 'cloudflare');
  assert.equal(alias.cloudflareApiTokenConfigured, true);
});

test('redactConfig 不泄露 apiKey', () => {
  const cfg = getConfig({
    DASHSCOPE_API_KEY: 'sk-super-secret',
    BAMBOONODE_API_KEY: 'bn-super-secret',
    JEVMODEL_API_KEY: 'jevm-super-secret',
    CLOUDFLARE_API_TOKEN: 'cf-super-secret',
    CLOUDFLARE_ACCOUNT_ID: 'cf-account-secret',
  });
  const redacted = redactConfig(cfg);
  assert.ok(!JSON.stringify(redacted).includes('sk-super-secret'));
  assert.ok(!JSON.stringify(redacted).includes('bn-super-secret'));
  assert.ok(!JSON.stringify(redacted).includes('jevm-super-secret'));
  assert.ok(!JSON.stringify(redacted).includes('cf-super-secret'));
  assert.ok(!JSON.stringify(redacted).includes('cf-account-secret'));
  assert.equal(redacted.apiKeyConfigured, true);
  assert.equal(redacted.bamboonodeApiKeyConfigured, true);
  assert.equal(redacted.jevApiKeyConfigured, true);
  assert.equal(redacted.cloudflareApiTokenConfigured, true);
  assert.equal(redacted.cloudflareAccountIdConfigured, true);
});
