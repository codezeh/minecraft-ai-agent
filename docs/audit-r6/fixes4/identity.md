# 阶段 2 收尾：people 为权威 + 恢复码 + 面板人表（决策 A）

**日期**：2026-11-12 · **归属**：ADR 阶段 2（D4/D6）· **改动面**：`mindcraft/src/mindcraft/`、`mindcraft/src/agent/commands/`、`mindcraft/src/agent/permissions.js`、`web/**`、`mindcraft/tools/` 两个新单测

---

## 1. 问题：两处"谁是谁"

阶段 2 已经落了两份表，但它们**互相不知道对方存在**：

| 表 | 位置 | 表达 | 生命周期 |
| --- | --- | --- | --- |
| `identity.json`（bindings） | `bots/<bot>/identity.json` | 这只 bot 认哪个玩家、什么等级 | 每 bot 一份，换 bot/换存档就换一份 |
| `people.json` | `bots/_identity/people.json` | 人是稳定的主体，avatar 是它的分身 | 跨 bot、跨存档 |

后果（真机上能复现）：

1. 面板把人 `!revoke`（people 里 `state=revoked`）之后，那只 bot 的 `identity.json`
   里仍然写着 `level: owner` ⇒ **被撤销的人照样是主人**。撤销只改了一张表。
2. `!invite` 把被邀请人记进 people，同时把**当前 bot 的 avatar 挂到被邀请人名下**（旧实现）。
   邀请一次就把分身判给别人，原主人下次说话就"权限没了"，且没人能解释为什么。
3. 判定散在三处（`commands/index.js`、`commands/identity.js`、`permissions.js`），
   任何一处漏判都只表现成"她突然不听我话了"，没有日志。

**决策 A**：`people` 是**权威**，`identity.json` 降级为"本存档/本 bot 的当前绑定缓存"。
缓存读起来快（每 bot 一份），但**授不授权由 people 说了算**。

---

## 2. 统一入口：`resolveIdentityAuthority(agentName, {uuid, name})`

新模块 `mindcraft/src/mindcraft/identity_authority.js`（零业务依赖，只有 fs + 两个 store）。

判定顺序（前面任何一步不满足就 `level: null`，即 fail-closed）：

| # | 条件 | 返回 `reason` | 含义 |
| --- | --- | --- | --- |
| ① | 缓存里没有可用绑定 / 已过期 | `unbound` / `expired` | 缓存自己就不认，和 people 无关 |
| ② | `people.json` 缺失 | `no-people` | 权威读不到 ⇒ 不授权 |
| ③ | `people.json` 损坏（已改名留证） | `people-corrupt` | 同上，绝不"按空表照样给" |
| ④ | 这只 bot 在 people 里没有 active avatar | `no-person` | 分身没挂到任何人 ⇒ 缓存不生效 |
| ⑤ | 这个人 `state === 'revoked'` | `person-revoked` | **决策 A 的核心：撤销穿透缓存** |
| ⑥ | 缓存绑定的玩家 ≠ 权威里的人（含别名） | `person-mismatch` | 缓存过期/被手改，不生效 |
| ⑦ | 以上都过 | `ok` | 按缓存里的 `level` 授权 |

- 每次 fail-closed 都会 `console.warn('[identity-authority] <bot> 的身份**不生效**（fail-closed）：<reason>（细节）')`，
  按 `bot+reason` 去重（这条在"玩家每次发言"的路径上，不能刷屏）。
- `explainAuthorityReason(reason)` 提供**唯一一份**人话（命令话术、面板、拒绝提示都引用它，
  避免"同一件事三种说法"）。
- 调用点只有两个（不散写）：
  - `commands/index.js` 的 `identityContextOf().resolve` —— 所有权限判定（聊天命令、任务单）；
  - `commands/identity.js` 的 `ownerGate` —— `!invite` / `!revoke` 的权限闸门。

## 3. `identity.json` 降级为缓存后，三条写入路径必须同步

| 命令 | 对 people（权威）做什么 | 对 identity.json（缓存）做什么 |
| --- | --- | --- |
| `!claim <码>` | `ensurePerson(玩家名)` + `linkAvatar(这只 bot)` | 核销码后写 owner 绑定 |
| `!recover <码>` | 核销 person 级恢复码 → 旧 avatar 退役 → `linkAvatar` 到该 person | 直接写 owner 绑定（同一次操作） |
| `!invite <玩家名>` | 建人 / 复活 `state=active`，记 `invited_by/at` | **不写**（邀请不是绑定） |

