# R5-001 / R5-002 修复记录：面板 BOM、.bat 退出码透传、acl-regression 误红

> 日期：2026-11-08 19:00–19:50 (+08:00) · 主机：Windows 11 / **PowerShell 5.1.26100.9711** / ANSI 代码页 **gb2312 (936)** / node v24.16.0
> 工作目录：`E:\我的世界ai`
> 证据目录：[`docs/audit-r5/evidence/fix/`](../evidence/fix/)

## 0. 一句话

`start-panel.ps1` 补回 **UTF-8 BOM**（正文零改动）后 PS 5.1 解析报错 **8 → 0**，真实入口 `启动面板.bat` 不再刷 ParserError、且能进入脚本主体；两个 `.bat` 的退出码改成**失败透传**（实测 9 → 9、2 → 2，旧版一律 0）；`acl-regression.mjs` 不再把运行时产物 `token` 当仓库不变量（**exit 1 → exit 0**，多打一条 SKIP）。

---

## 1. R5-001 一：`scripts/start-panel.ps1` 补 UTF-8 BOM

### 改法（只加 3 字节，正文一个字节没动）

```bash
# 原字节（15706）前面拼上 EF BB BF，其余原样
printf '\xef\xbb\xbf' > tmp/sp-with-bom.tmp
cat scripts/start-panel.ps1 >> tmp/sp-with-bom.tmp
cp tmp/sp-with-bom.tmp scripts/start-panel.ps1
```

### 前后 ParseFile（**实测输出**，非推断）

```
$ powershell -File tmp/r5-fix/measure-prefix.ps1
[tmp/r5-fix/start-panel.ps1.orig] bytes=15706 head=23 20 4D (no BOM) ERRORS=8
    line 73 col 17 : Array index expression is missing or not valid.
    line 92 col 43 : Missing type name after '['.
    line 152 col 46 : Array index expression is missing or not valid.
    line 306 col 39 : The string is missing the terminator: '.
    line 81 col 35 : Missing closing '}' in statement block or type definition.
    line 78 col 65 : Missing closing '}' in statement block or type definition.
    line 66 col 35 : Missing closing '}' in statement block or type definition.
    line 64 col 63 : Missing closing '}' in statement block or type definition.
[scripts/start-panel.ps1] bytes=15709 head=EF BB BF (BOM) ERRORS=0
```

### 「正文零改动」怎么证的

| 检查 | 结果 |
|---|---|
| 文件大小 | 15706 → **15709**（+3，正好一个 BOM） |
| 去掉前 3 字节后 sha256 | `744b097b…07bf2b0` = **改前工作区副本** `tmp/r5-fix/start-panel.ps1.orig` 的 sha256（完全相同） |
| `git diff --stat` | `1 file changed, 1 insertion(+), 1 deletion(-)` |
| `git diff --numstat` | `1	1` |
| `git diff -w` | 只有首行 `-# …` → `+﻿# …`（BOM 不算空白，`-w` 也照显，属预期） |

> 口径说明（易踩）：仓库 blob 存的是 **LF**，工作区因 `core.autocrlf` 是 **CRLF**，所以「`git show HEAD:…` 的字节」和「工作区字节」天生不同 —— 正文一致性只能拿**改前工作区副本**对**改后工作区文件**比（上表第 2 行）。

---

## 2. R5-001 二：两个 `.bat` 的退出码透传

### 改法（两个文件同一段尾巴）

```diff
 powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-panel.ps1"
-if errorlevel 1 pause
-exit /b 0
+if not errorlevel 1 exit /b 0
+set "RC=%errorlevel%"
+pause
+exit /b %RC%
```

### 为什么不用 `if errorlevel 1 ( ... exit /b %errorlevel% )`

cmd 会在**进入括号块之前**就把 `%errorlevel%` 展开，块内拿到的是旧值 —— 任务里点名的那个陷阱。这里改成：

- 成功路径：`if not errorlevel 1 exit /b 0` 直接出 0（不 pause、不改行为）；
- 失败路径：`set "RC=%errorlevel%"` 在**块外**执行（展开时就是当前退出码），再 `pause`，再 `exit /b %RC%`。
- 因此**不需要** `enabledelayedexpansion`，`setlocal` 保持原样，最小改动。

`停止面板.bat` 同样处理（只把 `start-panel` 换成 `stop-panel`、title 保持 `Stop`）。

### 验收实测

| 测试 | 命令 | 结果 | 说明 |
|---|---|---|---|
| **A 真实入口 + dry-run** | `printf "\n\n" \| cmd.exe /c "启动面板.bat"` | **BAT_EXITCODE=0**，输出 `Minecraft AI 陪玩面板   一键启动` + `[DRYRUN] 已进入脚本主体…`，**无任何 ParserError** | 见下方"dry-run 用的哪种" |
| **B 故意失败** | 同上（脚本里临时 `exit 9`） | **BAT_EXITCODE=9** | 旧版这里必然是 0 ⇒ 透传生效 |
| **C 停止面板.bat 真跑** | `printf "\n\n" \| cmd.exe /c "停止面板.bat"` | BAT_EXITCODE=**0**（但脚本明确"未完成"） | **原因不在 .bat**，见 §4 的独立发现 |
| **D 停止面板尾部探针** | 复制 `.bat` 只把 `-File` 指向 `exit 2` 的探针 | **PROBE_BAT_EXITCODE=2** | 同一段尾巴在 Stop 上也有效 |
| **E 意外收获** | 探针脚本本身写成 no-BOM 中文 → ParserError | **1** | 连"解析失败"这类错现在也不会被吞 |

