# R6 #2 / #18 —— 控制面鉴权与前端离线闸修复

> 缺陷：R6 报告 #2（破坏性控制面事件没有"面板门"、多数无限流、agent/panel 身份不可区分）
> 与 #18（`stores/diag.ts` 的 `ack()` 绕过离线闸，WEB-001 同源残留）。
> 共同病根：**判据建立在"客户端发了什么"上**——后端看"有没有发 `auth.token`"，前端看"有没有回执"。
> 两者都能被"换个携带方式 / 断线后重连"绕过去。
>
> 本批只做两件事：**把身份变成服务端判定的凭据结论**；**把"没连上就不要发"从注释变成代码**。
> 不改数据库架构（属 ADR 阶段 1-3），不碰 `src/agent/library/**`（fix-board 的作用域）。

| 项 | 值 |
|---|---|
| 成员 | fix-control（t1） |
| 写作用域 | `mindcraft/src/mindcraft/mindserver.js`、`mindcraft/src/mindcraft/auth_gate.js`、`web/src/**` |
| 基线 | 父仓 `main` · 子仓 `mindcraft` `3bcf8e8` · Node v24.16.0 |
| 实际改动文件 | `mindcraft/src/mindcraft/auth_gate.js`、`mindcraft/src/mindcraft/mindserver.js`、`web/src/stores/diag.ts` |

## 0. 结论摘要（先看这几条）

1. **`#2`：agent 与面板现在是两份不同的凭据，角色由握手门按"出示的是哪一份"判定**，写在 `socket.data.role`。
   原来的 `isPanelConnection()` 判据（`!isAgentIdentity(socket) && handshake.auth?.token == null`，
   R6 报告定位 `mindserver.js:1241`）已删除 —— 它只是"客户端有没有发某个字段"的语义标签。
2. **管理面事件统一走 `requirePanel()`**：`server-status/start/stop/log`、`create-agent`、`destroy-agent`、
   `restart-agent`、`start-agent`、`stop-agent`、`stop-all-agents`、`set-agent-settings`、`listen-to-agents`、`shutdown`。
   agent 连接调用一律拒绝，日志 + `control-denied` 回执。
3. **限流补全并按角色分桶**：`stop-all-agents`(3/60s)、`stop-agent`(10/60s)、`server-*`(6 或 30 或 60/60s)、
   `set-agent-settings`(30/60s) 原来**完全没有限流**，现在都有；桶键从 `label@addr` 改成 `label@role@addr`。
4. **`shutdown` 有一个必须保留的既有正常路径**（任务模式跑完任务 → 整套退出）。
   处理方式是**把"权限"和"配置"拆开**：agent 永远没有关服权限；任务模式下由**服务端用自己启动时的配置**判定
   （`rootSettings.task.task_id` 与 `agent_connections[name].settings.task.task_id` 相等、且同一个 task 只收尾一次），
   agent 自述的 `task_id` 只能**收窄**许可。面板模式下一律拒绝。
5. **`#18`**：`ack()` 先判 `socket.connected` 再 emit（断线时**根本不发**，因此进不了 `sendBuffer`）；
   `clearEvents()` 只有服务端确认 `ok` 才清本地视图与游标，并区分 `OFFLINE` / 超时 / 其它失败。
6. **`#3` / `#16` 不在本文件的改动范围**：修复点全在 `board_server.js` / `board_store.js`（fix-board 的作用域），
   已由 captain 裁决判给 fix-board，见第 3 节。

---

## 1. `#2` · 破坏性控制面事件没有"面板门"，agent/panel 不可区分

### 1.1 报告原文与证据行号（改前）

报告 `docs/audit-r6/00-缺陷报告.md` §2 #2：

- `mindserver.js:1647-1659`（`stop-all-agents` / `shutdown`）、`:1603-1606`（`stop-agent`）、
  `:1353-1372`（`server-status/start/stop/log`）、`:1374`（`create-agent`）；
- 根因行：`isPanelConnection()` 的判据是"**没有**发 `auth.token`"（报告记 `:1241`）；
- 报告给的最小修法："给危险事件统一加 `requirePanel(socket)`…… 真要区分主体，需要**第二种凭据**
  （agent 专用 token / 进程级 secret / mTLS）"。

