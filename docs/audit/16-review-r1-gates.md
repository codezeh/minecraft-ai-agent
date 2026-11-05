# 终审 R1③ · 门禁与工程线（第 11/12/13/18/26/27/33/34 条 + 棘轮/豁免/并发隔离）

> 审查对象：`mindcraft` 分支 `audit/remediation-2026-11-05`，相对主支 `e1e429d` 共 20 个提交。
> 规程：`docs/audit/REVIEW-PROTOCOL.md`（三态标注 / 证据标准 / PASS 或 BLOCK 二选一）。
> 纪律：**不看提交信息说修了什么，只看是否真的生效。**
> 会话时刻 2026-11-05 21:55~22:40，Node v24.16.0 / win32。
> **未修改 `mindcraft/` 任何文件**：实验全部在 `docs/audit/probes/r1/` 的副本里做；收尾 `git status --porcelain` 为空。

## 0. 判定总表

| 条目 | 判定 | 关键证据（三态） |
|---|---|---|
| **第 26 条** 0x08 假绿灯 | **真修好** | 0x08 计数 = **0**；注入 `fail('ZZPROBE_UNREGISTERED')` 后 §3 变红并点名文件（**已实测**） |
| **第 34 条** partial load | **真修好** | 判据 `loaded === files.length`（preflight.mjs:124-129）；副本 39/123 时打印「✗ 只导入了 39/123，差 84」（**已实测**） |
| **第 11 条** 三门接线 | **部分修好（1/3）** | hooksPath 已设、hook 已跟踪且可执行、hook 失败即拦住提交（**已实测**）；但 hook 只跑 preflight，**lint 与 unit_all 仍无自动触发点**，带 `no-undef` 违规跑桩 hook 得 exit 0（**已实测**） |
| **第 18 条** UNITS 自动发现 | **真修好** | `readdirSync` 发现（unit_all.mjs:74-84）；新增 `zz_probe_fake_unit.mjs` 后 registered 97→**98** 且出现在清单（**已实测**） |
| **第 12 条** 日志 ISO 时间戳 | **真修好** | `src/infra/log_prefix.js` + `init_agent.js:11 installLogPrefix()`；单测打出真实前缀 `2026-11-05T14:02:12.988Z idem-probe`（**已实测**；4 条子进程用例红 = 沙箱 spawn EPERM，见 §3.4） |
| **第 13 条** surveyArea 默认/夹取 | **真修好** | 默认 24（skills.js:5636）+ **唯一入口硬夹 32**（terrain3d.js:273-274）；`scan_scale_unit` **5/5 PASS**，含「r=64 被硬夹到 32，比值 1.00」（**已实测**） |
| **第 33 条** goToGoal 不可中断 | **修好但无回归测试** | `interruptTimer` 每 200ms 查 `bot.interrupt_code` → `pathfinder.stop()` → `INTERRUPTED`，`finally` 清理（skills.js:1863-1888）（**静态确证**）；`grep -rln goToGoal tools/*_unit.mjs` → **0** |
| **第 27 条** 文档/闸门盯错对象 | **部分修好** | ①`DOC` 已改指 `docs/架构交接-总.md`（preflight.mjs:349）✅ ②索引已收 `架构交接-总`（4 次）但 `回归-runbook`/`架构交接-夜间` 仍 **0** 次 ③基线 12 条**全部指向存在文件**，且新增 `deadItems` 硬校验（audit_rules.mjs:136-145）（**已实测**） |
| **棘轮（第 11 条 F1）** | **机制成立；本环境不可跑** | 基线 `total=278`、`filesScanned=217`、按 10 个 ruleId 分类；脚本用 `spawnSync` → 沙箱 EPERM，打印明确错误并 **exit 1（fail-closed）**（**已实测**退出码，**仍为推断**其计数正确性） |
| **豁免表（第 11 条 F2）** | **真修好** | `--audit-exemptions` 可跑、逐条给「仍必要/保留」判定、exit 0；T19 删的 2 条理由与代码现状吻合（**已实测**） |
| **并发隔离（T15/T17/T18）** | **真修好** | 同一测试 ×2 并行 → 双 exit 0、双 25/25；6 个写 tmp 的测试 ×2 并行 → 11/12 exit 0；两路 preflight 并行 → 输出完全一致、无互毁（**已实测**） |

**统计：9 项中 6 项真修好、2 项部分修好、1 项「修好但无测试」。未发现假绿残留，未发现修出的新问题。**

---

## 1. 第 26 条：0x08 假绿灯

### 1.1 断言
`grep -c $'\x08' tools/preflight.mjs` 必须为 0，且错误码审计必须**真的会报错**。

### 1.2 实测

```
$ cd mindcraft && grep -c $'\x08' tools/preflight.mjs
0
$ grep -rlc $'\x08' tools/*.mjs src/**/*.js
（空 —— 全树无残留）
```

