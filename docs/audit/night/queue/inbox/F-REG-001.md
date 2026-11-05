id: F-REG-001
severity: medium
class: config
file: mindcraft/src/agent/mindserver_proxy.js:57
evidence: |
  **F-SEC-205 的修复只改了"打印侧"，还有两处提示仍在教用户"从启动日志里拿 token"——
  而日志里已经没有 token 了。用户会照着提示去一个空的地方找。**

  ## 一、漏掉的消费方一：agent 侧握手失败提示（最误导）
  `mindcraft/src/agent/mindserver_proxy.js:55-58`（**未随 F-SEC-205 更新**）：
  ```js
  if (err?.data?.code === 'AUTH_REQUIRED') {
      console.error('MindServer 拒绝握手：缺少/错误的 token（MINDSERVER_TOKEN）。' +
          '这个 agent 进程不是由 mindserver 拉起的，请用 mindserver 启动它，' +
          '或设 MINDSERVER_TOKEN=<启动日志里的 token>。');     // ← 日志里已经没有完整 token
  }
  ```
  F-SEC-205 之后，启动日志只有 `握手 token 已生成: 1de2…9bbc(len=36)` 与
  `完整 token 位置: …\.mindserver-token（或环境变量 MINDSERVER_TOKEN）`
  （我起真实例抓到的原文）。用户按这条提示去日志里找完整值 → **找不到**，然后卡死在这。

  ## 二、漏掉的消费方二：`mindcraft/start.bat` 的收尾提示
  `mindcraft/start.bat:122`：
  ```bat
  echo Started. Web console: http://localhost:8080
  ```
  - 这个 URL 不带 `?token=`，而握手门会拒掉无 token 的 socket（`io.use(makeHandshakeGate)`）；
  - 更关键：**F-SEC-205 之后终端里再也看不到 token**，start.bat 又没告诉用户
    `.mindserver-token` 在哪 ⇒ 用 start.bat 的人**无法打开面板**（不是"多一步"，是无路可走）。
  - 注意 `start-panel.ps1` 那条链已经修好了（5e2694b 会读文件拼 `?token=`），
    所以**只有 start.bat 这条路被漏下**。
  - **在途改动核对（2026-11-06 02:35）**：patch-smith 工作区里正改 `start.bat`（加 F-DEP-004 的安装前预检）。
    我读过它的 diff：**收尾提示那行没动，全文件 `grep -c mindserver-token` = 0**
    ⇒ 本条后半**仍然成立**，不是已修。修的时候注意行号已因插入而位移，请用 `grep` 定位别用行号。

  ## 三、其余消费方全部核对过（这些是好的，列出来证明查全了）
  | 消费方 | 位置 | 结论 |
  |---|---|---|
  | agent 子进程 | `mindserver_proxy.js:46` `auth: cb => cb({token: process.env.MINDSERVER_TOKEN})` | ✓ mindserver 在 `:81` 先写 `process.env` 再 spawn，子进程继承，**不依赖日志** |
  | 自动开浏览器 | `mindcraft.js:25 getHandshakeToken()` | ✓ 同进程直接取模块变量 |
  | 面板启动链 | `scripts/start-panel.ps1:203-207` 读 `mindcraft/.mindserver-token` | ✓ 已修（5e2694b）。**路径对得上**：mindcraft 用 `-WorkingDirectory mindcraft` 起（`:188`），而 token 文件写在 `process.cwd()` ⇒ 正好是 `mindcraft/.mindserver-token` |
  | 停止面板 | `web/scripts/stop-all.mjs:8` | ✗ 已在 **F-WEB-205** 报过，本单不重复 |
  | 单测 | `tools/mindserver_gate_unit.mjs:240` | ✓ 只断言源码含 `makeToken()`/`MINDSERVER_TOKEN` 字样，两者都保留了 |
  | 根目录 `*.mjs` / `*.bat` | — | ✓ **零消费方**（`grep -nE "MINDSERVER_TOKEN\|mindserver-token\|\?token=" *.mjs *.bat` 无命中） |
  | `mindcraft/tools/**` | — | ✓ 除上面那条单测外零消费方 |
exploitability: |
  不是攻击面，是**可用性回归**（用户被自己的安全加固挡在门外）：
  - 用 `启动面板.bat` 的人：不受影响（脚本自动读 token 文件，甚至比改前更好）。
  - 用 `mindcraft/start.bat` 的人：**面板打不开，且没有任何提示告诉他去哪拿 token**。
    他会看到浏览器里 socket 一直重连失败，控制台日志里 `AUTH_REQUIRED`；
    若他还照 `mindserver_proxy.js:57` 的提示去日志找 token，会一无所获。
  - 影响半径：单机使用体验；不涉及数据或权限。
  为什么定 medium 而不是 low：这条链是我这轮审计的**起因**
  （F-WEB-205 的同类），而且它落在"唯一的本机运维入口"上——
  用户遇到时的第一反应往往是"关掉重来"，那次关停是非优雅的（见 F-WEB-205 的存档风险说明）。
suggested_fix: |
  两处文案 + 一处 bat 提示，都是小改：
  1. `mindcraft/src/agent/mindserver_proxy.js:56-57` 改成指向新通道：
     ```js
     console.error('MindServer 拒绝握手：缺少/错误的 token（MINDSERVER_TOKEN）。' +
         '这个 agent 进程不是由 mindserver 拉起的。' +
         '取 token：mindcraft/.mindserver-token 文件，或 mindserver 启动时设 MINDSERVER_TOKEN，' +
         '或 MINDSERVER_PRINT_TOKEN=1 重启看完整值。');
     ```
  2. `mindcraft/start.bat:122` 把收尾提示改成带取法（**不要**打印 token 本身，只打印位置）：
     ```bat
     echo Started. Web console: http://localhost:8080/console
     echo   Token: 见 %ROOT%mindcraft\.mindserver-token ，或用带 qrencode 的地址：
     echo   http://localhost:8080/console?token=^<把该文件内容粘在这里^>
     ```
     更省事的做法：直接调一下 `node -e` 读文件拼出完整地址**回显到控制台**——
     终端是本机的，不算泄漏（泄漏点是**日志文件**，不是屏幕）。
     即：`for /f "usebackq delims=" %%t in ("%ROOT%mindcraft\.mindserver-token") do echo   打开: http://localhost:8080/console?token=%%t`
  3. 同理检查 `启动面板.bat` 之外的其它入口（`文件/start.bat` 是老版本，若还在用也要同步）。
verify: |
  cd mindcraft
  # 1) 静态：不再出现"启动日志里的 token"这种已失效指引
  grep -rn "启动日志里的 token" src/ *.bat ../scripts/ ; echo "期望空（exit=1）"
  # 2) 静态：start.bat 有取 token 的指引
  grep -nE "mindserver-token|MINDSERVER_TOKEN" start.bat; echo "期望有命中"
  # 3) 动态：agent 侧握手失败提示要指向真实位置
  #    起一个 mindserver 但**不**给 agent 传 env，观察 agent 进程 stderr 里那句话
  node -e 'process.env.MINDSERVER_TOKEN=""; require("child_process")' # 见 unit 用例
  # 4) 正向对照：面板链路仍然可用（这条不能被改坏）
  #    人工：双击 启动面板.bat → 浏览器自动进 /console 且不再要求手输 token
  # 5) 门禁不回归
  npm run gate:full
discovered_by: recon-scout
dept: REG
