id: F-WEB-203
severity: medium
class: config
file: mindcraft/src/mindcraft/mindserver.js:464
evidence: |
  **socket.io 事件没有速率限制，`send-message` 也不限制消息体长度 ⇒ 单连接可把 LLM 费用刷爆。**

  ## 一、事件处理器的校验范围（读全文核过）
  `src/mindcraft/mindserver.js:464-487`：
  ```js
  socket.on('send-message', (agentName, data) => {
      if (!agent_connections[agentName]) { … return; }
      // 只校验 from 的形状：
      if (!data || typeof data.from !== 'string' || !data.from || data.from.length > 32) { … return; }
      agent_connections[agentName].socket.emit('send-message', data);   // ← data.message 原样转发
  });
  ```
  ⇒ **`data.from` 有形状校验（≤32 字符），`data.message` 没有任何长度/频率约束**，
  直接转发给 agent 进程 → 进 `handleMessage(source, message)` → 进 LLM 上下文与 `history`。

  ## 二、三处叠加放大（都已在别的 finding 里实证过）
  1. `settings.js:49 "max_commands": -1` ⇒ `agent.js:549 max_responses = Infinity`
     ⇒ **一次 send-message 可以让模型连续产出无限条命令**（F-AI-202 已报）。
  2. `profiles/*.json` 的 `cooldown` 只有 500–5000ms（`my-local.json:14` = 1200ms），
     而且它只限制"两次 LLM 调用之间的间隔"，**不限制调用次数**。
  3. 用户用的是按量计费中转站（`my-local.json: url: https://api.llmgo.net/v1`）⇒ 直接是钱。

  ## 三、实测边界（把"能不能打爆"这件事说准）
  - 消息体大小**不是无上限**：`engine.io` 默认 `maxHttpBufferSize: 1e6`（1 MB），
    本仓没有覆盖它（`grep -rn "maxHttpBufferSize" src/` → 空）。
    ```
    $ grep -n "maxHttpBufferSize" node_modules/engine.io/build/server.js | head -1
    51:            maxHttpBufferSize: 1e6,
    ```
    ⇒ `captain 提的"消息体无大小上限"这条**不成立**，我据此没有报"1 MB 帧随便发"那种说法。
    但 1 MB 文本进 LLM 上下文仍然远超模型窗口 ⇒ 单条消息就能触发上下文超长/重试/计费失败。
  - 速率：**完全没有**限流（无令牌桶、无每连接计数、无全局并发上限）。
    `socket.on('listen-to-agents')` 也是无上限的（`addListener(socket)` 直接 push）。
  - 顺带核实：`shutdown` / `stop-all-agents` / `destroy-agent` 这些"一枪打死全部"的事件
    同样没有任何角色区分 —— 任何持 token 的连接都能发。这在本机单用户模型里是设计使然
    （面板自己要用），我**不**把它单独报成越权，只在这里标注"token = 完全管理员"。
exploitability: |
  攻击者：持 token 的连接。token 的来源有两条现实路径：
  ① 本机任意进程能读到 `MINDSERVER_TOKEN` 环境变量（agent 子进程继承，`mindserver.js:81`）；
  ② `logs/mindcraft-console.log` 会把 token 打进去（F-SEC-205，`start-panel.ps1:189` 重定向）。
  另：本机浏览器里已用 `?token=` 打开过面板的会话，cookie 还在。
  在哪一步：`socket.emit('send-message', agentName, {from:'x', message:'<超长/反复>', …})`。
  能达成什么：
  - **token/费用刷爆**：长消息 + `max_commands=-1` + 无速率限制 ⇒ 一次连接可持续拉高账单；
  - **上下文挤出**：单条 1 MB 消息进去，`max_messages: 30` 的窗口被一条长消息撑满，
    真正的对话历史被挤掉 ⇒ bot 行为变得不可解释（与 F-AI-203 同一后果面）；
  - **连带打掉服务**：面板本身也是这条 socket，刷 `send-message` 会让 agent 长时间占用，
    心跳超时（`pingTimeout: 60000`）后触发"断连→重连→超时→杀进程"链（`mindserver.js:92-101` 注释）。
  拿不到什么：不越权到别的用户（本机单用户模型），不改配置（`set-agent-settings` 有白名单）。
  影响半径：真实费用 + bot 可用性 + 上下文完整性。
  诚实定级：medium（需要 token，不是匿名；但 token 在本机是"可读到的"，且后果是持续计费）。
suggested_fix: |
  1. **给 socket 事件加最小限流器**（不引第三方，20 行足够）：
     ```js
     const buckets = new Map();                       // socket.id -> {tokens, ts}
     function allow(socket, cost = 1, rate = 10, burst = 20) {   // 10 次/秒，突发 20
         const now = Date.now(); const b = buckets.get(socket.id) ?? { tokens: burst, ts: now };
         b.tokens = Math.min(burst, b.tokens + (now - b.ts) / 1000 * rate); b.ts = now;
         if (b.tokens < cost) return false; b.tokens -= cost; buckets.set(socket.id, b); return true;
     }
     socket.on('send-message', (agentName, data) => {
         if (!allow(socket)) { socket.emit('rate-limited', { event: 'send-message' }); return; }
         …
     ```
     对 `send-message` / `create-agent` / `restart-agent` / `listen-to-agents` 都用同一个桶。
  2. **限制 `data.message` 长度**（`mindserver.js:475` 那条 `from` 校验旁边加）：
     ```js
     if (typeof data.message !== 'string' || data.message.length > 2000) { …拒绝并告警… }
     ```
     2000 字符对聊天足够；超长直接拒，不要靠 1 MB 帧上限兜底。
  3. **限制 `listen-to-agents`**：`agent_listeners` 加一个上限（如 8），并在 disconnect 时可靠移除
     （`:365` 已有 disconnect 处理，确认它也清 `agent_listeners`）。
  4. `max_commands` 建议给个有限默认值（如 5）—— 这条属 F-AI-202 的范围，改一处即可。
verify: |
  cd mindcraft
  # 1) 静态：send-message 有长度校验
  grep -n "data.message.length" src/mindcraft/mindserver.js; echo "exit=$?"
  # 2) 动态：单连接连发 50 条应被限流（写一个 socket.io-client 脚本）
  node -e '
    const { io } = require("socket.io-client");
    const s = io("http://127.0.0.1:18085", { auth: { token: process.env.MINDSERVER_TOKEN } });
    s.on("connect", () => {
      let ok = 0, limited = 0;
      s.on("rate-limited", () => limited++);
      for (let i = 0; i < 50; i++) s.emit("send-message", "x", { from: "t", message: "hi" });
      setTimeout(() => { console.log("rate-limited 次数 =", limited, "（期望 >0）"); s.close(); }, 1500);
    });'
  # 3) 超长消息必须被拒（不靠 1MB 帧上限）
  #    用上面的脚本发 message: "a".repeat(5000)，期望服务端日志出现拒绝、且不转发给 agent
  # 4) 门禁不回归
  npm run gate:full
discovered_by: recon-scout
dept: D5-WEB
