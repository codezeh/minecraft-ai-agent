# 终审 R2③ · 报告完整性：九条遗漏项现状 + lint 接线实测 + S1~S32 假话修补 + 反向覆盖核对

> 对象：`mindcraft` 分支 `audit/remediation-2026-11-05`（R1 修复后，含 `5d28800`）。
> 规程：`docs/audit/REVIEW-PROTOCOL.md`（三态标注 + §「反向覆盖核对」）。
> 会话时刻 2026-11-06 00:25~00:45，Node v24.16.0。
> **未改 `mindcraft/` 任何文件**：实验全在 `docs/audit/probes/r2/`；收尾 `git status --porcelain` 为空。
> 本轮**产出文档改动**（只改 `docs/audit/`）：`00-REPORT.md`。

## 0. 结论速览

| 项 | 结论 |
|---|---|
| **A. 九条遗漏项** | **已修 2 条**（I6、I14）；**仍存在 7 条**（I7/I8/I15/I17/I18/I19/I21），其中 I18/I19 已被 R1 的握手门**部分缓解** |
| **I6 门控做得对不对** | **对**。只有 hyperbolic 一处需要改，现为 `LOG_PROMPTS === '1'` 门控、**默认关**；穷举 21 个适配器无第二处打印提示词 |
| **B. lint 接线** | **已接线（3 道 commit + 4 道 push），但本机端到端"拦得住"无法实测**——`sh.exe` 无法建管道，任何 hook 都执行不了，git 只能 fail-closed。组件级证据充分（见 §2.3） |
| **C. 报告修补** | **已完成**：`:621` 假话改为更正框 + 10 处 S 编号建立对应表 + 新增「四、未收录的已知发现」一节 |
| **D. 反向覆盖** | 62 个编号（D1~D26 + P1~P15 + I1~I21）**逐个**核对：**52 有落点、10 未收录**（9 个 I + **P3**） |

---

## 1. A 项：九条遗漏项的现状判定

判定口径按任务给定：**仍存在 / 已顺手修掉 / 完全没人管**。每条给代码证据。

### 1.1 逐条判定表

| 编号 | 内容 | 位置 | 判定 | 证据（已实测/静态确证） |
|---|---|---|---|---|
| **I6** | 完整提示词无条件打 stdout | `hyperbolic.js:47` → 现 `:50` | **已修**（`5d28800`） | 见 §1.2 专项 |
| **I7** | 退出不回收 agent 子进程 → 孤儿 + 重复登录 | `agent_process.js:26-29`、`mindserver.js:438-447` | **仍存在** | `mindserver.js:438-447`：`for(...) stopAgent()` → `setTimeout(2000) → process.exit(0)`，**不 await 子进程 exit**；`mindcraft.js:97 stopAgent` 只调 `.stop()`（发 SIGINT） |
| **I8** | `settings_spec.json` 的 `type`/`options` 从不读取 | `mindserver.js:292-306` | **仍存在** | create-agent 循环只读 `.required` 与 `.default`（`:294`/`:299`）；全仓 `settings_spec` 仅 4 处引用，无一处读 `type`/`options` |
| **I14** | `task_id` 未校验拼日志路径 | `prompter.js:433-440` | **已顺手修掉**（随 R1 第 2 条） | 见 §1.3 实证 |
| **I15** | 60 行手写 loop-lag，最大值不衰减 | `utils/loop_lag.js:1-60` | **仍存在**（文件未改） | `:33-35` `if (lag > maxLagMs) maxLagMs = lag;` 单调累积；`loopLagStats()` 返回历史最大值 → 一次尖峰后永久误报 |
| **I17** | 贴图代理 `..%2f` 穿越读任意 png | `mindserver.js:150`、`:183-184` | **仍存在** | `:150` `String(rawName).toLowerCase()` 是唯一处理；`:183-184` `path.join(base,'items',`${itemName}.png`)` → `readFileSync` |
| **I18** | `bot-output`/`agent-event` 不校验发送方 | `mindserver.js:471-478` | **仍存在（部分缓解）** | 两处仍是 `io.emit(agentName, ...)` 原样转发。缓解：`mindserver.js:103 io.use(makeHandshakeGate(handshakeToken))` |
| **I19** | `get-profiles`/`get-profile` 交出绝对路径与全文 | `mindserver.js:237`/`:245`/`:263` | **仍存在（部分缓解）** | `path: full`（237/245）、`raw`（263）都在；同在握手门后 |
| **I21** | `prismarine-schematic` 未使用依赖 | `package.json:30` | **仍存在** | 依赖仍在（`^1.3.0`）；`schematic.js:9` 注释明写不用它 |

