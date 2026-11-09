# 03 — 运行时行为缺陷实测（R5 / t3）

> 第五轮审计 · 运行时探针（runtime-probe）
> 生成时间：2026-11-08 · 全离线（不连模型、不连 MC 服、不起子进程）
> 被审计快照：
> - `mindcraft` @ `33b4327`（"第四轮复审全量落地"之后的最新修复版）
> - `web`（父仓）@ `92d405c`
> - Node `v24.16.0`（Windows / MSYS Bash）
>
> 探针目录：`docs/audit-r5/evidence/runtime/probes/`
> 原始日志：`docs/audit-r5/evidence/runtime/logs/`

---

## 0. 一句话结论

**R5 的 10 条运行时候选缺陷，在当前工作树上全部"实测未复现"；但它们全部在"修复前基线树"上"实测复现"。**

也就是说：这 10 条不是"读码看着像"，而是**真的能跑出来的缺陷**——只不过它们已经在 R3-2 / R4 这两轮修复里被修掉了。本轮交付的是**可执行的回归证据**：

| 含义 | 数量 |
|---|---|
| 当前 HEAD 实测复现的缺陷 | **0 / 10** |
| 修复前基线实测复现的缺陷（对照组） | **10 / 10** |
| 无法离线驱动（CANNOT-RUN） | **0 / 10** |

> 所以本轮"缺陷清单"的正确读法是：**它不是一份待修清单，而是一份"已修且可回归验证"的清单**。
> 任何一条将来被改回去，对应探针会立刻以退出码 0 报警。

---

## 1. 方法：为什么"退出码即结论"

每条缺陷都写成一个独立探针 `t-r5-<编号>.mjs`，遵守同一套硬约定：

```
node <probe>.mjs                    → 退出码 0 = 缺陷复现   1 = 未复现   2 = CANNOT-RUN
R5_SRC=<基线树>/src node <probe>.mjs → 同一个探针跑"修复前"的代码
```

**每条探针都跑两遍**，这才是判定力的来源：

- **当前树**：跑出 `1`（未复现）——证明"现在的行为是对的"；
- **基线树**：跑出 `0`（复现）——证明"这个探针确实抓得住这条缺陷"，不是空转。

只看当前树跑绿是不够的：一个写错的探针（比如根本没把被测代码驱动起来）同样会"跑绿"。本轮在调试过程中就真实踩到过 3 次"假绿"，全部已修（见 §4）。

### 1.1 三条基线（都是 `git worktree` 拉出来的独立检出，不动工作树）

| 基线 | 位置 | 用途 |
|---|---|---|
| `r5-base-prefix` @ `7524899` | `mindcraft/tmp/r5-base-prefix` | R4 修复前（候选 1/2/4/5/6/7/9/10） |
| `r5-base-limit` @ `4c91264` | `mindcraft/tmp/r5-base-limit` | R3-2 修复前（候选 3：限流真上限） |
| `agents.prefix.ts` @ `99f844d^` | `evidence/runtime/tmp/` | t14 离线闸修复前（候选 8） |

### 1.2 mock 边界（重要：改的是"边界"，不是"被测逻辑"）

| 探针 | 注入的东西 | 为什么这样不算作弊 |
|---|---|---|
| 1 | 假 bot / 假模型 / 记账版 history 与说话 | 被测的 `handleMessage` 是**真的** `Agent.prototype`，`!stop` 是**真的**命令实现 |
| 2 | 假 prompter（返回截断兜底串）；`_stageCode`/`_lintCode` 换成记录器 | 被测的是 `generateCode` 的**判据与分支**；执行器是外部副作用，本来就是边界 |
| 3 | `r5-hooks.mjs` 在加载期**追加一行 export** | 被测 `takeToken` 逐字未改，只是开了个观察窗（`takeToken` 是模块内部符号） |
| 4 | 假任务板（`heartbeat` 计数、`getAsync` 回报服务端状态）+ 假 runSkill | 被测的是 `_runJob` 的心跳决策；板子是网络边界 |
| 5 | 真 `History.save()` 写盘，`MC_BOTS_ROOT` 指向临时目录 | 真的写了 `memory.json` 再读回来验证 |
| 6 | `r5-hooks.mjs` 追加 `__r5_speakState` | `isSpeaking` 是模块内部变量；逻辑未改 |
| 7 | 假 agent（`handleMessage` 第一次就抛） | 被测 `startLoop` 是真的 |
| 8 | esbuild 打包真 `agents.ts` + 把 `../api/socket` 换成假实现 | store 的业务判断原样跑；socket.io 是网络边界（假实现**照 socket.io 语义缓存** emit，这正是缺陷载体） |
| 9 | 假 prompter（返回截断摘要） | 被测 `summarizeMemories` 是真的 |
| 10 | `child_process.spawn` 换成假子进程（EventEmitter） | 真起进程是禁止的；被测的 `'error'` 处理器是真的 |

