# R6 零散残留：做了什么 / 为什么不做 / 只能真机

> R6 / fixes4 · 2026-11-12 · 对应报告条目 **#54、#76、#77** + 板库 `user_version` 线上体检 + `memory.json` 损坏夹具。
>
> **这张表的用法**：t10 复核时逐条对。**"没做"就写没做**，不要含糊成"已关注"。
> 三列含义严格区分：
> - **做了** = 代码/测试已落地，且**有能红的验证**（不是"我改完了"）；
> - **只能真机** = 逻辑已就位，但"是否真的生效"只能在本机跑一次才知道，**离线测不了**；
> - **不做** = 明确决定不做，必须给出理由与替代方案。

## 1. 总表

| # | 条目 | 状态 | 证据 / 理由 | 验证方式 |
|---|---|---|---|---|
| #76 | `truncate` 行裁剪后字符裁剪被短路（25 万字符回灌模型） | **做了** | `contract.js` 的 `truncate()`：行裁剪后再比 `maxChars`，超了继续按字符裁；提示语合并"行数/字符数/省略行数"，避免只做字符裁剪把"省略 N 行"切掉 | `tools/contract_truncate_unit.mjs`（5 用例）；**旧实现跑同一套断言 → 8 FAIL / exit 1** |
| #77 | `floor3`/`floorXZ` 不校验分量 ⇒ `{x:'a'}` → `NaN` 且判合法 | **做了** | `contract.js`：逐分量 `Number.isFinite`，任一非法返回 `null`；`Number()` 归一化保留 `"12"` 这类可接受输入 | 同上（8 用例，含 posXZ/Infinity/undefined/数字字符串） |
| #54 | 计划任务只证"注册成功"，不证"真能跑" | **逻辑早已做了，本轮补测试** | `install-backup-task.ps1` 已实现 `Start-ScheduledTask` → 轮询 → **`LastTaskResult`** + **`backup-auto.log` 新增行** 双判据，并有 `-LogonType S4U`。缺的是**没有任何测试锁着它** | `scripts/tests/schtask-smoke.ps1`（8 用例）。从生产脚本**原样抽取**函数体，桩替换 3 个 cmdlet；**删掉 `$grew` 判据 → 场景② FAIL / exit 1** |
| #54-b | 计划任务"真能跑"（本机注册一次） | **只能真机** | 离线只能测"判定逻辑是否正确"，测不了"这台机器的 Task Scheduler 是否真的允许/真的执行"。而且**本任务明确不注册计划任务**（会改本机状态） | 见 §3 的命令，人工执行一次 |
| — | 板库 `user_version` 线上状态 | **做了**（只读脚本） | `tools/board_user_version_check.mjs`：`readOnly` 打开，查 `user_version` / 列齐全 / `claims` 唯一索引 / `quick_check`；不一致给修法。**落后只 WARN（不误报故障），超前才 FAIL** | 线上库实测：uv=3 与期望一致、26/26 列、`uq_claims_key` 在、`quick_check ok` → exit 0 |
| — | `memory.json` 真损坏 + `history` 捞回留证 | **做了** | `tools/history_corrupt_memory_unit.mjs`（25 用例，真文件不是 mock fs）：尾部截断→结构修复；尾部手改坏→部分抢救；整份乱码→认输但**必须留证**；顶层非对象→同损坏；健康文件不误判；版本戳过期只丢经验结论、保留地点 | 上述 25 用例；**把"改名留证"削弱成"删除" → ①②③ 全 FAIL** |
| #78 | `last_convo_truncated` 只置位不复位 | **不做（超出本任务边界）** | 属 `prompter.js` 的对话层状态机，与本任务「零散残留」的指定三项（#54/#76/#77）不是一组；且改动会碰成本/质量对账口径，需要单独一条任务 + 对账验证 | 见 §4「未做清单」 |
| #79 | `capSize` 每条 message 全量 `JSON.stringify` | **不做（同上）** | 属 `history.js` 的持久化性能路径。本任务只补「损坏捞回」的**测试**，不动 `save()` 的算法（改性能需要压测基线，纯改代码反而不可证） | 见 §4 |
| #80 | `routeResponse` 按名字判内部来源 | **不做（同上）** | 属 `agent.js` 路由层；修法要求把 `is_internal` 显式传下来，会动多处调用契约 | 见 §4 |
| #81–#87 | 端口/冷备 JDK/文档 `pwsh`/`release` 步号/保留策略/死副本 | **不做（同上）** | 都在 `scripts/*.ps1` 与 `README`，**与本任务指定的四项无关**；且 #83（多 JDK）与 #81（端口）已在 `e2e.ps1`/`start-panel.ps1` 的既有工作里处理，重复改会撞车 | 见 §4 |

