# R6 fixes3 · 真机验收汇总（t5）

> 汇总人：qa-report（acceptance-r6b，t5，attempt 1，2026-11-12 00:1x–00:4x CST）
> 输入：`fixes3/{e2e,smoke,panel,static}.md` + `fixes3/evidence/`（根目录 35 个文件 + `static/` 8 个）
> **口径**：数字一律照抄子报告，不四舍五入、不美化、不合并口径不同的分母；本轮汇总**未改任何产品代码**，**未新起任何服务/端口**（只做了只读核对）。
> 子报告：`e2e.md`（502 行，含 §7 阻塞项修复、§8 claims/restart；§0 的失效判断已就地标「已闭」）、`smoke.md`（274 行）、`panel.md`（271 行）、`static.md`（267 行）。

---

## 0. 一句话结论

五条线里，**修复类判据基本兑现**（#44-② / #11 / #9、#66 / #59 / #30 / #33 / #68、静态与产物门禁），**两处仍是红的**：

1. **#57 控制面 ack —— 仍未实现**（后端 5 个 handler 无 `callback` 形参，前端只能"发出即未知"）。
2. **F1 `start-panel.ps1` 入口必失败 —— blocker**（判据要绝对 jar 路径，脚本自己用相对 `-jar server.jar`）。

一条阻塞项**已闭**：`scripts/e2e.ps1` 的 JDK 预检（PS 5.1 stderr 坑），chest 由「1 秒 FATAL exit 1」变为「30/30 exit 0」。
另有一条"红"**不是产品红**：`claims` 场景 5/10（内部 1/13，12 条 `NO_PERMISSION`）红在 **t37 工具没跟上 R6 身份门** ⇒ 产品侧预约/冲突逻辑本轮**未验证**（不能说有问题，也不能说没问题）。

---

## 1. 执行概览与墙钟

| 线 | 端口 | 子报告记载的窗口（CST） | 结果 |
|---|---|---|---|
| E2E · chest（手工等价路径，官方入口当时被 JDK 预检卡死） | 25566 / RCON 25576 | 21:53–22:57（64 min） | 20/20 exit 0；跨重启 2/2 |
| 阻塞项 · e2e JDK 预检修复（t1） | 25566/25576/18093 | 23:0x–23:2x（约 20 min） | 修后 `-Scenario chest` **30/30 exit 0** |
| E2E · claims / restart（t6） | 25566/25576/18093 | 23:26–23:47（21 min） | restart 13/13 exit 0；claims 5/10 exit 1 |
| 冒烟 · 控制面（t2） | 8081 | 23:38–23:56（18 min） | 4 PASS + 1 PASS（附观察）+ 1 FAIL |
| 启动链（t3） | 8080 + 25565 + RCON 25575 | 23:05–00:10（65 min） | 5 项 PASS + **F1 FAIL** |
| 静态与产物（t4） | 无端口 | 23:04–23:58（54 min） | 全绿（fail=0），缺陷 S-1…S-5 |

**墙钟 vs 串行和（估算，按上表窗口相加）**：四线并行带为 **23:04–00:10 ≈ 66 min**，而该带内各线窗口之和 ≈ 65+54+41+18 = **178 min**；整批实际 21:53→00:10 ≈ **137 min**，各段之和 ≈ 242 min。并行省下约 105 min，符合"墙钟≈max 而非 sum"。
（`chest` 的手工段 21:53–22:57 是前置串行段，当时其余四线尚未开工，不计入并行收益。）

**并行不互扰的证据**：四条线的端口集合互不重叠且各自收工后自证（8080/8081/25565/25566/25575/25576/18093 全空闲）；`e2e.md` §8.4 明确记录"发现 `node serve-8081.mjs`、`java …tmp\panel-accept\root\server\server.jar`、`node init_agent.js -p 8080` 属并行其它线，**只杀自己起的 pid**，这些一律未碰"。

---

## 2. 已验 PASS（逐条，结果 + 日期）

