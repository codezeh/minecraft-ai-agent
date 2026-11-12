# 整批 diff 复核（t10，防假修复）

**结论：敢合（verdict = pass）。** 六项重点逐条通过，四条"防假修复"判据没有发现把失败改成成功、
没有发现鉴权落在客户端、没有发现事务缺位、也没有发现为让测试变绿而放宽/删除断言。

复核中没有只读文档，而是**自己改坏代码再跑**：共 8 处独立变异（含 t9 已做过的库存超卖），
每处都要求"指定那条用例红 → 复原 sha256 一致 → 复原后全绿"。其中 7 处如期变红；
**1 处（联邦凭证的 4 进程并发用例）需要放大到 12 进程才复现**——见 §4 F1，这条不是假绿，
但"能红"的强度被文档写高了。

- 复核范围：`mindcraft` 仓库 `b1f166a..HEAD`（阶段 2 收尾 → 阶段 3 → 记忆结构化 → 阶段 4 → R6 残留），
  51 个文件、约 8000 行新增；外加父仓 `docs/`、`scripts/`、`web/` 的配套改动。
- 只读复核：所有变异都在临时拷贝或就地改坏后**按 sha256 逐字节复原**，工作树复核后 `git status` 干净。
- 复核脚本（可复跑，均在 `tmp/review/`，已 gitignore）：`redcheck.sh`、`redcheck2.sh`、`deep.sh`、
  `grant_toctou.mjs`、`repro_try.sh` + `repro_doublespend_live.mjs`。

---

## 1. 六项重点的 verdict

### ① people 是权威、且 fail-closed —— **pass**

| 判据落点 | 证据 |
|---|---|
| 人不在表 ⇒ 缓存里的 owner 不生效 | `src/mindcraft/identity_authority.js:85`（`if (!personInfo)` → `level:null, reason:'no-person'`） |
| 人被撤 ⇒ 立刻失效 | `identity_authority.js:93`（`person-revoked`） |
| 缓存与权威对不上 ⇒ 不生效 | `identity_authority.js:103-110`（`person-mismatch`） |
| 权威表缺失/损坏 ⇒ 不授权 | `identity_authority.js:79`（`people-corrupt` / `no-people`） |
| 权限判定真的走这条 | `src/agent/commands/index.js:389` 把 `resolve` 换成 `resolveIdentityAuthority`；`src/agent/permissions.js:234` 优先用它的 `level`，`:247` 在"绑定已启用且没开名字回退"时**一律 guest**（名字不再产生权限） |

**独立验证（我自己改坏的）**：把 `identity_authority.js:85` 的 `if (!personInfo)` 改成"照旧授级"（返回结构合法、不崩溃）
⇒ `identity_authority_unit` 立刻 **A2 + A9 两条红 / exit=1**（`A2 …⇒ no-person（缓存不生效）——ok`、
`A9 …people 里没挂 ⇒ guest ——owner/ok`），复原 sha256 `a2a18235…` 一致、18/18 绿。
> 这同时证明"能红"是真的，而且红的**是断言**不是崩溃（第一版我用 `if (false)` 只是让它崩，
> 那不叫能红 —— 已改成注入 return 的干净变异）。

诚实边界（文档已写明，复核确认）：`identity.enabled=false` 这条配置逃生口会退回"名字即权限"（`permissions.js:254`），
这是**显式配置**而非默认；默认 `enabled=true`（`commands/index.js:350`）。

### ② 库存预占真在 `BEGIN IMMEDIATE` 里 —— **pass**

- `src/agent/library/board_inventory.js:228`（`reserveStock`）、`:273`（`settleTake`）、`:341/:366/:432` 全部 `return runInImmediateTx(db, …)`。
- `src/agent/library/board_store.js:1625` 是 `db.exec('BEGIN IMMEDIATE')`（不是 DEFERRED）；`:1644` `runInImmediateTx` 在 `body()` 返回 `ok:false` 时 **ROLLBACK**、抢锁失败返回 `BOARD_BUSY` 且**不降级**；`:1623` 嵌套事务用 `db.isTransaction` 识别、不重复 BEGIN。
- **变异（t9 我做过、本次复核工作树已复原）**：把 `runInImmediateTx` 改成裸调用 ⇒ `inventory_ledger_unit` ② 红、
  `raced=true`、库里 `total=12 > known=10`（**真超卖**）、exit=1；复原后 sha256 `453a1ebc…` 一致、13/13 绿。

