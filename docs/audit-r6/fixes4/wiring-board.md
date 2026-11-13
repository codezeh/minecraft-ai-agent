# board_server 接线：`team.*` / `inventory.*` 结算写 events + 访客判定（D8 · D7-6）

> R6 / fixes4 · 2026-11-13 · 任务 **t2**（wire-board）
> 改动面：`mindcraft/src/agent/library/board_server.js`、`mindcraft/tools/wiring_board_events_unit.mjs`（新单测，45 例）、本文件
> 上游依据：`events.md` §2/§4/§11（kind 白名单、world_id 语义、接线清单 #2/#3）、`inventory.md` §8（访客不记账 + audit）、`team.md`（按存档的队伍表）
> 同批交叠：`board_server.js` 由 t2 与 t4 同时改，插入点按 captain 2026-11-13 的切分执行（见 §1）

---

## 0. 一句话 + 边界

一句话：`board_server` 的**每个已登记 kind 的业务动作**现在都真的写一条 events（带 `worldId`/`avatarId`），
而"访客"这条分流**不再只是接缝**：注入 `isVisitor=true` ⇒ 预占/结算不占本机账（reservation / ledger 零行）、
只留 `inventory_audit`，且**不**写 `inventory.reserve|settle`（被跳过的动作不是账变）。

**这次没有做的事**（别读成"已完成"）：
* 没有新增 kind、也没有改 `EVENT_KINDS` 白名单（`inventory.store` 是 **captain 2026-11-13 批的**，t8 只做接线）—— 白名单里没有的动作一律**不写**（缺口表见 §4）；
* 没有做 events 的 retention/compact（events.md §12 的边界不变）；
* 没有把 `payload.visitor` 变成有效输入（客户端自报仍然**无效**，只认注入判定）；
* 没有改 `inventory:settle` 的 ack 形状、没有重排 inventory 段 handler 顺序、没有动 `board_inventory.js` 的券生命周期函数；
* 没有让生产上出现访客（`visitorOf()` 仍恒 false，见 §5）。

---

## 1. 位置清单（**复核按这个查**）

| # | 位置 | 内容 | 归属 |
|---|---|---|---|
| 1 | 顶部 import 后（模块作用域） | `chestKeyOf(container)`、`recordBoardEvent(recorder, kind, payload, evCtx)` —— **全文件唯一事件写入口**，worldId 门禁 + 旁路 try/catch 都在这里 | t2 |
| 2 | `attachBoardServer` 内、`isVisitor` 之后 | `const ev = (kind, payload, evCtx) => recordBoardEvent(...)`；默认取 `global_store.recordEvent`，`deps.recordEvent` 是单测注入点 | t2 |
| 3 | `team:create` ack 之后 | `void ev('team.create', ...)` | t2 |
| 4 | `team:join` ack 之后 | `void ev('team.join', ...)`（`already=true` 幂等重入**不写**） | t2 |
| 5 | `team:leave` | **回 ack** → `await teamWorld()` 解析存档 → `team.leave`；`disbanded=true` 时再加 `team.disband` | t2 |
| 6 | `inventory:reserve` ack 之后 | `void ev('inventory.reserve', ...)`（访客分流**不写**） | t2 |
| 7 | `inventory:settle` ack 之后 | `void ev('inventory.settle', ...)`（`already` 重放 / 访客**不写**） | t2 |
| 8 | `inventory:release` ack 之后 | `void ev('inventory.rollback', ...)`（`changes=0` 幂等重放**不写**）；**handler 本体是 t4 插的**，只有这一行事件归 t2 | t4 handler + t2 事件行 |
| 9 | `inventory:reconcile` ack 之后 | `void ev('inventory.reconcile', ...)`（`dryRun` / `written=0`**不写**） | t2 |
| 9b | `inventory:store` ack 之后 | `void ev('inventory.store', ...)`（访客分流**不写**；qty=`ledger.delta`=+qty） | t2（t8 补） |
| 10 | **`inventory:ledger` 之后** | 只有一段**位置说明注释**，不新增 handler、不改上面任何 handler | t2 |

