# 审计④ · 测试与质量门禁

审计对象：`mindcraft/tools/` 下的测试脚本（62 个 `*_unit*.mjs` + 44 个 `test_*.mjs`）、`tools/unit_all.mjs` 总入口、`tools/preflight.mjs`（1076 行）门禁、`eslint.config.js`、`web/` 的 typecheck。
**未修改任何源码与测试文件**，唯一写入是本报告。所有数字均为本机实际运行所得，命令与原始输出摘在下面。

---

## 一、现状（真实数字）

### 1.1 仓库里没有 CI

```
$ ls -a .github        → 不存在
$ cd ../.github        → 不存在
```
`package.json` 的 scripts 全表：
```json
{ "postinstall": "patch-package", "start": "node main.js",
  "test": "node tools/unit_all.mjs", "reinstall": "...", "clean:modules": "..." }
```
**没有 `lint` 脚本**，`devDependencies` 只有 `patch-package` 一项。
结论：**eslint / preflight / 单测三者没有任何一个被"自动"执行**。全部依赖人手动敲。这是本报告最重要的现状——下面所有"门禁"都只是"存在的门"，不是"关着的门"。

### 1.2 测试脚本清点

| 项 | 数量 | 依据 |
|---|---|---|
| `*_unit*.mjs` | 62 | `ls tools/*_unit*.mjs \| wc -l` |
| `test_*.mjs` | 44 | `ls tools/test_*.mjs \| wc -l` |
| `unit_all.mjs` 的 UNITS 清单 | 65 条 | 脚本内匹配 `'...'` 得 65 |
| 其中默认执行 / 跳过 | 64 / 1 | 跳过项 `verify_y_semantics`（`unit_all.mjs:99-101` NEEDS_REAL_DATA） |
| **未注册进任何总入口的 `test_*.mjs`** | **42 / 44** | 仅 `test_escape`、`test_tunnel` 在 UNITS 里 |
| 这 42 个里：需要服务端 / 纯离线 | 29 / 13 | 按是否 `mineflayer\|createBot\|25566` 分类 |

**关键事实**：`atom_all.mjs`（要服务端的那套）也不包含这 29 个 `test_*.mjs`（`grep test_move/test_wiring/... atom_all.mjs` 全部 MISSING）。
所以 **42 个测试脚本只能靠人记得手敲**，其中 13 个根本不需要服务端（本该进 `unit_all`）：
`test_climb`、`test_codes`、`test_collect_targets`、`test_context_trim`、`test_goto_wiring`、`test_mca_import`、`test_memory_cap`、`test_nav_opt`、`test_path3d`、`test_reconnect`、`test_s0_afk`、`test_terrain3d`、`test_tile_map`。

### 1.3 `node tools/unit_all.mjs` 在本次审计环境下的结果（**必须说明的限制**）

```
$ node tools/unit_all.mjs
  ❌ atom_classify_unit  (exit error)
  ... （64 个全部 exit error）
  0/64 个脚本通过，1 个跳过
```

这个 0/64 **不是测试失败**，是本审计环境的沙箱禁止子进程创建：

```
$ node -e "require('child_process').execFileSync(process.execPath,['tools/terrain3d_unit.mjs'])"
ERR code= EPERM status= null msg= spawnSync D:\Node\node.exe EPERM
```

`unit_all.mjs:125` 用 `execFileSync` 派生每个测试子进程 → EPERM → 全部记为失败。**直接单跑同一个文件是通过的**：
```
$ node tools/terrain3d_unit.mjs
PASS dbFor 复用连接 same instance
... 4/4 个用例通过
```
所以「README 声称 8 套 156 项全部离线运行」这条我**无法用 `unit_all.mjs` 验证**。我改用"逐个直接执行 65 个脚本"的办法取得真实数据（§1.4）。

顺带一个真实缺陷（与沙箱无关）：`unit_all.mjs:152` 写的是 `e.status ?? 'error'`，spawn 失败时 `status` 是 `null`，于是**把 EPERM 丢掉了**，报告里只剩 "exit error"，64 个全红却看不出根因。这是门禁的诊断能力问题，见 T14。

### 1.4 逐个执行的真实结果（绕过 `unit_all` 的 spawn）

命令：`for f in tools/*_unit*.mjs tools/test_escape.mjs tools/test_tunnel.mjs tools/verify_y_semantics.mjs; do node "$f"; done`
（统计每个文件输出的 `^PASS` 行数）

- **56 个脚本正常跑完**，合计 **≈742 条 PASS**。
- **9 个脚本因 EPERM 无法运行**（需写临时目录，沙箱拒绝）：`board_store_unit`、`board_iface_unit`、`board_b3_unit`、`board_b4_unit`、`board_orphan_parent_unit`、`board_store_converge_unit`、`board_store_finish_unit`、`path3d_tunnel_unit`、`strat_alloc_unit`。证据：
  ```
  $ node tools/board_store_unit.mjs
  code: 'EPERM', path: '\\\\?\\E:\\...\\mindcraft\\tmp\\board-test', syscall: 'rm'
  $ node tools/path3d_tunnel_unit.mjs
  code: 'EPERM', syscall: 'mkdir', path: 'C:\\Users\\...\\Temp\\tunnel-1793867100164'
  ```
  → **整个任务板测试套件（8 个文件）在本环境一条用例都没跑到**。这不是仓库 bug（换成可写目录就正常），但说明这批测试**对环境可写性有硬依赖且写在模块顶层**（`board_store_unit.mjs:25` 顶层直接 `rmSync`，无 try/catch），任何受限环境都表现为全红且无诊断。
- **2 个脚本真的 FAIL**（非环境原因）：
  - `atom_classify_unit` → `FAIL 地标缓存按 bot 隔离 A=[] B=[]`。根因是本环境 `writeStore` 写不进（`EPERM`），不是断言错。
  - `strat_alloc_unit` → `FAIL ⑦ 能生成并加载「去掉账本」的变异副本 EPERM: ... mkdir 'tools\.tmp_mut'`。同环境原因。
  - 我逐条核实了两个 FAIL 的根因都在"写盘被拒"，**没有发现仓库自身的断言失败**（详见 §6 未验证部分）。

### 1.5 README 与现实的偏差

