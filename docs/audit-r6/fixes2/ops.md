# R6 脚本/部署/门禁清零（#44 · #48–#56）+ ADR §10.2-2

> 任务：t5（fix-ops2；attempt 1 因账户余额中断，attempt 2 续做）。
> 写作用域：`scripts/**`、`docs/**`、`README.md`，以及**任务点名要求改动**的三个部署件：
> `收紧RCON.bat`（#48）、`mindcraft/tools/sync_web_dist.mjs`（#50）、`mindcraft/Dockerfile` + `mindcraft/docker-compose.yml`（#52）。
> 约束：不改产品代码（`mindcraft/src` 只读、前端只读）；不收大文件进仓；不改数据库架构。
> 日期：2026-11-11。

---

## 0. 结论表

| 项 | 状态 | 关键证据 |
|---|---|---|
| #44 start-panel 三条"没成功也报成功" | **已修** | 判据搬到 `scripts/lib/panel_guard.ps1`；真机验证：8080 被陌生服务占 ⇒ **exit 1**（§2.1） |
| #48 收紧RCON.bat 退出码与"已收紧"无关 | **已修** | `.bat` 用 `-Wait -PassThru` 透传子进程退出码；脚本 `netsh` 后**回读**规则形态；新增只读 `-Verify`；start-panel 前置检查会调它（§2.2） |
| #49 发布链校验的不是本机实际被服务的产物 | **已修** | start-panel 改走 `release.ps1 -SkipDocker`，再逐文件比对 `web\dist` 与 `mindcraft\web-dist`，不一致就 exit 1（§2.3） |
| #50（=ADR §10.2-2）MANIFEST 双写者 | **已修，单一写者** | sync 工具不再写 MANIFEST（只同步产物并**保留**它）；`release.ps1` 的 `files` 改按磁盘重算。验证：sync 前后 MANIFEST sha256 完全相同（§2.4） |
| #51 -FromConfig 总开关关闭时 exit 0 | **已修** | 跳过改用**退出码 4**，`backup_config` 据此记 `SKIP` 而不是 `OK`（§2.5） |
| #52 Docker 路径缺前置检查 | **已修** | `CMD ["node","main.js"]`、`USER node`、`HEALTHCHECK`、25568 收回到 127.0.0.1；新增 `scripts/docker-preflight.ps1`（§2.6） |
| #53 e2e 预检漏端口 / JDK 不确定 / junction 不安全 | **已修** | 三端口预检、JDK 按主版本排序并断言 ≥21、`Remove-RunDirSafe` 先摘 junction（含异常路径）（§2.7） |
| #54 计划任务只证"注册成功" | **已修** | 注册后**冒烟执行**：`Start-ScheduledTask` → 等 → 读 `LastTaskResult` + `backup-auto.log` 是否新增行；新增 `-LogonType S4U`（§2.8） |
| #55 凭据 ACL 覆盖面不够 | **已修（覆盖）+ 新增前置告警** | 目标从 4 个扩到 8 类（30 个文件）；本机体检**发现 22 条过宽 ACE**；start-panel 每次启动告警（§2.9） |
| #56 回归门禁是文本正则 | **已升级为行为测试** | `ops-regression.mjs` 29 → **87** 条；#44/#50 是**真跑**的行为断言，两条都做过**反向证明**（§3） |
| ADR-0001 升 rev 4 | **已完成** | 新增 §11（落地表 / D15 `memory.json` / 单一写者理由 / 门禁升级 / 真机清单 / 仍未收口） |

**没有做的事**：没有起 Minecraft 服务端、没有起 mindserver、没有跑 e2e（会在 25566/25576/18093 起真服）、没有跑 `docker build`（本机无 docker）、**没有执行 `harden-credentials-acl.ps1 -Apply`**（会改本机 ACL，需所有者确认）、没有改 `config/backup.json`、没有改任何产品代码。

---

