# 控制：谁在动身体、打断、恢复

> 2026-11-01 新增。补 `ARCHITECTURE_REDESIGN.md` §6.5（中断、超时与 mode 的边界）没讲到的部分：
> 任务板进来之后，被打断的事怎么接着做，以及死亡、断线、重启（原计划的 §8 错误恢复）。
> 前台 / 后台怎么协调、为什么不加锁，沿用 [`legacy/并发协调机制.md`](../legacy/并发协调机制.md) 的结论。

## 1. 现在有几样东西在驱动身体

| 机制 | 怎么驱动 | 位置 |
|---|---|---|
| `action_manager` | 一个前台动作槽 + 一个 resume 槽；新动作开始前先 `stop()` 旧的；默认 10 分钟超时 | `action_manager.js:20` `:28` `:202` |
| modes | 每 tick 检查；`interrupts` 决定能打断谁，触发时经 `execute()` → `runAction` 打断前台 | `modes.js:328` |
| `task_modes` | 流程开始时暂停 `GOAL_MODES`，`finally` 里恢复 | `task_modes.js:13-20` |
| auto-eat 插件 | 在 `physicsTick` 上自己判断、自己换手、自己吃，**不经 `action_manager`** | `agent.js:229` |
| `self_prompter` | 空闲时按 `!goal` 的目标催模型 | `agent.js:48` |
| 任务板调度器（计划） | 空闲时领单 | 06 §8 |

问题：
- mode 打断前台后，没有 `resume_func` 就发 AUTO MESSAGE 让模型重新决定（`modes.js:350-360`），进度从零开始
- auto-eat 吃东西时会换掉手里的工具，正在跑的流程不知道
- `stop()` 等 10 秒就强制复位，旧动作可能还在跑（D18）；`timedout` 置上后不复位（D17）

## 2. 谁先谁后

```
反射  >  任务单（priority 9 → 0）  >  空闲行为
```

- **反射**：保命，不经任务板，能打断任何事
- **任务单**：玩家的命令就是 9 级任务单（06 §7），不单独占一档；高优先级抢占低优先级，同级排队
- **空闲行为**：没有单在跑时才动，从不打断别人
- **即时命令**（`!stop` `!stay` `!setMode` `!equip` `!lookAtPlayer` …）：不进任务板，直接走 `action_manager`；打断任务单时按 §4 的 `brief` 处理

## 3. 现有 mode 归到哪

| mode | `interrupts` | 任务中 | 归类 | 目标做法 |
|---|---|---|---|---|
| `self_preservation` | all | 照跑 | 反射 | 不变；打断任务单时走 §4 |
| `self_defense` | all | 照跑 | 反射 | 同上 |
| `cowardice` | all | 照跑 | 反射 | 同上 |
| `unstuck` | all | 暂停（`GOAL_MODES`） | 导航自救 | 导航层自带被困检测（`atom_stuck_detect`）；`unstuck` 只在空闲时跑 |
| `hunting` | action:followPlayer | 暂停 | 空闲行为 | 保持；任务里要打猎用 `flow_fight` / `strat_food` |
| `item_collecting` | 同上 | 暂停 | 空闲行为 | 保持；任务里捡东西用 `flow_pickup` |
| `torch_placing` | 同上 | 暂停 | 空闲行为 | 保持 |
| `elbow_room` | 同上 | 暂停 | 空闲行为 | 保持 |
| `idle_staring` | 无 | 暂停 | 空闲行为 | 保持 |
| `cheat` | 无 | — | 开发用，默认关 | 陪玩时不许开 |
| auto-eat（插件） | 不经 `action_manager` | 照跑；`flow_eat` 期间暂停 | 反射 | §6 |

## 4. 打断的原因决定任务单去哪

`stop()` 加一个原因参数，调用方必须带上；记在 `actions.stop_reason`，调度器读它。

| 原因 | 谁调 | 被打断的任务单 | 结果码 |
|---|---|---|---|
| `brief` | 反射 mode，或即时命令（§2） | 留在本 bot（仍是 `claimed`，租约照常心跳），打断结束接着做；超过 60 秒没结束就退回 `ready` | 不写 |
| `preempt` | 调度器：来了更高优先级的单（包括玩家的新命令） | `ready`，放掉租约和预约 | `PREEMPTED` |
| `player` | `!stop` / `!stay` | `paused`，并暂停自动领单（06 §7） | `INTERRUPTED` |
| `timeout` | `action_manager` 的总超时 | 按 `attempts` 重试或 `failed` | `TIMEOUT` |
| `shutdown` | 进程退出 | 不改；租约过期后回 `ready`（06 §6） | — |

**流程不知道是谁打断的**：一律返回 `INTERRUPTED`（S3：`interrupt_code` 只读），`PREEMPTED` 只由调度器写进任务单结果。60 秒是起步值。

