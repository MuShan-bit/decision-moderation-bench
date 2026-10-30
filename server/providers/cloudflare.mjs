// Cloudflare Workers AI「决策模型」provider —— clef-omni。
// 文档：https://developers.cloudflare.com/workers-ai/models/clef-omni/
// 接口：POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/@cf/cloudflare/clef-omni
// 协议：与 TypeSafe System One 相同的 {model,state,questions} typed-decision 请求
//       （questions 支持 noul / choice / score；clef-omni 额外支持 images/audio/videos）。
// 鉴权：Authorization: Bearer <CLOUDFLARE_API_TOKEN>（Workers AI - Read/Edit 权限）。
// 响应：Cloudflare 标准信封 {result,success,errors,messages}，其中 result = {model,answers,usage}；
//       本 provider 复用 systemone.mjs，只负责拼 endpoint、校验凭据并去掉信封。
import { createSystemOneProvider, DEFAULT_TIMEOUT_MS } from './systemone.mjs';

/** Workers AI 模型选择器（请求体 model 字段必须为该值） */
export const DEFAULT_MODEL = 'clef-omni';
/** 模型在 Workers AI 路由中的完整名称 */
export const MODEL_PATH = '@cf/cloudflare/clef-omni';
export const DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4';

/** 由 accountId/baseUrl 拼 Workers AI run endpoint（已含 /ai/run/ 则视为完整 endpoint） */
export function buildCloudflareEndpoint({ accountId, baseUrl } = {}) {
  const base = String(baseUrl ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (!base) {
    throw new Error('CLOUDFLARE_BASE_URL 未配置，无法构造 Workers AI endpoint');
  }
  if (/\/ai\/run\//i.test(base)) return base;
  const account = String(accountId ?? '').trim();
  if (!account) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID 未配置，无法构造 Workers AI endpoint');
  }
  return `${base}/accounts/${encodeURIComponent(account)}/ai/run/${MODEL_PATH}`;
}

/**
 * 去掉 Cloudflare REST 信封，取出 {model,answers,usage}。
 * 失败响应（success=false / result=null）原样返回，交给上层报错文本提取。
 */
export function unwrapCloudflareResponse(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  if (data.success === false) return data;
  const result = data.result;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return result.answers ? result : data;
  }
  return data;
}

/**
 * 创建 Cloudflare Workers AI clef-omni provider。
 * @param {{
 *   apiToken?: string,
 *   apiKey?: string,
 *   accountId: string,
 *   baseUrl?: string,
 *   model?: string,
 *   timeoutMs?: number,
 *   maxRetries?: number,
 *   ensemble?: boolean,
 *   fetchImpl?: typeof fetch,
 *   concurrency?: number,
 * }} options
 */
export function createCloudflareProvider(options = {}) {
  const apiToken = String(options.apiToken ?? options.apiKey ?? '').trim();
  if (!apiToken) {
    throw new Error('CLOUDFLARE_API_TOKEN 未配置，无法创建 Cloudflare Workers AI provider');
  }
  const endpoint = buildCloudflareEndpoint({
    accountId: options.accountId,
    baseUrl: options.baseUrl,
  });
  return createSystemOneProvider({
    name: 'cloudflare',
    apiKey: apiToken,
    baseUrl: endpoint,
    model: String(options.model || DEFAULT_MODEL),
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    maxRetries: options.maxRetries,
    ensemble: options.ensemble,
    fetchImpl: options.fetchImpl,
    concurrency: options.concurrency,
    unwrap: unwrapCloudflareResponse,
  });
}
