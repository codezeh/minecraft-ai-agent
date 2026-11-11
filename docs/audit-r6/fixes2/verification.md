# R6 全量门禁与逐条复核（t6 / gate-runner）

> 任务：t6。**只读验证**：不改产品代码。为做反向验证曾临时改动 7 个文件、**逐个按 sha256 复原并复跑**（§7 有复原证明）。
> 开工前提：t1–t5 + t8/t9 全部落地之后。
> 环境：Windows，Node v24.16.0 / npm 11.13.0，PowerShell **5.1.26100.9818**（正是 BOM 会出问题的那个版本）。
> 日期：2026-11-11。

---

## 0. 结论速览

| # | 门 | 命令 | 结果 |
|---|---|---|---|
| 1 | mindcraft 全量单测 | `npm test` | ✅ **142/142 通过，5 跳过，exit 0**（基线 134 → 142，正好 +8 个新测试文件） |
| 2 | mindcraft 门禁 | `npm run gate` | ✅ exit 0（含 `lint:hard` no-undef=0 / no-floating-promise=0） |
| 3 | 前端类型 | `cd web && npx vue-tsc --noEmit` | ✅ 0 error，exit 0 |
| 4 | 父仓离线回归 | `node scripts/tests/ops-regression.mjs` | ✅ **87 passed / 0 failed**，exit 0 |
| 5 | 脚本语法 | `Parser::ParseFile`（PS 5.1，18 个 .ps1） | ✅ **TOTAL=18 ERR=0** |
| 6 | 发布链 | `scripts/release.ps1 -VerifyOnly` | ✅ **8/8 ALL PASS**，exit 0（**对当前脏工作树**，见 §5.1） |
| 7 | 大文件 | `git status` 逐个查 >1MB | ✅ 无意外大文件（父仓 33 项 / mindcraft 65 项，与开工时一致） |
| 8 | §10.2-1 category | 反向验证 | ✅ 能红（12/13，exit 1） |
| 9 | §10.2-2 MANIFEST | 反向验证 | ✅ 能红（83 passed / 4 failed，exit 1） |
| 10 | §10.2-3 killAll | 反向验证（两层） | ✅ 能红（源码接线 2 FAILED；行为 8 FAILED） |
| 11 | §10.2-4/5 限流桶 | 反向验证 | ✅ 能红（50 passed / 3 failed，exit 1） |
| 12 | #56 行为断言 | 反向验证 | ✅ 能红（86 passed / 1 failed，exit 1） |
| 13 | web_dist 源码漂移 | 反向验证 | ✅ 能红（FAIL 产物与源码不一致，exit 1） |
| 14 | BOM / 换行 | 逐文件头字节 | ⚠️ 18 个 `scripts/**` 全有 BOM；1 个新文件无 BOM 但纯 ASCII（§5.4） |

**没有红项。** 发现 5 条**文档口径/卫生**偏差（§5），均不影响功能，也不构成本批回归；按"只报告、由 owner 修"处理，我一条都没改。

---

## 1. 全量门禁实跑

### 1.1 `npm test`（mindcraft）

```
142/142 个脚本通过，5 个跳过
```

基线 134/134 + 5 跳过 → 现在 **142/142 + 5 跳过**，`+8` 正好是本批新增的 8 个测试文件（都能在 `git status` 的 `??` 里对上）：

```
tools/control_plane_r6_unit.mjs        (t1 + t8 D 段)   53
tools/r6_task_end_unit.mjs             (t3 §10.2-3)     25
tools/r6_agent_runtime_unit.mjs        (t3)             39
tools/board_add_guard_unit.mjs         (t2 #20)
tools/board_registry_unit.mjs          (t2 #24)
tools/board_transition_guard_unit.mjs  (t2 #22)
tools/identity_claim_race_unit.mjs     (t2 #21)
tools/identity_corrupt_unit.mjs        (t2 #69)          4
```

