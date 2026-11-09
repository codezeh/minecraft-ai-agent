# R6 · 控制面审计：mindserver / 任务板 / 共享状态并发

| 项 | 值 |
|---|---|
| 审计员 | scan-control |
| 审计时间 | 2026-11-09 22:3x–23:0x（Asia/Shanghai） |
| 基线 | 父仓 `d818b02` · 子仓 `mindcraft` `82da3f3` · Node **v24.16.0** |
| 范围 | `mindcraft/src/mindcraft/`（mindserver / auth_gate / identity_store / config_center / unlock_limiter / local_only / offline_identity_risk / proc_control / mcserver / mindcraft.js）+ `src/agent/library/board_store.js`、`board_server.js`、`board_claims.js`、`bot_paths.js`（`board_client.js` 仅作调用方取证） |
| 方法 | 逐行静态通读 + 跨文件调用链交叉核对 + 与 `docs/audit-r5` 已记条目对账。**未启动服务、未运行攻击脚本、未修改任何产品代码**（唯一产出是本文件） |
| 性质 | 只读审计。下文所有"修法方向"是建议，不是已实施 |

> 证据口径：所有行号以基线提交为准；引用格式 `文件:行`。凡我**没有**亲手验证的，会在第 6 节明确标出，不混进结论。

---

## 0. 结论摘要（先看这 8 条）

1. **任务书里的前提有一处需要纠正**：任务板**不是**"每 bot 一份 sqlite"。全系统只有**一份**库 `mindcraft/bots/_board/board.sqlite`，唯一写者是 mindserver 进程；`botsRootOf()` 只提供**根目录**，`boardDirOf()` 再拼 `_board`。所以"队伍共享板"在**存储层已经共享了**，不需要迁移库文件；真正的新问题是"要不要让第二个进程写"。
2. **"只有 mindserver 写库"是拓扑约束，不是强制约束**：没有任何锁、`PRAGMA query_only`、写者令牌或文件锁。board_store 里没有任何一行代码能阻止第二个进程 `new DatabaseSync(同一个 path)` 并开始写。它今天成立，只因为 `openBoard()` 在全仓**只有 mindserver 一处调用**（`mindserver.js:965`）。
3. **今天很多"原子"是靠 Node 单线程 + `DatabaseSync` 同步执行白送的，不是靠 SQL**。`reserve()` 是典型：`expireClaims` → `SELECT` 冲突 → `INSERT`，三步之间**没有事务**（`board_store.js:1285-1327`）。单进程下不会被打断，**第二个写者一进来立刻就能双占**。
4. **`mergeSharedChest()` 有一处致命的静默降级**：`BEGIN IMMEDIATE` 失败被 `catch {}` 吞掉，然后**照常**做读-改-写（`board_store.js:2085-2086`），最后返回 `ok:true`。它存在的唯一理由就是防丢更新（T31 第16条），而在最需要它的场景（写锁被抢）它恰好退化成**不设防**，且**不报错**。
5. **任务板 socket 层零鉴权**：`board_server.js` 全文没有任何 token / 身份 / bot 绑定校验。任何过了握手门的连接（面板、任何一个 agent 子进程）都能**冒充任意 bot 名**领单、收尾、改状态、删共享数据、伪造能力。所谓"服务端不信任 agent 传来的 roles"是**形式上的**——roles 本身就是 agent 在 `board:hello` 里自报的。
6. **控制面存在"高危动作无门"**：`shutdown`、`stop-all-agents`、`server-stop`、`server-start`、`create-agent`、`stop-agent` 都不检查"是不是面板连接"，也（除 create-agent 外）**完全没有速率限制**。`shutdown` 一行代码就能把整套控制面停掉（`mindserver.js:1654-1659`）。
7. **agent / panel 的身份区分是语义性的，不是鉴权**：`isPanelConnection()` 的判据是"**没有**发 `auth.token`"（`mindserver.js:1241`）。任何人只要**换一种方式携带 token**（query / header / cookie）就自动变成"面板"；反过来，面板只要发 `auth:{token}` 就变成"agent 身份"。同一个 bearer token 无法区分两类主体。
8. **架构缺口**：`shared` 表主键是 `(kind, key)`、`claims` 是 `(id, key)`，**没有队伍/命名空间维度**。两个队伍都写 `chest:10,64,20` 或 `landmark:home` 就会**互相覆盖/互相冲突**。队伍板需要的是"加一个 scope 列 + 一个原子取料 RPC"，而不是"换个库"。

---

## 1. 现状核对：任务板到底是不是"每 bot 一份"？

**不是。结论与任务书前提相反，且这是好事。**

| 事实 | 证据 |
|---|---|
| 板库路径 = `<bots根>/_board/board.sqlite`，与 bot 名无关 | `bot_paths.js:102-104`；`board_store.js:260-262` |
| 全仓**只有一处**打开板库：mindserver 启动时 | `mindserver.js:965`（`openBoard()` 不传参 → 走 `boardDirOf()`） |
| agent 子进程**不打开** sqlite，只走 socket | `grep -rn "DatabaseSync\|openBoard"` 仅命中 `board_store.js` / `secrets_vault.js` / `terrain3d.js`；`board_client.js:1-60` 明确是 "薄封装：把 `board:*` socket 事件包成方法" |
| "每 bot 一份"的只有：记忆、历史、地形库、身份表 | `bot_paths.js:79-91`；`terrain3d.js:96`；`identity_store.js:173-180` |
| `jobs` 表用 `assignee` + `kind` 做**逻辑**分区，不是物理分区 | `board_store.js:111-128`（schema）、`:663-669`（候选查询） |

`kind` 目前的取值只有 `'personal'`（默认）与 `'shared'`（拆单子单 / 可被任何人领），**没有 team 概念**：

```
grep -rn "team\|队伍\|组队" board_*.js mindserver.js  →  0 命中
```

**所以"共享板"这件事今天已经成立**——用户要的"进入组队任务板时共享队内材料清单"，在存储层不是重构，而是**加维度**（见第 5 节）。

---

## 2. 直答任务书的三个新问题

### Q1 · 现状确实是每 bot 一个 sqlite 吗？多进程写同一份共享库，node:sqlite 的打开方式够不够？现在有没有设？

**现状**：不是每 bot 一份。是**全局一份**，单进程写（见第 1 节）。

**现在已经设了什么**（`board_store.js:267-279`）：

```js
const db = new DatabaseSync(path);
try { db.exec('PRAGMA journal_mode = WAL'); } catch { /* 忽略 */ }
try { db.exec('PRAGMA busy_timeout = 5000'); } catch { /* 忽略 */ }
const migration = migrateBoardSchema(db);   // 先补列
db.exec(SCHEMA);                            // 再建表/建索引
```

**够不够？不够。** 逐项：

