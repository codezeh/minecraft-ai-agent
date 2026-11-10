# R6 进程与记忆存活修复（#13 / #14 / #15 / #17）

> 缺陷：R6 报告四条「一只 bot 的小故障把整机 / 整份记忆带走」的存活类缺陷。
> 共同病根：**故障路径上没有"隔离"这一档** —— 要么往上抛（打挂进程）、要么 `exit(0)`（伪装成正常结束）、
> 要么 `killAll()`（关掉整个 mindserver）、要么直接把记忆当"没存过"。
>
> 本批只做三件事：**能重试就重试、能隔离就隔离、必须退出时必须给出可区分的退出码；
> 记忆能抢救就抢救，抢救不到要吵。**
>
> **内容归属说明（重要）**：`src/agent/history.js` 同期有两拨改动 ——
> **t3 已完成的是 R6 #12 取消链接线**（`operationCallOpts(agent)`：定义在 `:28`，
> 两个调用点当前在 `:150` / `:158`，行号会因本批插入的注释整体平移几行）。
> **本节 #13/#14 的改动与它无关，也没有碰它**：
> 本文档只描述 `save()` / `load()` 两个**函数内部**的错误处理与自愈路径，
> 调用点传参（`promptMemSavingResult(turns, operationCallOpts(this.agent))` /
> `promptMemSaving(turns, operationCallOpts(this.agent))`）逐字未变。
> 请 gate-runner 按**内容归属**复核，勿把 t3 的 opts 接线算进本批。

| 缺陷 | 位置 | 一句话结论 | 本文章节 |
|---|---|---|---|
| #13 | `history.js:save()` + 3 处 fire-and-forget 调用点 | 落盘失败 ⇒ unhandled rejection ⇒ **整个 agent 进程崩** | §A.1 |
| #14 | `history.js:load()` | `memory.json` 写坏一次 ⇒ 重启 8 次后 `unregister` ⇒ **这只 bot 永久下线** | §A.2 |
| #15 | `agent.js` spawn 事件 catch | setup 异常用 `exit(0)` ⇒ 被当「正常结束」⇒ **不重启、不卸载** | §B.1 |
| #17 | `tasks.js` 两处 `// TODO wait for other bots to join` | 缺同伙 ⇒ `killAll()` ⇒ `socket.emit('shutdown')` ⇒ **整套服务退出** | §B.2 |

---

# A · #13 / #14：`history.js` 的 save / load 路径

> 作用域：只动 `save()`、`load()` 的函数体与构造函数里的两个记账字段。
> **没有改** `:28` 的 `operationCallOpts()`，**没有改** `:150` / `:158` 两个调用点的传参
> （那是 t3 的 R6 #12 取消链，已由队友完成）。

## A.1 #13 · `history.save()` 抛错 + 调用点 fire-and-forget

### 根因

`save()` 是 `async`，`catch` 里 `console.error` 之后 **`throw error`**；
而它的 4 个调用点**全都不 await**：

| 调用点 | 位置（改前） | 上下文 |
|---|---|---|
| `agent.js` | `:747` | `handleMessage` 里 `await history.add(...)` 之后顺手一存 |
| `agent.js` | `:886` | 命令循环里每轮一存 |
| `agent.js` | `:1108` | **`cleanKill()` 里**（最讽刺：一次落盘失败把「正常重启」变成「异常崩溃」） |
| `npc/controller.js` | `:106` | NPC 控制器（**不在本任务写作用域**，由 `save()` 内部修法一并覆盖） |

Node 24 默认 `--unhandled-rejections=throw` ⇒ 一次 `writeFileSync` 失败（磁盘满 / 文件被杀软或面板占用 /
`bots/<name>/` 权限变更）⇒ **整个 agent 进程崩**，且退出码偏离 `planExit` 的 0 / 1 / >1 三分支。

### 改法（双保险，只在 `save()` 内部 + 调用点收口）

