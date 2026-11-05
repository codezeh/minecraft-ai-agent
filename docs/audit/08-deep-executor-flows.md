# 深读②：执行器与流程层（executor / composite_registry / construction_tasks / 4 个 flow）

第二轮深读。目标：把审计①/② 自报「未读」的部分读完，并给出**执行器失败语义、材料记账、中断链路**三张全图。

---

## 0. 读了什么（含全文/部分，不粉饰）

| 文件 | 行数 | 覆盖 | 说明 |
|---|---:|---|---|
| `src/agent/library/executor.js` | 1097 | **全文** | 分 3 段读：1-80、80-869、869-1097 + 1006-1030 补缝 |
| `src/agent/library/composite_registry.js` | 614 | **全文** | 1-400（本轮）+ 400-614（审计②已读） |
| `src/agent/tasks/construction_tasks.js` | 1104 | **全文** | 1-380 / 381-780 / 781-1104 |
| `src/agent/tasks/tasks.js` | 597 | **部分** | 190-597 通读；1-190 只读了 `checkItemPresence` 与 `CookingCraftingTaskValidator`（`:190-232`） |
| `src/agent/library/flow_follow.js` | 526 | **全文** | 1-526 |
| `src/agent/library/nav_pathfinder.js` | 505 | **全文** | 1-505 |
| `src/agent/library/flow_collect_plan.js` | 523 | **全文** | 1-249 + 250-523（分两次） |
| `src/agent/library/flow_shelter.js` | 550 | **部分** | 只读了结构（`grep` 全文的 interrupt/loop/deadline/`ctx.deadline` 全部 20 处 + `:197-198`）；**未逐行通读** |
| `src/agent/library/terrain3d.js` | 614 | **部分（跨两轮）** | 审计②读过 1-130 / 150-430 / 510-620；**430-510（`boxSurfaces`/`saveSurfaces`/`clearChunk`）本机仍未读** |
| `src/agent/tasks/cooking_tasks.js` | — | **未读** | 本轮未纳入 |

**没读的**：`flow_build.js`（`flow_shelter` 提到"每格都查 interrupt"，但那是 `flow_build` 的行为，本轮未打开确认）、`act_dig.js`/`act_step.js`/`act_pillar.js` 内部（只从调用点推断它们会在被中断时返回 `INTERRUPTED`）、`path_3d.js`。

### 段落结构图（验收要求：证明全文读完）

**`executor.js` 1097 行**
```
1-30      import / 常量（SCAN_R=36, LOOK_AHEAD=16, MAX_ROUNDS=120）
33-78     blockAt / IS_AIR / IS_LIQUID / IS_DIGGABLE 辅助
91-677    execStep()  ← 单步执行器（本文件的核心）
  ├ 124-176   climb 分支（先水平挪 → 判可攀爬 → climbUp/climbDown）
  ├ 183-191   dig/digdown 的工具前置检查（canDigWithInventory）
  ├ 193-318   dig 分支（同列=往上挖穿 / 邻列=横挖人形通道；含假成功守卫 275-308）
  ├ 320-364   digdown 分支（含 liquid-pass 跳出，**无高度复核**）
  ├ 366-379   跳 2 格以上 → 循环 stepUp
  ├ 381-460   落点安全检查（LAVA / WATER / fallRisk）
  ├ 462-479   swim 分支（不交给 pathfinder）
  ├ 481-518   walk：先 stepInto(500ms)，失败回落 pathfinder
  ├ 520-562   可攀爬格"已到位"窄守卫
  ├ 564-565   moveToXZ（tol 0.8, timeout 30s）
  └ 567-676   走完校验高度（太高→往下挖/潜水；太低→补垫 stepUp）
683-746   stepUp()（清脚下/挖头顶 → pillarUpOnce ×3）
755-1055  walkTo()  ← 3D 滚动重规划主循环
  ├ 799-800   pauseGoalModes / restoreGoalModes
  ├ 824-832   每轮中断 + deadline 检查
  ├ 838-871   振荡检测（同一区域 ≥3 次 → recordFail ×3）
  ├ 905-914   scanSphere（每轮整球扫）
  ├ 936-977   plan3D（失败则再扫一次再规划）
  ├ 986-1043  逐格 execStep（MAX_STEPS=10/轮）
  └ 1046-1049 跑满 120 轮 → NO_PATH
1058-1065 describeStore()
1082-1097 updateSurfAfterDig()（挖后局部改 terrain3d）
```

**`composite_registry.js` 614 行**
```
1-22      import（CODES / trace_bus / mapDirOf）
24-43     18 个 flow/strat 的 manifest+run 双导入
64-196    ENTRIES[18]  ← 注册表本体（适配层：只搬参数）
198-202   remaining(ctx)  ← deadline 折算
207-261   validateManifest()（params 语法 / codes 必须在 CODES 里）
268-283   validateRegistry()（+ 名字唯一）
286-293   启动即校验（不合格 throw）；SKILL_NAMES
296-298   getSkill()
309-343   parseSkillArgs()（key=value → 按 manifest 校验，含默认值）
346-386   defaultOf / coerceParam（int/float/enum/pos/area）
400        re-export mapDirOf/botDirOf/botNameOf
407-614   makeCtx() + runSkill()（含 board/jobBudget/onEvent/checkpoint/reserve/release）
```

