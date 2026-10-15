# OCS ↔ 题库服务 接口契约（源码级考证）

> 本文不是猜测，全部结论都有 OCS 源码出处。目的是把"OCS 到底发什么、怎么收"
> 钉死，让新项目每一处设计都有依据，而不是靠试错。
>
> 源码：`github.com/ocsjs/ocsjs`。

---

## 〇、版本核对：4.0 与 5.x 的差异（按用户实际版本 5.2.1 校准）

第一版考证基于 `4.0` 分支。得知实际使用版本是 **5.2.1** 后，重新拉取 `5.0` 分支逐文件对比。
结论如下——**核心匹配算法两版完全一致，差异集中在"收什么"而非"怎么匹配"。**

### 逐字节相同的文件（§3、§5 的全部结论对 5.2.1 成立）

| 文件 | 内容 |
| --- | --- |
| `core/worker/utils.ts` | `splitAnswer`、`isPlainAnswer`、`resolvePlainAnswer`、`isProgramAnswer`、`defaultWorkTypeResolver` |
| `core/utils/string.ts` | `clearString`、`normalizeString`、`answerNormalizedMatch`、`answerSimilar`、`removeRedundant` |
| `core/worker/resolvers/single.ts` | 单选四阶段匹配 |
| `core/worker/resolvers/multiple.ts` | 多选匹配 + 领先度消歧 |
| `core/worker/resolvers/judgement.ts` | 判断题关键词匹配 |
| `core/worker/resolvers/completion.ts` | 填空题段数校验 |

> 所以"回写格式怎么选"这件事，4.0 的考证对 5.2.1 **直接适用**，
> `src/ocs/matcher.js` 的移植也不需要改。

### 有差异的文件（3 个）

**1. `answer-wrapper/answer.wrapper.handler.ts`（+36 行）——新增图片题字段**

```js
env.title defaults to ''
env.options ?= ''
if (env.type === undefined) env.type = 'unknown'      // ← 5.x 在此兜底
env.images ?= []
env.suggestion_title ?= ''
env.suggestion_options ?= ''
```
另外：POST 若未显式给 `Content-Type` 会默认 `application/json`；
`responseType` 可与 `contentType` 分开指定。

**2. `worker/question.resolver.ts`（+15 行）——选项文本改由调用方提供**

新增 `optionText?: (el, i) => string` 参数，注释写明原因：
"图片题等场景下 innerText 无法获取 img 的 URL，需由调用方通过 DOM 遍历提供"。

**3. `worker/worker.ts`（130 行差异）——`ctx.type` 为假时给出明确错误**

```js
if (result.ctx.type) {
  const resolver = createDefaultQuestionResolver(result.ctx, this.opts.work.optionText)[result.ctx.type];
  ...
} else {
  error = '题目类型解析失败, 请自行提供解析器, 或者忽略此题。';   // ← 5.x 新增的明确提示
}
```

**这条非常重要**：见 §8。

---

## 一、OCS 发给我们什么：**基础只有 3 个字段**（图片字段需显式声明）

### 1.1 权威拼装点

各平台的答题器都这样构造请求（`packages/scripts/src/projects/icourse.ts:512`、`zhs.ts:2645`，其余平台同构）：

```js
answerer: (elements, ctx) => {
  const title = titleTransform(elements.title);
  if (title) {
    return searchAnswerInCaches(title, async () => {
      return defaultAnswerWrapperHandler(answererWrappers, {
        type: ctx.type || 'unknown',
        title,
        options: ctx.elements.options.map((o) => o.innerText).join('\n')
      });
    });
  }
}
```

所以送到我们这里的 `env` **只有三项**：

| 字段 | 实际取值 | 可能为空 | 说明 |
| --- | --- | --- | --- |
| `title` | 题干字符串 | 否（为空则 OCS 直接抛错，不会发请求） | 已做空白归一化，见 1.3 |
| `options` | **单个字符串**，各选项 `innerText` 用 `\n` 拼接 | **是**（填空题为空串） | 保留了原始缩进与尾随空格 |
| `type` | `single` / `multiple` / `judgement` / `completion` | **经常是字符串 `"unknown"`** | 见 1.2 |

**没有**题目 ID、课程名、章节、平台名、题号、选项数量、填空框数量、图片地址。
这些 OCS 自己知道，但**不在请求里**。

### 1.2 `type` 经常是字面量 `"unknown"`——不要依赖它

