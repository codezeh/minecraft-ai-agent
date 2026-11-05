# 深读⑤：玩家建筑判定精度 + world/storage/schematic 三模块 + 三处未读区

补 t15（深读④）与 t10 遗留的硬缺口：`world_model` 的判定**精度**、`world.js`/`storage.js`/`schematic.js` 全文、`terrain3d 430-510`、`cooking_tasks`。

---

## 0. 覆盖表

| # | 文件 | 行数 | 覆盖 | 说明 |
|---|---|---:|---|---|
| A | `src/agent/library/world_model.js` | 291 | **全文** | 一次读完 1-291 |
| B | `src/agent/library/storage.js` | 139 | **全文** | 审计②读过 1-139；本轮按"持久化层"重新逐段核对（结论：它不是持久化层，见 §2） |
| C | `src/agent/library/schematic.js` | 174 | **全文** | 1-174 |
| D | `src/agent/library/world.js` | 431 | **全文** | 1-431 |
| E1 | `src/agent/library/terrain3d.js` | 614 | **补读 430-510** | 前两轮已读 1-130 / 150-430 / 510-620；本轮补上 `boxSurfaces` / `hasSurface` / `stats3d` / `saveSurfaces` / `clearChunk` |
| E2 | `src/agent/tasks/cooking_tasks.js` | 358 | **全文** | 1-180 + 181-358 |
| F1 | `src/agent/library/memory_store.js` | 172 | **全文** | 审计②读过 1-172 |
| F2 | `src/agent/library/mca_import.js` | 171 | **未读** | 本轮时间用尽，**未读**（见 §7） |
| — | `src/agent/library/query_classify.js` | — | **未逐行** | 只确认了 `isProtected` 的签名（`:110`）与调用点；**判定实现未读** |

### 段落结构图（验收要求）

**`world_model.js` 291 行**
```
1-18      文件头：为什么要有"唯一 owner"（三份不同步的历史事故）
20-26     import
26-73     1) 方块分类：AIR_BLOCKS / WATER_BLOCKS / LAVA_BLOCKS / NOT_GROUND(45-63) / isGroundBlock(69-73)
65-100    2) 玩家建筑判定：PLAYER_MATERIALS(84-89) + isPlayerBuiltBlock(95-100)
102-154   3) 危险统一读取：readDangers(107) / readHazards(112) / hazardBlobAt(117) / dangersAt(134-154)
157-166   4) DEFAULT_HAZARD_BLOCKS(163-166)
169-190   5) facingOf()（朝向名）
192-243   6) collectHazards()（枚举→矩形团块合并）
245-290   7) mergeHazardBlobs()（TTL + 扫描范围收敛）
```

**`world.js` 431 行**
```
1-2      import（pf / mcdata）
5-39     getNearestFreeSpace
42-58    getBlockAtPosition（返回活 Block 或假 {name:'air'}）
61-75    getSurroundingBlocks
78-115   getFirstBlockAboveHead
118-142  getNearestBlocks
144-158  getNearestBlocksWhere
161-176  getNearestBlock
179-192  getNearbyEntities（返回**活对象**）
194-196  getNearestEntityWhere
199-215  getNearbyPlayers（返回**活对象**）
218-259  getVillagerProfession
262-282  getInventoryCounts（每次新建对象，无缓存）
285-309  getCraftableItems（对全物品表逐个 recipesFor）
312-322  getPosition（返回**活 Vec3**）
325-341  getNearbyEntityTypes
343-350  isEntityType
352-368  getNearbyPlayerNames
371-388  getNearbyBlockTypes
390-404  isClearPath
406-419  shouldPlaceTorch
421-431  getBiomeName
```

**`storage.js` 139 行**
```
1-19     文件头：仓储分类设计
21-23    import landmarks
27-73    CATEGORY_RULES（ores/wood/building/food/tools 的 exact + suffix）
80-88    categorize()
93-101   allCategories() / categoryLabel()
107      CHEST_SLOTS = 27
113-116  freeSlotsIn()
121-126  countInChest()
131-137  summarizeContainer()
139      export { landmarks }
```

**`schematic.js` 174 行**
```
1-4      import（fs/path/zlib/prismarine-nbt）
6-20     文件头：为什么不用 prismarine-schematic
22-24    bitsPerBlock()
30-44    readPackedValue()（跨 long 边界拼接）
51-159   readLitematic()
  ├ 52-65   读文件 + gunzip + nbt.simplify
  ├ 71-96   逐 Region 解 Size/Position/Palette/BlockStates
  ├ 98-102  合并包围盒 → size
  ├ 111-134 getBlock(wx,wy,wz)（内部 0-based → 原始坐标 → 区域内索引）
  └ 137-148 blockCount：**遍历整个包围盒**统计非空气
164-174  listSchematics()
```