反射打断一张任务单的完整过程：
1. 反射 mode 触发 → `execute()` → `runAction` → `stop('brief')`，置 `interrupt_code`
2. 流程在下一步之前看到它（原子在等待中每 ~100ms 查一次，01 A3）→ `ctx.save(checkpoint)` → 返回 `INTERRUPTED`，带 `count / want`
3. 调度器按原因把单留在本 bot
4. 反射跑完 → 调度器在下一个空闲 tick 重新跑这张单 → `plan()` 读 checkpoint 接着做
5. 被打断的是任务单时**不发** AUTO MESSAGE（那条会让模型重新下命令），改给模型一行状态（08 §2）

## 5. 停不下来的动作（D17 / D18）

JS 没法强行取消一个 Promise，取消全靠流程和原子自己查 `interrupt_code`。所以：
- `stop()` 等满 10 秒还没退出 = bug，不是慢
- 不要在它上面开新动作。现在就是这么做的：强制复位后，新动作开头清掉 `interrupt_code`，旧动作再也看不到中断，两个流程同时驱动身体（D18）
- 改成：`releaseAll()` + `pathfinder.stop()` + `stopDigging()`，发 `zombie-action` 事件（动作名、已等多久），然后重启 agent 进程。用现有的 `cleanKill`（`agent.js:612` 一带：退出码 > 1 时提示 Restarting，由 `agent_process` 重新拉起）；任务单靠租约过期 + checkpoint 接着做
- `_executeAction` 开头复位 `timedout`（D17）

## 6. auto-eat

- 插件在 `physicsTick` 上自己吃，吃的时候换手；所以**每个动作入口自己 equip**，不假设手里还是上一步的东西（`digBlock` 已经这样，02 §2）
- `flow_eat` 期间暂停 auto-eat（04 §6.2）
- 吃一次约 1.6 秒，这期间流程的挖 / 放 / 打可能和它抢手。先接受；真机发现经常打架，再把 auto-eat 收进控制层，当反射走 `stop('brief')`

## 7. 死亡、断线、重启

| 事件 | 现在 | 目标 |
|---|---|---|
| 死亡 | `agent.js:546`；记 `last_death_position`（`:271`），告诉模型东西还在那（`:297`） | 正在跑的单 → `paused`（`result` 记 `died`，不算 attempts）；复活后重查 `requires.items`，缺了 → `blocked`。另开一张"回去捡"的个人单：`goto` 死亡点 → `pickup`，8 级，deadline 4 分钟（掉落物 5 分钟消失）。死因是岩浆或掉出世界就不开：东西已经没了，那里也危险。死因从 `messagestr` 判断（`agent.js:562` 已在听） |
| 断线 / 被踢 | `agent.js:101-102` → `onDisconnect` | 租约 30 秒没心跳 → 单回 `ready`（06 §6）；重连后照常领单；手里那张当 `LEASE_LOST` 处理 |
| agent 进程重启 | 正在做的事全丢 | 同断线；checkpoint 在任务板库里 |
| mindserver 重启 | — | 任务板从 sqlite 恢复；`claimed` / `running` 的单按租约到期回收 |
| 服务器重启 | — | 同断线 |
| 区块没加载（`NO_DATA`） | 各流程自己处理 | 统一：等 1 秒 `retry`，最多 3 次，再 `replan` |

## 8. 超时一层套一层

| 层 | 谁定 | 说明 |
|---|---|---|
| 任务单 | `deadline`，没有就 `manifest.timeoutMs` | 例：smelt 600 秒（04 §4.1） |
| 流程的每一步 | 传给动作的 `opts.timeout` | 不超过 `deadline - now` |
| 原子 | `opts.timeout`（01 A4） | 由动作给 |
| `action_manager` | `_startTimeout`，默认 10 分钟（`action_manager.js:202`） | 兜底 |

- 内层不超过外层剩下的时间；每层超时返回 `TIMEOUT` 往上报（D9 的根因是 deadline 只在循环开头查）
- 任务单跑在 `runAction(label, fn, { timeout })` 上，`timeout` 按任务单 deadline 换算成分钟传进去。不能吃默认的 10 分钟，否则 30 分钟的策略会被砍

## 9. 落地清单（M2，00 §10）

1. `_executeAction` 开头复位 `timedout`（D17）
2. `stop(reason)`，调用方按 §4 带原因
3. §5 的停不下来处理（D18）
4. `modes.js` 的 `execute()`：原因写 `brief`；被打断的是任务单时不发 AUTO MESSAGE
5. 有任务单在跑或排队时 `self_prompter` 不催（08 §2）
6. 任务单的 `runAction` 带上 deadline（§8）
7. 死亡 → `paused` + 回去捡的单（§7）
8. 删掉 `task_follow.js:85` 写 `interrupt_code = false`（D19）

测试：
- 离线：假 `action_manager` + 假任务板，§4 每个原因各一条状态转移用例
- 真机：采集中让她着火（RCON 在脚下放火）→ `self_preservation` 灭火 → 接着采，采集数不重复
