# flow_store 接预占：先预占 → 取用 → 结算（opt-in）

> R6 / fixes4 · 接线 t4（wire-flow）· 2026-11-13
> 交付：`mindcraft/src/agent/library/flow_store.js`（opt-in 共享路径）、
> `board_inventory.js`（`releaseReservation` + `stockIn` + 结算文案）、
> `board_server.js`（`inventory:release` / `inventory:store` 两个 handler；**都不写 events**）、
> `board_client.js`（`inventoryRelease` / `inventoryStore` + 无板默认值）、
> `mindcraft/tools/wiring_flow_reserve_unit.mjs`（11 条，六条"能红"实测见 §5）。

## 0. 一句话结论

`flow_store.fetch/store` 现在能在**调用方显式声明 `opts.shared === true`** 时走
「预占 → 真取 → 结算（取到多少结多少）」，一件都没取到就**当场还券**（额度立即回池）；
拿不到预占就**一件都不取**。不传 `opts.shared` 的路径**逐字未变**（`!do store/fetch` 与
真机 E2E chest 30/30 都走那条路）。

`inventory.md` §8-2 那条"存取流程还没接预占/结算"到此闭合。剩下的诚实边界在 §6。

## 1. 为什么必须 opt-in（而不是"共享库存一开就默认预占"）

`flow_store.store/fetch` 有**两类**调用方：

| 调用方 | 语义 | 能不能预占 |
|---|---|---|
| `!do store` / `!do fetch`（`commands/actions.js`）、真机 E2E `e2e_chest_store_live` | 单人存档里的"搬东西"，箱子是**自己的** | 不能：没有"共享库存"这回事，预占会凭空要券 |
| 调度/任务单分配库存 | 箱子是**全队共享**的，多个 bot 抢同一批材料 | 必须：否则账实分叉只能靠对账追平 |

`flow_store` 自己**看不出**这次取用属于哪一类（`inventory.md` §8-2 的原话就是
"它拿不到'我要取的是共享库存'这个意图，也不该由它决定"）。所以判定权留在调用方：
**显式传 `shared: true` 才走板**，其余一律老路。这条同时保证"不改变原有非共享行为"是可测的
（用例 ⑥ 直接给 `inventoryReserve/Settle/Release` 打桩计数，必须为 0）。

## 2. 取用路径：预占 → 取 → 结算

```
reserveStock(item, want, containers=附近箱子)
  ├─ 失败 ──────────────────────► 一件都不取，回 NO_ITEM + boardCode=INSUFFICIENT_STOCK
  └─ 成功(券 id)
        ↓ 真取（走的是**原来那条 fetchLocal**，一个字没改）
     taken = 实际取到的数量（服务端真值/客户端报数，沿用 T38 的修正）
        ├─ taken > 0 ─► settle(taken)   ← 未用掉的额度随 consumed 一起回池
        └─ taken = 0 ─► release(券)     ← 一件没取到 ⇒ 当场还券，不等 TTL
```

三个细节，都是踩过才知道的：

1. **结算量取"实际"，不取"预占量"**。开箱后发现只够 3 个是常态；结 3 而不是结 5，
   剩下 2 个额度随 `status='consumed'` 一起回池（`settleTake` 已保证幂等与 ≤预占量校验）。
   用例 ③ 就钉这条：预占 6、实取 2 ⇒ 券 `consumed_qty=2`、账本 `-2`、**下一个 bot 立刻能占到 8**。
2. **结算失败不能改写成"取用成功且已记账"**。物理上已经搬走了、账却没落 ⇒ 调
   `inventoryMarkDirty` 把容器标脏（否则下一次对账会把这次取用**再扣一遍**），
   结果里如实带 `settled:false, settleCode`，**但取用本身的成败照原样返回**。
3. **释放失败不许盖掉取用失败的真实原因**。`withReservation()` 只做数据合并：
   `code/message` 永远是取用那条（例如 `NO_ITEM`），券的收尾情况放在
   `data.released / releaseCode / releaseReason / settled / settleCode` 里。
   调用方在失败路径上看到的必须是"为什么没取到"，不是"为什么没还上券"。

## 3. "拿不到预占就不取"——以及为什么先补一次"只看不搬"的观测