① **单点修根**：`save()` 与同文件的 `appendFullHistory()` 同口径 —— **只记错误、不向上抛**，
返回 `true/false`，失败原因留在 `this.saveError`（`history.js:344`，构造时初始化于 `:70`）。

```js
// 改前
} catch (error) {
    console.error('Failed to save history:', error);
    throw error;                       // ← 抛给不 await 的调用方 = unhandled rejection
}

// 改后
} catch (error) {
    this.saveError = error;            // 不抛也要留证据，否则彻底看不见
    console.error(`[memory] 保存 ${this.name} 的 memory.json 失败（本批记忆未落盘，进程继续运行）: ...`);
    return false;
}
```

② **调用点收口**：`agent.js` 的 3 处改成统一走 `saveMemoryQuietly()`（`agent.js:1169`），
它是**唯一的 fire-and-forget 入口**，内部 `void this.history.save().catch(...)` 并额外兜住同步异常。

> **为什么不是「4 个调用点各加 `.catch()`」**：报告给了两个最小修法，选内部修法是因为
> `npc/controller.js:106` **不在本任务写作用域** —— 只改 agent.js 的三处会漏掉它，
> 而"漏一个调用点 = 漏洞还在"正是这条缺陷的形态。内部修法一处覆盖全部 4 个调用点。

### 写盘时序（没被这个改动破坏）

`save()` 虽是 `async`，但内部是 **同步** `writeFileSync`，没有 `await`。
所以 `cleanKill()` 里 `saveMemoryQuietly(); process.exit(code);` 的写入**在退出前已经落盘** ——
与改前逐字相同。这一点写进了注释，避免以后有人"顺手"把它改成 `fsp.writeFile`
（那会让 `cleanKill` 的记忆写入静默丢失）。

## A.2 #14 · `memory.json` 损坏后永久起不来

### 根因链

```
memory.json 被写坏（写盘中途被杀 / 断电 / 手改错一个逗号 / 外部脚本截断）
  → history.load() catch 后 throw
  → agent.start() 抛
  → init_agent 兜底 process.exit(1)
  → planExit 判「起不足 10s 就退出」→ 退避重启 ×8
  → MAX_QUICK_EXITS 触发 unregister
  ⇒ 这只 bot 永久下线，只能人工删文件；面板只显示「离线」，没有任何线索
```

对照：**同一个文件**的全程记录写入早有 `FULL_HISTORY_CORRUPT` 自愈（`history.js:221`），
这条**更重要**的路径反而没有。

### 改法：三级处理，**先抢救，再降级，最后才认输**

`load()`（`history.js:603`）拆成「读」与「解析」两段，解析失败后先尝试抢救：

| 级别 | 输入形态 | 处置 | 用户的记忆 |
|---|---|---|---|
| ① 读不出来 | EACCES / 竞态 | 记 `loadError`、`return null`、**不动文件** | 文件原样保留（下次 `save` 重整） |
| ②-a 结构修复 | 截断在某个 `}` 之后（写盘中断最常见形态） | 截到最后一个 `}` 重解析，整份对象回来，继续走**正常流程**（含版本戳检查） | **完整恢复**（memory + turns + memory_bank） |
| ②-b 字段抢救 | JSON 结构坏得更多 | 正则取 `"memory"` 字面量 + 从 `"memory_bank"` 起点做**大括号配平扫描**取完整对象 | **部分恢复**（记忆正文 / 地点箱子），`turns` 不伪造 |
| ③ 抢救失败 | 一个字都读不出来 | 留证 + **吵闹报错** + `return null` | 无可恢复 ⇒ 见下面的「产品语义」 |

三级**都必须先留证**：坏文件一律改名 `memory.json.corrupt-<时间戳>`（`_quarantineCorruptMemory()`，
`history.js:487`），路径记在 `this.corruptBackup` 上并被写进日志，**证据永远在、不会被下一次 `save` 覆盖**。
改名本身失败也不抛（退化成"不备份但照样能起"）。

