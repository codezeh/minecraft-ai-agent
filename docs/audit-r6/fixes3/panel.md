# R6 启动链验收：`start-panel.ps1` / `stop-panel.ps1` 真机（8080 + 25565）· #44 #11 #9

> 执行者：qa-panel（attempt 1，2026-11-11 23:05 – 2026-11-12 00:10 CST）
> 机器：本机 Windows（Windows PowerShell 5.1，Node v24.16.0 / npm 11.13.0，`.tools/jdk-21.0.12.1+1`）
> 端口：**8080 + 25565**（另开 25575 RCON），与冒烟线 8081、E2E 线 25566/25576/18093 不冲突，全程并行未互相干扰
> 硬约束遵守：**未修改任何产品代码**；**未碰 `server/` 生产存档**（隔离镜像根，见 §1）；收工时 java/node 全退、端口全释放（见 §7）

---

## 0. 结论（先说要紧的）

| # | 验收项 | 判断 | 一句话依据 |
|---|---|---|---|
| 1 | **#44-②** bot 未就绪不许报成功 | **PASS** | 真跑 120s 后打印 `[error] waited 120s and the log never said 'spawned.'` 并 **exit 1**；`mindcraft-console.log` 中 `spawned.` 出现 **0** 次 |
| 2 | **#11** 连不上 ≠ 没在跑 | **PASS** | 静默 8080 监听（TCP 通、握手永不回）下 **exit 5**「无法确认 mindserver 是否在运行……**没有**执行任何停止动作」；旧的 1.5s 代码在这里会说「没在跑、不用停」+ exit 0 |
| 3 | **#9** 备份含脱敏 `server.properties` + 插件 jar 清单 | **PASS** | 包内 `rcon.password=`（空）、`enable-rcon=true` / `white-list=true` 保留；整个备份目录中测试口令出现 **0** 次；`manifest.pluginJars` 6 条含 sha256 |
| 4 | 启动日志 `Done (`、面板 HTTP 200 | **PASS** | 服务端 `Done (28.758s)!` / `Done (20.474s)!`；`/console?token=` → 最终 **200**（Vue 外壳「陪玩控制台」），带 cookie 取 `index-BUfQgcJJ.js` → **200**，无 cookie → **401**（握手门在位） |
| 5 | RCON 优雅停服、java 真退出、端口释放 | **PASS** | `stop-panel.ps1` 打印「已确认 Minecraft 退出（25565 端口已关闭）」→「完成。」**exit 0**；java 进程 0、25565/25575/8080 无监听 |
| 6 | **新缺陷 F1（blocker）**：`start-panel.ps1` 在本仓库状态下**必然启动失败** | **FAIL（未修，仅报）** | `Get-ServerJava` 要求命令行含 **绝对** `server\server.jar` 路径，而脚本自己用 `-jar server.jar`（相对）启动 ⇒ 判据永远不成立。冷启动被误判「服务器进程已经退出了」；已在跑时被误判「25565 已被别的程序占用」 |

**一句话**：#44 / #11 / #9 三条修复在真机上**都成立且都真的会红**；但启动链的**入口本身**被同一批修复里的路径判据判死了 —— `start-panel.ps1` 现在**开不起来**（两种误判都 exit 1），这才是本次最该先修的东西。为避免阻塞其余四条验收项，我用手工起服（仅把 `-jar` 换成绝对路径）绕过了 F1，绕行方式在 §3.3 明确标注。

---

## 1. 隔离方案（为什么不是直接跑仓库根）

`start-panel.ps1` 把服务端目录硬编码成 `$root\server`（`$root` = 脚本父目录），启动会写 `world/`（chunk、`session.lock`、`level.dat`）、`logs/`、`plugins/*/` 数据，**并且** `release.ps1` 会重建 `web/dist` 与 `mindcraft/web-dist`。在仓库根直接跑就等于往生产存档和同事正在用的产物目录里写。因此本次用一个**镜像根**：

