# 存档维度 `world_id`：sidecar + `_worlds` 分层 + 幂等迁移（D6 · 阶段 3 地基）

> R6 / fixes4 · 2026-11-12 · 任务 **t2**（ADR-0001 阶段 3 的第一块地基）
> 代码：`mindcraft/src/mindcraft/world_store.js`（**唯一真相**）、`mindcraft/src/agent/library/bot_paths.js`
> 的 `boardDirForWorld()`、`mindcraft/src/mindcraft/mindserver.js` 一行接线。
> 运维：`mindcraft/tools/world_migrate.mjs`。单测：`mindcraft/tools/world_store_unit.mjs`（71 例）。
> 上游：`docs/adr/ADR-0001-联邦身份与本地状态所有权.md` §D6。

---

## 0. 一句话

`world_id` **不是配置项，是世界目录里的一个 sidecar 文件**。板库从"全服一个库"变成"一档一个库"：
`bots/_worlds/<world_id>/_board/board.sqlite`。旧库在**首次启动时幂等搬过去**（先备份 → 搬家 → 旧位置留
`MIGRATED-TO.txt`），跑几次结果都一样。

---

## 1. 最终目录形状（**实测字符串**，不是模板）

本机实测（`node -e "…bot_paths.js…"` 与单测输出的原样拷贝）：

```
E:/我的世界ai/mindcraft/bots/                                              ← botsRootOf()  锚在包根，不随 cwd
E:/我的世界ai/mindcraft/bots/_worlds/                                      ← worldsRootOf()
E:/我的世界ai/mindcraft/bots/_worlds/w-20261112-1a2b3c4d/                  ← worldDataDirOf(id)
E:/我的世界ai/mindcraft/bots/_worlds/w-20261112-1a2b3c4d/_board/           ← boardDirForWorld(id)
E:/我的世界ai/mindcraft/bots/_worlds/w-20261112-1a2b3c4d/_board/board.sqlite
E:/我的世界ai/mindcraft/bots/_board/                                       ← 旧位置（迁移后只剩备份 + MIGRATED-TO.txt）

E:/我的世界ai/server/world/world-id.json                                   ← sidecar（世界目录里）
```

一次真实迁移后的临时目录（单测产物，原样）：

```
...\bots\_worlds\w-20261112-136a66f2\_board\board.sqlite
...\bots\_board\MIGRATED-TO.txt
...\bots\_board\board.sqlite.bak-20261112202738
```

| 函数 | 返回（实测） |
|---|---|
| `botsRootOf()` | `E:/我的世界ai/mindcraft/bots` |
| `worldsRootOf()` | `E:/我的世界ai/mindcraft/bots/_worlds` |
| `worldDataDirOf(id)` | `E:/我的世界ai/mindcraft/bots/_worlds/<id>` |
| `boardDirForWorld(id)` | `E:/我的世界ai/mindcraft/bots/_worlds/<id>/_board` |
| `boardDirOf()`（旧，**保留**） | `E:/我的世界ai/mindcraft/bots/_board` |
| `currentWorldDir()` | `MC_WORLD_DIR` → 否则 `<仓库>/server/world` = `E:\我的世界ai\server\world` |

### sidecar 长什么样（实测文件内容）

```json
{
  "schema": 1,
  "id": "w-20261112-136a66f2",
  "createdAt": "2026-11-12T12:27:38.551Z"
}
```

* id 形态：`w-<YYYYMMDD>-<8 位 hex>`；日期只为可读，**唯一性靠随机**。
* 合法 id：`/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`（顺带挡掉 `../` 路径穿越）。
* **删世界 = 新 id**（sidecar 随世界目录走；`server/world` 被备份时它也一起走）。
* 生产库当前**还没有** sidecar：`E:\我的世界ai\server\world\world-id.json` 不存在 —— 下次 mindserver
  启动时生成（见 §3/§5，本任务没有替生产做迁移）。

### 与 ADR §D6 草稿的写法差异（**别按 ADR 的旧写法写代码**）

