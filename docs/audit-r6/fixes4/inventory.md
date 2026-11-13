# 共享库存（预占 / 结算 / 对账）：表、事务边界、边界条件

> R6 / fixes4 · ADR-0001 阶段 3 · D7（真实箱子为准 + 数量级预占 + 结算 + 对账）· 2026-11-12
> 交付：`mindcraft/src/agent/library/board_store.js`（schema v4→v5：四张表）、
> `mindcraft/src/agent/library/board_inventory.js`（预占/结算/对账/缓存/快照）、
> `mindcraft/src/agent/library/board_server.js`（`inventory:*` 七个事件 + 服务端裁决 + 过期清扫）、
> `mindcraft/src/agent/library/board_client.js`（客户端方法 + 无板降级）、
> `mindcraft/src/agent/library/flow_store.js`（开箱强刷缓存 + 取用失败标脏）、
> `mindcraft/tools/inventory_ledger_unit.mjs`（13 条，含"摘掉事务立刻红"）。

## 0. 一句话结论

D7 的四件事都落地了：**数量级预占**（读-判断写在一个写事务里）、**结算**（账本 + 预占转消耗，
同事务、幂等）、**对账**（缓存 vs 真实，以真实为准修正账本，可重复跑）、**开箱强刷 + 失败标脏**。
访客分流也有落点（只留审计、不写本机账本），但**"谁是访客"目前只能由服务端注入判定**，
阶段 4 接访问凭证之前，生产上没有连接会被判成访客 —— 这条边界必须一起读。

## 1. 四张表（为什么是四张，不是三张）

```sql
inventory_reservation(id PK, world_id, item, qty, holder, created_at, expires_at,
                      status DEFAULT 'held', consumed_qty, closed_at)
    + INDEX idx_inv_res_open(world_id, item, status)
inventory_ledger(id PK, world_id, item, delta, holder, reason, at)
    + INDEX idx_inv_ledger(world_id, item, at)
container_cache(world_id, x, y, z, items_json, updated_at, dirty, PK(world_id,x,y,z))
inventory_audit(id PK, world_id, actor, action, item, qty, detail, at)   -- 访客审计，append-only
```

- **`status` 为什么不能省**：D7-3 的"预占转消耗"与 D7-2 的"过期作废"是两种不同终态，
  光靠"删行"分不出来。而**结算幂等**恰恰需要它：同一个 `reservationId` 再结算一次，
  必须能回答"你上次已经结过了"（`status='consumed'`）而不是"没这张券"。
  同理，`expires_at` 过期的券如果直接删掉，再次结算就变成 `NO_TARGET`（"查无此券"），
  用户看到的是"没预占过"—— 那是**假信息**。现在它明确回 `RESERVATION_EXPIRED`。
- **`inventory_ledger` 只记"物理上真的动了"**：取用为负（`reason='take'`），
  存入为正（`reason='store'`，`stockIn()` 写，与 `take` 对称），
  对账修正为差额（`reason='reconcile'`），另有 `reason='release'`（**delta=0**，券回池的留痕，不参与任何求和）。
  **不记"预占"**（预占不是移动）。`store` 与 `reconcile` 必须分开：
  后者专指"账实不符、以真实为准修正"，把正常存入写成 reconcile 会让"对账修正了多少货"**静默变错**。
  账本一旦混进非移动记录，"账本 = 物理移动"这个唯一口径就废了 —— 所以 release 行是**唯一的** delta=0 例外，
  且它不参与 `knownStockOf` / `reservedQtyOf` 的求和。
- **为什么多一张 `inventory_audit`**：D7-6 要求"访客不写本机账本，只留审计"。
  审计塞进 ledger 就成了账（见上一条）；塞进 `shared` 表则是"用别人的 schema 存无关数据"。
  单独一张 append-only 表最省事，并且**它不参与任何库存计算**（`knownStockOf` / `reservedQtyOf`
  都不读它）—— 这保证"审计失败不影响业务"（`audit()` 内部 catch 掉写失败）。
