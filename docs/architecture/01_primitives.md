# 原子层（Primitives）

> 2026-11-01 重写。旧版（35 个"原子"，含寻路、合成、砍树）已归档到
> [`../legacy/01_primitives_v1.md`](../legacy/01_primitives_v1.md)：按下面的新定义，它列的大部分是**动作**，现收在 [`02_actions.md`](02_actions.md)。
> 返回结构、错误码、参数命名仍以 [`ARCHITECTURE_REDESIGN.md §6`](ARCHITECTURE_REDESIGN.md) 为准。

## 1. 定义：原子 = 一次玩家输入，或一次纯读取

判断口诀：**能不能用"按一下 / 按住直到 / 看一眼"一句话说完，且中间不需要做任何判断。**

| 例子 | 是不是原子 | 为什么 |
|---|---|---|
| 按住 W 直到条件满足或到时 | ✅ 原子 | 一个键 |
| 朝某点转头 | ✅ 原子 | 一次视角输入 |
| 对准方块按住左键直到它碎 | ✅ 原子 | `bot.dig` 内部发多个包，但对应玩家一次"按住" |
| 按数字键 3 切到快捷栏第 3 格 | ✅ 原子 | 一次按键 |
| 读某格是什么方块 | ✅ 原子（读取） | 一次读，无副作用 |
| 走到 (x,y,z) | ❌ 导航 | 寻路 + 很多步 + 中途判断 |
| 挖一个方块（选工具→挖→确认碎了） | ❌ 动作 `digBlock` | 三件事，有前置和后置 |
| 装备镐子 | ❌ 动作 `equip` | 不在快捷栏时要开背包、拖动、关背包 |
| 合成一次 | ❌ 动作 `craftOnce` | 开工作台、摆料、取出 |
| 这格能不能站 | ❌ 查询 `canStand` | 多次读取组合成一个判断，见 §5 |

mineflayer 的 `equip` / `craft` / `consume` / `sleep` / `openFurnace` 等是它**替我们写好的多步动作**，归动作层直接用，
见 [`02_actions.md §2`](02_actions.md)。

## 2. 规矩

| # | 规矩 | 为什么 |
|---|---|---|
| A1 | `bot.setControlState` / `bot.look*` / `bot.dig` / `bot.placeBlock` / `bot.activate*` / `bot.attack` / `bot.clickWindow` / 以 `/` 开头的 `bot.chat` **只许在 `atom_input_*.js` 里出现** | 现在 `setControlState` 出现在 8 个文件里（`atom_boat` 12 处最多），出事查不到是谁按的、谁该松 |
| A2 | 输入原子返回 `ActionResult`；读取原子**直接返回数据或 `null`，不抛异常** | 读取在热路径上，不该让每个调用方写 try |
| A3 | 入口查 `bot.interrupt_code`；会等待的原子在等待中每 ~100ms 再查一次，返回 `INTERRUPTED` | 现在爬梯中喊停仍会按住跳直到超时（D16） |
| A4 | 自带超时，用 `opts.timeout`（毫秒），超时返回 `TIMEOUT`，和 `INTERNAL` 分开 | 外包 `Promise.race` 分不清超时和异常 |
| A5 | 不重试、不循环动作、不调别的输入原子 | 重试属于上层（流程的 `onFail`） |
| A6 | 不做前置判断（够不够得着、有没有货） | 那是动作层的事；原子只管做并如实报 |
| A7 | 按下的键在**所有**退出路径上松开（`try/finally`） | 残留按键是最难查的一类 bug |

唯一例外：`releaseAll` 允许任何层在收尾时调用（等于"松开所有键"）。

## 3. 清单（44 个）

按文件分组，不是一个原子一个文件。"现状"列：✅ 已有 / 🔀 散在别处待收拢 / 🆕 没有。
表里省略第一个参数 `bot`。

### 3.1 `atom_input_move.js` — 移动键（5）

| 原子 | mineflayer | 完成条件 | 现状 |
|---|---|---|---|
| `holdKey(key, {until, timeout})` | `setControlState(key, true)` … `false` | `until()` 为真或到时；`finally` 松键 | 🔀 executor 潜水、`atom_climb`、`atom_pillar`、`atom_boat` 各写一份 |
| `pressKey(key, ms)` | 同上，固定时长 | 到时松开 | 🔀 |
| `setSprint(on)` | `setControlState('sprint', on)` | 立即 | 🆕 |
| `setSneak(on)` | `setControlState('sneak', on)` | 立即 | 🆕 |
| `releaseAll()` | `clearControlStates()` | 立即 | 🔀 各处直接调 |

### 3.2 `atom_input_mouse.js` — 视角与鼠标（11）

