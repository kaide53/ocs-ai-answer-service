'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const cfg = require('./config');
const cache = require('./cache');
const { answerQuestion } = require('./answer');

function appendJsonl(file, value) {
  fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + '\n', 'utf8');
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      model: cfg.AI.MODEL,
      jsonMode: cfg.AI.JSON_MODE,
      voteN: cfg.AI.VOTE_N,
      answerFormat: cfg.ANSWER.FORMAT,
      fallbackOnEmpty: cfg.ANSWER.FALLBACK_ON_EMPTY,
      search: { enabled: cfg.SEARCH.ENABLED, mode: cfg.SEARCH.MODE },
      cache: cache.stats(),
    });
  });

  app.post('/answer', async (req, res) => {
    const body = req.body || {};
    const started = Date.now();
    console.log('=========================================');
    console.log('题目：', body.question);
    console.log('题型：', body.type || '(未传)', '｜原始选项：', body.options);

    let result;
    try {
      result = await answerQuestion({ question: body.question, options: body.options, type: body.type });
    } catch (err) {
      console.error('[answer] 出错：', (err && err.message) || err);
      result = { code: 0, msg: '答题服务异常：' + ((err && err.message) || err) };
    }

    console.log(
      '结果：code=' + result.code +
      '｜来源=' + (result.source || '-') +
      '｜字母=' + JSON.stringify(result.letters || []) +
      '｜答案=' + (result.answer || '(空)') +
      '｜耗时=' + (Date.now() - started) + 'ms' +
      (result.conflict ? '｜⚠ 自洽冲突' : '') +
      (result.votes ? '｜投票=' + result.votes.agree + '/' + result.votes.total : '') +
      (result.usedReference ? '｜已参考联网资料' : '')
    );

    res.json(result);
  });

  /** 人工纠错：把正确答案钉死，之后同一题直接命中 */
  app.post('/feedback', (req, res) => {
    const body = req.body || {};
    const question = body.question == null ? '' : String(body.question);
    const answer = body.answer == null ? '' : String(body.answer).trim();
    // 填空题没有选项，所以只强制要求 question + answer
    if (!question.trim() || !answer) {
      return res.json({ ok: false, msg: '需要 question 与 answer' });
    }
    const options = body.options == null ? '' : String(body.options);
    const type = body.type ? String(body.type) : 'unknown';
    const key = cache.hashKey(question, options, type);
    cache.feedback(key, { answer, note: body.note || '', question });
    console.log('[feedback] 已记录纠错：', question, '=>', answer);
    res.json({ ok: true, key });
  });

  /** 可选：OCS handler 里用 navigator.sendBeacon 把题面打到这儿，自动攒回归题集 */
  app.post('/collected', (req, res) => {
    const body = req.body || {};
    if (body.question || body.options) {
      try {
        appendJsonl(path.join(cfg.DATA_DIR, 'collected.jsonl'), Object.assign({ ts: Date.now() }, body));
      } catch (err) {
        console.warn('[collected] 写入失败：' + err.message);
      }
    }
    res.json({ ok: true });
  });

  return app;
}

module.exports = { createApp };
