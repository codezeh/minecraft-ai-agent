# R6 整批 diff 复核（防假修复）· t7 / gate-runner

> 只读复核。范围：mindcraft `src/**`（24 文件 / +1230 −227）+ `tools/`（3 文件）+ 父仓 `scripts/**`、`web/src/**`。
> 基线：mindcraft `2f1f6f4`；父仓工作树（33 项改动）。
> 复核判据四条（任务给定）：① 失败是否被改成静默降级/返回成功；② 鉴权校验是否真在服务端；
> ③ 事务是否真包住"读-判断-写"；④ 有没有为让测试变绿而放宽断言/删测试。
> 日期：2026-11-11。**未修改任何产品代码**（§7 有一次带备份的临时反向验证，已按字节复原）。

---

## 0. 总裁决

**敢合。** 四条判据全部通过，没有发现任何一处"把失败变成静默成功"的假修复。

| 判据 | 结论 | 证据强度 |
|---|---|---|
| ① 假修复（静默降级/返回成功） | **通过** | 逐条读了 24 个文件的改动；`ok:true` 的每一处都追到调用方，失败面都在；`skipped` 只在幂等 no-op 上用，且**对外翻成失败** |
| ② 服务端鉴权 | **通过** | 身份取 `socketRole()`/`socket.data.agentName`（握手门 + `claimAgentChannel` 裁决），**不是**客户端自报；`knownAgent()` 全部走 `hasOwnProperty` |
| ③ 事务包住读-判断-写 | **通过（1 处降级为"检测+重试"，已评估）** | `finish` 等把判据压进 SQL `WHERE` + 只看 `changes`；`mergeSharedChest` 在 `BEGIN IMMEDIATE` 里；`mutateStore` 持真文件锁 |
| ④ 测试没被软化 | **通过** | **零**删除 `check()`、**零**注释掉的断言、**零**新增 skip、**零**删除测试文件；8 个新测试全在实跑清单 |

**独立反向验证（我自己做的，不改 t6 结论）**：#56 那段行为断言，我改的是**另一个判据**（`Resolve-PanelPortState`），照样红（见 §7）。说明它不是只对某一处敏感。

---

## 1. 判据①：有没有把失败改成静默成功

### 1.1 逐个追 `ok: true` / `return true` 的加行

`git diff src/ | grep '^\+.*ok:\s*true'` 共 20 余处，逐条追调用方后只有两处形态可疑，**两处都不是假修复**：

| 位置 | 形态 | 裁决 |
|---|---|---|
| `identity_store.js:387` `if (!out) return { ok:true, skipped:true }` | 内部信号 | **pass**：`consumeCodeAtomic:409-410` 立刻把它翻成 `{ok:false, reason: why ?? 'invalid'}` —— 对外**是失败**。`skipped` 只表示"mutator 判定无事可做"（幂等） |
| `mindserver.js:530` 同形 | 内部信号 | **pass**：三个调用方都用 `if (!out.ok) { 回失败 }`；1902（断开清理）用 `if (out.ok && out.result>0)`，不满足就只记日志、**不假装成功** |
| `board_server.js:476` `return {ok:true, fields}` | 校验器成功路径 | **pass**：`validateIncomingJob` 紧接着 `if (!fields.ok) return {ok:false, reason}` |
| `board_server.js:500/505` `registryAdmit` | 准入成功 | **pass**：满员时返回 `{ok:false, reason:'registry-full'}` → hello 回 `TOO_MUCH` |

**关键反例（做对了的）**：`coder.js` 的 #40。原实现是 `readFile(..., (err) => { if (err) throw err })` —— throw 在回调里 = uncaught = **进程退出**。新实现不吞错：把错误记进 `templateError`，`generateCode()` 入口**直接返回失败串** `Code action unavailable: ...`（进模型上下文，可见），不是返回 `''` 或装没事。**这是"把崩溃换成有界失败"，不是"把崩溃换成静默成功"。**

### 1.2 `catch` 块逐一看

`git diff src/ | grep '^\+.*catch'` 共 26 处。分类：

