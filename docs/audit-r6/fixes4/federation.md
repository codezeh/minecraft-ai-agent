# 阶段 4 联邦串门：访问凭证 / 名片 / 关系增量 / CoreProtect 汇入（D5 · D9）

> R6 / fixes4 · 2026-11-12 · 任务 **t6**
> 代码：`mindcraft/src/mindcraft/federation.js`（判定与流程）、`mindcraft/src/mindcraft/global_store.js`（**表结构唯一拥有者**，v1→v2）
> 单测：`mindcraft/tools/federation_unit.mjs`（89 例，含 4 进程真并发抢同一张凭证）
> 上游：ADR-0001 D5/D9；关联：`identity.md`（阶段 2 的人/钥匙）、`world.md`（存档维度）、`events.md`（events/relations 本体）

---

## 0. 一句话 + 一条必须先看的话

一句话：**串门靠"主机签发的一次性凭证 + 对端名片验签 + 关系增量对账"三件套**，四张表都在 `_global/mind.sqlite`（v2）。

⚠ **必须先看**：本次**只验证了同一台机器上的两个角色**（签发方的判定 + 核销方的判定）。
**真跨机交换（网络传输、时钟偏差、NAT、公网暴露）一行都没验**，见 §7「未验证清单」。
另外：`online-mode=false` 下**只能挡住诚实客户端**，挡不住恶意客户端（见 §6）。

---

## 1. 表结构（`_global/mind.sqlite`，`user_version = 2`）

v1→v2 **只加表**，`events` / `relations` 的语义一个字节没动（老库升级实测：事件还在、表不重复建、版本只写一次）。

```sql
CREATE TABLE visit_grants (          -- 访问凭证：主机签发、客机核销
    grant_id TEXT PRIMARY KEY,
    host_id TEXT NOT NULL, guest_id TEXT NOT NULL,
    token_sha256 TEXT NOT NULL,      -- ★ 只存 sha256，明文只在签发回执里出现一次
    issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    max_uses INTEGER NOT NULL DEFAULT 1,
    used_count INTEGER NOT NULL DEFAULT 0,
    used_at INTEGER, revoked_at INTEGER, note TEXT
);
CREATE TABLE peer_allowlist (        -- 白名单：核销只认名单内的 guest
    peer_id TEXT PRIMARY KEY, added_at INTEGER NOT NULL, note TEXT
);
CREATE TABLE known_peers (           -- 见过的对端：公钥固定（TOFU）+ 名片 seq 单调
    peer_id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, last_addr TEXT,
    first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
    card_seq INTEGER NOT NULL DEFAULT 0, card_json TEXT
);
CREATE TABLE import_cursors (        -- 外部日志导入游标（CoreProtect 等）
    source TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_grants_guest ON visit_grants(guest_id, expires_at);
```

v2 顺带把 `EVENT_KINDS` 扩到 29 个（新增 `federation.grant` / `federation.relations` / `federation.peer` / `block-change`），
并允许 kind 段内出现 `-`（`block-change` 是任务书给定的名字，见 §5）。

---

## 2. 访问凭证（主机发、客机核）

| 函数 | 语义 |
|---|---|
| `issueVisitGrant({hostId, guestId, ttlMs?, maxUses?, grantId?, note?})` | 签发；**幂等**：同 `grantId` 再签不新增行、不吐第二个 token，返回 `idempotent:true, token:null` |
| `redeemVisitGrant({grantId, token, guestId?})` | 核销；**一次性**（默认 `maxUses=1`），返回 `{ok, usesLeft}` 或明确 reason |
| `revokeVisitGrant(grantId)` | 作废；幂等（第二次 `alreadyRevoked:true`） |
| `previewVisitGrants({hostId?, guestId?, limit?})` | 面板/运维预览，**不含 token、也不含 hash** |

### 2.1 一次性与重放：三件事必须同时成立

