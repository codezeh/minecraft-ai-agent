id: F-WEB-202
severity: medium
class: config
file: mindcraft/src/mindcraft/mindserver.js:146
evidence: |
  **无鉴权的贴图代理会做重活：实测每个请求 10 秒不返回（超时上限打满）。**

  ## 一、这个 handler 每请求都做的事
  `src/mindcraft/mindserver.js:146-200`（`GET /assets/item/:agent/:name.png`）：
  ```js
  const mod = await import('minecraft-assets');        // :157  ← 动态 import（首次最贵）
  ...
  for (const ver of candidates) {                      // :161
      const assets = mcAssetsFactory(ver);              // 加载该版本的资源索引
      const item = assets.items[itemName];             // textureContent 全表
      ...
      for (const p of guessPaths) {                    // :184
          const buf = fsMod.readFileSync(p);           // :188
  ```
  即：**每个请求**都可能触发 `import('minecraft-assets')` + 资源索引构建 + 多次 `readFileSync`。
  没有任何鉴权（见 F-WEB-201）、没有任何缓存、也没有并发上限。

  ## 二、实测（临时端口 18084，不带 token）
  ```
  ===== C. 贴图代理（无 token，10s 上限）=====
    合法物品名   -> HTTP 000  time=10.011448s     ← 打满 curl 上限，没返回
    穿越请求     -> HTTP 000  time=10.016696s     ← 同上
  ```
  两次都没在 10 秒内响应（`HTTP 000` = 客户端超时；服务端还活着，netstat 能看到
  `127.0.0.1:* → 127.0.0.1:18084 CLOSE_WAIT` 堆积）。
  注意：这条实测同时修正了 F-EXEC-203 的严重度 —— 穿越**在代码上成立**（`path.join` 会规范化 `..`），
  但在这台机器上 handler 先卡在 `import`/资源索引上，穿越读文件那一步很难在超时前走到。
  所以 F-EXEC-203 保持 low 是对的，我把"能读任意 .png"的利用门槛写进了它的 evidence。

  ## 三、同族排查（captain 让确认还有没有别的 `:param` 未清洗）
  `grep -nE "req\.(params|query|body)" src/mindcraft/mindserver.js` → 只有 3 处：
  ```
  :86  req.query.token        → 只做等值比较，安全
  :148 req.params.agent       → 只用于 agent_connections[agentName] 查表（对象键，无 fs）
  :149 req.params.name        → 唯一的 fs sink（F-EXEC-203 已报）
  ```
  ⇒ **没有第二个未清洗的 `:param`**。这半条是"查过、没有"，写在这里免得后人重查。
exploitability: |
  攻击者：本机任意进程；或用户浏览器里打开的任何网页（`<img src="http://localhost:8080/assets/item/x/a.png">`
  可以无限次触发，不需要读响应 —— 只要让它"被执行"就够了）。
  能达成什么：**未授权的资源占用 / 轻量 DoS**。每个请求都可能触发一次昂贵的
  `import('minecraft-assets')` 与资源索引构建；并发发几十个就能让 mindserver 的事件循环长期占满，
  连带 socket.io 心跳超时（`pingTimeout: 60000`）→ agent 被判掉线 → 触发重连/重启链路
  （`mindserver.js:92-101` 的注释写明这条链"实测踩过"）。
  拿不到什么：不能读任意文件（被 `.png` 后缀卡住 + 上述超时），不能执行代码。
  影响半径：本机面板与 bot 的可用性（可被"打开一个网页"打坏）。
  诚实定级：medium —— 不是数据泄漏也不是 RCE，但它让**无鉴权**这个前提变成"可被任意网页反复消耗"，
  与 F-WEB-201 是同一根因的两个后果。
