# 第五轮审计 · 06 游戏内真机实测（隔离 Paper 服 + 真 mineflayer bot）

> 结论速览：本轮**没有在隔离服上复现出任何一条游戏内缺陷**。
> BUG-001（tp 物理崩溃）与 BUG-002（判据基准错位）回归**全绿**；
> BUG-003（远处区块不掉落）在隔离服的 4 种条件下**都正常掉落**，判 NOT-REPRODUCED-IN-ISOLATED。
> 游戏内原子能力 7/7、寻路、`!stop` 停手链路也都正常。唯一非绿项是 `bench_live_nav.mjs`（CANNOT-RUN，
> 它写死主服 RCON 25575 + 需要在线探针 + 真实地形，不属缺陷）。
> 明细与可复现命令见下；全部断言：**自建场景 63/63 全绿**，既有 live 场景 4 绿 1 CANNOT-RUN。

## 0. 地基与纪律

| 项 | 事实 |
|---|---|
| 服务端 | `server/server.jar` = Paper 1.21.8，JDK `.tools/jdk-21.0.12.1+1` |
| 客户端 | minecraft 协议 1.21.8，**mineflayer 4.39.0**（BUG-001 修复所在版本） |
| 隔离方式 | 每次建 `tmp/r5-ingame/<场景>/`，world 从 `test-template/world` 拷、`libraries/versions/cache` 用 junction 只读指到 `server-test` |
| RCON 口令 | 每次随机 24 位十六进制，写进运行目录的 `server.properties`，**不进仓库、不进日志** |
| 端口 | MC 25566 / RCON 25576 独占；每场景结束 RCON `stop` → 等 java 退出 → 校验无残留 |
| 生产服 | **全程未触碰** `server/` 与 `server-test/` 的世界（只读 junction） |

### 地基自证（先证明链路可信）

```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/e2e.ps1 -Scenario claims
→ E2E 通过：10/10 条断言全部通过   （claims 场景脚本 13 PASS / 0 FAIL）
```
原始输出：`tmp/r5-ingame-baseline-claims.log`。起服/RCON/停服/重置链路可信。

### 可复用脚本（本轮的"起服→跑批→停服→重置"）

| 文件 | 作用 |
|---|---|
| `docs/audit-r5/evidence/ingame/harness.mjs` | 一次性运行目录 + 起服 + `Done (` 等待 + RCON 探活 + 停服 + PASS/FAIL 断言器 |
| `docs/audit-r5/evidence/ingame/s1_physics_collect.mjs` | A（BUG-001）+ B（BUG-002）+ C①②③（BUG-003 前三种条件） |
| `docs/audit-r5/evidence/ingame/s2_atoms_nav.mjs` | D（7 条原子能力）+ E（寻路） |
| `docs/audit-r5/evidence/ingame/s3_natural.mjs` | C④（另起 level-type=normal 的自然森林世界） |
| `docs/audit-r5/evidence/ingame/s4_stop.mjs` | F（`!stop` 真机停手） |
| `docs/audit-r5/evidence/ingame/run_live_tool.mjs` | 起服 → 跑**既有** `tools/*_live.mjs` → 停服（G 段用） |
| `docs/audit-r5/evidence/ingame/s1b_diag_collect.mjs` | 诊断脚本：dump `planCollect` 的 skipped 原因（输出存在 `s1b-diag.log`） |

---

## A. BUG-001 回归：外部 tp 导致物理崩溃 / 被踢

判据（按 `bugs/BUG-001-tp物理崩溃.md` §0 的对照表）：tp 20 格、tp 60 格、连续 tp 5 次都要
坐标非 NaN；tp 后走路 ≥1.0 格/秒；服务端日志无 `invalid_player_movement`。

**命令**

```
node docs/audit-r5/evidence/ingame/s1_physics_collect.mjs     # 场景 s1-flat
```

**真实输出（摘录，全文见 `docs/audit-r5/evidence/ingame/s1-flat.log`）**