跑真 preflight：
```
✓ 错误码审计通过（扫到 33 个码，均已注册；CODES 共 38 个）
```

### 1.3 关键：这是真绿还是又一次假绿？—— 造一个未注册码

在副本 `docs/audit/probes/r1/t26/`（`cp -r` 自 `src/`+`tools/`+`package.json`）里注入：

```
$ tail -1 src/agent/library/query_classify.js
export function __probeFakeCode(){ return fail('ZZPROBE_UNREGISTERED'); }
$ node tools/preflight.mjs | grep -E "未注册|ZZPROBE"
  ✗ 有 1 个错误码没注册：ZZPROBE_UNREGISTERED
      ZZPROBE_UNREGISTERED ← src\agent\library\query_classify.js
```

**→ 抓到了，而且点名了文件。§3 是真绿，不是假绿。**

> 途中踩到一个自己的坑，记下来防复核时误判：第一次我用 `fail("ZZPROBE_UNREGISTERED")`（**双引号**），
> §3 仍是「✓ 通过、扫到 33 个码」。原因不是检查坏了，而是 `CODE_AUDIT_REGEXES` 第 1 条
> `/\bfail\(\s*'([A-Z_]+)'/` **只认单引号**。换成单引号后立刻报红。
> 这也说明一件事：**别用双引号写 `fail("XXX")`** —— 它能跑（contract.fail 接受字符串），但审计扫不到。

### 1.4 为什么现在不会假绿了（机制）

`preflight.mjs:310-320` 加了两道护栏，缺一不可：

| 护栏 | 拦什么 |
|---|---|
| `gotSrcFiles = requireScanned('3 错误码审计', files2.length, …)` | 一个源文件都没扫到（根目录指错） |
| `gotCodes = requireScanned('3 错误码审计', used2.size, '错误码用法（正则可能又坏了）', …)` | **扫到了文件但正则 0 命中** ← 0x08 那次的真正病灶 |

第二道是本轮的关键：它把「**扫了一堆、都合法**」和「**一个都没扫到**」分开了。
配套的单测 `tools/preflight_regex_unit.mjs` **33 通过 / 0 失败**（我直接跑过，见 §3.4）。

### 1.5 `:933` 的 `sawASection` 0x08 也处理了吗？

```
$ grep -n "SAW_A_SECTION" tools/preflight.mjs
71:const SAW_A_SECTION = /──\s*A·|\bA·策略|未发现"有早退分支但生产不提供"/;
```
这里用的是**正则字面量里的 `\b`（单词边界转义）**，不是 0x08 字节 —— 正确。
`grep -c $'\x08'` 全文 = 0 已证明没有残留的真实退格字节。

**§6 现在是真绿还是假绿？** —— **都不是：它是红的，且红得对**。见 §3.4 的区分。

---

## 2. 第 34 条：partial load 假绿

### 2.1 断言
打印「✓ 所有模块导入成功」时必须校验 `loaded === files.length`。

### 2.2 代码（静态确证）

```
preflight.mjs:118-133
// ★★★ 第34条（T02）：判据从 `failed === 0` 收紧为 `loaded === files.length`。
} else if (loaded === files.length) {
    console.log(`  ✓ 所有模块导入成功（${loaded}/${files.length}），没有未定义引用`);
} else {
    failed++;
    console.log(`  ✗ 只导入了 ${loaded}/${files.length} 个模块，差 ${short} 个 —— 不能算"导入成功"`);
```
旧判据 `failed === 0` 的漏洞（`:120` 注释）："静默跳过"既不计 failed 也不计 loaded，62/122 也能打 ✓。

### 2.3 实测（副本里制造真实的 partial load）

副本没有 `node_modules` → 84 个模块因缺包而 import 失败，天然构成 partial load：

```
$ node tools/preflight.mjs | grep -E "只导入了|所有模块导入成功"
  ✗ 只导入了 39/123 个模块，差 84 个 —— 不能算"导入成功"
     "静默跳过"不等于"导入成功"：这些模块报了非致命错，根本没加载进来。
     · task_collect.collect [ERR_MODULE_NOT_FOUND] Cannot find package 'vec3'
     · atom_move.makeMovements [ERR_MODULE_NOT_FOUND] Cannot find package 'mineflayer-pathfinder'
     · query_classify.isProtected [ERR_MODULE_NOT_FOUND] Cannot find package 'vec3'
```

**→ 变红了，且点名了没加载进来的模块。真修好。**

对照组（真树，环境完整）：
```
✓ 所有模块导入成功（123/123），没有未定义引用
```

> 注：副本的 123 与真树的 123 一致（同一批源文件），说明这个数字不是硬编码。

---

## 3. 第 26/34 条之外的两个「检查器自身」问题（区分清楚，别混为一谈）