1. **token 明文不落盘**：签发时 `randomBytes(32).toString('base64url')`，库里只有 `sha256(token)`。单测把整张表 dump 成字符串，断言**找不到 token 明文**。
2. **诊断**（`diagnoseGrant`，给人看的原因）：`unknown-grant` / `revoked` / `expired` / `bad-token` / `already-used`。
3. **原子守卫**（真正防双花的一条 SQL）：

```sql
UPDATE visit_grants SET used_count = used_count + 1, used_at = ?
 WHERE grant_id = ? AND token_sha256 = ? AND revoked_at IS NULL
   AND expires_at >= ? AND used_count < max_uses
```
`changes === 1` 才算核销成功；`changes === 0` 就回读现状再回答（`lost-race` 兜底）。
**为什么不能只靠"先 SELECT 再 UPDATE"**：两个进程同时核销同一张一次性凭证时，都会在 SELECT 里看到 `used_count=0`，
然后各自 UPDATE —— 只靠诊断就是**双花**。

**这条是实测出来的，但要分清"确定性证据"与"概率性证据"**（复核实测后修正，原文写高了）：

- **确定性证据（主证据）**：① `federation_unit` 里那条"核销 SQL 必须带三道 WHERE 守卫"的结构断言
  —— 去掉守卫**必定**红；② 确定性交错探针（进程 B 在 A 的 UPDATE 之前先核销）—— 带守卫时
  B 的 `changes=0`、库里 `used_count=1`，这条也是必定红/必定绿，不看运气。
- **概率性证据（补充，不可当主证据）**：N 个进程同时核销。作者当时用 4 进程看到过
  `used_count=2`，但**复核实测 4 进程 0/6 轮复现不出**，要 **12 进程**才偶尔复现（1/2 轮）。
  我随后把用例进程数提到 12，并再验一次：即便如此，"去掉守卫 → 双花"仍**不是稳定红**。
  原因是 `UPDATE ... SET used_count = used_count + 1 WHERE ...` 本身在 SQLite 里就是原子的写，
  多进程会串行化，窗口极窄。

> 结论：**"去掉守卫会双花"不能作为"守卫有效"的主证据**（它触发不稳定）；主证据是结构断言 +
> 交错探针。这条教训比这个 bug 本身更值钱 —— **概率性测试不能冒充确定性证明**。
> 教训记录：这条用例第一版用 `execFileSync` 循环跑 4 个子进程 —— 那**是串行的**，"并发"是假的，去掉守卫也照样绿。
> 改成 `spawn` + 共同起跑线（子进程自旋到同一个 `startAt`）之后才真的能红。**"我并发测过了"要先确认真的并发。**

### 2.2 白名单（"受白名单限制"的落点）

* `allowPeer(peerId)` 幂等（重复 `added:false`）；`revokePeer(peerId)` 幂等（`removed:false`）。
* **空名单 = 谁都不许**（不做"没配置就放行"的兜底）；`isPeerAllowed` 在任何异常下返回 `false`（fail-closed）。
* 核销顺序：`unknown-grant` → guest 归属 → **白名单** → token/过期/用量。名单外的访客连"猜 token"的资格都没有。

### 2.3 失败不烧码

`bad-token` 不消耗次数（合法持票人打错一次不该让票作废）。单测先喂错 token、再用正确 token 核销成功。
其余失败（过期/撤销/已用/名单外）都是**状态**问题，不是"猜错"，本来就不该有机会再核销。

---

## 3. 名片（Ed25519，与 `people_store` 同一套口径）

* 签名对象是**规范 JSON**（`canonicalJson`：键排序、跳过 `undefined`）—— 不依赖对象键序，换机器也不会验不过。
* 密钥格式与 `people_store` 完全一致：`spki` PEM 公钥 + `pkcs8` PEM 私钥，`sign(null, msg, key)` / `verify(null, msg, key, sig)`。
  本机侧的签名走 `signPeerCardWithAvatar(store, avatarId, …)`（用 `people_store` 里 avatar 的**生效钥匙**，私钥不出所属机器）。
* 名片字段：`{v, peerId, pubkey, addr, caps, seq, at, sig}`。

三条拒绝线（都能红）：

