# R6 运行时清零 —— agent 运行时与模型层（t3 / fix-agent）

> 任务：t3 · 负责人：fix-agent · 批次：R6 第二轮修复（fixes2）
> 范围：`mindcraft/src/agent/**`、`mindcraft/src/models/**` + 追加的 `mindcraft/src/process/**`（#36）
> 清单：#35 · #36（captain 追加）· #37 · #38 · #39 · #40 · #41 · #42 · #43
> + **ADR-0001 §10.2 第 3 条**（任务**进行中**缺同伙仍 `killAll()`）
> + 落在这些文件里的 Nice：#78（A18）· #79（A19）· #80（A20）

| 编号 | 一句话结论 | 主要落点 |
|---|---|---|
| #35 | 启动日志说"人人信任级"，实现是 fail-closed"所有命令都不响应" | `agent.js` 启动自检段 |
| #36 | 退出路径 `await board.*` 无超时 ⇒ gracefulStop 永不返回（僵尸 bot） | `process/init_agent.js` `waitBounded()` |
| #37 | 已过期操作仍发一次模型请求（剩 0s 被夹成 1s） | `models/prompter.js` `_callOptions()` + 5 个出口 |
| #38 | huggingface / replicate 写死 120s 忽略调用方期限 | `models/huggingface.js`、`models/replicate.js` |
| #39 | 多行斜杠安检只看整串第一个词 ⇒ `/skin\n/op` 绕过 | `permissions.js` `inspectChatText()`、`agent.js` `sendSlashCommand()` |
| #40 | coder 模板读取失败在 fs 回调里 `throw` ⇒ 进程退出 | `coder.js` 构造 + `generateCode()` 入口 |
| #41 | coder 语法错误不重试（`_stageCode`/`_lintCode` 在 try 外） | `coder.js` |
| #42 | 权限表登记 3 条零实现命令 + 1 条重复登记 | `permissions.js` 表 + `registeredButMissing()` |
| #43 | 任务单定级接口零调用 + 一旦接上会绕身份 | `permissions.js`（**接口加固，未接线**，见 §3） |
| §10.2-3 | 进行中缺同伙 → `isDone` → `checkTaskDone` → `killAll` 关整机 | `tasks/task_end_policy.js`（新）+ `tasks.js` + `agent.js` |
| #78 | `last_convo_truncated` / `last_convo_error_code` 只置位不复位 | `prompter.js` `_convoResult()` |
| #79 | `history.capSize` 每丢一条就全量序列化（O(n²)，同步） | `history.js` `capSize()` |
| #80 | `routeResponse` 又按名字判内部来源 ⇒ 回复改投别人 | `agent.js` `routeResponse()` + 7 个调用点 |

---

# 1 · ADR §10.2-3（本批最重的一条）

## 病根

`tasks.js:isDone()` 在**任务进行中**发现同伙不齐时，返回的其实是一个"正常的结束结果"：

```js
if (elapsedTime >= 30 && this.available_agents.length !== this.data.agent_count) {
    return { message: 'No other agents found', score: 0 };   // ← 看起来和"跑完"一样
}
```

而 `agent.checkTaskDone()` 只看返回值真假：

```js
if (res) { …; this.killAll(); }     // killAll → serverProxy.shutdown() → socket.emit('shutdown')
```

⇒ **一只 bot 的同伙掉线/晚到，就能把整套服务关掉**（其它 bot、面板、任务板数据库一起没）。
一期（#17）只堵了**开工阶段**（`initBotTask`/`teleportBots` 里的两处固定 10s sleep + killAll），
进行中这条更长的路径一直留着；且当时 `runtime_survival_unit` 的断言是"`tasks.js` 里没有 killAll"——
而真正调 `killAll` 的是 `agent.js`，所以那条断言**绿着**，缺陷仍在。

## 修法（三层，判定与副作用都集中到一个零依赖文件）

新增 `mindcraft/src/agent/tasks/task_end_policy.js`（**零依赖** ⇒ 离线用例可直接 import）：

| 导出 | 作用 |
|---|---|
| `TASK_END` | 结束理由：`success` / `teammates_missing` / `timeout` |
| `decideTaskEnd(result)` | 纯判定 → `continue` / `shutdown_all` / `detach_self` |
| `applyTaskEnd(agent, result)` | **唯一**允许碰 `killAll`/`cleanKill` 的地方 |
| `teammateState({now, elapsedSec, present, required, missingSince, graceMs})` | 进行中"够不够人"的三态：`present` / `waiting` / `missing` |

规则（**失败一律局部**）：