```
tmp/panel-accept/root/            ← 等价于仓库根（start-panel 的 $root）
├─ scripts/                       ← 真拷贝（404K）：$PSScriptRoot/$root 才解析到镜像根
├─ .tools            -> 仓库\.tools                 （junction，只读复用 JDK）
├─ mindcraft/                     ← 真拷贝，但排除 node_modules 与 tmp
│  └─ node_modules   -> 仓库\mindcraft\node_modules （junction）
├─ web/                           ← 真拷贝，但排除 node_modules 与 dist（dist 由 release.ps1 现构建）
│  └─ node_modules   -> 仓库\web\node_modules       （junction）
├─ config/  bots/                 ← 真拷贝（备份开关、bot 配置）
└─ server/                        ← 新建，**不指向生产**
   ├─ server.jar                  ← 拷贝（52.8 MB）
   ├─ libraries|versions|cache -> 仓库\server\…     （junction，只读大件）
   ├─ plugins/*.jar               ← 只拷 jar（6 个），不拷数据目录
   ├─ world/                      ← 从 test-template\world 拷（3.4M 干净模板）
   ├─ server.properties           ← 生产同名文件 + rcon.password 换成测试口令 acceptr6testrconpw…
   └─ eula.txt
```

验证生产未被动过（收工后）：

- `server/world` 目录 mtime 仍是 `Nov 7 16:02`，`find server/world -newermt "2026-11-11 23:00"` **无任何文件**；
- 仓库 `backups/` 最新仍是 `world-20261111-043001`（每日计划任务），本次备份全部落在镜像根 `tmp/panel-accept/root/backups/`；
- `git status --porcelain` 只有 `M scripts/e2e.ps1`（**另一条线**修 JDK 预检的改动）与我新增的 `docs/audit-r6/fixes3/`，**没有**我改的产品代码。

> 注意：镜像根里有 5 个 junction 指向真实大目录（`node_modules`、`.tools`、`server/libraries|versions|cache`）。**不要 `rm -rf tmp/panel-accept`** —— 会顺着 junction 删到真实依赖。清理时先对每个 junction 做 `cmd /c rmdir <junction>`，再删其余部分。

---

## 2. 前置状态（开工前）

| 项 | 结果 |
|---|---|
| 8080 / 25565 / 25575 监听 | 全部 **0**（`netstat -ano` 无 LISTENING） |
| 残留 java / node | java **0** 个；node 0 个 |
| JDK | 镜像根 `.tools\jdk-21.0.12.1+1\bin\java.exe`（junction 复用） |
| 启动脚本前置自检 | 「RCON 入站已收紧（防火墙规则 deny-rcon-25575-in 在位且形态正确）」；凭据 ACL 体检 **exit 3**（有凭据文件本机所有用户可读）→ 只告警不拦，符合设计 |

---

## 3. 跑过的命令（时间 / 退出码 / 结论）

### 3.1 第 1 次：真跑仓库脚本 —— 服务端起得来，脚本却说它死了（F1 之面 A）

```powershell
cd root; powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-panel.ps1
```
- 0/4 构建校验：`release.ps1 -SkipDocker` 全 PASS（vite build 1.25s，16 个产物文件与清单逐条一致，`web/dist` 与 `mindcraft/web-dist` 逐文件一致）
- 1/4：`正在启动（冷启动约 15~40 秒）` → `Minecraft 端口已就绪（14s）` → **`[错误] 服务器进程已经退出了，没能启动成功`**
- **exit 1**（耗时约 45s），但事实是：java 仍在跑、25565 在监听、稍后 `Done (28.758s)!`
- 全文：`evidence/panel-start-run1-serverdied.log`

实际 java 命令行（`Get-CimInstance Win32_Process`）：

```
"E:\…\root\.tools\jdk-21.0.12.1+1\bin\java.exe" -Xms1G -Xmx2G -XX:+UseG1GC -jar server.jar nogui
```

`-jar` 后面是**相对名** `server.jar`；而 `Get-ServerJava()` 的判据是命令行 `Contains('<root>\server\server.jar' 的绝对路径)` ⇒ **永远为 false** ⇒ `Wait-ServerReady` 第一次轮询就判定「进程已退出」并 `exit 1`（没有任何宽限窗口）。

### 3.2 第 2 次：服务端还活着时重跑 —— 被误判成「别人的服务器」（F1 之面 B）

