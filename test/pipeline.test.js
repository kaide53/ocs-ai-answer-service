'use strict';
/**
 * 端到端断言：我们的输出 → **OCS 官方匹配算法** → 必须选中我们想选的那几个选项。
 *
 * 这是整个项目的验收标准。旧项目从来没做过这件事，所以"服务端返回了正确答案、
 * 页面上却没选中"这类问题只能靠人肉踩坑发现。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { ingest } = require('../src/ingest');
const { emitVerified } = require('../src/emit');
const matcher = require('../src/ocs/matcher');

/** 便捷：走完 ingest → emitVerified */
function run(payload, letters) {
  const q = ingest(payload);
  const r = emitVerified({ type: q.type, options: q.options, letters, textAnswer: null, blankCount: q.blankCount });
  return { q, r };
}

// ————————————————————————————————————————————————
// 一、必须成功的正常场景
// ————————————————————————————————————————————————

test('单选·散文选项：回写能选中正确项', () => {
  const { q, r } = run(
    { title: '抗战时期八路军牺牲的最高将领是（  ）', options: '  A. 陈宇寰   \n  B. 左权   \n  C. 包森   \n  D. 洪麟阁', type: 'unknown', dom: '{"radios":4}' },
    ['B']
  );
  assert.equal(q.type, 'single', 'dom 里 radios=4 应推成 single');
  assert.equal(r.ok, true, 'OCS 自检必须通过');
  const sel = matcher.resolveSingle([r.answer], q.options.map((o) => o.raw));
  assert.equal(sel.finish, true);
  assert.match(sel.option, /左权/);
});

test('多选·散文选项：三个选项全部被选中（走 JSON 文本数组）', () => {
  const { q, r } = run(
    { title: '八路军下辖的三个师分别是?（  ）', options: 'A. 115师\nB. 120师\nC. 129师\nD. 新编第四军', type: 'multiple' },
    ['A', 'B', 'C']
  );
  assert.equal(r.strategy, 'text-json', '优先走 JSON 文本数组这条最强路径');
  assert.equal(r.ok, true);
  const sel = matcher.resolveMultiple([r.answer], q.options.map((o) => o.raw));
  assert.equal(sel.finish, true);
  const got = sel.options || sel.plainOptions;
  assert.equal(got.length, 3);
  for (const t of ['115师', '120师', '129师']) assert.ok(got.some((g) => g.includes(t)), '应选中 ' + t);
});

test('判断题型能从选项形态推出来（OCS 常给 unknown）', () => {
  const { q } = run({ title: '日本在东北扶植建立了伪满洲国。（ ）', options: 'A. 正确\nB. 错误', type: 'unknown' }, ['A']);
  assert.equal(q.type, 'judgement');
  assert.equal(q.typeSource, 'shape');
});

test('type=choice 且选中多项时，必须走 text-json 而不是退化成字母', () => {
  // choice 表示"单选多选未定"。此时选中 3 项就说明它是多选，
  // 不能因为 type 字面量不是 'multiple' 就掉进单选分支、白白跳过最强路径。
  const { q, r } = run(
    { title: '八路军下辖的三个师分别是?（  ）', options: 'A. 115师\nB. 120师\nC. 129师\nD. 新编第四军', type: 'unknown' },
    ['A', 'B', 'C']
  );
  assert.equal(q.type, 'choice', '4 个普通选项推不出单选多选，应标为 choice');
  assert.equal(r.strategy, 'text-json', 'choice+多项 必须走 JSON 文本数组这条路');
  assert.equal(r.ok, true);
  const sel = matcher.resolveMultiple([r.answer], q.options.map((o) => o.raw));
  assert.equal((sel.options || sel.plainOptions).length, 3);
});

test('type=choice 且只选一项时，走单选文本路径', () => {
  const { q, r } = run(
    { title: '以下说法正确的是（ ）', options: 'A. 甲\nB. 乙\nC. 丙\nD. 丁', type: 'unknown' },
    ['B']
  );
  assert.equal(q.type, 'choice');
  assert.equal(r.strategy, 'text');
  assert.equal(r.answer, '乙');
});

test('判断题·回写能选中"正确"这一项', () => {
  const { q, r } = run({ title: '日本在东北扶植建立了伪满洲国。（ ）', options: 'A. 正确\nB. 错误', type: 'unknown' }, ['A']);
  assert.equal(r.ok, true);
  const sel = matcher.resolveJudgement([[r.answer]], q.options.map((o) => o.text));
  assert.equal(sel.finish, true);
  assert.equal(sel.option, '正确');
});

