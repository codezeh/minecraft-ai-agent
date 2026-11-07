# T7 · BOT-009 `stored` 多报在途物品 —— 修复与真机验证（2026-11-07）

> 成员 `game-probe` 完成实现与真机矩阵后**被上游 502 中断**。代码与矩阵结果均在盘上，
> 本文结论由 **Lead 复核**（重跑门禁与单测、逐条读矩阵断言）。

## 1. 缺陷回顾（修复前）

真机 3/3 稳定复现：箱只剩 3 空位、存 10 把铁剑 ⇒ 返回 `stored=4`，真实只有 3 件进箱。
根因：`act_container.js` 用「**任一边变了就返回**」的收敛判据 + 取「背包减少量」当已存数，
而在途物品**已离开背包、尚未进箱**，只存在于 `win.selectedItem`（容器光标）上。

## 2. 改法

| 新增 | 作用 |
|---|---|
| `cursorCount(bot, name)` | 统计容器光标上的在途件数 —— 这是唯一能看见"第 4 把剑"的地方 |
| `settleTransferCounts(bot, name, …)` | 收敛判据改为「**连续两次读数完全相同，且光标为空**」，不再"动一下就返回" |
| `measureStored(...)` | 存物口径：容器增量优先 → 扣在途 → 容器未刷新才回退背包口径 → `take` 封顶；回传 `consistent/settled/cursorAfter` |
| `measureTaken(...)` | 取物口径，`measureStored` 的镜像；额外算 `cursorReturned`（在途件是否退回背包） |

调用点：存物 `:580`/`:602`，取物 `:722`/`:744` —— 四个都换成 `settleTransferCounts`（修复前只有两处且都是旧判据）。

## 3. 真机矩阵 6/6 全过（`result-matrix.json`）

| 场景 | 返回 | 真实账单 | 断言 |
|---|---|---|---|
| deposit partial | `INVENTORY_FULL`, `stored=3`, `cursorAfter=1` | 背包 10→7、箱 +3 | `storedMatchesRealChest:✅`，守恒 10 |
| deposit full | `OK`, `stored=10` | 10→0、箱 +10 | `noUnderReport:✅`，守恒 10 |
| withdraw partial | `INVENTORY_FULL`, `taken=3` | 背包 +3、箱 10→7 | `takenMatchesRealInv:✅`，守恒 10 |
| withdraw full | `OK`, `taken=10` | +10、箱 →0 | `noUnderReport:✅`，守恒 10 |
| flow store partial | `stored=3` | 背包 10→7、箱 +3 | 与 T2 口径一致 |
| flow fetch partial | `taken=3` | +3 / 箱 −3 | 一致 |

**关键细节**：`cursorAfter=1` 说明修复后的代码**看见了**那把在途剑（旧代码看不见），并正确扣除；
每条 `conservationAfterClose = 10` 说明关窗后总量守恒，没有物品凭空消失。

## 4. Lead 复核

| 项 | 结果 |
|---|---|
| `npm run gate` | **exit 0**（含 dockerignore 62 项、lint:hard 172 文件 0 违规） |
| `node tools/unit_all.mjs` | **119/119 通过**（4 个需真机数据的跳过，属已知项） |
| 对称性 | 存物/取物两方向都有 `measure*` 口径，且都覆盖 partial + full |
| 未修过头 | full 场景 `stored=10` / `taken=10`，无少报 |

## 5. 相关但未在本任务范围

- `flow_store.js` 的「跨箱累计」分支：本任务未改，T7 矩阵里 `flow store partial`/`flow fetch partial`
  走的是单箱路径，结果正确；多箱累计仍需单独构造验证（T2 §3.4 已记为未覆盖）。
