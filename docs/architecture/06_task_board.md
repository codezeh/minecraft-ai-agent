# 任务板（Task Board）：个人任务与多人任务

> 2026-11-01 新增，吸收了原计划的 `06_task_queue.md` 和 `07_multi_bot.md`。

## 1. 先分清两个词

| 词 | 是什么 | 例 |
|---|---|---|
| **任务单**（job） | **数据**：谁、做什么、优先级、做到哪了 | "bot A 采 32 个橡木，已采 12" |
| **复合技能** | **代码**：怎么做（[`04_skills.md`](04_skills.md)） | `flow_collect` |

任务单通过 `skill` 字段引用一个已注册的复合技能。复合技能**不知道**任务单的存在，只通过 `ctx` 读写 checkpoint、预约资源。
之后文档里"任务"只指任务单；代码里的 `task_*.js` 在 Phase R 改名为 `flow_*`。

## 2. 为什么单个 bot 也需要

现在 bot 要做的事只存在两个地方：模型的对话上下文，和 `action_manager` 正在跑的那一个动作
（外加一个不落盘的 `resume_func` 槽，`action_manager.js:10`）。所以：

| 问题 | 现状 |
|---|---|
| 重启、断线、死亡 | 正在做的事和进度全丢 |
| 玩家说"先砍树再挖矿" | 没有队列，只能靠模型记得 |
| 自保 mode 打断了采集 | 打完要不要回去接着采，没地方记 |
| 做到一半 | 没有进度，面板和模型都看不到"12/32" |

有了多个 bot 再加两条：**谁做哪张单**（分工），**别两个 bot 砍同一棵树**（防撞）。任务板一次解决这六条。

## 3. 放在哪

**放在 mindserver 进程里**，用 `node:sqlite` 落盘（`terrain3d.js` 已经在用同一个库），文件 `bots/_board/board.sqlite`。

理由：每个 agent 是独立子进程（`src/process/agent_process.js:26` spawn），彼此只能经 mindserver 的 socket 通信。
任务板放在 agent 里，别的 bot 看不到；放在 mindserver，**只有一个进程写库**，不用处理多进程锁。

| 模块 | 进程 | 职责 |
|---|---|---|
| `board_store.js` | mindserver | 任务单与预约表的增删改查，唯一写库的地方 |
| `board_server.js` | mindserver | socket 事件：`board:add / claim / heartbeat / progress / finish / list / cancel / reserve / release` |
| `board_client.js` | agent | 上面这些事件的薄封装，返回 `ActionResult` |
| `board_scheduler.js` | agent | 空闲时领单、交给 `action_manager` 执行、续租、回报 |
| 面板「任务板」页 | web | 看板、手动派单、拖拽改优先级 |

## 4. 任务单长什么样

```js
{
  id: 'j_20261101_0012',
  kind: 'personal' | 'shared',      // 个人单：只有 assignee 能领；多人单：进池子，符合 requires 的都能领
  parentId: null,                   // 拆单时子单指向父单
  title: '采 32 个橡木',             // 给面板和模型看的人话
  skill: 'collect',                 // 必须是注册表里的复合技能（04 §4）
  args: { names: ['oak_log'], want: 32 },   // 按 manifest.params 校验
  why: '为了 strat_obtain(iron_pickaxe)',   // 策略派生的单必填
  priority: 6,                      // 0–9，见 §7
  source: 'player:<name>' | 'llm' | 'strat:<jobId>' | 'panel',
  assignee: 'deepseek' | null,      // 个人单必填；多人单领取后填
  requires: { roles: ['miner'], items: ['stone_pickaxe'] },  // 多人单的领取资格
  claims: ['area:120,64,-30:16'],   // 开工前要预约的资源（§9.2）
  dependsOn: ['j_..._0011'],
  state: 'pending' | 'ready' | 'claimed' | 'running' | 'paused' | 'blocked' | 'done' | 'failed' | 'cancelled',
  attempts: 0, maxAttempts: 3,
  lease: { owner: 'deepseek', until: 1730430000000 },
  progress: { count: 12, want: 32 },
  checkpoint: {},                   // 复合技能自己定义的续做数据
  result: null,                     // 结束时的 ActionResult
  createdAt, updatedAt,
}
```

## 5. 生命周期

