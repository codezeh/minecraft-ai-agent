# T32 运行时自愈与浮空 promise（第 7/19/32 条 + 第 31 条消费 + 第 11 条遗留）

> mindcraft `de5f8a0`（14 文件，钩子 ✓ 门禁通过）
> 根仓库：本文件。
>
> **T90 硬指标达成**：`npx --no-install eslint src main.js` → **`no-undef = 0`**、
> **`no-floating-promise = 0`**（未关任何规则）。
> 总错误：T04 记录的硬门基线 **304** → 现在 **197**（这个降幅里有本轮与其他并行任务
> 共同的清理，**不要全记在本条头上**）；剩下的 197 条全是
> `semi` / `require-await` / `no-empty` / `no-ex-assign`，不属本轮两条硬指标。
> 测试：`node tools/unit_all.mjs` → **90/90 通过、4 跳过**；`node tools/preflight.mjs` 通过。

---

## 1. 第 7 条：agent 永久死亡且不自愈

**病根**（`agent_process.js`）：`if (Date.now() - last_restart < 10000) { …不会重启 }`
—— 一次"起不足 10 秒"就**永久放弃**。而现场是：**Paper 重启要 20~60 秒**，
这期间 agent 连不上 → 起来马上就退 → 每次都落在打击范围内 → 从此再也不起。

**改法**：指数退避 `min(2^n × 2s, 60s)`；只有**连续** `MAX_QUICK_EXITS(8)` 次都起不来才放弃。
把决策抽成**纯函数** `planExit()` / `backoffDelayMs()`，退出处理抽成 `_onChildExit()`
（定时器可注入）——于是整张矩阵能离线逐格断言，不用真起子进程。

### 实测（命令与输出）

```
$ node tmp/t32/backoff_demo.mjs
=== ① 旧实现的判据（复刻） ===
  活了 3000ms → 永久不再重启（打印 "exited too quickly and will not be restarted"）
  活了 6000ms → 永久不再重启（...）
  活了 9000ms → 永久不再重启（...）
  ⇒ 现场：Paper 重启 20~60 秒，agent 每次都 < 10s ⇒ 第 1 次就永久死亡

=== ② 新实现的决策（同一串事件） ===
  第 1 次快速退出 → restart（2000ms 后重试）
  第 2 次快速退出 → restart（4000ms 后重试）
  第 3 次快速退出 → restart（8000ms 后重试）
  第 4 次快速退出 → restart（16000ms 后重试）
  第 5 次快速退出 → restart（32000ms 后重试）
  第 6 次快速退出 → restart（60000ms 后重试）
  第 7 次快速退出 → restart（60000ms 后重试）
  第 8 次快速退出 → unregister
  ⇒ 只有**连续 8 次**都起不来才放弃；退避 2s → 4s → 8s → 16s → 32s → 60s
```

> 这就是验收要的"退避序列 2s/4s/8s…/60s"（无法实弹停 Paper 60 秒，用 stub 断言）。
> 单测 `agent_process_backoff_unit` 9/9：序列、连崩 4 次仍重启、门槛第 8 次才放弃、
> 活过 10 秒计数清零、stop() 取消退避重启。

---

## 2. 第 19 条：缺一个人就让整套服务退出

**病根**：`if (code > 1) { console.log('Ending task'); process.exit(code); }`
—— 触发源是 `agent.js:496 cleanKill('Not all required players/bots are present', 4)`。
**缺一个玩家/一个 bot，整个 mindserver 退出**：其他 bot、面板、任务板库一起没。

**改法**：只摘掉**这个** agent —— 注销（`logoutAgent`）+ 从 `agent_processes` 删除自己
（宿主注入 `unregister = () => destroyAgent(name)`；用注入而不是反向 import，避免
`mindcraft → agent_process → mindcraft` 循环依赖）。

```
$ node tmp/t32/backoff_demo.mjs   # ③ 段
=== ③ 第19条：退出码 > 1（缺玩家/缺 bot）===
  planExit(code=4) → action=unregister：退出码 4 > 1：只摘掉这个 agent，不动其他进程
  旧实现：process.exit(4) —— **整个 mindserver 一起退出**（其他 bot/面板/任务板全没）
  新实现：只摘掉这个 agent，进程继续活
```

源码守卫（单测 ⑥）：`agent_process.js` 去掉注释后 **`process.exit` 出现 0 次**。

