# 生产接线 ①：mindserver 接 `federation:*` + 身份事件 + CoreProtect 体检 + `isVisitor`

> R6 / fixes4 · 2026-11-13 · 任务 **t1**（成员 `wire-control`）
> 改动文件：`mindcraft/src/mindcraft/mindserver.js`（**本批只有这一处改了产品代码**）
> 新增单测：`mindcraft/tools/wiring_federation_unit.mjs`（53 例）
> 上游清单：`federation.md` §8、`events.md` §11；关联：`identity.md`（人/钥匙）、`world.md`（存档维度）

---

## 0. 一句话 + 一条必须先看的话

一句话：把**已经写好但没人调用**的 `federation.js` 接进 mindserver 的 socket 层，
并把「身份变更写 events」「启动 CoreProtect 体检」「`isVisitor` 注入」三处收口补齐。

⚠ **必须先看**：本次接通的是**同一台机器上的控制面入口**。真跨机交换（网络层/TLS/时钟偏差/NAT）
**一行都没验**（`federation.md` §7 的未验证清单原样有效）。另外 `identity.claim` **本批没有接**
（原因与下一步见 §9），这一点请勿读成"已实现"。

---

## 1. 改动前的现状（captain 已实测，这里是复核）

| 症状 | 证据 |
|---|---|
| `federation.js` 在 `src` 里**只有它自己**（除 `board_*` 外零引用） ⇒ 生产不可达 | 全仓 grep `federation` 只命中自身与文档 |
| `attachBoardServer(...)` 有 `worldIdOf`，**没传 `isVisitor`** | `mindserver.js` 的 attachBoardServer 调用里无 `isVisitor` 字段 |
| 身份变更（claim/invite/revoke/recover/relink）**一条 events 都没写** | `src` 内 `recordEvent(` 只在 `federation.js`/`global_store.js` 出现 |
| CoreProtect 装没装**看日志看不出来** | 启动诊断段只覆盖 OPS-003 / 身份绑定 / 离线模式三块 |

这三件事的共同病根就是本仓的母题：**"实现了"和"可达"是两件事**。
代码写对了、单测全绿，但没有任何生产路径调用它 —— 报告里看起来是"已完成"。

---

## 2. 接线清单（`mindserver.js` 里新增/改动的 6 处）

| # | 位置 | 改了什么 |
|---|---|---|
| 1 | 文件头 import | 新增 `federation.js`（8 个函数 + `coreProtectStatus`）与 `global_store.js` 的 `recordEvent` |
| 2 | `attachBoardServer({...})` | 新增 `isVisitor: visitorOf`（**t4 只留了接缝，这里才是注入点**） |
| 3 | 模块级新增一段 | `sourceIpOf` / `requirePanelRole` / `visitorOf` / `VISITOR_JUDGEMENT_WIRED` / `recordIdentityEvent` / `sanitizeGrantRow` / `safeFederationCall` / `normalizeEmitArgs` / 8 个联邦处理函数 |
| 4 | `io.on('connection')` 内 `requirePanel` | 内联体抽成对 `requirePanelRole(socket, event, ack)` 的一次调用，**行为与回执一字不差**（抽出来是为了能离线单测） |
| 5 | `io.on('connection')` 内新增 `fedOn(...)` × 8 | 8 个联邦 socket 事件（见 §3） |
| 6 | 启动诊断段末尾 | `coreProtectStatus()` 体检，**装/未装都打一行** |

**没有动的**：`board_*`、`web/**`、`flow_store.js`、`federation.js`、`global_store.js`（表结构与语义一个字节没改，只调用）。

---

## 3. `federation:*` socket 事件（全部 `requirePanel`，各自限流桶）

统一经 `fedOn(event, capacity, run)` 注册，四处**同时**成立：

1. `requirePanel(event, cb)` —— 不是 `role==='panel'` 的连接一律拒（回 `{ok:false, reason:'panel_only', role}` + `control-denied`）；
2. `takeToken(socket, event, capacity, 60000)` —— **label 就是事件名**，每个事件一条独立桶；
3. `safeFederationCall(event, …)` —— 实现抛错翻成 `{ok:false, reason:'internal'}`，**绝不把异常抛进 socket.io 回调**；
4. `normalizeEmitArgs(payload, callback)` —— `emit(ev, cb)` 时 payload 其实是那个函数，先归一再判。

