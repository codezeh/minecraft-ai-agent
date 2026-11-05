# 审计⑩ · 深读③：自研申报全文 / legacy / bugs / 回归 runbook / 许可证

> 工作目录 `E:\我的世界ai`。**未改任何源码与文档**（`cd mindcraft && git status --porcelain` 为空，见文末）。
> 唯一写入：本文件 `docs/audit/10-docs-license-bugs.md`。
> 审查时刻：2026-11-05 17:20~17:40。Node v24.16.0。
> 本轮把审计⑥自报未读的四块读完了：`自研申报.md`(2102 行全文)、`docs/legacy/`(22 份)、
> 两处 `bugs/`(各 3 份)、`回归-runbook.md`(219 行全文)、`FAQ.md`(38 行全文)、`docs/` 与 `docs/architecture/` 关系。

## 0. 结论速览

| 问 | 结论 |
|---|---|
| 1. 自研申报 vs 实际代码 | **申报制度本身是可信的**（每条带日期+用户授权原话+已检索候选），抽查最近两条与代码**逐行对上**；但**61 条里 17 条的模块已不存在**、编号重复 1 处、`game_rules.json` 申报 13 条实为 18 条 |
| 2. "四套寻路"是否零残留 | **文件确已全删（零残留）**；但**5 个 `tools/` 脚本仍 import 它们，一直崩**（`ERR_MODULE_NOT_FOUND`），另有 1 条棘轮基线指向 `tile_map.js` |
| 3. 许可证完整性 | **MIT 正文完整、版权行完整**（`mindcraft/LICENSE:1-3`）；README 的许可声明基本属实，**但"原项目 README"链接已失效** |
| 4. bugs 现状 | BUG-001 已修（版本可验）**但 4 个证据脚本全缺且被 gitignore → 不可复现**；BUG-002 已修**但修复位置指向已删文件、无回归测试**；BUG-003 **挂了 11 天仍"根因未定"** |
| 5. runbook 失效步骤 | 两条核心命令**实测仍可用**；失效的是**§5 归档清单**（说 6 个，实际 **38** 个）与**§② 的规模描述**（说"7 个脚本/17 个用例"，实际 17 个脚本） |
| 6. FAQ 不一致 | 2 条：`ERR_MODULE_NOT_FOUND → npm install` 在本仓库会把人带偏；`use andy.js by default` 与默认配置不符 |
| 7. 新发现 | F1~F14（2 Must / 8 Should / 4 Nice） |

---

## 1. 自研申报 vs 实际代码（必答 1）

### 1.1 制度本身：可信，且格式严谨

`docs/自研申报.md`（2102 行，68 个 `## 申报` 标题）每条固定五段：
**要解决的问题 / 已检索的候选（表格，逐条写"不选"的理由）/ 为什么都不够 / 拟自研范围 / 回收条件 / 结论**。
结论一律是「已批准」并附**用户授权原话 + 日期**（例：`:36`「用户在 P0 授权时选择「批准自研 step_runner」」）。

**上游与自研的边界是写清楚的**，这点值得肯定：
* `:1249` 明确称 `skills.js` 为 **「（上游遗留文件）」**；
* `:1244` 表里「上游 `mindcraft` 原版」被判 ❌「原版就是各处手拼，正是本问题的来源」；
* `:98`、`:143`、`:120` 等处把 `skills.js` 的 `openKnownChest`/`attackNearest`/`useDoor` 当作**被重构对象**而非自研成果。

→ **没有发现"把上游代码申报成自研"的情况。** 反过来（自研被当成上游）也没发现。

### 1.2 抽查：最近两条与代码逐行对上（正例）

| 申报 | 它说 | 实测 |
|---|---|---|
| 申报 70（L2001-2005）`NPC_EXEC_LOOP_ENABLED = false` + 在 `bot.on('idle')` 首行短路 + 恢复说明写在文件头与短路处 | 三处都有 | `controller.js:32` `const NPC_EXEC_LOOP_ENABLED = false;`；`:97` `if (!NPC_EXEC_LOOP_ENABLED) return;`；恢复说明在 `:22-25` 与 `:95` ✅ |
| 申报 72（L2087-2094）`makeCtx` 新增 `jobBudget:{limit,used,hitCap}`，limit 取 `manifest.jobBudget` 默认 40；`strat_first_night` 用 `jobBudget: 12` | — | `composite_registry.js:486-496` 有 `jobBudget` 与默认 40；`strat_first_night.js:234` `jobBudget: 12` ✅ |
| 申报 71（L2053）`strat_first_night_unit` **12 条**；申报 72（L2099）`job_budget_unit` **10 条** | — | 审计⑪实测：这两个脚本 EXIT=0、PASS 分别为 **12** 与 **10** ✅ |

### 1.3 差异表：申报了但已经对不上的（逐条给依据）

机械核对方式：从 `## 申报 NN · 日期 · xxx.js` 抽出模块名，与 `src/**` 实际文件名比对——
**61 条可解析的申报里，44 条文件名仍存在，17 条已不存在**：