5 个跳过仍是原来那 5 个（4 个"需要真机数据，加 --real 跑" + `chest_withdraw_race_unit` 需要测试服）。**没有新增跳过**——这点很重要：新增用例不是靠"跳过"变绿的。

失败面核查（不只看汇总行）：

```
grep -cE '^\s*❌'        → 0
grep -c 'HAS FAILURES'   → 0
```

### 1.2 `npm run gate`

exit 0。尾部：

```
启动自检通过（含函数体冒烟测试）。
  ✓ [lint:hard] no-undef = 0 · no-floating-promise = 0（扫 180 个文件）
```

### 1.3 `npx vue-tsc --noEmit`（web）

`REAL_TSC_EXIT=0`，无任何 error 行。
（第一次我把命令管道给 `tail`，`$?` 变成了 `tail` 的退出码 —— 这是假绿的经典来源，所以重跑了一次取真实退出码。）

### 1.4 `node scripts/tests/ops-regression.mjs`（父仓）

`ALL PASS: 87 passed, 0 failed`，exit 0。

### 1.5 18 个 `.ps1` 语法（PS 5.1 `Parser::ParseFile`）

```
TOTAL=18 ERR=0
```

18 = `scripts/` 下全部（含 `lib/` 3 个、`tests/` 2 个、新文件 `docker-preflight.ps1` 与 `lib/panel_guard.ps1`）。

### 1.6 `scripts/release.ps1 -VerifyOnly`

```
PASS  web-dist 结构完整（index.html + MANIFEST.json）
PASS  16 个产物文件与清单逐条一致
PASS  源码指纹 sha256:b405a172…（32 个输入文件）
PASS  产物指纹 sha256:6cc3a3f8…（16 个产物文件）
PASS  产物与 web/ 源码指纹一致
ALL PASS: 8 passed, 0 failed
VerifyOnly 完成：产物、清单、源码三方一致。
```

`generatedAt = 2026-11-11T09:08:03Z` —— 与 web.md "重建"记录的戳一致，说明 t4 的重建确实落地了。

**额外自查 #49**（start-panel 那条"被服务的必须就是被校验的"）：我直接逐文件比了 `web/dist` 与 `mindcraft/web-dist`：

```
artifacts: 16 vs 16    LISTS_IDENTICAL    DRIFT_COUNT=0
```

`mindcraft/web-dist` 比 `web/dist` 多的只有 `MANIFEST.json` + `README.md`（发布元数据，不是产物），符合 #50 的单一写者设计。

---

## 2. 逐条重跑 `docs/audit-r6/fixes2/*.md` 声称的命令

结论：**文档声称的验证数字，逐条对得上，没有编的。**

### 2.1 control.md（t1 §6 + t8 节）

| 命令 | 文档声称 | 实跑 | 结论 |
|---|---|---|---|
| `control_plane_r6_unit` | 45（§6）/ 53（t8 节） | **53** | ✅ 与 t8 节一致；§6 的 45 是 t8 加 D 段前的快照（§5.2） |
| `mindserver_gate_unit` | 49 | **49** | ✅ |
| `control_plane_guard_unit` | 73 | **73/73** | ✅ |
| `sec001_cookie_unit` | 63 | **63** | ✅ |
| `identity_binding_unit` | 80 | **80/80** | ✅ |
| `mindserver_local_only_unit` | 16 | **16/16** | ✅ |
| `vault_unit` | 24 | **24** | ✅ |
| `ops003_offline_identity_unit` | 28 | **28** | ✅ |

t1 自称"未跑全量 `npm test`（由 t6 跑）"——我跑了，见 §1.1，绿。

### 2.2 board.md（t2 §0）