// ————————————————————————————————————————————————
// 二、固化 OCS 的硬约束（这些是"旧项目为什么会错"的证据）
// ————————————————————————————————————————————————

test('【硬约束】判断题回字母必然失败——所以绝不能回字母', () => {
  const sel = matcher.resolveJudgement([['A']], ['正确', '错误']);
  assert.equal(sel.finish, false, 'OCS 的判断题只有关键词匹配，没有纯 ABCD 兜底');
});

test('【硬约束】多选字母必须升序——"BA" 不是合法纯字母答案', () => {
  assert.equal(matcher.isPlainAnswer('AB'), true);
  assert.equal(matcher.isPlainAnswer('BA'), false, 'isPlainAnswer 要求严格递增');
  assert.equal(matcher.isPlainAnswer('AA'), false, '不允许重复');
});

test('【硬约束】选项文本里的 # | ; 会击穿文本匹配，必须自动退到字母', () => {
  const { q, r } = run(
    { title: '以下哪些是合法分隔符？（ ）', options: 'A. a#b\nB. a|b\nC. a;b\nD. a+b', type: 'multiple' },
    ['A', 'B', 'C']
  );
  assert.equal(r.ok, true, '自检兜底后必须仍然通过');
  assert.equal(r.strategy, 'letter', '文本路径失效时应退到字母');
  const sel = matcher.resolveMultiple([r.answer], q.options.map((o) => o.raw));
  const got = sel.options || sel.plainOptions;
  assert.equal(got.length, 3, '三个选项都要被选中');
});

test('【硬约束】符号型选项（SQL 注释）会击穿纯文本匹配，自检要能发现并换策略', () => {
  const { q, r } = run(
    { title: 'SQL 中单行注释使用哪个符号？', options: 'A. --\nB. /* */\nC. #\nD. //', type: 'single' },
    ['A']
  );
  assert.equal(r.ok, true);
  // 纯文本 "--" 会被 normalizeString 剥成空串而失败，所以**绝不能**用 text 策略
  assert.notEqual(r.strategy, 'text', '朴素文本路径会失败，必须被自检拦下');
  const sel = matcher.resolveSingle([r.answer], q.options.map((o) => o.raw));
  assert.equal(sel.finish, true);
  assert.match(sel.option, /--/);
});

test('回写带上原始标签时更稳：OCS 的 removeRedundant 对答案与选项同等施加，mangling 会抵消', () => {
  // 'A. --' 经 removeRedundant 变成 'a'；选项 'A. --' 也变成 'a'，于是精确匹配成立。
  // 这正是 emit 的 raw 候选存在的意义。
  const { q, r } = run({ title: 'SQL 注释', options: 'A. --\nB. //', type: 'single' }, ['A']);
  assert.equal(r.ok, true);
  assert.equal(r.answer, 'A. --');
  const sel = matcher.resolveSingle([r.answer], q.options.map((o) => o.raw));
  assert.equal(sel.finish, true);
  assert.match(sel.option, /--/);
});

// ————————————————————————————————————————————————
// 三、解析的健壮性
// ————————————————————————————————————————————————

test('多行选项不会被切多（旧代码按 \\n 切会在这里错位）', () => {
  const q = ingest({
    title: '以下代码输出什么？（ ）',
    options: 'A. 第一行\n第二行\nB. 只有一个选项',
    type: 'single',
  });
  assert.equal(q.options.length, 2, '续行应并入上一个选项，而不是算作新选项');
  assert.equal(q.options[0].text, '第一行 第二行');
  assert.equal(q.options[1].text, '只有一个选项');
});

test('全角字母与各种标签形态都能解析', () => {
  for (const raw of ['Ａ．甲\nＢ．乙', '（A）甲\n（B）乙', 'A、甲\nB、乙', 'A) 甲\nB) 乙']) {
    const q = ingest({ title: '测试', options: raw, type: 'single' });
    assert.equal(q.options.length, 2, '解析失败：' + JSON.stringify(raw));
    assert.equal(q.options[0].text, '甲');
    assert.equal(q.options[1].text, '乙');
  }
});

test('type 是字面量 "unknown"/"undefined" 时不能当作有效题型', () => {
  for (const t of ['unknown', 'undefined', 'null', '', 'UNKNOWN']) {
    const q = ingest({ title: '测试', options: 'A. 甲\nB. 乙\nC. 丙', type: t });
    assert.notEqual(q.typeSource, 'ocs', JSON.stringify(t) + ' 不应被当作 OCS 给出的题型');
  }
});

