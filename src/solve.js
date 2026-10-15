'use strict';
/**
 * solve：调用大模型解题。
 *
 * 与旧方案的关键差别：
 *  1. 题型**不假设已知**——OCS 的 type 77/99 是 "unknown"，所以题型必须自己判，
 *     并且要求模型显式说明「单选还是多选」，多选少选都要能察觉。
 *  2. 逐个选项给判定，但**输出与 OCS 无关**：这里只产出"选了哪几个字母"，
 *     翻译成 OCS 能吃的字符串是 emit.js 的职责（并在那里用 OCS 官方算法自检）。
 *  3. 置信度低或自相矛盾时**允许交白卷**（返回 code:0），不瞎选。
 */
const cfg = require('./config');
const { reconcile } = require('./reconcile');

const SYSTEM = `你是一名中国高校网课题库的答题专家，需要处理各种不同课程的题目。

【最重要的一条】题干和选项是网页 innerText 抓下来的，可能有噪声：多余空格、
选项前缀（A. / A、/ （A））、图片被替换成 http 链接、题目被截断。请容忍这些噪声。

【题型判断】调用方给出的题型可能不准，甚至就是 "unknown"。你必须自己判断：
- 若选项只有 2 个且是「对/错」「正确/错误」这类 → judgement
- 若选项 ≥3 个且**只有 1 个**符合题意 → single
- 若选项 ≥3 个且**至少 2 个**符合题意 → multiple
- 若没有选项、题干里有下划线或空括号 → completion
多选最容易漏选。请对每个选项独立判定，不要因为「已经选够了」就停止分析。

【作答要求】
1. 逐个选项给出 verdict：correct / wrong / unsure，并给一句 why（指错因类型：
   概念混淆、定义或公式不符、条件不满足、主体范围不符、因果倒置、绝对化表述、
   时间/地点/人物不符、计算错误等）。
2. 不确定也要给最可能的判断，不要留空。
3. 只输出 JSON，不要 Markdown 代码块，不要任何前后缀。

【输出结构】
{
  "question_type": "single|multiple|judgement|completion",
  "subject": "你判断的学科",
  "option_judgements": [{"label":"A","verdict":"wrong","why":"概念混淆：……"}],
  "answer": ["C"],
  "text_answer": null,
  "confidence": 0.0,
  "uncertainty": "若有拿不准的点写在这里，没有就写空字符串"
}`;

function buildTextPrompt({ title, options, typeHint, dom, hasImage }) {
  const lines = [];
  lines.push('题目：' + title);
  if (options.length) {
    lines.push('选项：');
    options.forEach((o, i) => lines.push(String.fromCharCode(65 + i) + '. ' + o.text));
  } else {
    lines.push('选项：（无，可能是填空题）');
  }
  if (hasImage) {
    lines.push('');
    lines.push('注意：题干里的 [图片] 占位符对应下面附上的图片，请结合图片内容作答。');
  }
  lines.push('');
  const hints = [];
  if (typeHint) hints.push('调用方给的题型提示：' + typeHint + '（可能不准，以你自己的判断为准）');
  if (dom && dom.url) hints.push('当前页面域名：' + dom.url);
  if (hints.length) lines.push(hints.join('\n'));
  lines.push('');
  lines.push('请按系统提示的 JSON 结构输出。');
  return lines.join('\n');
}

/**
 * 构造 messages。有图片时用 OpenAI 兼容的多模态 content 数组：
 *   [{type:'text',text}, {type:'image_url',image_url:{url}}]
 * 图片地址就是 OCS 塞进题干里的 img.src（DOM 的 img.src 属性本身已是绝对地址）。
 */
function buildMessages(question) {
  const text = buildTextPrompt({
    // 用 textForModel：长 URL 已换成 [图片]，避免 URL 污染题干
    title: question.textForModel || question.title,
    options: question.options,
    typeHint: question.rawType,
    dom: question.dom,
    hasImage: question.flags && question.flags.hasImage,
  });

  // 图片附件：优先用 OCS 5.x 直传的 base64（不需要模型再去下载，也不会撞防盗链）；
  // 没有时退回 img.src URL，让多模态端点自己去取。
  const inline = cfg.AI.SEND_IMAGES ? (question.images || []) : [];
  const urls = cfg.AI.SEND_IMAGES && !inline.length ? ((question.flags && question.flags.imageUrls) || []) : [];
  const sources = (inline.length ? inline : urls).slice(0, cfg.AI.MAX_IMAGES);
  const content = sources.length
    ? [{ type: 'text', text }].concat(
        sources.map((src) => ({ type: 'image_url', image_url: { url: src } }))
      )
    : text;

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content },
  ];
}

