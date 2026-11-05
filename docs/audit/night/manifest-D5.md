# manifest · D5 面板与 API 部（patch-smith · t10）+ F-RT-002 附赠

> 分工：我改文件内容；**git 提交 / gate:full 归 captain**。
> 队列：`F-WEB-201/202/203/204` 已 mv 到 `claimed/`（**只 mv，未覆盖/未删除**）；`F-WEB-205` 在 t8 已交（同窗口）。
> 本轮改动文件：`mindcraft/src/mindcraft/mindserver.js`（主体）、`mindcraft/start.bat`（F-RT-002 一行提示）。

---

## 1. `F-WEB-201`（high）HTTP 三出口零鉴权 + 零安全头  [ready-for-commit]

**改动**（`mindserver.js`，紧跟原有的"种 cookie"中间件之后）：
1. `app.disable('x-powered-by')` —— 去掉版本指纹。
2. 安全头中间件：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、
   `Referrer-Policy: no-referrer`、`Content-Security-Policy`（`default-src 'self'`；`frame-ancestors 'none'`；`base-uri 'none'`）。
3. **HTTP token 门**：`hasAuthCookie(...) || req.query.token === handshakeToken` 才放行，否则 **401** 并给出取 token 的说明。

**为什么不会把面板打死**（这是本改动最大的风险，写清推理）：
- 首屏：`start-panel.ps1` 现在打开的是 `…/console?token=<token>`（t8 改的）⇒ 前置中间件把 token 换成 HttpOnly cookie，
  紧接着的门看到 **query 命中** ⇒ 放行。
- 之后页面发的所有同源请求（`/assets/*.js`、`/settings_spec.json`、`/console/*`）都带同一个 cookie ⇒ 放行。
- **socket.io 的 `/socket.io/` 请求由 engine.io 自己接管，不经 express 中间件** ⇒ 它仍由
  `allowRequest`(只放本机) + `io.use(makeHandshakeGate)` 把关。两套门各管各的，互不影响。
- 因此"无 token 的本机脚本 / 任意网页"从"能读 200"变成"401"；**面板正常使用路径不受影响**。

**自检（已做）**
- `node --check src/mindcraft/mindserver.js` → OK
- 判定逻辑真值表（`docs/audit/night/tmp/test-web201.mjs`，可复跑）→ **6/6 全对**：
  无 cookie 无 query → 401；错 query → 401；对 query → 放行；对 cookie → 放行；错 cookie → 401；都错 → 401
- `mindserver_gate_unit` → 49 passed / 0 failed（我改的都是中间件与 socket handler，未触及它的断言）

**未做（需运行环境）**：真起服务用 curl 验 `/settings_spec.json` 无 token → 401、带 token → 200。
本会话 node 不能 spawn、也不该动用户的服务器 ⇒ 归 captain 冒烟。
**回滚**：`git revert` 该 hunk（三段中间件整体可回退，无外部状态）。

---

## 2. `F-WEB-204`（low）回本机绝对路径  [ready-for-commit · 与 201 同文件]

- `get-profiles` 的 `path: full` → `path: path.basename(full)`（两处：正常项 + 解析失败项）
- `get-profile` 的 `path: full` → `path: path.basename(full)`
- 安全头与 `x-powered-by` 已并入 §1。
- 自检：`grep -n "path: full" mindserver.js` → **0 命中**；`node --check` OK。
- 未做：`get-settings` 白名单化（finding 的建议之一）——它要定义"哪些键可回"，属接口契约变更，
  且与 `settings_spec` 联动；本轮不动，留给后续单（写成 A=C 那类边界收窄会很啰嗦，收益低于风险）。

---

## 3. `F-WEB-203`（medium）socket 事件无限流  [ready-for-commit]

`send-message` 处理器里、`data.from` 校验**之前**加两道内存闸（无依赖）：
- **单条 `message` ≤ 2000 字符**（超了打印长度并返回）
- **每连接 30 条 / 10 秒**令牌桶（按时间线性回填，`socket.data.__rl`），超了打印并返回

自检：`node --check` OK；三处 `grep` 命中（2000 / 令牌桶 / 限流日志）；`mindserver_gate_unit` 49/0。
未做：`listen-to-agents` 的连接数上限（finding 提到）——需要"每 socket 只订阅一次"的语义确认，
改了可能影响面板重连行为，本轮不赌；已在下面 §7 记为遗留。

---

## 4. `F-WEB-202`（medium）贴图代理重活 DoS  [**部分解决** · 诚实标注]

- **主要向量已被 §1 关闭**：这条的真实利用方式是"任意网页 `<img src=…>` 反复打"——那条路现在要 token，
  401 直接挡住。
