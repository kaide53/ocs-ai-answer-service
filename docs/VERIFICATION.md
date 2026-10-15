# 验证证据汇总

> 本文回答一个问题：**这个重构凭什么说它是可靠的？**
> 每一条都是实际跑出来的，附可复现的命令。

---

## 一、OCS 契约：源码级核对（不是猜的）

| 验证项 | 方法 | 结果 |
| --- | --- | --- |
| 发给我们哪些字段 | 读 `answerer-env.ts` 的 `buildAnswererEnv` | 基础只有 `type` / `title` / `options` |
| `type` 会是什么值 | 读 `answer.wrapper.handler.ts` | `if (env.type === undefined) env.type = 'unknown'` —— **兜底成字面量 `"unknown"`** |
| 真实分布 | 统计旧日志 99 条请求 | `unknown` **77** / single 16 / multiple 2 / judgement 2 / completion 2 |
| 回写怎么被匹配 | 读 4 个 resolver | 文本匹配优先，字母是阶段 3 兜底；判断题无字母兜底 |
| 多答案分隔符 | 读 `splitAnswer` | `['===','#','---','###','|',';','；']`，**且第一步先试 `JSON.parse`** |
| 4.0 与 5.x 是否一致 | `diff` 两分支的 9 个关键文件 | **6 个逐字节相同**（含全部匹配算法）；3 个有差异 |
| 5.x 新增能力 | 读 `answerer-env.ts` | `${images}` / `${suggestion_title}` / `${suggestion_options}` 图片题优化 |
| `ctx.type` 为假的后果 | 读 `worker.ts` | 报 `'题目类型解析失败, 请自行提供解析器, 或者忽略此题。'`，**答案处理器不运行** |

详见 [OCS-CONTRACT.md](OCS-CONTRACT.md)（含逐条源码出处）。

---

## 二、把 99 条真实 OCS 请求回放进新 `ingest`

```bash
# 数据源：../ocs-ai-answer-service-test/logs/answer-*.jsonl
node -e 'const {ingest}=require("./src/ingest"); /* 逐条 ingest 后汇总 */'
```

| 指标 | 结果 |
| --- | --- |
| 选项解析 vs 旧解析器 | **97 条逐条对比，0 不一致**（且新增多行选项兜底） |
| 判断题形态推断 vs 模型判定 | **27/28 = 96% 一致** |
| 多选信号词规则 | 召回率仅 **43%**（漏 8/14）→ **规则化不可行，必须让模型判** |
| 5 行选项 | 逐条核对确为真 A–E 五选项，不是多行被拆错 |

详见 [REPLAY-VALIDATION.md](REPLAY-VALIDATION.md)。

---

## 三、OCS 官方匹配算法：移植 + 差分验证

`src/ocs/matcher.js`（935 行，零依赖）从 OCS 源码移植。验证方式不是"看着像"：

> 用 esbuild 把 `/tmp/ocsjs` 里**真实的 OCS TypeScript**（`string.ts`、`worker/utils.ts`、
> 4 个 resolver）连同**真实的 `string-similarity@4.0.4`**（OCS 的 `pnpm-lock.yaml` 锁的版本）
> 编译成 CJS，对 **86,492 组**随机 + 定向用例逐一比对两个实现的深度相等结果。

**结果：0 失败。**

移植过程中固化下来的、与直觉不符的 OCS 行为（都写成了测试）：

- `removeRedundant('A、白崇禧')` → `'、白崇禧'`（`、` 是 U+3001，落在 `[\u2E80-\u9FFF]` 里剥不掉；`，`、`：`、`）` 能剥）
- `splitAnswer` 的 JSON 陷阱：`JSON.parse` 成功但**不是数组**时（`'123'`、`'"A#B"'`）既不返回也不进 catch，直接 `[answer]`，完全不按分隔符拆
- `isProgramAnswer` 只取消 `;` `|` `；`，**`#` 仍是分隔符** → `#include <stdio.h>` 会被切开
- `isPlainAnswer('BA')` → `false`（要求严格递增）；只校验 charCode，故 `'1A'`、`'A['` 也返回 `true`
- 判断题不解析字母：`resolveJudgement([['A']], ['正确','错误'])` → **`finish: false`**
- `defaultWorkTypeResolver`：`radioCount === 1` 既非 judgement 也非 single，落到 `undefined`

---

## 四、自动化测试：168 个

```bash
npm test     # → tests 168 / pass 168 / fail 0
```

| 文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `test/matcher.test.js` | 105 | OCS 匹配算法逐函数行为 + 全部边界 |
| `test/pipeline.test.js` | 22 | `ingest → emit → OCS 算法自检` 端到端断言 |
| `test/reconcile.test.js` | 13 | 逐选项判定 ⇄ 最终答案的对齐策略 |
| `test/ui.test.js` | 28 | 显示宽度/边框对齐/流式提取/plain 字节兼容/并发不交错 |

`pipeline.test.js` 是验收标准：**我们的输出 → OCS 官方算法 → 必须选中预期选项**。

### 终端界面（后加）的验证

