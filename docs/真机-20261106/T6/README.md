# T6 —— 收费模型真实调用与失败路径（MOD-001 / MOD-006）

> 真机验收，2026-11-06。只写本目录，未改产品源码。key 全程打码（前 4 + 后 2），测完已清空。

## 一句话结论

| 项 | 判定 |
|---|---|
| **模型通路** | **通**。走项目自己的 `createModel()` → Claude 适配器 → `https://api.llmgo.net`，真实返回 291 字符内容，`recordUsage` 记下 **input=54 / output=503** tokens，**实际只发 1 次请求** |
| **MOD-001** | **修复只做了一半**：`gpt.js` / `deepseek.js` / `hyperbolic.js` 已修（单次请求 + 打截断标记）；**`qwen.js` / `vllm.js` / `grok.js` / `mercury.js` / `novita.js` / `lmstudio.js` 6 个适配器仍原样保留缺陷** —— 实测同一轮对话被放大成 **4 次**付费请求 |
| **MOD-001（Claude 通路，本项目当前在用）** | 不重复请求（无递归代码），但**截断不打标记** ⇒ 上层无法区分"说完了"与"被切了" |
| **MOD-006** | **修复成立**。裸 `fetch` 实测 8s 仍未结束（无内置总超时）；`fetchWithDeadline(3s)` 与**真实 Ollama 适配器**都在 ~3.0s 按 `code=LLM_TIMEOUT` 中止 |
| **★ 新发现（预算护栏失效）** | 代理**根本不遵守 `max_tokens`**：请求 `max_tokens=16`，实际产出 **503 tokens（≈31×）**。⇒ "显式传小 max_tokens 就能省钱"在本代理上**是假的** |

---

## 0. 交付物

| 文件 | 作用 |
|---|---|
| [probe-live-a.mjs](probe-live-a.mjs) | A：走项目模型层真发 1 次最小请求（含 fetch 拦截器） |
| [live-a-result.json](live-a-result.json) | A 的**原始**落盘结果（含拦截器失效的事实，未修饰） |
| [analyze-live-a.mjs](analyze-live-a.mjs) | 对上述原始结果做**正确推导**（把"能证明/证明不了"分开） |
| [live-a-analysis.json](live-a-analysis.json) | 修正后的判定 + 费用估算 + 预算账 |
| [probe-mod001-stub.mjs](probe-mod001-stub.mjs) | B：MOD-001 的**确定性触发**（真实适配器 + 假 transport，0 费用） |
| [mod001-stub-result.json](mod001-stub-result.json) | B 的逐适配器请求次数与标记情况 |
| [probe-mod006.mjs](probe-mod006.mjs) | C：MOD-006 对照实验 + `GET /v1/models` 取证（0 token） |
| [mod006-result.json](mod006-result.json) | C 的原始结果 |

---

## 1. A：真发一次最小请求 —— **通**

**通路**：`src/models/_model_map.js:createModel(profile)` → `Claude` 适配器 → `@anthropic-ai/sdk@0.17.2` → `https://api.llmgo.net`

**profile**（与任务书给的一致）：
```json
{"api":"anthropic","model":"deepseek-v4.1-flash","url":"https://api.llmgo.net","params":{"max_tokens":16}}
```

**零网络预检**（先确认形状，避免白发）：

```
constructor : Claude
model_name  : deepseek-v4.1-flash
params      : {"max_tokens":16}          ← 未被 claude.js:27-34 顶成 4096
baseURL     : https://api.llmgo.net
key present : true len= 67
```

**真实调用结果**：

| 项 | 实测值 |
|---|---|
| key（打码） | `sk-1…0e` (len=67) |
| wall-clock | **6101 ms** |
| 适配器返回 | 291 字符：`1,2,3,…,99,100`（完整数完，非 `[LLM_ERROR]` 标记） |
| 项目侧记账 | `[llm] model=deepseek-v4.1-flash prompt=54 completion=503` |
| `usageTotals()` | `{calls:1, prompt:54, completion:503, missing:0}` |
| **实际请求次数** | **1** |
| 传输层 HTTP 状态 | 模型 POST **未捕获**（见下方说明）；同域名 `GET /v1/models` = **HTTP 200** |

