'use strict';
/**
 * 终端显示宽度与折行。**零依赖**，自带宽度范围表。
 *
 * 为什么不能直接用 `String.length`：中文、全角标点在终端里占 **2 列**，
 * 组合符占 0 列。用 length 算宽度会导致边框对不齐——这正是画框最容易翻车的地方。
 */

/** 占 2 列的区段（East Asian Wide / Fullwidth 的常用部分） */
const WIDE = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK 部首 / 康熙部首 / CJK 符号与标点（含 U+3000 全角空格）
  [0x3041, 0x33ff], // 平假名 / 片假名 / 注音 / 谚文兼容字母 / 韩文符号 / 假名扩展 / 带圈CJK / CJK兼容
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 统一表意文字
  [0xa000, 0xa4cf], // 彝文
  [0xac00, 0xd7a3], // 谚文音节
  [0xf900, 0xfaff], // CJK 兼容表意文字
  [0xfe10, 0xfe19], // 竖排标点
  [0xfe30, 0xfe6f], // CJK 兼容形式 / 小写变体
  [0xff00, 0xff60], // 全角 ASCII（ＡＢＣ、（）等）
  [0xffe0, 0xffe6], // 全角符号
  [0x1f300, 0x1f64f], // 常见 emoji
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd], // CJK 扩展 B 及以后
];

/** 占 0 列的区段（组合符 / 零宽 / 变体选择符） */
const ZERO = [
  [0x0300, 0x036f], // 组合变音符号
  [0x0483, 0x0489],
  [0x0591, 0x05bd], [0x0610, 0x061a], [0x064b, 0x065f],
  [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x0e47, 0x0e4e],
  [0x1ab0, 0x1aff], [0x1dc0, 0x1dff],
  [0x200b, 0x200f], // 零宽空格 / ZWJ / ZWNJ / LRM / RLM
  [0x2028, 0x202e],
  [0x2060, 0x2064], // 不可见运算符
  [0x20d0, 0x20ff], // 组合符
  [0xfe00, 0xfe0f], // 变体选择符
  [0xfeff, 0xfeff], // BOM
  [0xe0100, 0xe01ef], // 变体选择符补充
];

function inRanges(cp, ranges) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ranges[mid][0]) hi = mid - 1;
    else if (cp > ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** 单个码点占多少列 */
function codePointWidth(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0; // 控制字符不占列
  if (inRanges(cp, ZERO)) return 0;
  if (inRanges(cp, WIDE)) return 2;
  return 1;
}

/** 字符串在终端里占多少列 */
function strWidth(s) {
  let w = 0;
  const str = String(s == null ? '' : s);
  for (const ch of str) w += codePointWidth(ch.codePointAt(0));
  return w;
}

/** 按显示宽度补齐到 len 列（超出不截断） */
function padEnd(s, len) {
  const cur = strWidth(s);
  return cur >= len ? String(s) : String(s) + ' '.repeat(len - cur);
}

/** 按显示宽度截断，超出加 suffix（suffix 也计入宽度） */
function truncate(s, len, suffix = '…') {
  const str = String(s == null ? '' : s);
  if (strWidth(str) <= len) return str;
  const sfxW = strWidth(suffix);
  if (len <= sfxW) return suffix.slice(0, len);
  const keep = len - sfxW;
  let out = '';
  let w = 0;
  for (const ch of str) {
    const cw = codePointWidth(ch.codePointAt(0));
    if (w + cw > keep) break;
    out += ch;
    w += cw;
  }
  return out + suffix;
}

/**
 * 按显示宽度折行。
 * 中文可在任意字之间断行；含空格的西文优先在空格处断，避免把单词劈开。
 */
function wrap(s, width) {
  const str = String(s == null ? '' : s);
  if (width <= 0) return [str];
  const out = [];
  let line = '';
  let w = 0;

  const flush = () => { if (line !== '') { out.push(line); line = ''; w = 0; } };

  // 按「空格分词」切，但中文没有空格，所以逐字符推进并在空格处记录可断点
  let lastSpace = -1;
  for (const ch of str) {
    if (ch === '\n') { flush(); lastSpace = -1; continue; }
    const cw = codePointWidth(ch.codePointAt(0));
    if (w + cw > width) {
      if (lastSpace >= 0 && lastSpace < line.length) {
        // 在最后一个空格处断，把余下部分挪到下一行
        const head = line.slice(0, lastSpace);
        const tail = line.slice(lastSpace + 1);
        out.push(head);
        line = tail;
        w = strWidth(line);
      } else {
        out.push(line);
        line = '';
        w = 0;
      }
      lastSpace = -1;
    }
    if (ch === ' ') lastSpace = line.length;
    line += ch;
    w += cw;
  }
  flush();
  return out.length ? out : [''];
}

/** 把多行文本折成不超过 maxLines 行，超出用省略号收尾 */
function wrapCapped(s, width, maxLines) {
  const lines = wrap(s, width);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = truncate(kept[maxLines - 1] + ' …', width);
  return kept;
}

module.exports = { codePointWidth, strWidth, padEnd, truncate, wrap, wrapCapped };
