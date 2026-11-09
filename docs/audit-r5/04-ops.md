# 04 · 运维脚本与备份恢复链路 实测（R5 · 第五轮实测型验证）

> 原则：**只记录能跑出来的东西**。每条 = 结论 ｜ 命令（原文） ｜ 真实输出摘录 ｜ 判定 ｜ 证据文件。
> 判定口径：`CONFIRMED` = 缺陷成立（有实测证据）｜`PASS` = 脚本/断言通过 ｜ `CANNOT-RUN` = 本轮约束下不可执行，并说明原因。
>
> **本轮硬约束（全程遵守）**：不起 Minecraft 服务器（游戏内实测由 mc-live-runner 独占 25566/25576）；不改 `server/`、`server-test/` 存档；临时写盘只用 `tmp/r5-ops/`。

## 1. 实测环境（一次性锚定）

| 项 | 值 | 取证方式 |
|---|---|---|
| 日期 | 2026-11-08 14:52–15:50 (+08:00) | 各证据文件末尾时间戳 |
| 工作目录 | `E:\我的世界ai` | — |
| node | v24.16.0 | `node --version` |
| PowerShell | **5.1.26100.9711**（本机无 pwsh，所有 .ps1 均用 `powershell -NoProfile -ExecutionPolicy Bypass -File`） | `$PSVersionTable.PSVersion` |
| 系统 ANSI 代码页 | **gb2312 / CodePage 936**（第 6 条的关键前提） | `[System.Text.Encoding]::Default.CodePage` |
| 父仓 HEAD | `92d405caca6ef74bb3caa5f15d6e16782348f553` | `git rev-parse HEAD` |
| mindcraft HEAD | `33b432703ccf2a4b8c2b47f3cbc44825defed602` | `git rev-parse HEAD`（`mindcraft/`） |
| 工作树 | 干净（父仓仅多出本轮新增的未跟踪 `docs/audit-r5/`；mindcraft 无改动） | `git status --porcelain` |
| 服务器进程 | **全程 0 个 java 进程**；25565/25566/25567/25576/25599 全程空闲 | `Get-Process java`／`Get-NetTCPConnection -State Listen` |
| 真实备份 | `backups/world-20261108-*` 共 **7** 个（均含 manifest.json） | `ls -d backups/world-20261108-*` |

## 2. 总表

| # | 项 | 命令（原文） | 退出码 | 判定 | 一句话结论 | 证据 |
|---|---|---|---|---|---|---|
| 1 | 运维回归 | `node scripts/tests/ops-regression.mjs` | 0 | **PASS** | 29/29 全过 | `evidence/ops/ops-regression.out.txt` |
| 2 | ACL 回归 | `node scripts/tests/acl-regression.mjs` | **1** | **CONFIRMED** | 18 过 1 红，红在 `.mindserver-token 存在`；该文件只在 mindserver 启动时生成 ⇒ 断言与运行状态耦合，干净仓库上必红 | `evidence/ops/acl-regression.out.txt`、`acl-token-lifecycle.txt` |
| 2b | ACL 现状复验 | `powershell -File scripts/harden-credentials-acl.ps1`（默认只体检） | 0 | **PASS** | 两个真实存在的凭据文件确已收口（非继承、3 条 ACE、无过宽主体） | `evidence/ops/harden-dryrun.out.txt` |
| 3 | RCON 协议回归 | `powershell -File scripts/tests/rcon-regression.ps1` | 0 | **PASS** | 7/7 全过；假服自动选 25599（回环），跑完即退，无残留监听 | `evidence/ops/rcon-regression.out.txt` |
| 4a | 备份可验证 | `powershell -File scripts/verify-world-backup.ps1 -BackupDir backups/world-20261108-131023`（7 个备份全跑） | 0 ×7 | **PASS** | 7/7 备份各 137 条断言全过 | `evidence/ops/verify-world-*.txt` |
| 4b | 验证器反向对照 | 同上，但把 world.zip 截掉 1000 字节后再验 | **1** | **PASS** | 4 条 FAIL（字节/哈希/可打开/组件），证明**不是假绿灯** | `evidence/ops/verify-bad.out.txt` |
| 4c | 恢复演练预检 | `powershell -File scripts/restore-drill.ps1 -BackupDir <坏目录\|旧 schema\|端口占用>` | 1/1/1 | **PASS**（预检） | 三个前置分支都能在**起服前**拦下并明确报错；同命令两次输出逐字节相同 | `evidence/ops/drill-t1/t1b/t2/t3.out.txt` |
| 4d | 恢复演练**完整**跑 | `powershell -File scripts/restore-drill.ps1 -BackupDir backups/world-20261108-131023` | — | **CANNOT-RUN** | 该脚本**没有** `-WhatIf`/`-Precheck` 开关，完整演练必然在 25567/25568 起一台真 MC 服 ⇒ 越过本任务红线 | — |
| 5 | e2e 前提静态核对 | 见 §5 各命令 | — | **PASS**（可跑） | jdk21/server.jar/server-test/test-template/两个 mjs 全在；junction 免管理员可用；PS5.1 语法 0 错 | `evidence/ops/e2e-static-prereq.txt` |
| 6 | 面板 .bat 链路 | `cmd /c "启动面板.bat"`（真实入口）+ `powershell -File scripts\start-panel.ps1` | **0**（.bat 恒 0；ps1 实测 1） | **CONFIRMED（高危，af4aa22 引入的回归）** | `af4aa22` 删掉 BOM（回归，非长期存在）⇒ 真实入口双击后刷 8 段 ParserError 停在 pause，面板不弹；`.bat` 恒 exit 0 | `evidence/ops/bat-real-entry.txt`、`ops6-regression-attribution.txt`、`ops6-no-side-effect.txt`、`bom-fix-control.txt` |

