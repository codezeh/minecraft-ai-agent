# D0 验证基线（gate-keeper · t11）

> 采样时刻：**2026-11-06 01:14–01:35 +08:00**
> 采样本机：Windows / `E:\我的世界ai`，git-bash，Node v24.16.0
> 采样身份：DSH 受限沙箱会话（`workspace-write`，审批被禁用）
>
> **本文件的用途只有一个**：给今晚所有"通过/红了"提供唯一基准。
> 凡是本文件已标红的项，后面任何人不许说"这是今晚引入的"；凡是本文件写着"跑不了"的项，任何人也不许说"我跑通了"。

---

## 0. 一句话结论（先看这个）

1. `npm run gate:full` **现在就红**，`exit 1`，在第 2 步短路，**第 3/4 步和全量测试一步都没跑**。
2. 三个红项里**没有一个**是代码缺陷：2 个是行尾符（CRLF），其余是沙箱不能起子进程 / 不能写非白名单目录。
3. 更严重的是第 4 节：**`mindcraft/` 对本会话整个只读**——今晚 4 个部门的修复无处落盘。这条会推翻计划，已单独上报。
4. 今晚**唯一**可以直接信用的绿是 `cd web && npm run typecheck`（exit 0）。

---

## 1. 三条命令的实测记录（原样，不美化）

### 1.1 `cd mindcraft && npm run gate:full` → **exit 1**

```
> gate:full
> npm run gate && node tools/unit_all.mjs

'CALL "D:\Node\\node.exe" "D:\Node\\node_modules\npm\bin\npm-prefix.js"' 不是内部或外部命令…
（↑ npm 包装脚本的噪音，不影响后续执行）

> gate
> node tools/settings_check.mjs && node tools/preflight_regex_unit.mjs && node tools/preflight.mjs && node tools/lint_hard.mjs

扫描 156 个模块（其中 11 个 import 了 agent settings），提取到 27 个被读取的键；spec 声明 28 个。
§1 代码读了、但 settings_spec.json 没声明： ✓ 无（零漏声明）
§2 已登记的例外：⚠ settings.companion_mode  （理由见 §3.3）
§3 面板声明了、agent 进程内未见读取：init_message, load_memory
✓ settings 键一致性检查通过

preflight 审计正则自检
[1/3] 控制字符扫描
  FAIL  源码里没有控制字符（0x08 退格等）
     发现 1332 处：第 1 行：0x0d；第 2 行：0x0d；… （全是 0x0d）
[2/3] 从 preflight.mjs 源码里抽出审计正则
  PASS  CODE_AUDIT_REGEXES 是可求值的数组  共 2 条
  FAIL  抽不出 SAW_A_SECTION（§6 的指纹正则被改名了？）
[3/3] 已知样本：30 条全部 PASS

✗ 有红项：31 通过，2 失败。
GATE_EXIT=1
```

**短路后果（必须记住）**：`gate` 是 `A && B && C && D`，B 红 → **C(`preflight.mjs`)、D(`lint_hard.mjs`) 从未执行**；`gate:full` 又是 `gate && unit_all`，故 **`unit_all` 也从未执行**。
任何"gate:full 红/绿"的结论都只覆盖前 2 步，覆盖不到后 3 步。

### 1.2 `cd web && npm run typecheck` → **exit 0（干净）**

```
> vue-tsc --noEmit
TYPECHECK_EXIT=0
```
无任何诊断输出。**这是今晚唯一可信的绿，可以作为回归判据。**

### 1.3 `cd web && npm run build` → **exit 1（`spawn EPERM`，非代码问题）**

```
> vite build
failed to load config from E:\我的世界ai\web\vite.config.ts
error during build:
Error: spawn EPERM
    at ChildProcess.spawn (node:internal/child_process:441:11)
    at ensureServiceIsRunning (.../esbuild/lib/main.js:1978:29)
    at bundleConfigFile (.../vite/dist/node/chunks/dep-CkSfqg8D.js:49636:24)
BUILD_EXIT=1
```
**直接根因**：vite 要 esbuild 起子进程，而本会话内 `node` **无法创建任何子进程**（见 §3.5 自证）。与 `web/` 代码无关。
旁证：`web/dist/` 最新产物停在 **Oct 30 22:13**——本机近期没有成功的 build 记录。
⇒ **今晚不许声称 build 通过；也不许把 build 红算成"引入的新问题"。**

