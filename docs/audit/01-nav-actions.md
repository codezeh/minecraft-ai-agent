# 审计① · 导航 / 动作 / 原子层（`mindcraft/src/agent/library` 主干）

审计对象：`mindcraft/src/agent/library/` 下的导航链（`nav_core` → `executor` → `path_3d` / `terrain3d` / `nav_pathfinder`）、原子层（`atom_*` / `act_*` / `query_*`）、以及巨型主干 `skills.js`。
本报告只读代码、不改任何源码。所有行号均来自实际读到的行，可用 `grep -n` 复核。

## 负载假设

单人 / 少数几台机器：1 个 Paper 服务端 + 1~3 个 bot 实例 + 1 个 Web 控制面板；bot 由 LLM 驱动，按秒级节奏连续下指令；任务板用 SQLite 持久化。每个 bot 是**独立进程**（`src/process/init_agent.js:45` 一次只 `new Agent()`），所以进程内的模块级变量天然"每 bot 一份"。

---

## (a) 这一层做什么

导航链用一张自建的真 3D 体素表（`terrain3d.db`，每列可存多个"可站立面"）代替全局 2.5D 地图：每轮先扫一个半径 36 的球把地形写进 SQLite，再用 `path_3d.js` 的 3D A* 算出一段约 16 格的路径（每步带 `walk/jump/down/dig/climb/swim` 动作），由 `executor.js` 逐步执行，走完再重扫重算。原子层（`atom_*`/`act_*`/`query_*`）把"挖一个方块""走一格""查一个方块"这类单次操作收成显式契约（`{ok, code, message, data}`），复合层（`flow_*`）负责编排。而 `skills.js`（5819 行、98 个导出）是历史遗留的"函数大卖场"——**它全部导出会被原样塞进模型可见的技能目录**（`index.js:36-40` → `skill_library.js:52`），所以里面的每个函数都是模型可以直接调的活代码，不是死代码。

---

## (b) 发现清单

## Must fix

### N1 一次 `!survey` 默认触发半径 64 的整球同步扫描（≈110 万次方块读取 + ≈1.3 万条 DELETE）
`skills.js:5402`（签名默认 `radius = 64`）→ `skills.js:5427-5428`（`scanSphere(..., Math.max(16, radius))`）→ `terrain3d.js:277-307`

**这是什么**：`scanSphere` 是同步函数，对球内每一列、每一格都调一次 `bot.blockAt`，并先对该列执行一条 SQL `DELETE`（`terrain3d.js:305`）。半径 r 的代价是球体积 `4/3·π·r³`。

**问题**：模型默认调用 `skills.surveyArea(bot)`（不传 radius）→ r=64 → 访问约 `4/3·π·64³ ≈ 110 万` 格方块，并对 `π·64² ≈ 12868` 列各发一次 DELETE，全部在同一个同步事务里。`bot.blockAt` 是同步的，这期间 Node 事件循环完全停摆、mineflayer 无法处理任何服务端包。项目自己在 `collect_planner.js:28` 记过实测："对每种木头各调一次 findBlocks 造成 loop-lag（实测 2332ms 被踢下线）"——2.3 秒就被踢，几十秒必然掉线。`skills.surveyArea` 还在 `skill_library.js:39` 的 `always_show_skills` 白名单里（全量文档注入），等于**主动鼓励模型调它**。`!map refresh` 走同一条路：`map_query.js:40` 默认 `radius = 4` 个区块 → `map_query.js:45` `spanBlocks = 64` → `map_query.js:52-53` 同样 r=64。

**最小修复**：把 `surveyArea` 的默认半径改成 24（`4/3·π·24³ ≈ 5.8 万` 格，实测同量级的 `bench_move_actions.mjs:396` 用的就是 24），并在 `scanSphere` 入口把 `radius` 硬夹到 ≤32；`map_query.js:53` 的 `Math.max(16, spanBlocks)` 改成 `Math.min(32, Math.max(16, spanBlocks))`。

**不修会怎样**：模型每次"看看周围"都可能把 bot 挂到掉线，表现为 `fell out of the world` 式的莫名重生、任务半途中断，且现象与导航逻辑毫无关系，极难定位。

---

### N2 导航互斥闸的 owner 缺省值全是 `'adhoc'` → 没有任务单的两条指令被当成"同一个 owner"直接重入
`nav_core.js:189`（`owner = bot?.__navJobId ?? 'adhoc'`）、`nav_core.js:128`（`if (_navOwner === null || _navOwner === owner)`）

**这是什么**：`nav_core` 加了一道"同一时刻只允许一个驱动者用 pathfinder"的闸（`nav_core.js:89-111` 的注释写了它的来历：真机 1590 次 `dig false INTERNAL`，根因就是两条流互相改 pathfinder 的 goal）。它的语义是"同 owner 可重入，不同 owner 排队"。

**问题**：owner 的缺省值是字符串常量 `'adhoc'`。任何没有任务单的调用——面板上连发两条 `!newAction`、`idle_planner` 直调、模型在一次 action 里并发两个技能——拿到的 owner 全部是 `'adhoc'`，命中 `_navOwner === owner`，于是**被判定为"自己重入"，两条流同时通过闸**。两条 `walkTo` 同时对同一个 pathfinder `setGoal`，后一条把前一条的 goal 换掉 → 前一条的 `dig`/移动全部 `INTERNAL The goal was changed`。这正是 `nav_core.js:92-100` 记录的那个症状，而这道闸恰好对"没有任务单"这种最常见的情形不生效。

