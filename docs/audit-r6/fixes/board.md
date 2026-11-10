# R6 #4 / #5 / #6 / #3 / #16 —— 任务板事务、身份归属与窗口上限

> 缺陷：R6 报告 #4（`mergeSharedChest` 吞掉 `BEGIN IMMEDIATE` 失败仍返回成功）、
> #5（`reserve()` 是 check-then-write，`claims` 无 `UNIQUE(key)`）、
> #6（坏库自动重建在多写者下毁数据、WAL 设置失败静默）、
> #3（任务板 socket 层零鉴权，`bot`/`owner` 全部取自 payload 自述）、
> #16（`board:list` 的 `limit` 直通 SQL ⇒ `LIMIT -1` = 无上限；`board:add` 无限流）。
>
> 共同病根：**把"我以为的"当成"已经成立的"** ——
> 锁没抢到却报成功、事务外读改写却当地址已锁、把"任何一个异常"当坏库、把"payload 里写的名字"当身份、
> 把"调用方给了个数字"当合法窗口。#4/#5/#6 是"数据库层的假设没人验"，#3/#16 是"外部输入没人验"。

| 项 | 值 |
|---|---|
| 成员 | fix-board（t2） |
| 写作用域 | `mindcraft/src/agent/library/board_store.js`、`board_claims.js`、`board_server.js`（后两个文件：前者本批未改动，后者由 captain 按 #3/#16 扩展授权） |
| 基线 | 子仓 `mindcraft` `3bcf8e8` · Node v24.16.0 · 未改数据库架构（ADR 阶段 1-3 不在本批） |
| 实际改动文件 | `mindcraft/src/agent/library/board_store.js`、`mindcraft/src/agent/library/board_server.js` |
| 迁移 | `PRAGMA user_version` 2 → 3（`claims.key` 唯一索引 + 重复预约去重；见 §1.2） |

---

## 0. 先确认报告是否属实（读实现，不看结论）

| 报告说法 | 实现原文（改前） | 属实？ |
|---|---|---|
| #4 `BEGIN IMMEDIATE` 失败被吞、仍返回 `ok:true` | `let inTx=false; try{db.exec('BEGIN IMMEDIATE');inTx=true;}catch{inTx=false;}` → 后接无锁读改写 → `return {ok:true,...}` | **属实**（注释「先拿写锁再读，保证中间不会被插进来」与实现相反） |
| #5 `reserve()` 四步无事务 | `expireClaims` → `SELECT` 冲突 → `INSERT ... ON CONFLICT(id,key)`，**中间没有 `BEGIN`** | **属实** |
| #5 `claims` 无 `UNIQUE(key)` | 主键 `(id,key)` + 非唯一 `idx_claims_key` | **属实**（同一 key 可以属于不同 id，数据库不拦） |
| #6 坏库自动重建会 rename/rm 正在写的库 | 改前已有 `isCorruptError` 分流（第3条修复），**重建本身仍是"改名 + 建空库"** | **部分属实**：判据已收窄（锁忙/权限/磁盘满已会 throw），但"证据"只有错误码一条，且 WAL 仍是 `catch{}` |
| #6 WAL 失败静默 | `try{db.exec('PRAGMA journal_mode = WAL');}catch{}` | **属实** |
| #3 身份全部取自 payload | `String(payload?.bot ?? '')` / `String(payload?.owner ?? '')`，服务端零校验 | **属实** |
| #16 `limit` 直通、`LIMIT -1` 无上限 | `params.push(Number.isFinite(filter.limit) ? filter.limit : 200)`；`Number.isFinite(-1) === true` | **属实** |
| #16 `board:add` 无限流 | 无任何桶/计数 | **属实** |

> 实跑反证（改前→改后，见 §1.3 / §2.3 / §3.3 的具体命令）：
> 改前 `LIMIT -1` 会把整张 `jobs` 表读出来；改后 `normalizeListLimit(-1) === 200`。

---

## 1. #4 / #5 / #6 —— 事务、唯一约束、重建证据与 WAL 可观测

### 1.1 改了什么

**(a) 一个事务原语：抢不到锁就是失败（#4 的核心）** — `board_store.js:1519-1576`

```js
function beginImmediate(db)            // db.isTransaction === true → 复用外层事务；否则 BEGIN IMMEDIATE
function runInImmediateTx(db, body)    // 抢锁失败/body 抛错/body 返回 ok:false/COMMIT 失败 → 一律如实返回
```

