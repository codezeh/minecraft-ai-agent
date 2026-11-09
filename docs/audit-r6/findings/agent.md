# 运行时与模型适配层缺陷（agent / models / sim / process）

审计轮次：R6 · 审计员：scan-agent（运行时审计员）
范围：`mindcraft/src/agent/**`（含 `commands/`、`library/`、`tasks/`、`npc/`、`vision/`）、`src/models/`、`src/sim/`、`src/process/`
方法：逐文件读码 + 只读脚本核对（`contract.js` CODES 产出矩阵、"权限表 vs 命令实现"集合差），**未修改任何产品代码**
结论：**20 条真缺陷**（P0×2 / P1×5 / P2×8 / P3×5）+ 1 组已核实为"非缺陷"的误报项 + 明确的未覆盖边界。

> 判据：只收"真机上会出错"的——空/满/最后一件/超时/中断/重试的边界、abort 传不到、同一规则两处实现、只增不减、O(n²)、catch 后状态没回滚。

---

## P0

### A1 · 三个模型出口从未接上取消信号 —— prompter 的 t29 修复在生产里是死代码

| | |
|---|---|
| 位置 | `src/agent/history.js:106`、`src/agent/coder.js:73`、`src/agent/vision/vision_interpreter.js:116`（消费端 `src/models/prompter.js:476,540,647`） |
| 触发输入 | 玩家 `!stop` / 面板停止 / 动作 10 分钟总超时，而此刻正在做**记忆摘要** / `!newAction` **代码生成** / **看图** |
| 错误结果 | 三个调用点都没传第 2 参 `opts`：<br>`history.js:106` → `promptMemSavingResult(turns)`<br>`coder.js:73` → `promptCodingResult(messages_copy)`<br>`vision_interpreter.js:116` → `promptVisionResult(messages, imageBuffer)`<br>于是 `prompter._callOptions({})` 得到 `signal=null / timeoutMs=120000`，`sendRequest(..., opts)` 里 `opts.signal` 恒为 null ⇒ **abort 无路可走**，只能等适配器自身的 120s 上限。`!stop` 之后最长 2 分钟才真正停手，且迟到的摘要/代码会照常落盘或执行。<br>而 `action_manager.js:357-359` 明明生成了唯一取消源并挂在 `agent.currentOperation` 上——只是没人把它传下去。prompter 里几段 `★ t29：接取消信号` 的注释描述的是**已修好的另一半**，这一半没接。 |
| 最小修法 | 三个调用点统一传：<br>`{ signal: this.agent.currentOperation?.ac?.signal ?? null, deadline: this.agent.currentOperation?.deadline ?? null, operationId: this.agent.currentOperation?.id ?? null }`<br>（history 里是 `this.agent`，coder 里是 `this.agent`，vision 里是 `this.agent`）。改 3 行，无需动 prompter。 |

### A2 · 失败动作的名字永远是 `(unknown)`

| | |
|---|---|
| 位置 | `src/agent/action_manager.js:404` 与 `:413` |
| 触发输入 | 任意动作抛异常（`generateCode` 语法错、技能内部 throw、断线） |
| 错误结果 | `catch` 块先执行 `this.currentActionLabel = ''`（404），随后才组装失败记录 `action: this.currentActionLabel \|\| '(unknown)'`（413）⇒ `bot.lastFailure.action` **恒为 `'(unknown)'`**。面板/日志里"上一次失败的是哪个动作"这条信息永久丢失，排障只能翻上下文。 |
| 最小修法 | 在 404 之前取下标量：`const failedLabel = this.currentActionLabel;`，413 用 `action: failedLabel \|\| '(unknown)'`。 |

---

## P1

### A3 · 启动日志说的权限语义与真实实现相反（同一规则两处实现）

