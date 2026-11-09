# 运维 / 部署 / 备份恢复 缺陷扫描（R6 · ops 席）

> 范围：父仓 `scripts/`（12 个 .ps1 + `lib/`）、根目录 3 个 `.bat`、`mindcraft/Dockerfile`、`mindcraft/docker-compose.yml`、`web/` 构建配置，以及它们所依赖的运行时代码（`mindcraft/src/mindcraft/mindserver.js`、`mindcraft/src/mindcraft/auth_gate.js`、`web/scripts/stop-all.mjs`）。
> 约束：**未修改任何产品代码**；未起 Minecraft 服务、未改 `server/`、`server-test/` 存档；临时文件只写 `tmp/bat-probe/`（已 gitignore）与 `docs/audit-r6/`。
> 日期：2026-11-09 22:31–23:15 (+08:00)。
> 环境：Windows + **无 pwsh**（只有 PowerShell 5.1.26100.9711）、node v24.16.0、python 3.14.6、无 docker。
> 证据目录：`docs/audit-r6/evidence/ops/`（每个结论对应一条可复跑命令）。

---

## 1. 一句话结论

**发布链（release.ps1 -VerifyOnly）是这条链上唯一"真的能证伪"的环节**；备份链"能证明自己完整"（137 条断言）、但**证明不了"恢复出一台能跑的原服务器"**；而**从零部署这一整段没有可执行路径**——干净 clone 里没有 JDK、没有 server.jar、没有 server.properties，README 的"3 条命令"到 `npm ci` 就断了，且**没装 `web/node_modules` 会让「停止面板.bat」根本无法运行**（只能强关窗口 = 存档未刷盘风险）。

判定口径：`CONFIRMED` = 本次实测/静态取证成立；`LATENT` = 结构上会分叉，当前状态恰好一致。

---

## 2. 本次实测（全部只读，退出码原样）

| # | 命令 | 退出码 | 结论 | 证据 |
|---|---|---|---|---|
| 1 | `powershell -File scripts/release.ps1 -VerifyOnly` | **0** | 产物↔清单↔源码三方一致（13 产物文件 / 29 源文件） | `evidence/ops/release-verifyonly.log` |
| 2 | `powershell -File scripts/start-panel.ps1 -DryRun` | **0** | 前置检查通过、零 spawn；但见 OPS-R6-03/04（它证明的是"本机已经有 JDK/jar/node"） | `evidence/ops/start-panel-dryrun.log` |
| 3 | `powershell -File scripts/verify-world-backup.ps1 -BackupDir backups/world-20261109-043001` | **0** | **137 条断言全过** | `evidence/ops/verify-backup-latest.log` |
| 4 | `powershell -File scripts/restore-drill.ps1 -BackupDir backups/does-not-exist` | **1** | 前置分支能在起服前拦下（不产生副作用） | `evidence/ops/restore-drill-precheck.log` |
| 5 | `powershell -File scripts/install-backup-task.ps1 -WhatIf` | **0** | 任务定义可打印（未注册）；见 OPS-R6-16 | `evidence/ops/install-task-whatif.log` |
| 6 | `powershell -File scripts/harden-credentials-acl.ps1`（默认 = 只体检） | **0** | 4 个目标文件均为「非继承 + 3 条 FullControl」 | `evidence/ops/harden-acl-check.log` |
| 7 | `node scripts/tests/ops-regression.mjs` | **0** | 29/29 | `evidence/ops/ops-regression.log` |
| 8 | `node scripts/tests/acl-regression.mjs` | **0** | 31/31 | `evidence/ops/acl-regression.log` |
| 9 | `.bat` 退出码透传探针（同构于两个面板 .bat） | — | 内层 `exit 5` → `.bat` 返回 **5**；`exit 0` → **0** | `evidence/ops/bat-exitcode-probe.log` |

**读完 7/8 要立刻记住一句话**：门禁全绿 ≠ 这些脚本对，它们是**文本正则断言**（`ops-regression.mjs:32` 的 `readSrc()` + 正则匹配源码字符串，如 `:111-120`）。本报告里一半以上的缺陷都活在这套门禁的盲区（见 OPS-R6-18）。

---

## 3. 缺陷清单（按严重度）

### P0 —— 从零部署走不通，或会直接导致存档风险

#### OPS-R6-01 从零 clone 之后没有"能跑的服务端"，而部署文档到此为止 —— CONFIRMED
- **位置**：`README.md`「从零开始（3 条命令）」、`scripts/clone-all.ps1:383-398`、`scripts/start-panel.ps1:181-183`
- **现象**：干净 clone 里**根本没有**跑起来所需的三件硬前置：
  - `.tools/`（JDK）——`.gitignore:46`，`git ls-files` 里 0 个文件
  - `server/server.jar` / `paper-*.jar` ——`.gitignore:47` 的 `*.jar`
  - `server/server.properties` ——`.gitignore:74`，仓库只跟踪 `server.properties.example`
  - `server/world*`、`server/plugins/` ——`.gitignore:58-66`
  - `git ls-files server | wc -l` = **11**（只有 yml/json/example 一类文本）
- **影响**：新机器照 README 执行完 3 条命令，`clone-all` 打印的"下一步"（`:383-398`）只有 `release.ps1 -VerifyOnly` / `npm ci` / docker，**从不提**装 JDK、放 `server.jar`、从 `.example` 生成 `server.properties`。随后双击「启动面板.bat」必然停在 `[错误] 找不到 JDK（.tools\jdk-*\bin\java.exe）` 或 `[错误] 找不到 server\server.jar`（`start-panel.ps1:181-183`）。唯一的"供给线索"是 `server/.paper-url` 里一条 Paper 下载 URL——没有任何脚本读它。
- **为什么没被发现**：`-DryRun` 与所有回归都跑在**已经装好**的这台机器上，绿得毫无意义。
- **建议**：加一个 `scripts/provision.ps1`（读 `.paper-url` 下载 jar、校验 sha、把 JDK 解到 `.tools/`、从 `server.properties.example` 生成 `server.properties`），并在 `clone-all` 的"下一步"里显式排进去；`start-panel` 的报错应指向该脚本而不是让人自己猜。

