# t6：整批 diff 复核（防假修复）

> 轮次：R6 fixes5（2026-11-14） · 复核者：gate-runner（t6）
> 范围：工作树 7 个文件的未提交改动 + `5b643fe`（P1-X 备份修复）+ `8f771ef`（t5 验证报告与常驻断言）
> 方式：**只读**。逐条看实现（不只看测试），每条都独立跑一次"能红/能绿"。
> 额外：captain 追加的 P1-X（任务板库迁移导致自动备份失败）已纳入复核。

---

## 0. 结论：敢不敢合？

**7 条缺陷：敢合。** P1-1 / P1-2 / P1-3 / P2-4 / P2-5 / P2-6 / P2-7 逐条看过实现，四条判据都没有命中，
每条都有我独立复跑的"改回缺陷态必红"。

**P1-X（备份链修复）：先补 2 行再合（needs_revision）。** 主逻辑（`backup-world.ps1` 的路径解析、
zip 键形状、`restore-drill` 的 manifest 驱动）**是对的**，我独立验证到 zip 条目一级；
但同一条链上还漏了**第三个**消费方 `verify-world-backup.ps1`，它现在对**每一份正确的新备份**都报
`exit 1`（实测 136 通过 / 1 失败）；另外 `restore-drill` 新增的"多候选"分支会**记了 FAIL 却退出 0**。
两处都是 10 行内的修，但不修就等于"备份能备了、核验工具说不行"——和刚修掉的那条是同一族缺陷。

| 项 | verdict | 一句话 |
|---|---|---|
| P1-1 send-message 凭据冒充 owner | **pass** | 面板门在投递之前，全仓 `data.from` 身份链只剩一条且已在门后 |
| P1-2 !stop 作废待启动票 | **pass** | 作废在 `stop()` 里、只对 `player`、`preempt`/`timeout` 不受影响；开工前复核位置正确 |
| P1-3 compose 重复 environment | **pass** | 键集合与 HEAD 逐字相同（4/4，零丢失）、无重复；门禁对 3 类畸形都能红 |
| P2-4 事件筛选竞态 | **pass** | 真实 store 打包 + 假 socket 时间序；变异体精确变红 |
| P2-5 销毁后 token 仍有效 | **pass** | 撤销在"确认退出之后"；既有连接真失效（断 + revoked 戳双保险）；登记表回基线 |
| P2-6 get-profile 无面板门 | **pass** | 两个入口都过 `requirePanelRole`，且都在读盘之前；HTTP 侧 `/api/config` 另有门（核过） |
| P2-7 其他 java 阻塞备份 | **pass** | 规范绝对路径（非关键词）；`session.lock` 仍是硬闸门（`$evidence -gt 0 ⇒ exit 2`） |
| **P1-X 备份链（captain 追加）** | **needs_revision** | 主逻辑对，漏了 `verify-world-backup.ps1`；`restore-drill` 新增分支静默退出 0 |

---

## 1. 四条判据的专项检查

### ① 有没有把失败改成静默降级 / 返回成功？

| 位置 | 判定 | 依据 |
|---|---|---|
| `deliverSendMessage` 的每条拒绝路径 | 干净 | 都 `reply({ok:false, code, message})` 且返回 `{ok:false, code}`，没有"吞掉但回 ok" |
| `readProfilesList / readProfileFile` | 干净 | 读盘失败 `callback({ok:false, reason})`，不抛也不谎报 |
| `revokeAgentToken / revokeCredential` | 干净 | 返回 `{revoked, dropped}` 真实计数；找不到凭据返回 `false` |
| `pausePendingJob` / `_cancelPendingLaunch` 的 try/catch | **有意降级，可接受** | 注释写明"控制层失败不该挡住'停'本身"；主判据（票作废）是同步、无 IO 的，不依赖这块。副作用：板写失败时单子可能停在 `claimed` 等租约过期，但**不会开工** |
| `pendingJobBlocked` 的 fail-open（读不到就放行） | **有意降级，可接受** | 反向选择（fail-closed）会因"镜像还没刷成 claimed"而拒掉合法开工；主判据仍是票作废。属设计取舍，已在注释说明 |
| **`restore-drill.ps1:511` 的 `return`** | **命中（见 Finding F2）** | 记了 2 条 FAIL 后 `return`，把汇总与 `exit $exitCode` 一起跳过 ⇒ **进程退出 0** |
| **`verify-world-backup.ps1:392-398`** | **命中（见 Finding F1）** | 硬编码旧键 ⇒ 对正确新备份报 FAIL（假失败，方向相反但同族） |