**最小修复**：owner 缺省不要用常量，改成每次调用生成唯一值，例如 `owner = bot?.__navJobId ?? \`adhoc:${++_adhocSeq}\``（模块级自增）。需要真重入的地方（`withNav` 包住的 `collectDrops` 内部）本来就是同一个 `bot.__navJobId` 或显式传 owner，不受影响。

**不修会怎样**：LLM 连发两条指令（很常见：一条"走过去"一条"砍树"）时，导航层重新退回"两条流抢一个 pathfinder"，`dig` 成功率掉到 1/1590 那个量级，且日志里只有 INTERNAL，看不出是闸没生效。

---

### N3 至少 12 处直接驱动 pathfinder 的调用点绕过了 N2 那道闸
`flow_collect_plan.js:268`、`flow_collect_plan.js:406`、`flow_collect_plan.js:299`、`flow_collect.js:127`、`flow_follow.js:186/317/373/502`、`flow_platform.js:59`、`atom_tunnel.js:252/266/288`、`tool_prep.js:202`、`skills.js:1628/1798`（`bot.pathfinder.goto`）、`skills.js:2186/2261`（`setGoal`）
（grep 复核：`grep -rn "await \(moveTo\|moveToXZ\|walkTo\)(\|pathfinder\.goto\|pathfinder\.setGoal" src/agent/library`）

**这是什么**：闸只在 `nav_core.goTo` / `nav_core.withNav` 里拿锁。其余直接调 `moveTo` / `moveToXZ` / `walkTo` / `pathfinder.goto` 的地方都不经过它。

**问题**：`flow_collect_plan.makeHandlers` 的 `moveTo` 处理器在 `flow_collect_plan.js:268` 直接调 `walkTo`，`climbByTunneling` 在 `406` 也直接调 `walkTo`——而采集流程是**和别的流程并行跑**的（任务板切任务）。`flow_pickup` 已经因为同样的原因被修过一次：`nav_core.js:34-43` 明写"`flow_pickup.collectDrops` 直接用 `moveTo` 绕过了 `goTo` 的单一驱动者闸……第 23 跑立刻和挖矿抢 pathfinder：`goTo false NO_REACH ×579`"。修法是给 `flow_pickup` 套 `withNav`（`flow_pickup.js:145/174`），但**同一类调用点还有 12 处没套**，`flow_collect_plan` 就是下一个会撞的（它每挖一块就调一次 `walkTo`）。

**最小修复**：把 `flow_collect_plan.js:268/406` 和 `flow_collect.js:127` 三处的调用包进 `withNav(bot, () => ...)`；`flow_follow` / `flow_platform` / `atom_tunnel` 同理。如果嫌逐处改容易漏，更彻底的做法是让 `nav_pathfinder.moveTo` / `moveToXZ` 在入口自己 `await acquireNav(bot.__navJobId ?? 唯一值)`（默认关闭、只有 `withNav` 内部用 flag 跳过），这样漏改不可能发生。

**不修会怎样**：任务板把"采集"和"跟随/取物"排到相邻时，两个流程互抢 pathfinder，`dig` 大量 INTERNAL、`goTo` 报 NO_REACH，而报告里只会说"走不到"，不会说"被另一条流抢了"。

---

### N4 地标保护清单永远是空的（写的用扁平 `{x,y,z}`，读的找 `.pos`）→ 玩家的箱子和房子不设防
`landmarks.js:78-80`

**这是什么**：`protectedPlaces()` 产出"不许挖的地方"清单，`flow_collect_plan.js:113` 拿它逐格过闸（`isProtected`，`query_classify.js:110-121`），是"砍树不砍到玩家建筑"的唯一防线。

**问题**：三行读的是嵌套字段 `c?.pos` / `s?.pos` / `lm.storage?.pos`，但**所有写入方写的都是扁平坐标**：`rememberChest` 存的是 `{ ...n, note, lastUsed }`（`landmarks.js:131`，`n = {x,y,z}`）、`rememberSite` 同理（`landmarks.js:203`）、`rememberStorageArea` 是 `{ ...n, note, createdAt }`（`landmarks.js:185`）。grep 全树确认没有任何地方往 chests/sites/storage 里写 `pos` 字段（`grep -rn "pos:" landmarks.js memory_store.js` 无结果）。于是 `spots` 恒为 `[]`，`isProtected` 恒返回 `protectedBy: null`——**这道闸从写出来的那天起就没拦过任何东西**。`flow_store.js:65-87` 另有一套"箱子记忆"写进任务板（`sharedPut('chest', key, {pos:{...}, items})`），但那是另一个库、且没人喂给 `protectedPlaces`。

**最小修复**：三行改成直接取扁平坐标并过滤有效性：
```js
for (const c of lm.chests || []) if (Number.isFinite(c?.x)) spots.push({ x: c.x, y: c.y, z: c.z });
for (const s of lm.sites  || []) if (Number.isFinite(s?.x)) spots.push({ x: s.x, y: s.y, z: s.z });
if (Number.isFinite(lm.storage?.x)) spots.push({ x: lm.storage.x, y: lm.storage.y, z: lm.storage.z });
```

**不修会怎样**：数据丢失。bot 会为了砍一棵树把玩家的箱子/房子当树干挖掉，而所有"已保护"的日志和代码都在，事后无从理解为什么保护没生效。

---

### N5 `scanSphere` 先删列再读，读不到时该列旧数据被删掉且不重写
`terrain3d.js:305`（`s.delCol.run(wx, wz)`）→ `terrain3d.js:310-321`（`if (!b) { missing++; break; }`）→ `terrain3d.js:397`（`if (loaded === 0) continue;`）

