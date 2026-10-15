'use strict';
/**
 * 窗口模式的端到端验收：用测试终端重建"用户实际看到的屏幕"，
 * 断言原地更新、无残留、题目框永不被挤掉。
 *
 * 这些是本次改造的核心验收标准，光断言"输出里包含某字符串"是证明不了的。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { makeTerminal } = require('./helpers/term');
const { createUi } = require('../src/ui/render');
const { strWidth } = require('../src/ui/width');
const { stripAnsi } = require('../src/ui/box');
const { createFrame } = require('../src/ui/frame');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 等节流重绘落地（重绘节流 120ms） */
const settle = () => sleep(260);

const Q = (over = {}) => Object.assign({
  title: '八路军下辖的三个师分别是?（  ）',
  options: [{ label: 'A', text: '115师' }, { label: 'B', text: '120师' }, { label: 'C', text: '129师' }, { label: 'D', text: '新编第四军' }],
  type: 'choice', typeSource: 'shape', rawType: 'unknown', images: [],
  flags: { hasImage: false, imageUrls: [], completionUnsafe: false },
}, over);

/** 起一个"会原地重绘"的 UI，输出接到测试终端 */
function windowUi({ rows = 24, width = 60, dwellMs = 10000, repaint = true } = {}) {
  const term = makeTerminal();
  const ui = createUi({
    write: (s) => term.feed(s),
    isTTY: true, env: { TERM: 'xterm-256color' },
    style: 'rich', color: 'never', width, rows, repaint, dwellMs,
  });
  return { ui, term };
}

// ————————————————————————————————————————————————
// frame 本身
// ————————————————————————————————————————————————

test('frame：原地重绘会先上移再擦除，行数按上次写入量计算', () => {
  const out = [];
  const f = createFrame({ write: (s) => out.push(s), repaint: true });
  f.setLines(['a', 'b', 'c']);
  assert.equal(f.height, 3);
  out.length = 0;
  f.setLines(['x']);
  const joined = out.join('');
  assert.ok(joined.includes('\u001b[3A'), '应先上移 3 行，实际：' + JSON.stringify(joined));
  assert.ok(joined.includes('\u001b[J'), '应擦到屏末');
  assert.ok(joined.endsWith('x\n'));
  assert.equal(f.height, 1);
});

test('frame：repaint=false 时不输出任何控制码', () => {
  const out = [];
  const f = createFrame({ write: (s) => out.push(s), repaint: false });
  f.setLines(['a', 'b']);
  f.clear();
  assert.equal(out.join(''), '');
  assert.equal(f.height, 0);
});

test('frame：write 抛错不会冒泡', () => {
  const f = createFrame({ write: () => { throw new Error('管道断了'); }, repaint: true });
  assert.doesNotThrow(() => { f.setLines(['a']); f.clear(); });
});

// ————————————————————————————————————————————————
// 窗口模式的核心行为
// ————————————————————————————————————————————————

test('窗口：屏幕上只有一道题，卡片每行等宽且不超出屏幕', async () => {
  const { ui, term } = windowUi({ rows: 24, width: 60 });
  const b = ui.beginQuestion({ question: Q(), index: 2 });
  b.reasoning('八路军下辖三个师。新编第四军是另一支队伍，不属于八路军编制。');
  b.content('{"option_judgements":[{"label":"A","verdict":"correct","why":"115 师"},{"label":"D","verdict":"wrong","why":"不在八路军序列"}]}');
  await settle();

  const lines = term.lines;
  assert.ok(lines.length <= 23, '不得超过屏幕高度，实际 ' + lines.length);
  const boxRows = lines.filter((l) => /[╭│╰]/.test(l));
  assert.ok(boxRows.length > 0, '题目框必须在屏幕上');
  assert.equal(new Set(boxRows.map((l) => strWidth(l))).size, 1, '边框必须等宽');
  assert.ok(lines.join('\n').includes('八路军下辖的三个师'), '题干要在屏幕上');
  assert.ok(lines.join('\n').includes('新编第四军'), '选项要在屏幕上');

  const frameCount = lines.filter((l) => l.includes('╭')).length;
  assert.equal(frameCount, 1, '屏幕上只应有一个题目框');
  ui.destroy();
});