| 申报$行号 | 申报的模块 | 现状 | 依据 |
|---|---|---|---|
| L95 申报5 | `atom_container.js` | 不存在 | `ls src/agent/library/atom_container.js` → No such file（现为 `act_container.js`） |
| L117 申报6 | `atom_use.js` | 不存在 | 现为 `act_blockuse.js`；且 `tools/atom_all.mjs:46` 注释写明「t44 已删 act_use.js/atom_use.mjs」 |
| L140 申报7 | `atom_attack.js` | 不存在 | 现为 `act_attack.js` |
| L162 申报8 | `atom_locate.js` | 不存在 | 拆分进 `query_*.js` |
| L242 申报10 | `atom_stand.js` | 不存在 | 现为 `act_step.js` + `query_stand.js` |
| L301 申报12 | `atom_drops.js` | 不存在 | 现为 `flow_pickup.js` |
| L363 申报14 | `atom_safe.js` | 不存在 | 现为 `query_safe.js` |
| L391 申报15 | `atom_classify.js` | 不存在 | 现为 `world_model.js` |
| L436 申报17 | `skill_collect.js` | 不存在 | 现为 `flow_collect*.js` |
| L460 申报18 | `skill_clear.js` | 不存在 | 现为 `flow_clear.js` |
| L494 申报19 | `atom_find_drops.js` | 不存在 | 现为 `query_drops.js` |
| L546 申报26 | `atom_climb.js` | 不存在 | 现为 `act_climb.js` |
| L686 申报28 | `atom_tree.js` | 不存在 | 并入 `skills.js` |
| L724 申报29 | `atom_boat.js` | 不存在 | 已删（README:148 记录载具在 1.21.8 不可用） |
| L852 申报31 | `task_pickup.js` | 不存在 | 现为 `flow_pickup.js` |
| L882 申报32 | `atom_stuck_detect.js` | 不存在 | 现为 `query_stuck.js` |
| L909 申报33 | `atom_pillar.js` | 不存在 | 现为 `act_pillar.js` |

**编号缺陷**：`## 申报 42` 出现**两次**——`:1230` `bot_paths.js`、`:1272` `act_craft.js`。
（`grep -oE "^## 申报 [0-9]+" | sort | uniq -d` → `## 申报 42`）

**数据型陈述过期**：`:74` 说 `rules/game_rules.json`（数据，**13 条**）——
实测 `node -e` 读该文件 = **18 条**（审计⑥也独立测到 18）。

**性质说明（不判为缺陷）**：`:28`「step_runner.js 约 60~90 行」实际 **164 行**、`:235`「rcon_client.js 约 140 行」实际 **175 行**
——这些在「**拟**自研范围」里，是提案时的估算，事后变大属正常，不构成文档错误。

**真正的问题不是这些条目本身，而是没有任何地方标注它是历史台账**：文件头（`:1-6`）只写了
「规矩 / 判定顺序 / 结论三态」，没有「本文是逐日台账，模块名会随后续重命名而失效，最新实现以 `src/` 为准」这类一句话。
配合 `docs/README.md:82` 说「`tools/audit_rules.mjs` 靠它检查新模块有没有申报」，读者很容易把它当**现行清单**用。 → **F6**

---

## 2. "移除的四套寻路实现"是否零残留（必答 2）

### 2.1 文件层：**确实全部删除**

```
$ ls src/agent/library/{heatmap,tile_map,path_long,chunk_map}.js
ls: cannot access 'src/agent/library/heatmap.js': No such file or directory
ls: cannot access 'src/agent/library/tile_map.js': No such file or directory
ls: cannot access 'src/agent/library/path_long.js': No such file or directory
ls: cannot access 'src/agent/library/chunk_map.js': No such file or directory
```

### 2.2 引用层：**有残留，且其中 5 处是"活的崩溃点"**

```
$ grep -rn --exclude-dir=node_modules --exclude-dir=.git "heatmap\|tile_map\|path_long\|chunk_map" . | grep -v "^./docs/"
```

**A. 直接 `import` 已删模块的脚本（一跑就崩，5 个）**

| 文件:行 | import 语句 | 实跑结果 |
|---|---|---|
| `tools/test_split_plan.mjs:5` | `import { planLong, describeLong } from '../src/agent/library/path_long.js'` | `ERR_MODULE_NOT_FOUND` |
| `tools/measure_corridors.mjs:3` | `import { openMapReader } from '../src/agent/library/chunk_map.js'` | `ERR_MODULE_NOT_FOUND` |
| `tools/measure_corridors.mjs:4` | `import { classifyChunk, tileCost } from '../src/agent/library/tile_map.js'` | 同上 |
| `tools/probe_map_main.mjs:6` | `import { scanArea, getChunk, … } from '../src/agent/library/chunk_map.js'` | `ERR_MODULE_NOT_FOUND` |
| `tools/test_tile_map.mjs`（首行区） | `from '../src/agent/library/tile_map.js'` + `chunk_map.js` | `ERR_MODULE_NOT_FOUND` |
| `tools/test_chunk_map.mjs`（首行区） | `from './rcon.mjs'` + `chunk_map.js` | `ERR_MODULE_NOT_FOUND` |

验证命令与真实输出：
```
$ cd mindcraft && for f in test_split_plan measure_corridors probe_map_main test_tile_map test_chunk_map; do node "tools/$f.mjs" 2>&1 | head -1; done
（五个都是）node:internal/modules/esm/resolve:271  throw new ERR_MODULE_NOT_FOUND(
```
这 5 个脚本**不在任何 runner 清单里**（`grep -l <name> tools/unit_all.mjs tools/atom_all.mjs tools/preflight.mjs` → 0 命中），
所以没人跑它们、也就没人发现它们坏了。 → **F5**

**B. 棘轮基线里指向已删文件（1 条）**
`src/agent/rules/audit_baseline.json` 的 `items` 里有
`{ "file": "src/agent/library/tile_map.js", "line": 23, "value": "0.6", … }` —— 指向已删文件。 → 见 **F2**（同类共 9 条）