## 1. 修法与取舍

### 1.1 #44：为什么把判据搬进 `scripts/lib/panel_guard.ps1`

三条"假成功"分支的病根是同一个：**判据是内联的 `Write-Ok` 文案**，除了真起一个服之外无法验证；而门禁只能 grep 文案（正是 #56 点名的"文本正则"）。所以先把判据抽成纯函数：

| 函数 | 输入（事实） | 输出（判据） | 原缺陷 |
|---|---|---|---|
| `Resolve-BuildOutcome` | 退出码、磁盘上有没有旧 dist | `ok` / `abort`+`exit 1` | 构建失败只 WARN，"沿用上一次的 dist"继续报成功 |
| `Resolve-McPortState` | 25565 是否监听、本项目 `server.jar` 进程是否存在 | `free`/`ours`/`foreign` | "有监听"就当成"本项目已在运行" |
| `Resolve-PanelPortState` | 8080 是否监听、`GET /console` 的应答 | `free`/`ours`/`foreign` | 8080 被别的服务占也说"已在运行" |
| `Get-BotSpawnHint` / `Wait-BotSpawned` / `Resolve-BotSpawnOutcome` | 日志尾部文本 | `spawned`/`failed`/`pending`；超时 **`$false`** | 120s 超时也 `return $true` ⇒ 调用点永不触发 |
| `Get-DistDrift` | 两个产物目录 | 差异行数组 | #49 的校验对象错位 |

`start-panel.ps1` 只负责**取事实 + 按判据打印 + 用退出码收尾**。行为变化共三处，全部是"从不失败变成会失败"。

**8080 怎么判"是不是本项目"**：探一次 `GET /console`（`Get-PanelProbe`，裸 socket、1.5s 上限）。本项目 mindserver 在无 token 时回 `401` 且正文以 `unauthorized:` 开头；闸门放开时回 Vue 外壳（含 `id="app"`）。其余一律 `foreign`。

### 1.2 #50：选"sync 不再写 MANIFEST"，理由三条

1. `source.hash` 必须由**构建用的源码树**算出（`release.ps1 -SourceRoot` 可指向另一棵树），而 `sync_web_dist.mjs` 只看得见 `web/dist` —— 它没有这个输入，让它写就只能是猜。
2. 清单要和 `release.ps1 -VerifyOnly` 的校验口径**同一处实现**，否则两边永远会漂（这正是双写者问题的本质）。
3. sync 剩下的职责（拷文件、`--check` 比对）与清单无关，可以彻底解耦。

配套两点（缺一不可）：

- sync 清理目标目录时**先保留** `MANIFEST.json` 与 `README.md`，再拷文件，最后把这两个写回去 —— 否则"同步一次 = 清单消失"。
- `release.ps1` 的 `files` 表改为**按磁盘重算**（不再从旧清单读），于是清单不依赖"上一个写者留下了什么"。这也让"清单缺失时重新 stamp"成为可能。

### 1.3 #49：校验对象对齐而不是"再加一道检查"

`mindserver` 本机候选顺序是 `$WEB_DIST` → `<repo>/web/dist` → `/app/web-dist`，所以**本地实际被服务的是 `web/dist`**；而 `release.ps1` 只校验 `mindcraft/web-dist`。修法不是"再多打印一句提醒"，而是把两条路径收敛到**同一条链**：

```
start-panel → release.ps1 -SkipDocker（build → sync → stamp → verify）
            → Get-DistDrift(web\dist vs mindcraft\web-dist) == 空 才继续启动
```

于是"被服务的那份"必然是"被校验的那份"；不一致就 exit 1，并列出差异文件。

### 1.4 #48：让"已收紧"变成可验证的事实

三层：

