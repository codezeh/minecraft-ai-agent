# 记忆结构化：`_global` events（追加写）+ relations（D8 · ADR 记忆层）

> R6 / fixes4 · 2026-11-12 · 任务 **t5**
> 代码：`mindcraft/src/mindcraft/global_store.js`（**唯一真相**，新模块）
> 单测：`mindcraft/tools/global_store_unit.mjs`（112 例，含 4 进程真并发）
> 上游：`docs/adr/ADR-0001-联邦身份与本地状态所有权.md`（记忆层 D8）、`docs/audit-r6/architecture-gaps.md` §12 DDL 草案
> 关联：`docs/audit-r6/fixes4/identity.md`（阶段 2 的人/恢复码）、`world.md`（阶段 3 的 `world_id`）

---

## 0. 一句话

**跨存档、跨 bot 的记忆只有两样东西**：`events`（发生过什么，**只能追加**）和 `relations`（谁跟谁怎么样，可更新）。
两者都住在 `<bots>/_global/mind.sqlite`，与存档无关；`events` 的"追加写"不是靠约定，而是**库层触发器**（连误操作也改不了历史）。

---

## 1. 文件与路径（实测字符串）

```
E:/我的世界ai/mindcraft/bots/_global                                  ← globalDirOf()
E:\我的世界ai\mindcraft\bots\_global\mind.sqlite                      ← globalDbPathOf()
```

* `MC_BOTS_ROOT` 覆盖语义不变（`bot_paths.botsRootOf()` 是唯一取值处）：测试用 `mkdtempSync` 指过去，**各进程各自一库**。
* 生产 `bots/_global/` 在本次任务里**没有被创建**（模块只在第一次真正需要读写时才建目录/建库）—— 实测 `ls bots/_global` = `No such file or directory`。
* 为什么不放在 `_worlds/<world_id>/`：events/relations 是**记忆层**（人、关系、跨存档历史），换存档不该忘掉谁是谁；按存档重置的是队伍/任务板/库存（阶段 3 已落 `_worlds/<id>/_board/`）。

---

## 2. 表结构（`PRAGMA user_version = 1`，实数导出的 DDL）

```sql
-- 实测：sqlite_master 原样导出
CREATE TABLE events (
    id TEXT PRIMARY KEY,
    world_id TEXT,
    avatar_id TEXT,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    at INTEGER NOT NULL,
    source_ip TEXT
);
CREATE INDEX idx_events_at        ON events(at, id);
CREATE INDEX idx_events_kind_at   ON events(kind, at);
CREATE INDEX idx_events_world_at  ON events(world_id, at);

CREATE TABLE relations (
    from_avatar TEXT NOT NULL,
    to_avatar   TEXT NOT NULL,
    affinity    INTEGER NOT NULL DEFAULT 0,
    tags_json   TEXT NOT NULL DEFAULT '[]',
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (from_avatar, to_avatar)
);
CREATE INDEX idx_relations_to ON relations(to_avatar);
```

几个**有意为之**的取舍：

| 取舍 | 为什么 |
|---|---|
| `events.id` 是 **TEXT**，不是自增整数 | 联邦（阶段 4）会把远端事件搬进来，甚至 CoreProtect 导出的块记录也要能重复导入。本地自增 id 在"重放/合并"时必然撞车；TEXT id 由**产生方**给出，重复导入靠 `INSERT OR IGNORE` 吃掉（`duplicate-id`，不重复落库、不报错）。本地生成形如 `ev-<base36 ms>-<8 hex>`。 |
| `at` 是**毫秒整数**，由调用方给或默认 `Date.now()` | 事件时间是**业务事实**（可回填历史、可跨机比较），不能靠插入顺序推。排序键是 `(at, id)` —— 同一毫秒多条也**全序**。 |
| `world_id` **可空** | 空 = 跨存档事件（人、邀请、恢复码、联邦名片）。非空时必须是 `world_store.isValidWorldId()` 认的形状（挡 `../etc`）。 |
| `kind` 上**没有** DB `CHECK` | kind 白名单只有**一份**（JS 常量 `EVENT_KINDS`）。DB 里再写一遍 CHECK 就是第二份真相：加一个 kind 要改两处，迟早漂移。 |
| `relations` 用 `(from_avatar,to_avatar)` 做主键 | 关系是**有向**的（a 对 b 的信任 ≠ b 对 a 的信任），且同一对只该有一行。ADR 草案里的 `relation(from_person,to_person,kind)` 是"人×关系类型"三键；本阶段按任务口径落 `avatar` 维度（人 → 分身的多对一映射在 `people_store`，接人维度时只加一列，不改主键语义）。 |
| `tags_json` 存 JSON 数组 | 标签是检索用的粗粒度标记（`friend`/`debt`/`met`），不是自由文本；JSON 数组比逗号拼接好解析、好去重。 |

