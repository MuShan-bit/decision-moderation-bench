// provider 工厂：dashscope（百炼 DashScope 决策模型）、bamboonode（StartLux 决策模型）、jev（Jev 官方网关）、
// cloudflare（Cloudflare Workers AI clef-omni）、mock（离线演示）。
//
// 四个真实入口都用同一套 TypeSafe System One（typed-decision）协议：
//   POST <endpoint>  {model, state, questions}
// 区别只在 endpoint / API Key / 模型名：
//   - dashscope  : 百炼 DashScope「决策模型（预览版）」decision-model-preview（workspace 专属域名）
//   - bamboonode : https://api.bamboonode.dev/v1/systemone，模型 startlux-decision-27b-autothink
//   - jev        : https://api.typesafe.ai/v1/systemone，模型 jev-preview(1.14) / jev-latest(1.13)
//   - cloudflare : https://api.cloudflare.com/client/v4/accounts/{id}/ai/run/@cf/cloudflare/clef-omni
//                  模型 clef-omni，响应包在 {result,success,errors,messages} 信封里
//   - mock       : 本地规则模拟，永远标注 simulated
import { createSystemOneProvider, DEFAULT_MODEL as DASHSCOPE_MODEL, DEFAULT_TIMEOUT_MS } from './systemone.mjs';
import {
  createCloudflareProvider,
  DEFAULT_BASE_URL as DEFAULT_CLOUDFLARE_BASE_URL,
  DEFAULT_MODEL as CLOUDFLARE_MODEL,
  MODEL_PATH as CLOUDFLARE_MODEL_PATH,
} from './cloudflare.mjs';
import { createMockProvider } from './mock.mjs';
import {
  DEFAULT_BAMBOONODE_BASE_URL,
  DEFAULT_BAMBOONODE_MODELS,
  DEFAULT_CLOUDFLARE_MODELS,
  DEFAULT_JEVMODEL_BASE_URL,
  DEFAULT_JEVMODEL_MODELS,
} from '../lib/env.mjs';

export const PROVIDER_NAMES = Object.freeze(['dashscope', 'bamboonode', 'jev', 'cloudflare', 'mock']);
export const MOCK_MODEL = 'mock-rule-v1';
const PROVIDER_ALIASES = Object.freeze({ systemone: 'dashscope' });

/** 兼容旧配置：历史 provider 名 systemone 统一归一为 dashscope。 */
export function normalizeProviderName(provider) {
  const name = String(provider ?? '').trim();
  return PROVIDER_ALIASES[name] || name;
}

export class ProviderConfigError extends Error {
  constructor(message, code = 'PROVIDER_CONFIG_ERROR') {
    super(message);
    this.name = 'ProviderConfigError';
    this.code = code;
  }
}

/** provider → 可用模型列表（用于前端级联筛选与后端校验） */
export function providerModels(cfg = {}) {
  const models = Array.isArray(cfg.models) && cfg.models.length ? cfg.models : [DASHSCOPE_MODEL];
  const bamboonodeModels =
    Array.isArray(cfg.bamboonodeModels) && cfg.bamboonodeModels.length
      ? cfg.bamboonodeModels
      : [...DEFAULT_BAMBOONODE_MODELS];
  const jevModels =
    Array.isArray(cfg.jevModels) && cfg.jevModels.length ? cfg.jevModels : [...DEFAULT_JEVMODEL_MODELS];
  const cloudflareModels =
    Array.isArray(cfg.cloudflareModels) && cfg.cloudflareModels.length
      ? cfg.cloudflareModels
      : [...DEFAULT_CLOUDFLARE_MODELS];
  return {
    dashscope: [...models],
    bamboonode: [...bamboonodeModels],
    jev: [...jevModels],
    cloudflare: [...cloudflareModels],
    mock: [MOCK_MODEL],
  };
}

/** 把 http(s)://host/v1 归一成 System One endpoint（已带 /systemone 则不动） */
export function buildDecisionEndpoint(baseUrl) {
  const trimmed = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /\/systemone$/i.test(trimmed) ? trimmed : `${trimmed}/systemone`;
}

function defaultModelFor(provider, map, cfg) {
  if (provider === 'mock') return MOCK_MODEL;
  if (provider === 'dashscope') {
    return cfg.model && map.dashscope.includes(cfg.model) ? cfg.model : map.dashscope[0];
  }
  return map[provider]?.[0];
}

/**
 * 校验并解析 provider 对应的模型：
 * - 未指定模型时使用该 provider 的默认模型；
 * - 指定了但不在该 provider 的模型列表里 → 抛 MODEL_NOT_ALLOWED。
 * @param {'dashscope'|'bamboonode'|'jev'|'mock'} provider
 * @param {string|undefined|null} requested
 * @param {{models?: string[], model?: string, bamboonodeModels?: string[]}} cfg
 */
export function resolveModelForProvider(provider, requested, cfg = {}) {
  provider = normalizeProviderName(provider);
  if (!PROVIDER_NAMES.includes(provider)) {
    throw new ProviderConfigError(
      `不支持的 provider：${provider}（可选 ${PROVIDER_NAMES.join(' / ')}）`,
      'UNKNOWN_PROVIDER',
    );
  }
  const map = providerModels(cfg);
  const allowed = map[provider] || [];
  const wanted = String(requested ?? '').trim();
  if (!wanted) {
    const fallback = defaultModelFor(provider, map, cfg);
    if (fallback) return fallback;
    throw new ProviderConfigError(`provider ${provider} 没有可用模型`, 'MODEL_NOT_ALLOWED');
  }
  if (!allowed.includes(wanted)) {
    throw new ProviderConfigError(
      `provider ${provider} 不支持模型 ${wanted}（可选：${allowed.join(' / ')}）`,
      'MODEL_NOT_ALLOWED',
    );
  }
  return wanted;
}