test('题型给的是有效值时应当采信', () => {
  const q = ingest({ title: '测试', options: 'A. 甲\nB. 乙\nC. 丙', type: 'multiple' });
  assert.equal(q.type, 'multiple');
  assert.equal(q.typeSource, 'ocs');
});

test('4 个普通选项推不出单选还是多选时，诚实标为 choice 而不是猜', () => {
  const q = ingest({ title: '以下说法正确的是', options: 'A. 甲\nB. 乙\nC. 丙\nD. 丁', type: 'unknown' });
  assert.equal(q.type, 'choice', '绝不能默认单选，实测 14/47 这类题实际是多选');
  assert.equal(q.flags.typeAmbiguous, true);
});

// ————————————————————————————————————————————————
// 四、图片题与填空的边界
// ————————————————————————————————————————————————

test('题干里的图片 URL 能被识别（OCS 把 img 换成 img.src 文本）', () => {
  const q = ingest({
    title: '如图所示电路，R1 的阻值是（ ） https://cdn.example.edu/a/b.png',
    options: 'A. 1Ω\nB. 2Ω',
    type: 'single',
  });
  assert.equal(q.flags.hasImage, true);
  assert.equal(q.flags.imageUrls.length, 1);
  assert.ok(!q.textForModel.includes('https://'), '给模型的正文里长 URL 应被替换成 [图片]');
  assert.ok(q.textForModel.includes('[图片]'));
});

test('多空填空拿不到空格数时标记为不安全，应当拒绝作答', () => {
  const q = ingest({ title: '中华人民共和国成立于______年______月______日。', options: '', type: 'completion' });
  assert.equal(q.type, 'completion');
  assert.equal(q.flags.completionUnsafe, true, '空格数不明时不能瞎填');
});

test('填空题有 dom.textareas 时就能安全作答', () => {
  const q = ingest({
    title: '中华人民共和国成立于______年______月______日。',
    options: '',
    type: 'completion',
    dom: '{"textareas":3}',
  });
  assert.equal(q.blankCount, 3);
  assert.equal(q.flags.completionUnsafe, false);
});

// ————————————————————————————————————————————————
// 五、绝不瞎猜
// ————————————————————————————————————————————————

test('没有任何候选能通过 OCS 自检时，必须返回 ok:false 而不是硬塞一个答案', () => {
  const r = emitVerified({ type: 'single', options: [{ label: 'A', text: '甲', raw: 'A. 甲' }], letters: ['Z'], textAnswer: null });
  assert.equal(r.ok, false, '越界字母不应产生任何答案');
});

// ————————————————————————————————————————————————
// 六、计算机类题目的真实风险（子代理差分 fuzz 发现的）
// ————————————————————————————————————————————————

test('代码里的 # 会被 splitAnswer 切开——自检必须发现并保证最终仍选中正确项', () => {
  // OCS 的 isProgramAnswer 只取消 ; | ； 三个分隔符，# 仍然是分隔符，
  // 所以 '#include <stdio.h>' 这种答案会被 '# ' 切成两段。这是 OCS 侧的真实缺陷。
  const q = ingest({
    title: 'C 语言中，以下哪个是预处理指令？',
    options: 'A. #include <stdio.h>\nB. printf("hi");\nC. int main()\nD. return 0;',
    type: 'single',
  });
  const r = emitVerified({ type: 'single', options: q.options, letters: ['A'], textAnswer: null, blankCount: 0 });
  assert.equal(r.ok, true, '自检必须兜住这个缺陷，最终给出能选中 A 的答案');
  const sel = matcher.resolveSingle([r.answer], q.options.map((o) => o.raw));
  assert.equal(sel.finish, true);
  assert.match(sel.option, /#include/, '必须选中含 #include 的那个选项');
});

test('程序题多选：分号是代码语法而非答案分隔符，不能把答案切碎', () => {
  const q = ingest({
    title: '以下哪些是 C 语言的语句终止符或运算符？（ ）',
    options: 'A. ;\nB. |\nC. {}\nD. ()',
    type: 'multiple',
  });
  const r = emitVerified({ type: 'multiple', options: q.options, letters: ['A', 'B'], textAnswer: null, blankCount: 0 });
  assert.equal(r.ok, true);
  const sel = matcher.resolveMultiple([r.answer], q.options.map((o) => o.raw));
  assert.equal(sel.finish, true);
  const got = sel.options || sel.plainOptions;
  assert.equal(got.length, 2, '两个选项都要被选中，不能被分号切碎');
});
