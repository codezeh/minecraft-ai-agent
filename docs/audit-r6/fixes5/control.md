# P1-1 / P2-5 / P2-6：控制面三条安全缺陷 —— 修复记录

> 轮次：R6 fixes5（2026-11-13） · 文件域：控制面（`mindserver.js` / `auth_gate.js` / `mindcraft.js`）
> 代码：`mindcraft/src/mindcraft/mindserver.js`、`mindcraft/src/mindcraft/auth_gate.js`、`mindcraft/src/mindcraft/mindcraft.js`
> 测试：`mindcraft/tools/sec_review_unit.mjs`（新增，47 项）；回归 `mindserver_gate_unit`(49) /
> `control_plane_guard_unit`(73) / `sec001_cookie_unit`(63) / `control_plane_r6_unit`(53)
> 证据：本目录 `evidence/green-0-baseline.txt`、`red-1-p1-1-no-panel-gate.txt`、
> `red-2-p2-5-no-revoke.txt`、`red-3-p2-6-no-profile-gate.txt`、`red-4-default-closure-ref.txt`、
> `green-1-after-restore.txt`（含 `npm run gate` 全文）

三条都是**收窄权限**，共同点是"失败形态静默"：把判据删掉，代码照跑、门禁照绿。
所以每条都配一个**行为**断言（不是读源码猜），并且真的把判据删掉跑过一遍，红了才收工。

---

## 1. P1-1（必须修）：`send-message` 无面板门 + 原样转发 `from` ⇒ agent 凭据可冒充 owner

### 1.1 缺陷

`mindserver.js` 的 `send-message` 原来有两件事同时成立：

1. **没有 `requirePanel`**（同文件里 `stop-all-agents` / `destroy-agent` / `set-agent-settings`
   早就加了，这条漏了）；
2. 只校验 `data.from` 是"1~32 字符串"，随后 `target.socket.emit('send-message', data)` —— **原样**转发。

目标 bot 侧（`mindserver_proxy.js:133`）拿这个 `from` 直接当"谁在说话"：

```js
this.socket.on('send-message', (data) => { this.agent.respondFunc(data.from, data.message); });
```

`respondFunc → handleMessage` 里 `perm.author = source`，**命令等级就按它算**（`agent.js:692` 起）。
于是：任一持**有效 agent 凭据**的连接（= 每个 bot 子进程、任何拿到 `.mindserver-token` 之外那份
agent token 的进程）发一条 `{from:'<在线 owner 名字>', message:'!newCommand…'}`，
就能让目标 bot 以 owner 级权限执行。

### 1.2 修复

- `send-message` **只接受面板角色**：非面板一律 `PANEL_ONLY`（回执里也带 `code`，并把
  `control-denied{reason:'panel_only',role}` 发给该连接，运维看得见"谁在试"）。
- 投出去的载荷改成**服务端白名单拷贝** `{ from, message }`：调用方的 `internal` / `permission` /
  `task_id` 这类"自述字段"不再原样进 bot 的处理器（也顺手挡掉未来在 `data` 上加字段的隐患）。
- `message` 收紧成"1~2000 字符串"（原来只对字符串长度上限设防，`undefined` 会被塞进 `respondFunc`）。
- 判定抽成模块级 `deliverSendMessage(socket, agentName, data, ack, deps)` ——
  **唯一的理由是能被离线单测直接驱动**；判据本身仍只有 `requirePanelRole` 一处
  （`requirePanel` 那族在连接闭包里，无法离线驱动）。

### 1.3 "那 bot 之间怎么通信？"——不新开 `agent-relay`

审查建议"若确实需要 bot 间通信，另开受限事件、发送者由服务端填"。**本仓已经有这条路，不需要再开**：

`socket.on('chat-message')`（`mindserver.js`，R6 #26 已加 agent 身份校验）——
发送者来自服务端状态 `curAgentName`（由 `claimAgentChannel` 在凭据归属校验通过后绑定），
**完全不读 payload 里的 `from`**；目标过 `knownAgent`；`message` 有形状与 2000 字符上限。
agent 侧收到后走 `convoManager.receiveFromBot()` ⇒ `from_other_bot=true` ⇒ **只能聊天、不能执行命令**。