| 命令 | 文档 | 实跑 |
|---|---|---|
| `board_store_unit` | 25/25 | **25/25** ✅ |
| `board_iface_unit` | 16/16 | **16/16** ✅ |
| `board_scope_unit` | 10 PASS / 0 FAIL | **10 PASS / 0 FAIL** ✅ |
| `shared_chest_merge_unit` | 13/13 | **13/13** ✅ |
| `board_open_migrate_unit` | 8/8 | **8/8** ✅ |
| `board_b3_unit` | 23/23 | **23/23** ✅ |
| `board_b4_unit` | 11/11 | **11/11** ✅ |
| `container_fix_unit` | 5/5 | **5/5** ✅ |
| `unit_all.mjs board` | 26/26 脚本 | **26/26** ✅ |
| `unit_all.mjs identity` | 5/5 脚本 | **5/5** ✅ |

另核 t2 的"无表结构变更"：`BOARD_SCHEMA_VERSION = 3`（`board_store.js:182`）—— 与文档一致，确实没动 schema。

### 2.3 agent.md（t3）

| 命令 | 文档 | 实跑 |
|---|---|---|
| `r6_task_end_unit` | 25 | **25** ✅ |
| `r6_agent_runtime_unit` | 39 | **39** ✅ |
| `runtime_survival_unit` | 64 | **64** ✅ |
| `permissions_unit` / `t4_op_signal_unit` / `agent_cancel_late_reply_unit` | 全绿 | **exit 0** ✅ |
| `unit_all.mjs` | 138/139（早期，web_dist 漂移）→ 142/142 | **142/142** ✅ |

agent.md 里那对数字（138/139 → 142/142）是**前后两轮**，不是自相矛盾：前一轮红的正是 `web_dist_manifest_unit`（web/ 源码漂移），t4 重建后修复。我实跑已是 142/142。

### 2.4 web.md（t4）

| 命令 | 文档 | 实跑 |
|---|---|---|
| `web_dist_manifest_unit` | 10/10 | **10/10** ✅ |
| `release.ps1 -VerifyOnly` | 8/8 | **8/8** ✅ |
| `vue-tsc` | 0 | **0** ✅ |

### 2.5 ops.md（t5）

| 命令 | 文档 | 实跑 | 结论 |
|---|---|---|---|
| `ops-regression.mjs` | 87（§0/§3.3） | **87** | ✅（§3 正文写 80，见 §5.3） |
| 18 个 .ps1 解析 | ERR=0 | **TOTAL=18 ERR=0** | ✅ |
| `release.ps1 -VerifyOnly` | 8/8 | **8/8** | ✅ |
| `docker-preflight.ps1` | exit 0 | **exit 0** | ✅ |
| `start-panel.ps1 -DryRun` | exit 0 | **exit 0** | ✅ |
| `harden-credentials-acl.ps1` | exit 3 / 22 条过宽 | **exit 3 / 22 条** | ✅ |
| `deny-rcon-25575-in.ps1 -Verify` | exit 0 | **exit 0** | ✅ |

小插曲：`harden-credentials-acl.ps1` 第一次我把输出管道给了 `tail`，`$?` 报 0（又是 tail 的退出码）；重跑取真实退出码才是 **3**。**这正是"假绿"最容易骗人的地方，我把它记下来是因为 t5 的 `-DryRun`/ACL 数字如果当初也是这么取的，就该被怀疑**——实测是对的。

---

## 3. 反向验证（本批重点）：我自己制造失败，确认它会红

方法统一：先把文件 `cp -p` 到 `tmp/t6-rev/` 备份并记 sha256 → 用 python 做**精确字面量替换**（每处断言 `MATCH_COUNT==1`）→ `node --check` → 跑测试 → `cp -p` 复原 → **重算 sha256 与备份比对 + 复跑确认回绿**。

### 3.1 §10.2-1（category 丢失）：撤掉 `...keep`

改动（`board_store.js` `mergeSharedChest`）：`const value = { ...keep,` → `const value = {`

```
FAIL ⑩ merge 抹掉了档案字段（ADR §10.2-1 复发） {"m":{...value 只有 pos/items/owner/at...}}
12/13 个用例通过            ← exit 1
```

**要点**：`⑩-b` 那条"老实现只写四个字段 ⇒ category 丢失"仍然是 PASS —— 它是**反证**（钉住老行为的形状），红的是**正向断言 ⑩**。这个分工是对的：撤掉修复，正向断言立刻红。