## 2. 本轮"做了"的三条，各自防的是什么假修复

这一节是给复核用的，说明**为什么不能把"我改完了"当证据**。

### #76 — 判据从"有省略提示"升级为"字符上限是硬上限"

原来的测试（`contract_test.mjs`）只断言"截断后带省略提示、行数变少"。
于是"行裁剪把字符裁剪短路"这个 bug **完全测不出来**：提示有了、行数少了，但返回 25 万字符。

现在的断言是 `out.length <= 6000`。**用旧实现跑同一套断言 → 8 FAIL / exit 1**，FAIL 输出直接给出超限长度。

### #77 — 判据是"非法输入返回 null"，不是"没崩"

原代码 `Math.floor('a')` 不抛异常，返回 `{x:NaN}`，**看起来是正常返回值**。
下游 `path_3d` 拿到 NaN 才报 `NO_START`/`NO_PATH`，于是"传参错"被记成"寻路失败"。

现在断言 `normalizeTarget({kind:'block',pos:{x:'a',y:2,z:3}}) === null`。
旧实现跑出来的实际值在 FAIL 里显示为 `posXZ:{x:NaN,z:3}` —— 正是报告描述的症状。

### #54 — 测的是"生产里那份判定"，不是"我另写一份判定"

`schtask-smoke.ps1` **从 `install-backup-task.ps1` 第 59–81 行原样抽取 `Invoke-TaskSmokeTest`**，再注入桩。

为什么必须这样：如果测试里另写一份判定逻辑，生产脚本改了（比如有人把 `$grew` 判据删掉）测试仍会绿 —— 那就变成"测了个副本"。
现在删掉 `$grew` → 场景② 「日志没新增 → 判定失败」立刻 FAIL / exit 1。

另外它**不注册、不触发任何真实计划任务**：`Start-ScheduledTask` / `Get-ScheduledTaskInfo` / `Start-Sleep` 三个都在测试作用域内被桩覆盖。

## 3. 只能真机的那一条：怎么跑

逻辑已就位，**是否真的生效只能本机验一次**。以下命令会**改本机状态**（注册计划任务），所以我没替你跑：

```powershell
# 0) 先看当前有没有残留任务（只读）
Get-ScheduledTask -TaskName 'Minecraft-AutoBackup' -ErrorAction SilentlyContinue

# 1) 注册 + 立即冒烟（脚本默认就带冒烟；要"重启后未登录也跑"加 -LogonType S4U）
powershell -ExecutionPolicy Bypass -File scripts\install-backup-task.ps1 -LogonType S4U

# 2) 人工确认两条判据（脚本已经验过，这里是自己再看一眼）
Get-ScheduledTaskInfo -TaskName 'Minecraft-AutoBackup' | Select-Object LastTaskResult, LastRunTime
Get-Content logs\backup-auto.log -Tail 5     # 应看到本次冒烟写入的新行

# 3) 不满意就撤掉（也是改状态，请自行决定）
powershell -ExecutionPolicy Bypass -File scripts\install-backup-task.ps1 -Uninstall
```

判据（与脚本一致）：`LastTaskResult` 为 `0`（成功）或 `267009`（正在运行）**且** `logs/backup-auto.log` 有新增行。
只有前者 = 任务被启动了但没真的跑到 `backup-world.ps1`，**不算通过**。

> 为什么不能自动化：注册计划任务需要交互/管理员权限，且 `LastTaskResult` 依赖本机 Task Scheduler 的真实执行。
> 把它塞进离线门禁只会得到一个"永远绿或永远红"的假判据。