**这是什么**：`scanSphere` 的注释（`terrain3d.js:295-304`）解释"每列扫描前先清空该列旧记录"，因为早期版本只 INSERT 会留脏数据。读取失败时（`bot.blockAt` 返回 null，即该区块未加载）代码选择"中断这一列、不记录任何面"（`terrain3d.js:312-321` 注释：宁可少记不能记错）。

**问题**：DELETE 已经在读之前执行了，而 `break` 之后 `loaded === 0` 只是 `continue`——**这一列原本正确的旧数据已经没了，且不会重写**。场景：她走到扫描球边缘、有若干列落在未加载区块里（`SCAN_R=36` 跨 3 个区块，`bench_deepwater.mjs:77` 记过"对岸/墙另一侧可能还没加载"）→ 那批列的 surf 行被删 → 本轮 `plan3D` 的 `boxSurfaces` 少了一批面 → 规划凭空 NO_PATH/NO_START，下一轮这些区块加载了又写回来。`.mca` 导入的远距离地形（`terrain3d.js:460-495` `saveSurfaces` 的注释说"导入的远距离地形和她走过扫的地形能无缝拼起来"）在同一路径上也会被抹掉。

**最小修复**：把 `delCol` 移到"这一列至少读到过一格"之后；最省事的是在循环开始前先探一格 `if (!bot.blockAt(new Vec3(wx, yTop, wz), false)) { missing++; continue; }`，确认可读再 `delCol`。

**不修会怎样**：地图数据反复被删又写回（每次扫描都抖一遍），规划结果随"这一秒区块加载没加载"随机变化，表现为同一个目标时好时坏、NO_PATH 无法复现。

---

### N6 步骤执行器把"全部步骤失败"报成 `ok`，`skills.digTunnel` 于是把"一格没挖"汇报成"挖了 N 步"
`step_runner.js:101-102`（`const action = rule?.action ?? 'next'`）→ `step_runner.js:140-143`（`next` 就是 `continue`）→ `step_runner.js:149-154`（`return ok({ doneSteps, count: doneSteps, failed, ... })`）；消费点 `skills.js:5742-5750`

**这是什么**：`runSteps` 按 `onFail` 表降级；表里没写的 code 一律 `next`（继续下一条）。循环跑完后**无论 `failed` 里有多少条，都返回 `ok`**。

**问题**：`skills.digTunnel` 造了 N 个 `{atom:'tunnelStep'}` 步骤，**没给任何 `onFail` 表**（`skills.js:5723`），所以每一步失败都是 `next`。若第一步就因 `LIQUID_RISK` 被拒（`atom_tunnel` 的安全性检查会拒绝），N 步全失败 → `run.ok === true` → `skills.js:5742` 的 `if (!run.ok) return run;` 不触发 → 走到 `skills.js:5750` `return ok({ steps: n, to })`，`to` 等于 `start`（她一步没动）。模型看到的是"成功挖了 3 步的隧道"。对比 `flow_collect.js:198-211`：它靠**再数一次背包**兜住了（`countAll() - before <= 0` → 拉黑目标），所以采集流程没事；`digTunnel` 没有这条兜底。

**最小修复**：`step_runner.js:149` 改成 `if (failed.length && doneSteps === 0) return fail(failed[0].code ?? 'INTERNAL', ...)`（一步没成就是失败），或至少把 `ok` 的条件改成 `doneSteps > 0`；`skills.js:5742` 之后再补一句 `if ((run.data?.failed ?? []).length) return fail(...)`。两者取一即可，前者更彻底（一处修，所有消费方受益）。

**不修会怎样**：模型基于假成功继续下一步决策（"隧道已经挖通，继续前进"），实际原地不动；且这条链路不产生任何失败码，任务板上这张单会被记成完成。

---

## Should fix

### N7 `digdown` 分支不校验"真的下降了"就返回成功（同一文件里另一分支有守卫）
`executor.js:363`（`return ok({ dug });`）对照 `executor.js:310-316`

**这是什么**：`execStep` 里 `dig` 分支和 `digdown` 分支是两段结构相同的循环。`dig` 分支收尾时明确检查"没到目标高度就别说 ok"（`executor.js:310-316`，注释写着"假成功会让上层停止重规划并原地卡住"）。

**问题**：`digdown` 分支没有这个检查。三种提前退出都会走到 `executor.js:363` 的 `ok`：`blockAt` 读不到（`:337 break`）、正下方是液体（`:342-345 break`，只发了 `liquid-pass` 事件）、`y <= targetY` 之外的循环结束。场景：她要在水里往下走到 y=58，`below` 是 water → `break` → `return ok({dug:0})`，位置还在 y=62。`walkTo` 认为这步成功；靠 `movedEnough`（`query_stuck.js:69`，垂直权重 1.5）后续 3 轮判 `NO_REACH` 才收场——也就是说自愈要靠另一个机制，代价是 3 轮（每轮 ~19.5 万次方块读取，见 N14）。

**最小修复**：`executor.js:363` 改成与 `dig` 分支同构：
```js
const nowY = Math.floor(bot.entity.position.y);
if (nowY > targetY) return { ok:false, code: liquidBlocked?'BLOCKED':'NO_REACH', message:`只到 y=${nowY}（目标 ${targetY}）` };
return ok({ dug });
```

**不修会怎样**：向下走的所有失败都被报成成功，靠 3 轮空转和另一个计数器兜底；日志里看到的是 `NO_REACH`，真实原因（水/读不到）只在 `liquid-pass` 事件里，和最终结论对不上。