- `null/false` → `continue`；
- `endReason === 'success'` → `shutdown_all`（**只有"任务成功"才关整机**，既有正常路径保住）；
- `teammates_missing` / `timeout` / 任何没标清的失败 → `detach_self`
  ⇒ `cleanKill(msg, 4)`（退出码 > 1 ⇒ `planExit()` 走 unregister：**只摘掉这一个 agent**）。

配套改动：

1. `tasks.js:isDone()` 三个出口都带 `endReason`；缺人场景不再"一发现就判死"，
   而是交给 `teammateState()`：第一次发现不齐 → `waiting`（记 `teammatesMissingSince`，
   **继续跑、继续数人**）；宽限（默认 60s，`MC_TASK_TEAMMATE_GRACE_MS` 可覆盖）用完仍是 `missing`
   才判失败；人齐了计时清零（晚到/中途掉线再回来都不累积误判）。顺带把原来的 `!==` 改成"够不够"
   （**人多也算齐**，原来多来一只就误判不齐）。时钟可注入（`this._now`）⇒ 用例毫秒级跑完。
2. `agent.js:checkTaskDone()` 不再自己 `killAll()`，改为 `applyTaskEnd(this, res, {onAction})`。

## 硬回归（先红后绿，两次都贴）

用例：`mindcraft/tools/r6_task_end_unit.mjs`（25 条，`tools/*_unit.mjs` 自动纳入 `unit_all`）。
关键断言：`applyTaskEnd(fakeAgent, 缺同伙结果)` ⇒ **`killAll` 0 次**、`cleanKill(msg,4)` 1 次；
成功仍 `killAll` 1 次；`checkTaskDone` 方法体里**没有** `.killAll(`。

**证明用例会红**：把 `checkTaskDone` 里那一行改回 `this.killAll();`（其余不动）：

