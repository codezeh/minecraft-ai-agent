# 复核清单 R1（终审第一轮 · 独立复核 · t23）

对象：`docs/audit/17-review-r1-verdict.md`（终审 R1④ 汇总，49 项）+ 分册 `14`/`15`/`16` + 基线 `00-REPORT.md` v2.1。
分支：`mindcraft` `audit/remediation-2026-11-05`（相对 `main` 20 提交 / 126 文件）。
方法：`node` 直跑探针 / 在副本里注入后跑 preflight / `grep -n` 定位 / 读 `git diff --stat` 最大改动文件。
**未改 `mindcraft/` 任何文件**（`git status` 为空），只写 `docs/audit/`。

> v2 复核（t14，针对基线报告）的台账已被本文件取代；v2 的结论仍有效，摘要见 §G。

## 结论摘要

| 项 | 结果 |
|---|---|
| **我的最终判定** | **`PASS`** —— 与主编**一致** |
| 抽检条数 | **15 条**（要求 ≥12），含全部高危"真修好"项 |
| 抽检结果 | **15/15 成立**，主编无虚报 |
| 三态修正 | **1 处**（第 26 条：判定保留"已实测"，但其**覆盖面被写宽**） |
| 需降级为"静态确证"的 | **0 条** |
| 新增问题 | **2 条**（N1 提示词落盘未被任何编号收录；N2 正则词法盲区） |
| 修出新问题 | **0 条**（专项查了新代码本身） |
| 覆盖缺口是否诚实 | **诚实**（未把"未覆盖"写成"通过"） |
| BLOCK 项 | **0**（主编判定为空，我复核后仍为空） |

## A. 我自己跑的 3+ 个关键探针（不转述分册）

| # | 探针 | 我的真实输出 | 判定 |
|---|---|---|---|
| 1 | **沙箱逃逸** `node docs/audit/probes/t19-ses-escape-review.mjs` | `===== 汇总：BLOCKED=20  ESCAPED=0  其余(探测类)=6 =====`；`Object.prototype` 相关向量全部 `Function.prototype.constructor is not a valid constructor` | 逃逸**真关住** |
| 2 | **板库重建** `node docs/audit/probes/t20-board-open.mjs schema <dir>` | `rebuilt = false`；`migration={"added":["interrupted","repeat_ms","dependsOn"],"from":1,"to":2}`；`行数 前=1 后=1` | **不丢数据** |
| 3 | **门禁假绿** 副本注入 `fail('ZZPROBEUNREGISTERED')` 后跑 `preflight.mjs` | `✗ 有 1 个错误码没注册：ZZPROBEUNREGISTERED` + `← src\agent\library\query_classify.js` | 门禁**真抓**（非假绿） |
| 4 | 同上的**词法盲区**测试 | 注入 `fail("T23_UNREGISTERED_CODE")`（双引号+数字）→ `✓ 错误码审计通过（扫到 33 个码，均已注册）`；改单引号仍漏；只有 `fail('ZZPROBEUNREGISTERED')` 被抓 | **N2：潜在缺口**（今天 0 处真实触发） |
| 5 | 玩家财产四路径 | J1 调用点 3 处（`skills.js:1054/:1231/:4166`）；J4 守卫 `:1054` **在**作弊分支 `:1059` **之前**；J2 `'farmland'` 4 处全在 tillAndSow（`:2472/2490/2496/2512`）、**不在** `NATURAL_BLOCKS`；J3 `flow_collect_plan.js:115` | **四条都在** |

副本来源：`bash docs/audit/probes/r1/make_sandbox.sh`（复现 t21 的实验环境）。

## B. 抽检 15 条明细