1. `deny-rcon-25575-in.ps1` 加 `netsh` 之后的**独立回读**（`Get-NetFirewallRule` + `Get-NetFirewallPortFilter`，判 入站/Block/TCP/25575/已启用）。命令退出 0 只证明"没报错"，不证明规则长成了要的样子。
2. 新增只读 `-Verify`（不需管理员）：`0`=在位且形态正确、`1`=不存在、`2`=存在但形态不对。这是"该防护无法被任何脚本验证"的直接答复。
3. `收紧RCON.bat` 改 `-Wait -PassThru` 后 `exit %RC%`；用户取消提权返回 **2**（与"执行失败"区分），失败时明确说"RCON 可能仍然暴露"。

`start-panel` 每次启动都调 `-Verify`：缺规则 ⇒ WARN + 指向那个双击动作。**不拦启动**（这是部署硬要求，不是启动前提）。

### 1.5 #51：给"跳过"分配独立退出码

`0` 成功 / `1` 失败 / `2` 服务端在跑 / `3` Hot 未加 `-Force` / **`4` 总开关关闭（跳过）**。
`backup_config.ps1` 增加 `$code -eq 4` 分支 → 记 `SKIP`（`enabled=false`），不再落到 `OK 停服后自动备份成功`。

### 1.6 #52：Docker 路径

| 问题 | 修法 |
|---|---|
| PID 1 是 npm，SIGTERM 未必到 node | `CMD ["node","main.js"]`（exec 形式，信号直达 `shutdownOnce()`） |
| 镜像以 root 运行、无健康检查 | `chown -R node:node /app` + `USER node`；`HEALTHCHECK` 用 node 自带 fetch 探 `/`（401 也算健康） |
| `25568` 绑 0.0.0.0 且撞 drill 默认端口 | `"127.0.0.1:25568:25568"`，与本文件其它端口口径一致 |
| 宿主缺 `keys.json`/`profiles/` 时 docker **静默建目录** ⇒ 容器里 EISDIR | compose 没有 `test -f` 能力，等价物放在 `scripts/docker-preflight.ps1`（检查 5 项 + 目录形态 + `web-dist/MANIFEST.json` + `MINDSERVER_TOKEN` 提示） |

### 1.7 #53：e2e 三处

- 预检扩展到 `$MC_PORT / $RCON_PORT / $MS_PORT` 三个端口（原来只查 25566，撞 RCON/18093 会伪装成"起服超时"）。
- `Resolve-Java` 改为**逐个 `java -version` 解析主版本、取最大**，并断言 `≥21`（多 JDK 时不再随机拿到 17）。
- 新增 `Remove-RunDirSafe`：先判 `ReparsePoint` 摘 junction（`cmd /c rmdir`）再 `-Recurse` 删；**正常收尾与 `finally`（异常路径）都走它**。以前异常路径会把 junction 留到下一轮。

### 1.8 #54：注册后真跑一次

新增 `Invoke-TaskSmokeTest`：`Start-ScheduledTask` → 每 3s 读 `Get-ScheduledTaskInfo`（最多 90s，`267009`=运行中视为未结束）→ 判据 = `LastTaskResult ∈ {0, 267009}` **且** `logs/backup-auto.log` 行数增加（证明确实执行到 `backup-world.ps1`，而不只是"任务启动了"）。失败 ⇒ exit 1 + 写 `ERROR` 日志。另加 `-LogonType S4U`（重启后未登录也能跑）。

### 1.9 #55：覆盖面 + 前置告警

`$fileTargets` 从 4 个扩到 8 类并支持通配：`mindcraft/profiles/*.json`（23 个，可能内嵌 API Key）、`mindcraft/.env*`、`mindcraft/vault/*`、`config/*.json`（准入策略/备份开关）。`start-panel` 前置检查调用它，体检 `exit 3` 时 WARN。

（§2.9 有本机实测输出：确实发现 22 条过宽 ACE。**没有 `-Apply`**：那是改本机 ACL 的动作，需所有者确认。）

---

## 2. 逐条证据