★ **关于"位置在 `inventory:ledger` 之后"**（captain 2026-11-13 裁决 1，(A)）：
inventory 侧的**调用点**必须留在各自 handler 里（各 1 行），因为 `worldId` **只有 handler 手里的
`pre.worldId` 才有**（ack 回执里没有 worldId）。搬到 ledger 之后的区块里靠"嗅探 ack"反推，
就得给 worldId 兜底成 `'default'`（违反 §2 口径 ②），而且 ack 一改事件会**静默消失** ——
那正是这一批反复在抓的"看起来接了、其实随时会断"。所以 ledger 之后放位置说明与分工声明，
实际调用点是第 6~9 行那 4 行 `void ev(...)`，**settle handler 只多了那 1 个 if 块，ack 形状与执行顺序一字未动**。

★ **顺序口径（captain 2026-11-13 复核点）：8 个事件调用全部在"成功回执"之后。**
用户等的是回执，审计是旁路 —— 所以先 `ack(cb, { ok: true, ... })`，再解析存档、再写事件。
反例的代价：`worldIdResolver()` 会碰文件系统（`PRAGMA database_list` + 路径解析），
把它放在 ack 之前等于让**回执给审计当人质**。
本条**可机器验证**：单测 **B7** 按 handler 边界切片，要求每个 kind 的 `void ev('kind'` 位置
**晚于**同一 handler 里 `ack(cb, { ok: true` 的位置（只认成功回执，不认开头的失败 ack ——
第一版就栽在这：把 ev 挪到成功 ack 之前，B7 照样 PASS，因为匹配到了 `if (!pre.ok) return ack(cb, pre.ack)`）。
把 ev 挪到 ack 之前 ⇒ B7 立刻报 `违规：inventory.settle`（实测）。

★ **断言的范围必须和它要保证的范围一致**（这条与 B7 一起留下的教训）：
B7 是这批里唯一一条**按 handler 边界切片**的断言，不是全文扫。
全文扫只能证明"文件里某个地方有 ack 在前面"——把 ack 挪到事件后面它照样绿，
因为它压根没在验证"同一个 handler 内"这件事。要保证什么范围，就在什么范围里断言；
同一个道理的另一面是：**断言要钉在会被执行的那一行语句上**（不能钉在注释、也不能钉在"长得像"的近似物上）。
`team:leave` 一开始是"先解析存档再 ack"（为了让测试有确定先后），已按此口径翻正 ——
测试改为**有界轮询**等事件落地（`waitFor`），不再假设"ack 时事件已写完"。

> ## 通用规则（比"顺序偏好"更重要的那条）
>
> **旁路的东西，不但不能影响结果，也不能影响延迟。**
>
> 这条是"事件写失败不影响业务"的**延伸**：只保证"不影响结果"是不够的 ——
> 审计慢一点，用户就多等一点；审计要是卡住（网络盘、库锁），面板就一直转圈，
> 而**从用户视角这跟"业务失败"没有区别**。所以旁路的正确形态是：
> **先把结果交出去，再去做旁路的事**。下一批再有人想"顺手在 ack 之前把事件写了"，先读这一条。

★ **关于落点选 `board_server` 而不是 `board_inventory`**：任务书原文写的是"`board_inventory` 的
settle / reconcile 成功后"。实际落在 `board_server` 的 handler 里，原因有两条，都是硬的：
① `worldId` 只在 socket 层（`inventoryPre`）有，`board_inventory` 的函数拿不到"这块库属于哪个存档"之外的上下文；
② `board_inventory.js` 是本批 t4 的活动文件（`releaseReservation` 正在里面加），
再往里插事件会与 t4 抢同一段。captain 的裁决 1/2 也是按 board_server 切的。
**副作用**：如果将来有人绕过 socket 直接调 `settleTake()`（例如面板或脚本），那条路径**不会**写事件 ——
这是已知边界，写在 §6。

---

## 2. 三条硬口径（附证据）

