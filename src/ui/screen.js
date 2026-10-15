'use strict';
/**
 * 屏幕合成：把「题目模型」渲染成一组终端行，并做窗口化裁剪。
 *
 * 布局（自上而下）：
 *   题目框（题干 + 选项 + 备注）
 *   空行
 *   状态行（正在分析…）        ← 易变，重绘时随意改
 *   流式区：思考 + 逐项判定     ← 超出预算时只保留尾部
 *   分隔线 + 结论行            ← 完成才有
 *
 * 窗口化的硬规则：**题目框永远可见**。预算不够时先丢状态行、再丢备注、
 * 最后压缩选项折行，绝不把题目框挤出屏幕。
 *
 * 本模块是纯函数（除 theme 里的颜色函数外无副作用），因此可以完全单测。
 */
const { strWidth, padEnd, truncate, wrap, wrapCapped } = require('./width');
const { renderBox, divider } = require('./box');

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

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '';
  return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
}

/** 题目框。optLines = 每个选项最多折几行；maxOptions = 最多显示几个选项（空间紧张时压缩） */
function buildBox(model, theme, width, optLines = 2, withNotes = true, maxOptions = Infinity) {
  const body = [];
  for (const l of wrapCapped(model.title || '(无题干)', width - 4, 4)) body.push({ text: l });
  const opts = model.options || [];
  const shownCount = Math.max(0, Math.min(opts.length, maxOptions));
  if (shownCount) {
    body.push({ text: '' });
    for (const o of opts.slice(0, shownCount)) {
      const lines = wrapCapped(o.text || '', width - 9, optLines);
      lines.forEach((l, i) => body.push({ text: (i === 0 ? '  ' + o.label + '  ' : '     ') + l }));
    }
    if (shownCount < opts.length) body.push({ text: '  … 还有 ' + (opts.length - shownCount) + ' 个选项', paint: theme.dim });
  }
  if (withNotes && model.notes && model.notes.length) {
    body.push({ text: '' });
    for (const t of model.notes) body.push({ text: t, paint: theme.dim });
  }
  const typeLabel = TYPE_LABEL[model.type] || model.type || '';
  const srcLabel = SOURCE_LABEL[model.typeSource] || model.typeSource || '';
  return renderBox({
    width,
    titleLeft: '#' + model.index,
    titleRight: [typeLabel, srcLabel].filter(Boolean).join(' · '),
    lines: body,
    theme,
  });
}

/** 流式区第一部分：思考（自然语言，暗色） */
function formatReasoning(text, theme, width) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const out = [theme.gray('  · 思考')];
  for (const l of wrap(t, width - 2)) out.push(theme.gray('  ' + l));
  return out;
}

/** 流式区第二部分：逐项判定 */
function formatVerdicts(verdicts, theme, width) {
  const out = [];
  for (const v of verdicts || []) {
    const mark = v.verdict === 'correct' ? theme.ok('  ✔ ')
      : v.verdict === 'unsure' ? theme.meh('  ? ')
        : theme.no('  ✘ ');
    const head = mark + theme.bold(v.label) + '  ';
    const avail = Math.max(8, width - strWidth('  ✔ X  '));
    const fallback = v.verdict === 'correct' ? '判定为正确' : v.verdict === 'unsure' ? '不确定' : '判定为错误';
    const wrapped = wrap(v.why || fallback, avail);
    const first = v.verdict === 'correct' ? theme.green(wrapped[0]) : wrapped[0];
    out.push(head + first);
    for (let i = 1; i < wrapped.length; i += 1) out.push(theme.dim('     ' + wrapped[i]));
  }
  return out;
}

/** 结论区：分隔线 + 一行摘要 */
function formatResult(result, theme, width) {
  if (!result) return [];
  const m = result.meta || {};
  if (result.msg) {
    return [divider(width, theme), theme.no('  ✗ ') + result.msg + theme.dim('   ' + fmtMs(result.elapsedMs))];
  }
  const letters = (m.letters || []).join('') || '-';
  const strategy = STRATEGY_LABEL[m.emitStrategy] || m.emitStrategy || '-';
  const verify = m.emitVerified ? theme.green('自检通过') : theme.yellow('自检降级');
  const head = '  ✓ ' + theme.bold('答案 ' + letters)
    + (result.answer ? ' · ' + truncate(String(result.answer), 26, '…') : '');
  const tail = [strategy, verify, fmtMs(result.elapsedMs)].filter(Boolean).join(' · ');
  const out = [divider(width, theme), theme.verdict(head) + '    ' + theme.dim(tail)];
  if (m.conflict) out.push(theme.yellow('  ⚠ ' + m.conflict));
  if (m.rechecked) out.push(theme.dim('  · 已定向重问复核'));
  if (result.rawFallback) {
    out.push(theme.dim('  · 原始输出：' + truncate(String(result.rawFallback).replace(/\s+/g, ' '), width - 14, '…')));
  }
  return out;
}

