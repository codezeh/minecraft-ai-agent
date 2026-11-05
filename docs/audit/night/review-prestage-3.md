# 修前预审 · D5 三张 WEB 单（F-WEB-201 / 203 / 202）

> 复核官：gate-keeper ｜ 2026-11-06 02:5x–03:1x
> 重点：**设计风险**（不是找 bug），因为我最擅长的是"改完才发现把正常功能弄死"这一类。
> **前置事实（先纠正 captain 的判断）**：这三张单在我审的这一刻**已经不是"未开始"状态**——
> - `F-WEB-201` / `F-WEB-203`：**代码已写好在工作区**（`mindserver.js` 未提交），文件里自述 `fix-ready-awaiting-commit`；
> - `F-WEB-202`：**未实现**（只有一行注释，无缓存/无并发上限/无超时）。
>
> 所以本文对 201/203 是"**对已写代码的设计评审**"，对 202 是"**修前设计判断**"。
> 我按你的三个问题逐条答，并且**能实测的都实测了**（尤其是 CSP 会不会打死面板）。

---

## 0. 三句话结论

1. **`F-WEB-201` 的方向对，但有一个"会把面板打死"的真实缺口**：`start-panel.ps1` 在
   `.mindserver-token` **缺失时仍然打开裸 `/console`**（`$panelUrl = $panel` 兜底），
   而新中间件对无 token 的 HTTP 一律 401 ⇒ **浏览器里只会看到一行 "unauthorized…" 纯文本，面板打不开**。
   你担心的正是这件事，而它**已经真实存在**于这段代码里（不是假设）。
2. **CSP 不会打死面板**——我实测了产物：`index.html` **零内联脚本**、bundle 里 `eval(`=0 / `new Function(`=0
   ⇒ 不需要 `'unsafe-eval'`；cookie 是 `Path=/` ⇒ 全站生效；`connect-src` 含 `ws:` ⇒ socket.io 通。
3. **`F-WEB-202` 的答案：光缓存 `import()` 不够，必须有"同 key 请求合并"**。因为攻击形态是**并发同 key**
   ——纯缓存对"第一波并发未命中"完全无效。

---

## 1. `F-WEB-201`（HTTP 三出口零鉴权）

### 1.1 你问①：改在 `:85` 那个 `app.use` 里，会不会打断 cookie 换发流程？

**不会，而且实现顺序是对的。** 我把三段中间件的顺序抄下来核过：

```js
// ① 换发 cookie（原来的那条，仍在最前）
app.use((req,res,next)=>{ if (fromQuery===handshakeToken && !hasAuthCookie(...)) res.setHeader('Set-Cookie', authCookieHeader(...)); next(); });

// ② 安全响应头（新增）
app.disable('x-powered-by');
app.use((req,res,next)=>{ nosniff / X-Frame-Options:DENY / Referrer-Policy:no-referrer / CSP; next(); });

// ③ 鉴权（新增）
app.use((req,res,next)=>{
    const viaCookie = hasAuthCookie(req.headers.cookie, handshakeToken);
    const viaQuery  = req.query?.token === handshakeToken;
    if (viaCookie || viaQuery) return next();
    console.warn(`[mindserver] 拒绝无 token 的 HTTP 请求 ...`);
    res.status(401)...send('unauthorized: 需要握手 token …');
});
```

- ① 在 ③ 之前 ⇒ **`?token=…` 仍然能先种上 cookie 再放行**，换发流程没被打断 ✅
- ③ 同时接受 `cookie` **和** `query` ⇒ 首屏带 `?token=` 能过 ✅
- `authCookieHeader` 实测是 `Path=/; HttpOnly; SameSite=Strict` ⇒ **Path=/ 覆盖 `/console/`、`/assets/*`、
  `/settings_spec.json` 全部路径**，不存在"cookie 只对某个子路径生效"的坑 ✅
- socket.io 的 `/socket.io/` 由 engine.io 抢先接管、不经 express ⇒ 不会被 ③ 401 掉
  （代码注释也写了这条；**但这一点必须实测确认**，见 §1.5 清单第 4 项）。

### 1.2 你问②：静态资源也要 token，会不会把面板彻底打死？——**会，而且已经有一个真实踩点**

**先说设计判断**：是的，你的直觉是对的 —— **"全部都要 token"这个做法在失败路径上会把面板变成白屏**。
而这段代码**目前就有一个确定的失败路径**：

