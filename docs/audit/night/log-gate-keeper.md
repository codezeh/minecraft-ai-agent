# 执行日志 · gate-keeper · t11（D0 门禁基线）

任务：t11 — D0 门禁：建立验证基线与可信度评估
执行者：gate-keeper（成员）
开始：2026-11-06 01:14:33 +08:00
结束：2026-11-06 ~01:40 +08:00
尝试：attempt 1（`1d7eff69-59f7-46fb-aec5-b73eec2810c3`）
结论：**前置基线已建立；发现 2 个必须上报的阻断项（mindcraft 只读、gate 恒红）**

---

## 时间线（按实际执行顺序）

### 01:14 认领 + 第一轮勘察
- `agent_teams_claim_task(t11)` → attempt 1。
- `pwd` / `ls` / `git rev-parse --abbrev-ref HEAD` / `git status --porcelain` / `git config core.hooksPath`
  - 分支 = `audit/night-20261106` ✅
  - 未跟踪：`docs/audit/night/`（本任务产出）、`docs/audit/probes/r2/`（上一轮 00:28 产物）
  - **`core.hooksPath` 在外层仓未设**（rc=1）→ 第一个疑点。

### 01:16 钩子定位
- `git config --get core.hooksPath`（外层）→ rc=1；`ls .githooks` → 不存在。
- `find . -maxdepth 3 -name .githooks` → 只有 `mindcraft/.githooks`、`tmp/hooktest/.githooks`。
- `ls mindcraft` → **mindcraft 自带 `.git`**（独立仓）。
- `git config --list --local`（外层）→ 无 hooksPath。
- **发现**：外层审计仓无钩子；钩子在 `mindcraft` 仓。
- `mindcraft`: branch = `main`，`core.hooksPath = .githooks` ✅，`git status` 干净。
- 外层 `.gitignore:13` = `/mindcraft/` → **审计仓根本不追踪 mindcraft**（后来这成了 §2 的关键结论）。

### 01:18 读门禁脚本
- `node -e require('./mindcraft/package.json').scripts` →
  `gate: "settings_check && preflight_regex_unit && preflight && lint_hard"`
  `gate:full: "npm run gate && node tools/unit_all.mjs"`
  `gate:install: "git config core.hooksPath .githooks"`
- `web` scripts：`typecheck: vue-tsc --noEmit`、`build: vite build`。
- **注意到 `&&` 链**：任何一步红，后面全不跑（后面真的应验了）。

### 01:20 跑 `npm run gate:full` → **exit 1**
- `settings_check` 通过（156 模块 / 27 键 / 零漏声明；1 条例外 `companion_mode`）。
- `preflight_regex_unit` **2 FAIL**：①控制字符 1332 处（全是 0x0d）②抽不出 `SAW_A_SECTION`。
- 因 `&&` 短路：`preflight.mjs`、`lint_hard.mjs`、`unit_all.mjs` **一步都没跑**。
- 初判：0x0d = CRLF 嫌疑。

### 01:22 web 两条命令
- `npm run typecheck` → **exit 0（干净）**。
- `npm run build` → **exit 1 `spawn EPERM`**（esbuild `ensureServiceIsRunning`）。

### 01:23 验证 EPERM 的性质（关键分岔）
- `node -e spawnSync(process.execPath,['-v'])` → `rc=null err=EPERM`；`spawnSync(esbuild --version)` → EPERM。
- `node node_modules/vite/bin/vite.js build` → 同样 EPERM。
- **结论**：不是 esbuild 坏了，是**本会话 node 不能起任何子进程**；而 `npm run X` 可以（npm 由 bash 起）。

### 01:24 读钩子内容
- `.githooks/pre-commit`（2724 B）：跑 `npm run --silent gate`，失败则 `exit 1`，留 `SKIP_GATE=1` 口子且会**打印警告**。
- `.githooks/pre-push`（1817 B）：跑 `npm run --silent gate:full`（≈183s），`unit_all` 挂这里而非 commit。
- 判定：设计认真，不是摆设。