### dry-run 用的是哪种（任务要求说明）

**临时把起服那步换成 echo 的变体**：在 `scripts/start-panel.ps1` 的三行前置检查（java / node / server.jar）之后、`Write-Step '0/4'` 之前，临时插入两行：

```powershell
Write-Host '[DRYRUN] 已进入脚本主体（起服步骤被临时替换为 echo）' -ForegroundColor Yellow
exit 0
```

跑完 `cmd /c "启动面板.bat"` 后**立即从备份还原**，最终 `sha256 = 9850d3c5…e07f0`，与「只加 BOM」的版本逐字节一致；`tail -c +4` 的正文 sha256 仍等于改前 `744b097b…`（见 §1 表）。

**为什么没做"真起面板"的端到端**：这条路会 `Start-Process java` 起**生产服**（25565、加载 `server/world`）并起 mindserver（8080）。本任务只授权改 BOM 与 .bat 退出码，起生产服会写 `server/` 存档目录，超出授权且不可逆 —— 故采用任务明确允许的 dry-run 变体。**若要端到端验证**，建议在允许起服的窗口里由人守着跑一次 `启动面板.bat`，确认浏览器弹面板 + 25565/8080 起来后，用 `停止面板.bat` 收尾。

---

## 3. R5-002：`acl-regression.mjs` 不再把运行时产物当仓库不变量

### 改法

`.mindserver-token` 由 mindserver **启动时**写到自己的 cwd（`mindserver.js`），已进 `.gitignore`、未被 git 跟踪 —— 干净 clone / CI 本来就没有它。原断言 `A mindcraft\.mindserver-token 存在` 要求它必须存在 ⇒ 必红。

改成：**不存在 → SKIP 并打印原因；存在 → 照旧校验 DACL**。

```diff
-for (const a of acls || []) {
-  check(`A ${a.rel} 存在`, a.missing !== true)
-  if (a.missing) continue
+const RUNTIME_ARTIFACTS = new Set(['mindcraft\\.mindserver-token'])
+
+for (const a of acls || []) {
+  if (a.missing === true) {
+    if (RUNTIME_ARTIFACTS.has(a.rel)) {
+      skipCheck(`A ${a.rel} 存在`, '→ 跳过：token 由 mindserver 启动时生成，干净仓库本不该存在')
+    } else {
+      check(`A ${a.rel} 存在`, false)
+    }
+    continue
+  }
+  check(`A ${a.rel} 存在`, true)
   check(`A ${a.rel} DACL 已断开继承`, …)
   check(`A ${a.rel} 没有 Users/Authenticated Users 之类过宽主体`, …)
   check(`A ${a.rel} 仍留有 ACE（没把自己锁死）`, …)
 }
```

配套：新增 `skip` 计数器与 `skipCheck()`；汇总行追加 skipped 计数（**退出码仍只由 fail 决定**）；文件头补一段 R5-002 说明。**其余 18 条断言一字未动**（`git diff` 可查）。

### 验收实测

```
$ node scripts/tests/acl-regression.mjs
PASS A 能读到 ACL 现状 → status=0 stderr=
PASS A ACL 探测返回了三个目标 → [{"rel":"mindcraft\\.mindserver-token","missing":true}, …]
SKIP A mindcraft\.mindserver-token 存在 → 跳过：token 由 mindserver 启动时生成，干净仓库本不该存在
PASS A mindcraft\keys.json 存在
PASS A mindcraft\keys.json DACL 已断开继承 → protected=true
PASS A mindcraft\keys.json 没有 Users/Authenticated Users 之类过宽主体 → []
PASS A mindcraft\keys.json 仍留有 ACE（没把自己锁死） → rules=3
PASS A server\server.properties 存在
PASS A server\server.properties DACL 已断开继承 → protected=true
PASS A server\server.properties 没有 Users/Authenticated Users 之类过宽主体 → []
PASS A server\server.properties 仍留有 ACE（没把自己锁死） → rules=3
PASS B 加固脚本存在
PASS B 脚本默认只体检（-Apply 才改）
PASS B 脚本用 SetAccessRuleProtection 断开继承
PASS B 脚本只放行 当前账户/SYSTEM/Administrators
PASS B 脚本带应用可用性自检（可读可写）
PASS B 脚本给出回滚方式
PASS B 脚本带 UTF-8 BOM（PowerShell 5.1 才不乱码） → ef bb bf
PASS B 脚本语法可解析 → OK

ALL PASS: 18 passed, 0 failed, 1 skipped（运行时产物：干净仓库不该有，不计红）
EXIT=0
```