`reserveStock` 的判据是 `已预占 + 请求量 <= 已知库存`，而"已知库存"来自
`container_cache`（**最近一次开箱看到的东西**）。从没被观测过的箱子 ⇒ 已知 0 ⇒
预占一律被拒（D7 的"未知即 0，宁可拒单也不超卖"）。

如果直接把这个"拒"回给调用方，共享取用会在**第一次开箱前永远不可用** —— 功能等于没接。
所以 `fetchShared` 只在**一个特定条件下**多走一步：`INSUFFICIENT_STOCK` 且 `known === 0` 时，
先 `observeContainers()`（逐个开箱 → `inventoryCacheRefresh` 刷缓存 → 关窗，**一件都不搬**），
然后**重新预占一次**。

- 只看不搬：观测过程没有任何 `withdraw`，物理守恒（用例 ⑤ 的箱子 7→4 与背包 0→3 对得上）。
- 只试一次：第二次还是 `INSUFFICIENT_STOCK` 就照直拒，不做循环、不降级成"先取了再说"。
- `known > 0` 时不触发：已知库存够了却因为已预占满而拒，那说明**确实没货**，再开箱也是白开。

## 4. 还券（`releaseReservation`）：为什么"立刻回池"是硬要求

D7 原本只给了三种券的终态：`held` / `consumed`（结算）/ `void`（过期）。**没有"我还回去"**。
后果在"一件都没取到"这个分支上最刺眼：券会一直占着额度到 TTL（默认 5 分钟）。
几十个 bot 抢同一批材料时，"白占 5 分钟"就等于"明明有货却领不到"。

`releaseReservation(db, { worldId, id, holder, reason, now })`：

- **只释放自己持有的券**：`UPDATE ... WHERE id = ? AND holder = ? AND world_id = ? AND status = 'held'`。
  三条判据**全压在 SQL 的 WHERE 里**（不是先查再判断）——少写一条就是放行别人的券。
  变更行数为 0 时才回查一次，用来区分三种"没改动"：
  `不存在` → `NO_TARGET`；`别人的券` → `NO_PERMISSION`；`已是 released/consumed/void` → **幂等 ok**。
  这样"失败路径上调它"不会二次炸（本单的要求），而越权仍然是明确的错。
- **终态用 `released`，不蹭 `void`**：`void` 的语义是"过期作废"，两者在面板/排障时要说得出区别。
  代价是 `settleTake` 的文案要分开（已同步改成"过期作废 / 已被释放"两句话，用例 ④ 只断言码，不受影响）。
- **写一行 `ledger(reason='release', delta=0)`**：释放**不是**物理移动，所以 delta 必须是 0；
  但"占过又退了"必须在对账/面板里看得见（否则账本上只剩 preemption 的痕迹，看不出它被撤回）。
  这与 `inventory.md` §1"账本只记物理移动"的口径有一处**有意偏离**：那一句的本意是
  "别让账本混进 delta 非零的事件行"，而 delta=0 的 release 行不参与任何求和
  （`knownStockOf` / `reservedQtyOf` 都不读 ledger），因此不会污染"账本 = 物理移动"的求和口径。
  复核时按这条看：**release 行必须 delta=0，且不参与库存计算**。
- **额度立即回池**：券从 `held` 变成 `released`，`reservedQtyOf`（只数 `held`）当场变小，
  下一次 `reserveStock` 立刻能占到。用例 ④ 用"箱内 4 / 请求 4"这种**刚好用满**的量来钉：
  券不回池 ⇒ 下一单一个都占不到（实测报 `已知 4、已预占 4、可用 0`）。

## 5. 三条反向验证（实测"能红"，都跑过）