| 需要的能力 | 现状 | 缺口 |
|---|---|---|
| WAL（读写不互斥） | 设了，但**失败被静默 catch** | 若某构建/文件系统不支持，没人知道现在是 rollback journal 模式；此时"读阻塞写"的行为变了，`busy_timeout` 的语义也跟着变 → **不可观测的状态差异** |
| `busy_timeout` | 设了 5000ms | 5 秒是阈值不是保证。board 的 5s 扫描定时器（`board_server.js:453`）会周期性跑一串写语句；另一个进程的 `BEGIN IMMEDIATE` 撞上就可能等满 5s 后抛 `SQLITE_BUSY`。**代码里没有任何重试**（只有 `mergeSharedChest` 有 try，而它选择了错误的"降级"） |
| 事务（读-改-写原子） | **只有 `mergeSharedChest` 用了 `BEGIN IMMEDIATE`** | `reserve()` / `finish()` / `setState()` / `updateJob()` / `heartbeat()` 全是"先读快照 → 再条件 UPDATE"，靠"单线程 + 同步 API 不被打断"自洽 |
| 唯一约束兜底 | `claims` 主键 `(id, key)` | **没有 `UNIQUE(key)`**。即使事务补上，`(id,key)` 也允许两个不同 job 同时持有同一个 key —— 唯一性只能靠应用层检查 |
| 迁移期互斥 | `migrateBoardSchema` + `SCHEMA` 裸跑 | 两个进程同时启动会并发执行 `ALTER TABLE` / `CREATE INDEX` → 一个拿到 `SQLITE_BUSY` 或"duplicate column"，没有 `BEGIN EXCLUSIVE` 保护 |
| 坏库重建的安全前提 | 检测到 11/26 → `close` → `rename`/`rm` → 建空库（`board_store.js:295-329`） | **多写者下这是数据毁灭路径**：A 进程把 B 正在写的 `board.sqlite` 改名走，B 继续往已被 rename 的 inode 写 → 双库、丢单、且两边都自认为成功 |
| 写者身份 | 无 | 没有 `query_only`、没有写者令牌、没有 lock 文件 |

**一句话**：WAL + busy_timeout 是"能跑"的下限，**不是"多写者正确"的充分条件**。当前代码正确性依赖一条**没有写进任何地方的不变量**：*"只有一个进程，且它的每次调用都是同步执行到底"*。

---

### Q2 · "只有 mindserver 写库"这个前提靠什么维持？如果 agent 子进程也要写，哪些点会碎？

**靠什么维持：只靠注释 + 目录事实（拓扑）。**

- `board_store.js:2-8` 的注释："**mindserver 侧、唯一写库的地方**……放 mindserver 就只有**一个进程写库**，省掉多进程锁（06 §3、§9.3）"；
- `board_server.js:389` 注释："只有 mindserver 写库（与任务单同一原则）"；
- `mindserver.js:31-32` 注释重复同一句；
- **代码层面零强制**：没有任何进程级守卫、没有 `PRAGMA query_only`、没有 flock、没有"写者 ID"校验。

**如果让 agent 子进程直接写库，会碎的 10 个点**（按危险度排序，全部有代码位置）：

| # | 会碎的点 | 位置 | 具体怎么碎 |
|---|---|---|---|
| 1 | `reserve()` 的 check-then-write | `board_store.js:1293-1326` | `SELECT` 与 `INSERT` 之间没有事务：两进程同时领同一材料 → 都查不到冲突 → 都插入成功（`(id,key)` 主键不冲突） → **双占**，正是要防的事 |
| 2 | `mergeSharedChest()` 吞掉 `BEGIN` 失败 | `board_store.js:2085-2086` | 抢不到写锁时**不重试、不报错**，直接无锁做读-改-写，还 `return {ok:true}` → 丢件且无人知 |
| 3 | `openBoard` 坏库重建 | `board_store.js:295-329` | 见 Q1 表末行：能把别人正在用的库改名走 |
| 4 | `finish()` 的 attempts 是陈旧快照算的 | `board_store.js:961` + `:1032-1040` | `attempts = job.attempts + 1` 用的是读快照；两个进程同时收尾 → 都写同一个 `attempts`，**丢一次计数**，或双双转移状态 |
| 5 | `finish/setState/updateJob` 的 UPDATE **没有 state 条件** | `board_store.js:1032-1040`、`:1157-1158`、`:1240` | 状态转移合法性在 JS 里用旧快照判；写时只带 `id`（+ 租约/attemptSeq）。中间被别人改成终态，仍能写进去 |
| 6 | `heartbeat()` 的租约归属只在 JS 判 | `board_store.js:719-730` | SQL 里只有 `WHERE id=?` + attempt 守卫，**没有 `lease_owner=?`**。跨进程时"我判完 → 别人接管 → 我写"可以发生（同名单靠 attemptSeq 挡，但老客户端/离线工具不传 attemptSeq 就不设防——`attemptGuardSql` 对空值 fail-open，`:619-627`） |
| 7 | `setState()` 的 `clearLease` | `board_store.js:1148-1158` | 旧进程把别人**刚领到**的单置 `paused/ready` → 直接清掉新租约 + 新 assignee |
| 8 | 5s 扫描定时器假定"只有一个扫描者" | `board_server.js:453-493` | 两进程各跑一份：`expireLeases/expireClaims/convergeOrphanParents/reopenOrphanBlocked/sweepDeadDepJobs/blockOrphanParents` 各扫一遍 → 重复状态转移、重复广播；`expireClaims` 是**全局 DELETE**（`:1392-1397`），并发时一边刚续期一边被扫 |
| 9 | `botRegistry` 是进程内存 | `board_server.js:41`、`:118-124` | 资格（roles/物品）与"这只 bot 会上报过的技能"是**每进程一份**；两个写者 = 两套能力表，`board:claim` 的 `requires` 过滤结果取决于连到哪个进程 |
| 10 | `board:changed` 是进程内广播 | `board_server.js:101`、`:112-114` | 多进程时事件不会跨进程传播，客户端缓存（`board_client.js` 的本地镜像）会长期不一致 |

**建议**：队伍板**继续只让 mindserver 写**。想给 agent 更强的实时性，应该加**新的 socket RPC**（如 `board:material-take`），而不是让子进程开库。若将来确实要多写者，上面 10 条必须**全部**处理，并额外加：`UNIQUE(key)`、`BEGIN IMMEDIATE` + 重试、迁移期 `BEGIN EXCLUSIVE`、坏库重建前的"唯一写者"门、`busy_timeout` 提高并显式失败上报。

---

### Q3 · 共享材料清单的并发语义：两个分身同时领同一种材料，现在有没有防超领的机制？

**有"半个"机制，且在跨进程时不成立。**

现有机制（都只在**单写者**下有效）：