`README.md:34` 写「8 套共 156 项，全部离线运行」，`README.md:114-124` 给了表格：
`test_codes(5) / test_tunnel(36) / test_climb(21) / test_nav_opt(18) / test_path3d(16) / test_terrain3d(28) / test_escape(23) / test_scaffold_inventory(9)`。

实际核对（`for f in ...; do ls tools/$f.mjs; done`）：
- 8 个文件都还在，但**只有 2 个（test_tunnel、test_escape）在 `unit_all` 里**，其余 6 个是 §1.2 的孤儿。
- README **完全没提 `unit_all.mjs` 这个真正的总入口**，而它是 `npm test` 唯一入口。
- README 说 `preflight.mjs`「启动自检（5 项审计）」，实际输出是 7 段 `[1/4]…[7/7]`。
- 我实测 `test_escape` 24 条、`test_tunnel` 37 条，与 README 的 23/36 已不一致。

### 1.6 preflight（真实运行）

```
$ node tools/preflight.mjs ; echo EXIT=$?
[1/4] 模块加载：✓ 所有模块导入成功（122/122）
       ~ atom_move.makeMovements: 非致命（Cannot read properties of undefined (reading 'id')）
       ~ history.load+save: 非致命（EPERM: ... mkdir ...）
       ~ tile_map.classifyChunk: 非致命（Cannot find module '...tile_map'）
[3/4] ✓ 规则审计通过（18 条表自洽）· 裸常量 12 处（基线 14）· ✓ 错误码审计通过（38 个已注册）
[4/4] API 扫描：扫 336 个文件，5 条规则，✓ 全部 0 处
[5/5] 前缀 import：扫 122 个文件 / 387 条 import，违规 0
[6/6] ✗ 扫描器自测**没跑起来** → **审计结果不可信**
[7/7] 源文件 162 / 注册表技能 18 / 测试脚本 64（+1 跳过）/ 错误码 38
启动自检失败：1 处有问题。不要 exit 0 → EXIT=1
```
- 退出码**正确为 1**（唯一失败项是 §6）。
- §6 失败同样是本环境 EPERM（`preflight.mjs:882` `spawnSync` 跑 `deps_injection_audit.mjs --selftest`，`status=null`）。**这一段的降级设计是正确的**：它没有因为"跑不起来"给绿灯，而是明确判失败并写"审计结果不可信"。这是全仓最好的一处门禁设计。
- 值得注意的第三条 `~`: **`tile_map` 模块已经不存在了**（`Cannot find module ...tile_map`），说明还有代码在引用一个被删除的文件（`path_3d.js:4` 的注释说它"取代 tile_map"）。preflight 把它标成"非致命"，所以一直没人清。

### 1.7 eslint（真实运行）

eslint v9.39.4 已装在 `node_modules`（**但 `package.json` 没声明**，是传递依赖；配置里 import 的 `globals` / `@eslint/js` / `eslint-plugin-no-floating-promise` 同样未声明）。

```
$ npx --no-install eslint src/
✖ 319 problems (319 errors, 0 warnings)
```
按规则分解（`-f json` 统计）：

| 条数 | 规则 |
|---|---|
| 107 | `semi` |
| 78 | `require-await` |
| 57 | `no-undef` |
| **39** | **`no-floating-promise/no-floating-promise`** |
| 20 | `(parse)` ← **整文件解析失败** |
| 8 | `no-empty` / 4 `no-irregular-whitespace` / 其余各 1~2 |

`no-floating-promise` 命中分布（真·浮空 promise，规则配置成 `error`）：
```
23  src/agent/modes.js
 9  src/agent/speak.js
 3  src/agent/conversation.js
 2  src/agent/library/skills.js
 1  src/agent/mindserver_proxy.js
 1  src/process/init_agent.js
```
**这 39 条今天真实存在于生产代码里**，因为没有任何流程会跑 eslint（§1.1）。

### 1.8 web typecheck（真实运行）

```
$ cd web && npm run typecheck   # vue-tsc --noEmit
TYPECHECK_EXIT=0        （无任何输出 = 0 错误）
```
通过。但 `web/tsconfig.json` 里 `"strict": false, "noImplicitAny": false, "skipLibCheck": true`，且 `include` 只覆盖 18 个 ts/vue 文件。这是一个**几乎不会报错的 typecheck**：它只能抓语法错和明显的类型不匹配，抓不到 null/undefined 这类（见 T11）。

---

## 二、发现清单

## Must fix

### T1 `skills.digTunnel` 每次正常返回都抛 `ReferenceError: ok is not defined`
`skills.js:5750`

**这是什么**：`digTunnel` 是模型可直接调用的技能（在 `skills.js` 的 98 个导出里，经 `index.js:36-40` 全部进技能目录）。它末尾写 `return ok({ steps: n, to });`。

**问题**：`skills.js` 从头到尾**没有 import 过 `ok`**（第 1~28 行 import 清单里没有任何 `contract.js`），模块作用域里也没有 `ok` 定义（`grep -n "\bok\b"` 只找到 8 处**函数内部**的 `const ok = ...`）。所以只要执行越过 `skills.js:5742` 的 `if (!run.ok) return run;`，就一定在 5750 行抛 `ReferenceError`。
触发场景：模型调 `skills.digTunnel(bot, dx, dz, 3)` → 内部 `runSteps` 跑完（`run.ok === true`）→ 5749 发 `tunnel-done` 事件 → 5750 抛异常。**挖了最多 60 秒（默认 `deadlineMs=60000`）之后以异常收场**，模型拿到的是工具异常而不是 ActionResult。

**最小修复**：在 `skills.js` 顶部加一行 `import { ok } from './contract.js';`（其余函数用的是裸对象字面量，不受影响）。若不想引入依赖，则把 5750 行改成 `return { ok: true, data: { steps: n, to } };`。

**不修会怎样**：这个技能现在**100% 抛错**，且错误信息（`ok is not defined`）与挖掘逻辑毫无关系，排查会被引向错误方向。注意这条本来就是 eslint `no-undef` 能抓的——它列在 `eslint.config.js:22`，只是没人跑。

---

### T2 三道门禁（eslint / preflight / 单测）没有任何一个被自动执行；而 eslint 一跑就是 319 条
题述位置：`.github/`（不存在）、`package.json`（无 `lint`）、`eslint.config.js:28`

