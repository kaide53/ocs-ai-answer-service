'use strict';
/**
 * 配置：全部来自环境变量，集中默认值。
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

function bool(v, def) {
  if (v === undefined || v === null || String(v).trim() === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}
function num(v, def) {
  const n = Number(v);
  return v === undefined || String(v).trim() === '' || !Number.isFinite(n) ? def : n;
}
function str(v, def) {
  return v === undefined || v === null || String(v).trim() === '' ? def : String(v).trim();
}

module.exports = {
  ROOT,
  PORT: num(process.env.PORT, 3000),
  DATA_DIR: path.resolve(ROOT, str(process.env.DATA_DIR, 'data')),
  LOG_DIR: path.resolve(ROOT, str(process.env.LOG_DIR, 'logs')),
  /** 请求体上限。OCS 5.x 会把图片转成 base64 直传，几 MB 很正常 */
  MAX_BODY_BYTES: num(process.env.MAX_BODY_BYTES, 16 * 1024 * 1024),

  /** 原始报文捕获：新项目的第一课——先看清 OCS 到底发什么 */
  CAPTURE: {
    ENABLED: bool(process.env.CAPTURE_ENABLED, true),
    FILE: str(process.env.CAPTURE_FILE, 'capture.jsonl'),
    /** 同时把 headers / query 也记下来 */
    HEADERS: bool(process.env.CAPTURE_HEADERS, true),
  },

  /** 答题开关：捕获阶段可以整体关掉，只观察不调用模型 */
  SOLVE: {
    ENABLED: bool(process.env.SOLVE_ENABLED, false),
  },

  AI: {
    URL: str(process.env.AI_API_URL, ''),
    KEY: str(process.env.AI_API_KEY, ''),
    MODEL: str(process.env.AI_MODEL, ''),
    /**
     * 思考等级 low|high|max。**不传时接口默认 high**，对"每题都要跑完"的服务偏慢。
     * 实测 deepseek-flash / deepseek-v4-pro 都支持这三档，默认 high。
     */
    EFFORT: str(process.env.AI_EFFORT, 'low'),
    TIMEOUT_MS: num(process.env.AI_TIMEOUT_MS, 90000),
    TEMPERATURE: num(process.env.AI_TEMPERATURE, 0),
    JSON_MODE: bool(process.env.ENABLE_JSON_MODE, true),
    MAX_RETRY: num(process.env.AI_MAX_RETRY, 1),
    /** 上游 429/5xx/网络抖动的额外重试次数（与上面的"JSON 解析失败重试"是两回事） */
    MAX_NETWORK_RETRY: num(process.env.AI_MAX_NETWORK_RETRY, 2),
    RETRY_BASE_MS: num(process.env.AI_RETRY_BASE_MS, 1500),
    /** 是否把题干里的 img.src 还原成图片附件发给多模态模型 */
    SEND_IMAGES: bool(process.env.SEND_IMAGES, true),
    MAX_IMAGES: num(process.env.MAX_IMAGES, 4),
    /** 流式请求：终端能边收边显示；关掉则退回一次性返回 */
    STREAM: bool(process.env.AI_STREAM, true),
    /** 空闲超时：连续这么久没收到任何数据才判失败（流式下比等满整请求上限更早发现问题） */
    IDLE_TIMEOUT_MS: num(process.env.AI_IDLE_TIMEOUT_MS, 30000),
  },

  /**
   * 终端界面。默认全部 auto：
   * 非 TTY / TERM=dumb / NO_COLOR 时自动退回纯文本，行为与加 UI 之前一致。
   */
  UI: {
    /** auto | rich | plain。auto：是 TTY 且 TERM!=dumb 才用富界面 */
    STYLE: str(process.env.UI_STYLE, 'auto'),
    /** auto | always | never */
    COLOR: str(process.env.UI_COLOR, 'auto'),
    /** 0 = 按终端宽度自动；否则固定总宽（会被钳到 44..100） */
    WIDTH: num(process.env.UI_WIDTH, 0),
  },

  /** 回写策略：见 docs/OCS-CONTRACT.md 第五节 */
  EMIT: {
    /** text = 回选项原文（默认，走 OCS 阶段1/2 文本匹配）；letter = 回字母（阶段3 兜底） */
    MODE: str(process.env.EMIT_MODE, 'text'),
    /** 回写前用 OCS 官方匹配算法自检，不通过则自动降级 */
    VERIFY: bool(process.env.EMIT_VERIFY, true),
  },
};