---

## 1. 【核心产出】「玩家建筑保护」到底有几套判定

**先给结论：本仓有 3 套互不相干的判定，其中只有 1 套真正拦住"破坏"，而它拦的是最不该拦错、却最容易拦错的场景。** 关键事实：**`isPlayerBuiltBlock` 一共只有 2 个调用点，且都不在破坏路径上。**

```bash
grep -rn "isPlayerBuiltBlock\|wmIsPlayerBuilt" --include=*.js --include=*.mjs . | grep -v node_modules
# world_model.js:95                      ← 定义
# skills.js:1190                         ← placeBlock
# skills.js:3973                         ← 蓝图放置（schematic overwrite 守卫）
# skills.js:4095                         ← import 别名 isPlayerBuiltBlock as wmIsPlayerBuilt
```

### 1.1 三套判定总表

| # | 判定名 | 定义位置 | 规则 | 调用点 | 结论 |
|---|---|---|---|---|---|
| **J1** | `world_model.isPlayerBuiltBlock(name)` | `world_model.js:95-100` | **纯方块名**：24 个精确名（`:84-89`）+ 15 个后缀正则（`:99`） | `skills.js:1190`（placeBlock）、`skills.js:3973`（蓝图放置） | **只保护"放置"和"蓝图覆盖"，不保护"破坏"** —— 半套 |
| **J2** | `skills.levelGround` 的 `NATURAL_BLOCKS` 白名单 | `skills.js:3359-3388` | **纯方块名**，硬编码 ~90 项，语义与 J1 **相反**（这是"可以拆"的清单） | `:3417`（快速 /fill 路径）、`:3465`（手工路径） | **这才是真正决定"铲平会不会毁房子"的判据**，而它与 J1 没有共享任何代码 |
| **J3** | `landmarks.protectedPlaces` + `query_classify.isProtected` | `landmarks.js:69`、`query_classify.js:110` | 坐标半径：地标（箱子/工地/仓库）周围 N 格 | 仅 `flow_collect_plan.js:113`→`:119`（砍树前过闸） | **本该是"别砍玩家东西"的防线，但因审计② B10 的字段形状 bug 恒为空**（写扁平 `{x,y,z}`、读 `c?.pos`）→ 实际不生效 |
| **J4** | `breakBlockAt` | `skills.js:1007` | **没有任何判定**，只有注释警告（`:1010-1013` "never call it on blocks you or the player placed"） | `skills.js:1104/1197/2383/2723` 等 | **完全无保护**：注释不是闸门 |

### 1.2 J1 的逐场景精度（本任务要求逐类给结论）

规则原文（`world_model.js:84-89`）：
```
'planks','stone_bricks','bricks','glass','glass_pane','chest','trapped_chest',
'crafting_table','furnace','blast_furnace','smoker','barrel','bookshelf','torch',
'lantern','door','trapdoor','fence','fence_gate','stairs','slab','bed','hopper','iron_bars','ladder'
```
后缀（`:99`）：`_planks$ _bricks$ _glass _wool$ _concrete _terracotta$ _carpet$ _stairs$ _slab$ _door$ _trapdoor$ _fence$ _fence_gate$ _bed$ _sign$`