- **`try{...}catch{/* ignore */}` 用于清理路径**（`unlinkSync`/`timer.unref`/`emit` 给已断开的 socket）：**合理**，这些失败没有恢复动作，吞掉不改变结果。
- **`catch { /* 取不到就当"没有进程" */ }`**（`mindserver.js` 内 `fstatSync` 判 stdout 是否被重定向）：方向正确 —— 取不到时**选择"当作是文件"⇒ 不打印 token**，是 fail-closed 而非 fail-open。
- **`catch (e) { console.error(...); }` + 明确降级**（#74 `identity-status`）：注释写明"原来裸 catch 让面板只看到 `mode:null`，分不清'读不到'与'正常'" —— 现在是**增加可观测性**，不是掩盖。
- **`catch` 后 `continue` 重试**（#41 `coder.js`）：有界（`MAX_ATTEMPTS`），且把错误文本塞回 messages —— 不是吞。

**没有发现"catch 后 return 成功"的写法。**

---

## 2. 判据②：鉴权/校验是否真在服务端

### 2.1 身份来源是服务端裁决，不是客户端自报 —— pass

| 判据入口 | 实现 | 文件:行 |
|---|---|---|
| `isAgentIdentity(socket)` | 先看 `socketRole(socket)`（**握手门 `io.use(makeHandshakeGate)` 定的角色**）；无角色戳才退回旧判据 | `mindserver.js:264-272` |
| agent 名戳 | `socket.data.agentName = agentName` 由 `bindAgentChannel()` 在 `claimAgentChannel()` **裁决通过后**写入 | `mindserver.js:1864` |
| 通道占用 | `claimAgentChannel({agentIdentity, credentialAgentName, requestedName})` —— 凭据只能占自己的名字，被顶掉的一方收到 `agent-channel-taken-over` | `mindserver.js:1826-1858` |
| 名字收口 | `knownAgent = Object.prototype.hasOwnProperty.call(agent_connections, name)` —— 原型链键（`'constructor'`/`'__proto__'`）不再是 agent 名 | `mindserver.js:1523-1526` |
| 面板专属动作 | `requirePanel()` / `isPanelConnection()` 挡在 `server-start/stop/status/log`、`create-agent`、`set-agent-settings`、`restart-agent`、`stop-agent`、`destroy-agent`、`listen-to-agents`、`identity-*` 上 | 见各 handler 首 3 行 |

**任务板侧同样在服务端**：`validateIncomingJob` + 新增 `validateAddFields`（state 白名单、`running` 必须带 assignee、`maxAttempts` 1–10、`claims` 过 `normalizeClaimKeys`）→ `board_server.js:52-105`；`board_client` 的校验只是**提前拦**，服务端**再校验一遍**（不是"客户端校验即信任"）。

### 2.2 发现 1 处 fail-open 兜底（低危，如实报告）

`mindserver.js:1805-1818`（`get-settings`）：

```js
if (socketRole(socket) === ROLE_AGENT) {
    const owner = socket?.data?.agentName ?? credentialAgent(tokenFromSocket(socket));
    if (owner && owner !== wanted) { ... 拒绝 ... }
}
cb({ settings: agent_connections[wanted].settings });
```

`owner` 为 `null`（agent 身份，但这条连接既没有 agent 名戳、凭据也映射不到具体 agent）时，条件 `owner && ...` 短路 ⇒ **放行读任意 agent 的设置**。

- **可达性**：需要"agent 类型凭据 + 该凭据未映射到任何 agent 名"。生产上每条 bot 一条凭据且已映射（ADR 阶段 1），所以正常路径**命中不到**；共享 `MINDSERVER_TOKEN` 的旧部署下可达。
- **影响**：读到的是 settings（模型名/端口/`permissions.owner` 名单等），**不含** vault 口令；不能改（`set-agent-settings` 仍要 `requirePanel`）。
- **建议最小修法**：`if (owner !== wanted)` 前先 `if (!owner) reject('identity-unbound')` —— 一行，与同文件其它 handler 的 fail-closed 口径一致。
- **verdict**：`needs_revision`（低危、非阻断）。这条**不影响"敢合"**，但要进残留清单。

---

## 3. 判据③：事务是否真包住"读-判断-写"

### 3.1 `finish()`（#22）—— 教科书式正确 pass

判据**压进 SQL**，成败只看 `changes`（`board_store.js:1262-1300`）：