```
PASS A-1 tp 20 格后坐标非 NaN（服务端读回） —— 服务端 17.5, -60, 10.5；客户端 (17.5, -60, 10.5)
PASS A-1 tp 20 格后到达目标（水平误差 ≤3） —— 目标 17, -60, 10
PASS A-1 客户端坐标也非 NaN —— mineflayer (17.5, -60, 10.5)
PASS A-2 tp 60 格后坐标非 NaN —— 服务端 17.5, -60, 70.5；客户端 (17.5, -60, 70.5)
PASS A-2 tp 60 格后到达目标（水平误差 ≤3） —— 目标 17, -60, 70
PASS A-3 连续 tp 5 次坐标全部正常 —— 异常 0/5；逐次 X=22.5 → 27.5 → 32.5 → 37.5 → 42.5
PASS A-4 tp 后正常走路（实测速度 ≥1.0 格/秒） —— 3.0s 位移 12.69 格 = 4.22 格/秒
PASS A-4 走完坐标仍非 NaN
PASS A-5 服务端日志无 invalid_player_movement / moved-too-quickly 记录 —— 日志 0 命中
PASS A-5 客户端整个 A 段没被踢（mineflayer kicked 事件 0 次） —— kicked 事件 0 次
```

| 场景 | 命令 | 真实输出（PASS/FAIL） | 判定 | 证据文件 |
|---|---|---|---|---|
| A BUG-001 回归 | `node …/s1_physics_collect.mjs` | **10 PASS / 0 FAIL**；tp20/60/连续5次坐标全正常；tp 后 4.22 格/秒；`invalid_player_movement` 0 命中 | **PASS**（行为正常，BUG-001 未复发） | `s1-flat.log`、`tmp/r5-ingame/s1-flat/server.log` |

> 对照 `bugs/BUG-001` 的表：4.33 时 tp 20 格就 NaN、走路只有 0.2 格/秒。本机 **mineflayer 4.39.0**，
> 实测 4.22 格/秒（正常速度的量级），**与"升级到 4.39 修复"的结论一致**。

---

## B. BUG-002 回归：判据基准错位 → 捡到第 1 个就停

判据不是"最终拿到了几个"，而是**背包增量是否持续**：BUG-002 复发时，任务里捡到第 1 个之后
`gained()` 恒真，后续挖的都不再捡。所以断言两件事：①总量增量 ≥8；②采样里出现 ≥2 个增长台阶。

**做法**：摆 3 棵**带树冠的真树**（12 个原木）→ `runSkill(agent, 'collect', 'block=oak_log count=8 radius=32')`
→ 每 400ms 采样一次背包 oak_log。

**真实输出**

```
PASS B-0 树已摆好（树干存在且带树冠） —— 树干 (47,84)，(第二棵在 (55,89))
[B] runSkill → ok=true code=OK msg=  13197ms
[B] 背包采样序列（去重）：4 → 5 → 6 → 7 → 8 → 9 → 10 → 11
PASS B-1 collect 技能返回 ok —— code=OK msg=
PASS B-2 背包 oak_log 增量 ≥8（不是捡到第 1 个就停） —— 任务前 4 → 任务后 12，增量 8
PASS B-3 增量是"持续"发生的（采样里出现 ≥2 个不同的增长台阶） —— 采样到 7 个增长台阶：5 → 6 → 7 → 8 → 9 → 10 → 11
```

| 场景 | 命令 | 真实输出（PASS/FAIL） | 判定 | 证据文件 |
|---|---|---|---|---|
| B BUG-002 回归 | 同上 | **3 PASS / 0 FAIL**；`4 → 5 → 6 → 7 → 8 → 9 → 10 → 11`（7 个台阶）；13.2s 拿满 8 个 | **PASS**（行为正常，BUG-002 未复发） | `s1-flat.log` |

> 顺带记录两条**探针自身踩过的坑**（避免下次误判成产品缺陷）：
> ① 只摆"光杆原木"时 `planCollect` 按设计拒绝：`not-tree:没有树冠（0 片叶），像玩家搭的或已剥光的树干`
> （真实 dump 见 `docs/audit-r5/evidence/ingame/s1b-diag.log`）——这是产品**正确**的保守行为，不是 bug。
> ② 树冠只铺在 y+3 以上时，砍掉上层后**树底的原木**离叶子 >2 格 → 同样被判 not-tree，
> 表现为"要 8 个只拿到 6 个"。改成叶子从 y+2 起铺即 8/8。两次都是场地摆法问题。