### 2.1 E2E 真机（2026-11-11）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| A1 | 头号缺陷「chest 取物要 8 搬 11」是否复现 | **未复现**：`fetch(8)` 精确搬 8；累计 **10+ 次 `fetch(8)`，`+16`/`16→0`/账目错 三种坏签名各 0 次** | `chest-live-run1.log`（20/20）、`run6/run7`（各含 `+8/-8`）、`rcon-truth-probe-mapfix.log`（RCON 6/6） |
| A2 | chest 场景断言（干净世界） | **20/20 PASS**，48s，exit 0 | `chest-live-run1.log` |
| A3 | 跨重启持久化 | **2/2 PASS**，7s，exit 0（bot 读 + RCON 读双证：箱内仍 8 个 oak_log） | `chest-live-persist.log` |
| A4 | 「一条命令跑完」·chest（修 JDK 预检后） | **30/30 PASS，exit 0**，日志 FATAL 计数 **0**（此前 1 秒 exit 1） | `e2e-ps1-jdk-fixed-chest.log` |
| A5 | 「一条命令跑完」·restart | **13/13 PASS，exit 0**，55s；箱子 / 熔炉产物与燃烧进度 / `memory.json` / `memory_bank` 跨重启全在 | `e2e-ps1-restart-keeprun.log`、`e2e-restart-stage.log`、`e2e-restart-verify.log` |
| A6 | #53 三段预检（修好后首次真正执行到） | 三端口预检未误报；`Resolve-Java` 取最高版本且 ≥21；停服后 junction 先摘再删、`server-test/{libraries,versions,cache}` 未被删（75M/28M/55M，`libraries` 119 文件） | `e2e-ps1-jdk-fixed-chest.log`、`e2e.md` §7.2 |
| A7 | 回归门禁 | `node scripts/tests/ops-regression.mjs` → **87 passed / 0 failed**（含 R6#53 三条） | `e2e.md` §7.3 |

> 另有 4 轮"红但不是缺陷"的运行如实记录在案：run2–4（世界未重置）15/20、14/20、15/20；run5–7（清箱后）15/20、19/20、18/20 —— **`断言D/D2/D3` 全部 PASS，RCON 每轮都是 8**，失败项全是客户侧读数（见缺陷 N-9）。

### 2.2 控制面冒烟 8081（2026-11-11 23:38–23:56）

| 条目 | 结果 | 关键实测 |
|---|---|---|
| #66 错 token 握手 | **PASS** | 错 token / 无 token 均 `connect_error.code=AUTH_REQUIRED`（`auth_gate.js:227`）；4s 内 `connectErrorCount=1`，无重连风暴；HTTP 无 token 401 / 带 token 200 |
| #59 配置二次确认 | **PASS** | 不带 `confirm` → `409 CONFIG_CONFIRM_REQUIRED` 且 `settings.js` **sha256 字节级不变**；带 `confirm` → 200 且写盘；已复原，`git status` 无 `settings.js` |
| #30 `/unlock` 限流 | **PASS**（附观察 N-10） | 顺序 6 次错口令 401×5 → 第 6 次 `429 VAULT_TOO_MANY_ATTEMPTS`；**被限流后正确口令仍 200**；6 并发耗时 80/122/176/277/349/417ms（串行化、无排队） |
| #33 限流按 agent 分桶 | **PASS** | `smokeA` 打满 20/60s，第 21 次 `rate_limited`；`smokeB` 首次照常拿 settings；服务端日志点名 `主体 agent:smokeA`（同机 127.0.0.1，仅主体不同） |
| #68 任务板 socket API | **PASS** | `board:add(collect, args="block=oak_log count=1")` → id；`list` / `list(openOnly)` 可见；`set-state(cancelled)` 成功且 openOnly 消失；`limit=9999` → `TOO_MUCH`；未知技能被拒且列出可用技能 |
| #57 控制命令 ack | **FAIL** | 见缺陷 N-2（四类失败帧 5/5 都真的会发，这一半是 PASS） |

隔离方式（重要）：不跑 `main.js`（`:88-91` 会 `createAgent` 连 25565，与启动链线冲突），只调 `Mindcraft.init(false, 8081, false)`；`MC_BOTS_ROOT` / `MC_VAULT_DB` 全部指向 `tmp/smoke-r6`，**0 个 agent 子进程**。

### 2.3 启动链 8080 + 25565（2026-11-11 23:05 – 11-12 00:10）

| # | 判据 | 结果 | 关键实测 |
|---|---|---|---|
| B1 | #44-② bot 未就绪不许报成功 | **PASS** | 真等 120s → `waited 120s and the log never said 'spawned.'` → **exit 1**；`mindcraft-console.log` 里 `spawned.` **0 次**（旧实现会 exit 0） |
| B2 | #11 连不上 ≠ 没在跑 | **PASS** | 静默 8080（accept 后永不回字节）→ **exit 5**「无法确认 mindserver 是否在运行……**没有**执行任何停止动作」；真空情况下 → exit 0「没在跑」 |
| B3 | #9 备份脱敏 + 插件清单 | **PASS** | `rcon.password=` 抹空、`enable-rcon=true` / `white-list=true` 保留；测试口令在整个备份目录 **0 命中**；`manifest.pluginJars` **6 条含 sha256**；`containsSecrets:false` |
| B4 | 启动日志 `Done (` 与面板 HTTP | **PASS** | `Done (28.758s)!`、`Done (20.474s)!`；`/console?token=` → **200**（Vue 外壳「陪玩控制台」）；带 cookie 取 `index-BUfQgcJJ.js` → 200，无 cookie → 401 |
| B5 | RCON 优雅停服、java 真退出 | **PASS** | `stop-panel.ps1` →「已确认 Minecraft 退出（25565 端口已关闭）」→「完成。」**exit 0**；java 0、25565/25575/8080 无监听 |