ADR §D6 画的是 `_worlds/<world_id>/board.sqlite`；实际落点是
**`_worlds/<world_id>/_board/board.sqlite`**：

1. 复用 `board_store.openBoard(dir)` 的既有约定「**一个目录 + `board.sqlite`**」——`_board` 不是多余的
   一层，它让「库目录」这个概念在所有调用点保持同一个含义；
2. `tools/team_wg_crosscheck.mjs` 的自动找库已经是 `_worlds/<id>/_board/board.sqlite`，迁移后的现实
   与它一致；
3. `worldIdOfBoardDb()` **两种形状都认**（`_worlds/<id>/_board/x.sqlite` 与 `_worlds/<id>/x.sqlite`），
   所以将来真要改成 ADR 的写法，只有"写"的那一处要动，读的那一处不用。

---

## 2. 接口（**t3 队伍 / t4 库存只需要下面这几个**）

### 2.1 反解：`worldIdOfBoardDb(dbPath)` —— 唯一入口

```js
// 从 src/mindcraft/ 里用：
import { worldIdOfBoardDb } from './world_store.js';
// 从 src/agent/library/ 里用（t3 的 board_server.js 实际就是这么引的）：
import { worldIdOfBoardDb } from '../../mindcraft/world_store.js';

const worldId = worldIdOfBoardDb(board.path);   // board.path = openBoard(...).path
```

| 项 | 约定 |
|---|---|
| 入参 | 板库**文件**路径（`openBoard(...).path`，如 `…\_worlds\w-…\_board\board.sqlite`） |
| 成功 | 返回 `world_id` **字符串**（`'w-20261112-136a66f2'`） |
| 失败 | **抛 `Error`**，`e.code === 'WORLD_ID_UNRESOLVABLE'`，`e.message` 里带原因与处理建议 |
| 绝不 | 返回 `null` / `undefined` / `''` / `'default'` / 猜测值 —— **不存在"兜底到单库单世界"这条路** |

不抛的体检版（诊断工具/单测用）：`tryWorldIdOfBoardDb(dbPath)` → `{ok:true, worldId}` 或
`{ok:false, worldId:null, reason}`。

**被拒的路径形态（全都有单测）**：旧位置 `bots/_board/board.sqlite`、随便一个目录、空串、
只到 `_worlds/<id>`（没指到库文件）、`_worlds` 后面没有 id、id 非法、路径里含 `..`。
**被接受的**：`_worlds/<id>/_board/board.sqlite`、`_worlds/<id>/board.sqlite`、Windows 反斜杠形态。

### 2.2 t3 已接好的那条线（对上就别再改）

`board_server.js` 的队伍事件前半段：

```js
const worldIdResolver = typeof deps.worldIdOf === 'function' ? deps.worldIdOf : async () => (await import('../../mindcraft/world_store.js')).currentWorldId();
// 解析不出 ⇒ 抛 ⇒ ack { ok:false, code:'NO_BOARD' }（拒，不退化）
```

`mindserver.js` 现在**显式注入**了库路径版本（本任务加的一行）：

```js
boardHandle = attachBoardServer({
    io, db: board.db,
    worldIdOf: () => worldIdOfBoardDb(board.path),   // ← 库在哪就是哪一档
    ...
});
```

> **为什么不是 `currentWorldId()`**：它是"当前世界目录"的 id，跟库在哪**可以不一致**（换世界、诊断旧库、
> 双开测试）。判据必须是**库自己**，所以生产路径一律走 `worldIdOfBoardDb(board.path)`。
> `deps.worldIdOf` 不注入时回落到 `currentWorldId()` 只是给单测省事，别在生产里依赖它。

### 2.3 其余导出

