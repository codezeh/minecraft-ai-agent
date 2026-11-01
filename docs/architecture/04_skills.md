# 复合技能（Composite Skills）

> 2026-11-01 新增（原计划的 `04_skills.md`）。
> 回答四个问题：复合技能分几级、怎么调下层、怎么规划、写一个新的要守什么规范；最后是清单。
> 下层：[`02_actions.md`](02_actions.md)（动作）、[`05_navigation.md`](05_navigation.md)（导航）。
> 上层：[`06_task_board.md`](06_task_board.md)（任务板，管"谁什么时候做"）。

## 1. 两级

| | 流程级 `flow_*` | 策略级 `strat_*` |
|---|---|---|
| 解决什么 | **一个目标、一个区域**：采 N 个木头、熔 N 个铁、跟着玩家 | **多个目标、要规划资源**：做一套铁工具、过第一夜、建个家 |
| 调谁 | 动作、`nav_core.goTo`、查询、别的流程 | **只调流程**（经任务板派子任务单） |
| 怎么规划 | 固定模板 → 步骤序列（§3.1） | 需求图反推（§3.2） |
| 失败了 | `onFail` 表：retry / restep / replan / skip / abort | 换来源（挖不到→开箱→交易），或把缺口报给模型 |
| 时长 | 秒到分钟 | 分钟到几十分钟，**必须能断点续做** |
| 现状 | 约 6 个（采集、跟随、平台、拾取、脱困、清障）+ 导航 | 0 |

**为什么要分两级**：把"挖铁→熔炼→合成"写进一个函数，它就得同时管寻路、挖矿、背包、配方，
又回到 678 行 `collect()` 的老路（`交接文档.md` 记录：24 小时改 12 次、8 个 bug）。
策略只决定"先做哪个流程"，流程只管"把这一件事做完"。

## 2. 调下层的规矩（流程级）

调用写法：

```js
const r = await digBlock(bot, { kind: 'block', pos }, { timeout: 8000 });
if (!r.ok) { /* 只看 r.code，查 onFail 表 */ }
const n = r.data.count;   // 数据只从 r.data 的白名单字段取，不解析 message
```

| # | 规矩 | 来源 |
|---|---|---|
| S1 | 只调动作、`nav_core.goTo`、查询、等待；**不直接按键**（收尾 `releaseAll` 除外） | `01_primitives.md` A1 |
| S2 | 每一步之间查 `bot.interrupt_code` 和 `ctx.deadline` | D9 |
| S3 | `bot.interrupt_code` **只读不写** | D19：`task_follow` 写 `false` 可能把真中断吞了 |
| S4 | 改了全局状态（暂停 mode、开 ScaffoldTracker）之后**立刻**进 `try`，`finally` 里恢复 | D6：`task_collect` 早退漏恢复 |
| S5 | 下层每个可能的 code 在 `onFail` 表里都有去处；表里没有的 = 整体失败并带原 code 上报，**不许落进默认 next** | D3 |
| S6 | 报数按背包/世界的**实际增量**算，不按调用成功的次数 | S2 验收「报数 = 背包实际增量」 |
| S7 | 同一目标连续 2 次无进展就拉黑换目标；每个循环有次数或时间上限 | `ok` 但零进展导致的无限空转（`legacy/技术总结.md §5.1`） |
| S8 | 选项名照抄 `ARCHITECTURE_REDESIGN.md §6.4`，拿不准就打开被调函数看签名 | `{timeout}` vs `{timeoutMs}` 静默用默认值 |

## 3. 怎么规划

### 3.1 流程级：plan / run 分开（`step_runner.js` 已经实现）

- `plan(bot, args)` 是**纯函数**：只读世界，不动 bot，同样输入同样输出。能打印、能单测、能人工检查。
- `runSteps(bot, steps, handlers, opts)` 只按序列跑，**不重新决策**；失败只查每步的 `onFail` 表。

```js
// planCollect 的产出（打印出来就是这样）
[
  { step: 1, atom: 'goTo',     args: { target: { kind: 'point', pos } }, onFail: [{ code: 'NO_PATH', action: 'skip' }] },
  { step: 2, atom: 'digBlock', args: { target: { kind: 'block', pos } }, onFail: [{ code: 'OUT_OF_REACH', action: 'restep' }] },
  { step: 3, atom: 'pickup',   args: { near: pos },                     onFail: [{ code: '*', action: 'skip' }] },
]
```

