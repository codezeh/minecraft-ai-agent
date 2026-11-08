# R4 运维手册（RUNBOOK）

> 适用范围：本机 `E:\我的世界ai`（父仓）+ `E:\我的世界ai\mindcraft`（嵌套独立仓）。
> **本机只有 `powershell`（Windows PowerShell 5.1），没有 `pwsh`。** 下文所有命令都按 5.1 写。
> 复制命令时注意：**路径用反斜杠**，但在 MSYS/Git-Bash 里跑 `powershell -File ...` 时，参数里的反斜杠会被 Bash 吃掉 —— 在 Bash 里请改用**正斜杠**（`backups/world-xxx`），或整体加单引号。
> 每条命令后面都给了「看什么算成功」，别只看有没有报错。

---

## 0. 通用约定

| 项 | 值 |
|---|---|
| 仓库根 | `E:\我的世界ai` |
| 子仓 | `E:\我的世界ai\mindcraft` |
| 服务端 | `E:\我的世界ai\server`（Paper，`server.jar`） |
| 备份产物 | `E:\我的世界ai\backups\world-<yyyyMMdd-HHmmss>\` |
| 演练/临时目录 | `E:\我的世界ai\tmp\`、`E:\我的世界ai\mindcraft\tmp\`（都在 `.gitignore` 里，不污染 git） |
| JDK | `E:\我的世界ai\.tools\jdk-21.0.12.1+1\bin\java.exe`（脚本自动探测，无需设置 PATH） |
| 端口占用 | 生产/测试服 `25565`/`25566`；E2E 用 `25566`（RCON `25576`）；演练用 `25567`（RCON `25568`）；控制台 `8080`；release smoke 用 `18090`（可 `-HostPort` 改） |
| 统一执行方式 | `powershell -NoProfile -ExecutionPolicy Bypass -File <脚本> <参数>` |

**脚本编码纪律**：`scripts\*.ps1` 必须是 **UTF-8 with BOM**。PS 5.1 读无 BOM 的 UTF-8 会按 GBK 解析中文，直接报语法错。已有脚本都带 BOM（`start-panel.ps1`/`stop-panel.ps1` 除外，它们是纯 ASCII）。

---

## 1. 备份（冷备）

> **默认冷备，要求服务端已停。** 运行期热备份在本机物理上不可能成功（`world/session.lock` 与 `region/*.mca` 被服务端独占），所以脚本会**主动拒绝**而不是给你一个坏包。

### 1.1 正常流程

```powershell
# ① 先关服（面板方式）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-panel.ps1
# ② 确认 java 已退出（应该没有任何输出）
Get-Process java -ErrorAction SilentlyContinue

# ③ 冷备
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup-world.ps1
```

**成功判据**：退出码 `0`，且最后打印
```
==> 完成：E:\我的世界ai\backups\world-<时间戳>
    组件：world, world_nether, world_the_end, bots, plugins, server-config, logs
    一致性：已保证（Cold）
```

### 1.2 退出码（照此判读，不要猜）

| 退出码 | 含义 | 怎么办 |
|---|---|---|
| `0` | 成功 | — |
| `1` | 备份过程失败 | 看上面的 `FAIL`/`ERROR` 行；半成品在 `backups\*.partial`，可加 `-KeepPartial` 保留现场 |
| `2` | **拒绝：服务端在跑** | 先 `stop-panel.ps1` 关服再跑 |
| `3` | **拒绝：`-Mode Hot` 没加 `-Force`** | 热备没有意义，请改用冷备 |

### 1.3 可选参数

```powershell
# 不想把 RCON 口令打进备份 → 排除 server/server.properties（manifest 会记录"已排除"）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup-world.ps1 -ExcludeSecrets

# 保留最近 N 份（默认 7）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup-world.ps1 -Keep 14

# 指定输出目录
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup-world.ps1 -OutDir D:\bk
```

> ⚠️ **备份目录是敏感数据**：默认包含 `server/server.properties`（内含 `rcon.password`）。别外传、别 `git add`。脚本自己也会打这条警告。

### 1.4 定期备份 —— **未实现，需你决定**

本轮**没有**做计划任务（`grep schtasks|Register-ScheduledTask scripts\*.ps1` = 0 命中）。要自动化请自行用「任务计划程序」调上面的命令，并注意：**冷备要求先停服**，所以自动化必须包含「停服 → 备份 → 起服」，否则每次都会 `exit 2`。

---

## 2. 验证备份

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-world-backup.ps1 -BackupDir backups\world-20261108-034843
```

**成功判据**：最后一行
```
ALL PASS: 137 项通过，0 失败（0 项警告）
```
退出码 `0`。

**要点**
- 验证是**逐项与 manifest 相等**（计数/摘要/来源），不是"文件存在就算过"。这是修掉「验证器假绿灯」（B2）后的口径。
- 要求 `schemaVersion >= 3`。**旧格式 `backups\world-20261108-030525` 会 FAIL，这是预期行为**（它没有来源与 SQLite 快照字段），不要拿它判红。
- 有效对照样本：`backups\world-20261108-034843`、`backups\world-20261108-071529`（均 137 项 0 失败）。

---

## 3. 恢复演练（不碰生产数据）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restore-drill.ps1 -BackupDir backups\world-20261108-034843
```

**成功判据**：
```
恢复演练 PASS：12/12 条断言通过
证据：E:\我的世界ai\tmp\drill-<时间戳>\report.json
      E:\我的世界ai\tmp\drill-<时间戳>\report.md
```
退出码 `0`，耗时约 33 秒（含起服）。

**安全性**：只解压到 `tmp\drill-<ts>\`，**绝不写 `server\` 与 `backups\`**；用隔离端口 `25567`/RCON `25568`，不会撞生产服。

**12 条断言覆盖**：manifest 存在 → 包 SHA256 → region/playerdata 计数 → `.mca` 头部 → NBT 可读 → 板库 `integrity_check` + 行数 → `memory.json` 可解析 → 世界 `Done (` → 日志 0 ERROR → RCON `stop` → `All chunks are saved`。

加 `-KeepArtefacts` 保留现场（默认清理骨架）。

---

## 4. 真恢复（灾难恢复，会覆盖生产数据）

> 这一节是**手工**操作，脚本不代做。**先确认服务端已停**。

```powershell
# 1) 关服并确认 java 退出
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-panel.ps1
Get-Process java -ErrorAction SilentlyContinue

# 2) 现有世界改名留底（不要直接删）
Rename-Item server\world        world.bak-20261108
Rename-Item server\world_nether  world_nether.bak-20261108
Rename-Item server\world_the_end world_the_end.bak-20261108

# 3) 解压世界（按备份里的组件逐个来）
Expand-Archive backups\world-<ts>\world.zip         -DestinationPath server\ -Force
Expand-Archive backups\world-<ts>\world_nether.zip  -DestinationPath server\ -Force
Expand-Archive backups\world-<ts>\world_the_end.zip -DestinationPath server\ -Force
```
4) **任务板只还原 `board.sqlite` + `board.sqlite-wal`，丢掉 `-shm`**（SQLite 会重建共享内存索引；还原 `-shm` 反而可能不一致）。
5) 起服，检查日志里没有任何 chunk/level 相关报错。

> 为什么丢掉 `-shm`：备份里是用 `VACUUM INTO` 做的一致快照，`-wal` 语义已被快照消化；把活跃库的 `-shm` 拷回去属于把两套索引混在一起。

---

## 5. 隔离服 E2E

```powershell
# 跑两个场景（claims 抢单争用 + restart 重启恢复）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\e2e.ps1 -Scenario all
```

**成功判据**：
```
E2E 通过：23/23 条断言全部通过
```
退出码 `0`。**连跑两次，两次都应 23/23 且断言集一致**（单次绿不足以排除抖动）。

**它自己做了什么**：在 `tmp\e2e\<scenario>\` 建一次性运行目录 → 从 `test-template\world` 复制干净世界 → 起服（等 `Done (` + RCON 可用）→ 跑场景断言 → RCON `stop` → **重置世界并逐文件 sha256 校验** → 汇总。每个场景用独立 `MC_BOTS_ROOT`，不污染仓库 `mindcraft\bots\`。

**起服前先探端口**（尤其在你还开着别的服/面板时）：
```powershell
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 25566,25567,25568,8080 } | Select-Object LocalAddress,LocalPort,OwningProcess
```
有占用就先停掉，否则 E2E 会起服失败（表现为等 `Done (` 超时）。

参数：`-Scenario claims|restart|all`（默认 `restart`）、`-KeepRun`（保留运行目录排查）、`-SkipReset`（不重置）、`-BootTimeoutSec`（默认 180）。

> **未覆盖**：容器存取（开箱/存物）场景**没有**做成 E2E 场景，只有历史真机脚本；见 §12。

---

## 6. 发布与镜像

### 6.1 三种模式

```powershell
# A) 全链路：build → 同步产物 → 指纹校验 → docker build → 起容器 → /console 200 + 首个 asset 200 → 清理
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release.ps1

# B) 只重建产物（不动 docker）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release.ps1 -SkipDocker

# C) 只校验（不构建）：产物/清单/源码三方一致 → 8/8
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release.ps1 -VerifyOnly

# D) 保留镜像（排查用，不删）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release.ps1 -KeepImage
```

**成功判据**
- B：`ALL PASS: 8 passed, 0 failed` + `web-dist 已同步`
- C：8 条 PASS（结构完整 / 9 个文件逐条一致 / 无野文件 / 2 个入口引用可找到 / 源码指纹 / 产物指纹 / 产物与源码一致 / 产物与清单一致 / 入口引用一致）
- A：额外 `PASS GET /console → 200（跟随 301 到 /console/）`、`PASS GET /console/assets/<当前入口>.js → 200`、`PASS /console 的 HTML 确实引用了 assets/<...>`

### 6.2 本机 docker 在 WSL 里（PATH 里没有 `docker`）

直接跑 `release.ps1` 会报"执行不了 docker 命令"。用这两个参数：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release.ps1 `
  -DockerExe "wsl -e sudo -n docker" -ProbeExe "wsl -e curl" -HostPort 18092
```

### 6.3 发布纪律（改过 `web/src` 就必须走这条）

1. 提交 `web/` 的改动；
2. `release.ps1 -SkipDocker` 重建产物；
3. **提交 `mindcraft/web-dist/`（含 `MANIFEST.json`）**；
4. `release.ps1 -VerifyOnly` 必须 8/8。

漏掉第 3 步，干净克隆构建出来的就是旧 UI（`-VerifyOnly` 会报"产物与源码不一致"，把差异的 hash 打出来）。

---

## 7. 身份绑定：给玩家发码（① 玩家身份）

### 7.1 发码流程

1. 用带 token 的地址打开控制台：`http://localhost:<port>/?token=<启动日志里那个>`；
2. 控制台**左侧「玩家身份」区** → 选 agent → 点 **「生成绑定码」**；
3. 把码（形如 `ABCD-EFGH`）告诉玩家，让他**5 分钟内**在游戏里发：`!claim ABCD-EFGH`；
4. 成功后玩家等级变为 `owner`，面板「已绑定」列表里能看到。

**码的三条硬约束**：**5 分钟**内有效（`code_ttl_ms` 上限 300000）、**只能用一次**、**绑定签发它的那个面板会话**（面板断开 ⇒ 该会话未核销的码全部作废；同一会话只留最新一个码）。

### 7.2 撤销

面板「玩家身份」区 → 已绑定列表 → **解绑**。写 `bots\<agent>\identity.json`，**立刻生效**，无需重启。

### 7.3 ⚠️ 离线服的根本限制（必须告诉玩家，别承诺做不到的事）

本机 `server.properties` 是 `online-mode=false`（离线服）。离线服下**服务端下发的 uuid 由玩家名字派生** ⇒ 任何人把客户端名改成同一个名字就拿到同一个 uuid。于是：

| `identity_binding.offline_owner_mode` | 离线服上 owner 能不能拿到 | 含义 |
|---|---|---|
| `deny`（**当前默认**） | **拿不到**（任何人，包括真主人，都只到 guest） | 最安全；离线服上身份不可证 |
| `session` | **拿得到，但有时限**（仅刚用面板码 `!claim` 后的 N 分钟内） | 只是压缩冒名窗口，**不是身份证明** |

**根治只有两条部署决策**（不改代码）：
1. `server.properties` 设 `online-mode=true`（正版验证）；或
2. 装登录插件（如 AuthMe），让"进服"本身需要密码。

改法（示例，**由你决定是否做**）：
```json
// mindcraft/settings.js 或其 profiles 里
"identity_binding": {
  "enabled": true,
  "offline_owner_mode": "session",     // deny | session
  "offline_session_minutes": 60,
  "legacy_profile_names": false         // true = 退回"按名字给权限"（离线服上不安全）
}
```

---

## 8. 门禁与单测

在 `mindcraft` 目录下跑：

```powershell
cd E:\我的世界ai\mindcraft

# 硬门（patch 完整性 / 密钥文件名 / settings / preflight 正则 / preflight / lint_hard）
npm run gate

# 全量门禁 = 硬门 + 全部单测
npm run gate:full

# 只跑单测（约 2 分钟）
node tools/unit_all.mjs

# tools/ 的 lint 棘轮（只许降不许升）
node tools/lint_ratchet.mjs
```

**当前期望值**
| 命令 | 期望 |
|---|---|
| `node tools/unit_all.mjs` | `130/130 个脚本通过，4 个跳过`，exit `0`（4 个跳过是「需真机数据」的既定项） |
| `npm run gate` / `gate:full` | exit `0` |
| `node tools/lint_ratchet.mjs` | `272 ≤ 278（上限）`，exit `0` |

> **lint 基线**：`tools/lint_tools_baseline.json` 里记录的上限**当前仍是 278**，实测总数 **272**（低于上限 6 条）。脚本会提示"可以收紧基线了（`--update`）" —— 收紧到 272 是**由队长决定的收口动作**，本手册不代替执行。**永远不要**用 `--update` 去**抬高**上限：棘轮的意义是只许降。
>
> ⚠️ **注意 `unit_all` 有一次已知抖动**（见 `R4-验收报告.md` 的 F1）：`tools/board_scheduler_unit.mjs` 的 ⑩-① 是时序敏感的（走 `runSlowScene` 真定时器），批跑时偶发 `129/130`，**紧接着复跑即 130/130，单跑 3/3 全绿**。遇到它红，先单独跑一次 `node tools/board_scheduler_unit.mjs` 再判断，不要直接当产品回归。

---

## 9. RCON 协议回归（3 秒，离线）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tests\rcon-regression.ps1
```
**成功判据**：`ALL PASS：7 项通过`，exit `0`。它用一个**按真实协议校验密码**的假服务器，覆盖「正确密码成功 / 错误密码失败 / **把命令当密码发必须失败**（老 bug 的写法）」以及"端口没人监听要快速失败"。

> 为什么要有这条：真实 Paper 会回 `id=-1` 并断开，但**自制假服务器曾经不看 auth 正文**，于是"把命令当密码发"藏了很久（RCON `save-off` 从来没生效过）。这是那条缺陷的回归网。

---

## 10. 一次完整验收（改动后照这个顺序）

```powershell
cd E:\我的世界ai

# 1) 产物与源码一致（改过 web/src 必须先 -SkipDocker 重建并提交 web-dist）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release.ps1 -VerifyOnly

# 2) 门禁 + 单测
cd mindcraft; npm run gate:full; node tools/lint_ratchet.mjs; cd ..

# 3) 收尾三件（都是真跑）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\e2e.ps1 -Scenario all
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restore-drill.ps1 -BackupDir backups\world-20261108-034843
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tests\rcon-regression.ps1
```
验收记录见 [`R4-验收报告.md`](R4-验收报告.md)。

---

## 11. 待用户决策（**我没有替你决定任何一条**）

| # | 事项 | 现状 | 选项 / 代价 |
|---|---|---|---|
| D1 | **离线身份策略 A/B/C** | 默认 `deny` ⇒ **离线服上 owner 不可达**（真主人也只到 guest） | **A** 收回监听（`server-ip=127.0.0.1`）：挡全部远程冒名，牺牲手机/局域网；**B** 装登录插件 AuthMe：挡冒名，要装插件+玩家注册；**C** 一次性绑定码（已实现）：冒名者拿不到码只能 guest，但离线服上仍无法证明"你是你"（同 D2） |
| D2 | **是否开正版验证 / 装登录插件** | `online-mode=false` | 这是**唯一**能让离线服身份成立的两条根（详见 §7.3）。开正版会挡住盗版客户端；AuthMe 要额外插件与注册流程 |
| D3 | **是否 push 到远端** | 父仓**没有配置任何 remote**；`mindcraft` 有两个：`mine`（你的 fork）、`origin`（upstream `mindcraft-bots/mindcraft`） | 父仓需要先 `git remote add`；`mindcraft` 只能推 `mine`，**不要**推 `origin`（那是上游） |
| D4 | **`backups/world-20261108-030525` 旧格式备份** | `schemaVersion` 不满足 `>=3` ⇒ `verify` 会 FAIL（预期） | ① 删掉（省 70MB+）；② 留作历史，但**不要再拿它做验证基线**；③ 用新脚本重做一份再删 |
| D5 | **RCON 口令轮换** | 已从 32 位轮换为 **48 位随机**；`broadcast-rcon-to-ops=false`；防火墙规则 `deny-rcon-25575-in`（Inbound/Block）**已启用** | 仍是**明文**存在 `server.properties` 且走 loopback 明文传输。要更好：定期轮换口令（改完记得 `stop-panel` 重启生效）；或改成仅本机回环 + 不做远程运维 |
| D6 | **是否做定期备份** | **未实现**（无计划任务） | 见 §1.4：自动化必须包住"停服→备份→起服"，否则每天 `exit 2` |

---

## 12. 本轮未做 / 未覆盖（**如实列出，不许当成已修**）

| # | 项 | 状态 | 说明 |
|---|---|---|---|
| N1 | **容器存取场景的 E2E** | ❌ 未做 | E2E 只有 `claims` / `restart` 两个场景。`-Scenario` 的合法值就是这三个，容器存取（开箱/存物守恒）**没有**自动化场景，只有历史真机脚本 |
| N2 | **13 个适配器原生迁移到 `ModelResult`** | ❌ 未做 | 现有 18 个适配器多数仍走 `toModelResult(...)` 桥接层；`agent.js:753` 与 vision 的"步1"也没改；旧字符串契约仍在（删契约 = 步3，未做）。**行为正确由桥接层保证**，但类型迁移没完成 |
| N3 | **`promptMemSaving` / `ShouldRespond` / `Vision` 不下传 `opts`** | ❌ 未做 | `prompter.js` 只有 convo(:335) 与 coding(:499) 传第 4 参；:544/:587/:627 仍是 3 参 ⇒ 这三条路径**拿不到取消信号与动作期限**（超时仍由适配器自身的 120s 期限兜底）。`sendVisionRequest` 同样 3 参 |
| N4 | **`init_agent.js` 的 `gracefulStop` 未实测** | ⚠️ **仅静态确证** | 代码在 `init_agent.js:88-108`（`setAutoClaim(false)` → `scheduler.stop('preempt')` → `board.stop('preempt')` → `update{state:'ready',lease_*:null}` → `release` → `socket.disconnect()`），孤儿自杀分支在 `:70-84`。但 E2E 只 RCON 停 **Minecraft 服务端**、两个 E2E 驱动都不创建 `BoardScheduler`/`Agent` ⇒ **没有任何一次实测**证明"停手时租约真被摘掉、顺序正确"。<br>**转实测的做法**：起真 agent（`node main.js`）→ 让它领一张单 → 发 `SIGINT` → 断言板库里该单 `lease_until IS NULL` 且 `state='ready'`、`assignee IS NULL` |
| N5 | **截断检测的覆盖边界** | ⚠️ 17/18 | 已收敛到 `result.js` 的单一判定（`isOutputLimit`：`length`/`max_tokens`/`model_length`）。**`replicate` 结构性不可检测**（SDK 只返回纯字符串，没有 `finish_reason`，代码里已声明）。`azure` 继承 `gpt`，随 `gpt` 一并覆盖。<br>（旧说法"缺 6 个适配器"已过期：那 6 个已由 t2 用 `finishReason` 补齐） |
| N6 | **重试策略仍不统一** | ⚠️ 未统一（已注释说明） | 会话侧**不重试**（`prompter.js:341-342` 明确写了理由：一次超时会放大成三次），编码侧仍 `MAX_ATTEMPTS=5`（`coder.js:61`）。差异是**有意保留**，但"三套策略"没有收敛成一套 |
| N7 | **离线模式下身份不可证** | ⚠️ 结构性限制 | 见 §7.3 / D1 / D2。这是部署问题，不是代码问题 |
| N8 | **`vitest`/`eslint` 对模板串插值里的未定义标识符不报错** | ⚠️ 已知盲区 | `${WHERE}` 这类错误能一路绿到生产（`no-undef` 抓不到模板插值）。本轮靠人工发现，没有加自动化防线 |
| N9 | **`board_scheduler_unit` ⑩-① 时序抖动** | ⚠️ 测试健壮性 | 批跑偶发 `129/130`（`hbBefore=3`），复跑即绿、单跑 3/3 绿（`hb=2`）。它断言"心跳拍数停住 + 主动摘租约"，而 `runSlowScene` 用真定时器 ⇒ 机器负载抖动会多出一拍。**产品行为未见异常**（同批 ⑩-②③⑤ 全绿证明停租/释放链成立）。建议改成"不依赖拍数等于 2"的判据（例如只断言"停后拍数不再增长"且"租约字段被清空"） |
| N10 | **`release.ps1` 会重写 `MANIFEST.generatedAt`** | ℹ️ 行为说明 | 每跑一次全链路/`-SkipDocker` 都会把 `generatedAt` 刷新（`artifact.hash`/`source.hash` 不变），所以 `web-dist/MANIFEST.json` 会显示为"已修改"。**产物内容没变**，提交时只需带上这一行变化即可（本轮我提交过两次这种纯时间戳提交） |

---

## 13. 相关文档

| 文档 | 用途 |
|---|---|
| [`R4-验收报告.md`](R4-验收报告.md) | 本轮验收的逐条命令/证据、已实测 vs 静态确证分档、两项红项的"为什么没被发现" |
| [`00-结论与优先级.md`](00-结论与优先级.md) **§11** | **收口台账**：24 条 S1/S2/S3 + H1~H6 + B1~B6 + 三个架构项的 已修/仅静态/未修/用户决策 |
| [`T13-玩家身份.md`](T13-玩家身份.md) | 身份方案设计、离线模式的根本限制 |
| [`T22-RCON协议.md`](T22-RCON协议.md) | 为什么 `save-off` 从来没生效过（RCON auth 正文必须发密码） |
| [`T11-隔离服E2E.md`](T11-隔离服E2E.md) | E2E 判据与两次一致性证据 |