- 本轮另加**在飞并发上限 4**（`TEX_INFLIGHT` + `res.on('finish'/'close')` 回收），超了回 503。
  ⇒ 不再出现"无限并发把主线程排队排死 / CLOSE_WAIT 堆积"的形态。
- **没做**：结果缓存（`minecraft-assets` 索引 + 文件缓冲）。它是性能优化而非安全判据，且要改动两处 `res.end` 分支，
  在无法真机验证的情况下风险大于收益 ⇒ 留给后续单。
- 自检：`node --check` OK；`grep TEX_INFLIGHT_MAX` 命中；handler 控制流未重构（只在顶部加守卫 + res 事件回收）。
- **定性**：**部分解决**（外部触发面关闭 + 并发有界；缓存未做）。

---

## 5. `F-WEB-101`（我在 t12 立的历史转化单）伪造 `bot-output`/`agent-event`  [ready-for-commit]

- 两个广播处理器加身份判据：**只有以 agent 身份连进来的 socket**（`handshake.auth.token === handshakeToken`）才允许转发；
  否则丢弃并打印 `丢弃伪造的 bot-output/agent-event`。
- 为什么这条判据成立：agent 子进程走 `auth: { token }`（`mindserver_proxy.js:46`），
  面板走 **HttpOnly cookie**（`web/src/api/socket.ts` 不带 auth payload）⇒ 两者可区分。
- 效果：持 token 的面板客户端**不能再伪造"某个 bot 说了某句话/某个诊断事件"**，
  排障日志不再能被单方面污染（收窄了 F-SEC-205 拿到 token 后的次级影响）。
- 自检：`node --check` OK；`grep` 两处守卫在位；`mindserver_gate_unit` 49/0。

---

## 6. `F-RT-002`（红队复测，medium）—— **我们的提示把我们的修复拆了**  [ready-for-commit · captain 列为最高优先]

**问题**：t8 为修 F-REG-001，我在 `start.bat` 里写了"或设 `MINDSERVER_PRINT_TOKEN=1` 打印一次"。
红队实测：`start-panel.ps1` 把 stdout 重定向进 `logs\mindcraft-console.log`，`Start-Process` 又继承父环境
⇒ 用户照着做，完整 token 就落盘，**F-SEC-205 原样复活**。而"找不到 token 的用户"最顺手的动作就是照这句提示做。

**修法（两处，5 行）**：
1. `mindserver.js`：打印完整 token 前先判 **stdout 是不是文件/非终端**（`fstatSync(1).isFile()` + `process.stdout.isTTY`）；
   被重定向时**忽略该开关**并 `console.warn` 解释原因（并指回 `.mindserver-token`）。
2. `start.bat`：把那句建议删掉，改成明确的**反向提示**（"不要在这里用它，stdout 被重定向，token 会进日志"）。

**自检**：`node --check` OK；`grep 忽略 MINDSERVER_PRINT_TOKEN / stdoutIsFile` 命中；
`start.bat` 里 `MINDSERVER_PRINT_TOKEN` 只剩"不要用它"的说明；括号平衡 **23/23（与 HEAD 一致）**。

**残余风险（诚实）**：交互终端里仍可打印完整 token（这是有意的调试口子）。
若用户把终端输出手工复制进聊天记录，仍会泄漏 —— 但那是"人主动外发"，与"自动落盘"不同量级。

---

## 7. 遗留 / 未做（明确记账，别当成已修）

| 项 | 状态 |
|---|---|
| `F-WEB-202` 的结果缓存 | 未做（性能优化，非安全判据） |
| `F-WEB-203` 的 `listen-to-agents` 上限 | 未做（需确认面板重连语义） |
| `F-WEB-204` 的 `get-settings` 键白名单 | 未做（接口契约变更） |
| 真机冒烟（curl 401/200、贴图并发、停止面板真实关服） | 归 captain/用户 |

## 8. 给 captain 的文件组通知（依你 ⑦ 的要求）
本轮**改动的文件组**：
- `mindcraft/src/mindcraft/mindserver.js`（F-WEB-201/202/203/204/101 + F-RT-002 的 node 侧）
- `mindcraft/start.bat`（F-RT-002 的提示侧）

**这两个文件现在是我的"完成态"，可以提交。** 同时提醒：工作区里还有两个**你正扣着的**文件
（`src/agent/tasks/tasks.js` 等你指派的 rework、`src/utils/text.js` 等你要求的接线），
我下一步就动它们 —— 动之前会先告你，避免你的 pre-commit 扫到中间态。