改前代码（本仓基线）与报告一致，两条关键事实：

```js
// mindserver.js（改前）
const isPanelConnection = () => !isAgentIdentity(socket) && socket.handshake?.auth?.token == null;

socket.on('stop-all-agents', () => {              // 无 requirePanel、无 takeToken
    for (let agentName in agent_connections) mindcraft.stopAgent(agentName);
});
socket.on('shutdown', () => { shutdownOnce('socket'); });   // 无 requirePanel、无 takeToken
```

`isAgentIdentity()` 的判据是 `handshake.auth.token === handshakeToken` —— 而**面板与 agent 拿的是同一个 token**，
所以它只能回答"这条连接把 token 放在 auth 字段里了吗"，回答不了"它是谁"。换个携带方式（query/header/cookie）
就换了身份，这就是报告说的"agent/panel 的区分是语义而非鉴权"。

### 1.2 改法

#### （a）第二份凭据：`auth_gate.js`（新增 `ROLE_PANEL` / `ROLE_AGENT` / `registerCredential` / `credentialRole`）

| 凭据 | 生成 | 交给谁 | 是否落盘 |
|---|---|---|---|
| **面板凭据** `handshakeToken` | `process.env.MINDSERVER_TOKEN` 或 `makeToken()`（每次启动不同） | 浏览器 `?token=` → HttpOnly+SameSite=Strict cookie；`.mindserver-token` 文件；启动日志只打指纹 | 是（`.mindserver-token`，退出时删） |
| **agent 凭据** `agentToken` | `makeToken()`（每次启动不同） | **只**经 `process.env.MINDSERVER_TOKEN` 被 agent 子进程继承（`AgentProcess` 默认继承 `process.env`） | **否**（不进 cookie / HTTP / 文件 / 日志） |

握手门按"出示的是哪一份"给角色，**写在服务端**：

```js
// auth_gate.js:173 credentialRole(handshake, panelToken)
if (tokenEquals(presented, panelToken)) return ROLE_PANEL;      // 面板
for (const [token, role] of EXTRA_CREDENTIALS) {                // 登记表（agent）
    if (tokenEquals(presented, token)) return role;
}
// auth_gate.js:224 —— makeHandshakeGate 放行时落戳
socket.data.role = role;
```

为什么用"登记表"而不是给 `makeHandshakeGate` 加第二个参数：`io.use(makeHandshakeGate(handshakeToken))`
这行接线是既有单测（`tools/mindserver_gate_unit.mjs` D1）的锚点，也是"门只有一处"的可 grep 证据。
登记表让面板凭据仍是唯一主参数，agent 凭据由 `registerCredential(agentToken, ROLE_AGENT)` 显式登记
（`mindserver.js:866-869`）。比较走 `tokenEquals`（定长 `timingSafeEqual`），不是 Map 直查，避免时间侧信道。

#### （b）角色是唯一的判据：`mindserver.js`

```js
// mindserver.js:1323
const isPanelConnection = () => socketRole(socket) === ROLE_PANEL;   // null=未知 ⇒ 不是面板

// mindserver.js:1341 —— 管理面事件的统一闸门
const requirePanel = (event, ack) => {
    if (isPanelConnection()) return true;
    console.warn(`[mindserver] 拒绝 ${event}：这是管理面事件，只允许面板连接（当前角色=${role}）`);
    try { if (typeof ack === 'function') ack({ ok: false, event, reason: 'panel_only', role }); } catch {}
    try { socket.emit('control-denied', { event, reason: 'panel_only', role }); } catch {}
    return false;
};
```

`isAgentIdentity()` 也改成"先看角色戳，再看旧字段"（`mindserver.js:262`）：
`role==='agent'` ⇒ true；`role==='panel'` ⇒ false；只有**没有角色戳的桩 socket**（离线单测）才退回旧判据 ——
生产路径上每个 socket 都过握手门，一定有角色。这样 `bot-output` / `agent-event` / `login-agent` 的既有行为不变。

#### （c）哪些事件被"面板门"了（改后行号）

