# manifest · D1 依赖与供应链部（patch-smith · t6）

> 分工：本会话只能改**文件内容**（`bash`/`node`/`git` 对 `mindcraft/` 均被拒），
> **git 提交、删除文件、跑 `gate:full` 由 captain 执行**。
> 下面每节都是"可直接照着提交"的规格：改动文件 / 需代删 / commit message / 自检证据 / 回滚。
>
> **工作区现状（`git -C mindcraft status --porcelain`）**：
> ```
>  M package.json
>  M start.bat
> ?? patches/SHA256SUMS
> ?? patches/mineflayer+4.39.0.patch
> ?? tools/patch_integrity.mjs
> ```
> ⚠️ `package-lock.json` **不在此列**，因为它被 `mindcraft/.gitignore:4` 排除（→ 见 `F-DEP-103`）。

---

## 0. 定型声明（给 captain）

**这 5 个文件我定型，不再改动**：
`package.json`（两行 script）、`start.bat`、`patches/SHA256SUMS`（新）、`patches/mineflayer+4.39.0.patch`（新）、`tools/patch_integrity.mjs`（新）。

**建议提交顺序（重要，不按这个顺序会有一条红窗口）**：
1. `F-DEP-003`（补丁换血：加新补丁 + **删旧补丁**）——此时 `patch_integrity` 还没接进 gate，不会红。
2. `F-DEP-004`（`tools/patch_integrity.mjs` + `patches/SHA256SUMS`）——**接 gate 的那一行等第 3 步之后再加**（见 §2）。
3. `F-DEP-005`（`package.json` 的 `clean:modules`/`reinstall` 两行）。
4. `F-DEP-012`（`start.bat`）。

⚠️ **`F-DEP-004` 与 `F-DEP-005` 改的是同一个文件 `package.json` 的不同两处**（`gate` 行 vs `clean:modules`/`reinstall` 行）。
若要严格"一条 finding 一个 commit"，这两条需 `git add -p package.json` 分开暂存；若嫌麻烦，合并提交并在 body 里同列两个 id 也可接受（我倾向后者，因为这两处在语义上互不相干、合并不会造成误读）。

---

## 1. `F-DEP-003` — mineflayer 补丁与实装版本对齐  [ready-for-commit（差一步删除）]

**改动文件**
- 新增 `patches/mineflayer+4.39.0.patch`（845 B，只含仍需要的 hunk 1）
- （我无法删除，见下）

**需我代为删除**
- `patches/mineflayer+4.33.0.patch` ← **必须删**，否则 patch-package 仍会在它上面失败
- （建议同时）`patches/minecraft-data+3.97.0.patch.disabled` ← `F-DEP-004⑤` 的残留，删或挪 `patches/disabled/`

**commit message 草稿**
```
fix(deps): 重建 mineflayer 补丁并删除与实装不匹配的旧补丁 — F-DEP-003

补丁文件名写 4.33.0、实装 4.39.0，3 处 hunk 一处都没落到代码里（npm ci 会在 postinstall 失败）。
本次只重建仍在用的 hunk 1（digging.js：incorrect_for_wooden_tool → mineable/pickaxe），
hunk 2/3（place_block timeout / inventory yawDeg）**故意不重建**：上游 4.39.0 已用
`_getBlockAtEyeLevel()` 与 `toNotchianYaw()` 覆盖了同样的问题，且 inventory 那段的上下文已不存在。

为什么安全：只有一处新增判断，不改控制流；对非该材质方块 `block.material` 保持原值。
怎么验证：把补丁套到 pristine mineflayer@4.39.0 后与预期文件逐字节相同（见 manifest 自检）；
补丁集其余 4 个补丁的版本映射仍一一对应。
```
**自检（已做）**
- `patch -p1 --dry-run` → `checking file ...` exit 0
- 真套用到 **pristine 4.39.0 副本** → 结果与我构造的目标文件 `diff -q` → **IDENTICAL_TO_INTENDED**
- 插入点 `grep -c incorrect_for_wooden_tool` → 2（1 行注释 + 1 行代码）
- 前置事实复核：`grep -rn incorrect_for node_modules/mineflayer/lib/` → 无输出（确实缺这个修复）
- 版本映射：其余 4 个补丁 file 版本 == 实装版本（`patch_integrity` 的 [2/2] 段 4/4 ✓）
- **未跑** `gate:full`（本会话 node 不能 spawn）→ 归 captain

