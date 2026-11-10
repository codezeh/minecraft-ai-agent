# R6 修复批次 · 全量门禁与逐条复核（t7 / gate-runner）

> 执行时间：2026-11-10 22:34 → 23:30（Asia/Shanghai）
> 方式：**只读验证**。没有修改任何产品代码；唯一写入是 `tmp/` 下的临时产物与本文件。
> 结论先说：**全部门禁绿**（mindcraft `npm test` / `npm run gate` / `vue-tsc` / 父仓 ops-regression / 16 个 `.ps1` 解析）。
> **1 个需要处理的发现（F1）**：#18 的前端修复**只进了源码，没进受 git 跟踪并被打包服务的 `web-dist`** —— 面板运行时仍是旧代码。
> 这个发现属于"部署一致性"，与 R6 主题同源；按纪律我只报告、不代改（owner 应为 t1 / 队长）。

---

## 0. 结果总览

| # | 检查 | 期望 | 实测 | 判定 |
|---|---|---|---|---|
| 1 | `mindcraft` `npm test` | 133/133 + 5 跳过 | **134/134 + 5 跳过**，exit 0 | ✅ 绿（+1 新脚本，见 §2.1） |
| 2 | `mindcraft` `npm run gate` | 全绿 | **exit 0**，37 通过 / 0 失败 | ✅ 绿 |
| 3 | `web` `npx vue-tsc --noEmit` | 0 错误 | **exit 0**，无输出 | ✅ 绿 |
| 4 | 父仓 `node scripts/tests/ops-regression.mjs` | 29/29 | **ALL PASS: 29 passed, 0 failed** | ✅ 绿 |
| 5 | 所有 `.ps1` `Parser::ParseFile` | ERRORS=0 | **16 个文件，BAD=0** | ✅ 绿 |
| 6 | `git status` 无意外大文件 | — | 只有预期项（见 §8） | ✅ 绿 |
| 7 | 六份报告的定点单测（我逐条重跑） | 与报告一致 | **全部逐字一致**（见 §4） | ✅ 绿 |
| 8 | 生产板库迁移（我另做的真实数据验证） | v2→v3 不丢数据 | **from 2 to 3，shared=26 保留，幂等** | ✅ 绿 |
| 9 | `web-dist` 是否含 #18 修复 | 应含 | **不含**（新字符串 MISSING） | ❌ **红 → F1** |

---

## 1. 环境

- Node `v24.16.0`（MSYS Bash / Windows），PowerShell 5.1。
- 工作树：父仓 `E:\我的世界ai`；子仓 `mindcraft/`（独立 git）。
- 改动面（`git status` 实测）：
  - 父仓：`M README.md`、`M scripts/backup-world.ps1`、`M scripts/clone-all.ps1`、`M scripts/start-panel.ps1`、`M web/src/stores/diag.ts`、`?? scripts/provision.ps1`、`?? docs/audit-r6/fixes/`
  - 子仓：12 个 `src/**` 修改 + `?? src/agent/tasks/wait_for_teammates.js` + `?? tools/runtime_survival_unit.mjs`

---

## 2. mindcraft 全量

### 2.1 `npm test` — exit 0，134/134，5 跳过

```text
134/134 个脚本通过，5 个跳过
EXIT=0
```

**为什么是 134 而不是任务书里的 133**：t4 新增了 `tools/runtime_survival_unit.mjs`（git 里是 `??` 未跟踪新文件），
而 `tools/unit_all.mjs` 的 UNITS 是 **`readdirSync` 自动发现**（`unit_all.mjs:93-94`），所以新增脚本自动计入、无需改清单。
**没有删除/跳过任何既有测试**（`git status` 无删除、`tools/*.mjs` 无既有文件被修改）。

5 个跳过全部是**环境性跳过**，不是被修坏的：
- `test_memory_cap` / `test_nav_opt` / `test_path3d` / `verify_y_semantics` —— 需要真机数据（加 `--real` 才跑）；
- `chest_withdraw_race_unit` —— 需要跑着的测试服（MC 25566 / RCON 25576）。