1. **任务单领取是真原子的**：`UPDATE jobs ... WHERE id=? AND state='ready'` + `changes===1`（`board_store.js:695-698`）。这条**跨进程也成立**——SQLite 会序列化写者。这是全文件里唯一可以放心搬去多写者的写法。
2. **材料用 `item:` 预约键**：`item:<name>[:n]`，`claimsConflict` 对 item×item **只比名字**（`board_claims.js:122-123`）。
3. **箱子清单有原子合并**：`mergeSharedChest`（`board_store.js:2076-2110`）——设计正确，实现有雷（见 Q2 #2）。

三个结构性缺口：

- **缺口 A（超领）**：`reserve()` 不是事务（Q2 #1）。单进程下靠"同步执行不被打断"侥幸正确；一旦有第二个写者，两个分身**都**会拿到"无冲突"然后**都**插入成功。
- **缺口 B（额度语义不存在）**：注释说 `item:<name>[:n]` 是"某种物品**额度**"，但 `claimsConflict` 对 item×item **完全忽略 `n`**（`board_claims.js:123`）。所以 `item:oak_log:5` 与 `item:oak_log:1` 视为**完全冲突**——这是"互斥锁"而不是"额度"。结果：要么整类材料被一个 bot 独占，要么（多个 key 都带不同 n 时）无意义地互相挡。**没有任何"剩余 N 个、我领 3 个后还剩 2 个"的记账。**
- **缺口 C（清单与预占不联动）**：`shared`(chest.items) 与 `claims`(item:) 是两套独立机制，**没有跨表事务**。`board:shared-merge`（扣减箱子）不检查/不消耗 `item:` 预约；`board:reserve`（占材料）也不扣减箱子。于是"我占了 5 个原木"与"箱子清单里那 5 个原木还在"可以同时成立 → 两个分身各自认为材料归自己。**这才是"两个分身同时领同一种材料"真正的超领路径**，而且它**今天在单进程下就能发生**（只是不会在同一次 tick 里发生）。

**结论**：单进程 + 单线程下，"任务单"不会双领；"材料"会（缺口 C），"预约"在跨进程后会双占（缺口 A）。要真正防超领，需要一个**单条语句/单事务**的 `claimMaterial(team, item, n)`：在一个 `BEGIN IMMEDIATE` 里"查剩余额度 → 扣减清单 → 写预占"，并让清单与预占共用一张表（或同一个事务边界）。

---

## 3. 缺陷清单（按严重度）

> 编号规则 `R6-CTRL-nn`。每条给：位置 / 证据 / 后果 / 触发 / 修法方向。**P0 = 直接失去控制面或数据完整性；P1 = 特定条件下必然错；P2 = 有边界但真实；P3 = 卫生问题。**

### P0

#### R6-CTRL-01 破坏性控制面事件没有"面板门"，且多数没有速率限制；agent/panel 身份不可区分

**位置**：`mindserver.js:1353-1372`（server-status/start/stop/log）、`:1603-1606`（stop-agent）、`:1647-1659`（stop-all-agents / shutdown）、`:1374`（create-agent）、`:1475`（get-settings）、`:1562`（chat-message）、`:1575`（set-agent-settings）。

**证据**：

- `isPanelConnection` 只被 3 个 `identity-*` 事件使用（`grep -n isPanelConnection` → `:1241/:1254/:1303/:1329`）。
- `takeToken` 只覆盖 9 个事件（`create-agent` / `restart-agent` / `start-agent` / `destroy-agent` / `send-message` / `listen-to-agents` / 3 个 `identity-*`）。`shutdown`、`stop-all-agents`、`stop-agent`、`server-start`、`server-stop`、`server-log`、`get-settings`、`chat-message`、`set-agent-settings` 全部**无限流**。
- `shutdown` 的实现就是一行 `shutdownOnce('socket')`（`:1654-1659`）→ `mindcraft.shutdownAndWait` → `process.exit(0)`。

**后果**：任何持 token 的连接（包括**每个 agent 子进程**）都能：关停整套控制面、批量杀 bot、发 RCON stop 关服、起新 bot 进程、把任意 bot 的通道踢掉。`stop-all-agents` + `start-agent` 还能被组合成"反复杀/拉"（start-agent 有限流 6/min，stop-all-agents 无）。

**为什么这条是 P0 而不是"token 即全权"**：代码自己在 `:1231-1241` 明确写了"agent 子进程不该能签发身份码"，说明作者**认为** agent 子进程是比面板低一级的主体。但同一份代码里，这个低一级的主体能**关掉整台机器上的控制面**。两者必居其一：要么统一承认"token = 全权"（那 identity 的三重门是装饰），要么给高危事件补门。现在是不一致，且不一致的方向是危险的那一侧。

**修法方向**：给一组"危险事件"统一加 `requirePanel(socket)`（`shutdown`/`stop-all-agents`/`server-*`/`create-agent`/`destroy-agent`/`set-agent-settings`/`stop-agent`），并对全部事件补 `takeToken`（`shutdown` 至少 1/60s）。若要真正区分 agent 与面板，需要**第二种凭据**（agent 专用 token / mTLS / 进程级 secret），单靠"token 放在哪个字段"不行。

---

#### R6-CTRL-02 任务板 socket 层零鉴权：任何连接可冒充任意 bot

**位置**：`board_server.js:116`（`io.on('connection')` 内注册全部 `board:*`）、`:118-124`（hello）、`:216-236`（claim）、`:274-314`（finish）、`:317-330`（set-state）、`:391-437`（shared-*）、`:440-449`（update）。

**证据**：

```
grep -n "token\|identity\|isAgent\|auth" board_server.js  →  0 命中
```

- `board:claim` 的身份是 `payload.bot`（`:218`），**服务端从不校验"这条连接是不是那个 bot"**；
- `board:finish` 的身份是 `payload.bot`（`:280`），同上；
- `board:add` 的 `assignee` 来自 `payload`（`:137`），可以指派给任何人；
- `board:shared-del` 无 owner 校验（`:428-431`）；
- `board:shared-put` 无 owner 校验（`:391-398`）；
- `board:set-state` / `board:update` 无"这张单是不是我的"校验。

**后果**：一个被提示注入的 bot（不需要代码执行权限）就能：取消/暂停别人的单、把别人的单收尾成 `done`、删掉全队共享的箱子清单、把任意单指派给任意 bot、用 `board:hello` 覆盖别人的能力表。**多 bot 协作的核心信任假设（"每个 agent 只动自己的单"）在服务端不存在。**

**修法方向**：socket 连接在 `board:hello` 时绑定 `{bot}` 到 `socket.data`，之后所有 `board:*` 的身份**只取这个绑定值**，忽略 payload 里的 `bot/owner`；`board:add`/`set-state`/`update`/`shared-*` 加"只有 assignee 或单的 lease owner 可改"的归属校验。

---

### P1

