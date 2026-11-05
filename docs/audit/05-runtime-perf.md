# 审计⑤：运行证据、崩溃模式与真实性能

审查对象：`E:\我的世界ai`（mindcraft fork + Paper 服务端 + 面板）。只读审查，未改任何源码、未启动任何进程。
**所有日志读取都是有界的**：正文给出的每条命令都可直接复现；没有整文件读、没有把日志原文大段贴进来。

---

## 0. 读法与免责

- 日志行可能有极长行（实测单行最长 **752,766 字符**），因此**禁止按行 `head`/`cat`**；本报告一律用 `cut -c1-N`、`grep -c`、`awk` 长度统计、`node` 解析 json。
- 「次数」全部来自 `grep -c` / `grep -h ... | wc -l`；「体积」来自 `stat -c%s` / `du -cb`。
- 仅有 1 份 agent 侧近期日志（`mindcraft/tmp-t59-agent.log`，2026-11-05 13:45，18KB/293 行）。**没有一次"长跑 + 多 bot + 面板"的完整现场**，所以本报告的能量主要在"能实证的"和"能证伪的"，不在"平均表现"。

---

## 1. 日志盘点（体积 / 覆盖时间窗）

复现命令：

```bash
cd "E:/我的世界ai"
# 全仓日志总量（排除 node_modules）
du -cb server/*.log server/logs/*.gz logs/*.log mindcraft/*.log \
      mindcraft/tmp/*.log mindcraft/tmp/bench/*.jsonl \
      mindcraft/tmp/bench/archive/*.jsonl server-test/logs/*.log | tail -1
# 单文件体积 + 行数
stat -c%s <file>; wc -l <file>
# 超长行体检（防 cat 炸屏）
awk '{if(length($0)>m)m=length($0)}END{print m}' <file>
```

| 文件 | 体积 | 行数 | 时间窗 | 用途 |
|---|---:|---:|---|---|
| `mindcraft/tmp/server-test-run.log` | **11,680,479 B** | 6,387 | 无时间戳（内容含 `[18:21]`~`[18:48]`） | Paper stdout 捕获（**已被 RC 提示符污染**，见 R5） |
| `server-test/logs/latest.log` | **9,128,155 B** | 107,383 | 00:14:24 → 15:59:25（**15.75 小时**） | 当前 Paper 服务端日志（最近一次，Nov 5） |
| `server/run-latest.log` | 565,195 B | 8,899 | 无时间戳 | 旧服务端运行 |
| `server/latest-run.log` | 287,890 B | 3,283 | 无时间戳 | 旧服务端运行 |
| `mindcraft/tmp-t59-agent.log` | **18,123 B** | 293 | **无时间戳** | **唯一的近期 agent 现场（Nov 5 13:45）** |
| `mindcraft/run-live.log` / `.err.log` | 3,489 / 548 B | 85 / 10 | 无时间戳 | 旧 agent 现场（Oct 29-30） |
| `logs/mindcraft-console.log` / `server-console.log` | 3,320 / 21,090 B | 79 / — | — | 面板启动时的控制台捕获 |
| `server/logs/*.gz` | 64 个文件，共 533,830 B | — | 10-18 ~ 10-20 | 旧服务端轮转归档 |
| `server-test/logs/` | 21 个 `.gz` + 1 个 `latest.log` | — | 10-22 ~ 11-05 | 当前服务端轮转归档 |
| `mindcraft/tmp/bench/**/*.jsonl` | 12 个文件，约 400 KB | — | 10-31 ~ 11-03 | **性能基准数据（唯一可复算的性能证据）** |
| **合计** | **24,469,026 B（23.3 MiB）/ 184 个文件** | | | |

覆盖时间窗的硬结论：**日志的时间分辨率在服务端是秒、在 bot 侧是零**。
`mindcraft/tmp-t59-agent.log` 与 `run-live.log` 里以 `[HH:MM` 开头的行数都是 **0**（`grep -cE '^\[[0-9]{2}:[0-9]{2}'` = 0/293、0/85）—— bot 侧任何一条日志都无法定位到时间。

---

## 2. 错误高频榜 Top 10

统计面：`server/*.log` + `server-test/logs/latest.log` + `logs/server-console.log` + `mindcraft/*.log` + `mindcraft/tmp-t59-agent.log`。
复现：`grep -c "<原文片段>" <file>`；「首次出现」给的是 `文件:行号`（行号仅对 agent 日志有意义，服务端日志无稳定行号故给时间或文件）。

| # | 原文片段（截断） | 次数 | 首次出现 | 判读 |
|---|---|---:|---|---|
| 1 | `Thread RCON Client /127.0.0.1 started` + `... shutting down` | **53,540 ×2** | `server-test/logs/latest.log`（首次连接 00:14 起每秒级） | **不是错误，是噪音**：占该文件 **99.7%**（见 R1）。每个 RCON 命令开一条新 TCP。 |
| 2 | `[MINE] dig false INTERNAL oak_log ... err= Digging aborted` | **9**（其中 5 条带 `interrupted=false timedOut= false inFlight= 0`） | `tmp-t59-agent.log:137`（另见 140/143/170） | **静默失败**：动作被第三方中止，但本流程既没被 interrupt 也没超时（R9）。 |
| 3 | `[walkTo] 第N轮 步X walk(...) 失败: NO_PATH 没有可走的路` | **7** | `tmp-t59-agent.log:203`（后 206/209/214/217/284） | 同一 3×3 格区域内**连续 5 轮**全 NO_PATH（见 §4 的卡死样本）。 |
| 4 | `The goal was changed before it could be completed!` | **2**（`INTERNAL`） | `tmp-t59-agent.log:164`、`:180` | **实证了审计① N2/N3**：pathfinder goal 被另一个驱动者抢走（R4）。 |
| 5 | `deepseek lost connection: Disconnected` 类 | **386**（21 个文件合计） | `server/run.log`（10-18）→ `server-test/logs/latest.log`（11-05，17 次） | 与 `joined the game` 387 / `left the game` 380 基本相等 → 每次上线下线一一对应（正常关停为主）。 |
| 6 | `Invalid move player packet received` | **20** | `server/run.log`（10-18 19:47） | **全部 ≤ 2026-10-22**，BUG-001 修复（10-24 升级 mineflayer 4.39）之后**零复发**（见 §3）。 |
| 7 | `[MINE] 已记录失败点` | **8** | `tmp-t59-agent.log:165` | 与 #3 同源：每轮 NO_PATH 落一个失败点（喂给 `terrain3d.fail`）。 |
| 8 | `[MINE] goTo false NO_REACH 连续 3 轮走不动（还差 5 格）` | **1** | `tmp-t59-agent.log:220` | 上述 NO_PATH 连击的**终局**：executor 的 `stalled>=3` 闸生效（这道闸是好的）。 |
| 9 | `Agent process exited too quickly and will not be restarted.` | **1** | `mindcraft/run-live.err.log`（末行） | **最危险的终态**：`ECONNRESET → ECONNREFUSED → 退出`，10 秒守卫判定"起得太快"→ **永久放弃**（R3）。 |
| 10 | `Internal Exception: ... DecoderException: Failed to decode packet` / `Invalid characters in username` | 5 / 1 | `server/*.log` | 协议版本不匹配 / 非法用户名，属配置期噪音，非运行期缺陷。 |

