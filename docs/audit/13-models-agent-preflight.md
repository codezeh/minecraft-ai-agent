# 深读⑥：模型层 21 个文件 + agent.js + preflight + utils/npc/vision

**未审 `web/`（按作者要求）。未改任何源码。**

## 0. 覆盖表

| 文件 | 行数 | 状态 |
|---|---:|---|
| `src/models/openrouter.js` | 77 | **已全文读** |
| `src/models/qwen.js` | 80 | **已全文读** |
| `src/models/ollama.js` | 115 | **已全文读** |
| `src/models/gpt.js` | 147 | **已全文读** |
| `src/models/hyperbolic.js` | 114 | **已全文读** |
| `src/models/azure.js` | 32 | **已全文读** |
| `src/models/deepseek.js` | 59 | **已全文读** |
| `src/models/cerebras.js` | 61 | **已全文读** |
| `src/models/novita.js` | 71 | **已全文读** |
| `src/models/lmstudio.js` | 74 | **已全文读** |
| `src/models/huggingface.js` | 86 | **已全文读** |
| `src/models/claude.js` | 87 | **已全文读** |
| `src/models/replicate.js` | 136 | **已全文读** |
| `src/models/vllm.js` | 77 | **只读 grep 骨架**（catch 行号已核，未逐行） |
| `src/models/grok.js` | 82 | **只读 grep 骨架** |
| `src/models/mistral.js` | 93 | **只读 grep 骨架** |
| `src/models/groq.js` | 95 | **只读 grep 骨架** |
| `src/models/mercury.js` | 95 | **只读 grep 骨架** |
| `src/models/gemini.js` | 175 | **只读 grep 骨架** |
| `src/models/_model_map.js` | 88 | **已全文读** |
| `src/models/prompter.js` | 383 | **只读 grep**（`sendRequest` 调用点 + `log_all_prompts`） |
| `src/agent/agent.js` | 865 | **已全文读**（1-440 + 441-865） |
| `tools/preflight.mjs` | 1076 | **已全文读**（1-540 + 541-1076） |
| `tools/audit_rules.mjs` | 339 | **只读结构**（`runAudits` 等 5 个函数签名） |
| `tools/audit_codes.mjs` | 60 | **未读** —— 已 grep 确认**全仓无人引用**（见 P9） |
| `src/utils/keys.js` | 24 | **已全文读** |
| `src/utils/mcdata.js` | 614 | **只读 grep**（31 个导出 + `getItemBlockSources` 位置） |
| `src/utils/` 其余 7 个 | ~330 | **未读**（`text.js` 被所有适配器 import，未展开） |
| `src/agent/vision/` 3 个 | 200 | **未读** |
| `src/agent/npc/` 5 个 | 898 | **只读 `item_goal.js:160-166`**（已复核 ReferenceError） |
| `src/agent/rules/rules.runtime.js` | 148 | **未读**（只被 import 常量） |

**诚实声明**：本轮把 acceptance 点名的三块（21 个 models 文件、agent.js、preflight.mjs）里 **13/19 个适配器 + 2 个非适配器文件 + agent.js + preflight 全文读完**；6 个适配器（vllm/grok/mistral/groq/mercury/gemini）只做了 grep 级核实 —— 它们的 `catch` 与 `sendRequest` 结构与已读的 deepseek/gpt 同型（同一条 grep 输出的行号可证），但**我没有逐行读它们的函数体**。utils/npc/vision/rules 只做了定点核实，未全文读。

---

## 1. 模型层重复实现：精确账（取代 t3 的 150~180 行估算）

### 1.1 「context 超长 → 截断重试」这一段的复制：**11 处，不是 11「处代码」而是 11 份**

| # | 文件:行 | 写法 |
|---|---|---|
| 1 | `deepseek.js:42-44` | `err.message == 'Context length exceeded' \|\| err.code == 'context_length_exceeded'` → `return await this.sendRequest(turns.slice(1), …)` |
| 2 | `novita.js:45-47` | 同上，但 **`sendRequest` 缺 `this.`**（见 P2） |
| 3 | `lmstudio.js:38-40` | 同上（用 `===`） |
| 4 | `vllm.js:51-53` | 同上（grep 核实） |
| 5 | `qwen.js:41-43` | 同上 |
| 6 | `grok.js:43-45` | 同上（grep 核实） |
| 7 | `mercury.js:49-51` | 同上（grep 核实） |
| 8 | `hyperbolic.js:71-76` | 同上（跨 3 行展开） |
| 9 | `ollama.js:38-40` | `err.message.toLowerCase().includes('context length')`（唯一用 includes + toLowerCase 的） |
| 10 | `gpt.js:76-78` | 同上 |
| 11 | `huggingface.js` | **没有**（HF 走单 prompt，不存在 turns 截断） |
| — | `openrouter.js` | **没有**（t3 说 openrouter 缺重试 → **核实成立**，见 P1） |
| — | `cerebras.js` / `claude.js` / `mistral.js` / `groq.js` / `replicate.js` / `gemini.js` / `azure.js` | **没有** |

每份 3~4 行（判断 + log + 递归 return），**11 份 ≈ 40 行**，可合并成 1 个 `withContextRetry(fn)` ≈ 8 行 → **净减 ≈32 行**。

### 1.2 「兜底字符串」：`'My brain disconnected, try again.'` **15 处**

