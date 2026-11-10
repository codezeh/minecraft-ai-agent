# R6 #7 + 「手动备份不读配置」：部署供给与备份配置一致性

> 任务：t5（fix-ops，attempt 1）。
> 写作用域：`scripts/**`、`docs/**`、`README.md`、`启动面板.bat`（`mindcraft/` 只读）。
> 前置约束：**不改数据库架构**（属 ADR 阶段 1–3）；**不把大文件（JDK / jar / world）收进仓库**。
> 日期：2026-11-10。
> 结论：两条缺陷都已修，且都用**真机无副作用模式**验证过；其中 #7 的验证是在**真干净 clone** 里跑的。

---

## 0. 结论表

| 项 | 结果 | 证据 |
|---|---|---|
| #7 从零 clone 有可照做的供给路径 | ✅ 新增 `scripts/provision.ps1`（读 `.paper-url` / `.example`，幂等，`-DryRun` 零副作用） | 第 3 节；`docs/audit-r6/fixes/ops.md` 同名证据小节 |
| #7 README 指向它 | ✅ 「从零开始」改成 4 步，第 2 步即供给；新增「第 2 步到底补了什么」表 | `README.md`「从零开始（4 步，照做即可）」 |
| #7 clone-all 的「下一步」指向它 | ✅ 第 2 步 + 按实际检出状态打印"缺 JDK / server.jar / server.properties" | `scripts/clone-all.ps1` §7；实测输出见 §3.3 |
| #7 start-panel 报错指向它 | ✅ 缺 JDK / 缺 server.jar 两处都给出 provision 命令（两条路径都已实测） | `scripts/start-panel.ps1` 前置检查；§3.7 |
| 手动备份不读配置 | ✅ 配置**永远读**（裸跑也生效）；`-IncludeSecrets` 显式覆盖；两开关互斥 exit 1 | 第 4 节；`scripts/backup-world.ps1` 配置块 |
| README 写清备份配置语义 | ✅ 新增「备份与恢复」一节 + 字段表（含"手动备份是否生效"列） | `README.md` |
| 解析检查 `Parser::ParseFile` | ✅ 4 个 .ps1 全 `ERR=0`（0 errors） | §5.1 |
| `node scripts/tests/ops-regression.mjs` | ✅ **29 passed, 0 failed** | §5.2 |
| 新脚本 `-DryRun` | ✅ 真机 exit 0；干净 clone exit 1（缺 JDK，已打印可照做步骤） | §3.2 / §3.4 |

**没有做的事**（避免越界/副作用）：没有起任何服务端、没有跑全量 `npm test`、没有改 `mindcraft/`、没有删任何既有备份、没有改 `config/backup.json`、没有提交任何二进制。

---

## 1. 缺陷原文与判定

### 1.1 #7 —— 从零 clone 之后没有「能跑的服务端」

`docs/audit-r6/00-缺陷报告.md` §#7（源 OPS-R6-01）：

> 干净 clone 里**根本没有**跑起来所需的三件硬前置：`.tools/`（JDK）、`server/server.jar`、`server/server.properties`。
> `git ls-files server | wc -l` = **11**（只有文本）。`clone-all` 打印的"下一步"从不提这些 ⇒
> `start-panel` 必然停在 `[错误] 找不到 JDK` 或 `[错误] 找不到 server\server.jar`。
> 唯一供给线索是 `server/.paper-url` 里一条 URL，**没有任何脚本读它**。

本次复核（`git ls-files server`）：仍是 11 个文件，全是文本；`.gitignore` 排除 `/.tools/`（46 行）、
`*.jar`（47 行）、`/server/server.properties`（74 行）。⇒ **缺陷成立**。

### 1.2 手动备份不读 `config/backup.json`