---

### N8 `walk` 步"补垫高"失败被吞，同一意图在文件另一处却如实返回失败
`executor.js:669-676` 对照 `executor.js:371-379`

**这是什么**：两段都是"垫方块往上爬"，用的是同一个 `stepUp`（`executor.js:683`）。

**问题**：`:371-379` 的版本 `if (!up.ok) return up;`（如实失败）；`:669-676` 的版本 `if (!up.ok) break;`，然后 `:676 return r;`——返回的是 `moveToXZ` 的 `ok`。场景：目标比她高 3 格、背包没有可垫方块，`stepUp` 返回 `NO_ITEM`（`executor.js:686`）→ 循环 break → 返回 `ok` → 她水平走了 0.8 格，`movedEnough` 算出 `0.8 < 2`：卡住计数 +1，3 轮后 `NO_REACH`。若水平位移恰好 ≥2（长距离步），卡住计数被重置，于是"永远差 2 格高"这件事可以一直拖到 `deadlineMs`（300 秒）或 `MAX_ROUNDS=120`。

**最小修复**：`:673` 的 `if (!up.ok) break;` 改成 `if (!up.ok) return up;`（与 `:376` 一致）。

**不修会怎样**：差高度这类失败在长距离行走中被吞掉，行走时间被拖满 5 分钟兜底，最后报 `TIMEOUT`/`NO_REACH`，而"没有垫脚方块"这个唯一可行动的信息丢失。

---

### N9 地下扫描时，球顶那层整片造出并不存在的"可站立面"（穹顶）
`terrain3d.js:288`（`let prevAir = true;`）→ `terrain3d.js:379-393`（`if (!isAir && prevAir) { ... s.ins.run(...) }`）

**这是什么**：扫描判定规则是"从空气变实心 → 这个实心块顶面能站"（`terrain3d.js:327`）。`prevAir` 初始值是 `true`，意思是"假定扫描窗口上方是空气"。

**问题**：`prevAir=true` 只在天上成立。她在 y=-56 的矿洞里时（项目日志里 `feetY=-51`、`feetY=-56` 都是他们真实跑到的深度），`scanSphere(center.y=-56, r=36)` 的 `yTop = -20`（`terrain3d.js:284-286`），那一格是实心石头 → 按规则被判成"可站立面"，于是**球顶整个穹顶（每一列都是）被写成假面**。`plan3D` 的搜索范围是 `y ±40` = `[-97,-17]`（`path_3d.js:130-131`），`-20` 落在里面 → A* 能把这条路算出来（挖上去 37 格 ≤ 允许的 40 格，`path_3d.js:443`）；真实前进不了，`executor` 的挖掘循环 `dug < 32`（`executor.js:223`）在 32 格后放弃，报 `NO_REACH`。

**最小修复**：`terrain3d.js:288` 改成按窗口上方那格的真实类型初始化：
```js
const bAbove = (() => { try { return bot.blockAt(new Vec3(wx, Math.min(Y_MAX, yTop + 1), wz), false); } catch { return null; } })();
let prevAir = !bAbove || AIR.has(String(bAbove.name || ''));
```

**不修会怎样**：她在地下、真的无路时，不是老实报 `NO_PATH`/`NO_START`，而是收到一条"往上挖 37 格"的假路，每轮白挖 32 格（约 30 秒）。这是"NO_PATH 变成漫长空转"的一个稳定来源。（本条的效果量级**需跑起来才能判定**，机制本身从代码可确定。）

---

### N10 挖掉一格时把该列**上方所有**面一起删掉（多层空间被压成单层）
`terrain3d.js:583`（`DELETE FROM surf WHERE x = ? AND z = ? AND y >= ?`）→ `terrain3d.js:586`（`INSERT ... (x, z, y, t) VALUES (?, ?, ?, ?)` 用的是 `fy - 1`）

**这是什么**：`noteDugSurface` 的语义是"挖掉 (x,y,z) 后，把下面那格登记成新的落脚面"（`terrain3d.js:578`）。它由 `executor.js:1093` 在每次挖成功后调用。

**问题**：删的是 `y >= fy` 的**全部**行。而整张表的设计前提是"同一列可能有多个面（洞穴地面/天花板/悬空平台）"（`terrain3d.js:8-10`、`terrain3d.js:102-110`）。场景：她站在两层平台上挖脚下那层（`fy=70`），同一列上方 `y=80` 有个合法的二层平台记录 → `DELETE ... y >= 70` 把 `y=80` 也删了 → 该列只剩 `y=69` 一个面。之后所有经过这一列的规划都看不见上层平台，原本可以走的上层路变成 `NO_PATH`，或规划绕一大圈。

**最小修复**：只删和这次挖掘相关的那一格及其正上方的"被挖穿"部分，即改成 `DELETE ... AND y = ?`（配合 `forgetSurface` 已经在 `executor.js:1086` 删过被挖的那格，这里其实只需 INSERT 新面）；如果确实要清"挖穿后悬空的上方面"，也应该用"取该列现存的最小 `y > fy`"而不是全删。

**不修会怎样**：多层地形（洞穴、平台、树屋）随挖掘逐层退化成 2.5D，3D 库最核心的能力被自己的局部更新逻辑吃掉；症状是"明明上面有路，规划说没有"。

---

### N11 `fail` 表只增不减：`pruneFails` / `clearFail` 在生产代码里没有任何调用者
`terrain3d.js:602`（`pruneFails` 定义）、`terrain3d.js:610`（`clearFail` 定义）；写入点 `executor.js:1027`（每失败一步一条）、`executor.js:859-861`（每次振荡写 3 条）

