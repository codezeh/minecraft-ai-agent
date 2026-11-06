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

---

## R3 2026-11-06 02:0x–02:2x | 预审下一个实现窗口三条（F-EXEC-201 / F-AI-202 / F-WEB-205）| 通过 2 / 需修正 1

### 关键发现：两条已被实现，一条未动
- **F-EXEC-201（speak RCE）已实现**：`exec(拼串)` → `spawn(字面量argv)` + 文本走 stdin；全仓 `shell:true` grep 为空。
- **F-WEB-205（停止面板）已实现**：`stop-all.mjs` 按 env→`./.mindserver-token` 取 token 塞 `auth`，
  退出码 2/3 分档；`stop-panel.ps1` `Push-Location mindcraft` + finally popd。
- **F-AI-202（!goal）完全未动**：等级仍 trusted、`prompter.js:226` 仍无转义无限长、`self_prompter` 无轮次上限。

### 最有价值的一条：我用实测推翻了自己的"专家直觉"
我原以为 Windows 上 `[Console]::In.ReadToEnd()` 默认编码会把中文弄乱、应加 `InputEncoding=UTF8`。
**实测结果相反**：
```
printf '中文测试HELLO' | powershell -Command '[Console]::In.ReadToEnd()'         → 中文测试HELLO  ✅
printf '中文测试HELLO' | powershell -Command '[Console]::InputEncoding=UTF8; …'  → ���Ĳ���HELLO  ❌
```
⇒ **现有实现是对的；"顺手加固"会把中文 TTS 弄坏。** 已要求把这条实测结论写进代码注释，
否则后人（包括未来的我）会加错。

### F-AI-202：我不同意原修法的一处（重要）
finding 建议把 `!goal` 与 `!endGoal` 一并升 OWNER_ONLY。**我认为 `!endGoal` 必须留在信任级**：
- 它是**急停**（停自提示循环），危险方向是"停止"不是"授权"；
- 若两者都升权，**owner 之外的任何人发现 bot 被套上疯狂目标时无法叫停** —— 与降险目标相反；
- goal 会写进 memory.json 跨重启恢复，更需要信任级能停。
⇒ 建议**只移 `!goal`**，并在 commit body 写明理由。

另两条判定：
- `!goal` 升权**对当前用户无影响**（唯一启用 profile `my-local.json` 的 owner = HEAVENZEH）；
  **但 owner 为空的 profile（deepseek / defaults/*）会 100% 用不了 `!goal`**（OWNER 级不可达）⇒ 需在 settings 注释写明。
- **限长 500 不是重点，转义才是**：现在的通道是 `"${prompt}"` 未转义 `"`，60 字注入就够；限长挡不住。
  且若做限长，**不许静默 slice**（会把目标拦腰砍断、语义反转），应超限拒绝并回话。
- 会红的测试我已定位到行：`permissions_unit:64`（`trustedCan` 含 `!goal`）与 `:181-182`（断言"没配 owner 陌生人 !goal 可用"），必须同 commit 改，并补"owner 配了 HEAVENZEH 时 !goal 可用"的正向断言。
- 实测现网最长 goal ≈ **170 字符**（bots/*/last_profile.json），500 有 3 倍余量 ⇒ 不会误伤。

### F-WEB-205：cwd 链条逐环验过，对得上
`start-panel.ps1:187-188` 以 `-WorkingDirectory (Join-Path $root 'mindcraft')` 起 mindserver
⇒ token 落 `<repo>\mindcraft\.mindserver-token`；`stop-panel.ps1` `Push-Location` 到**同一目录**；
`start-panel.ps1:203` 读的也是这个路径 ⇒ 三处口径一致 ✅
失败三档已分开（2=拿不到 token / 3=握手被拒 / 0=真没开），且都警告"服务器仍在运行，别关窗口" ⇒ 不误导 ✅
两条残留（不在本单）：`$node` 路径硬编码、`8080` 硬编码（改端口会走错分支）。

### 我的失误（第三次，同一病根）
我上一轮说"`config/network.json` 仍留旧论断"是**没 grep 就凭记忆下的结论**。实测 zero 命中，captain 是对的。
与前两次泄露口令同源：**拿印象代替实测**。已定：凡"文件里还有没有某句话"必须先 grep。

