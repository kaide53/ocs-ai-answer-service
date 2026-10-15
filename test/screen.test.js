'use strict';
/**
 * 屏幕合成的纯函数测试：区域顺序、行数上限、窗口化、降级阶梯。
 * 这些是"题目框永不被挤掉"这条约束的直接依据。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { composeScreen, composeIdle, formatVerdicts, formatResult, buildBox } = require('../src/ui/screen');
const { createTheme } = require('../src/ui/theme');
const { strWidth } = require('../src/ui/width');
const { stripAnsi } = require('../src/ui/box');

const theme = createTheme({ enabled: false });
const plain = (lines) => lines.map((l) => stripAnsi(l));

const baseModel = (over = {}) => Object.assign({
  index: 1,
  title: '八路军下辖的三个师分别是?（  ）',
  options: [{ label: 'A', text: '115师' }, { label: 'B', text: '120师' }, { label: 'C', text: '129师' }, { label: 'D', text: '新编第四军' }],
  notes: [],
  type: 'choice', typeSource: 'shape',
  status: '正在分析… 1.2s',
  reasoning: '',
  verdicts: [],
  result: null,
}, over);

const compose = (model, opts = {}) => composeScreen(model, { width: 60, maxLines: 23, theme, ...opts });

test('区域顺序：题目框 → 空行 → 状态行 → 流式内容 → 结论', () => {
  const c = compose(baseModel({
    reasoning: '这是思考内容。',
    verdicts: [{ label: 'A', verdict: 'correct', why: '理由甲' }],
    result: { answer: '115师', elapsedMs: 900, meta: { letters: ['A'], emitStrategy: 'text', emitVerified: true } },
  }));
  const text = plain(c.lines);
  const iBox = text.findIndex((l) => l.includes('╭'));
  const iTitle = text.findIndex((l) => l.includes('八路军下辖'));
  const iStatus = text.findIndex((l) => l.includes('正在分析'));
  const iThink = text.findIndex((l) => l.includes('· 思考'));
  const iVerdict = text.findIndex((l) => l.includes('理由甲'));
  const iResult = text.findIndex((l) => l.includes('答案 A'));
  assert.ok(iBox < iTitle && iTitle < iStatus, '框与题干要在状态行之前');
  assert.ok(iStatus < iThink, '状态行在思考之前');
  assert.ok(iThink < iVerdict, '思考在逐项判定之前');
  assert.ok(iVerdict < iResult, '结论在最后');
});

test('行数永不超过 maxLines（扫描各种高度）', () => {
  const model = baseModel({
    reasoning: '很长的思考。'.repeat(50),
    verdicts: ['A', 'B', 'C', 'D'].map((L) => ({ label: L, verdict: 'correct', why: '理由'.repeat(20) })),
    result: { answer: '甲', elapsedMs: 100, meta: { letters: ['A'], emitStrategy: 'text', emitVerified: true } },
  });
  for (let H = 3; H <= 40; H += 1) {
    const c = compose(model, { maxLines: H });
    assert.ok(c.lines.length <= H, 'maxLines=' + H + ' 时输出 ' + c.lines.length + ' 行');
  }
});

test('框在任何高度下都是闭合的（不会被从中间切断）', () => {
  const model = baseModel({
    title: '以下关于抗日战争的表述哪些是正确的？',
    options: ['A', 'B', 'C', 'D', 'E'].map((L) => ({ label: L, text: '选项' + L })),
    reasoning: '长内容。'.repeat(40),
    verdicts: [{ label: 'A', verdict: 'correct', why: '理由' }],
  });
  for (let H = 3; H <= 30; H += 1) {
    const c = compose(model, { maxLines: H });
    const text = plain(c.lines).join('\n');
    const hasTop = text.includes('╭');
    const hasBottom = text.includes('╰');
    assert.equal(hasTop, hasBottom, 'maxLines=' + H + ' 时框不闭合：\n' + text);
  }
});

test('窗口化：超出时保留流式区的尾部，并提示被裁掉多少行', () => {
  const verdicts = ['A', 'B', 'C', 'D', 'E', 'F'].map((L) => ({ label: L, verdict: 'correct', why: '理由' + L }));
  const c = compose(baseModel({ reasoning: '思考。'.repeat(20), verdicts }), { maxLines: 14 });
  const text = plain(c.lines).join('\n');
  assert.ok(c.dropped > 0, '应当发生裁剪');
  assert.ok(text.includes('前面还有 ' + c.dropped + ' 行'), '提示行要给出准确的裁剪行数');
  assert.ok(text.includes('理由F'), '最新的内容（尾部）必须保留');
  assert.ok(!text.includes('理由A'), '最早的判定应被裁掉');
  assert.ok(text.includes('八路军下辖'), '题目框必须仍在');
});

test('降级阶梯：空间不足时先丢状态行，再丢备注，再压选项折行', () => {
  const model = baseModel({ notes: ['这是一条备注'], reasoning: '思考。'.repeat(10) });
  const wide = compose(model, { maxLines: 23 });
  assert.ok(plain(wide.lines).join('\n').includes('正在分析'), '空间充足时状态行应在');

  const tight = compose(model, { maxLines: 13 });
  assert.ok(!plain(tight.lines).join('\n').includes('正在分析'), '空间紧张时应先丢状态行');
});

test('极矮终端退化为紧凑框，仍然闭合', () => {
  const c = compose(baseModel({ reasoning: '内容'.repeat(20) }), { maxLines: 3 });
  const text = plain(c.lines).join('\n');
  assert.ok(c.lines.length <= 3);
  assert.ok(text.includes('╭') && text.includes('╰'), '紧凑框也要闭合：\n' + text);
});

test('极窄宽度不会越界（每行宽度不超过设定值）', () => {
  for (const width of [30, 34, 40, 60, 100]) {
    const c = compose(baseModel({ reasoning: '中文思考内容'.repeat(20) }), { width, maxLines: 24 });
    for (const l of c.lines) {
      assert.ok(strWidth(stripAnsi(l)) <= width, 'width=' + width + ' 时出现超宽行：' + JSON.stringify(stripAnsi(l)));
    }
  }
});

test('逐项判定的标记与颜色语义正确', () => {
  const lines = plain(formatVerdicts([
    { label: 'A', verdict: 'correct', why: '对的' },
    { label: 'B', verdict: 'wrong', why: '错的' },
    { label: 'C', verdict: 'unsure', why: '拿不准' },
  ], theme, 60));
  assert.ok(lines[0].includes('✔') && lines[0].includes('A'));
  assert.ok(lines[1].includes('✘') && lines[1].includes('B'));
  assert.ok(lines[2].includes('?') && lines[2].includes('C'));
});

test('判定缺 why 时给出兜底措辞，不出现 undefined', () => {
  const lines = plain(formatVerdicts([{ label: 'A', verdict: 'correct', why: '' }], theme, 60));
  assert.ok(!lines[0].includes('undefined'));
  assert.ok(lines[0].includes('判定为正确'));
});

test('结论行包含答案、回写策略、自检状态与耗时', () => {
  const lines = plain(formatResult({
    answer: '["115师","120师"]', elapsedMs: 2364,
    meta: { letters: ['A', 'B'], emitStrategy: 'text-json', emitVerified: true },
  }, theme, 60));
  const text = lines.join('\n');
  assert.ok(text.includes('答案 AB'));
  assert.ok(text.includes('多选文本'));
  assert.ok(text.includes('自检通过'));
  assert.ok(text.includes('2.4s'));
});

test('结论：自检降级与冲突都要显式提示', () => {
  const lines = plain(formatResult({
    answer: '甲', elapsedMs: 500,
    meta: { letters: ['A'], emitStrategy: 'letter', emitVerified: false, conflict: '判定与答案不一致', rechecked: true },
  }, theme, 60));
  const text = lines.join('\n');
  assert.ok(text.includes('自检降级'));
  assert.ok(text.includes('判定与答案不一致'));
  assert.ok(text.includes('已定向重问复核'));
});

test('结论：拿不到答案时显示失败原因，不显示成功标记', () => {
  const lines = plain(formatResult({ msg: '模型未给出可用答案', elapsedMs: 300 }, theme, 60));
  const text = lines.join('\n');
  assert.ok(text.includes('模型未给出可用答案'));
  assert.ok(text.includes('✗'), '应使用失败标记');
  assert.ok(!text.includes('✓ 答案'), '不应出现成功标记');
});

test('等待态只有一行且不含边框', () => {
  const c = composeIdle({ width: 60, maxLines: 23, theme });
  assert.equal(c.lines.length, 1);
  assert.ok(!plain(c.lines)[0].includes('╭'));
});

test('空模型 / 缺字段不抛错且产出行数受控', () => {
  for (const m of [{}, { title: null, options: null }, baseModel({ options: [] })]) {
    assert.doesNotThrow(() => {
      const c = composeScreen(m, { width: 40, maxLines: 10, theme });
      assert.ok(c.lines.length <= 10);
    });
  }
});

test('选项过多时压缩显示并标注还有几个', () => {
  const options = 'ABCDEFGH'.split('').map((L) => ({ label: L, text: '选项' + L }));
  const box = plain(buildBox(baseModel({ options }), theme, 50, 1, false, 3));
  const text = box.join('\n');
  assert.ok(text.includes('选项A') && text.includes('选项C'));
  assert.ok(!text.includes('选项D'), '被压缩掉的选项不应出现');
  assert.ok(/还有 5 个选项/.test(text), '要标注还有几个，实际：\n' + text);
});
