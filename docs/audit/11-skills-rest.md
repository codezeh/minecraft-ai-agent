# 深读④：skills.js 剩余区间 + 15 个 act_* + strat_obtain

**本轮读完全部剩余行区间：是**

- `skills.js` **1-5819 全部读完**（本轮补读 t9 申报的空白：1321-1412、1563-1902、1903-2252、2253-2602、2603-2952、2953-3302、3303-3652、3653-3952、4104-4453、4454-4783、4784-5133、5134-5433、5434-5693）。
- `act_*.js` **15/15 全部读完**（本轮补：act_attack/act_blockuse/act_climb/act_container/act_craft/act_entity/act_farm/act_fish/act_pillar/act_place/act_rest/act_swim；t9 已读 act_dig/act_step/act_items）。
- `strat_obtain.js` **917 行全部读完**（t9 只读 95 行）。
未改任何源码。下表中每个行号都是实际读到的行。

## 0. 覆盖表

| 文件 | 行数 | 状态 |
|---|---:|---|
| `src/agent/library/skills.js` | 5819 | **已全文读**（t9 2400 + 本轮 3419，无缺口） |
| `act_attack.js` | 267 | **已全文读** |
| `act_blockuse.js` | 178 | **已全文读** |
| `act_climb.js` | 295 | **已全文读** |
| `act_container.js` | 467 | **已全文读** |
| `act_craft.js` | 581 | **已全文读** |
| `act_dig.js` | 256 | **已全文读**（t9 + 本轮） |
| `act_entity.js` | 138 | **已全文读** |
| `act_farm.js` | 193 | **已全文读** |
| `act_fish.js` | 77 | **已全文读** |
| `act_items.js` | 140 | **已全文读**（t9） |
| `act_pillar.js` | 129 | **已全文读** |
| `act_place.js` | 203 | **已全文读** |
| `act_rest.js` | 102 | **已全文读** |
| `act_step.js` | 148 | **已全文读**（t9） |
| `act_swim.js` | 115 | **已全文读** |
| `strat_obtain.js` | 917 | **已全文读** |

---

## 1. 一句话结论：**原子/动作层是干净的，脏的全在 skills.js**

我按同一组四个问题把 15 个 act 逐一过了一遍：

| 问题 | 结果 |
|---|---|
| ① 入口查不查 `interrupt_code`？ | **15/15 都查**（各文件函数首行；`act_pillar` 还在起跳轮询里每 25ms 再查一次 `:82`） |
| ② 返回值是"正向验证"还是"乐观返回"？ | **14/15 正向验证**（读回方块/血量/库存增量/窗口计数）；唯一弱一点的是 `act_entity.tradeOnce:128-137`（`win.trade` 不抛就 ok，没有核对交易前后货量） |
| ③ 有没有 import 不存在的标识符？ | **0/15**。全部 `import { ok, fail[, normalizeTarget] } from './contract.js'` 且都真用到 |
| ④ 失败码是否封闭？ | **15/15 都在 CODES 内**（NO_TARGET/NO_DATA/NO_ITEM/NO_TOOL/OCCUPIED/BLOCKED/NOT_READY/OUT_OF_REACH/NO_SUPPORT/TIMEOUT/INTERRUPTED/INTERNAL/BLOCKED/WINDOW_CLOSED/INVENTORY_FULL/NO_RECIPE/NO_WORKSTATION/STUCK/NOT_CLIMBABLE/DIG_FAIL） |

**所以本轮所有 Must/Should 新发现都在 `skills.js`** —— 这本身就是一个结论：**分层规矩在原子层守住了，在它上面那层（模型直接看到的那层）没有。**

---

## 2. 四个族逐族的"恒假判断 / 乐观返回 / 绕白名单 / 无保护破坏"

### 2.1 熔炉族（放炉/点火/进料/等待/取货/清理）

| 类型 | 位置 | 说明 |
|---|---|---|
| **恒假判断** | `skills.js:571` | `const walk = await goToBlockBounded(...)` 返回**对象**（`:347-353`），`if (!walk)` 恒假 → "熔炉走不到就自己放一个"的兜底整段（`:571-586`）是死代码。**应为 `if (!walk.ok)`**。（= t9 的 D11，本轮确认全文无第二处同类，但这是唯一一处） |
| **覆盖别人的料** | `skills.js:478` | `furnace.putInput(...)` **无条件执行**，前面只判了燃料（`:458`）。熔炉里已有别人的矿时会把料压进去。对照 `act_craft.furnaceBusyWith:451-472` + `:519-525` 的 `OCCUPIED` 保护（注释 `:510-518` 写明"这条一度被我丢了……会往别人正在烧的熔炉里塞自己的料"）。**修好的那份在 act_craft，没修的那份挂在 skills 上给模型用。** |
| 乐观返回 | `skills.js:645-654` | `smeltItem` 用 `total`（取到的产物数）判成功 —— 这个是对的（正向）。但 `total < num` 时返回 false 且**已经关窗、炉子留在原地**，上层重试会重新 `loadFurnace`（不检查输入槽）→ 叠料。 |
| 无保护破坏 | — | 熔炉族不破坏方块（`clearNearestFurnace:657` 只取内容）。**但 `:681-684` 会 `takeInput/takeFuel` 拿走别人正在炼的料** —— 见越权表。 |

### 2.2 战斗族

