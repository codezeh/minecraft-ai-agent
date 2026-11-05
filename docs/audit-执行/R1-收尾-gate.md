# R1 收尾 · gate 篇（独立复核 captain 的三项 + S35 + 第27条）

> 执行人：gate（AgentTeams 成员）　日期：2026-11-05
> 范围：`mindcraft/` 仓库（注意：真实仓根是 `E:/我的世界ai/mindcraft`，不是外层 `E:/我的世界ai`，两者各自是独立 git 仓、分支同名）
> 原则：**不因为"是 captain 改的就免检"**。下面每条都重跑过，命令与输出照抄。

---

## 0. 结论速览

| 项 | 结论 | 关键证据 |
|---|---|---|
| R1-a `hyperbolic.js` 提示词泄露 | ✅ 通过 | 五兄弟均注释形态；新写法受 `LOG_PROMPTS==='1'` 门控；全仓 `LOG_PROMPTS` 仅 2 处引用（注释+门控），无任何地方默认置 1 |
| R1-b 两个正则 | ✅ 通过（并补证 3 类误报） | 33 码不变、正则自检 37 绿、实注入 `ZZPROBE9` 判红点名、`fail("DOUBLE")` 抓到、`result:{code:'DIED'}` 不误报 |
| 第11条 提交门禁 | ✅ 设计合理，**采纳 captain 方案**（unit_all 不挂 commit） | 见 §3.5：两条硬指标实测都能真打红；但发现一条**假绿路径**并已堵（见 §3.6） |
| S35 `NAV_ALLOWED_ACT_FUNCS` | ✅ **选"删掉"** | 见 §4：0 使用 + 3/10 名字根本不存在 + 现行规矩本来就禁止 nav→act，接线等于**放宽**守卫 |
| 第27条 文档索引 | ✅ 补 2 行 | `existsSync` 逐条验过；同时如实标注 `架构交接-夜间.md` 是历史快照 |

**另外发现并已修两处**（都属于"0 命中=通过"这一族，见 §3.6 / §5）。

---

## 1. R1-a：`src/models/hyperbolic.js`（提示词无条件进日志）

终审说 `:47` 的 `console.log('Messages:', messages)` 没注释，而五个同目录模型都注释了。

**复核点 ①：五个兄弟到底什么形态** —— `grep -n "Messages:" src/models/*.js`：

```
src/models/deepseek.js:36:            // console.log('Messages:', messages);
src/models/grok.js:37:            ///console.log('Messages:', messages);
src/models/hyperbolic.js:50:            if (process.env.LOG_PROMPTS === '1') console.log('Messages:', messages);
src/models/mercury.js:43:            // console.log('Messages:', messages);
src/models/qwen.js:35:            // console.log('Messages:', messages);
src/models/vllm.js:51:            // console.log('Messages:', messages);
```

五个兄弟确实全是注释形态（grok 是 `///` 双斜杠写歪，仍是注释）。终审描述属实。

**复核点 ②：新写法会不会泄露** —— 改成 `if (process.env.LOG_PROMPTS === '1') console.log(...)`。
关键是"有没有别的地方把 `LOG_PROMPTS` 默认打开"。全仓 grep：

```
./src/models/hyperbolic.js:49:  // …要看提示词请显式开 LOG_PROMPTS=1。
./src/models/hyperbolic.js:50:  if (process.env.LOG_PROMPTS === '1') console.log('Messages:', messages);
```

只有这两处（一处注释、一处门控）。**没有 `.env` / 无任何代码 set 它** → 默认关闭，`messages`（含玩家私聊原文 / memory / 人设）不再进 stdout 与 `logs/mindcraft-console.log`。
判据用 `=== '1'` 而非真值判断，也避免了 `LOG_PROMPTS=0` / `=false` 被当成"开"。

**复核点 ③**：上面 grep 的六行里只剩 hyperbolic 这一处"活着"，且它带门控。✅

**结论**：R1-a 通过，可提交。

---

## 2. R1-b：`tools/preflight.mjs` 两个正则

改动（`git diff`）：

```diff
-    /\bfail\(\s*'([A-Z_]+)'/g,
+    /\bfail\(\s*["']([A-Z0-9_]+)["']/g,
-    /\{\s*ok:\s*(?:true|false)[^{}]{0,300}?\bcode:\s*'([A-Z_]+)'/g,
+    /\{\s*ok:\s*(?:true|false)[^{}]{0,300}?\bcode:\s*["']([A-Z0-9_]+)["']/g,
```