**一句话给 captain**：备份与恢复链路是**真的**（可验证 + 反向对照会红）；运维/RCON 回归通过；**两条真缺陷**：①`acl-regression.mjs` 在干净仓库上必红（与运行状态耦合）；②`scripts/start-panel.ps1` 缺 BOM，PS 5.1 下无法解析 ⇒「启动面板.bat」起不来 —— 且 ① 是 ② 的下游症状（面板起不来 ⇒ token 从不生成）。

---

## 3. 逐条实测

### OPS-1 运维回归 —— PASS

**命令**

```powershell
cd E:\\我的世界ai
node scripts/tests/ops-regression.mjs
```

**真实输出摘录**（首尾）

```
PASS OPS-001 找到 $panelUrl 赋值行 → $panelUrl = "${panel}?token=$tok"
PASS OPS-001 旧写法确实产出坏的 URL（说明这条断言有效） → "=TOK123"
...
PASS OPS-002 stop-panel.ps1 处理退出码 4
PASS OPS-002 stop-panel.ps1 明确"管理端仍在运行"

ALL PASS: 29 passed, 0 failed
```

**判定**：PASS（退出码 0，29 通过 0 失败，无失败断言可摘）
**证据**：`docs/audit-r5/evidence/ops/ops-regression.out.txt`

---

### OPS-2 ACL 回归 —— **CONFIRMED（缺陷成立）**

**命令**

```powershell
node scripts/tests/acl-regression.mjs
```

**真实输出摘录**（全文关键行）

```
PASS A ACL 探测返回了三个目标 → [{"rel":"mindcraft\\.mindserver-token","missing":true}, ...]
FAIL A mindcraft\.mindserver-token 存在
PASS A mindcraft\keys.json 存在
PASS A mindcraft\keys.json DACL 已断开继承 → protected=true
PASS A mindcraft\keys.json 没有 Users/Authenticated Users 之类过宽主体 → []
PASS A mindcraft\keys.json 仍留有 ACE（没把自己锁死） → rules=3
PASS A server\server.properties DACL 已断开继承 → protected=true
PASS A server\server.properties 没有 Users/Authenticated Users 之类过宽主体 → []
PASS A server\server.properties 仍留有 ACE（没把自己锁死） → rules=3
...
HAS FAILURES: 18 passed, 1 failed
```

退出码 **1**。失败断言原文：`FAIL A mindcraft\.mindserver-token 存在`（detail 为空）。

**为什么这是缺陷（而不是"文件真该在、安全出问题"）**：该文件是 `mindserver` **启动时**写到自身 cwd 的运行期凭据，仓库里既没有也不需要它。

```
$ ls -a mindcraft | grep -i token
（无匹配）
$ grep -n "mindserver-token" mindcraft/.gitignore .gitignore
mindcraft/.gitignore:96:.mindserver-token
.gitignore:132:.mindserver-token
$ git ls-files --error-unmatch mindcraft/.mindserver-token
error: pathspec 'mindcraft/.mindserver-token' did not match any file(s) known to git
$ sed -n '386,396p' mindcraft/src/mindcraft/mindserver.js
    const TOKEN_FILE = path.join(process.cwd(), '.mindserver-token');
    try {
        writeFileSync(TOKEN_FILE, handshakeToken, { encoding: 'utf8', mode: 0o600 });
```

⇒ 断言把"运行时状态"当成了"仓库不变量"：面板没在跑（干净 clone、CI、任何未起服的机器）时，这条**必然红**，于是这个回归脚本**无法作为门禁使用**（它给出的红与凭据安全无关）。修法二选一：把缺失当作 `SKIP`（打印原因），或先断言"面板在跑"再断言 ACL。

**同轮的正向证据（收口本身是真的）**：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/harden-credentials-acl.ps1
```
```
[跳过] 不存在：mindcraft\.mindserver-token
--- E:\\我的世界ai\\mindcraft\\keys.json
  DACL: 非继承（已收口）
  ok NT AUTHORITY\SYSTEM | FullControl | Allow | 继承=False
  ok BUILTIN\Administrators | FullControl | Allow | 继承=False
  ok LAPTOP-GDE992NS\zeh | FullControl | Allow | 继承=False
