# Mindcraft 架构概览

> **本目录是新规范（权威）**。`docs/legacy/` 只作历史参考，冲突时以本目录为准。
> 2026-11-01 改版：原子收窄为"一次玩家输入"、恢复动作层、复合技能分流程级与策略级、新增任务板。
> 契约（返回结构、错误码、data 白名单、参数命名）仍以 [`ARCHITECTURE_REDESIGN.md §6`](ARCHITECTURE_REDESIGN.md) 为唯一来源。

## 1. 分层

```
模型（LLM）                 决定"想要什么"：选目标、看失败码决定换路还是问玩家
  │  !命令 / !do / !addJob
commands/                   解析命令；直接执行，或交给任务板
  │
任务板 + 调度器              谁、什么时候、做哪张单：个人单 / 多人单、优先级、抢占、续做、预约     → 06
  │  skill + args + ctx
复合技能·策略级 strat_*      多目标：需求图反推 → 派子任务单                                     → 04
复合技能·流程级 flow_*       单目标：plan → runSteps → onFail                                   → 04
  │        └─ 导航 nav_core.goTo → executor / path_3d / terrain3d（移动的唯一入口）           → 05
动作 act_*                  一个动词：固定序列 + 前置 + 后置校验，不重试                       → 02
原子 atom_input_* / atom_read / atom_wait   一次玩家输入或一次纯读取                           → 01
  │
mineflayer
```

横向：
- **查询**（`query_*`）：多次读取组合成的判断，无副作用，任何层可调（[`01 §5`](01_primitives.md)）。
- **反射**：任务期间不被 `task_modes` 暂停的 mode（`self_preservation` / `self_defense` / `cowardice`）和 `mineflayer-auto-eat`；直接打断，不走任务板（[`06 §7`](06_task_board.md)）。
- **基础设施**：`atom_contract`（ActionResult / CODES）、`step_runner`、`trace_bus`、`rules/`。

**用名字称呼层，不用编号**：旧文档里的"Layer 2"有时指任务、有时指导航，编号已经不可靠。

## 2. 每层一句话判据

| 层 | 判据 | 不许 |
|---|---|---|
| 原子 | "按一下 / 按住直到 / 看一眼"一句话说完 | 判断、重试、调别的原子 |
| 动作 | 一个动词，顺序固定 | 寻路、重试、调别的动作 |
| 流程 | 一个目标，有 `onFail` 表 | 直接按键 |
| 策略 | 多个目标，输出子任务单 | 直接调动作、导航 |
| 任务板 | 只管数据和调度 | 知道"怎么做" |

## 3. 现状 vs 目标

| 层 | 现状 | 目标 | 文档 |
|---|---|---|---|
| 原子 | 按新定义只有 3 个（`atom_look` / `atom_wait` / `atom_wait_item`）；按键散在 8 个文件 | 44 个，收进 6 个文件 | [01](01_primitives.md) |
| 查询 | 8 个，名字仍是 `atom_*` | 改名 `query_*` | [01 §5](01_primitives.md) |
| 动作 | 8 个，名字仍是 `atom_*` | 43 个，改名 `act_*` | [02](02_actions.md) |
| 流程 | 约 6 个（`task_*` / `skill_*`）+ 导航 | 24 个（P0 与已有 17，P1 7），改名 `flow_*` | [04 §6](04_skills.md) |
| 策略 | 0 | P0/P1 6 个，P2 4 个 | [04 §6.3](04_skills.md) |
| 任务板 | 无（`action_manager` 只有一个不落盘的 resume 槽） | B0–B4 五期 | [06](06_task_board.md) |

## 4. y 坐标口径（定稿，用户选 1B）

| 名字 | 是什么 | 谁用 |
|---|---|---|
| **面位** | 脚下那块**实心方块**的 y | terrain3d 存储、path_3d 规划、**所有对外接口和命令参数** |
| **脚位** | 面位 + 1，bot 脚所在的空气格 | 只在执行层内部换算（`execStep` 里 `targetFeetY = step.y + 1`） |

- `Math.floor(bot.entity.position.y)` 得到的是**脚位**，要面位得减 1。
- 旧文档里的"脚格"一词含糊（有时指实心块、有时指空气格），**停用**。
  `ARCHITECTURE_REDESIGN.md §3.4` 写"`floor(y)` 即脚格（实心方块）"是错的，以本节为准。
- 代码已按此实现（`ba84907`）：`exec_step_y_unit` 3/3；`verify_y_semantics` 在真机地图库上面位命中 100%、脚位 6.7%。

## 5. 统一结果

原子（输入类）、动作、流程、策略都返回 `ActionResult`：`{ ok, code, message, data }`。
`code` 只能取自 `ARCHITECTURE_REDESIGN.md §6.2` 的白名单（31 条，另有 [`02 §4`](02_actions.md) 计划新增 7 条），`fail()` 对表外 code 直接抛异常。
读取原子例外：直接返回数据或 `null`。
`skills.js` 的上游老函数仍返回 boolean，迁到 flow 之前不动。