| 类型 | 位置 | 说明 |
|---|---|---|
| **会打到玩家**（Must） | `skills.js:695-714`（`attackNearest`）、`:716-751`（`attackEntity`） | 直接 `bot.pvp.attack(entity)`（`:738`），**没有任何 `isAttackable` 检查**。`attackNearest` 用 `world.getNearbyEntities(...).find(e => e.name === mobType)` —— 玩家实体的 `name` 就是用户名，所以 `skills.attackNearest(bot, '<玩家名>')` **会真的打玩家**。对照 `act_attack.isAttackable:40-48` + `NOT_ATTACKABLE_TYPES`（`:31-35` 第一项就是 `'player'`）—— **保护只在原子层，模型走 skills 就绕过了**。 |
| 乐观返回 | `skills.js:790-795` | `defendSelf` 的 `attacked` 只表示"挥过"，不保证打死。返回值语义尚可（`return attacked`）。 |
| 无 interrupt | `skills.js:739-746` | `while (world.getNearbyEntities(...).includes(entity))` 里查了 `bot.interrupt_code`（`:741`）✓ —— 这条是对的。 |
| 目标选择 | `skills.js:706-707` | 打 `drowned`/鱼时 `modesPause('self_preservation')` —— 关掉保命反射去水下打怪。这是有意的（注释写了 TODO），但它是**模型可触发的"关掉自己保命"**路径之一。 |

### 2.3 建造族

| 类型 | 位置 | 说明 |
|---|---|---|
| **绕白名单（第 2 处）** | `skills.js:1026-1031` | `breakBlockAt` 的 cheat 分支自己拼 `'/setblock x y z air'` 然后 **`bot.chat(msg)` 直发**（`:1029`）。这绕过 `atom_input_misc.command()` 的 `slashVerdict` 白名单，而且 preflight 的 `slash-command-owner` 正则（要求行内有字面量 `/`）**看不见**。t9 只找到 `:4000` 一处，**本轮找到第二处**（详见 D16）。 |
| **无保护破坏** | `skills.js:1007-1078` | `breakBlockAt` 对任何方块都挖，**没有 `wmIsPlayerBuilt` 检查**、**没有 `interrupt_code` 检查**。而同一文件的 `placeBlock:1190-1195` 有这道闸（注释："这是历史上把一整片 5x5x4 木板结构拆光的根源"）。对照 `act_place.placeBlockAt:102-104`：目标被占就 `OCCUPIED` 拒绝，**绝不拆**。所以"不破坏玩家建筑"这条规矩：`placeBlock` 有、`act_place` 有、`breakBlockAt` **没有**（它就是那个"破坏"入口）。 |
| **凭空造方块**（Should） | `skills.js:3414-3436` | `levelGround` 在 `size>=5` 时走 `/fill` 快路径：对 ~88 个方块名各发一条 `fill ... air replace <name>`（`:3419-3424`），再一条 `fill ... <filler> keep`（`:3433`）。**`/fill` 不消耗材料** → 模型可以无成本生成 50×50×20 的土块，也可以无成本清掉整片地形。`filler` 只用来"挑个名字"（`:3426-3429`），不检查背包。 |
| **"自然方块"清单把玩家农田算成自然**（Must） | `skills.js:3359-3388` | `NATURAL_BLOCKS` 里含 **`farmland`**（`:3361`）、`moss_block`、`snow_layer` 类。`farmland` **只能由玩家用锄头造出来**（`act_farm.tillSoil:167` 就是干这个的），所以"只拆天然地形、绝不碰玩家建筑"这条声明在农田上不成立：`levelGround` 会把玩家的整片农田当"自然地形"填平。 |
| 乐观返回 | `skills.js:4913` | `buildStorageRoom` 的 `ok = floorN > 0 && wallN > 0 && ceilN > 0` —— **1 块地板 + 1 块墙 + 1 块顶**就算"房间建好了"，随后 `fillRoomWithChests` 会在这个"房间"里摆箱子。 |
| 好的部分 | `skills.js:2871-2925`、`:5546-5580` | `placeBlockWithoutBreaking` 只往 `BUILD_REPLACEABLE` 里放、放完回读校验（`:2923-2924`）；`fillAreaSafely:3210`、`buildHouse:3572`、`buildStorageRoom:4862/4874/4890` 都查了 `interrupt_code`。这几处是全文件里最好的。 |

### 2.4 仓储族

| 类型 | 位置 | 说明 |
|---|---|---|
| **意图即成功（3 处同族）** | `skills.js:1437`（`putInChest`）、`:1486-1492`（`takeFromChest`）、`:4208-4210`（`storeItem`）、`:3094`（`stashUnneeded`） | 全部直接 `container.deposit/withdraw` 后按**打算搬多少**计数，不核对背包/容器增量。`takeFromChest` 最典型：`totalTaken += toTakeFromSlot` 后 `return totalTaken > 0` —— 窗口中途关掉（玩家按 `!stop`，或走远 >10 格被服务端静默关窗，`checkWindow` 的注释 `:366` 自己写着这个现象）也返回 true。对照 `act_container.deposit:369-404`/`withdraw:434-466`：**读 `invBefore/winBefore` → 等 `waitCountsSettled` → 比对 `invAfter/winAfter`**，三个历史 bug（`.type` 恒 null、`win.slots` 混入背包、计数未落定）都在注释里记着。**同一个需求，一边有验证一边没有。** |
| 窗口未开就操作 | `skills.js:1430-1437` | `putInChest` 只在 `openKnownChest` 返回 null 时退出；返回后**不再 `checkWindow`** 就直接 deposit。`storeItem:4198` 和 `verifyChest:5106` 反而查了 —— 同一文件内三套标准。 |
| 跨 bot 抢同一箱子 | `skills.js:4171-4217` | `storeItem` 按分类遍历 `chestsByCategory`，第一个满了换下一个；**没有预约/互斥**（板库有 `block:` claim 机制，但 skills 这条路径不声明 claim）→ 两个 bot 同时 `storeItem` 同一个分类会并发写同一个箱子（与 t2 报告 B11 的读改写丢更新叠加）。 |
| 好的部分 | `skills.js:5060-5130` | `verifyChest` 是"读实物 + 修正记录"的正向实现（`:5111` 读 `summarizeContainer`，`:5120` 比对旧记录）。 |