suggested_fix: |
  1. **先修 F-WEB-201 的 token 门**（这一条会自动把本条降级成"需 token 才能滥用"）。
  2. 给贴图代理加**内存缓存 + 并发上限**（治本，独立于鉴权）：
     ```js
     const texCache = new Map();                       // key = `${ver}/${itemName}`
     let inflight = 0; const MAX_INFLIGHT = 4;
     app.get('/assets/item/:agent/:name.png', async (req, res) => {
         const name = String(req.params.name || '');
         if (!/^[a-z0-9_]+$/i.test(name)) return res.status(400).end();   // 顺带修 F-EXEC-203
         const key = name.toLowerCase();
         if (texCache.has(key)) return sendPng(res, texCache.get(key));
         if (inflight >= MAX_INFLIGHT) return res.status(429).end();      // 挡住并发打爆
         inflight++; try { … 原有逻辑 … ; texCache.set(key, buf) } finally { inflight--; }
     ```
  3. 资源索引/`import('minecraft-assets')` 提到**模块级只做一次**（现在写在 handler 里，
     等于每次请求都走一遍动态 import 的解析路径）。
  4. 给这个路由加 8 秒硬超时（`Promise.race`），超时直接 504 —— 现在它会一直挂着。
verify: |
  cd mindcraft
  # 1) 无 token 必须 401（承接 F-WEB-201）
  curl -s -o /dev/null -w "HTTP %{http_code}\n" --max-time 5 "http://127.0.0.1:18085/assets/item/x/oak_plank.png"
  # 2) 带 token 时：合法名 200 且**快**（缓存生效），非法名 400
  curl -s -o /dev/null -w "HTTP %{http_code} time=%{time_total}s\n" --max-time 5 "http://127.0.0.1:18085/assets/item/x/oak_plank.png?token=$TOKEN"
  curl -s -o /dev/null -w "HTTP %{http_code}\n" --max-time 5 "http://127.0.0.1:18085/assets/item/x/..%2F..%2Fsecret.png?token=$TOKEN"
  # 期望：第一次 200 且 time < 1s（缓存）；第二次 400
  # 3) 并发上限：连发 20 个，应有 429、且面板 socket 不掉线
  seq 20 | xargs -P 20 -I{} curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:18085/assets/item/x/oak_plank.png?token=$TOKEN" | sort | uniq -c
  # 4) 门禁不回归
  npm run gate:full
discovered_by: recon-scout
dept: D5-WEB

---
status: fix-ready-awaiting-commit（patch-smith · D5 修补）
changed: mindcraft/src/mindcraft/mindserver.js（详见 docs/audit/night/manifest-D5.md 的对应节）
自检: node --check OK；mindserver_gate_unit 49/0；permissions_unit 66/0；F-WEB-201 判定真值表 6/6

## review（gate-keeper · t17 D5 复核 · 2026-11-06 03:2x）
**结论：部分解决（通过，但保留一个记账项）。** commit `69b3a14`。

已落地（实测行号）：
```
line 224  const TEX_INFLIGHT_MAX = 4;
line 225  let TEX_INFLIGHT = 0;
line 246  if (TEX_INFLIGHT >= TEX_INFLIGHT_MAX) { …429… }
line 253  const release = () => { if (!released) { released = true; TEX_INFLIGHT--; } };  ← finish/close 回收
```
⇒ **在飞并发上限生效**，且用 `finish/close` 回收（不会因异常漏减计数）。

**未做（我认定它是本条的真治本项，必须留账）**：**结果缓存 + 同 key 请求合并**。
理由在我预审 §3.1 已论证：`import()` 本身幂等，真正开销是 `mcAssetsFactory(ver)` 索引构建 + `readFileSync`；
而 DoS 的形态是**并发同 key**（20 个同时打 `oak_planks.png`，纯缓存对"第一波"无效，必须 coalescing）。
**为什么仍给通过**：F-WEB-201 的 token 门已把"任意网页 `<img>` 反复触发"这条**外部**向量关掉，
剩下的只是"持 token 的本地客户端能把自己堵住"——风险从"未授权 DoS"降为"自伤"。
⇒ 定性应为 **部分解决（外部触发面已关；缓存/合并仍欠）**，**不要标"已修"**。
