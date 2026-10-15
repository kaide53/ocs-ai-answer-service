'use strict';
const cfg = require('./src/config');
const { createServer } = require('./src/app');

const server = createServer();
server.listen(cfg.PORT, () => {
  console.log('ocs-answer-engine 已启动');
  console.log('  监听端口 : ' + cfg.PORT);
  console.log('  作答开关 : ' + (cfg.SOLVE.ENABLED ? '开启（会调用模型）' : '关闭（仅捕获原始报文）'));
  console.log('  模型     : ' + (cfg.AI.MODEL || '(未配置)'));
  console.log('  原始报文 : ' + require('./src/capture').FILE);
  console.log('');
  console.log('看一眼 OCS 到底发了什么：');
  console.log('  curl -s http://127.0.0.1:' + cfg.PORT + '/capture/profile | python3 -m json.tool');
  console.log('  curl -s "http://127.0.0.1:' + cfg.PORT + '/capture/recent?limit=5" | python3 -m json.tool');
});