**统计：已修 2 / 仍存在 7（含 2 条部分缓解）/ 完全没人管 0。**

> 「完全没人管 0」的意思是：7 条虽未修，但其中 2 条（I18/I19）因 R1 第 1 条的握手门而**攻击面实质性收窄**，
> 不是"从来没人碰过"。这个区别必须写清 —— 否则第三轮会把它们当成全新问题重判一遍。

### 1.2 I6 专项（任务点名的核查）

**问：是只注释了 hyperbolic 一处，还是统一门控？门控开关默认值？关掉后 19 个适配器是否都不打印？**

```
$ cd mindcraft && grep -rn "Messages:" src/models/*.js
src/models/deepseek.js:36:  // console.log('Messages:', messages);      ← 早已注释
src/models/grok.js:37:      ///console.log('Messages:', messages);     ← 早已注释
src/models/hyperbolic.js:50: if (process.env.LOG_PROMPTS === '1') console.log('Messages:', messages);   ← 本轮改
src/models/mercury.js:43:   // console.log('Messages:', messages);      ← 早已注释
src/models/qwen.js:35:      // console.log('Messages:', messages);      ← 早已注释
src/models/vllm.js:51:      // console.log('Messages:', messages);      ← 早已注释
```

**只有 hyperbolic 一处是"活的"**，其余 5 处上游就已注释；另外 15 个适配器从来没有这行。
所以 `5d28800` 只改一处是**对的**，不是偷懒。

**门控默认值**（已实测）：
```
$ node -e 'console.log("LOG_PROMPTS =", JSON.stringify(process.env.LOG_PROMPTS), "| 门控 =", process.env.LOG_PROMPTS === "1" ? "打印" : "不打印")'
LOG_PROMPTS = undefined | 门控 = 不打印
```
→ **默认关**。

**穷举 19/21 个适配器是否还有别的打印路径**（排除注释行后，搜 `messages|pack|prompt|turns|payload|body`）：
```
--- src/models/hyperbolic.js
50: if (process.env.LOG_PROMPTS === '1') console.log('Messages:', messages);
--- src/models/prompter.js
252: console.warn('Unknown prompt placeholders:', remaining.join(', '));
```
`prompter.js:252` 只打印**占位符名字**（如 `$STATS`），不是内容 → 不构成泄漏。
**→ 关掉后 19 个适配器都不打印。判定：门控做得对。**

### 1.3 I14 实证（复刻判定逻辑，不落盘）

```
$ node -e '…复刻 prompter.js:33-48 的 botDirOf…'
"deepseek"           -> E:\我的世界ai\mindcraft\deepseek\logs\deepseek
"../../../../tmp/x"  -> THROW: 路径逃逸已拦截: deepseek
"../../../evil"      -> THROW: 路径逃逸已拦截: deepseek
```
**→ 修好了**：`path.resolve` 后断言必须以 `botsRoot` 开头，越界直接抛错（不是静默写到外面）。

---

## 2. B 项：lint 接线是否真生效

### 2.1 现在接了几道门

| 层 | 内容 | 耗时（脚本自述） | 入口 |
|---|---|---|---|
| **commit** | 审计正则自检 + preflight + **lint（`lint_hard.mjs`）** | ≈6s | `.githooks/pre-commit` → `npm run --silent gate` |
| **push** | 上面三项 + **`unit_all`** | ≈183s | `.githooks/pre-push` → `npm run --silent gate:full` |