--- E:\\我的世界ai\\server\\server.properties
  DACL: 非继承（已收口）
  ...（同上三条）
[体检结果] 已经是收口状态，无需改动。      ← 退出码 0
```

即：加固脚本**能优雅跳过缺失文件**（`[跳过] 不存在`），而回归脚本不能 —— 两者口径不一致，进一步说明红的是回归脚本。

**判定**：**CONFIRMED**
**证据**：`evidence/ops/acl-regression.out.txt`、`evidence/ops/acl-token-lifecycle.txt`、`evidence/ops/harden-dryrun.out.txt`

---

### OPS-3 RCON 协议回归 —— PASS

**命令**（脚本自行拉起假服，无需手工预备）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/tests/rcon-regression.ps1
```

**真实输出**（全文）

```
PASS 假 RCON 服务器已启动 127.0.0.1:25599
PASS ①正确密码+命令 ⇒ 成功并拿到应答 ok=True body=Handled: save-all flush err=
PASS ②错误密码 ⇒ 判失败（不能被当成成功） ok=False err=RCON 认证失败（服务端回 id=-1：密码不对，或把命令当密码发了）
PASS ③反向：auth 正文写成命令 ⇒ 必须失败（老 bug 的写法） ok=False err=RCON 认证失败（...）
PASS ④假服务器收到的 auth 正文是密码（说明协议对） auth 正文样本：regress-pass / wrong-password / save-all flush
PASS ⑤用例③里 auth 正文确实是命令（证明这条反例真的走到了错误分支） 共收到 3 个 auth 包
PASS ⑥端口没人监听 ⇒ 快速判失败（不卡死） ok=False err=连接超时：127.0.0.1:1

ALL PASS：7 项通过（RCON 协议回归）
证据：E:\我的世界ai\tmp\rcon-regression.log
```

退出码 **0**。

**关于"假服是否占端口"**（任务点名要说明）：

- 端口不是固定 25599：脚本在 `25599..25620` 里按 `Test-PortFree` 挑第一个空闲口（本次抽到 25599），可用 `-Port` 指定。
- 只绑 **127.0.0.1**（回环），不对外监听；`MaxConnections=8`、`TimeoutSec=90` 兜底自杀。
- 跑完立即退出。实测收尾后：`Get-NetTCPConnection -State Listen | ? LocalPort -in 25566,25576,25599,25600,25601` → **空**，无残留监听、无残留 powershell 子进程。
- 副作用：脚本按设计写 `tmp/rcon-regression.log`（仓库 `tmp/`，不是 `tmp/r5-ops/`）；这是脚本自身行为，未改任何存档。

**判定**：PASS
**证据**：`evidence/ops/rcon-regression.out.txt`

---

### OPS-4a 备份可验证 —— PASS（7/7 备份）

**命令**（对 `backups/` 下全部 7 个 `world-20261108-*` 逐个跑；**只读**，脚本自身不写备份目录）

```powershell
for d in backups/world-20261108-*; do
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-world-backup.ps1 -BackupDir "$d"
done
```

**真实输出**（汇总 + 末个备份尾部摘录）

```
backups/world-20261108-051635 EXIT=0  ALL PASS: 137 项通过，0 失败（0 项警告）
backups/world-20261108-071529 EXIT=0  ALL PASS: 137 项通过，0 失败（0 项警告）
backups/world-20261108-124614 EXIT=0  ALL PASS: 137 项通过，0 失败（0 项警告）
backups/world-20261108-125058 EXIT=0  ALL PASS: 137 项通过，0 失败（0 项警告）
backups/world-20261108-125245 EXIT=0  ALL PASS: 137 项通过，0 失败（0 项警告）
backups/world-20261108-125724 EXIT=0  ALL PASS: 137 项通过，0 失败（0 项警告）
backups/world-20261108-131023 EXIT=0  ALL PASS: 137 项通过，0 失败（0 项警告）
```

末个备份里有信息量的几行：

```
PASS plugins/CoreProtect/database.db 用 VACUUM INTO 取快照
PASS plugins/CoreProtect/database.db SHA256 一致
PASS plugins/CoreProtect/database.db integrity_check=ok
PASS 任务板/记忆来自唯一真相 mindcraft/bots mindcraft/bots
PASS 备份含 world 组件
PASS 备份含 bots 组件
PASS 排除项已显式记录 10×*.jar…; 20×*-shm…; 3×session.lock…; 6×活跃 SQLite 库原文件…; 1×server/server.properties…
```

