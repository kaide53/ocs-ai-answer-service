'use strict';
/**
 * 与 OCS 源码 (packages/core/src/core/utils/string.ts) 对齐的字符串工具，
 * 保证我们返回的答案能被 OCS 的匹配器命中。
 */

const CORRECT_WORDS = ['是', '对', '正确', '确定', '√', '对的', '是的', '正确的', 'true', 'True', 'T', 'yes', '1'];
const INCORRECT_WORDS = [
  '非', '否', '错', '错误', '×', 'X', '错的', '不对', '不正确的', '不正确',
  '不是', '不是的', 'false', 'False', 'F', 'no', '0',
];

/** 去标点 / 空格 / 全角转半角，只保留中英文数字（等价于 OCS 的 clearString） */
function clearString(str, ...exclude) {
  exclude.push(...['①②③④⑤⑥⑦⑧⑨']);
  return String(str == null ? '' : str)
    .trim()
    .toLowerCase()
    .replace(new RegExp('[^\\u2E80-\\u9FFFA-Za-z0-9' + exclude.join('') + ']*', 'g'), '');
}

/** OCS 的归一化：先删中英标点与空白，再 clearString */
function normalizeString(str) {
  return clearString(
    String(str == null ? '' : str)
      .replace(/[，。！？；：“”‘’、（）【】《》\s]/g, '')
      .replace(/[,.\-!?;:'"()[\]<>]/g, '')
      .replace(/[ａ-ｚＡ-Ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/％/g, '%')
  );
}

/** 去掉选项开头的 “A.” / “A、” / “A选项” 之类冗余标签（与 OCS 一致） */
function removeRedundant(str) {
  return String(str == null ? '' : str)
    .trim()
    .replace(/^[A-Z]{1}[^A-Za-z0-9\u2E80-\u9FFF]+([A-Za-z0-9\u2E80-\u9FFF]+)/, '$1')
    .replace(/^[A-Z]{1}([\u2E80-\u9FFF][A-Za-z0-9\u2E80-\u9FFF]*)/, '$1');
}

/** 判断题极性：1 = 正确类，-1 = 错误类，0 = 无法判断 */
function judgementPolarity(word) {
  const s = clearString(removeRedundant(word), '√', '×');
  if (!s) return 0;
  if (CORRECT_WORDS.some((w) => clearString(removeRedundant(w), '√', '×') === s)) return 1;
  if (INCORRECT_WORDS.some((w) => clearString(removeRedundant(w), '√', '×') === s)) return -1;
  return 0;
}

/** OCS 认得的答案分隔符（splitAnswer 默认列表） */
const OCS_SEPARATORS = ['===', '#', '---', '###', '|', ';', '；'];

module.exports = { clearString, normalizeString, removeRedundant, judgementPolarity, OCS_SEPARATORS, CORRECT_WORDS, INCORRECT_WORDS };
