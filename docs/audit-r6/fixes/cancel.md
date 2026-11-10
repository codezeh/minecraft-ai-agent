# R6 #12 取消链修复：四个模型出口把 opts 接上

> 缺陷：R6 #12「三个模型出口从未接上取消信号 —— prompter 的 t29 修复在生产里是死代码」
> 触发场景（audit-r5 遗留 C）：`!stop` 之后，**记忆摘要 / 代码生成 / 看图**三条路径仍跑满到适配器 120s 上限。
> 本次改动：**只在调用点接信号**，不改三条路径对返回值的使用方式，不改 prompter 的既有逻辑。

---

## 1. 根因（一句话）

取消信号的唯一来源是 `action_manager._executeAction` 里建好并挂到 `agent.currentOperation`
的那个 operation（`action_manager.js:357-359`）：

```js
const op = this._newOperation(timeout);   // { id, deadline, ac }
this.currentOperation = op;
if (this.agent) this.agent.currentOperation = op;
```

`!stop` / 面板停止 / 动作总超时 / 被新动作取代 —— 全部收敛到同一个 `abort`。
prompter 侧（t29/t4）**已经**支持 `opts = { signal, deadline, operationId }`
（`prompter.js:476/540/647` 都过 `_callOptions(opts)` 并传给适配器），

但三个消费端**一个都没传这个可选参数**，于是 `_callOptions({})` 得到：

```
signal = null      → sendRequest(..., opts) 里 opts.signal 恒 null → abort 无路可走
timeoutMs = 120000 → 只剩适配器自身 120s 上限
operationId = null → 迟到结果连"属于哪次操作"都判不出来
```

⇒ t29 的修复在生产里是**死代码**；`!stop` 在"她正在思考"这个最常见时刻不生效，
而且迟到的摘要会**照常落盘**、迟到的代码会**照常执行**。

---

## 2. 调用点前后对比（实际 5 处 = 报告点名的 3 处 + 同族 2 处旧出口）

报告点名 3 处（带类型出口）。核对时发现同一条链上还有**第 4、第 5 处**：
`history.js` 与 `vision_interpreter.js` 里各自保留的**旧字符串出口兜底分支**
（`promptMemSaving` / `promptVision`）同样不带 opts，且 prompter 侧的旧包装器
本来就收 `opts`（`prompter.js:526/640`）。这两个分支在真实 Prompter 下不执行，
但一旦 prompter 被替换/桩化就会走上它 —— 既然形状已经允许，一并接上（成本 2 行）。

### 2.1 总表

| # | 文件 | 出口 | 改前 | 改后 | 备注 |
|---|---|---|---|---|---|
| ① | `mindcraft/src/agent/history.js` | `promptMemSavingResult`（带类型） | `:106` | `:142` | 报告点名 |
| ② | `mindcraft/src/agent/history.js` | `promptMemSaving`（旧出口兜底） | `:114` | `:150` | **第 4 处**（同函数 else 分支） |
| ③ | `mindcraft/src/agent/coder.js` | `promptCodingResult` | `:73` | `:100` | 报告点名 |
| ④ | `mindcraft/src/agent/vision/vision_interpreter.js` | `promptVisionResult`（带类型） | `:116` | `:141` | 报告点名 |
| ⑤ | `mindcraft/src/agent/vision/vision_interpreter.js` | `promptVision`（旧出口兜底） | `:128` | `:153` | **第 5 处**（同方法兼容分支） |

> 行号"改后"含新插入的 `operationCallOpts()` 帮助函数（各文件 `:28`）与注释，所以不是精确 +36/+27 的机械平移。

### 2.2 `history.js`（①②）

```diff
 // 改前 (:106 / :114)
-            const typed = await prompter.promptMemSavingResult(turns);
+            const typed = await prompter.promptMemSavingResult(turns, operationCallOpts(this.agent));
 ...
-            const nextMemory = await prompter.promptMemSaving(turns);
+            const nextMemory = await prompter.promptMemSaving(turns, operationCallOpts(this.agent));
```

### 2.3 `coder.js`（③）

