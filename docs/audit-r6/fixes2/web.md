# R6 前端清零：#57–#66 / #68 + Nice W12–W16

| 项 | 值 |
|---|---|
| 任务 | R6 t4（`fix-web`，第 2 条前端工作流） |
| 写作用域 | `web/**`（`src` + 构建配置）；`mindcraft/**` 只读（服务端需求写在 §7 交接） |
| 基线 | 父仓 `c0cd82b`；`vue-tsc --noEmit` 起始 0 error |
| 结论 | R6 报告 W1–W11（Should）与 W12–W16（Nice）对应项**全部落地**；其中 4 条（#57 服务端 ack、#62 relay 解耦、#64 服务端重放、W13 的 `socket.acks`）**前端无权限闭环**，已在 §7 写成可执行的服务端需求 |
| 门禁 | `vue-tsc` **0**；`vite build` + `sync_web_dist` 重建；`web_dist_manifest_unit` **10/10 PASS**；`scripts/release.ps1 -VerifyOnly` **8/8 PASS**（清单/产物/源码三方一致） |

> 口径：本文件只写"改了什么、凭什么说它真的改了"。凡是**只做了静态推演**（没有真机浏览器操作、没有起 mindserver）的地方在 §8 单列，不混进结论。

---

## 0. 改动清单（按文件）

| 文件 | 对应条目 |
|---|---|
| `web/src/api/socket.ts` | #66（`pauseReconnect`/`resumeReconnect`/`reconnectNow`）、#57（`emitControl` 语义注释） |
| `web/src/api/humanize.ts`（**新增**） | W14（错误码→人话，公共函数） |
| `web/src/stores/agents.ts` | #57 #58 #62 #63 #64 #65 W16 |
| `web/src/stores/board.ts`（**新增**） | #68 |
| `web/src/stores/config.ts` | #59（`confirm` 字段）+ fix-control 的 409 契约 |
| `web/src/stores/terrain.ts` | W15 |
| `web/src/views/BoardView.vue`（**新增**） | #68 |
| `web/src/router.ts` / `web/src/App.vue` | #68（路由 + 导航）、#63/#66（横幅/新鲜度） |
| `web/src/views/ConsoleView.vue` | W14（空态按连接状态分支） |
| `web/src/views/ChatStream.vue` | #57 #58 #64 |
| `web/src/views/StatusCard.vue` | #57 #58 #63 #65 |
| `web/src/components/QuickCommands.vue` | #58 |
| `web/src/components/IdentityPanel.vue` | #61 |
| `web/src/views/SettingsView.vue` | #59 |
| `web/src/views/SetupView.vue` | #60 #65 |
| `web/src/views/DebugView.vue` | #62 W13 W14 |
| `web/src/components/TerrainCanvas.vue` | W13 |
| `web/src/views/TerrainView.vue` | W15 |
| `mindcraft/web-dist/**`（产物） | 重建：16 个产物文件 + `MANIFEST.json` |

---

## 1. #57 控制命令"假成功"

**根因（审计 W1）**：`send-message` / `start-agent` / `stop-agent` / `restart-agent` / `destroy-agent`
服务端**没有 ack**；四类失败帧（`start-agent-failed` / `destroy-agent-failed` /
`agent-channel-rejected` / `agent-channel-taken-over`）前端**一个都没监听**。
`emitControl()` 只保证"发出去了"就返回 `ok:true`。

**改法（纯前端，符合"不改 mindserver"的边界）**

1. **监听四类失败帧**（`stores/agents.ts:296-309`）：
   - 写入 `store.actionError[agent]`（卡片就地显示）、`setError()`（顶部横幅）、往对话流插一条 system 行；
   - 同时清掉该 agent 对应的 `pendingActions` 条目 —— 否则按钮会一直停在"启动中…"。