> 计数口径小说明（不是缺陷）：gate 的 `[7/7]` 写"注册 139 = 执行 135 + 跳过 4"，
> 而 `npm test` 写"134 通过 + 5 跳过 = 139"。差额是 `chest_withdraw_race_unit`：
> 它在注册表里算"执行"（确实被拉起、exit 0），但自己打 `SKIP` 行 → `unit_all` 把它归到 skipped。
> 两边总数都是 139，只是归类方式不同。

### 2.2 `npm run gate` — exit 0，全绿

```text
GATE_EXIT=0
✓ patch_integrity 通过
✓ check_secret_filenames 通过：没有被跟踪的凭据类文件。
✓ settings 键一致性检查通过
✓ 全绿：37 通过，0 失败。
  ✓ 规则审计通过（规则表 18 条，自洽）
  ✓ 错误码审计通过（扫到 35 个码，均已注册；CODES 共 41 个）
✓ API 扫描没有命中（5 条规则，扫 420 个文件）
✓ 前缀 import 规矩没有命中（411 条本地 import，违规 0）
✓ A 档 0 处
启动自检通过（含函数体冒烟测试）。
✓ [lint:hard] no-undef = 0 · no-floating-promise = 0（扫 179 个文件）
```

与 t2/t6 声称的"错误码审计 35 码全注册、37 通过 0 失败、启动自检通过、lint_hard 0/0"**逐字一致**。

### 2.3 `vue-tsc --noEmit` — exit 0

```text
TSC_EXIT=0     # 无任何输出
```

---

## 3. 父仓（部署 / 运维侧）

| 命令 | 结果 |
|---|---|
| `node scripts/tests/ops-regression.mjs` | `ALL PASS: 29 passed, 0 failed`，exit 0 |
| 16 个 `.ps1` 的 `Parser::ParseFile` | `TOTAL_FILES=16 BAD=0`，每个 `ERRORS=0`（含 `provision.ps1`、`backup-world.ps1`、`lib/*.ps1`、`tests/*.ps1`） |

`.ps1` 清单：`backup-world` `clone-all` `deny-rcon-25575-in` `e2e` `harden-credentials-acl` `install-backup-task`
`provision` `release` `restore-drill` `start-panel` `stop-panel` `verify-world-backup` `lib/backup_config`
`lib/rcon` `tests/fake-rcon-server` `tests/rcon-regression`。

---

## 4. 六份报告逐条复核（"不是编的"）

> 方法：把每份报告 §验证 里列的命令**原样重跑**，逐条比对数字。
> 下表"实测"列全部来自我本次运行，不是抄报告。

### 4.1 control.md（t1 · #2 / #18）

| 报告声称 | 我实测 | 判定 |
|---|---|---|
| `mindserver_gate_unit` ALL PASS 49 | `ALL PASS: 49 passed, 0 failed` | ✅ |
| `control_plane_guard_unit` 73/73 | `73/73 个用例通过` | ✅ |
| `proc_lifecycle_unit` 25 | `ALL PASS: 25 passed, 0 failed` | ✅ |
| `identity_binding_unit` 80/80 | `80/80 个用例通过` | ✅ |
| `mindserver_local_only_unit` 16/16 | `16/16 个用例通过` | ✅ |
| `ops003_offline_identity_unit` 28 | `ALL PASS: 28 passed, 0 failed` | ✅ |
| `lint_hard` 0/0（179 文件） | gate 内 `no-undef = 0 · no-floating-promise = 0（179 文件）` | ✅ |
| 13 个管理面事件都接了 `requirePanel` | 源码实测 **12 处 `requirePanel(...)`** + `shutdown` 走独立判据（`mindserver.js:1823-1837`）= **13** | ✅（口径需说明） |
| 旧判据 `!isAgentIdentity && auth?.token==null` 已删 | 仅存在于**注释**（`:1310`）；实际判据 `socketRole(socket) === ROLE_PANEL`（`:1323`） | ✅ |
| `auth_gate.js` 有 `ROLE_PANEL/ROLE_AGENT/credentialRole` | `:132` `:133` `:173` 全部在位 | ✅ |
| `diag.ts` OFFLINE 在 `:118/:130/:187` | 三处逐一命中 | ✅ |
| `vue-tsc` EXIT=0 | 我跑的 exit 0 | ✅ |

