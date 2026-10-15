# ocs-answer-engine

OCS（网课脚本）的 AI 答题引擎，**从零重构**，不是旧项目的补丁。

旧项目的问题不是模型不够强，而是**设计前提是猜的**：猜 OCS 发什么、猜答案格式、
猜题型怎么判。这个项目换了做法——先把 OCS 的接口契约从源码里挖出来钉死，
再让每一个设计决策都有出处。完整考证见 **[docs/OCS-CONTRACT.md](docs/OCS-CONTRACT.md)**。

---

## 这个项目与旧项目的根本差别

| | 旧项目 | 本项目 |
| --- | --- | --- |
| OCS 发什么 | 靠试错，日志只记了 4 个字段 | 源码级考证：**只有 title / options / type 三个字段** |
| 题型来源 | 依赖 `${type}` | **不依赖**（实测 77/99 是字符串 `"unknown"`），自己推 |
| 回写格式 | 回字母 `A#B` | **回选项原文**，多选用 JSON 数组字符串 |
| 格式正确性 | 靠人肉踩坑 | **从 OCS 源码移植匹配算法，回写前自动自检** |
| 判断题 | 回字母会失效 | 明确回文本（判断题只有关键词匹配） |
| 多空填空 | 瞎填 | 拿不到空格数就**拒绝作答** |
| 依赖 | express + axios + dotenv | **零 npm 依赖**，只用 Node 内置模块 |

---

## 第一步：先只看，不答题

这是本项目最重要的设计——**别急着让模型答题，先花半小时看清 OCS 到底发什么。**

```bash
cp .env.example .env      # 保持 SOLVE_ENABLED=false 即可，不需要 API Key
npm start
```

把 OCS 题库配置成指向本服务（见下方"OCS 配置"），然后正常刷几道题。之后：

```bash
# OCS 一共发来哪些字段、各出现多少次、样例是什么
curl -s http://127.0.0.1:3000/capture/profile | python3 -m json.tool

# 最近收到的原始报文（含 headers、query、body 原文）
curl -s "http://127.0.0.1:3000/capture/recent?limit=5" | python3 -m json.tool
```

原始报文落在 `data/capture.jsonl`。**这一步不需要任何 API Key，也不花一分钱。**

`/capture/profile` 会直接告出这类事实：

- 到底有哪些字段（如果 OCS 或你的配置多发了什么，这里立刻看得见）
- `type` 的真实分布（`unknown` 占多少）
- 每个字段的样例值

## 第二步：打开作答

```bash
SOLVE_ENABLED=true
AI_API_KEY=sk-xxx
AI_API_URL=https://api.deepseek.com/v1/chat/completions
AI_MODEL=deepseek-chat
```

---

## OCS 题库配置

直接粘贴根目录的 **[ocs-config.json](ocs-config.json)**。它是按 **OCS 5.2.1** 校准的：

```json
[
  {
    "name": "AI 本地题库",
    "url": "http://localhost:3000/answer",
    "method": "post",
    "contentType": "json",
    "type": "GM_xmlhttpRequest",
    "headers": { "Content-Type": "application/json" },
    "data": {
      "title": "${title}",
      "type": "${type}",
      "options": "${options}",
      "suggestion_title": "${suggestion_title}",
      "suggestion_options": "${suggestion_options}",
      "images": { "handler": "return (env)=> env.images || []" },
      "dom": { "handler": "return (env)=> { /* location.host / radios / checks / textareas */ }" }
    },
    "handler": "return (res)=> res.code === 1 ? [undefined, res.answer] : [res.msg, undefined]"
  }
]
```

四个要点：

1. **`method` 必须是 `post`。** OCS 5.x 的图片题优化只在 POST 下启用——base64 图片数组装不进 GET 的 URL。
2. **`suggestion_title` / `suggestion_options` / `images` 是 5.x 的图片题字段，必须显式声明才会收到。**
   OCS 会把图片转成 base64 直传，并给出 `[图片N]` 占位符文本——**连同防盗链绕过、PNG 放大、会话级缓存一起做好了**。
   不声明也能用，只是收不到图片（退回从题干正则抠 URL，会撞防盗链）。
3. **`dom` 是关键增强。** OCS 官方只给 `title`/`options`/`type`，但 `data` 里的 `handler` 在**页面上下文**执行，
   能从 DOM 数出单选框/复选框/文本框数量，用来把题型判准、以及拿到填空题的空格数。取不到就返回空串。