| 场景 | 具体方块名 | J1 判定 | 依据 | 后果 |
|---|---|---|---|---|
| **玩家用圆石搭的房子** | `cobblestone` | ❌ **不是** | 不在名单；`cobblestone` 不匹配任何后缀。注释 `:80-83` **明确拒绝**加它（"实测把 cobblestone 算成建筑后，4 处天然裸露岩层被误判"） | **不保护**。而在 J2 里 `cobblestone` 属于"可拆"（`:3364`）→ **`levelGround` 会把它整片削平** |
| 玩家用石砖搭的房子 | `stone_bricks` | ✅ 是 | 精确名 `:85` | 保护（placeBlock/蓝图不放上去） |
| **玩家用泥土垫的路** | `dirt` | ❌ **不是** | 不在名单，无后缀命中；`:80-83` 同样明确拒绝 | **不保护**；J2 里 `dirt` 可拆（`:3361`）→ 会被铲平 |
| 自然生成的村庄房屋 | `oak_planks` / `glass_pane` / `cobblestone` / `oak_log` | ⚠️ **部分**（planks/glass_pane 是，cobblestone/oak_log 不是） | `_planks$`、`glass_pane` 命中 | **误报**：村庄会被当成"玩家建筑"，导致 placeBlock 拒绝在那儿放方块（ nuisance，不造成破坏）；而 levelGround 里 planks 不可拆（不在 J2）→ 村庄反而侥幸安全 |
| **玩家放的箱子** | `chest` | ✅ 是 | 精确名 `:86` | J1 保护它；但 **`breakBlockAt` 不看 J1**（J4 无判定），J3 又恒空 → **砍树/误挖时会被拆掉**（箱子 + 全部内容丢失） |
| 玩家放的工作台 | `crafting_table` | ✅ 是 | `:86` | 同箱子 |
| 玩家放的床 | `bed` / `*_bed` | ✅ 是 | `:88` + `_bed$` | 同箱子 |
| 玩家放的门 | `*_door` | ✅ 是 | `door` + `_door$` | 同箱子 |
| 玩家放的火把 | `torch` | ✅ 是 | `:87` | 保护；但 `NOT_GROUND` 里也有 torch（`:62`），两处语义不同 |
| **玩家铺的农田** | `farmland` | ❌ **不是** | 不在名单；`farmland` 不匹配任何后缀 | **不保护**。而且 J2 把 `farmland` **明确列为"可拆的自然方块"**（`:3361`）→ **`levelGround` 会主动把农田铲掉**；作物（`wheat` 等）不在 J2 名单里所以不被拆 → 留下**悬空作物**，随后掉落消失 |

**判定精度的总评**：J1 的判据是"材料像不像人造的"，不是"这块地是不是玩家的"。它在两个方向都错：
- **漏判**（该保护却没保护）：`cobblestone` / `stone` / `dirt` / `farmland` / `oak_log` —— 恰好是玩家最常用的四种建材；
- **误判**（不该拦却拦）：自然村庄（`oak_planks`、`glass_pane`）。
作者在 `:80-83` 里为"漏判"给的理由是**真实踩过的坑**（把圆石算成建筑会污染热力图禁行）——这说明矛盾不在"清单写错了"，而在**用一个"材料类型"判据去回答一个"归属"问题**。

### 1.3 信息从哪来 / 过期怎么办

**J1 完全无状态**：入参只有方块名（`world_model.js:95`），**没有坐标、没有历史、没有持久化**。所以不存在"过期"问题，也不存在"记住这是玩家盖的"——同一个 `cobblestone`，无论它是天然岩层还是玩家围的墙，判定结果永远相同。

**J3 有状态**：`landmarks.protectedPlaces(bot)` 从 `bots/<name>/memory/{chests,sites,storage}.json` 读，60 秒 TTL 缓存（`landmarks.js:70-77`，审计② 已读）。而写入方存的是扁平 `{x,y,z}`，读端要 `c?.pos` → **恒空**（审计② B10 / t15 N4）。

### 1.4 这套判定"实际被谁用"——回答问题

| 使用者 | 拦什么 | 拦得住吗 |
|---|---|---|
| `placeBlock`（`skills.js:1190`） | "要放方块的位置上已经有玩家建筑 → 拒绝放置" | 拦得住，但只拦"放置" |
| 蓝图放置（`skills.js:3973`） | "蓝图要覆盖的位置已有玩家建筑 → 除非 overwrite=true" | 拦得住，只在 `overwrite=false` 时 |
| **`breakBlockAt`（`skills.js:1007`）** | **什么都不拦** | ❌ **挡不住任何破坏** |
| **`levelGround`（`skills.js:3390`）** | 用 J2 白名单，**完全不查 J1** | ❌ 圆石/泥土/农田会被主动拆 |
| `flow_collect_plan`（砍树） | 用 J3 半径保护 | ❌ J3 恒空 → 不生效 |

**所以「玩家建筑保护」这条线，对"破坏"实际上只有一半，而且这一半（J3）因为字段 bug 是空的。** 能拆玩家东西的路径至少有 4 条：`breakBlockAt`（无判定）、`levelGround` 快速路径（J2 白名单把圆石/泥土/farmland 当"可拆"）、`levelGround` 手工路径（同）、`flow_collect_plan`（J3 恒空）。

---

## 2. `storage.js` 的持久化可靠性（回答问题 2）

**结论：`storage.js` 根本不是持久化层。** 它没有任何 `fs` / 数据库调用（全文 139 行只有 `import * as landmarks`，`:21`），只有：
- 物品→分类的规则表（`:27-73`）+ `categorize()`（`:80-88`）
- 箱子容量/计数的纯函数（`:113-137`）
- 末尾把 `landmarks` 再导出一遍（`:139`）

