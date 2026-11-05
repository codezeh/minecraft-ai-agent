# R1 收尾 · 拐杖（垫脚方块）id 错配 —— 喂 block id 而非 item id

> 任务：t8 · 执行人：skills · 2026-11-05
> 性质：**活 bug**（不是推测，也不是"代码重复"）
> 分支：`audit/remediation-2026-11-05`（未切分支、未合并、未碰 `main`）
> 唯一现存的历史记录：`docs/git-rescue-20261105/stash-5.patch`（**本次只读，未改动**）

## 0. 一句话结论

`scafoldingBlocks` 要的是 **item id**，而两处生产代码喂的是 **block id**。后果不是报错，是**静默数不到**：`countScaffoldingItems()` 恒为 0 → A* 的 `remainingBlocks === 0` → 所有"放方块走过去"的分支直接 `return` → 她明明背着木板，遇到沟坎却**绕远路或根本过不去，而且不打任何日志**。

两处都改了（`scaffold_blocks.js` + `skills.js:buildMovements`），并用**真 A\*** 在"无界裂谷"场景上证明：同一个 movements，只把清单从 item id 换成 block id，A* 就从"垫过去"退化成"过不去"。

---

## 1. 两条判据的源码对照

### 1.1 pathfinder 要 item id（`node_modules/mineflayer-pathfinder/lib/movements.js`）

```js
// :86-88  默认值也是 itemsByName
this.scafoldingBlocks = []
this.scafoldingBlocks.push(registry.itemsByName.dirt.id)
this.scafoldingBlocks.push(registry.itemsByName.cobblestone.id)

// :153-163  计数判据 —— 只有一处，且比的是 item.type
countScaffoldingItems () {
  let count = 0
  const items = this.bot.inventory.items()
  for (const id of this.scafoldingBlocks) {
    for (const j in items) {
      const item = items[j]
      if (item.type === id) count += item.count      // ← item.type 是 item id
    }
  }
  return count
}
```

`item.type` 是 **item id**（物品注册表），与方块注册表无关。

### 1.2 A\* 拿它当"最多能放几块"（同一文件）

```js
// :346  跳上一格时
if (node.remainingBlocks === 0) return // not enough blocks to place
// :352  还要再垫一块时
if (node.remainingBlocks === 1) return // not enough blocks to place
// :404  平着往前铺一块时
if (node.remainingBlocks === 0) return // not enough blocks to place
// :567  叠柱子时
if (!this.allow1by1towers || node.remainingBlocks === 0) return
```

`remainingBlocks` 的初值就是 `countScaffoldingItems()`。**数到 0 = 一切垫脚动作被静默禁用**。

### 1.3 我们喂的（改前）

```js
// src/agent/library/scaffold_blocks.js（改前）
export function scaffoldBlockIds(bot) {
    for (const it of bot.inventory?.items?.() ?? []) {
        if (!isScaffoldBlock(it.name)) continue;
        const id = bot.registry?.blocksByName?.[it.name]?.id;   // ← block id，错
        ...
    }
}
```

```js
// src/agent/library/skills.js buildMovements（改前）
const id = mc.getBlockId(it.name);        // getBlockId → blocksByName → block id，错
const id = mc.getBlockId(name);           // 同上（兜底 dirt/cobblestone 一并错）
m.scafoldingBlocks = scaffoldIds;
```

## 2. 数值表（1.21.8，两种 id 的差距）

| 方块名 | block id | item id | 改前能数到？ |
|---|---|---|---|
| dirt | 9 | 28 | ✗ |
| grass_block | 8 | 27 | ✗ |
| cobblestone | 12 | 35 | ✗ |
| oak_planks | 13 | 36 | ✗ |
| sand | 37 | 59 | ✗ |
| gravel | 40 | 63 | ✗ |
| deepslate | 1060 | 8 | ✗ |
| netherrack | 272 | 347 | ✗ |
| **stone** | **1** | **1** | ✓ 巧合 |
| **andesite** | **6** | **6** | ✓ 巧合 |
| **diorite** | **4** | **4** | ✓ 巧合 |
| **granite** | **2** | **2** | ✓ 巧合 |

**这就是它长期没被发现的原因**：恰好有 4 种方块两种 id 相同，于是"有时候能用"。
（`cobbled_deepslate` 是 block 1061 / item 9 —— 但它**不在**垫脚清单里，与本 bug 无关；清单覆盖面是另一件事，见 §9。）