### ② 鉴权是否真在服务端？

- P1-1：`requirePanelRole` 在 `deliverSendMessage` 的**最前面**（`mindserver.js:822`），投递在其后；
  唯一的 `emit('send-message')` 全仓只有 `mindserver.js:848` 一处，面板侧 `web/src/stores/agents.ts:390` 只是调用方。
- P2-6：两个模块级函数在**读盘之前**过同一道 `requirePanelRole`（`:890` / `:944`），handler 只做转发（`:1996-2003`）。
- 补充核查（我一开始怀疑过）：`/api/config` 的 router 定义里 `app.use('/api/config', router)` 在 1585 行，
  但那是 `attachConfigApi()` 的**函数体**；真正挂载发生在 `:1749`，在 HTTP token 门（`:1705-1734`）**之后**。
  ⇒ 没有绕过。`profileInfo()` 只回 `name/api/model`，不含 `permissions`。

### ③ 有没有为让测试变绿而放宽断言？

`tools/bot002_action_start_unit.mjs` 的 diff 里**被删的行只有 1 行**：`-function makeAgent() {`
（改成 `function makeAgent({ board = null } = {})`，并给假 agent 加了 `board` / `scheduler`）。
其余 223 行全是新增。新增的 E/F/G/H/I 五组**都是加严**：

- E：断言 `secondRan === false`（原缺陷为 `true`）+ `state === 'paused'` + `cancelledBy === 'player'`
- F：`paused` / `cancelled` 两态都必须拒开工，且拒绝后槽位干净（`executing===false && pending===null`）
- **G**：`preempt` 的新动作**必须照常开工** —— 这是"防过度修复"的反向断言，比原有用例更严
- H：`timeout` 也不许误伤
- I：单子被暂停时**即时命令仍要能开工**（防"顺手把 `!follow` 也拒掉"）

没有发现任何"把断言改弱以迁就实现"的痕迹。

### ④ 修复是不是只把测试改成迁就现状？

不是。四条行为级变异我都亲手做过（在 t5 与本次复核中各一次）：
删掉判据后 **A1/A1b/A1c/A1d、B4/B4b/B6/B7、C1/C1b、E 组 4 条** 分别变红，复原后全绿，
且复原用 sha256 逐字节核对。测试是"驱动真实现"，不是"复述实现"。

---

## 2. 逐条复核明细

### P1-1 —— pass

| 复核点 | 结论 | 证据 |
|---|---|---|
| `send-message` 是否真 requirePanel | 是 | `mindserver.js:810-824`：`gate()` 在 findAgent / 形状 / 限流 / 投递**之前**；判据只有 `requirePanelRole` 一处 |
| 载荷是否白名单拷贝 | 是 | `:848` `emit('send-message', { from: data.from, message: data.message })` —— 只这两键 |
| **是否还有别的路径把 `payload.from` 当身份** | **没有（全仓扫过）** | `mindcraft/src/**` 里 `data.from` 只剩 2 处：`mindserver.js:848`（唯一 emit，已在门后）→ `mindserver_proxy.js:133`（`respondFunc(data.from, ...)`）。其余命中是注释与无关的 `text.js` |
| 新开的 bot 间通道发送者是否服务端填 | 没新开；`chat-message` 本批未改 | `:2628-2653`：`isAgentIdentity` 校验 + 目标过 `knownAgent` + 发送者用服务端 `curAgentName`，**不读 payload 里的 from**；agent 侧 `isOtherAgent(sender)` ⇒ `from_other_bot` ⇒ 不执行命令（`agent.js:712,740`） |

⚠️ **口径提醒（t5 已写，复核确认）**：任务书"伪造 from ⇒ 目标 bot 收不到该字段"的措辞不准。
实测是 **agent 凭据 ⇒ 整条消息都到不了**；**面板**发 `from` 时服务端**保留** `from`（设计语义=替玩家说话）。
对外别写成"from 被剥离"。

### P1-2 —— pass

