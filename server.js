const express = require('express');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;
require('dotenv').config();

app.use(express.json());

app.post('/answer', async (req, res) => {
  const rawOptions = req.body.options;
  const question = req.body.question;

  console.log("=========================================");
  console.log("题目：", question);
  console.log("原始选项字符串：", rawOptions);

  if (!rawOptions || !question) {
    console.warn("数据不完整，返回空");
    return res.json({ code: 0 });
  }

  const options = parseOptions(rawOptions);
  // 提取纯净的选项内容，用于发给 AI 判断
  const pureOptions = options.map(opt => opt.replace(/^[A-F]\.\s*/, "").trim());
  console.log("解析后选项：", options);

  try {
    // 优化后的 Prompt：强制要求输出 JSON，并且只输出字母
const prompt = `你是一个专业的答题助手。请仔细分析题目和选项，选出正确答案。
要求：
1. 必须以严格的 JSON 格式返回结果，不要包含任何 Markdown 标记（如 \`\`\`json ）。
2. 为了保证准确率，JSON 必须包含两个字段：
   - "thought": 你的思考和分析过程。
   - "answers": 一个包含正确选项大写字母的数组。
3. 单选题示例：{"thought": "A和B明显错误，C符合题意。", "answers": ["C"]}
4. 多选题示例：{"thought": "A和D描述了正确的特征，B和C逻辑矛盾。", "answers": ["A", "D"]}
5. 如果遇到“以上都对”这类的选项，请结合逻辑直接将其对应的单字母放入 answers 数组。

题目：${question}

选项：
${pureOptions.map((opt, i) => `${String.fromCharCode(65 + i)}. ${opt}`).join('\n')}`;

    const response = await axios.post(
      process.env.AI_API_URL, 
      {
        model: process.env.AI_MODEL || 'default-model',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1 // 降低温度以获得更稳定的格式化输出
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.AI_API_KEY}`,
        },
        timeout: 10000 // 稍微增加一点超时时间，因为多选题可能思考时间较长
      }
    );

    let aiAnswer = response.data.choices?.[0]?.message?.content?.trim() || "";
    console.log("AI 原始返回：", aiAnswer);

    let selectedLetters = [];

    try {
      // 1. 尝试清理可能存在的 markdown 代码块包裹 (如 ```json ... ```)
      const cleanJsonStr = aiAnswer.replace(/```json/gi, '').replace(/```/g, '').trim();
      const parsedData = JSON.parse(cleanJsonStr);
      
      if (parsedData && Array.isArray(parsedData.answers)) {
        selectedLetters = parsedData.answers;
      }
    } catch (e) {
      console.warn("标准 JSON 解析失败，尝试使用正则提取字母兜底...");
      // 2. 兜底方案：直接匹配字符串中的 A-F 大写字母
      const match = aiAnswer.match(/[A-F]/g);
      if (match) {
        // 去重，防止 AI 返回类似 "A.选项A" 时匹配到多个A
        selectedLetters = [...new Set(match)]; 
      }
    }

    console.log("提取到的正确选项字母：", selectedLetters);

    // 根据提取到的字母，映射回原始选项的纯内容
    let matched = [];
    selectedLetters.forEach(letter => {
      // 将 A-F 转换为对应的数组索引 0-5
      const index = letter.charCodeAt(0) - 65; 
      if (index >= 0 && index < pureOptions.length) {
        // OCS 插件需要的是没有 ABCD 字母前缀的选项内容
        matched.push(pureOptions[index]); 
      }
    });

    // 如果 AI 彻底抽风什么都没匹配到，默认选第一个（防止 OCS 插件报错停滞）
    const finalAnswerList = matched.length > 0 ? matched : [pureOptions[0]];
    const finalAnswer = finalAnswerList.join("、");

    console.log(`最终返回给 OCS 的答案串：${finalAnswer}`);
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
  if (/[A-F]\./.test(optionStr)) {
    return optionStr
      .split(/(?=[A-F]\.)/)
      .map(opt => opt.trim())
      .filter(Boolean);
  } else {
    return optionStr
      .split(/\r?\n/)
      .map(opt => opt.trim())
      .filter(Boolean);
  }
}

app.listen(port, () => {
  console.log(`AI 做题家服务已启动，监听端口 ${port}`);
});