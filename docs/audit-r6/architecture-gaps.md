# R6 架构缺口与数据库方案（arch-gap / t5）

> 审计范围：父仓 `E:\我的世界ai`（脚本 / 前端）＋ 子仓 `mindcraft`（运行时）。
> 只读审计，**未修改任何产品代码**。证据基线：`mindcraft` HEAD `82da3f3`。
> 只读实测：`mindcraft/bots/_board/board.sqlite` = `user_version=2`、`jobs=0`、`claims=0`、`shared=1`（20 页 / 9 页空闲）。

---

## 0. 结论摘要

三条硬约束在当前代码里**一条都不能判定，更谈不上保证**：

| 硬约束 | 现状判定 | 一句话原因 |
|---|---|---|
| ① 一个玩家只允许一个 AI 分身 | ❌ **不可判定** | 身份是「每只 bot 一个 `identity.json`」，没有 people 表、没有 person→avatar 的唯一约束；同一玩家可对 N 个 agent 各领一次码，同一个 agent 也可被 N 个玩家同时绑成 owner |
| ② 服务器内置任务板 + 各分身组队 | ⚠️ **板在、队无** | 板是单库单写者（可复用），但数据模型里没有 `team` / `team_member` / `board_job.team_id`；`!addSharedJob` 只在权限表登记、无实现 |
| ③ 进入队伍板时共享队内材料清单 | ❌ **不存在** | 共享库存是「全服一张 `shared(kind='chest')` 缓存」，没有队伍命名空间，也没有数量级预占/领用账本，无法回答"队里还差多少材料" |

三个设计决策的评估（详见 §4/§5/§6）：

| 决策 | 现有可复用 | 必须补的最小机制 |
|---|---|---|
| A 真实箱子为真相 + 账本只记预占/领用 | 单写者 ✓、容器级预占 ✓、TTL 到期回收 ✓（5s 扫描） | **数量维度**、`UNIQUE(key)`、事务化取料、**领用结算**、**对账（reconcile）** |
| B 全局层 / 存档层两分 | 板库已是独立 SQLite（易加维度） | `world_id` 维度（当前 0 处）、把 `bots/<name>/` 里"世界相关"与"人相关"的资产拆开 |
| C 正版 + 离线归一到 people | 离线 uuid 派生已识别并降级（`weak` + session 窗口） | `people(provider, subject)` 主键 + `avatar.person_id` 唯一约束；自建离线 id 的**首次下发与落库** |

> 关键判断：**任务板不需要迁移数据库**（它已经是"单进程写 + WAL + 原子状态转移"的正确形态）。需要动的是**表结构维度**（world / team）和**库存账本**，以及"把身份从 bot 目录搬到 people 主键"。

---

## 1. 方法与证据边界

- 逐文件读代码（`board_store.js` 2219 行、`board_server.js` / `board_claims.js` / `board_scheduler.js`、`identity_store.js`、`permissions.js`、`memory_store.js`、`history.js`、`terrain3d.js`、`flow_store.js`、`act_container.js`、`config_center.js`、`offline_identity_risk.js`、`mindserver.js` 关键段）。
- 对板库做**只读** SQL 查询（`readOnly:true`）核实结构、行数与空闲页，不写库。
- 父仓脚本/前端只读：`scripts/backup-world.ps1`、`scripts/verify-world-backup.ps1`、`scripts/restore-drill.ps1`、`config/*.json`、`web/src/**`。
- 不做真机验证（不启服、不连 bot）；凡标注"实测"处均为本次只读查询或文件系统事实。
- **诚实边界**：`jobs=0` 的具体成因无法从现有文件回溯（见 §4.5 的"可疑证据"），下文只陈述可复现的代码路径与文件事实。

---

## 2. A：现状盘点（存哪、谁读写、并发、损坏、规模、可查询性）

### 2.1 资产总表

| 资产 | 物理位置 | 唯一真相入口 | 谁写 / 谁读 | 并发模型 | 损坏后果 | 规模上限 |
|---|---|---|---|---|---|---|
| 分身摘要记忆 | `mindcraft/bots/<bot>/memory.json` | `history.js:37` | 该 bot 子进程写；同进程读 | 单文件单写者（每 bot 一个进程）；`capSize` 20KB | 解析失败 → 记 warn；整份重写会覆盖（有 `.corrupt-*` 留证） | **20 KB 硬上限**（`history.js:333`），turns 默认 30 条 |
| 分领域记忆（箱子/工地/危险/任务/危险团块） | `mindcraft/bots/<bot>/memory/<ns>.json` | `memory_store.js:33-47,65-73` | 同上 | `updateStore` = 读-改-写，**无锁**（`memory_store.js:153-158`） | 读失败改名 `.corrupt-<ts>` 再返回默认值（`memory_store.js:84-124`） | 每 namespace 无硬上限；`landmarks` 24 条上限 |
| 完整对话归档 | `mindcraft/bots/<bot>/histories/<ts>.json` | `history.js:158-194` | 该 bot 写 | 追加式，每个分片一个文件 | 单文件坏不影响其它 | **无上限**（按会话分片增长） |
| 地形 3D 库 | `mindcraft/bots/<bot>/map/terrain3d.db` | `bot_paths.js:79-81` + `terrain3d.js:96` | 该 bot 子进程写；mindserver 只读拉取（`mindserver_proxy.js:176-177`） | 每 bot 一份 SQLite（WAL、busy_timeout 3s） | 库坏 → 该 bot 地形不可用（无重建约定） | **无上限**，随扫描面积增长；**与存档无关**（见 §5） |
| 任务板 | `mindcraft/bots/_board/board.sqlite` | `bot_paths.js:102-104`；`openBoard()` 全仓仅 `mindserver.js:965` 一处 | **只有 mindserver 写**；agent 经 socket 读写（`board_client.js`） | 单写者 + WAL + `busy_timeout=5000`（`board_store.js:260-281`） | 仅 `SQLITE_CORRUPT(11)` / `NOTADB(26)` 才改名重建**空库**（`board_store.js:226-330`）；锁忙/权限一律原样抛 | `jobs` **从不删除**（`board_store.js:511-514`）；`listJobs` 默认 LIMIT 200、`claimFor` 扫描上限 5000 |
| 箱子/地标/危险（共享） | 同板库 `shared` 表 | `board_store.js:2016-2138` | mindserver 写（`board:shared-*`） | `mergeSharedChest` 走 `BEGIN IMMEDIATE`（`2076-2110`）；`putShared` 无事务 | 随板库一起（损坏=重建空库→**共享库存记忆全丢**） | `shared` PK `(kind,key)`，行数无上限 |
| 箱子/地标（**第二份真相**） | `mindcraft/bots/<bot>/memory/chests.json` 等 | `landmarks.js:1-45,165-205` | 该 bot 子进程写 | 同 memory_store | 同 memory_store | 24 条/领域 |
| 凭据（API Key） | 仓库根 `.secrets.db`（`secrets_vault.js:51`） | `secrets_vault.js:118-123` | mindserver 的 vault 路由写；agent 只读注入 | SQLite + `busy_timeout=5000`；KEK 只在内存 | 口令错/库被改统一 `BAD_PASSPHRASE`；初始化后不可换口令 | 值上限 `MAX_VALUE_BYTES` |
| 人设 / 模型配置 | `mindcraft/profiles/*.json`、`profiles/defaults/*.json` | `settings.js:22-40` | 人读人写（配置中心可改 `settings.js`） | 无并发保护（改完重启生效） | JSON 坏 → agent 起不来 | 文件数无上限 |
| 身份绑定 | `mindcraft/bots/<bot>/identity.json` | `identity_store.js:173-174` | **两个进程写**：agent（`!claim`）/ mindserver（解绑）；tmp+rename | 最后写者胜（无锁，`identity_store.js:258-268`） | 坏 JSON → **空表**（全员降级 guest，`242-250`） | `bindings` 无上限；待核销码 8 条上限 |
| 待核销码 | `mindcraft/bots/<bot>/identity-codes.json` | `identity_store.js:177-180` | 面板下发（mindserver 写）/ agent 核销（删） | 同上 | 同上 | 8 条 / bot，TTL ≤5 分钟 |
| 配置中心 | `config/network.json`、`config/backup.json`、`mindcraft/settings.js` | `config_center.js:56-60,75+` | mindserver 写；两者都读 | 写前 `.bak-<ts>`；`settings.js` 只做行级正则替换（`config_center.js:22-40`） | 写坏回滚；settings 加载失败回滚 | — |
| 世界备份 | `backups/world-<stamp>/`（manifest 最后写） | `scripts/backup-world.ps1` | 停服后外部脚本 | **冷备**：服务端在跑就拒绝（exit 2） | 半成品目录不含 manifest，不算备份 | `keep=7`（`config/backup.json`）；实测 world 121MB、bots 35MB |
| 日志 | `logs/*.log`、`server/logs`、bot 输出流 | — | 多进程追加 | 追加写 | 无 | `-LogDays` 默认 7 天进备份 |