#### R6-CTRL-03 `board:add` 只校验 skill/priority，`state/parentId/assignee/maxAttempts` 全放行

**位置**：`board_server.js:127-151` → `board_store.js:430-479`。

**证据**：`validateIncomingJob` 只做三件事——skill 在注册表、args 过 manifest、priority 0-9（`board_server.js:56-80`）。`insertJobRow` 直接落 `state`（只要在 `ALL_STATES` 里）、`parentId`、`assignee`、`maxAttempts`、`notBefore`（`board_store.js:447-477`）。

**后果**（都能被任何连接做到）：
- `state:'done'` → **伪造历史**，面板统计/父单 rollup 都被污染；
- `state:'running'` + `assignee:'受害者'` → 占位/干扰对方调度；
- `parentId` 指向任意父单 → `rollupParent` 用伪造的子单判定父单完成（`:1869` 起的收敛逻辑）→ **父单被"做完了"**；
- `maxAttempts: 999` → 绕过失败上限，让一张不可能完成的单永久重试、持续占资源。

**修法方向**：`board:add` 强制 `state ∈ {pending, ready}`（或直接忽略客户端传的 state）、`parentId` 必须指向调用者刚创建的单、`maxAttempts` 夹在 1..10、`assignee` 必须是已 `hello` 的 bot。

---

#### R6-CTRL-04 `reserve()` 是 check-then-write，无事务、无 `UNIQUE(key)`

**位置**：`board_store.js:1285-1327`；表定义 `:137-141`。

**证据**：

```js
expireClaims(db, now);                                      // ① 写
const live = db.prepare('SELECT ... WHERE until > ? AND (owner IS NULL OR owner <> ?)').all(...);  // ② 读
for (...) { ... }                                           // ③ 判冲突
for (const k of norm.keys) stmt.run(jobId, k, owner, until); // ④ 写
```

四步之间**没有 `BEGIN`**；`claims` 主键 `(id, key)` 允许同一 key 属于不同 id。

**后果**：单进程下靠 Node 单线程"中间不让出"侥幸正确（这正是它现在测试全绿的原因）。一旦有第二个写者（队伍板让 agent 写、或运维手工开一个 sqlite 客户端），两个分身同时 `reserve('item:oak_log:5')` → 都通过 ②③ → 都插入 → **双占**，且两边都收到 `ok:true`。

**修法方向**：`BEGIN IMMEDIATE` 包住 ①②③④ 并加重试；表加 `UNIQUE(key)`（或用 `key` 做唯一索引 + `INSERT ... ON CONFLICT DO NOTHING` 看 `changes`）；失败返回 `CLAIM_CONFLICT` 而不是抛。

---

#### R6-CTRL-05 `mergeSharedChest()` 把 `BEGIN IMMEDIATE` 失败吞掉，退化成非原子读-改-写并返回成功

**位置**：`board_store.js:2084-2109`。

**证据**：

```js
let inTx = false;
try { db.exec('BEGIN IMMEDIATE'); inTx = true; } catch { inTx = false; }   // ← 吞掉
try {
    const prev = getShared(...);          // 读
    ... 合并 ...
    putShared(...);                       // 写
    if (inTx) db.exec('COMMIT');          // inTx=false 时什么都不做
    return { ok: true, key: k, value };   // ← 仍然报成功
} catch (e) { if (inTx) ROLLBACK; return { ok:false, ... }; }
```

**后果**：`BEGIN IMMEDIATE` 失败恰好意味着"另一个写者正在写"——也就是**最需要原子性的时刻**。此时函数静默地做无锁读-改-写，正是 T31 第16条要消灭的"后写覆盖先写"，而且返回 `ok:true`，上层（`board_server.js:405-416`）会把 `{ok:true}` 转给 agent → **丢件且无人知**。这条注释写着"`BEGIN IMMEDIATE` 先拿写锁再读，保证中间不会被插进来"，与实现相反。

**修法方向**：`BEGIN IMMEDIATE` 失败必须**重试（有限次 + 退避）或返回失败**，绝不允许降级继续。宁可让 agent 重试，也不能声称成功。

---

#### R6-CTRL-06 "坏库自动重建"在多写者下是数据毁灭路径；WAL 设置失败被静默忽略

**位置**：`board_store.js:283-330`（重建）、`:271`（WAL catch）。

**证据**：坏库判据已收窄到 errcode 11/26（`:226-248`，这一处**修得对**）。但重建动作用的是 `close` → `renameSync/rmSync`（`:305-321`），**没有任何"确认没有别的进程在用"的检查**。

**后果**：A 进程判定损坏（或真的损坏）→ 把 `board.sqlite` 改名 → B 进程句柄仍指向被改名的 inode，继续写 → ① B 的写入永久落到"孤儿文件"里，重启后消失；② A 建的空库与 B 的库**双真相**；③ `-wal`/`-shm` 被 A 删掉时，B 的 WAL 内容直接丢。这不是"理论风险"：只要队伍板让第二个进程开库，就具备全部前提。

**修法方向**：多写者前必须先有"唯一写者"机制（lock 文件 / 写者令牌）；重建改为"标记 + 由唯一写者执行"，或干脆改为**只报错不重建**（让运维决定）。

---

#### R6-CTRL-07 `board:list` 的 `limit` 直通（`-1` = 无限制）+ `board:add` 无限流 + `jobs` 永不删除 = 内存/磁盘 DoS

**位置**：`board_server.js:187-193`（`limit: f.limit` 直传）、`board_store.js:519`（`Number.isFinite(filter.limit) ? filter.limit : 200`）。

**证据**：`Number.isFinite(-1) === true` → SQL `LIMIT -1` 在 SQLite 里表示**无上限**；`1e9` 同理。同时 `board:add` 没有任何速率限制（`board_server.js:127`），而 `jobs` 表**全仓没有 DELETE**（`board_store.js:511` 注释自认："`jobs` 表**从不删除**（全仓无 DELETE FROM jobs）"）。

**后果**：一条 `board:list {limit:-1}` 在积累了几万张单后会把整表 `rowToJob`（每行多次 `JSON.parse`）读进内存；配合无限流的 `board:add`，任何连接都能在几分钟内把库撑到几十万行，之后**每次面板刷新**都触发一次全表物化 → 控制面 OOM/卡死。这是"低成本、可重复、无需特权"的 DoS。

**修法方向**：`limit` 夹在 `1..500`；`board:add` 加 `takeToken`（如 30/60s）与全局未终结单上限；给 `jobs` 加保留策略（终态单归档/裁剪）。

---

#### R6-CTRL-08 身份绑定码文件跨进程读-改-写：新码会被静默抹掉

**位置**：`mindserver.js:1310-1320`（面板签发：`readStore` → `addCode` → `writeStore`）、`agent/commands/identity.js:72-90`（游戏内核销：`readStore` → `consumeCode` → `writeStore`）、`identity_store.js:258-268`（写用 tmp+rename）。