`onFail` 的 action 只有五种：

| action | 含义 |
|---|---|
| `retry` | 原样再跑这一步 |
| `restep` | 换站位再跑这一步 |
| `replan` | 回到 `plan()` 重算剩下的步骤 |
| `skip` | 跳到下一个同类步骤 |
| `abort` | 整体失败，带原 code 上报 |

`code: '*'` 是兜底；`PARTIAL`（`moveTo` 推进了但没到）通常配 `replan`。

### 3.2 策略级：需求图反推

从目标往下拆，**已有的剪掉**，剩下的按依赖排成子任务单：

```
iron_pickaxe ×1                         （前提：有工作台；铁镐要求先有石镐才挖得了铁）
├─ iron_ingot ×3 ← 熔炼 raw_iron ×3     需要：熔炉（8 圆石）+ 燃料
│                 └─ raw_iron ×3 ← 挖 iron_ore，需要石镐
└─ stick ×2      ← 合成，2 个 oak_planks 出 4 根
```

**不要从零写规划器**：上游 `src/agent/npc/item_goal.js` 已经有 `ItemNode` / `ItemWrapper`，
能从 minecraft-data 的配方、方块掉落、熔炼、狩猎四种来源建出这棵树（`setRecipe` / `setCollectable` / `setSmeltable` / `setHuntable`），
`agent.js:9` 的 `NPCContoller` 在用它。要改的只是**执行端**：它现在直接调旧 `skills.*`，改成输出子任务单，
每张单带 `why`（"为了 iron_pickaxe 需要 3 个 iron_ingot"）。失败时把 code 和 why 一起交给模型，模型才知道该换路还是放弃。

### 3.3 失败往上走

| 层 | 失败时 |
|---|---|
| 动作 | 原样返回 code，不重试 |
| 流程 | 查 `onFail`；处理不了 → 返回 `fail(code, …)`，带 `count / want / failed / step` |
| 策略 | 换来源重派子单；来源都试过 → 返回缺口清单（每项带 code 和 why） |
| 模型 | 看 code + why：换目标 / 问玩家 / 放弃 |

> 缺口清单要用的 `missing` 字段不在 `ARCHITECTURE_REDESIGN.md §6.3` 的 data 白名单里，落地前先加进白名单。

## 4. 写一个新复合技能的规范

### 4.1 文件结构

```js
// flow_smelt.js
export const manifest = {
    name: 'smelt',
    level: 'flow',                                  // 'flow' | 'strat'
    summary: '把背包里的原料熔成 N 个成品（会自己找或放熔炉）',   // 给模型看的一句话
    params: { input: 'string', count: 'int 1..64', fuel: 'string?' },
    needs: { items: ['<input>', 'fuel'], near: [] },                // 前置
    claims: ['station:furnace'],                                     // 多 bot 时要预约的资源（06 §9.2）
    codes: ['NO_ITEM', 'NO_WORKSTATION', 'NOT_READY', 'INVENTORY_FULL', 'TIMEOUT', 'INTERRUPTED'],
    resumable: true,                                // 能从 checkpoint 续做
    timeoutMs: 600000,
};
export function plan(bot, args, ctx) { /* 纯函数 → steps[] */ }
export async function run(bot, args, ctx) { /* plan + runSteps；返回 ActionResult */ }
```

### 4.2 `ctx`：调度器注入的运行环境（唯一入口）

| 字段 | 用途 |
|---|---|
| `ctx.mapDir` | 3D 地图目录。**流程不许自己拼路径**（现在 `actions.js` 和 `skills.js` 里各自在拼 `./bots/<名字>/map`） |
| `ctx.deadline` | 绝对时间戳；每步之间和它比 |
| `ctx.onEvent(e)` | 进 `trace_bus`，自动带上 `jobId` |
| `ctx.checkpoint` / `ctx.save(obj)` | 断点读写（任务板落盘） |
| `ctx.reserve(key)` / `ctx.release(key)` | 资源预约；单 bot 时恒成功 |
| `ctx.jobId` | 当前任务单 id；从命令直接调用时为 `null` |