> **为什么用一个包装而不是 8 个 handler 各写一遍**：漏掉某一条 `requirePanel` 的失败形态是**静默的**
> —— 那个事件就变成"谁都能调的匿名写通道"，而日志、回执、单测都不会自己叫。
> 收进 `fedOn` 之后，闸门/限流桶/异常兜底/arg 归一都是**结构保证**：
> 新增事件只要走 `fedOn`，就不可能漏；单测 G2/G3 再钉一次"包装体内确实有这两条"（防有人把包装写空）。

| socket 事件 | 底层调用 | 桶（次/60s） | 备注 |
|---|---|---|---|
| `federation:grant-issue` | `issueVisitGrant` | 5 | **token 只在回执里出现一次**；日志里不打 |
| `federation:grant-revoke` | `revokeVisitGrant` | 10 | 幂等：第二次 `alreadyRevoked:true` |
| `federation:grant-list` | `previewVisitGrants` → 白名单拷贝 | 20 | 不含 token / hash |
| `federation:card-accept` | `acceptPeerCard` | 10 | 拒绝**必须**回原因（§4） |
| `federation:card-list` | `listKnownPeers` → 脱敏 | 20 | 不含公钥 |
| `federation:relations-since` | `exportRelationDelta` | 30 | 宁重不漏 |
| `federation:relations-push` | `pushRelationDelta` | 20 | 空批次 ⇒ `no-rows`（不报假成功） |
| `federation-status` | 三个只读视图（§8） | 30 | 面板只读 |

### 3.1 `federation:grant-redeem` **故意没接**

核销（`redeemVisitGrant`）是**客机**的动作，它天然**不是面板**：把它挂成 `requirePanel` 等于
让"主机面板替客人核销"，语义是假的；不挂 `requirePanel` 又会凭空开一条匿名写事件的通道。
真跨机核销需要**传输层 + 对端身份**，那两样都不存在（`federation.md` §9 第一条）。
所以本批只接主机侧的四件事（发/作废/列/收名片），核销留给"跨机通道"那一步 —— **登记为缺口，不假装**。

> **给下一个人的落点建议（队长裁决原话）**：真跨机核销的正确落点是**传输层带对端身份** ——
> 客机的 Ed25519 名片验过之后，由**主机的 federation 核销入口直接调 `redeemVisitGrant`**，
> **不经过 socket 事件层**。理由：`requirePanel` 的语义是"本机面板"，而核销的主体是**对端主机**；
> 一旦把它塞进 socket 事件，要么语义是假的，要么就得开一条无主体的匿名通道。

---

## 4. token 的边界（三条，缺一条就等于把凭据交出去）

1. **只回一次**：`issueVisitGrant` 幂等再签时 `token:null`；处理函数原样透传，**不缓存、不回读**。
2. **不打日志**：成功只打 `grantId`（标识，不是凭据）；失败只打 `reason`。
   `wiring_federation_unit` 的 B 段把 `console.log/warn/error` **全部捕获**后断言
   "任何一条日志都不包含 token" —— 故意用 `console.log(token)` 破坏一次，该用例**必红**（§11）。
3. **不落盘**：库里只有 `sha256(token)`（`federation.js` 的既有口径）。单测 H3 把 `_global/` 下
   **所有文件**（含 `-wal`）读成字节流，断言找不到 token 明文。

> 为什么第 2 条值得单独一条用例：F-SEC-205 那一族（token 进日志）在本仓已经复发过两次。

---

## 5. 拒绝原因（面板必须能说清"为什么"）

`federation.js` 负责判定，mindserver **只做透传**，不做二次解释（判据只能有一份）：

| 场景 | 可能原因 |
|---|---|
| 收名片 | `bad-signature` / `pubkey-mismatch` / `stale-card` / `card-invalid` / `card-version-unsupported` / `pubkey-invalid` |
| 核销（未接线，仅登记） | `unknown-grant` / `revoked` / `expired` / `bad-token` / `already-used` / `not-allowlisted` / `guest-mismatch` |
| 签发 | `host-id-invalid` / `guest-id-invalid` / `ttl-invalid` / `max-uses-invalid` / `grant-id-taken` |
| 作废 | `unknown-grant` |

实现没给 `reason` 时**兜底成 `unknown`**（不允许回一个没有原因的 `{ok:false}`）——
单测 C3 钉住这一点，把兜底删掉就红。