| 事件 | 位置 | 改前 | 改后 |
|---|---|---|---|
| `server-status` | `:1464` | 谁都能调、无限流 | `takeToken 60/60s` + `requirePanel` |
| `server-start` | `:1472` | 谁都能调、无限流 | `6/60s` + `requirePanel` |
| `server-stop` | `:1480` | 谁都能调、无限流 | `6/60s` + `requirePanel` |
| `server-log` | `:1488` | 谁都能调、无限流 | `30/60s` + `requirePanel` |
| `create-agent` | `:1497` | 仅 5/60s | 追加 `requirePanel` |
| `restart-agent` | `:1728` | 3/60s | 追加 `requirePanel` |
| `stop-agent` | `:1744` | **无** | `10/60s` + `requirePanel` |
| `start-agent` | `:1752` | 6/60s | 追加 `requirePanel` |
| `destroy-agent` | `:1772` | 3/60s | 追加 `requirePanel` |
| `stop-all-agents` | `:1795` | **无、无** | `3/60s` + `requirePanel` |
| `set-agent-settings` | `:1710` | **无、无** | `30/60s` + `requirePanel` |
| `listen-to-agents` | `:1929` | 10/60s（幂等在前） | 追加 `requirePanel`（幂等判断仍在限流之前） |
| `shutdown` | `:1823` | 谁都能调、无限流 | 见 1.3 |

**没有**被门掉的（故意的）：`get-settings`（agent 启动时**必须**读自己的配置，`mindserver_proxy.js:103,366`）、
`chat-message` / `send-message` / `bot-output` / `agent-event` / `login-agent` / `connect-agent-process`
（agent 的正常通信面；`bot-output`/`agent-event` 已有"必须是 agent 身份"的判据）、
`get-events` / `clear-events` / `get-task-state` / `get-memory` / `request-map` / `request-terrain`（面板诊断 relay）。

#### （d）限流桶按角色分

```js
// mindserver.js:468
const role = socketRole(socket) ?? 'unknown';
const key = `${label}@${role}@${addr}`;      // 改前：label@addr
```

改前只按远端地址分桶，而本仓默认"全本机部署"（面板与所有 agent 同地址）⇒ **一只话多的 agent 能把面板的配额吃光**。
角色是服务端判的（凭据种类），客户端改不了，于是"谁在刷"至少按主体分开计。

### 1.3 `shutdown`：关服权限 vs 任务模式配置

报告把 `shutdown` 列为必须加面板门的事件。但本仓有一条**既有正常路径**必须保留：

```
agent.js:1160 checkTaskDone() → this.killAll() → mindserver_proxy.shutdown() → socket.emit('shutdown')
```

即"任务模式（`npm start -- --task_path=… --task_id=…`）跑完任务 ⇒ 整套退出"。直接硬拒会让任务模式再也不退出。

处理口径（**判据全在服务端，agent 发来的东西只算"请求"，不算"授权依据"**）：

| 情形 | 结果 |
|---|---|
| `role === 'panel'` | 允许（面板该能关服），走 `shutdownOnce('socket')` |
| `role === 'agent'` 且**启动时配置了 task**（`rootSettings.task.task_id` 存在）且这条连接登记的 agent 的 `settings.task.task_id` 与之相等 | **由服务端决定**收整套，日志明说"这是启动配置决定的行为，不是 agent 的权限" |
| agent 在 payload 里自述了 `task_id` 且 ≠ 启动配置 | 拒绝（自述只能**收窄**许可） |
| 同一个 task 第二次触发 | `already-finished`（幂等，不重复收尾） |
| agent 在面板模式 / `role` 未知 | 拒绝 + `control-denied` |

实现：`taskIdOf()`（`:426`）、`agentNameOfSocket()`（`:433`）、`taskModeShutdownFired`（`:441`），
handler 在 `:1823`。**注意**：`agent_connections[name].settings.task` 是服务端自己登记的那份配置
（`main.js:87` 把含 `task` 的 `settings` 传给 `Mindcraft.createAgent`），不是 agent 自述。

### 1.4 另外顺手打通的一条（给 fix-board 的 #3 用）

`bindAgentChannel()` 成功时（`login-agent` / `connect-agent-process` 都走它，且先过 `claimAgentChannel`
的唯一占用裁决）会把**服务端裁决后的 agent 名**写到 `socket.data.agentName`（`:1648`）。
任务板原来只能取 `payload.bot`（客户端自述），现在可以拿这个戳比对。**这不是凭据**，见 4.2 残留。

