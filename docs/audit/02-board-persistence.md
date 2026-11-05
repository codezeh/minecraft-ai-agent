# 审计②：任务板、持久化与并发（board_* / executor / 存储层）

审查对象：`E:\我的世界ai\mindcraft`（mindcraft fork）。只读审查，未改任何被审查源码。
证据里的行号都是本次实际读到的那一行；带 `id` 的现场数据来自 `mindcraft/bots/_board/board.sqlite` 的副本（只读，未动原库）。

---

## 0. 负载假设（所有结论都建立在这上面）

- 单人 / 少数几台机器：1 个 Paper 服务端 + **1~3 个 bot 实例** + 1 个 Web 面板。
- bot 按秒级节奏连续下指令（调度器 3 秒一拍：`agent.js:57`）。
- 多个 bot 共享同一份任务板 SQLite（`bots/_board/board.sqlite`）。
- 允许用户/回归脚本在 mindserver 运行时也去打开这个库（`docs/回归-runbook.md:35` 就是一条直接 `new DatabaseSync('bots/_board/board.sqlite')` 的清库脚本）。

---

## 1. 层说明：谁写什么、锁在哪

| 层 | 文件 | 谁在跑 | 写什么 |
|---|---|---|---|
| 板库（唯一写者） | `board_store.js` | mindserver 进程 | `jobs` / `claims` / `shared` 三张表，`bots/_board/board.sqlite` |
| socket 层 | `board_server.js` | mindserver 进程 | 不写库，只校验→调 store→回 ack；另有 5 秒一次的扫描定时器 |
| 客户端 | `board_client.js` | 每个 bot 子进程 | 不写库；维护一份**内存镜像**，经 socket 请求 |
| 调度器 | `board_scheduler.js` | 每个 bot 子进程 | 领单/续租/回报，全部走 socket |
| 3D 地形库 | `terrain3d.js` | 每个 bot 子进程 | **每个 bot 一份** `terrain3d.db`，明确不共享（`board_store.js:1262-1266` 有原文） |
| 记忆 | `memory_store.js` | 每个 bot 子进程 | `bots/<name>/memory/*.json`，临时文件 + rename 原子写 |

关键前提（决定了哪些竞态真的存在）：`node:sqlite` 的 `DatabaseSync` 是**同步 API**，而 mindserver 是**唯一写者**。
所以**同一个 store 函数内部**（例如 `reserve()` 里"先 SELECT 再 INSERT"）在同一进程里不会交错 —— 那不是竞态。
真正会交错的只有两类：
1. **跨两次 socket 往返**的读-改-写（客户端发起，两个 bot 的请求在 mindserver 里交替执行）；
2. **多进程**同时打开同一个 sqlite 文件（mindserver + 回归脚本 / 手工清库）。

下面 6 条 Must fix 里，B1/B2/B3/B4/B5 属于"真的会错"，B6 属于"到 200 张单就静默失效"。

---

## 2. 十个必答问题的短答案

| # | 问题 | 结论 |
|---|---|---|
| 1 | WAL / busy 重试 / 长事务 | WAL 开了（`board_store.js:157`），`busy_timeout=5000`（`:158`）；**没有重试循环**，超时就直接抛。板库**没有显式事务**（全仓 `BEGIN` 只在 `terrain3d.js`），每条写都是自动提交，持锁是单条语句级。→ B5、B18 |
| 2 | check-then-write 竞态 | store 内部安全（单写者+同步）；**跨往返的读-改-写不安全**：`rememberChest` 丢更新（B11）；`finish()` 完全不校验租约归属（B1） |
| 3 | 事务边界 | 没有事务。`splitByCount` 先建父单再循环建子单，中间崩 = 父单永久 running 无子单（B4）；`reserve` 批量插入无事务（单进程下无交错，但崩了会半占） |
| 4 | LIMIT N 收敛扫描 | `convergeOrphanParents` 已修（`board_store.js:1094-1101` 带状态过滤）；**同类还剩两处**：`listJobs` 默认 `LIMIT 200`（B6）、`claimFor` 的候选窗口 `LIMIT 16`（B7） |
| 5 | 只增不减 | `jobs` 从不删除（`board_store.js:1082` 自述）；`terrain3d.fail` 的 `pruneFails` **零生产调用方**（B17）；`chunk_index` 随走过的区块长；`trace_bus` 有 400 条上限（这项是好的） |
| 6 | 崩溃恢复 | 租约过期回收可用，但**不记 attempts**（B12）；父单 0 子单永久 running（B4）；依赖已死的子单永久 ready（B3） |
| 7 | 幂等 | 计数靠 `mergeProgress` 单调（`board_store.js:255-266`，好）；但**动作不幂等**：`craft` 重跑会再扣一次材料（B12） |
| 8 | 两套实现同一规则 | 3 处：blocked 重开（B8）、共享数据迁移（B9）、`JOB_STATE` 枚举（B15）；另 `_claimNext` 的 requires 二次校验是死代码（B16） |
| 9 | schema 迁移 | **没有版本号、没有 ALTER TABLE**（全仓 grep `user_version`/`ALTER TABLE` = 0 命中）→ B14 |
| 10 | board_store 1412 行 | 混了 9 类职责，其中 154 行属于**另一个域**（共享世界数据）→ 见 §6 |

---

### 2.1 补充说明（短答案里放不下的细节）

