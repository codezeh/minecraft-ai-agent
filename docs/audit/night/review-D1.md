# D1 依赖部 · 复核记录（t13）

> 复核官：gate-keeper ｜ 2026-11-06 02:1x–02:3x ｜ 对象：D1 全部 13 项（8 张有单 + 5 项无单的代码改动）
> 环境：本会话 bash/node 对 `mindcraft/` 只读、node 不能 spawn。
> **但 `npm audit` 与 `npm view`（部分）在 npm 侧可通网** —— 这是本次复核最重要的能力：
> 我因此能**独立复现审计计数**，不靠任何人转述。
> 门禁：`gate:full` 按 captain 裁决由他执行（本会话无法运行），本节不重复他侧结果。

---

## 0. 一句话结论

**通过 12 / 打回 1。**

- 打回：`F-DEP-003`（补丁本体我验过是对的，但"少一个 hunk"的理由是**事实错误**、且那个行为变化**未经决策**）。
- 通过 12 项里，有 **3 项要带 caveat**：`F-DEP-004`（部分解决，未接线）、`F-DEP-006`（改了但入不了库）、
  `F-DEP-012`（改成 `npm ci` 但**安装期脚本照跑**）。
- **一条流程缺陷必须点名**：`F-DEP-003/004/005/006/012` 五条的 **finding 文件在修补收尾时被清空**，
  `queue/inbox` 与 `queue/done` 里都不存在 ⇒ 这五条**无法按"读原始单"的规程复核**，
  我只能对着 commit + 交接摘要复核。`F-DEP-003` 的复核单已由我重建并放回 `inbox/`。

---

## 1. 任务点名的四个专项检查（先答这四个）

### ① 升级是否真把 CVE 消除了？—— **一条都没消除，而且这是设计如此，不是失误**

我实跑的权威计数（`npm audit --json --registry=https://registry.npmjs.org`）：

| 仓 | 复核时实测 | recon 基线 | 变化 |
|---|---|---|---|
| `mindcraft` | `{"moderate":15,"high":13,"critical":1,"total":29}` | 同 | **0** |
| `web` | `{"moderate":3,"high":0,"critical":0,"total":3}` | 同 | **0** |

原因：**D1 四个 commit 里没有任何依赖版本变化**（见 ②）。所以"CVE 被消除"这件事**今晚没有发生**，
也不会发生 —— 需要升版本的 4 条（`F-DEP-006/007/008/010`）分别因跨主版本/缺安装权限被 blocked 或接受风险。

⇒ **对 D1 的正确描述是：修的是"补丁零生效 + 安装期流程 + 可复现性缺口"，不是"CVE 面缩小"。**
早报若写"依赖漏洞已修复"是错的；准确写法是"依赖审计首次建立了可复现基线（29/3 条），
CVE 面本轮未缩小，4 条需升版本的已按风险分级登记"。

### ② 有没有偷偷升主版本？—— **没有。一个依赖版本都没动**

```
$ git diff 7a5e5d0^..HEAD -- package.json | grep -E "^[+-]"
-  "reinstall": "npm run clean:modules && npm install",
-  "clean:modules": "node -e \"…['node_modules','package-lock.json']…\"",
+  "reinstall": "npm run clean:modules && npm ci",
+  "clean:modules": "node -e \"…['node_modules']…\"",
```
⇒ 只有 **2 行 scripts**，`dependencies` / `devDependencies` / `overrides` **完全未变**（未新增 `overrides` 段）。
`package-lock.json` 被 `.gitignore:4` 排除（`F-DEP-103`），所以 lock 也不可能被偷改入库。

### ③ 有没有为了过门而 `npm audit fix --force`？—— **没有，且不可能有**

- 语义上：`--force` 会改 `package.json`+`lock`，而 `package.json` 的 diff 只有 2 行 scripts（上面 ②）⇒ 无痕迹。
- 结构上：lock 未入库 ⇒ 任何 lock 级改动都不会出现在 git 里。**这既是本条"没有"的证据，
  也正好暴露 `F-DEP-103` 的危害：以后真有人 `--force` 了，我们也查不出来。**

### ④ `patch-package` 相关改动有没有被顺手放宽？—— **没有，我逐项查了**