- 1/4 输出：**`[错误] 25565 已被**别的程序**占用：端口在监听，但找不到本项目的 server\server.jar 进程。`**
- **exit 1**；而那个 25565 恰恰就是上一步本脚本自己起的本项目服务端。
- 全文：`evidence/panel-start-run2-port-foreign.log`

⇒ F1 的两种症状都实测到了，根因同一个（见 §6）。

### 3.3 绕行：手工把 `-jar` 换成绝对路径起服（**仅为让后续验收项能跑**）

```powershell
Start-Process <java> -ArgumentList '-Xms1G','-Xmx2G','-XX:+UseG1GC','-jar',<绝对 server.jar>,'nogui' -WorkingDirectory root\server
```
- `Done (20.474s)!`，25565/25575 监听
- 这一步**只改了我这条验证线的启动方式**，没有改仓库里任何文件；它同时也反证了 F1 的根因：换成绝对路径后，同一份 `start-panel.ps1` 立刻认得出「本项目服务端已在运行」

### 3.4 第 3 次：真跑仓库脚本（服务端已在跑）→ #44-② 主判定

- 1/4：`本项目服务端已在运行（25565 已监听，且是本项目的 server.jar），跳过` ✅
- 2/4：`将启动 mindserver（node main.js）` → `mindserver 端口已就绪（2s）`
- 3/4：等 120s → **`[error] waited 120s and the log never said 'spawned.': the start signal is NOT trustworthy`**
  → **`[错误] 启动未确认：节点已起，但 bot 没进游戏（脚本不把这种情况算成功）。`** → **exit 1**
- `evidence/panel-start-run3-bot-timeout.log`

**这就是 #44-② 的正题**：`main.js` 只 `Mindcraft.init()`，bot 是面板按需 spawn 的，直接起服不会有 bot ⇒ 稳居「未就绪」状态。旧实现（`Wait-BotSpawned` 超时 `return $true`）会在没有任何 bot 进游戏的情况下打印「已启动完成」并 exit 0；现在**超时即失败**，并且把「服务已在后台运行、别重复双击」讲清楚了。

bot 侧交叉证据：`root/logs/mindcraft-console.log` 中 `spawned.` 出现 **0** 次（服务起来了、bot 没进）。

### 3.5 面板真能打开（HTTP 200）

```bash
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/console              # 401
curl -sL -o /dev/null -w '%{http_code}' "http://127.0.0.1:8080/console?token=$TOK" # 200
```
- 无 token：**401** + 正文 `unauthorized: 需要握手 token。用 mindcraft/.mindserver-token 里的值打开 …`（本项目 mindserver 的握手门，正是 #44-③ 用来识别「是我们自己」的应答）
- 带 token：`301` → `/console/?token=…` → **200**，标题 `陪玩控制台`，引用 `/console/assets/index-BUfQgcJJ.js`（与本次构建产物同名）
- cookie：`mindserver_token`（HttpOnly，36 字符 UUID）；带 cookie 取 `index-BUfQgcJJ.js` → **200**，不带 cookie → **401**
- `mindcraft-console.log`：`Console UI mounted at http://localhost:8080/console (from E:\\…\\root\\web\\dist)` —— 顺带印证 #49 的说法：**被服务的是 `web/dist`**，而本次 `release.ps1` 的 drift 校验也 PASS（`web/dist` ≡ `mindcraft/web-dist`）

### 3.6 真跑 `stop-panel.ps1`：RCON 停服 + 自动备份（#11 主干 + #9）

```powershell
cd root; powershell -NoProfile -ExecutionPolicy Bypass -File scripts/stop-panel.ps1
```
- `已确认 Minecraft 退出（25565 端口已关闭）` → `完成。` → **exit 0**
- 随后 `自动备份：服务端已停，开始冷备（keep=7，excludeSecrets=True）` → `自动备份：完成`
- 停服后 java **0** 个；25565 / 25575 / 8080 无监听
- `evidence/panel-stop-ok-with-backup.log`

### 3.7 #11 回归：静默 8080 监听（TCP 通、握手永不回）

故障注入（不碰产品代码）：`node hang8080.mjs` —— 只 `accept()` 连接、永不回一个字节，正好覆盖「握手慢于 1.5s」这一类。