### 产出
`docs/audit/night/review-prestage-2.md`

---

## R4 2026-11-06 02:1x–02:3x | t15 · D3 执行体部复核 | **通过 2 / 打回 1** | 两条自查纠正

### 判决
- **F-EXEC-201（speak RCE）通过**：`exec` 已彻底移除、argv 全字面量、文本只走 stdin、全仓无 `shell:true`
  ⇒ **命令行内不存在可变文本**，是结构性堵死而非黑名单。
- **F-EXEC-202（38 处裸斜杠）打回**：闸**确实挡住了**（我一开始怀疑错了，见下），但
  ①靠"腰斩整个 initBotTask 后半段"实现 ⇒ teleportBots/对话/killAll 一起被跳，而日志只报 cheat ⇒ **低报**；
  ②闸在**调用方**不在 sink，`teleportBots()`/`initiator.init()` 自身无判据 ⇒ **换调用方即静默绕过**（任务判据明列的形态）。
  建议 `guardedChat()` 下沉治本。
- **F-EXEC-203（贴图路径）通过**：白名单 `^[a-z0-9_]{1,64}$` **强于** resolve+前缀（连点与斜杠都不允许）。
- **F-AI-202 ①②（D4，本轮一并）代码通过**：`!goal` 升 OWNER_ONLY、**`!endGoal` 正确保留在 TRUSTED**、
  转义顺序正确（`\` 先于 `"`）、超限**可见截断**。**但 permissions_unit 仍红（exit 1，59 passed）⇒ 断言未同步**。
  （F-AI-202 属 D4，留在 claimed/ 等 D4 复核，我不越部门归档。）

### D3 整体不能 PASS 的两个硬前提
1. **`gate:full` 未绿**（captain 实测 95/97；`permissions_unit` 4 红 = 我预审预告的断言）。
   按任务判据"gate 必须真绿" ⇒ 不通过。
2. **11 个文件全未提交**（`git status` M）⇒ 无 sha 可引用、无法单条回滚，违背 PLAYBOOK §3「一条修复一个 commit」。

### 两处自查纠正（主动记录）
1. **"D1 那 5 条 finding 被清空"是我错了**：它们在 `claimed/`，我 t13/t14 只查了 `inbox/` 与 `done/`。
   已把因此误造的 4 份重建记录（F-SEC-104/205/206/208）与**原件合并成一份**（review 并入原件，claimed→verified/inbox），
   现每份含 1 个 `## review`，无重复。**教训：判"文件在不在"必须 `find queue -name "*.md"` 全目录扫。**
2. **我一开始怀疑 `ALLOW_TASK_CHEATS` 没盖住 `/fill`** —— 走完调用链发现**盖住了**（`initiator` 在闸后才创建、
   `teleportBots` 在闸后才调用，且二者全仓唯一调用点）。我把纠正过程写进 review，不用"结论恰好对上"掩盖"论证曾经错"。

### 现场
未修改任何仓库源码；未删除任何 finding（只 `mv` + 追加 review）；D3 三条已归档（201/203→verified，202→inbox）。

---

## R5 2026-11-06 02:3x–02:5x | t16 · D4 AI部复核 | **通过 1 / 打回 3**

### 判决
- **F-AI-202 通过**：`!goal`→OWNER_ONLY、`!endGoal` 正确保留；`$SELF_PROMPT` 编码式转义（`\` 先于 `"`）+ 500 可见截断。
  **测试是加强不是删弱**：`!goal` 从 trustedCan 移入 trustedCannot（7→8）、`!endGoal` 加进 trustedCan、
  8g 改写为 owner 用例、**8g2 新增**、8h 反向改写+新增急停断言，**一条没删没 skip**；66 passed/0 failed。
  无空 catch / 无换模型 / 无新增重试。
