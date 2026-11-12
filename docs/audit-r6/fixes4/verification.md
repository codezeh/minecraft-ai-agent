# 全量验证与复核（t9）

**结论：全绿。** 门禁、前端类型/构建/发布校验、父仓回归、真机 E2E（53/53）、七组反向验证全部通过；
发现 **1 个真问题（E2E 会写生产 world 目录，已复原 + 给修法）**、2 处无害残留、1 处统计口径易误读，
以及 **1 条必须写明的诚实边界：阶段 4 的 `_global` events/relations 与 federation 还没接进生产进程**。

- 仓库布局（很重要）：`E:\我的世界ai` 是父仓（`docs/`、`scripts/`、`web/`），**`mindcraft/` 是独立 git 仓库**（`.gitignore:13 /mindcraft/`）。
  父仓 `git status` 干净 ≠ 代码干净；本批代码提交都在 mindcraft 仓库里。
- 环境：Windows / Node v24.16.0 / npm 11.13.0 / **只有 PowerShell 5.1（无 pwsh 7）**。
  所有 `.ps1` 用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File` 调用，Parser 判定也用 5.1 的 `[Parser]::ParseFile`。
- 验证时间：2026-11-12 23:23 → 2026-11-13 00:30（Asia/Shanghai）。

---

## 1. 逐项结果

| # | 项目 | 结果 | 关键证据 |
|---|---|---|---|
| 1 | `mindcraft && npm test` | 🟢 exit 0 | preflight 131/131 模块导入成功；unit_all **154/154 脚本通过 + 5 跳过**，合计 **3232 个用例** |
| 2 | `npm run gate` | 🟢 exit 0 | `lint:hard` no-undef 0 / no-floating-promise 0（扫 187 文件）；API 扫描 5 条规则 0 命中 |
| 3 | `node tools/preflight.mjs`（单独跑） | 🟢 exit 0 | 7 段全过：规则 18 条自洽、错误码 35 个均已注册、A 档死分支 0 处、前缀 import 416 条违规 0 |
| 4 | `web && npx vue-tsc --noEmit` | 🟢 exit 0 | 无任何输出（0 错误） |
| 5 | `web && npm run build` | 🟢 出产物 | 由 `release.ps1` 步骤 2 执行：`PASS web/dist 构建完成`（15 个产物文件） |
| 6 | 父仓 `release.ps1 -SkipDocker` | 🟢 PASS | 步骤 4 产物校验 6 + 8 条断言全过（源码指纹 `0acf3b4d…`、产物指纹 `a59535fa…`） |
| 7 | 父仓 `release.ps1 -VerifyOnly` | 🟢 **8/8** | 「产物与 web/ 源码指纹一致」「产物指纹与清单一致」「入口引用与清单一致」 |
| 8 | 父仓 `ops-regression` | 🟢 **87 passed / 0 failed** | 含 R6#50 的 4 条"能红"用例（源码漂移/产物被改 ⇒ 必红） |
| 9 | 所有 `.ps1` Parser ERRORS=0 | 🟢 26/26 | 见 §3（BOM 有 4 个历史文档例外） |
| 10 | **真机 E2E `e2e.ps1 -Scenario all`** | 🟢 **53/53** | exit 0，见 §4 |
| 11 | 七组反向验证 | 🟢 7/7 组、12 断言 + 1 变异能红 | 见 §5 |

### 1.1 新测试报数（本批新增 12 个测试文件，全部在 mindcraft 仓库当日提交里）

| 测试 | 用例 | 归属 |
|---|---|---|
| `people_store_unit` | 22 | 阶段 2 人表 |
| `people_recovery_unit` | 31 | 阶段 2 恢复码 |
| `people_invite_unit` | 27 | 阶段 2 邀请/撤销 |
| `identity_authority_unit` | 18 | 阶段 2 权威判定 |
| `world_store_unit` | 71 | 阶段 3 world_id 分层 + 幂等迁移 |
| `team_store_unit` | 12 | 阶段 3 队伍 |
| `team_wg_crosscheck_unit` | 8 | 阶段 3 WG 只读自检（三态） |
| `inventory_ledger_unit` | 13 | 阶段 3 库存预占/结算/对账 |
| `global_store_unit` | 112 | 记忆结构化 events/relations |
| `federation_unit` | 89 | 阶段 4 凭证/名片/关系增量/CoreProtect |
| `contract_truncate_unit` | 13 | R6 #76/#77 |
| `history_corrupt_memory_unit` | 25 | memory.json 损坏夹具 |
| **合计** | **441** | |

另有工具（非单测）：`tools/board_user_version_check.mjs`（只读体检）、`tools/team_wg_crosscheck.mjs`、
`scripts/tests/schtask-smoke.ps1`（8 PASS，不注册真实任务）。

### 1.2 5 个跳过是什么（不是"少跑了"）

- `test_memory_cap` / `test_nav_opt` / `test_path3d` / `verify_y_semantics` —— 静态 `NEEDS_REAL_DATA`，加 `--real` 才跑。
- `chest_withdraw_race_unit` —— **运行期自报 SKIP**：需要跑着的测试服（MC 25566 / RCON 25576）。

⚠ **统计口径提醒（容易误读，不是 bug）**：preflight 的打字是「测试脚本 155（+4 跳过）」（静态清单：注册 159 = 155+4），
而 unit_all 运行结果是「154/154 通过 + 5 跳过」。差的这 1 个就是上面 `chest_withdraw_race_unit`：
清单里它是"要执行"，运行时它自己 SKIP。两处数字不矛盾，但同一屏出现两个基数，建议后续把运行期自报跳过单独统计。

---

## 2. 反向验证（七组）—— 不只是"单测里写着会拒"

探针：`tmp/verify/reverse_probe.mjs`（**不是产品代码**，tmp/ 已 gitignore），用真实模块 + 临时目录构造越权/重放/篡改输入。

| 组 | 攻击动作 | 期望 | 实测 |
|---|---|---|---|
| ① people 权威 | identity.json 缓存写一条"Impostor 的 owner"，people 里 Bot1 却挂在 Zeh 名下 | 拒 | ✅ `level=null reason=person-mismatch`（日志：`Bot1 的身份**不生效**（fail-closed）：person-mismatch（缓存=Impostor / 人=Zeh）`） |
| ①b | people 里根本没有这只 avatar，但缓存有 owner | 拒 | ✅ `reason=no-person` |
| ①c | **阳性对照**：people 认可的绑定 | 放行 | ✅ `level=owner reason=ok`（证明上面的"拒"不是"一律拒"） |
| ② 恢复码 | 同一个码核销两次（两次都真读盘） | 第二次失败 | ✅ `first=ok / second=invalid` |
| ②b | 先喂错码，再用真码 | 真码仍可用（失败不消耗） | ✅ `wrong=invalid / right=ok` |
| ③ world 迁移幂等 | 同一个旧库连搬两次，比对整棵树（路径+大小+sha256） | 第二次 `already-migrated` 且零变化 | ✅ `migrated=true → already-migrated`，`files=3`（首 1）前后逐字节一致，旧位置留 `MIGRATED-TO.txt`，备份存在 |
| ③b | 搬完读旧库里的那行 | 数据没丢 | ✅ `jobs.legacy-1` 命中 |
| ④ 队伍权限 | beta（非队长）往共享账本加箱子，然后 alpha（队长）加 | 非队长拒、队长成 | ✅ `member=NO_PERMISSION / leader=ok / 库里 1 行` |
| ⑤ 库存超卖 | **变异**：把 `runInImmediateTx` 改成裸调用（放开事务） | 必须红 | ✅ 见 §2.1 |
| ⑥ events 追加写 | ①导出面找 update/delete；②绕过模块用原始 handle `UPDATE events` / `DELETE FROM events` | 不存在 / 被拒且行不变 | ✅ 导出面 0 个写历史函数；`UPDATE` → `events is append-only: UPDATE is forbidden`；`DELETE` → 同（DELETE）；行内容一字未变，rows=1 |
| ⑥c | 语法合法但未登记的 kind（`identity.hacked`） | 拒 + 不落库 | ✅ `kind-not-allowed`，行数 1→1 |
| ⑦ 访问凭证重放 | 错 token → 正确 token → 同一 token 再来一次 | 错码不烧码、首次成、重放失败 | ✅ `bad-token → ok → already-used`；dump 整表**不含明文 token** |
| ⑦b | 白名单外访客持正确 token | 拒 | ✅ `not-allowlisted` |

汇总输出：`12 PASS / 0 FAIL`（exit 0）。

### 2.1 ⑤ 库存超卖：变异能红 + 按 sha256 复原

脚本 `tmp/verify/check_oversell.sh`（可重跑）：

```
原始 sha256: 453a1ebc2aae2d535380ad81e5d44db8480260f5d4f5cdfe42514682749e8bdd
变异（board_store.runInImmediateTx 第一行插入 return body();）
变异后 sha256: 1c42a094dfc3297f3efc1431e4bf5d7af7e71703e3e8413281594ab221257aa7
→ FAIL ② 预占没有把校验和写入关在一个写事务里（或对手方插进来了）
     {"total":12,"rivalRows":1,"probe":{"blocked":false,"raced":true}}
   ← 真超卖：已知库存 10，库里变成 12，对手方那条插进来了