任务特别要求区分「0x08 没修好」与「沙箱 spawn 被拦」。这两件事在本轮 preflight 输出里**同时存在**，必须分开：

### 3.1 §6 红的原因 = 沙箱 spawn EPERM（**不是** 0x08）

```
[6/6] 依赖注入审计（A 档 = 单测能测到、生产走不到的死分支）
  ✗ 扫描器自测**没跑起来**（输出里没有「扫描器自测：N passed, M failed」指纹）
     status=null  输出前 120 字=
     → **审计结果不可信**…
```
`status=null` + 输出为空 = 子进程没起来（沙箱 EPERM），不是「自测跑了但失败」。

### 3.2 自测本体是健康的（**已实测**）

```
$ node tools/preflight_regex_unit.mjs
  PASS  [§3] 反例：行注释里的 code 举例不得被计入
  PASS  [§3] 正例：真代码里的未注册码必须仍被抓到
  PASS  [§3] 正例：**字符串里**的码也必须仍被抓（剥注释 ≠ 剥字符串）
  ...
✓ 全绿：33 通过，0 失败。
EXIT=0
```
**→ §6 的红是环境的锅，不是代码的锅。** 而且它红得对：**跑不起来就判"不可信"，绝不判"干净"**。这正是本团队最看重的那种 fail-closed。

### 3.3 §7 的「测试脚本 — ← 清单解析失败」也是 spawn EPERM

```
$ node tools/unit_all.mjs --list
{ "registered": 97, "executed": 93, "skipped": 4, "units": [ … ] }
```
`--list` 本身**完全正常**。preflight 是通过 `execFileSync` 调它（preflight.mjs:1273-1281），沙箱里 EPERM → `units=null` → 打印"清单解析失败"。
**→ 假红，非缺陷。** 真树里跑 preflight 时 §7 也会是这个 `—`（同一沙箱）。

### 3.4 第 12 条单测的 4 条 FAIL 同样是 spawn EPERM

```
$ node tools/log_prefix_unit.mjs
  FAIL  子进程 stdout 带 ISO 前缀  「」
  FAIL  子进程 stderr 带 ISO 前缀（error 也装了）  「」
  FAIL  前缀后面紧接原消息（没被吃掉/改写）
  FAIL  同批次前缀单调可排序（字典序 = 时间序）  0 个前缀
  ...（其余 11 条 PASS）
合计 11 PASS / 4 FAIL
```
这 4 条的失败输出全是 `「」`（空）。原因在 `tools/log_prefix_unit.mjs:48`：`spawnSync(process.execPath, ['-e', …])` → 沙箱 EPERM → `r.stdout` 为空。
**→ 假红，非缺陷。** 剩下 11 条（含直接证据「`2026-11-05T14:02:12.988Z idem-probe`」）证明实现本身是对的。

---

## 4. 第 11 条：三门接线（**部分修好，1/3**）

### 4.1 接线是真实的（已实测）

```
$ git config --get core.hooksPath
.githooks
$ git ls-files .githooks
.githooks/pre-commit          （已跟踪）
$ ls -la .githooks/           -rwxr-xr-x  pre-commit（可执行）
$ node -e 'package.json scripts' → gate / gate:install 均存在
```

**hook 失败会不会真的拦住提交？** 在副本 `trepo2`（真 hook + 真 src/tools + hooksPath 已设）里：

```
$ git -c user.email=a@b -c user.name=a commit -m "test2" ; echo GIT_EXIT=$?
…D:\Git\usr\bin\sh.exe: *** fatal error - couldn't create signal pipe, Win32 error 5
GIT_EXIT=1
$ git log --oneline
fatal: your current branch 'master' does not have any commits yet
```
**→ 提交被拦住了（GIT_EXIT=1、一个提交都没产生）。** 这里拦住的原因是「hook 根本执行不了」——git 对"钩子跑不起来"是 **fail-closed** 的，这个性质本身很好（不会静默放过）。

**hook 的判定逻辑本体**（用 bash 直接跑，绕开 sh.exe 限制）：
```
$ bash .githooks/pre-commit
  [gate] 提交前门禁（SKIP_GATE=1 可跳过）
  ✗ preflight 失败
       ✗ 只导入了 39/123 个模块，差 84 个 —— 不能算"导入成功"
  …
  这是**有意**的拦截：本仓库要求提交前 preflight 通过。
HOOK_EXIT=1
```
**→ 逻辑正确：preflight 失败 → exit 1 → git 拒绝提交。** 且有 `SKIP_GATE=1` 显式口子（比 `--no-verify` 更可审计）。

### 4.2 但只接了一道门（**关键差距，已实测**）

hook 全文只调用两个东西（`grep -niE "lint|unit_all|eslint" .githooks/pre-commit` → 只命中注释）：

