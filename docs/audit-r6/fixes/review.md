# R6 整批 diff 复核（防假修复）· t8 / gate-runner

> 只读复核：**没有修改任何产品代码**。基于 t7 的验证结果，逐个读 diff + 定点反证。
> 结论先说：**敢合**（verdict = pass）。14 项改动没有发现"把失败改成成功"的假修复；
> 事务是真的包住了读-判断-写；鉴权是真在服务端判的；**没有任何测试被放宽或删除**
> （整批 diff 里 `tools/` 只多了一个新测试文件，另一个是**加强** +40 行）。
> 另有 5 条 low 级观察（不需要打回，但接手的人应当知道）。
>
> 另：t7 报的红灯 F1（#18 只修源码、`web-dist` 是旧包）**在本轮复核前已被修掉并提交**
> （子仓 `204f784`），我**验证了那个修复和它新增的门禁都是真的**（不是把门禁写宽）。

---

## 0. 逐条 verdict

| # | 缺陷 | 结论 | 关键证据（文件:行） |
|---|---|---|---|
| 1 | #2 控制面鉴权 | **pass** | `auth_gate.js:151-215`、`mindserver.js:1310-1345`、`:1823-1865` |
| 2 | #18 前端离线闸 | **pass**（F1 已修） | `web/src/stores/diag.ts:118-190`、子仓提交 `204f784` |
| 3 | #4 共享合并抢锁失败 | **pass** | `board_store.js:1522-1560`、`:2400-2445` |
| 4 | #5 预约事务 + 唯一索引 | **pass**（我做了 DB 层反证） | `board_store.js:145`、`:213-235`、`:1592-1650` |
| 5 | #6 坏库重建证据 | **pass** | `board_store.js:300-360`、`:455-495` |
| 6 | #3 任务板身份绑定 | **pass（含已披露缺口）** | `board_server.js:112-350`、`:263-280`、各写事件 |
| 7 | #16 limit / 限流 / 未终结上限 | **pass** | `board_store.js:738-755`、`board_server.js:288-350`、`:451-461` |
| 8 | #12 取消链 | **pass** | `history.js:28-50,150,158`、`coder.js:28-50,100`、`vision_interpreter.js:28-50,141,153` |
| 9 | #13 save 不再抛 | **pass** | `history.js:337-380`、`agent.js:1169-1193` |
| 10 | #14 memory 损坏抢救 | **pass** | `history.js:473-620`、`:500-560` |
| 11 | #15 setup 异常退出码 | **pass** | `agent.js:400-430` |
| 12 | #17 缺同伙不再 killAll | **pass** | `tasks.js:330-395`、`:620-650`、`:706-720`、`wait_for_teammates.js` |
| 13 | #19 双账本合并 | **pass（含 2 条 low 观察）** | `landmarks.js:40-290`、`:300-350`、`:505-525`、`skills.js` 多处 |
| 14 | #7 供给 + 手动备份读配置 | **pass** | `scripts/provision.ps1`、`scripts/backup-world.ps1:118-175`、`lib/backup_config.ps1:33-95` |
| — | 测试是否被放宽/删除 | **pass（强证据）** | 见 §3 |

---

## 1. 四个重点问题的直接回答

### 1.1 有没有把「失败」改成「静默降级 / 返回成功」？—— **没有**

我按"失败必须可见"逐个查了失败分支，重点看是否有人把 `throw` 换成宽 `catch` 后再报成功：

