id: F-EXEC-111
severity: medium
class: config
file: mindcraft/src/agent/library/composite_registry.js:107-110
evidence: |
  craft 是 18 个注册项里**唯一一个不把 `ctx` 传给 flow 的**：
    :107  {
    :108      manifest: manifestCraft,
    :109      run: (bot, args, ctx) => runCraft(bot, args.item, args.count),     ← ctx 收到但丢弃
    :110  },
  同文件相邻项的写法（全部把 ctx 带下去）：
    :101  runEscapeUp(bot, { deadlineMs: remaining(ctx), mapDir: ctx.mapDir, onEvent: ctx.onEvent })
    :115  runSmelt(bot, args.input, args.count, { fuel: args.fuel, ctx })
    :122  runStore(bot, args.item, args.count, { ctx })
  而 `flow_craft.craft` 的签名是 `:146 export async function craft(bot, itemName, count = 1)`
  —— **它根本没有接收 opts 的口子**，所以这一条要改两处（注册项 + flow 签名），不是一行。
  后果（与第 15 条叠加）：craft 单没有 `deadline`（不会因超时收手）、没有 `jobId`/`onEvent`
  （用量与中断挂不到具体单上）；进程被杀 → 租约过期 → 重领 → 再合成 → 再扣料。
  第 15 条已修的部分是"产出账 `producedTotal` + finish 按增量收敛"（`bf06d4e`），
  它解决的是**重复扣料**，但没有解决**这张单没有 deadline/context**。
  出处：docs/audit/08-deep-executor-flows.md §6 Should **E6**（"18 个注册项里唯一一个不把 ctx 传给 flow"）；
  docs/audit/00-REPORT.md §十二 第 11 项（v2.1 登记，含行号）；docs/audit/12-world-storage-schematic.md §6.2「E6 维持」。
  本轮在当前代码复核：**仍存在**（`:109` 逐字未变，`flow_craft.craft` 仍是 3 参）。
exploitability: |
  无远程攻击面。危害是**单子失控与记账断链**：
  ① 没有 deadline → 一个"配方需要 64 个原料、背包只有 3 个"的 craft 单会一直重试到把原料耗尽，
     期间不接受"这张单已经超时"的裁决（其它 flow 都有 `deadlineMs`，只有 craft 没有）；
  ② 没有 `jobId`/`onEvent` → 面板的事件流里看不到这张单的进度事件，
     `blog()`/诊断页对它半盲（其余 17 个 flow 都能看到）；
  ③ 与孤儿进程（F-EXEC-102）叠加时：主控死了，孤儿还在 craft，没人能停。
  影响半径：合成链（`!do first_night` 全靠它），以及"面板看着正常但停不掉"这一族。
suggested_fix: |
  两处（一次 commit）：
  ① `flow_craft.js:146` 签名加第 4 参：`export async function craft(bot, itemName, count = 1, opts = {})`，
     函数内按其它 flow 的惯例处理 `opts.ctx?.deadlineMs`（超时返回 `fail('TIMEOUT', …)`，与 `runSmelt` 同口径）
     与 `opts.ctx?.onEvent`（每步发 `{type:'craft', …}`）；
  ② `composite_registry.js:109` 改成 `run: (bot, args, ctx) => runCraft(bot, args.item, args.count, { ctx })`。
  **不要**顺手改其它 17 项（它们已正确）。
verify: |
  cd mindcraft
  grep -n "runCraft(bot, args.item, args.count, { ctx })" src/agent/library/composite_registry.js   # 期望 1 命中
  grep -n "export async function craft(bot, itemName, count = 1, opts" src/agent/library/flow_craft.js # 期望 1 命中
  # 行为：给一个超出背包的合成单 + deadlineMs=2000 → 期望 2 秒内返回 {ok:false, code:'TIMEOUT'} 而不是一直重试
  node tools/unit_all.mjs 2>&1 | tail -5      # 与基线一致（craft 相关单测必须仍绿）
discovered_by: patch-smith(from history)
dept: D3-EXEC
