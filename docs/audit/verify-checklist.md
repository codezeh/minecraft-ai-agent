# 复核清单 R2（终审第二轮 · 独立复核 · t28）

对象：`docs/audit/21-review-r2-verdict.md`（终审 R2④ 汇总）+ 分册 `18`/`19`/`20` + R1 结论 `17-review-r1-verdict.md`。
分支：`mindcraft` `audit/remediation-2026-11-05`（相对 `main` **26 提交 / 138 文件**）。
方法：`node` 直跑探针 / 副本注入后跑门禁 / `grep -n` 定位 / 读 `git diff --stat` 最大改动文件。
**未改 `mindcraft/` 任何文件**（`git status` 为空），只写 `docs/audit/`。

> R1 复核（t23）台账已被本文件取代；R1 的结论仍有效，摘要见 §G。

## 结论摘要

| 项 | 结果 |
|---|---|
| **我的最终判定** | **`PASS`** —— 与主编**一致** |
| 抽检条数 | **12 条**（要求 ≥12），覆盖全部高危"真修好"项与 R1 遗留项 |
| 抽检结果 | **12/12 成立**，主编无虚报 |
| 三态需降级 | **0 条** |
| 九条遗漏处置 | **全部合格**（0 条"下轮再说"、0 条悬空） |
| 修出新问题 | **0 条**（读三处最大改动未发现新缺陷） |
| BLOCK 项 | **0**（主编判定为空，我复核后仍为空） |
| 新增方法学问题 | **2 条**（exit 码管道陷阱、npx 替代直跑法） |

## A. 我自己跑的 4 个关键探针（不转述分册）

| # | 探针 | 我的真实输出 | 判定 |
|---|---|---|---|
| 1 | **沙箱逃逸** `node docs/audit/probes/t19-ses-escape-review.mjs` | `===== 汇总：BLOCKED=20  ESCAPED=0  其余(探测类)=6 =====` | 逃逸**真关住** |
| 2 | **板库 schema 不匹配** `node docs/audit/probes/t20-board-open.mjs schema <dir>` | `rebuilt=false`；`migration={"added":["interrupted","repeat_ms","dependsOn"],"from":1,"to":2}`；`行数 前=1 后=1` | **不丢数据** |
| 3 | **门禁错误码**（副本 `r1/t26` 注入 `fail("ZZT28DQ")` —— **双引号 + 含数字**） | `✗ 有 1 个错误码没注册：ZZT28DQ` + `← src\agent\library\query_classify.js` | R1 版**两个盲区同时命中**，说明 R1-b 真修 |
| 4 | **lint 门禁** 注入 `undefinedVarT28` + `node mindcraft/node_modules/eslint/bin/eslint.js --config …` | `131:35 error 'undefinedVarT28' is not defined  no-undef`；另 `node tools/lint_hard.mjs` 跑不动时**真实 exit=1** | 规则**活着** + **fail-closed**，不是假绿 |

## B. 抽检 12 条明细

| 编号 | 主编判定 | 我的复核 | 依据 |
|---|---|---|---|
| 第 1 沙箱 | 真修好 | **成立** | 探针 1（27 向量 20 BLOCKED / 0 ESCAPED） |
| 第 3/24 板库 | 真修好 | **成立**（⚠️我是 t25 作者，仅复跑） | 探针 2 |
| R1-b / 第 26 正则 | 真修好 | **成立（用最难一例）** | 探针 3 |
| 第 11 lint 接线 | 部分修好 | **成立** | 探针 4 |
| 第 20③ `waitUntil` 包装 | 真修好（最危险回归点） | **成立** | `atom_wait.js:25` 语义"返回非 undefined/null 即完成（false 也算）"；`skills.js:60-62` 把陷阱写进注释；**唯二真实调用点** `:529`/`:1674` **都写 `\|\| undefined`**；全仓无裸 `waitUntil(bot, () => cond)` |
| R1-a / I6 提示词落盘 | 真修好 | **成立** | `hyperbolic.js:50` `if (process.env.LOG_PROMPTS === '1')`；全仓未注释的 `console.log('Messages:` **仅此一处** |
| I7 孤儿进程 | 收录 R2-1（仍存在） | **成立** | `mindserver.js` 退出 = `stopAgent()` 循环 + `globalThis.process.exit(0)`，**不 await 子进程 exit**；全仓 `process.on('exit'/SIGINT/SIGTERM)` = **0** |
| S35 死配置 | 已删 | **成立** | `grep -c NAV_ALLOWED_ACT_FUNCS preflight.mjs` = 1，且该条是**注释** `:835 "已删除"` |
| 第 27 文档索引 | 部分修好（已收 2 份） | **成立** | `README:136` 架构交接-总 = 现况手册；`:137` 交接文档 = ⚠️ 历史快照 |
| `ac477f3` 垫脚 id | 真修好 | **成立（我独立复算 id）** | `scaffold_blocks.js:99` 只用 `itemsByName`；实测 1.21.8 `dirt block=9/item=28`、`cobblestone 12/35`、`oak_planks 13/36` |
| I14 `task_id` 穿越 | 已修 | **成立**（⚠️t25 已核） | `task_id='logs/../../../../tmp/x'` → `THROW 路径逃逸已拦截` |
| 第 15 产出账 | 真修好 | **成立**（⚠️**作者，不作独立判定**） | 仅复述 t25 的 16/16 与 board 253 用例/0 失败，不背书 |