#### OPS-R6-02 按文档装依赖会漏掉 `web/node_modules`，于是「停止面板.bat」根本无法运行 —— CONFIRMED
- **位置**：`README.md` 第 2 步（只有 `cd mindcraft; npm ci`）、`web/scripts/stop-all.mjs:14`、`scripts/stop-panel.ps1:19-25`、`scripts/start-panel.ps1:187-190`
- **现象**：`stop-all.mjs` 用 ESM `import { io } from 'socket.io-client'`，解析基准是 `web/scripts/`，因此**必须有 `web/node_modules`**；而 README 只让装 `mindcraft` 的依赖。缺依赖时 `node stop-all.mjs` 立刻 `ERR_MODULE_NOT_FOUND` → 退出码 1 → `stop-panel.ps1:43-46` 打印"[未完成] stop-all.mjs 以退出码 1 结束"，但给的建议是"看上面对输出"，不是"去 `web/` 装依赖"。
- **同一根因的第二处**：`start-panel.ps1:187-190` 发现 `web/node_modules/vite` 不存在时只 `Write-Warn2 '跳过'`，然后**继续**起服、打印"已启动完成"、并打开 `http://localhost:8080/console?token=…` → 用户看到 404/unauthorized，而脚本认为自己成功。
- **影响**：优雅关服链断 ⇒ 用户只能关窗口/杀进程 ⇒ 存档未刷盘（这正是 `stop-panel.ps1:17-18,35-42` 反复警告的场景）。这是"部署先决条件没检查"造成的数据风险，不只是体验问题。
- **建议**：README 增加 `cd web; npm ci`；`stop-panel.ps1` 在调用前预检 `web/node_modules/socket.io-client` 并给出确切修复命令；`start-panel` 把"缺 web 依赖"从 WARN 升级为**拒绝启动**（或至少不打印"启动完成"）。

### P1 —— 会给出错误的成功信号，或"可恢复"的承诺不成立

#### OPS-R6-03 `start-panel.ps1` 有三条"没成功也报成功"的路径 —— CONFIRMED

| 分支 | 位置 | 实际行为 | 后果 |
|---|---|---|---|
| 面板构建失败 | `:191-200` | `& $node $vite build 2>&1 \| Out-Null` 吞掉全部构建输出，非 0 只 `Write-Warn2 '[警告] 构建失败，将沿用上一次的 dist'` | 改过前端但构建失败 → 服务的是旧 UI，脚本仍报"已启动完成" |
| bot 没进游戏 | `:157-159`（`Wait-BotSpawned`） | 120s 超时后 `Write-Warn2 '[提示] …先打开面板看看'` 然后 **`return $true`** | 调用点 `:305` 的 `if (-not (Wait-BotSpawned 120)) { exit 1 }` **永不触发**；失败被降级成提示 |
| 端口被别人占 | `:205`、`:243` | 只要 127.0.0.1:25565 / :8080 **有监听**就 `Write-Ok '已在运行，跳过'` | 8080 被别的服务占 ⇒ 面板实际不是本项目；脚本仍打开该 URL 并宣布成功。反向：本项目端口被改到 25566 时，脚本会去起第二个服 |

- **判定**：CONFIRMED（静态，行号可查）。`-DryRun` 的绿不代表这些分支正确。
- **建议**：构建失败应 `exit 1`；`Wait-BotSpawned` 超时应返回 `$false`；端口预检改为"探测该端口是不是**本项目的进程**"（`start-panel` 已有 `Get-ServerJava` 这种按绝对路径匹配的正确做法，可复用）。

#### OPS-R6-04 握手 token 长度被硬编码成 36，非 36 就永远打不开面板 —— CONFIRMED（且本机现存反例）
- **位置**：`scripts/start-panel.ps1:328-353`（`:335` `if ($t.Length -eq 36)`）
- **现象**：注释称"`crypto.randomUUID()` 恒为 36 字符，零成本的决定性判断"，但 token 的**唯一来源**是 `mindserver.js:793` 的 `process.env.MINDSERVER_TOKEN || makeToken()`——环境变量可被设成任意长度（`auth_gate.js:43-46` 明确支持；`docker-compose.yml:18` 自己就推荐 `openssl rand -hex 24` = **48 字符**）。
- **本机反例**：`mindcraft/.mindserver-token` 当前内容是 **9 字节**（非 UUID、非 hex48，形如 `a99-aaaaa`），说明该文件完全可能是残留/非标准值。此时 `start-panel` 重试 20×500ms 后走 `:339-353`：打印"拿不到握手 token → 没有打开面板"并 `exit 1`——**而服务其实已经起来了**（脚本自己也在 `:349-350` 承认这点）。
- **影响**：任何自定义 `MINDSERVER_TOKEN`、任何中途残留的 token 文件，都会让"一键启动"以红色失败收场，且把人往"权限/工作目录"方向带。
- **建议**：改为"非空 + 长度 8..256 且无空白"的宽松判据（截断检测真正需要的是"文件仍在增长"，不是定长）。

#### OPS-R6-05 `stop-all.mjs` 用固定 1.5s 等待把"连不上"判成"没在跑"，并 exit 0 —— CONFIRMED
- **位置**：`web/scripts/stop-all.mjs:68-81`
- **现象**：`await sleep(1500)` → 若此刻 `connected === false` → `console.log('mindserver 没在跑（8080 连不上），不用停。')` → `process.exit(0)`。没有重试、没有区分 `ECONNREFUSED`（真的没跑）与"连上了但握手慢/事件循环被长任务卡住"。
- **影响**：`stop-panel.ps1:61` 的 `if ($stopCode -eq 0)` 会认为"已停"→ 打印"完成"→ 退出码 0 → **并继续走停服后自动备份**（`stop-panel.ps1:61-88`）。若 MC 其实还在跑，`backup-world` 会以 exit 2 拒绝（这一层有兜底，`:195-198` 记 SKIP），但"已停止"这个**对外承诺是假的**；用户/快捷方式/计划任务看到的都是成功。
- **建议**：只有 `connect_error` 的 `ECONNREFUSED` 才能判"没跑"，其余重试到 10–15s；`shutdown` 之后同样要确认 8080 关闭（现在 `:146-152` 是 `emit` → `sleep 4000` → `exit 0`，**不确认**）。