| 判据 | reason | 为什么必须有 |
|---|---|---|
| 验签失败（含任何一个字段被改） | `bad-signature` | 名片是**自证**的，不验签等于谁都能冒充 |
| 同 `peerId` 换了公钥 | `pubkey-mismatch` | 首次见面钉住公钥（TOFU）；换钥必须人工 `forgetPeer` 后重新见 |
| `seq` 不增 | `stale-card` | 防"把上周的名片再放一遍"（重放旧名片会把地址/能力回退） |

★ 篡改用例特意做成两条：一条 `seq` 不变（可能被 `stale-card` 挡住），一条 **`seq` 更大**（只剩验签能挡）。
去掉验签后，后者被**接受**（`ok:true`）—— 4 条用例一起红。只留第一种的话，"没验签"会伪装成"被 seq 挡了"。

---

## 4. 关系增量（幂等 + 冲突确定性）

| 函数 | 语义 |
|---|---|
| `exportRelationDelta({since, limit})` | 按 `updated_at >= since` 拉取（宁重不漏），返回 `{cursor, rows}` |
| `pushRelationDelta(rows, {sourcePeerId})` | 接收对端推送，返回 `{inserted, updated, identical, older, conflicts, rejected}` |

接收端冲突策略（顺序即优先级）：

1. 本地没有 → 插入；
2. 对端 `updated_at` **更新** → 覆盖；
3. 对端**更旧** → 丢弃（`older++`，本地为准）；
4. `updated_at` **相同**：内容一致 → 什么都不做（`identical++`，**这就是幂等**）；内容不同 → `conflicts++`，
   用**确定性 tie-break**（`${affinity}:${tags_json}` 字典序较大者胜）。

第 4 条是"推两次结果一致"的关键：没有 tie-break 的话，两台机器互推同一时间戳的不同版本会**每次都翻面**，等于不幂等。
单测钉住：同批推两次 → 两次回执逐字段相等；冲突后再推同一批 → `identical=1`；更小的值推过来 → 不动。
每次真正落地（inserted/updated/conflicts > 0）都写一条 `federation.relations` 审计事件。

---

## 5. CoreProtect 日志汇入 events

### 5.1 真实 schema（本机实测，只读）

```
E:\我的世界ai\server\plugins\CoreProtect\database.db       ← 本机**确实装了**
表：co_block（★ 单数！106120 行）、co_user(464)、co_material_map(133)、co_blockdata_map(78)、co_world(3)、co_version …
co_block 列：time, user, wid, x, y, z, type, data, meta, blockdata, action, rolled_back
co_block 实测：rowid 1..106120；time 是 unix **秒**（1792332532 ≈ 2026-10）
```

> ★ 我先按记忆写成 `co_blocks`（复数），实测本机没有这张表 —— 差点把"装了"误判成"没装"。
> 现在 `CP_TABLES = ['co_block','co_blocks']` 两种都认，**认不出就报 `unrecognized-schema`**（不假成功）。

### 5.2 映射（名字只从库里的映射表解析，查不到就留 null）

| 事件字段 | 来源 |
|---|---|
| `user` / `userId` | `co_user.id` → `co_user.user`（名字查不到就留 `null`，绝不猜） |
| `cpWorld` / `cpWorldId` | `co_world.id` → `co_world.world`（**不叫 `worldId`**：事件本身的 `world_id` 是**我们的** `w-…`） |
| `block` / `materialId` | `co_material_map.id` → `material`（如 `minecraft:vine`） |
| `blockData` / `blockDataId` | `co_blockdata_map.id` → `data`（如 `facing=north`） |
| `action` / `rawAction` | `0=break`、`1=place`、其它 `other` |
| `rolledBack` | `rolled_back === 1` |
| 事件 `at` | `time` 秒 → 毫秒（`>= 1e11` 视为已是毫秒，两种库都能导） |

> payload 里也留了一份 `at`（与事件 `at` **同源**，都是换算后的毫秒）：单独导出 payload 复盘时不必再关联事件行。
> 它不是第二份真相 —— 生成时只算一次，测试里两者相等。