### 1.5 行为兼容性核对（"不改现有正常路径"）

| 路径 | 改前 | 改后 |
|---|---|---|
| 面板点"启动/停止/重启/删除 agent"、"启停 Paper"、"看日志"、"改设置"、订阅状态 | 正常 | 正常（面板凭据 ⇒ role='panel'） |
| 面板 `?token=` 打开控制台 | 种 cookie | 不变（cookie 里是**面板**凭据） |
| agent 子进程连回来、发 `bot-output`/`agent-event`/`chat-message`/`login-agent`、读 `get-settings` | 正常 | 正常（agent 凭据 ⇒ role='agent'） |
| agent 领任务板单（`board:*`） | 正常 | 正常（握手门只放行 + 落角色；`board:*` 不判角色） |
| 任务模式跑完任务整套退出 | 正常 | 正常（服务端按配置决定，见 1.3） |
| 面板模式下 agent 发 `shutdown` | **能关掉整套**（缺陷） | 拒绝 + `control-denied` |
| 本机脚本 / 工具读 `.mindserver-token` 连上来做面板动作 | 正常 | 正常（文件里是**面板**凭据） |

### 1.6 验证（本节命令与结果）

```text
# 1) 凭据 → 角色（离线探针，不起服务）
$ node --input-type=module -e "…makeHandshakeGate/credentialRole…"
panel via auth   -> undefined | role= panel        # next() 无错误
agent via auth   -> undefined | role= agent
panel via cookie -> undefined | role= panel
bad token        -> AUTH_REQUIRED | role= undefined
query  携带 agent 凭据 -> agent
header 携带 agent 凭据 -> agent
无凭据  -> null

# 2) 静态接线断言：13 个管理面事件都真的调了 requirePanel
$ node --input-type=module -e "…逐个截取 handler 前 1600 字符…"
ALL GATED
旧语义判据残留: false

# 3) 既有单测（都不需要真 socket / 真进程）
$ node tools/mindserver_gate_unit.mjs        → ALL PASS: 49 passed, 0 failed
$ node tools/control_plane_guard_unit.mjs    → 73/73 个用例通过
$ node tools/proc_lifecycle_unit.mjs         → ALL PASS: 25 passed, 0 failed
$ node tools/identity_binding_unit.mjs       → 80/80 个用例通过
$ node tools/mindserver_local_only_unit.mjs  → 16/16 个用例通过
$ node tools/ops003_offline_identity_unit.mjs→ ALL PASS: 28 passed, 0 failed
$ node tools/lint_hard.mjs                   → no-undef = 0 · no-floating-promise = 0（179 文件）
```

> `mindserver_gate_unit` 的 D1 锚点（`io.use(makeHandshakeGate(handshakeToken))`）与
> `control_plane_guard_unit` 的 E5 锚点（`claimAgentChannel(conn, socket, { agentIdentity: isAgentIdentity(socket) })`）
> 都保留原样 —— 它们钉的是"门只有一处""身份裁决只有一处"，本轮改动没有绕过它们。

---

## 2. `#18` · `diag.ack()` 绕过离线闸（WEB-001 同源残留）

### 2.1 报告原文与证据行号（改前）

报告 §2 #18：`web/src/stores/diag.ts:108-121`（`ack()` 裸 `socket.emit`）、调用点 `:124-148`（`pullEvents`）、
`:150-156`（`clearEvents`）、`:158-171`（`fetchTaskState`）、`:173-186`（`fetchMemory`）；
触发点 `DebugView.vue:41-50,77`。

病根与 `api/socket.ts` 的 WEB-001 **逐字同源**：`emit` 时未连接 ⇒ socket.io-client 把事件推进
`socket.sendBuffer`；16 秒后 `ack()` resolve 成 `{ok:false, reason:'超时'}`，而 `clearEvents()` **不看这个结果**，
照样 `diag.events = []` + `cursors.set(name, 0)`；重连瞬间 `emitBuffered` 把排队的 `clear-events` 真发出去
⇒ **agent 的事件环形缓冲被清空**，而用户看到的提示是"超时失败"。

