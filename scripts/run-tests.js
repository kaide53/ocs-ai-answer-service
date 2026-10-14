'use strict';
/**
 * 在同一个进程里顺序加载所有 test/*.test.js。
 *
 * 为什么不用 node --test test/：那个 runner 会用管道 spawn 子进程读取测试结果，
 * 在某些受限/沙箱环境里会 EPERM。直接 require 时 node:test 仍在进程内运行并照常报错退出。
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'test');
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

if (files.length === 0) {
  console.error('没有找到任何 test/*.test.js');
  process.exit(1);
}
console.log('运行 ' + files.length + ' 个测试文件：' + files.join(', ') + '\n');
for (const f of files) require(path.join(dir, f));