### 4.3 返回

- 成功：`ok({ count, want, costMs, … })`
- 部分完成或失败：`fail(code, message, { count, want, failed: [{pos, code, message}], step })` —— 任务板靠 `count / want` 判断要不要补单。

### 4.4 合入前自查

| # | 检查 | 机检？ |
|---|---|---|
| 1 | `manifest` 有 §4.1 列的全部字段，`name` 在注册表里唯一 | ✅ |
| 2 | `codes` 里每个码都在 `CODES` 里 | ✅（同 preflight 的错误码审计） |
| 3 | `plan()` 不 import 输入原子 / 动作 | ✅（import 扫描，`02_actions.md §5`） |
| 4 | 每个循环有次数或时间上限 | 人工 |
| 5 | 改全局状态的地方都在 `try/finally` 里 | 人工 |
| 6 | `onFail` 覆盖被调者可能返回的所有码 | 半自动（对照被调者 `manifest.codes`） |
| 7 | 报数 = 实际增量 | 真机用例 |
| 8 | `resumable: true` 的，每完成一个计数单位就 `ctx.save()` | 人工 |
| 9 | 离线单测进 `tools/unit_all.mjs`；真机用例用 `tools/arena.mjs` 租场地 | 人工 |
| 10 | 在 `docs/自研申报.md` 登记 | ✅（`tools/audit_rules.mjs`） |

### 4.5 `params` 写法

```js
params: {
    block: 'block',            // 方块名，按 minecraft-data 查，不认识的直接拒
    item: 'item',              // 物品名，同上
    count: 'int 1..64 = 1',    // 整数、范围、默认值
    fuel: 'item?',             // ? = 可选
    dir: 'enum(n,s,e,w)',
    at: 'pos',                 // 方块坐标，面位（00 §4）
    area: 'area',              // 中心 + 半径
    target: 'entity',          // 实体类型或 uuid
},
```

- 命令里怎么传：`!do("collect", "block=oak_log count=16")`，**一个 `key=value` 串，空格分隔**；`pos` 写 `at=120,64,-30`，`area` 写 `area=120,64,-30:16`
- 不能传 JSON：`commands/index.js:57` 的解析器只认数字、`true/false` 和不含双引号的 `"…"`，JSON 里的双引号传不进去
- 校验不过就不执行，回模型一句"参数错：count 要 1..64"；不进任务板，也不产生 code
- §4.1 例子里的 `'string'` 是旧写法；新代码用 `item` / `block`，多一道名字校验

### 4.6 注册表与 `ctx` 工厂

`src/agent/library/composite_registry.js`（基础设施，不带前缀；`skill_library.js` 这个名字上游已经占了）：
- 显式 import 每个 `flow_*` / `strat_*`，不扫目录：顺序确定，preflight 能逐个检查
- 启动时校验每个 manifest（§4.4 第 1、2 条，加上 `params` 能解析），不合格就启动失败，不等到运行时
- `makeCtx(agent, job)`：`mapDir` 由 helpers 统一拼（Phase 5.3）；`deadline` = 单子的 deadline，没有就 `now + manifest.timeoutMs`；`onEvent` = 唯一写 trace_bus 的那一层，自动带 `jobId` / `skill`（09 §2）；`checkpoint` / `save` 有单走 `board_client`，没单存在内存里；`reserve` / `release` 没有任务板时恒成功
- `!do` 的路径：校验参数 → 有任务板就建一张 9 级个人单交给调度器；还没任务板（B1 之前）就直接在 `runAction` 里跑，`timeout` 按 deadline 传（07 §8）

## 5. 怎么暴露给模型

**不给每个复合技能单开命令**（命令文档会撑爆上下文），只加两条：

| 命令 | 作用 |
|---|---|
| `!do(name, args)` | 按注册名执行复合技能；`args` 是 `key=value` 串（§4.5），按 `manifest.params` 校验；回给模型 `code + count/want + failed 摘要`（格式见 08 §4） |
| `!listSkills()` | 列出所有复合技能：从 `manifest.summary` + `params` **自动生成**，不再从函数体截 JSDoc（D24） |