原判据两个词法盲区：只认单引号、`[A-Z_]` 不含数字。

### 2.1 `node tools/preflight.mjs` → EXIT=0，§3 仍是 33 个码

```
✓ 错误码审计通过（扫到 33 个码，均已注册；CODES 共 38 个）
```
`EXIT=0`。放宽词法口径后**码数没变**（33 → 33），说明不是在"多扫出一堆东西"。

### 2.2 `node tools/preflight_regex_unit.mjs` → 37 通过 / 0 失败

```
✓ 全绿：37 通过，0 失败。
```
captain 声明加了 4 条（33 → 37），实测确认 37。新增的 4 条在 `[fail]` / `[字面量]` 两组各 2 条（含数字 1 条、双引号 1 条）。

这套自检的**方法本身是对的**：它不是抄一份正则副本去断言（那种只证明"没打错字"），而是用正则从 `preflight.mjs` 源码里**抽出 `CODE_AUDIT_REGEXES` 真身**再喂样本 —— 改回窄口径会立刻红。

### 2.3 实注入：`fail('ZZPROBE9')`（**含数字**）必须判红并点名

在 `src/agent/library/query_classify.js` 末尾临时加 `fail('ZZPROBE9');`：

```
EXIT=1
✗ 有 1 个错误码没注册：ZZPROBE9
    ZZPROBE9 ← src\agent\library\query_classify.js
```
（同时导入检查也红：`fail(): 非法 code "ZZPROBE9"`，因为 `contract.fail` 会校验 CODES。）
验完已 `cp` 回原文件，`git status --porcelain` 对它是空。

**反证旧判据会漏**：`[A-Z_]+` 只能吃到 `ZZPROBE`，下一个字符是 `9` 不是 `'` → 整条不匹配 → 修复前这里会打 ✓。所以这条注入是**有区分度**的，不是走过场。

### 2.4 同文件换双引号：`fail("DOUBLE")` 也必须抓

```
EXIT=1
✗ 有 1 个错误码没注册：DOUBLE
```
（旧判据只认单引号，同样会漏。）验完已恢复。

### 2.5 **不引入新误报** —— 我另写了一个独立探针（12 条断言全过）

我另写了一个一次性探针（`tmp/gate-r1b-probe.mjs`，`tmp/` 在 `.gitignore` 里，所以不入库；12 条断言全文抄在下面，可照抄复现）。它**不复用 captain 的测试**，同样从 `preflight.mjs` **抽真身**（`CODE_AUDIT_REGEXES` + `maskJsSource`）再喂样本：

```
== 该抓（对 fail 那条）==
PASS  fail('CODE2') 含数字  — ["CODE2"]
PASS  fail("DOUBLE") 双引号  — ["DOUBLE"]
PASS  fail('ZZPROBE9') 数字+双位

== 不该抓（误报回归）==
PASS  result: { code: 'DIED', at }        — []      ← 数据载荷，必须不抓
PASS  { ok: false, result: { code: 'DIED' }, at } — []   ← 嵌套在 result 里
PASS  failed.push({ pos, code })          — []
PASS  { code: 'DIED' } 裸载荷              — []
PASS  仍抓 { ok: false, code: 'REAL1' }
PASS  仍抓 { ok: true, code: "DQ1" }

== §3 剥注释后不误报（maskJsSource strings:false）==
PASS  行注释里的码被剥掉
PASS  块注释里的码被剥掉
PASS  strings:false 不剥字符串（字符串里的码仍算）

✓ 全部通过
```

要点：
- `result: { code: 'DIED', at }` **不被当成错误码** —— 因为收紧口径要求 `{ ok: … }` 前缀，且中间用 `[^{}]{0,300}?` **禁止跨进嵌套对象**。这正是 captain 在注释里讲的判据，实测成立。
- `\bfail\(\s*["']` 没有把 `argFail(` / `myfail(` 之类的长词误吃（`\b` + 紧跟 `(`）。

### 2.6 注释里的样本不会误报（端到端，不只是正则层）

注意：**正则单元测试里有一条"已知局限"**（`// 注释里提到 fail('GHOST') 不该被当代码` → 断言它 `includes('GHOST')`），那是在**裸正则**层面。真正跑 §3 时会先剥注释（`maskJsSource(raw2, { strings: false })`），所以端到端应该不误报。我实测了：