2. **失败语义显式化**：
   - 聊天：`say()` 先落一条 `state:'pending'` 的"我"消息，2.5 秒后落成 `sent`（文案**"已发出"**，
     tooltip 明确"服务端不回执，无法确认送达"），断线时落成 `failed`（`stores/agents.ts:175-190`、`:267-272`）。
   - 控制动作：`agentAction()` 记 `pendingActions[agent:event]`，15 秒内没有 `agents-status` 或失败帧
     ⇒ 落成 **"已发出但结果未知"**（`stores/agents.ts:210-232`）。**不再**把"发出去了"当"执行了"。
3. **UI 如实呈现**：`StatusCard` 三个按钮在飞行中显示"启动中…/停止中…/重启中…"并禁用；
   `ChatStream` 每条"我"的消息右侧显示"发送中…/已发出/未发出（原因）"。

**仍未闭环（交接 fix-control，§7-1）**：真正的"送达/失败"只能靠服务端 ack。
前端已经把"未确认"态、失败帧处理、超时降级都做好了 —— 服务端一旦给这 5 个事件加
`callback({ok:false, code:'RATE_LIMITED'|'NOT_IN_GAME'|'TOO_LONG'|'NOT_RUNNING'})`，
前端只需把 `emitControl` 换成 `request()` 即可把 `sent` 升级为"确认送达"，无需再动 UI。

---

## 2. #58 断线不清 agent 列表（在线假象 + 输入被吞）

**根因（W2）**：`disconnect` 只清 `states`，`store.agents` 原样保留 ⇒ `in_game` 是旧值，
徽标继续"在线"、输入框可编辑，而 `say()` 失败后 `input.value=''` 无条件清空。

**改法**

- 新增 `store.agentsStale`：`disconnect` 与 `connect_error` 都置 `true`，`connect` / `agents-status` 置回 `false`
  （`stores/agents.ts:31,249,262,278,310`）。
- 新增 `dataStale` 计算属性（`stores/agents.ts:81`）：`!connected || agentsStale || 状态帧 > 5s`。
- **写操作统一按 `connected && !agentsStale && in_game` 判定**：
  - `say()` 前置判定（`:362`）：不满足就 `setError()` 并返回 `false`；
  - `ChatStream.send()` **只在 `say()` 返回 true 时清空输入框**（`ChatStream.vue:9-15`）——
    断线时用户打的字留在框里；
  - `ChatStream` 的输入/发送按钮、`QuickCommands` 的全部按钮改绑 `canSend` / `offline`；
  - `StatusCard` 的"在线"徽标在断线时显示**"未连接"**而不是"在线"。
- 空态修正（W14 同源）：`ConsoleView` 断线时说"未连接到 mindserver（正在重连）"并给「重试连接」，
  不再说"还没有 agent，去配置页创建一个"（那句会把人引去改 `settings.js`）。

---

## 3. #59 allow_insecure_coding 永远存不下去（+ fix-control 的 409 契约）

**根因（W4）**：`save()` 的闸门是"从 false 打开且未确认"，而 `acceptInsecure()` 只把
`form.runtime.allow_insecure_coding=true` 并把 `confirmInsecure` 复位，**不触发保存** ⇒
再点保存时三个条件再次成立 ⇒ 弹框死循环，一次也写不进 `settings.js`。

**改法**

- 引入 `confirmedFor: ConfigGroup | ''`（`SettingsView.vue:71`）：确认**只绑定本次提交**；
  `save()` 的判据改成 `confirmedFor.value !== 'runtime'`（`:93`），提交时带 `confirm`
  （`:102`），成功/失败/无改动都把它复位（`:99,105,108`）。
- `acceptInsecure()` 确认后**立刻**发起这一次保存（`:179-183`）；`rejectInsecure()` 复位（`:190`）。
- **接上 fix-control 的接口增量（R6 #29）**：`saveGroup()` 新增第三参
  `{confirm?: boolean}`，只有该值为真才在 body 顶层加 `confirm: true`
  （`stores/config.ts:174-186`）——**不是默认值**，否则等于没确认。