**真正的持久化在 `memory_store.js`**（172 行，审计② 已读）：

| 问题 | 实际实现 | 可靠性判定 |
|---|---|---|
| 存什么 | `bots/<name>/memory/<namespace>.json`，每 namespace 一个文件，`{_v,_updated,data}` 外壳（`memory_store.js:96-113`） | — |
| 何时 flush | **每次 `writeStore` 立即整文件重写**（无缓冲、无定时器） | 不会"最后一批没落盘" |
| 崩溃窗口 | 写临时文件 → `renameSync`（`:101-108`），同分区 rename 原子 → **崩溃最多丢这一次写，不会写坏** | 这一层是**对的**（比板库的删库策略好） |
| 文件损坏 | `readStore` 的 `catch` 直接 `return fallback`（`:87-90`）——返回**默认值（空数组/空对象）**，只打一行 `console.warn` | ✗ **损坏 = 静默清空**。下一次 `writeStore` 会把"空数据"覆盖回去 → **原始数据永久消失，且没有备份**（对比：`openBoard` 至少会把坏文件改名留档） |
| 并发写 | 无锁；`updateStore` 是 read-modify-write（`:120-125`） | 每 bot 一个进程时安全；**同一 bot 被起两个实例**（本项目发生过，见审计③ I2 的"凭空起 agent"）→ 丢更新 |
| schema 演化 | 写入固定 `_v: 1`（`:103`），读取时**只看 `data` 字段，完全不校验 `_v`**（`:83-86`） | 版本号是装饰品：改了结构也没有迁移路径 |

**最小修复（损坏静默清空这条）**：`readStore` 的 catch 里把坏文件 `renameSync` 成 `<ns>.json.corrupt-<ts>` 再返回 fallback（照抄 `board_store.js:178-192` 的做法）。
**不修会怎样**：一次 JSON 半写/编码问题就让长期记忆（箱子坐标、危险点、任务进度）归零，且**日志只有一行 warn**，事后无法判断是被自己清空的。

---

## 3. `world.js` 的缓存与快照语义（回答问题 3）

**结论：`world.js` 里没有任何缓存，所以不存在"旧快照当现状"；但它返回的是活对象，风险方向相反——调用方改它会污染源。**

| 函数 | 返回什么 | 风险 |
|---|---|---|
| `getPosition(bot)`（`:312-322`） | **`bot.entity.position` 本体**（活 Vec3） | 调用方 `pos.x += 1` 会**直接改掉 bot 的位置对象**，与"瞬移"类问题同族 |
| `getNearbyEntities(bot)`（`:179-192`） | **活的 mineflayer entity 对象数组**（`:189` `res.push(entities[i].entity)`） | 调用方改 `e.position` 会污染 `bot.entities` |
| `getNearbyPlayers(bot)`（`:199-215`） | 同上（`:212`） | 同上 |
| `getBlockAtPosition(bot,x,y,z)`（`:42-58`） | 活 Block；**读不到时返回假对象 `{name:'air'}`**（`:55`） | 假对象**没有** `diggable`/`drops`/`position` → 调用方 `.diggable` 得到 `undefined`；`getNearestFreeSpace:28` 正是用 `bottom.drops.length` / `bottom.diggable` 判断，遇到假对象会 **TypeError** |
| `getInventoryCounts(bot)`（`:262-282`） | **每次新建** `{}`（安全） | 无缓存 → 循环里调 N 次就扫 N 遍 `inventory.slots` |
| `getCraftableItems(bot)`（`:285-309`） | 新数组 | 对 `mc.getAllItems()` **每个物品**调一次 `bot.recipesFor`（`:303-307`）→ 单次约 1500 次调用，模型每问一次"能做什么"都要付这个成本 |

**"旧快照当现状"在本仓的真实位置不在 world.js**，而在两处（都已记录）：`board_client` 的本地镜像（审计② B6）与 `flow_collect_plan` 的 `standPos`/`planned` 规划期状态（t15 N16）。**本轮确认 world.js 本身是干净的**——它宁可每次现查也不缓存。

**最小修复**：`getBlockAtPosition` 的兜底假对象补上 `diggable:false, drops:[], position:new Vec3(x,y,z)`（1 行），或让 `getNearestFreeSpace` 用 `bottom?.drops?.length` 取空安全。
**不修会怎样**：区块未加载时找空地的函数抛 TypeError，而调用方通常 catch 成"没找到"，表现为"偶尔找不到地方放方块"。