---

## 3. 追加写：三层护栏（缺一层都只是"约定"）

| 层 | 具体做法 | 单测 |
|---|---|---|
| ① 导出面 | 模块**没有**任何 `updateEvent/deleteEvent/removeEvent/purge...` 导出；唯一写入口是 `recordEvent(kind, payload, ctx)` | 扫 `Object.keys(mod)` |
| ② 源码 | 去注释后 `INSERT ... INTO events` **恰好 1 处**；`UPDATE events` / `DELETE FROM events` **0 处** | 直接扫源码文本（含"注释骗人"防护） |
| ③ 库层 | 两个触发器 `events_no_update` / `events_no_delete`，`RAISE(ABORT, ...)` | 用原始 `db.exec()` 强改/强删，必须抛 |

实测（单测原样）：

```
PASS  库层 UPDATE events 被触发器拒绝
PASS  库层 DELETE FROM events 被触发器拒绝
PASS  两次破坏尝试之后事件内容一字未变
```

**为什么第③层必须有**：前两层挡的是"我们自己写错代码"，挡不住"以后某个排障脚本顺手 `DELETE FROM events WHERE at < ...`"。
历史改不了，才叫审计；能改的历史等于没有。代价是**也不做 retention/compact**（见 §12）。

**"能红"实测**：把 `db.exec(APPEND_ONLY_TRIGGERS)` 那一行注释掉 → 4 条用例红、退出码 1；恢复后 112/112 绿（模块 sha256 回到 `ff0beae4…`）。

---

## 4. kind 白名单（封闭集合）

25 个 kind，全部在 `EVENT_KINDS`（`Object.freeze`）：

```
identity.claim / identity.invite / identity.revoke / identity.recover / identity.relink / avatar.retire
team.create / team.join / team.leave / team.disband
inventory.reserve / inventory.settle / inventory.reconcile / inventory.rollback
world.migrate / world.reset
federation.visit / federation.depart / federation.card
block.break / block.place
chat.say / chat.receive
player.join / player.quit
```

规则：

1. **白名单 + 语法**双重校验：`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$`，再要求 ∈ `EVENT_KINDS`。
2. 未注册 kind → `{ok:false, reason:'kind-not-allowed'}`，**一条不落库**，并 `console.warn`（按 `kind+reason` 去重，不刷屏）。
3. 新增 kind = **改常量 + 改文档**，没有"调用方自己起个名字"的路径。事件名一旦落库就永久可查，改名等于让历史分叉。

**为什么白名单要严格**：事件表是**复盘/审计的索引**。放任自由 kind 的后果是同一个业务动作出现 `chat.say` / `chat_send` / `say.chat` 三种写法，按 kind 统计永远对不上（本仓历史上 mode 列表三套、垫脚块四处的病根就是这个）。

**"能红"实测（这条一开始没红，是个真教训）**：第一版用例只喂了 `nope.not-a-kind`（**语法就非法**），把白名单校验去掉只留正则，测试**照样全绿** —— 因为它被正则拦住了。
补了 `identity.hacked`（**语法完全合法、没登记**）之后：去掉白名单 → 2 条红、退出码 1；恢复后绿。
> 教训通用化：**"被拒"不等于"被这条规则拒"**。反例必须唯一命中被测判据，否则测的是隔壁那条规则。

