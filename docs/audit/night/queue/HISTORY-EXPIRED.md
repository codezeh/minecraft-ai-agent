# 历史欠账：已过期（已修复，建议复核）

> 产出：patch-smith（D0 预热，t12，2026-11-06）
> 来源：`docs/audit/00-REPORT.md`（v2.1，34 条硬发现 + E1/E2 + S33~S45）、`01~19` 各分册。
> **本文件不产生待办**：这里每一条都已在当前代码里复核为"已修"，只留一句话结论 + 复核方式，
> 防止下一个人把已修的东西当新发现重报（`00-REPORT` 自己也吃过这个亏：I6 被 R1-a 跟踪过，R2 时又被当候选重查了一遍）。
> 仍然成立的历史问题**不在这里**，已转成待办单放进 `queue/inbox/`（编号一律用 **1xx** 段，见文末约定）。

## 一、34 条硬发现（33 条真修好 + 1 条部分）

| # | 内容 | 结论 | 本轮复核到的证据（当前代码） |
|---|---|---|---|
| 1 | 控制面无认证 + SES 沙箱可逃逸 + 任务 JSON 注入 + 蓝图穿越 | **已修复，建议复核** | `mindserver.js:103 io.use(makeHandshakeGate)`；`tasks.js:407/513` 改参数通道（不再拼串）；`schematic.js:41/70` 蓝图根 + `startsWith` 断言；探针 `probes/t19-ses-escape-review.mjs` → BLOCKED=20/ESCAPED=0 |
| 2 | `create-agent` profile.name 路径穿越 | **已修复，建议复核** | `src/models/prompter.js` 6 处 `botDirOf`（`resolve` + `startsWith` 断言） |
| 3 | 板库"当坏库→改名→重建"（BUSY 被当损坏） | **已修复，建议复核** | `board_store.js` 的 `openBoard` 按 `SQLITE_CORRUPT/NOTADB/malformed` 收窄（errcode 判据在位） |
| 4 | `finish()` 不校验租约归属 | **已修复，建议复核** | `board_store.js` `leaseGuard` / `LEASE_STALE`（8 处命中） |
| 5 | 依赖死掉→父单永久 running | **已修复，建议复核** | `board_store.js` `DEP_DEAD`（8 处命中） |
| 6 | `!stop` 对任务板无效（三处断链） | **已修复，建议复核** | `board_scheduler.js` 6 处 / `control.js` 2 处 `runJobAction`（不再零调用方） |
| 7 | 重启守卫 10 秒→永久死亡 | **已修复，建议复核** | `agent_process.js` 指数退避（15 处） |
| 8 | 玩家财产四条破坏路径 J1/J2/J3/J4 | **已修复，建议复核** | `landmarks.js:78-86` 两端 `normalizePos`（不再读 `c?.pos`）；`skills.js` 4 处 `wmIsPlayerBuilt`；`NATURAL_BLOCKS` 已去 `farmland` |
| 9 | 导航闸 owner 恒 `'adhoc'` | **已修复，建议复核** | `nav_core.js` `resolveNavOwner` + `adhoc:${n}` 唯一化（8 处命中） |
| 10 | `digTunnel` 的 `ok` 未 import | **已修复，建议复核** | `skills.js` 已 import `contract.js` |
| 11 | 三道门禁无自动触发点 | **部分修好（端到端不可验）** | `.githooks/pre-commit` 走 `npm run gate`（= settings_check + preflight_regex_unit + preflight + lint_hard）；`gate:full` 加 `unit_all`。**"钩子真能拦住"在本机仍无法证明**：Windows 下 git 起的 `sh` 报 `Win32 error 5`，连 `echo` 都跑不了（R1/R2 两轮同结论）。方向 fail-closed，**不是假绿** |
| 12 | bot 日志无时间戳 | **已修复，建议复核** | `src/infra/log_prefix.js:66`（幂等给 console 打 ISO 前缀） |
| 13 | `surveyArea` r=64 无上限 | **已修复，建议复核** | `skills.js` 默认 `radius=24`；`terrain3d.js:273 SCAN_MAX_RADIUS=32` 入口硬夹 |
| 14 | `listJobs` LIMIT 200 饥饿 | **已修复，建议复核** | `board_store.js` `openOnly`（2 处） |
| 15 | 租约回收不记 `attempts` | **已修复，建议复核** | `board_store.js` `attempts = attempts + 1`；再叠加 `bf06d4e` 的 `producedTotal` 产出账 |
| 16 | 共享箱读-改-写丢更新 | **已修复，建议复核** | `board_client.js:437 sharedMerge` + `flow_store.js:81`（无板时不退回本地文件） |
| 17 | 幽灵父单（0 子单，永久 running） | **已修复，建议复核** | `board_store.js` `blockOrphanParents` / `ORPHAN_PARENT`（7 处） |
| 18 | 42 个孤儿测试不在门禁 | **已修复，建议复核** | `unit_all.mjs` 改用 `readdirSync` 发现（3 处） |
| 19 | 退出码 >1 连带杀 mindserver | **已修复，建议复核** | `agent_process.js` 已无 `process.exit(code)` |
| 20 | `skills.js` 98 导出与原子层分叉 | **部分修好（只修了 3 处分叉 + 3 处顺手）** | `isSafeHere`/`canReach`/`waitUntil` 已薄包装；`loadFurnace` OCCUPIED、`breakBlockAt`、`attackNearest/Entity` 已接。**剩余分叉仍活着 → 已转新单** `F-EXEC-103`（takeFromChest/putInChest）、`F-EXEC-104`（equip）、`F-AI-103`（模型可见目录层面） |
| 21 | 技能能攻击玩家 | **已修复，建议复核** | `skills.js` 5 处 `isAttackable` |
| 22 | `giveToPlayer` 的 `if (got)` 恒真 | **已修复，建议复核** | `skills.js` `got && got.ok` |
| 23 | `levelGround` 拆农田 / 凭空造方块 | **已修复，建议复核** | `NATURAL_BLOCKS` 已去 `farmland`；`/fill` 加了库存前置（`haveFiller`/`canFill`） |
| 24 | schema 不匹配走"当坏库重建" | **已修复，建议复核** | `board_store.js` `PRAGMA user_version` + 幂等 `ALTER`（6 处命中） |
| 25 | `memory_store` 损坏静默清空 | **已修复，建议复核** | `memory_store.js` `.corrupt-<ts>` 备份（3 处） |
| 26 | preflight 0x08 假绿灯 | **已修复，建议复核** | `grep -c $'\x08' tools/preflight.mjs` → **0**；正则已改 `\b` 且引号归一 |
| 27 | 文档索引/棘轮盯过期对象 | **已修复，建议复核** | `docs/README.md` 已指 `架构交接-总.md`；`audit_rules` 逐条 `existsSync`（`deadItems` 硬校验） |
| 28 | `useToolOn` 恒假守卫 | **已修复，建议复核** | `skills.js` `gameMode !== 'creative'`（2 处） |
| 29 | 两处裸 `bot.chat('/setblock…')` 绕过白名单 | **已修复（skills.js 侧），但同族在 `src/agent/tasks/**` 仍有 38 处 → 已转新单** | `skills.js:1085` 只剩注释；`preflight.mjs:485-509` 的豁免表把 `src/agent/tasks/**` 整目录放过 → `F-EXEC-101` |
| 30 | `novita.js:47` 缺 `this.` | **已修复，建议复核** | `novita.js` 2 处 `this.sendRequest` |
| 31 | 失败伪装成模型的话 + 零 usage | **已修复，建议复核** | `_shared.js` `FAILED_REPLY`/`isFailedReply`；19/19 适配器 `recordUsage`；429 退避在 `_shared.js` + hyperbolic/ollama。**残留契约风险已转新单** `F-AI-102` |
| 32 | 心跳 `while(true)` 无 try/catch | **已修复，建议复核** | 循环搬到 `library/heartbeat_loop.js`，`agent.js:846-855` 调 `runHeartbeatLoop` 并兜异常 |
| 33 | `goToGoal` 180s 不可中断 | **已修复，建议复核** | `skills.js` 3 处 `INTERRUPTED`；`goToBed:2483` `while (bot.isSleeping && !bot.interrupt_code)` |
| 34 | preflight `loaded` 不校验 | **已修复，建议复核** | `preflight.mjs` `loaded === files.length`（3 处） |

