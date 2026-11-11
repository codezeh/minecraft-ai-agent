# R6 t4 前端静态与产物验收（无端口线）

> 执行者：qa-static（attempt 1，2026-11-11 23:04–23:58 CST）
> 机器：本机 Windows，仓库 `E:\我的世界ai`，node v24.16.0 / npm 11.13.0
> 硬约束遵守情况：**未修改任何产品代码**（`web/src/**`、`mindcraft/**` 一行未动）；**未跑 dev server**（全程零监听端口）；未跑浏览器。
> 本轮唯一写入：`docs/audit-r6/fixes3/static.md` 与本目录下的证据/脚本。
> 原始日志：`docs/audit-r6/fixes3/evidence/static/`

---

## 0. 结论（先说要紧的）

| # | 判断 | 依据 |
|---|---|---|
| 1 | **类型门禁 + 构建产物 + 两套清单门禁全绿** | `vue-tsc --noEmit` EXIT=0；`npm run build` 出 16 个产物；`web_dist_manifest_unit` **10/10**；`release.ps1 -VerifyOnly` **8/8** |
| 2 | **构建可复现**：重新构建的 `web/dist` 与入库的 `mindcraft/web-dist` **16/16 逐字节一致** | §2.3 |
| 3 | **静态零缺陷（CSS 变量 / 路由 / 文案兜底）**：幽灵变量 `--text-dim` **未复发**；8 条路由全部有视图，无死路由、无孤儿视图、导航零死链 | §3 |
| 4 | **危险开关契约基本对齐，但有一条侧门**：`PUT /api/config` 的 `confirm:true` 前后端一致；**`create-agent` 可以在不带任何 confirm 的情况下把 `allow_insecure_coding` 置 true** | §3.4、缺陷 S-1 |
| 5 | **上轮 `web.md §9` 交给服务端的 4 条需求：3 条仍未实现，1 条（前端传输层）未做且本就被标为不阻塞** | §5、缺陷 S-2/S-3 |

**一句话**：这条线**没有**发现回归 —— 门禁全绿、产物可复现、静态审计干净；真正的风险不在"前端跑不跑得起来"，而在**两处契约的空白**：`create-agent` 绕过了高危开关的二次确认，以及 `web.md §9` 承诺的三个服务端能力（ack / relay 解耦 / 输出重放）至今一个都没落地，前端只能继续靠"猜"和"超时降级"。

---

## 1. 门禁一：类型检查与构建

```console
$ cd web && npx vue-tsc --noEmit
TSC_EXIT=0
```
（完整日志 `evidence/static/vue-tsc.log`；无任何输出 = 0 error。`tsconfig.json` 里 `strict:true` / `noImplicitAny:true` 仍然开着，不是"关掉检查换绿"。）

```console
$ cd web && npm run build
vite v6.4.5 building for production...
✓ 109 modules transformed.
dist/index.html                          0.40 kB │ gzip:   0.30 kB
dist/assets/TerrainView-Bfx3UY9s.css     1.90 kB │ gzip:   0.71 kB
dist/assets/DebugView-BBXut0Sc.css       2.32 kB │ gzip:   0.71 kB
dist/assets/VaultView-D1JOuBUr.css       2.37 kB │ gzip:   0.67 kB
dist/assets/BoardView-BbQGd-9e.css       2.48 kB │ gzip:   0.75 kB
dist/assets/SetupView-1XMh8WPf.css       2.64 kB │ gzip:   0.79 kB
dist/assets/SettingsView-NmNjAVpN.css    5.11 kB │ gzip:   1.35 kB
dist/assets/index-BL9LFp5B.css          13.33 kB │ gzip:   3.18 kB
dist/assets/humanize-VZJ6ObYL.js         0.80 kB │ gzip:   0.60 kB
dist/assets/BoardView-DFG0lNew.js        5.40 kB │ gzip:   2.68 kB
dist/assets/DebugView-DDNhfSvO.js         7.19 kB │ gzip:   3.00 kB
dist/assets/SetupView-BqTVbrdv.js        10.87 kB │ gzip:   4.42 kB
dist/assets/VaultView-Yyy3gB3N.js        11.49 kB │ gzip:   4.94 kB
dist/assets/SettingsView-B_HOkUL1.js     25.73 kB │ gzip:   8.57 kB
dist/assets/index-BUfQgcJJ.js           175.33 kB │ gzip:  64.60 kB
dist/assets/TerrainView-DncGChUK.js     505.64 kB │ gzip: 129.33 kB
✓ built in 1.39s
```
（`evidence/static/npm-build.log`，EXIT=0。两次独立构建的输出哈希完全相同。）