| 导出 | 作用 | 备注 |
|---|---|---|
| `currentWorldId()` | 当前生效的 world_id | **有写副作用**，见 §4 |
| `currentWorldDir()` | 当前世界目录 | `MC_WORLD_DIR` → `<server>/world`（`MC_SERVER_DIR` 可改 server 根） |
| `worldIdOf(worldDir)` | 指定世界目录的 id（没有就生成） | 坏 sidecar ⇒ 抛，不重生成 |
| `readWorldIdOf(worldDir)` | **纯读**，不创建任何东西 | → `{ok, worldId, file, reason}` |
| `worldDataDirOf(id)` / `ensureWorldDir(id)` | `_worlds/<id>` / 建出来 | 非法 id ⇒ 抛 `WORLD_ID_INVALID` |
| `isValidWorldId(id)` | 入参校验（t3/t4 收 world_id 参数时用） | |
| `prepareBoardDirForCurrentWorld()` | **生产入口**：解析 → 建目录 → 幂等迁移 → 返回库目录 | mindserver 唯一调用方 |
| `migrateLegacyBoardToWorld(id, {quiet})` | 只做迁移 | 见 §3 |
| `resolveExistingBoardDir()` | **只读观察工具**用：找到现存的库目录 | 迁移前后都指同一块真库，见 §6 |
| `newWorldId()` / `WORLD_ID_FILE` | 生成 id / sidecar 文件名常量 | |

---

## 3. 迁移：备份 → 搬家 → 指路牌（幂等）

### 3.1 五条分支

| 场景 | 行为 | 返回 `reason` |
|---|---|---|
| 新位置已有 `board.sqlite` | **一个字节都不动** | `already-migrated` |
| 旧位置也没有库 | 建目标目录（空库由 `openBoard` 建） | `no-legacy-board` |
| **两边都有库** | **谁都不动** + `console.warn` | `both-exist` |
| 只有旧库 | 备份 → 搬家 → 写 `MIGRATED-TO.txt` | `migrated`（`migrated:true`） |
| 目标目录在别处已存在（同 id 第二块盘） | 按第一条处理 | `already-migrated` |

`both-exist` 不自动合并：合并两块库是**人的决定**（哪块是新的、要不要把旧单挪进某支队伍），脚本替人做
就等于把"账对不上"藏起来。

### 3.2 备份与 WAL

备份文件（就在旧位置旁边）：`board.sqlite.bak-<YYYYMMDDHHMMSS>`，
并**连 `-wal` / `-shm` 一起备**：`board.sqlite-wal.bak-<ts>`、`board.sqlite-shm.bak-<ts>`。

> 为什么非要连 WAL：本机生产库当前 `bots/_board/board.sqlite-wal` 有 **927032 字节**（19:50 还在写）。
> WAL 里是**已提交但还没 checkpoint** 的页 —— 只搬/只备主文件，等于丢最近的工单与预占。
> 单测专门有一条：三件一起搬、三件都有备份、旧位置三件都不在。

### 3.3 `MIGRATED-TO.txt`（实测原样）

```
# 任务板库已迁到「存档维度」（ADR-0001 D6 / 阶段 3）
world_id: w-20261112-136a66f2
moved_at: 2026-11-12T12:27:38.610Z
to: C:\...\bots\_worlds\w-20261112-136a66f2\_board\board.sqlite
backup: board.sqlite.bak-20261112202738

本目录不再有 board.sqlite（迁移前已备份，见上面 backup）。
回滚：停服 → 把备份改回 board.sqlite → 把新位置的 board.sqlite 移走 → 起服。
注意：回滚后新版本会再次迁移到**同一个** world_id（sidecar 不动）。
```

迁移后旧目录实测内容：`MIGRATED-TO.txt` + `board.sqlite.bak-20261112202738`（不再有 `board.sqlite`）。

### 3.4 幂等：实测输出（`node tools/world_store_unit.mjs` ③ 段原样）

