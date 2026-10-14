'use strict';
/**
 * 结果缓存 + 人工纠错表。
 *  - cache.json      : 同一题不再重复问模型（也顺带解决 OCS 并发搜题重复请求）
 *  - wrongbook.json  : 人工纠正的答案，优先级最高
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');

const memory = new Map();
const wrongbook = new Map();
let loaded = false;
let writeTimer = null;

function filePath(name) {
  return path.join(cfg.DATA_DIR, name);
}

/** 纠错表里可能只写了字母答案，这里补出 letters 供回归脚本使用 */
function lettersFromAnswer(answer) {
  const s = String(answer == null ? '' : answer).trim();
  if (!s || s.length > 8) return [];
  const letters = s.replace(/[^A-Za-z]/g, '').toUpperCase();
  return letters ? [...new Set(letters.split(''))] : [];
}

function normText(s) {
  return String(s == null ? '' : s).replace(/\s+/g, '').trim();
}

function hashKey(question, optionsRaw, type) {
  const payload = [normText(question), normText(optionsRaw), String(type || 'unknown').toLowerCase()].join('|');
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function writeJsonAtomic(file, value) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  if (!cfg.CACHE.ENABLED) return;
  try {
    fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
  } catch (err) {
    console.warn('[cache] 无法创建数据目录：' + err.message);
    return;
  }
  const c = readJson(filePath(cfg.CACHE.FILE));
  const entries = c && c.entries && typeof c.entries === 'object' ? c.entries : {};
  for (const [k, v] of Object.entries(entries)) memory.set(k, v);
  const wb = readJson(filePath(cfg.CACHE.WRONGBOOK_FILE));
  for (const [k, v] of Object.entries(wb)) wrongbook.set(k, v);
  if (memory.size || wrongbook.size) {
    console.log('[cache] 已加载 ' + memory.size + ' 条缓存、' + wrongbook.size + ' 条纠错');
  }
}

function scheduleSave() {
  if (!cfg.CACHE.ENABLED) return;
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      writeJsonAtomic(filePath(cfg.CACHE.FILE), { version: 1, entries: Object.fromEntries(memory) });
    } catch (err) {
      console.warn('[cache] 写缓存失败：' + err.message);
    }
  }, 1000);
  if (writeTimer.unref) writeTimer.unref();
}

/**
 * @returns {{answer:string, letters:string[], source:'wrongbook'|'cache'}|null}
 */
function get(key) {
  ensureLoaded();
  if (!cfg.CACHE.ENABLED) return null;

  const wb = wrongbook.get(key);
  if (wb && wb.answer) {
    const wbLetters = wb.letters && wb.letters.length ? wb.letters : lettersFromAnswer(wb.answer);
    return { answer: wb.answer, letters: wbLetters, source: 'wrongbook' };
  }

  const hit = memory.get(key);
  if (!hit || !hit.answer) return null;
  if (cfg.CACHE.TTL_DAYS > 0 && hit.ts) {
    const ageDays = (Date.now() - hit.ts) / 86400000;
    if (ageDays > cfg.CACHE.TTL_DAYS) {
      memory.delete(key);
      return null;
    }
  }
  hit.hits = (hit.hits || 0) + 1;
  hit.lastHit = Date.now();
  scheduleSave();
  const hitLetters = hit.letters && hit.letters.length ? hit.letters : lettersFromAnswer(hit.answer);
  return { answer: hit.answer, letters: hitLetters, source: 'cache' };
}

function set(key, value) {
  ensureLoaded();
  if (!cfg.CACHE.ENABLED) return;
  memory.set(key, Object.assign({ ts: Date.now(), hits: 0 }, value));
  scheduleSave();
}

/** 人工纠错：写入 wrongbook，并覆盖缓存 */
function feedback(key, value) {
  ensureLoaded();
  const entry = Object.assign({ ts: Date.now() }, value);
  wrongbook.set(key, entry);
  memory.set(key, entry);
  if (!cfg.CACHE.ENABLED) return;
  try {
    fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
    writeJsonAtomic(filePath(cfg.CACHE.WRONGBOOK_FILE), Object.fromEntries(wrongbook));
  } catch (err) {
    console.warn('[cache] 写纠错表失败：' + err.message);
  }
}

function stats() {
  ensureLoaded();
  return { cacheEntries: memory.size, wrongbookEntries: wrongbook.size, enabled: cfg.CACHE.ENABLED };
}

module.exports = { hashKey, get, set, feedback, stats, _reset: () => { memory.clear(); wrongbook.clear(); loaded = false; } };