#### OPS-R6-06 自动备份默认不含 `server.properties`，恢复后"优雅关服"直接失效 —— CONFIRMED
- **位置**：`config/backup.json`（`"excludeSecrets": true`）、`scripts/backup-world.ps1:116,649-652,833`、`scripts/stop-panel.ps1:39-41`、`scripts/lib/backup_config.ps1:17`
- **现象**：默认开关下 `server-config.zip` **不含** `server/server.properties`（本次实测的 manifest 明确记录 `server/server.properties：-ExcludeSecrets…不备份`）。而该文件承载 `enable-rcon / rcon.port / rcon.password / white-list / online-mode / server-port / level-name`。
- **影响链**：恢复 → 没有 `server.properties`（或只有 `.example` 的默认值）→ RCON 未启用 ⇒ `stop-all` 的 `server-stop` 返回 `rcon_disabled` ⇒ 按 `stop-policy.mjs:38-41` 判 **fail** ⇒ `stop-panel` 退出码 4、管理端保持运行 ⇒ 用户只能强关窗口 ⇒ 存档未刷盘风险。同时 `online-mode / white-list` 回到默认，局域网准入策略静默变化。
- **讽刺点**：`backup-world.ps1:43-45` 的注释本来写的是"默认**备份**（否则恢复出来的服务器没有 RCON/权限）"，但发版默认值反了。
- **建议**：二选一并写进恢复手册——(a) 默认备份 `server.properties`，恢复时提示立刻轮换 RCON 口令；(b) 保持排除，但在 manifest 里输出一份"恢复后必须手工重建的键值清单"（键名 + 占位，不含值），否则"恢复"是个半成品。

#### OPS-R6-07 备份不记录插件 jar 的名单/版本 ⇒ 恢复不可重现 —— CONFIRMED
- **位置**：`scripts/backup-world.ps1:214`（`*.jar：插件/服务端 jar 可重新下载（约 53MB），恢复时按同名部署即可`）、`:729-732`（只累计条数）
- **现象**：`server/plugins/` 下现有 **6 个 jar**（`Chunky`、`ChunkyBorder`、`CoreProtect-CE-24.1`、`OnePlayerSleep`、`SkinsRestorer`、`bluemap-5.16-paper`），全部因 `*.jar` 规则被排除；manifest 的 `excluded` 只有 **`files: 10`** 这个计数，**没有任何一个 jar 文件名或版本**。
- **影响**：manifest 承诺"按同名部署即可"——但"同名"是什么名字？恢复者只能靠记忆或去翻旧机器。`plugins/` 的配置与 CoreProtect 数据库在包里，插件本体不在，**配置与插件版本错配**的风险也没人管。
- **建议**：在 manifest 增加 `plugins.required[] = [{file, bytes, sha256}]`（只记元数据，不装箱），恢复脚本据此下载/校验；`verify-world-backup.ps1` 可顺带断言"名单非空"。

#### OPS-R6-08 `restore-drill.ps1` 的"12 条断言"证明不了"备份能恢复" —— CONFIRMED
- **位置**：`scripts/restore-drill.ps1:342-356`（只解压 `world` 与 `bots`）、`:322-340`（自造 server.properties）、`:18-32`（12 条断言清单）
- **现象**：`switch ($e.kind)` 只有 `'world'` 和 `'bots'` 两个分支，`plugins` / `server-config` / `logs` **一律不还原**。演练起的是一台**无插件**的 Paper。
- **因此以下事情演练一条都没验**：
  - `CoreProtect/database.db`（VACUUM 快照）能否打开、`integrity_check` 是否 ok —— 只有 `board.sqlite` 被验；
  - 6 个插件能否加载（`plugins.zip` 里只有配置）；
  - 恢复后的 `server.properties` 是否可用（演练用的是自己生成的，不是备份里的）；
  - `server-config.zip` 里的 `ops.json/whitelist.json` 能否被 Paper 接受。
- **影响**：`report.json` 的 `verdict=PASS` 会被读成"这个备份能恢复成原服务器"，实际上只等于"世界与机器人记忆能在一台裸服上加载"。这是**过度承诺**，比没有演练更危险（`verify-world-backup.ps1` 的 137 条断言同样是"包内自洽"，不含"能起服"）。
- **建议**：把 `plugins` 也解压进演练目录（jar 缺失时降级为 WARN 并显式声明"未验证插件加载"），`server-config` 解压后至少断言 `server.properties` 能被 Paper 解析（端口改成隔离端口再起）；报告里的 verdict 拆成 `dataRestorable` / `serviceRestorable` 两级。

#### OPS-R6-09 恢复演练把最有用的失败证据删掉了，且报告指向一个不存在的路径 —— CONFIRMED
- **位置**：`scripts/restore-drill.ps1:478-483`（`-RedirectStandardOutput $serverDir/boot.out`、`boot.err`）、`:204`（`javaOut = 'logs/boot.out'`）、`:557-569`（清理时删掉 `$drillRoot` 下除 `report.json/report.md/logs` 之外的一切，包含整个 `server/`）
- **现象**：`boot.out`/`boot.err` 实际落在 `tmp/drill-*/server/`，而清理只把 `server/logs/*` 拷到 `drillRoot/logs/`。于是：**没起服时**（最需要证据的场景）`boot.out` 被删；`report.json` 的 `evidence.javaOut` 永远指向 `logs/boot.out`——这个文件**从来不存在**。
- **影响**：起服失败（Java 版本不对、插件冲突、内存不足）时，用户拿到的是一份"断言 10 FAIL / 超时"的报告 + 一句"java 是否已退出=False"，没有任何 Java 侧堆栈。
- **建议**：把 `boot.out`/`boot.err` 一并搬进 `drillRoot/logs/`（或直接重定向到那里），并让 `evidence` 字段只在文件真实存在时才写路径。

