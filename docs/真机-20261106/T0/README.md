# T0 · 环境拉起与真机基线

> 真机验收 · 团队 `真机验收-20261106` · 采集时间 **2026-11-06 19:49:56 – 19:56 (UTC+8)**
> 本目录只放启动记录/脚本/日志。**未改任何产品源码、未改 server/server.properties**。
> 服务当前**保持运行**（T1/T2/T3 共用），关服步骤见文末（仅供 Lead 收尾）。

---

## 1. 验收对照表（逐条可查）

| 验收项 | 结果 | 证据位置 |
|---|---|---|
| 25565 LISTENING 且属本进程 | ✅ `::` 25565 → **PID 29060 (java.exe)** | §3 端口表 / `check-health.ps1` 输出 |
| 8080 LISTENING 且属本进程 | ✅ `127.0.0.1:8080` → **PID 4392 (node.exe)** | 同上 |
| `run-server.log` 含 `Done (` | ✅ `[19:50:22 INFO]: Done (17.713s)! For help, type "help"` | `run-server.log` |
| `/console` 返回 200 | ✅ 带 token → **200**（398 B）；不带 token → **401**（auth gate 有意为之，见 §6） | `check-health.ps1` |
| `/list` 里能看到 bot | ✅ `There are 1 of a max of 10 players online: probe1` | RCON `list`，`env.json` |
| 基线 5 项数值落盘 | ✅ 见 §4（/list、TPS、ping、spawn 坐标、时间戳） | `env.json` |
| 服务保持运行 | ✅ 三个进程均在跑，禁关服 | §3 |

一键复核：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "…\T0\check-health.ps1"` → 末行 `RESULT: HEALTHY`。

> ⚠️ `.ps1` 必须带 `-ExecutionPolicy Bypass`：本机执行策略禁止未签名脚本；直接 `& .\check-health.ps1` 会报 UnauthorizedAccess。
> ⚠️ 脚本一律 **ASCII-only + 路径全部由 `$PSScriptRoot` 派生**：Windows PowerShell 5.1 把「无 BOM 的 UTF-8 .ps1」按 ANSI/GBK 解码，写死中文路径会变成乱码路径（实测 `E:\鎴戠殑涓栫晫ai\...` → 文件找不到）。

---

## 2. 启动步骤（可复现）

### 2.1 Paper（25565 / RCON 25575）

```powershell
# 工作目录必须是 E:\我的世界ai\server
Start-Process -FilePath 'E:\我的世界ai\.tools\jdk-21.0.12.1+1\bin\java.exe' `
  -ArgumentList '-Xms1G','-Xmx2G','-jar','paper-1.21.8-60.jar','nogui' `
  -WorkingDirectory 'E:\我的世界ai\server' `
  -RedirectStandardOutput 'E:\我的世界ai\docs\真机-20261106\T0\run-server.log' `
  -RedirectStandardError  'E:\我的世界ai\docs\真机-20261106\T0\run-server.err.log' `
  -RedirectStandardInput  'E:\我的世界ai\docs\真机-20261106\T0\.stdin-empty' `
  -WindowStyle Hidden -PassThru
```

实测：`19:49:56` 起 → `19:50:22` 输出 `Done (17.713s)`，**17.7 s**（与任务书「13–21 s」一致）。

> 踩坑记录（省下后来人的时间）：用 `cmd /c "java … > log 2>&1 < nul"` 经 `Start-Process -ArgumentList` 传参会把重定向符号/引号拆坏，进程**立刻退出且不生成日志**；改用 `Start-Process -RedirectStandard*` 直接重定向才稳。另外 `stdin` 指向一个空文件即可（`< nul` 等价），Paper/RCON 不依赖控制台 stdin。

### 2.2 mindserver 面板（8080）

```powershell
# cwd 必须是 mindcraft\（面板的 board/token 落在标准位置）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "E:\我的世界ai\docs\真机-20261106\T0\start-mindserver.ps1"
```

启动器 `start-mindserver.mjs`（T0 内）做的事等价于：

```js
const mod = await import('file:///E:/我的世界ai/mindcraft/src/mindcraft/mindserver.js');
mod.createMindServer(false, 8080);
```

**为什么不是 `node src/mindcraft/mindserver.js`（任务书原写法）：**

- 实测 `node src/mindcraft/mindserver.js` → **rc=0、零输出、8080 不监听**。原因：该文件只是**模块**，只 `export function createMindServer(...)`，没有任何自执行入口。
- 真正入口是 `mindcraft/main.js` → `Mindcraft.init(false, mindserver_port, auto_open_ui)` → `createMindServer(...)`。
- 但 `main.js` 会顺带按 `settings.profiles`（当前只有 `./profiles/my-local.json` → `https://api.llmgo.net/v1`，远端**收费**中转）拉起 agent 子进程。T0 只要面板，所以直接调 `createMindServer`。
- 副产品：面板仍会挂载 `/console`、生成握手 token、打开 `bots/_board/board.sqlite`（日志实测 `18 个技能可派单`）。