在 `query_classify.js` 末尾加 `// fail('ZZCOMMENT1')` 与 `const __probeC = 1; // { ok: false, code: 'ZZCOMMENT2' }`：

```
EXIT=0
✓ 错误码审计通过（扫到 33 个码，均已注册；CODES 共 38 个）
```

两种注释里的未注册码都没有被判红。✅ 验完已恢复。

### 2.7 R1-b 小结

| 复核点 | 结果 |
|---|---|
| 1. preflight EXIT=0、§3 仍 33 码 | ✅ |
| 2. 正则自检 37 全绿 | ✅ |
| 3. 注入 `fail('ZZPROBE9')` 判红点名 | ✅（且有区分度：旧判据必漏） |
| 4. `fail("DOUBLE")` 抓 / 数据载荷不误报 | ✅（另写 12 条断言独立验证） |
| 5. 注释样本不误报 | ✅（裸正则仍会命中，但 §3 已剥注释，端到端 EXIT=0） |

---

## 3. 第11条：提交门禁（`package.json` + `.githooks/*` + `tools/lint_hard.mjs`）

### 3.1 `node tools/lint_hard.mjs` → ✓ 扫 167 个文件、两项为 0

```
✓ [lint:hard] no-undef = 0 · no-floating-promise = 0（扫 167 个文件）
```

**但"0"本身不能证明什么** —— 必须先证明这两条规则**真的开着**、**真的会打红**，否则就是又一次"0 命中=通过"。检查 `eslint.config.js`：两条都在 `rules` 里且都是 `"error"`（`no-undef`、`no-floating-promise/no-floating-promise`）。再各注入一次验证。

### 3.2 反证 ①：未声明变量 → exit 1 并点名文件:行号

注入 `function __probeUndef() { return ZZUNDECLARED_VAR_9; }`：

```
EXIT=1
✗ [lint:hard] 硬指标不为 0：1 处
   …\src\agent\library\query_classify.js:130  no-undef  'ZZUNDECLARED_VAR_9' is not defined.
```
✅ 有文件、有行号、有规则名。验完已恢复。

### 3.3 反证 ②：浮空 promise → exit 1（证明这条规则不是死的）

注入 `async function __probeFloat(){return 1;} function __probeCaller(){ __probeFloat(); return 0; } __probeCaller();`：

```
EXIT=1
✗ [lint:hard] 硬指标不为 0：1 处
   …\src\agent\library\query_classify.js:131  no-floating-promise/no-floating-promise  Floating promises can lead to unexpected scheduling.
```
✅ 两条硬指标**都能真打红**，不是装饰。验完已恢复。

### 3.4 `npm run gate` → EXIT=0

（在我改完 §3.6 / §4 / §5 之后重跑仍为 0。）

### 3.5 设计判断：**unit_all 不挂 commit 是对的，我采纳，不改**

captain 的理由是"177s 挂 commit 会把人逼去 SKIP_GATE"。我按工程后果复核了一遍，认为成立，并且有独立理由：

1. **门禁的价值 = 拦住错的提交，而不是拦住所有提交。** 一道"正确但没人愿意等"的门，最后一定退化成 `--no-verify` 或 SKIP_GATE 的肌肉记忆。本仓 pre-commit 里那段注释已经写明 SKIP_GATE 存在的理由（并行任务有中间态），说明设计者清楚这个风险。
2. **反馈延迟与缺陷发现时机不匹配。** commit 是"保存意图"，push 才是"代码要离开本机"。177s 的回归测试放在"意图"阶段，收益并不比放在 push 阶段高 —— 因为中间态提交本来就允许是红的。
3. **两条硬指标已经覆盖本轮真正归零的不变量**（no-undef / no-floating-promise），而这两个正是"运行期真会炸"的那类（ReferenceError / 吞掉的 async 异常）。其余 197 条（semi / require-await / no-empty）是风格欠账，拿它们做门禁等于**把门焊死后逼人翻墙**。
4. 我确认了 `gate:full` 真的接上了 unit_all（`"gate:full": "npm run gate && node tools/unit_all.mjs"`），且 `pre-push` 调它 —— 所以"全量测试自动化"这个目标**没有丢**，只是挪到了低频关口。

**唯一保留意见**（不影响采纳）：unit_all 目前挂在 `pre-push`，但 `git push` 的频率取决于人；若某段时间长期不 push，回归就长期不跑。建议后续把 `gate:full` 也挂到 CI（或至少每日一次定时）。这属于增量建议，不是本轮缺陷。