**证据**：同一个文件 `bots/<agent>/identity-codes.json` 被**两个进程**读改写，写入用 `<file>.tmp-<pid>` + `rename`（`identity_store.js:261-263`）——**rename 是原子的，但"读-算-写"整体不是**。没有任何锁或版本号。

**后果**（按时间序，真实可复现）：
1. 面板签发码 B：mindserver 读 `[A]` → `[A,B]` → 写盘；
2. 玩家在游戏里 `!claim A`：agent 早一步读到 `[A]`（不含 B）→ 核销 A → 把 `[]` 写回；
3. 结果：**B 被静默丢弃**。玩家拿着面板上显示的 B 去 `!claim`，得到"没有可用的绑定码"，而面板显示"5 分钟内有效"。
反向也可能：mindserver 的"面板断开 → 作废该会话未核销码"（`mindserver.js:1543-1555`）与 agent 核销并发时，可能把已核销的码**写回**（复活一个一次性码）。

**修法方向**：码表只让**一个**进程写（例如 mindserver 独占写、agent 只读 + 通过 socket 请求核销），或加文件锁 + 写前重读校验（CAS：比对 mtime/内容哈希，不一致就重试）。

---

#### R6-CTRL-09 状态机校验基于陈旧快照；`heartbeat` 的租约归属只在 JS 里判

**位置**：`board_store.js:712-743`（heartbeat）、`:957-961` + `:1032-1040`（finish）、`:1145-1158`（setState）、`:1197-1240`（updateJob）。

**证据**：

- `setState`：`canTransition(job.state, state)` 用的是**读**到的 `job.state`；UPDATE 条件是 `WHERE id=?` + attempt 守卫，**没有 `AND state=?`**（`:1157-1158`）。
- `updateJob`：同上（`:1240`）。
- `finish`：`attempts = job.attempts + 1` 来自读快照（`:961`），UPDATE 只有 `lease_owner` + attempt 守卫，**没有 state 守卫**（`:1032-1040`）。
- `heartbeat`：`if (job.lease?.owner !== bot) return LEASE_LOST`（`:719`）是 JS 判断；UPDATE **只按 id + attempt 守卫**（`:729-730`），SQL 里没有 `lease_owner=?`。而 `attemptGuardSql` 对"没传 attemptSeq"**完全不设限**（`:619-627`，fail-open，注释自认是老行兼容）。

**后果**（单进程下不可见，多写者下全部激活）：两个 bot 抢同一张单的老问题会**从 SQL 层回来**——读的时候租约是我的，写的时候已经被别人接管；`finish` 丢一次 attempts 计数；`setState(paused)` 把别人刚领的租约清空。这正是 R4/R5 反复修的那一族缺陷，修法是"把判据做成 SQL 条件"，但只做了 `finish` 的 `lease_owner` 和 attemptSeq，**没做 state 条件、没做 heartbeat 的 lease 条件**。

**修法方向**：所有状态转移统一成一条"带全部前置条件的 UPDATE"：`WHERE id=? AND state=? AND (lease_owner IS NULL OR lease_owner=?) AND attemptSeq...`，靠 `changes` 判定；`attemptSeq` 缺失时**不要** fail-open（至少对 `state ∈ {claimed,running}` 的行要求必须带）。

---

#### R6-CTRL-10 `MIND_SERVER_HOST` 能把 HTTP 放开，但 socket.io 仍被 `allowLocalOnly` 的 Host 白名单拒绝

**位置**：`mindserver.js:1742-1746`（host 可配）、`:949-956`（`allowRequest: allowLocalOnly`）、`local_only.js:16`（`LOCAL_HOSTS`）、`:34-40`（判据）。

**证据**：`LOCAL_HOSTS = {'localhost','127.0.0.1','[::1]'}`，`isLocalRequest` 要求 `Host` ∈ 该集合；`local_only.js` **没有任何环境变量开关**（`grep process.env local_only.js` → 0）。而 `MIND_SERVER_HOST=0.0.0.0` 只影响 `server.listen`。

**后果**：按 OPS-010 的意图在容器里 `MIND_SERVER_HOST=0.0.0.0` 后：HTTP 页面能打开（HTTP 门只看 token，不看 Host），但 socket.io 握手 `Host: <宿主IP>` 不在白名单 → `forbidden` → **面板加载出来但永远连不上**。日志里会看到"拒绝非本机 socket 连接"，但不会告诉运维"这是设计冲突"。这是功能缺口（不是安全缺口）：要么承认只支持本机、去掉这个 env 的暗示；要么在显式配置 host 时同步放宽/校验 Host 白名单。

---

### P2

#### R6-CTRL-11 限流按"远端地址"分桶，在"全本机"部署下退化成单一全局桶

**位置**：`mindserver.js:403-430`（`takeToken`，key = `label@address`）、`unlock_limiter.js:40-42`（`addressKeyOf`）。

**证据**：所有连接都来自 `127.0.0.1`/`::1`/`::ffff:127.0.0.1` → **同一个桶**。

**后果**：① 任何本机进程（或一个死循环的面板标签页）都能把 `create-agent`（5/min）、`restart-agent`（3/min）的额度**替所有人**耗光 → 跨客户端 DoS；② `unlock_limiter` 的"两个来源互不影响"（`unlock_limiter.js:7-8` 的设计目标）在本机部署下**没有第二个来源**，退化回全局计数——它的价值只在 `MIND_SERVER_HOST` 绑到网卡时才出现。这不是实现 bug，是**测试与部署语义的落差**（单测里"两个来源"是构造出来的）。

**修法方向**：把 token 指纹（前 8 位）或 socket.id 并入桶 key，或在注释/文档里明确"限流是全局配额，不是每客户端配额"。

#### R6-CTRL-12 配置中心并发丢更新；settings.js 回滚会覆盖并发写；备份名到秒会互相覆盖

**位置**：`config_center.js:475-487`（JSON 读改写）、`:490-506`（settings.js 写后校验+回滚）、`:324-342`（`backupThenWrite`）。

**证据**：
- JSON 组：`readJson` → `Object.assign` → `writeJsonFile`，两次并发 PUT 都基于旧文件 → 后写覆盖先写；
- settings.js 组：`before = readSettingsText()` → 写盘 → `await verifySettingsLoadable()`。**await 期间**另一个 PUT 可以读走"A 的中间结果"、写 B、再 await；若 A 校验失败，回滚用 `writeFileSync(SETTINGS_PATH, before)` → **把 B 的改动一起抹掉**；
- 备份名 `file.bak-YYYYMMDDHHMMSS`（`:299-302`）到秒；同一秒内两次写 → 同一个备份路径，`copyFileSync` 覆盖 → **第一份备份丢失**。

