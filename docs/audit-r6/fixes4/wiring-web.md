# 生产接线 ③：面板只读视图（队伍 / 库存 / 事件 / 联邦）

> R6 / fixes4 · 2026-11-13 · 任务 **t3**（成员 `wire-web`）
> 改动面：**只有 `web/**`**（源码 8 个文件 + 重建产物 `mindcraft/web-dist/**`）+ 本文件
> 新增页面：`/world`（导航名「存档」），4 个标签页
> 上游依赖：`wiring-control.md`（`federation-status`）、`wiring-board.md`（`team.*`/`inventory.*` 事件）、
> `events.md`（events 语义）、`inventory.md`（券生命周期）、`team.md`（按存档的队伍表）、`federation.md`（凭证）
> 下游：**t7**（`wire-control` 在 `mindserver.js` 接 `events:since`/`events:stats`，本文件 §5 是那份契约）

---

## 0. 一句话 + 三条边界

一句话：把「队伍 / 库存 / 事件 / 联邦」四块**已经存在但面板里完全看不到**的存档数据接进控制台，
全部**只读**，并且对每一种"看不到"都给出**能被区分的**原因（没接 / 被拒 / 真的没有）。

必须同时读到的三条边界（别把它读成"面板能管这些了"）：

1. **零写能力**：本页**不**建队/加入/离队、**不**预占/结算/释放/对账、**不**签发/核销凭证、
   **不**写事件。四个标签页调的都是纯读事件（§2 的表里逐个列出）。
2. **库存不按队**：`inventory_*` 表**没有队伍维度**（`board_store.js` 建表段可见），
   所以「某队共享仓的物品清单」在数据层不存在 —— 面板按**存档**展示，并把「容器坐标是否本队共享仓」
   作为唯一交叉点如实标注（§4）。
3. **事件视图依赖 t7**：`events:since` 是本轮新增的服务端只读入口（t7）。
   面板按契约实现完毕，服务端接上即出数；**未接时显示"暂不可用"，绝不伪造时间线**（§5）。

---

## 1. 改动清单

| # | 文件 | 内容 | 行数 |
|---|---|---|---|
| 1 | `web/src/api/socket.ts` | 新增 `requestRead()`：**只读**请求，超时可调（默认 6s），断线**不 emit** 直接 `OFFLINE`（与 WEB-001 同口径） | +26 |
| 2 | `web/src/api/types.ts` | 手抄服务端契约类型：`TeamRow/TeamMemberRow/TeamChestRow`、`StockItemRow/StockContainerRow/ReservationRow/LedgerRow`、`VisitGrantRow/KnownPeerRow/AllowedPeerRow/FederationStatusResult`、`GlobalEventRow` | +135 |
| 3 | `web/src/api/time.ts` | 新：`fmtTime / fmtAgo / fmtWindow`（绝对时间 + 相对时间分开，预占到期要能自己走） | 44（新） |
| 4 | `web/src/stores/world.ts` | 新：四块只读数据 + 三态语义（`ok`/`error`/`not-wired`）+ 事件分页 + `payloadText()` 敏感字段剥离 | 436（新） |
| 5 | `web/src/views/WorldView.vue` | 新：标签页宿主（`?tab=` 记状态），顶端显示存档 id / 当前 bot / 连接态 | 97（新） |
| 6 | `web/src/components/world/TeamPanel.vue` | 队伍列表 + 成员 + 本 bot 所在队 + 本队共享仓坐标 | 144（新） |
| 7 | `web/src/components/world/StockPanel.vue` | 物品（已知/预占/可用）+ 预占中（holder/qty/到期倒计时）+ 容器与待对账 + 账本与对账差异 | 269（新） |
| 8 | `web/src/components/world/EventsPanel.vue` | 事件时间线（时间窗 + kind 过滤 + 游标翻页） | 146（新） |
| 9 | `web/src/components/world/FederationPanel.vue` | 凭证（待用/已失效，**不含 token**）+ 已知 peer + 白名单 + `visitorWired` 现状 | 200（新） |
| 10 | `web/src/router.ts` | `/world` → `WorldView`（懒加载，`meta.label='存档'`） | +7 |
| 11 | `web/src/App.vue` | 导航项「存档」（label 与 `router.ts` 的 `meta.label` 一致） | +2 |
| 12 | `mindcraft/web-dist/**` | 重建产物 17 个文件 + `MANIFEST.json`（**唯一写者是 `scripts/release.ps1`**，R6 #50） | 重建 |

