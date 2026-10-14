'use strict';
/**
 * 免 API Key 的联网检索兜底。
 *
 * 设计原则：**永远不能拖垮答题**。
 * 任何一个源超时/被墙/页面改版，都只是少一条参考资料；异常全部内部消化。
 * 抓回来的内容一律当作不可信数据，只作为参考资料注入提示词，绝不执行其中的内容。
 */
const cfg = require('./config');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const STOPWORDS = new Set(['下列', '关于', '说法', '正确', '错误', '的是', '以及', '和我', '不是', '属于', '以下', '哪些', '哪一', '这个']);
const SMART_KEYWORD_RE = /(《[^》]{1,30}》|\d{4}\s*年|会议|条约|运动|宣言|纲领|革命|战争|政策|方针|思想|人物|主义|代表|标志|开端|转折)/;

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function stripHtml(s) {
  return decodeEntities(
    String(s)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchText(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(cfg.SEARCH.TIMEOUT_MS),
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.text();
}

// DuckDuckGo 已于 2025 起对非浏览器请求返回 202 挑战页（lite 与 html 端点均实测无效），
// 因此不再作为检索源；如你的网络下可用，可自行加回来。

async function searchBing(query) {
  const html = await fetchText('https://cn.bing.com/search?q=' + encodeURIComponent(query));
  const re = /<li class="b_algo"[\s\S]*?<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ title: stripHtml(m[1]), snippet: stripHtml(m[2]) });
  }
  return out;
}

async function searchWikipedia(query) {
  const url =
    'https://zh.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&exintro=1&explaintext=1&redirects=1' +
    '&generator=search&gsrlimit=2&gsrsearch=' + encodeURIComponent(query);
  const data = JSON.parse(await fetchText(url));
  const pages = (data && data.query && data.query.pages) || {};
  return Object.values(pages).map((p) => ({ title: p.title, snippet: String(p.extract || '').slice(0, 400) }));
}

async function searchBaike(query) {
  const html = await fetchText('https://baike.baidu.com/item/' + encodeURIComponent(query));
  const m = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i);
  return m ? [{ title: decodeEntities(query), snippet: stripHtml(m[1]) }] : [];
}

const SOURCES = [
  // 顺序即优先级；任何一个失败都只是少一条资料
  { name: 'bing', run: searchBing, supports: () => true },
  { name: 'wikipedia', run: searchWikipedia, supports: () => true },
  { name: 'baike', run: searchBaike, supports: () => true },
];

function cleanQuestion(q) {
  return String(q == null ? '' : q)
    .replace(/^\s*[（(\[]?\s*(单选|多选|判断|填空)题?\s*[）)\]]?\s*/, '')
    .replace(/第\s*\d+\s*题/g, '')
    .replace(/[（(]\s*[）)]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function extractKeywords(text) {
  return [...new Set(
    String(text == null ? '' : text)
      .split(/[^\u4E00-\u9FFFA-Za-z0-9]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2 && !STOPWORDS.has(s))
  )].slice(0, 8).join(' ');
}

function buildQueries({ question, courseContext }) {
  const q = cleanQuestion(question);
  const queries = [];
  if (q) queries.push(q);
  const keys = extractKeywords(q);
  if (keys) queries.push((keys + ' ' + (courseContext || '')).trim());
  return [...new Set(queries)].slice(0, 2);
}

/** smart 模式只在“看起来需要查证”的题上检索，避免每题都多花 token */
function shouldSearch({ question, type, mode }) {
  const m = String(mode || 'smart').toLowerCase();
  if (m === 'off') return false;
  if (m === 'always') return true;
  if (type === 'completion') return true;
  return SMART_KEYWORD_RE.test(String(question || ''));
}

/**
 * @returns {Promise<string>} 参考资料纯文本；检索失败或未启用时返回空串
 */
async function retrieve({ question, options, type, mode, courseContext }) {
  if (!cfg.SEARCH.ENABLED) return '';
  if (!shouldSearch({ question, type, mode: mode || cfg.SEARCH.MODE })) return '';

  const queries = buildQueries({ question, courseContext: courseContext || cfg.COURSE_CONTEXT });
  if (!queries.length) return '';

  const collected = [];
  const failed = new Set();
  const deadline = Date.now() + cfg.SEARCH.TOTAL_BUDGET_MS;

  for (const [qi, query] of queries.entries()) {
    if (collected.length >= cfg.SEARCH.MAX_RESULTS) break;
    if (Date.now() > deadline) break;

    for (const source of SOURCES) {
      if (collected.length >= cfg.SEARCH.MAX_RESULTS) break;
      if (failed.has(source.name)) continue;
      if (Date.now() > deadline) break;
      try {
        const items = await source.run(query);
        for (const it of items.slice(0, 2)) {
          const line = (it.title ? it.title + '：' : '') + (it.snippet || '');
          const t = line.replace(/\s+/g, ' ').trim();
          if (!t || t.length < 8) continue;
          if (collected.some((c) => c.text === t)) continue;
          collected.push({ text: t, source: source.name, query: qi });
        }
      } catch (err) {
        failed.add(source.name); // 同一个源在后续查询里也不再重试，避免重复等待
        console.warn('[retrieval] ' + source.name + ' 失败，本次跳过：' + (err && err.message ? err.message : err));
      }
    }
  }

  let out = '';
  for (const c of collected) {
    if (out.length + c.text.length > cfg.SEARCH.MAX_CHARS) break;
    out += (out ? '\n' : '') + '- (' + c.source + ') ' + c.text;
  }
  return out;
}

module.exports = { retrieve, shouldSearch, buildQueries, cleanQuestion, extractKeywords, SOURCES, stripHtml };