## 6. 本目录文档

| 文件 | 讲什么 |
|---|---|
| `00_overview.md` | 本文：分层、口径、阅读顺序 |
| [`01_primitives.md`](01_primitives.md) | 原子：定义、规矩、44 个清单、查询 |
| [`02_actions.md`](02_actions.md) | 动作：怎么调原子、43 个清单、新错误码、改名与 import 规则 |
| [`03_tasks.md`](03_tasks.md) | 旧任务层能力盘点（30–40 个签名）；规范以 04 为准 |
| [`04_skills.md`](04_skills.md) | 复合技能：两级、调用规矩、规划、编写规范、清单 |
| [`05_navigation.md`](05_navigation.md) | 导航：`nav_core` / executor / path_3d / terrain3d |
| [`06_task_board.md`](06_task_board.md) | 任务板：个人单 / 多人单、生命周期、抢占、预约、多 bot |
| [`07_control.md`](07_control.md) | 控制：谁在动身体、打断原因与恢复、停不下来的动作、auto-eat、死亡 / 断线 |
| [`08_interface.md`](08_interface.md) | 接驳层：模型什么时候被叫、命令的去向、结果回传、权限、陪玩默认行为 |
| [`09_crosscut.md`](09_crosscut.md) | 横切：数据归属、事件、配置、安全、测试、版本 |
| [`ARCHITECTURE_REDESIGN.md`](ARCHITECTURE_REDESIGN.md) | §6 契约（权威）；§2 机制覆盖分析 |
| [`ARCHITECTURE_REDESIGN_PART2.md`](ARCHITECTURE_REDESIGN_PART2.md) | 测试策略、Phase 时间表、MC 机制附录 |
| [`REFACTOR_ANALYSIS.md`](REFACTOR_ANALYSIS.md) | 现状诊断、**缺陷台账 D1–D27**、勾选式路线图 |

阅读顺序：本文 → `ARCHITECTURE_REDESIGN.md §6` → 要改哪层看哪份（01 / 02 / 04 / 05 / 06）→ `REFACTOR_ANALYSIS.md` 的台账和路线图。

## 7. 新增一个能力：各层各做什么（以"钓鱼"为例）

| 层 | 要做的 |
|---|---|
| 原子 | 不用加：`useHeld`、`waitEvent` 都在清单里 |
| 动作 | `fishOnce`：有鱼竿、面前有水 → `bot.fish` → 背包有新物品 |
| 流程 | `flow_fish`：找水 → 站到岸边 → 循环 `fishOnce` → 鱼竿快坏就停；写 `manifest` |
| 策略 | 通常不用；`strat_food` 把 `fish` 当作一种食物来源 |
| 任务板 | 玩家说"钓 20 条鱼" → 一张 `skill: 'fish'` 的个人单 |

实施顺序见 §10；逐项勾选清单在 `REFACTOR_ANALYSIS.md §5`。

## 8. 术语表

| 词 | 指什么 | 别和谁混 |
|---|---|---|
| 原子 | 一次玩家输入，或一次纯读取（01 §1） | 动作 |
| 查询 | 多次读取合成一个判断，无副作用（`query_*`） | 原子里的读取 |
| 动作 | 有前置、后置的一件事（`digBlock`），由原子和 mineflayer 现成动作组成（`act_*`） | 原子、流程 |
| 导航 | 跨格移动（`nav_core.goTo` 和它下面的 executor、规划器） | 动作里的单格 `stepInto` |
| 流程 / 策略 | 复合技能的两级（`flow_*` / `strat_*`，04 §1） | 任务单 |
| 任务单 | 任务板上的一条数据：谁、做什么、做到哪（06 §1） | 复合技能 |
| "任务" | 以后只指任务单。代码里的 `task_*.js` 在 Phase R 改成 `flow_*`；上游的 `src/agent/tasks/` 是评测任务，和这两个都无关 | — |
| 个人单 / 多人单 | `kind: 'personal'` / `'shared'` | — |
| 预约 / 租约 | 预约锁资源（方块、箱子…，06 §9.2）；租约锁任务单（谁在做，06 §6）；都靠心跳续期 | — |
| 断点 | `checkpoint`：流程存的进度，重启或被打断后接着做 | — |
| 反射 / 空闲行为 | 反射保命、能打断一切；空闲行为只在没有单时跑（07 §2） | mode（两者都用 mode 实现） |
| idle_planner | 空闲时自己找事做的那一层，产出 0–2 级的任务单（08 §6.1） | 空闲行为（mode） |
| 接驳层 | 模型和系统之间：命令、结果回传、权限（08） | — |
| 面位 / 脚位 | 面位 = 脚下实心块的 y，对外统一用它；脚位 = 面位 + 1，只在 executor 里用（§4） | 旧词"脚格"（已废） |
| 打断 / 抢占 | 流程一律返回 `INTERRUPTED`；调度器按原因记成 `PREEMPTED` 等（07 §4） | — |