**C. 只剩注释/历史叙述（不算残留，可保留）**
`executor.js:10`（"旧架构的病：四套规划器…"）、`path_3d.js:4`（"取代 tile_map 的 16 格战棋格 A*"）、
`query_safe.js:8/113`、`skills.js:1188`、`mca_import.js:73`（"与 chunk_map 的 scanChunk 同格式"）、
`tools/preflight.mjs:215`（"里面点名的 chunk_map.js / heatmap.js **早已删除**"）。
这些是**有意留下的历史坐标**，删了反而丢信息 → 不改。

**D. 用户/模型可见的文案仍写 heatmap（1 条，措辞级）**
`src/agent/commands/actions.js:278` 的 `!walkTo` 描述：`'Walk to (x, z) using the terrain heatmap planner: …'`。
heatmap 已不存在（现为 `terrain3d.js`），而这句会进模型的命令文档（`getCommandDocs`）。 → **F12**

---

## 3. 许可证 / 版权声明完整性（必答 3）

### 3.1 事实

```
$ ls -la mindcraft/LICENSE → 1094 字节，MIT 全文
$ head -3 mindcraft/LICENSE
MIT License

Copyright (c) 2024 Kolby Nottingham
```
`mindcraft/LICENSE:1-3` 与 `:4-21` 是**标准 MIT 全文**（含 "The above copyright notice and this permission
notice shall be included in all copies…" 那一段），版权行是原作者。

`mindcraft/README.md:155-164` 的「上游与许可」段落声称三件事，逐条核：

| README 声明 | 核实 |
|---|---|
| 「原作者：Kolby Nottingham」(`:159`) | ✅ 与 `LICENSE:3` 一致 |
| 「许可证：MIT —— 完整声明见 [LICENSE](LICENSE)，版权归原作者所有，**未做修改**」(`:160`) | ✅ LICENSE 与上游标准 MIT 一致，未见改动或追加 |
| 「按 MIT 许可证要求，本仓库保留原项目的版权声明与许可证文本」(`:163`) | ✅ 成立（LICENSE 在仓库根，`git ls-files` 可见） |
| 「**原项目 README**：[docs/readme-upstream.md](docs/readme-upstream.md)」(`:161`) | ❌ **死链**：该文件已迁到 `docs/legacy/readme-upstream.md`（`ls docs/readme-upstream.md` → No such file） |

### 3.2 结论

**许可证合规：通过。** MIT 的两项强制义务（保留版权声明、保留许可全文）都满足，且 LICENSE 就在 fork 根
（`mindcraft/` 是 git 仓库根，`git ls-files | grep LICENSE` 命中）。

**唯一瑕疵**是许可段落里的**上游 README 链接失效**（`README.md:161`）——它不影响合规性，但让"完整保留"这句话
在读者眼里打了折。 → **F11**

> 附带说明（不判缺陷）：MIT 不要求标注"哪些文件被修改"。本项目没有逐文件标注，属合规范围内的选择；
> 而 `docs/自研申报.md:1249` 主动称 `skills.js` 为"上游遗留文件"，实际比 MIT 要求更透明。

---

## 4. 两处 `bugs/` 的逐条现状（必答 4）

### 4.1 先说一个结构事实：**同一批 bug 有两个目录、两份拷贝**

```
$ ls bugs/                     → BUG-001/002/003   (Oct 24-25)
$ ls mindcraft/docs/bugs/      → BUG-001/002/003   (Oct 29)
```
逐份比对（`diff` 报 `1,141c1,141` 等全文件差异，但去掉 `\r` 后 md5 相同）：

| 文件 | 结论 |
|---|---|
| BUG-001 | **去掉 CR 后完全相同**（纯 CRLF/LF 差异） |
| BUG-002 | **同上** |
| BUG-003 | **同上** |

→ 不是"内容分叉"，是**同一份内容存了两处，一份 LF 一份 CRLF**。`docs/README.md:95-97` 索引的是
`mindcraft/docs/bugs/` 那三份，根目录 `bugs/` 无人引用。 → **F9**

### 4.2 逐条现状

| Bug | 文档状态 | 核实结果 | 判定 |
|---|---|---|---|
| **BUG-001** 外部瞬移导致客户端物理崩溃 | ✅ 已解决（升级 mineflayer 4.33→4.39，`BUG-001:3`） | `package.json:22` 确为 `"mineflayer": "4.39.0"` ✅ 版本这一半**可验**。但 `BUG-001:4` 列的 4 个证据脚本 `tools/_dbg_tp_dist.mjs`、`_dbg_noguard.mjs`、`_dbg_tp_physics.mjs`、`_dbg_forward.mjs` **全部不存在**，且被 `.gitignore:46 tools/_*.mjs` 永久排除 | **已修，但不可复现** → **F3** |
| **BUG-002** 判据基准错位 | ✅ 已修复（`BUG-002:3`），位置 `atom_drops.js` + `skill_collect.js`（`:4`） | 两个文件**都已删除**（`ls` → No such file）。修复逻辑**确实迁移了**：`flow_collect.js:185`「不传 baseCount：让 collectDrops 每次调用自己快照」、`flow_collect_plan.js:304-306`「只有调用方显式给了 baseCount 才传」→ 说明修复没丢。**但没有以 BUG-002 命名的回归测试** | **已修，但记录指向已删文件 + 无回归测试** → **F4** |
| **BUG-003** 远处区块不掉落 | ⚠️ 现象确认、根因未定（`BUG-003:3`），"待你实测确认"（`:4`） | 记录日期 **2026-10-25**，至今 **11 天**无更新；无对应测试；`git log` 无相关修复提交 | **未修，长期挂起** → **F14** |

