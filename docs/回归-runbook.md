# 全量回归 runbook（验收项 ②③④）

> **状态：只准备、未执行**（2026-11-05 整理，control）。
> 目的：等真机（25566）空出来时，**照着这份文档连跑，不用现场摸索**。
>
> ★ 三条铁律（都是读脚本确认过的，不是推测）：
> 1. **所有真机脚本都必须独占 25566**（同一个 MC 服务器 + RCON 25576）。
> 2. **跑 board_b* 之前必须清板** —— 板库是**持久化**的（`bots/_board/board.sqlite`），
>    当前残留 **18 张单**，其中 `j_20261105_0012` 是 **`ready` 的 `obtain` 单**。
>    `board_b1/b2` 的子进程在拿不到指定单时**会 `claim()` 任意 ready 单** → 会抢走它。
> 3. **`bench_move_actions` 会改地形**（`tools/arena.mjs` 用 `/forceload` + fill 切块填充），
>    跑完地形是"被改过"的状态 → **后续任何依赖自然地形（找树/找水）的用例都受影响**。

---

## 0. 环境前提（三项，缺一不可）

| 项 | 要求 | 怎么确认 |
|---|---|---|
| MC 测试服 | `127.0.0.1:25566` 在跑 | `node -e "require('net').connect(25566,'127.0.0.1').on('connect',()=>{console.log('up');process.exit(0)}).on('error',()=>{console.log('down');process.exit(1)})"` |
| RCON | `127.0.0.1:25576`（密码见 `server.properties`） | 任一 `RC('/list')` 能回 |
| 玩家 | **0 个真人玩家**（否则实体会干扰 b1/b2 的"server 侧痕迹"快照） | `RC('/list')` 只剩测试 bot |
| 板库 | `bots/_board/board.sqlite` | 跑 board 用例前**必须清到 0 单**（见下） |

---

## 1. 清板（board 用例的前置，**必做**）

板库是持久的，`board_b3/b4` 自己会 `DELETE FROM jobs/claims/shared`，但 **b1/b2 不会** —— 它们通过真 socket 走 mindserver，直接读同一个库。

**清板命令（只读脚本，不依赖服务器）：**
```bash
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('bots/_board/board.sqlite');
for(const t of ['jobs','claims','shared']){try{db.exec('DELETE FROM '+t);}catch(e){}}
console.log('cleared');
db.close();
"
```
**确认清干净：**
```bash
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('bots/_board/board.sqlite',{readOnly:true});
for(const t of ['jobs','claims','shared']) console.log(t, db.prepare('SELECT COUNT(*) c FROM '+t).get().c);
"
```
**成功判据**：三张表都 `0`。**不是 0 就别往下跑。**

> ⚠️ 清板前若还想留证据，先 `cp bots/_board/board.sqlite /tmp/board_before_regression.sqlite`。

---

## 2. 四件回归：命令行 / 前提 / 耗时 / 判据 / 失败先看什么

### ② `atom_all`（原子层 17 个用例）

| 项 | 内容 |
|---|---|
| 命令 | `node tools/atom_all.mjs`（或只跑几个：`node tools/atom_all.mjs dig place`） |
| 前置 | 25566 + RCON；**0 玩家**；无地形要求（原子用例自带搭台/清理）|
| 耗时 | **约 6~10 分钟**（7 个脚本串行，每个 1~2 分钟）|
| 成功判据 | 末尾 `✅` 全绿、退出码 **0**；每个子脚本打印 `N/N 个用例通过` |
| 失败先看 | ① 服务器是否真在跑（脚本现在会先探端口，连不上**直接判失败**——这是修过的"假绿"）② 逐个子脚本的 `✗` 行 ③ 残留实体/窗口导致的互相污染（脚本头部就写了踩过这个坑）|

> ★ 这个脚本**不会**清板、**不会**改地形。可以**紧接**在任何非地形用例之后跑。

### ③ `bench_move_actions`（移动基线，5 场景 × 逐 action）

| 项 | 内容 |
|---|---|
| 命令 | `node tools/bench_move_actions.mjs` |
| 前置 | 25566 + RCON；**0 玩家**；**会自己造场地**（`tools/arena.mjs`：`/forceload` + fill 切块）|
| 耗时 | **约 8~15 分钟**（每场景干跑规划 + 真跑执行；首跑记录里 water-cross 单场景就要 40~70s）|
| 成功判据 | **对基线 50/55**；输出 `tmp/bench/*.jsonl` 后按场景统计；**逐场景构成**也要看：`down5=0/5` 是**已知边界**（maxDrop=4，5 格跳不规划），不是回归 |
| 失败先看 | ① 逐 action 直方图（`walk/jump/down/dig/climb`）——若某 action 计数为 0，说明场景没逼出它（**场景失效**，不是能力退化）② `NO_PATH` vs `TIMEOUT` 的区别 ③ water-cross 本来就不稳（42.9s~70s）|