**没有新增任何错误码**：全部走 `reason` 字符串，`contract.js` 的 `CODES` 一个没动
（`npm run gate` 的错误码审计仍是"扫到 N 个码、均已注册"）。

---

## 6. 身份变更写 events（`events.md` §11-1）

五条**面板侧**的写入路径都收口在 mindserver 的 `identity-*` socket 事件上（第 6 条 `identity.claim`
发生在 agent 侧，**本批未接**，见 §9）。成功写一条：

```js
recordEvent('identity.<kind>', { person, avatar, by }, { avatarId, sourceIp })
```

| socket 事件 | kind | payload 关键字段 | 为什么这么映射 |
|---|---|---|---|
| `identity-issue-code` | `identity.invite` | `{person:null, avatar, by:'panel'}` | 面板为某个 avatar 签发**一次性绑定码** = 邀请该人认领（此刻还不知道是谁来认领） |
| `identity-unbind` | `identity.revoke` | `{person, avatar, by, removed}` | 解绑 |
| `identity-recovery-issue` | `identity.recover` | `{person, avatar:null, by}` | 发恢复码（找回某个**人**，与 avatar 无关） |
| `identity-recovery-revoke` | `identity.revoke` | `{person, by, scope:'recovery-code', removed}` | 撤销恢复码也是"对一个人的安全动作"，用 `scope` 区分是哪一种 |
| `identity-avatar-relink` | `identity.relink` | `{person, avatar, by, retired}` | 改挂 |

三条硬约束（写进代码注释，也在单测里）：

1. **返回值不参与业务判断**：调用点全是**独立语句**，全文没有 `if (!recordIdentityEvent(...))`、
   也没有 `x = recordIdentityEvent(...)`（单测 G6 直接扫源码）。
2. **失败只记日志**：`recordIdentityEvent` 内部 `try/catch`，`ok:false` 与抛错两条路径都只 `console.warn`
   （单测 D1/D2 —— 把 `try/catch` 去掉，D2 立刻红）。
3. **不在热路径**：只在这 5 个低频管理面事件里写，`send-message`/`chat` 这类高频路径**一条都没加**。

---

## 7. 启动 CoreProtect 体检（`federation.md` §8-4）

放在启动诊断段末尾（OPS-003 / 身份绑定 / 离线模式三条同级），只读打开、**不建库**：

```
装好：[mindserver] CoreProtect 已安装：表 co_block，106120 行（E:\我的世界ai\server\plugins\CoreProtect\database.db）
没装：[mindserver] CoreProtect 未安装/不可用（not-installed）：库文件不存在：CoreProtect 未安装或未启用 ⇒ 块记录不会进 events
```

* 四态口径来自 `coreProtectStatus()`：`installed` / `not-installed` / `unrecognized-schema` / `open-failed`
  —— 后三种都**明说**，不静默（"0 行"和"没装"必须能被区分）。
* 体检本身抛错只 `console.warn`，**不许**弄挂启动（板起不来还能聊天，体检同理）。
* **真启动实测**（`createMindServer(false, 0)` + `MC_BOTS_ROOT` 指到临时目录，不碰生产数据；跑完即退）：

  ```
  装好：  [mindserver] CoreProtect 已安装：表 co_block，106120 行（E:\我的世界ai\server\plugins\CoreProtect\database.db）
  没装：  [mindserver] CoreProtect 未安装/不可用（not-installed）：库文件不存在：CoreProtect 未安装或未启用 ⇒ 块记录不会进 events（CoreProtect 导入不可用）
  ```
  未装那条用 `MC_COREPROTECT_DB=<不存在的路径>` 驱动：**打完这行后库里仍然没有该文件**（只读体检不会凭空建库）。
* **不做**定时体检 / 自动导入：10 万行全量导入是运维决策（`federation.md` §9），启动时只报状态。

---

## 8. `isVisitor` 注入（接缝已就位，判定**恒 false**）

```js
boardHandle = attachBoardServer({
    ...,
    isVisitor: visitorOf,     // ← 本批补上的注入点
});
```

`board_server.js` 只认这条注入的判定（绝不读 `payload.visitor`），且允许异步；
本批注入的是**同步 `return false`**。

### 8.1 现在的诚实状态

> **凭证接线完成前，没有任何连接会被判成访客。**