**没动的**：`mindserver.js`、`board_server.js`、`board_*`、`flow_store.js`、`global_store.js`、
`federation.js`、`mindcraft/src/**` 的任何一行；`web-dist` 以外的产物；`MANIFEST.json` 没有手改过（跑脚本写的）。

> 模板里为什么没有「写」按钮：不是漏了，是**本任务的全部要求都是只读**。要写去任务板（`board:*` 已有入口）/
> 设置（`set-agent-settings`）/ 凭据页。四个标签页各调过一遍事件清单见 §2，一眼可查。

---

## 2. 四个视图：数据源 / 字段 / 空态

### 2.0 三态语义（**这一节是本页的地基**）

面板不能把三种"空"说成一句话，否则用户会以为"功能坏了"或"数据满了"：

| 状态 | 怎么判定 | 界面说什么 |
|---|---|---|
| `ok` | 收到 `{ok:true, …}` | 正常渲染；列表为空时**明说"服务端回了空列表"**（= 真的没有） |
| `error` | 收到 `{ok:false, code, reason}` | 服务端明确拒绝：`NO_BOARD`→"没解析出存档维度（未启用）"、`NO_PERMISSION`→原样带 reason（§2.1 实测那句） |
| `not-wired` | 事件发出后**没有回执**（超时） | "服务端没有回应 X（大概率没接这个只读入口；**不是"没有数据"**）" |

实现：`web/src/stores/world.ts` 的 `readOnce()`（唯一入口，不抛，视图只消费 `{phase, message, reason, data}`）。

### 2.1 队伍（`team:list` / `team:chest-list`）

| 项 | 来源 | 面板怎么用 |
|---|---|---|
| 队伍列表 | `team:list` → `{ok, teams[], worldId}` | 一行一队 |
| 成员 | 同上 `teams[].members[] = {avatar_id, role, joined_at}` | 徽标显示；`role` 翻成「队长/队员」 |
| 共享仓**数量** | 同上 `teams[].chests` | 只显示数量（坐标要另读） |
| 共享仓**坐标** | `team:chest-list {bot, teamId}` → `{ok, team, chests[{x,y,z,added_by,added_at}]}` | **只展开当前 bot 所在队**；其它队显示数量 |
| 当前 bot 属于哪个队 | 客户端匹配 `members[].avatar_id === currentAgent.name` | 行高亮 + 「本 bot 在此」 |

* 服务端只允许**队员**看坐标（`listTeamChest` 里 `team_member` 校验），所以面板对非本队**不发请求**，
  并在页脚写清"坐标只有本队可见"，而不是显示一个空表让人以为没数据。
* 面板读坐标时必须报 `bot`（服务端 `actingBot()` 走 panel 分支放行"自报名字"）——
  这是**已知边界**：`online-mode=false` 下名字是自报的，面板挡不住冒名。写进页脚，不假装是鉴权。
* 顶部**切换 bot** ⇒ 本页自动重读（`watch(currentAgent)`）：否则"本 bot 所在队"会停留在上一只 bot 的队伍上，
  那是**假信息**，比不显示更糟。

### 2.2 库存（`inventory:snapshot` / `inventory:ledger`）