- **Q1 长事务持锁多久**：板库没有显式事务，最长持锁 = 单条语句（微秒级）；`reserve()` 的 N 条 INSERT 是 N 个自动提交。真正的长写事务只存在于 `terrain3d.scanSphere`（一次扫描一个事务，见 B20），而它是**每 bot 私有库**，不与别人抢。
- **Q2 只有两类真竞态**：跨两次 socket 往返的读-改-写（B11）、以及"租约语义没写进写路径"（B1）。store 内部的 `SELECT … UPDATE`（如 `convergeIfSatisfied`、`reserve`、`claimFor`）因为单写者 + 同步驱动**不会交错**，而且 `claimFor` 的成败判据是 `changes===1`，这条是对的（`:479-482`）。
- **Q3 中间态谁能修**：`splitByCount` 半途崩 → 没人修（B4）；`finish` 里 `kidsAlive` 与 `rollupParent` 是两次独立 commit，中间崩 → 下一轮 scanTimer 会补（这条是好的，`board_server.js:401-405`）。
- **Q5 谁清理**：`claims` 有人清（`expireClaims`，scanTimer 每 5 秒）；`jobs` 没人清（无上限）；`terrain3d.fail` 没人清（B17）；`trace_bus` 400 条环（上限正确）；`shared` 的箱子按坐标 upsert，**箱子被拆后记录永留**（无害但会污染 `sharedFindItem` 的排序）。
- **Q8 另外还有**：`board_server.js:426` 已经 re-export 了 store 的 `JOB_STATE`（正确做法），而 `control.js:68-74` 还在自己定义一份（B15）。

---

## 3. 发现清单

### Must fix

#### B1　`finish()` 不校验租约归属，旧持有者能把别人手上的单写回 ready
`mindcraft/src/agent/library/board_store.js:637-659`（`UPDATE jobs SET ... WHERE id=?`，只有 id）

**这是什么**：`finish()` 是"这张单跑完了，决定去 done / ready / blocked / failed"的唯一落库点。它读 `getJob` 后直接 `UPDATE ... WHERE id=?`，**既不看 `lease_owner`，也不看当前 state**。对比同一个文件里的 `heartbeat()`（`:503-504` 显式校验 owner 与到期），同一份代码里两套标准。

**问题（具体交错）**：
- t=0　A 领到单 X（租约 30 秒），开始挖。
- t=10…40　A 的三次心跳都没送达（agent 进程在长同步动作里，或 mindserver 刚重启）。
- t=30　mindserver 的 `expireLeases`（`:668-684`）把 X 打回 `ready`、`lease_owner=NULL`。
- t=31　B 领到 X（`:479-482` 原子 UPDATE 成功），`assignee=B`、`lease_owner=B`，开始做同一件事。
- t=35　A 的 skill 返回（INTERRUPTED 或正常 ok），`_runJob` 的 finally 调 `finish(X, …)`
  → 这一条 UPDATE 无守卫 → X 变 `ready`（INTERRUPTED 属 `NO_COUNT_CODES`）、`lease_owner=NULL`。
- 结果：B 正在跑的单被 A 写没了租约；B 下一次心跳拿到 `LEASE_LOST` 白干一场；C（或 A）可以在 B 还在动世界时再领一次 X。

**最小修复**：`finish(db, id, result, { now, bot })`，UPDATE 改成
`WHERE id=? AND (lease_owner IS NULL OR lease_owner=?)`，`changes===0` 就返回 `{ok:false, code:'LEASE_STALE'}` 且**一个字段都不写**；`board_server.js:252` 调用处把 `payload.bot` 传进去（客户端 `board_client.js:357` 目前根本没发 `bot`，一并补上）。

**不修会怎样**：两个 bot 同时执行同一张单（互相打断、都报失败）；`progress.count` 虚涨（这正是 `convergeIfSatisfied` 当初要治的病，但它只治"已达标被重派"，治不了"同跑"）；挖矿/合成的世界副作用重复。

---

#### B2　玩家 `!stop` 对任务板任务完全无效（三处断链）
`mindcraft/src/agent/library/board_scheduler.js:655`（`runner(…)` 直接调用，绕过 action_manager）、`action_manager.js:77-91`（`stop()` 只在 `executing` 时中断）、`control.js:242`（`board.setAutoClaim(false)` 设的是客户端字段）、`board_scheduler.js:441`（读的是**自己的** `this._autoClaim`）

**这是什么**：`!stop`（`commands/actions.js:140`）→ `actions.stop('player')` → `control.applyStop` → 按 07 §4"单子去 paused + 暂停自动领单"。

**问题（三处同时断，链条整体失效）**：
1. 调度器跑单用的是 `runner(this.agent, job.skill, …)`（`:655`），**没走 `actions.runAction('job:'+skill)`**。于是 `ActionManager.currentActionLabel / currentJobId` 都不是这张单 → `applyStop` 里 `resolveJob({label, jobId})`（`control.js:210-224`）返回 null → `planStop(job=null)` 只回一句"要不要暂停领单"，**单子状态一个字节都没改**。
   本该补上这一环的 `control.runJobAction`（`control.js:339-351`，唯一设置 `label=job:<skill>` 和 `actions.currentJobId` 的地方）**全仓零调用方**（grep `runJobAction` 只有定义与注释）—— 也就是说调度器绕过的正是为它准备的那个入口。
2. `actions.stop()` 里 `if (!this.executing) return;`（`action_manager.js:91`）——调度器跑单时 `executing` 是 false → **不会 `requestInterrupt()`**，技能继续跑，`!stop` 连"停手"都做不到。
3. 就算走到 `pauseAutoClaim`，`control.js:242` 调的是 `board.setAutoClaim(false)`，落到 `board_client.js:264-268` 的**客户端字段**；而调度器判的是自己的 `this._autoClaim`（`:441`）。`scheduler.setAutoClaim()`（`:385`）**全仓零调用方**（grep 确认）。
   附带：`_resumeOwnPaused` 过滤条件用 `j.pausedReason !== 'player'`（`:540`），而 `pausedReason` **全仓只有这一处读、没有任何一处写**（`planStop` 的 PLAYER 分支 `control.js:150-160` 只写 state/lease/result）→ 就算单真被暂停，3 秒后也会被自动 resume。