---

## 5. payload：JSON + 字节上限 + 永不拖垮调用方

| 情况 | 结果 |
|---|---|
| `payload === undefined` | 写成 `{}` |
| `payload === null` | 写成 `null`（读回 `payload:null, payloadOk:true`） |
| 循环引用 / `BigInt` | `payload-not-serializable`（`JSON.stringify` 抛错，不落库） |
| JSON 字节数 > `MAX_EVENT_PAYLOAD_BYTES` (8192) | `payload-too-large` + `bytes`（**按 UTF-8 字节**，不是字符数：3000 个汉字 = 9000 字节被拒） |
| 恰好 8192 字节 | **允许**（边界用例钉死） |
| 库打不开 / 磁盘满 / 被锁 | `{ok:false, reason:'write-failed', detail}` + **`console.error`**，**绝不抛出** |

为什么"写失败不能拖垮调用方"：事件是**旁路记录**，不是业务事务的一部分。抢单/结算/入队因为"日志写不进去"而失败，是把最不值钱的东西放在了最值钱的位置上。
但**必须**打日志：静默吞掉会得到"看起来记了、实际没记"的假象（本仓母题）。

读的一侧相反：`sinceEvents` 的**参数**非法是程序员错误，**直接抛**（`SINCE_INVALID` / `KIND_INVALID`），不做"猜你想查什么"。

---

## 6. 查询口径

```js
sinceEvents(since, { worldId, kind, limit })   // at 升序、同 at 按 id 升序
```

`since` 有两种，语义**故意不同**：

| 形状 | SQL | 语义 | 什么时候用 |
|---|---|---|---|
| `number`（毫秒） | `at >= ?` | **宁重不漏**（含边界） | 面板"给我最近 N 分钟"，重复由面板去重 |
| `{at, id}` | `(at > ? OR (at = ? AND id > ?))` | **严格大于**，同一毫秒也不重不漏 | 增量同步/联邦回放（游标） |

* `limit` 默认 200、上限 2000（`MAX_EVENT_LIMIT`）；非法值退默认。
* 返回行形状：`{id, worldId, avatarId, kind, payload, payloadOk, at, sourceIp}`。`payload_json` 解析失败时 `payload:null, payloadOk:false` —— **不抛、也不装作是 `null`**。
* `statsByKind({worldId})` → `[{kind, count, firstAt, lastAt}]`（面板/复盘排序用）；`countEvents({worldId, kind})` 供对账。
* 查询函数都支持 `{readOnly:true}`（用完即关的只读连接）或 `{db}`（调用方自己的句柄）。

---

## 7. relations：绝对写 vs 增量写

| 函数 | 语义 | SQL 关键点 |
|---|---|---|
| `setRelation(from, to, {affinity, tags})` | **绝对**：整行设成给定值（未给 `tags` → `[]`） | `INSERT ... ON CONFLICT DO UPDATE SET affinity=excluded.affinity, tags_json=excluded.tags_json` |
| `addRelationAffinity(from, to, delta, {tags})` | **增量**：`affinity += delta`；**没给 tags 就不动 tags** | `ON CONFLICT DO UPDATE SET affinity = relations.affinity + excluded.affinity, tags_json = COALESCE(?, relations.tags_json)` |
| `applyRelationDeltas(list)` | 联邦批量增量：**一个事务**内全部生效，坏条目跳过并报告 | `BEGIN IMMEDIATE` + 预处理校验，`ROLLBACK` 兜底 |
| `getRelation` / `listRelations({from,to,limit})` | 读（`list` 按 `|affinity|` 降序、再按 `updated_at` 降序） | — |

