'use strict';
const cfg = require('./src/config');
const { createServer } = require('./src/app');

const captureFile = require('./src/capture').FILE;
const server = createServer();
server.listen(cfg.PORT, () => {
  const ui = require('./src/ui').getUi();
  const info = {
    监听端口: String(cfg.PORT),
    作答开关: cfg.SOLVE.ENABLED ? '开启（会调用模型）' : '关闭（仅捕获原始报文）',
    模型: cfg.AI.MODEL || '(未配置)',
    界面: ui.rich ? ('富界面' + (ui.color ? ' · 彩色' : ' · 无色') + ' · 宽 ' + ui.width) : '纯文本（UI_STYLE=plain 或非 TTY）',
    原始报文: captureFile,
  };
  const tips = [
    '看一眼 OCS 到底发了什么：',
    '  curl -s http://127.0.0.1:' + cfg.PORT + '/capture/profile | python3 -m json.tool',
    '  curl -s "http://127.0.0.1:' + cfg.PORT + '/capture/recent?limit=5" | python3 -m json.tool',
  ];

  if (!ui.rich) {
    // plain 模式：与加 UI 之前逐字节一致，避免影响管道/日志
    console.log('ocs-answer-engine 已启动');
    console.log('  监听端口 : ' + cfg.PORT);
    console.log('  作答开关 : ' + (cfg.SOLVE.ENABLED ? '开启（会调用模型）' : '关闭（仅捕获原始报文）'));
    console.log('  模型     : ' + (cfg.AI.MODEL || '(未配置)'));
    console.log('  原始报文 : ' + captureFile);
    console.log('');
    tips.forEach((l) => console.log(l));
    return;
  }

  ui.banner(info);
  tips.forEach((l) => ui.info('  ' + l));
  console.log('');
});