| 位置 | 改前 | 改后 | 判定 |
|---|---|---|---|
| `board_store.js:2400-2445` `mergeSharedChest` | 抢锁失败 → `catch{inTx=false}` → **无锁读改写后 `return ok:true`** | `runInImmediateTx` 返回 `{ok:false, code:'BOARD_BUSY'}`，**回滚** | ✅ 真修 |
| `board_server.js:733` `board:shared-merge` | ack 只回 `reason`（调用方拿不到码） | 透 `code` | ✅ |
| `board_store.js:300-330` WAL/busy_timeout | `try{…}catch{}` 静默 | 执行后**读回核对**，不生效进 `warnings` + `console.warn` + 返回给调用方 | ✅ |
| `history.js:337-380` `save()` | `catch → throw`（unhandled rejection 打挂进程） | 只记 `saveError`、返回 `false`，**不抛**；`agent.js` 3 处收口到 `saveMemoryQuietly()` | ✅（这是"失败不再杀进程"，不是"失败变成功"：错误仍被 `console.error` + `saveError` 记录） |
| `history.js:473-620` `load()` | 解析失败 `catch → throw`（永久起不来） | 留证 → 抢救 → 只救不出才降级，且 `console.error` 吵闹；**没有任何分支静默清空记忆** | ✅ |
| `landmarks.js:240-280` `persistChest` | — | 写失败 `pushError` + `console.warn`，`dirty` **不删除** | ✅ 不谎报 |
| `tasks.js:330-395` 等同伙 | 固定 10s + `killAll()` 关整机 | 轮询 + 超时只 `cleanKill(msg, 4)` | ✅ |

**唯一"看起来像"的地方**（我判定可接受，但必须写明）：

- `landmarks.js:365-395` `rememberChest()` 写完缓存**立即 `return true`**，落库是异步的。
  → 语义已写进注释与 `ledger.md`：「true 表示已记进本地账本缓存」，落库失败走
  `chestLedgerErrors(bot)` + `console.warn`。命令层（`!putInChest` / `storeItem` / `verifyChest`…）
  都改成 **`await flushChestWrites(bot)` 之后才对外报成功**（`skills.js:1533,1587,1620,4540`）。
  → 但 `flushChestWrites` 本身**吞掉**失败（"单条失败已记进 errors，不打断调用方"）。
  于是"物品真的放进箱子了、账本没写进去"这种情况，**模型看到的仍是 Successfully put**。
  物理动作确实成功（东西真的移进去了），账本是索引/缓存 —— 我判**不是假修复**，但属
  **low 观察 L1**（见 §4）。

### 1.2 鉴权是否真在服务端生效，而不是只在前端隐藏按钮？—— **是，服务端**

- 角色是**凭据种类**判定的：`auth_gate.js:151-190` 登记表 + `credentialRole()`（逐条 `tokenEquals` 定长比较），
  握手门把结论写 `socket.data.role`（`auth_gate.js:203-225`）。
- 两份不同随机串：`mindserver.js:856-876` `handshakeToken`（面板）/ `agentToken`（agent，仅经 env 继承）。
- 管理面 12 个事件接 `requirePanel()`（`mindserver.js:1310-1345`；`:1467-1937` 逐处），
  拒绝时 `console.warn` + 回 `control-denied`。`shutdown` 走单独判据（`:1823-1865`）。
- 前端**没有**新增任何"藏按钮"式鉴权：整批 web 改动只有 `diag.ts` 的离线闸（`web/src/stores/diag.ts:118-190`）。
- **不是**靠隐藏 UI：我用 `mindserver_gate_unit`(49)/`control_plane_guard_unit`(73) +
  源码 grep 交叉确认（`isPanelConnection` 只在 `:1323` 定义一处，旧判据只剩注释 `:1310`）。

兼容性也核对过：`bot-output` / `agent-event` / `chat-message` / `get-settings` / `login-agent`
**都没有**被 `requirePanel` 包住（逐条 grep 确认），agent 主流程不会被误杀。

### 1.3 事务是否真的包住了「读-判断-写」？—— **是，两处都真包了**

- `board_store.js:1515-1560`：`beginImmediate()` 用 `BEGIN IMMEDIATE`（不是裸 `BEGIN`），
  抢不到就返回 `{ok:false, code:'BOARD_BUSY'|'INTERNAL'}`；`runInImmediateTx()` 对
  "body 抛错 / body 返回 ok:false / COMMIT 失败"三种情况都 **ROLLBACK 并如实返回**。