### 2.2 关键结论（逐项）

**① 记忆是"每 bot 一份文件"，不是"每人一份"。**
`memory_store.memoryDir()` 用 `botsRootOf()/<bot.username>/memory`（`memory_store.js:65-69`），`history.memory_fp = …/<name>/memory.json`（`history.js:37`）。bot 名 = profile 名（`agent.js:194,212`）。⇒ 换一个分身就换一份记忆，**人的长期画像无法跨分身累积**；而这正是"一玩家一分身"「不许换分身」之外还需要 people 表的原因。

**② 地形库与存档完全无关。**
`mapDirOf(bot) = bots/<bot>/map`（`bot_paths.js:79-81`），`terrain3d.db` 直接建在这个目录下（`terrain3d.js:96`）。切换/重置存档后，**旧世界的地形仍被当作本世界地形使用**（没有 world_id、没有 seed 校验）。这是决策 B 最危险的一处错位：世界相关数据放在了世界无关的路径里。

**③ 任务板是全仓最扎实的并发骨架，可复用。**
- 单写者：`openBoard()` 只在 `mindserver.js:965` 调用；agent 只能经 socket（`board_server.js`）。
- 领单原子：`UPDATE jobs … WHERE id=? AND state='ready'` 看 `changes`（`board_store.js:695-698`），注释明确禁止"先 SELECT 再 UPDATE"。
- 收尾归属：`lease_owner` + `checkpoint.attemptSeq` 双守卫（`board_store.js:619-627,726-731`）。
- 预占 TTL：30s（`board_store.js:82,1263`），心跳续期（`board_scheduler.js` 10s），`expireClaims` 5s 扫描（`board_server.js:451-460`）。
- 已踩过的坑都写了注释与回归用例（丢单重建、先截断后过滤、craft 用库存数当进度等）。

**④ 共享库存只有"缓存"，且是第二份真相之外的第三份。**
`shared(kind='chest')` 由 `mergeSharedChest` 按增量合并（`board_store.js:2076-2110`），但：
- `flow_store` 写它（`flow_store.js:70-88`）；
- `!putInChest` / `!takeFromChest` / `!viewChest` / `verifyChest` / `findItemInStorage` **写读的仍是 `memory/chests.json`**（`skills.js:4447-4504,4535,5368-5410`；`landmarks.js:165-205`）；
- 两套账本互不同步。`board_store.js:2009-2013` 声称地形不共享、`flow_store.js:24-27` 声称旧文件"彻底删掉、不再有第二个真相"——**代码与注释不一致**，旧路仍在被命令使用。

**⑤ 并发模型总览（用户"多进程靠文件共享不舒服"的根因）。**
- 真正的单写者只有板库（+ vault 的写入路由）。
- 每个 bot 是独立子进程（`agent_process.js`），各自写：`memory.json`、`memory/*.json`、`histories/*`、`map/terrain3d.db`。
- **同一个文件有两个写者**的地方：`identity.json`（agent 的 `!claim` 与 mindserver 的解绑，靠 tmp+rename"最后写者胜"）；`memory/*.json`（同 bot 内多次读改写，`updateStore` 无锁）。
- 读侧没有一致性问题，写侧靠"恰好只有一个进程写"这一**约定**，而不是数据库约束。⇒ 用户的不适感是对的：可靠性来自纪律，不来自机制。

### 2.3 损坏行为对照

| 资产 | 损坏判据 | 行为 | 评价 |
|---|---|---|---|
| 板库 | 仅 errcode 11/26 或 "not a database/malformed" | 改名 `.corrupt-<ts>` → 建空库（`board_store.js:243-330`） | 正确（旧版把 BUSY 当损坏，已修） |
| 板库（锁忙/权限/磁盘满） | 其它异常 | 原样抛出 | 正确（不吞） |
| 记忆 | JSON 解析失败 | 改名 `.corrupt-<ts>`，返回默认值（`memory_store.js:84-124`） | 正确 |
| 身份表 | JSON 解析失败 | **静默返回空表**（`identity_store.js:242-250`），全员 guest | ⚠️ fail-closed 可以接受，但**无告警、无留证**，与记忆层不一致 |
| 地形库 | 任意异常 | 未捕获/未重建约定 | ⚠️ 该 bot 导航能力永久降级 |
| vault | AEAD 校验失败 | `BAD_PASSPHRASE`（不区分"口令错/库被改"） | 正确（防爆破进度） |

### 2.4 规模上限与可查询性（关键缺口）

| 问题 | 现状 |
|---|---|
| 按**时间**查任务 | ❌ `listJobs` 只支持 `states/assignee/claimableFor/skill/limit`（`board_store.js:493-521`）；没有时间范围条件；`createdAt` 只在 `ORDER BY` 里用 |
| 按**玩家**查任务 | ⚠️ 只能靠字符串前缀猜：`source = "player:<name>"`（`actions.js:878`），无索引、无外键、无等值过滤 |
| 按**任务类型**查 | ⚠️ `skill` 有等值过滤，但没有索引；`kind` 只有 `personal` / `shared`（拆单壳，不是队伍） |
| 统计 | ❌ 只有 `countJobs(state)`（`board_store.js:1251-1256`）；无按天/按人/按类型的聚合 |
| 历史保留 | ❌ `jobs` 从不删除（`board_store.js:511-514`）⇒ 长期必然膨胀；同时 `listJobs` 默认 LIMIT 200，**新单会被历史挤出视野**（同文件 508-520 的注释记录过同类事故） |
| 板库当前容量 | 20 页（80KB）/ 9 页空闲；`jobs=0, claims=0, shared=1` —— 与"从不删单"矛盾，见 §4.5 |

---

## 3. 三条硬约束的逐条判定

### 3.1 约束①：一个玩家只允许一个 AI 分身 —— ❌ 不可判定

**身份链（online-mode=false 实测口径）：**

1. 服务端 `online-mode=false`（`server/server.properties:38`；`config/network.json` 的 `servers.main.onlineMode=false`）。
2. bot 取 uuid 的方式：`bot.players[name].uuid`（`commands/identity.js:24-38`）——即**服务端下发**的 uuid。
3. 该 uuid 在离线服上由名字派生：`offlineUuidOf = MD5('OfflinePlayer:'+name)`，version=3（`identity_store.js:72-79`；注释 `51-71` 点名了 `minecraft-protocol` 的实现）。
4. 绑定写入 `bots/<agent>/identity.json`（`identity_store.js:173-174`；`identity_store.js:329-351`）。
5. 定级时 **uuid 优先**，名字仅作为"当初没拿到 uuid 的绑定"的回退（`identity_store.js:365-381`；`permissions.js:214-218`）。
6. 离线服上这条绑定被标 `weak`，owner 只在 `!claim` 后的会话窗口内有效（默认 60 分钟：`settings.js:43-58`；策略合成 `offline_identity_risk.js:158-175`）。