- `BEGIN IMMEDIATE`（而不是裸 `BEGIN`）：**开启时**就申请写锁 —— 裸 `BEGIN` 的"读"和"第一次写"
  之间别人可以插进来，那正是 check-then-write 的病根。
- 抢锁失败 → `{ok:false, code:'BOARD_BUSY'}`（`SQLITE_BUSY(5)`/`SQLITE_LOCKED(6)` 识别）；
  其它异常 → `INTERNAL`。**没有任何"降级继续"的分支**。
- 已经有外层事务（`db.isTransaction`）→ 复用外层（原子性本来就有），不重复 `BEGIN`。

**(b) `mergeSharedChest()` 不再吞锁失败（#4 的修复点）** — `board_store.js:2405`

整个"读 → 合并 → 写"进 `runInImmediateTx`，`putShared` 返回失败也回滚。返回值新增
`{ok:false, code:'BOARD_BUSY', message}`；`board_server` 的 `board:shared-merge` 把 `code` 一起回给调用方
（改前只回 `reason`，调用方根本看不出是"锁忙、可重试"）。

> 为什么不做"重试 + 退避"：`mergeSharedChest` 是**同步**函数，同步退避只能 `Atomics.wait`（阻塞事件循环），
> 比失败更糟。连接级 `busy_timeout = 5000` 已经在等 5 秒，所以这里的失败是"等了 5 秒仍抢不到"，
> 重试交给异步层（agent/客户端）做。

**(c) `reserve()` 读-判断-写进同一事务（#5）** — `board_store.js:1585`

`expireClaims` → `SELECT` 冲突 → 逐 key `INSERT` 全部进 `BEGIN IMMEDIATE`；
冲突/写失败 → 回滚（"全有或全无"语义保持不变）；`BOARD_BUSY` 与 `CLAIM_CONFLICT` 分开报。

**(d) `claims.key` 唯一约束 + 老库去重迁移（#5 的第二道闸）** — `board_store.js:145/217/242`

- `SCHEMA`：`CREATE UNIQUE INDEX IF NOT EXISTS uq_claims_key ON claims(key)`（旧的非唯一 `idx_claims_key` 已移除，不留两个索引两个真相）。
- 写入语句改为 `ON CONFLICT(key) DO UPDATE ... WHERE claims.owner IS NULL OR claims.owner = excluded.owner`：
  别人的行 → `WHERE` 不成立 → `changes = 0` → 返回 `CLAIM_CONFLICT`（**不抛异常**，上层按"换目标"处理）；
  同一 owner 换单持有同一 key → 行迁移到新单（幂等）。
- **迁移路径（已有库的风险点，按要求先确认再改）**：`BOARD_SCHEMA_VERSION 2 → 3`，
  `ensureClaimsUniqueKey()` 在 `db.exec(SCHEMA)` **之前**跑：
  1. 找出重复 key（`GROUP BY key HAVING COUNT(*) > 1`）；
  2. 每个重复 key **保留 `until` 最晚的一行**（无期限的 `NULL` 排最后，同 `until` 取最早写入的 rowid），删掉其余；
  3. `DROP INDEX IF EXISTS idx_claims_key` → `CREATE UNIQUE INDEX uq_claims_key`。
  不先做这一步，`SCHEMA` 里的唯一索引会让**老库直接打不开**（板起不来）。被删的重复行正是"同一资源上的第二个占用人"，
  一个资源本来就只该有一个占用人 —— 这不是丢数据，是修复结果；且迁移幂等（重复调用 `removed=0`）。

**(e) 重建前必须有"确实是坏库"的第二份证据（#6）** — `board_store.js:348`

`isCorruptError` 只说明"这次异常长得像坏库"。重建（改名/删 + 建空库）**之前**再关掉句柄、
另开一个**只读**连接跑 `PRAGMA quick_check(1)`：

| 复核结果 | 结论 |
|---|---|
| 打不开（NOTADB / 垃圾字节） | 第二份证据成立 → 走原有"改名留证 + 建空库" |
| 打得开但 `quick_check` 不是 `ok` | 真坏 → 重建 |
| **打得开且 `quick_check = ok`** | **判断站不住 → 抛错、库文件原样保留、绝不重建** |

新增 `corruptionEvidence` 字段进返回值（写进日志/排障线索），把"我为什么认为它坏了"变成可查的证据。

