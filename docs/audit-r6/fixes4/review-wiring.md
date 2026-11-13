# 整批 diff 复核（t6）：生产接线批次 —— 防假修复

> R6 / fixes4 · 2026-11-13 · 任务 **t6**（成员 `gate-runner`）· **只读复核**（未改任何产品代码；探针在 `mindcraft/tmp/verify/`，已 gitignore）
> 复核对象：`mindcraft` `861b82b`（接线主体）+ `af0b6a5`（面板四视图/expired 口径）+ 父仓 `79a0f8b`（web + 文档）
> 上游：t1/t2/t3/t4/t7/t8 的交付说明与文档；t5 的 `verification-wiring.md`（真机验证）

---

## 0. 结论：**敢合**（verdict = pass），附 8 条残留（无一条阻塞）

| 判据 | verdict | 一句话 |
|---|---|---|
| ① 有没有把失败改成静默降级/返回成功 | **pass**（2 条低危残留 R2/R6） | 所有拒绝路径仍返回 `ok:false` + 原因；两处"失败→看起来成功"只在**当前不可达**的分支上 |
| ② 鉴权是否真在服务端 | **pass** | 10 个新事件全部 `requirePanel`（结构保证）；board 的"我是谁"由 `socket.data.agentName`（服务端戳）对账，不信 payload |
| ③ 事件是否真写进 `_global`（不是只调函数） | **pass** | 我用**独立探针**正向证明 8 个 kind 真落库（9 行、world_id 全非空）；`void ev` 是明示旁路，但写入本身可被真库观测 |
| ④ 有没有为让测试变绿而放宽断言 | **pass** | 既有测试只被**追加**（+27/−0，新增用例㉒）；4 个新测试有阳性对照 + 变异证据；源码断言先剥注释再计数 |

**敢不敢合**：敢。核心口径（不静默降级、服务端鉴权、事件真落库、不放宽断言）都站得住，
且每一条我都在**真模块/真 socket** 上复核过，不是只读注释。

⚠ 但请按 captain 的裁决记录 ④：**「先预占再取用」= 机制已验（单测 + 真 socket），生产入口未接**
（`opts.shared` 无生产调用方）—— **不要写成"已闭环"，也不要写成"没做"**。

---

## 1. 复核范围与"看没看全"

| 提交 | 内容 | 我的复核方式 |
|---|---|---|
| `861b82b` | `mindserver.js` +352/−9、`board_server.js` +200/−2、`board_inventory.js` +99/−1、`flow_store.js` +176/−5、`global_store.js` +3、4 个新测试 | 逐 hunk 读 + 结构性 grep + 独立探针 |
| `af0b6a5` | `board_inventory.js` +6/−1（`expiredCount`）、`board_server.js` +1/−1、`inventory_ledger_unit` **+27/−0**、web-dist | 逐 hunk 读（是否放宽既有断言） |
| `79a0f8b` | `web/src/**`（只读四视图）+ 4 份接线文档 | 读 `readOnce`/`requestRead` 的失败语义 + 事件名白名单 |

**逐条看过的删除行**（删除是"守卫消失"的高发区）：本批产品代码共删 17 行，全部是
①`settleTake` 的过期文案（被"过期/已释放"两分支取代）②import 行 ③`team:leave` 由同步改 `async`
④`store()` 三处 `return ok(...)` 多了一个 `...(shared ? {ledger} : {})` ⑤`fetch` 改名 `fetchLocal`
⑥内联 `requirePanel` 抽成模块级。**没有一处是删掉校验/早退**（逐个看过）。

---

## 2. 六个重点逐条 verdict

### 2.1 `federation:*` 是否**都** requirePanel —— **pass**

- 结构：唯一注册器 `fedOn`（`mindserver.js:2102-2108`），顺序是 `requirePanel` → `takeToken(label=事件名)` → `safeFederationCall`。
- 全仓 `socket.on('federation` **0 处**；`socket.on('events:` **0 处** —— 全部走 `fedOn`（`mindserver.js:2110-2121`，共 10 条：8 联邦 + 2 只读）。
- 因此"漏一条 requirePanel"在结构上不可能：**新增事件若绕过 fedOn，才会漏**；本批没有绕过。
- 鉴权结论来自**服务端凭据种类**：`requirePanelRole`（`mindserver.js:696`）用 `socketRole(socket)`（握手时 `credentialRole` 定，`auth_gate.js`），不看 payload。
- 真 socket 复核（t5，我跑的）：agent 凭据调 `federation:grant-issue` / `events:since` ⇒ `{ok:false, reason:'panel_only', role:'agent'}`。
- **残留**：`federation:grant-redeem` **故意未接**（t1 已声明：客机动作，挂 requirePanel 语义是假的，需传输层+对端身份）。`redeemVisitGrant` 因此**仍无生产调用方**。

