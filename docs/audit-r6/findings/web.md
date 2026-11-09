# R6 · 前端审计：控制台在异常状态下的真实表现

| 项 | 值 |
|---|---|
| 审计员 | scan-web（前端审计员） |
| 审计时间 | 2026-11-09 22:3x–23:1x（Asia/Shanghai） |
| 基线 | 父仓 `d818b02` · 子仓 `mindcraft` `82da3f3` |
| 范围 | `web/src/**`（23 个文件 / 4674 行：`views/`、`components/`、`stores/`、`api/`、`router.ts`、`App.vue`、`main.ts`、`styles/tokens.css`）、`web/vite.config.ts`、`web-dist` 的消费方式（`mindserver.js` 的 `/console` 挂载 + `web/dist` 产物） |
| 方法 | 逐文件通读 + 与后端契约逐事件比对（`mindserver.js` / `mindcraft.js` / `full_state.js`）+ 依赖实现核对（`socket.io-client@4` 的 `emit`/ack 路径）+ `vue-tsc --noEmit`（0 error）+ 产物与源码一致性抽查。**未启动服务、未在浏览器里操作、未修改任何产品代码**（唯一产出是本文件） |
| 性质 | 只读审计。下文所有"修法方向"是建议，不是已实施 |

> 证据口径：行号以基线提交为准，格式 `文件:行`。凡我**没有**亲手验证的（真机浏览器行为、vite dev server），在第 4 节单独标出，不混进结论。
> 严重度沿用本队口径：**P0** = 直接造成数据丢失/错误执行；**P1** = 面板给出与事实相反的结论（假成功/假在线），或破坏性命令会在错误时刻执行；**P2** = 功能死路/静默失败/跨对象错配；**P3** = 体验与可维护性。

---

## 0. 结论摘要（先看这 12 条）

1. **控制类命令是"假成功"的**：`send-message` / `start-agent` / `stop-agent` / `restart-agent` / `destroy-agent` 服务端**全部没有 ack**，而前端 `emitControl()` 只保证"发出去了"就返回 `ok:true`；服务端为此专门发的四类失败帧（`start-agent-failed` / `destroy-agent-failed` / `agent-channel-rejected` / `agent-channel-taken-over`）在 `web/src` 里**一个监听都没有**。用户在对话流里看到"我：砍个木头"，bot 从未收到——这条假象还会被当成排障依据。
2. **断线时面板不失效 agent 列表**：`disconnect` 只清 `store.states`，不清 `store.agents`。于是 mindserver 挂掉期间，状态卡仍显示"在线"（`in_game` 是旧值）、血条为 0、输入框可用；用户敲的那句话在 `say()` 失败后**被无条件清空**（`ChatStream.vue:9-14`），没有任何提示。
3. **`stores/diag.ts` 的 `ack()` 绕过了离线闸**——这是 WEB-001 的**同源残留**：agents.ts / terrain 都改走"没连接就不发"，diag 仍裸 `socket.emit`。socket.io 会把断线期间的事件塞进 `sendBuffer`（已在依赖源码里核实），重连瞬间集中执行；其中 `clear-events` 是**破坏性**的（清 agent 的事件环形缓冲），而界面 16 秒后只会说"超时"。
4. **设置页的 `allow_insecure_coding` 永远存不下去**：二次确认一旦"同意"，`confirmInsecure` 被复位却没有触发保存；再点保存又满足"从 false 打开且未确认"的条件 → **确认弹窗无限循环**。这是一个安全开关的功能死路，且界面不报错。
5. **`SetupView` 有三处未捕获的 `Promise` rejection**（`loadProfiles` / `refreshServer` / `srvAction`），断线时 `request()` 立即以 `OFFLINE` 拒绝 → 控制台未处理拒绝、页面**零提示**：新建 agent 的 profile 列表永远空着、"启动服务"点了没反应、`loadSettings` 用裸 emit 无超时 → 点「设置」永远空白。
6. **`IdentityPanel` 不跟随 agent 切换**：只在 `onMounted` 拉一次。切到 B 后左栏仍是 A 的绑定人/A 的模式，"解绑"会把 A 的行发给 B（`removed: 0`，界面看起来"成功"）。这是 WEB-006 在身份面板上的同源缺口。
7. **按需 relay 全部挂在 `listen-to-agents` 上**：`request-terrain` / `get-events` / `clear-events` / `get-task-state` / `get-memory` 的处理器只在 `addListener()` 里注册。而这个事件被限流（10 次/60s，桶按**远端地址** = 本机所有面板共享）。被拒后前端仍显示"已连接"，但状态不再推送、地形 31 秒超时、诊断 8–16 秒超时，且**没有任何"订阅失败"判据**。
8. **没有"数据新鲜度"概念**：服务端 agent 5 秒不回就**沿用上一帧**（且明确"超时不发 error"），前端没有任何 `lastUpdate` 标记 → 卡死的 bot 会长期显示"健康、坐标正常"。`store.lastError` 写入后只在**重连**时清除，错误横幅可以挂一整天。
9. **聊天/输出只在内存、断线不重放、刷新即失**：`MAX_CHAT/MAX_OUTPUT=500`，断线窗口内产生的输出**永久丢失**，刷新页面全清。两个视图还共用同一份 500 条缓冲（`bot-output` 同时进 `chat` 与 `output`）。
10. **高危操作没有二次确认**：`destroy-agent`（删除）与 `server-stop`（优雅停服）都是**一击即发**；`start-agent` 连点会重复下发（服务端 6 次/60s 才拦，拦了也不回话）。没有路由守卫（可接受，门在服务端），但**页内也没有任何确认层**。
11. **token 面是干净的，但失效路径没有出口**：前端 0 处 `localStorage/sessionStorage/document.cookie`，也不读 URL；token 只由服务端 `?token=` → HttpOnly cookie 换发。代价是：mindserver 重启换 token 后，socket 无限重连、横幅只说"连不上 mindserver(8080)"，用户拿不到"重新带 token 打开"的指引（这句文案只存在于 config/vault 的 fetch 错误里）。
12. **`--text-dim` 这个 CSS 变量根本不存在**（`tokens.css` 只定义 `--fg-dim`），身份面板 6 处 `color: var(--text-dim)` 全部失效 → 次要文字不降级，信息层级丢失。

