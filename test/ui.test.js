'use strict';
/**
 * 终端界面的测试。全部在无 TTY 下跑——渲染器不直接读 process.stdout，
 * 所以可以注入 sink 精确断言输出了什么。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { strWidth, padEnd, truncate, wrap, wrapCapped, codePointWidth } = require('../src/ui/width');
const { renderBox, divider, stripAnsi } = require('../src/ui/box');
const { createTheme, shouldColor } = require('../src/ui/theme');
const { createStreamView, unescapeJsonString } = require('../src/ui/stream-view');
const { createUi, createLineWriter } = require('../src/ui/render');

/** 收集输出的辅助 */
function collector(width = 64) {
  const chunks = [];
  const ui = createUi({
    write: (s) => chunks.push(s),
    isTTY: false, env: { TERM: 'xterm-256color' },
    style: 'rich', color: 'never', width, spinner: false,
  });
  return { ui, text: () => chunks.join('') };
}

const Q = (over = {}) => Object.assign({
  title: '抗战时期八路军牺牲的最高将领是（  ）',
  options: [{ label: 'A', text: '陈宇寰' }, { label: 'B', text: '左权' }, { label: 'C', text: '包森' }, { label: 'D', text: '洪麟阁' }],
  type: 'single', typeSource: 'dom', rawType: 'unknown',
  images: [], blankCount: 0,
  flags: { hasImage: false, imageUrls: [], completionUnsafe: false },
}, over);

// ————————————————————————————————————————————————
// 显示宽度
// ————————————————————————————————————————————————

test('显示宽度：ASCII 计 1，CJK 与全角计 2，组合符计 0', () => {
  assert.equal(strWidth('abc'), 3);
  assert.equal(strWidth('左权'), 4);
  assert.equal(strWidth('（　）'), 6, '全角括号与全角空格各占 2 列');
  assert.equal(strWidth('ＡＢ'), 4, '全角字母占 2 列');
  assert.equal(strWidth('a中b'), 4);
  assert.equal(strWidth('e\u0301'), 1, '组合变音符号不占列');
  assert.equal(strWidth(''), 0);
  assert.equal(codePointWidth(0x1f600), 2, 'emoji 占 2 列');
});

test('padEnd / truncate 按显示宽度工作', () => {
  assert.equal(strWidth(padEnd('左权', 10)), 10);
  assert.equal(strWidth(padEnd('abc', 10)), 10);
  assert.equal(padEnd('abcdef', 3), 'abcdef', '超出时不截断');
  // truncate 的契约是"不超过 len"（宽字符是 2 列，凑不满时留空，由调用方 padEnd 补齐）
  assert.ok(strWidth(truncate('抗日战争时期八路军', 8)) <= 8);
  assert.ok(truncate('抗日战争时期八路军', 8).endsWith('…'));
  assert.equal(truncate('abc', 10), 'abc', '不超长就原样返回');
  assert.equal(strWidth(padEnd(truncate('抗日战争时期八路军', 8), 8)), 8, 'padEnd 之后必须精确等宽');
});

test('折行：中文可任意断，英文在空格处断', () => {
  assert.deepEqual(wrap('抗日战争时期', 6), ['抗日战', '争时期']);
  const en = wrap('the quick brown fox', 10);
  assert.deepEqual(en, ['the quick', 'brown fox']);
  assert.ok(en.every((l) => strWidth(l) <= 10));
  assert.deepEqual(wrap('甲\n乙', 10), ['甲', '乙'], '换行符要认');
});

test('wrapCapped 超出上限时用省略号收尾', () => {
  const lines = wrapCapped('抗日战争时期八路军牺牲的最高将领是左权将军', 8, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].endsWith('…'));
  assert.ok(lines.every((l) => strWidth(l) <= 8));
});

// ————————————————————————————————————————————————
// 颜色开关
// ————————————————————————————————————————————————

test('颜色判定遵循 never/always/NO_COLOR/TERM=dumb/非TTY', () => {
  assert.equal(shouldColor('never', { TERM: 'xterm' }, true), false);
  assert.equal(shouldColor('always', { TERM: 'dumb' }, false), true, 'always 覆盖一切');
  assert.equal(shouldColor('auto', { NO_COLOR: '1', TERM: 'xterm' }, true), false, 'NO_COLOR 优先');
  assert.equal(shouldColor('auto', { TERM: 'dumb' }, true), false);
  assert.equal(shouldColor('auto', { TERM: 'xterm' }, false), false, '非 TTY 不着色');
  assert.equal(shouldColor('auto', { TERM: 'xterm' }, true), true);
});

test('关闭颜色时输出里不含 ANSI 转义', () => {
  const t = createTheme({ enabled: false });
  assert.equal(t.ok('x'), 'x');
  assert.equal(t.dim('x'), 'x');
});