### ③ 对账以"真实箱子"为准 —— **pass**

`board_inventory.js:387` 逐物品算 `delta = actual - cached`；`:400-404` 有差异才写 `reason='reconcile'` 的账本行并把缓存改成 `actual`；
`:389-392` 账实一致**一行不写**（可反复跑无噪音）；`dryRun` 全程只算不写；
`:411-416` "预占 > 真实库存"**不自动撤销**（别人可能正持券开箱）但写进 `warnings` 与 ⚠ 行——这是设计上唯一没自动平的分叉，文档 §4/§8 已声明。

### ④ world 迁移幂等 + 备份真存在 + 旧位置有指路牌 —— **pass**

- 幂等：`src/mindcraft/world_store.js:267` `if (existsSync(to))` 直接返回 `already-migrated`（新旧都在则 `both-exist` 且**不动旧库**，只告警）。
- 备份在搬家**之前**：`:286` `copyFileSync` 逐个后缀（主文件 + `-wal` + `-shm`），`:296` 才 rename/copy 到新位置。
- 指路牌：`:303` 写 `MIGRATED-TO.txt`（含 world_id / to / backup / 回滚步骤）。
- **变异**：把 `:267` 的早退去掉 ⇒ `world_store_unit` **两条精确红**（`第二次 migrated=false / already-migrated —— "no-legacy-board"`、
  `两边都有 → migrated=false / both-exist —— "migrated"`），复原后绿。
- 行为复核（t9）：搬两次后**整棵树（路径+大小+sha256）逐字节一致**，旧库里的 `jobs.legacy-1` 搬家后仍命中（不是重建空库）。

### ⑤ events 真 append-only（无 update/delete 导出、无隐藏写路径）—— **pass（附两条低危注记）**

- 唯一的 `INSERT … INTO events` 在 `src/mindcraft/global_store.js:289`；全仓（`src/` + `tools/` 生产侧）**没有** `UPDATE events` / `DELETE FROM events`。
- 库层两个触发器 `global_store.js:126-131`（`RAISE(ABORT, 'events is append-only: UPDATE/DELETE is forbidden')`），在 `:180` 每次开库安装。
- 导出面：`Object.keys(global_store)` 里**没有任何** update/delete/edit/remove/purge 函数（探针断言，非口头）。
- **变异**：去掉 `db.exec(APPEND_ONLY_TRIGGERS)` ⇒ `global_store_unit` **4 条红 / exit=1**
  （`建出两个追加写触发器`、`UPDATE events 被触发器拒绝 {threw:false}`、`DELETE … {threw:false}`、`两次破坏后内容一字未变`），
  复原 sha256 `15cf9933…` 一致、112/112 绿。
- 低危注记见 §4 F3。

### ⑥ 联邦凭证真单次（重放失败）—— **pass（但"能红"的强度被文档写高了，见 F1）**

- 核销是**一条带四道守卫的原子 UPDATE**（`src/mindcraft/federation.js:218-222`）：
  `WHERE token_sha256 = ? AND revoked_at IS NULL AND expires_at >= ? AND used_count < max_uses`，靠 `changes === 1` 判定；
  `:223-228` 抢不到就回读现状再回答（`lost-race` 兜底）。
- 白名单**先于** token（`:206-210`，空名单 = 谁都不许）；错 token **不烧码**（`:212-216` 只审计不写）。
- 重放行为复核（t9 探针）：`bad-token → ok → already-used`，整表 dump **无明文 token**，名单外 `not-allowlisted`。
- 关系增量幂等：`global_store.js:627+` `pushRelations` 在 `BEGIN IMMEDIATE` 内按 `updated_at` 分派
  （本地无→插入；对端新→覆盖；对端旧→`older` 丢弃；**同 updated_at + 内容一致 ⇒ `identical`**，内容不同按 `${affinity}:${tagsJson}` 确定性 tie-break）。

### ⑦ 新增测试的"能红"证据是不是真做过 —— **pass（7/8 我亲手复现，1 处降级）**