**同时确认（不是缺陷）**：XSS 面为零（无 `v-html`/`innerHTML`/`eval`，全部走插值/属性绑定，图标 URL 经 `encodeURIComponent`）；WEB-004/005/008/010 的 three 资源释放修复确实在位，本轮**未发现新的显存泄漏**；`vue-tsc --noEmit` **0 error**——但下面这些问题全部落在类型系统的盲区（事件名、回调缺失、错误分支），类型绿灯不代表行为正确。

---

## P1

### W1 · 控制命令"假成功"：服务端无 ack，四类失败帧前端零监听

| | |
|---|---|
| 位置 | 前端 `web/src/api/socket.ts:92-98`（`emitControl`）、`web/src/stores/agents.ts:158-185`（`say` / `agentAction`）、`web/src/components/ChatStream.vue:9-14`、`web/src/components/QuickCommands.vue:19-21`、`web/src/components/StatusCard.vue:81-84`；后端 `mindserver.js:1661-1691`（`send-message`）、`1608-1624`（`start-agent`）、`1626-1645`（`destroy-agent`）、`1494-1512`（通道接管） |
| 触发输入 | ①bot 已注册但**未进游戏**时发消息；②消息 >2000 字符；③10 秒内发第 31 条；④60 秒内第 4 次重启 / 第 7 次启动 / 第 4 次删除；⑤agent 已被销毁但面板还没刷新 |
| 错误结果 | 服务端这些处理器**都没有 callback 参数**，失败时只 `console.warn` 或 `emit('start-agent-failed'/'destroy-agent-failed')`；前端 `emitControl()` 只做"`socket.connected` 就 `emit`，返回 `{ok:true}`"，**完全不看回执**。`agentAction()` 的返回值在 `StatusCard` 模板里被丢弃（`@click="agentAction('start-agent')"`），`say()` 的返回值在 `ChatStream.send()` 里被丢弃且紧接着 `input.value = ''`。`web/src` 里 `socket.on` 一共只注册了 8 个事件（`connect`/`disconnect`/`connect_error`/`agents-status`/`state-update`/`bot-output`/`chat-message`/`agent-event`），**四类失败帧一个都没接**（`grep -rn "start-agent-failed\|destroy-agent-failed\|agent-channel-" web/src/` 无输出）。<br>更隐蔽的一条：agent 停着时 `agent_connections[agentName]` 仍存在（只是 `socket=null`），`send-message` 走到 `agent_connections[agentName].socket.emit(...)` 抛 `TypeError`，被 `try/catch` 吞成一行 `console.error('Error: ')`（`mindserver.js:1688-1691`）——**服务端自己都不认为这是拒绝**。 |
| 影响 | 聊天、快捷指令、启停、重启、删除——**全部"点了没反应也不知道没反应"**。用户会认为"已经发出去了/已经停了"，而面板把用户消息写进对话流（`pushChat({kind:'me'})`），把假象固化成"证据"。限流（`takeToken`）在 UI 上完全不可见，且因为桶按 `127.0.0.1` 共享，多标签页/本机脚本会**互相**触发限流——用户只会觉得"面板时好时坏"。 |
| 最小修法 | 二选一：①服务端给这五个事件加统一回执（`{ok:false, code:'RATE_LIMITED'\|'NOT_IN_GAME'\|'TOO_LONG'\|'NOT_RUNNING'}`），前端用 `request()`；②不改服务端，则前端必须 `socket.on` 那四类失败帧 + 给 `send-message` 加"未确认"态（`pending/unknown`），并在发送失败时**不清空输入框**。②是纯前端改动，见效最快。 |

### W2 · 断线不清 agent 列表 → "在线"假象 + 用户输入被吞