---

## 4. `schematic.js` 与 skills 里 setblock 生成的关系（回答问题 4）

**结论：不是第三份实现。`schematic.js` 只做"解析"，不生成任何指令。**
- 全文 174 行里**没有** `setblock` / `fill` / `chat` 字样（只有 `fs` / `zlib` / `nbt`）。
- 它对外只暴露 `getBlock(x,y,z) → {name, properties}`（`:111-134`）与 `size`/`blockCount`。

所以坐标换算→指令的责任划分是：
```
schematic.js:getBlock   →  只回答"蓝图在 (x,y,z) 要放什么"
skills.js 的蓝图放置块  →  把内部坐标 + 原点转成世界坐标，再发 /setblock（含 J1 守卫 :3973）
skills.js 的 buildHouse / levelGround → 另一套（与蓝图无关的）指令生成
```
**D3/D4 说的"setblock 生成在 skills 里"是对的，`schematic.js` 不构成重复。**

**但有两个真问题**：
1. **加载时遍历整个包围盒**（`:139-148`）：`blockCount` 对 `size.x*size.y*size.z` 每个格子调一次 `getBlock`，而 `getBlock` 内部还要**遍历所有 Region**（`:114`）。一个 100×50×100 的蓝图 = **50 万次 getBlock × R 个 region**，全在 `readLitematic` 同步执行 → 加载期间阻塞事件循环。而 `totalBlocks`/`blockCount` 只用于展示。
2. **损坏/不匹配静默变空气**：`readPackedValue` 越界时取 `?? 0`（`:36,38`），取出的调色板索引若超出 `palette.length` → `entry` 为 undefined → **`return null`**（`:130`）→ 调用方一律按"air"处理（`:143`、`skills.js:3967`）。所以一个 BlockStates 长度写错的文件会**静默变成一张空蓝图**，不报错。

**最小修复**：① `blockCount` 改为惰性（只在被查询时算），或加 `opts.count=false`；② `getBlock` 里 `if (!entry) throw new Error('palette index 越界…')`，让坏文件在加载期就炸（符合本仓"启动即校验"的既定风格）。

---

## 5. 新发现清单

### Must fix

#### W1　`levelGround` 的"可拆白名单"包含圆石/泥土/农田 → 铲平会主动拆掉玩家的房子和农田
`mindcraft/src/agent/library/skills.js:3419-3424`（快速路径 `/fill … air replace <每个 NATURAL_BLOCKS>`）＋ `:3359-3388`（清单定义，含 `cobblestone`/`dirt`/`farmland`）

**这是什么**：`levelGround` 是"盖房子前把地推平"的技能（`skills.js:3509` 的 `buildHouse` 在铺地基前就调它）。size ≥ 5 时走快速路径：对 `NATURAL_BLOCKS` 里**每一个方块名**发一条 `/fill X0 TY+1 Z0 X1 TY+12 Z1 air replace <name>`。

**问题（场景 → 结果）**：`NATURAL_BLOCKS` 里有 `cobblestone`（`:3364`）、`dirt`/`grass_block`/`farmland`（`:3361`）、`stone`（`:3364`）、所有原木与树叶（`:3374-3375`）。
- 玩家用**圆石**盖的房子正好在推平范围内 → `/fill air replace cobblestone` **把整面墙削平**（13×13×12 的区域一次remove）。
- 玩家铺的**农田** → `/fill air replace farmland` **整片铲掉**；作物（`wheat` 不在名单）留下悬空，随后掉落消失。
- 这条路径**完全不查 J1** `isPlayerBuiltBlock`，也不查 J3 地标半径。

**最小修复**：`:3417` 的 `naturalNames` 里剔除 `cobblestone`/`dirt`/`stone`/`farmland`/`grass_block`（这五个是玩家最常用的建材），或让快速路径在发 `/fill` 前先用 `bot.findBlocks` 扫一遍范围内有没有 J1 命中项，有就降级到手工路径。

**不修会怎样**：`!build` / `buildHouse` 一开场就把附近玩家的圆石房/土路/农田抹平，且日志只说 "Only natural materials are removed."——`/fill` 的破坏是**不可撤销**的。

#### W2　`breakBlockAt` 对玩家建筑零判定，而它是绝大多数破坏动作的唯一出口
`mindcraft/src/agent/library/skills.js:1007-1065`（函数体只有坐标校验 → 距离 → 装备 → `holdDig`）

**这是什么**：`breakBlockAt` 是"挖掉一格"的底层函数，被 `:1104`、`:1197`、`:2383`、`:2723` 等至少 4 处调用。