`deepseek.js:47`、`novita.js:50`、`lmstudio.js:43`、`vllm.js:55`、`qwen.js:46`、`grok.js:50`、`mercury.js:56`、`hyperbolic.js:79`、`ollama.js:43`、`gpt.js:84`、`openrouter.js:51`、`cerebras.js:35`、`claude.js:54`、`mistral.js:65`、`groq.js:69`、`replicate.js:83` —— **16 处**（t3 说 17，实际 16：`azure.js` 继承 GPT 无自己那份）。

另外还有 3 种**别的**伪造串：
- `openrouter.js:41` `'No response received.'`
- `ollama.js:35` `'No response data.'`、`:66` `'I thought too hard, sorry, try again.'`
- `huggingface.js:76` `'I thought too hard, sorry, try again.'`、`hyperbolic.js:106` 同句
- `gpt.js:81` `'Vision is only supported by certain models.'`、`claude.js:52` 同句、`claude.js:47` `'No response from Claude.'`

**合计 24 处伪造串 ≈ 24 行**。合并成 `FAILED_REPLY` 常量 + 统一日志 → 净减 ≈18 行，**但更重要的是它是个语义问题，不只是重复**（见 P1）。

### 1.3 「构造样板」（new SDK client + apiKey + baseURL）：**14 处**

openai-SDK 型：`deepseek.js:11-16`、`novita.js:14-19`、`lmstudio.js:9-12`、`vllm.js`（grep 有 config）、`qwen.js:10-15`、`grok.js:16-19`(grep)、`mercury.js:14-17`(grep)、`gpt.js:12-21`、`openrouter.js:10-21`、`azure.js:13-30`、`cerebras.js:13`、`mistral.js:18-25`(grep)、`groq.js:26`(grep) = **13 处**；加 `gpt.js:126-136`（`sendAudioRequest` 里又建一次）= **14 处**。每处 4~8 行。

可合并成 `makeOpenAICompatible({ baseURL, keyName, org? })` ≈ 12 行，替换 10 处 openai 系 → **净减 ≈35 行**（cerebras/groq 用别的 SDK，只能共用 key 读取那半）。

### 1.4 Lean 结算

```
Lean: -85 行, -0 依赖 可能
```
= context 重试 32 + 伪造串 18 + 构造样板 35。**比 t3 的「150~180 行」小一半** —— 因为 t3 把"同一句话出现 N 次"按"每处能省 2~3 行"算，而实际每处只有 1 行。

**真正的收益不是行数，是 P1/P2**（伪造串会让上层把失败当回答；novita 的重试必崩）。

---

## 2. 适配器错误处理矩阵（21 行，完整）

列说明：**429** = 速率限制；**超时** = 请求超时；**网络** = DNS/断连；**畸形响应** = 200 但结构不对；**语境** = 超长自动截断重试；**兜底** = 失败时返回伪造串；**usage** = 记录 token 用量。

| # | 适配器 | 429 | 超时 | 网络 | 畸形响应 | 语境 | 兜底 | usage |
|---|---|---|---|---|---|---|---|---|
| 1 | `azure.js` | 继承 GPT（SDK 默认） | SDK 默认 | SDK 默认 | 继承 | ✔ 继承(:78) | ✔ 继承 | ✘ |
| 2 | `cerebras.js` | SDK 默认 | SDK 默认 | SDK 默认 | **`\|\| ''` 返回空串**(:32) | ✘ | ✔(:35) | ✘ |
| 3 | `claude.js` | Anthropic SDK 默认 | SDK 默认 | SDK 默认 | `find(type==='text')` 无则伪造串(:47) | ✘ | ✔(:54) | ✘ |
| 4 | `deepseek.js` | openai SDK 默认 | SDK 默认 | SDK 默认 | 无检查 | ✔(:44) | ✔(:47) | ✘ |
| 5 | `gemini.js` | **未核实** | 未核实 | 未核实 | catch 只判 image 分支 | ✘ | ✔ | ✘ |
| 6 | `gpt.js` | openai SDK 默认 | SDK 默认 | SDK 默认 | 无检查 | ✔(:78) | ✔(:84) | ✘ |
| 7 | `grok.js` | openai SDK 默认 | SDK 默认 | SDK 默认 | 无检查 | ✔(:44) | ✔(:50) | ✘ |
| 8 | `groq.js` | SDK 默认 | SDK 默认 | SDK 默认 | 无检查 | ✘ | ✔(:69) | ✘ |
| 9 | `huggingface.js` | 5 次循环但**错误直接 break**(:51) | ✘ | ✘ | **流截断无检查**(:40-46) | ✘ | ✔(:49) | ✘ |
| 10 | `hyperbolic.js` | **✘ 裸 fetch，无 429 重试** | ✘ | ✘ | `\|\| ''`(:68) | ✔(:76) | ✔(:79) | ✘ |
| 11 | `lmstudio.js` | openai SDK 默认 | SDK 默认 | SDK 默认 | 无检查 | ✔(:40) | ✔(:43) | ✘ |
| 12 | `mercury.js` | openai SDK 默认 | SDK 默认 | SDK 默认 | 无检查 | ✔(:49) | ✔(:56) | ✘ |
| 13 | `mistral.js` | SDK 默认 | SDK 默认 | SDK 默认 | 无检查 | ✘ | ✔(:65) | ✘ |
| 14 | `novita.js` | openai SDK 默认 | SDK 默认 | SDK 默认 | `res.includes` 对 null 崩(:53) | **✔ 但必抛**(:47) | ✔(:50) | ✘ |
| 15 | `ollama.js` | **✘ 裸 fetch** | ✘ | **✘ 被 `send()` 吞成 null**(:91-94) | `'No response data.'`(:35) | ✔(:40) | ✔(:43) | ✘ |
| 16 | `openrouter.js` | **✘ 无（SDK 默认算一半）** | ✘ | ✘ | **3 个伪造串**(:41/:51) | **✘ 缺**(t3 成立) | ✔(:51) | ✘ |
| 17 | `qwen.js` | **✘ chat 无；embed 有**(:56-77) | ✘ | ✘ | 无检查 | ✔(:43) | ✔(:46) | ✘ |
| 18 | `replicate.js` | **✘ 无** | ✘ | ✘ | **流截断无检查**(:66-73) | ✘ | ✔(:83) | ✘ |
| 19 | `vllm.js` | openai SDK 默认 | SDK 默认 | SDK 默认 | 无检查 | ✔(:52) | ✔(:55) | ✘ |
| 20 | `prompter.js` | —（不直接发请求） | — | — | 把 `sendRequest` 的返回**无条件当回答**(:246/291/301/316/337) | — | — | **✘ 零记录** |
| 21 | `_model_map.js` | —（不发包；动态发现） | — | — | `profile.model.includes(...)` 无空值保护(:68-76) | — | — | — |