---

## 2. 门禁二：产物一致性

### 2.1 `web_dist_manifest_unit.mjs` → 10/10

```console
PASS web-dist/ 存在（干净克隆可构建的前提）
PASS web-dist/index.html 存在（面板入口）
PASS web-dist/MANIFEST.json 存在（漂移检测的依据）
PASS MANIFEST 有 files 字段 keys=schemaVersion,generatedFrom,generatedAt,source,artifact,entryAssets,note,files
PASS 产物里没有缺失文件
PASS 产物内容与 MANIFEST 完全一致（防止手改/漏更新） 16 个文件全对
PASS 产物目录没有 MANIFEST 未记录的野文件
PASS 产物里至少有 1 个 assets/*.js（不是空壳） count=8
PASS index.html 已纳入清单
PASS 产物绑定的源码指纹与当前 web/src 一致（防"改了源码没重建"） 清单=sha256:937aea92e750… 当前=sha256:937aea92e750…（32 个输入）

ALL PASS: 10 passed, 0 failed
```
（`evidence/static/manifest-unit.log`，EXIT=0。构建**前后各跑一次**，两次都是 10/10 —— 说明"我重新 build 了一遍"没有让入库产物漂移。）

### 2.2 `scripts/release.ps1 -VerifyOnly` → 8/8

```console
[4/8] 产物校验：清单自洽 + index.html 引用 + 源码 hash 绑定
  PASS  web-dist 结构完整（index.html + MANIFEST.json）
  |   PASS  16 个产物文件与清单逐条一致
  |   PASS  产物目录没有清单未记录的野文件
  |   PASS  index.html 的 2 个入口引用都能在产物里找到
  |   PASS  源码指纹 sha256:937aea92e7506cc3…（32 个输入文件）
  |   PASS  产物指纹 sha256:87e67b82ae7437c1…（16 个产物文件）
  |   PASS  产物与 web/ 源码指纹一致（产物确实是这份源码构建出来的）
  |   PASS  产物指纹与清单一致
  |   PASS  入口引用与清单一致
  |   INFO  generatedAt = 2026-11-11T13:12:52Z
  |   ALL PASS: 8 passed, 0 failed
  PASS  VerifyOnly：清单/产物/源码三方一致
VerifyOnly 完成：产物、清单、源码三方一致。
```
（`evidence/static/release-verifyonly.log`，EXIT=0。`[2/8]`/`[3/8]` 两段在 VerifyOnly 模式下按设计打印 WARN 并跳过，不是缺陷。）

### 2.3 额外做的一件事：构建**可复现性**（清单门禁不覆盖这点）

清单门禁只证明"入库产物与它自己的清单一致"，**不证明"这份源码重新构建出来还是同一份产物"**。所以额外做了一次逐字节对比（`evidence/static/dist_compare.py`）：

```console
web/dist 文件数     : 16
mindcraft/web-dist 文件数: 16
仅 web/dist 有（漏同步）: 无
仅 web-dist 有（多余产物）: 无
内容不一致（构建不可复现）: 无

判定：PASS 重新构建的产物与入库产物逐字节一致（可复现）
```
（`evidence/static/dist-consistency.log`。）

> 备注：`mindcraft/web-dist/README.md` 与 `MANIFEST.json` 不在逐字节比对范围内 —— 前者是清单门禁里**显式白名单**的说明文件（`web_dist_manifest_unit.mjs:79` 排除 `MANIFEST.json`/`README.md`），后者是清单本身。这不是"漏检"，是设计。

---

