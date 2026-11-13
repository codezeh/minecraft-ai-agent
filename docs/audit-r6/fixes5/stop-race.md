# P1-2：`!stop` 之后待启动票仍开工 —— 修复记录

> 轮次：R6 fixes5（2026-11-13） · 文件域：agent 侧动作槽 / 控制层
> 代码：`mindcraft/src/agent/action_manager.js`、`mindcraft/src/agent/library/control.js`
> 测试：`mindcraft/tools/bot002_action_start_unit.mjs`（19 项 → 39 项）
> 证据：`.agent` 无关，见本目录 `evidence/`

## 1. 缺陷（审查已复现）

BOT-002 那一轮给 `_executeAction` 加了"启动票"（`_launchSeq` / `_pendingLaunch`），
消灭的是**两个动作同时驱动身体**。但票的生命周期只覆盖"被更新的动作取代"这一种结局：

| 时序 | 修复前 | 应有 |
|---|---|---|
| 旧任务 A 正在跑（`executing=true`） | A 在跑 | 同 |
| 新任务 B 进 `_executeAction`：登记票 T → `await stop('brief')` 等 A 退出 | T 挂着 | 同 |
| 玩家 `!stop` → `stop('player')` | 只把 A 标 `paused`，**T 原样挂着** | T 必须作废，B 对应的单也停 |
| A 的 `actionFn` 返回（`executing=false`） | B 醒来：`superseded=false`、`_pendingLaunch===T` ⇒ 认领槽位、`clearBotLogs()` 清掉中断标志 ⇒ **B 照常开工** | B 不许开工 |

纯内存复现（修复前）：

```
first=paused, second=running, secondRan=true
```

复现证据：`evidence/red-1-no-ticket-cancel.txt`（把下面 §3.1 那一行改回去）
—— 4 条 E 用例全红，核心那条正是 `E 等待中的任务没有再开工（secondRan=false） → secondRan=true`。

**为什么"只标当前任务 paused"必然不够**：`_executeAction` 的认领段只认两个判据
（`ticket.superseded`、`this._pendingLaunch === ticket`）。票没被谁作废时，它在这两个
判据上都是"赢家"，而"任务单已 paused"这件事它根本看不见 —— 于是 §3.2 的复核是必需的
第二道门，不是冗余。

## 2. 修复前的第二轮反思：为什么不能"一律作废"

`preempt`（新单抢旧单）时，**新单的票正是在 `stop('preempt')` 的窗口里排队的**：

```
board_scheduler._preempt() → await actions.stop('preempt') → 再 runJobAction(新单)
```

若把 `preempt` 也列入"作废待启动票"，抢占会永远抢不动 —— 修复 A 变成 bug B。
`timeout` 同理：旧动作自己超时，等它退出的新单**应当**接着开工（07 §4 / §5）。
所以作废名单必须**按原因收窄**，而不是按"有没有在等"收窄。

## 3. 修法

### 3.1 玩家停止 ⇒ 作废票（`action_manager.js:14 / :111 / :117 / :183`）

```js
const CANCELLED_PENDING_STOP_REASONS = new Set([STOP_REASONS.PLAYER]);
...
async stop(reason = DEFAULT_STOP_REASON, { exceptTicket = null } = {}) {
    const r = normalizeStopReason(reason);
    this.stop_reason = r;
    if (CANCELLED_PENDING_STOP_REASONS.has(r)) this._cancelPendingLaunch(r, exceptTicket);
```

`_cancelPendingLaunch(reason, exceptTicket)`：

1. `ticket.superseded = true` —— 沿用唯一判据，不另造一套；
2. `ticket.cancelledBy = reason` —— 好让回报说清"是谁撤销的"，而不是骗人的
   "Superseded by a newer action"；
3. `this._pendingLaunch = null`；
4. `pausePendingJob({ agent, jobId: ticket.jobId })` —— 把那张**还没开工**的单也标
   `paused`（`INTERRUPTED` + `checkpoint.pausedReason='player'`），否则它留在 `claimed`
   里，租约照续、别的 bot 也拿不到。

`exceptTicket` 是必须的：`_executeAction` 自己会调 `stop(stopReason)`，若那一轮原因恰好是
`player`，没有这个参数就会**自己作废自己的票**。

