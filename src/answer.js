'use strict';
/**
 * 答题编排：解析选项 → 查纠错表/缓存 → (可选)联网检索 → 问模型 → 收敛答案 → 落缓存。
 */
const cfg = require('./config');
const cache = require('./cache');
const retrieval = require('./retrieval');
const { parseOptions } = require('./options');
const { buildMessages } = require('./prompt');
const { chat } = require('./ai');
const { resolveAnswer } = require('./parse-answer');

const inflight = new Map();

const TYPE_ALIAS = {
  single: 'single', 单选: 'single', 单选题: 'single', '1': 'single',
  multiple: 'multiple', 多选: 'multiple', 多选题: 'multiple', '2': 'multiple',
  judgement: 'judgement', judge: 'judgement', 判断: 'judgement', 判断题: 'judgement', '3': 'judgement',
  completion: 'completion', fill: 'completion', 填空: 'completion', 填空题: 'completion', '4': 'completion',
};

function normalizeType(t) {
  if (t === undefined || t === null || String(t).trim() === '') return 'unknown';
  const raw = String(t).trim();
  return TYPE_ALIAS[raw.toLowerCase()] || TYPE_ALIAS[raw] || 'unknown';
}

function resolveRaw(raw, options, type) {
  return resolveAnswer({
    raw,
    options,
    type,
    format: cfg.ANSWER.FORMAT,
    fallbackOnEmpty: cfg.ANSWER.FALLBACK_ON_EMPTY,
    separator: cfg.ANSWER.MULTI_SEPARATOR,
  });
}

async function askOnce(messages, temperature, ctx) {
  let raw = await chat(messages, { temperature });
  let resolved = resolveRaw(raw, ctx.options, ctx.type);
  for (let i = 0; i < cfg.AI.MAX_RETRY && !resolved.answer; i++) {
    console.warn('[answer] 模型输出无法解析，第 ' + (i + 1) + ' 次重试');
    const retry = messages.concat([
      { role: 'user', content: '上一次输出无法解析。请只输出 json，不要任何其他文字或代码块。' },
    ]);
    raw = await chat(retry, { temperature });
    resolved = resolveRaw(raw, ctx.options, ctx.type);
  }
  return { raw, resolved };
}

/** 自洽投票：VOTE_N=1 时就是普通单次调用（零额外成本） */
async function askWithVoting(messages, ctx) {
  const n = cfg.AI.VOTE_N;
  if (n <= 1) return askOnce(messages, cfg.AI.TEMPERATURE, ctx);

  const runs = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      askOnce(messages, i === 0 ? cfg.AI.TEMPERATURE : cfg.AI.VOTE_TEMPERATURE, ctx).catch((err) => ({ error: err }))
    )
  );

  const ok = runs.filter((r) => r && r.resolved && r.resolved.answer);
  if (!ok.length) {
    const first = runs.find((r) => r && 'raw' in r);
    if (first) return first;
    throw runs[0].error || new Error('全部投票请求失败');
  }

  const tally = new Map();
  for (const r of ok) {
    const key = [...r.resolved.letters].sort().join('') || '#';
    const cur = tally.get(key);
    if (cur) cur.count += 1;
    else tally.set(key, { count: 1, run: r });
  }
  let best = null;
  for (const v of tally.values()) {
    if (!best || v.count > best.count) best = v; // 平票时保留最早的一票（temperature=0）
  }
  best.run.votes = { total: n, agree: best.count };
  return best.run;
}

async function run({ question, options, type }) {
  let reference = '';
  try {
    reference = await retrieval.retrieve({ question, options, type });
  } catch (err) {
    console.warn('[retrieval] 检索异常，忽略：' + (err && err.message ? err.message : err));
  }

  const messages = buildMessages({
    question,
    options,
    type,
    reference,
    courseContext: cfg.COURSE_CONTEXT,
    separator: cfg.ANSWER.MULTI_SEPARATOR,
  });

  const runResult = await askWithVoting(messages, { options, type });
  const resolved = runResult.resolved;

  if (!resolved.answer) {
    return { code: 0, msg: '模型未给出可用答案', raw: String(runResult.raw || '').slice(0, 200) };
  }

  return {
    code: 1,
    answer: resolved.answer,
    letters: resolved.letters,
    resolvedType: resolved.type,
    conflict: resolved.conflict,
    usedReference: Boolean(reference),
    votes: runResult.votes || undefined,
  };
}

/**
 * @param {object} p
 * @param {string} p.question
 * @param {string} p.options 原始选项字符串
 * @param {string} [p.type]
 * @returns {Promise<{code:number, question?:string, answer?:string}>}
 */
async function answerQuestion({ question, options: rawOptions, type }) {
  const q = String(question == null ? '' : question).trim();
  const parsed = parseOptions(rawOptions);
  const qtype = normalizeType(type);

  if (!q) return { code: 0, msg: '题目为空' };
  // 填空题本来就没有选项；其余题型拿不到选项就无从下手
  if (parsed.length === 0 && qtype !== 'completion') {
    return { code: 0, msg: '选项为空或无法解析' };
  }

  const key = cache.hashKey(q, rawOptions, qtype);

  const cached = cache.get(key);
  if (cached) {
    return { code: 1, question: q, answer: cached.answer, letters: cached.letters, source: cached.source };
  }

  if (inflight.has(key)) return await inflight.get(key);

  const task = run({ question: q, options: parsed, type: qtype });
  inflight.set(key, task);
  let result;
  try {
    result = await task;
  } finally {
    inflight.delete(key);
  }

  if (result.code === 1) {
    cache.set(key, {
      answer: result.answer,
      letters: result.letters,
      type: result.resolvedType,
      model: cfg.AI.MODEL,
    });
  }

  return Object.assign({ question: q, source: 'ai' }, result);
}

module.exports = { answerQuestion, normalizeType, askWithVoting, _inflight: inflight };