```js
_salvageFromCorruptMemory(raw) {          // history.js:519 —— 三层逐级降级，每层各自 try
    // ① 截到最后一个 '}' 重解析（整份对象）
    // ② /"memory"\s*:\s*"((?:[^"\\]|\\.)*)"/ + JSON.parse 还原转义
    // ③ "memory_bank" 起点做深度配平扫描（字符串里的 {} 不计）⇒ 完整对象
}
```

### ★ 产品语义（队长点名的重点：**绝不许"静默重建空记忆"**）

**唯一会"记忆清零"的分支只有 ③，而且它不静默。** 具体后果写在这里，别读成"已经修好了"：

1. **②-a / ②-b 不会清零**：bot 起来时**带着**抢救出来的记忆正文 / 地点箱子。
   ②-b 会额外打一行警告：**代码版本戳无法确认** ⇒ 这段记忆可能含旧版本的经验结论，
   **已原样保留（宁可保留也不清零）**，请人工核对留证文件。
   （为什么不在 ②-b 上套版本戳检查：抢救路径读不出版本，一律写 0 会被判"过时"而把 memory 丢掉 ——
   那正是"悄悄清零"，与本次修复的目标相反，所以 ②-b 直接返回、不落到那段检查上。）
2. **③ 的后果（必须让用户知道的事）**：
   - 这只 bot 会以「**没有记忆**」的状态启动（等价新号），`memory.json` 由下一次 `save()` 重建；
   - 坏文件**一定**留在 `memory.json.corrupt-<ts>`，**人工修好后改名回 `memory.json` 即可恢复**；
   - `console.error` 明确写出三件事：抢救失败、留证路径、会不会重建 —— 不再是"只剩一行 warn"。
3. **不会再永久下线**：`load()` 任何分支都不再抛，所以 `agent.start()` 不会抛，
   不会触发「重启 8 次 → `unregister` → 必须人工删文件」那条链。

> 取舍：为什么不是"直接失败、让用户手工处理"？因为 `load()` 抛的后果是**整只 bot 起不来**
> （正是 #14 的缺陷），而"能起来但记忆待人工修复"严格优于"起不来"。
> 代价是 ③ 分支下她会"暂时不记得"，所以日志必须吵、留证必须留、路径必须点名。

## A.3 `history.js` 改动清单（只看这两块，别把它和 t3 的 opt 接线混在一起）

| 位置 | 内容 | 归属 |
|---|---|---|
| `:70-80` | 构造函数新增 `saveError` / `loadError` / `corruptBackup` / `recoveredFromCorrupt` | #13/#14 |
| `:344-...` | `save()`：不抛、返回布尔、记 `saveError` | #13 |
| `:487-516` | `_quarantineCorruptMemory()`（新增） | #14 |
| `:519-565` | `_salvageFromCorruptMemory()`（新增） | #14 |
| `:603-...` | `load()`：拆读/解析 + 三级抢救 + 留证 + 吵闹降级 | #14 |
| `:28`、`:150`、`:158` | `operationCallOpts` 定义与 2 个调用点 | **t3 的 R6 #12，本批未改** |

---

# B · #15 / #17：进程存活

## B.1 #15 · setup 阶段异常用 `exit(0)`

### 根因

`agent.js:398-401`（改前）：

```js
} catch (error) {
    console.error('Error in spawn event:', error);
    process.exit(0);        // ← 退出码 0 = 「正常结束」
}
```

`planExit()` 见到 `code === 0` 直接返回 `action:'none'` ⇒ **不重启、也不走 `unregister` 的告警分支**
⇒ bot 掉线后再也不回来，日志里只剩一行 `Error in spawn event`。
而同一份代码里「起不来」的另一条路径（`init_agent` 启动失败）用的是 `exit(1)`（会重启）—— 两条路径语义相反。