---

## 2. git 现场检查

| 检查项 | 结果 |
|---|---|
| 当前分支 | `audit/night-20261106` ✅ 符合 |
| 工作区是否干净 | ⚠️ 有两个未跟踪目录：`docs/audit/night/`（本任务产出）、`docs/audit/probes/r2/`（上一轮探针产物，00:28 生成，非我创建） |
| 暂存区 | ✅ 空（`git diff --cached` 无输出），没有意外文件被 add |
| 已跟踪文件有无改动 | ✅ 无（`git status --porcelain` 只有 `??` 两项） |

**但发现一个必须先说清的仓库结构问题（影响全队）：**

- 外层审计仓 `audit/night-20261106` **不追踪 `mindcraft/`**——`.gitignore:13` 明确写 `/mindcraft/`（理由：mindcraft 自带 `.git`，禁止嵌套）。
- `mindcraft` 是**独立仓库，当前分支是 `main`**，`HEAD = 3a41acf`（01:05:17）。
- 后果：D1–D4 的修复会落在 `mindcraft` 仓的 `main` 上，**不在审计分支的历史里**。今晚的"修复证据链"天然断在仓库边界。
- `server/` 被外层仓追踪（13 个文件），`web/` 也被追踪。

⇒ **判定"改了什么"必须同时给两个仓库的 commit；只看审计分支会得出"什么都没改"的错误结论。**

---

## 3. 可信度评估（这一节决定今晚能不能相信自己）

### 3.1 `.githooks` 是否真生效？—— 装了，真会拦，但**必然被绕过**

| 事实 | 证据 |
|---|---|
| mindcraft 仓已设钩子路径 | `git -C mindcraft config core.hooksPath` → `.githooks`（`.git/config` mtime 01:06:36） |
| 钩子文件真的存在且非空 | `.githooks/pre-commit` 2724 B、`.githooks/pre-push` 1817 B，均为 `-rwxr-xr-x` |
| 钩子**真的会拦** | 我直接 `sh .githooks/pre-commit` → `HOOK_EXIT=1`，输出"✗ 门禁失败…这是**有意**的拦截" |
| 钩子内容没被弱化 | `pre-commit` 跑 `npm run --silent gate`（commit 级，≈6s）；`pre-push` 跑 `npm run --silent gate:full`（≈183s）。与文档一致 |
| **外层审计仓：完全没有钩子** | `git config --get core.hooksPath` → rc=1（未设）；仓库根**没有 `.githooks` 目录** |

**致命推论**：因为门禁恒红（§3.5），`pre-commit` 必定 `exit 1` ⇒ 任何提交都只能用 `SKIP_GATE=1` 过 ⇒ **钩子形式存在、实质 100% 被绕过**。
并且钩子里只 grep 了 `✗` 等关键词，**它自己也分辨不出"红因是环境"**，会把人逼向 `SKIP_GATE`。

### 3.2 lint 规则有没有被放宽？—— **没有放宽的证据；但有 3 条规则"从出生就是 off"**

`eslint.config.js` 全部历史只有 3 次提交（`2f7185e` 初始 → `c0c98e3` 三门接线 → `9fe2fad` T04）。逐字比对 `rules` 段：

| 规则 | 初始提交 | 现在 | 是否放宽 |
|---|---|---|---|
| `no-undef` | error | error | 否 |
| `semi` | error | error | 否 |
| `require-await` | error | error | 否 |
| `no-floating-promise/…` | error | error | 否 |
| `curly` | **off** | off | 否（一直是 off） |
| `no-unused-vars` | **off** | off | 否（一直是 off） |
| `no-unreachable` | **off** | off | 否（一直是 off） |

实际改动只有两处，且都是**收紧**：`globals.browser → globals.node`（消 51 条误报）、`ecmaVersion 2021 → latest`（原来 `src/models/` 20 个文件"Parsing error"= 根本没被 lint 过）。

⇒ 结论：**没有"为了过门放宽规则"的先例**；但 `curly / no-unused-vars / no-unreachable` 三条自始关闭，lint 覆盖面就是薄的，**不要拿 lint 绿当"代码干净"的证据**。

