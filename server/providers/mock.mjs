// Mock 审核 provider：确定性词典/规则 + 伪延迟 + 固定比例的模拟误判。
// 用途：离线 demo、端到端自测。所有输出都带 [MOCK] / simulated 标记，绝不伪装真实模型。
import { SYSTEM_PROMPT, CATEGORY_LABELS } from '../moderation.mjs';
import { sleep } from '../lib/limiter.mjs';

const MOCK_MODEL = 'mock-rule-v1';

/** FNV-1a 32bit，确定性哈希（同一文本每次结果一致） */
export function hashText(value) {
  const text = String(value ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const RULES = Object.freeze([
  {
    category: 'illegal',
    label: '违法交易',
    re: /(毒品|冰毒|海洛因|大麻|枪支|仿真枪|管制刀具|刀具|炸药|爆炸物|诈骗|洗钱|赌博|博彩|黑客|盗号|代开发票|走私|贩毒|制毒|套现|出售.{0,6}(枪|刀|毒品|账号|银行卡))/,
  },
  {
    category: 'privacy',
    label: '隐私信息',
    re: /(身份证号|身份证|手机号|家庭住址|住址|人肉|开盒|户籍|个人信息|定位|跟踪|偷拍|曝光.{0,4}(隐私|信息|地址))/,
  },
  {
    category: 'sexual',
    label: '色情低俗',
    re: /(色情|裸照|裸体|性交|做爱|呻吟|援交|约炮|卖淫|嫖娼|下体|私处|性暗示|火辣|性感|身材|浮想联翩|成人视频|成人片|艳照)/,
  },
  {
    category: 'violence',
    label: '暴力威胁',
    re: /(杀死|杀了|砍死|砍人|捅死|血腥|自杀|自残|炸弹|炸弹|见不到明天|打断.{0,2}腿|弄死|灭门|枪毙|恐怖袭击|血洗|报复你|揍你|宰了你)/,
  },
  {
    category: 'hate',
    label: '歧视仇恨',
    re: /(种族歧视|地域歧视|性别歧视|歧视|仇恨言论|劣等|低等民族|滚出.{0,4}(国|省|城市)|不配做人|穆斯林|黑人|同性恋|残疾人都|外地人都是|河南人都是|东北人都是|农村人都是)/,
  },
  {
    category: 'hate',
    label: '地域攻击',
    re: /(那个地方|这种地方|外地人|哪里人|地方来的人).{0,16}(都是|全是|没一个好东西|骗子|小偷|垃圾)/,
  },
  {
    category: 'insult',
    label: '辱骂攻击',
    re: /(蠢货|废物|傻逼|煞笔|白痴|脑残|智障|贱人|王八蛋|去死|滚蛋|妈的|草泥马|你妈|垃圾东西|sb)/i,
  },
  {
    category: 'spam',
    label: '广告引流',
    re: /(加微信|加v|加V|优惠券|日赚|刷单|兼职|代理|推广|引流|二维码|免费领取|私聊我|带货|内部价|赚.{0,4}元|扫码)/,
  },
]);

const HIGH_RISK = /(毒品|枪支|炸药|诈骗|洗钱|自杀|杀|杀你|灭门|炸弹|身份证号|人肉)/;

function classify(text) {
  const hits = [];
  for (const rule of RULES) {
    if (rule.re.test(text)) {
      if (!hits.some((h) => h.category === rule.category)) {
        hits.push({ category: rule.category, label: rule.label });
      }
    }
  }
  if (!hits.length) {
    return {
      violation: 0,
      categories: ['safe'],
      severity: 0,
      confidence: 0.9,
      reason: '未发现明显违规特征（模拟规则）',
    };
  }

  // 类别按 taxonomy 顺序输出，最多保留 2 个
  const categories = [...new Set(hits.map((h) => h.category))].slice(0, 2);
  const labels = [...new Set(hits.map((h) => h.label))].slice(0, 2);
  const severity = categories.length > 1 || HIGH_RISK.test(text) ? 3 : 2;
  return {
    violation: 1,
    categories,
    severity,
    confidence: 0.82,
    reason: `模拟规则命中：${labels.join('、')}`.slice(0, 40),
  };
}

function withSimulatedErrors(verdict, seed, enabled = true) {
  const bucket = seed % 100;
  const next = { ...verdict, categories: [...verdict.categories] };
  // 单条体验（无 sample 上下文）保持规则判定准确；仅批量跑分时注入固定比例噪声，
  // 让 dashboard 的混淆矩阵/判错样本有内容可看。
  if (!enabled) return next;

  if (verdict.violation === 1) {
    // 约 8% 漏判（违规判成正常）
    if (bucket < 8) {
      return {
        violation: 0,
        categories: ['safe'],
        severity: 0,
        confidence: 0.56,
        reason: '未发现明显违规特征（模拟误判）',
      };
    }
    // 约 6% 类别漂移（二分类仍对，细分类错）
    if (bucket >= 8 && bucket < 14) {
      const drift = ['insult', 'hate', 'sexual', 'violence', 'illegal', 'spam', 'privacy'];
      const current = verdict.categories[0];
      const idx = drift.indexOf(current);
      next.categories = [drift[(idx + 3) % drift.length]];
      next.reason = `模拟规则命中：${CATEGORY_LABELS[next.categories[0]] || '违规'}`.slice(0, 40);
      next.confidence = 0.63;
    }
    return next;
  }

  // 正常文本约 7% 误报
  if (bucket < 7) {
    const fp = ['spam', 'insult', 'privacy'][bucket % 3];
    return {
      violation: 1,
      categories: [fp],
      severity: 1,
      confidence: 0.43,
      reason: '疑似命中敏感特征（模拟误报）',
    };
  }
  return next;
}

/**
 * 创建 mock provider。
 * @param {{model?: string, latencyScale?: number}} options
 */
export function createMockProvider(options = {}) {
  // mock 统一使用可识别的模型名，避免和真实模型混淆
  const model = MOCK_MODEL;
  const latencyScale =
    Number.isFinite(Number(options.latencyScale))
      ? Math.max(0, Number(options.latencyScale))
      : 1;

  async function judge(text, ctx = {}) {
    const content = String(text ?? '');
    const seed = hashText(`${ctx.sample?.id ?? ''}|${content}`);
    let verdict = classify(content);
    verdict = withSimulatedErrors(verdict, seed, Boolean(ctx.sample?.id));

    // 二分类数据集只需要 safe / unsafe；细分类别仅用于 mock 内部规则
    if (ctx.labelMode === 'binary') {
      verdict = {
        violation: verdict.violation,
        categories: [verdict.violation === 1 ? 'unsafe' : 'safe'],
        severity: verdict.violation === 1 ? 2 : 0,
        confidence: verdict.confidence,
        reason: verdict.violation === 1 ? '模拟规则命中：不安全' : '未发现明显违规特征（模拟）',
      };
    }

    const simulatedLatency =
      latencyScale === 0
        ? 0
        : Math.round(
            (140 +
              (seed % 380) +
              Math.min(content.length, 200) +
              (hashText(`lat:${content}`) % 40)) *
              latencyScale,
          );

    if (simulatedLatency > 0) await sleep(simulatedLatency, ctx.signal);

    const promptTokens = Math.ceil((SYSTEM_PROMPT.length + content.length + 40) / 1.6);
    const completionTokens = 38 + (seed % 20);
    const tokens = {
      prompt: promptTokens,
      completion: completionTokens,
      total: promptTokens + completionTokens,
    };

    return {
      verdict,
      latencyMs: simulatedLatency,
      tokens,
      parseError: false,
      error: null,
      raw: `[MOCK] ${JSON.stringify(verdict)}`,
      attempts: 1,
      simulated: true,
    };
  }

  return {
    name: 'mock',
    model,
    simulated: true,
    judge,
  };
}