### 2.3 一个 bot 进服

```powershell
# 裸 mineflayer（见 §5 数据来源差异说明）
D:\Node\node.exe E:\我的世界ai\docs\真机-20261106\T0\join-bot.mjs probe1
```

- 复用 `mindcraft/node_modules`（`createRequire('E:/我的世界ai/mindcraft/package.json')`），mineflayer **4.39.0**，协议 1.21.8，`auth: 'offline'`。
- 首次连接被踢 → 见 §7 白名单。放行后重连成功。
- bot 进程**常驻**，每 30 s 刷新 `bot-last.json`（ping/坐标/血量/在线玩家）。

---

## 3. 进程与端口占用（此刻实测）

| 端口 | 地址 | 进程 | PID | 起始时间 | 归属 |
|---|---|---|---|---|---|
| 25565 | `::` (双栈) | `java.exe` | **29060** | 2026-11-06 19:49:56 | Paper / Minecraft 主服 |
| 25575 | `::` | `java.exe` | **29060** | 同上 | Paper RCON |
| 8080 | `127.0.0.1` | `node.exe` | **4392** | 2026-11-06 19:54:27 | mindserver 面板 |

辅助进程：

| 进程 | PID | 起始时间 | 说明 |
|---|---|---|---|
| `node.exe join-bot.mjs probe1` | **11300** | 19:52:33 | 常驻 bot（T1/T2/T3 可直接复用，也可另起） |

- 25566 **未占用**（硬约束遵守）。
- 8080 绑定在回环：`MIND_SERVER_HOST` 未设 → 按 OPS-010 的默认安全值只绑 `localhost`。
- 启动期 stderr 里有一条 `[安全][OPS-003]` 离线模式+监听全网卡的风险横幅 —— 是**预期告警**，不是故障。

---

## 4. 基线 5 项（真数字）

| # | 项 | 值 | 采集方式 |
|---|---|---|---|
| 1 | 玩家列表 | `There are 1 of a max of 10 players online: probe1` | RCON `list` |
| 2 | TPS | **20.0 / 20.0 / 20.0**（1m/5m/15m）；MSPT avg `1.3 / 1.3 / 1.4` ms（5s/10s/1m），1m max 38.5 ms（含启动期抖动的历史峰值） | RCON `tps` / `mspt` |
| 3 | bot ping | **0 ms**（`bot.player.ping`，本机回环）；旁证：TCP 握手到 25565 = `5.46 / 0.44 / 0.29 / 0.35 / 0.30` ms | mineflayer `bot-last.json` + 本机 TCP 计时 |
| 4 | spawn 坐标 | **(x=-141.5, y=63.0, z=-222.5)**，yaw `3.1416`，dimension `overworld`，gamemode `survival` | `bot-join.json` |
| 5 | 时间戳 | 服务起 `19:49:56` / `Done` `19:50:22` / bot 进服 `19:52:34.905Z`(UTC) = `19:52:34`(本地) / 快照 `19:53:04`、`19:55:04` | 日志 + `env.json` |

其它环境事实：MC 版本 1.21.8 / 服务端 brand `Paper` / health 20 / food 20 / gametime `22205927` tick、daytime `5931`。

> 注：`/spark tps` 经 RCON **无回包**（spark 输出走异步/控制台，RCON 抓不到），TPS 以 Paper 自带 `/tps`、`/mspt` 为准。
> 注：`rcon.mjs` 单次调用 ~165 ms 是 **node 冷启动开销**，不是 RCON 时延，别当成网络指标。

---

## 5. 「面板数据来源」差异（必须说清，不含糊）

任务书要求「优先用不花钱的本地模型 profile；没有就用裸 mineflayer，并写清数据来源差异」。**实测：本机没有可用的本地模型。**