复原后：`13/13 个用例通过`，sha256 与原值一致。

### 3.2 §10.2-2（MANIFEST 双写者）：让 sync 重新写清单

改动（`tools/sync_web_dist.mjs`）：`keepNames = ['README.md','MANIFEST.json']` → `['README.md']`，并在末尾 `writeFileSync(MANIFEST, {generatedFrom,note,files})`（**这就是原缺陷的形态**）。

```
PASS R6#50 同步后 MANIFEST.json 仍在
FAIL R6#50 发布元数据 source.hash 未被抹掉（原缺陷就是这个） → undefined
FAIL R6#50 artifact.hash 未被抹掉
FAIL R6#50 generatedAt 未被重写 → undefined
FAIL R6#50 entryAssets 未被抹掉
HAS FAILURES: 83 passed, 4 failed        ← exit 1
```

注意 `同步后 MANIFEST.json 仍在` 还是 PASS —— 说明那 4 条**不是同义反复**：只"存在"不够，抹掉元数据才红。复原后 `ALL PASS: 87 passed, 0 failed`，sha256 一致。

### 3.3 §10.2-3（任务中 killAll）：两层分别验

这一条我做了**两次**，因为它的判据分两层，强度不同：

**Rev A —— 把接线退回 `this.killAll()`**（`agent.js` 的 `checkTaskDone`）：

```
FAIL ⑤ checkTaskDone 调用 applyTaskEnd（单一判据入口）
23 passed, 2 FAILED       ← exit 1
```

与 t3 记录的"2 FAILED exit=1"完全对上。

**Rev B —— 把策略本身改成"失败也关整机"**（`task_end_policy.js` 的 `DETACH_SELF` → `SHUTDOWN_ALL`）：

```
FAIL ① decideTaskEnd(teammates_missing) → detach_self   "→ shutdown_all"
FAIL ① decideTaskEnd(timeout) → detach_self             "→ shutdown_all"
FAIL ① decideTaskEnd(无 endReason 的老调用) → detach_self "→ shutdown_all"
FAIL ★ ② 缺同伙：killAll **0 次**（禁掉修复必红）        "→ killAll=1"
FAIL ★ ② 缺同伙：cleanKill 1 次，且退出码 = 4            "→ []"
FAIL ★ ② 缺同伙：日志里说清"不关整机"                     "→ undefined"
FAIL ② 返回里 detached=true（真的走到摘自己）
FAIL ★ ② 超时：killAll 0 次、cleanKill 1 次               "→ {killAll:1,cleanKill:[]}"
17 passed, 8 FAILED       ← exit 1
```

**为什么值得做 Rev B**：Rev A 红的 ⑤ 是**源码断言**（读 `agent.js` 找 `.killAll(`），它只能证明"接线改了"，不能证明"改了之后真的不关整机"。Rev B 才是真行为断言（假 agent 上数 `killAll` 调用次数）——**两者都红，说明这条既钉住了纪律也钉住了后果**。

两轮都复原，`ALL PASS: 25 passed`，sha256 一致（`agent.js`、`task_end_policy.js` 两个文件）。

### 3.4 §10.2-4/5（限流共享桶）：桶键退回"只按地址"

改动（`mindserver.js`）：`${label}@${rateSubjectOf(socket)}@${addr}` → `${label}@${addr}`（即回到"所有 agent 共用一个桶"）。

```
FAIL A3   两只 agent 落在**不同**桶  create-agent@127.0.0.1 vs create-agent@127.0.0.1
FAIL A3b  agent 与面板落在不同桶    create-agent@127.0.0.1
FAIL A3e  未绑定名字的 agent 退回**凭据指纹**
50 passed, 3 failed       ← exit 1
```

顺带确认了 `control_plane_r6_unit` 的总数确实是 **53**（50+3）。复原后 `ALL PASS: 53 passed, 0 failed`，sha256 一致。