| | |
|---|---|
| 位置 | `web/src/stores/agents.ts:114-118`（`disconnect` 只清 `states`/`lastError`）、`:24-34`（`store` 字段）、`web/src/App.vue:21-24`（徽标）、`web/src/components/StatusCard.vue:8,42`（在线/离线徽标）、`web/src/components/ChatStream.vue:126-131`（禁用条件只看 `in_game`）、`web/src/stores/terrain.ts:162`（`canLoad = in_game`） |
| 触发输入 | mindserver 进程退出/重启/网络中断，浏览器 socket 进入重连循环（`api/socket.ts:5-11`，`reconnectionDelay` 500–3000ms，**无次数上限**） |
| 错误结果 | `disconnect` 后 `store.agents` **原样保留**，`in_game` 仍是旧值 ⇒ 状态卡徽标继续显示"在线"、对话输入框继续可编辑、地形"加载"按钮仍可点。同时 `store.states` 被清空，血条/饥饿显示 0、群系显示"未知群系" ⇒ **同一个卡片里"在线"和"空数据"并存**。用户敲的这句话：`say()` 走 `emitControl` → `{ok:false, OFFLINE}` → 写 `lastError` → 返回 `false`；`ChatStream.send()` 不检查返回值，**仍然清空输入框**。 |
| 影响 | 断线期间面板给出与事实相反的结论（"她在线，只是没数据"），用户输入被静默丢弃且无法找回；地形页按钮可点，点了才在侧栏看到一行 OFFLINE 文案。这是本轮最典型的"状态机在异常分支上没有收敛"。 |
| 最小修法 | 断线时把 agent 列表标记为失效（`staleAt`/`stale=true`）而不是保留 `in_game`；所有写操作统一按 `connected && in_game` 判定；`send()` 只在 `say()` 返回 `true` 时清空输入，失败时保留文本并给出原因。 |

### W3 · `diag.ack()` 绕过离线闸：断线期间的破坏性命令会进 `sendBuffer`，重连后集中执行

| | |
|---|---|
| 位置 | `web/src/stores/diag.ts:108-121`（`ack()` 裸 `socket.emit`）；调用点 `:124-148`（`pullEvents`）、`:150-156`（`clearEvents`）、`:158-171`（`fetchTaskState`）、`:173-186`（`fetchMemory`）；触发点 `web/src/views/DebugView.vue:41-50,77` |
| 触发输入 | 断线（`socket.connected === false`）时点「清空」/「补拉」，或打开 `/debug`（`onMounted` 自动 `pullEvents()+fetchTaskState()`） |
| 错误结果 | 代码与 WEB-001 修复前的形态**逐字同源**：`emit` 时未连接 ⇒ socket.io-client 把事件推进 `sendBuffer`（`web/node_modules/socket.io-client/build/esm/socket.js:266-272`，已核实）；16 秒后 `ack()` 的定时器把 Promise resolve 成 `{ok:false, reason:'超时'}`。`clearEvents()` **不看这个结果**，照样 `diag.events = []` + `cursors.set(name,0)`。重连瞬间 `emitBuffered` 把排队的 `clear-events` 真发出去 → **agent 的事件环形缓冲被清空**（8 秒后 relay 才回 ack，而前端已经不再关心）。`pullEvents` 也会带着断线前的游标迟到执行。<br>对比：`agents.ts:158-166`（`say`）、`:172-185`（`agentAction`）、`:284-288`（地形）都已经加了"没连接就不发"，`diag.ts` 是**漏网的那一处**。 |
| 影响 | 与 WEB-001 完全同形的"界面说失败、服务端却执行"：用户以为"清空没成功（报超时）"，结果重连后事件真的没了；诊断证据在**没有任何提示**的情况下被销毁。这是本轮唯一一条"破坏性命令在错误时刻执行"的 P1。 |
| 最小修法 | `ack()` 开头加与 `emitControl` 相同的判据：`if (!socket.connected) return Promise.resolve({ok:false, reason:'OFFLINE'})`；`clearEvents()` 检查 `r.ok` 再清本地；`pullEvents()` 在断线时直接返回。更彻底的做法是把 `ack()` 换成 `api/socket.ts` 的 `request()`（它已经有离线判据 + 统一错误分类）。 |

---

## P2

### W4 · 设置页 `allow_insecure_coding` 永远无法保存（二次确认死循环）

| | |
|---|---|
| 位置 | `web/src/views/SettingsView.vue:87-105`（`save`）、`:165-177`（`toggleInsecure` / `acceptInsecure` / `rejectInsecure`） |
| 触发输入 | 打开设置页 → 打开「允许模型写并执行代码」→ 点「保存运行时设置」 |
| 错误结果 | `save('runtime')` 的闸门是：`form.runtime.allow_insecure_coding === true && saved.runtime.allow_insecure_coding === false && !confirmInsecure` ⇒ 弹确认框并 `return`。`acceptInsecure()` 只做 `form...=true; confirmInsecure=false`，**没有调用 `save()`**。于是用户再点保存时，三个条件**再次全部成立** → 又弹同一个框。循环无出口（推演：弹窗→同意→保存→弹窗→同意→…），`allow_insecure_coding` 一次也写不进 `settings.js`。 |
| 影响 | 安全开关的"开启"在本页**功能死路**；按钮是可用的、也没报错，用户只会得出"保存坏了"或"这个开关没用"的结论（后者更糟——他会去手改 `settings.js`，绕过备份与写后校验）。关掉方向（true→false）不受影响，所以问题只在"想开"的时候出现，正好是最需要留痕的那条路径。 |
| 最小修法 | 让确认与本次提交绑定：`acceptInsecure()` 里保持 `confirmInsecure=true` 直到 `saveGroup` 完成（或直接调 `save('runtime')`），`save()` 的判据改成"本次提交已确认"（如 `confirmedFor='runtime'`），成功后清空。 |

### W5 · `SetupView` 三处未捕获 rejection + 一处无超时裸 emit → 页面永远空白

