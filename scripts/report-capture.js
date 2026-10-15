'use strict';
/**
 * 把 data/capture.jsonl 汇总成一份人看的报告。
 *
 *   npm run report
 *   node scripts/report-capture.js --file data/capture.jsonl --limit 8
 *
 * 用途：实地跑一轮真实 OCS 流量后，回答"OCS 每一次发回来的内容到底长什么样"，
 * 并核对它和 docs/OCS-CONTRACT.md 里的源码考证是否一致。
 */
const fs = require('fs');
const path = require('path');
const cfg = require('../src/config');
const { ingest } = require('../src/ingest');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const file = path.resolve(cfg.ROOT, arg('file', path.join(cfg.DATA_DIR, cfg.CAPTURE.FILE)));
const sampleN = Number(arg('limit', 5));

// —— 源码考证里"预期会出现"的字段。多出来的字段要显眼提示 ——
const EXPECTED = new Set(['title', 'options', 'type', 'dom', 'question']);
// OCS 只会给这四个 type 值；出现别的说明平台或 OCS 版本不同
const VALID_TYPES = new Set(['single', 'multiple', 'judgement', 'completion', 'unknown', 'undefined', 'null']);

function bar(n, total, width = 24) {
  const w = total ? Math.round((n / total) * width) : 0;
  return '█'.repeat(Math.max(n > 0 ? 1 : 0, w));
}