### 4.3 BUG-002 是否复发（额外深挖）

`baseCount` 在现码里仍有 3 处出现：
```
atom_wait_item.js:59/61/63   ← 原子内部自己快照，正确
flow_collect.js:185          ← 明确"不传"，正确
flow_collect_plan.js:248     ← ctx 里仍可传 baseCount
flow_collect_plan.js:306     ← if (Number.isFinite(baseCount)) opts.baseCount = baseCount;  ← 仍可被注入
```
→ **原 bug 不会自动复发，但"重新引入它"的入口还开着**：任何调用方只要在 ctx 里给一个"任务开始时"的
`baseCount`，就复现 BUG-002 的完全体症状。这与审计①的 N16（"flow_collect_plan 把规划时的状态当执行时的状态"）
是同一族问题。不是新 bug，但**修复的不变式没有被测试钉住**。

---

## 5. 回归 runbook 的失效步骤（必答 5）

先说结论：**这是一份质量很高的 runbook**——明确标注「状态：只准备、未执行」（`:3`），
三条铁律都写明"是读脚本确认过的，不是推测"（`:6`），并且**自曝了子进程会 `claim()` 任意 ready 单**这个隐蔽风险
（`:8-10`、`:132-155`，还贴了源码片段）。§4 甚至做了"当前板上残留 18 张单、`j_20261105_0012` 会被抢走"的只读查证。

### 5.1 实测仍然可用的步骤（3 条）

| runbook 步骤 | 我照抄执行 | 结果 |
|---|---|---|
| `:33-39` 清板命令（`node -e` + `require('node:sqlite')`） | 逐字跑 | `require(node:sqlite) OK` ✅（在 `package.json type:module` 下 `node -e` 仍是 CJS，能 `require`） |
| `:20` 端口探测命令 | 逐字跑 | 输出 `up` ✅（25566 在听） |
| `:23` 板库路径 `bots/_board/board.sqlite` | `ls` | 存在，81920 字节 ✅ |

→ **§0 前提、§1 清板、§2 各命令路径（`tools/atom_all.mjs`、`bench_move_actions.mjs`、`board_b1/b2/b3/b4_live.mjs` 全部存在）都没失效。**

### 5.2 已失效的步骤（2 条）

| 失效项 | runbook 写的 | 实测 | 依据 |
|---|---|---|---|
| **§5 归档清单** `:170-178` | 「**`archive/` 有 6 个历史**」并列出 6 个文件名 | **38 个** | `ls -1 tmp/bench/archive/*.jsonl \| wc -l` → `38`。它列的 6 个确实是**最新的 6 个**（`ls -t \| head -6` 完全吻合），但把"最新 6 个"写成了"有 6 个" |
| **§② 规模描述** `:57`、`:63` | 标题「`atom_all`（原子层 **17 个用例**）」、正文「**7 个脚本串行**」 | **17 个脚本**（`ATOM_ORDER` 12 + `EXTRA_TESTS` 3 + `SKILL_TESTS` 2） | `tools/atom_all.mjs:50-53` 三个数组相加 = 17。「17」是**脚本数**不是用例数；「7 个脚本」则完全对不上 |

> 补充：`atom_all` 的脚本数从 18 变成 17，是因为 `tools/atom_all.mjs:46-47` 的注释——
> **t44 删掉了 `act_use.js` / `atom_use.mjs`（拆完没清理的空壳）**，并把 `'use'` 从 `ATOM_ORDER` 移除。
> 于是**所有写「atom_all 18/18」的文档全部过期**（见 F7）。

### 5.3 无法实测的部分（诚实标注）

runbook 的 4 个真机用例（`atom_all`、`bench_move_actions`、`board_b1~b4`）都要求
**独占 25566 + 0 个真人玩家**，且 b1/b2 要起独立 mindserver（18099/18098）并 SIGKILL 子进程。
本轮沙箱 **spawn 被 EPERM 拦**（见审计⑪ §1），`atom_all`/`board_b*_live` 内部都用 `execFileSync`/`spawn`
→ **本轮无法实测它们的通过与否**。缺的条件：宿主机权限 + 25566 空闲 + 无真人玩家。

---

## 6. FAQ 与实际行为不一致（必答 6）

`mindcraft/FAQ.md` 共 38 行、9 条。逐条核后 **2 条不一致**，其余（ECONNREFUSED、npm install、
`My brain disconnected`、卡住、纹理包、Baritone、Mod 支持）都与实际相符。

| FAQ 条目 | 它说 | 实际 | 判定 |
|---|---|---|---|
| **`:7`** | 「`ERR_MODULE_NOT_FOUND`：**你少装了一个 npm 包，跑 `npm install`**」 | 本仓库出现这个错的**真实原因不是缺包**：5 个 `tools/` 脚本 import 了**项目自己已删除的文件**（`chunk_map.js`/`tile_map.js`/`path_long.js`），`npm install` 一万次也不会好。实测见 §2.2 | **误导** → **F10** |
| **`:31`** | 「Possible reason 3: Not setting the code path correctly in **setting.js**, use **andy.js** by default」 | ① 文件名是 `settings.js`（不是 `setting.js`）；② **默认根本不是 andy.js**：`settings.js:18-20` 是 `"./profiles/my-local.json"`；③ `andy.json` 是死配置（审计⑥已验证：`grep -rn "andy.json" --include=*.js` 零命中，只在 `docs/legacy/readme-upstream.md` 的叙述里出现） | **两处都错** → **F10** |

