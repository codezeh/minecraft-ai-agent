# 终审 R3②：依赖与门禁面（F-DEP-003/004/005/012/103 + F-REG-001 + 全线回归）

审查对象：`mindcraft` 分支 `audit/night-20261106`（相对 `main` 22 提交），**HEAD 实测**（`bdba2e6`，比 02:45 的 NIGHT-REPORT 更远）。
方法：`node` 直跑 / 副本篡改 / `git show` 取历史字节 / **exit code 一律 `> f 2>&1; echo $?`（无管道）**。
**未改 `mindcraft/` 任何文件**（`git status` 为空）。实验产物落在 `docs/audit/probes/run/t30/`。

---

## 1. 判定总表

| Finding | 报告原判 | **HEAD 实测判定** | 关键证据 | 三态 |
|---|---|---|---|---|
| **F-DEP-003** 补丁零生效 | 被 F-DEP-004 打穿（只做到事后发现） | **数据层已修好（版本对齐）；应用状态未验证** | `mineflayer+4.39.0.patch` 已替换 `+4.33.0.patch`（后者不存在，新补丁注释自述"重建自 4.33.0.patch hunk 1"）；实装版本 **4.39.0** 与文件名一致；`patch_integrity` 版本漂移检查 5/5 通过。**但** `node_modules` 时间戳 10-24 ≪ 补丁 11-06，`grep incorrect_for_wooden_tool` = **0** ⇒ 本机**未应用** | 已实测（内容缺席）+ 静态确证（机制） |
| **F-DEP-004** 完整性闸 | 曾被打穿，后"四修" | **闸本身有效（4 场景全过），但未接进 `npm run gate`** | 控制组 EXIT=0；①改 1 字节 → EXIT=1 并点名哈希；②删 SHA256SUMS → EXIT=1；③删补丁 → EXIT=1；④`--write` 无环境变量 → EXIT=1 拒绝 | **已实测** |
| **F-DEP-005** `npm ci` 替换 | 已改 | **已修好（但被 F-DEP-103 抽掉地基）** | `reinstall` = `clean:modules && npm ci`；`start.bat:91-97` `call npm ci` + `if errorlevel 1 → exit /b 1`（**失败即中止**） | 已实测（读码 + npm ci 行为验证） |
| **F-DEP-012** clean 不删 lock | 已改 | **已修好** | `clean:modules` 只 `rmSync('node_modules')`，**不碰** `package-lock.json` | 静态确证 |
| **F-DEP-103** lock 未入库 | blocked（未解决） | **仍未解决，且它使 F-DEP-005 在全新 clone 上失效** | `.gitignore:4` 忽略 `package-lock.json`；`git ls-files` = **未追踪**；本地存在（286KB）。实测无 lock 目录跑 `npm ci` → `EXIT=1 / EUSAGE: The 'npm ci' command can only install with an existing package-lock.json` | **已实测** |
| **F-REG-001** token 提示 | 已修（9e7253c） | **已修好** | `start.bat:123-125` 改为 `Read it from: mindcraft\.mindserver-token`；`mindserver_proxy.js:46` 从 `process.env.MINDSERVER_TOKEN` 取 | 静态确证 |
| **F-REG-002** | high | **≡ F-DEP-103（同一缺陷两个编号）**，未修 | 同上 | 已实测 |
| **F-REG-003** 半截提交即全断 | medium | **成立（设计使然）** | `start.bat:99` 启动时跑 `patch_integrity`；哈希不符 → 闸红 → 起不来 | 静态确证 |
| **F-REG-004** start.bat 无调用方 | low | **成立但不算缺陷** | 全仓引用只在 4 份文档里，无 `.ps1/.bat/.js` 调用点 —— 它是**人手动双击**的入口，无调用方是设计 | 静态确证 |
| **（新）CRLF 变异测试永久红** | 报告未载 | **gate:full 因此永久 EXIT=1；且该缺陷早于本分支** | `craft_diagnostic_reachability_unit.mjs` `14 PASS / 1 FAIL`；`:104` 硬编码 CRLF，`flow_craft.js` 实测 **CRLF=0 / LF=382**；**24f9d6b 当时也是 LF** ⇒ 从未通过 | **已实测** |

---

## 2. A. `F-DEP-003`：补丁到底有没有生效