| 复核点 | 结论 | 证据 |
|---|---|---|
| 作废是否真在 `stop()` 里 | 是 | `action_manager.js:117` `if (CANCELLED_PENDING_STOP_REASONS.has(r)) this._cancelPendingLaunch(r, exceptTicket)` |
| **是否把 `preempt` 一并作废** | **没有** | `:14` `new Set([STOP_REASONS.PLAYER])`；`STOP_REASONS` 全集 = brief/preempt/player/timeout/shutdown/death ⇒ 只有 `player` 进集合。抢占调用点 `board_scheduler.js:796`、`:1094-1105` 传 `PREEMPT` ⇒ 不受影响（G 组用例实测 `ran.new === true`） |
| 生产路径真的会传 `player` 吗 | 会 | `commands/actions.js:146` `await agent.actions.stop('player')`（`!stop`）；`:623` `!stay` 走 `runAsAction(..., 'player')`。**该文件本批未改** ⇒ 不是"新加了一个没人调的常量" |
| 开工前复核是否在"拿到票之后、执行之前" | 是 | 顺序：票登记 → `await stop()`（`:367`）→ superseded 分支 → `this._pendingLaunch = null`（认领）→ 僵尸检查 → **`pendingJobBlocked` 复核（`:411`）** → `clearBotLogs` → opId → `executing = true` → `actionFn` |
| 复核只认"任务单自己的票" | 是 | `gateJobId = isJobLabel(actionLabel) ? ticket.jobId : null` —— 挡住"把玩家随后的 `!follow` 也拒掉"（I 组用例） |
| `isJobLabel` 是否存在（会不会 ReferenceError） | 存在且非新增 | `control.js:77` 早于本批 |

### P1-3 —— pass

| 复核点 | 结论 | 证据 |
|---|---|---|
| `environment` 是否真只剩一个映射 | 是 | `docker-compose.yml:5` 唯一一处（4 空格缩进）；第二个键头在 diff 里被删掉，后续键在 6 空格 ⇒ 同属一个映射 |
| **有没有变量在合并里静默丢掉** | **没有（脚本核对）** | 用脚本解析 HEAD 的两个块并集 vs 现在：`["SETTINGS_JSON","MIND_SERVER_HOST","MINDSERVER_TOKEN","MC_WORLD_DIR"]` 两边完全相同，丢失 0、新增 0、无重复 |
| 门禁是否够严（防"门禁太弱=没修"） | 够严 | 我用 4 个对抗夹具试探：同层重复键 ⇒ 红（报两行号）；**flow 式**重复 ⇒ 红；**嵌套同名键**（`MC_WORLD_DIR` 两次）⇒ 红且指出值不对；缺 `MINDSERVER_TOKEN` ⇒ 红并点名。反向对照：**加一个新变量** ⇒ 只 NOTE 不拦（不过度严格） |
| 是否零新依赖 | 是 | 只看 `compose-gate.mjs` 的 import：全 `node:` 内置 |
| 接线是否 fail-closed | 是 | `release.ps1:266-271` `Invoke-Tool` 非零即 `Stop-Release` |

### P2-4（含 t7 的四个 loader）—— pass

| 复核点 | 结论 | 证据 |
|---|---|---|
| 守卫是否真在源码里（不是测试里造） | 是 | `world.ts` 里 6 个独立计数器 `eventsSeq/eventStatsSeq/teamsSeq/chestSeq/stockSeq/ledgerSeq/federationSeq`，各自 `++` 后在各回执处 `if (seq !== X) return` |
| 是否"各自独立、绝不共用" | 是 | 每个 loader 各自一个变量；`loadTeamChests` 额外用 `teamSeq` 双判据（挡"上一队的仓库"） |
| 会不会把视图卡在 loading | 不会 | 新一代请求自己也写 `phase='loading'`，最后由最新一代写回；旧回执丢弃不改变状态机 |
| 测试是否真变异真实源码 | 是 | `world-events-race-unit.mjs:71-100`：esbuild 打包真实 `src/stores/world.ts`，`onLoad` 里按 `RACE-GUARD <label>` 删行造变异体 |
| 断言强度 | 强 | 真实源码 A 13/13 + B 14/14；7 个变体各自只红自己那组（我实跑 20/20 PASS） |

### P2-5 —— pass