**响应原文（打码后）**——适配器取到的文本内容（`content[0].text`）：

```
1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,
35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,
66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,
97,98,99,100
```

**关于"HTTP 状态为什么没抓到"（如实说明）**：我原本用**全局 `fetch` 拦截器**统计请求次数与状态，但 `@anthropic-ai/sdk@0.17.2` 走它自己的 transport shim，**不经过 `globalThis.fetch`** ⇒ 拦截器记到 0 次、状态记成 `null`，`probe-live-a.mjs` 当时据此写出"不通"，**那是我脚本的误判，不是通路问题**。

正确判据不依赖拦截器（以下三条都在同一份 `live-a-result.json` 里）：
1. 适配器返回了 291 字符**非失败标记**的真实内容；
2. `recordUsage` 记下 `prompt=54 / completion=503`（`usage` 只可能来自真响应）；
3. `usageTotals().calls === 1`。

④ 旁证：同一 key、同一域名下 `GET /v1/models` 实测 **HTTP 200**。
修正推导见 [live-a-analysis.json](live-a-analysis.json)；`probe-live-a.mjs` 的判据已修好（注释里标明已落盘结果出自修补前版本，未回改证据）。

### 费用估算

代理没有公开价目表，模型 id `deepseek-v4.1-flash` 是代理自定义的，所以**不报结算金额**，只把实测 token 数代入几个公开参考档位给量级：

| 参考档位 | 费用 |
|---|---|
| DeepSeek-V3 官价（缓存未命中 $0.27/$1.10 per M） | **$0.000568**（≈¥0.0040） |
| DeepSeek-V3.1 官价（$0.56/$1.68 per M） | $0.000875（≈¥0.0062） |
| 低价档参考（$0.14/$0.28 per M） | $0.000148（≈¥0.0011） |

⇒ **一次最小请求 ≈ 1e-4 ~ 1e-3 美元量级**，可安全重复做验收。

### ★ 新发现：代理不遵守 `max_tokens`，预算护栏是假的

请求 `max_tokens: 16`，实际输出 **503 tokens**。

- 这不是项目侧没传（`claude.js:27-34` 只在 `max_tokens` 缺失时才顶 4096，这里传了 16；`...this.params` 会把 `max_tokens:16` 展开进 `messages.create`）；
- 也不是我校验错（`params` 预检确认 `{"max_tokens":16}`）；
- 结论：**该代理忽略 `max_tokens`**。

**两个直接后果**：
1. **"每次只花 16 输出 token"的省钱前提不成立** —— 有人按"传 max_tokens:16 就安全"去设计批量验收，实际每次可能烧 30 倍额度；
2. 我**没能用 `max_tokens` 制造出"真实截断"** —— 模型把 1..100 数完了，所以 §2 的"截断被误判成上下文超限"无法靠真机复现，改用确定性触发（见下）。

---

## 2. B：MOD-001 —— 6 个适配器仍在重复请求

### 2.1 缺陷原貌（在源码里仍然存在）

`qwen.js:37` / `vllm.js:51` / `grok.js:39` / `mercury.js:45` / `novita.js:42` / `lmstudio.js:32` 一字未改：

```js
if (completion.choices[0].finish_reason == 'length')
    throw new Error('Context length exceeded');       // ← 把"输出额度用完"当成"输入超限"
...
catch (err) {
    if (errMessage(err) === 'Context length exceeded' && turns.length > 1)
        return await this.sendRequest(turns.slice(1), systemMessage);   // ← 白删历史 + 再花一次钱
}
```

`finish_reason == 'length'` 是**输出**被 `max_tokens` 截断，缩短历史对输入侧毫无帮助，但每递归一次就多一次**付费请求**。

### 2.2 为什么用"真实适配器 + 假 transport"

真发的话单条用例就要 4~6 次付费请求，直接违反 ≤3 次预算。这里调用的是**产品源码里真实的 `sendRequest`**（递归、判断、标记全走真代码），只把最外层 SDK client 换成**计数桩** ⇒ 触发条件 100% 确定，费用 0。

### 2.3 实测结果（`mod001-stub-result.json`）