// ————————————————————————————————————————————————
// 边框
// ————————————————————————————————————————————————

test('边框：每一行的显示宽度完全相等（含中文内容）', () => {
  const theme = createTheme({ enabled: false });
  const rows = renderBox({
    width: 60, titleLeft: '#7', titleRight: '单选 · 页面推断',
    lines: ['抗日战争时期八路军牺牲的最高将领是（  ）', '', '  A  陈宇寰', '  B  左权', '  这是一行特别长的内容用来测试折行之后边框还对不对齐对齐对齐'],
    theme,
  });
  const widths = rows.map((r) => strWidth(stripAnsi(r)));
  assert.equal(new Set(widths).size, 1, '宽度不一致：' + JSON.stringify(widths));
  assert.equal(widths[0], 60);
});

test('边框：标题过长时也不会撑破宽度', () => {
  const theme = createTheme({ enabled: false });
  for (const w of [20, 30, 44]) {
    const rows = renderBox({
      width: w, titleLeft: '#123456789', titleRight: '一个特别特别长的题型标签 · 来源说明',
      lines: ['内容'], theme,
    });
    const widths = rows.map((r) => strWidth(stripAnsi(r)));
    assert.equal(new Set(widths).size, 1, 'w=' + w + ' 宽度不一致');
    assert.equal(widths[0], w, 'w=' + w + ' 实际宽 ' + widths[0]);
  }
});

test('ASCII 回退模式不出现 Unicode 边框字符', () => {
  const rows = renderBox({ width: 40, titleLeft: '#1', lines: ['内容'], ascii: true, theme: createTheme({ enabled: false }) });
  const joined = rows.join('\n');
  for (const ch of ['╭', '╮', '╰', '╯', '─', '│']) assert.ok(!joined.includes(ch), '不该出现 ' + ch);
});

test('stripAnsi 能剥掉颜色', () => {
  assert.equal(stripAnsi('\u001b[32m绿\u001b[39m'), '绿');
  assert.equal(stripAnsi('无颜色'), '无颜色');
});

// ————————————————————————————————————————————————
// 流式增量提取
// ————————————————————————————————————————————————

const SAMPLE = JSON.stringify({
  option_judgements: [
    { label: 'A', verdict: 'wrong', why: '含"引号"与转义\\反斜杠' },
    { label: 'B', verdict: 'correct', why: '左权是八路军副参谋长' },
    { label: 'C', verdict: 'unsure', why: '' },
  ],
});

test('流式提取：任意切分粒度都能还原出同样的判定', () => {
  for (const size of [1, 2, 3, 7, 13, 64]) {
    const view = createStreamView();
    let got = [];
    for (let i = 0; i < SAMPLE.length; i += size) got = got.concat(view.feed(SAMPLE.slice(i, i + size)));
    view.feed('');
    assert.equal(view.count, 3, '粒度 ' + size + ' 时条目数不对');
    assert.deepEqual(view.verdicts.map((v) => v.label), ['A', 'B', 'C']);
  }
});

test('流式提取：转义序列被正确还原', () => {
  const view = createStreamView();
  view.feed('{"option_judgements":[{"label":"A","verdict":"wrong","why":"含\\"引号\\"与\\\\反斜杠\\n换行"}]}');
  assert.equal(view.count, 1);
  assert.ok(view.verdicts[0].why.includes('"引号"'), '实际：' + view.verdicts[0].why);
  assert.ok(view.verdicts[0].why.includes('\\反斜杠'));
});

test('unescapeJsonString 处理 \\uXXXX', () => {
  assert.equal(unescapeJsonString('\\u4e2d\\u6587'), '中文');
  assert.equal(unescapeJsonString('a\\nb'), 'a\nb');
  assert.equal(unescapeJsonString('普通'), '普通');
});

test('流式提取：半截对象不产出；闭合后才产出，且不重复', () => {
  const view = createStreamView();
  // 判定对象本身还没闭合（缺 why 的收尾与 }）→ 不能产出
  view.feed('{"option_judgements":[{"label":"A","verdict":"correc');
  assert.equal(view.count, 0, '对象未闭合时不该产出');
  view.feed('t","why":"完"}]');
  assert.equal(view.count, 1, '闭合后应当产出');
  // 再补齐外层并重复喂入，不能重复产出
  view.feed('}');
  assert.equal(view.count, 1);
  view.feed(',{"label":"B","verdict":"wrong","why":"乙"}]}');
  assert.equal(view.count, 2);
});

test('流式提取：畸形内容不抛错、产出为空、raw 仍可兜底', () => {
  const view = createStreamView();
  assert.doesNotThrow(() => view.feed('这不是 JSON {{{'));
  assert.equal(view.count, 0);
  assert.ok(view.raw.length > 0);
});