```
$ grep -nE "node tools/|npm run" .githooks/pre-commit
40:if ! npm run --silent gate > /tmp/gate_main.$$ 2>&1; then
$ grep -nE "node tools/|npm run" .githooks/pre-push
31:if ! npm run --silent gate:full > /tmp/gate_push.$$ 2>&1; then

$ node -e 'package.json scripts'
"gate":      "node tools/preflight_regex_unit.mjs && node tools/preflight.mjs && node tools/lint_hard.mjs"
"gate:full": "npm run gate && node tools/unit_all.mjs"
```

**设计上是对的**：hook 里不抄命令，统一调 `npm run gate`（单一真相源，避免钩子与脚本漂移）。R1 的"1/3"现在是 **3/3（commit）+ 4/4（push）**。

### 2.2 先回答"hook 到底能不能跑"（这是 B 项的前提）

**不能。** 用最小纯 sh hook 做对照实验（与本仓库无关，排除"hook 写坏了"的可能）：

```
$ cd docs/audit/probes/r2/hooktest
$ git config core.hooksPath .githooks
$ cat .githooks/pre-commit
#!/bin/sh
echo "HOOK RAN"
exit 1
$ git -c user.email=a@b -c user.name=a commit -m t ; echo COMMIT_EXIT=$?
      0 [main] sh (14576) cygheap_user::init: NtSetInformationToken (TokenDefaultDacl), 0xC0000022
   2781 [main] sh (14576): *** fatal error - couldn't create signal pipe, Win32 error 5
COMMIT_EXIT=1
$ git log --oneline
fatal: your current branch 'master' does not have any commits yet
```

**结论**：连一句 `echo` 都跑不了 —— 本机 `sh.exe`（Git for Windows 的 MSYS）**无法创建管道**（`Win32 error 5`，拒绝访问）。
这是**环境限制**，不是 hook 写错。

**但 git 的反应是 fail-closed**：hook 执行不了 → git 视为失败 → **提交被拒**（`COMMIT_EXIT=1`，一个提交都没产生）。
这个性质本身是好的（不会静默放过），**但它不是"lint 拦住了"的证据**。

### 2.3 那 lint 这一道到底能不能拦？（组件级实测）

无法端到端（§2.2），所以拆成三段分别验：

**(a) `lint_hard` 的判据是什么、是不是空壳**（静态确证）
```
tools/lint_hard.mjs:5-22
 *   硬门只钉在**本轮已经真实归零的两个指标**上：
 *     · no-undef            → 必须是 0
 *     · no-floating-promise → 必须是 0
 *   其余规则走 lint:tools 的棘轮思路：不要求清零，但不许变多。
 *   明确写清**不**管什么：semi / require-await / no-empty …（仍是非零，要看全貌请跑 npm run lint）
```
它 `spawnSync` 起 `node_modules/eslint/bin/eslint.js src main.js --format json`，
对 `r.error` / `status!==0 && !stdout` / JSON 解析失败 / 非数组 **四处都 `exit 1`**（fail-closed），
还专门处理了 `{fatal:true, ruleId:null}`（语法错）这条假绿路径。

**(b) 它钉的两个指标现在真的是 0 吗**（**已实测**，绕开 spawnSync：直接用 shell 起 eslint 的 bin）
```
$ node node_modules/eslint/bin/eslint.js src main.js --format json > …/eslint.json
ESLINT_EXIT=1
总 problems = 197 | no-undef = 0 | no-floating = 0
Top: semi:101, require-await:78, no-empty:8, no-irregular-whitespace:4, …
```
**197 与 `lint_hard.mjs:7` 自述的 "197 problems" 一字不差**，且两个被钉的指标确实为 **0**。
→ 前提成立，这道德不是"上线即全红"也不是"永远是绿"。

**(c) 真造一个 `no-undef`，eslint 会不会报成 error**（**已实测**，用 `--stdin` 造虚拟文件，不落地）
```
$ printf 'export function probe(){ return definitelyUndefined_xyz; }\n' \
    | node node_modules/eslint/bin/eslint.js --stdin --stdin-filename src/agent/probe_virtual.js --format json
检出问题数 = 1
  ruleId = no-undef | severity = 2 | msg = 'definitelyUndefined_xyz' is not defined.
```
→ `severity 2`（error）。`lint_hard` 按 `ruleId === 'no-undef'` 计数 → 会判非 0 → `exit 1`。