- 错误分类（`stores/config.ts:190-203`）：
  - `CONFIG_CONFIRM_REQUIRED`（409）→ "开启高危项需要二次确认…"；
  - `CONFIG_CONFLICT`（409，写前 CAS 被并发改）→ "**请先「刷新」重读再重试**"（不再静默覆盖）；
  - 400 → "值不合法（服务端拒绝写入）"。
  **409 与 400 分开**，两类 409 也分开 —— 前者是"你没确认/被别人改了"，后者是"值错了"。

**行为断言**：开关从 false→true 时弹一次确认 → 点"我明白风险，开启" → 带 `confirm:true` 提交 →
409 不再出现；从 true→false 不需要确认（`wasOff` 为 false，直接提交）。

---

## 4. #60 SetupView 三处未捕获 rejection + 无超时

**根因（W5）**：`loadProfiles` / `refreshServer` 裸 `await request()`（断线时立即 `OFFLINE` 拒绝）
⇒ 未处理拒绝 + 页面空白/徽标恒"未知"；`srvAction` 是 `try/finally` **没有 catch** ⇒ 点"启动服务"零反应；
`loadSettings` 用裸 `socket.emit`（无超时、无离线判据）⇒ 点「设置」永远空白。

**改法**

- `loadProfiles()` / `refreshServer()` 补 `try/catch`，错误写进 `profilesErr` / `srvMsg`（`SetupView.vue:61-75`、`:148-160`）。
- `srvAction()` 补 `catch`（`:182-185`）。
- `loadSettings()` 改用 `request()`：离线立即失败、有 15 s 超时、异常可见（`:12-25`）。

---

## 5. #61 IdentityPanel 不跟随 agent 切换

**根因（W6）**：只在 `onMounted` 拉一次；切人不重挂 ⇒ 显示上一个 bot 的绑定/模式，
「解绑」把 A 的行发给 B（服务端 `removed:0`，界面看起来成功）。

**改法**

- `watch(agentName)`：切人即清空 `code/expiresAt/bindings/pending/mode/err` 并按新 agent 重拉
  （`IdentityPanel.vue:127-140`）。
- `unbind()` 把"这次解绑属于谁"钉住（`const owner = agentName.value`），
  响应回来时若已切人则**丢弃结果**；`removed === 0` 明确提示"服务端没有删除任何记录"
  （`:90-108`）—— 不再把 `removed:0` 当成功。

---

## 6. #62 按需 relay 与 listen-to-agents 强耦合 / #63 数据新鲜度 / #64 断线不重放

### 6.1 #62（前端侧缓解 + 服务端需求）

**根因（W7）**：`request-terrain` / `get-events` / `clear-events` / `get-task-state` / `get-memory`
的 handler 只在 `addListener()` 里注册；而 `listen-to-agents` 被限流（10 次/60 秒，桶按远端地址）
时不回任何东西直接 return ⇒ 这条连接**永远进不了 `agent_listeners`**：
状态不再推、relay 根本没注册，前端只能看到"31 秒超时"，而且 `socket.connected === true`。

**改法（前端不给假结论）**

- 订阅看门狗（`stores/agents.ts:104-136`）：连上后 12 s 内没收到 `state-update` ⇒ 判定"可能未订阅"，
  退避重试 `listen-to-agents`（5s/10s/15s，最多 3 次），并把 `store.subscribeError` 显式化。
- 收到任意状态帧 ⇒ `subscribed = true`、清告警、停表（`:312-320`）。
- `DebugView` 顶部显示"已订阅状态 / 未确认订阅"+「重试订阅」按钮（`DebugView.vue:56-63`）。
- 代价：**这只让"未订阅"可见并可自愈，不能真正解耦** —— relay 注册仍在服务端 `addListener` 里。
  解耦方案见 §7-2（交 fix-control）。

### 6.2 #63 数据新鲜度

**根因（W8）**：每秒整体替换 `states` 但不记时间戳；服务端 5 秒不回会**沿用上一帧**且不报错；
`lastError` 写入后除重连外永不清除。

**改法**

- `store.statesAt` + `store.now`（1 Hz 本地心跳，`stores/agents.ts:242-244`）、
  `stateAgeMs` / `STALE_AFTER_MS = 5000` / `dataStale`（`:74-83`）。
