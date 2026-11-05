id: F-EXEC-105
severity: medium
class: race
file: mindcraft/src/agent/library/executor.js:686-693
evidence: |
  "走完 x/z 但高度不够"这条路上，补垫高失败后仍然把 `moveToXZ` 的 ok 当结果返回：
    :686      // 走完还差高度 → 再补垫高（pathfinder 只管水平，不管垂直）
    :687      if (r.ok && Math.floor(bot.entity.position.y) < targetFeetY - 1) {
    :688          let guard = 0;
    :689          while (Math.floor(bot.entity.position.y) < targetFeetY && guard++ < 6) {
    :690              const up = await stepUp(bot, { onEvent });
    :691              if (!up.ok) break;            ← 垫高失败只 break，不记账
    :692          }
    :693      }
    :694      return r;                              ← r 是 moveToXZ 的 ok（true）
  也就是说：目标在 3 格高台上、背包里没有垫脚方块（`stepUp` 第一步就 `fail('NO_ITEM','没有可垫脚的方块')`），
  函数照样 `return r`（ok:true）。同文件的**上方**判据（`:669-684`）只覆盖"走过头了（y 太高）"
  那一种，走不到位这一种没有对称处理 —— 与该文件 `digdown` 分支修过的 `HEIGHT_MISS` 判据是同一个思路，漏了这支。
  出处：docs/audit/08-deep-executor-flows.md §1.1 表 **F2**（"没到目标高度却报 ok。`stepUp` 最常见的失败是
  `NO_ITEM 没有可垫脚的方块`"）；12 分册 §6.2 复核"维持"；**该条从未进 00-REPORT 34 条编号**
  （docs/audit/21-review-r2-verdict.md §4.3 记为"≈68 条不可追溯"之一）。
  本轮在当前代码复核：**仍存在**（`:686-694` 逐字如上）。
exploitability: |
  不是安全洞，是**失败语义**问题，但后果落在"她卡住了却报成功"：
  ① 上层 `step_runner` 只看 `r.ok` → 该步记成功 → 继续下一步 → 下一步的坐标基于"已经在这一层"计算
     → 后续每步都失败，最终报的错误点是最后一步，根因（没有垫脚方块）被埋；
  ② 任务板视角：这张单"跑完了"（finish 按 ok 走 done），世界状态没达成 → `convergeOrphanParents`
     与 `rollupParent` 都认为顺利，面板显示成功。
  影响半径：所有需要垂直位移的导航（挖上去、垫高、上台阶），并且它与 F-EXEC-106 一起把
  "失败 → 成功"的伪装做完整。
suggested_fix: |
  `:688-693` 补一个与 `:669-684` 对称的终局判据：
  ```js
  if (r.ok && Math.floor(bot.entity.position.y) < targetFeetY - 1) {
      let guard = 0, lastErr = null;
      while (Math.floor(bot.entity.position.y) < targetFeetY && guard++ < 6) {
          const up = await stepUp(bot, { onEvent });
          if (!up.ok) { lastErr = up; break; }
      }
      if (Math.floor(bot.entity.position.y) < targetFeetY - 1) {
          return { ok: false, code: lastErr?.code ?? 'HEIGHT_MISS',
                   message: `该上到 y=${targetFeetY}，实际停在 y=${Math.floor(bot.entity.position.y)}` +
                            (lastErr ? `（垫高失败：${lastErr.message ?? lastErr.code}）` : '') };
      }
  }
  ```
  **不要**把 `stepUp` 的失败改成"继续 try 6 次"以外的东西；`guard++ < 6` 的上限保留（那是防死循环的）。
verify: |
  cd mindcraft
  # 行为（假 bot，可进现有 executor_*_unit.mjs）：
  #   目标在 y+3、背包清空 → climbByTunneling/climbTo 必须返回 ok:false 且 code 为 NO_ITEM 或 HEIGHT_MISS
  grep -n "HEIGHT_MISS" src/agent/library/executor.js | wc -l     # 改后期望 ≥2（上下两种方向各一）
  node tools/unit_all.mjs 2>&1 | tail -5                          # 与基线一致（无新增失败）
discovered_by: patch-smith(from history)
dept: D3-EXEC