### 3.3 有没有"为了过门关掉检查"的先例？—— **有 3 处，但都是显式的、会自己喊出来的**

| # | 位置 | 内容 | 我的判定 |
|---|---|---|---|
| 1 | `tools/unit_all.mjs` `EXCLUDE` | 4 条排除，其中 `test_mca_import` / `test_tile_map` 是**陈旧测试**：都 `import … from '../src/agent/library/chunk_map.js'`，而该文件**已不存在**（`ls` → No such file）。即两条测试永久必红，处理方式是"排除"而不是删/重写 | ⚠️ **藏红**。虽然写了理由，但事实是"两个测试已经死了，门禁当它不存在"。今晚任何人**不许**以这两条为由说测试全绿 |
| 2 | `tools/settings_check.mjs` §2 | `settings.companion_mode`：唯一活代码 `agent/commands/index.js:31`，从未在 spec 声明 → 恒 falsy → **62 条命令其实全对模型可见**，方案 §12 的"只给 8 条"从未生效。挂着"待用户决策" | ⚠️ 真实未修缺陷，**可见但不算失败**。每次运行都打印，这点是可信的 |
| 3 | `.githooks` 的 `SKIP_GATE=1` | 显式口子，会打印"本次提交**跳过了门禁**" | ✅ 设计合理（明处比 `--no-verify` 暗处好），但今晚会成为唯一的提交方式 |

**没有发现静默关检查（`|| true`、恒真断言、注释掉一行）的证据。** 这点是好消息。

### 3.4 `gate:full` 里的每一步"是不是真会失败"？—— **每一步都是真判据，但 3 步在本会话跑不了**

我逐个单跑（绕开短路）：

| 步骤 | 单跑结果 | 真会失败吗 | 有效性判定 |
|---|---|---|---|
| `settings_check.mjs` | **exit 0** | 会（真扫 156 模块/27 键，有实质断言） | ✅ **可信** |
| `preflight_regex_unit.mjs` | **exit 1**（2 FAIL） | 会（31 条正反样本，其中 30 条 PASS 证明判据是活的） | ⚠️ 判据可信，但**当前红因是 CRLF**（§3.5），非判据失效 |
| `preflight.mjs` | **exit 1** | 会 | ⚠️ 红因是 §6 要起子进程 → 起不来 → 自己判"审计结果不可信"（**它拒绝假绿，这点很可信**） |
| `lint_hard.mjs` | **exit 1**：`✗ lint:hard 起不来：EPERM` | 会 | ❌ **本会话完全无法验证 lint** |
| `unit_all.mjs` | **exit 1**：`0/97 个脚本通过` | 会 | ❌ **这个 0/97 是假红**，见 §3.5 |

**没有任何一步是"恒真"的。** 门禁的设计是认真的；坏的是运行环境。

### 3.5 两个环境级限制 + 一个行尾符事故（今晚一切"红"的总根因）

**限制 A：`node` 不能创建子进程（一切 spawn = EPERM）**
```
node -e "require('child_process').spawnSync(process.execPath,['-v'])"  → rc=null, err=EPERM
```
连 `node -v` 都起不来。受影响：`unit_all`（`execFileSync`）、`lint_hard`、`lint_ratchet`、`preflight` §6、`web build`（esbuild）、`log_prefix_unit`（`spawnSync`）。
**注意：`npm run X` 可以**（npm 由 bash 起，能正常传递），所以 `npm run typecheck`/`npm run lint` 是通的——**这是本会话唯一能用的调用方式**。

**限制 B：`node` 不能写 `%TEMP%`、也不能写 `mindcraft/`、`server/`（详见 §4）**
```
os.tmpdir() = C:\Users\zeh\AppData\Local\Temp\dsh-iwMtgT   → mkdir OK
C:\Users\zeh\AppData\Local\Temp\...                        → EPERM
cwd 相对写入 docs/audit/night/logs                          → writeFile/mkdir 均 OK
mkdir mindcraft/tools/.x, mindcraft/tmp/_x, mindcraft/bots/_x, src/.x → 全 EPERM
```

**事故 C：01:05:35 的 fast-forward 合并把工作区重新 checkout 成 CRLF**

