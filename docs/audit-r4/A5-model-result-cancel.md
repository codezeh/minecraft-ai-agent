# A5 · 模型返回值类型化 + 取消/截止贯穿（架构收敛项 1、2）

审计面：用户原文第 1 条（模型返回值升级为明确结果类型）、第 2 条（取消与截止贯穿整次操作）
仓库：`E:\我的世界ai`（mindcraft）　性质：**只读审计，未改任何代码**
日期：2026-11-07

标注约定：

- **已实测** = 本次真的跑了命令并贴出输出（只跑既有单测 / 只做不改文件的 `node -e` 探针）
- **静态确证** = 逐行读过源码/依赖包源码，行号可复核
- **推断** = 由静态结构必然推出，但没有在本机跑到该路径

---

## 0. 结论摘要（先给判断）

1. **返回值形状**：一次模型调用返回的就是一个 `string`，三种语义挤在同一根串上 ——
   正常内容 / 以 `[LLM_ERROR]` 开头的失败 / 结尾带 `[LLM_TRUNCATED]` 的截断。
   **没有 ok/code/usage/finishReason 通道**，19 个适配器各自把这两件事编码进字符串
   （`_shared.js:25,47`）。这就是第 1 条的现状。
2. **标记泄漏**：主链路（`promptConvo`→`agent.js`）已经被 fence 住了，**但泄漏没有清零**，
   还留下 4 个真实缺口，其中 1 个是**假成功**（截断代码被当空代码执行并报"完成"），
   1 个是**状态被静默丢弃**（`last_convo_truncated` 只写不读，死标志）。
3. **取消**：全仓 `AbortController` **只有 1 处生产代码**（`_shared.js:186`），且**没有任何适配器传入外部
   signal** —— `fetchWithDeadline` 的"外部取消"分支在生产里是死代码（只有单测走过）。
   `operationId` 概念**不存在**（`grep operationId|operation_id|opId` = 0 命中）。
4. **最严重的单点**：openai SDK 默认 `timeout=600000` + `maxRetries=2`，**且超时（AbortError）也在重试范围内**
   —— 一次模型调用最坏 **30 分钟**，期间 `!stop` / 面板停止 / 动作 10 分钟超时**全都拦不住它**，
   唯一兜底是 D18 的僵尸看门狗**杀进程重启**。这是第 2 条的核心成本。

---

## 一、现状：一次模型调用的返回值形状

### 1.1 契约本体

`mindcraft/src/models/_shared.js:24-35`：

```
export const FAILED_REPLY = '[LLM_ERROR]';
export function failedReply(reason) { return `${FAILED_REPLY} ${String(reason ?? 'unknown')}`; }
export function isFailedReply(text) { return typeof text === 'string' && text.startsWith(FAILED_REPLY); }
```

`mindcraft/src/models/_shared.js:47-58`（截断，追加在后缀）：

```
export const TRUNCATED_SUFFIX = '[LLM_TRUNCATED]';
export function markTruncated(text) { ... return isTruncatedReply(s) ? s : s + TRUNCATED_SUFFIX; }
```

**实测（`node -e`，不改文件）**：

```
failedReply 形状: "[LLM_ERROR] boom"
markTruncated 形状: "hi[LLM_TRUNCATED]"
stripTruncatedMark: {"text":"hi","truncated":true}
```

所以返回值集合是：

| 语义 | 形状 | 判据 |
|---|---|---|
| 成功 | `"正文"` | 不以 `[LLM_ERROR]` 开头 |
| 失败 | `"[LLM_ERROR] <原因>"`（**原因被塞进给玩家看的那个位面**） | `startsWith` |
| 输出被截断 | `"正文[LLM_TRUNCATED]"` | `endsWith` |
| 空成功 | `""` | 与"失败后被上层转成空"**不可区分** |
| 用量 | **不在返回值里**，走 console sink `_shared.js:123-134` | — |
| 耗时/尝试次数 | **完全没有** | — |

关键后果：**"空串"同时表示"模型没话说"、"模型失败被吞"、"被新消息取代而丢弃"**（见 §6.1）。

### 1.2 适配器 × 能力矩阵（19 个适配器）

判定依据：超时看构造参数与 SDK 默认值（`node_modules/openai/core.js:138` 等），
usage 看 `recordUsage(` 调用点，截断看是否出现 `markTruncated(`。