- `stop-panel.ps1` 输出：**`[ERROR] 无法确认 mindserver 是否在运行：8080 的连接在 10 秒内既没有成功、也没有失败。`**
  → `**没有**执行任何停止动作；请稍后重跑本脚本` → `[未完成] stop-all.mjs 以退出码 5 结束` → **exit 5**
- 对照（旧病）：旧代码 `await sleep(1500)` 后 `connected === false` ⇒ 打印 `mindserver 没在跑（8080 连不上），不用停。` 并 **exit 0**
- `evidence/panel-stop-hang8080-exit5.log`、注入器 `evidence/panel-hang8080-listener.log`

### 3.8 #11 对照：确实什么都没跑（应判「没在跑」且 exit 0，不是缺陷）

- 8080 无监听时：`mindserver 没在跑（8080 连不上），不用停。` → **exit 0**（这次 ECONNREFUSED 是**明确失败**，与 3.7 的「无法确认」被正确区分开）
- `evidence/panel-stop-idle-exit0.log`

> 注：还有一种「连上了但 token 不对」的路径（exit 3 / AUTH_REQUIRED）本次未单独注入验证 —— 代码里它与 ECONNREFUSED、unknown 是三态分流，3.7/3.8 已证明分流没被合并。

### 3.9 #9 备份内容逐项核对

备份目录：`root/backups/world-20261111-235135/`（`bots.zip` / `world*.zip` / `plugins.zip` / `server-config.zip` / `logs.zip` / `manifest.json`）

`manifest.json`：

- `containsSecrets: false`
- `redacted`: `[{ "path": "server/server.properties", "field": "rcon.password", "reason": "-ExcludeSecrets：口令抹空后入包（其余设置全保留，保证可复现）" }]`
- `pluginJars`: **6 条**，含 `name` / `bytes` / `sha256`（`bluemap-5.16-paper.jar`、`ChunkyBorder-Bukkit-1.2.23.jar`、`Chunky-Bukkit-1.4.40.jar`、`CoreProtect-CE-24.1.jar`、`OnePlayerSleep-4.0.1.jar`、`SkinsRestorer.jar`）
- `secretNote`: 「…rcon.password 已抹空（其余设置完整保留）；恢复后按 manifest.redacted 填回口令即可」

`server-config.zip` → `server-config/server/server.properties`（1472 B）实测：

```
enable-rcon=true      ← 保留
rcon.password=        ← 抹空 ✅
rcon.port=25575
server-port=25565
white-list=true       ← 保留
```

- 测试口令 `acceptr6testrconpw…` 在该文件出现 **0** 次；在整个备份目录（8 个文件）中 grep 也 **0** 命中
- `evidence/panel-backup-manifest-excerpt.json`、`evidence/panel-backup-redacted-properties.txt`

---

## 4. 验收对照表（逐条打勾）

| 任务要求 | 实测 | 结论 |
|---|---|---|
| 真跑 `powershell -File scripts/start-panel.ps1`（真起 Paper + node） | 跑了 **3 次**；Paper 真起（`Done` 两次）、node 真起（`MindServer running on port 8080`） | 通过（但见 F1：入口脚本自身判死） |
| #44 构造「bot 未就绪」，确认不再报成功 | 120s 超时 → `is NOT trustworthy` → **exit 1**；`spawned.` 0 次 | 通过 |
| #11 跑一次 stop-panel，确认「连不上」不再判成「没在跑」 | 静默监听 → **exit 5 / 无法确认 / 没有执行任何停止动作**；真没跑 → exit 0「没在跑」 | 通过 |
| #9 触发一次备份，含脱敏 `server.properties` + 插件 jar 清单 | `rcon.password=` 空、`enable-rcon`/`white-list` 保留、口令 0 泄漏、6 个 jar + sha256 | 通过 |
| 启动日志出现 `Done (` | `Done (28.758s)!`、`Done (20.474s)!` | 通过 |
| 面板真能打开（HTTP 200） | 带 token **200**（Vue 外壳 + 资源 200），无 token 401 | 通过 |
| 停服走 RCON stop，java 真退出、端口释放 | 「已确认 Minecraft 退出（25565 端口已关闭）」；java 0、三端口无监听 | 通过 |
| 不碰 `server/` 生产存档、不改产品代码 | 镜像根隔离；`server/world` 今日零改动；`git status` 无我的改动 | 通过 |

