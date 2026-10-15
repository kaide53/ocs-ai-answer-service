'use strict';
/**
 * reconcile：把模型的两个产物对齐成一个答案集合。
 *
 * 模型被要求输出两样东西：
 *   - `option_judgements`：逐个选项的 verdict（correct / wrong / unsure）——这是"分析过程"
 *   - `answer`：最终选了哪几个字母——这是"结论"
 *
 * 两者本应一致，但实际会不一致，而**不一致本身就是最强的信号**。
 *
 * 为什么不能只用 `answer`：见 docs/REPLAY-VALIDATION.md 结论 C。
 * 实测 47 道"单选多选未定"的题里 14 道实际是多选（30%），
 * 而多选最大的失败模式是**漏选**——模型判对了某个选项是 correct，却没写进 answer。
 * 只用 answer 就把这类错误固化下来了。
 *
 * 为什么也不能无脑用 verdict 的并集：`choice` 类里 70% 其实是单选，
 * 如果模型把某个干扰项误判成 correct，并集反而会多选。
 *
 * 所以策略是**按题型可信度分级**：
 *   - OCS 明确说了 multiple      → 用并集（对着"漏选"这个主风险纠偏）
 *   - OCS 明确说了 single        → 用 answer，但要标记 verdict 不一致
 *   - 题型未定（choice）且不一致 → 用 answer，标记为需复核（交由上层做定向重问）
 *   - 题型未定且一致             → 按答案个数反推 single / multiple
 */

const LETTER_RE = /^[A-Z]$/;

function normalizeLetters(list, optionCount) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const s = String(raw == null ? '' : raw).trim().toUpperCase();
    if (!LETTER_RE.test(s)) continue;
    const idx = s.charCodeAt(0) - 65;
    if (optionCount != null && (idx < 0 || idx >= optionCount)) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out.sort();
}

/** 从逐选项判定里取出所有 verdict 为 correct 的字母 */
function verdictLetters(judgements, optionCount) {
  const correct = [];
  const unsure = [];
  const seen = [];
  for (const j of Array.isArray(judgements) ? judgements : []) {
    if (!j || typeof j !== 'object') continue;
    const label = String(j.label == null ? '' : j.label).trim().toUpperCase();
    if (!LETTER_RE.test(label)) continue;
    const idx = label.charCodeAt(0) - 65;
    if (optionCount != null && (idx < 0 || idx >= optionCount)) continue;
    if (seen.includes(label)) continue;
    seen.push(label);
    const verdict = String(j.verdict == null ? '' : j.verdict).trim().toLowerCase();
    if (verdict === 'correct') correct.push(label);
    else if (verdict === 'unsure') unsure.push(label);
  }
  return { correct: correct.sort(), unsure: unsure.sort(), seen: seen.sort() };
}

/**
 * @param {object} p
 * @param {string} p.declaredType  模型自报的题型
 * @param {string} p.questionType  ingest 推断/OCS 给出的题型（single|multiple|judgement|completion|choice）
 * @param {string[]} p.answer      模型自报的答案字母
 * @param {object[]} p.judgements  模型的逐选项判定
 * @param {number} p.optionCount   选项个数
 * @returns {{letters:string[], type:string, conflict:string|null, source:string, detail:object}}
 */
function reconcile({ declaredType, questionType, answer, judgements, optionCount }) {
  const answerLetters = normalizeLetters(answer, optionCount);
  const v = verdictLetters(judgements, optionCount);
  const vLetters = v.correct;
  const detail = { answerLetters, verdictCorrect: vLetters, verdictUnsure: v.unsure, declaredType: declaredType || null, questionType: questionType || null };

  // 题型可信度：OCS 明确给的最可信；否则看模型自报；都没有就是未定
  const declared = ['single', 'multiple', 'judgement', 'completion'].includes(String(declaredType || '').toLowerCase())
    ? String(declaredType).toLowerCase() : null;
  const fromOcs = ['single', 'multiple', 'judgement', 'completion'].includes(String(questionType || '').toLowerCase())
    ? String(questionType).toLowerCase() : null;
  const authoritative = fromOcs; // 只有 OCS 给的才算权威

  const same = answerLetters.join('') === vLetters.join('');

  // 两边都空 → 彻底没答案
  if (!answerLetters.length && !vLetters.length) {
    return { letters: [], type: declared || fromOcs || questionType, conflict: 'no-answer', source: 'empty', detail };
  }
  // 只有一边有 → 用有的那边，标记来源
  if (!answerLetters.length) {
    return {
      letters: vLetters, type: declared || fromOcs || questionType,
      conflict: 'answer-missing-used-verdicts', source: 'verdict-only', detail,
    };
  }
  if (!vLetters.length) {
    return {
      letters: answerLetters, type: declared || fromOcs || questionType,
      conflict: 'verdicts-missing-used-answer', source: 'answer-only', detail,
    };
  }

  if (same) {
    // 一致：题型未定时，用答案个数反推单选/多选（这是最可靠的推断，因为经过了复核）
    let type = authoritative || declared;
    if (!type || type === 'choice') type = answerLetters.length > 1 ? 'multiple' : 'single';
    return { letters: answerLetters, type, conflict: null, source: 'agree', detail };
  }

  // —— 不一致：按权威题型分级处理 ——
  if (authoritative === 'multiple') {
    // 权威多选：并集，专门纠"漏选"
    const union = [...new Set(answerLetters.concat(vLetters))].sort();
    const missing = union.filter((l) => !answerLetters.includes(l));
    return {
      letters: union, type: 'multiple',
      conflict: missing.length ? 'verdicts-有额外correct已并入:' + missing.join('') : null,
      source: 'union-for-multiple', detail,
    };
  }
  if (authoritative === 'single' || authoritative === 'judgement') {
    // 权威单选/判断：以 answer 为准，但记录不一致
    return {
      letters: answerLetters.slice(0, 1), type: authoritative,
      conflict: 'verdicts与answer不一致(verdicts认为' + vLetters.join('') + ')',
      source: 'answer-for-single', detail,
    };
  }

  // 题型未定 → 以 answer 为准，但标记需复核，让上层做定向重问
  let type = declared;
  if (!type || type === 'choice') type = answerLetters.length > 1 ? 'multiple' : 'single';
  return {
    letters: answerLetters, type,
    conflict: 'choice题verdicts与answer不一致(verdicts认为' + vLetters.join('') + ')',
    source: 'answer-for-ambiguous', detail,
  };
}

module.exports = { reconcile, verdictLetters, normalizeLetters };