**`construction_tasks.js` 1104 行**
```
1-34        ConstructionTaskValidator.validate()（score = matches/total）
36-45       resetConstructionWorld()（/fill 清场）
47-71       checkLevelBlueprint() / checkBlueprint()（给 !checkBlueprint 命令用）
73-310      class Blueprint
  ├ 77-141    explain / _getPlacementString / explainLevel / explainLevelDifference
  ├ 142-158   check()（汇总所有 level）
  ├ 159-209   checkLevel()  ← **异常时 return false（:201）**
  └ 211-309   autoBuild() / autoDelete()（生成 /setblock 指令串）
330-928     proceduralGeneration()（随机房间生成器）
  ├ 344-385    3D 矩阵 + 外墙 stone + 包层
  ├ 400-435    getRandomDirection / isSpaceValid
  ├ 437-483    validateAndBuildBorder
  ├ 485-583    addDoor / addWindowsAsSquares / addWindowsAsPlane
  ├ 636-728    addStairs / addCarpet / addLadder
  ├ 731-757    embellishments()  ← 参数错位（见 E6）
  └ 762-922    主循环（最多 150 次尝试/房间）
937-962     printMatrix()（调试）
970-995     matrixToBlueprint()
997-1049    worldToBlueprint()
1051-1073   blueprintToTask()
1075-1104   注释掉的测试代码
```

---

## 1. 执行器失败语义全表

「失败但上层以为成功」= 执行器返回 `ok`，但世界状态没有变成调用方期望的样子。
「成功但上层以为失败」= 世界真的变了，返回值却是 fail。

### 1.1 失败 → 上层以为成功

| # | 位置 | 场景 | 后果 |
|---|---|---|---|
| F1 | **`executor.js:342-345` + `:363`** | `digdown` 时正下方是液体 → `onEvent('liquid-pass')` → `break` → **`return ok({dug})`**，`dug` 可能是 0 | 她**一格没下去**，上层拿到 ok。`dig` 分支在 `:240-245` 专门修过同一个坑（注释原文："旧代码在这里 break 后照样 return ok({dug})，上层以为她已经上去了"），**`digdown` 没跟上** |
| F2 | `executor.js:669-676` | 走完 x/z 但高度不够 → 循环 `stepUp`；`stepUp` 失败就 `break`，然后 **`return r`**（`r` 是 `moveToXZ` 的 ok） | 没到目标高度却报 ok。`stepUp` 最常见的失败是 `NO_ITEM 没有可垫脚的方块`（`:686`） |
| F3 | `executor.js:252`（dig）、`:352`（digdown） | `digBlock` 失败但 message 里含 "air" → 当作成功继续 | 真实挖掘失败被吞（正则 `/air/i` 太宽） |
| F4 | `nav_pathfinder.js:269-271` | `goto` 抛错但已推进 ≥3 格 → **`return ok({partial:true, note:'失败(...)但在推进'})`** | 故意设计（Baritone 式 partial path），且带 `partial` 标记。**但只判断 `r.ok` 的调用方一律当成功**——本仓 `step_runner` 与 `climbByTunneling:482` 就是只看 `r.ok` |
| F5 | `executor.js:560` | 可攀爬格 + 水平≤1.0 + 高度相同 → `ok({walked:0, alreadyThere:true})` | 判据窄（注释 `:543-551` 记录了收紧过程），可信度高，仅是"零位移报成功"的形态 |
| F6 | `flow_follow.js:153-157` | `setGoal(GoalFollow)` 之后**不校验是否真的在接近**，只要 `goalEntity` 没变就每 250ms 空转 | 跟丢后仍然"看起来在跟"，直到 `lastVisibleAt` 超时才转 RCON 分支 |

### 1.2 成功 → 上层以为失败

| # | 位置 | 场景 | 后果 |
|---|---|---|---|
| S1 | `executor.js:252` | 目标格已经是空气，`digBlock` 必然失败（"block is air"）→ 被 `/air/i` 吞掉算成功 | 这条是**修 F3 的正确方向**，不是 bug；列在这里是为了对称 |
| S2 | `executor.js:283-290` | 邻列脚位格仍是实心 → 报 `DIG_FAIL`，但**可能已经挖掉了 1~31 格** | 上层看到"失败"，实际世界已改变；`data.dug` 带了数量但没人用它记账 |
| S3 | `executor.js:654-664` | 高度差 ≤1 格容差内放过（`:654` `> targetFeetY + 1`），>1 才报 `HEIGHT_MISS` | 差 1 格被当成功——这是**故意**的容差，但会让 `digdown` 累积误差 |
| S4 | `nav_pathfinder.js:285-287` / `:432` | pathfinder 抛 `GoalChanged` → 映射成 `BLOCKED`（不是 INTERNAL） | 这是审计⑤ R4 现场那 2 次 `goal was changed` 在**这一层**的归类；`walkTo` 读到 `BLOCKED` 会 `recordFail` 后重规划，行为正确 |
| S5 | `tasks.js:365-397` `isDone()` | 只有 `validator.validate()` 返回 `valid:true` 才算完成；`ConstructionTaskValidator` 内部 catch 后**返回 `valid:false, score:0`**（`construction_tasks.js:26-32`） | 校验器自己崩掉 = 任务永远"没完成"，永远查不出原因 |