**最小修复**：
- `_runJob` 改为 `await runJobAction(this.agent, job, () => runner(...))`（`control.js:339` 已经写好了：它负责设 `currentJobId` + 按 deadline 换算超时 —— 一步同时修好"`!stop` 找不到单"和"board 单没有超时换算"）；
- `applyStop` 改成"有 `agent.scheduler` 就调 `agent.scheduler.setAutoClaim(false)`，删掉 `board.setAutoClaim` 这条支路"；
- `planStop` 的 PLAYER 分支 patch 里加 `checkpoint: {...(job.checkpoint??{}), pausedReason:'player'}`（复用已有列，不新增 schema）。

**不修会怎样**：玩家按 `!stop`，机器人**照旧把这单做完**（这是单人场景下最直接的可用性事故）；`!stop` 之后也无法阻止它领下一张单。

---

#### B3　依赖已死的单永久卡在 `ready`，父单永久 `running`（现场已卡 166 分钟）
`mindcraft/src/agent/library/board_store.js:934-943`（`dependsSatisfied` 只认 `done`）、`:1113-1115`（有非终态子单就直接 `continue`）、`:1009-1015`（重开只处理 `blocked`）

**这是什么**：`dependsOn` 是"前置单必须 done 我才能领"。`claimFor` 用 `dependsSatisfied` 过滤候选，`convergeOrphanParents` 负责"子单全终态就把父单收敛"。两处都假设"非 done 的依赖迟早会 done"。

**问题（现场证据，当前库里的活数据）**：
```
j_20261105_0002_ngl  obtain   running   kids: 3 done / 1 blocked / 1 ready   卡了 166 分钟
├─ j_20261105_0003_ngl  mine   blocked  NO_TOOL「挖不动 stone（没有合适的镐）」  deps=null
└─ j_20261105_0007_ngl  craft  ready    stone_pickaxe  dependsOn=[0003, 0006]  updatedAt==createdAt（从未被碰过）
```
`0003` 是终态 `blocked`（`NO_ITEM/NO_TOOL/NO_RECIPE` 直接 blocked，`:598-599` 的设计），永远不会再 done；`0007` 因此 `dependsSatisfied=false`，**永远不可领**；而 `convergeOrphanParents` 看到"还有一个非终态子单（0007 ready）"就 `continue`（`:1115`），`reopenOrphanBlocked` 只扫 `blocked`（`:1005`），`rollupParent` 只在子单 finish 时被调（`board_server.js:267`），那之后再没有 finish 事件 → 父单永久 `running`。

**最小修复**：给 `dependsSatisfied` 加一条"依赖已死"的判定（新增一个小函数 `depDead(db, job)`：任一依赖处于 `failed/blocked/cancelled` 即真），在 `reopenOrphanBlocked`（`:1016` 之前）和 `convergeOrphanParents`（`:1115` 之前）里对命中的单 `setState(job, BLOCKED)` 并写 `result.code='DEP_DEAD'`。之后"子单全终态"成立，`rollupParent` 自然把父单收敛成 `blocked`。

**不修会怎样**：第一夜的 `obtain stone_pickaxe` 这类单必然永久挂着（挖石头要镐、镐要石头，是策略层的环）；面板上看起来"还在跑"，实际没有任何进程在跑它，且不报错。

---

#### B4　父单建好、子单没建完时进程死掉 → 父单永久 `running`，没人能收敛
`mindcraft/src/agent/library/board_store.js:1175-1207`（`splitByCount`：先 `addJob(父单)`，再循环 `addJob(子单)`，全程无事务）、`:1113-1114`（`if (!kids.length) continue;`）

**这是什么**：拆单是"1 次父单插入 + N 次子单插入"，每次都是独立自动提交。

**问题**：进程在第 2 次 `addJob` 之前死掉（OOM / `!restart` / 断网被父进程回收）→ 库里有 `running` 父单、0 子单。
`convergeOrphanParents` 明确跳过无子单的父单（`:1114`），`rollupParent` 返回 `no-children`（`:1131`），`claimFor` 只领 `ready`（`:460`）→ 这张单**没有任何路径会被再处理**，也不报错。

**最小修复**：在 scanTimer（`board_server.js:402`）里加一条：`SELECT id FROM jobs p WHERE p.state IN ('running','ready') AND NOT EXISTS(SELECT 1 FROM jobs c WHERE c.parentId=p.id) AND p.createdAt < now-120000` → `setState(BLOCKED)` + `result.code='ORPHAN_PARENT'`。

**不修会怎样**：每出现一次"拆单中途崩溃"就永久多一张幽灵父单；面板显示"还在跑"，`jobsBusy()` 也把它算成忙，`self_prompter` 会一直不催，看起来像"卡死的机器人"。

---

#### B5　"库损坏自动重建"把"临时打不开"也当损坏 → 启动时整份板库被删
`mindcraft/src/agent/library/board_store.js:163-201`

**这是什么**：`openBoard` 的兜底：`tryOpen()` 抛**任何**异常 → 关句柄 → `renameSync`（失败就 `rmSync`）`board.sqlite` → 建空库。