## 4. 未做清单（明确不做，不是漏掉）

| 条目 | 位置 | 为什么本轮不做 | 建议由谁做 / 前置 |
|---|---|---|---|
| #78 | `prompter.js:433-440` | 对话层状态复位，牵动成本/质量对账口径；本轮四项不含它 | 单独任务；需同时验证对账字段不再长期失真 |
| #79 | `history.js:367-381` | 持久化性能优化，需要压测基线才能证明"变快了"；本任务只补测试不动算法 | 有 `bench_*` 基线的任务 |
| #80 | `agent.js:926` | 要改 `routeResponse` 的入参契约（显式 `is_internal`），跨多处调用点 | 与 BOT-001「名字≠身份」同族，建议合并做 |
| #81 | `web/scripts/stop-all.mjs:98` | 属 `web/**`，**本任务明令不改 `web/**`** | 由能改 web 的任务做 |
| #82 | `backup-world.ps1:167-177` | 冷备判据要看项目绝对路径，需与 `start-panel` 的 `Get-ServerJava` 合并 | 与 #83 一起做（同一个"进程/环境识别"问题） |
| #84 | `README.md`、`clone-all.ps1` `.EXAMPLE` | 文档措辞统一（`pwsh`→`powershell`），量大但对正确性无影响 | 文档批处理 |
| #85–#87 | `release.ps1`、`backup-world.ps1`、`config/` 死副本 | 分别是步号打印、保留策略改回收站、清理 `.bak` 副本；都不在本任务的四项内 | 各自的运维任务 |

## 5. 一处必须留档的自我修正（写给下一个人）

**我把 `user_version` 检查的"关键列"硬编码了，结果线上库立刻假报警。**

- 我写的是 `['id','status','kind','created_at','payload','checkpoint']`；
- 真实列名是 `id, kind, parentId, title, skill, args, why, priority, source, assignee, requires, claims, state, attempts, maxAttempts, lease_owner, lease_until, progress, checkpoint, result, interrupted, notBefore, repeat_ms, dependsOn, createdAt, updatedAt`。
- **`status`/`created_at`/`payload` 一个都不存在** —— 那是别的项目（REST/ORM 那套）的命名。我凭印象套了上去，于是工具对着好库报 `FAIL 缺列`。

修法：不要硬编码，用代码自己的权威定义 —— `board_store.js` 的 `jobColumnDefs()`（它从 `SCHEMA` 解析出期望列）。
同一类问题还有两处，都已在实现里避开：
- 期望版本用 `import { BOARD_SCHEMA_VERSION }`，**不写字面量**（fix-team 会把 3 升到 4，写死就会假红）；
- `MEMORY_CODE_VERSION` 没导出，测试里从源码正则解析，不写 `5`。

**给下一个写校验脚本的人**：凡是要"断言结构/版本"，先找代码里的**单一权威定义**再去比。
凭记忆写列名/版本号，得到的一定是假报警 —— 而假报警比没检查更糟，它教人**忽略**报警。

## 6. 本轮改动清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `mindcraft/src/agent/library/contract.js` | 改 | #76 `truncate()`、#77 `floor3()`/`floorXZ()`（**只动这两个函数**；captain 已裁决该文件归 t8） |
| `mindcraft/tools/contract_truncate_unit.mjs` | 新增 | #76/#77 回归，13 用例，`*_unit.mjs` 自动进门禁 |
| `mindcraft/tools/history_corrupt_memory_unit.mjs` | 新增 | `memory.json` 损坏夹具 + `history.load()` 捞回留证，25 用例 |
| `mindcraft/tools/board_user_version_check.mjs` | 新增 | 板库 `user_version` **只读**体检（`readOnly` 打开） |
| `scripts/tests/schtask-smoke.ps1` | 新增 | #54 冒烟判定逻辑的离线验证（UTF-8 BOM，Parser 0 错，**不注册任务**） |
| `docs/audit-r6/fixes4/leftovers.md` | 新增 | 本文 |

**没碰**：`mindserver.js`、`board_*` 业务逻辑（只读检查除外）、`web/**`。