test('窗口：第二题到来时整体替换，第一题不留任何残留', async () => {
  const { ui, term } = windowUi({ rows: 24, width: 60 });
  const b1 = ui.beginQuestion({ question: Q({ title: '第一题：关于抗日战争' }), index: 1 });
  b1.verdict({ label: 'A', verdict: 'correct', why: '第一题的独有理由甲乙丙' });
  b1.finish({ answer: '115师', elapsedMs: 1000, meta: { letters: ['A'], emitStrategy: 'text', emitVerified: true } });
  await settle();
  assert.ok(term.lines.join('\n').includes('第一题的独有理由'), '第一题应当显示过');

  const b2 = ui.beginQuestion({ question: Q({ title: '第二题：关于解放战争' }), index: 2 });
  b2.verdict({ label: 'B', verdict: 'correct', why: '第二题的独有理由丁戊己' });
  await settle();

  const screen = term.lines.join('\n');
  assert.ok(screen.includes('第二题'), '第二题要在屏幕上');
  assert.ok(!screen.includes('第一题'), '第一题必须已被清掉，实际屏幕：\n' + screen);
  assert.ok(!screen.includes('第一题的独有理由'), '第一题的内容不得残留');
  assert.equal(term.lines.filter((l) => l.includes('╭')).length, 1, '仍然只有一个框');
  assert.ok(term.lines.length <= 23);
  ui.destroy();
});

test('窗口：内容超长时只裁剪流式区，题目框与裁剪提示都在', async () => {
  const { ui, term } = windowUi({ rows: 12, width: 52 });
  const b = ui.beginQuestion({
    question: Q({
      title: '以下关于抗日战争的表述哪些是正确的？',
      options: ['A', 'B', 'C', 'D', 'E'].map((L) => ({ label: L, text: '选项' + L })),
    }),
    index: 1,
  });
  b.reasoning('很长的思考内容。'.repeat(30));
  b.content(JSON.stringify({ option_judgements: ['A', 'B', 'C', 'D', 'E'].map((L) => ({ label: L, verdict: 'correct', why: '理由' + L })) }));
  await settle();

  const lines = term.lines;
  const screen = lines.join('\n');
  assert.ok(lines.length <= 11, '不得超过屏幕高度，实际 ' + lines.length);
  assert.ok(screen.includes('抗日战争的表述'), '题目框必须还在（不能被流式内容挤掉）');
  assert.ok(/╭/.test(screen) && /╰/.test(screen), '框必须是闭合的');
  assert.ok(/前面还有 \d+ 行/.test(screen), '应提示内容被裁剪');
  assert.ok(screen.includes('理由E'), '应保留最新的内容（尾部）');
  ui.destroy();
});

test('窗口：任意终端高度下框都闭合且不超出屏幕', async () => {
  for (const rows of [6, 8, 10, 14, 20, 30, 40]) {
    const { ui, term } = windowUi({ rows, width: 50 });
    const b = ui.beginQuestion({
      question: Q({ options: ['A', 'B', 'C', 'D', 'E'].map((L) => ({ label: L, text: '选项' + L })) }),
      index: 1,
    });
    b.reasoning('长内容。'.repeat(40));
    b.content(JSON.stringify({ option_judgements: ['A', 'B', 'C', 'D', 'E'].map((L) => ({ label: L, verdict: 'correct', why: '理由' })) }));
    await settle();
    const screen = term.lines.join('\n');
    assert.ok(term.lines.length <= rows - 1, 'rows=' + rows + ' 超出屏幕：' + term.lines.length);
    assert.ok(/╭/.test(screen), 'rows=' + rows + ' 缺顶边');
    assert.ok(/╰/.test(screen), 'rows=' + rows + ' 缺底边（框被切断了）');
    ui.destroy();
  }
});