补充（不在 Top10 但报告要用）：`OutOfMemory` **0**、`Address already in use` **0**、`Can't keep up` **0**、`ping timeout` **1**（仅 10-30，修复前）。

### 静默失败清单（没抛错 / 抛了不说明，但结果不对）

| 现象 | 证据 | 为什么算静默 |
|---|---|---|
| 挖掘"中止"但无人宣称中止 | `tmp-t59-agent.log:171` `[DIG] err seq= 7 reason= Digging aborted \| heldMs= 2382 budget= 6500 \| interrupted= false timedOut= false \| inFlight= 0` | 三个"谁中止的"判据全是否 → 中止者来自流程之外（另一驱动者改 goal / `stopDigging`），日志里**没有任何一方承认**。 |
| 挖到了却记成失败 | `:137` `mined= 0 / 1`，而 `:174` `[DIG] broke-stale-lock seq= 8` 说明上一轮方块真的被破坏 | 世界状态已变，账目记为 0。 |
| 挖超了却记成成功且无告警 | `:288` `[MINE] dig true OK stone d= 2.8 mined= 13 / 3` | `13/3` = 4.3 倍超采，日志语气是 OK，没有任何标记。 |
| NO_PATH 可能与真实原因无关 | `:203-218` 五轮 NO_PATH 全在同一 3 格范围，随后 `:220` 才报 `NO_REACH` | 审计① N12 指出扫描异常会被吞成 NO_PATH；现场无法区分"真没路"还是"数据坏"。 |

---

## 3. 崩溃与断连模式

### 3.1 唯一的崩溃报告：世界目录被别的进程锁住（不是 OOM）

复现：`head -34 "server/crash-reports/crash-2026-10-30_19.06.56-server.txt" | cut -c1-170`

```
Description: Exception in server tick loop
java.lang.RuntimeException: java.io.IOException: 另一个程序已锁定文件的一部分，进程无法访问。
  Caused by: ... at net.minecraft.util.DirectoryLock.create(DirectoryLock.java:26)
             at ...LevelStorageSource$LevelStorageAccess.<init>(LevelStorageSource.java:436)
             at net.minecraft.server.MinecraftServer.loadWorld0(MinecraftServer.java:571)
```

- **是什么**：Paper 启动时写 `session.lock` 失败 → 服务端在 tick loop 里抛异常直接退出。`DirectoryLock.create` 是**专门用来防"两个服务端开同一个世界"**的锁。
- **说明什么**：本次崩溃不是内存、不是 tick lag，是**同一个 world 目录被另一个进程占着**（上一个 java 没退干净 / 同时起了两个服务端）。
- **不是 OOM**：同文件 System Details 记 `Memory: 783,504,304 bytes (747 MiB) / 1,073,741,824 (1024 MiB) up to 2,147,483,648 (2048 MiB)` —— 747 MiB 用量，离 2 GB 上限很远。
- 这类崩溃**只发生一次**（`server/crash-reports/` 只有 1 个文件），且所有服务端日志里 `OutOfMemory` = 0、`Address already in use` = 0。

### 3.2 重连风暴与"永久放弃"（最该修的一条）

复现：`cut -c1-110 mindcraft/run-live.log | head -40` 与 `cat mindcraft/run-live.err.log`

`run-live.err.log`（548 字节，全文就这几行）：

```
[LoginGuard] Connection Error: Error: read ECONNRESET
Disconnected: socketclosed
[LoginGuard] Connection Failed: Server is under maintenance or restarting.
Disconnected: {"errno":-4078,"code":"econnrefused","syscall":"connect","address":"127.0.0.1","port":25565}
[LoginGuard] Network Error: Connection timed out or was lost.
Agent process exited too quickly and will not be restarted.
```

`run-live.log` 里 `Client connected` 出现 **13 次**（`grep -c "Client connected"`），末尾连续 8 行都是它 —— 典型的**重连风暴**：MC 服务端没起来（`ECONNREFUSED 127.0.0.1:25565`），agent 反复重试，最后触发父进程的守卫。

守卫逻辑（`mindcraft/src/process/agent_process.js:41-49`）：

```js
if (code !== 0 && signal !== 'SIGINT') {
    // agent must run for at least 10 seconds before restarting
    if (Date.now() - last_restart < 10000) {
        console.error(`Agent process exited too quickly and will not be restarted.`);
        return;                       // ← 永久放弃，不再重试
    }
    ...
}
```

**这是"瞬时故障 → 永久死亡"**：服务端重启通常要 20-60 秒，agent 在这期间必然 10 秒内退出 → 守卫判定"起得太快" → **再也不重启**，用户必须手工点启动。日志里就是这样收尾的。

### 3.3 心跳超时（ping timeout）——已修且未复发

- 全仓 `ping timeout` 只出现 **1 次**：`mindcraft/run-live.log`（2026-10-30 00:30）。
- 同一次掉线时项目自己的诊断在跑：`[disconnect-diag] 事件循环延迟最大 162ms（正常，不是阻塞导致）`（`agent/mindserver_proxy.js:58-65` + `utils/loop_lag.js`）。
  → **反证了"掉线是主线程被扫描卡住"这个猜想**（至少这一次不是）。