| 项 | 来源字段 | 面板怎么用 |
|---|---|---|
| 物品清单 | `items[] = {item, known, reserved, available}` | 表：已知/预占/可用；**`available<0` 高亮**并解释"预占超过已知" |
| 预占中 | `reservations[] = {id, item, qty, holder, expires_at, status, …}`（服务端只回 `status='held'`） | 表：holder/qty/到期（**每秒倒计时**，`clock` 驱动）/建立时间 |
| 容器 | `containers[] = {x,y,z,items:{name:n},updated_at,dirty}` | 坐标 + 内容摘要 + 最近观测 + 「待对账(dirty)」/「本队共享仓」标记 |
| 读取时作废的过期券 | `expired` | 头部"N 张"（**是 id 数组**，见 §6.2 的实测教训） |
| 最近账本 | `inventory:ledger {limit}` → `entries[{id,item,delta,holder,reason,at}]` | 倒序表；可按 `reason` 过滤 |
| 对账差异 | 账本里 `reason='reconcile'` 的行 | 单独计数 `对账差异 N`；行用 `warn` 色 |

> 「本队共享仓」这个标记要用队伍坐标，所以**直接从库存页打开**时会补读一次队伍（`teamView.phase==='idle'` 才补，
> 已在队伍页读过就不重复请求）。不补读的后果是标记静默消失 —— 那会让人以为"这些容器不属于本队"。

### 2.3 事件（`events:since` / `events:stats`）—— 见 §5

### 2.4 联邦（`federation-status`）

| 项 | 来源字段 | 面板怎么用 |
|---|---|---|
| 凭证 | `grants[]`（白名单 10 字段：`grantId/hostId/guestId/issuedAt/expiresAt/maxUses/usedCount/usedAt/revokedAt/note`） | 拆两栏：**待用** / **已失效**；状态客户端算（作废>用尽>过期>待用） |
| 已知 peer | `knownPeers[] = {peerId, lastAddr, firstSeen, lastSeen, cardSeq}` | 表（**没有公钥**） |
| 白名单 | `allowedPeers[] = {peerId, addedAt, note}` | 表 |
| 访客判定 | `visitorWired` | 顶部一行：`false` ⇒ "未接线（现在不会有人被判成访客）" |

---

## 3. 只读怎么保证的（不是"没写按钮"就算）

1. **只调读事件**：`team:list`、`team:chest-list`、`inventory:snapshot`、`inventory:ledger`、
   `federation-status`、`events:since`、`events:stats` —— 7 个，全部无副作用。
   *`team:chest-list` 是"读"，但它要 `bot` 参数，服务端会做成员校验*。
2. **没有任何写调用**：全文件 grep 不到 `board:set-state`/`board:add`/`inventory:reserve|settle|release|reconcile`/
   `federation:grant-issue|revoke` —— 这些词的唯一出现处是**别人的** store（`stores/board.ts` 有 cancel/retry）。
3. **面板连接也不是"什么都能读"**：`events:since`/`federation-status` 都挂在 `fedOn`（`requirePanel`）后，
   **agent 身份的连接会被拒**（真机实测：`{ok:false, event:'events:since', reason:'panel_only', role:'agent'}`）。
4. **读超时短**：`requestRead` 默认 6s（控制面是 15s/8s）。理由：只读视图"没有回执"就该早点说，
   而不是让人盯着转圈以为是网络卡 —— 但**绝不**把超时当成功（`not-wired` 是一种明确的失败态）。

---

## 4. 两条必须写下来的"数据层事实"（否则面板会撒谎）

### 4.1 共享库存**按存档**，不按队

`board_store.js` 的 `inventory_reservation / inventory_ledger / container_cache` 三张表只有
`world_id`，**没有 `team_id`**；队伍与容器的唯一关联是 `team_chest(world_id, team_id, x, y, z)` 的坐标。
所以：

* 物品清单/预占/账本 = **整个存档**的共享库 → 页面标题与页脚都写明"按存档"；
* 「本队」只体现在**容器行的标记**上（坐标落在 `team_chest` 里 ⇒ 打「本队共享仓」标）；

要做"按队的库存"，必须先改表结构（`inventory_*` 加 `team_id`）并重新定义预占/结算语义 ——
那是**产品/领域决策**，不是面板接线，本轮**没有**做，也**没有**用"按队"的文案假装做了。

