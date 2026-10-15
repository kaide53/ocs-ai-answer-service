'use strict';
/**
 * 免 OCS、免 API Key 的界面预览。
 *
 *   npm run demo              # 自动（TTY 下就是富界面）
 *   npm run demo -- --plain   # 看加 UI 之前的纯文本样子
 *   npm run demo -- --plain-sim  # 富界面但关掉颜色（检查边框对齐）
 *   npm run demo -- --width 72
 *   npm run demo -- --nodelay    # 不做流式延时，直接出结果
 *
 * 它只调用渲染层，不碰 solve / HTTP，所以不可能影响真实答题。
 */
const { createUi } = require('../src/ui/render');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

const asPlain = Boolean(arg('plain', false));
const forceRich = Boolean(arg('rich', false)) || Boolean(arg('nocolor', false));
const forceColor = Boolean(arg('color', false));
const noDelay = Boolean(arg('nodelay', false));
const width = Number(arg('width', 0)) || 0;
const sleep = (ms) => (noDelay ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));

/** 三个覆盖不同题型的样例，其中一道是图片题 */
const CASES = [
  {
    question: {
      title: '抗战时期八路军牺牲的最高将领是（　　）',
      options: [
        { label: 'A', text: '陈宇寰' }, { label: 'B', text: '左权' },
        { label: 'C', text: '包森' }, { label: 'D', text: '洪麟阁' },
      ],
      type: 'single', typeSource: 'dom', rawType: 'unknown',
      images: [], blankCount: 0,
      flags: { hasImage: false, imageUrls: [], completionUnsafe: false },
    },
    reasoning: '八路军是国民革命军第八路军。左权是八路军副参谋长，1942 年在山西辽县牺牲，是八路军在抗战中牺牲的最高级别将领。',
    json: {
      question_type: 'single', subject: '中国近现代史纲要', confidence: 0.98,
      option_judgements: [
        { label: 'A', verdict: 'wrong', why: '陈宇寰是抗日将领，但非八路军最高级别' },
        { label: 'B', verdict: 'correct', why: '左权是八路军副参谋长，1942 年牺牲' },
        { label: 'C', verdict: 'wrong', why: '包森是冀东抗日名将，级别较低' },
        { label: 'D', verdict: 'wrong', why: '洪麟阁是冀东抗日英雄，非八路军' },
      ],
      answer: ['B'],
    },
    finish: { answer: '左权', letters: ['B'], strategy: 'text', verified: true, ms: 1744 },
  },
  {
    question: {
      title: '八路军下辖的三个师分别是?（　　）',
      options: [
        { label: 'A', text: '115师' }, { label: 'B', text: '120师' },
        { label: 'C', text: '129师' }, { label: 'D', text: '新编第四军' },
      ],
      type: 'choice', typeSource: 'shape', rawType: 'unknown',
      images: [], blankCount: 0,
      flags: { hasImage: false, imageUrls: [], completionUnsafe: false },
    },
    reasoning: '八路军下辖三个师。新编第四军是另一支队伍，不属于八路军编制。',
    json: {
      question_type: 'multiple', subject: '中国近现代史纲要', confidence: 0.9,
      option_judgements: [
        { label: 'A', verdict: 'correct', why: '115 师，师长林彪' },
        { label: 'B', verdict: 'correct', why: '120 师，师长贺龙' },
        { label: 'C', verdict: 'correct', why: '129 师，师长刘伯承' },
        { label: 'D', verdict: 'wrong', why: '新编第四军属南方游击队改编，不在八路军序列' },
      ],
      answer: ['C', 'A', 'B'],
    },
    finish: { answer: '["115师","120师","129师"]', letters: ['A', 'B', 'C'], strategy: 'text-json', verified: true, ms: 2364 },
  },
  {
    question: {
      title: '如图所示，该电路图中 R1 的阻值是（　　）',
      options: [
        { label: 'A', text: '24 欧姆' }, { label: 'B', text: '42 欧姆' },
        { label: 'C', text: '420 欧姆' }, { label: 'D', text: '4.2 欧姆' },
      ],
      type: 'single', typeSource: 'ocs', rawType: 'single',
      images: ['data:image/png;base64,iVBORw0KGgo='], blankCount: 0,
      flags: { hasImage: true, imageUrls: [], completionUnsafe: false },
    },
    reasoning: '图中标注 R1 = 42 ohm，直接读数即可。',
    json: {
      question_type: 'single', subject: '电路/电工基础', confidence: 0.95,
      option_judgements: [
        { label: 'A', verdict: 'wrong', why: '与图中标注不符' },
        { label: 'B', verdict: 'correct', why: '图中明确标注 42 ohm' },
        { label: 'C', verdict: 'wrong', why: '数量级错误' },
        { label: 'D', verdict: 'wrong', why: '数量级错误' },
      ],
      answer: ['B'],
    },
    finish: { answer: '42 欧姆', letters: ['B'], strategy: 'text', verified: true, ms: 1744 },
  },
];

(async () => {
  const ui = createUi({
    style: asPlain ? 'plain' : forceRich ? 'rich' : 'auto',
    color: asPlain ? 'never' : forceColor ? 'always' : forceRich ? 'never' : 'auto',
    width: width || undefined,
    // 输出被管道接管时不画旋转符，避免 \r 出现在日志里
    spinner: Boolean(process.stdout.isTTY),
    // 没有 TTY 时（管道、CI）也能预览富界面
    ...(forceRich || forceColor ? { isTTY: true, env: { TERM: 'xterm-256color' } } : {}),
  });

  ui.banner({
    监听端口: '3000',
    作答开关: '开启（会调用模型）',
    模型: 'deepseek-flash',
    界面: ui.rich ? ('富界面' + (ui.color ? ' · 彩色' : ' · 无色') + ' · 宽 ' + ui.width) : '纯文本',
    原始报文: 'data/capture.jsonl',
  });
  ui.info('  （这是 npm run demo 的模拟输出，没有真的调用模型）');
  console.log('');

  for (const [i, c] of CASES.entries()) {
    const block = ui.beginQuestion({ question: c.question, index: i + 1 });
    if (c.question.flags.hasImage) block.note('图片题：1 张 base64 直传（OCS 5.x 图片优化）');

    await sleep(120);
    // 模拟"思考"流式逐字到达
    for (const ch of c.reasoning.match(/[\s\S]{1,6}/g) || []) {
      block.reasoning(ch);
      await sleep(12);
    }
    await sleep(80);

    // 模拟 JSON 内容流式逐块到达（故意切在别扭的位置，顺便验证增量提取）
    const json = JSON.stringify(c.json);
    for (let p = 0; p < json.length; p += 11) {
      block.content(json.slice(p, p + 11));
      await sleep(8);
    }
    await sleep(60);

    block.finish({
      answer: c.finish.answer,
      elapsedMs: c.finish.ms,
      meta: { letters: c.finish.letters, emitStrategy: c.finish.strategy, emitVerified: c.finish.verified },
      // plain 模式下用它复刻 "返回：{...}" 那一行
      rawResult: {
        code: 1,
        answer: c.finish.answer,
        meta: { type: c.question.type, letters: c.finish.letters, emitStrategy: c.finish.strategy, emitVerified: c.finish.verified },
        elapsedMs: c.finish.ms,
      },
    });
    console.log('');
  }
})();