```
$ node tools/r6_task_end_unit.mjs
FAIL ★ ⑤ checkTaskDone 里不再有 `.killAll(`（收场交给 applyTaskEnd）
FAIL ⑤ checkTaskDone 调用 applyTaskEnd（单一判据入口）
23 passed, 2 FAILED          ← exit=1
```

**修回后**：

```
$ node tools/r6_task_end_unit.mjs
ALL PASS: 25 passed          ← exit=0
```

> 过程中还抓到自己一个**假绿**：最初方法体边界用 `code.indexOf('killAll()')` 截断，
> 而该方法体里恰好有 `this.killAll();` ⇒ 断言永远看不见它。已改成按方法定义
> `\n    killAll() {` 取边界。上面那次"红"就是改完之后跑出来的。

---

# 2 · 逐条

## #35 启动日志 vs 真实权限语义

- **病根**：`agent.js` 启动自检自己抄了一份口径 ——「未配置 owner ⇒ 人人**信任级**，可用 聊天/走/跟/…」；
  而 `resolveLevel` 早已是 F-AI-201 fail-closed：没 owner ⇒ `OTHER` ⇒ `canRunCommand` 全 false
  ⇒ **所有玩家聊天命令都不响应**。照日志排障 ⇒ 结论完全相反。
- **修法**：这段**不再自述规则**，直接拿样本命令问权限模块再打印
  （`resolveLevel({author: probe, permissions})` → `canRunCommand(level, c)`），
  打印"实测等级 / 判定可用 / 判定拒绝 + 各自门槛"，并注明"开了身份绑定后真实等级按 uuid 算"。
  文案与实现漂移时，**日志会先红**。

## #36 退出路径的有界等待（captain 追加，位置在 `src/process/**`）

- **病根**：`gracefulStop()` 里 `await board.update(...)` / `await board.release(...)` 无超时。
  board socket 半死（连接在、ack 不回）⇒ gracefulStop 永不返回 ⇒ 包装后的
  `agent.cleanKill()` 永不执行 `process.exit` ⇒ **僵尸 bot 谁也停不下来**（面板"停止"也无效）。
- **修法**：新增 `waitBounded(label, fn)`（500ms 上限，`Promise.race` + `unref` 定时器），
  两处 RPC 都改走它；超时**留痕**（`console.error` 写明"超过 Nms 无 ack ⇒ 不再等它，
  这张单/预约可能留到租约过期回收"），然后**继续走完退出**。不是静默忽略。

## #37 已过期操作仍发请求

- `_callOptions()` 先算 `expired = deadline != null && deadline - now <= 0`（**先判后夹**），
  5 个出口（convo / coding / memSaving / shouldRespondToBot / vision）在同一位置短路：
  直接返回 `status=TIMEOUT` 的 `ModelResult`，**一次请求都不发**。
- 行为用例：假 `chat_model` 计 `sendRequest` 次数 ⇒ `sent===0 && r.status==='timeout'`。

## #38 两个适配器写死 120s

- `huggingface.js` / `replicate.js`：`const dlMs = Number(opts?.timeoutMs) > 0 ? Number(opts.timeoutMs) : LLM_MAX_CALL_MS;`
  日志里也打实际 `dlMs`（不再谎报 120s）。

## #39 多行斜杠安检

- `inspectChatText()` 改为**逐行**：以 `/` 开头的每一行各自过白名单，任何一行不过就整体拒绝，
  并把**行号 + offending 原文**带回去（原来算出来的行被丢弃、判据只看整串第一个词）。
  返回形状新增 `line` / `offending`，`reason` 变 `slash-blocked@line N`。
- 第二道：`agent.js:sendSlashCommand()` 直接**拒绝含 `\r`/`\n` 的文本**（换行在 MC 里 = 连发多条命令）。

## #40 / #41 coder

- #40：模板读取改 `readFileSync` + try/catch，失败记 `this.templateError` 并 `console.error`；
  `generateCode()` 开头发现模板坏 ⇒ 返回 `Code action unavailable: …`（进程不再被回调里的 throw 带走）。
- #41：`_stageCode` / `_lintCode` 各自包 try/catch，失败把错误文本塞回 `messages` 再 `continue`
  ⇒ `MAX_ATTEMPTS=5` 的重试预算终于用得上（原来语法错一次就把异常冒出 `generateCode`）。

## #42 权限表登记了没实现的命令

- **选择"从表里移除"**（不是实现）：`!pauseJob` / `!resumeJob` / `!addSharedJob` 需要任务板新增
  "暂停/恢复/共享单"的库层状态机（`board_store`/`board_client`），属任务板那一批；
  顺手删掉重复的 `!cancelJob`（原来出现两次）。
- **补反向自检**：新增 `registeredButMissing(implementedNames)`（原 `unclassifiedCommands()` 只查反方向），
  用例扫描 `commands/*.js` 的 `name:`（单/双引号两种写法都认）做集合差，断言为空。
  待那三条实现落地后加回表里，自检会立刻提醒登记一致。

## #43 任务单定级（**按 captain 裁决：不接线**）

接口修好（不再绕身份），但**刻意不接到调度器**：

- `levelForJobSource(job, permissions, opts)` 现在透传 `{uuid, identity}` 给 `resolveLevel`
  ——与聊天路径同一套判据；并新增 `jobAuthorOf(job)` 统一解析 `'player'`+`sourceName`
  与 `!addJob` 实际写的 `'player:<名字>'`（原来后者落进默认分支被当信任级）。
- 新增 `jobPermissionGate(job, permissions, opts)`：`job.level`（0–9，缺省 0）≤ 下单人 `maxJobLevel(level)` 才放行。
- **接线前置条件（写进代码注释 + 本文件）**：接线方（任务板那批）必须先能拿到
  `identityContextOf(agent)` + `playerUuidOf(agent, author)`；**不许用 `{identity:null, uuid:null}` 接线**，
  那等于退回"按名字定级"，正是这条缺陷要堵的身份旁路。
- 行为用例证明加固有效：同名但拿不出已绑定 uuid ⇒ 只有 `other`（不再按名字换权限）；
  信任级下单人要 9 级 ⇒ 拒绝（上限 6）。

## #78 / #79 / #80（Nice，落在本批文件里）

- #78 `_convoResult()` 改为**全量赋值**：本轮没截断就是 `false`，本轮成功就把错误码清成 `null`
  （原来只置位不复位 ⇒ `logTotals()` 永远报第一次截断的值）。
- #79 `capSize()` 不再"每丢一条就 `JSON.stringify` 整个结构一次"：先量**一次**总量，
  按每条大致字节一次算出该丢几条，再用**有界**（各 ≤4 次）精确复核修正。
- #80 `routeResponse(to_player, message, opts)` 只认 `opts.internal === true`（7 个调用点全部显式传
  `{internal: is_internal}`）；删除 `to_player === 'system' || to_player === this.name` 这条名字判据。

---

# 3 · 验证

| 命令 | 结果 |
|---|---|
| `node tools/r6_task_end_unit.mjs` | **ALL PASS: 25**（含红→绿两次记录，见 §1） |
| `node tools/r6_agent_runtime_unit.mjs` | **ALL PASS: 39** |
| `npm run gate` | **exit 0**（含 `lint:hard` no-undef=0 / no-floating-promise=0） |
| `node tools/unit_all.mjs` | **138/139 通过，5 跳过**；唯一失败 `web_dist_manifest_unit` = **web/ 源码指纹漂移**，见下 §4 |

`npm run gate` 尾部实测：

```
启动自检通过（含函数体冒烟测试）。
  ✓ [lint:hard] no-undef = 0 · no-floating-promise = 0（扫 180 个文件）
```

## §4 诚实边界 / 不在本批

1. **`web_dist_manifest_unit` 失败不是本批引入**：报错是
   「产物绑定的源码指纹与当前 `web/src` 不一致（清单=sha256:f60449… 当前=sha256:da51c6…）」——
   `web/` 不在我的写作用域（本队 web 那条工作流改了源码但没重建产物）。
   修法固定：`cd web && npm ci && npm run build && node ../mindcraft/tools/sync_web_dist.mjs`。
2. **#43 未接线**（见 §2），且刻意如此：没有 `identity`/`uuid` 就接线＝身份旁路。
   本批只交付"接口正确 + 用例证明不绕身份 + 文档写明前置条件"。
3. **Nice #76 / #77（A16 / A17）没做**：它们在 `src/agent/library/contract.js`
   （`truncate()` 双上限、`normalizeTarget` NaN），不在本任务列出的文件清单里，留给对应工作流。
4. `npm run lint`（eslint）**全仓本就有历史欠账**（如 `src/agent/speak.js` 的 `no-empty`），
   与 `npm run gate` 的 `lint:hard` 是两套口径；本批新增代码未引入新的 no-undef / no-floating-promise。
5. 本轮**未做真机验证**：§10.2-3 的"缺同伙"用注入时钟 + 假 agent 钉住，属单测级别；
   真机需要"多 bot 任务里手动踢掉一只"的场景（见 ADR §10.3 的清单）。

---

# t2 移交残留（t9 / fix-agent）

来源：fix-board2 在 t2 收口时列的残留，captain 逐条实核。两条都在 `src/agent/library/`。

## 残留 3 · 三个 flow 的非法 claim 占位（已删除）

| 文件 | 原占位 | 为什么非法 | 处置 |
|---|---|---|---|
| `flow_fight.js:45` | `claims: ['entity:target']` | `target` 是参数名，不是实体 id | 删除 |
| `flow_shelter.js:35` | `claims: ['area:<自己周围>']` | 占位文本，不是坐标/区域 | 删除 |
| `flow_smelt.js:44` | `claims: ['station:furnace']` | 缺坐标，合法形状是 `station:furnace@x,y,z` | 删除 |

**没有改成猜测值**（按 captain 口径）：这些 key 里的坐标/实体 id 只有运行时才知道。
也没有丢失预约能力 —— `deriveClaims()` 会从 `job.args` 推导：

```
fight  manifest.claims= undefined  deriveClaims= ["entity:zombie"]  parse=[true]
shelter manifest.claims= undefined deriveClaims= []                 parse=[]
smelt  manifest.claims= undefined  deriveClaims= []                 parse=[]
NO_ILLEGAL_CLAIMS
```

即 `parseClaimKey()` 对这三个 flow 的产出**不再有非法项**（shelter/smelt 不再声明，
真容器/工作台预约仍由 `act_container`/`act_station` 开窗时按真实坐标补）。

## 残留 4 · `landmarks.js` 的"档案字段只增不减"本地回填（已删除）

`refreshChests()` 里原本在把板库行合进缓存时，用本地旧值把 `category` / `note` 补回来：

```js
const local = st.rows.get(e.key);
if (local) { if (!e.category) e.category = local.category ?? null; if (!e.note) e.note = local.note ?? ''; }
```

§10.2-1 之后 `mergeSharedChest` **以板库现值为基底**，不再抹掉这两个字段 ⇒ 这段是冗余兜底，
删掉（含只服务它的 3 行注释）。`refreshChests` / `st.rows` / `st.dirty` 等真正的读路径**全部保留**
（`st.rows` 仍被 184-187 的 dirty 视图、`resolve`、`upsert` 等多处使用）。

依赖核查：全仓 grep `entity:target` / `area:<自己周围>` / `station:furnace'` 只剩本次注释；
`tools/` 下没有用例断言这三条 claim；`landmarks` 相关用例（`board_b4_unit`、`atom_classify_unit`、
`skills_fakesuccess_unit`）全绿。

## 验证

| 命令 | 结果 |
|---|---|
| `node tools/board_b3_unit.mjs` | exit 0 |
| `node tools/board_b4_unit.mjs` | exit 0（11/11 用例） |
| `node tools/flow_shelter_unit.mjs` + `flow_build_support_unit` / `flow_mine_*` / `flow_p0` / `flow_p1` | 全 exit 0 |
| `node tools/shared_chest_merge_unit.mjs` | exit 0（13/13 用例） |
| `node tools/r6_agent_runtime_unit.mjs` | ALL PASS: 39 |
| `node tools/unit_all.mjs` | **142/142 通过，5 跳过**（web_dist 漂移已由 web 侧重建修好） |
| `npm run gate` | exit 0（lint:hard no-undef=0 / no-floating-promise=0） |