| | |
|---|---|
| 位置 | `src/agent/agent.js:248-251` 对比 `src/agent/permissions.js:248-270` |
| 触发输入 | profile 里没写 `permissions.owner`（本仓 `profiles/defaults/*`、`deepseek.json` 等实测都是 null，permissions.js:262 自承） |
| 错误结果 | 启动打印：`未配置 permissions.owner —— 当前人人「信任级」` + `可用：聊天/走/跟/采集/制作/建造/存取`。<br>而 `resolveLevel` 早已改成 F-AI-201 fail-closed：没 owner ⇒ 返回 `OTHER` ⇒ `canRunCommand` 一律 false ⇒ **所有聊天命令都不响应**。<br>用户照着日志排障 → 方向全错（以为是命令实现坏了，其实是权限闸门）；`!newAction`、斜杠命令也一样不可用。这是"同一规则两份实现"的教科书案例，而且落在最容易被读的地方。 |
| 最小修法 | 让 agent.js 这段直接问权限模块，别再手抄一份文案：`const lv = commandLevel('!collectBlocks'); const lv2 = commandLevel('!newAction');` 打印 `lv/lv2`，或直接改成与 permissions.js:264-267 相同的措辞（`没配 owner ⇒ 所有玩家聊天命令不响应`）。 |

### A4 · `history.save()` 抛错 + 所有调用点 fire-and-forget ⇒ 未处理拒绝打挂进程

| | |
|---|---|
| 位置 | `src/agent/history.js:302-307`（`catch { console.error; throw error }`）；调用点 `agent.js:747, 886, 1108`、`npc/controller.js:106` 均**不 await** |
| 触发输入 | `writeFileSync(this.memory_fp, ...)` 失败：磁盘满、Windows 上文件被面板/杀软占用、`bots/<name>/` 权限变更 |
| 错误结果 | `save()` 是 async 且**重新抛出**，调用点没有 `.catch()` ⇒ unhandled promise rejection。Node 24 默认 `--unhandled-rejections=throw` ⇒ **整个 agent 进程崩**。最讽刺的是 `cleanKill()`（1108）里也这么调：一次落盘失败会把"正常重启"变成"异常崩溃"，退出码也不再是预期值（会偏离 planExit 的 0/1/>1 三分支）。 |
| 最小修法 | 与 `appendFullHistory` 同口径：`save()` 内部只 `console.error` 不 throw；或用 `void this.history.save().catch(()=>{})` 收口 4 处调用点（前者更稳，1 处改动）。 |

### A5 · `memory.json` 一旦损坏就永久起不来（没有自愈，全程记录反而有）

| | |
|---|---|
| 位置 | `src/agent/history.js:413`（`JSON.parse`）、`:428-431`（catch 后 `throw`）；消费点 `agent.js:277` `save_data = this.history.load();` 未捕获 |
| 触发输入 | `memory.json` 被写坏：进程在 `writeFileSync` 中途被杀/断电（非原子写）、用户手改错一个逗号、外部脚本截断 |
| 错误结果 | `load()` 抛出 → `agent.start()` 抛出 → `init_agent.js:140-144` 兜底 `process.exit(1)` → `planExit` 判"快速退出"→ 退避重启 → 连续 8 次后 `unregister`（`agent_process.js:63-68`）⇒ **这只 bot 永久下线，必须人工删文件**。<br>对比：同文件的全程记录写入有 `FULL_HISTORY_CORRUPT` 自愈（`history.js:173-180`），memory.json 这条更重要的路径反而没有。 |
| 最小修法 | `load()` 的 `catch` 里：把坏文件改名为 `memory.json.corrupt-<ts>`，`console.error` 一句，`return null`（等价于"没存过记忆"），让 bot 正常起来。 |

### A6 · 进程 setup 阶段的异常用 `exit(0)`，被当成"正常结束"⇒ 不重启、不卸载、只剩面板显示离线

| | |
|---|---|
| 位置 | `src/agent/agent.js:398-401`（spawn 处理器 catch → `process.exit(0)`）；判定在 `src/process/agent_process.js:58-60`（`code === 0 ⇒ action:'none'`） |
| 触发输入 | `spawn` 事件处理器里任一抛错：`initExamples()` 失败（profile 缺 examples）、`self_prompter.handleLoad` 抛（存档里 state≠STOPPED 但 prompt 为空，`self_prompter.js:63-64`）、vision 初始化失败 |
| 错误结果 | 退出码 0 = "正常结束" ⇒ `planExit` 返回 `none`：**不重启、也不走 unregister 的告警分支**。同一份代码里"起不来"的其它路径（`init_agent.js` 的 catch）用的是 `exit(1)` = 会重启，两条路径语义相反。真机表现：bot 掉线后再也不回来，日志里只有一行 `Error in spawn event`。 |
| 最小修法 | 改成 `this.cleanKill('Error in spawn event: ' + msg, 1)`（或 `process.exitCode = 1; process.exit(1)`），与 init_agent 的失败路径对齐。 |