```
③ 迁移
  PASS  迁移后 migrated=true   [object Object]
  PASS  新位置 board.sqlite 存在   C:\Users\zeh\AppData\Local\Temp\world-store-test-ZvMJiH\bots\_worlds\w-20261112-136a66f2\_board\board.sqlite
  PASS  新库与迁移前的原库逐字节相同
  PASS  旧位置不再有 board.sqlite
  PASS  备份是 .bak-<时间戳> 且内容 = 原库   C:\Users\zeh\AppData\Local\Temp\world-store-test-ZvMJiH\bots\_board\board.sqlite.bak-20261112202738
  PASS  旧位置留 MIGRATED-TO.txt
  PASS  MIGRATED-TO.txt 写清 world_id 与去向   world_id: w-20261112-136a66f2,…
  PASS  数据搬过去还能读   legacy-job-A
  PASS  第二次 migrated=false / already-migrated   already-migrated
  PASS  第二次整棵树完全一致（幂等）
  PASS  备份只有一个（不重复备份）   board.sqlite.bak-20261112202738
  PASS  prepareBoardDirForCurrentWorld 返回 <bots>/_worlds/<id>/_board   …\bots/_worlds/w-20261112-136a66f2/_board
  PASS  prepare 两次返回同一目录且不再备份
④ 迁移边界
  PASS  两边都有 → migrated=false / both-exist   both-exist
  PASS  两边都有 → 谁都不动
  PASS  没有旧库 → no-legacy-board 且建出目标目录   no-legacy-board
  PASS  没有旧库 → 不写 MIGRATED-TO.txt
  PASS  WAL 家族三件一起搬到新位置   3
  PASS  WAL 家族三件都有备份（含 -wal/-shm）   [object Object]
  PASS  旧位置三件都不在了
OK  通过 71 / 失败 0
```

"整棵树完全一致"不是比日志：是把 `bots/**` 全部文件的**相对路径 + 大小 + sha256** 拍成快照，
第二次跑完再拍一次，逐字节比较。

### 3.5 反例证明（测试**真的会红**，不是摆设）

| 故意破坏 | 结果 |
|---|---|
| `worldIdOfBoardDb` 解析不出时 `return null`（正是禁止的写法） | exit=1，**7 条红**：`{"threw":false,"returned":null}` ×7 |
| 迁移里去掉"先备份" | exit=1，**4 条红**：`备份是 .bak-<时间戳>…`、`备份只有一个`、`prepare…不再备份`、`WAL 三件都有备份` |

两次都已恢复到全绿（71/0）。

> ⚠ 排期提醒：如果你看到过 `world_store_unit` 报 7 条失败，那是**上面第一次反例**（我为了证明测试能红
> 故意把函数改成 `return null`），不是并发/环境问题；恢复后重跑即 57/0。

---

## 4. ⚠ `currentWorldId()` **有写副作用** —— 只读路径禁止用它

首次调用会：

1. `mkdir` 世界目录（`<仓库>/server/world` 不存在时也会建）；
2. 写 `<worldDir>/world-id.json`（tmp + 硬链接，防两路同时首次启动生成两个 id）。

因此：

* **只读/诊断**要"看"id → 用 `readWorldIdOf(dir)`（纯读）或 `tryWorldIdOfBoardDb(dbPath)`；
* **判断"这块库属于哪一档"** → 用 `worldIdOfBoardDb(dbPath)`（库在哪就是哪一档，与进程环境无关）；
* 只读观察工具找库 → `resolveExistingBoardDir()`（纯读，不建目录、不写 sidecar）。

> 这正是 t3 从 `currentWorldId()` 改用 `worldIdOfBoardDb(board.path)` 的原因。别再改回去。

**sidecar 坏了怎么办**：`worldIdOf()` 会**抛** `WORLD_ID_SIDECAR_CORRUPT`，**不会**自动重新生成。

* 为什么不自动修：重新生成 = 换一个 id = `_worlds/<旧 id>/` 里的队伍与账本**被静默孤立**（界面表现是
  "队伍没了"，没有报错）。
* 怎么办：人工看一眼那个 JSON（`id` 是不是缺了/写坏了），改对即可；确认要**重开一档**时再删文件——
  删除是可见动作，重建是隐形事故。

---

## 5. 失败模式对照表（排障用）