```diff
 // 改前 (:73)
-            const typed = await this.agent.prompter.promptCodingResult(messages_copy);
+            const typed = await this.agent.prompter.promptCodingResult(messages_copy, operationCallOpts(this.agent));
```

### 2.4 `vision_interpreter.js`（④⑤）

```diff
 // 改前 (:116 / :128)
-            const r = await prompter.promptVisionResult(messages, imageBuffer);
+            const r = await prompter.promptVisionResult(messages, imageBuffer, operationCallOpts(this.agent));
 ...
-        const raw = await prompter.promptVision(messages, imageBuffer);
+        const raw = await prompter.promptVision(messages, imageBuffer, operationCallOpts(this.agent));
```

### 2.5 折算函数（三个消费端文件各一份，`:28`）

```js
function operationCallOpts(agent) {
    const op = agent?.currentOperation ?? null;
    if (!op) return {};
    return {
        signal: op.ac?.signal ?? null,
        deadline: op.deadline ?? null,
        operationId: op.id,
    };
}
```

三点设计取舍，都是"不扩大爆炸半径"：

1. **没有在飞的操作 ⇒ 返回 `{}`**（不是 `{signal:null, deadline:null, operationId:null}`）。
   这样 `_callOptions({})` 走的就是**改前那条缺省路径**，手动调用 / 离线单测 / 记忆链
   在无操作时行为逐字不变（`tools/opts_cancel_unit.mjs ③` 钉的就是这条）。
2. **帮助函数就地复制 3 份，不抽公共模块**。抽到 `models/_shared.js` 或
   `prompter.js` 都会让 `history.js` 反向依赖模型层/命令表（`prompter.js` 顶层
   `import '../agent/commands/index.js'`，而 `commands/actions.js` 又挂着
   `composite_registry` 一长串），为 6 行代码引入一个潜在循环依赖不值得。
   本批写作用域也只有这三个消费端文件 + `prompter.js`。
3. **`deadline` 原样下传**，不在调用点折算成 `timeoutMs`：折算点全仓唯一
   （`prompter._callOptions`），两套时钟合并的那条不变量（`timeoutMs = min(120s, deadline - now)`）继续只有一个主人。

---

## 3. 为什么"只接信号"就够了（返回值用法未变）

| 路径 | 取消后 prompter 返回 | 现有消费逻辑 | 结果 |
|---|---|---|---|
| 记忆摘要 | `status=cancelled` ⇒ `failed=true` | `if (typed.failed \|\| ...) { warn; return; }` | **保留旧摘要，不覆盖 memory.json**（正是 #12 "迟到摘要照常落盘"的反面） |
| 代码生成 | `status=cancelled` ⇒ `failed=true`，`content=''` | `if (typed.failed) warn…; const res = typed.hasContent ? typed.content : ''` → `isNoCodeReply('')` ⇒ 按"没写代码"处理 | 不执行任何东西，最终 `'Action failed, agent would not write code.'` |
| 看图 | `status=cancelled` ⇒ `status !== ok` | `if (r.status !== STATUS.OK) { warn; return null; }` | **不写进上下文** |

三条都没有新增分支、没有改判据、没有动 `catch`/重试语义 —— 只是把"这一次能不能被打断"接上。

---

## 4. 验证

### 4.1 契约/回归单测（任务指定 + 相关）

| 命令 | 结果 |
|---|---|
| `node tools/opts_cancel_unit.mjs` | **14 passed, 0 failed**（三处 opts 到达模型层 `argc=4 keys=signal,timeoutMs,operationId`；缺省不传仍 ok） |
| `node tools/agent_cancel_late_reply_unit.mjs` | **7 passed, 0 failed** |
| `node tools/t4_op_signal_unit.mjs` | **6 passed, 0 failed**（signal 同一实例、deadline 反算、迟到结果三重不得、`!stop` 复用同一 opId） |
| `node tools/result_type_unit.mjs` | **51 passed, 0 failed**（含 `promptVisionResult` / `promptVision` 旧名仍是字符串） |
| `node tools/r4_misc_web_unit.mjs` | **41 passed, 0 failed**（视觉旧出口的标记净化未变） |
| `node tools/bot007_010_history_unit.mjs` | **20 passed, 0 failed**（记忆摘要/落盘链） |
| `node tools/prompter_path_unit.mjs` | **20 passed, 0 failed** |
| `node tools/adapters_signal_unit.mjs` | **38 passed, 0 failed**（19 个适配器全部消费第 4 参，取消能走到 fetch/SDK） |
| `node tools/llm_usage_unit.mjs` | **123 passed, 0 failed** |
| `node tools/mod_batch4_unit.mjs` | **33 passed, 0 failed** |
| `npm run gate` | **exit 0**（含 `lint:hard` no-undef / no-floating-promise 0，前缀 import 规矩 0 违规） |

