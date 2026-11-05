# T11 模型层「失败伪装成模型的话」+ 全层 usage 记录（第31条）

日期：2026-11-05　执行者：security（并发路 3/3）　上游：T01 基线、T02/T03 门禁、T04 日志、T10 第1/2/30条

> 一句话：**模型层故障从此有名字了**。失败不再伪装成"模型说了句话"，而是以 `[LLM_ERROR]` 前缀返回；
> 19 个适配器都记账了（token/成本第一次可算）；三个裸 fetch 适配器补了 429 退避；
> `eslint src/models/` **60 → 0 error**。

---

## 0. 先核对报告（改之前做的）

| 报告说 | 实测 | 结论 |
|---|---|---|
| `src/models/*.js` **16 处** `'My brain disconnected, try again.'` | **17 处** | 报告少数 1 处（`replicate.js` 用 tab 缩进，可能被漏扫）。以实测为准 |
| `openrouter.js:41` `'No response received.'`、`ollama.js:35` `'No response data.'` | 都在 | 成立 |
| `grep usage × src/models` = 0 | **0** | 成立 |
| `prompter.js:246/291/301/316/337` 五个消费点 | 编号已漂移（T10 改动后是 `:278/:323/:333/:348/:369`） | 成立 |
| `hyperbolic`/`ollama`/`replicate` 裸 fetch 无 429 重试 | 前半成立；`replicate` 其实走 SDK（`replicate` npm），但同样**没有** 429 退避 | 成立（措辞微调） |
| `ollama.send():91-94` 把网络异常吞成 null | 成立（`catch { console.error }` 后 `return data`=null） | 成立 |

**报告没点、本次一并处理的同族（7 处）**——它们都是「把失败说成一句人话」：
`claude.js:47 'No response from Claude.'`、`ollama.js:66` / `hyperbolic.js:106` / `huggingface.js:76`
`'I thought too hard, sorry, try again.'`、`gemini.js:105 'An unexpected error occurred, please try again.'`
（合计 17 + 7 = **24 处**被标记化。）

**故意不动的一类**：`'Vision is only supported by certain models.'`（7 个适配器）——
这是**能力说明**不是故障假台词，玩家看到它是有用信息；改掉反而让人不知道发生了什么。

**报告没点、本次发现的真缺陷**：`gemini.sendRequest()` **压根没有 try/catch**（裸抛）。
看起来"更诚实"，但 `prompter` 的 `promptCoding` / `promptMemSaving` / `promptShouldRespondToBot`
**都没有 try/catch** —— gemini 一抛就是 coder / history / conversation 三个调用方真崩。
所以本次把**契约统一成一句**：`sendRequest()` **永不抛**，成功给内容，失败给标记。

---

## 1. 新建 `src/models/_shared.js`（契约 + 12 行 sink）

- `FAILED_REPLY = '[LLM_ERROR]'`、`failedReply(reason)`、`isFailedReply(text)`（前缀判定）；
- `recordUsage(usage, model, tag)`：一行 `[llm] model=… prompt=… completion=…`，兼容五种 usage 形状
  （OpenAI `prompt_tokens`/Anthropic `input_tokens`/Ollama `prompt_eval_count`/Gemini `promptTokenCount`/Mistral `promptTokens`）；
  拿不到 usage 记 `-` 并计入 `missing`（**「不知道」和「零消耗」必须分开**）；
- `setUsageSink(fn)` / `usageTotals()`（给单测和成本核算用，不靠抓 console）；
- `isRateLimit(errOrResponse)` / `rateLimitDelayMs(attempt)`：429 判据 + 指数退避（上限 30s + 抖动）。

**没有**做 `withRetry` 抽象（第三批的事）。

## 2. 24 处兜底串 → 标记

每处都保留原因：`failedReply('ollama request failed: ' + err.message)` —— 这样日志里能直接看出是哪家、为什么。
`grep -c 'My brain disconnected' src/models/` → **0**。

## 3. 19 个适配器记账

| 类别 | 适配器 | usage 来源 |
|---|---|---|
| OpenAI 兼容（`chat.completions`） | cerebras deepseek grok lmstudio mercury novita openrouter qwen vllm (+gpt 的自定义 url 分支) | `completion.usage` |
| OpenAI responses API | gpt（默认分支）、azure（继承 gpt） | `response.usage` |
| Anthropic | claude | `resp.usage` |
| Google | gemini（+vision） | `result.usageMetadata` |
| Mistral SDK | mistral | `response.usage` |
| Ollama | ollama | `prompt_eval_count`/`eval_count` |
| 裸 fetch | hyperbolic | `data.usage` |
| 流式无 usage | huggingface / replicate | 记 `-` + `tag=stream`/`tag=replicate`（明确 missing） |

