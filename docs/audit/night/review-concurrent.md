# 并发第三道流 · 快验 + 预审 + 真机复跑（t22）

> 复核官：gate-keeper ｜ 2026-11-06 12:1x–12:5x
> 原则：**不信转述、不信 finding 自述**，每条都跑命令取真实输出。
> 环境边界：本会话 `spawnSync(node,-v)` 仍 **EPERM** ⇒ 我起不了外部进程；
> 但**端口监听不是 spawn**，所以我用"同进程 import `createMindServer` + 内置 `fetch` 打自己"完成了 ③ 的真机复跑。

---

## ① 五条快验（+1 条 captain 编号有误，按单子原文判）

### ⚠️ 先说一件必须先说的事：captain 给的"编号→主题"映射**三条全错位**

我按单子原文核对，实际内容是：

| captain 说的 | **单子实际是什么** |
|---|---|
| `F-AI-101` = `!goal` 那条 | **不是**。`F-AI-101` 是 `src/models/gpt.js:83` —— 5 个适配器在 catch 里**裸用 `err.message.includes()`** |
| `F-AI-102` = 19 处 `console.log(err)` | **不是**。`F-AI-102` 是 `src/models/_shared.js:25-35` —— `FAILED_REPLY` **魔法字符串契约** |
| `F-AI-103` = `get-profile` 契约 | **不是**。`F-AI-103` 是 `src/agent/library/skill_library.js:31-44` —— 技能目录暴露**分叉实现** |

（`!goal` 的升权在 D4 就做完了，属 `F-AI-202`；`get-profile` 属 `F-WEB-204`/`F-SEC-103`。）
**我按单子原文判，并把这三条的真实主题写进下表** —— 否则会对着错的目标验收。

---

### ①-1 `F-GATE-002`（low）`unit_all` 的 `EXCLUDE` 藏两个死测试 —— **未修**

```bash
$ grep -n "EXCLUDE\|test_mca_import\|test_tile_map" tools/unit_all.mjs | head -4
  36: const EXCLUDE = new Map([
  37:   ['test_mca_import', '引用已删除的 src/agent/library/chunk_map.js（ERR_MODULE_NOT_FOUND）；陈旧测试，删/重写不在 T03 范围'],
  38:   ['test_tile_map', '同上：引用已删除的 chunk_map.js；陈旧测试'],

$ for f in test_mca_import test_tile_map; do test -f tools/$f.mjs && echo "$f 存在"; done
  test_mca_import 存在
  test_tile_map   存在

$ ls src/agent/library/chunk_map.js
  No such file or directory          ← 模块仍然不存在
```
⇒ **两个死测试仍在、仍被 EXCLUDE 排除、它们 import 的模块仍不存在**。**未修**（当前行号：`tools/unit_all.mjs:37-38`）。
> 这正是我 D1 复核时说的"**藏红**"：理由写得很清楚，但事实是这两个测试永久必红且永不运行。

---

### ①-2 `F-GATE-003`（low）eslint 三条规则自始 off —— **未修（且仍无放宽先例，这点是好消息）**

```bash
$ grep -nE '"curly"|"no-unused-vars"|"no-unreachable"' eslint.config.js
  40:  "curly": "off",
  41:  "no-unused-vars": "off",
  42:  "no-unreachable": "off",

$ git log --oneline 3a41acf..HEAD -- eslint.config.js | wc -l   → 0      ← 本晚零改动
$ git log --oneline -- eslint.config.js | wc -l                 → 3      ← 全史仅 3 次，均早于今晚
```
⇒ **规则仍是 off（第 40-42 行）**；**"本晚无人为了过门放宽 lint"这一点成立**（0 次改动）。
本条我原本给的建议是"分期开进棘轮"，**至今没做**。属"已登记未处理"，不是回归。

---

### ①-3 `F-RT-004`（low）gitignore 能力边界 —— **部分修**（且 `.ENV` 那条是**假绿**）

