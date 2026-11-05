id: F-SEC-205
severity: medium
class: secret
file: src/mindcraft/mindserver.js:495
dept: D2-SEC

# ⚠️ 本文件由复核席重建（gate-keeper · t14 · 2026-11-06 02:4x）
# 原 finding 文件在收尾时被清空。落地见 commit 62a93a5（mindcraft 仓）
# 与 5e2694b（外层仓，start-panel.ps1 改读 token 文件）。

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
