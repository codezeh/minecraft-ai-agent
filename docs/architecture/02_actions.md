# 动作层（Actions）

> 2026-11-01 恢复。`ARCHITECTURE_REDESIGN.md §4.1` 曾把动作层并入任务层；
> 原子收窄为"一次玩家输入"（[`01_primitives.md`](01_primitives.md)）之后，"选工具→挖→确认碎了"这种固定小序列需要一个家，就是这一层。
> 旧的能力盘点表在 [`../legacy/02_actions.md`](../legacy/02_actions.md)。契约仍以 `ARCHITECTURE_REDESIGN.md §6` 为准。

## 1. 定义

**动作 = 固定顺序的几个原子 + 前置检查 + 后置校验，完成一件能用一个动词说清的事。**
挖一个方块、放一个方块、吃一口、合成一次、开一次门。

| 必须 | 不许 |
|---|---|
| 前置不满足就返回明确 code，**不做任何尝试** | 寻路（够不着就返回 `OUT_OF_REACH`，走过去是上层的事） |
| 做完**读世界**校验（方块真没了 / 背包真多了），不信 API 返回值 | 重试、换策略、换目标 |
| 自己计时，入口和等待中查中断 | 调别的动作（共用逻辑抽成查询或普通函数） |
| 返回 `ActionResult`，code 取自白名单 | 改全局状态（mode、记忆、地标） |
| 所有退出路径松键、关窗口 | |

现有 23 个 `atom_*.js` 里有 8 个本来就是这个形状（见 [`01_primitives.md §4`](01_primitives.md)），这一层主要是**改名 + 补缺**，不是重写。

## 2. 怎么调原子

以 `digBlock` 为例（现 `atom_dig.js`，改名后 `act_dig.js`）：

```js
export async function digBlock(bot, target, opts = {}) {
    if (bot.interrupt_code) return fail('INTERRUPTED', '被取消了');
    const t = normalizeTarget(target);                    // 只收 {kind:'block', pos}
    const block = read.blockAt(bot, t.pos);               // 读取原子
    if (!block) return fail('NO_DATA', '区块没加载');
    if (!canReach(bot, t.pos, digReach())) return fail('OUT_OF_REACH', '够不着');   // 查询；不走过去
    const tool = bestToolFor(bot, block);                 // 普通函数（读背包 + 规则表）
    if (needsTool(block) && !tool) return fail('NO_TOOL', `${block.name} 要镐子`);
    if (tool) await bot.equip(tool, 'hand');              // mineflayer 现成动作，见下
    const r = await input.holdDig(bot, block, { timeout: read.digTimeOf(bot, block) * 2 + 500 });  // 输入原子
    if (!r.ok) return r;                                  // 原子失败原样上报，不重试
    if (!isAir(read.blockAt(bot, t.pos))) return fail('BLOCKED', '挖完还在');        // 后置：读世界
    return ok({ pos: t.pos, dugBlock: block.name });
}
```

### mineflayer 现成动作（动作层可直接调，不必拆成原子）

`equip` `unequip` `toss` `tossStack` `craft` `recipesFor` `consume` `fish` `sleep` `wake`
`openContainer` `openFurnace` `openVillager` `trade` `openAnvil` `openEnchantmentTable`
—— 它们本身就是"开窗口→点几下→关窗口"的固定序列，自己重写只会更差。preflight 的 A1 扫描对这些放行。
**`pathfinder.*` 例外**：只许在导航层用。

调用方（流程）这样用动作：

```js
const r = await digBlock(bot, { kind: 'block', pos }, { timeout: 8000 });
switch (r.code) {
    case 'OK': break;
    case 'OUT_OF_REACH': /* 交给 onFail：restep（换站位再来） */ break;
    case 'NO_TOOL': /* abort，带着 code 上报 */ break;
}
```

动作不重试；"再来一次"永远由流程的 `onFail` 表决定（[`04_skills.md §3`](04_skills.md)）。

## 3. 清单（42 个）

表里省略 `bot` 参数。"现状"：✅ 有，改名即可 / 🔀 能从现有函数拆出 / 🆕 新写。

### 3.1 方块（8）