**这是什么**：`eslint.config.js` 把 `no-floating-promise` 和 `no-undef` 都配成 `error`，`tools/preflight.mjs` 是 1076 行的自检，`npm test` 指向 `unit_all.mjs`。三道门看起来齐全。

**问题**：没有任何自动触发点——没有 CI、没有 git hook、`package.json` 没有 `lint` 脚本、eslint 甚至不在 `devDependencies` 里。于是：
- 39 条 `no-floating-promise`（含 `modes.js` 23 条——那是驱动目标的控制层）真实存在于生产代码；
- 6 处 `no-undef` 是**真的未定义变量**（不是 `process` 这类误报）：`skills.js:5750 ok`（T1）、`modes.js:118/126 placed`、`modes.js:133 walked`、`item_goal.js:163/164 res`。`modes.js:118` 的上下文是"身上着火 → 用水桶灭火"，`if (placed)` 里 `placed` 从未声明（应是 `const success = ...` 的 `success`），所以**灭火分支一定抛 ReferenceError**；`item_goal.js:163` 的 `res = await ...` 在 ESM 严格模式下同样是 ReferenceError（该文件是 `hunt` 任务分支）。

**最小修复**：`package.json` 加 `"lint": "eslint src/ tools/"`，并把 `"test": "node tools/preflight.mjs && node tools/unit_all.mjs"`。要真正拦住回归，需要任意一个触发点（最简单的 CI 一行 workflow，或 `git config core.hooksPath` + `pre-commit`）。先别追求 319 清零：把 `no-undef` 和 `no-floating-promise` 两条设为**必须零**（其余 `semi`/`require-await` 降为 warn），因为这两条抓的是真 bug。

**不修会怎样**：门一直开着。本报告查到的 7 处 ReferenceError 级缺陷全部可被现成规则抓到，却全部活着——这说明"有配置"和"有约束"是两件事。

---

### T3 eslint 配置让 20 个源文件完全无法被检查，且 86% 的 `no-undef` 是噪音
`eslint.config.js:17`（`globals: globals.browser`）、`eslint.config.js:18`（`ecmaVersion: 2021`）

**这是什么**：`languageOptions` 声明了浏览器全局变量和环境级别 2021 的语法。

**问题**：两个独立错误叠在一起。
1. **`ecmaVersion: 2021` 太旧**：`src/models/*.js` 用了 class static field（`deepseek.js:6` `static prefix = 'deepseek';`，ES2022 特性）→ **20 个文件全部报 `Parsing error: Unexpected token =`**，直接被跳过，一行都 lint 不到。这 20 个文件是全部 LLM 供应商适配器（openai/gemini/claude/…），正是最该检查的地方。
2. **`globals: globals.browser` 用错了环境**：这是 Node 项目，`process`/`Buffer`/`setImmediate`/`global` 都不是浏览器全局。于是 57 条 `no-undef` 里 **49 条是误报**（35 个 `process` + 12 个 `Buffer` + `setImmediate` + `global`），真正有价值的 6 条（T2）被埋在这堆噪音里，谁看一眼都会选择"这条规则不靠谱"。

**最小修复**：`ecmaVersion: 2021` → `"latest"`（或 2022）；`globals.browser` → `{...globals.node}`（本仓库 `tools/` 也用 Node 全局）。改这两行，319 条会显著变化，剩下的才是真信号。

**不修会怎样**：lint 输出永远是一堆 "process is not defined" 的假警报，团队必然学会忽略它——规则存在反而比不存在更糟，因为它制造"我们已经检查过了"的错觉，而 20 个模型适配器根本没被看过。

---

### T4 65% 的测试脚本不在门禁里：42 个 `test_*.mjs` 未注册，其中 13 个纯离线
`unit_all.mjs:24-90`（UNITS 清单）、`unit_all.mjs:107`

**这是什么**：`unit_all.mjs` 用一份手写白名单 `UNITS` 决定跑什么（`:24-90`）。注释也写了"新增离线测试后记得加进来"（`:23`）。

**问题**：`tools/` 现有 44 个 `test_*.mjs`，**只有 2 个**（`test_escape`、`test_tunnel`）在名单里；`atom_all.mjs` 也一个都没有（实测 6 个抽样全 MISSING）。剩下 42 个彻底孤儿。按是否连服务端分类：
- **13 个纯离线、本该进 `unit_all`**：`test_climb`、`test_codes`、`test_collect_targets`、`test_context_trim`、`test_goto_wiring`、`test_mca_import`、`test_memory_cap`、`test_nav_opt`、`test_path3d`、`test_reconnect`、`test_s0_afk`、`test_terrain3d`、`test_tile_map`。
- 29 个需要服务端，只能手敲（这一条至少是可解释的）。

实测这 13 个里有 **4 个已经坏了**（我逐个跑过）：`test_codes` 4 PASS/1 FAIL、`test_climb` 4 PASS 后崩、`test_path3d` 11 PASS 后崩、`test_terrain3d` 0 PASS 崩（后两个是本环境 EPERM 写临时目录；`test_codes` 的 FAIL 见 T8）。`test_scaffold_inventory` 9/9 通过但也没注册。**"没注册 → 没人跑 → 烂掉 → 更没人注册"已经在发生**。

**最小修复**：把上述 13 个离线脚本加进 `unit_all.mjs:24-90` 的 `UNITS`；跑不过的先修或明确删（不要留着红的孤儿）。29 个服务端脚本在 `atom_all.mjs` 里列一份清单并注明"需服 25566"，让"哪些测试存在"这件事可查。

**不修会怎样**：README 承诺的 8 套 156 项里有 6 套已经不在任何总入口内（§1.5）。测试的**存在**和测试的**运行**彻底脱钩：越老的覆盖越先腐烂，而覆盖的恰恰是 `terrain3d`/`path3d`/`climb` 这些 t1 里问题最集中的地方。

---

### T5 唯一的"地标保护"测试用夹具伪造了生产不会产生的数据形状，于是它通过而生产是坏的
`atom_classify_unit.mjs:68-69`

**这是什么**：`atom_classify_unit` 是唯一碰 `protectedPlaces` 的测试（`grep protectedPlaces tools/*_unit*.mjs` 只命中它）。第 4 组用例要验"地标缓存按 bot 隔离"。