- 心跳参数在 **2026-10-31** 才放宽到 `pingInterval 25000 / pingTimeout 60000`（`git log -S"pingTimeout: 60000"` → commit `2f7185e`，2026-10-31；代码位置 `agent/mindserver_proxy.js:36-37` 与 `mindcraft/mindserver.js:63-64`）。
  → 10-30 那次掉线用的是旧的 20s 设置；**修复之后的日志里再没出现过 ping timeout**（覆盖到 11-05）。

### 3.4 踢人（Invalid move player packet）：已修且零复发

- 20 次全部落在 **2026-10-18 ~ 10-22** 的 7 个文件里（逐文件统计见下），11-05 的 `server-test/logs/latest.log` 里 **0 次**。

```bash
for f in server/*.log server-test/logs/latest.log logs/server-console.log; do
  c=$(grep -c "Invalid move player packet" "$f"); [ "${c:-0}" -gt 0 ] && printf "%s n=%s mtime=%s\n" "$f" "$c" "$(stat -c%y "$f"|cut -c1-16)"
done
# run-live4 3, run-vis 5, run6 5, run4 2, run2 2, run5 1, run 2  （全部 ≤ 2026-10-22）
```

- 这与 `bugs/BUG-001-tp物理崩溃.md` 记录的一致（"升级 mineflayer 4.33→4.39，业务代码零改动"，记录日 2026-10-24）。**结论：这个 bug 的修复站得住。**

---

## 4. 性能数字（每个都能复算）

唯一可信的性能证据是 `mindcraft/tmp/bench/**/*.jsonl`：一行一次场景（字段 `scenario/round/ok/code/ms/moved`）。
**必须先查污染**：`bench_move_actions.mjs` 是 `appendFileSync` 追加写（`tools/bench_move_actions.mjs:63`、`:309`），文件被文档明确警告"跑前必须归档"（`:59-63`）。实测确实是混的：

```bash
node -e '...统计 (scenario|round) 重复数...'
# baseline-m2-ACCUMULATED-MIX: 297 行，去重后 110，重复 187
# control-m2                : 424 行，去重后 110，重复 314
# 2026-11-01-move-actions   :  31 行，去重后  31，重复   0   ← 干净
```

**所以下面所有数字都按 `(scenario, round)` 去重后计算。**

### 4.1 导航吞吐：与 README / 交接文档三处都对不上

| 场景 | n（去重） | 成功率 | 移动 | 耗时 | **格/秒** | 数据来源 |
|---|---:|---:|---:|---:|---:|---|
| `long-route`（长距离） | 10 | **100%** | 561 格 | 179.7 s | **3.12** | `archive/2026-10-31-move-walkto.pre-t6.jsonl` |
| `long-route`（goto 通道） | 5 | 100% | 281 格 | 90.1 s | **3.11** | `archive/2026-10-31-move-goto.pre-t6.jsonl` |
| 全部 11 场景合计 | 110 | 90% | 1,827 格 | 928.8 s | **1.97** | `archive/2026-11-01-move-actions.baseline-m2-ACCUMULATED-MIX.jsonl`（去重后） |
| `walk-flat` | 10 | 100% | — | — | **3.85** | 同上 |
| `climb-ladder` | 10 | 100% | — | — | **4.02** | 同上 |
| `dig-through` | 10 | 90% | — | — | **2.58** | 同上 |
| `digdown` | 10 | 100% | — | — | **1.46** | 同上 |
| `pillar-up2` | 10 | 100% | — | — | **1.44** | 同上 |
| `water-cross` | 10 | 100% | — | — | **0.72** | 同上 |
| `down5` | 10 | **0%** | — | — | （3.60 但全失败） | 同上 |
| `deep-water` | 10 | 100% | 142 格 | 133.3 s | **1.07** | `deepwater-2026-11-03.jsonl` |

复现（可直接粘贴）：

```bash
cd "E:/我的世界ai/mindcraft/tmp/bench"
node -e '
const fs=require("fs");
const L=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(JSON.parse);
const seen=new Set(); const U=L.filter(r=>{const k=r.scenario+"|"+r.round; if(seen.has(k))return false; seen.add(k); return true});
let ok=0,mv=0,ms=0; for(const r of U){ if(r.ok)ok++; mv+=+r.moved||0; ms+=+r.ms||0 }
console.log(`去重n=${U.length} ok=${ok} ${mv}格/${(ms/1e3).toFixed(1)}s => ${(mv/(ms/1e3)).toFixed(2)}格/秒`);
' archive/2026-10-31-move-walkto.pre-t6.jsonl
```

**与宣称值三方对照（这是本节的结论）**：

| 宣称出处 | 宣称值 | 可复算吗 | 实测 |
|---|---|---|---|
| `README.md:40` | 长距离导航 **1.41 格/秒**，「302 格推进 168 格」 | **不可** —— 全仓 bench 归档里没有任何一条记录能推出 1.41，也没有 302 格的场景（`grep -rl "1\.41" tmp/bench/` 为空；`long-route` 单次平均只有 **56.1 格 / 18.0 s**） | long-route = **3.12 格/秒**（比宣称**快 2.2 倍**） |
| `docs/交接文档.md:187` | 「长距离移动（144 格）68~96 秒」 | 可换算 | 144/68=**2.12**、144/96=**1.50** 格/秒 → 与 bench 的 3.12 也不一致 |
| `docs/回归-runbook.md:76` | 「对基线 **50/55**；`down5=0/5` 已知边界」 | **可** | bench 实测 11 场景 × 5 轮 = 55，`down5` 0/5 → **正好 50/55，完全吻合** |

结论：**README 的 1.41 与 302 格是历史真机数据，没有任何可复算的artifact支撑，且与现在的 bench（3.12）差 2.2 倍**。它不是"夸大"，是"来源不可追溯"——两种可能都对读者不利（要么虚低让人低估，要么场景不同却写在同一行）。`回归-runbook` 的 50/55 则是**唯一一条能当场复算并成立的**宣称。