#### OPS-R6-10 「收紧RCON.bat」的退出码与"已收紧"无关，且该防护无法被任何脚本验证 —— CONFIRMED
- **位置**：`收紧RCON.bat:38-52`、`scripts/deny-rcon-25575-in.ps1:45-54,71-72`
- **现象**：`.bat` 用 `Start-Process -Verb RunAs` 拉起提权窗口，只要**进程拉起来了**就 `exit 0`（并 `timeout /t 4`）；内层 `netsh` 失败（组策略禁用、规则冲突、被安全软件拦）只会显示在那个即将关闭的窗口里。因此"双击 → 退出码 0"**不等于**"25575 已被拦"。
- **更难的部分**：`deny-rcon-25575-in.ps1:21-22` 自己承认"防火墙规则不入库、换机失效、无法用 git diff 证明"。而 `server.properties` 是 `server-ip=`（空 ⇒ RCON 监听 **0.0.0.0:25575**，明文口令在同文件 `:46`）——**唯一的暴露缓解就是这条需要人工执行、换机即失效、且没有任何脚本会检查它是否存在的规则**。
- **建议**：加只读自检 `Get-NetFirewallRule -DisplayName 'deny-rcon-25575-in'`，放进 `start-panel` 的前置检查（不拦就 WARN 并留痕）；`.bat` 的退出码改成提权进程的真实退出码（`Start-Process -Wait -PassThru` 后 `exit $p.ExitCode`）。

### P2 —— 局部缺陷 / 结构性分叉（今天不疼，明天疼）

#### OPS-R6-11 发布链校验的产物 **不是** 本机实际被服务的产物 —— LATENT（今天字节一致）
- **位置**：`mindcraft/src/mindcraft/mindserver.js:1130-1140`（候选顺序 `$WEB_DIST` → `<repo>/web/dist` → `/app/web-dist`）、`scripts/release.ps1:229-232`（只校验 `mindcraft/web-dist`）、`scripts/start-panel.ps1:187-200`（直接 `node vite.js build` 到 `web/dist`）
- **现象**：本机跑面板时 mindserver **优先**命中 `web/dist`（仓库根，gitignored，`release.ps1` 从不校验），而不是 `mindcraft/web-dist`（唯一被 stamp 与校验的产物）。本次实测两者恰好**逐字节相同**（`index.html` sha256 均为 `b621ac6c…`，assets 名字集合相同）——因为它们是同一次构建后同步的。
- **分叉条件**（满足任一即分叉）：① 改了 `web/` 但只跑 `start-panel`（它只重建 `web/dist`）；② `start-panel` 构建失败（OPS-R6-03）留下旧 `web/dist`；③ 有人只跑 `release.ps1 -VerifyOnly` 就以为"本机 UI 没问题"。
- **影响**：`release.ps1 -VerifyOnly` 的 ALL PASS 证明的是"镜像用的产物与源码一致"，**不能**推断"你现在打开的面板是这个版本"。
- **建议**：`start-panel` 改为调用 `release.ps1 -SkipDocker`（同一套构建+同步+绑定），或让 mindserver 的本地候选顺序与发布产物统一为 `web-dist`。

#### OPS-R6-12 同一份 `MANIFEST.json` 有两个写者，口径不同 —— CONFIRMED
- **位置**：`mindcraft/tools/sync_web_dist.mjs:96-105`（重写为 `{generatedFrom, note, files}`，**不含** `source/artifact/entryAssets`）、`scripts/release.ps1:354-482`（临时助手才写这些字段）、`scripts/release.ps1:445-448`（读到旧格式就 `bad()`）
- **现象**：`sync_web_dist.mjs` 自己的文件头用法写着"改过 `web/` 之后必须跑：`npm run build` → `node ../mindcraft/tools/sync_web_dist.mjs`"；但单独跑它会把 `release.ps1` 的元数据**抹掉**，此后 `release.ps1 -VerifyOnly` 直接红（"清单是旧格式"）。`release.ps1` 里则写着"不要只跑 tools/sync_web_dist.mjs"——**两个工具互相否对方的使用方式**，谁都没强制。
- **影响**：漂移检测的"绑定"（`source.hash`）能被一条合规的同步命令静默删除；且 `mindcraft` 子仓每次 stamp 都会重写 `generatedAt` → 每次发布都产生 dirty 工作树。
- **建议**：让 `sync_web_dist.mjs` 读旧 manifest 并**保留** `source/artifact/entryAssets`（或直接接受 `--stamp` 参数）；单一写者。

#### OPS-R6-13 `backup-world.ps1 -FromConfig` 在"总开关关闭"时 `exit 0`，上层会记"备份成功" —— CONFIRMED
- **位置**：`scripts/backup-world.ps1:110-114`（`enabled=false` → 打印 SKIP → `exit 0`）、`scripts/lib/backup_config.ps1:192-201`（`exitCode -eq 0` → 记 `OK '停服后自动备份成功'`）
- **影响**：`logs/backup-auto.log` 里会同时出现 `SKIP 总开关 enabled=false` 和 `OK 停服后自动备份成功`；退出码无法区分"关掉了"与"备成了"。运维只能靠读日志判断。
- **建议**：为"跳过"分配独立退出码（如 3），或让 `Invoke-BackupOnServerStop` 以 `logs/backup-auto.log` 的最后一行为准而不是只看退出码。

#### OPS-R6-14 Docker 路径缺前置检查，且有一个端口与 drill 相撞 —— CONFIRMED（静态）
- **位置**：`mindcraft/docker-compose.yml:21-25`（bind-mount `./settings.js`、`./keys.json`、`./profiles`、`./bots`）、`:44`（`"25568:25568"`）、`mindcraft/Dockerfile:107`（`CMD ["npm","start"]`）
- **三处问题**：
  1. 宿主缺 `keys.json` / `profiles/` / `settings.js` 时，**docker 会把不存在的源路径创建成目录**（compose 的既有行为）→ 容器内 `readFileSync('/app/keys.json')` 得到 EISDIR，报错文本像"文件坏了"而不像"你没建这个文件"。compose 里没有任何 precheck（`MINDSERVER_TOKEN` 有 `:?` 是唯一的强制项，这一点做得对）。
  2. `viaproxy` 把 **25568 发布到 0.0.0.0**（`:44` 没写 `127.0.0.1:`），与同文件 `:27-35` 反复强调的"只绑回环"口径直接冲突；并且 25568 正是 `restore-drill.ps1:68` 的默认 `-RconPort` ⇒ 该 profile 一开，恢复演练的端口预检必然报"端口 25568 已被占用"。
  3. `CMD ["npm","start"]` 让 **PID 1 是 npm**，`docker stop` 的 SIGTERM 未必转发给 `node`；而 `mindserver.js:1764` 的优雅关停挂在 node 的 SIGINT/SIGTERM 上 ⇒ 可能走不到 `shutdownOnce()`（agent 子进程变孤儿、`.mindserver-token` 不删，破坏 `F-RT-003` 的前提）。另外镜像以 **root** 运行、无 `HEALTHCHECK`、基础镜像只用 tag 不用 digest。
