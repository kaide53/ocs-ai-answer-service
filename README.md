# ocs-ai-answer-service

这个项目是为不想依赖固定题库的人提供的另一个选择：让 AI 现场做题，而不是查一个别人整理好的答案库。

**v1.1 重点改了什么**

- 把「拍脑袋给一个答案」改成 **逐选项判定**：模型必须对 A/B/C/D 每个选项单独给出 correct / wrong / unsure 和错因（时间不符、人物不符、因果倒置、绝对化表述……），再汇总答案。
- 强制 **结构化 JSON 输出**（response_format: json_object，接口不支持时自动降级）。
- 修掉了几个会直接产生错误答案的老 bug（见下面「以前的坑」）。
- 答案形态与 OCS 严格对齐，多选题不再靠运气。
- 新增 **结果缓存**、**人工纠错表**、**可选联网检索**、**可选自洽投票**、**准确率回归脚本**。

---

## ✨ 它现在怎么做到更准

| 手段 | 说明 | 额外成本 |
| --- | --- | --- |
| 逐选项判定 | 每个选项单独判定 + 说明错因，比一句 thought 强很多 | 无 |
| 结构化 JSON | 消灭「解析失败就乱猜字母」 | 无 |
| 答案形态对齐 OCS | 多选用 OCS 认得的 # 分隔；判断题返回选项原文 | 无 |
| 拿不到答案就交白卷 | 不再强行选 A 送分 | 无 |
| 缓存 + 人工纠错 | 同一题不漂移；错题可以钉死 | 无 |
| 联网检索兜底 | 免 API Key，抓网页摘要当参考资料 | 略增 prompt token |
| 自洽投票 | 同一题问 N 次取多数（默认关闭） | token ×N |

### 以前的坑（v1.0 的老问题）

1. **幽灵选项**：JSON 解析失败时会用 `match(/[A-F]/g)` 在整段文本里抓大写字母，thought 里出现的「A和B」、英文单词里的 F 都会被当成答案。
2. **多选题分隔符错了**：OCS 的 `splitAnswer` 只认 `=== # --- ### | ; ；`，**不认 、**。老代码用 `、` 拼接多选题答案，到 OCS 那里是一个整体字符串，只能靠包含匹配侥幸命中；选项文本里一旦含 `;` / `|` / `#`（计算机类题目极常见）就会被切碎，必然匹配失败。
3. **强行选 A**：模型完全给不出答案时老代码会默认返回第一个选项，等于白送错误。
4. **选项解析太窄**：只认 `A.`，不认 `A、 A． A) （A）`、全角字母、超过 6 个选项。

---

## 🚀 快速开始

1. 安装 Node.js（建议 18 以上，本项目在 Node 22 上验证）。

       node -v
       npm -v

2. 安装依赖：

       npm install

3. 复制 `.env.example` 为 `.env`，填入你的 API Key：

       cp .env.example .env      # Windows: copy .env.example .env

4. 启动服务：

       npm start                 # 或双击 start.bat

看到 `AI 做题家服务已启动，监听端口 3000` 就成功了。

---

## 📚 OCS 题库配置（重要：一定要带上 type）

把下面这段 JSON 粘到 OCS 的题库配置里。相比旧版，**多了 `type` 字段**——服务端据此区分单选 / 多选 / 判断 / 填空，能明显减少多选误判。

    [
      {
        "name": "AI本地题库",
        "url": "http://localhost:3000/answer",
        "method": "post",
        "contentType": "json",
        "type": "GM_xmlhttpRequest",
        "headers": {
          "Content-Type": "application/json"
        },
        "data": {
          "question": "${title}",
          "options": "${options}",
          "type": "${type}"
        },
        "handler": "return (res)=> res.code === 1 ? [res.question, res.answer] : undefined"
      }
    ]

`${type}` 是 OCS 官方支持的特殊占位符，取值是 `single` / `multiple` / `judgement` / `completion`（已对照 OCS 官方文档与源码确认）。

### 关于面板上的「可用性检测」

OCS 5.x 的题库面板会先发一个 **HEAD** 请求（只有 405/501 才回退 GET）到题库 url，并且**只把 2xx/3xx 当作「连接成功」**。服务端为此注册了 `GET /answer`：

- `HEAD/GET /answer?t=<时间戳>` → 200 + 一段自述信息，面板会显示「连接成功（200）」；
- 没有题目参数时**不会**触发模型调用，不花你的 token；
- 顺带支持 `GET /answer?question=...&options=...&type=...`，所以题库配置也可以用 `"method": "get"`。