---

## 2. 总表

| # | 缺陷（候选标题） | 当前树 | 基线树 | 当前树关键证据 | 修复落点 |
|---|---|---|---|---|---|
| 1 | 迟到回复：`!stop` 后仍写 history / 说给玩家 | 未复现 | **复现** | history 0 条、聊天 0 条 | R4 `c9a860f`（cancelEpoch + 返回后复查） |
| 2 | 截断代码假成功：兜底串自带三反引号 → 当代码执行 | 未复现 | **复现** | 进执行路径 0 次 | R4 `c9a860f`（`[NO_CODE]` + `hasStatements`） |
| 3 | 面板限流「硬上界」不成立（513 新鲜 key 删不掉） | 未复现 | **复现** | size 停在 512 | R3-2 `6c8758e` |
| 4 | 板心跳不看停止标志：paused 单仍续租 | 未复现 | **复现** | 暂停后新增心跳 0 次 + 主动放租约 | R4 `c9a860f`（A5-8） |
| 5 | 记忆保留方向相反：留最旧、丢最新 | 未复现 | **复现** | 保留 120 条，最新一条在 | R4 `c9a860f`（`keys.slice(-MAX_BANK)`） |
| 6 | `speak.js` catch 不重置 `isSpeaking` → 永久静音 | 未复现 | **复现** | 异常后闸门 false | R4 `c9a860f` |
| 7 | `startLoop` 无 try/finally → 循环死但 state 仍 ACTIVE | 未复现 | **复现** | `loop_active=false` | R4 `c9a860f` |
| 8 | `refreshTerrain` 绕过离线闸 | 未复现 | **复现** | emit 0 个、sendBuffer 0 个 | R4 t14 `99f844d` |
| 9 | 截断摘要覆盖 `memory.json` | 未复现 | **复现** | memory 仍是 `OLD-SUMMARY` | R4 `c9a860f`（H4 双保险） |
| 10 | `AgentProcess` spawn `'error'` 不置 `running=false` | 未复现 | **复现** | `running=false` | R4 `c9a860f`（S2#12） |

---

## 3. 逐条实录

### 3.1 候选 1 — 迟到回复：`!stop` 之后仍写 history、仍说给玩家

**探针**：`probes/t-r5-1.mjs`　**驱动**：真 `Agent.prototype.handleMessage` + 真 `!stop` 命令，
在"模型正在生成"的窗口里执行 `!stop`（此刻**没有动作在跑**，正是审计描述的场景）。

**缺陷形态**：模型返回后没有复查取消；且 `!stop` = `actions.stop('player')` + `clearBotLogs()`，
后者把 `interrupt_code` 清回 false ⇒ 只看标志位永远抓不到。修复靠**只增不减的取消序号**。

```
# 当前树
$ node docs/audit-r5/evidence/runtime/probes/t-r5-1.mjs
[t-r5-1] !stop 之后的标志位 interrupt_code = false  取消序号 = 1
[t-r5-1] 迟到回复写进 history 的次数： 0
[t-r5-1] 迟到回复说给玩家的次数： 0
[t-r5-1] NOT-REPRODUCED：迟到的回复被丢弃（既不写 history、也不说给玩家）
→ exit=1

# 基线树（7524899，R4 修复前）
$ R5_SRC=mindcraft/tmp/r5-base-prefix/src node .../t-r5-1.mjs
[t-r5-1] 取消序号 = (无 cancelEpoch)
[t-r5-1] 迟到回复写进 history 的次数： 1 [["botc","好的，我这就去挖树"]]
[t-r5-1] 迟到回复说给玩家的次数： 1 [["deepseek","好的，我这就去挖树"]]
[t-r5-1] REPRODUCED：!stop 之后迟到的回复仍然产生了副作用（history 1 条、聊天 1 条）
→ exit=0
```