**为什么"一玩家一分身"判不了：**

- 绑定表挂在**bot 目录**下，主键是"这只 bot 的绑定数组"，没有 `person` 实体。全局唯一的"人"不存在。
- 面板按 agent 发码：`identity-issue-code(agentName)`（`mindserver.js:1301-1325`）。同一面板持有人可以对 N 个 agent 各发一次码、各 `!claim` 一次 ⇒ **同一玩家成为 N 个分身的 owner**，没有任何代码路径会拒绝。
- 反方向也没有约束：`bindFromCode` 只在"同一个 uuid/同名"时覆盖旧绑定（`identity_store.js:348`），不同人会被**追加**进同一个 `bindings` 数组 ⇒ **同一个分身可以有 N 个 owner**（且等级恒为 `owner`，`identity_store.js:48,337-350`）。
- 全仓唯一的"跨 bot 身份扫描"是启动时统计绑定总数用于提示（`mindserver.js:1826-1842`），只读、不判定、不拦截。

**结论：** 当前既不能判定"这个玩家已经有分身了"，也不能判定"这个分身已经属于别人了"。约束①必须新增 people/avatar 两张表 + 唯一约束才能在**写路径**上成立（§7）。

### 3.2 约束②：内置任务板 + 各分身组队 —— ⚠️ 板在、队无

已有（可复用）：
- 单库单写者、状态机（`pending/ready/claimed/running/paused/blocked/done/failed/cancelled`，`board_store.js:36-74`）。
- 抢占规则（9 级抢任何 / 6–8 抢低 ≥2 级 / 3–5 排队，`board_scheduler.js:96-120`）。
- 拆单（按数量 / 按区域，`board_store.js:1914-2010`）、父子收敛、孤儿父单兜底。
- 共享数据 namespace（landmark / danger / chest，`board_store.js:2016-2053`）。

缺（组队的前提）：
- `jobs.kind` 只有 `'personal'` 与 `'shared'`，而 `'shared'` 是**拆单壳**（`board_store.js:1923,1943`），不是队伍。
- 没有 `team` / `team_member`；`claimFor` 没有"队内可见/队外不可见"的过滤（`board_store.js:663-669` 只按 `assignee` 与 `notBefore`）。
- `!addSharedJob` 只登记在信任级权限表（`permissions.js:125`），**命令实现不存在**（`src/agent/commands/*.js` 里无此 name）；`!pauseJob` / `!resumeJob` 同样（`permissions.js:126`）。这就是"组队单"的入口缺口。

### 3.3 约束③：进入队伍板时共享队内材料清单 —— ❌ 不存在

- 共享库存的 namespace 是 `(kind,key)`，**没有 team 维度**（`board_store.js:146-153`）。全服所有 bot 看同一张箱子表，无法"只给队里看"。
- 没有"材料清单"实体：`shared(kind='chest')` 是"某箱子有什么"的缓存；没有"队伍需要什么 / 已预占多少 / 还差多少"。
- 箱子缓存的写入是**增量**且**只在实际搬运成功后**（`flow_store.js:70-88,173-177,255`），因此它既不是库存总量，也不是预占量。
- `findItemInSharedChests` 只按物品名查缓存（`board_store.js:2123-2138`），返回 `{key,pos,count,owner}`，没有"新鲜度/核实时间"以外的可信度信号（`updatedAt` 是写入时间，不是核对时间）。

---

## 4. 决策 A：真实箱子为真相 + 账本只记预占/领用

### 4.1 现有机制清点

| 最小机制 | 现状 | 证据 | 缺口 |
|---|---|---|---|
| **单写者** | ✅ 有 | `openBoard()` 仅 `mindserver.js:965`；agent 走 socket | 生产板库可被工具进程直接打开写（§4.5） |
| **事务** | ⚠️ 部分 | `mergeSharedChest` 用 `BEGIN IMMEDIATE`（`board_store.js:2084-2105`）；`reserve()` **无事务**（`1285-1327`，读后再逐一 INSERT） | `reserve` 的"查冲突→插入"没有事务包裹；跨进程时会双插 |
| **预占原子性** | ⚠️ 仅"进程内恰好原子" | `reserve` 是同步函数，node 单线程 ⇒ 同进程内不存在交错；冲突判定是"同 key 有别人未过期" | 无 `UNIQUE(key)`（`claims` 只有 `PRIMARY KEY(id,key)`，`board_store.js:137-141`）；一旦有第二个写进程即可重复占用 |
| **超时回收** | ✅ 有 | `expireClaims`（`board_store.js:1392-1397`）+ 5s 扫描（`board_server.js:451-460`）；TTL 30s（`82,1263`），心跳续期 | 无"回收后通知持有者"（靠下一次心跳拿到 `LEASE_LOST`） |
| **领用结算** | ❌ 只有产出账 | `settleCraftLedger` 只记 **craft 产出** `checkpoint.producedTotal`（`board_store.js:798-817,886-892`） | 没有"领了多少料、从哪个箱子、消耗在哪张单"的账 |
| **与真实箱子对账** | ❌ 完全没有 | 全仓 `reconcile` / `对账` 只出现在 `board_store.js:1000` 的一句注释（"增量对账用"），无实现；`findItemInSharedChests` 只读缓存 | 无定期核对、无差异修正、无"缓存不可信"标记 |

### 4.2 三个并发场景推演：两个分身同时领"最后一组材料"

**场景 1：同一个箱子，同时取走同一批材料**
- 双方各自 `openContainer` 前会走 `reserveNow('container:x,y,z')`（`act_container.js:186-215`）。
- `reserve` 冲突 → `CLAIM_CONFLICT`，调用方当场换目标（`composite_registry.js:650-670`；`board_scheduler.js:683-706`）。
- ⇒ **能防住**"两个 bot 同时开同一个箱子"，也就防住了"同一箱子里的最后一组被两边同时取走"。
- 边界：这个预占依赖 `bot.__reserveNow` 被正确注入；没有板/不是任务单时是 `NO_JOB`/`NO_BOARD` + 只 warn 一次（`act_container.js:32-42,205-215`），**不会阻塞动作**。

**场景 2：不同箱子、同一材料，各自取"最后一批"**
- 规划阶段读的是共享缓存（`findItemInSharedChests`）；预占只有 `container:`（按坐标），**没有 `item:`**。
- `item:` key 虽在词表里（`board_claims.js:16,78-88`），但冲突判据是"**同物品名即冲突**"，数量 `n` 只被解析、**从不参与比较**（`board_claims.js:122-123`）。
- 更关键：现实中**没有任何流程产出 `item:` 预占**——`deriveClaims` 只在 `args.materials` / `args.cost` / `args.material` 显式给出时生成（`board_claims.js:231-254`），而全仓没有任何流程/job 填这些字段（`strat_obtain` 的 `cost` 是策略代价整数，不是材料表，`strat_obtain.js:84-190`）。
- ⇒ **防不住**：两个分身可以各自从不同箱子取走同一材料的"最后一批"，因为它们从未对"材料总量"达成过一致。结果不是"双花"（真实世界由服务端裁定，第二个人会发现箱子空了），而是**白跑 + 反复 blocked/retry**，以及上层对"还剩多少"的判断失真。

