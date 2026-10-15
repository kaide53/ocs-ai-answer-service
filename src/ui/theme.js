'use strict';
/**
 * 颜色与图标。**默认安全**：只要环境看起来不适合彩色，就全部退化成空字符串，
 * 调用方不用做任何判断。
 *
 * 判定顺序（与社区惯例一致）：
 *   1. NO_COLOR 被设置 → 关闭（https://no-color.org）
 *   2. UI_COLOR=never/always → 强制
 *   3. TERM=dumb 或非 TTY → 关闭
 */

const CODES = {
  reset: [0, 0],
  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  underline: [4, 24],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  gray: [90, 39],
  brightGreen: [92, 39],
  brightRed: [91, 39],
  brightCyan: [96, 39],
  brightYellow: [93, 39],
};

function shouldColor(mode, env, isTTY) {
  const m = String(mode || 'auto').toLowerCase();
  if (m === 'never') return false;
  if (m === 'always') return true;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (!isTTY) return false;
  if (String(env.TERM || '').toLowerCase() === 'dumb') return false;
  return true;
}

/**
 * @param {object} opts
 * @param {boolean} opts.enabled 是否输出颜色
 */
function createTheme({ enabled }) {
  const on = Boolean(enabled);
  const paint = (name, s) => {
    if (!on) return String(s);
    const c = CODES[name];
    if (!c) return String(s);
    return '\u001b[' + c[0] + 'm' + s + '\u001b[' + c[1] + 'm';
  };

  // 图标在非彩色/窄终端下也可以用，但 ASCII 兜底更保守
  return {
    enabled: on,
    paint,
    dim: (s) => paint('dim', s),
    bold: (s) => paint('bold', s),
    gray: (s) => paint('gray', s),
    cyan: (s) => paint('cyan', s),
    green: (s) => paint('green', s),
    red: (s) => paint('red', s),
    yellow: (s) => paint('yellow', s),
    magenta: (s) => paint('magenta', s),
    /** 正确答案 */
    ok: (s) => paint('brightGreen', s),
    /** 错误选项 */
    no: (s) => paint('brightRed', s),
    /** 不确定 */
    meh: (s) => paint('brightYellow', s),
    /** 结论 */
    verdict: (s) => paint('brightCyan', s),
    accent: (s) => paint('blue', s),
  };
}

module.exports = { createTheme, shouldColor, CODES };