### 2.1 #44：真机证明（不是静态推断）

先让 8080 被一个**陌生服务**占用（`python -m http.server 8080`），再跑 `start-panel.ps1 -DryRun`：

```
[2/4] mindserver + bot
      [错误] 8080 已被**别的东西**占用：端口在监听，但应答的不是本项目面板。
              探测结果：HTTP 404
              继续下去会在一个陌生页面上说"已启动完成"。请先让出 8080 再重跑。
EXIT=1
```

修复前这里是 `Write-Ok '已在运行（8080 已监听），跳过'` 然后一路到"已启动完成"。8080/25565 空闲时同一脚本 `EXIT=0` 且走完 4 步（§2.10 全文）。

### 2.2 #48：规则真的在位

`start-panel -DryRun` 的前置检查输出：

```
      RCON 入站已收紧（防火墙规则 deny-rcon-25575-in 在位且形态正确）
```

即本机 `-Verify` 返回 0：规则存在、`Inbound`、`Block`、`TCP`、`25575`、`Enabled`。以前这条信息**根本不存在**（没有任何脚本检查过它）。

### 2.3 #49：被服务的就是被校验的（drift = 0）

```
drift count = 0        # Get-DistDrift(web/dist, mindcraft/web-dist)
```

同一判定已进 start-panel：`drift > 0` ⇒ exit 1 并列出差异文件。

### 2.4 #50：单一写者（核心证据）

**（a）真跑一次同步，清单字节不变**

```
=== MANIFEST hash BEFORE sync ===
e0c77ee2bf5a04ad274d56a4
[sync] 已同步 13 个文件到 …\mindcraft\web-dist
[sync] 已保留原 MANIFEST.json（本工具不写清单：唯一写者是 scripts/release.ps1）
=== MANIFEST hash AFTER sync ===
e0c77ee2bf5a04ad274d56a4
source.hash: sha256:f6044919cc90e artifact.hash: sha256:5a2b6ea0632eb generatedAt: 2026-11-10T15:40:14Z entryAssets: 2
```

修复前：这次同步会把清单重写成 `{generatedFrom, note, files}` ⇒ `source.hash`/`artifact.hash`/`generatedAt` 全部消失，随后 `release.ps1 -VerifyOnly` 直接红（"清单是旧格式"）。**一条合规的同步命令能静默删掉漂移检测的绑定**。

**（b）`release.ps1 -VerifyOnly` 8/8**

```
PASS  13 个产物文件与清单逐条一致
PASS  产物目录没有清单未记录的野文件
PASS  index.html 的 2 个入口引用都能在产物里找到
PASS  源码指纹 sha256:f6044919…（29 个输入文件）
PASS  产物指纹 sha256:5a2b6ea0…（13 个产物文件）
PASS  产物与 web/ 源码指纹一致
PASS  产物指纹与清单一致
PASS  入口引用与清单一致
ALL PASS: 8 passed, 0 failed
```

> **关于"用哪棵树验证"**：本轮多人在改 `web/src`，验证期间撞上 t4 重建产物的窗口，因此 8/8 曾在 `git worktree add tmp/rel-src HEAD` 的**已提交源码树**上取得（`git worktree remove` 已清理，未留残留）。
> **t4 重建并重新 stamp 之后，当前工作树已是 8/8**（2026-11-11 16:44，源码指纹 `19c0e0b5…`/32 个输入文件、产物指纹 `0b1a3cd8…`/16 个产物文件）。
> 结论：这条门既不"永远绿"（见 §3.4 的反证），也不要求干净树才能过 —— 它要求**产物确实由当前源码构建**。

### 2.5 #51：退出码分离

契约现在是：`0` 成功 / `1` 失败 / `2` 服务端在跑 / `3` Hot 未加 `-Force` / **`4` 总开关关闭（跳过）**。