**残留风险**：探针钉的是"无动作在跑"的那条路径。`actions.executing = true`（旧动作还在跑）时
标志位**不许清**这条反向约束，由 R4 的 `tools/agent_cancel_late_reply_unit.mjs` 覆盖，本探针不重复。

---

### 3.2 候选 2 — 截断代码假成功

**探针**：`probes/t-r5-2.mjs`　**驱动**：假 prompter 返回**老兜底串** `'```//no response (truncated)```'`，
把 `_stageCode` / `_lintCode`（执行路径的副作用边界）换成记录器，看有没有东西被送进去。

**缺陷形态**：`res.indexOf('```') !== -1` 是弱判据 —— 兜底串自带三反引号 ⇒ 判成"有代码" ⇒
抽出一行注释 `//no response (truncated)` 当代码执行 ⇒ 跑通后**记账成功**。

```
# 当前树
[t-r5-2] generateCode 返回： Action failed, agent would not write code.
[t-r5-2] 进入执行路径的次数： 0
[t-r5-2] NOT-REPRODUCED → exit=1
（stderr 里还有 4 行 "Code block contains no statements (comment-only) — treated as "no code"."）

# 基线树
[t-r5-2] !! _stageCode 被调用，收到的"代码"： "//no response (truncated)"
[t-r5-2] generateCode 返回： Agent wrote this code: \n```//no response (truncated)```\nCode Output:\n
[t-r5-2] 进入执行路径的次数： 1 ["//no response (truncated)"]
[t-r5-2] REPRODUCED：截断兜底串被判成"有代码"，注释被当代码送进执行路径（执行 1 次，返回 成功摘要）
→ exit=0
```

**为什么这条最锋利**：老实现的返回串是**成功摘要**（"Agent wrote this code…"），
即"一次截断 = 一次什么都没做却记账成功的动作"。

---

### 3.3 候选 3 — 面板限流「硬上界」不成立

**探针**：`probes/t-r5-3.mjs`　**驱动**：加载期钩子导出 `takeToken` / `RATE_BUCKETS`，
用 **600 个互不相同的远端地址**各取一次令牌（= 600 个**新鲜** key，`ts` 全是 now）。

**缺陷形态**：`if (size > 512) { 删 >60s 的 }` 是**清理触发条件**，不是上限 ——
新鲜 key 一条都删不掉，表可以无限长，之后每条消息全表扫描。

```
# 当前树
[t-r5-3] 声称的桶上界： 512  观察到常量： 512
[t-r5-3] 构造 600 个新鲜 key 后：RATE_BUCKETS.size = 512，放行 600/600
[t-r5-3] 表内最旧条目年龄(ms)： 6 （全部新鲜 ⇒ 陈旧项清理不可能生效）
[t-r5-3] NOT-REPRODUCED：上界成立 —— 实际 512 条 <= 声明上限 512
→ exit=1