## 9. 决定记录

| 日期 | 决定 | 出处 |
|---|---|---|
| 10-31 | y 统一用面位（1B） | §4 |
| 11-01 | 原子 = 一次玩家输入或一次纯读取 | 01 §1 |
| 11-01 | 文件名前缀就是层级；`library/` 保持平铺 | 02 §5 |
| 11-01 | 复合技能不单开命令，只加 `!do` / `!listSkills`；参数用 `key=value` 串 | 04 §4.5、§5 |
| 11-01 | 任务板放 mindserver，`node:sqlite` | 06 §3 |
| 11-01 | bot 之间交接物品走 store + fetch，不当面丢 | 06 §9.4 |
| 11-01 | 3D 地形库暂不共享 | 06 §9.3 |
| 11-01 | `flow_eat` 期间暂停 auto-eat | 04 §6.2 |
| 11-01 | Phase R 放在 Phase A 之后、补动作之前 | 02 §5 |
| 11-01 | 落点检查只拦危险面，不拦水面 | `executor.js` 注释、05 末节 |
| 11-01 | `findStandSpot` 不加 `isSafe` 过滤 | REFACTOR D27 |
| 11-01 | mindserver socket 只放本机连接 | 09 §4 |
| 11-01 | 流程只返回 `INTERRUPTED`，`PREEMPTED` 由调度器记 | 07 §4 |
| 11-01 | 水面过河用单独的 `swim` 步和动作 `swimStep`，不交给 pathfinder | 05 末节 |
| 11-01 | 权限写在每只 bot 的 profile JSON（`permissions`）；没配 owner 时人人按"信任" | 08 §5、09 §3.1 |
| 11-01 | 空闲时不跟随，自己找事做（idle_planner）；跟随只在玩家要求时做（`flow_follow` 单） | 08 §6.1 |
| 11-01 | `protect_owner` 反射，只在跟随主人时生效 | 07 §3.1 |
| 11-01 | `!stay` 不停 `self_preservation` | 07 §3.2 |
| 11-01 | server-ip 只绑本机；RCON 换密码并改读 `server.properties` | 09 §4（M1） |

**可调的默认值**（不用再定，改 profile 就行）：idle_planner 多久想一次、活动半径（09 §3.1）。
更早的"为什么不"见 `legacy/陪玩改造方案.md §13`。

## 10. 实施顺序

| 里程碑 | 内容 | 依赖 |
|---|---|---|
| M0 ✅ | Phase 1、Phase 2 大部分、`nav_core`、爬梯空等；D14 / D15 / D25 / D27；socket 只放本机 | — |
| M1 安全 | RCON 改读 `server.properties` + 换密码；server-ip 只绑本机；`openChat` 拦 `/`；按发言人分级 + profile 的 `permissions`（08 §5、09 §3.1） | 无，**先做** |
| M2 控制 | 07 §9 的清单（含 D17 / D18 / D19）；trace 只写一次（09 §2，D10） | 无 |
| M3 原子收拢 | Phase A（顺手 D16 / D21 / D22） | 可与 M2 并行 |
| M4 改前缀 | Phase R | M3 |
| M5 注册表 | `composite_registry` + `makeCtx`（04 §4.6）；现有 6 个流程补 manifest；`!do` / `!listSkills`（D24）；顺手 D20 | M2 |
| M6 动作 | 7 个新 code；P0 动作（REFACTOR"动作补齐"）；`swimStep` + `path_3d` 的 `swim` 边 + executor 的 `swim` 分支（05 末节） | M4 |
| M7 P0 流程 | craft → smelt → store / fetch → eat → mine → farm → fight → build | M5、M6 |
| M8 任务板 | B1 个人单 + 持久化 → B2 调度、抢占；周期单（06 §13） | M5 |
| M9 接驳层 | 命令改路由（08 §3）；结果格式（08 §4）；idle_planner（08 §6.1）；`protect_owner`（07 §3.1，只依赖 M1、M2，可以提前做）；D23 | M7、M8 |
| M10 策略 | `strat_obtain` → `tool_tier` → `first_night`（先做 `flow_shelter`）；关掉 NPC 执行循环（08 §7） | M7；长策略要 M8 |
| M11 多 bot | B3 / B4 | M8 |

06 §11 的 B0 = M2 + M5 里的 ctx 注入。Phase 5（上游清理）、Phase 6（性能与可观测性，含 D26）、Phase 4.1 的剩余项穿插着做。