---

## 2. 材料 / 资源记账链路（从派单到扣料）

```
[1] 派单            board_server.js:250-275  socket 'board:finish' / addJob
                     ↓
[2] 领单            board_store.claimFor(:451-486)  原子 UPDATE state='claimed'
                     ↓  lease_owner=bot, lease_until=now+30s
[3] 调度器跑单       board_scheduler._runJob(:604)
                     ├ reserve(): 每个 key 一次 socket 往返（:584-598）
                     ├ setInterval 心跳 10s（:635-647）
                     └ runner(agent, skill, args, job)（:655）← 绕过 action_manager
                     ↓
[4] 契约/ctx        composite_registry.runSkill(:556) → makeCtx(:407)
                     ├ jobBudget: {limit, used, hitCap}（:480-487）
                     └ ctx.jobId → bot.__navJobId（:419）
                     ↓
[5] 流程层          flow_craft / flow_smelt / flow_store / strat_obtain...
                     ↓
[6] 动作层（真正改世界的地方）
                     ├ act_craft.craftOnce：produced = after - before（act_craft.js:375）
                     │   **没有"这张单已经产出过"的账**
                     ├ act_place / act_container.deposit：把物品放进箱子 = **离开背包**
                     └ act_dig：方块变 air
                     ↓
[7] 回报            _runJob finally(:672-696) → board.finish(id, {ok, code, progress})
                     ↓
[8] 记账            board_store.finish(:537-661)
                     ├ mergeProgress：count 取 max(old,new)（:255-266）—— 只增不减
                     ├ craft 单完成只看 okFlag（:566-567），不看 count
                     └ attempts 只在 counted=true 时 +1（:636）
```

### 会在哪里重复扣 / 漏扣

| # | 位置 | 机制 | 判定 |
|---|---|---|---|
| M1 | `board_store.js:668-684` `expireLeases` | 租约过期 → 单回 `ready`，**`attempts` 一字不动** → `maxAttempts=3` 永远达不到 | **重复扣**：进程每崩一次，`craft` 就再跑一次，`act_craft` 每跑一次都真扣一次材料（`produced` 是"本次"的量，无累计账）；`finish` 对 craft 只看 `okFlag`（`:566-567`），所以第 N 次成功了就记 done，前 N-1 次扣的料**没有任何记录** |
| M2 | `act_craft.js:375` | `produced = after - before` 是**差值**，没有幂等键（无 jobId→已产出 的映射） | 同 M1 的放大器：重试 = 再扣一份 |
| M3 | `board_store.js:424` `convergeIfSatisfied` | `if (String(job.skill)==='craft') return null;` —— craft **不做**"按库存收敛" | 这是 t120 **故意**关的（否则"背包里有 2 块板"就提前收敛、压根不合成）。代价：craft 单没有任何"库存已够"的快路，只能真跑 → 更依赖 M1 的 attempts 上限 |
| M4 | `tasks.js:371-373` `isDone()` | 任务成功 → `for (agent of available_agents) bot.chat('/clear '+agent)` | **整包清空**（评测用设计）。在 `restrict_to_inventory` 任务里这是"结算"，但一旦误判完成（见 S5）就是**材料全灭** |
| M5 | `composite_registry.js:109` | `runCraft(bot, args.item, args.count)` —— **不传 ctx / 不传 deadline**，而同文件里 `runStore`/`runSmelt`/`runFetch` 都传了 `{ctx}` | **漏扣/失控**：craft 拿不到 `ctx.deadline`，也没有 `ctx.jobId` → 既不能被 deadline 掐，也无法把"已产出"写进 checkpoint |
| M6 | `flow_store.js:70-90` `rememberChest` | `sharedGet` → 算 → `sharedPut`（两次 socket 往返） | 账目丢更新（审计② B11）：材料**还在箱子里**但账上说没有 → 上层重复去采 |

**M1 的完整链路（把审计② B12 补全）**：
`expireLeases 不计 attempts`（`:668-684`）→ 单回 ready → `claimFor` 再领（`:451`）→ `_runJob` 再跑（`board_scheduler:604`）→ `runSkill`（`composite_registry:556`，且 **craft 走 :109 不带 ctx**）→ `act_craft` 再扣一份材料（`act_craft.js:375`）→ `finish` 只看到最后一次的 `okFlag`。**全程没有任何一处记录"这个 jobId 已经产出过 N 个"**。

---

## 3. 中断链路全图（`!stop` 为什么不生效）