**问题**：`tryOpen` 里的三步（`new DatabaseSync` / `PRAGMA journal_mode=WAL` / `db.exec(SCHEMA)`）都可能因**别人的写锁**抛 `SQLITE_BUSY`——`busy_timeout=5000` 到期就抛（`:158`）。实际触发场景：回归脚本 `docs/回归-runbook.md:35` 正握着写事务清库，或面板工具在写，此时用户重启 mindserver → 5 秒超时 → 代码判定"库坏了" → **把一份完好的库改名/删掉** → 库里所有 `ready/claimed/running` 单当场蒸发（坏文件即使被留档，新库也是空的）。
`SQLITE_CANTOPEN`（目录权限/杀软占用/磁盘满）走同一条路。

**最小修复**：只在错误确实是"文件不是数据库"时重建 —— 判断 `e.errcode === 11`（`SQLITE_CORRUPT`）或 `e.errcode === 26`（`SQLITE_NOTADB`）或 message 含 `file is not a database` / `malformed`；其它错误原样 `throw`（mindserver 的 `try/catch` 在 `mindserver.js:75-98`，本来就会把"板起不来"降级成"没有板"，不会阻止启动）。

**不修会怎样**：一次锁冲突 = 一整个任务列表被清空；而且它会以"板库损坏已重建"的日志出现，看起来像磁盘问题，实际是代码把自己锁在门外。

---

#### B6　镜像/列表的 `LIMIT 200` 截断：累计 200 张单之后，新单进不了调度器的视野
`mindcraft/src/agent/library/board_store.js:378-382`（`ORDER BY priority DESC, createdAt ASC LIMIT ?`，默认 200）、`board_scheduler.js:426`、`:456`（`refresh({scope:'claimable'})` **不传 states**）

**这是什么**：`jobs` 表只增不减（`:1082` 自述，全仓无 `DELETE FROM jobs`）。客户端"镜像"（`board_client._byId`）靠 `refresh()` 拉一次覆盖，默认走 `listJobs` 的 200 条上限。
排序是 `priority DESC, createdAt ASC` —— **同优先级下取最老的 200 条**。

**问题**：现库 22 张；每跑一次 `!do first_night` 约新增 7 张（父单+6 子单）。累计到 ~200 张后：
- 新加的共享单（`assignee=null`、`priority=5`、`createdAt` 最新）**排在窗口外**，`refresh({scope:'claimable'})` 永远拿不到它们；
- 于是 `_findPreemptor`（`:719-729`）在镜像里看不到新来的 9 级单 → **抢占彻底失效**（正是 t140/t142 那类"事件漏一次就再没人重试"，这次是"窗口漏一次就永远看不到"）；
- `requeueStaleBrief`、`jobsBusy`、`_resumeOwnPaused` 全部在同一份被截断的镜像上做判断；
- 面板 `board:list`（`board_server.js:177-182`）同样只显示 200 条且没有总数，看起来"都在这儿"。

**最小修复**：给 `listJobs` 加一个 `openOnly` 参数，SQL 里加 `AND state NOT IN ('done','failed','cancelled')`；`refresh({scope:'claimable'})` 一律带上它（和 t142 修 `convergeOrphanParents` 的做法完全一致：**把过滤放进 SQL，让结果集天然小**）。终端态仍然只能通过显式 `scope:'all'` + 分页看。

**不修会怎样**：一个跑过几十轮的存档会静默退化成"没有抢占、残局没人收"，且**不报错**；只有把库清空才恢复。

---

### Should fix

#### B7　`claimFor` 的候选窗口 `LIMIT 16` 会被"JS 侧才过滤掉的单"占满
`board_store.js:458-484`

**这是什么**：候选 SQL 只过滤 `state/assignee/notBefore` 三项，`meetsRequires`（`:475`）和 `dependsSatisfied`（`:477`）在**JS 里**跳过。

**问题**：一旦排队里攒了 16 张"资格不满足或依赖未满足"的 ready 单（B3 的 `0007` 就是这种：ready + 依赖未满足），候选窗口被它们占满，**第 17 张可领的单永远轮不到**，`claimFor` 恒返回 null，bots 集体空转，不报错。这正是 t141/t142 修过的同一类"LIMIT + 事后过滤"。

**最小修复**：把 `requires` 的两条能下推的条件放进 SQL（`roles` 用 `jobRegistry` 侧算好的白名单拼 `IN`），并且**去掉 LIMIT**（ready 单本来就少）；最少一步：`LIMIT 16` → 扫描全部 `state='ready'`。

**不修会怎样**：多 bot 时"有单却没人领"，且排查时 `!jobs` 显示一堆 ready，看不出为什么。

---

#### B8　同一个"blocked 单依赖满足后重开"写了两份，两份还不一样
`board_store.js:996-1022`（`reopenOrphanBlocked`，带 `LIMIT`+`ORDER BY rowid DESC`+状态过滤）与 `board_store.js:1024-1043`（`reopenBlockedWithSatisfiedDeps`，**无 LIMIT、无排序**）

**这是什么**：两个函数体几乎逐行相同，唯一区别是前者加了 t142 的"LIMIT 不会被历史垃圾占满"修正，后者没有。

**问题**：后者只挂在 `board:finish` 事件上（`board_server.js:263`）。改一处忘另一处 —— 现在想给"重开"加任何规则（比如 B3 的 `DEP_DEAD`），必须改两个地方；而它们的行为已经不一致（一个按新单优先，一个按 rowid 升序）。

**最小修复**：删掉 `reopenBlockedWithSatisfiedDeps`（20 行），`board_server.js:263` 改调 `reopenOrphanBlocked(db, { parentId, now })`（给它加一个可选 `parentId` 过滤）。

**不修会怎样**：下一次修重开逻辑必然只修一半；两条路径给同一张单不同结果。

---

#### B9　共享数据迁移：一份死代码 + 一份内联副本，`migrateLocalToBoard` 零调用方
`board_store.js:1361-1412`（`migrateLocalToBoard`，52 行，grep 全仓**无调用方**）与 `agent.js:78-116`（`_migrateSharedOnce`，同样的搬家逻辑内联重写一遍）

