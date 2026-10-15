'use strict';
/**
 * UI 的唯一集成点。
 *
 * 解耦约定：
 *  - 业务代码（app.js / solve.js）只依赖 `getUi()` 返回的几个方法，
 *    不直接碰 ANSI、宽度、边框这些细节；
 *  - 想彻底关掉这套界面：设 `UI_STYLE=plain`，行为回到加 UI 之前；
 *  - 想整体移除：删掉 `src/ui/` 目录，并还原 app.js / solve.js / server.js 的对应几行
 *    （基线提交见 README 的"回退"一节）。
 */
const { createUi } = require('./render');

let shared = null;

function getUi() {
  if (!shared) shared = createUi();
  return shared;
}

/** 测试用：丢弃当前实例，下次 getUi() 重建 */
function resetUi() {
  shared = null;
}

module.exports = { getUi, resetUi, createUi };
