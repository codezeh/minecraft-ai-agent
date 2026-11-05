id: F-EXEC-104
severity: low
class: race
file: mindcraft/src/agent/library/skills.js:1348-1396
evidence: |
  `skills.equip` 不看 `bot.equip` 的结果、不查中断，函数末尾无条件 `return true`：
    :1348  export async function equip(bot, itemName) {
    :1362      let item = bot.inventory.slots.find(slot => slot && slot.name === itemName);
    :1363      if (!item) { … else { log(bot,`You do not have any ${itemName} to equip.`); return false; } }
    :1373      if (itemName.includes('leggings')) { await bot.equip(item, 'legs'); }
    …          （helmet/boots/chestplate/shield/hand 六条同形，全部不查返回值）
    :1396      log(bot, `Equipped ${itemName}.`);  return true;    ← 只要没抛异常就 true
  同族对照（作者写对的那份）：`act_equip` 会做"装备位上现在是什么"的读回验证；
  `act_dig.canDigReason:189-256` 还把"读不到"与"没有"分成三态并留了真机事故注释。
  本条属 00-REPORT 第 20 条 12 条分叉表的残留项（同 F-EXEC-103）：
  第 20 条修复清单只做了 `isSafeHere` / `canReach` / `waitUntil` 三处 + 顺手 3 处，
  **`equip` 未动**；00-REPORT §六 表格把它列为"不查中断/不验证"。
  出处：docs/audit/00-REPORT.md 第 20 条 + §七 表第 2 行；§六 四类恒真判断相邻族。
  本轮在当前代码复核：**仍存在**（`:1348-1396` 六条 `bot.equip` 全无返回值检查）。
exploitability: |
  实际危害偏低（mineflayer 的 `bot.equip` 失败通常抛异常 → 调用方拿到异常而不是 false），
  所以严重度按 low 记。真实后果是两类：
  ① **中断不可达**：`!stop` 之后 equip 这条路径没有任何 `interrupt_code` 检查，
     切装备虽快，但在"连续切 9 次工具"的 `prepareForDig` 这类循环里会累积成秒级不可中断；
  ② **"读不到 ≠ 没有"**：`bot.inventory.slots.find` 在背包尚未同步（刚登录/刚死亡重建）时返回
     undefined，函数报"You do not have any X"并 `return false` —— 这与 `act_dig.canDigReason`
     记录的"死亡后背包重建被误判 NO_TOOL → 单子 blocked"是**同一个坑**，只是这里连三态都没有。
  影响半径：单个 bot 的工具链失败诊断（把"还没同步"说成"没有工具"），会误导上层派单。
suggested_fix: |
  三点，都不要动签名：
  ① 每条 `await bot.equip(item, slot)` 后读回：`const held = bot.heldItem?.name === itemName`（或 armor 位
     `bot.inventory.slots[5..8]`），不成立就 `log(bot,'FAILED'); return false;`。
  ② 循环入口加 `if (bot.interrupt_code) { log(bot,'被取消'); return false; }`（与 `act_equip` 同形）。
  ③ `!item` 分支区分"读不到"与"没有"：先 `await bot.waitForTicks(1)`（或 sleep(100)）再查一次，
     仍没有才报 NO_ITEM；这一条能直接消掉"死亡后误判"的历史事故形态。
verify: |
  cd mindcraft
  grep -n "await bot.equip" src/agent/library/skills.js | wc -l      # 现状 6
  # 改后应每一条都有对应的读回/返回判断（人工核对 6/6）
  # 行为：假 bot 让 equip 成功但装备位不变 → 必须返回 false
  node tools/unit_all.mjs 2>&1 | tail -5                             # 与基线一致
discovered_by: patch-smith(from history)
dept: D3-EXEC