> 说明：报告写"13 个事件接 requirePanel"，实际是 **12 个走 `requirePanel()` + `shutdown` 走单独的服务端判据**
> （因为它有"任务模式正常收尾"这条合法路径，不能一刀切）。**功能等价，表述可以更准确**，不算缺陷。

### 4.2 board.md（t2 · #4 / #5 / #6 / #3 / #16）

| 报告声称 | 我实测 | 判定 |
|---|---|---|
| `board_store_unit` 25/25 | `25/25` | ✅ |
| `board_open_migrate_unit` 8/8 | `8/8` | ✅ |
| `shared_chest_merge_unit` 11/11 | `11/11` | ✅ |
| `board_b3_unit` 23/23 | `23/23` | ✅ |
| `board_coord_unit` 17/17 | `17/17` | ✅ |
| `board_iface_unit` 16/16 | `16/16` | ✅ |
| `board_cmd_unit` 11/11 | `11/11` | ✅ |
| `board_scheduler_unit` 40/40 | `40/40` | ✅ |
| `claims` 有 UNIQUE 索引 `uq_claims_key`，旧 `idx_claims_key` 被替换 | `board_store.js:145` `CREATE UNIQUE INDEX ... uq_claims_key`；`ensureClaimsUniqueKey` 里 `DROP INDEX IF EXISTS idx_claims_key` | ✅ |
| `user_version` 2→3 的幂等迁移 | `BOARD_SCHEMA_VERSION = 3`；我在**生产库副本**上实跑（§5.1） | ✅（比报告更强） |
| `normalizeListLimit` 堵 `LIMIT -1`；`board:list` 1..500 否则拒 | `board_store.js:738`、`board_server.js:330-341`（`TOO_MUCH`，不静默夹） | ✅ |
| `board:add` 30/60s 按来源分桶 | `ADD_RATE = {max:30, windowMs:60_000}`、`bucketKeyOf`（`:288/:292`） | ✅ |
| 未终结单上限 500 | `MAX_OPEN_JOBS = 500` + `countOpenJobs`（`:327/:400`） | ✅ |
| `board:hello` 身份绑定、`assertJobOwner` → `LEASE_LOST` | `:170-214` 绑定、`:263` assertJobOwner、`:276` LEASE_LOST、7 个写事件调用点 | ✅ |

### 4.3 cancel.md（t3 · #12）

| 报告声称 | 我实测 | 判定 |
|---|---|---|
| `opts_cancel_unit` 14 | `ALL PASS pass=14 fail=0` | ✅ |
| `agent_cancel_late_reply_unit` 7 | `7 passed, 0 failed` | ✅ |
| `t4_op_signal_unit` 6 | `6 passed, 0 failed` | ✅ |
| `result_type_unit` 51 | `51 passed, 0 failed` | ✅ |
| `r4_misc_web_unit` 41 | `41 passed, 0 failed` | ✅ |
| `bot007_010_history_unit` 20 | `20 passed, 0 failed` | ✅ |
| `prompter_path_unit` 20 | `20 passed, 0 failed` | ✅ |
| `adapters_signal_unit` 38 | `38 passed, 0 failed` | ✅ |
| `llm_usage_unit` 123 | `123 passed, 0 failed` | ✅ |
| `mod_batch4_unit` 33 | `33 passed, 0 failed` | ✅ |
| 5 个 prompter 调用点都递 `{signal,deadline,operationId}` | 源码：`history.js:150,158`、`coder.js:100`、`vision_interpreter.js:141,153`（各文件顶部 `operationCallOpts()`） | ✅ |
| tmp 探针 11 条断言全过 | `tmp/r6_cancel_probe.mjs` 仍存在 → 我重跑 `ALL PASS pass=11 fail=0` | ✅ |

### 4.4 runtime.md（t4 · #13 / #14 / #15 / #17）