```sql
UPDATE jobs SET state=?, attempts=?, lease_owner=NULL, ...
WHERE id=? AND state=? AND attempts=? AND (lease_owner IS NULL OR lease_owner=?)
```

- `changes === 0` → 一字不写，返回 `LEASE_STALE`（不是"照写然后说成功"）。
- **补了个 fail-closed 洞（T31）**：`bot` 未传 **且** 该行租约非空且未过期 → 直接 `LEASE_STALE` + warn。原来"不传 bot 就不校验"等于给漏传者开后门，现在只收紧危险窗口，其余路径不变（`board_store.js:1216-1228`）。
- **注意（正确但容易误读）**：`state=?`/`attempts=?` 取自先前的 `getJob` 快照。这**不是** TOCTOU —— 陈旧快照只会让 `changes=0`（拒绝），不会写出错误值。

### 3.2 `mergeSharedChest()`（§10.2-1）—— pass

`runInImmediateTx(db, ...)` 把"读 `getShared` → 合并 → `putShared`"整个包在 `BEGIN IMMEDIATE` 里；抢不到锁返回 `BOARD_BUSY`，**不降级成无锁读改写**（`board_store.js:2414-2455`，注释里写明了这条历史）。

### 3.3 两套"身份文件写者"共存 —— 已知残留，安全方向成立

| 机制 | 位置 | 是否有真互斥 |
|---|---|---|
| `mutateStore`（文件锁 `O_EXCL`，锁跨读-写） | `identity_store.js:378-396` + `acquireFileLock:306` | **是**（真锁，超时 3s、残留 10s 可抢） |
| `mutateStoreFile`（内容哈希 CAS + 写后复核 + 重试） | `mindserver.js:520-547` | **否**（是"检测+重试"，不是锁） |

**我重点验的是危险方向**：面板（无锁）与游戏内核销（有锁）并发写 `identity-codes.json`，会不会把**已核销的码写回去**（复活一次性码）？

- 面板 mutate 出的 store **带着 `rev`**（`sanitizeStore:214` 保留 rev）⇒ `writeStore:287` 的乐观锁**生效**：`store.rev !== curRev` → `{ok:false, reason:'conflict'}` → **拒写**。
- 所以"复活已核销码"这条**被挡住**（不是靠 CAS，是靠 rev）。t8 记的"两套机制并存但兼容"属实。

**残余（低危，如实报告）**：`mutateStoreFile` 在 `writeStore` 返回 `conflict` 时**直接返回失败、不重试**（`mindserver.js:537`），与"哈希检出变化"时的 `continue` 不一致。后果：
- `identity-issue-code` → 面板收到"写码失败"，用户重点一次即可（**可见失败**，可接受）。
- `disconnect` 里作废未核销码 → 只记日志后放弃 ⇒ 那些码要等 TTL（5 分钟）自然过期，不是"永久有效"。
- **建议**：把 `conflict` 也走 `continue`（与哈希分支同形），或在注释里写明"这里刻意不重试"。

### 3.4 `anyState` 逃生门 —— 现存但**全仓零调用**（pass，附观察）

`finish(..., { anyState:true })` 可绕过新的"状态必须可收尾"判据。`grep -rn anyState src/ tools/` ⇒ **只有定义那 2 行，0 调用**。好处是测试走的是默认路径（防护真被覆盖）；坏处是留了一条**没人测的旁路**。建议要么删，要么加一条"用它必须写理由"的注释。

---

## 4. 判据④：有没有为让测试变绿而放宽断言/删测试

### 4.1 硬指标（全为 0）

```
mindcraft: git diff | grep -cE '^-\s*(check|ok|bad)\('        → 0
父仓:      git diff -- scripts/ | grep -E '^-\s*(check|assert)\(' → 0（唯一 '-' 是 release.ps1 里一条 ok() 文案改了字）
注释掉的断言 '^+\s*(//|#)\s*(check|assert)\('                    → 0
新增 skip/xfail/todo                                            → 0
删除的测试文件（git status ' D' 里的 test/unit）                  → 0（那批 D 全是 web-dist 重建替换的产物）
```

### 4.2 唯一改动的测试文件：`board_b3_unit.mjs` —— 是**收紧**不是放宽

t2 提示"此文件有他人改动"。逐行读了：改动在**夹具拓扑**（`tools/board_b3_unit.mjs:475-510`）——

