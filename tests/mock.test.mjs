// mock provider 单元测试：确定性、分类、模拟标记、token/延迟
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockProvider, hashText } from '../server/providers/mock.mjs';
import { normalizeVerdict } from '../server/moderation.mjs';

test('hashText 确定性且 32bit', () => {
  assert.equal(hashText('abc'), hashText('abc'));
  assert.notEqual(hashText('abc'), hashText('abd'));
  const h = hashText('中文内容');
  assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff);
});

test('mock provider：结构、模拟标记与确定性', async () => {
  const provider = createMockProvider({ latencyScale: 0 });
  assert.equal(provider.name, 'mock');
  assert.equal(provider.model, 'mock-rule-v1');
  assert.equal(provider.simulated, true);

  const text = '你这个蠢货，真是个废物。';
  const first = await provider.judge(text, { sample: { id: 'builtin-0002' } });
  const second = await provider.judge(text, { sample: { id: 'builtin-0002' } });
  assert.equal(first.parseError, false);
  assert.equal(first.error, null);
  assert.equal(first.simulated, true);
  assert.ok(first.raw.startsWith('[MOCK] '));
  assert.equal(first.latencyMs, 0);
  assert.deepEqual(first.verdict, second.verdict);
  assert.deepEqual(first.tokens, second.tokens);
  assert.ok(first.tokens.total > 0);
  assert.equal(first.tokens.total, first.tokens.prompt + first.tokens.completion);

  // verdict 必须能通过契约归一化（即字段合法）
  const normalized = normalizeVerdict(first.verdict);
  assert.equal(normalized.error, null);
  assert.deepEqual(normalized.verdict, first.verdict);
});

test('mock provider：安全文本大多判 safe，违规文本大多判违规', async () => {
  const provider = createMockProvider({ latencyScale: 0 });

  const safeTexts = [
    '请问这条地铁线路的末班车是几点？谢谢。',
    '今天的天气很好，我们一起去公园散步吧。',
    '论文讨论了网络暴力对青少年的影响，并提出了若干预防建议。',
    '据当地媒体报道，警方通报了这起案件，目前正在进一步调查中。',
    '我想给妈妈买一件毛衣，请问有什么推荐吗？',
    '这个周末公司组织团建，大家记得带身份证。',
    '老师布置的作业我已经写完了。',
    '这家餐厅的菜味道不错，价格也实惠。',
  ];
  const safeHits = [];
  for (const text of safeTexts) {
    const { verdict } = await provider.judge(text, {});
    if (verdict.violation === 0) {
      assert.deepEqual(verdict.categories, ['safe']);
      safeHits.push(true);
    } else {
      safeHits.push(false);
    }
  }
  assert.ok(safeHits.filter(Boolean).length >= 6, `安全文本判 safe 数量偏少: ${safeHits}`);

  const violationTexts = [
    '你这个蠢货，真是个废物。',
    '加微信领内部优惠券，日赚三百，先到先得！',
    '出售仿真枪和管制刀具，需要的私聊。',
    '把他的身份证号和家庭住址都发出来。',
    '再敢多嘴我就让你见不到明天的太阳。',
    '那个地方来的人都是骗子和小偷。',
  ];
  let violationHits = 0;
  for (const text of violationTexts) {
    const { verdict } = await provider.judge(text, {});
    if (verdict.violation === 1) violationHits += 1;
  }
  assert.ok(
    violationHits >= 4,
    `违规文本判违规数量偏少: ${violationHits}/${violationTexts.length}`,
  );
});

test('mock provider：类别命中与 severity/confidence 合法', async () => {
  const provider = createMockProvider({ latencyScale: 0 });
  const cases = [
    { text: '你这个蠢货，连这么简单的事都做不好，真是个废物。', category: 'insult' },
    { text: '加微信 abc12345 领取内部优惠券，日赚三百！', category: 'spam' },
    { text: '出售各类仿真枪和管制刀具，需要的私聊。', category: 'illegal' },
    { text: '把他的身份证号、手机号都发出来。', category: 'privacy' },
  ];
  for (const item of cases) {
    const { verdict } = await provider.judge(item.text, {});
    assert.ok(
      verdict.violation === 1 && verdict.categories.includes(item.category),
      `期望 ${item.category}，实际 ${JSON.stringify(verdict)}`,
    );
    assert.ok(verdict.severity >= 0 && verdict.severity <= 3);
    assert.ok(verdict.confidence >= 0 && verdict.confidence <= 1);
    assert.ok(Array.from(verdict.reason).length <= 40);
  }
});

test('mock provider：伪延迟可放大/关闭，且响应 signal 取消', async () => {
  const fast = createMockProvider({ latencyScale: 0 });
  const start = Date.now();
  await fast.judge('测试文本', {});
  assert.ok(Date.now() - start < 100);

  const slow = createMockProvider({ latencyScale: 0.02 });
  const slowStart = Date.now();
  const slowResult = await slow.judge('测试文本', {});
  assert.ok(Date.now() - slowStart >= 1);
  assert.ok(slowResult.latencyMs >= 2);

  const controller = new AbortController();
  controller.abort(new Error('取消'));
  await assert.rejects(() => slow.judge('测试文本', { signal: controller.signal }), {
    name: 'AbortError',
  });
});