★ **一处需要你知道的边界**：`killAll()` 走的是另一条路（`serverProxy.shutdown()` →
socket `'shutdown'` → mindserver 自己 `shutdown()`），那是"任务真的结束了"的**故意**行为，
本轮**没动**它 —— 它和"单个 agent 意外退出"不是同一类。

---

## 3. 第 32 条：心跳一次异常就永久停摆

**病根**：`setTimeout(async () => { while (true) { await this.update(...) } }, 300)`
**整段没有 try/catch**。`update()` 抛一次（`modes.update()` 里一个 ReferenceError 就够）
就把循环**彻底打死**，而且**没有任何人会重启它**；偏偏聊天走 `handleMessage`、**不依赖**它
⇒ bot 进入"只会聊天、不会做事"的半死状态：进程活着、面板在线、她再也不动。

**改法**：循环抽到 `src/agent/library/heartbeat_loop.js`（新模块，已申报 73），
**逐拍** try/catch：异常 → 一行告警 → 下一拍照跑。告警通道自己抛也不许反噬。

### ★ 验收要的"人工构造一次 modes.update() 抛异常：心跳继续、日志有告警"

```
$ node tmp/t32/heartbeat_demo.mjs ; echo "EXIT=$?"
=== 开始心跳（共 6 拍，第 2 拍让 modes.update() 抛异常）===
  [bot] 第 1 拍：正常
  [bot] 第 3 拍：正常
  [bot] 第 4 拍：正常
  [bot] 第 5 拍：正常
  [bot] 第 6 拍：正常
=== 结束：实际跑了 6 拍，最后一拍序号 6 ===
结论：抛异常之后**心跳仍在继续**（第 3~6 拍照跑）
EXIT=0
[stderr]
[心跳] update() 抛异常，本轮已隔离、循环继续：modes.update 里一个未声明变量（真实缺陷的形态）
```

> 读法：`[bot] 第 2 拍` 那行**没有出现**（它抛了）+ stderr 上有一行告警 +
> 第 3~6 拍照常跑完。**改之前**同一场景会停在第 2 拍（单测 ⑥ 用复刻的老循环证明了这一点：
> `旧：抛「…」拍数=2；新：6 拍继续`）。

---

## 4. 第 31 条：agent.js 消费 FAILED_REPLY

`src/models/_shared.js`（T11 交付）导出 `FAILED_REPLY` / `failedReply()` / `isFailedReply()`。
**生产端打标记，消费端不认 = 标记没用**：这条"回答"会写进 history、真的说给玩家、
还吃掉一次 response 预算（`max_responses`）。

改法：`let res = await this.prompter.promptConvo(history)` 之后立刻判 ——
命中就**当空响应** `break`：不写 history、不 `routeResponse`。

单测 `agent_failed_reply_unit` 6/6，其中：
- ① 判据正反 8 例（含「提到牌子但不在开头」不误判）；
- ② 接线守卫：`if (isFailedReply(res))` 的**位置在** `history.add` / `routeResponse` **之前**
  （`guard@20733 < history@21320, route@21865`）；
- ③ **失败反证**：老逻辑同一输入 → `effects=2`（写 history + 说给玩家）；
  新逻辑 → `effects=0`。

---

## 5. 第 11 条遗留（让门禁真正变绿）

| 位置 | 病根 | 改法 |
|---|---|---|
| `modes.js:118/126` | `const success = await placeBlock(...)` 但判的是 `if (placed)` —— `placed` **从未声明** | `if (success)` |
| `modes.js:133` | 同上，`if (walked)` | `if (success)` |
| `item_goal.js:163` | `res = await skills.attackNearest(...)` —— 给未声明标识符赋值 | `const res = ...` |

★ 为什么这是**行为缺陷**而不只是 lint：这三处都在 `execute()` 的 try/catch 里，
ReferenceError 被吞成一行 `console.warn` ⇒ **身上着火时水桶灭火永久静默失效**；
`item_goal` 那处更直接，hunt 类目标**必抛**、永远打不完（还伪装成"任务在做"）。

### 浮空 promise：36 条全部收口

