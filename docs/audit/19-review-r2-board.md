# 终审 R2②：任务板线 —— 第 15 条产出账实测 + board 全线回归 + I7/I14 现状

审查对象：`mindcraft` 分支 `audit/remediation-2026-11-05`（相对 `main` **26 提交 / 138 文件**）。
本轮范围：任务板线（第 15 条新修 + 全线回归 + I7/I14 现状）。
规程：`docs/audit/REVIEW-PROTOCOL.md`（含 R1 后新增 §3.5「探针可能给假绿」）。
**未改 `mindcraft/` 任何文件**（`git status` 为空）。新增探针：`docs/audit/probes/t25-craft-ledger.mjs`。

---

## 1. 判定总表

| 项 | R1 判定 | 本轮判定 | 三态 | 证据 |
|---|---|---|---|---|
| **第 15 条** 重复扣料 | 部分修好（有限次、无账） | **真修好** | **已实测** | 自写探针 4 场景 **16/16 通过**：增量语义正确、无第 3 次尝试、幂等、失败分支不虚记（§2） |
| **第 3 条** 板库被当坏库重建 | 真修好 | **通过（无回退）** | **已实测** | 锁冲突复跑：`rebuilt=false`、无 `.corrupt-`、单子 1 行完好、**4205ms ≈ busy_timeout(5000)**；holder 在 **DELETE journal** 下持 EXCLUSIVE 16s |
| **第 24 条** schema 不匹配 | 真修好 | **通过（无回退）** | **已实测** | `rebuilt=false`、`migration={added:[interrupted,repeat_ms,dependsOn],from:1,to:2}`、行数 1→1 |
| **第 25 条** 记忆损坏留备份 | 真修好 | **通过（无回退）** | 静态确证 | `memory_store.js:88` `${p}.corrupt-${Date.now()}` 仍在 |
| **第 4 条** finish 校验租约 | 真修好 | **通过（无回退）** | 静态确证 | `leaseGuard` 仍在（**行号 803→922**，因新账本代码 +119 行）；另新增 fail-closed：未传 bot 且租约仍在别人身上 → `LEASE_STALE`（`:908-921`） |
| **第 5 条** 死依赖→blocked | 真修好 | **通过（无回退）** | 静态确证 | `depDead` 5 处仍在；`board_store_converge_unit` 的 **②-6 已从 XFAIL 升为硬断言** |
| **第 6 条** `!stop` 链路 | 真修好 | **通过（无回退）** | 静态确证 | `runJobAction` 6 处引用仍在 scheduler；`board_stop_unit` 6/6 通过 |
| **第 14 条** `LIMIT 200` | 真修好 | **通过（无回退）** | 静态确证 | `openOnly` SQL 谓词仍在 `board_store.js:507`；`board_openonly_unit` 6/6 |
| **第 17 条** 幽灵父单 | 真修好 | **通过（无回退，但已改名）** | 静态确证 | `reopenOrphanParent` → **改名 `blockOrphanParents`**（`board_store.js:1615`），接在 `board_server.js:459` 的扫描定时器里；`board_orphan_parent_unit` 23/23 |
| **I14** `task_id` 拼路径穿越 | 从未进任何轮 | **已修好（意外收获）** | **已实测** | `task_id='logs/../../../../tmp/x'` → **`THROW 路径逃逸已拦截`**（§4） |
| **I7** 退出不回收子进程 | 从未进任何轮 | **仍存在** | 静态确证 | 全仓 `process.on('exit'/'SIGINT'/'SIGTERM')` = **0 处**；`killAll()` 只被任务逻辑调用（§4） |

**board 单元测试成绩单：18 个文件逐个直跑，全部 exit=0，合计 253 条用例 / 0 失败**（§3）。

---

## 2. 第 15 条：实测扣料次数（验收硬要求）

探针：`docs/audit/probes/t25-craft-ledger.mjs`（只调 store，不需要 bot/模型/服务端）

