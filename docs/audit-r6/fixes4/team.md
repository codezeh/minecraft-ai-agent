# 队伍（team / team_member / team_chest）：表、服务端校验、边界

> R6 / fixes4 · ADR-0001 阶段 3 · D6（存档维度）/ D13（只有队伍专属箱子）· 2026-11-12
> 交付：`src/agent/library/board_store.js`（三张表 + 幂等迁移 + 队伍读写）、
> `src/agent/library/board_server.js`（`team:*` 六个事件 + 服务端校验）、
> `src/agent/library/board_client.js`（客户端方法 + 无板降级）、
> `tools/team_store_unit.mjs`、`tools/team_wg_crosscheck.mjs`（+ 其单测）。

## 0. 一句话结论

队伍三张表**已落地**，六个 `team:*` 事件**全部在服务端校验身份与归属**；
但三条边界必须一起读，否则会把"能挡诚实客户端的手滑"误读成"做到了身份隔离"：

1. **`online-mode=false` 下，本校验不能防冒名** —— 白名单 16/16 都是离线 v3 UUID，
   名字由客户端自报、UUID 由名字派生 ⇒ 任何人用成员名字登录就"成为"该成员。
   本文件的校验只挡**诚实客户端的手误**（发错字段、替别人操作、漏了队长限制）。
2. **`world_id` 不在这里解析** —— 库路径 → 存档 id 的唯一实现在 `world_store.js`（t2，
   `worldIdOfBoardDb`）。解析不出来时队伍操作**一律拒绝**（`NO_BOARD`），**绝不退化**
   成"单库单世界"：旧位置 `bots/_board/` 的库、内存库都会被拒（用例 ⑫ 就是这条）。
3. **D12（组队需双方同意）尚未闭合** —— 当前 `team:join` 是自助加入，没有邀请/同意流程。

## 1. 三张表与迁移

```sql
team(id PK, world_id, name, created_by, created_at, UNIQUE(world_id, name))
team_member(team_id, avatar_id, role, joined_at, PK(team_id, avatar_id))
    + UNIQUE INDEX uq_team_member_avatar(avatar_id)      -- 一 avatar 只在一个队
team_chest(world_id, team_id, x, y, z, added_by, added_at, PK(world_id, team_id, x, y, z))
```

- **schema 3 → 4**（`BOARD_SCHEMA_VERSION = 4`）：三张表都是 `CREATE TABLE IF NOT EXISTS`，
  老库里一行都没有 ⇒ 迁移**无回填、无丢数据**。
- `openBoard` 现在**无条件**写一次 `user_version`。**这一句不是冗余，不要"优化"掉** —— 理由见 §1.1。

### 1.1 为什么 `user_version` 必须**无条件**写（谁删谁负责把 ⑤ 修回来）

`openBoard` 的 `tryOpen()` 末尾现在是这一句，**没有 if**：

```js
db.exec(`PRAGMA user_version = ${BOARD_SCHEMA_VERSION}`);
```

它同时干两件不可替代的事，缺一条就有一个真问题：

1. **全新库也要落版本**。`migrateBoardSchema()` 在"没有 jobs 表"时是 early-return（老库才需要"补列"），
   所以**它不会给新库写版本**；唯一会写的就是 `openBoard` 这一句。删掉它 ⇒ 新装的库
   `user_version` 永远停在 0，t8 的版本体检（`tools/board_user_version_check.mjs`）会一直
   报 `user_version 0 < 期望 4` —— 那是**假信号**，会让人去查一个不存在的故障。
2. **它是"库可写"的探针**。本库跑在 WAL 下，**读者不会被写者阻塞**，所以"能读"证明不了"能写"。
   而 `openBoard` 里其余语句在"结构已是最新"时**一次写都不做**（`CREATE TABLE IF NOT EXISTS`
   全是 no-op、`migrateBoardSchema` 也提前返回）。于是如果这一句被删/被改成"不一致才写"，
   当另一个进程持 `BEGIN EXCLUSIVE` 锁时，`openBoard` 会**成功返回**一个能读、写不进去的句柄 ——
   问题从"启动时报错"被推迟到"夜里第一次下单才炸"，现场只剩一句 `database is locked`。

**删掉会怎样（实测，不是推理）**：把这一句改成"版本不一致才写"（我第一版就是），
`tools/board_open_migrate_unit.mjs` 的 **⑤ 立刻变红**：

