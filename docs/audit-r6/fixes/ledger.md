# R6 #19 —— 两个箱子账本并存（合并成一份）

> 缺陷：R6 报告 #19。`flow_store.js:24-27` 的注释写着「B4 把这一路彻底删掉，不再有第二个真相」，
> 但 `!putInChest` / `!viewChest` / `verifyChest` / `findItemInStorage` / `tidyInventory`
> 仍然读写 `bots/<name>/memory/chests.json`（`skills.js:4447-4504 / 4535 / 5368-5410`、
> `landmarks.js:165-205`）。**于是 A 用 `!putInChest` 存的 64 个原木，B 用共享账本查不到。**
>
> 病根：B4 只把 `flow_store` 一路搬进了任务板，`landmarks.js` 那一路没搬 —— 同一件事两个写者、
> 两种数据形状（数组 vs map）、两份互不可见的真相。**"改了一半"比"没改"更危险**：
> 注释宣称单真相，读代码的人（和模型）都会照着错的前提干活。

| 项 | 值 |
|---|---|
| 成员 | fix-ledger（t6） |
| 写作用域（本任务） | `mindcraft/src/agent/library/skills.js`、`landmarks.js`、`flow_store.js` |
| 实际改动文件 | 同上三个（`flow_store.js` 只改注释/说明，代码未动） |
| 基线 | 子仓 `mindcraft` @ 本批工作树 · Node v24.16.0 · 依赖 t2（任务板事务 #4/#5/#6）已合入 |
| 不动的部分 | `board_store.js` / `board_server.js` / `board_client.js` / `memory_store.js`（他人作用域，只读） |

---

## 0. 合并后谁是唯一真相（一句话声明）

> **任务板库（mindserver 侧唯一写库）的 `shared` 表、`kind='chest'` 命名空间，是箱子账本的唯一真相。**
>
> - 持久化落点只有一个：`shared(kind='chest', key='x,y,z', value={pos,items,category,note,lastUsed})`。
> - `bots/<name>/memory/chests.json` **不再是账本**：`landmarks.js` 既不读也不写它
>   （只剩"老版本 `landmarks.json` 升级时的一次性迁移源"角色，由 `memory_store.migrateFromLegacyLandmarks`
>   + `agent._migrateSharedOnce` 消费，两个文件都不在本任务写作用域内）。
> - 进程内 `CHEST_LEDGER`（`landmarks.js`）是**缓存**：丢了能从板库重建，从不被当作真相。
> - 两个写入口径**共用同一张表**，谁都不是"第二个账本"：
>   · `flow_store.rememberChest` 写**增量**（`board.sharedMerge`：存 +N / 取 -N，服务端一个事务里合并）；
>   · `landmarks.rememberChest / updateChestContents` 写**观测值**（打开箱子看到的真实内容）与档案字段
>     （`category` / `note`），走 `board.sharedPut`。

---

## 1. 选的方向：**commands 层全部改写共享账**（不是"把 shared 缓存降级为只读缓存"）

两个候选方向，任务要求二选一、不许两套都留。选前者，理由按"能不能真的消除第二个账本"来判：

| 方向 | 具体做法 | 判定 |
|---|---|---|
| **A（采纳）** commands 层全部改写共享账 | `landmarks.js` 的箱子域改成板库 `shared(kind='chest')` 的适配器；`memory/chests.json` 不读不写 | ✅ 写者从 2 个变 1 个（板库）；A 写的 B 立刻看得见；`!viewChest`/`findItemInStorage` 天然看到同一份真相 |
| B 把 shared 缓存降级为"只读缓存" | 板库只读，写仍回本地文件 | ❌ 那等于把**文件**当真相、板库当缓存 —— 每只 bot 仍各写各的文件，跨 bot 可见性不会自己出现；`flow_store` 那边反而要回退到 B4 之前。**问题原样保留**，只是换了个名字 |

另一个现实约束也指向 A：只有 mindserver 有写库权（06 §3 单写者），跨 bot 的原子更新只可能发生在那里；
`sharedMerge` 的"读-改-写在服务端一个事务里完成"正是 t2（#4）刚加固过的那条路径，本任务直接复用它的语义。

**B 里唯一值得保留的那半句，A 顺带就拿到了**：本地那份东西确实是"只读缓存"——
`CHEST_LEDGER` 只是板库的进程内投影（§2.2），写失败不会让它变成第二个真相（失败会记进
`chestLedgerErrors`，不再静默）。

### 1.1 为什么本地还留一层缓存（不是留恋第二个账本）

`protectedPlaces()`（被 `flow_collect_plan.js` 同步调用）和 `map_query` 的读端是**同步**函数，
socket 往返是异步的，同步函数没法 await。所以：