**问题**：函数体的检查只有 `x/y/z` 非空（`:1023`）、距离 ≤4.5（`:1034`）、能不能采（`:1057`）。**没有任何"这是不是玩家建筑"的判断**——`:1010-1013` 的注释写着 "never call it on blocks you or the player placed (planks, glass, chests, doors...)"，但**注释不是闸门**。
具体场景：砍树流程里 `flow_collect_plan` 只靠 J3（恒空）过闸；一旦目标格判定失误（树的坐标算错、`skip` 集合漏项），`digBlock` → `breakBlockAt` 会把玩家放的**箱子/工作台直接挖掉**（箱子内的物品同时消失）。审计② B10 已证明 J3 恒空，所以这条路上**没有任何有效保护**。

**最小修复**：在 `breakBlockAt` 的 `:1025` 之后加一道与 `placeBlock:1190` 完全同形的守卫：
```js
if (wmIsPlayerBuilt(block.name) && !opts?.force) { log(bot,'REFUSED_PLAYER_BUILT'); return false; }
```
（`wmIsPlayerBuilt` 已在本文件 import，`:4095`。需要给内部合法调用方（如 `levelGround` 拆自己铺的地基）加 `force`。）

**不修会怎样**：所有破坏路径共用同一个"无保护出口"；结合 J1 的漏判（圆石/泥土不算建筑），即使加了守卫也只能挡住木板/玻璃/箱子这一类。

#### W3　`memory_store.readStore` 遇损坏文件静默返回空值，下一次写就把原数据永久覆盖
`mindcraft/src/agent/library/memory_store.js:87-90`（`catch → return fallback`）对照 `:96-113`（`writeStore` 整文件覆盖）

**这是什么**：长期记忆（箱子坐标 `chests`、工地/死亡点 `sites`、危险点 `dangers`、任务进度 `tasks`、地形危险 `hazards`）的唯一存储。

**问题（场景 → 结果）**：`JSON.parse` 抛错（半写、磁盘满、手工编辑出错）→ `catch` 返回默认空值并只打一行 `console.warn`；**坏文件既不备份也不改名**。之后任何一次 `updateStore`（`:120-125`，read→改→写）都会把"空数据"写回去 → 原文件被**永久覆盖**。
对照同仓的 `board_store.openBoard`（`:178-192`）——那里至少会 `renameSync` 成 `.corrupt-<ts>` 留证。两处标准不一致。

**最小修复**：`:88` 的 catch 里加 `try { fs.renameSync(p, p + '.corrupt-' + Date.now()); } catch {}`，再返回 fallback。

**不修会怎样**：一次损坏 = 记忆归零且无痕迹；事后查不到"为什么箱子记录全没了"。

### Should fix

#### W4　`isPlayerBuiltBlock` 用"材料类型"回答"归属"问题，两个方向都判错
`mindcraft/src/agent/library/world_model.js:84-100`

**这是什么**：全仓"玩家建筑"的唯一名字判据。

**问题**：见 §1.2 的逐场景表。漏判 `cobblestone`/`dirt`/`stone`/`farmland`/`oak_log`（玩家最常用建材），误判自然村庄（`oak_planks`/`glass_pane`）。
注意：作者在 `:80-83` 给出的理由（把 cobblestone 算成建筑会污染热力图）是**真实踩过的坑**，所以**不能简单地把 cobblestone 加进名单**——那会把当初的 bug 复活。这条的修法不是改名单，而是补第二个维度。

**最小修复**：不要动 `PLAYER_MATERIALS`。改为新增一个**位置型**判据并用在破坏路径上——`isNearPlayerStructure(bot, pos)`：若 `pos` 周围 8 格内存在 J1 命中项（木板/玻璃/箱子等），则把 `cobblestone`/`dirt`/`farmland` 也视为"可疑玩家结构"。这一步只新增函数，不改现有语义。

**不修会怎样**：玩家用圆石/泥土/农田做的任何东西都不在保护范围内，而自然村庄却被当成玩家建筑（`placeBlock` 会被无故拒绝）。

#### W5　`getBlockAtPosition` 的兜底假对象缺字段，`getNearestFreeSpace` 会 TypeError
`mindcraft/src/agent/library/world.js:55`（`if (!block) block = {name: 'air'}`）对照 `:28`（`bottom.drops.length == 0 || !bottom.diggable`）

**这是什么**：查询层唯一的"读不到就给个假方块"兜底。