## 4. prompter 五个消费点：失败不当回答

| 调用点 | 失败时 | 为什么这么选 |
|---|---|---|
| `promptConvo`（→ 写 history / 对玩家说） | 记 `conversation-failed` 日志后**返回空串** | `agent.js:598` 判 `res.trim().length === 0` ⇒ 不写 history、不 `routeResponse`、本轮结束。**直接返回而不是重试**：适配器内部已重试过 429/超长，再打三次只会把一次超时放大成三轮超时 |
| `promptCoding` | 标记原样上传 | `coder.js:50` 的 `res.indexOf('```') === -1` ⇒ 走既有「没写代码→重试」分支，标记绝不会被执行 |
| `promptMemSaving` | **返回原记忆** | `history.js:59` 是 `this.memory = 返回值`；返回 '' 或标记都会把真记忆覆盖掉 |
| `promptShouldRespondToBot` | `false` | 失败不该被当成"我要接话" |
| `promptGoalSetting` | `null` | 标记不可能解析出 goal，且别让 `res.split` 崩 |

（`agent.js` 侧的消费点按约定归 T32，本任务没碰。）

## 5. 429 / 吞异常

- `hyperbolic`：429 → `continue` 退避重试（最多 5 次）；其它错误 → 标记。
- `ollama`：429 → 退避重试；**`send()` 不再吞异常**（`catch` 里 `throw err`）⇒ 上层能判 429、能记失败。
- `replicate`：包一层重试循环（最多 4 次），429 退避，其它 → 标记。

## 6. vllm.js 补 import（T03 实测新增的第 6 项）

`saveToFile()` 用了 `path`/`fs`/`__dirname` 却没有 import（eslint no-undef 点名 5 处）。补齐后 **no-undef = 0**。

**顺带发现（已注释在代码里，未擅自删）**：`vllm.saveToFile()` **没有任何调用点**（prompter 用自己的 `_saveToFile`），
且判据写的是 `this.task_id`（从没赋过值，上一行局部变量才叫 `task_id`）⇒ 永远走 else 分支、`task_id` 为 null 时路径是 `.../logs/null`。
本次只把判断改成本地变量（与本文件上一行语义一致），**整个方法该删该接留待下一批**（删之前要确认没计划用它）。

---

## 7. 验收（逐条命令 + 结果）

| 命令 | 结果 |
|---|---|
| `grep -rc 'My brain disconnected' src/models/` | **0 处**（全部标记化；连文档注释里的措辞也换了，避免 grep 假阳性） |
| `npx --no-install eslint src/models/` | **0 error**（改前 **60**：semi 35 / require-await 19 / no-undef 5 / no-extra-boolean-cast 1） |
| `node tools/llm_usage_unit.mjs` | **ALL PASS: 123 passed, 0 failed** |
| `node tools/unit_all.mjs` | **87/87 通过，4 跳过**（不回归；改前 84/84） |
| `node tools/preflight.mjs` | 启动自检通过 |
| `npx --no-install eslint src main.js` 的 **no-undef** | **0**（T90 硬指标；其余 199 条是 semi/require-await/no-empty 等既有类，归 T20/T21/T31/T32） |

**eslint 从 60 → 0 是怎么做到的（有意为之，不是关规则）**
- `semi` 35：`eslint --fix`（纯机械）。
- `require-await` 19：
  - `sendVisionRequest`（10 个）体内只有 `return this.sendRequest(...)` ⇒ 去掉 `async`，返回的**仍是同一个 Promise**，对 `await` 调用方语义完全一致；
  - `embed`（9 个）体内只有 `throw` ⇒ 去掉 `async` 改成 `return Promise.reject(...)`。
    **这一条特别注意**：`examples.js:32` 用 `.then()` 接，直接删 `async` 会变成同步 throw 逃出 `map` —— 那是行为变化。
- `no-extra-boolean-cast` 1：`if (!!x)` → `if (x)`。

**行尾**：`src/models/` 里有 CRLF 也有 LF（`hyperbolic.js` 是 CRLF）。我用脚本/`--fix` 写回时统一过一遍，
最后按 **HEAD 的原始行尾**逐个复原，所以 diff 只有内容改动：21 文件 **254 +/92 −**
（`--ignore-all-space` 与普通 `--stat` 数字一致 = 没有整文件重写）。行尾不对时 `hyperbolic.js`
一个文件就会显示 ~241 行变动 —— 那是噪声，已消掉。

## 8. 单测 `tools/llm_usage_unit.mjs`（123 项，都不联网）

- **A 标记与 sink**：前缀/原因保留/正常回答不误判；五种 usage 形状各自的解析；
  拿不到 usage → `-` 且 `missing+1`；`isRateLimit` 的 429/rate-limit/普通错误三面；退避递增且封顶。
