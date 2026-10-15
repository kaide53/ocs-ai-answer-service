'use strict';
/**
 * 原地重绘引擎：把一块「屏幕区域」固定在终端某个位置，反复用新内容替换它。
 *
 * 两种输出策略（由 repaint 决定）：
 *  - repaint = true （真终端）：上移 N 行 → 擦到屏末 → 逐行重画。窗口停在原地，不向下累加。
 *  - repaint = false（管道/日志）：**完全不输出光标控制码**，由调用方按"只追加新增行"的方式打印。
 *
 * 注意：这里只负责"画一块区域"，不做内容裁剪——裁剪是 screen.js 的职责，
 * 因为只有它知道哪些行是固定的（题目框）、哪些是可滚动的（流式内容）。
 */

/** 上移 n 行的 ANSI 序列 */
const cursorUp = (n) => '\u001b[' + n + 'A';
/** 从光标处擦到屏幕末尾 */
const ERASE_DOWN = '\u001b[J';

function createFrame({ write, repaint = false }) {
  let lastCount = 0;
  const safeWrite = (s) => { try { write(s); } catch { /* UI 输出失败不得影响答题 */ } };

  return {
    /** 是否使用原地重绘（false 时 setLines/clear 都是空操作） */
    repaint: Boolean(repaint),

    /**
     * 用新的行数组替换整个区域。
     * @param {string[]} lines 每一行都应是"整行同色"（宽度计算在纯文本上完成）
     */
    setLines(lines) {
      if (!repaint) return;
      const arr = Array.isArray(lines) ? lines : [];
      if (lastCount > 0) safeWrite(cursorUp(lastCount));
      safeWrite(ERASE_DOWN);
      for (const l of arr) safeWrite(String(l) + '\n');
      lastCount = arr.length;
    },

    /** 擦除整个区域，游标回到区域首行 */
    clear() {
      if (!repaint || lastCount === 0) return;
      safeWrite(cursorUp(lastCount));
      safeWrite(ERASE_DOWN);
      lastCount = 0;
    },

    /** 当前占用的行数 */
    get height() { return lastCount; },

    /** 供测试观察：上一次写入的行数 */
    get writtenLines() { return lastCount; },
  };
}

module.exports = { createFrame, cursorUp, ERASE_DOWN };
