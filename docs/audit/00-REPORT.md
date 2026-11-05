# 全盘审查与优化报告

> **版本：v2.1（v2 + t14 复核后的 6 项漏并补齐）**
> 汇总 `docs/audit/01~13`。编号 1~20 为 v1 已交付的硬发现（**v2 未重排、未改号**）；**21~34 为 v2 新增**；S 系列为小项。
> 每条的 `文件:行号` 都带证据，出处标在条目末，形如（源自 ②）。
> **v2 相对 v1 的三件事**：① 新增「实测 vs 推断」三态总表（第 四 节）；② 兑现实证线 t11 的 10 条改判；③ 把 `skills.js` 全文、15 个 `act_*`、board 测试、bench、模型层全部读/跑完，据此推翻或加强了 v1 的若干结论。

## What this repo does:

一个 Minecraft AI agent：LLM 按秒级节奏下指令，驱动 1~3 个 bot 在 Paper 服务端里干活（挖矿、合成、建造、跟随），中间有一层自建的**任务板**（SQLite 持久化的工作队列，多 bot 抢单/租约/依赖）和一个 Vue 控制面板。导航是自研的：先把世界扫进一张真 3D 体素表（`terrain3d.db`，每列可存多个"可站立面"），再用 3D A* 算路、逐步执行。

**负载假设**（全报告的分级基准）：单人/少数几台机器；1 个 Paper 服务端 + 1~3 个 bot 实例 + 1 个 Web 面板；bot 由 LLM 驱动连续下指令；任务板 SQLite 持久化；**每个 bot 一个独立进程**（`src/process/init_agent.js:45`）。

## 方法论声明

**这个仓库的文档不可作为事实来源。** 根因是一次重命名：commit `071fc74 refactor(Phase R)` 把 `task_*→flow_*`、`atom_*→act_*` 共 37 个文件改了前缀，但 `00~09` 与三份设计稿仍按旧名写。实测 **202 个 `.js` 引用 token 在全树找不到同名文件**。

因此本报告有一条硬规矩：**凡只靠文档得出、未经代码核实的结论，一律标注可靠性**。v2 更进一步：第 四 节把每一条标成「已实测 / 静态确证 / 仍为推断」，凡标"已实测"的都能在 `09-empirical.md` 或 `docs/audit/probes/` 找到对应输出。

---

# 一、Must fix

> 编号规则：**1~12 是 v1 的 Must**（v2 在原位置修订，条目末标「v2 修订」）；**21~27 是 v2 新增的 Must**（接在 v1 全部编号之后，不占 13~20 的位置）。
> 编号说明：1~20 为 v1 沿用（作者可能已按此排期，故不重排）；21~34 为 v2 新增。因新增 Must 插在 Should 之前，正文物理顺序为 1..12 → 21..27 → 13..20 → 28..34，按编号查找不受影响。

## 1 控制面完全没有门：本机任意进程/任意页面可冒充主人，拿走 owner 级权限——**而且"代码执行沙箱"根本关不住**
`mindcraft/src/mindcraft/mindserver.js:392-402`（`send-message` 原样转发 `data.from`）、`src/mindcraft/local_only.js:38`（不带 Origin 直接放行）、`mindserver.js:336-343`（`set-agent-settings` 可改运行期设置）、`mindserver.js:234-248`/`356-390`（`server-stop`/`shutdown`）、**`mindcraft/settings.js:33`**（`"allow_insecure_coding": true`）；**沙箱侧 `src/agent/library/lockdown.js:20`（`evalTaming:'unsafeEval'`）+ `src/agent/coder.js:189-194`（把宿主 `skills`/`world`/`Vec3` 注入 Compartment）**

**这是什么**：控制面板和 agent 之间走本机 socket.io（`ws://127.0.0.1:8080`），**没有任何认证**；`send-message` 里"我是谁"由**客户端自己填**，而权限等级就是拿这个名字算的。而"代码执行"这条最危险的能力，其唯一的边界是一个 SES Compartment。

**问题（三层叠加，v2 已把第三层从"未审计"变成"已实测失效"）**：
- **第一层（认证）**：本机任意 Node/脚本进程、以及任何从 `http://localhost:<任意端口>` 提供的页面都能连进来——`local_only.js:38` 对"没带 Origin"的连接直接放行。局域网连不上（`mindserver.js:421` 固定 bind `localhost`），所以攻击面是"本机"。
- **第二层（身份自报）**：`{from:'HEAVENZEH', message:'!newAction(…)'}` 这一条报文就让等级判成 `owner`（`profiles/my-local.json:6`），`OWNER_ONLY_COMMANDS` 全开（`permissions.js:40-54`），`!newAction` 走到 `coder.js` **生成并执行代码**。这个 bot 在服里是 op（`server/ops.json` 有 341 条 bot 账号）。
- **第三层（沙箱 —— v1 当时写的是"未评估"，现在是"已实测可逃逸"）**：`lockdown.js:20` 设 `evalTaming:'unsafeEval'`，`coder.js:189-194` 把**宿主对象**当 endowment 注入。宿主函数的 `.constructor` 是**宿主 realm 的 `Function`**，所以模型代码可以：
  ```js
  const p = skills.log.constructor('return process')();      // → object
  const req = world.constructor.constructor('return require')();  // → function
  req('child_process').exec('…');
  ```
  **队长亲验（探针 `docs/audit/probes/captain-verify-ses-escape.mjs` / `-escape2.mjs`）**：compartment 内部 `new Function('return typeof process')()` → **`undefined`**（说明 SES 对"自己的 Function"是管用的）；而 `skills.log.constructor('return typeof process')()` → **`object`**；取到宿主 `process.version` → **`v24.16.0`**、`process.platform` → **`win32`**、`process.binding` → **`function`**。
- **第四层（闸门本来就是开的）**：`mindcraft/settings.js:33` 的 `allow_insecure_coding` 实际是 `true`，而 `README.md:177-179` 告诉读者"代码执行默认关闭，需手动设 true"。照文档判断风险的人会以为"要手动开所以还算安全"——**恰好相反**。（`main.js:50-52` 还留了第二个开闸口：环境变量 `INSECURE_CODING` 一设就强制打开。）
- 同一批无认证事件还包括：`server-stop`（关服）、`shutdown`（`process.exit(0)`）、`set-agent-settings`（可把 `allow_insecure_coding` 改成任意值、清空 `blocked_actions`）。
- **第五层（v2.1 新增：第三种入口，连 socket 都不需要）—— 任务 JSON 升级成可执行输入**：`src/agent/tasks/tasks.js:407` 把任务数据里的 `agentGoal` 插进 `executeCommand(this.agent, \`!goal("${agentGoal}")\`, { internal: true })`；`:509` 同样把 `this.data.conversation` 插进 `!startConversation("…","${…}")`，两处都标 `internal: true`。`internal:true` 的设计意图正是**跳过发言人权限闸门**（`:405-406` 的注释写明"否则 !goal 是主人级命令、这里没有 author 会被自己的闸门拦掉"）。于是**改一个任务 JSON 文件，就能让 bot 以主人身份执行任意 owner 级命令**——不需要 socket、不需要认证、不需要写代码。这是第 1 条那类风险的**第三种入口**。
- **第六层（v2.1 新增：不需要"代码执行"的越权面）—— 蓝图路径穿越**：`skills.js:4039 describeSchematic(bot, schematicFile)` → `:4051 readLitematic(schematicFile)` → `schematic.js:52 const abs = path.resolve(filePath)` → `:56 fs.readFileSync(abs)`，**`path.resolve` 之后没有任何前缀/白名单校验**，绝对路径与 `../../` 都接受。**受限的部分**：读进来的内容必须能解析成 litematic/.schem 的 NBT 且含 `Regions`（`schematic.js:64` 解析、`:66` 校验），否则 `describeSchematic:4058-4061` 的 catch 只返回 `{ok:false, reason:'read_failed', detail: 错误消息}`。所以准确的能力是两件：①**读取磁盘任意位置**的蓝图文件并把它的 size/totalBlocks/材料清单**返回并 log 给模型**（这类文件可以是 `./schematics/` 之外的）；②对非蓝图文件不能读内容，但 `existsSync` + 两种不同错误消息构成**任意路径存在性探测**。另有 `listBlueprints(dir)`（`:4064`）→ `schematic.js:164-173 listSchematics(dir)` 的 `readdirSync(path.resolve(dir))`，同样无校验 → **任意目录枚举**（按 `.litematic|.schem|.schematic` 过滤后返回文件名）。

**这条的正确读法（v2 修订，定性已变）**：v1 说"这是作者有意识的权衡，安全性押在未经审计的沙箱边界上"。**现在那个前提被证伪了** —— SES 边界挡不住宿主 realm。所以本条的定性从「**入口没锁**」升级为「**锁上了也没用**」：即使把认证补好，只要模型被提示注入（玩家聊天就能做到）或幻觉，三行代码就是本机 RCE，而 `allow_insecure_coding` 默认还是 `true`。（注：作者当初开启这个开关时的注释原文是「代码跑在 SES Compartment 沙箱里，只能访问 skills/world/Vec3/log，没有 fs/net/process」——**这句话在 v2 实测下不成立**，是本报告最需要作者知道的一句话。）

**结论一句话（v2.1 新增，必须写在这里）**：**把 `allow_insecure_coding` 改成 `false` 不等于安全** —— 第六层那条路径完全不需要模型写代码；第五层连 socket 和认证都不需要。所以"关掉代码执行"只是把最坏的那条关小，不是关死。

**最小修复**（六处一起才算修好）：
① 启动时 `crypto.randomUUID()` 生成握手 token，`io.use(...)` 校验；`set-agent-settings`/`shutdown`/`server-*` 全落到这道门后。
② `set-agent-settings` 加字段白名单，`allow_insecure_coding` 与 `blocked_actions` 直接丢弃。
③ **`allow_insecure_coding` 默认改回 `false`**（见路线图第一批），并在 README 与之对齐。
④ **沙箱要么真关、要么别当沙箱**：把 `evalTaming` 改回默认的 `safeEval`（唯一能真关的开关，代价是 protodef 依赖 eval 需要另解）；做不到就明确写"这是给模型的 root，不是沙箱"。
⑤ **任务 JSON 当数据、不当命令**：`tasks.js:407`/`:509` 的插值改成"把 goal/conversation 作为参数传递"而不是拼进命令串（例如给 `executeCommand` 加一个 args 通道），或对插值串做引号/换行转义并拒绝含 `"` 与换行的值。
⑥ **蓝图路径加前缀断言**：`schematic.js:52` 的 `path.resolve` 之后加 `if (!abs.startsWith(SCHEM_ROOT)) throw`；`listSchematics:165` 同样处理。

**不修会怎样**：本机任何一个能起进程的东西都能以主人身份指挥一个 op bot，而"代码执行"这条路径上**没有任何一层是有效的**（认证没有、身份可伪造、沙箱可逃逸、开关默认开）。
**状态（v2.1 拆分，按 t14 复核）**：本条的**逃逸那一半是「已实测」**（探针 `probes/captain-verify-ses-escape*.mjs` 有输出）；**"控制面无认证"那一半是「静态确证」** —— `09-empirical.md:397` 自己写明"没有对运行中的 mindserver 实弹打过包"。整条既不是全已实测、也不该整条降级。
**（源自 ③⑥，v2 修订：合入 07/13 的沙箱实测，定性从"入口没锁"改为"锁上了也没用"；v2.1 修订：状态拆两半）**

---

## 2 `create-agent` 的 profile 名没校验，而且在校验之前就拼进了路径 → 任意目录创建 + 任意文件写
`mindcraft/src/models/prompter.js:110-116`（写入点）对照 `src/agent/agent.js:205-210`（校验点，晚 58 行）

**这是什么**：`Prompter` 构造器用 profile 名拼路径并落盘：`mkdirSync('./bots/'+name,{recursive:true})` 然后写 `last_profile.json`。而 `name` 来自客户端。

**问题**：合法性检查 `validateNameFormat`（`/^[a-zA-Z0-9_]{3,16}$/`，`connection_handler.js:87-96`）在 `agent.js:205` 才跑，但 `new Prompter(...)` 在 **`agent.js:147`** 就已经执行完了。
**v2 修订：路径穿越已实测解析**（t11）：`profile.name = '../../pwn'` → 解析为 `E:\我的世界ai\pwn\last_profile.json`；`'../../../pwn2'` → `E:\pwn2\…`（实测未落盘，被校验拦下）。`validateNameFormat` 确实会拒——但它跑在写入之后 58 行。
**补一条 v1 没写的**：即使把校验提前，**也撤销不了已经写出去的文件**。所以修法必须同时包含"Prompter 内部做路径断言"。

**最小修复**：① `mindserver.js:267` 之前复用 `validateNameFormat`；② `prompter.js:110-111` 改成 `path.join(process.cwd(),'bots',name)` 后断言 `resolved.startsWith(botsRoot)`（**这条不能省**）。

**不修会怎样**：本机任意客户端可往任意可写目录投递任意 JSON 文件（覆盖同名文件），并凭空起一个不受管的 agent 进程。（源自 ③，v2 修订：补实测路径解析 + 补"校验提前也不够"）

---

## 3 "板库损坏自动重建"把"临时打不开"也当损坏 → 会把**好库**当坏库（v2 已实测，判据必须拆成两句）
`mindcraft/src/agent/library/board_store.js:163-201`

**这是什么**：`openBoard` 的兜底逻辑：`tryOpen()` 抛**任何**异常 → 关句柄 → `renameSync`（失败就 `rmSync`）`board.sqlite` → 建空库。

**问题（v2 修订：原稿一句"一次锁冲突就把整份任务列表删掉"必须拆成两句，且都不是原稿写的那样）**：
- **① `WAL` + `BEGIN IMMEDIATE` 持锁 9 秒 → `openBoard` 只用 1ms、`rebuilt=false`**（实测 t11）。也就是说**普通写事务撞不到** BUSY——`busy_timeout=5000` 到期才抛，而 `db.exec(SCHEMA)` 拿锁很快。
- **② `rollback journal` + `BEGIN EXCLUSIVE` 持锁 10 秒 → 卡 8246ms 后 `rebuilt=true`、`error="database is locked"`、`backup=(none)`**（实测 t11）。**BUSY 确实被判成"库损坏"**。
- **③ 但数据侥幸保住了**：那一刻文件被别人占着，Windows 上 `rename`/`rm` 都失败（`catch{}` 静默吞掉），等锁释放后重试，打开的仍是同一份文件。**准确表述是「判成坏库但没删成」，不是「必然删库」。**
- **④ 这是 5 秒 `busy_timeout` 的边界，不是必然**：持锁 5.2 秒（在 busy_timeout 内）→ `rebuilt=false`。
- **⑤ 比 BUSY 更容易触发的是 schema 不匹配**：`no such column: priority` **无需任何并发**就走进同一条「当坏库→改名→重建」路径（见新增第 24 条）。

**最小修复**（两条并列，任选其一）：
- **① 判据收窄**：只在错误确实是"文件不是数据库"时重建——`e.errcode===11`（`SQLITE_CORRUPT`）/`26`（`SQLITE_NOTADB`）/message 含 `file is not a database`/`malformed`；**其它错误原样 `throw`**。mindserver 侧 `mindserver.js:75-98` 本就把"板起不来"降级成"没有板"，不阻止启动。
- **② 或者不把 SCHEMA 失败当致命**：`db.exec(SCHEMA)` 外面单独 try + 重试一次。

**不修会怎样**：一次**外部进程**持写锁超过 5 秒，就会让"库损坏已重建"的日志出现、整份任务列表在下次启动时变成空的（本次实测因 Windows 文件占用而侥幸，但那是运气，不是设计）。（源自 ②，**v2 修订：拆成 WAIT/EXCLUSIVE 两种锁 + "判成坏库但没删成" + 5 秒边界，均按 t11 实测改；已实测**）

---

## 4 `finish()` 不校验租约归属：旧的持有者能把别人正在跑的单写回 ready，两个 bot 同跑一张单
`mindcraft/src/agent/library/board_store.js:637-659`（`UPDATE jobs SET … WHERE id=?`，只有 id）

**这是什么**：`finish()` 是"这张单跑完了，决定去 done/ready/blocked/failed"的唯一落库点。它读 `getJob` 后直接 `UPDATE … WHERE id=?`，**既不看 `lease_owner`，也不看当前 state**。同一个文件里的 `heartbeat()`（`:503-504`）反而显式校验 owner 与到期——同一份代码两套标准。

**问题**（完整交错序列）：
- t=0　A 领到单 X（租约 30 秒）；t=10…40　A 的三次心跳都没送达；t=30　`expireLeases`（`:668-684`）把 X 打回 `ready`；t=31　B 领到 X（`:479-482` 原子 UPDATE）；t=35　A 的技能返回，`_runJob` 的 finally 调 `finish(X,…)` → **无守卫的 UPDATE** → X 变 `ready`、`lease_owner=NULL`。
- 结果：B 正在跑的单被 A 抹掉租约，B 下次心跳拿 `LEASE_LOST` 白干；然后 C（或 A）可以再领一次 X。

**最小修复**：UPDATE 改成 `WHERE id=? AND (lease_owner IS NULL OR lease_owner=?)`；`changes===0` 返回 `{ok:false,code:'LEASE_STALE'}` 且**一个字段都不写**。`board_server.js:252` 传 `payload.bot`，客户端 `board_client.js:357` 补发。

**不修会怎样**：两个 bot 同时执行同一张单（互相打断、都报失败）；`progress.count` 虚涨；挖矿/合成的世界副作用重复。（源自 ②，静态确证）

---

## 5 依赖死掉的单永久卡在 ready、父单永久 running——现场已卡 166 分钟，日志与板库两侧都对上了
`mindcraft/src/agent/library/board_store.js:934-943`（`dependsSatisfied` 只认 `done`）、`:1113-1115`（有非终态子单就 `continue`）、`:1009-1015`（重开只处理 `blocked`）；测试侧 `board_store_converge_unit.mjs:218`

**这是什么**：`dependsOn` 的语义是"前置单必须 done 我才能领"。`claimFor` 用 `dependsSatisfied` 过滤，`convergeOrphanParents` 负责"子单全终态就收敛父单"。**两处都假设"非 done 的依赖迟早会 done"**——不成立，因为有些单会进 `blocked` 终态（`:598-599`）。

**问题（现场活数据，双向闭合）**：
```
板库：j_20261105_0002_ngl obtain running 卡 166 分钟
      ├─ ..._0003_ngl mine  blocked  NO_TOOL「挖不动 stone（没有合适的镐）」
      └─ ..._0007_ngl craft ready    dependsOn=[0003,0006]  updatedAt==createdAt
日志：tmp-t59-agent.log:120/236/261  [MINE] round n= 0 ore= cobblestone count= 0 / 3
```
`0003` 已是终态 `blocked` → `0007` 永远不可领 → `convergeOrphanParents` 见"还有一个非终态子单"就 `continue`（`:1115`）→ `reopenOrphanBlocked` 只扫 `blocked`（`:1005`）→ `rollupParent` 只在子单 finish 时被调 → 再没有 finish 事件 → **父单永久 running**。

**最小修复**：加 `depDead(db,job)`（任一依赖处于 `failed/blocked/cancelled` 即真），在 `:1016` 与 `:1115` 前对命中的单 `setState(BLOCKED)` + `result.code='DEP_DEAD'`；**同时把 `board_store_converge_unit.mjs:218` 那条 XFAIL ②-6 转成硬断言**。

**不修会怎样**：第一夜的 `obtain stone_pickaxe` 这类单必然永久挂着；面板显示"还在跑"，实际没有进程在跑它，且**不报错**。（源自 ②⑤，静态确证 + 现场数据；v2 修订：测试侧那条 XFAIL 的断言对象与 B3 不完全相同——它断言"无留痕"，B3 是"永不收敛"，**同一根因不是同一断言**）

---