> 另外 `:13-19` 说「Node v24+ 会导致 `gl` 编译报 C++20 错，请切到 v18/v20」——
> 这条**不算不一致**：`gl` 确实在 `package.json:44-47` 的 `overrides` 里（`"gl": "^8.1.6"`），是
> `node-canvas-webgl` 的传递依赖，原生编译失败是真事；本项目用"关掉 vision"（`settings.js:31/36` 把
> `render_bot_view`/`allow_vision` 设为 false）绕开，而不是切 Node。建议补一句但不算错。
> 同理 `:25`「We have improved upon it with patches」是**真的**：`patches/mineflayer-pathfinder+2.4.5.patch` 存在，
> 且 `package.json` 的 `postinstall` 跑 `patch-package`。

---

## 7. `docs/` 与 `docs/architecture/` 的关系（清单 D）

```
docs/
├── README.md            索引（123 行）
├── 交接文档.md           467 行  ← 自称快照，见 F1
├── 自研申报.md          2102 行  ← 申报台账
├── 回归-runbook.md       219 行  ← 新增，未入索引
├── 架构交接-总.md        401 行  ← 新增，未入索引（自称"现在的权威交接"）
├── 架构交接-夜间.md      175 行  ← 新增，未入索引
├── architecture/        14 份（00~09 规范 + 4 份设计稿）
├── legacy/              22 份（308 KB）
└── bugs/                 3 份
```

* **顶层 6 份 vs `architecture/` 14 份：无同名文件**（`for f in docs/*.md; do [ -f docs/architecture/$f ]` → 0 命中）
  → 二者是"索引/交接/台账"与"规范"的分工，**不是重复**。
* **`legacy/` 的链接全部有效**：把 `docs/**/*.md` 里 `legacy/xxx.md` 的引用逐个 `test -f`，9 个目标**全部 OK**
  （`验收记录/陪玩改造方案/经验教训/改进规划/技术总结/字段标准/原子接口标准/原子动作规格-v2/02_actions`）。
  说明"移到 legacy"这个动作做得很干净，**没有制造死链**。
* **真正的问题在索引维护**：三份新增的顶层文档（`回归-runbook` / `架构交接-总` / `架构交接-夜间`）
  在 `docs/README.md` 里出现 **0 次**。 → **F1 / F13**

---

## 8. 新发现清单

### Must fix

---

#### F1 「现况手册」指向一份自称过期的文档；权威交接文档不在索引里；而文档漂移检查盯着的正是那份过期文档

`mindcraft/docs/README.md:81`、`mindcraft/docs/交接文档.md:3-4`、`mindcraft/tools/preflight.mjs`（DOC 常量）

**这是什么**
`docs/README.md` §3「根目录里仍在用的两份」把 `交接文档.md` 描述为「**现况手册**；`tools/preflight.mjs`
会比对它与代码的提交时间，提示是否过时」。而 `交接文档.md` 自己的第 3-4 行写着：

> ⚠️ **本文是 2026-10-24 的快照，描述的是重构前的状态。**
> **现在的权威交接是 [`架构交接-总.md`](./架构交接-总.md)**（2026-11-03，覆盖 M0–M11 全部 12 个里程碑）。

preflight 的漂移检查里 `const DOC = 'docs/交接文档.md';` —— **盯的就是这份自称作废的快照**。

**问题（场景 → 结果）**
新接手的人按索引读"现况手册"，读到的是 10-24 重构前状态（它自己都说了）；真正描述现状的
`架构交接-总.md`（401 行）在索引里**一次都没出现**（`grep -c "架构交接-总" docs/README.md` → `0`）。
更糟的是：preflight 的时间戳漂移检查只保护这份过期文档，**`架构交接-总.md` 变旧了没有任何机制会发现**。

**最小修复**
1. `docs/README.md:81` 把「现况手册」改成指向 `架构交接-总.md`，`交接文档.md` 降为"历史快照"并与 legacy 并列；
2. 在 §3 表里补 `回归-runbook.md` 与 `架构交接-夜间.md` 两行；
3. `tools/preflight.mjs` 的 `DOC` 常量改成 `'docs/架构交接-总.md'`（或改成数组，两个都查）。

**不修会怎样**
索引与文档自我声明直接矛盾；漂移检查保护错了对象 → 最该保鲜的那份文档是唯一没有护栏的。

---

#### F2 裸常量棘轮基线 14 条里有 9 条指向已删除的文件 → 闸门实际被放宽 9 个名额

`mindcraft/src/agent/rules/audit_baseline.json`（`items`）、`mindcraft/tools/audit_rules.mjs:126-136`

**这是什么**
`audit_baseline.json` 是"裸常量棘轮"：它记下**已存在的**未申报常量，`audit_rules` 用
`if (violations.length > base.count)` 判"有没有新增"。`count` 是历史容忍上限。

**问题（场景 → 结果）**
实测：`count = 14`，`items = 14` 条，但**只有 5 条指向的文件还存在**，9 条指向已删文件：

```
$ node -e '…遍历 items，fs.existsSync(it.file)…'
count= 14  items= 14
指向存在文件: 5  指向已删文件: 9
{ "src/agent/library/atom_perceive.js": 2, "src/agent/library/atom_dig.js": 1,
  "src/agent/library/atom_move.js": 1, "src/agent/library/task_collect.js": 4,
  "src/agent/library/tile_map.js": 1 }
```
后果：真实存量只剩 **5** 处，但闸门仍按 **14** 放行 → **可以悄悄新增 9 处裸常量而不触发失败**。
`audit_rules.mjs` 从不校验 `it.file` 是否存在（`grep -n existsSync` 在该文件只用于 BASELINE 本身）。