即：`send-message` 的语义本来就是"面板替玩家说一句话"（`web/src/stores/agents.ts` 发
`from:'ADMIN'`），`chat-message` 才是 bot↔bot。再开一个 `agent-relay` 只会让"投递一次消息"
出现第二个 owner —— 本仓已在多处收口过同类重复（见 anti-entropy 口径），故不开。

**诚实边界（措辞很重要，别写成"面板能冒充玩家"）**：面板凭据就是 `.mindserver-token` 里的那一条，
**同机同用户**的进程本来就能读到它。所以准确的说法是"**同机同用户的人本来就能拿到面板凭据、
自己直接操作控制面**"——这是既有权限模型（同一 OS 用户不是安全边界）的问题，
**不是**这里有一条绕过鉴权的通路（那会让人以为本次修的口子还开着）。
`auth_gate.js` 顶部早已写清同一件事。本次修的是另一件事：
**另一份**凭据（agent）被用来提升成 owner —— 那一份现在过不去了（A1/A2 用例钉住）。

---

## 2. P2-5（应修）：销毁 bot 后旧 token 仍有效

### 2.1 缺陷

- `auth_gate.js` 只有 `registerCredential` 与 `clearCredentials`（**整体清空**），没有单条撤销；
- `mindcraft.js` 的 `destroyAgent` 在确认子进程退出后**只** `delete agent_processes[name]`。

后果两条：① 旧 token 在 mindserver 存活期间继续能过握手门（可 `login-agent` 抢占同名通道、
可发 `chat-message`）；② 反复 create/destroy 让凭据登记表**只增不减**（实测 5 轮 1 → 6）。

### 2.2 修复

三层，缺一不可：

1. **单条撤销**：`auth_gate.revokeCredential(token)`（定长 `tokenEquals` 比较，幂等）+ `credentialCount()`
   （只为单测断言"不再增长"）。
2. **按名字撤销**：`mindserver` 里 `issueAgentToken()` 现在把 `name → token` 记进 `agentTokens`，
   `revokeAgentTokenByName(name)` 撤凭据并清表项（同名重建会登记新 token，旧的那条从此查不到）。
3. **既有连接一起失效**：`invalidateAgentSocket(socket)` —— 能 `disconnect(true)` 就断，
   断不掉就盖 `socket.data.revoked = true`；`socketRole()` **认这个戳**（返回 `null`），
   于是后续一切管理面事件按"角色未知"拒。`revokeAgentToken(token, sockets)` 只断"出示这份 token"的连接
   （用 `tokenEquals`，别人不受影响）。

接线：`mindcraft.destroyAgent` 在 **确认退出之后** 才调 `revokeAgentTokenByName`；
`not-found` 分支也调（幂等：`createAgent` 失败路径 / 子进程自杀残留都走这里）。
**未确认退出时绝不撤** —— 否则还在跑的那个进程立刻失联，孤儿问题反而更糟（`B5` 用例钉住这条）。

`destroyAgent` 的返回值多带一个 `credential: {revoked, dropped}`，面板/日志能看出来"这次撤了几条、断了几条"。

---

## 3. P2-6（应修）：agent 可读任意 profile

### 3.1 缺陷

`get-profile`（返回 profile **原文 + 解析**）与 `get-profiles`（配置元数据：`api`/`model`/`url`/字节数）
两个入口都**没有**面板角色检查。profile 原文里就是 `api`、`model`、`permissions`（谁是这个 bot 的主人）——
任何持 **agent 凭据** 的连接都能读走全部配置，属于"拿一份低权凭据换管理面数据"。

### 3.2 修复

两个入口都过 `requirePanelRole`（非面板 ⇒ `PANEL_ONLY`，一个字节的 profile 数据都不回），
并同样抽成模块级 `readProfilesList` / `readProfileFile`（理由同 P1-1：离线可驱动）。
原有的边界全部保留：`path.basename` 防目录穿越、列表只回相对名（F-WEB-204）、
不存在的 profile 回 `reason` 而不是抛。

---

## 4. 能红证据（实测，不是推断）