```
postinstall                     = patch-package          ← 未变
任何 script 含 ignore-scripts    = false                  ← 没有引入 --ignore-scripts
新增 .patch.disabled            = 0 个                   ← 没有把咬人的补丁"禁用"掉
patch_integrity.mjs 自 4c006bc 后改动 = 0 次              ← 闸本身没被削弱
```
反而**收紧**了：`start.bat` 里加了"不要用 `--ignore-scripts`，会静默丢掉 patches/"的显式警告，
并在失败时 `exit /b 1` 中止（从"装完继续跑"变成"装坏就停"）。

---

## 2. 四项"内容正确性"独立验证（captain 特别点名的四处）

### 2.1 `7a5e5d0` 补丁内容 —— **本体正确，但少一个 hunk（→ 打回）**

我把 pristine 的 `digging.js` 复制到独立夹具后自己套了一遍（不信修补者的 `diff -q` 说法）：

```
$ patch -p1 --dry-run < patches/mineflayer+4.39.0.patch   → DRYRUN_RC=0（干净，无 fuzz）
$ patch -p1          < patches/mineflayer+4.39.0.patch   → APPLY_RC=0
$ wc -l  原件 267 → 打后 273                              → 恰好 +6 行
$ diff   原件 打后                                        → 仅 246a247,252（6 行插入），其余零改动
```
**更强于他那个 `diff -q`**：我没有他的 pristine 副本，但我证明了"结果 = 原件 + 恰好 6 行预期插入"，
即**没有夹带任何其它修改**。

三个 hunk 的去留我逐个判：
| 原 hunk | 内容 | 处置 | 我的判定 |
|---|---|---|---|
| 1 | `incorrect_for_wooden_tool → mineable/pickaxe` | **保留重建** | ✅ 正确，且是唯一真正需要的 |
| 1 的另一半 | `bot.entity.isInWater → false` | 丢弃 | ✅ 正确：4.39.0 已换成 `['water','flowing_water'].includes(bot._getBlockAtEyeLevel()?.name)`（`digging.js:251`） |
| 2 | inventory `yawDeg/pitchDeg` | 丢弃 | ✅ 正确：4.39.0 已用 `toNotchianYaw/toNotchianPitch`；`conversions.js:17` 的 `toDegrees(PI - yaw)` 与旧补丁手算**数学等价** |
| 3 | place_block `timeout: 5000 → 500` | 丢弃 | ❌ **理由错误**（详见 `inbox/F-DEP-003.md`） |

hunk 3 的问题：修补者说"上游已用 `_getBlockAtEyeLevel` 覆盖"，但实测该函数**只存在于 digging.js**
（`grep -rn "_getBlockAtEyeLevel" node_modules/mineflayer/lib/` 只命中 digging.js:251/258），
与 place_block 的 timeout 毫无关系；而 `place_block.js:29` 的 `timeout: 5000` **仍然在**。
客观上旧 hunk 3 确实套不上了（4.39.0 重构了那段，上下文与回调签名都变了），
但"套不上"不等于"这个意图不重要"——它把"放置失败要快速失败"从 5s 压到 0.5s，
丢掉意味着每次失败多等 4.5s。**这个行为变化没人记录、没人决策，被夹在"依赖补丁重建"里静默发生。**

**另：修复尚未生效。** `grep -c incorrect_for_wooden_tool node_modules/.../digging.js` → **0 命中**；
`git apply --check` → 0（能套但没套）。**必须 `npm ci` 才生效**（captain 执行）。
所以"F-DEP-003 已修复"现在不成立，准确说法是**"补丁已就位、待重装生效"**。

### 2.2 `119f45f` start.bat 括号与 `popd` 路径 —— **全部正确**

```
$ node -e "统计 start.bat 全文括号"   → ( = 20   ) = 20   差 = 0    ✅ 配平（含 echo 里的括号）
```
三个分支的 `popd` 位置逐条看（`sed -n '69,92p' start.bat`）：

| 分支 | 序列 | 判定 |
|---|---|---|
| 外层条件 | `if not exist ...node_modules (` → `pushd` → … → `popd` → `)` | ✅ 正常路径最后 popd |
| `npm ci` 失败 | `popd` → `pause` → `exit /b 1` | ✅ **popd 在 pause 之前**（不会把 cwd 留在子目录里） |
| integrity 失败 | `popd` → `pause` → `exit /b 1` | ✅ 同上 |
| 无 `patch_integrity.mjs` | 跳过 `if exist` 块 → 走到末尾 `popd` | ✅ 仍 popd |