```
玩家聊天 "!stop"
  │
  ▼
commands/actions.js:140   await agent.actions.stop('player')
  │
  ▼
action_manager.js:77      async stop(reason)
action_manager.js:83-88   applyStop({ agent, reason, label: this.currentActionLabel,
                                      jobId: this.currentJobId })
  │
  ▼
control.js:232-243        applyStop()
control.js:235            resolveJob({ board, jobId, label })
control.js:210-224          ├ label 优先：jobSkillFromLabel(label) —— 只有以 "job:" 开头才认
  │                          └ 否则用 jobId → board.get(jobId)
  │
  ╔═══════════════════════════════════════════════════════════════════════╗
  ║ ✖ 断点 1  control.js:213-218 / 219                                     ║
  ║   任务板单跑在 `runner(...)` 里（board_scheduler.js:655），**没有走     ║
  ║   actions.runAction**，所以 ActionManager.currentActionLabel 是        ║
  ║   'mode:xxx'/'action:xxx' 之类，currentJobId 恒为 null                ║
  ║   → resolveJob 返回 null → planStop(job=null) 只回 "要不要暂停领单"    ║
  ║   → **单子状态一个字节都没改**（control.js:120-122）                   ║
  ╚═══════════════════════════════════════════════════════════════════════╝
  │
  ▼
control.js:241-243        if (plan.pauseAutoClaim) board.setAutoClaim(false)
  │
  ╔═══════════════════════════════════════════════════════════════════════╗
  ║ ✖ 断点 2  control.js:242 → board_client.js:264-268                     ║
  ║   设的是**客户端**的 `this._autoClaim`；而调度器判的是它自己的          ║
  ║   `this._autoClaim`（board_scheduler.js:441）。                        ║
  ║   桥接方法 `scheduler.setAutoClaim()`（:385）**全仓零调用方**。        ║
  ╚═══════════════════════════════════════════════════════════════════════╝
  │
  ▼
action_manager.js:91      if (!this.executing) return;     ← 到此为止
  │
  ╔═══════════════════════════════════════════════════════════════════════╗
  ║ ✖ 断点 3  action_manager.js:91                                        ║
  ║   任务板单不经过 runAction，`executing` 是 false → **直接 return**，    ║
  ║   下面那个 `while (this.executing)` 里才是 requestInterrupt() 的地方    ║
  ║   → **连"停手"都不会发生**，技能继续跑                                 ║
  ╚═══════════════════════════════════════════════════════════════════════╝
  │
  │ （若断点 3 不存在，理论上会走到这里：）
  ▼
action_manager.js:105     agent.requestInterrupt() → agent.js:501  bot.interrupt_code = true
  │
  ▼
【各层对 interrupt_code 的检查点】
  executor.js:822   walkTo 入口            ✔
  executor.js:825   walkTo 每轮            ✔
  executor.js:1013  walkTo 每步（失败时）  ✔（但只在 r.ok===false 分支用）
  executor.js:615   holdKey 潜水（200ms）  ✔
  executor.js:733-741 stepUp 重试         △ 只在 pillarUpOnce 回 INTERRUPTED 时退出
  executor.js:223    dig 循环             �� **自身不查**，靠 digBlock 内部
  executor.js:335    digdown 循环          ✘ **自身不查**，靠 digBlock 内部
  executor.js:564    moveToXZ 轮询         ✔（nav_pathfinder.js:399，每 100ms）
  nav_pathfinder.js:230  moveTo 轮询       ✔（每 100ms）
  flow_follow.js:136      follow 主循环     ✔
  flow_follow.js:485      followEntity     ✔
  flow_collect_plan:417   climbByTunneling ✔
  flow_shelter.js:198     入口             ✔（每格是否检查未逐行确认，manifest 注释称靠 flow_build）
  │
  ▼
技能返回 INTERRUPTED → _runJob finally（board_scheduler.js:672）
  │
  ▼
board.finish(INTERRUPTED) → board_store.finish
  │
  ▼
board_store.js:600-601    NO_COUNT_CODES.has('INTERRUPTED') → next = READY（不是 paused！）
  │
  ╔═══════════════════════════════════════════════════════════════════════╗
  ║ ✖ 断点 4  board_store.js:600-601                                      ║
  ║   玩家喊停 → 单子回 **ready** → 下一次 claimFor（3 秒一拍的 tick）     ║
  ║   **立刻又把它领回来继续做**。07 §4 要求的是 paused。                  ║
  ╚═══════════════════════════════════════════════════════════════════════╝
  │
  ▼
  ╔═══════════════════════════════════════════════════════════════════════╗
  ║ ✖ 断点 5  board_scheduler.js:540                                     ║
  ║   `_resumeOwnPaused` 用 `j.pausedReason !== 'player'` 过滤，          ║
  ║   而 `pausedReason` **全仓只有这一处读、没有任何一处写**              ║
  ║   （planStop 的 PLAYER 分支 control.js:150-160 只写 state/lease/result）║
  ║   → 就算单真的进了 paused，3 秒后也会被自动 resume。                  ║
  ╚═══════════════════════════════════════════════════════════════════════╝
```