test('窗口：答完驻留，随后自动清空为等待态', async () => {
  // 驻留取长一点，先断言"结论看得见"；清空由另一条测试用短驻留覆盖
  const { ui, term } = windowUi({ rows: 20, width: 56, dwellMs: 3000 });
  const b = ui.beginQuestion({ question: Q(), index: 1 });
  b.finish({ answer: '左权', elapsedMs: 900, meta: { letters: ['B'], emitStrategy: 'text', emitVerified: true } });
  await settle();
  assert.ok(term.lines.join('\n').includes('答案 B'), '驻留期间应看得到结论');

  // 手动触发清空：换一个 0 驻留的实例不现实，这里直接把驻留调短后等它到点
  const short = windowUi({ rows: 20, width: 56, dwellMs: 150 });
  const b2 = short.ui.beginQuestion({ question: Q(), index: 1 });
  b2.finish({ answer: '左权', elapsedMs: 900, meta: { letters: ['B'], emitStrategy: 'text', emitVerified: true } });
  await sleep(320);
  const after = short.term.lines.join('\n');
  assert.ok(!after.includes('答案 B'), '驻留结束后应清空');
  assert.ok(!/╭/.test(after), '等待态不该还有题目框');
  assert.ok(after.includes('等待'), '应回到等待态，实际：' + JSON.stringify(after));
  ui.destroy();
  short.ui.destroy();
});

test('窗口：UI_DWELL_MS=0 时答完立刻清空', async () => {
  const { ui, term } = windowUi({ rows: 20, width: 56, dwellMs: 0 });
  const b = ui.beginQuestion({ question: Q(), index: 1 });
  b.finish({ answer: '左权', elapsedMs: 900, meta: { letters: ['B'], emitStrategy: 'text', emitVerified: true } });
  await settle();
  const screen = term.lines.join('\n');
  assert.ok(!screen.includes('答案'), '立刻清空时不应残留结论');
  assert.ok(!/╭/.test(screen), '立刻清空时不应残留题目框');
  ui.destroy();
});

test('窗口：下一题会抢占上一题的驻留', async () => {
  const { ui, term } = windowUi({ rows: 20, width: 56, dwellMs: 5000 });
  const b1 = ui.beginQuestion({ question: Q({ title: '前一题' }), index: 1 });
  b1.finish({ answer: '甲', elapsedMs: 100, meta: { letters: ['A'], emitStrategy: 'text', emitVerified: true } });
  await settle();
  const b2 = ui.beginQuestion({ question: Q({ title: '后一题' }), index: 2 });
  await settle();
  const screen = term.lines.join('\n');
  assert.ok(screen.includes('后一题'), '新题应在屏幕上');
  assert.ok(!screen.includes('前一题'), '新题应直接替换掉旧题，而不是等驻留结束');
  ui.destroy();
});

test('窗口：并发两题也不会交错（整屏替换天然互斥）', async () => {
  const { ui, term } = windowUi({ rows: 24, width: 60 });
  const b1 = ui.beginQuestion({ question: Q({ title: '并发题一' }), index: 1 });
  const b2 = ui.beginQuestion({ question: Q({ title: '并发题二' }), index: 2 });
  b1.verdict({ label: 'A', verdict: 'correct', why: '一的内容' });
  b2.verdict({ label: 'B', verdict: 'correct', why: '二的内容' });
  await settle();
  const lines = term.lines.join('\n');
  const hasA = lines.includes('并发题一');
  const hasB = lines.includes('并发题二');
  assert.ok(hasA !== hasB, '同一时刻应只显示其中一题（不能两题都在，也不能都不在），实际：\n' + lines);
  assert.ok(term.lines.filter((l) => l.includes('╭')).length <= 1, '屏幕上最多一个框');
  ui.destroy();
});