**场景 3：规划期与实际取料之间（幽灵库存）**
- 规划读缓存 → 走到箱子 → 打开 → 发现没有 → `NO_ITEM` / `NO_TARGET`（`flow_store.js` 的失败码）。
- 缓存漂移来源：玩家手动往箱子里放/拿、怪物炸箱、别的 bot 走的是**旧命令路径**（`!putInChest` 只写本地 `chests.json`，不写共享缓存，`skills.js:4447-4504`）。
- ⇒ **没有对账 ⇒ 缓存可以长期偏大或偏小**，且没有任何机制会自己纠正。

**结论（直接回答任务点）：**
> 现有机制能防"**同一容器被同时打开**"，但**不能防"两个分身同时把最后一组材料都领走"**。
> 因为缺的不是锁，而是**数量账**：没有"某材料在全队范围内已预占 N、可用 M"的记录，也没有把"实际领走"结算回账本的动作。

### 4.3 最小机制缺口（点名对照）

| 任务点名的最小机制 | 判定 | 说明 |
|---|---|---|
| 单写者 | ✅ 已有 | 但需禁止工具进程写生产库（§4.5） |
| 事务 | ⚠️ 补 | `reserve` 要 `BEGIN IMMEDIATE`；数量预占必须"条件 UPDATE + changes 判定"（同 `claimFor` 的模式），不能 SELECT-then-UPDATE |
| 预占到期回收 | ✅ 已有 | `expireClaims` 5s 扫描；数量预占沿用同一 `until` 字段即可 |
| 对账任务 | ❌ 缺 | 需新增：定期/触发式核对"真实箱子 vs 账本"，产出差异修正行 |

**还缺三条（任务没点名但同样是前置）：**
- **数量维度**：`claims` 只有 `(id,key,owner,until)`，没有 `item/qty`。`item:<name>:<n>` 的 `n` 被丢弃（`board_claims.js:82-87` 解析、`122-123` 不使用）。
- **唯一约束**：`claims` 无 `UNIQUE(key)`（`board_store.js:137-141`）⇒ 数据库层不阻止重复占用，只有应用层"先查后插"。
- **事务重试**：`busy_timeout=5000` 的失败被 `try/catch` 静默吞（`board_store.js:271-272`），没有重试/退避，也没有指标。

### 4.4 "混合模式"的正确落点（不改代码，只给结论）

真实箱子是真相 ⇒ 账本**不能**充当库存总量。最小可行是"**预占 + 领用流水 + 定期对账**"三件套：
1. `inventory_reservation(world_id, item, qty, job_id, owner_avatar, expires_at, state)`：只表示"我打算领 N 个"，过期自动释放。
2. `ledger(world_id, ts, avatar_id, job_id, item, delta, chest_key, reason)`：**只追加**，`delta` 为负数表示取走；这是唯一可审计的"领用结算"。
3. `reconcile`：定时（或每次开箱）把真实箱子内容与账本/缓存对齐；**真实箱子永远覆盖账本**，差异写成一条 `ledger(reason='reconcile')`。
4. 可用量公式 = `最近一次核对到的实际数量 − 未过期预占之和`；**缓存的新鲜度必须显式暴露**（`verified_at`），规划器不得把未核对的缓存当承诺。

### 4.5 生产板库可被测试脚本清空（实测线索 + 代码证据）

- 代码证据：`tools/board_b3_live.mjs:128` 用默认目录 `store.openBoard()`，紧接 `:131` 执行 `DELETE FROM jobs; DELETE FROM claims`，**在起 bot 之前**执行（即使后续连接失败，清空已经发生）。`tools/a2_budget_live.mjs:40`、`tools/first_night_live.mjs:39-41` 同样打开默认板库并 `DELETE FROM jobs`。
- 另有 `tools/t37_idle_live.mjs:99`、`tools/t51_triple_round.mjs:50`、`tools/m10_do_live.mjs:42` 等同类。
- 后果：跑一次"live"诊断即清空**线上**任务与预约；与 `board_store.js:511-514` 的"jobs 从不删除"假设冲突。
- 实测线索：本机生产板库 `jobs=0, claims=0, shared=1`（20 页 / 9 页空闲），而代码路径从不删单 ⇒ 该库很可能被上述工具清过（或曾因损坏重建，但目录内**没有** `.corrupt-*` 留证）。
- 定性：这不是"架构"问题，但它是**任何预占/账本方案落地前必须先堵的口子**——否则账本可以被一次测试清空。

---

## 5. 决策 B：两层持久化（全局层 / 存档层）

### 5.1 现有 `bots/<name>/` 目录能否承载这个切分？—— **不能**

逐项判定：

| 现有路径 | 语义 | 应属哪层 | 判定 |
|---|---|---|---|
| `bots/<bot>/memory.json` | 对话摘要 + 自我目标 + 地点 bank | **跨存档**（人物画像/长期记忆） | ⚠️ 内容对，但按 bot 分目录 ⇒ 换分身就断；且 20KB 上限会把长期画像压没 |
| `bots/<bot>/memory/sites.json`、`storage.json`、`hazards.json`、`tasks.json` | 坐标/危险/长任务进度 | **存档层**（世界相关） | ❌ 现在是全局路径，世界重置后仍被沿用 |
| `bots/<bot>/memory/chests.json` | 箱子坐标与内容 | **存档层** | ❌ 同上，且是"第二份真相" |
| `bots/<bot>/memory/dangers.json` | 危险点 | **存档层** | ❌ 同上 |
| `bots/<bot>/map/terrain3d.db` | 地形扫描 | **存档层** | ❌ 同上（最危险：会把旧世界地形当新世界用） |
| `bots/<bot>/histories/*.json` | 对话归档 | **跨存档** | ⚠️ 语义对，但无 world 标记，无法区分"哪段发生在哪个世界" |
| `bots/<bot>/identity.json` | 玩家↔bot 绑定 | **全局层** | ⚠️ 位置错：挂在 bot 目录、无 people 主键；且与 `bots/_board` 同处一个备份单元 |
| `bots/<bot>/identity-codes.json` | 待核销码 | 全局层（短时） | ⚠️ 同上 |
| `bots/<bot>/last_profile.json`、`logs/`、`action-code/` | 运行产物 | 无所谓 | ✅ |
| `bots/_board/board.sqlite` | 任务/预约/共享 | **存档层**（队伍/板/库存按存档重置） | ❌ 现在是全局单库，无 world 维度 |

**结论：现结构不只是"缺 world 字段"，而是把两层错误地混在同一棵目录里：**世界相关的几何数据（map、sites、chests、hazards）放在全局路径，而全局的人/关系数据（identity）放在按分身命名的目录里。继续在这棵树上打补丁，会得到"每个文件各自判断自己属哪层"的散乱实现。

### 5.2 world_id 从哪来（必须可稳定复现、可随备份一起走）

三种候选与判定：

| 方案 | 稳定性 | 重置语义 | 备份/恢复 | 判定 |
|---|---|---|---|---|
| A. 读 `server.properties` 的 `level-name` | 中：改名即变 | 改名=换世界（可能误判） | 随配置备份 | ⚠️ 可作 fallback，不能作主键 |
| B. 读 `world/level.dat` 的种子/时间 | 差：会随游玩变化 | 不可靠 | 随世界备份 | ❌ |
| C. **世界目录内放 sidecar `.mindcraft-world-id`（首次使用时生成 UUID）** | 高 | **删世界=删 sidecar=新 id**，正是"按存档重置"；恢复世界备份会带回同一个 id | 随世界一起备份/恢复 | ✅ **推荐** |

补充：`server/world`、`world_nether`、`world_the_end` 是三个维度目录（实测存在），`world_id` 应绑定**主世界目录**（`level-name` 指向的那个），下界/末地共享同一 id。

### 5.3 目标路径（最小改动、无第三层）