/**
 * 合成整屏。
 *
 * @param {object} model { index, title, options, notes, type, typeSource, status, reasoning, verdicts, result }
 * @param {object} opts  { width, maxLines, theme }
 * @returns {{lines:string[], box:string[], status:string|null, content:string[], result:string[],
 *            dropped:number, degraded:string|null}}
 */
function composeScreen(model, { width, maxLines, theme }) {
  const t = theme || { paint: (_, s) => s, dim: (s) => s, gray: (s) => s, ok: (s) => s, no: (s) => s, meh: (s) => s, bold: (s) => s, green: (s) => s, yellow: (s) => s, verdict: (s) => s };
  const W = Math.max(20, Math.floor(width));
  const H = Math.max(3, Math.floor(maxLines));

  // 流式区（完整、未裁剪）
  const content = formatReasoning(model.reasoning, t, W).concat(formatVerdicts(model.verdicts, t, W));
  const result = formatResult(model.result, t, W);
  const statusLine = model.status ? t.dim('  ' + model.status) : null;
  const optCount = (model.options || []).length;

  // 降级阶梯：**题目框永不被挤掉**。空间越紧越往后走。
  const attempts = [
    { status: true, notes: true, optLines: 2, blank: true, degraded: null },
    { status: false, notes: true, optLines: 2, blank: true, degraded: null },
    { status: false, notes: false, optLines: 2, blank: true, degraded: '状态与备注已省略' },
    { status: false, notes: false, optLines: 1, blank: true, degraded: '状态与备注已省略' },
    { status: false, notes: false, optLines: 1, blank: false, degraded: '状态、备注与空行已省略' },
    { status: false, notes: false, optLines: 1, blank: false, maxOptions: true, degraded: '已压缩为屏幕可容纳的选项数' },
  ];

  let chosen = null;
  for (const a of attempts) {
    // 框高 = 顶边 + 题干 + 空行 + N 个选项 + 底边（+ 压缩提示行）。
    // 压缩选项时会多出一行"… 还有 N 个选项"，所以这里要预留 5 行而不是 4 行。
    const cap = a.maxOptions ? Math.max(1, H - 5) : optCount;
    const box = buildBox(model, t, W, a.optLines, a.notes, cap);
    const overhead = box.length + result.length + (a.status && statusLine ? 1 : 0) + (a.blank ? 1 : 0);
    // 有流式内容时再留 2 行：一行裁剪提示 + 至少一行内容。
    // 否则极端窄屏下会出现"内容全被裁掉、提示也被钳掉"的一屏空白。
    const need = content.length > 0 ? 2 : 0;
    if (overhead + need <= H || a === attempts[attempts.length - 1]) { chosen = { a, box, overhead }; break; }
  }

  const { a, box, overhead } = chosen;
  let budget = Math.max(0, H - overhead);
  // 需要裁剪时才多花一行放提示（提示本身也占一行，所以要再减一格）
  if (content.length > budget && budget > 0) budget -= 1;
  const shown = content.length > budget ? content.slice(content.length - budget) : content;
  const dropped = content.length - shown.length;

  let head = box.slice();
  let mid = [];
  if (a.blank) mid.push('');
  if (a.status && statusLine) mid.push(statusLine);
  if (dropped > 0) mid.push(t.dim('  … 前面还有 ' + dropped + ' 行'));
  mid.push(...shown);

  // 极小终端兜底：连降级过的框都放不下时，退化成"顶边 + 题干 + 底边"的紧凑框。
  // 宁可少显示内容，也不要把框从中间切断——残缺的框看起来像坏了。
  if (head.length + result.length > H) {
    const compact = renderBox({
      width: W, titleLeft: '#' + model.index, titleRight: '', theme: t,
      lines: [{ text: truncate(model.title || '', W - 4, '…') }],
    });
    head = compact.slice(0, Math.max(1, H - result.length));
    mid = [];
  }

  let lines = head.concat(mid, result);
  if (lines.length > H) {
    // 收尾策略：**裁中间、保两端**——题目框与结论不能让位给流式内容。
    const midBudget = Math.max(0, H - head.length - result.length);
    lines = head.concat(mid.slice(Math.max(0, mid.length - midBudget)), result);
  }
  if (lines.length > H) lines = lines.slice(0, H); // 最后的保险：绝不超过屏幕
  return { lines, box, status: (a.status && statusLine) || null, content, result, dropped, degraded: a.degraded };
}

/** 等待态：服务空闲时的极简屏 */
function composeIdle({ width, maxLines, theme, hint }) {
  const t = theme || { dim: (s) => s };
  return { lines: [t.dim('  ' + (hint || '等待 OCS 题目…'))], box: [], status: null, content: [], result: [], dropped: 0, degraded: null };
}

module.exports = {
  composeScreen, composeIdle, buildBox, formatReasoning, formatVerdicts, formatResult,
  TYPE_LABEL, SOURCE_LABEL, STRATEGY_LABEL, fmtMs,
};