- **缓存**：`cachedChests(bot)` 同步返回快照，每次 miss 会顺手踢一次后台刷新；
- **权威读**：`refreshChests(bot)` / `loadChests(bot)`（async），异步读者一律先 await 它；
- **落库保证**：`flushChestWrites(bot)`（async），命令层用它做到"报成功之前已经进库"。

代价（已写进 §5 残留缺口）：进程刚起、还没人 await 过账本时，同步读者的箱子列表会暂时为空（≤60s 自愈）。

---

## 2. 改了什么

### 2.1 `landmarks.js`：箱子域从"自己写文件"改成"板库适配器"

新增/重写的一节见文件头 `箱子账本（R6 #19）`（`landmarks.js:41` 起）：

| 函数 | 改前 | 改后 |
|---|---|---|
| `loadLandmarks(bot).chests` | `readStore(bot,'chests')`（读文件） | `cachedChests(bot)`（**缓存快照**，注释写明"要权威答案 `await loadChests`"） |
| `rememberChest` | 读文件 → 改数组 → 写文件（同步） | 同步更新缓存 + 排一次板库 `sharedPut`（串行队列）；返回值仍是 boolean（调用方无需改） |
| `updateChestContents` | 没记录过的箱子直接 `return false`（丢掉观测） | 写板库；**没记录的箱子会被建档**（开到箱子看到内容本身就是一次真实观测） |
| `chestsByCategory` / `findItemInChests` / `knownChestsNearest` | 读文件 | 读缓存（同步），异步调用方先 `await refreshChests` |
| `forgetChest` | 从数组里删一条（本 bot 自己那份） | 写**墓碑** `{removed:true}`（全队都不再当它有用）；**且只在 `FORGET_RADIUS=64` 格内才抹** |
| `touchChest` | 改 `lastUsed` 并写文件（每次存取一次磁盘写） | 只改缓存 `lastUsed`（板库顺序本来就按 `updatedAt`，不值得为"碰一下"多写一行） |
| `saveLandmarks` | 三个域都写（含 `chests`） | 只写 `sites` / `storage`（**箱子不再落文件**） |
| 新增 `refreshChests` / `loadChests` / `cachedChests` / `flushChestWrites` / `chestLedgerErrors` | — | 权威读 / 权威读别名 / 同步快照 / 等落库 / 诊断（最近 20 条失败 + pending 数） |

几个关键实现点（都是踩过的坑，注释都留在代码里）：

1. **写前先刷新（`persistChest`）**：本文件写的是**绝对值**（"箱子现在有什么"）。拿一份过期快照整份覆盖，
   会把别人刚 `sharedMerge` 进来的增量抹掉。所以每次写之前先读一次板库，把窗口压到"一次往返以内"。
   （增量写走 `sharedMerge` 的地方天然安全，不需要这一步。）
2. **合并基底必须是纯板库快照（`st.boardRows`），不是本地视图**：
   `rememberChest` 会先乐观地写本地缓存（这样 `protectedPlaces` 之类的同步读者立刻能看到），
   于是本地视图里可能有"我刚按冷缓存拼出来的 `contents:{}`"。一开始拿视图当基底，结果把
   B 记的 64 个原木写成了 `{}` —— 反证用例 ⑦ 就是守这条的（见 §4）。
3. **"只登记位置"不许抹内容**：`!scanned` / `!placed_by_bot` 这类调用不传 `contents`，
   这时**不写 `items` 字段**（沿用板库那份），只有显式传入时才覆盖。
4. **档案字段只增不减**：`sharedMerge` 只写 `pos/items/owner/at`，会把 `category/note` 抹掉
   （见 §5 残留缺口 1）。刷新时若板库那份 `category/note` 为空而我这边知道，就补回来，
   免得一次增量入库把"分类箱子"变成 `unsorted`。
5. **墓碑只在实测半径内**：`bot.blockAt()` 对**没加载的区块**同样返回 `null`。以前
   `knownChestsNearest` 遍历所有记录的箱子、远的那几个必然 `null` → 被当"箱子没了"删记录。
   各删各的看不见，现在账本是共享的 —— **误删就是全队的记录一起没**。所以超出 64 格时
   `forgetChest` 只返回 `false`，不动账本。

### 2.2 无板降级：只留内存，不写文件，且失败可见

- 没有任务板（mindserver 没连上）→ 只更新内存缓存，**绝不回落写文件**（与 `flow_store` 同一立场：
  "宁可少一条记忆，也不要再长出第二份文件"）；首次发生 `console.warn` 一次；
- 每一次失败（`NO_BOARD` / 板库返回的码 / 抛异常）都进 `chestLedgerErrors(bot)`，
  不再 `catch {}` 静默。诊断口：
  ```js
  landmarks.chestLedgerErrors(bot)  // { errors:[{at,code,key,message}], hydrated, pendingWrites }
  ```