| 命令位置 | 内容 |
|---|---|
| `.githooks/pre-commit:36` | `node tools/preflight_regex_unit.mjs`（扫描器自检） |
| `.githooks/pre-commit:48` | `node tools/preflight.mjs` |
| `package.json gate` | `preflight_regex_unit && preflight`（同上） |
| `package.json test` | `preflight && unit_all`（**含 unit_all，但只能手动跑**） |
| `package.json lint:all` | `eslint src main.js && lint_ratchet`（**完全无自动触发点**） |

**隔离实验**：把 hook 里那两条 gate 命令替换成 `true`（模拟"preflight 通过"），同时在 `src` 里留一个 `no-undef` 违规：

```
$ sed -e 's#^if ! node tools/preflight_regex_unit.mjs#if ! true#' \
      -e 's#^if ! node tools/preflight.mjs#if ! true#' .githooks/pre-commit > .githooks/pre-commit-stub
$ bash .githooks/pre-commit-stub ; echo STUB_HOOK_EXIT=$?
  ✓ 门禁通过（preflight + 审计正则自检）
STUB_HOOK_EXIT=0
```
**→ 即使源码里带着 `no-undef` 违规，提交门禁照样放行。**

### 4.3 后果（具体输入 → 具体结果）

* 输入：某次提交把 `skills.js` 里的 `ok(...)` 写成未定义标识符（**正是第 10 条当初那个 bug**）；
* 结果：`preflight` 不跑 eslint → 绿；`git commit` 通过；（`npm run lint` 才会红，但没人自动跑）。
* 也就是说：**第 10 条那类"未定义变量"缺陷，提交期无任何自动拦截**。

（补充：`eslint.config.js:22` 明确 `"no-undef": "error"`，`tools/lint_tools_baseline.json` 的 `byRule.no-undef: 5` 证明 eslint 确实会报这一类 —— 检查器没问题，是**没接线**。）

### 4.4 判定

**部分修好（1/3 门）**。真实进展：从"零自动触发点"变成"preflight 自动触发"；未完成：`lint`（eslint + 棘轮）与 `unit_all`。
**最小补法（1 行）**：`.githooks/pre-commit` 在 preflight 之后加一段 `node tools/lint_ratchet.mjs`（棘轮本来就允许存量、只拦新增，适合放提交期）；`unit_all` 太慢（几分钟）不必进 hook，留在 `npm test` 即可 —— 但要在 hook 末尾那行提示里已经写了（`:61` 已有），属可接受。

---

## 5. 第 18 条：UNITS 自动发现

### 5.1 代码（静态确证）
```
tools/unit_all.mjs:74-84
const UNITS = (() => {
    const discovered = readdirSync(HERE).filter(f => f.endsWith('_unit.mjs'))
        .map(f => f.slice(0, -'_unit.mjs'.length) + '_unit').sort();
    const all = [...new Set([...discovered, ...EXTRA_OFFLINE, ...NEEDS_REAL_DATA])].filter(n => !EXCLUDE.has(n));
    return all.sort();
})();
```

### 5.2 实测：新增一个测试文件会不会被自动收录

```
$ cp -r … （副本 t26）
$ printf 'console.log("fake ok");\n' > tools/zz_probe_fake_unit.mjs
$ node tools/unit_all.mjs --list | grep -E "registered|executed|zz_probe"
  "registered": 98,          ← 基线是 97
  "executed": 94,            ← 基线是 93
    "zz_probe_fake_unit"     ← 出现了
```
**→ 自动发现生效。真修好。**

### 5.3 顺带确认的护栏（值得记一笔）
`unit_all.mjs:89` 有「登记了但文件不存在必须当场炸」的断言（避免 `execFileSync ENOENT` 被误当成"测试红了"）。
本次副本实验没有触发它（我的假文件确实存在），但代码在。

---

## 6. 第 12 条：日志 ISO 时间戳

* 实现：`src/infra/log_prefix.js`（99 行，新文件），`installLogPrefix()` 包了 `console.log/error/warn`。
* 接线：`src/process/init_agent.js:11` `installLogPrefix();` —— **在 bot 进程启动处**，位置正确（不是只在测试里装）。
* 格式：`new Date().toISOString()`（`log_prefix.js:43`），UTC 定长毫秒，字典序=时间序。

**实测**（单测直接打出来的真实前缀）：
```
PASS 重复 install 3 次后仍只有一个前缀  「2026-11-05T14:02:12.988Z idem-probe」
PASS printf %s/%d 语义保留  「bot 走了 7 格」
PASS 对象展开保留（util.inspect 形态）  「{ a: 1, b: 'x' }」
PASS console.log() 空参数 → 只有时间戳
PASS 原函数抛错时异常能冒出来（没被吞）
```
**判定：真修好**（11 条相关用例 PASS；另外 4 条子进程用例红是沙箱 spawn EPERM，见 §3.4）。
附带确认：`console.info`/`console.debug` **未**被改动（有意为之，避免污染第三方库输出）。

---