- `settings.js` 的 `profiles` 只有 `./profiles/my-local.json` → `"url": "https://api.llmgo.net/v1"`、`"model": "deepseek-v4.1-flash"` —— **远端收费中转**，不是本地。
- 仓库里唯一指向本地的是 `profiles/vllm.json` → `http://127.0.0.1:8000/v1`，但**8000 无监听**；11434（Ollama）/1234/5000/8081/3000 **同样无监听**。即：没有本地推理服务可跑。

因此 bot 用**裸 mineflayer**，由此产生三处真实差异，全部按实说明：

1. **bot 不经过 mindserver**：这个 bot 不在面板的 agent/bot 列表里，面板点「停止」也不会停它（它由 `join-bot.mjs` 直接持有）。要停它：`Stop-Process -Id 11300`。
2. **面板侧数据来源 = 服务器侧**：T0 基线里所有 Minecraft 状态（`/list`、`/tps`、`/mspt`）都是**经 RCON 从服务端取的**（`rcon.mjs`，密码运行时从 `server.properties` 读、从不打印）；仅 ping/坐标/血量来自 bot 自己的 mineflayer 状态。
3. **没有模型推理链路**：本次基线与 LLM 无关；凡需要「模型真的回话/真的下令」的验收（MOD-001/006 那一类）**不能**用这个 bot 证明。

---

## 6. 面板访问（token 不入文档）

- 地址：`http://localhost:8080/console?token=<token>`
- token 值在 **`E:\我的世界ai\mindcraft\.mindserver-token`**（36 字符，每次启动重写）。
- 裸访问 `/console`、`/`、`/api/agents` 一律 **401** —— 这是 auth gate 的设计（`auth_gate.js`），**不是面板没起来**。
- 面板日志只打印 token 指纹（`4031…ccb(len=36)`），完整值不落日志（`MINDSERVER_PRINT_TOKEN=1` 在 stdout 被重定向时会被忽略，这也是产品行为）。
- 本 T0 的所有记录、日志中**均未出现** rcon.password / token 明文。

---

## 7. 白名单闸门（本次唯一的真实阻断，已处置）

**现象**（`run-server.log` 原文）：

```
[19:52:10 INFO]: Disconnecting probe1 (/127.0.0.1:57293): You are not whitelisted on this server!
[19:52:10 INFO]: probe1 (/127.0.0.1:57293) lost connection: You are not whitelisted on this server!
```

**根因**：`server/server.properties` 里 `white-list=true` + `enforce-whitelist=true`，而 `server/whitelist.json` **不存在**（等价空名单）→ 任何名字都被踢。

**处置（最小、可逆、未碰配置）**：

```
RCON: whitelist add probe1        → Added probe1 to the whitelist
```
- 只写 `server/whitelist.json`（现在只有 probe1 一条）。
- **`server.properties` 未改动**（复核：`white-list=true`、`enforce-whitelist=true` 原样）。
- 还原：`RCON: whitelist remove probe1`。
- 未采用 `whitelist off`：那会回写 `server.properties`，属于改配置，超出约束。

> **对 T1/T2/T3 的直接影响**：换任何新 bot 名（`probe2`、`smelt1`…）前必须先
> `node rcon.mjs "whitelist add <name>"`，否则 1 s 内被踢。
> 如果确实需要「随便起名就能进」，需要 Lead 拍板走 `whitelist off`（会改 server.properties）——我不擅自做。

---

## 8. 本目录文件清单

| 文件 | 作用 |
|---|---|
| `README.md` | 本报告：启动记录、基线、差异说明、关服步骤 |
| `env.json` | 机器可读快照（PID/端口/基线/运行时变更），供 T1/T2/T3 对照 |
| `run-server.log` / `run-server.err.log` | Paper stdout / stderr（stderr 只有 126 B 的「构建已过期」提示，非错误） |
| `run-mindserver.log` / `run-mindserver.err.log` | 面板 stdout / stderr（stderr 是 OPS-003 离线模式风险横幅，中文在 GBK 控制台里显示为乱码属正常） |
| `join-bot.log` / `join-bot.err.log` | bot 进服与 30 s 快照流 |
| `bot-join.json` / `bot-last.json` | bot 进服快照 / 最近一次心跳 |
| `bot-kicked.json` | 首次被白名单踢的原始证据（历史留证，非当前状态） |
| `start-mindserver.ps1` | 面板启动脚本（ASCII-only，路径派生自 `$PSScriptRoot`） |
| `start-mindserver.mjs` | 面板真正入口包装（`createMindServer(false, 8080)`） |
| `join-bot.mjs` | 裸 mineflayer 进服 + 心跳快照 |
| `rcon.mjs` | 极简 RCON 客户端（密码运行时读取，绝不打印） |
| `check-health.ps1` | 一键体检：端口/PID/Done/panel 200+401/`list`/`tps`/`mspt`/bot 心跳 |
| `.stdin-empty` | 给三个后台进程当空 stdin（等价 `< nul`） |

