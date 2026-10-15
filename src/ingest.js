'use strict';
/**
 * ingest：把 OCS 发来的 3 个字段，归一化成结构化的「题目对象」。
 *
 * 设计依据见 docs/OCS-CONTRACT.md：
 *  - OCS 只发 title / options / type 三项，且 type 经常是字面量字符串 "unknown"（77/99 实测）
 *  - options 是各选项 innerText 用 \n 拼接的**单个字符串**，保留缩进与尾随空格
 *  - 某个选项的 innerText 内部可能含换行 → 按 \n 切会切多 → 字母索引错位
 *    所以这里按「行首的序号标签」切，而不是按 \n 切
 */

/** 全角字母/数字 → 半角 */
function toHalfWidth(s) {
  return String(s).replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

/** 行首的选项标签：A. / A、/ A．/ A) / A: / （A）/ [A] / A选项 */
const BRACKET_LABEL = /^\s*[（(\[]\s*([A-Za-z])\s*[）)\]]\s*[.．、,，:：]?\s*/;
const BARE_LABEL = /^\s*([A-Za-z])\s*[.．、,，:：)）\]】]\s*/;
/** 字母直接紧跟中文（"A选项"），但 "TCP协议" 不该被误判——要求后面跟中文 */
const CN_LABEL = /^\s*([A-Za-z])([\u4E00-\u9FFF][\s\S]*)$/;

function matchLabel(line) {
  let m = line.match(BRACKET_LABEL);
  if (m) return { letter: m[1].toUpperCase(), rest: line.slice(m[0].length) };
  m = line.match(BARE_LABEL);
  if (m) return { letter: m[1].toUpperCase(), rest: line.slice(m[0].length) };
  m = line.match(CN_LABEL);
  if (m) return { letter: m[1].toUpperCase(), rest: m[2] };
  return null;
}

/**
 * 解析选项：按「行首序号标签」切分，续行并入上一个选项。
 * 这样即使某个选项内部含换行，也不会被切多。
 * @returns {{label:string|null, text:string, raw:string}[]}
 */
function parseOptions(rawOptions) {
  const text = toHalfWidth(rawOptions == null ? '' : rawOptions).replace(/\r\n?/g, '\n');
  if (!text.trim()) return [];

  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const grouped = [];
  let expected = 0;
  let labeled = 0;

  for (const line of lines) {
    const m = matchLabel(line);
    const expectedLetter = expected < 26 ? String.fromCharCode(65 + expected) : null;
    if (m && m.letter === expectedLetter) {
      grouped.push({ label: m.letter, text: m.rest.trim(), raw: line.trim() });
      expected += 1;
      labeled += 1;
    } else if (grouped.length) {
      // 续行：并入上一个选项（多行选项的救星）
      const last = grouped[grouped.length - 1];
      last.text = (last.text + ' ' + line.trim()).trim();
      last.raw = last.raw + '\n' + line.trim();
    } else {
      grouped.push({ label: null, text: line.trim(), raw: line.trim() });
    }
  }

  // 一个标签都没识别出来 → 退回「非空行即一个选项」
  if (labeled < 2) {
    return lines.map((l, i) => ({ label: String.fromCharCode(65 + i), text: l.trim(), raw: l.trim() }));
  }

  // 给无标签的项按位置补字母
  return grouped.map((g, i) => ({ label: g.label || String.fromCharCode(65 + i), text: g.text, raw: g.raw }));
}

/** OCS 的 type 可能是 "unknown"/"undefined"/"null" 字面量，或是我们想要的四个值 */
const VALID_TYPES = new Set(['single', 'multiple', 'judgement', 'completion']);
function normalizeOcsType(t) {
  const s = String(t == null ? '' : t).trim().toLowerCase();
  if (['', 'unknown', 'undefined', 'null', 'none', '0', 'false'].includes(s)) return null;
  const alias = {
    single: 'single', 单选: 'single', 单选题: 'single', '1': 'single',
    multiple: 'multiple', 多选: 'multiple', 多选题: 'multiple', '2': 'multiple',
    judgement: 'judgement', judge: 'judgement', 判断: 'judgement', 判断题: 'judgement', '3': 'judgement',
    completion: 'completion', fill: 'completion', 填空: 'completion', 填空题: 'completion', '4': 'completion',
  };
  const v = alias[s];
  return v && VALID_TYPES.has(v) ? v : null;
}

/** 判断题性质的选项文本（对齐 OCS 的 CORRECT_WORDS / INCORRECT_WORDS） */
const CORRECT_RE = /^(是|对|正确|确定|√|对的|是的|正确的|true|t|yes|1)$/i;
const INCORRECT_RE = /^(非|否|错|错误|×|x|错的|不对|不正确的|不正确|不是|不是的|false|f|no|0)$/i;

function isJudgementOptions(texts) {
  if (texts.length !== 2) return false;
  const clean = texts.map((t) => String(t).replace(/[\s。.]/g, '').toLowerCase());
  return clean.some((t) => CORRECT_RE.test(t)) && clean.some((t) => INCORRECT_RE.test(t));
}

