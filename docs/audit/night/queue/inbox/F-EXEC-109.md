id: F-EXEC-109
severity: low
class: race
file: mindcraft/src/agent/tasks/construction_tasks.js:47-56
evidence: |
  `checkLevelBlueprint` 直接解引用 `blueprint.checkLevel()` 的返回值，不判类型/空值：
    :47  export function checkLevelBlueprint(agent, levelNum) {
    :50      const result = blueprint.checkLevel(bot, levelNum);
    :51      if (result.mismatches.length === 0) {        ← 若 checkLevel 返回 false 或 undefined → TypeError
    :52          return `Level ${levelNum} is correct`;
  同型解引用还有 `:15`、`:19`、`:65`、`:121-122`（`result.mismatches.length` / `result.matches.length`）。
  调用方是**用户可直达的命令**：
    src/agent/commands/queries.js:237-243   name: '!checkBlueprintLevel' → let res = checkLevelBlueprint(agent, levelNum);
    src/agent/permissions.js:80             '!checkBlueprint' / '!checkBlueprintLevel' 在命令表里（不是 owner 专属也可触发）
  也就是说：一条命令 + 一个"checkLevel 走了异常/提前返回分支"的蓝图 → `TypeError: Cannot read properties of
  false (reading 'mismatches')`。
  出处：docs/audit/08-deep-executor-flows.md §6 Should **E3**（"`!checkBlueprint` 会抛 TypeError，是可被用户直接触发的命令级崩溃"）；
  docs/audit/00-REPORT.md §十二 第 11 项（v2.1 登记：E3 不进 1~34，理由"落在离线生成器；
  **但 E3 是可被用户直接触发的命令级崩溃，建议进 S 组**"）——建议了，没进编号，也一直没修。
  本轮在当前代码复核：**仍存在**（`:51` 逐字未变）。
exploitability: |
  前置条件：本机用户（或任何能让 bot 收到 `!checkBlueprintLevel N` 的路径 —— 玩家在服里聊天若能说上话，
  按第 1 条那套权限链甚至可以自报 owner 名）在 agent 有 `agent.task.blueprint` 的情况下执行该命令。
  能拿到什么：命令处理链里抛未捕获异常 → 视 `commands` 的调用处有没有 try/catch 决定是
  "一条命令报错"还是"整个 agent 的指令循环断掉"。`:15/:19` 那两处甚至在**构造/解析阶段**就会碰同样的字段。
  影响半径：单次命令级崩溃（不是 RCE、不是数据丢失），列 low；但它是"模型/玩家能打出来的形状"，
  与 PLAYBOOK §2 的反面教材正好相反的一类：**位置、可利用性、验证方式都明确，成本 1 行**。
suggested_fix: |
  每个解引用点前加一句类型守卫（` :51` 必改，`:15/:19/:65/:121-122` 同）：
  ```js
  const result = blueprint.checkLevel(bot, levelNum);
  if (!result || typeof result !== 'object' || !Array.isArray(result.mismatches)) {
      return `Level ${levelNum} 检查失败：checkLevel 返回了非预期值（${String(result)}）`;
  }
  ```
  判据用 `Array.isArray` 而不是 `result.mismatches?.length` —— 前者会把"形状不对"如实报出来，
  后者会把 TypeError 换成一个更难查的 `undefined === 0`。
verify: |
  cd mindcraft
  grep -n "result.mismatches.length" src/agent/tasks/construction_tasks.js | wc -l   # 现状 4 处
  # 改后每处都应先有 Array.isArray 守卫：
  grep -c "Array.isArray(result.mismatches)" src/agent/tasks/construction_tasks.js     # 改后期望 ≥4
  # 行为：让 blueprint.checkLevel 返回 false → 期望返回「检查失败：…」而不是抛 TypeError
  node tools/unit_all.mjs 2>&1 | tail -5                                            # 与基线一致
discovered_by: patch-smith(from history)
dept: D3-EXEC