- `reserve()`（`:1592-1650`）：`expireClaims → 查 live → 比对 conflicts → INSERT`
  **整段在一个 `runInImmediateTx` 里**（我逐行确认缩进与作用域，不是"只加了 try/catch"）。
- `mergeSharedChest()`（`:2400-2445`）：`getShared → 合并 → putShared` 同样整段在事务里，
  `putShared` 返回 `ok:false` 时主动 `return {ok:false}` 让外层 ROLLBACK。
- 事务原语的"嵌套"判定用的是 `db.isTransaction` —— 我实测 node:sqlite **真有**这个属性
  （`:memory:` 上 `BEGIN IMMEDIATE` 后为 `true`，`COMMIT` 后为 `false`），不是我行我素的自造字段。
- 最后一道闸（跨进程）：`claims.key` **唯一索引**。我做了 DB 层反证（§2.1）：绕过 `reserve`
  直接插两行同 key，第二行被 `UNIQUE constraint failed: claims.key` 拒绝。

### 1.4 有没有「为了让测试变绿」放宽断言 / 删测试？—— **没有，而且有强证据**

- 整批工作区 diff 里，`tools/` **只有新增** `tools/runtime_survival_unit.mjs`（`??` 未跟踪），
  **没有任何既有测试文件被修改或删除**（`git diff --stat` 12 个文件全是 `src/`；`git status tools/` 只有那一个 `??`）。
- 已提交的两个收尾提交里，唯一被改的测试文件是 `tools/web_dist_manifest_unit.mjs`，而且是
  **+40 行新增校验**（`204f784`），不是放宽。
- 计数变化有解释且方向是"加"：133 → **134**（+1 新脚本，`unit_all` 用 `readdirSync` 自动发现）。
- 反向检查"生产代码为测试开后门"：新增的缝都是**注入式**（`opts.now` / `sleep` / `MC_TASK_WAIT_BOTS_MS`
  / `opts.quiet`），生产默认值不变，没有"检测到测试就跳过工作"的分支。

---

## 2. 我另外做的反证（不是重跑报告，是自己找证据）

### 2.1 `claims.key` 唯一索引在 DB 层真的有效（#5 的最后一道闸）

```text
索引 = sqlite_autoindex_claims_1(plain) / uq_claims_key(UNIQUE) / idx_claims_until(plain)
直接插 (j1, block:1,2,3, A) → ok
直接插 (j2, block:1,2,3, B) → ✅ UNIQUE constraint failed: claims.key
claims 行数 = 1
```

→ 即使 `reserve` 的判断被绕过（或第二个写者根本不走 `reserve`），数据库也不会出现"双占"。

### 2.2 生产库迁移（t7 做的）与本次复核的关系

t7 在**生产库副本**上跑过 v2→v3：`shared=26` 零丢失、`idx_claims_key` 被 `uq_claims_key` 取代、重开幂等。
与本次代码读完的结论一致：`ensureClaimsUniqueKey`（`:213-235`）先按 `until` 最晚去重，再
`DROP INDEX IF EXISTS idx_claims_key` + `CREATE UNIQUE INDEX`，且**在 `db.exec(SCHEMA)` 之前**调用
（`:245-258`）—— 否则 SCHEMA 里的 `CREATE UNIQUE INDEX` 会因老库重复行直接失败。这个顺序是对的。

### 2.3 `judge` 是否在服务端（#2）

- `login-agent` → `bindAgentChannel` → `claimAgentChannel({agentIdentity: isAgentIdentity(socket)})`，
  **`identity-required`** 直接拒绝非 agent 凭据的连接（`mindserver.js:306-335`、`:1624-1631`）：
  也就是说**面板连接不能把自己绑成某个 agent 通道**。这一格是我最担心"只在前端隐藏"的地方，实测在服务端。
- 通道接管有上限（`maxTakeovers=3 / 30s`）且**明说给旧连接**（`agent-channel-taken-over` + `disconnect`），不静默换主人。

