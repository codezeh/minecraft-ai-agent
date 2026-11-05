id: F-WEB-205
severity: medium
class: authz
file: web/scripts/stop-all.mjs:8
evidence: |
  **「停止面板.bat」必然失败：脚本不带 token，握手门一定拒它；而 token 现在也不打印了。**
  后果不是"少个便利功能"，而是**优雅关服失效 ⇒ 用户会直接关窗口 ⇒ 世界存档有损坏风险**。

  ## 一、脚本本身：连接时不带任何凭据
  `web/scripts/stop-all.mjs:8`：
  ```js
  const URL = 'http://127.0.0.1:8080';
  const s = io(URL, { path: '/socket.io', transports: ['websocket'], reconnection: false });
  //      ↑ 没有 auth: { token }，没有 header，没有 query，没有 cookie
  ```
  而它要用的两个事件都是特权级：
  ```js
  const r = await ack('server-stop');     // → RCON 'stop'，关掉 Minecraft 服务器
  s.emit('shutdown');                     // → mindserver 停所有 agent 后 process.exit(0)
  ```
  它由 `scripts/stop-panel.ps1` 调用（`& $node $script`），也就是 `停止面板.bat` 的整条链路。

  ## 二、门会拒绝它（实测）
  ```js
  // 用真实 socket.io-client 连一个真实例（18089），完全复刻 stop-all.mjs 的连接参数：
  node -e "io('http://127.0.0.1:18089',{path:'/socket.io',transports:['websocket'],reconnection:false})"
  → 结果: connect_error: unauthorized: mindserver 需要握手 token | code=AUTH_REQUIRED
  ```
  门实现（`mindcraft/src/mindcraft/auth_gate.js:74-86 tokenFromHandshake`）只认四个来源：
  `auth.token` / `x-mindserver-token` 头 / `?token=` query / cookie。
  `stop-all.mjs` 一个都没提供 ⇒ **100% 被拒，脚本从设计上就跑不通**。

  ## 三、今天更糟：token 已经不再打印了（patch-smith 的 F-SEC-205 修复）
  当前 `mindserver.js:87-95` + `:517-519`（我自己起实例时的真实日志）：
  ```
  [mindserver] 写 E:\我的世界ai\mindcraft\.mindserver-token 失败（EPERM）；
               本次 token 只能通过 MINDSERVER_TOKEN 环境变量或 MINDSERVER_PRINT_TOKEN=1 获取
  ...
  const tokenHint = `${handshakeToken.slice(0,4)}…${handshakeToken.slice(-4)}(len=${…})`;   // 只印指纹
  ```
  ⇒ 修好 F-SEC-205（token 不再进日志）之后，**"人肉把 token 抄进脚本"这条退路也没了**。
  新的正式通道是 `.mindserver-token` 文件（`TOKEN_FILE = path.join(process.cwd(), '.mindserver-token')`）
  —— 而 `stop-all.mjs` **不读这个文件**。
  所以：修复前跑不通，修复后依然跑不通，且更难自救。

  ## 四、影响（为什么定 medium 而不是 low）
  `stop-panel.ps1` 的注释写明了设计意图：
  > Minecraft 走 RCON stop，会自己刷盘关闭（不是强杀）

  一旦这条链路失效，用户点"停止面板"看到的只会是超时提示（`ack` 里 20 秒超时 → `{ok:false, reason:'超时（mindserver 可能没开）'}`
  —— 日志还会误导成"mindserver 没开"，实际是**鉴权失败**），然后用户自然的选择就是**直接关掉
  "MC Server" 与 "Mindcraft" 两个窗口** ⇒ 非优雅关停 ⇒ 世界存档未刷盘。
  这与 F-SEC-202（RCON）同源：本仓把 RCON 当作"优雅关服"的唯一手段，现在这个手段断了。