- 全局 `core.autocrlf=true`，仓库**没有 `.gitattributes`**。
- `mindcraft` reflog：`01:05:17 commit` → `01:05:33 checkout main` → **`01:05:35 merge … Fast-forward`**。
- 文件 mtime 印证：`tools/preflight.mjs`、`tools/unit_all.mjs`、`src/agent/commands/index.js` 全部 = **01:05:35**。
- 现状：`src/` + `tools/` 共 **295 个文件含 CR、123 个是纯 LF**（混合，更糟）。
- 两个 FAIL 由此而来：
  - `[1/3]` 把 `\r` 当控制字符 → 1332 处 → 恒 FAIL（`preflight.mjs` 有 1333 行）。
  - `[2/3]` 的 `extractBlock` 找 `;\n`，CRLF 下是 `;\r\n` → 永远抽不出 `SAW_A_SECTION`。

**铁证（这条一定要看）**：`docs/audit/probes/r2/npm_gate.log`（今晚 **00:28** 采的同一命令）里，同一文件是**全绿**的：
```
PASS  源码里没有控制字符（0x08 退格等）  共 1333 行，干净
PASS  SAW_A_SECTION 是正则  /──\s*A·|\bA·策略|未发现"有早退分支但生产不提供"/
```
⇒ **00:28 绿 → 01:05 合并后红，代码一个字节没变。** 这是行尾符事故，不是缺陷。

---

## 4. 🔴 阻断项：`mindcraft/` 与 `server/` 对本会话只读

bash 与 node 两条路径都试过，结果一致：

```
READ-ONLY   mindcraft        touch: Permission denied   / fs 写 → EPERM
READ-ONLY   mindcraft/src    fs.writeFileSync → EPERM
READ-ONLY   mindcraft/tools  fs.mkdirSync   → EPERM
READ-ONLY   server           touch: Permission denied
WRITABLE    web / web/src / docs/audit/night / scripts / config / bugs
```

**已排除的误判**（省得别人重走弯路）：
- 不是 NTFS 权限问题。`Get-Acl` 显示 `mindcraft / server / web / docs` 四者 ACL **逐条完全相同**（都含沙箱 SID `S-1-4-…:(Write,Delete,DC)`，`AreAccessRulesProtected=False`）。用同样的 ACL，`web/` 可写、`mindcraft/` 不可写。
- ⇒ **是 DSH 会话的路径策略，不是 ACL。`icacls` 改不动，别去改。**
- 也与 git 无关：`server/` 无 `.git` 且被外层仓追踪，一样只读。

**后果**：D1 依赖 / D2 密钥 / D3 执行体 / D4 AI 的代码全在 `mindcraft/src`，**"已修复"无法落盘**；只有 D5 面板（`web/`）能真正修。已就此立即上报 captain。

---

## 5. 今晚的**真基线**（替代门禁，可直接引用）

### 5.1 单元测试真值：**89 / 97 通过，8 红，8 条全是环境所致**

`node tools/unit_all.mjs` 报 `0/97`**是假红**（harness 用 `execFileSync`，受限 A）。我改用 bash 逐个直跑（97 = 89 个 `*_unit.mjs` 去掉 4 条 EXCLUDE + 8 个 `EXTRA_OFFLINE`；4 条 `NEEDS_REAL_DATA` 按设计跳过），原始日志：`docs/audit/night/logs/unit-baseline-raw.txt`。

**8 条红项与归因（一条都不是代码缺陷）：**

| 脚本 | 报错 | 归因 |
|---|---|---|
| `log_prefix_unit` | 子进程 stdout/stderr 无 ISO 前缀 | 限制 A：测试内部 `spawnSync` 失败，断言自然不成立 |
| `path3d_tunnel_unit` | `EPERM mkdir C:\Users\…\Temp\tunnel-…` | 限制 B（%TEMP%） |
| `test_tunnel` | `EPERM mkdir …\Temp\submerged-…` | 限制 B |
| `test_climb` | `EPERM mkdir …\Temp\climb-test-…` | 限制 B |
| `test_terrain3d` | `EPERM mkdir …\Temp\t3d-test-…` | 限制 B |
| `server_props_unit` | `EPERM mkdir mindcraft\tmp\_serverprops_…` | 限制 B（mindcraft 只读，§4） |
| `strat_alloc_unit` | `EPERM mkdir tools\.tmp_mut-…` | 限制 B（同上） |
| `preflight_regex_unit` | 控制字符 / 抽不出 SAW_A_SECTION | 事故 C（CRLF） |