| 原子 | mineflayer | 完成条件 | 现状 |
|---|---|---|---|
| `lookAt(point, {force})` | `bot.lookAt` | 读回 yaw/pitch 在容差内 | ✅ `atom_look.lookAt` |
| `setLook(yaw, pitch)` | `bot.look` | 同上 | 🆕 |
| `swing()` | `bot.swingArm()` | 立即 | 🆕 |
| `holdDig(block, {timeout})` | `bot.dig(block)` | 方块变空气，或到时 | 🔀 在 `atom_dig.digBlock` 里 |
| `stopDig()` | `bot.stopDigging()` | 立即 | 🔀 |
| `placeAgainst(ref, face)` | `bot.placeBlock(ref, face)` | `blockUpdate` 到达或到时 | 🔀 在 `atom_place.placeBlockAt` 里 |
| `useHeld({hold})` | `bot.activateItem()` | 立即；`hold` 时保持到 `releaseUse` | 🆕 |
| `releaseUse()` | `bot.deactivateItem()` | 立即 | 🆕 |
| `useOnBlock(block)` | `bot.activateBlock(block)` | 立即 | 🔀 在 `atom_use` 里 |
| `useOnEntity(entity)` | `bot.activateEntity(entity)` | 立即 | 🆕 |
| `attack(entity)` | `bot.attack(entity)` | 一次挥击 | 🔀 `atom_attack` 现在是"打到死"的循环 |

### 3.3 `atom_input_inventory.js` — 物品栏与界面（4）

| 原子 | mineflayer | 完成条件 | 现状 |
|---|---|---|---|
| `selectSlot(i)` | `bot.setQuickBarSlot(i)` | `quickBarSlot === i` | 🆕 |
| `clickSlot(slot, button, mode)` | `bot.clickWindow` | 回包或到时 | 🆕 |
| `closeWindow()` | `bot.closeWindow(window)` | `currentWindow` 为空 | ✅ `atom_container.closeContainer` |
| `dropSlot(slot, all)` | `clickWindow(slot, all ? 1 : 0, 4)`（Q 键） | 该格减少 | 🆕 |

### 3.4 `atom_input_misc.js` — 载具、聊天、命令（6）

| 原子 | mineflayer | 说明 | 现状 |
|---|---|---|---|
| `mountEntity(entity)` / `dismount()` | `bot.mount` / `bot.dismount` | Paper 1.21.8 上原生 mount 被服务端忽略，上船走 `command('ride …')`（`legacy/技术总结.md §4.2`） | 🔀 `atom_boat` |
| `say(text)` | `bot.chat` | 拒绝以 `/` 开头的文本 | 🆕 |
| `whisper(user, text)` | `bot.whisper` | | 🆕 |
| `command(cmd, args)` | `bot.chat('/' + …)` | **全系统唯一能发斜杠命令的地方，带白名单**。bot 账号是 op，`/ride` `/tp` `/setblock` `/fill` 现在散在 `atom_boat.js` 和 `skills.js` 十多处。起步白名单只放 `ride`；作弊模式命令单列豁免；加命令要写用途 | 🆕 |
| `respawn()` | `bot.respawn()` | 死亡后 | 🆕 |

### 3.5 `atom_read.js` — 读取（14）

不抛异常；读不到返回 `null` 或空数组。

| 原子 | 读什么 | 现状 |
|---|---|---|
| `blockAt(pos)` | 方块（未加载返回 `null`） | 🔀 `atom_perceive.js:26`、`executor.js:67` 各有一份包装 |
| `findBlocks(match, {maxDistance, count})` | `bot.findBlocks` | 🔀 |
| `entities(filter, radius)` / `nearestEntity(filter)` | `bot.entities` / `bot.nearestEntity` | 🔀 |
| `inventory()` / `heldItem()` | 背包计数 / 手持 | 🔀 `atom_items.findItem` |
| `vitals()` | health / food / saturation / oxygenLevel | 🆕 |
| `pose()` | 位置、速度、yaw/pitch、onGround、isInWater | 🆕 |
| `worldState()` | timeOfDay、isRaining、thunderState | 🆕 |
| `cursorBlock(maxDist)` | `bot.blockAtCursor` | 🆕 |
| `canSee(block)` | `bot.canSeeBlock` | 🆕 |
| `windowSlots()` | 当前窗口的格子 | ✅ `atom_container.windowItems` |
| `lightAt(pos)` / `digTimeOf(block)` | 光照 / `bot.digTime` | 🆕 |

### 3.6 `atom_wait.js` — 等待（4）

| 原子 | 说明 | 现状 |
|---|---|---|
| `waitTicks(n)` | `bot.waitForTicks(n)` | 🆕 |
| `waitEvent(name, {filter, timeout})` | 等一次事件；超时或中断时**一定**摘掉监听 | 🆕 |
| `waitUntil(predicate, {timeoutMs, intervalMs, bot})` | 轮询判据；**必须传 `bot`** 才响应中断（`interruptible` 默认 `!!bot`） | ✅ `atom_wait.js:38` |
| `waitItem({countFn, minGain, timeoutMs})` | 盯背包计数上涨 | ✅ `atom_wait_item.js` |

合计：移动 5 + 视角鼠标 11 + 物品栏 4 + 杂项 6 + 读取 14 + 等待 4 = **44**。