| | |
|---|---|
| 位置 | `web/src/views/SetupView.vue:61-67`（`loadProfiles`）、`:144-149`（`refreshServer`）、`:151-163`（`srvAction`）、`:181-184`（`onMounted` 的 `void` 调用）、`:12-20`（`loadSettings`） |
| 触发输入 | 断线 / 服务未起 / 回执丢失；或点某个 agent 的「设置」 |
| 错误结果 | `loadProfiles` 与 `refreshServer` 里都是裸 `await request(...)`，**无 try/catch**；`request()` 在未连接时**立即**以 `RequestError('OFFLINE')` 拒绝（`api/socket.ts:63-65`）⇒ `void loadProfiles()` 变成**未处理的 Promise 拒绝**，`profilesErr`/`srv` 都不会被赋值 ⇒ profile 列表区空白、"Paper 服务"徽标恒为"未知"。`srvAction` 是 `try/finally`（**没有 catch**）：点「启动服务」/「优雅停止」在断线时同样未处理拒绝，`srvMsg` 永不赋值 ⇒ 点了完全没反应。`loadSettings` 用裸 `socket.emit('get-settings', name, cb)`：无超时、无离线判据，回调不来就永远停在占位文案"点「设置」读某个 agent 的完整配置"（看起来像没点中）。 |
| 影响 | 配置向导的三个主流程（列出 profile / 新建 agent / 启停 Paper）在异常态下**全部静默**；尤其"新建 Agent"页空白会被理解成"没有可用的 profile"，而不是"没连上"。 |
| 最小修法 | 三处补 `try/catch` 并把错误写进现有错误槽；`loadSettings` 改用 `request()` 或至少加 5–10 秒超时 + 离线判据。 |

### W6 · `IdentityPanel` 不跟随 agent 切换：显示上一个 bot 的绑定/模式，解绑打错对象

| | |
|---|---|
| 位置 | `web/src/components/IdentityPanel.vue:127-131`（只在 `onMounted` `refresh()`）、`:90-100`（`unbind` 用点击时的 `agentName.value`）、`:22-30`（`code`/`bindings`/`mode`/`pending` 都是组件局部状态） |
| 触发输入 | 顶部下拉切到另一个 agent（`App.vue:46-55` → `selectAgent`），ConsoleView **不会重挂** |
| 错误结果 | 面板仍显示 A 的：绑定人数与名单、`mode`（离线/正版验证 + owner 可达性文案）、`pendingCodes` 计数、"已绑定 N 人"。点某行的「解绑」：`unbindIdentity({uuid,name}, agentName.value)` 用的是**切换后的 B**，行数据却是 **A 的** ⇒ 服务端 `revokeBinding` 在 B 的 identity.json 里找不到该玩家 ⇒ 返回 `{ok:true, removed:0}`，界面 `humanize` 不处理 `removed:0`，`refresh()` 后仍显示 A 的旧列表（因为列表没被清）⇒ **用户以为解绑成功**。<br>同理「生成绑定码」是给 B 签的，但左侧 `modeText` 还在描述 A 的服务器模式。 |
| 影响 | 跨对象数据错配 + 破坏性操作（解绑）打到错误对象；与 `diag.ts:99-105`（WEB-006 游标按 agent 分区）、`terrain.ts:150-160`（WEB-007 切 bot 清空）的既有处理**明显不一致**，属于同一族缺陷的漏改点。 |
| 最小修法 | `watch(() => currentAgent.value?.name, ...)`：切人即清空 `code/bindings/mode/pending/err` 并 `refresh()`；`unbind` 里再校验一次"行属于当前 agent"（或把 agentName 存进行数据）。 |

### W7 · 按需 relay 与 `listen-to-agents` 强耦合；订阅被限流后地形/诊断永久超时且无判据

| | |
|---|---|
| 位置 | 后端 `mindserver.js:1922-1928`（`addListener` 里才 `registerMapRelay`）、`:1989-2075`（`request-terrain` / `get-events` / `clear-events` / `get-task-state` / `get-memory` 都注册在这里）、`:1717-1727`（`listen-to-agents` 命中 `takeToken(10/60s)` 后**直接 return，无回执**）、`:403-433`（桶 key = `label@远端地址`）；前端 `web/src/stores/agents.ts:106-112`（只在 `connect` 时 emit 一次）、`api/socket.ts:5-11` |
| 触发输入 | 60 秒内第 11 次连接成功（服务端重启抖动、多标签页、本机脚本共用同一桶），或该 emit 因任何原因丢失 |
| 错误结果 | 这条连接**永远进不了 `agent_listeners`**，于是：`state-update` 不来（状态冻结在最后一帧）、`request-terrain`/`get-events`/`get-task-state`/`get-memory` 的 handler **根本没注册**（不是超时，是没人接）⇒ 前端 31 秒后报"超时(30s)"、DebugView 8–16 秒后报"超时"。而 `socket.connected === true`、徽标显示"mindserver 已连接"，前端**没有任何"订阅失败"的判据**，也不会重试（`connect` 只触发一次）。由于桶按 `127.0.0.1` 共享，同一台机器上**另一个标签页或 `poc/` 脚本**就能把面板挤掉。 |
| 影响 | "连上了但什么都没有"——状态卡不刷新、地形读不出、事件流空，且所有提示都指向"超时/没数据"，把排查引向错误方向（agent 卡了？库坏了？）而不是"订阅被限流"。 |
| 最小修法 | `listen-to-agents` 加 ack（服务端已经知道是否成功）；前端失败时退避重试并把状态显式化（"未订阅：服务端限流，N 秒后重试"）；relay 注册与订阅解耦（`connection` 时就注册，或单独 `subscribe-diag`）。 |