- `StatusCard` 在超过 5 秒时显示**"⚠ 状态已过期 N 秒（服务端超时会沿用上一帧）"**（`StatusCard.vue:76-79`）。
- 顶部横幅：连接徽标旁新增"数据 Ns 前"徽标（`App.vue`）。
- `lastError` 分级自愈：`setError()` 记时间戳；**状态帧持续到达且错误已超过 15 秒**则自动清除
  （`stores/agents.ts:322-325`）；横幅另有「×」可手动关闭。

### 6.3 #64 聊天/输出断线不重放、刷新即丢

**根因（W9）**：`bot-output` 只有 `io.emit` 广播，服务端**不为面板缓冲**；前端只在内存，
刷新即清；两个视图共用 500 条上限互相挤占。

**改法（前端侧，能做的都做了）**

- 双缓冲解耦容量：`MAX_CHAT=500` / `MAX_OUTPUT=1000`（`stores/agents.ts:22-24`）。
- `sessionStorage` 持久化（`stores/agents.ts:86-141`）：最近 200 条 chat + 200 条 output，
  400 ms 防抖，`restoreHistory()` 在 `initStore` 里接回（含 `seq` 续号，避免 key 冲突）。
  隐私模式/配额满时 `try/catch` 静默降级，不影响主流程。
- 断线缺口**显式标注**：`store.chatGap` 在 `disconnect` 置真，`ChatStream` 插一条
  "— 期间可能断线过，断线窗口内的输出服务端不补发 —"（`ChatStream.vue`）——
  **不假装"什么都没丢"**。
- **仍未闭环**：断线窗口内产生的输出无法找回（服务端没有 ring buffer）。
  方案见 §7-3：`get-output(since)` + 带 `seq` 的缓冲，与 `get-events` 同构。

---

## 7. #65 高危操作零确认 / #66 token 失效 / #68 任务板

### 7.1 #65 高危操作确认 + 在飞锁

**根因（W10）**：`destroy-agent` 与 `server-stop` 一击即发；`start-agent` 连点重复下发
（服务端 6 次/60 秒才拦，且拦了不回话）。

**改法**

- 复用 `/vault` 已有的"两次点击确认"模式：
  - `destroy-agent`：第一次点把按钮文案变成 **"确认删除？"**，4 秒无第二次点击自动复位
    （`SetupView.vue:27-36`、`:200-203`）；
  - `server-stop`：第一次点变成 **"确认停止？（再点一次）"**（`:177-182`、`:316-319`）。
- **在飞锁**：`agentAction()` 用 `pendingActions[agent:event]` 拒绝重复点击
  （`stores/agents.ts:212-213`），`StatusCard` 三个按钮同时置灰并显示"…中"
  （`StatusCard.vue:99-110`）。锁的释放有两条路：`agents-status` 到达、失败帧到达、或 15 s 超时降级为"结果未知"。

### 7.2 #66 token 失效没有恢复出口

**根因（W11）**：`connect_error` 只把 `e.message` 拼进横幅，然后 0.5–3 s 一次无限重连；
页面没有"重新带 token 打开"的出口，也没有把 `err.data.code` 映射成人话。

**改法**

- `connect_error` 判 `e.data.code === 'AUTH_REQUIRED'`（已核对 `auth_gate.js:227` 实际发出的码）
  ⇒ 横幅换成 **"握手 token 已失效：mindserver 重启会换 token。请用新值重新打开
  `http://<host>:8080/?token=<mindcraft/.mindserver-token 里的值>`"**，
  并 `pauseReconnect()` **停止重连风暴**（`stores/agents.ts:274-289`、`api/socket.ts:27-40`）。
- 连接徽标显示 **"token 失效"**（不再说"重连中…"，那会让人一直等）；横幅上有「重试连接」按钮
  ⇒ `reconnectNow()` 恢复自动重连（`App.vue`）。
- `AUTH_BAD_TOKEN` 分支是**防御性**的：当前 `auth_gate.js` 只发 `AUTH_REQUIRED`，
  留着是为了将来码名变化时不至于退回"无限重连"。这一点在 §8 明确说明，不算已验证能力。

