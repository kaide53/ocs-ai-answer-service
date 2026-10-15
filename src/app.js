'use strict';
/**
 * HTTP 层：零依赖，只用 node:http。
 * 路由：
 *   POST /answer              ← OCS 主入口
 *   GET  /answer              ← OCS 5.x 可用性探测（HEAD 也走这里）+ 支持 query 传参
 *   GET  /health  GET /
 *   POST /collected           ← 可选：攒题面
 *   GET  /capture/recent      ← 看最近收到的原始报文（"OCS 到底发了什么"）
 *   GET  /capture/profile     ← 字段画像：一共出现过哪些字段、各多少次、样例
 */
const http = require('http');
const cfg = require('./config');
const capture = require('./capture');
const { ingest } = require('./ingest');
// 注意：emit / solve 一律**延迟 require**。
// 捕获模式下不碰求解器，任何求解侧的依赖缺失都不该让"先看清 OCS 发什么"这一步跑不起来。

const SERVICE_INFO = {
  ok: true,
  service: 'ocs-answer-engine',
  solveEnabled: cfg.SOLVE.ENABLED,
  usage: 'POST /answer { title, options, type, dom? }',
  inspect: ['GET /capture/profile', 'GET /capture/recent?limit=20'],
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req, limit = cfg.MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 只取我们关心的字段；title 与 question 互为别名（旧配置用的是 question） */
function pickParams(src) {
  const s = src || {};
  const g = (k) => (s[k] === undefined || s[k] === null ? undefined : String(s[k]));
  return {
    title: g('title') !== undefined ? g('title') : g('question'),
    options: g('options'),
    type: g('type'),
    dom: s.dom === undefined ? undefined : s.dom,
    // —— OCS 5.x 图片题优化（题库配置里显式引用后才会收到）——
    images: Array.isArray(s.images) ? s.images : undefined,
    suggestion_title: g('suggestion_title'),
    suggestion_options: g('suggestion_options'),
    _probe: s.t !== undefined && s.title === undefined && s.question === undefined,
  };
}

async function handleAnswer(res, params, meta) {
  const started = Date.now();
  const question = ingest(params);

  // —— 输出全部交给 UI 层；UI_STYLE=plain（或非 TTY）时逐字节复刻加 UI 之前的输出 ——
  const ui = require('./ui').getUi();
  const block = ui.beginQuestion({ question });

  if (question.flags.hasImage) {
    const n = question.images.length;
    block.note('图片题：' + (n ? n + ' 张 base64 直传（OCS 5.x 图片优化）' : 'URL 兜底：' + question.flags.imageUrls.join(' ')));
  }
  if (question.flags.completionUnsafe) block.note('多空填空但拿不到空格数，将拒绝作答');

  let result;
  if (!cfg.SOLVE.ENABLED) {
    result = { code: 0, msg: '捕获模式：原始报文已记录，未调用模型（设 SOLVE_ENABLED=true 开始作答）' };
  } else if (question.flags.completionUnsafe) {
    // 依据 docs/OCS-CONTRACT.md §3.4：空格数不知道时作答必然错，宁可交白卷
    result = { code: 0, msg: '多空填空题但拿不到填空框数量，拒绝瞎填' };
  } else {
    try {
      const { solve } = require('./solve');
      const { emitVerified } = require('./emit');
      const s = await solve(question, {
        onEvent: (evt) => {
          if (!evt) return;
          if (evt.type === 'delta') {
            if (evt.reasoning) block.reasoning(evt.reasoning);
            if (evt.content) block.content(evt.content);
          } else if (evt.type === 'phase') block.phase(evt.name);
          else if (evt.type === 'warn') ui.warn(evt.text);
        },
      });
      if (!s.ok) {
        result = { code: 0, msg: '模型未给出可用答案：' + (s.reason || s.conflict || '') };
      } else {
        const emitted = emitVerified({
          type: s.type,
          options: question.options,
          letters: s.letters,
          textAnswer: s.textAnswer,
          blankCount: question.blankCount,
        });
        result = emitted.ok
          ? { code: 1, answer: emitted.answer }
          : { code: 1, answer: emitted.tried && emitted.tried.length ? emitted.tried[emitted.tried.length - 1].answer : '', _emitFailed: true };
        if (!emitted.ok) {
          ui.warn('[emit] OCS 算法自检未通过，已回退到最后一个候选：' + JSON.stringify(emitted.tried));
        }
        result.meta = {
          type: s.type, declaredType: s.declaredType, subject: s.subject,
          confidence: s.confidence, conflict: s.conflict || undefined,
          reconcileSource: s.reconcileSource, rechecked: s.rechecked || undefined,
          emitStrategy: emitted.strategy, emitVerified: emitted.ok,
          letters: s.letters, usage: s.usage,
        };
      }
    } catch (err) {
      ui.error('[answer] 出错：' + ((err && err.message) || err));
      result = { code: 0, msg: '答题服务异常：' + ((err && err.message) || err) };
    }
  }

  result.elapsedMs = Date.now() - started;
  capture.record(Object.assign({}, meta, { result }));
  block.finish({
    msg: result.code === 1 ? undefined : result.msg,
    answer: result.answer,
    elapsedMs: result.elapsedMs,
    meta: result.meta,
    rawResult: result,
  });
  sendJson(res, 200, result);
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const query = Object.fromEntries(url.searchParams.entries());
    const method = req.method || 'GET';

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,HEAD,OPTIONS',
        'Access-Control-Allow-Headers': '*',
      });
      return res.end();
    }

    if (pathname === '/' && method === 'GET') return sendJson(res, 200, SERVICE_INFO);
    if (pathname === '/health' && method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        solveEnabled: cfg.SOLVE.ENABLED,
        captureEnabled: cfg.CAPTURE.ENABLED,
        model: cfg.AI.MODEL || '(未配置)',
        emitMode: cfg.EMIT.MODE,
        emitVerify: cfg.EMIT.VERIFY,
        captured: capture.profile().totalRequests,
      });
    }

    if (pathname === '/capture/profile' && method === 'GET') return sendJson(res, 200, capture.profile());
    if (pathname === '/capture/recent' && method === 'GET') {
      return sendJson(res, 200, { file: capture.FILE, entries: capture.recent(Number(query.limit) || 20) });
    }

    if (pathname === '/collected' && method === 'POST') {
      try {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        capture.record({ method, url: req.url, headers: req.headers, query, body, result: { stored: true } });
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 200, { ok: false, msg: String((err && err.message) || err) });
      }
    }

    // —— 主入口 ——
    if (pathname === '/answer') {
      const meta = { method, url: req.url, headers: req.headers, query };
      if (method === 'HEAD') {
        // OCS 5.x 探测：只把 2xx/3xx 当"连接成功"，且不读 body
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
        return res.end();
      }
      if (method === 'GET') {
        const params = pickParams(query);
        if (params._probe || (params.title === undefined && params.options === undefined)) {
          return sendJson(res, 200, Object.assign({ code: 0, msg: '服务在线，请提交题目' }, SERVICE_INFO));
        }
        meta.body = query;
        return handleAnswer(res, params, meta);
      }
      if (method === 'POST') {
        let body;
        try {
          const raw = await readBody(req);
          body = raw ? JSON.parse(raw) : {};
        } catch (err) {
          capture.record(Object.assign({}, meta, { body: null, result: { code: 0, msg: '请求体不是合法 JSON' } }));
          return sendJson(res, 200, { code: 0, msg: '请求体不是合法 JSON：' + ((err && err.message) || err) });
        }
        meta.body = body;
        return handleAnswer(res, pickParams(body), meta);
      }
      return sendJson(res, 405, { code: 0, msg: '只支持 GET/POST/HEAD' });
    }

    sendJson(res, 404, { code: 0, msg: '未找到该路径' });
  });
}

module.exports = { createServer, pickParams };