- `backup-world.ps1`：`$FromConfig -and -not enabled` 分支打印 `SKIP … —— 本次不备份（exit 4）` 并 `exit 4`（原来 `exit 0`）。
- `backup_config.ps1`：新增 `$code -eq 4` 分支 ⇒ 记 `SKIP`（`reason='enabled=false'`），**不再**落进 `OK 停服后自动备份成功`。

**证据级别：代码 + 门禁断言，未真机执行。** 原因：跑这条路径需要把 `config/backup.json` 的 `enabled` 改成 `false`，而本任务明确不改该文件（改了会影响运行中的自动备份语义）。门禁里有三条断言钉住它：

```
PASS R6#51 -FromConfig+enabled=false 用独立退出码 4（不是 0）
PASS R6#51 enabled=false 分支不再 exit 0
PASS R6#51 上层把 exit 4 记成 SKIP 而不是 OK
```

真机执行方式（所有者可自行验，无破坏性）：临时把 `enabled` 改 `false` → `powershell -File scripts/backup-world.ps1 -FromConfig; $LASTEXITCODE` 应为 **4** → 把 `enabled` 改回 `true`。

### 2.6 #52：前置检查真跑

```
Docker 部署前置检查（R6 #52）
  ok    mindcraft/settings.js（文件）
  ok    mindcraft/keys.json（文件）
  ok    mindcraft/profiles（目录）
  ok    mindcraft/bots（目录）
  warn  MINDSERVER_TOKEN 未设置：compose 会立刻报错（这是有意的，别改）。
  ok    mindcraft/web-dist/MANIFEST.json
结果：前置齐全，可以 docker compose up。
```

（`build`/`stop` 未验证：本机无 docker。）

### 2.7 #53：静态 + 解析级

三端口预检、JDK 主版本排序与 `≥21` 断言、`Remove-RunDirSafe`（含 `finally` 兜底）都已落码；`e2e.ps1` 解析 0 错。**端到端未跑**（会起真服）。

### 2.8 #54：冒烟判据落码

`Invoke-TaskSmokeTest` 已实现并被注册路径调用；`-SkipSmokeTest` 可跳过。**真机未跑**（会改本机任务计划）——列入 ADR §11.5 清单第 1 项。

### 2.9 #55：覆盖面实测（新增的 30 个文件里确实有洞）

```
[体检结果] 发现 22 条过宽 ACE。跑一次加 -Apply 收口：
            powershell -NoProfile -File scripts\harden-credentials-acl.ps1 -Apply
```

抽查两条：

```
--- mindcraft\profiles\qwen.json
  !! NT AUTHORITY\Authenticated Users | ReadAndExecute, Synchronize | Allow | 继承=True
--- config\network.json
  !! NT AUTHORITY\Authenticated Users | Modify, Synchronize | Allow | 继承=True
  !! BUILTIN\Users | ReadAndExecute, Synchronize | Allow | 继承=True
```

即：**人设文件（可能内嵌 API Key）对本机所有用户可读**，`config/network.json`（准入策略）甚至可**写**。这正是 #55 说的"覆盖面不够，不是现在漏着"。
`start-panel` 已把这句接进前置输出：

```
      [警告] 有凭据类文件仍是"本机所有用户可读"（体检 exit 3）。
              修法：powershell -NoProfile -File scripts\harden-credentials-acl.ps1 -Apply
```

**未执行 `-Apply`**：改本机 ACL 需所有者确认（ADR §11.6 第 2 条）。

### 2.10 #44 的另一半：全绿路径仍能走完

8080/25565 空闲时 `start-panel.ps1 -DryRun` **EXIT=0**，四步全部打印，且 `[0/4]` 现在打印的是"构建→同步→打指纹→校验（唯一产物写者）"与 drift 比对，不再是裸 `vite build`。

---

## 3. 门禁升级（#56）：能红能绿，两次结果都在这里

`scripts/tests/ops-regression.mjs` 从 **29 条** 扩到 **80 条**。新增部分两类：