### 7.3 #68 任务板最小可用入口（新增）

**根因**：`mindserver` 通过 `attachBoardServer()` 暴露了完整的 `board:*` 事件（`board:list` /
`board:get` / `board:set-state` / `board:update` …），`board_server.js` 明确"面板/控制层可以
替任意 bot 建单、取消、暂停"，而 `web/src` 里 `board` 命中 **0** —— 后端有能力，前端无入口。

**做到的（刻意最小，不引新依赖）**

- 新增 `web/src/stores/board.ts`：
  - `refreshBoard()` → `board:list {scope:'all', openOnly, limit:200}`（`limit` 走服务端 1..500 校验）；
  - `cancelJob()` → `board:set-state {id, state:'cancelled'}`；
  - `retryJob()` → `board:set-state {id, state:'ready'}`（仅对 `blocked/paused/claimed/running`，
    与服务端 `TRANSITIONS` 对齐；`done/failed/cancelled` 是终态，按钮禁用）；
  - 走 `request()`（既有 ack 超时 + **离线闸**），错误码 `LEASE_LOST` / `NO_PERMISSION` / `TOO_MUCH` 翻人话；
  - `board:changed` 只在**页面打开时**（`board.watching`）自动刷新。
- 新增 `web/src/views/BoardView.vue`：未终结计数、只看未终结开关、文本过滤、
  按状态着色的列表（id/状态/skill+args/assignee/优先级/尝试次数）、**重试**与**取消**按钮（逐行 busy 锁）、
  终态禁用说明。路由 `/board`（懒加载）+ 顶部导航「任务板」。

**没做（属完整产品，不在本条）**：建单/编辑参数、子单树（parentId/rollup）、共享数据
（`board:shared-*`）、租约详情、优先级拖拽。`board:add` 需要 `skill` 在注册表内且参数过
`manifest.params` 校验 —— 那套 UI 是另一个量级，硬塞进来会变成"半成品入口"。

---

## 8. Nice 项（W12–W16）

| 项 | 结论 |
|---|---|
| W12 `--text-dim` 不存在 | **已修（前一轮）**。复核：`grep -rn "text-dim" web/src` 无命中；`var(--…)` 引用集合与 `tokens.css` 定义集合差集为**空**，无其它未定义变量 |
| W13 1 Hz 整树重算 + rAF 常驻 | **已修**。① `TerrainCanvas` 监听 `visibilitychange`：页面隐藏时停 rAF，回来时重启（`TerrainCanvas.vue:269-283` + `onBeforeUnmount` 反注册）；② `DebugView` 的 `stateJson` 改成**只在 `tab==='state'` 时**才 `JSON.stringify`（`DebugView.vue:11-17`）—— 原来停在"事件流"页也每秒 stringify 一次整份状态 |
| W14 错误码直出 + 空态误导 | **已修**。新增 `web/src/api/humanize.ts`（`OFFLINE` / `agent_not_in_game` / `unknown_agent` / `panel_only` / `rate_limited` / 超时…），在 `DebugView` 的事件/任务/记忆三处与 `BoardView` 使用；`ConsoleView` 空态按 `connected` 分支（断线 ≠ 没有 agent） |
| W15 地形解码异常未捕获 | **已修**。`decodeTerrain` 显式校验 `pos` 字节数（按 `dtype` 4/2 与 3 坐标对齐）与 `types` 数量，不合格就清空 `decoded` 并把原因写进 `terrain.stats`；`t[i]` 用 `?? 0` 兜底；`loadTerrain()` 与 `TerrainView.load()` 各加 `try/catch`，异常变可见错误 |
| W16 `isFullState` 校验不完整 | **已修**。校验清单与模板消费点对齐：`gameplay.health` + `gameplay.position` + `inventory.counts/equipment/stacksUsed` + `action` + `nearby.humanPlayers` 数组（`stores/agents.ts:170-186`）。契约漂移时整条状态被丢弃并给出可读提示，而不是整卡抛 `TypeError` |