| 验证项 | 方法 | 结果 |
| --- | --- | --- |
| 边框对齐 | 中文/全角/超长标题下，断言每行显示宽度完全相同 | 全部等宽（含 33 行实测） |
| **plain 模式不影响现有用法** | 把基线提交导出到独立目录，同一 mock 端点跑同一道题，`diff` 终端输出与 HTTP 响应 | **逐字节相同**（仅 `elapsedMs` 为计时抖动） |
| 流式提取器 | 同一段 JSON 按 1/2/3/7/13/64 字节切分喂入，断言还原结果一致 | 全部一致 |
| 中文跨 chunk | `TextDecoder({stream:true})`，在 UTF-8 多字节中间切断 | 无损还原 |
| `delta.reasoning_content` | 真实 HTTP 服务 + mock 先流 reasoning 再流 content | "思考"段落正确折行，判定顺序正确 |
| 端点忽略 `stream:true` | mock 返回普通 JSON（非 SSE） | 按 Content-Type 自动降级为一次性处理 |
| 并发不交错 | 交错触发两个块的事件，断言输出仍为两块连续文本 | 通过 |
| UI 自身异常 | 注入会抛错的 `write`、传入全 `null` 的题目 | 均不抛错到调用方 |

---

## 五、端到端演练（mock 端点）

用本地假端点验证全链路，不消耗额度：

| 场景 | 结果 |
| --- | --- |
| 单选（`type=unknown`，`dom.radios=4`） | 推成 `single`，回 `左权`，策略 `text`，自检通过 |
| 多选（模型乱序返回 `C,A,B`） | 排序后回 `["115师","120师","129师"]`，策略 `text-json`，自检通过 |
| 判断题（`type=unknown`，形态推断） | 回 `A. 正确`（**不是字母**），策略 `option-raw`，自检通过 |
| **多选含 `#` / `|` / `;` 的选项** | 文本路径被 OCS 的 `removeRedundant` 毁掉 → **自检发现** → 自动退到字母，仍选中全部 3 项 |
| **SQL 注释题 `A. --`** | 纯文本 `"--"` 归一化后变空串 → 自检发现 → 退到带标签原文 `A. --`，命中 |
| 代码题 `#include <stdio.h>` | `#` 会被 `splitAnswer` 切开 → 自检兜住，仍选中含 `#include` 的项 |
| 多空填空但无 `dom.textareas` | **拒绝作答**（`code:0`），不瞎填 |
| 题型未定 + 判定与答案冲突 | **触发定向重问**，漏掉的 C 被补回，`rechecked: true` |
| 上游连续两次 503 | 指数退避 383ms / 874ms 后第 3 次成功 |

---

## 六、真实模型端到端（deepseek-flash，真实图片）

唯一一次真实 API 调用，验证此前只是假设的多模态格式。

**方法**：用 Pillow 生成一张写着 `R1 = 42 ohm` 的图，按 OCS 5.x 的形态
（`suggestion_title` 带 `[图片1]` + `images` 为 base64）打进请求，答案必须读图才能得到。

```bash
SOLVE_ENABLED=true AI_MODEL=deepseek-flash AI_EFFORT=low node server.js
curl -X POST localhost:3000/answer --data-binary @payload.json
```

**结果**：

```json
{
  "code": 1,
  "answer": "42 欧姆",
  "meta": {
    "type": "single", "declaredType": "single",
    "subject": "电路/电工基础", "confidence": 0.98,
    "reconcileSource": "agree",
    "emitStrategy": "text", "emitVerified": true,
    "letters": ["B"],
    "usage": [{ "prompt_tokens": 746, "completion_tokens": 260, "total_tokens": 1006 }]
  },
  "elapsedMs": 1744
}
```

**一次性验证了 6 件事**：

1. 模型**确实看得见图**——正确读出图里的 `42`，选了 B
2. `effort: "low"` 被接口接受
3. `image_url` 用 base64 `data:` URL 的格式正确
4. `response_format: {type:'json_object'}` 生效（直接解析出 JSON）
5. 整条链路 `ingest → solve → reconcile → emit → OCS 算法自检` 全通
6. **延迟 1744ms**（旧项目同题量级 p50 5.5s、p90 24.8s）

模型能力元数据（`GET /v1/models` 实测）：

| 模型 | 输入模态 | effort | context |
| --- | --- | --- | --- |
| `deepseek-flash`（V4.1-Flash） | **text + image** | low/high/max，默认 high | 1,048,576 |
| `deepseek-v4-pro` | text only | low/high/max，默认 high | 1,048,576 |

> 两个模型默认 effort 都是 `high`，本项目默认发 `low` 以压延迟——这是实测得出的配置。

---

## 七、尚未验证的部分（诚实清单）

- **真实 OCS 流量下的字段清单**：需要你在实际平台跑一轮捕获模式，用 `npm run report` 核对
  （源码考证说只有 3 个基础字段，但真实平台可能有出入）。
  `report-capture.js` 会主动把"考证之外的字段"标成 ⚠。
- **客观正确率**：目前所有"准确率"证据都是**伪标签**（模型自己的判定），
  要证明准确率必须有人工标注题集。旧项目的 `eval/questions.json` 只有 20 题且是自选名题，
  不代表真实分布。
- **`ctx.type` 为假导致 OCS 不填答案**：源码证据确凿（§一），但需要你在页面上实测确认
  ——刷一道 `type=unknown` 的题，看选项有没有被自动选中、面板有没有那句报错。
- **`${images}` 在本机 OCS 5.2.1 上的实际字段形态**：我只按源码构造了请求，
  真实 OCS 发来时字段名/类型是否完全一致，需要捕获模式确认。