`config/backup.json` 只有 `enabled / onServerStop / dailyAt / keep / excludeSecrets` 五个字段，
而 `scripts/backup-world.ps1` 里读配置的那一段**被 `if ($FromConfig)` 包住**；README 教的是裸跑
`powershell -File scripts\backup-world.ps1`（不带 `-FromConfig`）⇒ **人工备份从不读 `excludeSecrets`**，
默认 `-ExcludeSecrets` 未传 ⇒ manifest 记 `containsSecrets=true`，`server-config.zip` 里是**明文 RCON 口令**。
⇒ **缺陷成立**（且与 #9 的"脱敏入包"修复叠加后才真正危险：脱敏逻辑存在，但手动路径根本走不到）。

---

## 2. 修法（设计取舍）

### 2.1 #7：为什么是「一条脚本 + 三处指向」，不是「把二进制塞进仓库」

仓库刻意只收录"需要回滚的源码/文档/配置"（`.gitignore` 顶部注释 + `docs/audit-执行/00-基线.md`）。
把 300 MB JDK 与 50 MB jar 收进来会毁掉这条纪律，所以**供给脚本**是唯一正确形态：

- 供给**入口唯一**：`scripts/provision.ps1`（幂等，跑几次都行）；
- **不猜、不瞎下**：JDK 没有入库的 URL，脚本不会私自下载某个版本 —— 它检查 `.tools/jdk*`，
  没有就打印**本机候选 JDK 路径 + 照抄即可的命令**，或让你给 `-JdkZip` / `-JdkUrl`；
- **衔接现有线索**（这正是 #7 说"没人读"的东西）：
  - `server/.paper-url`：URL 最后一段就是 PaperMC fill-data 的**文件 sha256**（实测
    `server/server.jar` 的 sha256 = `8de7c52c3b02403503d16fac58003f1efef7dd7a0256786843927fa92ee57f1e`，
    与 URL 段完全一致）⇒ 下载后**校验**，不一致拒绝落盘；
  - `server/server.properties.example`：模板全保留，只把 `rcon.password=CHANGE_ME` 换成随机 32 位十六进制
    （`enable-rcon=true` 必须保留 —— `stop-panel` 的优雅关服链依赖 RCON）；
  - `server/eula.txt`：缺失时补 `eula=true`（Paper 首次启动硬性要求）。

### 2.2 备份：为什么让「手动也读配置」而不是「强制必须带 -FromConfig」

两条路都能止血，选了前者，理由：

1. README/快捷方式/肌肉记忆里都是裸跑；**报错强制**会让"已经关服、想备一份"的用户当场卡住，
   而备份是**减少数据损失**的动作 —— 不该给它加门槛；
2. 让配置成为**唯一语义来源**（`excludeSecrets` 默认 true ⇒ 裸跑也是安全的），符合"同类只留一份实现"的既有原则；
3. 自动备份的 `enabled` 总开关语义不变：`enabled=false` **只关自动**，手动仍执行（但打印一句说明）。

同时保留**显式覆盖**：`-ExcludeSecrets` / `-IncludeSecrets`（互斥，同给 exit 1）。
真需要带明文口令的人必须**明说** `-IncludeSecrets`，脚本会警告"备份目录属敏感数据"。

---

## 3. #7 的实现与证据

### 3.1 `scripts/provision.ps1`（新增，592 行）

| 步骤 | 行为 | 幂等语义 |
|---|---|---|
| 1/3 JDK 21 | 先看 `.tools/jdk*/bin/java.exe` 且 major ≥ 21；否则 `-JdkZip`（解压到 `.tools/`）/ `-JdkUrl`（下载再解压）/ `-JavaHome`（建 `.tools\jdk-system` **junction**，不复制 300 MB）；都没有 ⇒ 打印候选路径与照抄命令，exit 1 | 已有合规 JDK ⇒ 只体检 |
| 2/3 Paper jar | 读 `server/.paper-url` ⇒ 下载到 `server/server.jar`，用 URL 段 sha256 校验；`-JarFile` 离线；`Force` 才允许覆盖指纹不符的旧 jar | 已存在且指纹一致 ⇒ 跳过 |
| 3/3 配置 | 缺 `server.properties` ⇒ 从 `.example` 生成（口令随机化）；已存在 ⇒ **只体检不修改**（可能是在跑的服）；`eula.txt` 缺失 ⇒ 补 `eula=true` | 已存在 ⇒ 只体检 |