```bash
$ for f in .ENV .Env server.crt keystore.jks config.local.ts config.local.js; do git check-ignore -v "$f"; done
  忽略   .ENV          <- .gitignore:115:.env
  忽略   .Env          <- .gitignore:115:.env
  未忽略 server.crt
  未忽略 keystore.jks
  未忽略 config.local.ts
  忽略   config.local.js  <- .gitignore:127:config.local.js
```

**⚠️ 这里有个必须点出来的坑**：`.ENV` 之所以显示"已忽略"，**是因为这台 Windows 上
`core.ignorecase=true`（我实测两仓都是 `true`）** —— git 的 ignore 匹配变成了**不区分大小写**。
⇒ **换到 Linux/macOS（大小写敏感）上，`.ENV` 会立刻漏掉。** 也就是说这条"通过"是**平台造成的假绿**，
不是规则真的覆盖了大小写变体。要真修，得在 `.gitignore` 里显式写大小写变体（或加 `.gitattributes`
说明约束），不能靠 `core.ignorecase`。

| 项 | 现状 | 判定 |
|---|---|---|
| `.ENV` / `.Env` | 仅因 `core.ignorecase=true` 被忽略；**大小写敏感平台上会漏** | ⚠️ **假绿** |
| `server.crt` | 未覆盖 | ❌ 未修 |
| `keystore.jks` | 未覆盖 | ❌ 未修 |
| `config.local.ts` | 未覆盖（只有 `.js`，见 mindcraft `.gitignore:89` / 根 `.gitignore:127`） | ❌ 未修 |
| `git add -f` 穿透 | 无法用 `.gitignore` 阻止（git 设计如此） | ℹ️ **不可修**，只能靠 pre-commit 检查 |

⇒ **部分修**；四类里三类仍未覆盖，一类是平台假绿。

---

### ①-4 `F-SEC-105`（low）`log_all_prompts` vs `LOG_PROMPTS` 两个开关并存 —— **未修**

```
$ grep -rn "log_all_prompts" src/ tools/ --include=*.js --include=*.mjs --include=*.json
  src/mindcraft/auth_gate.js:145            'narrate_behavior', 'log_all_prompts', …   ← 运行期白名单
  src/mindcraft/public/settings_spec.json:94  "log_all_prompts": { … }
  src/models/prompter.js:435                if (!settings.log_all_prompts) …

$ grep -rn "LOG_PROMPTS" src/ tools/
  src/models/hyperbolic.js:49   // …要看提示词请显式开 LOG_PROMPTS=1。
  src/models/hyperbolic.js:50   if (process.env.LOG_PROMPTS === '1') console.log('Messages:', messages);
```
⇒ **两个开关仍然并存**：一个走 settings（`settings.log_all_prompts`），一个走环境变量
（`process.env.LOG_PROMPTS`）。**未修**（当前行号：`prompter.js:435` / `hyperbolic.js:50`）。
> 补充：`hyperbolic.js:50` 那行**已经被闸住**了（`LOG_PROMPTS === '1'` 才打），所以它不是"无条件泄漏"，
> 但仍与 settings 那条形成**两套真相**——同一个用户意图有两个开关，改一个不生效。

---

### ①-5 `F-AI-101/102/103` —— **三条全部未修**（按单子原文）

**`F-AI-101`（medium）：5 个适配器裸用 `err.message.includes()`** —— **未修**
```bash
$ grep -nE "err\.message\.includes" src/models/{gpt,claude,groq,mercury,mistral}.js
  gpt.js:83         } else if (err.message.includes('image_url')) {
  claude.js:54      if (err.message.includes("does not support image input")) {
  groq.js:67        if (err.message.includes("content must be a string")) {
  mercury.js:55     } else if (err.message.includes('image_url')) {
  mistral.js:63     if (err.message.includes("A request containing images…")) {

$ grep -rnE "err\?\.message\?\.includes" src/models/*.js    → 空
```
⇒ 5 处**逐字未变**。上游 reject 非 Error 时，**在 catch 块里二次抛 TypeError** ⇒ 冲出 `sendRequest`，
prompter 无 catch ⇒ 未处理 rejection，运维只看到 `Cannot read properties of undefined (reading 'includes')`。
**未修**（行号同上）。

