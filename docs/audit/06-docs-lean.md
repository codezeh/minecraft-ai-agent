# 审计⑥ · 文档一致性、死代码与工程资产瘦身

> 审查对象：`E:\我的世界ai`。**未改动任何源码与文档**，本文件是唯一写入物。
> 审查时刻：2026-11-05。方法：文档全量读 + 机器扫描（脚本 + `grep`）+ `du`/`md5sum` 实测，不估算。

**`web/` 前端面板按作者要求不在范围内**（作者声明为草稿、会被重写）。
因此本报告不评 `web/src/**` 的代码质量，也不评估 `web/package.json` 的依赖可删性（草稿会换栈，结论没价值）。
唯一相关的一点放在 §6.3：`mindcraft.js` 会挂载 `web/dist` 作为 `/console`，所以"面板是草稿"这件事对**部署侧**已经生效。

---

## 0. 先说三个会影响结论的前提

### 0.1 仓库边界：`git` 只管 `mindcraft/`，外层整棵树没有版本控制

```
$ ls -d /e/我的世界ai/.git          → No such file or directory
$ cd mindcraft && git rev-parse --show-toplevel → E:/我的世界ai/mindcraft
$ git ls-files | wc -l              → 547
$ git status --porcelain            → (空)
```

即 `scripts/`、`server/`、`server-test/`、`config/`、`docs/`、`web/`、`bots/`、`backups/`、`文件/`、
根目录的 `*.bat` 与 3 个探针脚本 **完全不在任何版本库里**。这决定了 §4 与 §6 的结论方向：
备份目录不是"多余"，`server/` 的配置文件根本没有第二份历史。

### 0.2 层命名已经整体改过（Phase R），而文档停留在改名前

```
$ git log --oneline --all | grep "Phase R"
071fc74 refactor(Phase R): 37 个文件按层改前缀 + import 收敛 + preflight 前缀规矩
b1cbf11 refactor(Phase R 收尾): 4 处前缀违规清到 1 处 …
3b3772e chore(Phase R): 删 skills.followPlayer（真死代码，84 行，零调用方）
```

`00_overview.md:114` 自己也写了这条计划：「代码里的 `task_*.js` 在 Phase R 改成 `flow_*`」。
**它已经执行完了**，但 00~09 与三份设计稿仍按改名前写。于是这些文档里所有 `文件:行号` 指针都指向不存在的文件。

实际命名（`src/agent/library/` 93 个文件）：

| 前缀 | 文件数 | 说明 |
|---|---:|---|
| `flow_*` | 16 | 原 `task_*`（Phase R 改名） |
| `act_*` | 15 | 原 `atom_*` 里的"动作"（Phase A/M3 收拢） |
| `atom_*` | **9** | 只剩输入/读取/等待类（`atom_input_move/mouse/inventory/misc`、`atom_look`、`atom_read`、`atom_tunnel`、`atom_wait`、`atom_wait_item`） |
| `query_*` | 8 | |
| `board_*` | 5 | M8 任务板 |
| `strat_*` | 3 | |

### 0.3 实测体积（`du -sh`，全部真数字）

| 目录 | 体积 | 备注 |
|---|---:|---|
| `mindcraft/node_modules` | **1.3G** | 依赖，必需 |
| `server/` | **716M** | 含 world 113M / bluemap 165M / plugins 106M / libraries 75M / cache 55M / 3 个 jar |
| `.tools/` | 329M | 便携 JDK + Node |
| `server-test/` | **319M** | 测试服（world 116M / libraries 75M / cache 55M / plugins 32M / logs 11M） |
| `web/` | 103M | 不在范围 |
| `backups/` | **71M** | 见 §4 |
| `mindcraft/tmp/` | **38M** | 436 个文件 |
| `mindcraft/bots/` | 34M | 77 个目录 |
| `mindcraft/src` / `tools` / `tasks` / `docs` | 2.5M / 2.2M / 1.9M / 1.1M | |
| `tmp/`（根） | 2.4M | |
| `文件/` `logs/` `bugs/` `config/` `docs/` | 656K / 29K / 20K / 4K / 216K | |
| **合计** | **≈ 2.95 GB** | |

---

## 1. 文档漂移表

### 1.1 命令级缺失（`文档:行` → 不存在的对象）

扫描方式：把 `mindcraft/` 下所有 `.js/.mjs/.json` 建成文件名索引（945 个），再扫 47 份 `.md`
里所有 `xxx.js` 形式的引用，凡"全树没有同名文件"者输出。跑出来的 202 个 token 里，
去掉 `node_modules/...`、`tmp/bench/...`（历史测试产物）等噪声后，**真正会误导人的**如下：