```powershell
# scripts/start-panel.ps1
$panelUrl = $panel                  # = 'http://localhost:8080/console'   ← 没有 token
if (Test-Path $tokenFile) {
    $tok = (Get-Content $tokenFile -Raw).Trim()
    if ($tok) { $panelUrl = "$panel?token=$tok" }
} else {
    Write-Host '  [WARN] 未找到 mindcraft/.mindserver-token；…'     # ← 只警告，然后继续
}
Start-Process $panelUrl              # ← token 缺失时，照样打开裸 /console
```

⇒ **`.mindserver-token` 不存在 / 是空文件时**（首次启动失败、cwd 不对、权限不足 ——
而 `mindserver.js` 自己就有一条"写 token 文件失败只告警不阻断启动"的降级分支），
脚本会**打开一个没有 token 的 `/console`**，新中间件立刻 401，
**用户看到的是浏览器里一行纯文本 "unauthorized: 需要握手 token…"，而不是面板**。
这比"打不开"更糟：**它看起来像服务器坏了**。

**另一个时序坑**：`start-panel.ps1` 读 token 文件是一次性的。若 mindserver 还在启动、
文件尚未写出，就会走进上面那条兜底。**建议加一个"最多重试 N 次读文件"**，否则冷启动可能偶发白屏。

### 1.3 我建议的修法：**混合策略**（你猜的那个方案，我认为是对的）

**HTML 外壳 + 静态资源放行；数据/API 要 token。** 理由有实测支撑：

- recon 已核过 **bundle 里没有任何凭据**（`grep -roE "sk-[A-Za-z0-9]{20,}" web/dist` → 空），
  所以"放行静态资源"**不泄漏任何秘密**，只泄漏"这是个 Vue 面板"这种低价值信息。
- 真正该拦的是 **`/settings_spec.json`**（它把 `allow_insecure_coding` / `task` / `speak` 这些
  **隐藏开关列成清单**，等于给攻击者一份地图）—— 这个必须留在 token 后面。

具体形态（只动一处，不碰换发流程）：
```js
const PUBLIC_PATHS = /^\/(console(\/.*)?|settings_spec\.json|favicon\.ico)$/;  // ← 注意 settings_spec 不在放行里！
// 正确写法：放行外壳与静态资源，但**单独拒绝** settings_spec
const SHELL = /^\/(console(\/.*)?|favicon\.ico)$/;
app.use((req,res,next)=>{
    const ok = hasAuthCookie(...) || req.query?.token === handshakeToken;
    if (ok) return next();
    if (SHELL.test(req.path)) return next();          // 外壳放行：用户能看到面板，再由前端引导
    res.status(401)…                                    // settings_spec 等数据仍要 token
});
```
**并且**前端在 `web/src/api/socket.ts` 那条握手失败时，**显示"请用带 ?token= 的地址打开"**，
而不是干等超时 —— 这样"外壳放行"不会变成"看起来能用其实连不上"的新误导。

> 若 patch-smith 坚持"全部要 token"，那**必须**同时做两件事，否则就是上面那个白屏：
> ① `start-panel.ps1` 在拿不到 token 时**不要 Start-Process**，改为打印"token 未就绪，请稍后重跑"；
> ② token 文件读取加**重试**（最多 ~10 秒）。两件缺一不可。

### 1.4 你问③：CSP / X-Frame-Options / nosniff 会不会打死 `three.js` 与 vite 产物？

**不会。我实测了真实产物，不是猜。**

```
$ cat web/dist/index.html            # 这是 /console 实际 serve 的文件（mindserver.js:283-288）
  <script type="module" crossorigin src="/console/assets/index-BfjaJXlW.js"></script>
  <link rel="stylesheet" crossorigin href="/console/assets/index-Ce4aIC61.css">
  → **零内联 <script>**，全是外链同源资源 ⇒ `script-src 'self'` 够 ✅

$ grep -c 'eval('        assets/index-BfjaJXlW.js  → 0
$ grep -c 'new Function(' assets/index-BfjaJXlW.js → 0
  → **不需要 'unsafe-eval'** ✅（若需要，CSP 里没有就会直接白屏，这是最常见的 CSP 事故）

CSP 各项对本项目的对应关系：
  default-src 'self'            → 静态资源同源 ✅
  script-src  'self'            → 外链 module script ✅（无内联、无 eval）
  style-src   'self' 'unsafe-inline' → Vue 动态 style ✅（已含 unsafe-inline，够）
  img-src     'self' data:      → 贴图代理 `/assets/item/…` 同源 + base64(data:) ✅
  connect-src 'self' ws: wss:   → socket.io 的 ws://localhost:8080 ✅（含 polling 的 /socket.io/ 也是 'self'）
  frame-ancestors 'none'        → 与 X-Frame-Options:DENY 同义，防嵌入 ✅
```