**问题**：夹具这样写：
```js
writeStore(BOT_A, 'chests', [{ pos: { x: 100, y: 64, z: 100 }, note: 'A 的箱子' }]);   // :68
writeStore(BOT_B, 'chests', [{ pos: { x: -100, y: 64, z: -100 }, note: 'B 的箱子' }]); // :69
```
它写的条目**带嵌套 `pos` 字段**——正好是 `landmarks.protectedPlaces` 读取的字段（`landmarks.js:78` `if (c?.pos) spots.push(c.pos)`）。但**生产代码的写入方从来不写 `pos`**：`rememberChest` 存的是 `{ ...n, note, lastUsed }`（`landmarks.js:131`，`n = {x,y,z}` 扁平坐标），`rememberSite`（`:203`）、`rememberStorageArea`（`:185`）同理。
后果：测试用手写夹具绕过了"真实写入方"，于是它验的是**读端自己的形状假设**，而不是"写→读"这条真链路。生产上 `spots` 恒为空、`isProtected` 恒返回 `protectedBy: null`（审计① N4：砍树不保护玩家箱子），**这个测试却一直是绿的**。
（本次运行为什么它还是 FAIL：`writeStore` 在本沙箱返回 `false`（EPERM，实测 `writeStore returned: false` / `readStore: []`），所以 A=[] B=[]。换成可写目录它会通过——这恰好证明了问题：**它通过时，生产是坏的**。）

**最小修复**：`atom_classify_unit.mjs:68-69` 的夹具改成调用真实的写入函数：
```js
rememberChest(BOT_A, { x: 100, y: 64, z: 100 }, 'A 的箱子');
rememberChest(BOT_B, { x: -100, y: 64, z: -100 }, 'B 的箱子');
```
并新增一条断言：`rememberChest` 之后 `protectedPlaces(bot)` 必须**非空**（现在这条断言无论好坏都会失败，正好暴露 N4）。

**不修会怎样**：这是最危险的一类"假测试"——它不是空的，它会断言、会打印证据、会红绿变化，但它验的是夹具自己的形状。它给了"地标保护有测试"的错觉，而真实的保护链是断的（玩家资产仍会被挖）。

---

## Should fix

### T6 已知 bug 被固化成永久 XFAIL，其中一条正好是审计② 的 Must fix
`scaffold_tracker_unit.mjs:63/126/154`、`board_store_converge_unit.mjs:218`、`board_scheduler_unit.mjs:1085`、`craft_diagnostic_reachability_unit.mjs:192-193`

**这是什么**：项目用"带指纹的 XFAIL"记录已知缺陷：行为符合 bug 指纹 → 打 `XFAIL(已知bug)` 且**不判红、退出码 0**。

**问题**：设计意图是好的（`flow_mine_orenames_unit.mjs:52-53` 甚至写明了"修好后必须转硬断言，否则回归会重新变回 XFAIL 而照样全绿"）。但当前有 4 处长期挂着：
1. `scaffold_tracker_unit.mjs:63/126/154` ×3 条：`XFAIL(已知bug) ... scaffold_cleanup.js:69 传裸坐标被 catch 吞掉（已报 captain）` → 该文件 `rc=0`、`3 PASS`，**3 个已知 bug 全部绿灯**。这与审计① 里"裸坐标传给原子层被吞"是同一类根因。
2. `board_store_converge_unit.mjs:218`：`XFAIL(已知缺口) ②-6 前置 blocked 时后继被卡住却无任何留痕（result/interrupted/pausedReason 全空）` → **这就是审计② 的 B3（依赖已死的单永久 ready / 静默阻塞）**。测试早就发现了它，用 XFAIL 记了账，然后它就永久绿着。
3. `board_scheduler_unit.mjs:1085`：`XFAIL(已知bug) ⑧ 假件忠实度：nearShelter 在真 mineflayer 形态下恒为 null` —— 这是**测试自己承认假件不忠实**（见 T7）。
4. `craft_diagnostic_reachability_unit.mjs:192-193`：`flow_craft:141-150 第一道前置检查`。

**最小修复**：给 XFAIL 加**到期机制**——每条形如 `XFAIL(known, issue:'B3', expires:'2026-12-01')`，过期即判红。否则"记账"就等于"注销"。至少把 `board_store_converge ②-6` 与审计② B3 合并成一张待修单（测试与审计已经指向同一个 bug，不该分两处维护）。

**不修会怎样**：XFAIL 是"我们知道了"的记录，不是"我们不做"的许可。挂满一年的 XFAIL 与没有测试等价，甚至更差——它让人以为这块有守卫。

### T7 测试反复选择"测闸/测假件"而不是"测接线"，而 bug 恰好都在接线上
`nav_lock_unit.mjs:3`、`nav_lock_unit.mjs:14/19/39`；`board_scheduler_unit.mjs:1085`

**这是什么**：`nav_lock_unit` 是全仓唯一覆盖导航互斥闸的测试，4 条用例。

**问题**：它直接调 `acquireNav('JOB_A')` / `acquireNav('JOB_B')` / `acquireNav('JOB_SAME')`——**全部用显式、互不相同的 owner 字符串**。而生产代码的 owner 来自 `nav_core.js:189` `owner = bot?.__navJobId ?? 'adhoc'`：所有没有任务单的调用共用同一个字符串 `'adhoc'`，于是命中 `nav_core.js:128` 的"同 owner 可重入"分支，**两条流同时通过**（审计① N2）。
`grep -rl "adhoc" tools/*_unit*.mjs` → **零命中**。也就是说：测试证明了"不同 owner 会串行"这条纯逻辑，而真实调用方永远产生同一个 owner——**缺陷正好落在被测属性用不上的地方**。测试文件自己在 `:3` 写了取舍理由：「因为 `goTo` 要真 bot 才能跑通 pathfinder，太重」。
同样形态见 `board_scheduler_unit.mjs:1085`：XFAIL 明说"假件在真 mineflayer 形态下恒为 null"——即被 stubbed 掉的那个行为，正是它要验的那个。

**最小修复**：`nav_lock_unit.mjs` 新增一条**接线级**用例（不需要真 bot，只需假 bot 对象）：构造两个 `bot`（`__navJobId` 均为 `undefined`），依次 `acquireNav(String(bot.__navJobId ?? 'adhoc'))`，断言第二个**必须拿不到**（现在它会拿到 → 用例红 → 修 N2）。用例名建议：`④ 两个无任务单的调用必须互斥（默认 owner 不能相同）`。

