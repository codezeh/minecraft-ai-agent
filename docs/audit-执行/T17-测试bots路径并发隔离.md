# T17 tools/ 第二类并发病灶：固定 `bots/` 路径互删地标

> mindcraft：本轮改动（扫描器扩展 + `botsRootEnv` 覆盖点 + 9 个测试改进程隔离）
> 根仓库：本文件。
>
> **T15 的结论被证伪了一半。** T15 报的「两路 `unit_all` 并行 → 全绿」不是稳定结论：
> 它只是那一次没撞上 `atom_classify`。本轮实测三路并行 **6/6 轮必红**（见 §3.1），
> 而且在修的过程中又抓出**第三个入口**（`tools/.tmp_mut`），T15 的判据对它完全瞎（见 §4）。

---

## 1. 病灶（同一类，三个入口）

| # | 入口 | 典型 | 为什么 T15 抓不到 |
|---|---|---|---|
| 1 | 固定 `tmp/` | `const DIR = join('tmp','x')` + 开跑 `rmSync` | T15 修掉了 13 个 |
| 2 | 固定 `bots/` | `rmSync('bots/<name>')` + 地标写在 `bots/<name>/memory/*.json` | **判据只认 `tmp/`** |
| 3 | **点开头的临时目录** | `tools/.tmp_mut/` 变异副本 + 收尾 `rmSync(MUT_DIR)` | 不以 `tmp/` 开头、不在仓库根，**旧判据完全看不见**（本轮新增） |

共同机制：**两个进程共用一个目录，且其中一方会删它** → 「单跑全绿、并发随机红」。

---

## 2. 扫描器扩展（`tools/scan_tmp_isolation.mjs`）

判据从「固定 `tmp/` 路径 + 删除」扩成「**固定共享路径 + 删除/写入 + 无隔离**」：

- **共享目录**：`tmp/ bots/ logs/ data/ schemas/ schematics/ reports/` + **`.tmp*`（点开头临时目录）**
- **四种写法**：字面量前缀 `'bots/x'`、`join('bots', …)`、**目录名当参数** `resolve(process.cwd(),'bots',…)`、
  **嵌在路径中间的点开头目录** `'tools/.tmp_mut'`
- **动作**：删除（`rmSync/unlinkSync/rmdirSync/rm -rf`）、写入（`writeFileSync/appendFileSync/createWriteStream/copyFileSync`）
- **隔离标记**：`mkdtempSync` / `os.tmpdir()` / `process.pid` / `randomUUID` / **`MC_BOTS_ROOT`（环境变量覆盖）**

保留 T15 的好设计并加强：
- **注释感知**（先剥注释再匹配，带引号状态机）；
- **`--selftest` 只报真样本**，夹具现在是 10 行：行注释假样本 / 块注释假样本 / `tmp` 两种写法 /
  字符串里的 `//` / **`bots/` 模板字面量** / **`'tools/.tmp_mut'` 嵌套形态**，逐行断言"该报的必须报、不该报的必须不报"；
- 另加**只读/非风险登记**（`kind: read-only | string-message | arg-only`）+ **僵尸自检**，
  以及 `--check`（可挂 CI）、`--leftovers/--purge`。

```
$ node tools/scan_tmp_isolation.mjs --selftest
✓ 自检通过：注释样本被忽略 / 代码真样本全中 / 字符串里的 // 没误判 / bots 模板命中 / 只读登记双向正确

$ node tools/scan_tmp_isolation.mjs
合计：需处置 0 · 已隔离 25 · 只读 3 · 豁免 8
✓ --check 通过
```

**扫描器不是自证**：把 HEAD 版 `strat_alloc_unit.mjs` 放回 `tools/` 让扫描器看，它确实报：
```
✗ tools/_t17_head_strat.mjs   固定路径 → 65: 'tools/.tmp_mut | 81: '../tools/.tmp_mut/... 
                              删除动作 → 96(rmSync)      写入动作 → 80(writeFileSync)
```
即：**扩后的判据能抓到它原本漏掉的东西**（这才是"扩扫描器"该有的证明）。

---

## 3. 反证与并发证明

### 3.1 ★ 改动前：三路并行 `atom_classify_unit` **6/6 轮必红**

单跑是绿的（这与 captain 的观察一致）：
```
$ node tools/_t17_old_atom.mjs      # HEAD 版
6/6 个用例通过
```
三路并行 ×6 轮（每轮 3 个进程，同一 cwd）：