- 错误码只用 `contract.CODES` 里已注册的（`NO_BOARD` / `NO_TARGET` / `INTERNAL`），
  细节进 `message` —— 否则 `npm run gate` 的错误码审计会红（本批踩过一次：自造的 `PUT_THREW`）。

### 2.3 `skills.js`：命令层接线（读共享账、写共享账、报成功前落库）

改的都是"箱子"这一条链，用户可见输出（`log` 文案、返回值形状）**一行未改**：

| 命令/函数 | 接线 | 效果 |
|---|---|---|
| `openKnownChest`（`putInChest`/`takeFromChest`/`viewChest` 共用） | 读前 `await refreshChests` | 别的 bot 记的箱子也算"已知箱子" |
| `!putInChest` | 存完 `updateChestContents(真实容器内容)` + `flush` | **本条缺陷的正面修复**：A 存的 64 原木进了共享账本，B 立刻查得到 |
| `takeFromChest` | 取完记真实余量 + `flush` | 取走之后别的 bot 不会还看到旧数量 |
| `!viewChest` | 看一眼就把真实内容记下来 + `flush` | "看一眼"本身就是观测，顺手把账本修正（可见输出不变） |
| `stashUnneeded` | 存完记真实内容 + `flush` | 腾背包也会入账（以前只 `touchChest`） |
| `ensureChest`（`prepareForBuilding` 用） | 读前 refresh；扫描/放置后 flush | 复用在别人建的箱子上 |
| `reportStatus` | 读前 refresh | "已知箱子"是全队的 |
| `listKnownSites` | 改 async + refresh | ★ **签名变化**：`sync → async`（返回值形状不变） |
| `storeItem`（`tidyInventory` 的基础） | 读前 refresh；写完 flush | 分类箱子跨 bot 共用 |
| `findItemInStorage` | 读前 refresh | ★ 本条验收点：A 存的，B 查得到 |
| `listStorage` | 读前 refresh | 仓库布局是全队的 |
| `planMaterials` | 读前 refresh | "仓库里有没有"按共享账本算 |
| `fillRoomWithChests` | 读前 refresh；摆完 flush | 不重复建同一分类箱子 |
| `verifyChest` | 读前 refresh；核对结果 flush | 核对修正的是全队的账 |

### 2.4 `flow_store.js`：只改说明（代码一行未动）

它的写路径本来就是对的（`sharedMerge` 增量，t2 的 #4 已保证"抢不到锁就失败"）。
本任务把它文件头那段"B4 删掉第二真相"的注释**补全成事实**：当时只搬了一半，
`landmarks.js` 那一路仍在写文件；现在两边共用 `shared(kind='chest')`，并写明两个写入口径的分工。

---

## 3. 行为差异（对用户/上游可见的部分，逐条列出）

1. `!putInChest` / `!viewChest` / `storeItem` / `verifyChest` 之后，**别的 bot 立刻查得到**（这是要修的）。
2. `skills.listKnownSites(bot)` 由同步变 **async**（列表内容不变）。全仓唯一调用者是模型生成的代码，
   文档示例已改成 `await skills.listKnownSites(bot)`。
3. `verifyChest` / `storeItem` 会给"以前没记录过、但这次真的打开了"的箱子建档（以前这类观测被丢掉）。
4. `forgetChest` 离得远（>64 格）时不再删记录（返回 `false`），近处才写墓碑。
5. 无板运行时：箱子记忆不再落盘（重启即丢），且首次会 warn 一次。

---

## 4. 验证（全部实跑）

| 命令 | 结果 | 说明 |
|---|---|---|
| `node tools/shared_chest_merge_unit.mjs` | **11/11** | 增量合并 / 老做法失败反证 / 接线守卫（接线守卫要求 `flow_store` 仍只有 `sharedMerge`、没有 `sharedPut`/`sharedGet`、没有 fs 读写 —— 本任务没破坏） |
| `node tools/container_fix_unit.mjs` | **5/5** | 容器口径（未受影响，回归确认） |
| `node tools/board_b4_unit.mjs` | **11/11** | 含"单一真相（源码级）：`flow_store` 没有 fs/chests.json"、迁移幂等、e2e 共享可见 |
| `node tools/atom_classify_unit.mjs` | **6/6** | `rememberChest` 同步可见 + `protectedPlaces` 形状/按 bot 隔离（证明缓存层没把同步读者打断） |
| `node tools/skills_fakesuccess_unit.mjs` | **9/9** | `storeItem` 仍能按分类找到"刚 rememberChest 的箱子"、S40 记账口径不变 |
| `node tools/bot004_migration_unit.mjs` | **11/11** | 旧文件→板库的一次性迁移仍工作、无板时静默跳过 |
| `node tools/unit_all.mjs` | **134/134 通过，5 跳过** | 全量离线单测（跳过的是要真机/测试服的） |
| `npm run gate` | **exit 0**，错误码审计 35 码全注册、启动自检通过、`lint_hard` 0/0 | 见下 |
| `node tmp/t6_ledger_proof.mjs`（**临时脚本，tmp/ 已 gitignore，不提交**） | **7/7** | 见下：正证 + 反证 |