### 4.2 LLM 调用耗时与 token 花费：**无法从日志算出**

- 全仓日志里 `prompt_tokens` / `completion_tokens` / `usage` / `tokens` 的出现文件数 = **0**（`grep -rl` 统计）。
- 唯一相关的行是 `Awaiting openai api response from model deepseek-v4.1-flash` → `Received.`（`mindcraft/run-live.log`），**既无时间戳也无 token 数**。
- 因此**任何 LLM 延迟/成本数字都无法给出**。这不是"没算"，是"没记录"（见 R8）。

### 4.3 工具/技能调用耗时排行：同样不可得

- 日志里唯一带耗时的字段是各测试脚本自己打印的 `costMs`（如 `PASS 返回 costMs costMs=12`），那是**离线单测**的断言输出，不是真机技能耗时。
- 真机上没有任何"技能开始/结束 + 耗时"的成对日志（agent 日志连时间戳都没有，R2）。

---

## 5. 现场证据 ↔ 代码（审计①/② 的 Must fix 逐条对号）

判定口径：**已实证** = 日志里有该缺陷的独有签名，且我先在代码里定位了机制；**未实证** = 现有日志既不能证实也不能证伪（不是"没有此 bug"）。

| 编号 | 缺陷 | 判定 | 现场证据 / 说明 |
|---|---|---|---|
| **N1** | `surveyArea` 默认 radius=64 → 同步扫 110 万次 `blockAt` 阻塞事件循环 | **未实证（且有反证）** | 现有日志里没有 `surveyArea` 调用；唯一一次掉线的诊断是 `事件循环延迟最大 162ms（正常，不是阻塞导致）`（`run-live.log`）→ 至少那一次不是被扫描卡住。radius=64 的阻塞量级来自代码推算，**未经现场测量**。 |
| **N2** | nav 互斥闸 owner 缺省全是 `'adhoc'` → 两条指令被当"自己重入"放行 | **已实证** | `tmp-t59-agent.log:164`、`:180` 两次 `INTERNAL The goal was changed before it could be completed!` —— 这是 mineflayer 在**另一个驱动者替换 pathfinder goal** 时抛的原话。293 行日志里出现 2 次。 |
| **N3** | 12 处直驱 pathfinder 绕过互斥闸 | **已实证** | `flow_follow.js:154` 在 `while`+`sleep(250)`（`:136`/`:201`，即 4 次/秒）里直接 `bot.pathfinder.setGoal(new pf.goals.GoalFollow(...))`；日志中每次 goal 冲突前一行紧跟着 `Unpausing mode unstuck/hunting/item_collecting/...` 块（`:158-163`、`:175-179`）→ 被恢复的 mode 与 walkTo 抢同一 goal。 |
| **N4** | 地标保护清单恒为空（读 `c?.pos` vs 存扁平 `{x,y,z}`） | **未实证** | 现有日志没有"挖到箱子/房子"的行；要证实需要一个专门的现场（在仓库旁砍树）。 |
| **N5** | `scanSphere` 先 `delCol` 后读，读不到时该列旧数据被删且不重写 | **未实证** | 日志里没有该签名（无 `scan3d` 行出现在 agent 日志中，`grep -c scan3d` = 0）。 |
| **N6** | `step_runner` 全部步骤失败仍 `return ok` | **未实证** | 反向证据相关：`tmp-t59-agent.log:288` `dig true OK ... mined= 13 / 3` 说明"ok + 数字不合理"确实发生，但没有任何一行显示"报了 ok 却 doneSteps=0"。 |
| **B1** | `finish()` 不校验租约归属 → 两 bot 同跑一张单 | **未实证** | 现有日志全部是**单 bot**（`deepseek` 一个名字，`server-test/logs/latest.log` 里只有它），没有接管/双写现场。 |
| **B2** | 玩家 `!stop` 对任务板任务无效 | **未实证** | 所有日志里 `!stop` 出现 **0** 次（`grep -c "!stop"`）。 |
| **B3** | 依赖已死的单永久 ready、父单永久 running | **已实证（日志 + 库双向对上）** | ① 日志：`tmp-t59-agent.log:120`、`:236`、`:261` 三行 `[MINE] round n= 0/1 ore= cobblestone candidates= 32 feetY= -59 count= 0 / 3` —— 正是那张 `count:3, ore:cobblestone` 的单；② 库：`j_20261105_0003_ngl` = 同一张单，终态 `blocked`、`NO_TOOL「挖不动 stone（没有合适的镐）」`；③ 后果：它的兄弟 `j_20261105_0007_ngl`（craft stone_pickaxe）`dependsOn=[0003,0006]` 永久 `ready`，父单 `j_20261105_0002_ngl` 永久 `running`（166 分钟，`updatedAt` 与 `createdAt` 只差 3 秒）。 |
| **B4** | 拆单半途崩 → 父单 0 子单永久 running | **未实证** | 库里 7 个 parentId 都有子单，没有 0 子单样本。 |
| **B5** | `openBoard` 把任何异常当"库损坏"→ 删库重建 | **未实证（但同类崩溃已实证）** | 板库没有被重建过的痕迹；不过**同一种失败模式在服务端已经真实发生过一次**：`crash-2026-10-30` 的 `DirectoryLock` 就是"文件被别的进程锁住"，只是 Minecraft 选择崩溃、而板库选择删数据。 |
| **B6** | `LIMIT 200` 镜像截断 | **未实证** | 现库 22 张单，离 200 还远；日志侧无法观察镜像内容。 |

汇总：**t1/t2 的 12 条 Must fix 里，3 条已在现场实证（N2、N3、B3），1 条有反向证据（N1），其余 8 条未实证。** 这说明这批 Must fix 里"事件循环/多 bot 竞态/容量上限"类的没到爆发点，而**"驱动者互相抢"这一类已经在每次真实跑动里复发了**。

---

## 6. README 实测数据表是否还站得住

逐行复核 `README.md:36-46`（同一张表也抄在 `docs/交接文档.md:126-136`）：