```
=== 场景 A：部分产出后重试（want=2，两次各产 1）===
  [claim1]  state=claimed attempts=0 attemptSeq=1 progress.count=0
  [finish1] state=ready   attempts=1 producedTotal=1 producedAttempt=1 countedSeq=1 progress.count=1
  ✅ A2 第一次后 producedTotal=1（记了增量）
  ✅ A3 未达标 → 回 ready 重试
  ✅ A4 TIMEOUT 计了 1 次 attempts
  [claim2]  state=claimed attempts=1 producedTotal=1 attemptSeq=2
  [finish2] state=done    producedTotal=2 producedAttempt=1 countedSeq=2 progress.count=2
  ✅ A7 累计 producedTotal=2（不是背包总量、不是单次）
  ✅ A8 账到 want → done
  ✅ A9 ★ 不会再有第 3 次尝试（= 不多扣第三份料）  —— claimFor 返回 null

=== 场景 B：已产满但被中断（原病灶最狠的一种）===
  [finish(INTERRUPTED, produced=2)] state=done producedTotal=2 countedSeq=1
  ✅ B2 ★ 账已满即 done（不再回 ready 重做一遍 → 不会第二次扣料）
  ✅ B3 ★ 不会被重新领走再产一遍  —— claimFor 返回 null

=== 场景 C：幂等（同一次尝试 finish 两次）===
  [finish#1] producedTotal=1  [finish#2] producedTotal=1
  ✅ C1 ★ 重复 finish 不重复记账（countedSeq 兜住）  —— 第一次 1 → 第二次 1
  ✅ C2 progress.count 也是 1（与账一致，未翻倍）

=== 场景 D：账本只认「真件数」，不认背包总量 ===
  [finish(失败, progress.count=9 但 data.produced=1)] producedTotal=1
  ✅ D1 ★ 失败分支只记 produced=1，没把背包总量 9 当产出（防虚记→提前 done）
  ✅ D2 没被虚记骗成 done

===== 汇总：16 通过 / 0 失败 =====
```

### 2.1 完整链路（派单 → 执行 → finish → 收敛）

```
① 派单/领单   claimFor()                       board_store.js:643
      checkpoint.attemptSeq = (上次||0) + 1     ← **每次领单打一个新序号**
      （不能用 attempts：attempts 只在 finish 计数时才 +1，
        分不开"同一次尝试重复 finish"与"下一次尝试"）
                    ↓
② 执行        act_craft 返回
      data.produced       = after - before（**本次真件数**）
      data.producedTotal  = 同值            act_craft.js:389/446
      fail 分支也带 produced*              act_craft.js:362/365
                    ↓
③ 取"本次产出" craftProducedOf(result)         board_store.js:711-723
      ① data.producedTotal → ② data.produced → ③ progress.count **仅在 ok===true 时**
      ④ 都没有 → 0（不猜）
      ★ 失败分支**不采信** progress.count：flow_craft 失败时那里是 limit（合成**次数**），
        拿次数当件数会**虚记**，账报大了会被判"已达标"而提前 done —— 注释把这条写清楚了
                    ↓
④ 结算账本    settleCraftLedger(job, result)   board_store.js:745-764
      prevTotal  = checkpoint.producedTotal || 0
      alreadyCounted = (countedSeq === attemptSeq) ? producedAttempt : 0
      delta      = max(0, reported - alreadyCounted)      ← **增量**，同一次尝试重复 finish 得 0
      producedTotal = prevTotal + delta                   ← 单调不减
                    ↓
⑤ 完成判据    finish()                          board_store.js:814-820
      ledgerSatisfied = isCraftJob && want>0 && ledger.producedTotal >= want
      completed = ledgerSatisfied || (okFlag && (isCraftJob || want<=0 || count>=want))
      ★ 第一个析取项就是"账够了直接 done"→ **不再回 ready 重跑 → 不再二次扣料**
                    ↓
⑥ 落库        checkpointForWrite / progressForWrite   board_store.js:932-943
      checkpoint.producedTotal / producedAttempt / countedSeq   ← 唯一持久处
      progress.count（craft）= max(旧, 累计产出)                ← 原来是"背包总量"
```

### 2.2 三个关键判据都过

