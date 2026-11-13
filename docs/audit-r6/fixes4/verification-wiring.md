# 全量验证与真机复核（t5）：生产接线批次

> R6 / fixes4 · 2026-11-13 · 任务 **t5**（成员 `gate-runner`）· 只读验证，除"改坏再复原"的变异外未改产品代码
> 依赖：t1（mindserver 联邦/身份/CP/isVisitor）、t2 + t8（board 队伍·库存事件）、t3（面板四视图）、t4（flow_store 预占）、t7（events:since/stats）
> 基线：`docs/audit-r6/fixes4/verification.md`（上一批 t9，154 脚本 / 3232 用例 / E2E 53-53）

---

## 0. 结论

**门禁、前端、发布校验、父仓回归、真机 E2E、真 socket、六组反向验证全部通过。**
但有 **3 处必须知情的发现**，其中 1 处直接关系到本批的母题：

| # | 发现 | 级别 | 一句话 |
|---|---|---|---|
| F1 | **`opts.shared=true` 在生产里没有任何调用方** | **高（待裁决）** | 预占路径只有测试能到达 ⇒ 「先预占再取用」**仍未接进运行路径**，只接到一个接缝 |
| F2 | 生产 `server/world/world-id.json` 存在（14:27，非 E2E 所写） | 中 | 某次"真进程"测试没设 `MC_WORLD_DIR`，把 sidecar 写进了**生产存档目录** |
| F3 | 生产 `bots/_global/mind.sqlite` 多出 **523 条测试事件**（w1 / w_inv / w_demo） | 中 | 某次真机探针没设 `MC_BOTS_ROOT`，测试账写进了**生产记忆库**（面板事件视图会看到） |

另有两处低级别：一个来源不明的 `node server.js` 残留进程、两处队友文档的用例计数与实跑不符（§6）。

**一句话判断**：本批把"已实现但不可达"的**入口**都接上了（socket 层、事件写、只读视图），
但 ④「先预占再取用」只接到了**调用方接缝**，生产调用方（`!do fetch` / `!take`）依旧走老路 ——
这与批次母题是同一类问题，**建议 captain 明确裁决**（§6 F1 给了两个选项）。

---

## 1. 环境与仓库布局（复核前必读）

