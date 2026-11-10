# 我的世界 AI 陪玩 —— 仓库总览

这个工作区是**两个 git 仓库**叠在一起的：

| 路径 | 仓库 | 装什么 |
|---|---|---|
| `./`（仓库根） | 父仓 | 启动/关服脚本、世界备份、控制台前端源码 `web/`、文档与审计台账 |
| `./mindcraft/` | 独立嵌套仓（父仓 `.gitignore:13` 排除） | Minecraft bot 运行时 + mindserver、Dockerfile、**固化产物 `web-dist/`** |

⚠️ **父仓不跟踪 `mindcraft/`**（`.gitignore:13` 排除，因为子仓自带 `.git`，硬纳进来会变成伪子模块）。
只 clone 父仓拿到的是"控制脚本 + 前端源码"，**没有业务代码，跑不起来**；
新机器上必须**两个仓都 clone** —— 这件事现在由 `scripts/clone-all.ps1` 一条命令负责，不再靠人记。

## 从零开始（4 步，照做即可）

```powershell
# 1) 两个仓一起拉下来（父仓 → <Dest>，子仓 → <Dest>/mindcraft）
#    有远端时：
pwsh scripts/clone-all.ps1 -ParentUrl <parent-url> -MindcraftUrl <mindcraft-url> -Dest D:\repo
#    只想在本机复现"干净检出"（没有远端也能真跑）：先 clone 父仓，再用 -LocalSource
pwsh scripts/clone-all.ps1 -LocalSource -Dest D:\repo

# 2) 供给服务端：JDK 21 + Paper jar + server.properties
#    干净 clone 里这三样**一定是缺的**（二进制与口令文件不入库），第 1 步的 clone-all
#    也补不了它们 —— 这就是 R6 #7。provision.ps1 是唯一入口，幂等，可反复跑。
cd D:\repo
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/provision.ps1 -DryRun   # 先体检（零副作用）
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/provision.ps1          # 照体检输出落地
#    离线机器：-JdkZip <JDK21.zip> -JarFile <paper.jar>
#    本机已有 JDK 21（不想复制 300MB）：-JavaHome "C:\Program Files\Eclipse Adoptium\jdk-21.0.x-hotspot"

# 3) 装运行时依赖（mindcraft 548 个包，首次约 10 分钟；web 是面板与关服脚本要用的）
cd D:\repo\mindcraft; npm ci
cd D:\repo\web; npm ci

# 4) 校验"产物 ↔ 清单 ↔ 源码指纹"是否一致（秒级，不需要 docker）
cd D:\repo; pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -VerifyOnly
```

四步走完之后双击「启动面板.bat」就能起服（第一次较慢：Paper 要在 `server/` 下生成
`libraries/`、`cache/`、`world/`）。

`clone-all.ps1` 会做三件容易漏掉的事：**(a)** 检测"父仓 clone 完但没有 `mindcraft/`"的半成品状态并给出明确报错（这正是 R5-004 的用户体感）；**(b)** 校验两个仓的 HEAD 短哈希与 `-Ref` 是否一致；**(c)** 自检 `mindcraft/web-dist/` 与 `MANIFEST.json` 是否随仓库到位（缺了就明说镜像会构建失败）。参数：`-ParentUrl` / `-MindcraftUrl` / `-Dest`（必填）/ `-Ref`（可选）/ `-LocalSource`。

### 第 2 步到底补了什么（`scripts/provision.ps1`）

| 缺的东西 | 为什么 clone 拿不到 | provision 怎么补 |
|---|---|---|
| `.tools/jdk-*\bin\java.exe` | `.gitignore` 排除 `/.tools/`（约 300 MB） | 用 `-JdkZip` 解压、`-JdkUrl` 下载，或 `-JavaHome` 给已有 JDK 21 做目录联接（不复制） |
| `server/server.jar` | `.gitignore` 排除 `*.jar` | 读仓库里的 `server/.paper-url` 下载，并用 URL 段里的 **sha256** 校验；`-JarFile` 可离线 |
| `server/server.properties` | 只跟踪 `server.properties.example`（真文件含 RCON 口令） | 从 `.example` 生成，并把 `rcon.password=CHANGE_ME` 换成随机 32 位十六进制 |

