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

## review（gate-keeper · t15 · 2026-11-06 02:3x）
**结论：打回（needs_revision）。** 对象：工作区 diff（**未提交**）。

### 一、先纠正我自己：闸**确实**挡住了，你的断言成立
我一开始怀疑"`initBotTask()` 不是唯一入口（`/fill` 在 `CookingTaskInitiator.init()`、`/kill` 在 `killEntities()`）⇒ 闸漏了"。
**走完调用链后发现我错了**：
```
agent.js:336  if(settings.task){ this.task.initBotTask(); }         ← 唯一外部入口（grep 确认）
tasks.js:429  if(process.env.ALLOW_TASK_CHEATS!=='1'){ … return; }  ← 闸
tasks.js:434  bot.chat(`/clear …`)           ← 闸后，被跳过
tasks.js:444  this.initiator = new CookingTaskInitiator(…)          ← 闸后 ⇒ initiator 从不被创建
tasks.js:504  if(this.initiator && …) await this.initiator.init()   ← 因此 8 条 /fill 不执行 ✅
tasks.js:508  await this.teleportBots()                             ← 闸后 ⇒ /tp 不执行 ✅
```
全仓 `initiator.init()` / `teleportBots()` 各只有一个调用点 ⇒ **当前代码里 38 处全被切断，fail-closed 成立。**

### 二、但两个问题都成立
**问题 1（功能回归 + 日志低报）**：`return` 跳过的是 `initBotTask()` **整个后半段**，不只 cheat：
`/clear`、500ms/3000ms 等待、`initiator` 赋值、人类玩家清包、**`teleportBots()`（bot 不传送）**、
`agent_count` 检查与 `killAll()`、`!startConversation`；而 `agent.js:337` 的 `setAgentGoal()` **与闸并列、仍执行**
⇒ 半初始化（目标设了、场景没搭）。
日志只写"拒绝执行 … cheat 初始化 … 本次本会执行：/clear、8 条 /fill、/kill" ⇒ **低报**。

**问题 2（闸在调用方，不在 sink）**：任务判据明写"换个调用方就绕过 = 打回"。
cheat 住在**公开方法**里且自身无判据：`CookingTaskInitiator.init/plantCrops/plantSugarCane/plantMushrooms/killEntities`、
`Task.teleportBots()`、`tasks.js:456/486/496` 的 `/clear`、`/give`。今天无第二个调用点（已 grep）⇒ 当前不可利用；
但未来任何重构/新调用会**静默绕过**，日志不会响。

### 三、requiredFix
**① 治本（推荐）**：闸下沉到 cheat 的唯一出口 —— `src/agent/tasks/` 内加
```js
export function guardedChat(bot, cmd) {
    if (String(cmd).trimStart().startsWith('/') && process.env.ALLOW_TASK_CHEATS !== '1') {
        console.error('[F-EXEC-202] 已拒绝一条 cheat 指令（未设 ALLOW_TASK_CHEATS=1）：', String(cmd).slice(0,60));
        return Promise.resolve();
    }
    return bot.chat(cmd);
}
```
把 38 处 `bot.chat(`/…`)` 换成 `guardedChat(bot, …)`：校验在危险处（换调用方绕不过）＋**只拦 cheat、不腰斩正常初始化**＋每条被拒都有日志。

**② 若来不及**：`return` 改成**只跳 cheat 三段**（`/clear`、`initiator`、人类清包），**保留 `teleportBots()` 等非 cheat 流程**；
日志改如实口径（明确"还将跳过 teleportBots/对话初始化"）；并把本条标 **`部分解决（总闸止血，38 处未逐条收口）`，不要标"已修"**。

### 四、可复现路径
设 `settings.task = true`、**不设** `ALLOW_TASK_CHEATS`，起两个 bot 跑 cooking 任务：
按日志会理解成"只不执行 /fill"；**实际** bot 不传送、不对话、缺人也不 killAll，而 `setAgentGoal()` 照样设目标。

---
resolution: **部分解决**（如实口径，patch-smith · 按 captain 裁决重做）
上一版打回原因（复核席，我采纳）：① 函数开头直接 `return` 会连带跳过 `teleportBots()`/`agent_count`/`killAll()`/
`startConversation` 等**非 cheat** 段，而日志只说"拒绝 cheat" ⇒ 照日志排障会得出错误结论；② 闸在调用方不在 sink。
本次改法：
- 只跳过**三段 cheat**：`/clear <bot名>`、cooking 场景搭建（8 条 /fill + /kill @e）、`/clear <玩家名>`
- **保留**：等待、`teleportBots()`（tasks.js:526 仍执行）、agent_count 检查、killAll()、startConversation
- 日志**逐条列出"拦住什么 / 什么照常"**，并明确写"结果是**场景没有搭起来**（部分解决，不是 cheat 被拦其它全好）"
已知边界（写进代码注释与下面）：
- 闸在**调用方**（`initBotTask`）不在 sink：`CookingTaskInitiator.*` / `Task.teleportBots()` 等公开方法自身无判据，
  将来新增调用点会静默绕过 ⇒ **已单独立单 F-EXEC-204（guardedChat 下沉，标"待真机环境"）**
- 其余 10 处 `/give` `/tp` 等未纳入本闸（captain 裁决只做这三段）；它们同样需要 `settings.task` 才可达
verify: `ALLOW_TASK_CHEATS` 未设时启动 `!do cooking` → 日志出现三行"✗ 跳过"与一行"✓ 照常"，且 bot 仍会被 teleportBots 传送、不搭场景。