- 原来两个 client **共用一个 `srvSocket`**；现在 `mkPeer('agent','alpha')` / `mkPeer('agent','beta')` **各连一条**，且桩里如实提供 `data:{role, agentName}`。
- 理由（diff 注释原文）：board 层现在要求"写事件有明确角色 + agent 连接只能代表已 hello 的那一只"，共用 socket 会让第二个 client 的 hello 把第一个顶掉。

**判定**：这是把"假拓扑"改成"真拓扑"，让测试**更贴近生产**、更容易红。断言数量与强度都没降。

> 诚实附注：桩里 `data.agentName` 是**测试自己给的**，所以这个用例证明不了"服务端会不会写这个戳"。那一点由 `mindserver.js:1864` 与 `bindAgentChannel` 的用例覆盖（`control_plane_r6_unit` / `mindserver_gate_unit`）。**不构成假绿**，但要知道它守的是 board 层的"敢不敢信"，不是服务端的"会不会写"。

### 4.3 8 个新测试**都真的在跑**（不是"写了没接"）

`unit_all.mjs:93-99` 的 `UNITS` 是 **`readdirSync` 自动发现**，不存在"忘记登记"。实测 `npm test` 日志里 8 个名字各出现 2 次（启动行 + 结果行）：

```
control_plane_r6_unit(53) r6_task_end_unit(25) r6_agent_runtime_unit(39)
board_add_guard_unit board_registry_unit board_transition_guard_unit
identity_claim_race_unit identity_corrupt_unit(4)
```

总数 134 → **142**，**跳过数仍 5**（没靠 skip 变绿）。

---

## 5. 逐条 verdict

> 说明：我只复核**别人**的实现；t6（我自己跑的验证）不作为被复核对象。

| 项 | 归属 | verdict | 关键依据（文件:行） |
|---|---|---|---|
| §10.2-1 category 不丢 | t2 | **pass** | `board_store.js:2436,2448` 以 `{...prevValue}` 为基底只覆盖 4 字段；事务包在 `runInImmediateTx:2433` |
| §10.2-2 MANIFEST 单一写者 | t5 | **pass** | `sync_web_dist.mjs:100,126` 只保留不写；`release.ps1` files 按磁盘重算、verify 用清单记录（非同义反复） |
| §10.2-3 任务中 killAll | t3 | **pass** | `task_end_policy.js:60-74` 只有 success→shutdown；`tasks.js:488-500` 宽限**有界**（30s+60s→MISSING，不会无限等）；`agent.js:1258` 单一入口 |
| §10.2-4/5 限流按 agent | t1 | **pass** | `mindserver.js:554-570` 桶键 `label@主体@addr`；主体取 `socket.data.agentName`，未绑定退凭据指纹 |
| #20 add 字段校验 | t2 | **pass** | `board_server.js:52-105` 服务端白名单；`running` 必须带 assignee |
| #21 跨进程核销 | t2 | **pass** | `identity_store.js:306-320`（真锁）+ `378-396`（锁跨读改写）+ `280-298`（rev 拒覆盖） |
| #22 状态机/租约 | t2 | **pass** | SQL `WHERE state=? AND attempts=? AND lease_owner…` + `changes===0` 才判成败 |
| #24 登记表上限 | t2 | **pass** | `board_server.js:208-218`（满则淘汰/拒）+ `421-427`（disconnect 摘除）；`roles` 明确标注"提示非授权" |
| #23/#25/#26/#27/#28/#29/#30/#31/#32/#33 | t1 | **pass** | 服务端鉴权/限流/CAS/并发闸/并发拉取，逐条见 §2、§3 |
| #35/#36/#37/#38/#39/#40/#41/#42 | t3 | **pass** | #40/#41 见 §1.1（失败可见、重试有界）；#42 移除 3 条未实现命令并有反向自检 |
| #43 任务单定级 | t3 | **pass（未接线，按裁决）** | `permissions.js:71-88` 语义已正确且**透传 uuid/identity**，但 `board_scheduler` **不调用** ⇒ 功能上仍留身份旁路。文档如实写明，**没有谎报已修** |
| #57–#66 + #68 前端 | t4 | **pass** | 未见吞错；`socket.ts` 的 catch 只是重连标志位兜底 |
| #44/#48–#56 部署门禁 | t5 | **pass** | #51 用独立退出码 4（ops-regression 有一条断言专门钉"不再 exit 0"，实跑 PASS） |
| **#27 get-settings fail-open** | t1 | **needs_revision（低危）** | `mindserver.js:1805-1818`：`owner==null` 时放行任意 agent 读设置 |