两条"不许烧凭证"的保护：

- `!claim` 在**核销码之前**先只读检查人表：这只 bot 已归别人 ⇒ 当场拒绝，**码不被消耗**；
- `!recover` 的核销与改挂在同一次 `mutatePeople`（同一把锁、同一个 rev）里完成，
  失败（码无效/过期/人被撤）⇒ `mutator` 返回 `null`，**整张表一个字节都不写**。

### 3.1 `!invite` 的语义修正（诚实记录）

旧 `invite()` 会 `linkAvatar(当前 bot, 被邀请人)`。在"people 是权威"之后这条是**有害**的：
邀请一个朋友 = 把这只 bot 判给他，原主人的 `person-mismatch` 立刻生效、权限消失。

现在 `!invite` **只建人 + 记邀请人**，不碰 avatar 归属；归属只由 `!claim` / `!recover` /
面板「改挂」改变。`tools/people_invite_unit.mjs` 的 ③ 也随之改成断言
"邀请不改归属：botA 仍归 Steve"（原来断言的是相反的行为，等于把 bug 钉成了规格）。

---

## 4. 恢复码（人丢了分身怎么找回）

人（person）级一次性凭据，落在 `people.json` 的 `recoveries` 数组里：

```json
{ "id": "uuid", "person_id": "...", "hash": "sha256(规范化码)",
  "created_at": 0, "expires_at": 0, "used_at": null, "created_by": "panel" }
```

硬约束（都由 `people_store.js` 单点实现，命令与面板共用）：

- **只存 sha256**：`hashRecoveryCode()` 先规范化（大写、去空格/连字符）再 sha256；
  明文只出现在"签发那一次"的 socket 回执里。`people.json` 里搜不到明文（R3c 用真文件断言）。
- **带过期**：默认 30 分钟，`MAX_RECOVERY_TTL_MS` = 24 小时（传更大也压到 24h）。
- **单次使用**：核销即写 `used_at`；第二次查不到（`invalid`/`no-codes`）。
- **重签即作废旧码**：同一个人只留最新一个未用码（少一个"打印过但忘了"的口子）。
- **失败不烧码**：人 `revoked` / 人不存在 / 过期 ⇒ 都不写 `used_at`（重新启用后那个码还能用）。
- **作废**：`revokeRecoveryCodes({personId})`（面板"作废恢复码"）。
- 已用记录保留 7 天（`RECOVERY_KEEP_MS`）便于追责，过期记录直接清掉。

`!recover <码>`（对 guest 开放，同 `!claim` —— 丢分身的人本来就没身份）：
核销码 → `retireAvatar(当前 bot)` → `linkAvatar(当前 bot, person)` → 把发言人名记进 `aliases`
→ 写 owner 缓存 → `recordClaim`（离线 session 策略靠它）。回执如实说明退役了几条旧记录。

---

## 5. 面板（只改 `web/**`）

### 5.1 `identity-status` 新增字段（**不改旧字段形状**）

旧字段 `ok/agent/mode/modeError/corrupt/backup/codesCorrupt/codesBackup/pendingCodes/bindings`
一个没动（`people_recovery_unit` 的 R12b 断言它们仍在；`control_plane_r6_unit` D5 断言
`corrupt`/`backup` 仍在 identity-status 块的前 3000 字符内 —— 新增字段全排在 `bindings` 之后，
且 people 的读取放在 `cb(...)` 之前但**不夹在** corrupt/backup 行前面）。

新增：

- `people: [{id,name,aliases,state,avatars[],retired_avatars[],invited_by,invited_at,revoked_by,revoked_at}]`
- `peopleTotal`、`peopleCorrupt`、`peopleBackup`
- `recoveries: [{id,person_id,created_at,expires_at,created_by}]`（**不含 hash、不含明文**）
- `thisBotPerson: {id,name,state}|null`（这只 bot 在权威里归谁；null ⇒ 缓存权限不生效）

### 5.2 三个新 socket 事件（都是 `isPanelConnection()` + 独立限流桶）

| 事件 | 参数 | 说明 |
| --- | --- | --- |
| `identity-recovery-issue` | `personId` | 生成恢复码；明文只在这条回执里回一次 |
| `identity-recovery-revoke` | `personId` | 作废这个人未用的恢复码 |
| `identity-avatar-relink` | `agentName, personId` | 改挂 avatar：旧记录退役 + 挂到该 person |

都走 `mutatePeople`（人表自带文件锁 + rev），不复用身份表那套 `mutateStoreFile` CAS ——
两张表不同文件、不同锁，套错会变成"拿到锁 A 去写文件 B"。