### 4.2 「对账差异」只能来自账本里的 `reconcile` 行

真正的账实差异需要**开箱观测**（`inventory:reconcile` 的 `observations` 只能由客户端上报）。
**面板没有开箱能力**，所以：

* 面板**不调** `inventory:reconcile`（连 `dryRun:true` 也不调）：拿缓存当观测去对账，必然算出
  "差异 0"，那是**自己跟自己比**的假绿；
* 面板显示的是**已经发生过的差异**：账本里 `reason='reconcile'` 的 `delta` 行（服务端只把真实差额写账）；
* 「待对账」= `container_cache.dirty=1`（上次取用结果不确定），这是**待办**不是**差异**，文案分开写。

---

## 5. 事件视图：契约、两种空态、分页、脱敏

### 5.1 契约（本轮与 t7 对齐的**唯一真相**）

```text
events:since  { since?: number | {at:number,id:string}, kind?: string, limit?: number, worldId?: string }
           →  { ok:true, events:[{id, worldId, avatarId, kind, payload, at}], count, limit }
           →  { ok:false, reason:'since-invalid' | 'kind-invalid' | 'limit-invalid' | 'internal' }

events:stats  {} → { ok:true, kinds:[{kind, count, firstAt, lastAt}] } | { ok:false, reason:'internal' }
```

* `since` 是**毫秒**（`at >= since`，**含边界 ⇒ 会重复**，面板按 `id` 去重）或 `{at,id}` 元组（严格 `>`）；
* `limit` 服务端**夹到 500**（默认 200）：面板发 200，并**不假设**一次取完 —— 满页就显示"可能还有"，
  继续用最后一行的 `{at,id}` 当游标往后翻（真机实测 `limit:100000` ⇒ 回执 `limit:500`）；
* `payload` 是**已解析的对象**（解析失败服务端给 `null`）⇒ 面板**不二次序列化**；
* 面板认的 4 个 `reason` 字面量与 t7 实现逐字一致（`since-invalid/kind-invalid/limit-invalid/internal`），
  探针会从**面板源码**里解析这几个字符串并与服务端实测对齐（§6.3 破坏 #2 能红）。

### 5.2 两种"空"必须是两句话（captain 2026-11-13 明确要求）

| 情形 | 判定 | 文案 |
|---|---|---|
| 服务端**没有**这个事件 | 发出去**没回执**（`UNKNOWN_RESULT`） | 「服务端未接 events:since，事件视图暂不可用（面板这边已就绪，服务端接上即出数）」 |
| 服务端有、但这次**被拒** | `{ok:false, reason}` | 「服务端已接 events:since，但这次读取被拒：<原因>」 |
| 服务端有、**没有记录** | `{ok:true, events:[]}` | 「<时间窗>里还没有事件记录（不是"功能没做"：服务端回了空列表）」 |

> 第三句是我加的：把 `{ok:false, reason:'kind-invalid'}` 也说成"未接"会是假话 ——
> 服务端明明接了，只是我这次参数不合法。三句话各自对应一个**可复现的**判定，别合并。

### 5.3 不显示 token / hash（两层）

1. **服务端**：写事件时只落标识（`wiring-control.md` §4/§8），`federation-status` 走白名单拷贝，
   库里只存 `sha256(token)`；
2. **面板**：`payloadText()` 按字段名再剥一层（`token|secret|passwd|password|hash|sha256|pubkey|private|signature|sig`），
   命中就显示「（已隐藏）」；超 300 字符截断并标注。

真机实测（§6.1）：`federation-status` 的整段 JSON 里**搜不到**刚签发的那张 token；
grant 行的字段集就是那 10 个白名单字段。

---

## 6. 证据（可复跑）