4. **`question` 故意不传**，让 OCS 显示它自己的题干，避免回显造成视觉噪音。

配置里的域名记得加进脚本的 `@connect`，或把 `@connect 模式` 设为宽松。
`localhost:3000` 和 `127.0.0.1:3000` 不是一回事，统一用一个。

---

## 目录结构

```
server.js              服务入口（启动卡片）
src/config.js          环境变量与默认值
src/capture.js         原始报文捕获 + 字段画像        ← 第一步用它
src/ingest.js          OCS 字段 → 结构化题目
src/solve.js           调大模型解题（流式 SSE）+ 降级 + 定向重问
src/reconcile.js       逐选项判定 ⇄ 最终答案 的对齐策略  ← 防"多选漏选"
src/emit.js            选中项 → OCS 答案协议 + 自检
src/ocs/matcher.js     从 OCS 源码移植的官方匹配算法   ← 格式正确性的依据
src/app.js             HTTP 路由（node:http，零依赖）
src/ui/                终端界面（width/theme/box/stream-view/render）← 可整体摘掉
scripts/demo.js        免 OCS 的界面预览（npm run demo）
test/                  168 个测试（含 OCS 匹配算法差分验证）
docs/OCS-CONTRACT.md   OCS 接口契约源码考证
docs/VERIFICATION.md   全部验证证据（含真实模型端到端实测）
data/capture.jsonl     原始报文（gitignore）
```

## 终端界面

每题一张卡片，下方流式显示"思考"与逐项判断，末尾一行结论：

```
╭─ #1 ───────────────────────────────── 单选 · 页面推断 ─╮
│ 抗战时期八路军牺牲的最高将领是（  ）                    │
│                                                         │
│   A  陈宇寰                                             │
│   B  左权                                               │
│   C  包森                                               │
│   D  洪麟阁                                             │
╰─────────────────────────────────────────────────────────╯
  · 思考
  八路军是第八路军。左权任副参谋长，1942 年在山西辽县牺牲。
  ✘ A  陈宇寰非八路军最高级别
  ✔ B  左权是八路军副参谋长
  ✘ C  包森级别较低
  ✘ D  洪麟阁非八路军
  ───────────────────────────────────────────────────────
  ✓ 答案 B · 左权        文本匹配 · 自检通过 · 1.7s
```

**先看效果，不需要 OCS 也不需要 API Key：**

```bash
npm run demo                      # 终端里直接看（有颜色）
npm run demo -- --plain           # 看纯文本样子
npm run demo -- --rich --nocolor  # 管道里也能看富界面布局
npm run demo -- --nodelay         # 不模拟流式延时
```

**开关**：`UI_STYLE=auto|rich|plain`、`UI_COLOR=auto|always|never`、`UI_WIDTH=0|数字`。

### 默认是"安全"的

`UI_STYLE=auto` 时，只有**是终端且 `TERM!=dumb`** 才启用富界面。也就是说：

- 管道 / 重定向到文件 / CI / 本机的 DSH 环境（`TERM=dumb`、`NO_COLOR=1`）→ **自动退回纯文本**，
  输出与加界面之前**逐字节一致**；
- 你在自己的终端里跑 → 自动变成卡片。

这一点有测试兜着（`test/ui.test.js` 里那条"plain 模式逐字节复刻"），
另外把基线提交导出成独立目录、用同一个 mock 端点跑同一道题做过 diff：
HTTP 响应与终端输出**全部逐字节相同**（仅 `elapsedMs` 是计时抖动）。

## 回退

界面是完全解耦的，三种粒度任选：

1. **临时关掉**（不删代码）：`.env` 里设 `UI_STYLE=plain`，行为立刻回到加 UI 之前。
2. **只关流式**：`AI_STREAM=false`，回到一次性请求（其余不变）。
3. **整体撤销**：这个目录在加界面之前打过基线提交，所以

```bash
cd ocs-answer-engine
git log --oneline                 # 找到 "baseline: 加入 UI 之前的纯净状态"
git diff <baseline>..HEAD --stat  # 先看清改了什么
git checkout <baseline> -- .      # 或 git reset --hard <baseline>
rm -rf src/ui scripts/demo.js test/ui.test.js   # 再删掉纯新增文件
```