**空白格（真正缺保护的组合）**：
- **429**：`hyperbolic`、`ollama`、`replicate`（都是**裸 fetch / 非 openai SDK**，没有 SDK 默认重试兜底）→ **3 个真空格**。
- **网络错**：`ollama.send()` 把 fetch 异常**吞掉返回 null**(:91-94) → 上层看到 "No response data."，**永不重试**。
- **畸形响应**：`cerebras:32`、`hyperbolic:68`、`ollama:35` 用 `|| ''` 把畸形变成**空字符串**；`novita:53`、`gpt:79`、`claude:51`、`groq:64`、`mercury:52`、`mistral:60` 用 `err.message.includes(...)`，**err 不是 Error 时在 catch 里再抛 TypeError**。
- **usage**：**21 行全 ✘**。

---

## 3. 密钥处理审计

**读 key 的唯一入口**：`src/utils/keys.js` —— `getKey(name)`（:12-21）先读 `./keys.json`，再读 `process.env[name]`，**都没有就 throw**（:18-20）。`hasKey(name)`（:23-25）返回真值不抛。
19 个适配器全部走 `getKey`/`hasKey`，**没有一处硬编码密钥**（`lmstudio.js:11` 的 `'lm-studio'` 是 LM Studio 要求的占位串，不是密钥）。

**有没有把 key 打进日志？** —— **没有发现直接打印 key 的代码**。但有一个必须指出的风险面：

- **16 个适配器在 catch 里直接 `console.log(err)` / `console.error(err)`**（`deepseek:46`、`novita:49`、`lmstudio:42`、`vllm:55`、`qwen:45`、`grok:50`、`mercury:56`、`hyperbolic:78`、`ollama:42/93`、`gpt:83`、`openrouter:49`、`cerebras:34`、`claude:56`、`mistral:65`、`groq:69`、`replicate:82`）。**打印的是整个 error 对象**。对基于 `fetch` 的 SDK / axios 包装，error 对象常带 `request`/`config`，其 headers 含 `Authorization: Bearer <key>` → **会落盘到 `logs/mindcraft-console.log` 与 `run-live.log`**。
- 本项目混合用了 openai SDK v4（`fetch`）、`@anthropic-ai/sdk`、`@cerebras/cerebras_cloud_sdk`、`groq-sdk`、`replicate`、`HfInference`。**哪些 SDK 的 error 对象带 request headers 我没有逐个实测** → 标为**需现场验证**：随便找一个 401 触发一次，看日志里是否出现 `Authorization`。
- **无一处打印 request headers 全文**；`hyperbolic` 手写 headers（:52-55）但只用于 fetch，未打日志。

**结论**：没有"明文写死 key"，但**有 16 个 `console.log(err)` 的泄露面**，且这是 C 类（可能含 Authorization）。最小修复：在这 16 处改成 `console.log(err?.message ?? err)`（一行一处，或统一走一个 `logErr()`）。

---

## 4. LLM 用量不可测的根因链（三跳，每跳都有行号）

```
①  适配器丢弃 usage
    openai SDK 的 response 里有 completion.usage {prompt_tokens, completion_tokens}
    但 19 个适配器**没有一个读它** —— 它们只取 choices[0].message.content：
      deepseek.js:39   res = completion.choices[0].message.content;
      gpt.js:54        res = completion.choices[0].message.content;
      qwen.js:38       res = completion.choices[0].message.content;
      … 其余同型
    → grep 'usage' × src/models/*.js = **0 命中**

②  接口形状让它无法上传
    sendRequest 的契约是 (turns, systemMessage) => Promise<string>
    prompter 的 5 个调用点全部把返回值当字符串：
      prompter.js:246  generation = await this.chat_model.sendRequest(messages, prompt);
      prompter.js:291/301/316/337 同样
    → usage 即使想返回，也没有传递通道

③  于是日志与账本里永远没有 token
    grep 'usage|tokens|prompt_tokens' × 全仓日志/源码 = 0
    → 审计⑤的 R8「挂一夜花了多少钱、慢在哪」无法回答（不是没做，是数据不存在）
```