```
pending ──依赖都 done──► ready ──领单──► claimed ──开工──► running ──┬─ ok 且 count≥want ──► done
                           ▲                                        ├─ 失败且 attempts<max ──► ready（attempts+1）
                           │                                        ├─ 失败且 attempts=max ──► failed
                           ├──────────── 租约过期（保留 checkpoint）─┤
                           └──────── resume ── paused ◄── 被抢占 / 玩家喊停
依赖 failed ──► blocked（等父单或来源决定：补单 / 取消）
```

## 6. 规则

| 规则 | 内容 |
|---|---|
| 领单是原子的 | `UPDATE jobs SET state='claimed', lease=… WHERE id=? AND state='ready'`，改到 1 行才算领到，两个 bot 不会领到同一张 |
| 租约 | 领到给 30 秒，`running` 期间每 10 秒 heartbeat 续租；bot 掉线 30 秒后单子自动回 `ready`，**checkpoint 留给下一个接手的** |
| 重试计数 | `INTERRUPTED` / `PREEMPTED` 不计 attempts；`TIMEOUT` / `STUCK` / `NO_PATH` 计；`NO_ITEM` / `NO_TOOL` / `NO_RECIPE` 直接 `blocked`（重试没用，要别的单先补料） |
| 完成判据 | 复合技能返回 `ok` **且** `progress.count ≥ want`；只看"没报错"不算完成 |
| 丢租约 | heartbeat 回 `LEASE_LOST` 时立刻停手（别人可能已经接了），不许继续动世界 |

## 7. 优先级与抢占

| 级别 | 谁 | 抢不抢 |
|---|---|---|
| 反射（不进任务板） | 任务期间不暂停的 mode：`self_preservation` / `self_defense` / `cowardice`；`mineflayer-auto-eat` | 本地立即打断一切；完事后调度器自动续做被打断的单 |
| 9 | 玩家直接命令（"停""过来"） | 抢占任何单 |
| 6–8 | 玩家 / 模型派的单 | 可抢占比自己低 ≥2 级的单 |
| 3–5 | 策略派生的子单 | 不抢，排队 |
| 0–2 | 后台维护（整理箱子、补火把） | 只在完全空闲时 |

抢占怎么做：调度器调 `action_manager.stop()` → 流程在下一个步骤边界读到 `interrupt_code`，`ctx.save()` 后返回 `INTERRUPTED`
→ 调度器知道是自己发起的抢占，把单记成 `paused`（reason `preempted`），新单跑完再按 checkpoint 续做。

玩家说"停"：当前单 `paused`，**调度器也暂停自动领单**，直到玩家说"继续"——否则她停一秒又去领下一张。

> ⚠️ 这套机制依赖两个现存缺陷先修好（`REFACTOR_ANALYSIS.md` D17 / D18）：
> `timedout` 从不复位，之后的中断都被当成超时、中断消息被吞；
> `stop()` 等 10 秒后强制 `executing=false`，旧动作函数可能还在跑，会出现两个流程同时驱动 bot。

## 8. 调度器主循环（每个 agent 一个）

```
空闲 且 未被玩家暂停:
  1. 有自己的 paused 单            → resume 它
  2. 否则 board:claim             → 个人单优先，再多人单；按 requires 过滤，按 priority、距离排序
  3. 逐个 reserve(job.claims)     → 有冲突：全部 release，退避 5 秒重领
  4. action_manager.runAction(job.title, () => run(bot, args, ctx), { timeout })
     每 10 秒 heartbeat + progress
  5. board:finish(result)，release 预约
```

直接命令（`!collectBlocks` 等）现在绕过任务板立即执行，这一期不动；
B3 起改为"生成一张 priority 8 的个人单"，所有入口走同一条路。

## 9. 多人任务（多个 bot）

### 9.1 拆单

| 方式 | 例 |
|---|---|
| 按数量 | "采 64 原木" → 4 张 `shared` 子单，各 16 |
| 按区域 | "清空这片 32×32" → 按 16×16 网格切 4 块，每块 `claims: ['area:…']` |
| 按工序 | 挖铁 → 熔炼 → 合成，用 `dependsOn` 串起来；挖铁和挖煤可以并行 |

父单在所有子单 `done` 后才 `done`；任一子单 `failed` 且没人能接 → 父单 `blocked`，通知来源。

### 9.2 预约（防撞）

