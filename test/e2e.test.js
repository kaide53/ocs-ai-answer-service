'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const cfg = require('../src/config');
const TMP_DATA = path.join(__dirname, '.tmp-data');

let mockServer;
let appServer;
let base = '';

/** 假 DeepSeek：根据题目里的标记词返回不同形态的响应 */
function mockHandler(req, res) {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let payload = {};
    try {
      payload = JSON.parse(body);
    } catch {
      /* ignore */
    }
    const user = (payload.messages || []).map((m) => m.content).join('\n');

    let content = JSON.stringify({
      question_type: 'single',
      options: [{ option: 'C', verdict: 'correct', reason: '符合题意' }],
      thought: '推理',
      answers: ['C'],
    });
    if (user.includes('[BADJSON]')) {
      content = '好的，答案如下：\n\u0060\u0060\u0060json\n{"answers":["B"]}\n\u0060\u0060\u0060\n以上。';
    } else if (user.includes('[GHOST]')) {
      content = '不是 json，"A和B" 里只有 A 提到，还有个 Finish 的字样';
    } else if (user.includes('[MULTI]')) {
      content = JSON.stringify({ answers: ['B', 'A'] });
    } else if (user.includes('[JUDGE]')) {
      content = JSON.stringify({ answers: ['A'] });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
}

async function ask(payload) {
  const res = await fetch(base + '/answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return await res.json();
}

test.before(async () => {
  mockServer = http.createServer(mockHandler);
  await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
  const mockPort = mockServer.address().port;

  // 直接改 config 对象，避免依赖 require 顺序
  cfg.AI.URL = 'http://127.0.0.1:' + mockPort + '/v1/chat/completions';
  cfg.AI.KEY = 'test-key';
  cfg.AI.MAX_RETRY = 0;
  cfg.AI.VOTE_N = 1;
  // 缓存/纠错表用测试专用目录，跑完删掉
  fs.rmSync(TMP_DATA, { recursive: true, force: true });
  cfg.DATA_DIR = TMP_DATA;
  cfg.CACHE.ENABLED = true;
  cfg.SEARCH.ENABLED = false;
  cfg.ANSWER.FALLBACK_ON_EMPTY = 'none';

  const { createApp } = require('../src/app');
  appServer = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => appServer.once('listening', r));
  base = 'http://127.0.0.1:' + appServer.address().port;
});

test.after(async () => {
  if (appServer) await new Promise((r) => appServer.close(r));
  if (mockServer) await new Promise((r) => mockServer.close(r));
  fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

test('正常单选返回字母', async () => {
  const r = await ask({ question: '测试 [OK]', options: 'A. 甲\nB. 乙\nC. 丙\nD. 丁', type: 'single' });
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.answer, 'C');
});

test('带围栏和前后缀的 JSON 也能解析', async () => {
  const r = await ask({ question: '测试 [BADJSON]', options: 'A. 甲\nB. 乙\nC. 丙', type: 'single' });
  assert.strictEqual(r.answer, 'B');
});

test('完全解析不了时返回 code:0，绝不瞎选', async () => {
  const r = await ask({ question: '测试 [GHOST]', options: 'A. 甲\nB. 乙\nC. 丙', type: 'single' });
  assert.strictEqual(r.code, 0);
});

test('多选题用 OCS 认得的 # 分隔', async () => {
  const r = await ask({ question: '测试 [MULTI]', options: 'A. 甲\nB. 乙\nC. 丙\nD. 丁', type: 'multiple' });
  assert.strictEqual(r.answer, 'A#B');
  assert.deepStrictEqual(r.letters, ['A', 'B']);
});

test('判断题返回选项原文而不是字母', async () => {
  const r = await ask({ question: '测试 [JUDGE]', options: 'A. 正确\nB. 错误', type: 'judgement' });
  assert.strictEqual(r.answer, '正确');
});

test('选项为空时返回 code:0', async () => {
  const r = await ask({ question: '测试 [OK]', options: '', type: 'single' });
  assert.strictEqual(r.code, 0);
});

test('题目为空时返回 code:0', async () => {
  const r = await ask({ question: '', options: 'A. 甲\nB. 乙', type: 'single' });
  assert.strictEqual(r.code, 0);
});

test('填空/判断题没有选项时也能写入纠错表', async () => {
  const payload = { question: '中国共产党独立领导革命战争、创建人民军队的开始是______。', options: '', type: 'completion', answer: '南昌起义' };
  const fb = await fetch(base + '/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const fbJson = await fb.json();
  assert.strictEqual(fbJson.ok, true);

  const r = await ask({ question: payload.question, options: '', type: 'completion' });
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.answer, '南昌起义');
  assert.strictEqual(r.source, 'wrongbook');
});

test('纠错表命中后不再请求模型（缓存命中）', async () => {
  const payload = { question: '缓存测试题', options: 'A. 甲\nB. 乙', type: 'single', answer: 'B' };
  await fetch(base + '/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const first = await ask({ question: payload.question, options: payload.options, type: payload.type });
  const second = await ask({ question: payload.question, options: payload.options, type: payload.type });
  assert.strictEqual(first.answer, 'B');
  assert.deepStrictEqual(second.letters, ['B']);
  assert.strictEqual(second.source, 'wrongbook');
});

test('/health 可用', async () => {
  const res = await fetch(base + '/health');
  const j = await res.json();
  assert.strictEqual(j.ok, true);
});