**一句话**：`!stop` 在**第 3 跳就 return 了**（`action_manager.js:91`），根本到不了 `requestInterrupt()`；即使强行让 `interrupt_code=true`，单子也只回 `ready`（断点 4）并立刻被重领，而"玩家暂停"这个语义从未落库（断点 5）。审计② B2 报的是 3 处断链，实际是 **5 处**。

---

## 4. 建造任务（construction_tasks 1104 行）

**结论：它不是一个"状态机 + 预算"的任务层，而是一个"蓝图读写 + 随机生成器 + /setblock 指令生成器"的库。**

- **没有材料预算**：`blueprintToTask()`（`construction_tasks.js:1051-1073`）把 `materials` 按 `give_agent = (give_agent+1) % num_agents` 轮流塞进每个 bot 的 `initial_inventory`（`:1059-1062`）。**只算"总需求"，不校验"够不够"**，也不在执行中扣减。
- **没有状态机**：进度 = `validator.validate()` 现算 `score = matches/total`（`:19-20`）。
- **失败不回滚**：`autoDelete()`（`:266-309`）是唯一"清场"手段，但**没有任何地方在失败路径上调用它** —— 唯一调用点是 `tasks.js:576`（`teleportBots()` 里、任务**开始前**清场）。所以"建一半失败"之后，已放下的方块**留在世界里**，材料也不退。
- **`/clear` 是结算手段**：`tasks.js:371-373` 成功时清空所有 bot 背包。

**具体缺陷**：
- **E6**（见下）：`embellishments()` 把 `newZ` 当 x 传（`:738`、`:741`）。
- `validate()` 在 `total_blocks === 0` 时 `score = 0/0 = NaN`（`:19-20`）。
- `checkLevel` 异常分支 `return false`（`:201`）与调用方 `.mismatches` 不匹配（**E4**）。

---

## 5. terrain3d 数据正确性（S14 之外）

| # | 位置 | 问题 | 场景 → 结果 |
|---|---|---|---|
| T-a | `terrain3d.js:275-424`（`scanSphere`） | 全程一个 `BEGIN…COMMIT`，逐列 `DELETE` 后重写 | 已在审计② B20 记：同步驱动 + 单事务 → 扫描期间进程完全阻塞 |
| T-b | `terrain3d.js` `noteDugSurface`（审计① N10） | `DELETE FROM surf WHERE x=? AND z=? AND y >= ?` 把整列上方全删，再只插 `y-1` | 多层列（洞穴/桥/水下地面）被**压平成一层** → 规划看不到上面那层 |
| T-c | `terrain3d.js:305`（`delCol` 先删后读）+ `:397`（`loaded===0` 只 `continue`） | 列数据先被删，若该列区块没加载则**不重写** | 已由审计① N5 记录（本轮确认：这是"先删后读"结构必然的后果，不是偶发） |
| T-d | `terrain3d.js` `chunk_index` | `INSERT OR REPLACE` 记录"扫过的区块" | 只增不减（审计② 已记），但它同时是**裁剪的依据**——目前没有任何裁剪使用它 |
| T-e | `terrain3d.js:518-527` `recordFail` + `executor.js:857-861` | 振荡时同一格 `recordFail` **连记 3 次**（注释 `:850` 明说"记 3 次（加价 4 倍）足够"） | 声明过的决策，不算发现；但它与"`pruneFails` 零生产调用"（审计② B17）叠加 → 失效的记忆永远加价 |

---

## 6. 新发现清单

### Must fix

#### E1　`follow` 的 30 分钟超时从未生效：注册表传 `deadlineMs`，函数读 `timeoutMs`
`mindcraft/src/agent/library/composite_registry.js:78`（`deadlineMs: remaining(ctx)`）对照 `src/agent/library/flow_follow.js:87`（`timeoutMs = -1`）

**这是什么**：`follow` 是"跟着玩家走"。它自己的 manifest 声明了 `timeoutMs: 30*60*1000`（`flow_follow.js:40`），注册表也老老实实把剩余时间算好传进来。

**问题（场景 → 结果）**：注册表传的键名是 **`deadlineMs`**，而 `follow()` 解构的是 **`timeoutMs`**（`:87`）——`deadlineMs` 被**静默丢弃**。于是 `timeoutMs` 永远取默认值 **`-1`**，而 `:137` 的判断是 `if (timeoutMs > 0 && ...)` → **`-1` 永远不成立** → 跟随没有任何超时，只能靠 `!stop`/玩家离线/找不到人来结束。
`follow()` 全仓只有一个调用方（`grep runFollow` = composite_registry.js:76），所以这是**唯一入口的唯一参数**，100% 命中。
与 B2/E-中断链叠加后最糟：`!stop` 也不生效（断点 1-3）→ **`!do follow player=xxx` 是一个既不会超时、也停不下来的技能**。

**最小修复**：`flow_follow.js:87` 的 `timeoutMs = -1` 改成 `timeoutMs = -1, deadlineMs = null`，然后 `const limit = Number.isFinite(deadlineMs) ? deadlineMs : timeoutMs;` 并在 `:137` 用 `limit`。或反过来把注册表 `:78` 的键改成 `timeoutMs`（一行）。

**不修会怎样**：跟随便能无限跑；结合 B2 的 5 处断链，它连"停"都停不下来，只能杀进程。