| 文档:行 | 文档里写的对象 | 实际 |
|---|---|---|
| `README.md:32` | 「**21 个 `atom_*.js` 模块**，单一副作用」 | 实际 **9** 个 `atom_*.js` + 15 个 `act_*.js` |
| `交接文档.md:212` | `src/agent/library/atom_dig.js`（100 行，挖一格） | 不存在；现为 `act_dig.js` |
| `交接文档.md:213` | `src/agent/library/atom_move.js`（240 行，走） | 不存在；移动拆进 `atom_input_move.js` + `nav_core.js` + `executor.js` |
| `交接文档.md:121-123` | `atom_climb.js` / `atom_tunnel.js` / `atom_tree.js` | `atom_tunnel.js` 存在；`atom_climb`→`act_climb.js`；`atom_tree` 无（已在 `skills.js`） |
| `01_primitives.md:141,142,143,144,145,146,147,149,156` | `atom_stand.js` / `atom_safe.js` / `atom_perceive.js` / `atom_classify.js` / `atom_tree.js` / `atom_find_drops.js` / `atom_stuck_detect.js` / `atom_query.js` | 全部不存在（现为 `act_step.js` / `query_*.js` / `query_stuck.js` 等） |
| `01_primitives.md:88` | `atom_boat.js` | 不存在 |
| `02_actions.md:24` | `atom_dig.js` | 不存在（`act_dig.js`） |
| `02_actions.md:151`、`08_interface.md:59` | `atom_contract.js` | 不存在（契约在 `contract.js`） |
| `REFACTOR_ANALYSIS.md:11,19,23,24,26,30,31,34,38,39,41,49,50,55,56,57,84,85,89,90,91,94,96,99,100,101,104,105,110-113,118-125,130-140` | `atom_move/stand/dig/place/items/drops/find_drops/container/attack/use/classify/boat/perceive/craft/smelt/…`、`task_collect/follow/pickup/platform/build/mine/…`、`skill_collect/escape/clear/wood/unstuck/…` | 三类前缀**全部**不存在 |
| `REFACTOR_ANALYSIS.md` 全文 | 以 "✅ 已有" 口吻盘点 22 个原子 | 现在 `atom_*` 只有 9 个，且职责已重新划分 |
| `05_navigation.md:9,10,12,15,230-236` | `nav.js` / `path_short.js` / `pathfinder.js` / `walk.js` / `climb.js` / `dig.js` / `swim.js` / `pillar.js` / `drop.js` / `terrain_scanner.js` | 全部不存在（现为 `nav_core.js` / `nav_pathfinder.js` / `nav_hop.js` / `path_3d.js` / `executor.js`） |
| `05_navigation.md:468,471` | `task_modes.js` | 不存在（`modes.js`） |
| `09_crosscut.md:16` | `src/mindcraft/public/settings_spec.js` | 实际是 `settings_spec.json` |
| `09_crosscut.md:53` | `settings_spec.js`、`mindserver.js`（两处混写） | 前者是 `.json` |
| `ARCHITECTURE_REDESIGN_PART2.md:22,23,72,73,136,191,233` | `tests/atoms/atom_dig.test.js`、`src/agent/library/atoms/atom_dig.js`、`tests/mocks/bot.js`、`tests/performance/terrain3d.perf.js` | 没有任何 `tests/` 目录；实际测试是 `tools/*_unit.mjs`（62 个）+ `tools/test_*.mjs`（44 个） |
| `07_control.md:141`、`REFACTOR_ANALYSIS.md:49` | `task_follow.js` | 不存在（`flow_follow.js`） |
| `04_skills.md:258`、`自研申报.md:1573` | `memory/chests.js` | 不存在（`memory_store.js` 的 chest 命名空间） |
| `08_interface.md:117` | `chests.js` | 不存在 |
| `M8_实施设计.md` §1 表格 | `board_store.js` / `board_server.js` / `board_client.js` / `board_scheduler.js` 全部标 **❌ 不存在** | **五个文件全部存在**：`board_store.js` 71 785 B、`board_scheduler.js` 46 699 B、`board_server.js` 24 379 B、`board_client.js` 23 261 B、`board_claims.js` 8 872 B |

### 1.2 数字漂移