### 2.2 改法（`web/src/stores/diag.ts`）

1. `ack()` 第一行判连接，**没连接就直接返回、不 emit**（`diag.ts:128-131`）：

```ts
function ack<T>(event: string, ...args: any[]): Promise<DiagAck<T>> {
  if (!socket.connected) {
    // ★ 关键：先判连接再 emit。emit 一次就等于把事件排进 sendBuffer。
    return Promise.resolve({ ok: false, reason: 'OFFLINE' } as DiagAck<T>)
  }
  …
}
```

2. `clearEvents()`（`diag.ts:178`）**只有服务端确认 ok 才清本地**，并把失败原因区分开：

```ts
const r = await ack<{ ok: boolean; reason?: string }>('clear-events', owner)
if (!r?.ok) {
  diag.lastError = r?.reason === 'OFFLINE'
    ? '未连接 mindserver：清空未执行（本地视图保留）'
    : `清空失败：${r?.reason || '未知原因'}（本地视图保留）`
  return
}
if (currentAgent.value?.name !== owner) return    // 迟到响应不写进别人的视图（WEB-006 口径）
diag.events = []; cursors.set(owner, 0); diag.lastError = ''
```

3. `pullEvents()` 断线直接跳过并把原因写进 `diag.lastError`（不再把 `get-events` 排进 `sendBuffer` 等重连补发）。
   `fetchTaskState()` / `fetchMemory()` 走同一个 `ack()`，断线时拿到 `{ok:false, reason:'OFFLINE'}` 并显示，
   不再"看起来在等、其实早已排队"。

没有改成 `request()`：诊断事件失败要就地显示成 `diag.lastError`，不需要 `request()` 的 `UNKNOWN_RESULT` 语义，
且想保留 16s 这个较宽松的超时（`get-task-state` 要读库）。

### 2.3 验证

```text
$ cd web && npx vue-tsc --noEmit
EXIT=0        # 无类型错误（DiagAck<T> = T & {ok?, reason?}，现有 TaskState/MemoryInfo 用法不受影响）
```

代码级核对（`diag.ts`）：`grep -n "OFFLINE" web/src/stores/diag.ts`
→ `:118`（注释口径）、`:130`（ack 的断线返回）、`:187`（clearEvents 的提示分支）。

**未做的验证**：没有在浏览器里制造"断线 + 点清空"的真机复现（属 E2E / 真机验证，
见 4.4）。本条的证据级别是【静态】+ 类型检查。

---

## 3. `#3` / `#16` —— **不在本文件改动，归属 fix-board**

captain 裁决：`#3`（任务板 socket 层零鉴权）与 `#16`（`board:list` 的 `limit` 直通 + `board:add` 无限流）
的修复点全部落在 `mindcraft/src/agent/library/board_server.js` 与 `board_store.js`，
不在我的写作用域（`mindserver.js` / `auth_gate.js` / `web/src/**`）。为避免与 fix-board 互相覆盖，
我**没有**改动这两个文件；已把报告证据行号（`board_server.js:116`/`118-124`/`216-236`/`274-314`/`317-330`/`391-437`/`440-449`；
`board_server.js:187-193`/`127`；`board_store.js:519`）与可落地修法直接发给 fix-board，由他在 t2 内收掉。

我这边只提供了两个**不越界**的支撑：
1. `socket.data.role`（`'panel'|'agent'`，服务端按凭据判定）—— fix-board 已用它做 #3 的判据基础；
2. `socket.data.agentName`（服务端唯一占用裁决后的 agent 名，见 1.4）—— 让 `board:hello` 可以不再信 `payload.bot`。

> 复跑记录：fix-board 折掉 6 个未注册错误码之后，`npm run gate` 在 `mindcraft/` 下 **EXIT=0 / 全绿 37 通过**。

---

## 4. 还没做 / 残留缺口（请连"证据级别"一起引用）

### 4.1 限流仍不是"按 agent 分"（报告 #33，属 Should fix）

桶键是 `label@role@addr`（`:468`）。同一个角色 + 同一地址（本机部署下所有 agent）仍共享一个桶：
**面板已经被隔离出来**（#2 的"话多的 agent 饿死面板"已解决），但**多只 agent 之间**仍会互相吃配额。
要做到按 agent 分，需要在 `login-agent` 之后用 `socket.data.agentName` 再细分 —— 与 #33 一起做更合适。

