# 控制面回执协议（fixes3 / protocol）

本文件记录本轮"控制事件补 ack + relay 解耦 + 输出补拉"的**协议契约**。代码里只留 1–2 行
「为什么」的注释，细节都在这里。

改动文件：

- 服务端：`mindcraft/src/mindcraft/mindserver.js`
- 前端：`web/src/api/socket.ts`、`web/src/api/humanize.ts`、`web/src/stores/agents.ts`、
  `web/src/views/SetupView.vue`、`web/src/views/DebugView.vue`、
  `web/src/components/IdentityPanel.vue`、`web/src/components/ChatStream.vue`、
  `web/src/components/QuickCommands.vue`
- 测试/审计脚本（断言升级，见 §7）：`mindcraft/tools/control_plane_guard_unit.mjs`、
  `web/scripts/offline-audit-web001.mjs`
- 生成产物（仓库门禁要求，见 §8）：`mindcraft/web-dist/**`、`mindcraft/web-dist/MANIFEST.json`

---

## 1. 为什么要有回执

旧实现：前端 `emitControl()` 直接 `socket.emit(event, ...args)` 后返回 `{ok:true}`；服务端五个
控制事件的 handler 签名里也没有 callback。于是面板只能表达"我从浏览器发出去了"，**永远不知道
服务端到底执行了没有** —— 未知 agent、目标不在游戏里、被限流、只有面板能操作，全都表现成
"成功"。

现在：前端 `emitControl()` 返回 `Promise<ControlResult>`（8 秒超时），服务端**每条分支**都回执。

## 2. 回执形状

```js
// 成功
{ ok: true }                       // 可带必要字段：{ ok:true, started:true } / { ok:true, destroyed:true }
// 失败
{ ok: false, code: '<CODE>', message: '<人话>' }   // 限流另带 retryAfterMs
```

服务端统一用 `ackFn(callback)` 生成回执函数（`mindserver.js`，与 `create-agent` 的 `ack` 同口径）：
**客户端没传 callback 时静默返回、绝不抛**（裸 `callback(...)` 会抛 TypeError，而 handler 是
async ⇒ Node 22 未处理拒绝 ⇒ 整个控制面退出）。`requirePanel(event, ack)` 的第二个参数五个事件
全部补上了，所以"只有面板能操作"也会回 `control-denied` + ack 双份。

## 3. 每个事件的回执表

| 事件 | 签名 | 成功回执 | 失败分支 → code |
| --- | --- | --- | --- |
| `restart-agent` | `(agentName, callback)` | `{ok:true}` | 限流 `RATE_LIMITED`；非面板 `PANEL_ONLY`；未知名 `UNKNOWN_AGENT`；`socket` 为 null `NOT_RUNNING` |
| `stop-agent` | `(agentName, callback)` | `{ok:true}` | `RATE_LIMITED` / `PANEL_ONLY` / `UNKNOWN_AGENT`（停一只已停的 agent 不算失败：`stopAgent` 幂等） |
| `start-agent` | `async (agentName, callback)` | `{ok:true, started:true}` | `RATE_LIMITED` / `PANEL_ONLY`；`r.started===false` 时 `ALREADY_RUNNING`（`r.reason==='not-found'` 例外，回 `UNKNOWN_AGENT`，更准确） |
| `destroy-agent` | `async (agentName, callback)` | `{ok:true, destroyed:true}` | `RATE_LIMITED` / `PANEL_ONLY` / `UNKNOWN_AGENT`；`destroyAgent` 未确认退出 `NOT_RUNNING`（注册项保留） |
| `send-message` | `(agentName, data, callback)` | `{ok:true}` | `UNKNOWN_AGENT`；`RATE_LIMITED`（30 条/10s）；载荷非法 `BAD_REQUEST`；**目标 `socket` 为 null → `NOT_IN_GAME`**；转发抛错 `NOT_IN_GAME` |
| `listen-to-agents` | `(callback)` | `{ok:true}`（已订阅也算成功，幂等） | `PANEL_ONLY`；`RATE_LIMITED` + `retryAfterMs` |
| `get-output` | `(payload, callback)` | `{ok:true, entries:[{seq,line}], latest} ` | `UNKNOWN_AGENT`；`RATE_LIMITED`（60 次/60s） |

### 码的含义

- `RATE_LIMITED` 令牌桶拒绝（按 `label@主体@来源地址` 分桶）。
- `PANEL_ONLY` 该连接不是面板角色（`requirePanel` 拒绝；同时会发 `control-denied`）。
- `UNKNOWN_AGENT` 名字不是已注册 agent（过 `knownAgent()`，原型链键不再当名字）。
- `NOT_RUNNING` agent 已注册但没有可用的进程/通道（停着的、或销毁未确认退出）。
- `NOT_IN_GAME` 通道存在但 bot 不在游戏里（`socket === null`）。**这是 S-3 的正解**：原来直接
  `agent_connections[sendTo].socket.emit(...)` 抛 TypeError，被外层 `catch` 吞成一行 `console.error`。