复算命令：

```bash
cd mindcraft && node -e "
const mc=require('minecraft-data')('1.21.8');
for (const n of ['dirt','cobblestone','oak_planks','sand','gravel','deepslate','netherrack','stone','andesite','diorite','granite'])
  console.log(n, 'block='+(mc.blocksByName[n]?.id ?? '-'), 'item='+(mc.itemsByName[n]?.id ?? '-'));
"
```

## 3. 复现：真 A\* + 无界裂谷（改前 vs 改后）

不需要服务器 —— pathfinder 的 `AStar` 是纯函数（`new AStar(start, movements, goal, timeout).compute()`），世界只需 `bot.blockAt()`。

**场景**：`y<=62` 实心、`y=63` 是地板，`z∈{3,4,5}` 这 3 条 **整片**（x 方向无限延伸）挖空 = 一道无底裂谷。起点 `(0,64,0)`，终点 `(0,64,10)`，背包 `7×oak_planks + 9×cobblestone`，`allowParkour=false`（不许跳过去）。绕不过去，唯一出路是"放方块垫过去"。

探针源码：`docs/audit/probes/t8-gap-probe.mjs`（bare import 要走 `mindcraft/node_modules`，所以拷进项目里跑：
`cd mindcraft && cp ../docs/audit/probes/t8-gap-probe.mjs tmp/ && node tmp/t8-gap-probe.mjs`，`tmp/` 在 .gitignore 里）。逐字输出：

```
[改前：喂 block id]
  countScaffoldingItems() = 0   getScaffoldingItem() = undefined
  A* status=success  → 只能绕远路（12 节点、toPlace=0）

[改后：喂 item id]
  countScaffoldingItems() = 16  getScaffoldingItem() = oak_planks
  A* status=success  → 直接垫过去（9 节点、toPlace=3）
```

用"无界裂谷"后结论二值化，最后固化成单测的断言（§6 输出的那两行）：

```
nav_pathfinder.makeMovements：清单喂 item id ⇒ count=16 status=success 节点=9 toPlace=3
nav_pathfinder.makeMovements：清单喂 block id ⇒ count=0  status=partial 节点=2 toPlace=0
skills.buildMovements        ：清单喂 item id ⇒ count=16 status=success 节点=9 toPlace=3
skills.buildMovements        ：清单喂 block id ⇒ count=0  status=partial 节点=2 toPlace=0
```

`status=partial` = **连对岸都到不了**（不是"绕远了"，是"放弃了"）。

## 4. 改了什么

### 4.1 `src/agent/library/scaffold_blocks.js`

```js
export function scaffoldIdReport(bot) {          // 新：ids + skipped（诊断）
    for (const it of bot.inventory?.items?.() ?? []) {
        if (!it || !(it.count > 0) || !isScaffoldBlock(it.name)) continue;
        const id = bot.registry?.itemsByName?.[it.name]?.id;   // ← item id
        if (id == null) { skipped.push(it.name); continue; }   // 取不到就跳过并记录
        ids.push(id);
    }
    return { ids, skipped };
}
export function scaffoldItemIds(bot) { return scaffoldIdReport(bot).ids; }  // 新的正式名字
export function scaffoldBlockIds(bot) { return scaffoldItemIds(bot); }      // 旧名保留，语义已修正
```

- **取不到 item id 时跳过并记录，绝不退回 block id** —— 否则只会把"没有这个物品"伪装成"清单里写了却没生效"，正是本 bug 的伪装术。
- 旧名 `scaffoldBlockIds` 保留但语义已修正（名字骗人是这条 bug 的起点之一），新代码用 `scaffoldItemIds`。

### 4.2 `src/agent/library/skills.js` — `buildMovements`（captain 批准的第二处，同一症状）

```js
const itemIdOf = (name) => bot.registry?.itemsByName?.[name]?.id ?? null;   // 原来是 mc.getBlockId(name)
```
两处取值（背包循环 + 兜底 dirt/cobblestone）都换掉；`haveBlocks` 那段**没动**（空清单关掉搭桥本来就是对的）。顺手 `export function buildMovements`，为的是它能被 A\* 探针驱动 —— 私有函数连测都没法测。