### 2.2 签发 token 是否只出现一次、日志零命中 —— **pass**

- `federationIssueGrant`（`mindserver.js:784-804`）：token 只在"非幂等"的返回里；幂等分支 `token: null`；日志只打 `grantId`（`token 只在本次回执里`）。
- 列表侧：`federationListGrants`（:820）与 `federationStatus`（:870）都 `.map(sanitizeGrantRow)`，白名单 10 字段（`GRANT_PUBLIC_FIELDS`，:729），**不含 token / token_sha256**；`publicPeerRow`（:747）不含公钥。
- 落库侧：`federation.js:151-157` 只写 `token_sha256`，明文不落盘。
- t1 单测有**阳性对照**（B1 回执里确有 token）+ **全日志捕获**（B2）+ **磁盘扫描**（H3）；我的 t5 真 socket 另做了一次独立 `grep -F`：7251 字节 stdout+stderr 无命中，run 目录全树无命中。
- 一次"三处独立证据"都指向同一结论，不是自证。

### 2.3 `recordEvent` 返回值是否真没参与业务判断 —— **pass**

全仓 `recordEvent(` 调用点只有 2 处（外加 1 处包装）：
| 位置 | 用法 | 是否参与业务 |
|---|---|---|
| `federation.js:76`（`audit()`） | `const r = recordEvent(...)`，失败只 `console.error` | **否**（返回值不返回给业务分支） |
| `federation.js:649`（CP 导入） | 用于计数/告警 | 否（导入流程不因事件失败而中止） |
| `mindserver.js:723`（`recordIdentityEvent`） | 包一层 try/catch，返回 `{ok,reason}`，**调用方一律裸调用** | 否 |

board 侧更严格：9 个调用点**全部** `void ev(...)`（`board_server.js:1074/1095/1116/1122/1204/1233/1264/1292/1355`），
`recordBoardEvent`（:249-268）在 4 条失败路径上**都返回 `ok:false`**（`no-recorder` / `no-world-id` / 写入失败 / 抛错），不会假装成功。
t2 的 B1/B2/B3 还做了源码级反向保护（剥注释后数 `recordEvent(`=0、`ev(` 全等于 `void ev(`、禁止 `const r = ev(` 等四种接法）。
**我用 9 个 `void ev` 的实际行号复核过，与 B2 的计数一致。**

### 2.4 `isVisitor` 是否真传到 `board_server` —— **pass**

- 注入点：`mindserver.js:1550` `isVisitor: visitorOf`（不是"定义了个函数没人用"）。
- 消费链：`board_server.js:258-264` 的 `isVisitor()` → `inventoryPre`（:1176-1182）→ `reserveStock(... visitor: pre.visitor)` / `settleTake(... visitor: pre.visitor)` / `stockIn(... visitor)`。
- **不信客户端自述**：`payload.visitor` 在 board_server 里**0 处读取**（grep 只命中一句注释）。
- 诚实性：`VISITOR_JUDGEMENT_WIRED = false` 透出到 `federation-status.visitorWired`（真 socket 复核为 `false`）。
- t2 的 D 段 + 我 t5 的真 socket 探针都实测：注入 `true` ⇒ reservation 0 / ledger 0 / audit 有行 / events 零增。
- **残留（R6，低）**：注入器**抛错**时 `catch { return false }` —— 静默 fail-open，无 warn。见 §3。

### 2.5 共享取用：预占失败时是否**真的没有取** —— **pass**

逐行（`flow_store.js:378-440`）：
1. `:386` 没板 ⇒ 直接 `fail(..., noBoard:true)`（**在取用之前**）；
2. `:392` 附近没箱子 ⇒ `fail`（之前）；
3. `:399` `resv = await board.inventoryReserve(...)`；`:401-406` 仅在 `INSUFFICIENT_STOCK && known===0` 时**只读观测**（`observeContainers` 只 `containerItems()`，无 `withdraw`）后重试一次；
4. `:407` `if (!resv?.ok) return refuseReservation(item, want, resv);` ← **唯一的早退闸门**；
5. `:409` `const r = await fetchLocal(...)` ← **全函数唯一一次真取**（`grep -n 'fetchLocal('` = 370/409/482，其中 409 在 fetchShared 内，且在闸门之后）；
6. `:412-424` `taken>0` ⇒ `settle(实际 taken)`；`:428-436` `taken===0` ⇒ `release`（还券）。
- 我 t5 的真 socket + 假柜探针：箱子 8→8、背包 0→0、零券零账；变异 M1（去掉这个早退）⇒ 立刻红（12/2），按 sha256 复原。
- 结论：**取与不取由 `resv.ok` 决定，代码里没有第二条"先取了再说"的路径**。

