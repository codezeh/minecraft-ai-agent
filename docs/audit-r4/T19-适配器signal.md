# T19 · 适配器 signal 接线（取消要真的到网络层）

> 对应 A5 §1.2「0/19 适配器接受取消信号」+ 架构收敛项(2) 的第 5 跳。执行：model-layer（t19）。
> 口径：**已实测** = 本次真跑并贴输出；**静态确证** = 逐行读过；**不支持** = 明确标注，不假装。

## 0. 一句话

t4 把 `operationId + deadline + AbortSignal` 下传到 `prompter.sendRequest(turns, sys, stop_seq, callOpts)`
的第 4 参；本任务把这第 4 参在 **17 个适配器**里逐个接到**网络层**，并为每个适配器留了一条可执行证据。

## 1. 契约

适配器签名统一为：`sendRequest(turns, systemMessage, stop_seq, opts = {})`，其中
`opts = { signal?: AbortSignal, timeoutMs?: number, operationId?: string }`（prompter 的 `_callOptions()` 产出）。

两个新助手（`src/models/_shared.js`）：

| 助手 | 作用 |
|---|---|
| `sdkCallOptions(opts)` | 映射成 SDK 的 **per-call** 请求选项：`signal` + `timeout`/`timeoutMs`（OpenAI 系认 `timeout`，Mistral 认 `timeoutMs`，两边都给、各自忽略不认识的键）。per-call 覆盖构造期默认值（t1 的 120s / 1 次重试），**调用方更短的 deadline 以调用方为准** |
| `combineSignals(...sigs)` | 合并「外部取消」与「本适配器期限」：优先 `AbortSignal.any`，否则手工桥接（任一 abort 就 abort） |

## 2. 逐适配器落点

| 类 | 适配器 | 接法 | 证据强度 |
|---|---|---|---|
| OpenAI 兼容 | gpt（chat 支路 + **responses 支路**）、azure（继承 GPT）、deepseek、grok、mercury、novita、openrouter、qwen、lmstudio、vllm、groq、cerebras | `.create(body, sdkCallOptions(opts))` | **identity**：SDK 收到的 `options.signal` 就是调用方实例 |
| Anthropic | claude | `messages.create(body, sdkCallOptions(opts))` | identity |
| Google | gemini | `config.abortSignal`（实测该字段在 `GenerateContentConfig`，不在顶层参数） | identity |
| Mistral | mistral | `chat.complete(body, sdkCallOptions(opts))` | **静态**（`#client` 私有字段，无法打桩 —— 单测里**显式标注**，不静默跳过） |
| 流式合并 | huggingface | `{ signal: combineSignals(opts.signal, dl.signal) }` 走 `chatCompletionStream` 第二参 | **propagate**（合并后非同一实例，验「外部 abort ⇒ 底层 signal aborted」） |
| 流式合并 | replicate | `run/stream({ input, signal: combineSignals(...) })` | propagate |
| 裸 fetch | ollama | `send(endpoint, body, opts)` → `fetchWithDeadline(request, { signal: opts.signal }, { timeoutMs: opts.timeoutMs ?? this.timeoutMs })` | **行为级**（abort ⇒ <200ms 返回失败） |
| 裸 fetch | hyperbolic | `fetchWithDeadline(url, { ..., signal: opts.signal }, { timeoutMs: opts.timeoutMs ?? this.timeoutMs })` | 行为级 |

补充：截断重试的递归分支（deepseek/grok/lmstudio/mercury/novita/qwen/vllm/gpt/hyperbolic/ollama）
**都把 `opts` 继续下传** —— 否则「第一次超时后裁历史重试」那条路会丢掉取消能力。

## 3. 验收证据（已实测）

```
node tools/adapters_signal_unit.mjs → ALL PASS: 38 passed, 0 failed
```

四档判据（每一档都可见，无静默跳过）：
1. **identity（13 个 OpenAI 兼容系 + claude + gemini）**：`sendRequest(..., {signal})` 时 SDK 收到的
   `options.signal === 调用方实例`，且 `options.timeout === 250`（deadline 也真的下去了）。
2. **propagate（huggingface / replicate）**：合并信号后 identity 不成立，改为断言
   「外部 `abort()` ⇒ 底层拿到的 signal 进入 `aborted`」——证明是**合并**而不是各传各的。
3. **行为级（ollama / hyperbolic）**：挂住的假 fetch + 30ms 后 `abort()` ⇒
   **<200ms** 以 `[LLM_ERROR]` 返回（实测 30~70ms），**不是**等满 60000ms 的 timeout。
4. **静态（mistral）**：`#client` 私有，无法打桩 —— 单测断言源码形态并**显式标注证据强度=静态**。

反向证据（防"把没 signal 的情况搞坏"）：不传 `signal` 时 ollama 照常成功；
huggingface 不传外部 signal 时仍有期限信号（t1 的 H5 不回退）。

覆盖清点：`⑥` 一条用例扫 19 个适配器文件，逐个断言「签名有 opts」+「signal 真的用出去」，
漏一个就 FAIL（azure 继承 GPT，单列说明）。

## 4. 未做 / 边界（老实说明）

1. **只接了 `sendRequest` 的第 4 参**；`sendVisionRequest` 仍是 3 参（视觉请求目前不带取消）。
2. **prompter 只有 `promptConvoResult` / `promptCodingResult` 下传 callOpts**；`promptMemSaving` /
   `promptShouldRespondToBot` / `promptVision` 还没有 opts 形参（t4 的 4 跳只覆盖前两条）。这是
   prompter 层的增量，不属本任务（避免与 t4 抢同一段代码）。
3. **取消的"结果语义"仍是 `[LLM_ERROR]`**：适配器把 AbortError 折成 `failedReply('... aborted')`，
   由 prompter 的 `_callOptions`/ModelResult 侧判成 `cancelled`。即"取消"与"超时"在适配器层不可分，
   在 prompter 层才分开（`errorCode=TIMEOUT/CANCELLED`，靠文案推断，见 result.js `inferErrorCode`）。
4. `replicate` 的 `embed()` 仍不传 signal（不是对话通路，走 `run()`）。