**只读性核对**（自证不改备份）：`grep -n "Set-Content|Out-File|New-Item|Remove-Item|Copy-Item|Set-Acl|Expand-Archive" scripts/verify-world-backup.ps1` 的写操作全部落在 `[System.IO.Path]::GetTempPath()` 下的临时目录（`:86`、`:419`、`:504`），无一条写 `backups/` 或 `server/`。

**判定**：PASS —— "备份可验证"在当前 7 份真实备份上**成立**。
**证据**：`evidence/ops/verify-world-20261108-*.txt`（7 个文件）

---

### OPS-4b 验证器反向对照 —— PASS（证明不是假绿灯）

只取"全绿"不够：把一份**真备份的副本**截断后重验，验证器必须响。

**命令**

```bash
rm -rf tmp/r5-ops/bad-backup && mkdir -p tmp/r5-ops/bad-backup
cp backups/world-20261108-131023/manifest.json tmp/r5-ops/bad-backup/
cp backups/world-20261108-131023/*.zip          tmp/r5-ops/bad-backup/
truncate -s $(( $(stat -c%s tmp/r5-ops/bad-backup/world.zip) - 1000 )) tmp/r5-ops/bad-backup/world.zip
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-world-backup.ps1 -BackupDir tmp/r5-ops/bad-backup
```

**真实输出**

```
corrupted world.zip: 74208854 -> 74207854
FAIL world.zip 大小一致 manifest=74208854 实际=74207854
FAIL world.zip SHA256 一致 manifest=D848D155989F...29EEE 实际=5208F8E5AD2B...45C635
FAIL world.zip 可打开 Exception calling "OpenRead" with "1" argument(s): "End of Central Directory record could not be found."
FAIL 组件 world 有对应压缩包 components 声明了 world，但 entries 里没有 world.zip
HAS FAILURES: 122 项通过，4 项失败（0 项警告）        ← 退出码 1
```

**判定**：PASS（验证器对损坏备份给出 4 条 FAIL + 退出码 1，判据真是"逐项相等"）

**一处文案小瑕（观察项，不算缺陷）**：第 4 条 FAIL 的措辞是"`entries 里没有 world.zip`"，但实际文件在、只是打不开 —— 结论对、文案误导。建议改成"组件包不可读"。

**证据**：`evidence/ops/verify-bad.out.txt`

---

### OPS-4c 恢复演练预检 —— PASS（三个前置分支 + 可复跑性）

`restore-drill.ps1` 参数里**没有** `-WhatIf`/`-Precheck`（实测 `param()` 只有 `BackupDir/Port/RconPort/TimeoutSec/KeepArtefacts/StrictErrors/JavaPath`）。但它把前置检查**放在起服之前**，且失败即 `exit 1`，因此可以在"绝不起服"的前提下把预检路径全部跑透：

| 分支 | 命令 | 真实输出 | 退出码 |
|---|---|---|---|
| 备份目录不存在 | `... -BackupDir "tmp/r5-ops/no-such-backup"` | `FAIL 前置：找不到可演练的备份目录（需要含 manifest.json 的 world-*）` | 1 |
| 旧 schema（v2） | `... -BackupDir "tmp/r5-ops/fake-backup-v2"`（造的 `{"schemaVersion":2,...}`） | `FAIL #1 manifest 可读且 schemaVersion>=3 schemaVersion=2 entries=1`<br>`演练中断：断言 1 失败：manifest 不可用，后续断言无意义`<br>`恢复演练 FAIL：0 通过 / 2 失败` | 1 |
| 端口被占 | 先 `TcpListener(127.0.0.1:25567).Start()`，再 `... -BackupDir backups/world-20261108-131023` | `FAIL 前置条件不满足：`<br>`     · 端口 25567 已被占用` | 1 |

**关键点（安全边界实测成立）**：

- 三个分支都**没有起 java**（`Get-Process java` 全程为空）、**没有占用 25567/25568**、**没有写 `backups/`**。
- 前两分支连 `tmp/drill-*` 都没建（预检在建目录之前）；第三分支同样在建目录之前退出。
- 旧 schema 分支会建 `tmp/drill-20261108-151425/`（含 `report.json`/`report.md`）—— 这是它"把失败现场留证"的设计，已按任务约束清理。
- **可复跑性**：把第一条命令原样跑两遍，输出**逐字节相同**（`diff` 无差异 → `IDENTICAL`），说明预检是幂等/确定性的，不依赖上一次残留状态。

**判定**：PASS（预检层面"恢复演练可复跑"成立）

**4d —— 完整演练：CANNOT-RUN**。第 10~12 条断言需要真起服（`Start-Process java` 在 `scripts/restore-drill.ps1:480`，端口 25567/25568），本轮红线禁止起 MC 服务器。所以：

- 「备份**可验证**」= **本轮已实测成立**（OPS-4a/4b）。
- 「恢复演练**可复跑**」= **预检与中断路径已实测可复跑**；**端到端 12 条断言本轮未证**，需另开一轮（或交 mc-live-runner/人工）在允许起服的窗口里跑一次 `-BackupDir backups/world-20261108-131023`，并留意它会在 `tmp/drill-<时间戳>/` 落 `report.json`+`report.md`。

