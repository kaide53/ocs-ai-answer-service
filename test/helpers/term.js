'use strict';
/**
 * 测试用的极简终端模拟器。
 *
 * 它消费渲染器吐出的 ANSI 字节流，重建出「用户实际看到的屏幕」。
 * 有了它，就能对"窗口是否原地更新、上一题是否残留、题目框有没有被挤掉"
 * 这类**视觉行为**写真正的断言，而不是只断言输出了某个字符串。
 *
 * 只支持本项目实际用到的序列：\x1b[NA（上移）、\x1b[J（擦到屏末）、SGR 颜色。
 */
const { stripAnsi } = require('../../src/ui/box');

function makeTerminal() {
  let screen = [];
  let cursor = 0;
  let sawAnsiFlag = false;

  function putChar(ch) {
    if (cursor > 2000) return; // 防御：别让失控输出把内存撑爆
    screen[cursor] = (screen[cursor] || '') + ch;
  }

  function feed(s) {
    let i = 0;
    const str = String(s);
    while (i < str.length) {
      if (str[i] === '\u001b') {
        sawAnsiFlag = true;
        const up = /^\u001b\[(\d*)A/.exec(str.slice(i));
        if (up) { cursor = Math.max(0, cursor - (Number(up[1]) || 1)); i += up[0].length; continue; }
        const erase = /^\u001b\[J/.exec(str.slice(i));
        if (erase) { screen = screen.slice(0, cursor); i += erase[0].length; continue; }
        const sgr = /^\u001b\[[0-9;]*m/.exec(str.slice(i));
        if (sgr) { i += sgr[0].length; continue; }
        i += 1; // 未识别的序列：跳过控制字节
        continue;
      }
      const nl = str.indexOf('\n', i);
      const esc = str.indexOf('\u001b', i);
      let end = str.length;
      if (nl >= 0) end = Math.min(end, nl + 1);
      if (esc >= 0) end = Math.min(end, esc);
      if (end === i) { i += 1; continue; }
      let seg = str.slice(i, end);
      if (seg.endsWith('\n')) {
        seg = seg.slice(0, -1);
        for (const ch of seg) putChar(ch);
        cursor += 1;
      } else {
        for (const ch of seg) putChar(ch);
      }
      i = end;
    }
  }

  return {
    feed,
    /** 屏幕上的可见行（已剥掉颜色），末尾的游标空行不计入 */
    get lines() {
      const all = screen.map((l) => stripAnsi(l || ''));
      while (all.length && all[all.length - 1] === '') all.pop();
      return all;
    },
    /** 非空行 */
    get visible() { return this.lines.filter((l) => l.trim() !== ''); },
    /** 是否出现过 ANSI 序列（用于断言非 TTY 路径不输出控制码） */
    get sawAnsi() { return sawAnsiFlag; },
    reset() { screen = []; cursor = 0; },
  };
}

module.exports = { makeTerminal };
