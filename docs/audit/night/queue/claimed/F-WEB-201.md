id: F-WEB-201
severity: high
class: authz
file: mindcraft/src/mindcraft/mindserver.js:85
evidence: |
  **HTTP 三个出口全部零鉴权，已实测（不是读代码推断）。握手门只保护 socket.io。**

  ## 一、代码：那个 `app.use` 只发 cookie，从不拒绝
  `src/mindcraft/mindserver.js:85-92`：
  ```js
  app.use((req, res, next) => {
      const fromQuery = typeof req.query?.token === 'string' ? req.query.token : null;
      if (fromQuery && fromQuery === handshakeToken && !hasAuthCookie(req.headers.cookie, handshakeToken)) {
          res.setHeader('Set-Cookie', authCookieHeader(handshakeToken));   // 只是顺手发 cookie
      }
      next();                                                             // ← 无条件放行
  });
  ```
  全仓 HTTP 侧**没有任何** auth 中间件（`grep -nE "app\.(get|post|use|all)\(" mindserver.js` 只有 4 条：
  上面这条、`:143 express.static(public)`、`:207 app.use('/console', express.static(webDist))`、
  `:209 app.get(['/console','/console/*'])`）。
  真正的门只有 `:103 io.use(makeHandshakeGate(handshakeToken))` —— **socket.io 专用**。

  ## 二、实测：起一个真实例（临时端口 18084），全程不带任何 token
  ```
  $ node -e '(await import("./src/mindcraft/mindserver.js")).createMindServer(false, 18084)'
  ===== A. express.static(public) =====
    /                    -> HTTP 200  bytes=58752      ← 旧控制台整页（单文件 UI）
    /index.html          -> HTTP 200  bytes=58752
    /settings_spec.json  -> HTTP 200  bytes=5226       ← 完整配置项清单（28 个键）
  ===== B. 新控制台 /console/ =====
    /console             -> HTTP 301  bytes=157
    /console/            -> HTTP 200  bytes=398        ← Vue 构建产物入口
    /console/index.html  -> HTTP 200  bytes=398
    /console/assets/     -> HTTP 200  bytes=398        （SPA fallback 回 index.html）
  ===== D. 响应头（GET /console/）=====
    HTTP/1.1 200 OK
    X-Powered-By: Express
    Accept-Ranges: bytes
    Cache-Control: public, max-age=0
    Last-Modified: … / ETag: … / Content-Type: text/html; charset=UTF-8 / Content-Length: 398
    （CSP / X-Frame-Options / X-Content-Type-Options / Referrer-Policy：**一个都没有**）
  ```
  ⇒ `/console/` 与 `/settings_spec.json` **无需 token，直接 200**。

  ## 三、暴露的是什么（逐项核过内容）
  - `/console/` + `/console/assets/index-*.js`：整个面板前端（路由、组件、API 调用形状、
    内网地址如 `127.0.0.1:8080`、字段名）——**已核对：bundle 里没有密钥**
    （`grep -roE "sk-[A-Za-z0-9]{20,}" web/dist` → 空，D2 已核），所以不是凭据泄漏，是**攻击面地图**。
  - `/settings_spec.json`（5226 B）：28 个配置键的完整 schema，含
    `allow_insecure_coding` / `blocked_actions` / `task` / `speak` / `only_chat_with`…
    ⇒ 直接告诉访问者"这个系统有 `allow_insecure_coding` 这个总闸"`、
    "有 `task` 这个隐藏开关"（正是 F-EXEC-202 与 F-AI-204 的两个关键点）。
    顺带从反面印证 F-AI-204：**`task` 在 spec 里，`companion_mode` 不在**。
  - 旧控制台 `/`（58752 B）：`grep -cE "token|password|apiKey|sk-"` → **0**，无凭据。

  ## 四、能拿到什么 / 拿不到什么（诚实边界）
  拿到：面板 UI 与配置 schema（无凭据）；⇒ 任何能在本机发 HTTP 的进程、或用户浏览器里打开的
  任意网页（`<img>`/`<iframe src="http://localhost:8080/console/">`）都能取到这些。
  拿不到：**socket.io 事件仍然要 token**（`io.use` 是真门，`allowRequest: allowLocalOnly` 挡异源），
  所以"读面板静态资源"不等于"能控制 bot"。这一点必须写清，否则会把 high 变成虚报。
  这条为什么仍算 high：
  1. **认证边界摆错了位置** —— 同一次会话里 socket 要 token、HTTP 不要，用户会以为面板是受保护的；
  2. `settings_spec.json` 是**主动的侦察材料**（它把隐藏开关列成清单），显著降低 D3/D4 那些
     "隐藏开关"被发现的成本（`task` / `allow_insecure_coding` 都在里面）；
  3. 与 F-SEC-205（token 落盘到 `logs/mindcraft-console.log`）叠加时，攻击者拿 token 的路径是
     "读日志文件"；而**读日志常常只需要能读那个目录**，HTTP 零鉴权使得"先确认这是个什么系统、
     有什么开关"这一步变得零成本。
exploitability: |
  攻击者：本机任意进程；或用户浏览器里打开的任何网页（本地服务没有 CORS/来源限制，
  `<iframe>`/`<img>` 就能取资源）。不需要任何凭据、不需要知道 token。
  在哪一步：`GET http://localhost:8080/...` → express 直接 `next()` → `express.static` 出文件。
  能达成什么：拿到完整面板前端 + 28 项配置 schema（含隐藏开关清单）+ 旧控制台整页；
  能据此摸清 API 形状（socket 事件名、字段名）来对着 `F-SEC-205` 的 token 做后续利用。
  拿不到什么：socket.io 事件（需 token）；不能直接控制 bot、不能读 `keys.json`（它不在 public/ 下）。
  影响半径：信息暴露 + 认证边界误导（把"本机面板"误当成"受保护面板"）。