**反向验证**：抽 3 条"失败"的脚本独立直跑均 `exit 0`（`test_codes` 5 PASS/0 FAIL、`strat_cycles_unit` 11 passed/0 failed、`task_pickup_unit` 4/4）——证明 harness 的 0/97 与这些脚本本身无关。

### 5.2 lint 真值：`npm run lint` → **197 errors，exit 1（存量）**

```
✖ 197 problems (197 errors, 0 warnings)   101 个可 --fix
semi 101 | require-await 78 | no-empty 8 | no-irregular-whitespace 4
no-prototype-builtins 2 | no-ex-assign 1 | no-fallthrough 1 | no-useless-escape 1 | no-dupe-keys 1
```
**`no-undef = 0`、`no-floating-promise = 0`**（这两项真的干净，可用）。
存量佐证：`docs/audit/probes/r2/eslint_summary.txt`（00:28）也是 `total=197 / no-undef=0` ⇒ **197 不是今晚引入的**。
`lint_hard.mjs` / `lint_ratchet.mjs` 起不来（限制 A）⇒ **提交级 lint 门禁本会话无法验证**。

### 5.3 今晚唯一可执行的"通过"判据（建议 captain 采纳）

1. `cd web && npm run typecheck` → 必须 `exit 0`。（唯一硬绿）
2. 逐脚本单元基线：`89/97`，**红项集合必须与 §5.1 的 8 条完全一致**（多一条 = 真回归；这 8 条内有变化也要查）。
3. `npm run lint` → 仍是 `197 errors`，且**目标文件不新增** error；`no-undef` 保持 0。
4. **永不用**：`npm run gate:full`（恒红）、`npm run build`（EPERM）、`node tools/unit_all.mjs`（假红）、`lint_hard`（起不来）。
5. 任何"修复完成"的声明必须附**两仓 commit**（`mindcraft` + 外层审计仓），见 §2。

---

## 6. 结论：哪些检查可信，哪些形同虚设

### ✅ 可信（可以拿它下判断）

| 检查 | 为什么可信 |
|---|---|
| `web && npm run typecheck` | 唯一实跑绿，`vue-tsc` 真做类型检查，无护栏 |
| `npm run lint`（197 存量） | 数字与 00:28 探针逐项吻合；`no-undef/no-floating = 0` 是真结论 |
| `settings_check.mjs` | 真扫 156 模块 / 27 键，零漏声明；且**拒绝静默变绿**（例外每次都打印） |
| `preflight.mjs` 的 §1–§5、§7 | 判据真、有样本自证；§6 起不来时**它自己判"不可信"而不是放过**——这是最值得信的一种设计 |
| `preflight_regex_unit.mjs` 的 31 条样本 | 30 条 PASS 证明扫描器**看得见**（这正是防"0 处 = 干净"假绿的关键） |
| 逐脚本 unit 基线（bash 直跑） | 89/97 真值，可复现，日志已存 |

### ❌ 形同虚设（今晚不能当证据）

| 检查 | 问题 |
|---|---|
| **`npm run gate:full`** | **恒红**（CRLF），且 `&&` 短路让后 3 步从不执行。它的绿永远拿不到、它的红不含信息 |
| **`.githooks/pre-commit` `/pre-push`** | 装了、会拦，但门禁恒红 ⇒ 只能 `SKIP_GATE=1` ⇒ 实质**每一次都绕过** |
| **外层审计仓的钩子** | **完全没有**（`core.hooksPath` 未设、无 `.githooks`） |
| **`lint_hard.mjs` / `lint_ratchet.mjs`** | EPERM 起不来；所谓"提交级 lint 护栏"本会话**一次都没跑过** |
| **`unit_all.mjs`** | 本会话 `0/97` 是**假红**，若有人照抄会得出"测试全崩"的错误结论 |
| **`web && npm run build`** | esbuild 起不来；`dist/` 停在 Oct 30。**没有 build 通过的证据** |
| **`unit_all` 的 EXCLUDE 里那 2 条** | `test_mca_import`/`test_tile_map` import 已删除的 `chunk_map.js`，永久必红，被排除=当它不存在（**藏红**） |
| **`preflight` §6 依赖注入审计** | 起不来 ⇒ 该段"0 处违规"**没有意义**（幸好它自己这么判） |

