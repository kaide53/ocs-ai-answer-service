'use strict';
/**
 * 渲染器：一个**固定在原地的窗口**，支持并发分屏。
 *
 * 布局：
 *   1 题  → 整宽单栏
 *   N 题  → N 栏并排（`│` 分隔），每栏各自是"题目框 + 思考 + 逐项判定 + 结论"
 *   栏数上限取 min(活跃题数, UI_MAX_PANES, 按宽度能放下的栏数)
 *   放不下的题在窗口底部列一行「还有 N 题进行中：#x #y」
 *
 * 三种输出策略：
 *  1. plain  —— 非 TTY / TERM=dumb / UI_STYLE=plain。**逐字节复刻加 UI 之前的输出**，绝不出现 ANSI。
 *  2. window —— 真终端。整块区域原地重绘（frame），做完的题不残留。
 *  3. append —— 富界面 + 非原地（管道/日志/demo）。只追加新增行，无光标控制码；
 *               并发时每行加 `[#N]` 前缀，否则日志里分不清是哪道题。
 *
 * 设计约束：
 *  - 渲染器不直接碰 `process.stdout`，一切经注入的 `write`，因此可在无 TTY 下单测；
 *  - 所有写入包 try/catch——**UI 出错绝不允许影响答题**；
 *  - window 模式下整屏每次完整替换，所以并发交错**在结构上不可能发生**。
 */
const cfg = require('../config');
const { strWidth } = require('./width');
const { stripAnsi } = require('./box');
const { createTheme, shouldColor } = require('./theme');
const { createStreamView } = require('./stream-view');
const { createFrame } = require('./frame');
const screen = require('./screen');

const {
  composeScreen, composeWindow, composeIdle, fmtMs,
  TYPE_LABEL, SOURCE_LABEL, STRATEGY_LABEL,
} = screen;

const DEFAULT_ROWS = 24;
const PAINT_INTERVAL_MS = 120;

/** 增量行写入器：把流式片段按宽度折行并逐行吐出（append 模式用） */
function createLineWriter(emit, width, indent = '') {
  let cur = '';
  let curW = strWidth(indent);
  return {
    push(text) {
      for (const ch of String(text == null ? '' : text)) {
        if (ch === '\n') { emit(indent + cur); cur = ''; curW = strWidth(indent); continue; }
        const cw = strWidth(ch);
        if (curW + cw > width && cur !== '') { emit(indent + cur); cur = ''; curW = strWidth(indent); }
        cur += ch;
        curW += cw;
      }
    },
    flush() {
      if (cur !== '') { emit(indent + cur); cur = ''; curW = strWidth(indent); }
    },
    get pending() { return cur; },
  };
}

/**
 * 把题目归一化成渲染器可以无条件信任的形状。
 *
 * 为什么不靠 try/catch 兜：捕获块自己也会碰到同样的空字段再抛一次，
 * 异常会逃逸到答题链路。入口处一次性补齐默认值才是真正的隔离。
 */
function safeQuestion(q) {
  const s = q && typeof q === 'object' ? q : {};
  const flags = Object.assign({ hasImage: false, imageUrls: [], completionUnsafe: false }, (s.flags && typeof s.flags === 'object') ? s.flags : {});
  return {
    title: String(s.title == null ? '' : s.title),
    options: Array.isArray(s.options)
      ? s.options.filter(Boolean).map((o, i) => ({
        label: String((o && o.label) || String.fromCharCode(65 + i)),
        text: String((o && o.text) == null ? '' : o.text),
      }))
      : [],
    type: String(s.type || 'unknown'),
    typeSource: String(s.typeSource || 'shape'),
    rawType: s.rawType === undefined ? null : s.rawType,
    images: Array.isArray(s.images) ? s.images : [],
    blankCount: Number(s.blankCount) || 0,
    flags: {
      hasImage: Boolean(flags.hasImage),
      imageUrls: Array.isArray(flags.imageUrls) ? flags.imageUrls : [],
      completionUnsafe: Boolean(flags.completionUnsafe),
    },
  };
}

/**
 * @param {object} [opts]
 * @param {(s:string)=>void} [opts.write]   输出通道（默认 process.stdout.write）
 * @param {number} [opts.columns]
 * @param {number} [opts.rows]
 * @param {boolean} [opts.isTTY]
 * @param {boolean} [opts.repaint]  是否原地重绘。默认跟随 isTTY；测试可显式指定
 * @param {object} [opts.env]
 * @param {string} [opts.style]  auto | rich | plain
 * @param {string} [opts.color]  auto | always | never
 * @param {number} [opts.width]  0 = 自动
 * @param {number} [opts.dwellMs]    答完驻留多久再收起该栏；0 = 立刻收起
 * @param {number} [opts.maxPanes]
 * @param {number} [opts.minPaneWidth]
 * @param {(fn:Function)=>any} [opts.onResize] 订阅终端尺寸变化（测试可注入，避免真的挂 SIGWINCH）
 */