细节约束（都是踩过才知道的）：

- **`$ErrorActionPreference='Stop'` 会把原生命令的 stderr 变成终止错误**：`& java -version 2>&1` 在 Stop 下
  直接抛 ⇒ 版本号恒为 0（第一版就踩了，见 §6）。现在函数内临时降到 `Continue` 再取文本。
- **`$HOME` 是只读变量**（大小写不敏感）：第一版用 `$home` 存 JDK 路径，在**干净 clone** 里当场抛
  `Cannot overwrite variable HOME`（§6）。改名 `$jdkHome`。
- **junction 的删除**只能用 `[System.IO.Directory]::Delete()`；`Remove-Item -Recurse` 会**进到目标里**删真文件。
- 启动器只认 `server\server.jar`（`start-panel.ps1`），所以落盘名固定为 `server.jar`，不让用户猜。

### 3.2 真机 `-DryRun`（本机已是可跑状态）

```
$ powershell -NoProfile -ExecutionPolicy Bypass -File scripts/provision.ps1 -DryRun
[1/3] JDK 21（.tools\jdk*\bin\java.exe）
      OK   已就绪：E:\…\.tools\jdk-21.0.12.1+1\bin\java.exe（Java 21）
[2/3] Paper 服务端 jar（server\server.jar）
      OK   已就绪：server\server.jar（sha256 与 .paper-url 一致：8de7c52c3b024035…）
[3/3] 服务端配置（server\server.properties + eula.txt）
      OK   已就绪：server\server.properties（enable-rcon=true 且口令已设置）
      OK   已就绪：server\eula.txt（eula=true）
[结果] 三项前置  ……  EXIT=0
```

### 3.3 clean clone 里 `clone-all` 的「下一步」（真跑，非模拟）

```
$ pwsh scripts/clone-all.ps1 -LocalSource -Dest tmp/cloneall-probe      # EXIT=0
[7] 下一步（照抄即可）
  # 1) 进目录
  cd "E:\我的世界ai\tmp\cloneall-probe"
  # 2) 供给服务端（JDK 21 + Paper jar + server.properties）—— R6 #7 缺的就是这一步
  powershell … -File scripts/provision.ps1 -DryRun   # 先体检，零副作用
  powershell … -File scripts/provision.ps1
     # 离线机器：-JdkZip <JDK21.zip> -JarFile <paper.jar>；已有 JDK 21：-JavaHome <dir>
     # 它读 server/.paper-url 下 jar（sha256 校验），并从 server.properties.example 生成配置
  # 3) 装运行时依赖（mindcraft 548 个包…；web 是面板与关服脚本要用的）
  # 4) 只校验… -VerifyOnly      # 5) -SkipDocker      # 6) 全链路
  WARN  注意：这份检出里没有 server\server.jar（Paper 服务端核心）、server\server.properties（含 RCON 口令，仓库只跟踪 .example）、.tools\（JDK 21） —— 这就是第 2 步要补齐的
  WARN  不跑第 2 步，「启动面板.bat」会停在 [错误] 找不到 JDK / 找不到 server\server.jar。
```

⇒ 「从零 clone 到能跑」现在**有编号、有命令、有缺项清单**，不再靠人猜。

### 3.4 在同一个 clean clone 里**真做一次供给**（离线：junction + 本机 jar）

