# T23 · 修被身份门打死的 live 测试（补握手 token + 消除判据重复）

> 执行者：`release-e2e`。范围：`mindcraft/tools/**` + `scripts/e2e.ps1`（未动 `src/`、未改 `auth_gate.js`/`mindserver.js` 的鉴权语义）。

## 0. 结论

| 项 | 结果 |
|---|---|
| `t37_claims_contention_live.mjs` 恢复 | ✅ 真测试服上 **13/13** 全绿（e2e 驱动，退出码 0） |
| 同类工具扫清 | ✅ 8 个直连 socket 的脚本全部补 token；5 个"看着像连、其实不连"的已逐一判定 |
| 判据重复消除 | ✅ 删除 `tools/e2e_claims_live.mjs`，`e2e.ps1 -Scenario claims` 直接驱动 t37 |
| 「静默失败」修复 | ✅ 统一走 `tools/lib/ms_token.mjs` 的 `awaitConnect()`：连不上/未授权 ⇒ 打印原因 + 退出码≠0 |
| e2e 回归 | ✅ `-Scenario all` 连跑两次均 **23/23**、EXIT=0、断言清单逐条一致 |

## 1. 直连 socket 的工具清单 × 处置 × 依据

判据：`grep -rln "socket.io-client\|io(" tools/*.mjs` 命中 19 个文件，逐个看**真实连接行**（不是看有没有 `io(` 字样）。

### 1.1 补了 token（8 个）

| 文件 | 真实连接行 | 处置 |
|---|---|---|
| `t37_claims_contention_live.mjs` | `const sock = io(\`http://localhost:${MS_PORT}\`, { transports: ['websocket'] })` ×2（A/B 两个 BoardClient） | ✅ 改 `connectMindserver(io, MS_PORT)` + `awaitConnect` 显式失败 |
| `t37_firstnight_live.mjs` | 同上（`ioClient`） | ✅ 同上 |
| `t37_idle_live.mjs` | 同上（`ioClient`） | ✅ 同上 |
| `a2_budget_live.mjs` | 同上（`ioc`） | ✅ 同上 |
| `first_night_live.mjs` | 同上（`ioc`） | ✅ 同上 |
| `m10_do_live.mjs` | 同上（`ioc`） | ✅ 同上 |
| `say.mjs` | `io('http://127.0.0.1:8080', { transports, timeout: 6000, reconnection: false })` ×2（polling/websocket 两轮） | ✅ 改 `connectMindserver(io, 8080, {...})`，失败时点明 token 原因 |
| `e2e_claims_live.mjs` | `io(\`http://localhost:${MS_PORT}\`, ...)` | ❌ **删除**（判据与 t37 重复，见 §2） |

### 1.2 本来就合规，未动（5 个）

`board_b1_live` / `board_b2_live` / `board_b2_brief_live` / `board_b3_live` / `board_b4_live`
—— 已在 t145（`6c8758e` 之后）接上 `lib/ms_token.mjs`，`grep connectMindserver` 每个文件 4 处命中。

### 1.3 看着像连、其实不连（5 个，**不加 token**）

| 文件 | 命中的是什么 | 判定 |
|---|---|---|
| `adapters_signal_unit.mjs` | 第 68 行 `new LMStudio('m')` → 被 `io(` 模式误命中 | 纯离线单测，不连 socket |
| `r4_model_hemo_unit.mjs` | `new LMStudio('m').openai`（第 192 行） | 纯离线单测，不连 |
| `diag_kick_movement.mjs` | `scenario(` 之类 | 只用 mineflayer，`grep -c socket` = 0 |
| `test_nav_opt.mjs` | `ratio(` | 纯算法，`grep -c socket` = 0 |
| `diag_logs.mjs` | 第 4 行**只 import** `io`，全文没有 `io(...)` 调用点 | 不连（该 import 是死引用，本轮不动） |

### 1.4 特殊：`mindserver_local_only_unit.mjs`

它也 `ioc(...)` 连了一次，但连的是**它自己起的裸 socket.io 服务**（只挂 `allowLocalOnly`，
第 14-16 行注释明确"不 import mindserver.js"）—— 那个服务**没有 auth 闸**，所以客户端不需要 token。
**判定：不该加**（加了反而把"本机 Node 能连"这条断言变成依赖 token 的伪命题）。