**未做且写明理由**：`socket.acks` 在长连接内的缓慢增长（未用 `socket.timeout()`）。
`request()` 仍是"自建定时器 + 普通 ack"，未应答的回调由 `disconnect` 时的 `_clearAcks()` 清理。
要彻底解决得把 `request()` 换成 `socket.timeout(ms).emit(...)`（依赖内部自动清理），
这属于**传输层重构**，会同时影响 identity / server-* / 诊断全部调用点；
本轮已改 16 个文件，不宜再叠一层高风险重构。**建议单列一条任务。**

---

## 9. 交接给 fix-control 的服务端需求（本单不改 mindserver）

以下四条都是前端**无法自己闭环**的，按"最小改动 + 现有错误码口径"写成可执行需求：

1. **#57 给 5 个控制事件加 ack**（`mindserver.js` 的 `send-message` / `start-agent` /
   `stop-agent` / `restart-agent` / `destroy-agent`）：回调参数 + 统一形状
   `{ok:false, code:'RATE_LIMITED'|'NOT_IN_GAME'|'TOO_LONG'|'NOT_RUNNING'|'ALREADY_RUNNING'}`。
   **收益**：前端 `emitControl()` 可换 `request()`，"已发出"升级为"确认送达/确认被拒"。
   **注意**：`send-message` 当前在 `agent_connections[agentName].socket` 为 `null` 时会抛
   `TypeError` 被 `try/catch` 吞成一行 `console.error('Error: ')` —— 连服务端都不认为那是"拒绝"，
   加 ack 时**顺手把它变成 `NOT_RUNNING` 的显式拒绝**。
2. **#62 relay 与订阅解耦**：`request-terrain` / `get-events` / `clear-events` / `get-task-state` /
   `get-memory` 的 handler 在 `io.on('connection')` 里注册（或在 `requirePanel` 通过后立即注册），
   不要只在 `addListener()` 里注册；并给 `listen-to-agents` **加 ack**（`{ok:false, code:'RATE_LIMITED', retryAfterMs}`）。
   **收益**：前端不必靠"12 秒没状态帧"猜订阅失败；被限流时能直接显示"还需等 N 秒"。
3. **#64 输出可重放**：`bot-output` 增加 `seq` 并保留 ring buffer（建议 1000 条/进程），
   新增 `get-output(sinceSeq, cb)`（形状与 `get-events` 同构）。
   **收益**：前端把 `sessionStorage` 兜底换成"按游标补拉"，断线窗口内的输出不再永久丢失。
4. **W13 传输层**：`request()` 改 `socket.timeout()` 属于前端可做项，但会动所有 ack 调用点，
   建议作为独立任务评估（不阻塞本单）。

**已在本次落地、无需 fix-control 动作**：`PUT /api/config` 的 `confirm:true` 已接（§3），
两类 409（`CONFIG_CONFIRM_REQUIRED` / `CONFIG_CONFLICT`）已分开处理。

---

## 10. 验证（命令与实测输出）

> 全部在本机 `E:\我的世界ai` 实跑，不是推演。

### 10.1 类型门禁

```console
$ cd web && node ./node_modules/vue-tsc/bin/vue-tsc.js --noEmit
EXIT=0
```

### 10.2 重建产物（**不重建 = 运行时不生效**，F1 的教训）

```console
$ cd web && node node_modules/vite/bin/vite.js build
✓ 109 modules transformed.
dist/index.html                         0.40 kB
dist/assets/BoardView-CpTOM3zj.js       5.40 kB   ← 新增任务板
dist/assets/humanize-VZJ6ObYL.js        0.80 kB   ← 新增 humanize
dist/assets/index-D71HzmAv.js         173.72 kB
✓ built in 2.88s

$ node mindcraft/tools/sync_web_dist.mjs
[sync] 已同步 16 个文件到 mindcraft/web-dist
[sync] 已保留原 MANIFEST.json（本工具不写清单：唯一写者是 scripts/release.ps1）
```

### 10.3 清单/产物/源码三方一致