**这是什么**：`fail` 表记"这里走过走不通"，`path_3d` 读它给格子加价（`path_3d.js:143-144`、`path_3d.js:411-412`）。TTL（10 分钟）只在**读**的时候过滤（`terrain3d.js:537`）。

**问题**：`pruneFails` 的注释自己写着"TTL 只在读的时候过滤，行本身一直在表里……所以定期删一次"（`terrain3d.js:595-597`），但 grep 全树：`pruneFails` 只被 `tools/terrain3d_unit.mjs:72` 调用；`clearFail` 只被 `tools/bench_failmem.mjs:123`、`tools/test_nav_opt.mjs:128` 调用。**生产路径一次都没调**。于是跑一夜：`MAX_ROUNDS=120` × 每轮至少 1 条失败记录 × 每次振荡 3 条，行数单调增长，永不过期删除。读路径有 `idx_fail_last_at` 索引（`terrain3d.js:136`）所以查询不会立刻退化，但表会一直变大，且"10 分钟后不该再影响规划"这个语义只能靠内存过滤兜。

**最小修复**：在 `walkTo` 成功返回前调一次 `pruneFails(mapDir)`（一行），或在 `executor.js` 的每轮开头按 "if (rounds % 20 === 0) pruneFails(mapDir)" 调。同时成功走完一步后对 `step` 坐标调 `clearFail`（目前"成功就不再加价"完全没实现）。

**不修会怎样**：长跑（一夜、几千轮）后 `fail` 表无界增长；且"这格昨天失败过、今天好了"只能等内存 TTL，无法主动清除。

---

### N12 3D 扫描失败被 `walkTo` 完全吞掉，最终报成"没路"
`executor.js:905-914`

**这是什么**：`scanSphere` 内部 catch 到异常时返回 `{ cells:0, columns:0, ms, chunks:0, error: e.message }`（`terrain3d.js:414-417`，会先 ROLLBACK）。

**问题**：`walkTo` 只看 `if (s.cells)`——为 0 时连事件都不发，`s.error` 从不读取。随后 `plan3D` 拿到的是**上一轮的旧数据**（或空），于是报 `NO_PATH` / `NO_START` / `NO_DATA`（`executor.js:970-975`）。触发场景很具体：另一个进程（`.mca` 导入、`!map refresh`、另一个 bot 的进程共用同一个 `mapDir` 时）持有写锁，`busy_timeout = 3000`（`terrain3d.js:100`）超时 → `BEGIN`/`COMMIT` 抛错 → 扫描静默失败。上层和日志都会说"走不通"，而真实原因是"库写不进去"。

**最小修复**：`executor.js:907-913` 里改成
```js
const s = scanSphere(...);
if (s.error) { onEvent({ type:'scan3d-error', error:s.error }); lastErr='SCAN_FAIL'; }
```
并在 `:973` 把它映射成一个独立的码（`DB_BUSY`/`INTERNAL`），不要并进 `NO_PATH`。

**不修会怎样**：数据库层面的问题永远显示成导航问题，排查方向被引到错误的层（项目已经在 `executor.js:961-969` 花力气区分 `NO_START`/`BUDGET`，唯独漏了"扫描就失败了"这一种）。

---

### N13 每一步都重查库：单个 `walk` 步至少 2 次 SQLite 列查询，而本轮计划已经读过整个盒子
`executor.js:403`（`columnSurfaces(mapDir, step.x, step.z)`）、`executor.js:441`（`fallRisk`）→ `query_safe.js:211`（又一次 `columnSurfaces`）

**这是什么**：`execStep` 在落点检查里查一次 `columnSurfaces`（取落点类型），再调 `fallRisk` 又查一次同一列。`columnSurfaces` 是每次一条 SQL（`terrain3d.js:208` 的 `col` 语句）。

**问题**：`walkTo` 每轮已经通过 `plan3D`→`boxSurfaces` 把整个搜索盒（约 65×49 列）读进了内存（`path_3d.js:133-135`），却没有传给执行层；执行层反过来逐步回查数据库。一轮 10 步 = 20 次 SQL，`MAX_ROUNDS=120` 上限时单次 `walkTo` 可到 2400 次；同时每步还有 3~5 次 `bot.blockAt`（`executor.js:328`、`:556`、`:580`、`:619`、`:630`）+ 1 次 `inventory.items()`（`canDigWithInventory`，`executor.js:187`）。在"秒级节奏连续下指令"下这些查询与 N1/N14 的扫描叠加在同一个事件循环上。

**最小修复**：`walkTo` 把本轮 `plan3D` 用过的 `surf`（`path_3d.js:134` 的 Map）作为 `opts.surf` 传给 `execStep`，落点检查和 `fallRisk` 优先读它、读不到再回退 SQL。纯内存查表，改 3 个函数签名即可。

**不修会怎样**：每一步的开销和"这一轮扫了多少"无关、只和"走了几步"线性相关；想靠调小 `SCAN_R` 提速时，数据库这一半的损耗完全不降。

---

### N14 每轮无视移动距离整球重扫（半径 36 ≈ 19.5 万次方块读取），规划失败还再扫一遍
`executor.js:42`（`SCAN_R = 36`）、`executor.js:907`（每轮扫）、`executor.js:951`（失败时再扫一次）、`executor.js:993`（`MAX_STEPS = 10`）