suggested_fix: |
  **把 token 门提到 HTTP 层**（一处中间件，覆盖静态与 API），并保持"浏览器体验不变"：
  ```js
  // mindserver.js:85 之前
  const PUBLIC_PATHS = new Set(['/favicon.ico']);          // 只放真正无需鉴权的
  app.use((req, res, next) => {
      // 1) ?token= 换 cookie（保留现有行为）
      const fromQuery = typeof req.query?.token === 'string' ? req.query.token : null;
      if (fromQuery && fromQuery === handshakeToken && !hasAuthCookie(req.headers.cookie, handshakeToken)) {
          res.setHeader('Set-Cookie', authCookieHeader(handshakeToken));
      }
      if (PUBLIC_PATHS.has(req.path)) return next();
      // 2) 之后所有请求都必须带 cookie 或 header
      if (hasAuthCookie(req.headers.cookie, handshakeToken)
          || tokenEquals(req.headers['x-mindserver-token'], handshakeToken)) {
          return next();
      }
      res.status(401).type('text/plain').send('mindserver: 需要握手 token（用启动日志里的 ?token=… 打开）');
  });
  ```
  配套：① 前端 `web/src/api/socket.ts` 已靠 cookie，无需改；② 用户首次访问仍走
  `http://localhost:8080/?token=…`（启动日志打印的那个），换到 cookie 后一切照旧；
  ③ `start-panel.ps1` 打开的 URL 已经是带 token 的形式（`:15 $panel = 'http://localhost:8080/console'`
  —— 这里要改成带 token 的地址，否则用户点面板会 401，**这条必须一起改**）。
  另加安全响应头（同一中间件里）：
  ```js
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'");
  app.disable('x-powered-by');   // 去掉 X-Powered-By: Express
  ```
verify: |
  cd mindcraft
  # 1) 无 token 必须 401（这是本条的硬判据）
  node -e '(await import("./src/mindcraft/mindserver.js")).createMindServer(false, 18085)' &
  sleep 8
  for p in "/" "/index.html" "/settings_spec.json" "/console/" ; do
    printf "%-22s " "$p"; curl -s -o /dev/null -w "HTTP %{http_code}\n" --max-time 5 "http://127.0.0.1:18085$p"
  done
  # 期望：全部 401
  # 2) 带 token 必须 200（不能为了安全把用户挡在门外）
  TOKEN=$(… 从启动日志取 …)
  printf "带 token /console/      "; curl -s -o /dev/null -w "HTTP %{http_code}\n" --max-time 5 "http://127.0.0.1:18085/console/?token=$TOKEN"
  # 期望 200
  # 3) 安全头到位
  curl -s -i --max-time 5 "http://127.0.0.1:18085/console/?token=$TOKEN" | grep -iE "content-security|x-frame|nosniff"
  # 4) 面板仍能用（人工：双击 启动面板.bat → 浏览器自动进控制台，不要求手输 token）
  # 5) 门禁不回归
  npm run gate:full
discovered_by: recon-scout
dept: D5-WEB

---
status: fix-ready-awaiting-commit（patch-smith · D5 修补）
changed: mindcraft/src/mindcraft/mindserver.js（详见 docs/audit/night/manifest-D5.md 的对应节）
自检: node --check OK；mindserver_gate_unit 49/0；permissions_unit 66/0；F-WEB-201 判定真值表 6/6