```console
$ node mindcraft/tools/web_dist_manifest_unit.mjs
PASS 产物里没有缺失文件
PASS 产物内容与 MANIFEST 完全一致（防止手改/漏更新） 16 个文件全对
PASS 产物目录没有 MANIFEST 未记录的野文件
PASS 产物里至少有 1 个 assets/*.js（不是空壳） count=8
PASS index.html 已纳入清单
PASS 产物绑定的源码指纹与当前 web/src 一致（防"改了源码没重建"）
   清单=sha256:19c0e0b56232…  当前=sha256:19c0e0b56232…（32 个输入）
ALL PASS: 10 passed, 0 failed
```

### 10.4 发布自检

```console
$ powershell scripts/release.ps1 -SkipDocker        # 首次：构建 + 同步 + 写清单
  |   PASS  16 个产物文件与清单逐条一致
  |   PASS  源码指纹 sha256:19c0e0b56232…
  |   PASS  已写回发布元数据（generatedAt = 2026-11-11T08:37:36Z）

$ powershell scripts/release.ps1 -VerifyOnly        # 复核：只校验
  |   ALL PASS: 8 passed, 0 failed
  PASS  VerifyOnly：清单/产物/源码三方一致
```

**为什么先跑 `-SkipDocker` 再跑 `-VerifyOnly`**：`MANIFEST.json` 的唯一写者是
`scripts/release.ps1` 的非 VerifyOnly 路径（R6 #50 双写者修复）；`sync_web_dist.mjs` 现在
**只拷产物、不写清单**（工具自身也打印这一点）。所以"改完 `web/`"的正确顺序是：
`vite build` → `sync_web_dist` → `release.ps1`（写清单）→ `release.ps1 -VerifyOnly`（复核）。

### 10.5 产物落盘证据

`mindcraft` 子仓 `git status`：`web-dist/MANIFEST.json` 与 `index.html` 已改，
12 个旧哈希产物删除、14 个新哈希产物新增（其中 `BoardView-*`、`humanize-*` 是本次新增入口）
—— 说明产物**确实重建**，不是"源码改了产物没动"。

---

## 11. 诚实边界（哪些是"已验证"，哪些不是）

| 断言 | 证据等级 |
|---|---|
| 类型门禁 0、产物重建、清单/源码指纹一致、发布自检 8/8 | **实跑命令**（§10），可复现 |
| 失败帧事件名/载荷字段（`{agent, reason}`）与服务端一致 | **逐行核对** `mindserver.js:1814` / `:1834` / `:1676` / `:1683` |
| `board:list` / `board:set-state` 的 payload 与 ack 形状 | **逐行核对** `board_server.js:430-497`、`:613-635`，并按 `board_store.js` 的 `TRANSITIONS` 定"能否重试" |
| 面板连接（role=panel）可取消/改任意单 | **核对服务端判据**：`actingBot()` 对 `ROLE_PANEL` 放行、`assertJobOwner()` 只对 `ROLE_AGENT` 生效 |
| `AUTH_REQUIRED` 是 token 失效的实际错误码 | **核对** `auth_gate.js:227`（`err.data = {code:'AUTH_REQUIRED'}`） |
| 各界面在断线/限流/超时下的**真实观感** | **未验证**：本轮没有起 mindserver、没有真机浏览器操作。所有 UI 结论来自源码路径推演 |
| `AUTH_BAD_TOKEN` 分支 | **未验证**：当前服务端不产生这个码，纯防御性代码 |
| `visibilitychange` 停 rAF 的实际 GPU 占用下降 | **未验证**：没有 profile 数据（结构性改动，方向确定） |
| `sessionStorage` 在配额满/隐私模式下的降级 | **未验证**：代码有 `try/catch`，但没有构造配额耗尽场景 |
| 任务板在真实数据库上的读性能 | **未验证**：`limit:200` 由服务端强制 1..500；没有拿生产库跑过 |

---

## 12. 与 R5 既有修复的关系（避免重复计账 / 避免互相踩）