## 3. 静态审计（不跑浏览器）

审计脚本落在 `evidence/static/static_audit.py`（只读扫描，可复跑：`PYTHONIOENCODING=utf-8 python docs/audit-r6/fixes3/evidence/static/static_audit.py <repo-root>`），输出 `evidence/static/static-audit.log`，**fail=0**。

### 3.1 CSS 变量：`var(--x)` 逐个对 `styles/tokens.css` 验可解析

```console
== 1. CSS 变量 ==
  tokens.css 定义 16 个；web/src 里 var() 引用 16 个不同变量
  未定义（幽灵变量）: 0
  上轮幽灵变量 --text-dim 出现次数: 0  （未复发）
  非字面量 var() 用法（无法静态判解析）: 0
```

- 扫描范围：`web/src/**/*.{vue,css,ts}` 全部 `var(--…)` 字面量引用；定义来源：`styles/tokens.css` 的 `:root`。
- **引用集合 = 定义集合**（16 = 16），无未定义；也没有 `var(--变量)` 形式的动态拼接（那种静态工具判不了，也不能靠 lint 兜）。
- **上轮修过的 `--text-dim` 幽灵变量确认未复发**（全仓 `text-dim` 命中 0）。
- 也没有组件用内联 `style="--x: …"` 或 `setProperty('--x', …)` 私自定义变量 —— 即"变量只有一个定义处"这条不变量成立。

### 3.2 路由：`router.ts` ↔ `views/*.vue` ↔ `App.vue` 导航

```console
== 2. 路由 ↔ 视图 ==
  router.ts 路由 8 条（其中重定向 1 条）：
    OK   /            name=console   → views/ConsoleView.vue
    OK   /terrain     name=terrain   → views/TerrainView.vue
    OK   /debug       name=debug     → views/DebugView.vue
    OK   /setup       name=setup     → views/SetupView.vue
    OK   /settings    name=settings  → views/SettingsView.vue
    OK   /board       name=board     → views/BoardView.vue
    OK   /vault       name=vault     → views/VaultView.vue
    SKIP /:pathMatch(.*)*   重定向路由（无组件，不算死路由）
  views/*.vue 共 7 个；未被任何路由引用（孤儿视图）: 无
  App.vue 导航 7 条；死链（指向不存在路由）: 无
  路由无导航入口: 无；label 不一致: 无
```

三方（路由表 / 文件系统 / 导航菜单）**完全对齐**：7 条真实路由 ↔ 7 个 `views/*.vue` ↔ 7 条导航项，`meta.label` 与 `App.vue` 的 `label` 逐条相同。通配路由 `/:pathMatch(.*)*` 是 redirect 到 `/` 的兜底，不是死路由。**无死路由、无孤儿视图、无死链。**

### 3.3 i18n / humanize：新增文案的兜底

```console
== 3. 文案/映射表兜底 ==
  找到 5 个 Record 映射表：['MAP', 'TONE', 'TYPE_META', 'kindClass', 'out']
    OK   views\\BoardView.vue: TONE[j.state] ||
    WARN components\\TerrainCanvas.vue: TYPE_META[Number(k)]
    WARN components\\ChatStream.vue: kindClass[m.kind]
    WARN views\\SettingsView.vue: out[k]
```

三条 WARN 逐条人工判定（**都不是悬空 key**）：

| WARN | 判定 | 理由 |
|---|---|---|
| `TYPE_META[Number(k)]` | 安全 | `TerrainCanvas.vue:39` 是在 `for (const k of Object.keys(TYPE_META))` 里取**自己的键**，永远命中 |
| `kindClass[m.kind]` | 安全 | 唯一消费点是 `:class="[kindClass[m.kind], …]"`（`ChatStream.vue:119`），Vue 对 `undefined` class 直接不渲染该 class，**不会把 "undefined" 画到屏幕上**；且 `m.kind` 类型是 `me`/`her`/`system` 三值，枚举完备 |
| `out[k]` | 误报 | `SettingsView.vue:118` 是 `out[k] = cur[k]` **赋值**，不是查找 |