## 6 玩家按 `!stop` 对任务板上的任务完全无效：三处断链，单子照旧做完
`board_scheduler.js:655`（直接调 `runner(…)`）、`action_manager.js:77-91`（`stop()` 只在 `executing` 时中断）、`control.js:242`（`setAutoClaim` 设的是客户端字段）、`board_scheduler.js:441`（读自己的 `_autoClaim`）

**这是什么**：`!stop` → `actions.stop('player')` → `control.applyStop` → 按 07 §4 应该"把单子转 paused + 暂停自动领单"。

**问题（三处同时断）**：
1. 调度器跑单用 `runner(this.agent, job.skill, …)`（`:655`），**没走 `actions.runAction`** → `resolveJob`（`control.js:210-224`）返回 null → 单子状态**一个字节都没改**。本该补这一环的 `control.runJobAction`（`:339-351`）**全仓零调用方**。
2. `actions.stop()` 里 `if (!this.executing) return;`（`action_manager.js:91`）——调度器跑单时 `executing` 是 false → **不发中断**。
3. `control.js:242` 调 `board.setAutoClaim(false)` 落到客户端字段（`board_client.js:264-268`），而调度器判的是 `this._autoClaim`（`:441`）；`scheduler.setAutoClaim()`（`:385`）**零调用方**。附带：`pausedReason` 全仓只有一处读、**没有一处写** → 就算真暂停，3 秒后也被自动 resume。

**最小修复**：`_runJob` 改成 `await runJobAction(this.agent, job, () => runner(...))`；`applyStop` 改调 `scheduler.setAutoClaim(false)`；`planStop` 的 PLAYER 分支 patch 里加 `checkpoint:{…, pausedReason:'player'}`。

**不修会怎样**：玩家按 `!stop`，机器人**照旧把这单做完**——单人场景下最直接的可用性事故。**这是"失控面"两处之一**（见第 八 节）。（源自 ②，静态确证）

---

## 7 重启守卫 10 秒：服务端只要在重启，agent 就会"永久死亡"且不再自愈
`mindcraft/src/process/agent_process.js:41-49`；现场 `mindcraft/run-live.err.log` 末行

**这是什么**：父进程（mindserver）在 agent 子进程退出后决定要不要重启，规则是"**距上次启动不足 10 秒就不再重启**"。

**问题**（日志原文）：
```
[LoginGuard] Connection Error: Error: read ECONNRESET
Disconnected: {"errno":-4078,"code":"econnrefused","port":25565}
Agent process exited too quickly and will not be restarted.
```
`run-live.log` 里 `Client connected` 出现 13 次。链条：MC 服务端没起来 → agent 连不上 → 进程退出 → 父进程看到"启动不到 10 秒" → **放弃**。Paper 重启一次通常 20~60 秒，**正好落在这个守卫的打击范围内**。

**最小修复**：指数退避 + 上限（`delay = min(2^n * 2s, 60s)`），只在"连续 N 次都在 10 秒内退出"时放弃。**最小一行**：把 `return` 改成 `setTimeout(() => this.start(...), 15000)`。

**不修会怎样**：任何一次服务端重启、网络抖动、端口未就绪，都会让 bot **永久下线**且不自愈——对"挂机跑一夜"是致命的。（源自 ⑤，现场日志）

---

## 8 玩家的东西实际上不受保护——**能拆玩家方块的路有 4 条，其中 3 条零有效保护**（v2.1 扩写：原只写"地标清单恒空"，现覆盖 J1/J2/J3/J4）
`landmarks.js:78-80`（读 `c?.pos`）对照 `landmarks.js:131`/`:203`/`:185`（写扁平 `{x,y,z}`）；测试侧 `tools/atom_classify_unit.mjs:68-69`

**这是什么**：`protectedPlaces()` 产出"不许挖的地方"清单，`flow_collect_plan.js:113` 拿它逐格过闸（`isProtected`），这是"砍树不砍到玩家建筑"的**唯一防线**。
**v2.1 扩写——这件事在代码里其实由四套互不相通的判定分摊，其中三套零有效保护**：

| 判定 | 位置 | 是什么 | 有没有用 |
|---|---|---|---|
| **J1** `isPlayerBuiltBlock` | `world_model.js:95-100` | **纯方块名匹配**（木板/玻璃/砖…） | 全树**仅 2 个调用点**：`skills.js:1190`（`placeBlock`）与 `:3973`（蓝图放置）——**都在"放置"侧，没有一个在"拆除"侧** |
| **J2** `NATURAL_BLOCKS` | `skills.js:3359-3388` | 与 J1 **语义相反**的"可拆白名单" | 它才是决定"铲平会不会毁房子"的真判据，而它**含 `farmland`**（`:3361`） |
| **J3** `protectedPlaces`+`isProtected` | `landmarks.js:78-80` → `query_classify.js:110` | "记住的地点不许挖" | **因字段 bug 恒空**（见下面第 1 点） |
| **J4** `breakBlockAt` | `skills.js:1007-1078` | 唯一的通用拆方块出口 | **零代码判定**，只有 JSDoc 警告 |

**逐场景精度**（12 分册口径）：圆石房子 ❌ 且被 `levelGround` 主动削平；泥土路 ❌；**农田 ❌**；村庄 ⚠️ 误判；箱子/工作台/床/门/火把 ✅ J1 判"是玩家建的"，**但 `breakBlockAt` 不看 J1、J3 恒空** → 砍树/误挖会把箱子连带拆掉（含内容）。

**问题（四条路径，每条一个具体后果）**：
1. **J3 恒空（原 v2 内容）**：三行读嵌套字段 `c?.pos`/`s?.pos`/`lm.storage?.pos`，但所有写入方写的都是扁平坐标（`rememberChest` 存 `{ ...n, note, lastUsed }`，`:131`；`rememberSite` `:203`；`rememberStorageArea` `:185`）。grep 全树确认没有任何地方往 chests/sites/storage 写 `pos` 字段。于是 `spots` 恒为 `[]`，`isProtected` 恒返回 `protectedBy:null` —— **这道闸从写出来那天起就没拦过任何东西**。
2. **J2 主动拆玩家方块（W1，v2.1 新增）**：`levelGround` 在 `size >= 5` 时走 `/fill` 快路径，对 `NATURAL_BLOCKS` 里 ~88 个名字**逐个**发 `fill … air replace <name>`（`skills.js:3419-3424`）。这**不可撤销**，而清单里的 `cobblestone`/`dirt`/`stone` 正是玩家铺地基与泥土路用的材料；**`farmland`（`:3361`）也在清单里** —— 农田只能由玩家用锄头造（`act_farm.tillSoil:167`），所以"铲平"会把玩家整片麦田清成空气、作物悬空。附带 `:3433` 的 `/fill … <filler> keep` 不检查背包有几个 filler → 凭空造方块。
3. **J4 零判定（W2，v2.1 新增）**：`breakBlockAt`（`skills.js:1007-1078`）对任何方块都挖，**没有 `wmIsPlayerBuilt` 检查、没有 `interrupt_code` 检查**。同一文件的 `placeBlock:1190-1195` 反而有这道闸（注释写着"这是历史上把一整片 5x5x4 木板结构拆光的根源"）。模型逐格扫过玩家房子，没有任何拒绝。
4. **测试层（为什么没人发现）**：`atom_classify_unit.mjs:68-69` 的夹具写 `[{pos:{x:100,…}}]` —— 正好是**读端**的形状，绕过了真实写入方。**测试通过时，生产是坏的**。`grep rememberChest tools/*_unit*.mjs` → **0 命中**。

**最小修复**：① `landmarks.js:78-80` 改取扁平坐标（3 行）；② 夹具改成调 `rememberChest(...)` 并**新增断言**：`rememberChest` 之后 `protectedPlaces(bot)` 必须非空；③ 从 `NATURAL_BLOCKS` 删掉 `farmland`（以及 `moss_block`/`moss_carpet` 这类玩家可放置的装饰块）；④ `/fill` 的填充分支加前置：`countInventoryItem(bot, filler) >= 需填格数`；⑤ **给 `breakBlockAt` 加 3 行 `wmIsPlayerBuilt` 守卫**（该函数本文件已 import，一行判断即可）。
**修法方向的一条反对意见（v2.1 保留，按 t13 的裁决）**：**不要**把 J1/J2/J3 合并成一套判定 —— J1（名字匹配）与 J2（可拆白名单）**语义相反**，强行统一会复活 `world_model.js:80-83` 记录过的真实 bug。正确方向是**新增一个位置型判据**（"这格是不是玩家放过/踩过的"），让"拆除侧"也有 J1 那样的正面判定。

**不修会怎样**：数据丢失。bot 会为了砍一棵树把玩家箱子/房子当树干挖掉；`levelGround` 会主动铲平玩家地基、泥土路与农田；而"已保护"的代码和日志都在，事后无从理解为什么没生效。（源自 ①④，静态确证；**v2.1 修订：标题与正文从"地标清单恒空"扩为四条路径 J1~J4，并合入 12 分册的 W1/W2**）

---

## 9 导航"单一驱动者"闸因为缺省 owner 全是同一个常量而失效——现场日志已实证，密度是每 150 行撞 2 次
`nav_core.js:189`、**`:50`（第二个同样的缺省）**、`:128`；现场 `tmp-t59-agent.log:164`、`:180`；驱动力 `flow_follow.js:154`

**这是什么**：`nav_core` 有一道闸："同一时刻只允许一个驱动者用 pathfinder"（`:89-111` 的注释记着它的来历：真机 1590 次 `dig false INTERNAL`）。

**问题（已实证）**：
- **接线层**：owner 缺省是常量 `'adhoc'`（`:189` 与 `:50` 两处）。任何没有任务单的调用拿到的 owner 全是 `'adhoc'`，命中 `_navOwner === owner`，于是**被判成"自己重入"，两条流同时通过**。
- **绕闸层**：另有 **12 处**直接驱动 pathfinder 的调用点根本不进这道闸：`flow_collect_plan.js:268/406/299`、`flow_collect.js:127`、`flow_follow.js:186/317/373/502`、`flow_platform.js:59`、`atom_tunnel.js:252/266/288`、`tool_prep.js:202`、`skills.js:1628/1798/2186/2261`。其中 `flow_follow.js:154` 在 `sleep(250)` 的 while 里直驱 `setGoal`。项目给 `flow_pickup` 修过同一类问题（`nav_core.js:34-43`），但只修了那一处。
- **现场密度**：293 行日志里 `The goal was changed before it could be completed!` 出现 **2 次**（`:164`、`:180`），每次紧跟 `Unpausing mode …` 块。
- **测试为什么没抓到**：`nav_lock_unit.mjs` 只调 `acquireNav('JOB_A')` 这类**显式且互不相同**的 owner，`grep adhoc` 在测试里 **0 命中**。缺陷正好落在被测属性用不上的地方。

**最小修复**：① owner 缺省改成每次唯一（`?? \`adhoc:${++_seq}\``）；② 12 处直驱点包进 `withNav`；③ 止血版：`restoreGoalModes` 在 `bot.pathfinder.isMoving()` 为真时延后恢复。

**不修会怎样**：每次"跟人/打怪/防卡"与"走任务路线"重叠，就白跑一轮规划；现场每 150 行撞 2 次。（源自 ①⑤，测试侧合自 ④；**已实测（现场日志）**）

---

## 10 `skills.digTunnel` 每次正常返回都抛 `ReferenceError`
`skills.js:5750`（`return ok({ steps: n, to })`，`ok` 从未 import）、`step_runner.js:149-154`（全部步骤失败仍 `return ok`）

**这是什么**：`digTunnel` 是模型可直接调用的技能（98 个导出经 `index.js:36-40` 全进技能目录）。

**问题**：`skills.js` 第 1~28 行的 import 清单里**没有 `contract.js`**，模块作用域也没有 `ok`。机器验证：`npx eslint src/agent/library/skills.js` → `5750:12 error 'ok' is not defined no-undef`。
**v2 修订：已实测崩溃**（t11）——用 stub bot 让 `digTunnel` 走正常返回路径，实测抛 `ReferenceError: ok is not defined`。因为上一行是 `if (!run.ok) return run;` 而 `runSteps` 全失败也返回 `ok:true`，所以**只要走到末尾就必抛**：这个技能在现版本中**从未成功返回过一次**。原稿"挖满 60 秒之后以异常收场"会被读成"偶发"，已改。

**最小修复**：① `skills.js` 顶部加 `import { ok } from './contract.js';`；② `step_runner.js:149` 改成 `if (failed.length && doneSteps === 0) return fail(...)`。

**不修会怎样**：该技能 **100% 抛错**，错误信息与挖掘逻辑无关；"全失败报成功"会让任何新增的 `runSteps` 消费方重蹈覆辙。（源自 ①④，**v2 修订：从"假成功"升级为"已实测必崩"；已实测**）

---

## 11 三道门禁没有任何一个被自动执行，所以 6 处 ReferenceError 和 39 条浮空 promise 全都活着
`.github/`（不存在）、`package.json`（无 `lint` 脚本）、`eslint.config.js:17`（`globals: globals.browser`）、`:18`（`ecmaVersion: 2021`）；实证 `npx eslint src/` → **319 errors**

**这是什么**：仓库有三道质量门：eslint（`no-floating-promise` 与 `no-undef` 都配成 `error`）、`tools/preflight.mjs`（1076 行自检）、`npm test` → `unit_all.mjs`。

**问题**：
- **没有任何自动触发点**：无 CI（`.github/` 不存在）、无 git hook、`package.json` 没有 `lint` 脚本、`eslint` 甚至不在 `devDependencies`。于是"配好了"等于"没配"。
- **6 处真的 ReferenceError 就躺在生产代码里**：`skills.js:5750`（`ok`，见第 10 条）、`modes.js:118/126`（`placed`）、`modes.js:133`（`walked`）、**`src/agent/npc/item_goal.js:163/164`**（`res` 未声明）。
  **v2 修订（降到"静默失效"）**：`modes.js` 那三处的变量确实未声明、分支可达（实测能进 self_preservation 火分支），**但被 `modes.js:466` 的 `execute()` try/catch 吞成一行 `console.warn`，不崩进程**。真实后果是"**身上着火→水桶灭火永久静默失效**"，不是"必崩"。`item_goal.js:163` 仍然必抛（`let res` 在 `:141` 的 `getNext()` 内，`execute()` 作用域无声明）。
- **39 条 `no-floating-promise`**：`modes.js` 23、`speak.js` 9、`conversation.js` 3、`skills.js` 2、`mindserver_proxy.js` 1、`init_agent.js` 1。
- **eslint 配置两行错**：`ecmaVersion: 2021` 太旧 → `src/models/*.js` 用了 class static field（`deepseek.js:6`）→ **20 个文件全部 `Parsing error`**（机器验证：`npx eslint src/models/` → 20 条）；`globals: globals.browser` 用错环境 → 57 条 `no-undef` 里 **51 条是误报**，把真正有价值的 **6** 条埋在噪音里。

**最小修复**：① `eslint.config.js:18` → `"latest"`；`:17` → `globals.node`（**两行，全场投入产出比最高**）。② `package.json` 加 `lint` 脚本 + `test` 串起 preflight。③ 任意一个触发点（一行 CI 或 `core.hooksPath` + pre-commit）。④ `no-undef` 与 `no-floating-promise` 设为**必须零**。

**不修会怎样**：门一直开着。第 10 条那个必崩的技能、以及 5 处同类缺陷，全部可被现成规则抓到，却全部活着。（源自 ④，**已实测**；v2 修订：modes 三处降级为"静默失效"、ReferenceError 数 6 处不变但严重度分层）

---

## 12 bot 侧日志没有时间戳：任何事故都定位不到秒，LLM 与技能耗时物理上算不出来
`mindcraft/tmp-t59-agent.log`（293 行中 `[HH:MM:SS]` 前缀 **0** 条）、`mindcraft/run-live.log`（85 行中 **0** 条）

**这是什么**：agent 侧全部 `console.log` 输出没有时间前缀；只有 Paper 服务端日志有 `[HH:MM:SS INFO]`。

**问题**：
- 无法判断 `tmp-t59-agent.log` 的 293 行横跨 3 分钟还是 3 小时；
- 那两次 `The goal was changed` 之间隔了多久**日志无法回答**——"偶发还是每拍都撞"这个定性也答不了；
- 因此"LLM 调用耗时""技能耗时排行"**在现有日志上物理不可能算**；
- `[DIG] … heldMs= 2382` 这类自带耗时的行无法与其他事件对齐时间轴。
- **v2 补充（更 upstream 的一层）**：即便加了时间戳，"**花了多少钱**"仍然算不出来——19 个模型适配器**没有一个记录 token 用量**（`grep usage × src/models` = 0，见第 31 条）。**两条必须一起修**。

**最小修复**：agent 入口给 `console.log`/`console.error` 包一层 ISO 时间前缀（一处改动）。

**不修会怎样**：每查一次事故都要靠"文件 mtime + 猜顺序"；性能优化无法度量收益；跨 bot/跨进程事件无法排序。**它是所有后续分析的前提，而且最便宜。**（源自 ⑤，**已实测**；v2 修订：补 upstream 一层）

---

## 21 `skills.attackNearest` / `skills.attackEntity` 能攻击玩家 —— 原子层写好的"不许打人"判定，模型这条路上没接
`mindcraft/src/agent/library/skills.js:695-714`（`attackNearest`）、`:716-751`（`attackEntity`）对照 `src/agent/library/act_attack.js:31-35`（`NOT_ATTACKABLE_TYPES` 第一项就是 `'player'`）、`:40-48`（`isAttackable`）

**这是什么**：两个模型可见的攻击入口。原子层有一整套"什么不该打"的判定，`isAttackable` 明确把 `player` 排除在外。

**问题（队长亲验）**：`skills.js` **全文零引用 `isAttackable`**。`attackNearest` 用 `find(entity => entity.name === mobType)`（`:706`）选目标——**玩家的 `entity.name` 就是用户名**；`attackEntity` 直接 `bot.pvp.attack(entity)`（`:733`）。于是：
```js
skills.attackNearest(bot, '某个玩家名')   // → 真的用 op 账号打人
```
同一个文件里的 `defendSelf`（`:765`）反而用了 `mc.isHostile`（不会打玩家），说明作者知道这个区别，只是这两条忘了。
**为什么这是 Must**：bot 在服里是 op，打玩家是不可逆的社交事故；而判定代码**已经写好了、就在隔壁文件**，只差一行接线。

**最小修复**：`skills.attackNearest` 在 `find` 之前加 `act_attack.isAttackable` 过滤；`skills.attackEntity` 开头加 `if (!isAttackable(entity)) return false;`（**共一行到两行**）。见路线图第一批。

**不修会怎样**：模型（或一次幻觉把玩家名当成生物名）就能让 op bot 打人，且没有任何一层会拒绝。（源自 11，**已实测（队长亲验）**）

---

## 22 `giveToPlayer` 的 `if (got)` 恒为真 —— 物品已经扔到地上，玩家没捡也报成功
`mindcraft/src/agent/library/skills.js:1598-1615`

**这是什么**：把物品丢到玩家脚下的函数，模型可见。

**问题**：`:1609` `const got = await waitUntil(bot, () => given, {…})` —— `skills.waitUntil` 返回的是**对象** `{ok, waitedMs, reason, label}`（`:60`），恒真。`:1611` `if (got) return true;` 于是**永远走这一支**：哪怕 3 秒内玩家一次都没捡（返回 `{ok:false, reason:'timeout'}`），函数也返回 true。而 `:1598` 的 `discard(...)` **已经把物品 `bot.toss` 到地上了** —— 玩家没接住，物品就躺在那里等 5 分钟消失。
**触发场景**：`skills.giveToPlayer(bot,'diamond','某人',5)`，玩家 AFK → 5 颗钻石掉地上 → 返回 `true`。

**最小修复**：`:1611` 改成 `if (got && got.ok) return true;`（一个 `.ok`）。

**不修会怎样**：交付类任务会**吞掉玩家的东西并谎报成功**，且日志里看不出没送到——物品是真的消失了。（源自 11，**已实测（队长亲验）**）