**(d) 但它在本机跑不起来**（**已实测**）
```
$ node tools/lint_hard.mjs ; echo LINT_HARD_EXIT=$?
  ✗ lint:hard 起不来：EPERM
LINT_HARD_EXIT=1
$ npm run --silent gate ; echo NPM_GATE_EXIT=$?      # /tmp 被拒后改写到 probes/r2/
NPM_GATE_EXIT=1
…✓ 全绿：37 通过，0 失败。   ← 正则自检 ok
…✓ 所有模块导入成功（123/123）… ✓ 错误码审计通过（扫到 33 个码）
…✗ 扫描器自测**没跑起来**（status=null）→ 启动自检失败：1 处有问题
```
`gate` 是 `a && b && c` 串联，**preflight 在 §6（spawn EPERM）就红了 → 短路 → lint_hard 根本没被调用**。
`lint_hard` 单独跑则直接 `EPERM → exit 1`（fail-closed，不假装通过）。

### 2.4 B 项判定

| 子问 | 答案 | 三态 |
|---|---|---|
| 接了几道门 | commit 3 道（正则/preflight/lint）+ push 4 道（+unit_all） | 静态确证 |
| hook 能不能执行 | **不能**（`sh.exe: couldn't create signal pipe, Win32 error 5`），连 `echo` 都不行 | **已实测** |
| 造 lint 错误 commit 是否被拦 | **无法实测**。本机任何 hook 都跑不了，git 只能 fail-closed（提交被拒，但原因是"hook 跑不起来"） | **仍为推断**（组件级证据见 2.3） |
| 文案与实跑的门是否一致 | **一致**：`✓ 门禁通过（审计正则自检 + preflight + lint）` ↔ `gate` = 正则自检 + preflight + lint_hard | 静态确证 |

**缺什么才能实测**：一个能让 `sh.exe` 正常创建管道的运行环境（普通宿主机、非本沙箱）。

---

## 3. C 项：报告完整性修补（已产出的改动）

改动全部在 `docs/audit/00-REPORT.md`，共 3 处，**未改任何已有判定**。

| # | 改动 | 位置 | 效果 |
|---|---|---|---|
| 1 | **删掉 `:621` 的假话**，换成带 grep 证据的更正框 | 第三节开头（原 L621 → 现 L621-647） | 明确写出"v1 的 S1~S32 原文并未保留，一条都没有"+ 为什么（git 初始化前被覆盖）+ 已不可恢复 |
| 2 | **10 处坏链建表**：每个编号给「正文引用处 → 从上下文反推的主题 → 是否可恢复」 | 紧接更正框 | 读者看到"（S3）"能查到它指什么；且标明**是从本报告自身用法反推的，不是原文** |
| 3 | **新增「四、未收录的已知发现」** | 文末（L1240 起） | 9 个 I 编号 + P3 + 遗失的 S 项**有了正式归属**；含 4.4 反向覆盖总账 |

**逐项核对**：
```
$ grep -n "原文全部保留" docs/audit/00-REPORT.md
623:> 本节此前写着「v1 的 S1~S32 **原文全部保留**…」，**这句话是假的**：     ← 只作为"被推翻的原话"出现
$ grep -n "^# 四、未收录的已知发现" docs/audit/00-REPORT.md
1240:# 四、未收录的已知发现（终审 R2 / t26 补登，2026-11-06）
$ for n in 3 4 5 6 9 10 17 20 21 29; do grep -c "\*\*S$n\*\*" …; done
（10 个编号各 1 处定义）
行数：1208 → 1289（+81）
```

### 3.1 一处口径更正（对 R1 附二的修正）

R1 附二写「10 处引用：S3、S4、S5、S6、S9、S10、S17、S21、S29、**S32**」。
实测：**`S32` 全文只出现在"本节的范围描述"里，从未被正文引用**；它列举的 `L831` 那一行里是 **`S20`**。