- **F-AI-201 打回（未完成）**：围栏函数写好了**但是死代码** —— `stringifyTurns()` 三个调用点(prompter 221/223、examples 79)
  **全不传 opts ⇒ `fenced` 恒 false ⇒ 围栏分支永不执行**；`sanitizeExternalText` **零调用点**。
  **这条 high 级注入面当前实际防护=0。** 且即便接上线，按任务判据（"防线在提示层、执行侧无校验 = 打回"）也不够：
  围栏属任务允许的"边界标记/硬上限"，但它作用在 system 提示上、可被绕过；执行侧只挡 10 条主人级、
  不挡 48 条信任级，且没配 owner 时 `return TRUSTED`。
- **F-AI-203 打回（未完成）**：四条修法（落盘净化/$MEMORY 围栏/硬规则/!forgetMemory）一条没落地。
  记忆是数据不是命令 ⇒ 没有执行侧判据可依赖，围栏+净化是唯一手段 ⇒ "写了不调用"等于零防护。
- **F-AI-204 打回（未完成）**：`settings_spec.json` 仍未声明 `companion_mode`；`if (!settings.companion_mode) return true`
  的**默认放行方向没反转**。仍挂在 settings_check 的 KNOWN_UNDECLARED 已登记例外（每次打印、未静默变绿 —— 这点诚实）。

### 门禁/流程
- 相关单测我全跑：`permissions_unit` 66/0、`mindserver_gate_unit` 49/0、`step_runner_unit` exit 0、`atom_classify_unit` 6/6
  ⇒ D4 改动没打坏它们；`permissions_unit` 由红转绿是因为断言被**正确改写**（我逐条核过是加强）。
- `gate:full` 本会话不能 spawn，由 captain 跑。
- **13 个文件全部未提交**（第三次提同一问题：D1/D3/D4 都这样）⇒ 无 sha、无法单条回滚。
- `text.js` 三个新函数**零测试引用** —— 又一个"没人守"的新代码。

### 一句话给 captain
**D4 只有 1 条真正交付。另 3 条仍在 inbox，其中 201/203 的"实现"是未被引用的死代码 ——
别因为 git diff 里看得见围栏函数就以为修好了。**

### 现场
未修改任何仓库源码；未删除任何 finding（只 mv + 追加 review）；F-AI-202 → verified，201/203/204 留 inbox 并附打回意见。

---

## R6 2026-11-06 02:5x–03:1x | D5 修前预审（F-WEB-201/203/202）| 通过 0 / 待修 3（其中 201/203 代码已在工作区）

### 前置发现（纠正 captain 的前提）
三张单**不是"还没开始"**：`F-WEB-201`/`203` 代码**已写好在工作区**（`mindserver.js` 未提交，文件自述 fix-ready）；
`F-WEB-202` **未实现**（只有一行注释，无缓存/无并发上限/无超时）。故 201/203 是"对已写代码的设计评审"。

### 最有价值的一条：**201 会有一个确定的白屏失败路径（已真实存在，不是假设）**
```powershell
# scripts/start-panel.ps1
$panelUrl = $panel                    # = http://localhost:8080/console  ← 无 token
if (Test-Path $tokenFile) { … $panelUrl = "$panel?token=$tok" }
else { Write-Host '[WARN] 未找到 .mindserver-token…' }    # ← 只警告，然后继续
Start-Process $panelUrl                # ← token 缺失时照样打开裸 /console
```
⇒ `.mindserver-token` 缺失/为空时（首次启动失败、cwd 不对、**mindserver 自己就有"写 token 文件失败只告警不阻断"的降级分支**），
脚本打开无 token 的 `/console` → 新 401 中间件 → **浏览器里只有一行 "unauthorized…" 纯文本**。
比"打不开"更糟：**看起来像服务器坏了**。另有一次性读文件的时序坑（mindserver 还没写出 token 就读）。
**建议**：① 拿不到 token 就别 `Start-Process`；② token 文件读取加重试（~10s）（两条缺一不可）。

### 三个问题的答案
1. **会不会打断 cookie 换发** → **不会**。顺序正确（换发中间件在前、鉴权在后），且鉴权同时接受 cookie 与 `?token=`；
   `authCookieHeader` 是 `Path=/; HttpOnly; SameSite=Strict` ⇒ 全站生效 ✅