| 复核点 | 结论 | 证据 |
|---|---|---|
| 撤销是否真在"确认进程退出之后" | 是 | `mindcraft.js:166` `if (!r.exited) return {ok:false,...}`（**不撤**）；确认退出 → `delete agent_processes[name]`（`:171`）→ `revokeAgentTokenByName(name)`（`:174`） |
| not-found 分支 | 幂等撤 | `:153` 没有进程条目也撤（`createAgent` 失败路径/自杀残留） |
| **已有连接是否真的失效**（还是一只删注册表） | **真失效，双保险** | `invalidateAgentSocket`：先盖 `socket.data.revoked = true`，再 `disconnect(true)`。`socketRole()` 见 revoked 一律返回 null；`isAgentIdentity` 走 `socketRole`（⇒ agent 身份不成立）；`requirePanelRole` 同理 |
| 撤销会不会被 `login-agent` 的旧式分支绕过 | 不会 | `claimAgentChannel:495` 先要求 `agentIdentity`；revoked socket 的 `socketRole()` 为 null ⇒ `isAgentIdentity` 为 false ⇒ 到不了"旧式共享凭据"分支（该分支只对"从未逐 agent 发放凭据"的连接开放，属已登记残留） |
| 注册表是否还会无限增长 | 不会 | `revokeCredential` 按 token 删单条；`agentTokens.delete(name)`；实测 create/destroy 后 `credentialCount()` 回基线 |
| 面板凭据会不会被误删 | 不会 | 面板凭据是 `handshakeToken`，不在 `EXTRA_CREDENTIALS` 里 |
| 顺序正确性 | 正确 | 我自己判过一次：`revokeAgentTokenByName` 先按 token 断"出示该 token"的连接、再断"通道绑定"的连接；两者都幂等（`s?.data?.revoked === true` 跳过重复计数） |

### P2-6 —— pass

| 复核点 | 结论 | 证据 |
|---|---|---|
| `get-profiles` 有门 | 是 | `readProfilesList:890`，在读盘之前 |
| `get-profile` 有门 | 是 | `readProfileFile:944`，在读盘之前 |
| 是否只补 socket、HTTP 侧还漏 | 不漏 | `/api/config` 在 `:1749` 挂载，晚于 HTTP token 门 `:1705`；`profileInfo()` 只回 name/api/model |
| 原有边界是否保留 | 保留 | `path.basename` 防穿越、列表只回相对名（`dir: path.basename(...)`）、不存在回 `reason` 不抛 |

### P2-7 —— pass

| 复核点 | 结论 | 证据 |
|---|---|---|
| 是否用规范绝对路径（不是关键词匹配） | 是 | `server_proc.ps1`：`[System.IO.Path]::GetFullPath((Join-Path $root 'server\server.jar'))` → 小写 + 斜杠归一 → `Contains`。`server.jar`/`paper` 这类字面量已从判据里消失 |
| `session.lock` 检查是否保留 | 保留，且仍是硬闸门 | `backup-world.ps1:225-228` 三维 lock；`$evidence.Count -gt 0` ⇒ **`exit 2`**（`:560-577`），不是只打印 |
| 三处是否共用同一判据 | 是 | start-panel 委托（保留 `$null` 语义）、stop-panel 等待循环、backup 的 evidence |
| 真实进程验证（我独立做过） | 通过 | 造一个**同名不同路径**的 `server.jar`（`tmp/…/foreignmc/server.jar`）常驻：`OWN_COUNT=0` 而 `ALL_JAVA=1`；备份失败原因是板库路径、**不是** java 占用 |

---

## 3. P1-X（captain 追加）专项复核

### 3.1 `Resolve-BotsBoardPath` 三态 —— 符合描述（实测）

抽**真身**函数（不另写副本）在夹具上跑：

```
zero      | Ok=False | Reason=找不到任务板库：既没有 _worlds/<id>/_board/board.sqlite，也没有 _board/board.sqlite
one       | Ok=True  | Rel=_worlds/w-aaa/_board/board.sqlite
multi     | Ok=False | Reason=发现多个存档的任务板库（2 个）：…w-aaa…; …w-bbb… —— 不猜该备份哪个，请显式指定
legacyOnly| Ok=True  | Rel=_board/board.sqlite
```

0 个⇒拒绝并说清；1 个⇒返回 POSIX 相对路径；多个⇒**拒绝且不猜**；仅旧路径⇒回退。全部符合 captain 描述。

### 3.2 最该复核的一点：`Replace` 键形状 vs zip 内条目 —— **一致（独立验到条目级）**