## 7. 第 13 条：surveyArea 默认 24 + 硬夹 32

### 7.1 代码（静态确证）
```
skills.js:5636   export function surveyArea(bot, radius = 24, opts = {})   ← 默认 64 → 24 ✓
terrain3d.js:273-274
    const SCAN_MAX_RADIUS = 32;
    const r = Math.min(SCAN_MAX_RADIUS, Math.max(2, Math.floor(radius)));  ← 唯一入口硬夹 ✓
map_query.js:54  const scanR = Math.min(32, Math.max(16, spanBlocks));      ← 调用方也夹 ✓
```
放在**唯一入口**（`scanSphere`）而不是每个调用方，是正确的选择（注释 `:271-272` 写明了这个理由）。

### 7.2 实测（`tools/scan_scale_unit.mjs`，计数型假 bot）
```
PASS ① r=24（surveyArea 新默认）blockAt 次数在上限内 blockAt=57777 ≤ 86666，cells=1793
PASS ② r=32（硬上限）blockAt 次数在上限内 blockAt=137065 ≤ 205598
PASS ③ ★ r=64 被硬夹到 32（与 r=32 的工作量一致） r=32 时 137065 次，r=64 时 137065 次，比值 1.00
PASS ④ 半径越大扫得越多（没有被夹成常数） r8=2109 < r16=17077 < r24=57777
PASS ⑤ surveyArea 默认半径 = 24 radius = 24
5/5 个用例通过
```
**→ 真修好。** 特别是 ③（比值 1.00）直接证明硬夹生效，④ 排除了"夹成常数"这种低级假修。

---

## 8. 第 33 条：goToGoal 可中断（**修好，但零回归测试**）

### 8.1 代码（静态确证）
```
skills.js:1863-1888
// ★★ 第33条：**硬超时 180 秒根本不是"可中断"**。玩家按 !stop 后最长还要走 3 分钟…
//   现在加第三支：每 200ms 查一次中断标志，一旦为真就停寻路并按 INTERRUPTED 结束。
new Promise((_, reject) => {
    interruptTimer = setInterval(() => {
        if (!bot.interrupt_code) return;
        try { bot.pathfinder.stop(); } catch { }
        const e = new Error('goToGoal interrupted by !stop');
        e.code = 'INTERRUPTED';
        reject(e);
    }, 200);
}),
…
} finally { clearTimeout(hardLimitTimer); clearInterval(interruptTimer); }
```
三支竞速（goto / 180s 硬上限 / 200ms 中断轮询），`INTERRUPTED` 在 `CODES` 里已注册（38 个之一）。

### 8.2 缺什么
```
$ grep -rln "goToGoal" tools/*_unit.mjs
（0 命中）
```
**→ 修复本身成立，但没有任何用例覆盖它。** 这是本轮唯一"改了没测"的条目：
将来有人在重写 `_goToGoalBody` 时删掉 `interruptTimer`，`preflight`/`unit_all` 都不会红。

**最小补法**：加一条 `tools/goToGoal_interrupt_unit.mjs`，用假 bot（`pathfinder.goto` 永不 resolve、`interrupt_code` 由测试翻转），断言 200ms 内以 `code==='INTERRUPTED'` 结束且 `clearInterval` 被调用。约 40 行。

---

## 9. 第 27 条：文档 / 闸门盯错对象

### 9.1 三小项逐个核

| 小项 | 原状 | 现状 | 判定 |
|---|---|---|---|
| ① `preflight` 的 `const DOC` | `docs/交接文档.md`（自称作废的快照） | `preflight.mjs:349` `const DOC = 'docs/架构交接-总.md';` | ✅ **已改对**（静态确证） |
| ② `docs/README.md` 是否索引 `架构交接-总.md` | grep = **0** | grep = **4** | ✅ 已收录；但 `架构交接-夜间` = **0**、`回归-runbook` = **0** → **部分** |
| ③ `audit_baseline.json` 死条目 | count=14、**9 条指向已删文件**（真实存量 5） | `count=12`、`items=12`、**12/12 全部指向存在的文件** | ✅ **数据已清** |

### 9.2 关于 ③ 的"机制"是否也补上了（这是我在 F2 里要求的那一条）

```
tools/audit_rules.mjs:136-145
const deadItems = (base.items ?? []).filter((it) => !it?.file || !existsSync(join(MC_ROOT, it.file)));
if (deadItems.length) {
    problems.push(`基线里有 ${deadItems.length} 条**死条目**（文件已不存在），棘轮被这些空名额放宽了：…`
        + ' —— 请删掉它们并同步 count');
}
```
**→ 机制补上了，而且是硬失败（`problems.push` → 门禁红），不是"提示"。** 注释 `:131-135` 还写明了原病灶（"删得越多棘轮越宽松 —— 方向正好反了"）。
另外 `:148` 起把"身份比对"从"只有总数超标才比对"改成了**无条件比对** —— 堵住了"总数不变但内容换掉"的漏网。