⇒ **括号 6/6 配平、所有分支 popd 都执行到**，captain 担心的这一点没问题。
（但**顺序**有问题：integrity 在 `npm ci` 之后、且在 `if not exist` 块内 —— 那是 `F-DEP-004` 的 D1 缺陷，见 §3。）

### 2.3 `7331ba5` clean:modules 单行脚本 —— **语法成立，语义正确，但留了段死代码**

```
$ 抽出 node -e 的 payload（200 字符）→ node --check → SYNTAX_OK     ✅
$ 语义模拟（把 fs 打桩）→ 会动到的路径: [["rmSync","node_modules"]]  ✅ 只删 node_modules
```
⇒ 数组只剩一个元素后脚本**仍然合法**，`package-lock.json` **不再被删**（这正是 `F-DEP-005` 要的）。

⚠️ 一个小瑕疵（不影响功能，记录备查）：`fs.lstatSync(f).isDirectory()` 那个分支现在**走不到**
（`node_modules` 永远是目录，`unlinkSync` 分支成死代码）。无害，但下一个人读到这里会疑惑"什么时候会是文件"。

### 2.4 四个 commit 有没有混入无关文件 —— **没有，逐个名字核过**

```
7a5e5d0  patches/mineflayer+4.33.0.patch  patches/mineflayer+4.39.0.patch   ✅ 仅补丁
4c006bc  patches/SHA256SUMS  tools/patch_integrity.mjs                        ✅ 仅闸与基线
7331ba5  package.json                                                          ✅ 仅 package.json
119f45f  start.bat                                                             ✅ 仅 start.bat
```
每条都与 commit 声称的范围一致，**零夹带**。（我是用 `git show --name-only` 独立取的，没看 captain 的摘要。）

---

## 3. 五条"无单的代码改动"复核（finding 文件已被清空）

| id | commit | 我的判定 | 关键证据 |
|---|---|---|---|
| `F-DEP-003` | `7a5e5d0` | **打回** | 见 §2.1 + `inbox/F-DEP-003.md` |
| `F-DEP-004` | `4c006bc` | **通过（按 captain 裁决 = 部分解决）** | 闸存在且正向 exit 0；我对它做过 16 用例对抗测试（`review-patch-integrity.md`）⇒ **作为漂移探测器可信、作为防篡改防线不可信**；未接线是**有意**的且已登记 |
| `F-DEP-005` | `7331ba5` | **通过** | §2.3；`npm ci` + 不删 lock 均已落地 |
| `F-DEP-006` | **无 commit** | **通过（带 caveat）** | `gl` 条目已有 `resolved`+`integrity`，全树"有 resolved 缺 integrity"= **0**（我实读 lock 核实）；**但 lock 被 `.gitignore:4` 排除 ⇒ 修复只在磁盘、换机即丢**，这是 `F-DEP-103` 的直接后果 |
| `F-DEP-012` | `119f45f` | **通过（带 caveat）** | `npm install → npm ci`、失败中止、`patch_integrity` 前置警告都已落地（§2.2）。**caveat：`npm ci` 仍然执行 lifecycle scripts**（`postinstall=patch-package` + canvas/gl/protobufjs/@google/genai）⇒ 本条标题里的"安装期脚本执行"风险**只是变确定了，没有消除**。真正消除它要靠"脚本白名单/`--ignore-scripts` + 显式 rebuild"，那是另一条单 |

---

## 4. 八张有单条目的复核（已全部 `mv done/ → verified/`）

每张都在文件尾追加了 `## review` 段（commit / 实际命令 / 关键输出 / 结论）。要点：

| id | 结论 | 我独立复现的判据 |
|---|---|---|
| `F-DEP-007` accepted-risk | 通过 | `range=<4.6.6` ⇒ **3.x 内数学上不存在修复版**（advisory 区间本身即证明，不依赖 `npm view`） |
| `F-DEP-008` blocked | 通过 | tar 12 条 via 的上界全在 7.5.x（最高 `<=7.5.20`）⇒ **6.x 全中，无 6.x 回补**；另：recon 记 8 条 via，今为 12 条，**包级计数不变** |
| `F-DEP-009` accepted-risk | 通过 | `grep require('glob')` **无输出** ⇒ 攻击面（glob CLI `-c`）不可达 |
| `F-DEP-010` blocked | 通过 | 实装仍 **1.20.8**；`range=<1.20.9`；`grep express.json\|bodyParser` **无输出** ⇒ 当前不可达 |
| `F-DEP-011` accepted-risk | 通过 | web audit `{moderate:3,high:0,critical:0,total:3}` **与声明精确吻合** |
| `F-DEP-101` blocked | 通过 | `grep prismarine-schematic src` 仅命中 `schematic.js:9` 一句注释 ⇒ 零 import |
| `F-DEP-102` partially-delivered | 通过 | `deps-baseline.md`（7934 B）存在，且其数字与我实跑 audit **一致**；"网关未接线"如实登记，定性准确 |
| `F-DEP-103` blocked | 通过 | `git check-ignore` → `.gitignore:4`；`git ls-files` 空；`web/package-lock.json` 反而被跟踪 ⇒ "两仓两 lock 两命运"成立 |