代码里写死 `export const VISITOR_JUDGEMENT_WIRED = false`，并把它透出到 `federation-status.visitorWired`
—— 这样"没接线"是**可查询的**，而不是只躺在文档里。单测 E4/I3 钉住它恒 `false`。

### 8.2 接线时要补的判据（先记下来，免得下一个人重新想）

1. 该连接对应的 **avatar 不属于本机 people 表**；或
2. 该连接**出示了有效的来访凭证**（`visit_grants` 的 grant 与 `known_peers` 的 peerId 映射到这条连接）。

缺的是**连接 ↔ peerId/avatar 的映射**：`peerId` 目前还是自由字符串（`federation.md` §9 最后一条），
所以这一步**不是接线问题，是一次显式设计**（谁代表这台机器、名片由哪把钥匙签、连接怎么证明自己是那个 peer）。
在它完成前把 `visitorOf` 写成"看起来像判定"的东西，就是本仓最常见的假修复 —— 所以这里**只留接缝**。

---

## 9. 明确**没做**的事（别读成"已实现"）

| # | 没做 | 为什么 / 下一步 |
|---|---|---|
| 1 | **`identity.claim` 没有写 events**（**未接清单**） | `!claim` 的核销发生在 **agent 子进程**（`src/agent/commands/identity.js`），mindserver 侧**没有收口点**。本批硬要求"只有 mindserver.js 可改"，所以：**接线点在 agent 侧 `!claim` 成功分支，归下一单**（队长已裁决另开 agent 侧任务）。⚠ **不许**在 mindserver 里造假收口点（例如监听某个事件反推 claim）—— 那会让事件表混进**不可信**的 claim 记录，比缺一条事件更糟。 |
| 2 | `federation:grant-redeem` 未接（**未接清单**） | 见 §3.1：客机动作；正确落点是**传输层带对端身份 + 主机 federation 入口直接调 `redeemVisitGrant`，不经过 socket 事件层**。 |
| 3 | 没有传输层 / 真跨机 | `federation.md` §7/§9 原样有效：不监听端口、不建连、无 TLS。 |
| 4 | 面板 UI 没有联邦视图 | 本批只提供 `federation-status` 的**服务端只读接口**；`web/**` 不在 inScope（其他成员负责）。 |
| 5 | `identity-status` 未改 | 按任务要求**不改旧字段形状**，一个字没动。 |
| 6 | 没做 CP 导入的定时任务 | 见 §7 末。 |

---

## 10. 面板只读接口：`federation-status`

```js
socket.emit('federation-status', {}, (r) => { /* ... */ });
// r = { ok, grants:[…], knownPeers:[…], allowedPeers:[…], visitorWired:false }
```

* `grants` 走 `sanitizeGrantRow` —— **白名单拷贝**（10 个字段），`token` / `token_sha256` / 任何未知字段
  一律不出现。为什么是白名单而不是"删掉 token"：多一个字段就多一次泄漏机会，白名单的失败形态是"少显示"，
  黑名单的失败形态是"泄漏"。
* `knownPeers` 只出 `peerId / lastAddr / firstSeen / lastSeen / cardSeq` —— **公钥不外发**。
* `allowedPeers` 只出 `peerId / addedAt / note`。
* `visitorWired` 是**设备状态**（§8.1），面板应当据此显示"访客判定未接线"，而不是显示"0 个访客"。
* 单测 E1/E2 用**会泄漏的假实现**（行里塞 `token`/`token_sha256`/`pubkey`）驱动，断言整串 JSON 里搜不到。

---

## 11. 验证记录（可复跑）

```bash
cd mindcraft
node tools/wiring_federation_unit.mjs        # 57 通过 / 0 失败，exit 0
node tools/mindserver_gate_unit.mjs          # ALL PASS: 49 passed, 0 failed
node tools/control_plane_guard_unit.mjs      # 73/73
node tools/control_plane_r6_unit.mjs         # ALL PASS: 53 passed, 0 failed
node tools/sec001_cookie_unit.mjs            # ALL PASS: 63 passed, 0 failed
npm run gate                                 # 自验时为 0；之后因 t2 的 board_server.js 改动变 1，见 §11.2
```