**最小修复（在哪一层加一行什么）**：
在**适配器层**加一行"把 usage 送到一个全局 sink"，不改 `sendRequest` 的返回契约：
```js
// src/models/_usage.js（新，约 12 行）
export const usage = { prompt: 0, completion: 0, calls: 0, lastAt: 0 };
export function recordUsage(u, model) { if (!u) return; usage.prompt += u.prompt_tokens ?? 0; ... console.log(`[llm] model=${model} prompt=${u.prompt_tokens} completion=${u.completion_tokens}`); }
```
然后在每个适配器拿到 `completion` 之后、取 content 之前插一行 `recordUsage(completion.usage, this.model_name)`（**openai 系的 13 个适配器都能这么做**；claude 用 `resp.usage`；gemini 用 `response.usageMetadata`）。
**收益**：一行/适配器换来"每次调用的 token 与累计成本"，且不碰任何调用方。

---

## 5. preflight 的可绕过性实证

### 5.1 哪些段是「可执行断言」（真检查）

| 段 | 判据 | 强度 |
|---|---|---|
| [1] 模块导入 | **真的 `await import()`** 每个文件，只把 `ReferenceError`/`MODULE_NOT_FOUND` 判失败（:57-76） | **强**（唯一能抓 `skills.js:5750` 那类的一层），但有洞（见 P5） |
| [1b] 冒烟测试 | **真的调用** 5 个函数（:98-141），带假 bot | **强**，但有 1 条指向已删模块（P6） |
| [3] 规则审计 | `audit_rules.runAudits()`，17 条规则表 + 裸常量 + 字段标准 | **中**（见 5.2） |
| [3b] 错误码审计 | **正则扫源码** `/\bcode:\s*'([A-Z_]+)'/`（:183） | **弱且当前失效**（P7） |
| [5] 前缀 import | **正则解析 import 行** + 层矩阵 + 同层白名单（:592-745） | **中**（可被动态 import 字符串绕过） |
| [6] 依赖注入 | **跑子进程** `deps_injection_audit.mjs --selftest` 再跑主体 | **强**（三态设计，最好的一个） |
| [7] 代码规模 | 只统计，不判失败 | 信息 |

### 5.2 哪些是「只做文本匹配」（可绕过）

1. **`API_SCAN_RULES` 全部 5 条**（:294-368）都是**正则扫"抹掉注释/字符串后的源码"**（`maskJsSource` :433-473）。绕过写法（三种都合法且常见）：
   - **变量拼命令**：`const cmd = '/setblock …'; bot.chat(cmd);` → `slash-command-owner` 的模式是 `/bot\.chat\s*\([^\n]*?['"`]\s*\//`（:339），**要求同一行有字面量 `/`** → 变量不匹配。**生产里已有两个实例**：`skills.js:1029`（`breakBlockAt` cheat 分支）、`skills.js:4000`（`buildFromSchematic`）—— 见 D16/D3。
   - **解构取方法**：`const { setControlState } = bot; setControlState('forward', true)` → `control-state-owner` 的模式要求 `\bsetControlState\s*\(`，这条会命中；但 `mouse-input-owner` 的模式（:325）要求前缀是 `bot|agent|agent\.bot|this\.bot|this\.agent\.bot` → **重命名（`const b = bot; b.dig(x)`）或可选链（`bot?.dig?.(x)`）都不匹配**。
   - **`chat-via-openchat` 的 `allow` 名单里直接写着 `skills.js`**（:351）→ 该文件里所有 `bot.chat` 本来就豁免。
2. **错误码审计**（:183）也是纯正则，且**只认单引号**：`code: "DIED"`（双引号）不会被扫到。
3. **前缀 import**（:614-624）用正则取 import 行 → `await import(someVar)`（变量）绕过；`:617` 只识别 `import('...')` 字面量。

### 5.3 「检查到问题但只警告不失败」的降级开关

| 开关 | 位置 | 效果 |
|---|---|---|
| `--report-api` | `preflight.mjs:278` | 把 §4 从"命中即失败"降成"只报告"，**一句话让 5 条规则全失效** |
| `--strict-api` | `:806` | 只影响 §5 的 `TIGHTENED_NEW_VIOLATIONS`（现在是**空表**），默认不判失败 |
| `KNOWN_PREFIX_VIOLATIONS` | `:759-780` | **4 条已知违规永久豁免**（含 `commands/actions.js → act_place.js`，一条真的分层违规），只打 `·` |
| 非 ReferenceError 的导入失败 | `:72-74` | 静默跳过，**不计 failed** |
| 冒烟测试的非判定错误 | `:137-139` | 打 `~` 不计 failed |
| 交接文档漂移 | `:246` | 明确"只提示不计入 failed"（合理） |

---

## 6. 新发现（P1 起）

## Must fix

### P1 适配器把失败**伪装成模型的话**返回，上层无法区分 → 这是"17/16 处兜底串"的真正危害
`openrouter.js:51`、`gpt.js:84`、`deepseek.js:47`、`claude.js:54`、`cerebras.js:35`、`replicate.js:83` 等共 16 处（完整列表见 §1.2）

**这是什么**：每个适配器的 `catch` 里，失败时 `res = 'My brain disconnected, try again.'` 然后 `return res`。

**问题**：`sendRequest` 的返回类型是 `Promise<string>`，**没有 ok/code 通道**。于是 prompter 拿到的"回答"与一次真实的模型输出**完全同形**。后果链：
1. `prompter.js:246` 把它当 generation → 存进 history（`agent.js:608` `this.history.add(this.name, res)`）；
2. `agent.js:599` 判 `res.trim().length === 0` —— 非空 → 继续；
3. `containsCommand(res)` → 无命令 → 当作对话回复 `routeResponse` → **真的对玩家说出 "My brain disconnected, try again."**；
4. 这一轮**算作成功回合**，`max_responses` 计数被消耗，历史里多了一条"她自己说的话"。
更糟的是 `openrouter.js:41` `'No response received.'` 与 `ollama.js:35` `'No response data.'`：这两句读起来像**系统状态**，会让模型在下一轮基于它推理（"我好像没收到响应"），而实际是传输失败。
**触发场景**：API 401/429/超时/断网 —— 每一种都静默变成一句台词，**没有任何 code、没有任何 retry 记录**。

