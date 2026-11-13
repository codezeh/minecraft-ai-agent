# P2-4 事件筛选竞态：请求代号（seq）+ 丢弃旧回执

第五轮审查（P2-4 应修）+ t7（四个 loader 的同源竞态，风险等级低于 P2-4，见 §5）。
只改 `web/**`；服务端（`mindserver.js`、`board_*`）、`scripts/**` 未动。

## 1. 缺陷原貌

`web/src/stores/world.ts` 的两个只读入口都是「发请求 → `await` → **无条件**写回视图」：

```ts
const out = await readOnce(...)          // loadEvents()
eventsView.phase = out.phase             // ← 谁最后回来谁说了算
eventsView.events = reset ? rows : mergeEvents(...)
```

```ts
const out = await readOnce(...)          // loadEventStats()
eventsStats.kinds = out.phase === 'ok' ? out.data.kinds : []
```

`EventsPanel.vue` 的筛选下拉（`onWindowChange` / `onKindChange`，原第 24–25 行）每改一次就 `loadEvents(true)`。
用户快速连改两次 ⇒ 两个 `events:since` 同时在飞。回执顺序由网络/服务端决定，
**与筛选的先后无关**：

- 选 `team.create`（请求 #1）→ 马上改选 `inventory.reserve`（请求 #2）；
- #2 先回、#1 后回 ⇒ 视图最终显示 #1 的 `team.create`，
  而界面上的筛选框仍停在 `inventory.reserve`。**"选了 A 却显示 B"**，且不会有任何报错提示。

同一竞态在 `events:stats` 上独立存在（`loadEventStats()`），影响的是过滤下拉里 kind 清单的来源与计数。

这不是"慢一点就好了"的问题：它是**写入没有请求身份**的问题。加防抖只能降低概率，
一旦两个请求都发出（用户连点两次、或第一次超时后重试），错误结果就一定能稳定复现。

## 2. 修复：请求代号（seq）单写者

在 store 里为每个入口各维护一个单调递增的代号；**每次请求取一个新代号**，
回执回来时只有「自己的代号仍是当前代号」才允许写回，否则直接丢弃：

```ts
let eventsSeq = 0
let eventStatsSeq = 0

export async function loadEvents(reset = true): Promise<void> {
  const seq = ++eventsSeq          // 新请求 ⇒ 所有在飞的旧请求（含"继续往后读"）同时作废
  ...
  const out = await readOnce(...)
  if (seq !== eventsSeq) return    // RACE-GUARD：旧回执到达 ⇒ 丢弃，不覆盖新筛选的结果
  ...
}

export async function loadEventStats(): Promise<void> {
  const seq = ++eventStatsSeq
  ...
  if (seq !== eventStatsSeq) return // RACE-GUARD：旧的 events:stats 回执 ⇒ 丢弃
  ...
}
```

时序矩阵（`s1` / `s2` 是两次请求的代号，`s2 > s1`）：

| 到达顺序 | 处理 | 视图最终状态 |
| --- | --- | --- |
| #2 先到，#1 后到 | #2 写回；#1 的 `s1 !== s2` 丢弃 | #2（新筛选） |
| #1 先到，#2 后到 | #1 的 `s1 !== s2` 丢弃（保持 `loading`）；#2 写回 | #2（新筛选） |

两种时序都正确 —— 关键点是**"先到"不等于"该写"**：只要不是最新一代，就不写。
因此 `phase` 也不会被旧回执从 `loading` 提前改成一个过时的结论。

### 为什么箭头不画在组件里

代号放在 store（**唯一写者**）而不是 `EventsPanel.vue`，理由是：

1. 视图状态的唯一写者是 store；组件再判一次 = 同一个规则两份实现，迟早漂（本仓反复出过这类问题）。
2. `eventsView` 是**模块级单例**：两个面板实例、或路由切换后残留的请求，都可能写同一个对象；
   组件内部变量管不到这层。
3. `loadMoreEvents()`（"继续往后读"）走的是同一个 `loadEvents(false)`：它也必须在筛选切换后作废，
   否则旧分页结果会被 `mergeEvents()` **追加**到新筛选的列表里。同一个代号天然覆盖这个分支
   （见下面测试 S6）。

组件侧只留一行说明（`EventsPanel.vue`），行为不变。