---

## 3. §2 差异总表（零个未核实项）

上一轮标"待核实"的 30 余条现已**全部核实完毕**，本表不再有任何推断条目。最终数字（可站住的口径）：

| 分类 | 条数 | 说明 |
|---|---:|---|
| `skills.js` 导出总数 | **98** | `grep -n "^export \(async \)\?function"` 实数 |
| **真转发 / 薄包装** | **10** | `craftRecipe`→craftOnce、`smeltItem`→furnaceLoad+Collect、`consume`→act_items.eat、`followEntity`→flow_follow、`scanTreeAt`/`planTreeChop`→query_tree、`planRoute`→plan3D、`digTunnel`→atom_tunnel、`climbLadder`→act_climb、`canClimbHere`→act_climb |
| **有原子/动作层对应物、但是独立实现** | **33** | 见下表 12 条"答案不同" + 21 条"答案相同/差异无害" |
| **无对应物（唯一实现）** | **55** | 仓储 11 + 仓储建造 5 + 建造 7 + 蓝图 3 + `stay`/`goToSurface`/`giveToPlayer`/`surveyInventory`/`reportStatus`/`makeRoomForBot`/`findFlatBuildingSpot`/`findBuildingSite`/`prepareBuildingSite`/`checkLoadout`/`planMaterials`/`guardInventory`/`markDanger`/`recordTaskProgress`/`resumeTask`/`clearTask`/`resetHazardCache`/`surveyArea`/`furnaceStatus`/`waitForSmelt`/`takeFromFurnace`/`ensureNearbyBlock`/`checkItems`/`log`/`facingName`/`modesIsOn`/`modesPause`/`modesUnpause`/`checkWindow`/`collectBlock`/`defendSelf`/`pickupNearbyItems`/`goToGoal`/`goToPosition`/`goToNearestBlock`/`goToNearestEntity`/`goToPlayer`/`moveAway`/`moveAwayFromEntity`/`avoidEnemies`/`useDoor`/`goToBed`/`tillAndSow`/`activateNearestBlock`/`showVillagerTrades`/`digDown`/`useToolOn`/`placeBlockWithoutBreaking`/`prepareForBuilding`/`fillAreaSafely`/`buildHouse`/`levelGround`/`findItemInStorage`/`tidyInventory`/`listStorage`/`equip`/`discard`/`putInChest`/`takeFromChest`/`viewChest`/`attackNearest`/`attackEntity`/`breakBlockAt`/`placeBlock`/`isSafeHere`/`recordTaskProgress`…（按"是否有同名同义的原子/动作"判） |
| **★ 同一规则给出不同答案（已逐行核实）** | **12** | 全部列在下表 |

**12 条"答案真的不同"**（这是最终能站住的数；第一轮说 3、t9 说 7、本轮核实到 12）：

| # | skills.js | 对应原子/动作 | 差异（哪边对） |
|---|---|---|---|
| 1 | `waitUntil:39-67` | `atom_wait.waitUntil:38-74` | **`false` 语义相反**：skills 只有 `predicate()` 为真才算成立（`:59`）；atom 把 `false` 当**完成**（`:67`），且 atom 文件头 `:10-12` 明写"把 false 当还没完成"是被修掉的 bug。**atom 对**；模型拿到的是错的那份（`always_show_skills` 白名单里，`skill_library.js:43`） |
| 2 | `loadFurnace:439-481` | `act_craft.furnaceLoad:483-538` | skills 版 `putInput` 无条件（`:478`）；atom 版 `furnaceBusyWith` → `OCCUPIED`（`:519-525`）。**atom 对** |
| 3 | `breakBlockAt:1007-1078` | `act_dig.digBlock:30-145` | skills 无 `interrupt_code`、距离 `4.5`（`:1034`）vs `5.1`（`act_dig:36`）、无建筑保护、cheat 分支 `bot.chat` 直发（`:1029`）。**atom 对** |
| 4 | `equip:1285-1331` | `act_items.equip:50-73` | skills 无中断检查、无槽白名单、无读回验证；atom 三样都有（`:51/52/64-72`）。**atom 对** |
| 5 | `takeFromChest:1449-1493` | `act_container.withdraw:416-467` | skills 按意图计数（`:1486`）；atom 按 `winBefore-winAfter` 实测（`:451`）+ settle 等待。**atom 对** |
| 6 | `putInChest:1413-1447` | `act_container.deposit:351-405` | skills 无窗口校验、无增量核对；atom 两道都有。**atom 对** |
| 7 | `canReach:1911-1913` | `query_perceive.canReach:73-81` | 默认阈值 **4.3 vs 5.1**。5.1 有实测依据（`act_dig:31-35`），4.3 无依据。**atom 更对** |
| 8 | `isSafeHere:5173-5240` | `query_safe.isSafe:60-170` | 敌对生物上限硬编码 1（`:5228-5231`）vs 全数（`query_safe:142-153`）；`mc.isHostile` vs 自带 `HOSTILE` 集（多 `breeze`/`bogged`）。**atom 对** |
| 9 | `attackNearest:695-714` | `act_attack.nearestAttackable:156-162` | skills **不排除玩家**；atom 的 `isAttackable` 明确排除 `'player'`（`:31-35`）。**atom 对（安全）** |
| 10 | `attackEntity:716-751` | `act_attack.attackEntity:58-137` | skills 无 `isAttackable`、无距离前置、无后置校验；atom 三样都有。**atom 对（安全）** |
| 11 | `placeBlock:1082-1283` | `act_place.placeBlockAt:47-203` | skills **先拆后放**（`:1181-1204`，只挡玩家建筑）；atom 目标被占直接 `OCCUPIED`、**绝不拆**（`:102-104`）。**atom 更安全** |
| 12 | `goToBed:2312-2342` | `act_rest.sleepInBed:44-82` | skills 不判"白天睡不了"（`:2334` 直接 `bot.sleep`，白天会抛）；atom 有 `isNightOrStorm` 前置（`:62-64`）+ 后置读 `bot.isSleeping`（`:78`）。**atom 对** |