| # | 口径 | 怎么保证 | 证据 |
|---|---|---|---|
| ① | **`recordEvent` 的返回值不参与业务判断** | 所有调用点写 `void ev(...)`，永不接返回值；写失败/抛错只 `console.warn` | 单测 **B2**（`ev(` 计数 == `void ev(` 计数）、**B3**（没有 `const r = ev(` / `if (ev(` / `ev(...).ok` / `return ev(`）、**C17**（注入记录器返回 `ok:false` 与直接抛错两轮 ⇒ 预占/结算照常成功、账本照常落行）、**C18**（**真的**写不进 events ⇒ 队伍操作仍然成功） |
| ② | **`worldId` 拿不到就不写，绝不填假值** | 门禁在 `recordBoardEvent` 里（trim 后为空 ⇒ `reason:'no-world-id'`，**不调**记录器）；团队/库存的 worldId 只来自 `teamPre`/`teamWorld` | 单测 **A1/A2**（记录器 0 次调用）、**B5**（源码里没有 `worldId ?? 'default'` 之类兜底）、**C14/C15/C16**（`worldIdOf` 返回空 ⇒ 业务 `NO_BOARD` 且 events **零新增**、全库没有 `default`/`unknown`/空 world_id） |
| ③ | **唯一写入口** | `recordEvent` 只能在 `recordBoardEvent` 里被调用一次；`ev` 绑定是唯一引用点 | 单测 **B1**（源码里**直接** `recordEvent(` 调用数 = 0）、**B1b**（`recordEvent` 文本引用只在 import + `ev` 绑定，共 4 处） |

**注（变量名 `evCtx`，captain 2026-11-13 裁决 3）**：第二个形参叫 `evCtx` 而**不是** `ctx`。
`tools/deps_injection_audit.mjs` 的 B 档扫 `board_*.js` 里"`ctx.F` 且有早退"的地方，并要求
`F ∈ makeCtx()` 的键 —— 用 `ctx` 当形参名会被判成"单测注入、生产不注入的死分支"（实测红过一次）。
本仓的 `ctx` 是 `composite_registry.makeCtx()` 的专用对象，这里传的是**每次调用的事件元数据**，
两者不是一回事；改名消歧，**审计本身一个字没改**（不为消误报削弱真保护）。

---

## 3. 事件表（socket 事件 → kind → payload）

| socket 事件 | kind | payload | evCtx | 什么时候**不**写 |
|---|---|---|---|---|
| `team:create` | `team.create` | `{teamId, name, role, avatarId, by, avatar}` | `{worldId, avatarId}` | worldId 解析不出（业务本来也 NO_BOARD） |
| `team:join` | `team.join` | `{teamId, role, avatarId, by, avatar}` | 同上 | `already=true`（自助加入的幂等重入） |
| `team:leave` | `team.leave` | `{teamId, avatarId, by, avatar, disbanded, promoted}` | 同上 | worldId 解析不出（离队仍成功，只是没事件） |
| `team:leave`（最后一人） | `team.disband` | `{teamId, avatarId, by, avatar}` | 同上 | 同上 |
| `inventory:reserve` | `inventory.reserve` | `{reservationId, item, qty, holder, known, reserved, available, expiresAt, chestKey}` | 同上 | 访客分流（没落预占行，见 §5）；worldId 解析不出 |
| `inventory:settle` | `inventory.settle` | `{reservationId, item, delta, holder, chestKey, container}` | 同上 | `already=true`（账本行早写过）；访客分流；worldId 解析不出 |
| `inventory:release` | `inventory.rollback` | `{reservationId, item, qty, holder, reason}` | 同上 | `changes=0`/`already=true`（券早回池）；worldId 解析不出 |
| `inventory:reconcile` | `inventory.reconcile` | `{checked, changed, written, diffs(≤20), diffsTotal, holder}` | 同上 | `dryRun`；`written=0`（账实一致）；worldId 解析不出 |
| `inventory:store` | `inventory.store` | `{item, qty, chestKey, holder, avatarId, by}` | 同上 | 访客分流（`stockIn` 已 `skipped`、账本零行）；worldId 解析不出 |

* `delta` 是**负的实际取用量**（`-take`），与 `inventory_ledger` 同一口径 —— 账实不符时这是唯一的第三方证据。
  `inventory.store` 是它的**镜像**：`qty` = `ledger.delta` = **+存入量**（存进去与取出来在 events 里方向相反，便于按 kind 抽样对账）。
* `chestKey` = `"x,y,z"`（`chestKeyOf()`）；坐标不合法 ⇒ `null`（不编 `0,0,0` 假装知道位置）。
* `avatarId` 同时出现在 `evCtx`（列上）与 payload（便于人读）；`by` 是动作发起者（本批 = 同一个 avatar）。

---

## 4. 缺口表（白名单里没有的 kind **不造、不写**；已批准的登记为"待接线"）

规则：**新增 kind = 改 `global_store.EVENT_KINDS` + 改 `events.md`**（events.md §4 规则 3）。本任务不越权造名字。
状态口径：**"已批准、待接线" = kind 已在白名单里、只差在 handler 里插那一行**；**"建议不写" = 有意的决定**（不是遗漏）；
**"下一批" = 需要改白名单/口径，不在本批范围**。读这张表的人不该把"待接线"当成"没批准"。

