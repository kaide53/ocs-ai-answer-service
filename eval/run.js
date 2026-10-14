'use strict';
/**
 * 准确率回归：对 eval/questions.json 逐题调用本地服务，输出正确率与错题清单。
 *
 *   npm run eval
 *   npm run eval -- --base-url http://127.0.0.1:3000 --out eval/baseline.json
 *
 * 建议先在没有改动前的代码上跑一次存成 baseline.json，改造后再跑一次对比。
 */
const fs = require('fs');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const baseUrl = arg('base-url', process.env.EVAL_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const file = path.resolve(process.cwd(), arg('file', 'eval/questions.json'));
const outFile = arg('out', '');
const requestTimeout = Number(arg('timeout', '180000'));

function expectedOf(q) {
  const raw = String(q.answer == null ? '' : q.answer).trim();
  if (q.type === 'completion') return { kind: 'text', value: raw };
  return { kind: 'letters', value: raw.replace(/[^A-Za-z]/g, '').toUpperCase().split('').sort().join('') };
}

function actualOf(q, result) {
  if (q.type === 'completion') return { kind: 'text', value: String(result.answer == null ? '' : result.answer).trim() };
  const letters =
    Array.isArray(result.letters) && result.letters.length
      ? result.letters
      : String(result.answer == null ? '' : result.answer).replace(/[^A-Za-z]/g, '').split('');
  return {
    kind: 'letters',
    value: letters.map((l) => String(l).toUpperCase()).filter(Boolean).sort().join(''),
  };
}

function isHit(expected, actual) {
  if (expected.kind === 'text') {
    if (!actual.value) return false;
    return actual.value.includes(expected.value) || expected.value.includes(actual.value);
  }
  return Boolean(actual.value) && expected.value === actual.value;
}

async function ask(question) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), requestTimeout);
  try {
    const res = await fetch(baseUrl + '/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: question.question,
        options: question.options,
        type: question.type,
        course: question.course || undefined,
      }),
      signal: ac.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  if (!fs.existsSync(file)) {
    console.error('找不到题集文件：' + file);
    process.exit(1);
  }
  const dataset = JSON.parse(fs.readFileSync(file, 'utf8'));
  // 题集可以给一个顶层 course 作为默认课程；每题也能用 course 字段单独覆盖
  const questions = (dataset.questions || dataset).map((q) => Object.assign({ course: dataset.course || '' }, q));

  console.log('服务地址：' + baseUrl);
  console.log('题集：' + file + '（' + questions.length + ' 题）\n');

  try {
    const health = await fetch(baseUrl + '/health');
    const j = await health.json();
    console.log('服务信息：' + JSON.stringify(j) + '\n');
  } catch (err) {
    console.error('无法连接服务（' + baseUrl + '）：' + err.message);
    console.error('请先在另一个终端运行 npm start');
    process.exit(1);
  }

  let hit = 0;
  let served = 0;
  const details = [];
  const started = Date.now();

  for (const q of questions) {
    const expected = expectedOf(q);
    const t0 = Date.now();
    let result = {};
    let error = '';
    try {
      result = await ask(q);
    } catch (err) {
      error = err.message;
    }
    const ms = Date.now() - t0;
    const actual = actualOf(q, result || {});
    const ok = !error && isHit(expected, actual);
    if (ok) hit += 1;
    if (result && result.code === 1) served += 1;

    const id = String(q.id == null ? details.length + 1 : q.id).padStart(3, ' ');
    if (ok) {
      console.log('[' + id + '] ✓ ' + expected.value + '  (' + ms + 'ms' + (result.source ? ', ' + result.source : '') + ')');
    } else {
      console.log(
        '[' + id + '] ✗ 期望 ' + expected.value + '｜实得 ' + (actual.value || '(无)') +
        '｜' + (error ? 'ERROR ' + error : 'code=' + result.code) +
        '｜' + ms + 'ms'
      );
      console.log('      题目：' + String(q.question).slice(0, 60));
      if (result && result.answer) console.log('      返回答案：' + result.answer);
    }

    details.push({
      id: q.id,
      question: q.question,
      type: q.type,
      expected: expected.value,
      actual: actual.value,
      answer: result ? result.answer : undefined,
      letters: result ? result.letters : undefined,
      source: result ? result.source : undefined,
      code: result ? result.code : undefined,
      ms,
      ok,
      error: error || undefined,
    });
  }

  const totalMs = Date.now() - started;
  const rate = questions.length ? (hit / questions.length) * 100 : 0;
  console.log('\n================ 结果 ================');
  console.log('正确率：' + hit + '/' + questions.length + ' = ' + rate.toFixed(1) + '%');
  console.log('服务成功作答（code=1）：' + served + '/' + questions.length);
  console.log('总耗时：' + totalMs + 'ms｜平均 ' + Math.round(totalMs / Math.max(1, questions.length)) + 'ms/题');

  if (outFile) {
    const out = path.resolve(process.cwd(), outFile);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ baseUrl, file, hit, total: questions.length, rate, totalMs, details }, null, 2), 'utf8');
    console.log('已写入：' + out);
  }

  if (rate < 100) {
    console.log('\n提示：把错题的正确答案填回题集，或用 POST /feedback 把答案钉死，下次就能直接命中。');
  }
})();