| # | 适配器 | 传输 | 超时来源 | 覆盖响应体解析 | 可由外部取消 | usage | 截断检测 |
|---|---|---|---|---|---|---|---|
| 1 | `gpt.js` | openai SDK（+responses） | SDK 600s ×(1+2 重试) | ✅ SDK 内 | ❌ | ✅ `completion.usage`/`response.usage` | ✅ 双分支 |
| 2 | `azure.js` | 继承 GPT（AzureOpenAI） | 同上 | ✅ | ❌ | ✅（继承） | ✅（继承） |
| 3 | `claude.js` | Anthropic SDK | SDK 600s ×(1+2) | ✅ | ❌ | ✅ `input/output_tokens` | ✅ `stop_reason==='max_tokens'` |
| 4 | `deepseek.js` | openai SDK | SDK 600s ×(1+2) | ✅ | ❌ | ✅ | ✅ `finish_reason==='length'` |
| 5 | `grok.js` | openai SDK | SDK 600s ×(1+2) | ✅ | ❌ | ✅ | ✅ |
| 6 | `lmstudio.js` | openai SDK | SDK 600s ×(1+2) | ✅ | ❌ | ✅ | ✅ |
| 7 | `mercury.js` | openai SDK | SDK 600s ×(1+2) | ✅ | ❌ | ✅ | ✅ |
| 8 | `novita.js` | openai SDK | SDK 600s ×(1+2) | ✅ | ❌ | ✅ | ✅ |
| 9 | `openrouter.js` | openai SDK | SDK 600s ×(1+2) | ✅ | ❌ | ✅ | ✅ |
| 10 | `qwen.js` | openai SDK | SDK 600s ×(1+2) | ✅ | ❌ | ✅ | ✅ |
| 11 | `vllm.js` | openai SDK | SDK 600s ×(1+2) | ✅ | ❌ | ✅ | ✅ |
| 12 | `groq.js` | groq-sdk | **SDK 60s**（`groq-sdk/index.js:71`） | ✅ | ❌ | ✅ | ❌ **无** |
| 13 | `cerebras.js` | cerebras SDK | **SDK 60s**（`@cerebras/cerebras_cloud_sdk/index.js:65`） | ✅ | ❌ | ✅ | ❌ **无** |
| 14 | `mistral.js` | mistral SDK | **未见默认值**（推断：由 SDK/fetch 决定） | ? | ❌ | ✅ | ❌ **无** |
| 15 | `gemini.js` | `@google/genai` | **无任何超时**（`gemini.js:36` 未传 `httpOptions.timeout`；SDK 只在传了才设 `setTimeout`，`@google/genai/dist/node/index.cjs:13183-13187`） | ❌（等于不受限） | ❌ | ✅ `usageMetadata` | ✅ `finishReason==='MAX_TOKENS'` |
| 16 | `ollama.js` | 裸 fetch | **120s 应用级**（`fetchWithDeadline`，`ollama.js:100-107`） | ✅ `parse` 内读 body | ❌ **外层 signal 未传** | ✅ `prompt_eval_count/eval_count` | ❌ **无** |
| 17 | `hyperbolic.js` | 裸 fetch | **120s 应用级**，但 `this.timeoutMs` **恒 undefined、不读 params**（`hyperbolic.js:12`） | ✅ `parse` | ❌ **未传** | ✅ `data.usage` | ✅ |
| 18 | `huggingface.js` | HfInference **流式** | **无超时** | ❌ | ❌（SDK 支持 `signal`，`dist/index.cjs:235`，未传） | ✅（记 null + tag=stream） | ❌ **流截断无检测** |
| 19 | `replicate.js` | replicate SDK **流式** | **无超时**（`replicate` 无 timeout 选项） | ❌ | ❌（`run/stream` 支持 `options.signal`，`replicate/index.js:125,272`，未传） | ✅（记 null + tag=replicate） | ❌ **流截断无检测** |

**汇总**：

- **usage**：19/19 都调了 `recordUsage`；其中 `huggingface`/`replicate` 明确记 `-`（`missing`），
  不是"零消耗"—— 语义正确（`_shared.js:129-130`）。
  **但 `usageTotals()` 在全仓 0 个生产调用点**（只有 `llm_usage_unit.mjs` 用），成本**仍然算不出来**，只能捞 console。
- **截断检测**：13 个有，**6 个没有**（`groq` `cerebras` `mistral` `ollama` `huggingface` `replicate`）。
- **超时**：4 档并存 —— 600s×3（openai/anthropic 系 11 个）、60s（groq/cerebras）、
  120s（ollama/hyperbolic）、**无**（gemini/huggingface/replicate；mistral 未确证）。
  这就是用户说的"超时只覆盖部分适配器"的**精确形状**。
- **可取消**：**0/19**。没有任何 `sendRequest` 接受 signal —— 签名是 `(turns, systemMessage, stop_seq)`，
  无处可传。

### 1.3 两套时钟的真实代价（这是第 2 条的核心数字）

`node_modules/openai/core.js:138`：`constructor({ ..., maxRetries = 2, timeout = 600000 })`（静态确证）；
`core.js:325-330`：连接层失败（含 `AbortError` → `APIConnectionTimeoutError`）**在 retriesRemaining 内会重试**；
`core.js:402-414`：`shouldRetry` 对 408/409/429/5xx 重试。

⇒ **一次 `claude`/`gpt`/`deepseek` 调用最坏 3 × 600s = 1800s = 30 分钟**，
而 `action_manager` 的动作总超时是 10 分钟（`_startTimeout`，`action_manager.js:373-381`）。
**动作超时了，模型请求还在跑** —— 两套时钟互不相干。

---

## 二、内部标记泄漏到玩家回复的路径

### 2.1 已被 fence 的主链路（不是缺口，但要说清）

- `prompter.js:304-311`：`isFailedReply(generation)` → 记 `conversation-failed` 日志 → **返回 `''`**；
  `agent.js:710-713` 见空串即 `break`，不写 history、不 `routeResponse`。
- `prompter.js:339-346`：`isTruncatedReply` → `stripTruncatedMark` → 只返回正文。
- `agent.js:704-708`：第二道闸（防"prompter 忘了剥"）。
- 单测覆盖：`tools/agent_failed_reply_unit.mjs` 用例③**实测**断言了"老逻辑会写 history 并说给玩家、新逻辑零副作用"：

```
PASS ★ ③ 失败反证：老逻辑会把 "[LLM_ERROR] timeout" **写进 history 并说给玩家**；新逻辑零副作用 旧 effects=2 新 effects=0
```