**这是什么**：B4"把旧 memory 分片文件搬进板库"的迁移。

**问题**：store 里那份是死代码；真正跑的是 agent 侧手抄的一份。两份判断口径已经不同：store 版按"该 kind 有任意行就跳过"，agent 版按 `sharedList` 的返回长度；agent 版**不搬 `category/note` 之外的东西，也不搬 storage 的 note**。改一份、另一份变成更危险的"看起来是唯一实现"。

**最小修复**：删 `board_store.js:1361-1412`，或反过来让 agent 调它（agent 只需注入 `{readStore}`，`board_store` 不反向依赖 agent —— 签名早就为这个准备好了）。

**不修会怎样**：下一个人改迁移会改到死的那份，然后困惑"为什么行为没变"。

---

#### B10　地标/危险点/箱子：板库与 JSON 文件**两套真相同时在写**
`landmarks.js:43-45`（读 `chests/sites/storage` JSON）、`landmarks.js:96-102`（**写** 三个 JSON）、`world_model.js:107-109`（读 `dangers` JSON）、`skills.js:5153-5168`（**写** `dangers` JSON）、对照 `flow_store.js:70-90`（箱子内容写**板库** `shared`）

**这是什么**：06 §9.3 / B4 的验收要求"搬进板库后不许再有两份真相"。

**问题**：`flow_store` 把箱子内容写进板库 `shared.chest`，而 `landmarks.js` 仍在往 `bots/<name>/memory/chests.json` 写**另一份**箱子表（`addChest`/`updateChest` 路径），`protectedPlaces()`（`landmarks.js:56-76`）只读 JSON → 板库里记的箱子不会被当成"受保护地点"。危险点同理：`markDanger` 写 JSON，`strat_*` 读板库。
后果（具体）：A 用 `flow_store` 往箱子 X 存 5 个木头 → 板库 `shared` 有、`chests.json` 没有 → B 用 `sharedFindItem` 能找到箱子，但 A 自己的 `protectedPlaces` 里没有这个箱子，`atom_classify.isProtected` 不保护它 → 采集时把箱子当普通方块挖掉。

**最小修复**：`landmarks.js` 的 `chests/sites/storage` 三路读写整体改走 `board.shared*`（保留 JSON 仅作只读取证），或者反过来：把 `flow_store.rememberChest` 删掉、只留 JSON —— **二选一，不能两边都写**。`dangers` 同理。

**不修会怎样**：同一个箱子两个计数，谁先写谁说话；B4 的"全 bot 共享"只在直调 board API 的测试里成立（`composite_registry.js:440` 的注释已承认这条生产路径曾经完全没生效）。

---

#### B11　`rememberChest` 的读-改-写跨两次 socket 往返 → 丢更新
`flow_store.js:74-88`（`await board.sharedGet(...)` → 算 → `await board.sharedPut(...)`）

**这是什么**：箱子内容增量合并（存 +N / 取 -N），"先读现值再叠加"的设计是对的，但两次往返之间没有原子性，而 mindserver 在这中间会服务**别的 bot 的请求**。

**问题（交错序列）**：
- A 与 B 同时往同一个箱子 X 存东西。板库现值 `items={}`。
- t1 A `sharedGet('chest','X')` → `{}`
- t2 B `sharedGet('chest','X')` → `{}`（还没人写）
- t3 A `sharedPut` → `items={oak_log:5}`
- t4 B `sharedPut` → `items={stone:3}` —— **A 的 5 个木头被整个覆盖掉**
→ 之后 `strat_obtain.js:710-712` 按板库找材料，会认为箱子里没有木头，重复去砍。

**最小修复**：在 store 加一个服务端合并函数（一条语句完成）：`mergeSharedChest(db, key, delta, owner)` —— 事务内 `SELECT value` → 合并 → `UPDATE`；`board_server` 加 `board:shared-merge` 事件，`rememberChest` 改调它。

**不修会怎样**：两个 bot 共用仓库时箱子账目随机丢项，且丢得没有痕迹（谁后写谁赢）。

---

#### B12　租约过期回收不记 attempts → 崩溃型任务无限重试，且每次重试重复扣材料
`board_store.js:668-684`（`expireLeases` 只改 state/lease，`attempts` 一字不动）＋ `:53-63`（`TRANSITIONS`）

**这是什么**：`attempts` 只在 `finish()` 里按结果码加（`:636`）。进程被杀/断网被回收时**根本没有 finish**，`expireLeases` 是唯一会碰这张单的地方。

**问题**：任何"跑到一半把进程搞死"的单（OOM、`!restart`、长同步卡死被父进程 kill）→ 租约 30 秒后回 `ready` → 再领 → 再死，**`attempts` 永远是 0，`maxAttempts=3` 永远不会达成**，形成永久循环。
同一张单被重复执行的副作用是不幂等的：`craft` 单每跑一次就**真的**扣一次材料（`act_craft.js:375-417` 的 `produced` 是"这一次做了几个"，没有"这张单已经产出过"的账；`finish` 对 craft 只看 `okFlag`，`:566-567`）。

**最小修复**：`expireLeases` 的 UPDATE 里加 `attempts = attempts + 1`，并 `attempts+1 >= maxAttempts` 时直接置 `failed`（`result.code='LEASE_EXPIRED'`）；`SHUTDOWN` 这种"自己退出的"用 `interrupted.reason` 排除。

**不修会怎样**：一张"一跑就把 bot 弄死"的单会让 bot 起不来（每次重启都在 30 秒内再死一次）；合成类单会被重复扣料。

---