| 适配器 | 单轮输入的 turns | **实际请求次数** | 结果 |
|---|---|---|---|
| `qwen.js` | 4 | **4** | DUP-REQUEST |
| `vllm.js` | 4 | **4** | DUP-REQUEST |
| `grok.js` | 4 | **4** | DUP-REQUEST |
| `mercury.js` | 4 | **4** | DUP-REQUEST |
| `novita.js` | 4 | **4** | DUP-REQUEST |
| `lmstudio.js` | 4 | **4** | DUP-REQUEST |
| `deepseek.js` | 4 | 1 | ✅ OK（单次 + 已打 `[LLM_TRUNCATED]`） |
| `gpt.js` | 4 | 1 | ✅ OK（单次 + 已打 `[LLM_TRUNCATED]`） |
| `gpt.js`（反向对照：真 `context_length_exceeded`） | 4 | 2 | ✅ OK（**应当**裁历史重试 1 次） |
| **`claude.js`（本项目在用）** | 4 | **1** | ⚠️ SILENT-TRUNCATION |

各次请求携带的 messages 长度衰减（`qwen`）：`4 → 4 → 2 → 2`；`grok`：`5 → 4 → 3 → 2` —— 正是"每次丢掉一段历史再重发"的指纹。

**放大倍数 = turns 数**：turns=4 就 4 次请求；真实会话几十轮 ⇒ 一次截断就能烧掉几十次调用。这解释了报告里"实测 6 次请求全失败"的现象。

### 2.4 判据边界（`isContextLengthError`）

| 输入 | 判为上下文超限？ | 评价 |
|---|---|---|
| `Error('Context length exceeded')` | **HIT** | ← 正是 6 个适配器自己造出来的假信号，所以 `isContextLengthError` 也救不了它们（它们压根没调用它） |
| `code=context_length_exceeded` | HIT | 正确 |
| `message 含 maximum context` | HIT | 正确 |
| `message 含 prompt is too long` | HIT | 正确 |
| `message 含 max_tokens`（输出截断的措辞） | miss | 正确（`finish_reason=length` 不该算超限） |
| `ECONNRESET` | miss | 正确 |

### 2.5 Claude 通路的单独结论

`claude.js` **既没有** `finish_reason/stop_reason` 判断，**也没有** `markTruncated`：

- ✅ 好消息：既然没有递归分支，**不可能**因为截断而重复计费；
- ❌ 坏消息：截断被**静默**当正常回答返回（`markedTruncated=false`），上层 `isTruncatedReply()` 永远为假 ⇒ 被切一半的回答会被当成"模型说完了"写进 history / 说给玩家。

**建议**（不在本任务改动范围）：把 `gpt.js` 的 `markTruncated` 那 3 行同样加到 `claude.js`（`stop_reason === 'max_tokens'` → `markTruncated`），并给 6 个旧适配器换掉 `finish_reason=='length' → throw` 的写法。

---

## 3. C：MOD-006 —— 修复成立

### 3.1 传输层取证（免费）

```
GET https://api.llmgo.net/v1/models   →  HTTP 200
模型数: 1     modelIds: ["deepseek-v4.1-flash"]
```

⇒ 与上游转述一致（**唯一可用模型**就是 `deepseek-v4.1-flash`），并且这是我这一轮自己采的原文，不是转述。

### 3.2 对照实验（打 RFC 5737 TEST-NET-1 `192.0.2.1:81`，不经过任何模型）

| 路径 | 结果 | 用时 |
|---|---|---|
| **裸 `await fetch(...)`**（缺陷原貌） | **STILL-PENDING** —— 观察窗 8s 结束时**仍未结束** | > 8007 ms |
| `fetchWithDeadline(url, {}, {timeoutMs: 3000})` | rejected，`name=AbortError`，**`code=LLM_TIMEOUT`** | **3007 ms** |
| **真实 Ollama 适配器 `send()`**（`params.timeoutMs=3000`） | rejected，**`code=LLM_TIMEOUT`**，日志 `[ollama] 请求被终止：timeout` / `[llm-error] code=LLM_TIMEOUT tag=ollama 模型请求超过总期限 3000ms` | **3006 ms** |

结论：**裸 fetch 确实没有内置总超时**（这就是 MOD-006 的原缺陷），而 `fetchWithDeadline` 与**产品路径**都能按总期限中止，并给出可判别的 `code=LLM_TIMEOUT`。