**一处观察（设计如此，仅记录）**：演练被断言中断时，汇总里会多一条 `✗ #99 演练完整跑完（未被中断）`，所以"失败数"比真实坏点数多 1。对"是否通过"的判断无影响。

**证据**：`evidence/ops/drill-t1.out.txt`、`drill-t1b.out.txt`、`drill-t2.out.txt`、`drill-t3.out.txt`

---

### OPS-5 `scripts/e2e.ps1` 可行性前提 —— 静态核对（结论：可跑，附一条抢占风险）

**只核对，不启动。** 逐项核对脚本自己声明的 5 类前提：

| 前提 | 脚本里怎么用 | 实测 | 结论 |
|---|---|---|---|
| `.tools/jdk*/bin/java.exe` | `Resolve-Java`：`Get-ChildItem .tools -Filter 'jdk*' -Directory` → `bin/java.exe` | `.tools/jdk-21.0.12.1+1/bin/java.exe`（50304B）；`java -version` = `openjdk version "21.0.12.1" 2026-08-18 LTS` | ✅ |
| `server/server.jar` | `$ServerJar`，传给 ctl 作 `-jar` | 存在，52811717B；**sha256 与 `server/paper-1.21.8-60.jar` 完全相同**（`8de7c52c…f1e`）⇒ 就是 Paper 1.21.8，模板里的 `paper-world.yml` 等前提对得上 | ✅ |
| `server-test/{libraries,versions,cache}` | `New-RunDir` 里 `New-Item -ItemType Junction` 指过去只读复用 | 三个都在：libraries 75M / versions 28M / cache 55M | ✅ |
| `test-template/{world,server.properties}` | 拷 `world`；properties 里替换 `__E2E_RCON_PASSWORD__` | `world/` 有 `level.dat`(1661B)+`region/{r.-1.-1,r.-1.0,r.0.-1,r.0.0}.mca`；properties 占位符出现 **1** 次（`:46`），`:47 rcon.port=25576`、`:55 server-port=25566`、`:30 level-type=minecraft\:flat` | ✅ |
| 起服守护器 | `node mindcraft/tools/e2e_server_ctl.mjs` + `mindcraft/tools/e2e_rcon.mjs` | 两个都存在（3111B / 1492B）；ctl 用 `spawn(..., {cwd: runDir, stdio:['pipe',...]})` 并把 java pid 写 `server.pid` | ✅ |

**机制层面实测（不用起服也能验的两件）**：

1. **junction 免管理员可用**（e2e 靠它省 158MB 拷贝）：
   ```
   $ New-Item -ItemType Junction -Path tmp\r5-ops\jtest\libraries -Target E:\\我的世界ai\\server-test\\libraries
   junction created: True
   entries visible: 11
   LinkType: Junction
   cleaned: True
   ```
2. **PS 5.1 语法**：`[Parser]::ParseFile` → `scripts/e2e.ps1 errors=0`（同一批 10 个脚本里只有 `start-panel.ps1` 报错，见 OPS-6）。

**java 进程检测逻辑（读码核对）**：起服后从 `server.pid` 读 pid（`:158-171`，30s 超时），停服时①RCON `stop` 等优雅退出（`:223-232`），②超时才 `Stop-Process -Id $javaPid`（**按 pid，不按名字扫 java**）；收尾 `finally` 只杀 `$script:JavaPids`，对残留 java 仅打印 `INFO 机器上还有 N 个 java 进程（可能是别人的跑批，未动）`（`:458-467`）。判定：检测/清理**只碰自己起的实例**，对并行跑批安全。

**给 mc-live-runner 的结论与前置条件**：

- e2e **前提齐备、语法可解析、机制可用 ⇒ 可以跑**；但它会**独占 25566 + 25576**（`:40-41`，`test-template/server.properties` 同值）以及 t37 内置 mindserver 的 **18093**（`:44`，与 `mindcraft/tools/t37_claims_contention_live.mjs:23` 的硬编码一致）⇒ **必须与游戏内实测串行**，不能同时开。
- **一条抢占风险（CONFIRMED，低危）**：端口预检只查了 MC 端口，没查 RCON 端口
  ```
  $ grep -n "PortFree|Get-NetTCPConnection" scripts/e2e.ps1
  404: $busy = @(Get-NetTCPConnection -LocalPort $MC_PORT -State Listen ...)
  406:   Stop-E2E "端口 $MC_PORT 已被占用（pid $($busy[0].OwningProcess)）"
  ```
  只有 `:404` 一处，`$RCON_PORT(25576)` 与 `$MS_PORT(18093)` 未被预检。若 25576 被别人（上一轮的测试服/另一个 e2e）占着而 25566 空着，e2e 会**照常起服**，然后在 RCON 阶段以"认证失败/连不上"的形式炸 —— 报错指向不明显。建议照 `:404` 的样式补两条预检。
