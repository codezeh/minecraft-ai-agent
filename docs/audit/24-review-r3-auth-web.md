# 终审 R3③ · 认证与面板面（F-WEB-101/201~205 + F-SEC-104/205/206/208/209 + token 流向）

> 对象：`mindcraft` 分支 `audit/night-20261106` @ **HEAD `bdba2e6`**；外层仓 `E:\我的世界ai`（52 个提交，本轮首次为独立仓）。
> 规程：`docs/audit/REVIEW-PROTOCOL.md`（三态标注 + 反向覆盖）。必读已读：`REVIEW-PROTOCOL.md`(187)、`night/PLAYBOOK.md`(305)、`night/NIGHT-REPORT.md`(508)。
> 时刻 2026-11-06 09:26~09:45，Node v24.16.0。
> **未改 `mindcraft/` 任何文件**：`git status --porcelain` 为空；实验只在 `docs/audit/probes/r3/`（已清空）。

> **前提校正**：`NIGHT-REPORT.md` 是 **02:45 快照**，而 HEAD 是 `bdba2e6`（更晚）。本次全部按 **HEAD 实际代码**判定；
> 凡"报告说没做、HEAD 已做"的，一律判**报告过时**（不是代码缺陷），并在表中标出。

## 0. 判定总表

| Finding | 报告原判（02:45 快照） | HEAD 实测 | 三态 |
|---|---|---|---|
| **F-WEB-202** 贴图代理 | ⚠️ 部分：**同 key 合并仍未做** | ✅ **已做**（`TEX_INFLIGHT` 同 key 复用 Promise + `finally` 清理 + 300 上限缓存 + 8s 硬超时）→ **报告过时，`bdba2e6` 标题属实** | **已实测**（读码 + 结构验证） |
| **F-WEB-201** HTTP 门 + 安全头 | 已修 | ✅ token 门在服务端 `app.use`；4 头 + `x-powered-by` 关；CSP 保留 `'unsafe-inline'` 是**有据**的；start-panel 重试/不打开/exit 1 全在；**复核席必补的 2 行提示已补** | **已实测 / 静态确证** |
| **F-WEB-203** 限流 | 已修（按地址共享） | ✅ 按远端地址共享 + 四事件 + msg≤2000；⚠️ **硬上界仍未给**（`size>512` 只是清理触发条件，非上限；注释自称"容量上限"与行为不符）→ **复核席必补项未补** | **已实测（静态确证行为）** |
| **F-WEB-204** 绝对路径 | 已修 | ✅ 三处 `path.basename()` 全在（`434`/`442`/`460`），响应里不再有绝对路径 | 静态确证 |
| **F-WEB-205** 停止面板 | 已修 | ✅ `stop-all.mjs` 取 token（env → `./.mindserver-token`）→ `auth:{token}`；退出码 **2/3 分开**；`stop-panel.ps1` 有 `pushd` + 两条"别关窗口（会丢未刷盘存档）" | 静态确证 |
| **F-WEB-101** bot 台词伪造 | 已修 | ✅ `bot-output`/`agent-event` 服务端判 `socket.handshake.auth.token === handshakeToken`，否则丢弃并 warn | 静态确证 |
| **F-SEC-104** 贴图名穿越 | 已修（红队复测打不进） | ✅ 白名单 `/^[a-z0-9_]{1,64}$/` 在 `toLowerCase()` 之后、拼路径之前（`mindserver.js:363`） | 静态确证 |
| **F-SEC-205** token 进日志 | 已修 | ✅ 只打指纹（首4…末4 + len）；完整值仅在 `MINDSERVER_PRINT_TOKEN=1` **且 stdout 是交互终端**时打 | **已实测** |
| **F-SEC-206** gitignore 兜底 | 已修（D2 打回后补 config.local.js） | ⚠️ **主体已补**，但 **`*.token` 与 `config.local.ts` 两仓都漏**（实测 MISS） | **已实测** |
| **F-SEC-208** 「白名单=安全」论断 | 已更正 | ✅ `tools/server-net.mjs:9-20` + `config/network.json:6` 都改写为"白名单挡别人、不挡伪装成你"，**更正内容正确** | 静态确证 |
| **F-SEC-209** `broadcast-rcon-to-ops` | 已修（D2 打回：example 未同步） | ✅ `server/server.properties.example:7` 已是 **`false`**；`rcon.password=CHANGE_ME`（无真凭据） | **已实测** |
| **F-RT-001** token 文件 ACL | medium（0600 在 Windows 无效） | ⚠️ **实测确认**：`mode:0o600` → 磁盘 `-rw-r--r--`，ACL 含 `Authenticated Users: Modify` / `Users: ReadAndExecute` | **已实测** |
| **F-RT-002** PRINT_TOKEN 绕过 | 已修 | ✅ 判据正确（`fstatSync(1).isFile() || !isTTY` → 忽略）；仅交互终端才打全值 | **已实测** |
| **F-RT-003** token 302/残留 | 已修 | ✅ 302 抹 `?token=`（只留其它 query）；退出时 `unlink` token 文件（`process.once('exit')` + SIGINT/SIGTERM） | 静态确证 |
| **F-RT-005** patch timeout 500 | low（当时**未入库**） | ✅ **已入库**：`patches/mineflayer+4.39.0.patch:26-27` `timeout: 5000` → `500`，工作区干净 | **已实测** |