| 动作 | 前置 → 原子序列 → 后置 | 常见 code | 现状 |
|---|---|---|---|
| `digBlock(target)` | 可挖、够得着、有合格工具 → equip → `holdDig` → 那格变空气 | `OUT_OF_REACH` `NO_TOOL` `BLOCKED` `TIMEOUT` | ✅ `atom_dig`（等待中不查中断，D21） |
| `placeBlockAt(target, item)` | 有货、目标格空、有支撑面 → equip → `lookAt` → `placeAgainst` → 那格是该方块 | `NO_ITEM` `OCCUPIED` `NO_SUPPORT` `OUT_OF_REACH` | ✅ `atom_place`（同 D21） |
| `toggleBlock(target)` | 门/活板门/栅栏门/拉杆/按钮 → `useOnBlock` → `open`/`powered` 翻转 | `BLOCKED` `OUT_OF_REACH` | 🔀 从 `atom_use` 拆 |
| `harvestCrop(target)` | 作物成熟（`age` 满）→ `holdDig` → 方块没了 | `NOT_READY` | 🔀 从 `atom_use` 拆 |
| `tillSoil(target)` | 手里有锄、是泥土/草方块 → `useOnBlock` → 变耕地 | `NO_TOOL` `BLOCKED` | 🆕 |
| `plantSeed(target, seed)` | 耕地上方是空气、有种子 → `placeAgainst` → 作物出现 | `NO_ITEM` `OCCUPIED` | 🆕 |
| `boneMeal(target)` | 作物未熟、有骨粉 → `useOnBlock` → `age` 增加 | `NO_ITEM` `BLOCKED` | 🆕 |
| `bucket(target, mode)` | 装水 / 装岩浆 / 倒出 → `useHeld` → 桶的种类变了 | `NO_ITEM` `BLOCKED` | 🆕 |

### 3.2 物品与容器（7）

| 动作 | 前置 → 原子序列 → 后置 | 常见 code | 现状 |
|---|---|---|---|
| `equip(item, slot)` | 背包有 → `bot.equip` → 该槽是它 | `NO_ITEM` | ✅ `atom_items.equipItem`（只校验了手，没校验护甲槽） |
| `unequip(slot)` | 该槽非空、背包有空位 → `bot.unequip` → 该槽空 | `INVENTORY_FULL` | 🆕 |
| `dropItem(item, n)` | 背包有 → `bot.toss` → 数量减少 | `NO_ITEM` | ✅ `atom_items.dropItem`（src 里没人用） |
| `openContainer(target)` | 是容器、够得着 → `bot.openContainer` 等 → 窗口开 | `OUT_OF_REACH` `NO_TARGET` | ✅ `atom_container` |
| `deposit(item, n)` | 容器窗口开着、背包有 → `window.deposit` → 两边计数对上 | `WINDOW_CLOSED` `INVENTORY_FULL` | 🆕 |
| `withdraw(item, n)` | 容器窗口开着、容器有 → `window.withdraw` → 两边计数对上 | `WINDOW_CLOSED` `INVENTORY_FULL` | 🆕 |
| `closeContainer()` | — → `closeWindow` | — | ✅ `atom_container` |

`deposit` / `withdraw` 以"窗口已开"为前置，**不自己开**；开、存、关串起来是流程 `flow_store` / `flow_fetch` 的事。

### 3.3 合成与加工（6）

| 动作 | 前置 → 原子序列 → 后置 | 常见 code | 现状 |
|---|---|---|---|
| `craftOnce(item, n)` | 有配方、料够；3×3 时工作台在 `maxReach` 内 → `bot.craft` → 产物增加 n | `NO_RECIPE` `NO_ITEM` `NO_WORKSTATION` | 🔀 `skills.craftRecipe` |
| `furnaceLoad(furnace, input, fuel)` | 够得着熔炉、有料有燃料 → `openFurnace` → `putInput` / `putFuel` → 关 | `NO_ITEM` `OUT_OF_REACH` | 🔀 `skills.smeltItem` |
| `furnaceCollect(furnace)` | 够得着 → `openFurnace` → `takeOutput` → 背包增加 | `NOT_READY` `INVENTORY_FULL` | 🔀 `skills.smeltItem` |
| `brewOnce(stand, ingredient)` | 酿造台、水瓶、材料 → 开窗放料 → 等完成 → 取出 | `NO_ITEM` `NOT_READY` | 🆕 P2 |
| `enchantOnce(table, item, slot)` | 附魔台、青金石、经验够 → `openEnchantmentTable` → `enchant` | `NO_ITEM` `BLOCKED` | 🆕 P2 |
| `anvilCombine(anvil, a, b)` | 铁砧、经验够 → `openAnvil` → `combine` | `NO_ITEM` `BLOCKED` | 🆕 P2 |

`craftOnce` 不走到工作台、不放工作台；"附近没有就放一个"是 `flow_craft` 的事。

### 3.4 生存与战斗（9）