---

## C. BUG-003 探因：远处区块不掉落

`bugs/BUG-003` 的现象是"挖了但服务端 `@e[type=item]` 查不到"（根因未定）。隔离服上分四个条件测，
每处都要**双证据**：服务端 `@e[type=item]` 计数（scoreboard `execute store result` 取回）+ bot 背包增量。

**C①②③（超平坦世界，`s1_physics_collect.mjs`）真实输出**

```
PASS C-① 超平坦区挖 setblock 的 dirt 方块确实变成 air —— execute if block 52 -60 93 minecraft:air → true
PASS C-① 超平坦区挖 setblock 的 dirt 掉落物证据 —— 服务端 item 0→1，背包 8→8
PASS C-② setblock 放 oak_log 后挖 方块确实变成 air
PASS C-② setblock 放 oak_log 后挖 掉落物证据 —— 服务端 item 1→2，背包 12→12
PASS C-③ 未 forceload 的远区块确实未加载（原始现象前提） —— RCON data get block 449 -60 493 → That position is not loaded
PASS C-③ forceload 后 setblock 成功（区块可写）
PASS C-③ forceload 远区块挖 oak_log 方块确实变成 air
PASS C-③ forceload 远区块挖 oak_log 掉落物证据 —— 服务端 item 0→0，背包 12→13
```

> C-③ 里"服务端 item 0→0 但背包 12→13"不是矛盾：掉落物**已经吸附进背包**了，
> 所以该位置的 item 实体计数回到 0。这是"掉落物确实生成了"的更强证据（它被捡走了）。

**C④（另起 `level-type=normal` 的自然森林世界，`s3_natural.mjs`）真实输出**

```
PASS S3 普通世界起服：Done ( + RCON 就绪 —— 耗时 19.2s
[S3] locate biome → The nearest minecraft:forest is at [-64, 101, 64] (90 blocks away)
PASS S3 落点属于森林类生物群系（#minecraft:is_forest） —— 探针：(-64,64,64)=Test passed；原木位置 (-69,113,62) → Test passed
PASS S3 自然森林里确实有原木（前置） —— 找到 24 处
PASS S3 走到自然树旁边（前置） —— 实际距离 2.91 格
[S3] 挖 birch_log @ -69,113,62：变 air=true；服务端 item 0→0；背包 birch_log 0→1
PASS S3 C-④ 自然森林：方块变 air —— execute if block → true
PASS S3 C-④ 自然森林：掉落物双证据 —— 服务端 item 0→0，背包 0→1
```

| 场景 | 命令 | 真实输出（PASS/FAIL） | 判定 | 证据文件 |
|---|---|---|---|---|
| C-① 超平坦挖方块 | `node …/s1_physics_collect.mjs` | 方块→air；服务端 item `0→1` | **PASS**（掉落正常） | `s1-flat.log`、`tmp/r5-ingame/s1-flat/server.log` |
| C-② setblock 放原木再挖 | 同上 | 方块→air；服务端 item `1→2` | **PASS**（掉落正常） | 同上 |
| C-③ forceload 远区块挖 | 同上 | 未 forceload 时确为 `That position is not loaded`；forceload 后可写可挖；掉落物被捡走（背包 `12→13`） | **PASS**（掉落正常） | 同上 |
| C-④ 自然森林挖树 | `node …/s3_natural.mjs` | 方块→air；`birch_log` 背包 `0→1` | **PASS**（掉落正常） | `s3-natural.log`、`tmp/r5-ingame/s3-natural/server.log` |

**判定：NOT-REPRODUCED-IN-ISOLATED。** 四个条件（含 forceload 远区块、含自然森林）**全部掉落正常**，
无法给出"什么条件下不掉落"的最小条件式。