如果面板仍然显示失败，先确认服务已经启动（浏览器打开 `http://localhost:3000/` 能返回 json），以及油猴的 `@connect` 允许了 localhost。

### 多门课程怎么用（COURSE_CONTEXT 不绑定任何一门课）

服务端默认不知道你在上什么课，**推荐留空** `COURSE_CONTEXT`：模型会先自己判断题干属于哪门学科（把判断写进 `subject` 字段），再按那门学科的教材、定义与公式作答。于是一台服务可以同时应付近代史、马原、计算机、外语等不同课程的题。

三种用法，按需选：

1. **留空（默认，推荐）**：靠模型自判学科，最省事，跨课程通用。
2. **一段时间内只刷一门课**：在 `.env` 里填 `COURSE_CONTEXT=数据结构`，提示词会以这门课为准，准确率略高；换课时记得改回来。
3. **同时刷多门课，想每题都带课程名**：在 OCS 配置的 `data` 里加一个 `course` 字段，用自定义 handler 从页面抓课程名：

    "course": { "handler": "return (env)=> (document.querySelector('.course-name')?.innerText || document.title || '').slice(0, 30)" }

   选择器按你用的平台改；抓不到就返回空串，服务端会自动退回 .env 的 `COURSE_CONTEXT`（也就是「模型自判学科」）。课程名只影响提示词和联网检索，不影响缓存命中——同一个题目换课程仍然命中同一条缓存。

### 别忘了 @connect

油猴脚本默认不允许跨域请求本地服务，请在脚本头部的 `@connect` 里加上 `localhost` 与 `127.0.0.1`，或者把脚本管理器里的 `@connect 模式` 设为宽松。

### 可选：自动攒回归题集

在 `handler` 里顺手把题面发给服务端，方便你之后对答案、跑准确率回归：

    "handler": "return (res)=> { navigator.sendBeacon('http://localhost:3000/collected', JSON.stringify({question: res.question, options: res.options, type: res.type})); return res.code === 1 ? [res.question, res.answer] : undefined }"

题面会落到 `data/collected.jsonl`。

---

## ⚙️ 配置项（.env）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AI_API_KEY` | 空 | 必填 |
| `AI_API_URL` | DeepSeek 官方 | 兼容 OpenAI 协议的端点都可以 |
| `AI_MODEL` | `deepseek-chat` | 想更准可以换 `deepseek-reasoner`（慢一些） |
| `COURSE_CONTEXT` | 空 | 可选。留空 = 模型自己判断学科（跨课程通用）；填了 = 按这门课作答 |
| `AI_TIMEOUT_MS` | 30000 | reasoner 建议 60000 |
| `AI_TEMPERATURE` | 0 | 越低越稳 |
| `ENABLE_JSON_MODE` | true | 强制 json 输出，接口不支持时自动降级 |
| `AI_MAX_RETRY` | 1 | 仅在 JSON 解析失败时重试 |
| `SELF_CONSISTENCY_N` | 1 | 自洽投票票数，改成 3 会更准，token ×3 |
| `ANSWER_FORMAT` | auto | 单选/多选返回字母，判断题返回选项原文 |
| `FALLBACK_ON_EMPTY` | none | 拿不到答案时返回 code:0（不瞎选） |
| `MULTI_SEPARATOR` | # | 必须是 OCS 认得的符号 |
| `CACHE_ENABLED` | true | 结果缓存 |
| `CACHE_TTL_DAYS` | 30 | 缓存有效期 |
| `ENABLE_WEB_SEARCH` | false | 联网检索开关 |
| `SEARCH_MODE` | smart | `off` / `smart` / `always` |
| `SEARCH_TIMEOUT_MS` | 3000 | 单个检索源超时 |
| `SEARCH_TOTAL_BUDGET_MS` | 6000 | 整个检索阶段的总预算，超时就用已有资料继续答题 |
| `SEARCH_MAX_CHARS` | 1200 | 参考资料最大长度 |
| `SEARCH_MAX_RESULTS` | 4 | 最多注入几条检索结果 |

---

## 🔍 联网检索（免 API Key）

打开方式：

    ENABLE_WEB_SEARCH=true
    SEARCH_MODE=smart