```
$ grep -n "S32" docs/audit/00-REPORT.md      → 只有 L619/L621 两处范围描述
$ sed -n 831p docs/audit/00-REPORT.md | grep -oE "S[0-9]+"  → S20
```
→ 真正的 10 个是 **S3/S4/S5/S6/S9/S10/S17/S20/S21/S29**。已在更正框里写明。

---

## 4. D 项：反向覆盖核对（规程新增，本轮必须做一次）

方法：取三份分册的**全部发现编号**，逐个在主报告里**按内容**找落点（不搜编号），
且**每种都要换措辞**（函数名 / 关键常量 / 症状 / 行号）—— 这条是踩过坑才加的，见 §4.3。

### 4.1 核对结果

| 分册 | 范围 | 有落点 | 未收录 |
|---|---|---:|---|
| `07-deep-skills-atoms.md` | D1~D12 | 12/12 | 0 |
| `11-skills-rest.md` | D13~D26 | 14/14 | 0 |
| `13-models-agent-preflight.md` | P1~P15 | 14/15 | **P3** |
| `03-interface-security.md` | I1~I21 | 12/21 | **9**（I6/I7/I8/I14/I15/I17/I18/I19/I21） |
| **合计** | **62** | **52** | **10** |

> **口径说明**：`I6` 在 R1 里被单列为「R1-a」，但 `grep -n "R1-a" 00-REPORT.md` 在**本轮修补前 = 0 命中**
> （当时只在 `17-review-r1-verdict.md` 里），所以它**同样属于"未进主报告编号"**，计入这 9 条之内。
> 反过来也自洽：21 − 9 = **12** 条 I 系列在主报告里有落点。

各条落点（抽样，全表见 `00-REPORT.md` §4.4）：

| 编号 | 落点 |
|---|---|
| D1 SES 沙箱逃逸 | 第 1 条（L27 起，含第六层越权面） |
| D2 `digTunnel` 的 `ok` | 第 10 条 |
| D3/D16 直发 `/setblock` | 第 1 条 + L531/L306 |
| D18 `goToGoal` 不可中断 | 第 11 条相关段（L503） |
| D21 `collectHazardsCached` | **S37**（L630） |
| D22 `storeItem`/`stashUnneeded` | **S40**（L633） |
| D23 `digDown` | **S41** |
| D24/D25 仓储两处 | **S42** |
| **D26** `verifyChest` 无效排序 | **L720**（按行号 `skills.js:5080` 描述） |
| P6 `tile_map` 冒烟 | **S33** |
| P8 `profile.model.includes` | **S44** |
| P9 `audit_codes` 无人引用 | **S34** |
| P12/P13 双 error / 无 await | **S43** |
| P14 `NAV_ALLOWED_ACT_FUNCS` | **S35** |
| P15 `API_SCAN_ENFORCE` | **S36** |

### 4.2 唯一未收录：P3（已登记进主报告 §4.2）

```
$ for k in "二次抛" "err.message" "gpt.js:79" "未捕获异常" "String(err"; do grep -c "$k" 00-REPORT.md; done
0 0 0 0 0
$ grep -n "includes" 00-REPORT.md     # 症状级
355:…未注册的码 ['DIED']…      ← 扫描日志
639:…S44 `profile.model.includes(...)`…   ← S44，另一件事
```
**P3 确属零落点**：`gpt.js:79`/`claude.js:51`/`groq.js:64`/`mercury.js:52`/`mistral.js:60`
在 catch 里对 `err.message` 调 `.includes`，若 reject 的不是 Error 会在 catch 内二次抛 `TypeError` 并逃出 `sendRequest`。

> 注意它与 **P1**（16 处兜底串把失败伪装成模型的话）**不是同一件事**：P1 的后果是"返回了假话"，
> P3 的后果是"连假话都没返回、直接抛"。主报告 L571 的最小修复是改 P1 的兜底串，不覆盖 P3。

### 4.3 一条方法论教训（写进规程用）

我第一次把 **D26 判成"未收录"**，因为主报告里搜 `verifyChest` = 0。
再查才发现主报告 **L720 用行号（`skills.js:5080`）而不是函数名**描述它：

> `| 4 | skills.js:5080 | known.sort((a,b)=>a.distanceTo?.(me) ?? 0) —— 记录没有 distanceTo，恒 0 | 排序是空操作…|`