| README 行 | 宣称 | 复核结论 |
|---|---|---|
| 长距离导航 | 4/4 完成，平均 **1.41 格/秒**；302 格推进 168 格 | **站不住（无法复算）**：bench 里 `long-route` 实测 **3.12 格/秒**、单次均 56 格；无 302 格场景；全仓无 1.41 的 artifact。数字方向是"低估"，但来源不可追溯。 |
| 爬梯子 | 上 4 格 `y 62.00 → 66.21`，下到底 `66.21 → 63.00` | **部分可证**：bench `climb-ladder` n=10 **ok=10，4.02 格/秒**，"能上下"成立；具体 y 值无 artifact（不可否定）。 |
| 挖掘爬升 | 6 格高实心台地 `(58,63) → (63.5,68.25)`，上升 5.2 格 | **部分可证**：bench `pillar-up2` n=10 ok=10（能上），但只有 **1.44 格/秒**；坐标无 artifact。 |
| 采集 | 树底 `jungle_log ×3`；跨 6 格水沟 `oak_log ×2` | **不可证**：无对应 bench 场景；`tmp-t59-agent.log` 显示 oak_log 采集**多次 `mined= 0`**（`:137`/`:140`/`:143`），至少在某些地形上不稳。 |
| 水中下沉 | 稳定 1 格/秒 | **成立**：`deepwater-2026-11-03.jsonl` n=10 全 ok，**142 格 / 133.3 s = 1.07 格/秒**，与"1 格/秒"完全吻合。 |
| （表外）`docs/回归-runbook.md:76` | 对基线 50/55，`down5=0/5` 已知边界 | **成立且可复算**（11 场景 ×5 轮 = 55，`down5` 0/5）。 |

另外三条 README 里明确写"已知边界/做不到"的内容，现场支持：
- `down5` **0/10 全失败**（两个归档文件都是 0），README/runbook 已把它列为已知边界 → 一致。
- `water-cross` 只有 **0.72 格/秒**（11 个场景里最慢），`bench_move_actions.mjs:27` 注释也自认"首跑 TIMEOUT 70s，第二跑 42.9s 勉强通过（不稳）" → 一致，但**README 表里没有这一行**，读者会以为所有场景都是秒级。

---

## 7. 发现清单

### Must fix

#### R1　每次 RCON 命令都新建 TCP 连接 → 一条日志 99.7% 是连接噪音
`mindcraft/src/agent/library/rcon_client.js:74`（`const sock = net.connect(port, host)`）与 `:80`（`try { sock.destroy(); }`）；现场：`server-test/logs/latest.log`

**这是什么**：`rcon(command)` 是"执行一条 RCON 命令"的单次函数，每次调用自己 `net.connect` 建连、认证、发命令、`destroy()`。没有连接池、没有复用。

**问题（场景 → 结果）**：一次 15.75 小时的服务端会话里，日志出现 **`Thread RCON Client started` 53,540 次 + `shutting down` 53,540 次，合计 107,080 行 / 107,383 行 = 99.7%**；对应体积 ≈ **8.9 MB**。也就是约 **0.94 次 RCON 命令/秒**，每次都要一次 TCP 握手 + 一次鉴权往返。
具体代价：① 每次查询多付 2 个 RTT（本机也 ≥1-3 ms，跨机更差）；② 服务端为每条命令起一个 RCON 线程（日志里正是 `Thread RCON Client`）；③ 日志把真正的错误淹掉 —— 在这个文件里，`ERROR` 只有 **0** 条可读信号，其余全被淹没。

**最小修复**：把 `rcon()` 改成持有一个长连接（模块级 `let client`，第一次 `connect`+auth 后保留 socket，后续复用；`error`/`close` 时置空重连）。签名不变，所有调用点零改动。再把服务端 `logs/latest.log` 的干扰降下来（顺带把 "started/shutting down" 这类 INFO 在 `server.properties`/log4j 配置里调成 WARN）。

**不修会怎样**：日志每天涨 13.9 MB 而几乎没有信息量；每次位置查询都在付 TCP+auth 的往返，跟随/寻路这类"每秒查几十次"的路径被网络开销拖住；真错误永远埋在这 99.7% 里。

---

#### R2　bot 侧日志没有时间戳 → 任何事故都无法定位到秒，性能无法测量
`mindcraft/tmp-t59-agent.log`（293 行中 `[HH:MM:SS]` 前缀 **0** 条）、`mindcraft/run-live.log`（85 行中 **0** 条）

**这是什么**：agent 侧（`console.log` 全部）输出没有时间前缀；只有 Paper 服务端的日志有 `[HH:MM:SS INFO]`。

**问题（场景 → 结果）**：
- 我无法判断 `tmp-t59-agent.log` 覆盖的 293 行到底横跨 3 分钟还是 3 小时 —— 只能靠文件 mtime（13:45）猜；
- 那两次 `The goal was changed`（`:164`、`:180`）之间隔了多久、是 1 秒还是 10 分钟，**日志无法回答**，于是"是偶发还是每拍都撞"这个最关键的定性也答不了；
- 因此本报告 §4.2/§4.3 的"LLM 耗时""技能耗时排行"**在现有日志上物理不可能算**，不是没做；
- 同一文件里 `[DIG] ... heldMs= 2382` 这类自带耗时的行无法与其他事件对齐时间轴。

**最小修复**：在 agent 入口给 `console.log`/`console.error` 包一层前缀（`new Date().toISOString()`），或直接用 `node --enable-source-maps` 之外的零依赖做法：`import { format } from 'node:util'` 后覆盖 console。**一处改动，全仓日志立刻可对齐。**

**不修会怎样**：每查一次事故都要靠"文件 mtime + 猜顺序"；性能优化无法度量收益；跨 bot / 跨进程的事件无法排序（这对审计②的租约/抢占类问题尤其致命）。

---

#### R3　重启守卫 10 秒 → 服务端重启期间 agent 永久死亡，需人工干预
`mindcraft/src/process/agent_process.js:41-49`；现场：`mindcraft/run-live.err.log` 末行

**这是什么**：父进程（mindserver）在 agent 子进程退出后决定要不要重启，规则是"**距上次启动不足 10 秒就不再重启**"。