- 现状：核对时刻 25566/25576/25565/25567/8080/18093 **全部空闲**，无 java 进程（见 §1）。

**判定**：PASS（可跑）＋ 1 条低危抢占风险（CONFIRMED）
**证据**：`evidence/ops/e2e-static-prereq.txt`

---

### OPS-6 面板 .bat 链路 —— **CONFIRMED（高危）**

**命令级核实：两个 .bat 引用的路径是否真实存在**

```powershell
powershell -NoProfile -Command "Get-Content -Encoding Default '启动面板.bat'"
@echo off
setlocal
title MC AI Panel - Start
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-panel.ps1"
if errorlevel 1 pause
exit /b 0

powershell -NoProfile -Command "Get-Content -Encoding Default '停止面板.bat'"
... powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-panel.ps1" ...

$ ls -l scripts/start-panel.ps1 scripts/stop-panel.ps1
-rwxrwxrwx 1 zeh zeh 15706 Nov  8 13:16 scripts/start-panel.ps1
-rwxrwxrwx 1 zeh zeh  5103 Nov  8 13:16 scripts/stop-panel.ps1
```

⇒ **两个被引用路径都存在**（`%~dp0` = 仓库根）。**但路径存在 ≠ 能跑**：`start-panel.ps1` 在 PS 5.1 下**解析失败**。

**缺陷与实测证据（`start-panel.ps1` 是全仓唯一没有 UTF-8 BOM 的 .ps1）**

```
$ head -c 3 scripts/start-panel.ps1 | od -An -tx1
 23 20 4d            ← "# M"，无 BOM（正确应为 ef bb bf）

$ 全仓 BOM 普查（scripts/*.ps1 + scripts/tests/*.ps1 + scripts/lib/*.ps1）
BOM    scripts/backup-world.ps1           BOM    scripts/restore-drill.ps1
BOM    scripts/deny-rcon-25575-in.ps1     NO-BOM scripts/start-panel.ps1   ← 唯一
BOM    scripts/e2e.ps1                    BOM    scripts/stop-panel.ps1
BOM    scripts/harden-credentials-acl.ps1 BOM    scripts/verify-world-backup.ps1
BOM    scripts/install-backup-task.ps1    BOM    scripts/tests/fake-rcon-server.ps1
BOM    scripts/release.ps1                BOM    scripts/tests/rcon-regression.ps1
                                          BOM    scripts/lib/backup_config.ps1
                                          BOM    scripts/lib/rcon.ps1
```

同一份字节，两种解码下的解析结果（`[Parser]::ParseInput`）：

```
DefaultEncoding = gb2312 (CodePage 936)
按 ANSI/936 解码后解析 -> errors = 8
按 UTF-8  解码后解析 -> errors = 0

按 ANSI 解码后的报错（= powershell -File 实际会看到的）：
  line 73 col 17 : Array index expression is missing or not valid.
  line 92 col 43 : Missing type name after '['.
  line 152 col 46 : Array index expression is missing or not valid.
  line 306 col 39 : The string is missing the terminator: '.
  line 81 col 35 : Missing closing '}' in statement block or type definition.
  line 78 col 65 : Missing closing '}' in statement block or type definition.
  line 66 col 35 : Missing closing '}' in statement block or type definition.
  line 64 col 63 : Missing closing '}' in statement block or type definition.
```

**坏点定位（第 73 行）**：UTF-8 的 3 字节汉字在 cp936 下的 2 字节切分留下一个悬空前导字节，把**字符串结束引号吃掉**：

```
UTF-8 line 73  :     Write-Bad "[错误] 等了 $seconds 秒 $label 端口还没起"
ANSI  解码后    :     Write-Bad "[閿欒] 绛変簡 $seconds 绉?$label 绔彛杩樻病璧?      ← 结尾的 " 变成 ?
```

于是字符串未闭合，往后级联出 8 条错误。**机制最小复现**（我另造的同构探针，与 `start-panel.ps1` 无关）：

```
$ powershell -NoProfile -ExecutionPolicy Bypass -File tmp/r5-ops/enc-probe.ps1
At E:\我的世界ai\tmp\r5-ops\enc-probe.ps1:1 char:6
+ $t = '涓?
+      ~~~
The string is missing the terminator: '.
```

**交叉验证（关键）**：`Parser::ParseFile`（命令行 `-File` 走的就是它）对**同一个探针文件**报出**同一条错误**，证明"我这里的解析结论 = 双击 .bat 时真实发生的事"：

```
ParseFile 对同一个探针文件 -> errors = 1
  line 1 : The string is missing the terminator: '.
```

