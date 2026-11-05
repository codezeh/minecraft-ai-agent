# 复核 · captain 亲手写的三处补修

> 复核官：gate-keeper ｜ 2026-11-06 03:2x–03:4x
> 对象：`0ecc241`（mindcraft）/ `2e84818`（外层 start-panel）/ `f8496a9`（外层 停止面板）
> 立场：**captain 的代码也过同一道门。** 我按审 patch-smith 的同一套判据审，不放水；
> 但也不为了显得严而编问题 —— 下面每条都给出"**能到什么程度**"和"**为什么**"。

---

## 判决

| commit | 判决 | 一句话 |
|---|---|---|
| `2e84818` start-panel.ps1 | **通过，但有一处必须补** | 重试与 `exit 1` 都对；**但 `exit 1` 之后 java/mindserver 仍在后台跑，脚本却什么都没说** ⇒ 用户可能重复双击 → 双开/端口冲突 |
| `0ecc241` mindserver.js | **通过，两条建议** | HTML 401 与按来源限流都对；**清理逻辑在它声称防的场景里是空转**；`port` 插入 HTML 的理论注入面建议归一 |
| `f8496a9` 停止面板 | **通过** | token 取法、`Push-Location`、`exit 2/3` 分档全部正确，与 `start-panel` 三处口径一致 |

**结论：你的三个问题里，"内存被随机 address 打爆"实践上不成立（我给出原因）；"HTML 401 有没有注入面"网络不可达但建议加一行；"exit 1 会不会留孤儿"—— 这正是我唯一要求你改的地方。**

---

## 1. `2e84818`（start-panel.ps1）

### 1.1 你问：`for ($i = 0; $i -lt 20 -and -not $tok; $i++)` 语义对不对？—— **对**

PowerShell 里**比较运算符优先级高于逻辑运算符**，所以它等价于：
```powershell
for ($i = 0; ($i -lt 20) -and (-not $tok); $i++)
```
- `$tok` 为 `$null` → `-not $tok` = `$true` → 继续循环 ✅
- `$tok` 被赋值成非空字符串 → `-not $tok` = `$false` → **立即退出**（不是跑满 20 次）✅
- 每次失败 `Start-Sleep -Milliseconds 500`，最多 20 次 = **10 秒**，覆盖冷启动时序 ✅

### 1.2 你问：`Test-Path` 撞上"文件正被写入"会不会读到半截？—— **理论上有，实践上很小，但建议加一行硬判据**

风险链：Node 的 `writeFileSync` 是 `open(truncate) → write → close`，**不是原子操作** ⇒ 读取方可能落在"文件已存在但内容未写完"的窗口里。
你的 `if ($raw) { $tok = $raw.Trim() }` 只挡了**空文件**，**挡不住"读到前 10 个字符"** —— 那时 `$tok` 会被当成有效 token，拼进 `?token=`，然后被 401（虽然现在 401 是友好 HTML 了，但用户仍打不开面板）。

窗口有多小：token 是 `crypto.randomUUID()`，**恰好 36 字符**；一次 `write` 就是几十字节，通常在同一时间片内完成。但 Windows 上杀毒/索引器插入可以把这个窗口拉到毫秒级。

**建议（一行，把"理论风险"变成"不可能"）**：
```powershell
if ($raw) {
    $t = $raw.Trim()
    if ($t.Length -eq 36) { $tok = $t }      # UUID 长度硬判据；半截内容必然 ≠ 36
}
```
`crypto.randomUUID()` 的长度是固定的 36，所以这是个**零成本、决定性**的判据。比"读两次比对"更简单，也不会误伤。

### 1.3 你问：`exit 1` 之后，前面启动的 java / mindserver 会不会变成孤儿？—— **会是"无人管理的活进程"，而且脚本什么都没告诉用户**

我把 `start-panel.ps1` 的执行顺序过了一遍（token 块在**最后**）：

```
… 前面已经：Start-Process $java  -WorkingDirectory server      ← Minecraft 服务端已启动
… 前面已经：Start-Process $node main.js -WorkingDirectory mindcraft   ← mindserver 已启动
… Wait-BotSpawned 120                                          ← 已等到 bot 进游戏
… 然后才走到 token 块 → 拿不到 → exit 1
```