改前（HEAD 版本）同一命令：`HAS FAILURES: 18 passed, 1 failed` / `FAIL A mindcraft\.mindserver-token 存在` / **exit 1**。

### 两种状态都实测过（SKIP 只针对"干净仓库本不该有"这一种情形）

| 状态 | 结果 | 说明 |
|---|---|---|
| ① token **不存在**（干净 clone / CI） | `ALL PASS: 18 passed, 0 failed, 1 skipped`，`EXIT=0` | 本次新增的 SKIP 分支；打印「跳过：token 由 mindserver 启动时生成，干净仓库本不该存在」 |
| ② token **存在**但 DACL 未收口 | `HAS FAILURES: 20 passed, 2 failed`，`EXIT=1` | "存在 → 照旧校验 ACL"这条**完整保留**：`protected=false` + `Authenticated Users:ReadAndExecute` 是真问题，不是误红 |

实测②是怎么出现的：19:44 有一个**并行成员**的跑批在工作区留下了 `mindcraft/.mindserver-token`（16B，无进程占用、无监听），脚本于是走"存在"分支并如实报红 —— 这正好证明 R5-002 没有把校验改松，只是修掉了"没有也算错"这一种。
为了在①状态下取证，我把该残留 token 临时移出约 2 秒、运行后**原样放回**（sha256 前后均为 `5d41757a…b325bf`，未删未改）。

> **给 captain 的提示**：验收「`acl-regression` exit 0」的前提是**当前没有残留 token**。若复核时看到 exit 1 且报的是 token 的 DACL，那不是回归，而是环境里有个活得太久的 token（顺手跑一次 `powershell -File scripts\harden-credentials-acl.ps1 -Apply` 即可，或把它停服后删掉）。

---

## 4. 一个**独立发现**（不在本任务改动范围内，留给 captain 定）

**`scripts/stop-panel.ps1` 不把自己的失败码传给进程退出码。** 该脚本对 `stop-all.mjs` 的 2（NO_TOKEN）/ 3（AUTH_REJECTED）/ 4（STOP_FAILED）只做打印，**从头到尾没有 `exit $stopCode`**（全文只有第 14/15 行的 `exit 1`），最后一行是 `Read-Host '按回车关闭'` ⇒ PowerShell 进程退出码恒为 **0**。

后果：即使 `停止面板.bat` 已经正确透传，用户/计划任务看到的仍是 0 —— 实测测试 C 就是这个现象（脚本打印"未完成…服务器仍在运行"，而 `BAT_EXITCODE=0`）。

这是 R5-001 二阶缺陷的**更上游一环**，与 `ops-regression.mjs` 里"OPS-002 有独立退出码 4"的叙述也对不上（4 是 `stop-all.mjs` 的码，没被 .ps1 转出去）。修法很小（末尾 `exit $stopCode`），但本次授权只到"两个 .bat 只改退出码透传"，故**未改**，只报告。

---

## 5. 改动面（本任务只碰这 4 个文件）

```
$ git diff --numstat -- scripts/start-panel.ps1 scripts/tests/acl-regression.mjs 启动面板.bat 停止面板.bat
1	1	scripts/start-panel.ps1          ← 只有首行（BOM）
25	4	scripts/tests/acl-regression.mjs ← token 分支 + 汇总行 + 文件头说明
4	2	启动面板.bat                      ← 只有退出码分支
4	2	停止面板.bat                      ← 只有退出码分支
```

未引入任何新依赖（只用 node 内置模块与 cmd 内建命令）；未改 `server/`、`server-test/`、`backups/`。

> ⚠️ **并发提醒**：本轮同一工作树里有其它成员在并行改文件（我观测到 `.gitattributes` 被新增并暂存、`scripts/harden-credentials-acl.ps1`、`README.md`、新增 `scripts/clone-all.ps1`）。期间我对 `scripts/tests/acl-regression.mjs` 的第一次修改**曾被外部还原**（文件回到 HEAD 内容），已重做并当场验证。合并/提交时请留意这几个文件的最终状态以谁为准。

## 6. 验收对照表（任务 verify 三条）

| 验收项 | 结果 | 证据 |
|---|---|---|
| `ParseFile('scripts/start-panel.ps1')` → ERRORS=0 | ✅ **0**（改前 8） | `evidence/fix/01-parsefile-before-after.txt` |
| `node scripts/tests/acl-regression.mjs` → exit 0 且能看到 SKIP | ✅ **EXIT=0**，`ALL PASS: 18 passed, 0 failed, 1 skipped` | `evidence/fix/03-acl-regression.txt` |
| `.bat` 失败时返回非 0 | ✅ **9 → 9**（Start，故意失败）、**2 → 2**（Stop 尾部探针）、**1 → 1**（ParserError 路径） | `evidence/fix/02-bat-exit-code.txt` |