| 现象 | 真实原因 | 处理 |
|---|---|---|
| 日志 `[任务板] 板起不来（库文件原样保留…）` + `WORLD_ID_SIDECAR_CORRUPT` | sidecar 存在但读不出合法 id | 修/删 `<server>/world/world-id.json`（见 §4） |
| 队伍操作一律回 `NO_BOARD` | 库不在 `_worlds/<id>/` 下（还指着旧位置） | 看日志的库路径；跑 `node tools/world_migrate.mjs` |
| 旧库还在、新位置也有库（`both-exist` 警告） | 曾经迁移过又回滚了一半 | 人工确认哪块是新的；脚本不替你合并 |
| `_worlds/` 下出现两个 id | 曾经换过世界目录 / 删过 sidecar | `node tools/world_migrate.mjs` 会列出来（只读提示，不删） |
| 迁移后"工单少了最近的几条" | 只搬了主文件，没搬 `-wal` | 本实现已修（§3.2）；旧实现不要再用 |
| 容器/只读环境里板起不来：`ENOENT`/`EACCES` 指向 `server/world` | `currentWorldId()` 要**建目录 + 写 sidecar**（§4），而容器里没有可写的 `server/world` | 设 `MC_WORLD_DIR` 指向**挂载的存档目录**（本该如此：id 要跟存档一起走）。板起不来不影响 agent 聊天/走/挖 |

运维工具（**不打开数据库、不改内容**）：

```bash
node tools/world_migrate.mjs              # 报当前 id + 库位置，并跑幂等迁移
node tools/world_migrate.mjs --dry-run    # 只报告会做什么（**不写任何文件**）
node tools/world_migrate.mjs --db <file>  # 反解某块库属于哪一档（解析不出 = FAIL + exit 1）
```

---

## 6. 改了哪些、没改哪些

**改**（本任务全部落点）：

| 文件 | 改动 |
|---|---|
| `mindcraft/src/mindcraft/world_store.js` | **新增**（唯一真相：sidecar / 分层 / 反解 / 迁移） |
| `mindcraft/src/agent/library/bot_paths.js` | 加 `boardDirForWorld(id)`；`boardDirOf()` **原样保留** |
| `mindcraft/src/mindcraft/mindserver.js` | `openBoard(boardDirOf())` → `openBoard(prepareBoardDirForCurrentWorld())`；并注入 `worldIdOf: () => worldIdOfBoardDb(board.path)` |
| `mindcraft/tools/world_migrate.mjs` | 新增运维 CLI |
| `mindcraft/tools/world_store_unit.mjs` | 新增单测（71 例，自动纳入 `unit_all`） |
| 5 个**只读观察**工具 | `boardDirOf()` → `resolveExistingBoardDir()`：`t37_claims_contention_live`、`t37_firstnight_live`、`t51_firstnight_realagent`、`t52_board_diag`、`board_user_version_check`（+ `temp_board.mjs` 的注释） |

> 那 5 个工具为什么必须跟着改：它们是"看真实系统"的只读脚本（`openBoard(dir, {readOnly:true})`）。
> 生产库迁移走之后，`boardDirOf()` 指向的目录里**没有** `board.sqlite`，只读打开会抛"库不存在"——
> 等于把排障工具静默打死。`resolveExistingBoardDir()` 在迁移前后都指向同一块真库，且**纯读**
> （不建目录、不写 sidecar）。单测 ⑥ 段 6 条钉住：迁移后指新位置 / 只有旧库时指旧位置 /
> 找库不生成 sidecar / 磁盘上只有一个存档有库就指它 / **多个存档都有库时不猜、退回旧位置**。
> 旧位置彻底清空后，这个函数与它的调用点一起删。

**没改**（明确不做，免得下一个人以为漏了）：

