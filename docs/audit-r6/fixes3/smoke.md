# R6 fixes3 · 控制面冒烟（8081）— #57 / #66 / #59 / #30 / #33 / #68

- 分支基线：`4057f4c`（工作区仅 `scripts/e2e.ps1` 由并行的 e2e 线改动，与本单无关）
- 执行者：qa-smoke（acceptance-r6b，t2）
- 时间：2026-11-11 23:38–23:56（+08:00）
- 端口：**8081**（避开启动链的 8080；全程未启动 MC 服务器、未连接真 MC 服、未启任何 bot）
- 结论：**4 条 PASS，1 条 PASS（附观察），1 条 FAIL（#57 服务端 ack 仍缺）**

## 0. 方法与隔离（为什么不是 `node main.js`）

任务书写的是 `cd mindcraft && MINDSERVER_PORT=8081 node main.js`。**这一条按字面执行会违规**：
`main.js:88-91` 会对 `settings.profiles` 里每个 profile 调 `createAgent()`，那会 spawn agent 子进程并
尝试连接 `127.0.0.1:25565` —— 而 25565 此刻正被并行的「启动链」线占用，等于跨线干扰，也违反「不连真 MC 服」。

所以用**等价且更轻**的方式起同一个控制面：只调 `Mindcraft.init(false, 8081, false)`，不进入 `createAgent`。

```
# 启动（隔离三件套：bots 根 / 保管库 / 面板 token 全部指到 tmp）
cd mindcraft/tmp/smoke-r6
MINDSERVER_PORT=8081 \
MINDSERVER_TOKEN=2ab6a47a-ff94-4233-8a1d-1842c527d3c2 \
MC_BOTS_ROOT=./bots MC_VAULT_DB=./vault.sqlite \
node serve-8081.mjs
```

- `serve-8081.mjs`（非产品代码，见 evidence）：`Mindcraft.init()` + 用导出的
  `registerAgent()` / `issueAgentToken()` 造两个**没有进程**的假 agent（`smokeA` / `smokeB`，
  任务书允许「能造两个假 agent 名字即可」），并为 `smokeB` 注入一个「拒绝退出」的假
  `AgentProcess`（`Mindcraft.__test.set`，该钩子的注释明确写着「仅测试用」）以触发 `destroy-agent-failed`。
  **全程 0 个子进程**（已核对进程表：只有 1 个 `node serve-8081.mjs`）。
- `MC_BOTS_ROOT=./bots` ⇒ 任务板库落在 `tmp/.../bots/_board`，**不碰**生产 `mindcraft/bots/_board`
  （`board_server.js` 有 5 秒扫描器，跑生产库会动真实租约 ⇒ 必须隔离）。
- `MC_VAULT_DB=./vault.sqlite` ⇒ `/unlock` 测在一个**一次性保管库**上，不碰生产 keys。
- 唯一有生产副作用的一条是 **#59**（任务书明确要求）：`PUT /api/config/runtime` 会改写
  `mindcraft/settings.js`。测完已改回，**字节级复原**（sha256 与测试前一致，已断言）；
  期间产生的两个 `settings.js.bak-2026111123445471x-00x` 备份文件已删除。

### 证据文件（`docs/audit-r6/fixes3/evidence/`）

| 文件 | 内容 |
|---|---|
| `smoke-8081-mindserver.log` | 8081 控制面**完整** stdout/stderr（含所有拒绝/限流/帧日志） |
| `smoke-probe1.json` | 第一段探针 27 项结构化结果（请求 + 原始响应 + PASS/FAIL） |
| `smoke-probe2.json` | 第二段探针 9 项（#68 修正后 + #30 并发观察） |
| `serve-8081.mjs` / `probe.mjs` / `probe2.mjs` | 可复跑的启动器与探针源码 |

复跑：

```
cd mindcraft/tmp/smoke-r6
node serve-8081.mjs &          # 见上面 env
node probe.mjs && node probe2.mjs
```