| 文档:行 | 文档说 | 实测 | 命令 |
|---|---|---|---|
| `docs/README.md:25`、`:54` | 「31 条错误码」 | **38** | `node -e` 解析 `contract.js` 的 `CODES` 数组 → `CODES length = 38` |
| `README.md:32` | 21 个 `atom_*.js` | 9（+15 `act_*`） | `ls src/agent/library/atom_*.js \| wc -l` → `9` |
| `README.md:34`、`:116-123` | 「8 套共 156 项」 | 8 个测试脚本**都存在**，但仓里另有 **44** 个 `test_*.mjs` + **62** 个 `*_unit.mjs` | `ls tools/test_*.mjs \| wc -l` → 44；`ls tools/*_unit.mjs \| wc -l` → 62 |
| `docs/README.md:104` | `game_rules.json` 18 条规则 | **18** ✓（这条是准的） | `node -e "…game_rules.json…"` → `rules: 18` |
| `README.md:110` | preflight 是「5 项审计」 | 实际 4 层 + `audit_rules.mjs` 的第 5 层（字段审计确实存在，`audit_rules.mjs:291`）✓ | 与 `docs/README.md:119` 的「四层自检」自相矛盾（同一工具两种计数） |

### 1.3 部署与默认值漂移（含一条安全相关）

| 文档:行 | 文档说 | 实际 |
|---|---|---|
| `README.md:76` | 「默认使用 `profiles/deepseek.json`」 | `settings.js:18-20` 写的是 `"./profiles/my-local.json"` |
| `README.md:128` | 「详见 `docs/经验教训.md`」 | 该文件已迁到 `docs/legacy/经验教训.md`（`ls docs/经验教训.md` → No such file） |
| `README.md:138` | 文档表里链 `docs/经验教训.md` | 同上，死链 |
| `README.md:140` | 链 `docs/readme-upstream.md` | 实际 `docs/legacy/readme-upstream.md`（死链） |
| `README.md:52-53` | 「Node.js 18 或 20 LTS（Node 24+ 可能与原生依赖冲突）」 | 本机运行的是 **Node v24.16.0**（`node -v`），且 `package.json` 没有 `engines` 字段兜底 |
| **`README.md:177-179`** | 「**代码执行默认关闭**，如需开启请把 `allow_insecure_coding` 设为 `true`」 | **`settings.js:33` 是 `true`**（已开启），注释还写着"已开启" |

最后一条是**安全相关的反向漂移**：README 给读者的第一印象是"默认安全、需手动开"，
而实际配置文件是开着的，且 `!newAction` 的闸门（`actions.js:119`）就是读这个值。
一个照 README 判断风险的人会低估这套部署。**修法**：改 README 那一句，或把 `settings.js:33` 改回 `false` 再在
`my-local.json` 里单独开——两者选一，不要一边说关一边是开。

### 1.4 M8 设计稿的"现状核对"表整张作废

`M8_实施设计.md:10-20` 用 `❌ 不存在` 逐个否掉四个 `board_*` 模块，并说"改设计的时候它们都还不存在"。
现在 B1~B4 都落地了（`board_store/server/client/scheduler` 五个文件、共 175 KB），
`mindserver.js:83` 里还调 `attachBoardServer`。这份文档的 §1 表格如今**每读一次就是一次误判**。

### 1.5 反向：`src` 里重要模块没被文档提到

抽查 17 个骨架模块在 `docs/` 里的提及文件数（`grep -rl <name> docs/ | wc -l`）：

| 模块 | 文档提及文件数 | 判断 |
|---|---:|---|
| `nav_core` | 12 | ✓ |
| `step_runner` | 8 | ✓ |
| `flow_fight` / `strat_obtain` / `trace_bus` | 7 | ✓ |
| `flow_build` / `flow_shelter` / `board_client` | 5 | ✓ |
| `board_store` / `board_scheduler` / `strat_tool_tier` / `flow_mine` | 4 | ✓ |
| `terrain_view` / `nav_pathfinder` | 2 | 偏少但存在 |
| `flow_collect_plan` | **1** | ⚠️ 只在 `REFACTOR_ANALYSIS` 里被点名，00~09 完全没有它的契约 |

结论：**反向缺失不严重**——真正的问题不是"新模块没人写文档"，而是"文档写的名字已经不是代码的名字"。

---

## 2. 四份设计稿的处置建议

判断依据统一用三条：① 文档自称是什么时点的东西；② 它描述的代码事实今天是否成立；③ `docs/README.md` 是否把它列为必读。