代码链：`$rel = $resolved.Rel`（相对 `mindcraft/bots`，如 `_worlds/w-xxx/_board/board.sqlite`）
→ `New-WorldZip` 里 `$zip.CreateEntry("$Leaf/$rel")`（`Leaf='bots'`）⇒ 条目 `bots/_worlds/…/board.sqlite`。
`manifest.entries[].databases` 的键用 `$boardRel = 'bots/' + $resolved.Rel`（`:687`），与 zip 条目同形。

**独立实测**（不采信 captain 的结论，自己解包看）：

```
bots.zip 里 board 相关条目 5 条：
  bots/_board/board.sqlite{-shm,-wal}.bak-20261113224422   ← 迁移前留下的备份，属正常
  bots/_board/MIGRATED-TO.txt
  bots/_worlds/w-20261113-96c12b98/_board/board.sqlite     ← 139264 B（快照）
解出来的快照：user_version=5 · 10 张表（claims,container_cache,inventory_audit,inventory_ledger,
  inventory_reservation,jobs,shared,team,team_chest,team_member）· integrity_check=ok · jobs=15 行
manifest：entries[kind=bots].databases["bots/_worlds/w-20261113-96c12b98/_board/board.sqlite"] = {method:"VACUUM INTO", bytes:139264, sha256:8b9720…}
```

⇒ 键形状正确**且**快照真的被换进去了（不是"备份成功但内容是旧库"）。这一项 **pass**。

### 3.3 有没有别的脚本还在读旧路径 —— **漏了一个（Finding F1）**

我对 `scripts/**`（24 个文件）做了穷尽扫描（`scanComplete=true`，16 处命中），逐条判定：

| 位置 | 性质 | 判定 |
|---|---|---|
| `backup-world.ps1:253/265/267/270` | 解析器本体 | 正确（优先 `_worlds/*`，回退旧） |
| `backup-world.ps1:687` | manifest 键 | 正确 |
| `backup-world.ps1:888-892` | **仓库根** `bots/`（11-02 前遗留目录）的存在与版本，写进 manifest 的说明字段 | **captain 的判断对：故意不改没错** —— 它不 throw、不参与备份，只是把"_board 已过期（user_version=…）"记进 note。仓库根 `bots/_board/board.sqlite` 确实是**未迁移**的老库 |
| `restore-drill.ps1:514` | 老备份回退 | 正确（默认只在 manifest 无记录时用） |
| `restore-drill.ps1:518` | 失败文案 | **硬编码旧路径**（Finding F3，low：诊断误导） |
| **`verify-world-backup.ps1:393`** | **功能性硬编码** | **F1（medium）：对每份正确新备份都报 FAIL** |
| `verify-world-backup.ps1:21/403` | 文档与注释 | 随 F1 一起改 |

`mindcraft/tools/board_user_version_check.mjs` 走 `resolveExistingBoardDir()`（world_store），**没有**硬编码；
我实跑：`PASS 8 / WARN 0 / FAIL 0`（user_version=5、26 列齐全、quick_check ok）。⇒ 这个不用改。

---

## 4. Findings

### F1 [medium] `verify-world-backup.ps1:392-398` 硬编码旧板库键 ⇒ 对着**正确**的新备份报假失败

**问题**：`$boardKey = 'bots/_board/board.sqlite'`，用它在 `manifest.entries[kind=bots].databases` 里查存在性。
迁移后 manifest 的键是 `bots/_worlds/<id>/_board/board.sqlite` ⇒ `$hasBoard = false` ⇒ `Bad`。
紧接着的通用循环（`:399-408`）又按 manifest 逐条 `Ok` 同一个库 ⇒ **同一份包自相矛盾**。

**实测（不可辩驳）**：对 captain 那份**正确**备份跑一次

```
FAIL bots.zip 含任务板快照 bots/_board/board.sqlite   任务板库不在包里 = 恢复后任务单/预约/共享地标全丢
PASS bots.zip 含 bots/_worlds/w-20261113-96c12b98/_board/board.sqlite  139264 字节
PASS bots/_worlds/w-20261113-96c12b98/_board/board.sqlite 用 VACUUM INTO 取快照
→ VWB_EXIT=1（136 项通过，1 项失败）
```

**为什么要修**：`backup-world.ps1:973` 自己提示用户"核验：`verify-world-backup.ps1 -BackupDir …`"。
用户照着做会看到"任务板库不在包里"，于是要么以为备份坏了、要么学会忽略这个工具 ——
后者正是 captain 在 P1-X 里亲自点名的那句"演练形同虚设"。