**这两条是 E 组（08 分册的 Must）**：

| # | 内容 | 结论 | 证据 |
|---|---|---|---|
| E1 | `follow` 超时键名错配（`deadlineMs` vs `timeoutMs`） | **已修复，建议复核** | `flow_follow.js` 6 处 `deadlineMs` |
| E2 | `digdown` 液体假成功（`dug=0` 仍 `ok`） | **已修复，建议复核** | `executor.js` `BLOCKED` 判据（3 处）+ `:369` 起的 E2 注释段 |

## 二、S 系列 S33~S45（13 条）

| 编号 | 内容 | 结论 |
|---|---|---|
| S33 | preflight 冒烟指向已删 `tile_map.js` | 已修复，建议复核（缺模块判失败） |
| S34 | `tools/audit_codes.mjs` 死文件 | 已修复（文件已删） |
| S35 | `NAV_ALLOWED_ACT_FUNCS` 定义未用 | 已修复（R2 删净，`preflight.mjs` 只剩一句注释） |
| S36 | preflight 注释与 `API_SCAN_ENFORCE` 漂移 | 已修复，建议复核 |
| S37 | `collectHazardsCached` 死代码 | 已修复（不只是删，把缓存**接上**了） |
| S38 | 四个 `goTo*` 忽略返回值恒 `true` | 已修复，建议复核 |
| S39 | `tillAndSow` cheat+null 抛 TypeError | 已修复，建议复核 |
| S40 | `storeItem` 意图即成功 | 已修复（`beforeHave/afterHave/actuallyMoved`） |
| S41 | `digDown` 读不到方块报成功 | 已修复，建议复核 |
| S42 | 储物间建成判据过弱 | 已修复（期望面积/周长 + 容差） |
| S43 | 双份 `bot.on('error')` + 未 await | 已修复（`agent.js` 单一注册、`:324` 已 await） |
| S44 | `_model_map` 的 `profile.model` 空值崩溃 | 已修复，建议复核 |
| S45 | `world.js` 恒假检查/假对象 | 已修复，建议复核 |