---

## 6. 残留清单（按是否阻断合并排序）

**不阻断合并，但必须在合并说明里写清：**

1. **`get-settings` 的 `owner==null` fail-open**（t1，低危）— 一行可修，见 §2.2。
2. **身份文件两套写者并存**（t1/t2）— 面板侧是"哈希 CAS + rev"不是真锁；`conflict` 时不重试（§3.3）。当前安全方向成立，但属结构性欠账。
3. **#43 未接线**（t3）— 任务单定级接口已正确但无人调用 ⇒ 任务单仍是身份旁路的可能入口（取决于 `board_scheduler` 现在按什么定级）。**这是本批最大的一条"未闭口"**，需要下一轮接线（前置：拿到下单人 `identity`+`uuid`）。
4. **`anyState` 逃生门全仓零调用**（t2）— 建议删除或加理由注释（§3.4）。
5. **`board_b3` 桩自给 `data.agentName`**（测试）— 守的是 board 层信任，服务端"是否写戳"由别的用例守（§4.2）。
6. **t5 的 `-VerifyOnly` 免责句已过期**（t6 已报）— 现为绿，建议更新文档。
7. **`panel_guard.ps1` 的 BOM 缺口已关闭**（t6 报的 §5.4）— 复核期间已确认补上（`ef bb bf` 就位，且与 t6 备份逐字节只差这 3 字节）。
8. **未真机项**（t6 §8）：#54 计划任务冒烟 / #52 docker build / #53 e2e / #55 ACL `-Apply` / `.bat` UAC 提权链 / mindserver 真 socket / 前端真浏览器 / 完整非 DryRun 启动链。

---

## 7. 我做过的唯一一次临时改动（已按字节复原）

为了**独立**验证 #56 的行为断言（而不是复述 t6 那次），我改的是 `Resolve-PanelPortState`（**另一个判据**），形态取原缺陷：任何"有监听"都当成本项目的面板。

```
# 在 `if (-not $Listening) { return 'free' }` 之后插一行 `return 'ours'`
FAIL R6#44 8080 被陌生服务占用 ⇒ foreign → ours
HAS FAILURES: 86 passed, 1 failed     ← exit 1
```

复原：`cp -p` 备份回写，`tail -c +4 | cmp` 与 t6 备份**逐字节相同**（仅差 BOM 3 字节，那是别人后加的），复跑 `ALL PASS: 87 passed, 0 failed`。

**结论**：#56 那段不是"只对 `Wait-BotSpawned` 这一处敏感"的窄断言，而是**真的把假事实喂进判据库、按 verdict 断言**。t6 说它"能红"是对的，且我换了一处也能红。

> 顺带记录一个复核发现：`scripts/lib/panel_guard.ps1` 在我 t6 报告之后、t7 开工之前被人补上了 BOM（mtime 18:34）。所以 t6 §5.4 那条建议**已闭环**，不需要再派人。

---

## 8. 复核方法与局限

**做了的**：逐文件读 24 个 src 改动 + 3 个 tools 改动 + 父仓 `scripts/`、`web/src` 改动；对 `ok:true`/`catch`/`await` 类形状做全量 grep 后**逐条追调用方**；核对鉴权基元的取值来源（是 socket 还是 payload）；核对事务边界（`BEGIN IMMEDIATE` / SQL WHERE / 文件锁）；核对测试硬指标（删断言/注释/skip/删文件/自动发现/实跑日志）；一次独立反向验证。

**没做的（诚实边界）**：没有起真 mindserver / 真 MC 服 / 真浏览器去跑（那属 t6 §8 的真机清单）；没有对 `web/src` 的每个 Vue 组件做逐行语义复核（`vue-tsc` 0 + 产物三方一致由 t6 覆盖）；没有做性能或压测意义上的并发验证 —— §3.3 对"复活血"的判断是基于 rev 乐观锁的**代码路径推理 + t8 的 D 段真行为用例**，不是我自己跑的多进程压测。
