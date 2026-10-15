'use strict';
/**
 * 分屏几何：把终端宽度切成 N 个并排栏，并把各栏的行横向拼起来。
 *
 * 为什么单独一个模块：不同题目并发时，每栏的内容高度不一样，
 * 必须补齐到同一高度才能让边框在水平方向对齐。这块只关心几何，不关心题目内容，
 * 因此可以完全单测——窄终端下的降级行为尤其需要测。
 *
 * 宽度一律按**显示列数**算（中文 2 列），否则中文题干一多，栏与栏就会错位。
 */
const { strWidth, truncate } = require('./width');
const { stripAnsi } = require('./box');

/** 栏与栏之间的分隔符宽度（单个字符） */
const SEP_WIDTH = 1;

/**
 * N 栏时每栏的宽度。向下取整，保证 n*w + (n-1)*sep ≤ total。
 */
function paneWidth(total, count, sepWidth = SEP_WIDTH) {
  if (count <= 1) return Math.max(1, total);
  return Math.max(1, Math.floor((total - (count - 1) * sepWidth) / count));
}

/**
 * 实际能并排显示几栏。
 *
 * 约束（任一不满足就减少栏数）：
 *  1. 不超过 `maxPanes`（OCS 的线程上限就是 3）
 *  2. 每栏宽度不低于 `minPaneWidth`——再窄就只剩几个字，读不了
 * 无论如何至少返回 1，保证单题永远能显示。
 *
 * @returns {number}
 */
function computePaneCount(active, { width, maxPanes = 3, minPaneWidth = 22 } = {}) {
  if (active <= 1) return 1;
  const cap = Math.max(1, Math.min(Math.floor(active), Math.floor(maxPanes)));
  for (let n = cap; n >= 2; n -= 1) {
    if (paneWidth(width, n) >= minPaneWidth) return n;
  }
  return 1;
}

/**
 * 把一行补到指定显示宽度。行内可能带 ANSI 颜色——按约定每行都是**整行同色且闭合**的，
 * 所以直接在末尾补空格是安全的（空格落在颜色复位之后，不会被染色）。
 */
function padTo(line, width) {
  const s = String(line == null ? '' : line);
  const w = strWidth(stripAnsi(s));
  if (w === width) return s;
  if (w > width) return truncate(s, width, '');
  return s + ' '.repeat(width - w);
}

/**
 * 把多个栏的行横向拼接。
 *
 * @param {Array<{lines:string[], width:number}>} panes
 * @param {object} opts
 * @param {number} opts.width    整屏宽度（结果每行都会补齐到这个宽度）
 * @param {string} [opts.sep]    分隔符（默认 '│'）
 * @param {number} [opts.maxLines] 行数上限，超出截断
 * @returns {string[]}
 */
function joinPanes(panes, { width, sep = '│', maxLines } = {}) {
  if (!panes.length) return [];
  const height = Math.max(...panes.map((p) => (p.lines ? p.lines.length : 0)));
  const rows = [];
  for (let i = 0; i < height; i += 1) {
    const cells = panes.map((p) => padTo(p.lines && p.lines[i] ? p.lines[i] : '', p.width));
    rows.push(padTo(cells.join(sep), width));
  }
  if (maxLines && rows.length > maxLines) return rows.slice(0, maxLines);
  return rows;
}

module.exports = { paneWidth, computePaneCount, joinPanes, padTo, SEP_WIDTH };