- **B 每个适配器真跑**（把各家网络客户端换成桩）：成功 → sink 收到 `[llm] model=… prompt=N completion=M` 且数值正确；
  失败 → 返回值是标记、且**不含任何旧假台词**。覆盖 cerebras/deepseek/gpt/grok/groq/lmstudio/mercury/novita/
  openrouter/qwen/vllm/claude/gemini/huggingface + replicate + hyperbolic + ollama（mistral 因 `#client` 私有字段改用源码断言）。
- **C prompter**：失败 → 空串 / 不写 history / 不含标记 / 只试 1 次；正常回答照旧；
  coding 给标记且无代码围栏；memSaving 保留原记忆；shouldRespond=false；goal=null。
- **D/E 429 与覆盖**：ollama 429 重试到成功且仍记 usage；网络异常 → 标记；replicate/hyperbolic 429 重试；
  静止断言：19 个适配器**全都**调了 `recordUsage`、`src/models/` 无残留假台词、三个裸 fetch 都接上退避。

## 9. 没做 / 留给下游

0. **一个我自己踩、差点留在树上的坑（队长当场抓到的）**：新建的 `tools/llm_usage_unit.mjs` 里
   桩函数写成 `async () => 固定值`，触发 **21 条 require-await + 1 条 require-yield + 1 条 no-regex-spaces**，
   把 `npm run lint:tools` 的棘轮从 **278 顶到 301**。
   修法（**没有** `eslint-disable`、**没有** `--update` 抬基线）：
   - 只返回固定值的桩 → `() => Promise.resolve(x)` / `() => Promise.reject(e)`（对 `await` 调用方语义不变）；
   - 要"迭代时抛"的流桩 → 不用没有 `yield` 的 `async function*`，改成显式
     `{ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(e) }) }`；
   - 删掉一条多余的正则（`no-regex-spaces`）。
   结果：该文件 eslint **23 → 0**，棘轮回到 **278 ≤ 278**。
   教训值得写进流程：**"桩函数别写 async"** —— 这是三个人这轮同时踩的坑。

1. **`agent.js` 侧的消费点**（`routeResponse`、response 预算）按分工归 T32 —— 我只保证 prompter 不再把失败当回答。
2. **统一 `withRetry`**：本任务只给三个裸 fetch 加了最小退避，没有抽象重试框架（第三批）。
3. **`vllm.saveToFile()` 死代码**：见 §6，删/接需要先确认无人计划调用。
4. `[llm]` 目前只打到日志 sink；落库/出报表属于成本核算专项（第12条后续）。

---

## 附：T10（第1/2/30条）两处「实现偏离报告字面」的补遗（应队长复核要求补记）

T10 当时写在 `T10-控制面-沙箱-注入.md` 与提交信息里，但**报告正文没有这两条**，
所以这里集中补一次，供 T90 汇总时引用（队长已列入其「实现偏离报告字面」清单 ⑧⑨）。

### ⑧ `set-agent-settings` 白名单把 `profile` 也一并丢弃（报告只点了两项）

- 报告第 1 条 ② 原文只要求丢 `allow_insecure_coding` 与 `blocked_actions`。
- 实现：`src/mindcraft/auth_gate.js` 的 `SAFE_RUNTIME_SETTINGS` 里**还排除了 `profile`**。
- **理由**：`profile` 里装的是 `permissions`（谁是这只 bot 的主人）。
  `set-agent-settings` 能改它 ⇒ 任何能发这条事件的人都能**把 owner 改成自己**，
  等于自己给自己发权限。留着它，另外两项白名单就形同虚设（拿到 owner 就能再开一切）。
- 代价：面板无法经 socket 改 profile —— 但面板本来就不发这条（实测 `grep set-agent-settings web/src` 无命中），
  改 profile 一直是「改文件 + 重启」，行为没变。

### ⑨ `INSECURE_CODING` 环境变量只认 `1/true/yes/on`（原来 `=0` 也算开）

- 报告第 1 条 ③ 只说「`main.js:50` 的 `INSECURE_CODING` 要么删、要么保留但打印告警」。
- 实测原文是 `if (process.env.INSECURE_CODING) { allow_insecure_coding = true }` ——
  **只要非空就开**，于是 `INSECURE_CODING=0` / `=false` / `=no` 这些**看起来是关闭**的写法
  全都会把代码执行**打开**。这是「设了关反而开着」的经典坑，比不设更危险（人会以为自己关了）。
- 实现：显式白名单 `1/true/yes/on` 才算开；`0/false/no/off` 走「按关闭处理」并打一条 warn；
  真开启时打印 72 个 `=` 夹的「代码执行已开启 = 本机 root 权限」。
- 位置：`mindcraft/main.js`（T10 提交 `ce053e3`）。