### 4.2 "两份凭据"仍不是**每 agent 一份**

同一份 agent 凭据被所有 agent 子进程共享（`process.env.MINDSERVER_TOKEN`）。因此：

- 一个持有 agent 凭据的进程仍能 `login-agent <别人的名字>` 去抢通道 —— 会被 `claimAgentChannel` 的
  **接管限速 + 日志**记录下来，并且会**顶掉对方通道**（对方立刻收到 `agent-channel-taken-over` 并断连），
  不是无声的；但它确实不是"凭据级"拒绝。
- 同机同用户的任意进程仍能读 `.mindserver-token`（= 面板凭据，报告 `auth_gate.js` 顶部已写明的边界），
  拿到它就能当面板。这条**不是本轮能解决的**（属 F-RT-001 的同用户权限模型）。
- 真正的封闭要做 **per-agent 凭据**（`(name × 进程)` 一对一，父进程在 spawn 时按 name 生成并只给那个子进程）。
  本轮没做：它会改动 `agent_process.js` / `mindserver_proxy.js`（不在我的作用域），且要处理"重启/接管后凭据轮换"。

### 4.3 任务模式下 agent 仍能"提前"触发收尾

`shutdown` 的任务模式分支只保证：**只能收启动时配置的那一个 task、只能收一次、agent 自述不能扩大许可**。
一个被提示注入的 bot 在任务模式下仍可能**提前**结束整套（它本来就有权在任务完成时这么做，
服务端无法区分"真完成"和"被诱导完成"）。
面板模式（= 产品模式）下这个洞是**封死的**（agent 一律拒绝）。若要连任务模式也封，
需要"任务完成"由 agent 之外的一方认定（面板/调度器），属后续任务。

### 4.4 真机 / E2E 未做

- 没有起真服务验证"agent 子进程真的只能拿 agent 凭据"（`AgentProcess` 继承 `process.env` 是既有行为，
  本轮只改了**写进 env 的值**；集成层没有任何自动化用例覆盖"agent 发 server-stop 被拒"）。
- 没有做浏览器端的"断线 → 点清空 → 重连"实测（#18）。
- 建议 gate-runner 在复核时补一条端到端：起 mindserver → 用 agent 凭据连一条 socket →
  发 `server-stop` / `stop-all-agents` / `create-agent` / `shutdown` → 断言全部 `control-denied` 且进程仍在。

### 4.5 `control-denied` 前端还没有统一消费

后端会在拒绝时向该 socket 发 `control-denied`（`{event, reason, role}`），但前端目前只对
带 ack 的事件显示失败原因（`request()` / `SetupView` 的 ack 路径），**没有**监听 `control-denied` 做统一提示。
本轮没加：`web/src` 里新增一个全局监听属于 UI 行为变更，且需要和"错误文案统一"（报告 #66）一起做。

---

## 5. 改动清单（可直接拿去 review）

| 文件 | 改动 |
|---|---|
| `mindcraft/src/mindcraft/auth_gate.js` | 新增 `ROLE_PANEL`/`ROLE_AGENT`、凭据登记表 `registerCredential`/`clearCredentials`、`credentialRole()`；`makeHandshakeGate` 放行时写 `socket.data.role` |
| `mindcraft/src/mindcraft/mindserver.js` | 新增 `agentToken`（第二份凭据）与 `registerCredential`；`isAgentIdentity` 改为角色优先；新增 `socketRole()`/`taskIdOf()`/`agentNameOfSocket()`/`taskModeShutdownFired`；`isPanelConnection` 改为角色判据；新增 `requirePanel()`；13 个管理面事件接入 `requirePanel` + 补限流；`takeToken` 桶键加角色；`shutdown` 改为"面板直接允许 / 任务模式服务端判定 / 其余拒绝"；`bindAgentChannel` 落 `socket.data.agentName` |
| `web/src/stores/diag.ts` | `ack()` 断线短路（`OFFLINE`，不 emit）；`clearEvents()` 按回执决定是否清本地（区分 OFFLINE/超时）；`pullEvents()` 断线跳过并写 `lastError` |