做法：把判据那一行删掉 → 跑 `node tools/sec_review_unit.mjs` → 记录失败 → 还原。全文见本目录 `evidence/`。

| 缺陷 | 删掉什么 | 实测结果（原文见 `evidence/red-*.txt`） |
|---|---|---|
| P1-1 | `deliverSendMessage` 里的面板闸门 `if (!gate(...)) return PANEL_ONLY` | `A1/A1b/A1c/A1d/A6b` 红（6 行 FAIL）；**A2 输出 `[["send-message",{"from":"ServerOwner","message":"!stop"}]]`** —— 伪造的 owner 名真的进了目标 bot |
| P2-5 | `destroyAgent` 里两处 `revokeAgentTokenByName(...)` | 4 行 FAIL：`B4` 红（`credential.revoked=false`，旧 token 仍可认证）、`B4b` 红（登记表 `baseline=1, now=6`）、`B6` 红 |
| P2-6 | `readProfilesList` / `readProfileFile` 的面板闸门 | 2 行 FAIL：`C1` 红（agent 拿到 `ok:true` + 两个 profile 的 `api/model/bytes`）、`C1b` 红（拿到 `raw`，其中 `permissions.owners:["ServerOwner"]`） |
| 回归 A7 | 把默认 `findAgent` 改回闭包变量 `knownAgent` | 1 行 FAIL：`A7 ... knownAgent is not defined` |

附加（第 4 条，不是三条之一，但属于同一族）：`lint:hard` 的 `no-undef` 抓到过一次**真问题** ——
投递判定抽到模块级后，默认 `findAgent` 还指向连接闭包里的 `const knownAgent`。
单测因为注入了 `findAgent` 反而看不到，生产路径上却是 `ReferenceError`。
已修（模块级 `knownAgentName`，闭包里那份改成它的别名），并补 `A7` / `C7` 两条**不注入**的
默认路径用例：把默认值改回闭包变量，`A7` 立刻红（`knownAgent is not defined`）。

---

## 5. 验证命令与结果

```
cd mindcraft
node tools/sec_review_unit.mjs              # 47/47 PASS（新增）
node tools/mindserver_gate_unit.mjs         # 49/49 PASS
node tools/control_plane_guard_unit.mjs     # 73/73 PASS
node tools/sec001_cookie_unit.mjs           # 63/63 PASS
node tools/control_plane_r6_unit.mjs        # 53/53 PASS
npm run gate                               # exit 0（含 lint:hard no-undef=0 / no-floating-promise=0）
node tools/unit_all.mjs                    # 159/159 个脚本通过，5 个跳过（全量离线套件，含新增那条）
```

复现"能红"（可重跑，脚本本身不留在仓库里也能照 §4 的表手工做）：

```
bash mindcraft/tmp/sec-verify/red_evidence.sh    # 逐条去掉判据 → 存证据 → 还原 → 复验
```

## 6. 残留（如实登记，不在本轮范围）

1. **面板凭据 = 同机同用户可读的文件**（`.mindserver-token`）：准确表述是
   **"同机同用户的人本来就能拿到面板凭据、直接操作控制面"** —— 这是既有**权限模型**的边界
   （同一 OS 用户不构成安全边界），**不是**一条绕过鉴权的通路，也不是本批三条缺陷之一，故本批不修。
   要动它只有两条路：进程隔离（改部署模型），或把"替玩家说话"降级成"只能以代理身份说话"
   （会让面板失去现有功能）—— 属产品口径决定。
   ★ 措辞纪律：**不要**把它写成"面板能冒充玩家"——那听起来像这里还有一个未修的鉴权绕过。
2. **`login-agent` 的旧式共享凭据分支**：`credentialAgentName === null`（未逐 agent 发放）时仍放行。
   现在所有 `createAgent` 都走 `issueAgentToken`，这条分支只对"尚未升级的调用方"兼容；
   一旦确认无调用方，应当删掉并把 unknown 视为拒绝（`claimAgentChannel` 里已标注）。
3. **撤销不回溯历史**：被撤销的 token 曾经建过的连接若已被对端保留（离线重放握手），
   只要 mindserver 重启过，旧 token 本来就不再有效（token 每次启动重生成）——不需要额外处理。