### 2.6 非共享路径是否零行为变化 —— **pass（逐字级）**

- `fetch()`：`export async function fetch(...) { if (isShared(opts)) return fetchShared(...); return fetchLocal(...); }`。
- 原 `fetch()` 体 vs 现 `fetchLocal()` 体：`diff -u` **除函数名那一行外为空**（t5 记录：5337 vs 5342 字符，差 5 = `Local`）。
- `store()`：三处 `return ok(...)` 只多 `...(shared ? { ledger } : {})`；**partial 仍返回 `fail(..., partial:true)`**（没被改成成功）。
- 运行期复核：我 t5 的非共享探针 8→5/背包 0→3，且 `reserve/settle/release/store` **一次都没调**；E2E 53/53 里 chest 场景走同一条老路。

---

## 3. 逐条 finding（8 条，全部不阻塞合并）

| id | 严重度 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| **R2** | low | `flow_store.js:238` | `recordStoreLedger` 在 **账本缺失**时 `delta: Number(r?.data?.ledger?.delta ?? qty)`：访客 store 走 `stockIn` 的 `{ok:true, ledger:null, skipped:true}` ⇒ 这里报 `recorded:true, delta=qty`，**实际一行账都没有**（可读的假成功） | 先判 `r?.data?.skipped === true \|\| !r?.data?.ledger` ⇒ `recorded:false, reason:'visitor' / 'no-ledger'`；不要用 `?? qty` 兜数字 |
| **R6** | low | `board_server.js:263` | `isVisitor` 的 `catch { return false }`：判定器抛错 ⇒ **静默 fail-open**（访客被当普通玩家全额记账），且**无 warn**。今天不可达（`visitorOf` 恒 false），但接凭证后就是"静默降级"的典型形态 | 至少 `console.warn`（与 `recordBoardEvent` 同口径）；更稳的是抛错即拒（fail-closed） |
| **R1** | low（口径） | `board_server.js:1233` | `inventory.settle` 的 payload 用 **`delta`**，而 `reserve/rollback/store` 用 **`qty`**；而 `wiring-board.md` §3 写"store 的 qty = ledger.delta，是 settle 的镜像" ⇒ **字段名不对称，文档读起来像对称** | 统一成 `qty` 并另留 `delta`（或两边都带 `qty`+`delta`）；至少改文档写明 settle 用 `delta` |
| **R3** | low（文档） | `board_server.js:301-306` | 残留一段**过期注释**："在 mindserver 给每只 agent 发独立凭据…（t1 范畴）之前，客户端仍可 hello 成别人的名字" —— 而 6 行之后的 `bindBot`（:363-380）**已经强制** `socket.data.agentName` 对账 + 拒换绑 | 改写该段为"已由 t1 凭据 + `claimAgentChannel` 落地，这里是对账" |
| **R4** | low（文案） | `board_inventory.js:352` | 数量非法用 `C.TOO_MUCH` 表示"必须是正整数"（错误码语义不符） | 换语义更近的已注册码，或在 `reason` 里说明（现状已带 message，影响小） |
| **R7** | info | `global_store.js:206-208` + `web/src/stores/world.ts:45-52` | 只读打开**拒绝建库**（这是对的），但"从未有过 events"的机器上 `events:since` 会走到 `{ok:false, reason:'internal'}` ⇒ 面板 `describeFail` 渲染成「**服务端拒绝了这次读取：internal**」，而真实语义是"还没有事件记录"。三态设计是对的，只是缺第 4 种"服务端没有这个库"的表达 | 把 `GLOBAL_DB_MISSING` 翻成 `no-db`（或直接回 `{ok:true, events:[]}`），面板显示"还没有事件记录" |
| **R8** | info | `federation.js:86/99/440` | `allowPeer` / `revokePeer` / `forgetPeer` **零生产调用方**（只有单测）⇒ 白名单**只能读不能改**；`federation-status.allowedPeers` 因此永远显示"别人写进去的"或空 | 属"已实现但不可达"的同类残留；要么接（三个 socket 事件），要么在文档登记为下一批 |
| **R9** | info | `mindserver.js:2110-2121` | 事件入账是 `void ev(...)`/旁路：写失败只 warn，**调用方无法感知"少了一条账"**。这是本批明示的设计（events.md §11），但"事件完整性"没有任何自动校验 | 若要闭环：面板显示 `events:stats` 与 `inventory_ledger` 的条数差；或定时对账探针 |