**另 21 条"有对应物但答案相同/差异无害"**（不再逐个列表，只记结论）：`ensureNearbyBlock`、`wait`、`checkWindow`、`takeFromFurnace`、`waitForSmelt`、`discard`、`viewChest`、`goToGoal`、`goToPosition`、`eyePosition`、`reachDistanceTo`、`moveAway`、`useDoor`、`tillAndSow`、`tradeWithVillager`、`activateNearestBlock`、`digDown`、`useToolOn`、`surveyInventory`、`collectBlock`、`pickupNearbyItems` —— 它们与原子层**确实各有一份**（所以计入"33"），但差异属"剂量/覆盖范围"，不是"同一输入给出相反答案"。

---

## 4. 新发现（D13 起，接续 t9）

## Must fix

### D13 `giveToPlayer` 的 `if (got)` 恒为真 —— 物品已经扔到地上，玩家没捡也报成功
`skills.js:1598-1615`

**这是什么**：把物品丢到玩家脚下的函数，模型可见。

**问题**：`:1609` `const got = await waitUntil(bot, () => given, {...})` —— `skills.waitUntil` 返回的是**对象** `{ok, waitedMs, reason, label}`（`:60`），恒真。`:1611` `if (got) return true;` 于是**永远走这一支**：哪怕 3 秒内玩家一次都没捡（`given` 一直是 false，返回 `{ok:false, reason:'timeout'}`），函数也返回 true。而 `:1598` 的 `discard(...)` **已经把物品 `bot.toss` 到地上了** —— 玩家没接住，物品就躺在那里等 5 分钟消失。
触发：`skills.giveToPlayer(bot,'diamond','某人',5)`，玩家 AFK → 5 颗钻石掉地上 → 返回 `true` → 模型以为交付成功。

**最小修复**：`:1611` 改成 `if (got && got.ok) return true;`（一个 `.ok`）。顺手把 `:1598` 的顺序改成"先确认玩家在附近能接住再丢"，或改成 `bot.toss` 后等 `playerCollect` 再放行。

**不修会怎样**：交付类任务（"把材料给玩家"）会**吞掉玩家的东西并谎报成功**，且没有任何日志能看出没送到 —— 物品是真的消失了。

### D14 `skills.attackNearest` / `attackEntity` 能攻击玩家（原子层挡，模型层不挡）
`skills.js:695-714`、`skills.js:716-751`

**这是什么**：两个模型可见的攻击入口。`act_attack` 里有一整套"什么不该打"的判定（`isAttackable:40-48`，`NOT_ATTACKABLE_TYPES` 第一项就是 `'player'`，`:31-35`）。

**问题**：skills 这两条**都不调 `isAttackable`**，`:738` 直接 `bot.pvp.attack(entity)`。而 `attackNearest` 的目标筛选是 `find(entity => entity.name === mobType)`（`:708`）—— 玩家的 `entity.name` 就是用户名。所以模型（或一次幻觉把玩家名当成生物名）写出 `skills.attackNearest(bot, '某个玩家名')` 就会**真的 PVP 打人**，用的还是 op 账号。
反面证据：`act_attack` 的注释 `:27-30` 专门解释"僵尸是 'hostile' 不是 'mob'"，`NOT_ATTACKABLE_TYPES` 里 `'player'` 排第一 —— 说明作者**明确知道**要挡玩家，只是没挡在 skills 这条路上。

**最小修复**：`skills.attackNearest` 在 `find` 之前加 `act_attack.isAttackable`（导出即可）；`skills.attackEntity` 开头加 `if (!isAttackable(entity)) return false;`（两行）。

**不修会怎样**：op bot 打玩家是不可逆的社交事故，而安全判定明明已经写好了、只是没接到模型能走的那条路上。

### D15 `useToolOn` 的守卫 `!bot.game.gameMode === 'creative'` 恒假 —— "没有工具"检查从来没生效
`skills.js:2760`

**这是什么**：`useToolOn(bot, toolName, targetName)` 开头检查"有没有这个工具"。

**问题**：`if (!bot.inventory.slots.find(...) && !bot.game.gameMode === 'creative')` —— `!` 绑定比 `===` 紧，所以后半是 `(!gameMode) === 'creative'`。`gameMode` 是 `'survival'`/`'creative'`（非空字符串，恒真）→ `!gameMode` 恒 `false` → `false === 'creative'` 恒 **false** → 整个条件恒 false，**"You do not have any X to use" 这条早退永远不执行**。于是没工具也照常往下走，`equip` 失败后才失败（`act_items.equip` 会返回 NO_ITEM）。
两个后果：① 那句本意是"提前拦住、省一次失败"的话白写；② 真机日志里会看到 "Could not equip X" 而不是清晰的 "you don't have any X"。

**最小修复**：改成 `if (!bot.inventory.slots.find(...) && bot.game.gameMode !== 'creative')`（把 `!` 挪到比较右边，一个字符）。

**不修会怎样**：同类"恒假守卫"在本文件里已出现 2 次（`:571` 的 `if (!walk)`、`:2760` 这条），说明这是**同一类错误在同一个文件里的复发**，不修会继续长第 3 个。

### D16 `breakBlockAt` 的 cheat 分支也在直发 `/setblock` —— 命令白名单被绕过的第 2 处
`skills.js:1026-1031`