function createUi(opts = {}) {
  const env = opts.env || process.env;
  const out = opts.write || ((s) => process.stdout.write(s));
  const isTTY = opts.isTTY === undefined ? Boolean(process.stdout.isTTY) : Boolean(opts.isTTY);

  const style = String(opts.style || cfg.UI.STYLE || 'auto').toLowerCase();
  const rich = style === 'rich' ? true
    : style === 'plain' ? false
      : (isTTY && String(env.TERM || '').toLowerCase() !== 'dumb');

  const colorMode = opts.color || cfg.UI.COLOR || 'auto';
  const color = shouldColor(colorMode, env, isTTY);
  const theme = createTheme({ enabled: color });

  // 原地重绘只对真终端有意义；注入了自定义 write 时默认关闭（测试/管道）
  const repaint = opts.repaint === undefined
    ? (isTTY && !opts.write)
    : Boolean(opts.repaint);

  const dwellMs = opts.dwellMs === undefined ? Number(cfg.UI.DWELL_MS) || 0 : Number(opts.dwellMs) || 0;
  const maxPanes = Math.max(1, Number(opts.maxPanes) || Number(cfg.UI.MAX_PANES) || 3);
  const minPaneWidth = Math.max(8, Number(opts.minPaneWidth) || Number(cfg.UI.MIN_PANE_WIDTH) || 22);

  let columns = Number(opts.columns) || Number(process.stdout.columns) || 0;
  let rows = Number(opts.rows) || Number(process.stdout.rows) || 0;
  const heightOverride = Number(cfg.UI.HEIGHT) || 0;
  const widthOverride = Number(opts.width) || Number(cfg.UI.WIDTH) || 0;

  /**
   * 窗口宽度。
   * 单栏时限制在 100 列以内——太宽的卡片读起来累；
   * 但**多栏并排时允许用满终端**，否则 120 列的终端切 3 栏会被白白压到 100 列，
   * 每栏只剩 32 列。
   */
  function computeWidth(paneCount = 1) {
    const avail = columns ? Math.max(20, columns - 1) : 80;
    const cap = 100 * Math.max(1, paneCount);
    return Math.max(30, Math.min(widthOverride || avail, avail, cap));
  }
  function computeHeight() {
    const h = heightOverride || rows || DEFAULT_ROWS;
    return Math.max(3, h - 1); // 留一行给游标，避免把屏幕顶出去
  }
  let width = computeWidth(1);

  const safeWrite = (s) => { try { out(s); } catch { /* 忽略 */ } };
  const line = (s = '') => safeWrite(s + '\n');

  const frame = createFrame({ write: safeWrite, repaint: rich && repaint });

  // ——— 窗口状态 ———
  const panes = [];            // 正在显示的块，按到达顺序
  let currentLines = [];
  let ticker = null;
  const dwellTimers = new Set();

  function composeCurrent() {
    // 宽度随栏数变化：栏多的时候才值得用满终端
    width = computeWidth(panes.length || 1);
    if (!panes.length) return composeIdle({ width, maxLines: computeHeight(), theme }).lines;
    return composeWindow(panes.map((p) => p.model), {
      width, maxLines: computeHeight(), theme, maxPanes, minPaneWidth,
    }).lines;
  }

  function paint() {
    currentLines = composeCurrent();
    frame.setLines(currentLines);
  }

  /** 立刻重画（内容变化或收尾时用，不节流） */
  function paintNow() { if (rich) paint(); }

  function ensureTicker() {
    if (!repaint || ticker) return;
    ticker = setInterval(() => { if (panes.length) paint(); }, PAINT_INTERVAL_MS);
    if (ticker.unref) ticker.unref();
  }

  function stopTickerIfIdle() {
    if (!ticker) return;
    if (panes.length) return;
    clearInterval(ticker);
    ticker = null;
  }

  function addPane(block) {
    panes.push(block);
    if (rich) { paintNow(); ensureTicker(); }
  }

  function removePane(block) {
    const i = panes.indexOf(block);
    if (i >= 0) panes.splice(i, 1);
    if (rich) paintNow();
    stopTickerIfIdle();
  }

  function clearDwellTimers() {
    for (const t of dwellTimers) clearTimeout(t);
    dwellTimers.clear();
  }

  function standalone(text) {
    // append 模式没有"区域"可言，直接打印
    if (!rich || !repaint) { line(text); return; }
    // 先擦掉窗口，打印一行，再把窗口重画回来——保证外部信息不会打乱区域
    frame.clear();
    line(text);
    paintNow();
  }

  // ————————————————————————————————————————————————
  // plain 模式：逐字节复刻加 UI 之前的输出（这条路径不允许改）
  // ————————————————————————————————————————————————
  function plainBlock(question, index) {
    const pending = [];
    let isHead = false;
    let done = false;
    const drain = () => { while (pending.length) line(pending.shift()); };
    const emitLine = (t) => { if (isHead) line(t); else pending.push(t); };

    return {
      model: null,
      pushSystem: (t) => emitLine(t),
      becomeHead() { isHead = true; drain(); },
      note(text) { emitLine('⚠ ' + text); },
      reasoning() { /* plain 模式不展示思考过程 */ },
      content: () => [],
      verdict() { /* plain 模式不展示逐项判定 */ },
      endReasoning() {},
      phase() {},
      finish(payload) {
        const json = payload.rawResult === undefined ? '' : JSON.stringify(payload.rawResult).slice(0, 300);
        emitLine('返回：' + json);
        done = true;
      },
      fail(msg) {
        emitLine('返回：' + JSON.stringify({ code: 0, msg }));
        done = true;
      },
      boot() {
        pending.push('─'.repeat(60));
        pending.push('题干：' + question.title);
        pending.push('题型：' + question.type + '（来源 ' + question.typeSource + '，OCS 给的是 ' + JSON.stringify(question.rawType) + '）');
        pending.push('选项：' + question.options.map((o) => o.label + '=' + o.text).join(' | '));
      },
      get isHead() { return isHead; },
      get done() { return done; },
    };
  }

  // ————————————————————————————————————————————————
  // 富界面：window（原地重绘、可多栏）与 append（只追加新增行）
  // ————————————————————————————————————————————————
  function richBlock(question, index) {
    let done = false;
    const t0 = Date.now();
    const stream = createStreamView();

    // append 模式下的已打印游标
    let printedBox = false;
    let printedContent = 0;
    let printedResult = false;
    let printedStatus = null;

    const model = {
      index,
      title: question.title,
      options: question.options,
      notes: [],
      type: question.type,
      typeSource: question.typeSource,
      status: '正在分析…',
      reasoning: '',
      verdicts: [],
      result: null,
    };

    if (question.flags && question.flags.hasImage) {
      const n = (question.images || []).length;
      model.notes.push(n ? '含 ' + n + ' 张图片（base64 直传）' : '含图片链接');
    }
    if (question.flags && question.flags.completionUnsafe) model.notes.push('多空填空但拿不到空格数，将拒绝作答');

    /** append 模式：并发时给每行加题号前缀，否则日志里分不清 */
    function prefix() { return panes.length > 1 ? '[#' + index + '] ' : ''; }

    function appendNew() {
      const c = composeScreen(model, { width, maxLines: computeHeight(), theme });
      if (!printedBox && c.box.length) { c.box.forEach((l) => line(prefix() + l)); line(''); printedBox = true; }
      for (let i = printedContent; i < c.content.length; i += 1) line(prefix() + c.content[i]);
      printedContent = c.content.length;
      if (c.status && c.status !== printedStatus) { line(prefix() + c.status); printedStatus = c.status; }
      if (!printedResult && c.result.length) { c.result.forEach((l) => line(prefix() + l)); printedResult = true; }
    }

    function scheduleDwell() {
      if (dwellMs <= 0) { removePane(block); return; }
      const timer = setTimeout(() => {
        dwellTimers.delete(timer);
        removePane(block);
      }, dwellMs);
      if (timer.unref) timer.unref();
      dwellTimers.add(timer);
    }

    const block = {
      model,
      index,
      becomeHead() { /* 多栏模式下无需排队，所有活跃题同时显示 */ },
      boot() { /* 内容都在 model 里，由 UI 统一绘制 */ },
      pushSystem: (t) => standalone(t),
      note(text) { model.notes.push(text); },
      reasoning(chunk) {
        if (!chunk) return;
        model.reasoning += String(chunk);
      },
      endReasoning() { /* 思考是累积字符串，无需收尾 */ },
      content(chunk) {
        const fresh = stream.feed(chunk);
        for (const v of fresh) model.verdicts.push(v);
        return fresh;
      },
      verdict(v) { model.verdicts.push(v); },
      phase(name) {
        const map = {
          request: '请求模型', 'json-retry': '输出不是 JSON，重试',
          recheck: '判定与答案冲突，定向重问', 'network-retry': '上游繁忙，退避重试',
        };
        if (name === 'request') return;
        model.status = map[name] || name;
      },
      finish(payload) {
        const m = payload.meta || {};
        model.result = {
          msg: payload.msg,
          answer: payload.answer,
          meta: m,
          elapsedMs: payload.elapsedMs,
          rawFallback: (stream.count === 0 && stream.raw) ? stream.raw : null,
        };
        model.status = null;
        done = true;
        if (repaint) paintNow(); else appendNew();
        scheduleDwell();
      },
      fail(msg) {
        model.result = { msg, elapsedMs: Date.now() - t0 };
        model.status = null;
        done = true;
        if (repaint) paintNow(); else appendNew();
        scheduleDwell();
      },
      /** 时间在走，状态行的计时需要刷新 */
      tick() { if (!done) model.status = '正在分析… ' + fmtMs(Date.now() - t0); },
      get isHead() { return true; },
      get done() { return done; },
    };

    return block;
  }

  // ——— 终端尺寸变化 ———
  let resizeHandler = null;
  function onResize() {
    columns = Number(opts.columns) || Number(process.stdout.columns) || 0;
    rows = Number(opts.rows) || Number(process.stdout.rows) || 0;
    width = computeWidth(panes.length || 1);
    paintNow();
  }
  if (rich && repaint) {
    try {
      if (typeof opts.onResize === 'function') {
        const off = opts.onResize(onResize);
        if (typeof off === 'function') resizeHandler = off;
      } else if (process.stdout.isTTY) {
        process.on('SIGWINCH', onResize);
        resizeHandler = () => process.removeListener('SIGWINCH', onResize);
      }
    } catch { /* 订阅失败不影响功能 */ }
  }

  // 每次 tick 刷新所有活跃题的状态计时，再由 ticker 统一重绘
  let refreshTimer = null;
  if (repaint) {
    refreshTimer = setInterval(() => { for (const p of panes) if (p.tick) p.tick(); }, 500);
    if (refreshTimer.unref) refreshTimer.unref();
  }

  let counter = 0;

  return {
    rich,
    color,
    repaint,
    maxPanes,
    minPaneWidth,
    theme,
    get width() { return width; },
    get rows() { return computeHeight(); },
    /** 每题一个块；同步返回。并发时多栏并排显示，不再排队 */
    beginQuestion({ question, index }) {
      counter += 1;
      const idx = index === undefined ? counter : index;
      const q = safeQuestion(question);
      let block;
      try {
        block = rich ? richBlock(q, idx) : plainBlock(q, idx);
        block.boot();
        if (rich) addPane(block);
        else { block.becomeHead(); }
      } catch (err) {
        try {
          line('题干：' + q.title);
          block = plainBlock({ title: q.title, options: [], type: q.type, typeSource: q.typeSource, rawType: q.rawType }, idx);
          block.boot();
          block.becomeHead();
        } catch {
          block = {
            model: null, note() {}, reasoning() {}, content: () => [], verdict() {}, phase() {},
            finish() {}, fail() {}, endReasoning() {}, becomeHead() {}, boot() {}, isHead: true, done: true, tick() {},
          };
        }
      }
      return block;
    },
    banner(info) {
      if (!rich) {
        line('ocs-answer-engine 已启动');
        Object.entries(info || {}).forEach(([k, v]) => line('  ' + k + ' : ' + v));
        return;
      }
      // 键按显示宽度补齐（中文键占 2 列，不能直接用 length）
      const keys = Object.keys(info || {});
      const keyW = keys.reduce((m, k) => Math.max(m, strWidth(k)), 0);
      const rowsInfo = keys.map((k) => ({ text: '  ' + k + ' '.repeat(Math.max(0, keyW - strWidth(k))) + '  ' + info[k] }));
      const box = require('./box').renderBox({ width, titleLeft: 'ocs-answer-engine', titleRight: '问答服务', lines: rowsInfo, theme });
      box.forEach((l) => line(l));
    },
    warn(text) { standalone(theme.yellow('⚠ ' + text)); },
    error(text) { standalone(theme.red('✗ ' + text)); },
    info(text) { standalone(text); },
    /** 清除定时器、撤销尺寸订阅，并把窗口置空（进程退出或测试清理时调用） */
    destroy() {
      clearDwellTimers();
      if (ticker) { clearInterval(ticker); ticker = null; }
      if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
      if (resizeHandler) { try { resizeHandler(); } catch { /* 忽略 */ } resizeHandler = null; }
      panes.length = 0;
      frame.clear();
      currentLines = [];
    },
    get pendingBlocks() { return panes.filter((p) => !p.done).length; },
    get paneCount() { return panes.length; },
    /** 供测试观察当前屏幕内容（不含颜色控制码） */
    get screenLines() { return currentLines.slice(); },
  };
}

module.exports = {
  createUi, createLineWriter, safeQuestion,
  TYPE_LABEL, SOURCE_LABEL, STRATEGY_LABEL, fmtMs, stripAnsi,
};
