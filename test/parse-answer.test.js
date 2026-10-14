'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resolveAnswer, extractJson, normalizeLetters } = require('../src/parse-answer');
const { parseOptions } = require('../src/options');

const OPTIONS = parseOptions('A. 北京\nB. 上海\nC. 广州\nD. 深圳');
const run = (raw, type, extra) =>
  resolveAnswer(Object.assign({ raw, options: OPTIONS, type: type || 'unknown', format: 'auto', fallbackOnEmpty: 'none', separator: '#' }, extra || {}));

test('标准 JSON：单选返回字母', () => {
  const raw = JSON.stringify({
    question_type: 'single',
    options: [
      { option: 'A', verdict: 'wrong', reason: '时间不符' },
      { option: 'C', verdict: 'correct', reason: '符合题意' },
    ],
    thought: '……',
    answers: ['C'],
  });
  const r = run(raw, 'single');
  assert.strictEqual(r.answer, 'C');
  assert.strictEqual(r.conflict, false);
});

test('带代码围栏与前后缀说明的 JSON', () => {
  const raw = '好的，答案如下：\n\u0060\u0060\u0060json\n{"answers":["B"]}\n\u0060\u0060\u0060\n以上。';
  assert.strictEqual(run(raw, 'single').answer, 'B');
});

test('幽灵选项：解析失败时绝不从 thought 文本里抓字母', () => {
  const raw = '不是 json，"A和B" 里只有 A 提到，还有个 Finish 的字样';
  const r = run(raw, 'single');
  assert.strictEqual(r.answer, '');
  assert.deepStrictEqual(r.letters, []);
});

test('answers 与逐选项 verdict 冲突时以 verdict 为准', () => {
  const raw = JSON.stringify({ options: [{ option: 'A', verdict: 'correct', reason: 'r' }], answers: ['B'] });
  const r = run(raw, 'single');
  assert.strictEqual(r.answer, 'A');
  assert.strictEqual(r.conflict, true);
});

test('多选题按字母升序并用 # 连接', () => {
  const raw = JSON.stringify({ answers: ['C', 'A'] });
  const r = run(raw, 'multiple');
  assert.strictEqual(r.answer, 'A#C');
});

test('type 缺失时按答案个数推断多选', () => {
  assert.strictEqual(run(JSON.stringify({ answers: ['A', 'B'] }), 'unknown').answer, 'A#B');
  assert.strictEqual(run(JSON.stringify({ answers: ['D'] }), 'unknown').answer, 'D');
});

test('单选返回多个字母时只取模型顺序的第一个', () => {
  const r = run(JSON.stringify({ answers: ['C', 'A'] }), 'single');
  assert.strictEqual(r.answer, 'C');
});

test('越界字母被丢弃', () => {
  const r = run(JSON.stringify({ answers: ['F'] }), 'single');
  assert.strictEqual(r.answer, '');
});

test('answers 是字符串而不是数组', () => {
  assert.strictEqual(run(JSON.stringify({ thought: 'x', answers: 'C' }), 'single').answer, 'C');
});

test('判断题：字母映射回选项原文', () => {
  const opts = parseOptions('A. 正确\nB. 错误');
  const r = resolveAnswer({ raw: JSON.stringify({ answers: ['A'] }), options: opts, type: 'judgement', format: 'auto' });
  assert.strictEqual(r.answer, '正确');
});

test('判断题：模型直接给文字答案', () => {
  const opts = parseOptions('A. 对\nB. 错');
  const r = resolveAnswer({ raw: JSON.stringify({ answers: ['错误'] }), options: opts, type: 'judgement', format: 'auto' });
  assert.strictEqual(r.answer, '错');
});

test('填空题：返回 text_answer', () => {
  const r = run(JSON.stringify({ question_type: 'completion', text_answer: '辛亥革命' }), 'completion');
  assert.strictEqual(r.answer, '辛亥革命');
});

test('FALLBACK_ON_EMPTY=first 时才兜底选 A', () => {
  const opts = parseOptions('A. 北京\nB. 上海');
  assert.strictEqual(resolveAnswer({ raw: '垃圾输出', options: opts, type: 'single', fallbackOnEmpty: 'none' }).answer, '');
  assert.strictEqual(resolveAnswer({ raw: '垃圾输出', options: opts, type: 'single', fallbackOnEmpty: 'first' }).answer, '北京');
});

test('extractJson / normalizeLetters 基础行为', () => {
  assert.deepStrictEqual(Object.keys(extractJson('prefix {"a":1} suffix')).length, 1);
  assert.strictEqual(extractJson('完全没有 json'), null);
  assert.deepStrictEqual(normalizeLetters('A、B'), ['A', 'B']);
  assert.deepStrictEqual(normalizeLetters(['A', 'A', 'B']), ['A', 'B']);
});