| 判据 | 结果 |
|---|---|
| `producedTotal` 是**增量语义**还是"背包总量"？ | **增量**：`prevTotal + delta`，`delta = reported − alreadyCounted`。场景 A 里 1→2，场景 D 里背包总量 9 **没被采信**（记 1） |
| 崩 1 次后再成功，最终是否多扣？ | **不多扣**：场景 A 只有 2 次尝试（各产 1 件，真扣 2 份料 = 真实需要），**无第 3 次**；场景 B（产满后被中断）**直接 done**，一次都不会再跑 |
| 同一张单 finish 两次会不会重复收敛？ | **不会**：`countedSeq===attemptSeq` 时 `delta=0`（场景 C：1→1） |

### 2.3 如实记录的边界（代码自己写了，我复核成立）

`settleCraftLedger` 注释 `:738-741` 声明：**checkpoint 只在 finish 时落库**。进程被 SIGKILL 时这次尝试走不到 finish → 这次产出记不进库 → 重试仍会重做一份。**这个残留是真实的**，但它覆盖不了的情形恰好不是"重试重复扣料"的原发场景（原发场景是 INTERRUPTED / 部分产出后失败 / 被抢占后收尾——都走到 finish）。**判定：真修好，附这一条已知边界，不算缺陷。**

---

## 3. 回归检查表（board 全线）

### 3.1 单元测试成绩单（18 个文件逐个直跑；`unit_all` 的 `0/64` 是 EPERM，**不是失败**）

| 测试 | exit | 结果 |
|---|---|---|
| board_add_recall_unit | 0 | 6/6 |
| board_b3_unit | 0 | 23/23 |
| board_b4_unit | 0 | 11/11 |
| board_cmd_unit | 0 | 11/11 |
| **board_craft_ledger_unit**（第 15 条新增） | 0 | **10/10** |
| board_iface_unit | 0 | 16/16 |
| board_lease_expire_unit | 0 | 9/9 |
| board_nofallback_unit | 0 | 7/7 |
| board_open_migrate_unit | 0 | 8/8 |
| board_openonly_unit | 0 | 6/6 |
| board_orphan_parent_unit | 0 | 23/23 |
| board_payload_unit | 0 | 14 PASS / 0 FAIL |
| board_scheduler_unit | 0 | 34/34 |
| board_scope_unit | 0 | 10 PASS / 0 FAIL |
| board_stop_unit | 0 | 6/6 |
| board_store_converge_unit | 0 | 12/12（**②-6 已由 XFAIL 升硬断言**） |
| board_store_finish_unit | 0 | 22/22 |
| board_store_unit | 0 | 25/25 |
| **合计** | **18/18 exit=0** | **253 条用例 / 0 失败** |

### 3.2 关键探针复跑（§3.5 要求：**必须声明 journal 模式 + 报耗时**）

```
$ node docs/audit/probes/t20-board-open.mjs hold <dir> 16000        # 后台 holder
[hold pid=33312] BEGIN EXCLUSIVE OK  模式=delete  保持 16000ms
[hold] 库内行数=1  size=45056
[hold] 释放                                    ← 实际持有 16s

$ node docs/audit/probes/t20-board-open.mjs probe <dir>             # 锁窗口内
[probe] 打开前：exists=true size=45056 目录=["board.sqlite"]
[probe] openBoard 正常返回（4205ms）            ← ≈ busy_timeout(5000)，说明真撞上锁
[probe]   rebuilt = false
[probe]   backup  = (none)
[probe]   jobs 行 = 1
[probe] 是否出现 .corrupt- 备份：无
[probe] 判定：✅ 好库没被删/改名
```

**journal 模式声明**：holder 用 `PRAGMA journal_mode = DELETE`（不是 WAL）——按 §3.5，WAL 下读者不被写者阻塞，会给出**假绿**。
**耗时判据**：本轮 **4205ms**，R1 同探针为 5069ms，两者均为 `busy_timeout(5000)` 量级 ⇒ 确实撞到了锁。
（如实说明：本轮比 R1 少 ~860ms，我未逐毫秒追查差异来源；但 `rebuilt=false / 无 .corrupt- / 单子仍在` 这三条被测行为在本轮与 R1 完全一致。）