### W8 · 没有数据新鲜度：状态停更不可见，`lastError` 永不自愈

| | |
|---|---|
| 位置 | `web/src/stores/agents.ts:132-135`（每秒整体替换 `states`，无时间戳）、`:109/117/122`（`lastError` 只在 `connect` 清除）、`:61-77`（`sanitizeStates` 写入"状态尚未就绪"）、`web/src/App.vue:62`（横幅无关闭/无级别）；后端 `mindserver.js:1939-1968`（agent 5 秒不回则**沿用 `last_state`**，注释明确"超时不发 error"） |
| 触发输入 | agent 卡在等模型 API / 跑长同步代码；或 bot 不在游戏（该 agent 干脆不出现在 `states` 里） |
| 错误结果 | 前端无法区分"这一帧是 0.2 秒前的"还是"3 分钟前的"：坐标、血量、动作全部照常显示。停更期间没有任何视觉变化，用户据此判断"她站着没动"（实际进程可能已经卡死）。`lastError` 一旦写入（连接错误、地形失败、`sanitizeStates` 的协议提示）就**永久驻留**，除重连外没有任何路径清除——旧的错误横幅会盖住新的错误。 |
| 影响 | "状态卡死"的真正来源不是渲染失败，而是**没有过期概念**：坏消息（过期）不可见，好消息（在线）一直显示。这是运维面板最危险的一类失真。 |
| 最小修法 | 每帧记 `receivedAt`，超过 3–5 秒在状态卡/徽标上标"数据已过期(Ns)"；`lastError` 分级（ephemeral 在任意成功响应/下一帧状态时清除，persistent 才常驻），横幅给关闭按钮。 |

### W9 · 聊天/输出只在内存：断线不重放、刷新即失、两个视图抢同一份缓冲

| | |
|---|---|
| 位置 | `web/src/stores/agents.ts:20-21`（`MAX_CHAT/MAX_OUTPUT=500`）、`:91-99`（push + `splice`）、`:138-148`（`bot-output` 同时进 `output` 与 `chat`）、`:114-118`（断线不补拉）；`web/src/views/DebugView.vue:15`（`output` 复用同一份） |
| 触发输入 | 断线窗口内 bot 继续输出；或刷新页面；或对话超过 500 条 |
| 错误结果 | 服务端 `bot-output` 只有 `io.emit` 广播（`mindserver.js:1694-1704`），**没有为面板缓冲**；断线期间产生的所有输出**永久丢失**，重连也不补拉。刷新页面等于清空全部对话与日志。`splice` 截断后用户往上翻不到更早的内容。且 `bot-output` 的每条消息同时写进 `chat` 和 `output`，两个 500 条上限**互相挤占**：诊断页的"输出日志"和对话页看到的是同一批数据的两个副本，任一视图的容量都被另一视图消耗。 |
| 影响 | 诊断证据在"出问题的那段时间"恰好不可复原（出问题最容易断线/刷新）；排障必须回到 `logs/` 文件，而面板上的时间线与日志文件对不上。 |
| 最小修法 | 服务端给面板一份带 `seq` 的 ring buffer + `get-output(since)`（与 `get-events` 同构）；前端按游标补拉。短期至少把 `output` 与 `chat` 拆成两份独立缓冲，并考虑 `sessionStorage` 兜住刷新。 |

### W10 · 高危操作零确认：`destroy-agent` / `server-stop` 一击即发，`start-agent` 可连点

| | |
|---|---|
| 位置 | `web/src/views/SetupView.vue:198-203`（启动/停止/重启/删除四个按钮）、`:311-312`（启动服务 / 优雅停止）、`web/src/components/StatusCard.vue:81-84`（启动/停止/重启）、`web/src/stores/agents.ts:172-185`（无 in-flight 锁） |
| 触发输入 | 误点「删除」；或误点「优雅停止（RCON）」；或在"启动中"反复点「启动」 |
| 错误结果 | `destroy-agent` 只 `busy=true` 800ms（`SetupView.vue:22-29`，一个 `setTimeout` 假忙状态），**没有确认框**；它虽然不删文件（`mindcraft.js:142-162` 只停进程 + 删注册项），但 agent 会从面板消失、要重新走"新建 Agent"才能回来，而失败时（`destroy-agent-failed`）前端**听不到**，按钮看起来"没生效"。`server-stop` 直接走 RCON 停服，无确认。`start-agent` 连点会重复下发（服务端 6 次/60s 才拦，拦了也不回话——见 W1）；`forceRestart` 的双开保护在服务端，但用户看到的是"点了 5 次，不知道哪次生效"。面板里唯一有二次确认的删除是**凭据条目**（`VaultView.vue:158-169`），说明这套交互在项目里已有先例，只是没推广到 agent/服务器。 |
| 影响 | 不可逆或代价高的操作暴露在单次点击上，且失败不可见——正好是"误操作 + 无法判断结果"的叠加。 |
| 最小修法 | 复用 VaultView 的"两次点击确认"模式（第二次按钮文案变"确认删除？"）；控制按钮加 in-flight 锁（按 agent+动作），直到收到 `agents-status` 变化或超时。 |