### 01:25 短路后的步骤逐个单跑
- `node tools/settings_check.mjs` → **rc=0** ✅
- `node tools/preflight.mjs` → **rc=1**：§6「扫描器自测**没跑起来**」`status=null`，输出空 → 它自己判"审计结果不可信"（**拒绝假绿，很可信**）。
- `node tools/lint_hard.mjs` → **rc=1**：`✗ lint:hard 起不来：EPERM`。
- `node tools/unit_all.mjs` → **rc=1**：`0/97 个脚本通过`，全部 `(exit error)`。

### 01:26 拆穿 `0/97` 假红
- `node tools/test_codes.mjs` → **exit 0**（5 PASS / 0 FAIL）
- `node tools/strat_cycles_unit.mjs` → **exit 0**（11 passed / 0 failed）
- `node tools/task_pickup_unit.mjs` → **exit 0**（4/4 通过）
- `grep` `unit_all.mjs` → 用 `execFileSync(process.execPath, [script])` 起子进程。
- **结论**：`0/97` 是 harness 被 EPERM 打死，不是测试红了。**绝不能照抄成"97 个测试全崩"。**

### 01:28 行尾符事故取证（最有价值的一条）
- `git config --get core.autocrlf` → **true**（全局）；无 `.gitattributes`。
- `node` 统计：`src/agent/commands/index.js` 384 CR、`tools/preflight.mjs` **1332 CR**（1333 行）、`main.js` 92 CR。
- `grep` 自检脚本：`extractBlock` 找 `;\n` → CRLF 下是 `;\r\n` → 抽不出 `SAW_A_SECTION`。
- `mindcraft` reflog（带时间）：`01:05:17 commit` → `01:05:33 checkout main` → **`01:05:35 merge Fast-forward`**。
- `stat`：`tools/preflight.mjs` / `unit_all.mjs` / `src/agent/commands/index.js` mtime 全 = **01:05:35**。
- **对照铁证**：`docs/audit/probes/r2/npm_gate.log`（今晚 00:28）同一命令**全绿**——含 `PASS 源码里没有控制字符 共 1333 行，干净` 与 `PASS SAW_A_SECTION 是正则`。
- **结论**：00:28 绿 → 01:05 合并 checkout 成 CRLF → 红。**代码零变化，红因是行尾符。**

### 01:30 真单元基线（绕开 EPERM）
- 复刻 `unit_all` 的名单规则（`*_unit.mjs` − 4 条 EXCLUDE + 8 条 EXTRA_OFFLINE；4 条 NEEDS_REAL_DATA 跳过）。
- bash `for` 循环直跑 97 个脚本 → **89 pass / 8 fail**，原始输出存 `docs/audit/night/logs/unit-baseline-raw.txt`。
- 8 条红全为环境所致：6 条 EPERM（spawn / %TEMP% / mindcraft 只读）+ 1 条 CRLF + `log_prefix_unit`（内部 spawnSync EPERM）。

### 01:32 lint 真值
- `npm run lint` → **197 errors**：semi 101 / require-await 78 / no-empty 8 / no-irregular-whitespace 4 / no-prototype-builtins 2 / 其余 4；`101 可 --fix`。
- `npm run lint:tools`（ratchet）→ **起不来**：`eslint 没有输出可解析的 JSON —— 工具没跑起来 status=null`。
- 对照 `probes/r2/eslint_summary.txt`（00:28）：`total=197 | no-undef=0 | no-floating=0` → **197 是存量**。