**`F-AI-102`（low）：`FAILED_REPLY` 魔法字符串契约** —— **未修（结构债，当前无活 bug）**
```bash
$ sed -n '24,36p' src/models/_shared.js
  export const FAILED_REPLY = '[LLM_ERROR]';
  export function failedReply(reason) { return `${FAILED_REPLY} ${String(reason ?? 'unknown')}`; }
  export function isFailedReply(text) { return typeof text === 'string' && text.startsWith(FAILED_REPLY); }
```
⇒ 逐字未变。**当前无活 bug**（9 处已知消费点都调了 `isFailedReply`），风险是"下一次新消费点忘了调"。
**未修**（`_shared.js:25-35`）。

**`F-AI-103`（medium）：技能目录暴露分叉实现** —— **未修**
```bash
$ grep -nE "export async function (equip|putInChest|takeFromChest)" src/agent/library/skills.js
  1348: export async function equip(bot, itemName)
  1476: export async function putInChest(bot, itemName, num=-1)
  1512: export async function takeFromChest(bot, itemName, num=-1)

$ sed -n '1348,1362p' …（equip 函数体）
  let item = bot.inventory.slots.find(slot => slot && slot.name === itemName);   ← 自己那套，未接原子层
$ sed -n '1526,1545p' …（takeFromChest 函数体）
  let matchingItems = chestContainer.containerItems().filter(item => item.name === itemName);  ← 同上
```
⇒ 三处仍是**独立实现**，没有接到原子层（`act_container` / `act_equip`）。**未修**（行号同上）。
> 这条是 `F-EXEC-103/104` 的"为什么危险"：模型按目录选函数时，会绕过原子层的三态/读回校验。

### ① 汇总表

| 条目 | 判定 | 关键证据 |
|---|---|---|
| `F-GATE-002` | ❌ **未修** | `unit_all.mjs:37-38` 仍在 EXCLUDE；两个测试仍在；`chunk_map.js` 仍不存在 |
| `F-GATE-003` | ❌ **未修**（但**无放宽先例** ✅） | `eslint.config.js:40-42` 仍 off；本晚 eslint 配置 0 次改动 |
| `F-RT-004` | ⚠️ **部分** | `server.crt`/`keystore.jks`/`config.local.ts` 未覆盖；`.ENV` 是 **`core.ignorecase=true` 造成的假绿** |
| `F-SEC-105` | ❌ **未修** | `prompter.js:435`(settings) 与 `hyperbolic.js:50`(env) 两套开关并存 |
| `F-AI-101` | ❌ **未修** | 5 处 `err.message.includes` 裸用（gpt83/claude54/groq67/mercury55/mistral63） |
| `F-AI-102` | ❌ **未修**（结构债，无活 bug） | `_shared.js:25-35` 逐字未变 |
| `F-AI-103` | ❌ **未修** | `equip:1348` / `putInChest:1476` / `takeFromChest:1512` 仍独立实现 |

**⇒ 结论："这 5 条我认为已修完"这个判断，我实测下来 0 条算是修完。**
（`F-GATE-003` 严格说不是 bug 而是"留白"，但也没动。）

---

## ② `F-EXEC-102` 预审判据（给 patch-smith 动手前看）