test('流式提取：onVerdict 回调按序触发', () => {
  const seen = [];
  const view = createStreamView({ onVerdict: (v) => seen.push(v.label) });
  view.feed(SAMPLE);
  assert.deepEqual(seen, ['A', 'B', 'C']);
});

test('行写入器：按宽度折行，flush 吐出残留', () => {
  const out = [];
  const w = createLineWriter((l) => out.push(l), 8, '  ');
  w.push('abcdefghij');
  assert.equal(out.length, 1, '第 9 个字符才触发换行');
  w.push('k');
  w.flush();
  assert.ok(out.length >= 2);
  assert.ok(out.every((l) => strWidth(l) <= 8));
});

// ————————————————————————————————————————————————
// 渲染：plain 模式必须与加 UI 之前一致
// ————————————————————————————————————————————————

test('plain 模式：逐字节复刻原有输出，且不含 ANSI', () => {
  const chunks = [];
  const ui = createUi({ write: (s) => chunks.push(s), isTTY: false, env: { TERM: 'dumb' }, style: 'plain' });
  const block = ui.beginQuestion({ question: Q() });
  block.finish({ rawResult: { code: 1, answer: '左权' } });
  const text = chunks.join('');
  const expected = [
    '─'.repeat(60),
    '题干：抗战时期八路军牺牲的最高将领是（  ）',
    '题型：single（来源 dom，OCS 给的是 "unknown"）',
    '选项：A=陈宇寰 | B=左权 | C=包森 | D=洪麟阁',
    '返回：{"code":1,"answer":"左权"}',
    '',
  ].join('\n');
  assert.equal(text, expected);
  assert.ok(!/\u001b\[/.test(text), 'plain 模式不得含 ANSI');
});

test('非 TTY 环境下 auto 会退回 plain（本机 TERM=dumb 就是这种情况）', () => {
  const chunks = [];
  const ui = createUi({ write: (s) => chunks.push(s), isTTY: false, env: { TERM: 'dumb' }, style: 'auto' });
  assert.equal(ui.rich, false);
  const block = ui.beginQuestion({ question: Q() });
  block.finish({ rawResult: { code: 0, msg: 'x' } });
  assert.ok(!/\u001b\[/.test(chunks.join('')));
  assert.ok(!chunks.join('').includes('╭'), 'plain 模式不该画框');
});

// ————————————————————————————————————————————————
// 渲染：rich 模式
// ————————————————————————————————————————————————

test('append 模式（管道/日志）：卡片包含题干与全部选项，且每行等宽', () => {
  const { ui, text } = collector(64);
  const block = ui.beginQuestion({ question: Q() });
  block.finish({ answer: '左权', elapsedMs: 1744, meta: { letters: ['B'], emitStrategy: 'text', emitVerified: true } });
  const out = text();
  assert.ok(out.includes('抗战时期八路军牺牲的最高将领是'), '缺题干');
  for (const t of ['陈宇寰', '左权', '包森', '洪麟阁']) assert.ok(out.includes(t), '缺选项 ' + t);
  const rows = out.split('\n').filter((l) => /[╭│╰]/.test(l));
  const widths = rows.map((r) => strWidth(stripAnsi(r)));
  assert.equal(new Set(widths).size, 1, '边框宽度不一致：' + JSON.stringify(widths));
  assert.equal(widths[0], 64);
});

test('append 模式：流式判定按到达顺序出现，结论行含答案', () => {
  const { ui, text } = collector(64);
  const block = ui.beginQuestion({ question: Q() });
  block.content('{"option_judgements":[{"label":"A","verdict":"wrong","why":"甲错误"},');
  block.content('{"label":"B","verdict":"correct","why":"乙正确"}]}');
  block.finish({ answer: '左权', elapsedMs: 1744, meta: { letters: ['B'], emitStrategy: 'text', emitVerified: true } });
  const out = text();
  const ia = out.indexOf('甲错误');
  const ib = out.indexOf('乙正确');
  assert.ok(ia >= 0 && ib >= 0, '两条判定都要出现');
  assert.ok(ia < ib, '顺序应与到达顺序一致');
  assert.ok(out.includes('答案 B'), '结论行要含答案字母');
  assert.ok(!out.includes('undefined'), '不该把 undefined 打到界面上');
});

test('append 模式：思考区的最后一行必须在判定之前打印出来', () => {
  const { ui, text } = collector(64);
  const block = ui.beginQuestion({ question: Q() });
  block.reasoning('这是一段比较长的思考内容，长到会折成两行，第二行是结尾。');
  block.verdict({ label: 'B', verdict: 'correct', why: '判定' });
  block.finish({ answer: '左权', elapsedMs: 100, meta: { letters: ['B'], emitStrategy: 'text', emitVerified: true } });
  const out = text();
  const tail = out.indexOf('第二行是结尾');
  const judge = out.indexOf('判定');
  assert.ok(tail >= 0, '思考内容不能丢');
  assert.ok(tail < judge, '思考的残留行不能排到判定之后');
});

test('append 模式：一条判定都没提取出来时，兜底展示原始输出', () => {
  const { ui, text } = collector(64);
  const block = ui.beginQuestion({ question: Q() });
  block.content('模型没有按 JSON 输出，这是一段自由文本');
  block.finish({ answer: '左权', elapsedMs: 100, meta: { letters: ['B'], emitStrategy: 'text', emitVerified: true } });
  assert.ok(text().includes('原始输出'), '应当兜底展示原始输出');
});

test('append 模式：题目带图片与不安全填空时给出提示行', () => {
  const { ui, text } = collector(64);
  const a = ui.beginQuestion({ question: Q({ images: ['data:image/png;base64,x'], flags: { hasImage: true, imageUrls: [], completionUnsafe: false } }) });
  a.finish({ rawResult: { code: 0 } });
  assert.ok(text().includes('base64'), '图片题要有提示');

  const { ui: ui2, text: text2 } = collector(64);
  const b = ui2.beginQuestion({ question: Q({ type: 'completion', options: [], flags: { hasImage: false, imageUrls: [], completionUnsafe: true } }) });
  b.note('多空填空但拿不到空格数，将拒绝作答');
  b.finish({ msg: '拒绝瞎填', elapsedMs: 1 });
  assert.ok(text2().includes('拒绝瞎填'));
});

// ————————————————————————————————————————————————
// 并发：两块不能交错
// ————————————————————————————————————————————————

test('两个题目同时到达时，卡片不会交错', () => {
  const { ui, text } = collector(60);
  const b1 = ui.beginQuestion({ question: Q({ title: '第一题' }), index: 1 });
  const b2 = ui.beginQuestion({ question: Q({ title: '第二题' }), index: 2 });

  b1.verdict({ label: 'A', verdict: 'correct', why: '一A' });
  b2.verdict({ label: 'B', verdict: 'correct', why: '二B' });
  b1.verdict({ label: 'C', verdict: 'wrong', why: '一C' });
  b2.verdict({ label: 'D', verdict: 'wrong', why: '二D' });
  b1.finish({ answer: '甲', elapsedMs: 10, meta: { letters: ['A'], emitStrategy: 'text', emitVerified: true } });
  b2.finish({ answer: '乙', elapsedMs: 20, meta: { letters: ['B'], emitStrategy: 'text', emitVerified: true } });

  const out = text();
  // 第一题的三行必须连续；第二题的内容必须整体排在第二题的卡片之后
  const i1a = out.indexOf('一A');
  const i1c = out.indexOf('一C');
  const firstFinish = out.indexOf('答案 A');
  const secondBox = out.indexOf('第二题');
  const i2b = out.indexOf('二B');
  assert.ok(i1a < i1c && i1c < firstFinish, '第一题的判定要聚在一起');
  assert.ok(secondBox < i2b, '第二题的卡片必须在它的判定之前');
  assert.ok(i2b > firstFinish, '第二题的输出不能插到第一题中间');
});

// ————————————————————————————————————————————————
// 健壮性：UI 绝不能影响答题
// ————————————————————————————————————————————————

test('传入畸形题目时渲染器不抛错', () => {
  const { ui } = collector(50);
  assert.doesNotThrow(() => {
    const b = ui.beginQuestion({ question: { title: null, options: null, type: null, typeSource: null, rawType: null, flags: null } });
    b.note('x');
    b.reasoning('y');
    b.content('z');
    b.verdict({ label: 'A', verdict: 'correct', why: 'w' });
    b.finish({ answer: 'q', elapsedMs: 1, meta: {} });
  });
});

test('write 抛错时不影响调用方', () => {
  const ui = createUi({ write: () => { throw new Error('管道断了'); }, isTTY: true, env: { TERM: 'xterm' }, style: 'rich', width: 50, spinner: false });
  assert.doesNotThrow(() => {
    const b = ui.beginQuestion({ question: Q() });
    b.verdict({ label: 'A', verdict: 'correct', why: 'x' });
    b.finish({ answer: 'y', elapsedMs: 1, meta: { letters: ['A'] } });
  });
});

test('banner 在 plain 模式下不画框', () => {
  const chunks = [];
  const ui = createUi({ write: (s) => chunks.push(s), isTTY: false, env: { TERM: 'dumb' }, style: 'plain' });
  ui.banner({ 监听端口: '3000' });
  const out = chunks.join('');
  assert.ok(!out.includes('╭'));
  assert.ok(out.includes('监听端口'));
});