| 动作 | 前置 → 原子序列 → 后置 | 常见 code | 现状 |
|---|---|---|---|
| `eat(food?)` | 饱食度 < 20、有食物 → equip → `bot.consume` → 饱食度上升 | `NO_ITEM` `NOT_READY` | 🔀 `skills.consume`（返回 boolean，不校验饱食度） |
| `drinkPotion(type)` | 有该药水 → equip → `bot.consume` → 获得效果 | `NO_ITEM` | 🆕 |
| `sleepInBed(target)` | 是床、够得着、夜里或雷雨 → `bot.sleep` → `isSleeping` | `NOT_READY` `OUT_OF_REACH` | 🔀 从 `atom_use` 拆 |
| `wake()` | 在睡 → `bot.wake` → 不在睡 | — | 🔀 从 `atom_use` 拆 |
| `attackOnce(entity)` | 在 `maxReach` 内、攻击冷却好了 → `lookAt` → `attack` → 目标掉血或死亡 | `OUT_OF_REACH` `NO_TARGET` | 🔀 `atom_attack` 现在是"打到死"的循环，循环挪到 `flow_fight` |
| `raiseShield()` / `lowerShield()` | 副手是盾 → `useHeld({hold})` / `releaseUse` | `NO_ITEM` | 🆕 |
| `shootBow(target, chargeMs)` | 有弓有箭 → equip → `lookAt`（含抛物线）→ `useHeld({hold})` 等 chargeMs → `releaseUse` | `NO_ITEM` | 🆕 |
| `throwItem(item, target)` | 雪球 / 末影珍珠 / 喷溅药水 → equip → `lookAt` → `useHeld` | `NO_ITEM` | 🆕 |

### 3.5 实体交互（7）

| 动作 | 前置 → 原子序列 → 后置 | 常见 code | 现状 |
|---|---|---|---|
| `feedEntity(entity, food)` | 够得着、手里是对的食物 → equip → `useOnEntity` → 进入繁殖状态 | `NO_ITEM` `OUT_OF_REACH` | 🆕 |
| `shear(entity)` | 有剪刀、羊有毛 → equip → `useOnEntity` → 掉羊毛 | `NO_TOOL` `NOT_READY` | 🆕 |
| `milk(entity)` | 有空桶 → equip → `useOnEntity` → 桶变奶桶 | `NO_ITEM` | 🆕 |
| `leash(entity)` | 有拴绳 → equip → `useOnEntity` | `NO_ITEM` | 🆕 |
| `tradeOnce(villager, index)` | 够得着、货够 → `openVillager` → `trade` → 关 | `NO_ITEM` `BLOCKED` | 🔀 `skills.tradeWithVillager` |
| `mount(vehicle)` | 附近有载具 → `command('ride …')` → `bot.vehicle` 非空 | `NO_VEHICLE` `RIDE_FAILED` `NO_PERMISSION` | 🔀 `atom_boat` |
| `dismount()` | 在载具上 → `bot.dismount` / `command('ride … dismount')` → 不在载具上 | `NOT_MOUNTED` | 🔀 `atom_boat` |

### 3.6 身体（5）

| 动作 | 前置 → 原子序列 → 后置 | 常见 code | 现状 |
|---|---|---|---|
| `stepInto(cell)` | 相邻一格、能站 → `lookAt` 格心 → `holdKey('forward', {until: 进格})` → 脚位在该格 | `BLOCKED` `UNSAFE` `TIMEOUT` | 🆕 P1 |
| `climb(dir)` | 在梯子 / 藤蔓上 → `holdKey('jump')` 或 `holdKey('sneak')` → 高度变化 | `NOT_CLIMBABLE` `HEIGHT_MISS` | ✅ `atom_climb.climbUp` / `climbDown`（D16） |
| `pillarUp()` | 手里有垫脚块、头顶空 → `holdKey('jump')` 到顶点 → `placeAgainst` 脚下 | `NO_ITEM` `BLOCKED` | ✅ `atom_pillar.pillarUpOnce` |
| `sinkInWater(targetFeetY)` | 在水里 → `holdKey('sneak', {until: 脚位到位})` | `HEIGHT_MISS` `TIMEOUT` | 🔀 executor 潜水循环（D9：30 秒不查中断） |
| `fishOnce()` | 手里有鱼竿、面前是水 → `bot.fish()` → 背包多一样 | `NO_TOOL` `TIMEOUT` | 🆕 |

`stepInto` 为什么是 P1：executor 现在每个单格步骤都调 `moveToXZ`，也就是每走一格都起一次 pathfinder。
爬梯前空等 20 秒是这个结构的一个症状：目标格是梯子，`GoalNearXZ` 永远不 resolve。`4b4ac1c` 已针对这个成因加守卫修掉（21958 → 1959ms），但"单格也走 pathfinder"的结构还在。
换之前先跑逐 action 基线（`REFACTOR_ANALYSIS.md` Phase 3，99/110），换完不能掉。那次修复的教训同样适用：判据要钉在具体成因上，必须多场景验证。

**合计**：方块 8 + 物品容器 7 + 合成加工 6 + 生存战斗 9 + 实体 7 + 身体 5 = **42**。其中 21 个复用或拆分现有代码，21 个新写。