### 改法（`agent.js:404-427`）

```js
} catch (error) {
    console.error('Error in spawn event:', error);
    try {
        this.cleanKill(`Error in spawn event: ${error?.message ?? error}`, 1);   // ← 非 0 退出码
    } catch (e) {
        console.error('Error while killing agent after spawn failure:', e);
        process.exit(1);                       // ← 兜底也必须是 1，不许回到 0
    }
}
```

`cleanKill(msg, 1)` 的收益不止"退出码对"：

- 走 `init_agent` 已包好的 `gracefulStop`（先摘 board 租约再退出），不留"离线但仍在续租"的僵尸条目；
- `planExit` 判「起不足 10s 就退出」→ **指数退避重启**，真的起不来才由 `MAX_QUICK_EXITS` 收口；
- 失败原因进 history / 进 bot 聊天，不再只有一行 console。

### 相邻加固（同一条杀伤链的另一个触发点）

同一处的 `this.task.initBotTask()` / `this.task.setAgentGoal()` 也是 **async 但裸调用**：
内部要 `executeCommand` / `bot.chat` / 等同伴 bot，任何一步 reject 同样是 unhandled rejection ⇒ 进程被带走。
现在统一走 `guardTaskStartup(label, promise)`（`agent.js:1137`，调用点 `:390/:391/:396`）：

```js
guardTaskStartup(label, promise) {
    const onFail = (e) => {
        console.error(`[agent] 任务初始化阶段 ${label} 失败:`, e);
        try { this.cleanKill(`Task startup failed (${label}): ...`, 1); }
        catch (e2) { console.error(...); process.exit(1); }
    };
    try { if (promise && typeof promise.catch === 'function') void promise.catch(onFail); }
    catch (e) { onFail(e); }
}
```

> 关键判断：**这不是"改变语义"，而是把"进程凭空消失"换成"干净重启 + 一条能读的日志"。**
> 改前这两个调用点 reject 的结局是 unhandled rejection（Node 24 直接崩），
> 所以"接住并 exit(1)"严格优于改前，而不是把"能活的情况"改成"会死"。

## B.2 #17 · 缺同伙 bot 时 `killAll()` 关掉整个 mindserver

### 根因

`tasks.js:538-545` 与 `:619-626`（**两处一字不差**）的全部实现：

```js
// TODO wait for other bots to join
await new Promise((resolve) => setTimeout(resolve, 10000));      // ← 固定 10 秒就是全部逻辑
if (this.available_agents.length < this.data.agent_count) {
    console.log(`Missing N bot(s).`);
    this.agent.killAll();        // → mindserver_proxy.shutdown() → socket.emit('shutdown')
}
```

两个问题叠加：

1. **等待量固定**，不看成败 —— Paper 重启要 20~60 秒，某只 bot 晚到 11 秒，早到的那只就判「人不齐」
   （而且两处重复 ⇒ 启动白等 20 秒，早到也没用）；
2. 判「人不齐」后 `killAll()` ⇒ **整套服务退出**：其它 bot、面板、任务板数据库一起没。
   这与 `agent_process.js:47-55` 刚修好的「单个 agent 退出不许拖垮整个 mindserver」**直接冲突**。

### 改法：抽一个零依赖的轮询等待模块

新增 `src/agent/tasks/wait_for_teammates.js`（**零依赖**，离线用例可直接 import；
`tasks.js` 顶层 import 了 `commands/index.js` → mineflayer 整条链，用例导入它既慢又易连带崩）：

| 导出 | 作用 |
|---|---|
| `waitForAgents({required, present, timeoutMs, intervalMs, sleep, now})` | 轮询等待，**时钟与 sleep 可注入** |
| `describeWaitResult({required, present, waitedMs})` | 超时文案（纯函数，可逐字钉住） |
| `readEnvMs(name, fallback, min, max)` | 环境变量覆盖 + 夹紧（默认 60s / 500ms） |
| `TEAMMATE_WAIT_EXIT_CODE = 4` | 「只摘自己」的退出码（`planExit` 判 >1 ⇒ unregister） |