**与调度器收尾的配合（已核对，不用改 `board_scheduler.js`）**：被作废的票返回
`{success:false, interrupted:true, message:'Cancelled before start (player)...'}`，
`_runJob` 的 `finally` 里有三道闸——`_preemptedJobId`、`_jobPausedByPlayer()`（读
`actions.stop_reason === 'player'`，本修复正是它）、`_authoritativeStopKind()`——任一中招都
**不许 finish**，所以 `paused` + `INTERRUPTED` 不会被 `finish()` 推回 `ready`；同一时刻
`_shouldRenewLease()` 的"停止原因不是 brief 就不续租"会让 j2 的心跳停手并放租约。

### 3.2 开工前复核任务状态（`action_manager.js:406-416` + `control.js:233`）

票拿到之后、`clearBotLogs()` / `executing=true` 之前（**同一段同步代码，没有 await**）：

```js
const gateJobId = isJobLabel(actionLabel) ? (ticket.jobId ?? null) : null;
const blocked = pendingJobBlocked({ agent: this.agent, jobId: gateJobId });
if (blocked) return { success: false, message: blocked, interrupted: true, timedout: false };
```

`control.pendingJobBlocked()` 是纯逻辑（读 `board.get()` 的**同步镜像**，见
`board_client.js:20`）：`paused / cancelled / failed / blocked / done` → 拒绝开工，
其余（含 `ready`）放行。**不列 `ready`**：领单后镜像可能还没刷成 `claimed`，
把 `ready` 也拦掉会凭空拒掉合法开工。

**只核"任务单自己的票"**：mode / 即时命令的票也会带 `currentJobId`（`runJobAction` 的
`finally` 还没跑），照抄去核会把玩家随后的 `!follow` 一起拒掉 —— 那是回归不是修复。
这条范围由 `isJobLabel(actionLabel)` 划出，用例 `I` 专门盯它
（改回 `ticket.jobId` 必红：`evidence/red-3-gate-scope.txt`）。

### 3.3 停止原因矩阵（修复后）

| 原因 | 作废待启动票 | 待启动单 | 理由 |
|---|---|---|---|
| `player`（`!stop` / `!stay`） | **是** | `paused`（`INTERRUPTED`）+ 暂停自动领单 | 玩家以为已经停了，身体不许再开动 |
| `preempt` | 否 | 保持 | 抢占语义：票就是新单自己的，作废它 = 抢占失效 |
| `timeout` | 否 | 保持 | 旧动作超时后新单应当开工（07 §4 重试/轮转） |
| `brief` | 否 | 保持 | 反射/即时命令打断，单子仍在本 bot 手里 |
| `shutdown` | 否 | 保持 | 进程要退了，票随进程消亡 |
| `death` | 否 | 保持 | 复活后续做，由 07 §7 的死亡路径管 |

### 3.4 `control.js` 新增两个纯逻辑函数（`control.js:225 / :233 / :254`）

- `pendingJobBlocked({ agent, jobId })` → `string|null`：能不能开工；无板 / 读不到 ⇒ 放行
  （宁可让她干，也不要凭"看不见"判死）。
- `pausePendingJob({ agent, jobId, now })` → 复用 `applyStop(PLAYER)`；**已经进终态的单
  不重写**（连按两次 `!stop` 不许冲掉第一次的 `pausedReason` / `result.at`）。

## 4. 验证

| 用例 | 断言 | 结果 |
|---|---|---|
| A/B/C/D（原有 19 项） | BOT-002 取代语义、D18 僵尸、resume、槽位干净 | 全绿，未回归 |
| E（8 条） | `!stop` 同步作废票；`secondRan=false`；单被 paused；自动领单双关；`maxConcurrent=1` | 全绿 |
| F（6 条） | `paused` / `cancelled` 两种单都被开工前复核拒绝，且槽位干净 | 全绿 |
| G（3 条） | `preempt` 的新动作照常开工、旧单回 `ready` | 全绿 |
| H（2 条） | `timeout` 后等待中的新单照常开工、attempts+1 回 ready | 全绿 |
| I（1 条） | 单被暂停时即时命令不被误拒 | 全绿 |