**不修会怎样**：测试覆盖的是"我以为的调用方式"，而线上跑的是"真实的调用方式"。这类缺口不会红，只会让"这块有测试"成为错觉。

### T8 `test_codes` 用源码正则统计"用到的错误码"，已误报且已腐烂
`test_codes.mjs:43-53`

**这是什么**：错误码完整性测试，6 条用例，验证"代码里用到的 CODE 都注册在 `contract.CODES` 里"。

**问题**：它的做法是 `readFileSync` 每个源文件再 `matchAll(re)` 扫字面量（`:43-45`），然后与 `CODES` 比。实测输出：
```
扫到 35 个错误码，CODES 注册 38 个
  未注册: DIED        src\agent\library\control.js
FAIL  所有用到的错误码都已注册在 CODES 里  DIED
```
但 `DIED` **不是** ActionResult 的 code，它只出现在**数据载荷**里：`control.js:188` `code: 'DIED'`（一个返回对象字段）、`control.js:192/443` `result: { code: 'DIED', at: now }`（写进任务板的 result JSON）。`grep "fail('DIED'" src/` → 零命中。而 `contract.fail()` 只在**直接调用**时才校验 code（`contract.js:104-105` 会 throw）。所以这是一条**误报**：正则分不清"传给 `fail()` 的 code"和"写进数据里的 code"。
同时：它已红且在 42 个孤儿里（§1.2），所以没人看到它红。

**最小修复**：把扫描正则收窄到只匹配 `fail(` 的实参位置（如 `/fail\(\s*['"]([A-Z_]+)['"]/g` 加 `asBool`/`isResult` 相关），或干脆删除这条用例——preflight 的"错误码审计"（`preflight.mjs` §[3/4]「错误码审计通过（38 个已注册，全部合法）」）已经在做**注册表自身**的校验，两者职责重叠且这条更弱。

**不修会怎样**：一条永远红、永远没人看的测试。它同时污染"测试全绿"这个信号，让人误以为错误码这块没保障（其实 preflight 那条是有效的）。

### T9 preflight 的 API 规则是"源码正则 + 白名单"，不是可执行断言，有多种正常重构即可绕过
`preflight.mjs:278`（`API_SCAN_ENFORCE`）、`preflight.mjs:305-311`（`control-state-owner` 规则）、`preflight.mjs:331`（`mouse-input-owner` 规则）

**这是什么**：`[4/4] API 扫描` 用"扫源码文本、正则命中即失败"来保证"控制键只从 `atom_input_move` 出去""鼠标输入只从 `atom_input_mouse` 出去"。规则形如 `pattern: /\bsetControlState\s*\(/`，`mouse-input-owner` 更具体：`/\b(?:bot|agent|agent\.bot|this\.bot|this\.agent\.bot)\.(dig|placeBlock|...)\s*\(/`。

**问题**：这是**文本匹配**，不是行为断言。下面几种正常重构会让规则静默失效（都是我会写的代码）：
1. **解构**：`const { setControlState } = bot; setControlState('forward', true);` → 没有 `bot.` 前缀，`mouse-input-owner` 与 `control-state-owner`（后者是 `\bsetControlState\s*\(`，这条其实会命中）中的前者直接漏掉。
2. **变量改名**：`const b = bot; b.dig(block);` → 前缀白名单只有 `bot|agent|agent.bot|this.bot|this.agent.bot`，`b.dig(` 不命中。
3. **可选链/换行**：`bot?.dig?.(x)` 或 `bot.\n  dig(x)` → `.` 与名字之间的 `?.`/换行都不匹配 `\.(dig|...)`。
4. **间接调用**：`const f = bot.dig.bind(bot); f(block);` → 只匹配调用点形状，不追绑定。
另外：`API_SCAN_ENFORCE = !process.argv.includes('--report-api')`（`:278`）意味着**任何人在任何时候加一个 `--report-api` 就把这道门降级成"只报告"**，而 preflight 其余部分照常绿灯。`allow` 白名单里也已经躺着 `src/agent/modes.js`（`mouse-input-owner` 与 `control-state-owner` 双份豁免），即这个文件本来就不受这两条规则约束。
顺带可核对强度：`[5/5]` 前缀 import 规矩也是正则解析 import 行（`preflight.mjs:614-679` `importedLocalPaths` / `namedImportSymbols`），同样是文本层，但比 §4 强一点——它比对的是解析出的模块路径与符号名，且扫了 387 条 import。

**最小修复**：把两条最关键的规则从"调用点正则"改成"**行为级断言**"——用 `tools/fixtures/fake_bot.mjs` 造一个假 bot，记录所有 `setControlState/dig/placeBlock` 的调用，然后 `import` 目标模块跑一遍、断言"这些调用只可能来自 L1 原子"。这需要把 §4 从"扫源"改成"跑代码"，成本较高；**折中方案**：给 `--report-api` 加"必须显式写明原因（如 `--report-api=大改分支名`）"，并在 preflight 输出里把"本次是只报告模式"打成显眼一行，避免它悄悄降级。

**不修会怎样**：这条门"看起来守着 5 条硬规矩，实际只守得住最朴素的写法"。项目历史上 `setControlState` 就是从各处收敛过来的（`preflight.mjs` 的 allow 注释里记着 skills.js 曾有 14 处鼠标输入 + 6 处 `bot.lookAt`）——收敛一次的成果，会在下一次重构（解构、改名）时静默流失。

### T10 preflight 不运行测试，只在统计段打印"测试脚本 64"且明确不参与判定
`preflight.mjs:1076` 前 §[7/7]（代码规模段）注释「统计信息，不参与失败判定」

**这是什么**：preflight 被称为"启动自检（须先通过）"（README:110）。

**问题**：7 段里没有任何一段执行单元测试。它打出 `测试脚本 64（+1 跳过）← tools/unit_all.mjs 的 UNITS 清单`——这是**读清单数个数**，不是跑。于是"preflight 通过"完全不能说明测试是绿的：今天 preflight 的实际状态是 §6 红（环境所致）、其余全绿，而与此同时 `atom_classify_unit` 与 `strat_alloc_unit` 是红的、42 个脚本没跑过。
更具体：`test_codes` 明明红着（T8），preflight 却打印"错误码审计通过"——两件事结论相反，因为 preflight 只检查注册表自身的合法性，不检查"用到的码是否都注册了"（那正是 `test_codes` 的职责，而它是孤儿）。