**最小修复**：catch 里不要返回字符串，而是 `throw e`（让 prompter 感知）**或者**返回一个可识别的对象 `{ __error: e.message }`，由 `prompter.js` 统一转成 `fail('INTERNAL', …)`。最小一步（不改契约）：把那 16 处 `'My brain disconnected, try again.'` 换成**带标记的**字符串 `'[LLM_ERROR] <code>'`，并在 `agent.js:599` 之前加一个判断：**遇到 `[LLM_ERROR]` 就当作空响应对待（break）**，不写进 history、不发给玩家。

**不修会怎样**：所有模型层故障都会被记账成"模型说了句话"，于是①成本/失败率不可统计；②玩家会看到莫名其妙的台词；③排障时 history 里全是假回答。

### P2 `novita.js:47` 的语境重试**必然抛 ReferenceError**（`sendRequest` 缺 `this.`）
`src/models/novita.js:47`

**这是什么**：novita 的"超长→截断重试"分支。

**问题**：`:47` 写的是 `return await sendRequest(turns.slice(1), systemMessage, stop_seq);` —— **模块作用域里没有 `sendRequest`**（它是类方法）。所以一旦触发（长对话必然触发），抛 `ReferenceError: sendRequest is not defined`，而且**是在 catch 块里抛**，直接冲出 `sendRequest`，prompter 无 catch → 未处理的 Promise rejection。
**这与 `skills.js:5750` 的 `ok` 未 import 是同一类**（返回值构造用了不存在的标识符），而且 preflight 的 `[1] 模块导入` 段**抓不到**（函数体没执行）。

**最小修复**：`return await this.sendRequest(...)`（3 个字符）。

**不修会怎样**：使用 novita 的 bot 在第一次长对话时崩溃/静默失联；而其它 10 个适配器同名分支都是对的 —— 只这一处漏了 `this.`。

### P3 `gpt.js:79`（及 claude/groq/mercury/mistral 同型）在 catch 里对 `err.message` 调 `.includes` → 二次抛
`gpt.js:79`、`claude.js:51`、`groq.js:64`、`mercury.js:52`、`mistral.js:60`

**这是什么**：`catch (err) { if (err.message.includes(...)) … }`。

**问题**：`err.message == 'Context length exceeded'`（如 `gpt.js:76`）对 `undefined` 是安全的；但 `.includes` 不是。若被 reject 的**不是 Error**（字符串、`{status:429}`、`null` —— fetch 包装与部分 SDK 会这样），`:79` 抛 `TypeError: Cannot read properties of undefined (reading 'includes')`，**在 catch 内部抛出 → 逃出 sendRequest**。t3 的「gpt.js:79」判断**成立**。
**触发场景**：`throw 'timeout'`（字符串）→ 走到 :76 判断为 false → 进 `:79` → TypeError。

**最小修复**：统一改成 `const msg = String(err?.message ?? err); if (msg.includes(...))`。5 个文件各 1~2 行。

**不修会怎样**：本应"优雅降级到兜底串"的路径变成**未捕获异常**，比 P1 更糟（P1 至少返回了字符串）。

### P4 `huggingface.js:40-46` / `replicate.js:66-73`：流式响应**中断也当成功返回半截**
`huggingface.js:40-52`、`replicate.js:66-75`

**这是什么**：两个适配器用 `for await` 累加流式片段：`res += (chunk.choices[0]?.delta?.content || "")`。

**问题**：`for await` 的迭代器**正常结束**（服务端干净关闭连接、或 SSE 流被代理截断）**不会抛异常** → catch 不触发 → `res` 是**半截回答**，`finalRes=res; break;` → 返回给 prompter，**当成完整回答**。没有任何"流是否正常收尾"的判断（没有 finish_reason 检查、没有长度校验）。
**具体后果**：模型说到一半（比如 `!collectBlocks("木` ）→ 这段被当回答 → `containsCommand` 解析失败或者执行一个残缺命令。而且是**静默的**。
（`huggingface:79` 还会把这段 `console.log(finalRes)` 打出来，所以在日志里能看到半截，但**没有任何标记说它是半截**。）

**最小修复**：累加后检查结束条件 —— HF/Replicate 的流在正常结束时会给出最终 chunk；在循环后加 `if (!sawFinish) res = '[LLM_ERROR] stream truncated at ' + res.length` （配合 P1 的标记），或至少 log `[stream] no finish marker`。

**不修会怎样**：长回答被截断时产生**看起来合法、实际不完整**的指令，且无法从日志分辨。

### P5 `preflight.mjs:78-80`：`failed===0` 时打印「✓ 所有模块导入成功（loaded/files.length）」—— **不校验 `loaded === files.length`**
`tools/preflight.mjs:72-80`

**这是什么**：§[1] 模块导入段的收尾。

