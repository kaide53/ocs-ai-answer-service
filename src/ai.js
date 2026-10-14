'use strict';
const axios = require('axios');
const cfg = require('./config');

const REASONER_RE = /reasoner|thinking/i;

function buildBody(messages, { temperature, jsonMode }) {
  const body = { model: cfg.AI.MODEL, messages, stream: false };
  // reasoner / thinking 模型不接受 temperature，传了反而可能报错
  if (!REASONER_RE.test(cfg.AI.MODEL)) body.temperature = temperature;
  if (jsonMode) body.response_format = { type: 'json_object' };
  return body;
}

function describeError(data) {
  try {
    const s = typeof data === 'string' ? data : JSON.stringify(data);
    return s.slice(0, 300);
  } catch {
    return String(data).slice(0, 300);
  }
}

/**
 * 调用一次 chat completions。
 * @returns {Promise<string>} 模型输出的文本
 */
async function chat(messages, opts = {}) {
  if (!cfg.AI.KEY) throw new Error('AI_API_KEY 未配置');
  const temperature = opts.temperature === undefined ? cfg.AI.TEMPERATURE : opts.temperature;
  const wantJson = opts.jsonMode === undefined ? cfg.AI.JSON_MODE : opts.jsonMode;

  const post = (jsonMode) =>
    axios.post(cfg.AI.URL, buildBody(messages, { temperature, jsonMode }), {
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.AI.KEY,
      },
      timeout: cfg.AI.TIMEOUT_MS,
      validateStatus: () => true,
    });

  let res = await post(wantJson);
  if (res.status >= 400 && wantJson) {
    // 接口不支持 response_format 时自动降级（DeepSeek 之外的兼容端点常见）
    console.warn('[ai] response_format 被拒绝(' + res.status + ')，降级为纯提示词约束：' + describeError(res.data));
    res = await post(false);
  }
  if (res.status >= 400) {
    throw new Error('AI 接口返回 ' + res.status + '：' + describeError(res.data));
  }

  const content = res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message
    ? res.data.choices[0].message.content
    : '';
  return content || '';
}

module.exports = { chat };