**requiredFix**：把 `:392-398` 改成与 `restore-drill` 同一口径（manifest 驱动）：

```powershell
$boardProps = @($dbMap.PSObject.Properties | Where-Object { $_.Name -like '*/board.sqlite' })
if ($boardProps.Count -ge 1) { Ok "... 含任务板快照 $($boardProps[0].Name)" }
else { Bad "... 含任务板快照" '任务板库不在包里 = ...' }
```

（多候选时下游的逐条循环本来就会把每个都查一遍，不需要在这里判死。）

### F2 [medium] `restore-drill.ps1:511` 记了 FAIL 却 `exit 0`（新增分支上的静默成功）

**问题**：多候选分支里 `Add-Result 7/8 ... $false` 之后是一个**裸 `return`**。该 `return` 在 `try{}` 内，
而"汇总 + `exit $exitCode`"在 `try/catch/finally` **之后**（`:704-711`）。
PowerShell 语义：`return` 会执行 `finally` 然后**结束脚本**，跳过 try 之后的全部语句。

**最小复现（我造的等价结构）**：

```
try { $script:res += FAIL; return } catch { } finally { Write-Host "finally-ran" }
Write-Host "SUMMARY-RAN"      # 不打印
exit 1                         # 不执行
→ 输出 finally-ran，EXIT=0
```

**端到端复现（不是推断）**：复制那份正确备份、往 manifest 的 bots 条目加第二个 `*/board.sqlite` 键，跑演练：

```
PASS #1..#6
FAIL #7 任务板 integrity_check=ok manifest 里有 2 个 board.sqlite，无法判定
FAIL #8 任务板 jobs/claims/shared 行数与 manifest 相等 多份候选
（没有"恢复演练 FAIL：…"汇总行，也没有 report.json 路径）
DRILL_EXIT=0     ← 记了 2 条失败却退出 0
```

**边界（我验过，避免夸大）**：正常失败路径是**对的** —— 我把 manifest 的 board 记录删掉（回退旧路径⇒解压后找不到），
走的是普通 `Add-Result` 流程：打印 `恢复演练 FAIL：12 通过 / 2 失败` 且 **`DRILL_EXIT=1`**。
所以这是**新增分支独有**的问题，不是整脚本瘫痪。

**requiredFix**（任选其一，都在 10 行内）：
- 把汇总与 `exit $exitCode` 移进 `finally`（最稳，以后再加早退也不会漏）；
- 或把 `Add-Result ... ; return` 换成 `throw "…"`（由 `catch` 收口，`:673` 已置 `exitCode=1` 并写报告）。

### F3 [low] `restore-drill.ps1:518` 失败文案硬编码旧路径

`Add-Result 7 ... '解压后找不到 bots/_board/board.sqlite'` —— 当 `$boardRel` 是新路径时，文案指错地方。
与 F1 同族（"报错看不出真因"）。**requiredFix**：`("解压后找不到 {0}" -f $boardRel)`。

### F4 [low] 竞态单测的变异体不校验"替换是否命中"

`world-events-race-unit.mjs:87-91` 按 `RACE-GUARD <label>` 注释标签删行造变异体，但**没有断言替换真的发生**。
将来若有人重排注释、把标签写错/删掉，变异体会与真实源码逐字节相同。
好消息：那时"变异体必须变红"的 verdict 会失败（测试仍会响），不会静默放过；
坏消息：报错文案会指向"守卫没生效"而真因是"变异没打上"，排查会绕一圈。
**requiredFix**（可选）：`if (!src.includes('RACE-GUARD ' + label)) throw`；或统计替换次数，为 0 就报"变异未命中"。

### F5 [low/note] `stop-panel.ps1` 在 CIM 不可用时**静默**当作"没有服务端在跑"

`:69-79` 用 `Get-OwnServerJava`（默认走 CIM）。CIM 不可用时它返回空 ⇒ 等待循环立刻通过 ⇒ 直接进自动备份。
P2-7 已经明确接受"不把'所有 java'当占用"的取舍（`backup-world` 那边会 WARN 一句），
但 `stop-panel` 这里**一句提示都没有**。风险由 `backup-world` 的 `session.lock` 硬闸门兜底，故只记 low。
**建议**：CIM 取不到时补一行 `Write-Host '  WARN 读不到进程命令行…'`（与 backup 口径一致）。