- **建议**：`CMD ["node","main.js"]`；25568 加 `127.0.0.1:` 前缀或改成可选 profile 的独立端口；compose 前置用 entrypoint/compose 侧 `test -f` 检查；加 `USER node`。

#### OPS-R6-15 `e2e.ps1` 的预检漏端口、JDK 选择不确定、junction 清理不对称 —— CONFIRMED
- **位置**：`scripts/e2e.ps1:494`（只查 `$MC_PORT`）、`:72`（`$MS_PORT = 18093` 只在注释里被"使用"）、`:104-109`（`Resolve-Java` 取 `$cands[0]`，未排序）、`:116`（`Remove-Item -Recurse -Force $runDir`）vs `:536-545`（正常收尾特意用 `cmd /c rmdir` 摘 junction）
- **三条**：
  1. `25576`（RCON）与 `18093`（t37 内置 mindserver）**不做占用预检** ⇒ 撞端口的失败会伪装成"起服超时/RCON 未就绪"，白等 3 分钟超时。r5 已记，仍在。
  2. 多 JDK 时 `Get-ChildItem .tools -Filter 'jdk*' | Select [0]` 顺序不确定；Paper 1.21.8 需要 **Java 21**，拿到 17 就是 `UnsupportedClassVersionError`，而报错只说"起服超时"。
  3. `New-RunDir` 用 `Remove-Item -Recurse` 清上一轮运行目录，但该目录里可能有**指向 `server-test/` 的 junction**（`libraries/versions/cache`，`:130-136`）。Windows PowerShell 5.1 的 `Remove-Item -Recurse` 有跟随 reparse point 删穿目标的已知行为——正常收尾之所以特意改用 `cmd /c rmdir`（`:537-542`）说明作者知道这个坑，但**异常路径**（`Stop-E2E` 直接 `exit 1`）会把 junction 留到下一轮。
- **建议**：预检三个端口；`Resolve-Java` 按版本号数值排序并断言 `major -ge 21`；`New-RunDir` 也走 `rmdir` 摘链（或把 junction 建在独立子目录、永不 `-Recurse`）。

#### OPS-R6-16 计划任务只证"注册成功"，不证"真能跑" —— CONFIRMED
- **位置**：`scripts/install-backup-task.ps1:104-111`（`-LogonType Interactive`、无 `-WakeToRun`）、`:137-146`（回读只看 `State/NextRunTime/Triggers`，**不看 `LastTaskResult`**）
- **影响**："每日兜底备份"的存在性可证、有效性不可证；`Interactive` 意味着**重启后未登录就不跑**，而"服务端一直开着"恰恰是它要兜的场景。注册完也没有"立即跑一次并校验 `backup-auto.log` 有新行"的动作。
- **建议**：注册后 `Start-ScheduledTask` 跑一次 + 等 30s 读 `LastTaskResult` 与 `logs/backup-auto.log`；`-LogonType` 至少提供 `S4U` 选项。

#### OPS-R6-17 凭据 ACL 加固的**覆盖面**不够（不是收口不严） —— CONFIRMED
- **位置**：`scripts/harden-credentials-acl.ps1:46-52`（只有 4 个文件 + `mindcraft/` 目录）
- **缺口**：
  - `mindcraft/profiles/*.json`（23 个，已被 git 跟踪）——`Dockerfile:101-103` 注释明确写"每个 bot 的人设 + permissions（**可能内嵌 API Key**）"，但它们不在加固列表里，走继承 ACL；
  - `mindcraft/.env*`（若存在）、`mindcraft/vault/*`（加密库 + salt）——不在列表；
  - `config/*.json`（`network.json` 里有准入策略、`backup.json` 有开关）——不在列表；
  - 本次实测 4 个目标文件**都已经是收口状态**（`evidence/ops/harden-acl-check.log`），所以这条是"覆盖面"问题，不是"现在漏着"。
- **建议**：把 `profiles/`、`.env*`、vault 纳入 `$fileTargets`（或至少纳入"体检"并输出 WARN），并把"体检发现过宽 ACE"接进 `start-panel` 前置检查。

#### OPS-R6-18 回归门禁是文本正则，掩盖了本报告 P0/P1 的全部问题 —— CONFIRMED
- **位置**：`scripts/tests/ops-regression.mjs:32,111-120`、`scripts/tests/acl-regression.mjs`（同类）
- **现象**：29/29 与 31/31 全绿的同时，OPS-R6-01~07 全部成立。断言形如 `check('…', /isPortOpen\(/.test(stopAll))`——证明"代码里出现了这个标识符"，不证明"这条路径正确"。例如 `OPS-002 stop-all 有端口探测` 绿了，但端口是**硬编码 25565**（`stop-all.mjs:98`，见 OPS-R6-19）。
- **建议**：把已有纯函数（`stop-policy.mjs` 是正确范式）扩展到端口判定/构建判定；对 `start-panel` 的三条假成功分支建立**行为**测试（`-DryRun` + 注入 fake `Test-Port`/fake vite 退出码）。

### P3 —— 观察项 / 一致性漂移