| 声称的破坏 | 我独立复现的结果 |
|---|---|
| events 去掉触发器 | ✅ 4 条红 / exit 1 |
| people `no-person` 放行 | ✅ A2 + A9 红 / exit 1 |
| 队伍去掉队长闸门 | ✅ ⑥ 红（`byMember.ok=true` 直接暴露越权）/ exit 1 |
| world 迁移去掉早退 | ✅ 2 条精确红 / exit 1 |
| 结算去掉幂等短路 | ✅ ⑤ 红（重复结算变成 `RESERVATION_EXPIRED`）/ exit 1 |
| 库存去掉事务（t9 已做） | ✅ ② 红、真超卖 12>10 |
| 凭证去掉 `used_count < max_uses` | ⚠️ **只有 SQL 结构断言红**；4 进程并发用例 0/6 未复现双花（放大到 12 进程才复现，1/2 轮）→ 见 F1 |

---

## 2. 四条"防假修复"判据

| 判据 | 结论 | 依据 |
|---|---|---|
| ① 是否把失败改成静默降级/返回成功 | **没有发现** | 全部新增 `catch` 逐个看过：要么是**清理**（关句柄/删临时文件/回滚），要么是**旁路**（审计写不进不影响业务、缓存刷新失败不改变存取结果），全是文档里声明过的"尽力而为"；**写失败如实返回 `ok:false`**——实测 `recordEvent` 在库建不出来时返回 `{"ok":false,"reason":"write-failed","detail":"ENOTDIR…"}` 而不是假装成功（`global_store.js` 写路径无 swallow）。`board_server.js:206` 的 `ack` 吞的是**客户端回调**的异常（结果已算出），不是业务异常 |
| ② 鉴权与权限是否真在服务端 | **是** | 队伍/库存事件的 avatar **只取服务端裁决**：`actingBot`（`board_server.js:332-375`）按握手角色 + `board:hello` 登记集合校验，`payload.avatar` 一律不读；未知角色显式 `NO_PERMISSION`；`inventoryPre`/`teamPre` 再叠 world 解析。对账的 `holder` 也只取服务端身份（`board_server.js:1162-1170` 注释 + 实现）。面板面：`isPanelConnection()`（`mindserver.js:1535`，角色来自握手凭据）+ 限流；恢复码/改挂/签发都 `panel_only` |
| ③ 事务是否真包住"读-判断-写" | **是** | 预占/结算/对账/建队/入队/登记共享仓/关系增量全部 `runInImmediateTx` / `BEGIN IMMEDIATE`；`beginImmediate` 用 IMMEDIATE（拿不到写锁就 `BOARD_BUSY`，**没有"降级成无锁"的分支**——这正是 `inventory_ledger_unit ②` 与本题变异共同钉住的） |
| ④ 有没有为让测试变绿而放宽/删除断言 | **没有发现** | 唯一改到既有测试的是 `tools/identity_binding_unit.mjs`（+16 行）：只**新增前置** `hardLink(AGENT, NAME)` —— 让夹具满足"people 必须认这只 bot"的新契约，**断言一行没动**（E2/E4 仍断言 owner）；原来"缓存有 owner 但 people 没有"的行为由 `identity_authority_unit` A2/A9/A10 覆盖，覆盖是**搬家**不是丢失。`t37/t52` 只把 `boardDirOf()` 换成 `resolveExistingBoardDir()`（迁移后的正确入口），不涉及断言 |

---

## 3. 逐文件清单（本批生产代码）