### 2.1 文件关系：**替换，不是并存**

```
patches/
  SHA256SUMS                            468 B
  mineflayer+4.39.0.patch              1585 B   ← 当前唯一 mineflayer 补丁
  mineflayer-pathfinder+2.4.5.patch   12412 B
  mineflayer-pvp+1.3.2.patch            665 B
  prismarine-viewer+1.33.0.patch        666 B
  protodef+1.19.0.patch                 890 B
  minecraft-data+3.97.0.patch.disabled  529 B   ← `.disabled`，不参与校验也不被套用
```

`mineflayer+4.33.0.patch` **已不存在**。新补丁自己的注释写着：
> `+    // 本地改动（重建自 patches/mineflayer+4.33.0.patch hunk 1）：`

⇒ **替换**（把旧版本号的补丁按 4.39.0 重建），不是并存。

### 2.2 版本匹配：**已对齐**（这就是 F-DEP-003 的根因所在）

```
实装: node -e require('./node_modules/mineflayer/package.json').version  →  4.39.0
补丁: mineflayer+4.39.0.patch                        →  4.39.0   ✔ 一致
```
`patch-package` 按「`<pkg>+<version>.patch` 的 version == 实装 version」决定是否套用。**旧名 4.33.0 vs 实装 4.39.0 时永远不匹配 ⇒ 补丁零生效**，这就是 F-DEP-003 的机制。现在名字对上了。

`patch_integrity` 的第 ② 项（版本漂移）在 HEAD 上 **5/5 通过**，等于把这条从"没人知道"变成"硬失败"。

### 2.3 应用状态：**本机未应用，且无人验证过**

```
$ grep -c "incorrect_for_wooden_tool" node_modules/mineflayer/lib/plugins/digging.js
0
$ sed -n '244,247p' node_modules/mineflayer/lib/plugins/digging.js
      enchantments = enchantments.concat(helmetEnchantments)
    }

    const creative = bot.game.gameMode === 'creative'
```
补丁要插的 6 行（`if (block.material === 'incorrect_for_wooden_tool') block.material = 'mineable/pickaxe'`）**不在里面** —— 从 `}` 直接跳到 `const creative`。

时间戳给出解释：
```
node_modules/mineflayer/lib/plugins/digging.js   2026-10-24 17:16
patches/mineflayer+4.39.0.patch                  2026-11-06 01:58
```
`node_modules` 比补丁**早 13 天**。而同一份 `node_modules` 里 pathfinder 补丁**是**应用的（`grep -c lavaType` = 1）⇒ 说明这套 node_modules 是用**当时那套补丁**装出来的，之后补丁改名/重建，**没有重装**。

**结论（三层，别混）**：
1. **根因（版本号错配）已修** —— 文件名与实装版本现在一致，`npm ci` 时 `postinstall` 会套用；`patch_integrity` 版本检查能守住不再漂移。→ **数据层已修好**
2. **应用状态未验证** —— HEAD 的 `node_modules` 里没有这段代码。要证明"真的生效"，必须在可写目录跑一次 `npm ci`（本机 node_modules 属主时间早于补丁，重装会动 `mindcraft/`，**本次未做**）。
3. **闸只能发现"补丁文件被改"，发现不了"补丁没被应用"** —— 这是 F-DEP-004 的边界（见 B 节）。

---

## 3. B. `F-DEP-004`：完整性闸三场景 + 控制组（**验收硬要求**）

工具：`tools/patch_integrity.mjs`（9.2 KB）。机制：
- ① 逐个 patch 算 `sha256` ↔ `patches/SHA256SUMS`
- ② 文件名里的版本 == `node_modules/<pkg>/package.json` 实装版本（**直接针对 F-DEP-003**）
- `--write` 需 `PATCH_INTEGRITY_ALLOW_WRITE=1`（防止"篡改完顺手重建基线"）

测试方法：`--root <dir>` 建副本（含 `patches/` 与 5 个 `node_modules/<pkg>/package.json` 版本桩），**exit code 用 `> f 2>&1; echo $?`，全程无管道**。