> 说明：`R2` 与 `R6` 都属于"失败→看起来成功/权限默认放宽"，但**当前生产不可达**
> （`isVisitor` 恒 false；`shared` 路径无调用方），因此**不构成合并阻塞**，列为下一批顺手修。

---

## 4. 专项：有没有"为让测试变绿而放宽断言"—— **没有**

1. **既有测试只被追加**：`af0b6a5` 对 `tools/inventory_ledger_unit.mjs` 是 **+27 / −0**（新增用例㉒），
   没有改任何已存在的期望值；其余既有测试文件 0 改动（`git show --numstat` 逐提交核过）。
2. **新测试不是自证**：
   - t1 B1 是**阳性对照**（先证明"回执里确实有 token"），否则 B2"日志里没有"可能因为压根没签发；
   - t1 H3 扫磁盘；t2 B1-B5 先**剥注释**再计数（这正是 t1 自己踩过的坑：只判 `includes(...)` 时破坏 R8 照样全绿）；
   - t4 用例⑥ 直接给 `inventoryReserve/Settle/Release` 打桩计数必须为 0（"不调板"是可观测的，不是断言注释）。
3. **变异证据齐全**：本批累计 10（federation）+7（board）+10（events_read）+4（flow）+2（t8 store）= 33 组变异，
   每组都写明"改哪一行 → 哪条用例红"。我自己另加了 2 组（M1 预占失败仍取、M2 访客也写事件），都红后按 sha256 复原。
4. **唯一"文本断言"集中处**（源码断言）都**与真库行为测试并存**：board 的 B 段配 C/D 段（真 sqlite + 真 recordEvent），
   events_read 的源码断言配 44 例真库读写。**没有"只靠读源码就宣布接通"** 的用例。

---

## 5. ④ 的定标（按 captain 裁决，请照抄进验收结论）

> ④「flow_store：先预占再取用」= **机制已验（单测 + 真 socket），生产入口未接**。
> - 已验：`opts.shared===true` 时 reserve→take→settle/release 全链路（真库 + 真 socket + 假柜），失败不取、取不到还券；
> - 未接：`!putInChest/!takeFromChest`（`actions.js:408/420`）与 `!do store/fetch`（`composite_registry.js:125/129`）都不传 `shared`，
>   而 `isShared = opts?.shared === true` ⇒ 生产走 `fetchLocal`。
> - 不写成"已闭环"（生产走不到），也不写成"没做"（机制、文档、测试齐全）。实施路径见 captain 的四步计划。

---

## 6. 残留清单（合并后仍需跟的）

| # | 残留 | 归属 | 触发条件 |
|---|---|---|---|
| 1 | ④ 无生产调用方（`shared`） | 下一批（captain 已给四步路径） | 任何"在共享仓取用"的真实场景 |
| 2 | `isVisitor` 恒 false ⇒ **没有任何连接会被判访客**；访客路径只在测试可达 | 下一批（凭证 ↔ avatar 映射） | 真接入访客凭证时 |
| 3 | `identity.claim`（游戏内 `!claim` 核销）**未写 events** | 下一批（agent 侧 `commands/identity.js`） | 玩家在游戏里核销绑定码 |
| 4 | `federation:grant-redeem` 未接（客机动作） | 下一批（需传输层 + 对端身份） | 真跨机核销 |
| 5 | `allowPeer/revokePeer/forgetPeer` 无调用方 ⇒ 白名单只读（R8） | 下一批 | 需要手工配白名单时 |
| 6 | R2 假成功 / R6 fail-open / R1 字段名 / R3 过期注释 / R4 码语义 / R7 空态措辞 | 下一批顺手修（均 low） | 见 §3 |
| 7 | 真跨机交换（TLS/NAT/时钟偏差）一行未验 | 长期（federation.md §7） | 真跨机部署 |
| 8 | `shared` 路径**从未在真 MC 服上跑过**（E2E chest 是非共享） | 接调用方时补 E2E | 同上 |

---

## 7. 复核方法（可复现）

```powershell
cd mindcraft
# 结构核对
git show --stat 861b82b; git show --stat af0b6a5
grep -n "socket.on('federation\|fedOn('federation\|fedOn('events:" src/mindcraft/mindserver.js   # 应只有 fedOn
grep -rn 'recordEvent(' src/ | grep -v 'export function'                                        # 应只有 2 处
grep -n 'payload.visitor' src/agent/library/board_server.js                                     # 应只有注释
# 我自写的两个复核探针（gitignored，不属产品代码）
node tmp/verify/board_events_positive.mjs    # 正向：8 个 kind 真落 _global（10 PASS）
node tmp/verify/board_reverse.mjs            # 反向：worldIdOf 缺失/访客/预占失败/非共享（14 PASS）
```