## 三、03 分册 9 条悬空 I 项（R2 归位）

| 编号 | 内容 | 结论 |
|---|---|---|
| I6 | 提示词无条件打 stdout | **已修复**（`hyperbolic.js:50` 门控 `LOG_PROMPTS=1`，默认关）。**残留"两个开关"问题 → 已转新单** `F-SEC-105` |
| I14 | 提示词日志目录用未校验 `task_id` 拼路径 | **已修复**（`prompter.botDirOf` + `startsWith`，越界抛错） |
| P2 | `novita.js:47` 缺 `this.` | 已修复（= 第 30 条） |

## 四、仍成立、已转成待办的历史项（不在本文件，在 `queue/inbox/`）

见同目录 `F-*-1xx.md`。一句话对照：

| 原编号 | 转成的单 |
|---|---|
| R2-1 / I7 退出不回收子进程 | `F-EXEC-102` |
| R2-2 / I8 `settings_spec.type/options` 不校验 | `F-EXEC-112` |
| R2-3 / I15 `loop_lag` 最大值不衰减 | `F-EXEC-107` |
| R2-4 / I17 贴图代理路径穿越 | `F-SEC-104` |
| R2-5 / I18 `bot-output` 可伪造 | `F-WEB-101` |
| R2-6 / I19 profile 全文/绝对路径 | `F-SEC-103` |
| R2-7 / I21 `prismarine-schematic` 未使用依赖 | `F-DEP-101` |
| R2-8 提示词两个开关 | `F-SEC-105` |
| R2-9 垫脚选材两份实现 | `F-EXEC-108` |
| P3 适配器 catch 内二次抛 | `F-AI-101` |
| P11 `console.log(err)` 可能泄 Authorization | `F-SEC-102` |
| E3 `checkLevel` 解引用崩溃 | `F-EXEC-109` |
| E4 `embellishments` 传错 newZ | `F-EXEC-110` |
| E6 `runCraft` 不传 ctx | `F-EXEC-111` |
| 第 20 条剩余分叉 | `F-EXEC-103` / `F-EXEC-104` / `F-AI-103` |
| 第 29 条同族（tasks 裸斜杠命令） | `F-EXEC-101` |
| 08 F2 高度不足报 ok | `F-EXEC-105` |
| 08 F3 `/air/i` 吞失败 | `F-EXEC-106` |
| T11 web 门禁极弱 | `F-WEB-102` |
| 无依赖 CVE 审计（D1 缺口） | `F-DEP-102` |
| RCON 开启 + 绑全网卡 + 明文口令 | `F-SEC-101` |

## 五、约定：编号分段（避免与侦察兵撞号）

- 侦察兵（`recon-scout`）用 **0xx** 段（`F-DEP-001…`）。
- 本预热任务（历史转化）用 **1xx** 段（`F-SEC-101`、`F-EXEC-101` …）。
  原因：本轮是三人并发，两边同时往 `inbox/` 写；`mv` 只保证认领互斥，**不保证写入互斥**
  （`cat >` 会直接覆盖同名文件）。分段后两边的号段天然不重叠。
- 认领仍然照 PLAYBOOK §1：`mv inbox/<id>.md claimed/<id>.md`，与号段无关。

## 六、本轮**没有**转化、留给下一轮侦察的（诚实边界）

以下是历史文档里存在、但本轮**没有**在代码里复核的条目，因此**没有**写成单（宁缺勿假）：

- `08` 的 **F4**（`nav_pathfinder.js:269-271` 的 `partial:true` 只判 `r.ok` 的调用方当成功）、
  **F6**（`flow_follow` 不校验"是否真的在接近"）—— 需读 `step_runner` / `climbByTunneling` 的消费面。
- `13` 的 **P4**（huggingface/replicate 流式中断返回半截）—— 看到 `huggingface.js:50` 已改 `failedReply`，
  `replicate.js` 的 `for await` 未见 try/catch，**未定性**，需实跑一次断流才能判。
- `04` 的 **T12/T13/T14**（README 测试章节过期 / 测试脚手架重复 N 遍 / `unit_all` 丢错误原因）。
- `06` 的文档漂移表（命令级缺失、数字漂移）与**依赖可删清单**之外的瘦身项 —— 属文档/瘦身，不是安全面。
- `00-REPORT §4.3` 说的"**≈68 条分册发现不可追溯**"：本轮只覆盖了其中**能在代码里一眼复核**的部分
  （E3/E4/E6/P3/P11/T11 等）。剩下的没有映射表，无法机械清点 —— 这是报告体系的结构性缺口，
  建议下一轮让侦察兵**按文件**扫（而不是按编号找），命中即立单。
