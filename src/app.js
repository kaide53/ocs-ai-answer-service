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

/** 只取需要的字段，POST body 与 GET query 共用一套逻辑 */
function pickParams(src) {
  const s = src || {};
  const str = (v) => (v === undefined || v === null ? undefined : String(v));
  return {
    question: str(s.question),
    options: str(s.options),
    type: str(s.type),
    course: str(s.course),
    _probe: s.t !== undefined && s.question === undefined, // OCS 探测带 ?t=时间戳
  };
}

async function handleAnswer(res, params) {
  const started = Date.now();
  console.log('=========================================');
  console.log('题目：', params.question);
  console.log('题型：', params.type || '(未传)', '｜课程：', params.course || '(用默认)', '｜原始选项：', params.options);

  let result;
  try {
    result = await answerQuestion({
      question: params.question,
      options: params.options,
      type: params.type,
      course: params.course, // 可选：每题单独指定课程，留空则用 .env 的 COURSE_CONTEXT
    });
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
}

const SERVICE_INFO = {
  ok: true,
  service: 'ocs-ai-answer-service',
  usage: 'POST /answer  { question, options, type }；也支持 GET /answer?question=...&options=...&type=...',
};

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
      courseContext: cfg.COURSE_CONTEXT || '',
      search: { enabled: cfg.SEARCH.ENABLED, mode: cfg.SEARCH.MODE },
      cache: cache.stats(),
    });
  });

  app.get('/', (req, res) => res.json(SERVICE_INFO));

  app.post('/answer', (req, res) => handleAnswer(res, pickParams(req.body)));

  /**
   * OCS 5.x 的「题库可用性探测」（probeAnswerer）会先发 **HEAD** /answer?t=<时间戳>，
   * 只有 405/501 才会回退 GET，并且只把 2xx/3xx 视为「连接成功」。
   * 只注册 POST 的话这里会 404，面板就一直显示「连接失败（404）」。
   *
   * Express 会用 GET 路由自动应答 HEAD，所以注册 GET 就同时修好了探测；
   * 顺带也让题库配置可以用 method: "get"（参数走 query）。
   */
  app.get('/answer', (req, res) => {
    const params = pickParams(req.query);
    if (params._probe || (!params.question && !params.options)) {
      // 探测请求 / 直接浏览器打开：返回 200 + 自述信息
      return res.json(Object.assign({ code: 0, msg: '服务在线，请用 POST 提交题目' }, SERVICE_INFO));
    }
    return handleAnswer(res, params);
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