```
$ powershell … provision.ps1 -JavaHome "E:\我的世界ai\.tools\jdk-21.0.12.1+1" -JarFile "E:\…\server\server.jar"
[1/3] OK 已建立 .tools\jdk-system → E:\…\jdk-21.0.12.1+1（Java 21）
[2/3] OK 已从本地拷入：…\tmp\cloneall-probe\server\server.jar（sha256 校验通过）
[3/3] OK 已生成：…\server\server.properties（来自 .example，rcon.password 已换成随机 32 位十六进制）
      OK 已就绪：…\server\eula.txt（eula=true）
[结果] 三项前置全部就绪   EXIT=0
```

随后：**幂等重跑**（不带任何参数）⇒ 三项全 OK、EXIT=0，什么都没改；
生成的 `server.properties`：`enable-rcon=true`、`rcon.port=25575`、`white-list=true`、`online-mode=false`、
`rcon.password` = **32 位十六进制**（实测 `len=32 hex=True`）。

### 3.5 仓库卫生：供给物**不会**污染 git

在 clean clone 里 `git status --porcelain` 只显示 `?? scripts/provision.ps1`（探针拷进去的那份），
三个供给物都被忽略：

```
.gitignore:46:/.tools/                  .tools
.gitignore:47:*.jar                     server/server.jar
.gitignore:74:/server/server.properties server/server.properties
```

### 3.6 一条命令的「能跑」判据

`provision.ps1` 的退出码就是判据：`0` = 三项前置全部就绪（`-DryRun` 下表示"照此执行即可就绪"）；
`1` = 还有未满足项（每条 FAIL 后面都跟"修法"）；`2` = 参数/环境错误。
所以"这台机器能不能起服"从"双击试试看"变成了一条**可断言**的命令。

---

### 3.7 两条报错路径实测（都在 clean clone 里触发，任何 spawn 之前退出）

```
$ (clean clone，没有 .tools)          powershell -File scripts/start-panel.ps1
      [错误] 找不到 JDK（.tools\jdk-*\bin\java.exe）
              修法（一次性供给）：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision.ps1 -DryRun
              照它的输出做完再重跑本脚本（说明见 README「从零供给（provision.ps1）」）。
      EXIT=1

$ (有 JDK，但删掉了 server.jar)       powershell -File scripts/start-panel.ps1
      [错误] 找不到 server\server.jar
              修法（一次性供给）：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision.ps1
              它会按 server\.paper-url 下载并按 sha256 校验（离线可用 -JarFile <本地 jar>）。
      EXIT=1
```

⇒ 报错不再只说"找不到什么"，而是**直接给出补它的命令**；两条都在一个进程都没起的时候就退出
（这是 #7 期望的"错就要错得可照做"，也是避免"半启动"这种更糟的状态）。

## 4. 备份配置的修复与证据

### 4.1 改动（`scripts/backup-world.ps1`）

1. **配置块移出 `if ($FromConfig)`** —— 永远 dot-source `lib/backup_config.ps1` 并 `Get-BackupConfig`；
2. **`enabled=false` 只拦自动**：`-FromConfig` 下照旧"跳过 + 记 `logs/backup-auto.log` + exit 0"；
   手动跑则打印一句"本次是手动备份，继续执行"；
3. **`keep` 默认取配置**（`$PSBoundParameters` 判断，命令行 `-Keep` 仍优先）；
4. **新增 `-IncludeSecrets`**（显式要明文口令）与既有的 `-ExcludeSecrets` **互斥**，同给 ⇒ exit 1；
5. **输出两行"来源"**，让用户看见这次到底是哪来的策略：
   `配置：…\config\backup.json（已读取）keep=7` / `口令：excludeSecrets=True（来源：config/backup.json）`；
6. **manifest 新增 `secretsPolicy`**：`{excludeSecrets, source, configPath, configFromFile}`
   —— 恢复者能回答"这份备份为什么带/不带口令"；
7. 结尾在"含明文口令"时多一句修法提示（下次去掉 `-IncludeSecrets` 即默认脱敏）。

### 4.2 真机证据（每次都是真跑，用 `-Mode Hot` 的无害闸门取退出码）