#### B13　`deathPickupJob` 的 `deadline` / `manifest` 被 `insertJobRow` 静默丢弃（4 分钟变 10 分钟）
`control.js:399-419`（返回对象里带 `deadline: now+4min`、`manifest.timeoutMs`）对照 `board_store.js:319-348`（INSERT 列清单里**没有** deadline/manifest）与 `:89-107`（`jobs` 表无这两列）

**这是什么**：死亡后"回去捡东西"的单，07 §7 要求 4 分钟 deadline（掉落物 5 分钟消失）。

**问题**：`addJob` 只把显式列出来的字段写库，`deadline`/`manifest` 不在其中也不是 JSON 列 → 静默丢掉。`jobDeadlineTimeoutMinutes(job)`（`control.js:316-325`）于是永远拿不到 deadline，退回默认 **10 分钟**。同一族问题在 `interrupted` 上已经踩过一次（`board_store.js:712-717` 有完整记录），这次是第二处。

**最小修复**：要么在 `jobs` 加 `deadline INTEGER` 列并进 `PATCHABLE`/INSERT（需要迁移，见 B14），要么把 deadline 放进已有的 `args` 里不参与语义（不推荐）。最小一步：`deathPickupJob` 改用 `notBefore` 之外的既有能力——直接在 `result`/`checkpoint` 里记 deadline 并由调度器读；但**最省事的是把 `deadline` 加进 `dependsOn` 之外的 JSON 列 `checkpoint`**：`checkpoint:{deadline:…}`，`jobDeadlineTimeoutMinutes` 先读 `job.checkpoint?.deadline`。

**不修会怎样**：捡东西的单会跑 10 分钟（东西 5 分钟就没了），白跑 + 占住调度。

---

#### B14　schema 没有版本号、没有 ALTER 路径：加一列就让所有**新单**被拒
`board_store.js:89-134`（`CREATE TABLE IF NOT EXISTS`，无 `PRAGMA user_version`）、`:153-161`（`openBoard` 只 `exec(SCHEMA)`）、`:319-323`（INSERT 显式列名）

**这是什么**：全部建表用 `IF NOT EXISTS`，旧库不会被改；也没有任何 `ALTER TABLE`（全仓 grep = 0 命中）。

**问题**：给 `jobs` 加一个字段（比如 B13 的 `deadline`）后，**旧库的 `jobs` 表没有这一列**，而 INSERT 的列清单里写了它 → 每条 `addJob` 抛 `table jobs has no column named deadline`。`openBoard` 不报错（库能打开），于是走不到 B5 的重建路径；`board:add` 的 catch 把异常转成 `{ok:false, reason:...}`（`board_server.js:142-144`），**所有新单静默被拒**，而老单照常在跑 —— 最难查的一类"半死"状态。

**最小修复**：`openBoard` 里建表后加一段幂等迁移：
`PRAGMA user_version` 读版本 → `if (v < 2) { try { db.exec('ALTER TABLE jobs ADD COLUMN deadline INTEGER'); } catch {} db.exec('PRAGMA user_version = 2'); }`。
（`memory_store.js:27` 的 JSON 文件已有 `_v` 字段，但**没有任何代码校验/升级它**，属于同一类欠账。）

**不修会怎样**：任何一次加列 = 上线后"任务板只读"，而且要等有人去看日志才知道。

---

#### B15　`JOB_STATE` 两套定义（9 个状态 vs 5 个）
`board_store.js:34-44`（pending/ready/claimed/running/paused/blocked/done/failed/cancelled）与 `control.js:68-74`（只有 ready/claimed/running/paused/failed）

**这是什么**：状态名的两个真相。control 层现在**无法表达** `done` / `blocked` / `cancelled`。

**问题**：`jobsBusy()`（`control.js:295-304`）只看 ready/claimed/running → 一张 `blocked` 的父单（B3 现场）不算"忙"，`self_prompter` 会在它卡着的时候催模型自己找事做；`requeueStaleBrief` 看不到 blocked。任何"按状态做判断"的新代码都得先决定用哪一份。

**最小修复**：删掉 `control.js:68-74`，改成 `import { JOB_STATE } from './board_store.js'`（`board_server.js:426` 已经是这么做的，先例现成）。

**不修会怎样**：状态机有第二份定义后，新状态（已经加到 9 个了）必然漏同步一次。

---

#### B16　`_claimNext` 的 requires 二次校验是死代码（`agent.roles` 从不存在）
`board_scheduler.js:557-562`、`:572-575`（`this.agent?.roles ?? []`）

**这是什么**：领到单后客户端再判一次资格，不满足就 `setState(ready)` 退回。

**问题**：`agent.roles` 全仓**没有任何一处赋值**（grep：只有 `board_client.js:71` 从 `settings.profile.roles` 拿到 name 为 `roles` 的客户端字段）。所以 `_who().roles` 恒为 `[]`，而 `meetsRequires` 对"who 没配角色"的语义是**不受限**（`board_store.js:919-924`）→ 这段判断恒真，永远不生效。真正的资格过滤在服务端 `claimFor`（`board_server.js:212-216`，用的是 hello 上报的 roles），是对的。

**最小修复**：删掉 `:557-562` 与 `:572-575`（10 行），只信任服务端。

**不修会怎样**：读代码的人会以为"客户端还有一道资格闸"，实际没有；而一旦有人给 `agent.roles` 赋了值，就会冒出"领到→退回 ready→再被抢"的抖动。

---

#### B17　`terrain3d.fail` 表只增不减：`pruneFails` 没有任何生产调用方
`terrain3d.js:602-608`（函数定义）、`:220`（`failPrune` 语句）；grep 全仓：调用方只有 `tools/terrain3d_unit.mjs:72`（单测）

