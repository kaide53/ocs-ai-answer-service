'use strict';
/**
 * 一次性探测各检索源在当前网络下的可用性：
 *   npm run probe:search -- "《南京条约》签订于哪一年"
 */
const cfg = require('../src/config');
const { SOURCES, buildQueries } = require('../src/retrieval');

(async () => {
  const question = process.argv.slice(2).join(' ') || '《南京条约》签订于哪一年？';
  const queries = buildQueries({ question, courseContext: cfg.COURSE_CONTEXT });

  console.log('题目：' + question);
  console.log('课程语境：' + (cfg.COURSE_CONTEXT || '(未设置)'));
  console.log('生成的查询：' + JSON.stringify(queries));
  console.log('单源超时：' + cfg.SEARCH.TIMEOUT_MS + 'ms\n');

  for (const source of SOURCES) {
    const started = Date.now();
    try {
      const items = await source.run(queries[0]);
      const ms = Date.now() - started;
      console.log('[OK]   ' + source.name.padEnd(11) + items.length + ' 条  ' + ms + 'ms');
      if (items[0]) console.log('       ' + JSON.stringify(items[0]).slice(0, 160));
    } catch (err) {
      console.log('[FAIL] ' + source.name.padEnd(11) + (Date.now() - started) + 'ms  ' + (err && err.message));
    }
  }
})();