**问题**：`:72-74` 对"非 ReferenceError / 非模块缺失"的导入失败**静默跳过**（`else { /* 其他错误在导入阶段不致命 */ }`），既不计 `failed` 也不计 `loaded`。于是：
- 假设 60 个文件因 `TypeError`（例如缺全局、循环依赖 TDZ）导入失败 → `loaded=62`、`failed=0` → 打印 **`✓ 所有模块导入成功（62/122）`** → **exit 0**。
- 那句 "✓ ...成功" 与括号里的 62/122 **自相矛盾**，但退出码是绿的。这正是本文件自己 (:19-32) 反复强调的"**0 命中 = 通过**"家族的变体：**"部分加载 = 全部成功"**。

**最小修复**：`:78` 改成 `if (failed === 0 && loaded === files.length) { ✓ } else if (loaded < files.length) { failed++; console.log('✗ 有 N 个模块没加载成功（loadable 602/122）') }`。

**不修会怎样**：一个模块因非 ReferenceError 原因加载失败时，preflight 会给绿灯；重启后该模块的功能在运行期才炸。

## Should fix

### P6 `preflight.mjs:122-125` 的冒烟测试指向**已删除的模块** `tile_map.js`——每次运行都"非致命"失败
`tools/preflight.mjs:122-125`

**这是什么**：`smokeTests` 第 5 条 `['tile_map.classifyChunk', async () => { const m = await import(.../library/tile_map.js); ... }]`。

**问题**：`src/agent/library/tile_map.js` **不存在**（`path_3d.js:4` 的注释明写它已被"取代"，t4 的实跑日志也印证：`~ tile_map.classifyChunk: 非致命（Cannot find module ...tile_map）`）。这段因此**永远失败**，但走的是 `:137-139` 的 `~ 非致命` 分支 → 不计 failed → 绿灯带一条噪音。
**危害**：这条冒烟测试本来是"抓函数体里未定义引用"的覆盖点之一，现在等于**少了一条实际覆盖**，而看起来"我们有 5 条冒烟测试"。
**最小修复**：删掉这条（4 行），或换成 `path_3d.plan3D`。

**不修会怎样**：冒烟测试名义 5 条实际 4 条；且每次 preflight 输出都带一条假警告，训练人忽略 `~` 行。

### P7 `preflight.mjs:165-210` 的错误码审计**当前在说谎**：`DIED` 未注册却打印「✓ 错误码审计通过」
`tools/preflight.mjs:180-206`

**这是什么**：§[3] 的错误码审计，用两条正则扫 `src/**/*.js`，求 `missing2 = used \ CODES`。

**问题（可复现，我跑了两遍）**：
```
$ node tools/preflight.mjs | sed -n '/\[3\/4\]/,/\[4\/4\]/p'
  ✓ 错误码审计通过（38 个已注册，全部合法）

$ # 用它的同一套逻辑单独跑：
$ node --input-type=module -e "…(与 :171-190 逐行相同)…"
CODES.length= 38
files2= 162 used2= 35
missing2= ["DIED"]      ← 非空！
```
而 `grep` 确认 `DIED` 出现在 `src/agent/library/control.js:188`（`code: 'DIED'`），且 `contract.CODES` **不含** `'DIED'`。
→ **同一套判据单独运行得到"失败"，正式运行却打印"通过"。** 两者必有一处与实际执行的代码不一致（我对 §165-210 的读码没找到短路；`requireScanned` 在 `files2=162` 时返回 true，理应走到 `else if (missing2.length)` 的 ✗ 分支）。**这条我无法只靠读码收敛，标为「待现场复核」**：复核方法 = 在 `:190` 后插一行 `console.log('DBG', missing2)` 跑一次（不动业务逻辑），看它到底是空还是有值。

**独立的、确定的那一半**：`DIED` 确实不在 `CODES` 里、且只作为**数据载荷**使用（`control.js:188/192/443` 的 `result: { code: 'DIED' }`），**从未传给 `fail()`** → **运行时无害**。所以：
- **修正 t4 的 T8 结论**：t4 说 `test_codes.mjs` 报 `DIED` 是"正则误报"—— 就"DIED 不在 CODES"这件事而言 `test_codes` **没说错**；错的是它把"数据载荷里的 code"当成"ActionResult 的 code"。真正的结论是：**这条审计的口径太宽（应只扫 `fail('X'` 与 `isResult`），而且 preflight 里那份同口径的实现现在行为异常**。

**最小修复**：① 把两条正则收窄为只匹配 `fail\(\s*'([A-Z_]+)'`（去掉 `code:` 那条），`DIED` 这类数据载荷自然不再报；② 顺手按上一条复核 §3 分支为何打印 ✓。

**不修会怎样**：错误码审计这一层**不可信** —— 要么它漏报（现在这样），要么将来把它收留又会误报。而"错误码没注册 → `fail()` 直接 throw"是已经炸过 4 次的坑（`:160-163` 自己写的），这一层必须可信。

### P8 `_model_map.js:68-76`：`profile.model.includes(...)` 没有空值保护 → 缺 `model` 的 profile 直接崩
`src/models/_model_map.js:68-76`

**这是什么**：profile 没给 `api` 时，按模型名猜 API。

**问题**：`:68` `if (profile.model.includes('gpt') || …)`。若 profile 只给了 `api: 'deepseek'` 而**没给 `model`**（合法用法 —— `createModel` 里 `profile.model` 会被置 null 以走默认模型，见 `:81-84`），则 `profile.model` 为 `undefined` → `TypeError: Cannot read properties of undefined (reading 'includes')`。
**触发场景**：`profiles/*.json` 里写 `{ "api": "deepseek" }`（不写 model）→ 启动即崩在 `selectAPI`。
**最小修复**：`:68` 前加 `const m = String(profile.model ?? '');` 并全部改用 `m`。

