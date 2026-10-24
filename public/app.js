/* 内容审核跑分台 —— 纯原生前端逻辑（零依赖，无 CDN）
 * 对接 docs/CONTRACT.md 第 4/6/7 节的 HTTP API；图表全部内联 SVG 自绘。
 */
(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PAGE_SIZES = { default: 20 };
  const CAT_COLORS = {
    safe: '#34d399',
    insult: '#fb923c',
    hate: '#f87171',
    sexual: '#f472b6',
    violence: '#ef4444',
    illegal: '#a78bfa',
    spam: '#fbbf24',
    privacy: '#38bdf8',
  };

  const state = {
    config: null,
    health: null,
    result: null, // 当前展示的跑分结果
    runId: null,
    pollTimer: null,
    elapsedTimer: null,
    runStartedAt: 0,
    running: false,
    revealAll: false,
    revealed: new Set(),
    filter: 'all',
    category: 'all',
    search: '',
    page: 1,
    pageSize: PAGE_SIZES.default,
    categories: [],
    // provider -> 可用模型列表（后端 /api/config 下发，用于级联筛选）
    providerModels: null,
    // 跑分记录 / 多模型对比
    history: [],
    latestRunId: null,
    historyTotal: 0,
    historyPage: 1,
    historyPages: 1,
    historyCache: new Map(),
    selectedRuns: new Set(),
    compareInitialized: false,
  };

  const COMPARE_MAX = 6;
  const HISTORY_PAGE_SIZE = 6;
  const RUN_COLORS = ['#5eead4', '#fbbf24', '#f472b6', '#a78bfa', '#38bdf8', '#fb923c', '#34d399', '#f87171'];

  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------------
  // 基础工具
  // ------------------------------------------------------------------
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function svg(tag, attrs, text) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value !== undefined && value !== null) node.setAttribute(key, String(value));
      }
    }
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function fmtPct(value, digits = 1) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return `${(n * 100).toFixed(digits)}%`;
  }

  function fmtNum(value, digits = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return n.toFixed(digits);
  }

  function fmtMs(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (n < 1) return '<1ms';
    if (n < 1000) return `${Math.round(n)}ms`;
    return `${(n / 1000).toFixed(2)}s`;
  }

  function fmtDuration(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n < 1000) return `${Math.round(n)}ms`;
    if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
    return `${Math.floor(n / 60000)}m${Math.round((n % 60000) / 1000)}s`;
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const pad = (v) => String(v).padStart(2, '0');
    return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function catLabel(code) {
    const item = (state.categories || []).find((c) => c.code === code);
    return item ? item.label : code;
  }

  function chip(code) {
    const node = el('span', `chip ${code}`, catLabel(code));
    node.title = `${catLabel(code)}（${code}）`;
    return node;
  }

  function chipsFor(list, max = 4) {
    const wrap = el('span', 'chips');
    const codes = Array.isArray(list) ? list.slice(0, max) : [];
    if (!codes.length) {
      wrap.appendChild(el('span', 'chip plain', '—'));
      return wrap;
    }
    for (const code of codes) wrap.appendChild(chip(code));
    return wrap;
  }

  function showToast(message, type = 'error', timeout = 4200) {
    const box = $('toasts');
    if (!box) return;
    const node = el('div', `toast ${type}`);
    node.appendChild(el('span', '', message));
    box.appendChild(node);
    setTimeout(() => {
      node.classList.add('hide');
      setTimeout(() => node.remove(), 240);
    }, timeout);
  }

  function setErrorBanner(message) {
    const banner = $('errorBanner');
    const text = $('errorBannerText');
    if (!banner || !text) return;
    if (message) {
      text.textContent = message;
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }

  async function api(path, options = {}) {
    const opts = { ...options, headers: { ...(options.headers || {}) } };
    if (opts.body !== undefined && !opts.headers['Content-Type']) {
      opts.headers['Content-Type'] = 'application/json';
    }
    let res;
    try {
      res = await fetch(path, { cache: 'no-store', ...opts });
    } catch (error) {
      throw new Error(`无法连接后端（${error && error.message ? error.message : error}）`);
    }
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const message = (body && body.error) || body?.message || `HTTP ${res.status}`;
      const err = new Error(message);
      err.status = res.status;
      err.code = body && body.code;
      throw err;
    }
    return body;
  }

  // ------------------------------------------------------------------
  // 顶部状态 / 配置
  // ------------------------------------------------------------------
  function setConn(status, text) {
    const pill = $('connStatus');
    const label = $('connText');
    if (!pill || !label) return;
    pill.classList.remove('loading', 'online', 'demo', 'offline');
    if (status === 'online') pill.classList.add('online');
    else if (status === 'demo') pill.classList.add('demo');
    else if (status === 'offline') pill.classList.add('offline');
    else pill.classList.add('loading');
    label.textContent = text;
  }

  function setBadges(health, config) {
    const provider = health?.provider || config?.defaultProvider || '—';
    const model = health?.model || config?.defaultModel || '—';
    const dataset = config?.datasetTotal ?? health?.dataset?.total ?? '—';
    if ($('badgeProvider')) $('badgeProvider').textContent = `provider · ${provider}`;
    if ($('badgeModel')) $('badgeModel').textContent = `model · ${model}`;
    if ($('badgeDataset')) $('badgeDataset').textContent = `数据集 · ${dataset} 条`;
  }

  function updateMockBanner(providerName) {
    const banner = $('mockBanner');
    if (!banner) return;
    const provider = providerName || $('providerSelect')?.value || state.config?.defaultProvider;
    const isMock = provider === 'mock';
    banner.hidden = !isMock;
    if (isMock) {
      const text = $('mockBannerText');
      if (text) {
        text.textContent =
          '当前使用 mock provider：跑分结果由本地模拟器生成，仅用于界面演示，不代表真实模型能力。';
      }
    }
  }

  function modelsForProvider(providerName) {
    const mapped = state.providerModels && state.providerModels[providerName];
    if (Array.isArray(mapped) && mapped.length) return mapped;
    if (providerName === 'mock') return ['mock-rule-v1'];
    return Array.isArray(state.config?.models) ? state.config.models : [];
  }

  /** Provider → Model 级联：切换 provider 时只展示该 provider 能用的模型 */
  function refreshModelOptions(providerName, preferred) {
    const modelSelect = $('modelSelect');
    if (!modelSelect) return;
    const models = modelsForProvider(providerName);
    modelSelect.textContent = '';
    for (const name of models) {
      const option = el('option', '', name);
      option.value = name;
      modelSelect.appendChild(option);
    }
    if (!models.length) {
      const option = el('option', '', '当前 provider 无可用模型');
      option.value = '';
      option.disabled = true;
      modelSelect.appendChild(option);
    }
    const wanted = models.includes(preferred) ? preferred : models[0];
    if (wanted) modelSelect.value = wanted;
    modelSelect.disabled = models.length === 0;
  }

  function updateProviderWarn(providerName) {
    const warn = $('apiKeyWarn');
    if (!warn) return;
    const health = state.health || {};
    if (providerName === 'bamboonode' && health.bamboonodeKeyConfigured === false) {
      warn.textContent = '未检测到 BAMBOONODE_API_KEY，选择该 provider 会返回配置错误；请在 .env 中配置网关 Key。';
      warn.hidden = false;
      return;
    }
    if (providerName === 'jev' && health.jevKeyConfigured === false) {
      warn.textContent = '未检测到 JEVMODEL_API_KEY，选择该 provider 会返回配置错误；请在 .env 中配置 Jev 官方网关 Key。';
      warn.hidden = false;
      return;
    }
    if (providerName === 'systemone' && health.apiKeyConfigured === false) {
      warn.textContent = '未检测到 DASHSCOPE_API_KEY（百炼），选择 systemone 会返回配置错误。';
      warn.hidden = false;
      return;
    }
    warn.hidden = true;
  }

  function populateControls() {
    const cfg = state.config || {};
    const providers = Array.isArray(cfg.providers) ? cfg.providers : ['mock'];
    const providerSelect = $('providerSelect');
    if (providerSelect) {
      providerSelect.textContent = '';
      for (const name of providers) {
        const option = el('option', '', name);
        option.value = name;
        providerSelect.appendChild(option);
      }
      providerSelect.value = providers.includes(cfg.defaultProvider)
        ? cfg.defaultProvider
        : providers[0] || 'mock';
    }

    // Provider 与 Model 级联：模型列表由 provider 决定
    refreshModelOptions(
      providerSelect ? providerSelect.value || cfg.defaultProvider : cfg.defaultProvider,
      cfg.defaultModel,
    );

    const concurrencySelect = $('concurrencySelect');
    const options = Array.isArray(cfg.concurrencyOptions) && cfg.concurrencyOptions.length
      ? cfg.concurrencyOptions
      : [1, 2, 4, 8];
    if (concurrencySelect) {
      concurrencySelect.textContent = '';
      for (const n of options) {
        const option = el('option', '', n);
        option.value = String(n);
        concurrencySelect.appendChild(option);
      }
      const picked = options.includes(4) ? 4 : options[Math.min(1, options.length - 1)];
      concurrencySelect.value = String(picked);
    }

    if (cfg.limitDefault) {
      const limitSelect = $('limitSelect');
      if (limitSelect && [...limitSelect.options].some((o) => o.value === String(cfg.limitDefault))) {
        limitSelect.value = String(cfg.limitDefault);
      }
    }

    updateProviderWarn(providerSelect ? providerSelect.value : cfg.defaultProvider);
    updateMockBanner();
  }

  function renderTaxonomy() {
    const legend = $('taxonomyLegend');
    if (!legend) return;
    legend.textContent = '';
    for (const item of state.categories) {
      const node = el('span', 'tax-chip');
      node.style.setProperty('--cat', `var(--cat-${item.code})`);
      node.appendChild(el('i'));
      node.appendChild(el('span', '', item.label));
      const code = el('code', '', item.code);
      node.appendChild(code);
      legend.appendChild(node);
    }
  }

  // ------------------------------------------------------------------
  // 总览 / KPI
  // ------------------------------------------------------------------
  function kpiCard(label, value, sub, accent) {
    const card = el('div', 'kpi');
    if (accent) card.dataset.accent = accent;
    card.appendChild(el('div', 'kpi-label', label));
    card.appendChild(el('div', 'kpi-value', value));
    if (sub) card.appendChild(el('div', 'kpi-sub', sub));
    return card;
  }

  function renderOverview(result) {
    const loading = $('overviewLoading');
    const empty = $('overviewEmpty');
    const kpiGrid = $('kpiGrid');
    if (!kpiGrid) return;
    kpiGrid.textContent = '';
    if (loading) loading.hidden = true;
    if (!result) {
      if (empty) empty.hidden = false;
      kpiGrid.hidden = true;
      if ($('chartGrid')) $('chartGrid').hidden = true;
      if ($('categoryPanel')) $('categoryPanel').hidden = true;
      if ($('sourcePanel')) $('sourcePanel').hidden = true;
      if ($('resultMeta')) $('resultMeta').textContent = '';
      return;
    }
    if (empty) empty.hidden = true;
    kpiGrid.hidden = false;

    const m = result.metrics || {};
    const b = m.binary || {};
    const lat = m.latency || {};
    const tokens = m.tokens || {};
    const acc = Number(b.accuracy) || 0;
    const accAccent = acc >= 0.8 ? 'ok' : acc >= 0.6 ? 'warn' : 'danger';

    const cards = [
      kpiCard('准确率 Accuracy', fmtPct(b.accuracy), `有效 ${b.valid ?? 0} / ${b.total ?? 0} 条`, accAccent),
      kpiCard('精确率 Precision', fmtPct(b.precision), `TP ${b.tp ?? 0} · FP ${b.fp ?? 0}`, 'cyan'),
      kpiCard('召回率 Recall', fmtPct(b.recall), `FN ${b.fn ?? 0} 条漏判`, 'warn'),
      kpiCard('F1', fmtPct(b.f1), `macroF1 ${fmtPct(m.macroCategoryF1)}`, 'violet'),
      kpiCard('解析成功率', fmtPct(b.parseSuccessRate), `解析失败 ${b.parseFail ?? 0} 条`, 'cyan'),
      kpiCard('P50 延迟', fmtMs(lat.p50), `均值 ${fmtMs(lat.mean)}`),
      kpiCard('P95 延迟', fmtMs(lat.p95), `P99 ${fmtMs(lat.p99)}`),
      kpiCard('吞吐', `${fmtNum(lat.throughputRps, 1)} req/s`, `总耗时 ${fmtDuration(lat.totalWallMs)}`, 'violet'),
      kpiCard('Tokens', fmtNum(tokens.total), `平均 ${fmtNum(tokens.avgTotal, 0)} / 条`),
      kpiCard('调用错误', `${b.errors ?? 0}`, `样本 ${b.total ?? 0} 条 · 模拟 ${result.simulated ? '是' : '否'}`, (b.errors || 0) > 0 ? 'warn' : 'ok'),
    ];
    for (const card of cards) kpiGrid.appendChild(card);

    renderResultMeta(result);
  }

  function renderResultMeta(result) {
    const wrap = $('resultMeta');
    if (!wrap) return;
    wrap.textContent = '';
    const items = [
      ['run', result.runId],
      ['模型', `${result.provider} · ${result.model}`],
      ['并发', String(result.config?.concurrency ?? '—')],
      ['样本', String(result.config?.limit ?? '—')],
      ['开始', fmtTime(result.startedAt)],
      ['耗时', fmtDuration(result.metrics?.latency?.totalWallMs)],
    ];
    for (const [label, value] of items) {
      const node = el('span', 'meta-chip');
      node.appendChild(el('strong', '', label));
      node.appendChild(document.createTextNode(` ${value}`));
      wrap.appendChild(node);
    }
  }

  // ------------------------------------------------------------------
  // 图表：延迟直方图
  // ------------------------------------------------------------------
  function chartEmpty(target, message) {
    target.textContent = '';
    target.appendChild(el('div', 'chart-empty', message || '暂无可绘制的数据'));
  }

  function renderLatencyChart(result) {
    const target = $('latencyChart');
    if (!target) return;
    const records = Array.isArray(result.records) ? result.records : [];
    const values = records
      .map((r) => Number(r.latencyMs))
      .filter((v) => Number.isFinite(v) && v >= 0);
    if (!values.length) return chartEmpty(target, '没有有效的延迟数据');

    const lat = result.metrics?.latency || {};
    const p50 = Number(lat.p50) || 0;
    const p95 = Number(lat.p95) || 0;
    const maxVal = Math.max(p95 * 1.35, 300, Math.min(2000, Math.max(...values)));
    const binCount = 18;
    const binW = maxVal / binCount;
    const bins = new Array(binCount).fill(0);
    for (const v of values) {
      const idx = Math.min(binCount - 1, Math.max(0, Math.floor(v / binW)));
      bins[idx] += 1;
    }
    const yMax = Math.max(1, ...bins);

    const W = 640;
    const H = 280;
    const M = { left: 42, right: 14, top: 22, bottom: 38 };
    const plotW = W - M.left - M.right;
    const plotH = H - M.top - M.bottom;
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '延迟直方图' });
    target.textContent = '';
    target.appendChild(root);

    for (let i = 0; i <= 4; i += 1) {
      const y = M.top + (plotH * i) / 4;
      root.appendChild(svg('line', { x1: M.left, y1: y, x2: W - M.right, y2: y, class: 'grid-line' }));
      root.appendChild(svg('text', { x: M.left - 7, y: y + 4, 'text-anchor': 'end' }, String(Math.round((yMax * (4 - i)) / 4))));
    }

    const barGap = 2;
    const barW = Math.max(2, plotW / binCount - barGap);
    for (let i = 0; i < binCount; i += 1) {
      const h = (bins[i] / yMax) * plotH;
      const x = M.left + (plotW * i) / binCount;
      const y = M.top + plotH - h;
      const rect = svg('rect', {
        x: x.toFixed(1),
        y: y.toFixed(1),
        width: barW.toFixed(1),
        height: Math.max(0, h).toFixed(1),
        rx: 2,
        class: 'bar',
        fill: 'url(#latGrad)',
      });
      rect.appendChild(svg('title', {}, `${Math.round(i * binW)}-${Math.round((i + 1) * binW)}ms：${bins[i]} 条`));
      root.appendChild(rect);
    }

    const defs = svg('defs');
    const grad = svg('linearGradient', { id: 'latGrad', x1: '0', y1: '0', x2: '0', y2: '1' });
    grad.appendChild(svg('stop', { offset: '0', 'stop-color': '#5eead4' }));
    grad.appendChild(svg('stop', { offset: '1', 'stop-color': '#0ea5e9', 'stop-opacity': '0.55' }));
    defs.appendChild(grad);
    root.insertBefore(defs, root.firstChild);

    function refLine(value, label) {
      if (!Number.isFinite(value) || value <= 0 || value > maxVal) return;
      const x = M.left + (value / maxVal) * plotW;
      root.appendChild(svg('line', { x1: x, y1: M.top, x2: x, y2: M.top + plotH, class: 'ref-line' }));
      root.appendChild(svg('text', { x: x + 4, y: M.top + 11, class: 'ref-label' }, `${label} ${fmtMs(value)}`));
    }
    refLine(p50, 'P50');
    refLine(p95, 'P95');

    root.appendChild(svg('line', { x1: M.left, y1: M.top + plotH, x2: W - M.right, y2: M.top + plotH, class: 'axis-line' }));
    for (let i = 0; i <= 5; i += 1) {
      const value = Math.round((maxVal * i) / 5);
      const x = M.left + (plotW * i) / 5;
      root.appendChild(svg('text', { x, y: H - 14, 'text-anchor': 'middle' }, fmtMs(value)));
    }
    root.appendChild(svg('text', { x: W - M.right, y: M.top - 8, 'text-anchor': 'end' }, `共 ${values.length} 条 · 直方图按实际延迟分桶`));

    const hint = $('latencyHint');
    if (hint) {
      hint.textContent = `单条审核耗时直方图 · P50 ${fmtMs(p50)} · P95 ${fmtMs(p95)} · 均值 ${fmtMs(lat.mean)}`;
    }
  }

  // ------------------------------------------------------------------
  // 图表：分类别 F1
  // ------------------------------------------------------------------
  function renderCategoryChart(result) {
    const target = $('categoryChart');
    if (!target) return;
    const perCategory = result.metrics?.perCategory || {};
    const rows = Object.entries(perCategory)
      .map(([code, m]) => ({ code, ...m }))
      .filter((row) => row && (row.support || 0) > 0)
      .sort((a, b) => (Number(b.f1) || 0) - (Number(a.f1) || 0));
    if (!rows.length) return chartEmpty(target, '没有分类别指标');

    const rowH = 34;
    const W = 640;
    const H = Math.max(120, rows.length * rowH + 30);
    const M = { left: 92, right: 138, top: 12, bottom: 10 };
    const plotW = W - M.left - M.right;
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '分类别 F1' });
    target.textContent = '';
    target.appendChild(root);

    rows.forEach((row, index) => {
      const y = M.top + index * rowH;
      const f1 = Math.max(0, Math.min(1, Number(row.f1) || 0));
      const color = CAT_COLORS[row.code] || '#94a3b8';
      root.appendChild(svg('text', { x: M.left - 10, y: y + 18, 'text-anchor': 'end' }, catLabel(row.code)));
      root.appendChild(svg('rect', { x: M.left, y: y + 8, width: plotW, height: 12, rx: 6, fill: 'rgba(148,163,184,0.14)' }));
      root.appendChild(svg('rect', {
        x: M.left,
        y: y + 8,
        width: Math.max(1, plotW * f1).toFixed(1),
        height: 12,
        rx: 6,
        class: 'bar',
        fill: color,
        'fill-opacity': '0.9',
      }));
      root.appendChild(svg('text', { x: M.left + plotW + 10, y: y + 18 }, `${fmtPct(f1)} · n=${row.support ?? 0}`));
    });

    const panel = $('categoryPanel');
    if (panel) panel.hidden = false;
    const hint = $('categoryHint');
    if (hint) hint.textContent = `按 F1 降序 · macroF1 ${fmtPct(result.metrics?.macroCategoryF1)} · microF1 ${fmtPct(result.metrics?.microCategoryF1)}`;
  }

  // ------------------------------------------------------------------
  // 图表：混淆矩阵
  // ------------------------------------------------------------------
  function renderConfusion(result) {
    const target = $('confusionMatrix');
    const legend = $('confusionLegend');
    if (!target) return;
    const c = result.metrics?.confusion || {};
    const tp = Number(c.tp) || 0;
    const tn = Number(c.tn) || 0;
    const fp = Number(c.fp) || 0;
    const fn = Number(c.fn) || 0;

    const grid = el('div', 'cm-grid');
    grid.appendChild(el('div', 'cm-corner'));
    grid.appendChild(el('div', 'cm-col-head', '预测违规'));
    grid.appendChild(el('div', 'cm-col-head', '预测正常'));
    grid.appendChild(el('div', 'cm-row-head', '实际违规'));
    grid.appendChild(cmCell(tp, 'correct', 'TP 命中'));
    grid.appendChild(cmCell(fn, 'wrong', 'FN 漏判'));
    grid.appendChild(el('div', 'cm-row-head', '实际正常'));
    grid.appendChild(cmCell(fp, 'wrong', 'FP 误判'));
    grid.appendChild(cmCell(tn, 'correct', 'TN 正确'));
    target.textContent = '';
    target.appendChild(grid);

    if (legend) {
      legend.textContent = '';
      const b = result.metrics?.binary || {};
      const items = [
        ['TP', tp], ['TN', tn], ['FP', fp], ['FN', fn],
        ['准确率', fmtPct(b.accuracy)], ['F1', fmtPct(b.f1)],
      ];
      for (const [label, value] of items) {
        const node = el('span');
        node.appendChild(el('b', '', label));
        node.appendChild(document.createTextNode(` ${value}`));
        legend.appendChild(node);
      }
    }

    function cmCell(value, cls, tag) {
      const cell = el('div', `cm-cell ${cls}`);
      cell.appendChild(el('div', 'cm-num', String(value)));
      cell.appendChild(el('div', 'cm-tag', tag));
      return cell;
    }
  }

  // ------------------------------------------------------------------
  // 来源细分表
  // ------------------------------------------------------------------
  function renderSourceTable(result) {
    const target = $('sourceTable');
    if (!target) return;
    const bySource = result.metrics?.bySource || {};
    const names = Object.keys(bySource);
    target.textContent = '';
    if (!names.length) {
      target.appendChild(el('div', 'chart-empty', '暂无来源数据'));
      return;
    }
    const table = el('table', 'data-table');
    const thead = el('thead');
    const headRow = el('tr');
    for (const text of ['来源', '样本', '有效', '准确率', '精确率', '召回率', 'F1', '']) {
      headRow.appendChild(el('th', '', text));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    for (const name of names) {
      const m = bySource[name] || {};
      const tr = el('tr');
      tr.appendChild(el('td', '', name));
      tr.appendChild(el('td', 'num', String(m.total ?? '—')));
      tr.appendChild(el('td', 'num', String(m.valid ?? '—')));
      tr.appendChild(el('td', 'num', fmtPct(m.accuracy)));
      tr.appendChild(el('td', 'num', fmtPct(m.precision)));
      tr.appendChild(el('td', 'num', fmtPct(m.recall)));
      tr.appendChild(el('td', 'num', fmtPct(m.f1)));
      const barCell = el('td');
      const bar = el('div', `mini-bar${(Number(m.f1) || 0) < 0.5 ? ' danger' : (Number(m.f1) || 0) < 0.75 ? ' warn' : ''}`);
      const fill = el('i');
      fill.style.width = `${Math.max(0, Math.min(1, Number(m.f1) || 0)) * 100}%`;
      bar.appendChild(fill);
      barCell.appendChild(bar);
      tr.appendChild(barCell);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    target.appendChild(table);
    if ($('sourcePanel')) $('sourcePanel').hidden = false;
  }

  // ------------------------------------------------------------------
  // 样本浏览器
  // ------------------------------------------------------------------
  function filterRecords() {
    const records = Array.isArray(state.result?.records) ? state.result.records : [];
    const keyword = state.search.trim().toLowerCase();
    return records.filter((record) => {
      const pred = record.prediction;
      const gold = record.gold || {};
      const predictedViolation = pred ? pred.violation === 1 : Boolean(gold.violation);
      if (state.filter === 'wrong' && record.correct) return false;
      if (state.filter === 'violation' && !predictedViolation) return false;
      if (state.filter === 'safe' && predictedViolation) return false;
      if (state.category !== 'all') {
        const goldCats = Array.isArray(gold.categories) ? gold.categories : [];
        const predCats = pred && Array.isArray(pred.categories) ? pred.categories : [];
        if (!goldCats.includes(state.category) && !predCats.includes(state.category)) return false;
      }
      if (keyword) {
        const haystack = [
          record.id,
          record.text,
          record.source,
          pred?.reason,
          pred?.categories?.join(' '),
          gold.categories?.join(' '),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(keyword)) return false;
      }
      return true;
    });
  }

  function renderSamples() {
    const list = $('sampleList');
    if (!list) return;
    list.textContent = '';
    const records = filterRecords();
    const totalPages = Math.max(1, Math.ceil(records.length / state.pageSize));
    if (state.page > totalPages) state.page = totalPages;
    const start = (state.page - 1) * state.pageSize;
    const pageRecords = records.slice(start, start + state.pageSize);

    if (!pageRecords.length) {
      list.appendChild(el('div', 'chart-empty', '当前筛选条件下没有样本'));
    } else {
      for (const record of pageRecords) list.appendChild(renderSample(record));
    }

    const hint = $('samplesHint');
    if (hint) {
      hint.textContent = state.running
        ? '跑分进行中，完成后可逐条查看；判错样本会高亮'
        : `共 ${records.length} 条（全部 ${state.result?.records?.length ?? 0} 条） · 判错样本会高亮`;
    }

    const pager = $('pager');
    const pageInfo = $('pageInfo');
    if (pager && pageInfo) {
      pager.hidden = records.length <= state.pageSize;
      pageInfo.textContent = '';
      const b = el('b', '', String(state.page));
      pageInfo.appendChild(document.createTextNode('第 '));
      pageInfo.appendChild(b);
      pageInfo.appendChild(document.createTextNode(` / ${totalPages} 页 · 共 ${records.length} 条`));
    }
    const prev = $('prevPage');
    const next = $('nextPage');
    if (prev) prev.disabled = state.page <= 1;
    if (next) next.disabled = state.page >= totalPages;
  }

  function renderSample(record) {
    const pred = record.prediction;
    const gold = record.gold || {};
    const isError = Boolean(record.error);
    const cls = isError ? 'error' : record.correct ? 'ok' : 'wrong';
    const card = el('article', `sample ${cls}`);

    const head = el('div', 'sample-head');
    head.appendChild(el('span', 'sample-id', record.id));
    head.appendChild(el('span', 'tag src', record.source || '—'));
    if (record.sensitive) head.appendChild(el('span', 'tag sensitive', '敏感'));
    if (isError) head.appendChild(el('span', 'tag warn', '调用错误'));
    else if (record.correct) head.appendChild(el('span', 'tag good', '判对'));
    else head.appendChild(el('span', 'tag bad', '判错'));
    head.appendChild(el('span', 'spacer'));
    head.appendChild(el('span', 'tag', fmtMs(record.latencyMs)));
    card.appendChild(head);

    const masked = record.sensitive && !state.revealAll && !state.revealed.has(record.id);
    const textNode = el('div', `sample-text${masked ? ' is-masked' : ''}`, record.text);
    card.appendChild(textNode);

    if (record.sensitive) {
      const note = el('div', 'mask-note');
      note.appendChild(el('span', '', masked ? '敏感文本已打码' : '敏感文本已显示'));
      const btn = el('button', 'btn tiny ghost', masked ? '显示原文' : '隐藏原文');
      btn.type = 'button';
      btn.addEventListener('click', () => {
        if (state.revealed.has(record.id)) state.revealed.delete(record.id);
        else state.revealed.add(record.id);
        renderSamples();
      });
      if (masked) {
        textNode.addEventListener('click', () => {
          state.revealed.add(record.id);
          renderSamples();
        });
      }
      note.appendChild(btn);
      card.appendChild(note);
    }

    const predBlock = el('div', 'pred-block');
    predBlock.appendChild(el('span', 'label', '金标'));
    predBlock.appendChild(chipsFor(gold.categories));
    predBlock.appendChild(el('span', 'label', '预测'));
    predBlock.appendChild(chipsFor(pred?.categories));
    card.appendChild(predBlock);

    const meta = el('div', 'sample-meta');
    if (pred) {
      meta.appendChild(kv('严重度', String(pred.severity ?? '—')));
      meta.appendChild(kv('置信度', fmtNum(pred.confidence, 2)));
      if (pred.reason) meta.appendChild(kv('理由', pred.reason));
    }
    const tokens = record.tokens;
    if (tokens) meta.appendChild(kv('tokens', String(tokens.total ?? '—'), true));
    if (record.categoryHit !== undefined) meta.appendChild(kv('类别命中', record.categoryHit ? '是' : '否'));
    card.appendChild(meta);

    if (record.error) {
      card.appendChild(el('div', 'sample-error', `调用错误：${record.error}`));
    }
    if (record.parseError && pred === null) {
      card.appendChild(el('div', 'sample-error', '解析失败：模型输出无法解析为 JSON verdict'));
    }
    return card;
  }

  function kv(label, value, mono = false) {
    const node = el('span', `kv${mono ? ' mono' : ''}`);
    node.appendChild(el('span', '', `${label} `));
    node.appendChild(el('b', '', value));
    return node;
  }

  // ------------------------------------------------------------------
  // 跑分记录 / 多模型对比
  // ------------------------------------------------------------------
  function shortRunId(runId) {
    return String(runId || '').replace(/^bench-\d{8}-/, '');
  }

  function runColor(index) {
    return RUN_COLORS[index % RUN_COLORS.length];
  }

  function selectedRunObjects() {
    return [...state.selectedRuns]
      .map((runId) => state.historyCache.get(runId))
      .filter(Boolean);
  }

  async function loadHistory({ focusRunId = null, page = state.historyPage } = {}) {
    let data;
    const targetPage = focusRunId ? 1 : Math.max(1, page);
    try {
      data = await api(`/api/results?page=${targetPage}&pageSize=${HISTORY_PAGE_SIZE}`);
    } catch (error) {
      showToast(`加载跑分记录失败：${error.message}`, 'warn', 5000);
      return;
    }
    state.history = Array.isArray(data?.runs) ? data.runs : [];
    state.latestRunId = data?.latestResultId ?? null;
    state.historyTotal = Number(data?.total) || 0;
    state.historyPages = Number(data?.totalPages) || 1;
    state.historyPage = Number(data?.page) || targetPage;
    for (const run of state.history) state.historyCache.set(run.runId, run);

    if (focusRunId && state.historyCache.has(focusRunId) && !state.selectedRuns.has(focusRunId) && state.selectedRuns.size < COMPARE_MAX) {
      state.selectedRuns.add(focusRunId);
    }
    if (!state.compareInitialized && state.history.length) {
      for (const run of chooseInitialComparison(state.history)) state.selectedRuns.add(run.runId);
      state.compareInitialized = true;
    }
    renderHistory();
    renderCompare();
  }

  // 默认对比：优先选「全量同配置」的不同模型记录，最多 3 个，保证样本数/口径一致；
  // 没有足够全量记录时退化为最新两条不同模型记录。
  function chooseInitialComparison(history) {
    const full = history.filter((run) => Number(run.datasetTotal) > 0 && Number(run.sampleCount) === Number(run.datasetTotal));
    const distinct = [];
    const seen = new Set();
    for (const run of full) {
      const key = `${run.provider}||${run.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      distinct.push(run);
      if (distinct.length >= 3) break;
    }
    if (distinct.length >= 2) return distinct;
    const latest = history[0];
    const partner = history.find(
      (run) => run.runId !== latest.runId
        && (run.provider !== latest.provider || run.model !== latest.model)
        && run.sampleCount === latest.sampleCount,
    ) || history.find((run) => run.runId !== latest.runId && (run.provider !== latest.provider || run.model !== latest.model))
      || history[1];
    return partner ? [latest, partner] : [latest];
  }

  function renderHistory() {
    const list = $('historyList');
    const count = $('historyCount');
    if (!list) return;
    if (count) count.textContent = `${state.historyTotal} 条`;
    const clear = $('clearCompareBtn');
    if (clear) clear.hidden = state.selectedRuns.size === 0;
    const hint = $('historyHint');
    if (hint) {
      hint.textContent = state.historyTotal
        ? `共 ${state.historyTotal} 条记录 · 本页 ${state.history.length} 条 · 勾选 2 条以上做横向对比（最多 ${COMPARE_MAX} 条）`
        : '按模型分组显示每次跑分；勾选 2 条以上可做横向对比';
    }

    const pager = $('historyPager');
    const pageInfo = $('historyPageInfo');
    const prev = $('historyPrevBtn');
    const next = $('historyNextBtn');
    if (pager && pageInfo) {
      pager.hidden = state.historyPages <= 1;
      pageInfo.textContent = '';
      const b = el('b', '', String(state.historyPage));
      pageInfo.appendChild(document.createTextNode('第 '));
      pageInfo.appendChild(b);
      pageInfo.appendChild(document.createTextNode(` / ${state.historyPages} 页 · 共 ${state.historyTotal} 条`));
    }
    if (prev) prev.disabled = state.historyPage <= 1;
    if (next) next.disabled = state.historyPage >= state.historyPages;

    list.textContent = '';
    if (!state.history.length) {
      const empty = el('div', 'state-box empty', '暂无历史跑分记录。先跑一次分，结果会按模型归档在这里。');
      list.appendChild(empty);
      return;
    }

    const groups = new Map();
    for (const run of state.history) {
      const key = `${run.provider}||${run.model}`;
      if (!groups.has(key)) groups.set(key, { provider: run.provider, model: run.model, runs: [] });
      groups.get(key).runs.push(run);
    }

    for (const group of groups.values()) {
      const box = el('div', 'history-group');
      const head = el('div', 'history-group-head');
      const title = el('span', 'history-group-title');
      title.appendChild(el('span', 'prov-dot'));
      title.appendChild(el('b', '', `${group.provider} · ${group.model}`));
      head.appendChild(title);
      head.appendChild(el('span', '', `${group.runs.length} 次跑分`));
      box.appendChild(head);

      for (const run of group.runs) {
        box.appendChild(historyRow(run));
      }
      list.appendChild(box);
    }
  }

  function historyRow(run) {
    const row = el('div', 'history-item');
    row.dataset.runId = run.runId;
    if (run.runId === state.runId) row.classList.add('active');

    const checkLabel = el('label', 'history-check');
    checkLabel.title = '加入模型对比';
    const checkbox = el('input');
    checkbox.type = 'checkbox';
    checkbox.value = run.runId;
    checkbox.checked = state.selectedRuns.has(run.runId);
    checkbox.setAttribute('aria-label', `对比 ${run.provider} ${run.model} ${run.runId}`);
    checkLabel.appendChild(checkbox);
    row.appendChild(checkLabel);

    const identity = el('div', 'history-identity');
    const title = el('div', 'history-title');
    title.appendChild(el('span', 'history-provider', run.provider));
    title.appendChild(el('span', 'history-model', run.model));
    title.appendChild(el('span', 'history-runid', run.runId));
    if (run.simulated) title.appendChild(el('span', 'tag-sim', '模拟'));
    identity.appendChild(title);
    identity.appendChild(el(
      'div',
      'history-sub',
      `${fmtTime(run.startedAt)} · 样本 ${run.sampleCount}/${run.datasetTotal ?? '—'} · 并发 ${run.concurrency ?? '—'} · tokens ${fmtNum(run.tokensTotal)} · 错误 ${run.errors ?? 0}`,
    ));
    row.appendChild(identity);

    const stats = el('div', 'history-stats');
    for (const [label, value] of [
      ['准确率', fmtPct(run.accuracy)],
      ['F1', fmtNum(run.f1, 3)],
      ['P50', fmtMs(run.p50)],
      ['吞吐', `${fmtNum(run.throughputRps, 1)}/s`],
    ]) {
      const stat = el('div', 'history-stat');
      stat.appendChild(el('span', '', label));
      stat.appendChild(el('b', '', value));
      stats.appendChild(stat);
    }
    row.appendChild(stats);

    const actions = el('div', 'history-actions');
    const button = el('button', 'btn ghost tiny', run.runId === state.runId ? '当前' : '查看');
    button.type = 'button';
    button.disabled = run.runId === state.runId;
    actions.appendChild(button);

    const deleteBtn = el('button', 'btn ghost tiny history-delete', '删除');
    deleteBtn.type = 'button';
    deleteBtn.title = `删除跑分记录 ${run.runId}`;
    deleteBtn.setAttribute('aria-label', `删除跑分记录 ${run.runId}`);
    deleteBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteHistoryRun(run.runId);
    });
    actions.appendChild(deleteBtn);
    row.appendChild(actions);
    return row;
  }

  async function deleteHistoryRun(runId) {
    if (!runId) return;
    if (!window.confirm(`删除跑分记录 ${runId}？删除后不可恢复，如果它是最新记录，latest 会自动回退到上一条。`)) return;
    const deletingCurrent = state.runId === runId;
    try {
      await api(`/api/results/${encodeURIComponent(runId)}`, { method: 'DELETE' });
    } catch (error) {
      showToast(`删除 ${runId} 失败：${error.message}`, 'error', 5000);
      return;
    }
    state.historyCache.delete(runId);
    state.selectedRuns.delete(runId);
    await loadHistory({ page: state.historyPage });
    if (deletingCurrent) {
      try {
        const latest = await api('/api/results/latest');
        if (latest) {
          renderResult(latest);
        } else {
          state.result = null;
          state.runId = null;
          state.page = 1;
          renderOverview(null);
          renderSamples();
          if ($('overviewHint')) $('overviewHint').textContent = '暂无跑分结果';
        }
      } catch (error) {
        showToast(`刷新最新结果失败：${error.message}`, 'warn', 5000);
      }
    }
    showToast(`已删除 ${runId}`, 'success', 2600);
  }

  async function loadRun(runId, { scroll = false } = {}) {
    if (!runId) return;
    try {
      const result = await api(`/api/results/${encodeURIComponent(runId)}`);
      renderResult(result);
      renderHistory();
      if (scroll) {
        $('overviewPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } catch (error) {
      showToast(`加载跑分 ${runId} 失败：${error.message}`, 'error', 5000);
    }
  }

  function toggleCompare(runId, checked) {
    if (!runId) return;
    if (checked) {
      if (state.selectedRuns.size >= COMPARE_MAX && !state.selectedRuns.has(runId)) {
        showToast(`最多同时对比 ${COMPARE_MAX} 条记录`, 'warn', 3200);
        renderHistory();
        return;
      }
      state.selectedRuns.add(runId);
    } else {
      state.selectedRuns.delete(runId);
    }
    renderHistory();
    renderCompare();
  }

  function compareMetricRows() {
    return [
      { label: '样本数', get: (run) => Number(run.sampleCount) || 0, format: (v) => fmtNum(v), best: null },
      { label: '并发', get: (run) => Number(run.concurrency) || 0, format: (v) => (v ? String(v) : '—'), best: null },
      { label: '准确率', get: (run) => Number(run.accuracy) || 0, format: (v) => fmtPct(v, 2), best: 'max' },
      { label: '精确率', get: (run) => Number(run.precision) || 0, format: (v) => fmtPct(v, 2), best: 'max' },
      { label: '召回率', get: (run) => Number(run.recall) || 0, format: (v) => fmtPct(v, 2), best: 'max' },
      { label: 'F1', get: (run) => Number(run.f1) || 0, format: (v) => fmtPct(v, 2), best: 'max' },
      { label: 'macro-F1', get: (run) => Number(run.macroF1) || 0, format: (v) => fmtNum(v, 3), best: 'max' },
      { label: 'P50 延迟', get: (run) => Number(run.p50) || 0, format: (v) => fmtMs(v), best: 'min' },
      { label: 'P95 延迟', get: (run) => Number(run.p95) || 0, format: (v) => fmtMs(v), best: 'min' },
      { label: '吞吐', get: (run) => Number(run.throughputRps) || 0, format: (v) => `${fmtNum(v, 2)} req/s`, best: 'max' },
      { label: '总耗时', get: (run) => Number(run.totalWallMs) || 0, format: (v) => fmtDuration(v), best: 'min' },
      { label: 'Tokens 总量', get: (run) => Number(run.tokensTotal) || 0, format: (v) => fmtNum(v), best: null },
      { label: '调用错误', get: (run) => Number(run.errors) || 0, format: (v) => String(v), best: null },
      { label: '完成时间', get: (run) => run.finishedAt || '', format: (v) => (v ? fmtTime(v) : '—'), best: null },
    ];
  }

  function renderCompareTable(runs) {
    const wrap = $('compareTable');
    if (!wrap) return;
    wrap.textContent = '';
    const table = el('table', 'compare-table');
    const thead = el('thead');
    const headRow = el('tr');
    headRow.appendChild(el('th', '', '指标'));
    runs.forEach((run, index) => {
      const th = el('th');
      const dot = el('span', 'legend-dot');
      dot.style.background = runColor(index);
      dot.style.marginRight = '6px';
      th.appendChild(dot);
      th.appendChild(el('span', 'th-model', run.model));
      th.appendChild(el('span', 'th-sub', `${run.provider} · #${shortRunId(run.runId)}`));
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    for (const metric of compareMetricRows()) {
      const tr = el('tr');
      tr.appendChild(el('td', '', metric.label));
      const values = runs.map((run) => metric.get(run));
      let bestValue = null;
      if (metric.best) {
        const numeric = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
        if (numeric.length) bestValue = metric.best === 'max' ? Math.max(...numeric) : Math.min(...numeric);
      }
      values.forEach((value) => {
        const td = el('td', '', metric.format(value));
        if (bestValue !== null && typeof value === 'number' && value === bestValue) td.classList.add('best');
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  function compareLegend(target, runs) {
    if (!target) return;
    target.textContent = '';
    runs.forEach((run, index) => {
      const item = el('span', 'legend-item');
      const dot = el('span', 'legend-dot');
      dot.style.background = runColor(index);
      item.appendChild(dot);
      const label = el('span', 'legend-label', `${run.provider} · ${run.model} #${shortRunId(run.runId)}`);
      label.title = `${run.provider} · ${run.model} · ${run.runId}`;
      item.appendChild(label);
      target.appendChild(item);
    });
  }

  function renderCompareQuality(runs) {
    const target = $('compareQualityChart');
    const legend = $('compareLegend');
    if (!target) return;
    compareLegend(legend, runs);
    target.textContent = '';
    const groups = [
      { label: '准确率', get: (run) => Number(run.accuracy) || 0 },
      { label: '精确率', get: (run) => Number(run.precision) || 0 },
      { label: '召回率', get: (run) => Number(run.recall) || 0 },
      { label: 'F1', get: (run) => Number(run.f1) || 0 },
    ];
    const W = 680;
    const H = 272;
    const M = { left: 42, right: 12, top: 22, bottom: 40 };
    const plotW = W - M.left - M.right;
    const plotH = H - M.top - M.bottom;
    const groupW = plotW / groups.length;
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '模型质量指标对比' });

    for (let tick = 0; tick <= 1.0001; tick += 0.25) {
      const y = M.top + plotH * (1 - tick);
      root.appendChild(svg('line', { x1: M.left, y1: y, x2: M.left + plotW, y2: y, class: 'grid-line' }));
      root.appendChild(svg('text', { x: M.left - 8, y: y + 3, 'text-anchor': 'end' }, `${Math.round(tick * 100)}%`));
    }

    const gap = 4;
    const innerGroup = groupW - 16;
    const barW = Math.max(8, Math.min(32, (innerGroup - gap * (runs.length - 1)) / runs.length));
    const totalW = barW * runs.length + gap * (runs.length - 1);

    groups.forEach((group, groupIndex) => {
      const center = M.left + groupW * groupIndex + groupW / 2;
      const startX = center - totalW / 2;
      runs.forEach((run, runIndex) => {
        const value = Math.max(0, Math.min(1, group.get(run)));
        const barH = Math.max(1, plotH * value);
        const x = startX + runIndex * (barW + gap);
        const y = M.top + plotH - barH;
        root.appendChild(svg('rect', {
          x,
          y,
          width: barW,
          height: barH,
          rx: Math.min(4, barW / 2),
          class: 'bar',
          fill: runColor(runIndex),
          'fill-opacity': '0.92',
        }));
        if (runs.length <= 4) {
          root.appendChild(svg('text', {
            x: x + barW / 2,
            y: Math.max(M.top + 10, y - 4),
            'text-anchor': 'middle',
            class: 'bar-value',
          }, fmtPct(value, 0)));
        }
      });
      root.appendChild(svg('text', { x: center, y: H - 14, 'text-anchor': 'middle' }, group.label));
    });

    target.appendChild(root);
  }

  function hbarSection(target, title, runs, { get, format, scale = 'linear', lowerBetter = false }) {
    const section = el('div', 'hbar-section');
    section.appendChild(el('div', 'hbar-title', title));
    const values = runs.map((run) => Math.max(0, Number(get(run)) || 0));
    const max = Math.max(...values, 0);
    const minPositive = Math.min(...values.filter((v) => v > 0), max || 1);
    values.forEach((value, index) => {
      const row = el('div', 'hbar-row');
      const label = el('span', 'hbar-label', `${runs[index].model} #${shortRunId(runs[index].runId)}`);
      label.title = `${runs[index].provider} · ${runs[index].model} · ${runs[index].runId}`;
      row.appendChild(label);
      const track = el('div', 'hbar-track');
      const fill = el('div', 'hbar-fill');
      let ratio = 0;
      if (max > 0 && value > 0) {
        if (scale === 'log') {
          const floor = Math.max(1, minPositive * 0.35);
          ratio = Math.log10(value / floor) / Math.max(0.0001, Math.log10(max / floor));
        } else {
          ratio = value / max;
        }
      }
      fill.style.width = `${Math.max(2, Math.min(100, ratio * 100)).toFixed(1)}%`;
      fill.style.background = runColor(index);
      fill.style.opacity = lowerBetter ? '0.95' : '0.9';
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el('span', 'hbar-value', format(value)));
      section.appendChild(row);
    });
    target.appendChild(section);
  }

  function renderCompareSpeed(runs) {
    const target = $('compareSpeedChart');
    if (!target) return;
    target.textContent = '';
    hbarSection(target, 'P50 延迟（越短越好）', runs, {
      get: (run) => run.p50,
      format: (v) => fmtMs(v),
      scale: 'log',
      lowerBetter: true,
    });
    hbarSection(target, 'P95 延迟（越短越好）', runs, {
      get: (run) => run.p95,
      format: (v) => fmtMs(v),
      scale: 'log',
      lowerBetter: true,
    });
    hbarSection(target, '吞吐 req/s（越高越好）', runs, {
      get: (run) => run.throughputRps,
      format: (v) => `${fmtNum(v, 2)}/s`,
    });
  }

  function renderCompareCategory(runs) {
    const wrap = $('compareCategoryTable');
    if (!wrap) return;
    wrap.textContent = '';
    const codes = [...new Set(runs.flatMap((run) => Object.keys(run.perCategory || {})))];
    if (!codes.length) {
      wrap.appendChild(el('div', 'chart-empty', '没有分类别指标'));
      return;
    }
    const supportOf = (run, code) => Number(run.perCategory?.[code]?.support) || 0;
    codes.sort((a, b) => supportOf(runs[0], b) - supportOf(runs[0], a) || a.localeCompare(b));
    const table = el('table', 'compare-table');
    const thead = el('thead');
    const headRow = el('tr');
    headRow.appendChild(el('th', '', '类别'));
    headRow.appendChild(el('th', '', '支持数'));
    runs.forEach((run, index) => {
      const th = el('th');
      const dot = el('span', 'legend-dot');
      dot.style.background = runColor(index);
      dot.style.marginRight = '6px';
      th.appendChild(dot);
      th.appendChild(el('span', 'th-model', run.model));
      th.appendChild(el('span', 'th-sub', `${run.provider} · #${shortRunId(run.runId)}`));
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = el('tbody');
    for (const code of codes) {
      const tr = el('tr');
      tr.appendChild(el('td', '', catLabel(code)));
      tr.appendChild(el('td', '', String(supportOf(runs[0], code))));
      const f1Values = runs.map((run) => Number(run.perCategory?.[code]?.f1));
      const best = Math.max(...f1Values.filter((v) => Number.isFinite(v)), -1);
      f1Values.forEach((f1) => {
        const value = Number.isFinite(f1) ? f1 : 0;
        const td = el('td', '', Number.isFinite(f1) ? fmtPct(f1, 2) : '—');
        if (Number.isFinite(f1) && Math.abs(f1 - best) < 1e-9) td.classList.add('best');
        td.style.background = `rgba(94, 234, 212, ${(0.03 + value * 0.14).toFixed(3)})`;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  function renderCompare() {
    const panel = $('comparePanel');
    if (!panel) return;
    const runs = selectedRunObjects();
    const clear = $('clearCompareBtn');
    if (clear) clear.hidden = state.selectedRuns.size === 0;
    if (runs.length < 2) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const count = $('compareCount');
    if (count) count.textContent = `${runs.length} 条记录`;

    const hint = $('compareHint');
    if (hint) hint.textContent = '同一批数据、同一套决策逻辑下，不同模型/不同配置的并排对比';

    const warning = $('compareWarning');
    if (warning) {
      const warnings = [];
      const sampleSet = new Set(runs.map((run) => Number(run.sampleCount) || 0));
      const concurrencySet = new Set(runs.map((run) => run.concurrency));
      if (sampleSet.size > 1) {
        warnings.push(`样本数不同（${runs.map((run) => run.sampleCount).join(' / ')}），准确率/F1 的可比性有限`);
      }
      if (concurrencySet.size > 1) {
        warnings.push(`并发不同（${[...concurrencySet].join(' / ')}），延迟与吞吐不可直接比较`);
      }
      if (runs.some((run) => run.simulated) && runs.some((run) => !run.simulated)) {
        warnings.push('包含 mock 模拟结果，不能与真实模型结果对比');
      }
      warning.hidden = warnings.length === 0;
      warning.textContent = warnings.join('；');
    }

    renderCompareTable(runs);
    renderCompareQuality(runs);
    renderCompareSpeed(runs);
    renderCompareCategory(runs);
  }

  // ------------------------------------------------------------------
  // 结果渲染入口
  // ------------------------------------------------------------------
  function renderResult(result) {
    if (!result) return;
    state.result = result;
    state.runId = result.runId || null;
    state.page = 1;
    renderOverview(result);
    if ($('chartGrid')) $('chartGrid').hidden = false;
    renderLatencyChart(result);
    renderConfusion(result);
    renderCategoryChart(result);
    renderSourceTable(result);
    renderSamples();
    const exportBtn = $('exportBtn');
    if (exportBtn) exportBtn.disabled = state.running || !result.records?.length;
    const overviewHint = $('overviewHint');
    if (overviewHint) {
      const latestId = state.latestRunId || state.history[0]?.runId;
      const suffix = latestId === result.runId ? '（最新一次）' : '';
      overviewHint.textContent = `当前查看：${result.runId} · ${result.provider}/${result.model}${suffix}`;
    }
    if (state.history.length) renderHistory();
  }

  // ------------------------------------------------------------------
  // 跑分流程
  // ------------------------------------------------------------------
  function selectedLimit() {
    const select = $('limitSelect');
    const value = select ? select.value : 'all';
    if (value === 'all') return null;
    if (value === 'custom') {
      const input = $('customLimit');
      const n = Number(input && input.value);
      if (!Number.isFinite(n) || n < 1) throw new Error('自定义样本数必须是正整数');
      return Math.floor(n);
    }
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  }

  function setRunning(running) {
    state.running = running;
    const startBtn = $('startBtn');
    const exportBtn = $('exportBtn');
    if (startBtn) startBtn.disabled = running;
    if (exportBtn) exportBtn.disabled = running || !state.result?.records?.length;
    const pill = $('runStatePill');
    if (pill && running) {
      pill.hidden = false;
      pill.className = 'pill running';
      pill.textContent = '跑分中';
    }
  }

  function stopTimers() {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
    if (state.elapsedTimer) {
      clearInterval(state.elapsedTimer);
      state.elapsedTimer = null;
    }
  }

  function updateProgress(done, total, runId) {
    const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
    if ($('progressCount')) $('progressCount').textContent = `${done} / ${total}`;
    if ($('progressPct')) $('progressPct').textContent = `${pct.toFixed(pct >= 10 ? 0 : 1)}%`;
    if ($('progressFill')) $('progressFill').style.width = `${pct}%`;
    if ($('progressRunId')) $('progressRunId').textContent = runId ? `runId ${runId}` : '';
  }

  function tickElapsed() {
    if ($('progressElapsed')) {
      $('progressElapsed').textContent = `已用时 ${fmtDuration(Date.now() - state.runStartedAt)}`;
    }
  }

  async function startBenchmark(event) {
    if (event) event.preventDefault();
    if (state.running) return;
    let limit;
    try {
      limit = selectedLimit();
    } catch (error) {
      showToast(error.message);
      return;
    }
    const provider = $('providerSelect')?.value || state.config?.defaultProvider;
    const model = $('modelSelect')?.value || state.config?.defaultModel;
    const concurrency = Number($('concurrencySelect')?.value || 4);

    state.runStartedAt = Date.now();
    state.revealed.clear();
    state.page = 1;
    setRunning(true);
    setErrorBanner('');
    const progressWrap = $('progressWrap');
    if (progressWrap) progressWrap.hidden = false;
    if ($('progressTrack')) $('progressTrack').classList.add('indeterminate');
    if ($('progressSpinner')) $('progressSpinner').className = 'spinner';
    if ($('progressText')) $('progressText').textContent = '正在创建跑分任务…';
    updateProgress(0, 0, '');
    tickElapsed();
    state.elapsedTimer = setInterval(tickElapsed, 500);

    const pill = $('runStatePill');
    if (pill) {
      pill.hidden = false;
      pill.className = 'pill running';
      pill.textContent = '跑分中';
    }

    try {
      const body = { concurrency, provider, model };
      if (limit !== null) body.limit = limit;
      const created = await api('/api/benchmark', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const runId = created?.runId;
      if (!runId) throw new Error('后端未返回 runId');
      if ($('progressText')) $('progressText').textContent = '审核中…';
      updateProgress(0, limit || state.config?.datasetTotal || 0, runId);
      pollBenchmark(runId);
    } catch (error) {
      finishRun('error', error.message);
    }
  }

  async function pollBenchmark(runId) {
    try {
      const status = await api(`/api/benchmark/${encodeURIComponent(runId)}`);
      const done = Number(status.done) || 0;
      const total = Number(status.total) || 0;
      if ($('progressTrack')) $('progressTrack').classList.remove('indeterminate');
      updateProgress(done, total, runId);
      if ($('progressText')) {
        $('progressText').textContent =
          status.status === 'queued' ? '排队中…' : status.status === 'running' ? '审核中…' : '收尾中…';
      }
      if (status.status === 'done') {
        const resultId = status.resultId || runId;
        let result = null;
        try {
          result = await api(`/api/results/${encodeURIComponent(resultId)}`);
        } catch (error) {
          showToast(`拉取结果失败：${error.message}`);
        }
        if (result) {
          renderResult(result);
          updateProgress(
            result.metrics?.binary?.total ?? total,
            result.metrics?.binary?.total ?? total,
            result.runId || runId,
          );
        }
        finishRun('done');
        loadHistory({ focusRunId: resultId });
        return;
      }
      if (status.status === 'error') {
        finishRun('error', status.error || '跑分失败');
        return;
      }
      state.pollTimer = setTimeout(() => pollBenchmark(runId), 500);
    } catch (error) {
      finishRun('error', error.message);
    }
  }

  function finishRun(status, message) {
    stopTimers();
    setRunning(false);
    const pill = $('runStatePill');
    if (pill) {
      pill.hidden = false;
      pill.className = `pill ${status === 'done' ? 'done' : 'error'}`;
      pill.textContent = status === 'done' ? '已完成' : '失败';
    }
    if ($('progressSpinner')) {
      $('progressSpinner').className = status === 'done' ? 'spinner done' : 'spinner failed';
    }
    if ($('progressText')) {
      $('progressText').textContent = status === 'done' ? '跑分完成' : `跑分失败：${message || '未知错误'}`;
    }
    if ($('progressTrack')) $('progressTrack').classList.remove('indeterminate');
    if (status === 'error') {
      showToast(message || '跑分失败', 'error', 6000);
      setErrorBanner(`跑分失败：${message || '未知错误'}`);
    } else {
      showToast('跑分完成，指标与样本已刷新', 'success', 2600);
    }
  }

  // ------------------------------------------------------------------
  // CSV 导出
  // ------------------------------------------------------------------
  function csvCell(value) {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function exportCsv() {
    const result = state.result;
    if (!result || !Array.isArray(result.records) || !result.records.length) {
      showToast('没有可导出的结果，请先跑分', 'warn');
      return;
    }
    const header = [
      'id', 'source', 'sensitive', 'gold_violation', 'gold_categories', 'pred_violation',
      'pred_categories', 'severity', 'confidence', 'correct', 'category_hit', 'latencyMs',
      'tokens_prompt', 'tokens_total', 'parseError', 'error', 'text', 'reason',
    ];
    const lines = [header.join(',')];
    for (const r of result.records) {
      const gold = r.gold || {};
      const pred = r.prediction || {};
      const tokens = r.tokens || {};
      lines.push([
        csvCell(r.id),
        csvCell(r.source),
        csvCell(r.sensitive ? 1 : 0),
        csvCell(gold.violation ? 1 : 0),
        csvCell((gold.categories || []).join('|')),
        csvCell(pred.violation ?? ''),
        csvCell((pred.categories || []).join('|')),
        csvCell(pred.severity ?? ''),
        csvCell(pred.confidence ?? ''),
        csvCell(r.correct ? 1 : 0),
        csvCell(r.categoryHit ? 1 : 0),
        csvCell(Math.round(Number(r.latencyMs) || 0)),
        csvCell(tokens.prompt ?? ''),
        csvCell(tokens.total ?? ''),
        csvCell(r.parseError ? 1 : 0),
        csvCell(r.error || ''),
        csvCell(r.text || ''),
        csvCell(pred.reason || ''),
      ].join(','));
    }
    const blob = new Blob([`\ufeff${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${result.runId || 'moderation-result'}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast(`已导出 ${result.records.length} 条结果`, 'success', 2400);
  }

  // ------------------------------------------------------------------
  // 单条体验
  // ------------------------------------------------------------------
  function renderVerdict(response) {
    const wrap = $('verdictCard');
    const empty = $('verdictEmpty');
    if (!wrap) return;
    if (empty) empty.hidden = true;
    wrap.textContent = '';
    const verdict = response.verdict || {};
    const violation = verdict.violation === 1;
    const card = el('div', 'verdict-card');

    const head = el('div', 'verdict-head');
    head.appendChild(el('span', `verdict-status ${violation ? 'violation' : 'safe'}`, violation ? '违规' : '正常'));
    head.appendChild(chipsFor(verdict.categories));
    const meta = el('span', 'verdict-meta', `${response.provider || '—'} · ${response.model || '—'} · ${fmtMs(response.latencyMs)}`);
    head.appendChild(meta);
    card.appendChild(head);

    const metrics = el('div', 'verdict-metrics');
    const severity = Number(verdict.severity) || 0;
    const sevDots = el('span', 'sev-dots');
    for (let i = 1; i <= 3; i += 1) {
      const dot = el('i');
      if (i <= severity) dot.className = `on-${severity}`;
      sevDots.appendChild(dot);
    }
    const sevBox = el('div', 'vmetric');
    sevBox.appendChild(el('div', 'label', '严重度 severity'));
    const sevValue = el('div', 'value');
    sevValue.appendChild(sevDots);
    sevValue.appendChild(document.createTextNode(` ${severity}`));
    sevBox.appendChild(sevValue);
    metrics.appendChild(sevBox);

    const confBox = el('div', 'vmetric');
    confBox.appendChild(el('div', 'label', '置信度 confidence'));
    confBox.appendChild(el('div', 'value', fmtNum(verdict.confidence, 2)));
    const confBar = el('div', 'conf-bar');
    const confFill = el('i');
    confFill.style.width = `${Math.max(0, Math.min(1, Number(verdict.confidence) || 0)) * 100}%`;
    confBar.appendChild(confFill);
    confBox.appendChild(confBar);
    metrics.appendChild(confBox);

    const tokens = response.tokens?.total ?? '—';
    const tokBox = el('div', 'vmetric');
    tokBox.appendChild(el('div', 'label', 'tokens / 错误'));
    tokBox.appendChild(el('div', 'value', String(tokens)));
    tokBox.appendChild(el('div', 'kpi-sub', response.parseError ? '解析失败' : '解析成功'));
    metrics.appendChild(tokBox);
    card.appendChild(metrics);

    const reason = el('div', 'verdict-reason');
    reason.appendChild(el('span', 'label', '判定理由'));
    reason.appendChild(document.createTextNode(verdict.reason || '（模型未给出理由）'));
    card.appendChild(reason);

    if (response.raw) {
      const details = el('details', 'raw');
      details.appendChild(el('summary', '', '原始响应'));
      details.appendChild(el('pre', '', response.raw));
      card.appendChild(details);
    }

    wrap.appendChild(card);
    wrap.hidden = false;
  }

  async function runModerate() {
    const input = $('moderateText');
    const button = $('moderateBtn');
    const text = (input?.value || '').trim();
    if (!text) {
      showToast('请先输入待审核文本', 'warn');
      input?.focus();
      return;
    }
    const provider = $('providerSelect')?.value || state.config?.defaultProvider;
    const model = $('modelSelect')?.value || state.config?.defaultModel;
    if (button) button.disabled = true;
    const empty = $('verdictEmpty');
    if (empty) {
      empty.hidden = false;
      empty.textContent = '审核中…';
    }
    try {
      const response = await api('/api/moderate', {
        method: 'POST',
        body: JSON.stringify({ text, provider, model }),
      });
      renderVerdict(response);
    } catch (error) {
      const wrap = $('verdictCard');
      if (wrap) wrap.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = `审核失败：${error.message}`;
      }
      showToast(`审核失败：${error.message}`, 'error', 6000);
    } finally {
      if (button) button.disabled = false;
    }
  }

  // ------------------------------------------------------------------
  // 事件绑定
  // ------------------------------------------------------------------
  function bindEvents() {
    $('refreshBtn')?.addEventListener('click', () => loadAll(true));
    $('retryBtn')?.addEventListener('click', () => loadAll(true));

    $('runForm')?.addEventListener('submit', startBenchmark);
    $('emptyStartBtn')?.addEventListener('click', () => {
      $('runPanel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(startBenchmark, 120);
    });
    $('exportBtn')?.addEventListener('click', exportCsv);

    $('historyList')?.addEventListener('click', (event) => {
      const item = event.target.closest('.history-item');
      if (!item) return;
      if (event.target.closest('.history-check')) return;
      loadRun(item.dataset.runId, { scroll: event.target.closest('button') !== null });
    });
    $('historyList')?.addEventListener('change', (event) => {
      const checkbox = event.target.closest('input[type="checkbox"]');
      if (!checkbox) return;
      toggleCompare(checkbox.value, checkbox.checked);
    });
    $('clearCompareBtn')?.addEventListener('click', () => {
      state.selectedRuns.clear();
      renderHistory();
      renderCompare();
    });
    $('historyPrevBtn')?.addEventListener('click', () => {
      if (state.historyPage <= 1) return;
      loadHistory({ page: state.historyPage - 1 });
      $('historyPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('historyNextBtn')?.addEventListener('click', () => {
      if (state.historyPage >= state.historyPages) return;
      loadHistory({ page: state.historyPage + 1 });
      $('historyPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    const limitSelect = $('limitSelect');
    limitSelect?.addEventListener('change', () => {
      const wrap = $('customLimitWrap');
      if (wrap) wrap.hidden = limitSelect.value !== 'custom';
    });

    $('providerSelect')?.addEventListener('change', (event) => {
      updateMockBanner(event.target.value);
      updateProviderWarn(event.target.value);
      refreshModelOptions(event.target.value);
    });

    $('verdictFilter')?.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-filter]');
      if (!btn) return;
      state.filter = btn.dataset.filter;
      state.page = 1;
      for (const node of $('verdictFilter').querySelectorAll('button')) {
        node.classList.toggle('active', node === btn);
        node.setAttribute('aria-pressed', node === btn ? 'true' : 'false');
      }
      renderSamples();
    });

    $('categoryFilter')?.addEventListener('change', (event) => {
      state.category = event.target.value;
      state.page = 1;
      renderSamples();
    });

    let searchTimer = null;
    $('searchInput')?.addEventListener('input', (event) => {
      const value = event.target.value || '';
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.search = value;
        state.page = 1;
        renderSamples();
      }, 180);
    });

    $('prevPage')?.addEventListener('click', () => {
      state.page = Math.max(1, state.page - 1);
      renderSamples();
      $('samplesPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('nextPage')?.addEventListener('click', () => {
      state.page += 1;
      renderSamples();
      $('samplesPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    $('revealAllBtn')?.addEventListener('click', () => {
      state.revealAll = !state.revealAll;
      const btn = $('revealAllBtn');
      if (btn) {
        btn.textContent = state.revealAll ? '全部打码' : '全部显示原文';
        btn.setAttribute('aria-pressed', state.revealAll ? 'true' : 'false');
      }
      renderSamples();
    });

    const textarea = $('moderateText');
    const counter = $('moderateCounter');
    textarea?.addEventListener('input', () => {
      if (counter) counter.textContent = `${textarea.value.length} / 2000`;
    });
    $('moderateClear')?.addEventListener('click', () => {
      if (textarea) textarea.value = '';
      if (counter) counter.textContent = '0 / 2000';
      if ($('verdictCard')) $('verdictCard').hidden = true;
      if ($('verdictEmpty')) {
        $('verdictEmpty').hidden = false;
        $('verdictEmpty').textContent = '输入文本后点击「审核」，结果会显示在这里。';
      }
      textarea?.focus();
    });
    $('moderateBtn')?.addEventListener('click', runModerate);
    textarea?.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        runModerate();
      }
    });
  }

  // ------------------------------------------------------------------
  // 初始化
  // ------------------------------------------------------------------
  async function loadAll(showToasts = false) {
    setConn('loading', '连接中…');
    if ($('overviewLoading')) $('overviewLoading').hidden = false;
    try {
      const [health, config] = await Promise.all([api('/api/health'), api('/api/config')]);
      state.health = health;
      state.config = config;
      state.latestRunId = config.latestResultId || null;
      state.categories = Array.isArray(config.taxonomy) ? config.taxonomy : [];
      state.providerModels =
        config.providerModels && typeof config.providerModels === 'object'
          ? config.providerModels
          : null;
      setBadges(health, config);
      populateControls();
      renderTaxonomy();
      populateCategoryFilter();
      setConn(health.provider === 'mock' ? 'demo' : 'online', health.provider === 'mock' ? '演示模式' : '已连接');
      setErrorBanner('');
      if (health.dataset?.fallback) {
        showToast('数据集加载失败，后端使用了内置兜底样本', 'warn', 6000);
      }
    } catch (error) {
      setConn('offline', '连接失败');
      setErrorBanner(`无法连接后端接口：${error.message}`);
      showToast(`加载配置失败：${error.message}`, 'error', 6000);
      if ($('overviewLoading')) $('overviewLoading').hidden = true;
      return;
    }

    // 最新结果
    try {
      const latest = await api('/api/results/latest');
      if (latest) {
        renderResult(latest);
      } else {
        renderOverview(null);
        renderSamples();
      }
    } catch (error) {
      showToast(`加载最新结果失败：${error.message}`, 'warn', 5000);
      renderOverview(null);
    }

    try {
      await loadHistory();
    } catch (error) {
      showToast(`加载跑分记录失败：${error.message}`, 'warn', 5000);
    }

    if (showToasts) showToast('已刷新配置与最新结果', 'success', 2200);
  }

  function populateCategoryFilter() {
    const select = $('categoryFilter');
    if (!select) return;
    const current = select.value || 'all';
    select.textContent = '';
    const all = el('option', '', '全部类别');
    all.value = 'all';
    select.appendChild(all);
    for (const item of state.categories) {
      const option = el('option', '', `${item.label}（${item.code}）`);
      option.value = item.code;
      select.appendChild(option);
    }
    select.value = [...select.options].some((o) => o.value === current) ? current : 'all';
    state.category = select.value;
  }

  function boot() {
    bindEvents();
    loadAll(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
