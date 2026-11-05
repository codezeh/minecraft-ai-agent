id: F-SEC-205
severity: medium
class: secret
file: mindcraft/src/mindcraft/mindserver.js:493
evidence: |
  握手 token 被**打印到 stdout**，而启动脚本把 stdout **重定向进日志文件** ⇒ token 落盘。

  token 的唯一来源（每次启动新建，或读环境变量）：
  $ sed -n '79,81p' mindcraft/src/mindcraft/mindserver.js
  handshakeToken = process.env.MINDSERVER_TOKEN || makeToken();
  process.env.MINDSERVER_TOKEN = handshakeToken;

  打印三行，其中两行带完整 token：
  $ sed -n '493,495p' mindcraft/src/mindcraft/mindserver.js
  console.log(`[mindserver] 握手 token: ${handshakeToken}`);
  console.log(`[mindserver] 控制台地址: http://${host}:${port}/?token=${handshakeToken}`);
  console.log(`[mindserver] 本机脚本对接: 设 MINDSERVER_TOKEN=${handshakeToken}`);

  落盘通路（不是猜测，是脚本里写死的重定向）：
  $ grep -nE "logDir|mcOut|RedirectStandardOutput" scripts/start-panel.ps1
  16:$logDir = Join-Path $root 'logs'
  19:$mcOut  = Join-Path $logDir 'mindcraft-console.log'
  189:        -RedirectStandardOutput $mcOut `
  即：`启动面板.bat` → `scripts/start-panel.ps1` → mindcraft 的 stdout 全部进
  `logs/mindcraft-console.log`，**包括上面那三行 token**。

  现状核查（诚实标注）：现有这份日志早于 token 功能，暂时**还没有** token 行：
  $ grep -nE "握手 token|mindserver_token" logs/mindcraft-console.log → 无
  ⇒ 这是"下一次启动就会发生"的泄漏，不是已经漏过的泄漏。
  另：`logs/` 被 gitignore（根仓 `.gitignore` 的 `logs/` + mindcraft `.gitignore` 的 `*.log`），
  所以不会进版本库；但**它在磁盘上**，而日志正是"出问题时发给别人看"的东西。
exploitability: |
  拿到 token 的人能做什么：
  $ grep -nE "socket.on\('(send-message|set-agent-settings|server-stop|shutdown)'" mindcraft/src/mindcraft/mindserver.js
  ⇒ 能以已握手身份连 socket.io，发 `send-message`（指挥 bot）、`set-agent-settings`（改 bot 设置，
  白名单字段已过滤但 max_messages/blocked_actions 之类仍可改）、`server-stop`/`shutdown`（停服）。
  token 本身是 randomUUID（不可猜），所以**没有这条泄漏时它很安全**；泄漏渠道有两个：
  1) 日志文件（本条主因）—— 任何人拿到 `logs/mindcraft-console.log`（发人排查、同步盘、打包上传）
     就拿到完整的机器人控制权；
  2) 浏览器 URL `?token=…`（第 494 行让用户点开带 token 的地址）→ 进浏览器历史/书签同步，
     这条属 D5 面板部，此处只标记，不重复展开。
  影响半径：本机 mindserver 的完全控制（指挥 bot 行动、停服）。攻击者仍需先拿到那个日志文件。
suggested_fix: |
  1. **默认不打印 token 明文**（改一行判断即可，不动鉴权逻辑）：
     `mindserver.js:493-495` 改为默认只打印长度/指纹，仅在显式调试开关下打印完整值，例如：
     ```js
     const tokenHint = `${handshakeToken.slice(0,4)}…${handshakeToken.slice(-4)} (len=${handshakeToken.length})`;
     console.log(`[mindserver] 握手 token 已生成: ${tokenHint}（完整值见 MINDSERVER_TOKEN 环境变量或 --print-token）`);
     if (process.env.MINDSERVER_PRINT_TOKEN === '1') console.log(`[mindserver] token=${handshakeToken}`);
     ```
     同时第 494 行的控制台地址改成 `?token=<见上>`，让用户自己从环境变量取；
     若必须保证"复制粘贴就能进面板"的体验，就把完整值写进**用户级环境变量 +
     一个 gitignore 的本地文件**（如 `.mindserver-token`，加进 .gitignore），而不是日志。
  2. `scripts/start-panel.ps1` 里对 `$mcOut` 的写入保持不变，但增加启动时的脱敏：
     在 `start-panel.ps1` 里把 mindcraft 的 stdout 通过一个过滤器落盘（PowerShell 侧
     `Where-Object { $_ -notmatch 'token=' }` 的等价实现），即"日志里永不出现 token"。
     这条比改 node 侧更稳（防的是所有未来的打印）。
  3. README 加一句："`logs/mindcraft-console.log` 含运行时敏感信息，外发前先跑
     `scripts/redact-logs.ps1`（可以后补）或手工删 token 行。"
  4. 提醒用户：如果曾经把 `logs/` 发给别人，那把 token 只对"那一次启动"有效
     （每次启动重新生成），影响面有限 —— 这条要写清楚，避免过度恐慌。
verify: |
  cd "E:/我的世界ai"
  # 1) 静态：代码不再无条件打印完整 token
  grep -nE "握手 token" mindcraft/src/mindcraft/mindserver.js
  # 期望：不出现 `${handshakeToken}` 直出，或只在 MINDSERVER_PRINT_TOKEN 分支里
  # 2) 动态：真跑一次，然后日志里搜不到完整 token
  #    （先记下当前 token 以便反证：环境变量方式启动）
  MINDSERVER_TOKEN=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee node mindcraft/main.js > /tmp/tok.log 2>&1 &
  sleep 8; kill %1 2>/dev/null
  grep -c "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" /tmp/tok.log
  # 期望 0（默认不打印）；设 MINDSERVER_PRINT_TOKEN=1 再跑一次应为 1（证明开关有效）
  # 3) 现有日志不含 token（基线）
  grep -cE "token=[A-Za-z0-9-]{8,}" logs/mindcraft-console.log
  # 期望 0
discovered_by: recon-scout
dept: D2-SEC

---
status: fix-ready-awaiting-commit（patch-smith · D2 修补）
see: docs/audit/night/manifest-D2.md 的对应小节（改动清单 + commit message 草稿 + 自检证据 + 回滚）
## review（裁决：**通过**，附 1 条 Windows 专属 caveat）

### 一、旧的全值打印确实被删掉了（我逐行看 diff，不只看新增）

```
- console.log(`[mindserver] 握手 token: ${handshakeToken}`);
- console.log(`[mindserver] 控制台地址: http://${host}:${port}/?token=${handshakeToken}`);
- console.log(`[mindserver] 本机脚本对接: 设 MINDSERVER_TOKEN=${handshakeToken}`);
+ const tokenHint = `${handshakeToken.slice(0,4)}…${handshakeToken.slice(-4)}(len=${handshakeToken.length})`;
+ console.log(`[mindserver] 握手 token 已生成: ${tokenHint}`);
+ console.log(`[mindserver] 完整 token 位置: ${TOKEN_FILE}（或环境变量 MINDSERVER_TOKEN）`);
+ console.log(`[mindserver] 控制台地址: http://${host}:${port}/?token=<见上>`);
+ if (process.env.MINDSERVER_PRINT_TOKEN === '1') { … console.log(完整值) }
```
⇒ **三行泄漏点全部删除**，默认只输出"前4…后4 + 长度"。这是本条的核心，做到位了 ✅

### 二、token 文件的落点与忽略（任务点名"gitignore 加了但文件已被跟踪"的反向检查）

```
$ git -C mindcraft check-ignore -v .mindserver-token
  .gitignore:89:.mindserver-token	.mindserver-token     ✅ mindcraft 仓已覆盖