**这是什么**：失败记忆表（"这里走过走不通"）。TTL 只在**读**时过滤（`:532-546`，`WHERE last_at >= ?`），行本身不删。

**问题**：`recordFail` 每次振荡记 3 次（`executor.js:857-861`，这是有意为之），一次长距离寻路能写几十行；这些行**永远不会被物理删除**。规划器每轮都调 `readFails`（`path_3d.js:144`），虽然走了索引，但表随运行时长线性增长（一夜 10 轮挖矿 × 每轮几十行）。文件注释自己写着"规划每轮都会 readFails，所以定期删一次"—— 但没人调。

**最小修复**：在 `board_server` 的 `scanTimer` 之外给 bot 侧加一个低频清理：`walkTo` 开头（`executor.js:820` 附近）每 N 次调用一次 `pruneFails(mapDir)`（比如按 `scans % 50 === 0`）。一行调用。

**不修会怎样**：库越来越大（`surf` 表还会被 `scanSphere` 重写，`fail` 表只增），长时间运行后每次规划都拖着越来越大的表扫。

---

### Nice to have

#### B18　`board:finish` 的"顺手释放预约"恒为 no-op（owner 取错）
`board_server.js:256`（`release(db, r.job.id, r.job.lease?.owner ?? payload?.bot ?? '', null)`）＋ `board_client.js:356-360`（`finish` 只发 `{id, result}`，没有 `bot`）

**这是什么**：finish 之后放掉这张单的预约。

**问题**：`finish()` 内部已经把 `lease_owner` 置 NULL（`:638`），所以 `r.job.lease.owner` 恒为 null；回退取 `payload.bot` = `undefined` → `String(undefined)` = `''` → `DELETE ... AND (owner IS NULL OR owner='')` 删不到任何真实 owner 的行。真正生效的是调度器 finally 里的逐个 `ctx.release`（`board_scheduler.js:699-701`），所以现在没出事；但这条"兜底"是假的。

**最小修复**：finish 前先 `const owner = getJob(db,id)?.lease?.owner` 存下来，再释放；或直接删掉这 3 行（调度器已经负责）。

**不修会怎样**：一旦调度器那条路失败（进程崩溃前），预约要靠 30 秒 TTL 才释放，期间别的 bot 抢不到箱子/区域。

#### B19　`repeat_ms` / `notBefore` 是死字段
`board_store.js:104`（列）、`:217-218`（映射）、`:344-346`（写入）、`:462`（读）

**这是什么**：重复任务周期与"最早可领时间"。

**问题**：两个字段全仓**只有 store 内部读写**：没有任何代码生成 `repeat`（grep `job.repeat` 仅 4 处，都在 store），也没有任何调用方设置 `notBefore`。`claimFor` 的 `notBefore` 过滤永远是真。

**最小修复**：保留列（SQLite 删列要重建表），但删掉 `:217-218` 的映射与注释里的承诺；或用 `notBefore` 实现 B12 的"崩溃后退避"，让它真的有用。

**不修会怎样**：读代码的人会以为有"定时重复任务"这个能力，实际没有。

#### B20　`scanSphere` 整段扫描包在一个写事务里，而且是同步驱动
`terrain3d.js:275`（`BEGIN`）→ `:413`（`COMMIT`）、`:261-424`

**这是什么**：半径 36 的球形扫描，逐列 `DELETE` 旧行 + 逐格 `INSERT`，全部在一个事务里；`DatabaseSync` 是同步 API。

**问题**：每次扫描约 4000 列（`π·36²`），事务从开始到提交期间**整个 Node 进程阻塞**（socket ack 回调、心跳定时器、3 秒调度 tick 都停住）。`executor.js:905-914` 每轮最多扫 2 次、`MAX_ROUNDS=120`。按代码注释里的实测基准（`terrain3d.js:20`：27ms/区块，半径 36 ≈ 16 个区块）估算单次约 0.4 秒 —— 现在这个量级不会撞 30 秒租约，但它是"一次心跳都发不出去"的沉默窗口。

**最小修复**：把内层 `for (let dz...)` 的列循环每 N 列 `COMMIT`+`BEGIN` 一次（把一个大事务拆成若干小事务），或者把 `scanSphere` 改成 `setImmediate` 分批的异步版本。

**不修会怎样**：扫描半径或频率一旦调大，就会以"心跳超时 → 租约丢失 → 同一张单被两个 bot 跑"的形式爆出来（链条见 B1）。

---

## 4. 未读部分（诚实边界）

- `executor.js`：只精读了 1-80、820-1097（主循环、振荡、扫描、挖后局部更新）；**80-820 的导航动作分发细节未逐行读**，因此本报告不对导航正确性下结论。
- `composite_registry.js`：只读了 400-614（`makeCtx` / `runSkill`）；**1-400（注册表构造、manifest 校验、参数解析）未逐行读**。
- `step_runner.js`：读 1-80；80-163 的 onFail 降级表未细读。
- `world.js`：仅做持久化相关检索（无文件/SQLite 写入），未通读 431 行。
- `terrain3d.js`：读 1-130、150-430、510-620；430-510（`boxSurfaces`/`saveSurfaces`/`clearChunk`）未细读。
- `board_store.js` 全 1412 行、`board_server.js` 全 426 行、`board_client.js` 全 469 行、`board_scheduler.js` 全 805 行、`control.js` 全 463 行、`board_claims.js` 全 201 行、`memory_store.js`/`storage.js`/`full_state.js`/`trace_bus.js`/`modes.js`/`lockdown.js`/`outcome.js` 全文读过。
- `docs/交接文档.md` 里**没有**"父单兜底收敛 / 孤儿父单 / LIMIT 200 时间炸弹 / 库存池统筹"这四条的记录（grep 0 命中）；相关的历史只在 `docs/architecture/REFACTOR_ANALYSIS.md:3249/3273-3280` 有两条简述。因此"库存池统筹"这一项**没有背景材料可对照**，本报告未涉及。
- 未在真机复现任何一条竞态（只读审查 + 现有库快照）。B1/B11 的交错序列是按代码路径与 socket 语义推导的，不是抓包实测。