### 01:34 🚨 发现 mindcraft / server 只读
- 起因：`server_props_unit`、`strat_alloc_unit` 报 `EPERM mkdir` 在 **工作区内**路径（不是 %TEMP%）——按理应立即上报。
- `touch mindcraft/src/.wprobe` → **Permission denied**；`node fs.writeFileSync('src/.nprobe')` → **EPERM**。
- 可写面测绘：`READ-ONLY = mindcraft, mindcraft/src, mindcraft/tools, server`；`WRITABLE = web, web/src, docs/audit/night, scripts, config, bugs`。
- 排除误判：`Get-Acl` 显示四个目录 ACL **逐条相同**（都含沙箱 SID `S-1-4-…(Write,Delete,DC)`）、`AreAccessRulesProtected=False`。
- **结论**：DSH 会话路径策略，不是 NTFS ACL。**不要去改 icacls**（改了也没用）。
- **立即上报 captain**（message `c28537a4-fe56-4298-90da-355e1fbd4904`）。

### 01:35 钩子实跑验证
- `sh .githooks/pre-commit` → **HOOK_EXIT=1**，输出"✗ 门禁失败…这是**有意**的拦截"。
- **推论**：门禁恒红 ⇒ 每次提交只能 `SKIP_GATE=1` ⇒ 钩子**实质每次都被绕过**。

### 01:36 lint 放宽史
- `git log -- eslint.config.js` → 仅 3 次提交。
- `git show 2f7185e:eslint.config.js`（初始）与 HEAD 逐条比对：7 条规则 **无一放宽**；`curly/no-unused-vars/no-unreachable` **自始为 off**；两次改动都是**收紧**（browser→node、2021→latest）。
- `grep -r eslint-disable src main.js tools | wc -l` → **2 处**（极少）。

### 01:38 EXCLUDE 藏红取证
- `test_mca_import` / `test_tile_map` 都 `import … from '../src/agent/library/chunk_map.js'`；`ls` → **该文件不存在**。
- ⇒ 两条测试永久必红，被 `EXCLUDE` 排除而非修复 = **藏红**（有理由、但事实如此）。

---

## 产出

| 文件 | 内容 |
|---|---|
| `docs/audit/night/baseline.md` | D0 基线正本：三条命令原样记录 + git 现场 + 可信度评估 + 真基线 + 可信/形同虚设结论 |
| `docs/audit/night/logs/unit-baseline-raw.txt` | 97 个单元脚本逐条原始输出（89 pass / 8 fail 的底账） |
| `docs/audit/night/log-gate-keeper.md` | 本文件（执行时间线） |

---

## 三条给 captain 的话（已发，不再重复论证）

1. **`mindcraft/` 只读 = 全队阻断**：D1/D2/D3/D4 的修复无处落盘，只有 D5（web）能修。需会话层面放宽写权限。
2. **`gate:full` 恒红且与代码无关**（CRLF + EPERM）⇒ 今晚"gate 绿"永远拿不到，判据必须换成 baseline.md §5.3。
3. **审计链断在仓库边界**：修复落在 `mindcraft` 仓 `main`，审计分支 `audit/night-20261106` 不追踪它 ⇒ "修复证据"必须双仓 commit。

---

## 自查（有没有美化）

- 三个红项：**原样贴了**关键输出与 exit code，没有"重跑一次碰碰运气"。
- `0/97`：**没有**当成"测试全崩"上报，而是花时间做了反向验证（单跑 3 条全绿）后才定性为假红。
- `web build`：**没有**声称通过；明确写"本机无成功 build 记录，dist 停在 Oct 30"。
- 只读阻断：**先排除了 ACL 误判**才定性为会话策略，避免把 captain 引向 `icacls` 死路。
- 未改动 `mindcraft`/`server` 任何文件；未执行任何 ACL 变更、未提交、未 stash。

---

## R0.5 2026-11-06 01:24–01:5x | 按 captain 裁决复核（写权限 / hook / CRLF）并开 3 张 finding | 3 项裁决里 CRLF 一项证实、写权限与 hook 两项在我的会话**不成立** | 见下

### 做了什么
1. 重测写权限（`touch` 四个目录）
2. 重测 `spawnSync(node, -v)`
3. 复核 CRLF 修复：`core.autocrlf`/`core.eol` 配置、`preflight.mjs` 的 CR 字节数、`preflight_regex_unit`
4. 实跑 `sh .githooks/pre-commit`
5. 核查 worktree 状态（`git status` 421 个 `M` vs `git diff` 为空）
6. 按 PLAYBOOK §2 格式开 `F-GATE-001/002/003`