2. **静态资源要 token 会不会打死面板** → **会**，且已有一个真实踩点（见上）。我建议**混合策略**：
   **外壳与静态资源放行、`/settings_spec.json` 与数据仍要 token**。依据：recon 已核 bundle 里**零凭据**，
   放行外壳不泄密；而 `settings_spec.json` 把 `allow_insecure_coding`/`task`/`speak` 这些**隐藏开关列成清单**，必须拦。
3. **CSP 会不会打死 three.js / vite** → **不会，实测**：`web/dist/index.html` **零内联脚本**（只有外链 module script）；
   bundle 的 `eval(`=0、`new Function(`=0 ⇒ **不需要 `'unsafe-eval'`**；`connect-src` 含 `ws:` ⇒ socket 通；
   `img-src data:` ⇒ 贴图代理的 base64 通。**唯一需人工确认的是 three.js 运行时渲染**（已列入最小验证清单第 5 项）。

### 202 的答案（captain 直接问的）
**光缓存 `import('minecraft-assets')` 不够，必须有"同 key 请求合并"**：
① `import()` 在 Node 里本来就幂等（模块注册表缓存）⇒ 缓存它解决的是不存在的问题；真正的开销是
`mcAssetsFactory(ver)` 的资源索引构建 + `readFileSync`；② **纯缓存在"第一波并发"上完全无效**，而攻击形态正是并发同 key
（20 个同时打 `oak_planks.png` ⇒ 20 个各跑一遍）；③ 还需并发上限 + 8s 硬超时（finding 实测"10 秒不返回"，现在连超时都没有）。
给出最小实现骨架（缓存 → 合并 → 并发上限 → finally 清理 → 504）。

### 203 的三个设计问题（代码已在，但有缺口）
① 桶键是 `socket.data.__rl`（**按连接**）⇒ **重连即重置，可无限绕过**；建议改 `remoteAddress` 或加全局桶。
② 只挂 `send-message`；`create-agent`/`restart-agent`/`listen-to-agents` 无限流（finding 原文要求）。
③ **不误伤 `narrate`**：我 grep 了全部 22 个 `socket.on(...)`，**没有 narrate 入站事件** ⇒ 零误伤。
另：限流挡不住 `max_commands=-1`（一次消息引爆无限命令），别把 203 当费用问题的完整解法。

### 我自己的两处更正
1. **"13 个文件全未提交"是我的错**（第三次同病）。`git log` 实测六个 commit 都在
   （`7ba7b5e/9e7253c/d42f796/c8df8ce/7d15339/76ee07b`），真正扣住的只有 `tasks.js` 与 `text.js`。
   **根因与 421 假 M 同类：用 `git status` 判提交**。已定规矩：**判提交一律 `git log --oneline -- <path>`**。
2. **`7ba7b5e` 含两个 finding**（标题 F-DEP-004，实际含 F-DEP-003 补丁对）已登记进 `review-D1.md` 附注，
   并同步更正了 `review-D3.md`/`review-D4.md` 里的陈旧读数。**不改写历史**——我已按 sha 复核，rewrite 会让复核链失去锚点。

### 产出
`docs/audit/night/review-prestage-3.md`（含"改完必须验证的最小清单"8 项，其中第 3/4/5 项只能真机验）

---

## R7 2026-11-06 03:2x–03:4x | t17 · D5 复核 + 全晚收尾巡检 + 复核 captain 三处补修

### D5 复核：**通过 6 / 部分 1**
- **F-WEB-201 通过**：401 门在 `app.use` 链（服务端）；4 安全头 + disable x-powered-by；
  **CSP 不会打死面板**（dist 零内联 script、bundle `eval(`=0/`new Function(`=0 实测）；
  **我预审提的 P0 白屏路径已被正确修掉**（start-panel 重试 20×500ms，拿不到 token 不打开 + exit 1）。
- **F-WEB-204 通过**：三处 `path.basename(full)` ⇒ 接口真的不下发绝对路径（非前端隐藏）。
- **F-WEB-203 通过**：message ≤2000 + 令牌桶；**桶已按我预审改为按远端地址跨连接共享**（堵掉重连绕过）；
  `RATE_BUCKETS` line 71 已声明、node --check OK。