### 3.5 #56（门禁从"文本正则"升级为行为断言）

改动（`scripts/lib/panel_guard.ps1`）：`Wait-BotSpawned` 超时末行 `return $false` → `return $true`（**原缺陷本体**）。

```
FAIL R6#44 等超时 **不再**返回成功（这条就是原缺陷本身） → true
HAS FAILURES: 86 passed, 1 failed       ← exit 1
```

这条能红很关键：它证明 `ops-regression` 那一段**不是 grep 文案**，而是真的 `dot-source` 了 `panel_guard.ps1`、喂假日志、拿返回值断言。
复原后 `ALL PASS: 87 passed, 0 failed`，sha256 一致，头字节仍是 `23 20 3d`。

### 3.6 web_dist 源码漂移

改动：给 `web/src/router.ts` 追加一行注释（真实源码漂移）。

```
FAIL 产物与源码不一致：清单记录 sha256:b405a172…，当前 web/ 源码是 sha256:578e90bd…
FAIL 命令失败（退出码 1）：… verify …MANIFEST.json …\web
exit 1
```

**这同时回答了 t5 §6.1 留下的那句话**："`-VerifyOnly` 对当前脏工作树是红的" —— 现在**不再是红的**（t4 重建后已一致，§1.6），但**漂移能力还在**：我一改源码它立刻红，说明绿不是把门关掉了。

复原后 `ALL PASS: 8 passed, 0 failed`，`router.ts` sha256 与原值一致、无残留注释（`grep 't6 reverse-verification drift marker'` 零命中）。

---

## 4. 反向验证汇总

| 验证点 | 制造失败的方式 | 红的断言 | 数字 |
|---|---|---|---|
| §10.2-1 category | 撤 `...keep` | ⑩（正向）+ ⑩-b 仍绿（反证） | 12/13，exit 1 |
| §10.2-2 MANIFEST | sync 重写清单 | source.hash / artifact.hash / generatedAt / entryAssets | 83 passed / 4 failed |
| §10.2-3 killAll（接线） | 退回 `this.killAll()` | ⑤ 源码接线 | 23 passed / 2 FAILED |
| §10.2-3 killAll（行为） | 策略改成失败也 shutdown | ①×3 + ★②×5 | 17 passed / 8 FAILED |
| §10.2-4/5 限流桶 | 桶键退回只按地址 | A3 / A3b / A3e | 50 passed / 3 failed |
| #56 行为断言 | 超时返回 `$true` | "等超时不再返回成功" | 86 passed / 1 failed |
| web_dist 漂移 | 改 `web/src/router.ts` | 产物与源码不一致 | exit 1 |

7 组全部**能红**，全部**按 sha256 复原并复跑回绿**。

---

## 5. 发现的偏差（只报告，未修改）

### 5.1 t5 的 `-VerifyOnly` 免责句已经过期（好消息）

ops.md §6.1 与 ADR §11.5 都写着"`-VerifyOnly` 对当前脏工作树是红的，合并前需重跑 `release.ps1` 重新 stamp"。

**现在实测是绿的**（8/8，§1.6），因为 t4 已经重建产物并把清单重新 stamp 了（`generatedAt=2026-11-11T09:08:03Z`）。这不是"门坏了"，§3.6 证明它照样能红。

→ 建议 owner 把那段免责句更新成"已由 t4 重建消除；合并前若再动 `web/src` 需重新 stamp"。

### 5.2 control.md §6 的 45 是旧快照

§6 写 `control_plane_r6_unit # ALL PASS: 45`，但同一文档 t8 节写 53，实跑 53。t8 的 D 段新增 8 条，§6 没回填。

→ 一般性提醒：**文档里的数字快照会随轮次腐烂**，`npm run gate` 自己也打印了这句警告。建议只在"本节实跑"处写数字，历史数字标注轮次。

### 5.3 ops.md §3 正文的 80 与 87 不一致