* **表结构**：本任务只换库**位置**，不动 schema（`BOARD_SCHEMA_VERSION` 与 team/inventory 表是 t3/t4 的事）。
* `identity*` / `people*` / `commands/**` / `web/**` / `board_*`：一行没动。
* **生产数据没迁**：`bots/_board/board.sqlite` 仍在原地（`-wal` 有 927032 字节未 checkpoint 数据，
  且面板 `node server.js` 在跑）。迁移代码路径与 mindserver 启动时**完全相同**，交给下次启动执行
  （那时没有写者，rename 最干净）。
* **备份一致性策略**：`_worlds/` 与 `server/world/` 是两份备份对象（ADR §5 的代价），本任务不写备份脚本。
* `team_chest(world_id)` 与 WorldGuard 区域覆盖的交叉校验属 t5/t7（`tools/team_wg_crosscheck.mjs`），
  本任务只负责提供 id 来源。

---

## 7. 验证

| 项 | 结果 |
|---|---|
| `world_store_unit`（新） | **71/71**，且两条反例实测能红（§3.5） |
| `board_store_unit` | 25/25 |
| `board_open_migrate_unit` | 8/8 |
| `board_scope_unit` | 10/10 |
| `board_iface_unit` | 16/16 |
| `shared_chest_merge_unit` | 13/13 |
| `npm run gate` | **0**（含 lint:hard：no-undef 0 / no-floating-promise 0） |
| `node tools/unit_all.mjs` | **151/151 脚本通过，5 跳过**（含 `world_store_unit 71 用例`、t3 的 `team_store_unit 12` / `team_wg_crosscheck_unit 8`） |
| `lint:ratchet` | 与 t1 记录一致（+9：require-await 8 / no-control-regex 1），**本任务新增 0**（新文件 eslint 逐条 clean；`mindserver.js` 唯一的 require-await 在 HEAD 就有：`getTexture`） |

---

## 8. ⚠ 未决：**容器部署**下 sidecar 的落点（需要裁决，我没有擅自改 compose）

**事实（读过 `mindcraft/Dockerfile` 与 `docker-compose.yml`）**

* compose 只挂了 `./bots:/app/bots`（持久卷）+ 几个配置文件；
* 镜像里**根本没有** `/app/server`（`COPY` 只有 `bots/` 的两个模板、`src`、`web-dist` 等），也没挂载它；
* 所以容器里 `currentWorldDir()` = `/app/server/world` —— 一个**新建在容器可写层**的目录。

**后果（真会发生的坏结果）**

容器销毁重建 ⇒ `/app/server/world` 没了 ⇒ 生成**新** world_id ⇒ `_worlds/<新 id>/_board/board.sqlite`
是块空库 ⇒ 面板与命令看起来像「任务板/队伍被清空」。旧数据还在旧 id 目录里，但**在容器可写层中，
容器一删就真没了**。

**代码已经做的**（不静默）

* 世界目录**本来不存在**时，`worldIdOf()` 打一条 `console.warn`（点名目录 + 说清"重建容器会换 id"），
  并把 `opts.quiet` 留给单测/脚本；
* 单测末尾三条钉住这件事（告警恰好一次、点名那个新建目录、世界目录已存在时不告警）。

**三种修法（选哪个是架构/安全取舍，不是实现细节）**

| 方案 | 做法 | 代价 |
|---|---|---|
| **A（我倾向）** | compose 加 `../server/world:/app/server/world` | sidecar 真正跟存档走（符合 ADR「随备份走」）；但容器因此拿到**存档目录写权限** —— 爆炸半径变大 |
| B | compose 设 `MC_WORLD_DIR=/data/world` + 挂一个专用卷 | 不碰存档；但 id 与存档**脱钩**（换存档/回滚存档后 id 不变），与 ADR 原意不符 |
| C | 不改 compose，在部署文档里要求必设 `MC_WORLD_DIR` | 零风险；但"忘了设"就回到静默换档（只有一条 warn 兜着） |

**本机（宿主）部署不受影响**：`E:\我的世界ai\server\world` 存在，sidecar 就落在真实存档目录里。

> 这条留给 captain/用户裁决（涉及安全取舍，且 compose 在本机改不了、没法实测）。
