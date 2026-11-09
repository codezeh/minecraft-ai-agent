# 12 — 修复 T22-C：三处模型调用不下传 `opts`（取消信号贯穿）

> 第五轮 · t29（runtime-probe）
> 时间：2026-11-09 · 工作目录 `E:\我的世界ai\mindcraft`
> 缺陷来源：T22 实测（`docs/audit-r5/10-遗留三条复核.md` §3.4）——三处模型调用 `opts` 恒为 `undefined`，
> `!stop` / 面板停止 / 动作超时**拦不住**，只能等适配器自身 120s 上限。
> 探针：`tools/opts_cancel_unit.mjs`（下划线命名 ⇒ 被 `unit_all` 自动发现）
> 证据：`docs/audit-r5/evidence/fix/{opts_cancel_unit,unit_all,preflight,gate_full,adapters_signal_unit}.log`

---

## 0. 一句话

三处调用已把 `{signal,timeoutMs,operationId}` 接到模型层，**abort 后不再返回 `ok`**（实测 56–62ms 返回 `cancelled`，而"跑满"是 300ms）；
**缺省不传 `opts` 时行为与改前完全一致**（`status=ok`，模型层收到 `signal:null`）。
`unit_all` 134/134、`gate:full`、`preflight` 全绿。

---

## 1. 改了什么（12 个文件，+97 / −34）

```
 src/models/cerebras.js   |   4 +--
 src/models/claude.js     |   4 +--
 src/models/gemini.js     |   6 +++-
 src/models/gpt.js        |   4 +--
 src/models/grok.js       |   4 +--
 src/models/groq.js       |   4 +--
 src/models/lmstudio.js   |   4 +--
 src/models/mercury.js    |   4 +--
 src/models/mistral.js    |   4 +--
 src/models/ollama.js     |   4 +--
 src/models/openrouter.js |   4 +--
 src/models/prompter.js   |  85 +++++++++++++++++++++++++++++++++++++++++-------
 12 files changed, 97 insertions(+), 34 deletions(-)
新增：tools/opts_cancel_unit.mjs（14 条断言）
```

### 1.1 `src/models/prompter.js`：三处接线（每处 = 入口预取消 + 第 4 参下传 + 生成中取消复查）

| 路径 | 签名变化 | 下传点 | 取消语义 |
|---|---|---|---|
| `promptMemSavingResult` | `(to_summarize, **opts = {}**)` | `chat_model.sendRequest([], prompt, **undefined, callOpts**)` | 预取消 ⇒ `cancelled`；生成中被取消 ⇒ **丢弃本次摘要**（不写 memory） |
| `promptShouldRespondToBotResult` | `(new_message, **opts = {}**)` | 同上 | 预取消/生成中 ⇒ `cancelled`（`failed=true` ⇒ 调用方按"不接话"处理） |
| `promptVisionResult` | `(messages, imageBuffer, **opts = {}**)` | `vision_model.sendVisionRequest(messages, prompt, imageBuffer, **callOpts**)` | 预取消/生成中 ⇒ `cancelled`（这张图的描述不作数） |

三个旧契约包装器（`promptMemSaving` / `promptShouldRespondToBot` / `promptVision`）也各加一个 `opts = {}` 形参并透传 —— 否则"走老 API 的调用点"仍然拿不到取消。

`callOpts` 由文件里**既有**的 `_callOptions(opts)` 产出（与 `promptConvo` / `promptCoding` 完全同口径）：
`{ signal | null, timeoutMs (=min(120s, deadline-now)), operationId | null }`。

### 1.2 `sendVisionRequest`：11 个实现全部同步（没漏）

`grep -rn "sendVisionRequest" src/` 的实现清单与我改后的签名：

| 文件 | 改法 |
|---|---|
| `cerebras` `claude` `gpt` `grok` `lmstudio` `mercury` `mistral` `ollama` `openrouter` | `(…, imageBuffer, **opts = {}**)` + `return this.sendRequest(imageMessages, systemMessage, **undefined, opts**)` |
| `groq` | 同上，但原调用只有 2 参 ⇒ `sendRequest(imageMessages, **undefined, undefined, opts**)` |
| `gemini` | 特例：直接调 SDK。`(…, **opts = {}**)` + `...(opts?.signal ? { config: { abortSignal: opts.signal } } : {})`（与它自己 `sendRequest` 里 t19 的写法**同口径**：`abortSignal` 属于 `config`） |

调用点共 2 处：`prompter.js`（已传第 4 参）；`src/agent/vision/vision_interpreter.js` 只做**存在性判断**（`if (!…sendVisionRequest)`），不实际调用 ⇒ 无需改。
`azure.js` 继承 `GPT`，无自己的 `sendVisionRequest` ⇒ 一并覆盖。

### 1.3 刻意**没**做的事

- **`promptGoalSetting`（`:627`，注释已标 `// deprecated`）未接线** —— 按任务书 §3，第 4 处同类调用点保留原样。它走的是 `chat_model.sendRequest(user_messages, system_message)`，仍然拿不到取消信号；将来若有人复活"自动定目标"功能，需要一并接。
- 没重构、没改默认值（`LLM_MAX_CALL_MS` 仍是 120s，`opts` 缺省仍是 `{}`）、没动 `mindserver.js` / `web/**` / `settings.js` / `src/agent/**`。