| ID | 问题 | 位置 | 影响 |
|---|---|---|---|
| OPS-R6-19 | `stop-all.mjs` 把 MC 端口硬编码为 25565（env 可覆盖，但 `stop-panel` 从不设），`isPortOpen` 只探 127.0.0.1 | `web/scripts/stop-all.mjs:98,101-108` | `server-port` 改过 → `waitServerExit` 立即判"已退出" → 关掉管理端但 MC 仍在跑；反向：别的程序占 25565 → 等 45s 后误判关服失败 |
| OPS-R6-20 | 冷备的"服务端在跑"判据用 `server\.jar\|paper\|spigot\|bukkit` 匹配**任意** java 命令行 | `scripts/backup-world.ps1:167-177` | 同机别的 Paper 服/IDE 工程名含 `paper` → 冷备被拒（exit 2）。`start-panel` 已按项目绝对路径修过同类问题（OPS-009），备份脚本没跟上 |
| OPS-R6-21 | 三处 JDK 选择策略各不相同且都不校验版本 | `start-panel.ps1:162-172`（首个 `jdk*`）、`restore-drill.ps1:159-173`（名字**降序**首个）、`e2e.ps1:104-109`（首个） | 多 JDK 机器上三者可能选中不同版本；`jdk-9` 会排在 `jdk-21` 前面（字符串降序） |
| OPS-R6-22 | 文档/脚本示例统一写 `pwsh`，而默认 Windows 只有 `powershell`；本机 `where pwsh` 为空 | `README.md`、`clone-all.ps1:44-53,383-398`、各脚本 `.EXAMPLE` | 从零用户照抄 → `pwsh : 不是内部或外部命令`。`clone-all.ps1` 有 `#Requires -Version 5.1`，本可跑 5.1；`.bat` 里反而正确用了 `powershell` |
| OPS-R6-23 | `release.ps1` 步号是 `[1/8]…[8/8]`，但 `-VerifyOnly` 在第 4 步 `exit 0`、`-SkipDocker` 在第 5 步；清理阶段无条件 `docker rmi -f $ImageTag` | `scripts/release.ps1:95,500-514,652-655` | 输出误导；`rmi -f` 会删掉用户可能想保留的同名镜像（默认 `-KeepImage` 关） |
| OPS-R6-24 | 备份保留策略是**永久删除**，且按目录 `LastWriteTime` 排序 | `scripts/backup-world.ps1:890-899` | `keep=7` 之外直接 `Remove-Item -Force`（无回收站）；目录 mtime 被外部工具改动时可能删错对象 |
| OPS-R6-25 | `config/backup.json.bak-20261109123232` 留在 `config/` 里 | `config/` | 读取逻辑只认 `backup.json`；死副本 ⇒ 将来有人改副本、"改配置没反应"，且该目录无 cleanup |
| OPS-R6-26 | 冷备一致性判据是 `(size, mtime)`，不是内容哈希 | `scripts/backup-world.ps1:189-193,705-727` | 同秒同大小的覆写会漏检；概率低，但"零变更"的说法比实现强 |
| OPS-R6-27 | `backup-world` 的 SQLite 快照依赖 `node:sqlite` 或 `python`，但**没有版本/能力预检** | `scripts/backup-world.ps1:287-307,313-315` | 本机 v24.16.0 + Python 3.14.6 都可用；Node 22.x 早期版本 `node:sqlite` 需 `--experimental-sqlite`，无 python 时整份冷备 `throw`（失败后才说"node:sqlite / python 都可用吗？"） |
| OPS-R6-28 | 脚本里有多处 `Read-Host` 收尾（`stop-panel.ps1:90`、`start-panel.ps1:370`、两处失败分支） | 同上 | 在计划任务/自动化/无控制台会话中会**永久阻塞**；`install-backup-task` 绕过它直接调 `backup-world` 是唯一没踩的路径 |

---

## 4. 每个脚本「它到底保证什么」（一句话）