### A7 · 退出路径被一个可能挂住的网络 ack 拖死

| | |
|---|---|
| 位置 | `src/process/init_agent.js:105-109`（`await board.update(...)` / `await board.release(...)`）经 `gracefulStop`（`:89-115`）串在 `cleanKill` 包装里（`:128-137`） |
| 触发输入 | board socket 半死：连接还在但服务端不回 ack（mindserver 卡、库锁、网络抖动） |
| 错误结果 | `await` 无超时 ⇒ `gracefulStop` 永不返回 ⇒ 包装后的 `agent.cleanKill()` 永不执行 `process.exit`。后果链：动作超时/僵尸判定的 `_onZombieAction`（`action_manager.js:180`）也走 cleanKill ⇒ **"停不下来就重启进程"这条兜底自己也被卡住**，面板"停止"同样停不掉，只能杀进程。代码注释写着"交还失败也要继续退出"，但实现只 `catch` 了异常、没有兜住"不返回"。 |
| 最小修法 | 两处 await 都套 `Promise.race([p, new Promise(r => setTimeout(r, 500))])`，保证 500ms 后一定继续走到 exit。 |

---

## P2

### A8 · 已经过期的操作仍会发一次模型请求（"剩 0 秒"被夹成 1 秒）

| | |
|---|---|
| 位置 | `src/models/prompter.js:424`：`timeoutMs = Math.max(1000, Math.min(LLM_MAX_CALL_MS, deadline - Date.now()))` |
| 触发输入 | `opts.deadline` 已过（动作刚好在超时/停止边缘），紧随其后的一次 `promptConvoResult` |
| 错误结果 | `deadline-now` 为负 → 被 `Math.max(1000, …)` 抬成 1000ms ⇒ **照样发请求**，白花一次调用；若该路径的 `signal` 恰好为空（见 A1），还能完整拿到一条"过期回答"并写进 history。语义上"已超期"应当**立即返回 CANCELLED/TIMEOUT**，而不是"给 1 秒碰运气"。 |
| 最小修法 | 保留夹取但先短路：`const left = deadline ? deadline - Date.now() : null; if (left !== null && left <= 0) return 立即 CANCELLED;` |

### A9 · 两个适配器写死 120s，忽略调用方给的单次期限（19 个里唯一 2 个）

| | |
|---|---|
| 位置 | `src/models/huggingface.js:50`、`src/models/replicate.js:60`：`callDeadlineSignal(LLM_MAX_CALL_MS, …)` |
| 触发输入 | 动作只剩 5 秒（`_callOptions` 算出 `timeoutMs=5000`），profile 用 huggingface 或 replicate |
| 错误结果 | 其余 17 个适配器走 `sdkCallOptions(opts)` / `fetchWithDeadline({timeoutMs: opts.timeoutMs})`，遵守"模型请求剩余时间 ≤ 动作剩余时间"（prompter.js:411-414 的单一时钟约定）；这两个仍可占满 120 秒 ⇒ 玩家按停后（abort 生效前）最长 120s 无响应，且与"每个适配器都显式写死同一档"的注释承诺不一致。 |
| 最小修法 | `callDeadlineSignal(Number(opts?.timeoutMs) > 0 ? opts.timeoutMs : LLM_MAX_CALL_MS, …)`（两处同改）。 |

### A10 · 多行文本的斜杠安检：算出来的 offending 行被丢弃，判据只看整串的第一个词

| | |
|---|---|
| 位置 | `src/agent/permissions.js:462-469`（`inspectChatText`）：`offending` 数组算完只用于 `if (!offending.length)`，随后 `isSlashAllowed(text)` 把**整串**传进 `slashCommandName()`（`:400-405`，只取第一个空白分隔词） |
| 触发输入 | 文本 = `"/skin clear\n/op 某人"`（皮肤路径来自 profile，可含换行；或任何拼出多行的调用方） |
| 错误结果 | `slashCommandName("/skin clear\n/op 某人")` → `skin` → 白名单命中、非作弊、`level=OWNER` ⇒ `allowed:true, reason:'slash-whitelisted'`，**第二行的 `/op` 完全没被检查**。<br>`openChat`（`agent.js:959→967`）因为先安检后把 `\n` 折成空格而侥幸安全（第二行变成第一条命令的参数）；但 `sendSlashCommand`（`agent.js:993-1001`）**不做折行**，直接 `bot.chat(text)` —— 换行在 Minecraft 里等于连发多条命令（这行代码上方的注释自己也这么说）。 |
| 最小修法 | 逐行判：`const ok = lines.filter(l => /^\s*\//.test(l)).every(l => isSlashAllowed(l));`；并在 `sendSlashCommand` 拒绝含 `\n`/`\r` 的文本（或先折成空格再 send）。 |