注意那句 `type: ctx.type || 'unknown'`：**是 OCS 自己兜底成字符串 `'unknown'`**，不是字段缺失。

`ctx.type` 来自各平台的 `work.type(ctx)` 解析器，例如 `zhs.ts` 是去读页面上的
`.subject_type` 文本里有没有"单选题/多选题"；找不到就返回 `undefined` → 变成 `"unknown"`。

实测印证（本仓库 `ocs-ai-answer-service-test/logs/` 共 99 条真实请求）：

| OCS 传来的 `type` | 条数 |
| --- | --- |
| `unknown` | 77 |
| `single` | 16 |
| `multiple` | 2 |
| `judgement` | 2 |
| `completion` | 2 |

**最近一整批 22 题全是 `unknown`。** 结论：题型必须能从题干+选项**自己推**，
`type` 只能当"有则采信"的提示。

### 1.3 `title` 被 OCS 改写过

`titleTransform`（`icourse.ts:482`）做了这些事：

```js
titles.filter(t => t?.innerText || t?.querySelector('img'))
  .map(t => optimizationElementWithImage(t, true).textContent.replace(/\s+/g, ' ').trim())
  .join(',')                                  // 多个标题元素用英文逗号拼接
  .replace(/[\u200A-\u200F]/g, '')            // 去掉不可见空白
// 再过一遍 removeRedundantWords(用户自定义的冗余词表)
```

三个要点：
1. **所有空白被压成单个空格**，所以题干里不会有换行、连续空格。
2. 多个标题元素会**用 `,` 拼在一起**（实测本仓库数据未出现，但存在可能）。
3. **图片会被替换成 `img.src` 的 URL 文本**（`utils/work.ts:187` 的 `optimizationElementWithImage`，
   把 `<span style="font-size:0px">` 插到图片后面）。所以**题干里出现 `http(s)://...png/jpg`
   就意味着这是一道图片题**。实测本仓库 99 条里 0 条含图片；但 `icourse` 平台会有。

### 1.4 `options` 的真实形态

因为就是 `innerText` 直接 `join('\n')`，所以：

- **保留了缩进和尾随空格**。实测行首空格分布 `{0:62, 2:169, 4:80}`，
  行尾空格最多见过 19 个。
- **通常自带字母前缀**。实测 97/99 的选项形如 `"    A. 白崇禧   "`。
- 实测选项行数分布：`{0:2, 2:36, 3:6, 4:54, 5:1}` —— 2 行是判断题，
  4 行是常规单选/多选，5 行是真 A–E 五选项（已逐条核对，不是多行选项被拆错）。

> ⚠️ **一个真实隐患**：OCS 那边的选项是**按 DOM 元素**划分的，而给我们的是
> **用 `\n` 拼起来的**。如果某个选项的 `innerText` 内部含换行（如计算机题的代码选项），
> 我们 `split('\n')` 得到的条数就会**多于** OCS 的选项数，**后面所有字母索引全部错位**。
> 本仓库数据未触发，但这正是"不要依赖字母、要回选项文本"的决定性理由（见第四节）。

---

## 二、我们回给 OCS 什么

### 2.1 传输格式

`handler` 用 `new Function` 解析，返回**一维或二维数组**：

```js
"handler": "return (res)=> res.code === 1 ? [res.question, res.answer] : undefined"
```

- 一维 `[题目, 答案]`
- 二维 `[[题目1,答案1],[题目2,答案2],...]`（同一题多个候选，OCS 会都拿去匹配）
- 搜不到：返回 `undefined`，或 `[提示文本, undefined]` 让 OCS 显示提示
- 题目可以返回 `undefined`，OCS 会自动用自己搜索的题干显示

源码里做了保护（`answer.wrapper.handler.ts`）：
```js
info.every(item => Array.isArray(item)) ? 二维 : 一维
```
`answer` **必须是字符串**——下游 `splitAnswer` 会直接 `answer.trim()`，传数组会抛异常。

### 2.2 多答案的分隔协议：**优先用 JSON 数组字符串**

`splitAnswer`（`worker/utils.ts:139`）的实现顺序很关键：

```js
export function splitAnswer(answer, separators = ['===','#','---','###','|',';','；']) {
  answer = answer.trim();
  if (answer.length === 0) return [];
  if (isProgramAnswer(answer)) {
    separators = separators.filter(el => el !== ';' && el !== '|' && el !== '；');
  }
  try {
    const json = JSON.parse(answer);
    if (Array.isArray(json)) {
      return json.map(String).map(el => el.trim()).filter(el => el.length > 0);
    }
  } catch {
    for (const sep of separators) {
      if (answer.split(sep).length > 1) {
        return answer.split(sep).map(el => el.trim()).filter(el => el.length > 0);
      }
    }
  }
  return [answer];
}
```