- **schema v4→v5**：四张表都是 `CREATE TABLE IF NOT EXISTS`，老库里一行都没有 ⇒
  迁移无回填、无丢数据（与 v3/v4 同一条路）。`openBoard` 本来就无条件写 `user_version`，不需要改。

## 2. 预占：为什么"读-判断-写"必须在一个 `BEGIN IMMEDIATE` 里

D7-2 的判据是 `已预占 + 请求量 <= 已知库存`。这三步拆开就是经典 check-then-act：

```
A: 读到 reserved=0, known=10        B: 读到 reserved=0, known=10
A: 0+6 <= 10 → 插入 6               B: 0+6 <= 10 → 插入 6        ⇒ 预占 12 > 库存 10（超卖）
```

本仓的单测是**单线程**的，光"顺序调两次"抓不到这个 bug（第二次会读到 6，自然拒）。
所以 `tools/inventory_ledger_unit.mjs` 的用例 ② 换了个办法**制造真实的交错**：

1. 用 `node:sqlite` 在**同一个库文件**上开第二条连接（另一个写者，`busy_timeout=30`）；
2. 用一层薄薄的 db 代理，把 `prepare('INSERT INTO inventory_reservation …')` 的 `run()` 包住，
   在真正插入**之前**让第二条连接试一次 `BEGIN IMMEDIATE` + 插入 6 个 + `COMMIT`；
3. 断言：第二条连接**被挡**（`blocked=true`，SQLITE_BUSY）、我方预占成功、库里只有我方 6 行。

这条用例的"能红"是**实测**过的：把 `reserveStock` 里的 `runInImmediateTx(...)` 摘成裸调用
（`((body) => body())(...)`），第二条连接就插进来了，最终库里 `total=12 > known=10`，
用例 ② 立刻 FAIL（`raced=true`）。改回去 13/13 全绿。
这正是"**放开事务校验应立刻红**"那条验收。

另外两条细节：

- `voidExpired()` 在**同一个事务里**先跑：过期的券当场作废，额度回到可用池。
  "过期"因此不需要守护进程才能生效 —— 任何一次预占/结算/对账/快照都会顺带清理；
  定时扫描（`board_server` 的租约扫描）只是让"没人访问"时也能清，**不是唯一入口**。
- `reserveStock` 对访客**根本不进事务**：不写 reservation，只读一份 `known/reserved` 给调用方提示，
  再写一行 `inventory_audit`。理由见 §5。

## 3. 结算：账本 id 就是幂等键

`settleTake()` 在同一个事务里做三件事：写 `inventory_ledger`、把预占改成 `consumed`、扣缓存。

- **账本 id 固定为 `<reservationId>:take`**。重复结算时先看 `status`：
  - `consumed` → 直接返回 `already=true` + 第一次那条账本行（**不重复扣**）
  - `void`（过期作废）→ `RESERVATION_EXPIRED`
  - `held` → 正常结算
- **实际取用 ≤ 预占量**：超过就 `TOO_MUCH`（"预占 5，实际取 9" 是调用方的 bug，
  也可能是有人顺手多拿了 —— 两种情况都不该由本层替它编账）。
  取用小于预占是允许的（开箱后发现只够 3 个）：未用掉的额度随 `status='consumed'` 一起释放。
- **同事务扣缓存**：`container_cache` 是"最近一次观测"，一次**已知的**取用当然要扣掉，
  否则下一次对账会把这次取用再算一遍（双重扣减）。所以 `settleTake` 接受 `container:{x,y,z}`：
  缓存缺行时 `cache.applied=false`（**不凭空造一行 0**，否则等于把"没观测过"伪造成"观测到 0"）。
- `dirty` **不在结算时清掉**：本来就"不确定"的缓存，扣一次已知移动也不会变确定。
  只有开箱强刷（`refreshContainerCache`）会清脏。

## 4. 对账：为什么它是必选项，以及"以真实为准"到底改了什么

没有对账，`container_cache` 会永远停在最后一次开箱那一刻：别人手拿、漏斗、区块卸载、
甚至别的 bot 直接破坏方块，都不会进账本。D7 把对账列为**必选**就是因为
"账实分叉不可观测"比"账有点旧"严重得多 —— 前者会让预占基于幻觉库存放行。