**这是什么**：`breakBlockAt` 在 cheat 模式下不挖，而是发一条 `/setblock <x> <y> <z> air`。

**问题**：`:1029` 是 **`bot.chat(msg)` 裸调**，而 `msg` 是 `:1028` 用字符串拼出来的变量。两点：
1. 绕过 `atom_input_misc.command()` —— 那里有 `slashVerdict` 白名单 + `cheat`/`level` 两层判定（`atom_input_misc.js:63-78`），而这里是裸 `bot.chat`。
2. preflight 的 `slash-command-owner` 正则要求**同一行有字面量 `/`**，`bot.chat(msg)` 不匹配 → **门禁看不见**。
t9 只找到 `buildFromSchematic:4000`，本轮找到**第二处**（`:1029`）。同文件还有 4 处**正确**的写法（`command(bot,'setblock',...)` 在 `:1144/1147/1150/4714/4741`）—— 说明作者知道该走 `command()`，这两处是漏的。

**最小修复**：`:1026-1031` 改成 `await command(bot, 'setblock', [x, y, z, 'air'], { cheat: true })`（与 `:1144` 同一写法）。

**不修会怎样**：命令白名单这条安全不变量在生产里有 **2 个常开后门**；任何"内容 → 命令"的注入都能从这两处过。

### D17 `levelGround` 把玩家的农田当"自然地形"填平，并且用 `/fill` 凭空造方块
`skills.js:3359-3388`（`NATURAL_BLOCKS`）、`:3414-3436`（`/fill` 快路径）

**这是什么**：`levelGround(bot, x0, z0, size, targetY)` 把一片地方铲平，模型可见、参数（含 `size`）由模型给。`size>=5` 时走 `/fill` 快路径。

**问题（两件独立的事）**：
1. **`NATURAL_BLOCKS` 含 `farmland`**（`:3361`）、`moss_block`、`moss_carpet`、`snow`。`farmland` 只能由玩家用锄头造（`act_farm.tillSoil:167` 干的就是这个）→ 函数注释 `:3396` 承诺的"只替换自然材料，玩家建筑不会被碰"**在农田上不成立**。玩家一整片麦田会被 `/fill ... air replace farmland` 清成空气。
2. **`/fill` 不消耗材料**：`:3433` `fill ... <filler> keep` 会在坑里凭空生成方块，而 `filler` 只是从背包"挑个名字"（`:3426-3429`），**不检查有几个**。所以模型可以无成本造出 50×50×20 的土方块，也可以无成本抹平任何地形 —— 这绕过了"有材料才能建"这个基本约束。

**最小修复**：① 从 `NATURAL_BLOCKS` 删掉 `farmland`（以及 `moss_block`/`moss_carpet` 这类玩家可放置的装饰块）；② `/fill` 的 filler 分支加一条前置：`countInventoryItem(bot, fillerName) >= 需要填的格数`，不够就只做"削高"（air replace）不做"填低"。

**不修会怎样**：玩家农场会被"铲平"；而"凭空造方块"让模型能用一条命令生成任意体量的人造地形（这也是 t9 越权表第 3 条"大范围改地形"的最强形态）。

## Should fix

### D18 `goToGoal` 全程不看 `interrupt_code` —— 最长 180 秒不可中断
`skills.js:1734-1815`（另有 `useDoor:2263`、`goToBed:2337`）

**这是什么**：`goToGoal` 是所有 `skills.goTo*` 的底层，内部 `Promise.race(bot.pathfinder.goto(goal), 180s 硬超时)`（`:1794-1805`）。

**问题**：整个函数（含两条 `getPathTo`，各 1000ms 预算，`:1753/1760`）**没有任何 `bot.interrupt_code` 检查**。玩家按 `!stop` 后，这条路最长要等 **180 秒**（`GOTO_HARD_LIMIT_MS`，`:1794`）才返回，而且返回的还是"超时"而不是"被取消"。
同族还有两处：
- `useDoor:2263-2265`：`while (bot.pathfinder.isMoving()) await sleep(100)` —— **无超时、无中断**，pathfinder 若卡在"重置路径-重试"就永远转。
- `goToBed:2337-2339`：`while (bot.isSleeping) await sleep(500)` —— 睡到天亮，**无中断**，最长一整夜。

（对照：`skills.stay:2226` 的 while 条件里就有 `!bot.interrupt_code`，`wait:301` 也有 —— 说明这个模式在本文件里是**有的地方写、有的地方忘**。）

**最小修复**：`goToGoal` 的 race 里加第三支 `interruptPoll`（每 200ms 查 `bot.interrupt_code`，命中就 `pathfinder.stop()` 并 reject 成 INTERRUPTED）；`useDoor`/`goToBed` 的两个 while 各加 `&& !bot.interrupt_code`。

**不修会怎样**：这就是"玩家按了停、机器人还在走/还在睡"的那类体感事故；与 t10 发现的 `follow` 超时参数没接上（`composite_registry.js:78` vs `flow_follow.js:87`）合起来看，**长动作的"停不下来"有三处**（follow / goToGoal / goToBed），而不是零处。

### D19 四个 `goTo*`/`moveAway*` 忽略返回值、恒 `return true`
`skills.js:2003-2004`（`goToNearestBlock`）、`:2023-2024`（`goToNearestEntity`）、`:2167-2168`（`moveAwayFromEntity`）、`:2198`（`avoidEnemies`）

**这是什么**：这四个都调用了会返回 boolean/ActionResult 的底层（`goToPosition`/`gotoWithTimeout`），然后**丢掉返回值**。