`wiring_federation_unit` 覆盖：
A 面板闸门 ｜ B token 只在回执/不进日志 ｜ C 拒绝原因透传 ｜ D events 旁路（失败/抛错）｜
E 只读视图脱敏 ｜ F 异常兜底 ｜ K **ack 形状归一**（`emit(ev, cb)` vs `emit(ev, payload, cb)`）｜
G 接线源码断言（8 事件/闸门/限流桶/isVisitor/身份事件/CP 体检）｜
H **真模块可达性**（真 `federation.js` + 真 `_global` 库 + 真 Ed25519：签发→预览→作废→收名片
（篡改/换钥/旧 seq 三种拒绝）→关系增量→只读视图→审计事件落库→token 不落盘）｜
I 来源 IP / 访客接缝 ｜ J 清理。

> ⚠ **它测到哪一步为止**：H 段是"直接调 handler 函数"（不是 socket 客户端），
> 所以它是"**逻辑与可达性**"的证据，不是"**真 socket 通路**"的证据 —— 见 §12 第 1/1b 条。

### 11.2 关于 `npm run gate`（诚实记录，别把别人的红算到自己头上，也别替别人掩盖）

* 本批自验**首次**跑 `npm run gate` 时是 **0**（时间点：t2/t3/t4 当时的改动已在树上）。
* 之后（t1 收尾期间）`npm run gate` 变成 **1**，原因是 `[6/6] 依赖注入审计` 报 A 档 1 处：

  ```
  ── B·ctx 字段不存在：1 处
    · board_server.js:84  ctx.worldId  → 早退行为=ok
  合计 1 处。
  ```

* **这一处不是本批的**：它来自 t2 对 `src/agent/library/board_server.js` 的未提交改动
  （`recordBoardEvent(recorder, kind, payload, ctx)` 里 `ctx?.worldId` 的早退分支，`git diff` 显示为**新增行**）。
  本批改的三个文件里 `ctx.worldId` 出现 **0 次**；行号在两次复现间从 `:72` 漂到 `:84`，说明该文件仍在被编辑。
* 本批的 5 个单测 + `unit_all` 在同一棵树上仍然全绿（§11 的命令）。
  **修法归 board 侧**（要么让生产绑定处显式注入 `worldId`，要么把这条早退改成上游必传）——
  t1 无权改 `board_server.js`，也不该为了让门禁变绿去动它。

### 11.1 「能红」实测（12 处破坏，各破坏一次 → exit 1；恢复后 57/57 绿）

| # | 破坏 | 红的用例 |
|---|---|---|
| 1 | `requirePanelRole` 恒放行 | A2 / A2b / A3 |
| 2 | 在签发路径 `console.log(token)` | **B2**（token 不进日志） |
| 3 | `sanitizeGrantRow` 改成 `{...row}` | E1 / E2 |
| 4 | `recordIdentityEvent` 把写失败当成功 | D1 / D1b |
| 5 | 去掉 `isVisitor: visitorOf` 注入 | **G4** |
| 6 | `relations-push` 空批次返回成功 | H13 |
| 7 | 启动不调 `coreProtectStatus()` | **G7** |
| 8 | 身份事件被短路（`void 0 && recordIdentityEvent(...)`） | G5 |
| 9 | 身份事件整段被注释掉（解析仍合法） | G5 |
| 10 | `fedOn` 里去掉 `requirePanel` | **G2** |
| 11 | `normalizeEmitArgs` 被去掉（`emit(ev,cb)` 时函数被当 payload） | K1 / K4 |
| 12 | `normalizeEmitArgs` 反过来（把 payload 也吞成 undefined） | K2 |

> 记录一条**测试自身**的教训（本仓母题，必须留档）：G5 第一版只判
> `ms.includes("recordIdentityEvent('identity.invite'")` —— 第 8 号破坏
> （`void 0 && recordIdentityEvent(...)`）**照样全绿**。
> 修法是把判据写窄成"**行首的独立调用语句**"，并先剥掉行注释（否则第 9 号也骗过去）。
> 这与 `federation.md` §10 那条（"SQL 守卫断言扫整个文件，被注释里同一串字喂绿"）
> 是**同一个根因的两处实例**：**"断言绿"不等于"接线在"；字符串匹配能被注释/短路喂绿。**
> 通用判据：**断言必须钉在"会被执行的那一行语句"的形状上**，而不是"文件里出现过这串字"。

---

## 12. 未验证清单（显式标注，不许当成已验）