### ⚠️ 可信但需人盯着的

- `settings.companion_mode`：**真缺陷**（62 条命令实际全可见），被登记为例外、不算失败。今晚若有人宣布"命令可见性已修"，先查这条。
- 工作区 **295 CRLF / 123 LF 混合**：建议今晚别去"顺手统一行尾"，那会制造一个 400 文件的巨型 diff，把真修复埋掉。若一定要修，先加 `.gitattributes` 再单独一笔提交（**属另行决策，不在本基线范围**）。

---

## 7. 给后续每轮的一句话提醒

> **本机 `gate:full` 恒红是行尾符 + 沙箱限制，不是你的错，也不许拿来当"没引入问题"的证明。**
> 要证明没引入问题，用 §5.3 的四条；要修 `mindcraft/src`，先解决 §4 的只读阻断。

---

_附：原始证据 —— `docs/audit/night/logs/unit-baseline-raw.txt`（97 个脚本逐条输出）、`docs/audit/probes/r2/npm_gate.log`（00:28 全绿对照）、`docs/audit/probes/r2/eslint_summary.txt`（lint 存量 197）。_

---

# ⚠️ 更正（R0.6，2026-11-06 01:5x）—— 本文 §4、§5、§7 已作废，以本节为准

> 保留上面全文是为了留痕：**不许事后篡改基线**。但环境变了，结论必须跟着变。
> 以下每一条都注明"谁改的、我实测到了什么、哪条旧结论失效"。

## 变更 1：CRLF 根因已除 ⇒ §1.1 的两个 FAIL 不再是基线

captain 执行 `git config --local core.autocrlf false` + `core.eol lf`，并把 421 个被转坏的文件
重新按 LF 落盘。**我独立复测（不是转述）**：

```
core.autocrlf = false / core.eol = lf                        ✅
tools/preflight.mjs 的 CR 字节数：1332 → 0                    ✅
node tools/preflight_regex_unit.mjs → ✓ 全绿：37 通过，0 失败，exit 0   ✅（原 2 FAIL 消失）
```

⇒ **§1.1 的"2 FAIL"作废。** 那两条从来不是代码缺陷（这点原判断正确），
现在连"环境红"也不是了。captain 对机制的解释比我准：**blob 一直是纯 LF，
是本地 `autocrlf=true` 每次检出时把磁盘转成 CRLF** —— 我原 §3.5 写的"01:05 合并把工作区
重启 checkout 成 CRLF"是**现象描述正确、根因归因不完整**（真正的病根是 autocrlf 配置）。

## 变更 2：captain 会话的门禁真值（我无法复现，故**引用而非主张**）

captain 实测并交由我裁决的基线：

```
cd mindcraft && npm run gate:full → exit 0
  settings_check ✅ / preflight_regex_unit ✅ 37通过0失败 / preflight ✅（含 §6）
  lint_hard ✅ no-undef=0 no-floating-promise=0（扫 167 文件）/ unit_all ✅ 96/97，4 个真跳过
cd web && npm run typecheck → exit 0
```

**证据等级说明（必须诚实）**：这些数字**我这边跑不出来**——我的会话
`spawnSync(node,-v)` 仍返回 `EPERM`，故 `lint_hard`/`unit_all`/`preflight §6` 在我这边
一律起不来。我**没有**独立复现 96/97 或 lint_hard 绿。
裁决依据 = captain 提供的原始输出 + 与我实测不冲突的部分（`preflight_regex_unit` 37绿我已自证）。
**若之后有人发现 gate:full 与上表不符，以上表为"待复核"而非"已确证"。**

## 变更 3：`gate:full` 恢复为有效判据 ⇒ §5.3 那套"等价基线"**作废**