$ 外层仓 .gitignore:126 亦含 .mindserver-token            ✅ 两仓都覆盖
```
写盘位置是 `process.cwd()` 下的 `.mindserver-token`；无论 cwd 是 `mindcraft/` 还是仓库根，
两仓的 .gitignore 都覆盖了它 ⇒ **不会被误提交**。且写盘失败只告警、不阻断启动（降级合理）。

### 三、程序仍能启动 + 相关单测未被破坏（任务点名"外部化后还能不能正常启动"）

```
$ node tools/settings_check.mjs         → ✓ settings 键一致性检查通过（exit 0）
$ node tools/mindserver_gate_unit.mjs   → ALL PASS: 48 passed, 0 failed（exit 0）
$ node tools/mindserver_local_only_unit.mjs → 16/16（exit 0）
$ node tools/permissions_unit.mjs       → 63 passed（exit 0）
$ node tools/ses_escape_unit.mjs        → 16 passed（exit 0）
```
commit body 声称"`mindserver_gate_unit.mjs:240` 断言源码含 `makeToken()` 与 `MINDSERVER_TOKEN`，断言仍成立"
—— 我实跑 **48 passed / 0 failed**，该断言确实仍成立 ✅

### 四、caveat（不影响通过，但必须写下来，否则下一个人会误信注释）

代码用 `writeFileSync(TOKEN_FILE, token, { mode: 0o600 })`，注释写"只有本机用户可读"。
**在 Windows/NTFS 上 `mode` 基本无效**（Node 的 mode 只影响 POSIX 权限位，Windows 走 ACL 继承）
⇒ 实际保护强度 = 该目录的 NTFS 继承权限（即"同用户下任何进程可读"），**不是 0600**。

- **不是回归**：改之前 token 直接进日志，比现在更差；现在至少不再落进 `logs/`。
- **但注释的表述过强**：建议改成"Windows 下靠 NTFS 继承权限，POSIX 下为 0600"，
  或真要做严格权限就 `icacls` 显式收紧 —— 否则读注释的人会以为有 0600 这层保护。

### 五、行为变更是否可接受
终端里看不到完整 token 了 —— 但 `start-panel.ps1`（外层仓 `5e2694b`）改成从文件读并拼 `?token=`，
**顺带修好了"面板打开不带 token 被握手拒绝"的既有缺陷**。用 `启动面板.bat` 的用户体验不变。
⇒ 变更方向正确，且已单列在 manifest §7。**通过。**