改动只落在三处老代码里，都很小：`src/app.js`（输出语句换成 `block.*`）、
`src/solve.js`（新增流式函数与事件出口，**不传 opts 时行为不变**）、`server.js`（启动卡片）。
其余全是纯新增文件，删掉即无残留。

## 为什么要有 `src/reconcile.js`

模型被要求输出两样东西：逐个选项的 `verdict`（分析过程），和最终的 `answer`（结论）。
**两者不一致本身就是最强信号**，而且实测倾向很明确：47 道"单选多选未定"的题里 14 道实际是多选，
多选最主要的失分模式是**漏选**——判对了却没写进答案。

对齐策略按题型可信度分级：

- **OCS 明确说多选** → 用判定与答案的**并集**，把漏掉的补回来
- **OCS 明确说单选** → 坚持答案（单选多给会被 OCS 取第一个命中，风险更大）
- **题型未定且不一致** → 标记冲突，**触发一次定向重问**，专门追问有争议的选项

重问的采信门槛很保守：只在"给出更多正确项"或"已达成一致"时采纳，避免把答对的题改坏。

---

## 为什么要有 `src/ocs/matcher.js`

OCS 拿到我们的答案后，要**自己**把它匹配回页面上的选项。这套匹配算法是 OCS 内部的，
旧项目完全没考虑它——所以会出现"服务端返回了正确答案，页面上却没选中"的情况。

把 OCS 的匹配算法原样移植过来之后：

- **回写前自检**：`emit.js` 生成答案后，先跑一遍 OCS 算法，确认"这个字符串真的能选中我想选的那几个选项"，
  不通过就自动换下一种格式，全都不通过就交白卷，而不是发一个自以为对的字符串出去。
- **测试可断言**：可以写"我们的输出 → OCS 算法 → 必须选中预期选项"的端到端断言。

```bash
npm test
```

---

## 已知限制

### ⚠️ 最重要的一条：`type=unknown` 的题，OCS 可能根本不填答案

OCS 5.x 的 `worker.ts` 里，答案处理器的派发是有条件的：

```js
if (result.ctx.type) { ...运行答案处理器... }
else { error = '题目类型解析失败, 请自行提供解析器, 或者忽略此题。'; }
```

`ctx.type` 由 `defaultWorkTypeResolver` 在每个**选项元素内部**数 `input[type=radio]` 得出。
如果平台的选项元素不包裹 input，计数为 0 → `ctx.type` 为 `undefined`：

```
ctx.type 为 undefined
  → 发给题库的 type 变成字符串 'unknown'
  → 题库正常作答、返回答案
  → 但 if (ctx.type) 不成立 → 答案处理器不运行 → 页面选项不会被选中
  → OCS 面板显示「题目类型解析失败」
```

**实测佐证**：旧项目日志 99 条请求里 **77 条** `type` 是 `unknown`。

这是 OCS 侧的问题，题库服务改不了。服务端能做的只有不假设 `type` 有值、自己把题型推准
（`src/ingest.js` 就是这么做的——但那只能保证"答案正确"，不能保证"OCS 会填进去"）。

**请务必实测确认**：刷一道 `type=unknown` 的题，看页面选项有没有被自动选中、
OCS 面板有没有那句报错。若确实如此，需要在 OCS 侧为该平台提供 `work.type` 解析器。

### 其他限制

- **图片题**依赖 OCS 5.x 的 `${images}` 直传；未声明时退化为从题干抠 URL，可能撞防盗链。
- **多空填空题**依赖 `dom.textareas`；拿不到就拒绝作答（返回 `code:0`）。
- **计算机类题目有 OCS 侧缺陷**：`isProgramAnswer` 只取消 `;` `|` `；` 三个分隔符，
  `#` 仍是分隔符，所以 `#include <stdio.h>` 这种答案会被切开。
  本项目的回写自检能兜住（实测通过），但根因在 OCS。
- **OCS 有自己的答案缓存**（`searchAnswerInCaches`，按题干缓存）。
  改了 prompt 或换模型后，旧答案会被它挡住——评测前要清 OCS 缓存，否则会误判"改了没效果"。
- **版本基线**：契约文档核对过 OCS `4.0` 与 `5.0` 分支，核心匹配算法逐字节相同；
  实际使用版本为 **5.2.1**。若你升级后行为异常，优先复查 `docs/OCS-CONTRACT.md` §〇 列出的那 3 个变化文件。