/**
 * 创建 provider 实例。
 * @param {{
 *   provider?: 'dashscope'|'bamboonode'|'jev'|'cloudflare'|'mock',
 *   model?: string,
 *   concurrency?: number,
 *   apiKey?: string,
 *   apiToken?: string,
 *   accountId?: string,
 *   workspaceId?: string,
 *   region?: string,
 *   systemoneBaseUrl?: string,
 *   baseUrl?: string,
 *   timeoutMs?: number,
 *   maxRetries?: number,
 *   latencyScale?: number,
 *   fetchImpl?: typeof fetch,
 * }} options
 */
export function createProvider(options = {}) {
  const name = normalizeProviderName(options.provider || 'dashscope');
  if (!PROVIDER_NAMES.includes(name)) {
    throw new ProviderConfigError(
      `不支持的 provider：${name}（可选 ${PROVIDER_NAMES.join(' / ')}）`,
      'UNKNOWN_PROVIDER',
    );
  }

  if (name === 'mock') {
    return createMockProvider({
      latencyScale: options.latencyScale,
    });
  }

  const apiKey = String(options.apiKey ?? '').trim();

  if (name === 'bamboonode' || name === 'jev') {
    const isJev = name === 'jev';
    const keyName = isJev ? 'JEVMODEL_API_KEY' : 'BAMBOONODE_API_KEY';
    const baseName = isJev ? 'JEVMODEL_BASE_URL' : 'BAMBOONODE_BASE_URL';
    const defaultBase = isJev ? DEFAULT_JEVMODEL_BASE_URL : DEFAULT_BAMBOONODE_BASE_URL;
    const defaultModel = isJev ? DEFAULT_JEVMODEL_MODELS[0] : DEFAULT_BAMBOONODE_MODELS[0];
    if (!apiKey) {
      throw new ProviderConfigError(
        `${keyName} 未配置，无法使用${isJev ? ' Jev 官方网关' : ' StartLux / bamboonode'}；请在 .env 中配置 Key`,
        'MISSING_API_KEY',
      );
    }
    const endpoint = buildDecisionEndpoint(options.baseUrl || defaultBase);
    if (!endpoint) {
      throw new ProviderConfigError(`${baseName} 未配置，无法使用 ${name} provider`, 'MISSING_BASE_URL');
    }
    return createSystemOneProvider({
      name,
      apiKey,
      baseUrl: endpoint,
      model: options.model || defaultModel,
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      maxRetries: options.maxRetries,
      ensemble: options.ensemble,
      fetchImpl: options.fetchImpl,
      concurrency: options.concurrency,
    });
  }

  if (name === 'cloudflare') {
    const apiToken = String(options.apiToken ?? options.apiKey ?? '').trim();
    if (!apiToken) {
      throw new ProviderConfigError(
        'CLOUDFLARE_API_TOKEN 未配置，无法使用 Cloudflare Workers AI；请在 .env 中配置 API Token',
        'MISSING_API_KEY',
      );
    }
    const accountId = String(options.accountId ?? '').trim();
    if (!accountId) {
      throw new ProviderConfigError(
        'CLOUDFLARE_ACCOUNT_ID 未配置，无法使用 Cloudflare Workers AI；请在 .env 中配置 Account ID',
        'MISSING_ACCOUNT_ID',
      );
    }
    return createCloudflareProvider({
      apiToken,
      accountId,
      baseUrl: options.baseUrl,
      model: options.model || CLOUDFLARE_MODEL,
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      maxRetries: options.maxRetries,
      ensemble: options.ensemble,
      fetchImpl: options.fetchImpl,
      concurrency: options.concurrency,
    });
  }

  if (!apiKey) {
    throw new ProviderConfigError(
      'DASHSCOPE_API_KEY 未配置，无法使用 dashscope；请改用 mock，或在 .env 中配置真实 Key',
      'MISSING_API_KEY',
    );
  }

  const workspaceId = String(options.workspaceId ?? '').trim();
  const systemoneBaseUrl = String(options.systemoneBaseUrl ?? '').trim();
  if (!workspaceId && !systemoneBaseUrl) {
    throw new ProviderConfigError(
      'SYSTEMONE_WORKSPACE_ID 未配置，无法使用 dashscope（或直接配置 SYSTEMONE_BASE_URL）',
      'MISSING_WORKSPACE',
    );
  }

  return createSystemOneProvider({
    name: 'dashscope',
    apiKey,
    workspaceId,
    region: options.region,
    baseUrl: systemoneBaseUrl,
    model: options.model || DASHSCOPE_MODEL,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    maxRetries: options.maxRetries,
    ensemble: options.ensemble,
    fetchImpl: options.fetchImpl,
    concurrency: options.concurrency,
  });
}

export {
  createSystemOneProvider,
  createCloudflareProvider,
  createMockProvider,
  DEFAULT_BAMBOONODE_BASE_URL,
  DEFAULT_BAMBOONODE_MODELS,
  DEFAULT_CLOUDFLARE_BASE_URL,
  DEFAULT_CLOUDFLARE_MODELS,
  DEFAULT_JEVMODEL_BASE_URL,
  DEFAULT_JEVMODEL_MODELS,
  CLOUDFLARE_MODEL,
  CLOUDFLARE_MODEL_PATH,
  DASHSCOPE_MODEL,
};