| 文档 | 体积 | 自称 | 今天的代码事实 | 建议 |
|---|---:|---|---|---|
| `ARCHITECTURE_REDESIGN.md` | 38 KB | 目标设计 v2.0（2026-10-31） | §6 契约仍被代码引用（错误码/字段名），但 §5 组件清单里的 `atom_*`/`task_*` 名字全废 | **保留，但加一行头注**：本文件的组件清单按 Phase R 前的命名写；契约部分（§6）仍有效 |
| `ARCHITECTURE_REDESIGN_PART2.md` | 18.7 KB | 测试策略 + Phase 时间表 | `tests/` 目录从来没建过，实际测试是 `tools/*_unit.mjs`；Phase 表已过时（M1~M8 大多完成） | **归档**到 `docs/archive/`，或删。它对今天**没有任何可执行内容** |
| `M8_实施设计.md` | 14 KB | 「实施前的设计，**不是**实施记录」 | B1~B4 已落地，§1 现状表全反 | **改成实施记录**（把 ❌ 逐行改成 ✅ 并链到文件），或直接归档。**不能原样放着** |
| `REFACTOR_ANALYSIS.md` | **250 KB** | 现状诊断 + D1–D27 台账 + 勾选路线图 | 主体是"今天哪里烂"的盘点，但**几乎每条都指向已改名的文件**（`atom_move.js` 等 30+ 处）；`docs/README.md:26` 却把它列为**必读第 3 篇**并说「§5 是勾选式验收清单」 | **拆**：保留 §3.4 的 D1–D27 台账与 §5 勾选清单（这两块有长期价值），删掉 §1「现有组件盘点」等已作废的现状描述。它是全仓最大的一份文档，也是最大的一份过期文档 |

一句话结论：**四份里只有 `ARCHITECTURE_REDESIGN.md` 的 §6 仍在生效**；
`PART2` 与 `M8` 应该从 `architecture/`（README 第 10 行自称"唯一权威"）里移出去，
`REFACTOR_ANALYSIS` 需要拆分——保留台账、砍掉现状盘点。

---

## 3. 死代码清单（每条都附 grep 命令与零匹配证据）

扫描口径：先建全树 token 计数（`.js/.mjs/.md/.json` 全部参与，`node_modules`/`.git`/`bots` 除外），
再对 `src/**` 每个 `export function|class|const|let` 取名字，**全树总计只出现 1 次（即只有定义处）** 者列为死导出。
这条判据很保守：连注释、文档里提过一次都会让它"不算死"，所以下面 17 条可以放心。

```bash
# 复现命令（全树计数，只看 src，排除动态发现的 models/）
node -e '…建立 token 计数 → 对 src 每个 export 名计数 → 输出 count<=1…'
# 逐条核对（示例，其余同）
grep -rn --exclude-dir=node_modules --exclude-dir=.git "resetConstructionWorld" src tools *.js | wc -l   # → 1
```

### 3.1 零引用的导出（17 个，合计 **69 行**）

| 文件:行 | 导出 | 行数 | grep 计数 |
|---|---|---:|---:|
| `src/agent/library/collect_targets.js:92` | `CATEGORY_HINT` | 1 | 1 |
| `src/agent/library/landmarks.js:247` | `landmarksFileFor` | 4 | 1 |
| `src/agent/library/memory_store.js:46` | `knownNamespaces` | 3 | 1 |
| `src/agent/library/memory_store.js:120` | `updateStore` | 6 | 1 |
| `src/agent/library/nav_hop.js:39` | `describe3dStore` | 3 | 1 |
| `src/agent/library/storage.js:121` | `countInChest` | 6 | 1 |
| `src/agent/library/world_model.js:33` | `LAVA_BLOCKS` | 1 | 1 |
| `src/agent/library/world_model.js:69` | `isGroundBlock` | 5 | 1 |
| `src/agent/rules/rules.runtime.js:100` | `hardnessOf` | 4 | 1 |
| `src/agent/rules/rules.runtime.js:106` | `leavesDistanceMax` | 5 | 1 |
| `src/agent/rules/rules.runtime.js:113` | `playerBox` | 4 | 1 |
| `src/agent/tasks/construction_tasks.js:36` | `resetConstructionWorld` | 10 | 1 |
| `src/mindcraft/mindcraft.js:77` | `getAgentProcess` | 3 | 1 |
| `src/utils/loop_lag.js:45` | `stopLoopLagWatch` | 3 | 1 |
| `src/utils/mcdata.js:55` | `isMcDataReady` | 3 | 1 |
| `src/utils/mcdata.js:248` | `getAllItemIds` | 8 | 1 |