§0 与 §3.3 写 87，§3 正文第一句写"从 29 条扩到 80 条"。实跑 87。同一份文档两处口径不同。

→ 低危编辑项。

### 5.4 `scripts/lib/panel_guard.ps1` 没有 BOM（本轮新增文件）

头字节 `23 20 3d`（即 `# =`），**不是** `ef bb bf`。而 ops.md §0 声称"已对全部 .ps1 复位 BOM"。

**但它当前是安全的**，我逐项证过：

| 检查 | 结果 |
|---|---|
| 非 ASCII 字符数 | **0**（纯 ASCII ⇒ PS 5.1 按 ANSI 读也不会乱码） |
| PS 5.1 `Parser::ParseFile` | ERR=0 |
| 真 PowerShell `dot-source`（ops-regression 那段） | 通过，12 个 verdict 全对 |
| 真机 `start-panel.ps1 -DryRun`（它会 dot-source 这个库） | exit 0，**中文输出全部正常** |

→ **不是缺陷，是一致性缺口**。风险在未来：谁在这个文件里加一句中文（`Write-Bad "构建失败"`），PS 5.1 立刻把它读成乱码，而且**没有任何门禁会拦**。建议补 BOM，或在文件头显式写"本文件必须纯 ASCII"（它现在没有这句）。**这条我建议 owner 处理，不留给下一轮。**

### 5.5 `.bat` 是 LF 单换行（不是 CRLF）

三个 `.bat` 的 `CR=0`。`.bat` 用 LF 在 cmd.exe 上是有历史坑的（尤其 `goto :label`）。

**实测安全**：三个文件都**没有标签、没有 goto**；我用同构造的 LF-only 夹具验了它们实际用到的 `if "%RC%"=="2" ( ... )` 括号块：

```
BLOCK_ENTERED
SECOND_LINE
EXIT=2
```

→ 结论：**当前构造下无缺陷**（实证，不是推断）。但这是"恰好安全"，不是"设计上安全"。→ 归入 Nice 级别建议。

另外三个 `.bat` 是**刻意纯 ASCII**（`收紧RCON.bat` 里写着 "This layer is ASCII-only on purpose (cmd codepage safety); all Chinese text lives in the .ps1"）——这个设计是对的，值得保留。

---

## 6. BOM / 换行复查（逐文件）

规则：**含非 ASCII 的 .ps1 必须有 BOM**（PS 5.1 无 BOM 会把中文按 ANSI 读成乱码，即 R5-001 同类坑）。

### 6.1 `scripts/**` 全部 18 个（这是门禁真正会跑的那批）

```
OK  nonascii=223  CR=989  scripts/backup-world.ps1
OK  nonascii=140  CR=428  scripts/clone-all.ps1
OK  nonascii=55   CR=0    scripts/deny-rcon-25575-in.ps1
OK  nonascii=141  CR=612  scripts/e2e.ps1
OK  nonascii=73   CR=271  scripts/harden-credentials-acl.ps1
OK  nonascii=66   CR=196  scripts/install-backup-task.ps1
OK  nonascii=53   CR=216  scripts/lib/backup_config.ps1
OK  nonascii=41   CR=173  scripts/lib/rcon.ps1
OK  nonascii=156  CR=1    scripts/provision.ps1
OK  nonascii=201  CR=679  scripts/release.ps1
OK  nonascii=161  CR=699  scripts/restore-drill.ps1
OK  nonascii=188  CR=0    scripts/start-panel.ps1        ← 特别点名的这个：OK
OK  nonascii=35   CR=97   scripts/stop-panel.ps1
OK  nonascii=22   CR=114  scripts/tests/fake-rcon-server.ps1
OK  nonascii=40   CR=147  scripts/tests/rcon-regression.ps1
OK  nonascii=136  CR=522  scripts/verify-world-backup.ps1
OK  nonascii=21   CR=0    scripts/docker-preflight.ps1    ← 本轮新增
✗   nonascii=0    CR=0    scripts/lib/panel_guard.ps1     ← 本轮新增，无 BOM（纯 ASCII，见 §5.4）
```