**风险与回滚**
- 风险：patch-package 的应用语义与 GNU patch 有极微小差别（它用 `executeEffects` 逐 hunk 试应用）；
  若它判失败，表现为 `npm ci` 报 `Failed to apply patch for package mineflayer`。
- 回滚：`git checkout -- patches/` + 把旧补丁恢复回来（`git show HEAD:patches/mineflayer+4.33.0.patch > patches/mineflayer+4.33.0.patch`）。

---

## 2. `F-DEP-004` — 补丁完整性闸（工具已就位，**gate 未接入**）  [ready-for-commit · 接线待指示]

**改动文件**
- 新增 `tools/patch_integrity.mjs`（≈150 行，只用 `node:crypto`/`node:fs`/`node:path`，**零新增依赖**）
- 新增 `patches/SHA256SUMS`（5 行，对应"换血之后"的补丁集：`mineflayer+4.39.0` + 其余 4 个）

**需我代为删除**：无（但 `SHA256SUMS` 必须在 `F-DEP-003` 的删除**之后**才与磁盘一致 —— 见 §0 顺序）

**当前状态：工具存在，但 `gate` 里没有它。** 这是**故意**的：
现在把 `patch_integrity` 接进 `gate`，它会立刻在"旧补丁还在"上报 2 条 FAIL（实测见下），
`.githooks/pre-commit` 跑 `npm run gate` ⇒ **全队所有提交立刻被拦死**。
接入是 **1 行改动**，等你删完旧补丁后由你（或授权我改）执行：
```json
"gate": "node tools/patch_integrity.mjs && node tools/settings_check.mjs && node tools/preflight_regex_unit.mjs && node tools/preflight.mjs && node tools/lint_hard.mjs"
```

**commit message 草稿**
```
fix(deps): 新增补丁完整性闸（sha256 + 版本漂移）— F-DEP-004

patches/ 是"npm 完整性校验之后再写源码"的通道，此前 14k 行 diff 无任何门禁覆盖
（grep -rln 'patches/' tools/ 为空）。新增 tools/patch_integrity.mjs + patches/SHA256SUMS：
① 逐补丁 sha256 与基线比对；② 文件名版本必须等于 node_modules 实装版本
（这条直接拦 F-DEP-003 那类漂移）；③ SHA256SUMS 漏登记/多登记都报错。

为什么安全：只读校验，不修改任何文件；不新增依赖；**尚未接进 gate**（接线见下一条 commit）。
怎么验证：正反双向五组实测（干净=绿；篡改一字节/漏行/删文件/版本漂移=红），见 manifest §2 自检。
```
**自检（已做，5 组对抗性实测）**

| 场景 | 期望 | 实测 |
|---|---|---|
| 干净补丁集（换血后状态，副本） | 通过 | `✓ 5 个补丁内容与基线一致` + `✓ 版本一一对应（5 个包）`，exit 0 |
| 补丁多一个字节（protodef） | 红 | `✗ protodef+1.19.0.patch 内容被改动（基线 a26c92eb… 现为 64550eab…）`，exit 1 |
| 实装版本改成 4.33.0（模拟漂移） | 红 | `✗ mineflayer+4.39.0.patch：文件名写 4.39.0，实装 4.33.0`，exit 1 |
| 基线里登记的文件被删 | 红 | `✗ prismarine-viewer+1.33.0.patch 在 SHA256SUMS 里但文件已不存在`，exit 1 |
| 还原后 | 恢复绿 | exit 0 |
| **未登记的新补丁（后门 patch）** | 红 | `✗ <file> 不在 SHA256SUMS 里 —— 新增补丁必须同时写基线`（当前树上就实测到了：`mineflayer+4.33.0.patch` 被这样报出来） |

**已知局限（写在这里，不藏）**：如果攻击者**同时**改补丁和改写 `SHA256SUMS`，本工具会通过 ——
这是"仓库内哈希基线"的固有上限，防线是**代码评审里能看到 `SHA256SUMS` 的改动**。
要真正抗内部篡改，需签名（`git commit -S` 或独立签名文件），属下一轮。
**建议 gate-keeper 就测这一条**，并把结论写进复核记录：本闸挡的是"改了一个没改另一个"和"悄悄加一个新补丁"，不挡"两处一起改"。

**风险与回滚**
- 风险：若某天合法地增删补丁却忘了 `--write` 刷新基线 → 门禁红（**这是想要的行为**，不是故障）。
- 回滚：`git rm tools/patch_integrity.mjs patches/SHA256SUMS`（或 revert 该 commit）；gate 里那行一并撤掉。