等待语义（每一条都有用例）：`required <= 1` ⇒ 立刻通过；人已到齐 ⇒ 立刻通过、**一次 sleep 都不做**；
人不够 ⇒ 每 `intervalMs` 重数一次；超时 ⇒ `ok:false` 并带回 `present / required / waitedMs`。

`tasks.js` 侧新增两个方法：

```js
async waitForOtherBots(opts = {}) { ... }        // :344 —— 单机直通；超时打一句人话
detachSelf(msg) {                                 // :382 —— ★ 绝不再 killAll()
    console.error(`[task] ${msg}`);
    try { this.agent.cleanKill?.(msg, TEAMMATE_WAIT_EXIT_CODE); }   // 4 > 1 ⇒ 只注销这一个 agent
    catch (e) { console.error(`[task] 摘除自身时异常（已兜住）: ${e?.message ?? e}`); }
}
```

三处 `killAll()` 全部替换：

| 位置 | 改前 | 改后 |
|---|---|---|
| `initBotTask` `:624-633` | 固定 10s + `killAll()` | `waitForOtherBots()`；超时 `detachSelf(...)` + `return` |
| `teleportBots` `:710-719` | 固定 10s + `killAll()`（**重复第二份**） | 同上（调用方已等过时这里一数就够，不 sleep） |
| `initBotTask` 会话分支 `:644-650` | `console.log('No other agents found')` + `killAll()` | `detachSelf(...)` + `return` |

> 第三处报告没点名，但它与 #17 是**同一个病**（缺同伙 ⇒ 关整机），而且改前 `killAll()` 之后
> 代码**继续往下用空名字发 `!startConversation`** —— 所以这里必须 `return`。

同时更正两处**已经过时的日志文案**（原写「✓ 照常：…、killAll()、…」及注释里的「agent_count 检查、killAll()」）：
缺同伙现在不关整机了，日志说得和实际不一致 —— 那正是同类缺陷里踩过的坑（`cleanKill` 的
Restarting/Exiting 说反的那次）。

### 边界：`agent.js` 的 `killAll()` **保留**

`checkTaskDone()` → `killAll()`（`agent.js:1200`）**没动**，理由：那是**任务完成**的语义
（一套 mindserver 跑一个任务，任务结束就收工），不是"某个零件坏了把整机拉闸"。
本批只处理**故障路径**上的整机停机。

---

# C · 验证

## C.1 新增回归用例：`tools/runtime_survival_unit.mjs`（64 个用例）

判据尽量做成**行为可跑**；跑不了的退化为源码静态断言并用例名里写明理由。