**这是什么**：`walkTo` 的主循环是"扫球 → A* → 执行最多 10 步 → 再扫球"。扫描半径 36 的球体积 `4/3·π·36³ ≈ 19.5 万`格，全部逐格 `bot.blockAt`，外加 4072 条 `DELETE`。

**问题**：不管上一轮实际移动了 1 格还是 10 格，下一轮都重扫整个球——而她只可能看到新移动那几格带来的变化。规划失败时在同一轮里连扫两次（`:907` 和 `:951`），于是最坏情况一轮 39 万次方块读取。`docs/architecture/05_navigation.md:587-604` 设计的"分块扫描（只扫缺失区块）"和"路径缓存（`05_navigation.md:574-585`）"**都没有实现**——代码里既没有 pathCache 也没有增量扫描。按 `MAX_ROUNDS=120` 算，一次失败的 `walkTo` 上限约 `120 × 19.5万 ≈ 2300 万`次方块读取。

**最小修复**：分两步，先做最省事的一步——只在"她这一轮位置变化 ≥ 4 格"或"上一轮规划失败"时才重扫，否则复用上一轮的 `surf`（本轮移动 10 格以内的球心偏移，重叠率 70% 以上）。第二步再按 `05_navigation.md:587` 已写好的方案做"只扫新增环形区域"。

**不修会怎样**：导航的主要 CPU 时间花在重复读同一批方块上；地形越难、轮数越多，浪费越大，而扫得再勤也不会让路径更准（她的移动速度远慢于扫描频率）。

---

### N15 `skills.js` 与原子层存在大量"同一规则的第二份实现"，而它 98 个导出全部对模型可见
`skills.js:5173`（`isSafeHere`）、`skills.js:1007`（`breakBlockAt`）、`skills.js:1915`（`goToPosition`）、`skills.js:1734`（`goToGoal`）、`skills.js:800`（`collectBlock`）、`skills.js:2675`（`digDown`）、`skills.js:74`（`checkItems`）；暴露面：`index.js:36-40` → `skill_library.js:52-64` → `skill_library.js:182-185`

**这是什么**：`getSkillDocs()` 把 `skills.js` 的全部导出做成"技能目录"注入 prompt，并明说"These existing functions are the ones you may call"。

**问题**：这些函数和原子层是同一件事的两份实现，而且**已经出现了分叉**：
- `isSafeHere`（`skills.js:5173`）vs `query_safe.isSafe`（`query_safe.js:60`）：前者把敌对生物上限硬编码成 1（`skills.js:5229-5231` `getNearestEntityWhere` 只取一个），后者数全部（`query_safe.js:142-153`）；前者用 `mc.isHostile`（依赖 mcdata），后者用自己的 `HOSTILE` 白名单（`query_safe.js:38-44`，多了 `breeze`/`bogged`）。同一个"这里安不安全"问出两个答案。
- `breakBlockAt`（`skills.js:1007`）vs `act_dig.digBlock`：前者不查 `bot.interrupt_code`（`digBlock` 在 `act_dig.js:38` 查），且距离判据是 `4.5`（`skills.js:1034`）而 `digBlock` 用 `5.1`（`act_dig.js:36`）。
- `goToPosition` / `goToGoal`（`skills.js:1915/1734`）vs `nav_core.goTo`：前者直接用 `pathfinder.goto`（`skills.js:1628/1798/2186/2261`），**完全绕过 N2 的闸**。
- `collectBlock`（`skills.js:800`）、`digDown`（`skills.js:2675`）vs `flow_collect.collect` / `executor`：各自一套"走-挖-捡"循环。

grep 内部引用：`isSafeHere`、`goToGoal`、`checkItems`、`surveyInventory`、`putInChest`、`takeFromChest`、`fillAreaSafely` 在 `skills.js` 之外**零调用**——它们唯一的调用者是模型。（注意：**零内部调用 ≠ 死代码**，模型可以直接调，所以不能直接删；但正因为如此，"改一处忘了另一处"的风险是实打实的。）

**最小修复**：不动 goto 类（模型用得多），先做两件低成本的事：① `skills.isSafeHere` 改成 `return query_safe.isSafe(...)` 的薄包装（一行），把分叉消掉；② `skills.breakBlockAt` 改成先查 `bot.interrupt_code`、距离判据换成 `reachDistanceTo` 与 `digBlock` 同源。中长期：给 `skill_library` 加一层"这两个名字是同一件事，用新的"，把重复项逐步标 deprecated。

**不修会怎样**：模型按目录里的文档选函数，选到旧那份就得到不同的判据（安全判定更宽松、挖掘距离更保守、导航绕过互斥闸）；而且每次修原子层，旧复制品的分叉都会更深一层——这个项目已经因为"mode 列表三套""垫脚块四处"（`scaffold_blocks.js:1-14` 的注释记了同样的事）反复吃过这个苦。

---

### N16 `flow_collect_plan` 里"规划时刻的站位/顺序"被直接当成执行时刻的状态
`flow_collect_plan.js:126`（只在**规划时** `blockAt` 复核）、`flow_collect_plan.js:161-173`（`moveTo` 的 `standPos` 在规划时算好写死进 args）、`flow_collect_plan.js:203`（`planned++` 在规划时就记数）

**这是什么**：`planCollect` 一次规划最多 8 棵树 × 每棵 3~11 格，产出完整步骤序列后交给 `runSteps` 顺序执行（`flow_collect.js:192`）。每步 `moveTo` 有 8 秒上限、`digBlock` 有 8 秒上限，整串执行可以是几分钟。