- ❌ 作废：§5.1 的 **89/97**（含我那 8 条红项清单）——那是**我的会话**的产物，前提是
  "本机起不了子进程"，该前提在 captain 会话不成立。**我的 0/97/89/97 全部作废，以 96/97 为准。**
- ❌ 作废：§5.3 的四条替代判据（不必再执行）。
- ✅ 恢复原版判据（PLAYBOOK §4）：**`gate:full` 绿 + `web typecheck` 绿 + `lint 197 存量不新增`**。
- ✅ 仍然有效的观察：`web build` 在我会话 `spawn EPERM`，`dist/` 停在 Oct 30 ⇒
  **build 是否绿需 captain 侧给出结论**，别引用我这条当"build 已知坏"。

## 变更 4：§4「mindcraft 只读」已解除 —— 但**我的会话仍只读**（分工已改）

- 用户 01:17 把策略改为 `danger-full-access`；captain 会话实测可写。
- **我的会话仍 `READ-ONLY mindcraft / src / tools / server`**（我复测过），原因是
  **我的权限在 01:14 派生时固定，会话内不可放宽**（本会话审批被禁用）。
- ⇒ captain 已裁决（2026-11-06）：**不重启我**，改为
  **captain = 唯一执行者（跑 gate / commit / 删文件）；gate-keeper = 唯一判决者
  （读 diff、读代码、跑不依赖子进程的检查、给通过或打回）**。
- ⇒ **§4 的"全队阻断"结论作废**（那是针对"没人能写"的时点）；现为"只有 captain 能写"。

## 变更 5：审计链已补建（§2 的仓库边界问题已解）

captain 在 **mindcraft 仓内**建了同名分支 `audit/night-20261106`（我从仓内
`git rev-parse --abbrev-ref HEAD` 复测确认 ✅）。新规范：**任何"已修复"必须双仓 commit**，
`## review` 段写明两个仓的 sha。⇒ **§2 的"审计链断在仓库边界"已修，作为历史记录保留。**

## 不变的部分（仍然有效，继续用）

| 结论 | 状态 |
|---|---|
| `npm run lint` = **197 errors 是存量**（与 00:28 探针一致），非今晚引入 | ✅ 有效 |
| `no-undef = 0`、`no-floating-promise = 0` | ✅ 有效，可作判据 |
| lint 规则**无放宽先例**（3 次提交、7 条规则一致、两次改动均为收紧） | ✅ 有效 |
| `curly`/`no-unused-vars`/`no-unreachable` **自始 off** ⇒ lint 覆盖面薄 | ✅ 有效（已开单 `F-GATE-003`） |
| `.githooks` 装了、真会拦；但**门禁红时只能 `SKIP_GATE=1`** ⇒ 实质被绕过 | ✅ 机制有效；**门禁已修好，现在应能真拦**（需 captain 侧复验 `sh .githooks/pre-commit` 是否 exit 0；我这边因 preflight §6 起不来仍 exit 1） |
| `settings.companion_mode` 62→实测 **8 条白名单 vs 64 条注册**、白名单从未生效 | ✅ 有效（已开单 `F-GATE-001`，captain 已批准） |
| `unit_all` 的 `EXCLUDE` 藏了 2 个死测试（import 已删模块） | ✅ 有效（已开单 `F-GATE-002`） |
| 外层审计仓**没有钩子**，且不追踪 `mindcraft/` | ✅ 有效（现由"双仓 commit"规范兜住） |

## 新增提醒（本轮实测，供全队）

`git -C mindcraft status` 仍报 **421 个 `M`**（captain 说已 `git reset` 清掉，我这边**复测仍在**）。
`git diff` 为空、porcelain v2 两侧 **blob sha 相同** ⇒ 纯 stat 缓存，**内容零变化**。
⇒ 提交一律**逐文件显式 `git add <file>`**（禁 `-A`）；要判"树干净"请用
`git diff --quiet && git diff --cached --quiet`（内容判据），**不要信 `git status` 的 stat 结果**。

---

**一句话总结更正后的基线**：
**门禁已修好、判据回到原版（gate:full 绿 + typecheck 绿 + lint 197 不新增）；
我这边跑不了子进程类检查，故由 captain 出原始输出、我据此裁决；
我的 0/97 与 89/97 全部作废，不得再被引用。**