(function main() {
  if (!fs.existsSync(file)) {
    console.error('找不到捕获文件：' + file);
    console.error('先跑 `npm start`（保持 SOLVE_ENABLED=false），把 OCS 题库指向本服务，刷几道题。');
    process.exit(1);
  }

  const raw = fs.readFileSync(file, 'utf8').trim();
  const entries = raw ? raw.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const reqs = entries.filter((e) => e.kind === 'ocs_request' && e.body && typeof e.body === 'object');

  console.log('捕获文件：' + file);
  console.log('总记录 ' + entries.length + ' 条，其中带 body 的 OCS 请求 ' + reqs.length + ' 条');
  if (!reqs.length) {
    console.log('\n还没有收到任何请求。把 OCS 配置里的 url 指向本服务（见 ocs-answer-engine/ocs-config.json）后刷几道题。');
    return;
  }
  const ts = reqs.map((r) => r.ts).sort();
  console.log('时间范围：' + ts[0] + '  →  ' + ts[ts.length - 1]);

  // ——— 1. 字段清单（最重要）———
  console.log('\n================ 一、OCS 到底发了哪些字段 ================');
  const fieldCount = new Map();
  const fieldSample = new Map();
  for (const r of reqs) {
    for (const [k, v] of Object.entries(r.body)) {
      fieldCount.set(k, (fieldCount.get(k) || 0) + 1);
      if (!fieldSample.has(k)) fieldSample.set(k, []);
      const arr = fieldSample.get(k);
      if (arr.length < 2) arr.push(typeof v === 'string' ? v.slice(0, 150) : JSON.stringify(v).slice(0, 150));
    }
  }
  const sorted = [...fieldCount.entries()].sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sorted) {
    const pct = ((count / reqs.length) * 100).toFixed(0);
    const flag = EXPECTED.has(name) ? '' : '   ← ⚠ 源码考证里没有这个字段';
    console.log('  ' + name.padEnd(12) + String(count).padStart(4) + ' 次 (' + pct + '%)' + flag);
    for (const s of fieldSample.get(name)) console.log('        · ' + JSON.stringify(s));
  }
  const missing = [...EXPECTED].filter((k) => k !== 'question' && !fieldCount.has(k));
  if (missing.length) console.log('  （本批未出现：' + missing.join(', ') + '）');

  // ——— 2. type 的真实分布 ———
  console.log('\n================ 二、type 的真实分布 ================');
  const typeCount = new Map();
  for (const r of reqs) {
    const t = r.body.type === undefined ? '(字段缺失)' : String(r.body.type);
    typeCount.set(t, (typeCount.get(t) || 0) + 1);
  }
  for (const [t, n] of [...typeCount.entries()].sort((a, b) => b[1] - a[1])) {
    const bad = VALID_TYPES.has(t) ? '' : '   ← ⚠ 意料之外的取值';
    console.log('  ' + t.padEnd(12) + String(n).padStart(4) + '  ' + bar(n, reqs.length) + bad);
  }
  const unknownN = [...typeCount].filter(([t]) => /unknown|undefined|null|缺失/.test(t)).reduce((a, b) => a + b[1], 0);
  console.log('  → ' + unknownN + '/' + reqs.length + ' 条 OCS 没给出可用题型，服务端只能自己推');

  // ——— 3. 我们的推断 vs OCS 给的 ———
  console.log('\n================ 三、服务端推断出的题型 ================');
  const inferred = new Map();
  const sourceCount = new Map();
  const parsed = reqs.map((r) => ({ r, q: ingest({ title: r.body.title, options: r.body.options, type: r.body.type, dom: r.body.dom }) }));
  for (const { q } of parsed) {
    inferred.set(q.type, (inferred.get(q.type) || 0) + 1);
    sourceCount.set(q.typeSource, (sourceCount.get(q.typeSource) || 0) + 1);
  }
  for (const [t, n] of [...inferred.entries()].sort((a, b) => b[1] - a[1])) {
    console.log('  ' + t.padEnd(12) + String(n).padStart(4) + '  ' + bar(n, reqs.length));
  }
  console.log('  判定来源：' + [...sourceCount.entries()].map(([k, v]) => k + '=' + v).join('  '));
  console.log('  （ocs=OCS 给了可用题型；dom=靠自定义 handler 抓的 DOM；shape=靠选项形态推）');

  // ——— 4. 选项形态 ———
  console.log('\n================ 四、选项形态 ================');
  const optCount = new Map();
  for (const { q } of parsed) optCount.set(q.options.length, (optCount.get(q.options.length) || 0) + 1);
  for (const [n, c] of [...optCount.entries()].sort((a, b) => a[0] - b[0])) {
    console.log('  ' + String(n).padStart(2) + ' 个选项 : ' + String(c).padStart(4) + ' 题  ' + bar(c, reqs.length));
  }
  const noOpt = parsed.filter(({ q }) => q.options.length === 0).length;
  const judgementLike = parsed.filter(({ q }) => q.flags.judgementLike).length;
  console.log('  → 无选项（填空）' + noOpt + ' 题｜判断题形态 ' + judgementLike + ' 题');

  // ——— 5. 图片题 ———
  console.log('\n================ 五、图片题 ================');
  const withImg = parsed.filter(({ q }) => q.flags.hasImage);
  console.log('  含图片链接的题目：' + withImg.length + ' 题');
  for (const { q } of withImg.slice(0, 5)) {
    console.log('    · ' + q.title.slice(0, 50));
    q.flags.imageUrls.slice(0, 2).forEach((u) => console.log('        ' + u.slice(0, 110)));
  }
  if (!withImg.length) console.log('  （本批没有。不同平台行为不同：icourse 会把 img 换成 URL，zhs 只取 innerText）');

  // ——— 6. 平台 / 课程 ———
  console.log('\n================ 六、来源平台分布（靠自定义 handler 抓的） ================');
  const domCount = new Map();
  let domMissing = 0;
  for (const { r } of parsed) {
    let d = r.body.dom;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = null; } }
    if (!d || !d.url) { domMissing += 1; continue; }
    domCount.set(d.url, (domCount.get(d.url) || 0) + 1);
  }
  for (const [u, n] of [...domCount.entries()].sort((a, b) => b[1] - a[1])) console.log('  ' + u.padEnd(30) + n + ' 题');
  if (domMissing) console.log('  ⚠ ' + domMissing + ' 条没拿到 dom —— 检查 OCS 配置里有没有加那个 dom handler（见 ocs-config.json）');

  // ——— 7. 题干特征 ———
  console.log('\n================ 七、题干特征 ================');
  const lens = parsed.map(({ q }) => q.title.length).sort((a, b) => a - b);
  const pct = (p) => lens[Math.min(lens.length - 1, Math.floor(lens.length * p))];
  console.log('  长度 p50=' + pct(0.5) + '  p90=' + pct(0.9) + '  max=' + lens[lens.length - 1]);
  console.log('  含全角括号（题干挖空标记）：' + parsed.filter(({ q }) => /[（(]\s*[）)]|（\s*）/.test(q.title)).length + ' 题');
  console.log('  题干被 OCS 用逗号拼过多标题：' + parsed.filter(({ q }) => q.flags.multiTitle).length + ' 题');

  const dup = new Map();
  for (const { q } of parsed) dup.set(q.title, (dup.get(q.title) || 0) + 1);
  const dups = [...dup.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, sampleN);
  if (dups.length) {
    console.log('  重复出现最多的题干：');
    for (const [t, n] of dups) console.log('    ' + String(n).padStart(3) + '×  ' + t.slice(0, 56));
    console.log('  （注意：OCS 自己有 searchAnswerInCaches 按题干缓存答案，重复题可能压根没再请求我们）');
  }

  console.log('\n================ 对照结论 ================');
  const extra = sorted.filter(([k]) => !EXPECTED.has(k)).map(([k]) => k);
  console.log(extra.length
    ? '⚠ 出现了源码考证之外的字段：' + extra.join(', ') + ' → 需要更新 docs/OCS-CONTRACT.md'
    : '✓ 字段集合与 docs/OCS-CONTRACT.md 的考证一致（title / options / type，外加我们自定义的 dom）');
  const badTypes = [...typeCount.keys()].filter((t) => !VALID_TYPES.has(t));
  console.log(badTypes.length
    ? '⚠ 出现了意料之外的 type 取值：' + badTypes.join(', ')
    : '✓ type 取值都在预期内');
  console.log(domMissing
    ? '⚠ 有 ' + domMissing + ' 条拿不到 dom，题型推断会退化到 shape'
    : '✓ dom 增强信息都拿到了');
})();