**不修会怎样**：一个"用默认模型"的正常配置变成启动崩溃，且报错指向 `.includes` 而非"你没写 model"。

### P9 `tools/audit_codes.mjs`（60 行）**全仓无人引用**，而 preflight 里已内联了同功能的一段
`tools/audit_codes.mjs`；对照 `tools/preflight.mjs:165-210`

**这是什么**：一个独立的错误码审计脚本。

**问题**：`grep -rn "audit_codes" tools/ src/`（排除自身）→ **0 命中**。即 `npm test`/`preflight`/任何 doc 都不跑它。而 preflight 的 §[3] 里**内联**了一份功能相同的实现（:165-210）。→ **两份同口径实现，一份是死的**，且它们将来会漂移（就像 P7 已经暴露的那样）。
**最小修复**：删 `audit_codes.mjs`（60 行），或反过来让 preflight 调它（与 `audit_rules` 的做法一致 —— preflight 已经是 `runAudits()` 调 `audit_rules.mjs` 的）。

**不修会怎样**：下一次改错误码审计的人有 50% 概率改到死的那份，然后困惑"为什么行为没变"（这一族 t2/t6 都记过）。

### P10 `agent.js:812-822` 的 300ms 心跳 `while(true)` **没有 try/catch** —— 一次异常永久停掉心跳
`src/agent/agent.js:812-822`

**这是什么**：`startEvents()` 末尾起的更新循环：每 300ms `await this.update(...)`，`update` 里跑 `modes.update()` / `self_prompter.update()` / `checkTaskDone()`。

**问题**：`while (true) { await this.update(start - last); … }` **整段没有任何 try/catch**。`update()` 内部三处调用任一抛出（比如 `modes.update()` 里某个 mode 的 handler 抛、或 `checkTaskDone` → `task.isDone()` 抛），这个 async IIFE 就**永久退出**，且异常成为 unhandled rejection（Node 只打一行 warning）。后果：**mode 不再更新、self_prompter 不再推进、任务完成不再被检测** —— 而进程还活着、面板还显示在线、玩家发消息仍然有响应，**只是"她自己不会动了"**。这是最难查的一类"半死"。
**最小修复**：把 `await this.update(...)` 包一层：
```js
try { await this.update(start - last); }
catch (e) { console.log('[update] 心跳内异常（已忽略，循环继续）：' + String(e?.message ?? e).slice(0,160)); }
```
**不修会怎样**：一次偶发异常让 bot 变成"只会聊天、不会做事"，且重新发消息也没用（心跳不是靠消息驱动的），只能重启。这与 t10 发现的 `follow` 超时没接上叠加，就是"看着在跑、其实停了"。

### P11 16 处 `console.log(err)` 打印整个 error 对象（可能含 `Authorization` header）
`deepseek.js:46`、`novita.js:49`、`lmstudio.js:42`、`vllm.js:55`、`qwen.js:45`、`grok.js:50`、`mercury.js:56`、`hyperbolic.js:78`、`ollama.js:42`+`:93`、`gpt.js:83`、`openrouter.js:49`、`cerebras.js:34`、`claude.js:56`、`mistral.js:65`、`groq.js:69`、`replicate.js:82`

**这是什么**：所有适配器 catch 里的日志。

**问题**：打印的是**整个 error 对象**而非 `err.message`。多数 LLM SDK 的 error 会把 `request`/`config`（含 headers）挂在错误对象上，`console.log` 会展开它 → 落进 `logs/mindcraft-console.log`（`start-panel.ps1:19` 的重定向）与 `run-live.log`。**这是 C 类须实测**：我没有逐个 SDK 验证 error 上是否带 `Authorization`。
**最小修复**：16 处统一改成 `console.log('[llm] ' + String(err?.message ?? err))`。

**不修会怎样**：一次 401 就可能把 `Authorization: Bearer sk-…` 写进磁盘日志；而这个仓库的日志是"给作者贴出来排障"的（t3 的 I6 同族）。

## Nice to have

### P12 `agent.js:271` 与 `:762` 各注册了一个 `bot.on('error')` → 重复日志
**问题**：`start()` 里 :271 注册一个（判 Duplicate/ECONNREFUSED 走 onDisconnect，否则 log），`startEvents()` 里 :762 又注册一个（无条件 `console.error('Error event!', err)`）。同一次错误打两遍，且第二处会把本该只在 login 阶段处理的信息重复刷屏。
**最小修复**：删 :762-764（3 行）。
**不修会怎样**：无功能影响，只是日志噪音翻倍。

### P13 `agent.js:312` `this._setupEventHandlers(save_data, init_message)` 是 async 但**没有 await**
**问题**：`:337` 声明为 `async`，`:312` 调用处不 await → 它内部若抛（`save_data.self_prompt` 分支、`history.add` 等），成为 unhandled rejection，spawn 流程继续往下走，看起来"初始化成功"。
**最小修复**：`await this._setupEventHandlers(save_data, init_message);`
**不修会怎样**：初始化失败的痕迹只剩一条 unhandled rejection warning。