```
mindcraft/bots/                         # 只放"运行时产物"，不再承载身份/世界数据
  _global/
    mind.sqlite                         # 全局层：people / avatar / relation / world 注册表 / 全局记忆
  _worlds/
    <world_id>/
      board.sqlite                      # 存档层：team / team_member / board_job / reservation / ledger / 世界记忆
  avatars/
    <avatar_id>/                        # avatar_id = 原 bot 名（迁移期可同名）
      memory.json                       # 该分身的"人格摘要"（跨存档）
      histories/                        # 该分身的对话归档（带 world_id 列）
```

- `bots/_board` 保留为**迁移兼容**：首次启动若发现 `_global` 不存在且 `_board` 存在，把 jobs/claims/shared 整体搬进 `_worlds/<当前 world_id>/board.sqlite`，并把 `_board` 改名归档（不删）。
- `MC_BOTS_ROOT` 覆盖语义不变（测试仍可整体隔离），这是现成的测试隔离点（`bot_paths.js:59-63`）。

**主键与唯一约束**见 §7.2。

---

## 6. 决策 C：身份归一（正版 + 离线）

### 6.1 online-mode=false 下现有代码把什么当身份

证据链（逐条可查）：

1. `server.properties:38` → `online-mode=false`。
2. `offlineUuidOf(name) = javaUUID('OfflinePlayer:' + name)`（v3 MD5，`identity_store.js:72-79`）。
3. `isOfflineDerivedUuid(uuid,name)` 用来判定"这条绑定是否可被同名冒用"（`identity_store.js:93-99`）。
4. `!claim` 取 `bot.players[name].uuid`（服务端视图），落 `bots/<agent>/identity.json`（`commands/identity.js:24-38,50-60`；`identity_store.js:329-351`）。
5. 定级 uuid 优先、名字只作"无 uuid 绑定"的回退（`identity_store.js:365-381`）。
6. 离线服上标 `weak`，并按 `offline_owner_mode=session` + 60 分钟窗口授 owner（`identity_store.js:110-115`；`settings.js:43-58`；`offline_identity_risk.js:158-175`）。

⇒ **主键事实**：身份记录的主键是"**(bot 目录, uuid/name, level)**"，不是人。`uuid` 在离线服上等价于 `name`（确定性派生），因此 **uuid 不携带任何秘密**。

### 6.2 改名会怎样（三种情形）

| 情形 | 结果 |
|---|---|
| 冒名者把客户端名改成主人名 | 服务端发**同一个 uuid** ⇒ `resolveBinding` 按 uuid 精确命中 ⇒ 拿 owner（离线服上 60 分钟窗口内直接生效；窗口外走 weak 降级） |
| 主人改名 | 新 uuid ⇒ 查不到绑定 ⇒ 掉回 guest（且 `legacy_profile_names=false` 时名字不再兜底） |
| 冒名者用别的名字 | 无绑定 ⇒ guest（正确） |

⇒ 现有设计对"改名冒用"的**唯一**抑制是时间窗口（`weak` + session），不是身份证明。这一点代码注释是诚实的（`identity_store.js:17-20,51-71`；`config/network.json` 的 `_剩余风险`）。

### 6.3 归一方案（people 主键 + provider）

```
people(
  id            INTEGER PRIMARY KEY,
  provider      TEXT NOT NULL CHECK(provider IN ('mojang','offline')),
  subject       TEXT NOT NULL,          -- mojang: 去连字符小写 uuid；offline: 自建 server-side id
  display_name  TEXT,                   -- 最近一次见到的名字（仅展示，不作身份）
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  UNIQUE(provider, subject)
)
```

- **正版**：`provider='mojang'`，`subject=uuid`（稳定、不可冒名）。
- **离线**：`provider='offline'`，`subject` 用**自建随机 id**（首次入服生成并落库），**不再用名字派生**。同时保留 `offline_binding(server_id, name, bound_at, approved_by)` 作为"名字→id"的**弱映射**，只用于"识别这是同一个人"的提示，不用于授权。
- **授权仍必须经过面板码**：`!claim` 把"当前连接"绑到某个 `people.id`，而不是"名字=某人"。
- `avatar.person_id` 上加唯一约束（见 §7.2）才能真正实现约束①。

**必须写进文档的诚实结论：**
> 自建 server-side id 只能提供"稳定的句柄"，**不能提供"不可冒名"**。离线服没有共享秘密，服务端只能看到客户端自报的名字；任何"第一次见到这个名字就认定为某人"的规则，都可以被"先到者冒充"击穿。要根治只有三条部署选择：① `online-mode=true`；② 装离线可用的登录插件（AuthMe 等，密码=秘密）；③ 书面接受风险。代码层能做的是"把风险收敛到窗口内 + 让它在面板上可见"（现状已做到这一步）。

---

## 7. B：目标形态（最小可行，不堆层）

**只两个库**，不引入服务、不引入第三层：

- `_global/mind.sqlite`：全局层（人、关系、分身归属、世界注册表、跨存档记忆）。
- `_worlds/<world_id>/board.sqlite`：存档层（队伍、任务板、预占、流水、世界记忆）。

### 7.1 实体表

| 实体 | 层 | 进库 | 主键 | 唯一约束 / 索引 | 单写进程 | 不做会出的**具体事故** |
|---|---|---|---|---|---|---|
| `people` | 全局 | ✅ | `id` | `UNIQUE(provider, subject)`；`INDEX(display_name)` | mindserver | 无法回答"这个人是谁"；同一人被当成 N 个人，关系/履历各算各的；改名即换人 |
| `avatar` | 全局 | ✅ | `id`（= bot 名） | **`UNIQUE(person_id)`**（NULL 允许多个）；`INDEX(person_id)` | mindserver | 一玩家开 N 个分身（现状）；或一个分身被 N 个玩家同时当 owner（现状） |
| `relation` | 全局 | ✅ | `id` | `UNIQUE(from_person_id,to_person_id,kind)`；`INDEX(to_person_id,kind)` | mindserver | 交友/结怨只能活在对话摘要里，20KB 上限一到就丢；无法"按人查恩怨" |
| `world` | 全局 | ✅ | `id`（UUID） | `UNIQUE(level_name, created_at)`；`INDEX(archived_at)` | mindserver | 无法区分"这是第几个存档"；重置后账本/队伍串档 |
| `memory` | 全局（`scope='global'`）/ 存档（`scope='world'`，带 `world_id`） | ✅ | `id` | `UNIQUE(avatar_id, scope, world_id, key)`；`INDEX(avatar_id, updated_at)` | 全局层 mindserver；世界层 mindserver | 现在 memory.json 一个 20KB 文件既装人设又装坐标；坐标串档、人设被挤掉 |
| `team` | 存档 | ✅ | `id` | `UNIQUE(world_id, name)` | mindserver | "组队"只能靠聊天约定；同名队无法区分；队伍无法跨重启存在 |
| `team_member` | 存档 | ✅ | `(team_id, avatar_id)` | `UNIQUE(avatar_id)`（一人同时只在一队） | mindserver | 一个分身同时属于多队 ⇒ 材料清单/可见性互相污染 |
| `board_job` | 存档 | ✅（扩展现表） | `id` | 现 PK + `INDEX(world_id, state, priority, created_at)`、`INDEX(world_id, team_id, state)`、`INDEX(source_person_id, created_at)` | mindserver | 现在只能按状态/assignee/skill 查；**不能按时间/玩家/类型统计**；跨存档串单 |
| `inventory_reservation` | 存档 | ✅ | `id` | `UNIQUE(world_id, job_id, item, chest_key)`；`INDEX(world_id, item, state, expires_at)` | mindserver | **两个分身同时把最后一组材料规划走**（现状只能防同箱同时开）；无过期回收则料被永久占 |
| `ledger` | 存档 | ✅ | `id`（自增/ULID） | `INDEX(world_id, ts)`、`INDEX(world_id, avatar_id, ts)`、`INDEX(world_id, job_id)`；**只追加** | mindserver | 没有"谁在什么时候从哪个箱子领了多少"；无法对账、无法追责、无法统计消耗 |
| `container_cache`（可选，非真相） | 存档 | ⚠️ 可留 | `(world_id, chest_key, item)` | `PRIMARY KEY(world_id,chest_key,item)`；`verified_at` | mindserver | 若把缓存当真相：幽灵库存 + 白跑 + 规划失真（现状） |