`Start-Process` 起的是**独立进程**，父脚本 `exit 1` **不会**带走它们。所以：

- **不是"孤儿进程"**（它们是正常启动、正常在跑的服务，不是泄漏的僵尸）；
- **但确实是"无人告知的活服务"** —— 而这条路径**恰好发生在 mindserver 起来之后**，所以服务器/ bot 很可能就在正常跑着；
- **实际危害是重复启动**：用户看到红色报错窗口，第一反应是"再双击一次 `启动面板.bat`" ⇒ **第二次 `Start-Process java` 撞端口 25565、第二次 `Start-Process node main.js` 撞 8080** ⇒ 两个进程报错退出或行为诡异，用户更懵。
- 另外 `exit 1` 也让脚本**跳过了末尾那段"怎么停止"的说明**（原文有"停止：双击 停止面板.bat（RCON 优雅关服，不会损坏存档）"）。

**这是我唯一认为"必须改"的地方。** 建议在该分支补两句（成本 2 行）：
```powershell
Write-Host '  [重要] Minecraft 服务端与 Mindserver **已在后台运行**（本脚本已启动它们）。' -ForegroundColor Yellow
Write-Host '         不要重复双击本脚本（会撞端口）。要停止请双击 停止面板.bat（RCON 优雅关服，不会损坏存档）。' -ForegroundColor Yellow
```

### 1.4 顺带一条（不是问题，是赞）
`$panelUrl = "$panel?token=$tok"` 只在**拿到 token 之后**才赋值，且 `Write-Step` 打印的是 `"打开面板"`（**不带 token**）⇒ **token 不会被打进控制台/日志**，与 F-SEC-205/F-RT-002 的意图一致 ✅
（`Start-Process $panelUrl` 仍带 token 交给浏览器，这是必须的。）

---

## 2. `0ecc241`（mindserver.js）

### 2.1 你问：`RATE_BUCKETS` 的清理（512 阈值 + 60 秒陈旧）有没有漏洞？会被"大量随机 address"打爆内存吗？

**结论分两层，两层都要说：**

**(a) 实践上打不爆 —— 因为只绑 loopback。**
```js
src/mindcraft/mindserver.js:634   const host = 'localhost';
src/mindcraft/mindserver.js:635   server.listen(port, host, …)
```
服务只监听 `localhost` ⇒ 所有连接的对端地址只能是 `127.0.0.1` / `::1`（`handshake.address`）
⇒ **`RATE_BUCKETS` 的 key 最多 2 个**，永远到不了 512。**这条担心可以放下。**

**(b) 但清理逻辑本身是"空转"的 —— 在你设想的那个场景里它一个都删不掉。**
```js
if (RATE_BUCKETS.size > 512) {
    for (const [k, v] of RATE_BUCKETS) { if (now - v.ts > 60000) RATE_BUCKETS.delete(k); }
}
```
- 触发条件是"超过 512 项"，清理条件是"**该项 60 秒没被更新**"。
  攻击者若在 60 秒内制造 600 个**新鲜** key ⇒ 全部 `now - v.ts < 60000` ⇒ **一个都删不掉**，`size` 停在 601，
  下一个新 key 继续加 ⇒ **无上限增长**。也就是说：这段代码**防不住它声称要防的那件事**，它防的是"长期不活跃的累积"。
- 附带性能问题：一旦 `size > 512`，**每一条 send-message 都要全表扫一遍** ⇒ O(n)，在 n 很大时是 O(n²) 的行为放大
  （虽然 (a) 说 n 到不了，但这段代码一旦被复用/被改绑到公网就是真问题）。

**建议（若要保持这段代码的正确性，改 2 行）**：把"时间清理"换成**硬上限 + 淘汰最旧**，或在超限时直接拒绝新 key：
```js
if (RATE_BUCKETS.size >= 512 && !RATE_BUCKETS.has(rlKey)) {
    // 先尝试清陈旧；仍然满则淘汰最旧一个（LRU 近似），保证 size 有硬上界
    for (const [k, v] of RATE_BUCKETS) { if (now - v.ts > 60000) RATE_BUCKETS.delete(k); }
    if (RATE_BUCKETS.size >= 512) { RATE_BUCKETS.delete(RATE_BUCKETS.keys().next().value); }
}
```
**这条我不按"打回"处理**（因为 (a) 让它不可达），但请把注释里"防 Map 无限增长"改成"防长期累积"，或者在代码里真的给它一个硬上界 —— **注释与行为要对得上**。