关键结论：
- **`humanize()` 本身有兜底**（`api/humanize.ts:18-24`）：空原因 → `'失败（服务端没有给出原因）'`；未收录的码 → 原样返回；`timeout` / `agent_not_in_game` 有正则二级兜底。**不存在"查表 miss 就渲染 undefined"的路径。**
- 所有会**渲染成文本**的映射查找都有兜底（`TONE[j.state] || 'plain'`）。唯一有文本渲染直出风险的是 `DebugView.vue:163` 的 `diag.memory.reason`（见缺陷 S-4，低危）。

### 3.4 危险开关：`allow_insecure_coding` 是否真的带 `confirm:true`

**`PUT /api/config` 这条主路径：契约前后端一致，确认无误。**

| 环 | 位置 | 行为 | 判定 |
|---|---|---|---|
| 前端发 | `web/src/stores/config.ts:183` | `const body = opts.confirm ? { ...patch, confirm: true } : patch` | OK |
| 前端只对本次提交确认 | `views/SettingsView.vue:102` | `saveGroup(group, patch, { confirm: confirmedFor.value === 'runtime' })`，成功后立刻 `confirmedFor.value=''` | OK（#59 的"确认一次永远存不下去"没复发） |
| 前端二次确认弹窗 | `SettingsView.vue:91-96, 171-190` | 只有 `false→true` 才弹；关掉不需要确认；`acceptInsecure()` 确认后**立刻提交**（不再是"只改本地状态、无限弹框"） | OK |
| 服务端门 | `mindcraft/src/mindcraft/config_center.js:552` | `if (group === 'runtime' && applied.allow_insecure_coding === true && oldInsecure !== true && !confirmed)` → 409 `CONFIG_CONFIRM_REQUIRED` | OK |
| 服务端取 confirm | `mindserver.js:972-982` | `confirm` 与 patch **分开取**（`delete body.confirm`，避免被 SCHEMA 当配置项拒掉） | OK |
| 前端接 409 | `stores/config.ts:190-193` | `CONFIG_CONFIRM_REQUIRED` 与 `CONFIG_CONFLICT` 分开给可操作文案 | OK |

**但 `create-agent` 是另一条侧门 —— 见缺陷 S-1。**

---

## 4. 缺陷清单（本轮只记录，未修改任何代码）

### S-1（中危，安全契约）· `create-agent` 可绕过 `allow_insecure_coding` 的二次确认

- **现象**：`web/src/views/SetupView.vue:302` 有一个 `allow_insecure_coding` 复选框，`SetupView.vue:49` 把它放进 `create-agent` 的 settings 一起提交。服务端 `mindserver.js:1673` 的 `create-agent` 对该字段**只做 `settings_spec` 的 type 校验**；`allow_insecure_coding` 在 `mindcraft/src/mindcraft/public/settings_spec.json` 里就是 `{type:'boolean', default:false}`，**没有任何 `confirm` 门**。
- **后果**：#29 把 `allow_insecure_coding`（= 本机 root）定义成"必须二次确认"的高危项，但那条门只装在 `PUT /api/config?group=runtime` 上。走"配置向导 → 创建一个 agent"这条路，**一次点击就能把某个 bot 开成可写/执行本机任意 JS，且从不出现确认框、也不产生 409**。同一个安全等级，两条入口两种强度。
- **边界说明**：这不是"前端没带 confirm"，而是**服务端在 `create-agent` 上就没有这个门**；前端也确实没带（`SetupView` 里没有 `confirm` 概念）。两侧都对不上 #29 的口径。
- **建议（供后续单独立项）**：在 `create-agent` 的 settings 校验后加一道 `if (settings.allow_insecure_coding === true && settings.confirm !== true)` → `ack({success:false, error:'CONFIG_CONFIRM_REQUIRED'})`，前端 `SetupView` 补一个和 `SettingsView` 同款的确认弹窗（可复用 `acceptInsecure` 的文案）。注意 `confirm` 是协议层标记，不能进 `settings_spec`（同 `mindserver.js:972` 的处理）。
- **未修原因**：本轮硬要求"不修改产品代码"，且这条要动 `mindserver.js` + `SetupView.vue` 两个文件、跨两条工作流的写作用域。