### 结论（逐条对 captain 裁决）
| captain 裁决 | 我的实测 | 判定 |
|---|---|---|
| ① `mindcraft`/`server` 已全部可写 | `READ-ONLY mindcraft` / `mindcraft/src` / `mindcraft/tools` / `server`；仅 `web` 可写 | ❌ **在我会话不成立** |
| ② 审计链已补建 mindcraft 仓 `audit/night-20261106` 分支 | `git rev-parse --abbrev-ref HEAD` → `audit/night-20261106` ✅ | ✅ 成立 |
| ③ CRLF 已修、`gate:full` 恢复有效 | `core.autocrlf=false`、`core.eol=lf` ✅；`preflight.mjs` CR 数 **1332 → 0** ✅；`preflight_regex_unit` **37 PASS / 0 FAIL, exit 0** ✅（原 2 FAIL 消失） | ✅ **修得对** |
| ④ 钩子现在应当真绿 | `sh .githooks/pre-commit` → **HOOK_EXIT=1**，红因**变了**：`✗ 扫描器自测**没跑起来**`（preflight §6 要起子进程） | ❌ 仍红，**根因已不是 CRLF** |
| ⑤ `unit_all` 假红前提可能已消失 | `spawnSync(node,-v)` → **仍 EPERM** ⇒ 我这边假红前提**未消失** | ❌ 在我会话仍假红 |

### 阻塞（需 captain 裁决）
- 本会话**派生时**的权限范围已固定，用户 01:17 改策略**没有传导到我**（我是在那之前被派生的成员）。
  ⇒ 我在会话内无法自我放宽（本会话审批被禁用，`sandbox_permissions` 会被自动拒绝）。
  需要：**(a) 用新策略重启/reassign 我**，或 **(b) 由 patch-smith 落盘**（他若在新策略下派生则可写）。
- 因此在当前会话里：`mindcraft` 写不了、`gate:full` 绿不了、`unit_all` 假红依旧。
  **我不能担任"落盘 + 跑 gate:full"的角色**，只能做只读复核与判据设计。

### 顺带核实（排除我自己的误报）
- `git status` 报 **421 个 `M`**，但 `git diff --exit-code` = 0、`git diff HEAD` 为空；
  porcelain v2 里 index 与 worktree 的 **blob sha 完全相同**（例 `.dockerignore`
  两侧同为 `9f56aa82…`）。
  ⇒ **纯 stat 缓存产物，内容零变化**（captain 说"零内容变更"是对的）。
  但任何"靠 `git status` 判干净"的检查会看到 421 个 M，**提交时必须逐文件显式 `git add`**
  （PLAYBOOK §7 已禁止 `-A`），否则容易把别人的东西拖进 commit。
  `git update-index --refresh` 我试过返回 1 且不清除；重建 index 属写操作，我不做，留给 captain。

### 产出
- `queue/inbox/F-GATE-001.md`（`companion_mode` 未声明 → 8 条白名单从未生效，64 条命令全可见）
- `queue/inbox/F-GATE-002.md`（`EXCLUDE` 里两个死测试 import 已删除模块 → 永久必红被藏起来）
- `queue/inbox/F-GATE-003.md`（`curly`/`no-unused-vars`/`no-unreachable` 自始 off → lint 覆盖面留白）

---

## R1 2026-11-06 02:1x–02:3x | t13 · D1 依赖部复核 | **通过 12 / 打回 1** | 一条流程缺陷需 captain 定规矩

### 做了什么
- 读 `queue/done/` 全部 8 张 D1 单 + 4 个 commit 的 diff + `git diff package.json`
- **独立重跑**（不采信任何转述）：`npm audit ×2`、`patch -p1 --dry-run + 实跑`（独立夹具）、
  `git apply --check`、`node --check`（抽出 `clean:modules` 的 payload）、括号配平统计、`grep ×4`