**为什么增量必须在 SQL 里做**：`SELECT affinity → JS 加 → UPDATE` 是读改写。两个 bot 同时 `+1` 会丢掉一次（本仓在任务板领单上已经栽过一次同类）。`affinity = affinity + ?` 是单语句原子操作，实测 4 进程 × 25 次并发 = `+100`，一条不丢。

校验（都返回 `{ok:false, reason}`，不落库）：
`from-avatar-invalid` / `to-avatar-invalid`（空、超 64、含控制字符）、`self-relation-refused`（`from===to`）、
`affinity-invalid`（非整数 / `|x|>1e6`）、`delta-invalid`（0 或非整数）、`tags-invalid`（非数组 / 单个 >48 字符 / >32 个）。
`tags` 去重**保序**（`['friend','ally','friend'] → ['friend','ally']`）。

relations 与 events **互不写入**：单测断言"改关系不增加事件条数"。

---

## 8. 并发与 WAL

* 打开写连接时 `PRAGMA journal_mode = WAL` + `busy_timeout = 5000`，并且**读回核对**（没生效就 `[global]` 告警 —— 静默降级比报错更难查）。
* 写句柄按**绝对路径**缓存（`openGlobalDb()` 幂等）；`closeGlobalDb()` 清空缓存（测试清临时目录前必须调，否则 Windows 上 `rmSync` 会 EPERM）。
* 实测并发（单测 ⑫）：

```
PASS  4 进程 × 50 条事件一条不丢            {"delta":200}
PASS  并发写入的 payload 都是完整 JSON       200+
PASS  4 进程 × 25 次增量 = +100（SQL 里累加，不丢更新）  {"relBefore":0,"relAfter":100}
```

> 注意：这不是"多进程都开写句柄乱写"的推荐形态，而是**证明它不会坏**。真正的写者仍是 mindserver 一个进程（见 §11 的接线清单）。

---

## 9. 版本护栏

`PRAGMA user_version` 与 `GLOBAL_SCHEMA_VERSION` 对齐；**库比代码新就拒绝打开**：

```
GLOBAL_SCHEMA_TOO_NEW: 全局库结构版本 99 比本代码（1）新：拒绝用旧代码写新库
```

旧代码写新库的典型后果是：新表/新列被当成不存在 → 插入走老路径 → 字段静默丢失。
单测还断言"改回版本号后能正常打开"——护栏不是永久锁死。

建表是**幂等**的：`CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS` + 无条件重写 `user_version`。
实测二次打开：`created=false`、`sqlite_master` 条目数不变、已有事件条数不变。

---

## 10. 只读通道

`openGlobalDb({readOnly:true})`：

* **不建目录、不建库、不建表**；库不存在 → `GLOBAL_DB_MISSING`（拒绝凭空建空库骗人）。
* 打开点就跑一次 `SELECT count(*) FROM sqlite_master`，把"坏文件"的报错提前（SQLite 只读打开是惰性的）。
* 只读句柄上 `INSERT/UPDATE/DELETE` 由 SQLite 直接拒（`SQLITE_READONLY`）。
* 查询函数传 `{readOnly:true}` 时**用完即关**，不会给进程留永不关闭的连接。

---

## 11. 接线清单（**本次没有改 `mindserver.js`**，按任务硬要求）

任务要求"不改 mindserver、不改 board_*"，所以下面只是**给 captain 的清单**，一行代码都没动：

