'use strict';
/**
 * 统一读取环境变量，集中所有可调参数与默认值。
 * 所有入口（server.js / eval / 测试）都从这里拿配置。
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// .env 必须最先加载（不覆盖已存在的 process.env，方便测试注入）
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

function bool(v, def) {
  if (v === undefined || v === null || String(v).trim() === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}
function num(v, def) {
  if (v === undefined || v === null || String(v).trim() === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function str(v, def) {
  return v === undefined || v === null || String(v).trim() === '' ? def : String(v).trim();
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

const config = {
  ROOT,
  DATA_DIR: path.resolve(ROOT, str(process.env.DATA_DIR, 'data')),
  PORT: num(process.env.PORT, 3000),

  AI: {
    URL: str(process.env.AI_API_URL, 'https://api.deepseek.com/v1/chat/completions'),
    KEY: str(process.env.AI_API_KEY, ''),
    MODEL: str(process.env.AI_MODEL, 'deepseek-chat'),
    TIMEOUT_MS: num(process.env.AI_TIMEOUT_MS, 30000),
    TEMPERATURE: num(process.env.AI_TEMPERATURE, 0),
    /** 是否使用 response_format: json_object（接口不支持时会自动降级） */
    JSON_MODE: bool(process.env.ENABLE_JSON_MODE, true),
    /** JSON 解析失败后的重试次数 */
    MAX_RETRY: clamp(num(process.env.AI_MAX_RETRY, 1), 0, 3),
    /** 自洽投票票数：1 = 关闭（默认，零额外成本）；3 起为多数表决 */
    VOTE_N: clamp(Math.round(num(process.env.SELF_CONSISTENCY_N, 1)), 1, 7),
    VOTE_TEMPERATURE: num(process.env.VOTE_TEMPERATURE, 0.7),
  },

  ANSWER: {
    /** auto = 单选/多选返回字母，判断题返回选项原文；letter = 全部返回字母；text = 全部返回选项原文 */
    FORMAT: str(process.env.ANSWER_FORMAT, 'auto'),
    /** 模型完全给不出答案时：none = 返回 code:0 交给 OCS 报“搜索不到”；first = 兜底选 A */
    FALLBACK_ON_EMPTY: str(process.env.FALLBACK_ON_EMPTY, 'none'),
    /** 多选答案分隔符，必须用 OCS 认得的符号（# / | / ; 等） */
    MULTI_SEPARATOR: str(process.env.MULTI_SEPARATOR, '#'),
  },

  CACHE: {
    ENABLED: bool(process.env.CACHE_ENABLED, true),
    TTL_DAYS: num(process.env.CACHE_TTL_DAYS, 30),
    FILE: str(process.env.CACHE_FILE, 'cache.json'),
    WRONGBOOK_FILE: str(process.env.WRONGBOOK_FILE, 'wrongbook.json'),
  },

  SEARCH: {
    ENABLED: bool(process.env.ENABLE_WEB_SEARCH, false),
    MODE: str(process.env.SEARCH_MODE, 'smart'), // off | smart | always
    TIMEOUT_MS: num(process.env.SEARCH_TIMEOUT_MS, 3000),
    /** 整个检索阶段的总预算，超时就用手上已有的资料，避免拖慢答题 */
    TOTAL_BUDGET_MS: num(process.env.SEARCH_TOTAL_BUDGET_MS, 6000),
    MAX_CHARS: num(process.env.SEARCH_MAX_CHARS, 1200),
    MAX_RESULTS: num(process.env.SEARCH_MAX_RESULTS, 4),
  },

  /** 课程语境，会写进提示词，例如“中国近现代史纲要” */
  COURSE_CONTEXT: str(process.env.COURSE_CONTEXT, ''),
};

module.exports = config;