现有的 `!collectBlocks` / `!followPlayer` 等保留（模型已经会用），内部改调对应的 flow。

## 6. 复合技能清单

### 6.1 P0 流程卡片

#### `flow_collect` — 采 N 个某种方块（✅ 已有）

- **参数**：`block`、`count`、`radius?`
- **plan**：`findBlocks` → 按距离排序 → 每块 `[reserve block:… → goTo 站位 → digBlock → pickup]`
- **onFail**：`NO_PATH` `NO_REACH` `OUT_OF_REACH` `STUCK` `CLAIM_CONFLICT` → `skip`（拉黑这块）；`NO_TOOL` → `abort`（上层 `strat_obtain` 去做工具）；`TIMEOUT` → `retry` 1 次再 `skip`
- **完成**：背包增量 ≥ `count`；目标用完 → `fail('NO_TARGET', …, {count, want})`
- **现状**：`task_collect` + `skill_collect`，缺 manifest 和 ctx

#### `flow_craft` — 合成 N 个（P0）

- **参数**：`item`、`count`
- **plan**：`bot.recipesAll` 为空 → `NO_RECIPE`；有配方但 `recipesFor` 为空 → 缺料 `NO_ITEM` → 要 3×3 就找附近工作台，没有就放一个（背包没有先合一个，4 木板）→ `goTo` 工作台 → `craftOnce` 到够数
- **onFail**：`NO_ITEM` → `abort`，`data.missing` 列出缺什么，交给 `strat_obtain`；`NO_WORKSTATION` `OUT_OF_REACH` → `restep`
- **完成**：产物增量 ≥ `count`
- **现状**：🔀 `skills.craftRecipe`（返回 boolean）

#### `flow_smelt` — 熔炼 N 个（P0）

- **参数**：`input`、`count`、`fuel?`
- **plan**：找附近熔炉并 `reserve station:furnace@…`，没有就放（背包没有先 `flow_craft` 一个，8 圆石）→ `goTo` → `furnaceLoad` → 每 10 秒 `furnaceCollect`，到够数或到 deadline
- **燃料**：默认顺序 煤 > 木炭 > 木板 > 原木（1 煤烧 8 个，1 木板烧 1.5 个）
- **onFail**：`NOT_READY` → 等 10 秒 `retry`；`NO_ITEM`（燃料或原料）→ `abort` 带 `missing`；`INVENTORY_FULL` → `abort`，上层先 `flow_store`
- **可续**：checkpoint 记熔炉坐标和已装数量，重启后先去取
- **现状**：🔀 `skills.smeltItem`（站在熔炉前干等）

#### `flow_mine` — 挖 N 个矿（P0）

- **前提**：D15（液体地板被当实心）已于 2026-11-01 修好，`checkStep` 遇到水 / 岩浆地板报 `NO_FLOOR`
- **参数**：`ore`、`count`、`maxDepth?`
- **plan**：按矿种定目标高度（写进配置，例：铁 16、钻石 -58）→ `flow_tunnel` 阶梯下到那层 → 主巷道每隔 3 格开支巷 → 每步先看可见矿石，有就 `digBlock` + 捡 → 够数原路返回
- **安全**：每步 `checkStep`；掉血交给 `self_preservation` 反射，流程不自己判
- **onFail**：`LIQUID_RISK` `NO_FLOOR` → `replan` 换方向；`NO_TOOL` → `abort`
- **完成**：增量 ≥ `count`；到 `maxDepth` 或 deadline → `fail('TIMEOUT', …, {count, want})`
- **现状**：🆕（`atom_tunnel` 只有单步掘进）

#### `flow_build` — 按蓝图放方块（P0）

- **参数**：`blocks: [{x, y, z, name}]`（方块自己的坐标，不是脚位）
- **plan**：自下而上、同层由近到远排序 → 先算材料清单，不够直接 `fail('NO_ITEM', …, {missing})`，**不建一半** → 每块 `[findStandSpot → goTo → placeBlockAt]`；高处用 `pillarUp` 或 `ScaffoldTracker`，完工只拆自己放的脚手架（D7）
- **onFail**：`OCCUPIED` → 已是蓝图里的方块就算完成，否则 `digBlock` 后 `retry`；`NO_SUPPORT` → 先放下面那块再回来；`OUT_OF_REACH` → `restep`
- **完成**：逐格读回和蓝图一致；checkpoint 记已完成的序号
- **现状**：🆕（`task_platform` 是它的特例：平台）

