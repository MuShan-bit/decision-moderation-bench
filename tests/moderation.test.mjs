// 裁判 prompt / 输出解析 / 归一化 单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TAXONOMY,
  TAXONOMY_CODES,
  VIOLATION_CODES,
  SYSTEM_PROMPT,
  buildJudgeMessages,
  normalizeVerdict,
  parseJudgeOutput,
  isCorrect,
  isCategoryHit,
  taxonomyConfig,
  sortCategories,
} from '../server/moderation.mjs';

test('taxonomy：8 个固定类别，safe 唯一非违规', () => {
  assert.equal(TAXONOMY.length, 8);
  assert.equal(new Set(TAXONOMY_CODES).size, 8);
  assert.deepEqual(VIOLATION_CODES, [
    'insult',
    'hate',
    'sexual',
    'violence',
    'illegal',
    'spam',
    'privacy',
  ]);
  assert.equal(TAXONOMY[0].code, 'safe');
  assert.equal(TAXONOMY[0].violation, false);
  assert.deepEqual(
    taxonomyConfig().map((t) => t.code),
    [...TAXONOMY_CODES],
  );
});

test('system prompt 含全部类别与输出格式', () => {
  for (const code of TAXONOMY_CODES) {
    assert.ok(SYSTEM_PROMPT.includes(code), `prompt 缺少类别 ${code}`);
  }
  assert.ok(SYSTEM_PROMPT.includes('violation=0 时 categories 必须为 ["safe"]'));
  assert.ok(SYSTEM_PROMPT.includes('只输出一个 JSON 对象'));
});

test('buildJudgeMessages：system + user，user 原文含 <<< 包裹', () => {
  const messages = buildJudgeMessages('你好，世界');
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, SYSTEM_PROMPT);
  assert.equal(messages[1].role, 'user');
  assert.ok(messages[1].content.includes('你好，世界'));
  assert.ok(messages[1].content.includes('<<<'));
  assert.ok(messages[1].content.includes('>>>'));
});

test('parseJudgeOutput：干净 JSON', () => {
  const { verdict, parseError } = parseJudgeOutput(
    '{"violation":1,"categories":["insult"],"severity":2,"confidence":0.9,"reason":"包含人身侮辱"}',
  );
  assert.equal(parseError, false);
  assert.deepEqual(verdict, {
    violation: 1,
    categories: ['insult'],
    severity: 2,
    confidence: 0.9,
    reason: '包含人身侮辱',
  });
});

test('parseJudgeOutput：```json 围栏', () => {
  const raw = '好的，结果如下：\n```json\n{"violation":1,"categories":["spam"],"severity":1,"confidence":0.8,"reason":"广告"}\n```\n';
  const parsed = parseJudgeOutput(raw);
  assert.equal(parsed.parseError, false);
  assert.equal(parsed.verdict.violation, 1);
  assert.deepEqual(parsed.verdict.categories, ['spam']);
});

test('parseJudgeOutput：前置解释 + 花括号提取', () => {
  const raw = '我的判断是 {"violation":0,"categories":["safe"],"severity":0,"confidence":0.95,"reason":"正常"} 以上。';
  const parsed = parseJudgeOutput(raw);
  assert.equal(parsed.parseError, false);
  assert.equal(parsed.verdict.violation, 0);
  assert.deepEqual(parsed.verdict.categories, ['safe']);
});

test('parseJudgeOutput：完全不是 JSON 时正则兜底 violation', () => {
  const raw = '判断结果：violation: 1, categories: ["hate"], severity: 3, confidence: 0.85';
  const parsed = parseJudgeOutput(raw);
  assert.equal(parsed.parseError, false);
  assert.equal(parsed.verdict.violation, 1);
  assert.deepEqual(parsed.verdict.categories, ['hate']);
});

test('parseJudgeOutput：垃圾输出 -> parseError=true, verdict=null', () => {
  for (const raw of ['', '   ', '我不知道', '模型拒绝回答', null, undefined, 123]) {
    const parsed = parseJudgeOutput(raw);
    assert.equal(parsed.parseError, true, `raw=${String(raw)}`);
    assert.equal(parsed.verdict, null);
    assert.ok(typeof parsed.error === 'string' && parsed.error.length > 0);
  }
});

test('normalizeVerdict：violation=0 强制 categories=["safe"]，severity=0', () => {
  const { verdict, error } = normalizeVerdict({
    violation: 0,
    categories: ['insult', 'spam'],
    severity: 3,
    confidence: 1.7,
    reason: '正常',
  });
  assert.equal(error, null);
  assert.deepEqual(verdict.categories, ['safe']);
  assert.equal(verdict.severity, 0);
  assert.equal(verdict.confidence, 1);
});

test('normalizeVerdict：violation=1 但只有 safe -> 语义错误', () => {
  const { verdict, error } = normalizeVerdict({ violation: 1, categories: ['safe'] });
  assert.equal(verdict, null);
  assert.match(error, /categories/);
});

test('normalizeVerdict：非法类别过滤、去重、按 taxonomy 排序', () => {
  const { verdict } = normalizeVerdict({
    violation: 1,
    categories: ['spam', 'not-a-category', 'insult', 'spam'],
    severity: 9,
    confidence: '0.72',
    reason: 'x'.repeat(80),
  });
  assert.deepEqual(verdict.categories, ['insult', 'spam']);
  assert.equal(verdict.severity, 3);
  assert.equal(verdict.confidence, 0.72);
  assert.equal(Array.from(verdict.reason).length, 40);
});

test('sortCategories 按 taxonomy 顺序', () => {
  assert.deepEqual(sortCategories(['privacy', 'insult', 'spam']), [
    'insult',
    'spam',
    'privacy',
  ]);
});

test('isCorrect / isCategoryHit 口径', () => {
  const safeGold = { violation: false, categories: ['safe'] };
  const insultGold = { violation: true, categories: ['insult'] };
  const hateGold = { violation: true, categories: ['hate'] };

  assert.equal(isCorrect(safeGold, { violation: 0, categories: ['safe'] }), true);
  assert.equal(isCorrect(safeGold, { violation: 1, categories: ['spam'] }), false);
  assert.equal(isCorrect(insultGold, { violation: 1, categories: ['insult'] }), true);
  assert.equal(isCorrect(insultGold, { violation: 0, categories: ['safe'] }), false);
  assert.equal(isCorrect(insultGold, null), false);

  assert.equal(isCategoryHit(safeGold, { violation: 0, categories: ['safe'] }), true);
  assert.equal(isCategoryHit(safeGold, { violation: 1, categories: ['spam'] }), false);
  assert.equal(isCategoryHit(insultGold, { violation: 1, categories: ['insult'] }), true);
  assert.equal(isCategoryHit(insultGold, { violation: 1, categories: ['hate'] }), false);
  assert.equal(isCategoryHit(insultGold, { violation: 0, categories: ['safe'] }), false);
  assert.equal(
    isCategoryHit(hateGold, { violation: 1, categories: ['insult', 'hate'] }),
    true,
  );
});