function cleanJson(s) {
  return String(s || '').replace(/```json/gi, '').replace(/```/g, '').trim();
}

/** 值得退避重试的 HTTP 状态：上游繁忙/限流 */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callModelOnce(messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.AI.TIMEOUT_MS);
  try {
    const body = { model: cfg.AI.MODEL, messages, temperature: cfg.AI.TEMPERATURE, stream: false };
    // 思考等级：接口默认 high，对"每题都要跑完"的答题服务偏慢，默认降到 low
    if (cfg.AI.EFFORT) body.effort = cfg.AI.EFFORT;
    if (cfg.AI.JSON_MODE) body.response_format = { type: 'json_object' };
    const res = await fetch(cfg.AI.URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.AI.KEY },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error('模型接口 ' + res.status + '：' + text.slice(0, 300));
      err.status = res.status;
      err.retryable = RETRYABLE_STATUS.has(res.status);
      throw err;
    }
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('模型接口返回的不是 JSON：' + text.slice(0, 200)); }
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof content !== 'string') throw new Error('模型返回里没有 content：' + text.slice(0, 200));
    return { content, usage: data.usage };
  } catch (err) {
    // 网络层错误与硬超时同样值得重试
    if (err.name === 'AbortError') { err.retryable = true; err.message = '模型请求超时(' + cfg.AI.TIMEOUT_MS + 'ms)'; }
    else if (err.status === undefined) err.retryable = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 带指数退避的重试包装 */
async function callModel(messages) {
  let lastErr;
  for (let attempt = 0; attempt <= cfg.AI.MAX_NETWORK_RETRY; attempt += 1) {
    try {
      return await callModelOnce(messages);
    } catch (err) {
      lastErr = err;
      if (!err.retryable || attempt >= cfg.AI.MAX_NETWORK_RETRY) throw err;
      const waitMs = Math.round(cfg.AI.RETRY_BASE_MS * Math.pow(2, attempt) + Math.random() * 500);
      console.warn('[solve] 第 ' + (attempt + 1) + ' 次调用失败（' + (err.status || err.name || '未知') + '），' + waitMs + 'ms 后重试：' + String(err.message).slice(0, 140));
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

/** 把一次模型返回解析成结构；失败返回 null */
function parseModelJson(content) {
  try {
    const p = JSON.parse(cleanJson(content));
    return p && typeof p === 'object' ? p : null;
  } catch {
    return null;
  }
}

/**
 * 定向重问：只在「题型未定 + 逐选项判定与最终答案不一致」时触发。
 *
 * 这是把冲突变成行动而不是只打个标记。实测 47 道题型未定的题里 14 道实际是多选，
 * 而多选漏选是最主要的失分模式——所以这里只追问"到底还有没有别的正确项"，
 * 不去推翻模型已经确定的部分。
 */
function buildRecheck(question, parsed, rec) {
  const disputed = [...new Set(
    (rec.detail.verdictCorrect || []).concat(rec.detail.answerLetters || [])
  )].sort();
  const optionLines = question.options
    .map((o, i) => {
      const label = String.fromCharCode(65 + i);
      const mark = disputed.includes(label) ? '  ← 有争议，请重点判断' : '';
      return label + '. ' + o.text + mark;
    })
    .join('\n');

  return [
    {
      role: 'user',
      content: [
        '你的逐选项判定和最终答案是矛盾的，请只解决这个矛盾。',
        '',
        '逐选项判定认为正确的选项：' + (rec.detail.verdictCorrect.join('') || '(无)'),
        '最终答案给出的选项：' + (rec.detail.answerLetters.join('') || '(无)'),
        '',
        '题目：' + (question.textForModel || question.title),
        '选项：',
        optionLines,
        '',
        '请重新审视上面标了「有争议」的选项，逐个给出 verdict 和理由，然后回答：',
        '这道题究竟是**单选还是多选**？再给出最终答案（多选必须把所有正确项都列出来，不要漏）。',
        '注意：OCS 的题型提示不可信，必须靠题干和选项自己判断。',
        '',
        '仍然只输出那个 JSON 结构，不要任何其他文字。',
      ].join('\n'),
    },
  ];
}

/**
 * @returns {Promise<{ok:boolean, letters?:string[], textAnswer?:string|null, type?:string,
 *                    confidence?:number, usage?:object, raw?:string, reason?:string}>}
 */
async function solve(question) {
  if (!cfg.AI.KEY || !cfg.AI.URL || !cfg.AI.MODEL) {
    return { ok: false, reason: 'AI_API_KEY / AI_API_URL / AI_MODEL 未配置完整' };
  }
  const messages = buildMessages(question);
  const first = await callModel(messages);
  const usageAll = [first.usage];

  let parsed = parseModelJson(first.content);
  let rawAll = first.content;
  if (!parsed) {
    // JSON 解析失败只重试一次：把上次输出丢回去要求纯 JSON
    const retry = messages.concat([
      { role: 'assistant', content: String(first.content).slice(0, 2000) },
      { role: 'user', content: '上一次输出不是合法 JSON。请只输出 JSON 本体，不要任何其他文字或代码块。' },
    ]);
    const again = await callModel(retry);
    usageAll.push(again.usage);
    rawAll = again.content;
    parsed = parseModelJson(again.content);
    if (!parsed) {
      return { ok: false, reason: '模型两次都没给出合法 JSON', raw: String(again.content).slice(0, 300) };
    }
  }

  const declared = String(parsed.question_type || '').toLowerCase();
  let rec = reconcile({
    declaredType: declared,
    questionType: question.type,
    answer: parsed.answer,
    judgements: parsed.option_judgements,
    optionCount: question.options.length,
  });

  // —— 定向重问：只在题型未定且判定与答案冲突时触发一次 ——
  let rechecked = false;
  let finalParsed = parsed;
  if (rec.source === 'answer-for-ambiguous' && question.options.length) {
    try {
      const recheck = await callModel(messages.concat(buildRecheck(question, parsed, rec)));
      usageAll.push(recheck.usage);
      const p2 = parseModelJson(recheck.content);
      if (p2) {
        const rec2 = reconcile({
          declaredType: String(p2.question_type || '').toLowerCase(),
          questionType: question.type,
          answer: p2.answer,
          judgements: p2.option_judgements,
          optionCount: question.options.length,
        });
        // 重问只在"给出更多正确项"或"明确改口"时采信，避免把已经答对的题改坏
        const grew = rec2.letters.length > rec.letters.length;
        if (grew || rec2.source === 'agree') {
          rec = rec2;
          finalParsed = p2;
          rechecked = true;
        }
      }
    } catch (err) {
      console.warn('[solve] 定向重问失败，沿用首次结论：' + ((err && err.message) || err));
    }
  }

  const type = rec.type;
  const letters = rec.letters;

  // 遗留一致性检查（reconcile 之外的情况，例如模型自称单选但给了多个）
  let conflict = rec.conflict || '';
  if (!conflict && type === 'single' && letters.length > 1) conflict = '模型自称单选却给了多个答案';
  if (!conflict && type === 'multiple' && letters.length === 1) conflict = '模型自称多选却只给了一个答案';

  return {
    ok: letters.length > 0 || Boolean(finalParsed.text_answer),
    letters,
    textAnswer: finalParsed.text_answer == null ? null : String(finalParsed.text_answer),
    type,
    declaredType: declared || null,
    subject: finalParsed.subject || '',
    confidence: typeof finalParsed.confidence === 'number' ? finalParsed.confidence : null,
    uncertainty: finalParsed.uncertainty || '',
    conflict: conflict || null,
    judgements: Array.isArray(finalParsed.option_judgements) ? finalParsed.option_judgements : [],
    reconcileSource: rec.source,
    rechecked,
    usage: usageAll.filter(Boolean),
    raw: String(rawAll).slice(0, 4000),
  };
}

module.exports = { solve, buildMessages, buildTextPrompt, buildRecheck, parseModelJson, SYSTEM };