**`start-panel.ps1` 没有退**：BOM 在（`ef bb bf`），非 ASCII 188 处，`CR=0`（LF）。t5 说的"归一 LF"在它身上是成立的。

CR 那些是 CRLF——**PS 两种都吃**，不是问题；BOM 才是问题。t5 说"复位 BOM 并归一 LF"，实测是"BOM 都复位了，换行有 CRLF 有 LF（混着）"，功能无影响。

**最强证据不是字节，是运行时**：`start-panel.ps1 -DryRun` 真跑 exit 0，输出中文完全正常（`构建并校验面板产物` / `本应启动（已短路，不会 spawn）` / `演练完成：前置检查全部通过`）。这就是 R5-001 那个坑没有复发的直接证明。

### 6.2 `docs/**` 的 .ps1（3 个无 BOM，**既有、本轮未改**）

```
NO-BOM  nonascii=1  docs/audit/night/parse-ps1.ps1
NO-BOM  nonascii=1  docs/真机-20261106/T0/check-health.ps1
NO-BOM  nonascii=0  docs/真机-20261106/T0/start-mindserver.ps1
NO-BOM  nonascii=1  docs/真机-20261106/T2/start-env-r3.ps1
OK      nonascii=23 docs/真机-20261106/T5/probe-runtime.ps1
OK      nonascii=68 docs/真机-20261106/T5/run-docker-build.ps1
```

`git status` 里这几个**都不在改动列表**（本轮没人碰），中文只出现在注释里（而且注释内容本身就是"别在这个文件里写中文字面量，会被读成乱码"这类提醒，功能字符串一律避开中文）。→ **既有状态，不属本批回归**，记录在案即可。

### 6.3 排除噪声

`tmp/` 与 `node_modules/` 下有 400+ 个 `.ps1`（含 npm 生成的 `.bin/*.ps1`，天生无 BOM），一开始把我的扫描结果淹了（`BOM_MISSING: 247`）。已按 `git ls-files` + `scripts/` 口径收紧到真正该管的 24 个文件。**统计时不要把这 247 当成缺陷。**

---

## 7. 复原证明（我改过的东西全部按字节还原）

为做反向验证临时改过 7 个文件，全部 `cp -p` 备份 + sha256 比对：

| 文件 | 复原后 sha256 | 与备份 |
|---|---|---|
| `mindcraft/src/agent/library/board_store.js` | `00598318ca59…d12b64` | ✅ 一致 |
| `mindcraft/src/agent/agent.js` | `21bffa3fab5c…7fdde21` | ✅ 一致 |
| `mindcraft/src/agent/tasks/task_end_policy.js` | `8be8cf8414c8…8844cea` | ✅ `cmp` IDENTICAL |
| `mindcraft/tools/sync_web_dist.mjs` | `61096fdaf3e8…4523d4` | ✅ 一致 |
| `mindcraft/src/mindcraft/mindserver.js` | `ea5a325fe9ed…b5ee564` | ✅ 一致 |
| `scripts/lib/panel_guard.ps1` | `5cb01226e9d5…0db2b0` | ✅ 一致（BOM 状态也一致） |
| `web/src/router.ts` | `b5d86e735b97…807169` | ✅ 一致，无残留标记 |

复原后**重跑**的绿：

| 门 | 结果 |
|---|---|
| `npm test`（全量，复原后重跑） | **142/142 + 5 跳过，exit 0**（`grep -cE '^\s*❌'` = 0，`HAS FAILURES` = 0） |
| `npm run gate`（复原后重跑） | **exit 0** |
| `ops-regression.mjs`（复原后重跑） | **87 passed / 0 failed** |
| `release.ps1 -VerifyOnly`（复原后重跑） | **8/8，exit 0** |
| `shared_chest_merge_unit` / `r6_task_end_unit` / `control_plane_r6_unit` | 13/13、25/25、53/53 |