```
FAIL ⑤ 锁忙被当成了坏库（第3条回归：好库会被删）
     {"err":"(没有抛错)","stillThere":true,"bytesBefore":4096,"bytesAfter":4096,"backups":[],"dataIntact":true,"waited":1}
```

复核席按原样重跑过一次：`waited≈5533ms`（`busy_timeout=5000` 等满后由 SQLite 自己抛
`database is locked`），说明那条红是**真的锁等出来的**，不是被绕过去的。
`⑤` 保护的是报告第 3 条："读不到 ≠ 库坏了" —— 而它能生效，恰好依赖"打开时必有一次写"。

代价：每次 `openBoard` 多一条 `PRAGMA`（常量写入），可忽略。
**结论：这一句要无条件，别加 `if`、别"顺手"删。**


- `team_chest` 的 PK 里带 `world_id`：同一个坐标在不同存档是**不同的箱子**，
  跨存档"撞坐标"不该被当成重复登记。
- `team_member` 的唯一索引是"一 avatar 只在一个队"的**唯一落点**。为什么不靠"先查后写"：
  两次查询之间另一个连接可以插进来，然后两个队都认为自己有他。返回值也据此区分：
  已在队里 ⇒ `OCCUPIED`，重名队 ⇒ `CLAIM_CONFLICT`（两者处置不同：换队 vs 换名）。

## 2. 六个事件与服务端校验矩阵

| 事件 | 谁能做 | 校验（全部在服务端） | 失败码 |
|---|---|---|---|
| `team:create` | 任何已握手的分身 | 队名归一化/限长；同一 avatar 已有队 ⇒ 拒；同存档重名 ⇒ 拒 | `NO_TARGET`/`TOO_MUCH`/`OCCUPIED`/`CLAIM_CONFLICT`/`NO_BOARD`/`NO_PERMISSION` |
| `team:join` | 任何已握手的分身 | 队伍必须存在**且属于本存档**；已有队 ⇒ 拒；重复加入 ⇒ 幂等成功 | `NO_TARGET`/`OCCUPIED`/`NO_BOARD` |
| `team:leave` | 队员本人 | 不在队里 ⇒ 拒；队长离队转交最早入队者；最后一人离队 ⇒ 队解散 + 清共享仓坐标 | `NO_TARGET`/`NO_PERMISSION` |
| `team:list` | 任何人（只读） | 只列**本存档**的队 | `NO_BOARD` |
| `team:chest-add` | **只有队长** | 必须是本队队长；坐标必须是三个整数；同坐标 ⇒ 拒；不能替别的队登记 | `NO_PERMISSION`/`NO_TARGET`/`OCCUPIED`/`NO_BOARD` |
| `team:chest-list` | 本队成员 | 不带 teamId 看自己队；带别人的 teamId 且自己不是队员 ⇒ 拒 | `NO_PERMISSION`/`NO_TARGET`/`NO_BOARD` |

**avatar 从哪来（这是"不许客户端自称"的落点）**：一律取 `board_server.js` 的
`actingBot(socket, payload)` —— agent 连接的名字来自 `socket.data.agentName`（由
`login-agent` / `connect-agent-process` 写入，经 `claimAgentChannel` 的唯一占用裁决），
并与 `board:hello` 的绑定对账。**绝不读 `payload.avatar`**。
`team_store_unit` ⑧ 就是拿 `payload.avatar = beta` 去撞 `agentName = alpha` 的连接：
队伍必须落在 alpha 名下、beta 名下必须没有队。这条用例能红（把 `teamActor` 换成读
`payload.avatar` 立刻失败）。

**错误码口径**：只产出 `contract.js` 里**已注册**的码（`NO_TARGET` / `TOO_MUCH` /
`OCCUPIED` / `CLAIM_CONFLICT` / `NO_PERMISSION` / `NO_BOARD` / `INTERNAL`）。
不新造码的理由：`contract.js` 正被 t1 修改，且未注册码会让 `fail()` 抛异常、启动自检判红
（本仓踩过一次）。具体原因写进 `reason`。

## 3. `team_chest` 与 WorldGuard 的逐格对齐

WorldGuard 只认**区域**（坐标范围），`team_chest` 只认**具体方块坐标**。两者不一致就是黑洞：
WG 放行但账本不记（东西进出没人知道），或账上记了但 WG 不让碰。