| 段 | 覆盖 | 个数 |
|---|---|---|
| ① `save()` 失败不抛（#13） | 指到不存在目录 ⇒ 返回 `false`、`saveError` 有值、**全程 0 个 unhandledRejection**；正向对照 `true` + `saveError` 清空 | 6 |
| ② 调用点（#13） | agent.js 无裸 `this.history.save();`（`await` 的除外）、`saveMemoryQuietly()` 存在且 ≥3 个调用点、内部接了 `.catch` | 3 |
| ③ `load()` 三级抢救（#14） | 部分抢救（记忆正文被救回、**不是清零**）/ 结构修复（memory+turns+bank 全回来）/ 结构块抢救（箱子坐标）/ 抢救失败（不抛、留证、返回 null）/ 三种非对象顶层 / 留证内容一字不差 / 原文件腾位 / 自愈重建后证据仍在 | 22 |
| ④ #15 退出码 | spawn catch 内 `cleanKill(…, 1)`、**无 `process.exit(0)`**（先剥注释，否则解释缺陷的注释会把断言逼红）、兜底 `exit(1)`；`planExit` 三分支静态对照 | 8 |
| ⑤ 轮询等待（#17） | 人齐 0 次 sleep；单机直通；**晚到 11 秒能被等到**（旧实现固定 10s 就判错）；超时 `ok:false` + 数字正确 + 不越界；人多也算齐；文案写明「缺 N 只 ⇒ 只摘自己」；环境变量夹紧 | 13 |
| ⑥ tasks.js（#17） | 代码里**无** `killAll(`（剥注释后）、无 `emit('shutdown')`、走 `detachSelf`、退出码 4、两处固定 10s 已被轮询取代、无 `setTimeout(...,10000)` | 7 |
| ⑦ `detachSelf` 方法体（#17） | 只 `cleanKill(msg, 4)`，无 killAll / `exit(0)`，有 catch 兜底 | 3 |
| ⑧ 相邻加固（#15） | `guardTaskStartup` 存在、两个任务初始化调用受保护、失败给 `cleanKill(…, 1)` | 3 |

关键几条输出（摘录）：

```
PASS ★ ① 写盘失败时 save() 不抛（不再有 unhandled rejection 把进程带走）
PASS ★ ③ 坏 memory.json 不再抛（这一抛会让 bot 连续重启 8 次后被永久注销）
PASS ★ ③ 部分抢救：**她的记忆正文被救回来了**（不是静默清零）
PASS ★ ③ 结构修复：整份记忆（含 turns / memory_bank）都恢复
PASS ★ ④ 该 catch 块里不再有 process.exit(0)（那等于伪装成"正常结束"⇒ 不重启、不卸载）
PASS ★ ⑤ 晚到 11 秒的同伙能被等到（旧实现固定 10s 就判"人不齐"） → waitedMs=11000 polls=22
PASS ★ ⑤ 超时 ⇒ ok:false（调用方据此只摘自己），且带回 present/required → present=1 required=3
PASS ★ ⑥ tasks.js 的**代码**里不再有 killAll() 调用（缺同伙不许关整机）
```

## C.2 命令与结果

| 命令 | 结果 |
|---|---|
| `node tools/runtime_survival_unit.mjs` | **64 passed, 0 failed** |
| `node tools/board_stop_unit.mjs`（任务指定） | **exit 0** |
| `node tools/agent_cancel_late_reply_unit.mjs`（任务指定） | **exit 0** |
| `node tools/bot007_010_history_unit.mjs`（memory.json 预算/摘要链） | **exit 0** |
| `node tools/memory_store_corrupt_unit.mjs`（同族 `.corrupt-` 口径） | **exit 0**（6/6） |
| `node tools/agent_process_backoff_unit.mjs`（`planExit` 退避矩阵） | **exit 0** |
| `node tools/task_pickup_unit.mjs` | **exit 0** |
| `node tools/unit_all.mjs runtime_survival`（纳入总入口） | **1/1 脚本通过** |
| `node tools/lint_hard.mjs` | **no-undef = 0 · no-floating-promise = 0**（扫 179 文件） |
| `npm run gate` | **exit 0 —— 启动自检通过（含函数体冒烟 + lint:hard）** |

`tools/*_unit.mjs` 是 `unit_all.mjs` 的**自动发现**范围，新用例零登记成本。

> 备注：本任务执行早期 `npm run gate` 曾因 `src/agent/library/board_server.js` 的
> 6 个错误码未注册而红（控制面那条线的在飞改动，不在本任务写作用域）。
> 该线落地后**已复跑为 exit 0**，本批未代改任何非作用域文件。

---

# D · 改动文件