**所以"标记直接说给玩家"这条老路径当前是关着的。**

### 2.2 残余缺口（4 条，按严重度）

#### 缺口 A（**假成功**，新）：截断的代码被当"空程序"执行并报成功

`prompter.js:381-387`：

```
const codingTruncated = isTruncatedReply(resp);
...
if (codingTruncated) { ...; return '```//no response (truncated)```'; }
```

该返回值**带三反引号**，而 `coder.js:50` 的判据是 `res.indexOf('```') !== -1`。
**实测**：

```
coder.js:50 contains_code = true (注释声称这里会是 false → 走"没写代码→重试"分支)
coder.js:72 抽出的 code = "//no response (truncated)"
按行插桩后是否含 ;\n（interrupt 检查注入点）= false
```

于是 `coder.js:72` 抽出一行**注释**，`_stageCode` 后 `bots/execTemplate.js` 只剩 `log(bot,'Code finished.')`，
`coder.js:87-93` **返回成功摘要** `"Agent wrote this code: ```//no response (truncated)``` Code Output: ... Code finished."`。
后果：(a) 一次截断 = 一次**什么都没做却记账成功**的动作；
(b) 那句 `(truncated)` 作为"代码"进了 history 给模型看；
(c) `code.replaceAll(';\n', ...)` 没命中 ⇒ **这段代码里一次 `interrupt_code` 检查都没有**（`coder.js:168`），
    即使玩家取消也不会停。
`prompter.js:386` 的注释写的是"返回没有代码让 coder.js 走既有分支"—— **与事实不符**（静态确证 + 实测字符串）。

#### 缺口 B（状态静默丢失，新）：`last_convo_truncated` 是死标志

`prompter.js:339-346` 剥离标记后 `this.last_convo_truncated = true`，
但 `grep last_convo_truncated src/` = **仅此一处赋值，0 处读取**。
⇒ 玩家看到的是一句**被腰斩的半句话**，没有任何提示；上层也拿不到"这句不完整"。
这就是"截断信息在展示层被删掉、却没有替代通道"的直接证据 —— 字符串里塞状态，剥标记就等于丢状态。

#### 缺口 C（标记进模型上下文，新）：视觉失败被拼成"图像分析结果"

`vision_interpreter.js:78-83`：

```
const result = await this.agent.prompter.promptVision(messages, imageBuffer);
return result + `\n${blockInfo}`;
```

`promptVision`（`prompter.js:440-445`）**没有** `isFailedReply` 判断，
`sendVisionRequest` 失败时返回的就是 `[LLM_ERROR] ...`。随后
`vision_interpreter.js:45,59` 把它包成 `Image analysis: "[LLM_ERROR] ..."`，
经 `!lookAt`（`actions.js:732,749`）→ `agent.js:769` `history.add('system', execute_res)`。

静态确证：标记**进模型上下文**；是否被说给玩家取决于模型是否复述（**推断**）。

#### 缺口 D（in-band 判据的固有缺陷）：模型自己输出同前缀 → 整轮被丢弃

`isFailedReply` 只看前缀。玩家说"把 `[LLM_ERROR]` 这几个字原样发给我"，模型照做 ⇒
`prompter.js:304` 判为失败 ⇒ **整轮静默**（不写 history、不说话），日志里只留一条 `conversation-failed`。
同理，正文里出现终结位置的 `[LLM_TRUNCATED]` 会被 `stripTruncatedMark` 削掉尾部
（`_shared.js:73-77`）。这不是"会不会被利用"，而是**把控制面塞进数据面的必然结果**，
也正是第 1 条要类型化的理由。

---

## 三、方案 A：`ModelResult` 迁移

### 3.1 边界定义

```js
// src/models/_shared.js（新）
/**
 * @typedef {Object} ModelResult
 * @property {string}  content      只放"能给人看/能进 history"的正文，永不含标记
 * @property {'ok'|'truncated'|'error'|'cancelled'|'timeout'} status
 * @property {string|null} finishReason  供应商原值：'stop'|'length'|'max_tokens'|'MAX_TOKENS'|'tool_use'|null
 * @property {{prompt:number|null, completion:number|null, missing:boolean}|null} usage
 * @property {string|null} errorCode   'RATE_LIMIT'|'TIMEOUT'|'CANCELLED'|'CONTEXT_LENGTH'|'BAD_RESPONSE'|'NO_TEXT'|'AUTH'|'NETWORK'
 * @property {string|null} errorMessage  已过 safeErrText 的一行（可写日志）
 * @property {number} elapsedMs
 * @property {number} attempts
 */