隔离：镜像根 `tmp/panel-accept/root`（`server/` 不指向生产、world 从 `test-template` 拷）；收工后 `server/world` mtime 仍 `Nov 7 16:02`，`find server/world -newermt "2026-11-11 23:00"` 无文件，生产 `backups/` 最新仍是 `world-20261111-043001`。

### 2.4 静态与产物（无端口，2026-11-11 23:04–23:58）

| 门禁 | 结果 |
|---|---|
| `cd web && npx vue-tsc --noEmit` | **EXIT=0**（`strict:true` / `noImplicitAny:true` 仍开着） |
| `npm run build` | **EXIT=0**，16 个产物；两次独立构建哈希完全相同 |
| `node mindcraft/tools/web_dist_manifest_unit.mjs` | **10/10**（构建前后各一次，均 10/10） |
| `powershell -File scripts/release.ps1 -VerifyOnly` | **8/8**（`[2/8]` / `[3/8]` 按设计 WARN 跳过） |
| 构建可复现性（额外补做） | 重新构建的 `web/dist` 与入库 `mindcraft/web-dist` **16/16 逐字节一致** |
| 静态审计 `static_audit.py` | **fail=0**：CSS 变量 16 定义 = 16 引用（幽灵 `--text-dim` 0 命中）；路由 8 条 = 7 真实 + 1 通配 redirect，7 视图全对应、无死路由/孤儿视图/死链；`humanize()` 三级兜底；3 条 WARN 逐条判安全 |
| 危险开关契约 | `PUT /api/config` 的 `confirm:true` 前后端一致（`config.ts:183` / `SettingsView.vue:102` / `config_center.js:552` / `mindserver.js:972`）—— 但 `create-agent` 有侧门（N-3） |

---

## 3. 验出缺陷（按严重度排序；文件:行 + 现象 + 复现）

> 严重度为本汇总统一口径；子报告另有标注时括注。**状态**列只描述事实，不含推测。

### N-1【blocker】`start-panel.ps1` 入口必然启动失败（F1）

- **文件:行**：`scripts/start-panel.ps1`（`Get-ServerJava()` 判据 `$cmd.Contains(<root>\server\server.jar 绝对路径)`）vs 同文件启动处 `Start-Process … -ArgumentList '-Xms1G','-Xmx2G','-XX:+UseG1GC','-jar','server.jar','nogui'`
- **现象**（两种面都实测）：
  - 面 A（冷启动）：`[错误] 服务器进程已经退出了，没能启动成功` → **exit 1**（约 45s），而服务端 28.758s 后才 `Done`；实测命令行 `… -jar server.jar nogui`（相对名），判据永不成立。
  - 面 B（服务端在跑时重跑）：`[错误] 25565 已被**别的程序**占用` → **exit 1**，而那个 25565 正是本脚本自己起的。
- **复现**：`cd tmp/panel-accept/root; powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-panel.ps1`（日志 `panel-start-run1-serverdied.log` / `panel-start-run2-port-foreign.log`）
- **状态**：报告时**未修**。**注意**：汇总时（2026-11-12 00:18）工作区出现 `M scripts/start-panel.ps1`（把 `-jar` 改成 `(Join-Path $srvDir 'server.jar')`，即 panel.md §6 的修法 A），**但本轮没有任何复跑证据**，team 任务列表也没有对应验收单 ⇒ 该修复**未经验收**，F1 状态应视为「已改、未证」。

### N-2【高】#57 / S-2：5 个控制事件仍无 ack，`send-message` 的 TypeError 仍被吞

- **文件:行**：`mindcraft/src/mindcraft/mindserver.js:1976`（`restart-agent`）、`:1998`（`stop-agent`）、`:2012`（`start-agent`）、`:2032`（`destroy-agent`）、`:2140`（`send-message`）—— 五个 handler 签名**一个 `callback` 形参都没有**；`NOT_RUNNING|ALREADY_RUNNING|RATE_LIMITED|TOO_LONG|NOT_IN_GAME` 在 `mindserver.js` 里**命中 0**。
- **现象**：`emit(..., cb)` 等 1.2s **全部无回执**（`ms:1206–1213`）。对照：`create-agent`(`:1673`)、`shutdown`(`:2090`)、`identity-*`、`server-*`、`get-settings` 都有 ack ⇒ 是这五个漏了，不是架构问题。
- **附带（真机抓到）**：目标 agent socket 为 null 时 `send-message` 在 `:2170` 抛 `TypeError: Cannot read properties of null (reading 'emit')`，被 `:2171-2175` 的 `catch { console.error('Error: ', error) }` 吞成一行 ⇒ **既无 ack 也无失败帧**（`fixes2/web.md §9-1` 点名的未修项）。
- **另一半是 PASS**：四类失败帧**都真的会发** —— `start-agent-failed`、`destroy-agent-failed`、`agent-channel-rejected`、`agent-channel-taken-over`，另加 `control-denied`，实测 5/5 收到（`smoke.md` §2.2）。
- **复现**：`cd mindcraft/tmp/smoke-r6 && node serve-8081.mjs` 后 `node probe.mjs`（`smoke-8081-mindserver.log:41-46`）