---

#### E2　`digdown` 遇液体时"报成功但一格没下去"——`dig` 分支修过的坑没同步过来
`mindcraft/src/agent/library/executor.js:342-345`（liquid → break）＋ `:363`（`return ok({ dug })`）

**这是什么**：`digdown` 的语义是"挖下去"。循环里若发现正下方是液体，它按"液体该穿过、不该挖"处理（这是对的），然后 `break`。

**问题（场景 → 结果）**：`break` 之后直接 **`return ok({ dug })`**，`dug` 此刻是 0。她**一格都没下降**，但调用方拿到 `ok`。
同一文件 `:240-245` 对 **`dig`** 分支写过完全对口的注释：「旧代码在这里 `break` 后照样 `return ok({dug})`，上层以为她已经上去了，实际停在原地（"液体头顶假成功"）」——并加了 `liquidBlocked` 标记 + `:312-314` 的显式失败。**`digdown` 分支没有这个守卫**，是同一 bug 的未修副本。
触发场景：站在 1 格厚的水面下沿要往下走（`step.action='digdown'`，正下方 water）→ 报 ok → `walkTo` 用 `moved` 判断，位移≈0 → 但在 `step_runner`/`climbByTunneling:482` 这类**只看 `r.ok`** 的消费方那里就是彻底的成功。

**最小修复**：`:344` 的 `break` 前设 `liquidBlocked = true`，`:363` 改成
`if (liquidBlocked) return { ok:false, code:'BLOCKED', message:'正下方是液体，挖不下去' };`（照抄 `dig` 分支 `:312-314` 的写法）。

**不修会怎样**：`digdown` 是"下矿井/下台阶"的主路径；每一次"液体挡路"都会被记成成功，上层不重规划，表现为原地不动而日志全是 ok。

---

### Should fix

#### E3　`.mismatches` 在一个可能返回 `false` 的函数上被直接解引用 → `!checkBlueprint` 会抛 `TypeError`
`mindcraft/src/agent/tasks/construction_tasks.js:201`（`return false`）对照 `:122`（`results.mismatches`）与 `:150-152`（`result.mismatches.push(...)`）

**这是什么**：`Blueprint.checkLevel()` 正常返回 `{mismatches, matches}`，但 `catch` 分支 `return false`。

**问题（场景 → 结果）**：`bot.blockAt()` 在区块未加载时会抛（`:176` 已被 try 包住 → 走到 `:201`）。此后：
- `check()`（`:150-152`）做 `mismatches.push(...result.mismatches)` → `false.mismatches` → **TypeError**；
- `explainLevelDifference()`（`:122`）同样；
- 入口 `!checkBlueprint`（`commands/queries.js:252`）直接调 `checkBlueprint()`，**没有 try**（`construction_tasks.js:59-71`）→ 异常冒到命令层。
触发场景：蓝图有一部分在未加载区块里（建造任务传送后极常见）→ 用户敲 `!checkBlueprint` → 报错而不是"这些格没读到"。

**最小修复**：`:201` 改成 `continue;`（跳过这一格），或在 `check()`/`explainLevelDifference()` 里 `if (!result || !result.mismatches) continue;`。

**不修会怎样**：唯一的建造进度查询命令在最有用的时刻（区块没加载）崩掉。

#### E4　`embellishments()` 把 `newZ` 当 x 传进去 → 窗户/楼梯放错坐标
`mindcraft/src/agent/tasks/construction_tasks.js:738`、`:741`

**这是什么**：`embellishments(carpet, windowStyle, matrix, newX, newY, newZ, newLength, newWidth, newDepth, material)`，内部调 `addWindowsAsSquares(matrix, newZ, newY, newZ, ...)`（`:738`）与 `addWindowsAsPlane(matrix, newZ, newY, newZ, ...)`（`:741`）——**第一个参数位置传的是 `newZ`**，而函数签名第一位是 `x`。

**问题**：`proceduralGeneration()` 生成的房间，窗户会被写到 `x = newZ` 那一列（通常越界被 `isInBounds` 挡掉 → **这个房间永远没有窗**，因为 `Math.random()<0.8` 被消耗了却没生效）。属于"生成了但静默丢失"，不影响验证（`checkLevel` 只比对期望/实际，期望里本来就没窗户）。

**最小修复**：`:738`、`:741` 的第一个 `newZ` 改成 `newX`。

**不修会怎样**：所有程序化生成的房子都没有窗（外观问题），且无从从日志看出。

#### E5　任务 JSON 的 `goal` / `conversation` 被拼进**主人级**命令字符串
`mindcraft/src/agent/tasks/tasks.js:407`（`!goal("${agentGoal}")`）与 `:509`（`!startConversation("${other_name}", "${this.data.conversation}")`）

**这是什么**：`Task.setAgentGoal()` 与 `initBotTask()` 用 `executeCommand(..., { internal: true })` 执行命令串。`internal: true` 在权限层意味着**按主人级处理**（`:405-406` 注释自述："否则 !goal 是主人级命令、这里没有 author 会被自己的权限闸门拦掉"）。