## 4. 现有 23 个 `atom_*.js` 按新定义归位

| 文件 | 归到 | 说明 |
|---|---|---|
| `atom_look` `atom_wait` `atom_wait_item` | **原子** | 本来就是 |
| `atom_stand` `atom_safe` `atom_perceive` `atom_classify` `atom_tree` `atom_find_drops` `atom_stuck_detect` `atom_query` | **查询**（§5） | 无副作用，Phase R 改名 `query_*` |
| `atom_dig` `atom_place` `atom_use` `atom_container` `atom_attack` `atom_items` `atom_climb` `atom_pillar` | **动作**（[02](02_actions.md)） | `atom_use` 拆成 toggle / sleep / harvest；`atom_attack` 拆成单次挥击 + `flow_fight` |
| `atom_tunnel` | `tunnelStep` → **流程**；`checkStep` / `computeSafeZone` → 查询 | `tunnelStep` 调了 `digBlock` 和 `moveToXZ`，是两个动作的组合 |
| `atom_move` | **导航**（pathfinder 封装） | 走 `pathfinder.goto`，按定义不是原子 |
| `atom_contract` | 基础设施 | |
| `atom_boat` | **冻结** | src 里没人 import；Paper 1.21.8 上船过水走不通 |

整个文件就是原子的只有上面 3 个；另有 `closeContainer` / `windowItems` 两个函数已经是原子、只是住在 `atom_container` 里。
其余都要从散落的代码里收拢或新写。

## 5. 查询（`query_*`）

查询 = 多次读取组合成一个判断，**无副作用**。任何层都能调；查询只许调读取原子和别的查询，不许调输入原子。

| 查询 | 回答什么 | 现在在哪 |
|---|---|---|
| `canStand(pos)` / `findStandSpot(target, opts)` | 这格能不能站 / 够得着目标的站位 | `atom_stand.js:50` / `:101` |
| `isSafe(target, opts)` | 落点有没有悬空、液体、危险方块 | `atom_safe.js:58` |
| `eyePosition` / `reachDistanceTo` / `canReach` / `blockBelow` / `countItem` | 眼睛位置、到目标的距离、够不够得着、脚下第一块实心、背包计数 | `atom_perceive.js` |
| `classifyLog(pos)` / `isProtected(pos)` | 这块原木是树还是建筑 / 是不是保护区 | `atom_classify.js:42` / `:110` |
| `scanTree` / `judgeTree` / `planFelling` | 整棵树的形状、能不能砍、砍的顺序 | `atom_tree.js` |
| `findDrops(opts)` | 附近掉落物 | `atom_find_drops.js:31` |
| `movedEnough` / `weightedMove` / `realMove` / `detectTrapped` | 有没有真的在动、是不是被困 | `atom_stuck_detect.js` |
| `checkStep` / `computeSafeZone` / `inSafeZone` | 掘进下一步安不安全 | `atom_tunnel.js:58-108` |
| `query(target)` | 玩家 / 实体 / 方块在哪 | `atom_query.js:83` |

例外：`atom_query` 的 `PlayerTracker` / `ensureTracking` 会挂事件监听，`queryPlayerExact` 走 RCON 网络请求，都不是纯查询。
Phase R 时把它们挪进基础设施，`query_*` 只留纯函数。

`atom_perceive` 里的 `blockAt` / `findBlocks` / `playerPos` 是读取，收进 `atom_read`（§3.5）。

> ✅ **D27**（2026-11-01 已修）：`atom_stand.js` 的 `PASSABLE` 原来含 `lava`，`canStand` 会把脚位 / 头位是岩浆的格子判成能站；已去掉，回归 `tools/atom_stand_unit.mjs`。

## 6. 测试与落地（Phase A）

**测试**

- 原子够薄，离线用假 bot 测：断言调了哪个 `bot.*`、参数对不对、`finally` 里松了键、中断后 150ms 内返回。放 `tools/unit_*.mjs`，接进 `tools/unit_all.mjs`。
- 真实物理效果（跳没跳上去、方块碎没碎）只在测试服用 `tools/arena.mjs` 租场地验，不在离线测试里模拟。

**落地顺序**（每步都要离线全绿，且真机逐 action 基线 99/110 不掉）

1. 建 `atom_input_move.js` + `atom_read.js`；executor 潜水、`atom_climb`、`atom_pillar` 改调 `holdKey`，顺手修 D16。
2. 建 `atom_input_mouse.js`；`digBlock` / `placeBlockAt` / `atom_use` 改走 `holdDig` / `placeAgainst` / `useOnBlock`，顺手修 D21、D22。
3. 建 `atom_input_misc.js` 和带白名单的 `command()`；`skills.js` 里的斜杠命令改调它，作弊模式命令单列。
4. `tools/preflight.mjs` 加扫描：A1 列的 API 出现在 `atom_input_*.js` 之外就报错。`skills.js`、`modes.js`、`npc/`、`tasks/` 先进豁免名单，迁一个删一个。