| 操作 | 现有 kind | 建议 kind 名 | 谁定的 / 为什么现在不写 |
|---|---|---|---|
| `team:chest-add` | 无 | `team.chest-add` | **建议补**（captain 2026-11-13 确认）：这是**有账变的操作** —— 登记坐标决定了"哪些箱子算共享"，共享仓账本的适用范围由此界定。但**不是这批**，两条理由：① 要改 `EVENT_KINDS` 白名单（+ `events.md` §4 的 kind 清单），属下一批；② 要考虑**事件量**（一个队伍可能加几十个箱子，逐条写会稀释有效信息），接线时得先定口径（全写 / 只写首次登记 / 带上限） |
| `inventory:store`（t4 新增：往共享箱存入，`stockIn` 写 `inventory_ledger` 正 delta、访客只留 audit） | **`inventory.store`（已在白名单，30 个 kind 之一）** | `inventory.store` | **已接线（2026-11-13，t8）**：handler 成功 ack 之后 `void ev('inventory.store', {item, qty, chestKey, avatarId, by})`，qty 取 `ledger.delta`（=+qty）、带 `chestKey`、**访客不写**。证据：C12b/C12c（值对得上）、D7（访客零事件）、B7（ack-first）。原判断"有账变、应当有事件"保留在此供追溯 |
| `inventory:cache-refresh` | 无 | **建议不写事件（captain 2026-11-13 已确认保持）** | 开箱刷新是**高频内部动作**（每个容器每次开箱一条），写进 events 会把真正要看的账变淹没；缓存本身有 `container_cache.updated_at` |
| `inventory:mark-dirty` | 无 | `inventory.dirty`（可选） | **建议不写事件（captain 2026-11-13 已确认保持）**：只有"脏持续存在"才有意义；若将来要做，只在 `dirty 0→1` 时写（重复标脏不写），且需先登记 kind |
| `team:chest-list` / `team:list` / `inventory:snapshot` / `inventory:ledger` | 无 | **不写** | 纯读操作，不是"发生过什么"；写事件只会把审计表变成访问日志 |
| 预占过期清扫（`sweepInventoryReservations` → `expireReservations`） | 无（`inventory.rollback` 语义接近但不同：过期 ≠ 主动回滚） | `inventory.expire` | 每 5 秒扫一次、可能一次作废多条；现在写会灌爆。**要做得先有 kind + 批量 id 上限**，属下一批 |
| 访客被分流的 reserve/settle | 无 | **建议不写** | 没发生账变（reservation/ledger 零行）；留痕已有 `inventory_audit`（actor/action/qty/container）。写 `inventory.reserve` 会让"按 kind 统计"把一次免账查询算成一次真实占用 |

---

## 5. `isVisitor`：**接线存在** ≠ **接线有效**（两条都证）

| 层次 | 结论 | 证据 |
|---|---|---|
| 接线**存在** | `mindserver.js` `isVisitor: visitorOf` 真的传进 `attachBoardServer`；`board_server` 的 `isVisitor()` 真的读 `deps.isVisitor`，`inventoryPre()` 把结果传给 `reserveStock`/`settleTake` | 单测 **B6**（源码断言 `isVisitor: visitorOf`）、**D5**（判定器真的被调用，拿到的是**服务端解析出的 worldId**，不是 payload 自报） |
| 接线**有效** | 注入 `true` ⇒ `inventory_reservation` **0 行**、`inventory_ledger` **0 行**、`inventory_audit` 有行（reserve + take，t8 起再加 store）、events 里**没有** `inventory.reserve|settle|store` | 单测 **D1/D2/D4/D7** |
| 客户端自报**无效** | `payload.visitor:false` 说谎也压不过注入的 `true` | 单测 **D3** |
| 判定器抛错 | 判 **false**（不误判成访客、不炸业务） | 单测 **D6** |

⚠ **诚实边界（不变）**：`mindserver.visitorOf()` 现在**恒返回 false**（`VISITOR_JUDGEMENT_WIRED=false`）——
访问凭证还没和"连接"建立映射（avatar ↔ peerId 未设计）。所以**生产上目前没有任何连接会被判成访客**。
本任务把"注入 ⇒ 有效"这条路证死了，但**没有**创造访客 —— 那需要凭证接线。