| 场景 | 命令 | 真实退出码 | 输出 |
|---|---|---|---|
| **对照（未篡改）** | `node tools/patch_integrity.mjs --root run/t30/A` | **0** | `✓ patch_integrity 通过` |
| **① 改一个字节** | 对 `mineflayer+4.39.0.patch` 追加 1 字节后跑 | **1** | `✗ mineflayer+4.39.0.patch 内容被改动（基线 c2372a4c84a6… 现为 736082fa0585…）` |
| **② 删 SHA256SUMS** | `rm patches/SHA256SUMS` | **1** | `✗ SHA256SUMS 不存在 —— 先跑一次 --write 并提交` |
| **③ 删补丁文件** | `rm patches/protodef+1.19.0.patch` | **1** | `✗ protodef+1.19.0.patch 在 SHA256SUMS 里但文件已不存在` |
| **④ `--write` 无环境变量** | `node … --write` | **1** | `✗ 拒绝 --write：需要先设 PATCH_INTEGRITY_ALLOW_WRITE=1` |

**对照组 EXIT=0 很关键**：它证明这套探针不是"永远报错"，四个 FAIL 都指向真实篡改点。

### 3.1 但：**它没有接进 `npm run gate`**

```
"gate": "node tools/settings_check.mjs && node tools/preflight_regex_unit.mjs && node tools/preflight.mjs && node tools/lint_hard.mjs"
```
四个组件里**没有** `patch_integrity`。工具自己的文件头明说这是刻意的：
> `注意（接线约定）：本脚本**故意不自己改 gate**。接进 npm run gate 由人来做…要先修数据再接判据`

**它接在了哪里**：`start.bat:99` —— 启动时跑一次。
⇒ 所以现状是「**提交时不检查、启动时检查**」。后果正是 F-REG-003 说的：一次半截提交 → 启动即红 → **整台机器起不来**（不是降级，是全断）。

**对"只做到事后能发现"这句话的修正**：它连"事后"都不自动 —— 要人手动 `node tools/patch_integrity.mjs`。启动时那道是**运行期**兜底，不是提交期闸门。**判定：闸有效，但接线位置选在了"最痛的地方"（启动），而不是"最该的地方"（commit）。**

---

## 4. C. `F-DEP-005` / `F-DEP-012`

### 4.1 脚本现状（已修）

```
"reinstall":      "npm run clean:modules && npm ci"        ← npm ci，不是 npm install ✔
"clean:modules":  node -e "...['node_modules'].forEach(... rmSync recursive ...)"  ← 只删 node_modules ✔
"postinstall":    "patch-package"                          ← 补丁在这条链路里
```
`clean:modules` 的目标数组只有 `['node_modules']`，**不碰 `package-lock.json`** ⇒ F-DEP-012 **已修好**。

### 4.2 `start.bat` 失败路径（**验收硬要求**）

```bat
:88  if not exist "%ROOT%mindcraft\node_modules" (
:89      echo [WARN] mindcraft\node_modules missing. Running npm ci first (strict, per lock) ...
:91      call npm ci
:92      if errorlevel 1 (
:93          echo [ERROR] npm ci failed - do NOT use --ignore-scripts, it silently drops patches/.
:94          echo [ERROR] Fix the node_modules / package-lock.json mismatch, then run this file again.
:96          popd
:97          pause
:98          exit /b 1
```
**判定：失败即中止（fail-closed）✔**。而且错误文案准确指出"不要用 `--ignore-scripts`，那会静默丢掉 patches/"——这句话是对的（`postinstall: patch-package` 就是靠 scripts 跑的）。

**实测 npm ci 的失败行为**（我用副本造了"有 package.json、无 lock"的目录）：
```
$ cd run/t30/nolock && npm ci > out.txt 2>&1 ; echo $?
EXIT=1
npm error code EUSAGE
npm error The `npm ci` command can only install with an existing package-lock.json
```
⇒ `start.bat` 的 `if errorlevel 1` 分支**真的会走到**，且会 `exit /b 1` 中止。

（未做的一层：我没有真的双击跑 `.bat` —— 那需要 `cmd.exe` 起批处理，本沙箱 `spawn` EPERM。但上面两段合起来已经闭合了判据：**npm ci 无 lock 必失败** + **bat 对失败必中止**。）

---

## 5. D. `F-DEP-103`：它是什么、为什么卡住别人