**问题**：`await goToPosition(...); return true;` —— 走没走到都返回 true。模型据此认为"我已经到了那棵树旁边/那个村民旁边"，然后下一步 `digBlock`/`openVillager` 因为够不着而失败，**失败点离真因很远**。
对照：`recoverDeathItems:3866` 是**正确**写法（`if (!walk) return {ok:false, reason:'unreachable'}`）—— 同一文件里两种写法并存。

**最小修复**：四处都改成 `return await goToPosition(...)`（`goToPosition` 本身返回 boolean，见 `:1957/1960`）；`moveAwayFromEntity` 改成 `return await gotoWithTimeout(...)`。

**不修会怎样**：任何"先走过去再交互"的技能组合在走不到时都会在**第二步**报一个误导性的错误（够不着/没找到），上层无法判断该重走还是该换目标。

### D20 `tillAndSow` 在 cheat 模式下 `seedType=null` 直接抛 TypeError（且两次 placeBlock 未 await）
`skills.js:2361-2371`

**这是什么**：`tillAndSow(bot, x, y, z, seedType=null)` —— `seedType` 的**默认值就是 null**，而 JSDoc 明说"默认为空就只耕地"。

**问题**：cheat 分支 `:2362-2367`：
```js
let to_remove = ['_seed', '_seeds'];
for (let remove of to_remove) {
    if (seedType.endsWith(remove)) { ... }   // seedType 是 null → TypeError
}
```
所以 `skills.tillAndSow(bot,x,y,z)`（不传 seed）在 cheat 模式下**必抛 `Cannot read properties of null`**。这正好是文档承诺支持的那个用法。
附带：`:2368-2369` 两个 `placeBlock(...)` **没有 await**（浮空 promise，属 t4 那 39 条之一），所以"放 farmland / 放种子"的成败完全不知道，函数直接 `return true`。

**最小修复**：`if (seedType)` 包住 `:2362-2367`；`:2368-2369` 加 `await` 并检查返回。

**不修会怎样**：最常用的调用形态（只耕地不播种）在 cheat 模式（`goToPosition:1933` 等大量技能都依赖它）下必崩，且崩在 `null.endsWith` 这种与农业无关的地方。

### D21 `collectHazardsCached` 是死代码 —— 缓存永远不填，`resetHazardCache` 空转
`skills.js:5338-5339`（`hazardScanCache`/`HAZARD_SCAN_TTL_MS`）、`:5358-5391`（`collectHazardsCached`）、`:5341-5343`（`resetHazardCache`）

**这是什么**：一套"危险方块枚举结果缓存"，带 TTL 合并（`mergeHazardBlobs`）、按 bot+8 格取整做 key、超过 32 条淘汰最旧（`:5379-5382`）。

**问题**：`grep -rn "collectHazardsCached" src/ tools/` → **只有定义处 1 处命中，零调用方**。所以 `hazardScanCache` 永远是空的，而导出的 `resetHazardCache()`（`:5341`）清的就是这个空 Map —— **`!forgetHazards` 这类调用是纯空转**。
真正在做安全检查的 `isSafeHere:5218` 走的是 `wmCollectHazards(bot,{radius:8})`，**每次都重新枚举**（`collectHazards` 64 格 183ms，注释 `:5330` 自己写着成本）。

**最小修复**：`isSafeHere:5218` 改成 `collectHazardsCached(bot, {radius:8})`（一行）；或直接删掉 `collectHazardsCached`+`hazardScanCache`+`HAZARD_SCAN_TTL_MS`（34 行）并把 `resetHazardCache` 也删掉。**二选一，不要留一个"看起来有缓存"的死实现。**

**不修会怎样**：读代码的人会以为危险枚举有缓存（连带以为 `resetHazardCache` 有作用），而实际每次安全检查都付 183ms；且这套代码是"写了没接上"的第 7 个实例（见 t9 的根因归类 B）。

### D22 `storeItem` / `stashUnneeded` 同属"意图即成功"（D4 的第 3、4 处）
`skills.js:4208-4210`（`storeItem`）、`:3094-3096`（`stashUnneeded`）

**这是什么**：往分类箱存东西（`storeItem`）与"腾格子时把不用的存进去"（`stashUnneeded`）。

**问题**：`storeItem:4208` `await container.deposit(item.type, null, put); remaining -= put; storedTotal += put;` —— `deposit` 不抛错就认为搬成功，**不核对背包/箱子增量**。容器满、或服务端吞包时，`stored` 虚高。`stashUnneeded:3094` 同理（`deposit` 后 `stashed.push`，`catch` 只跳过单件）。
后果链：`storeItem` 谎报 → `tidyInventory:4313` 按 `r.stored` 累加 `moved` → `guardInventory:4577` 用**真实** `emptySlotCount()` 复检 → 于是"报存了但格子没腾出来" → `guardInventory` 返回 `still_short`。**好在最后一层用了真值，所以不会静默；但中间层的数字是假的。**

**最小修复**：`storeItem` 里 `deposit` 前后各取一次 `countInventoryItem(bot, itemName)`，`stored = before - after`（3 行）。`stashUnneeded` 同样。

**不修会怎样**：与 D4 同族 —— 仓储链上的数字不可信，排查时"存了多少"永远对不上账。

### D23 `digDown` 读不到方块时 `return true`（"挖到底了" vs "根本没读到"）
`skills.js:2689-2692`

**这是什么**：向下挖 N 格，模型可见。

**问题**：`if (!targetBlock || !belowBlock) { log('reached the end of the world'); return true; }` —— `bot.blockAt` 返回 null 的真实含义是**那个区块没加载**（`act_place:59-70` 的注释专门讲过这件事，并为此把码从 `NO_TARGET` 改成 `NO_DATA`）。在未加载区域 `digDown(bot,10)` 会挖 0 格却 **`return true`**，日志说"到世界尽头了"。
另外 `:2684` `bot.blockAt(bot.entity.position).position` —— `blockAt` 返回 null 时直接 `.position` 会抛（脚下未加载）。