> 注：`probe.mjs` 里 #68 的 `args` 一开始写成 `{}`，被服务端正确拒绝
> （`参数不合格：参数要写成 key=value：{}`）—— 那是**探针写错了**，不是产品缺陷；
> 按要求格式 `block=oak_log count=1` 重测后全部通过（见 §6）。#30 的并发闸同样在 `probe2.mjs` 里重测。

---

## 1. 总表

| 条目 | 判定 | 一句话 |
|---|---|---|
| **#57** 控制命令 ack 形状 | **FAIL** | 5 个控制事件**全部不回 ack**；四类失败帧**都真的会发**（4/4 PASS）；另实测 `send-message` 在目标 socket 为空时**内部抛 TypeError 被吞** |
| **#66** 错 token 握手 | PASS | 错 token/无 token 都是 `connect_error.code === 'AUTH_REQUIRED'`；无重连风暴（4s 内 1 次） |
| **#59** 配置二次确认 | PASS | 不带 `confirm:true` → `409 CONFIG_CONFIRM_REQUIRED` 且**不写盘**；带上 → 200 且写盘；已复原 |
| **#30** `/unlock` 限流 | PASS | 连打第 6 次错口令 → `429 VAULT_TOO_MANY_ATTEMPTS`；被限流后**正确口令仍 200**（不排队/不锁死） |
| **#33** 限流按 agent 分桶 | PASS | `smokeA` 打满 20/60s 后 `smokeB` 一次照常成功；日志点名 `主体 agent:smokeA` |
| **#68** 任务板 socket API | PASS | `board:add` / `list` / `list(openOnly)` / `set-state(cancelled)` / limit 越界拒绝 全部按契约 |

---

## 2. #57 控制命令的 ack 形状 —— **FAIL**

`web/src` 侧已按「服务端不回执」做了降级（"已发出但结果未知"），并把服务端需求写在
`docs/audit-r6/fixes2/web.md` §9-1（交 fix-control）。本单**真机复测该需求是否已落地**：**没有**。

### 2.1 五个控制事件：ack 全缺

| 事件 | 请求（原文） | 实际响应 | 判定 |
|---|---|---|---|
| `send-message` | `emit('send-message','smokeA',{from:'panel',message:'smoke-test'}, cb)`，等 1.2s | **1.2s 无 ack**（`{acked:false,ms:1213}`） | FAIL |
| `start-agent` | `emit('start-agent','smokeA', cb)` | **无 ack**（`ms:1206`）；但失败帧已发（见 2.2） | FAIL |
| `stop-agent` | `emit('stop-agent','smokeA', cb)` | **无 ack**（`ms:1211`） | FAIL |
| `restart-agent` | `emit('restart-agent','smokeA', cb)` | **无 ack**（`ms:1209`） | FAIL |
| `destroy-agent` | `emit('destroy-agent','smokeB', cb)` | **无 ack**（`ms:1213`）；但失败帧已发 | FAIL |

**根因（代码位置）**：这五个 handler 的签名里根本没有 ack 参数 —— socket.io 的 ack 是「最后一个参数是函数」，
签名少一个位置就永远拿不到回调：

- `src/mindcraft/mindserver.js:2140` `socket.on('send-message', (agentName, data) => {`
- `src/mindcraft/mindserver.js:2012` `socket.on('start-agent', async (agentName) => {`
- `src/mindcraft/mindserver.js:1998` `socket.on('stop-agent', (agentName) => {`
- `src/mindcraft/mindserver.js:1976` `socket.on('restart-agent', (agentName) => {`
- `src/mindcraft/mindserver.js:2032` `socket.on('destroy-agent', async (agentName) => {`

对比：同文件里 `create-agent`（`:1673`）、`shutdown`（`:2090`）、`identity-*`、`server-*`、`get-settings`
**都有** ack（`ack(...)` / `cb(...)`），说明只是这五个漏了，不是架构问题。
`takeToken()` 失败时也只是 `return`（`start-agent` 的限流分支 `:2016-2019` 只打 warn 然后 return），
面板拿不到 `RATE_LIMITED`。