**问题**：假对象只有 `name`。`:28` 对 `bottom` 做 `.drops.length` 与 `.diggable` → **TypeError**（`Cannot read properties of undefined`）。触发场景：区块未加载时 `bot.blockAt` 返回 null（`getNearestFreeSpace` 正是"找一个能放东西的空地"，常发生在刚传送到的地方）。
另有逻辑 bug：`!top.name == 'air'`（`:28`）—— `!` 只作用于 `top.name`，得到 `false`，再与 `'air'` 比较恒为 `false` → **"上方必须是空气"这条检查永远不生效**。

**最小修复**：`:55` 改为 `block = { name: 'air', diggable: false, drops: [], position: new Vec3(x,y,z) }`；`:28` 改为 `top?.name !== 'air' || !bottom?.drops?.length || !bottom?.diggable`。

**不修会怎样**：找空地偶发抛错（被上层吞成"没找到"）；且"上方是否空气"从未被检查过 → 可能把方块放进已有方块里。

#### W6　`readLitematic` 用"遍历整个包围盒"统计方块数，坏文件静默变空蓝图
`mindcraft/src/agent/library/schematic.js:137-148`（全盒遍历）＋ `:128-131`（索引越界 → `return null`）

**这是什么**：蓝图加载器。

**问题**：
- **性能**：`size.x*size.y*size.z` 每格一次 `getBlock`，每次再遍历所有 Region。100×50×100 → 50 万次同步调用，`readLitematic` 是同步的 → 加载期阻塞。
- **正确性**：`readPackedValue` 越界取 0（`:36,38`），调色板索引若越界 → `entry` undefined → `return null`（`:130`）→ 上层按 air 处理。**BlockStates 长度不对的文件会静默变成空蓝图**，一句错误都没有。

**最小修复**：`blockCount` 加 `opts.count` 开关（默认 false，只在 `!listSchematics` 或诊断时算）；`getBlock` 里索引越界直接 `throw`。

**不修会怎样**：大蓝图加载卡住调度；坏蓝图表现为"她什么都不建"且无任何报错。

#### W7　`buildHouse`（cooking 任务）用逐格 `/setblock` 拼房，500+ 条指令 + 每格 `await bot.chat`
`mindcraft/src/agent/tasks/cooking_tasks.js:290-324`（三层循环逐格 `await this.bot.chat('/setblock …')`）

**这是什么**：cooking 评测任务的场景搭建（11×11×5 的房子）。

**问题**：`for x → for y → for z` 三层循环，每格一条 `/setblock stone_bricks`，**全部 `await bot.chat(...)`**。而 `bot.chat` 对 slash 命令是**发出去就不管**、不保证服务端已执行 → 500+ 条命令后的 `:356` 只 `setTimeout(300)` 就开始下一步（放床/熔炉）。场景要么没搭完，要么把后面步骤的坐标算在未生成的墙上。
同类问题在 `:224-233`（`plantCrops` 36 格 × 2 条）、`:336-345`（屋顶 3 圈）。

**最小修复**：墙体用一条 `/fill`（矩形区域 + 再单独挖门窗），把 500+ 条降到 ~5 条；这是评测脚本，改动不影响生产代码。

**不修会怎样**：评测场景时快时慢、偶发缺墙缺床，导致"任务失败"的归因错误（是模型不行还是场景没搭好，分不清）。

### Nice to have

#### W8　`cooking_tasks` 里 29 行死数据：`cookingItems` 的消费者全被注释
`mindcraft/src/agent/tasks/cooking_tasks.js:157-185`（数组定义）对照 `:135-156` / `:187-202`（`addChestWithItems` 与调用点**全部是注释**）

**这是什么**：给场景箱子准备的材料清单。

**问题**：`:157` 的 `const cookingItems = [...]` 是在 `init()` 顶层声明的，但唯一读它的函数 `addChestWithItems` 从定义到调用（`:202 await addChestWithItems()`）**整段被注释**。所以这 29 行既执行又无人用（数组构造本身有开销，且误导读者以为箱子会被填满）。
（已 grep 确认：`cookingItems` 全仓仅这 2 处引用，无动态引用。）

**最小修复**：删掉 `:157-185`。

**不修会怎样**：读代码的人以为箱子逻辑活着；实际场景里没有那个箱子。

#### W9　`findValidPosition` 的报错文案与实际循环次数不符
`cooking_tasks.js:49`（`while (attempts < 10000)`）对照 `:62`（`throw new Error('… after 1000 attempts')`）

**最小修复**：文案改成 10000，或把上限定成与文案一致的 1000。