| 报告声称 | 我实测 | 判定 |
|---|---|---|
| `runtime_survival_unit` 64 用例 | `ALL PASS: 64 passed` | ✅ |
| `board_stop_unit` | `6/6` | ✅ |
| `agent_cancel_late_reply_unit` | `7 passed, 0 failed` | ✅ |
| `bot007_010_history_unit` | `20 passed, 0 failed` | ✅ |
| `memory_store_corrupt_unit` | `6/6` | ✅ |
| `agent_process_backoff_unit` | `9/9` | ✅ |
| `task_pickup_unit` | `4/4` | ✅ |
| `save()` 不再向上抛，改记 `saveError` | `history.js:337` 注释 + `:369/:373` | ✅ |
| agent.js 收口到 `saveMemoryQuietly()` | `agent.js:770/909/1169/1189` | ✅ |
| `tasks.js` 3 处 `killAll()` 全部移除 | 现在只剩**注释**里提到（`:370/:530/:625/:643/:711`），无实际调用 | ✅ |
| 新增 `wait_for_teammates.js` | 存在，150 行，7.5 KB | ✅ |

### 4.5 ops.md（t5 · #7 + 手动备份读配置）

| 报告声称 | 我实测 | 判定 |
|---|---|---|
| `ops-regression` 29/29 | `ALL PASS: 29 passed, 0 failed` | ✅ |
| 4 个 `.ps1` 解析 ERRORS=0 | 我放宽到**全部 16 个** `.ps1`，`BAD=0` | ✅（更强） |
| `provision.ps1 -DryRun` EXIT=0，jar sha256 `8de7c52c…` 与 `.paper-url` 一致 | 实跑 EXIT=0，打印 `sha256 与 .paper-url 一致：8de7c52c3b024035…` | ✅ |
| 冷备真跑 EXIT=0，`server-config.zip` 内 `rcon.password` 置空 | 我另跑一份到 `tmp/gate-verify-backup`（`-Keep 0 -Force`）EXIT=0，日志 `server.properties：已脱敏入包（rcon.password 置空）` | ✅ |
| manifest 记 `containsSecrets=false` + 脱敏 | 我读这份新 manifest：`containsSecrets=false`、`redacted` 存在、`secretsPolicy={excludeSecrets:true, source:"config/backup.json", configFromFile:true}` | ✅ |
| `verify-world-backup` 137 PASS / 0 FAIL | 对这份新备份实跑：`ALL PASS: 137 项通过，0 失败（0 项警告）` | ✅ |
| `-IncludeSecrets` 与 `-ExcludeSecrets` 互斥、同给 exit 1 | 实跑：`FAIL ... 互斥` + `MUTEX_EXIT=1` | ✅ |
| `enabled=false` 只拦自动备份，手动仍执行 | 源码 `:138` `if ($FromConfig -and -not $backupCfg.enabled)` | ✅ |
| README / clone-all / start-panel 都指向 provision | `README.md:27-28,45-57`；`clone-all.ps1:391-392`；`start-panel.ps1:186-193` | ✅ |

> **我**没有重跑"真干净 clone 里端到端供给"那一条（t5 在自己的干净 clone 里跑过）。
> 我只在工作树里跑了 `-DryRun`。见 §7"静态/未实测清单"。

### 4.6 ledger.md（t6 · #19）

| 报告声称 | 我实测 | 判定 |
|---|---|---|
| `shared_chest_merge_unit` 11/11 | `11/11` | ✅ |
| `container_fix_unit` 5/5 | `5/5` | ✅ |
| `board_b4_unit` 11/11 | `11/11` | ✅ |
| `atom_classify_unit` 6/6 | `6/6` | ✅ |
| `skills_fakesuccess_unit` 9/9 | `9/9` | ✅ |
| `bot004_migration_unit` 11/11 | `11/11` | ✅ |
| `unit_all` 134/134（5 跳过） | 我跑的 `npm test` 一致 | ✅ |
| landmarks 不再读写 `chests.json` | `landmarks.js:13/:53` 声明；`saveLandmarks` 只写地标；无 `chests.json` 路径拼接（`:542`） | ✅ |
| 写走 `sharedPut`、读前 `refreshChests`、写完 `flushChestWrites` | `:156/:198/:227/:243/:268` | ✅ |
| 墓碑 `removed:true` + `FORGET_RADIUS=64` | `:70/:505-518` | ✅ |
| 跨 bot 可见（A 存 B 查到） | t6 自己的 tmp 脚本已被清理；但**仓库内** `board_b4_unit` 第 222-224 行就是 `A.sharedPut(...)` → `B.sharedFindItem(...)`，11/11 通过 | ✅（换了独立证据源） |