**判定：第 27 条 部分修好**（①② 是文档面，③ 已彻底修好；② 还剩 2 份文档没进索引）。

---

## 10. 棘轮与豁免

### 10.1 机制

| 事物 | 内容 |
|---|---|
| `tools/lint_ratchet.mjs` | 对 `tools/` 跑 eslint，**按 ruleId 分类计数** + 总数，与 `lint_tools_baseline.json` 比，**超过任一项即 exit 1**；`--update` 才收紧基线 |
| `tools/lint_tools_baseline.json` | `filesScanned=217`、`total=278`、`byRule` 10 项（no-empty 129 / require-await 128 / no-floating-promise 8 / no-undef 5 / no-constant-binary-expression 2 / no-irregular-whitespace 2 / no-constant-condition 1 / semi 1 / no-dupe-keys 1 / no-useless-escape 1） |
| 与硬门的分工 | `npm run lint` = 硬门（eslint src main.js，目标清零）；`lint:tools` = 棘轮（只要求不高于基线） |

### 10.2 实测：棘轮在本环境跑不了，但**失败方式正确**

```
$ node tools/lint_ratchet.mjs ; echo EXIT=$?
[lint:ratchet] eslint 没有输出可解析的 JSON —— 工具没跑起来
  status=null
  stderr=
EXIT=1
```
`spawnSync` 被沙箱 EPERM（`status=null`）→ 脚本走 `process.exit(1)`。
**→ fail-closed：工具没跑起来时它 exit 1，不会打"✓ 通过"。** 这点与第 26/34 条同源，值得肯定。

**但"临时引入一个 lint 违规、棘轮会不会拦"这一条，我无法实测**——棘轮靠 `spawnSync` 起 eslint，本沙箱起不来。
**三态标注：仍为推断。** 缺什么条件：宿主机权限（能 spawn）。推断依据（静态）：`:166` 起逐项 `current[key] > baseline[key]` 即计入 problems，逻辑清楚。

### 10.3 豁免表：`--audit-exemptions`（已实测，机制很好）

```
$ node tools/scan_tmp_isolation.mjs --audit-exemptions
逐条核对 EXEMPTIONS（判定用的是**同一套** classify 规则）
· tools/bench_move_actions.mjs   判定：仍必要（仍会被判为需处置）
· tools/restart_bot.mjs          判定：保留（工具判为安全，但那个标记不是目录隔离 —— 见 keepReason）
    保留依据：process.pid 出现在一段 PowerShell 进程过滤脚本里，与目录隔离无关 —— 否则就成了"用无关标记换来的假绿"
· tools/t51_triple_round.mjs     判定：仍必要
逐条核对 NON_RISK_USES
· tools/test_nav_opt.mjs  ← bots/deepseek/map [read-only]
· tools/test_path3d.mjs   ← bots/deepseek/map [read-only]
EXIT=0
```
当前 **6 条 EXEMPTIONS + 2 条 NON_RISK_USES**。

### 10.4 T19 删掉的 2 条，删对了吗？（静态确证）

`tools/scan_tmp_isolation.mjs:277-290` 写明删的是：

| 被删条目 | 理由 | 复核 |
|---|---|---|
| `tools/preflight.mjs` | T18（`e540515`）已改成 `mkdtempSync` + `MC_BOTS_ROOT` 独占，**真的已隔离**；原豁免理由引着 `rmSync(...bots/preflight_tmp)` 那句**已不存在于代码** | ✅ 我实测两路 preflight 并行无互毁（§11.3），且 `grep preflight_tmp` 只剩注释 → **删对了** |
| `tools/t51_firstnight_realagent.mjs` | 当初被扫到是因为 `on('data', …)` 的 `'data'` 被当成目录（假阳性，T19 已修）；修完它不再有固定共享目录 | ✅ 理由自洽（它确实只写单个 `tmp-t59-agent.log`，不属于"目录"判据）→ **删对了** |

且豁免表有**防僵尸**设计：结尾断言"清单里每一条都还在"，避免豁免表变成永远为真的空话。

---

## 11. 测试基建的并发隔离（T15/T17/T18）

方法：因为 `unit_all` 内部 `execFileSync` 在沙箱被拦（§3.3），改用**shell 并行起多路 node** 直接跑同一批测试 —— 这比跑 `unit_all` 更严格（`unit_all` 是串行的，根本不会并发）。

### 11.1 同一测试 × 2 并行（同一 cwd）
```
$ ( node …/board_store_unit.mjs > a.log ) & ( node …/board_store_unit.mjs > b.log ) & wait
A_EXIT=0   B_EXIT=0
--- A 末尾 ---  25/25 个用例通过
--- B 末尾 ---  25/25 个用例通过
```
→ 两路都满分，没有互删 fixture。

