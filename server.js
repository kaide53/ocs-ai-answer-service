'use strict';
const cfg = require('./src/config');
const { createApp } = require('./src/app');

const app = createApp();

app.listen(cfg.PORT, () => {
  console.log('AI 做题家服务已启动，监听端口 ' + cfg.PORT);
  console.log(
    '模型：' + cfg.AI.MODEL +
    '｜JSON 模式：' + cfg.AI.JSON_MODE +
    '｜自洽投票：' + cfg.AI.VOTE_N +
    '｜联网检索：' + cfg.SEARCH.ENABLED + '(' + cfg.SEARCH.MODE + ')' +
    '｜缓存：' + cfg.CACHE.ENABLED
  );
  if (!cfg.AI.KEY) console.warn('⚠ 未配置 AI_API_KEY，请在 .env 中填写');
});