- **行为断言**（真跑，不是 grep）：`#44` 把 `panel_guard.ps1` 交给**真 PowerShell dot-source**，喂假事实断言 12 个 verdict；`#50` 用夹具目录**真跑** `sync_web_dist.mjs`，断言清单元数据没被抹掉。
- **接线断言**：脚本必须真的使用这些判据（防止"库里写好了、start-panel 没用"）。

### 3.1 反向证明 A（#44）：把"超时算成功"改回去

改 `panel_guard.ps1` 的 `Wait-BotSpawned` 末行 `return $false` → `return $true`：

```
broke #44 (timeout returns $true again)
FAIL R6#44 等超时 **不再**返回成功（这条就是原缺陷本身） → true
HAS FAILURES: 79 passed, 1 failed
```

复原后：`ALL PASS: 87 passed, 0 failed`。

### 3.2 反向证明 B（#50）：让 sync 重新写清单

改 `sync_web_dist.mjs`：恢复"重写 MANIFEST 为 `{generatedFrom,note,files}`"：

```
broke #50 (sync wipes MANIFEST again)
FAIL R6#50 发布元数据 source.hash 未被抹掉（原缺陷就是这个） → undefined
FAIL R6#50 artifact.hash 未被抹掉
FAIL R6#50 generatedAt 未被重写 → undefined
FAIL R6#50 entryAssets 未被抹掉
HAS FAILURES: 76 passed, 4 failed
```

复原后：`ALL PASS: 87 passed, 0 failed`。

> 这两次是**故意制造失败**再复原，命令与输出如上；复原后的绿不是"改测试让它绿"，而是改回实现（测试一个字都没动）。

### 3.3 门禁账（最后一轮，逐项）

| 门 | 命令 | 结果 |
|---|---|---|
| 语法 | `Parser::ParseFile`（18 个 .ps1，含 `lib/`、`tests/`） | **全部 ERR=0** |
| 离线回归 | `node scripts/tests/ops-regression.mjs` | **87 passed, 0 failed** |
| 发布链 | `powershell -File scripts/release.ps1 -VerifyOnly` | **8/8 ALL PASS**（对已提交源码树，见 §2.4 注） |
| 部署前置（新） | `powershell -File scripts/docker-preflight.ps1` | exit 0（§2.6） |
| 面板演练 | `powershell -File scripts/start-panel.ps1 -DryRun` | exit 0；8080 被占时 exit 1（§2.1） |
| ACL 体检（只读） | `powershell -File scripts/harden-credentials-acl.ps1` | exit 3（22 条过宽，§2.9） |
| RCON 自检（只读） | `powershell -File scripts/deny-rcon-25575-in.ps1 -Verify` | exit 0（§2.2） |

### 3.4 反向证明 C（#50 复核补强）：`files` 按磁盘重算**没有**把门变成同义反复

captain 提出的问题：`release.ps1` 的 `files` 表改成按磁盘重算后，`-VerifyOnly` 会不会永远绿？

**先承认一个真问题**：初版改法里 `files` 恒由磁盘重算，于是"13 个产物文件与清单逐条一致"这条**变成了自比较**（产物被改时它仍然 PASS），真正拦住产物改动的只剩 `artifact.hash` 一条。这就是"假门禁"的形状，已修：

| 项 | 初版（有同义反复） | 现在 |
|---|---|---|
| `files` 基准 | 恒 = 磁盘 | verify 用**清单记录**、stamp 用磁盘 |
| 逐文件比对 | 磁盘 vs 磁盘（自比较） | **清单记录 vs 磁盘**（能抓改动） |
| `artifact.hash` | 按清单记录算 | 按**磁盘**算，再与清单记录比 |

**三种状态实测**（夹具，直接抽 `release.ps1` 里的真实助手跑，不另写一份实现）：