**问题**：`standPos = stand.data.pos` 是规划那一刻算出的站位，被写死进 `args.target`（`:165`），几分钟后才执行；`blockAt` 的复核只发生在规划时（`:126`，注释"方块可能已经被前面的步骤挖掉了"——但那只防"规划前已挖掉"，防不了"执行时已变"）。`planned++`（`:203`）也在规划时就加，`estimated: planned`（`:236`）于是把"注定挖不到的格子"也算成产能，`flow_collect` 的 `MAX_ROUNDS=40` 兜底被提前触发的概率上升。同类问题本项目踩过并修过一次：`flow_pickup.js:83-96` 记着"把任务开始时的 `baseCount` 当当前基准 → 后续每次 collectDrops 都立刻判定成功"，改法是"每次调用自己快照"。这里缺同样的纪律。

**最小修复**：把 `moveTo` 的目标改成"执行时再算"，即在 `makeHandlers.moveTo` 里对 `args.pos` 先做一次 `findStandSpot` 复核（已有现成函数，一行调用），失败则返回 `NO_REACH` 让 `onFail` 走 `skipGroup`。另外 `planned++` 移到执行成功后再计（或直接把 `estimated` 的名字改成 `attempted`）。

**不修会怎样**：采集一轮里后面几棵树经常"站位早已失效"，白跑 8 秒 × N；产出预估偏高导致上层提前判断"够用了"，最终拿不到足量材料。实际影响幅度**需跑起来才能判定**，但机制与历史上踩过的那次同型。

---

## Nice to have

### N17 `plan3D` 每次调用都从 SQLite 重读整个搜索盒并重建字符串键 Map
`path_3d.js:133-135`

**这是什么**：`boxSurfaces(baseDir, x0, z0, x1, z1, yLo, yHi)` 每次把盒子内所有面取出来，再 `for (const r of rows) surf.set(key(r.x,r.y,r.z), r.t)` 建一个 `"x,y,z"` 字符串键的 Map。

**问题**：`walkTo` 一轮最多调 2 次 `plan3D`（`executor.js:938` 和 `:955`），盒子约 65×49 列 × 每列 1.8 面 ≈ 5700 行，两次就是约 1.1 万个字符串键的构造与丢弃。与其说慢，不如说它在 N14 的"整球扫描"旁边又多了一层重复读取——同一份数据本轮已经写过一遍。

**最小修复**：在 `walkTo` 里缓存上一次的 `{box 参数, surf Map}`，盒子参数不变就复用；或让 `plan3D` 接受外部传入的 `surf`。

**不修会怎样**：无正确性问题，只是每次规划的固定开销；修 N14 时顺手做掉最划算。

### N18 线性遍历整表 + `split(',')` 的三处（起点/终点吸附、无路时挑最远点）
`path_3d.js:182`、`path_3d.js:210`、`path_3d.js:607`

**这是什么**：三处 `for (const k of surf.keys())` 后紧跟 `k.split(',').map(Number)`。

**问题**：`surf` 通常 5700 条，每条约 10 字符、`split` 再分配一个 3 元素数组。`:182`（起点吸附）与 `:210`（终点吸附）几乎每次规划都会走（终点不在面上很常见，注释 `path_3d.js:194-200` 说这正是常态），`:607` 只在无路时走。没有 O(n²)，是常数因子问题。

**最小修复**：建 `surf` 时同时维护 `colMap: Map<"x,z", Array<{y,t}>>`，起点/终点吸附改成只查目标那一列（+邻列），O(1)~O(9) 而不是 O(5700)。

**不修会怎样**：每次规划多几千次字符串切分，单独看无所谓，但它是 `walkTo` 主循环里每轮必付的固定税。

---

## 附：任务里九个必答问题