**最小修复**：`package.json` 的 `test` 串起来（见 T2），并在 README:110 把"须先通过"改成实际顺序：`preflight → unit_all`。不要在 preflight 里跑单测（会让它变慢、职责变杂），但要把它输出的"测试脚本 64"标注成"**清单条目数，非执行结果**"。

**不修会怎样**：`preflight 通过` 会被读成"仓库健康"，而它其实只覆盖了静态规矩；真实运行期行为（含 T1 那个必崩的 `digTunnel`）不在它的视野里。

### T11 web typecheck 通过但门禁极弱（strict 全关）
`web/tsconfig.json:5-7`（`"strict": false, "noImplicitAny": false, "skipLibCheck": true`）

**这是什么**：`npm run typecheck` = `vue-tsc --noEmit`，实测 `EXIT=0` 无输出。

**问题**：`strict: false` + `noImplicitAny: false` + `skipLibCheck: true` 三条一起关掉后，typecheck 只能抓"语法错"和"签名完全不匹配"。`null`/`undefined` 混用、隐式 any、未定义的属性访问（面板与后端 socket 字段对不上这类最常见的问题）全部放行。面板是 18 个 ts/vue 文件、直接消费 `board:*` 事件 payload（审计② 提到 payload 形状问题是重点），恰恰是 `strictNullChecks` 最能发挥的场景。

**最小修复**：`"noImplicitAny": true` 先打开（改动量小、收益直接）；`strict` 可以分文件渐进（`// @ts-strict-ignore` 不行就先在 tsconfig 里按目录 include 两次）。

**不修会怎样**：typecheck 存在、永远绿、抓不到面板↔后端字段错配。和 T3 的 eslint 同一个病：**绿灯不代表检查过，只代表检查不严**。

### T12 README 的测试章节已过期，且把 `preflight` 和测试的先后关系写错
`README.md:34`、`README.md:110`、`README.md:114-124`

**这是什么**：对外声明的质量承诺。

**问题**：三处偏差已在 §1.5 量化：①「8 套共 156 项」的表格是**旧世界**，其中 6 套已不在任何总入口；②真正的入口 `unit_all.mjs` 完全没提；③`preflight.mjs` 写"5 项审计"实际 7 段。外部读者（或新接手的人）按 README 敲 `node tools/test_tunnel.mjs` 会以为这就是测试全貌，实际上漏掉 63 个脚本。

**最小修复**：`README.md:107-125` 整段重写为：`npm test`（= `preflight && unit_all`，64 个脚本）、`node tools/atom_all.mjs`（需服务端 25566，N 个）、以及"42 个历史 `test_*.mjs` 中 13 个离线、29 个需服务端"的一句话说明。数字直接从 `preflight.mjs` §[7/7] 抄（它自己就提示"引用时以本段输出为准，别抄文档里的快照"）。

**不修会怎样**：文档承诺与门禁现实持续分叉，而"156 项全部离线运行"这种具体数字会让人误判覆盖度。

## Nice to have

### T13 测试脚手架在 40 个文件里各写一遍（同一族断言写 N 遍）
`unit_all.mjs` 无共享 harness；样例：`atom_classify_unit.mjs:19-21`、`board_store_converge_unit.mjs:227`、`craft_diagnostic_reachability_unit.mjs:192`

**这是什么**：每个测试自己定义 `let pass = 0, fail = 0`、`okCase/badCase`、`PASS/FAIL` 打印、退出码。

**问题**：统计（`grep -l`）：**40 个文件**含 `let pass = 0, fail = 0`，**28 个文件**含 `const okCase`。每份约 6~10 行重复（计数器 + 两个打印函数 + 末尾 `process.exit`）。这不只是行数——各文件的 `XFAIL/XPASS` 判定逻辑是**各自手写的**（`craft_diagnostic_reachability_unit.mjs:16` 有完整四态，`scaffold_tracker_unit.mjs` 只有两句 `if`），所以"XFAIL 到期该判红"这种语义无法统一实现（T6 的根因之一）。
`tools/fixtures/fake_bot.mjs`（426 行，25 个文件 import）证明**共享夹具这条路已经走通了**，只是 harness 没跟着收。

**最小修复**：新增 `tools/fixtures/harness.mjs`（约 40 行）：导出 `ok(name, evidence)` / `fail(name, actual)` / `xfail(name, fingerprint, issue, expiresAt)` / `summary()`，末尾统一 `process.exit`。然后按文件逐个替换——机械改动。预计**减少约 250~350 行**（40 文件 × 6~8 行），并让 XFAIL 的到期语义只剩一份实现。

**不修会怎样**：不影响正确性，但每次加测试都要复制一遍判定逻辑；XFAIL 语义继续分裂，"到期转红"这件事永远做不成。

### T14 `unit_all` 在子进程起不来时丢掉错误原因，只报 "exit error"
`unit_all.mjs:152`（`results.push({ name, ok: false, code: e.status ?? 'error' })`）

**这是什么**：总入口的失败归因。

**问题**：`execFileSync` 因 spawn 失败抛错时 `e.status` 是 `null`，`?? 'error'` 于是把所有 EPERM/E2BIG/ENOENT 压成同一个字符串。实测 64 个脚本全红、报告里只有 `(exit error)`，真实原因（EPERM：禁止派生进程）一个字都没露。这与 preflight §6 的做法（明确打印 `status=` 与输出片段，`preflight.mjs:894`）形成对比——同一仓库里两种诊断标准。

**最小修复**：`code: e.status ?? (e.code || 'error')`，并在 catch 里把 `String(e.message).slice(0,120)` 打出来。

**不修会怎样**：换台机器/换环境跑测试失败时，无法区分"测试坏了"和"环境不让跑"——这次审计差点据此误判 64 个测试全挂。

---

## 三、覆盖缺口表（审计①/② 的 Must/Should ↔ 有无测试 ↔ 该补的那一条）

判定依据：`grep -rl "<关键词>" tools/*_unit*.mjs tools/test_*.mjs`