**唯一没被我验证的**：`three.js` 在**运行时**是否会因为某些特性（如 WebGL 上下文、Worker）被
`default-src 'self'` 挡住。它不用 Worker、不用 eval，所以理论上安全 —— 但**这条只能靠"真开一次面板"确认**，
我把它放进下面的最小清单第 5 项。

### 1.5 **改完必须验证的最小清单（我按"最可能坏"排序）**

| # | 验什么 | 怎么验 | 期望 | 为什么排这个位置 |
|---|---|---|---|---|
| 1 | **无 token 的 HTTP 必须 401** | `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:PORT/settings_spec.json` | `401` | 本条的硬判据 |
| 2 | **带 token 必须 200** | `curl ".../settings_spec.json?token=$TOK"` | `200` | 别为了安全把用户挡在门外 |
| 3 | **双击 `启动面板.bat` → 面板真的能打开** | 人工 | 浏览器进控制台、**不是** 401 纯文本 | **最容易坏的一条**（见 §1.2） |
| 4 | **socket 仍能连上**（`/socket.io/` 没被 401 拦） | 面板打开后看 bot 状态是否刷新；或看日志无 `拒绝无 token 的 HTTP 请求 POST /socket.io/` | 有数据、无该日志行 | engine.io 抢先接管这件事**要实证** |
| 5 | **three.js 场景仍渲染**（CSP 未误伤） | 人工：面板里看地图/3D 视图 | 能渲染、控制台无 CSP 报错 | 唯一靠人工的 CSP 判据 |
| 6 | **cookie 全站生效** | 打开后看 devtools：`/console/assets/*`、`/settings_spec.json` 是否都 200 | 都 200 | 验证 `Path=/` |
| 7 | **`X-Powered-By` 已消失、三个安全头都在** | `curl -i ... \| grep -iE "x-powered-by\|content-security\|nosniff\|x-frame"` | 无 X-Powered-By；三个头都在 | — |
| 8 | 门禁 | `npm run gate:full` | 与基线一致 | — |

**其中第 3、4、5 项只能人工/真机验**，`curl` 验不出来。**这三项没过就不许标"已修"。**

### 1.6 另外两个小风险（低，但记下来）
- **`?token=` 在每一次请求都被接受**（不只首屏）⇒ token 会出现在地址栏/浏览器历史里。
  已有 `Referrer-Policy: no-referrer` 降低外泄面，但更干净的做法是"只在没有 cookie 时接受 query 参数，
  种完 cookie 就 302 到不带 token 的同一路径"。**不必须，但值得做。**
- **`/favicon.ico` 会每次 401 并打一行 `console.warn`** ⇒ 浏览器每个标签页都会刷一条日志。
  建议把 favicon 放进 `PUBLIC_PATHS`，否则日志会被无意义地填满（与 F-SEC-205 的"日志别乱写"同源）。

---

## 2. `F-WEB-203`（socket 零限流）—— 已实现，但有 3 个设计问题

### 2.1 现状（我读的代码，不是转述）
```js
socket.on('send-message', (agentName, data) => {
    if (typeof data?.message === 'string' && data.message.length > 2000) { warn; return; }   // ① 长度闸
    { const now=Date.now();
      const rl = socket.data.__rl || (socket.data.__rl = { tokens: 30, ts: now });
      rl.tokens = Math.min(30, rl.tokens + ((now - rl.ts)/10000) * 30);                     // ② 令牌桶
      rl.ts = now;
      if (rl.tokens < 1) { warn; return; }
      rl.tokens -= 1; }
    if (!data || typeof data.from !== 'string' || !data.from || data.from.length > 32) { … } // ③ 原形状校验
    agent_connections[agentName].socket.emit('send-message', data);
});
```
- ①**长度上限 2000 已落地** ✅（2000 字符对聊天足够宽松，不会误伤）
- ②令牌桶：初始 30、约 **3 条/秒**（30 per 10s）—— 对聊天绰绰有余 ✅

### 2.2 你问："放哪一层？按来源还是按连接？会不会误伤 `narrate`？"