### 5.3 UI（`web/src/components/IdentityPanel.vue`）

新增"人表"区块：每人一行显示 名字 / 状态（已启用·已撤销）/ 别名 / 名下分身 / 退役分身 /
邀请人 / 未用恢复码数，以及三个按钮（生成恢复码、作废恢复码、改挂到这只 bot）。
恢复码明文显示一次 + 倒计时；人表损坏时显示"已按空表 fail-closed 处理 + 留证路径"。
`stores/agents.ts` 增加 `IdentityPersonRow` / `IdentityRecoveryRow` 与三个请求函数；
`npx vue-tsc --noEmit` = 0。

---

## 6. 验证

| 项 | 结果 |
| --- | --- |
| `tools/people_store_unit.mjs` | 22/22 |
| `tools/people_invite_unit.mjs` | 27/27（③ 改为断言"邀请不改归属"） |
| `tools/identity_binding_unit.mjs` | 80/80（E 段造数据时补建 people 归属） |
| `tools/control_plane_r6_unit.mjs` | 53/53 |
| `tools/identity_authority_unit.mjs`（新） | 18/18 |
| `tools/people_recovery_unit.mjs`（新） | 31/31 |
| `cd web && npx vue-tsc --noEmit` | 0 |
| `npm run gate` | 0（preflight / lint:hard / API 扫描 / 前缀 import 规矩全绿） |
| `npm test` | **147/147 个脚本通过，5 个跳过**（原基线 144 + 本批新增 2 个 + 并行队友新增 1 个） |
| `web_dist_manifest_unit` | 改过 `web/**` ⇒ 必须重建产物：`cd web && npm run build` → `node ../mindcraft/tools/sync_web_dist.mjs` → `powershell scripts/release.ps1 -SkipDocker`（MANIFEST.json 的唯一写者是 release.ps1，R6 #50）⇒ 10/10 |

两个新单测**能红**（已实测，两次破坏后均 `exit=1`）：

1. 把 `identity_authority.js` 的 ③（"没挂到人就 fail-closed"）改成回退到缓存等级 ⇒
   `identity_authority_unit` 立刻红 2 条：`A2`（people 没挂这只 bot ⇒ no-person）、
   `A9`（权限判定必须给 guest，实际给了 owner）。改回后 18/18 全绿。
2. 把 `consumeRecoveryCode` 里的 `record.used_at = now` 改成 `null`（= 破坏单次使用）⇒
   `people_recovery_unit` 立刻红 2 条：`R5c`（同码第二次必须失败）、`R11f`（`!recover` 不能复用）。
   改回后 31/31 全绿。

### 6.1 一条与本次无关但会被撞上的门禁（如实记录）

`node tools/lint_ratchet.mjs` 当前 `+9`（`require-await` +8 / `no-control-regex` +1）。**不是本批引入**：

- 本批新增/修改的 tools 文件（`identity_authority_unit.mjs`、`people_recovery_unit.mjs`、
  `people_invite_unit.mjs`）用同一份 eslint 逐个跑过 —— 全部 `(clean)`；
  `people_invite_unit.mjs` 的 6 条 `async ()` 与 HEAD 版本一致（diff 里没有任何新增 `async`）。
- 基线文件本身已过期：`lint_tools_baseline.json` 记 `filesScanned: 283`，而 HEAD 已跟踪
  297 个 `tools/` 文件，`vault_import.mjs` 的 `no-control-regex` 在 HEAD 里就已存在（该文件本批未改）。
  ⇒ 要消化它应当由"收紧基线 / 清理历史文件"的单独一笔来做（`node tools/lint_ratchet.mjs --update`
  只在确实改善后使用）。

---

## 7. 诚实边界

- 恢复码/人表都是**本机文件**：能读 `bots/_identity/people.json` 的人可以直接建人，
  这一层解决的是"两处真相不一致"，不是"本机提权"（与 OPS-003 / F-RT-001 同一口径）。
- 离线服（`online-mode=false`）下 uuid 由名字派生，**同名仍可冒用**；
  `offline_owner_mode` 的 deny/session 策略与本文档无关，仍然照旧生效
  （authority 只决定"这条缓存算不算数"，不改变弱绑定的处置）。
- 阶段 3 引入 `_global` 时，`people.json` / `recoveries` 整体搬过去即可；
  本文件的判定顺序不需要改（`identity_authority` 只依赖 `readPeopleStore/ personForAvatar`）。