**关于原现象（重要限定）**：BUG-003 原记录发生在**主服**的自然森林（`(-260,69,-350)`），
而主服本轮**不可扰动**（不重启、不 tp、不挖方块），所以那一处**没有也不能**在本轮被复现或排除。
能说的是：**同一套服务端 jar（Paper 1.21.8）+ 同一个 mineflayer 客户端，在隔离服的自然森林里掉落正常**，
因此"Paper 对 forceload 区块跳过实体生成"这条**最可能的假设被实测否定**。
剩下的差异只有主服的**插件栈/常加载区/世界年龄**（主服装了 BlueMap/Chunky/CoreProtect 等，
隔离服是纯 Paper）—— 这条边界建议下一轮在主服的**只读**侧继续查（例如 CoreProtect 的方块日志
与主服 `spigot.yml` 的 `item-despawn-rate` / `entity-activation-range` 实配值）。

---

## D. 游戏内原子能力 smoke（7 条，全部走产品代码 `src/agent/library/act_*.js`）

**命令**：`node docs/audit-r5/evidence/ingame/s2_atoms_nav.mjs`（场景 s2-atoms-nav）

| # | 能力 | 走的产品入口 | 客观断言 | 真实输出 | 判定 |
|---|---|---|---|---|---|
| D-1 | dig | `act_dig.digBlock` | 方块变 air + 服务端生成掉落物 | `{ok:true,code:"OK",dugBlock:"stone",costMs:405}`；`execute if block … air → true`；`@e[type=item]=1` | **PASS** |
| D-2 | place | `act_place.placeBlockAt` | 世界里真的出现 stone | `{ok:true,placedBlock:"stone",support:"grass_block"}`；`execute if block … stone → true` | **PASS** |
| D-3 | craft | `act_craft.craftOnce` | 背包 oak_planks `0 → 4` | `{ok:true,craftedItem:"oak_planks",produced:4,usedTable:false}` | **PASS** |
| D-4 | chest 存 | `act_container.openContainer + deposit` | 箱子内容 dirt ≥5，背包 `16→11` | `{stored:5,invBefore:16,invAfter:11,winBefore:0,winAfter:5}`；箱子内 dirt=5 | **PASS** |
| D-4 | chest 取 | `act_container.withdraw` | 背包 dirt 复原 `11→16` | `{taken:5,invBefore:11,invAfter:16,winBefore:5,winAfter:0}` | **PASS** |
| D-5 | eat | `act_items.eat` | 饱食度 `17 → 20` | `{ok:true,ate:"cooked_beef",foodBefore:17,foodAfter:20}` | **PASS** |
| D-6 | attack | `act_attack.attackEntity` | 服务端僵尸实体 `1 → 0` | `{ok:true,killed:true,costMs:3058}` | **PASS** |
| D-7 | pickup | 走过去吸附服务端生成的 item 实体 | 背包 diamond `0 → 1` | 服务端该处 item 实体 2；背包 0→1 | **PASS** |

**小计：8 PASS / 0 FAIL**（D-4 拆成"存/取"两条断言）。

**两条 API 契约记录**（本轮踩到的真实返回，供后续脚本参考）：

- `placeBlockAt(bot, pos, item, opts)` / `openContainer(bot, pos, opts)` 的 `pos` **必须**是
  `{kind:'block', pos:{x,y,z}}`；直接给 `{x,y,z}` 会得到 `NO_TARGET / 目标位置无效`。
- `attackEntity(bot, target, opts)` 的 `target` **必须**是 `{kind:'entity', entity}`；
  直接给 entity 对象会得到 `NO_TARGET / 目标必须是 {kind:"entity", entity}`。
- `attackEntity` 对 4.06 格外的目标**正确地**返回 `OUT_OF_REACH（近战 3 格）`—— 这是产品对的，
  第一版把僵尸摆到 4 格外才失败；摆回 3 格内即 `killed:true`。

---

## E. 寻路

| 场景 | 命令 | 真实输出 | 判定 | 证据 |
|---|---|---|---|---|
| E 走到 25 格外 | `node …/s2_atoms_nav.mjs` | `PASS E-1 到达（误差 0.89 格，5.3s）`；`PASS E-2 采样到 10 个不同位置（未 stuck）`；`PASS E-3 位移 26.3 格` | **PASS** | `s2-atoms-nav.log` |

