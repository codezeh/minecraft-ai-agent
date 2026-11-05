# 终审 R1②：任务板与运行时（第 3/4/5/6/7/14/15/16/17/19/24/25/31/32 条）

审查对象：`mindcraft` 分支 `audit/remediation-2026-11-05`（相对 `main` 20 提交 / 126 文件）。
本轮范围：任务板 / 持久化 / 运行时线，共 14 条。
纪律：**不看提交信息说修了什么，只看代码是否真的修对了。**
基线：`docs/audit/00-REPORT.md` v2.1；规程：`docs/audit/REVIEW-PROTOCOL.md`。

**未改 `mindcraft/` 任何文件**（`git status` 为空）。新增探针均落在 `docs/audit/probes/`。

---

## 1. 判定总表

| 条 | 判定 | 三态 | 关键证据 |
|---|---|---|---|
| **3** 板库被当坏库重建 | **真修好** | **已实测** | 真实 `EXCLUSIVE` 锁持有 16s 期间调 `openBoard`：`rebuilt=false`、无 `.corrupt-`、单子仍在、耗时 5069ms（≈`busy_timeout`5000，说明真撞上了锁）；判据 `isCorruptError` 只认 `errcode 11/26`（`board_store.js:219,235-240`），其余 rethrow（`:282-286`） |
| **24** schema 不匹配走重建 | **真修好** | **已实测** | 旧库（缺 `priority` 等 4 列）→ `rebuilt=false`、`migration={added:[priority,interrupted,repeat_ms,dependsOn],from:1,to:2}`、`user_version` 1→2、**行数 1→1 未丢**。顺序"先迁移再跑 SCHEMA"是关键（`:265-271`） |
| **25** memory_store 损坏不备份 | **真修好** | **已实测** | 坏 JSON → 产出 `chests.json.corrupt-<ts>`，仍返回 fallback 不抛（`memory_store.js:76-89`） |
| **4** `finish()` 不校验租约 | **真修好** | 静态确证 | `leaseGuard = ' AND (lease_owner IS NULL OR lease_owner = ?)'`（`:803`）；`changes===0` → `LEASE_STALE` 且一字段不写（`:795-833`） |
| **5** 死依赖→父单永久 running | **真修好** | 静态确证 | `depDead()`（`:1371`）+ `markDepDeadBlocked`，在 `:1230`、`:1256` 两条 reopen 路径与 `:1341` 生效；`result.code=DEP_DEAD`（`:97`） |
| **6** `!stop` 三处断链 | **真修好** | 静态确证 | 断点①`runJobAction` 真被调用（`board_scheduler.js:698`）；②`control.js:261` `agent?.scheduler?.setAutoClaim?.(false)`；③`pausedReason` 真写入（`control.js:170`，存 `checkpoint`）；断点④改用"暂停态不被 finish 覆盖"（`board_scheduler.js:724-730`） |
| **7** 重启守卫永久死亡 | **真修好** | 静态确证 | 指数退避 `min(2000·2^(n-1), 60000)`（`agent_process.js:14,17,25-27`），"10 秒即永久放弃"已删 |
| **14** `LIMIT 200` 截断 | **真修好** | 静态确证 | 全链路：客户端 `scope==='claimable' → openOnly=true`（`board_client.js:312`）→ 服务端强制（`board_server.js:189`）→ SQL `state NOT IN ('done','failed','cancelled')`（`board_store.js:507`） |
| **15** 租约回收不记 attempts | **部分修好** | 静态确证 | `expireLeases` 现在 `attempts=?`、`assignee=NULL`、耗尽→`LEASE_EXPIRED`（`:1445` 区段 UPDATE）——**但 craft 的重复扣料链未消除**（见 §3.2） |
| **16** 共享箱读改写丢更新 | **真修好** | 静态确证 | 生产侧改为原子合并 `board.sharedMerge(key, delta, …)`（`flow_store.js:84`），不再 `sharedGet`+`sharedPut`；链路 `board_client.js:437` → `board_server.js:376` → store `mergeSharedChest` |
| **17** 幽灵父单（0 子单） | **真修好** | 静态确证 | `reopenOrphanParent`（`:1445` 起），`ORPHAN_PARENT_MS=120s`，落 `blocked` + `result.code=ORPHAN_PARENT`（`:1488-1493`） |
| **19** 退出码>1 杀 mindserver | **真修好** | 静态确证 | `agent_process.js` 中 `if (code > 1) process.exit(code)` **已不存在**（仅剩解释性注释 `:46`） |
| **32** 心跳 `while(true)` 无 try/catch | **真修好** | **已实测** | `runHeartbeatLoop` 的 `try/catch` **在 while 内部**（`heartbeat_loop.js:15` while → `:18-27` try/catch，且不 rethrow）。实测：第 2 拍抛异常，循环仍跑满 5/5 拍 |
| **31** 失败伪装成模型的话 + 零 usage | **真修好** | 静态确证 + 部分实测 | `My brain disconnected` 全仓 **0 处**；失败改为 `FAILED_REPLY='[LLM_ERROR]'` + `isFailedReply()`（`_shared.js:25-34`），**消费端真认**：`agent.js:629` `break`（不写 history、不 routeResponse）；`recordUsage` 覆盖 **19/19 适配器**（azure 继承 GPT，无自己的 `sendRequest`）；429 退避三处齐（hyperbolic:44 / ollama:45 / replicate:88）。**但契约仍是 `Promise<string>` 字符串前缀，不是 ok/code 通道**（见 §3.3） |