> 已排除的误报：`src/models/*.js` 的 17 个类**不是死代码**——它们由 `_model_map.js:12-29`
> 按 `readdir` + `exported.prefix` 动态发现，静态 grep 必然看不见引用。
> 同理 `skills.js` / `world.js` 的导出是**给模型看的 API 面**（`coder.js:189-194` 把
> `skills`/`world` 当 endowment 注入沙箱），不算死代码，**不能删**。

### 3.2 整文件死代码

| 路径 | 行数 | 证据 |
|---|---:|---|
| `src/mindcraft-py/`（`init-mindcraft.js` 23 行 + `mindcraft.py` 99 行 + `example.py` 27 行） | **149** | `grep -rn "mindcraft-py" .` 只命中 `.gitignore:30`（`src/mindcraft-py/__pycache__/`）；没有任何 JS 引用它 |
| `tools/test_tile_map.mjs` | 90 | 首行 `import … from '../src/agent/library/tile_map.js'` —— 该模块**已删**（`ls src/agent/library/tile_map.js` → 无），此脚本 `import` 必失败 |
| `tools/test_chunk_map.mjs` | 110 | 同上，`import … from '../src/agent/library/chunk_map.js'` 已不存在 |
| 根 `m6probe.mjs` + `m6_furnace_probe.mjs` + `m6_harvest_probe.mjs` | 108 + 116 + 31 = **255** | `grep -rn "m6probe\|m6_furnace_probe\|m6_harvest_probe" mindcraft/src mindcraft/tools mindcraft/docs docs` → **0 命中** |
| `mindcraft/andy.json` | 5 | `grep -rn "andy.json" --include=*.js --include=*.json .` → 只命中 `docs/legacy/readme-upstream.md` 的叙述；入口是 `settings.js:18-20` |
| `src/agent/tasks/tasks.js:64-68` | 5 | `CraftTaskValidator` 类被 `//` 整段注释掉（`grep -n "CraftTaskValidator"` → 唯一命中是 `64:// export class CraftTaskValidator {`，其后 4 行同被注释） |

**小计：死代码约 69 + 149 + 200 + 255 + 5 + 5 ≈ 683 行。**

### 3.3 `tools/` 的存量（不是死代码，但需要处置）

```
$ ls tools | wc -l          → 214
$ git ls-files tools | wc -l → 207
分类：test_* 44 · *_unit 62 · atom_* 19 · board_* 18 · probe_* 14 · diag_* 11 · bench_* 10 · verify_* 8 · strat_* 7 · flow_* 7 · t37_* 6 · _dbg 1
```

`tools/` 是**全仓最大的单目录**（207 个被跟踪文件，比 `src` 的 172 还多）。其中 `bench_*`(10) /
`probe_*`(14) / `diag_*`(11) / `t37_*`(6) 共 ~41 个属于"一次性现场"。
它们有考古价值（`docs/legacy/经验教训.md` 大量引用），**不建议删**，但建议按
`tools/{tests,bench,probe}/` 分三个子目录——这是 §7 的搬动方案的一部分。

---

## 4. 重复资产与体积（全部实测）

### 4.1 同一份文件的重复拷贝

```
$ md5sum server/server.jar server/paper-1.21.8-60.jar
052b8c9b5415f660127ef31fa1382b8e *server/server.jar
052b8c9b5415f660127ef31fa1382b8e *server/paper-1.21.8-60.jar
```

**两个 51 MB 的 jar 是同一个文件**（`ls -l` 都是 52 811 717 B）。`proc_control.js:67-70` 的
`findServerJar()` 只读 `server/server.jar`，所以 `paper-1.21.8-60.jar` 是纯冗余 → **可删 51 MB**。

另有 `server/server-vanilla-1.21.8.jar`（55 MB）：`ls server/*.jar` 三个 jar 里它是原版服，
代码没有任何一处引用它（`grep -rn "server-vanilla" src tools` → 0）→ **可删 55 MB**（除非保留来做对照实验）。

### 4.2 `backups/` 的性质：不是"同一快照的多份拷贝"，而是"30 个不同时刻的小快照"

```
$ du -ch backups/* | tail -1        → 71M total
```

| 分块 | 体积 | 内容 |
|---|---:|---|
| `preinstall-20261018-220629/` | **49M**（87 文件） | `server/` 的首次快照：`ops.json` + `plugins/` + `server.properties` |
| `world-preinstall-20261018-220642/` | **13M** | 世界存档目录快照（level.dat / region / playerdata …） |
| `world-1.21.8-20261018-185639.zip` | 3.7M | 同一世界的 zip 版 |
| 其余 ~28 个目录（`levelfix-*`、`groundfix-*`、`facing-*` …） | 合计 ~5.3M | 每次改动前的 1~4 个**源码文件**快照 |