- 绿：`evidence/green-after-fix.txt` → `ALL PASS: 39 passed, 0 failed`
- 红 1（§3.1 改回去）：`evidence/red-1-no-ticket-cancel.txt` → `secondRan=true`，4 红
- 红 2（§3.2 复核改回去）：`evidence/red-2-no-job-recheck.txt` → `ran=true`，4 红
- 红 3（§3.2 范围改回 `ticket.jobId`）：`evidence/red-3-gate-scope.txt` → `!follow` 被误拒，1 红
- 门禁：`evidence/gate.log` → `npm run gate` **exit 0**（`no-undef = 0 · no-floating-promise = 0`，扫 187 个文件）。
  期间有一次红点 `src/mindcraft/mindserver.js:810 no-undef 'knownAgent'`，属 **P1-1 那条线**的在改文件
  （本轮其余成员正在重写该文件，当时未落定），与本 task 无关；该文件落定后门禁转绿，即为本记录里的最终结果。
- 全量离线单测：`evidence/unit_all-final.log` → **159/159 个脚本通过，5 个跳过**（无回归）。

## 5. 已知边界（不假装修完了）

1. `_cancelPendingLaunch` 用的是**票登记时**的 `currentJobId`。它不是新动作自己的单时
   （mode 票 → 正在跑的那张单）也照样暂停它 —— 玩家按停时这恰好是对的，但语义上算
   "顺手"，不是精确归因。
2. 票作废与"单已 paused"之间仍有极窄窗口：`!stop` 落在 `_pendingLaunch=null` 之后、
   `executing=true` 之前的**同步段**是不可能的（JS 单线程、中间无 await），所以窗口只剩
   "`!stop` 在票被认领之前到达但任务板镜像还没刷新"这一种 —— 那时由 §3.2 的复核兜住
   （镜像是同步读的本地对象，写入在 `applyStop` 里同步完成，实际不会发生）。
3. 复核只看任务板**本地镜像**；镜像滞后 = 放行。这是刻意选的失败方向（宁可开工也不误拒）。
4. `pausePendingJob` 依赖 `board.get(jobId)` 读得到那张单。镜像里还没有它时（刚领单、
   `board:changed` 未到）**不会暂停**，但该动作仍被"票作废"拦住开工 —— 失败方向是
   "单留在 `claimed` 里空等到租约过期"，不是"身体又动了"。
5. `tools/` 的 lint 棘轮当前 +9（`require-await` 8 / `no-control-regex` 1），来源是 HEAD 上
   `vault_import.mjs` 等**本轮未修改**的文件（基线 2026-11-08 早于 tools/ 的后续提交）；
   本轮新增/改动的 tools 文件对棘轮新增 **0**。它不在 `npm run gate` 里，另案处理。

---

## 6. 与调度器收尾的配合（实现者中断前最后核对的一条，captain 补记）

**问题**：本次修复让"等待中的票被作废"，但被作废的任务 j2 本身已经在 `_runJob` 里跑过
（心跳已起、租约已拿）。如果它的 `finally` 照常收尾，会不会把 paused 状态覆盖掉、或者把租约漏掉？

**核对结果（代码路径，不是推测）**：
- 调度器的 finish 路径**已经拒绝覆盖** `paused-by-player` / `preempted` 状态；
- `_jobPausedByPlayer` 的判据是 `actions.stop_reason === 'player'` —— 本次玩家停止正是写这个值；
- 所以 j2 的 `finally` 会走 `pausedByPlayer === true` ⇒ **跳过 finish**，不会把 paused 改回别的状态；
- 租约：`_shouldRenewLease` 只在"本 run 开始后 stop_reason 才变"时停止续租；玩家停止发生在 j2 的 run
  开始之后 ⇒ 不续租 ⇒ 心跳停 ⇒ `_releaseOnStop` 按 kind=paused 释放租约与预占。

**结论**：新行为与既有收尾逻辑**组合正确**——停在 paused、租约释放、单不空留在 claimed。
这一点在 `bot002_action_start_unit` 的 E 组有断言（`state !== 'claimed'`、`secondRan=false`），
且把作废逻辑禁用后 E 组 4 条全红（`secondRan=true`、`state:"claimed"`），与审查报告现象一致。

> 记这一节的原因：**"新逻辑与旧收尾的组合"是最容易出事的地方** —— 两边单独看都对，
> 合起来可能互相覆盖。实现者在中断前正是查到这一步，值得留下来。