三条都是**幂等**的：已经就绪就只做体检、不覆盖（`server.jar` 指纹不符时拒绝覆盖，除非 `-Force`）。
`-DryRun` 只打印计划、不下载不写文件。想审计这条链只需两条命令：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/provision.ps1 -DryRun   # 应打印三项 OK（已是可跑状态）
```

## 备份与恢复（手动 / 自动 / 演练）

备份是**冷备**：先优雅关服再备。运行期 Paper 独占 `world/session.lock` 并缓存 `region/*.mca`，
热备物理上不可能一致（脚本检测到服务端在跑会直接拒绝，退出码 2）。

| 场景 | 命令 |
|---|---|
| 手动备一次（**先关服**） | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup-world.ps1` |
| 想连明文 RCON 口令一起备 | 上面加 `-IncludeSecrets`（默认**不带**，见下） |
| 校验一份备份是否完整 | `powershell -File scripts\verify-world-backup.ps1 -BackupDir backups\world-<时间戳>` |
| 真恢复到临时服演练 | `powershell -File scripts\restore-drill.ps1 -BackupDir backups\world-<时间戳>` |
| 注册每日兜底计划任务 | `powershell -File scripts\install-backup-task.ps1` |
| 停服后自动备份 | 自动：`stop-panel.ps1` 确认 java 已退出后触发 |

### 配置只有一份：`config/backup.json` —— 手动备份也读它

**R6 #7-②**：以前这份配置只在 `-FromConfig`（自动备份/计划任务）时被读，而 README 教的是裸跑，
于是**人工备份永远不读 `excludeSecrets`**，会产出含明文 RCON 口令的备份。现在：

| 字段 | 作用 | 手动备份是否生效 |
|---|---|---|
| `enabled` | 自动备份总开关（`false` ⇒ 停服不备、计划任务跳过） | **不拦**手动备份（手动=你明确要求） |
| `onServerStop` | 停服后自动备份（主路径） | 不适用 |
| `dailyAt` | 每日计划任务的时刻 | 不适用 |
| `keep` | 保留最近几份（只清理带 `manifest.json` 的目录） | 生效（`-Keep` 可覆盖） |
| `excludeSecrets` | 备份里是否抹空 `rcon.password`（默认 `true`） | **生效**（`-ExcludeSecrets` / `-IncludeSecrets` 可覆盖） |

也就是说：**裸跑 `backup-world.ps1` 现在会自动抹掉 RCON 口令**（`server.properties` 其余设置全保留，
恢复后按 manifest 的 `redacted` 填回口令即可）。真要带明文口令备份，必须显式 `-IncludeSecrets`，
此时脚本会警告"备份目录属敏感数据"，manifest 记 `containsSecrets=true`。
两个参数同时给会直接失败（退出码 1）—— 不猜你想要哪个。

每份备份的 `manifest.json` 里有 `secretsPolicy` 记录本次口令策略的来源
（`config/backup.json` / 命令行），恢复者能回答"这份备份为什么带/不带口令"。


## 从干净检出到可运行镜像（发布路径）

第四轮审计 ④ 的问题就是这条路径不可复现：`web-dist/` 从未入库、HEAD 的 Dockerfile 没有
`COPY web-dist`、mindserver 只查 `/web/dist` —— 干净克隆要么构建失败，要么镜像里 `/console` 静默 404。
现在这条路径被一条命令管住：

```powershell
# 1) 两个仓都 clone —— 用上面第 1 条命令（scripts/clone-all.ps1），它会连子仓一起拉

# 2) 一条命令：构建前端 → 同步固化产物 → 校验清单/源码指纹 → docker build
#    → 起容器 → 断言 /console 与首个静态资源均 200 → 清理
pwsh scripts/release.ps1
```

常用变体：

| 命令 | 作用 | 耗时 |
|---|---|---|
| `pwsh scripts/release.ps1` | 全链路（含镜像与运行时 200 断言） | 首次几分钟（apt/npm 有缓存后更快） |
| `pwsh scripts/release.ps1 -SkipDocker` | 只刷新 `mindcraft/web-dist` 并校验，不建镜像 | 秒级~1 分钟 |
| `pwsh scripts/release.ps1 -VerifyOnly` | 只校验"产物 ↔ 清单 ↔ 源码指纹"是否一致 | 秒级 |
| `pwsh scripts/release.ps1 -DockerExe 'wsl -e sudo docker' -ProbeExe 'wsl -e curl'` | 本机只有 WSL 里的 docker 时 | 同上 |

### 为什么构建期会拦住"缺产物"

`mindcraft/Dockerfile` 在 `COPY web-dist ./web-dist` 之后有一段 `RUN` 做硬校验：
缺 `index.html`/`MANIFEST.json`、文件与清单 sha256 不符、`index.html` 引用了产物里不存在的
chunk、或产物目录里有清单未记录的野文件 ⇒ **docker build 直接失败**。
所以"删掉 `web-dist/` 再构建"得到的是一条明确报错，而不是一个 `/console` 404 的镜像。

产物本身的指纹与生成时间记在 `mindcraft/web-dist/MANIFEST.json`
（`source.hash` = 源码指纹，`artifact.hash` = 产物指纹，`generatedAt` = 生成时间），
字段说明见 `mindcraft/web-dist/README.md`。

### 发布纪律

- 改过 `web/`（前端源码）之后**必须**重跑 `scripts/release.ps1 -SkipDocker` 并把
  `mindcraft/web-dist/**` 一起提交，否则镜像里的控制台是旧版本，`-VerifyOnly` 会红。
- 要发布"某次提交"的产物、而工作树里还有别人的改动时：
  `git worktree add tmp/rel-src <ref>` 然后用 `-SourceRoot tmp/rel-src/web`。
- 推送远端需要人工确认——脚本只做本地构建与自检，不推送。