抽查 md5 证明"每个都是不同版本"、不是拷贝：
```
a353c6db… backups/levelfix-20261020-200120/skills.js
62b6d5ef… backups/groundfix-20261020-211153/skills.js
90217bec… backups/facing-20261020-203224/skills.js
66ed707c… .atom-v2-backup/skills.js.bak
```
四份互不相同 → 它们各自是一次真实回滚点。

**但关键前提（§0.1）**：这些 `.js` 全是 `mindcraft/src/**` 里**被 git 跟踪**的文件的历史版本，
git 历史里永远能取回。所以：

| 可删项 | 体积 | 为什么安全 |
|---|---:|---|
| ~28 个小快照目录 + `.atom-v2-backup/`（300 KB） | **≈5.6M** | 全是被 git 跟踪的 `skills.js`/`actions.js`/`agent.js` 的旧版本 |
| `world-preinstall-20261018-220642/`（保留 3.7M 的 zip 一份） | **13M** | 同一世界的两种存法，留一份够 |
| `preinstall-20261018-220629/` | 49M | **不要删** —— `server/` 不在 git 里，这是它唯一的历史 |

### 4.3 其他可删/可重建体积

| 项 | 体积 | 判断 |
|---|---:|---|
| `mindcraft/tmp/`（436 文件，`server-test-run.log` 12M、`board-test` 3.5M、`test.db` 3.3M 等） | **38M** | `.gitignore:16` 已忽略；纯运行残留 → 可删 |
| 根 `tmp/`（`uplink` 1.4M、`package-lock.json.bak-433` 280K、`acl-recovery` 65K…） | **2.4M** | 调试残留 → 可删（注意 `tmp/` 是 `.agent-teams` 之外的临时区，删前确认没有待查证据） |
| `mindcraft/bots/` 77 个目录 | **34M** | 实际在用的只有 `deepseek`；其余是 `blk2`/`blk3`/`hprobe`/`hprobe4`/`dirprobe`/`cmdprobe`/`fixture`/`__nonexistent_map__`/`dafeiyu`/`dg2812`… 等探针残留 → 可删 ~70 个 |
| `server-test/logs/` | 11M | 测试服日志 → 可清 |
| `server/bluemap/` | **165M** | BlueMap 的**渲染产物**（插件本体只有 5.5M）。可重建；不用 3D 地图就整目录删 |
| `server/cache/` + `server-test/cache/` | 55M + 55M | Paper 的 remote chunk cache，可重建 |
| `server/libraries` + `server-test/libraries` | 75M + 75M | Paper 的依赖库，删了下次启动会自动下（需要网络） |

**保守可删（不含"看你要不要"的项）：51 + 55 + 5.6 + 13 + 38 + 2.4 + ~30 + 11 ≈ 206 MB**
**加上条件项（bluemap 165M + 两个 cache 110M + 两个 libraries 150M）最多可再省 425 MB。**

---

## 5. 依赖可删清单（`mindcraft/package.json`，逐个 grep）

复现命令（对每个包名，在全仓 JS 里找 `'pkg'` / `"pkg"` / `'pkg/...` 形式的 import）：
```bash
grep -rn --exclude-dir=node_modules --exclude-dir=.git --exclude=package-lock.json \
     -E "['\"/]<包名>['\"/]" . | grep -v '^./package.json'
```

| 包 | 直接 import 处 | 判定 |
|---|---:|---|
| **`prismarine-schematic`** | **0** | ✅ **可删**。`schematic.js:9` 的注释明说「为什么不用 prismarine-schematic」（自己实现了 NBT 解析） |
| **`canvas`** | **0** | ⚠️ 无一文件 import，但 `node-canvas-webgl` 在 require 时要它。`package.json` 的 `overrides` 还专门钉了 `canvas: ^3.1.0` → **建议移到 `optionalDependencies`**，不要删 |
| `three` | 1（`vision/camera.js:20`） | 保留；但只服务 `allow_vision`（`settings.js:36` = false） |
| `node-canvas-webgl` | 1（`camera.js:21`） | 同上 |
| `prismarine-viewer` | 2（`browser_viewer.js:9`、`camera.js:17-19`） | 同上 |
| `replicate` | 1（`models/replicate.js`） | 保留（模型适配器之一） |
| `ses` | 1（`library/lockdown.js:1`） | 保留——这是代码沙箱本体 |
| `mineflayer` | 103 处 | 保留 |
| `mineflayer-pathfinder` | 104 处 | 保留 |
| `mineflayer-collectblock` / `-pvp` / `-auto-eat` / `-armor-manager` / `-death-event` / `-schem` / `@nxg-org/mineflayer-smooth-look` | 6 / 3 / 1 / 1 / 1 / 1 / 1 | 全部保留（每个都挂在 `mcdata.js:99-167` 的 `loadPlugin`） |
| **`eslint` / `@eslint/js` / `globals` / `eslint-plugin-no-floating-promise`** | 均只被 `eslint.config.js` 引用 | ⚠️ **是开发工具，却放在 `dependencies`** → 移到 `devDependencies`（`npm i --production` 能省这 4 个包） |