`reconcileContainers(db, {observations:[{x,y,z,items}]})` 的口径：

1. 对每个观测到的容器，算出 `delta = 真实 - 缓存`（逐物品）；
2. **有差异**才写：一条 `inventory_ledger(reason='reconcile', delta)`，并把缓存改成真实（清 `dirty`）；
3. **账实一致**的容器不写任何行（连 `updated_at` 都不动）—— 对账必须能**反复跑而不制造噪音**；
4. 返回可读差异报告：`lines` 形如 `箱子(10,64,-3)：oak_log 账 57 → 真 50（修正 -7）`，
   另有 `diffs`（结构化）、`summary`（一句话）、`warnings`；
5. **预占超过真实库存**不自动撤销：别人的券可能正拿着在开箱，撤销它是替别人做决定。
   但报告里必须点名（`⚠ oak_log：已预占 8 个超过真实库存 5 个`），这是"对账发现问题，
   人工确认"而不是"对账替人平账"。这条写在这里，因为它是**唯一**没被自动修掉的分叉。

`dryRun=true` 只算不写（面板/排障先看一眼）。单测 ⑦ 断言：dryRun 后缓存仍是 57；
正式跑写 2 条修正（oak_log -7、stone -5）且缓存变成 `{oak_log:50}`；再跑一次 `changed=0, written=0`。

## 5. 访客：不写本机账本（D7-6），但"谁是访客"不能由客户端说

- 访客的 bot 是**别人机器上的代码**（ADR D9）。它的活动属于**它自己的存档**，
  写进本机账本就会让房主的库存账被外部行为污染。
- 因此访客路径只做两件事：写 `inventory_audit` 一行审计；如果这次取用点了名某个容器，
  就把该容器 `dirty=1`（内容已经不可信，下一次房主开箱会强刷）。
- **关键**：`payload.visitor` 一律**忽略**。判定只认 `attachBoardServer({ isVisitor })` 的注入
  （阶段 4 由访问凭证/peer 判定接上）。客户端自己说"我是访客"就等于自己给自己免账，
  反过来"我不是访客"就等于可以写别人的账 —— 两种都必须是服务端说了算。
  在此之前 `isVisitor` 默认 `false`，即**生产上没有连接会被判成访客**（诚实边界）。
- 单测 ⑧ 走 store 层、单测 ⑫ 走 socket 层（一个连接注入 `isVisitor:()=>true` 并**故意**在
  payload 里发 `visitor:false`）都断言：reservation 0 行、ledger 0 行、audit 有行。

## 6. 与既有"共享箱子记忆"的关系（不是第二本账）

`shared(kind='chest')`（B4 / T31）是**跨 bot 的箱子内容记忆**，`container_cache` 是
**库存计算用的最近观测**。两者都必须与真实箱子一致，但职责不同：

| | `shared(kind='chest')` | `container_cache` |
|---|---|---|
| 谁写 | `rememberChest` → `sharedMerge`（存/取成功后按增量） | 开箱强刷（真实内容）、结算扣减、标脏 |
| 谁读 | `findItemInSharedChests`（"哪里有这个东西"） | `reserveStock` 的"已知库存"、对账 |
| 语义 | 记忆（可以旧） | 库存判据（预占按它算） |

`flow_store.js` 本批（fixes4 接线 t4）的改动：`ensureOpen()` 成功后把窗口里的真实内容刷进
`container_cache`；`fetch` 某一箱没取全时调 `inventoryMarkDirty`；
**`opts.shared === true` 时另外走"预占 → 取用 → 结算"**（见 §8-2 与 [wiring-flow.md](wiring-flow.md)）。

## 7. 真实接线（socket / client）

九个事件，全部与队伍事件同一口径（身份只认 `actingBot`，存档只认 `worldIdOf` 注入，
解析不出 ⇒ `NO_BOARD`）：