- `ALREADY_RUNNING` `startAgent` 返回 `started === false`（仍在跑 / 旧进程未确认退出）。
- `BAD_REQUEST` **超出任务书列的五码**：形状非法（`message` > 2000 字符、`from` 不是 1–32 字符
  字符串）不属于"状态失败"，用五码会误导；前端会显示服务端 `message`，不会漏反馈。

`listen-to-agents` 被限流时的 `retryAfterMs` 是**估算值**：`takeToken` 只返回布尔、拿不到剩余
令牌数，所以按窗口/容量推 `60000/10 = 6000ms`（一个令牌的回填时间）。任务书允许估一个值。

## 4. relay 解耦（前后对比）

- **前**：`registerMapRelay(socket)` 唯一调用链是 `addListener ← listen-to-agents`。想拿地图/地形/
  诊断数据，必须先订阅 1 Hz 状态推送；不订阅就 `request-map`/`request-terrain`/`get-events` 全无
  处理器（前端只能"发出去没回执"）。
- **后**：`io.on('connection')` 里紧跟 `agentsStatusUpdate(socket)` 直接 `registerMapRelay(socket)`；
  `addListener` **只**管订阅集合与轮询起停，不再注册 relay。`rylayedSockets`（WeakSet）仍保证
  每 socket 只注册一次（`socket.on` 是追加语义）。
- 因此现在任何过握手门的连接（面板或 agent 连接）都能用按需 ack 的 relay。**已知取舍**：agent
  连接此前没法订阅，所以这条读面（别的 bot 的地图/地形/诊断）对它是新增的；它是只读数据，
  风险等同"bot 已能给别的 bot 发 chat-message"，本轮未再收紧（要收紧就在 relay handler 里加
  `isPanelConnection()` 判定）。

## 5. bot-output 缓冲策略

- 每个 agent 一个环形缓冲：`BOT_OUTPUT_LIMIT = 500` 条，元素 `{seq, line}`，`seq` 从 1 自增。
- 写：`bot-output` 通过身份校验后 `pushBotOutput()`（满了 `shift()` 丢最旧）→ 再 `io.emit`。
  **只为 `knownAgent(agentName)` 建键**：否则任意 `agentName` 都能新增一个键，"缓冲有界"就形同虚设
  （每键 ≤500 条、但键可以无限多）。
- 读：`get-output {agent, since}` 返回 `entries`（`seq > since`）+ `latest`（最新 seq，空缓冲为 0）。
  `since` 缺省 = 0，即"全给（最多 500 条）"。
- 有界性是硬要求：不限长会把控制面进程吃满；面板后接上时最多补 500 行，更早的历史不保留。
- 销毁路径 `destroy-agent` 成功时 `botOutputBuffers.delete(name)`，同名重建不会读到上一世的输出。
  **未做**：agent 进程自己退出（`unregister` 路径）时不清缓冲 —— 缓冲有界，且重建同名会从 seq=1
  继续追加；若要"重建即清空"，需要把清理挂到 `destroyAgent` 的所有调用点。

## 6. 前端语义

`emitControl(event, ...args): Promise<ControlResult>`：

1. 未连接 ⇒ 立即 `{ok:false, code:'OFFLINE'}`，**不 emit**（WEB-001：否则进 sendBuffer，重连时迟到执行）；
2. 已连接 ⇒ `socket.emit(event, ...args, cb)`，8 秒无回执 ⇒ `{ok:false, code:'UNKNOWN_RESULT',
   message:'已发出但没收到回执，结果未知'}`，调用方不许当"确定失败"自动重试；
3. 回执归一化：`true` → `{ok:true}`；`{ok:true,...}` → 原样；`{ok:false,code,message}` → 补齐默认值；
   其它 ⇒ `UNKNOWN_RESULT`（回执不可识别）。

调用点全部 `await` 并按 `code` 给真实反馈（`humanizeControl()`，`web/src/api/humanize.ts`）：

- `RATE_LIMITED`→"太频繁，请稍后"、`NOT_IN_GAME`→"这只 bot 不在游戏里"、
  `PANEL_ONLY`→"只有面板能操作"、`ALREADY_RUNNING`→"已经在跑了"、
  `UNKNOWN_RESULT`→"结果未知，请刷新确认"，另补 `OFFLINE`/`UNKNOWN_AGENT`/`NOT_RUNNING`/`BAD_REQUEST`。
- `say()` 改成 `async`（`ChatStream.vue`/`QuickCommands.vue` 跟着 await / `void`）；有 ack 后不再
  伪造"2.5 秒后猜结果"的 pending 态，直接落 `sent`。