# 基线树（4c91264，R3-2 修复前）
[t-r5-3] 声称的桶上界： 512  观察到常量： (无)
[t-r5-3] 构造 600 个新鲜 key 后：RATE_BUCKETS.size = 600，放行 600/600
[t-r5-3] REPRODUCED：桶上界不成立 —— 声明上限 512，实际 600 条，新鲜 key 一条也淘汰不掉（超出 88 条）
→ exit=0
```

---

### 3.4 候选 4 — 板心跳不看停止标志（paused 单仍续租）

**探针**：`probes/t-r5-4.mjs`　**驱动**：真 `BoardScheduler._runJob`，假板子计心跳；
`heartbeatMs=40ms`；跑到一半把**服务端权威状态**改成 `paused`（模拟"别人在面板上暂停了"，
这是本地镜像看不到的那种）。

**缺陷形态**：无条件 `board.heartbeat(job.id)` ⇒ `_runJob` 卡在 30 分钟模型调用期间，
paused 单每 10 秒续租，别的 bot 一直到进程被杀都拿不到这张单。

```
# 当前树
[t-r5-4] 暂停时刻的累计心跳数： 2
[t-r5-4] 暂停后继续观察 240ms：累计心跳数 = 2 （暂停后新增 0 次）
[t-r5-4] 释放租约的 update： [{"id":"job-1","patch":{"lease_owner":null,"lease_until":null}}]
[t-r5-4] 事件： [{"type":"lease-renew-stop","id":"job-1","kind":"paused"},
               {"type":"skip-finish-lease-released","id":"job-1"},
               {"type":"skip-finish-stopped","id":"job-1","kind":"paused"}]
[t-r5-4] NOT-REPRODUCED：暂停后心跳停止，并主动放掉了租约（心跳数停在 2）
→ exit=1

# 基线树
[t-r5-4] 暂停时刻的累计心跳数： 2
[t-r5-4] 暂停后继续观察 240ms：累计心跳数 = 5 （暂停后新增 3 次）
[t-r5-4] 释放租约的 update： []
[t-r5-4] 事件： []
[t-r5-4] REPRODUCED：单已被服务端暂停后心跳仍在续租（暂停后新增 3 次）
→ exit=0
```

---

### 3.5 候选 5 — 记忆保留方向相反

**探针**：`probes/t-r5-5.mjs`　**驱动**：真 `History.save()`（`MC_BOTS_ROOT` 指向临时目录），
塞 200 条 `memory_bank` 后**真的写盘**，再读回 `memory.json` 看留下了谁。

```
# 当前树
[t-r5-5] 写入 200 条，写回后保留 120 条
[t-r5-5] 保留的前 3 条： place-80, place-81, place-82
[t-r5-5] 保留的后 3 条： place-197, place-198, place-199
[t-r5-5] 最新一条 place-199 是否保留： true ；最旧一条 place-0 是否保留： false
[t-r5-5] NOT-REPRODUCED：保留的是最新的一批（120 条） → exit=1

# 基线树
[t-r5-5] 保留的前 3 条： place-0, place-1, place-2
[t-r5-5] 保留的后 3 条： place-117, place-118, place-119
[t-r5-5] 最新一条 place-199 是否保留： false ；最旧一条 place-0 是否保留： true
[t-r5-5] REPRODUCED：保留方向相反 —— 留下的是最旧的一批，最新登记的地点被丢弃（place-199 丢失）
→ exit=0
```

**症状翻译**：`!rememberHere` 刚记的坐标**最先被淘汰** ⇒ 模型"刚记住就忘"。

---

### 3.6 候选 6 — `speak.js` 的 catch 不重置 `isSpeaking`

**探针**：`probes/t-r5-6.mjs`　**驱动**：喂一条**必炸**文本（`toString()` 抛错 —— 老实现
`txt.trim()` 会 TypeError），等异常落地后读模块内部 `isSpeaking`（加载期开观察窗）。
用 `toString` 抛错的好处：**保证不会真的启动 TTS 进程**（这台机器不会出声）。

```
# 当前树
[t-r5-6] 调用前闸门： {"isSpeaking":false,"queue":0}
[t-r5-6] 异常落地后闸门： {"isSpeaking":false,"queue":0}
[t-r5-6] unhandledRejection 次数： 0
[t-r5-6] NOT-REPRODUCED：异常后闸门已复位 → exit=1

# 基线树
[t-r5-6] 异常落地后闸门： {"isSpeaking":true,"queue":0}
[t-r5-6] REPRODUCED：一次异常后 isSpeaking 永久卡在 true —— 队列泵已死，之后所有 TTS 请求只入队、永远不播
→ exit=0
```

---

### 3.7 候选 7 — `startLoop` 无 try/finally

**探针**：`probes/t-r5-7.mjs`　**驱动**：假 agent 的 `handleMessage` 第一次就抛，调真 `startLoop()`。

```
# 当前树
[t-r5-7] startLoop 是否把异常抛给调用方： no
[t-r5-7] 循环结束后：loop_active = false  state = 1 (1=ACTIVE, 0=STOPPED)
[t-r5-7] 连续失败计数 loop_errors = 1
[t-r5-7] NOT-REPRODUCED：异常后状态被说明清楚（loop_active=false）→ exit=1