**问题（场景 → 结果）**：`agentGoal` 来自 `this.data.goal`，`conversation` 来自 `this.data.conversation`，两者都是**任务 JSON 的字段**。若某份任务文件里 `goal` 含 `") !newAction(...) //`，拼出来的字符串在 `!goal("...")` 解析后会**多出一条主人级命令**。
触发场景：`!task` 加载外部 JSON（`tasks/` 目录下就是给人写的），或任何能写 `bots/<name>/task*.json` 的东西。与审计③ I1/I3（socket 零认证）叠加时，这就成了一条"数据文件 → owner 级命令执行"的链。

**最小修复**：两处都改成"不用命令串、直接调函数"（`!goal` / `!startConversation` 背后都是普通方法）；若必须走命令串，至少对 `agentGoal`/`conversation` 做 `replace(/"/g,'\\"')` 转义。

**不修会怎样**：任务文件从"数据"升级成"可执行输入"，而执行权限是主人级。

#### E6　`runCraft` 不传 `ctx`：craft 既没有 deadline，也拿不到 jobId
`mindcraft/src/agent/library/composite_registry.js:109`（`run: (bot,args,ctx) => runCraft(bot, args.item, args.count)`）

**这是什么**：注册表里 18 条中，`runStore`/`runFetch`/`runSmelt`/`runEat`/`runMine`/`runFarm`/`runFight`/`runBuild`/`runShelter` **全部**传了 `{ctx}`（`:113-153`），只有 `runCraft` 一个参数都没传。

**问题（场景 → 结果）**：
- 拿不到 `ctx.deadline` → craft 没有外部超时约束（`flow_craft` 若自带 `timeoutMs` 则侥幸，但 `remaining(ctx)` 那套折算对它完全失效，违反 `composite_registry.js:50-51` 自己写的"timeout 一律按 ctx.deadline 折算"）；
- 拿不到 `ctx.jobId` → 无法把"本次已产出 N 个"写进 checkpoint → 直接放大 M1/M2 的重复扣料。

**最小修复**：`:109` 改成 `runCraft(bot, args.item, args.count, { ctx })`（与 `:113` 的 `runSmelt` 完全同形），并在 `flow_craft` 里按 `ctx.deadline` 折算超时。

**不修会怎样**：合成是唯一"消耗材料"的动作，却唯一没有超时与 jobId 上下文；卡住时无人能掐断。

#### E7　`expireLeases` 不计 attempts 的完整后果链（补全审计② B12）
`board_store.js:668-684` + `act_craft.js:375` + `board_store.js:566-567`

（链路图见 §2 的 M1。此处只记"为什么这条比审计②描述的更严重"）
**加强点**：审计②只说"会无限重试"。实际后果比那更具体——因为 craft 单**完全不做库存收敛**（`:424`），它只能真的执行 `craftOnce`，而 `craftOnce` 的 `produced` 是**每次调用的差值**（`act_craft.js:375`），且 `finish` 对 craft **只看 `okFlag`**（`:566-567`）。三者叠加 = **一次崩溃重试就多扣一份真实材料，且这笔消耗在库里不留任何痕迹**（`progress.count` 对 craft 是"背包总量"，会被 `mergeProgress` 取 max，看不出扣了几次）。

**最小修复**：同审计② B12（`expireLeases` 里 `attempts+1`，达上限转 `failed`）+ `act_craft` 把 `produced` 累进 `checkpoint.producedTotal`。

**不修会怎样**：一个"跑到一半就崩"的合成单会持续吃料，直到把背包吃空；账面上只看到"背包数量没涨"。

### Nice to have

#### E8　`ConstructionTaskValidator.validate()` 在空蓝图时 `score = NaN`
`construction_tasks.js:19-20`：`total_blocks = mismatches.length + matches.length`；全 air 蓝图 → 0 → `0/0 = NaN`。

**最小修复**：`score = total_blocks ? (matches/total) * 100 : 100;`
**不修会怎样**：`!checkBlueprint` 打印 "Task score: NaN%"，且 `isDone()` 返回的 `score` 也是 NaN。

#### E9　`execStep` 的两个挖循环自身不查 `interrupt_code`
`executor.js:223`（dig：`while (y < targetY && dug < 32)`）、`:335`（digdown：`while (y > targetY && dug < 32)`）

**这是什么**：这两个循环最多各跑 32 次 `digBlock`。它们**自己不检查** `bot.interrupt_code`（对比 `walkTo:825` 与 `moveToXZ:399` 都是每轮查）。
**问题**：能否停下完全取决于 `act_dig.digBlock` 内部是否响应中断——本轮**没有打开 `act_dig.js` 确认**（见 §0 未读清单）。若它也只在开头查一次，那么"往上挖穿 30 格"的整段是不可中断的。
**最小修复**：两个 `while` 体首行各加 `if (bot.interrupt_code) return fail('INTERRUPTED','挖到一半被叫停');`（与 `walkTo` 同形，两行）。
**不修会怎样**：取决于 `act_dig` 的实现——**这一点必须在修之前先读 `act_dig.js`**，否则可能只是重复已有的保护。