**统计：15 条中 12 条成立（含 3 条"报告过时、实际已修"）、2 条部分（F-WEB-203 硬上界 / F-SEC-206 两模式漏）、1 条为真实缺陷（F-RT-001，风险已诚实标注）。**

---

## A. `F-WEB-202` 矛盾定案：**同 key 合并做了，报告过时**

**说法冲突**：NIGHT-REPORT（02:45）说「缓存/同 key 请求合并仍未做 ⇒ 部分解决，别标已修」；HEAD 最后一提交 `bdba2e6` 标题说「贴图代理**同 key 合并**+硬超时」。

**读码定案**（`src/mindcraft/mindserver.js:277-351`）：

```js
const TEX_INFLIGHT_MAX = 4;      // 并发上限
const TEX_TIMEOUT_MS = 8000;     // 硬超时
const TEX_CACHE_MAX = 300;
const TEX_CACHE   = new Map();   // key -> Buffer|null（null = 确认找不到）
const TEX_INFLIGHT = new Map();  // key -> Promise<Buffer|null>

async function getTexture(itemName, candidates) {
    const key = `${candidates.join('|')}:${itemName}`;
    if (TEX_CACHE.has(key)) return TEX_CACHE.get(key);
    if (TEX_INFLIGHT.has(key)) return TEX_INFLIGHT.get(key);      // ① 同 key 合并
    if (TEX_INFLIGHT.size >= TEX_INFLIGHT_MAX) { …TEX_BUSY… }     // ② 并发上限
    const task = (async () => {
        try { …await Promise.race([fetchTextureBuffer(...), timeout])… }
        finally { clearTimeout(timer); TEX_INFLIGHT.delete(key); }  // ③ 清理
    })();
    TEX_INFLIGHT.set(key, task);
    task.catch(() => { });          // 防 unhandled rejection 带走进程
    return task;
}
```

**四条结构性证据**（比"有这行代码"更硬）：

1. **合并的是 Promise，不是结果**：`TEX_INFLIGHT.has(key) → return 同一个 Promise`，所以 20 个并发同 key 请求共享**一次**流水线 —— 正是"第一波并发"场景（纯缓存在这里确实无效，报告的预审判断正确，但实现已经用了正确的手法）。
2. **`fetchTextureBuffer` 不碰 `res`**（`:292` 注释写明"这样才能被同 key 合并复用"）—— 拆分了"取图"与"写响应"，这是合并能成立的前提。
3. **`finally` 里 `TEX_INFLIGHT.delete(key)`**（`:345`），并注释"漏这行 = 该 key 永久 503 + 内存泄漏" —— 超时/异常路径也会清理，不会永久卡死。
4. **超时不写缓存**（`:371-377` 走 504 且不 `TEX_CACHE.set`），下次还能重试。

**单人复核要点（可复跑）**：`grep -n "TEX_INFLIGHT" src/mindcraft/mindserver.js` → 定义 1 处 + `has/get/set/delete` 各 1 处，无遗漏。

**判定：✅ 同 key 合并已实现；NIGHT-REPORT 的"部分解决"是 02:45 快照的历史结论，已过时。`bdba2e6` 标题没撒谎。**
**处置：更新 NIGHT-REPORT 该项结论为"已解决"，并把"别标已修"这句撤掉。**

---

## B. `F-WEB-201` HTTP token 门 + 安全头