```
inventory:reserve       {item,qty,ttlMs,containers}        → reservation{id,expiresAt,known,...}
inventory:settle        {reservationId,qty,container}      → {already,ledger,reservation,cache}
inventory:release       {reservationId,reason}             → {already,changes,closed,reservation,ledger}（券回池，delta=0 留痕）
inventory:store         {item,qty,chestKey?,observed?}     → {ledger(reason='store'),cache}（存入记账；observed 走 D7-1 强刷）
inventory:cache-refresh {x,y,z,items}                      → 开箱强刷（清 dirty）
inventory:mark-dirty    {x,y,z,reason}                     → dirty=1
inventory:reconcile     {observations,dryRun}              → {diffs,lines,summary,warnings}
inventory:snapshot      {item?}                            → {items:[{item,known,reserved,available}], containers, reservations}
inventory:ledger        {item?,limit}                      → 最近账本行
```

对账的"真实内容"只能由客户端上报（服务端不自己开箱），所以它**必须可归因**：
`inventory:reconcile` 的 `holder` 只取服务端裁决的身份（`payload.holder` 忽略），
账本里记的就是"谁报的这次账"。同理 `payload.visitor` 也被忽略（见 §5）。

`board_client.js` 对应 `inventoryReserve / inventorySettle / inventoryStore / inventoryRelease /
inventoryCacheRefresh / inventoryMarkDirty / inventoryReconcile / inventorySnapshot / inventoryLedger`；
`makeNullBoard()` 一样全给"没有任务板"的失败默认值 —— **不假装预占成功**，
否则调用方会真的去搬东西。

错误码：`INSUFFICIENT_STOCK` **不在** `contract.CODES` 里（它是库存域的码），
所以两件事都做了：① 服务端用**具名常量** `INVENTORY_RESULT_CODES`（字面量会被 preflight
判成"未注册错误码"）；② 客户端 `BOARD_CODE_TO_CONTRACT` 把它映射成 `NO_ITEM`
（对 agent 的语义就是"箱子里没那么多"），原始码保留在 `data.boardCode` 里，诊断不丢信息。

## 8. 没做到的（诚实边界，复核请按这几句看）

1. **"谁是访客"没有生产判定**：`isVisitor` 注入点已就位，默认恒 `false`。
   真正接上要等阶段 4 的访问凭证（`visit_grants`）—— 在那之前**访客行为会按本地 bot 记账**，
   因为系统根本不知道它是访客。
2. ~~**存取流程还没接预占/结算**~~ → **已闭合（2026-11-13，接线 t4）**：
   `flow_store.fetch` 在调用方显式传 `opts.shared === true` 时走**预占 → 取用 → 结算**，
   一件都没取到就当场还券（新增 `releaseReservation` + `inventory:release`），
   拿不到预占就**一件都不取**。不传 `opts.shared` 的路径逐字未变（`!do store/fetch` 与真机 E2E 依赖它）。
   为什么仍是 opt-in：`flow_store` 拿不到"这次取的是共享库存"这个意图，判定权必须留在调用方。
   存入侧同样入账：`inventory:store` → `ledger(reason='store', delta=+qty)`（`stockIn()`，与 `settleTake` 对称），
   与对账的 `reason='reconcile'` **严格分开** —— 否则「对账修正了多少货」这个问题会静默变错。
   落地细节、仍存的边界（结算只扣一个容器的缓存）见 [wiring-flow.md](wiring-flow.md)。
3. **预占没有"整队共享"语义**：预占是 holder 个人的（`holder` = 服务端裁决的 bot 名）。
   队伍共享仓目前只共享**坐标**（`team_chest`），不共享"券"。要不要把券记在队上，
   等 D12（组队需双方同意）落地后一起定。
4. **脏缓存的"已知库存"仍是估算值**：`dirty=1` 只表示"下一次开箱必须强刷"，
   `knownStockOf` 仍然读它（否则一次失败取用就会让整个物品再也预占不到）。
   口径：脏 = 请尽快开箱；不是"库存归零"。
5. **对账不自动撤销超额预占**（见 §4-5）：只报告，不替人平账。
