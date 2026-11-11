# R6 收口 · 任务板 / 账本 / 身份存储（t2 / fix-board2）

> 写作用域（本轮实际改动）：`mindcraft/src/agent/library/board_store.js`、`board_server.js`、
> `board_client.js`、`flow_store.js`、`mindcraft/src/mindcraft/identity_store.js`
> + 新增/扩充的离线单测（`mindcraft/tools/*_unit.mjs`）。
> 其他文件只读：`landmarks.js`、`mindcraft.js`、`commands/identity.js`、`mindserver.js` 一行未改（残留见 §9）。
>
> 逐条：**原文属实? / 改了什么 / 验证 / 残留**。

---

## 0. 结论速览

| 条目 | 状态 | 关键证据 |
|---|---|---|
| ADR §10.2-1（merge 抹掉 category/note） | ✅ 根治 + 新回归 | `shared_chest_merge_unit` ⑩/⑩-b（13/13） |
| #20 `board:add` 放行 state/parentId/assignee/maxAttempts | ✅ 修 | `board_add_guard_unit`（22/22） |
| #67 `flow_store` 非法 claim key 占位 | ✅ 修 | `board_add_guard_unit` ⑩/⑪/⑫/⑭ |
| #69 身份表损坏静默返回空表 | ✅ 修 | `identity_corrupt_unit`（4/4） |
| #22 状态机拿旧快照判 / heartbeat 租约只在 JS 判 | ✅ 修（SQL 条件化） | `board_transition_guard_unit`（5/5） |
| #24 `botRegistry` 无上限无清理 / roles 自报 | ✅ 修（+roles 定性） | `board_registry_unit`（5/5） |
| #21 绑定码文件跨进程读-改-写 | ✅ 原语已根治（调用方待切换） | `identity_claim_race_unit`（4/4，真子进程） |

验证命令与结果（本机，2026-11-11）：

```
node tools/board_store_unit.mjs            25/25
node tools/board_iface_unit.mjs            16/16
node tools/board_scope_unit.mjs            10 PASS / 0 FAIL
node tools/shared_chest_merge_unit.mjs     13/13
node tools/board_open_migrate_unit.mjs      8/8
node tools/board_b3_unit.mjs               23/23
node tools/board_b4_unit.mjs               11/11
node tools/container_fix_unit.mjs           5/5
npm run gate                               exit 0（含 lint:hard / preflight / patch_integrity）
node tools/unit_all.mjs board              26/26 脚本
node tools/unit_all.mjs identity            5/5 脚本
```

---

## 1. ADR §10.2-1 · `mergeSharedChest` 抹掉 `category`/`note`（最关键）

**原文属实?** 属实。`board_store.mergeSharedChest` 过去把整份 value **重建**成
`{pos, items, owner, at}` 四个字段，箱子档案里其余字段（`category` / `note` / `lastUsed`）
一次增量入库就没了。今天靠 `landmarks.refreshChests` 的「档案字段只增不减」兜住
（`landmarks.js:170` 那段本地补丁），但那是**内存里补**：新进程首次读到"只被 merge 过"的箱子时，
板库里已经没有 category → 分类箱子变 `unsorted`。报告与 ADR §10.2 第 1 条说的是同一件事。

**改了什么**（`board_store.js:2433-2443`）
- 以 `{ ...prevValue }` 为**基底**，只覆盖本函数负责的四个字段：`pos` / `items` / `owner` / `at`；
  未知字段（含将来的字段）原样保留 —— 这是"局部更新"而不是"整份重建"。
- `items` 的基底兼容老形状：`keep.items ?? keep.contents`，随后 `delete keep.contents`
  （`items` 是权威口径，避免同一份内容留两处而漂移）。
- 若上一版 value 带墓碑 `removed:true`，合并时删掉该标记：能合并 ⇒ 这个箱子此刻确实在用。
- **没有改表结构**：`shared.value` 本来就是 JSON 文档，不需要新增列，因此也**不需要迁移**
  （`BOARD_SCHEMA_VERSION` 保持 3，`user_version` 不动）。"shared 表仍是唯一真相"没有变化：
  写入路径仍然只有 `putShared` / `mergeSharedChest`，`chest.json` 依旧没有任何写入口。

**验证**（新用例，且证明"改之前会红"）
- `tools/shared_chest_merge_unit.mjs` 新增 **⑩**：写档案（category/note/lastUsed）→ 增量 merge
  （`{stone:2}`）→ **关连接、重开库**（模拟重启）→ 断言 `category==='木料' && note && lastUsed`
  仍在、`items` 已合并。**⑩-b 反证**：同一场景用"老实现只写四个字段"复刻 → category 必丢。
