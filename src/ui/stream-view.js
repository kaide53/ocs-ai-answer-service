'use strict';
/**
 * 从**流式到达的 JSON** 里增量提取逐选项判定。
 *
 * 模型输出的是 JSON 字符串，直接打到终端上正是"工程、赤裸"的来源。
 * 这里把已经**完整闭合**的判定对象挑出来，转成人类可读的一行。
 *
 * 实现要点：
 *  - 只认「已闭合的对象」(`{...}` 里不含嵌套 `{}`)，所以半截对象不会被误报；
 *  - 每次重新扫描整个缓冲区（内容只有几 KB，代价可忽略），
 *    用「匹配起点 + label」去重，避免游标推进把"先到的半截对象"永久跳过；
 *  - 键顺序不敏感：先圈出对象，再在对象内各取各的键；
 *  - 转义序列 `\"` `\\` `\n` `\uXXXX` 都会被还原后再显示。
 */

/** 缓冲上限：超过就认为输出异常，只保留尾部用于提取 */
const MAX_BUFFER = 64 * 1024;

const OBJECT_RE = /\{[^{}]*\}/g;
const LABEL_RE = /"label"\s*:\s*"([A-Za-z])"/;
const VERDICT_RE = /"verdict"\s*:\s*"(correct|wrong|unsure)"/i;
const WHY_RE = /"why"\s*:\s*"((?:[^"\\]|\\.)*)"/;

/** 还原 JSON 字符串字面量里的转义 */
function unescapeJsonString(s) {
  const str = String(s == null ? '' : s);
  let out = '';
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (ch !== '\\') { out += ch; continue; }
    const next = str[i + 1];
    i += 1;
    switch (next) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case '"': out += '"'; break;
      case '\\': out += '\\'; break;
      case '/': out += '/'; break;
      case 'u': {
        const hex = str.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 4; }
        else out += 'u';
        break;
      }
      default: out += next === undefined ? '' : next;
    }
  }
  return out;
}

/**
 * @param {object} [opts]
 * @param {(entry:{label:string,verdict:string,why:string})=>void} [opts.onVerdict]
 */
function createStreamView(opts = {}) {
  let buffer = '';
  const seen = new Set();
  const extracted = [];

  function scan() {
    if (!buffer) return [];
    const fresh = [];
    OBJECT_RE.lastIndex = 0;
    let m;
    while ((m = OBJECT_RE.exec(buffer)) !== null) {
      const objText = m[0];
      const lm = objText.match(LABEL_RE);
      if (!lm) continue;
      const label = lm[1].toUpperCase();
      const key = m.index + ':' + label;
      if (seen.has(key)) continue;
      const vm = objText.match(VERDICT_RE);
      const wm = objText.match(WHY_RE);
      // 没有 verdict 就还不能算一条完整判定
      if (!vm) continue;
      seen.add(key);
      const entry = {
        label,
        verdict: vm[1].toLowerCase(),
        why: wm ? unescapeJsonString(wm[1]).replace(/\s+/g, ' ').trim() : '',
      };
      extracted.push(entry);
      if (typeof opts.onVerdict === 'function') opts.onVerdict(entry);
      fresh.push(entry);
    }
    return fresh;
  }

  return {
    /** 喂入一段流式内容，返回这次新识别出的判定 */
    feed(chunk) {
      if (chunk) {
        buffer += String(chunk);
        if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
      }
      return scan();
    },
    /** 已识别出的全部判定 */
    get verdicts() { return extracted.slice(); },
    /** 原始累积内容（供"一条都没提取出来"时兜底展示） */
    get raw() { return buffer; },
    get count() { return extracted.length; },
  };
}

module.exports = { createStreamView, unescapeJsonString };