### 2.2 你问：HTML 401 里拼了 `port`，有没有 XSS / 注入面？—— **网络不可达；但建议加一行归一**

先看 `port` 从哪来（我溯到底了）：
```
main.js:45    settings.mindserver_port = process.env.MINDSERVER_PORT;
main.js:87    Mindcraft.init(false, settings.mindserver_port, settings.auto_open_ui);
                 ↓
mindserver.js:73  export function createMindServer(host_public = false, port = 8080)
```
⇒ **`port` 来自环境变量 `MINDSERVER_PORT`，不是 HTTP 请求参数** ⇒ 攻击者要注入必须先能改你的环境变量（那已经等于拿到本机权限）。
**所以：不存在可从网络触发的 XSS。** 你的担心可以放下。

**但有一个组合值得记一笔**：你同时把 CSP 放宽到了 `script-src 'self' 'unsafe-inline'`（见 §3）。
在放宽之前，即使 `port` 是脏字符串，注入的 `<script>` 也会被 CSP 拦掉；**放宽之后就不会了**。
两条单独都不可达，但**"不可达 × 不可达"不该被当成"安全"来依赖**。建议一行归一：
```js
const safePort = String(Number.parseInt(port, 10) || 8080);
… 'http://localhost:' + safePort + '/?token=…'
```
成本 1 行，把这条链彻底掐死，也让 future reader 不必重新推理一遍。

### 2.3 附带的两个小观察（低，供参考）
1. **日志伪造（低）**：`console.warn(\`… ${req.method} ${req.path}\`)` —— `req.path` 是**解码后**的，
   `%0A` 会变成真换行 ⇒ 可以伪造多行日志（往运维日志里塞假信息）。建议 `req.path.replace(/[\r\n]/g,'')`。
2. **401 的 HTML 里没有 CTA 链接**（只有 `<code>` 提示）——可选改进：把 `http://localhost:<port>/?token=<值>`
   做成 `<a>`，用户能直接点。不影响安全。

---

## 3. CSP 放宽（`script-src 'self' 'unsafe-inline'`）—— **理由成立，但建议按路径收紧**

### 3.1 你的理由我实测复核过：**成立**
```
$ grep -oE "<script>" src/mindcraft/public/index.html | wc -l   → 1     （1 个内联 script）
$ grep -oE "onclick=" src/mindcraft/public/index.html | wc -l   → 15    （15 个内联事件属性）
```
⇒ **旧控制台（`express.static(public)` 服务的 `/`）确实会被 `script-src 'self'` 打死**：按钮全失灵、页面变白。
所以"放宽 or 旧控制台报废"这个二选一里，你选放宽是**对的选择**，而且你在注释里如实交代了这是**故意放宽**（这点我很认可——比偷偷放宽强一百倍）。

同时我的 dist 实测结论仍然有效并可用来支撑你的判断：
`web/dist/index.html` **零内联脚本**、bundle `eval(`=0 / `new Function(`=0 ⇒ **新面板根本不需要 `unsafe-inline`**。

### 3.2 建议（可选，成本约 3 行）：**按路径下发不同的 CSP**
既然新面板不需要 `unsafe-inline`、旧控制台需要，就不要让整站一起降级：
```js
const isLegacy = !req.path.startsWith('/console');
res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    (isLegacy ? "script-src 'self' 'unsafe-inline'; " : "script-src 'self'; ") +
    "connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'");
```
收益：**新面板（用户天天用的那个）保留 `script-src 'self'` 的原防护**，只有旧控制台降级；
代价：约 3 行，且不需要改任何 HTML。**不做也不算错**（你已在注释里登记为"后续可选加固"），但这是今晚就能拿到的额外安全。

---

## 4. `f8496a9`（停止面板）—— 通过

