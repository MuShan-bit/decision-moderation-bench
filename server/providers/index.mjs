// provider 工厂：systemone（百炼决策模型）、bamboonode（StartLux 决策模型）、jev（Jev 官方网关）、mock（离线演示）。
//
// 三个真实入口都用同一套 TypeSafe System One（typed-decision）协议：
//   POST <endpoint>/systemone  {model, state, questions}
// 区别只在 endpoint / API Key / 模型名：
//   - systemone  : 百炼「决策模型（预览版）」decision-model-preview（workspace 专属域名）
//   - bamboonode : https://api.bamboonode.dev/v1/systemone，模型 startlux-decision-27b-autothink
//   - jev        : https://jevmodel.org/v1/systemone，模型 jev-preview(1.14) / jev-latest(1.13)
//   - mock       : 本地规则模拟，永远标注 simulated
import { createSystemOneProvider, DEFAULT_MODEL as SYSTEMONE_MODEL, DEFAULT_TIMEOUT_MS } from './systemone.mjs';
import { createMockProvider } from './mock.mjs';
import {
  DEFAULT_BAMBOONODE_BASE_URL,
  DEFAULT_BAMBOONODE_MODELS,
  DEFAULT_JEVMODEL_BASE_URL,
  DEFAULT_JEVMODEL_MODELS,
} from '../lib/env.mjs';

export const PROVIDER_NAMES = Object.freeze(['systemone', 'bamboonode', 'jev', 'mock']);
export const MOCK_MODEL = 'mock-rule-v1';

export class ProviderConfigError extends Error {
  constructor(message, code = 'PROVIDER_CONFIG_ERROR') {
    super(message);
    this.name = 'ProviderConfigError';
    this.code = code;
  }
}

/** provider → 可用模型列表（用于前端级联筛选与后端校验） */
export function providerModels(cfg = {}) {
  const models = Array.isArray(cfg.models) && cfg.models.length ? cfg.models : [SYSTEMONE_MODEL];
  const bamboonodeModels =
    Array.isArray(cfg.bamboonodeModels) && cfg.bamboonodeModels.length
      ? cfg.bamboonodeModels
      : [...DEFAULT_BAMBOONODE_MODELS];
  const jevModels =
    Array.isArray(cfg.jevModels) && cfg.jevModels.length ? cfg.jevModels : [...DEFAULT_JEVMODEL_MODELS];
  return {
    systemone: [...models],
    bamboonode: [...bamboonodeModels],
    jev: [...jevModels],
    mock: [MOCK_MODEL],
  };
}

/** 把 http(s)://host/v1 归一成 systemone endpoint（已带 /systemone 则不动） */
export function buildDecisionEndpoint(baseUrl) {
  const trimmed = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /\/systemone$/i.test(trimmed) ? trimmed : `${trimmed}/systemone`;
}

function defaultModelFor(provider, map, cfg) {
  if (provider === 'mock') return MOCK_MODEL;
  if (provider === 'systemone') {
    return cfg.model && map.systemone.includes(cfg.model) ? cfg.model : map.systemone[0];
  }
  return map[provider]?.[0];
}

/**
 * 校验并解析 provider 对应的模型：
 * - 未指定模型时使用该 provider 的默认模型；
 * - 指定了但不在该 provider 的模型列表里 → 抛 MODEL_NOT_ALLOWED。
 * @param {'systemone'|'bamboonode'|'mock'} provider
 * @param {string|undefined|null} requested
 * @param {{models?: string[], model?: string, bamboonodeModels?: string[]}} cfg
 */
export function resolveModelForProvider(provider, requested, cfg = {}) {
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
 *   provider?: 'systemone'|'bamboonode'|'mock',
 *   model?: string,
 *   concurrency?: number,
 *   apiKey?: string,
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
  const name = options.provider || 'systemone';
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

  if (!apiKey) {
    throw new ProviderConfigError(
      'DASHSCOPE_API_KEY 未配置，无法使用真实 provider；请改用 mock，或在 .env 中配置真实 Key',
      'MISSING_API_KEY',
    );
  }

  const workspaceId = String(options.workspaceId ?? '').trim();
  const systemoneBaseUrl = String(options.systemoneBaseUrl ?? '').trim();
  if (!workspaceId && !systemoneBaseUrl) {
    throw new ProviderConfigError(
      'SYSTEMONE_WORKSPACE_ID 未配置，无法使用决策模型 provider（或直接配置 SYSTEMONE_BASE_URL）',
      'MISSING_WORKSPACE',
    );
  }

  return createSystemOneProvider({
    name: 'systemone',
    apiKey,
    workspaceId,
    region: options.region,
    baseUrl: systemoneBaseUrl,
    model: options.model || SYSTEMONE_MODEL,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    maxRetries: options.maxRetries,
    ensemble: options.ensemble,
    fetchImpl: options.fetchImpl,
    concurrency: options.concurrency,
  });
}

export {
  createSystemOneProvider,
  createMockProvider,
  DEFAULT_BAMBOONODE_BASE_URL,
  DEFAULT_BAMBOONODE_MODELS,
  DEFAULT_JEVMODEL_BASE_URL,
  DEFAULT_JEVMODEL_MODELS,
  SYSTEMONE_MODEL,
};