1. **3D A* 的 open set 结构 / 重规划开销**：open set 是手写二叉堆（`path_3d.js:67-97`，用 `:245` 的 `new Heap()`），无 decrease-key，靠 `seen` Map + 惰性重复入堆（`path_3d.js:583-592`）。**A* 本身没有 O(n²)**。真正的开销不在 A*，而在它前后：每次调用 `plan3D` 都重读整个盒子（N17），每轮 `walkTo` 都整球重扫（N14），LLM 侧还能一次扫 r=64（N1）。开销随扫描半径按**体积** `r³` 增长：r=24 → 5.8 万格，r=36 → 19.5 万格，r=64 → 110 万格。
2. **重规划循环有没有节流**：有，三道——"连续 3 轮没动"（`executor.js:891` `stalled >= 3`）、"6 轮内回到 8 格内 ≥3 次"的振荡检测（`executor.js:838-868`，会 `recordFail` ×3 禁用上轮路径中段）、`MAX_ROUNDS=120`（`executor.js:65`）+ `deadlineMs`。**没有发现真正的死循环**。但轮内无任何节流（无 sleep、失败即刻再扫再算），而 N7/N8 两个"假成功"会把失败推迟到这几道闸才收场。
3. **只增不减的内存/列表，谁在清**：`recentPos` 自己截到 6 条（`executor.js:870`）；`lastPathKeys` 每轮整体替换（`executor.js:984`）；`trace_bus` 环形 400 条封顶（`trace_bus.js:16`、`:31`）；`surf` 表每次扫描按列先删后写（`terrain3d.js:305`）——但 N5 说明这个"清"会误删；**`fail` 表没有任何生产代码清理（N11）**；`DB_CACHE` 按设计进程内不关（`terrain3d.js:169` 已声明）。
4. **同一 bot 收到两条指令的重入**：有闸，但缺省 owner 都是 `'adhoc'` → 被当成重入直接放行（N2）；另有 12 处调用点根本不进闸（N3）。两条 flow 同时跑的实际后果 = 互相 `setGoal` 覆盖 → `dig`/移动大量 `INTERNAL The goal was changed`（`nav_core.js:92-100` 的真机记录）。
5. **错误吞掉**：最严重的是 `step_runner` 全失败仍 `ok`（N6，直接让 `skills.digTunnel` 向模型汇报假成功）；`executor.js:669-676` 吞掉补垫失败（N8）；`digdown` 不校验就 `ok`（N7）；扫描异常被 `walkTo` 吞掉并错报成 NO_PATH（N12）；`executor.js:456-459` 的落点检查 catch 只留痕不拦（这是有意的，注释在 `:457`）。
6. **边界**：空目标已处理（`flow_collect.js:60`、`collect_planner.js:31`、`step_runner.js:42-43`）。确认有问题的：水下/液体（`digdown` 遇液体 `break` 后仍报 ok，N7）、y 轴窗口边界（球顶造假面，N9）、多层列被压平（N10）、未加载区块（N5）。"只剩 1 个方块/脚下最后一块"的具体行为**需跑起来才能判定**——代码里 `stepUp` 会先挖掉自己脚踩的那格（`executor.js:700-705`），单格柱上是否因此坠落，我没能只靠读代码确认。坐标/朝向 off-by-one：`execStep` 已在 `:115` 统一做"面位 → 脚位"换算并有专门注释，未发现第二个地方重复做这件事。
7. **每步是否 N+1 查询**：是（N13）。单个 `walk` 步 = ≥2 次 `columnSurfaces` SQL + 3~5 次 `blockAt` + 1 次背包遍历；而本轮计划已经读过同一个盒子。
8. **`skills.js` 是否有同一规则的第二份实现**：有，且已经分叉（N15）。
9. **"建单时刻的快照当当前状态"**：找到 1 处同类（N16，`flow_collect_plan` 的站位与产能预估）。`collectDrops` 的那次历史事故已修（`flow_pickup.js:83-96`）。`landmarks.findItemInChests`（`landmarks.js:166`）明确注明 `contents` 可能过期、由调用方验证——这是已声明决策，不算发现。

---

## (c) 我没读的部分（不许假装读完）

- **`skills.js` 只精读了约 800 行**（`1000-1090`、`5130-5260`、`5402-5520`、`5690-5819`）。其余约 5000 行（熔炼、箱子/仓库、建造、蓝图/schematic、`liveAll`、`goToBed`、交易、`buildHouse`、`levelGround` 等）**没有逐行读**，只通过"导出清单 + 内部调用次数"判断它们的存在与重复关系。N15 的清单因此**不完整**——真实重复项可能更多。
- **21 个 `atom_*.js` 只读了 `atom_input_mouse`（片段）与 `atom_tunnel`（片段，经 grep 定位）；13 个 `act_*.js` 只读了 `act_dig`、`act_step`、`act_climb`（仅导入名）。** 其余原子未读，所以"原子层里是否还有 N2/N6 同型的假成功"**未能确认**。
- **`strat_obtain.js`（917 行）、`flow_mine.js`（495 行）、`strat_first_night.js`、`board_*.js`（属 t2 范围）完全没读**。`strat_obtain` 很可能藏着 N16 同型的快照问题。
- **`terrain3d.js` 与 `path_3d.js` 读全**；`terrain_view.js` 只读前 120 行（其余是纯渲染，不参与决策，`terrain_view.js:6` 自述）；`landmarks.js` 读全；`map_query.js` 读全；`bot_paths.js` / `nav_hop.js` / `nav_core.js` / `scaffold_blocks.js` / `tool_prep.js` / `collect_planner.js` / `step_runner.js` / `query_perceive.js` / `query_safe.js` / `query_stuck.js` / `query_classify.js` / `flow_collect.js` / `flow_collect_plan.js` / `flow_pickup.js` / `trace_bus.js` / `skill_library.js` / `index.js` 读全。
- **`docs/architecture/05_navigation.md` 只读了 §性能优化（555-604）与目录**；`02_actions.md`、`03_tasks.md` 未读（`03_tasks.md` 属 t2）。所以"代码是否违反已写下的规格"只核对到 §656 那条 `swim` 规格（`executor.js:388-400` 与 `path_3d.js:413-425` 一致，无发现）。
- **没有跑任何东西**。凡涉及"实际有多慢""频率多高"的数字，都是按代码结构推算的格数/条数，不是实测。标注了"需跑起来才能判定"的条目请当作待验证。

---

## (d) Lean

`Lean: -约 1000 行, -0 依赖 可能`

依据：`skills.js` 98 个导出里，与原子/复合层职责重复、且 `skills.js` 外零内部调用的至少 7 个（`isSafeHere`/`goToGoal`/`checkItems`/`surveyInventory`/`putInChest`/`takeFromChest`/`fillAreaSafely`），加上 `placeBlock`/`collectBlock`/`digDown`/`smeltItem`/`pickupNearbyItems`/`fillAreaSafely`/`buildHouse` 这一批的重复循环——粗估 800~1500 行。**但这些函数的唯一调用者是模型，grep 看不见，所以"零内部调用"不等于可删**；真要删必须同步改 `skill_library` 的目录与文档，属于产品决策而非纯清理。依赖数不减（`skills.js` 的 import 基本被留下的函数共用）。**新增零依赖：本报告所有修复都是就地改，不需要引入新库。**