因此交付 `tools/team_wg_crosscheck.mjs`（**只读**：只读 `config/worldguard-regions.yml` +
只读打开板库，不改任何东西）。三种输出**必须可区分**：

| 输出 | 含义 | 退出码 |
|---|---|---|
| `SKIP` | 配置里还有 `__FILL_ME__` 之类占位符 / 解析不通 / 没有 cuboid 区域 / 板库还没这张表 ⇒ **配置未生效、无法校验** | 0 |
| `OK` | 每个 `team_chest` 坐标都被至少一个 cuboid 区域覆盖 | 0 |
| `FAIL` | 有坐标没被任何区域覆盖（逐条列出坐标、队伍、存档） | 1 |

**为什么 SKIP 也算一种"结论"**：区域草案目前 19 处占位符未填（`world` 都是 `__FILL_WORLD__`）。
这时候如果报 OK，就是最坏的一种假绿灯 —— 看着有保护，其实一个区域都没生效。
所以脚本在"配置不可用"时**连库都不读**，直接 SKIP 并在输出里写明"本脚本没有校验任何坐标"。

**能被红**：`tools/team_wg_crosscheck_unit.mjs` 的 ⑤-e2e 造一个区域外坐标 `(99,65,5)`，
断言脚本 `exit 1` 且输出点名该坐标；另有"存档不同不算被覆盖"的用例（跨存档是最容易
"看起来对"的一种错）。

**现状（如实）**：区域坐标未填 ⇒ 现在跑是 `SKIP`。**WorldGuard 本体也还没装**（见
`worldguard.md`）。所以"逐格对齐"目前是**工具就绪、配置未就绪**，不是"已经对齐了"。

## 4. 没做到的 / 依赖别人的（别当成已完成）

| # | 事项 | 现状 | 归属 |
|---|---|---|---|
| 1 | **`world_id` 的唯一来源** | **已接上**：`board_server` 每次队伍操作都从 `PRAGMA database_list` 取本库路径，交给 `world_store.worldIdOfBoardDb(path)` 反解。解析不出（旧位置 `bots/_board/`、内存库）⇒ 抛 → 翻成 `NO_BOARD` 拒绝。**没有任何兜底值** | t2（已完成） |
| 2 | D12 组队需双方同意 | **未做**：`team:join` 是自助加入，`team_invite` 表/流程都没有 | 待排（阶段 3 尾或阶段 4） |
| 3 | 退队时释放预占、按 ledger 结清（D13） | **未做**：库存账本（`inventory_reservation`/`inventory_ledger`）归 t4；现在离队只清座位与共享仓坐标，箱子里实物留在原地不动（这条是对的） | t4（fix-inv） |
| 4 | 共享仓内容进账本 | `team_chest` 只是"哪些坐标算共享仓"的清单，**不是账本**；真正的取用/结算在 t4 | t4 |
| 5 | 队伍操作审计进 `events` | **未做**：`events` 表在阶段"记忆结构化"里（t5）；现在被拒/成功只回 ack + `reason` | t5（fix-fed） |
| 6 | 面板可视化（谁在哪个队、共享仓清单） | **未做**（`web/**` 不在本条写作用域） | 另排 |

## 5. 证据（怎么复跑）

```bash
cd mindcraft
node tools/team_store_unit.mjs            # 12 pass / 0 fail：建队/重名/加入/离队/唯一队伍/权限/无存档维度/socket 身份/真接线（⑪⑫）
node tools/team_wg_crosscheck_unit.mjs    # 8 pass / 0 fail：含"区域外坐标必须 FAIL + exit 1"
node tools/team_wg_crosscheck.mjs         # 当前输出 SKIP（19 处占位符未填），exit 0
node tools/board_store_unit.mjs           # 无回归
node tools/board_b3_unit.mjs              # 无回归
node tools/board_b4_unit.mjs              # 无回归
node tools/board_iface_unit.mjs           # 无回归
node tools/board_open_migrate_unit.mjs    # 无回归（⑤ 锁忙必须抛，见 §1）
npm run gate                              # 0
```

**测试能红的证明方式**（做过两次，别只信"全绿"）：把 `addTeamChest` 里的
`if (held.role !== TEAM_ROLE.LEADER)` 临时改成 `if (false)`，`team_store_unit` 立刻
`11 pass / 1 fail`（⑥ 队员登记被拒那条；exit=1）；改回后 `12 pass / 0 fail`（exit=0）。
