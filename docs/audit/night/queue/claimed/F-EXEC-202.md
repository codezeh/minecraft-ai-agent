id: F-EXEC-202
severity: medium
class: injection
file: mindcraft/src/agent/tasks/cooking_tasks.js:17
evidence: |
  独立核实 patch-smith 那条"38 处裸 `bot.chat('/…')`" —— **数字对得上，危险度需要修正**。

  ## 一、计数（我自己数一遍，排除注释）
  $ cd mindcraft && for f in src/agent/tasks/*.js; do ... done
  src/agent/tasks/construction_tasks.js  代码行=0   总命中=1     ← 唯一那条是注释（:1092）
  src/agent/tasks/cooking_tasks.js       代码行=27  总命中=33
  src/agent/tasks/tasks.js               代码行=10  总命中=11
  $ grep -rnE "\.chat\(\s*[\`'\"]/" src --include="*.js" | grep -vE ":[0-9]+:\s*(//|\*)" | wc -l
  **38**     ← 与 patch-smith 的数字一致（全部在 src/agent/tasks/**）

  这 38 处**全部绕过** `command()` 白名单与 `inspectChatText`（M1 那条"斜杠命令只走白名单"
  的规则对它们无效），而 bot 是 op。

  ## 二、真正的危险点（我核到的原文，比传闻更准）
  1) `cooking_tasks.js:17-24` —— **8 条裸 /fill**，`init()` 第一件事：
     ```
     /fill ~ ~-1 ~ ~50 ~-3 ~50 grass_block     … 4 条草地（50×50 水平 × 3 高）
     /fill ~ ~ ~ ~50 ~10 ~50 air               … 4 条清空（50×50 水平 × 10 高）
     ```
     单条最大 = 50×50×10 = **25000 格**；4 条 air 合起来覆盖 **100×100×10** 的方盒。
     ⇒ patch-smith 说的"8 条 /fill 清 100×100×10"**成立**（准确表述：8 条 /fill，
     合并足迹 100×100，高度 10(清空)/3(铺草)）。
  2) `cooking_tasks.js:274-276 killEntities()`：
     ```
     /kill @e[type=${entity},distance=..200]
     ```
     ⇒ patch-smith 说的 `/kill @e[...,distance=200]` 存在，但**原文是 `distance=..200`**
     即"≤200 格内的该类型所有实体"，不是"距离 200 处"。影响面比传闻更大一点
     （200 格足以覆盖整片基地：玩家本人的宠物、村民、展示框里的盔甲架、别的 bot 全在内）。
     调用点 `:208-210` 是 `/kill @e[type=item]` + 各类动物 + 再一次 item —— **自动执行**。
  3) `tasks.js:372/414/436/466` —— `/clear ${agent}`、`/clear ${username}`、`/give ${username} …`，
     `${username}` 来自任务 JSON 的 `usernames` 数组（数据驱动，不是硬编码）。

  ## 三、可达性（这是我把 severity 定在 medium 而不是 critical 的全部理由）
  $ grep -n '"task"' mindcraft/settings.js   → **无此键**（settings.task = undefined）
  `agent.js:334`：
  ```js
  if (!load_mem) { if (settings.task) { this.task.initBotTask(); this.task.setAgentGoal(); } }
  else           { if (settings.task) { this.task.setAgentGoal(); } }
  ```
  ⇒ **`initBotTask()` 整个函数被 `settings.task` 挡住**，`/clear`（在 initBotTask 第一行）
  和 `CookingTaskInitiator.init()`（`tasks.js:485`）都在里面。
  又：`README.md` / `FAQ.md` 里 `grep -E "settings\.task|hells|cooking"` → **零命中**，没教用户开它。
  `new Task(...)` 本身在 `agent.js:246` 是无条件构造，但那只是建对象，不执行任何 chat。

  ## 四、一旦启用会发生什么（用户视角）
  用户把 `settings.task` 指向一个 hells_kitchen 格式的 JSON（上游遗留的多 agent 实验），
  `task_type === 'cooking'` 时：**启动即自动** `/clear` → 8 条 `/fill` 清掉脚下 100×100×10 →
  `/kill @e[...,distance=..200]` 清实体。全程无权限闸、无二次确认、日志只有 `console.log`。
exploitability: |
  默认配置：**不可达**（`settings.task` 不存在）。所以今天不是线上漏洞，是"埋着的开关"。
  可达条件：用户/后人把 `settings.task` 打开（上游 mindcraft 的 hells kitchen 实验入口；
  本仓 README 没写、settings.js 没留键，只能靠翻代码或旧文档才会碰到）。
  开了之后谁能造成伤害：**不需要攻击者**。这 38 处是"无输入也会打出巨型破坏性命令"，
  唯一触发者是"任务启动"这个事件本身。若同时玩家能改任务 JSON（任务文件放工作区、无校验），
  则 `/clear ${username}`、`/give ${username}` 的 `${username}` 直接来自该 JSON。
  影响半径：**整个世界存档**（100×100×10 方块 + 200 格内实体），不可回滚（服务器没有自动备份）。
  诚实定级：按"可达性=需要用户打开一个未文档化的实验开关"，我给 medium；
  一旦那个开关被打开，这几条应该按 **critical** 处理（破坏力超过本项目任何其他发现）。
suggested_fix: |
  分两步，都不改变玩法（默认本来就不可达）：
  1. **把这 38 处收回白名单通道**（治本）：`src/agent/tasks/cooking_tasks.js` 与 `tasks.js` 里
     所有 `bot.chat('/…')` 改成 `atom_input_misc.js` 的 `command(bot, name, args)`：
     - `/fill`、`/setblock`、`/summon`、`/kill`、`/clear`、`/give` 需要在
       `src/agent/permissions.js` 的斜杠白名单里登记（`cheat: true` + `level: OWNER`），
       由 `command()` 统一做等级判定与参数拼接（它用的是 `[cmd, ...args].join(' ')`，
       不会再出现模板串拼接）。
     - 这样即使将来被打开，也至少有权限闸 + 统一入口，且 preflight 的斜杠扫描能看见它们。
  2. **加一道显式闸**（治标但立刻有效）：把 `settings.task` 的启用做成显式声明，
     并在 `initBotTask()` 开头加一行"危险操作确认"：
     例如要求 `process.env.ALLOW_TASK_CHEATS === '1'` 才允许跑 `/fill`/`/kill`,
     否则直接 `fail('NO_PERMISSION', ...)` 并打印它会做什么。README 里写明这三条命令的破坏范围。
  3. 顺带（不属本条，但同一段代码）：`PROGRESS_FILE = './hells_kitchen_progress.json'` 写在
     cwd 根，建议挪到 `bots/<name>/`；本夜可不动。
verify: |
  cd mindcraft
  # 1) 代码级裸斜杠 chat 归零（这是本条的硬判据）
  grep -rnE "\.chat\(\s*[\`'\"]/" src/agent/tasks --include="*.js" | grep -vE ":[0-9]+:\s*(//|\*)" | wc -l
  # 期望 0（修完）；修改前是 38
  # 2) 危险命令仍然存在但走了白名单（不是被删掉）
  grep -rn "fill\|kill" src/agent/tasks/cooking_tasks.js | grep -c "command(" ; echo "期望 >0"
  # 3) 默认配置下行为不变（settings.task 缺失 → 不执行任何任务命令）
  node -e "console.log('settings.task =', require('fs').readFileSync('settings.js','utf8').includes('\"task\"'))"
  # 期望 false
  # 4) 门禁不回归（preflight 的斜杠扫描是本条的正向检查者）
  npm run gate:full
discovered_by: recon-scout
dept: D3-EXEC

---
resolution: 部分解决（总闸已上）+ 38 处逐条改造 blocked（patch-smith · D3 修补）
已做: src/agent/tasks/tasks.js 的 initBotTask() 开头加 fail-closed 总闸
  `if (process.env.ALLOW_TASK_CHEATS !== '1') { 打印会执行什么; return; }`
  —— 这是 38 处的唯一入口（/clear 在下一行，CookingTaskInitiator.init() 也由此 new 出），一处闸覆盖全部。
blocked（38 处改 command() 通道）: 属"造场景/烹饪测试"脚本；改成 command() 需先在 permissions.js 斜杠白名单登记
  /fill /setblock /summon /kill /clear /give（cheat+OWNER），并逐条验证 NBT 片段与相对坐标 `~` 语义不变；
  本会话无法运行 bot / 无法跑 gate ⇒ 只能保语法，无法证明场景仍能建出来。按"保守优先"不赌。
建议后续单: F-EXEC-204（38 处收回 command()），前置 = 能真机跑一次 cooking/construction 场景。