**后果**：面板上"点了两次保存"可能丢一次；更糟的是 A 写坏（理论上被 `patchSettingsText` 的"必须命中 1 次"挡住）时，回滚把别人的有效改动也撤了。**没有 version/ETag/条件写**。

**修法方向**：写前比对文件哈希（CAS），不一致返回 409 让前端重试；settings.js 回滚改为"只在当前内容仍等于自己写的那份时才回滚"；备份名加毫秒或序号。

#### R6-CTRL-13 `/api/config` 能运行期打开 `allow_insecure_coding`，与 `set-agent-settings` 的禁区口径冲突

**位置**：`config_center.js:138-150`（SCHEMA 里有 `allow_insecure_coding`）+ `:509-513`（只 warn）；对照 `auth_gate.js:158-177`（`SAFE_RUNTIME_SETTINGS` **故意排除** `allow_insecure_coding`，理由写着"等于远程开代码执行 = 本机 root"）。

**后果**：同一个危险开关有两扇门：socket 那扇明确封死，HTTP 配置中心那扇只回一行 warn 就写进 `settings.js`（对新起的 agent 生效）。**不是漏洞**（配置中心本来就是给主人的），但"两个地方对同一件事给出不同答案"正是本仓反复出现的病根；将来有人按 `SAFE_RUNTIME_SETTINGS` 的注释做安全假设会踩空。

**修法方向**：要么让配置中心也要求二次确认（如额外 `confirm: true` 字段），要么在 `auth_gate.js` 的注释里明确"配置面是例外，因为它需要写文件权限"。

#### R6-CTRL-14 保管库 `/unlock` 先 scrypt 后限流、且无并发上限 → 持 token 者可打满 CPU

**位置**：`mindserver.js:530-570`（顺序：先 `vaultUnlock`，再 `isThrottled`）、`unlock_limiter.js:19-27`（设计自认代价："超限期间失败的尝试仍要付一次 scrypt"）。

**后果**：限流**故意**不阻止错误尝试进入 scrypt（这是为了避免把管理员锁死，取舍正确），代价是：持 token 者（或任何本机进程）并发 N 个 `/unlock` 请求 → N 个 scrypt 并行 → 控制面 CPU 饱和。**没有并发闸、没有全局 QPS 上限**。

**修法方向**：加一个"同时最多 2 个 scrypt 在跑"的信号量，超出的直接 429；这不影响"正确口令总能解锁"（排队而不是拒绝）。

#### R6-CTRL-15 原型链键（`constructor`/`__proto__`/`toString`）在多个 handler 里造成未捕获异常

**位置**：`mindserver.js:1475-1481`（get-settings 直接索引）、`:1575-1587`（set-agent-settings 调 `agent.setSettings`）、`:1603-1606`（stop-agent → `mindcraft.stopAgent`）、`:1589-1601`（restart-agent）。

**证据**：`agent_connections` / `agent_processes` 是普通对象字面量；`agent_connections['constructor']` 返回 `Object` 构造函数（真值）。`knownAgent()`（`:1247-1250`）用了 `hasOwnProperty`，但上述几个 handler **没用**。例如 `set-agent-settings('constructor', {port: 1})` → `agent.setSettings is not a function` → handler 无 try/catch → 抛进 socket.io 派发 → `uncaughtException`。

**后果**：单次请求不致命（靠 `installCrashGuards` 兜住），但**每条消息一个未捕获异常 + 一段栈日志** → 日志洪水（可用来淹没真实告警、撑爆日志盘）；同时也说明这些 handler 对"任意字符串 = agent 名"毫无防御。

**修法方向**：全部改用 `knownAgent()` / `Object.hasOwn`；handler 体统一 try/catch 并回 ack。

#### R6-CTRL-16 `get-settings` 无限流且回整份 settings（含 `profile.permissions`）

**位置**：`mindserver.js:1475-1481`。

**后果**：任何持 token 连接（含 agent 子进程）可高频读取**所有** agent 的完整 settings，含 `profile`（owner 名单、base_profile、host/port）。owner 名单本身不是秘密（config/network.json 里有），但"任意 agent 能枚举所有 bot 的配置"是横向信息面，且无速率限制。

**修法方向**：`get-settings` 只允许读**自己**（agent 身份按通道绑定），或只回白名单字段。

#### R6-CTRL-17 `chat-message` 无身份校验（与 `bot-output`/`agent-event` 不一致）

**位置**：`mindserver.js:1562-1570`；对照 `:1694-1715`（那两个有 `isAgentIdentity` 检查）。

**证据**：`chat-message` 把 `(curAgentName, json)` 直接转发给目标 agent 的 socket；`curAgentName` 对面板连接是 `null`，对未登录连接也是 `null`。

**后果**：任何持 token 连接都能向任意 bot 注入一条"聊天消息"。bot 侧会把它当玩家消息处理（进 LLM 上下文）→ **提示注入通道**，且发送者身份可以是 `null`（行为未定义）。作者在 `bot-output` 上已经承认"面板能伪造 bot 说的话"是问题，但**反方向**（往 bot 里塞话）没有对称处理。

**修法方向**：与 `send-message` 合并成一条受控通路（校验 `from` 形状 + 限流），或给 `chat-message` 加 `isAgentIdentity` 检查。

#### R6-CTRL-18 `botRegistry` 无上限、无清理、可被任意连接覆盖 → roles 资格其实是自报

**位置**：`board_server.js:41`（`new Map()`）、`:118-124`（`board:hello` 覆盖写）、`:220-230`（claim 用 `botRegistry.get(bot).roles`）。

**证据**：注释（`:220-222`）说"用**服务端记下的** roles，不信任 agent 传来的 roles"——但服务端记下的就是**这个 agent 上一次在 `board:hello` 里自己说的**。而且 `board:hello` 的 `bot` 字段来自 payload，任何连接都能替**别的 bot** 重写能力表。

**后果**：① `requires.roles` 过滤可被绕过（自称 miner 即可领矿单；或把别人的能力改成空的，让他领不到）；② Map 无上限、断线不清理 → 任意 bot 名可以无限增长内存（DoS 变体）。

**修法方向**：能力表按 socket 绑定 + 断线清理；`roles` 若要可信，必须来自**配置文件**（`profile.roles`）而不是 hello。

#### R6-CTRL-19 1 Hz 状态轮询逐 agent 串行 `await`，多只卡住时面板状态整体停更

**位置**：`mindserver.js:1939-1967`。

**证据**：`for (let agentName in agent_connections) { ... await new Promise(... 5000ms timeout) }` —— 一只卡住 5s，10 只就是 50s；`polling` 标志只是**跳过**后续 tick，不会并行、也不会缩短。