```
PASS E-1 寻路到达 25 格外的目标点（误差 ≤2 格） —— 终点 (20.11, -60, 17.91)，误差 0.89 格，用时 5.3s
PASS E-2 全程有位置推进（未 stuck） —— 采样到 10 个不同位置：-2.0,8.0 → -0.0,10.0 → 2.5,10.5 → 5.3,10.5 → 8.0,10.7 → 9.8,12.8 …
PASS E-3 起点到终点确实移动了（水平位移 ≥20） —— 位移 26.3 格
```

（`tools/bench_live_nav.mjs` 的结果见 §G。）

---

## F. 聊天取消：`!stop` 真机停手

**做法**：不用 LLM。用**产品代码里的 `!stop`**（`src/agent/commands/index.js` 的 `getCommand('!stop')`，
就是玩家聊天时走的那份实现）+ 真 `ActionManager` + 真 bot；先跑一个真长动作
（`flow_collect.collect` 砍 8 个原木），跑起来之后发 `!stop`。

**命令**：`node docs/audit-r5/evidence/ingame/s4_stop.mjs`（场景 s4-stop）

**真实输出（11 PASS / 0 FAIL）**

```
PASS F-1 停之前长动作确实在动（位置推进 >2 格） —— 起点 (2.5, -60, -3.5) → 现在 (5.53, -60, -3.5)
waiting for code to finish executing...
PASS F-2 !stop 返回 "Agent stopped." —— 返回：Agent stopped.
PASS F-2 !stop 后 actions.executing 变 false —— executing=false
PASS F-3 被停的长动作标记为 interrupted —— runAction 返回 {"success":true,"message":"","interrupted":true,"timedout":false}
PASS F-3 !stop 记了取消原因（agent.noteCancel 被调用） —— cancels=["player-stop"]
PASS F-5 stop 在 10s 内完成（没走僵尸动作重启） —— 耗时 311ms
PASS F-4 停手后位置稳定（1.5s 内水平位移 <0.5 格） —— 位移 0.000 格
```

| 场景 | 命令 | 真实输出 | 判定 | 证据 |
|---|---|---|---|---|
| F `!stop` 停手 | `node …/s4_stop.mjs` | **11 PASS / 0 FAIL**；`interrupted:true`、`executing=false`、`noteCancel('player-stop')`、停后位移 0.000 格、stop 耗时 311ms | **PASS**（停手链路正常） | `s4-stop.log`、`tmp/r5-ingame/s4-stop/server.log` |

**与 T3 的交叉印证（重要，别把两件事混成一件）**：
本节证明的是**「身体真的停了」**——动作被 abort、`executing=false`、位置不再变化。
T3 记录的是**「模型那边迟到的回复仍会写进 history 并说给玩家」**——那是"嘴"没停，不是"手"没停。
两者**并不矛盾**，正好互补：`!stop` 的 `noteCancel('player-stop')` 只拦得住**动作**，
拦不住**已经在飞的模型请求**产出的那句话。本轮**没有**在真机上验证"迟到回复"，因为那需要真 LLM；
本条按 T3 的结论**引用**，不重复验证。

**一个模块加载层面的备注（不是产品缺陷）**：
直接 `import 'src/agent/commands/actions.js'` 会抛
`ReferenceError: Cannot access 'actionsList' before initialization`
（`commands/index.js:60`）。这是 ESM 循环依赖：`actions.js` 初始化期间有别的模块把 `index.js` 拉起来，
而 `index.js` 顶层就要读 `actionsList`。**正常入口（`main.js` → `agent` → `commands/index.js`）不受影响**，
`getCommand('!stop')` 实测可用（本轮就是这条路）。只有"从 actions.js 侧门进入"才会撞上，
所以只记为可维护性备注，不上报为缺陷。

---

## G. 既有 live 场景回归