---

## 5. 我额外做的独立验证（超出"重跑报告"）

### 5.1 用**真实生产板库副本**验证 #5 迁移（关键）

报告只跑了合成的老库。我直接拿线上库做副本实测（原库只读，未改）：

```text
源：mindcraft/bots/_board/board.sqlite        user_version=2, shared=26, 索引=idx_claims_key(非唯一)
副本：tmp/gate-migrate-probe/                 ← 连同 -wal 一起复制
openBoard(副本) →
  migration = {"added":[],"from":2,"to":3,"claims":{"duplicateKeys":0,"removed":0}}
  rebuilt   = false   warnings = []
  user_version = 3
  索引 = sqlite_autoindex_claims_1, idx_claims_until, uq_claims_key     ← 旧 idx_claims_key 已换掉
  shared = 26   jobs = 0                                                 ← 数据零丢失
再次 openBoard → migration {"from":3,"to":3,...}, user_version=3         ← 幂等
```

**结论**：#5 的迁移在真生产数据形态上成立（不是只能在合成库上成立）。

### 5.2 `web-dist` 与源码漂移（→ F1）

见 §6。

### 5.3 备份链路（t5 第二条）真跑

`tmp/gate-verify-backup/world-20261110-225141`：我用 `-Keep 0 -Force` 另跑的一份，**没有覆盖任何既有备份**
（`backups/` 里 4 份 `world-2026*` 未动）。产物在 `tmp/`（`.gitignore:23 tmp/`），不污染仓库。

---

## 6. 红灯 / 发现

### F1（**需处理**，严重度：中高）— #18 修在源码里，但**没有进被打包、受 git 跟踪、由服务端下发的 `web-dist`**

证据链（全部实测）：

| 项 | 实测值 |
|---|---|
| `web/src/stores/diag.ts` 修改时间 | `2026-11-10T21:08` |
| `mindcraft/web-dist/MANIFEST.json` `generatedAt` | `2026-11-08T18:30:34Z`（本地 11-09 02:30） |
| `web/dist` 构建时间 | `2026-11-09T02:30` |
| 新增字符串 `清空未执行` / `本地视图保留` / `未连接 mindserver` 在 `web-dist/assets/` | **全部 MISSING** |
| 服务端下发的是哪份 | `mindserver.js:1214` → `path.join(__dirname,'../../web-dist')` = `mindcraft/web-dist` |
| `web-dist` 是否受 git 跟踪 | **是**（`git ls-files web-dist` = 15 个文件），且本次 `git status` **无修改** |
| `node tools/sync_web_dist.mjs --check` | `[sync] 一致` ← **假阴性**：它比的是 `web/dist` ↔ `web-dist`，两份一样旧 |
| `web_dist_manifest_unit`（9 用例，通过） | 只核 `MANIFEST` ↔ 产物文件；**不核 `web/src` 源码**。其文件头自称"防产物与源码漂移"，实现没做到 |

**影响**：面板（Docker 镜像 / 直接从 `web-dist` 提供）运行的仍是**改前**的 `diag.ack()` 语义 ——
断线时 `clearEvents()` 仍会清本地视图、`ack()` 仍可能把事件排进 `sendBuffer`。
即 **#18 在运行时不生效**，直到重新构建产物。

**修法（owner：t1 / 队长，我不代改）**：

```bash
cd web && npm run build
node ../mindcraft/tools/sync_web_dist.mjs      # 同步 web/dist → mindcraft/web-dist 并重写 MANIFEST
cd mindcraft && git add web-dist              # 产物受版本控制，必须一起提交
```