**后果**：多 bot + 某个 bot 在等模型 API 时，面板状态卡住数十秒（用户在面板上看到"全部离线/不动"）。这不是安全缺陷，是可用性缺陷，但会掩盖真实故障（与"孤儿 agent"的症状难以区分）。

**修法方向**：`Promise.allSettled` 并发拉取（每只独立 5s 超时），整轮再加一个总超时。

#### R6-CTRL-20 `mcserver.findServers` 全局替换 `console.log` 且无 try/finally；端口扫描无总预算

**位置**：`mcserver.js:61-102`（`console.log = () => {}` / 循环 / 恢复）。

**证据**：`:83-99` 把 `console.log` 换成空函数，循环 49000→65000（16000 个端口 × 100ms 超时），**任何异常都会跳过恢复**（没有 try/finally）；`getServer(host, port=-1)` 走这条路（`:117-128`）。

**后果**：① `port=-1`（"自动找 LAN 服"）最坏要 ~27 分钟，期间**全进程日志静默**（`console.log` 被换成 no-op）——排查者会以为"mindserver 卡死了、什么都不打印"；② 一旦中途抛错，`console.log` **永久**是空函数（直到进程重启），后续所有日志静默丢失。这是"错误被吞导致状态不一致"的典型：**诊断信息被静默吞掉**。

**修法方向**：`try { ... } finally { console.log = original }`；扫描加总时限 + 并发度；或干脆用 `mc.ping` 的广播发现替代全端口扫。

#### R6-CTRL-21 401 页面里的 token 文件名渲染成 `mindcraft.mindserver-token`（r5 lint-h 仍成立）

**位置**：`mindserver.js:905`（HTML 提示）、`:913-914`（纯文本提示）。

**证据**：源码单引号串里写的是 `mindcraft\.mindserver-token`（`\.` 是无用转义 → 渲染成 `.`），而同函数的纯文本提示写的是 `mindcraft/.mindserver-token`。真实文件是 `<cwd>/.mindserver-token`（`:806`）。

**后果**：未授权用户照 HTML 提示找 `mindcraft.mindserver-token`（一个不存在的文件）→ 找不到 → 认为"面板坏了"。纯文案问题，但发生在**唯一的第一接触点**。

**修法方向**：把 `\.` 改成 `/.`（一个字符）。

---

### P3

| 编号 | 位置 | 问题 | 影响 |
|---|---|---|---|
| R6-CTRL-22 | `mindcraft.js:53-54` | `agentIndex = agent_count++`，`viewer_port = 3000 + agentIndex` 只增不复用 | 反复创建/销毁后 viewer 端口一直涨，超过 65535 后 `viewer_port` 无意义（不崩，但面板上的 viewer 链接会指向一个不存在的端口） |
| R6-CTRL-23 | `mindcraft.js:80-82` + `mindserver.js:1529-1537` | `agentProcess.unregister → destroyAgent` 只删 `agent_processes`，**不删 `agent_connections`** | 进程异常退出后注册项残留：面板显示"这只 bot 还在"；同名 `create-agent` 被永久拒绝（"Agent already exists"），必须手动 `destroy-agent` |
| R6-CTRL-24 | `board_server.js:127`；`board_client.js` ack 超时 5s | 无幂等键：ack 超时后客户端重试会产生**重复任务单** | 同一件事被做两遍（挖两份料），与 R6-CTRL-07 叠加会加速表膨胀 |
| R6-CTRL-25 | `mindserver.js:1266-1286` | `identity-status` 的 `modeInfo` 用 `try/catch {}` 静默吞错 → `mode: null` | 面板无法区分"读不到 online-mode"与"一切正常"，用户不知道自己在哪种策略下（而这正是 t27 要解决的问题） |
| R6-CTRL-26 | `mindserver.js:1157-1162`、`1885-1900` | `agentsStatusUpdate` 在**连接建立时**就给这条新连接广播，随后 `for...in agent_connections` | 无实质缺陷，但与 `for...in` 的继承键语义耦合（见 R6-CTRL-15）；建议统一 `Object.keys` |

---

## 4. 与 `docs/audit-r5` 的对账（仍成立 / 已修 / 描述不准确）

> 说明：我**只核对了与本次范围重叠的 r5 条目**（控制面、token、vault 门、RCON、任务板路径）。r5 的正文缺陷（R5-001/003/004/005/006/007/012）不在本范围，未复核。凡"已修"均给出**当前代码证据**，不引用 r5 的自述。

| r5 条目 | r5 的结论 | 本轮核对依据 | 判定 |
|---|---|---|---|
| `07-lint-nonstyle.md §h`：`mindserver.js` 401 提示的文件名渲染成 `mindcraft.mindserver-token` | 低危文案不一致（附注，非规则缺陷） | 当前源码 `mindserver.js:905` 仍是 `mindcraft\.mindserver-token`（`cat -v` 确认单反斜杠）；纯文本分支 `:913` 是 `mindcraft/.mindserver-token` | **仍成立**（且未修）→ 见 R6-CTRL-21 |
| `R5-002 / OPS-02`：`acl-regression.mjs` 断言 `mindcraft\.mindserver-token` 存在，干净仓库必红 | CONFIRMED（P1，缺陷在测试脚本） | 事实基础仍在：`mindserver.js:806` `TOKEN_FILE = path.join(process.cwd(), '.mindserver-token')`，仅在 mindserver 启动时写、退出时删（`:816-820`）。脚本本身不在本次范围 | **描述准确、仍成立**（缺陷本体在 `scripts/tests/`，范围外） |
| `08-修复验收.md §6.4 (t24)`：`.mindserver-token` 免 `-Apply` 即收口 | PASS（已落地） | `mindserver.js:76-103` `hardenTokenFileAcl()`（`icacls` + `execFile` argv，无 shell；断开继承 + 只授当前用户/SYSTEM/Administrators），调用点 `:810` | **已修（代码在）**；残留：失败只 `console.warn`（`:85/:93/:101`），面板/运维看不到"这次收口失败了" → 建议升级为可见状态（P3 级，未单列） |
| `15-终验 §5.4 / T31-W-2`：连错 5 次后**正确口令必须 200** | PASS | `mindserver.js:530-570`：先 `vaultUnlock`，成功后 `noteSuccess`；失败才判 `isThrottled` → 401/429。`unlock_limiter.js:90-103` 注释与实现一致（`isThrottled` 不参与提前 return） | **已修**；补充观察：分桶按来源，而本机部署只有一个来源 → 实际退化为全局桶（R6-CTRL-11） |
| `08-修复验收.md §8 / R5-008`：RCON 明文 + `server-ip` 空 → 25575 对全网卡 | PASS（换的是防火墙路径） | 代码面：`proc_control.js:81-86` 从 `server.properties` 读明文口令；`:103-140` 的 RCON 客户端**只连 `127.0.0.1`**（`net.connect(port, '127.0.0.1')`）。"对全网卡监听"是 `server.properties` 的配置事实，不是这段代码能控制的 | **描述不准确（就代码面而言）**：代码不做对外连接；风险 100% 落在配置文件与防火墙，配置面的结论仍成立 |
| `04-ops.md:204`："任务板/记忆来自唯一真相 `mindcraft/bots`" | PASS | `bot_paths.js:54-63` 锚到**包根绝对路径**（不随 cwd 变），`boardDirOf()` = `<pkg>/bots/_board`（`:102-104`）；`MC_BOTS_ROOT` 可覆盖 | **仍成立**（并且这是"队伍板不需要换库"的前提） |
| `R5-010`：`chmod 600` 在 NTFS 上无效 | CONFIRMED（P2） | 对 **token 文件**这一路径：已被 `icacls` 收口（见上条 t24）。对 `keys.json` / 父目录可写：不在本次范围 | **对 token 文件已修；对 keys.json 未复核**（范围外） |
| `R5-001 / OPS-06`：`start-panel.ps1` 缺 BOM → 面板起不来 | CONFIRMED（P0） | 本轮**未运行**，无法验证；但它决定 `.mindserver-token` 是否生成，因此与本次范围有因果关系 | **未复核**（范围外 + 需真机运行） |

