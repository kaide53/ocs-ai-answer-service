'use strict';
/**
 * capture：把 OCS 发来的**原始报文**原样落盘。
 *
 * 这是新项目的第一课——旧项目的日志只记录了我们主动提取的 4 个字段，
 * 导致"OCS 到底发了什么"始终没有一手证据。这里一律先存原始报文。
 *
 * 铁律：捕获失败绝不影响答题流程（只告警）。
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const FILE = path.join(cfg.DATA_DIR, cfg.CAPTURE.FILE);

/** 敏感字段：原样落盘但要标注出来，避免以后误当题目字段用 */
const SENSITIVE = /^(authorization|cookie|x-api-key|api[-_]?key)$/i;

function scrub(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(scrub);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE.test(k)) { out[k] = '<redacted>'; continue; }
    out[k] = v && typeof v === 'object' ? scrub(v) : v;
  }
  return out;
}

/**
 * 记录一次原始请求。
 * @param {object} p
 * @param {string} p.method
 * @param {string} p.url
 * @param {object} p.headers
 * @param {object} p.query
 * @param {any}    p.body
 * @param {object} [p.result] 我们的响应（便于对照"收到什么/回了什么"）
 */
function record(p) {
  if (!cfg.CAPTURE.ENABLED) return;
  try {
    fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      kind: 'ocs_request',
      method: p.method,
      url: p.url,
      query: p.query || {},
      headers: cfg.CAPTURE.HEADERS ? scrub(p.headers) : undefined,
      body: scrub(p.body),
      /** 原始 body 的字符串形式，连类型错误都能看出来 */
      bodyRaw: typeof p.body === 'string' ? p.body : undefined,
      result: p.result,
    };
    fs.appendFileSync(FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    console.warn('[capture] 写入失败（已忽略）：' + ((err && err.message) || err));
  }
}

/** 读回最近 N 条，供 /capture/recent 查看 */
function recent(limit = 20) {
  try {
    if (!fs.existsSync(FILE)) return [];
    const lines = fs.readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return { _unparsable: l.slice(0, 400) }; } });
  } catch (err) {
    return [{ _error: String((err && err.message) || err) }];
  }
}

/**
 * 字段画像：把捕获到的所有请求做一次"到底有哪些字段"的统计。
 * 这正是回答"OCS 每一次发回来的内容是什么样的"最直接的工具。
 */
function profile() {
  const rows = recent(100000);
  const fieldCount = new Map();
  const typeCount = new Map();
  const valueSamples = new Map();
  let total = 0;
  for (const r of rows) {
    if (r.kind !== 'ocs_request') continue;
    const b = r.body;
    if (!b || typeof b !== 'object') continue;
    total += 1;
    for (const [k, v] of Object.entries(b)) {
      fieldCount.set(k, (fieldCount.get(k) || 0) + 1);
      if (!valueSamples.has(k)) valueSamples.set(k, []);
      const arr = valueSamples.get(k);
      if (arr.length < 3) arr.push(typeof v === 'string' ? v.slice(0, 120) : v);
    }
    const t = b.type === undefined ? '(未发)' : String(b.type);
    typeCount.set(t, (typeCount.get(t) || 0) + 1);
  }
  return {
    totalRequests: total,
    fields: [...fieldCount.entries()].sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count, samples: valueSamples.get(name) })),
    typeDistribution: Object.fromEntries([...typeCount.entries()].sort((a, b) => b[1] - a[1])),
  };
}

module.exports = { record, recent, profile, FILE };