**不修会怎样**：排查"为什么场景生成失败"时按 1000 去算概率，与实际差一个数量级。

---

## 6. 对 t15 的 D7/D17/D21 与 t10 的 E1~E9 的复核意见

### 6.1 t15（深读④）

| 编号 | 原判 | 本轮意见 | 依据 |
|---|---|---|---|
| **D7**（`breakBlockAt` 不调用玩家建筑判定） | 成立 | **成立，且要加强** | 本轮把 `breakBlockAt` 全文读完（`skills.js:1007-1065`）：函数体确实**一个判定都没调**，`:1010-1013` 只有注释警告。且它是 4+ 处破坏动作的共同出口 → 影响面比 D7 描述更大（见 W2） |
| **D17**（`levelGround` 用硬编码 `NATURAL_BLOCKS` 而非 J1） | 成立 | **成立，且要补两点** | ① 确认 `NATURAL_BLOCKS` 在 `:3359-3388`，两条路径（`:3417` 快速 / `:3465` 手工）都只用它；② **但要纠正一个细节**：`wmIsPlayerBuilt` 的第二个调用点是 `:3973`，那属于**蓝图放置**，不是 `levelGround`。所以不能说"只有 placeBlock 一处用它"——是**两处**，且两处都在"放置"侧 |
| **D21** | 未在本轮材料中给出原文，**无法复核** | — | 本轮未拿到 D21 的表述原文，不做判断（不猜） |

### 6.2 t10（深读② 本轮的 E1~E9）

| 编号 | 原判 | 本轮意见 | 依据 |
|---|---|---|---|
| E1 `follow` 超时键名不匹配 | Must | **维持** | 与本轮无关，未取新证；上轮已 grep 铁证（registry:78 `deadlineMs` vs follow:87 `timeoutMs`） |
| E2 `digdown` 液体假成功 | Must | **维持** | 同上（`executor.js:342-345`→`:363`） |
| E3 `checkLevel` 返回 false | Should | **维持** | 同上 |
| E4 `embellishments` 传错 `newZ` | Should | **维持** | 同上（`construction_tasks.js:738/741`） |
| E5 任务 JSON → owner 级命令 | Should | **维持，并新增旁证** | 本轮在 `cooking_tasks.js:17-24` 看到另一个同族形态：**硬编码的 `/fill … air` 直接清空 100×100 区域**（`:17-24`），同样是"数据/常量 → 高权限指令" |
| E6 `runCraft` 不传 ctx | Should | **维持** | 同上 |
| E7 = B12 后果链 | Should | **维持** | 同上 |
| E8 `score=NaN` | Nice | **维持** | 本轮在 `construction_tasks.js:19-20` 复核了算式，成立 |
| E9 挖循环不查 interrupt | Nice | **仍未定性** | 本轮仍未打开 `act_dig.js`；**保持"需先确认"的标注**，不升级 |

---

## 7. Lean: 结算

| 项 | 量 | 依据 |
|---|---|---|
| **可直接删** | **29 行** | `cooking_tasks.js:157-185` 的 `cookingItems`（消费者全被注释，grep 确认零引用）（W8） |
| **可合并/降级** | 0 | 三套判定**不建议合并**：J2 的 `NATURAL_BLOCKS` 与 J1 语义相反（可拆 vs 不可放），合并会把真实踩过的坑复活（`world_model.js:80-83`）。正确方向是**新增**位置型判据（W4 的修法），不是合并 |
| **可省的计算** | 每次蓝图加载 O(size³) | `schematic.js:137-148`（W6）；100×50×100 省 50 万次同步调用 |
| **本轮的净收益** | **不是删行，是把"保护"这件事说清楚了** | 结论：能拆玩家东西的路径有 4 条，其中 3 条**零有效保护** |

**没读的（诚实边界）**
- `mca_import.js`（171 行）**未读** —— 本轮时间用尽，任务清单 F2 未完成。
- `query_classify.js` 的 `isProtected` **实现未逐行读**（只确认签名 `:110` 与调用点 `flow_collect_plan:119`）；所以 J3 的"半径精度"我只能引用审计② B10 的结论（恒空），**没有独立复核**。
- `terrain3d.js` 614 行中，本轮补了 430-510；**130-150 与 510-620 之外仍有未读片段**（前两轮覆盖 1-130/150-430/510-620，故整体已连成全文，但 510-620 是审计②时有界读的，本轮未复读）。
- `NATURAL_BLOCKS` 与 `PLAYER_MATERIALS` 的逐项比对是**人工对照**，没有写脚本穷举，可能存在个别漏看项。