### 2.2 四类失败帧：**都真的会发**（PASS 部分）

| 帧 | 触发方式（原文） | 实际收到 | 判定 |
|---|---|---|---|
| `start-agent-failed` | 面板 `emit('start-agent','smokeA')`（无进程） | `{"agent":"smokeA","reason":"not-found"}` + 日志 `[mindserver] start-agent 未生效（not-found）：smokeA` | PASS |
| `destroy-agent-failed` | 面板 `emit('destroy-agent','smokeB')`（假进程拒绝退出） | `{"agent":"smokeB","reason":"smoke-fake-refuses-to-die"}` + 日志 `[destroy] smokeB 未确认退出…**保留注册表条目**` | PASS |
| `agent-channel-rejected` | 面板连接 `emit('login-agent','smokeA')` | `{"agent":"smokeA","reason":"identity-required"}` | PASS |
| `agent-channel-taken-over` | 两条不同 socket 都用 `smokeA` 的 agent 凭据 `login-agent('smokeA')` | 旧连接收到 `{"agent":"smokeA"}`，随后被服务端断开（日志：`agent 通道接管：smokeA 旧连接 socket=… → 新连接 socket=…（takeover-live）—— 旧连接已摘除`） | PASS |
| 附加 · `control-denied` | agent 凭据连接 `emit('stop-agent','smokeB')` | `{"event":"stop-agent","reason":"panel_only","role":"agent"}` | PASS |

> 说明：`destroy-agent-failed` 这条需要一个「拒绝退出」的 `AgentProcess`。为了不 spawn 真进程，
> 用产品代码自带的测试钩子 `Mindcraft.__test.set()` 注入了一个假对象（见 `serve-8081.mjs`）。
> 它验的是**服务端在 `destroyAgent` 返回 `ok:false` 时会不会发帧** —— 这一点结论有效。

### 2.3 附带发现（真机抓到，报告 W1 同源，仍未修）

`send-message` 在目标 agent 的 `socket` 为空（agent 注册了但没 `in_game`/没 `login-agent`）时：

```
# 请求
emit('send-message','smokeA',{from:'panel',message:'smoke-test'})
# 服务端 stderr（smoke-8081-mindserver.log:41-46）
Error:  TypeError: Cannot read properties of null (reading 'emit')
    at Socket.<anonymous> (file:///…/mindcraft/src/mindcraft/mindserver.js:2170:50)
```

- 位置：`src/mindcraft/mindserver.js:2170` → `agent_connections[sendTo].socket.emit('send-message', data);`
- 外面只有一个 `try { … } catch (error) { console.error('Error: ', error); }` ⇒ **既没有 ack，也没有失败帧**，
  面板只能等 15s 超时降级成"结果未知"。这正是 `fixes2/web.md` §9-1 第 1 条点名要一起改的地方。
- 复现：`node serve-8081.mjs` 后 `node probe.mjs`（第一段 #57-1），日志第 41-46 行。

**给 fix-control 的最小改法**（与 `web.md` §9-1 一致，本单不改产品代码）：
给这五个 handler 补 `(…, callback)` 与统一回执
`callback({ok:false, code:'RATE_LIMITED'|'NOT_IN_GAME'|'TOO_LONG'|'NOT_RUNNING'|'ALREADY_RUNNING'})`，
并把 `:2170` 的 `socket == null` 显式转成 `{ok:false, code:'NOT_IN_GAME'}`。

---

## 3. #66 错 token 握手 —— PASS