- `agentAction()` 的 `pendingActions` 从"15 秒后报结果未知"降级为 **3 秒按钮锁**（ack 已经回答了
  服务端执行没执行）；`agents-status` 回来仍会整体清空。
- `DebugView.vue` 的 `diag.memory.reason`、`SetupView.vue` 的三处 `reason` 改走 `humanize()`；
  `IdentityPanel.vue` 的本地 `humanize` 删除，改为 `import { humanize } from '../api/humanize'`
  （S-4/S-5）。

### S-1 的门 + 面板侧配套

服务端 `create-agent`：`requirePanel` → 形状校验 → **confirm 门**（`allow_insecure_coding === true`
且 `confirm !== true` ⇒ `ack({success:false, error:'CONFIG_CONFIRM_REQUIRED'})`，不 spawn、不写盘）。
`confirm` 在校验前就从 `settings` 里摘掉（它是协议标记，不是配置项，不能进 `settings_spec` 校验）。

面板必须有配套，否则勾了复选框就永远建不出来（每次都被拒）。`SetupView.vue` 的 `createAgent()`
采用与本页「停止服务 / 销毁」一致的**两次点击**：第一次只置 `confirmInsecure`（5 秒复位）并提示
"等于把本机 root 交给模型，再点一次”，第二次才把 `confirm: true` 一起发出去。
`humanize()` 里补了 `CONFIG_CONFIRM_REQUIRED` 的人话兜底（万一还是被拒，面板显示可照做的提示，
不是裸码）。

## 7. 测试断言升级（不放宽，只升级）

1. `mindcraft/tools/control_plane_guard_unit.mjs`
   - **D1b**：原来断言"`addListener` 之后 `request-map`/`request-terrain`/`get-events` 各 1 个处理器"。
     解耦后 relay 不在 `addListener` 里注册，这条断言钉的是**旧实现**。升级为三条更强的判据：
     `addListener` 函数体里**不含** `registerMapRelay`；`io.on('connection')` 里紧跟
     `agentsStatusUpdate(socket)` 调用 `registerMapRelay(socket)`；`relayedSockets.has(socket)` 的
     重复注册防护仍在。用例数不变（73）。
   - **E3**：原来用固定 1800 字符窗口切 `create-agent` 块再比位置。S-1 的 confirm 门插在形状校验
     之后，把 `for (let key in settings_spec)` 推到窗口外 ⇒ 假失败。升级为"切到该 for 循环为止"，
     断言的是**顺序**而不是字符距离，比原来更稳。用例数不变（73）。
2. `web/scripts/offline-audit-web001.mjs`（不在 npm test 里，但它是 `emitControl` 的既有审计）
   原来同步取 `r.ok`；新 API 是 Promise。升级为 `await` + 额外两条更强的断言：`emitControl`
   必须**带上 ack 回调**，服务端回执后才 resolve；服务端 `{ok:false,code}` 必须原样带回。
   现在 29/29 PASS。

## 8. 生成产物（为什么动了 `mindcraft/web-dist/`）