**建议顺带补门禁**（否则下次还会漂）：
- `web_dist_manifest_unit` 增加一条：按 `MANIFEST.source.hash` 的同一算法（`sync_web_dist.mjs` 已有的
  `walk web/src` 那套，或 `release.ps1` 里生成 `source{root,files,hash,inputs}` 的那段）**重算 `web/` 并比对**，
  不一致即 FAIL；
- 或让 `sync_web_dist.mjs --check` 接受 `--with-source` 直接比 `web/src` 而不是 `web/dist`。

> 说明：这不是本批谁"写错了代码"——产品的 JS/TS 改动是对的、类型检查也过。
> 缺的是**固化产物没重新生成**这一步，属部署一致性，正好落在本批主题里。

### F2（提示，非缺陷）— 线上板库还没升到 v3

`mindcraft/bots/_board/board.sqlite` 目前仍是 `user_version=2` + 旧 `idx_claims_key`：
迁移只在 `openBoard()` 时执行，而验证期间没有起 `mindserver`。
我已在副本上证明它会**干净升级且不丢 26 条 shared**（§5.1）。
→ 下次正常起服务时自动迁移；**无需人工动作**，但"线上已到 v3"这句话现在**不能提前写**。

另：父仓 `bots/_board/board.sqlite` 是个 4096 字节、`user_version=0`、`shared=0` 的空库。
`openBoard` 已强制显式传目录，不会被误用；仅提示存在两份同名库文件、口头沟通时要说清是哪一个。

### F3（提示，非缺陷）— 测试计数口径两套说法

见 §2.1 末尾。数字都对（139 = 134+5 = 135+4），只是 `unit_all` 按"运行时自报 SKIP"归类、
gate 的 `[7/7]` 按"注册表 + --real 名单"归类。**不要**把两个数混着引用。

### F4（提示）— 任务书预期 133，实际 134

唯一原因是 t4 新增了 `tools/runtime_survival_unit.mjs`，`readdirSync` 自动发现。
**没有**任何既有测试被删除或降级为跳过。

---

## 7. 证据级别：哪些是实测、哪些仍是静态推断

### 7.1 我**实测**（真跑、有退出码）

- 全量 `npm test`（134/134）、`npm run gate`（exit 0）、`vue-tsc`（exit 0）
- ops-regression（29/29）、16 个 `.ps1` 解析（BAD=0）
- 六份报告列出的**全部定点单测**（§4 表格，共 40+ 个脚本）逐条重跑并比对数字
- `provision.ps1 -DryRun`（EXIT=0，sha256 实测）
- 冷备**真跑**到 `tmp/`（EXIT=0）+ `verify-world-backup`（137/0）+ manifest 字段逐项读回
- `backup-world.ps1 -ExcludeSecrets -IncludeSecrets`（exit 1）
- **生产库副本**上的 v2→v3 迁移（§5.1）+ 幂等重开
- `sync_web_dist.mjs --check`（暴露 F1 的假阴性）
- `tmp/r6_cancel_probe.mjs`（11/11）

### 7.2 仍是**静态推断**（没实测，或报告自陈没做）

| 项 | 为什么没实测 | 谁已声明 |
|---|---|---|
| #18 的"浏览器断线 + 点清空"真机复现 | 需要真浏览器 + 断网注入；且 F1 未修复前**测了也是旧行为** | control.md §2.3/§4.4 明确写"未做，证据级别=静态+类型检查" |
| #2 的"agent 发 shutdown 被拒"真 socket 行为 | 我用 `mindserver_gate_unit`/`control_plane_guard_unit` 覆盖接线，未起真 socket 冒烟 | control.md §4.4 |
| 多 agent **真进程**并发（非 in-process server） | 板级测试用 in-process server + 双 socket（`board_b3/b4/cmd`），够覆盖协议；真多进程需起 bot | 未声明，属我判断 |
| t5 的"真干净 clone 端到端供给" | 我只在工作树跑了 `-DryRun` | ops.md 声称在干净 clone 里跑过；`tmp/cloneall-probe/` 是那次的痕迹 |
| 任务板 `warnings` 接到面板 | 代码里有 `openBoard().warnings`，面板无出口 | board.md 残留缺口已自陈 |
| #14 真坏文件（非合成）的抢救 | 单测用合成坏文件；无真生产 `memory.json` 损坏样本 | runtime.md 自陈修复策略；单测 6/6 |
| `killAll` 残留路径（任务进行中缺同伙仍经 `isDone()`→`killAll()`） | 已知未修的**另一条路径** | runtime.md §E 已明确留残留 |