**没有**顺手合并 `goodScaffold` 正则与 `isScaffoldBlock` 白名单：两者语义不同（宽松正则 vs 白名单），合并要先统一口径；按 captain 裁决，先把 bug 关掉，清单统一留待下轮（第 8 条已明令禁止"顺手合并语义相反的两套判据"）。

### 4.3 `src/agent/library/nav_pathfinder.js`

改调 `scaffoldItemIds(bot)`，并把"为什么必须是 item id"钉在注释里（附 `movements.js` 行号）。

### 4.4 `tools/test_scaffold_inventory.mjs`（既有测试，**它在断言 bug**）

```js
-const idOf = (name) => mcData.blocksByName[name]?.id;   // 期望值 = block id = bug 本身
+const idOf = (name) => mcData.itemsByName[name]?.id;    // pathfinder 比的是 item.type
```

这条值得单独说：它是 2026-10-26 修"从不设置 scafoldingBlocks"时写的，但**期望值取错了**，于是它一直在"保护 bug"。我改完代码后它立刻 5 PASS / 4 FAIL —— 如果没人动它，下一个人会按它把代码改回 block id。修好后 9 PASS / 0 FAIL。

## 5. 全仓同类错配清单（先列全，再定改哪些）

任务给的正则 **`grep -rn "blocksByName\[.*\]\.id"` 抓不到** —— 代码实际写的是可选链 `blocksByName?.[...]?.id`，`.` 与 `?.` 不匹配，所以它**返回 0 条**。换成能匹配真实写法的变体后：

| 位置 | 取值 | 喂给谁 | 需要 item id？ | 判定 |
|---|---|---|---|---|
| `scaffold_blocks.js:80` | `blocksByName[name].id` | `scafoldingBlocks` | **是** | ✗ **已修** |
| `skills.js:1775 / 1781`（`buildMovements`） | `mc.getBlockId(name)` | `scafoldingBlocks` | **是** | ✗ **已修**（captain 批准） |
| `skills.js:1763` | `mc.getBlockId(name)` | `blocksCantBreak` | 否（要 block id） | ✓ 正确 |
| `skills.js:1799` | `mc.getBlockId(name)` | `blocksToAvoid` | 否（要 block id） | ✓ 正确 |
| `collect_planner.js:30` | `blocksByName[n].id` | `findBlocks({matching})` | 否（要 block id） | ✓ 正确 |
| `query_safe.js:153` | `blocksByName[n].id` | `findBlocks({matching})` | 否（要 block id） | ✓ 正确 |
| `tool_prep.js:295` | `blocksByName.crafting_table.id` | `findBlocks` | 否（要 block id） | ✓ 正确 |
| `flow_smelt.js:66` | `blocksByName.furnace.id` | 找方块 | 否（要 block id） | ✓ 正确 |
| `flow_store.js:93` | `blocksByName.chest.id` | 找方块 | 否（要 block id） | ✓ 正确 |
| `vine_physics.js:80` | `blocksByName.air.id` | 空气判定 | 否（要 block id） | ✓ 正确 |
| `world.js:114 / 157` | `mc.getBlockId(...)` | `findBlocks` 忽略表 | 否（要 block id） | ✓ 正确 |
| `commands/index.js:207 / 211` | `getBlockId/getItemId` | 参数校验 | — | ✓ 正确（两者都查） |

`scafoldingBlocks` 是本仓**唯一**"期望 item id"的 pathfinder 字段；其余 `blocks*` 字段（`blocksCantBreak` / `blocksToAvoid` / `climbables` / `replaceables`）都按 block id 比对，喂 block id 才对。

**教训（比这一条本身更值钱）**：扫代码的判据必须拿**真实写法样本**校准。本轮已经因为可选链、双引号、tab 缩进各漏过一次 —— 每次都是"看起来扫了，其实没扫到"。

## 6. 单测：`tools/scaffold_ids_unit.mjs`（12 用例，自动并入 unit_all）

三层，缺一层就会重演"测了但测不了错"：

| 层 | 断言 |
|---|---|
| ① 契约 | `scaffoldIdReport()` 的每个 id 都能被 `item.type === id` 命中；覆盖 **oak_planks / cobblestone / dirt / stone**（stone 是"巧合也能过"的对照组，只测它等于没测） |
| ② 无 item 的名字 | 抹掉 `dirt` 的 item 定义 → 必须进 `skipped`，且 ids 里**不许**出现它的 block id 或 item id |
| ③ 行为（真 A\*） | **两条入口各跑一遍**：`nav_pathfinder.makeMovements` 与 `skills.buildMovements`；每处都用同一个 movements 做 item id ↔ block id 的一对一对照 |
| ④ 结构 | 两个文件的垫脚段都只许 `itemsByName`，不许 `getBlockId`（判前先剥注释——注释里会**提到**旧写法） |