| 问题 | 我的回答 |
|---|---|
| 放哪一层 | **放在事件处理器内是对的**（简单、无依赖、不动传输层）。放 express 中间件不行——socket 事件不经 express。 |
| 按"来源"还是"连接" | **现状是按连接（`socket.data.__rl`）——这有个确定的绕过：重连即重置桶。** 攻击者只要 `disconnect → connect` 循环就能无限刷。建议：**桶键改成 `req.socket.remoteAddress`**（本机单用户场景下就是 127.0.0.1，效果=全局限流），或**全局桶 + 每连接桶双层**。 |
| 会不会误伤 `narrate` | **不会，而且不存在这个风险**：我 grep 了全部 `socket.on(...)`（22 个），**没有 `narrate` 这个入站事件**（`narrate_behavior` 是 settings 字段、走的是出站/agent 侧）。限流只挂在 `send-message` 上，其余事件完全不经过它 ⇒ **零误伤**。 |

### 2.3 三个仍然存在的问题（建议补，但不必因此打回）
1. **限流只覆盖 `send-message`**：`create-agent` / `restart-agent` / `destroy-agent` /
   `listen-to-agents` 仍然无限流。finding 原文就要求"用同一个桶"。其中 `restart-agent` 循环调用
   会让 agent 反复重启（比刷消息更伤可用性）。
2. **限流挡不住"一条消息引爆无限命令"**：`settings.max_commands = -1` ⇒ 一次 `send-message`
   仍可让模型产出无限条命令（那是 `F-AI-202` ③ 的范围）。**所以限流只把"每秒花费"限住，
   没有把"单次花费"限住。** 别把 203 当成费用问题的完整解法。
3. **`rl.tokens` 回填公式是可读的**（30 per 10s），但注释写"30 条 / 10 秒"容易被读成"每秒 3 条"中的
   "3 条/秒"——建议注释直接写 `≈3 条/秒，突发 30`，免得后人以为能发 30/秒。

---

## 3. `F-WEB-202`（贴图代理 DoS）—— **未实现**，直接回答你的问题

### 3.1 你的问题："缓存 `import('minecraft-assets')` 的结果是否就够，还是需要请求合并？"

**答案：光缓存 `import()` 不够，必须有请求合并（coalescing）。** 理由分三层：

1. **`import()` 本身在 Node 里是幂等的** —— 同一个 specifier 第二次 import 不会再解析一遍模块
   （模块注册表缓存）。所以"缓存 import 结果"解决的是一个**基本不存在的问题**。
   真正的每请求开销是 **`mcAssetsFactory(ver)` 的资源索引构建** + 循环里的 `readFileSync`（finding 实测：**每次 10 秒不返回**）。
   ⇒ **要缓存的是 `mcAssetsFactory(ver)` 的结果（按版本记忆化）和最终 PNG buffer，不是 `import`。**
2. **纯缓存在"第一波并发"上完全无效** —— 攻击形态恰恰是**并发同 key**：
   20 个请求同时打 `oak_planks.png`，缓存里都还没命中，**20 个请求会各跑一遍完整流水线**。
   这就是为什么**必须有 in-flight 合并**：同 key 只允许一个在跑，其余挂起等同一个 Promise。
3. **还需要并发上限 + 硬超时** —— finding 自己实测"10 秒不返回"，说明现在连超时都没有；
   只有合并、没有上限时，攻击者换 20 个**不同**物品名就能绕过合并。

**推荐形态（顺序很重要）**：
```js
// 模块级：只做一次
const factoryCache = new Map();                     // ver -> assets
function getAssets(ver) { if(!factoryCache.has(ver)) factoryCache.set(ver, mcAssetsFactory(ver)); return factoryCache.get(ver); }

const pngCache = new Map();                         // `${ver}/${name}` -> Buffer
const inflight = new Map();                         // 同 key 合并
let running = 0; const MAX_RUNNING = 4;

async function buildPng(ver, name) { /* 原逻辑，但用 getAssets(ver) */ }

app.get('/assets/item/:agent/:name.png', async (req,res) => {
    const name = String(req.params.name||'').toLowerCase();
    if (!/^[a-z0-9_]{1,64}$/.test(name)) return res.status(400).end();     // 已有（F-EXEC-203）
    const key = name;                                                    // ver 可在内部兜底
    if (pngCache.has(key)) return sendPng(res, pngCache.get(key));       // ① 命中直接给
    if (inflight.has(key)) return sendPng(res, await withTimeout(inflight.get(key), 8000)); // ② 合并
    if (running >= MAX_RUNNING) return res.status(429).end();            // ③ 并发上限
    running++;
    const p = withTimeout(buildPng(null, name), 8000)
        .then(buf => { pngCache.set(key, buf); return buf; })
        .finally(() => { inflight.delete(key); running--; });            // ④ 一定要 finally
    inflight.set(key, p);
    try { sendPng(res, await p); } catch { res.status(504).end(); }      // ⑤ 超时 504，别挂死
});
```
**四个要点**：①先查缓存 → ②再查合并 → ③再查并发上限 → ④`finally` 里**必须**清 `inflight` 与 `running`
（漏了就是内存泄漏 + 之后该 key 永久 429）→ ⑤超时给 `504` 而不是一直挂着。