同一套机制在 t7 里补齐到 `loadTeams` / `loadTeamChests` / `loadStock` / `loadLedger` / `loadFederation`
（每个入口一个独立代号；共享仓子请求双判据）。那四处的**风险定级低于本条**，理由与实现见 §5。

## 3. 回归测试：模拟乱序回执，并**证明能红**

新增 `web/scripts/world-events-race-unit.mjs`（离线，无需浏览器 / 8080 / 真实服务端）：

- 用 vite 自带的 **esbuild** 把 `src/stores/world.ts` 打包成 ESM，把
  `import { requestRead } from '../api/socket'` 换成**可控回执的假模块** ——
  每个请求的 resolve 时机与内容由测试决定，因此"谁先回、谁后回"是确定的事实，不是碰运气；
- 断言的是**真实模块的导出函数**（不是复制品），跑的是真 `reactive` 状态与真写回逻辑；
- 每行守卫都带标签（`RACE-GUARD teams/chest/stock/ledger/fed/events/stats`），变异体按标签
  **只删指定那一条**，因此能证明断言是**逐条**有效的，而不是"一删全红"：
  1. **真实源码** —— 事件侧 13 项 + loader 侧 14 项必须全绿；
  2. **变异体-events**（删 `events`/`stats` 两行）—— 5 条事件乱序断言必须红，**loader 断言仍全绿**；
  3. **变异体-teams / -chest / -stock / -ledger / -fed**（每个只删自己那一行）—— **只有**它自己那组
     后果断言红，其余 loader 与事件断言**仍全绿**；同时**正向对照**（无并发时正常落库）必须保持绿，
     证明这些绿不是"把功能关掉"换来的。

覆盖的场景（A = 事件筛选 / P2-4，B = 四个 loader / t7）：

| 场景 | 内容 | 删掉对应守卫后的表现 |
| --- | --- | --- |
| A1 | 新回执**先**到、旧回执**后**到 ⇒ 不覆盖 | **红**：列表变回 `team.create` |
| A2 | 旧回执**先**到、新请求还在飞 ⇒ 不落库、仍 `loading` | **红**：`phase=ok` 且列表是旧结果 |
| A3 | `events:stats` 新先旧后 ⇒ 不覆盖统计 | **红**：kinds 变回旧清单 |
| A4 | `events:stats` 旧先新后 ⇒ 不落库、仍 `loading` | **红**：kinds 提前被旧回执填上 |
| A5 | 无并发 ⇒ 正常落库（正向对照） | 绿（所有变体都绿） |
| A6 | 分页旧回执不追加进切换筛选后的新列表 | **红**：`team.create,inventory.reserve` 混在一起 |
| B0 | 无并发 ⇒ `loadStock` 正常落库（正向对照） | 绿（所有变体都绿） |
| B1 | 换 bot 后**旧** `team:list` 回执最后到达 ⇒ 队伍不被覆盖，且**不会再去拉上一队的共享仓** | **红**（两条后果断言）：队伍变回 `teamA`，并多出一次 `team:chest-list(teamA)` |
| B2 | `team:chest-list` 自身乱序：旧队仓库回执最后到达 ⇒ 不覆盖新队仓库 | **红**：`chest.x` 变回 1 |
| B3 | `inventory:snapshot` 旧快照回执最后到达 ⇒ 不覆盖新快照 | **红**：items 变回 `old`、world 变回 `w1` |
| B4 | `inventory:ledger` **反向**时序（旧先到、新后到）⇒ 旧的不会提前落库 | **红**：`ledgerPhase=ok` 且账本是 `old` |
| B5 | `federation-status` 旧回执最后到达 ⇒ 不覆盖新结果 | **红**：grants 变回 `old`、`visitorWired` 变回 false |

运行：`cd web && node scripts/world-events-race-unit.mjs` → `ALL PASS: 20 passed, 0 failed`
（真实源码 13/13 + 14/14 绿；变异体-events 恰好 5 条红；五个 loader 变异体各自恰好红在自己那组，
其它断言全绿）。

## 4. 验证记录（本次实际输出）