```js
// web/scripts/stop-all.mjs
function readToken() {
    if (process.env.MINDSERVER_TOKEN) return process.env.MINDSERVER_TOKEN.trim();   // ① env 优先
    try { return readFileSync(path.join(process.cwd(), '.mindserver-token'), 'utf8').trim(); }  // ② cwd 文件
    catch { return null; }
}
if (!token) { …"这**通常不是** mindserver 没开：请从 mindcraft/ 目录运行本脚本"…; process.exit(2); }
```
```powershell
# scripts/stop-panel.ps1
Push-Location (Join-Path $root 'mindcraft')
try { & $node $script; $stopCode = $LASTEXITCODE } finally { Pop-Location }
if ($stopCode -eq 2) { '[未完成] 拿不到握手 token。服务器仍在运行，请不要直接关窗口（会丢未刷盘的存档）。' }
if ($stopCode -eq 3) { '[未完成] 握手被拒（token 已过期）。…请重跑本脚本而不是强关。' }
```
逐项核过：
- **token 取法** 与 `start-panel.ps1` 读的是**同一个文件路径**（`mindcraft/.mindserver-token`）✅ 三处口径一致。
- **`Push-Location` + `finally Pop-Location`** ⇒ 异常也能复位 cwd ✅（比不带 try/finally 的写法稳）。
- **`$LASTEXITCODE`** 取原生进程退出码，正确 ✅。
- **exit 2/3 分档**把"拿不到 token"/"token 过期"/"真没开"三件事分开，且都警告"**服务器仍在运行，不要关窗口**" ——
  这正是 F-WEB-205 的**核心诉求（别让用户硬关导致存档未刷盘）**，做到了 ✅

**唯一 caveat（与我 D5 复核一致）**：真实"RCON stop 优雅关服"只能**用户早上点一次**验证，我起不了真实例。

---

## 5. 我要不要打回？

**不打回。** 三条 commit 的**修复方向、实现、注释诚实度**都合格，且我能看出你吸收了预审意见（按来源限流、不打开裸面板、401 改 HTML）。

**但有 1 项请你在收工前补上（2 行）**：
> **`start-panel.ps1` 的 `exit 1` 分支要告诉用户"服务器已在后台运行、别重复双击、停止请用 停止面板.bat"。**

理由：那条路径**发生在 java 与 mindserver 都已启动之后**，而脚本静默退出 + 跳过"怎么停止"的说明 ⇒
用户的自然反应是再双击一次 ⇒ **撞端口双开**。这不是安全漏洞，但它是**这条修复自己制造的新困惑**，
而且和 F-WEB-205 想解决的"用户乱关窗口"是同一类问题。

另有 3 条"建议"（不做也行，但都不贵）：
1. token 读取加 `$t.Length -eq 36` 硬判据（把半截读取从"理论"变成"不可能"）；
2. `RATE_BUCKETS` 给硬上界，或把注释改成"防长期累积"（**注释与行为要对得上**）；
3. `port` 用 `Number.parseInt` 归一；CSP 按路径收紧到"新面板不放宽"。

---

## 6. 复核动作（可审计）

```
读：git show 0ecc241 / 2e84818 / f8496a9 全文 diff 与 commit body
    mindserver.js 的 105-150（三段中间件 + HTML 401）、572-592（限流）、128-142（CSP）、634-635（bind）
    scripts/start-panel.ps1:200-230、scripts/stop-panel.ps1:14-40、web/scripts/stop-all.mjs:1-40
跑：grep 验证 public/index.html 内联 script=1、onclick=15（CSP 放宽理由成立性）
    grep 溯源 port 来源（main.js:45/87 → createMindServer 形参）
    grep 确认 host='localhost'（RATE_BUCKETS 不可能被多地址打爆）
    node --check src/mindcraft/mindserver.js（早前已跑，SYNTAX_OK）
未做：起真实例做 E2E（node 不能 spawn）；双击面板/停止面板的人工冒烟（归用户）
```

## 7. 一句总结
**你这三处补修，代码质量和注释诚实度都在标准线上；我把"三个担心"逐条判了：两个实践上不成立（附原因），
一个是真的（`exit 1` 后服务仍在跑却没告知用户）。请补那 2 行，其余三条建议你按体力取舍。**