**最小修复**：`:2691` 改成 `return false`（并说明"脚下区块未加载"）；`:2684` 加 null 检查。

**不修会怎样**："往下挖 10 格"在新区块边缘变成"什么都没做但报成功"，上层继续下一步才发现高度不对。

## Nice to have

### D24 `buildStorageRoom` 的成功判据过弱：1 块地板 + 1 块墙 + 1 块顶就算"房间建好"
`skills.js:4913`

**问题**：`const ok = floorN > 0 && wallN > 0 && ceilN > 0;`。而一个正常仓库是 `9×9` 地板（81 块）+ 四面墙（`3×32`）+ `81` 块顶。只要各放下 1 块就从 `INCOMPLETE` 变 `OK`，随后 `fillRoomWithChests:4947` 用硬编码的 `x0+4, CHEST_Y-1, z0+4` 去"验证房间存在"（只探 1 格地板 + 1 格墙），也照样通过。
**最小修复**：`ok = floorN >= OUT*OUT*0.8 && wallN >= 8 && ceilN >= OUT*OUT*0.8`（按比例）。
**不修会怎样**：半成品房间会被当成成品，箱子摆在没有墙/没有顶的地方（下雨、刷怪、箱子被苦力怕炸）。

### D25 `fillRoomWithChests` 的探测点硬编码 `+4`，绑死 `innerSize=7`
`skills.js:4947-4950`

**问题**：`probe(x0 + 4, CHEST_Y - 1, z0 + 4)` —— `4` 是 `innerSize=7` 的中心偏移。若 `WAREHOUSE.innerSize`（`:4607-4612`）改动，这个探测点会落到墙里/外面，`roomFound` 判断失效。
**最小修复**：`x0 + Math.floor(S/2)`。
**不修会怎样**：改仓库尺寸这个参数时，验证逻辑静默错位（而它正是"没建房间就别摆箱子"的守卫）。

### D26 `verifyChest` 里有一段永远无效的排序
`skills.js:5080`

**问题**：`known.sort((a, b) => a.distanceTo?.(me) ?? 0)` —— 箱子记录是 `{x,y,z,note}` 这类扁平对象，**没有 `distanceTo` 方法** → `undefined ?? 0` = `0` → 等于没排序。紧接着 `:5082-5084` 用 `Math.hypot` 重新排了一次（那次是对的），所以功能没坏，只是前一行是死代码。
**最小修复**：删 `:5080`（一行）。
**不修会怎样**：无功能影响；但它是"看起来在排序、其实没排"的误导（与 `:571`/`:2760` 同类：**判断看起来做了、其实没做**）。

---

## 5. 对 t9 那 12 条（D1~D12）的复核

| 编号 | 结论 | 依据 |
|---|---|---|
| **D1** SES 沙箱 3 行可逃逸 | **维持 Must，加强** | 本轮读完 `coder.js:189-194` 与 `lockdown.js` 全文，确认 endowment 是**整个 skills 模块 + 整个 world 模块**（不是精选的 facade）→ 逃逸面比 t9 写的更宽（`world` 上任何一个函数都能当跳板）。 |
| **D2** `skills.js:5750` `ok` 未 import | **维持 Must** | 读完 `digTunnel:5690-5751` 全文，`ok` 确实不存在于该函数作用域；`:5742` 的 `if (!run.ok) return run;` 之后必抛。 |
| **D3** 变量拼 `/setblock` 直发 `bot.chat` | **加强：从 1 处变 2 处** | 新增 `:1029`（`breakBlockAt` cheat 分支）。见 D16。 |
| **D4** `takeFromChest` 意图即成功 | **加强：同族从 1 处变 4 处** | 新增 `putInChest:1437`、`storeItem:4208`、`stashUnneeded:3094`。见 D22。 |
| **D5** `loadFurnace` 覆盖别人料 | **维持 Must** | 对照 `act_craft.furnaceBusyWith:451-472` + `:519-525`，确认 atom 侧有 OCCUPIED、skills 侧没有。`smeltItem` 走的 `furnaceLoad` 反而**是对的** —— 所以危险只在模型直接调 `skills.loadFurnace` 时。 |
| **D6** `flow_mine` 的 `countAll` 数两遍 | **维持 Should** | 本轮补了对照：`strat_obtain` 用 `allocated` 账本（`:424-435`）**正确地**解决了"同一库存被多个消费者重复认领"的问题（注释 `:407-423` 有完整的离线复现）→ 说明这套代码库里**有正确解法可抄**，`flow_mine` 只是没抄。 |
| **D7** `breakBlockAt` 无建筑保护 | **维持 Must** | 本轮确认 `act_place:102-104`（OCCUPIED，绝不拆）与 `placeBlock:1190-1195`（wmIsPlayerBuilt）都有闸 → `breakBlockAt` 是**唯一**无闸的破坏入口，对比更鲜明。 |
| **D8** `waitUntil` 语义相反 | **维持，加强** | 新增 D13（`giveToPlayer` 的 `if (got)` 恒真）就是**这个返回值形状不一致的直接后果** —— 有人当它是 boolean 用了。 |
| **D9** `equip` 不查中断/不验证 | **维持 Nice** | 读完 `act_items.equip:50-73` 确认三态验证（`verified`）确实存在，skills 版没有。 |
| **D10** `canReach` 4.3 vs 5.1 | **维持 Nice** | 本轮确认 `skills:1911`（4.3，注释说"留 0.2 余量"）vs `query_perceive:73`（5.1）—— 4.3 = 4.5-0.2 是"交互距离 4.5 留余量"，5.1 是 mineflayer `canDigBlock` 的阈值。两边各有理由，但**同一问题两个答案**这件事本身没变。 |
| **D11** `if (!walk)` 恒假 | **维持 Should** | 读完 `smeltItem:532-655` 全文，确认这是唯一一处；`:571-586` 整段是死代码。 |
| **D12** `putInChest`/`viewChest` 裸 `container.*` | **维持，并入 D4 族** | `viewChest` 只是读，无副作用；`putInChest` 并入 D22。 |