| 文件 | 增量 | 复核要点 | verdict |
|---|---|---|---|
| `src/mindcraft/identity_authority.js` | +117 | 四道 fail-closed 分支 + 原因进日志/返回值 | pass |
| `src/mindcraft/people_store.js` | +415 | 恢复码单次（`used_at`）、sha256 落盘、重签作废旧码、`mutatePeople` 带锁与 rev | pass |
| `src/agent/library/whitelist_gate.js` | +88 | 邀请/撤销走 people + 服务端 RCON（不双写 whitelist.json） | pass |
| `src/agent/library/board_store.js` | +366 | schema v5；`BEGIN IMMEDIATE`；唯一索引先建；约束错误翻译成域码（不落 INTERNAL）；`openBoard` 无条件写 user_version（可写探针）+ 只有真损坏才重建 | pass |
| `src/agent/library/board_inventory.js` | +469 | 预占/结算/对账/访客审计（访客 0 行 reservation/ledger） | pass |
| `src/mindcraft/world_store.js` | +334 | 幂等迁移、备份先行、指路牌、`worldIdOfBoardDb` 唯一反解、解析不出就抛 | pass |
| `src/mindcraft/global_store.js` | +702 | 追加写三层护栏、kind 白名单、payload 字节上限、WAL/busy_timeout、关系增量 | pass（F3 注记） |
| `src/mindcraft/federation.js` | +663 | 凭证原子单次、白名单先行、名片 Ed25519 + TOFU、CoreProtect 只读导入 | pass（F1 注记） |
| `src/agent/library/board_server.js` | +309 | 13 个新 handler 统一走 `actingBot` + world 解析 | pass |
| `src/agent/library/board_client.js` | +87 | 13 个方法 + `makeNullBoard` 全给失败默认值（不假装成功） | pass |
| `src/agent/library/flow_store.js` | +37 | 开箱强刷 / 部分取用标脏；**不改变存取成败** | pass |
| `src/mindcraft/mindserver.js` | +107 | 板库按存档分层；人表面板事件 panel-only + 限流 | pass |
| `src/agent/library/contract.js` | +25 | #77 逐分量 `Number.isFinite`；#76 行裁剪后再字符裁剪 | pass（F2 注记） |
| `src/agent/library/bot_paths.js` | +11 | `boardDirForWorld` 单一真相 | pass |

---

## 4. 发现（按严重度；均**非阻塞**）

### F1（low-medium）联邦凭证的"4 进程并发双花"是**不稳定探测器**，文档把强度写高了

- **文档声称**：`docs/audit-r6/fixes4/federation.md:77-78`「把 `used_count < max_uses` 从 WHERE 里去掉，
  4 进程并发用例**立刻**报 `["ok","already-used","ok","already-used"]`、`used_count=2`（真双花了）」；
  `:269` 表格同样标"**真双花**：4 进程 2 个成功"。
- **我实测**：4 进程 × 6 轮（3 轮在 `deep.sh`、3 轮在 `repro_try.sh`）**0 次**双花；
  把进程数提到 **12** 才复现（2 轮里 1 轮 `winners=2 used_count=2`）。
  原因：`redeemVisitGrant` 的 `diagnoseGrant` 预检会在 UPDATE 之前挡住后来者，只有当两个进程的
  `SELECT` 都早于彼此的 `UPDATE` 时才会双花 —— 4 个进程的调度抖动不足以稳定造出这个窗口。
- **不是假修复**：①代码里的守卫**确实承重**——我用两连接确定性交错证明：同样 `A读0/B读0 → A写/B写`，
  带守卫时 `B.changes=0, used_count=1`，去掉守卫则 `B.changes=1, used_count=2`（`tmp/review/grant_toctou.mjs`，3/3 PASS）；
  ②测试里另有一条**确定性**的 SQL 结构断言（"核销用的那条 UPDATE 语句带三道 WHERE 守卫"），
  我去掉守卫时**它确实红了**。所以回归仍会被抓住。
- **建议**：把 4 进程额度提到 ≥8（12 更稳），或改成确定性交错（照 `inventory_ledger_unit ②` 用 db 代理在 diagnose 与 UPDATE 之间插一刀）；
  同时把 `federation.md:77-78` 从"立刻报"改成"需要足够并发才复现，确定性锁靠 SQL 结构断言"。

### F2（low）`truncate()` 在 `maxChars < ~42` 时违反自己的上限

`src/agent/library/contract.js:223-238`：提示语本身约 42 个字符，`cut = max(0, maxChars - note.length)` 会算成 0，
于是返回 `'' + note`，**长度超过 maxChars**。实测：

```
100行×5000字符, maxChars=6000 → 6000 ✅
100行×5000字符, maxChars=100  → 100  ✅
100行×5000字符, maxChars=40   → 42   ❌（超 2）
100行×5000字符, maxChars=10   → 42   ❌（超 32）
```

- **可达性**：两个调用点（`contract.js:252/254`）都用默认 6000，**生产当前打不到**，所以是 latent。
- **建议**：`note` 只在 `maxChars > note.length + 16` 时才附；否则直接 `slice(0, maxChars)`（宁可不解释也不越界）。
  另把这条边界补进 `contract_truncate_unit`（现在只覆盖 6000）。

### F3（low）`openGlobalDb()` 导出裸句柄 ⇒ "唯一写入口/追加写"是**约定 + 测试**，不是能力边界