### 3.6 我在复核中发现并修掉的一条**假绿路径**（`lint_hard.mjs`）

原实现只认 `HARD` 集合里的两个 `ruleId`：

```js
if (HARD.has(m.ruleId)) { hits.push(...); }
```

**文件语法错时，eslint 报的是 `{ fatal: true, ruleId: null }`** —— 既不在 `HARD` 里，也不会让 `scanned` 变成 0（文件仍被计入）。于是：**一个根本没被 lint 过的文件，会让硬指标看起来更"干净"**。

实测（在 `query_classify.js` 末尾注入不完整语法 `function __probeSyntax( {`）：

- 改之前：`✓ no-undef = 0 · no-floating-promise = 0（扫 167 个文件）` ← **假绿**
- 改之后：`EXIT=1` / `✗ [lint:hard] 1 个文件解析失败 —— 它们没被 lint 过，0 不等于干净` + 点名 `:131 Parsing error: Unexpected token`

这与该文件自己写的注释是同一母题（"防'扫了 0 个文件还报绿'—— 本轮母题之一就是'0 命中 = 通过'"），只是原作者只防了 `scanned===0`、没防 `fatal`。**当前仓 0 个 fatal**，所以这条只是把口子堵上，不改变任何现有判定（167 文件 / 两项 0 的重跑结果与改前一致）。

### 3.7 hook 双向验证

见 §6（与真实提交一起做）。

---

## 4. S35：`NAV_ALLOWED_ACT_FUNCS` 死配置 —— **选"删掉"**

原状（`tools/preflight.mjs:834-841`）：一个 10 个函数名的白名单，注释说"导航层唯一允许直接调的几个单格动作（02 §5 明列）"。

**为什么不选"在 §[5] 里真按它放行"** —— 三条理由，第 3 条是决定性的：

1. **它从来没被用过**：`grep -rn NAV_ALLOWED_ACT_FUNCS` 全仓只有它自己的定义 1 处。§5 的判定只读 `PREFIX_IMPORT_ALLOW`。
2. **名单本身是坏的**：10 个名字里 `climb` / `pillarUp` / `sinkInWater` 在 `src/` 里**没有任何 export**（其余 7 个都有）。一个连名字都对不上的白名单，说明它从写下那天起就没被任何人验证过 —— 把它接线，等于把三个不存在的函数写进"允许调用"的契约里。
3. **它和现行规矩方向相反**：`PREFIX_IMPORT_ALLOW.nav = ['atom','query','infra']` —— **nav 一律不许 import act**。而这个白名单若真生效，效果是"允许 nav 从 act 层挑几个函数调"，那是**放宽**现行更严的规则、而不是补上一道守卫。为了让死配置"看起来有用"去放开门禁，是本末倒置。

**删掉不改变任何判定**：实测 nav 三个文件（`nav_core` / `nav_hop` / `nav_pathfinder`）的 import 里，act 层符号 **0 个**；§5 删前删后都是 `扫 123 个文件，检查 398 条本地 import，违规 0 处`。

**留下墓碑注释**而不是直接删干净：把上面三条理由写进原位置，这样下一个人不会"觉得缺个白名单"又把它加回来。如果将来真要允许"导航层调单格动作"，正确顺序是：先改 02 §5 规范 → 再把白名单**接到 §5 判定里** → **补一条反证**（未列出的 act 符号必须被判违规）。只写一个 Set 放在旁边当装饰，不算守卫。

---

## 5. 顺手修的一处格式问题（`package.json`）

captain 加 `gate:full` 时缩进写成了 4 空格（其余 script 是 8 空格）：

```diff
-    "gate:full": "npm run gate && node tools/unit_all.mjs",
+        "gate:full": "npm run gate && node tools/unit_all.mjs",
```

JSON 合法（`node -e JSON.parse` 通过），只是与同块不一致；一并归正。

---

## 6. 第27条：文档索引补 2 行

`docs/README.md` 是"按索引读文档"的入口。`回归-runbook.md` 与 `架构交接-夜间.md` 一直躺在 `docs/` 根目录，但**索引里搜不到**（`grep -rln "回归-runbook\|架构交接-夜间" docs --include=*.md` 改前返回空）。对按索引读文档的人来说，等于不存在。

