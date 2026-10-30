// 阿里云百炼 DashScope「决策模型（预览版）」provider —— TypeSafe System One 协议。
// 接口：POST https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1/systemone
// 特点：一次前向完成分类/评分（不生成文本），返回概率分布与置信度；用于内容审核判定。
// 契约：与 mock provider 相同（name/model/simulated/judge）。
import { createLimiter, sleep, abortError } from '../lib/limiter.mjs';
import { TAXONOMY, CATEGORY_LABELS } from '../moderation.mjs';

export const DEFAULT_MODEL = 'decision-model-preview';
export const DEFAULT_REGION = 'cn-beijing';
export const DEFAULT_TIMEOUT_MS = 20000;
export const RETRY_DELAYS_MS = Object.freeze([500, 1500, 3000]);
const MAX_JITTER_MS = 220;
const MAX_RETRY_AFTER_MS = 10000;

/** 分类问题选项：code -> 中文判定说明 */
const CATEGORY_CRITERIA = Object.freeze(
  Object.fromEntries(TAXONOMY.map((t) => [t.code, `${t.label}：${t.description}`])),
);

/** 严重度 4 级（score 类型） */
const SEVERITY_CRITERIA = Object.freeze([
  '正常，不违规',
  '轻微：轻度冒犯、边缘低俗或单条无扩散性的推广',
  '明显：明确的辱骂/歧视/色情/违法/垃圾广告内容',
  '严重：暴力威胁、严重违法教唆、高危或大规模传播内容',
]);

/** 根据模态（纯文本 / 图片）生成 instructions；图片模式下要求先识别图中文字再判定 */
function buildCategoryInstructions(imageMode) {
  return [
    imageMode
      ? '对这张待审核图片做内容安全分类，先识别图片中的文字/画面内容，只选一个最贴切的类别。判定原则：'
      : '对这条待审核文本做内容安全分类，只选一个最贴切的类别。判定原则：',
    '1) 直接或间接的辱骂、嘲讽、阴阳怪气、贬低人格/外貌/智力的评论属于 insult；',
    '2) 对性别、地域、种族、宗教、职业等群体的贬低、仇恨、煽动对立属于 hate；',
    '3) 请求、询问、教唆如何实施违法行为或购买违禁品（即使以提问形式）属于 illegal；',
    '4) 暴力威胁、血腥伤害、自残自杀内容属于 violence；',
    '5) 含联系方式、引流、刷单、推广话术，即使有错别字/谐音/乱码变体也属于 spam；',
    '6) 新闻转述、举报、学术讨论、引述他人观点等仅“提及”违规内容不判违规；',
    '7) 完全正常、无攻击或违规风险的内容选 safe。',
  ].join('');
}

function buildSeverityInstructions(imageMode) {
  return imageMode
    ? '这张图片的违规严重程度如何？（正常内容选 0 级）'
    : '该文本的违规严重程度如何？（正常内容选 0 级）';
}

function buildAttackInstructions(imageMode) {
  return imageMode
    ? '这张图片中的内容是否在攻击、贬低、嘲讽或冒犯某个人或群体（包括阴阳怪气、暗讽、人身攻击）？'
    : '这段文本是否在攻击、贬低、嘲讽或冒犯某个人或群体（包括阴阳怪气、暗讽、人身攻击）？';
}

function buildHarmfulInstructions(imageMode) {
  return imageMode
    ? '这张图片是否在请求、询问或教唆实施违法/危险行为，或涉及违禁品交易？'
    : '这段文本是否在请求、询问或教唆实施违法/危险行为，或涉及违禁品交易？';
}

/** 图片输入归一化：仅保留 {content_type, base64} 字符串，空值忽略 */
export function normalizeImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .filter((image) => image && typeof image === 'object')
    .map((image) => ({
      content_type:
        typeof image.content_type === 'string' && image.content_type.trim()
          ? image.content_type.trim()
          : 'image/png',
      base64: typeof image.base64 === 'string' ? image.base64.trim() : '',
    }))
    .filter((image) => image.base64.length > 0);
}

/** 后处理阈值：category 的违规类别概率 / attack / harmful 达到阈值即判为对应违规 */
export const ENSEMBLE_THRESHOLDS = Object.freeze({
  categoryProb: 0.35,
  attack: 0.6,
  harmful: 0.6,
});

/**
 * 构造 System One 请求体（导出便于测试）。
 * ensemble=false 时只问 category+severity（纯 argmax 模式）；
 * options.images 非空时按 clef-omni 多模态协议附带图片，并把 instructions 切换为图片措辞。
 */