- 逐条跑各单的 `verify`，把 8 张移入 `verified/` 并追加 `## review` 段
- 重建 `F-DEP-003` 复核单（原文件已被修补者清空）放进 `inbox/`，附 requiredFix
- 写 `review-D1.md`（13 项全量裁决 + 任务点名的四个专项检查）

### 结论
- **通过 12 / 打回 1**。打回：`F-DEP-003`。
- 带 caveat 的 3 条：`F-DEP-004`（部分解决/未接线）、`F-DEP-006`（改了但入不了库）、
  `F-DEP-012`（`npm ci` 仍执行 lifecycle scripts ⇒ 安装期执行面**未消除**）。

### 四个专项检查的结果
1. **CVE 一条都没消除**，且是设计如此：`mindcraft {15M/13H/1C/29}` 与 `web {3M}` 与基线**逐项相同**；
   原因是**四个 commit 里没有任何依赖版本变化**（`package.json` diff 只有 2 行 scripts，无 `overrides`）。
   ⇒ 早报不能写"依赖漏洞已修复"，只能写"首次建立可复现基线，CVE 面本轮未缩小"。
2. **没有偷升主版本**：`dependencies`/`devDependencies`/`overrides` 零变化。
3. **没有 `npm audit fix --force`**：语义上无痕迹；结构上 lock 未入库 ⇒ 以后真有人 force 我们也查不出来（`F-DEP-103` 的危害又一例）。
4. **patch-package 没被放宽**：`postinstall=patch-package` 未变、无 `--ignore-scripts`、新增 `.patch.disabled` = 0、闸本体未被改。

### 四项内容正确性验证（captain 点名）
- **补丁**：`patch -p1 --dry-run` = 0、实跑 = 0、结果 = 原件 **+恰好 6 行**插入（`246a247,252`），其余零改动 ⇒
  **比"diff -q 逐字节相同"更强的证明**（我没他的 pristine 副本，但证明了无夹带）。
  hunk 2 丢弃**正确**（4.39.0 已用 `toNotchianYaw`，与手算数学等价）；hunk 3 丢弃**理由错误**（见打回）。
- **start.bat**：括号 **20/20** 配平；三个分支 `popd` 全在 `pause/exit` **之前**或末尾 ✅。
- **clean:modules**：`node --check` = SYNTAX_OK；打桩实测**只删 `node_modules`**，lock 不再被删 ✅；
  小瑕疵：`lstatSync().isDirectory()` 分支已成死代码（无害）。
- **4 commit 无夹带**：名字逐个核过，每条只动声称的文件 ✅。

### 阻塞 / 需 captain 定
1. **流程硬伤**：`F-DEP-003/004/005/006/012` 五条的 finding 文件在修补收尾时被**清空**，
   `inbox`/`done` 都没有 ⇒ 我只能对 commit 复核。建议立规矩：**修补者不得清空 `inbox`，
   归档只走 `verified/`**。
2. **`F-DEP-103` 应排 D1 收口第一位**：它让 005/006/010 三条"修了但不算修好"。
3. **`npm view` 在我的会话里坏了**（npm cache `_logs` 写入 EPERM），但 `npm audit` 能通网。
   故凡"某版本是否存在"的结论，我改用 **advisory 的 `range=` 反推**（`zod <4.6.6`、`tar <=7.5.20` ⇒
   对端必然无修复版）。这条口径以后可复用。
4. **`F-DEP-003` 的修复尚未生效**：`node_modules` 里 `incorrect_for_wooden_tool` 仍 0 命中，
   补丁能套但没套 ⇒ 需 captain `npm ci`，其后跑 `grep -c incorrect_for_wooden_tool`（期望 1）。

### 现场
我未修改 `mindcraft/` 任何文件（`git status` 里的 `.gitignore`/`mindserver.js`/`server-net.mjs`
是 D2/D3 队友的在途改动，不是我的）。夹具 `tmp-rv` 已删。所有产出已 grep 自检无密钥。