#### `flow_farm` — 收一轮庄稼（P0）

- **参数**：`area: {center, radius}`、`crop`
- **plan**：扫区域 → 成熟的 `harvestCrop` → 空耕地 `plantSeed` → 裸泥土 `tillSoil` → 可选 `boneMeal` → `pickup`
- **一次调用只做一轮**，不在内部循环；要定期收由策略层或玩家再下单
- **onFail**：`NOT_READY` → `skip`；种子用完（`NO_ITEM`）→ 后面的种植步骤 `skip`，收割照做
- **完成**：返回 `{harvested, planted}`
- **现状**：🆕

#### `flow_fight` — 打一个或一群目标（P0）

- **参数**：`target`（实体类型或 uuid）、`maxKills?`、`retreatHp?`（默认 8）
- **plan**：最近的目标 `reserve entity:…` → 追到 `maxReach` 内 → 等冷却 → `attackOnce` → 目标死了换下一个
- **撤退**：血量 < `retreatHp` → `flow_escape`，返回 `ok({killed: false, retreated: true})`。撤退是正确行为，不算失败
- **onFail**：`NO_TARGET` → `skip`；`OUT_OF_REACH` → `restep`（再追）
- **和反射的区别**：`self_defense` / `cowardice` 是被动的，不经任务板；`flow_fight` 是主动去打
- **现状**：🔀 `atom_attack` 的"打到死"循环挪到这里

#### `flow_store` / `flow_fetch` — 存进 / 取出箱子（P0）

- **参数**：`items: {name: count}`、`chest?`
- **plan**：选箱子（指定的 > 记忆里同类的 > 最近的）→ `reserve container:…` → `goTo` → `openContainer` → 逐项 `deposit` / `withdraw` → `finally` 里 `closeContainer` → 更新箱子记忆（`bots/<名字>/memory/chests.json`）
- **onFail**：存时箱子满（`INVENTORY_FULL`）→ `replan` 换下一个箱子，都满了才 `abort`；取时背包满 → `abort` 带 `{count, want}`；没有箱子 → `NO_TARGET`
- **完成**：两边计数对上
- **现状**：🔀 `skills.putInChest` / `takeFromChest`

卡片里出现的新 `data` 字段（`missing` `killed` `retreated` `harvested` `planted`）要先加进 [`ARCHITECTURE_REDESIGN.md §6.3`](ARCHITECTURE_REDESIGN.md) 白名单。

### 6.2 其余流程

| 流程 | 做什么 | 优先级 | 现状 |
|---|---|---|---|
| `flow_goto` | 走到某处（给 `!do` 用的薄壳，内部就是 `nav_core.goTo`） | 已有 | ✅ `nav_core` |
| `flow_follow` | 跟随玩家或实体 | 已有 | ✅ `task_follow`（D19） |
| `flow_pickup` | 捡附近掉落物 | 已有 | ✅ `task_pickup`（D20） |
| `flow_escape` | 被困时挖路出去 | 已有 | ✅ `skill_escape` |
| `flow_platform` | 在中心点铺 3×3 平台 | 已有 | ✅ `task_platform`；以后改成调 `flow_build` |
| `flow_tunnel` | 朝一个方向掘进 N 格 | 已有 | 🔀 在 `atom_tunnel.tunnelStep` 外面套循环（D15） |
| `flow_clear` | 清掉挡路的藤蔓、树叶 | 已有 | ✅ `skill_clear` |
| `flow_eat` | 吃到饱食度达标 | P0 | 🔀 `skills.consume`；和 auto-eat 的冲突见下 |
| `flow_sleep` | 找床 → 走过去 → 睡到天亮 | P1 | 🔀 `skills.goToBed` |
| `flow_give` | 把东西交给玩家（走近 → 朝玩家丢） | P1 | 🔀 `skills.giveToPlayer`。bot 之间交接走 store + fetch（06 §9.4） |
| `flow_fish` | 钓 N 条鱼 | P1 | 🆕 循环 `fishOnce` |
| `flow_trade` | 和村民按指定交易做 N 次 | P1 | 🔀 `skills.tradeWithVillager` |
| `flow_breed` | 喂两只同种动物让它们繁殖 | P1 | 🆕 |
| `flow_explore` | 往没去过的方向走，沿途记地标 | P1 | 🆕 |
| `flow_shelter` | 天黑前搭一个能过夜的小屋 | P1 | 🆕（`strat_first_night` 要用，见 §7） |