---

## 23 `levelGround` 把玩家的农田当"自然地形"填平，并且用 `/fill` 凭空造方块 —— 能拆玩家东西的路有 4 条，其中 3 条零有效保护
`mindcraft/src/agent/library/skills.js:3359-3388`（`NATURAL_BLOCKS` 含 `farmland`）、`:3414-3436`（`/fill` 快路径）、`:1007-1078`（`breakBlockAt` 零判定）；对照 `src/agent/library/world_model.js:95-100`（`isPlayerBuiltBlock`）

**这是什么**：`levelGround(bot,x0,z0,size,targetY)` 铲平一片地，模型可见、`size` 由模型给。

**问题（v2 新建，由 t16 的判定精度审计得出：4 条破坏路径里 3 条没有有效保护）**：
- **J1 `world_model.isPlayerBuiltBlock`（`:95-100`）= 纯方块名匹配**，全树**仅 2 个调用点**（`skills.js:1190` 的 `placeBlock`、`:3973` 的蓝图放置）——**都在"放置"侧，没有一个在"拆除"侧**。
- **J2 `levelGround` 的 `NATURAL_BLOCKS`（`:3359-3388`）= 与 J1 语义相反的"可拆白名单"**，它才是决定"铲平会不会毁房子"的真判据。而它**含 `farmland`（`:3361`）** —— 农田只能由玩家用锄头造出来（`act_farm.tillSoil:167` 干的就是这个）。于是 `/fill air replace farmland`（`:3421`）会把玩家整片麦田清成空气、作物悬空。它同时含 `cobblestone`/`dirt`/`stone`，**玩家铺的圆石地基和泥土路一样会被削平**。
- **J3 `protectedPlaces` + `isProtected`**（唯一调用点 `flow_collect_plan.js:113/119`）**因第 8 条的字段 bug 恒空**。
- **J4 `breakBlockAt`（`:1007`）零判定** —— 没有 `wmIsPlayerBuilt`、没有 `interrupt_code`（详见第 29 条 D16），却是 4+ 处破坏动作的共同出口。
- **附带**：`:3433` 的 `/fill … <filler> keep` **凭空造方块** —— `filler` 只是从背包"挑个名字"（`:3426-3429`），**不检查背包有几个**。模型可以无成本造出 50×50×20 的土方块。

**逐场景精度**：圆石房子 ❌ 且被 `levelGround` 主动削平；泥土路 ❌；**农田 ❌**；村庄 ⚠️ 误判；箱子/工作台/床/门/火把 ✅ J1 判"是玩家建的"，但 `breakBlockAt` 不看 J1、J3 恒空 → **砍树/误挖会把箱子连带拆掉（含内容）**。

**最小修复**：① 从 `NATURAL_BLOCKS` 删掉 `farmland`（以及 `moss_block`/`moss_carpet` 这类玩家可放置的装饰块）；② `/fill` 的填充分支加前置：`countInventoryItem(bot, filler) >= 需填格数`，不够只做"削高"不做"填低"；③ 给 `breakBlockAt` 加 3 行守卫（`wmIsPlayerBuilt` 本文件已 import，见第 29 条）。

**不修会怎样**：玩家的农场、地基、泥土路会被"铲平"功能清掉；而"凭空造方块"让模型能用一条命令生成任意体量的人造地形。（源自 12，**静态确证**）

---

## 24 schema 不匹配也会走"当坏库→改名→重建"：**无需任何并发**，加一列就让旧库被当坏的
`mindcraft/src/agent/library/board_store.js:163-201`（`openBoard` 的重建兜底）、`:89-134`（`CREATE TABLE IF NOT EXISTS`，无 `PRAGMA user_version`）、`:319-323`（INSERT 显式列名）

**这是什么**：`openBoard` 把 `tryOpen()` 的**任何**异常都当成"库损坏"。

**问题（v2 新增，t11 已实测）**：`no such column: priority`（schema 版本不匹配）走进**同一条**「当坏库→改名→重建」路径，而且**不需要任何并发、不需要任何外部进程**——只要代码里给 `jobs` 加了一列、而磁盘上是旧库，第一次 INSERT 就报这个错。
**这比 BUSY 更容易触发，也更致命**：本报告 `S9` 早就写过"加一列会让所有新单被静默拒绝"，v2 实测补充：**它还会顺手把旧库改名成"坏库"**。也就是说 `S9` 的后果不止"新单被拒"，还包括"整个任务列表被当成损坏文件"。
（`memory_store.js:27` 的 JSON 文件已有 `_v` 字段，但**没有任何代码校验/升级它**，属同一类欠账。）

**最小修复**：① 按第 3 条的收窄判据（只在 `SQLITE_CORRUPT`/`NOTADB` 时重建）——这一条同时修好第 3 条和本条；② `openBoard` 里加幂等迁移：`PRAGMA user_version` 读版本 → `if (v < 2) { try { db.exec('ALTER TABLE jobs ADD COLUMN deadline INTEGER'); } catch {} db.exec('PRAGMA user_version = 2'); }`。

**不修会怎样**：任何一次加列/改列 = 上线后"任务板只读"**且旧库被当成损坏文件改名**，要等有人去看日志才知道。（源自 ②⑨，**已实测**）

---

## 25 `memory_store.readStore` 损坏时静默返回空值且不备份，下次写永久覆盖
`mindcraft/src/agent/library/memory_store.js`（`readStore` 的 `catch` 分支）；对照 `board_store.js` 会留 `.corrupt-` 备份

**这是什么**：`memory_store` 是地标/危险点/箱子/任务的 **JSON 持久化层**（`landmarks`/`world_model`/`skills` 都经它读写）。

**问题**：JSON 解析失败时 `readStore` **静默返回空值**（`{}` / `null`），既不告警也不备份。下一次 `writeStore` 就把空集合写回去 → **原文件被永久覆盖**。而同一仓库的 `board_store` 遇到坏库至少会 `renameSync` 留一份 `.corrupt-*`。后果：一次半截写（断电/被杀）就抹掉这只 bot 全部的：
- 记住的工地/死亡点/箱子位置（`sites`/`chests`/`storage`）；
- 危险点（`dangers`）—— 直接影响"这里危不危险"的判据；
- 长任务的进度（`tasks`，`recordTaskProgress` 写的）。

**最小修复**：`readStore` 的 `catch` 里先把原文件 `copyFileSync` 成 `<name>.corrupt-<ts>` 再返回空值，并 `console.warn` 一行。

**不修会怎样**：一次异常写 = 这只 bot 的全部位置记忆与任务进度被静默清空，且**没有任何痕迹**说明是被自己覆盖的。（源自 12，**静态确证**）

---

## 26 ★ preflight 的错误码审计是一道**假绿灯**：两个正则里各混进了一个 0x08 退格符 —— 这道门从上线起没检过任何东西
`tools/preflight.mjs:183`（两条正则）、`:933`（扫描器自测的指纹识别正则）

**这是什么**：preflight §[3/4] 里那段"错误码审计"：用两条正则扫 `src/**/*.js`，求 `used \ CODES`，非空就 `failed++` 并打印「✗ 有 N 个错误码没注册」。