export function buildSystemOnePayload(text, options = {}) {
  const images = normalizeImages(options.images);
  const imageMode = images.length > 0;
  const questions = {
    category: {
      type: 'choice',
      instructions: buildCategoryInstructions(imageMode),
      criteria: { ...CATEGORY_CRITERIA },
    },
    severity: {
      type: 'score',
      instructions: buildSeverityInstructions(imageMode),
      criteria: [...SEVERITY_CRITERIA],
    },
  };
  if (options.ensemble !== false) {
    questions.attack = { type: 'noul', instructions: buildAttackInstructions(imageMode) };
    questions.harmful = { type: 'noul', instructions: buildHarmfulInstructions(imageMode) };
  }
  const payload = {
    model: String(options.model || DEFAULT_MODEL),
    state: String(text ?? ''),
    questions,
  };
  if (imageMode) payload.images = images;
  return payload;
}

/** 由 workspace/region 拼 endpoint */
export function buildSystemOneEndpoint({ workspaceId, region = DEFAULT_REGION, baseUrl } = {}) {
  if (baseUrl && String(baseUrl).trim()) return String(baseUrl).trim().replace(/\/+$/, '');
  const ws = String(workspaceId ?? '').trim();
  if (!ws) {
    throw new Error('SYSTEMONE_WORKSPACE_ID 未配置，无法构造决策模型 endpoint');
  }
  return `https://${ws}.${region}.maas.aliyuncs.com/compatible-mode/v1/systemone`;
}

function num(value, fallback = 0) {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 把 System One 响应归一化成契约 verdict。
 * 决策规则（ensemble）：
 * 1. category 的 argmax 非 safe → 直接采用；
 * 2. 否则若某违规类别概率 >= 0.35 → 采用该类别；
 * 3. 否则 attack >= 0.6 → insult；harmful >= 0.6 → illegal；
 * 4. 否则 safe。
 * 多个 head 独立前向，组合后显著提升隐晦辱骂/违法请求的召回。
 */
export function parseSystemOneResponse(data, options = {}) {
  const answers = data?.answers;
  if (!answers || typeof answers !== 'object') {
    return { verdict: null, error: '响应缺少 answers' };
  }
  const categoryAnswer = answers.category;
  const probabilities = categoryAnswer?.probabilities;
  if (!probabilities || typeof probabilities !== 'object') {
    return { verdict: null, error: '响应缺少 category 概率分布' };
  }
  const rawCategory = categoryAnswer?.choice;
  const argmax =
    typeof rawCategory === 'string' && Object.prototype.hasOwnProperty.call(probabilities, rawCategory)
      ? rawCategory.trim().toLowerCase()
      : Object.entries(probabilities)
          .filter(([code]) => Object.prototype.hasOwnProperty.call(CATEGORY_CRITERIA, code))
          .sort((a, b) => num(b[1]) - num(a[1]))[0]?.[0];
  if (!argmax || !Object.prototype.hasOwnProperty.call(CATEGORY_CRITERIA, argmax)) {
    return { verdict: null, error: `类别非法：${rawCategory ?? '(空)'}` };
  }

  const thresholds = { ...ENSEMBLE_THRESHOLDS, ...(options.thresholds || {}) };
  const ensemble = options.ensemble !== false;
  const attack = num(answers.attack?.noul, 0);
  const harmful = num(answers.harmful?.noul, 0);
  const violationCodes = Object.keys(CATEGORY_CRITERIA).filter((code) => code !== 'safe');
  const bestViolation = violationCodes
    .map((code) => [code, num(probabilities[code], 0)])
    .sort((a, b) => b[1] - a[1])[0] || ['safe', 0];

  let category = argmax;
  let basis = 'category';
  let confidenceValue = num(categoryAnswer?.confidence, num(probabilities[argmax], 0.5));

  if (ensemble && argmax === 'safe') {
    if (bestViolation[1] >= thresholds.categoryProb) {
      category = bestViolation[0];
      basis = 'category-prob';
      confidenceValue = bestViolation[1];
    } else if (attack >= thresholds.attack) {
      category = 'insult';
      basis = 'attack';
      confidenceValue = attack;
    } else if (harmful >= thresholds.harmful) {
      category = 'illegal';
      basis = 'harmful';
      confidenceValue = harmful;
    } else {
      category = 'safe';
      basis = 'safe';
      confidenceValue = num(probabilities.safe, confidenceValue);
    }
  }

  const violation = category === 'safe' ? 0 : 1;
  const severityRaw = num(answers.severity?.score, 0);
  const severity = violation === 0 ? 0 : Math.max(1, Math.min(3, Math.round(severityRaw)));

  let reason;
  if (violation === 0) {
    reason = `未发现违规（safe P=${num(probabilities.safe, 0).toFixed(2)}）`;
  } else if (basis === 'category') {
    reason = `直接分类：${CATEGORY_LABELS[category]}（P=${num(probabilities[category], 0).toFixed(2)}）`;
  } else if (basis === 'category-prob') {
    reason = `${CATEGORY_LABELS[category]}（类别概率 ${bestViolation[1].toFixed(2)}）`;
  } else if (basis === 'attack') {
    reason = `攻击性判别：${CATEGORY_LABELS[category]}（attack=${attack.toFixed(2)}）`;
  } else {
    reason = `违法请求判别：${CATEGORY_LABELS[category]}（harmful=${harmful.toFixed(2)}）`;
  }
  reason = Array.from(reason).slice(0, 40).join('');

  return {
    verdict: {
      violation,
      categories: [category],
      severity,
      confidence: Math.round(Math.max(0, Math.min(1, confidenceValue)) * 1000) / 1000,
      reason,
    },
    decision: {
      basis,
      argmax,
      attack: Math.round(attack * 1000) / 1000,
      harmful: Math.round(harmful * 1000) / 1000,
      probabilities,
    },
    error: null,
  };
}

function parseRetryAfterMs(headerValue) {
  if (!headerValue) return null;
  const seconds = Number.parseFloat(String(headerValue));
  if (Number.isFinite(seconds)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1000));
  const date = Date.parse(String(headerValue));
  if (Number.isFinite(date)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now()));
  return null;
}