**最小修复**
在 `audit_rules.mjs` 读基线后加 3 行：过滤掉 `!existsSync(it.file)` 的条目，并把 `base.count` 重算为
过滤后的长度（或直接在 `--print` 时重新生成基线）。改完 `count` 应从 14 降到 5。

**不修会怎样**
"只许变少不许新增"的棘轮机制实际失效 9 个名额——这是全仓唯一防止"凭印象写魔法数字"的自动闸门。

---

### Should fix

---

#### F3 BUG-001 的 4 个证据脚本全部缺失，且被 `.gitignore` 永久排除 → "已解决"不可复现

`bugs/BUG-001-tp物理崩溃.md:3-4`、`mindcraft/.gitignore:46`

**这是什么**
BUG-001 记「证据脚本：`tools/_dbg_tp_dist.mjs`、`_dbg_noguard.mjs`、`_dbg_tp_physics.mjs`」（`:4`），
另有正文引用 `tools/_dbg_forward.mjs`。

**问题（场景 → 结果）**
四个文件**全部不存在**（`ls tools/_dbg_tp_dist.mjs …` 全报 No such file；现存 `_dbg` 只有 `_dbg_scan.mjs`）。
原因：`.gitignore:46` 有 `tools/_*.mjs` —— 这类证据脚本**从设计上就进不了仓库**。
于是这条"✅ 已解决"只有一半可验：能验 `package.json:22` 的 `mineflayer: 4.39.0`（升级确实做了），
**不能验**"崩溃真的消失了"、也没法在复现时对照原始现象。

**最小修复**
二选一：① 把 BUG-001 需要的 3 个脚本**改名去掉 `_` 前缀**（如 `tools/diag_tp_physics.mjs`）纳入版本库，
并在 `.gitignore` 保留 `tools/_*.mjs` 不变；② 若确实不想留脚本，就把 `BUG-001:4` 那行改成
"证据脚本属本地临时件，未入库（`.gitignore:46`），复现方式见正文 §X"。

**不修会怎样**
11 天后想复查"这个 bug 真的好了吗"，唯一办法是重新发明当时的测量方法。

---

#### F4 BUG-002 标"已修复"但修复位置指向两个已删文件；修复的不变式没有测试钉住

`bugs/BUG-002-判据基准错位.md:3-4`、`mindcraft/src/agent/library/flow_collect_plan.js:304-306`

**这是什么**
`BUG-002:4` 写「位置：`src/agent/library/atom_drops.js` + `skill_collect.js`」。

**问题（场景 → 结果）**
两个文件**都已删除**（现为 `flow_pickup.js` / `flow_collect*.js`）。修复本身**还在**——
`flow_collect.js:185`「不传 baseCount：让 collectDrops 每次调用自己快照」、
`flow_collect_plan.js:304-306`「只有调用方显式给了 baseCount 才传」——但：
① 记录里没有任何一行说明"逻辑已迁到 X"；
② **没有以 BUG-002 为主题的回归测试**（`grep -rl "baseCount" tools/` 命中若干，但都测原子自己快照，不测"传入任务级 baseCount 会不会复发"）；
③ `flow_collect_plan.js:306` 仍然接受调用方传入 `baseCount` → **重新引入这个 bug 的入口是开着的**。

**最小修复**
① `BUG-002:4` 改成"原位置已随 Phase R 更名为 `flow_pickup.js` / `flow_collect*.js`；不变式：`collectDrops`
每次调用自己快照"；② 补一条用例：给 `flow_collect_plan` 的 ctx 传"任务开始时"的 `baseCount`，
断言它**不会**因此提前返回成功（即钉住"不传 baseCount"这条不变式）。

**不修会怎样**
一个曾经造成"拿到 4/8 就再也不动、且报数诚实所以查不出来"的隐蔽 bug（`BUG-002` §为什么难发现），
其防线只靠调用方自觉。

---

#### F5 5 个 `tools/` 脚本 import 已删除的模块，运行即崩，且不在任何 runner 里

`tools/test_split_plan.mjs:5`、`tools/measure_corridors.mjs:3-4`、`tools/probe_map_main.mjs:6`、`tools/test_tile_map.mjs`、`tools/test_chunk_map.mjs`

**这是什么** 详见 §2.2 表。它们 import 的 `path_long.js` / `chunk_map.js` / `tile_map.js` 已于 2026-10-29 架构翻新时删除。

**问题（场景 → 结果）**
`node tools/<任一个>` → `ERR_MODULE_NOT_FOUND`。这 5 个不在 `unit_all` / `atom_all` / `preflight` 的任何清单里
（`grep -l <name>` 三个 runner 均 0 命中），所以**没人跑、也就没人发现**。而 FAQ:7 恰好教人
"看到 `ERR_MODULE_NOT_FOUND` 就去 `npm install`" → 双重误导。

**最小修复** 删掉这 5 个文件（它们的被测对象已不存在，无迁移价值）；若想留考古，移进
`tools/archive/` 并在文件头加一行「依赖已删模块，不可运行」。

**不修会怎样** 仓库里长期躺着 5 个"看起来能跑"的测试，谁点到谁浪费半小时查 `npm install`。

---

#### F6 自研申报 61 条里 17 条的模块已不存在、编号重复 1 处、数据陈述 13 实为 18，且全文没有"历史台账"标注

