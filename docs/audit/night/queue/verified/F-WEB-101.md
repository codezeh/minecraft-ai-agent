id: F-WEB-101
severity: low
class: authz
file: mindcraft/src/mindcraft/mindserver.js:471-478
evidence: |
  面板内容可以伪造：两个广播事件原样转发，不校验发送方是不是"那台 agent 自己的连接"：
    :471  socket.on('bot-output', (agentName, message) => {
    :472      io.emit('bot-output', agentName, message);        ← 谁发的都转发，连 agentName 也不校验
    :473  });
    :476  socket.on('agent-event', (agentName, e) => {
    :477      io.emit('agent-event', agentName, e);
    :478  });
  面板侧是**无条件信任**的：`web/src/stores/agents.ts:97` `socket.on('bot-output', (agentName, message) => …)`
  直接把它追加进对话流显示。
  缓解现状（要写准）：`:103 io.use(makeHandshakeGate(handshakeToken))` 已挡掉**未认证**客户端
  → 攻击面从"本机任意进程"收窄到"已持 token 的客户端"；而 token 在启动日志里明文打印
  （`:493-494`），所以"本机任意进程"仍然能拿到它。
  出处：docs/audit/03-interface-security.md I18；docs/audit/21-review-r2-verdict.md §3 **R2-5（收录待修）**
  （"认证内客户端仍可伪造 bot 台词 → 排障时对着假日志查错"）；docs/audit/00-REPORT.md §四 4.1 I18。
  本轮在当前代码复核：**仍存在**（`:471-478` 逐字未变）。
exploitability: |
  前置：能连上 mindserver 的 socket 并持 token（本机进程可读启动日志 → 成立）。
  能拿到什么：往**所有人的面板**注入任意 `bot-output` / `agent-event`：
  ① 伪造"bot 说了某句话"（`agentName` 也可以随便填成别的 bot）→ 排障时对着假日志查错；
  ② 伪造 `agent-event` 的结构化事件（诊断页的事件流）→ 可以让"挖矿失败/离线/单子卡住"看起来发生或消失。
  不能拿到什么（要写清，避免夸大）：这条**不**能驱动 bot 做事（那是 `send-message`，另有权限链），
  也**不**是提权 —— 它是**面板显示的完整性**问题，属"观测层可被污染"。
  影响半径：面板/日志可信度；与 F-SEC-004（HTTP 端零鉴权）合起来说明"面板这一侧的整体鉴权边界很薄"。
suggested_fix: |
  给 socket 与 agent 绑定身份，转发前校验（≈8 行）：
  ```js
  // 连接建立时记下来源：agent 子进程握手时会带 ?agent=<name>（或复用已有 env token 通道）
  socket.data.agentName = resolveAgentNameFromHandshake(socket.handshake);
  socket.on('bot-output', (agentName, message) => {
      if (socket.data.agentName && socket.data.agentName !== agentName) {
          console.warn(`[mindserver] 丢弃伪造的 bot-output：连接=${socket.data.agentName} 声称=${agentName}`);
          return;
      }
      io.emit('bot-output', agentName, message);
  });
  ```
  `agent-event` 同改。**若今晚不想动握手协议**（风险高），最小版：只允许**面板连接**（非 agent）转发，
  即"agent 身份的连接不许发 `bot-output`"，因为实际上只有 agent 进程会发它。
  先做判据再谈改名：`grep -rn "emit('bot-output'" mindcraft/src` 确认生产侧唯一来源是 agent 进程。
verify: |
  cd mindcraft
  grep -n "丢弃伪造的 bot-output" src/mindcraft/mindserver.js    # 改后期望 1 命中
  # 行为：用两个 socket 连接，A 声称自己是 bot "x" 发 bot-output('x','假台词')
  #   期望：面板收不到 / 收到被丢弃的 warn；而 agent 自己发仍正常到达
  npm run gate                                                  # 与基线一致
discovered_by: patch-smith(from history)
dept: D5-WEB

## review（gate-keeper · t17 D5 复核 · 2026-11-06 03:2x）
**结论：通过（服务端发送方身份判据，非前端限制）。** commit `69b3a14`。
```
line 603  socket.on('bot-output', (agentName, message) => {
line 608    if (!(typeof socket.handshake?.auth?.token === 'string' && socket.handshake.auth.token === handshakeToken)) {
line 609        console.warn('丢弃伪造的 bot-output：连接未以 agent 身份（auth.token）互联…');
line 610        return;
line 611    }
line 612    io.emit('bot-output', agentName, message);
```
⇒ 判据是**握手凭据（agent 用 `auth:{token}`，面板用 HttpOnly cookie）**，面板无法伪造 bot 台词/诊断事件。
这是**服务端**判据，不是"前端不渲染"。`agent-event` 同族（t10 说明两处一并加）。