**它是什么**：`mindcraft/package-lock.json` **从未进过 git**。
```
$ git check-ignore -v package-lock.json
.gitignore:4:package-lock.json	package-lock.json
$ git ls-files package-lock.json
(空 —— 未追踪)
$ ls -la package-lock.json
-rw-r--r-- 286159  2026-11-06 01:42        ← 本机存在
```

**为什么它卡住别人**：`npm ci` 的**硬性前提**就是有 lock（实测 `EUSAGE`，见 §4.2）。于是：
- **本机**：lock 在 → `npm ci` 正常 → `reinstall` / `start.bat` 都工作
- **任何全新 clone**：没有 lock → `npm ci` 直接 EUSAGE → `start.bat` 在 `:92` 中止 → **应用根本起不来**

⇒ **F-DEP-005（改成 `npm ci`）这个修复，在全新 clone 上是无效的**——它把"用 `npm install` 能装上（虽然不严格）"换成了"用 `npm ci` 装不上（严格但没料）"。这就是报告说的"卡住 D1 三条的落脚点"，我复核**属实**。

**现状：仍未解决**，且报告的处理是**有理由的主动延后**（NIGHT-REPORT:246）：
> 「今晚不擅自把 lock 入库 —— 如果 lock 与 package.json 不同步，`npm ci` 会失败」

这个理由**成立**（提交一份过期的 lock 会让所有人都装不上），但代价是**仓库不可从零部署**。两条路必须选一条，不能一直挂着。

**注意：`F-REG-002` 与本条是同一个缺陷的两个编号**（NIGHT-REPORT:240 的 F-REG-002 描述与 F-DEP-103 完全同因）。**建议合并为一个号**，否则同一件事会被追两次、也可能被"另一次已修"误判为已解决。

---

## 6. E. `F-REG-001`~`004` 现状

| 编号 | 内容 | 现状 | 判定 |
|---|---|---|---|
| **F-REG-001** | token 不再打印后，两处提示还在教人"去启动日志找 token" | **已修**：`start.bat:123-125` 改为 `Read it from: mindcraft\.mindserver-token`；`mindserver_proxy.js:46` 从 `process.env.MINDSERVER_TOKEN` 读 | ✔ 真修好 |
| **F-REG-002** | lock 从未进 git | **未修**，且 ≡ F-DEP-103 | ✘ 见 §5 |
| **F-REG-003** | 完整性闸要求哈希严格相等 → 任何半截提交让整机起不来 | **成立（设计使然）**：`start.bat:99` 启动即校验 | ⚠ 风险已声明，未改 |
| **F-REG-004** | `start.bat` 全仓无调用方；面板链缺 node_modules 时不说缺什么 | **仍然无调用方**（只在文档里出现）—— 但它是**人手动双击**的入口，无调用方是**设计**不是缺陷；"面板链缺 node_modules 不说清"这点未核实 | ✔ 不算缺陷（low） |

---

## 7. F. 回归成绩单（6 项，逐项结论）

| # | 项目 | 命令 | 结果 | 判定 |
|---|---|---|---|---|
| 1 | 沙箱逃逸 | `node probes/t19-ses-escape-review.mjs` | **EXIT=0**，`BLOCKED=20 / ESCAPED=0` | **通过** |
| 2 | 板库重建 | `node probes/t20-board-open.mjs schema` | **EXIT=0**，`rebuilt=false`、`行数 前=1 后=1`、无 `.corrupt-` | **通过** |
| 3 | 门禁 0x08 | `grep -c $'\x08' tools/preflight.mjs` | **0** | **通过** |
| 4 | board 全套 | 18 个 `tools/board_*_unit.mjs` 逐个直跑 | **通过 18 / 失败 0** | **通过** |
| 5 | skills 守护 | `skills_attack_guard_unit` / `skills_fakesuccess_unit` / `step_runner_unit` | 三个均 **EXIT=0** | **通过** |
| 6 | 门禁自身 | `npm run gate > f 2>&1; echo $?`（**无管道**） | **EXIT=1** —— 唯一红项是 preflight `[6/6]`「扫描器自测没跑起来」（`status=null`）；四个组件逐个跑：`settings_check` **0**、`preflight_regex_unit` **0**、`lint_hard` **1（✗ 起不来：EPERM，fail-closed）** | **本沙箱 EPERM 红，非代码红**（见下） |

### 7.1 关于第 6 项：必须分清"环境红"与"代码红"