### N-3【高/中危（安全契约）】`create-agent` 可绕过 `allow_insecure_coding` 的二次确认（S-1）

- **文件:行**：前端 `web/src/views/SetupView.vue:302`（复选框）/ `:49`（放进 `create-agent` 的 settings）；服务端 `mindcraft/src/mindcraft/mindserver.js:1673`（只做 `settings_spec` 的 type 校验，**无 confirm 门**）。#29 的门只装在 `PUT /api/config?group=runtime`（`config_center.js:552`）。
- **现象**：走"配置向导 → 创建 agent"，一次点击即可把某个 bot 开成可写/执行本机任意 JS，**从不出现确认框、也不产生 409**；同一安全等级两条入口两种强度。
- **复现**：静态判定（`static.md` §4 S-1），未做运行时注入 —— 因为服务端根本没有这道门。
- **状态**：未修、未立项。

### N-4【高】`web.md §9-2 / §9-3` 三项服务端能力一项未落地（S-3）

- **§9-2 relay 解耦 —— 未做**：`registerMapRelay(socket)`（`mindserver.js:2509`）唯一调用点是 `addListener()`（`:2424`），`addListener()` 唯一调用点是 `listen-to-agents` handler（`:2211`）⇒ `request-map` / `request-terrain` / `get-events` / `clear-events` / `get-task-state` / `get-memory` 仍**只在订阅之后才存在**。
- **§9-2 `listen-to-agents` ack —— 未做**：`socket.on('listen-to-agents', () => {…})`（`:2199`）不收 callback；限流时 `takeToken` 返回 false 后**裸 return**（`:2210`），不回 `{ok:false, code:'RATE_LIMITED', retryAfterMs}`。
- **§9-3 输出可重放 —— 未做**：`bot-output`（`:2176`）仍是裸转发 `io.emit('bot-output', agentName, message)`，无 `seq`、无 ring buffer、无 `get-output(sinceSeq, cb)`（`mindserver.js` 搜 `seq` 命中 0）。`trace_bus.js` 的 ring buffer 属**另一条管**（`agent-event`），不能顶替。
- **§9-4（`request()` → `socket.timeout`）未做**，但 §9 原文已标"不阻塞"⇒ 只记状态，不算违背承诺。

### N-5【高（工具）】claims 场景在 R6 agent 凭据下必红（12/13）