> ★ **会改地形**：`/forceload` 加远处区块 + fill。跑完场地是"被改造过"的。
> ★ **跑前的 jsonl 必须先归档**，否则新旧混在一起（台账里记过这个坑：`tmp/bench/archive/2026-11-03-move-actions.jsonl` 就因为混了 15 轮历史而不能当基线）。

### ④ `board_b1_live` / `board_b2_live`

| 项 | b1 | b2 |
|---|---|---|
| 命令 | `node tools/board_b1_live.mjs` | `node tools/board_b2_live.mjs` |
| 前置 | 25566 + RCON + **清板到 0** + **0 玩家** | 同 b1 |
| 自起 mindserver 端口 | **18099** | **18098** |
| 耗时 | 约 3~5 分钟（含 SIGKILL + 等租约过期 + 子进程 B 接手）| 约 3~5 分钟（抢占快照 + 1 秒静默观察）|
| 成功判据 | 四条：① 单同 id 还在 ② `progress.count` 不倒退 ③ **不重复计数** ④ `attempts` 没因 kill +1 | 三条：① 3 级 → `paused(preempted)` 且 `attempts=0` ② 9 级执行并 `done` ③ **抢占后 1 秒内 server 侧痕迹不再增长**（挖掉的方块数、位置都不变）|
| 失败先看 | ① **板上是不是有残留单**（子进程会 `claim()` 任意 ready 单 —— 见铁律 2）② 租约超时参数是否够 ③ 子进程 stderr 里 `AGENT_CLAIMED` 打印的 **job id 是不是它自己那张** | ① 抢占瞬间快照的两次是否真的"都没变" ② `INTERRUPTED` 有没有被误记成 attempts=1 |

### ④ `board_b3_live` / `board_b4_live`

| 项 | b3 | b4 |
|---|---|---|
| 命令 | `node tools/board_b3_live.mjs` | `node tools/board_b4_live.mjs` |
| 前置 | 25566 + RCON + **0 玩家** | 同 b3 |
| **会清库** | **会**：`DELETE FROM jobs` + `DELETE FROM claims`（:127）| **会**：`DELETE FROM shared`（:129）|
| 耗时 | 约 2~4 分钟 | 约 2~4 分钟 |
| 成功判据 | 见脚本内断言（B3 = 预约/冲突）| B4 = 共享箱子记忆（A 存、B 不开箱就知道）；**⑤ 依赖子进程调度时机**，是已知脆弱点 |
| 失败先看 | 冲突断言是否因为"板上还有别的单占着 key" | ① `shared` 表是否有残留 ② B4 的 ⑤ 本身不稳（台账记过）|

> ★ **b3/b4 自己会清库** → 它们**可以**在脏板上跑；但**b1/b2 不行**（不清）。为了统一口径，**建议一律先手动清板**。

---

## 3. 冲突矩阵

| ↓先跑 / 后跑→ | atom_all | bench_move | b1 | b2 | b3 | b4 |
|---|---|---|---|---|---|---|
| **atom_all** | — | ⚠️ 地形被改 | ✅ | ✅ | ✅ | ✅ |
| **bench_move** | ✅ | — | ✅ | ✅ | ✅ | ✅ |
| **b1** | ✅ | ✅ | — | ⚠️ **必须清板**（b1 不清库）| ✅（b3 自清）| ✅ |
| **b2** | ✅ | ✅ | ⚠️ **必须清板** | — | ✅ | ✅ |
| **b3** | ✅ | ✅ | ✅（自清）| ✅ | — | ✅ |
| **b4** | ✅ | ✅ | ✅ | ✅ | ✅ | — |

**图例**：✅ 可以连跑｜⚠️ 需要中间重置

### 硬约束三条（从矩阵读出来）
1. **所有真机用例两两之间都不能并行** —— 都占 25566 + RCON 25576。b1/b2 虽各有独立 mindserver 端口（18099/18098），但**共用一个 MC 服**。
2. **`bench_move` 之后必须重置地形**才能跑任何"依赖自然地形"的用例（本 runbook 里的四个不依赖；但 `first_night` / `t37_firstnight_live` **依赖有树的自然地形**，绝不能紧跟在 bench_move 后面）。
3. **跑 b1/b2 之前必须清板**；b3/b4 自清，但也建议统一先清。

---

## 4. ★ D 项结论：`board_b1~b4` **确实依赖板子状态**

**读脚本确认（不是推测）：**

`tools/board_b1_live.mjs` 子进程领单逻辑：
```js
let job = JOB_ID ? board.get(JOB_ID) : null;
if (!job || (job.state !== CLAIMED && job.state !== RUNNING)) {
    const r = await board.claim();        // ← 领"任意一张 ready 单"
    job = r.data?.job ?? null;
}
if (!job) { console.log('AGENT_NO_JOB'); process.exit(3); }
```