```
round 1: E1=0 E2=0 E3=1
round 2: E1=1 E2=1 E3=1
round 3: E1=0 E2=1 E3=1
round 4: E1=0 E2=1 E3=1
round 5: E1=1 E2=0 E3=1
round 6: E1=0 E2=0 E3=1
```

失败原文（4 种形态，全部来自实测日志）：
```
FAIL 地标缓存按 bot 隔离 写入=true/true A=[{"x":100,"y":64,"z":100}] B=[]        ← 串味（9 次）
FAIL 地标缓存按 bot 隔离 写入=true/true A=[] B=[]                                ← 两边都被删
FAIL 地标缓存按 bot 隔离 写入=true/false A=[] B=[]                               ← 写的时候就被删了
FAIL rememberChest 之后 protectedPlaces 非空且判得出保护 写入=true spots=[] protectedBy=null
```
**「写入=true/true 但读回 A=[] B=[]」正是 captain 要的那条** —— 写入确实发生了，
文件被另一个进程删掉了。

### 3.2 改动后：三路并行 ×5 轮全绿

```
round 1: E1=0 E2=0 E3=0  (6/6 / 6/6 / 6/6)
round 2: E1=0 E2=0 E3=0  (6/6 / 6/6 / 6/6)
round 3: E1=0 E2=0 E3=0  (6/6 / 6/6 / 6/6)
round 4: E1=0 E2=0 E3=0  (6/6 / 6/6 / 6/6)
round 5: E1=0 E2=0 E3=0  (6/6 / 6/6 / 6/6)
失败数：0
```

### 3.3 ★ 第三个入口：`strat_alloc_unit`（两路 `unit_all` 并行时被抓到）

第一版两路并行 ×3 轮里，round 1 出现 `❌ strat_alloc_unit (exit 1)`：
```
FAIL ⑦ 能生成并加载「去掉账本」的变异副本
     ENOENT: no such file or directory, lstat '...\mindcraft\tools\.tmp_mut\strat_obtain_mut.mjs'
```
根因：`MUT_DIR = 'tools/.tmp_mut'`（固定），第 96 行收尾 `rmSync(MUT_DIR)` ——
A 刚写完变异体，B 把它连目录删了，A 的 `import` 就 ENOENT。
**这正是"只修 captain 给的清单"会漏掉的那类**：它不在 captain 的 11 个候选里，T15 的扫描器也看不见（§2 已修判据）。

修法（最小、零风险）：`MUT_DIR = \`tools/.tmp_mut-${process.pid}\`` —— **只加 pid 后缀**。
为什么不搬到 `os.tmpdir()`：变异体的两处相对 import 是按 `tools/.tmp_mut/` 的位置改写的
（`../../src/...`），挪走就断；**同深度只换名字**完全不碰那些改写。

修后三路并行 ×5 轮：`E1=E2=E3=0`，全 15/15，且 `tools/.tmp_mut*` 无残留。

### 3.4 验收要求的两路 `unit_all` 并行 ×3 轮

```
PARALLEL round 1: run1=0  run2=0      run1: 93/93 通过 4 跳过   run2: 93/93 通过 4 跳过
PARALLEL round 2: run1=0  run2=0      run1: 93/93 通过 4 跳过   run2: 93/93 通过 4 跳过
PARALLEL round 3: run1=0  run2=0      run1: 93/93 通过 4 跳过   run2: 93/93 通过 4 跳过
```
**6 次运行全绿、零 ❌。**

### 3.5 单路不回归

```
$ node tools/unit_all.mjs
EXIT=0
  93/93 个脚本通过，4 个跳过
```
合同里写的是「92/93 + 4 跳过」，我跑到的是 **93/93 + 4**：差额 = 期间并行任务新增的一个脚本
（T90 封版记录也是 93/93 + 4，与本次一致）。

---

## 4. 改了什么（逐条）

### 4.1 `src/` —— 一个**覆盖点**，不是改目录结构

| 文件 | 改动 |
|---|---|
| `library/bot_paths.js` | **新增 `botsRootOf()`**：`MC_BOTS_ROOT` 有值就用它，否则 `'./bots'`（**默认行为逐字节不变**）；`mapDirOf`/`botDirOf`/`boardDirOf` 全部改走它 |
| `library/memory_store.js` | `memoryDir()` / 旧 landmarks 迁移路径改走 `botsRootOf()`（顺带消掉"第二处自己算 bots 根"） |
| `history.js` | `memory.json` / `histories/` 三处改走 `botsRootOf()` |