**净结论：可删 1 个包（`prismarine-schematic`），另有 5 个包应改归类（`canvas` → optional，4 个 eslint 系 → dev）。**

风险提示：`canvas` 若真删，`vision/camera.js:23-29` 的 catch 会把错误包装成
"Vision requires the native `canvas` addon…"，虽然 `allow_vision=false` 时不会走到，
但 `browser_viewer.js:9` 的 `import('prismarine-viewer')` 是**动态**的、且有 catch——两个都是"缺了也能跑"，
所以移到 `optionalDependencies` 是最贴合现状的归类。

---

## 6. 仓库卫生

### 6.1 该进 `.gitignore` 的（`mindcraft/` 侧）——基本已经对了

```
$ git ls-files | wc -l      → 547
$ git status --porcelain    → (空)
$ git ls-files | grep -iE "\.log$|node_modules|/tmp/|\.bak$|\.zip$" → 仅 bots/execTemplate.js、bots/lintTemplate.js（模板，正常）
```

`.gitignore` 已覆盖：`node_modules/`(3)、`keys.json`(9)、`bots/**/`(8)、`tmp/`(16)、`src/models/logs/*`(21)、
`*.log`(35)、`tools/_*.mjs`(46)、`*_probe.mjs`(67)、`t1[0-9]_*.mjs`(68)、`bots/_board/`(72)、
`profiles/*-private.json`(54)、`profiles/*-local.json`(55)。
`git check-ignore` 抽查：`bots/_board` → ignored ✓，`tmp` → ignored ✓。

### 6.2 真正的问题：外层整棵树没有版本控制（见 §0.1）

`scripts/`（启动/停止面板）、`config/network.json`、`server/server.properties`、`docs/audit/*`、
`docs/archive/*`、`web/`、根 `*.bat` —— **全部无 git**。这意味着：

* `docs/` 下这批有长期价值的文档（含本次三份审计报告）**没有任何历史**，改错了找不回来；
* `server.properties`（含 RCON 口令）、`ops.json`（341 条）、`whitelist.json` 只靠 `backups/preinstall-*` 那一份快照兜底；
* 启动脚本 `start-panel.ps1`（211 行）改坏了没有回滚点。

**最小修复（不搬目录）**：在 `E:\我的世界ai` 根建一个 `.gitignore` + `git init`，只收
`scripts/ docs/ config/ *.bat`，把 `server/ server-test/ web/ mindcraft/ backups/ tmp/ .tools/ bots/ 文件/` 全部忽略。
这样成本最小（约 20 行 .gitignore），收益是"文档与启动脚本有了历史"。

### 6.3 顺带一提（不是代码质量问题）

`mindcraft.js:164-172` 会把 `../../../web/dist` 挂到 `/console`，且面板上线的 `server-stop` /
`create-agent` 等事件就是审计③的 I1/I3。所以"面板是草稿"这个判断对**部署侧**已经生效：
草稿面板已经是唯一能用的控制入口。这不是要审前端代码，只是说明"草稿"这个定性会影响安全结论的严重度。

---

## 7. 目录结构最小搬动方案

根目录现在把「产品代码」和「运行现场」混在一起：

```
我的世界ai/
├── mindcraft/        ← 唯一的 git 仓库（产品代码）
├── web/              ← 草稿面板（103M，含 node_modules）
├── server/           ← 主服运行现场（716M：世界/插件/地图/jar）
├── server-test/      ← 测试服运行现场（319M）
├── .tools/           ← 便携 JDK/Node（329M）
├── backups/  tmp/  logs/  bots/  bugs/  文件/   ← 现场与考古
├── scripts/  config/  docs/              ← 项目自己的运维与文档
├── 启动面板.bat  停止面板.bat
└── m6probe.mjs  m6_furnace_probe.mjs  m6_harvest_probe.mjs   ← 一次性探针
```

**最小搬动（只动 4 步，不动 `mindcraft/`、不动 `web/`、不碰 git 结构）**：