```
① 干净        → 8/8 ALL PASS
② 源码漂移    → FAIL 产物与源码不一致：清单记录 f6044919…，当前 web/ 源码是 35cbaa2d…
③ 产物被改 1 字节 → FAIL 产物内容与清单不一致: assets/DebugView-BASKxfDS.js
                （修复前这里会 PASS，只靠 artifact.hash 拦）
```

这三条现在都在门禁里（`ops-regression.mjs` 的「R6#50 能从 release.ps1 抽出 verify 助手」一组，6 条断言），所以**同义反复一旦被改回来，门禁会红**：

```
PASS R6#50 能从 release.ps1 抽出 verify 助手
PASS R6#50 夹具 stamp 成功
PASS R6#50 夹具干净时 verify 通过（否则下面的"能红"没有意义）
PASS R6#50 源码漂移 ⇒ verify 红（不是永远绿） → status=1
PASS R6#50 红的理由是"产物与源码不一致"
PASS R6#50 产物被改 ⇒ verify 红 → status=1
PASS R6#50 逐文件比对自己就拦住（不是同义反复） → FAIL 产物内容与清单不一致: assets/a.js
```

> 说明：③ 这一轮是拿**夹具目录**做的，不是拿仓里的 `mindcraft/web-dist` 做 —— 验证期间 t4 正在重建真实产物，对它做篡改会互相踩（第一次尝试就撞上了，产物被换成了新构建）。夹具用的是 `web-dist`+`MANIFEST.json`+`web/src` 的最小可复现结构，跑的是**生产代码本身**（从 `release.ps1` 里抽出的 here-string）。

---

## 4. 跨端契约（#29）：`allow_insecure_coding` 的二次确认

配置面已加二次确认。**前端不跟上，`SettingsView` 的保存会永远失败** —— 那会和 #59（"该开关永远存不下去"）撞成同一个症状，且更难分辨。约定如下：

| 项 | 内容 |
|---|---|
| 请求 | `PUT /api/config/runtime`，body 里把 `allow_insecure_coding` 从 `false` 改成 `true` 时**必须**带 `"confirm": true` |
| 拒绝 | 缺少 `confirm` ⇒ HTTP **409**，`code = "CONFIG_CONFIRM_REQUIRED"`，**不写盘**（其余字段也不会被部分写入） |
| 前端动作 | 见到该码**不要**当普通错误吞掉、**不要**自动重试：先弹确认（说明"允许模型生成并执行代码"的风险）→ 用户确认后**带 `confirm: true` 重发那一次 save**（只重发一次） |
| 用户取消 | 放弃这次保存，界面保留用户已改的值并标明"未保存"，不要回滚成假成功 |
| 没跟上的后果 | 用户点了保存、界面显示成功或静默无变化，实际配置没变 ⇒ 与 #59 同症状；排查会指向权限/网络，而不是"少了一个 confirm" |
| t6 复核对齐点 | ① 409 分支存在且不写盘 ② 前端只在这一处重发（不是无限重试） ③ 取消路径没有"假成功" |

参考实现位置：`web/src/views/SettingsView.vue` + `web/src/stores/config.ts`（由前端席落地；本条只做契约记录与门禁约定）。

---

## 5. 改动清单