| 改成什么 | 期望 | 实测 |
|---|---|---|
| `releaseReservation` 的 WHERE 去掉 `AND holder = ?`（并把参数一起去掉） | 别的 bot 能释放我的券 ⇒ 用例 ⑦ 红 | **红**：`steal.ok=true, changes=1`，券被别人 `released` |
| 释放只写账本、`status` 不动（等价"只在 TTL 才回池"） | 用例 ④ 的"另一个 bot 立刻能占到"红 | **红**：下一单报 `已知 4、已预占 4、可用 0` |
| `fetchShared` 在预占失败时继续取（"先取了再说"） | 用例 ② 的物理守恒断言红 | **红**：返回 `ok:true/taken:2`，箱子 2→0 |
| `isShared` 改成默认开启（`opts?.shared !== false`） | 用例 ⑥ 的"非共享不碰板"红 | **红**：`calls=["inventoryReserve","inventorySettle"]`，结果里多出 `shared/settled` |
| `stockIn` 的 reason 写回 `'reconcile'` | 用例 ⑨ 的"正常存入不许产出 reconcile 行"红 | **红**：`reconcile` 行数 0 → 1（`reason=reconcile, delta=+4`） |
| `reconcileContainers` 改成"无差异也写行"（伪造 delta=0） | 用例 ⑩ 的"对账可重复跑不制造噪音"红 | **红**：账实一致跑两次 ⇒ `written=1,1`、`rowsAfterSame=2` |

还原后 9/9 全绿（每次都是改完立刻跑、跑完立刻还原，`git diff` 核对无残留）。

用例 ③（部分取用结实际量）与 ⑤（观测后重试预占）**没有**单独做反向验证，如实说明：
把它们改坏（结预占量 / 去掉观测重试）时用例会在**别的断言**上先红（`consumed_qty` / `taken`），
红点不唯一 ⇒ 说不清"这条到底在守什么"，所以只保留上表这四条红点唯一的。

## 6. 诚实边界（复核请按这几句看）

1. **存入的账本 reason 是 `store`（captain 裁决后已改，原实现是 `reconcile`）**。
   首版为省一次事件，存入后用 `inventory:reconcile` 把"真实 − 缓存"的差额写进账本 —— 效果对，**语义错**：
   `reason='reconcile'` 的意思是"账实不符、以真实为准修正"，正常存入混进去会让
   「对账修正了多少货」这个问题的答案**静默变错**（数字看着正常，这正是这批反复在防的那类问题）。
   现在补了 `stockIn()`（`settleTake` 的对偶，写 `delta=+qty, reason='store'`）与 `inventory:store` handler，
   `flow_store` 的 shared 分支改调它；缓存仍然只按**观测**强刷（D7-1），账本绝不用数字去加减缓存。
   反向验证：把 `stockIn` 的 reason 写回 `'reconcile'` ⇒ 用例 ⑨ 立刻红（`reconcile` 行数 0 → 1）。
2. **`release` 事件（`inventory.rollback`）不归本单**。captain 2026-11-13 分工：handler 由 t4 插，
   事件由 t2 在 handler 里写。现在那一行已经由 t2 加在 `inventory:release` 的 ack 之后，
   本单**没有**任何 events 写入。
3. **结算的缓存扣减只认一个容器**。`settleTake` 的 `container` 只接受一个坐标，而一次取用可能跨多个箱子；
   本单传"最后取到的那个箱子"（`r.data.chest`），其余箱子的缓存由下一次对账修正。
   影响面：`container_cache` 可能短暂偏高（不是偏低），预占因此偏保守，不会超卖。
4. **访客路径不结算也不释放**。服务端判定的访客在 `reserveStock` 里就返回 `skipped:true, id:null`
   （只留审计不落券），所以 `fetchShared` 直接用 `visitor` 标记短路：不拿空券去 settle/release
   （否则每次访客取用都会多一条 `NO_TARGET` 噪音）。用例 ⑧ 断言"物理照常取 2、券 0 行、账本 0 行、只留审计"。
5. **`opts.shared` 只是"意图声明"，不是权限**。它只能让调用方**多走一道预占**，
   不能让它绕过服务端裁决（`holder` 永远是服务端从连接身份推出来的，`payload.bot` 只在一致性校验里用）。
6. **非共享路径的"零变化"是逐字保证**：`fetch` 只是把原实现原样搬进 `fetchLocal`，
   多出来的唯一动作是 `if (isShared(opts))` 的分支判断；`store` 只在 `shared` 为真时才多调
   `recordStoreLedger`。用例 ⑥/⑨ 对"不传 shared 时板方法调用数为 0 / 不写账本 / 结果字段不多不少"做了断言。