### 2.4 `web-dist` 重建是真的（F1 收尾复核）

```text
web-dist/MANIFEST.json generatedAt = 2026-11-10T15:40:14Z（本地 23:40，晚于 diag.ts 的 21:08）
新语义字符串「清空未执行 / 本地视图保留 / 未连接 mindserver」→ 三个都 FOUND
web_dist_manifest_unit → ALL PASS 10/10，其中第 10 条：
  「产物绑定的源码指纹与当前 web/src 一致」清单=sha256:f6044919cc90… 当前=sha256:f6044919cc90…（29 个输入）
```

**我确认这条新门禁不是同义反复**（读实现 `tools/web_dist_manifest_unit.mjs:88-135`）：
它真的 `readFileSync` 每个 `web/src/**` + 5 个根文件、逐文件 sha256、按 `release.ps1` 同构算法拼指纹，
再与 `MANIFEST.source.hash` 比。改一行源码 ⇒ 指纹变 ⇒ 必 FAIL。这是**加强**门禁，不是把门禁写宽。
`web-dist` 也已提交（不在 `git status` 里），运行时与源码一致。

### 2.5 备份口令策略的"配置缺失"退化路径（#7-②）

`backup_config.ps1:33-95` 的默认值是 `excludeSecrets = true`（fail-safe）：
配置文件不存在/损坏 ⇒ 打 WARN + 用默认 true。**不会**因为配置丢了就产出明文口令备份。
实际配置 `config/backup.json` 也是 `excludeSecrets:true`。互斥开关 `:149-152` 直接 exit 1（我实跑过）。

---

## 3. 测试面专项结论

| 检查 | 结果 |
|---|---|
| 既有测试文件被修改 | **0**（`git diff --stat` 无 `tools/*`；`git status tools/` 只有 `?? runtime_survival_unit.mjs`） |
| 既有测试被删除 | **0** |
| 断言被放宽 | **未发现**；唯一被改的测试文件是 **+40 行加强**（`204f784`） |
| 测试数变化 | 133 → 134（+1 新文件，`readdirSync` 自动发现） |
| 生产代码是否因测试而变松 | 未发现"检测测试环境就跳过"分支；新增缝均为可注入参数/环境变量，默认值不变 |
| 门禁是否真的会红 | 见 §2.4（源码指纹不符必 FAIL）、§2.1（UNIQUE 真的会拒） |

> 补充：`board_scope_unit.mjs:106` 这类"故意传非法 scope 期望报错"的负例仍在，没有被改成"放行"。

---

## 4. Low 级观察（不需要打回，接手的人要知道）

### L1 账本写失败时，模型看到的仍是「Successfully put」
`skills.js:1525-1540`：物品物理入箱成功 → `updateChestContents` → `await flushChestWrites` → `return true`。
若 `flushChestWrites` 内部那一条 `sharedPut` 失败，`flushChestWrites` 吞掉（`landmarks.js:227-233`），
模型侧文案不变。**缓解**：失败进 `chestLedgerErrors()` + `console.warn`（`landmarks.js:120-128`），
且 `ledger.md §5` 已把它列为残留（`warnings` 未接面板）。
**建议**（下批）：`flushChestWrites` 返回 `{ok, errors}`，`!putInChest` 在账本失败时补一句
"东西已放入，但账本没记上（别人可能查不到）"。

### L2 `BOARD_BUSY` 到客户端被折成 `INTERNAL`
`board_client.js` 的 `contractCodeOf`：`BOARD_BUSY` 不在 `contract.CODES` → 回落 `INTERNAL`。
**不是假修复**（`ok:false` 仍明确失败、不会被当成功），但调用方无法据此区分"锁忙可重试"与"真内部错"。
`board.md` 已说明"6 个自造码折到已注册码"的口径；`BOARD_BUSY` 是 store 层码，没进 CODES。
**建议**：要么把 `BOARD_BUSY` 注册进 `CODES`，要么在 `BOARD_CODE_TO_CONTRACT` 里显式映射成可重试码。