| 文件 | 条数 | 做法 |
|---|---|---|
| `src/agent/modes.js` | 23 | `say()` **去掉没用的 async**（体内无 await），并把 `agent.openChat()` 的 rejection 显式接住；`execute()` 的 11 个调用点改走 `fireModeAction()` —— 一个**显式错误边界**（`execute` 本身仍 async，因它要 await runAction） |
| `src/agent/speak.js` | 9 | 队列泵 `processQueue()` 是自递归 + 顶层同步 → 加 `continueQueue()` 统一接住；本就在 async 回调里的两处直接 `await processQueue()` |
| `src/agent/conversation.js` | 3 | 1 处**真该 await**（`_scheduleProcessInMessage`）；2 处 `_resumeSelfPrompter()` 会 sleep 5 秒**不能 await** → 显式 `.catch` |
| `src/agent/mindserver_proxy.js` | 1 | `get-map` 的 async IIFE 补 `.catch` |
| `src/process/init_agent.js` | 1 | 顶层 IIFE 补 `.catch`（**注**：这条在 T04 交接里标的是 T20 的领地，但它挡住硬指标，且文件当时干净无人编辑，我改了并在此标注） |

★ 这里没有一处是"加 await 让它不报"。区别在于：**浮空 promise 的真问题不是"没等待"，
而是"没人处理 rejection"**。所以要么真的该等（`_scheduleProcessInMessage`），
要么给 fire-and-forget 一个显式的错误边界（其余）。

---

## 6. 需要你复核/知情的几点

1. **`init_agent.js:48` 我越界清了一条**（T04 交接标注为 T20 领地）。理由：它独自挡住
   `no-floating-promise = 0` 这条硬指标，且改动只有一行 `.catch`。若 T20 也要动这个文件，
   以它为准合并。
2. **`killAll()` 路径没动**（§2 末）：任务正常结束时整套退出是**故意的**，与"单 agent 崩溃"不同类。
3. **`MAX_QUICK_EXITS = 8`** 是我选的值：它让退避序列能走满 2/4/8/16/32/60（含封顶）再放弃。
   若你希望更快放弃（比如 5 次），改一个常量即可，用例会跟着变（门槛用例是参数化的）。
4. **`自研申报.md` 申报 73** 是 preflight 的硬要求（新 library 模块必须有「结论：已批准」记录），
   所以它和代码同一次提交。
5. **lint 棘轮 +17 不是我的**：`tools/llm_usage_unit.mjs`（T11 security 的新文件，单独跑 19 条）。
   我新增的 3 个测试文件单独 eslint **0 问题**，且没跑 `--update`。

---

## 7. 验收对照表

| 验收项 | 结果 |
|---|---|
| `eslint src` → `no-undef = 0` | **0** ✅ |
| `eslint src` → `no-floating-promise = 0` | **0** ✅（39→0，含 T21 已清的 skills 2 条） |
| `node tools/unit_all.mjs` 不回归 | **90/90 通过、4 跳过** ✅ |
| 人工构造 `modes.update()` 抛异常 → 心跳继续 + 日志告警 | §3，`EXIT=0`，第 3~6 拍照跑，stderr 一行告警 ✅ |
| 退避序列 2s/4s/8s…/60s | §1，`backoffDelayMs(1..8) = 2000,4000,8000,16000,32000,60000,60000,60000` ✅ |
| 第 19 条：`process.exit` 消失 | 单测 ⑥ `found=0` ✅ |
| 第 31 条消费端 | 单测 ②/③（guard 在副作用之前 + 反证 effects 2→0）✅ |
| 第 11 条遗留 5 条 no-undef | 单测 ④/⑤ + eslint 0 ✅ |

---

## 8. 未做 / 记账

1. **实弹"停 Paper 60 秒再起"没跑**（本机没有可控的 Paper 实例与本轮时长）。按验收的
   "若无法实弹，至少用 stub 断言退避序列"交付：`planExit`/`backoffDelayMs` 的序列与门槛已逐格断言，
   且 `_onChildExit` 用注入定时器验证了"真的排了重启、stop() 能取消"。
2. **`agent.js` 里的 `no-ex-assign`（`err = err.toString()`）没动** —— 不属本轮两条硬指标，
   且改它要动 catch 分支的语义（`err.stack` 之后被重赋值），风险大于收益，记账。
3. **`semi`/`require-await`/`no-empty` 共 197 条未动** —— 不在 T90 本轮指标内（它们属第三批清理），
   也没有为了让数字好看去 `--fix`（那会把这些文件变成大面积 diff，掩盖真正的两行修复）。