---

## 9. 优雅关服（**仅供 Lead 收尾，现在不要执行**）

按依赖倒序关，避免留孤儿：**bot →（可选）面板 → Paper**。

```powershell
# 0) 先停 bot（直接持有连接，面板停不掉它）
Stop-Process -Id 11300 -ErrorAction SilentlyContinue

# 1) 正常关面板：走产品的唯一关停入口（会等 agent 子进程退出，超时才强杀）
Stop-Process -Id 4392            # SIGTERM 等价；日志会出现 "[mindserver] 开始关停"

# 2) 正常关服：优先用 RCON 的 stop（等同控制台 stop，世界会被正常保存）
D:\Node\node.exe "E:\我的世界ai\docs\真机-20261106\T0\rcon.mjs" stop

# 3) 等 java 退出（以 25565 消失为准），确认没有残留
Get-NetTCPConnection -State Listen -LocalPort 25565,8080 -ErrorAction SilentlyContinue
Get-Process java,node -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime
```

- **不要**用 `Stop-Process -Force` 关 Paper：跳过世界保存，可能留下损坏的 region。
- 若 RCON 不可用（端口没起来），进程内 stdin 已被 `< nul` 关掉，此时只能：
  `Stop-Process -Id 29060`（等于 SIGTERM，Paper 仍会走正常关停钩子并保存世界），**别加 `-Force`**。
- 关服后如需复原白名单：`whitelist remove probe1` 必须在关服前执行；关服后直接删 `server/whitelist.json` 里的 probe1 条目即可。

---

## 10. 已知偏差与风险（诚实清单）

1. **面板 bot 列表为空是预期**：bot 走裸 mineflayer，不经 mindserver（§5）。判「bot 在不在」请用 RCON `/list`，不要看面板 agent 列表。
2. **`mindserver/.mindserver-token` 被本次启动重写**：产品每次启动都重写，属正常；但如果有人记着旧 token，会 401。
3. **面板跑的是 `createMindServer` 而非 `main.js`**：因此没有「agent 自动进服/自动执行任务」那条链路，也没有会自动调模型的进程（这正是 T0 想要的零费用状态）。
4. **`bot.player.ping` 恒为 0**：回环下服务端上报延迟就是 0；它不是坏值，但**不能**用来验证「网络抖动处理」类缺陷。
5. **启动期 MSPT max 38.5 ms / 首次 TCP 握手 5.46 ms**：冷启动抖动，稳态 avg 1.3 ms、TPS 满 20，判性能请用稳态值。
6. **白名单仍是开着的**：T1/T2/T3 每用新 bot 名都要先 `whitelist add`（§7）。
7. **本机无本地模型**：任何「模型真的调用」类验收都不能用 T0 的 bot 顶替（§5.3）。
8. **`server/server.properties` 的 mtime 变了（19:50:12）但内容没变**：这是 Paper 启动自写文件头的正常行为。与启动前备份 `server.properties.bak-20261106-115645` 逐行比对，差异只有 `#Fri Nov 06 19:50:12 CST 2026` 这行文件头注释（`rcon.password` 的差异在我开工**之前**就存在，非本次造成）。`white-list`、`enforce-whitelist`、`server-port`、`online-mode`、`enable-rcon`、`rcon.port` 全部原样 —— 我没有任何写配置的动作。
9. **`server/whitelist.json` 是本次唯一新增的 server/ 侧状态**（一条 probe1，由 RCON `whitelist add` 生成）。它不在 git 跟踪范围（`server/` 只跟踪 11 个文件），因此 `git status` 看不到它 —— 别被"clean"误导。产品代码零改动：`git status` 只有 `docs/真机-20261106/` 一条未跟踪目录。