**影响**：`启动面板.bat` → `powershell -File scripts\start-panel.ps1` → **解析期即失败，一行也不会执行** ⇒ 面板（mindserver + MC 服 + 浏览器）起不来，窗口里只有 8 段红色 ParserError。自引入提交起，这条链路上的一切下游功能（含 `mindcraft/.mindserver-token` 的生成 → 即 OPS-2 那条红）在本机上都失效。

**这是 `af4aa22` 引入的回归，不是"长期存在"**（此处更正第一版判断）

- 引入提交：`af4aa225f3bd3e1421b65b30b5d22c7e1d4bcd28` · 2026-11-06 16:05:57 +0800 · `fix(security): 批次1 —— 控制面/面板/关服链（WEB-001/012、OPS-001/002/004）`
- 该提交对 `scripts/start-panel.ps1` 的**第一处改动就是删掉 BOM**（`git diff af4aa22^ af4aa22 -- scripts/start-panel.ps1 | cat -A`）：

```
-M-oM-;M-?# Minecraft AI M-iM-^YM-*M-gM-^NM-)M-iM-^]M-"M-fM-^]M-? ...   ← "-" + EF BB BF + "#"
+# Minecraft AI M-iM-^YM-*M-gM-^NM-)M-iM-^]M-"M-fM-^]M-? ...              ← "+#"
```

- 父提交与本提交的头字节：`af4aa22^` = `ef bb bf`；`af4aa22` = `23 20 4d`。
- 用 `Parser::ParseFile`（**与 `-File` 同一条编码路径**，见上文交叉验证）逐版实测：

| 版本 | 头字节 | errors | 说明 |
|---|---|---|---|
| `af4aa22^`（父提交） | `EF BB BF` | **0** | 删 BOM 之前，正常 |
| `af4aa22`（引入提交） | `23 20 4D` | **7** | 删 BOM 的那一次提交 |
| `57499b7`（其后） | `23 20 4D` | **8** | 继续加中文，错更多 |
| `40e29d6`（更早） | `EF BB BF` | **0** | 带 BOM，正常 |

- **自我更正**：我在第一版里用 `ParseInput(强制按 ANSI 解码的字符串)` 统计历史版本，该方法**对有 BOM 的版本也强行按 ANSI 解**，于是把 `40e29d6` 误算成 7 错，进而误判为"长期存在"。改用与运行期完全一致的 `ParseFile` 后结论反转：**BOM 在 → 0 错，BOM 被删 → 7/8 错**。
- **反证"长期存在"**：`logs/mindcraft-console.log` / `logs/server-console.log` 时间戳为 **10-30 19:23 → 10-31 01:40**（早于 `af4aa22` 的 11-06），内容是 `Console UI mounted at http://localhost:8080/console` / `MindServer running on port 8080 on host localhost` ⇒ 那时面板确实跑起来过（当时是带 BOM 的版本）。
- 文件自己的注释仍写着「所有中文都在这里（**UTF-8+BOM**）」（`scripts/start-panel.ps1:2`）—— 与该提交的实际改动自相矛盾，属于"注释承诺了、代码没守住"。

**真实入口实测（用户双击的等价路径，补上最后一环）**

```powershell
$ MSYS_NO_PATHCONV=1 printf "\n\n" | MSYS_NO_PATHCONV=1 cmd.exe /c "启动面板.bat"
# printf 的两个换行是给 .bat 末尾 pause 喂回车，等价于用户双击后按一次键
```

真实输出（截取首尾，全文见证据文件）：

```
At E:\我的世界ai\scripts\start-panel.ps1:73 char:17
+     Write-Bad "[閿欒] 绛変簡 $seconds 绉?$label 绔彛杩樻病璧?
+                 ~
Array index expression is missing or not valid.
...
    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException
    + FullyQualifiedErrorId : MissingArrayIndexExpression
 
Press any key to continue . . . 
BAT_EXITCODE=0
```

**用户观察到的现象**：双击 → 黑窗口刷 **8 段** ParserError（每段带 `+ 出错行原文`，汉字是 cp936 乱码，如 `[閿欒]`）→ 停在 `Press any key to continue . . .` → 按任意键窗口关闭 → **面板没打开**（浏览器不弹、服不起）。

**两个细节**：

1. `Press any key to continue . . .` 出现，说明 `.bat` 的 `if errorlevel 1 pause` 被触发 ⇒ **PowerShell 侧退出码非 0**（直接调用实测 `POWERSHELL_EXITCODE=1`）。
2. **但 `.bat` 自己退出码是 0**（`BAT_EXITCODE=0`）：`.bat` 末尾无条件 `exit /b 0`，把失败吞掉了。⇒ 二阶缺陷：任何"看退出码判断是否启动成功"的调用方（快捷方式、计划任务、外层脚本）都会被骗过。

**无副作用断言（跑完真实入口后）**