| 风险点 | 现有测试 | 缺口 | 建议补的用例（文件 + 名字） |
|---|---|---|---|
| ①N1 `surveyArea` 默认 r=64 同步扫 110 万格 | **无**（`grep surveyArea` 0 命中） | 没有任何性能/规模守卫 | `tools/scan_scale_unit.mjs`（新）：`① scanSphere 的 blockAt 调用次数 ≤ 上限（用计数假 bot 数 r=24/32/64 的调用次数）` |
| ①N2 互斥闸 owner 缺省都是 `'adhoc'` | `nav_lock_unit`（只测显式 owner） | `grep adhoc` 0 命中；真实 owner 来源无测试 | `tools/nav_lock_unit.mjs` 新增 `④ 两个无任务单的调用必须互斥（默认 owner 不能相同）` |
| ①N3 12 处直驱 pathfinder 绕过闸 | **无** | 没有任何"只许从 goTo 出去"的检查 | `tools/nav_gate_unit.mjs`（新）：`① 源码里除 nav_core 外无 walkTo/moveTo/pathfinder.goto 直调`（可做成 preflight 第 5 条 API 规则）+ 现有 `flow_collect_plan` 的手工接线用例 |
| ①N4 地标保护清单恒为空 | `atom_classify_unit`（夹具形状错，见 T5） | 真实写入方从未被测试 | `tools/atom_classify_unit.mjs` 新增 `⑤ rememberChest 后 protectedPlaces 非空`（修 T5 夹具） |
| ①N5 `scanSphere` 先删列后读，读不到就丢数据 | 仅 `test_terrain3d`（孤儿） | 未注册且在跑不到的环境 | `tools/terrain3d_unit.mjs` 新增 `⑤ 某列 blockAt 返回 null 时，该列原有 surf 行必须保留` |
| ①N6 `step_runner` 全失败仍返回 ok | **无**（`grep step_runner` 0 命中） | 完全无测试 | `tools/step_runner_unit.mjs`（新）：`① 所有步骤失败（无 onFail 表）时 runSteps 必须返回 ok:false` / `② skills.digTunnel 一格没挖必须报失败而非 ok` |
| ②B1 `finish()` 不校验租约归属 | `board_store_finish_unit`（本环境跑不起来） | 用例名只覆盖"活子单/全终结/已达标"，未见租约归属 | `tools/board_store_finish_unit.mjs` 新增 `④ 租约过期的旧持有者 finish 必须失败（不能把单写回 ready）` |
| ②B2 玩家 `!stop` 对任务板任务无效 | `control_reasons_unit`（38 PASS） | 覆盖"停的原因→单去哪"，不覆盖"命令到调度器" | `tools/board_stop_unit.mjs`（新）：`① !stop 后调度器当前单必须进 paused 且发中断` |
| ②B3 依赖已死的单永久 ready / 静默阻塞 | `board_store_converge_unit` **XFAIL ②-6**（永久绿） | 已发现、已被 xfail 掉 | 把 XFAIL 转硬断言（T6），用例名沿用 `②-6 前置 blocked 时后继必须留痕` |
| ②B4 父单永久 running（kids=0 跳过） | `board_orphan_parent_unit`（本环境跑不起来） | 与 B4 的 `kids.length===0` 分支对应关系未验证 | 确认该文件有一条 `父单无子单时也必须被收敛`；没有则补 |
| ②B6 `listJobs` LIMIT 200 饥饿 | `reopen_orphan_blocked_unit`（含"LIMIT 饥饿证伪"） | 有覆盖 | 无需新增 |
| ⑥ eslint `no-floating-promise` 39 条 | **无** | lint 未接入（T2） | 不是测试用例问题，见 T2 |
| T1 `digTunnel` `ok` 未定义 | **无** | `no-undef` 能抓但没跑 | 同上 + `step_runner_unit` 里顺带覆盖 |

**一句话结论**：审计①/② 的 12 条 Must fix 里，**只有 2 条（②B6、部分 ②B4）有像样的测试**；4 条完全没有测试，2 条有测试但测错了东西（①N2、①N4），1 条被 XFAIL 掉了（②B3）。

---

## 四、"空测试 / 假测试"清单

按题述四型逐条核：

**(a) 断言恒真 / 只断言不抛错** —— 未发现。抽查的 8 个文件（`board_scheduler_unit`、`control_reasons_unit`、`permissions_unit`、`find_stand_unit`、`fall_risk_unit`、`exec_step_y_unit`、`strat_alloc_unit`、`atom_input_unit`）的断言都带具体数值/字符串证据（如 `asked=5`、`protectedBy=landmark`、`inside=保护 outside=不保护`），且普遍有"反向验证"（`find_stand_unit` 30 条含反例、`flow_build_support_unit` 注释写明"含防循环论证反例"）。这一项是全仓做得最好的。

**(b) 已过期仍是 XFAIL** —— 4 处，见 T6。其中 `board_scheduler_unit.mjs:1085` 的 XFAIL 是**假件不忠实**（nearShelter 恒 null），性质最差。

**(c) 以 skip 收尾的用例** —— `unit_all.mjs:99-101` 把 `verify_y_semantics` 列入 NEEDS_REAL_DATA，默认跳过。这一条**是合理且有理由的**（要真机录的地形库）。我实测它在有库时能跑：`node tools/verify_y_semantics.mjs` → `1 PASS`。不算问题。

**(d) 用夹具伪造了被测行为（假测试）** —— 1 处，但是**最严重的一处**：`atom_classify_unit.mjs:68-69` 用带 `pos` 的夹具绕过生产写入方（T5）。同类第二处：`nav_lock_unit` 只测显式 owner，避开真实 owner 来源（T7，属"避开了被测接线"而非"伪造"，但效果相同）。
另外 `test_codes.mjs` 属 (e) **误报型**：用正则统计 code，把数据载荷里的 `DIED` 当成 ActionResult code（T8）。

---

## 五、门禁绕过路径（谁能绕过、怎么绕）

按"改一行就能让门变绿"的容易程度排序：