**问题（场景 → 结果，日志原文）**：
```
[LoginGuard] Connection Error: Error: read ECONNRESET
Disconnected: {"errno":-4078,"code":"econnrefused","port":25565}
[LoginGuard] Network Error: Connection timed out or was lost.
Agent process exited too quickly and will not be restarted.
```
`run-live.log` 里 `Client connected` 出现 **13 次**（一次启动里反复重连）。这条链是：MC 服务端没起来 → agent 连不上 → 进程退出 → 父进程看到"启动不到 10 秒" → **放弃**。
而 Paper 重启一次通常要 20~60 秒，**正好落在这个守卫的打击范围内**：越是"服务端正在重启"，越会被判成"起得太快"。

**最小修复**：把"退避"换成"指数退避 + 上限"——`delay = min(2^n * 2s, 60s)`，一直重试到成功或用 `--max-restarts`；只在"连续 N 次（如 10 次）都在 10 秒内退出"时才放弃。最小一行改动是把 `return` 改成 `setTimeout(() => this.start(...), 15000)`。

**不修会怎样**：任何一次服务端重启、网络抖动、端口未就绪，都会让 bot **永久下线**且不再自愈；对"挂机跑一夜"这个核心用法是致命的。

---

#### R4　两个驱动者抢同一个 pathfinder goal（审计① N2/N3 的现场取证）
`mindcraft/src/agent/library/flow_follow.js:154`（`while` 内直接 `bot.pathfinder.setGoal(new pf.goals.GoalFollow(...))`）；现场 `tmp-t59-agent.log:164`、`:180`

**这是什么**：`flow_follow` 的跟随循环每 250ms（`:136` 的 `while` + `:201` 的 `sleep(250)`）检查一次目标，并在 `goalEntity !== target.ent` 时**直接**设 pathfinder 目标。同一时刻如果 `walkTo`（executor 的单链路）正在走，mineflayer 的旧 goal 被替换 → 走的那一方抛 `The goal was changed before it could be completed!`。

**问题（场景 → 结果，日志原文）**：
```
:158-163  Unpausing mode unstuck / hunting / item_collecting / torch_placing / elbow_room / idle_staring
:164      [walkTo] 第1轮 步3 walk(6202,-60,8796) 失败: INTERNAL The goal was changed before it could be completed!
:180      [walkTo] 第1轮 步9 walk(6202,-60,8803) 失败: INTERNAL The goal was changed before it could be completed!
```
293 行日志里出现 **2 次**，两次都紧跟在 `Unpausing mode ...` 块之后 —— 即"被恢复的 mode"（`unstuck` 会 `moveAway`、`hunting` 会 `setGoal`）与正在执行的 walkTo 抢 goal。`modes.js:34-39` 的 `restoreGoalModes` 只负责"恢复"，**不知道此刻有人正在走路**。

**最小修复**：走审计① N2 的方案（owner 缺省改自增唯一值 + 12 处直驱改走 `nav_core` 闸）。若只想先止血：`restoreGoalModes` 在 `bot.pathfinder.isMoving()` 为真时延后恢复（一次 `setTimeout`），并且 `flow_follow` 的 `setGoal` 改成走 `nav_core` 的互斥闸。

**不修会怎样**：每次"跟人/打怪/防卡"与"走任务路线"重叠，就白跑一轮规划；现场已经是**每 150 行撞 2 次**的量级，且每次撞掉的是"走到某一格"这一步，代价是整轮重扫重规划。

---

#### R5　日志没有大小轮转，且有 96.7% 的字符是 RC 提示符填充
现场：`mindcraft/tmp/server-test-run.log`（11,680,479 B）；`server-test/logs/latest.log`（9,128,155 B / 15.75 h）

**这是什么**：`server-test-run.log` 是"把 Paper 的 stdout 重定向到文件"的产物；Windows 下 RCON/控制台每次写入都会带回一个 `> ` 提示符，被原样追加。

**问题（可复算）**：
```bash
awk '/^> > >/{s+=length($0); n++} END{printf "lines=%d bytes=%d (%.1f%%)\n", n, s, 100*s/11680479}' \
    mindcraft/tmp/server-test-run.log
# lines=2306 bytes=11295770 (96.7% of file)
awk '{print length($0)}' mindcraft/tmp/server-test-run.log | sort -n | awk '{a[NR]=$1} END{printf "p50=%d p99=%d max=%d\n",a[int(NR*.5)],a[int(NR*.99)],a[NR]}'
# p50=66 p99=51670 max=752766      ← 单行 752 KB
```
11.7 MB 里 **11.3 MB（96.7%）**是 `> > > > ...` 的重复提示符（2306 行），**最长单行 752,766 字符**。它直接导致：任何 `cat`/`head` 这类按行读取都会瞬间刷爆终端（本次审计第一版就踩了），grep 的匹配也会被这行巨物拖慢。

轮转方面：`server-test/logs/` 有 21 个 `.gz` + 1 个 `latest.log`，说明轮转**存在但是"重启时轮转"**；当前 `latest.log` 连续 15.75 小时长到 9.1 MB 没有切分。按此推算：**约 579 KB/小时 ≈ 13.9 MB/天 ≈ 5 GB/年**（`9128155 B / 15.75 h`），而且其中 99.7% 是 R1 的连接噪音。

**最小修复**：① 捕获服务端 stdout 时用 `script`/PTY 以外的干净方式（或直接把 Paper 日志文件当唯一来源，不要二次捕获 console）；② 给 `server-test/logs` 打开按大小轮转（Paper 的 `log4j2.xml` 里给 `RollingRandomAccessFile` 加 `SizeBasedTriggeringPolicy size="20 MB"` + `DefaultRolloverStrategy max="10"`）。

**不修会怎样**：仓库里最大的一个文件 96.7% 是垃圾，且它会让人**不敢看日志**（一 `cat` 就卡死）；磁盘按 5 GB/年 稳定增长且无上限。

---

#### R6　bench 归档被污染，"对照"文件与"基线"文件其实是同一批数据
`mindcraft/tmp/bench/archive/2026-11-01-move-actions.control-m2.jsonl`（424 行）vs `...baseline-m2-ACCUMULATED-MIX.jsonl`（297 行）