### 3.3 默认兜底与覆盖范围

- `DEFAULT_LLM_TIMEOUT_MS = 120000`（未配 `timeoutMs` 时的兜底）。
- `ollama.js:15` 支持 `params.timeoutMs` 覆盖；`hyperbolic.js:12` 把 `timeoutMs` 硬设为 `undefined` ⇒ 恒用 120s 兜底，**不可配**（不是缺陷，但极端网络下用户没法自己调短）。
- 全仓已无裸 `await fetch(` 的模型适配器：仅 `ollama.js:98`、`hyperbolic.js:59` 两处 fetch，且都走 `fetchWithDeadline`。

---

## 4. 预算账（如实记录，含超支）

| 项 | 预算 | 实际 | 说明 |
|---|---|---|---|
| 出网模型调用 | ≤ 3 次 | **1 次** | 只发了一次 POST |
| 免费 GET | — | 1 次 | `GET /v1/models`，0 token |
| 不可达地址尝试 | — | 1 次 | MOD-006，不经过模型，0 token |
| **输出 token** | **≤ 500** | **503** | **超 3** |

**超支原因不是脚本没设上限，而是代理忽略了 `max_tokens=16`**（见 §1 末）。发现后我**没有**再发起任何模型调用（后续 MOD-001 改用 0 费用的桩探针），否则会继续成倍超支。

---

## 5. 收尾：key 已清空 + 工作树干净

| 步骤 | 结果 |
|---|---|
| 清空前 `ANTHROPIC_API_KEY` 长度 | 67 |
| 清空后长度 | **0**（空串） |
| 其它 15 个键 | 完好未动（`OPENAI_API_KEY` 仍 len=67） |
| `git status --porcelain` | **空 —— 工作树干净** |
| `git check-ignore -v keys.json` | 命中 `.gitignore:9:keys.json` |
| 影响面 | **没有任何 profile 引用 `api: anthropic`** ⇒ 清空不影响其他成员的既有配置；需要复跑时把 key 写回 `ANTHROPIC_API_KEY` 即可 |
| key 打码合规 | 3 份结果 JSON 均**不含**完整 key（逐字节校验通过） |

---

## 6. 复现命令

```powershell
cd E:\我的世界ai

# B：MOD-001 确定性触发（0 费用，随时可跑）
node docs\真机-20261106\T6\probe-mod001-stub.mjs

# C：MOD-006 对照 + GET /v1/models（0 token）
node docs\真机-20261106\T6\probe-mod006.mjs

# A：真发一次（★ 会花钱；跑前先把 key 写回 mindcraft\keys.json 的 ANTHROPIC_API_KEY）
cd mindcraft
node ..\docs\真机-20261106\T6\probe-live-a.mjs
cd ..
node docs\真机-20261106\T6\analyze-live-a.mjs      # 正确推导（拦截器不可靠，需看这份）
```

> 若要连模型 POST 的 HTTP 状态一起抓：给 `new Anthropic({ fetch: myFetch })` 注入自定义 fetch
> （SDK 0.17.2 支持 `opts.fetch`），而不是去 patch `globalThis.fetch`。本轮因预算原因未重跑。

---

## 7. 结论一览

| 断言 | 结论 | 证据强度 |
|---|---|---|
| 收费模型真能调通 | **通** | 强：真实内容 + usage 记账 + `GET /v1/models` 200 |
| 项目侧 `recordUsage` 真记账 | **是**（`calls=1 prompt=54 completion=503`） | 强 |
| `max_tokens` 能约束花费 | **不能**（请求 16 实出 503） | 强（预检 + 记账双向确认） |
| MOD-001 已修好 | **只修了 3/9**；6 个适配器仍 4× 放大 | 强：真实适配器代码 + 计数桩，逐请求 messages 衰减可查 |
| MOD-001 在 Claude 通路会重复计费 | **不会**（无递归） | 强 |
| MOD-001 截断在 Claude 通路会被标记 | **不会（静默截断）** | 强 |
| MOD-006 裸 fetch 无总超时 | **确认**（8s 仍未结束） | 强 |
| MOD-006 修复在真实适配器路径生效 | **生效**（3.006s / `LLM_TIMEOUT`） | 强 |