> 探针脚本是**临时文件**（`mindcraft/tmp/wiring_web_probe.mjs`，`tmp/` 已在 `.gitignore` 里），
> 故意不塞进 `tools/`：本任务的交付面是 `web/**`，探针只是**这一轮**的取证方式，
> 长期留档应做成正式单测（建议后续 `tools/web_panel_read_unit.mjs`，见 §8）。

### 6.1 真机探针：58/58 PASS

环境：**真 `createMindServer(false,0)` + 真 socket.io 面板客户端（token 走 Cookie）+ 真 SQLite 板库/全局库**，
全程 127.0.0.1，`MC_BOTS_ROOT`/`MC_WORLD_DIR`/`MC_SERVER_DIR` 全指临时目录（不碰生产库、不覆盖生产 token）。

```bash
cd mindcraft && node tmp/wiring_web_probe.mjs      # ALL PASS: 58 passed, 0 failed（exit 0）
```

覆盖（节选，全部是**字段级**断言，不是"不报错"）：

* `team:list`：`ok/worldId/teams[1]/members[2]`、成员字段 `avatar_id|role|joined_at`、`chests=1`；
* `team:chest-list`：坐标 `10,64,-20`、`added_by/added_at` 齐全；**非成员 ⇒ `NO_PERMISSION`**（面板据此说"被拒"）；
* `inventory:snapshot`：`items` 有 `known/reserved/available`、`reservations` 含 `held` 行
  （`holder/qty/expires_at`）、`containers` 带 `dirty`、`expired` 是**数组**；
* `inventory:ledger`：`reason` 同时出现 `take` 与 `reconcile`（面板"对账差异"的数据来源）；
* `federation-status`：`visitorWired===false`、grant 行字段 = 白名单 10 个、**无 `token/token_sha256/pubkey`**、
  整段 JSON 里 grep 不到刚签发的 token；
* `events:since`：≥4 条、行字段齐、`payload` 是**对象**、带 `worldId`、按 `kind` 过滤生效；
  `since:'nope'` ⇒ `since-invalid`；`kind:'bogus.kind'` ⇒ `kind-invalid`；`limit:100000` ⇒ 回执 `limit:500`；
* `events:stats`：`kinds[]` 带 `count/firstAt/lastAt`；
* **反向**：`registerCredential(token,'agent')` 的连接读 `events:since`/`federation-status` ⇒
  `{ok:false, reason:'panel_only', role:'agent'}`；同一面板 token 换 `auth.token` 携带 ⇒ 身份**不变**（仍可读，R6 #2）。

### 6.2 探针**抓到的面板 bug**（这就是为什么要真机跑）

`inventory:snapshot` 的 `expired` 返回的是 **`voidExpired()` 的 id 数组**（`["<uuid>"]`），不是数量。
面板第一版按数字写：`Number(expired ?? 0) || 0` ⇒ `Number([])=0`、`Number(['x'])=NaN||0=0` ⇒
**刚作废了 1 张券也会显示"0 张"**（对用户是可读的谎话）。已改：类型 `string[]`，界面按 `.length` 显示，
并由探针钉住"数组且包含刚过期那张券的 id"。

### 6.3 反向验证：4 处破坏**都能红**（改完即复原）

| # | 破坏 | 结果 |
|---|---|---|
| 1 | `'inventory:snapshot'` → `'inventory:snapshott'`（拼写） | `HAS FAILURES: 51/7` —— 契约断言 + snapshot 全部断言红 |
| 2 | `EVENTS_PARAM_REASONS` 去掉 `'internal'` | `57/1` —— reason 对齐断言红 |
| 3 | `team:chest-list` 的 `{ bot: … }` → `{ avatar: … }` | `57/1` —— "传的是 bot"断言红 |
| 4 | `{ since, limit: … }` → `{ since }` | `57/1` —— events 载荷断言红 |

> **关键设计**：探针里的 7 个事件名**是从 `web/src/stores/world.ts` 源码里解析出来的**，
> 不是我另抄一遍 —— 否则面板里把 `events:since` 打成 `events:sinces`，探针会全绿（"假绿"）。
> 破坏 #1 就是这条设计的实测证明。