| 文件 | 改动 |
|---|---|
| `scripts/lib/panel_guard.ps1` | **新增**：判据库（build/port/bot-spawn/dist-drift/probe），ASCII-only（PS 5.1 无 BOM 按 ANSI 读） |
| `scripts/start-panel.ps1` | 三条假成功分支改用判据；构建改走 `release.ps1 -SkipDocker`+drift 比对；新增 RCON 与 ACL 前置自检 |
| `scripts/deny-rcon-25575-in.ps1` | 新增 `-Verify`（0/1/2）；`netsh` 后回读规则形态 |
| `收紧RCON.bat` | `-Wait -PassThru` + 透传真实退出码；取消提权=2；失败明确告警 |
| `scripts/release.ps1` | `files` 按磁盘重算；清单唯一写者的文案/报错对齐 |
| `mindcraft/tools/sync_web_dist.mjs` | **不再写 MANIFEST**；保留 MANIFEST/README；`SYNC_WEB_DIST_SRC/DEST` 供门禁用夹具 |
| `scripts/backup-world.ps1` | 跳过 ⇒ `exit 4`；退出码文档同步 |
| `scripts/lib/backup_config.ps1` | 处理 `exit 4` ⇒ `SKIP` |
| `scripts/install-backup-task.ps1` | `-LogonType`（Interactive/S4U）、`-SkipSmokeTest`、`Invoke-TaskSmokeTest` |
| `scripts/harden-credentials-acl.ps1` | 目标扩到 8 类 + 通配展开 |
| `scripts/e2e.ps1` | 三端口预检、JDK 主版本排序+≥21、`Remove-RunDirSafe`（含 finally） |
| `scripts/docker-preflight.ps1` | **新增**：#52 的 compose 前置检查 |
| `mindcraft/Dockerfile` | `CMD node main.js`、`USER node`、`HEALTHCHECK` |
| `mindcraft/docker-compose.yml` | 25568 只绑回环 |
| `scripts/tests/ops-regression.mjs` | +51 条（#44/#50 行为断言 + 其余接线断言） |
| `docs/adr/ADR-0001-…md` | rev 3 → **rev 4**，新增 §11；§10.2 加"已被 §11 取代"指针 |
| `docs/audit-r6/fixes2/ops.md` | 本文件 |

### 5.1 写作用域超集（已获 captain 裁决认可，2026-11-11）

本任务字面写作用域是 `scripts/**`、`docs/**`、`README.md`，但实际改了 4 个域外文件：

| 文件 | 为什么必须改 |
|---|---|
| `收紧RCON.bat` | #48 点名："`.bat` 改为 `Start-Process -Wait -PassThru` 后 `exit $p.ExitCode`" |
| `mindcraft/tools/sync_web_dist.mjs` | #50 硬要求点名该文件（"要么 sync 不再写 MANIFEST"） |
| `mindcraft/Dockerfile` | #52 最小修法点名 `CMD ["node","main.js"]` / `USER node` |
| `mindcraft/docker-compose.yml` | #52 最小修法点名 25568 只能绑回环 / 补前置检查 |

裁决判据（captain）：**只改点名要求的文件、不碰 `mindcraft/src`、不碰 `config/backup.json`**。本批改动满足该判据：`mindcraft/src` 零改动，`config/backup.json` 零改动。

---

## 6. 残留与诚实边界

1. **`-VerifyOnly`**：验证期间曾对脏工作树红（产物落后于他人未提交的 `web/src`）。t4 重建并重新 stamp 后**当前工作树 8/8 通过**（§2.4）。**若后续再改 `web/`，必须重跑 `scripts/release.ps1`**——这是门在正常工作，不是残留问题。
2. **#55 只做了"覆盖 + 告警"，没做 `-Apply`**：本机 22 条过宽 ACE 仍在。需所有者确认后执行。
3. **#54 冒烟、#52 容器、#53 e2e 未真机跑**：三项都会改本机状态（任务计划 / 容器 / 端口占用），列入 ADR §11.5。
4. **`sync_web_dist.mjs` 的 `--check` 仍会 EXTRA 报 `MANIFEST.json` 之外的文件**：这是既有语义（`SKIP` 集合已含 MANIFEST/README），未改。
5. **`Get-PanelProbe` 用裸 socket 判"是不是本项目"**：依赖 mindserver 的 401 文案（`unauthorized:`）或 Vue 外壳（`id="app"`）。若将来改这两处文案，判定会退化成 `foreign`（表现为"8080 被占用"，属**保守**失败方向，不会造成假成功）。