**(f) WAL / `busy_timeout` 执行后读回核对，失败必告警（#6）** — `board_store.js:308/369`

`applyTuningPragmas()` 不用 `exec` 而是 `prepare('PRAGMA journal_mode = WAL').get()` **读回实际模式**；
不是 `wal`（或执行失败）→ 进 `warnings`；`busy_timeout` 同样读回核对。
`openBoard()` 的返回值新增 `warnings: string[]`，并 `console.warn('[board] …')` 打一条
（`opts.quiet` 供离线工具关掉噪音）。**"现在是 rollback journal 模式"不再是不可观测的状态差异。**

### 1.2 明确没做的事（避免下一个人误解）

- **没有**引入"唯一写者令牌/锁文件"。报告说"多写者前先有唯一写者机制"是**架构**措施（属 ADR 阶段 1-3），
  本条只让**多写者下的失败可见**（`BOARD_BUSY` + 唯一索引 + 重建证据）。改完之后的保证是
  "并发不会静默丢/双占"，不是"支持多写者"。
- **没有**改 `board.sqlite` 的表语义：只加了一条唯一索引（+ 一次去重迁移）。
- **没有**删 `-wal`/`-shm` 之外的行为改动；重建仍是"改名留证 + 建空库"（用户决策②）。

### 1.3 验证

```bash
cd mindcraft
node tools/board_store_unit.mjs          # 25/25
node tools/board_open_migrate_unit.mjs   # 8/8   （含 ⑤ 另一连接持 EXCLUSIVE → 原样 throw，文件字节不变、无 .corrupt-）
node tools/shared_chest_merge_unit.mjs   # 11/11
node tools/board_b3_unit.mjs             # 23/23 （预约冲突/TTL/release/单 bot 恒成功）
node tools/board_coord_unit.mjs          # 17/17
node tools/board_iface_unit.mjs          # 16/16
node tmp/verify_board_tx.mjs             # 6/6   （见下，临时反证脚本，不入库）
```

`tmp/verify_board_tx.mjs`（本次专为"改后行为"写的反证，**tmp/ 已 gitignore，不提交**）：

| 用例 | 结果 |
|---|---|
| ① 另一连接持 `EXCLUSIVE` → `mergeSharedChest` | **`ok:false / BOARD_BUSY`，且库里没有半份数据**（改前是 `ok:true`） |
| ② 两个连接（两个写者）抢同一 `item:` key | 一方 `CLAIM_CONFLICT`，`claims` 里**只有 1 行** |
| ③ 绕过 `reserve` 直接插重复 key | `UNIQUE constraint failed: claims.key` |
| ④ 老库（v2、含重复 key）| 去重（保留到期最晚的 `jobB`）+ 唯一索引 + `user_version=3` + `removed=1` |
| ⑤ `journal_mode` 读回 | `wal`，且 `warnings=[]`（有值即会打印） |
| ⑥ 去重迁移幂等 | 重复调用 `removed=0` |

---

## 2. #3 —— 从"payload 自述"到"服务端裁决 + 归属校验"

### 2.1 诚实的分层（**哪层能做什么，写清**）

| 层 | 判据 | 强度 | 归属任务 |
|---|---|---|---|
| 传输层 | 面板凭据（`?token=` → cookie）/ agent 凭据（`process.env.MINDSERVER_TOKEN` 只继承给子进程） | 服务端判定 | **t1（fix-control，已落地）** |
| 连接身份 | `socket.data.role`（`'agent'`/`'panel'`）+ `socket.data.agentName`（`bindAgentChannel()` 经 `claimAgentChannel` 唯一占用裁决后写入） | 服务端判定 | t1 提供，本文件使用 |
| 动作身份 | `board:hello` 里把"服务端裁决名"与自述名**对账**并绑定；此后所有写事件只认绑定值 | 本文件 | **t2（本条）** |
| 动作归属 | 改一张**正被租用**的单必须就是租约持有者；删共享数据必须是自己记的 | 本文件 | **t2（本条）** |

### 2.2 改了什么 — `board_server.js:143-280`

**(a) 错误码口径先写死**（`board_server.js:143`）：本文件只产出**已注册**的码，
身份/归属类 → `NO_PERMISSION`，速率/上限/参数类 → `TOO_MUCH`，细节全在 `reason`。
（原因：`contract.js` 的 `CODES` 是全仓唯一码表，未注册码会让 `fail()` 抛异常、也会被启动自检判红；
要更细的码必须同时改 `contract.js` + `board_client.contractCodeOf` + 错误码审计，属别的任务。）