- **本沙箱**：`preflight [6/6]` 的自测要 spawn 子进程 → **EPERM**（`status=null`）→ preflight 打红 → `npm run gate` EXIT=1。`lint_hard` 同理（`✗ 起不来：EPERM`，但**退出码 1 是 fail-closed**，不是假绿）。
- **队长在正常宿主跑**：四件全绿（settings_check / regex_unit / preflight / lint_hard）。**与本沙箱差异只在 spawn 权限**。
- ⇒ 结论：**门禁代码本身没有回退**；本沙箱的两处红是**已知 EPERM 盲区**（规程 §6），不构成回归。

### 7.2 但 `gate:full` 有一条**真红**（队长线索，我已独立复核）

```
$ node tools/craft_diagnostic_reachability_unit.mjs > f 2>&1; echo $?
EXIT=1
14 PASS / 1 FAIL / 0 XFAIL / 0 XPASS
FAIL ①-反向验证：把 NO_ITEM 预检写回去 → 守卫报红（① 会立刻红） mutant first=false second=false
```

**根因（我独立复核，与队长结论一致）**：
- `tools/craft_diagnostic_reachability_unit.mjs:104` `const NL = String.fromCharCode(13, 10);`（**CRLF**）
- `src/agent/library/flow_craft.js` 实测 **`CRLF=0 / LF=382`**（纯 LF）
- 锚点 `needTable = true;` 仍在（`grep -c` = 1）⇒ 不是锚点漂移，是**换行符不匹配**：`FLOW_SRC.replace('        needTable = true;' + CRLF + '    }', …)` 匹配不到 → 变异没插入 → `guard(reintroduced)` 两路都 false → 测试红。
- 同文件 `:103` 的注释写「★ 关键：src/ 是 CRLF」——**方向记反了**，代码是照这条错注释写的。

**我额外查清的两件事（超出队长给的线索）**：
1. **不是本轮打坏的**：`git diff --stat main..HEAD -- src/agent/library/flow_craft.js` = **空**（本轮没碰这文件）；`git show main:…flow_craft.js` 也是 **CRLF=0 / LF=382**；测试文件 `main` 上已存在（提交 `24f9d6b`，2026-11-05）。
2. **它从来没绿过**：我导出 `git show 24f9d6b:src/agent/library/flow_craft.js` 量了换行符 → **CRLF=0 / LF=322**。所以那条 `①-反向验证` 在提交当时也不可能通过。**commit message 里的「15/15」不准确**（真实是 14/15）。

**严重性判断（我的独立结论，不顺着说）**：
- **它使 `gate:full` 永久 EXIT=1**。`gate:full` = `npm run gate && node tools/unit_all.mjs`，所以 `unit_all` 一跑就红。
- **但它不挡提交**：`.githooks/pre-commit` 跑的是 `npm run gate`（**不含** `unit_all`），所以 pre-commit 是绿的、提交正常。
- **它守的那条保护目前等于没有**：`①` 要守"`flow_craft` 里不许把 `NO_ITEM` 预检写回来"（t132 那族反复复发）。现在这条测试**永远红**，所以真有人把预检写回来时，**不会出现任何新信号**——红还是那个红。
- **不判 BLOCK 的理由**：①基线即红（早于本分支），不是本轮引入；②运行时代码干净；③commit 门是绿的。**把它算作本轮 BLOCK 会让任何一轮都无法通过。**
- **但必须立刻修（2 行）**，否则 `gate:full` 这块招牌等于不存在，维护者会习惯性 `SKIP_GATE=1` —— **那时整道门才真的失效**。

**最小修复**：`:104` 改成按文件实际换行符推导，例如
`const NL = FLOW_SRC.includes('\r\n') ? '\r\n' : '\n';`（或直接 `'\n'`，因为全仓 src 已是 LF）。
**修完怎么验**：`node tools/craft_diagnostic_reachability_unit.mjs > f 2>&1; echo $?` → 应 `EXIT=0`、`15 PASS / 0 FAIL`；再确认 `mutant first=true || second=true`。

### 7.3 队长问的第 3 类：这类硬编码换行符还有多少