function bodySnippet(bodyText, data) {
  // Cloudflare 标准错误信封：{success:false, errors:[{code,message}], messages:[]}
  const firstError = Array.isArray(data?.errors)
    ? data.errors.find((item) => typeof item?.message === 'string' && item.message.trim())
    : null;
  if (firstError) return firstError.message.trim().slice(0, 240);
  const message = data?.error?.message ?? data?.message;
  if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 240);
  return String(bodyText ?? '').slice(0, 240);
}

/** 默认响应适配：System One 直接返回 {answers,usage}；Cloudflare 等网关可用 unwrap 去掉信封 */
function identityResponse(data) {
  return data;
}

/**
 * 创建决策模型 provider。
 * @param {{
 *   apiKey: string,
 *   name?: string,
 *   workspaceId?: string,
 *   region?: string,
 *   baseUrl?: string,
 *   model?: string,
 *   timeoutMs?: number,
 *   maxRetries?: number,
 *   unwrap?: (data: any) => any,
 *   supportsImages?: boolean,
 *   fetchImpl?: typeof fetch,
 * }} options
 */
export function createSystemOneProvider(options = {}) {
  const name = String(options.name || 'dashscope');
  const apiKey = String(options.apiKey ?? '').trim();
  if (!apiKey) throw new Error('API Key 未配置，无法创建决策模型 provider');
  const endpoint = buildSystemOneEndpoint(options);
  const model = String(options.model || DEFAULT_MODEL);
  const timeoutMs = Math.max(1000, Math.floor(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const maxRetries = Math.max(0, Math.floor(Number(options.maxRetries) ?? 3));
  const ensemble = options.ensemble !== false;
  const supportsImages = options.supportsImages === true;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  // 网关响应信封不同（如 Cloudflare REST {result,...}），由 provider 传入适配函数归一化
  const unwrap = typeof options.unwrap === 'function' ? options.unwrap : identityResponse;
  // 并发由 benchmark / HTTP 层控制，这里放宽上限避免成为瓶颈
  const limiter = createLimiter(Math.max(32, Math.floor(Number(options.concurrency) || 32)));
  let notFoundHint = false;

  async function requestOnce(text, { signal, images } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`请求超时（${timeoutMs}ms）`));
    }, timeoutMs);
    timer.unref?.();

    const signals = [controller.signal];
    if (signal) signals.push(signal);
    const combinedSignal =
      signals.length > 1 && typeof AbortSignal.any === 'function'
        ? AbortSignal.any(signals)
        : controller.signal;

    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(buildSystemOnePayload(text, { ensemble, model, images })),
        signal: combinedSignal,
      });
      const bodyText = await response.text();
      let data = null;
      try {
        data = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        data = null;
      }

      if (!response.ok) {
        if (response.status === 404 && !notFoundHint) {
          notFoundHint = true;
          if (name === 'bamboonode') {
            console.warn(
              '[bamboonode] 接口 404：请确认 BAMBOONODE_BASE_URL 指向 https://api.bamboonode.dev/v1，且模型名在该网关可用',
            );
          } else if (name === 'cloudflare') {
            console.warn(
              `[cloudflare] 接口 404：请确认 CLOUDFLARE_ACCOUNT_ID 正确、CLOUDFLARE_API_TOKEN 具备 Workers AI 权限（Workers AI - Read/Edit），且 @cf/cloudflare/clef-omni 对当前账号可用`,
            );
          } else {
            console.warn(
              `[${name}] 接口 404：请确认 SYSTEMONE_WORKSPACE_ID 正确、地域为 cn-beijing，且账号已开通决策模型权限`,
            );
          }
        }
        const retryable = response.status === 429 || response.status >= 500;
        return {
          ok: false,
          status: response.status,
          retryable,
          retryAfterMs: parseRetryAfterMs(response.headers?.get?.('retry-after')),
          error: `HTTP ${response.status}: ${bodySnippet(bodyText, data) || response.statusText || '请求失败'}`,
          bodyText,
        };
      }

      // 各网关可能把响应包在信封里（Cloudflare: {result,success,errors,messages}）
      let payload;
      try {
        payload = unwrap(data);
      } catch {
        payload = data;
      }

      // 少数网关会以 HTTP 200 返回 {success:false, errors:[...]}，优先报出真实错误
      if (payload && typeof payload === 'object' && payload.success === false) {
        return {
          ok: false,
          status: response.status,
          retryable: false,
          error: `决策模型响应失败：${bodySnippet(bodyText, payload)}`,
          bodyText,
        };
      }

      const parsed = parseSystemOneResponse(payload, { thresholds: options.thresholds, ensemble });
      if (!parsed.verdict) {
        return {
          ok: false,
          status: response.status,
          retryable: false,
          error: `决策模型输出无法解析：${parsed.error}`,
          bodyText,
        };
      }
      const inputTokens = num(payload?.usage?.input_tokens, 0);
      const outputTokens = num(payload?.usage?.output_tokens, 0);
      return {
        ok: true,
        status: response.status,
        verdict: parsed.verdict,
        decision: parsed.decision,
        tokens: {
          prompt: Math.round(inputTokens),
          completion: Math.round(outputTokens),
          total: Math.round(inputTokens + outputTokens),
        },
        serverLatencyMs: num(payload?.latency_ms, 0),
        requestId: payload?.request_id ?? null,
        bodyText,
      };
    } catch (error) {
      const externalAborted = Boolean(signal?.aborted);
      const timedOut = controller.signal.aborted && !externalAborted;
      if (externalAborted) {
        return { ok: false, status: 0, retryable: false, aborted: true, error: '请求已取消' };
      }
      return {
        ok: false,
        status: 0,
        retryable: true,
        timedOut,
        error: timedOut
          ? `请求超时（${timeoutMs}ms）`
          : `网络请求失败：${error?.message || error}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function judge(text, ctx = {}) {
    const startedAt = globalThis.performance?.now?.() ?? Date.now();
    let attempt = 0;
    let retries = 0;
    let lastFailure = null;

    for (;;) {
      if (ctx.signal?.aborted) throw abortError(ctx.signal.reason);
      attempt += 1;
      const result = await limiter.run(() =>
        requestOnce(String(text ?? ''), { signal: ctx.signal, images: ctx.images }),
      );

      if (result.ok) {
        return {
          verdict: result.verdict,
          parseError: false,
          error: null,
          raw: JSON.stringify({
            request_id: result.requestId,
            latency_ms: result.serverLatencyMs,
            verdict: result.verdict,
            decision: result.decision,
          }),
          tokens: result.tokens,
          latencyMs: Math.round(nowMs() - startedAt),
          serverLatencyMs: result.serverLatencyMs,
          attempts: attempt,
          simulated: false,
        };
      }

      if (result.aborted) throw abortError(ctx.signal?.reason);
      lastFailure = result;

      if (result.retryable && retries < maxRetries) {
        const baseDelay = RETRY_DELAYS_MS[Math.min(retries, RETRY_DELAYS_MS.length - 1)];
        const jitter = Math.floor(Math.random() * MAX_JITTER_MS);
        const retryAfter = Number.isFinite(result.retryAfterMs) ? result.retryAfterMs : 0;
        retries += 1;
        await sleep(Math.max(baseDelay + jitter, retryAfter), ctx.signal);
        continue;
      }

      return {
        verdict: null,
        parseError: false,
        error: lastFailure?.error || '决策模型调用失败',
        raw: String(lastFailure?.bodyText ?? '').slice(0, 500),
        tokens: null,
        latencyMs: Math.round(nowMs() - startedAt),
        attempts: attempt,
        status: lastFailure?.status ?? 0,
        simulated: false,
      };
    }
  }

  return { name, model, simulated: false, ensemble, supportsImages, judge, endpoint };
}

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}