### W11 · token 失效没有恢复出口；socket 层错误文案与 HTTP 层不一致

| | |
|---|---|
| 位置 | `web/src/stores/agents.ts:120-123`（`connect_error` → "连不上 mindserver(8080)：..."）、`api/socket.ts:5-11`（无限重连）、`web/src/stores/config.ts:149` 与 `web/src/stores/vault.ts:91`（唯一出现"请用带 ?token= 的地址重新打开"的地方） |
| 触发输入 | mindserver 重启（每次启动生成新 token）、cookie 被清、或从 `localhost` 换到 `127.0.0.1` 打开 |
| 错误结果 | 旧 cookie 失效 ⇒ 握手被 `makeHandshakeGate` 拒绝（`auth_gate.js:118-146`，`err.data.code='AUTH_REQUIRED'`）⇒ 前端只把 `e.message` 拼进横幅："连不上 mindserver(8080)：unauthorized: mindserver 需要握手 token"，然后**每 0.5–3 秒重试一次，永不停止**。页面上没有"重新带 token 打开"的入口，也没有把 `err.data.code` 映射成人话——而 config/vault 的 fetch 路径里**已经有**这句正确文案，两条通道各写各的。<br>附带一条 dev 陷阱：cookie 是 host-only（`auth_gate.js:150` 只设 `Path=/`，无 `Domain`），`localhost:8080` 种下的 cookie 不会发给 `127.0.0.1:5173`；README 里两种主机名混用（`web/README.md` 用 `localhost:5173`，`vite.config.ts:30-40` 注释强调必须 `127.0.0.1:8080`），照 README 走 dev 会得到"代理 200 但 socket 被拒"的假象。 |
| 影响 | token 轮换是**每次重启都会发生**的正常事件，却要求运维凭记忆手工拼 URL；频率高到足以让"面板连不上"变成日常噪声。 |
| 最小修法 | `connect_error` 里判断 `e.data?.code === 'AUTH_REQUIRED'` → 横幅换成"token 已失效：请用 `mindcraft/.mindserver-token` 里的新值重新打开 `http://<host>:<port>/?token=…`"，并停止重连（或退避到 30s）；README/vite 注释统一一种主机名，或给 dev 加 `?token=` 透传说明。 |

---

## P3

### W12 · `--text-dim` 变量不存在：身份面板 6 处次要文字不降级

| | |
|---|---|
| 位置 | `web/src/components/IdentityPanel.vue:196,201,203,208,222,223`；`web/src/styles/tokens.css:1-18`（只定义 `--fg-dim`，无 `--text-dim`） |
| 错误结果 | `grep -rho "var(--[a-z-]*" web/src | sort | uniq -c` 里 `--text-dim` 出现 6 次，而 `tokens.css` 定义了 16 个变量、**没有它**。CSS 自定义属性未定义时 `color: var(--text-dim)` 在计算值阶段失效 ⇒ 继承父级颜色（≈`--fg` 全亮）。`.label`、`.meta`、`.hints`、`.sub`、`.mode-text`、`.switch-hint` 全部失去"次要"层级，身份面板的提示文字和主文本一个亮度。 |
| 修法 | 二选一：把 6 处改成 `--fg-dim`（与其它页面一致），或在 `tokens.css` 补 `--text-dim: #8b949e`。 |

### W13 · 1 Hz 整树重算 + 3D 画布 rAF 常驻（功耗，不是泄漏）

| | |
|---|---|
| 位置 | `web/src/stores/agents.ts:132-135`（每秒整体替换 `states`）、`web/src/views/DebugView.vue:11-13`（`stateJson` 每秒 `JSON.stringify(full_state,null,2)`，即使 panes 用 `v-show` 隐藏也会随组件重渲染求值）、`web/src/components/TerrainCanvas.vue:269-273`（`requestAnimationFrame` 自循环，无 `visibilitychange` 暂停） |
| 错误结果 | 每秒一次全量状态替换 ⇒ 所有依赖 `currentState` 的模板重算；`DebugView` 即使停在"事件流"页，隐藏的 `full_state` pane 仍每秒 stringify 一次完整状态（KB 级）。地形页离开后 canvas 会卸载，但**停留在原地形页时**即使窗口最小化/切到后台仍以 60fps 渲染（`controls.update()` + `renderer.render`）。 |
| 影响 | 笔记本上长期开着面板 = 常态 CPU/GPU 占用；与本轮"资源增长"相关的**泄漏**已修（WEB-004/005/010），剩下的是稳态功耗。 |
| 修法 | `document.visibilitychange` 时停 rAF；`stateJson` 改成按需计算（`v-if` 而非 `v-show`，或在 `tab==='state'` 时才 stringify）；状态帧可加"内容哈希相同则跳过替换"。 |

### W14 · 错误码直出 + 空态误导