## C. 反向检验：PASS 是否过松（五面）

| 面 | 我的动作 | 结果 |
|---|---|---|
| 沙箱真关 | 自己重跑 | 20/0 ✓ |
| 板库不丢 | 自己造 schema 不匹配 | rebuilt=false、1→1 ✓ |
| 门禁真绿 | 自己注入双引号+数字码 | 抓到并点名 ✓ |
| lint 真接线 | 自己注入 no-undef | 规则活 + lint_hard fail-closed ✓ |
| 138 文件有漏掉逻辑错误 | 读最大三处 `board_store(+626)` / `skills(+486)` / `preflight(+362)` | 未发现新缺陷；`waitUntil` 语义与 `scaffold` id 两个危险点都被作者主动处理 ✓ |

**未发现"该 BLOCK 却被放过"的项。**

### C.1 两条方法学产出（建议进规程）

1. **`$?` 管道陷阱**：我第一次测 `lint_hard` 用 `node tools/lint_hard.mjs 2>&1 | tail -6; echo EXIT=$?` → 得到 **EXIT=0**，看上去像"门禁跑不动却返回成功"的假绿（BLOCK 级）。改成 `> file 2>&1; echo EXIT=$?` → **真实 exit=1**。`$?` 取的是管道末端（`tail`）的码。
   → **凡断言 exit 码，命令里不许有管道。**
2. **`npx` 不可用时的直跑法**：本会话 `npx` EPERM（npm 连 cache 都写不了），但 `node mindcraft/node_modules/eslint/bin/eslint.js --config mindcraft/eslint.config.js <file>` **可跑**。t26 当时只能给 lint 的"组件级证据"，用这个直跑法可以**真注入真跑**。

## D. 九条遗漏项处置合格性

| 编号 | 处置 | 合格 | 备注 |
|---|---|---|---|
| I6 | 已修 + 证据 | ✅ | 我独立复跑确认 |
| I14 | 已修 + 证据 | ✅ | t25 实测 |
| I7 | 收录 R2-1 | ✅ | 四项齐全（现状行号/定级/最小修法/验证法）；我复核"仍存在"成立 |
| I8 | 收录 R2-2 | ✅ | 四项齐全 |
| I15 | 收录 R2-3 | ✅ | 四项齐全 |
| I17 | 收录 R2-4 | ✅ | 四项齐全 |
| I18 | 收录 R2-5 | ✅ | 四项齐全，且如实写"部分缓解" |
| I19 | 收录 R2-6 | ✅ | 四项齐全，如实写"部分缓解" |
| I21 | 收录 R2-7 | ✅ | 四项齐全（Nice） |

**"下轮再说"式敷衍：0 条。** 9 个 I 编号各出现 1 次、无重复无遗漏。另 R2-8/R2-9 是主编自查残留，也给了号——**比规程要求更好**。

## E. 对「43% 不可追溯」的看法：**这是加分项**

主编明写 `49+32+9+68=158` 自洽，且**没有**把 68 条含糊成"已合并"，而是写"**无法证明被覆盖**"并指出根因（v1/v2 从未建映射表）。
→ 这 68 条是**报告体系的历史债，不是本轮代码风险**；不挡合并，但应作为下一轮元任务（补映射表）。

## F. 做不到的

- `unit_all` 全量（EPERM，`0/64` 不是失败）；socket 实弹（需启动 mindserver）；真机跑一局看任务板端到端。
- 第 15 / 3 / 24 / I14 / I7 五项因**我是 t25 作者**，只做复跑与行号核对，**不充当独立判定**。

## G. R1 复核（t23）结论摘要 —— 仍有效

R1 总账：改判 5（把"队长亲验"的 5 条从已实测降为静态确证）/ 状态拆分 1 / 修正内容 1 / 未并入且未登记 4 / 补记缺口 2 / 删除 0；R1 编号稳定。
R1 提的 N1（`hyperbolic.js:47` 提示词无条件落盘）与 N2（preflight 正则词法盲区）**已在 R2 的 `5d28800` 修掉**，本轮我复跑确认（探针 3 + §B 第 6 项）。