**当前板上实际残留（2026-11-05 00:16 只读查）：**
```
jobs 18 | claims 0 | shared 0
j_20261105_0012  obtain  state=ready   assignee=deepseek   ← 会被 claim 抢走
j_20261105_0013  eat     state=blocked
j_20261105_0018  craft   state=blocked
```

→ **是的，会依赖**。三条具体风险：
1. **抢错单**：`claim()` 是"任意 ready 单"，残留的 `j_20261105_0012`（obtain/ready）会被领走 → b1 的"重启不丢单/不重复计数"断言测的就不是它自己那张单。
2. **污染计数**：b1 断言里若涉及 `listJobs()` 数量（板上有 18 张），基线不是 0。
3. **b2 的抢占观察**：多一张 ready 单就可能被另外的 claim 抢走，导致"server 侧痕迹"快照出现无关变化。

**结论：跑 b1~b4 前必须先清板到 0。** b3/b4 脚本自带清库（可容忍脏板），但**为了口径统一，四个都先清**。

---

## 5. `tmp/bench/` 归档状态（2026-11-05 00:20 实查）

```bash
ls -lt tmp/bench/*.jsonl            # 当前
ls -lt tmp/bench/archive/*.jsonl    # 历史
```

**当前 `tmp/bench/` 只有 1 个文件**：
```
-rw-r--r-- 2935  Nov 3 16:36  tmp/bench/deepwater-2026-11-03.jsonl    ← 11-03 的深水基准，不是 move-actions
```
**`archive/` 有 6 个历史**（均为 11-02 / 11-03 的 move-actions 或对照）：
```
2026-11-03-move-actions.t49-before.jsonl
2026-11-03-move-actions.jsonl                     ← 就是那个"混了 15 轮历史、不能当基线"的文件
2026-11-02-move-actions.jsonl
2026-11-03-captain-bench-check-45of55.jsonl
2026-11-02-move-actions.t29-m9-before.jsonl
2026-11-03-confirm3-45of55-noflake.jsonl
```

**→ 跑 `bench_move_actions` 前不需要先归档**（当前没有 move-actions 的 jsonl 挡路），
但**跑完必须立刻**把它产出移到 `archive/`，文件名带日期+用途，并当场记下基线数字。

**规矩（台账里已记过教训）**：
- 每次跑 `bench_move_actions` **之前**，把现存 `tmp/bench/*.jsonl` 里**同用途**的移到 `tmp/bench/archive/<日期>-<用途>.jsonl`
- **不同口径的样本绝不能混在同一个文件** —— 曾经因为混了 15 轮历史，把一个 69/91 的混合文件当成了基线
- 归档文件名必须带**日期 + 用途**，且**跑完当场记下基线数字**

---

## 6. 建议执行顺序（一条命令接一条）

```bash
# 0) 前提
node -e "require('net').connect(25566,'127.0.0.1')..."   # 25566 up?
# 1) 清板（board 用例之前必须）
node -e "...DELETE FROM jobs/claims/shared..."           # 见 §1
# 2) 原子层（不碰板、不改地形）
node tools/atom_all.mjs                                  # 6~10 min
# 3) 任务板（b1/b2 依赖清板；b3/b4 自清）
node tools/board_b1_live.mjs                             # 3~5 min
node tools/board_b2_live.mjs                             # 3~5 min
node tools/board_b3_live.mjs                             # 2~4 min（自清库）
node tools/board_b4_live.mjs                             # 2~4 min（自清 shared）
# 4) 移动基线（会改地形 —— 放最后）
node tools/bench_move_actions.mjs                        # 8~15 min（跑前先归档 jsonl）
```

**把 bench_move 放最后**，因为它是唯一**改地形**的；即使本组用例不依赖自然地形，也避免给后续（第一夜）留烂摊子。

**总预计**：**约 25~40 分钟**（不含清板与排障）。

---

## 7. 失败时的统一诊断顺序（从今晚学的）

1. **先确认"它真的跑了吗"** —— 端口通不通、有没有 `AGENT_CLAIMED`、有没有 `N/N 用例通过`。今晚栽过：**脚本连不上服务器却退出码 0**（假绿）。
2. **再看"数字的分母"** —— `54/54` 和 `54/55` 差一个脚本却是两件事；报通过率必须同时报分母口径。
3. **再看"是能力退化还是场景失效"** —— 某 action 计数为 0 通常是**场景没逼出它**（墙没横贯、终点已在到达半径内），不是能力退化。
4. **最后才怀疑代码** —— 并且要能回答"这个症状还有哪些可能原因"（见台账的 32 条症状索引）。