- Windows / Node **v24.16.0** / npm 11.13.0 / **只有 PowerShell 5.1（无 pwsh 7）**
  ⇒ 所有 `.ps1` 用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File` 调用；`pwsh: command not found` 是本机常态。
- 仓库是**两个 git 仓库**：`E:\我的世界ai`（父仓：`docs/`、`scripts/`、`web/`）+ `mindcraft/`（独立仓库，父仓 `.gitignore` 排除了它）。
  父仓 `git status` 干净 **≠** 代码干净。
- 本轮验证期间**队友又落了两个提交**（我 16:47 开工时 `mindcraft` 只有 861b82b、父仓有未提交的 web 改动）：
  - `mindcraft` `af0b6a5 feat(panel): 面板只读四视图 + expired 字段口径消歧`（含我 16:53 重建的 `web-dist` 产物）
  - 父仓 `79a0f8b feat(panel): 只读四视图（队伍/库存/事件/联邦）+ 接线文档`
  ⇒ 我在**提交后**又把 `release.ps1 -VerifyOnly` 重跑了一次（8/8），确认"产物与当前 `web/src` 仍一致"，不是只在提交前绿过。
- 验证窗口：2026-11-13 16:47 → 18:25（Asia/Shanghai）。

---

## 2. 门禁逐项结果

| # | 项目 | 结果 | 关键证据 |
|---|---|---|---|
| 1 | `cd mindcraft && npm test` | 🟢 exit 0 | preflight **131/131** 模块导入；unit_all **158/158 脚本 + 5 跳过**，用例合计 **3392** |
| 2 | `npm run gate` | 🟢 exit 0 | 补丁 5 个内容/版本/6 哨兵全过；lint:hard `no-undef=0`、`no-floating-promise=0`（187 文件）；API 扫描 0 命中；前缀 import 416 条 0 违规 |
| 3 | `node tools/preflight.mjs` | 🟢 exit 0 | 7 段全过（含"[6/6] 依赖注入审计 A 档 0 处"） |
| 4 | `node tools/deps_injection_audit.mjs` | 🟢 exit 0 | **A 档 0 处**；C 档 16 处为信息档（历史既有，非本批新增） |
| 5 | `cd web && npx vue-tsc --noEmit` | 🟢 exit 0 | 无输出 |
| 6 | 父仓 `release.ps1 -SkipDocker` | 🟢 PASS | 步骤 2 构建 + 步骤 3 同步（17 文件）+ 步骤 4 清单：**6 passed / 0 failed**、**8 passed / 0 failed** |
| 7 | 父仓 `release.ps1 -VerifyOnly` | 🟢 **8/8**（跑了两次） | 提交前 16:53 与提交后 18:12 各一次：源码指纹 `sha256:0f8e40d6…`、产物 `sha256:c2a9e894…`、入口引用一致 |
| 8 | 父仓 `node scripts/tests/ops-regression.mjs` | 🟢 **87 passed / 0 failed** | 含 R6#50 四条"能红"夹具（源码漂移/产物被改 ⇒ verify 红） |
| 9 | 全部 `.ps1` Parser | 🟢 **26 文件 / ERRORS=0** | BOM：22 有 / **4 无**，4 个全在历史文档目录（`docs/audit/night/parse-ps1.ps1`、`docs/真机-20261106/T0|T2/*.ps1`）＝上批记录的同一批例外 |
| 10 | **真机 E2E `scripts/e2e.ps1 -Scenario all`** | 🟢 **53/53** exit 0 | 见 §2.2 |
| 11 | **真 socket 验证** | 🟢 **24/24** | 见 §3 |
| 12 | **反向验证六组** | 🟢 **6/6 组** + 2 组变异能红 | 见 §4 |

### 2.1 新测试报数（本批新增 4 个测试脚本，全部已提交）

| 测试 | 用例 | 归属 |
|---|---|---|
| `wiring_federation_unit` | **57** | t1 |
| `wiring_board_events_unit` | **45** | t2 + t8 |
| `wiring_events_read_unit` | **44** | t7 |
| `wiring_flow_reserve_unit` | **11** | t4 |
| 合计 | **157** | 全仓用例 3232 → **3392**（+160） |

⚠ **一处文档计数与实跑不符**（不影响结论，但引用时别抄错）：`wiring-control.md:5` 与 t1 的交付说明写 **53 例**，实跑 **57**。
（t4 的交付说明写"9 条"，但 `wiring-flow.md:8` 正文写的是 **11 条**、与实跑一致 ⇒ 只有交付说明那一处笔误。）见 §6 F5。

### 2.2 真机 E2E（`-Scenario all`，53/53）

- JDK：`.tools/jdk-21.0.12.1+1`（脚本自选 ≥21 的最佳版本）；`server/server.jar` 在；25566/25576 起服前无占用。
- 三个场景全过：`claims`（多 bot 抢单争用）、`restart`（箱子/熔炉/bot 记忆跨重启）、`chest`（主动存取守恒 + 三条反证）。
- 每组跑完都断言 **"重置后世界 = 模板世界（逐文件 sha256 比对）"**；运行目录 `tmp/e2e/` 收尾已删空。
- ⚠ **本批动了 `attachBoardServer` 注入 / `flow_store` 取用 / 新事件写入** —— E2E 是新接线的第一个真实用户，
  它绿说明"非共享取用 + 板/事件注入"在真服上没被带坏（但 E2E **没有**覆盖 `opts.shared=true`，见 §7）。
- 上批修的 `MC_WORLD_DIR` 隔离**复查通过**：跑前跑后生产 `server/world/world-id.json` 的 sha256
  `9797c140…` 与 mtime `11-13 14:27` **一字未变**（E2E 的世界都在 `tmp/e2e/<scenario>/` 里）。
  ⇒ 但该文件**本来就存在**（14:27，早于我全部操作），见 §6 F2。

---

## 3. 真 socket 验证（本批重点，24/24 PASS）

**为什么必须单独做**：t1/t7 的单测都是"直调函数"，`normalizeEmitArgs` 的 K1 分支（`emit(ev, cb)` 时 payload 其实是函数）
只有在**真 socket.io 传输**下才能证明"库真的这样传参"。

探针：`mindcraft/tmp/verify/socket_mindserver.mjs`（gitignored，非产品代码）
= **真 `createMindServer`（临时 `MC_BOTS_ROOT`/`MC_WORLD_DIR`/cwd，端口 0）+ 真 `socket.io-client`**。

| # | 断言 | 实测 |
|---|---|---|
| 1 | 凭据分离：面板 token ≠ agent token | ✅ 两个 36 位随机值不同 |
| 2 | **K1**：`emit('federation-status', cb)` 单参 | ✅ `{ok:true, grants:[], knownPeers:[], allowedPeers:[], visitorWired:false}` |
| 3 | `visitorWired === false` 如实暴露"访客判定未接线" | ✅ |
| 4 | grants 行不含 `token`/`token_sha256` | ✅ |
| 5 | **K2**：`emit('federation-status', {}, cb)` 双参 | ✅ `ok:true` |
| 6 | `emit('events:since', {limit:5}, cb)` | ✅ `{ok:true, events:[…], count:1, limit:5}` |
| 7 | 事件行**只有 6 个字段**（`id,worldId,avatarId,kind,payload,at`，不外发 `sourceIp/payloadOk`） | ✅ |
| 8 | 面板刚签发的 `identity.invite` 真落库并读回 | ✅ `avatarId=alpha` |
| 9 | `limit` 超上限夹到 **500**（回执带回生效值） | ✅ |
| 10 | 非法游标 ⇒ `{ok:false, reason:'since-invalid'}`（**不抛**） | ✅ |
| 11 | `events:stats` ⇒ `kinds:[{kind,count,firstAt,lastAt}]` | ✅ `identity.invite:1` |
| 12 | **反向①**：签发回执里有 token 明文（阳性对照，43 字符） | ✅ |
| 13 | **反向①**：stdout+stderr **7251 字节全文搜不到 token** | ✅ 用 `grep -F` 独立扫（不是自己判自己） |
| 14 | 日志里有 `grantId`（可追踪，不是"什么都不打"） | ✅ |
| 15 | 签发 token **也没落进任何文件**（run 目录整棵 grep） | ✅ 空 |
| 16 | **反向②**：events 库不可写（`_global` 被占成普通文件）⇒ `identity-issue-code` 仍 `ok:true` | ✅ |
| 17 | 同上，日志留 `身份事件未落库 kind=identity.invite reason=write-failed` | ✅ |
| 18 | **反向②b**：**只读库**（0 字节 + `chmod 444` 的 `mind.sqlite`）⇒ 仍 `ok:true` | ✅ |
| 19 | 同上，只读库下也留 warn | ✅ |
| 20 | **非面板凭据**（agent token，`auth.token`）调 `federation:grant-issue` ⇒ 拒 | ✅ `{ok:false, reason:'panel_only', role:'agent'}` |
| 21 | 非面板调 `events:since` 同样拒 | ✅ `panel_only` |

> 附注：该探针启动时会读**生产** `server/plugins/CoreProtect/database.db`（CP 体检只读），
> 打印"已安装：表 co_block，106120 行" —— 这是 t1 体检的**真实分支**。只读的证据：该库 mtime 仍是
> `11-12 00:44`（我全部操作之后复查），未被这个探针写过。

---

## 4. 反向验证六组（要求项，全部有实测）

探针：`mindcraft/tmp/verify/board_reverse.mjs`（**真 socket.io 服务端 + 真 `attachBoardServer` + 真 `BoardClient`**，
不是直调 handler）；变异一律"改坏 → 跑 → 按 sha256 复原 → 再跑"。

| 组 | 要求 | 做法 | 实测 |
|---|---|---|---|
| ① | 签发日志搜不到 token 明文 | 真 socket 签发一次，抓 stdout/stderr | ✅ §3 #12–15（7251 字节无 token；文件树也无） |
| ② | 身份事件写失败（只读库）⇒ 主流程仍成功 | 两种失败形态：目录被占成文件 / 0 字节只读库 | ✅ 都 `ok:true` + 留 warn（§3 #16–19） |
| ③ | 队伍事件 `worldIdOf` 不可用 ⇒ 不写事件、不报错 | `worldIdOf: () => null` | ✅ `ack={ok:false, code:'NO_BOARD'}`（**没抛**）；events `0→0`；服务端仍活（下一条仍有结构化 ack） |
| ④ | 访客注入 true ⇒ reservation/ledger 零行、audit 有行 | `isVisitor: async () => true` | ✅ reservation **0**、ledger **0**、`inventory_audit=2`、events `0→0`（reserve/settle 都不写） |
| ⑤ | 共享取用：预占失败 ⇒ **真的没取** | 箱里放 8 个、缓存已知 2 个、请求 5 | ✅ `NO_ITEM/INSUFFICIENT_STOCK`（已知2/已占0/可用2/需要5）、`took=0`、**箱子 8→8、背包 0**、零券零账零事件 |
| ⑥ | 非共享取用：行为与接线前一致 | 不传 `shared` | ✅ 照常搬 8→5 / 背包 0→3；reserve/settle/release/store **一次都没调**（`inventory:cache-refresh` 1 次，是接线前既有行为）；零券零账零事件 |

### 4.1 两组变异（证明探针不是"永远绿"）

| 变异 | 期望 | 实测 | 复原 |
|---|---|---|---|
| M1：`flow_store.fetchShared` 去掉"预占失败就返回"（改成预占失败也继续取） | ⑤ 的物理守恒断言红 | **红**：`E` 变成 `ok:true/taken:5`、`E1` 箱子 8→3、背包 0→5（12 PASS/2 FAIL） | `git checkout` 后 sha256 `fcb551e4…` **RESTORE_OK=YES** |
| M2：`board_server` 的 `if (r.visitor !== true)` 改成 `if (true)`（访客也写事件） | ④ 的事件断言红 | **红**：`D3` events `0→1`、`reserve:1`（13 PASS/1 FAIL） | sha256 `d0d26881…` **RESTORE_OK=YES** |

复原后复查：`mindcraft` 工作树 `git status` **干净**（只有本批提交，不含我的变异）。

### 4.2 ⑥"零变化"的更强证据（逐字 diff，不只是跑测试）

把 `git show f6c5ad9:src/agent/library/flow_store.js` 里的原 `fetch()` 函数体，与当前 `fetchLocal()` 函数体逐字节比对：
**唯一差异就是函数名那一行**（`async function fetch(` → `async function fetchLocal(`，长度 +5 = 5337→5342），
`diff -u` 除首行外**空**。⇒ "非共享路径一字未改"是**逐字**成立的，不是靠用例推断。

---

## 5. 生产数据 / 工作区残留（如实清点）

| 项 | 状态 | 说明 |
|---|---|---|
| 生产 `server/world/world-id.json` | ⚠ **存在**（`w-20261113-96c12b98`，createdAt `2026-11-13T06:27:33Z`，sha256 `9797c140…`，92 字节） | **不是我写的**：我全部操作前（16:47）就已存在；E2E 跑前跑后 sha/mtime 未变。见 §6 F2 |
| 生产 `bots/_global/mind.sqlite` | ⚠ **523 条测试事件**（`w1=452 / w_inv=57 / w_demo=14`，avatar `alpha`/`beta`，`2026-11-13T06:39Z→08:59Z`） | 某真机探针没设 `MC_BOTS_ROOT`。我的全部探针/单测都走临时根（跑前后计数仍 523）见 §6 F3 |
| 生产 `bots/_global` 的 `visit_grants` | ✅ 0 行 | 我的签发探针写在临时根 |
| CP 库 `server/plugins/CoreProtect/database.db` | ✅ 只读访问 | 体检分支读取，无写入 |
| `tmp/e2e/` | ✅ 已清空 | e2e.ps1 收尾删除 |
| 监听端口 25565/25566/25576/8080/18090/7151 | ✅ 无占用 | 我的探针用端口 0 / 7151 且已 close |
| 进程 | ⚠ 1 个 `node server.js`（PID 35456，13:41:08 起，父进程 `cmd.exe /c "node server.js"`，**未监听任何端口**） | 来源不明：仓库内（排除 node_modules）**没有 `server.js`**，非我启动。见 §6 F4 |
| 我的探针产物 | `mindcraft/tmp/verify/{socket_mindserver.mjs, board_reverse.mjs, out-socket.log}`（gitignored） | 含 token 的 `out/` 与 `out-board/` 已删（签发 token 未留盘） |

---

## 6. 发现与判断（请 captain 裁决 F1）

### F1（高，待裁决）`opts.shared=true` 在生产里**没有调用方** ⇒ ④仍未真正"接进运行路径"

- 事实（grep 全 `src/`）：`flow_store.store/fetch` 的生产调用方只有两处，**都不传 `shared`**：
  - `src/agent/commands/actions.js:408/420`：`storeFlow(agent.bot, item, num)` / `fetchFlow(agent.bot, item, num)`（`!store` / `!take`）
  - `src/agent/library/composite_registry.js:125/129`：`runStore(bot, args.item, args.count, { ctx })` / `runFetch(bot, args.item, args.count, { ctx })`（`!do store/fetch`）
  - `isShared = (opts) => opts?.shared === true` ⇒ **`ctx` 里带什么都没用**。
- 含义：预占/结算/还券这条链路，**目前只有测试与工具能到达**；生产 bot 跑 `!do fetch` 依旧是"开箱强刷 + 失败标脏"的老路。
  这与本批母题（"把已实现但不可达的能力接进运行路径"）是同一类问题，只是把不可达从"函数没有调用方"降级成了"调用方没有传开关"。
- `wiring-flow.md` §1 解释了"为什么必须 opt-in"（合理：单人存档不该凭空要券），但**没有写明"现在没有任何调用方传它"** —— 建议补一句。
- 两个可裁决的收口方式（都不需要改这条链路本身）：
  1. **接到调用方**：`!do fetch` 在"箱子是共享仓"时传 `shared: true`（判据用 `team_chest`/`board.sharedList`，服务端已有依据）；
  2. **明确记为下一批**：在 `wiring-flow.md` §6 写"shared 路径当前无生产调用方，只有测试/工具可达"，并把本行当验收缺口跟踪。
  > 我**没有**替任何一方改代码：t5 的授权是"只读验证 + 门禁脚本"。

### F2（中）生产 `server/world/world-id.json` 被"真进程测试"写出来

- 证据：`createdAt=2026-11-13T06:27:33Z`（本地 14:27），`id=w-20261113-96c12b98`；`world_store.currentWorldId()` 的规则是
  `MC_WORLD_DIR` 优先、否则 `<repo>/server/world`（`world_store.js:145-149`）⇒ 任何**没设 `MC_WORLD_DIR` 的真 mindserver 启动**
  都会在生产存档目录落下这个 sidecar（我的探针设了临时目录，落点在临时 world 里，可复现该写入路径）。
- 影响：目前**无事件**引用这个 id（events 里只有 w1/w_inv/w_demo），所以它只是"把生产世界钉成了这个 id"。
  一旦生产真跑起来，这个 id 就是生产世界的 id（幂等、不会再变）——**不删也不会有错**；删掉则由下一次真实启动重建一个新 id。
- 建议：**保留**，并在本批记录里写明"这行是测试写出来的、但语义上是生产世界 id"；若 captain 要"生产目录零测试痕迹"，
  删掉即可（当前无引用者）。这条正是上批 `MC_WORLD_DIR` 隔离的**同类风险**：修的是 E2E，没覆盖"手工真进程测试"。

### F3（中）生产 `bots/_global/mind.sqlite` 被写入 523 条测试事件

- 证据：§5 表；时间窗 14:39–16:59，world id `w1/w_inv/w_demo`，avatar `alpha/beta`，kind 覆盖
  `inventory.reserve/settle/rollback/reconcile/store` + `team.create`。
- 影响：**面板的「事件」视图（t3 新做的）打开就会看到这批测试行**（`events:since` 不带 worldId 时返回全库），
  `events:stats` 的 kind 计数也把它们算进去。
- 清理**不能**直接 `DELETE`：`global_store` 装了 `events_no_delete` / `events_no_update` 触发器（append-only，这是设计）。
  真要清，只能"停机 → 显式 drop 触发器 → 删 → 重建触发器"这种维护动作（有风险，不建议在验证轮做）。
  ⇒ 建议：**先记录**，由 captain 决定是否值得为它做一次维护；同时给探针/工具补一条"必须设 `MC_BOTS_ROOT`"的硬约束
  （例如启动时若 `bots/_global/mind.sqlite` 里出现 `world_id` 不在 `_worlds/*` 名单内就 warn）。

### F4（低）遗留 `node server.js` 进程

PID 35456，13:41:08 起，父进程 `cmd.exe /c "node server.js"`，未监听任何端口；仓库（排除 node_modules）内没有 `server.js`。
不是我的探针（我的都用 `node tmp/verify/*.mjs` 且已退出）。**未擅自 kill**（可能是别人在跑的东西）。

### F5（低）队友文档用例计数漂移

- `wiring-control.md:5`（及 t1 的交付说明）写"**53 例**"，实跑 **wiring_federation_unit 57 例** —— 文档落后于代码（可能是加用例后没回填）。
- t4 的**交付说明**写"9 条"，实跑 **11**；但 `wiring-flow.md:8` 正文写的是"11 条"、与实跑一致 ⇒ 只有那一处转述笔误。
不影响门禁，但"新测试要报数"这件事上，文档与实跑应一致（否则下一个人引用会抄错）。

### F6（信息）`.ps1` BOM：22 有 / 4 无

4 个无 BOM 的全在历史文档目录（`docs/audit/night/`、`docs/真机-20261106/`），与上批记录同一批例外；
`scripts/**` 全部带 BOM（PS 5.1 解析中文必需），Parser **ERRORS=0**。

---

## 7. 只到单测/离线、**没有**真机覆盖的部分（诚实边界）

| 能力 | 覆盖到哪 | 未覆盖 |
|---|---|---|
| ④ 预占→取用→结算（`opts.shared`） | 单元（真 sqlite + 真 board_server）+ 我这次真 socket + 假窗口 bot | **没有**在真 Minecraft 服上跑过（E2E 的 chest 场景走的是非共享路径） |
| ③⑤ 事件写入（team.\*/inventory.\*） | 单测 + 我这次真 socket（临时根）+ 真机 E2E 的间接路径 | 生产库里"真实世界 id"下的事件落库（需要真 bot 真存档） |
| ① 联邦 `federation:*` | 单测 + 我这次**真 socket**（含 K1/K2、拒面板外、token 不进日志） | 真跨机交换（TLS/NAT/时钟偏差）一行没验 —— t1 文档已如实声明 |
| ① 身份事件旁路 | 单测 + 真 socket（正常/库不可写/只读库三种） | `identity.claim`（游戏内 `!claim` 核销）**未接**，t1 已登记为缺口，接线点在 `src/agent/commands/identity.js` |
| ① 访客判定 `isVisitor` | 单测 + 我这次注入 `true` 的全链路（零券零账、audit 有行） | **生产恒 false**（`VISITOR_JUDGEMENT_WIRED=false`）⇒ 真机上没有任何连接会被判访客 |
| ① CP 体检 | t1 真进程两分支 + 我这次启动实测"已安装"分支（106120 行） | "未安装"分支我只在 t1 记录里见到，本轮未复跑 |
| ② 面板四视图 | t3 的真探针 58/58 + 我这次 `events:since/stats` 真 socket | 浏览器里的真渲染未做（属 UI，未在本轮要求内） |