实测默认不受影响、覆盖生效：
```
默认 root: ./bots        | botDir: ./bots/a | mapDir: ./bots/a/map | board: ./bots/_board
覆盖 root: C:/tmp/iso…/test | botDir: C:/tmp/iso…/test/a | board: C:/tmp/iso…/test/_board
```
**没有硬改 `bots/` 目录结构**（生产路径一字未变）。

### 4.2 `tools/` —— 9 个测试改进程隔离

| 文件 | 处置 |
|---|---|
| `atom_classify_unit.mjs` | **已隔离**（`MC_BOTS_ROOT=mkdtemp`；`cleanup()` 不再 rmSync 共享 `bots/<name>`）★主目标 |
| `memory_store_corrupt_unit.mjs` | **已隔离**（同上；T30 我自己写的，同类病灶） |
| `verify_memory_version.mjs` | **已隔离**（`MC_BOTS_ROOT`，走 `History` 同一个根） |
| `strat_alloc_unit.mjs` | **已隔离**（`tools/.tmp_mut-${pid}`，§3.3）★本轮新发现 |
| `test_chunk_map.mjs` | **已隔离**（`DIR` 由 `MC_BOTS_ROOT` 推出） |
| `test_map_main.mjs` | 同上 |
| `test_mca_import.mjs` | 同上 |
| `test_tile_map.mjs` | 同上 |
| `probe_map_main.mjs` | 同上 |
| `tools/_dbg_scan.mjs` | **已删除**（T15 列的豁免：未跟踪、直连真服务器的临时调试脚本） |

★ 上面 5 个 map 测试（`test_chunk_map`/`test_map_main`/`test_mca_import`/`test_tile_map`/`probe_map_main`）
**依赖早已删除的 `chunk_map.js`，现在根本跑不起来**（`ERR_MODULE_NOT_FOUND`），
所以**无法用"运行"来验证**。改动只有"DIR 由固定字面量改成从 `MC_BOTS_ROOT` 推出"一行，
不碰断言与逻辑 —— 目的是**把地雷拆掉**，等谁重写它们时不会再中同一个坑。

### 4.3 豁免与"非风险用途"（逐条给理由，且都自检僵尸）

豁免 8 条：4 个 bench（人工触发的基准，`unit_all` 不跑）、`restart_bot`（运维）、
`t51_triple_round` / `t51_firstnight_realagent`（真机演练）、**`preflight.mjs`**（见 §5）。

非风险 3 条：`test_nav_opt` / `test_path3d`（真机地形库**只读**输入，缺就 SKIP）＋
**`prompter_path_unit`（★ 假阳性）**：它在**断言消息字符串**里引用 `` `./bots/${name}` ``
来说明"prompter.js 里不该有裸拼"，本身一个字都不写；那个字符串里还含 `writeFileSync` 字样，
所以同时被"写入动作"命中 —— 正是 T05 记过的同族坑：**"文本里提到路径" ≠ "代码里用了路径"**。

---

## 5. 一处需要纠正 captain 的判断：`preflight.mjs` 不是"只读"

任务书里写「`preflight.mjs` 是误报，它只读」。实测**不成立**：

```
$ grep -n "bots" tools/preflight.mjs
534:const API_SCAN_SKIP_DIRS = new Set([... 'bots' ...]);        ← 这一处确实是"跳过不扫"（只读）
1273:try { rmSync(join(ROOT, '../../bots/preflight_tmp'), ...) } ← **这一处真的在删 bots/ 下的目录**
```
所以它是"**固定 bots 路径 + 删除**"。我**没有改它**（任务书明确要求不碰、gate 正在改），
而是列进豁免并写明真实原因：① 它是**串行门禁**（一次一个提交），不是被 `unit_all` 并发调度的测试；
② 那行删的是**它自己上一次留下的** `bots/preflight_tmp`。

★ **残留风险（交给 gate 的负责人决定）**：两次提交恰好同时跑 preflight 时，
后一个的 `rmSync(bots/preflight_tmp)` 可能删掉前一个正在用的目录。
一行 `preflight_tmp-${process.pid}` 就能消掉 —— 但那要动 preflight，本轮不碰。

---

## 6. lint / 硬指标

