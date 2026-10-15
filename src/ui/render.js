'use strict';
/**
 * 渲染器：题目卡片 + 流式回复 + 结论行。
 *
 * 设计约束（来自"不要影响现在的版本、要能解耦回退"）：
 *  1. **plain 模式逐字节复刻原输出**——任何非 TTY / TERM=dumb / NO_COLOR 环境下，
 *     行为与加 UI 之前完全一致，也就是说这台机器上的日志输出不会有任何变化。
 *  2. 渲染器不直接碰 `process.stdout`，一切经注入的 `write`，因此可在无 TTY 下单测。
 *  3. 所有写入都包在 try/catch 里——**UI 出错绝不允许影响答题**。
 *  4. append-only，不做整块重绘（重绘需要光标上移，终端缩放/超屏/并发时会错乱）。
 */
const cfg = require('../config');
const { strWidth, padEnd, truncate, wrap, wrapCapped } = require('./width');
const { renderBox, divider, stripAnsi } = require('./box');
const { createTheme, shouldColor } = require('./theme');
const { createStreamView } = require('./stream-view');

const TYPE_LABEL = {
  single: '单选', multiple: '多选', judgement: '判断', completion: '填空',
  choice: '选择·待定', unknown: '未知',
};
const SOURCE_LABEL = { ocs: '题目给定', dom: '页面推断', shape: '形态推断' };
const STRATEGY_LABEL = {
  text: '文本匹配', 'text-json': '多选文本', 'text-hash': '多选文本',
  raw: '原文匹配', 'raw-json': '多选原文', letter: '字母回退',
  'option-raw': '选项原文', 'option-text': '选项文本', 'letter(known-bad)': '字母(不推荐)',
};