> 说明：`board_job` 复用现有 `jobs` 表，只加 `world_id`、`team_id`、`source_person_id` 三列（幂等迁移已有基建：`board_store.js:176-224` 的 `PRAGMA user_version` + 补列）。`claims` 表保留为"空间/容器/实体"锁，**不要**把它硬改成数量账（语义不同，混用会让两类冲突判定互相污染）。

### 7.2 必须单进程内的读写

| 操作 | 为什么必须单进程 |
|---|---|
| `people` / `avatar` / `relation` 的全部写入 | 唯一约束的正确性依赖单一写入序列；两进程同时"首次入服下发 id"会插两条 |
| `team` / `team_member` 写入 | 成员变更与"共享清单可见性"必须同一时刻生效，否则会短时越权看到别队材料 |
| `board_job` 领单/收尾/状态转移 | 现 `claimFor` 的原子性依赖单写者（`UPDATE … changes`） |
| `inventory_reservation` 的"预留/释放/结算" | 必须"条件 UPDATE + changes"一条语句完成；SELECT-then-UPDATE 会超卖 |
| `ledger` 追加 | 与预占结算同一事务，保证"预占减少"与"消耗流水"同生共死 |
| 世界切换/重置（`world.archive` + 新 id） | 必须与板上所有写入互斥；否则会出现"半新半旧"的板 |

**可以并发的读写：**
- 所有 agent 侧的**读**（列表、查询、看板）：走 socket RPC（现成），或对 WAL 开只读连接（可选优化）。
- 每个分身的 `memory.json` / `histories` 写入：仍然"每文件一个写者"（该 bot 进程），不需要跨进程锁；但**世界相关的坐标类记忆**应迁到存档库，避免与全局层混写。
- 地形 `terrain3d.db`：每 bot 一份，本来就不共享（`board_store.js:2009-2013` 明确不要合并），保持"每 bot 单写者"，但路径必须带 `world_id`。

### 7.3 迁移顺序（建议，不含代码改动）

1. **止血**：禁止工具进程写生产板库（`openBoard()` 加"非 mindserver 必须显式传入临时目录"的守卫）；给 `claims` 加 `UNIQUE(key)`。
2. **加维度**：`world` 注册表 + `world_id` sidecar；`jobs/claims/shared` 加 `world_id`（幂等迁移）；把 `_board` 搬到 `_worlds/<id>/`。
3. **加人**：`people` / `avatar` / `relation`；身份绑定改写成"绑到 person"，`avatar.person_id UNIQUE`；面板发码时做"此人已有分身"检查。
4. **加队**：`team` / `team_member`；`jobs.team_id`；`claimFor` 增加队伍过滤；实现 `!addSharedJob` / `!pauseJob` / `!resumeJob`。
5. **加账**：`inventory_reservation` / `ledger` / `reconcile`；把 `flow_store` 的"取料"改成"预占→取→结算"，`!putInChest` 旧路径并入同一账本（否则永远是两份真相）。
6. **加查询**：按 `(world_id, ts)` / `(avatar_id, ts)` / `(skill)` 的索引 + 一个只读统计接口；面板加"任务板/队伍/材料"页。

---

## 8. C：残留风险

### 8.1 离线身份仍可被冒名（收敛，不可根治）

| 残余风险 | 说明 | 可做的收敛 |
|---|---|---|
| 先到者冒充 | 离线服第一次见到"HEAVENZEH"这个名字，无法区分是不是本人；若自建 id 按名字首次下发，冒充者可先占 | 首次绑定**必须经面板码**（面板持有=本人），且把"首次见到即绑定"从代码里删掉 |
| 同名同时在线 | 服务端会踢重复登录，但"改名后重进"仍可命中同一 uuid | 会话窗口（现 60 分钟）+ `weak` 标记 + 面板显示 |
| 本机提权 | 能读 `identity-codes.json` / `identity.json` 的人可冒充（注释已声明，`identity_store.js:17-20`） | 文件 ACL 收紧（vault 已有 icacls 先例，`secrets_vault.js:197-221`） |
| 面板 token 泄露 | token 在 `mindcraft/.mindserver-token`，面板用它签发码 | 已有 ACL/不打印（`start-panel.ps1:321-344`）；继续按现状 |

> **结论**：`provider='offline'` 的 people 记录，其可信度上限是"面板持有人确认过这个人"，不是"密码学证明"。文档必须这么写，不能宣称"归一后不可冒名"。

### 8.2 预占 vs 真实箱子不一致时的收敛策略

建议三条硬规则：
1. **真实箱子永远赢**：任何对账发现差异，都以"打开箱子看到的"为准；账本写一条 `delta` 修正行（`reason='reconcile'`），**不修改历史行**。
2. **预占必须比缓存短命**：预占 TTL（如 60–120s）+ 心跳续期；缓存带 `verified_at`，超过阈值（如 10 分钟）在规划时降级为"仅提示，不作承诺"。
3. **开箱即对账**：每次 `openContainer` 成功后，把容器内容整体回写 `container_cache`（`verified_at=now`），并结算该 job 的预占（领用→`ledger`，未用→释放）。这比"定时全服扫箱"便宜且及时；定时任务只做兜底（清理过期预占 + 标记长期未核对的箱子）。

冲突优先级（写进实现约定）：
`真实箱子内容 > 本次开箱回写 > 预占（未过期）> 缓存（未核对）`。

### 8.3 备份与一致性（世界快照 ≠ 库快照）

现状（值得肯定的部分）：
- 冷备：服务端在跑就拒绝（`backup-world.ps1:11-18`，exit 2）；同一包里同时含 `world` 与 `bots`，且 `bots/_board/board.sqlite` 用 `VACUUM INTO` 取一致副本（`backup-world.ps1:20-23,591-604`）。
- 校验器要求 `world` 与 `bots` 两个组件都在，缺 `bots.zip` 直接 FAIL（`verify-world-backup.ps1:21-24,461-470`）；恢复演练对板库做 `integrity_check`（`restore-drill.ps1:427-433`）。

残留风险：

| 风险 | 触发 | 后果 | 收敛 |
|---|---|---|---|
| **部分恢复** | 只解 world 不解 bots（或反之） | 队伍/板/库存账本与真实箱子对不上 | 恢复脚本必须**整包恢复**或**拒绝**；启动时比对 world_id 与板库 `world_id`，不一致则 fail-closed（拒绝接单，提示对账） |
| **世界重置但库不动** | 玩家删了 `server/world` 重开 | 旧队伍/板/预占被新世界继承（现状必然发生，因为无 world_id） | 新 world_id ⇒ 旧 `_worlds/<old>/` 归档为只读；新板从空开始 |
| **库恢复但世界前进** | 只回滚 DB（如手动拷备份） | 预占指向已不存在的箱子/已被搬空的箱子 | 启动时把所有未过期预占标记为"待核对"，首次对账后释放 |
| **热备份** | 有人 `-Mode Hot -Force` | region 与 WAL 不同刻，manifest 也救不了 | 保持"冷备是唯一安全路径"的硬约束，不做热备承诺 |

> 结论：现有冷备在"整包恢复"前提下是一致的；**一旦允许部分恢复/世界重置，就必须有 world_id + 启动对账**，否则"备份一致"只是巧合。

---

## 9. D：残缺功能登记