| 编号 | 主编判定 | 我的复核 | 依据 |
|---|---|---|---|
| 1 | 真修好 | **成立** | 探针 1；`lockdown.js:56` `const sesLockdown = globalThis.lockdown`；`settings.js:38` `allow_insecure_coding: false` |
| 3 | 真修好 | **成立**（⚠️我是 t20 作者，仅复跑不独立判定） | 探针 2 |
| 8 | 真修好 | **成立** | 探针 5（四路径逐个读位置与顺序） |
| 13 | 真修好 | **成立** | `skills.js:5636` `radius = 24`；`terrain3d.js:273-274` `SCAN_MAX_RADIUS=32` + `Math.min` |
| 19 | 真修好 | **成立** | `grep process.exit agent_process.js` 2 处命中 = 注释(`:46`) + 字符串(`:142`)，**无真实调用** |
| 20 | 部分修好 | **成立** | `canReach(bot,pos,max = 4.3)` 仍 `:1984`；主体未修 |
| 21 | 真修好 | **成立** | `isAttackable` 已 import 进 `skills.js:26`，5 处引用；定义 `act_attack.js:40` |
| 22 | 真修好 | **成立** | `skills.js:1655` `if (got && got.ok) return true;` |
| 24 | 真修好 | **成立**（⚠️作者，仅复跑） | 探针 2 |
| 26 | 真修好 | **成立，但覆盖面被写宽** | 探针 3 通过；探针 4 暴露词法盲区 → N2 |
| 28 | 真修好 | **成立（行号已漂移）** | 实际在 `skills.js:2896`（不是分册写的 2760，2760 现为 `stringifyTrades`）：`bot.game.gameMode !== 'creative'` |
| 29 | 真修好 | **成立** | `grep "bot.chat('/"` 仅 2 处、**全是注释**（`:13`/`:1063`）；`:1065` 已改 `command(bot,'setblock',…)` |
| 30 | 真修好 | **成立** | `novita.js:51` `return await this.sendRequest(...)` |
| 32 | 真修好 | **成立**（⚠️作者，仅复跑） | `heartbeat_loop.js` catch 在 `while` 内、不 rethrow；实跑 5/5 拍存活 |
| S35 | 未修 | **成立** | `grep -c NAV_ALLOWED_ACT_FUNCS preflight.mjs` = **1**（仅定义、零使用） |

## C. 新增问题（我提的，主编没抓到）

### N1（Should；**下一轮不收应升级为 BLOCK**）`hyperbolic.js:47` 无条件把完整提示词打到 stdout
- `mindcraft/src/models/hyperbolic.js:47` = `console.log('Messages:', messages);` **未注释**。
- 同仓 **5 个兄弟文件都已注释掉**：`deepseek.js:36`、`grok.js:37`、`mercury.js:43`、`qwen.js:35`、`vllm.js:51` —— 说明"这行不该活着"已是共识。
- **本来有编号**：`03-interface-security.md:292` 「I6 每次模型请求都无条件把完整提示词打到 stdout（含玩家聊天与记忆）」。
- **丢了**：`grep I6|Messages: 00-REPORT.md` → **0 命中**。I6 从未并入 00-REPORT 的 1~34 / S 题号 ⇒ 不在 R1 的 49 项、三份分册没审、主编 §3 没列。
- **为什么现在必须提**：`hyperbolic.js` 本轮被改写 **+242 行**（`git diff --stat` 第 4 大），作者在其中加 429 退避与 `recordUsage`，**却没顺手删这行**。
- 后果：选该模型时，每轮对话把完整 messages（玩家私聊原文、memory、profile 人设）无条件写进 `logs/mindcraft-console.log`；叠加第 12 条新加的 ISO 时间戳后更可检索。
- 最小修复：删/注释该行，或 `if (process.env.LOG_PROMPTS === '1')`。
- **不判 BLOCK 的理由**：基线即存在、且不在本轮 49 项范围内（流水线漏收）。按规程 §5，本轮 BLOCK 应限于"本轮变更引入或本轮范围内"。

### N2（Should）`preflight.mjs:55-68` 错误码正则的词法盲区
两个正则 `\bfail\(\s*'([A-Z_]+)'` 与 `\{…code:\s*'([A-Z_]+)'`：**只认单引号**、**`[A-Z_]+` 不含数字**。
现状：`CODES` 38 个全部匹配（含数字的 0 个）；`src/` 里 `fail("` = 0 处、含数字的 `fail('` = 0 处 ⇒ **当前覆盖率实际 100%**，属潜在缺口。
修法：正则加 `["']` 与 `[A-Z0-9_]`（4 个字符），并补一条"注入含数字码必须变红"的单测。