### 3.3 schema 不匹配（第 24 条）

```
[schema] 造好旧库：user_version=1 jobs=1 列数=23
[schema]   rebuilt  = false
[schema]   migration= {"added":["interrupted","repeat_ms","dependsOn"],"from":1,"to":2}
[schema]   表里行数 前=1 后=1
[schema] 判定：✅ 迁移成功、未重建、单子全在
```

### 3.4 回归结论

**全部通过，无回退。** 两处**行号漂移**（不是回退，但按旧行号改代码会找错地方）：
- `leaseGuard`：`board_store.js:803` → **`:922`**（第 15 条新增 ~119 行账本代码所致）
- 第 17 条函数：`reopenOrphanParent` → **`blockOrphanParents`**（`board_store.js:1615`，接在 `board_server.js:459`）

---

## 4. I7 / I14 现状

### 4.1 I14（`task_id` 拼日志目录）—— **已修好（已实测），但不是靠"校验 task_id"**

`ce053e3` 把 prompter 的日志路径改成走 **prompter 自己的** `botDirOf(name, sub, botsRoot)`（`src/models/prompter.js:33`），该函数在 `:44-51` 做 `path.resolve` + `startsWith(botsRoot + sep)` 断言。`task_id` 进了 `sub` 参数，所以穿越被 `resolve`＋断言拦住。

我用**正确的那个函数**实测（第一次我误用了 `bot_paths.botDirOf` 的 1 参版本，差点误报，见 §6）：

```
1 正常:            OK:   ...\mindcraft\bots\deepseek\logs
2 正常带 task:     OK:   ...\mindcraft\bots\deepseek\logs\task_abc
3 task_id 穿越:    THROW 非法 agent 名（路径逃逸已拦截）: "deepseek"
4 name 穿越:       THROW 非法 agent 名（路径逃逸已拦截）: "../../pwn"
5 空名:            THROW 非法 agent 名（为空）: ""
6 只空格:          THROW 非法 agent 名（为空）: "   "
```

**判定：I14 已修好（已实测）。** 对比 `main`（`prompter.js:371-375` 直接 `path.join(__dirname, '../../bots/${name}/logs/${task_id}')`，`task_id` 完全不校验）——**本轮确实修掉了，且顺带覆盖了 `name` 本身**。

`5d28800`（提示词日志门控）只动了 `hyperbolic.js:50`（`LOG_PROMPTS==='1'` 门控），**没有碰 prompter / task 路径** ⇒ **对 board 无影响**。

### 4.2 I7（退出不回收子进程）—— **仍存在**

```
$ grep -rn "process.on('exit'|'SIGINT'|'SIGTERM')" src/ main.js
（0 处命中）
$ grep -rn "killAll" src/
src/agent/agent.js:895   killAll() { ... }        ← 定义
src/agent/agent.js:890   this.killAll();          ← 任务逻辑里调
src/agent/tasks/tasks.js:495/509/576  this.agent.killAll();   ← 任务逻辑里调
```

**问题（具体场景 → 结果）**：mindserver 被 `Ctrl-C` / `kill` / 崩溃时**没有任何全局钩子**去 `SIGINT` 它 spawn 的 agent 子进程 → **子进程成为孤儿**继续运行。对任务板的具体后果：孤儿 agent 仍持有 `board_client`、**继续领单与心跳续租**，面板上"这只 bot 在跑"看起来正常，实际主控已经退出——**无法从面板停它，只能手工 `taskkill`**。这也让第 4 条（租约）与第 6 条（`!stop`）在孤儿场景下失效：没有人能给它发停止指令。

**判定：仍存在，从未进入任何一轮编号。** 定级 **Should**（不是数据丢失、不是外部安全洞，但会产生不受控的 op 账号进程 + 幽灵 worker）。最小修复：mindserver 侧加
`for (const s of ['SIGINT','SIGTERM']) process.on(s, () => { killAllAgents(); process.exit(0); });`
（约 5 行）。

---

## 5. 我提的两条（都属 Should，都不挡门）