## 2. 判据重复：删 `e2e_claims_live.mjs`，统一走 t37

- 删除 `tools/e2e_claims_live.mjs`（t11 临时替代品，判据与 t37 逐条重复）；
- `scripts/e2e.ps1 -Scenario claims` 改为直接驱动 `tools/t37_claims_contention_live.mjs`；
- 校验逻辑不变：仍要求 t37 退出码 0、`FAIL` 行 0 条，且 ①②③④⑤ 五条关键断言的 `PASS` 行必须**真的出现**
  （防"脚本早退但零失败"的假绿）。

## 3. 「静默失败」这个更重要的坑

`ms_token.mjs` 头注释早就写了：token 缺失时 socket 错误**不传递到 `process.exitCode`**，
于是"看起来跑了、其实没跑"还返回 0。t11 实测正是这个形态（12 条断言全红，脚本仍能 exit 0）。

本轮在 `tools/lib/ms_token.mjs` 新增并统一使用：

```js
export function awaitConnect(sock, { label, timeoutMs } = {}) { ... }
```

- `connect` → `true`
- `connect_error`（含 `AUTH_REQUIRED`）→ 打印 `[label] 连接 mindserver 失败：<code>（token 门拒绝…）`
  并 `process.exitCode = 1`
- 超时 → 同上

调用点统一写成：

```js
const sock = connectMindserver(io, MS_PORT);
if (!await awaitConnect(sock, { label: 'xxx' })) process.exit(1);
```

顺带修了 t37 的 `push()`：原来 detail 直接插值，对象会打成 `[object Object]`，
把真实原因（`ok/code/conflicts`）盖住 —— 现在 `JSON.stringify`。

## 4. 实测证据

### 4.1 失败要看得见（`say.mjs`，外部 mindserver + 真 token）

```
① 错误 token
   MINDSERVER_TOKEN=definitely-wrong node tools/say.mjs "t23 测试"
   → 发送失败: polling=unauthorized: mindserver 需要握手 token websocket=…
   → 原因：mindserver 拒绝握手（缺 token 或 token 错）。用 MINDSERVER_TOKEN=<token> 重试…
   EXIT=1                                        ← 修好前这里是 0
② 正确 token（自动从 .mindserver-token 读）
   → 已发送（polling）→ deepseek: t23 测试        EXIT=0
③ 服务端没开
   → 发送失败: polling=xhr poll error websocket=websocket error   EXIT=1
```

### 4.2 t37 恢复（真测试服，e2e 驱动）

```
pwsh scripts/e2e.ps1 -Scenario claims
  PASS  claims 场景脚本全部断言通过 —— 退出码=0, PASS=13, FAIL=0
  PASS  claims 关键断言出现：①A 预约成功 / ②B 抢同一 key / ③B 没落行 / ④反向对照 / ⑤ entity 预约泄漏
  E2E 通过：10/10                                         EXIT=0
```

> 说明：`a2_budget_live` 等"脚本内直接 createMindServer"的工具，**服务端和客户端读同一个 env**，
> 所以"错误 token"这一态只能对外部服务端的脚本（`say.mjs`）构造；对它们能验证的是
> "正确 token ⇒ 过了 token 门"（实测已跨过连接、进到 bot 阶段）。

### 4.3 回归

```
pwsh scripts/e2e.ps1 -Scenario all   (run1) → E2E 通过：23/23   EXIT=0
pwsh scripts/e2e.ps1 -Scenario all   (run2) → E2E 通过：23/23   EXIT=0
diff 两次断言清单 → IDENTICAL
node tools/lint_hard.mjs → no-undef = 0 · no-floating-promise = 0（扫 175 个文件）
```

## 5. 未做 / 注意事项

- `diag_logs.mjs` 里 `import { io }` 是**死引用**（全文无调用），本轮不改（不在本任务的失败面里）。
- 其余 `*_live.mjs` 若将来新增 socket 连接，请直接用 `connectMindserver` + `awaitConnect`，
  不要回到裸 `io(...)`。
- 本机实测需要一个真 MC 测试服；`scripts/e2e.ps1` 会自己起（见 docs/audit-r4/T11-隔离服E2E.md）。