| # | 场景 | 命令 | 真实输出 | 判定 | 证据 |
|---|---|---|---|---|---|
| G-1 | claims 争用（`t37_claims_contention_live.mjs`） | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/e2e.ps1 -Scenario claims` | `E2E 通过：10/10`；场景脚本 `退出码=0, PASS=13, FAIL=0`；5 条关键断言（①②③④⑤）全部命中 | **PASS** | `tmp/r5-ingame-baseline-claims.log`、`tmp/e2e/claims/server.log` |
| G-2 | restart 恢复（`e2e_restart_live.mjs`） | `powershell … -File scripts/e2e.ps1 -Scenario restart` | `E2E 通过：13/13`；箱子 3 种物品逐项一致、熔炉产物跨重启仍在（煤 8→7、iron_ingot 1）、`History.load()` 命中记忆标记、`memory_bank` 命中 | **PASS** | `docs/audit-r5/evidence/ingame/g-restart.log`、`tmp/e2e/restart/server.log` |
| G-3 | `tools/m9_smoke_live.mjs`（改路由的 4 条命令 + protect_owner） | `node …/run_live_tool.mjs tools/m9_smoke_live.mjs 300` | `8/8 条通过`，`退出码 = 0` | **PASS** | `g-m9-smoke.log`、`tmp/r5-ingame/live-m9_smoke_live/tool.log` |
| G-4 | `tools/verify_escape_live.mjs`（被埋后自救） | `node …/run_live_tool.mjs tools/verify_escape_live.mjs 300` | `7 PASS / 0 FAIL`；`y -60.0 → -50.0`（真升 10 格），`退出码 = 0` | **PASS** | `g-verify-escape.log`、`tmp/r5-ingame/live-verify_escape_live/tool.log` |
| G-5 | `tools/bench_live_nav.mjs`（真机寻路基准） | `node …/run_live_tool.mjs tools/bench_live_nav.mjs 300` | `Error: connect ECONNREFUSED 127.0.0.1:25575`，`退出码 = 1` | **CANNOT-RUN**（设计上跑主服，见下） | `g-bench-nav.log` |

**G-5 的真实原因（跑出来的原文，不是猜）**

```
Error: connect ECONNREFUSED 127.0.0.1:25575
    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1705:16)
  code: 'ECONNREFUSED', address: '127.0.0.1', port: 25575