当前：

```
PASS 四种垫脚料（含 stone 对照）的 item id 全在清单里且都数得到 ids=[36,35,28,1] 计数=18/18
       oak_planks: item=36 block=13(不同)→命中 | cobblestone: item=35 block=12(不同)→命中 |
       dirt: item=28 block=9(不同)→命中 | stone: item=1 block=1(巧合相同)→命中
PASS 取不到 item id 时跳过并记录，不塞 block id ids=[35] skipped=["dirt"]
PASS nav_pathfinder.makeMovements：清单喂 item id ⇒ A* 规划出**垫过去**的路径 count=16 status=success 节点=9 toPlace=3
PASS nav_pathfinder.makeMovements：清单喂 block id ⇒ 数到 0、**到不了对岸** count=0 status=partial 节点=2 toPlace=0
PASS skills.buildMovements：清单喂 item id ⇒ A* 规划出**垫过去**的路径 count=16 status=success 节点=9 toPlace=3
PASS skills.buildMovements：清单喂 block id ⇒ 数到 0、**到不了对岸** count=0 status=partial 节点=2 toPlace=0
PASS 对照（背包无垫脚料）⇒ 关掉搭桥、过不去 count=0 status=partial allow1by1towers=false
PASS scaffold_blocks.js 只查 itemsByName / skills.buildMovements 只查 itemsByName
12/12 个用例通过
```

## 7. 反向验证（两个文件各一遍，都变红）

测试支持三个环境变量（`SCAFFOLD_MODULE` / `SKILLS_MODULE` / `NAV_MODULE`），可以指到变异副本上跑。
**注意**：`nav_pathfinder` 内部是 `import './scaffold_blocks.js'`（相对路径），只改 `SCAFFOLD_MODULE` 到不了它 —— 所以变异必须整棵 `src` 复制（沙箱里两个文件各自隔离）。

### R1：只把 `scaffold_blocks.js` 退回 block id

```
FAIL 清单里应含这四种的 **item id** 缺=["oak_planks","cobblestone","dirt"] ids=[13,12,9,1] 计数=6/18
FAIL 应跳过并记录 leaked=[9] ids=[9,12] skipped=[]
FAIL nav_pathfinder.makeMovements：喂 item id 时应规划垫脚路径 {"count":0,"status":"partial","nodes":2,"places":0}
FAIL nav_pathfinder.makeMovements：id 类型必须改变 A* 的结论
FAIL scaffold_blocks.js 必须只查 itemsByName
7/12 个用例通过   ← exit=1
```
（`skills.buildMovements` 那三条仍绿 —— 因为它读的是自己那份代码，这正是"两条入口要分别验"的原因。）

### R2：只把 `skills.buildMovements` 退回 `mc.getBlockId`

```
FAIL skills.buildMovements：喂 item id 时应规划垫脚路径 {"count":0,"status":"partial","nodes":2,"places":0}
FAIL skills.buildMovements：id 类型必须改变 A* 的结论
FAIL skills.buildMovements 必须只查 itemsByName 找到垫脚段=true 用 getBlockId=true
9/12 个用例通过   ← exit=1
```

两组红点都**精确落在被改的那条入口上**，互不串扰 —— 证明用例没有互相顶替。

## 8. 门禁与提交

```
node tools/scaffold_ids_unit.mjs     12/12 通过
node tools/unit_all.mjs              97/97 个脚本通过，4 个跳过   （改前 96/96 + 4，+1 = 本任务的 scaffold_ids_unit）
node tools/lint_hard.mjs             ✓ no-undef = 0 · no-floating-promise = 0
npm run lint:tools                   ✓ 273 ≤ 278（新脚本 0 条新发现）
node tools/test_scaffold_inventory.mjs 9 PASS / 0 FAIL（改前 5/4 —— 它在断言 bug）
```

只 `git add` 这 5 个文件；未 `git add -A`、未 `checkout .`、未 `stash`；未切分支/合并/碰 `main`。
提交时门禁**未跳过**（`SKIP_GATE` 未使用）。