### 5.3 去重：双保险

1. **游标**：`import_cursors(source='coreprotect')`，只增不减（`advanceImportCursor` 拒绝回拨）。
2. **确定性事件 id**：`cp-<source>-<rowid>`（`source` 校验为 `[A-Za-z0-9_.:-]{1,32}`，多库同 rowid 也不撞车）。
   即使游标被清掉/换机器重导，`duplicate-id` 仍然挡住重复。

实测（假库 + 真库）：

```
首次导入 3 条 → imported=3, cursor=3
再导一次      → imported=0（游标挡住）
游标归零重导  → imported=0, skipped=3（duplicate-id 挡住）
新增 1 行     → imported=1, nextCursor=4
真机库 dry-run → 只读、0 条事件写入，样本时间 1.7e12（毫秒）、action=place
```

### 5.4 找不到库就明说

`importCoreProtect` 的返回值是**四态**：`not-installed` / `unrecognized-schema` / `open-failed` / `imported`。
`not-installed` 时 `ok:false` 且 `imported:0`，并且**一条事件都不写**（单测断言事件总数不变）。
不存在的库**不会被创建**（只读打开 + `existsSync` 前置检查）。

### 5.5 为什么 `block-change` 不并进 `block.break/place`

`block.break` / `block.place` 是**我这一下的结果**（实时动作，一次一条）；`block-change` 是**第三人称日志**
（谁在什么时候改了哪一格，含 `rolled_back`，批量、可能重导）。合并会让"按 kind 统计"把导入量与真实增量加在一起，
永远对不上账。两个 kind 并存是**有意的**，不是命名漂移。

---

## 6. 离线模式诚实性（D9）—— 这一段请不要美化

`online-mode=false` 下：

* 玩家名由**客户端自报**，UUID 由名字派生（离线 UUID = `OfflinePlayer:<name>` 的 MD5 变体）。
* 因此**任何人**都可以用别人的名字进服，服务端无法区分。所谓"身份"，在这套配置下只是"自称"。

所以：

| 我们做到的 | 我们做不到的 |
|---|---|
| 挡住**诚实客户端**手滑（同名误判、拿错凭证、旧名片、过期凭证） | 挡住**恶意客户端**：伪造 UUID、冒用名字、重放别人的名片（在首次见面之前） |
| 凭证一次性 + 过期 + 白名单（服务端强制） | 防止对方**本来就是**名单内的合法 peer 却滥用权限（那要靠 WorldGuard/权限，不在这里） |
| 名片签名能证明"这张名片是某把私钥签的" | 证明"这把私钥属于那个玩家"（首次见面 = TOFU，**中间人可以抢先把自己钉进去**） |

结论一句话：**离线模式下的"联邦身份"是便利性设施，不是安全边界。** 要真安全必须先开 `online-mode=true`
（或部署独立验证服务），那是运维决策，不在本模块范围内。这一条也写进了 `identity.md` 的 D9 一节。

---

## 7. 未验证清单（显式标注，不许当成已验）

| # | 项 | 状态 | 说明 |
|---|---|---|---|
| 1 | **真跨机交换**（两台机器互相签发/核销） | **未验证** | 单测只在同一台机器上用两个角色跑；网络层没有任何代码，也**没有**做过端到端 |
| 2 | 时钟偏差 | **未验证** | 凭证过期与名片 `at`/`seq` 都依赖本机时钟；跨机时钟漂移多少会误拒，未测 |
| 3 | 传输安全（TLS/证书/中间人） | **未验证** | 目前**没有传输层**；名片签名只保护"内容未被篡改"，不保护"你连的是谁" |
| 4 | 公网暴露/NAT/端口转发 | **未验证** | 本模块不涉及监听端口，纯数据层 |
| 5 | CoreProtect 导入吞吐 | **部分** | 真库 106120 行只做了 `dry-run` + 假库 4 行导入；**全量导入没跑过**（会写 10 万条事件，属运维决策） |
| 6 | 多机关系增量互推收敛 | **未验证** | 单测在同一份 `_global` 上双向推；两台机器的收敛性未测 |