# 基线树
[t-r5-7] startLoop 是否把异常抛给调用方： [t-r5-7] 故意制造的目标循环异常
[t-r5-7] 循环结束后：loop_active = true  state = 1 (1=ACTIVE, 0=STOPPED)
[t-r5-7] 连续失败计数 loop_errors = (无此字段)
[t-r5-7] REPRODUCED：一次异常后 loop_active 永久卡 true + state 仍 ACTIVE
→ exit=0
```

**说明**：当前树 `state` 仍是 1 是**设计如此**（单次失败不判死，靠 `loop_errors >= 3` 才 STOPPED），
关键是 `loop_active` 已复位 ⇒ `update()` 能按既有节流自动重启。

---

### 3.8 候选 8 — `refreshTerrain` 绕过离线闸（前端）

**探针**：`probes/t-r5-8.mjs`　**驱动**：用 esbuild 把**真** `web/src/stores/agents.ts` 打成 node 可跑模块，
把 `../api/socket` 换成照 socket.io 语义记账的假实现（未连接时 emit 进 `sendBuffer`，不抛错）。

```
# 当前树
[t-r5-8] currentAgent = "probe8"
[t-r5-8] 调用前：connected = false  已发包 = 0  sendBuffer = 0
[t-r5-8] refreshTerrain 返回： {"ok":false,"reason":"未连接到 mindserver，地形请求没有发出"}
[t-r5-8] 本次新增的 emit： []
[t-r5-8] 本次新增的 sendBuffer（重连后会真发出去）： []
[t-r5-8] NOT-REPRODUCED：未连接时没有发包（离线闸生效）→ exit=1

# 基线（99f844d^ 的 agents.ts）
[t-r5-8] refreshTerrain 返回： {"ok":false,"reason":"超时(30s)"}
[t-r5-8] 本次新增的 emit： ["request-terrain"]
[t-r5-8] 本次新增的 sendBuffer（重连后会真发出去）： ["request-terrain"]
[t-r5-8] REPRODUCED：未连接状态下 refreshTerrain 仍发出了 request-terrain
→ exit=0
```

**症状翻译**：界面显示"超时(30s)失败"，而请求包躺在 `socket.sendBuffer` 里 ——
**重连那一刻真发出去**，地形被一条早就失败了的旧请求覆盖。

---

### 3.9 候选 9 — 截断摘要覆盖 `memory.json`

**探针**：`probes/t-r5-9.mjs`　**驱动**：`memory` 先置 `OLD-SUMMARY`，用"返回被截断摘要"的 prompter 桩
调真 `summarizeMemories()`。

```
# 当前树
[t-r5-9] 调用前 memory = "OLD-SUMMARY"
[t-r5-9] 调用后 memory = "OLD-SUMMARY"
[memory] 本轮摘要不可用(truncated) → 保留旧摘要，不覆盖 memory.json
[t-r5-9] NOT-REPRODUCED → exit=1

# 基线树
[t-r5-9] 调用后 memory = "半截摘要：她当时正在往（此处被输出额度截断[LLM_TRUNCATED]"
[t-r5-9] REPRODUCED：截断的摘要覆盖了长期记忆（memory.json 已被污染）→ exit=0
```

**为什么严重**：`memory.json` 跨重启存活，一次覆盖就是**永久降级**，且这批 turns 已被 splice 掉，没有重来机会。

---

### 3.10 候选 10 — `AgentProcess` 的 spawn `'error'` 不置 `running=false`

**探针**：`probes/t-r5-10.mjs`　**驱动**：导入前用 `createRequire` 把 `child_process.spawn` 换成
假子进程（EventEmitter）；`start()` 后让它 `emit('error')`（真实 Node 在 spawn 失败时发 error，**不发 exit**）。

```
# 当前树
[t-r5-10] start() 返回： true  running= true  假子进程数= 1
Agent process error: Error: spawn ENOENT（假）
[t-r5-10] emit('error') 之后：running = false  排队的重启定时器 = []
[t-r5-10] NOT-REPRODUCED：spawn 失败后 running 已落回 false → exit=1