**它第一步就尝试 `JSON.parse`。** 所以：

> 返回 `'["白崇禧","陈诚"]'` 这样的 **JSON 数组字符串**，会被精确还原成数组，
> **完全绕开分隔符歧义**。这比 `A#B` 或 `文本#文本` 都更稳——
> 后者一旦选项文本里含 `#`、`|`、`;`、`；`，就会被切碎（计算机类题目很常见）。

注意 `isProgramAnswer` 只在**含** `;`/`|`/`；` 时才影响分隔符列表，
且 JSON 分支不使用分隔符，所以两者不冲突。

---

## 三、OCS 怎么把我们的答案匹配到选项上

这是整个契约里最容易被忽略、却决定成败的部分。**OCS 的匹配是文本匹配，字母只是最后的兜底。**

### 3.1 单选题 `resolveSingle`（`resolvers/single.ts`）

四阶段，**按顺序短路**：

| 阶段 | 做法 | 关键条件 |
| --- | --- | --- |
| 1 | 归一化精确匹配 | 去标点/空格/全角后，**答案 ⊇ 选项** 或相等 |
| 2 | 相似度匹配 | 取相似度最高者，且 **> 0.6** |
| 3 | **纯 ABCD 兜底** | 去 `[,，.。．、 #]` 后若是严格递增不重复的 A–Z，且**长度==1** |
| 4 | 多片段合并 | 答案被拆成多段时合并后重跑 |

阶段 3 是字母方案唯一的活路，**排在文本匹配之后**。

### 3.2 多选题 `resolveMultiple`（`resolvers/multiple.ts`）

| 阶段 | 做法 |
| --- | --- |
| 1 | 归一化匹配，**严格方向：答案 ⊇ 选项**（刻意不取"选项⊇答案"，避免 `TCP` 误选 `TCP/IP协议`）+ 领先度消歧 |
| 2 | 相似度 **> 0.6** + 领先度消歧 |
| 3 | 纯 ABCD 兜底 |

`disambiguateSimilarOptions`：两个候选选项文本相似度 > 0.6 时**只保留匹配度更高的那个**，
用来解决"一字之差的选项被全选"。

### 3.3 判断题 `resolveJudgement`：**字母在这里根本不通**

```js
const CORRECT_WORDS   = ['是','对','正确','确定','√','对的','是的','正确的','true','True','T','yes','1'];
const INCORRECT_WORDS = ['非','否','错','错误','×','X','错的','不对','不正确的','不正确','不是','不是的','false','False','F','no','0'];
```

逻辑是：答案命中正确词表 → 在选项里找同样命中正确词表的那个；错词表同理。
**没有纯 ABCD 兜底。**

> 🔴 所以判断题返回字母 `"A"` 会**直接匹配失败**（`finish: false`，OCS 显示搜不到）。
> 判断题**必须返回"正确/错误/对/错"这类文本**。
> 另外 `question.resolver.ts` 里单选题也会先做 `isJudgementOptions` 检查——
> 两个选项恰好是"对/错"性质的单选题，走的也是判断题逻辑。

### 3.4 填空题 `resolveCompletion`：答案段数必须等于空格数

```js
resolveCompletion(answerGroups, options.length, ctx.answerSeparators)
```

- 答案段数 **== 填空框数** → 命中
- 或 **填空框数 == 1** → 把所有答案拼成一段
- 否则不命中

`options.length` 是**空格数量**（OCS 从 DOM 数出来的），而我们收到的 `options` 是拼接后的字符串，
**填空题时通常还是空串** —— 所以我们**拿不到空格数**。

> 🔴 多空填空题我们无法可靠作答，除非用自定义 handler 从 DOM 里数出来（见第四节）。

---

## 四、我们还能额外拿到什么：自定义 `data.handler`

`data` 里的字段可以写成对象 + `handler`，用 `new Function` 在**页面上下文**执行，
第一个参数是 `env`（只有 `{title, options, type}`），但**作用域里能访问 `document`、`window`、`localStorage`**。