| # | 请求（原文） | 实际响应 | 判定 |
|---|---|---|---|
| a | `GET http://127.0.0.1:8081/api/config`（无 token） | `401` | PASS |
| b | `GET /api/config?token=<panel>` | `200` | PASS |
| c | socket.io `auth:{token:'wrong-token-0000'}` | `connect_error`：`{"message":"unauthorized: mindserver 需要握手 token","code":"AUTH_REQUIRED"}` | PASS |
| d | socket.io 连握手 auth 都不带 | 同上 `AUTH_REQUIRED` | PASS |
| e | 错 token + `reconnection:true, reconnectionDelay:200ms`，观察 4s | `connectErrorCount = 1`，`code=AUTH_REQUIRED` | PASS |
| f | 同上但用默认 transports（polling→ws） | `connectErrorCount = 1` | PASS |

- 码的来源：`src/mindcraft/auth_gate.js:227` `err.data = { code: 'AUTH_REQUIRED' };`（`next(err)` → 客户端 `connect_error`）。
- 服务端对每次拒绝只打一行 `[mindserver] 拒绝未握手的连接 host=… origin=null（缺 token 或 token 不对…）`（日志 36/37/38/71 行），
  **不排队、不缓存失败连接、不自己重试** ⇒ 不会无限重连。实测客户端在 `AUTH_REQUIRED` 后自己也停了（1 次）。
- 出厂前端的额外闸：`web/src/stores/agents.ts:280-284` 判 `AUTH_REQUIRED` → `pauseReconnect()`；
  产物 `mindcraft/web-dist/assets/index-*.js` 内确实含该码（`grep -l AUTH_REQUIRED web-dist`）。
- 遗留（非缺陷，已在 `web.md` §7.2 自陈）：`AUTH_BAD_TOKEN` 分支是防御性的，服务端只发 `AUTH_REQUIRED`。

---

## 4. #59 配置二次确认 —— PASS

| # | 请求（原文） | 实际响应 | 判定 |
|---|---|---|---|
| a | `PUT /api/config/runtime {"allow_insecure_coding":true}` | `409` `{"error":"CONFIG_CONFIRM_REQUIRED","message":"allow_insecure_coding 是\"允许模型在本机写并执行代码（= 本机 root）\"。开启它需要二次确认：请在同一个请求体里加 \"confirm\": true 再提交一次。"}`；**settings.js 的 sha256 与请求前完全一致** | PASS |
| b | `PUT /api/config/runtime {"allow_insecure_coding":true,"confirm":true}` | `200` `{"ok":true,"group":"runtime","applied":{"allow_insecure_coding":true},"backup":"…settings.js.bak-…-001","values":{…,"allow_insecure_coding":true,…}}`；sha256 改变 | PASS |
| c | `PUT /api/config/runtime {"allow_insecure_coding":false}`（复原） | `200` `…"allow_insecure_coding":false…`；**sha256 回到测试前的值** | PASS |

- "不写盘"是**字节级**证据（测前/测后 sha256 相等），不是"看 status 猜"。
- 复原后 `git status --porcelain` 里 `mindcraft/settings.js` **无改动**；测试产生的两个
  `settings.js.bak-*` 已删除（`backupThenWrite` 的备份，见 `config_center.js:363-383`）。
- 服务端留痕正确：`[config] ⚠ allow_insecure_coding 已从 false 改为 true …`（日志 66 行）。

---

## 5. #30 `/unlock` 限流 —— PASS（含一条观察）

隔离保管库先 `POST /api/vault/init {passphrase:'smoke-pass-1234'}` → `201 {"ok":true,"unlocked":true}`。

| # | 请求（原文） | 实际响应 | 判定 |
|---|---|---|---|
| a | `POST /api/vault/unlock {passphrase:'wrong-pass-000N'}` 顺序 6 次 | `401`×5（`VAULT_BAD_PASSPHRASE`，59-70ms），第 6 次 `429 {"error":"VAULT_TOO_MANY_ATTEMPTS","message":"口令错误次数过多，请等 60 秒后再试（提示：正确口令任何时候都可用，限流只影响错误尝试）"}` | PASS |
| b | 紧接着 `POST /api/vault/unlock {passphrase:'smoke-pass-1234'}`（正确） | `200 {"ok":true,"injected":0}`（59ms） | PASS |
| c | 6 次**并发**错口令 | 5×`401` + 第 6 个 `429 VAULT_TOO_MANY_ATTEMPTS`；耗时单调递增 80/122/176/277/349/417ms ⇒ **串行化、无排队堆积** | 观察 |