- 反证实测：把 `...keep` 临时撤掉后单跑，⑩ 立刻 FAIL（`12/13`），恢复后 `13/13`。
  这条用例不是在描述现状，它真的守住了这次修改。

**残留**：`landmarks.js:170-176` 的「档案只增不减」本地回填**保留**（不在本任务写作用域）。
它现在是纯冗余的第二道兜底；要删属于 `landmarks.js` 的清理项，需要那个文件的所有者动手。

---

## 2. #20 · `board:add` 只校验 skill/priority，其余字段全放行

**原文属实?** 属实，但**修法要照顾现有合法调用**：`strat_obtain.js:787` 的壳父单是
`state:'running'` + `assignee=self`，`strat_first_night.js:284`、`commands/actions.js:871` 用
`state:'ready'`。所以不能只放 `{pending,ready}`。

**改了什么**
- `board_server.js:52-130` 新增纯函数 `validateAddFields(job)`（`validateIncomingJob` 里调用），
  与 socket 解耦、可单测：
  - `state`：只接受 `pending | ready | running`；其余（`done/failed/cancelled/claimed/paused/blocked`）拒绝
    —— 伪造历史、伪造"正在跑"都在这里挡掉。
  - `state==='running'` **必须带 assignee**（无主的 running 单没人敢收）。
  - `maxAttempts`：必须是 `1..10` 的整数，越界即拒（不是静默夹，避免"改用户数据不告知"）。
  - `parentId` / `assignee`：形状校验（非空字符串、去空白、长度 ≤64、无控制字符）。
  - `claims`：`normalizeClaimKeys` 校验（见 #67）。
- `board_server.js:483-501`（handler 层，需要 db）：
  - `parentId` **必须指向存在的单**，且**不能指向终态单**（`NO_TARGET`）；agent 连接只能挂在
    自己名下的父单下（`NO_PERMISSION`）。
  - agent 连接的 `assignee` 必须是**已 hello 的 bot**（`NO_PERMISSION`）。面板连接是控制层，
    允许提前指派（保留运维用法）。

**验证**：`tools/board_add_guard_unit.mjs`（新）22/22：
① 默认 ready/3、② ready+maxAttempts 放行、③ running+assignee 放行（三种合法形态全都活着）、
④ 六种伪造 state 全拒、⑤ running 无 assignee 拒、⑥ maxAttempts 999/0/-1/2.5 全拒、
⑦ 幽灵 parentId 拒、⑧ 终态 parentId 拒、⑨ 合法 parentId 落库、⑬ `validateAddFields` 独立可用。

**残留**：`kind` 字段仍未校验（`personal|parent|...` 是自由字符串）——报告没点名，本轮不动；
若要收紧，建议与 `rollupParent` 的 kind 语义一起做。

---

## 3. #67 · `flow_store` 的 `manifest.claims = ['container:chest']` 是非法 key

**原文属实?** 属实且已确认是**死元数据**：`deriveClaims`（`board_claims.js:185`）只读
`job.claims` 与 `args`，从不读 `manifest.claims`；而容器预约的真实入口是
`act_container.js:203` 在**开窗那一刻**按真实坐标生成 `container:x,y,z`（T6 已落地）。
所以这个常量既没被消费，形状又非法（`parseClaimKey` 要求 `x,y,z`）。

**改了什么**
- `flow_store.js:59-60`：删掉该常量，并留一行说明"容器预约由 act_container 运行时按坐标补"。
  没有改成"另一个常量"或"假的函数"（那只是把死代码换个形状）。
- 真正的防线补在**入口**（报告建议的"校验 + 失败日志"）：
  - `board_client.js:276-284`：`add()` 先 `normalizeClaimKeys`，非法即 `console.warn` + 本地拒发
    （日志里带具体 key 错误），不把非法 key 送进账本。
  - `board_server.js`（`validateAddFields` 内）：服务端**再校验一遍** `claims`，非法即拒 ——
    因为 socket 外部可达，不能只信 client。

**验证**：`board_add_guard_unit` ⑩（`container:chest` 被拒且**库里 0 行**）、
⑪（合法 `container:1,64,2` 放行并落库）、⑫（源码里已无该常量、`manifestStore.claims === undefined`）、
⑭（client 侧先拒 + 有 warning，socket 都没发）。