```
$ grep -rn "fromCharCode(13" tools/
tools/craft_diagnostic_reachability_unit.mjs:104     ← 仅此一处
```
⇒ `fromCharCode(13` 这个写法**只有这一处**，不是普遍模式。
另查了 `grep -rln '\r\n' tools/*.mjs`（8+ 文件命中），抽检 `act_craft_limit_unit` / `agent_failed_reply_unit`：命中的都是 **JS 字符串里的 `\n`**（如 `'return (function (want, recipe, cap) {\n'`），**不是 CRLF 锚点**。
**结论：这类"硬编码换行符做锚点"的写法目前只有 1 处，已定位；不存在"普遍写法"**。今晚"第 3 次栽在换行上"是**单点复发**，不是系统性缺陷——但这一处是**注释把方向写反**导致的，值得记一笔。

---

## 8. 结论

**`PASS`（可合并），附 2 条必须跟进的项 —— 均非本轮引入。**

### 8.1 为什么 PASS
1. **六项回归无回退**：沙箱 20/0、板库 `rebuilt=false` 行数不丢、0x08 = 0、board **18/18**、skills 守护 **3/3**。
2. **`F-DEP-004` 的闸经我 5 个场景实测（含对照组）确认有效**：改字节/删基线/删补丁/绕 `--write` 全部 exit=1。
3. **`F-DEP-005`/`012` 真修好了**：`npm ci` + `clean` 不删 lock + `start.bat` 失败即中止（fail-closed，且错误文案准确）。
4. **`F-REG-001` 已修**（token 提示改指 `.mindserver-token`）。
5. **两条红都不是本轮造成的**：`gate` 在本沙箱的红是 EPERM；`gate:full` 的 CRLF 红早于本分支（`24f9d6b` 时 `flow_craft.js` 已是 LF）。

### 8.2 必须跟进的 2 项（都不挡本轮合并，但都要给号）
| # | 项 | 为什么必须修 | 最小修复 |
|---|---|---|---|
| **M1** | `craft_diagnostic_reachability_unit.mjs:104` 硬编码 CRLF（`:103` 注释方向写反） | `gate:full` **永久 EXIT=1** → 维护者会习惯性 `SKIP_GATE=1` → 整道门失效；且它守的 t132 族保护**目前零信号** | `const NL = FLOW_SRC.includes('\r\n') ? '\r\n' : '\n';`（2 行） |
| **M2** | `F-DEP-103` ≡ `F-REG-002`：`package-lock.json` 未入库 | **全新 clone 上 `npm ci` 必失败（实测 EUSAGE）** → `start.bat` 在 `:92` 中止 → 应用无法从零部署；即 `F-DEP-005` 的修复在 clone 场景**无效** | 二选一：①把 lock 与 `package.json` 同步后一起入库（并加 `npm ci --dry-run` 校验同步）；②`.gitignore` 保留但 `start.bat` 在缺 lock 时降级为 `npm install` 并显著告警。**不建议继续挂着** |

### 8.3 一条给报告的更正
`F-DEP-003` 的定性应从"被 F-DEP-004 打穿"改为：**根因（文件名版本错配）已修好且有闸守着；但"补丁是否真的套进了 node_modules"这一跳，HEAD 上无人验证过，而 `patch_integrity` 按设计也查不到这一跳**（它只比对补丁文件哈希与版本号，不比对 node_modules 内容）。要闭合最后这一跳，需要在可写环境跑一次 `npm ci` 后断言 `grep -c incorrect_for_wooden_tool node_modules/…/digging.js == 1`。

---

## 9. 本轮盲区（照规程声明）

1. **`npm ci` 全量重装未做**（会动 `mindcraft/node_modules`，规程禁止改 `mindcraft/`）→ "补丁真的套进去"这一跳只能静态推断"版本对得上、`postinstall` 会跑"。
2. **`.bat` 未真双击执行**（需 `cmd.exe` 起批处理，本沙箱 spawn EPERM）→ 失败路径靠"npm ci 无 lock 实测 EUSAGE" + "bat `:92` 分支读码"两段闭合，**未做端到端**。
3. **`npm run gate` 在本沙箱因 EPERM 红**（`[6/6]` 自测 spawn 被拒）→ 以队长正常宿主的四绿为准，我只补了组件级逐个验证。
4. **`F-REG-004` 的"面板链缺 node_modules 时不说缺什么"**未核实（属面板脚本，超出本线）。