| # | 项 | 状态 | 说明 |
|---|---|---|---|
| 1 | 面板真的连上来调这 8 个 `federation:*` 事件 | **未验证真 socket 通路** | 本批的单测是「**直接调 handler 函数**」（`federationIssueGrant` / `federationStatus` …）+ 源码接线断言，**没有**起 socket.io 服务器、也**没有**用 socket.io-client 连上去 emit。真进程只验到"启动 + CP 体检行"。⇒ 面板到事件的端到端归真机 E2E（t5 复跑）。 |
| 1b | `fedOn` 的 payload/ack 归一分支（`emit(ev, cb)`） | **逻辑已验证 / 传输未验证** | 归一逻辑已抽成 `normalizeEmitArgs()` 并被单测 K1–K4 覆盖（破坏 R11/R12 都会红）；但「socket.io 真的按假设把 (payload, cb) / (cb) 传进来」**只有**真 socket 能证。 |
| 2 | 事件表在长时间运行下的增长 | **未验证** | 只证明了"会写"，没跑过容量/清理（`events.md` §12：不做 retention） |
| 3 | 跨机签发/核销/名片 | **未验证** | 同 `federation.md` §7 |
| 4 | `identity.claim` 的事件 | **未接线** | 见 §9 第 1 条（接线点在 agent 侧，归下一单） |

---

## 13. 面板只读入口：`events:since` + `events:stats`（t7）

`global_store` 的三个读函数（`sinceEvents` / `statsByKind` / `countEvents`）实现齐全，但**生产路径零调用方** ——
面板的 events 视图一直是死路（wire-web 在 t3 按契约做好了面板，只等服务端接上）。本节记 t7 的接线与边界。

### 13.1 两个事件（都走 `fedOn`，与联邦那批同一个包装）

| socket 事件 | 底层调用 | 桶（次/60s） | 回执 |
|---|---|---|---|
| `events:since` | `sinceEvents(since, {kind, worldId, limit, readOnly:true})` | 30 | `{ok, events:[6 字段], count, limit}` |
| `events:stats` | `statsByKind({worldId, readOnly:true})` | 20 | `{ok, kinds:[{kind,count,firstAt,lastAt}]}` |

复用 `fedOn` 换来**四件结构保证**（而不是在 handler 里各写一遍）：`requirePanel` 闸门、
**label=事件名** 的独立限流桶、`safeFederationCall` 异常兜底、`emit(ev,cb)` 单参 ack 归一。
`statsByKind` 的返回**已经**含 `firstAt/lastAt`，不需要动 `global_store`（任务问过这一点：不缺字段）。

### 13.2 五个必须说清的口径

1. **两种游标语义不同**（不是笔误）：
   - `since` 是**数字** ⇒ `at >= since`（**含边界**，宁重不漏；面板按 id 去重）；
   - `since` 是 `{at,id}` ⇒ `(at > at) OR (at = at AND id > id)`（**严格 >**，同毫秒也不漏，翻页用它）。
   单测 B3/B4/B5 分别钉住：同毫秒的两条在数字游标下**都回来**、在元组游标下游标那行**被排除**、
   游标指向最后一条 ⇒ 空结果（不是"最后一条再给一次"）。
2. **读侧参数错误必须翻成 reason**：`global_store` 在参数非法时是**直接 throw**（`SINCE_INVALID` / `KIND_INVALID`）。
   handler 里 try/catch 翻成 `since-invalid` / `kind-invalid`，未知异常翻 `internal` ——
   **绝不让异常穿进 socket.io 回调**（那会和其他事件的行为不一致：客户端只看到 ack 超时，分不清"没做"与"炸了"）。
3. **`limit` 归一（选"夹到上限"而不是报错）**：缺省 200、超上限**夹到 500**（回执带回**生效值**）、
   非正整数（0/负数/非数字）⇒ `limit-invalid`。
   为什么夹而不是拒：面板的 `mayHaveMore = 行数 >= limit` 是照"满页=可能还有"设计的，它自己传的 200 不会超限；
   真超限的多半是脚本/手搓请求，**夹到上限**比让面板空手而归更有用，但**必须把生效值带回去**，否则面板会误判翻页。
   为什么上限是 500 而不是 `global_store` 的 2000：事件表只增不减，面板一页 200 已够，500 是给"导出前预览"留的余量。