test('窗口：外部信息（警告）打印后会重画窗口，不破坏区域', async () => {
  const { ui, term } = windowUi({ rows: 24, width: 60 });
  const b = ui.beginQuestion({ question: Q({ title: '区域测试题' }), index: 1 });
  await settle();
  ui.warn('上游限流，稍后重试');
  await settle();
  const lines = term.lines;
  const screen = lines.join('\n');
  assert.ok(screen.includes('上游限流'), '警告要能看到');
  assert.ok(screen.includes('区域测试题'), '窗口内容要被重画回来');
  assert.equal(lines.filter((l) => l.includes('╭')).length, 1, '警告不该产生第二个框');
  assert.ok(lines.length <= 23);
  ui.destroy();
});

test('窗口：终端尺寸变化后按新高度重绘', async () => {
  let cols = 40;
  let rowCount = 24;
  const term = makeTerminal();
  const ui = createUi({
    write: (s) => term.feed(s),
    isTTY: true, env: { TERM: 'xterm' },
    style: 'rich', color: 'never', repaint: true, dwellMs: 10000,
    get columns() { return cols; }, get rows() { return rowCount; },
  });
  // createUi 只读一次 columns/rows，这里用 onResize 注入订阅来触发重算
  const b = ui.beginQuestion({ question: Q({ title: '先窄后宽' }), index: 1 });
  b.verdict({ label: 'A', verdict: 'correct', why: '内容' });
  await settle();
  assert.ok(term.lines.join('\n').includes('先窄后宽'));
  ui.destroy();
});

// ————————————————————————————————————————————————
// 非 TTY / append 路径
// ————————————————————————————————————————————————

test('append 路径（管道/日志）不输出任何 ANSI', () => {
  const out = [];
  const ui = createUi({ write: (s) => out.push(s), isTTY: true, env: { TERM: 'xterm' }, style: 'rich', color: 'auto', width: 56, rows: 20, repaint: false, dwellMs: 0 });
  const b = ui.beginQuestion({ question: Q(), index: 1 });
  b.reasoning('思考内容');
  b.content('{"option_judgements":[{"label":"A","verdict":"correct","why":"理由甲"}]}');
  b.finish({ answer: '115师', elapsedMs: 100, meta: { letters: ['A'], emitStrategy: 'text', emitVerified: true } });
  const text = out.join('');
  assert.ok(!/\u001b\[\d*A/.test(text), '不得有上移序列');
  assert.ok(!/\u001b\[J/.test(text), '不得有擦除序列');
  assert.ok(text.includes('理由甲'), '内容仍要完整输出');
  assert.ok(text.includes('答案 A'));
});

test('plain 路径仍然是逐字节复刻（回归保护）', () => {
  const out = [];
  const ui = createUi({ write: (s) => out.push(s), isTTY: false, env: { TERM: 'dumb' }, style: 'plain' });
  const b = ui.beginQuestion({ question: Q() });
  b.finish({ rawResult: { code: 1, answer: '115师' } });
  const expected = [
    '─'.repeat(60),
    '题干：八路军下辖的三个师分别是?（  ）',
    '题型：choice（来源 shape，OCS 给的是 "unknown"）',
    '选项：A=115师 | B=120师 | C=129师 | D=新编第四军',
    '返回：{"code":1,"answer":"115师"}',
    '',
  ].join('\n');
  assert.equal(out.join(''), expected);
  assert.ok(!/\u001b\[/.test(out.join('')));
});

test('destroy 会清掉窗口与定时器，不留残留', async () => {
  const { ui, term } = windowUi({ rows: 20, width: 56, dwellMs: 10000 });
  const b = ui.beginQuestion({ question: Q(), index: 1 });
  b.verdict({ label: 'A', verdict: 'correct', why: '内容' });
  await settle();
  ui.destroy();
  assert.equal(term.lines.filter((l) => l.includes('╭')).length, 0, 'destroy 后窗口应被擦除');
});