`answer.wrapper.handler.ts` 原文：
```js
if (typeof wrapperData[key] === 'object' && Reflect.has(wrapperData[key], 'handler')) {
  const handler = Function(wrapperData[key].handler)();
  const result = handler(env);          // ← env 只有 title/options/type
  Reflect.set(data, key, result);
}
```

**这意味着页面 DOM 才是真正的第四、第五个信息源。** 实测可行的补充：

| 想补的信息 | 思路 |
| --- | --- |
| 真实题型 | 复刻 `defaultWorkTypeResolver`：数 `[type=radio]` / `[type=checkbox]` / `textarea` |
| 填空框数量 | 数页面上的填空输入框 |
| 课程名 | 从 `document.title` 或某个选择器取，读 `localStorage` |
| 当前页 URL / 平台 | `location.host` |
| 题号/进度 | 从题目容器索引推 |

注意限制：
- `${xxx}` 占位符**只有** `${title}`、`${type}`、`${options}` 三个；其它占位符不会被替换（保持字面量）。
- handler 是在**用户浏览器**里跑的，选择器随平台改版会失效，**必须容错**（取不到就给空值，不能抛错）。
- handler 返回的值会原样进请求体，所以给服务端的是"字符串/数字"。

---

### 4.1 OCS 5.x 原生图片题优化（我原来手搓的东西，5.2.1 自带）

这是 5.x 相对 4.0 最大的新增能力，直接改变图片题的处理方式。

**新增 3 个 env 字段**（权威来源：`packages/scripts/src/utils/answerer-env.ts` 的 `buildAnswererEnv`）：

| 字段 | 内容 |
| --- | --- |
| `images` | **base64 data URL 数组**，顺序对应 `[图片1]`、`[图片2]`… |
| `suggestion_title` | 原题干中图片 URL 被替换成 `[图片N]` 占位符后的文本 |
| `suggestion_options` | 原选项中图片 URL 被替换成 `[图片N]` 占位符后的文本 |

**关键：这是 opt-in，必须在题库配置里显式引用才会收到。**

```js
const env = { type: params.type || 'unknown', title: params.title, options };
if (params.enableImageOptimize) { /* 才去构造 env.images / suggestion_* */ }
```

判定函数 `isAnswererWrapperSupportImageOptimize` 要求**同时满足**：

1. **`method` 必须是 `post`** —— base64 数组装不进 GET 的 URL 查询串；
2. `data` 里**实际引用了**这三个字段之一：字符串字段含 `${images}` / `${suggestion_title}` /
   `${suggestion_options}` 占位符，**或**某个 `handler` 的源码里出现 `env.images` 之类引用。

OCS 会在面板上提示"建议更新题库配置"，但不做任何强制——旧配置只是收不到图片，不会报错。

**OCS 侧为我们做掉的那些脏活**（都在 `answerer-env.ts` / `png-upscaler.ts`）：

- 浏览器里优先用 **Canvas** 转 base64（图片已带认证信息加载，能绕过防盗链）；
- Canvas 被跨域污染时回退 **GM_xmlhttpRequest**；
- Node 环境用 `node-fetch` 拉取，并带上 `Referer` + `User-Agent`
  （注释里明确写了是为绕过 **chaoxing 403**）；
- **PNG 放大**（`upscalePngDataUrl`）——针对公式图这类小图；
- **会话级 LRU 缓存**（200 条），因为同一份试卷里公式图常在多题间复用。

**对新项目的含义**：

> 图片题不要自己从题干里正则抠 `img.src` 再去下载。**优先用 OCS 5.x 直传的 base64**：
> 不需要模型端去 fetch（避免防盗链和网络问题），也不需要自己实现转码与放大。
> `src/ingest.js` 同时支持两条路线，有 `images` 就用 base64，没有才退回 URL。

### 4.2 选项文本会被 `dedupeLines` 去重

5.x 的 `buildAnswererEnv` 里有 `const options = dedupeLines(rawOptions);`——
**选项里重复的行会被去掉**。所以服务端收到的 `options` 可能比页面上的选项元素少，
进一步印证了 §1.4 的结论：**不要依赖字母索引，要以文本为主**。

---

## 五、由契约推出的设计结论

这七条是后面所有设计的依据：