### A11 · coder 模板读取失败在 fs 回调里 throw ⇒ 未捕获异常直接带走进程

| | |
|---|---|
| 位置 | `src/agent/coder.js:43-50`：`readFile(path, 'utf8', (err, data) => { if (err) throw err; … })` |
| 触发输入 | `bots/execTemplate.js` 或 `bots/lintTemplate.js` 缺失/不可读（新装、误删、部署漏文件） |
| 错误结果 | 回调里的 `throw` 不在任何 try 里 ⇒ **uncaught exception** ⇒ 进程退出。表现是"bot 起来几秒就没了"，而不是"代码动作不可用"。 |
| 最小修法 | 换 `readFileSync` + try/catch，把错误存到 `this.templateError`，`generateCode()` 入口发现后直接返回明确的失败串。 |

### A12 · coder：语法错误不重试（`_stageCode`/`_lintCode` 在 try 之外）

| | |
|---|---|
| 位置 | `src/agent/coder.js:140-148`（`_stageCode` / `_lintCode`），只有 `:154` 的执行块被 try 包住 |
| 触发输入 | 模型生成的代码有语法错（很常见）→ `compartment.evaluate(src)`（`coder.js:270`）抛 `SyntaxError` |
| 错误结果 | 异常直接冒出 `generateCode`，`MAX_ATTEMPTS=5` 的重试预算**一次都没用上**；上层（`executeCommand` → `handleMessage`）只把它记成一次异常。用户看到的是"她这次没动"，而不是"代码写错了、我重写了"。 |
| 最小修法 | 把 140-148 包进 try/catch，`catch` 里把错误文本塞回 `messages` 走 `continue`（与 143-148 的 lint 分支同形）。 |

### A13 · 权限表登记了 3 条根本没有实现的命令，另 1 条重复登记

| | |
|---|---|
| 位置 | `src/agent/permissions.js:125-127` |
| 触发输入 | 信任级玩家（或模型按命令文档）调用 `!pauseJob` / `!resumeJob` / `!addSharedJob` |
| 错误结果 | 只读脚本核对：`commands/*.js` 里以 `name:` 注册的命令共 **65** 条，`TRUSTED_COMMANDS` 里这 3 条**全仓 0 实现**（`grep` 也只在 permissions.js 出现）。`agent.js:700-702` 的 `commandExists` 为假 ⇒ 回一句 `Command '!pauseJob' does not exist.`，白烧一轮模型调用。同数组里 `!cancelJob` **出现两次**（`:125`、`:126`），是复制粘贴残留。<br>现有自检 `unclassifiedCommands()`（`:478`）只查反方向（"实现了但没登记"），查不出"登记了但没实现"。 |
| 最小修法 | 实现它们，或从 `TRUSTED_COMMANDS` 删除；把"登记 ⊆ 实现"加进 preflight（用 `name:` 扫描集合做差集）。顺手去掉重复项。 |

### A14 · 任务单定级：接口零调用 + 一旦接上会绕过身份绑定（与聊天路径不一致）

| | |
|---|---|
| 位置 | `src/agent/permissions.js:288-313`（`maxJobLevel` / `levelForJobSource`） |
| 触发输入 | 任务板调度器要按 `job.source` 决定"这张单能干什么"（06 §5 / 08 §5：信任级最多下 6 级） |
| 错误结果 | ① 只读检索：`levelForJobSource` / `maxJobLevel` 在 `board_scheduler.js`、`board_client.js`、`executor.js`、`control.js` **零调用** ⇒ "任务单最高级"这条规则**从未被执行**。<br>② 即使接上也是错的：它调 `resolveLevel({ author, permissions })` **不传 `uuid` / `identity`**；而命令路径（`commands/index.js:474-483`）传了 `identityContextOf(agent)` + `playerUuidOf(...)`。差别正好落在 `resolveLevel` 第 4 步（`identity.enabled && !legacyNames ⇒ OTHER`）⇒ **开了身份绑定时，聊天命令按 uuid 判、任务单却按名字判**，一条玩家下的单可以拿回"按名字"的等级。 |
| 最小修法 | 调用处透传 `identity`/`uuid`（把 `identityContextOf` + `playerUuidOf` 抽成共享函数），并在调度器 `_runJob` 前真正用 `maxJobLevel(level)` 卡一道。 |