### 2.1 现状（我实测，确认仍是问题）
```bash
$ sed -n '665,675p' src/mindcraft/mindserver.js        # shutdown 处理器
  665: socket.on('shutdown', () => {
  667:   for (let agentName in agent_connections) { mindcraft.stopAgent(agentName); }
  671:   setTimeout(() => { console.log('Exiting MindServer'); globalThis.process.exit(0); }, 2000);
$ grep -rn "process.on\('exit'\|process.on\('SIGINT'\|process.on\('SIGTERM'" src/   →  空
```
⇒ **仍是"发信号 → 硬等 2 秒 → `process.exit(0)`"，且无任何信号处理器**。

### 2.2 怎么才算"真的回收了"（**判据，不是"发了信号就返回"**）

必须同时满足三条，缺一条都只能算"看起来回收了"：

1. **每个子进程都真的 `exit` 过**（拿到 `child.on('exit')` / `child.killed === true` 且已 exit），
   而不是 `kill()` 返回成功就算数 —— **`kill()` 成功只代表信号送达，不代表进程已死**。
2. **退出前所有子进程都不再持有 board 租约**（孤儿的核心危害是"继续领单执行"，不是"进程还在"）。
   验收要能看到「租约已释放 / 心跳已停」。
3. **父进程是在"子进程已退出"之后才 exit 的**，且**有超时兜底**（子进程卡死时不能永久挂住）。
   顺序必须是：`stopAgent 全部 → 等 exit（有上限）→ 再 process.exit(0)`。

**一句话判据**：`shutdown` 返回后，`ps`/`tasklist` 里不应再有该 mindserver 的子 node 进程，
且 board 库里对应租约已释放。

### 2.3 孤儿判定手段与各自副作用（选哪个决定假修风险）

| 手段 | 怎么判 | 副作用 / 局限 |
|---|---|---|
| **父进程存活检查**（子进程侧轮询 `process.ppid` 是否还是那个 pid，或 `process.send` 通道断开） | 最直接：父死了立刻自退 | 需要子进程**主动**配合；Windows 上 `ppid` 在父死后可能被复用/变成 0，判断要小心；**不改子进程就无效** |
| **board 租约过期**（`leaseGuard` / `LEASE_STALE`） | 已有机制，孤儿持约不续 ⇒ 过期后单子可被回收 | **有延迟**（等租约过期），期间孤儿仍可能执行；且**心跳会续租**，若孤儿还在跑心跳就一直不过期 —— **这正是本条的症结** |
| **心跳超时**（mindserver 侧记录每个 agent 最后心跳，超时即判死并回收） | 无需子进程配合 | 只能判"没心跳"，判不了"进程是否还活着"；对"孤儿还在跑但不再心跳"与"孤儿还在心跳"区分不开 |
| **子进程自杀**（agent 侧监听 stdout/socket 断开即 exit） | 覆盖 Ctrl-C/崩溃 | 需要改 agent 侧；**崩溃退出时不自杀**（因为它自己也崩了） |

**我的建议**：**主用"父进程存活检查（子进程侧）+ 父侧 await exit"两条并行**，
**辅以租约过期兜底**。理由：单项都有盲区 ——
父侧 await 覆盖不了"父被 `SIGKILL`"（它没机会 await）；子侧 ppid 检查覆盖不了"子进程自身崩溃"；
租约过期只能兜底且延迟大。**三者叠加才闭环。**

### 2.4 最容易假修的三处（我验收时会重点打这三枪）

1. **只处理正常退出，不处理崩溃退出**
   `socket.on('shutdown')` 只覆盖"用户点停止面板"。**Ctrl-C（SIGINT）、`taskkill`、父进程崩溃、
   未捕获异常**都走不到它。必须同时挂 `process.on('SIGINT'|'SIGTERM')` 和 `uncaughtException`/`unhandledRejection`
   （或至少 SIGINT/SIGTERM + `process.on('exit')` 里的同步 kill 兜底）。
   **验收**：直接 SIGINT 父进程，看子进程是否也被清。
2. **只在 mindserver 侧清理，没管 agent 自杀**
   父被 `SIGKILL`（任务管理器里"结束任务"就是）时，父根本没有机会清理 ⇒
   **只有子侧"发现父没了就自退"能救**。若只改父侧，这一枪必挂。