/** 从自定义 handler 抓到的 DOM 信息推题型（复刻 OCS 的 defaultWorkTypeResolver） */
function inferFromDom(dom) {
  if (!dom) return null;
  let d = dom;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return null; } }
  if (!d || typeof d !== 'object') return null;
  const radios = Number(d.radios) || 0;
  const checks = Number(d.checks) || 0;
  const textareas = Number(d.textareas) || 0;
  if (radios === 2) return 'judgement';
  if (radios > 2) return 'single';
  if (checks > 2) return 'multiple';
  if (textareas >= 1) return 'completion';
  return null;
}

const BLANK_MARK_RE = /_{2,}|（\s*）|\(\s*\)|【\s*】|＿{2,}/g;

/** 从题干和选项形态推题型；推不出就诚实地说 choice（待模型判定） */
function inferFromShape(options, title) {
  const texts = options.map((o) => o.text);
  if (options.length === 0) {
    return BLANK_MARK_RE.test(String(title || '')) ? 'completion' : 'unknown';
  }
  if (isJudgementOptions(texts)) return 'judgement';
  if (options.length >= 2) return 'choice'; // 单选/多选无法从形态区分，交给模型
  return 'unknown';
}

/**
 * @param {object} payload OCS 原始请求体
 * @returns {object} 结构化题目
 */
function ingest(payload) {
  const raw = payload || {};
  const title = String(raw.title == null ? raw.question == null ? '' : raw.question : raw.title)
    .replace(/\s+/g, ' ').trim();
  // OCS 5.x 会把 title 里的图片 URL 换成 [图片N] 占位符，并另发 base64 图片数组
  const suggestionTitle = String(raw.suggestion_title == null ? '' : raw.suggestion_title)
    .replace(/\s+/g, ' ').trim();
  const options = parseOptions(raw.options);
  const texts = options.map((o) => o.text);

  const fromOcs = normalizeOcsType(raw.type);
  let type = fromOcs;
  let typeSource = fromOcs ? 'ocs' : null;

  if (!type) {
    const fromDom = inferFromDom(raw.dom);
    if (fromDom) { type = fromDom; typeSource = 'dom'; }
  }
  if (!type) {
    type = inferFromShape(options, title);
    typeSource = 'shape';
  }

  // 填空题的空格数：优先用页面数出来的，其次数题干里的空标记
  const domObj = (() => {
    if (!raw.dom) return null;
    if (typeof raw.dom === 'object') return raw.dom;
    try { return JSON.parse(raw.dom); } catch { return null; }
  })();
  const blankMarks = (title.match(BLANK_MARK_RE) || []).length;
  const blankCount = (domObj && Number(domObj.textareas) > 0) ? Number(domObj.textareas) : blankMarks;

  // —— 图片 ——
  // 路线 A（OCS 5.x 原生，推荐）：题库配置里声明 ${images} / ${suggestion_title}，
  //   OCS 会把图片转成 base64 直传，并给出 [图片N] 占位符文本。
  // 路线 B（兜底，4.x 及未开图片优化时）：OCS 把 <img> 换成 img.src 文本塞进 title，
  //   我们自己从题干里把 URL 抠出来（见 utils/work.ts:187 的 optimizationElementWithImage）。
  const b64Images = Array.isArray(raw.images)
    ? raw.images.filter((s) => typeof s === 'string' && /^data:image\//i.test(s))
    : [];
  const allUrls = (title.match(/https?:\/\/[^\s,)\]，）]+/g) || []);
  const imageExt = allUrls.filter((u) => /\.(png|jpe?g|gif|webp|bmp|svg)(\?|#|$)/i.test(u));
  const urlImages = [...new Set(imageExt.length ? imageExt : allUrls)];
  const imageUrls = b64Images.length ? [] : urlImages;

  // 给模型的正文：优先用 OCS 5.x 的 suggestion_title（图已变成 [图片N] 占位符，最干净）
  let textForModel = suggestionTitle || title;
  for (const u of allUrls) textForModel = textForModel.split(u).join('[图片]');

  return {
    title,
    textForModel,
    options,
    optionTexts: texts,
    type,
    typeSource,
    rawType: raw.type == null ? null : String(raw.type),
    blankCount,
    /** OCS 5.x 直传的 base64 图片；与 textForModel 里的 [图片N] 严格同序 */
    images: b64Images,
    suggestionTitle: suggestionTitle || null,
    suggestionOptions: raw.suggestion_options == null ? null : String(raw.suggestion_options),
    flags: {
      /** 题干里有图片（无论走哪条路线） */
      hasImage: b64Images.length > 0 || urlImages.length > 0,
      /** base64 直传，无需我们再下载 */
      imagesInline: b64Images.length > 0,
      imageUrls,
      otherUrls: allUrls.filter((u) => !imageUrls.includes(u)),
      /** 题干像是多个标题元素被 OCS 用逗号拼起来的 */
      multiTitle: /,\s*\S/.test(title) && title.split(',').length >= 2,
      /** 题型是从形态猜的、且单选/多选未定 */
      typeAmbiguous: type === 'choice',
      judgementLike: isJudgementOptions(texts),
      /** 多空填空但我们没拿到空格数 → 不允许作答 */
      completionUnsafe: type === 'completion' && blankCount > 1 && !(domObj && domObj.textareas),
    },
    dom: domObj,
  };
}

module.exports = {
  ingest, parseOptions, matchLabel, isJudgementOptions,
  normalizeOcsType, inferFromDom, inferFromShape,
};