**规程说"按内容找、不要搜编号"是对的，但不够** —— 还要**按内容找时换多种措辞**：函数名 / 行号 / 症状关键词。
否则会把"已收录"误判成"未收录"，让作者白改一遍。

---

## 5. 本轮无法实测 / 受限（三态标注必填）

| 项 | 三态 | 缺什么 |
|---|---|---|
| 「造 lint 错误 → commit 被拦」端到端 | **仍为推断** | 本机 `sh.exe` 无法建管道（`Win32 error 5`），任何 hook 都执行不了；组件级证据见 §2.3（a/b/c） |
| `lint_hard.mjs` 自身的违规检测 | **静态确证 + 旁证** | 它靠 `spawnSync` 起 eslint → EPERM（`✗ lint:hard 起不来：EPERM`）。旁证：直接用 shell 起 eslint，197/no-undef=0/no-floating=0 与它自述完全一致；`--stdin` 造 no-undef 得 severity 2 |
| `npm run gate` 全绿 | **假红**（环境） | preflight §6 因 spawn EPERM 红 → `&&` 短路。真宿主上应能过 |
| I18/I19 的实弹利用 | **仍为推断** | 需启动 mindserver（本轮不启动，避免污染现场）；且已有握手门，需先拿 token |
| v1 的 S1~S32 原文 | **确认不可恢复** | git 历史无 v1 版本（最早快照 `22c41e8` 已是 v2.1 1208 行） |

---

## 6. 给下一轮的三条建议

1. **把"反向覆盖核对"变成机械步骤**：写 `tools/audit_partial_coverage.mjs`，输入分册目录 + 主报告，
   按"编号 → 候选关键词表"自动比对，输出未收录清单。本轮是手做的，容易漏（D26 就漏过一次）。
2. **主报告里给每个 S/D/P 编号加"落点列"**（哪一条第 N 条覆盖了它），这样下一次核对是查表而不是搜文本。
3. **I7/I8/I15/I17 这四条是真未修**，且都不难（I7 等子进程 exit + 5s 超时；I8 加 6 行类型校验；
   I15 换 `perf_hooks.monitorEventLoopDelay`；I17 加一行 `/^[a-z0-9_]+$/`）。建议下一轮直接收掉，
   免得它们以"未收录"身份第三次出现。

---

## 7. 复跑方法

| 实验 | 命令 | 预期 |
|---|---|---|
| S1~S32 定义数 | `grep -cE '^\s*-\s*\*\*S[0-9]+\*\*' docs/audit/00-REPORT.md` | `13`（只有 S33~S45） |
| 10 处坏链是否都有定义 | `for n in 3 4 5 6 9 10 17 20 21 29; do grep -c "\*\*S$n\*\*" docs/audit/00-REPORT.md; done` | 各 `1` |
| I6 门控 | `grep -rn "Messages:" mindcraft/src/models/*.js` | 只有 `hyperbolic.js:50`，且带 `LOG_PROMPTS === '1'` |
| I14 越界拦截 | 见 §1.3 的 node -e 复刻 | 两个越界名都 `THROW: 路径逃逸已拦截` |
| hook 能否执行 | `docs/audit/probes/r2/hooktest`（纯 sh hook + `exit 1`）再 `git commit` | `COMMIT_EXIT=1` + `sh.exe: couldn't create signal pipe` |
| lint 前提 | `cd mindcraft && node node_modules/eslint/bin/eslint.js src main.js --format json` 后统计 | `197 / no-undef=0 / no-floating=0` |
| no-undef 规则是否活 | `printf 'export function f(){return x_undef;}\n' \| node node_modules/eslint/bin/eslint.js --stdin --stdin-filename src/agent/v.js --format json` | `ruleId=no-undef severity=2` |
| lint_hard 本机状态 | `node tools/lint_hard.mjs` | `✗ lint:hard 起不来：EPERM`，exit 1 |

---

*分册完。`cd mindcraft && git status --porcelain` 为空；本轮只写 `docs/audit/`（`00-REPORT.md` + 本文件 + `probes/r2/`）。*