**推翻 0 条；加强 3 条（D1/D3/D4）；新增 14 条（D13~D26）。**

---

## 6. Lean 结算（逐条核实后）

上一轮给的是 `−895 行 可能`（粗估）。本轮读完 15 个 act 与 skills.js 全文后，**按"是否真有等价原子"逐条重算**：

### A 类：纯转发 / 薄包装，删掉让调用方直接走原子层（低风险）

| 条目 | 行数 |
|---|---:|
| `craftRecipe`(198-284) | 87 |
| `smeltItem`(532-655) | 124 |
| `consume`(1524-1542) | 19 |
| `followEntity`(5662-5688) | 27 |
| `scanTreeAt`(5753-5785) | 33 |
| `planTreeChop`(5787-5819) | 33 |
| `climbLadder`(5611-5635) | 25 |
| `canClimbHere`(5637-5660) | 24 |
| **小计** | **372 行** |

### B 类：重复实现，删掉后由原子层那份接管（中风险：改模型可见 API）

| 条目 | 行数 | 前提 |
|---|---:|---|
| `loadFurnace`(439-481) | 43 | 调用方改 `act_craft.furnaceLoad` |
| `putInChest`(1413-1447) | 35 | 改 `act_container.deposit` |
| `takeFromChest`(1449-1493) | 45 | 改 `act_container.withdraw` |
| `viewChest`(1495-1522) | 28 | 改 `act_container.windowItems` |
| `equip`(1285-1331) | 47 | 改 `act_items.equip` |
| `discard`(1333-1374) | 42 | 改 `act_items.dropItem` |
| `goToBed`(2312-2343) | 32 | 改 `act_rest.sleepInBed` |
| `useDoor`(2233-2310) | 78 | 改 `act_blockuse.toggleBlock` |
| `tradeWithVillager`(2548-2625) | 78 | 改 `act_entity.tradeOnce` |
| `activateNearestBlock`(2421-2443) | 23 | 改 `act_blockuse.toggleBlock` |
| `canReach`+`eyePosition`+`reachDistanceTo`(1897-1913) | 17 | 改 `query_perceive` |
| `waitUntil`(39-67) | 29 | 改 `atom_wait.waitUntil`（**注意语义相反，必须改调用方**） |
| `digDown`(2675-2731) | 57 | 改 executor 的 digdown 分支 |
| **小计** | **554 行** |

### C 类：死代码，直接删（无争议）

| 条目 | 行数 | 证据 |
|---|---:|---|
| `collectHazardsCached`(5358-5391) + `hazardScanCache`/`HAZARD_SCAN_TTL_MS`(5338-5339) + `resetHazardCache`(5341-5343) | 42 | `grep collectHazardsCached` 全树 1 处（定义） |
| `verifyChest:5080` 的无效排序 | 1 | 箱子记录无 `distanceTo` |
| **小计** | **43 行** |

### 合计

```
Lean: -969 行, -0 依赖 可能
```
（A 372 + B 554 + C 43 = 969 行，占 skills.js 的 16.6%）

**代价（必须写清楚）**：
1. **B 类会改变模型可见 API**。`skill_library.js:32-44` 的 `always_show_skills` 与 `:52-64` 的技能目录要同步改，否则模型会调不存在的名字（`coder.js:119-133` 的 `_lintCode` 会拦，但浪费一整轮 LLM 调用）。
2. **`waitUntil` 那条最危险**：两份语义相反（`false` = 未完成 vs 已完成）。删 skills 版之前必须先把 `waitForSmelt:499`、`giveToPlayer:1609`、`wait:300` 等**内部调用方**逐个改成 atom 语义，否则会把"等到超时"变成"立刻返回 true"。
3. **没有新依赖**；`prismarine-schematic` 仍被蓝图族使用，**不建议删**。
4. 上一轮说 `−895`，本轮 `−969`：差额来自本轮新确认的 `collectHazardsCached`（42）与 `digDown`/`viewChest` 等被判定为"确有等价原子"。

---

## 7. 未验证 / 边界

- **所有结论都来自读码，没有跑**。D6 的"2 倍"、D13 的"恒真"、D17 的"farmland 会被填平"都是**代码可证**，但没有真机跑一次验证观测量级。
- **`/fill` 与 `/setblock` 的实际服务端行为**（是否受 `spawn-protection`、op 等级、区块加载限制）未验证 —— D17 的"凭空造方块"以"bot 是 op 且指令成功"为前提（`buildFromSchematic` 的注释 `:3905` 说 3784 块验证过，可作旁证）。
- **`act_entity.tradeOnce` 的交易后置校验缺失**只标为观察，未列条目：`win.trade` 不抛错就当成功，但服务端吞包时会谎报。需要真机 + 交易日志才能定性。
- `docs/audit/probes/` 里的两个 SES 逃逸探针**没有运行**（本轮只读码；t9 的逃逸结论是用 `lockdown.js` 直接 `node -e` 复现的，那次的输出在 t9 报告里）。
- 本轮**没有读** `world.js` / `storage.js` / `schematic.js` / `outcome.js` / `world_model.js` 的内部实现（它们是 skills.js 的下游依赖）—— 所以"D7 的 `wmIsPlayerBuilt` 判定是否准确"未核实，只核实了它在 `placeBlock:1190` 被调用、在 `breakBlockAt` 里**没有**被调用。