**(b) `board:hello` = 绑定身份（agent 连接）** — `board_server.js:166/346`

- `role === 'agent'` 时：`socket.data.agentName` 为空 → 拒（`先 login-agent 再来 board:hello`）；
  与 `payload.bot` 不一致 → 拒（**这一步就是"一个 agent 进程冒充另一只 bot"**）；一致 → 绑定，
  且**绑定后不可换人**（再 hello 成别人 → 拒）。
- 面板/未知角色：一条连接可以替多只 bot 声明（控制层要替任意 bot 建单），但**只能用声明过的名字**行动。

**(c) 所有写事件的身份来源改为绑定值** — `board_server.js:219` `actingBot()`

`claim` / `heartbeat` / `checkpoint` / `save-checkpoint` / `finish` / `set-state` / `reserve` / `release` /
`update` / `shared-put` / `shared-merge` / `shared-del` / `add` 全部改过：
- 不再 `String(payload.bot ?? '')` 直接用；`reserve/release` 的 `owner`、`finish` 的 `bot`、
  `shared-put/merge` 的 `owner` 一律取绑定值（**payload 里的身份字段被忽略**）。
- agent 连接只有一只 bot 时可以不写名字（自动取绑定值），但必须已 hello。

**(d) 归属校验（不依赖传输层身份的那一层）** — `board_server.js:263` `assertJobOwner()`

判据：这张单**正被一条未过期的租约持有**且持有者不是自己 → `LEASE_LOST`；
无租约 / 就是自己 / 租约已过期（残局清理）→ 放行。挂到 `set-state`（取消/暂停）、`update`、
`checkpoint`、`save-checkpoint`、`reserve` 上。
这一层即使身份被冒充也仍然有效 —— 冒充者还是得先拿到租约。

**(e) 共享数据的"谁记的"** — `board_server.js` `board:shared-put/-merge/-del`

`put/merge` 的 `owner` 强制取绑定值（改前 `payload.owner` 直通 ⇒ 谁都能把一条共享数据记成别人的名字）；
`del` 对 agent 连接要求 `shared.owner === 自己`，否则 `NO_PERMISSION`（面板/控制层不受限）。

### 2.3 残留缺口（**必须让下一个人看到**）

1. **`board:hello` 仍是"持有 agent 凭据的进程"粒度，不是 per-agent 凭据。**
   一个持 agent 凭据的进程仍可以 `login-agent` 去抢别人的名字 —— 它会被 `claimAgentChannel` 的
   唯一占用裁决 + 接管限速 + 日志记下，并**顶掉对方通道**（可观测的越权），但不是静默冒充。
   真正封闭要做 per-agent 凭据（`(name × 进程)` 一对一），属后续任务。
2. **面板/未知角色保持旧行为放行**（`!cancelJob` 这类控制层命令不带 bot，收紧会把控制层打死）。
   这条依赖 t1 的握手门；`role` 未接线时（离线夹具/老部署）本文件事实上不设防 —— 这是**故意的**，
   避免"没接上握手门就全红"，但也就意味着**不能**把本条当成"任务板已鉴权"的依据。
3. **读路径（`list`/`get`/`claims`/`shared-list`/`shared-get`/`shared-find-item`）不做身份限制**：
   `scope='all'` 仍对 agent 开放（调度器/诊断要用）。数据是"看得到但不能改"，若后续要求"agent 只能看自己的"，
   那是另一条判据（要区分"面板视角"与"agent 视角"），本条未做。
4. `board:hello` 的绑定状态存在 `socket.data`（内存），**进程重启即失效**，重连必须重新 hello（这是期望行为）。

### 2.4 验证

`tmp/verify_board_auth.mjs`（临时反证，不入库）—— 每个 socket 独立 handler，`role` 按 t1 的约定注入：

| 用例 | 结果 |
|---|---|
| ① agent 连接 hello 成 alpha 后再 hello 成 beta | `NO_PERMISSION`（不能换人） |
| ② agent 连接没 hello 就 `reserve`（自称 alpha） | `NO_PERMISSION` |
| ③ alpha 的连接用 `owner=beta` 占资源 | `NO_PERMISSION`（冒充被拒） |
| ④ alpha 领到单后，beta 连接 `set-state=cancelled` | `LEASE_LOST`，**状态仍是 claimed** |
| ⑤ alpha 记的地标，beta 删 | `NO_PERMISSION`（`NOT_OWNER` 语义）；面板可删（`deleted=1`） |
| ⑩ 连接裁决名 alpha，hello 报 beta | `NO_PERMISSION`；报 alpha 放行 |