- 口径与实现一致：`mindserver.js:713-753` 先校验口令、再用限流决定「失败回 401 还是 429」，
  所以正确口令永不被额度否决（`unlock_limiter.js` 顶部注释的两条铁律）。
- 日志：`[vault] 来源 127.0.0.1 连续第 6 次口令错误，已限流 60 秒（正确口令仍可解锁）`。

### 观察（非本单验收项，供后续决定是否要动）

**`#30` 新加的 scrypt 并发闸（`mindserver.js:656` `createConcurrencyGate({max:2})`，路由在 `:756`）
在 HTTP 层不可触发**：口令派生用的是**同步** `scryptSync`（`secrets_vault.js:234`），
它阻塞整个事件循环 ⇒ 同一进程里"同时在算"的解锁永远 ≤ 1，`max=2` 的闸永远打不到，
`429 VAULT_BUSY` 在真机上一次也没出现（6 并发实测）。

后果两面看：
- 好消息：并发请求被**串行化**（上表耗时单调递增），所以报告 #30 说的"持 token 者并发打满 CPU"实际不成立；
- 坏消息：那道闸在真机上是**死代码**，它的语义只在离线单测里成立
  （`tools/control_plane_r6_unit.mjs:32-55` 的 A1/A1b/A1c/A1d/A1e 用手工 `tryEnter()` 断言）。
  另外串行化的代价是**延迟随并发线性增长**（6 个并发 ≈ 417ms），且每次错误尝试都要付一次 scrypt。

建议（不阻塞验收）：要么把闸的注释改成"仅在 KDF 异步化后才生效"，要么把 `scryptSync` 换成
`crypto.scrypt`（异步）—— 后者才会让闸真正有意义。本单只记录，不改代码。

---

## 6. #33 限流按 agent 分桶 —— PASS

```
# smokeA（agent 凭据连接，login-agent 成功）连打 get-settings 21 次（配额 20 次/60s）
# → 前 20 次都拿到 settings，第 21 次 {"error":"rate_limited"}
# 随后 smokeB（另一条 agent 凭据连接）打 1 次
# → {"settings":{"profile":{"name":"smokeB","model":"smoke","api":"smoke"}}}   ← 完全没被 smokeA 的额度影响
```

| 观测点 | 值 |
|---|---|
| smokeA `okCount` | **20** |
| smokeA 第 21 次 | `{"error":"rate_limited"}` |
| smokeB 第 1 次 | `{"settings":{…}}`（不是 `rate_limited`） |
| 服务端日志 | `[mindserver] 拒绝 get-settings：触发限流（20 次/60000ms，主体 agent:smokeA，来源 127.0.0.1）` |

- 桶键 = `label@主体@来源地址`（`mindserver.js:539-556` `rateSubjectOf` + `rateBucketKeyOf`），
  主体 `agent:smokeA` / `agent:smokeB`。**同一台机、同一来源地址 127.0.0.1** —— 只有主体不同，
  所以这一次对照直接证明"分桶不是按地址"（正是 #33 的病灶）。
- 日志里的桶名（`主体 agent:smokeA`）是直接从服务端拒绝行读出来的，不是探针自述。

---

## 7. #68 任务板 socket API —— PASS

面板连接（`role=panel`，控制层）逐条打，全部按 `board_server.js` 的 ack 契约：