**汇总：真修好 12 条、部分修好 1 条（第 15）、没修 0 条、修出新问题 0 条。**

---

## 2. 第 3 / 24 条实测输出（验收硬要求）

探针：`docs/audit/probes/t20-board-open.mjs`（新写，"hold 用 DELETE journal"是本次踩到的关键坑，见 §3.1）

### 2.1 场景 A：锁冲突（真实 `BEGIN EXCLUSIVE`）

```
$ node docs/audit/probes/t20-board-open.mjs hold docs/audit/probes/run/t20-lock 16000   # 后台
[hold pid=33312] BEGIN EXCLUSIVE OK  模式=delete  保持 16000ms
[hold] 库内行数=1  size=45056

$ node docs/audit/probes/t20-board-open.mjs probe docs/audit/probes/run/t20-lock      # 锁被持有时
[probe] 打开前：exists=true size=45056 目录=["board.sqlite"]
[probe] openBoard 正常返回（5069ms）
[probe]   rebuilt = false   ← true 表示把好库当坏库改名重建
[probe]   backup  = (none)
[probe]   jobs 行 = 1
[probe] 打开后：exists=true 目录=["board.sqlite"]
[probe] 是否出现 .corrupt- 备份：无
[probe] 判定：✅ 好库没被删/改名
[hold] 释放          ← holder 实际持有 16s，probe 全程落在锁窗口内
```

**判定**：`rebuilt=false`、无 `.corrupt-`、1 行单子完好。耗时 **5069ms ≈ `busy_timeout=5000`** ⇒ 说明这 5 秒是真的在等锁，而不是"没撞上锁所以顺利通过"。
（v1 报告第 3 条的病根是"任何异常都当损坏 → 删库"，此处已不再发生。）

### 2.2 场景 B：schema 不匹配（无需并发）

```
$ node docs/audit/probes/t20-board-open.mjs schema docs/audit/probes/run/t20-schema
[schema] 造好旧库：user_version=1 jobs=1 列数=23
[schema] openBoard 返回（23ms）
[schema]   rebuilt  = false
[schema]   migration= {"added":["interrupted","repeat_ms","dependsOn"],"from":1,"to":2}
[schema]   user_version 现在 = 2（期望 2）
[schema]   表里行数 前=1 后=1   ← 少一行就是丢单
[schema]   老行还在？ [{"id":"old_1","title":"老库里的单子","priority":5,"state":"ready"}]
[schema] 判定：✅ 迁移成功、未重建、单子全在
```

**判定**：第 24 条（"无需并发就会走重建"）已不成立 —— 现在走**幂等迁移**，旧单保留。
`migrateBoardSchema` 的列清单**从 `SCHEMA` 建表语句反抽**（`jobColumnDefs` `:177-187`），不是另写一份 → 以后加列自动纳管（这条设计我认可，见 §3.4 的唯一风险）。

---

## 3. "修出新问题"专项

### 3.1 【我自己踩到的坑，值得写进规程】旧探针在 WAL 下"假通过"

`p2_lockholder_exclusive.mjs` 用的是 WAL + `BEGIN EXCLUSIVE`。**WAL 下读者不被写者阻塞**，所以那个探针跑出来的 `rebuilt=false / 1124ms` 是"根本没撞上锁"的假绿。我第一版照抄它就得到了一个"通过但没测到"的结果。
必须把连接压回 **`journal_mode=DELETE`** 才能造出真 `SQLITE_BUSY`（压回后耗时立刻变成 5069ms）。**建议把这条写进 REVIEW-PROTOCOL §3.1**：凡"锁冲突"类断言，探针必须显式声明 journal 模式。