---

## 5. 顺带确认的旁证

- **#49 的对象问题**：`mindcraft` 日志自报 `Console UI mounted … (from root\web\dist)`，本次 `release.ps1 -SkipDocker` 的 drift 校验（`web/dist` vs `mindcraft/web-dist` 逐文件 sha256）PASS ⇒ 「被服务的」与「被校验的」是同一份。
- **#44-① 构建判据**：`Resolve-BuildOutcome` 生效（本次构建 exit 0 才继续）。
- **#44-③ 面板认领**：8080 探针 `Get-PanelProbe` + `Resolve-PanelPortState` 识别出本项目（401 带 `unauthorized` 正文 → `ours`）。

---

## 6. 新缺陷 F1（blocker，未修 —— 只报，属产品代码）

**标题**：`start-panel.ps1` 的「本项目服务器」判据与它自己的启动方式不自洽 ⇒ 冷启动必失败、热重跑必误判「端口被别的程序占用」

**位置**：`scripts/start-panel.ps1`

- `Get-ServerJava()`（OPS-009 引入）：
  ```powershell
  $jar = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot 'server\server.jar'))
  # … $cmd.Contains($needle)   # $needle 是绝对路径
  ```
- 启动处（同一文件）：
  ```powershell
  Start-Process -FilePath $java -ArgumentList '-Xms1G','-Xmx2G','-XX:+UseG1GC','-jar','server.jar','nogui' -WorkingDirectory $srvDir
  ```
  ⇒ 子进程命令行是 `… -jar server.jar nogui`，**不含**绝对路径。

**后果（都实测）**：

1. `Wait-ServerReady` 第一轮就把「进程已退出」判死 → `[错误] 服务器进程已经退出了，没能启动成功` → exit 1，而服务端其实 28.7s 后 `Done`（面 A）。
2. 服务端在跑时重跑 → `Resolve-McPortState` 看到 `Listening=$true, OurJavaPresent=$false` ⇒ `foreign` → `[错误] 25565 已被**别的程序**占用` → exit 1，把自家的服当成别人的（面 B）。
3. 连带影响：`2/4` 的 8080 `ours` 判定、以及 `Wait-ServerReady` 的存活轮询都依赖同一函数；只要用本脚本启动，`Get-ServerJava` 恒空。

**最小修法（二选一，需 captain 派给实现方，我不改代码）**：

- A（更小）：启动时传绝对路径 —— `-ArgumentList '…','-jar',(Join-Path $srvDir 'server.jar'),'nogui'`；命令行即含项目绝对路径，判据立刻成立。副作用：命令行变长，可接受。
- B（更稳）：`Get-ServerJava` 同时接受「绝对路径」**或**「`-jar server.jar` + 进程工作目录 == `<root>\server`」两种形态（进程 cwd 需另取，成本略高）。

**为何算 blocker**：R6 #44 的目标是「别再谎报成功」，但现在变成了「**永远报失败**」。用户按 README 双击 `启动面板.bat` 会看到红字 + exit 1，而服务其实起得来（面板得自己再开一次），这比原缺陷更劝退，且会让人反覆双击造成端口冲突。

---

## 7. 收尾状态（硬要求）

| 项 | 收工值 |
|---|---|
| 8080 监听 | **0** |
| 25565 监听 | **0** |
| 25575 监听 | **0** |
| java 进程数 | **0** |
| node 进程数 | **0**（我起的 mindserver 与故障注入器全部退出/被清理） |
| 生产 `server/` | 今日零改动（`world/` mtime `Nov 7 16:02`） |
| 生产 `backups/` | 最新仍为 `world-20261111-043001`，本次备份只在镜像根 |
| 产品代码 | 未改（`git status` 仅 `M scripts/e2e.ps1`，属另一条线；`?? docs/audit-r6/fixes3/`） |
| 遗留 | 镜像根 `tmp/panel-accept/`（含 junction，**勿 `rm -rf`**；清理方式见 §1 注） |

---

## 8. 证据清单（`docs/audit-r6/fixes3/evidence/`）