3. **`kill()` 成功即认为回收完成**
   `mindcraft.stopAgent(n)` 目前不返回 promise，`setTimeout(2000)` 是"猜"。
   **必须先拿到 child 引用、等 `exit` 事件、再退**；否则只是"发了信号"。

### 2.5 可判的验收命令 / 脚本

```bash
# ── 枪 1：正常退出（点停止面板 / socket shutdown）
#   起 mindserver + 1 个 agent，记录子进程 pid，调 shutdown，然后：
#   期望：子进程 pid 在 5 秒内消失；board 里该 agent 的租约已释放
tasklist /FI "IMAGENAME eq node.exe" /FO CSV | findstr /i mindcraft      # 期望：不再有该子进程

# ── 枪 2：崩溃退出（父被强杀）—— 最容易假修的一枪
#   起 mindserver + agent，然后 **直接 SIGKILL 父**（不给它清理机会）：
powershell -NoProfile -Command "Stop-Process -Id <mindserverPID> -Force"
#   期望：子进程在 X 秒内**自行**退出（父侧没机会清，只能靠子侧 ppid 检查）
#   失败形态：子进程继续活着并在下个心跳周期继续续租 ⇒ 面板停不掉 = 本 bug 原样

# ── 枪 3：Ctrl-C（SIGINT）路径
#   在 mindserver 控制台按 Ctrl-C，期望子进程一并退出（而不是留孤儿）
#   现在实测：process.on 0 处 ⇒ 这一枪必挂

# ── 租约侧验收（不依赖进程表）
cd mindcraft && node -e "
import('./src/agent/library/board_store.js').then(async m=>{
  const b = m.openBoard();
  const rows = b.listJobs ? b.listJobs({}) : [];
  console.log('带租约的单子:', rows.filter(j=>j.lease_owner).map(j=>j.lease_owner));
});"
#   期望：shutdown 之后不再有属于该 agent 的 lease_owner
```

**我验收时会跑枪 1 + 枪 2 + 枪 3 三条。只过枪 1 不算修好。**

---

## ③ 复跑 captain 的真机 HTTP 门结论（`b0e7ca7`）—— **你说的都对，另有一处你没提的细节**

### 3.1 我怎么复跑的（本会话不能 spawn，绕开的办法）
`spawnSync(node,-v)` 仍 **EPERM** ⇒ 起不了外部进程。但**监听端口不是 spawn**：
我在**同一进程内** `import createMindServer` → 监听 **18099**（没占 8080）→ 用内置 `fetch`
（`redirect:'manual'`，否则看不到 302）打自己。脚本留在
`docs/audit/night/probe-http-gate.mjs`（可复现，未改任何业务代码）。

### 3.2 实测结果（真实输出，逐条对照你的结论）

```
name                     status  location   csp xfo  nosniff referrer    x-powered-by
A1 数据接口 无token        401     -          Y   DENY nosniff no-referrer (已移除)
A2 页面导航 无token        401     -          Y   DENY nosniff no-referrer (已移除)
B1 数据接口 带token        200     -          Y   DENY nosniff no-referrer (已移除)
C1 页面导航 带token        302     /          -   -    -       -           (已移除)
D1 index  带token        302     /          -   -    -       -           (已移除)
E1 socket.io 握手探测      200     -          -   -    -       -           (已移除)
```

