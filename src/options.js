'use strict';
/**
 * 选项解析：把 OCS 传来的 options 字符串拆成 [{ label, text }]。
 *
 * 支持的标签形态：
 *   A. xx / A、xx / A．xx / A) xx / A: xx / （A）xx / [A] xx / Ａ.xx（全角）
 * 也支持无标签（按行拆分，按位置补 A/B/C…）。
 *
 * 注意：返回的 label 只是“检测到的原始标签”，最终给模型和回传给 OCS 的字母
 * 一律按 **位置** 生成（第 1 个选项 = A），因为 OCS 自己也是按位置映射字母的。
 */

const BRACKET_LABEL = /^\s*[（(\[]\s*([A-Za-z])\s*[）)\]]\s*[.．、,，:：]?\s*/;
const BARE_LABEL = /^\s*([A-Za-z])\s*[.．、,，:：)）\]】]\s*/;
const FULLWIDTH_LETTER_RE = /[\uFF21-\uFF3A\uFF41-\uFF5A]/g;

function letterOf(index) {
  return index >= 0 && index < 26 ? String.fromCharCode(65 + index) : null;
}

function toHalfWidthLetters(s) {
  return String(s).replace(FULLWIDTH_LETTER_RE, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 仅当行首标签字母正好等于期望字母时才剥离，避免把选项正文里的 “B.” 当成标签 */
function stripLabel(line, expected) {
  if (!expected) return null;
  let m = line.match(BRACKET_LABEL);
  if (m && m[1].toUpperCase() === expected) return line.slice(m[0].length).trim();
  m = line.match(BARE_LABEL);
  if (m && m[1].toUpperCase() === expected) return line.slice(m[0].length).trim();
  return null;
}

function parseLabeledLines(lines) {
  if (lines.length < 2) return null;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const expected = letterOf(i);
    if (!expected) return null;
    const stripped = stripLabel(lines[i], expected);
    if (stripped === null) return null;
    out.push({ label: expected, text: stripped });
  }
  return out;
}

const INLINE_LABEL_RE = /(^|\s)(?:[（(\[]\s*([A-Za-z])\s*[）)\]]\s*[.．、,，:：)）\]】]?|([A-Za-z])\s*[.．、,，:：)）\]】])\s*/g;

function parseInline(text) {
  const flat = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return null;

  const marks = [];
  let m;
  INLINE_LABEL_RE.lastIndex = 0;
  while ((m = INLINE_LABEL_RE.exec(flat)) !== null) {
    const letter = (m[2] || m[3]).toUpperCase();
    marks.push({ letter, start: m.index + m[1].length, end: INLINE_LABEL_RE.lastIndex });
    if (INLINE_LABEL_RE.lastIndex === m.index) INLINE_LABEL_RE.lastIndex++;
  }

  const startIdx = marks.findIndex((x) => x.letter === 'A');
  if (startIdx === -1) return null;

  const seq = [marks[startIdx]];
  for (let i = startIdx + 1; i < marks.length; i++) {
    const expected = letterOf(seq.length);
    if (!expected) break;
    if (marks[i].letter === expected) seq.push(marks[i]);
  }
  if (seq.length < 2) return null;

  const out = [];
  for (let i = 0; i < seq.length; i++) {
    const from = seq[i].end;
    const to = i + 1 < seq.length ? seq[i + 1].start : flat.length;
    const t = flat.slice(from, to).trim();
    if (!t) return null;
    out.push({ label: letterOf(i), text: t });
  }
  return out;
}

/**
 * @param {string} raw OCS 传来的选项字符串（通常是 "A. xx\nB. yy"，也可能没有标签）
 * @returns {{label: string|null, text: string}[]}
 */
function parseOptions(raw) {
  const text = toHalfWidthLetters(String(raw == null ? '' : raw))
    .replace(/\r\n?/g, '\n')
    .replace(/\u3000/g, ' ');
  if (!text.trim()) return [];

  const lines = text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '');

  const byLine = parseLabeledLines(lines);
  if (byLine) return byLine;

  const inline = parseInline(text);
  if (inline) return inline;

  return lines.map((t, i) => ({ label: letterOf(i), text: t }));
}

/** 位置 → 字母（与 OCS 的映射方式一致） */
function letterFor(index) {
  return letterOf(index);
}

module.exports = { parseOptions, letterOf, letterFor, stripLabel, parseLabeledLines, parseInline };