### S-2（高，契约未闭环）· `web.md §9-1`：5 个控制事件仍然没有 ack

- **现象**：`restart-agent`(`mindserver.js:1976`)、`stop-agent`(`:1998`)、`start-agent`(`:2012`)、`destroy-agent`(`:2032`)、`send-message`(`:2140`) 的 handler 签名**一个 `callback` 形参都没有**（分别是 `(agentName)` / `async (agentName)` / `(agentName, data)`）。全仓搜 `NOT_RUNNING|ALREADY_RUNNING|RATE_LIMITED|TOO_LONG|NOT_IN_GAME` 在 `mindserver.js` 里**命中 0**。
- **后果**：前端 `api/socket.ts:115-121` 的 `emitControl()` 至今只能返回 `{ok:true}` = "发出去了"；15 秒没有状态帧就降级成"已发出但结果未知"。§9-1 要的"把 sent 升级为确认送达/确认被拒"**一点都没发生**。
- **§9-1 附带项也没做**：`send-message` 里 `agent_connections[sendTo].socket.emit(...)` 仍然包在 `try { } catch (error) { console.error('Error: ', error) }`（`:2171-2175`）—— socket 为 null 时抛的 `TypeError` 依旧被吞成一行 `Error: `，**连服务端都不认为那是"拒绝"**。此外"message 过长 / 触发限流 / `from` 非法"三处都是裸 `return`，调用方零反馈。
- **补充观察**：`start-agent` / `destroy-agent` 会 `socket.emit('start-agent-failed' | 'destroy-agent-failed', …)`（`:2021`、`:2055`），前端也监听了 —— 这是**事件帧**，不是 ack，覆盖不了"限流被拒""名字非法""panel_only"这些**根本没有 agent 参与**的拒绝分支。

### S-3（高，契约未闭环）· `web.md §9-2 / §9-3`：relay 没解耦、输出没重放

- **§9-2 relay 与订阅解耦 —— 未做**。`registerMapRelay(socket)`（`mindserver.js:2509`）**唯一调用点**是 `addListener()`（`:2424`），而 `addListener()` 的唯一调用点是 `listen-to-agents` 的 handler（`:2211`）。也就是说 `request-map` / `request-terrain` / `get-events` / `clear-events` / `get-task-state` / `get-memory` 的 handler **仍然只在订阅之后才存在**。§9-2 明确要求"在 `io.on('connection')` 里注册（或 `requirePanel` 通过后立即注册）"—— 没做。
- **§9-2 的 `listen-to-agents` ack 也没做**：`socket.on('listen-to-agents', () => {...})`（`:2199`）仍然**不收 callback**；被限流时是 `takeToken` 返回 false 后裸 `return`（`:2210`），不会回 `{ok:false, code:'RATE_LIMITED', retryAfterMs}`。前端只能继续靠"12 秒没状态帧"猜。
- **§9-3 输出可重放 —— 未做**。`bot-output`（`:2176`）仍是 `io.emit('bot-output', agentName, message)` 的**裸转发**：没有 `seq`，没有 ring buffer（`mindserver.js` 里搜 `seq` 命中 0），也没有 `get-output(sinceSeq, cb)` 处理器。前端因此只能用 `sessionStorage` 兜底，断线窗口内的输出**仍然永久丢失**。
  - 注：`mindcraft/src/agent/library/trace_bus.js` 里确实有一个 ring buffer + `since(sinceSeq)`，但它是给**结构化诊断事件**（`agent-event`）用的，与 `bot-output` 的纯文本流是两条独立的管，不能互相顶替。
- **§9-4 W13 传输层 —— 未做，且本就标注不阻塞**：`web/src/api/socket.ts:81-100` 的 `request()` 仍是手写 `Promise + setTimeout(15000)`，没有换成 `socket.timeout(ms).emit(...)`。§9 原文即写明"建议作为独立任务评估（不阻塞本单）"，因此**这条不算违背承诺**，在此仅记录状态。