export class ModelResult {
    constructor(f) { Object.assign(this, { status:'ok', finishReason:null, usage:null,
        errorCode:null, errorMessage:null, elapsedMs:0, attempts:1, content:'' }, f); }
    get ok() { return this.status === 'ok'; }
    get truncated() { return this.status === 'truncated'; }
    /** 过渡兼容：旧调用点拿到对象也能当字符串用（含旧标记语义） */
    toString() { return this.status === 'error' ? failedReply(this.errorMessage ?? this.errorCode ?? 'error')
        : this.status === 'truncated' ? markTruncated(this.content) : this.content; }
    valueOf() { return this.toString(); }
}
```

**边界划在适配器返回值这一层**（`sendRequest`/`sendVisionRequest`），
不进 `bot`、不进 `history`：`history` 只该收 `content`。

### 3.2 改动面（精确文件数）

| 层 | 文件 | 数量 | 改什么 |
|---|---|---|---|
| 契约 | `src/models/_shared.js` | 1 | `ModelResult` + `toModelResult(text, {elapsedMs,attempts,usage,finishReason})` 桥 |
| 适配器 | `src/models/*.js`（19 个） | **19** | 返回 `ModelResult`；把已有的 `finish`/`usage` 填进字段（**信息本来就在手里，只是被丢了**） |
| 聚合层 | `src/models/prompter.js` | 1 | 5 个调用点 + `promptVision` 改读字段；`promptConvo` 的"空串"要拆成 `status` |
| 消费层 | `src/agent/agent.js`、`src/agent/coder.js`、`src/agent/vision/vision_interpreter.js` | 3 | 用 `status` 判，不再 `startsWith`/`indexOf('```')` |
| 测试 | `tools/mod_batch4_unit.mjs`、`llm_usage_unit.mjs`、`agent_failed_reply_unit.mjs`、`review2_regression_unit.mjs` | 4 | 断言新字段 |
| **合计** | | **28**（生产 24 + 测试 4） | |

### 3.3 兼容策略：分 4 步，每步都能独立合并

- **步 0（桥，2 文件，≈3 人时）**：`_shared.js` 加 `ModelResult` + `toModelResult()`；
  `prompter.js` 内部把 `sendRequest()` 的字符串**包装**成 `ModelResult`（适配器一行不改）。
  这一步只能恢复 `status`/`errorCode`/`elapsedMs`/`attempts`；
  **`usage` 与 `finishReason` 拿不到**（适配器已经把它们扔了）—— 要老实说明，别假装是完整版。
- **步 1（消费层先切，3 文件，≈4 人时）**：`agent.js`/`coder.js`/`vision_interpreter.js` 改读字段。
  此时适配器仍是字符串，靠步 0 的桥。**行为不变**，可以先上。
- **步 2（适配器逐个原生化，19 文件，≈10-14 人时）**：每个文件把已有 `usage`/`finish`/`catch` 三段接到
  `ModelResult` 上，删掉 `markTruncated`/`failedReply` 的拼接。可**按适配器逐个合**，
  没迁完的继续走桥（`toString()` 保证新旧共存）。
- **步 3（删旧契约，2-3 文件，≈2 人时）**：删 `toString()` 与 `isFailedReply` 的消费点，
  把 `FAILED_REPLY`/`TRUNCATED_SUFFIX` 降级为"仅日志用"。

**成本合计 ≈ 20-24 人时**（不含评审）。**不建议**"一个 PR 直接改全部调用点"：
`sendRequest` 有 5 个调用点分布在 3 个模块，且有 4 个测试断言字符串前缀，
一次性改会把"类型化"和"行为变更"混在同一个 diff 里 —— 出问题时无法二分。

### 3.4 收益

- 截断/错误/用量不再是"字符串里的暗号"，`status` 可以直接驱动**降级决策**
  （截断→续写 or 缩短；RATE_LIMIT→退避；CANCELLED→静默丢弃）。
- `usage` 有了**传递通道**，`usageTotals()` 才可能有真实消费者（见 §6.2）。
- 缺口 A/B/C 全部由字段化自然消失（不再需要"剥标记"这种补救）。

---

## 四、取消与截止：现状核实

### 4.1 `AbortController` / `AbortSignal` 全仓清点（核实用户的 grep）

```
$ grep -rn "AbortController" src/ tools/ --include=*.js --include=*.mjs
src/models/_shared.js:186:    const ctrl = new AbortController();
tools/mod_batch4_unit.mjs:249:    const ac = new AbortController();

$ grep -rn "AbortSignal" src/
src/models/_shared.js:164: *  ... 把 AbortSignal 传下去 ...
```

**结论：生产代码 1 处（`_shared.js:186`），测试 1 处。用户判断成立。**

### 4.2 但这 1 处是"半死"的

`fetchWithDeadline` 支持外部信号（`_shared.js:182-192`），可是**两个调用方都没传**：

- `ollama.js:100`：`await fetchWithDeadline(request, {}, { timeoutMs: ... })` ← init 是空对象，无 `signal`
- `hyperbolic.js:61`：`{ method, headers, body }` ← 无 `signal`

⇒ `_shared.js:184`（外部已取消）与 `_shared.js:211-214`（外部取消分支）在生产**永不触发**，
只有 `mod_batch4_unit.mjs` 的用例②走过。**"有取消入口"是表面现象。**

### 4.3 `operationId`：不存在

```
$ grep -rn "operationId\|operation_id\|opId" src/   → 0 命中
```

现存的三种"近似物"，**都不是操作身份**：

| 近似物 | 位置 | 语义 | 为什么不够 |
|---|---|---|---|
| `ctx.jobId` | `composite_registry.js:414-458` | 任务单 id | 只在 flow 层；不传给模型层；一张单可包含多次动作 |
| `ctx.deadline` | `composite_registry.js:426-430` | 绝对毫秒 | 只是个数字，无取消能力；`flow_follow` 曾只认 `timeoutMs` 完全没生效（T21 E1） |
| `attemptSeq` | `board_client.js:395-420`、`board_claims.js` | 尝试代次 | **这才是正确的模式**，但只用于任务板写入，未用于模型结果 |
| 开窗代次 `_openGen` | `act_container.js:165-206` | 代次 | 局部实现，未抽象 |

**注意 `act_container.js:165-206` 与 `board_client.js:395-420` 已经是两份"代次/纪元"实现**，
说明这个模式在项目里被独立发明了至少两次 —— 做成统一 `operationId` 是**收敛重复**，不是新增复杂度。

### 4.4 面板取消时，实际会发生什么（问题 6）

面板有两条完全不同的"停"：

| 入口 | 链路 | 实际语义 |
|---|---|---|
| 面板「停止」按钮 | `SetupView.vue:199` / `StatusCard.vue:82` → `socket 'stop-agent'` → `mindserver.js:758-759` → `mindcraft.js:97-101 stopAgent` → `agent_process.stop()` → `process.kill('SIGINT')`（`agent_process.js:188-190`，必要时 `proc_lifecycle.js:129-137` 升级 SIGKILL） | **杀整个 agent 进程**。粗暴但**确实能停一切**（含在飞的模型请求，因为进程没了） |
| 快捷指令「停下」= `!stop` | `QuickCommands.vue:24` → 聊天命令 → `actions.js:136-140` `agent.actions.stop('player')` | **只设 `bot.interrupt_code`**（`agent.js:564-570`），**进程活着** |

**用户问的"取消一个正在跑的动作"= 后者（`!stop`）**。逐环节：

| 环节 | `!stop` 后是否真的终止 | 证据 |
|---|---|---|
| 寻路 | ✅ 大部分（`pathfinder.stop()`；`goToGoal` 还有 200ms 轮询 `interrupt_code` 的第三支分支） | `agent.js:568`、`skills.js:1922-1935` |
| 挖掘 / PvP | ✅ `stopDigging()` / `pvp.stop()` | `agent.js:566,569` |
| 收集（collectBlock） | ✅ `cancelTask()` | `agent.js:567` |
| 新动作启动前 | ✅ `stop()` 阻塞等待（10s 看门狗 + 僵尸重启） | `action_manager.js:120-134,146-161` |
| **模型请求** | ❌ **完全不会停**。没有 signal，`promptConvo`/`promptCoding` 只管 `await` | `prompter.js:296,375,400,428`（签名无 opts） |
| **模型回复的落地** | ❌ **仍会写 history 并说给玩家**：`handleMessage` 的 else 分支在 `promptConvo` 返回后**没有任何 interrupt 复查** | `agent.js:773-777` |
| **429/退避等待** | ❌ 退避 `await new Promise(r=>setTimeout(r, wait))` 不可中断，最长 ~30s | `ollama.js:48-52`、`hyperbolic.js:99-103`、`replicate.js:88-93` |
| 容器开窗 | ✅ 已修（代次 + 成功前复核取消 + 清计时器） | `act_container.js:143-206` |
| 容器交互循环（存取/转移） | ⚠️ 只在若干检查点查 `interrupt_code`（`act_container.js:553,729`），**长转移循环中间没有取消源** | 同上 |
| 任务板租约 | ❌ **心跳照旧每 10s 续租**（`board_scheduler.js:663-674`），进程/动作卡着也照样续，别的 bot 拿不到 | `board_scheduler.js:658-674` |
| 迟到结果的丢弃 | ⚠️ 只有会话层一道 `most_recent_msg_time` 比对（"有新消息"才丢），**取消不在判据内** | `prompter.js:282-289,326-329` |
| 代码生成循环 | ❌ `interrupt_code` 只在**模型返回之后**才查 | `coder.js:44-49` |

**最锋利的一条**：`!stop` 之后那句"她其实已经生成好的回复"**照样被说出口**
（`agent.js:773-776` 无复查），因为它既非"新消息取代"也不在 `checkInterrupt()` 的判据里
（`agent.js:668`：`shouldInterrupt || shut_up || responseScheduledFor`，`interrupt_code` 不在其中）。

---

## 五、方案 B：`operationId + deadline + AbortSignal` 最小贯穿

### 5.1 在哪一层创建

**唯一创建点：`ActionManager._executeAction()`**（`action_manager.js:191-290`），
因为它是全仓**唯一的动作槽**（`executing` / `_pendingLaunch` 都在这里，`action_manager.js:206-278`）：

```js
// 开工前（认领动作槽之后，紧邻 this.executing = true）
this.currentOperation = {
    id: `${this.agent.name}:${++this._opSeq}`,   // 操作身份
    deadline: Date.now() + timeout * 60_000,     // 与动作总超时同源
    ac: new AbortController(),                   // 唯一取消源
};
```

一条不变式：**`currentOperation` 只在同一次 `_executeAction` 内有效，
`stop()`/超时/被取代 一律 `ac.abort()`**（挂到 `action_manager.js:86-135` 的 `stop()` 里，
在 `applyStop()` 之前/之后各一次都行：`requestInterrupt()` 旁边加 `this.currentOperation?.ac.abort()`）。

### 5.2 怎么下传（4 跳，全部是"加一个可选参数"）

1. `action_manager` → `agent.currentOperation`（已有 `agent` 引用，0 改签名）
2. `agent`/`coder` → `prompter.promptConvo(history, { op })`（**加第 2 个可选参数**）
3. `prompter` → `sendRequest(turns, system, stop_seq, { signal, timeoutMs })`（**加第 4 个可选参数**）
4. 适配器 → SDK：`client.chat.completions.create(pack, { signal })`（openai 系一处加一个第二参）；
   `fetchWithDeadline(..., { signal })`（ollama/hyperbolic 各 1 行）；
   `replicate.run(model, { input, signal })`；`genai` 传 `config.abortSignal`

`timeoutMs` 由 deadline 反算：`Math.max(1000, deadline - Date.now())` ——
**这就把"两套时钟"合并成一套**：模型请求用的剩余时间 ≤ 动作剩余时间。

### 5.3 迟到结果怎么丢弃（租约绑定）

**复用 `attemptSeq` 的既有模式**，不要发明新机制：

- 结果值里带 `operationId`；消费点先比对 `res.operationId === agent.currentOperation?.id`，
  不等则**丢弃（不写 history、不说话、不 finish 任务单）**。
- 任务板侧：`heartbeat/finish/checkpoint` 已经带 `attemptSeq`（`board_client.js:415-446`），
  **再加 `opId` 是可选的**；真正需要加的是"**停了就不许续租**"：
  `board_scheduler.js:663-674` 的心跳回调里加 `if (this._stopRequested) return;`。
- 否则就是现在的现象：单子被 `paused` 了，心跳还在续租，别人拿不到，直到 finally 才 release。

### 5.4 改动面与成本

| 阶段 | 内容 | 文件数 | 人时 | 收益 |
|---|---|---|---|---|
| **P0-a** | `ollama`/`hyperbolic` 把 `signal` 传进 `fetchWithDeadline`（**入口本来就有**） | 2 | **1** | 两个裸 fetch 适配器立刻可取消 |
| **P0-b** | openai/anthropic 系 12 个适配器加 `{ timeout, maxRetries: 0, signal }` 请求选项；**顺手把 600s×3=30min 压到 ≤120s×1** | 12（可先只改 `gpt`/`claude`/`deepseek` 3 个） | 2-4 | **消灭 30 分钟黑洞**（最高收益/最低成本） |
| **P0-c** | `gemini` 传 `httpOptions.timeout`；`hyperbolic` 接线 `params.timeoutMs` | 2 | 1 | 补齐"无超时/配置无效" |
| **P0-d** | `agent.js` 在 `promptConvo` 返回后**补一次 `checkInterrupt()`**（或在 `checkInterrupt` 里纳入 `bot.interrupt_code`） | 1 | **1** | `!stop` 后不再说那句迟到的回复 |
| **P1** | `ActionManager` 建 `currentOperation` + `stop()` 里 abort + prompter/coder 透传 | 4-5 | 6-8 | 取消真正贯穿"动作→模型" |
| **P2** | 结果带 `operationId` + 消费点比对 + 心跳停租 | 6-8 | 8-12 | 迟到结果不影响新任务 |
| **合计** | | ~25 | **19-27** | |

**P0 四件事（≈5 人时）就能消掉本次审计里最痛的两条**（30 分钟黑洞 + 取消后仍说话），
建议先做，`operationId` 放第二批（它需要 P0 的 signal 通道先存在）。

---

## 六、衍生问题（比"标记泄漏"更严重）

### 6.1 "失败被当成空字符串继续执行"—— 三种语义合并的后果

`promptConvo` 的四种返回**在上层同形**（`agent.js:710-713` 一律 `break`）：

| 实际情况 | 返回 | 上层看到 |
|---|---|---|
| 模型确实无话可说 | `''` | "本轮结束" |
| 模型失败 | `''`（`prompter.js:310`） | "本轮结束" |
| 生成期间来了新消息 | `''`（`prompter.js:326-329`） | "本轮结束" |
| 3 次都撞 `(FROM OTHER BOT)` 幻觉 | `''`（`prompter.js:321-324` 循环耗尽） | "本轮结束" |

⇒ **失败率、丢弃率、幻觉率在运行时不可分辨**，只能翻 `conversation-failed` 日志。
这正是第 1 条"状态应与内容分离"的最直接证据。

### 6.2 usage 记了但没人能读（新）

`recordUsage` 打了 19 处，`usageTotals()` **0 个生产消费者**（`_shared.js:107`），
`setUsageSink` 只有测试用。⇒ "第一次可以算成本"目前只到 console 一行，**没有汇聚/上报/落盘**。

### 6.3 重试策略：不是"缺"，而是"三种各来一套"

| 层 | 策略 | 证据 |
|---|---|---|
| SDK 层（openai/anthropic） | 2 次，**超时也重试** | `openai/core.js:138,325-330` |
| 适配器层 | ollama 5 次 / hyperbolic 5 次 / replicate 4 次，**仅 429** | `ollama.js:26,48-52`；`hyperbolic.js:96-103`；`replicate.js:44,88-93` |
| 上下文超长 | 递归 `sendRequest(turns.slice(1))`，**每层多一次请求** | `deepseek.js:55-57`、`gpt.js:111-113`、`hyperbolic.js:95-98`、`ollama.js:45-47` |
| coder 层 | **失败 / 无代码 → 再要 5 次** | `coder.js:42,50-69` |

⇒ 一次供应商故障的实际请求数可达 **5（coder）× 3（SDK）× N（429 退避）**。
`promptConvo` 那边反而"失败即返回空串、不重试"（`prompter.js:307-310` 有注释解释），
**两条路径的策略完全相反** —— 会话不重试、代码重试 5 次，这是不一致而不是设计。

### 6.4 超时/失败后仍写 history / 记忆

- `promptConvo` 失败**不写**（好）。但 `promptCoding` 失败把 `[LLM_ERROR] ...` **原样返回**，
  经 `coder.js:50-66` → `history.add('system', execute_res)`（`agent.js:769`）⇒ **标记进上下文**。
- 记忆：`promptMemSaving` 失败返回**原记忆**（`prompter.js:404-407`）—— 这个处理是对的；
  但**截断**的摘要会被 `stripTruncatedMark` 后**照写进 `memory.json`**（`prompter.js:414-418`），
  而记忆是跨重启的长期内容（`history.js:93-109`）：**一条被腰斩的"结论"会长期生效**，
  代码只删了标记、没做"截断就别覆盖"的判断。**（新，建议改成保留原记忆）**

### 6.5 任务租约"活着的僵尸单"（新）

`board_scheduler.js:663-674` 的 `setInterval` 心跳**不看** `_stopRequested`/`actions.executing`，
只要 `_runJob` 还没走完 finally 就一直续租。而 `_runJob` 卡住的最长来源正是
§1.3 的 30 分钟模型调用（`coder` 路径）或 10 分钟动作超时。
⇒ 面板上单子已 `paused`，租约仍归自己，**别的 bot 拿不到**，直到进程被杀或 finally 到达。

---

## 七、死代码 / 隐患（问题 8）

### 7.1 `setTimeout` 未 `clearTimeout`

按文件统计（`setTimeout` vs `clearTimeout`）：`skills.js` 31/4、`act_container.js` 3/2、
`tool_prep.js` 4/1 —— 数字本身不算证据（大量是 `sleep()`），逐点核过的**真泄漏**：

| 位置 | 问题 | 级别 |
|---|---|---|
| `act_fish.js:55-58` | `Promise.race([bot.fish(), setTimeout(reject)])`，**计时器无句柄、无 `clearTimeout`** ⇒ 钓鱼成功/失败后计时器仍挂到 `timeoutMs`；且 `bot.fish()` **超时后继续跑**（底层 promise 无人管） | S3（小） |
| `modes.js:203-208` | `Promise.race([skills.moveAway(bot,5), setTimeout(15000)])`，计时器**从不清理**（会把事件循环多吊 15s）；超时后 `moveAway` 仍在跑却已 `say('我出来啦~')` —— **假好消息** | S3（小） |
| `action_manager.js:120-134` | 已正确 `clearTimeout`（对照组） | — |
| `skills.js:1922-1955` | `hardLimitTimer`/`interruptTimer` 在 `finally` 清理，`doorCheckInterval` 在 catch/成功都清（对照组） | — |
| `_shared.js:193-222` | 已正确清理（**实测**：`MOD-006 正常返回后没有残留定时器`） | — |

### 7.2 `Promise.race` 之后底层继续跑

- `act_fish.js:55`：`bot.fish()` 输掉 race 后**没有 `bot.finishFishing`/取消 API**，
  下一次 `fishOnce` 会在旧 promise 未结束的 bot 上再发一次 —— 状态机冲突（**推断**，需真机验证）。
- `modes.js:205`：`moveAway` 输掉 race 继续移动，与紧接着的其它动作争用身体。
- `act_container.js:143-206`：**已修**，且是本节唯一做对的范式（代次 + 迟到清理 + 清计时器）——
  建议把这段注释里的做法直接抽成通用工具，别让每个文件重新踩一次。
- `tool_prep.js:260`：`.finally(clearTimeout)` ✅。

---

## 八、12 条结论清单（与最终消息同源）

> 排序规则：级别（S1 > S2 > S3），同级别按成本升序。
> 标注：`已实测` / `静态确证` / `推断`；`(已知未修)` 表示前序审计已提出但仍在；`(新)` 表示本次新发现。

| # | 级别 | 问题 | 证据 | 影响 | 成本 |
|---|---|---|---|---|---|
| 1 | S1 | 一次模型调用最坏 **30 分钟**且不可取消（SDK 600s×3，超时也在重试范围） | `node_modules/openai/core.js:138,325-330,402`（静态确证） | 动作 10 分钟超时/`!stop`/面板停 全都拦不住，只能杀进程 | 中 2-4h（改 3 个主适配器） |
| 2 | S1 | **0/19 适配器接受取消信号**；`fetchWithDeadline` 外部 signal 分支生产永不触发 | `prompter.js:296,375,400,428`；`ollama.js:100`/`hyperbolic.js:61` 未传；`_shared.js:182-214`（静态确证） | 取消后仍烧 token、占连接 | 中 6-8h |
| 3 | S1 | `!stop` 后**迟到的回复仍写 history 并说给玩家** | `agent.js:773-777`（无复查）vs `agent.js:668`（`interrupt_code` 不在 `checkInterrupt` 判据）（静态确证） | 玩家叫停后她仍在说话 | **小 1h** |
| 4 | S1 | **截断代码被当空代码执行并报成功**（`(truncated)` 假成功） | `prompter.js:386` + `coder.js:50,72,87-93`（**已实测**字符串行为） | 什么都没做却记账成功；该段代码无 interrupt 检查 | **小 1-2h** |
| 5 | S2 | 返回值无类型：失败/截断/空/丢弃 四语义同形 | `_shared.js:25,47`；`prompter.js:304,310,326-329`；`agent.js:710-713`（静态确证） | 失败率/丢弃率不可分辨；`ModelResult` 迁移主体 | **大 20-24h**（可拆 4 步，步0仅 3h） |
| 6 | S2 | **截断摘要覆盖 memory.json**（长期污染） | `prompter.js:414-418`；`history.js:93-109`（静态确证）（新） | 被腰斩的"结论"跨重启生效 | **小 1h** |
| 7 | S2 | `usageTotals()` 无生产消费者，成本仍算不出 | `_shared.js:97-134`（grep 0 调用点）（静态确证）（新） | 花了多少钱仍然未知 | **小 2h** |
| 8 | S2 | 超时四档并存；`gemini` 无超时、`hyperbolic` 配置不生效 | `gemini.js:36,52`；`hyperbolic.js:12`；`groq-sdk/index.js:71`；`@cerebras/cerebras_cloud_sdk/index.js:65`（静态确证）（新） | 行为不可预期；配置项骗人 | **小 2h** |
| 9 | S2 | 任务板心跳**不看停止标志**，paused 单仍续租 | `board_scheduler.js:663-674`；`board_client.js:415-420`（静态确证）（新） | 别的 bot 拿不到单，直到进程被杀 | **小 1-2h** |
| 10 | S2 | 重试策略三套且相反（会话不重试 vs coder 5 次） | `coder.js:42,50-69`；`prompter.js:307-310`；`_shared.js:150`（静态确证）（新） | 一次故障放大成 5-15 次请求 | **小 2h** |
| 11 | S3 | 视觉失败把 `[LLM_ERROR]` 拼进"图像分析"结果进上下文 | `vision_interpreter.js:78-83,45,59`；`prompter.js:440-445`（静态确证）（已知未修） | 标记进模型上下文，可能被复述给玩家 | **小 1h** |
| 12 | S3 | `act_fish`/`modes` 的 `Promise.race` 计时器不清、底层继续跑 + 假好消息 | `act_fish.js:55-58`；`modes.js:203-208`（静态确证）（新） | 泄漏 timer；"我出来啦~"是假的 | **小 2h** |

**先做这 4 条（合计 ≈5 人时，都是 S1 且低成本）**：#3、#4、#6、#8。

---

## 附录 A：本次实际执行的命令（可复核）

```
# 契约形状（不改文件）
node -e "import('./src/models/_shared.js').then(...)"         → failedReply/markTruncated/stripTruncatedMark 形状
node -e "…indexOf('```')…"                                    → 截断代码被误判为"有代码"（实测）

# 既有单测（只跑，不改代码）
node tools/mod_batch4_unit.mjs         → ALL PASS: 33 passed, 0 failed（含 MOD-006 三条）
node tools/agent_failed_reply_unit.mjs → 6/6 通过（含"失败标记零副作用"反证用例）

# 清点
grep -rn "AbortController" src/ tools/          → 生产 1 处（_shared.js:186）
grep -rn "operationId|operation_id|opId" src/   → 0
grep -rn "last_convo_truncated" src/            → 1 处赋值、0 处读取
grep -rn "usageTotals|setUsageSink" src/        → 0 个生产消费者
grep -rn "sendRequest|sendVisionRequest" src/ | grep -v src/models/  → 仅 prompter / vision 两处入口
```

## 附录 B：没能确证的项（老实说明，勿当结论用）

- `@mistralai/mistralai@1.15.1` 的默认超时：包内 `core.js` 未搜到 `timeout` 字面量，
  未能确认其 HTTP 层默认值（**推断为"未设"**，需要真机断网实验）。
- gemini 在"服务端发完头不发 body"时的表现：`@google/genai` 未传 `httpOptions.timeout`，
  按源码 `dist/node/index.cjs:13183-13187` 推断为"无期限"；**未做真机断流实验**。
- `act_fish` 超时后 `bot.fish()` 继续跑与下一次钓鱼的状态机冲突：**推断**，需真机复现。
- 面板「停止」是否在生产中真的用 SIGKILL 兜底：`agent_process.stop()` 只 `kill('SIGINT')`
  （`agent_process.js:188-190`），`proc_lifecycle.stopChildAndWait` 的升级逻辑是否接在该路径上，
  **未逐跳确证**。
- 「模型自己输出 `[LLM_ERROR]` 导致整轮静默」的影响面：静态可确证会被判失败，
  实际能否被玩家触发取决于提示词，**未做对抗实测**。

## 附录 C：与既有审计的关系（避免重复计费）

| 本报告条 | 既有文档 | 关系 |
|---|---|---|
| §1.2 适配器矩阵 | `docs/audit/13-models-agent-preflight.md` §4（21 行"usage 全 ✘"） | 那份是**修复前**快照；本表是**修复后**现状（19/19 有 usage） |
| 缺口 A（截断代码假成功） | `T11` 文档 §4 表格称"标记绝不会被执行" | **本次推翻该结论**，理由见 §2.2A |
| 缺口 B（`last_convo_truncated` 死标志） | `T21`/`mod_batch4` 的"第3B条"修复 | 剥标记是对的，但**没有替代通道** —— 属于修复的残余 |
| §6.3 重试 | `T11` 明确写"不做 withRetry（第三批）" | 本报告确认**仍未做**，且已产生可观测的放大效应 |
| §4.4 容器取消 | `T31`/BOT-006 | 已修（`act_container.js:143-206`），列为对照范式 |
| §7 定时器 | `T21` §33（goToGoal 可中断） | 已修；本报告发现的是**其余两处**未修 |