既有回归：`board_b3_unit 23/23`、`board_b4_unit 11/11`、`board003 30/30`、`board002 17/17`、
`board_cmd_unit 11/11`（`!cancelJob` 控制层路径未被收紧）、`board_scheduler_unit 40/40`。

---

## 3. #16 —— 窗口上限、参数校验与限流

### 3.1 改了什么

**store 层（真正的病根）** — `board_store.js:738`

```js
export const LIST_LIMIT_DEFAULT = 200;
export const LIST_LIMIT_MAX = 500;
export function normalizeListLimit(raw) { /* 非有限/非整数/<1 → 200；>500 → 500 */ }
```

`listJobs` 不再 `Number.isFinite(limit) ? limit : 200`，改走 `normalizeListLimit`：
**`-1` 再也不可能变成 `LIMIT -1`（SQLite 里 = 无上限）**。`countOpenJobs()` 同时新增（未终结单计数）。

**socket 层** — `board_server.js:327-341/417`

- `board:list` 的 `limit`：必须是 `1..500` 的整数，否则 `TOO_MUCH`（**不静默夹**：非法参数要报出来，
  不然调用方永远不知道自己发的 `-1` 被当成了 200）。
- `board:add` 令牌桶：`30 张 / 60 秒`，**按真实来源分桶** —— agent 连接 → `bot:<名字>`，
  其余 → 握手地址（`handshake.address`）→ 最后才 `socket.id`。桶表上限 512，满了先清回满的桶。
- `board:add` 未终结单上限 `MAX_OPEN_JOBS = 500`（"只加不结"会把调度器 `LIMIT 200` 的视野和历史表一起淹掉）。

### 3.2 验证

| 用例 | 结果 |
|---|---|
| `list {limit:-1}` / `{limit:501}` / `{limit:'abc'}` | 全部 `TOO_MUCH`（改前 `-1` 直通 = 全表） |
| `list {limit:10}` | 正常，`jobs.length <= 10` |
| `normalizeListLimit(-1/0/NaN/501/7/'9')` | `200/200/200/500/7/9` |
| 同一 agent 连发 40 张 `board:add` | `ok=30`、`TOO_MUCH=10` |
| 另一只 bot 紧接着下 1 张 | 成功（**不是全机共用一个桶**） |

---

## 4. 全量门禁

```bash
cd mindcraft && npm run gate
```

改后结果：**退出码 0** ——
`✓ 错误码审计通过（扫到 35 个码，均已注册；CODES 共 41 个）`、
`✓ 启动自检通过（含函数体冒烟测试）`、
`✓ [lint:hard] no-undef = 0 · no-floating-promise = 0（扫 179 个文件）`，
其余 4 个门（patch_integrity / secret 文件名 / settings 键 / preflight_regex）一并绿。

> 注：本次**未**跑全量 `npm test`（按任务纪律由 gate-runner 跑）。除上表定点单测外，
> 追加跑了全部 `tools/board*unit.mjs`（24 个脚本，全绿）。

## 5. 残留缺口汇总（按重要性）

1. **多写者仍不是被支持的形态**：本条只保证"并发时失败可见、不静默丢/双占"。
   唯一写者机制（锁文件/写者令牌）属 ADR 阶段 1-3。
2. **#3 的"真身份"依赖 t1 的 `socket.data.agentName`**；per-agent 凭据未做（见 §2.3-1）。
3. **重建仍会换库文件**（用户决策②：板是可重建的调度状态）。第二份证据把"误判"堵死了，
   但真坏库重建时，另一个持旧句柄的写者仍会写进孤儿文件 —— 那需要唯一写者机制才能根治。
4. **新增的 `warnings` 只是告警**（`console.warn` + 返回值字段），没有接入面板/诊断视图；
   要让"WAL 没生效"在面板上可见，属 `web/` 与诊断侧的接线。
5. `board:add` 的限流是**进程内**内存桶：多进程部署时每个进程各算各的（mindserver 是唯一写者，
   当前拓扑下等价于全局；若将来拆进程需换共享计数）。
