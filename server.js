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
    const prompt = `请分析以下题目类型并给出最合适的答案：
1. 如果是单选题或判断题，请只返回一个最合适的选项内容（不要返回选项字母）
2. 如果是多选题，请返回所有正确选项的内容（不要返回选项字母），用"、"分隔
3. 请直接返回选项内容，不要包含任何解释或说明

题目：${question}

选项：
${pureOptions.map((opt, i) => `${String.fromCharCode(65 + i)}. ${opt}`).join('\n')}`;

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

    let matched = [];
    // 处理多选题情况（包含"、"分隔的多个答案）
    if (aiAnswer.includes("、")) {
      const answerParts = aiAnswer.split("、").map(p => p.trim());
      matched = options.filter(opt => {
        const pureOpt = opt.replace(/^[A-F]\.\s*/, "").trim();
        return answerParts.some(part => 
          part === pureOpt ||  // 完全匹配选项内容
          part === opt.charAt(0)  // 匹配选项字母
        );
      });
    } else {
      // 处理单选题情况
      matched = options.filter(opt => {
        const pureOpt = opt.replace(/^[A-F]\.\s*/, "").trim();
        return aiAnswer === pureOpt ||  // 完全匹配选项内容
               aiAnswer === opt.charAt(0);  // 匹配选项字母
      });
    }

    if (matched.length === 0 && /^[A-F]+$/i.test(aiAnswer)) {
      // 处理只返回选项字母的情况（如"AB"或"ACD"）
      matched = Array.from(aiAnswer.toUpperCase())
        .map(c => options[c.charCodeAt(0) - 65])
        .filter(Boolean);
    }

    const fallback = [options[0]];
    const finalOptions = matched.length > 0 ? matched : fallback;
    const finalAnswer = finalOptions
      .map(opt => opt.replace(/^[A-F]\.\s*/, "").trim())
      .join("、");

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