改动：
- §3 标题 `根目录里仍在用的两份` → `根目录里仍在用的文档`（该表实际已列 3 份，标题早就名不副实）；
- 新增小节"另外两份（R1 收尾 / 第27条补入索引）"，两行分别指向 `回归-runbook.md` / `架构交接-夜间.md`。

**链接目标存在性用 `existsSync` 逐条验过**（见 §7 验收输出）。同时**如实标注** `架构交接-夜间.md` 是 2026-11-02 凌晨的**历史快照**、现况以 `架构交接-总.md` 为准 —— 这正是 T05/第27条修过一次的那个坑（把快照当现况手册），不能再犯。

---

## 7. 验收数据

| 项目 | 要求 | 实测 | 结论 |
|---|---|---|---|
| `node tools/preflight.mjs` | EXIT=0 | EXIT=0；§3「扫到 33 个码」；§5「123 文件 / 398 import / 违规 0」 | ✅ |
| `node tools/preflight_regex_unit.mjs` | 全绿 | 37 通过 / 0 失败 | ✅ |
| `node tools/lint_hard.mjs` | ✓ | `no-undef = 0 · no-floating-promise = 0（扫 167 个文件）` | ✅ |
| `npm run lint:tools` | ≤ 278 | 273 ≤ 278（未抬高） | ✅ |
| `node tools/unit_all.mjs` | 93/93 + 4 跳过 | **92/93 + 4 跳过（1 红：`warehouse_build_unit`）** | ⚠️ 见 §8 |
| `npm run gate` | EXIT=0 | EXIT=0（无并发污染时）；并发期间 EXIT=1（见 §8） | ⚠️ 见 §8 |

---

## 8. ⚠️ 并发阻塞（不是我的改动造成，但会拦住提交）

跑 `unit_all` 时发现 1 红：`warehouse_build_unit (exit 1)`。单独跑它：

```
SyntaxError: The requested module './query_safe.js' does not provide an export named 'hostilesNear'
    at src/agent/library/skills.js:41
```

排查结论：**这是 skills 成员正在改的 `src/agent/library/skills.js`（第20条）的中间态**，与我本轮改的文件无关。

- `git status` 显示 `M src/agent/library/skills.js`（70 insertions / 33 deletions），本次新增了 `import { hostilesNear } from './query_safe.js';` 以及 `digReach` / `atomWaitUntil` 等 5 条 import；
- 但 `query_safe.js` **无论 HEAD 还是工作树都没有导出 `hostilesNear`**（HEAD 的 `query_safe.js` 只有 `isSafe` / `fallRisk`）。也就是说那半边的配套改动还没落地；
- 我本轮改的文件里没有一个与 `skills.js` / `query_safe.js` 有关：`hyperbolic.js`（日志门控）、`preflight.mjs`（正则 + 删死配置）、`preflight_regex_unit.mjs`（未改，captain 已改）、`lint_hard.mjs`（解析失败守卫）、`package.json`（缩进）、`docs/README.md`（索引）。

**影响**：`preflight` 的导入体检是**整树**判定的（"只导入了 106/123 个模块"），所以别人工作树里的中间态会让**我的** `npm run gate` 也红；而 `pre-commit` 跑的就是 `npm run gate` → 我的提交会被**与我无关的原因**拦住。

**处理**：等 skills 成员把 `query_safe.js` 那半边落地后重跑；不使用 `SKIP_GATE=1` 做最终提交（任务明确要求最终提交不带）。若长时间不收敛，需要 captain 决定：要么等，要么由 captain 授权在 `SKIP_GATE=1` 下提交并知会。

> 顺带记一条工程观察（不在本轮范围，供 captain 参考）：`preflight` 的"整树导入体检"与"3 人并行改同一工作树"是天然冲突的 —— 这正是 T17/T18 已经处理过的并发病灶的另一副面孔（那次是文件系统互删，这次是**共享工作树的模块图互相污染**）。若后续还要并行，值得考虑"每个成员一个 worktree"，否则任何人的中间态都会红掉所有人的门禁。

---

## 9. 边界遵守

- 未碰 `skills.js`（skills 成员）、未碰 `act_craft.js` / `board_store.js`（board 成员）；
- 未 `git add -A` / `checkout .` / `stash`；只 `git add` 具体文件名；
- 未切分支、未合并、未碰 main（分支保持 `audit/remediation-2026-11-05`）；
- 所有注入验证均已 `cp` 回原文件并用 `git status --porcelain` 确认工作树干净。
