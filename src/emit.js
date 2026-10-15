'use strict';
/**
 * emit：把「选中的选项」转成 OCS 能匹配上的答案字符串，并在回写前用
 * OCS 官方匹配算法自检（src/ocs/matcher.js 是从 OCS 源码移植的）。
 *
 * 依据 docs/OCS-CONTRACT.md 第三节：
 *  - OCS 的匹配是**文本匹配**（阶段1 归一化精确 / 阶段2 相似>0.6），字母只是阶段3 兜底
 *  - 判断题只有关键词匹配，**返回字母一定失败**
 *  - splitAnswer 第一步就试 JSON.parse → 回 `'["A文本","B文本"]'` 可完全绕开分隔符歧义
 *  - 单选只能给 1 个元素；多选字母必须升序不重复
 */
const matcher = require('./ocs/matcher');

/** 候选生成：按「最可能被 OCS 匹配上」的顺序排列 */
function candidates({ type, options, letters, textAnswer }) {
  const texts = options.map((o) => o.text);
  const raws = options.map((o) => o.raw || o.text);
  const idx = (letters || []).map((L) => String(L).toUpperCase().charCodeAt(0) - 65)
    .filter((i) => i >= 0 && i < options.length);
  const pickedText = idx.map((i) => texts[i]);
  const pickedRaw = idx.map((i) => raws[i]);
  const sortedLetters = [...new Set((letters || []).map((L) => String(L).toUpperCase()))]
    .filter((L) => /[A-Z]/.test(L) && L.charCodeAt(0) - 65 < options.length)
    .sort();

  if (type === 'completion') {
    return textAnswer ? [{ answer: String(textAnswer), strategy: 'text' }] : [];
  }
  if (type === 'judgement') {
    // 判断题必须回文本；优先回选项原文，其次回选项纯文本，最后回"正确/错误"词
    const out = [];
    if (pickedRaw.length === 1) out.push({ answer: pickedRaw[0], strategy: 'option-raw' });
    if (pickedText.length === 1 && pickedText[0] !== pickedRaw[0]) {
      out.push({ answer: pickedText[0], strategy: 'option-text' });
    }
    if (sortedLetters.length === 1) {
      out.push({ answer: sortedLetters[0], strategy: 'letter(known-bad)' });
    }
    return out;
  }
  if (type === 'multiple' || (type === 'choice' && sortedLetters.length > 1)) {
    // 注意：type === 'choice'（单选多选未定）时也要按选中个数自行分流。
    // 否则选中多项的题会掉进下面的单选分支，白白跳过最强的 text-json 路径。
    const out = [];
    if (pickedText.length > 1) {
      out.push({ answer: JSON.stringify(pickedText), strategy: 'text-json' });
      out.push({ answer: pickedText.join('#'), strategy: 'text-hash' });
    }
    if (pickedRaw.length > 1 && JSON.stringify(pickedRaw) !== JSON.stringify(pickedText)) {
      out.push({ answer: JSON.stringify(pickedRaw), strategy: 'raw-json' });
    }
    if (sortedLetters.length) out.push({ answer: sortedLetters.join('#'), strategy: 'letter' });
    return out;
  }
  // single / choice(单选) / judgement 之外的兜底
  const out = [];
  if (pickedText.length === 1) {
    out.push({ answer: pickedText[0], strategy: 'text' });
    if (pickedRaw[0] && pickedRaw[0] !== pickedText[0]) out.push({ answer: pickedRaw[0], strategy: 'raw' });
  }
  if (sortedLetters.length) out.push({ answer: sortedLetters.join('#'), strategy: 'letter' });
  return out;
}

/** 用 OCS 官方算法验证：这个 answer 会不会被解析成我们想要的选项 */
function verifyOne({ type, options, answer, expectLetters, blankCount }) {
  const opts = options.map((o) => o.raw || o.text);
  const expectIdx = (expectLetters || [])
    .map((L) => String(L).toUpperCase().charCodeAt(0) - 65)
    .filter((i) => i >= 0 && i < opts.length)
    .sort((a, b) => a - b);
  const expectSet = expectIdx.map((i) => opts[i]);

  try {
    if (type === 'judgement') {
      const r = matcher.resolveJudgement([[answer]], opts.map((o) => String(o).trim()));
      return { ok: Boolean(r.finish) && expectSet.includes(r.option), matched: r.option ? [r.option] : [] };
    }
    if (type === 'completion') {
      const blanks = Number(blankCount) || 1;
      const r = matcher.resolveCompletion([[answer]], blanks);
      return { ok: Boolean(r.finish), matched: r.answers || [] };
    }
    if (type === 'multiple') {
      const r = matcher.resolveMultiple([answer], opts);
      const got = (r.finish && (r.options || r.plainOptions)) || [];
      const same = got.length === expectSet.length && expectSet.every((e) => got.includes(e));
      return { ok: Boolean(r.finish) && same, matched: got };
    }
    // single / choice(单选)
    const r = matcher.resolveSingle([answer], opts);
    return { ok: Boolean(r.finish) && expectSet.includes(r.option), matched: r.option ? [r.option] : [] };
  } catch (err) {
    return { ok: false, matched: [], error: String((err && err.message) || err) };
  }
}

/**
 * 生成最终答案：按候选顺序逐个用 OCS 算法自检，取第一个通过的。
 * 全部不通过时返回 ok:false（交给上层返回 code:0，绝不瞎猜）。
 */
function emitVerified({ type, options, letters, textAnswer, blankCount }) {
  const cands = candidates({ type, options, letters, textAnswer });
  if (!cands.length) return { ok: false, reason: '无可生成的答案候选' };

  const tried = [];
  for (const c of cands) {
    const v = verifyOne({ type, options, answer: c.answer, expectLetters: letters, blankCount });
    tried.push({ strategy: c.strategy, answer: c.answer, ok: v.ok, matched: v.matched, error: v.error });
    if (v.ok) return { ok: true, answer: c.answer, strategy: c.strategy, tried };
  }
  return { ok: false, reason: '所有候选都过不了 OCS 匹配算法', tried };
}

module.exports = { candidates, verifyOne, emitVerified };
