'use strict';
/**
 * 画框。零依赖，Unicode 边框 + ASCII 回退。
 *
 * 关键约束：**宽度计算必须在纯文本上做**，颜色只能在整行拼好之后套上去。
 * 否则 ANSI 转义序列会被算进显示宽度，边框立刻歪掉。
 * 因此 body 的每一项都必须是"整行同色"，而不是行内局部染色。
 */
const { strWidth, padEnd, truncate } = require('./width');

const GLYPHS = {
  unicode: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  ascii: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' },
};

const ANSI_RE = /\u001b\[[0-9;]*m/g;
function stripAnsi(s) {
  return String(s == null ? '' : s).replace(ANSI_RE, '');
}

/**
 * @param {object} p
 * @param {number} p.width       含边框的总宽
 * @param {string} [p.titleLeft]
 * @param {string} [p.titleRight]
 * @param {Array<string|{text:string,paint?:Function}>} p.lines
 * @param {object} p.theme       createTheme() 的返回值（用于给边框上色）
 * @param {boolean} [p.ascii]    true = 用 +-| 画框
 * @returns {string[]} 每一行（已含颜色）
 */
function renderBox({ width, titleLeft = '', titleRight = '', lines = [], theme, ascii = false }) {
  const g = ascii ? GLYPHS.ascii : GLYPHS.unicode;
  const t = theme || { paint: (_, s) => s };
  const W = Math.max(12, Math.floor(width));
  const inner = W - 4; // "│ " + 内容 + " │"
  const border = (s) => t.paint('gray', s);

  const out = [];

  // —— 顶边：╭─ 左标题 ──── 右标题 ─╮ ——
  const segTarget = W - 2;
  // 左标题后、右标题前各留一个空格，否则会和填充横线黏在一起
  let left = titleLeft ? g.h + ' ' + titleLeft + ' ' : g.h;
  let right = titleRight ? ' ' + titleRight + ' ' + g.h : g.h;
  let fill = segTarget - strWidth(left) - strWidth(right);
  if (fill < 1) {
    // 标题太长：先砍右标题，再砍左标题
    right = g.h;
    fill = segTarget - strWidth(left) - strWidth(right);
    if (fill < 1) {
      const room = Math.max(1, segTarget - strWidth(g.h + ' ') * 2 - strWidth(right));
      left = g.h + ' ' + truncate(titleLeft, room, '…') + ' ';
      fill = segTarget - strWidth(left) - strWidth(right);
      if (fill < 1) { left = g.h; fill = segTarget - strWidth(left) - strWidth(right); }
    }
  }
  let mid = left + g.h.repeat(Math.max(0, fill)) + right;
  if (strWidth(mid) > segTarget) mid = truncate(mid, segTarget, '');
  if (strWidth(mid) < segTarget) mid = padEnd(mid, segTarget);
  out.push(border(g.tl + mid + g.tr));

  // —— 内容行 ——
  for (const item of lines) {
    const isObj = item && typeof item === 'object';
    const text = isObj ? String(item.text == null ? '' : item.text) : String(item == null ? '' : item);
    const paint = isObj && typeof item.paint === 'function' ? item.paint : null;
    const content = padEnd(truncate(text, inner, '…'), inner);
    const row = border(g.v) + ' ' + (paint ? paint(content) : content) + ' ' + border(g.v);
    out.push(row);
  }

  // —— 底边 ——
  out.push(border(g.bl + g.h.repeat(W - 2) + g.br));
  return out;
}

/** 分隔线（用于结论与正文之间） */
function divider(width, theme, char = '─') {
  const t = theme || { paint: (_, s) => s };
  const W = Math.max(4, Math.floor(width));
  return t.paint('gray', char.repeat(W - 2).padStart(W - 2));
}

module.exports = { renderBox, divider, stripAnsi, GLYPHS };