# 基线树
[t-r5-10] emit('error') 之后：running = true
[t-r5-10] REPRODUCED：spawn 失败后 running 仍为 true —— 状态机认为"它还在跑" → exit=0
```

**症状翻译**：面板上一条永不消失的"运行中"，退避重启也不触发。

---

## 4. 调试过程中被自己抓到的 3 次"假绿"（诚实记录）

这三条如果没抓到，本报告会给出**四个错误的"未复现"**。列在这里是为了说明为什么"每条都跑基线"是必须的：

1. **t-r5-4 空转**：假 `actions` 缺 `runAction` → 调度器走 `control.runJobAction` 时立刻 run-failed，
   心跳一次都没发生 ⇒ 心跳数恒为 0，"暂停后心跳不增长"被判成"未复现"。
   修：给假 actions 补 `runAction(label, fn)`，此后暂停前能看到 2 次心跳。
2. **t-r5-8 空转**：`refreshTerrain` 开头 `if (!currentAgent.value) return null` —— 探针没选 agent，
   拿到 `null` 就"没发包"，同样是假绿。修：按 store 的真实结构设 `store.agents` + `store.current`。
3. **t-r5-8 观察窗是另一个实例**：esbuild 把假 socket **内联**进包，探针 import 的是另一个模块实例，
   记录数组永远是空的。修：`external: true` + `file://` URL 让运行时 import 同一个实例
   （Windows 上直接写 `E:\...` 会被 Node 当成 scheme `e:`）。

同理，t-r5-10 第一版把"再次 `start()`"写在断言之前，`running` 被重新置 true → 假"复现"。已修。

---

## 5. 复现方式（一条命令跑全表）

```bash
cd "E:/我的世界ai"
bash docs/audit-r5/evidence/runtime/probes/run-all.sh
```

输出（真实）：

```
PROBE      TREE     RESULT
t-r5-1     current  exit=1  NOT-REPRODUCED：迟到的回复被丢弃（既不写 history、也不说给玩家）
t-r5-1     prefix   exit=0  REPRODUCED：!stop 之后迟到的回复仍然产生了副作用（history 1 条、聊天 1 条）
t-r5-2     current  exit=1  NOT-REPRODUCED：截断兜底串没有进入执行路径
t-r5-2     prefix   exit=0  REPRODUCED：注释被当代码送进执行路径（执行 1 次，返回 成功摘要）
t-r5-4     current  exit=1  NOT-REPRODUCED：暂停后心跳停止，并主动放掉了租约
t-r5-4     prefix   exit=0  REPRODUCED：暂停后新增 3 次心跳
t-r5-5     current  exit=1  NOT-REPRODUCED：保留的是最新的一批（120 条）
t-r5-5     prefix   exit=0  REPRODUCED：留下的是最旧的一批，place-199 丢失
t-r5-6     current  exit=1  NOT-REPRODUCED：异常后闸门已复位
t-r5-6     prefix   exit=0  REPRODUCED：isSpeaking 永久卡在 true
t-r5-7     current  exit=1  NOT-REPRODUCED：loop_active=false
t-r5-7     prefix   exit=0  REPRODUCED：loop_active 永久卡 true + state 仍 ACTIVE
t-r5-9     current  exit=1  NOT-REPRODUCED：保留旧摘要
t-r5-9     prefix   exit=0  REPRODUCED：半截摘要覆盖了长期记忆
t-r5-10    current  exit=1  NOT-REPRODUCED：running=false
t-r5-10    prefix   exit=0  REPRODUCED：running 仍为 true
t-r5-3     current  exit=1  NOT-REPRODUCED：上界成立（512 条）
t-r5-3     limit    exit=0  REPRODUCED：声明上限 512，实际 600 条
t-r5-8     current  exit=1  NOT-REPRODUCED：未连接时没有发包
t-r5-8     prefix   exit=0  REPRODUCED：request-terrain 进了 sendBuffer
```