1. **不要依赖 `type`** —— 77/99 是 `unknown`。题型要能从题干+选项自己推。
2. **回写要「文本」和「字母」两条路都准备，用 OCS 算法自检决定用哪条。**
   - 文本走阶段 1/2（最强路径），但对**符号型选项会失效**：见 §5.1；
   - 字母走阶段 3 兜底，恰好能救符号型选项；
   - 所以不能二选一，必须**先试文本、跑一遍 OCS 匹配算法自检、不过再退字母**（`src/emit.js` 就是这么做的）。
   - 字母方案本身还有个硬约束：正确性依赖"我们对选项的切分与 OCS 完全一致"，
     而多行选项会让它错位（§1.4）——所以字母只当兜底，不当默认。
3. **多选题答案优先用 JSON 数组字符串**（`'["A文本","B文本"]'`），
   因为 `splitAnswer` 第一步就 `JSON.parse`，彻底避开分隔符歧义。
   但它同样受 §5.1 的符号问题影响，同样要靠自检兜底。
4. **判断题必须返回文本**，返回字母必然失败（§3.3，已实测固化）。
5. **单选题只返回 1 个元素**（阶段 1 会取第一个命中，多给会误伤）。
6. **多选题字母必须升序且不重复**（`isPlainAnswer` 要求严格递增；`'BA'` 会判 false，已实测）。
7. **多空填空题我们信息不足**，需要靠自定义 handler 补填空框数量；补不到就不作答（返回 `code:0`，让 OCS 提示"搜不到"），**绝不瞎填**。
8. **图片题用 OCS 5.x 直传的 base64**（§4.1），不要自己从题干抠 URL 再下载。
   代价是要在题库配置里显式声明 `${images}` / `${suggestion_title}`，且必须用 POST。
9. **选项文本可能被 `dedupeLines` 去重**（§4.2），所以字母索引更加不可靠——再次印证结论 2。

### 5.1 关键补充：符号型选项会击穿文本匹配（实测）

OCS 的 `removeRedundant` + `normalizeString` 会**破坏符号型选项的语义**。实测：

```
'A. --'     → removeRedundant → "a"     → normalizeString → "a"
'B. /* */'  → removeRedundant → "b"     → normalizeString → "b"
'C. #'      → removeRedundant → "c"     → normalizeString → "c"
'D. //'     → removeRedundant → "d"     → normalizeString → "d"

单选回文本 "--" : {"finish":false}                 ← 失败
单选回字母 "A"  : {"finish":true,"option":"A. --"}  ← 成功
```

原因：`removeRedundant` 的正则 `^[A-Z][^A-Za-z0-9⺀-鿿]+([A-Za-z0-9⺀-鿿]+)`
只捕获标签后的**第一个字母数字串**，所以 `A. --` 被替换成了 `a`，选项正文丢失。
而 `normalizeString` 会把 `--` 整个剥掉变成空串，导致文本路径彻底匹配不上。

另一个形态是**选项文本归一化后变得完全相同**，触发 `disambiguateSimilarOptions` 把多个选项消歧成一个：

```
选项 A. a#b / B. a|b / C. a;b  →  normalizeString 后全都是 "ab"
disambiguateSimilarOptions(...) → ["A. a#b"]      ← 只剩一个
```

**这是 OCS 侧的缺陷，改答案格式救不了**，只能靠"试文本→自检→退字母"兜住。
这类题目在计算机/数学课程里很常见（SQL 注释、运算符、公式），所以自检不是锦上添花，是必需品。

### 5.2 意外发现：回写**带上原始标签**反而更稳

既然 `removeRedundant` 会把 `A. --` 变成 `a`，那如果我们回写时**也带上标签**，
这个 mangling 就会**同等施加于答案和选项两侧，相互抵消**：

```
选项  'A. --'      → removeRedundant → 'a'
答案  'A. --'      → removeRedundant → 'a'   → 精确匹配（level 2）成立 ✓
答案  '--'         → removeRedundant → '--'  → normalizeString → ''  → 匹配失败 ✗
```

所以 `src/emit.js` 的候选顺序是 **`text`（纯选项正文）→ `raw`（带标签原文）→ `letter`（字母）**，
逐级用 OCS 算法自检。实测 SQL 注释题就是靠 `raw` 这一级救回来的。

这条也说明为什么"回写格式"不能靠推理定死，**必须让 OCS 自己的算法来当裁判**。

---

## 六、推荐的 OCS 题库配置（面向 5.2.1，含图片题优化）

见项目根目录的 [`ocs-config.json`](../ocs-config.json)，可直接粘贴。要点：