### 观察项（不是缺陷，但别被下一个人改回去）

1. **`from` 的语义**：面板凭据投递时服务端**保留** `from`（=替玩家说话）。这是设计，不是漏改。
   若有人"顺手"把 `from` 换成服务端常量，会改变 owner 命令的语义 —— 要有意为之，不能当 bug 顺手修。
2. **`chat-message` 转发整个 `json`**（`:2653`）：`received.start` 等字段会影响 agent 侧对话状态。
   本批未改、发送者恒为服务端 `curAgentName`、且只聊天不执行命令，故不构成本批问题；
   若将来要收口，应改成白名单 `{ message }`。
3. **`ops-regression.mjs` 的 5 条常驻断言（`8f771ef`）是本人（gate-runner）在 t5 里写的** ——
   按"不审自己的实现"的规矩，这一项**不算我的 pass**：请 captain 另找一人复核该 5 条断言的强度。
   我能提供的客观事实只有：`122 passed / 0 failed`，以及 `,$own` / `$false` / 插入内联 CIM 三种变异各自精确变红。

---

## 5. 我没能验证到的（诚实清单）

| 项 | 原因 |
|---|---|
| `verify-world-backup.ps1` 修好后能否 137/137 | 依赖 F1 先修；修完我可以用同一份备份再跑一次（1 分钟内） |
| 多候选分支在**真实**部署里出现的概率 | 备份侧不可能产出多候选（解析器拒绝）；只有手改/外部 manifest 会触发 ⇒ 现实中罕见，但"静默退出 0"的代价与概率无关 |
| `preempt` 在真机（E2E）层面的行为 | 已由 G 组单测覆盖（真 `ActionManager` + 真 `runJobAction`），E2E 里没有"抢占"场景 |
| `chat-message` 的 `json.start` 语义 | 属 pre-existing 行为，本批未改；只做了代码路径判断，没做行为实验 |
| Windows 上 `.mindserver-token` 的 ACL 边界 | 属 t1 已登记的既有权限模型边界，本批不改 |

---

## 6. 残留

- 代码：**未做任何修改**（本任务只读）。工作树状态与开工时一致：
  `M scripts/{release,start-panel,stop-panel}.ps1`、`M web/src/{stores/world.ts,components/world/EventsPanel.vue}`、
  `?? scripts/{compose-gate.mjs,lib/server_proc.ps1}`、`?? web/scripts/world-events-race-unit.mjs`；
  mindcraft 侧 7 个已提交/已改文件不变。
- 进程/端口：java 0 个；25565-25568 / 8080 无监听。
- 临时文件：`tmp/review6/`（我的夹具与探针，52 KB）；`tmp/drill-20261113-235525/`（captain 的演练现场，未动）。
- 备份：`backups/world-20261113-234124` 是 P1-X 修复后第一份成功备份（我解包核过），无 `.partial` 残留。

---

## 7. 复现命令

```powershell
# F1：对"正确的新备份"跑核验工具 ⇒ 现在 exit 1（修好后应 137/137）
powershell -File scripts/verify-world-backup.ps1 -BackupDir backups/world-20261113-234124

# F2：多候选 manifest ⇒ 记 FAIL 却 exit 0（修好后应 exit 1 且有汇总）
cp -r backups/world-20261113-234124 tmp/ambig
node -e "const fs=require('fs'),p='tmp/ambig/manifest.json',m=JSON.parse(fs.readFileSync(p));
const b=m.entries.find(e=>e.kind==='bots'); b.databases['bots/_board/board.sqlite']=Object.values(b.databases)[0];
fs.writeFileSync(p,JSON.stringify(m,null,2))"
powershell -File scripts/restore-drill.ps1 -BackupDir tmp/ambig ; echo "EXIT=$?"

# P1-3 门禁的三类畸形（均应 exit 1）+ 加新变量（应 exit 0）
node scripts/compose-gate.mjs tmp/review6/fx/{flow-dup,nested-dup,missing-token}.yml
node scripts/compose-gate.mjs tmp/review6/fx/extra-key.yml

# P1-X 解析器三态
powershell -File tmp/review6/rb_probe.ps1

# 七条的"能红"（t5 已固化）
node tmp/verify7/reverse.mjs
cd web && node scripts/world-events-race-unit.mjs
```