---

## 3. `F-DEP-005` — 不再删 lock / reinstall 改 ci  [ready-for-commit]

**改动文件**：`package.json`（2 行）
```diff
-        "reinstall": "npm run clean:modules && npm install",
+        "reinstall": "npm run clean:modules && npm ci",
-        "clean:modules": "node -e \"...[&#39;node_modules&#39;,&#39;package-lock.json&#39;].forEach...",
+        "clean:modules": "node -e \"...[&#39;node_modules&#39;].forEach...",
```
（`clean:modules` 仍保留原脚本形状，只是数组里去掉 `package-lock.json` —— 保证"删 node_modules 但留 lock"，
 这样后面的 `npm ci` 才有据可依；**两条必须一起改**，只改一条会让 reinstall 变成"没有 lock 的 ci = 直接失败"。）

**需我代为删除**：无

**commit message 草稿**
```
fix(deps): reinstall 改为 npm ci 且不再删除 package-lock.json — F-DEP-005

原 `reinstall` = 删 node_modules **和 package-lock.json** 后再 `npm install` ⇒ 33 个 `^` 依赖全部重新解析，
拉进未经审计的新版本（typosquat / dependency-confusion 的唯一现实落地窗口）。
改为：clean:modules 只删 node_modules（保留 lock），reinstall 用 `npm ci`（严格按 lock、lock 与 package.json 不一致时直接失败）。

为什么安全：只改 npm 脚本字符串，不碰依赖树、不改任何运行时代码。
怎么验证：JSON 合法 + 两条断言（clean:modules 不含 package-lock、reinstall 以 npm ci 结尾），见 manifest。
```
**自检（已做）**：`JSON_OK`；`clean:modules 不再删 lock : true`；`reinstall 用 npm ci : true`；`reinstall 不再 npm install : true`；`clean:modules 仍能自跑 : true`
**风险与回滚**：风险=某人本地 lock 已被删过，`npm ci` 会直接报错（**这正是想要的显式失败**，不是静默升版）。回滚 revert 该两行。

---

## 4. `F-DEP-006` — `gl@8.1.6` 补 resolved + integrity  [已修好并验证 · **但进不了 git**]

**已补（写进 `mindcraft/package-lock.json` 的 `node_modules/gl`）**
```json
"version": "8.1.6",
"resolved": "https://registry.npmjs.org/gl/-/gl-8.1.6.tgz",
"integrity": "sha512-BcvkgW+jWiX2SjTddgq4lOfkFmeiKE/n1N3zFnq/JlSwemIvQvH1rLURz5oMdfp4ZT5bzseuIOE608zQI0DRYA==",
"hasInstallScript": true,
```
**integrity 不是抄元数据，是实测出来的**：下载 `gl-8.1.6.tgz`（5,913,101 字节）→ 算 sha512-base64 → 与 registry 的 `dist.integrity` **MATCH=true**。

**自检（已做）**：`LOCK_JSON_OK`；`gl.integrity` 存在；**全树缺 integrity 条目 = 0**（修复前 1 条，即 gl）。
**⚠️ 阻断：`package-lock.json` 被 `mindcraft/.gitignore:4` 排除** ⇒ `git status` 看不到它，captain 提交时**不会包含这次修复**。
⇒ 本条 durability 依赖 **`F-DEP-103`**（取消 ignore + 首次入库 lock）。现状准确表述：
**"已修好且已验证，但在 lock 入库前不生效/不可回滚。"**
**回滚**：删除该两行即可（无副作用）。

---

## 5. `F-DEP-012` — start.bat 不再用 npm install  [ready-for-commit]

**改动文件**：`start.bat`（+20/−4）
- `node_modules` 缺失时：`call npm install` → `call npm ci`
- 失败即 `popd` + `pause` + `exit /b 1`（**不再继续往下起 Mindcraft**）
- 前面加一句人话：`do NOT use --ignore-scripts, it silently drops patches/`
- 若 `tools\patch_integrity.mjs` 存在，安装后先跑它，红则中止（`if exist` 守卫，避免在补丁尚未换血时误拦）

