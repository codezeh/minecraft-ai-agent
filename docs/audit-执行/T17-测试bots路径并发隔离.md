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