合计 24 个流程：§6.1 的 9 个 + 上表 15 个；17 个是 P0 或已有，7 个 P1。

> ⚠️ **`flow_eat` 和 `mineflayer-auto-eat` 会打架**：auto-eat 饿了就自己吃，吃的时候会换掉手里的东西；`flow_eat` 同时在吃就会互相打断。
> **定了（2026-11-01）：`flow_eat` 开始时暂停 auto-eat，结束后恢复（同 S4）。** 做法：记下 `bot.autoEat.enabled` → `disableAuto()` →
> `bot.autoEat.isEating` 为真就先等它吃完 → 自己吃 → `finally` 里原来开着才 `enableAuto()`（mineflayer-auto-eat 5.x 的接口）。
> 没选"`flow_eat` 只在 auto-eat 关着时用"：auto-eat 默认开着（`agent.js:229`），那样 `flow_eat` 基本用不上。

### 6.3 策略

策略不自己做动作，只拆子单、等子单结果。任务板 B1 之前，子步骤按顺序同步调流程；B1 之后改成带 `parentId` 的子单。

#### `strat_obtain` — 弄到 N 个某物品（P0）

- **参数**：`item`、`count`
- **来源顺序**：箱子 > 合成 > 熔炼 > 采集 > 交易 > 打怪掉落；前一个能满足就不往后试
- **拆法**：用 `item_goal.js` 建需求图（§3.2），每个来源出一张子单，带 `why`
- **防止无限展开**：子单返回 `NO_ITEM` 时把 `missing` 加回需求图；最多展开 6 层、30 张子单（起步值，跑起来再调）
- **完成**：背包里有 `count` 个；做不到 → 返回缺口清单（§3.3）

| 策略 | 做什么 | 优先级 |
|---|---|---|
| `strat_tool_tier` | 工具升到某一档（木 → 石 → 铁）：每档对镐、斧、剑各调一次 `strat_obtain` | P0 |
| `strat_first_night` | 第一夜：撸木头 → 工作台 + 木镐 → 石器 → `flow_shelter` 或 `flow_sleep` → 吃饱 | P0 |
| `strat_base` | 建基地：`flow_build` 小屋 + 放箱子、熔炉、工作台 | P1 |
| `strat_food` | 稳定食物：`flow_farm` / `flow_breed` / `flow_fish` 选一个做得了的 | P1 |
| `strat_build_project` | 大型建筑：`strat_obtain` 备料 → 按区域拆成 `flow_build` 子单（多 bot 时按 06 §9.1 拆） | P1 |
| `strat_prepare_nether` / `strat_villager` / `strat_explore_map` / `strat_automate` | 下界准备 / 村民交易所 / 绘制地图 / 自动农场 | P2，前面的跑稳再细化 |

## 7. 落地顺序

1. 现有流程补 manifest 和 `ctx`：`task_collect` `task_follow` `task_pickup` `task_platform` `skill_escape` `skill_clear`（和任务板 B0 一起做）。
2. 注册表 + `!do` / `!listSkills`（顺手修 D24）。
3. P0 流程：craft → smelt → store / fetch → eat → mine（D15 已修）→ farm → fight → build。
4. 策略：`strat_obtain`（基于 `item_goal`）→ `strat_tool_tier` → `strat_first_night`（要先做 `flow_shelter`）。
   其余策略耗时长，要能被打断后接着做，等任务板 B2（抢占 + 断点续做）之后再做。

每一步都要过 §4.4 自查和真机用例才算完。