## 4. 新错误码（7 个，用到时再加）

`fail()` 遇到 `CODES` 之外的码直接抛异常，所以下面的码要**先加进 `atom_contract.js` 的 `CODES`**，再写用它的动作。
登记流程见 [`ARCHITECTURE_REDESIGN.md §6.2`](ARCHITECTURE_REDESIGN.md)。

| 码 | 意思 | 要和谁分开 | 上层怎么处理不同 |
|---|---|---|---|
| `NOT_READY` | 东西在，时机不对（作物没熟、熔炉没烧完、白天睡不了） | `BLOCKED` | 等一会再试，不换目标 |
| `NO_RECIPE` | 没有这个配方 | `NO_ITEM` | 缺料可以去采；没配方采了也没用 |
| `NO_WORKSTATION` | 需要工作台 / 熔炉，附近没有 | `OUT_OF_REACH` | 去放一个，不是走近一点 |
| `INVENTORY_FULL` | 背包满了 | `BLOCKED` | 先存箱子，不是换目标 |
| `PREEMPTED` | 被更高优先级任务挤掉 | `INTERRUPTED` | 任务单回 `ready`，之后接着做；`INTERRUPTED` 是玩家喊停，任务单 `cancelled` 或 `paused` |
| `CLAIM_CONFLICT` | 资源被别的 bot 预约了 | `OCCUPIED` | 换一个目标；`OCCUPIED` 是那格本身有东西 |
| `LEASE_LOST` | 任务单租约过期，被收回 | `TIMEOUT` | **立刻停**，不写结果（别人可能已经接手） |

`PREEMPTED` 只由调度器写进任务单结果；流程不管被谁打断，一律返回 `INTERRUPTED`（[07 §4](07_control.md)）。

## 5. 改名与 import 规矩（Phase R）

前缀就是层级：看文件名就知道它能调谁。

| 前缀 | 层 | 现在对应的文件 |
|---|---|---|
| `atom_input_*` / `atom_read` / `atom_wait` | 原子 | `atom_look` `atom_wait` `atom_wait_item` |
| `query_*` | 查询 | `atom_stand` `atom_safe` `atom_perceive` `atom_classify` `atom_tree` `atom_find_drops` `atom_stuck_detect` `atom_query` |
| `act_*` | 动作 | `atom_dig` `atom_place` `atom_use` `atom_container` `atom_attack` `atom_items` `atom_climb` `atom_pillar` |
| `nav_*` | 导航 | `nav_core`、`task_hop`（`hopTo` 薄适配）、`atom_move`（→ `nav_pathfinder`），以及 executor 和规划器（见 [05](05_navigation.md)） |
| `flow_*` | 流程级复合 | `task_collect` `task_follow` `task_pickup` `task_platform` `skill_escape` `skill_clear`、`atom_tunnel.tunnelStep` |
| `strat_*` | 策略级复合 | 还没有 |
| `board_*` | 任务板 | 还没有 |
| 不带前缀 | 基础设施 | `atom_contract`（→ `contract`）`step_runner` `trace_bus` `terrain3d` `task_modes` … |

- `task_*` 前缀退役："task" 以后只指任务板上的任务单，免得混。
- `task_collect` 和 `skill_collect` 是同一件事的两半（前者管 deadline 和换目标，后者管一轮怎么砍），合成一个 `flow_collect`，`skill_collect` 的 plan / run 留作内部函数。

**import 规矩**（`tools/preflight.mjs` 按前缀检查）

| 谁 | 能 import |
|---|---|
| 原子 | mineflayer、基础设施 |
| 查询 | 读取原子、别的查询 |
| 动作 | 原子、查询、mineflayer 现成动作（§2）。动作之间不互相调用，换手直接用 `bot.equip`（§2 示例就是这样） |
| 导航 | 原子、查询，以及单格动作 `stepInto` `climb` `pillarUp` `sinkInWater` `digBlock` `placeBlockAt` |
| 流程 | 动作、导航（只经 `nav_core.goTo`）、查询、等待原子、`releaseAll`、别的流程 |
| 策略 | 流程、查询、任务板客户端 |
| `commands/` | 流程、策略、任务板、查询；**不 import 动作和原子** |

现在 `commands/actions.js:8` 直接 import 了 `atom_place.placeBlockAt`，Phase 5.4 改成调流程。

**怎么改**：新文件直接用新前缀；旧文件 `git mv` 后在原路径留一行 `export * from './新名.js'` 转发；
等所有 import 改完、preflight 的前缀检查通过，再删掉转发文件。时间放在 Phase A 之后、补动作之前（2026-11-01 已确认），免得新写的文件改两次名。