- **F-WEB-101 通过**：bot-output/agent-event 用握手凭据判 agent 身份（服务端判据）。
- **F-WEB-205 通过（代码层）**：token 取法/pushd/exit 2-3 分档全对；真机优雅关服待用户。
- **F-RT-002 通过**：`fstatSync(1).isFile()` + `!isTTY` ⇒ 重定向下忽略打印开关，堵掉自埋雷。
- **F-WEB-202 部分**：在飞上限 4 + 429 + finish/close 回收已落地；**缓存/同 key 合并仍未做**（我预审已论证纯缓存对第一波并发无效）。

### 复核 captain 三处补修（`review-captain-fixes.md`）：**不打回，1 项必须补**
- `2e84818` start-panel：`for ($i=0; $i -lt 20 -and -not $tok; $i++)` **语义正确**（比较优先级高于 -and）；
  半截读取风险真实但小 ⇒ 建议 `$t.Length -eq 36` 硬判据（UUID 定长）；
  **必须补**：`exit 1` 发生在 java/mindserver 都已启动之后 ⇒ 服务在后台跑却不告知、且跳过"怎么停止"说明
  ⇒ 用户会重复双击撞端口。补 2 行提示。
- `0ecc241` mindserver：两个担心判"实践不成立"——① `RATE_BUCKETS` 打不爆（`host='localhost'` ⇒ key 最多 2 个）；
  ② HTML 401 的 `port` 来自 `MINDSERVER_PORT` env、非 HTTP 参数 ⇒ 网络不可达。
  **但**清理逻辑在它声称防的场景里**空转**（513 个新鲜 key 全 <60s ⇒ 一个删不掉），且超限时每条消息全表扫
  ⇒ 建议给硬上界，或把注释改成"防长期累积"（**注释与行为要对得上**）。