- **未回退任何 R5 修复**：WEB-001（`emitControl` 离线闸）、WEB-002（`sanitizeStates`）、
  WEB-003（IME 回车）、WEB-006（事件游标按 agent）、WEB-007（地形归属）、WEB-008（`seq` 驱动滚动）、
  WEB-009（`create-agent` ack 超时）、WEB-011（profile 原生 button）、WEB-012（`allow_insecure_coding` 默认 false）全部在位。
- **本轮新增的状态字段是"加法"**：`agentsStale` / `statesAt` / `subscribed` / `pendingActions` /
  `actionError` / `chatGap` / `authFailed` 都不改既有字段语义；
  `ChatLine.state` 是可选字段（旧持久化数据没有它也能渲染）。
- **与 fix-control 的写作用域零交叉**：`mindcraft/**` 只读，所有服务端诉求写在 §9。
- **设置页的两处契约同时更新**：`confirm:true`（#29）与 `CONFIG_CONFLICT` 的"重读后重试"文案，
  没有把它们当普通错误吞掉，也没有无限重试。

---

## 13. 剩余风险 / 建议单列的任务

1. **`request()` 未用 `socket.timeout()`**（W13 尾巴）：长连接下 ack 回调会缓慢积累，
   断开时才集中清理。改动面横跨全部 ack 调用点，建议单独一条。
2. **`send-message` 的 `TypeError` 静默吞掉**（§9-1 附带项）：这是服务端"假成功"的另一半根源，
   加 ack 时必须一起改，否则前端只能停在"已发出"。
3. **#64 的服务端 ring buffer**：不做的话，"刷新 + 断线"组合下日志仍然会丢一段 ——
   前端已经如实标注缺口（`chatGap`），但没有能力补回。
4. **真机验收**：建议在起 mindserver 后按 §11 的"未验证"清单逐条过一遍
   （特别是 #62 的限流复现与 #66 的 token 轮换）。

---

## 14. 增量（fix-control 移交，2026-11-11 17:0x）

`identity-status` 的 ack 新增三个字段（服务端已实现，面板只读消费；**不影响旧服务端**）：

| 字段 | 语义 | 面板口径 |
|---|---|---|
| `corrupt: boolean` | 身份表损坏，已按**空表** fail-closed 处理 | `true` ⇒ 显示"⚠ 身份表损坏 / 已按空表处理（fail-closed）"；`false` ⇒ **什么都不显示** |
| `backup: string\|null` | 损坏时原文件改名留证路径（`<path>.corrupt-<ts>`） | 仅在 `corrupt===true` 时原样显示"原文件已改名留证：`<backup>`" |
| `modeError: string\|null` | **R6 #74**：读身份策略失败的原因（`mode` 为 `null` 时才有值） | 显示"读不到身份策略（离线/正版无法判断）：…"，不再只留一个空白 |

**关键防误导**：`corrupt===true` 时 `bindings` 必然是空数组 —— 面板**不**再用
"0 个绑定 / 还没有人绑定"这类文案，改为"绑定表不可读（见上方「身份表损坏」）——
这不是「没有绑定」，别据此判断权限"。这正是本条要避免的误读。

**兼容性**：字段缺失一律按"正常"处理（`r.corrupt === true` 严格判真、`modeError ?? null`），
所以对接旧 mindserver 时不会出现假的"损坏"告警。

**改动**：`stores/agents.ts`（`IdentityStatus` 加三个可选字段）、
`components/IdentityPanel.vue`（状态捕获 + 切人复位 + 告警块 + 空列表文案 + 样式）。

**验证**：`vue-tsc` 0；`vite build` → `sync_web_dist` → `release.ps1 -SkipDocker`（重写清单，
`generatedAt=2026-11-11T09:08:03Z`）→ `release.ps1 -VerifyOnly` **8/8**；
`web_dist_manifest_unit` **10/10**（源码指纹已随本次改动更新）。

**仍未验证**：没有构造真实的 `identity.json` 损坏场景跑一遍（需要起 mindserver + 弄坏一个身份表）；
`corrupt/backup/modeError` 三段的"显示效果"属源码级实现，真机观感未看过。