---

## 5. 复核席的三条附加意见（不阻塞 D1，但请 captain 定）

1. **`F-DEP-103` 应排到 D1 收口第一位**。它让 `F-DEP-005/006/010` 三条"修了但不算修好"
   （改的是 lock，而 lock 不入库）。不解决它，D1 的成果会随一次 `npm install` 蒸发。
2. **流程：finding 文件被清空是硬伤**。`F-DEP-003/004/005/006/012` 五条无单可读，
   我只能对 commit 复核。建议定一条规矩：**finding 文件只在 `verified/` 里被删/归档，修补者不得清空 `inbox`**。
3. **`npm view` 在我的会话里坏了**（`C:\Users\zeh\AppData\Local\npm-cache\_logs` 写入 EPERM），
   但 `npm audit` 能通网。所以**审计计数我能独立复现，单包版本清单我不能**。
   凡涉及"某版本是否存在"的结论，我一律改从 **advisory 的 `range=` 反推**（如上 007/008），
   这条口径以后可以复用：**advisory 区间比 `npm view` 更权威地证明"对端不存在修复版"**。

---

## 6. 复核动作清单（可审计）

```
读：queue/done/ 8 张单 + git show --name-only ×4 + git diff package.json + patch 内容 + lock 实读
跑：npm audit ×2（mindcraft/web，--registry=npmjs）
    patch -p1 --dry-run / patch -p1（独立夹具 docs/audit/night/tmp-rv）
    git apply --check（只读）
    node --check（抽出 clean:modules 的 payload）
    括号配平统计 / popd 分支人工核
    grep ×4（glob / bodyParser / prismarine-schematic / incorrect_for_wooden_tool）
    patch_integrity.mjs 正向（本报告 §3 引用的是更早的 16 用例对抗测试）
移：done/ → verified/ ×8（每张已追加 ## review）
写：queue/inbox/F-DEP-003.md（重建复核单，含 requiredFix）
    docs/audit/night/review-D1.md（本文件）
清理：docs/audit/night/tmp-rv/（夹具，跑完即删）
```
**未做**：`gate:full`（本会话不能 spawn，按 captain 裁决由他跑）；`npm ci`（无安装权限）；
未修改 `mindcraft/` 任何文件。

---

## 附注（2026-11-06 03:1x · 复核后登记，非改写历史）

**`7ba7b5e` 这个 commit 标题写的是 `F-DEP-004`，实际还包含 `F-DEP-003` 的补丁对**
（`patches/SHA256SUMS` + `patches/mineflayer+4.39.0.patch`），原因 captain 已说明：
`F-DEP-003` 那次 commit 被 pre-commit 拦下（钩子扫**整个工作区**而非暂存区，当时另一位正在并发改
`tasks.js`/`text.js`，那 4 处 lint 来自中间态），提交失败后文件留在暂存区，被下一次 `git commit` 一并带走。

**对本复核结论的影响：无。**
- `F-DEP-003` 的硬要求（补丁与 SUMS **必须同一 commit**）**恰好被满足了**，问题只是归属标注；
- 我在 t13 复核 `F-DEP-003` 时验的是**补丁内容**（`patch -p1 --dry-run` + 实跑 + 逐行 diff），与 commit 边界无关；
- captain 选择**如实登记、不改写历史**——我同意：我已按 sha 复核过这批，
  `rewrite` 会让整条复核链失去锚点。错误用登记纠正，比用历史重写掩盖更可信。

**给早上读报告的人**：不要把"`F-DEP-003` 没单独 commit"误读成"没修"。
`7a5e5d0` 是补丁替换本体，`7ba7b5e` 里带的是**补丁与 SUMS 的同步更新**。