```json
{
  "method": "post",
  "data": {
    "title": "${title}",
    "type": "${type}",
    "options": "${options}",
    "suggestion_title": "${suggestion_title}",
    "suggestion_options": "${suggestion_options}",
    "images": { "handler": "return (env)=> env.images || []" },
    "dom": { "handler": "return (env)=> { ...location.host, radios, checks, textareas... }" }
  },
  "handler": "return (res)=> res.code === 1 ? [undefined, res.answer] : [res.msg, undefined]"
}
```

说明：

- **`method` 必须是 `post`**，否则 OCS 不会启用图片题优化（§4.1）。
- `suggestion_*` 用字符串占位符；`images` 是数组，用 `handler` 直接返回原值
  （源码里 handler 的返回值是 `Reflect.set(data, key, result)`，数组可直接放）。
  该 handler 里出现 `env.images` 也正好满足 OCS 的图片优化判定。
- **`dom` 字段是关键增强**：OCS 官方只给基础字段，但 `data` 里的 `handler` 在**页面上下文**执行，
  能从 DOM 数出单选框/复选框/文本框数量，用来把题型判准、拿到填空题空格数。
  取不到就返回空串，服务端会容错。
- **`question` 故意不传**，让 OCS 显示它自己的题干，避免回显造成视觉噪音。
- 搜不到时返回 `[res.msg, undefined]`，OCS 会把提示显示给用户。

配置里的域名记得加进脚本的 `@connect`，或把 `@connect 模式` 设为宽松。
`localhost:3000` 和 `127.0.0.1:3000` 不是一回事，配置里统一用哪个就测哪个。

---

## 七、还有一件事：OCS 自己有答案缓存

`answerer` 里包了一层 `searchAnswerInCaches(title, ...)`。**OCS 会按 `title` 缓存答案。**
所以同一道题第二次遇到时**根本不会请求我们的服务**。

含义：
- 我们服务端的缓存和 OCS 的缓存是**两层**，且 OCS 那层更靠前；
- 改 prompt / 换模型后，**旧答案会被 OCS 的缓存挡住**，需要清 OCS 缓存才能看到效果；
- 做 A/B 评测时务必注意这一点，否则会得出"改了没效果"的错误结论。

---

## 八、`ctx.type` 为假时，OCS 根本不会填答案

**这是最容易被误判为"模型答错了"的一条。**

OCS 5.x 的 `worker.ts` 里，答案处理器的派发是有条件的：

```js
if (result.ctx.type) {
  const resolver = createDefaultQuestionResolver(result.ctx, this.opts.work.optionText)[result.ctx.type];
  res = await resolver(result.ctx.searchInfos, result.ctx.elements.options, handler);
} else {
  error = '题目类型解析失败, 请自行提供解析器, 或者忽略此题。';   // ← 5.x 的明确报错
}
```

而 `ctx.type` 来自 `work.type(ctx)`，没有自定义解析器时走 `defaultWorkTypeResolver`：

```js
return count('[type="radio"]') === 2 ? 'judgement'
  : count('[type="radio"]') > 2   ? 'single'
  : count('[type="checkbox"]') > 2 ? 'multiple'
  : count('textarea') >= 1         ? 'completion'
  : undefined;                     // ← 顺序不对/选择器不匹配就落到这里
```

`count` 是在**每个选项元素内部**找输入控件。如果平台的选项元素不包裹 input，
计数就是 0 → `ctx.type` 为 `undefined`。

**后果链条**：

```
ctx.type === undefined
  → 发给题库的 type 变成字符串 'unknown'      （answer.wrapper.handler.ts 兜底）
  → 题库正常作答并返回答案
  → 但 worker.ts 的 if (ctx.type) 不成立
  → 答案处理器根本不运行 → 页面上的选项不会被选中
  → 用户在 OCS 面板看到「题目类型解析失败, 请自行提供解析器, 或者忽略此题」
```

**实测佐证**：本仓库旧日志 99 条请求里 **77 条** `type` 是 `unknown`，
即这些题目 OCS 大概率先报了上面那句错，答案算了也没填进去。

**这是 OCS 侧的问题，题库服务改不了。** 服务端能做的只有：
不要假设 `ctx.type` 一定有值，把题型自己推准（本项目 `src/ingest.js` 的做法）。

**排查方法**：看 OCS 面板/控制台有没有那句"题目类型解析失败"；
或者刷一道 `type=unknown` 的题，观察页面选项有没有被自动选中。
若确实如此，需要在 OCS 侧为该平台提供 `work.type` 解析器，或让选项选择器包住 input。