### 11.2 6 个会写 tmp 的测试 × 2 并行
```
board_store_unit         stream1 FAIL=0  stream2 FAIL=0
terrain3d_unit           stream1 FAIL=0  stream2 FAIL=0
task_pickup_unit         stream1 FAIL=0  stream2 FAIL=0
board_b3_unit            stream1 FAIL=0  stream2 FAIL=0
scaffold_tracker_unit    stream1 FAIL=0  stream2 FAIL=0
flow_mine_pickup_unit    stream1 FAIL=0  stream2 FAIL=0
（12 路里 11 路 exit=0；flow_mine_pickup 两路都 exit=1）
```
`flow_mine_pickup_unit` 两路**完全一致地** exit=1，原因是它用 **cwd 相对路径** `readFileSync('src/agent/library/flow_mine.js')`（我在审计⑩ F5 记过这类写法），而我用的 cwd 是探针目录 → `ENOENT`。
**→ 与并发无关（两路同因同果，可复现），不是互毁。** 顺带说明：这类"cwd 相对读源码"的写法在 `tools/` 里还有若干处（`act_craft_limit_unit:110`、`board_b4_unit:166`、`craft_diagnostic_reachability_unit:26` 等），**只要 cwd 不是 `mindcraft/` 就会红**。

### 11.3 两路 preflight 并行（T18 的原始病灶）
```
$ ( node tools/preflight.mjs > pf1.log ) & ( node tools/preflight.mjs > pf2.log ) & wait
PF1_EXIT=1  PF2_EXIT=1
pf1: ✓ 所有模块导入成功（123/123）  ✓ 错误码审计通过（扫到 33 个码）  启动自检失败：1 处有问题
pf2: ✓ 所有模块导入成功（123/123）  ✓ 错误码审计通过（扫到 33 个码）  启动自检失败：1 处有问题
```
**→ 输出逐字一致，无互毁**（两边那 1 处失败都是 §6 的 spawn EPERM，见 §3.1）。
**判定：并发隔离真修好。**

---

## 12. 假绿专项：逐条回答"现在绿了，是因为真的检查到了吗？"

| 现在的绿灯 | 是真检查到了，还是检查器坏了？ | 证据 |
|---|---|---|
| §3「✓ 错误码审计通过（扫到 33 个码）」 | **真检查到了** | 注入 `fail('ZZPROBE_UNREGISTERED')` → 立刻变红点名（§1.3）；且 `used2.size` 非 0 才打 ✓（`gotCodes` 护栏） |
| §1「✓ 所有模块导入成功（123/123）」 | **真检查到了** | 副本 partial load 39/123 → 变红点名（§2.3） |
| §6「✗ 自测没跑起来」 | **红得对**（不是假绿，是假红） | 自测本体直接跑 = 33 通过 0 失败（§3.2）；红因 `status=null`（EPERM） |
| §7「测试脚本 —」 | **假红** | `unit_all --list` 直接跑正常输出 97/93/4（§3.3） |
| 第 12 条单测「11 PASS」 | **真检查到了** | 4 条红的全是子进程用例、输出为空（§3.4） |
| 第 13 条「5/5 PASS」 | **真检查到了** | ④ 断言"半径越大扫得越多"排除"夹成常数"；③ 比值 1.00（§7.2） |
| 第 18 条 registered 97 | **真检查到了** | 加一个假文件 → 98 且名单里出现它（§5.2） |
| 棘轮「跑不了 → exit 1」 | **fail-closed，正确** | `status=null` → 明确报错 + exit 1（§10.2） |
| **提交门禁「✓ 门禁通过」** | ⚠️ **只证明了 preflight 过了，没证明 lint 过了** | 桩 hook + `no-undef` 违规 → exit 0（§4.2） |

最后一行是本轮**唯一残留的"绿得名不副实"**：hook 打的「✓ 门禁通过（preflight + 审计正则自检）」措辞其实准确（它没说自己查 lint），但容易让人以为"三道门都过了"。

---

## 13. 本轮无法实测的（三态标注必填）

| 项 | 三态 | 缺什么 |
|---|---|---|
| 「故意 lint 违规 → `git commit` 被拦」 | **仍为推断** | 本机 `sh.exe` 无法创建管道（`couldn't create signal pipe, Win32 error 5`），任何 hook 都执行不了 → git 直接 fail-closed。**间接证据**：桩 hook 实验证明 hook 内没有 lint 逻辑（§4.2）；hook 本体 bash 直跑 exit 1 证明其决策链有效（§4.1） |
| 棘轮"引入违规是否被拦" | **仍为推断** | `lint_ratchet` 靠 `spawnSync` 起 eslint，沙箱 EPERM（实测 `status=null`、exit 1）（§10.2） |
| `unit_all` 整体跑通 | **仍为推断** | 内部 `execFileSync`（unit_all.mjs:125）被 EPERM；已用并行直跑 6 个测试替代（§11） |
| 第 33 条 goToGoal 的实际中断行为 | **静态确证** | 需真 bot + 真导航；无单测（§8.2） |