| # | 项 | 证据 | 性质 | 是否为三约束的前置缺口 |
|---|---|---|---|---|
| D1 | 载具错误码零产出：`NO_VEHICLE` / `RIDE_FAILED` / `NOT_MOUNTED` / `DRIVE_FAILED` | `contract.js:27-39` 明确写"当前全仓零产出"；`atom_boat.js` 已于 2026-11-01 删除；`!ride` 仍登记为信任级（`permissions.js:375`），但动作层 mount/dismount 未建 | 登记未实现（错误码先于实现） | 否（与三约束无关，但会让模型"看到码以为有能力"） |
| D2 | `!addSharedJob` 只在权限表登记，**无命令实现** | `permissions.js:125`；`src/agent/commands/*.js` 无此 name | 占位无实现 | **是（约束②③的入口）** |
| D3 | `!pauseJob` / `!resumeJob` 同上 | `permissions.js:126` | 占位无实现 | 是（组队调度需要暂停/恢复） |
| D4 | `flow_store` 的 `manifest.claims = ['container:chest']` 是**非法 key**（缺坐标） | `flow_store.js:47`；`board_claims.js:45-49` 要求 `x,y,z` | 占位/死元数据 | 是（一旦有人把 manifest.claims 接进 `job.claims`，所有存取单的预占会 `INTERNAL` 全失败） |
| D5 | 多 bot 协作仍是"睡 10 秒 + 缺人就 killAll" | `tasks.js:539,620`（两处 `TODO wait for other bots to join`） | 未实现 | 是（这是"组队"的旧实现，和任务板是两套） |
| D6 | **任务板零 UI** | `web/src/views` 只有 Console/Settings/Setup/Terrain/Vault/Debug；无 board/team 页；`QuickCommands.vue` 也没有 `!addJob`/`!jobs` | 后端有能力、UI 无入口 | 是（用户"看板/组队"没有操作面） |
| D7 | `DebugView` 的「任务 / 运行时」是**单 agent 任务态**，不是任务板 | `DebugView.vue:59,94-121` | 名不副实 | 否（但会误导以为有板） |
| D8 | **两个箱子账本**：`shared` vs `memory/chests.json` | `flow_store.js:70-88`（写 shared）vs `skills.js:4447-4504,4535`、`landmarks.js:165-205`（读/写本地） | 双真相 | **是（约束③：队内清单必须只有一个账）** |
| D9 | `verifyChest` 只修本地账本，不写共享账本 | `skills.js:5368-5410` | 半实现 | 是（"核对"不会修正队内清单） |
| D10 | 文档漂移：`config/network.json` 的 `_身份与权限` 写 720 分钟，`settings.js:43-58` 已是 60 | 两处对照 | 文档不一致 | 否（但会让人误判安全窗口） |
| D11 | `jobs` 无归档/清理，`listJobs` 默认 LIMIT 200 | `board_store.js:508-520` | 规模缺口 | 否（但统计/历史查询必须先解决） |
| D12 | 身份表损坏静默空表、无留证/无告警 | `identity_store.js:242-250` | 容错不一致 | 否（但 people 迁移前建议对齐 memory 的 `.corrupt-*` 做法） |

**前置缺口排序（对三约束）：**
1. D8/D9（一个箱子账本）→ 否则共享清单永远是假的。
2. D2/D3（共享单入口与暂停/恢复）→ 否则"组队干活"没有入口。
3. D4（非法 claims 占位）→ 否则接账本时会把所有存取单打挂。
4. D6（任务板 UI）→ 否则用户看不到队伍/清单。
5. D1/D5/D7/D10/D11/D12 → 与本三约束无关或次生。

---

## 10. 三条硬约束的"最小可判定"验收口径（给修复阶段用）

| 约束 | 可判定的验收（不带实现细节） |
|---|---|
| ① 一玩家一分身 | 对同一 `people.id` 连续两次绑定不同 avatar ⇒ 第二次必须被拒（`UNIQUE(person_id)` 冲突），且面板给出"你已有分身 X"；对同一 avatar 绑定第二个 person ⇒ 必须被拒或明确"换绑"语义 |
| ② 内置板 + 组队 | 两个分身入同一队后，A 下的单在 B 的 `!jobs` 可见且可领；不入队的分身看不到、领不到；`!addSharedJob` 可用 |
| ③ 队内共享材料清单 | 队伍页显示"材料 / 需要 / 已预占 / 可用 / 最后核对时间"；两人同时申请最后一组 ⇒ 只有一个 `ok`，另一个收到 `CLAIM_CONFLICT`（而不是白跑后 `NO_ITEM`） |

---

## 11. 证据索引

**核心代码**
- `mindcraft/src/agent/library/board_store.js`：状态机 36-74；SCHEMA 110-155；`BOARD_SCHEMA_VERSION`/迁移 176-224；损坏判定 226-330；`claimFor` 642-702；`heartbeat` 712-744；`settleCraftLedger` 798-817；`finish` 830-892；`expireLeases` 1083；`countJobs` 1251-1256；`reserve` 1285-1327；`release` 1341-1386；`expireClaims` 1392-1397；`renewClaims` 1417-1453；`splitByCount` 1914-1950；`mergeSharedChest` 2076-2110；`findItemInSharedChests` 2123-2138；地形不共享的说明 2009-2013。
- `mindcraft/src/agent/library/board_claims.js`：六种 key 9-20；`claimsConflict` 103-134（`item` 按名冲突 122-123）；`deriveClaims` 176-256（materials 231-254）。
- `mindcraft/src/agent/library/board_server.js`：`botRegistry` 58；`board:reserve` 336-347；`board:shared-merge` 405；5s 扫描 451-460。
- `mindcraft/src/agent/library/board_scheduler.js`：主循环 1-40；`preempts` 96-120；`_reserveClaims` 683-706。
- `mindcraft/src/agent/library/composite_registry.js`：`reserveNowFn` 486-508；无板 fail-closed 616-640；`releaseRuntimeClaims` 650-670。
- `mindcraft/src/agent/library/act_container.js`：开窗补占位 186-215；无回调只 warn 32-42。
- `mindcraft/src/agent/library/flow_store.js`：`manifest claims` 47；`rememberChest` 70-88；`store` 149-198。
- `mindcraft/src/agent/library/skills.js`：`putInChest` 4447-4504；`findItemInStorage` 4523-4563；`viewChest` 1584-1610；`verifyChest` 5368-5410。
- `mindcraft/src/agent/library/landmarks.js`：本地账本 1-45；`findItemInChests` 165-205。
- `mindcraft/src/agent/library/memory_store.js`：REGISTRY 33-47；`memoryDir` 65-73；读 99-124；写 129-147；`updateStore` 153-158。
- `mindcraft/src/agent/history.js`：`memory_fp` 37；`appendFullHistory` 158-194；`capSize` 20KB 333。
- `mindcraft/src/agent/library/terrain3d.js`：`openDb3d` 96-110。
- `mindcraft/src/agent/library/bot_paths.js`：bots 根 59-63；`mapDirOf` 79-81；`botDirOf` 89-91；`boardDirOf` 102-104；双 bots 目录说明 39-46。
- `mindcraft/src/mindcraft/identity_store.js`：离线 uuid 72-79；`isWeakBinding` 110-115；文件路径 173-180；`writeStore` 258-268；`addCode` 287-301；`consumeCode` 309-320；`bindFromCode` 329-351；`resolveBinding` 365-381。
- `mindcraft/src/agent/permissions.js`：OPEN（`!claim`）64；OWNER 名单 70-90；TRUSTED 96-126；`resolveLevel` 204-256（绑定优先 214-218）；`maxJobLevel` 288-290；`!ride` 375。
- `mindcraft/src/mindcraft/offline_identity_risk.js`：风险评估 35-70；`readServerOnlineMode` 128-138；`resolveIdentityPolicy` 158-175。
- `mindcraft/src/mindcraft/config_center.js`：三个配置源 3-15；路径 56-60；`GROUP_META` 75+。
- `mindcraft/src/agent/library/secrets_vault.js`：库路径 51,118-123；`busy_timeout` 137-140；ACL 197-221。
- `mindcraft/src/mindcraft/mindserver.js`：板启动 963-984；身份三事件 1252-1352；跨 bot 绑定统计（仅诊断）1826-1842。
- `mindcraft/src/agent/commands/identity.js`：`whois` 24-38；读码 40-48。
- `mindcraft/src/agent/commands/actions.js`：`!addJob` 848-887（`source: player:<name>` 878）；`!jobs` 889-926；`!cancelJob` 927-946。
- `mindcraft/src/agent/library/contract.js`：载具错误码 27-39。
- `mindcraft/src/agent/tasks/tasks.js`：`TODO wait for other bots` 539,620。