### A15 · 缺少同伙 bot 时直接 `killAll()` 关掉整个 mindserver（与"单个 agent 不许拖垮整机"冲突）

| | |
|---|---|
| 位置 | `src/agent/tasks/tasks.js:539-545` 与 `:620-626`（两处同样的 `// TODO wait for other bots to join` + 固定 `setTimeout 10000`） |
| 触发输入 | `settings.task.agent_count > 1` 的多机任务，某个 bot 晚到 11 秒（Paper 重启/玩家手动开） |
| 错误结果 | `available_agents.length < agent_count` ⇒ `this.agent.killAll()` ⇒ `mindserver_proxy.js:394-396` `socket.emit('shutdown')` ⇒ **整套服务退出**：其它 bot、面板、任务板数据库一起没（这正是 `agent_process.js:47-55` 刚修好的"一个零件坏了把整机拉闸"）。而且 `TODO` 说明"等其它 bot 进来"这件事根本没实现——固定 10 秒 sleep 就是全部逻辑，早到/晚到都判错。 |
| 最小修法 | ① 改成轮询等待（每 500ms 查一次，上限 60s，见到人就继续）；② 超时后调 `cleanKill(msg, 4)`（只摘自己），不要 `killAll()`。 |

---

## P3

### A16 · `truncate()` 的两个上限只生效一个

**位置** `src/agent/library/contract.js:206-221`。
**触发** 输出 100 行 × 每行 5000 字符。
**结果** `tooManyLines` 为真 ⇒ 走行裁剪；`tooManyChars` 分支被 `if (tooManyLines) … return` 完全短路 ⇒ 返回 50 行 × 5000 = **25 万字符**，正是它开头要防的 `229,629 字符回灌` 场景的变体（模型看到的是被"省略 N 行"标记伪装过的巨量正文）。
**修法** 行裁剪后再跑一次字符裁剪（两级都过），或按"行裁剪后若仍超 maxChars 再 slice"。

### A17 · `normalizeTarget` 接受 NaN 坐标

**位置** `src/agent/library/contract.js:178-196`（`floor3` / `floorXZ` 只有 `Math.floor`，无 `Number.isFinite` 校验）。
**触发** `{ kind:'point', pos:{} }` 或 `{ kind:'block', pos:{x:'a',y:2,z:3} }`。
**结果** 返回 `{x:NaN,y:NaN,z:NaN}` 且 `normalizeTarget` 判为合法 ⇒ 下游 `path_3d`/`goTo` 拿 NaN 算路，报 `NO_START`/`NO_PATH`（"她悬空/算不出路"），而不是明确"目标非法"。
**修法** `floor3/floorXZ` 里逐分量 `Number.isFinite`，任一非法返回 `null`。

### A18 · `last_convo_truncated` / `last_convo_error_code` 只置位、永不复位

**位置** `src/models/prompter.js:433-440`。
**触发** 第一次回答被截断（之后每一轮都正常）。
**结果** `if (r.truncated) this.last_convo_truncated = true;` 只写不清，`if (r.failed) … = code` 同；成功一轮不重置 ⇒ `logTotals()` 从第一次截断起**永远**报 `lastConvoTruncated=true`、`lastConvoErrorCode=<旧码>`。这正是它要消灭的"死标志"病，只是从"没人读"变成"读了但值是陈的"（成本/质量对账因此失真）。
**修法** 每次进 `_convoResult` 先全量赋值：`this.last_convo_truncated = r.truncated; this.last_convo_error_code = r.failed ? (r.errorCode ?? null) : null;`。

### A19 · `history.capSize` 每轮保存都做 O(n²) 全量序列化