exploitability: |
  这不是"攻击者能做什么"，而是**防御性能力被自己关掉**：
  - 攻击者视角：无直接收益（脚本本来就该关服）。
  - 用户视角：以为自己在优雅关服，实际每次都是硬关 ⇒ 存档损坏风险 + 每次都要手动找窗口。
  - 与 F-SEC-205 的关系：修 token 泄漏时**没有同步更新唯一依赖 token 的本机脚本**，
    属于"修 A 面时忘了 B 面"的典型（与我 D2 报的 F-SEC-206→201 顺序问题是同一类）。
  影响半径：每次关服（数据完整性），不影响开机与运行。
suggested_fix: |
  改 `web/scripts/stop-all.mjs`，按"env → 文件"的顺序取 token（与 `mindserver.js` 的通道一致）：
  ```js
  import { readFileSync, existsSync } from 'node:fs';
  import path from 'node:path';

  function resolveToken() {
      if (process.env.MINDSERVER_TOKEN) return process.env.MINDSERVER_TOKEN;      // 显式优先
      const f = path.join(process.cwd(), '.mindserver-token');                     // mindserver 写的那个
      try { if (existsSync(f)) return readFileSync(f, 'utf8').trim(); } catch {}
      return null;
  }
  const token = resolveToken();
  const s = io(URL, { path: '/socket.io', transports: ['websocket'], reconnection: false,
                      auth: token ? { token } : {} });
  s.on('connect_error', (e) => {
      const code = e?.data?.code;
      if (code === 'AUTH_REQUIRED') {
          console.log('[错误] 鉴权失败：拿不到握手 token。');
          console.log('       请在 mindcraft 目录跑（脚本读 ./.mindserver-token），或设 MINDSERVER_TOKEN=…');
          process.exit(2);
      }
  });
  ```
  两个配套细节（都很关键）：
  1. **`cwd` 要对**：`.mindserver-token` 是 mindserver **以自己 cwd 为基准**写的
     （`path.join(process.cwd(), '.mindserver-token')`）。mindserver 由 `start-panel.ps1` 以
     `/D "%ROOT%mindcraft"` 启动 ⇒ 文件在 `mindcraft/.mindserver-token`。
     所以 `stop-panel.ps1` 调用时要 `pushd` 到 `mindcraft` 再 `node ..\web\scripts\stop-all.mjs`，
     或者脚本里直接试两个候选路径（`./.mindserver-token` 与 `../mindcraft/.mindserver-token`）。
  2. **失败要说人话**：现在的超时提示是"mindserver 可能没开"，会把人往错方向带；
     必须单独判 `AUTH_REQUIRED` 并提示"token 拿不到"。
  3. **顺带核实（已核，无需修）**：`.mindserver-token` 已被 gitignore（`mindcraft/.gitignore:89`），
     根仓也因 `/mindcraft/` 整体忽略而覆盖 —— patch-smith 这次改对了，**没有引入新的泄漏面**。
verify: |
  cd mindcraft
  # 1) 起一个真实例（用固定 token 便于断言），另开一个终端：
  MINDSERVER_TOKEN=test-token-1234 node main.js   # 或者只 createMindServer
  # 2) 无 token 时脚本必须给出"鉴权失败"而不是"超时/没开"
  node ../web/scripts/stop-all.mjs; echo "exit=$?"
  # 期望：打印 AUTH_REQUIRED 说明并非 0 退出；**不应**出现 "mindserver 没在跑"
  # 3) token 可被脚本自动取到时必须真的能停
  echo test-token-1234 > .mindserver-token
  node ../web/scripts/stop-all.mjs; echo "exit=$?"
  # 期望：依次输出 "1) 优雅停止 Minecraft 服务器…" 与 "2) 停止 agent 并关闭 mindserver…"
  # 4) 回滚 .mindserver-token 不是 git 状态里的东西
  git status --porcelain | grep mindserver-token; echo "期望空"
  # 5) 门禁不回归
  npm run gate:full
discovered_by: recon-scout
dept: D5-WEB