---

## 5. 架构缺口：从"每 bot 角色板"到"队伍共享板"

### 5.1 现状的真实形状

```
bots/                                  ← 唯一根（bot_paths.js:54-63，锚包根）
├── _board/board.sqlite                ← 全系统一份；唯一写者 = mindserver
│     jobs(id, kind='personal'|'shared', assignee, parentId, requires, claims, state, lease...)
│     claims(id=jobId, key='block:x,y,z'|'area:...'|'item:<name>[:n]', owner, until)
│     shared(kind='landmark'|'danger'|'chest', key, value, owner)   ← 主键 (kind,key)
├── <bot>/memory/*.json                ← 每 bot 一份
├── <bot>/identity.json                ← 每 bot 一份（agent 写）
├── <bot>/identity-codes.json          ← 每 bot 一份（mindserver 写、agent 核销）
├── <bot>/map/terrain3d.db             ← 每 bot 一份（明确不共享，board_store.js:2009-2013）
└── <bot>/histories/                   ← 每 bot 一份
```

**"共享"已经在存储层发生了**：`jobs` 与 `shared` 都是全局表；"每 bot"只是**视图**（`scope:'mine'`）与**兄弟目录**。

### 5.2 队伍化真正缺的四样东西

| 缺什么 | 现状 | 影响 |
|---|---|---|
| **队伍维度** | `jobs` 无 `teamId`；`shared` 主键只有 `(kind,key)`；`claims` 只有 `(id,key)` | 两个队伍都写 `landmark:home` / `chest:10,64,20` → **互相覆盖**；一个队伍的"材料清单"就是另一个队伍的 |
| **成员关系** | 无队伍表、无成员表；等价物只有 `assignee`（单个人）与 `kind='shared'`（所有人） | 无法表达"这三只 bot 一队"，`scope:'all'` 是**全局**可见（`board_server.js:177-181`）→ 队伍板只能靠约定，不能靠代码 |
| **可见性规则** | `board:list` 只有 `mine/claimable/all` 三档 | 队伍板需要第四档 `team`（默认），且 `all` 应收紧/仅诊断 |
| **原子取料** | `item:` 预约是布尔互斥、不记额度、与箱子清单不联动（见 Q3） | 两个分身领同一材料 = 缺口 C（单进程下就存在） |

### 5.3 建议的落点（不写代码，只给形状）

1. **不要换库、不要让子进程开库**。队伍板 = 在现有 `board.sqlite` 上加 `teamId`（`jobs`/`shared`/`claims` 三表各加一列 + 复合主键），并把 `openBoard` 继续留在 mindserver。
2. **`shared` 主键改为 `(teamId, kind, key)`**，否则两队的地标/箱子必然撞车。
3. **新增一个原子 RPC `board:material-take`**：在**一个 `BEGIN IMMEDIATE`** 里完成"读清单 → 校验剩余 ≥ n → 扣减 → 写 `item:` 预占 → 返回余额"。把它做成 store 层函数（可离线单测），socket 层只做 ack。
4. **`item:<name>:<n>` 的冲突判定要升级**：从"同名即冲突"改成"额度池"（`remain` 记账），否则队伍里两只 bot 永远不能各领 1 个同种材料。
5. **加 `teamId` 之后的默认 scope = team**，`all` 只给面板诊断用（并在服务端按连接身份过滤，而不是信任 payload）。
6. **写者模型保持不变**（单写者）。如果将来真要读写分离，先补 Q2 表里的 10 条 + `UNIQUE(key)` + `BEGIN IMMEDIATE` 重试 + 迁移期独占锁。

---

## 6. 诚实边界：我没做什么、哪些结论是"读出来的"而不是"跑出来的"

1. **未启动任何服务**：所有结论来自静态阅读与跨文件核对。所以"两个进程同时写会双占"是**基于 SQL 语义的推断**（`SELECT` 与 `INSERT` 之间无事务 + 主键 `(id,key)` 不阻止跨 id 重复），我没有起过第二个写者。
2. **未运行攻击脚本**：R6-CTRL-01/02/03/07/15 的"可被任何持 token 连接触发"是"代码里确实没有检查"的结论，不是"我实际打穿了"。要变成实锤需要起 mindserver + 一个客户端，超出本轮"只读"约束。
3. **`node:sqlite` 的行为**：WAL/`busy_timeout`/`LIMIT -1` 的语义来自 SQLite 官方语义与 Node v24 的 `node:sqlite`（`DatabaseSync` 同步 API）。我没有在本机构造 `SQLITE_BUSY` 来实测 `busy_timeout=5000` 的实际等待行为。
4. **r5 条目只做"代码面"对账**：`08-修复验收.md` / `15-终验.md` 里那些"实测 PASS"的结论我**没有重跑**；我的"已修"仅指"当前代码里能看到修复"，不等于"在当前环境仍 PASS"。
5. **`secrets_vault.js` / `terrain3d.js` 不在本次范围**：只在 `mergeSharedChest` 的 scrypt 代价、`terrain3d` 明确不共享这两处被引用，未做审计。
6. **`board_scheduler.js` / `board_client.js` 未逐行审**：只核对了"agent 侧不开库""客户端有本地缓存镜像"这两个与并发结论相关的事实。

---

## 7. 给下一轮的一句话

**队伍共享板不需要"换库/多进程写"，需要的是"加 team 维度 + 一个原子取料 RPC"；而在动多进程写之前，必须先补 `reserve` 的事务、`mergeSharedChest` 的静默降级、`openBoard` 的破坏性重建这三处——否则第二个写者一上线，丢的就是工单和材料账。**