| 你的结论 | 我的复跑 | 判定 |
|---|---|---|
| 数据接口无 token → **401** | A1 = **401** | ✅ 成立 |
| 带 token 数据接口 → **200**（不是 302） | B1 = **200** | ✅ 成立（`b0e7ca7` 的修正有效） |
| 页面导航带 token → **302** 抹 token | C1/D1 = **302 → /** | ✅ 成立 |
| 四个安全头齐全 | A1/A2/B1 = CSP+XFO+nosniff+Referrer 全 Y | ✅ 成立（**但仅对 200/401 成立，见下**） |
| `X-Powered-By` 已移除 | 六行全部 `(已移除)` | ✅ 成立 |
| socket.io 未误拦 | E1 = **200**（不是 401） | ✅ 成立 |

### 3.3 ⚠️ 一处你没提、但会让人误判的细节：**302 响应没有安全头**

看 C1/D1 那两行：`csp/xfo/nosniff/referrer` 全是 `-`。

**原因（我读了中间件顺序）**：302 是在**第一个**中间件（`?token=` → `Set-Cookie` → 302）里
`return` 掉的，而安全头是**第二个**中间件设的 ⇒ 302 提前返回，安全头没跑。

**影响评估（不夸大）**：302 的响应体是空的、浏览器立刻跟随跳转，**实际风险≈0**。
但它有两个次生影响：
1. 若有人（或自动化验收脚本）**拿 302 当作"响应是否安全加固"的样本**，会得出"安全头缺失"的错误结论 ——
   这正是我们整晚在防的"**检查对象不是要证明的那件事**"。
2. CSP/XFO 在 302 上缺失意味着"跳转前的那一响应"不受这些头约束 —— 对点击劫持防护无实质影响（302 无内容）。

**建议（不阻塞，1 行）**：把安全头中间件**移到 302 中间件之前**（即 `app.use` 顺序调换），
或在 302 分支里补一句 `applySecurityHeaders(res)`。这样"所有响应都有安全头"这条就**无条件成立**，
验收脚本也不会被平台细节误导。

---

## ④ 给 captain 的三句话

1. **①"这 5 条已修完"实测 0 条成立**：`F-GATE-002`/`F-GATE-003`/`F-SEC-105`/`F-AI-101`/`F-AI-102`/`F-AI-103` 全部**未修**（行号已给），
   `F-RT-004` **部分修**，且 `.ENV` 那条是 **`core.ignorecase=true` 造成的平台假绿**（换 Linux 就漏）。
   **另：你给的编号↔主题映射三条全错位**（AI-101 不是 `!goal`、AI-102 不是 `console.log(err)`、AI-103 不是 `get-profile`），
   我按单子原文判了。
2. **② 判据已给**：真回收 = ①子进程真的 exit 过 ②退出前不持租约 ③父在子退出后才退且有超时兜底。
   **验收我会打三枪：正常 shutdown / 父被 SIGKILL / Ctrl-C**。**只过第一枪不算修好**——
   而"只在父侧清理、没让子进程自杀"恰恰会在第二枪挂掉，这是最容易假修的地方。
3. **③ 你的真机结论 6/6 我都复跑成立**（用同进程 `fetch`、端口 18099，没占 8080）。
   **唯一补充**：**302 响应没有安全头**（302 在第一个中间件提前返回，安全头中间件还没跑）——
   实际风险≈0，但会让"四头齐全"这条在自动化验收里给出假结论，建议把安全头中间件前移或补一行。

---

## ⑤ 复核动作（可审计）
```
读：queue/inbox 的 F-EXEC-102、F-AI-101/102/103 原文（发现 captain 的编号映射错位）
    mindserver.js:665-675（shutdown）、src/models/*.js 的 err.message.includes、
    _shared.js:24-36、skills.js:1348/1476/1512 函数体、unit_all.mjs:36-38、eslint.config.js:40-42
跑：grep 各条证据（命令与输出已逐条贴在上文）
    git check-ignore × 6（并查出 core.ignorecase=true 导致 .ENV 假绿）
    git log -- eslint.config.js（本晚 0 次改动）
    ⭐ 真机复跑：node ../docs/audit/night/probe-http-gate.mjs（同进程 listen:18099 + fetch，6 个用例）
未做：F-EXEC-102 的三枪验收（patch-smith 还没动手；且本会话不能 spawn 起真实例，需真机）
```
