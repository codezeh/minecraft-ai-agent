id: F-EXEC-203
severity: low
class: path
file: mindcraft/src/mindcraft/mindserver.js:146
evidence: |
  **路径穿越：HTTP 路径参数 → `path.join` → `readFileSync`，无前缀校验。**

  完整调用链：

  1. 路由声明（`mindserver.js:146`）：
     ```js
     app.get('/assets/item/:agent/:name.png', async (req, res) => {
         const agentName = req.params.agent;
         const rawName  = req.params.name;
         const itemName = String(rawName).toLowerCase();      // :150  ← 只小写，不清洗
     ```
  2. 拼接（`:184-190`）：
     ```js
     const base = assets.directory;                            // node_modules/minecraft-assets/data/<ver>/
     guessPaths.push(path.join(base, 'items', `${itemName}.png`));
     ...
     const buf = fsMod.readFileSync(p);                        // :188  ← sink
     ```
     `path.join` 会**规范化 `..`**，而 `itemName` 来自 `req.params.name`（Express 对 param
     做 `decodeURIComponent`，所以 `%2F` → `/`）。

  3. 实测路径计算（只算路径，未读文件）：
     ```
     $ node -e 'path.join(base,"items", decodeURIComponent("..%2F..%2F..%2F..%2F..%2F..%2Fsecret").toLowerCase()+".png")'
     → \secret.png            # 已经跳出 base，落到当前盘根
     ```
     也就是说 `GET /assets/item/x/..%2F..%2F..%2F..%2F..%2F..%2FUsers%2Fme%2FDesktop%2Fa`
     在机器上存在 `…/Desktop/a.png` 时会被读出来返回。

  4. 谁能打到：这条路由**没有 token 校验**（`mindserver.js:85` 的中间件只负责"把 ?token= 换成
     cookie"，不拒绝请求；`io.use(makeHandshakeGate)` 只管 socket.io）。服务只绑
     `localhost`（`settings.js:3 host` 与 `mindserver.js:487 const host='localhost'`）。
     ⇒ 需要在本机能发起 HTTP 请求：本机任意进程、或用户浏览器打开的任意网页
     （`<img src="http://localhost:8080/assets/item/x/...">`，不需要 CORS 就能**触发**；
     要读回内容仍需同源/CORS，所以严格说"盲读"）。

  5. 限制：文件名后缀被强制加上 `.png`（`${itemName}.png`），所以只可能读到**以 .png 结尾的文件**。
     `keys.json`、`.env` 这类读不到（这是本条只有 low 的原因）。
exploitability: |
  前提：能在本机发 HTTP（本机进程 / 用户浏览器）。
  能拿到什么：
  - 任意磁盘上 `*.png` 的**存在性**与**内容**（若攻击者能读回响应）；
  - 具体可达的敏感物：`web/poc/*.png` 截图、桌面/文档目录里的截图、
    其它项目里的图片；对"证明某文件存在"也有用（状态码 200 vs 404 可区分）。
  拿不到什么：非 .png 文件、代码执行、写入。跨用户/跨盘取决于文件权限。
  影响半径：信息泄露（窄），且要求攻击者已经能在本机发起请求 —— 与 F-SEC-205（token 落盘）
  这类"本机已失陷"的场景叠加时意义不大，独立价值有限。
  诚实定级：low。但它属于"外部输入直接进 fs sink 且无前缀校验"这一类，
  同一段代码的 `get-profile` 已经用了 `path.basename` 防护（`:262`），这里却漏了 —— 修起来 3 行。
suggested_fix: |
  与同文件 `get-profile` 保持一致的做法（`mindserver.js:262` 已经这么写了）：
  ```js
  // :146 之后，取到 rawName 立刻做一次白名单化，而不是只小写
  const rawName = String(req.params.name ?? '');
  if (!/^[a-z0-9_]+$/i.test(rawName)) {          // 物品名只会是 [a-z0-9_]
      res.status(400).end(); return;
  }
  const itemName = rawName.toLowerCase();
  ```
  并在 `:184` 的 `guessPaths` 循环里加一次前缀断言（双保险，防止将来 base 变成变量）：
  ```js
  const root = path.resolve(base);
  for (const p of guessPaths) {
      const abs = path.resolve(p);
      if (!abs.startsWith(root + path.sep)) continue;   // 越界直接跳过
      try { const buf = fsMod.readFileSync(abs); ... } catch {}
  }
  ```
  参考实现：`src/agent/library/schematic.js:52 resolveSchemPath()` + `:67 isUnder()` ——
  本仓已经有正确的工具函数，这里直接复用即可（`isUnder(abs, root)`）。
verify: |
  cd mindcraft
  # 1) 静态：参数有了白名单校验
  grep -nA3 "req.params.name" src/mindcraft/mindserver.js | head -8   # 期望能看到正则校验
  # 2) 动态（起一个最小实例，别动真服务）：
  #    正常物品仍返回图片 200，穿越请求必须 400/404 而不是 200
  curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/assets/item/deepseek/oak_plank.png"      # 期望 200
  curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/assets/item/deepseek/..%2F..%2F..%2F..%2F..%2Fsecret.png"  # 期望 400 或 404
  # 3) 面板图标不回归（前端要真的还能显示）
  #    人工：打开 http://localhost:8080/console/ 的背包/物品页，图标正常
  # 4) 门禁不回归
  npm run gate:full
discovered_by: recon-scout
dept: D3-EXEC

---
resolution: 已在 t7 以 F-SEC-104 修完（同一处代码，两个编号，不重复改）
已修: mindserver.js 的 /assets/item/:agent/:name.png 加白名单断言 ^[a-z0-9_]{1,64}$，非法 400。
复核: grep -n "invalid texture name" src/mindcraft/mindserver.js → 行 172 在位。
注: 复核席在 t7 已把它算作 F-SEC-104 提交；本条与 F-SEC-104 是同一 finding 的两个编号。