| 文件 | 内容 |
|---|---|
| `panel-start-run1-serverdied.log` | 第 1 次真跑：服务端起得来（14s 端口就绪），脚本误判「进程已退出」→ exit 1（F1 面 A） |
| `panel-start-run2-port-foreign.log` | 服务端在跑时重跑：误判「25565 被别的程序占用」→ exit 1（F1 面 B） |
| `panel-start-run3-bot-timeout.log` | #44-② 主证据：120s 超时 → `is NOT trustworthy` → exit 1 |
| `panel-stop-ok-with-backup.log` | #11 主干 + #9：RCON 停服确认、java 退出、自动备份完成、exit 0 |
| `panel-stop-hang8080-exit5.log` | #11 回归：静默 8080 → 「无法确认」→ 未执行停止 → exit 5 |
| `panel-stop-idle-exit0.log` | #11 对照：确实没跑 → 「没在跑」→ exit 0 |
| `panel-hang8080-listener.log` | 故障注入器（accept 后永不回话）自身日志 |
| `panel-backup-manifest-excerpt.json` | 备份清单摘录：`pluginJars` 6 条 + `redacted` + `containsSecrets=false` |
| `panel-backup-redacted-properties.txt` | 包内 `server.properties` 关键行（`rcon.password=` 空、`enable-rcon`/`white-list` 保留）+ 口令出现 0 次 |
| `panel-server-done.txt` | `Done (20.474s)!` |

---

## 9. 建议给 captain 的下一步

1. **先修 F1**（§6 最小修法 A，一行改动），否则「启动链」这条线只能靠手工绕行；修完应复跑 §3.1（冷启动应打出 `服务器已完全加载（Ns）` 并继续到 3/4）与 §3.2（热重跑应打 `本项目服务端已在运行…跳过`）。
2. #44-①/#44-②/#44-③、#11、#9 三条**可以就地判过**（本次真机已证），不必等 F1。
3. F1 修好后建议补一条回归：让 `ops-regression` 把「启动用的 `-ArgumentList`」与 `Get-ServerJava` 的 `$needle` 形态对齐（dot-source 现成纯函数 + 断言 `Contains` 关系），避免再出现「判据与启动方式不自洽」这类**只有真机才暴露**的问题。


---

## §9 F1 修复（captain 亲自修并真机验证）

**缺陷**：`start-panel.ps1` 的 `Get-ServerJava()` 判据要求命令行含**绝对**路径
`<root>\server\server.jar`（OPS-009 为防误匹配别人目录的 jar），而同一脚本启动时传的是
**相对名** `-jar server.jar`（工作目录才是 `server/`）⇒ 判据永假。后果：
- 冷启动：端口已就绪、后来也 `Done (28.7s)!`，脚本却报「服务器进程已经退出了，没能启动成功」→ exit 1；
- 热重跑：报「25565 已被**别的程序**占用」→ exit 1（其实是自家的服）。
⇒ 按 README 双击「启动面板.bat」必然红字失败。

**修法**（保留 OPS-009 的严格判据，只让命令行自证身份）：先把 `$jarAbs = Join-Path $srvDir 'server.jar'`
算成变量，再传给 `-ArgumentList ... '-jar', $jarAbs, 'nogui'`。
> 踩坑记录：第一次把 `(Join-Path $srvDir 'server.jar')` 直接塞进续行参数表，**打断了反引号续行**，
> 报 `-ArgumentList : The term ... is not recognized`。PowerShell 续行参数表里不要塞括号表达式。

**真机验证（captain 实跑，非推演）**：
- `Parser::ParseFile` ERRORS=0；BOM `ef bb bf` 保留
- `-DryRun` 打印的命令已是 `-jar "E:\我的世界ai\server\server.jar"`（绝对路径）
- **真跑一次完整启动**：`[1/4]` 服务器起来 → `[2/4]` mindserver 0s 就绪 → `[3/4]` bot entered the game (16s)
  → `[4/4]` 面板 → 「已启动完成」。**这是该脚本首次完整走通。**
- 收尾：stop-panel 报「mindserver 没在跑」；实测 8080/25565/25575 全 free、无 java/node → 判断准确，
  且自动备份已执行。