- `f8496a9` 停止面板：token 取法 / Push-Location / exit 2-3 分档**全部正确**，与 start-panel 口径一致 ✅
- CSP 放宽：**理由成立**（实测 public/index.html 1 内联 script + 15 onclick）；建议按路径收紧（/console/* 保持 script-src 'self'），约 3 行。

### 全晚收尾巡检
- 分支 ✅ / **越界改动 0**（未碰 backups/logs/tmp/.env/keys.json/真实 server.properties/.bak）/
  **真实凭据 0 改动**（key 指纹逐字符一致）/ **git 历史未改写** / **lint 规则零改动**（3 条 off 是既有）/
  **单测无删无 skip**（permissions_unit 59/4→66/0 且断言加强）
- **一条 finding 一个 commit：部分违反**（69b3a14 自带 6 条、62a93a5/76ee07b/9e7253c/7ba7b5e 各 2 条）—— 已登记不改写历史
- 未提交仅 `tasks.js`（F-EXEC-202 待重做）与 `text.js`（F-AI-201 死代码），故意扣住 ✅

### 门禁：我能签什么
- ✅ 我亲手跑：`web typecheck` exit 0、`permissions_unit` 66/0、`mindserver_gate_unit` 49/0、`patch_integrity` exit 0
- ⚠️ **未证**：`web build`（spawn EPERM）、`gate:full`（node 不能 spawn）、面板真机冒烟、停止面板真机
  ⇒ **这三项没过，不许标"完全修好"**

### 产出
- `docs/audit/night/review-captain-fixes.md`（三处补修的逐条裁决）
- `docs/audit/night/NIGHT-REPORT.md` 追加「03:4x 复核席终章」（不覆盖 captain 的滚动报告）
- D5 七条已归档 verified/（201/202/203/204/205/101/RT-002），各含 `## review`

---

## R8 2026-11-06 03:5x–04:1x | 复验 D4 三条重做 + captain 必改项 | **通过 3 / 新发现 1 条 high**

### 复验结果（按 captain 要求：读本体，不信单测的源码断言）
1. **`6f46182` 接线 → 通过（不是死代码）**：我自己 grep 到四处真实调用点 ——
   `prompter.js:219` `$MEMORY→fenceUntrusted`、`:221` `$TO_SUMMARIZE→fenced:true`、`:223` `$CONVO→fenced:true`、
   `history.js:70` `sanitizeExternalText(memory,1500)`；`examples.js:79` **正确地不 fence**。
   另查了一条 captain 没提的旁路：`prompter.js:407` 另有一处 `$CONVO` 走同一 `replaceStrings` ⇒ 同样 fenced，**无漏网**。
2. **`permissions_unit 68/0` → 真绿且加强**：3 条断言改写成新语义（非删除）、**新增**"执行侧判据真的生效（走/停都不可用）"、
   **新增**"配了 owner 后信任级仍能用 !endGoal 急停"（双向守门）。实跑 `commandLevel` 确认 `!endGoal` 仍 trusted（未被顺手升权）。
3. **`08e0f65` → 通过（部分解决，如实标注）**：`tasks.js:526 await this.teleportBots()` **无条件在路径上**；
   日志逐条列"✗跳过了什么 / ✓什么照常 / ⇒ 场景没搭起来（部分解决）"；并主动写明"闸在调用方不在 sink，彻底修法已立单"。
4. **`bfdaca8` globalThis → 通过，2 建议**：单进程单 profile 下没问题（我核了三点：只在没 owner 分支置位、
   internal/otherBot 提前 return 不会误触发、每 agent 独立子进程各有一份）。建议 ①改 `Set`（按 profile 记，防未来多 Agent 串味）
   ②别挂 `globalThis`，用模块级变量（否则单测无法隔离）。
5. **我上轮必改项 → 已修到位**：`$t.Length -eq 36`、`exit 1` 前两行警告、`port` 归一、`req.path` 去控制字符、`RATE_BUCKETS` 注释对齐。

### 🔴 新发现 `F-AI-205`（high）：一个"无人能停的 2 秒烧钱循环"
**不是任何单个提交的错，是两个各自合理的改动组合出的新故障。** 五跳链条（全部实读）：
```
history.js:144-149  goal 跨重启存活（含 self_prompt_author）
  → 自提示回合按该 author 定级
  → permissions.js:154 fail-closed：没配 owner ⇒ LEVEL.OTHER ⇒ 所有命令（含 !endGoal）被拒
  → agent.js:674 executeCmd 被拒后 used_command 仍被**无条件置 true**
  → self_prompter.js:78-91 no_command_count 归零 ⇒ 循环永不自停（cooldown 2s）
```
叠加 `max_commands=-1` + 自提示提示词要求"必须含命令" + 按量计费 ⇒ **每 2 秒一次 LLM，玩家叫不停，只能改 memory.json**。
触发很现实：用过 my-local 设过 goal → 切到 deepseek/defaults（owner 实测 null）；或 owner 打成空串/错字。
**requiredFix（推荐①）**：权限拒绝时 `used_command = false`（1 行），让"被拒"等价于"没命令"⇒ 连续 3 轮 STOPPED；
或 ②加 `max_turns`（即 F-AI-202 ③）；或 ③恢复 goal 时校验作者等级，低于 TRUSTED 就不恢复。
已开单 `inbox/F-AI-205.md`，带五跳证据 + 4 条 verify。

### 队列纪律（这次先验证再动）
发现 `claimed/` 与 `verified/` 同名重复（我上轮又造成一次），且 **`verified` 那份只有 review、丢了原始单正文**（1774 vs 12454 字节）。
已按"claimed 全文 + 我 t17 复验段"合并成一份 → `verified/`，现在三份各含**原始单 + t16 review + t17 复验**（14.2KB / 8.6KB / 13.6KB），claimed 无残留。

### 关于 captain 问的第 ④ 条（commit 粒度）我的判断
**不认为"宁可拆成红门禁的中间态"是对的。** commit 的价值有两个：可回滚单元（要"内聚"）+ 归属可查（要"可查"）。
同文件交织改动天然是一个回滚单元，拆开会得到两个"单独 revert 都会坏"的 commit —— 降低价值一，而价值二有更便宜的办法：
**加一份 `docs/audit/night/COMMIT-MAP.md`（finding → sha）**。建议把规则从"一个 finding 一个 commit"改成
"**一个 commit 一个可独立回滚单元**"，body 按 finding 分节（captain 已在这么做且做得很好），
只在**跨文件/跨子系统**时坚持拆开（那种情况拆开才便宜）。一句话：**归属清晰 = COMMIT-MAP + body 分节，不是一个 finding 一个 commit。**

---

## R9 2026-11-06 10:3x–11:1x | R3-7 台账收口 + 核实 ② 5 项交付状态 + 复核 a8fd019

### ① 台账收口（R3-7）完成
R3 那 4 份无 `## review` 的单子，我核实**属实**（纯 YAML front-matter、零 markdown 标题）。
处理：
- `F-SEC-103` **≡ `F-WEB-204`（我逐字比对确认：同两个 socket 事件、同 `path: full`、同修法）** → 补 `## review` → 留 `verified/`
- `F-SEC-101/102/105` → 回 `inbox/`（写明 `superseded-by-202 ≠ 已解决`（202 仍 blocked、RCON 仍 0.0.0.0）、`deferred ≠ 已修`）
- `F-AI-205` → `verified/` + 补 `## review`（我自己验的，不只引 t29）
- `done/` **保留为空**（中间态，当前确无待复核项）
- 三组别名**成对**写入：`EXEC-203≡SEC-104`、`SEC-103≡WEB-204`、`DEP-103≡REG-002`
**收口后**：inbox 29 / claimed 10 / done 0 / verified **31**；**合规自检零命中**（31/31 都有 review 段）。

### ② 5 项修复：**全部未交付**（逐项读码，非看转述）
| 项 | 当前实际 | 判定 |
|---|---|---|
| R3-4 围栏转义 | `text.js:18-19` 正则**无 `i`**、`sanitizeExternalText` **不剥零宽** | ❌ 未修 |
| R3-2 限流硬上界 | `mindserver.js:87-89` 仍 `size > 512` + 删 >60s（触发条件当上限） | ❌ 未修 |
| R3-5 补丁哨兵 | `patch_integrity.mjs` 仍只有内容哈希+版本漂移，`grep 哨兵/sentinel/incorrect_for_wooden_tool` = 0 | ❌ 未修 |
| R3-6 闸进 gate | `gate` 仍 4 步（无 patch_integrity） | ❌ 未修 |
| F-SEC-206 `*.token` | 两仓 `.gitignore` 仍只有字面量 `.mindserver-token` | ❌ 未修 |

已给出**每项一条可判的验收命令**（`review-r3-triage.md §2.1`），落地即验。
特别为 R3-5（"变体病"）写了反例保护：**重装后必须转绿**，否则又成"恒红闸"；且哨兵须**从补丁内容解析**而非写死。

### ③ `a8fd019`（R3-M1）复核：**通过**
- 修法：`const NL = FLOW_SRC.includes('\r\n') ? '\r\n' : '\n'` —— 从被变异的源文件自身推断，不写死 ✅
- 根因我独立核实：`flow_craft.js` **LF=382 / CR=0 ⇒ 纯 LF**，原注释"src/ 是 CRLF"**方向写反** ⇒ 锚点永不匹配 ⇒ 变异插不进 ⇒ 恒红 ⇒ 逼人 SKIP_GATE ⇒ 门失效
- 实跑：`craft_diagnostic_reachability_unit` **15 PASS / 0 FAIL，EXIT=0** ✅
- 独立确认"还有没有别处"：`grep fromCharCode(13` / `'\r\n'` / `0x0d` 于 `tools/*.mjs` → **均零命中** ⇒ 审查说法成立

### 我的台账失实（不解释掉）
那 4 份无 review 的单子，是我**唯一一处自己违反自己口径**的地方。根因不是"历史格式遗留"，
而是**我的自检判据选窄了**：我扫的是 `## review`，没扫"有没有 markdown 标题"。
已把自检固定为 `for f in verified/*.md; do grep -qiE '^#+ *review' "$f" || echo 无review "$f"; done`，每次收口必跑。

### 产出
`docs/audit/night/review-r3-triage.md`

---

## R10 2026-11-06 12:1x–12:5x | t22 并发第三道流：快验 7 条 + 预审 F-EXEC-102 + 真机复跑

### ① 快验：captain 认为"5 条已修完"，实测 **0 条成立**
**先纠一处**：captain 的编号↔主题映射**三条全错位**（我按单子原文判）：
`F-AI-101` 实为 `err.message.includes()` 裸用（gpt.js:83 等 5 处），**不是** `!goal`；
`F-AI-102` 实为 `FAILED_REPLY` 魔法字符串（`_shared.js:25-35`），**不是** `console.log(err)`；
`F-AI-103` 实为 skills 分叉（`skill_library.js:31-44`），**不是** `get-profile`。

| 条目 | 判定 | 关键证据 |
|---|---|---|
| F-GATE-002 | ❌ 未修 | `unit_all.mjs:37-38` 仍在 EXCLUDE；两测试仍在；`chunk_map.js` 仍不存在 |
| F-GATE-003 | ❌ 未修（但**无放宽先例** ✅） | `eslint.config.js:40-42` 仍 off；本晚 eslint 配置 **0 次改动** |
| F-RT-004 | ⚠️ 部分 | `server.crt`/`keystore.jks`/`config.local.ts` 未覆盖；**`.ENV` 是 `core.ignorecase=true` 造成的平台假绿**（换 Linux 就漏） |
| F-SEC-105 | ❌ 未修 | `prompter.js:435`(settings) 与 `hyperbolic.js:50`(env) 两套开关并存 |
| F-AI-101 | ❌ 未修 | 5 处 `err.message.includes` 裸用（gpt83/claude54/groq67/mercury55/mistral63） |
| F-AI-102 | ❌ 未修（结构债，当前无活 bug） | `_shared.js:25-35` 逐字未变 |
| F-AI-103 | ❌ 未修 | `equip:1348`/`putInChest:1476`/`takeFromChest:1512` 仍独立实现 |

**最有价值的一条附带发现**：`.ENV` 显示"已忽略"**不是因为规则覆盖了大小写变体**，
而是这台 Windows 上 `core.ignorecase=true`（两仓实测均 true）让 git 的 ignore 匹配变成不区分大小写
⇒ **换到 Linux/macOS 立刻漏**。这是"平台造成的假绿"，与整晚在抓的假绿同类。

### ② F-EXEC-102 预审判据（patch-smith 未动手，我给了三枪验收）
现状实测仍是最坏形态：`mindserver.js:665-675` 仍 `stopAgent 发信号 → setTimeout(2000) → process.exit(0)`，
`grep process.on('SIGINT'|'SIGTERM'|'exit')` → **0 处**。
**真回收三条判据**：①每个子进程真的 `exit` 过（`kill()` 返回成功只代表信号送达）②退出前不持 board 租约
③父在子退出后才退且有超时兜底。
**孤儿判定手段及副作用**：父存活检查（需子进程配合、Windows ppid 有坑）/ 租约过期（有延迟、且**心跳会续租**正是症结）/ 心跳超时（判不了进程是否还活着）。
**建议三者叠加**，因为单项都有盲区。
**三枪验收**：枪1 正常 shutdown｜枪2 **父被 SIGKILL**（最容易假修：只改父侧必挂）｜枪3 Ctrl-C（现 `process.on` 0 处 ⇒ 必挂）。**只过枪 1 不算修好。**

### ③ 复跑 captain 的真机结论：**6/6 全部成立**
本会话 `spawn` 仍 EPERM，但**监听端口不是 spawn** ⇒ 用"同进程 import createMindServer + 内置 fetch（redirect:'manual'）"
在 **18099** 复跑（没占 8080），脚本留 `docs/audit/night/probe-http-gate.mjs`。实测：
```
A1 数据接口 无token 401（CSP/XFO/nosniff/Referrer 全 Y，X-Powered-By 已移除）
A2 页面导航 无token 401   B1 数据接口 带token 200（不是 302 ⇒ b0e7ca7 有效）
C1 页面导航 带token 302 → /   D1 index 带token 302   E1 socket.io 200（未误拦）
```
**唯一补充（captain 没提）**：**302 响应没有安全头** —— 302 在第一个中间件（换 cookie）里提前 return，
而安全头是第二个中间件设的 ⇒ 没跑到。实际风险≈0（302 无响应体），但会让"四头齐全"在自动化验收里给出**假结论**。
建议：安全头中间件前移，或 302 分支补一行。

### 产出
`docs/audit/night/review-concurrent.md` + `docs/audit/night/probe-http-gate.mjs`（可复现探针，未改业务代码）