```
$ npx --no-install eslint src main.js | grep -c no-undef          → 0
$ npx --no-install eslint src main.js | grep -c no-floating-promise → 0
$ npx --no-install eslint src main.js | grep "problems"            → ✖ 197 problems   ← 与 T90 封版数字完全一致
$ node tools/lint_ratchet.mjs                                      → ✓ 274 ≤ 278（扫 237 文件）
```
- **硬门 197 / no-undef 0 / no-floating 0 三项与 T90 封版完全一致** —— 我对 `src/` 的改动**没有引入任何新问题**。
- 棘轮 274 ≤ 278（比基线还低 4，不是我抬的）。**没跑 `--update`**。
- 我改/加的文件里只剩 3 条，全部用 `git show HEAD:` 取原版 eslint 对照证明**既有**：
  `verify_memory_version.mjs` 1 条（HEAD 第 11 行同一条）、`history.js` 2 条（HEAD 也是 2 条）。

---

## 7. 验收对照表

| 验收项 | 结果 |
|---|---|
| 扩展扫描器判据（tmp/bots/logs/data/… + 点开头临时目录）；保留注释感知 + `--selftest` | ✅ §2；`--selftest` 通过，且用 HEAD 版 strat_alloc 反证"扩后能抓到原来漏的" |
| 处置候选（先扫再改，不照抄清单） | ✅ 我扫出 **12 个需处置**（含 captain 没列的 `strat_alloc_unit`、`t51_firstnight_realagent`、`bench_s2_main`、`preflight`）；逐一处置，见 §4 |
| 反证：改动前三路并行 → 至少两路红，贴出 `A=[] B=[]` 原文 | ✅ §3.1：6/6 轮必红，含 `写入=true/true A=[] B=[]` |
| 改动后：三路并行 ×5 轮全绿 | ✅ §3.2：5/5 轮，三路各 6/6 |
| 两路 `unit_all` 并行 ×3 轮全绿 | ✅ §3.4：6 次运行 93/93，零 ❌ |
| 单路 `unit_all` 不回归 | ✅ §3.5：93/93 + 4 跳过（合同写 92/93，现 93/93，差额=并行任务新增脚本） |
| `lint:ratchet` ≤ 278、不许抬 | ✅ 274 ≤ 278 |
| `eslint src main.js` 保持 no-undef=0 / no-floating=0 | ✅ 且总数 197 与 T90 封版一致 |
| 只 add 自己的文件；不 `-A` / 不 `checkout .` / 不 `stash` | ✅ 见提交 |
| 删掉 `_dbg_scan.mjs` | ✅ 已删 |
| 别改断言逻辑，只改进程隔离 | ✅ 全程只改路径构造/根目录；断言一字未动 |

---

## 8. 边界与未做

1. **5 个 map 测试无法运行验证**（依赖已删的 `chunk_map.js`），改动仅"DIR 来源"，见 §4.2。
2. **`preflight.mjs` 未改**（任务书要求 + gate 在动），但它的真实风险已如实写进 §5 交给人决定。
3. **`coder.js` 里还有 `'/bots/'+agent.name+'/action-code/'` 这种绝对拼接** —— 它不在本轮任何测试路径上
   （没有测试构造 Coder 写盘），且它前面带 `/` 是另一个问题；**记账未动**，避免借"并发加固"扩范围。
4. **实弹多 bot 现场没有**：本轮的证明全部是"真进程 + 真文件 + 真并发"的离线实验（三路/两路并行），
   不是真机多 bot —— 但对"互删文件"这个机制，离线并发已经等价（就是同一台机器上的两个进程）。

---

# T19 收尾：豁免表逐条审计（过期豁免 = 假证据）

> 背景：T17 的 `EXEMPTIONS` 里那条 `tools/preflight.mjs` 写着"它收尾会 `rmSync(bots/preflight_tmp)`"、
> 并留着"交给 gate 决定是否加 pid 后缀"。而 **T18（`e540515`）已经把 preflight 改成
> `mkdtempSync` + `MC_BOTS_ROOT` 独占** —— 那句话指向一段**已不存在的代码**。
>
> 这正是本轮反复踩的同一个母题：**引用了作废对象的检查，看起来和有效检查一模一样**
> （S33 的冒烟测试指向已删的 `tile_map.js`、第 27 条那份"自称已过期"的交接文档、现在这条豁免）。
> 一条过期豁免会让下一个人**以为那里还有风险**，或者**以为已经有人处理过**。