### 3.2 第 15 条：重复扣料只是"限了次"，没"消掉"

- 已修的部分：`expireLeases` 记 `attempts+1`、放开 `assignee`、耗尽转 `failed/LEASE_EXPIRED` ⇒ 无限重试变成**最多 3 次**。
- **仍然存在**：`board_store.js:700-701` 对 craft 仍是 `completed = okFlag && (isCraftJob || …)`（只看 okFlag），`:554` 仍让 craft 跳过库存收敛；而 `grep producedTotal|craftedTotal|幂等` 在 board_store / act_craft / flow_craft **零命中** ⇒ **没有任何"这张单已经产出过多少"的账**。
- 后果：一张合成单若连续崩 2 次，**材料被真实扣 2 次**，第 3 次成功即记 done，前两次的消耗在库里查不到（`progress.count` 对 craft 是背包总量，被 `mergeProgress` 取 max，看不出扣了几次）。
- **判定：部分修好**。原报告的"无限重试"已消除；"重复扣料"从"无界"变"≤maxAttempts 次"，但**没有归零**。
- 最小修复：`act_craft` 把本次 `produced` 累进 `checkpoint.producedTotal`，`finish` 时把它写进 `result`。**这不属于本轮 BLOCK**（次数已有上界），但第 15 条不能标"真修好"。

### 3.3 第 31 条：契约仍是字符串前缀，不是 ok/code 通道

- 事实：`sendRequest` 签名没变，失败通过 `[LLM_ERROR]` 字符串前缀表达；判别靠 `isFailedReply(text).startsWith(...)`。
- 这**能工作**（消费端 `agent.js:629` 确实 branch 了，不写 history、不回复玩家），所以"伪装成模型的话"这一条**真修好了**。
- 但两个残留风险（不是本轮 BLOCK，属 Should）：
  1. 若模型/上游输出恰好以 `[LLM_ERROR]` 开头，会被误当成失败（概率极低，但不是零）；
  2. 前缀会随字符串流经 `prompter` → 任何未接 `isFailedReply` 的新消费点会重新把失败当回答（grep 显示当前只有 `agent.js:629` 一处消费）。新增消费点时必须记得判。

### 3.4 新增迁移的唯一结构性风险：`jobColumnDefs` 靠切逗号解析

`:184-186` 用 `schema.slice(...).split(',')` 抽列定义。**当前 `SCHEMA` 的 jobs 表没有带逗号的列定义**（无 `CHECK(...)`、无复合默认值），所以正确。但**将来**若加一列写成 `x INTEGER DEFAULT (1,2)` 或 `CHECK(x IN (1,2))`，会切错 → 迁移拼出非法 DDL → `openBoard` 抛错（不会静默删库，因为非 corrupt 会 rethrow，所以**最坏是无板可用，不是丢数据**）。
最小修复：解析时按括号深度切分（约 6 行），或在 `validateRegistry` 类启动自检里加一句"列定义不得含逗号"。

### 3.5 事务/锁方面：没有引入死锁或长事务

- `migrateBoardSchema` 的 `ALTER TABLE` **没有包在显式事务里**，每条独立提交 → 中途失败只会"补了一部分列"，下次打开继续补（幂等）。`user_version` 只是信息位，迁移判据用的是 `PRAGMA table_info` 的实列集，不依赖它（`:202-212`）。⇒ **可重入，无半迁移死锁**。
- 每次打开都要拿一次写锁做 ALTER 检查（即使无列可加，`migrateBoardSchema` 只做读 + 0 次写）。实测 23ms，无长事务。

---

## 4. 新增测试的鉴别器检验（E 项，已实测 3 组）

探针：`docs/audit/probes/t20-discriminator.mjs`（**修复版 vs 回滚版**成对跑）

```
=== ① 第32条 心跳循环 ===
   修复版：update 被调用 5/5 次（第2拍抛过 1 次）
✅ 修复版循环活过异常
   回滚版：update 被调用 2/5 次，循环以异常终止（boom@2）
✅ 回滚版循环确实被打死（证明测试能抓回归）

=== ② 第24条 schema 迁移 ===
   回滚版（不迁移直接建索引）：抛错 → no such column: priority
✅ 回滚版确实炸（证明迁移调用是承重的）
   修复版 openBoard：rebuilt=false migration={"added":["priority","interrupted","repeat_ms","dependsOn"],"from":1,"to":2} rows=1
✅ 修复版迁移成功且不重建、单子保留

=== ③ 第25条 memory_store 损坏备份 ===
[memory] 读取 chests 失败，使用默认值（原文件已留证：…chests.json.corrupt-1793887316180）
✅ 损坏时留下 .corrupt- 备份
✅ 损坏时不抛、仍返回 fallback
=== 总判定：✅ 三组鉴别器全部成立 ===
```