| 文件 | 改动 | 归属 |
|---|---|---|
| `mindcraft/src/agent/history.js` | `save()` 不抛（+`saveError`）；`load()` 三级抢救 + 留证自愈（+`loadError`/`corruptBackup`/`recoveredFromCorrupt`）；`renameSync` 引入 | #13/#14 |
| `mindcraft/src/agent/agent.js` | `saveMemoryQuietly()` + 3 个调用点收口（#13）；spawn catch 改 `cleanKill(…, 1)`（#15）；`guardTaskStartup()` + 3 个任务初始化调用点（#15 相邻） | #13/#15 |
| `mindcraft/src/agent/tasks/tasks.js` | 新增 `waitForOtherBots()` / `detachSelf()`；**3 处 `killAll()` 全部移除**；两处固定 10s 换成轮询；过时日志文案更正 | #17 |
| `mindcraft/src/agent/tasks/wait_for_teammates.js` | **新增**（零依赖）：`waitForAgents` / `describeWaitResult` / `readEnvMs` / 退出码与默认值常量 | #17 |
| `mindcraft/tools/runtime_survival_unit.mjs` | **新增**：64 个用例（自动纳入 `unit_all`） | 验证 |
| `docs/audit-r6/fixes/runtime.md` | 本文 | — |

未改（明确记录理由）：

- `src/agent/npc/controller.js:106` 的 `history.save()` —— **不在写作用域**；`save()` 内部已不再抛，该调用点一并被覆盖（用例 ① 的运行期验证同形）。
- `src/agent/history.js:28` / `:150` / `:158` 的 `operationCallOpts` —— **t3 的 R6 #12 取消链**，本批未碰。
- `src/agent/library/board_server.js` / `contract.js` —— 不在写作用域（gate 当时的唯一红点，已由该线自行落地）。
- `agent.js:1200` 的 `killAll()`（任务**完成**语义）—— 见 §B.2 边界。

---

# E · 遗留与观察（交回队长/下一批）

1. **`killAll()` 仍然存在**（`agent.js:1205`），用于「任务完成」。在**多任务常驻**形态下会误伤其它任务，
   但那是架构变更（一套 mindserver = 一个任务），不在本批。建议在 ADR 阶段一并处理。
2. **#14 的 ②-b 分支留下了"版本未知"的记忆**：这是有意的**不静默清零**取舍，但意味着
   一条旧版本的错误经验结论可能被保留。若要更严谨，方向是"抢救时从坏文件里也把 `codeVersion`
   尽量捞出来"（本文已尝试：结构修复路径能拿到；纯字段抢救路径拿不到）。建议下一批考虑
   在 `memory.json` 里把 `codeVersion` 写在**文件开头**，让截断/抢救更容易读到。
3. **`memory.json.corrupt-*` 没有清理策略**：每次损坏留一份证据是**有意为之**，但长期多份会占目录。
   与 #16 的 `jobs` 保留策略同类，建议一起做（不要在这里单独加删除逻辑）。
4. **`saveError` / `corruptBackup` 还没有出口给面板**：`mindserver_proxy` 的 `fetch-memory`
   只回 `memory/turns/codeVersion`。建议在 diag 里加「最近一次落盘是否失败 / 记忆是否来自坏文件抢救」，
   否则"记忆没写进去 / 记忆是抢救来的"对用户依旧不可见。
5. **`onDisconnect` 的退避交互缺少用例**：`agent.js:319`（断线 `exit(1)`）语义正确，
   但「Paper 重启期间连续 quick exit」的组合没有专门用例（现有 `agent_process_backoff_unit` 只覆盖
   `planExit` 矩阵）。建议补一条离线用例。
6. **任务进行中缺同伙仍会关整机**：`isDone()` 里 `elapsedTime >= 30 && available_agents.length !== agent_count`
   ⇒ 返回 `score:0` ⇒ `checkTaskDone()` 走 `killAll()`（`tasks.js:466`）。
   也就是说 #17 的"整机被拉闸"在**任务进行中**这条更长的路径上仍存在。
   本批未动（会牵动任务成功/失败判定，风险高于收益），建议单独立单。