### N1（R2）I7 仍是未修项 —— 见 §4.2
建议进下一轮编号（它已在 R1 复核报告的"9 条从未进编号"清单里，本轮确认**仍未修**）。

### N2（R2）craft 单的 `progress.count` 仍可能显示"背包总量"，虽然不影响判定
- 现象：我的场景 D 里喂了 `progress.count=9`（模拟背包总量）而 `data.produced=1`，结果 `checkpoint.producedTotal=1`（对）但 **`progress.count` 落库为 9**（`board_store.js:932-935` 对 craft 取 `max(progress.count, producedTotal)`）。
- **为什么不是 bug**：craft 的完成判据（`:819-820`）与库存收敛（convergeIfSatisfied 跳过 craft）**都不读 `progress.count`**，所以不会导致"假 done"。它只影响**面板显示**（会出现"9/2 超额"这种读数）。
- 定级 **Nice**。若要让面板更诚实，可在 craft 单写进度时忽略调用方给的 count，只用 `producedTotal`。

---

## 6. 我在本轮自查中差点犯的两个误报（记下来防后人重踩）

1. **测错函数**：我一度以为 `prompter.js:439` 传给 `botDirOf` 的第 2、3 个参数被忽略（因为 `bot_paths.botDirOf` 只收 1 个参数），并据此推出"所有 bot 的日志都落到 `bots/agent/`、注释在撒谎"。**实际上 prompter 有自己的本地 `botDirOf`（3 参 + 断言）**，我从 `bot_paths` 导入测的是另一个函数。用正确的函数复测后，I14 是真修好。
   → **教训：同名的两个函数，测之前先确认被测模块 import 的是哪一个**（本项目已多次栽在"同一件事两个真相"）。
2. **把改名当回退**：`reopenOrphanParent` grep 零命中，我一度判"第 17 条回退了"。实际是改名为 `blockOrphanParents` 并接在扫描定时器上。
   → **教训：函数找不到时先查 `*_unit.mjs` 的 import 清单**（测试引用了 `blockOrphanParents`，一步就能确认是改名）。

---

## 7. 结论

**`PASS`（不 BLOCK）。**

理由：
1. **第 15 条真修好了，且是实测的**：16/16 通过，四个关键语义（增量、不重跑、幂等、不虚记）逐条验证。这是我 R1 判"部分修好"的那条，本轮补齐了缺失的"账"，并且**做法比我建议的更稳**——不止记 `producedTotal`，还用 `attemptSeq/countedSeq` 做了同尝试去重（我 R1 只建议了"记 producedTotal"，作者多做了幂等那一层）。
2. **board 全线无回退**：18 个测试全绿（253 用例 / 0 失败），锁冲突（DELETE journal，4205ms）与 schema 迁移两个数据丢失场景复跑通过。
3. **I14 顺带修好了**（已实测，含 `name` 本身的穿越）。
4. **R2 的新改动没有碰坏 board**：`5d28800` 只动 `hyperbolic.js` 的日志门控与 preflight 正则，与 board 无交集。
5. **唯一的遗留是 I7**（退出不回收子进程）：仍是 Should，不进编号就无法跟踪；但它**不是本轮引入**、也**不是数据丢失/安全洞**，够不上 BLOCK。

**给作者的 2 条（按性价比）**
1. **I7**：mindserver 加 SIGINT/SIGTERM 钩子回收 agent 子进程（≈5 行）。这条不修，孤儿 agent 会继续持有任务板租约，让第 4/6 条的防护在"主控已退出"场景下形同虚设。
2. **N2（Nice）**：craft 单写 `progress.count` 时忽略调用方给的 count，只用 `producedTotal`，避免面板出现"9/2"这种读数。

**R1 的两条我已在新提交里看到被修**：`5d28800` 修了 `hyperbolic.js` 的 `Messages:` 无条件落盘（改 `LOG_PROMPTS==='1'` 门控，`hyperbolic.js:50`）与 preflight 正则词法盲区（改 `["']([A-Z0-9_]+)["']`，`preflight.mjs:61`）——即我 t23 提的 N1/N2。
