id: F-EXEC-101
severity: high
class: injection
file: mindcraft/src/agent/tasks/tasks.js:372
evidence: |
  「斜杠命令只许从 `atom_input_misc.command()` 出去」这条安全不变量，在 `src/agent/tasks/**` 里有
  **约 38 处裸 `bot.chat('/…')` 常开后门**，而 preflight 用一条豁免把它们整目录放过：
    tools/preflight.mjs:488-495（slash-command-owner 的 allow 列表）
      allow: [ 'src/agent/library/atom_input_misc.js',
               // 冻结文件（src 里没人 import），Phase R 一并删/迁
               // 开发用任务脚本（造场景/烹饪测试），**不是运行时链路**；后续并入 command()
               'src/agent/tasks/**/*.js',
               'src/agent/agent.js' ]
  实测（本轮，非注释行）：
    $ grep -rn "bot\.chat(\`/" mindcraft/src/agent/tasks/*.js | grep -v "//" | wc -l   → 38
    tasks.js:372  this.agent.bot.chat(`/clear ${agent}`)
    tasks.js:414  await this.agent.bot.chat(`/clear ${this.name}`)
    tasks.js:436  bot.chat(`/clear ${username}`)
    tasks.js:466  bot.chat(`/give ${username} ${itemName} ${quantity}`)
    tasks.js:544  bot.chat(`/tp ${this.name} ${human_player_name}`)
    tasks.js:589  bot.chat(`/tp @a ${first_coord[0]} …`)          ← /tp @a，全体玩家
    cooking_tasks.js:17-24  await bot.chat(`/fill ~ ~-1 ~ ~50 ~-3 ~50 grass_block`) ×4
                            await bot.chat(`/fill ~ ~ ~ ~50 ~10 ~50 air`) ×4   ← 100×100×10 清空
    cooking_tasks.js:276    await this.bot.chat(`/kill @e[type=${entity},distance=..200]`)
    construction_tasks.js:43 bot.chat(command)   // command = `/fill … air`，算式拼的复位指令
  **豁免理由与实际不符**：`tasks.js` 不是"冻结/开发用脚本"，它是 `!do <任务名>` 的**运行时引擎**
  （同一个文件 `:407`/`:513` 就是本轮已修的"任务 JSON → owner 级命令"那条注入链的所在地）。
  `cooking_tasks.js` 同样可被任务 JSON 真实跑到。作者自己的注释也写着"**后续并入 command()**"——即已知未做完。
  出处：docs/audit/00-REPORT.md 第 29 条（"命令白名单在 skills.js 里有两处被裸 bot.chat 绕过"，已修）+
  docs/audit/12-world-storage-schematic.md §6.2 E5 旁证（"cooking_tasks.js:17-24 硬编码 /fill … air 直接清空 100×100"）；
  豁免表的合法性审查见 docs/audit/21-review-r2-verdict.md §2 #8 之前的 T19 提交（710ab7e「豁免表逐条审计」）——
  T19 删了 2 条过期豁免，**这一条被保留**。
  本轮在当前代码复核：**仍存在**（且第 29 条已在 skills.js 修完，tasks 这一族没跟着修）。
exploitability: |
  攻击者前置条件：能让任务 JSON / 任务参数里出现自己的字符串（任务文件是本机 JSON，面板/`!do` 都能触发）。
  能拿到什么：以 **op 账号**执行 `/tp`、`/give`、`/clear`、`/fill`、`/kill`、`/setblock`。
  最坏那条：`cooking_tasks.js:276` 的 `/kill @e[type=…,distance=..200]` —— 200 格内指定类型的**所有实体**
  （含玩家养的动物、别人的宠物、掉落物），一条常量字符串就删干净。
  其次是 `:17-24` 的 8 条 `/fill`：把 100×100×10 的范围先铺草方块再清成空气，**不可撤销**。
  影响半径：整个服务端世界。而 `injection` 的入口面就是"数据 → 命令"这条链，
  与第 1 条第五层同源（那条已改成参数通道，这条没有）。
suggested_fix: |
  ① **先立判据**：`preflight.mjs:488-495` 的 `'src/agent/tasks/**/*.js'` 豁免后面补一句
     "**仅限离线生成器（construction/cooking 的构建函数）**，`tasks.js` 属运行时，禁止豁免"，
     并把 `src/agent/tasks/tasks.js` 从豁免里**单独摘出来**（改成显式 allow 只有 construction/cooking）。
     这一步会让 preflight 立刻在 `tasks.js` 上报 10+ 条 —— 这正是"门禁恢复了视力"的证据，不是回归。
  ② `tasks.js` 的 10 处改成 `await command(bot, 'clear', [agent])` / `command(bot,'tp',[...])` / `command(bot,'give',[...])`
     （`atom_input_misc.command` 有 `slashVerdict` 白名单 + cheat/level 两层判定，与 skills.js 那 5 处正确写法同形：
     `skills.js:1144/1147/1150/4714/4741`）。
  ③ 烹饪/建造脚本（约 28 处）按同一方式改；**不要求今晚全改完** —— 若量大，至少先做 ①，
     让门禁从上到下都看得见，再逐文件收敛（每条一个 commit，符合 PLAYBOOK §3）。
  红线提醒：`/fill`、`/kill` 这类指令改完后行为必须逐字节等价（坐标区间与方块名不变），只换出口不换语义；
  改之前先把原命令 dump 成对照表贴进 commit body。
verify: |
  cd mindcraft
  # 门禁能看到（改 ①）
  npm run gate 2>&1 | grep -c "slash-command-owner"        # 期望 ≥1（原来恒 0）
  # 收敛完成后的终局判据（改 ②③）
  grep -rn "bot\.chat(\`/" src/agent/tasks/*.js | grep -v ":[[:space:]]*//" | wc -l   # 期望 0
  # 行为等价：以 cooking 任务为例，改前/改后各跑一次，比对服务端日志里实际执行的指令序列
  #   （Paper 控制台会打印每条指令；用 diff 对照两边）
discovered_by: patch-smith(from history)
dept: D3-EXEC