**位置** `src/agent/history.js:367-381`（`while (turns.length > MIN_TURNS && byteLen({...out, turns}) > LIMIT) turns.shift();`，以及 371-379 的双层循环）。
**触发** 每条消息 / 每条命令后的 `history.save()`（`agent.js:747, 886`）。
**结果** 每丢一条就重新 `JSON.stringify` 整个 20KB 结构；turns≈60 时一轮 save 约 60–120 次全量序列化，且全程**同步**（占住事件循环，与心跳/网络同线程——直接拖慢 `update()` 与消息响应）。
**修法** 先算一次总字节，按"超出量 ÷ 平均条字节"一次算出该丢几条（或累加前缀字节），不要逐条重算。

### A20 · `routeResponse` 又用"名字"判内部来源（BOT-001 同一模式残留）

**位置** `src/agent/agent.js:926`：`let self_prompt = to_player === 'system' || to_player === this.name;`。
**触发** 玩家把游戏名起成 `system`（或与 bot 同名）。
**结果** 他的消息回复被当成"内部触发"⇒ 若 `last_sender` 存在就**改投给另一个玩家**，而不是回给说话的人（BOT-001 已经把权限侧的同类判据全部换成显式 `internal` 标记，这里漏了）。
**修法** `handleMessage` 已知 `is_internal`，把"路由目标"随调用显式传下来，别在 `routeResponse` 里重新按名字猜。

---

## 已核实为"非缺陷"（避免重复排查）

- **载具 4 个错误码零产出 —— 属实且已被代码显式记录，不是漏接**。
  只读脚本对 `contract.js` 的 41 个 CODES 做了全仓产出统计（排除 contract.js 自身）：零产出的**只有** `NO_VEHICLE` / `RIDE_FAILED` / `NOT_MOUNTED` / `DRIVE_FAILED`，与 `contract.js:31-39` 的注释完全一致（"boat 已删、动作层 mount/dismount 还没建，保留不删"）。同段 `NO_PERMISSION` 有 3 处真实产出（`atom_input_misc.js`），`HEARTBEAT_SKIPPED`(2)、`NO_JOB`(1)、`PREEMPTED`(3) 均有产出。**结论：无需新增或删除错误码**，建议在总报告里作为"已知设计"列一条即可。
- **全程记录的 O(n²) 写盘已修**（`history.js:204-240` 改为尾部 append，单批成本与文件大小无关）。
- **`_appendJsonArray` / `capSize` 的边界**（空文件、`[]` 空数组、末尾无 `]`）已按 `FULL_HISTORY_CORRUPT` 分支处理，未发现新缺陷。

---

## 未覆盖 / 残余风险（诚实边界）

1. `src/agent/library/` 里 4 个大文件只做了定点抽查，**没有逐行读完**：`skills.js`(6146 行)、`board_store.js`(2219)、`executor.js`(1172)、`board_scheduler.js`(1151)。这 4 个文件里"长任务列表只增不减 / O(n²) / 中断不生效"仍可能有同类缺陷。
2. `src/sim/`（`vine_physics.js`、`position_guard.js`、`position_throttle.js`）只读了签名与调用关系，未做边界推演。
3. `src/agent/tasks/`（`construction_tasks.js` 1113 行、`cooking_tasks.js` 等）只核了 `tasks.js` 的多机等待路径。
4. 本轮**没有运行仓库自带的离线单测**（`tools/*_unit.mjs`）：执行会触碰 `bots/` 落盘与 `tmp/`，与"不改任何产品代码/不产生运行痕迹"的边界容易混淆。所有结论均来自静态读码 + 只读脚本，每条已给出可直接复核的 `文件:行`。
5. 本轮明确**未覆盖** `src/mindcraft/`、`src/infra/`、`src/utils/`（不在本任务范围）。

## 建议的修复顺序（供修复阶段参考）

1. **A1 / A2**（各 1–3 行，收益最大：取消真的能到模型、失败可诊断）
2. **A4 / A5 / A6**（进程存活与自愈：落盘失败不再崩、坏存档不再永久下线、setup 失败会重启）
3. **A3 / A13 / A14**（权限语义一致性：日志不再骗人、命令表与实现对齐、任务单定级不绕过绑定）
4. **A7 / A15**（退出路径与"一个 bot 不拖垮整机"）
5. 其余 P2/P3 可批量处理（A8–A12、A16–A20）。