---

## 6. 未做 / 残留（别当成已实现）

* `team:chest-add` 没有 kind（§4），所以"登记共享仓"这个动作在 events 里**看不见**；它仍在 `team_chest` 表里。
* **绕过 socket 直接调 `settleTake()`/`reserveStock()` 不写事件**：事件写在 socket 层（理由见 §1）。
  面板/脚本若直连 store，只能看到账本，看不到 events —— 这是已知边界。
* events 只写**本机**（`_global/mind.sqlite`），队伍/库存的表在**按存档**的板库里 —— 两者不是同一事务：
  极端情况下（板库提交成功、events 写失败）会出现"账上有、事件没有"。这是**故意的取舍**：
  events 是旁路（events.md §11 硬约束 1），不能因为它写不进去就把业务回滚。
* 同一个 `worldId` 下的事件顺序只按 `(at,id)` 排；同一毫秒内多条不保证业务因果序（events.md §2 已写明）。
* 本批没有做面板读取（t3 的事）；事件表已经可读（`sinceEvents`/`statsByKind`）。

---

## 7. 验证记录（可复跑）

```bash
cd mindcraft
node tools/wiring_board_events_unit.mjs     # 45 通过 / 0 失败，exit 0
node tools/deps_injection_audit.mjs         # ✅ 未发现"有早退分支但生产不提供"的字段，exit 0
npm run gate                                # exit 0（含 lint:hard no-undef=0 / no-floating-promise=0）
node tools/unit_all.mjs                     # exit 0（全量离线单测）
```

**"能红"实测（10 组变异：改坏 → 跑 → 复原；复原后 sha256 与改坏前逐字节一致）**

| 变异 | 期望红 | 实测 |
|---|---|---|
| `recordBoardEvent` 去掉 worldId 门禁、兜底 `'default'` | A1/A2 | **红 2 条**（`calls=1`） |
| worldId 门禁改成"放行但不记" | A1/A2 | **红 2 条** |
| `inventory:settle` 的 `void ev(...)` 改成 `if (false)` | C9/C10 | **红 2 条**（`settle_events=0`） |
| `inventory:release` 的 `inventory.rollback` 改成 `if (false)` | C11 | **红 1 条**（`rows=0`） |
| `team.create` 事件改成 `if (false)` | C2 | **红 1 条** |
| `isVisitor` 直接 `return false`（忽略注入） | D1~D5 | **红 5 条**（reservation 出现 1 行、audit=0） |
| 一条 `void ev(...)` 改成 `const _unusedOk = ev(...)` | B2/B3 | **红 2 条**（`ev(=8) void ev(=7)`） |
| **在 settle 的成功 ack 之前**插一条 `void ev('inventory.settle', ...)` | B7 | **红 1 条**（`违规：inventory.settle`） |
| **在 store 的成功 ack 之前**插一条 `void ev('inventory.store', ...)` | B7 | **红 1 条**（`违规：inventory.store`） |
| 去掉 store 的访客分流（`if (true)`） | D7 | **红 1 条**（`evDelta:1`，访客写了事件） |

**回归（改了 `board_server.js` 之后，受影响的老测试全绿）**

```
inventory_ledger_unit        13 pass / 0 fail
team_store_unit              12 pass / 0 fail
board_b4_unit                11 pass / 0 fail
board_b3_unit                23 pass / 0 fail
board002_claim_items_unit    17 pass / 0 fail
board003_attempt_lease_unit  30 pass / 0 fail
board_add_guard_unit         22 pass / 0 fail
board_iface_unit             16 pass / 0 fail
board_registry_unit           5 pass / 0 fail
```

全量 `unit_all` / `npm run gate` / `deps_injection_audit` 都已在本地跑过（见上）；真机 E2E 与
整批 diff 复核归 t5/t6。

**`unit_all` 的一次非本任务红点（如实记录）**：最后一次全量跑（2026-11-13 15:26）唯一失败是
`web_dist_manifest_unit`（`web/src` 指纹与 `web-dist/MANIFEST.json` 不一致）—— 这是 t3 正在重建面板产物
的中间态（当时 `web-dist/assets/*` 正在被替换），与本任务无关；本任务相关的 10 个套件（含新单测 42 例、
`wiring_federation_unit` 57 例、`wiring_flow_reserve_unit` 9 例）全绿。