### 7.3 报告自陈的残留缺口（我确认仍然存在，不是虚报）

- control.md：限流非按 agent 分；无 per-agent 凭据；任务模式 agent 可提前收尾；真机/E2E 未做；`control-denied` 前端无统一消费。
- board.md：多写者非支持形态；#3 需 per-agent 凭据才真封闭；重建仍换库文件；`warnings` 未接面板；限流是进程内桶。
- runtime.md：`saveError`/`corruptBackup` 无面板出口；`memory.json.corrupt-*` 无清理策略；`isDone()→killAll()` 长路径未动。
- ledger.md：`mergeSharedChest` 只写 pos/items/owner/at（重启后可能丢 category，根治需改 schema —— 属 ADR 阶段）。
- ops.md：`enabled=false` 只拦自动备份（符合设计，已写清）。

---

## 8. 工作区状态与副作用声明

### 8.1 我产生的写入（全部可丢弃）

| 路径 | 内容 | 是否入库 |
|---|---|---|
| `tmp/gate-verify-backup/` | 我为验证真跑的一次冷备（~84 MB） | 否（`.gitignore:23 tmp/`） |
| `tmp/gate-migrate-probe/` | 生产库副本 + 迁移结果 | 否（同上） |
| `tmp/gate-full.log` | gate 完整输出 | 否（同上） |
| `docs/audit-r6/fixes/verification.md` | 本文件 | 是（本任务交付物） |

**没有修改任何产品代码**（`git status` 与开工时点名的改动面一致，未增未减）。
没有删除既有备份（`backups/` 4 份原样，最新仍是 `world-20261110-194846`）。
没有起任何服务端、没有连生产板库写（只读 + 副本）。

### 8.2 一个环境异常（需要队长知道，但不是本批产物）

- 开工时（22:34）父仓 `git status` 里有 `?? .archify/`（1.6 MB，内部文件时间戳 **2026-11-09**，属**上一会话**的架构图产物）；
- 收尾时（23:10）该目录**已不存在**，`git status` 里也消失。
- 我全程**没有**对它执行任何删除（我只 `rm -rf` 过自己建的 `tmp/gate-migrate-probe`）。
- 判断：不是本批任何人的交付物，消失不影响门禁与结论；若是队长/清理任务所为，可忽略；否则请确认是否有别的进程动过工作树。

### 8.3 未跟踪文件检查（任务书第 2 条）

- `scripts/provision.ps1`：t5 新增，**预期内**（R6 #7 的交付物）。
- `docs/audit-r6/fixes/`：六份报告 + 本文件，共 ~150 KB，**预期内**。
- `mindcraft/src/agent/tasks/wait_for_teammates.js`、`mindcraft/tools/runtime_survival_unit.mjs`：t4 交付物，**预期内**。
- **没有**意外的未跟踪大文件（`.archify/` 已消失，此前 1.6 MB 且与本批无关）。

---

## 9. 给队长的建议动作（按优先级）

1. **F1（必须）**：让 t1 重建前端产物并提交 `mindcraft/web-dist`（含 `MANIFEST.json`），
   否则 #18 在运行时不生效。建议同时在 `web_dist_manifest_unit` 补"源码哈希漂移"校验，防复发。
2. **F2（可忽略）**：知悉线上板库会在下次起服务时自动升到 v3；对外别提前宣称"已升"。
3. **F4/F3（说明用）**：任务书里"133/133"应更新为"134/134（+1 新脚本）"；
   引用测试数时区分 `npm test` 与 gate `[7/7]` 两套口径。
4. 六份报告的残留缺口（§7.3）建议按原样收进后续批次，不要在本批 PR 里假装已闭环。