**这是什么**：`bench_move_actions.mjs` 用 `appendFileSync` 追加写（`:63`、`:309`），文档明确要求"跑前先 `mv` 归档"（`:59-63`）。

**问题（可复算）**：两个文件按 `(scenario, round)` 去重后**完全一样**：
```
baseline-m2-ACCUMULATED-MIX: lines=297 去重=110 重复=187
control-m2                : lines=424 去重=110 重复=314
两者去重后统计完全相同：n=110 ok=99 moved=1827格 ms=928.8s => 1.97格/秒
```
也就是说 `control-m2`（本该是"改后对照"）里**没有一条新记录**，只是把 baseline 又追加了一遍。文件名里的 `ACCUMULATED-MIX` 本身就是事故自白。

**最小修复**：`bench_move_actions.mjs` 开跑时若目标文件已存在，**自动改名归档**（`fs.renameSync` 到 `archive/<stamp>-<tag>.jsonl`）而不是静默追加；并在每行里写入 `runId`（进程启动时间戳），分析时按 `runId` 过滤。

**不修会怎样**：任何人拿这两个文件做 A/B 会得出"改动没有任何效果"（或更糟：重复计权后得出任意结论）；这个项目已经因此踩过一次（t6 的"混了 15 轮历史"）。

---

### Should fix

#### R7　`down5` 100% 失败、`water-cross` 只有 0.72 格/秒，但 README 的能力表里看不到
`mindcraft/tmp/bench/archive/*.jsonl`（`down5` n=10 **ok=0**，两个文件都是）；`water-cross` 0.72 格/秒；对照 `README.md:36-46`

**这是什么**：能力宣称表。`down5`（连续下 5 格）与 `water-cross`（过 5 格宽水池）是两个**从未通过**或**极慢**的场景。

**问题**：`docs/回归-runbook.md:76` 老实写了"`down5=0/5` 是已知边界"，但**面向读者的 README 表里一个字都没有**，读者（以及未来的维护者）会以为导航已经是"全场景可用"。具体后果：`down5` 每次回归都是红的，看日志的人会以为是新引入的回归，从而浪费时间在"修复"一个已知边界上。

**最小修复**：在 `README.md` 的能力表下面加两行"已知边界：`down5` 0/10（垂直下落 >2 格不通过）、`water-cross` 0.72 格/秒"，与 runbook 对齐。

**不修会怎样**：每轮回归都要重新发现一次"这是个已知失败"，并且对外宣称的可用性与实测数据自相矛盾。

#### R8　LLM 成本与延迟零记录 → 无法回答"花了多少钱、慢在哪"
全仓日志 `prompt_tokens|completion_tokens|usage|tokens` 命中文件数 = **0**

**这是什么**：模型调用层（`models/`）只打印 `Awaiting openai api response from model deepseek-v4.1-flash` / `Received.`，不打 usage、不打耗时。

**问题**：单人挂机一夜的核心成本项（token 费用、每次决策延迟）**完全不可观测**。举例：一次"挂机 8 小时"到底花了多少 token、平均每次决策等了多久，现有日志一个字都答不出；模型变慢时也无法与"网络慢/服务端慢"区分。

**最小修复**：在模型响应处打一行结构化日志：`[llm] model=… prompt=… completion=… ms=…`（多数 provider 的响应体就带 `usage`）。若 provider 不返回，至少打 `ms` 与 `prompt 字符数`。

**不修会怎样**：无法做任何成本/延迟优化决策；账单只能等 provider 后台看，且与具体 bot 行为对不上。

#### R9　`Digging aborted` 的中止者不存在于任何日志里（5/9 次）
`tmp-t59-agent.log:171`：`reason= Digging aborted | heldMs= 2382 budget= 6500 | interrupted= false timedOut= false | inFlight= 0`

**这是什么**：`[DIG]` 是挖掘原子自带的埋点，它已经排除了三种中止原因（被打断、超时、在飞行中），结论是"**中止来自流程之外**"。

**问题**：这样的行 9 条，其中 5 条明确 `interrupted=false timedOut=false`。中止者（R4 的另一个驱动者 / `mobGoal` 被替换 / 服务端拒绝）**没有任何一方在日志里承认**，于是 `[MINE] dig false INTERNAL ... mined= 0 / 1` 被当成"挖掘失败"上报，最终可能把重试次数耗光变成 `blocked`（正是 B3 那条链）。这是典型的**静默失败**：日志有现象、无责任方。

**最小修复**：在 `[DIG] err` 那行把当前 pathfinder goal（`bot.pathfinder.goal?.constructor?.name`）与 `bot.modes` 的暂停状态一并打出来；一个字段就能指认中止者。

**不修会怎样**：同一类"挖不动"会被反复误判成"没有镐/没有路"，而真正的原因是有人在抢 goal —— 这也是 B3 现场那条 `NO_TOOL` 的最可疑上游。

#### R10　服务端日志里没有任何 tick 性能信号（无 `Can't keep up`），也就无法证明"服务端不是瓶颈"
`server/*.log` + `server-test/logs/latest.log`：`Can't keep up` 命中 **0**

**这是什么**：Paper 在 tick 超时（>50ms）时会打 `Can't keep up! Is the server overloaded?`。全仓一次都没有。

**问题**：这是个**好**消息（服务端从未掉 tick），但报告不能只靠"没出现"：默认值下 `max-tick-time` 与日志阈值可能让它不打印。也就是说"服务端很健康"这个结论的强度只有"没看见告警"，没有"TPS 数字"。而项目的一大风险假设正是"N1 的同步扫描会不会把服务端搞崩"。

**最小修复**：用 `/tps`（Paper 内建）或 `spark` 在每次真机验收时采一次 TPS 记进验收报告；或打开 `paper-global.yml` 的 tick 诊断。

**不修会怎样**：下次出现"她卡卡的"，仍然分不清是 bot 的 JS 阻塞、网络、还是服务端 tick。

#### R11　`Unpausing mode` 36 次 / `Pausing mode` 0 次 —— 日志只记一半
`tmp-t59-agent.log`（`grep -c "Unpausing mode"` = 36，`grep -c "Pausing mode"` = 0）；代码 `modes.js:22-32`（`pauseGoalModes` 不打日志）vs `:34-39`（`restoreGoalModes` 由 mineflayer 打）