**残留**：`flow_fight.js`(`entity:target`)、`flow_shelter.js`(`area:<自己周围>`)、
`flow_smelt.js`(`station:furnace`) 里还有同族的**非法占位**（同样不被 `deriveClaims` 消费，
但形状同样不合法）。它们在本次写作用域之外，**建议统一清掉**（一行删除 + 注释），
否则将来"把 manifest.claims 接进 job.claims"时会以全量 `INTERNAL` 的形式爆出来（正是 #67 的触发路径）。

---

## 4. #69 · 身份表损坏静默返回空表

**原文属实?** 属实。`identity_store.readStore` 的 `catch` 直接 `return {store: emptyStore(), ok:false}`：
没有日志、没有留证。方向和 `memory_store`（`.corrupt-<ts>` 改名 + warn）不一致。

**改了什么**（`identity_store.js:240-270`）
- 拆开两种失败：**读不出来**（权限/IO）→ `reason: unreadable`，**不动文件**；
  **解析失败** → 称 `backupCorruptFile()` 把原文件改名成 `identity.json.corrupt-<ts>`，
  `console.error` 一条（含备份路径），返回 `{ok:false, corrupt:true, backup}`。
- 原名文件消失 ⇒ 后续 `writeStore` 不会把证据覆盖掉（有专门用例守这一条）。
- 表仍然是 fail-closed（损坏 → 空表 → 全员 guest），**行为不变，只是变成可观测**。

**验证**：`tools/identity_corrupt_unit.mjs`（新）4/4：
① 正常文件不误伤；② 损坏 → 空表 + `corrupt:true` + 原文件内容原样在 `.corrupt-*` 里 + `console.error` 有告警；
③ 文件不存在 → `missing`，不凭空生成 `.corrupt`；④ 之后 `writeStore` 写新表，证据文件仍在。

**残留**：**面板可见状态**这一层没做 —— `mindserver.js:1573` 的 `identity-status` 只取
`readStore(...).store`，把 `reason/corrupt` 丢了。要显示"身份表已损坏、已留证"，需要改
`mindserver.js`（本任务写作用域之外）把 `idRead.corrupt` / `idRead.backup` 带进 ack
（字段是**新增**的，不动既有字段语义）。需要谁改什么：`mindserver.js` 的所有者。

---

## 5. #22 · 状态机基于陈旧快照 + heartbeat 租约只在 JS 里判

**原文属实?** 属实。三处证据：
- `heartbeat`：`if (job.lease?.owner !== bot)` 是 JS 快照判断，`UPDATE` 的 WHERE 只有 `id`；
- `setState`：`canTransition(job.state, …)` 用读到的旧 state，`UPDATE` 没有 `state=?`；
- `finish`：`attempts = job.attempts + 1` 来自读快照，`UPDATE` 没有 `state=?` / `attempts=?`
  ⇒ 两次收尾同时到会写同一个 `attempts`，**丢一次计数**。

**改了什么**（全部落成 SQL 条件，成败只看 `changes`）
- `board_store.js:958-962` `heartbeat`：
  `WHERE id=? AND lease_owner=? AND (lease_until IS NULL OR lease_until >= ?)` ——
  续租的"是不是我"和"租约还没过期"都进 WHERE，不再依赖上面那次读。
- `board_store.js:1390-1394` `setState`：`WHERE id=? AND state=?`（起点状态进条件）。
- `board_store.js:1285-1289` `finish`：`WHERE id=? AND state=? AND attempts=?`
  —— 并发收尾只有一个 `changes=1`，另一个 `LEASE_STALE`，`attempts` 不会被写成同一个数。
- `board_store.js:1475-1479` `updateJob`：`patch.state` 存在时追加 `AND state=?`。
- 既有守卫（租约归属 `leaseGuard`、尝试序号 `attemptGuardSql`）保持不变，新的三条与它们并存。

**验证**：`tools/board_transition_guard_unit.mjs`（新）5/5：
- ① **真子进程**并发 finish（3 轮）：每轮 `wins === attempts`（一次成功只记一次，失败方 `LEASE_STALE`）；
- ①b 旧尝试（`attemptSeq=0`）的 finish 被拒，`attempts/state` 一个字段都没写；
- ② 非持有者 `heartbeat` → `LEASE_LOST` 且 `lease_until` 真的没被推后；持有者可续租；
- ③ 同一单第二次 `setState` 被拒；
- ④ 接线守卫：三条前置条件确实写在 UPDATE 里（不是只在 JS 里判了一下）。