工作区卫生：父仓 `git status` 33 项、mindcraft 65 项，**与开工时同一个数**；`git status` 范围内无 >1MB 文件。`tmp/t6-rev/` 是我留的备份目录（已被 `.gitignore` 的 `tmp/` 覆盖，不进仓）。

---

## 8. 仍是静态推断 / 未真机的（诚实边界）

**没有真机验证的**（会改本机状态或需要真服，本任务明确不做）：

| 项 | 为什么没跑 | 现有证据强度 |
|---|---|---|
| #54 计划任务冒烟（`Start-ScheduledTask` + 读 `LastTaskResult`） | 会真的注册/触发一个计划任务，改本机状态 | 代码路径 + ops-regression 断言脚本里**有** `Start-ScheduledTask`/`LastTaskResult`/`S4U`；**没有**真跑过一次 |
| #52 docker build / compose up | 本机无 docker | `docker-preflight.ps1` 实跑 exit 0（前置齐全）；镜像本身没构建过 |
| #53 e2e（起 25566/25576/18093 真服） | 会起真服务端、跑真 bot | 三端口预检/JDK≥21/junction 断言的**静态**+脚本级证据；端到端没跑过 |
| #55 ACL 收口 `-Apply` | 改本机 ACL，需所有者确认 | **只读体检实跑**：exit 3、22 条过宽 ACE（含 `config/*.json` 可写、`profiles/*.json` 可读）；**未 Apply**，22 条还在 |
| `.bat` 双击 + UAC 提权路径 | 会弹 UAC 并改防火墙 | 只验了构造（§5.5）与 `-Verify`（exit 0）；提权链没走过真机 |
| mindserver 真实 socket 行为（限流桶 / 并发闸 / 原型链键） | 需要起 mindserver + 真 socket 客户端 | 全部是**离线单测**（`control_plane_r6_unit` 53 条、`mindserver_gate_unit` 49 条、`control_plane_guard_unit` 73 条）；`-DryRun` 只到"本应启动"就短路了 |
| 前端真实浏览器交互（4 类失败帧、pending 态） | 需要真机浏览器 + 真 socket | `vue-tsc` 0 + 产物重建 + `web_dist_manifest_unit`；**没在浏览器里点过** |
| `start-panel.ps1` 完整非 DryRun 链 | 会起 server + mindserver + bot | 只跑了 `-DryRun`（前置检查全过、exit 0） |

**已真机/真进程验证的**（不是推断）：PowerShell 5.1 解析 18 个脚本、`release.ps1 -VerifyOnly`、`docker-preflight`、`deny-rcon -Verify`、ACL 只读体检、`start-panel -DryRun`、`ops-regression`（含真 PowerShell dot-source 与真跑 sync 工具）、`npm test` 142 个脚本、以及 §3 那 7 组"真失败"实验。

---

## 9. 给 captain 的结论

1. **门禁全绿，且不是假绿**：7 组反向实验都红了再复原，覆盖 ADR §10.2 的全部四条 + #56 + web_dist 漂移。这是本批最该问的问题，答案是"能红"。
2. **文档数字可对账**：control/board/agent/web/ops 五份文档声称的每一条验证命令我都重跑过，数字逐条对上（唯一差异是 §5.2/§5.3 两处**过期快照**，不影响结论）。
3. **建议 owner 处理的 1 条**：`scripts/lib/panel_guard.ps1` 无 BOM（纯 ASCII，当前安全，但未来加中文会静默乱码且无门禁拦）。**这条我按"只报告不修"处理**，需要谁去补请 captain 指派（t5/fix-ops2 最合适，是它的新增文件）。
4. **`-VerifyOnly` 的免责句可以撤了**（§5.1）：t4 重建后它已经绿，且漂移能力仍在。
5. **未真机的 8 项**都在 §8，其中 #54/#52/#53 需要起真服或 docker，#55 需要所有者同意改 ACL —— 这些不是"没做完"，是**本任务明确不碰**的边界，需要合并后另开真机验收。