---

## 8. 复现命令（照抄可跑）

```powershell
# 门禁（父仓 shell 用 bash，PowerShell 用 powershell.exe）
cd mindcraft; npm test; npm run gate; node tools/preflight.mjs; node tools/deps_injection_audit.mjs
cd ..\web; npx vue-tsc --noEmit
cd ..; powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -SkipDocker
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -VerifyOnly
node scripts/tests/ops-regression.mjs
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/e2e.ps1 -Scenario all     # 53/53，约 10 分钟

# 真 socket（临时根，不碰生产）
cd mindcraft; node tmp/verify/socket_mindserver.mjs      # 24 PASS
node tmp/verify/board_reverse.mjs                        # 14 PASS
```

---

## 9. 验收对照（任务书 1–7）

| 任务书要求 | 结果 |
|---|---|
| 1) `npm test`（基线 154/154+5跳，新测试报数）、`gate`、`preflight`、`deps_injection_audit` | ✅ 158/158+5跳（用例 3392）、gate 0、preflight 0、deps A 档 0（新测试 57/45/44/11） |
| 2) `vue-tsc`=0、`build`→`release -SkipDocker`→`-VerifyOnly 8/8` | ✅ 0 / 6+8 全过 / 8/8（提交前后各一次） |
| 3) `ops-regression` 87/87、`.ps1` Parser 0 + BOM | ✅ 87/0；26 文件 ERRORS=0；BOM 22/4（4 个历史例外） |
| 4) `e2e.ps1 -Scenario all` 53/53；确认生产 `server/world` 无 `world-id.json` | ✅ 53/53；⚠ **文件存在但不是 E2E 写的**（跑前跑后 sha/mtime 未变）→ F2 |
| 5) 真 socket：K1/K2、`events:since`、非面板拒绝 | ✅ 24/24（含单参/双参、limit 夹取、since-invalid、panel_only） |
| 6) 六组反向验证（改完按 sha256 复原） | ✅ 6/6 组 + M1/M2 两组变异能红且 RESTORE_OK |
| 7) 输出：绿/红、原因、只到单测的清单、工作区残留 | ✅ §2/§3/§4 + §5 + §7 |