`mindcraft/docs/自研申报.md:1-6`（文件头）、`:74`、`:1230` 与 `:1272`（编号 42 重复）

**这是什么** 详见 §1.3 表。

**问题（场景 → 结果）**
① 17 条申报的模块名已随 Phase R 改名/合并/删除而失效（`atom_attack.js`→`act_attack.js` 等）；
② `## 申报 42` 出现两次（`bot_paths.js` 与 `act_craft.js`）；
③ `:74` 说 `game_rules.json` 有「13 条」，实测 **18** 条；
④ 文件头只写"规矩/判定顺序/结论三态"，**没有一句**说明"这是逐日台账、模块名会失效、以 `src/` 为准"。
配合 `docs/README.md:82`「`tools/audit_rules.mjs` 靠它检查新模块有没有申报」，读者会当现行清单用。

**最小修复**
① 文件头加 2 行：**「本文是逐日申报台账（2026-10-24 起）。模块名以当日为准，Phase R 改名后未回填；
现行模块清单以 `src/` 为准。`audit_rules.mjs` 只按文件名匹配『已批准』记录来放行新增文件。」**
② `:74` 的 13 → 18；
③ 把第二个 `## 申报 42` 改成 `43`，其后编号顺延（或只把标题改成 `42-补`）——**注意**：
`audit_rules` 只做 `sections.find(s => s.includes(name))` 的**文件名子串匹配**，不解析编号，
所以改编号**不会**影响闸门，安全。

**不修会怎样** 唯一一份"哪些是自研、为什么自研"的正式台账，其中 28% 的条目指向不存在的文件；
审计者要花时间逐条反查（本轮就是）。

---

#### F7 全仓 5 处写「atom_all 18/18」（另有 1 处「18 个脚本」），实际已是 17 个脚本

`docs/README.md:120`、`docs/交接文档.md:53/65/69/96`、`docs/架构交接-夜间.md:16`、`mindcraft/docs/回归-runbook.md:57`

**这是什么** `atom_all` 的脚本体量。

**问题（场景 → 结果）**
`tools/atom_all.mjs:50-53`：`ATOM_ORDER`(12) + `SKILL_TESTS`(2) + `EXTRA_TESTS`(3) = **17 个脚本**。
而 `:46-47` 的注释写明"t44 去掉了 `'use'`（`act_use.js` / `tools/atom_use.mjs` 已删）"——**所以 18 是 t44 之前的历史值**。
实测出现位置（`grep -rn "18/18"` 命中 **5** 处；`交接文档.md:96` 另有「18 个脚本」1 处）：
`README.md:120`（写在"怎么跑测试"的代码注释里 `# 全套：18/18`，直接教错）、
`交接文档.md:53/65/69`、`架构交接-夜间.md:16`。
（额外：`回归-runbook.md:57` 标题写「17 个用例」、`:63` 正文写「7 个脚本串行」——**17 是脚本数不是用例数，"7 个"对不上任何口径**。）

**最小修复** 把 5 处 `18/18` 改为 `17/17`、`交接文档.md:96` 的「18 个脚本」改 17（或统一改成"17 个脚本，用例数以各脚本输出为准"）；
`回归-runbook.md:57` 改「17 个**脚本**」、`:63` 的「7 个脚本串行」改「17 个脚本串行」。

**不修会怎样** README 的"怎么跑测试"这段是新人第一个照抄的，抄完发现数字对不上，会怀疑自己环境坏了。

---

#### F8 回归 runbook §5 的归档清单少算了 32 个文件（说 6 个，实际 38 个）

`mindcraft/docs/回归-runbook.md:170-178`

**这是什么** runbook 用来防"新旧样本混进同一个基线文件"的归档台账。

**问题（场景 → 结果）**
`:170` 写「**`archive/` 有 6 个历史**」并列出 6 个文件名。实测 `ls -1 tmp/bench/archive/*.jsonl | wc -l` = **38**。
它列的 6 个确实是**最新的 6 个**（`ls -t | head -6` 逐个吻合），但把"最新 6 个"表述成"有 6 个"。
后果：按这份清单判断"没有同用途旧档挡路"是**不安全**的——实际还有 32 个更早的 move-actions 变体。

**最小修复** 把 `:170` 改成「`archive/` 当前有 38 个（`ls -1 tmp/bench/archive/*.jsonl | wc -l`），
下面是其中最新的 6 个」——**并且把"数数"本身写成命令而不是数字**（这个数字会一直变）。

**不修会怎样** runbook 的核心价值是"照着做不用现场摸索"，而这一条恰好需要现场重新数。

---

#### F9 同一批 3 份 bug 记录在两个目录各存一份（内容相同、仅行尾不同）

`bugs/BUG-00{1,2,3}-*.md` 与 `mindcraft/docs/bugs/BUG-00{1,2,3}-*.md`

**这是什么** 六份文件，实为三份内容 × 两个拷贝。

**问题（场景 → 结果）**
`diff` 报全文件差异，但 `tr -d '\r' | md5sum` 完全一致 → **纯 CRLF/LF 差异，内容零分叉**。
`docs/README.md:95-97` 只索引 `mindcraft/docs/bugs/` 那三份，根目录 `bugs/` 无人引用
（而根目录整个不在 git 里，见审计⑥ §0.1）。将来只改一处，就会真的分叉。

**最小修复** 删掉根目录 `bugs/`（3 份，20 KB），或反过来把 `mindcraft/docs/bugs/` 换成软链接——
但更简单的是**只留一份**：`mindcraft/docs/bugs/`（它在 git 里、被索引）。