### L3 #3 的缺口是"共享 agent 凭据"，不是"没修"
持 agent 凭据的进程仍可 `login-agent` 去抢别人的名字（会被唯一占用裁决 + 接管限速 3/30s + 日志 +
通知旧连接，属**可观测越权**）。`board_server.js:160-175` 与 `control.md`/`board.md` 都写了这条残留。
**要真封闭必须 per-agent 凭据**——不在本批范围（team goal 明确只做"控制面鉴权"这一层）。

### L4 `assertJobOwner` 查单异常时放行
`board_server.js:263-280`：`getJob` 抛错 → `return {ok:true}`。
不会造成假成功（下游 `updateJob/finish` 自己也会因同一个坏库报错），但归属校验会**跳过**。
**建议**：抛错时返回 `{ok:false, code:'INTERNAL'}` 更保守。

### L5 `board:list` 现在会**拒绝** `limit > 500`
`board_server.js:330-341` 是"拒绝"不是"静默夹"，符合 #16 要求（不再 `LIMIT -1` 读全表）。
仓库内**没有任何调用方传 `limit`**（我 grep 过 `src/`，只有 server 自己），所以不会打断现有链路；
但若有外部脚本/面板传 1000，行为会从"能跑"变成"被拒"，属**有意的破坏性收紧**，发布说明里值得提一句。

---

## 5. 仍属静态推断 / 未真机验证的部分

| 项 | 证据级别 | 说明 |
|---|---|---|
| 多进程真实并发写板库（`BOARD_BUSY` 真触发） | **静态 + 单测**，我另做了 DB 层反证 | 没有起两个进程同时写；`board_open_migrate_unit` 里有一条"另一连接持 EXCLUSIVE → 原样 throw"，但那是同进程连接 |
| 真 MC 服上的箱子账本跨 bot 可见 | **单测/双 socket** | `board_b4_unit:222-224` 是 in-process server + 两个 BoardClient；没起真 bot 进程 |
| 浏览器断线 + 点清空（#18） | **静态 + 类型检查** | 且我在 t7 报告里已标：真机 E2E 未做（control.md 自陈） |
| agent 发 `shutdown` 被拒 | **单测** | `control_plane_guard_unit` 覆盖判据；没起真 socket 冒烟 |
| `history.save()` 磁盘满的真实行为 | **单测** | 用 mock 抛错；没制造真磁盘满 |
| `provision.ps1` 在干净 clone 的端到端供给 | **t5 自述真跑**，我**没重跑** | 我只跑了 `-DryRun`（EXIT=0，指纹一致）；干净 clone 那部分不可复现于当前工作树 |
| `memory.json` 真损坏样本的抢救 | **合成坏文件** | 无真实损坏样本（`runtime.md` 已自陈） |

---

## 6. 「敢不敢合」

**敢合。**

- 四类"假修复"我逐项找了，**没有命中**：没有把失败改成成功（`BOARD_BUSY`/`saveError`/`loadError`/
  `chestLedgerErrors` 都是可见失败）、鉴权在服务端、事务真包住读-判断-写、测试只增不减且门禁被加强。
- t7 报的唯一红灯 F1 已在本轮复核前修掉，**我验证了修复本身与新增门禁都是真的**（不是把门禁写宽绕过）。
- 5 条 low 观察都是"可观测性/粒度"问题，不是"用户会被骗"的问题；其中 L2 与 L1 建议下批顺手收掉。
- 合之前建议（非阻塞）：
  1. 确认线上板库在下次 `openBoard` 时完成 v2→v3（已证安全，t7 §5.1）；
  2. 发布说明里提一句 `board:list` 现在会拒 `limit > 500`（L5）；
  3. 把 §5 里"静态推断"的几项排成下批的真机/E2E 清单，别再靠单测代表真机。