## T19.1 不是靠眼睛，靠工具（新增 `--audit-exemptions`）

给扫描器加了三样东西，让"豁免是否过期"变成**可机械复现**的判断：

1. **`classify(rel, src)` 抽出来**，`main()` 与审查用**同一套**判据 ——
   否则"审查豁免"用的就是另一套规则，那审查本身不可信。
2. **必要性判定**：把这条豁免**摘掉**再判一次，看它会落在哪：
   - 仍落"需处置" → 豁免**仍必要**
   - 落"已隔离/非风险" → 豁免**冗余**（应删）
   - **完全没有命中** → **僵尸豁免**（理由在描述一个不存在的东西）
3. **理由里"代码引用"的失效检测**：把 `why` 里反引号包起来的片段抽出来，
   去该文件的**代码**（`stripComments` 之后）里找。
   ★ 关键细节：被删的代码**经常还留在注释里** —— 所以必须剥注释再比，否则这个检查会假绿。
   ★ 反过来也不能太死：带占位符的描述（`<日期>`、`…`）是**人话**不是逐字引用，
   一律跳过；比对时还统一了引号（`"tmp"` 与 `'tmp'` 不该算失效）。
   （第一版两条都踩了：既误伤我自己的文案，又把 `rmSync(join(...))` 这种省略了后面参数的引用判失效。）

## T19.2 逐条核对结果（8 条 → 删 2 条，留 6 条）

| # | 条目 | 摘掉豁免会落在 | 判定 | 处置 |
|---|---|---|---|---|
| 1 | `bench_move_actions.mjs` | 需处置 | 仍必要 | **保留**；理由改成逐字引用（`join('tmp', 'bench-actions-map')`、`tmp/bench/*.jsonl`） |
| 2 | `bench_deepwater.mjs` | 需处置 | 仍必要 | **保留**；原文写 `tmp/bench-*`，实际是 `tmp/bench/deepwater-<日期>.jsonl` → 已订正 |
| 3 | `bench_move_baseline.mjs` | 需处置 | 仍必要 | **保留**；原文只有"同上：人工触发的基准脚本" —— **太含糊**，已写清产物：`tmp/bench/<日期>-move.jsonl` + `join('tmp','bench-move-map','terrain')` |
| 4 | **`bench_s2_main.mjs`** | 需处置 | 仍必要 | **保留**；★ 原文说"仓库内 `tmp/`"，**实际是项目根**（`join(toolsDir,'..','..','tmp','bench')`，在 mindcraft 仓**之外**）→ 已订正 |
| 5 | **`restart_bot.mjs`** | 已隔离（`process.pid`） | 工具会判"冗余"，**但那是假绿** | **保留 + `keepReason`**（见下） |
| 6 | **`preflight.mjs`** | 已隔离（`mkdtempSync+os.tmpdir+env-root`） | **冗余** | **删除**（T18 起它真的隔离了）；且理由引用的 `rmSync(join(ROOT, "../../bots/preflight_tmp"))` 已被机械检测标出"代码里已不存在" |
| 7 | **`t51_firstnight_realagent.mjs`** | **没有命中** | **僵尸** | **删除**（见下） |
| 8 | `t51_triple_round.mjs` | 需处置 | 仍必要 | **保留**；理由补上产物 `tmp/t51-craft-chain.jsonl` / `tmp/t51-craft-fail-full.jsonl` / `tmp/t51-triple.json` |

### 第 5 条的坑：`process.pid` 不等于"已隔离"
`restart_bot.mjs` 里有 `process.pid`，工具因此判它"已隔离"。**但那个 `process.pid`
出现在一段 PowerShell 进程过滤脚本里**（`Where-Object { $_ -ne $PID -and $_ -ne ${process.pid} }`，
用于排除自己），跟目录/文件隔离毫无关系；它真实的固定路径只有 `tmp/bot_run.log`（单个日志文件）。
→ 所以**保留豁免**，并新增 `keepReason` 字段把这件事写在条目里，
`--audit-exemptions` 会显示成「保留（工具判为安全，但那个标记不是目录隔离）」而不是"冗余"。
**这是"别用无关标记换来的假绿"的落地**：我没有删掉它去让报告好看，也没有假装工具是对的。