| # | 请求（原文） | 实际响应 | 判定 |
|---|---|---|---|
| a | `emit('board:add',{skill:'collect',args:'block=oak_log count=1'},cb)` | `{"ok":true,"id":"j_20261111_0001_rq5","job":{…,"state":"ready","args":{"count":1,"radius":48,"block":"oak_log"},…}}`（7ms） | PASS |
| b | `emit('board:list',{scope:'all',limit:50},cb)` | `{"ok":true,"jobs":[{…id:'j_20261111_0001_rq5'…}]}`（count=1，含新单） | PASS |
| c | `emit('board:list',{scope:'all',openOnly:true,limit:50},cb)` | `count=1`，含新单（未终结 ⇒ 正确） | PASS |
| d | `emit('board:set-state',{id:'j_20261111_0001_rq5',state:'cancelled',bot:'smokeA'},cb)` | `{"ok":true,"job":{…,"state":"cancelled","updatedAt":…}}`（6ms） | PASS |
| e | `emit('board:list',{scope:'all',limit:50},cb)` | 该单 `state:"cancelled"` | PASS |
| f | `emit('board:list',{scope:'all',openOnly:true,limit:50},cb)` | `count=0`（终态单已不在 openOnly 里） | PASS |
| g | `emit('board:list',{scope:'all',limit:9999},cb)` | `{"ok":false,"code":"TOO_MUCH","reason":"limit 必须是 1..500 的整数（收到 9999）"}` | PASS |
| 附加 | `emit('board:add',{skill:'__no_such_skill__',args:'{}'},cb)` | `{"ok":false,"reason":"skill「__no_such_skill__」不在注册表里（可用：collect follow pickup platform escape craft smelt store fetch eat mine farm fight build shelter obtain tool_tier first_night）"}` | PASS（拒绝且列可用技能） |

- 使用约束（**不是缺陷**，探针一开始踩到了）：`args` 必须是 `key=value` 串，不是 JSON 对象 ——
  给 `{}` 会得到 `参数不合格：参数要写成 key=value：{}`（`composite_registry.js:325-338`）。
  `collect` 的必填参数是 `block`（`flow_collect.js:27-31`）。
- 本条只验 **socket 层**（任务书要求"不用浏览器"）。前端入口（`web/src/views/BoardView.vue`、路由 `/board`）
  属 fix-web 的范围，本单未开浏览器验证。

---

## 8. 环境收尾（硬要求的核对）

| 要求 | 结果 |
|---|---|
| 不开真 MC 服 | 全程未启动/未连接 25565；`serve-8081.mjs` 不进 `createAgent`，**0 个 agent 子进程** |
| 不修改产品代码 | `git status --porcelain` 只有 ` M scripts/e2e.ps1`（并行 e2e 线的）与新目录 `docs/audit-r6/fixes3/`；`mindcraft/settings.js` 无改动（#59 已字节级复原） |
| 杀掉自己起的 node | `node serve-8081.mjs`（PID 27980）已终止；`Get-Process -Id 27980` → 不存在 |
| 确认 8081 释放 | `netstat -ano | grep :8081` → **无输出** |
| 一次性产物清理 | `mindcraft/settings.js.bak-2026111123445471x-00x` 已删；探针/隔离库留在 `mindcraft/tmp/smoke-r6/`（tmp 下，非产品路径） |

---

## 9. 给后续的单（按优先级）

1. **#57 服务端 ack（阻塞前端体验，仍未闭环）** — 五个控制事件补 ack + 统一 code；
   顺手把 `mindserver.js:2170` 的 `socket == null` 从"抛 TypeError 被吞"改成显式 `NOT_IN_GAME`。
   验收口径建议：`emit(..., cb)` 在正常/限流/目标不在游戏三种情况下**都在 1s 内**收到回执。
2. **#30 并发闸的死代码问题（建议，不阻塞）** — 注释写明"仅 KDF 异步化后生效"，或把 `scryptSync` 改异步。
   当前结论：CPU 有串行化兜底，DoS 不成立；但不该留一道真机上永不触发的闸让人以为有保护。
3. **#57 的失败帧已有服务端支持**，前端监听也已在位；ack 一补，前端 `emitControl() → request()`
   就能把"已发出"升级成"确认送达"。