## D. 覆盖缺口核对（主编 §3 是否诚实）

| 主编列的缺口 | 我核对 |
|---|---|
| 第 1~34 缺 2 条（第 9、20） | ✅ 已列，且补审结论**不是**"通过"：第 9 = 真修好、第 20 = **部分修好（主体未修）** |
| S 组缺 5 条（S33/34/35/36/39） | ✅ 已列；其中 **S35 = 未修**（诚实） |
| `unit_all` 全量没跑过（EPERM） | ✅ 已列并注明"整套测试通过这件事本轮没有任何人证明过" |
| 无多 bot / 第 6 条未端到端 / 第 14 条未压测 / 第 31 条 usage 仅 grep / socket 未实弹 | ✅ 全部已列 |

**结论：没有虚假覆盖。** 唯一未列的缺口是 N1（不在编号体系内），属于**编号体系本身的洞**，不是主编隐瞒。

## E. "修出新问题"专项（我自己查的新代码）

| 新代码 | 我查什么 | 结果 |
|---|---|---|
| `hyperbolic.js` 重试循环 | `maxAttempts=5`、`attempt++` 是否在循环首、429 是否会被无限重试/双重计数 | `maxAttempts = 5`（:40）、`attempt++` 在循环首（:45）、429 抛 `{status:429}` 由 `isRateLimit` 接住 → **无死循环、无双重计数** |
| `breakBlockAt` 新守卫（J4） | 是否遮挡正常路径、是否在作弊分支之前 | 守卫在 `:1054`、`if (modesIsOn(bot,'cheat'))` 在 `:1059` → **两条路都过闸，正常路径未被误挡** |
| `board_store.migrateBoardSchema` | 是否引入死锁/长事务；失败是否比原来更糟 | ALTER 逐条独立提交、判据用 `table_info` 实列而非 user_version ⇒ **可重入**；非 corrupt 走 rethrow（不删库）⇒ **最坏是无板可用，不丢数据** |

## F. 行号漂移（给作者的实用提示）

| 条目 | 分册/主编写的 | 实际 |
|---|---|---|
| 第 28 条 | `skills.js:2760` | **`:2896`**（2760 现在是 `stringifyTrades`）；同文件累计位移 ≈ +136 行 |
| 第 8 条 J1 | 原报告称 2 个调用点 | 现为 **3 个**（新增 `:1054` = J4 守卫本体） |

## G. v2 复核（t14）结论摘要 —— 仍有效

当年总账：删 0 / 降 0 / 修正行号路径 4 / 修正数字 5 / 加强表述 2 / 删错误表述 1。
六条必验断言：a 成立（eslint `5750:12 no-undef`）、b 成立（路径在 `src/agent/npc/item_goal.js`）、c 成立（`src/models/` 20 条 Parsing error）、d 成立（静态，绿路径 EPERM 不可执行）、e 部分成立（同一根因、断言对象不同）、f 成立（`adhoc` 零命中）。
v2 当时 5 条"队长亲验被标已实测"已降级为静态确证——**本轮 R1 未重犯该错**（我逐条核过标"已实测"的 16 条，均有 `probes/` 或分册输出支撑）。

## H. 我做/没做的边界

**做了**：重跑 3 个关键探针 + 1 个盲区探针；抽检 15 条；读 4 个最大改动文件中的 2 个（`hyperbolic.js`、`breakBlockAt` 区段）+ `preflight.mjs` 错误码段；核三份分册交集。
**没做**：`unit_all` 全量（EPERM，`0/64` 不是失败）；socket 实弹（需启动 mindserver）；真机 `!stop` 端到端；250 单压测；真跑一次模型调用看 usage 数值。
**利益冲突声明**：第 3/4/5/6/7/14/15/16/17/19/24/25/31/32 条是我 t20 的产出，本清单里对这 14 条只做"复跑证据 + 行号核对"，**不充当独立判定**。
