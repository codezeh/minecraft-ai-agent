id: F-WEB-204
severity: low
class: config
file: mindcraft/src/mindcraft/mindserver.js:225
evidence: |
  **token 门内的事件把"本机绝对路径 + 全量配置"推给前端；同时 HTTP 侧零安全响应头。**

  ## 一、`get-profiles` / `get-profile` 回给前端的东西
  `src/mindcraft/mindserver.js:225-268`：
  ```js
  socket.on('get-profiles', (callback) => {
      const full = path.join(profilesDir, f);
      out.push({ file: f, path: full, name: …, api: …, model: …, url: …, bytes: … });   // ← :240 绝对路径
  });
  socket.on('get-profile', (file, callback) => {
      callback({ ok: true, file: safe, path: full, raw, json: JSON.parse(raw) });        // ← :265 整份 profile 原文
  });
  ```
  实测回包形状（代码内 `path: full` 用了 `path.join(__dirname,'../../profiles')`）：
  ⇒ 前端拿到 **`E:\我的世界ai\mindcraft\profiles\xxx.json` 这种绝对路径**
  与 **整份 profile**（含 `permissions.owner` 主人名、`url` 中转站地址、`conversing` 人设全文）。
  `get-settings`（`:338`）同样把**整份 settings** 返回：`host` / `port` / `mindserver_port` /
  `blocked_actions` / `allow_insecure_coding` 全在里面。
  （**不**含 `keys.json` 的内容 —— `getKey` 走 `src/utils/keys.js`，不进 settings，这点我核过：D2 已确认前端 bundle 无密钥。）

  ## 二、token 门内 + 零安全头 = 两个后果叠在一起
  1. 这些事件本身在 `io.use(makeHandshakeGate)` 之后（真门），所以**未授权拿不到**。
     但 token 的现实泄漏路径有两条：`MINDSERVER_TOKEN` 环境变量（agent 子进程继承）与
     `logs/mindcraft-console.log`（F-SEC-205 已实证会落盘）。拿到 token 的连接即可走上面两个事件。
  2. HTTP 侧没有任何安全响应头（实测，见 F-WEB-201 的响应头抓取）：
     ```
     X-Powered-By: Express          ← 技术栈指纹（顺手就能关掉）
     CSP / X-Frame-Options / X-Content-Type-Options / Referrer-Policy：一个都没有
     ```
     `X-Frame-Options` 缺失意味着本机面板可被任意网页 `<iframe>` 嵌入。
     **但我要诚实说明它的实际危害很小**：面板要靠 socket.io 工作，而 socket 有
     `allowRequest: allowLocalOnly`（`local_only.js`）会拒绝异源 Origin ⇒ 被 iframe 嵌进去的面板
     是"能看见但点不动"的。所以这条**不是点击劫持**，只是缺一层纵深防御。
     CSP 缺失的影响同理：面板自身无 `v-html`/`innerHTML`（下条核实），没有可执行注入点给它兜。
exploitability: |
  攻击者：持 token 的本机进程 / 会话（token 见上）。
  能达成什么：
  - 拿到**本机绝对路径**（`E:\我的世界ai\mindcraft\profiles\…`）——对"在用户机器上找东西"有定向价值
    （结合 F-EXEC-201 的 RCE 就是现成的目标清单：`profiles/` 旁边就是 `keys.json`）；
  - 拿到 `permissions.owner` 主人名 —— 与 F-SEC-204（离线模式冒名登录）组合：
    知道主人名就能直接冒用进服；
  - 拿到全量 settings（`allow_insecure_coding` 等开关状态）—— 决定后续打哪条路。
  拿不到什么：密钥值、代码执行。
  影响半径：信息暴露（定向侦察）。
  诚实定级：**low**。理由：它需要 token（不是匿名可达），且泄漏的是"路径与配置"而非凭据；
  单独看价值有限，但它是 F-SEC-204（冒名）+ F-EXEC-201（RCE 找目标）的**前置侦察件**。
suggested_fix: |
  1. **不回绝对路径**（`mindserver.js:240` 与 `:265`）：把 `path: full` 改成 `path: file`（相对名），
     前端只需要文件名；真要排障就返回 `pathBasename` 即可。
  2. **`get-settings` 按白名单裁剪**：复用已有的 `SAFE_RUNTIME_SETTINGS`（`auth_gate.js`）思路 ——
     面板只需要"能改的那几个键 + 当前值"，不需要 `allow_insecure_coding` 这类开关状态。
     建议返回 `sanitizeAgentSettings(settings).settings` 而不是整份。
  3. **补安全响应头 + 关指纹**（与 F-WEB-201 的中间件一起加，一处改动）：
     ```js
     app.disable('x-powered-by');
     app.use((req, res, next) => {
         res.setHeader('X-Content-Type-Options', 'nosniff');
         res.setHeader('X-Frame-Options', 'DENY');
         res.setHeader('Referrer-Policy', 'no-referrer');
         res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'");
         next();
     });
     ```
  4. 前端 `DebugView.vue` 若展示了这些 `path` 字段，一并改成只显示文件名（不改也行，后端不回就够了）。
verify: |
  cd mindcraft
  # 1) 静态：不再回绝对路径
  grep -n "path: full" src/mindcraft/mindserver.js; echo "期望无命中（exit=1）"
  # 2) 静态：get-settings 走白名单
  grep -n "sanitizeAgentSettings" src/mindcraft/mindserver.js | head -3   # 期望在 get-settings 里也出现
  # 3) 动态：抓一次 get-profiles 的返回，断言不含盘符
  node -e '
    const { io } = require("socket.io-client");
    const s = io("http://127.0.0.1:18085", { auth: { token: process.env.MINDSERVER_TOKEN } });
    s.on("connect", () => s.emit("get-profiles", (r) => {
      const bad = JSON.stringify(r).match(/[A-Za-z]:\\\\/g);
      console.log("含盘符字段:", bad ? "FAIL " + bad.slice(0,2).join(",") : "OK 无绝对路径");
      s.close();
    }));'
  # 4) 安全头
  curl -s -i --max-time 5 "http://127.0.0.1:18085/console/?token=$TOKEN" | grep -iE "x-powered-by|content-security|x-frame|nosniff|referrer"
  # 期望：x-powered-by 消失，其余四项出现
  # 5) 门禁不回归
  npm run gate:full
discovered_by: recon-scout
dept: D5-WEB