### 第 7 条的坑：它当初是被**假阳性**扫进来的
`t51_firstnight_realagent.mjs` 命中的是 `agentProc.stdout.on('data', …)` 里的 **`'data'`** ——
我加的 `dir-as-arg` 判据（`[(,]\s*'<dir>'\s*,`）把**事件名**当成了目录。
→ T19 顺手修掉这个假阳性（排除 `.on/.once/.off/.emit/.addListener/.removeListener` 后面的那种形态），
于是该文件**不再有任何固定共享目录**，豁免成了僵尸 → **删除**。
它确实会写一个固定的 `tmp-t59-agent.log`，但那是**单个文件**、不是目录（见 T19.5 边界）。

★ 修假阳性本身的附带效果（也说明假阳性的代价）：`已隔离 25 → 18`（**7 个文件原来只是被
`on('data')` 这类噪声带进了报告**），同时 `t51_firstnight` 由"豁免"变成"僵尸"（`豁免 8 → 7`）。
再删掉 preflight 与 t51_firstnight 两条之后，最终是 **`已隔离 19 · 豁免 6`**。

## T19.3 现状（可复现）

```
$ node tools/scan_tmp_isolation.mjs --audit-exemptions
· tools/bench_move_actions.mjs      判定：仍必要（仍会被判为需处置）
· tools/bench_deepwater.mjs         判定：仍必要
· tools/bench_move_baseline.mjs     判定：仍必要
· tools/bench_s2_main.mjs           判定：仍必要
· tools/restart_bot.mjs             判定：保留（工具判为安全，但那个标记不是目录隔离 —— 见 keepReason）
· tools/t51_triple_round.mjs        判定：仍必要
逐条核对 NON_RISK_USES
· tools/test_nav_opt.mjs        ← bots/deepseek/map       [read-only]
· tools/test_path3d.mjs         ← bots/deepseek/map       [read-only]
· tools/prompter_path_unit.mjs  ← bots/${name}            [string-message]
· tools/prompter_path_unit.mjs  ← ('logs'                 [arg-only]
✓ 所有豁免/非风险登记都与当前代码相符            （exit 0）
```

`NON_RISK_USES` 的 4 条也一并核过（同一母题：登记也会过期）——
全部仍然**能命中**对应片段，且 `test_nav_opt` / `test_path3d` 的"真机地形库只读"至今成立。

**preflight 现在落在「已隔离」**（不再是豁免）：
```
$ node tools/scan_tmp_isolation.mjs | grep preflight
  · tools/preflight.mjs  (mkdtempSync+os.tmpdir+env-root+env-root(其他))

合计：需处置 0 · 已隔离 19 · 只读 3 · 豁免 6
✓ --check 通过
```

## T19.4 验收

| 验收项 | 结果 |
|---|---|
| `--check` 需处置 0，且 preflight 在「已隔离」 | ✅ 需处置 0；preflight → `已隔离(mkdtempSync+os.tmpdir+env-root)` |
| `--selftest` 仍全过（注释感知 + 只报真样本不能被破坏） | ✅ 通过，且**加了两条新断言**：① 事件名 `on('data',…)` 不许被当目录；② 理由里的代码引用检查（占位符跳过 + **正对照** `resolve(cwd,'bots',…)` 必须被认出 —— 否则"排除事件名"可能把功能整体关掉而自检照样绿） |
| `unit_all` 93/93 + 4 跳过不回归 | ✅ EXIT=0，93/93 通过 4 跳过 |
| `lint:tools` ≤ 278（当前 273，别抬基线） | ✅ **273 ≤ 278**（未跑 `--update`） |
| 文档列出每条豁免的现状 | ✅ 本节 T19.2 / T19.3 |

## T19.5 边界（本轮明确不覆盖的）

1. **固定"单个文件"不在判据内**：本扫描器的判据是**共享目录**。
   `restart_bot.mjs` 的 `tmp/bot_run.log`、`t51_firstnight_realagent.mjs` 的 `tmp-t59-agent.log`
   都是**cwd 下的单个固定文件**，并发跑会互相覆盖 —— 但它们都是**人工脚本、不在 `unit_all`**，
   而且把"单文件"也纳入判据会让大量正常测试（写自己的 report/result 文件）被误报。
   → 判据保持"目录"，这两处写在文档里而不是塞进扫描器（**不静默**）。
2. **`--purge` 仍不区分"正在被并发跑的测试所用"的目录**（T17 已有的提示保留在输出里）。
3. **没有改 `preflight.mjs`、没有改 `src/`**（任务约束）。