### S-4（低，一致性）· 部分错误原因没走 `humanize()`

- `views/DebugView.vue:163`：`{{ diag.memory.reason }}` 直出；
- `views/SetupView.vue:189`：`` `失败：${r?.reason || '?'}` `` 拼接直出。

两处都**不会渲染 undefined**（有 `|| '?'` 或空字符串兜底），但会把 `agent_not_in_game` 这类内部串直接怼给用户，与 W14「错误码→人话」的初衷不一致。属"该用没用"，不是"兜底缺失"。

### S-5（低，重复实现）· `IdentityPanel` 私藏了一份 `humanize`

`components/IdentityPanel.vue:119-126` 定义了一个**本地 `humanize()`**，与 `api/humanize.ts` 的公共实现覆盖同一批码（`panel_only` / `unknown_agent` / `rate_limited` / `need_uuid_or_name`），但**文案不同、且多了一句句号**。两处**必然漂移**：`humanize.ts` 里新增的码（`OFFLINE`、`空响应`、`超时`）在 identity 面板里拿不到翻译。

---

## 5. 上轮 `web.md §9` 四条服务端需求的逐条核对

| # | 需求（`web.md §9`） | 本轮只读核对结果 | 判定 |
|---|---|---|---|
| 1 | 5 个控制事件加 ack，统一 `{ok:false, code:…}`；顺手把 `send-message` 的 `TypeError` 变 `NOT_RUNNING` | handler 全部无 `callback` 形参；`NOT_RUNNING` 等 5 个码全仓 0 命中；`TypeError` 仍被 `console.error('Error: ')` 吞 | **未实现**（S-2） |
| 2 | relay 与订阅解耦（`connection` 时注册）；`listen-to-agents` 加 ack（`RATE_LIMITED` + `retryAfterMs`） | `registerMapRelay` 仍只被 `addListener` 调用、`addListener` 仍只被 `listen-to-agents` 调用；`listen-to-agents` 不收 callback、限流时裸 `return` | **未实现**（S-3） |
| 3 | `bot-output` 加 `seq` + ring buffer（1000 条），新增 `get-output(sinceSeq, cb)` | `bot-output` 仍裸转发，无 `seq`、无 ring buffer、无 `get-output`（`trace_bus` 的 ring buffer 属另一条管） | **未实现**（S-3） |
| 4 | W13：`request()` 改 `socket.timeout()` | 仍是手写 `Promise + setTimeout` | **未做（§9 已标注"不阻塞"）** |
| — | `PUT /api/config` 的 `confirm:true`（§9 说"已在本次落地"） | 前后端一致，两类 409 分开处理 | **已实现**（§3.4） |

---

## 6. 本轮**没有**做什么（口径声明）

- **没跑 dev server**（会占端口），**没跑浏览器**，所以本文件里**没有任何"界面上看到什么"的断言**。运行时的可见性问题（布局、交互、真实 socket 行为）不在本文件覆盖范围。
- **没改任何产品代码**：`git status` 里本轮只新增 `docs/audit-r6/fixes3/`（`web/dist` 因 `npm run build` 被重写，但内容与入库产物逐字节相同，见 §2.3）。
- 未验证 `release.ps1` 的**非** VerifyOnly 路径（会 `npm run build` + 同步 + 重写 `MANIFEST.json`，属发布动作，不在本线职责内）。
- §9 四条只做**只读代码判断**，未起 mindserver 做行为验证。

## 7. 复跑方式

```bash
# 门禁
cd web && npx vue-tsc --noEmit && npm run build
cd .. && node mindcraft/tools/web_dist_manifest_unit.mjs          # 期望 10/10
powershell -NoProfile -File scripts/release.ps1 -VerifyOnly      # 期望 8/8

# 产物可复现性
PYTHONIOENCODING=utf-8 python docs/audit-r6/fixes3/evidence/static/dist_compare.py .

# 静态审计（CSS 变量 / 路由 / 文案兜底）
PYTHONIOENCODING=utf-8 python docs/audit-r6/fixes3/evidence/static/static_audit.py .
```