→ 12 pass / 1 fail，exit=1
复原后 sha256: 453a1ebc…（与原始**完全一致**）
→ 13 pass / 0 fail，exit=0
```

> 这条是本次唯一改产品代码的动作，改完按 sha256 逐字节复原（脚本内断言，不一致即 FAIL）。
> `git status` 证实 `board_store.js` 无残留改动。

---

## 3. `.ps1` Parser + BOM 复查

范围：`git ls-files '*.ps1'`（父仓 26 个）。`tmp/` 下另有一批历史探针脚本（如 `tmp/provision.lf.ps1` ERR=12、
`tmp/r5-*/start-panel-*.ps1` ERR=8），是过去排查留下的**半截样本**，不在运行链上，未计入统计。

- **Parser ERRORS=0：26/26** —— 全部通过（PowerShell 5.1 解析器）。
- **BOM（`ef bb bf`）**：
  - ✅ `scripts/**` 全部 20 个：`BOM=True`，零例外（含本批新增 `scripts/tests/schtask-smoke.ps1`、`scripts/worldguard-check.ps1`）。
  - ✅ `docs/真机-20261106/T5/*.ps1` 2 个：`BOM=True`。
  - ⚠️ 4 个历史文档快照 `BOM=False`：`docs/audit/night/parse-ps1.ps1`、
    `docs/真机-20261106/T0/check-health.ps1`、`T0/start-mindserver.ps1`、`T2/start-env-r3.ps1`。
    其中后三个含中文注释 —— 在 PS 5.1 下无 BOM 读 UTF-8 会乱码（不影响 `scripts/` 运行链）。
    **归 owner 判断**：属历史归档，建议下次编辑时顺手补 BOM，或明确标注"仅归档、不执行"。

---

## 4. 真机 E2E：53/53

`powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\e2e.ps1 -Scenario all`
→ **`E2E 通过：53/53 条断言全部通过`**，exit 0。

| 场景 | 断言 | 内容 |
|---|---|---|
| claims | **10** | 起服前世界=模板 / 起服就绪 / 脚本 13 条断言全过（退出码 0、PASS=13）/ 5 条关键断言出现（A 预约成功、B 抢同一 key、B 没落行、反向对照、entity 预约不泄漏）/ 优雅停服 / 重置后=模板 |
| restart | **13** | 起服前=模板 / 首次起服 / 场地与记忆就绪 / 首次停服 / 重启起服 / 重启前状态读回 / 箱子内容完好 / 熔炉产物仍在 / 熔炉真工作过且进度自洽 / bot 记忆可读回（真实 `History.load()`）/ memory_bank 仍在 / 二次停服 / 重置后=模板 |
| chest | **30** | 起服前=模板 / 起服就绪 / 脚本 20 条断言全过 / 前置（背包 32、箱子空）/ 存 16（技能 ok、背包 -16、箱子 +16 **bot 读 + RCON 独立读**、总数守恒）/ 取 8（技能 ok、+8、-8、总数守恒、RCON 读数）/ **三条反证**（取不存在物品、满箱存、距离过远都必须是真失败且背包不变、箱子不被破坏）/ 收尾留 8 / 停服 / 重启起服 / 跨重启守恒（bot + RCON 双读）/ 二次停服 / 重置后=模板 |

> 计数口径：`grep -cE "^\s+\[(claims|restart|chest)\] PASS"` = 10 / 13 / 30，合计 **53**。

**关于"新迁移的第一个真实用户"**（任务特别提示）：claims 场景在一次性 `MC_BOTS_ROOT` 里跑通，
说明新的板库位置/表结构下 claims 读写没坏。但请连同 §6 的两条边界一起读：
E2E 用的是**全新 run 目录（没有旧板库）**，它证明的是"新库能建、能跑"，**不证明**"生产旧库搬家安全"——
后者要等生产 mindserver 下次启动才第一次发生（见 §7）。

---

## 5. 发现的问题与处理

### 5.1 🟠 真问题：E2E 会写**生产** world 目录（已复原，需 owner 修脚本）

- **现象**：验证期间 `server/world/world-id.json` 被创建（`id: w-20261112-4f1ae8ed`，
  `createdAt: 2026-11-12T15:44:27Z` = 本地 23:44:27，正是 claims 场景起服时刻）。
- **根因**：`scripts/e2e.ps1` 只隔离了 `MC_BOTS_ROOT`（303 / 350 / 477 行），**没有隔离 `MC_WORLD_DIR`**；
  claims 场景的 t37 在**父进程内** `createMindServer`，走到 `openBoard(prepareBoardDirForCurrentWorld())`
  → `currentWorldId()` → `currentWorldDir()` 默认 `<仓库>/server/world` → `worldIdOf()` 懒生成并落盘 sidecar。
- **影响**：无数据迁移、无数据丢失（`mindcraft/bots/_worlds` **不存在** ⇒ `MC_BOTS_ROOT` 隔离生效，
  旧板库没被搬进生产）。但它"跑一次验证改一次生产数据"，且把生产世界固定绑定到一个测试生成的 world_id。
- **我做的**：把内容留档到 `tmp/verify/e2e-created-world-id.json`，删除该文件，
  生产 `server/world/` 恢复为运行前状态（运行前此文件不存在）。`find server/ mindcraft/bots -newermt "2026-11-12 23:40"`
  确认**只有这一个**生产文件被碰过。
- **建议 owner 修**：`e2e.ps1` 里补 `$env:MC_WORLD_DIR = Join-Path $RunDir 'world'`（收尾时一并清 env），
  否则下一个人跑 E2E 还会写生产 —— 而且这次是"创建"，下次可能被误读成"生产本来就有"。

### 5.2 🟡 残留（不是我造成的，未动）：`mindcraft/tools/temp_board.mjs`

一行注释改动未提交：`openBoard(boardDirOf(), …)` → `openBoard(resolveExistingBoardDir(), …)`。
方向与本批"唯一反解入口"的口径一致，但**不归我提交**，留给 owner 决定（提交或回退）。

### 5.3 🟢 我已复原：`mindcraft/web-dist/MANIFEST.json`

`release.ps1 -SkipDocker` 会重写 `generatedAt`（唯一差异）。已 `git checkout` 复原，
并**重跑 `-VerifyOnly` 仍是 8/8** —— 证明提交里的清单与当前源码/产物依旧自洽，不是我掩盖了漂移。

### 5.4 🟢 我自己踩的假红（留档，同一类教训第 N 次）

第一版反向探针用 `openGlobalDb({path: 自建库})` 去检查 events，而 `recordEvent` 写的是 `MC_BOTS_ROOT` 默认路径
⇒ 我检查的是**另一个空库**，于是得出"events 能被 update/delete"的**假红**（`count=0`、`updErr=null`）。
修成默认路径 + 加一句"我打开的库就是 recordEvent 写的那个库"的断言后，12/12。
**教训**：检查器和被测对象必须指向同一个对象；否则红绿都不可信（与 t5 那条"假绿"是同一枚硬币的两面）。

---

## 6. 只到单测 / 未接线的项（诚实边界，按内容归属分）

| 项 | 状态 | 证据 |
|---|---|---|
| `team:*`、`inventory:*` 七个事件 | ✅ **已接生产** | `mindserver.js:1257 attachBoardServer(...)`；`board_server.js` 里 6 个 team + 7 个 inventory handler；`board_client.js` 有对应 13 个方法；`flow_store.js:109/127` 调 `inventoryCacheRefresh` / `inventoryMarkDirty`（`composite_registry`、`commands/actions` 引用 flow_store） |
| `_global` events / relations（`global_store.js`） | ❌ **只在单测里活** | 唯一 import 者是 `federation.js`；`src/` 里没有第二个引用者 ⇒ 生产进程不会写一条事件 |
| `federation.js`（凭证/名片/关系增量/CoreProtect） | ❌ **完全未接线** | `grep -rn "federation.js" src/` 除自身零命中 ⇒ 阶段 4 四个能力当前**不可达**，E2E 也不可能覆盖。t6 文档 §8 的"接线清单 6 条"仍未落地 |
| 库存四张表在真机上写对没写对 | ⚠️ 无真机证据 | E2E 的 chest 场景走 `flow_store.store/fetch`（同一路径会刷新缓存），但**没有断言** `container_cache`/`inventory_ledger` 行；这是设计意图（缓存失败不影响搬运），代价是"真机上账对不对"只能等接线后验 |
| `chest_withdraw_race_unit` | ⚠️ 运行期 SKIP | 缺测试服；基线同样 SKIP，非本批回归 |
| `team_wg_crosscheck` | ⚠️ 只报 SKIP | 区域草案 19 处占位符未填 + WorldGuard 未安装 ⇒ 三态里的"配置未就绪"。不假成功，这条设计是对的 |
| 生产旧板库搬家 | ⚠️ **还没在真生产跑过** | `mindcraft/bots/_board/board.sqlite` 仍在旧位置、`bots/_worlds` 不存在 ⇒ 迁移在下次 mindserver 启动时才第一次执行。反向 ③ 证明的是迁移**函数**幂等，不是"生产那份数据搬得安全" |
| D12（组队需双方同意） | ⚠️ 未闭合 | `team:join` 仍自助加入；t3 已写明 |

---

## 7. 工作区残留（进程 / 端口 / 临时目录 / 文件）

| 类别 | 状态 |
|---|---|
| java / node 进程 | ✅ 无（`tasklist` 无 java、无残留 node） |
| 端口 25566 / 25576 / 18093 / 18090 | ✅ 无监听 |
| `tmp/e2e/**` 运行目录 | ✅ 已由 e2e.ps1 自动清理（目录空） |
| 探针临时目录 `%TEMP%\reverse-probe-*` | ✅ 0 个（探针自删） |
| 父仓 git 工作区 | ✅ 干净 |
| mindcraft 仓库 | 🟡 仅 `M tools/temp_board.mjs`（§5.2，非我所改） |
| 生产 `server/world/` | ✅ 恢复运行前状态（§5.1） |
| 我留下的证据文件 | `tmp/verify/`（gitignore）：`reverse_probe.mjs`、`check_oversell.sh`、`oversell.log`、`e2e_all.log`、`ps1_tracked_check.log`、`e2e-created-world-id.json` |

---

## 8. 复跑命令（照抄可用）

```bash
# 单测 + 门禁（mindcraft 是独立 git 仓库）
cd mindcraft && npm test && npm run gate && node tools/preflight.mjs

# 前端
cd web && npx vue-tsc --noEmit && npm run build

# 发布链（只需 PowerShell 5.1）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\release.ps1 -SkipDocker
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\release.ps1 -VerifyOnly

# 父仓回归 + .ps1 体检
node scripts/tests/ops-regression.mjs

# 真机 E2E（唯一需要 JDK 的项；会写生产 world 目录，见 §5.1）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\e2e.ps1 -Scenario all

# 反向验证（只读探针 + 变异复原，退出码 0 才算过）
node tmp/verify/reverse_probe.mjs
bash tmp/verify/check_oversell.sh
```