/** 增量行写入器：把流式片段按宽度折行并逐行吐出 */
function createLineWriter(emit, width, indent = '') {
  let cur = '';
  let curW = strWidth(indent);
  const avail = () => Math.max(1, width - strWidth(indent));
  return {
    push(text) {
      const s = String(text == null ? '' : text);
      for (const ch of s) {
        if (ch === '\n') { emit(indent + cur); cur = ''; curW = strWidth(indent); continue; }
        const cw = strWidth(ch);
        if (curW + cw > width && cur !== '') {
          emit(indent + cur);
          cur = '';
          curW = strWidth(indent);
        }
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

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '';
  return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
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
 * @param {(s:string)=>void} [opts.write]  输出通道（默认 process.stdout.write）
 * @param {number} [opts.columns]
 * @param {boolean} [opts.isTTY]
 * @param {object} [opts.env]
 * @param {string} [opts.style]  auto | rich | plain
 * @param {string} [opts.color]  auto | always | never
 * @param {number} [opts.width]  0 = 自动
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

  const detected = Number(opts.columns) || Number(process.stdout.columns) || 0;
  const override = Number(opts.width) || Number(cfg.UI.WIDTH) || 0;
  const width = Math.max(44, Math.min(override || detected || 80, 100));

  /** 安全写：UI 自身任何异常都不得冒泡到答题链路 */
  const safeWrite = (s) => { try { out(s); } catch { /* 忽略 */ } };
  const line = (s = '') => safeWrite(s + '\n');

  // ——— 块队列：只有队首块实时写，其余把输出缓冲，避免两题的卡片交错 ———
  const blocks = [];

  function standalone(text) {
    const head = blocks[0];
    if (head && !head.done) head.pushSystem(text);
    else line(text);
  }

  function advance() {
    while (blocks.length && blocks[0].done) blocks.shift();
    const head = blocks[0];
    if (head && !head.isHead) head.becomeHead();
  }

  // ————————————————————————————————————————————————
  // plain 模式：逐字节复刻加 UI 之前的输出
  // ————————————————————————————————————————————————
  function plainBlock(question, index) {
    const pending = [];
    let isHead = false;
    let done = false;
    const drain = () => { while (pending.length) line(pending.shift()); };
    /** 队首就直接写，否则缓冲——保证多题不交错，同时队首不被延迟 */
    const emitLine = (t) => { if (isHead) line(t); else pending.push(t); };

    const block = {
      pushSystem: (t) => emitLine(t),
      becomeHead() { isHead = true; drain(); },
      note(text) { emitLine('⚠ ' + text); },
      reasoning() { /* plain 模式不展示思考过程 */ },
      content: () => [],
      verdict() { /* plain 模式不展示逐项判定 */ },
      phase() {},
      finish(payload) {
        const json = payload.rawResult === undefined ? '' : JSON.stringify(payload.rawResult).slice(0, 300);
        emitLine('返回：' + json);
        done = true;
        advance();
      },
      fail(msg) {
        emitLine('返回：' + JSON.stringify({ code: 0, msg }));
        done = true;
        advance();
      },
      boot() {
        pending.push('─'.repeat(60));
        pending.push('题干：' + question.title);
        pending.push('题型：' + question.type + '（来源 ' + question.typeSource + '，OCS 给的是 ' + JSON.stringify(question.rawType) + '）');
        pending.push('选项：' + question.options.map((o) => o.label + '=' + o.text).join(' | '));
      },
      get plainPending() { return pending; },
      get isHead() { return isHead; },
      get done() { return done; },
    };
    return block;
  }

  // ————————————————————————————————————————————————
  // rich 模式
  // ————————————————————————————————————————————————
  function richBlock(question, index) {
    const pending = [];
    let isHead = false;
    let done = false;
    let spinner = null;
    let spinnerShown = 0;
    let wroteAnything = false;
    let reasoningStarted = false;
    const rw = createLineWriter((s) => emit(s), width, '  ');
    const stream = createStreamView();
    const timeouts = [];

    const drain = () => { while (pending.length) line(pending.shift()); };

    function clearSpinner() {
      if (spinner) { clearInterval(spinner); spinner = null; }
      // 按上次实际画出的长度回退，避免刷过量空格
      if (spinnerShown) { safeWrite('\r' + ' '.repeat(spinnerShown) + '\r'); spinnerShown = 0; }
    }

    function emit(text) {
      wroteAnything = true;
      if (isHead) { clearSpinner(); line(text); } else pending.push(text);
    }

    function startSpinner() {
      // 只有真终端才跑：注入了自定义 write 说明输出被接管（测试/管道），画旋转符只会污染内容
      if (!isTTY || !rich || opts.write) return;
      if (opts.spinner === false) return;
      const t0 = Date.now();
      const tick = () => {
        const text = '  ◐ 正在分析… ' + fmtMs(Date.now() - t0) + '   ';
        spinnerShown = strWidth(stripAnsi(text));
        safeWrite('\r' + theme.dim(text));
      };
      spinner = setInterval(tick, 200);
      if (spinner.unref) spinner.unref();
      tick();
    }

    const body = [];
    // 题干
    for (const l of wrapCapped(question.title || '(无题干)', width - 4, 4)) body.push({ text: l });
    if (question.options.length) {
      body.push({ text: '' });
      for (const o of question.options) {
        const lines = wrapCapped(o.text || '', width - 9, 2);
        lines.forEach((l, i) => body.push({ text: (i === 0 ? '  ' + o.label + '  ' : '     ') + l }));
      }
    }
    const noteLines = [];
    if (question.flags && question.flags.hasImage) {
      const n = (question.images || []).length;
      noteLines.push(n ? '含 ' + n + ' 张图片（base64 直传）' : '含图片链接');
    }
    if (question.flags && question.flags.completionUnsafe) noteLines.push('多空填空但拿不到空格数，将拒绝作答');
    if (noteLines.length) { body.push({ text: '' }); noteLines.forEach((t) => body.push({ text: t, paint: theme.dim })); }

    const typeLabel = TYPE_LABEL[question.type] || question.type;
    const srcLabel = SOURCE_LABEL[question.typeSource] || question.typeSource;
    const box = renderBox({
      width,
      titleLeft: '#' + index,
      titleRight: typeLabel + ' · ' + srcLabel,
      lines: body,
      theme,
      ascii: !rich,
    });

    const block = {
      pushSystem: (t) => { if (isHead) { clearSpinner(); line(t); } else pending.push(t); },
      becomeHead() { isHead = true; drain(); startSpinner(); },
      note(text) { (isHead ? (t) => { clearSpinner(); line(t); } : (t) => pending.push(t))(theme.yellow('  ⚠ ') + text); },
      boot() { box.forEach((l) => pending.push(l)); },
      reasoning(chunk) {
        if (!chunk) return;
        if (!reasoningStarted) {
          reasoningStarted = true;
          emit(theme.gray('  · 思考'));
        }
        rw.push(chunk);
      },
      /**
       * 收尾思考区。line writer 只在超宽/遇 \n 时吐行，最后不足一行的残留会留在缓冲里——
       * 若不在这里 flush，它会一直等到 finish() 才打印，于是"思考"的最后一行会诡异地
       * 排在逐项判定之后。所以在开始输出判定前先把思考区关掉。
       */
      endReasoning() {
        if (!reasoningStarted) return;
        rw.flush();
        reasoningStarted = false;
      },
      content(chunk) {
        const fresh = stream.feed(chunk);
        if (fresh.length) block.endReasoning();
        for (const v of fresh) block.verdict(v);
        return fresh;
      },
      verdict(v) {
        block.endReasoning();
        const mark = v.verdict === 'correct' ? theme.ok('  ✔ ')
          : v.verdict === 'unsure' ? theme.meh('  ? ')
            : theme.no('  ✘ ');
        const head = mark + theme.bold(v.label) + '  ';
        const avail = Math.max(8, width - strWidth('  ✔ X  '));
        const text = v.why || (v.verdict === 'correct' ? '判定为正确' : v.verdict === 'unsure' ? '不确定' : '判定为错误');
        const wrapped = wrap(text, avail);
        emit(head + (v.verdict === 'correct' ? theme.green(wrapped[0]) : wrapped[0]));
        for (let i = 1; i < wrapped.length; i += 1) emit('     ' + theme.dim(wrapped[i]));
      },
      phase(name) {
        const map = {
          request: '请求模型', 'json-retry': '输出不是 JSON，重试',
          recheck: '判定与答案冲突，定向重问', 'network-retry': '上游繁忙，退避重试',
        };
        if (name === 'request') return;
        emit(theme.dim('  · ' + (map[name] || name)));
      },
      finish(payload) {
        block.endReasoning();
        clearSpinner();
        const m = payload.meta || {};
        if (payload.msg) {
          emit(theme.no('  ✗ ') + payload.msg + theme.dim('   ' + fmtMs(payload.elapsedMs)));
        } else if (stream.count === 0 && stream.raw) {
          // 一条判定都没提取出来 → 兜底展示原始输出，别让人以为卡住了
          emit(theme.dim('  · 原始输出：' + truncate(stream.raw.replace(/\s+/g, ' '), width - 14, '…')));
        }
        const letters = (m.letters || []).join('') || '-';
        const strategy = STRATEGY_LABEL[m.emitStrategy] || m.emitStrategy || '-';
        const verify = m.emitVerified ? theme.green('自检通过') : theme.yellow('自检降级');
        const parts = [
          theme.bold('答案 ' + letters),
          payload.answer ? truncate(String(payload.answer), 28, '…') : '',
          strategy,
          verify,
          fmtMs(payload.elapsedMs),
        ].filter(Boolean);
        emit(divider(width, theme));
        emit(theme.verdict('  ✓ ' + parts.slice(0, 2).join(' · ') + '    ') + theme.dim(parts.slice(2).join(' · ')));
        if (m.conflict) emit(theme.yellow('  ⚠ ' + m.conflict));
        if (m.rechecked) emit(theme.dim('  · 已定向重问复核'));
        done = true;
        clearSpinner();
        timeouts.forEach(clearTimeout);
        if (isHead) drain();
        advance();
      },
      fail(msg) {
        clearSpinner();
        emit(theme.red('  ✗ ' + msg));
        done = true;
        if (isHead) drain();
        advance();
      },
      get isHead() { return isHead; },
      get done() { return done; },
      get wroteAnything() { return wroteAnything; },
    };
    return block;
  }

  let counter = 0;

  return {
    rich,
    color,
    width,
    theme,
    /** 每题一个块；同步返回，内部自动排队 */
    beginQuestion({ question, index }) {
      counter += 1;
      const idx = index === undefined ? counter : index;
      // 入口就归一化：之后两条渲染路径都可以无条件信任字段存在
      const q = safeQuestion(question);
      let block;
      try {
        block = rich ? richBlock(q, idx) : plainBlock(q, idx);
        blocks.push(block);
        // 先 boot（内容入缓冲）再 advance（若已轮到自己就立刻 flush）
        block.boot();
        advance();
      } catch (err) {
        // 最后一道防线：连归一化后的渲染都失败，就退回最朴素的单行输出。
        // 这里绝不能再抛——UI 出问题不允许影响答题。
        try {
          line('题干：' + q.title);
          block = plainBlock({ title: q.title, options: [], type: q.type, typeSource: q.typeSource, rawType: q.rawType }, idx);
          blocks.push(block);
          block.boot();
          advance();
        } catch {
          block = {
            note() {}, reasoning() {}, content: () => [], verdict() {}, phase() {},
            finish() {}, fail() {}, endReasoning() {}, becomeHead() {},
            isHead: true, done: true,
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
      const rows = Object.entries(info || {}).map(([k, v]) => ({ text: '  ' + padEnd(k, 10) + v }));
      const box = renderBox({ width, titleLeft: 'ocs-answer-engine', titleRight: '问答服务', lines: rows, theme });
      box.forEach((l) => line(l));
    },
    warn(text) { standalone(theme.yellow('⚠ ' + text)); },
    error(text) { standalone(theme.red('✗ ' + text)); },
    info(text) { standalone(text); },
    /** 给测试用：当前是否还有未完成的块 */
    get pendingBlocks() { return blocks.filter((b) => !b.done).length; },
  };
}

module.exports = { createUi, createLineWriter, safeQuestion, TYPE_LABEL, SOURCE_LABEL, STRATEGY_LABEL, fmtMs, stripAnsi };