**这是什么**：mode 的暂停/恢复是一对操作，但只有"恢复"那半出现在日志里（mineflayer `modes` 自己打的）。

**问题**：看日志的人会以为"只有恢复、没有暂停"，从而误判"这些 mode 一直没被暂停过"，进而怀疑 `pauseGoalModes` 没生效。而实际上 R4 的 goal 冲突恰恰发生在"恢复"之后 —— **需要的是那半没打的日志**。

**最小修复**：`pauseGoalModes` 里加一行 `console.log('[modes] pause', names.join(','))`，与恢复对称。

**不修会怎样**：R4 这类冲突的因果链永远缺前半段。

#### R12　`[MINE] dig true OK ... mined= 13 / 3`（4.3 倍超采）混在正常日志里
`tmp-t59-agent.log:288`

**这是什么**：一次挖石头报成功，实际挖了 13 个，而 want 是 3。

**问题**：超采在语义上有价值（说明 want 定小了），但**日志语气是 OK**，`grep OK` 的人会把这条当正常记录。这与审计② B6/`mergeProgress` 那条"count 只许往上"的设计遥相呼应：库端不截断是对的，但**日志端应当标记"超额"**，否则回溯时无法区分"正好做完"和"做了 4 倍"。

**最小修复**：`mined > want` 时把 `OK` 改成 `OK(OVER)` 并加 `over= N-want` 字段。

**不修会怎样**：采集/合成的实际效率与资源浪费无法从日志发现。

---

### Nice to have

#### R13　`server-test/logs` 的轮转是"重启驱动"，长会话会无限长
`server-test/logs/`：21 个 `.gz` + `latest.log`（9.1 MB / 15.75 h）

**这是什么**：现有轮转只在服务端重启时把 `latest.log` 压成 `.gz`。

**问题**：不重启就一直涨。按实测速率 579 KB/h 推算，连续跑 7 天 ≈ 97 MB 单文件；再叠加 R1 的 99.7% 噪音。

**最小修复**：见 R5 的 `SizeBasedTriggeringPolicy`（本质是同一处改动，R5 是"根因+当下最大的文件"，R13 是"当前服务端的配置"）。

**不修会怎样**：单文件大到编辑器打不开，且 `grep` 全扫越来越慢。

#### R14　README 的「302 格推进 168 格」不可复算，建议直接删掉这个数字
`README.md:40`、`docs/交接文档.md:129`

**这是什么**：一句没有 artifact 的历史真机记录。

**问题**：它旁边的"1.41 格/秒"同样不可复算（§4.1）。留着两个查不到来源的数字，会让后来者以为有一个"官方基线"可以去对比，而实际 bench 里跑的是 `long-route` 56 格 / 18 s。

**最小修复**：换成"bench 可复算口径"：`long-route 10 轮 100% 通过，3.12 格/秒（2026-10-31，tmp/bench/archive/2026-10-31-move-walkto.pre-t6.jsonl）`。

**不修会怎样**：下一个人优化完导航，无法用 README 的数字证明自己变快了或变慢了。

---

## 8. 磁盘与日志卫生建议（按性价比排序）

1. **先做 R2**（bot 日志加时间戳）：一行代码，立刻让所有后续分析成为可能。当前"没有时间戳"是整个 §4 无法计算性能的**唯一**原因。
2. **再删掉那 11.3 MB 的 `> > >` 垃圾**（R5）：`mindcraft/tmp/server-test-run.log` 可以直接删（内容 96.7% 无信息，剩余部分与 `server-test/logs/*.gz` 重复）。回收 11.7 MB ≈ 全仓日志的 **47.7%**。
3. **RCON 长连接**（R1）：同时解决"日志噪音 99.7%"和"每命令 2 个 RTT"两件事，一处改动。
4. **服务端日志按大小轮转**（R5/R13）：`size=20MB, max=10`，上限 200 MB。
5. **bench 开跑自动归档 + 写 runId**（R6）：防止第二次"ACCUMULATED-MIX"。
6. **`server-test-run.log` 这类 stdout 二次捕获直接停用**：Paper 自己的 `logs/latest.log` 已经是权威来源，再捕获一次只会引入 PTY 噪音。

当前账（可复算）：全仓 **23.3 MiB / 184 个文件**；其中 **11.3 MiB（46.2%）是纯提示符填充 + 9.1 MiB（37.2%）是 RCON 连接噪音** → **83% 的日志字节没有诊断价值**（`(11295770 + 9128155×0.997) / 24469026 = 83.0%`）。

---

## 9. 未验证部分（明确边界）

- **没有一次"多 bot + 面板 + 长跑"的现场**：所有日志里只有 `deepseek` 一个 bot。因此审计② 的 B1（租约双写）、B6（镜像截断）**无法用日志证实或证伪**。
- **没有任何 LLM 侧数字**（R8）：token、延迟、花费都不可得；§4.2 的结论是"不可测量"，不是"很便宜/很贵"。
- **`surveyArea` radius=64 的阻塞量级未实测**（N1）：110 万次 `blockAt` 是代码推算；唯一的现场反证是"那次掉线时事件循环延迟 162 ms（正常）"。
- **性能数字全部来自 2026-10-31 / 11-01 / 11-03 的 bench**，不是最近一次（11-05）的真机；最近那次只有一份 293 行的短日志，没有性能埋点。
- **`down5` 0% 与 `water-cross` 0.72 格/秒**只统计了 10 轮/场景，样本小；且 `bench_move_actions.mjs` 自述这两个场景"不稳"。
- **崩溃报告只有 1 份**（2026-10-30），不能代表崩溃分布；`session.lock` 那次的"另一个进程"究竟是谁（残留 java / 双开 / 杀软）日志没写，**未定位**。
- **`The goal was changed` 我只见到 2 次**，样本不足以估计发生率（R4 的"每 150 行 2 次"只是这 293 行的局部密度，不能外推）。
- 未运行任何东西：没有启动服务端、没有跑 bench、没有复现任何一条竞态。所有"次数/体积/速率"均来自静态日志与 jsonl 的离线统计。