```

`tools/bench_live_nav.mjs:13` 写死 `rcon(c, { port: 25575 })` —— 那是**主服** RCON，
而其余全部 `tools/*_live.mjs`（a2_budget / atom_* / m9_smoke / t37_* …）都写死 25576（测试服）。
它还要 `list` 里有一个非 `deepseek` 的**在线探针**、并且要在**真实地形**上 `spreadplayers` 找落点，
这三条（主服 25575 + 在线探针 + 真实地形）在隔离服里都不成立，所以判 **CANNOT-RUN**，
不判缺陷（它本来就是"主服基准"工具；主服本轮不可扰动）。

> 记一条**观察项**（low，未上报为缺陷）：`bench_live_nav.mjs` 与其它 live 工具的端口约定不一致
> （25575 vs 25576）。如果本意是"也能在测试服跑"，那这是工具债；如果本意是"只在主服跑"，
> 建议在文件头把"只在主服"写清楚，免得下次又按 `*_live.mjs` 的惯例拿去测试服跑、白白踩 ECONNREFUSED。

---

## 总表

| 场景 | 命令 | 真实输出摘录 | 判定 | 证据文件 |
|---|---|---|---|---|
| 地基自证 | `powershell … -File scripts/e2e.ps1 -Scenario claims` | `E2E 通过：10/10`；PASS=13 FAIL=0 | **PASS** | `tmp/r5-ingame-baseline-claims.log` |
| A BUG-001 回归 | `node …/s1_physics_collect.mjs` | 10 PASS / 0 FAIL；tp20/60/连5次正常；4.22 格/秒；踢人 0 | **PASS** | `s1-flat.log`、`tmp/r5-ingame/s1-flat/server.log` |
| B BUG-002 回归 | 同上 | 3 PASS / 0 FAIL；采样 `4→5→…→11`，最终 `4→12`（增量 8） | **PASS** | `s1-flat.log` |
| C-① 超平坦挖方块 | 同上 | 方块→air；`@e[type=item] 0→1` | **PASS** | `s1-flat.log` |
| C-② setblock 原木再挖 | 同上 | 方块→air；`@e[type=item] 1→2` | **PASS** | `s1-flat.log` |
| C-③ forceload 远区块 | 同上 | 未加载→可写→可挖→掉落（背包 12→13） | **PASS** | `s1-flat.log` |
| C-④ 自然森林挖树 | `node …/s3_natural.mjs` | 9 PASS / 0 FAIL；`birch_log` 背包 0→1 | **PASS** | `s3-natural.log`、`tmp/r5-ingame/s3-natural/server.log` |
| D 原子能力 smoke | `node …/s2_atoms_nav.mjs` | 8 PASS / 0 FAIL（dig/place/craft/chest存/chest取/eat/attack/pickup） | **PASS** | `s2-atoms-nav.log` |
| E 寻路 | 同上 | 误差 0.89 格 / 5.3s / 10 个位置采样 | **PASS** | `s2-atoms-nav.log` |
| F `!stop` 停手 | `node …/s4_stop.mjs` | 11 PASS / 0 FAIL；`interrupted:true`、停后位移 0.000 | **PASS** | `s4-stop.log`、`tmp/r5-ingame/s4-stop/server.log` |
| G-1 claims | `powershell … -Scenario claims` | `10/10` | **PASS** | `tmp/r5-ingame-baseline-claims.log` |
| G-2 restart | `powershell … -Scenario restart` | `13/13` | **PASS** | `g-restart.log` |
| G-3 m9 smoke | `node …/run_live_tool.mjs tools/m9_smoke_live.mjs` | `8/8`，退出码 0 | **PASS** | `g-m9-smoke.log` |
| G-4 verify_escape | `node …/run_live_tool.mjs tools/verify_escape_live.mjs` | `7 PASS / 0 FAIL`，退出码 0 | **PASS** | `g-verify-escape.log` |
| G-5 bench_live_nav | `node …/run_live_tool.mjs tools/bench_live_nav.mjs` | `ECONNREFUSED 127.0.0.1:25575`，退出码 1 | **CANNOT-RUN** | `g-bench-nav.log` |

**断言合计：自建场景 63 条断言全绿（26+17+9+11），既有 live 场景 4 绿 1 CANNOT-RUN。**

---

## 结论

1. **BUG-001（tp 物理崩溃）不复现。** mineflayer 4.39.0 下 tp 20/60 格、连续 tp 5 次坐标全正常，
   tp 后走路 4.22 格/秒，服务端 `invalid_player_movement` 零命中 —— 回归通过。
2. **BUG-002（判据基准错位）不复现。** 一次任务砍 8 个原木背包 `4→12`（增量 8，采样到 7 个增长台阶），
   不是"捡到第 1 个就停" —— 回归通过。
3. **BUG-003 在隔离服 4 种条件下全部掉落正常 → NOT-REPRODUCED-IN-ISOLATED。**
   特别是原记录里最可疑的假设「forceload 远区块不生成实体」**被实测否定**：
   forceload 后 `setblock` 可写、挖掉有掉落、掉落物还能被捡走。
   原现象发生在**主服**自然森林，主服本轮不可扰动，故**不宣称主服无此问题**；
   下一轮应只在主服做只读取证（CoreProtect 方块日志、`spigot.yml` 的 `entity-activation-range` 实配值）。
4. **游戏内原子能力 7/7、寻路、`!stop` 停手链路全部正常。** 本轮**没有**发现新的游戏内缺陷。
5. 唯一非绿项 `bench_live_nav.mjs` 是 **CANNOT-RUN**（写死主服 25575 + 需要在线探针 + 真实地形），
   属工具适用范围问题，不是本轮缺陷。

### 纪律自查

- 生产服 `server/`、`server-test/` 的世界**全程未写**（`server-test` 只被 junction 只读复用）。
- 所有场景目录在 `tmp/r5-ingame/<场景>/`，每个场景世界都从 `test-template/world` 重拷。
- 每个场景结束都 `RCON stop` 并确认 java 退出；收尾后 `tasklist` 无 java、
  `netstat` 25566/25575/25576 无监听，**无残留进程**。
- RCON 口令每次随机、只写在运行目录的 `server.properties`，未进仓库、未进日志。