- **文件:行**：`mindcraft/tools/t37_claims_contention_live.mjs:57`（父进程内起 mindserver）、`:111-116`（`ms_token` env 优先拿到 agent 凭据）、`:121`（`await c.hello()` 的异常被 `try/catch {}` 吞）
- **现象**：`E2E 失败：5/10`，exit 1，内部 **1/13**；12 条争用断言全部 `{"ok":false,"code":"NO_PERMISSION"}`；服务端原文「这条 agent 连接还没完成 agent 握手（socket.data.agentName 为空）：先 login-agent 再来 board:hello」。
- **成因链**：`mindserver.js:1019-1021` 把 `process.env.MINDSERVER_TOKEN` 覆盖成**无 agentName 的 agent 凭据** → `auth_gate.js:195-207` 判 `role=agent` → `board_server.js:248-254` 要求 `socket.data.agentName` 已被 `login-agent` 盖戳 → t37 从未发 `login-agent` ⇒ `board_server.js:296-298` 每次 `reserve` 都 `NO_PERMISSION`。
- **复现**：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/e2e.ps1 -Scenario claims`（59s / 43s，两轮逐条一致）
- **产品影响**：产品侧预约/冲突/反向对照逻辑**一条都没被执行到** ⇒ 本轮**未验证**（不能据此说好或坏）。
- **同族**：`t37:184-185` 的第 ⑤ 条是**空断言假通过**（`{"before":0,"after":0}`，`before=0` 时 `after.length===0` 恒真），应改为 `before.length===1 && after.length===0`。

### N-6【中】`store` 的账目仍信客户端：箱内已有同类物品时自报 < 物理

- **文件:行**：`mindcraft/src/agent/library/act_container.js:665`（`fail('INVENTORY_FULL', '只存进去 ${m.stored}/${take}')`）→ `mindcraft/src/agent/library/flow_store.js:235`（`只存进去 ${storedTotal}/${target}`，`partial:true`）
- **现象**（3 轮里 1 轮）：`round1: 箱 16→32（物理 +16）；背包 32→16；自报 stored=9 ok=false code=INVENTORY_FULL` —— **物理搬了 16 件却报"只存进去 9/16"并返回失败**；round2/round3 自报 `stored=16 ok=true`。上层若按 `stored` 重试就会**重复搬运**。
- **触发条件**：目标箱**已有同类可叠加物品**（预置 16 个 oak_log 在 slot0）；箱子为空时 6/6 全对。
- **不对称**：`fetch` 已在 T38 用"关窗→重开读服务端真值"修正（`flow_store.js:313` `takenSource:'server'`），**`store` 没跟上**。
- **复现**：`RCON_PORT=25576 RCON_PASSWORD=*** MC_BOTS_ROOT=<run>/bots node mindcraft/.tmp-probe/store_account_probe.mjs`（探针跑完即删；日志 `store-account-probe.log`）
- **边界**：只 3 轮、1 次复现，未统计频次；`m.stored` 具体错在读槽还是按键计数**未定位到行内表达式**。

### N-7【中】live 工具不建 `<botsRoot>/<name>/map` → 3D 扫描打不开库 → 需走路场景间歇失败

- **文件:行**：`mindcraft/src/agent/library/bot_paths.js`（`mapDirOf` 返回 `<botsRoot>/<name>/map`）→ `terrain3d.js:95-96`（`openDb3d` 里 ``new DatabaseSync(`${baseDir}/terrain3d.db`)``）；报错点 `executor.js:987`（`[walkTo] 3D 扫描失败:`）
- **现象**：`[walkTo] 3D 扫描失败: unable to open database file` 成对刷屏；sqlite **不建父目录**，而 `MC_BOTS_ROOT` 指过去的树里没有 `<name>/map`（实测 `find <run>/bots` 为空）。
- **后果**：目标不在交互距离内时 `walkTo` 失去 3D 规划 ⇒ `store`/`fetch` 直接失败（`stored=0`，物品守恒、无损失）。对照 A **3/5**（round4/5 挂在这里）；预建 map 目录后 **6/6 全绿、零扫描报错**。
- **影响面**：所有设 `MC_BOTS_ROOT` 却不建子目录的 `tools/*_live.mjs`；`scripts/e2e.ps1` 同样只设 `MC_BOTS_ROOT`（`:296/:343/:470`）不建 map —— chest 场景恰好站在 3 格内（交互距离内）**掩盖**了它。
- **复现**：`MC_BOTS_ROOT=<空目录> node mindcraft/tools/e2e_chest_store_live.mjs`

### N-8【中】失败现场被脚本自己删掉 —— 默认跑法拿不到失败证据

- **文件:行**：`scripts/e2e.ps1:575-577`（`if (-not $KeepRun) { Remove-RunDirSafe -Dir $runDir }`；`finally` 里 `:597` 还有一次）
- **现象**：`-Scenario claims` 不带 `-KeepRun` 时失败后照样删 `tmp/e2e/claims/`，而 t37 的原始输出（含每条 FAIL 的 `{ok,code,…}`）**只**写在该目录 ⇒ 想知道"为什么红"必须再跑一遍（本次白花 43s）。
- **复现**：`... -Scenario claims`（不加 `-KeepRun`）→ `ls tmp/e2e/` 为空

### N-9【低】`fetch` 后 `containerItems()` 间歇读到空/0（客户侧读数抖动，非搬运错误）

- **文件:行**：`mindcraft/tools/e2e_chest_store_live.mjs:67`（`settleWindow`「等同步 + 1200ms 静默」）
- **现象**：fetch 刚结束 `containerItems()` 读到 `{}`（RCON 同期是 8）；`clear`+`give` 之后 `bot.inventory` 读到 0（实际 4/24）。清箱后 3 次运行出现 1–2 项（run5 最重，5 条 FAIL）。
- **判读**：**物理真值始终正确**（RCON 每轮 8），是 live 断言测量面在抖 ⇒ 会让官方 chest 场景**间歇性红**，容易被误当回归。**建议把关键断言改为以 RCON 真值为准**（`takenSource:'server'` 已是这个思路，场景断言层没跟）。

### N-10【低】#30 新加的 scrypt 并发闸在 HTTP 层不可触发（真机死代码）

- **文件:行**：`mindserver.js:656` `createConcurrencyGate({max:2})`、路由 `:756`；`secrets_vault.js:234` 用**同步** `scryptSync`
- **现象**：`scryptSync` 阻塞事件循环 ⇒ "同时在算"的解锁永远 ≤1，`max=2` 的闸永远打不到，`429 VAULT_BUSY` 真机 0 次（6 并发实测）。
- **两面**：并发被串行化（80→417ms 单调递增）⇒ DoS 不成立；但闸是死代码，语义只在离线单测（`control_plane_r6_unit.mjs:32-55`）里成立。
- **建议**：注释写明"仅 KDF 异步化后生效"，或把 `scryptSync` 换成 `crypto.scrypt`。

### N-11【低】S-4 / S-5 / progress=nulls（文案与日志一致性）

- `views/DebugView.vue:163`、`views/SetupView.vue:189` 直出 `reason` 未走 `humanize()`（有 `|| '?'` 兜底，不会 undefined，但会把 `agent_not_in_game` 这类内部串怼给用户）。
- `components/IdentityPanel.vue:119-126` 私藏一份 `humanize()`，与 `api/humanize.ts` 文案不同且多句号 ⇒ 两处**必然漂移**。
- `tools/e2e_restart_live.mjs` 的 `progress=nulls` / `fuelSeconds=nulls` 是 `${undefined}s` 字符串化伪影，**不影响判定**（实际煤 8→7、产出 `iron_ingot|1`）。

### N-12【已闭】`scripts/e2e.ps1` JDK 预检（PS 5.1 stderr）

- **文件:行**：`scripts/e2e.ps1:59`（`$ErrorActionPreference='Stop'`）+ `Resolve-Java` 的 `& $c -version 2>&1` 包在 `try/catch{}` 里
- **现象（修复前）**：`java -version` 把版本号写 stderr，PS 5.1 在 Stop 下抛 `NativeCommandError` → 被 `catch {}` 吞 → `$ver` 恒 null → `FATAL 解析不出任何 JDK 的主版本号`，**1 秒 exit 1**，一个断言都没跑（`e2e-ps1-jdk-fatal.log`）。
- **修复（t1，2026-11-11）**：只在该行临时 `$ErrorActionPreference='Continue'`、`finally` 还原、正则解析移到 `try` 外（9 插入/2 删除）；未用 `-ErrorAction SilentlyContinue` 掩盖真错；未动 #53 的三端口预检与 junction 清理。
- **验证**：Parser ERR=0；`-Scenario chest` **30/30 exit 0**、FATAL 0；`ops-regression` 87/87。
- **结论**：**已闭**。`e2e.md` §0 第 2 条「e2e.ps1 跑不起来」**已失效**——本次汇总已把 §0 该行与「一句话」里的同一判断就地划掉并标注「已闭（2026-11-11 修复，复跑 30/30 exit 0）」；§3.1 原文保留作历史缺陷记录（§7.5 早已注明可视为已修）。

---

## 4. 仍不可验（缺环境 / 缺工具 / 未指派）

| # | 项目 | 为什么不可验 | 需要什么才能验 |
|---|---|---|---|
| U-1 | ADR §11.5-3 **Docker 路径（#52）** | **本机没有 docker**：`docker --version` → `docker: command not found`（2026-11-12 00:2x 实测）。`docker-preflight.ps1` / `docker compose up` 全未执行 | 装 Docker Desktop（或等价 runtime）+ 可拉镜像 |
| U-2 | ADR §11.5-2 **防火墙跨机验证（#48）** | 本单要求"另一台机器 `Test-NetConnection <LANIP> -Port 25575 = False`"，**需第二台机器**；本轮只做了脚本侧自检旁证（`panel.md` §2：「RCON 入站已收紧（防火墙规则 deny-rcon-25575-in 在位且形态正确）」） | 第二台同网机器 |
| U-3 | **claims 产品逻辑**（预约/冲突/反向对照/泄漏） | **不是环境问题，是工具问题**：t37 没做 `login-agent`，12 条断言 `NO_PERMISSION`（N-5） ⇒ 产品代码一条都没被执行到 | 先修 t37（面板凭据或补 `login-agent`），再复跑 43–59s |
| U-4 | ADR §11.5-6 **板库 `user_version` 2→3（10.2-7）** | 本轮未指派；冒烟线用的是**隔离库**（`tmp/smoke-r6/bots/_board`），不能也不该用来验生产库升级 | 起一次服务后 `PRAGMA user_version` 查线上库 |
| U-5 | ADR §11.5-7 **多进程并发写板库** | 本轮未指派（需真机多进程 + 观察 `BOARD_BUSY` 与半份数据） | 多进程压测脚本 |
| U-6 | ADR §11.5-8 **`memory.json` 损坏样本** | 本轮未指派（需手工截断一只 bot 的 memory 后启动） | 手工破坏样本 + 启动观察 |
| U-7 | ADR §11.5-1 **计划任务真能备份（#54）** | 本轮未指派；只有旁证：仓库 `backups/` 最新 `world-20261111-043001`（`panel.md` §1 记录），**未见 `LastTaskResult=0` 与 `logs/backup-auto.log` 新增行** | 跑 `install-backup-task.ps1` + 等一次触发 |
| U-8 | `store` 的「第一箱半满 → 换第二箱（storefull）」成功分支 | 只触发过失败（`INVENTORY_FULL`），**未验证成功换箱** | 构造半满箱 + 小容量目标 |
| U-9 | 大数量（>64/跨多格）、nbt/components 物品（潜影盒/命名物品）、bot 死亡/掉线窗口残留 | 本轮未覆盖（`e2e.md` §5 自陈） | 需专门场景 |
| U-10 | 浏览器端可见性（布局/交互/真实 socket 行为） | 静态线**明确没跑浏览器、没跑 dev server**（会占端口）；冒烟线只验 socket 层 | 允许开浏览器/端口的单 |
| U-11 | `release.ps1` 的**非** VerifyOnly 路径（会写产物/清单） | 属发布动作，不在这几条线职责内 | 发布窗口 |

---

## 5. ADR §11.5 对照（详见 ADR 正文，本节为摘要）

| ADR 项 | 本轮状态 | 结果 |
|---|---|---|
| 11.5-1 计划任务备份 `LastTaskResult=0` | **未验**（仅旁证：`backups/` 最新 `world-20261111-043001`） | — |
| 11.5-2 防火墙跨机 `Test-NetConnection` | **未验**（缺第二台机器；仅脚本自检旁证） | — |
| 11.5-3 Docker 路径 `docker compose up` | **未验**（本机无 docker） | — |
| 11.5-4 e2e 三场景 `scripts/e2e.ps1` | **部分验**：chest 30/30 exit 0；restart 13/13 exit 0；claims 5/10（工具问题） | 端口预检不误报 ✅ / 无残留 junction ✅ |
| 11.5-5 面板端到端（#44/#49） | **部分验**：构建/产物一致 ✅（静态线 16/16）、启动 `Done` ✅、HTTP 200 ✅、停止 RCON ✅；**入口 F1 阻塞** ❌ | 见 N-1 |
| 11.5-6 板库升级 2→3 | **未验**（未指派；冒烟用隔离库） | — |
| 11.5-7 多进程并发写板库 | **未验**（未指派） | — |
| 11.5-8 `memory.json` 损坏样本 | **未验**（未指派） | — |

---

## 6. 环境与残留（汇总时实测，2026-11-12 00:2x–00:4x）

### 6.1 起过什么、停没停

| 线 | 起过 | 停法 | 现状 |
|---|---|---|---|
| E2E | Paper 测试服（25566 / RCON 25576）、t37 内嵌 mindserver（18093）、临时探针进程 | RCON `stop`（java exit 0）；t37 随进程退出；探针跑完即删 | **全停** |
| 阻塞项修复 | 同上（复跑 chest 时起了测试服） | 脚本自行停服 + 清 `tmp/e2e` | **全停** |
| 冒烟 | `node serve-8081.mjs`（PID **27980**，8081） | 手动终止 | **已停**（`Get-Process -Id 27980` 不存在） |
| 启动链 | Paper（25565 / RCON 25575）、`node main.js`（8080）、`node hang8080.mjs` 故障注入 | `stop-panel.ps1`（RCON stop）→ java exit 0；注入器自行退出 | **全停** |
| 静态 | 无（零监听端口） | — | — |

### 6.2 端口现状（汇总时实测）

`netstat -ano` 对 **8080 / 8081 / 25565 / 25566 / 25575 / 25576 / 18093 全部无监听**；
`Get-Process java,node` **无输出**（0 个）。

### 6.3 遗留文件 / 目录（都是临时物，非产品代码）

| 路径 | 内容 | 清理要点 |
|---|---|---|
| `tmp/panel-accept/`（260M） | 镜像根：`root/{scripts,mindcraft,web,server,config,bots,logs,backups}` + 5 个 junction（`node_modules`×2、`.tools`、`server/{libraries,versions,cache}`）+ 注入器/日志 | **勿 `rm -rf`**（会顺 junction 删到真实依赖）。先对每个 junction `cmd /c rmdir <junction>`，再删其余 |
| `mindcraft/tmp/smoke-r6/` | `serve-8081.mjs` / `probe.mjs` / `probe2.mjs` / 隔离 `bots/`（含 `_board`）/ `vault.sqlite` / `smoke-credentials.json` / `server.log` | 可留可删；`tmp` 下非产品路径 |
| `tmp/e2e/` | **空**（脚本自行清理；`server-test/{libraries,versions,cache}` 未被删，75M/28M/55M，`libraries` 119 文件） | 无需动作 |
| `docs/audit-r6/fixes3/` | 本批文档 + `evidence/`（根 35 个文件 + `static/` 8 个） | 交付物，保留 |
| `mindcraft/.mindserver-token` | 正常轮换的 token（gitignore） | 无需动作 |

### 6.4 生产未被动的证据

- `server/world` mtime 仍 `Nov 7 16:02`；`find server/world -newermt "2026-11-11 23:00"` 无文件。
- 仓库 `backups/` 最新仍是 `world-20261111-043001`（本次备份全落在镜像根）。
- `mindcraft/settings.js` 字节级复原（sha256 回到测试前）；测试产生的 `settings.js.bak-*` 已删。

### 6.5 当前工作区状态（**与子报告写作时不同，需注意**）

```
 M scripts/e2e.ps1          ← t1（JDK 预检）已修、已真机验证（30/30）
 M scripts/start-panel.ps1  ← 2026-11-12 00:18 出现，为 F1 修法 A（-jar 改绝对路径），
                              无复跑证据、无验收单 ⇒ 未经验收
?? docs/audit-r6/fixes3/    ← 本批交付物
```

`e2e.md` / `panel.md` 落笔时 `git status` 只列 `M scripts/e2e.ps1`；汇总时多出 `M scripts/start-panel.ps1`。**本汇总不认领该修复**，只如实记录其存在与"未证"状态。

---

## 7. 数字对账（防两套口径混用）

1. **claims 的 10 与 13**：`5/10` 是 `e2e.ps1` 的**汇总断言**（起服/停服/世界重置等 10 条）；`1/13` 是 t37 脚本**内部**断言（三种 key × 4 条 + 泄漏 1 条）。两个分母不同，不是矛盾。
2. **chest 的 20/20 与 30/30**：20/20 = 手工等价路径下的 `e2e_chest_store_live.mjs`（48s）；30/30 = 官方 `e2e.ps1 -Scenario chest`（含起服/停服/重置的外围断言）。两者断言集合不同，**两轮证据都在**。
3. **run2–7 的 15/20、14/20、19/20、18/20 不是精确性回归**：`断言D/D2/D3` 全部 PASS、RCON 每轮 8；红的是客户侧读数（N-9）或绝对量断言（世界未重置）。
4. **#57 的"FAIL"与"5/5 PASS"并存**：ack 形状 FAIL（N-2 主干）；四类失败帧 + `control-denied` 共 5/5 PASS（覆盖面不同）。
5. **#30 的 PASS 与"死代码"并存**：限流口径 PASS；但新加的 scrypt 并发闸在 HTTP 层永不触发（N-10，观察项）。
6. 静态线 `web/dist` 被 `npm run build` 重写，但**内容与入库产物 16/16 逐字节一致** ⇒ `git status` 无 `web/dist` 改动是**正确**的，不是"漏检"。

---

## 8. 建议下一步（按"阻塞下游"排序）

1. **验 F1 的修复**（N-1）：工作区已有修法 A 的改动，但**零证据**。复跑 panel.md §3.1（冷启动应打出「服务器已完全加载」并继续到 3/4）与 §3.2（热重跑应打「本项目服务端已在运行…跳过」），两条都过才算闭。
2. **#57 ack**（N-2）：五个 handler 补 `(…, callback)` + 统一 `{ok:false, code:'RATE_LIMITED'|'NOT_IN_GAME'|'TOO_LONG'|'NOT_RUNNING'|'ALREADY_RUNNING'}`，并把 `:2170` 的 `socket == null` 显式转 `NOT_IN_GAME`。验收口径：正常/限流/目标不在游戏三种情况**都在 1s 内**收到回执。
3. **修 t37**（N-5）再复跑 claims：这是**唯一**能证明预约/冲突逻辑真假的路（U-3）。
4. **`store` 账目改服务端真值**（N-6）：与 `fetch` 的 `takenSource:'server'` 对齐，否则上层重试会重复搬运。
5. **建 `<botsRoot>/<name>/map`**（N-7）：在 live 工具与 `e2e.ps1` 里统一建目录，把"间歇失败"变成"必过"。
6. **失败留现场**（N-8）：`e2e.ps1` 失败路径也保留运行目录，或把 `scenario-*.log` 先拷进 `evidence/` 再删。
7. **低优先**：N-9 断言改 RCON 真值、N-10 闸的注释/异步 KDF、N-11 文案统一。
8. **不可验项**（§4）按需单独派单：Docker（U-1）、第二台机器（U-2）、板库升级（U-4）、多进程并发（U-5）、memory 损坏（U-6）、计划任务（U-7）。

---

## 9. 证据索引

- `evidence/`（根 35 个文件）：`chest-live-run{1,5,6,7}.log`、`chest-live-persist.log`、`rcon-truth-probe{,-mapfix}.log`、`store-account-probe.log`、`server-boot{1,2}.log`、`e2e-ps1-jdk-fatal.log`、`e2e-ps1-jdk-fixed-chest.log`、`e2e-ps1-claims{,-keeprun}.log`、`e2e-claims-scenario.log`、`e2e-ps1-restart-keeprun.log`、`e2e-restart-stage.log`、`e2e-restart-verify.log`、`probe-board-role.log`、`smoke-8081-mindserver.log`、`smoke-probe{1,2}.json`、`serve-8081.mjs`、`probe{,2}.mjs`、`panel-start-run{1,2,3}-*.log`、`panel-stop-*.log`、`panel-hang8080-listener.log`、`panel-backup-{manifest-excerpt.json,redacted-properties.txt}`、`panel-server-done.txt`
- `evidence/static/`（8 个文件）：`vue-tsc.log`、`npm-build.log`、`manifest-unit.log`、`release-verifyonly.log`、`dist-consistency.log`、`dist_compare.py`、`static-audit.log`、`static_audit.py`