| 命令 | 结果 |
| --- | --- |
| `cd web && npx vue-tsc --noEmit` | 退出码 0（无输出 = 0 error） |
| `cd web && node scripts/world-events-race-unit.mjs` | `ALL PASS: 20 passed, 0 failed` |
| `cd web && npm run build` → `node ../mindcraft/tools/sync_web_dist.mjs` | 同步 17 个产物文件 |
| `powershell scripts/release.ps1 -SkipDocker` | `ALL PASS: 8 passed, 0 failed`（含源码/产物指纹写回） |
| `node mindcraft/tools/web_dist_manifest_unit.mjs` | `ALL PASS: 10 passed, 0 failed` |
| `powershell scripts/release.ps1 -VerifyOnly` | `ALL PASS: 8 passed, 0 failed` |

产物指纹（t7 收尾后重建）：`source sha256:ce56f338…`（39 个输入文件）/ `artifact sha256:5f6413eb…`（17 个产物文件）。
MANIFEST 仍由 `scripts/release.ps1` 唯一写出（R6 #50），`sync_web_dist.mjs` 只拷产物。

## 5. 同源竞态：t7 已把四个 loader 一起修掉（**风险等级低于 P2-4**）

t4 当时在 §5 诚实标注过：`loadTeams` / `loadStock` / `loadLedger` / `loadFederation` 也是
"无条件写回"。**t7 已全部补齐**（同一套 `++seq` + 回执比对），不再留"已知同源缺陷"。

### 5.1 为什么把定级压在 P2-4 之下

| | P2-4（事件筛选） | t7（四个 loader） |
| --- | --- | --- |
| 旧回执覆盖新回执时显示的数据 | **与筛选条件不符**（选 `inventory.reserve` 却列 `team.create`） | 仍是**真实**数据，只是可能不是最新（例如库存快照差几秒） |
| 用户后果 | 会据此判断"这些事件发生过"，是**结论错** | 看到的是稍旧的真相，刷新即恢复，**不是假数据** |
| 是否可能持续误导 | 会（列表与筛选框长期不一致） | 一般不会（下一次刷新/操作即覆盖） |

所以这四处按"应修的健壮性问题"处理，而不是按 P1/P2-4 那种"结果错误"处理。

### 5.2 具体编号（**每个入口一个独立代号，绝不共用**）

| 代号 | 覆盖 | 说明 |
| --- | --- | --- |
| `teamsSeq` | `team:list` | 换 bot / 刷新队伍列表 |
| `chestSeq` | `team:chest-list` | 共享仓坐标；**子请求也单独编号** |
| `stockSeq` | `inventory:snapshot` | 库存快照 |
| `ledgerSeq` | `inventory:ledger` | 账本（`limit` 可变，慢请求很容易被后发的超过） |
| `federationSeq` | `federation-status` | 联邦 / 凭证 |

不共用的理由：共用会让"另一个面板的旧回执"误杀"这个面板刚发的新回执"——代号必须与
**被写回的那份状态**一一对应。

`loadTeamChests` 用了**两个判据**，挡的是两件不同的事：

```ts
if (seq !== chestSeq || teamSeq !== teamsSeq) return // RACE-GUARD chest
```

- `seq !== chestSeq`：两个仓库请求乱序 ⇒ 旧的别盖新的（"同一队、后点的那次"赢）；
- `teamSeq !== teamsSeq`：**队伍已经换代**（`loadTeams` 又被调了）⇒ 这个在飞的仓库请求属于上一队，
  无论到达顺序如何都作废 —— 否则会出现"队伍换成 B 了、共享仓还显示 A 队的坐标"。
  这是本任务里唯一一处"旧数据会**张冠李戴**到另一个实体上"的情形，所以单独加了一层判据。

`loadTeamChests` 仍是对外导出的，直接调用时 `teamSeq` 默认取当前 `teamsSeq`
（即"按当前这一代队伍算"），不会因为少传参数就把回执全部误丢。

### 5.3 仍然没做（明确边界，免得被当成已覆盖）

- 代号只裁决**写回**，不取消底层请求：旧 `events:since` / 旧快照仍会飞完（都是幂等只读，
  代价可忽略）。要真取消需要 `requestRead` 支持 `AbortSignal`，属协议改动，不在本轮内。
- 服务端 `events:since` 语义（`at >= since` 宁重不漏、`limit` 夹到 500）未改，与 `fixes4/events.md` 一致。
- 服务端不改：本任务只改 `web/**`，`mindserver.js` / `board_*` / `scripts/**` 一行未动。
