'use strict';
/**
 * reconcile 的策略测试。
 *
 * 核心是被实测数据驱动的一条权衡：
 *  - 权威多选题 → 用**并集**（对着"漏选"这个主风险纠偏）
 *  - 权威单选题 → 用 answer（不能被 verdict 带偏成多选）
 *  - 题型未定且不一致 → 用 answer 但标记冲突，交由上层定向重问
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcile } = require('../src/reconcile');

const j = (label, verdict) => ({ label, verdict, why: '' });

test('两边一致且多于一个 → 判为多选（题型未定也能反推出来）', () => {
  const r = reconcile({
    declaredType: 'choice', questionType: 'choice',
    answer: ['A', 'C'], judgements: [j('A', 'correct'), j('B', 'wrong'), j('C', 'correct'), j('D', 'wrong')],
    optionCount: 4,
  });
  assert.deepEqual(r.letters, ['A', 'C']);
  assert.equal(r.type, 'multiple');
  assert.equal(r.conflict, null);
  assert.equal(r.source, 'agree');
});

test('两边一致且只有一个 → 判为单选', () => {
  const r = reconcile({
    declaredType: 'single', questionType: 'choice',
    answer: ['B'], judgements: [j('A', 'wrong'), j('B', 'correct'), j('C', 'wrong'), j('D', 'wrong')],
    optionCount: 4,
  });
  assert.deepEqual(r.letters, ['B']);
  assert.equal(r.type, 'single');
  assert.equal(r.conflict, null);
});

test('【关键】权威多选题 + 判定比答案多 → 用并集，把漏选的补回来', () => {
  // 模型判对了 C 是 correct，却忘了写进 answer —— 这是多选最主要的失分模式
  const r = reconcile({
    declaredType: 'multiple', questionType: 'multiple',
    answer: ['A', 'B'], judgements: [j('A', 'correct'), j('B', 'correct'), j('C', 'correct'), j('D', 'wrong')],
    optionCount: 4,
  });
  assert.deepEqual(r.letters, ['A', 'B', 'C'], 'C 必须被补回来');
  assert.equal(r.source, 'union-for-multiple');
  assert.match(r.conflict, /C/);
});

test('【关键】权威单选题 + 判定说多个正确 → 坚持单选，不被带偏成多选', () => {
  const r = reconcile({
    declaredType: 'single', questionType: 'single',
    answer: ['B'], judgements: [j('A', 'wrong'), j('B', 'correct'), j('C', 'correct'), j('D', 'wrong')],
    optionCount: 4,
  });
  assert.deepEqual(r.letters, ['B'], '单选题给多个答案会被 OCS 阶段1 取第一个命中，风险更大');
  assert.equal(r.type, 'single');
  assert.equal(r.source, 'answer-for-single');
  assert.match(r.conflict, /不一致/);
});

test('题型未定 + 不一致 → 用 answer 但标记冲突（触发上层定向重问）', () => {
  const r = reconcile({
    declaredType: 'single', questionType: 'choice',
    answer: ['A'], judgements: [j('A', 'correct'), j('B', 'correct'), j('C', 'wrong'), j('D', 'wrong')],
    optionCount: 4,
  });
  assert.deepEqual(r.letters, ['A']);
  assert.equal(r.source, 'answer-for-ambiguous');
  assert.match(r.conflict, /choice/);
});

test('判断题走权威单选路径', () => {
  const r = reconcile({
    declaredType: 'judgement', questionType: 'judgement',
    answer: ['B'], judgements: [j('A', 'wrong'), j('B', 'correct')],
    optionCount: 2,
  });
  assert.deepEqual(r.letters, ['B']);
  assert.equal(r.type, 'judgement');
});

test('答案缺失时用判定结果，并标记来源', () => {
  const r = reconcile({
    declaredType: 'multiple', questionType: 'multiple',
    answer: [], judgements: [j('A', 'correct'), j('B', 'correct')],
    optionCount: 4,
  });
  assert.deepEqual(r.letters, ['A', 'B']);
  assert.equal(r.source, 'verdict-only');
  assert.equal(r.conflict, 'answer-missing-used-verdicts');
});

test('判定缺失时用答案，并标记来源', () => {
  const r = reconcile({
    declaredType: 'single', questionType: 'single',
    answer: ['C'], judgements: [],
    optionCount: 4,
  });
  assert.deepEqual(r.letters, ['C']);
  assert.equal(r.source, 'answer-only');
});

test('两边都空 → 明确返回 no-answer，不产生任何字母', () => {
  const r = reconcile({ declaredType: 'single', questionType: 'single', answer: [], judgements: [], optionCount: 4 });
  assert.deepEqual(r.letters, []);
  assert.equal(r.conflict, 'no-answer');
});

test('越界字母被过滤掉（不能把 Z 映射到不存在的选项）', () => {
  const r = reconcile({
    declaredType: 'multiple', questionType: 'multiple',
    answer: ['A', 'Z', '1'], judgements: [j('A', 'correct')],
    optionCount: 4,
  });
  assert.deepEqual(r.letters, ['A']);
});

test('大小写、重复、乱序输入都能归一化', () => {
  const r = reconcile({
    declaredType: 'multiple', questionType: 'multiple',
    answer: ['c', 'A', 'c', 'a'], judgements: [j('a', 'correct'), j('c', 'correct')],
    optionCount: 4,
  });
  assert.deepEqual(r.letters, ['A', 'C']);
});

test('unsure 的判定不会被当成正确项', () => {
  const r = reconcile({
    declaredType: 'single', questionType: 'choice',
    answer: ['B'], judgements: [j('A', 'unsure'), j('B', 'correct'), j('C', 'unsure'), j('D', 'wrong')],
    optionCount: 4,
  });
  assert.deepEqual(r.letters, ['B']);
  assert.deepEqual(r.detail.verdictUnsure, ['A', 'C'], 'unsure 要被单独记录，供事后分析');
});

test('判定里出现选项范围外的字母时忽略它', () => {
  const r = reconcile({
    declaredType: 'single', questionType: 'single',
    answer: ['B'], judgements: [j('B', 'correct'), j('F', 'correct')],
    optionCount: 4,
  });
  assert.deepEqual(r.letters, ['B'], 'F 超出 4 个选项，不能计入');
});