| 场景 | 命令 | 输出关键行 | 退出码 |
|---|---|---|---|
| 裸跑（**修的就是这条**） | `backup-world.ps1 -Mode Hot` | `口令：excludeSecrets=True（来源：config/backup.json）` | 3（Hot 闸门） |
| 显式要口令 | `… -IncludeSecrets` | `excludeSecrets=False（来源：命令行 -IncludeSecrets（显式要求带明文口令））` | 3 |
| 显式排除 | `… -ExcludeSecrets` | `excludeSecrets=True（来源：命令行 -ExcludeSecrets）` | 3 |
| 互斥 | `… -ExcludeSecrets -IncludeSecrets` | `FAIL -ExcludeSecrets 与 -IncludeSecrets 互斥…` | **1** |
| 自动模式 | `… -FromConfig` | `自动备份配置：enabled=True dailyAt=04:30` | 3 |
| keep 覆盖 | `… -Keep 3` | `keep=3` | 3 |

### 4.3 **真做一次冷备**，证明「手动也脱敏」端到端成立

服务端已停（25565 closed），备份到临时目录（`-OutDir tmp/backup-probe -Keep 0`，**不动既有备份**）：

```
$ powershell … backup-world.ps1 -OutDir tmp/backup-probe -Keep 0        # EXIT=0
world.zip 70.8 MB / 1502 条目；bots.zip 8.3 MB / 494；plugins.zip 4.6 MB / 589；server-config.zip 18；logs.zip 10
完成：…\tmp\backup-probe\world-20261110-210654     一致性：已保证（Cold）
```

manifest 实证：

```json
"secretsPolicy": {"excludeSecrets": true, "source": "config/backup.json", "configFromFile": true}
"containsSecrets": false
"redacted": [{"path": "server/server.properties", "field": "rcon.password", …}]
```

`server-config.zip` 内的 `server/server.properties`（逐行读出）：

```
enable-rcon=true            ← 保留（否则恢复后优雅关服断链，见 #9）
rcon.port=25575             ← 保留
white-list=true             ← 保留
online-mode=false           ← 保留
rcon.password=              ← 抹空（不是 CHANGE_ME，不是明文）
```

⇒ **同一条裸命令，修复前产出明文口令，现在自动脱敏**，且 settings 完整可恢复。

### 4.4 备份本身仍然自洽

对这份新备份跑既有门禁：`verify-world-backup.ps1 -BackupDir …` ⇒ **EXIT=0**（137 条断言全过），
说明新增 `secretsPolicy` 字段没有破坏 manifest 消费方（`verify` / `restore-drill` 只读它们认识的键）。

---

## 5. 验证

### 5.1 PowerShell 解析（`Parser::ParseFile`，要求 ERRORS=0）

| 文件 | ERR |
|---|---|
| `scripts/provision.ps1`（新增） | **0** |
| `scripts/backup-world.ps1`（改） | **0** |
| `scripts/clone-all.ps1`（改） | **0** |
| `scripts/start-panel.ps1`（改） | **0** |

编码与仓库既有约定一致：UTF-8 **with BOM**、CRLF。

### 5.2 离线回归

```
$ node scripts/tests/ops-regression.mjs
ALL PASS: 29 passed, 0 failed        # 与修复前基线一致（改动未触碰 OPS-001/OPS-002 断言点）
```

### 5.3 无副作用模式

| 命令 | 退出码 | 说明 |
|---|---|---|
| `provision.ps1 -DryRun`（本机已就绪） | 0 | 三项 OK，零写入 |
| `provision.ps1 -DryRun`（clean clone） | 1 | JDK 缺 ⇒ 打印两条照做路径；jar/配置打印 DRYRUN 计划 |
| `provision.ps1`（clean clone，离线真做） | 0 | 三物落盘；再跑一次仍 0（幂等） |
| `start-panel.ps1 -DryRun` | 0 | 改动后前置检查仍全过、零 spawn |
| `clone-all.ps1 -LocalSource -Dest tmp/…` | 0 | 两仓就位 + 新"下一步" |