| 脚本 | 保证 | 不保证 |
|---|---|---|
| `启动面板.bat` / `停止面板.bat` | 把内层 `powershell -File` 的**退出码原样透传**（实测 5→5、0→0），失败时 `pause` 留住窗口 | 不检查 Node/JDK/依赖是否存在；不绕过 `Read-Host` 阻塞 |
| `收紧RCON.bat` | 能**拉起**一个提权的 `deny-rcon-25575-in.ps1` | **不保证**防火墙规则真的加上（`Start-Process` 一返回就 exit 0，OPS-R6-10） |
| `scripts/start-panel.ps1` | 在**这台机器**上：JDK/Node/jar 在预期位置 → 起 java+node → 等 `Done (` → 拿 token → 开浏览器；`-DryRun` 走完全部检查且零 spawn（实测 exit 0） | 不保证服务真的可用（构建失败/bot 超时/端口被占都算成功，OPS-R6-03）；不保证换机能跑（`D:\Node\node.exe` 硬编码，OPS-R6-01/22）；不保证非 36 位 token 时能打开（OPS-R6-04） |
| `scripts/stop-panel.ps1` | 把 `stop-all.mjs` 的 0/2/3/4 翻译成人话并**透传为进程退出码**（`:96`）；`java` 确认退出后才做冷备，备份失败不影响停服 | 不保证"exit 0 = 已停"（OPS-R6-05）；不保证缺 `web/node_modules` 时能跑（OPS-R6-02）；备份结果只进日志不进退出码（OPS-R6-13） |
| `web/scripts/stop-all.mjs` | 有 token 时：发 `server-stop`→**轮询端口确认退出**→`shutdown`；失败时非零退出且**不** `emit('shutdown')` | 不保证"连不上 = 没在跑"（1.5s 固定等待，OPS-R6-05）；不确认管理端真的退出（`:146-152`）；端口写死 25565（OPS-R6-19） |
| `scripts/release.ps1` | **本机**产物 ↔ `mindcraft/web-dist/MANIFEST.json` ↔ `web/` 源码指纹三方一致（`-VerifyOnly` 实测 exit 0）；全链路时还断言镜像内产物存在、`/console` 与首个 asset 均 200、HTML 引用了本次构建的 chunk | 不保证本机**正在被服务**的 UI 是这一份（`web/dist` 优先，OPS-R6-11）；不保证全新机器的 docker build 能过（本机无 docker，未跑）；不保证元数据不被 `sync_web_dist.mjs` 抹掉（OPS-R6-12） |
| `scripts/clone-all.ps1` | 两个仓都到位、都是 git 仓库、HEAD 与 `-Ref` 一致、子仓 `web-dist/MANIFEST.json` 随仓库到位；半成品状态显式报错而不是留下"只有父仓" | 不保证 clone 完**能跑**：不装 JDK、不下 `server.jar`、不生成 `server.properties`、不装 `web/node_modules`（OPS-R6-01/02）；`548` 与 Dockerfile 的 `549` 包数不一致 |
| `scripts/backup-world.ps1` | **冷备**：`java`/`session.lock` 在场就拒（exit 2）；先写 `.partial`、manifest 最后写、再原子 rename；每组件复制前后 `(size,mtime)` 零变更；活跃 SQLite 用 `VACUUM INTO` 取一致快照；zip 写完立刻反读做条目数/大小自检 | 不保证"恢复成原服务器"：不含 `*.jar`、默认不含 `server.properties`、不含 `keys.json`/`settings.js`/`config/`（OPS-R6-06/07）；不能告诉你该装哪些插件；`-FromConfig` 关闭时静默 `exit 0`（OPS-R6-13） |
| `scripts/verify-world-backup.ps1` | 备份**包内自洽**：非 `.partial`、`schemaVersion>=3`、逐文件字节/SHA256、zip 清单摘要、region/playerdata/bot 计数、`level.dat` 可 gunzip + 首字节 `0x0a`、每个 `.mca` 扇区表有 chunk、任务板 `integrity_check=ok` 且行数相符、`components` 每个都有包。本次 **137 条全过** | 不保证能起服、不保证插件能加载、不保证 `server-config` 里的配置可用；`plugins`/`server-config`/`logs` 缺失**不 FAIL**（只有 `world`/`bots` 是硬要求） |
| `scripts/restore-drill.ps1` | 在隔离端口(25567/25568)起一台**裸 Paper**，验证：包未损坏、世界 region/playerdata/level.dat 可读、任务板可打开且行数相符、bot `memory.json` 可解析、`Done (` 出现、日志 ERROR=0、RCON `stop` 后 `All chunks are saved`；产物只落 `tmp/drill-*` | 不还原 `plugins`/`server-config`/`logs`，因此**不证明**"原服务器能恢复"（OPS-R6-08）；失败时删掉 `boot.out/boot.err` 且报告路径写错（OPS-R6-09）；无 `-Precheck`，完整跑必然起真服 |
| `scripts/install-backup-task.ps1` | 用**当前用户**注册一个每日 `backup-world.ps1 -FromConfig` 的任务；注册失败如实 exit 1；`-Uninstall` 幂等；`-WhatIf` 只打印（实测 exit 0） | 不保证任务**真的会跑/跑成功**（不看 `LastTaskResult`、`Interactive` 依赖登录，OPS-R6-16） |
| `scripts/harden-credentials-acl.ps1` | 对 4 个指定文件把 DACL 收成"非继承 + 当前账户/SYSTEM/Administrators"，并**自检应用仍可读写**（否则 exit 5）；默认只体检，发现过宽 ACE 时 exit 3 | 不覆盖 `profiles/*.json`（可能内嵌 key）、`.env*`、vault、`config/`（OPS-R6-17）；不做周期性巡检（只在手动跑时有效） |
| `scripts/deny-rcon-25575-in.ps1` | 管理员下：先删同名规则再加"TCP 25575 入站阻断，profile=any"，并打印三步人工验证法 | 不保证规则存在性可被复核（自己承认换机失效）；不自动验证；`netsh` 失败只影响那个窗口 |
| `scripts/e2e.ps1` | 每场景独立运行目录、从 `test-template` 建干净世界、junction 复用 `server-test` 大件、起服→跑场景→优雅停→重置→逐文件 sha256 证明"重置生效"；`0 条断言`也判失败（`:576-578`） | 只预检 25566（漏 25576/18093）；JDK 选择不确定；异常退出留下 junction 且下一轮用 `Remove-Item -Recurse` 清理（OPS-R6-15） |
| `scripts/lib/rcon.ps1` | 正确的 MC RCON 协议：auth 正文是**密码**、id 校验、命令应答 id 校验、读不满/超时即失败；带重试 | 不保证服务器侧 `enable-rcon` 已开（由调用方判） |
| `scripts/lib/backup_config.ps1` | 配置缺失/损坏/字段非法一律**退回默认值 + 记 warning**，绝不让"配置坏了"变成"备份悄悄停了"；每次尝试都追加 `logs/backup-auto.log` | 不保证调用方按日志语义解读（OPS-R6-13） |
| `mindcraft/Dockerfile` | `npm ci`（按 lock 严格装）+ 显式 COPY 清单（不含 `.git`/token/keys/profiles）+ `COPY web-dist` + **构建期 RUN 硬校验**产物（缺 index/MANIFEST、sha 不符、refs 缺失、野文件 ⇒ build 失败） | 不保证可复现（base 用 tag 非 digest）；不带 `USER`/`HEALTHCHECK`；`CMD ["npm","start"]` 的信号转发问题（OPS-R6-14） |
| `mindcraft/docker-compose.yml` | 容器内 `MIND_SERVER_HOST=0.0.0.0`、宿主 `127.0.0.1:8080` 固定映射、`MINDSERVER_TOKEN` 缺失时 compose 直接报错（`:?`） | 不保证挂载源存在（缺 `keys.json` 会被建成目录）；`viaproxy` 的 25568 绑 0.0.0.0 且与 drill 撞端口（OPS-R6-14） |
| `web/vite.config.ts` + `package.json` | 生产 `base=/console/`、`outDir=dist`、`emptyOutDir`；dev 端口 5173 + `strictPort`；代理全用 `127.0.0.1`（避开 IPv6） | 不保证产物被同步/被校验（那是 `sync_web_dist.mjs` + `release.ps1` 的事）；`build` 只有 `vite build`，而 `start-panel` 绕过它直接调 `vite.js`（将来给 build 加 typecheck 门，本机面板路径不生效） |

---

## 5. 从零到"能玩"的断点图