4. **只读、用完即关**：`readOnly: true` ⇒ `global_store.readVia` **自己开一个只读句柄并在 finally 里关掉**；
   mindserver **根本不 import `openGlobalDb`**（单测 H4 直接扫源码断言）⇒ 结构上拿不到写/复用句柄。
   另有一条实测（E2）：拿只读句柄 `INSERT` 会被 SQLite 直接拒（`SQLITE_READONLY`）。
5. **`payload` 不二次序列化**：`global_store.rowToEvent` 已经 `JSON.parse` 过；handler 只做
   `payload: r.payload ?? null`（**兜底 `undefined` → `null`**，让"解析失败"在 JSON 里表现为 `null` 而不是字段消失）。
   单测 F1 用真库插一条坏 `payload_json`（events 追加写只禁 UPDATE/DELETE，INSERT 可造脏行）、
   F2 用假实现喂 `payload: undefined` 让兜底**承重**。

### 13.3 为什么这次不碰 `web/**`

面板（`web/src/stores/world.ts`）已经按契约实现，并且**已经把"没接"和"没有数据"分开**：
`EVENTS_PARAM_REASONS = ['since-invalid','kind-invalid','limit-invalid','internal']` ——
收到这几个 reason 就说明"服务端已接、这次请求不合法"，没 ack 才是"未接线"。
服务端接上即点亮，**面板侧无需改动**（已与 wire-web 对齐）。

### 13.4 验证（真跑）

```bash
cd mindcraft
node tools/wiring_events_read_unit.mjs     # 44 通过 / 0 失败，exit 0
npm run gate                                # 0
node tools/deps_injection_audit.mjs         # A 档 0 处（形参用 evCtx 不用 ctx）
node tools/unit_all.mjs                     # 全绿
```

`wiring_events_read_unit` 覆盖：A `limit` 归一 ｜ B 两种游标语义 + 行形状 + kind/worldId 过滤 + limit 生效 ｜
C 参数错误翻 reason（含实现抛错）｜ D 非面板拒 ｜ E 只读三证（传参/INSERT 被拒/不漏句柄）｜
F 坏 `payload_json` 与 `undefined` 兜底 ｜ G stats 形状/排序/worldId/失败兜底 ｜ H 接线源码断言 ｜ J 清理。

**「能红」实测（10 处破坏，各破坏一次 → exit 1；恢复后 44/44 绿）**

| # | 破坏 | 红的用例 |
|---|---|---|
| 1 | `readOnly: false` | E1 / E1b |
| 2 | 不翻异常（`throw e`） | C1 / C2 / 真库段整体 |
| 3 | 不做字段映射（`{...r}`，把 `payloadOk`/`sourceIp` 塞给面板） | B2 / F2 |
| 4 | `payload` 变字符串 | B6 / F1 / F2 |
| 5 | `limit` 不夹上限 | A3 / B10 |
| 6 | 回执不带生效 `limit` | B9 / B10 |
| 7 | 少注册 `events:stats` | H1 |
| 8 | `limit<=0` 静默退默认 | A6 / C5 |
| 9 | 形参改叫 `ctx` | H3（且会被 `deps_injection_audit` A 档报成死分支） |
| 10 | 游标语义写反（把 `{at,id}` 元组当成数字传给 `sinceEvents`） | B4 / B5 |

> 记一条**测试自身**的坑（同 §11.1 母题）：第一版"不做字段映射"的破坏写成了**把锚点替换成它自己**（粘贴错误），
> 于是"破坏"根本没发生、测试自然全绿，harness 报 `NOT-RED`。**破坏实测本身也会假绿** ——
> 判据是"改完磁盘上的字节确实变了再跑"（harness 里 `bak.includes(from) && from !== to` 应当显式断言）。

---

## 14. 一句话结论

`federation.js` 从"只有单测在用的孤儿模块"变成**控制面带闸门、带限流、带脱敏、带原因**的 8 个 socket 入口；
身份变更的 4 条路径开始写 events（第 5 条 `identity.claim` **明写缺口，归下一单**）；
启动时 CoreProtect 装没装**每次都说得清**；`isVisitor` 的注入点补上了，但判定**诚实地恒为 false**。

**边界一句话**：本批证明的是「**逻辑对 + 生产可达 + 破坏能红**」；
**没有**证明「真 socket 通路」（单测直接调 handler，没有真客户端）—— 那一条归真机 E2E。