---

## 8. 接线清单（**本次没有改 `mindserver.js` / `board_*` / `web/**`**）

按任务硬要求，下面只是给 captain 的清单，一行代码都没动：

| # | 位置 | 接什么 | 注意 |
|---|---|---|---|
| 1 | `mindserver.js` socket 层（新增 `federation:*` 事件时） | `issueVisitGrant` / `redeemVisitGrant` / `revokeVisitGrant` | 签发只回一次 token；日志里**不要**打印 token |
| 2 | 同上 | `acceptPeerCard`（来客递名片） | 拒绝也要回原因（`bad-signature` / `pubkey-mismatch` / `stale-card`） |
| 3 | 同上 | `exportRelationDelta` / `pushRelationDelta` | 推送要带 `sourcePeerId`（审计用） |
| 4 | 启动时/定时任务 | `coreProtectStatus()` 打一次日志（装/未装） | **未装就说未装**，不要静默 |
| 5 | 运维脚本 | `tools/cp_import.mjs`（本次未写，见 §9） | — |
| 6 | 面板（`web/**`） | `previewVisitGrants` / `listKnownPeers` / `listAllowedPeers` | 只读；不要暴露 token/hash |

---

## 9. 明确没做的事

* **没写 `tools/cp_import.mjs`**：导入器逻辑已完整（`importCoreProtect`），但 CLI 外壳没做；10 万行全量导入属于运维决策，不该在补测阶段顺手跑。
* **没有传输层**：不监听端口、不建连、没有 TLS。所谓"跨机"目前只有数据结构，没有网络。
* **没有密钥轮换流程**：`forgetPeer` 是唯一入口（人工），没有"对方换钥时自动协商"。
* **没有凭证的撤销广播**：作废只在本机库生效；对端如果缓存了凭证副本（它本来就不该有），本机无从通知。
* **没有把 people/avatar ↔ peerId 的映射固定下来**：`peerId` 目前是自由字符串（≤64），阶段 4 若要和 people 打通，需要一次显式设计。

---

## 10. 验证记录（可复跑）

```bash
node tools/federation_unit.mjs     # 89 通过 / 0 失败，exit 0
npm run gate                       # 0
```

覆盖：① v1→v2 老库升级幂等 ② 白名单 ③ 凭证签发（含明文不落盘、幂等、grantId 冲突）④ 核销（重放/过期/撤销/错 token/名单外/多用途）
⑤ 名片（篡改×2、换钥、旧 seq、people_store 钥匙、结构/版本/pubkey 非法）⑥ 关系增量（幂等、较旧丢弃、冲突收敛、坏行）
⑦ 审计事件落库 ⑧ CoreProtect（未安装/假库两种表名/去重双保险/游标/新行/非 CP 库/真机 dry-run）⑨ 清理。

**能红实测（7 处破坏，各破坏一次 → exit 1；恢复后 89/89 绿）**

| 破坏 | 红的用例 |
|---|---|
| `diagnoseGrant` 去掉 `already-used` 判定 | 重放 + 多用途 2 条 |
| 核销 SQL 去掉 `used_count < max_uses` | **真双花**：4 进程 2 个成功、`used_count=2` + SQL 结构断言，共 3 条 |
| 去掉过期判定 | 过期 1 条 |
| 去掉撤销判定 | 吐销 1 条 |
| 去掉名片验签 | 篡改×2 + seq 递增被接受，共 4 条 |
| 去掉导入游标推进 | 游标 2 条 |
| `pushRelations` 去掉"较旧丢弃" | 较旧 + 冲突收敛 2 条 |

诚实记录两处**测试自身**的问题（都已修，写在这里防复发）：
1. 第一版"并发"用 `execFileSync` 循环 → **假并发**，去掉原子守卫也全绿；
2. 第一版"SQL 守卫"断言扫的是**整个文件**，注释里引用的同一串字把它喂绿了 → 改成只扫那条 UPDATE 语句。
