'use strict';
/**
 * 并发分屏的专项测试：几何切分、横向拼接、多栏合成。
 *
 * 分屏最容易翻车的地方是**宽度算错**——中文占 2 列，一旦按 length 算，
 * 栏与栏就会错位、边框会参差不齐。所以这里断言的都是"显示宽度"。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { paneWidth, computePaneCount, joinPanes, padTo } = require('../src/ui/layout');
const { composeWindow, composeScreen } = require('../src/ui/screen');
const { createTheme } = require('../src/ui/theme');
const { strWidth } = require('../src/ui/width');
const { stripAnsi } = require('../src/ui/box');

const theme = createTheme({ enabled: false });
// 注意剥掉颜色再算宽度——strWidth 会把 ANSI 转义序列也数进去
const widthsOf = (lines) => [...new Set(lines.map((l) => strWidth(stripAnsi(l))))];

const model = (i, over = {}) => Object.assign({
  index: i,
  title: '第' + i + '题：八路军相关史实判断',
  options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }, { label: 'C', text: '丙' }, { label: 'D', text: '丁' }],
  notes: [], type: 'single', typeSource: 'dom',
  status: null, reasoning: '', verdicts: [], result: null,
}, over);

// ————————————————————————————————————————————————
// 几何
// ————————————————————————————————————————————————

test('paneWidth：N 栏总宽不超过给定宽度', () => {
  for (const total of [40, 60, 80, 100, 119, 200]) {
    for (let n = 1; n <= 4; n += 1) {
      const w = paneWidth(total, n);
      const used = w * n + (n - 1); // 分隔符各占 1 列
      assert.ok(used <= total, 'total=' + total + ' n=' + n + ' 用了 ' + used + ' 列');
      assert.ok(w >= 1);
    }
  }
  assert.equal(paneWidth(80, 1), 80, '单栏用满');
  assert.equal(paneWidth(80, 2), 39);
});

test('computePaneCount：不超过 maxPanes，且优先保证每栏可读', () => {
  // 宽度充足 → 按活跃数（上限 3）
  assert.equal(computePaneCount(1, { width: 100 }), 1);
  assert.equal(computePaneCount(2, { width: 100 }), 2);
  assert.equal(computePaneCount(3, { width: 100 }), 3);
  assert.equal(computePaneCount(5, { width: 200 }), 3, 'OCS 线程上限是 3，默认也只显示 3 栏');
  // 宽度不足 → 减少栏数，但至少 1
  assert.equal(computePaneCount(3, { width: 60, minPaneWidth: 22 }), 2, '60 列放不下 3 栏');
  assert.equal(computePaneCount(3, { width: 40, minPaneWidth: 22 }), 1, '40 列只能 1 栏');
  assert.equal(computePaneCount(4, { width: 10, minPaneWidth: 22 }), 1, '再窄也要留 1 栏');
});

test('computePaneCount：maxPanes 可配', () => {
  assert.equal(computePaneCount(5, { width: 200, maxPanes: 2 }), 2);
  assert.equal(computePaneCount(5, { width: 200, maxPanes: 1 }), 1);
});

test('padTo：按显示宽度补齐，中文按 2 列算', () => {
  assert.equal(strWidth(stripAnsi(padTo('左权', 10))), 10);
  assert.equal(strWidth(stripAnsi(padTo('abc', 10))), 10);
  assert.equal(padTo('abcdef', 3).length <= 3, true, '超长时截断');
  assert.ok(strWidth(stripAnsi(padTo('abcdef', 3))) <= 3);
});

test('padTo：带颜色的行也能正确补齐（空格不落在颜色里）', () => {
  const t = createTheme({ enabled: true });
  const line = t.green('左权');
  const padded = padTo(line, 10);
  assert.equal(strWidth(stripAnsi(padded)), 10, '补空格后显示宽度应为 10');
  assert.ok(padded.endsWith('\u001b[39m' + ' '.repeat(6)), '空格应在颜色复位之后');
});

test('joinPanes：所有行等宽，短栏用空行补齐', () => {
  const rows = joinPanes(
    [{ lines: ['aa', 'bb', 'cc'], width: 6 }, { lines: ['xx'], width: 6 }],
    { width: 15, sep: '│' }
  );
  assert.equal(rows.length, 3, '取最高的那一栏');
  assert.deepEqual(widthsOf(rows), [15], '每行宽度必须一致');
  assert.ok(rows[2].startsWith('cc'), '第一栏第三行还在');
  assert.ok(rows[2].trim().endsWith('│'), '第二栏第三行是空的，但分隔符要在');
});

test('joinPanes：maxLines 生效且不越界', () => {
  const rows = joinPanes([{ lines: Array.from({ length: 20 }, (_, i) => 'l' + i), width: 5 }], { width: 5, maxLines: 4 });
  assert.equal(rows.length, 4);
});

// ————————————————————————————————————————————————
// 多栏合成
// ————————————————————————————————————————————————

test('composeWindow：单题时与 composeScreen 完全一致（回归保护）', () => {
  const m = model(1);
  const single = composeScreen(m, { width: 60, maxLines: 23, theme });
  const win = composeWindow([m], { width: 60, maxLines: 23, theme });
  assert.deepEqual(win.lines, single.lines, '单题路径必须与分屏改版前逐字节一致');
  assert.equal(win.paneCount, 1);
});

test('composeWindow：两题并排，两个框顶边在同一行', () => {
  const win = composeWindow([model(1), model(2)], { width: 100, maxLines: 23, theme });
  assert.equal(win.paneCount, 2);
  assert.equal(widthsOf(win.lines).length, 1, '每行必须等宽');
  assert.equal(widthsOf(win.lines)[0], 100);
  const topRows = win.lines.filter((l) => l.includes('╭'));
  assert.equal(topRows.length, 1, '两个框的顶边应在同一行');
  assert.ok(topRows[0].includes('#1') && topRows[0].includes('#2'));
});

test('composeWindow：三题并排', () => {
  const win = composeWindow([model(1), model(2), model(3)], { width: 120, maxLines: 23, theme });
  assert.equal(win.paneCount, 3);
  assert.equal(widthsOf(win.lines)[0], 120);
  const top = win.lines.find((l) => l.includes('╭'));
  for (const i of [1, 2, 3]) assert.ok(top.includes('#' + i), '缺第 ' + i + ' 栏');
});

test('composeWindow：栏数超限时，多出来的题在底部列出', () => {
  const win = composeWindow([model(1), model(2), model(3)], { width: 60, maxLines: 23, theme, minPaneWidth: 22 });
  assert.equal(win.paneCount, 2, '60 列放不下 3 栏');
  assert.equal(win.overflow.length, 1);
  const footer = win.lines[win.lines.length - 1];
  assert.ok(/还有 1 题进行中/.test(footer), '底部要有溢出提示，实际：' + footer);
  assert.ok(footer.includes('#3'), '要列出被挤出的题号');
});

test('composeWindow：各栏内容互不串栏', () => {
  const win = composeWindow([
    model(1, { verdicts: [{ label: 'A', verdict: 'correct', why: '一号理由' }] }),
    model(2, { verdicts: [{ label: 'B', verdict: 'correct', why: '二号理由' }] }),
  ], { width: 100, maxLines: 23, theme });
  const row = win.lines.find((l) => l.includes('一号理由')) || '';
  const i1 = row.indexOf('一号理由');
  const i2 = row.indexOf('二号理由');
  assert.ok(i1 >= 0 && i2 >= 0, '两条理由应在同一行（并排），实际：' + row);
  assert.ok(i1 < i2, '第一栏内容必须在第二栏之前');
});

test('composeWindow：行数不超过 maxLines（扫描各栏数）', () => {
  for (const n of [1, 2, 3]) {
    for (const maxLines of [6, 10, 16, 30]) {
      const models = Array.from({ length: n }, (_, i) => model(i + 1, { reasoning: '很长的思考。'.repeat(30) }));
      const win = composeWindow(models, { width: 100, maxLines, theme });
      assert.ok(win.lines.length <= maxLines, 'n=' + n + ' maxLines=' + maxLines + ' 实际 ' + win.lines.length);
    }
  }
});

test('composeWindow：每行宽度都等于窗口宽度（含中文与多栏）', () => {
  for (const [width, n] of [[80, 1], [80, 2], [100, 2], [120, 3], [60, 3]]) {
    const models = Array.from({ length: n }, (_, i) => model(i + 1, { title: '第' + (i + 1) + '题：中文题干测试内容' }));
    const win = composeWindow(models, { width, maxLines: 23, theme });
    const ws = widthsOf(win.lines);
    assert.equal(ws.length, 1, 'width=' + width + ' n=' + n + ' 行宽不一致：' + JSON.stringify(ws));
    assert.equal(ws[0], width);
  }
});

test('composeWindow：没有活跃题时退回等待态', () => {
  const win = composeWindow([], { width: 60, maxLines: 23, theme });
  assert.equal(win.lines.length, 1);
  assert.equal(win.paneCount, 0);
  assert.ok(win.lines[0].includes('等待'));
});

test('composeWindow：栏很窄时标题只留题型，不硬塞来源', () => {
  const win = composeWindow([model(1), model(2), model(3)], { width: 80, maxLines: 23, theme });
  const top = stripAnsi(win.lines.find((l) => l.includes('╭')));
  assert.ok(top.includes('单选'), '题型要保留');
  assert.ok(!top.includes('页面推断'), '窄栏下不该再塞来源，否则标题会被截断');
});