```
干净 clone（两个仓）
  ├─ OK  release.ps1 -VerifyOnly ........ 产物/清单/源码一致（本机 exit 0）
  ├─ OK  clone-all.ps1 .................. 两仓到位 + web-dist 随仓库到位
  ├─ X   无 .tools/jdk-* ................ start-panel:181 [错误] 找不到 JDK           <- OPS-R6-01
  ├─ X   无 server/server.jar ........... start-panel:183 [错误] 找不到 server.jar    <- OPS-R6-01
  ├─ X   无 server/server.properties .... 只有 .example；RCON/白名单/端口没人生成     <- OPS-R6-01/06
  ├─ X   无 server/world*, server/plugins  服能起也是空世界、无插件                   <- OPS-R6-07/08
  ├─ X   无 web/node_modules ............ 面板构建静默跳过 + stop-panel 直接跑不起来  <- OPS-R6-02
  ├─ !   无防火墙规则 ................... 25575 裸奔（0.0.0.0）直到人工双击 .bat       <- OPS-R6-10
  └─ OK  mindcraft npm ci ............... 但 postinstall 依赖 patches/（已在库）
```

---

## 6. 发布链：同一条知识被写了 5 遍（分叉点）

| # | 拥有者 | 它认为"权威产物"在哪 | 它做的检查 |
|---|---|---|---|
| A | `web/vite.config.ts:7,39-43` | `web/dist`（base `/console/`） | 无 |
| B | `mindcraft/tools/sync_web_dist.mjs` | 把 `web/dist` → `mindcraft/web-dist` | 复制 + 逐文件 sha256，**重写 MANIFEST 时丢掉 `source/artifact/entryAssets`** |
| C | `mindcraft/Dockerfile:96-98` | `/app/web-dist` | 内联 JS 再实现一遍：sha、refs、野文件（**不含** sourceHash 绑定） |
| D | `scripts/release.ps1:354-482`（临时 .mjs） | `mindcraft/web-dist` | 第三份实现：+ `sourceHash`/`artifactHash`/`entryAssets` 的**写入与比对** |
| E | `scripts/start-panel.ps1:187-200` | `web/dist`（直接 `node vite.js build`） | 只看 `$LASTEXITCODE`，失败降级为 WARN |
| F | `mindserver.js:1130-1140` | 本地优先 `web/dist`，镜像才用 `web-dist` | 都不存在时只 `console.warn` |

**分叉结论**：
1. "哪份产物算发布物"没有唯一定义：`web/dist`（被本机服务）与 `web-dist`（被校验、被镜像）是两棵树，靠人记得同步。
2. 校验逻辑存在三份独立实现（C/D + B 的弱化版），任何一份改了另外两份不会跟——`sourceHash` 绑定只存在于 D。
3. 镜像**无法**自证"我是由 manifest 里记的那份源码构建的"（`source.hash` 只在本机可验），所以"发布可复现"目前等于"本机可验"，不是"跨机可复现"。
4. 构建入口有两个：`npm run build`（文档）vs `node vite.js build`（`start-panel` 实际用法）。今天等价，加一条 typecheck/插件就分叉。

---

## 7. 未覆盖 / 边界（诚实声明）

- **`restore-drill.ps1` 端到端未跑**：完整演练必然在 25567/25568 起一台真 MC 服（>=2GB 内存 + 约 225MB 骨架），超出本次"只读校验"的授权（任务只点名 `release.ps1 -VerifyOnly` 与 `start-panel.ps1 -DryRun`）。本次只验证了它的**前置分支**（exit 1，无副作用）。OPS-R6-08/09 的结论来自代码路径（显式的 `switch` 与清理逻辑），不是运行结果。
- **`e2e.ps1` 未跑**（同上，需起服）。OPS-R6-15 三条均为静态取证；其中"`Remove-Item -Recurse` 跟随 junction"是 PowerShell 5.1 的已知行为，我**没有**用真实数据复现（会造成破坏），标注为风险而非已发生事实。
- **未跑 docker**：本机没有 docker。OPS-R6-14 全部为静态取证（compose 语义 + Dockerfile 指令）。
- **备份/恢复未做破坏性实验**：没有解压覆盖 `server/world`，没有删备份。`verify-world-backup.ps1` 的 137 条断言是正向证据；反向对照（截断 zip 应报 FAIL）见 R5 记录 `docs/audit-r5/04-ops.md` OPS-4b，本轮未重跑以省时。
- **未改任何产品代码**；`tmp/bat-probe/` 是探针（已 gitignore），`docs/audit-r6/` 是本次产出。

---

## 8. 复现命令（照抄可跑）

```powershell
cd E:\\我的世界ai
# 1) 发布链校验（只读，秒级）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -VerifyOnly

# 2) 面板前置检查（只读，零 spawn）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-panel.ps1 -DryRun

# 3) 备份完整性（只读，137 条断言）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-world-backup.ps1 -BackupDir backups/world-20261109-043001

# 4) 恢复演练前置分支（只读，必然 exit 1）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restore-drill.ps1 -BackupDir backups/does-not-exist

# 5) 凭据 ACL 体检（只读，不加 -Apply）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/harden-credentials-acl.ps1

# 6) 计划任务定义（不注册）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-backup-task.ps1 -WhatIf

# 7) 现有门禁（文本断言，全绿）
node scripts/tests/ops-regression.mjs
node scripts/tests/acl-regression.mjs
```

---

## 9. 给修复阶段的优先级建议（仅供拍板，本席未实施）

1. **先补两条会伤存档的**：OPS-R6-05（`stop-all` 假成功）+ OPS-R6-02（缺 `web/node_modules` 时 stop-panel 不可用）——两者合起来才是"用户强关窗口"的真正入口。
2. **再补从零部署**：OPS-R6-01 的 `provision.ps1` + README 三条命令补成五条（含 `cd web; npm ci` 与 JDK/jar/server.properties）。
3. **然后修"承诺过头"**：OPS-R6-08（drill 不还原 plugins/config，verdict 拆两级）+ OPS-R6-07（插件清单入 manifest）+ OPS-R6-06（`server.properties` 恢复策略二选一）。
4. **最后收一致性**：OPS-R6-11/12（产物唯一权威 + 单一 MANIFEST 写者）、OPS-R6-14（容器 CMD/USER/端口）、OPS-R6-18（把文本门禁换成行为门禁）。