- `global_store.js:191` 导出 `openGlobalDb()` 返回 `{db}`；拿到句柄的任何模块都能直接
  `INSERT INTO events(...)` 绕过 `recordEvent` 的 kind 白名单与 payload 上限（**改/删仍被触发器挡住**，
  所以"历史不可篡改"这条没被削弱；被绕过的是"事件必须长成合法形状"）。
- 现状：生产侧只有 `federation.js` 用它且只调 `recordEvent`；`tools/federation_unit.mjs:67` 正是靠这条
  直接插"历史遗留行"做迁移夹具——**说明这是有意留的**。
- **建议**：在模块注释里把口径改成"追加写在**库层**强制；kind/payload 在**API 层**强制"，
  或者给 `openGlobalDb` 加 `{raw:true}` 才能拿裸句柄，默认只给受限句柄。
- 顺带（同一条）：读侧在库不可达时抛的是**裸 fs errno**（`ENOTDIR: not a directory, mkdir …`），
  不是带 code 的 `GLOBAL_DB_*`。当前没有生产调用者，等到接线时 socket handler 会把 errno 原文吐给面板。
  建议统一包成 `GLOBAL_DB_UNAVAILABLE`。

### F4（info，**既有、不属本批**）`levelForJobSource` 仍未接线

`src/agent/permissions.js:303-345` 自述"未接线（刻意如此）"：任务单按 `job.source` 定级这条规则
**目前没有任何调用者**（调度器不调）。风险不是"现在是错的"，而是"将来有人用 `{uuid:null, identity:null}` 接上，
就等于把身份旁路又打开"。文档（fixes2/agent.md）已写明，保持现状即可，**别在没拿到下单人 uuid 时接线**。

### F5（info，**既有、不属本批**）`assertJobOwner` 在 DB 读失败时**放行**

`board_server.js:391` `catch { return { ok: true } }` —— `getJob` 抛错就不再校验归属（fail-open）。
实际影响有限（DB 坏了下游 `finish()` 也会失败），但它与"未知一律拒"的风格不一致。非本批引入，记录备查。

---

## 5. 敢不敢合

**敢合。** 理由不是"测试都绿"，而是：

1. 六项重点的行为**在代码里各有唯一落点**，且都能被我改坏后**指定那条用例红**；
2. 四条防假修复判据没有一条踩线：失败没有变成成功、鉴权确实在服务端（`actingBot` + 握手角色）、
   事务确实包住读改写（`BEGIN IMMEDIATE`，抢不到锁就 `BOARD_BUSY` 而非降级）、既有断言没被放宽；
3. 唯一"能红"被打折的那条（F1），**代码是对的、且有确定性的替代断言**，属于证据表述问题，不是功能问题。

前置条件（建议合并前顺手做，都不影响合并结论）：

- [ ] F1：并发额度 4 → ≥8（或改确定性交错）+ 改 `federation.md:77-78` 的措辞；
- [ ] F2：`truncate` 小 `maxChars` 边界 + 补一条单测；
- [ ] F3：`openGlobalDb` 裸句柄口径写清（或加 `raw` 开关）；读侧 errno 包成 `GLOBAL_DB_*`。

---

## 6. 残留清单

| 项 | 状态 |
|---|---|
| 工作树（mindcraft） | ✅ 干净（`git status` 空；复核期间 8 处变异全部按 sha256 复原） |
| 工作树（父仓） | ✅ 干净（本报告是唯一新增，见 commit） |
| 变异临时文件 | ✅ 无（`__mut_federation_review.js` 已删并复查 `ls`） |
| 生产数据 | ✅ 未被改动（复核全程用 `mkdtemp` / 临时 `MC_BOTS_ROOT`） |
| 端口/进程 | ✅ 未起任何服务 |
| 复核脚本 | `tmp/review/`（gitignore）：`redcheck.sh`、`redcheck2.sh`、`deep.sh`、`grant_toctou.mjs`、`repro_try.sh`、`repro_doublespend_live.mjs` |
| 文档与代码口径不一致 | ⚠️ 仅 F1 一处（`federation.md:77-78`，已给改法） |
| 依赖 t9 已报的问题 | `e2e.ps1` 未隔离 `MC_WORLD_DIR`（写生产 `server/world`）——**仍未修**，建议与 F1/F2 一起收；`tools/temp_board.mjs` 已被 owner 提交（34de9c9），此项已消 |
