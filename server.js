const express = require('express');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;
require('dotenv').config();

app.use(express.json());

app.post('/answer', async (req, res) => {
  const rawOptions = req.body.options;
  const question = req.body.question;

  console.log("题目：", question);
  console.log("原始选项字符串：", rawOptions);

  if (!rawOptions || !question) {
    console.warn("数据不完整，返回空");
    return res.json({ code: 0 });
  }

  const options = parseOptions(rawOptions);
  const pureOptions = options.map(opt => opt.replace(/^[A-F]\.\s*/, "").trim());
  console.log("解析后选项：", options);

  try {
    //这里可以修改AI的提示词 我不确定修改了会不会导致问题 请自行测试 但是应该可以通过优化提示词来提高AI的准确性
    const prompt = `请从以下选项中选择一个最合适的答案，只返回选项的内容，不要返回选项字母。\n\n题目：${question}\n\n选项：\n${pureOptions.map((opt, i) => `${String.fromCharCode(65 + i)}. ${opt}`).join('\n')}`;

    const response = await axios.post(
      process.env.AI_API_URL, 
      {
        model: process.env.AI_MODEL || 'default-model',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.AI_API_KEY}`,
        },
        timeout: 8000
      }
    );

    const aiAnswer = response.data.choices?.[0]?.message?.content?.trim();
    console.log("AI：", aiAnswer);


    let matched = options.find((opt, i) =>
      aiAnswer.includes(opt) || aiAnswer.includes(pureOptions[i])
    );

 
    if (!matched && /^[A-F]$/i.test(aiAnswer)) {
      const index = aiAnswer.toUpperCase().charCodeAt(0) - 65;
      matched = options[index];
    }

    const fallback = options[0];
    const finalOption = matched || fallback;
    const finalAnswer = finalOption.replace(/^[A-F]\.\s*/, "").trim();

    console.log(`返回给 OCS：${finalAnswer}`);
    return res.json({
      code: 1,
      question,
      answer: finalAnswer
    });

  } catch (err) {
    console.error("调用 API 出错：", err.message || err);
    return res.json({ code: 0 });
  }
});

function parseOptions(optionStr) {
  return optionStr
    .split(/(?=[A-F]\.)/)
    .map(opt => opt.trim())
    .filter(Boolean);
}

app.listen(port, () => {
  console.log(`AI 做题家服务已启动，监听端口 ${port}`);
});