（`tmp/` 全部被 `.gitignore` 忽略；探针里的 junction 已用 `Directory::Delete` 安全摘除，目标 JDK 未动。）

---

## 6. 过程中踩到并修掉的两个真 bug（都只在干净环境才现形）

> 这两个都是"在本机能跑、换台机器就炸"的类型，正好是 #7 的主题，值得留档。

1. **`$ErrorActionPreference='Stop'` + 原生命令 stderr**：`& $java -version 2>&1` 会把那条 stderr 变成
   ErrorRecord，在 Stop 下**立即终止**，被外层 `catch` 吞掉 ⇒ `Get-JavaMajor` 恒返回 0 ⇒ 本机明明有 JDK 21
   却报 `找到 JDK 但版本太低（Java 0）`。修法：函数内临时 `$ErrorActionPreference='Continue'` 取文本
   （不靠 try/catch 兜底），`finally` 复原。
2. **`$home` 是内置只读变量**：`Find-SystemJdks` 里 `$home = Split-Path …` 在**干净 clone**（PATH 上找到 java）时
   抛 `Cannot overwrite variable HOME because it is read-only or constant`，脚本当场崩。改名 `$jdkHome`。
   —— 这个 bug 在本机（PATH 上没有 java）根本触发不到，是"在 clean clone 里跑一遍"才抓出来的。

---

## 7. 改动清单（本任务写作用域内）

| 文件 | 性质 | 内容 |
|---|---|---|
| `scripts/provision.ps1` | **新增**（592 行） | 从零供给：JDK / Paper jar（sha256 校验）/ server.properties + eula.txt；`-DryRun`、`-JdkZip`、`-JdkUrl`、`-JavaHome`、`-JarFile`、`-Force`、`-SkipJdk` |
| `scripts/backup-world.ps1` | 改 | 配置永远读；`-IncludeSecrets`；互斥校验；来源打印；manifest `secretsPolicy`；文档同步 |
| `scripts/clone-all.ps1` | 改 | 「下一步」插入供给步骤（并重编号），并按检出状态打印缺项清单 |
| `scripts/start-panel.ps1` | 改 | 缺 JDK / 缺 server.jar 时指向 `provision.ps1`（不再只说"找不到"） |
| `README.md` | 改 | 「从零开始」3 条 → **4 步**（第 2 步供给）；新增「第 2 步到底补了什么」表；新增「备份与恢复」一节（含 `config/backup.json` 字段的"手动备份是否生效"表） |
| `docs/audit-r6/fixes/ops.md` | **新增** | 本文 |

**未改**：`mindcraft/**`（只读）、`config/backup.json`（默认值本来就对）、`server/**` 任何运行期文件、
`verify-world-backup.ps1` / `restore-drill.ps1`（manifest 新字段向后兼容，无需改动）。

---

## 8. 留给后续的观察点（不在本任务范围）

1. **JDK 供给仍是"人给一次文件"**：没有入库的 JDK URL（避免钉死一个可能失效的镜像）。
   若日后要"半自动"，建议新增 **入库的** `server/.jdk-url`（与 `.paper-url` 对称）+ 可选 sha256，
   再由 `provision.ps1 -FromUrlFile` 读取 —— 这样"线索文件"和"读它的代码"一一对应，不会重演 #7 的"没人读"。
2. **README 的第 3 步多了 `cd web; npm ci`**：这是 #8（缺 `web/node_modules` ⇒「停止面板.bat」不可用）的
   文档侧止血；代码侧（`stop-panel` 预检、`start-panel` 拒绝启动）属 #8 的实现范围，本任务未改判定逻辑。
3. **`provision.ps1` 未接入任何门禁脚本**：`ops-regression.mjs` 仍是文本正则（R6 #97 的盲区）。
   建议在 gate 层加一条"`provision.ps1 -DryRun` 在已就绪机器上必须 exit 0"的真跑断言。