### 4.1 `tmp/t6_ledger_proof.mjs` 逐条（真 server + 真 sqlite + 真 BoardClient）

| 用例 | 证明什么 |
|---|---|
| ① 源码级 | `landmarks.js` 代码里没有 `readStore/writeStore(bot,'chests')`、没有 `storeFileFor(bot,'chests')`、没有拼 `chests.json` 路径，且有 `sharedPut(` —— 文件**不再是账本** |
| ★② **正证** | A（命令层口径）记 64 原木 → **B（另一只 bot）`findItemInChests` 查到 64**；板库 `getShared('chest','3,64,7')` 里 `items.oak_log=64`、`category='wood'` —— **这正是 #19 的原症状，现在好了** |
| ★③ 共存 | B 用 `sharedMerge` 增量 +3 石头，A 再写一次观测值：**合并没丢、category 没被抹**（两个写入口径共用一张表） |
| ④ 档案兜底 | 纯 merge 之后板库 `category` 确实变 `null`；A 刷新后按"档案只增不减"补回 `wood`（`chestsByCategory('wood')` 仍能命中） |
| ★⑤ 误删边界 | 远处（900,900）`forgetChest` → `false` 且板库无墓碑；近处 → 写 `removed:true`，B 刷新后**看不到** |
| ⑥ 无板 | 写入只留内存、`chestLedgerErrors` 记 `NO_BOARD`（不再静默）、文件一个字没写 |
| ★⑦ 冷缓存不抹内容 | 一个从没读过账本的 bot 只"登记位置"（`rememberChest` 不带 contents）→ 板库里别人记的 `items`/`category` **原样保留**（这条一开始是红的，见 §2.1 第 2 点） |

> `npm run gate` 关键行：`✓ 错误码审计通过（扫到 35 个码，均已注册；CODES 共 41 个）`、
> `✓ 全绿：37 通过，0 失败`、`启动自检通过（含函数体冒烟测试）`。

---

## 5. 残留缺口（如实列出，不假装修完了）

1. **`mergeSharedChest` 会抹掉档案字段**（`board_store.js:2434-2439` 只写 `pos/items/owner/at`）。
   本进程用"档案只增不减"兜住，但**重启后的新进程**对"只被 merge 过、命令层没观测过"的箱子会丢
   `category`。根治要改 `board_store.mergeSharedChest`（保留未知字段）—— **不在本任务写作用域**，
   建议下一批连同"队伍共享库存（预占/领用）"一起做。
2. **绝对值写入 vs 增量合并的固有竞争**：两个 bot 同时"观测写"仍是 last-writer-wins
   （写前刷新把窗口压到一次往返）。真正的账本语义（真实箱子为准 + 账本记预占/领用）属 ADR-0001 D7，
   不在本批。
3. **同步读者冷启动**：`protectedPlaces()` / `map_query` 是同步的，进程刚起、账本还没 hydrate 时
   看不到箱子（≤60s 自愈，首次调用会踢后台刷新）。要彻底消除得把这两个读者也改成 async。
4. **墓碑只增不减**：`board:shared-del` 对 agent 有 owner 限制（R6 #3），所以"忘掉箱子"只能写墓碑，
   库里的行不会被删 —— 长期运行需要在维护任务里清理（或给面板一个管理口）。
5. **`FORGET_RADIUS=64` 是启发式**：64 格内 `blockAt` 为 null 就当箱子没了。若区块恰好在 64 格内
   但没加载（视距很小），仍会误写墓碑。更稳的判据是"区块已加载且方块为空气"。
6. **无板运行 = 箱子记忆不持久**（有意取舍，与 `flow_store` 一致）。单机无 mindserver 的用法会丢记忆，
   换来的是"不再有第二个账本"。
7. **站点 / 仓库区仍在文件里**（`sites.json` / `storage.json`）。它们在板库另有 `landmark` 命名空间
   （`agent._migrateSharedOnce` 负责搬），但命令层还没改成写共享账 —— **不属 #19（箱子账本）范围**，
   留给"队伍共享库存"那一批一起收。
8. **每次开箱前多一次 `sharedList` 往返**（`refreshChests`）。箱子操作本身要开窗走位，这点开销可忽略；
   若以后变成热路径，可加 TTL（`st.at` 字段已经留好）。