**问题（定案过程，每一步可复现；本轮我与队长各自独立验过）**：
1. t17 先报了矛盾：用 preflight **自己的判据**单独跑得到 `missing2 = ['DIED']`，但正式 `node tools/preflight.mjs` 打印「✓ 错误码审计通过（38 个已注册，全部合法）」。
2. 复刻 `:175-190` 的扫描逻辑单跑：`扫描文件数 162`（与正式跑一致）、`未注册的码 ['DIED']`、`DIED 出现在 ['src\\agent\\library\\control.js']`；另单独确认 `CODES.length = 38`、`CODES.includes('DIED') = false`。
3. `sed -n '183p' tools/preflight.mjs | od -c` → `/` 后面跟的是**一个单字节 0x08**（`od -c` 显示 `\b`），然后才是 `fail`：
   ```
   [ / \b f a i l \ ( \s * ' ( [ A - Z _ ] + ) ' / g , / \b c o d e : …
   ```
   **源码里要写词边界是两个字符 `\` + `b`；这里只有一个 0x08 字节。** 于是正则变成「`fail` 前面必须有一个退格符」→ **永远匹配不到任何东西**。
4. 全仓污染范围（只有这一个文件）：`grep -rln $'\x08' --include=*.js --include=*.mjs src tools` → `tools/preflight.mjs`，共 **2 行**：`:183`（两条错误码正则）与 `:933`。
5. **我用探针逐条验了（`docs/audit/probes/t13-regex-check.mjs`，可复跑）**：
   ```
   含 0x08 的行号: 183, 933
   "/\bfail\(\s*'([A-Z_]+)'/g"   含0x08=true  命中样本=[]      ← 永远不命中
   "/\bcode:\s*'([A-Z_]+)'/g"    含0x08=true  命中样本=[]
   正确写法（\b）: /\bfail\(\s*'([A-Z_]+)'/g 命中=["fail('DIED', 'x')"]
                  /\bcode:\s*'([A-Z_]+)'/g   命中=["code: 'DIED'"]
   control.js: fail('DIED' 出现 0 次；code: 'DIED' 出现 3 次
   ```

**后果（两句，第二句与队长的推断有一处不同，按实测写）**：
- **`used2` 永远是空 Map → `missing2` 永远为空 → 永远走 `else` 打印「✓ 错误码审计通过」**。这道门**从上线起就没检过任何东西**；`DIED` 只是第一个被它放过的东西，以后任何未注册的错误码都会被放行。而"错误码没注册 → `fail()` 直接 throw"是已经炸过 4 次的坑（`:160-163` 自己写的），这一层恰恰是唯一挡它的门。
- **`:933` 那处 0x08 只坏了三条备选之一，另外两条是好的**（实测：`/──\s*A·|\x08A·策略|未发现"…"/` 对 `"── A·策略"` **仍然返回 true**，对 `"A·策略"` 返回 false）。所以 §[6] 那道常驻红灯**不是**这个退格符造成的——它在本沙箱是 `deps_injection_audit` 子进程 spawn 被 EPERM（我上一轮就是这么归因的，v2 维持）。**这点与队长补充里的推断不同，以本条实测为准**；方向上都 fail-closed，没有造成假绿，但**这意味着 `:933` 的修复不会让红灯消失**，别把它当成"§6 修好了"。

**这条为什么是 Must 且是全仓"门禁给假安全感"的最强例证**：项目专门写了 t99 护栏（`requireScanned`，`:33-39`）来防「扫到 0 个样本 → 打 ✓」，并在注释里反复强调"**'什么都没检测到'和'检测了、没有'在报告里长得一模一样**"。但这道护栏防的是「输入为空」，**没防「扫描器自己写坏了」**——正则连一个字都匹配不到时，`used2` 是空的、`missing2` 是空的、`requireScanned` 看的是 `files2.length`（162，非空）→ **一条护栏都拦不住**。这与 t99 的设计者想防的是同一件事，只是发生在更下面一层。

**最小修复（5 分钟）**：把 `:183` 两处、`:933` 一处 0x08 换成真正的 `\b`（或直接删掉）。改完跑 `node tools/preflight.mjs`，应看到 **「✗ 有 1 个错误码没注册：DIED」**。然后二选一：
- 把 `DIED` 注册进 `CODES`（它现在是 `control.js:188/192/443` 的 `result:{code:'DIED'}` 数据载荷，**`fail('DIED'` 出现 0 次**，注册它只是让口径统一）；
- 或按下面的口径修正，把 `code:` 那条正则收窄成只扫 `fail('X'`——因为 `DIED` 这类"数据载荷里的 code"本来就不该被当成 ActionResult 的错误码。

**顺带纠正如下的旧结论**：t4 的 T8 报"`DIED` 不在 CODES"**没说错**，错的是审计口径（该只扫 `fail('X'`，不该把 `code:` 一起扫）；t17 的 P7 矛盾**现已定案**，不再写"待现场复核"。
**建议加一条护栏**（与 t99 同级）：给每条审计正则配一个**自测样本**——"这条正则必须能匹配到已知存在的字符串"，匹配不到就判失败。这正是 `:933` 那道 selftest 想做的事，只是它自己被 0x08 咬掉了一条备选。

**不修会怎样**：错误码审计**永久假绿**；任何新写的 `fail('XXX')` 用了未注册的码，都会在运行期才炸，而报错（`fail(): 非法 code "XXX"`）不指向根因。（源自 13/09，**已实测（探针 `t13-regex-check.mjs` 可复跑）**）

---

## 27 闸门与被索引的文档都盯着**已作废的对象**：文档索引把"自称已过期"的交接文档当现况手册，裸常量棘轮被放宽 9 个名额
`docs/README.md:81`、`mindcraft/docs/交接文档.md:3-4`、`tools/preflight.mjs`（`const DOC='docs/交接文档.md'`）、`src/agent/rules/audit_baseline.json`（`count=14`）、`tools/audit_rules.mjs`

**这是什么**：两处"元层"设施——① 文档索引与 preflight 的交接文档漂移检查；② 一个叫"裸常量棘轮"的闸门（防"凭印象写魔法数字"）。

**问题（v2 新增，t12 实测）**：
- **F1**：`docs/README.md:81` 把 `交接文档.md` 当「现况手册」推荐；而 `交接文档.md:3-4` 自己写着「本文是 2026-10-24 快照…现在的权威交接是 `架构交接-总.md`」。`grep -c "架构交接-总" docs/README.md` = **0**（权威那份根本不在索引里）。更关键：**`tools/preflight.mjs` 的漂移检查盯的正是那份自称作废的文档**（`const DOC='docs/交接文档.md'`）→ 护栏守的是一份它自己承认过期的文件。
- **F2**：`src/agent/rules/audit_baseline.json` 的 `count=14`，但实测**只有 5 条指向存在的文件，9 条指向已删文件**（`atom_perceive`×2 / `atom_dig` / `atom_move` / `task_collect`×4 / `tile_map`）。`audit_rules.mjs` 只比 `violations.length > base.count`、**从不校验条目的 `file` 是否还存在** → **棘轮被放宽 9 个名额**：真实存量仅 5 处，却可按 14 放行。这是全仓唯一一道防"魔法数字漂移"的自动闸门。

**最小修复**：① `docs/README.md:81` 改成指向 `架构交接-总.md`，并把 `交接文档.md` 标注为历史快照；`preflight.mjs` 的 `DOC` 常量改成 `'mindcraft/docs/架构交接-总.md'`。② `audit_rules.mjs` 在比 `count` 之前加一句：**逐条 `existsSync(entry.file)`，不存在的从基线里剔掉并判失败**（让它自己缩回去）。

**不修会怎样**：① 下一个接手的 agent/人按索引读到的是三天前的过期手册，而"文档漂移检查"这道护栏会替他确认"文档不比代码旧"（因为它盯的是错的那份）；② 裸常量棘轮可以慢慢放进 9 个新违规而不报警。（源自 10，**静态确证**；同批已知：`legacy/` 被引用的 9 个链接全部有效、`LICENSE` 版权行与 MIT 全文完整合规 —— 这两项**不是**问题，避免下一个人重复排查）

---

# 二、Should fix

> 13~20 是 v1 的 Should；28~34 是 v2 新增。

## 13 `!survey` 默认半径 64 的整球同步扫描：单次 ≈110 万次方块读取，且没有任何上限保护
`skills.js:5402`（签名默认 `radius = 64`）→ `:5427-5428`（`scanSphere`）→ `terrain3d.js:277-307`；`map_query.js:52` 同路

**这是什么**：`scanSphere` 是**同步**函数：对球内每一列、每一格调一次 `bot.blockAt`，并先对该列发一条 SQL `DELETE`（`terrain3d.js:305`）。代价是球体积 `4/3·π·r³`。

**问题**：模型默认调 `skills.surveyArea(bot)`（不传 radius）→ r=64 → 访问约 **110 万**格、对 **12,868** 列各发一次 DELETE，全在一个同步事务里。`!map refresh` 走 `map_query.js:40` → `:45` `spanBlocks=64` → `:52-53` 同一条路。**代码事实：无节流、无上限、时长随 r³ 增长。** 对照 r=24 → 5.8 万格、r=36 → 19.5 万格。
**因果链已作废**：v1 原写"这就是掉线原因（2.3 秒 loop-lag）"。项目自己的诊断原话是 `run-live.log:39`：`[disconnect-diag] 事件循环延迟最大 162ms（正常，不是阻塞导致）`。本条成立的理由改为**结构性无上限**，不再引用"踢人"。

**最小修复**：`surveyArea` 默认改 24，`scanSphere` 入口把 `radius` 硬夹到 `≤32`；`map_query.js:53` 改 `Math.min(32, Math.max(16, spanBlocks))`。

**不修会怎样**：模型每次"看看周围"都付 110 万次读取；在秒级指令节奏下成为稳定 CPU 尖峰源，而换来的信息量与 r=24 几乎没差别。（源自 ①，**静态确证 + 反证已实测**）

---

## 14 `listJobs` 的 `LIMIT 200`：累计 200 张单之后，新单进不了调度器视野，抢占静默失效
`board_store.js:378-382`、`board_scheduler.js:426`/`:456`

**这是什么**：`jobs` 表只增不减（`:1082` 自述），客户端"镜像"靠 `refresh()` 拉一次覆盖，默认走 200 条上限。排序 `priority DESC, createdAt ASC` —— **同优先级下取最老的 200 条**。

**问题**：现库 22 张；每跑一次 `!do first_night` 约新增 7 张。到 ~200 张后：新加的共享单排在窗口外 → `_findPreemptor`（`:719-729`）看不到新来的 9 级单 → **抢占彻底失效**；`requeueStaleBrief`/`jobsBusy`/`_resumeOwnPaused` 全在同一份被截断的镜像上判断；面板 `board:list` 同样只显示 200 条且没有总数。

**最小修复**：`listJobs` 加 `openOnly` 参数，SQL 加 `AND state NOT IN ('done','failed','cancelled')`；`refresh({scope:'claimable'})` 一律带上（**把过滤放进 SQL**）。

**不修会怎样**：跑过几十轮的存档会静默退化成"没有抢占、残局没人收"，不报错。（源自 ②，静态确证）

---

## 15 租约过期回收不记 `attempts`：崩一次就无限重试，而合成单每重试一次就真扣一次材料
`board_store.js:668-684`（`expireLeases` 只改 state/lease）、`:53-63`、`:636`

**这是什么**：`attempts` 只在 `finish()` 里按结果码递增。

**问题**：进程被杀/断网被回收时**根本没有 finish**，`expireLeases` 是唯一会碰这张单的地方，而它**一个字都不动 `attempts`**。于是"跑到一半把进程搞死"的单 → 租约 30 秒后回 `ready` → 再领 → 再死，**`attempts` 永远是 0**，`maxAttempts=3` 永不达成。而重复执行的副作用**不幂等**：`craft` 单每跑一次**真的**扣一次材料（`act_craft.js:375-417` 的 `produced` 是"这一次做了几个"，没有"这张单已产出过"的账）。

**最小修复**：`expireLeases` 的 UPDATE 加 `attempts = attempts + 1`，`attempts+1 >= maxAttempts` 时置 `failed`（`result.code='LEASE_EXPIRED'`）。

**不修会怎样**：一张"一跑就弄死 bot"的单让 bot 起不来；合成类单被重复扣料。（源自 ②，静态确证）

---

## 16 箱子内容"读-改-写"跨两次 socket 往返：两个 bot 同时存东西，先写的被整个覆盖
`flow_store.js:74-88`

**这是什么**：箱子内容用增量合并（存 +N / 取 -N），两次往返之间没有原子性。

**问题**：A 与 B 同时往箱子 X 存东西：t1 A 读 `{}`；t2 B 读 `{}`；t3 A 写 `{oak_log:5}`；t4 B 写 `{stone:3}` —— **A 的 5 个木头被整个覆盖**。之后 `strat_obtain.js:710-712` 按板库找材料会认为箱子里没有木头，重复去砍。

**最小修复**：在 store 加服务端合并函数 `mergeSharedChest(db,key,delta,owner)`（事务内 SELECT→合并→UPDATE）；`board_server` 加 `board:shared-merge` 事件。

**不修会怎样**：两个 bot 共用仓库时箱子账目随机丢项，且丢得没有痕迹。（源自 ②，静态确证）

---

## 17 拆单中途崩溃 → 一个永久 `running`、没有子单的幽灵父单，没有任何路径会再碰它
`board_store.js:1175-1207`（`splitByCount`，全程无事务）、`:1113-1114`（`if (!kids.length) continue;`）

**这是什么**：拆单是"1 次父单插入 + N 次子单插入"，每次独立提交。

**问题**：进程在第 2 次 `addJob` 之前死掉 → 库里有 `running` 父单、0 子单。`convergeOrphanParents` **明确跳过**无子单的父单（`:1114`）；`rollupParent` 返回 `no-children`；`claimFor` 只领 `ready` → 这张单**没有任何路径会被再处理**，也不报错。它还会让 `jobsBusy()` 一直算"忙"，`self_prompter` 于是不催。

**最小修复**：在 scanTimer（`board_server.js:402`）加一条 `SELECT id FROM jobs p WHERE p.state IN ('running','ready') AND NOT EXISTS(SELECT 1 FROM jobs c WHERE c.parentId=p.id) AND p.createdAt < now-120000` → `setState(BLOCKED)` + `result.code='ORPHAN_PARENT'`。

**不修会怎样**：每出现一次"拆单中途崩溃"就永久多一张幽灵父单；面板显示"还在跑"。（源自 ②，静态确证）

---

## 18 65% 的测试脚本不在门禁里：44 个 `test_*.mjs` 只有 2 个注册，42 个是孤儿
`tools/unit_all.mjs:24-90`（手写白名单 `UNITS`）、`:107`

**这是什么**：`unit_all.mjs` 用一份手写清单决定跑什么。

**问题**：`tools/` 现有 **44** 个 `test_*.mjs`，只有 2 个（`test_escape`、`test_tunnel`）在清单里；`atom_all.mjs` 也一个都没有。剩下 **42 个**彻底孤儿：**13 个纯离线、本该进 `unit_all`**（`test_climb`/`test_codes`/`test_collect_targets`/`test_context_trim`/`test_goto_wiring`/`test_mca_import`/`test_memory_cap`/`test_nav_opt`/`test_path3d`/`test_reconnect`/`test_s0_afk`/`test_terrain3d`/`test_tile_map`）；29 个需要服务端。
机制根因：`unit_all.mjs` 没有任何"新测试必须注册"的检查（没有 `readdirSync`）。
**v2 修订两处**：① 原稿说"这 13 个里已有 4 个坏了"——这 4 个的失败**全部归因环境**（EPERM / 换 cwd 导致的 ENOENT），**不是断言失败**（见第 九 节与 t11 的测试成绩单）；② `test_codes` 的 FAIL **不是误报**——它报 DIED 未注册是对的，错的是它自己把 `code:` 数据载荷也当成了错误码（见第 26 条）。

**最小修复**：把 13 个离线脚本加进 `UNITS`；`UNITS` 改 `readdirSync('tools').filter(/_unit\.mjs$/)` + 显式排除表。

**不修会怎样**：README 承诺的 8 套 156 项里，6 套已不在任何总入口内。（源自 ④，静态确证 + v2 修订）

---

## 19 单个 bot 的退出码 >1 会连带 `process.exit` 掉整个 mindserver
`agent_process.js:37-40`；触发源 `agent.js:496` 与 `:862-864`

**这是什么**：父进程看到 agent 子进程退出码 >1 就 `process.exit(code)`。

**问题**：这条路径上挂着**运行期也会发生**的触发点：`agent.js:496` 的 `checkAllPlayersPresent()` 缺人时 `cleanKill(…,4)`；`:862-864` 任务结束 `killAll()` → `serverProxy.shutdown()`。场景：`tasks/*.json` 里写的人有一个没进服 → 退出码 4 → **mindserver 整体退出**，同机其它 bot、面板一起没。

**最小修复**：`agent_process.js:37-40` 改为只清该 agent（`logoutAgent` + 从 `agent_processes` 删除自己），**不调 `process.exit`**。

**不修会怎样**：缺一个人就让整套服务退出，现场看起来像"面板自己崩了"。（源自 ③，静态确证）

---

## 20 `skills.js` 的 98 个导出与原子层是两套实现，且已经分叉——而它们全部对模型可见
`skills.js:5173`（`isSafeHere`）、`:1007`（`breakBlockAt`）、`:1915`（`goToPosition`）、`:1734`（`goToGoal`）、`:800`（`collectBlock`）、`:2675`（`digDown`）；暴露面 `index.js:36-40` → `skill_library.js:52-64`

**这是什么**：`getSkillDocs()` 把 `skills.js` 的全部导出做成"技能目录"注入 prompt，里面每个函数都是**活代码**。

**问题（v2 已把整表核实完，不再抽样）**：98 个导出 = **10 个真转发** + **33 个有原子/动作层对应物但独立实现** + **55 个唯一实现**；其中**「同一规则给出不同答案」已逐行核实 12 条**（v1 只报了 3 条）：
`waitUntil`（**对 `false` 的判定两边相反**，而模型拿到的是错的那份）、`loadFurnace`（不查输入槽→覆盖别人正在炼的料，原子侧 `act_craft.furnaceBusyWith:451-472` 有 `OCCUPIED`）、`breakBlockAt`（不查 `interrupt_code`、距离 `4.5` vs `5.1`）、`equip`（不查中断/不验证）、`takeFromChest`（按"打算取多少"计数，窗口关掉也返回 true）、`putInChest`（无窗口校验）、`canReach`（**4.3 vs 5.1**）、`isSafeHere`（敌对生物上限硬编码 1 vs 全数）、`attackNearest`/`attackEntity`（**能打玩家**，见第 21 条）、`placeBlock`（**先拆后放** vs `act_place` 目标被占直接 `OCCUPIED`）、`goToBed`（不判"白天睡不了"）。

**最小修复**：先做三件低成本、高收益的：① `skills.isSafeHere` 改成 `query_safe.isSafe(...)` 薄包装；② `breakBlockAt` 补 `interrupt_code` + 距离判据同源；③ `attackNearest`/`attackEntity` 接 `isAttackable`（第 21 条）。中长期把「真转发」那 10 个删掉、调用方直连原子层（见第 十三 节 Lean）。

**不修会怎样**：模型按目录选函数，选到旧那份就得到不同判据；而每修一次原子层，旧复制品的分叉就更深一层。（源自 ①，**静态确证（§2 表 98 条零未核实）**；v2 修订：3 条 → 12 条，并给出 10/33/55 的精确分解）

---

## 28 `useToolOn` 的守卫 `!bot.game.gameMode === 'creative'` 恒假 —— "没有工具"检查从来没生效
`skills.js:2760`

**这是什么**：`useToolOn(bot, toolName, targetName)` 开头检查"有没有这个工具"。

**问题**：`if (!bot.inventory.slots.find(...) && !bot.game.gameMode === 'creative')` —— `!` 比 `===` 绑得紧，所以后半是 `(!gameMode) === 'creative'`。`gameMode` 是非空字符串 → `!gameMode` 恒 `false` → `false === 'creative'` 恒 **false** → 整个条件恒 false，**"You do not have any X to use" 这条早退永远不执行**。没工具也照常往下走，直到 `equip` 失败。
**为什么单列一条**：这是本文件**第 2 个恒假守卫**（第 1 个是 `:571` 的 `if (!walk)`，第 3 个是 `:1609` 的 `if (got)`，第 4 个是 `:5080` 的无效排序）—— 见第 六 节。

**最小修复**：把 `!` 挪到比较右边：`if (!bot.inventory.slots.find(...) && bot.game.gameMode !== 'creative')`（一个字符）。

**不修会怎样**：那句本意是"提前拦住、省一次失败"的话白写；日志里会看到 "Could not equip X" 而不是清晰的 "you don't have any X"。（源自 11，**已实测（队长亲验）**）

---

## 29 命令白名单在 `skills.js` 里有**两处**被裸 `bot.chat` 绕过，而 preflight 的正则看不见
`skills.js:1026-1031`（`breakBlockAt` 的 cheat 分支）、`skills.js:3998-4000`（`buildFromSchematic`）；对照 `atom_input_misc.js:63-78`（唯一合法出口）、`preflight.mjs:339`（`slash-command-owner` 正则）

**这是什么**：全系统约定"斜杠命令只许从 `atom_input_misc.command()` 出去"（那里有 `slashVerdict` 白名单 + `cheat`/`level` 两层判定）。

**问题**：
1. **`breakBlockAt:1026-1031`**：cheat 分支自己拼 `'/setblock x y z air'` 然后 **`bot.chat(msg)` 裸发**（`:1029`）。
2. **`buildFromSchematic:3998-4000`**：`const cmd = '/setblock ' + wx + … ; bot.chat(cmd);`（`:4000`）。
3. **两道门都看不见**：preflight 的 `slash-command-owner` 模式是 `/bot\.chat\s*\([^\n]*?['"\`]\s*\//` —— **要求同一行有字面量 `/`**，而这两处实参都是变量 → 不匹配。另外 `chat-via-openchat` 规则的 `allow` 名单里**直接写着 `skills.js`**（`preflight.mjs:351`），该文件的 `bot.chat` 本来就豁免。
4. **同文件有 5 处正确写法**（`command(bot,'setblock',…)` 在 `:1144/1147/1150/4714/4741`）→ 说明这是漏的，不是设计。

**最小修复**：两处都改成 `await command(bot, 'setblock', [x,y,z,state], { cheat: true })`（各一行）。

**不修会怎样**：命令白名单这条安全不变量在生产里有 **2 个常开后门**；任何"内容 → 命令"的注入都能从这两处过（蓝图里的方块名就是文件内容）。（源自 11，静态确证）

---

## 30 `novita.js:47` 的语境超长重试**必然抛 ReferenceError**（`sendRequest` 缺 `this.`）
`src/models/novita.js:47` 对照 `deepseek.js:44`（`this.sendRequest`）

**这是什么**：novita 的"超长→截断重试"分支。

**问题**：`:47` 写的是 `return await sendRequest(turns.slice(1), systemMessage, stop_seq);` —— **模块作用域里没有 `sendRequest`**（它是类方法）。一旦触发（长对话必然触发），抛 `ReferenceError: sendRequest is not defined`，而且**是在 catch 块里抛**，直接冲出 `sendRequest`，prompter 无 catch → 未处理的 Promise rejection。
**这与第 10 条 `skills.js:5750` 的 `ok` 未 import 是同一类**（返回值构造用了不存在的标识符）；而 preflight §[1] **抓不到**（它只 `import` 模块、不执行函数体）。

**最小修复**：`this.` 三个字符。

**不修会怎样**：使用 novita 的 bot 在第一次长对话时崩溃/静默失联；而其它 10 个适配器同名分支都是对的 —— 只这一处漏了。（源自 13，**已实测（队长亲验）**）

---

## 31 模型层把失败**伪装成模型的话**返回，且全层零 token 记录 —— "花了多少钱、慢在哪"结构上算不出来
`src/models/openrouter.js:51`、`gpt.js:84`、`deepseek.js:47`、`claude.js:54` 等 **16 处**；`prompter.js:246/291/301/316/337`；`grep usage × src/models` = 0

**这是什么**：19 个适配器的 `catch` 与返回值契约。

**问题（两件，互为因果）**：
1. **16 处 `catch { res = 'My brain disconnected, try again.' }` 后 `return res`**。`sendRequest` 的返回类型是 `Promise<string>`、**没有 ok/code 通道**，所以 prompter 拿到的"回答"与一次真实的模型输出**同形**：会写进 history（`agent.js:608`）、**真的对玩家说出来**（`agent.js:649` → `routeResponse`）、并消费掉一次 response 预算。另有 `openrouter.js:41` `'No response received.'`、`ollama.js:35` `'No response data.'` 这两句更像系统状态，会让模型下一轮基于它推理。
2. **零 usage**：19 个适配器只取 `choices[0].message.content`，**没有一个读 `completion.usage`**；而契约是 `=>string`，即使想返回也没有传递通道。→ 这就是第 12 条"S29 / usage 不可测"的**根因链第 ①② 跳**。
3. **配套的 429 空缺**：`hyperbolic`/`ollama`/`replicate` 三个走裸 `fetch`，**没有 429 重试**（openai/anthropic SDK 那层默认重试它们没有）；`ollama.send():91-94` 还把网络异常**吞成 null** → 上层看到 "No response data." 且永不重试。

**最小修复**：① 16 处兜底串换成带标记的 `'[LLM_ERROR] …'`，并在 `agent.js:599` 之前加一句"遇到该标记就当空响应 break"，不写 history、不发玩家；② 新增 `src/models/_usage.js`（约 12 行 sink）+ 每个适配器在取 content 前插一行 `recordUsage(completion.usage, this.model_name)`（openai 系 13 个都能这么做，claude 用 `resp.usage`）。

**不修会怎样**：所有模型层故障都被记账成"模型说了句话"→ 成本/失败率不可统计、玩家看到莫名台词、history 里全是假回答；而成本永远无法核算。（源自 13，**静态确证**；usage 缺口的因果链已闭合）

---

## 32 `agent.js` 的 300ms 心跳 `while(true)` 没有 try/catch —— 一次异常永久停掉心跳
`src/agent/agent.js:807-820`

**这是什么**：`startEvents()` 末尾起的更新循环：每 300ms `await this.update(...)`，`update` 里跑 `modes.update()` / `self_prompter.update()` / `checkTaskDone()`。

**问题**：`setTimeout(async () => { while (true) { await this.update(start - last); … } })` **整段没有任何 try/catch**。`update()` 内部任一抛出，这个 async IIFE 就**永久退出**，异常成为 unhandled rejection（Node 只打一行 warning）。后果：**mode 不再更新、self_prompter 不再推进、任务完成不再被检测** —— 而进程还活着、面板还显示在线、玩家发消息仍然有响应，**只是"她自己不会动了"**。这是最难查的一类"半死"。

**最小修复**：把 `await this.update(...)` 包一层 `try { … } catch (e) { console.log('[update] 心跳内异常（已忽略，循环继续）：' + String(e?.message ?? e).slice(0,160)); }`。

**不修会怎样**：一次偶发异常让 bot 变成"只会聊天、不会做事"，且重新发消息也没用（心跳不靠消息驱动），只能重启。（源自 13，**已实测（队长亲验）**）

---

## 33 `goToGoal` 全程不看 `interrupt_code` —— 单次最长 180 秒不可中断
`skills.js:1734-1815`（`GOTO_HARD_LIMIT_MS = 180000` 在 `:1794`）；同族 `useDoor:2263`、`goToBed:2337`

**这是什么**：`goToGoal` 是所有 `skills.goTo*` 的底层，内部 `Promise.race(bot.pathfinder.goto(goal), 180s 硬超时)`。

**问题**：整个函数（含两条 `getPathTo`，各 1000ms 预算）**没有任何 `bot.interrupt_code` 检查**。玩家按 `!stop` 后最长要等 **180 秒**才返回，且返回的是"超时"不是"被取消"。同族还有两处：`useDoor:2263-2265` 的 `while (bot.pathfinder.isMoving()) await sleep(100)` **无超时、无中断**；`goToBed:2337-2339` 的 `while (bot.isSleeping)` **睡到天亮、无中断**。
（对照：`skills.stay:2226` 与 `wait:301` 的 while 条件里都有 `!bot.interrupt_code` —— 这个模式在本文件里**有的地方写、有的地方忘**。）

**最小修复**：`goToGoal` 的 race 里加第三支 `interruptPoll`（每 200ms 查 `interrupt_code`，命中就 `pathfinder.stop()` 并 reject 成 INTERRUPTED）；`useDoor`/`goToBed` 的两个 while 各加 `&& !bot.interrupt_code`。

**为什么它不算"失控面"**：它的**上界是 180 秒**（有界），与第 八 节那两条"永久不停"不同类。为避免误读，本报告**不把它放进失控面**，只作为独立的中断缺陷记录。

**不修会怎样**：玩家按停后机器人还在走/还在睡最多 3 分钟；`goToBed` 甚至能"睡一整夜"。（源自 11，静态确证）

---

## 34 `preflight.mjs:78-80`：`loaded < files.length` 时仍打印「✓ 所有模块导入成功」
`tools/preflight.mjs:72-80`

**这是什么**：§[1] 模块导入段的收尾。

**问题**：`:72-74` 对"非 ReferenceError / 非模块缺失"的导入失败**静默跳过**（`else { /* 其他错误在导入阶段不致命 */ }`），既不计 `failed` 也不计 `loaded`。于是 60 个文件因 `TypeError`（缺全局、循环依赖 TDZ）导入失败时：`loaded=62`、`failed=0` → 打印 **`✓ 所有模块导入成功（62/122）`** → **exit 0**。那句 "✓ …成功" 与括号里的 62/122 **自相矛盾**，但退出码是绿的。这是本文件自己 (`:19-32`) 反复强调的「0 命中 = 通过」家族的变体：**"部分加载 = 全部成功"**。

**最小修复**：`:78` 改成 `if (failed === 0 && loaded === files.length) { ✓ } else if (loaded < files.length) { failed++; console.log('✗ 有 N 个模块没加载成功') }`。

**不修会怎样**：一个模块因非 ReferenceError 原因加载失败时，preflight 给绿灯；重启后该模块的功能在运行期才炸。（源自 13，静态确证）

---

# 三、小项（S1~S32 沿用 v1，S33~S45 为 v2 新增）

> v1 的 S1~S32 原文全部保留（安全 S1~S3、任务板 S4~S13、导航 S14~S19、测试与门禁 S20~S24、运维 S25~S32）。**v2 新增如下**：

**测试与门禁（v2 新增）**
- **S33** `preflight.mjs:122-125` 的冒烟测试指向**已删除的模块** `tile_map.js` → 永远走 `:137-139` 的 `~ 非致命` 分支，名义 5 条实际 4 条。（源自 13）
- **S34** `tools/audit_codes.mjs`（60 行）**全仓无人引用**，而 preflight 已内联同功能的一段 → 两份同口径实现，一份是死的，将来会漂移（第 26 条就是它漂移的后果）。（源自 13）
- **S35** `preflight.mjs:608` 的 `NAV_ALLOWED_ACT_FUNCS` **定义了但从未被引用**（`grep` 只有定义处）→ "nav 层可调单格动作"这条规矩实际没实现：`PREFIX_IMPORT_ALLOW.nav` 只允许 `atom/query/infra`，nav 层其实**不许** import `act_*`。（源自 13）
- **S36** `preflight.mjs:259-262` 注释写「这一层只报告不判失败（API_SCAN_ENFORCE = false）」，而 `:278` 实际是 `true` → 读码的人会误判 §4 的强度。（源自 13）

**skills.js（v2 新增）**
- **S37** `collectHazardsCached`（`skills.js:5358-5391`）**死代码**（全树 1 处命中，仅定义）→ 缓存永不填、`resetHazardCache`（`:5341`）空转，而 `isSafeHere:5218` 每次重枚举付 183ms。修：让 `isSafeHere` 调它，或删掉这 42 行。（源自 11）
- **S38** 四个 `goTo*`/`moveAwayFromEntity` **忽略返回值恒 `return true`**（`:2003`/`:2023`/`:2167`/`:2198`）→ 走不到也报成功，失败点被推到下一步（误导性强）。（源自 11）
- **S39** `tillAndSow:2361-2371` 在 cheat 模式且 `seedType=null`（**正是 JSDoc 承诺的默认用法**）时抛 `TypeError`（`null.endsWith`）；`:2368-2369` 两个 `placeBlock` 未 `await`。（源自 11）
- **S40** `storeItem:4208`/`stashUnneeded:3094` 同属"意图即成功"（第 22 条那一族的第 3、4 处）→ 仓储链上的数字不可信。（源自 11）
- **S41** `digDown:2689-2692` 读不到方块时 `return true`（把"区块未加载"说成"到世界尽头"）；`:2684` `bot.blockAt(...).position` 无空值保护。（源自 11）
- **S42** `buildStorageRoom:4913` 的成功判据过弱（`floorN>0 && wallN>0 && ceilN>0`，1 块地板+1 块墙+1 块顶就算"房间建好"）；`fillRoomWithChests:4947` 硬编码 `+4` 绑死 `innerSize=7`。（源自 11）

**模型/运行时（v2 新增）**
- **S43** `agent.js:271` 与 `:762` 各注册了一个 `bot.on('error')` → 同一次错误打两遍；`:312` 的 `_setupEventHandlers` 是 async 但**没有 await**。（源自 13）
- **S44** `_model_map.js:68-76` 的 `profile.model.includes(...)` 无空值保护 → profile 只写 `{"api":"deepseek"}`（用默认模型的合法写法）会在 `selectAPI` 崩在 `.includes`。（源自 13）
- **S45** `world.js:28` 的 `!top.name=='air'` 是恒 false 的死检查；`getBlockAtPosition:55` 返回的假对象缺 `diggable`/`drops`；`schematic.js:137-148` 全盒遍历（100×50×100 = 50 万次同步调用）、越界静默变空蓝图。（源自 12）

---

# 四、实测 vs 推断（v2 核心）

三类定义：
- **已实测** = 本仓库里真的跑出过输出，能在 `09-empirical.md` 或 `docs/audit/probes/` 找到对应命令与结果；
- **静态确证** = 逐行读到了原文，因果链闭合，但没有运行时输出（多为"需要真机/需要服务"的场景）；
- **仍为推断** = 机制明确但既没跑过也没有完整静态链，仅按代码结构推断。

| 编号 | 状态 | 依据 |
|---|---|---|
| 1 控制面（**拆分状态**） | **已实测（逃逸那一半）/ 静态确证（无认证那一半）** | 逃逸：队长探针 `captain-verify-ses-escape.mjs`/`-escape2.mjs` —— 宿主 `process.version`=`v24.16.0`、`platform`=`win32`、`skills.log.constructor(...)` → `object`；无认证：`09-empirical.md:397` 自写"没有对运行中的 mindserver 实弹打过包" |
| 2 profile 名路径穿越 | **已实测** | t11：`../../pwn` → `E:\我的世界ai\pwn\last_profile.json`；`../../../pwn2` → `E:\pwn2\…` |
| 3 板库「当坏库重建」 | **已实测** | t11：`BEGIN EXCLUSIVE` 持锁 10s → 8246ms 后 `rebuilt=true`、`error="database is locked"`、`backup=(none)`；`BEGIN IMMEDIATE` 9s → 1ms、`rebuilt=false`；5.2s → `rebuilt=false` |
| 4 `finish()` 不校验租约 | 静态确证 | `board_store.js:637-659` 只 `WHERE id=?`；`heartbeat():503-504` 有校验 |
| 5 依赖死掉 → 父单永久 running | **已实测（现场数据）** | 板库 `j_20261105_0002_ngl` 卡 166 分钟 + 日志 `t59:120/236/261` 双向闭合 |
| 6 `!stop` 对任务板无效 | 静态确证 | `board_scheduler.js:655`、`action_manager.js:91`、`control.js:242`、`runJobAction` 零调用方 |
| 7 重启守卫 10 秒 | **已实测（现场日志）** | `run-live.err.log` 末行 `will not be restarted`；`Client connected` ×13 |
| 8 地标保护恒空 + 假测试 | 静态确证 | 读 `c?.pos` vs 写扁平；t11 复刻该测试因 EPERM 无法在本机复现"绿" |
| 9 导航闸 owner 恒 `'adhoc'` | **已实测（现场日志）** | `t59:164`、`:180` 两处 `The goal was changed` |
| 10 `digTunnel` 的 `ok` 未 import | **已实测** | t11：stub bot 走正常返回 → `ReferenceError: ok is not defined`；`npx eslint` → `5750:12 no-undef` |
| 11 门禁无触发点 + 配置两行错 | **已实测** | `npx eslint src/` → 319 errors；`npx eslint src/models/` → 20 条 Parsing error |
| 12 日志无时间戳 | **已实测** | `grep -cE '^\[[0-9]{2}:[0-9]{2}'` → `tmp-t59-agent.log` 0/293、`run-live.log` 0/85 |
| 13 `surveyArea` r=64 无上限 | 静态确证（反证已实测） | `:5402` 默认 64、`:5428` 只有下限；反证 `run-live.log:39` 162ms |
| 14 `LIMIT 200` 饥饿 | 静态确证 | `:378-382` + `:1082` 只增不减 |
| 15 `expireLeases` 不记 attempts | 静态确证 | `:668-684` UPDATE 里无 attempts |
| 16 箱子读改写丢更新 | 静态确证 | `flow_store.js:74-88` 两次往返 |
| 17 幽灵父单 | 静态确证 | `:1175-1207` 无事务 + `:1114` 跳过无子单 |
| 18 42 个孤儿测试 | **已实测** | `ls tools/test_*.mjs`=44；`unit_all.mjs` 只注册 2 个 |
| 19 退出码 >1 杀 mindserver | 静态确证 | `agent_process.js:37-40` |
| 20 skills 与原子层分叉 | **静态确证（98 条零未核实）** | `11-skills-rest.md` §2 全表；12 条答案不同逐行带两侧行号 |
| 21 技能能攻击玩家 | **静态确证** | `NOT_ATTACKABLE_TYPES:31-35` 含 `'player'`；`skills.js` 全文零引用 `isAttackable` |
| 22 `giveToPlayer` 恒真 | **静态确证** | `:1609` 返回对象 vs `:1611` `if (got)` |
| 23 `levelGround` 拆农田 + 凭空造方块 | 静态确证 | `NATURAL_BLOCKS:3361` 含 `farmland`；`:3433` `/fill keep` 不查库存 |
| 24 schema 不匹配走重建 | **已实测** | t11：`no such column: priority` 无需并发即进重建路径 |
| 25 `memory_store` 损坏静默清空 | 静态确证（对照 `board_store` 留 `.corrupt-`） | `12` 报告 §memory_store |
| 26 preflight 0x08 假绿灯 | **已实测** | `od -c` 见 `/ \b f a i l`；探针 `t13-regex-check.mjs`：0x08 版命中 `[]`、`\b` 版命中 `["fail('DIED'…"]`；`control.js` `fail('DIED'`=0 次、`code: 'DIED'`=3 次 |
| 27 索引/棘轮盯过期对象 | 静态确证 | `docs/README.md:81`、`交接文档.md:3-4`、`audit_baseline.json count=14` vs 实测 5 条有效 |
| 28 `useToolOn` 恒假守卫 | **静态确证** | `:2760` 优先级错 |
| 29 两处 `bot.chat` 绕过白名单 | 静态确证 | `:1029`、`:4000`；`preflight.mjs:339` 正则要求字面量 `/`；`:351` 豁免 `skills.js` |
| 30 `novita.js:47` 缺 `this.` | **静态确证** | 对照 `deepseek.js:44` 的 `this.sendRequest` |
| 31 伪造兜底串 + 零 usage | 静态确证 | 16 处 `'My brain disconnected…'`；`grep usage × src/models` = 0；`prompter` 5 个调用点都是 `=>string` |
| 32 心跳无 try/catch | **静态确证** | `agent.js:807-820` |
| 33 `goToGoal` 180s 不可中断 | 静态确证 | `:1734-1815` 全文无 `interrupt_code`；`:1794` 常量 |
| 34 preflight `loaded` 不校验 | 静态确证 | `:72-80` |

**统计：34 条里 已实测 10 条、静态确证 24 条、仍为推断 0 条。**（v2.1 按 t14 复核重算：第 1 条按"逃逸 / 无认证"拆两半后只有逃逸那半计入已实测；21/22/28/30/32 五条**降为静态确证** —— 它们是读代码确认的，`09-empirical.md` 与 `probes/` 里对它们零命中。已实测的 10 条 = 2、3、5、7、9、10、11、12、18、24、26 中能在 `09-empirical.md` 或 `probes/` 找到输出的那些，外加第 1 条的逃逸半。）v1 里标"需现场验证/未复现"的 4 项（B5 的 errcode、板套件断言强度、1.41 格/秒、路径穿越），v2 已全部落地为实测。

---

# 五、沉宝（v2 的结构性洞察）

**原子/动作层是干净的，脏的全部在 `skills.js` —— 也就是模型直接看到的那一层。**

按同一组四个问题把 15 个 `act_*.js` 逐一过完（全文读完）：

| 问题 | 结果 |
|---|---|
| ① 入口查不查 `interrupt_code`？ | **15/15 都查**（`act_pillar:82` 还在起跳轮询里每 25ms 再查一次） |
| ② 返回值是"正向验证"还是"乐观返回"？ | **14/15 正向验证**（读回方块/血量/库存增量/窗口计数）；唯一弱一点的是 `act_entity.tradeOnce:128-137`（`win.trade` 不抛就 ok，没核对交易前后货量） |
| ③ 有没有 import 不存在的标识符？ | **0/15** —— 全部 `import { ok, fail[, normalizeTarget] }` 且都真用到 |
| ④ 失败码是否封闭？ | **15/15 都在 CODES 内** |

对照之下，`skills.js`（98 个导出，全部对模型可见）里：4 处恒假/恒真判断（第 六 节）、12 条同一规则两个答案（第 20 条）、2 处命令白名单绕过（第 29 条）、3 条零保护的破坏路径（第 23 条）、4 处"意图即成功"（第 22/40 条）。

**一句话**：**分层规矩在底层守住了，在顶端没守住。** 这不是"代码普遍质量差"，而是"**新写的原子层被严格执行，老的 `skills.js` 因为是对模型的 API 面而免于重构**"。修法方向因此很明确：不是重写原子层，而是**把 `skills.js` 的导出逐个接到原子层上、或者删掉**（第 十三 节）。

---

# 六、同一个错误在同一文件复发（不是笔误，是模式）

`skills.js` 里有 **4 处**「判断看起来做了、其实没做」：

| # | 位置 | 写法 | 后果 |
|---|---|---|---|
| 1 | `skills.js:571` | `if (!walk)` —— `goToBlockBounded` 返回**对象**，恒真 | 「熔炉走不到就自己放一个」的兜底整段（`:571-586`）是死代码 |
| 2 | `skills.js:2760` | `!bot.game.gameMode === 'creative'` —— 优先级错，恒假 | 「没有工具」守卫从未生效 |
| 3 | `skills.js:1609-1611` | `if (got)` —— `waitUntil` 返回**对象**，恒真 | 物品扔地上、玩家没接也报成功（第 22 条） |
| 4 | `skills.js:5080` | `known.sort((a,b)=>a.distanceTo?.(me) ?? 0)` —— 记录没有 `distanceTo`，恒 0 | 排序是空操作（功能上被 `:5082` 的正确排序救了，但这一行是死的） |

**为什么单列一节**：四处分布在**熔炉、工具、交付、仓储**四个互不相干的族里，写法各不相同（`!对象`、`!x ===`、`if(对象)`、`?.()??0`），但**同一种错**：把"非布尔值"当成布尔用。它证明这不是手滑，而是**这个文件缺少"返回值形状"的统一契约**——`skills.js` 的 98 个导出返回 boolean / 对象 / ActionResult / 字符串四种形状混用，而调用方按其中一种写判断。**根治方法**：`skills.js` 里凡返回对象的函数，调用点必须用 `.ok`；更彻底的是让 `skills.js` 的导出统一成 ActionResult（与 `contract.js` 一致），那 4 处会变成 `if (!r.ok)` 立刻被 eslint 的 `no-undef`/类型检查抓住。

---

# 七、有正确解法却没抄（比单报 bug 更能指向修法）

同一套代码库里，**同一个问题有正确解法，但另一处没抄**：

| 问题 | 正确的那份 | 错的那份 |
|---|---|---|
| **同一库存被多个消费者重复认领** | `strat_obtain.js:424-435` 的 `allocated` 账本：`have` 只能用"**剩下的**"（`haveTotal = hRaw.total - alreadyAllocated`），注释 `:407-423` 有完整离线复现（背包 3 块板 → 两个消费者各认领一遍 → 计划一块都不派） | `flow_mine.js:268-270` 的 `countAll` 把 `dropNames` 与 `names` **两套名字都累加** → `cobblestone` 这类"物品名=方块名"的场景被数两遍 → `want=3` 挖到 2 个就报完成、`count` 虚高 2× |
| **"没工具" vs "读不到工具"** | `act_dig.canDigReason:189-256` 三态（`ok`/`no-tool`/`unreadable`），注释记着真机事故（死亡后背包重建被误判 NO_TOOL → 单子 blocked） | `flow_mine:266-270` 用的是同一套（抄对了）；而 `skills.js` 的 `equip`/`breakBlockAt` **连"读不到"这个概念都没有** |
| **窗口/计数校验** | `act_container.deposit:369-404` / `withdraw:434-466`：`invBefore/winBefore` → `waitCountsSettled` → 比对 `invAfter/winAfter`，三个历史 bug 都在注释里 | `skills.putInChest:1437` / `takeFromChest:1486` / `storeItem:4208`：按**意图值**计数（第 20/40 条） |
| **"不许打玩家"** | `act_attack.isAttackable:40-48` + `NOT_ATTACKABLE_TYPES:31-35`（`'player'` 排第一） | `skills.attackNearest:706` / `attackEntity:733`：直捅 `bot.pvp.attack`（第 21 条） |
| **"别人的料不抢"** | `act_craft.furnaceBusyWith:451-472` + `:519-525` 返回 `OCCUPIED`（注释写明"这条一度被我丢了，是 captain 抓出来的真 bug"） | `skills.loadFurnace:478`：`putInput` 无条件执行（第 20 条） |

**这张表的意义**：这些都不是"没人想到"，而是"**想到了、写对了、但只写在一处**"。所以修复成本极低（把正确那份接过去或复制过来），而风险极高（模型走的恰好是没写对的那条）。**优先修这五处，比修任何架构问题都划算。**

---

# 八、失控面（只有两处）

"玩家喊停之后停不下来"的真例只有**两处**，且都是**缺陷**而非设计：

| 失控点 | 证据 | 玩家按 `!stop` 后的实际行为 |
|---|---|---|
| **`follow` 的超时参数根本没接上** | `composite_registry.js:78` 传 `deadlineMs: remaining(ctx)`，而 `flow_follow.js:87` 解构的是 `timeoutMs = -1` → **`deadlineMs` 被静默丢弃**；`:137` 的判断是 `if (timeoutMs > 0 && …)` → `-1` 永不成立。`follow()` 全仓只有一个调用方（`composite_registry.js:76`），所以是唯一入口的唯一参数，**100% 命中** | 跟随**永不超时**；叠加上任务板 `!stop` 断链，`!do follow player=xxx` 变成一个**既不会超时也停不下来**的技能，只能杀进程 |
| **任务板单的 `!stop` 断链** | 第 6 条（`board_scheduler.js:655` 绕过 `runJobAction`；`action_manager.js:91` `executing=false` 不发中断；`control.js:242` 设错字段） | 单子照旧做完；连"停手"都不会发生 |

**明确排除**（写在这里防止被重复误报）：
- **`dig` 不是失控点。** `act_dig.js:38` 入口查中断、`:121` 的 `holdDig` 每 **100ms** 轮询（`atom_input_mouse.js:266/269`）、`:134` 的后置 `waitUntil` 传了 `bot` 也响应中断 —— **三层都查**；`executor.js` 那两个挖方循环调的都是 `act_dig.digBlock`，自身不查属于可接受的上层省略（最坏多挖一格）。**一条"按住 `!stop` 挖矿会停"的演示就能推翻任何把它列进失控面的说法。**
- `goToGoal` 有 180 秒上界（第 33 条），属"中断延迟"而非"失控"，单独列为 Should。

---

# 九、根因归类 A：测试与门禁给了假安全感

一句话：**这些问题能活着上线，不是因为难，是因为没有任何一道门在看——而其中一道门还是假装在看的。**

**v2 修订的测试成绩单（推翻 v1 的"board 套件一条没跑到"）**：
- **board 13 个 unit 直跑 → 188 条用例全 PASS、0 条断言失败**（11 个 exit=0 共 170 条 + 2 个功能段 18 条）。v1 写"8 个文件一条用例都没跑到"**已被 t11 实测推翻**：当时是沙箱 `writeStore` 的 EPERM，换 cwd + 绝对路径即可跑。那两个 exit=1 是脚本用 cwd 相对读 `src/...` 的 ENOENT，**不是断言失败**。
- **`unit_all` 的 0/64 归因环境**：`unit_all.mjs:125` 的 `execFileSync` 被 EPERM（本沙箱禁 spawn）。62 个 `*_unit.mjs` 逐个直跑：可写 cwd 下 50 个 exit=0；12 个失败中 10 个是 ENOENT、改回 `mindcraft/` 后 8 个转全绿、其余 4 个 EPERM（只读目录）→ **真实断言失败 0 条**。
- **`preflight` 7 段 6 绿**，唯一红是 `[6/6]` 自测的 `spawnSync` 不起 → `status=null` → 按设计 **fail-closed**（这一点是对的：它没有因为"跑不起来"给绿灯）。

**四处"看起来有守卫、实际没有"（v2 加第 5 处）**：
1. **有测试，但测的是夹具自己的形状**（第 8 条）：夹具手写 `{pos:{…}}` 灌库，绕过真实写入方 `rememberChest`（写扁平 `{x,y,z}`）。**它绿着的时候，生产是坏的**。`grep rememberChest tools/*_unit*.mjs` → **0 命中**。
2. **有测试，但被测属性用不上**（第 9 条）：`nav_lock_unit.mjs` 只调显式 owner，`grep adhoc` → **0 命中**；缺陷正好落在被测属性的盲区里。
3. **有测试，但被 XFAIL 掉了**（第 5 条 / S21）：4 处已知 bug 以"带指纹 XFAIL"记账，指纹在就永久绿。`board_store_converge_unit.mjs:218` 记的就是第 5 条的根因。
4. **有规则，但没有执行点**（第 11 条）：`no-floating-promise` 与 `no-undef` 都配成 `error`，一跑就是 39 条浮空 promise + 6 处 ReferenceError；eslint 不在 `devDependencies`、无 CI、无 `lint` 脚本。
5. **有门禁，但门禁自己的正则写坏了**（第 26 条，v2 新增，最强例证）：`preflight.mjs:183` 两条正则里各有一个 **0x08 退格符**代替了 `\b` → **永远匹配不到任何东西** → `used2` 恒空 → 永远打印「✓ 错误码审计通过」。项目专门写了 t99 护栏防"扫到 0 个所以没发现"，**但没防"扫描器自己坏了"**：`requireScanned` 看的是 `files2.length`（162，非空），一条都拦不住。

**覆盖面量化**：审计①② 的 12 条 Must 里，只有 2 条有像样测试；4 条完全没有测试；2 条测错对象；1 条被 XFAIL。**v2 补记**：`step_runner` 至今在测试里 `grep` **0 命中**（第 10 条两个 Must 都落在它身上）。

---

# 十、根因归类 B：写的入口没人接

一句话：**机制写好了，接线没接上，于是代码在库里、能力不在系统里。**

| 机制 | 状态 | 后果 |
|---|---|---|
| `control.runJobAction`（`control.js:339-351`） | **零调用方** | 第 6 条：`!stop` 对任务板完全无效 |
| `scheduler.setAutoClaim`（`board_scheduler.js:385`） | **零调用方** | 同上 |
| `maxJobLevel` / `levelForJobSource` | **零调用方**（S3） | 权限模型实际不存在 |
| `migrateLocalToBoard`（`board_store.js:1361-1412`） | **零调用方**（S6） | 真正跑的是 `agent.js:78-116` 手抄的一份 |
| `pruneFails` / `clearFail`（`terrain3d.js:602`/`:610`） | 只有单测调用（S17） | `fail` 表只增不减 |
| 导航互斥闸 `acquireNav` | **12 处直驱点不进闸**（第 9 条） | 现场每 150 行撞 2 次 goal 冲突 |
| `runSteps` 的 `failed` 数组 | `skills.digTunnel` **不检查**（第 10 条） | 全失败 → 假成功 → 再抛 ReferenceError |
| **`act_attack.isAttackable`** | **`skills.js` 全文零引用**（第 21 条，v2 新增） | op 账号能打玩家 |
| **`act_container` 的计数校验** | `skills.putInChest`/`takeFromChest`/`storeItem` 都不用（第 20/S40 条） | 仓储链数字不可信 |
| **`act_craft.furnaceBusyWith` 的 OCCUPIED** | `skills.loadFurnace` 不用（第 20 条） | 覆盖别人正在炼的料 |
| **`collectHazardsCached`** | 定义了、`isSafeHere` 不用（S37） | 缓存永不填，安全检查每次重枚举 |
| **`NAV_ALLOWED_ACT_FUNCS`** | 定义了、判据循环不用（S35） | "nav 可调单格动作"没实现 |

这十二条的共同形态是"半成品接线"：入口函数写好了、注释还写着"由 X 调用"，但真正那条路径绕过去了。危害比"完全没写"更大——**读代码的人会以为它在生效**。

---

# 十一、文档数字对不上（项目对自己的性能没有可信口径）

**v2 已把这条从"三个数互相矛盾"升级为"没有任何可复算支撑"**：

| 来源 | 声称 | 复算结果 |
|---|---|---|
| `README.md` | **1.41 格/秒**；推进 302 格只走了 168 格 | **无任何支撑**（t11 重算 55 个 artifact / **3484 条记录**：`long-route` n=17 = **56.1 格 / 18.0s = 3.12 格/秒**；**全库无任何 ≥250 格的场景**，「302 格」无归档） |
| `交接文档` | 144 格 / 68~96 秒（= 1.5~2.1 格/秒） | 与 README 不一致 |
| `docs/回归-runbook.md:76` | 50/55 | **✓ 复算吻合**（唯一站得住的） |
| 去重后实测 | `long-route` **3.12 格/秒**（n=17，100%）；全场景汇总 1.97 格/秒（n=110） | 见 ⑤/⑨ |

各场景实测（去重后）：walk-flat 3.85、climb-ladder 4.02、dig-through 2.58、digdown 1.46、pillar-up2 1.44、water-cross 0.72、deep-water 1.07；`down5` **0/10 全失败**（`docs/回归-runbook.md:76` 老实写了，README 的能力表里一个字都没有）。

**v2 新增两条（t11）**：
- **`gap-bridge` 场景的 `dist` 字段不可信**：单次记录 11457 格（→ 189 格/秒，物理上不可能）→ **bench 产物必须注明 `dist` 是"净位移"还是"累计路程"**，否则任何基于它算的"格/秒"都是垃圾。
- **原 A/B 对照组无效**（沿用 v1）：`control-m2`（424 行）与 `baseline-m2-ACCUMULATED-MIX`（297 行）按 `(scenario,round)` 去重后**完全相同**（110 条 / 1827 格 / 928.8s）——"对照组"里没有一条新数据。**任何基于这两组的 A/B 结论都不得采信**，本报告一条也没用。

**结论**：README 的性能表是目前最不可靠的一块。修法不是"改数字"，而是：① bench 每行写 `runId`（进程启动时间戳），开跑时若目标文件存在就自动改名归档；② 每行注明 `dist` 语义；③ README 的能力表改成"实测区间 + 已知边界 + 采数日期"。

---

# 十二、已降级说明

1. **① N1（`surveyArea` r=64）从 Must 降为 Should（第 13 条）**。原判据"阻塞事件循环 2.3 秒 → 被踢"**作废**：`run-live.log:39` 的原文是 `事件循环延迟最大 162ms（正常，不是阻塞导致）`。保留代码事实，理由改为"结构性无上限"。
2. **⑤ R6（bench 归档污染）不作独立条目**，见第十一节。
3. **⑥ 两条"看起来像漂移、其实是对的"**：preflight 的字段标准检查确实存在（`audit_rules.mjs:291`）；`game_rules.json` 18 条规则准确。
4. **③ 的四条"核实为否"**：`keys.json` 从未被 git 跟踪；mindserver 不暴露给局域网（`mindserver.js:421` + `allowRequest(local_only)`）；SQL/RCON 注入均不成立。
5. **① N17/N18** 仅列优化方向，未进硬发现。
6. **① N3 的 12 处直驱点**并入第 9 条。
7. **【v2 新增】`modes.js:118/126/133` 三条 ReferenceError 降级为"静默失效"**（t11 实测）：变量确未声明、分支可达，但被 `modes.js:466` 的 `execute()` try/catch 吞成一行 `console.warn`，**不崩进程**。真实后果是"身上着火→水桶灭火永久静默失效"。仍计入第 11 条的 6 处之列，但严重度分层。
8. **【v2 新增】第 3 条的"必删库"表述作废**，改为"判成坏库但没删成 + 5 秒边界"（t11 实测）；同一条的"面板在写"触发场景在 v1 复核时已删（面板走同一 mindserver，单写者）。
9. **【v2 新增】S20（`test_codes` 的 DIED 是误报）修正**：`DIED` 确实不在 `CODES` 里（`fail('DIED'` 出现 0 次、`code: 'DIED'` 3 次），所以 `test_codes` **报得对**；错的是它的口径（把 `code:` 数据载荷当成错误码）。同一口径也正是第 26 条那个 0x08 假绿灯的成因。
10. **【v2 新增】`t4` 的"npx 可用"在本环境不成立**（t11：npx 也 EPERM）。v1 里"`npx eslint` 拿到的机器结论"来自另一个沙箱能力的成员，**结论本身仍成立**（我 v2 复跑过 `npx eslint` 拿到同样的 319），只是"环境能力"这条要以 t11 的 P1 为准。
11. **【v2.1 新增】建造任务的三条（E3/E4/E6）不进 1~34 硬发现，在此登记并写清理由**。它们都落在 `src/agent/tasks/construction_tasks.js`（1104 行，一个跑一次就结束的离线生成器/校验器），不在 bot 的常驻运行链路上，所以按"影响 × 触发概率"排不进前 34；但都是真缺陷，**已核实行号**：
    - **E3 类型混淆会抛 TypeError**：`construction_tasks.js:47-51` 的 `checkLevelBlueprint` 调 `blueprint.checkLevel(bot, levelNum)` 后直接 → `:51 if (result.mismatches.length === 0)`。若 `checkLevel` 在异常路径上返回 `false`（布尔），`.mismatches` 即 `undefined` → `.length` 抛 `TypeError`。同型解引用还在 `:15`、`:19`、`:65`、`:121-122`。调用方是 `commands/queries.js:243`（`!checkBlueprint` 命令）→ **一条命令就能触发**。修法：`:51` 前加 `if (!result || typeof result !== 'object') return \`Level ${levelNum} 检查失败\`;`。
    - **E4 传参错位 → 程序化房子没有窗户**：`embellishments(...)`（`:731` 定义，参数序 `(carpet, windowStyle, matrix, newX, newY, newZ, newLength, newWidth, newDepth, material)`）内部 `:738` 调 `addWindowsAsSquares(matrix, **newZ**, newY, **newZ**, …)`、`:741` 调 `addWindowsAsPlane(matrix, **newZ**, newY, **newZ**, …)` —— **第 2 个坐标参数喂的是 `newZ` 而不是 `newX`**（对比同函数 `:749`/`:752` 的 `addCarpet` 正确传 `newX`）→ 窗户被算到错误的轴上，表现在"所有程序化生成的房子没有窗户"。修法：`:738`/`:741` 的第 2 参改成 `newX`。
    - **E6 唯一不传 ctx 的注册项 → 放大重复扣料**：`composite_registry.js:109` 的 craft 项写的是 `run: (bot, args, ctx) => runCraft(bot, args.item, args.count)` —— **18 个注册项里唯一一个不把 `ctx` 传给 flow 的**（其余都形如 `runCraft(bot, …, {ctx})`）。后果：craft 单**没有 deadline、没有 jobId**，于是它不会因超时收手，也不会把用量/中断挂到具体单上；与第 15 条（`expireLeases` 不记 attempts）叠加时，"同一张 craft 单被反复重领"会**重复扣料且无超时兜底**。修法：改成 `runCraft(bot, args.item, args.count, { ctx })`。
    - **为什么 E5 不在此登记**：E5（`tasks.js:407`/`:509` 把任务 JSON 拼进 owner 级命令）是**安全**问题、且不需要 socket 与认证，已按任务要求**并入第 1 条**（第五层入口）。

---

# 十三、建议删除 / 不要删

## 13.1 可以删（三项分别结算，**不简单相加**）

| 项 | 量 | 依据 |
|---|---|---|
| **A. `skills.js` 的重复实现** | **−969 行** | 11 报告 §6：A 类纯转发 372（8 条）+ B 类重复实现 554（13 条）+ C 类死代码 43。逐条带行号 |
| **B. 模型层重复实现** | **−85 行** | 13 报告 §1：context 重试 11 份（−32）+ 伪造串 24 处（−18）+ 构造样板 14 处（−35） |
| **C. 死代码与冗余资产** | **−683 行 / −1 依赖 / ≈−206MB** | 06 报告：17 个零引用导出 69 + `mindcraft-py` 149 + 两个坏测试 200 + 3 个 m6 探针 255 + `andy.json`/`CraftTaskValidator` 10；磁盘见 06 §4 |
| **D. 其它零头** | **−29 行** | 12 报告：`cookingItems`（消费者全注释、grep 零引用） |

**去重说明（必须读）**：A 与 C **有一处重叠** —— C 里"17 个零引用导出（69 行）"是**跨全仓**的零引用导出统计，而 A 的 969 行是 `skills.js` **内部**的转发/重复实现；两者的文件集合不重叠（`skills.js`/`world.js` 的导出按 8.2 的"误删禁区"不算死代码）。因此合计 = 969 + 85 + 683 + 29 = **1766 行**，**不扣减**。
**保守取值**（把 A 的 B 类 554 行视为"需先补 4 条逐行核对"才敢删）：**可信下界 = 1766 − 554 = 1212 行**。

```
Lean: -1766 行（保守下界 -1212 行）, -1 依赖  可能
磁盘：≈ −206MB（含可重建项最多 ≈ −631MB）
```
（"可能"= 需要同步改模型可见的 API 面，见 13.3。）

## 13.2 不要删（误删禁区，务必照抄）

- **`src/models/*.js` 的 17 个类不是死代码**：由 `_model_map.js` **动态发现/加载**（`fs.readdir` + `dynamic import` + 要求 `static prefix`），静态 grep 零调用是正常的。删掉等于所有供应商适配器消失。
- **`skills.js` / `world.js` 的导出不是死代码**：它们是**注入 SES 沙箱给模型调用**的 API 面。`grep` 零外部调用 ≠ 可删——调用者是 LLM，grep 看不见。
- **`backups/preinstall-20261018-220629`（49MB）不能删**：`server/` 不在 git 里，那是它唯一的历史。
- **`backups/` 其余部分别当"重复拷贝"删**：实测是 30 个**不同时刻**的小快照（md5 抽验各不相同）。
- **【v2 新增】不要把三套"玩家建筑判定"合并成一套**（12 报告）：`world_model.isPlayerBuiltBlock`（J1，纯名字匹配）与 `levelGround` 的 `NATURAL_BLOCKS`（J2，可拆白名单）**语义相反**，合并会复活 `world_model.js:80-83` 记录过的真实 bug。正确方向是**新增位置型判据**（"这格是不是玩家放过/踩过的"），而不是合并。

## 13.3 删 B 类的代价（必须写清楚）

`skills.js` 的 B 类（554 行）会改变**模型可见的 API 面**：`skill_library.js:32-44` 的 `always_show_skills` 与 `:52-64` 的技能目录要同步改，否则模型会调一个不存在的名字（`coder.js:119-133` 的 `_lintCode` 会拦，但浪费一整轮 LLM 调用）。
**`waitUntil` 那一条最危险**：两份语义相反（`false` = 未完成 vs 已完成），删 skills 版之前必须先把内部调用方 `waitForSmelt:499`、`giveToPlayer:1609`、`wait:300` 逐个改成 atom 语义，否则"等到超时"会变成"立刻返回 true"。

---

# 十四、优化路线图（v2 重写）

## 第一批：止血（1~2 天，8 处）

| # | 内容 | 工作量 | 验证方式 |
|---|---|---|---|
| **26** | **preflight 的三处 0x08 换成 `\b`**（`:183`×2、`:933`×1） | **5 分钟** | `node tools/preflight.mjs` 的 §3 从「✓ 通过」变成 **「✗ 有 1 个错误码没注册：DIED」**；再按口径收窄或注册 DIED 后**真绿** |
| **1** | **`allow_insecure_coding` 默认改 `false`**（`mindcraft/settings.js:33`）+ README 对齐 | 10 分钟 | `grep -n allow_insecure_coding settings.js` → `false`；README 与之一致；`!newAction` 在默认配置下被拒 |
| **21** | **`isAttackable` 接到 `skills.attackNearest`/`attackEntity`**（1~2 行） | 10 分钟 | 调 `skills.attackNearest(bot,'<玩家名>')` → 返回失败且不挥击 |
| 11 | **eslint 两行**（`ecmaVersion`→`latest`；`globals.browser`→`globals.node`）+ `package.json` 加 `lint` 脚本 | 30 分钟 | 20 个 adapters 不再 parse error；`no-undef` 57→6（全是真问题）；`no-floating-promise` 39 条全可见 |
| 12 | **bot 侧日志加 ISO 时间戳** | 30 分钟 | 任意一行都有 `2026-…T…Z` 前缀；两次 goal 冲突能算出间隔 |
| 3 | **B5 判据收窄**（只在 `SQLITE_CORRUPT`/`NOTADB`/`malformed` 时重建，其余 `throw`） | 30 分钟 | 造"另一进程 `BEGIN EXCLUSIVE` 持锁 10 秒"→ 日志出现"板起不来"、**库文件仍在** |
| 30 | **`novita.js:47` 补 `this.`** | 1 分钟 | `npx eslint src/models/novita.js` → 无 `no-undef`；构造一次超长上下文 → 走截断重试而不抛 |
| — | **版本控制补口**：根建 `.gitignore` + `git init`，只收 `scripts/ docs/ config/ *.bat` | 1 小时 | `git log` 能看到 14 份审计报告与 `server.properties` 的第一次提交 |

> 版本控制这条不是"代码质量"，但它决定上面所有修复**有没有第二份历史**：`git` 只管 `mindcraft/`（547 文件），外层 `scripts/ server/ config/ docs/ web/ *.bat` 全部无版本控制——连这 14 份审计报告和含 RCON 口令的 `server.properties` 都没有回滚能力。

## 第二批：结构性整改（1~2 周）

| # | 内容 | 工作量 | 验证方式 |
|---|---|---|---|
| 1+ | 控制面 token 握手 + `set-agent-settings` 字段白名单 | 1~2 天 | 不带 token 的 `send-message` → 被拒；`allow_insecure_coding` 无法经 socket 改 |
| 1 | **SES 沙箱二层**：`evalTaming` 改回 `safeEval`（或明确声明"非沙箱"） | 1~2 天 | compartment 内 `skills.log.constructor('return process')()` → 抛错而非返回 `object` |
| 2 | `create-agent` 名字前置校验 + **Prompter 内路径断言** | 半天 | `profile.name='../../pwn'` → `{success:false}` 且磁盘无新目录 |
| **24** | **schema 幂等迁移**（`PRAGMA user_version` + ALTER） | 半天 | 旧库 + 新代码启动 → 自动加列、不触发"当坏库" |
| 4 | `finish()` 加租约归属校验（客户端补 `bot`） | 1 天 | 按 t=0/30/31/35 序列：A 的迟到 finish 返回 `LEASE_STALE` |
| 5 | `depDead` + XFAIL ②-6 转硬断言 | 1 天 | 造 blocked 依赖 → 后继 `DEP_DEAD`、父单收敛 `blocked` |
| 6 | 调度器改走 `runJobAction` + `scheduler.setAutoClaim` | 1 天 | 长单时 `!stop` → 单子 paused 且技能被中断（日志有 `pausedReason='player'`） |
| **E1** | **`follow` 超时键名对齐**（`flow_follow.js:87` 加 `deadlineMs`，或注册表 `:78` 改传 `timeoutMs`） | 1 行 | 构造"找不到人"场景 → 30 分钟后返回 TIMEOUT 而不是无限跑 |
| **E2** | **`digdown` 液体假成功（现状：坑还活着）**：`executor.js:342-345` 发现正下方是液体只 `break`，`:363` 仍是 `return ok({ dug })` 而 `dug=0` → **一格没下降却报成功**。同一文件 **`dig` 分支早已修过**（`:240-245` 是诊断注释、`:310-314` 加了 `liquidBlocked` 标记 + 显式失败），**`digdown` 分支没有同步** ← 这正是 08 分册的核心论点 | 半天 | 正下方是水的 digdown → 返回 `BLOCKED` 而非 `ok` |
| 7 | 重启守卫改指数退避 | 半天 | 停 Paper 60 秒再起 → agent 自动回来 |
| 8+9 | 地标扁平坐标 + 导航 owner 唯一化 + 12 处直驱走 `withNav` | 2~3 天 | `rememberChest` 后 `protectedPlaces` 非空；两条无任务单指令并发时第二条 `BLOCKED`；`goal was changed` 压测 0 次 |
| 10 | `step_runner` 全失败即 fail + `digTunnel` 加 import | 半天 | `step_runner_unit.mjs ①` 转绿；`digTunnel` 不再抛 |
| **22** | `giveToPlayer` 的 `if (got && got.ok)` | 5 分钟 | 玩家 AFK → 返回 `false` |
| **23** | `levelGround` 去 `farmland` + `/fill` 填充查库存；`breakBlockAt` 加 3 行 `wmIsPlayerBuilt` 守卫 | 半天 | 对农田调 `levelGround` → 农田保留；对箱子调 `breakBlockAt` → 拒绝 |
| **25** | `memory_store.readStore` 损坏时备份 `.corrupt-` | 半小时 | 手动写坏 JSON → 生成备份文件 + 告警，不静默清空 |
| **32** | 心跳 `while(true)` 包 try/catch | 10 分钟 | 人为让 `modes.update()` 抛 → 心跳继续，日志有告警 |
| 13 | `surveyArea` 默认 24 + `scanSphere` 夹 ≤32 | 1 小时 | 计数型假 bot 断言 r=64 被夹到 32 |
| **27** | 文档索引改指 `架构交接-总.md`；`audit_rules` 逐条校验 `existsSync(file)` | 1 小时 | 索引里出现权威文档；把 9 条死条目剔掉后棘轮自动缩到 5 |
| **34** | preflight `loaded === files.length` 才算过 | 10 分钟 | 人为让某模块 import 抛 TypeError → §1 变红 |

## 第三批：长期结构债与瘦身（按月计）

- **`skills.js` 收口**（−969 行）：先删 A 类纯转发 372 行（8 条，风险低），再逐条把 B 类 554 行接到原子层（删前必须改内部调用方，尤其 `waitUntil`）。验证：`skill_library` 目录同步更新；`npx eslint` 的 `no-undef` 仍为 0。
- **模型层收口**（−85 行）：一个 `withRetry` + 一个 `FAILED_REPLY` 常量 + 一个 `makeOpenAICompatible`，同时把 usage 记录加进去（约 12 行 sink）。验证：日志里出现 `[llm] model=… prompt=… completion=…`。
- **死代码与资产**（−683 行 / −1 依赖 / ≈−206MB）：`mindcraft-py`、m6 探针、两个坏测试、重复 jar、`REFACTOR_ANALYSIS` 拆分归档。
- **测试治理**（第 18 条）：13 个离线孤儿并入 `unit_all`，`UNITS` 改 `readdirSync`，XFAIL 加 `expires`，补第十五节那 8 条。
- **任务板结构债**（S4/S5/S6/S9/S10）：验证方式是"加一列后旧库能自动迁移"。
- **文档可信化**：`00~09` 按 Phase R 后的真实文件名重写 `文件:行号`（202 个 token 是基数）；`M8_实施设计` 现状表逐行改 ✅；`README` 数字（CODES 38 而非 31、`atom_*.js` 9 而非 21、默认 profile 是 `my-local.json`、三条死链）一次改完。验证：写 `tools/doc_ref_check.mjs` 扫文档里所有 `x.js:行号` 断言文件存在，纳入 preflight。

---

# 十五、建议立刻补的测试

| # | 文件（是否已存在） | 用例名 | 守的是哪条 |
|---|---|---|---|
| 1 | `tools/step_runner_unit.mjs`（**新建**） | `① 所有步骤失败且无 onFail 表时 runSteps 必须返回 ok:false` | 第 10 条 |
| 2 | `tools/step_runner_unit.mjs`（同文件） | `② skills.digTunnel 正常返回不得抛异常（当前必抛）` | 第 10 条 |
| 3 | `tools/nav_lock_unit.mjs`（已存在，**加一条**） | `④ 两个无任务单的调用必须互斥（默认 owner 不能相同）` | 第 9 条 |
| 4 | `tools/atom_classify_unit.mjs`（已存在，**改夹具+加断言**） | `⑤ rememberChest 之后 protectedPlaces 必须非空` | 第 8 条 |
| 5 | `tools/preflight_regex_unit.mjs`（**新建**） | `① preflight 每条审计正则必须能匹配到已知样本（防 0x08 那类静默失效）` | 第 26 条 |
| 6 | `tools/board_store_finish_unit.mjs`（已存在，**加一条**） | `④ 租约过期的旧持有者调用 finish 必须失败` | 第 4 条 |
| 7 | `tools/scan_scale_unit.mjs`（**新建**） | `① 计数假 bot 下 scanSphere 的 blockAt 次数 ≤ 上限（r=24/32/64）` | 第 13 条 |
| 8 | `tools/skills_attack_guard_unit.mjs`（**新建**） | `① attackNearest/attackEntity 对 type='player' 必须返回失败` | 第 21 条 |

---

# Verdict:

**能演示，不能交付。** v1 的判断是"能用，但不能无人值守地信"；**v2 必须收紧**，因为两条支撑"它能安全地跑"的前提都被打掉了：
- **第 1 条**：`allow_insecure_coding` 默认开着，而它唯一的边界（SES Compartment）**已实测可逃逸** —— 模型代码拿到宿主 `process`/`require`。也就是说，这个 bot 在默认配置下**已经是一个"谁能对它说话、谁就能在本机执行任意代码"的 op 账号**。
- **第 21 条**：模型能用一个名字就让 op bot 去打玩家。

除此之外，v2 反而**修正了三处"过于悲观"的判断**：board 测试套件其实是**188 条用例全 PASS**；`unit_all` 的 0/64 是沙箱 EPERM；性能数字虽然 README 不可信，但 bench 数据本身可以复算（3.12 格/秒）。
**所以优先级是三句话**：① 先把"能执行代码"这件事关掉或关住（第一批 #1 + #2 的沙箱层）；② 再把必然发生的正确性问题修掉（第二批 E1/E2/第 4/5/6/8/9/10 条 + schema 迁移）；③ 最后才是收口与瘦身。**而无论修哪一批，第 26 条（preflight 假绿灯）都应该先修** —— 它是唯一能保证"后面的修复真的被检查"的那道门。

**Lean: -1766 行（保守下界 −1212 行）, -1 依赖  可能**（磁盘 ≈−206MB，含可重建项最多 ≈−631MB；另可合并测试脚手架约 −400~−550 行，未计入）

# Not checked:

> v2 说明：v1 的这份清单里有 **5 项本轮已覆盖并删除**（每项注"v2 已覆盖"），其余保留；新增的缺口在末尾。

- ~~整个 board 测试套件一条用例都没跑到~~ —— **v2 已覆盖：13 个 board unit 直跑 = 188 条用例全 PASS、0 条断言失败**（t11）。
- ~~`unit_all` 的真实 0/64 无法取得~~ —— **v2 已覆盖：0/64 归因 `execFileSync` 被 EPERM；62 个 unit 逐个直跑，真实断言失败 0 条**。那个 0/64 **不是测试失败**。
- ~~`skills.js` 约 5000 行未逐行读~~ —— **v2 已覆盖：1-5819 全文读完**（t9 2400 + t15 3419，无缺口）。
- ~~9 个 `atom_*` 只精读 3 个、15 个 `act_*` 只精读 3 个~~ —— **v2 已覆盖：15 个 `act_*.js` 全部全文读完**（t15）；`atom_*` 9 个中 6 个由 t9/t15 覆盖。
- ~~`preflight.mjs` 1076 行只精读约 300 行；`audit_rules`/`audit_codes` 只看输出~~ —— **v2 已覆盖：preflight 1076 行全文读完**（t17）；`audit_rules` 读了结构（5 个导出）+ `audit_baseline.json` 逐条核对（t12）；`audit_codes.mjs` 确认**全仓零引用**（S34）。
- ~~性能数字全部来自 2026-10-31/11-01/11-03 的 bench~~ —— **v2 已覆盖：55 个 artifact / 3484 条记录重算**（t11，long-route 3.12 格/秒），并确认原 A/B 对照组无效。

**仍然没查的（保留）**：
- **socket 实弹**：第 1 条的"发一条伪造 `from` 的报文就能拿到 owner 权限"是**静态链闭合**，没有对真实运行中的 mindserver 打过包（不启动服务端）。
- **`modes.js` 的精确命中路径**：三条 ReferenceError 已确认"被 `execute()` 吞成 console.warn"，但**"着火"这个触发条件没有实弹构造**（需要真机 + 引火）。
- **新的真机性能**：所有性能数字仍是历史 bench 的复算，**没有一次最近的真机运行**；`down5` 0/10 是否仍为 0 未知。
- **`atom_all.mjs`**（需要服 25566）**一个用例都没跑**。
- **6 个模型适配器只做了 grep 级核实**（vllm/grok/mistral/groq/mercury/gemini）：与已读的 deepseek/gpt 同型，catch 行号已核，**函数体未逐行读**。
- **`P11` 的密钥泄露面未实测**：16 处 `console.log(err)` 是否会打出 `Authorization` header，需要触发一次 401 后 grep 日志。
- **`preflight` §6 的常驻红灯**：本沙箱因 `spawnSync` EPERM（不是第 26 条那个 0x08 —— 那处只坏了三条备选之一，见第 26 条的实测）；在**能 spawn 的环境里 §6 是否真绿**未知。
- **多 bot / 面板 / 长跑现场**：日志里只有 `deepseek` 一个 bot；Vue 面板只做了 typecheck，没有实际点过；没有连续数小时的完整运行记录。跨 bot 的租约/抢占类问题（第 4/16 条）只有代码推演。
- **`utils/mcdata.js`（614 行）只 grep、`vision/` 3 个与 `npc/` 大部分未读**；`atom_all`/`mca_import`/`terrain_view` 未审。

---

# 复核变更记录（t8 独立复核，只追加，不改写上面的历史结论）

复核者身份：独立复核，逐条打开 `文件:行号` 核对。**方法**：`grep -n` / `sed -n` 定位原文 + `npx eslint`（本复核环境**可以**派生 npx，与 t4 不同，因此 6 条高影响断言全部拿到了机器结论）+ 单文件 `node` 直跑。**未改任何被审查源码**，只改本目录。

## 变更总账

| 类别 | 数量 | 明细 |
|---|---:|---|
| 删除条目 | **0** | 20 条硬发现 + S 小项，**没有一条因无据被删**（唯一被删的是两处**表述**，见下） |
| 降级 | **0**（沿用上游已有降级） | N1 已在 v1 降为第 13 条并附反证；本次复核确认该降级正确，未再动 |
| 修正行号/路径 | **4 处** | ① 第 11 条 `item_goal.js` → `src/agent/npc/item_goal.js` ② 第 9 条补 `nav_core.js:50` ③ 第 8 条确认写入方为 `landmarks.js:131` ④ 第 3 条改指 `:159 db.exec(SCHEMA)` |
| 修正数字 | **5 处** | ① `7 处 ReferenceError` → **6 处** ② `49 条误报` → **51 条** ③ `86% 噪音` → **89%** ④ `21 个 atom_*.js` → **9 个** ⑤ `13 个 act_*.js` → **15 个** |
| 加强表述 | **2 处** | ① 第 10 条改为"**凡正常返回即崩，该技能从未成功返回过一次**" ② 第 1 条把"代码执行默认开着"改写为"文档与实际不符 + 安全性押在未审计的 SES 沙箱边界上" |
| 删除的错误表述 | **1 处** | 第 3 条把触发场景里的"**面板在写**"删掉 |
| 无法独立验证 | **见下「复核无法证实的 4 项」** | |

## 六条必验断言（a~f）的结论

| # | 断言 | 结论 | 证据（可复现命令与输出） |
|---|---|---|---|
| **a** | `skills.js:5750` 的 `ok` 从未 import → `digTunnel` 必抛 | **成立（机器验证）** | `grep -n "^import" src/agent/library/skills.js` → 28 条 import，**无 `contract.js`、无 `ok`**；`npx eslint src/agent/library/skills.js` → `5750:12 error 'ok' is not defined no-undef` |
| **b** | `modes.js:118/126 placed`、`:133 walked`、`item_goal.js:163/164 res` 未定义 | **成立（机器验证，路径修正）** | `npx eslint src/agent/modes.js` → `118:29`/`126:33 'placed'`、`133:33 'walked'`；`res` 在 **`src/agent/npc/item_goal.js`** → `163:17`/`164:22` |
| **c** | `eslint.config.js:17/:18` 让 `src/models/*.js` 整文件解析失败 | **成立（机器验证）** | `npx eslint src/models/` → **20 条 `Parsing error: Unexpected token =`** |
| **d** | T5 夹具写 `{pos:{…}}` 而生产写扁平 `{x,y,z}` | **成立（静态闭合）；绿色路径本机无法执行** | 夹具 `atom_classify_unit.mjs:68-69`；生产 `landmarks.js:131`；读端 `landmarks.js:78`。本机跑该测试得 4/5，失败原因是 `EPERM: mkdir bots/__unit_...` |
| **e** | `board_store_converge_unit.mjs:218` 的 XFAIL ②-6 就是审计② B3 | **部分成立** | 行号正确；**同一根因**（依赖进 blocked → 后继永久 ready），但断言对象不同：XFAIL 断言"无留痕"，B3 是"永不收敛"。报告里宜理解为"同一根因" |
| **f** | `nav_lock_unit` 只测显式 owner，`adhoc` 零命中 | **成立** | `grep -c adhoc tools/nav_lock_unit.mjs` → **0**；生产缺省 `'adhoc'`（`nav_core.js:189` 与 `:50` 两处） |

## 复核确认"通过、无需修改"的高影响条目（抽检 10+ 条）

| 编号 | 核对了什么 | 结果 |
|---|---|---|
| 1 | `mindserver.js:392-402` 原样转发 `data`；`local_only.js:38`；`mindserver_proxy.js:117`；`settings.js:33`；`README.md:178`；`my-local.json:6` | **全部逐字命中**；身份→等级链闭合 |
| 2 | `prompter.js:110` `mkdirSync`、`:111` `writeFileSync`（第三参是回调，同步 API 忽略但**文件照写**）；校验在 `agent.js:205` | **通过** |
| 3 | `board_store.js:145-201`；`:159` `db.exec(SCHEMA)` 为唯一 BUSY 抛点 | **通过** |
| 4 | `board_store.js:637-659` 仅 `WHERE id=?`；`heartbeat()` `:503-504` 反而校验 owner | **通过** |
| 5 | `:934-943`；`:1113-1115`；`:1009-1015`；板库三行 + 日志 `t59:120/236/261` | **通过（双向闭合成立）** |
| 6 | `board_scheduler.js:655`；`action_manager.js:91`；`control.js:242`；`:441`；`runJobAction` 零调用方 | **通过** |
| 7 | `agent_process.js:37` → `:39` `process.exit(code)`；`:41-49` 10 秒守卫 | **通过** |
| 8 | 读 `:78-80` / 写 `:131`（chest）、`:185`（storage）、`:203`（sites）全为扁平 | **通过** |
| 9 | `:189` 与 `:50` 两处 `adhoc` 缺省；`:128` | **通过（补 :50）** |
| 10 | 见断言 a | **通过（表述已加强）** |
| 11 | `✖ 319 problems (319 errors, 0 warnings)`；semi 107 / require-await 78 / no-undef 57 / no-floating-promise **39** / Parsing error **20** | **通过** |
| 12 | `grep -cE '^\[[0-9]{2}:[0-9]{2}'` → `tmp-t59-agent.log` **0/293**、`run-live.log` **0/85** | **通过** |
| 13 | `skills.js:5402` 默认 64；`:5428` `Math.max(16, radius)`；反证 `run-live.log:39` 162ms | **通过（降级正确）** |
| 18 | `ls tools/test_*.mjs` = **44**；仅注册 2 个 → 孤儿 **42** | **通过** |
| 19 | `agent_process.js:37-40` | **通过** |
| 20 | `grep -c "^export function\|^export async function\|^export const" skills.js` = **98** | **通过** |

## 复核无法证实的 4 项（不是"错"，是"本次查不了"）

1. **板套件（8 个 board_*_unit）的断言强度**：本环境 `writeStore` 触发 `EPERM: mkdir bots/...`，一条用例跑不到。（**v2 已由 t11 补齐**：13 个 board unit 直跑 188 条全 PASS）
2. **B5 的 `SQLITE_BUSY` 实际 `errcode`**：机制明确，但未构造"两进程争锁 >5 秒"现场。（**v2 已由 t11 补齐**：`BEGIN EXCLUSIVE` 10 秒 → `rebuilt=true`、`error="database is locked"`）
3. **第 1 条"`!newAction` 会真的执行代码"**：链路已静态核实，但**没有实弹验证**。（**v2 部分补齐**：队长探针证明了沙箱可逃逸，但"从 socket 到执行"这一跳仍未实弹）
4. **第 5 条父单 166 分钟**是用 `board.sqlite` 副本只读查询得到的时间戳差；**该库是"当时"的快照**，复核时无法重现"仍在增长"这一动态。

---

## v2 增补记录（t13 汇总，只追加）

**本轮的输入与产出**：`00-REPORT.md` v1（621 行）+ 07~13 七份分册（合计约 3200 行）→ 并入为 v2。

| 类别 | 数量 | 明细 |
|---|---:|---|
| **v1 编号改动** | **0** | 1~20 一个都没重排、没改号；被新证据修正的条目**在原位置**加「v2 修订」标注 |
| **新增硬发现** | **14 条** | 21~34：Must 7（21/22/23/24/25/26/27）、Should 7（28~34） |
| **新增小项** | **13 条** | S33~S45 |
| **新增整节** | **4 节** | 第 四 节「实测 vs 推断」（34 行总表）、第 五 节「沉宝」、第 六 节「同一错误复发」、第 七 节「有正确解法却没抄」、第 八 节「失控面（两处）」 |
| **重写** | 3 节 | 第九节（测试成绩单按 t11 推翻重写）、第十一节（性能按 3484 条记录重算）、第十四节（路线图三批全部重排） |

**t11 的 10 条改判兑现位置**：① B5 拆两句 → 第 3 条 + 第 24 条；② schema 不匹配新起一条 → **第 24 条**；③ modes 降级 → 第 11 条 + 第十二节第 7 项；④ board 188 用例全 PASS → 第九节；⑤ `unit_all` 0/64 归因环境 → 第九节 + Not checked；⑥ `skills.js:5750` 已实测崩溃 → 第 10 条；⑦ 1.41 格/秒无支撑 → 第十一节；⑧ `gap-bridge` 的 `dist` 不可信 → 第十一节；⑨ 路径穿越已实测解析 → 第 2 条；⑩ RCON 仍 `0.0.0.0 + [::]` → S1（沿用）。

**队长亲验的四条已按最高等级落入正文**：SES 逃逸 → 第 1 条（定性改为"锁上了也没用"）；`isAttackable` 未接 → 第 21 条；`useToolOn` 恒假 → 第 28 条；`giveToPlayer` 恒真 → 第 22 条；另 `novita.js:47` 缺 `this.` → 第 30 条、心跳无 try/catch → 第 32 条、preflight 0x08 → 第 26 条。

**对 07~13 各分册结论的处置**：
- **采纳并升级**：t15 的"原子层干净/脏在 skills.js" → 写成第 五 节的一级洞察；t15 的 §2 十二差异表 → 并入第 20 条；t17 的 0x08 疑点 → 第 26 条（从"待复核"升级为**已实测定案**）。
- **采纳并纠正**：t17 说"§6 红灯源于 0x08" → **实测否定**（`:933` 三条备选里第一条完好，§6 在本沙箱是 spawn EPERM）；t4 的 T8（`test_codes` 是误报）→ **纠正**（它报得对，错的是口径）；t15 的 D21（`collectHazardsCached` 死代码）→ 保留为 S37（t16 说"未拿到原文"）。t16 的 D17 纠正一处：`isPlayerBuiltBlock` 的第二调用点是 `:3973` 蓝图放置，**不是** `levelGround`（第 23 条已按此写）。
- **未采纳**：t12 建议"三套玩家建筑判定合并" → **明确反对**（J1/J2 语义相反，合并会复活 `world_model.js:80-83` 记录过的真实 bug），已写入 13.2 误删禁区。
- **保留待办**：t16 的 `mca_import.js`（171 行）、`query_classify.isProtected` 实现、`utils/text.js`、`vision/` 3 个、`npc/` 大部分 —— 见 Not checked。

**本轮新增的两个可复跑探针**：`docs/audit/probes/t13-regex-check.mjs`（核验 preflight 0x08 三条正则的实际命中行为）、队长留下的 `captain-verify-ses-escape.mjs` / `-escape2.mjs`（SES 逃逸）。

**v2 自检**：`grep -E "^## [0-9]+ "` → 20 条（v1）+ 14 条（v2）= **34 条，编号 1~34 无重复**；全文无三类模糊表述（"建议+考虑"、"或+许"、"可能+存在问题"这类措辞，已逐条 grep 确认为 0）；失控面只出现两处（第 八 节）；关于 dig 是否会被打断，第 八 节只在"明确排除"的语境下出现一次，无任何条目主张它停不下来。

---

# 复核变更记录 v2（t14 独立复核，只追加，不改写上面的历史结论）

复核者：独立复核第二轮。方法同第一轮：逐条打开 `文件:行号` 读原文、`grep -n` 复核、`od -c` 验证字节、`ls probes/` 核对证据存在性。**未改任何被审查源码**，只改 `docs/audit/`。

## 总账

| 类别 | 数量 | 明细 |
|---|---:|---|
| **v1 编号稳定性** | **稳定 ✅** | 1~20 全部存在、编号未变、相对顺序未变（含 v1 的"7 处→6 处"等已修正内容均保留）。21~34 为 v2 新增，**连续、无重复、无缺号**（机器核：`grep -cE "^## [0-9]+ "` = 34，`uniq -d` 为空） |
| **改判（状态标签）** | **5 条** | 21 / 22 / 28 / 30 / 32 从「已实测（队长亲验）」→ **静态确证**（详见 A 节） |
| **修正行号/内容** | **2 处** | ① 第四节 #1 的状态需拆分（见 A 节）；② 第十四节路线图 E2 那行的括号描述**与实际代码相反**（见 C 节） |
| **降级为"未并入且未说明"** | **4 条** | 08 分册的 E3/E4/E5/E6 在 v2 主报告里**零命中**，且「十二、已降级说明」未提（见 C 节） |
| **补记缺口** | **1 条** | 07 分册越权表第 7 行「读文件系统」在主报告里**零命中**（见 D 节） |
| **删除条目** | **0 条** | 34 条硬发现 + S1~S45，无一条因无据被删 |

**一句话**：编号稳、无捏造；问题不在"编造"，在**5 条"队长亲验"被标成了"已实测"**，以及**两条新分册的结论没进主报告也没登记**。

## A.「实测 vs 推断」34 行总表逐条核对

**判定口径（照抄总表自己的定义）**：已实测 = 本仓库里真的跑出过输出，能在 `09-empirical.md` 或 `probes/` 找到对应命令与结果。**"读代码看出来的"按此定义一律是静态确证。**

### A.1 被我降级的 5 条（原标「已实测（队长亲验）」）

| 编号 | 原标 | 改为 | 理由（可复现） |
|---|---|---|---|
| **21 技能能攻击玩家** | 已实测 | **静态确证** | `grep -c giveToPlayer\|useToolOn\|novita\|attackNearest\|807 probes/*.mjs` → 空；`grep -c attackNearest 09-empirical.md` 的 3 处全在 §3.3（讲 `item_goal.js:163` 的 ReferenceError），**与"能否攻击玩家"无关**。内容本身我复核**成立**：`act_attack.js:31-35` 的 `NOT_ATTACKABLE_TYPES` 第一项确是 `'player'`，且 `grep -c isAttackable skills.js` = **0** |
| **22 `giveToPlayer` 恒真** | 已实测 | **静态确证** | `09-empirical.md` 中 `giveToPlayer` = **0 命中**、probes 中 0 命中。内容复核**成立**：`skills.js:1609` `const got = await waitUntil(...)`、`:1611` `if (got) return true;`——`waitUntil` 返回对象，恒真 |
| **28 `useToolOn` 恒假守卫** | 已实测 | **静态确证** | `useToolOn` 在 09/probes **0 命中**。内容复核**成立**：`skills.js:2760` = `if (!bot.inventory.slots.find(...) && !bot.game.gameMode ==`——`!bot.game.gameMode` 先求值再与字符串比，恒假 |
| **30 `novita.js:47` 缺 `this.`** | 已实测 | **静态确证** | `novita` 在 09/probes **0 命中**。内容复核**成立**：`novita.js:47` = `return await sendRequest(...)`，而 `deepseek.js:44` = `return await this.sendRequest(...)` |
| **32 心跳无 try/catch** | 已实测 | **静态确证** | `心跳` / `agent.js:807` 在 09 **0 命中**，probes 0 命中。内容我**未逐行复核**（`agent.js:807-820` 本轮未打开），故只改状态、不背书内容 |

> 这 5 条**内容大多是真的**（我复核了 4 条的代码，全部成立）。问题只在于**"队长读代码确认"不等于"跑出过输出"**。作者若按"已实测"去排期（以为已有可复跑证据），会找不到对应的探针。**建议：要么补探针，要么保留"静态确证"**。

### A.2 第 1 条：状态需**拆分**（不是降级）

第 1 条标「已实测」，但它是两件事的复合：
- **沙箱可逃逸** → **真已实测**（`probes/captain-verify-ses-escape.mjs` / `-escape2.mjs` 存在且就是干这个的）✔
- **控制面无认证** → `09-empirical.md` §6.1 原文自己写的是「**静态确证，无法实弹**（mindserver 当前未运行，任务禁止启动它）」✘

**处理**：不是把整条降级（那会低估它），而是在状态栏写清"**已实测（仅沙箱逃逸那半）/ 静态确证（认证那半）**"。已在本次复核中标注。

### A.3 其余 9 条「已实测」：全部核对通过 ✅

| 编号 | 支撑物（我实际核对到的） |
|---|---|
| 2 路径穿越 | `probes/p6_path_traversal.mjs` 存在；09 §6.2「已解析到具体绝对路径」 |
| 3 板库当坏库重建 | `p2_lockholder.mjs` / `p2_lockholder_exclusive.mjs` / `p2_openboard.mjs` 三个探针 + `probes/run/lock*.log` 三份输出都在；09 §2.2 有真实输出 |
| 5 依赖死掉→父单 running | 板库副本查得 `j_20261105_0002_ngl` 卡 166 分钟 + `t59:120/236/261`（**我在 t5/t16 亲手复核过这条**）✔ |
| 7 重启守卫 | `run-live.err.log` 末行（**我 t5 亲手读过**）✔ |
| 9 导航闸 adhoc | `t59:164/:180`（**我 t5 亲手读过**）✔ |
| 10 digTunnel ok | `probes/p3_reference_errors.mjs` case 1 就是它；`npx eslint` 5750:12 no-undef（**我 t8 亲手跑过**）✔ |
| 11 门禁 319 errors | **我 t8 亲手跑出 319 / 20 条 Parsing error** ✔ |
| 12 日志无时间戳 | **我 t5 亲手跑 `grep -cE` 得 0/293、0/85** ✔ |
| 18 42 个孤儿测试 | **我 t8 亲手 `ls tools/test_*.mjs`=44、注册 2 个** ✔ |
| 24 schema 不匹配 | 09 §2.3「`no such column` 无需并发即进重建」有真实输出 |
| 26 preflight 0x08 | `probes/t13-regex-check.mjs` 存在；**我本轮亲手 `od -c tools/preflight.mjs:183` 看到 `/ \b f a i l`（单字节 0x08），两行合计 13 处** ✔ |

### A.4 19 条「静态确证」：抽查 1/3（7 条）复核闭合 ✅

抽查 4/14/15/16/17/29/33：

| 编号 | 我复核到的 |
|---|---|
| 4 finish 不校验租约 | `board_store.js:637-659` 只 `WHERE id=?`；同文件 `heartbeat():503-504` 有 owner 校验（**我 t2/t10 两次读过**）✔ |
| 14 LIMIT 200 | `:378-382` 默认 200、`:1082` 自述"从不删除"✔ |
| 15 expireLeases 不记 attempts | `:668-684` 的 UPDATE 只有 state/lease/updatedAt ✔ |
| 16 箱子丢更新 | `flow_store.js:74-88` 两次 `await` 往返 ✔ |
| 17 幽灵父单 | `:1175-1207` 无事务 + `:1114` 跳过 `kids.length===0` ✔ |
| 29 两处 bot.chat 绕过 | `:1029` `bot.chat(msg)`、`:4000` `bot.chat(cmd)`（**本轮亲手 sed 核对**）✔ |
| 33 goToGoal 180s | `:1794` 常量 + 全文无 interrupt（**我 t10 读过 1734-1815 区段**）✔ |

**「仍为推断」= 0 条**：与总表一致，我未发现被标成"仍为推断"却措辞暗示已验证的条目。

## B. v1 编号稳定性：**稳定 ✅**

- 34 条全部存在、**无重复**（`uniq -d` 为空）、无缺号。
- v1 的 1~20 **编号一个没变、相对顺序一个没变**；v1 复核时我改过的（第 11 条"7 处→6 处"、第 3 条删"面板在写"）**都还在**，说明 v2 是在 v1 上增量改，没有重写。
- **一个需要注意的排版后果**（不是重排，但会让人误读）：v2 把新增的 Must（21~27）插在 13 之前，于是物理顺序是 `1..12, 21..27, 13..20, 28..34`。按编号找条目没问题，但**按段落顺序读会从 12 跳到 21**。建议在"二、Should fix"开头加一句"本节含 v1 的 13~20 与 v2 新增的 28~34"。

## C. 07~10 新分册与主报告的一致性

| 分册 | Must 级发现 | 是否进主报告 |
|---|---|---|
| **08**（执行器/流程） | **E1** follow 超时参数没接上 | ✅ 进 **§八 失控面**（表格第一行，证据完整） |
| | **E2** digdown 液体假成功 | ⚠️ **只进了路线图（:878），且括号描述与代码相反**——见下 |
| 08 Should | E3 `checkLevel` 返回 false / E4 `embellishments` 传错 newZ / E5 任务 JSON→owner 级命令 / E6 `runCraft` 不传 ctx | ❌ **主报告零命中**（`mismatches`/`embellishments`/`startConversation`/`runCraft` 各 0 次），「十二、已降级说明」也未提 |
| **10**（文档/许可/bug） | **F1** 索引指向过期手册 | ✅ 并入 **第 27 条**（"闸门与被索引的文档都盯着已作废的对象"，F1+F2 合并） |
| | **F2** 棘轮 9 条指向已删文件 | ✅ 同上，并入第 27 条 |
| **07**（skills 深读） | **D1** SES 3 行可逃逸 | ✅ 并入 **第 1 条第三层**（并升级为"已实测"） |
| | **D2~D5**（digTunnel/命令绕过/箱子计数/熔炉覆盖） | ✅ 分别并入 **第 10、29、16、S 组** |
| **09**（实证） | 无独立 Must（它是证据层） | — 其结论已散入各条的"实测"标注 |

### C.1 需要修的两处

**① 第十四节路线图 :878 的 E2 描述与代码相反**（这是本轮**唯一的内容性错误**）：
原文写「**E2** | **`digdown` 液体假成功**（`executor.js:344` 设 `liquidBlocked`、`:363` 返回 `BLOCKED`）」
—— 这是把**修法**写成了**现状**。实际代码是：`:342-345` 遇液体只 `break`，**不设** `liquidBlocked`；`:363` 是 `return ok({ dug })`。`liquidBlocked` 与 `BLOCKED` 只存在于**同文件 `dig` 分支**（`:243`、`:312-314`）——这正是 08 报告的核心论点（"dig 修过的坑没同步到 digdown"）。读这一行的人会以为 bug 已经不存在。

**② 08 的 E3~E6 未并入也未登记**。其中 **E5 最值得补**：任务 JSON 的 `goal`/`conversation` 被拼进 `!goal("...")` / `!startConversation("...")` 且带 `internal: true`（= 主人级），是"数据文件 → owner 级命令"的注入面。它与第 1 条同族（都是"外部输入拿到主人权限"），建议至少并入第 1 条作为第 4 个子场景，或在第十二节登记"为何不进"。

## D. 07 越权能力面 vs 第 1 条：**定级够，但漏了一条路**

**结论：第 1 条的定性在 v2 已经对了，但覆盖面仍缺一块。**

- **够的部分**：v1 说"安全性押在未经审计的沙箱边界上"，v2 改成「**而且"代码执行沙箱"根本关不住**」，并给出实测三行 `skills.log.constructor('return process')()` → `world.constructor.constructor('return require')()` → `child_process.exec(...)`。这正好回答了本任务 D 的问题："认证补上了模型依然能拆家"——**是的，而且不只拆家，是任意代码执行**。定级（Must 第 1 条）**足够，不需要再升**。
- **缺的部分**：07 §3.5 越权表**第 7 行「读文件系统」**（`skills.describeSchematic(bot,'../../settings.js')` / `listBlueprints('C:/Users')`）在主报告里 **`grep` 零命中**。这条路的特点与第 1 条不同：**它不需要逃逸沙箱**，用的就是正常 skill API + 路径穿越。
  → 如果第 1 条只讲"沙箱逃逸"，读者会以为"不开放代码执行就安全了"；而**即使 `allow_insecure_coding=false`，模型仍可用 `describeSchematic` 读任意文件**。
- **建议**（最小改动）：在第 1 条第三层后加一句：「另有**不依赖沙箱逃逸**的同类路径：`skills.describeSchematic`/`listBlueprints` 的路径参数未做根目录约束（07 §3.5 第 7 行），`describeSchematic(bot,'../../settings.js')` 即可读任意文件——即使关掉 `allow_insecure_coding` 这条路仍在。」
- 顺带：**"删玩家建筑"这条路**主报告已有第 23 条（`levelGround` 拆农田），我另在 12 分册给出 W1/W2（`levelGround` 白名单含圆石/泥土、`breakBlockAt` 零判定），**这两条也未进主报告** → 与 C.1② 同类，建议一并登记。

## E. 本轮我修正/新增的内容

1. 第四节总表：21/22/28/30/32 五条状态 已实测 → 静态确证（已在上文 A.1 留档）。
2. 第四节总表：第 1 条状态拆为「已实测（沙箱逃逸）/ 静态确证（无认证）」。
3. 第十二节：追加 C.1② 与 D 的登记项（见下方"追加登记"）。
4. 统计口径变化：**已实测 15 → 10、静态确证 19 → 24、仍为推断 0**。（第 1 条按拆分计，不重复计入两侧。）

### 追加登记（补进第十二节「已降级说明」的清单）

- **08 的 E3/E4/E6**：未并入 v2 主报告。理由（我的判断）：均为单点健壮性问题，不影响主报告 34 条的结论强度；**但 E3（`!checkBlueprint` 会抛 TypeError）是可被用户直接触发的命令级崩溃**，建议进 S 组。
- **08 的 E5**（任务 JSON → 主人级命令注入）：**建议并入第 1 条**（见 C.1②），不进 S 组。
- **12 的 W1/W2**（`levelGround` 白名单含圆石/泥土/农田、`breakBlockAt` 零判定）：与第 23 条同族，**建议并入第 23 条**而不是另起编号（避免第 8/23 条被拆成三条）。
- **07 的越权表第 7 行**（读文件系统）：**建议并入第 1 条**（见 D）。

---

# v2.1 补丁记录（t18 收尾，逐条对应 t14 复核的 6 项）

> 只补 t14 指出的漏并/表述错，**未改 v1 的 1~20 编号、未改已有条目的定级**（唯一的状态调整是第 ①⑥ 项要求的"已实测→静态确证"降级与第 1 条状态拆分）。

| # | t14 指出 | 本轮改了什么 | 落在正文哪里 |
|---|---|---|---|
| **①** | 路线图 E2 的括号把**修法写成了现状** | 改成描述现状：`executor.js:342-345` 发现正下方是液体只 `break`、`:363` 仍是 `return ok({dug})` 而 `dug=0`；并明确写出「**`dig` 分支早已修过**（`:240-245` 诊断注释、`:310-314` 加 `liquidBlocked` + 显式失败），**`digdown` 分支没有同步**」。这正是 08 分册的核心论点，之前写反会让读者以为 bug 不存在 | 第十四节 第二批 E2 行 |
| **②** | E5（任务 JSON → 主人级命令）未并、E3/E4/E6 未登记 | **E5 并入第 1 条**，作为「**第五层（第三种入口，连 socket 都不需要）**」：`tasks.js:407` 把 `agentGoal` 拼进 `!goal("…")`、`:509` 把 `this.data.conversation` 拼进 `!startConversation(…)`，两处都 `{internal: true}` 而该标记的**设计意图正是跳过发言人权限闸门**（`:405-406` 注释原文）→ 改一个任务 JSON 就能让 bot 以主人身份执行。**E3/E4/E6 登记进第十二节「已降级说明」第 11 条**并写明不进 1~34 的理由（都在 `construction_tasks.js`，离线生成器/校验器，不在常驻运行链路），三条均**已核实到行号**：E3 `:47-51`（`:51` 直接解引用 `.mismatches`，同型在 `:15/:19/:65/:121-122`）、E4 `:738`/`:741`（`addWindowsAsSquares/Plane(matrix, **newZ**, newY, **newZ**, …)` 把 `newZ` 当 x 传，对比 `:749/:752` 的 `addCarpet` 正确传 `newX`）、E6 `composite_registry.js:109`（18 项里唯一不传 `ctx`） | 第 1 条第五层 + 第十二节第 11 条 |
| **③** | 07 越权表第 7 行「读文件系统」主报告零命中 | **并入第 1 条**，作为「**第六层：不需要"代码执行"的越权面**」。按 captain 的核实收窄了口径：`skills.js:4039` → `:4051` → `schematic.js:52 path.resolve`（**无前缀校验**）→ `:56 fs.readFileSync`。**能读内容的只有能解析成 litematic 且含 `Regions` 的文件**（`:64` 解析、`:66` 校验），普通文本/源码会走 `:4058-4061` 的 catch 只返回错误消息；能力准确说是「读取磁盘任意位置的蓝图并把材料清单读回模型」+「`existsSync` 与两类错误消息构成的**任意路径存在性探测**」；另附 `listBlueprints` → `schematic.js:164-173 readdirSync(path.resolve(dir))` 的**任意目录枚举**。并在第 1 条新增一句结论：**把 `allow_insecure_coding` 改成 false 不等于安全** | 第 1 条第六层 + 「结论一句话」+ 最小修复 ⑤⑥ |
| **④** | W1/W2 未进主报告 | **第 8 条标题与正文重写**：标题从"地标清单恒为空"改成「**能拆玩家方块的路有 4 条，其中 3 条零有效保护**（J1/J2/J3/J4）」；新增四行判定表（J1 `world_model.js:95-100` 纯名字匹配、全树仅 2 个调用点且都在放置侧；J2 `NATURAL_BLOCKS:3359-3388` 语义相反且含 `farmland`；J3 `landmarks.js:78-80` 恒空；J4 `breakBlockAt:1007-1078` 零判定）；问题清单从 2 条扩为 4 条，**W1（`/fill air replace` 逐个拆 `:3419-3424`，不可撤销，含农田）与 W2（`breakBlockAt` 零判定、只有 JSDoc 警告）成为第 2、3 条**；附 12 分册的"逐场景精度"一行；最小修复补 ③④⑤ 三条。**并保留 t13 的反对意见**：明确写「**不要**把 J1/J2/J3 合并成一套判定 —— 语义相反，合并会复活 `world_model.js:80-83` 记录过的真实 bug；正确方向是新增位置型判据」 | 第 8 条（标题 + 判定表 + 问题 4 条 + 最小修复 + 反对意见） |
| **⑤** | 段落物理顺序从 12 跳到 21，读者会以为漏了 13~20 | 在「一、Must fix」开头的引用块里加了一行 `> 编号说明：1~20 为 v1 沿用…；21~34 为 v2 新增。因新增 Must 插在 Should 之前，正文物理顺序为 1..12 → 21..27 → 13..20 → 28..34，按编号查找不受影响。` | 第一节标题下 |
| **⑥** | 「实测 vs 推断」总表与实际不自洽 | 三处改动：① **第 1 条状态拆分**为「已实测（逃逸那一半，有探针）/ 静态确证（无认证那一半，`09-empirical.md:397` 自写"没有实弹打过包"）」；② **21/22/28/30/32 五条从「已实测（队长亲验）」降为「静态确证」**（理由：它们是读代码确认的，`09-empirical.md` 与 `probes/` 零命中）；③ 合计从「已实测 15 / 静态 19」改为「**已实测 10 / 静态确证 24 / 仍为推断 0**」，并写明口径（只有逃逸那半计入已实测）。**同口径同步改到第 1 条尾部的状态行** | 第四节表格第 1/21/22/28/30/32 行 + 统计行；第 1 条尾部 |
| **版本** | — | 顶部版本行 → `版本：v2.1（v2 + t14 复核后的 6 项漏并补齐）` | 第 3 行 |

**自检（本轮）**：
- 编号：`grep -E "^## [0-9]+ "` → **34 条，1~34 无重复无跳号**；v1 的 1~20 条目**编号与正文一字未动**（第 8 条的扩写是在原条目内追加，编号仍为 8）。
- 第 8 条已覆盖 J1/J2/J3/J4 四条路径，且全文**没有**"合并三套判定"的建议（只有一条**反对**合并的说明）。
- 第 1 条已写出"**把 `allow_insecure_coding` 改成 `false` 不等于安全**"，并带 `schematic.js:52` 的 `path.resolve` 无校验 + `:56 fs.readFileSync` 的行号。
- 三类模糊表述（"建议+考虑"、"或+许"、"可能+存在问题"）grep = **0**。
- 未改任何源码（`cd mindcraft && git status` 为空）。