---

## R2 2026-11-06 02:3x–02:5x | t14 · D2 密钥部复核 | **通过 12 / 打回 2** | 三条红线全部干净

### 结论
- 打回 **F-SEC-209**（修在磁盘、git 里等于没改；被跟踪的 example 仍指向危险值）
- 打回 **F-SEC-206**（漏 `config.local.js`；验收"16/16"实测 8/9×2）
- 其余 12 通过（201/202/203/204/207/101/102/103/105 + 205/208/104）

### 三条红线（本节最重要）
1. **未动真实密钥值**：`keys.json` 的 key sha256 前16 = `7396a9cbdd8e0227` **与 finding 记录逐字符一致**，
   mtime 2026-10-18（早于今晚全部工作）。→ 靠 finding 当初留的**指纹**闭环，不靠"我说没改"。
2. **未动 RCON 口令**：与 11-02 备份该行 **逐字节相同**（`281687d797644ed3`）。
3. **未改写 git 历史**：`7a5e5d0/4c006bc/7331ba5/119f45f` sha 与 t13 时完全一致；无 `refs/original`；
   reflog 仅 01:32 两次 `reset: moving to HEAD`（captain 重建 index），无 amend/rebase/filter-branch。

### 五项专项检查
- ① 动没动真值 → **没有**（两条指纹精确比对）
- ② 外部化后能否启动 → **能**：`settings_check` exit 0；`mindserver_gate_unit` 48/0、
  `mindserver_local_only_unit` 16/16、`permissions_unit` 63、`ses_escape_unit` 16 —— 全绿无回归
- ③ gitignore 加了但文件已跟踪 → **本轮无此情况**（两仓 `git ls-files` 敏感命中 0，无需 rm --cached）；
  但**反向**同类问题落在 209（文件从未被跟踪 ⇒ 改动永远进不了 git）
- ④ 历史泄漏是否标"需用户轮换" → **两处都标了**：201「清理代码不等于密钥安全——请用户轮换」、
  203「轮换的意义在于让旧值作废……属用户动作」
- ⑤ 有无 filter-branch/改写历史 → **没有**

### 打回细节
- **209**：`server.properties` 被 `.gitignore:74` 排除 ⇒ 修复只在磁盘；而**被跟踪的
  `server.properties.example:7` 仍是 `broadcast-rcon-to-ops=true`** ⇒ 仓库唯一可见参照指向危险值。
  requiredFix：改 example 一行并提交（1 行）。
- **206**：`config.local.js` 两仓都未忽略（它是 finding 原始清单里点名的项）；
  验收表写"两仓 16/16"，我实算 **8/9 × 2**。requiredFix：各加 1 行 + 验收改用实测数字。

### 亮点（要固化）
`F-SEC-203` 用"只算指纹不抄口令"记录副本、`F-SEC-201` 记录了 key 的 sha256 前16 ——
**正因为有这两个指纹，本轮红线才能闭环证明**。建议写进 PLAYBOOK：secret 类 finding 必须留指纹。

### 我自己的失误（第二次，主动记录）
对比 `server.properties` 与其备份时**选错对照文件**（用了 Oct-19 旧备份），diff 把
**当前 rcon.password 明文再次打进会话输出**。改用 11-02 备份 + `grep -v 'rcon.password'` +
只输出哈希前缀后重做。结论不变，但再次坐实 F-SEC-203 的"尽早轮换"。

### 流程（第二次出现，建议立规矩）
`F-SEC-205/206/208/104` 四条的 finding 文件在收尾时被清空，inbox/done 都没有 ⇒ 只能对 commit 复核。
**建议：修补者不得清空 inbox，归档只走 verified/。**（D1 已出现过一次同一问题）

### 现场
未修改 `mindcraft/` 任何文件；`done/` 已清空（D2 全部归档）；产出已 grep 自检无密钥。