---

## 7. 对审计② B1~B20 的复核意见

| 编号 | 意见 | 本轮新增依据 / 说明 |
|---|---|---|
| B1 `finish()` 不校验租约 | **加强** | 本轮读到 `_runJob` 的 finally（`board_scheduler.js:672`）**无条件**调 `finish`，唯一的豁免是 `wasPreempted`（`:665-669`）。也就是说"租约丢了还在跑"的那条路**必然**走到无守卫的 UPDATE——B1 描述的交错序列不是边角，是默认路径 |
| B2 `!stop` 无效 | **加强（3 处 → 5 处）** | 新增两处：断点 4 `board_store.js:600-601`（INTERRUPTED → ready，不是 paused，3 秒后被重领）、断点 5 `board_scheduler.js:540`（`pausedReason` 无写入方）。完整图见 §3 |
| B3 依赖死锁 | **维持** | 本轮未涉及 board_store 依赖逻辑，无新增 |
| B4 幽灵父单 | **维持** | 同上 |
| B5 板库误删 | **维持** | t8 已修正触发点（`db.exec(SCHEMA)` 是唯一 BUSY 抛点） |
| B6 `LIMIT 200` | **维持** | 同上 |
| B7 `claimFor` LIMIT 16 | **维持** | 同上 |
| B8 `reopen*` 两份实现 | **维持** | 同上 |
| B9 迁移两份实现 | **维持** | 同上 |
| B10 共享数据两套真相 | **维持** | 本轮在 `flow_collect_plan.js:113`（`protectedPlaces(bot)`）看到这条链的**消费端**：它读的是 JSON 那份，所以 B10 的"板库那份没人读"又多一个证据 |
| B11 箱子丢更新 | **维持** | 本轮在 §2 M6 把它并入材料记账链 |
| B12 租约不记 attempts | **加强** | 见 E7：craft 不做库存收敛（`:424`）+ `craftOnce.produced` 是差值 + `finish` 只看 okFlag → **重复扣料且不留痕** |
| B13 deathPickup deadline 丢失 | **维持** | 本轮未涉及 |
| B14 schema 无版本 | **维持** | 同上 |
| B15 两份 `JOB_STATE` | **维持** | 同上 |
| B16 `_claimNext` 死资格闸 | **维持** | 同上 |
| B17 `pruneFails` 无调用 | **维持** | 本轮在 §5 T-e 记了它与"振荡时 recordFail×3"的叠加效应 |
| B18 `finish` 后假释放 | **维持** | 本轮确认 `_runJob` finally 里 `ctx.release(key)`（`board_scheduler.js:699-701`）是唯一真正生效的那条 |
| B19 `repeat_ms`/`notBefore` 死字段 | **维持** | 同上 |
| B20 `scanSphere` 单事务 | **维持** | 本轮 §5 T-a |

**推翻：0 条。降级：0 条。**

---

## 8. 优先修复顺序（本文件内的）

1. **E1**（一行改键名）—— 唯一能让"停不下来"变成"至少会超时"的改动，且成本极低。
2. **E2**（3 行，照抄同文件 `dig` 分支的守卫）—— 消除一类"报 ok 但原地不动"。
3. **B2 的断点 4+5**（`INTERRUPTED → paused` + 把 `pausedReason` 落库）—— 与 `!stop` 的另外 3 处断链合并修。
4. **E6**（一行，加 `{ ctx }`）—— craft 才有 deadline 与 jobId。
5. **E3 / E4**（各 1-3 行）—— 建造任务的崩溃与错位。

---

## Lean: 结算

| 项 | 量 | 依据 |
|---|---|---|
| 可删代码（本文件内新发现） | **≈0 行** | 本轮没有发现"整块死代码"；`construction_tasks.autoBuild()` 看似无人调用，但 `grep` 显示 `tasks.js:576` 用了 `autoDelete()`，而 `autoBuild` 只在 `tasks/construction_tasks/*.js` 工具里用 → **不算死码**，不提议删 |
| 可删代码（跨轮确认，仍然成立） | **≈96 行** | 审计② 的账（`migrateLocalToBoard` 52 + `reopenBlockedWithSatisfiedDeps` 20 + 死资格闸 10 + 双 `JOB_STATE` 7 + 其它 7），本轮无变化 |
| 可删文件 | **0** | `tasks/construction_tasks/` 三个脚本是**离线生成器**（`generate_multiagent_construction_tasks.js` 等），不属死码 |
| 本轮的净收益 | **不是"删多少行"，是"少两处必错"** | E1（跟随永不超时）+ E2（digdown 假成功）都是 1-3 行改动、可当场验证 |

**本轮的诚实边界**：`flow_shelter.js` 550 行只读了结构未逐行；`terrain3d.js` 430-510 仍未读；`act_dig.js`/`act_step.js`/`act_pillar.js` 内部未打开（E9 因此标为"需先确认"）；`tasks.js` 1-190 未通读。**凡标"维持"的条目，我在本轮没有重新取证，只是没有发现反证** —— 那不是"复核通过"，是本轮无新增输入。