---

## 5. Lean 统计

**可直接删的代码（不改任何行为）**

| 位置 | 行数 | 理由 |
|---|---|---|
| `board_store.js:1024-1043` `reopenBlockedWithSatisfiedDeps` | 20 | 与 `reopenOrphanBlocked` 重复，后者更新（B8） |
| `board_store.js:1361-1412` `migrateLocalToBoard` | 52 | 零调用方，逻辑被 `agent.js:78-116` 内联重写（B9） |
| `board_scheduler.js:557-562, 572-575` 客户端资格闸 | 10 | `agent.roles` 从不存在，恒真（B16） |
| `control.js:68-74` 第二份 `JOB_STATE` | 7 | 与 store 定义重复（B15） |
| `control.js:193` `countAttempt: false` | 1 | 白名单外的死字段（同文件 `:444-449` 已记过一次） |
| `board_client.js:264-268` `setAutoClaim` 的客户端字段 | 5 | 设置后无人读（B2） |
| `board_server.js:256` 假释放 | 1 | owner 取错，恒 no-op（B18） |
| `control.js:339-351` `runJobAction`（若按 B2 改用它则**保留**；若不用就该删） | 13 | 零调用方；删了就等于承认"任务单不进 action_manager"这个现状 |
| **合计** | **≈96 行（若删 runJobAction 则 ≈109 行）** | 占 1412 行的 6.8%～7.7% |

**另外三处"本该不存在"**
- `jobs.repeat_ms` + `job.repeat` 映射（4 处）＋ `notBefore` 过滤：无人生产，死字段（B19）。
- `control.js` 里 `deadline`/`manifest` 两个字段：写进去就被 `insertJobRow` 丢掉，等于"看起来有 deadline，实际没有"（B13）。
- `agent.roles`：幽灵字段（B16）。

**被复制粘贴但应合并的**
- 三处几乎逐行相同的 `_migrateSharedOnce` / `migrateLocalToBoard`（B9）
- 两处几乎逐行相同的 reopen blocked（B8）
- 两份 `JOB_STATE`（B15）

**一行就能修的**：B17（加一次 `pruneFails` 调用）、B18（删 3 行）、B15（改一行 import）、B5（改一个 catch 条件）。

---

## 6. `board_store.js` 1412 行的职责拆分（可拆点）

按行号切，实际是 **9 个互不相关的职责 + 2 个域**：

| 行段 | 职责 | 行数 |
|---|---|---|
| 34-84 | 状态机常量与转移表、错误码分类、租约常量 | ~50 |
| 89-202 | 建表 SQL + 打开/修复库（含 B5 的破坏性兜底） | ~114 |
| 208-266 | 行↔对象映射（JSON 编解码）+ 进度单调合并 | ~58 |
| 301-350 | 加单 / INSERT | ~50 |
| 352-486 | 读单 / 列单 / 按库存收敛 / **原子领单** | ~135 |
| 488-684 | 心跳续租 / finish（状态决策）/ 租约过期回收 | ~197 |
| 691-763 | setState / updateJob（白名单） | ~73 |
| 765-890 | 预约（reserve/release/expire/renew/list） | ~126 |
| 892-943 | 资格与 dependsOn | ~52 |
| 945-1158 | 父子收敛 + 两个兜底扫描（其中 48 行是重复实现） | ~214 |
| 1160-1257 | 拆单（按数量 / 按区域） | ~98 |
| **1259-1412** | **共享世界数据**（地标/危险/箱子/找箱子/旧文件迁移）—— 与调度**零关系** | **~154** |

可落地的拆点（按收益排序）：
1. **`board_shared.js`**：`1259-1412` 整体搬出（154 行，含 `SHARED_KINDS`/`putShared`/`getShared`/`listShared`/`delShared`/`findItemInSharedChests`/`parseChestKey`/`sharedRowToObj`/`migrateLocalToBoard`）。`board_server.js` 只要改 import 来源。这一步把"调度状态"和"世界记忆"分开，也是 B10 的天然落点。
2. **`board_rollup.js`**：`945-1158`（父子收敛 + 两个兜底扫描），顺带删掉重复的那 48 行（B8）。
3. 剩下的 `board_store.js` ≈ 1050 行仍是"一个域一个文件"，可以接受。

---

## 7. 建议的修复顺序（依赖最少者优先）

1. **B5**（一个 catch 条件）—— 防"一重启丢整板"，风险最低、收益最大。
2. **B1 + B12**（finish 加租约守卫；expireLeases 记 attempts）—— 这两个一起做才有意义：不加卫士，加了 attempts 也会被旧持有者覆盖。
3. **B2**（!stop 三处接线）—— 用户每天都会按的键。
4. **B3 + B4**（两个"永久卡住"的兜底扫描）—— 都挂在已有的 5 秒 scanTimer 上，增量代码不到 30 行。
5. **B6 + B7**（把状态过滤下推 SQL）—— 与 t142 的修法同型，一次改完两处。
6. **B8/B9/B15/B16/B18**（删代码）—— 纯减法，可以和上面并行。
7. **B10 + B11 + B13 + B14**（数据真相与 schema）—— 需要一次明确的"停止写 JSON"决定和一次幂等迁移，单独一轮做。