1. **建 `runtime/`**，把运行现场收进去：`server/`、`server-test/`、`backups/`、`logs/`、`tmp/`、`bots/`。
   代价：`proc_control.js:24-25` 的 `ROOT`/`SERVER_DIR`、`start-panel.ps1:135` 的 `server\server.jar`
   路径、`server_props.js:69` 的 `['server','server-test']` 都要跟着改 3 处常量。**这是唯一需要改代码的搬动**，
   建议与"给外层建 git"（§6.2）一起做，这样改坏了能回滚。
2. **删根目录 3 个 `m6*.mjs`**（255 行零引用）→ 或移进 `tools/archive/`。
3. **`文件/`（656K，22 份 md 规划稿）并入 `docs/`**，与 `docs/archive/` 同级——它现在是一个
   名字叫"文件"的文档目录，和 `docs/` 重复。
4. **`bugs/`（根，20K）与 `mindcraft/docs/bugs/` 合并**：现在两处都叫 `bugs`，`docs/README.md:95-97`
   索引的是 `mindcraft/docs/bugs/` 那三份，根目录的 `bugs/` 没人引用。

不建议动的：`mindcraft/`（git 仓库根，动了要改所有相对路径）、`web/`（不在范围）、`.tools/`（体积大但改了要改两处脚本）。

---

## 8. Lean 总结

```
Lean: -683 行, -1 依赖
```
拆解：

| 项 | 行数 / 数量 | 依据 |
|---|---:|---|
| 零引用导出（17 个） | **−69 行** | §3.1，每个 grep 计数 = 1 |
| `src/mindcraft-py/` 整目录 | **−149 行** | §3.2，零 JS 引用 |
| 两个 import 已删模块的测试脚本 | **−200 行** | §3.2，import 目标文件不存在 |
| 根 3 个 m6 探针 | **−255 行** | §3.2，全树 0 引用 |
| `andy.json` | **−5 行** | §3.2，无代码引用 |
| 注释掉的 `CraftTaskValidator` | **−5 行** | `tasks.js:64-68` 整段 `//` |
| **合计代码** | **−683 行** | |
| 依赖 | **−1**（`prismarine-schematic`） | §5，0 import |
| 依赖改归类（不算删除） | 5 个 | `canvas`→optional；`eslint`/`@eslint/js`/`globals`/`eslint-plugin-no-floating-promise`→dev |
| **磁盘（保守）** | **≈ −206 MB** | 重复 jar 51M + 原版 jar 55M + 源码快照 5.6M + 世界冗余 13M + `mindcraft/tmp` 38M + 根 `tmp` 2.4M + ~70 个 bots 目录 ~30M + 测试服日志 11M |
| **磁盘（含条件项）** | **≈ −631 MB** | 再加 bluemap 165M + 两处 cache 110M + 两处 libraries 150M（均为可重建） |
| 文档 | 归档 2 份（`PART2` 18.7K + `M8` 14K）、拆 1 份（`REFACTOR_ANALYSIS` 250K） | §2 |

---

## 9. 未读部分（诚实清单）

* `mindcraft/docs/自研申报.md`（132 KB，全仓最大单文件）**只读了目录与抽查段落**，未逐条核对 20 条申报。
* `mindcraft/docs/架构交接-总.md`（33 KB）、`交接文档.md`（23.5 KB）**读了漂移相关段落**（文件清单、模块表、错误码），未通读全文。
* `mindcraft/docs/回归-runbook.md`（12 KB）、`架构交接-夜间.md`（10 KB）：只核对了它们引用的 `tmp/bench/*.js` 路径（全部已不存在，属历史记录）。
* `docs/archive/*.md`（8 份，79 KB）：属明确的历史归档，只核对了是否与 `docs/legacy/` 重复（未发现同内容重复）。
* `mindcraft/docs/legacy/`（21 份）：只用于判断"哪些名字是历史名"，未逐份校对其内容准确性。
* `tools/` 207 个被跟踪文件中，只读了 `atom_all.mjs`、`audit_codes.mjs`、`audit_rules.mjs`（节选）、`preflight.mjs`（节选）、`test_tile_map.mjs`/`test_chunk_map.mjs`（头部）、`unit_all.mjs`（未读）。
* `web/**`：**按作者要求不审**（见开头）。
* 未运行 `preflight.mjs` / `atom_all.mjs` / `unit_all.mjs`（需要测试服 25566，且属"改代码后的验证"，不在本次只读范围）。

---

*报告完。未修改任何被审查源码与文档；本文件为唯一写入物。*