`web_dist_manifest_unit` 会复算 `web/src` 指纹并与 `web-dist/MANIFEST.json` 比对；改了前端源码
不重建就会红。仓库规定的重建方式是 `scripts/release.ps1`（MANIFEST 的**单一写者**，R6 #50 起
`sync_web_dist.mjs` 只同步文件、不写清单）：

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -SkipDocker   # 本机无 pwsh 7
```

因此 `mindcraft/web-dist/**` 与 `MANIFEST.json` 是本轮**构建产物**的更新，不是手改。

本轮执行了两次（第一次之后又补了面板侧的 confirm 两次点击，源码指纹变了）：

```
RELEASE_EXIT=0  → 源码指纹 sha256:0c18a1c4bea5…（32 个输入文件），产物与源码指纹一致
```

`web_dist_manifest_unit` 现在 `ALL PASS: 10 passed, 0 failed`。

## 9. 验证（真实执行结果）

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `cd mindcraft && node --check src/mindcraft/mindserver.js` | 通过（无输出） |
| 2 | `node tools/mindserver_gate_unit.mjs` | `ALL PASS: 49 passed, 0 failed` |
| 3 | `node tools/control_plane_guard_unit.mjs` | `73/73 个用例通过` |
| 4 | `node tools/control_plane_r6_unit.mjs` | `ALL PASS: 53 passed, 0 failed` |
| 5 | `cd web && npx vue-tsc --noEmit` | 退出码 0，无输出 |
| 6 | `cd mindcraft && npm run gate` | 退出码 0；`✓ 错误码审计通过（扫到 35 个码，均已注册）`、`启动自检通过（含函数体冒烟测试）` |
| 7 | `cd mindcraft && npm test` | `141/142 个脚本通过，5 个跳过`（退出码 1）—— 唯一失败 `exec_landing_unit` 见下 |
| + | `cd web && node scripts/offline-audit-web001.mjs` | `ALL PASS: 29 passed, 0 failed` |
| + | `node tools/web_dist_manifest_unit.mjs` | `ALL PASS: 10 passed, 0 failed` |

### 第 7 条的唯一失败与归因

`exec_landing_unit` 用例 6（"库打不开 → 发 landing-check-error 且照走"）失败，**与本轮改动无关**：

- 该用例给一个不存在的 `mapDir`，期望 `columnSurfaces()` 抛错从而发 `landing-check-error`；
- 但工作区里 `src/agent/library/terrain3d.js` 有**另一位同事正在改**的 `openDb3d()`
  （`git diff` 可见新增 `mkdirSync(baseDir, { recursive: true })`），"目录不存在"不再抛错；
- 已实测复现：直接 `columnSurfaces('<不存在目录>', [{x:0,z:0}])` → **不抛错**，返回 `[]`。
  于是该用例的 `landing-check-error` 永远不会发生；
- `terrain3d.js` 与 `src/agent/**` 按任务约束**禁止我修改**，所以这条留给 owner 处理
  （要么让 `openDb3d` 对"显式指定的坏路径"仍抛错，要么把该用例改成"自建目录后照走"）。

## 10. 错误码登记的处置（`preflight` 的 §3）

新码一开始裸写成 `{ ok:false, code:'RATE_LIMITED' }`，`preflight` 的错误码审计立刻报
"7 个错误码没注册：…"。它扫的是 **ActionResult 错误码**（必须在 `src/agent/library/contract.js`
的 `CODES` 里），而这七个是 **socket 协议码**，属于另一套词表；把协议码塞进 `CODES` 会让
`assertResult` 误认它们是结果码，而且 `src/agent/**` 是禁改区。

处置：在 `mindserver.js` 里集中一份 `CONTROL_CODE`（冻结对象），回执统一引用
`code: CONTROL_CODE.RATE_LIMITED`。协议码仍是**单一来源**，`preflight` 的 ActionResult 词表
不再被污染 —— `npm run gate` 现在报 `✓ 错误码审计通过（扫到 35 个码，均已注册）`。

## 11. 没做完 / 需要别人接手的地方

1. `exec_landing_unit` 失败（§9）—— 归因于 `terrain3d.js` 的并发改动，禁改区。
2. agent 进程自己退出时不清 `botOutputBuffers`（§5 末）。
3. `listen-to-agents` 的前端调用点（`agents.ts` 的 `subscribe()`）仍是裸 `socket.emit`，
   没用上新 ack；被限流时依旧靠"看有没有状态帧"反推（#62 的既有机制）。本轮任务书只要求
   改 `emitControl` 调用点，故未动。
4. relay 解耦后 agent 连接也拿到了只读的 map/terrain/诊断 relay（§4 的已知取舍），未加面板门。
5. 没有为 ack / 环形缓冲新增单测：`mindserver` 的 handler 级测试需要假 socket 服务端夹具，
   本轮为保持任务书给定的用例数（49/73/53）未新增；新行为目前由源码接线断言 + 上面这次真机
   验证覆盖。

---

## 收尾补记（captain，2026-11-12）

本文件先前记录的三项遗留，现全部收口：

1. **agent 摘除即清输出缓冲**：新增 `forgetAgentConn(name)`（同时 `delete agent_connections` 与
   `botOutputBuffers.delete`），在三个摘除点统一使用 —— create-agent 的残留注册项、
   createAgent 失败回滚、destroy-agent。子进程自杀走 unregister→destroyAgent 时不再残留。
   断言 C12 同步升级：要求走 `forgetAgentConn` 且该函数必须清缓冲（加强，不是放宽）。
2. **订阅走 ack**：`agents.ts` 的 `armSubscribeWatch` / `retrySubscribe` 改用
   `request('listen-to-agents')`，用服务端给的 `retryAfterMs` 安排重试并把等待时间写进
   `subscribeError`；请求失败仍走原看门狗兜底。
3. **relay 加面板门**：`registerMapRelay` 对非面板连接**直接不注册** `request-map` /
   `request-terrain` / 诊断 relay。agent 自身走 `get-map` / `get-terrain`，不需要 `request-*`，
   所以这是纯收紧。

验证：`control_plane_r6` 53/53、`control_plane_guard` 73/73、`mindserver_gate` 49/49；
`npm test` 142/142（5 跳过）；`npm run gate` 0；`vue-tsc` 0；
`web_dist_manifest_unit` 10/10；`VerifyOnly` 8/8；`ops-regression` 87/87。
