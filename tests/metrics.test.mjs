// 指标计算 / 分位数 / CSV 导出 单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, quantile, resultToCsv, makeRunId, nextRunId } from '../server/benchmark.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function record(overrides = {}) {
  const base = {
    id: 'cold-0001',
    text: '示例文本',
    source: 'cold',
    sensitive: false,
    gold: { violation: true, categories: ['insult'] },
    prediction: {
      violation: 1,
      categories: ['insult'],
      severity: 2,
      confidence: 0.9,
      reason: '包含人身侮辱',
    },
    correct: true,
    categoryHit: true,
    latencyMs: 100,
    tokens: { prompt: 10, completion: 5, total: 15 },
    parseError: false,
    error: null,
    raw: '{}',
  };
  return { ...base, ...overrides };
}

function fixtureRecords() {
  return [
    // tp：违规 -> 违规（insult 命中）
    record({ id: 'cold-0001', latencyMs: 100, tokens: { prompt: 10, completion: 5, total: 15 } }),
    // tn：正常 -> 正常
    record({
      id: 'cold-0002',
      gold: { violation: false, categories: ['safe'] },
      prediction: {
        violation: 0,
        categories: ['safe'],
        severity: 0,
        confidence: 0.95,
        reason: '正常',
      },
      latencyMs: 200,
      tokens: { prompt: 20, completion: 5, total: 25 },
    }),
    // fp：正常 -> 违规（predict spam）
    record({
      id: 'cold-0003',
      gold: { violation: false, categories: ['safe'] },
      prediction: {
        violation: 1,
        categories: ['spam'],
        severity: 1,
        confidence: 0.4,
        reason: '疑似广告',
      },
      correct: false,
      categoryHit: false,
      latencyMs: 300,
      tokens: { prompt: 30, completion: 5, total: 35 },
    }),
    // fn：违规(hate) -> 正常
    record({
      id: 'cold-0004',
      gold: { violation: true, categories: ['hate'] },
      prediction: {
        violation: 0,
        categories: ['safe'],
        severity: 0,
        confidence: 0.6,
        reason: '未发现',
      },
      correct: false,
      categoryHit: false,
      latencyMs: 400,
      tokens: { prompt: 40, completion: 5, total: 45 },
    }),
    // parseFail
    record({
      id: 'cold-0005',
      gold: { violation: false, categories: ['safe'] },
      prediction: null,
      correct: false,
      categoryHit: false,
      latencyMs: 50,
      tokens: null,
      parseError: true,
      error: '无法解析模型输出为 JSON verdict',
    }),
    // 上游错误
    record({
      id: 'cold-0006',
      gold: { violation: false, categories: ['safe'] },
      prediction: null,
      correct: false,
      categoryHit: false,
      latencyMs: 0,
      tokens: null,
      parseError: false,
      error: 'HTTP 500: boom',
    }),
  ];
}

test('computeMetrics：二分类 / 混淆矩阵 / parseFail 自洽', () => {
  const records = fixtureRecords();
  const metrics = computeMetrics(records, {
    startedAt: '2026-10-23T00:00:00.000Z',
    finishedAt: '2026-10-23T00:00:01.000Z',
  });
  const { binary, confusion } = metrics;

  assert.equal(binary.total, 6);
  assert.equal(binary.parseFail, 1);
  assert.equal(binary.errors, 1);
  assert.equal(binary.valid, 4);
  assert.equal(binary.valid + binary.parseFail + binary.errors, binary.total);

  assert.equal(binary.tp, 1);
  assert.equal(binary.tn, 1);
  assert.equal(binary.fp, 1);
  assert.equal(binary.fn, 1);
  assert.deepEqual(confusion, { tp: 1, tn: 1, fp: 1, fn: 1 });
  assert.equal(binary.tp + binary.tn + binary.fp + binary.fn, binary.valid);

  assert.equal(binary.accuracy, 0.5);
  assert.equal(binary.precision, 0.5);
  assert.equal(binary.recall, 0.5);
  assert.equal(binary.f1, 0.5);
  assert.equal(binary.parseSuccessRate, Math.round(((6 - 1) / 6) * 10000) / 10000);
});

