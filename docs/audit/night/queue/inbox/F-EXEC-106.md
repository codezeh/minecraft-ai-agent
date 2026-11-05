id: F-EXEC-106
severity: medium
class: race
file: mindcraft/src/agent/library/executor.js:252,354,739
evidence: |
  三处用 `/air/i` 正则把"挖掘失败"判成"其实已经挖掉了"：
    :252   if (!r.ok && !/air/i.test(String(r.message ?? ''))) { return { ok:false, code: r.code ?? 'DIG_FAIL', … }; }
    :354   （同形，digdown 分支）
    :739   if (!hr.ok && !/air/i.test(String(hr.message ?? ''))) { … }   （垫高/挖头分支）
  正则 `/air/i` 的匹配面远超"目标已是空气"：任何 message 里含 `air` 子串都算成功 ——
  `stair`、`chair`、`repair`、`air` 以外的 `No air above`、`Cannot break … (airborne)`、
  以及上游随手写的英文句子（`message` 是**错误文本**，不是结构化字段）都会命中。
  同族对照：`act_dig.canDigReason:189-256` 有 `ok/no-tool/unreadable` 三态，
  `act_dig.digBlock` 返回的是结构化 ActionResult（`code` + `message`）→ 判据应该用 `code`，不是文本。
  出处：docs/audit/08-deep-executor-flows.md §1.1 表 **F3**（"真实挖掘失败被吞（正则 `/air/i` 太宽）"）；
  **从未进 00-REPORT 34 条编号**（docs/audit/21-review-r2-verdict.md §4.3"≈68 条不可追溯"之一）。
  本轮在当前代码复核：**仍存在**，且是 3 处（08 分册当时只列了 2 处，`:739` 是漏记的第三处）。
exploitability: |
  触发条件：任何一次真实挖掘失败，且失败文案里恰好含 `air`（含 "already air"/"stair" 这类）。
  后果：`dug++` 照样自增 → 上层认为这一格已经通了 → 规划继续沿着**没挖开的墙**走 → `NO_PATH` 或卡住；
  更糟的是 `updateSurfAfterDig()`（`:258` 附近）会**在没挖成功时也更新 terrain3d** ——
  库与现实分歧从此固化（同一文件 `:254` 的注释记录过这类"库和现实对不上"的真机事故）。
  影响半径：挖矿/挖隧道/垫高整条链，以及 terrain3d 的数据可信度（12 分册 §5 的问题面）。
suggested_fix: |
  判据换成结构化字段（三处同改，每处 1 行）：
  ```js
  // 原来：if (!r.ok && !/air/i.test(String(r.message ?? ''))) return …
  // 改成：只认"目标格现在确实是空气"这一种免责
  if (!r.ok && !blockIsAir(bot, targetPos)) return { ok:false, code: r.code ?? 'DIG_FAIL', … };
  ```
  `blockIsAir` 建议直接用本文件已有的 `blockAt(bot,x,y,z)` + `IS_AIR.has(name)`（`:725` 附近的 `stepUp`
  就是这么写的），并在 `r.ok` 为假时才调用（省一次读）。
  `updateSurfAfterDig` 的调用条件收紧为 `if (r.ok || blockIsAir(...))`，避免"没挖成也写库"。
verify: |
  cd mindcraft
  grep -n "/air/i" src/agent/library/executor.js          # 期望 0 命中（三处都不再靠文本猜）
  # 行为：假 bot 让 digBlock 返回 {ok:false, code:'DIG_FAIL', message:'cannot break stair_block (airborne)'}
  #   → executor 必须返回 ok:false，且 terrain3d 的 columnSurfaces 不被更新
  # 反证：让 digBlock 返回 ok:false + 目标格实际为 air → 必须当作成功（不清 regress）
  node tools/unit_all.mjs 2>&1 | tail -5                  # 与基线一致
discovered_by: patch-smith(from history)
dept: D3-EXEC
