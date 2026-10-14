'use strict';
/**
 * 模型输出 → OCS 可用答案。
 *
 * 关键设计：
 *  - 只认结构化字段（answers / options[].verdict / text_answer），
 *    绝不再对整段文本做 [A-F] 抓字母（那是“幽灵选项”的根源）。
 *  - 解析失败且拿不到答案时返回空串，由上层决定是否 code:0。
 */

const { judgementPolarity } = require('./text');

const CORRECT_VERDICT_RE = /^(correct|true|right|yes|y|正确|对|是|√|应当选|选中)$/i;
const TYPES = ['single', 'multiple', 'judgement', 'completion'];

function letterOf(index) {
  return index >= 0 && index < 26 ? String.fromCharCode(65 + index) : '';
}

function toArray(v) {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** 提取首个可解析的 JSON 对象：原文 → 去代码围栏 → 首个配平的花括号区间 */
function extractJson(raw) {
  const s0 = String(raw == null ? '' : raw).trim();
  if (!s0) return null;

  const cleaned = s0.replace(/^\uFEFF/, '').replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '').trim();
  const candidates = [cleaned];

  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(cleaned.slice(first, last + 1));

  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
      if (Array.isArray(v) && v.length) return { answers: v };
    } catch {
      /* 继续尝试下一个候选 */
    }
  }
  return null;
}

/** 把 "C" / "A、B" / ["A","B"] 之类的值归一化为字母数组 */
function normalizeLetters(input) {
  const out = [];
  for (const item of toArray(input)) {
    const s = String(item == null ? '' : item).trim();
    if (!s || s.length > 8) continue;
    const letters = s.replace(/[^A-Za-z]/g, '').toUpperCase();
    for (const ch of letters) out.push(ch);
  }
  return [...new Set(out)];
}

function optionToLetter(value, options) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  if (/^[A-Za-z]$/.test(s)) return s.toUpperCase();
  const m = s.match(/^[（(\[]?\s*([A-Za-z])\s*[）)\]]?\s*[.．、,，:：]?\s*$/);
  if (m) return m[1].toUpperCase();
  const idx = options.findIndex((o) => o.text === s);
  return idx === -1 ? '' : letterOf(idx);
}

function isCorrectVerdict(v) {
  return CORRECT_VERDICT_RE.test(String(v == null ? '' : v).trim());
}

function stringifyTextAnswer(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).join('#');
  return String(v).trim();
}

/** 判断题：优先用字母映射回选项原文，其次按“正确/错误”极性找对应选项 */
function resolveJudgementText(selected, rawAnswers, options) {
  if (selected.length) {
    const opt = options[selected[0].charCodeAt(0) - 65];
    if (opt) return opt.text;
  }
  for (const a of rawAnswers) {
    const pol = judgementPolarity(a);
    if (pol === 0) continue;
    const hit = options.find((o) => judgementPolarity(o.text) === pol);
    if (hit) return hit.text;
  }
  for (const a of rawAnswers) {
    const s = String(a == null ? '' : a).trim();
    if (s && options.some((o) => o.text === s)) return s;
  }
  return '';
}

/**
 * @param {object} p
 * @param {string} p.raw 模型原始输出
 * @param {{label:string|null,text:string}[]} p.options 解析后的选项
 * @param {string} [p.type] single|multiple|judgement|completion|unknown
 * @param {string} [p.format] auto|letter|text
 * @param {string} [p.fallbackOnEmpty] none|first
 * @param {string} [p.separator] 多选分隔符（必须属于 OCS 的 splitAnswer 分隔符表）
 */
function resolveAnswer({ raw, options = [], type = 'unknown', format = 'auto', fallbackOnEmpty = 'none', separator = '#' }) {
  const opts = Array.isArray(options) ? options : [];
  const max = opts.length;
  const parsed = extractJson(raw);

  let verdictLetters = [];
  let rawAnswers = [];
  let textAnswer = '';
  let modelType = '';
  let thought = '';

  if (parsed) {
    modelType = String(parsed.question_type || parsed.type || '').trim().toLowerCase();
    thought = String(parsed.thought || '').trim();
    if (Array.isArray(parsed.options)) {
      for (const item of parsed.options) {
        if (!item || typeof item !== 'object') continue;
        const letter = optionToLetter(item.option, opts);
        if (letter && isCorrectVerdict(item.verdict)) verdictLetters.push(letter);
      }
      verdictLetters = [...new Set(verdictLetters)];
    }
    if (parsed.answers !== undefined) rawAnswers = toArray(parsed.answers);
    else if (parsed.answer !== undefined) rawAnswers = toArray(parsed.answer);
    if (parsed.text_answer !== undefined && parsed.text_answer !== null) textAnswer = stringifyTextAnswer(parsed.text_answer);
  } else {
    const m = String(raw == null ? '' : raw).match(/"answers"\s*:\s*\[([^\]]*)\]/i);
    if (m) rawAnswers = m[1].match(/[A-Za-z]/g) || [];
  }

  const answerLetters = normalizeLetters(rawAnswers);
  let conflict = false;
  let letters;
  if (verdictLetters.length) {
    const a = new Set(verdictLetters);
    const b = new Set(answerLetters);
    conflict = answerLetters.length > 0 && (a.size !== b.size || [...a].some((x) => !b.has(x)));
    letters = verdictLetters;
  } else {
    letters = answerLetters;
  }

  // 越界字母直接丢弃（选项只有 4 个却返回 F）
  letters = letters.filter((l) => {
    const i = l.charCodeAt(0) - 65;
    return i >= 0 && i < max;
  });

  let effective = String(type || 'unknown').trim().toLowerCase();
  if (!TYPES.includes(effective)) {
    if (TYPES.includes(modelType)) effective = modelType;
    else if (letters.length > 1) effective = 'multiple';
    else if (letters.length === 1) effective = 'single';
    else effective = 'unknown';
  }

  let selected = letters;
  if (effective === 'single' || effective === 'judgement') {
    // 单选/判断只保留模型给出的第一个（保留模型顺序，不按字母序截断）
    selected = letters.slice(0, 1);
  } else if (effective === 'multiple') {
    selected = [...letters].sort();
  }

  let answer = '';
  if (effective === 'completion') {
    answer = textAnswer;
    if (!answer && selected.length) {
      answer = selected.map((l) => opts[l.charCodeAt(0) - 65].text).join(separator);
    }
  } else if (effective === 'judgement') {
    answer = resolveJudgementText(selected, rawAnswers, opts);
  } else if (format === 'text') {
    answer = selected.map((l) => opts[l.charCodeAt(0) - 65].text).join(separator);
  } else {
    answer = selected.join(separator);
  }

  if (!answer && fallbackOnEmpty === 'first' && opts[0]) answer = opts[0].text;

  return { answer, letters: selected, type: effective, conflict, thought, textAnswer };
}

module.exports = { resolveAnswer, extractJson, normalizeLetters, optionToLetter, stringifyTextAnswer, resolveJudgementText };