| 资源 | key | 防什么 |
|---|---|---|
| 方块 | `block:x,y,z` | 两个 bot 砍同一棵树、挖同一块矿 |
| 区域 | `area:x,y,z:r` | 两个 bot 在同一片地方建 / 挖 |
| 容器 | `container:x,y,z` | 同时开同一个箱子，计数对不上 |
| 工作站 | `station:furnace@x,y,z` | 抢同一个熔炉 |
| 实体 | `entity:<uuid>` | 打同一只怪、和同一个村民交易 |

预约有 TTL，跟着任务单 heartbeat 续期；bot 掉线自动释放。冲突返回 `CLAIM_CONFLICT`，流程按 `onFail` 换目标。
**单 bot 时 `reserve` 恒成功**：单机和多机走同一套代码，不维护两条路径。

### 9.3 共享什么

| 数据 | 现在 | 计划 |
|---|---|---|
| 任务单、预约 | 无 | 任务板库（B1 起） |
| 地标、危险点、箱子内容 | 每个 bot 各存一份 | 搬进任务板库，各 bot 读写（B4） |
| 3D 地形库 `terrain3d` | 每个 bot 一份 SQLite | **暂不共享**：多进程写同一个 SQLite 要处理 WAL 和 busy 重试，收益不值 |

### 9.4 通信、角色、交接

- **协调走任务板事件，不走聊天**。聊天要经过模型理解，慢、贵、会误解；现有的 bot 间聊天（`conversation.js`）只留给"像人一样聊天"。
- **角色**：profile 加 `roles: ['miner']`，多人单的 `requires.roles` 按它过滤；不配就什么都能领。
- **交接物品**：不要当面丢（会被别人或 `item_collecting` 捡走）。拆成两张单：A 的 `store` 存进约定的箱子（预约 `container:…`），B 的 `fetch` 单 `dependsOn` A。

## 10. 怎么用

**命令**（模型和玩家都能用）

| 命令 | 作用 |
|---|---|
| `!addJob(skill, argsJson, priority?)` | 给自己加一张个人单 |
| `!addSharedJob(skill, argsJson, priority?)` | 加一张多人单，谁合适谁领 |
| `!jobs()` | 列出自己的单和可领的多人单：状态、进度、卡在哪 |
| `!cancelJob(id)` / `!pauseJob(id)` / `!resumeJob(id)` | 取消 / 暂停 / 继续 |

**面板**：mindserver 加一页"任务板"，按状态分栏显示所有单，能手动取消、改优先级。

**安全**

- mindserver 的 socket 只放本机连接：✅ 2026-11-01 已加 `allowRequest`（`src/mindcraft/local_only.js`：Host 必须是本机名，带了 Origin 必须是本机页面；单测 `tools/mindserver_local_only_unit.mjs`）。
- `skill` 只能填注册表里有的名字，不能是任意函数名。
- `args` 按 `manifest.params` 校验，不合格直接拒，不进库。

## 11. 分期

| 期 | 做什么 | 验收 |
|---|---|---|
| **B0** | 修 D17、D18；给现有 6 个流程注入 `ctx`（`deadline` / `onEvent` / `checkpoint`）。还没有任务板 | 喊停 1 秒内停下；下一个动作不再带 `timedout`；D18 先真机复现，修后同一场景不再出现两个流程同时驱动 |
| **B1** | `board_store` + `board_server`；个人单；`!addJob` / `!jobs` / `!cancelJob`（socket 的 `allowRequest` 已提前做完） | 加单 → 重启 bot → 单还在，从断点接着做，不重复计数 |
| **B2** | `board_scheduler`：空闲自动领单、优先级、抢占 | 做 3 级单时玩家下 9 级命令 → 先做 9 级 → 回去接着做 3 级，进度不丢 |
| **B3** | 多人单、预约、角色 | 两个 bot 领"采 64 原木"的 4 张子单：不砍同一棵树，合计 ≥ 64 |
| **B4** | 共享地标、危险点、箱子内容（§9.3） | A 存进箱子的东西，B 不开箱就知道在哪个箱子 |

B0 不依赖任务板，可以和 Phase A 并行。

## 12. 测试

- **离线**：`board_store` 用临时 sqlite 文件测状态机的全部转移、租约过期（假时钟）、两个客户端抢同一张单只有一个成功、预约冲突、重启后恢复。接进 `tools/unit_all.mjs`。
- **真机**：用 `tools/arena.mjs` 租场地跑 §11 的验收用例，结果记进 `legacy/验收记录.md`。