### 3.2 顺带确认两件事（省得后人重查）
- **`F-EXEC-203` 的白名单已经在位**（`^[a-z0-9_]{1,64}$`，我 D2/D3 都核过）⇒ **非法名在进入昂贵路径之前就被 400 了**，
  所以 202 的"穿越请求打满 10 秒"那条实测，前提已经变了（现在会被 400 立刻拒）。
- **`F-WEB-202` 不必等 201**：合并+缓存+上限是**独立于鉴权**的治本手段。201 做完只是把它降级成"需 token 才能滥用"。

---

## 4. 给 patch-smith 的下单要点（按"最可能把面板弄死"排序）

| 优先 | 事项 | 为什么 |
|---|---|---|
| **P0** | `start-panel.ps1`：拿不到 token 时**别 Start-Process**；并给 token 文件读取加重试（~10s） | 否则 201 上线当天就白屏（§1.2 的确定失败路径） |
| **P0** | 决定 201 形态：**混合策略（外壳放行、`settings_spec.json` 与数据要 token）** 或 "全部要 token + 前端引导页" | 二选一，别留"401 纯文本当首页" |
| P1 | 202 采用 **in-flight 合并 + 版本记忆化 + 并发上限 + 8s 超时** | 光缓存对并发同 key 无效（§3.1） |
| P1 | 203 的桶键从 `socket.data` 改成 `remoteAddress`（或加全局桶） | 否则重连即重置 |
| P2 | 203 把桶也挂到 `create-agent` / `restart-agent` / `listen-to-agents` | finding 原文要求；`restart-agent` 比刷消息更伤 |
| P2 | favicon 加进 `PUBLIC_PATHS`；`?token=` 种完 cookie 后 302 去掉 | 减少日志噪音与 token 外泄面 |

---

## 5. 复核动作（可审计）

```
读：claimed/{F-WEB-201,F-WEB-202,F-WEB-203}.md；mindserver.js 的 100-165（三段中间件）、
    283-288（/console 静态 + SPA fallback）、530-570（send-message 校验与限流）、
    auth_gate.js:119-126（cookie 属性）、scripts/start-panel.ps1:200-215
跑：grep mindserver.js 的 401/PUBLIC_PATHS/安全头/nosniff/CSP/长度校验/限流 → 确认哪些已实现
    cat web/dist/index.html → 零内联脚本
    grep 'eval(' / 'new Function(' web/dist/assets/index-*.js → 均为 0（CSP 不需要 unsafe-eval）
    grep 全部 socket.on(...) → 22 个入站事件，**无 narrate**（回答"会不会误伤"）
    grep texCache|inflight|Promise.race|504 → 无（确认 202 未实现）
    git log --oneline（**不用 git status 判提交**）
未做：起真实例 curl 验 401/200（本会话不能 spawn、不能监听端口）；面板人工点击验证
```

---

## 6. 我自己的两处更正（captain 已指出，我一并写在这里）

1. **"13 个文件全部未提交"是我的错**，已核实 `git log`：`7ba7b5e / 9e7253c / d42f796 / c8df8ce / 7d15339 / 76ee07b`
   **六个 commit 都在**；真正仍未提交的只有两个：`src/agent/tasks/tasks.js`（F-EXEC-202 待重做）与
   `src/utils/text.js`（F-AI-201 死代码待接线）。
   **根因与 421 假 M 同类：我拿 `git status` 判"有没有提交"，而它会显示别人在途的改动。**
   已定规矩：**判提交一律 `git log --oneline -- <path>`**。
2. **`7ba7b5e` 标题写 F-DEP-004，实际还包含 F-DEP-003 的补丁对** —— 已按 captain 要求登记，
   不改写历史（rewrite 会让整条复核链失去锚点）。详见我在 `review-D1.md` 补的注记。
