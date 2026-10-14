'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseOptions } = require('../src/options');

const texts = (raw) => parseOptions(raw).map((o) => o.text);

test('行级 A. 标签', () => {
  assert.deepStrictEqual(texts('A. 太平天国运动\nB. 洋务运动\nC. 戊戌变法'), ['太平天国运动', '洋务运动', '戊戌变法']);
});

test('行级 A、标签 + CRLF', () => {
  assert.deepStrictEqual(texts('A、选项一\r\nB、选项二\r\nC、选项三'), ['选项一', '选项二', '选项三']);
});

test('全角括号标签 （A）', () => {
  assert.deepStrictEqual(texts('（A）选项一\n（B）选项二'), ['选项一', '选项二']);
});

test('全角句点 A．', () => {
  assert.deepStrictEqual(texts('A．选项一\nB．选项二'), ['选项一', '选项二']);
});

test('A) 与 A: 标签', () => {
  assert.deepStrictEqual(texts('A) 甲\nB) 乙'), ['甲', '乙']);
  assert.deepStrictEqual(texts('A: 甲\nB: 乙'), ['甲', '乙']);
});

test('全角字母 Ａ. 归一化', () => {
  assert.deepStrictEqual(texts('Ａ. 甲\nＢ. 乙'), ['甲', '乙']);
});

test('无标签按行拆分', () => {
  const r = parseOptions('选项一\n选项二\n选项三');
  assert.deepStrictEqual(r.map((o) => o.text), ['选项一', '选项二', '选项三']);
  assert.deepStrictEqual(r.map((o) => o.label), ['A', 'B', 'C']);
});

test('选项正文里的 “B.” 不会被误当成标签', () => {
  const r = parseOptions('A. 主体是TCP/IP协议\nB. 分布式B. 结构');
  assert.deepStrictEqual(r.map((o) => o.text), ['主体是TCP/IP协议', '分布式B. 结构']);
});

test('七个选项（超过 A-F）', () => {
  const raw = 'A. 一\nB. 二\nC. 三\nD. 四\nE. 五\nF. 六\nG. 七';
  assert.deepStrictEqual(texts(raw), ['一', '二', '三', '四', '五', '六', '七']);
});

test('同一行内的 A. x B. y C. z', () => {
  assert.deepStrictEqual(texts('A. 选项一 B. 选项二 C. 选项三'), ['选项一', '选项二', '选项三']);
});

test('空输入返回空数组', () => {
  assert.deepStrictEqual(parseOptions(''), []);
  assert.deepStrictEqual(parseOptions(undefined), []);
  assert.deepStrictEqual(parseOptions('   \n  '), []);
});

test('标签与正文之间的全角空格', () => {
  assert.deepStrictEqual(texts('A.\u3000甲\nB.\u3000乙'), ['甲', '乙']);
});