### 6.4 产物级证据（构建物里真的有这些调用）

```bash
cd mindcraft/web-dist && grep -c "events:since\|team:chest-list\|inventory:snapshot\|federation-status" \
  assets/WorldView-*.js
```
`WorldView-*.js` 里逐个命中：`team:list`、`team:chest-list`、`inventory:snapshot`、`inventory:ledger`、
`federation-status`、`events:since`、`events:stats`、`visitorWired`、**两句空态文案**
（「服务端未接 events:since」「还没有事件记录」）；入口 chunk 里命中导航 label「存档」。

---

## 7. 门禁（全部 0 / 满分）

```bash
cd web && npx vue-tsc --noEmit                       # 0 error（exit 0）
cd web && npm run build && node ../mindcraft/tools/sync_web_dist.mjs
powershell scripts/release.ps1 -SkipDocker           # 8/8 ALL PASS（MANIFEST 由它写，R6 #50）
node mindcraft/tools/web_dist_manifest_unit.mjs      # 10/10 ALL PASS
powershell scripts/release.ps1 -VerifyOnly           # 8/8 ALL PASS（产物=清单=源码三方一致）
```

> 顺序有讲究：`sync_web_dist.mjs` **不写** `MANIFEST.json`（它自己会打印"唯一写者是 release.ps1"），
> 所以改完 `web/**` 必须让 `release.ps1` 跑一次，否则 `web_dist_manifest_unit` 的**源码指纹**那条会红
> （那正是 R6 F1 加进来的漂移护栏，别绕）。

---

## 8. 缺口 / 需要转出去的事

| # | 事 | 现状 | 建议落点 |
|---|---|---|---|
| 1 | `events:since` / `events:stats` | **t7 已接线**（本轮真机实测通过）。本轮之前它是"实现齐全但零调用方" | 已闭环 |
| 2 | `identity.claim` 不写事件 | t1 已登记（游戏内 `!claim` 在 agent 子进程，mindserver 侧没有收口点）⇒ **事件视图里会缺"身份核销"这一条**。用户可能会问"我在游戏里 claim 了为什么时间线没有" | agent 侧（`src/agent/commands/identity.js` 的 `!claim` 成功分支） |
| 3 | 库存按队 | 数据层没有 `team_id`（§4.1）。要"按队看库存"必须先改表 + 重定义语义 | 产品/领域决策，**不建议**在下个"接线"任务里顺手做 |
| 4 | 面板读坐标靠 `bot` 自报 | `actingBot()` 的 panel 分支放行自报名字（`online-mode=false` 下可冒名）。只读视图风险低，但**别**把它当鉴权 | 已写进页脚 + 本节；根治在身份/传输层（federation.md §9） |
| 5 | 探针没有正式单测化 | 目前是 `mindcraft/tmp/wiring_web_probe.mjs`（临时文件，`tmp/` 已 ignore） | 建议做成 `tools/web_panel_read_unit.mjs` 纳入门禁（需要改 `tools/**`，不在本任务范围） |

---

## 9. 明确**没有**做的事（别读成"已实现"）

* **没有**任何写操作入口（建队/预占/结算/释放/对账/签发/核销全都不在面板里）；
* **没有**做「按队」的库存视图（数据层不支持，见 §4.1），也没有用"按队"的文案混淆；
* **没有**替用户对账（不调 `inventory:reconcile`，连 dryRun 都不调，见 §4.2）；
* **没有**展示 token/hash/公钥，也没有"点一下显示 token"的开关（凭证明文只在签发那一次的回执里，面板不缓存）；
* **没有**改 `mindserver.js`/`board_*`/`flow_store.js`/`global_store.js`/`federation.js` 一个字节；
* **没有**新增依赖（`time.ts` 是手写格式化，不引 dayjs/luxon）；
* **没有**新增路由之外的路由表改动（`/world` 一个，标签页用 `?tab=` 而不是四个路由）。