---

## 14. 建议：**PASS**（不 BLOCK）

**理由（按规程 §5 的硬门标准）：**

1. **没有假绿残留。** 本轮四道最关键的"原本假绿"的闸门（第 26/34 条 §3 与 §1、第 18 条清单、第 13 条夹取）**全部经实注入/实测证明"真的检查到了"**（§1.3 / §2.3 / §5.2 / §7.2）。
2. **没有修出新问题。** 未发现任何"检查器越修越瞎"的迹象；两个红（§6、§7）与 4 条 FAIL 均定位为沙箱 EPERM，且区分清楚（§3）。
3. **两个"部分修好"都不属于"引入回归"，属于"没做完"：**
   * 第 11 条：从「零自动触发点」进步到「preflight 自动触发」。**缺的是 lint/棘轮与 unit_all 的接线**，后果是「未定义变量类缺陷提交期不拦」——但 `npm run lint` / `npm test` 仍然可用，且仓库内**没有任何"三道门已全部接线"的虚假声明**（hook 注释 `:6` 是在描述问题，`:61` 老实写了"完整测试请跑 npm test"）。
   * 第 27 条：文档索引还剩 2 份未收录（`回归-runbook` / `架构交接-夜间`），属文档面遗漏，不影响闸门正确性。
4. **唯一"改了没测"的是第 33 条**，但它不挡门（修复本身成立，且 `INTERRUPTED` 已在 CODES 注册）。

**放行时必须附带的 3 条下一轮首要补项**（都不构成 BLOCK，但不该拖）：
1. `.githooks/pre-commit` 加一行 `node tools/lint_ratchet.mjs`（1 行，把 lint 接上；棘轮只拦新增，适合提交期）。
2. 补 `tools/goToGoal_interrupt_unit.mjs`（约 40 行），钉住第 33 条。
3. `docs/README.md` 补 `回归-runbook.md` 与 `架构交接-夜间.md` 两行索引。

**另附一条口径提醒（给复核/主编）**：`fail("XXX")` 用双引号时审计扫不到（§1.3 的坑）。建议在 `contract.fail` 或 preflight 注释里写一句"错误码字面量必须用单引号"，否则下一个人还会以为"审计通过了"。

---

## 15. 复跑方法（全部留在磁盘上）

**先建沙箱**（副本共约 10MB，不长期入库；一条命令重建）：
```bash
bash docs/audit/probes/r1/make_sandbox.sh      # 产出 r1/t26 与 r1/trepo2，并打印三类实验的现成命令
```

| 实验 | 位置 / 命令 | 预期 |
|---|---|---|
| 0x08 清零 | `cd mindcraft && grep -c $'\x08' tools/preflight.mjs` | `0` |
| §3 真检查（注入未注册码） | `cd r1/t26 && printf "\nexport function f(){return fail('ZZPROBE_UNREGISTERED');}\n" >> src/agent/library/query_classify.js && node tools/preflight.mjs` | `✗ 有 1 个错误码没注册：ZZPROBE_UNREGISTERED` |
| §1 partial load | `cd r1/t26 && node tools/preflight.mjs \| grep 只导入` | `✗ 只导入了 39/123 个模块，差 84 个` |
| 扫描器自检本体 | `cd mindcraft && node tools/preflight_regex_unit.mjs` | `✓ 全绿：33 通过，0 失败` |
| UNITS 自动发现 | `cd r1/t26 && touch tools/zz_probe_fake_unit.mjs && node tools/unit_all.mjs --list` | `registered: 98` 且名单含它 |
| hook 决策链 | `cd r1/trepo2 && bash .githooks/pre-commit` | exit 1 + 「这是**有意**的拦截」 |
| hook 不查 lint | `cd r1/trepo2`：把两条 gate 换成 `true` 后 `bash .githooks/pre-commit-stub` | **exit 0** |
| 第 13 条夹取 | `cd mindcraft && node tools/scan_scale_unit.mjs` | `5/5` 通过，含「r=64 被硬夹到 32，比值 1.00」 |
| 第 12 条 | `cd mindcraft && node tools/log_prefix_unit.mjs` | 11 PASS / 4 FAIL（4 条为 spawn EPERM） |
| 并发隔离 | 见 §11 的并行命令 | 双 25/25；两路 preflight 输出一致 |

**已留存的实际输出**：`docs/audit/probes/r1/conc/`（14 个日志：`a.log`/`b.log` 是同一测试双跑，`x_*`/`y_*` 是 6 个测试 ×2 路的逐份输出）。

---

*分册完。所有判定按规程 §3.1 标注三态；跑不了的已写明缺什么。`cd mindcraft && git status --porcelain` 为空。*