---

## 2. 验收（全部实测，日志见 `evidence/fix/`）

### 2.1 探针 14/14 全过（`node tools/opts_cancel_unit.mjs` → exit 0）

```
PASS ① 对照组 promptCodingResult 预取消 ⇒ cancelled  status=cancelled
PASS ② memSaving 预取消 ⇒ cancelled  status=cancelled 0ms 调用次数=0
PASS ② memSaving 进行中取消 ⇒ 非 ok 且提前返回  status=cancelled 59ms（跑满=300ms） 形参=object
PASS ④ memSaving 的 opts 到达模型层  argc=4 keys=signal,timeoutMs,operationId
PASS ② shouldRespond 预取消 ⇒ cancelled  status=cancelled 0ms 调用次数=0
PASS ② shouldRespond 进行中取消 ⇒ 非 ok 且提前返回  status=cancelled 62ms（跑满=300ms） 形参=object
PASS ④ shouldRespond 的 opts 到达模型层  argc=4 keys=signal,timeoutMs,operationId
PASS ② vision 预取消 ⇒ cancelled  status=cancelled 0ms 调用次数=0
PASS ② vision 进行中取消 ⇒ 非 ok 且提前返回  status=cancelled 60ms（跑满=300ms） 形参=object
PASS ④ vision 的 opts 到达模型层  argc=4 keys=signal,timeoutMs,operationId
PASS ③ memSaving 缺省（不传 opts）仍 ok  status=ok argc=4 signal=null
PASS ③ shouldRespond 缺省（不传 opts）仍 ok  status=ok argc=4 signal=null
PASS ③ vision 缺省（不传 opts）仍 ok  status=ok argc=4 signal=null
PASS ③b 旧契约包装器（string/boolean）仍可用
ALL PASS  pass=14 fail=0
```

对照三条验收要求：
1. **对照组仍绿** → ① `status=cancelled`。
2. **新接线生效** → 三条路径各 2 条断言（预取消 + 进行中取消），`status=cancelled`（≠ ok）且 **56–62ms vs 跑满 300ms**。
3. **缺省兼容** → 三条路径 `status=ok`、模型层收到 `signal=null`（`_callOptions({})` 的合法缺省，与 `promptCodingResult` 同口径），且旧契约包装器返回类型不变。

> 探针设计上的两个关键点（第一版踩过，已修）：
> ① 记录器在 abort 时**必须返回 `failedReply(...)` 而不是抛异常** —— 全仓适配器契约是 `sendRequest` 永不抛，探针若让它抛，测的就不是真实契约。
> ② 缺省兼容的断言判"没有真 signal"（`signal === null`），不是判 `=== undefined` —— 否则会把正确实现判红。

### 2.2 门禁

| 命令 | 结果 |
|---|---|
| `node tools/unit_all.mjs` | **exit 0**，`134/134 个脚本通过，4 个跳过`（改前 133，新增本探针 1 个） |
| `npm run gate:full` | **exit 0**（`lint:hard` no-undef=0 / no-floating-promise=0；`134/134`） |
| `node tools/preflight.mjs` | **exit 0**（"启动自检通过"） |
| `node tools/adapters_signal_unit.mjs` | **exit 0**，`38 passed, 0 failed`（含"19 个适配器文件全部消费第 4 参 缺=[]"） |
| `node tools/r4_model_hemo_unit.mjs` | exit 0，40 passed |
| `node tools/result_type_unit.mjs` | exit 0，51 passed |

`npx eslint src/models/ tools/opts_cancel_unit.mjs` → **0 problem**。

---

## 3. 过程中的两个坑（诚实记录）

1. **换行符污染**：我用 Python 脚本改文件时默认写成了 **CRLF**，导致 `git diff` 从 `+97/−34` 膨胀成 `+2139/−2076`（每个文件全行变红）。
   已全部转回 **LF**（与 HEAD 一致），现在 `git diff --stat` 就是干净的小 diff；`grep -c '\r'` 对 12 个文件均为 **0**。
   教训：在这种全 LF 仓库里，任何脚本化改写都必须 `newline=''` / 二进制写，否则 diff 会淹没真正的改动。
2. **探针首版两处设计错**（见 §2.1 末尾引述），都在跑门禁前修掉了，没有污染结论。

---

## 4. 影响面与残留

- **行为变化只在"有 signal/deadline 时"**：没有 signal 时调用链与改前逐字等价（多一层 `_callOptions({})` 的纯计算）。
- **真正的中断能力取决于适配器**：11 个适配器都已把 `opts` 传给 SDK/fetch（`sdkCallOptions` / `abortSignal` / `fetchWithDeadline`）。
  `gemini` 的 vision 走 `config.abortSignal`，与其 `sendRequest` 一致；若某天 SDK 版本不接受该键，退化为"仍跑满"，不会报错。
- **残留**：`promptGoalSetting`（deprecated）未接线 —— 见 §1.3。
- **未覆盖**：本次只做了离线单测。真机上"`!stop` 时记忆摘要/看图立刻停"仍需一次带模型的实测（属 E2E 车道）。