**残留 / 诚实边界**
- 这些守卫解决的是"**基于旧快照硬写**"，不是"分布式事务"。同一连接内的读-算-写在同步 SQLite 上
  天然串行；跨进程的写由 SQLite 锁 + `busy_timeout` 串行。`finish` 的"选哪个 next 状态"仍基于
  读快照计算（只是写被条件挡住），极端交错下会出现"该 FAILED 的单被判 READY、下一次尝试再收一次"，
  这个偏差需要把整段逻辑搬进 `BEGIN IMMEDIATE` 才能消掉 —— 属结构性重写，不建议在收口轮做。
- 真机多进程并发写仍未实测（ADR §10.3 同一空白）。

---

## 6. #24 · `botRegistry` 无上限无清理；roles 靠 hello 自报

**原文属实?** 属实。`board:hello` 直接 `botRegistry.set(bot, …)`：无上限、连接断开不摘、
agent 销毁不摘；`roles` 是 hello 里自报的，而 `claimFor` 用它做**资格过滤**。

**改了什么**（`board_server.js`）
- `:42-47` 登记表加**硬上限** `MAX_REGISTERED_BOTS = 64`，条目形状加 `socketId` / `rolesSource`。
- `:209-220` 准入 `registryAdmit(bot)`：已在表内或未满 → 放行；满了 → 先收掉没有连接挂着的残留，
  仍满 → **拒绝**（`code: 'TOO_MUCH'`，reason 写明"已登记 N 只（上限 64）"）+ 一行 warn。
- `:421-427` `socket.on('disconnect')` → 摘掉**这条连接**登记的所有 bot（别的连接的条目不动）。
- `:436-448` 登记时记 `socketId`（断开对得上）与 `rolesSource: 'hello-self-reported'`。
- `roles` 的定性写进了代码注释与本文（§9）：**它只是能力提示，不是授权依据**。

**验证**：`tools/board_registry_unit.mjs`（新）5/5：
① 登记项带 `rolesSource/socketId`；② 断开一条连接 → 它登记的 bot 全摘、别的连接不受影响（3 → 1）；
③ 第 65 只被拒（`TOO_MUCH` + 明确 reason），表停在 64；④ 同一 bot 重复 hello 是覆盖（不占名额、
能力更新）；⑤ roles 原样记下但带 `rolesSource`（可辨别"自报"）。

**残留**
- `agent_processes` 销毁路径在 `mindcraft.js` / `mindserver.js`（不在写作用域）。现在靠 socket
  断开兜住；如果某天 agent 进程与 socket 生命周期脱钩，仍会有残留条目（但**有了上限**，不会再无限涨）。
- **`roles` 仍是自报**：`claimFor` 用它过滤"这单该派给谁"，所以一只 bot 自称 `owner` 能领到
  owner 级角色单。这**不是权限提升**（只是拿到别人的活），但**不能**当授权用 —— 真正的权限在
  `permissions.js` / `identity_store` 那条线上。要根治需要可信角色来源（agent 凭据/服务端下发），
  属 ADR §10.2 第 4 条（per-agent 凭据）那一批。

---

## 7. #21 · 身份绑定码文件跨进程读-改-写（新码被静默抹掉 / 一次性码被复活）

**原文属实?** 属实。码表是文件：面板签发（mindserver）与游戏内核销（agent）各"读 → 改 → 写"，
`rename` 原子但整体不是。两个核销者交错时后写的覆盖先写的，可能同一码用两次或新码被抹掉。

**改了什么**（`identity_store.js`）
- `:180-186` 表里加单调版本号 `rev`（`emptyStore` / `sanitizeStore` 都保留它）。
- `:282-292` `writeStore` 加**乐观锁**：调用方带 `rev`（即"我从盘上读出来的那份"）且与文件当前
  `rev` 不等 → 返回 `{ok:false, reason:'conflict'}`，**不静默覆盖**；写成功后 `rev = curRev + 1`。
  兼容：`rev` 为 0/缺省（现场新建的表）不做冲突判定，保证老的"首次落盘"用法不被误伤。
- `:368-400` 新增 `mutateStore(file, mutator)`：**文件锁（O_EXCL 建 `.lock`，残留超 10s 可抢）
  → 重读 → 改 → 临时文件 + rename**，锁内没有第二个写者；冲突重试 3 次。