## 9. 遗留（不在本任务范围）

1. **垫脚清单口径仍是两套**：`scaffold_blocks.SCAFFOLD_EXACT`（白名单）与 `skills.buildMovements` 的 `goodScaffold`（正则，含 `_slab`）语义不完全一致 —— 按 captain 裁决**本轮不合并**，下轮先统一口径再合。
2. **清单覆盖面偏窄**：`cobbled_deepslate`/`deepslate_tiles`/`tuff` 等常见"石头类"不在清单里（它们两种 id 也不同：1061/9）。这不是本 bug（不是错配），是"能垫但不认"，属功能缺口。
3. **`it.type` 比查名字更稳**：`docs/git-rescue-20261105/stash-5.patch` 里那份**从未落地**的修复用的是 `ids.add(it.type)` —— `item.type` **本身**就是 item id，不需要经过"名字 → 注册表"这一步，天然不受"方块名与物品名不同"（如 `wall_torch`↔`torch`）影响。本次按 captain 指定用 `itemsByName[name].id`（当前清单里的名字两种注册表都有，见 §4.1 的校验）；若将来清单要加"方块名≠物品名"的方块，应改成 `it.type`。

## 10. 这条判据曾经只活在一个没人读的补丁里

`docs/git-rescue-20261105/stash-5.patch` 的 `atom_move.js` 段里，`scaffoldItemIds()` 上方原文：

```
 * ★ 必须返回 **item id**，不是 block id。
 *   `movements.js:156-159` 的判定是 `item.type === id`，而 item.type 是 item id。
 *   1.21.8 里 dirt 的 blockId=9、itemId=28 —— 混用就永远匹配不上，
 *   表现出来是「搭桥静默失效」，最难查的那种。
```

那份修复**从未落地**（目标文件 `atom_move.js` 后来被拆分，`makeMovements` 迁到 `nav_pathfinder.js:28`），而 bug 跟着漂到新文件里继续活着，直到本轮才被 gate 从补丁里翻出来。

**这就是本轮最该记住的一条**：未落地的修复必须进**待办**，不能只留在 `stash` 或补丁文件里 —— 补丁不会自己执行，也不会在有人改到同一个函数时叫一声。本文件（含 §1 的判据、§2 的数值表、§6 的用例）就是把它从"某人的记忆/某个补丁"搬进"代码能自证"的地方。

## 11. 复现命令

```bash
cd mindcraft

# 0) 手工 A/B 探针（两条入口各一次，结论应一致）
cp ../docs/audit/probes/t8-gap-probe.mjs tmp/ && node tmp/t8-gap-probe.mjs && rm -f tmp/t8-gap-probe.mjs

# 1) 现况（绿）
node tools/scaffold_ids_unit.mjs

# 2) 反向验证 A：只把 scaffold_blocks.js 退回 block id
rm -rf tmp/rsx && mkdir -p tmp/rsx && cp -r src tmp/rsx/src && cp settings.js tmp/rsx/ \
  && printf '{"type":"module"}' > tmp/rsx/package.json
sed -i 's/registry?\.itemsByName?\.\[it\.name\]?\.id/registry?.blocksByName?.[it.name]?.id/' \
  tmp/rsx/src/agent/library/scaffold_blocks.js
SCAFFOLD_MODULE=../tmp/rsx/src/agent/library/scaffold_blocks.js \
NAV_MODULE=../tmp/rsx/src/agent/library/nav_pathfinder.js \
node tools/scaffold_ids_unit.mjs          # 期望 7/12、exit=1

# 3) 反向验证 B：只把 skills.buildMovements 退回 mc.getBlockId
rm -rf tmp/rsy && mkdir -p tmp/rsy && cp -r src tmp/rsy/src && cp settings.js tmp/rsy/ \
  && printf '{"type":"module"}' > tmp/rsy/package.json
# 把 itemIdOf 的那行改成 mc.getBlockId(name)（见 §4.2）
SKILLS_MODULE=../tmp/rsy/src/agent/library/skills.js \
NAV_MODULE=../tmp/rsy/src/agent/library/nav_pathfinder.js \
node tools/scaffold_ids_unit.mjs          # 期望 9/12、exit=1

# 4) 门禁
node tools/unit_all.mjs && node tools/lint_hard.mjs && npm run lint:tools
```