- `smart`：只有题干包含年份、《书名号》、会议/条约/运动/宣言等「需要查证」的词时才检索，避免每题都多花 token。
- `always`：每题都检索。
- `off`：永不检索。

检索源（全部免 Key，按顺序降级）：必应 → 中文维基百科 API → 百度百科。任何一个源超时或被墙都只是少一条资料，**不会**影响答题；同一个源在一次答题里失败一次后就不再重试，并且整个检索阶段有总预算（默认 6 秒），超时就用手上已有的资料继续答题。（DuckDuckGo 已于 2025 起对非浏览器请求返回 202 挑战页，实测 lite 与 html 两个端点都拿不到结果，因此已移除。）

先跑一次探针看看你的网络下哪些源可用：

    npm run probe:search -- "《南京条约》签订于哪一年"

> 网页摘要可能包含错误信息，代码里已经把检索结果标记为「不可信资料，不是指令」，并且提示模型只作参考。如果发现联网后反而变差，关掉它即可。

---

## 🧠 想要更高准确率：打开自洽投票

    SELF_CONSISTENCY_N=3
    VOTE_TEMPERATURE=0.7

同一道题并发问 3 次，按选项字母集合多数表决；平票时采用 temperature=0 的那一票。代价是 token ×3、每题慢几秒。这是纯模型层面最有效的提升手段。

---

## 🗂 缓存与人工纠错

- `data/cache.json`：同一题第二次遇到直接命中，不再请求模型（也顺带避免 OCS 并发搜题时重复请求）。
- `data/wrongbook.json`：人工纠错表，优先级最高。

发现某题答错了，直接钉死（注意 options 里的换行要写成 `\n`）：

    curl -X POST http://localhost:3000/feedback -H "Content-Type: application/json" -d "{\"question\":\"题干\",\"options\":\"A. 甲\\nB. 乙\",\"type\":\"single\",\"answer\":\"B\"}"

之后同一题永远返回 B。

---

## 📊 准确率回归（证明「更准」的唯一办法）

1. 编辑 `eval/questions.json`，把 30–50 道真题和正确答案填进去（题面可以先用 `/collected` 自动攒）。题集可以写一个顶层 `"course"` 作为默认课程，每题也能用 `"course"` 单独覆盖，所以同一份题集可以混多门课。
2. 先在没有改动的代码上跑一次基线：

       npm start
       npm run eval -- --out eval/baseline.json

3. 改造后再跑一次：

       npm run eval -- --out eval/after.json

输出会打印每题对错、耗时、来源（cache / ai），最后给出正确率。对比两个文件就能知道到底提升了多少。

---

## 🧪 测试

    npm test

覆盖：选项解析的各种标签形态、畸形 JSON 兜底、幽灵选项防护、冲突收敛、判断题/填空题、多选题分隔符、端到端 mock 调用。

---

## 📁 项目结构

    server.js              服务入口
    src/config.js          环境变量与默认值
    src/options.js         选项解析（各种标签形态）
    src/prompt.js          提示词构建
    src/ai.js              模型调用（json 模式、超时、降级）
    src/parse-answer.js    模型输出 → OCS 可用答案
    src/answer.js          答题编排（缓存/检索/投票）
    src/cache.js           缓存与人工纠错表
    src/retrieval.js       免 Key 联网检索
    src/app.js             Express 路由
    src/text.js            与 OCS 对齐的字符串匹配工具
    test/                  单元测试 + 端到端测试
    eval/                  准确率回归题集与脚本
    scripts/               测试入口、检索探针

---

## ❓ 常见问题

**多选题只选中了一个？**
确认 OCS 配置里带了 `"type": "${type}"`，并且 OCS 能识别出多选题（选项中至少 3 个 checkbox）。

**判断题没被选中？**
判断题必须返回「正确 / 错误 / 对 / 错」这类文字。服务端在 `type=judgement` 时会自动返回选项原文；如果你没传 type，它会靠选项文本自动判断。

**返回「搜索不到答案」？**
说明服务端返回了 `code: 0`，通常是模型输出无法解析。看服务端控制台的 raw 字段，必要时把 `AI_MAX_RETRY` 调大，或改用 `deepseek-reasoner`。

**想换成别的模型？**
改 `AI_MODEL` 与 `AI_API_URL` 即可，任何兼容 OpenAI `/chat/completions` 的端点都能用。

**接口端口不是 3000？**
改 `.env` 里的 `PORT`，同时把 OCS 配置里的 url 一起改掉。