| 子项 | 结果 | 证据 |
|---|---|---|
| ① token 门在**服务端** | ✅ | `mindserver.js:143` 起 `app.use`，在 `express.static`(`:275`) / `/console`(`:403`) **之前**；判据 `hasAuthCookie || req.query.token === handshakeToken` |
| ② 4 头 + `disable('x-powered-by')` | ✅ | `:174` `app.disable('x-powered-by')`；`:176-190` `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`Content-Security-Policy`（含 `frame-ancestors 'none'`、`base-uri 'none'`） |
| ③ CSP 会不会打死面板 | ✅ **不会，且放宽有据（已独立核数）** | CSP 为 `default-src 'self'; …; script-src 'self' 'unsafe-inline'`。注释（`:181-189`）称旧 `public/index.html` 有「1 个内联 `<script>` + 15 个 `onclick=`」—— **我实测复核：`grep -oE "onclick=" src/mindcraft/public/index.html \| wc -l` → `15`；`:464` 处确为无 `src` 的内联 `<script>`** ⇒ 若收紧成 `script-src 'self'`，旧控制台按钮与那段脚本全废。而 `web/dist/index.html` **内联 script/onclick = 0**、`web/src` **零 `eval(`/`new Function(`/`v-html`/`innerHTML`** ⇒ 新面板本可在 `'self'` 下工作；放宽只为旧面板，且 `default-src 'self'` 仍挡住外链脚本 |
| ④ start-panel 重试 | ✅ | `scripts/start-panel.ps1:209` `for ($i = 0; $i -lt 20 -and -not $tok; $i++)`，`:216` `Start-Sleep -Milliseconds 500`；`:214` 用**定长 36** 做硬判据（防读到半截）；拿不到 → `:224` 明说"**没有**打开面板"+ 排查方法 + `:231 exit 1` |
| ⑤ **复核席必补项**（2 行提示） | ✅ **补了** | `:229-230`：「**[重要] Minecraft 服务端与 Mindserver 已在后台运行（本脚本已启动它们）。不要重复双击本脚本（会撞端口）。要停止请双击 停止面板.bat（RCON 优雅关服，不会损坏存档）。**」—— 文字和复核席要求的两点（别重复双击 / 怎么停）**逐条对上**，且放在 `exit 1` **之前** |

**判定：B 项 5/5 全部成立，含必补项。**

> 附带核实（`F-RT-002` 的根因）：`start.bat:127` 现在写的是「这里**曾经**建议用户设 `MINDSERVER_PRINT_TOKEN=1` —— 但本脚本的 stdout 会被……」，`:130` 明确输出 `NOTE: do not use MINDSERVER_PRINT_TOKEN here (stdout is redirected; token would land in logs).` ⇒ **"推荐用户开这个开关"的源头已拔掉**，与代码侧 C2 的忽略逻辑形成双保险。

---

## C. token 流向（`F-SEC-205` / `F-RT-001/002/003`）

### C1 存哪 / 谁读 / 谁能看

| 项 | 实测 |
|---|---|
| 存储 | `TOKEN_FILE = path.join(process.cwd(), '.mindserver-token')`，`writeFileSync(..., {mode: 0o600})`（`mindserver.js:124-126`） |
| 生命周期 | **退出即删**：`process.once('exit', cleanupTokenFile)` + SIGINT/SIGTERM 各自 `unlinkSync`（`:132-139`） |
| git 覆盖 | **两仓都忽略**：`mindcraft/.gitignore:90`、外层 `.gitignore:126` 均有 `.mindserver-token` |
| 谁能看 | ⚠️ **任何本机已认证用户可读可改** —— 见 C5（实测 ACL） |

### C2 `F-RT-002` 判据是否正确（能否绕过）

```js
if (process.env.MINDSERVER_PRINT_TOKEN === '1') {
    let stdoutIsFile = false;
    try { stdoutIsFile = fstatSync(1).isFile(); } catch { /* 取不到就当不是文件 */ }
    if (stdoutIsFile || !process.stdout.isTTY) {
        console.warn('…忽略 MINDSERVER_PRINT_TOKEN：stdout 不是交互终端…');
    } else {
        console.log(`…完整值: ${handshakeToken}`);   // 仅交互终端
    }
}
```
**判据正确且偏保守**：
- 重定向到**文件** → `isFile()=true` → 忽略 ✓（正是 start-panel 的场景）
- 管道 / 非 TTY → `!isTTY` → 忽略 ✓
- 唯一放行的是**真交互终端**。此时 token 进的是终端回滚缓冲，**不落盘**——与"别再进日志文件"的目标一致。
- `fstatSync` 抛错时按"不是文件"处理，但下一道 `!isTTY` 仍会拦住非 TTY，因此**没有可利用的绕过路径**。

### C3 `F-RT-003` 302 抹除 + 日志

```js
if (req.method === 'GET') {
    const rest = { ...req.query }; delete rest.token;
    const qs = new URLSearchParams(rest).toString();
    res.redirect(302, req.path + (qs ? `?${qs}` : ''));
}
```
已实测 `sed -n 152,162p`：**Location 只带非 token 的 query** ✓。
另外 `grep -n "morgan|access log|req.originalUrl"` → **无请求日志中间件** ⇒ token 不会经访问日志落盘 ✓。
拒绝日志用的是 `safePath = req.path`（**不含 query**）+ 去 `\r\n\t`（防日志行伪造），`mindserver.js:199-200` ✓。

### C4 全仓 token 打印点巡检（已实测）

`grep -rnE "console\.(log|warn|error)\(.*(token|Token|TOKEN)" src/ main.js tools/*.mjs` 共 12 处，逐条判定：

| 位置 | 打的是什么 | 判定 |
|---|---|---|
| `mindserver.js:732` | `${tokenHint}` = 首 4 + `…` + 末 4 + `(len=36)` | ✅ 仅指纹 |
| `:733` | 文件路径 / 环境变量名 | ✅ |
| `:734` | `…/?token=<见上>` | ✅ 占位符 |
| `:744/745` | "已忽略该开关" + "请读文件" | ✅ |
| `:747/748` | 完整值 + 完整 URL | ✅ **仅交互终端调试模式**（C2） |
| `:200` | `safePath`（`req.path`，无 query） | ✅ |
| `:129` | 写文件失败的告警，只提环境变量名 | ✅ |
| `:696` | 丢弃伪造 bot-output 的 warn，只打 `agentName` | ✅ |
| `mindserver_proxy.js:58` | 握手被拒的错误文（不含 token） | ✅ |
| `groq.js:44` | 无关（max_tokens 弃用警告） | ✅ |
| `unreachable_guard_audit.mjs:421` | `h.token` = **代码标识符**，非凭据 | ✅ |

**结论：没有任何一处把完整 token 打进日志。**

### C5 `F-RT-001` 实测：`mode:0o600` 在 Windows 上**真的无效**

```bash
$ node -e 'require("fs").writeFileSync("acl_probe.txt","x",{mode:0o600})'
$ ls -l acl_probe.txt
-rw-r--r-- 1 zeh 197609 1 Nov  6 09:32 acl_probe.txt          ← 644，不是 600
$ powershell -NoProfile -Command "(Get-Acl 'acl_probe.txt').AccessToString"
S-1-4-48068235-1068318981 Allow  DeleteSubdirectoriesAndFiles, Write, Delete, Synchronize
BUILTIN\Administrators Allow  FullControl
NT AUTHORITY\SYSTEM Allow  FullControl
NT AUTHORITY\Authenticated Users Allow  Modify, Synchronize      ← 可改
BUILTIN\Users Allow  ReadAndExecute, Synchronize                 ← 可读
```
**→ 红队 F-RT-001 的论断成立**（探针已删，未留任何凭据）。
**风险评估**：单人机器 ≈0（只有你自己一个账户）；**多用户机器成立**（另一个本地账户可读到 token ⇒ 完全控制 mindserver；可写 ⇒ 可删/改导致面板"打不开"且极难排查）。
**代码侧已诚实标注**（`:120-121`「mode 0600 只在 POSIX 生效…不是权限边界」），但**无缓解**。
**最小修复**：启动时 `icacls` 收紧到 当前用户 + SYSTEM + Administrators（`/inheritance:r`），或改用 `MINDSERVER_TOKEN` 环境变量通道并**不落盘**。

---

## D. `F-WEB-101`：bot 台词伪造 —— 服务端判据

```js
socket.on('bot-output', (agentName, message) => {
    if (!(typeof socket.handshake?.auth?.token === 'string'
          && socket.handshake.auth.token === handshakeToken)) {
        console.warn(`[mindserver] 丢弃伪造的 bot-output …`);
        return;
    }
    io.emit('bot-output', agentName, message);
});
socket.on('agent-event', …同款判据…);
```
**判定：✅ 是服务端判据**（`mindserver.js:692-712`），不是前端限制。
**为什么这条判据能区分 agent 与面板**（`auth_gate.js` 的四种凭据来源 + 注释 `:694-696` 说明）：
agent 子进程走 `auth:{token}`；面板走 `HttpOnly` cookie（`web/src/api/socket.ts` 不带 auth payload）⇒ 两类连接可区分。
**残余说明（诚实）**：面板若哪天改成带 `auth:{token}`，这条区分就退化。当前实现如此，属可接受的取舍。

---

## E. `F-WEB-203`：限流（**复核席必补项未补**）

### E1 已成立的部分

| 项 | 实测 |
|---|---|
| 按**远端地址**共享（跨连接，重连不清零） | ✅ `key = \`${label}@${addr}\``，`addr = socket.handshake.address \|\| socket.conn.remoteAddress`（`:84-85`） |
| 令牌桶（按时间比例回填） | ✅ `rl.tokens = Math.min(capacity, rl.tokens + (Δ/window)*capacity)`（`:92`） |
| 四事件统一限流 | ✅ `create-agent` 5/60s、`restart-agent` 3/60s、`send-message` 30/10s、`listen-to-agents` 10/60s（`:491/611/678/716`） |
| message ≤ 2000 | ✅ `if (typeof data?.message === 'string' && data.message.length > 2000) → 拒绝`（`:670-671`） |

### E2 **未补的部分（复核席原话逐字对照）**

复核席的问题：「清理逻辑在它声称防的场景里**空转**（513 个新鲜 key 全 <60s，一个都删不掉），且 `size>512` 时**每条消息全表扫**」；要求是**给硬上界**。

HEAD 实际代码（`mindserver.js:86-91`）：
```js
// 容量上限：防 Map 长期累积（本仓只绑 localhost，key 其实只有 2 个；这条是给"将来放开绑定"兜底）
if (RATE_BUCKETS.size > 512) {
    for (const [k, v] of RATE_BUCKETS) { if (now - v.ts > 60000) RATE_BUCKETS.delete(k); }
}
```
**逐条判**：
1. **仍然只有"清理"，没有"上限"**：`size > 512` 只是**触发一次全表扫**的条件，扫完可能**一个都不删**（513 个新鲜 key 全 <60s）。下一轮同样如此 ⇒ 复核席说的"空转 + 每条消息全表扫"**原样存在**。
2. **注释与行为不符**：注释写「容量上限」，但代码**不设容量**，`RATE_BUCKETS.size` 可无限增长。这正是"注释声称做了、其实没做"的老毛病。
3. **实际风险很低（须说清，别夸大）**：key = `label@addr`，label 只有 4 个；本仓 `host='localhost'` ⇒ addr 最多 2 个 ⇒ **key 上限 ≈ 8**，永远到不了 512。**只有在放开绑定（局域网/公网）时才可能被外部 IP 撑大**，而那正是注释想兜的场景。
4. **不修会怎样**：放开绑定后，攻击者用大量源 IP 发消息 → Map 涨到 >512 后**每条消息 O(n) 全表扫**，且扫不掉新鲜条目 ⇒ 单核 CPU 被打满（自我 DoS）。

**最小修复（3 行）**：把"触发清理"改成"硬上界 + 淘汰最旧"：
```js
if (RATE_BUCKETS.size >= 512 && !RATE_BUCKETS.has(key)) RATE_BUCKETS.delete(RATE_BUCKETS.keys().next().value);
```
并同步改注释（"硬上界 512，满了淘汰最早插入的 key"）。

**判定：F-WEB-203 主体成立，复核席的必补项（硬上界）**❌**未补**，且注释与行为不符。**

---

## F. `F-WEB-204`：绝对路径外泄 —— 三处都在

```
mindserver.js:434   path: path.basename(full)      ← get-profiles 正常分支
mindserver.js:442   path: path.basename(full)      ← get-profiles 解析失败分支
mindserver.js:460   path: path.basename(full)      ← get-profile
```
**判定：✅ 三处 `path.basename()` 全在**，响应里不再有本机绝对路径（`grep -n "path: full"` → 0 命中）。
**保留项说明**：`get-profile` 仍返回 `raw`（profile 全文）—— 这是面板"选 profile 即填表单"的功能需求，且整条链已在 token 门后。**不算未修**，但应在报告里写明"绝对路径已消除、内容仍需读 profile"。

---

## G. `F-SEC-206` / `208` / `209`

### G1 `.gitignore` 兜底规则 —— **实测有 2 个漏**

两仓规则（`mindcraft/.gitignore:78-90`、外层 `.gitignore:115-127`）：
`.env`、`.env.*`、`!.env.example`、`*credentials*.json`、`*secrets*.json`、`config.local.js`、`.mindserver-token`（外层另有 `id_rsa` 等）。

**实测（`git check-ignore`，两仓各跑一遍）**：

| 文件 | mindcraft | 外层 | 说明 |
|---|---|---|---|
| `.env` / `.env.local` / `.env.production` | ✅ / ✅ / ✅ | ✅ / ✅ / — | `.env.local` 由 `.env.*` 覆盖 ✓（任务点名的第一种**已覆盖**） |
| `secrets.json` / `credentials.json` | ✅ / ✅ | ✅ / ✅ | |
| `config.local.js` | ✅ | ✅ | D2 打回后已补 ✓ |
| **`config.local.ts`** | ❌ **MISS** | ❌ **MISS** | `config.local.*` 只覆盖了 `.js`（任务点名的第三种**漏**） |
| **`app.token` / `my.token`** | ❌ **MISS** | ❌ **MISS** | `*.token` 未覆盖（任务点名的第二种**漏**） |
| `id_rsa` | ✅ | ✅ | |
| `keys.json` | ✅ | — | 仅在 mindcraft 子仓（合理） |
| `.env.example` 不被忽略 | ✅ | ✅ | 例外生效 ✓ |

**判定：`F-SEC-206` 主体成立（8/9 → 补 config.local.js 后 9/9），但 `*.token` 与 `config.local.*`（非 `.js`）两仓都漏。**
**最小修复**：两仓各加 2 行 —— `*.token`、`config.local.*`（后者可替代 `config.local.js`）。
**风险**：低（本项目实际只产生 `.mindserver-token`，它已被具名覆盖）。但它正是**"兜底规则"的意义所在**：兜底就是防"下一个没预料到的名字"。另按红队 F-RT-004 的边界：gitignore 是"防手滑"不是"防恶意"（`git add -f` 可穿透），真正的护栏是 pre-commit。

### G2 `F-SEC-208`：更正「白名单=安全边界」

被更正的两处（都已改）：
- `mindcraft/tools/server-net.mjs:9-20`：新增「★ 关键认知（2026-11-06 审计更正：原来这里写的是错的）：**白名单不是万能的 —— 它挡"别人"，不挡"伪装成你"**」，并给出完整推理链（离线模式 → 只认自报名字 → 名单只有 HEAVENZEH → `my-local.json` 的 owner 也是 HEAVENZEH → 改游戏名即可冒充 → 拿 OWNER 级权限含 `!newAction`）。
- `config/network.json:6`：旧文案"名单内的人才进得来"改为「只挡名单外的人；**挡不住冒用 HEAVENZEH 这个名字**」。

**核实更正是对的**：离线模式（`server.properties:38 online-mode=false`）**确实不做 Mojang 验证**，白名单校验的是**名字**；`ops.json` 341 个 op bot 与 `my-local.json` 的 `owner: HEAVENZEH` 都在（审计③/⑩ 已核）。⇒ **原论断「白名单=安全边界」是错的，更正是对的。**
**判定：✅ 成立。**

### G3 `F-SEC-209`：example 已同步（D2 的打回已落实）

```
server/server.properties.example:7   broadcast-rcon-to-ops=false     ← D2 打回时是 true
server/server.properties.example:14  enable-rcon=true
server/server.properties.example:46  rcon.password=CHANGE_ME         ← 无真凭据 ✓
```
**判定：✅ D2 的 requiredFix（改 example 一行 + 提交）已做**；example 里无真凭据。
真实 `server/server.properties` 仍被 `.gitignore:74` 排除（`git check-ignore` 命中）⇒ 仓库里唯一可见参照指向**安全值**，这个方向是对的。
> 关于"config.local.js 兜底：核实两仓都补了" —— 已补（G1 表 ✅）。**但仓库里并不存在 `config.local.example.js`**（`find` 零命中），所以"example 参照值不含真凭据"这条在 config.local 上无从谈起；实际带 example 的凭据文件只有 `server.properties.example`，上表已核为 `CHANGE_ME`。

---

## H. 越界与凭据安全（独立复核，不转述报告）

### H1 两仓本晚触碰的文件是否在允许范围

**mindcraft**（`git diff --name-only main..HEAD`，按目录归并）：
```
11 src/    5 tools/    3 patches/    1 start.bat    1 package.json    1 .gitignore
```
→ **全部落在允许清单内**（`src/`、`tools/`、`patches/`、`package.json`、`start.bat`、`.gitignore`）。

**外层仓**（`git log --name-only --since="2026-11-05 20:00"`）：
```
docs/…（181 条，含 docs/audit-执行/ 与 docs/audit/night/）  ✓ docs/
config/network.json                                        ✓ config/
server/server.properties.example                           ✓ server/*.example
.gitignore                                                 ✓
scripts/start-panel.ps1                                    ⚠ 不在清单内
scripts/stop-panel.ps1                                     ⚠ 不在清单内
web/scripts/stop-all.mjs                                   ⚠ 不在清单内
文件/交接文档.md                                            ⚠ 文档，但不在 docs/
```
**判定：无"实质性越界"** —— 三个 ⚠ 项都是**被指派 finding 的必需改动**：
`scripts/start-panel.ps1` ← F-SEC-205（读 token）；`scripts/stop-panel.ps1` + `web/scripts/stop-all.mjs` ← F-WEB-205（停止面板）。
它们的"不在清单内"暴露的是**允许清单写窄了**（清单是照 mindcraft 仓写的，没算外层仓的运维脚本）。建议把 `scripts/`、`web/scripts/*.mjs`、`文件/` 补进清单，否则下一轮会把必需改动误判成越界。

### H2 有没有碰敏感文件 —— **没有**

```
$ git diff --name-only main..HEAD | grep -iE "keys\.json|server\.properties|backups/|logs/|\.mindserver-token"
（空）
$ git log --name-only --since="2026-11-05 20:00" | grep -iE "keys\.json|server\.properties$|backups/|logs/|\.token"
（空）
```
另核：`git ls-files | grep server.properties` → **1 条**，且就是 `server.properties.example`；真实 `server.properties` 被 ignore ✓。
`.mindserver-token` 当前**不存在于磁盘**（mindserver 未运行 + 退出即删）✓。

### H3 docs 里有没有明文 rcon 口令 / API key —— **零命中**（这轮最关键的自验）

做法：从真实文件读值到 shell 变量，**只输出命中数，绝不打印值**。

```
$ PW=$(grep -E "^rcon.password=" server/server.properties | cut -d= -f2- | tr -d '\r')   # 长度=32
$ grep -rlF "$PW" docs/ | wc -l                                    → 0
$ git grep -lF "$PW" | wc -l  /  (cd mindcraft && git grep -lF "$PW" | wc -l)   → 0 / 0

$ K=$(…keys.json 的 OPENAI_API_KEY…)                                # 长度=67
$ grep -rlF "$K" docs/ | wc -l                                     → 0
$ git grep -lF "$K" | wc -l  /  (cd mindcraft && git grep -lF "$K" | wc -l)     → 0 / 0
```
**→ 复核席两次把明文 grep 进会话输出这件事，没有污染任何文件。**
旁证：docs 里出现 `rcon.password` 的行全是**叙事或占位**（`CHANGE_ME`、`got=abc` 单测夹具、"明文再次打进会话输出"的事件描述），无一为真值。
**判定：✅ 无新的 docs 泄露。**

### H4 一条正面结论（顺带核实）

**外层仓本轮变成了独立 git 仓**（52 个提交，`.git` 存在）。审计⑥当时记录"外层整棵树无版本控制、`server.properties` 与 docs 无第二份历史" —— 这条**已被解决**。这是本轮值得记下的实质改善。

---

## 矛盾专章：`F-WEB-202` 的定案与处置

| 来源 | 说法 | 结论 |
|---|---|---|
| `NIGHT-REPORT.md:444`（02:45） | 「缓存/同 key 请求合并仍未做 ⇒ **部分解决，别标已修**」 | **过时**（快照早于 `bdba2e6`） |
| `bdba2e6` 提交标题 | 「贴图代理**同 key 合并**+硬超时」 | **属实** |
| **HEAD 代码** | `TEX_INFLIGHT` 同 key 复用 Promise + `finally` 清理 + 8s 超时 + 300 缓存 | **已实现** |

**定案：不是"标题撒谎"，是"报告过时"。**
**处置（给主编）**：把 NIGHT-REPORT 该项从「⚠️ 部分」改为「✅ 已解决（`bdba2e6`）」，并删掉「别标已修」这句；同时在报告里补一句方法论提醒——**快照式报告必须标"截至 commit"，否则最后几个提交永远会被误判**。
（同类"报告过时"还有 2 条：`F-RT-005` 的 patch 当时"尚未入库"，现已入库；`F-SEC-209` 的 example 当时未同步，现已同步。）

---

## 建议：**PASS**（附 2 条必须下一轮收掉）

**理由**：
1. **核心修复全部成立且经实测**：token 门在服务端、4 安全头齐、CSP 放宽有据、`F-WEB-101` 用握手凭据判身份、`F-WEB-204` 三处 basename、`F-SEC-205` 只打指纹、`F-RT-002` 判据正确不落盘、`F-RT-003` 302 抹除且无访问日志、`F-WEB-205` 停止链完整（退出码 2/3 + "别关窗口"警告）。
2. **零凭据泄漏**：docs 与两仓跟踪文件中，真实 rcon 口令与 API key **命中均为 0**（含指纹法自验）；敏感文件**零触碰**。
3. **本轮的未修项都不是"修复错了"，而是"补强没做完"**：`F-WEB-203` 的硬上界、`F-SEC-206` 的两个 gitignore 模式。两者都**不改变现有安全性**，且实际风险低（见 E2.3、G1）。
4. `F-RT-001`（token 文件 ACL）是**真实缺陷但已被诚实标注**，单人机器风险≈0；要在多用户机器部署前修。

**必须下一轮收掉的 2 条（不构成 BLOCK，但不该再拖）**：
1. **`F-WEB-203` 硬上界**（`mindserver.js:86-91`）：3 行改 `RATE_BUCKETS.size >= 512 → 淘汰最旧 key`，并把注释从"容量上限"改成与行为一致。**理由**：注释现在声称做了、实际没做；且这是"放开绑定"时的自我 DoS 路径。
2. **`F-SEC-206` 补 2 个模式**（两仓 `.gitignore` 各 2 行）：`*.token`、`config.local.*`。**理由**：兜底规则的价值就在于覆盖"没想到的名字"；任务里点名的三个例子中有**两个漏**（`.env.local` 是唯一覆盖到的）。

**同时建议（流程，非代码）**：
- 修 `F-RT-001`：启动时用 `icacls /inheritance:r` 收紧 token 文件 ACL（或用环境变量通道不落盘）。
- 更新 NIGHT-REPORT 的 3 处过时项（`F-WEB-202` / `F-RT-005` / `F-SEC-209`），并给报告加「截至 commit」标记。
- 把 `scripts/`、`web/scripts/*.mjs`、`文件/` 补进"允许改动清单"。

---

## 附：本轮无法实测的（三态标注必填）

| 项 | 三态 | 缺什么 |
|---|---|---|
| `F-WEB-202` 同 key 合并的**端到端吞吐**（20 并发同 key 是否真只跑一次流水线） | **静态确证**（结构 + 语义） | 需启动 mindserver 并构造并发请求；`getTexture` 在 `createMindServer` 闭包内、未导出，无法离线单测。**注**：审计③当时因"不启动服务端"未打真实包，本轮沿用同一约束 |
| `F-WEB-201` token 门的**实弹**（无 token 访问 `/`、`/console/`） | **静态确证** | 同上（需起实例） |
| `F-RT-001` token 文件在**真实运行期**的 ACL | **已实测（机制）**，目标文件本身因"退出即删"不存在 | 已在 `probes/r3/` 用同 mode 的探针测得 644 + Authenticated Users:Modify；探针已删 |
| `F-SEC-206` 在 **Linux/mac** 下的行为（大小写、`git add -f`） | **仍为推断** | 本机是 Windows（`core.ignorecase=true`）；红队 F-RT-004 已给出该矩阵，本轮未重跑 |

---

*分册完。`cd mindcraft && git status --porcelain` 为空；本轮只写 `docs/audit/`。*