| | |
|---|---|
| 位置 | `web/src/views/TerrainView.vue:23-27`（`store.lastError` 直出）、`web/src/stores/agents.ts:304`（`'地形加载失败：' + res.reason`）、`web/src/views/DebugView.vue:98-100,154`（`diag.taskState.reason` 直出）、`web/src/views/ConsoleView.vue:12-21`（断线时仍显示"还没有 agent…检查 settings.js 或去配置页创建一个"） |
| 错误结果 | 用户看到的是 `agent_not_in_game`、`get-task-state timeout`、`Error: state timeout` 这类内部串（`IdentityPanel.humanize()` 已经证明这套翻译是必要的，但只覆盖了 identity 一组）；断线时 ConsoleView 的文案把"连不上"说成"没有 agent"，直接把人引向配置页去改 `settings.js`。 |
| 修法 | 把 `humanize(reason)` 提取成公共函数覆盖 `agent_not_in_game`/超时/`OFFLINE`；空态按 `connected` 分支：断线 → "未连接到 mindserver（正在重连）"，连上且 0 agent → 现有文案。 |

### W15 · 地形解码异常未捕获：未处理拒绝 + 画面停留旧图且无提示

| | |
|---|---|
| 位置 | `web/src/stores/terrain.ts:96-115`（`new Int32Array(posBytes.buffer, 0, byteLength/4)`、`types[i]` 越界即 `undefined`）、`:136-147`（`loadTerrain` 无 try/catch）、`web/src/views/TerrainView.vue:23-27`（`await loadTerrain()` 同样无 try/catch，只判 `!res`） |
| 错误结果 | `dtype` 与 `pos` 字节数不匹配（非 4/2 的整数倍）时 `new Int32Array` 抛 `RangeError`；`types` 比 `count` 短时 `t[i]=undefined`（静默变成 0=实心，颜色错但看不出来）。抛异常时 `decodeTerrain` 未写 `terrain.decoded`，**旧地图继续留在屏幕上**，`terrain.stats` 不变，`error` 也不赋值 ⇒ 用户看到的是"点了一下，什么都没发生"。 |
| 影响 | 概率低（后端打包是自洽的），但一旦契约漂移，症状是"静默显示错误数据"，比报错更糟。 |
| 修法 | `decodeTerrain` 里对 `byteLength % 4`、`types.length < count` 做显式校验并返回 `{ok:false, reason}`；`loadTerrain`/`load()` 包 try/catch 把异常转成可见错误。 |

### W16 · `isFullState` 校验不完整：契约漂移会重新变成"整卡白"

| | |
|---|---|
| 位置 | `web/src/stores/agents.ts:52-59`（只校验 `gameplay.health` 与 `inventory.counts`）、`web/src/components/StatusCard.vue:61,71`（`s?.action.current`、`s?.nearby.humanPlayers.length`）、`web/src/components/InventoryGrid.vue:56`（`currentState?.inventory.stacksUsed`） |
| 错误结果 | 边界校验只覆盖了状态卡与背包**读到的两个字段**，`action`、`nearby`、`inventory.equipment`、`inventory.stacksUsed` 都没查；而模板里的可选链只保护了**第一层**（`s?.`），`gameplay`/`action`/`nearby` 为 `undefined` 时仍会抛 `TypeError` 并让整个组件渲染失败（Vue 会把它抛到 `app.config.errorHandler`，没有处理器 ⇒ 控制台报错 + 该子树不更新）。当前 `full_state.js:87-122` 总是给全字段，所以这是"契约一漂移就白卡片"的隐患，不是现网故障。 |
| 修法 | 校验清单与消费点对齐（`action`/`nearby`/`inventory.equipment` 至少要是对象），或把模板降到全链可选（`s?.action?.current`、`s?.nearby?.humanPlayers?.length`）。 |

---

## 1. 逐类问题对照（任务书要求项 → 结论）

| 任务书要求 | 结论 |
|---|---|
| 断连/超时/无令牌/接口报错下的真实表现（白屏、静默失败、状态卡死） | **无白屏**（错误边界靠逐层可选链，唯一会整卡抛的是 W16 那类半截载荷）；**静默失败是主要形态**：W1（命令）、W5（配置页）、W11（token）、W14（错误码直出）；**状态卡死** = W2（假在线）+ W8（无新鲜度）。 |
| socket.io 重连与事件重放 | 重连本身正确（`connect` 里重新 `listen-to-agents`，diag 按游标补拉、能识别进程重启）。缺口：W3（断线 emit 进 buffer，破坏性命令迟到执行）、W7（订阅被限流后不重试）、W9（聊天/输出无重放）。 |
| token 存取与泄漏面 | 前端 **0 处** `localStorage/sessionStorage/document.cookie`，不读 URL（`grep` 无命中）；token 只经服务端 `?token=` → HttpOnly cookie。泄漏面不在前端，在"失效后没有恢复出口"（W11）。 |
| `v-html` 一类 XSS 面 | **不存在**：`grep -rn "v-html\|innerHTML\|outerHTML\|insertAdjacentHTML\|document.write" web/src` 无命中；`grep "eval(\|new Function"` 无命中；所有 bot/agent 文本走插值或属性绑定（Vue 转义）；图标 URL 经 `encodeURIComponent`（`InventoryGrid.vue:27-29`）。 |
| 路由守卫是否挡得住 | **没有任何守卫**（`router.ts` 全文 43 行无 `beforeEach`）。但这不是这一层的鉴权：真正的门是服务端 HTTP 中间件 + `io.use`——未带 token 连 `index.html` 都拿不到，所以"守卫挡不住"在本架构下不构成越权。真正缺的是**页内确认层**（W10）与 404 兜底（`/:pathMatch` 全量 redirect 到 `/`，打错的地址会被静默吞掉）。 |
| 长列表与轮询造成的资源增长 | 三处上限都在（chat 500 / output 500 / events 400），`splice` 与 `MAX_EVENTS` 生效；three 资源释放（WEB-004/005/010）在位，**未发现新的显存/监听器泄漏**。剩 W13（1 Hz 重算 + rAF 常驻）与 `socket.acks` 的缓慢增长（未用 `socket.timeout()`，未应答的 ack 回调只在**断开**时由 `_clearAcks()` 清理，见 `socket.io-client/build/esm/socket.js:279-303,447-467`——同一连接内长跑会积累）。 |
| 前后端契约不一致（字段名、错误码、状态机） | 字段名/事件名**基本一致**（逐个事件核对：`agents-status`/`state-update`/`bot-output`/`chat-message`/`agent-event`/`identity-*`/`get-events`/`get-task-state`/`get-memory`/`request-terrain`/`server-*`/`get-profiles`/`get-profile`/`create-agent`/`get-settings`）。不一致集中在**语义**：①控制事件服务端无 ack 而前端当"已确认"（W1）；②`listen-to-agents` 是 relay 的前置条件，前端当"可丢失"（W7）；③服务端"超时沿用上一帧"而前端没有过期语义（W8）；④`destroy-agent` 失败走事件、前端只认"列表变化"（W1/W10）。 |