1. **没人跑，所以不存在"绕过"** —— 根因。没有 CI、没有 git hook、`npm test` 只是 `unit_all`（T2）。任何人提交任何代码，只要不手动敲命令，三道门全部为零。
2. **`--report-api` 一句话降级 §4**：`preflight.mjs:278` `API_SCAN_ENFORCE = !process.argv.includes('--report-api')`。加了参数，API 扫描从"命中即失败"变成"只报告"，preflight 仍可能整体退出 0。
3. **`allow` 白名单是硬编码文件路径**：`preflight.mjs:305-311` 已豁免 `modes.js`（双份）、`agent.js`、`atom_input_*`。要把一个新文件塞进白名单只要改一个字符串数组——没有"为什么豁免"的可执行约束（只有注释）。
4. **改名/解构/可选链绕过 §4 正则**：见 T9，`b.dig()`、`bot?.dig?.()`、`const {setControlState}=bot` 三种正常写法都漏。
5. **`unit_all` 的 UNITS 是手写白名单**：`unit_all.mjs:24-90`。删掉一行就"少一个测试"，而总数会从 64 变 63——**没有任何检查断言"新加的测试文件必须注册"**（`grep`：`unit_all.mjs` 里没有 `readdirSync`，`:107` 只过滤）。这是 42 个孤儿产生并持续增加的机制。
6. **`test_*.mjs` 天然不在门禁内**：只有 `*_unit*.mjs` 被当作"单元测试"，`test_*` 前缀等于"手敲脚本"。命名习惯成了门禁边界。
7. **XFAIL 让红变绿**：`scaffold_tracker_unit.mjs:63` 等，只要 bug 指纹不变就永久绿（T6）。
8. **`preflight` 的"非致命"通道**：§[1/4] 对 `Cannot find module ...tile_map`、`atom_move.makeMovements` 异常都标"非致命"并放行——模块引用已经失效（`tile_map` 文件不存在）也不会红。
9. **web typecheck 的 `strict:false`**：改代码基本不会让它红（T11）。

**唯一"结实"的地方**：preflight §[6/6] 的三态设计（`preflight.mjs:870-905`）——它区分了"检测了没问题 / 检测了有问题 / 根本没检测"，并且在"没跑起来"时**判失败**而不是给绿灯，还要求自测 ≥6 条才算可信。这是全仓最值得复制的模式（本报告 T4/T5 的缺口都能用它表达）。

---

## 六、可合并瘦身清单（预计行数）

| 项 | 文件 | 预计减少 |
|---|---|---|
| 抽出共用 harness（`ok/fail/xfail/summary`），替换 40 个文件各自手写的判定 + 5 个文件各自的 XFAIL 逻辑 | 40 个 `*_unit*.mjs` | **-250 ~ -350 行** |
| 删除已红且误报的 `test_codes.mjs`（职责与 preflight §[3/4] 重叠且更弱） | `tools/test_codes.mjs` | -73 行 |
| 13 个离线孤儿并入 `unit_all`（不删，登记）；29 个服务端脚本合并成一份 `real_all.mjs` 清单（去掉各文件自己那句"需要服务器"的说明） | `tools/test_*.mjs` × 42 | **-40 ~ -80 行**（多为重复的头部注释与连接样板） |
| `unit_all.mjs:24-90` 的 65 行手写白名单改为 `readdirSync('tools').filter(/_unit\.mjs$/)` + 一个显式排除表（`NEEDS_REAL_DATA` 已有） | `tools/unit_all.mjs` | **-50 行**，并根治 T4 |
| 总计 | | **约 -400 ~ -550 行** |

（`tools/` 下 65 个测试脚本共 **17967 行**，本项瘦身幅度约 2~3%。真正的收益不是行数，而是"新增测试不会再漏注册"和"XFAIL 语义只剩一份"。）

---

## 七、未验证的部分（明确列出，不许假装读完）

1. **9 个测试脚本没跑起来**（环境 EPERM 写临时目录）：`board_store_unit`、`board_iface_unit`、`board_b3_unit`、`board_b4_unit`、`board_orphan_parent_unit`、`board_store_converge_unit`、`board_store_finish_unit`、`path3d_tunnel_unit`、`strat_alloc_unit`。**整个任务板测试套件（8 个文件）的断言强度我没有实测**，只做了静态阅读（读了 `board_scheduler_unit.mjs` 的注释区与 `board_store_converge_unit.mjs:194-227` 的 XFAIL 段）。换到可写目录重跑是复核这部分的唯一办法。
2. **`node tools/unit_all.mjs` 的真实 0/64 我无法得到**（同 EPERM spawn）。我给出的"56 个跑完 / ≈742 PASS"是逐个直跑的口径，与 `unit_all` 的 `passCount`（`unit_all.mjs:141` 只数行首 `PASS`）口径一致但**不是同一次执行**。
3. **`preflight.mjs` 1076 行我只精读了约 300 行**（§4 规则表、§6 自测三态、§1 模块加载）。`audit_rules.mjs`（18 条规则表）与 `audit_codes.mjs`（38 码）**只看了输出不看实现**——所以"规则表自洽"具体断言了什么，我只能说它通过了、不能保证它断言得对。
4. **`board_scheduler_unit.mjs`（1138 行）只读了 XFAIL 段**（`:1040-1090`），其余 1000 行断言内容未逐条核。
5. **29 个需服务端的 `test_*.mjs` 一个都没跑**（没有服务端），它们是否还能跑、断言是否过期**完全未知**。
6. **`tools/` 下另外 ~150 个非测试脚本**（bench_*、probe_*、verify_*、_dbg_*）没读，只通过 `ls` 与 `unit_all` 白名单确认它们不在门禁内。
7. 所有 ESLint 数字（319 / 39 / 57 / 20）来自**一次**运行，未做跨版本对比；`require-await` 78 条与 `semi` 107 条我没逐条看是否真问题（按项目风格 `semi: error` 合理，但 107 条说明风格并未统一到配置上）。

---

## 八、给 captain 的三句话

1. **最该先修的不是某个测试，是"没有人在跑测试"**（T2）—— 修 3 行（`package.json` 加 lint + 串起 test）+ 一个 CI 文件，就能同时激活 eslint 抓到的 7 处 ReferenceError（含 `digTunnel` 必崩）和 preflight。
2. **`eslint.config.js` 改两行**（`ecmaVersion: 2021`→latest、`globals.browser`→node）能让 20 个模型适配器重新可被检查、并让 49 条误报消失（T3）——投入产出比全场最高。
3. **测试层面最危险的一处是 T5**：唯一守"地标保护"的测试用夹具伪造了生产永不产生的数据形状，所以它绿着而玩家箱子可被挖（对应审计① N4）。改 2 行夹具 + 加 1 条断言即可让它变红并暴露真 bug。
