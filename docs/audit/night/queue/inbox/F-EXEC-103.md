id: F-EXEC-103
severity: medium
class: race
file: mindcraft/src/agent/library/skills.js:1476,1512
evidence: |
  箱子存取的"成功"是按**意图值**算的，不是按容器/背包的实际差算的：
    :1476  export async function putInChest(bot, itemName, num=-1) {
    :1498      let to_put = num === -1 ? item.count : Math.min(num, item.count);
    :1500      await opened.container.deposit(item.type, null, to_put);
    :1501      log(bot, `Successfully put ${to_put} ${itemName} …`);
    :1503      return true;                         ← deposit 不抛就 return true
    :1512  export async function takeFromChest(bot, itemName, num=-1) {
    :1550      await chestContainer.withdraw(item.type, null, toTakeFromSlot);
    :1551      totalTaken += toTakeFromSlot;       ← 累加的是"打算取多少"
    :1558      return totalTaken > 0;
  对照物（同一代码库里的正确做法，作者已写过三遍）：
    `act_container.deposit:369-404` / `withdraw:434-466` —— `invBefore/winBefore` →
    `waitCountsSettled` → 比对 `invAfter/winAfter` 三个历史 bug 都写在注释里。
  本条属 00-REPORT 第 20 条「同一规则给出不同答案」12 条分叉表的残留项：
  第 20 条已修 3 处（`isSafeHere` / `canReach` / `waitUntil`）+ `loadFurnace` 的 OCCUPIED、
  `breakBlockAt`、`attackNearest/attackEntity`；**`takeFromChest` / `putInChest` 这 2 条没动**。
  出处：docs/audit/00-REPORT.md 第 20 条 + 第 七 节「有正确解法却没抄」表第 3 行；
  复核记录见 docs/audit/17-review-r1-verdict.md §2 第 20 条（"部分修好"）、
  docs/audit/21-review-r2-verdict.md §2 #3（"三处分叉改薄包装"，未含本条）。
  本轮在当前代码复核：**仍存在**（`return totalTaken > 0` 与 `return true` 逐字未变）。
exploitability: |
  不是远程攻击面，是**数字不可信**导致的连锁：
  ① 两个 bot 共用仓库时（`flow_store` 的共享箱已改成服务端原子合并，见第 16 条），
     但**单个 bot 的 `takeFromChest` 仍按意图计数** —— 箱子被别人同时取走一部分时，
     `withdraw` 可能只成功一部分甚至抛错，函数仍可能报"取到了"；
  ② 上层（`strat_obtain.js` 按板库/记忆算材料）据此认为"背包里有 5 个石头"，
     实际只有 2 个 → 后续合成单必然失败，且失败点离根因很远（报 `NO_MATERIAL` 而不是"取箱子没取到"）；
  ③ 反向：`putInChest` 报成功但物品还在背包 → 下次"清空背包"任务再存一遍，
     箱子账目虚高、板库分配（`allocated` 账本）算出"材料够"→ 派单后做不出来。
  影响半径：材料/仓储链上的所有下游判断（第 16/22/S40 同一族）。
suggested_fix: |
  两处都改成"前后差比对"（与 `act_container` 同口径），不新增依赖：
  ```js
  // putInChest
  const before = countInventoryItem(bot, itemName);       // 本文件已有同名工具，见 :3426 附近用法
  try { await opened.container.deposit(item.type, null, to_put); } catch (e) { … return false; }
  await waitCountsSettled?.(…) // 若无此工具，退化为 sleep(100) 后读一次
  const after = countInventoryItem(bot, itemName);
  const moved = before - after;
  log(bot, `put ${moved}/${to_put} ${itemName}`);
  return moved > 0;
  ```
  `takeFromChest` 同理：`totalTaken` 换成 `countInventoryItem(after) - countInventoryItem(before)`。
  注意：`deposit/withdraw` 的第二参 `null` 表示"任意 NBT"，保持不变。
verify: |
  cd mindcraft
  # 静态：不再有"意图值直接当结果"的写法
  grep -n "totalTaken += toTakeFromSlot" src/agent/library/skills.js     # 期望 0 命中
  # 行为（假 bot 单测，可放进 tools/ 现有 *_unit.mjs 风格）：
  #   构造 deposit 只成功一半（容器满）→ putInChest 必须返回 false 或 moved < to_put 的日志
  #   构造 withdraw 抛错 → takeFromChest 必须返回 false
  node tools/unit_all.mjs 2>&1 | tail -5                                # 与基线一致（无新增失败）
discovered_by: patch-smith(from history)
dept: D3-EXEC