### P14 `preflight.mjs:608` 的 `NAV_ALLOWED_ACT_FUNCS` 定义了但**从未被引用**
**问题**：`grep -rn "NAV_ALLOWED_ACT_FUNCS" tools/` → 只有定义处 1 命中。§[5] 的判定循环（:696-745）只用 `PREFIX_IMPORT_ALLOW` 与 `PURE_SIBLING_IMPORTS`。所以这份"导航层允许调的单格动作白名单"是**死配置** —— 而 `PREFIX_IMPORT_ALLOW.nav` 只允许 `['atom','query','infra']`，**意味着 nav 层现在根本不许 import act_***。也就是说：文档里"nav 可以调 stepInto/climbUp/digBlock"这条**没有实现**（要么永远违规，要么 nav 层实际在用别的方式）。
**最小修复**：删这 4 行；或在 §[5] 里真的按它放行（`selfLayer==='nav' && targetLayer==='act'` 时按 `symbols ⊆ NAV_ALLOWED_ACT_FUNCS` 放行）。
**不修会怎样**：读码的人以为"nav→act 有受控通道"，实际没有；而 nav 层若真的 import 了 `act_step.js`，会被当成新违规（或已躺在 KNOWN 名单里）。

### P15 注释漂移：`preflight.mjs:259-262` 写「这一层只报告不判失败（API_SCAN_ENFORCE = false）」，而 `:278` 实际是 `true`
**问题**：同一文件里，`：259-262` 的注释说"骨架期只报告"，`:271-277` 的注释说"已翻成判失败"，`:278` 代码是 `!argv.includes('--report-api')` = 默认 true。`:262` 那句是历史遗留。
**最小修复**：删 `:259-262` 那 4 行注释（保留 `:271-277`）。
**不修会怎样**：读码的人会以为 §4 默认是"只报告"，于是误判 preflight 的强度。

---

## 7. 对第 1、2、11、12 条的补充与修正

**第 1 条（控制面零认证 + 代码执行默认开）→ 补充一条链路**
`agent.js:544` 的 `perm_author = self_prompt ? (self_prompter?.author ?? source) : source` 显示：**权限等级取自 `source`（调用方），不取自文本** —— 这是对的、也是第 1 条成立的原因：`mindserver.js:392` 把客户端自报的 `data.from` 原样当 `source` 传进来（经 `mindserver_proxy` → `respondFunc(data.from, ...)`）。所以第 1 条的修法（**把 `from` 强制改写为服务端认定的 agent 名**）是正确的，而且只改一个文件就够，不需要动 agent.js。

**第 2 条（`profile.name` 路径穿越）→ 确认并补上精确行号**
本轮读完 agent.js，把顺序钉死：
- `agent.js:147` `this.prompter = new Prompter(this, settings.profile)` ← **这里落盘** `bots/<name>/last_profile.json`
- `agent.js:205` `const nameCheck = validateNameFormat(this.name)` ← **校验在这里，晚了 58 行**
所以"任意目录创建 + 任意文件写"确实发生在校验之前。**补充**：`:208` `process.exit(1)` 说明校验失败会退出，但那时文件已经写完了 —— **校验放对位置也不能撤销已写的文件**，所以第 2 条的修法必须同时包含"在 Prompter 内部做路径断言"（`resolved.startsWith(botsRoot)`），不只是提前校验。

**第 11 条（三道门禁无自动触发点）→ 修正一处、强化一处**
- **修正**：t4 说"eslint 是传递依赖、未列入 devDependencies"—— 本轮确认 `preflight.mjs` **自己**就是一道可执行门禁（且在 P5/P7 里暴露了两个洞），所以"没有门"应改成"有门，但门上有两个洞 + 没人开它"。表述更准。
- **强化**：preflight 的 §[6] 三态设计（`:882-954`）是全仓最强的门禁实现，值得作为其它段的模板（P5/P7 都该照它做"输入非空 + 指纹在不在"）。

**第 12 条（bot 侧日志无时间戳）→ 找到更 upstream 的原因，并补一条新结论**
- 本轮确认：**模型层连 usage 都没有**（§4 三跳），所以即便加了时间戳，"LLM 花了多少钱/多慢"**仍然算不出来** —— 第 12 条只能解决"何时发生"，不能解决"花了多少"。**两条要一起修**：时间戳（R2）+ usage 记录（§4）。
- **补一条**：`hyperbolic.js:45` `console.log('Messages:', messages)` 在 `while` 循环里、**每次重试都打一遍完整提示词**（最多 5 次）。这是 t3 的 I6，本轮确认行号与"每轮都打"这个细节。

---

## 8. 未验证 / 边界

- **6 个适配器（vllm/grok/mistral/groq/mercury/gemini）只做了 grep 级核实**，未逐行读函数体。§2 矩阵里这些行是从 `catch` 行号与同型结构推的，**可靠性低于其它 13 行**。
- **P11 的"error 对象含 Authorization"未实测** —— 需要触发一次 401 后检查 `logs/mindcraft-console.log`。**这是 C 类，不是已证实**。
- **P7 的矛盾我无法只靠读码收敛**：`missing2=["DIED"]`（我用它的逻辑单独跑）vs 正式运行打印 ✓。已在 P7 写明复核方法（在 `:190` 后插一行 DBG）。
- `audit_rules.mjs`（339 行）只读了 5 个函数签名，`runAudits()` 的 17 条规则**未逐条读**。
- `src/utils/text.js`（`strictFormat`/`toSinglePrompt`，被全部适配器 import）、`src/agent/vision/` 3 个、`src/agent/npc/` 除 `item_goal.js:160-166` 外**未读**；`rules.runtime.js` 只知它导出 `GOAL_LOOK_AT_DEFAULT_REACH` 等常量。
- 本轮**没有运行任何适配器**（无 API key 可用），所以"429 会怎样"全部来自读码 + SDK 默认值知识（openai-node 默认 `maxRetries=2`、Anthropic 默认 2），**没有实测**。