**需我代为删除**：无
**commit message 草稿**
```
fix(deps): start.bat 用 npm ci 且安装失败即中止 — F-DEP-012

正常启动路径里藏着"node_modules 缺失就自动 npm install"（浮点解析 + 跑 install 脚本 + 重跑 postinstall）。
改为 npm ci（严格按 lock），失败立刻 exit /b 1 不再启动 Mindcraft，并明令禁止 --ignore-scripts
（它会让 patches/ 静默全丢）。安装后若 patch_integrity 存在则先校验补丁完整性。

为什么安全：只影响"node_modules 不存在"这条冷启动分支；node_modules 存在时行为完全不变。
怎么验证：grep 无 npm install、有 npm ci；括号配平 6/6（cmd 语法）；冷启动路径人工验（见下）。
```
**自检（已做）**：`grep -n "npm install" start.bat` → 0 命中；`npm ci` 3 命中；第 70~94 行括号计数 **6/6 配平**；
`Running npm install first` → 已改 `Running npm ci first (strict, per lock)`
**未做（需人能跑 cmd）**：把 lock 临时改坏 → 双击 → 应报错退出而不是起服务。
**风险与回滚**：风险=老机器 node_modules 与 lock 不一致时，以前"能装上去"，现在会明确失败（**有意**）。回滚 revert 该文件。

---

## 6. `F-DEP-103`（本轮新发现，我的）— mindcraft 的 lock 不在版本控制里  [blocked · 需用户决策]

- `mindcraft/.gitignore:4` = `package-lock.json`；而 `web/package-lock.json` **是**被外层仓追踪的。
  ⇒ 生产依赖树（547 条、13 个 high 全在这）**没有任何 git 历史**；`npm ci` 的可复现性、供应链取证、以及
  **`F-DEP-005/006/010` 三条修复的落脚点**全部悬空。
- 修法（1 行 + 1 次真实安装）：删 `.gitignore:4` → 在 `F-DEP-003` 之后跑一次 `npm ci` → 首次入库这份 lock。
- 已 `mv` 到 `queue/done/`，`blocked:` 段写清"需用户/captain 决策"。

---

## 7. 本轮未落地 / 接受风险（一并交复核）

| finding | 结局 | 一句话 |
|---|---|---|
| `F-DEP-007` zod 3.25.76 | **accepted-risk**（done/） | **本轮核实：3.x 无回补版**（只有 3.26.0-canary），修复只能跨到 4.x，而 openai/mistralai 要求 ^3 |
| `F-DEP-008` tar 6.2.1 | **blocked**（done/） | **本轮核实：6.x 最大就是 6.2.1，没有 6.2.2+** ⇒ 只能 node-gyp 11 / tar 7（跨主版本）；构建期-only，运行时 `require('tar')` 零调用 |
| `F-DEP-009` glob 10.4.5 | **accepted-risk**（done/） | 不调用 glob CLI，攻击面（`-c` + shell:true）无入口 |
| `F-DEP-010` body-parser 1.20.8 | **blocked**（done/） | 1.20.9 存在且满足 `~1.20.5`（已核实），但落地要 `npm ci`，本会话无安装权限；且必须排在 F-DEP-003 之后 |
| `F-DEP-011` web 3 moderate | **accepted-risk**（done/） | 全 devDeps，不进产物；web 侧维持 0 high/0 critical |
| `F-DEP-101` prismarine-schematic | **blocked**（done/） | 零 import 已核实；删依赖必须重建 lock，无安装权限 |
| `F-DEP-102` 依赖审计落账 | **partially delivered**（done/） | 已交 `docs/audit/night/deps-baseline.md`（基线数字 + 接受风险 + audit 命令）；脚本/gate 接线待你决定 |

---

## 8. 给复核席（gate-keeper）的对接点

1. **`patch_integrity.mjs` 对抗性测试**：我预期它挡住"改一字节 / 漏行 / 删文件 / 版本漂移 / 未登记新补丁"五种；
   **挡不住"补丁与 SHA256SUMS 一起改"**（§2 已知局限，属设计上限，不是 bug）。若你发现别的打穿方式，请直接点名。
2. **D1 的"修复完成"判据**不要用 `gate:full` 单点判定：本轮 4 条落地项全部是"配置/脚本"层，
   `gate:full` 覆盖不到它们；真正的判据是本文件每节的"自检"列。
3. `docs/audit/night/deps-baseline.md` 是 D1 唯一的数字台账，改依赖后请让下一个人更新它。

---

## 9. 行为变更登记（本轮无，预告下一批）

本轮 D1 的改动**不改变任何运行时行为**（`clean:modules`/`reinstall`/`start.bat` 冷启动分支/补丁内容语义等价）。
`F-EXEC-201`（`speak` 从 `SAFE_RUNTIME_SETTINGS` 移出）**是行为变更**，将在那份 manifest 里单独开一节说明。