**结论**：这三条对应的新增测试（`heartbeat_loop_unit` / `board_open_migrate_unit` / `memory_store_corrupt_unit`）**具备鉴别力** —— 回滚修复后它们会红。不是"绿着但没测东西"。

未做实证的其余 9 个测试，静态理由：
| 测试 | 静态判断 |
|---|---|
| `board_openonly_unit` | 断言 openOnly 过滤生效；回滚后 `listJobs` 无该谓词 → 250 单场景下新单消失，会红 |
| `board_lease_expire_unit` | 断言 attempts 递增；回滚后 `expireLeases` 不动 attempts → 会红 |
| `board_stop_unit` | 断言 paused/`pausedReason`；回滚后 `finish` 把 INTERRUPTED 推回 ready → 会红 |
| `board_orphan_parent_unit` | 断言 0 子单父单转 blocked；回滚无该函数 → 会红（或直接 import 失败） |
| `shared_chest_merge_unit` | 断言并发两次合并都保留；回滚成 get+put → 必丢一条 → 会红 |
| `agent_process_backoff_unit` | 断言退避序列 2s/4s/8s…；回滚无该函数 → 会红 |
| `agent_failed_reply_unit` | 断言失败不写 history；回滚无 `isFailedReply` 分支 → 会红 |
| `llm_usage_unit` | 断言 recordUsage 被调；回滚无调用 → 会红 |
| `s43_s44_unit` | 与本线无关（S43/S44），未核 |

---

## 5. 第 25 条专项（F 项）

**真修好，已实测。** `memory_store.js:76-89` 新增 `backupCorruptFile()`：读失败时 `renameSync(p, p + '.corrupt-' + Date.now())` 再返回 fallback。实测产出了 `.corrupt-1793887316180` 且不抛错。
与 `board_store` 的做法对齐了（原先两处标准不一致：板库留证、记忆库静默清空）。

---

## 6. 一句话结论

**`PASS`**（可交付），附 1 条不挡门的遗留与 2 条建议。

理由：14 条里 **12 条真修好**（其中第 3/24/25/32 条**已实测**，第 3/24 条正是原报告的数据丢失面，实测证明好库不再被删、旧单不再丢）、**0 条修出新问题**、**0 条没修**。第 15 条**部分修好**：无限重试已消除（attempts 有上界、assignee 已释放），但 craft 的"重复扣料账"仍未建立 —— **它不再是数据无限流失，而是"最多 3 次"的有界损失**，故不构成 BLOCK。

**不挡门但应在下一轮补的：**
1. **第 15 条收尾**：`act_craft` 记 `checkpoint.producedTotal`，让"已产出多少"在库里有账（最小改动，5 行）。
2. **第 31 条契约**：把 `sendRequest` 从 `Promise<string>` 前缀协议改成 `{ok, text, code}` 是更大的改动；当前做法可用，但**新增任何消费点都必须调 `isFailedReply`**，建议在 `_shared.js` 注释里写明这条纪律。
3. **规程补充**：把 §3.1 的"锁冲突探针必须显式声明 journal 模式"写进 `REVIEW-PROTOCOL.md`（本轮我自己就在 WAL 上得到过假绿）。

---

## 7. 本轮盲区（照规程重新声明）

1. **沙箱 EPERM**：未跑 `unit_all.mjs`（`execFileSync` 被拒，0/64 不是失败）。本轮全部证据来自**自写探针直跑单文件**。
2. **无多 bot 现场**：第 4/16 条的跨 bot 交错仍无真实现场，本轮是静态确证 + 单进程内模拟。
3. **第 6 条只到"代码链路接通"**：`!stop` 的端到端（真按一次看单子是否 paused）需要启动 mindserver + 真 bot，本轮未做。
4. **第 14 条未做 250 单的压力实测**（静态链路已闭合：客户端→服务端→SQL 三处都在）。
5. **第 31 条 usage 覆盖率是 grep 级**：确认 19 个适配器都调 `recordUsage`（azure 经继承），但**没有真跑一次模型调用**看数值是否写对。