- `:399-412` `consumeCodeAtomic(file, code)`：核销走 `mutateStore`，**跨进程单次生效**；
  `:414-421` `issueCodeAtomic(file, p)`：面板签发走同一把锁，避免"读旧写新"抹掉别人刚签的码。

**验证**：`tools/identity_claim_race_unit.mjs`（新）4/4，**真子进程**：
① 4 个进程同时核销同一个码 → 恰好 1 个成功、码从表里消失（`wins=1`）；
② 同进程重复核销：第一次 ok、第二次明确失败（不是"幂等成功"）；
③ 基于旧快照的写被 `rev` 拒掉（`conflict`），B 刚签的码不会被 A 抹掉；
④ `mutateStore` 在锁内读到的是最新表（CCCC 在）再追加 DDDD。
另：`identity_binding_unit` 80/80、`ops003_offline_identity_unit` 28/28（回归未被破坏）。

**残留（需要别人改什么）**
- **agent 侧核销路径未切换**：`src/agent/commands/identity.js:72-90` 仍是
  `readStore → consumeCode → writeStore`。好处是 `rev` 乐观锁把"覆盖"变成了**明确的失败**
  （fail-closed：码不会被用两次，也抹不掉别人的写），坏处是没有重试、文案是"码文件写不回去"。
  建议该文件的所有者把这段换成：
  ```js
  const consumed = consumeCodeAtomic(codesFileOf(agentName), raw);   // 单次核销，带重试
  ```
- **mindserver 侧签发路径**（`mindserver.js` 的 `mutateStoreFile`）已有哈希 CAS + 重试
  （fix-control 做的"失败可见"），但它用的是**自己的**实现。两套 CAS 并存可以工作，
  但建议后续统一收敛到 `identity_store.mutateStore`（一把锁、一处实现）。
- 锁文件 `.lock` 的残留由 `staleMs=10s` 兜底；崩溃在"持锁中"最多让下一个写者等 10 秒。

---

## 8. 表结构 / 迁移

本轮**没有新增或变更任何表结构**，因此没有新迁移：
- `shared.value` 是 JSON 文档（§10.2-1 的 category/note 就在里面），不需要列；
- 身份表的 `rev` 是 JSON 字段（不是 SQLite 列），老文件没有它 → 读出来当 0，写一次就被补上（天然幂等）；
- `BOARD_SCHEMA_VERSION` 保持 **3**，`user_version` 不动；`board_open_migrate_unit` 8/8 仍绿。

---

## 9. 诚实边界（本轮没做完、或故意没做的）

1. **`roles` 仍是自报提示**（#24 的语义层，见 §6）：不作授权依据；根治要 per-agent 凭据（ADR §10.2-4）。
2. **同族非法 claim 占位**还有三处：`flow_fight.js` / `flow_shelter.js` / `flow_smelt.js`（见 §3）。
3. **panel 可见的"身份表损坏"状态**未接线（见 §4，需 `mindserver.js`）。
4. **agent 侧核销/面板签发未切到原子原语**（见 §7，需 `commands/identity.js` / `mindserver.js`）。
5. **`landmarks.js` 的本地档案回填**仍在（冗余兜底，见 §1）。
6. **`finish` 的 next 状态仍按读快照计算**（写被条件挡住，但语义上仍有极端交错，见 §5）。
7. 多进程并发写板库、真机跨 bot 可见性：仍只在单测/假件级别（ADR §10.3 同一空白）。

## 10. 本轮新增/扩充的测试清单

| 文件 | 新增/改动 | 用例数 |
|---|---|---|
| `tools/shared_chest_merge_unit.mjs` | 新增 ⑩（重启视角 category 不丢）、⑩-b（老实现反证） | 11 → 13 |
| `tools/board_add_guard_unit.mjs` | 新文件（#20 + #67 正/反例、client 侧日志） | 22 |
| `tools/board_transition_guard_unit.mjs` | 新文件（#22，真子进程并发 finish） | 5 |
| `tools/board_registry_unit.mjs` | 新文件（#24 上限/清理/rolesSource） | 5 |
| `tools/identity_corrupt_unit.mjs` | 新文件（#69 留证/告警/不覆盖证据） | 4 |
| `tools/identity_claim_race_unit.mjs` | 新文件（#21 4 进程并发核销） | 4 |

`tools/*_unit.mjs` 会被 `tools/unit_all.mjs` **自动收录**（无需登记），已实跑 `unit_all board` 26/26、
`unit_all identity` 5/5。