`tools/` 下没有 `vision_*` 单测；视觉相关断言分布在 `result_type_unit.mjs`、
`r4_misc_web_unit.mjs`、`opts_cancel_unit.mjs`（上表已覆盖）。

### 4.2 生产调用点端到端（一次性探针，`tmp/r6_cancel_probe.mjs`，tmp/ 已被 .gitignore 覆盖）

用 `Object.create(原型)` + 记录器 prompter（与 `tools/r4_model_hemo_unit.mjs` 同款手法），
**直接调生产函数**（`History.summarizeMemories` / `Coder.generateCode` / `VisionInterpreter._visionAnalysis`），
断言"调用点确实把三件套递下去了"，而不是只测 prompter 一侧：

```
PASS ① history→promptMemSavingResult 收到取消三件套  op=probe:1 deadline=… sigSame=true
PASS ① 取消的摘要不覆盖 memory.json（迟到结果不落盘）
PASS ② history→promptMemSaving（旧出口） 收到取消三件套
PASS ③ 无操作时 opts={}（prompter 走旧缺省）
PASS ③ 正常摘要照旧写入（功能没被关掉）
PASS ④ coder→promptCodingResult 收到取消三件套
PASS ④ 返回值用法未变（仍是字符串）  "Action failed, agent would not write cod"
PASS ⑤ vision→promptVisionResult 收到取消三件套 / 取消 ⇒ 返回 null（不写进上下文）
PASS ⑥ vision→promptVision（旧出口） 收到取消三件套 / 取消 ⇒ 返回 null
ALL PASS  pass=11 fail=0
```

---

## 5. 遗留与观察（不在本任务写作用域，交回队长/下一批）

1. **同类未接点：`conversation.js:308`**
   `await agent.prompter.promptShouldRespondToBot(received.message)` ——
   `promptShouldRespondToBotResult` 是 t29 修好的三个出口之一，但它的调用点同样不传 opts。
   该文件不在本任务的写作用域内，**未改**，建议单开一条（同款 1 行改动）。
2. **coder 取消后的"空转重试"**：`promptCodingResult` 返回 `cancelled` 后，`generateCode`
   仍按"没写代码"走 `MAX_NO_CODE` 分支，最多再调 3 次才放弃。每次都在**请求发出前**
   被 `prompter` 的预检拦下（`signal.aborted`），**不产生网络请求、无 120s 等待**，
   实测 4 次调用毫秒级结束。按"不改返回值用法"的要求本次不动；若日后要更干净，
   应在 coder 循环里认 `status===cancelled` 立刻返回，而不是靠 no-code 次数耗尽。
3. **`deadline-now` 为负被抬成 1000ms**（R6 #37）：本次已把 `deadline` 送到 prompter，
   但"过期期限仍然发请求"这条仍在 `_callOptions` 里，属 #37，不在本任务范围。

---

## 6. 改动文件

- `mindcraft/src/agent/history.js`（`operationCallOpts()` + 2 个调用点）
- `mindcraft/src/agent/coder.js`（`operationCallOpts()` + 1 个调用点）
- `mindcraft/src/agent/vision/vision_interpreter.js`（`operationCallOpts()` + 2 个调用点）

`mindcraft/src/models/prompter.js` **未改**：t29/t4 的接线本来就在，缺的只是上面这些调用点。