---

## 2. 与 R5 台账的关系（避免重复计账）

已修且**本轮核实仍在位**（不是缺陷，供 captain 对账）：WEB-001（`emitControl` 离线闸 + `RequestError` 分类）、WEB-002（`sanitizeStates` 边界校验 + 组件可选链，但见 W16 的残留缺口）、WEB-003（IME 组合回车）、WEB-004/005（实例容量扩容 + three 资源 dispose）、WEB-006（事件游标按 agent 分区）、WEB-007（地形归属校验 + 切人清空）、WEB-008（用 `seq` 而非 `length` 驱动滚动）、WEB-009（`create-agent` ack 超时 + 结果未知提示）、WEB-010（实例矩阵后重算包围球）、WEB-011（profile 列表改原生 button）、WEB-012（`allow_insecure_coding` 默认 false）。

R5 已记、本轮**不重复计**：R5-003（`/console` 产物与源码一致性）。本轮只做了一次抽查：`web/dist` 的 mtime（2026-11-09 02:30）晚于全部 `web/src` 文件，且产物里能命中最新源码的标记串（"回到最新"、"已丢弃 … 地形响应"、"请求未发送"、"结果未知"），**未发现新的"产物落后于源码"证据**；但这仍不能证明逐字节一致（仓库不记构建指纹），结论以 R5-003 为准。

---

## 3. 复现/验证方式（均为只读，可逐条重跑）

```bash
# 全部前端监听器清单（对照 W1：失败帧零监听）
grep -rn "socket.on(" web/src/

# W1 的后端依据：这些处理器没有 callback 参数
grep -n "socket.on('send-message'\|socket.on('start-agent'\|socket.on('stop-agent'\|socket.on('restart-agent'\|socket.on('destroy-agent'" mindcraft/src/mindcraft/mindserver.js

# W2：disconnect 只清 states
sed -n '114,118p' web/src/stores/agents.ts

# W3：diag 的裸 emit + socket.io 的缓冲行为
sed -n '108,121p' web/src/stores/diag.ts
sed -n '260,275p' web/node_modules/socket.io-client/build/esm/socket.js

# W4：确认死循环的三个条件
sed -n '87,105p;165,177p' web/src/views/SettingsView.vue

# W6：identity 面板无 watch
grep -n "watch\|onMounted" web/src/components/IdentityPanel.vue

# W7：relay 只在 addListener 里注册
grep -n "registerMapRelay\|diagRelay(" mindcraft/src/mindcraft/mindserver.js

# W12：未定义的 CSS 变量
grep -rho "var(--[a-z-]*" web/src | sort -u | tr '\n' ' '
grep -n "text-dim" web/src/components/IdentityPanel.vue

# 类型检查（0 error，说明上述问题都在类型盲区）
cd web && node ./node_modules/vue-tsc/bin/vue-tsc.js --noEmit; echo $?
```

---

## 4. 未覆盖 / 不能下的结论

1. **没有真机浏览器操作**：所有"界面表现"结论来自源码路径推演 + 依赖实现核对，不是录屏/截图。唯一需要真机确认的是 W7（限流后 `listen-to-agents` 被拒的实际频率）与 W11（cookie 失效后的重连日志形态）。
2. **没有启动 vite dev server**：dev 代理链（5173 → 8080）的 cookie/Origin 行为只做了静态推断（W11 的附带项），未实测。
3. **没有跑构建**：`web/dist` 与源码的一致性按 R5-003 处理，本轮只做"产物是否命中最新标记"的抽查；`vite build` 未重跑（不修改产品代码，也不生成新产物）。
4. **未审计旧控制台** `mindcraft/src/mindcraft/public/`（`index.html` + 内联 onclick）：那不属于 `web/src`，且它正是服务端 CSP 放宽 `script-src 'unsafe-inline'` 的原因。若后续要收 CSP，这是必须先迁走的前置项（属安全席，不在本单范围）。
5. **未评价性能数字**：W13 是"结构性浪费"的判断，没有 profile 数据（未运行应用）。