| # | 位置（现状） | 建议接什么 | 为什么在这一层 |
|---|---|---|---|
| 1 | `src/mindcraft/mindserver.js` socket 层，`identity-*` 事件处理完之后 | `recordEvent('identity.claim'|'identity.invite'|'identity.revoke'|'identity.recover'|'identity.relink', {person, avatar, by}, {avatarId, sourceIp})` | 身份变更只在这里收口（t1 已把三条写入路径收到 `people_store`），事件必须同一个收口点写，否则又是一份"漏记"的真相 |
| 2 | `src/agent/library/board_server.js` 队伍事件（`team.*`） | `recordEvent('team.join'…, {teamId, avatarId}, {worldId: worldIdOf()})` | t3 的 world_id 已经注入到 board_server；队伍是**按存档**的，事件要带 world_id 才能按档复盘 |
| 3 | 库存结算/对账（t4 落点，`board_store` 的 reservation/ledger 收口） | `recordEvent('inventory.settle'…, {jobId, item, delta, chestKey}, {worldId})` | 结算事件是"账实对不上"时唯一的第三方证据 |
| 4 | 阶段 4 联邦访问（访客入场/离场/名片） | `recordEvent('federation.visit'|'federation.depart'|'federation.card', {peer, cardId}, {sourceIp})` | 串门是跨存档的，正好归 `_global` |
| 5 | CoreProtect 导入器（阶段 4，尚未写） | 走 `recordEvent('block.break'|'block.place', {...}, {worldId, avatarId})`，**必须传显式 `id`**（CP 的行号） | 重复导入同一段 CP 日志是常态；显式 id + `INSERT OR IGNORE` 让重复导入无副作用 |
| 6 | 面板（`web/**` 只读） | 用 `openGlobalDb({readOnly:true})` 或 `sinceEvents(0,{readOnly:true,limit})` | 面板绝不能拿到写能力 |

**接线时的两条硬约束**（写进清单，免得下一个人踩）：

1. `recordEvent` 的返回值**不要**参与业务判断（它是旁路）；`ok:false` 只影响日志。
2. 事件条数会**只增不减**，接线前先确认单条 payload 真的在 8 KiB 内（尤其 CoreProtect 的 NBT 片段）。

---

## 12. 明确没做的事（边界，别当成"已实现"）

* **不迁 `people.json`**：阶段 2 的人表还在 `bots/_identity/people.json`。搬到 `_global/mind.sqlite` 是**独立一步**（`identity.md` §7 已登记），本任务只建 events/relations 两张表，不动人表 —— 混在一起会让 t1 已经绿掉的 22+27+18+31 条用例全部悬空。
* **不做 retention / compact**：追加写的代价就是表会一直长。要清理必须**另行设计**（导出归档 → 删库重建 → 重放），不能在 `events` 上开 `DELETE` 的口子（那等于取消 §3 的保证）。
* **没有联邦签名/验签**：`source_ip` 只是记录，不是证据链；阶段 4 若要多节点互信，需要另加签名列（`sig` + 公钥来源），本阶段不猜。
* **面板未接**：没有任何 `web/**` 改动；事件统计要等接线（§11）之后才有数据。
* **CoreProtect 导入器未写**：只登记了 kind 与"显式 id 幂等导入"的口径。

---

## 13. 验证记录（可复跑）

```bash
node tools/global_store_unit.mjs     # 112 通过 / 0 失败，exit 0
npm run gate                         # 0（含 preflight / lint:hard；新增模块已申报）
```

单测覆盖（按小节）：① 路径形状 ② 幂等建表 ③ 追加写三层 ④ kind 白名单 ⑤ payload 边界 ⑥ sinceEvents 两种游标 ⑥b 参数校验 ⑦ 统计 ⑧ relations 绝对/增量 ⑨ 批量增量 ⑩ 写失败不拖垮调用方 ⑪ 只读 ⑫ 4 进程并发 ⑬ 版本护栏 ⑭ 清理。

**两处"能红"实测**（各破坏一次 → exit 1，恢复后 112/112 绿）：

| 破坏 | 红的用例 |
|---|---|
| 去掉 `db.exec(APPEND_ONLY_TRIGGERS)` | 建触发器 / UPDATE 被拒 / DELETE 被拒 / 内容未变（4 条） |
| 把 `eventKindAllowed(kind)` 换成"只做正则校验" | 语法合法但未注册 kind 被拒 / 未注册 kind 没落库（2 条） |

诚实记录：第二次的**初版用例不会红**（只喂了语法非法的 kind）——已按 §4 的教训补了 `identity.hacked` 才真的钉住白名单。