单独跑一条 / 跑基线：

```bash
node docs/audit-r5/evidence/runtime/probes/t-r5-1.mjs
R5_SRC=E:/我的世界ai/mindcraft/tmp/r5-base-prefix/src node docs/audit-r5/evidence/runtime/probes/t-r5-1.mjs
R5_SRC=E:/我的世界ai/mindcraft/tmp/r5-base-limit/src  node docs/audit-r5/evidence/runtime/probes/t-r5-3.mjs
R5_WEB_FILE=docs/audit-r5/evidence/runtime/tmp/agents.prefix.ts node docs/audit-r5/evidence/runtime/probes/t-r5-8.mjs
```

基线 worktree 的建立（可重复）：

```bash
cd mindcraft
git worktree add tmp/r5-base-prefix 7524899      # R4 修复前
git worktree add tmp/r5-base-limit  "6c8758e^"    # R3-2 修复前
cd ..
git show 99f844d^:web/src/stores/agents.ts > docs/audit-r5/evidence/runtime/tmp/agents.prefix.ts
```

> ⚠️ **基线 worktree 在本次交付结束后已删除**（它们会把旧代码放进仓库目录，
> 全仓 lint / 补丁完整性闸扫到会误报）。要复跑基线，先执行上面两条 `git worktree add`；
> 跑完再 `git worktree remove tmp/r5-base-prefix --force` 清掉。
> `logs/*.prefix.log` / `logs/*.limit.log` 是**当时的真实输出**，已冻结在仓库里。
> `evidence/runtime/tmp/agents.prefix.ts` 保留（它是候选 8 的对照源码，不参与 lint）。

---

## 6. 边界与残留风险（不要当成"全部验证完毕"）

1. **全部是单元级/进程内驱动**，没有一条连真 MC 服或真模型。对"取消在真实网络往返下的时序"
   （例如 fetch abort 竞态）本轮无证据；那属于 R4 的隔离服 E2E（`docs/audit-r4/T11-隔离服E2E.md`）。
2. **候选 1 只覆盖"无动作在跑"的分支**。`actions.executing=true` 时"遗留标志不许清"的反向约束
   由 `tools/agent_cancel_late_reply_unit.mjs` 覆盖。
3. **候选 4 的板子是假的**：`getAsync` 的语义按 `board_client.getAsync` 的真实返回形状构造
   （`{ok, data:{job}}`），但跨进程"别人暂停了我的单"没有在真板上验证过。
4. **候选 8 的 socket 是假的**：假实现照 socket.io `autoConnect:false` 的缓存语义写，
   但没有跑真 socket.io-client 的 sendBuffer 行为（那需要浏览器/服务端）。
5. **候选 3 只证明"表有上界"**，没有证明"淘汰最旧一条"这个选择对限流正确性无害
   （被淘汰的 key 只是丢掉令牌计数 = 该来源短时多拿一点额度）。
6. 本轮**没有新增缺陷**：10 条候选在 HEAD 上均为已修状态。如果 captain 需要"还能修的东西"，
   本报告的产出是"回归护栏"而不是"待修列表"。

---

## 7. 文件清单

| 路径 | 说明 |
|---|---|
| `probes/t-r5-1.mjs` … `t-r5-10.mjs` | 10 条探针（退出码 0=复现 / 1=未复现 / 2=CANNOT-RUN） |
| `probes/r5-hooks.mjs` | 加载期只追加 export 的观察窗（候选 3、6） |
| `probes/r5-fake-socket.mjs` | 候选 8 的假 socket（照 socket.io 缓存语义） |
| `probes/run-all.sh` | 一次跑完"当前树 + 基线树"两遍 |
| `logs/*.current.log` / `logs/*.prefix.log` / `logs/*.limit.log` | 原始输出（真实，未经修饰） |
| `tmp/agents.prefix.ts` | 候选 8 的对照源码（`99f844d^`） |