test('computeMetrics：perCategory / macro / micro', () => {
  const metrics = computeMetrics(fixtureRecords(), {});
  const { perCategory } = metrics;

  assert.equal(perCategory.insult.support, 1);
  assert.equal(perCategory.insult.predicted, 1);
  assert.equal(perCategory.insult.f1, 1);

  assert.equal(perCategory.hate.support, 1);
  assert.equal(perCategory.hate.fn, 1);
  assert.equal(perCategory.hate.recall, 0);

  assert.equal(perCategory.spam.support, 0);
  assert.equal(perCategory.spam.predicted, 1);
  assert.equal(perCategory.spam.precision, 0);

  // insult=1, hate=0, spam=0 -> 平均 1/3
  assert.equal(metrics.macroCategoryF1, 0.3333);
  // micro: TP1 FP1 FN1 -> P=0.5 R=0.5 F1=0.5
  assert.equal(metrics.microCategoryF1, 0.5);
});

test('computeMetrics：延迟分位数 / tokens / 吞吐', () => {
  const metrics = computeMetrics(fixtureRecords(), {
    startedAt: '2026-10-23T00:00:00.000Z',
    finishedAt: '2026-10-23T00:00:01.000Z',
  });
  assert.equal(metrics.latency.count, 4);
  assert.equal(metrics.latency.mean, 250);
  assert.equal(metrics.latency.p50, 250);
  assert.equal(metrics.latency.min, 100);
  assert.equal(metrics.latency.max, 400);
  assert.equal(metrics.latency.totalWallMs, 1000);
  assert.equal(metrics.latency.throughputRps, 6); // 6 条 / 1s
  assert.equal(metrics.tokens.prompt, 100);
  assert.equal(metrics.tokens.completion, 20);
  assert.equal(metrics.tokens.total, 120);
  assert.equal(metrics.tokens.avgTotal, 30);
});

test('computeMetrics：bySource / worst / 空输入', () => {
  const metrics = computeMetrics(fixtureRecords(), {});
  assert.equal(metrics.bySource.cold.total, 6);
  assert.equal(metrics.bySource.cold.valid, 4);
  assert.equal(metrics.bySource.cold.accuracy, 0.5);
  assert.ok(Array.isArray(metrics.worst));
  assert.equal(metrics.worst.length, 4); // 1 fp + 1 fn + parseFail + error
  assert.ok(metrics.worst.every((item) => item.id && typeof item.text === 'string'));

  const empty = computeMetrics([], {});
  assert.equal(empty.binary.total, 0);
  assert.equal(empty.binary.valid, 0);
  assert.equal(empty.binary.accuracy, 0);
  assert.equal(empty.latency.count, 0);
  assert.equal(empty.latency.totalWallMs, 0);
  assert.deepEqual(empty.worst, []);
});

test('quantile：边界与线性插值', () => {
  assert.equal(quantile([], 0.5), 0);
  assert.equal(quantile([5], 0.95), 5);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([1, 2, 3, 4], 0), 1);
  assert.equal(quantile([1, 2, 3, 4], 1), 4);
});

test('resultToCsv：表头、转义与记录数', () => {
  const result = {
    runId: 'bench-test',
    records: [
      record({
        id: 'x-1',
        text: '含,逗号 "引号"\n换行',
        source: 'cold',
      }),
    ],
  };
  const csv = resultToCsv(result);
  const lines = csv.split('\r\n');
  assert.ok(lines[0].startsWith('id,source,sensitive,gold_violation'));
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes('"含,逗号 ""引号""'));
  assert.ok(lines[1].includes('x-1'));
});

test('runId 生成格式与唯一性', () => {
  const id = makeRunId(new Date(2026, 9, 23, 21, 15, 0));
  assert.equal(id, 'bench-20261023-211500');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-runid-'));
  try {
    const first = nextRunId(dir);
    fs.writeFileSync(path.join(dir, `${first}.json`), '{}');
    const second = nextRunId(dir);
    assert.notEqual(first, second);
    assert.ok(second.startsWith(first));
    const third = nextRunId(dir, new Set([second]));
    assert.notEqual(third, second);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