**配置 / 脚本 / 前端**
- `server/server.properties:38`（`online-mode=false`）、`level-name=world`。
- `config/network.json`：main（bind all / whitelist / offline / players=[HEAVENZEH]）、`_剩余风险`、`_身份与权限`（720 分钟，已过期文案）。
- `mindcraft/settings.js:43-58`（identity_binding：enabled / legacy=false / session / 60 分钟）。
- `config/backup.json`（enabled / onServerStop / 04:30 / keep=7 / excludeSecrets）。
- `scripts/backup-world.ps1`：冷备 11-18；VACUUM INTO 20-23；板库占用检测 184-185；板快照 591-604；manifest 789-841。
- `scripts/verify-world-backup.ps1`：必须含 world+bots 21-24,461-470；板快照校验 392-403。
- `scripts/restore-drill.ps1`：板 `integrity_check` 427-433。
- `web/src/views/*`（Console/Settings/Setup/Terrain/Vault/Debug）——无任务板/队伍页；`web/src/components/IdentityPanel.vue` 按 `currentAgent` 工作；`web/src/components/QuickCommands.vue` 无板命令。

**只读实测**
- `mindcraft/bots/_board/board.sqlite`：`user_version=2`，表 `claims/jobs/shared`，`jobs=0 claims=0 shared=1`，20 页 / 9 页空闲；`bots/_board/board.sqlite`：`user_version=0`、全 0 行（遗留目录）。
- `du`：`server/world` 121MB；`mindcraft/bots` 35MB（`deepseek` 22MB）。
- 全仓 grep：`world_id|worldId|save_id|saveId` 在 `mindcraft/src` 与 `web/src` **0 命中**。

---

## 12. 附：目标形态 DDL 草案（只作方案，未落地）

> 仅用于修复阶段评审；本任务未修改任何产品代码。

```sql
-- ========== 全局层：mindcraft/bots/_global/mind.sqlite ==========
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE people (
  id           INTEGER PRIMARY KEY,
  provider     TEXT NOT NULL CHECK(provider IN ('mojang','offline')),
  subject      TEXT NOT NULL,
  display_name TEXT,
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL,
  UNIQUE(provider, subject)
);
CREATE INDEX idx_people_name ON people(display_name);

CREATE TABLE avatar (
  id           TEXT PRIMARY KEY,          -- 原 bot 名（迁移期同名）
  person_id    INTEGER REFERENCES people(id),
  profile      TEXT,
  created_at   INTEGER NOT NULL,
  retired_at   INTEGER
);
CREATE UNIQUE INDEX ux_avatar_person ON avatar(person_id) WHERE person_id IS NOT NULL;

CREATE TABLE relation (
  id             INTEGER PRIMARY KEY,
  from_person_id INTEGER NOT NULL REFERENCES people(id),
  to_person_id   INTEGER NOT NULL REFERENCES people(id),
  kind           TEXT NOT NULL CHECK(kind IN ('friend','feud','trust','debt')),
  score          INTEGER NOT NULL DEFAULT 0,
  since          INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE(from_person_id, to_person_id, kind)
);

CREATE TABLE world (
  id          TEXT PRIMARY KEY,           -- sidecar 里的 UUID
  level_name  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE UNIQUE INDEX ux_world_level ON world(level_name, created_at);

CREATE TABLE memory (
  id         INTEGER PRIMARY KEY,
  avatar_id  TEXT NOT NULL REFERENCES avatar(id),
  scope      TEXT NOT NULL CHECK(scope IN ('global','world')),
  world_id   TEXT REFERENCES world(id),
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(avatar_id, scope, world_id, key)
);

-- ========== 存档层：mindcraft/bots/_worlds/<world_id>/board.sqlite ==========
CREATE TABLE team (
  id         TEXT PRIMARY KEY,
  world_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(world_id, name)
);

CREATE TABLE team_member (
  team_id   TEXT NOT NULL REFERENCES team(id),
  avatar_id TEXT NOT NULL,
  role      TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(team_id, avatar_id)
);
CREATE UNIQUE INDEX ux_member_one_team ON team_member(avatar_id);  -- 一人同时只在一队

-- jobs：在现有表上加三列（幂等迁移）
--   ALTER TABLE jobs ADD COLUMN world_id TEXT;
--   ALTER TABLE jobs ADD COLUMN team_id  TEXT;
--   ALTER TABLE jobs ADD COLUMN source_person_id INTEGER;
CREATE INDEX idx_jobs_world_state ON jobs(world_id, state, priority, createdAt);
CREATE INDEX idx_jobs_world_team  ON jobs(world_id, team_id, state);
CREATE INDEX idx_jobs_source      ON jobs(source_person_id, createdAt);

CREATE TABLE inventory_reservation (
  id         TEXT PRIMARY KEY,
  world_id   TEXT NOT NULL,
  job_id     TEXT NOT NULL,
  avatar_id  TEXT NOT NULL,
  item       TEXT NOT NULL,
  qty        INTEGER NOT NULL CHECK(qty > 0),
  chest_key  TEXT,                      -- 申请时已知就填；执行期补
  state      TEXT NOT NULL CHECK(state IN ('active','settled','expired','cancelled')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(world_id, job_id, item, chest_key)
);
CREATE INDEX idx_res_world_item ON inventory_reservation(world_id, item, state, expires_at);

CREATE TABLE ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id   TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  avatar_id  TEXT NOT NULL,
  job_id     TEXT,
  item       TEXT NOT NULL,
  delta      INTEGER NOT NULL,            -- 负=取走，正=存入
  chest_key  TEXT,
  reason     TEXT NOT NULL CHECK(reason IN ('withdraw','deposit','craft','reconcile','rollback'))
);
CREATE INDEX idx_ledger_world_ts ON ledger(world_id, ts);
CREATE INDEX idx_ledger_avatar_ts ON ledger(world_id, avatar_id, ts);
CREATE INDEX idx_ledger_job ON ledger(world_id, job_id);

-- 可选：缓存（非真相，必须带 verified_at）
CREATE TABLE container_cache (
  world_id    TEXT NOT NULL,
  chest_key   TEXT NOT NULL,
  item        TEXT NOT NULL,
  qty         INTEGER NOT NULL,
  verified_at INTEGER,                    -- 最后一次"真的打开看过"的时间
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY(world_id, chest_key, item)
);
```

**唯一约束与业务规则的对应：**
- `ux_avatar_person` → 约束①（一玩家一分身）。
- `ux_member_one_team` → 约束②（一人一队，队内可见）。
- `inventory_reservation` + `ledger` + `container_cache.verified_at` → 决策 A（预占/领用/对账三件套）。
- `world.id` → 决策 B（存档层重置）。
- `people(provider, subject)` → 决策 C（正版/离线归一）。

---

**（完）**