**不修会怎样** 下次修 bug 只更新一处，另一处变成"看起来一样的错误版本"，而这正是本仓反复出现的病
（`docs/自研申报.md:1249` 讲的"两个地方都以为自己在管同一件事"）。

---

#### F10 FAQ 有 2 条会把人带偏

`mindcraft/FAQ.md:7`、`mindcraft/FAQ.md:31`

**这是什么** 上游 FAQ 直接继承下来的条目，未按本 fork 现状改写。

**问题（场景 → 结果）**
* `:7`「`ERR_MODULE_NOT_FOUND` = 少装 npm 包，跑 `npm install`」——本仓库该错误的**真实来源**是
  5 个脚本 import 了项目**自己删掉的**文件（§2.2 实测 5/5 都是 `ERR_MODULE_NOT_FOUND`）。照它做只会白等一次 `npm install`。
* `:31`「use **andy.js** by default」「`setting.js`」——① 文件名应为 `settings.js`；
  ② 默认 profile 是 `settings.js:18-20` 的 `./profiles/my-local.json`；③ `andy.json` 是死配置
  （`grep -rn "andy.json" --include=*.js` 零命中，审计⑥ 已证）。

**最小修复** `:7` 补一句「本仓库若在 `tools/` 下遇到此错，多为脚本引用了已更名的项目文件，
先看报错里的路径是否存在于 `src/`」；`:31` 改成「`settings.js` 的 `profiles` 字段（默认
`./profiles/my-local.json`）」。

**不修会怎样** FAQ 是"出问题第一个查的地方"，这两条会让人查错方向。

---

### Nice to have

---

#### F11 README 许可段落的「原项目 README」链接失效

`mindcraft/README.md:161`

**问题** `[docs/readme-upstream.md](docs/readme-upstream.md)` → 文件已迁到 `docs/legacy/readme-upstream.md`（实测 No such file）。
**最小修复** 改成 `docs/legacy/readme-upstream.md`。
**不修会怎样** 不影响 MIT 合规（LICENSE 本身完整），但"完整保留"这句话旁边挂着一个 404。

---

#### F12 `!walkTo` 的用户/模型可见描述仍写 "terrain heatmap planner"

`mindcraft/src/agent/commands/actions.js:278`

**问题** heatmap 已删（现为 `terrain3d.js`），但这句description 会进模型的命令文档（`getCommandDocs`）。
**最小修复** 改成 "terrain 3D planner"。
**不修会怎样** 模型被教去理解一个不存在的模块名；影响很小（描述性文字）。

---

#### F13 三份"交接"文档并存，索引缺两份

`mindcraft/docs/交接文档.md`(467 行, 自称快照) / `架构交接-总.md`(401 行, 自称权威) / `架构交接-夜间.md`(175 行)

**问题** 三份都以"交接"为主题、时间跨度 10-24 → 11-03，索引只收了最旧那份（见 F1）。
**最小修复** 索引里明确排序：`架构交接-总.md`（现况）→ `架构交接-夜间.md`（历史过程）→ `交接文档.md`（最早快照，归 legacy 语气）。
**不修会怎样** 与 F1 同源，修 F1 时一并解决即可。

---

#### F14 BUG-003 挂起 11 天，状态仍是"根因未定"

`bugs/BUG-003-远处区块不掉落.md:3-4`

**问题** 记录日 2026-10-25，至今无更新、无测试、无修复提交。它描述的"主服某些区域挖方块不掉落"若属实，
是**数据/产出丢失**类问题（比 BUG-001/002 更影响游戏体验）。
**最小修复** 要么按 `:4` 的"请你在游戏里验证的三件事"实测一次并记录结论；要么标成"已知限制"写进 README「已知限制」表
（那里已有"掉落物拾取为轮询实现"一条，位置合适）。
**不修会怎样** 一条可能的数据丢失线索永远停在"待确认"。

---

## 9. 未读 / 无法验证的部分（诚实清单）

| 项 | 状态 |
|---|---|
| `docs/自研申报.md` 2102 行 | **读了全文的骨架与全部结论行 + 完整精读**：`:1-100`、`:1988-2102`；其余 1900 行通过"68 个标题 + 61 条申报名 + 全部 `结论：` 行 + 全文 `skills.js`/`上游` 命中"覆盖，**未逐句读中间的候选表格** |
| `docs/legacy/` 22 份（308 KB） | **只验证了"被谁引用/是否死链/是否重复"**，未逐份读内容准确性（它们已被官方降级为"历史参考"，`docs/README.md:12-16`） |
| `架构交接-总.md`(401 行) / `架构交接-夜间.md`(175 行) | 读了标题与首段（用于判定 F1/F13），**未通读** |
| runbook 的 4 个真机用例 | **无法实测**：内部用 `execFileSync`/`spawn`，本沙箱 spawn 被 EPERM 拦（见审计⑪ §1）；且需独占 25566 + 0 玩家 |
| BUG-003 的现象 | **无法验证**：需要真机在主服特定区域挖方块观察掉落 |
| 许可证"逐文件标注修改" | MIT 不要求；本项目未做，**不判缺陷** |

**收尾核对**：
```
$ cd mindcraft && git status --porcelain
(空)
```
未改任何被审查源码与文档；本文件是唯一写入物。

---

*报告完。所有"文档说 X / 实际 Y"均附两侧证据（文档行号 + 代码行号或 grep 输出）；"<<移除的四套>>"附真实 grep 与实跑输出。*
