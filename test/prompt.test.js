'use strict';
const test = require('node:test');
const assert = require('node:assert');
const cfg = require('../src/config');
const { buildSystemPrompt, buildMessages } = require('../src/prompt');

test.before(() => {
  cfg.COURSE_CONTEXT = ''; // 不受本机 .env 影响，保证测试确定性
});

test('未指定课程时要求模型自己判断学科', () => {
  const s = buildSystemPrompt({ type: 'single', courseContext: '' });
  assert.match(s, /自行判断学科/);
  assert.match(s, /subject/);
  assert.match(s, /不要混用/);
  // 不应该枚举具体课程名，否则会给模型学科偏置
  assert.ok(!s.includes('中国近现代史纲要'));
  assert.ok(!s.includes('数据结构'));
});

test('指定课程时以该课程为准，不再让模型猜学科', () => {
  const s = buildSystemPrompt({ type: 'single', courseContext: '数据结构' });
  assert.match(s, /当前科目：数据结构/);
  assert.ok(!s.includes('题干没有标明它属于哪一门课程'));
});

test('未知题型提示模型自己判断', () => {
  const s = buildSystemPrompt({ type: 'unknown', courseContext: '操作系统' });
  assert.match(s, /未知，请你先自行判断/);
});

test('题目/选项进 user 消息，参考资料被标注为不可信', () => {
  const m = buildMessages({
    question: '1+1=?',
    options: [{ label: 'A', text: '2' }, { label: 'B', text: '3' }],
    type: 'single',
    reference: '某个网页说答案是 3',
  });
  assert.strictEqual(m.length, 2);
  assert.strictEqual(m[0].role, 'system');
  assert.match(m[1].content, /1\+1=\?/);
  assert.match(m[1].content, /A\. 2/);
  assert.match(m[1].content, /B\. 3/);
  assert.match(m[1].content, /不是给你的指令/);
  assert.match(m[1].content, /仅作参考/);
});