- `mindcraft/.mindserver-token`：运行前 `False`，运行后仍 `False` ⇒ 未写凭据、mindserver 未启动。
- 监听端口：运行前后 `25565/25566/25576/8080/18093` **均为空**；无 java 进程。
- 为什么必然无副作用：解析阶段就失败 ⇒ **语句块从未执行**。我另做了机制探针（`tmp/r5-bom-fix/parse-abort-probe.ps1`：第 2 行本应创建标记文件、第 3 行故意 no-BOM 汉字造成解析错），实跑后报 `TerminatorExpectedAtEndOfString` 且**标记文件未生成**。
- 诚实记录：采样间隔内出现过一次 `node pid=23764`（16:10:46 起、数秒后消失），但它既不监听 8080 也未写 token、命令行为本机其它跑批产物（该机常驻 node 是 OpenAI Codex runtime，另 `node server.js`、`s3_natural.mjs` 属并行成员的任务），不是本 `.bat` 的产物。

**修法（一行）**：把 `scripts/start-panel.ps1` 重新保存为 **UTF-8 with BOM**（其余 13 个 .ps1 已是 BOM，`acl-regression.mjs` 甚至专门断言 harden 脚本必须带 BOM —— 口径已有，只差这一个文件）。修完应能直接 `powershell -File scripts\start-panel.ps1` 进入正常启动流程（本轮不改代码，只报缺陷）。

**顺带核到的可移植性风险（观察项，非本轮缺陷）**：`start-panel.ps1:14` 硬编码 `$node = 'D:\Node\node.exe'`（实测存在，且 `Get-Command node` 也指向它）—— 本机没事，换机器/换 Node 安装位置就会挂。建议改成"PATH 优先 + 该路径兜底"。

**判定**：**CONFIRMED（高危；路径存在但脚本不可解析）**
**证据**：`evidence/ops/start-panel-encoding.txt`、`evidence/ops/bat-real-entry.txt`（真实入口 EXITCODE + 原样报错）、`evidence/ops/ops6-regression-attribution.txt`（引入提交 af4aa22 + 逐版解析 + 面板跑过的日志）、`evidence/ops/ops6-no-side-effect.txt`（token/端口/进程前后快照 + 零执行机制探针）、`evidence/ops/bom-fix-control.txt`（+BOM 副本 0 错）、`evidence/ops/bat-paths.txt`、`evidence/ops/e2e-static-prereq.txt`

---

## 4. 结论汇总（给下游用）

| 断言 | 本轮结论 | 依据 |
|---|---|---|
| 「运维回归脚本可跑通」 | ✅ 成立 | OPS-1 29/29，exit 0 |
| 「ACL 回归脚本可当门禁用」 | ❌ **不成立（缺陷）** | OPS-2 exit 1，断言与运行状态耦合 |
| 「凭据文件 ACL 已收口」 | ✅ 成立 | OPS-2b：两文件非继承 + 3 ACE + 无过宽主体；harden 体检 exit 0 |
| 「RCON 协议回归离线可跑」 | ✅ 成立 | OPS-3 7/7，假服回环+自退，无端口残留 |
| 「备份可验证」 | ✅ **成立（7/7 实测）** | OPS-4a；且 OPS-4b 反向对照会红，非假绿灯 |
| 「恢复演练可复跑」 | ⚠️ 预检层面成立，**端到端未证** | OPS-4c（3 分支 + 两次同输出）；OPS-4d CANNOT-RUN（需起服） |
| 「`e2e.ps1` 前提齐备可跑」 | ✅ 成立（附 1 条端口预检缺口） | OPS-5 |
| 「双击 启动面板.bat 能起面板」 | ❌ **不成立（高危缺陷，`af4aa22` 引入的回归）** | OPS-6：真实入口实测 EXITCODE=0 但面板未起；`start-panel.ps1` 无 BOM ⇒ PS 5.1 解析 8 错 |

**建议优先级**：OPS-6（面板起不来，P0：一行改 BOM；顺手把 .bat 末尾 `exit /b 0` 改成透传退出码）> OPS-2（回归脚本必红，P1，改成 SKIP 或加运行前置）> OPS-5 的 25576/18093 预检缺口（P2）> 其余为观察项。

## 5. 约束遵守与现场清理

- **未起 MC 服务器**：全程 `Get-Process java` 为空；25565/25566/25567/25576/25599 无监听。三次演练只走"起服前"分支。
- **未改存档**：`server/`、`server-test/`、`backups/` 零写入（`git status --porcelain` 仅显示本轮新增的未跟踪 `docs/audit-r5/`）。
- **临时写盘**：全部在 `tmp/r5-ops/` 与本轮补测用的 `tmp/r5-bom-fix/`（BOM 对照副本、历史版本副本、探针、各命令输出）；另有三处是**脚本自身**的默认落盘，已核对均为仓库 `tmp/` 而非存档：`tmp/rcon-regression.log`（RCON 回归的证据文件，保留）、`tmp/drill-<时间戳>/`（已清理）、`tmp/e2e/`（空目录，非本任务创建）。
