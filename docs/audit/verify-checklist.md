# 复核清单 v2（t14 独立复核第二轮）

对象：`docs/audit/00-REPORT.md` **v2**（34 条硬发现 + S1~S45 + 第四节「实测 vs 推断」34 行总表）。
方法：逐条打开 `文件:行号` 读原文；`grep -n` 复核；`od -c` 验字节；`ls probes/` 核对证据存在性；`grep` 核对分册↔主报告一致性。
**未改任何被审查源码**（`mindcraft` git 工作树为空），只写 `docs/audit/`。

> **v1 复核（t8）的结论仍然有效**，摘要见文末 §F，不再重复 20 条逐项。

## 结论摘要

| 项 | 数 |
|---|---|
| 核对条目 | 34 条硬发现 + 第四节 34 行状态表 + 07/08/09/10 四份分册↔主报告一致性 |
| **v1 编号稳定性** | **稳定 ✅**（1~20 编号与顺序未变；21~34 连续、无重复、无缺号；`uniq -d` 为空） |
| **改判（状态标签）** | **5 条**：21 / 22 / 28 / 30 / 32「已实测（队长亲验）」→ **静态确证** |
| **状态拆分** | **1 条**：第 1 条 →「已实测（沙箱逃逸）/ 静态确证（无认证）」 |
| **修正内容** | **1 处**：第十四节路线图 E2 行把"修法"写成了"现状"（与代码相反） |
| **未并入且未登记** | **4 条**：08 的 E3/E4/E5/E6 |
| **补记缺口** | **2 条**：07 越权表第 7 行（读文件）、12 的 W1/W2（拆农田 / breakBlockAt 零判定） |
| **删除条目** | **0 条** |
| 统计口径变化 | 已实测 **15 → 10**、静态确证 **19 → 24**、仍为推断 **0** |

**一句话**：编号稳、无捏造。问题不在编造，而在**5 条"队长读代码确认"被标成了"已实测"**，以及**两条新分册的结论没进主报告也没登记**。

## A. 第四节「实测 vs 推断」34 行逐条核对

判定口径照抄总表自己的定义：**已实测 = 本仓库真的跑出过输出，能在 `09-empirical.md` 或 `probes/` 找到命令与结果**。**"读代码看出来的"一律算静态确证。**

| 编号 | 原标 | 复核结果 | 依据 / 复现方式 |
|---|---|---|---|
| 1 无认证 + 沙箱可逃逸 | 已实测 | **修正：拆分** | 逃逸 ✔ 真实测（`probes/captain-verify-ses-escape.mjs`/`-escape2.mjs`）；**无认证那半**被 `09-empirical.md:397` §6.1 自己写成「静态确证，无法实弹」→ 拆为「已实测(逃逸)/静态确证(认证)」 |
| 2 profile 路径穿越 | 已实测 | 通过 | `probes/p6_path_traversal.mjs` 存在；09 §6.2 有落点输出 |
| 3 板库当坏库重建 | 已实测 | 通过 | `p2_lockholder.mjs`/`p2_lockholder_exclusive.mjs`/`p2_openboard.mjs` + `probes/run/lock{2,3,4}.log` 三份输出齐备；09 §2.2 |
| 4 finish 不校验租约 | 静态确证 | 通过 | `board_store.js:637-659` 只 `WHERE id=?`，对照 `heartbeat():503-504` |
| 5 依赖死→父单 running | 已实测 | 通过 | 板库 166 分钟 + `t59:120/236/261`（我 t5/t16 亲手复核） |
| 6 !stop 对任务板无效 | 静态确证 | 通过 | `board_scheduler.js:655` / `action_manager.js:91` / `control.js:242` / `runJobAction` 零调用方 |
| 7 重启守卫 10 秒 | 已实测 | 通过 | `run-live.err.log` 末行（我 t5 亲手读） |
| 8 地标保护恒空+假测试 | 静态确证 | 通过 | 读 `c?.pos` vs 写扁平（我 t16 复核 `landmarks.js:78` vs `:131`） |
| 9 导航闸 adhoc | 已实测 | 通过 | `t59:164/:180`（我 t5 亲手读） |
| 10 digTunnel ok 未 import | 已实测 | 通过 | `p3_reference_errors.mjs` case 1；`npx eslint` `5750:12 no-undef`（我 t8 跑过） |
| 11 门禁无触发点+两行错 | 已实测 | 通过 | `npx eslint src/` = 319 errors；`src/models/` 20 条 Parsing error（我 t8 跑过） |
| 12 日志无时间戳 | 已实测 | 通过 | `grep -cE '^\[[0-9]{2}:'` → 0/293、0/85（我 t5 跑过） |
| 13 surveyArea r=64 | 静态(+反证实测) | 通过 | `:5402`/`:5428`；反证 `run-live.log:39` 162ms |
| 14 LIMIT 200 | 静态确证 | 通过（抽查） | `:378-382` + `:1082` |
| 15 expireLeases 不记 attempts | 静态确证 | 通过（抽查） | `:668-684` UPDATE 无 attempts |
| 16 箱子读改写 | 静态确证 | 通过（抽查） | `flow_store.js:74-88` 两次 await |
| 17 幽灵父单 | 静态确证 | 通过（抽查） | `:1175-1207` 无事务 + `:1114` |
| 18 42 个孤儿测试 | 已实测 | 通过 | `ls tools/test_*.mjs`=44、注册 2 个（我 t8 跑过） |
| 19 退出码>1 杀 mindserver | 静态确证 | 通过 | `agent_process.js:37-40` |
| 20 skills 与原子层分叉 | 静态确证 | 通过 | `11-skills-rest.md` §2 全表（98 条零未核实） |
| **21 技能能攻击玩家** | 已实测 | **改判→静态确证** | 09/probes **零命中**（`attackNearest` 的 3 次命中全在 §3.3 讲 ReferenceError）。内容我复核**成立**：`act_attack.js:31-35` 含 `'player'`；`grep -c isAttackable skills.js` = **0** |
| **22 giveToPlayer 恒真** | 已实测 | **改判→静态确证** | 09/probes 0 命中。内容**成立**：`:1609` `waitUntil(...)` 返回对象 → `:1611 if (got)` 恒真 |
| 23 levelGround 拆农田+凭空造方块 | 静态确证 | 通过 | `NATURAL_BLOCKS:3361` 含 `farmland`（我 t16 亲手读）；`:3433` `/fill keep` |
| 24 schema 不匹配走重建 | 已实测 | 通过 | 09 §2.3 有 `no such column` 真实输出 |
| 25 memory_store 静默清空 | 静态确证 | 通过 | 12 分册 §memory_store（我 t16 亲手读 `:87-90`） |
| 26 preflight 0x08 假绿灯 | 已实测 | 通过 | `probes/t13-regex-check.mjs` 存在；**本轮 `od -c tools/preflight.mjs:183` 见 `/ \b f a i l`（单字节 0x08），两行合计 13 处** |
| 27 索引/棘轮盯过期对象 | 静态确证 | 通过 | 10 分册 F1+F2 合并；`audit_baseline.json count=14` vs 实测 5 |
| **28 useToolOn 恒假守卫** | 已实测 | **改判→静态确证** | 09/probes 0 命中。内容**成立**：`skills.js:2760` 运算符优先级错 |
| 29 两处 bot.chat 绕过白名单 | 静态确证 | 通过 | `:1029` `bot.chat(msg)`、`:4000` `bot.chat(cmd)`（本轮亲手 sed 核对） |
| **30 novita.js:47 缺 this.** | 已实测 | **改判→静态确证** | 09/probes 0 命中。内容**成立**：`novita.js:47` vs `deepseek.js:44` 对照 |
| 31 伪造兜底串+零 usage | 静态确证 | 通过 | 16 处伪造串；`grep usage × src/models` = 0 |
| **32 心跳无 try/catch** | 已实测 | **改判→静态确证** | 09/probes 0 命中。**内容我未逐行复核**（`agent.js:807-820` 本轮未打开）→ 只改状态、不背书内容 |
| 33 goToGoal 180s 不可中断 | 静态确证 | 通过（抽查） | `:1794` 常量 + 全文无 interrupt |
| 34 preflight loaded 不校验 | 静态确证 | 通过 | `:72-80` |

**「仍为推断」0 条**：与总表一致；未发现措辞暗示已验证的条目。

## B. v1 编号稳定性

| 检查 | 结果 |
|---|---|
| 34 条全部存在 | ✅ `grep -cE "^## [0-9]+ "` = 34 |
| 无重复 | ✅ `uniq -d` 为空 |
| v1 的 1~20 编号未变 | ✅ 逐条比对（第 3/10 条标题微调，编号与语义未变） |
| v1 的修正未被回退 | ✅ 第 11 条仍是"6 处"（t8 的修正保住）；第 3 条仍无"面板在写" |
| 21~34 连续 | ✅ 21..27 = Must，28..34 = Should |

**注意（排版后果，不是重排）**：物理顺序是 `1..12, 21..27, 13..20, 28..34` —— 新增 Must 插在 13 之前。按编号查没问题；**按段落顺序读会从 12 跳到 21**。建议在"二、Should fix"开头注明"本节含 v1 的 13~20 与 v2 新增的 28~34"。

## C. 07~10 ↔ 主报告一致性

| 分册 Must | 去向 | 结果 |
|---|---|---|
| 08 E1（follow 超时参数没接上） | §八 失控面 表首行 | ✅ 并入 |
| 08 E2（digdown 液体假成功） | 仅第十四节路线图 | ⚠️ **描述与代码相反**（见 D1） |
| 08 E3/E4/E5/E6 | 无 | ❌ **零命中且未登记**（E3 建议进 S 组；**E5 建议并入第 1 条**） |
| 10 F1/F2（索引/棘轮盯过期对象） | 第 27 条（合并） | ✅ 并入 |
| 07 D1（SES 3 行逃逸） | 第 1 条第三层 | ✅ 并入并升级为已实测 |
| 07 D2~D5（digTunnel/命令绕过/箱子计数/熔炉覆盖） | 第 10 / 29 / 16 / S 组 | ✅ 并入 |

## D. 两处需要修的内容

**D1（唯一的内容性错误）** 第十四节路线图 E2 行原文：
> 「**E2** | **`digdown` 液体假成功**（`executor.js:344` 设 `liquidBlocked`、`:363` 返回 `BLOCKED`）」

这是把**修法**写成了**现状**。实际代码：`:342-345` 遇液体只 `break`（**不设** `liquidBlocked`），`:363` 是 `return ok({ dug })`；`liquidBlocked` / `BLOCKED` 只存在于**同文件 `dig` 分支**（`:243` / `:312-314`）——这正是 08 报告的核心论点（"dig 修过的坑没同步到 digdown"）。读这一行的人会以为 bug 已不存在。
**应改为**：「`digdown` **缺** `dig` 分支已有的守卫；修法：照抄 `:243` 的 `liquidBlocked = true` + `:312-314` 的显式 `BLOCKED`」。

**D2** 07 越权表第 7 行「读文件系统」（`describeSchematic(bot,'../../settings.js')` / `listBlueprints('C:/Users')`）在主报告 **`grep` 零命中**。它走**正常 skill API + 路径穿越**，**不需要逃逸沙箱** → 见 E。

## E. 对第 1 条定级的专门结论（任务 D）

**定级够，不必再升；但覆盖面要补一块。**

- **够的部分**：第 1 条已从"缺认证 + 沙箱未审计"升级为「**认证补上也没用**」：实测三行 `skills.log.constructor('return process')()` → `world.constructor.constructor('return require')()` → `child_process.exec(...)`，宿主 `process.version`=`v24.16.0` / `platform`=`win32` 是真输出。这正面回答了"认证补上了模型依然能拆家"——**不只是拆家，是任意代码执行**。
- **缺的部分**：① **读文件**（07 §3.5 第 7 行）不需要逃逸沙箱，`allow_insecure_coding=false` 时依然可用；② **拆家**有专门的 API 路径（12 的 W1/W2：`levelGround` 白名单含圆石/泥土/农田、`breakBlockAt` 零判定），主报告只有第 23 条提到 `levelGround` 拆农田。
- **两者都加强而非削弱**第 1/23 条。建议：第 1 条第三层后加一句"另有不依赖沙箱逃逸的同类路径：`describeSchematic`/`listBlueprints` 路径参数未做根目录约束"；W1/W2 并入第 23 条（避免第 8/23 被拆成三条）。

## 复现命令（本轮实际用过）

```bash
cd "E:/我的世界ai/docs/audit"
grep -cE "^## [0-9]+ " 00-REPORT.md; grep -oE "^## [0-9]+ " 00-REPORT.md | sort | uniq -d
for p in giveToPlayer useToolOn novita 心跳 agent.js:807; do grep -c "$p" 09-empirical.md; done
grep -l "giveToPlayer\|useToolOn\|novita\|attackNearest\|heartbeat\|807" probes/*.mjs
cd ../../mindcraft
sed -n '31,35p' src/agent/library/act_attack.js; grep -c isAttackable src/agent/library/skills.js
sed -n '1605,1612p;2758,2762p' src/agent/library/skills.js
sed -n '45,49p' src/models/novita.js; sed -n '42,46p' src/models/deepseek.js
sed -n '183p' tools/preflight.mjs | od -c | head -3
sed -n '1028,1029p;3999,4001p' src/agent/library/skills.js
```

## F. 本轮做不到的

- **32 心跳**（`agent.js:807-820`）只改了状态标签，**未逐行复核内容**——若实际写法与描述不符，需下一轮确认。
- 第 1 条"无认证"那半**仍无法实弹**（mindserver 未运行、任务禁止启动）。该限制来自 `09-empirical.md:397`，我未突破，也未假装突破。
- 本轮**没有跑 `npx eslint`**（不需要，319 的结论已在 t8/t13 两次取得）；只用 grep / sed / od。

---

## G. v1 复核（t8）结论摘要 —— 仍然有效

对象是 v1 的 20 条。当时总账：**删 0 / 降 0 / 修正行号路径 4 / 修正数字 5 / 加强表述 2 / 删错误表述 1 / 无法独立验证 4**。

六条必验断言的 v1 结论（本轮未推翻）：
- **a** `skills.js:5750` `ok` 未 import → **成立（机器验证）**：`npx eslint` 报 `5750:12 'ok' is not defined`。
- **b** `modes.js:118/126 placed`、`:133 walked`、`res` → **成立**；**路径修正**：`res` 在 `src/agent/npc/item_goal.js`（不是 `library/`）。
- **c** `eslint.config.js:17` `globals.browser` / `:18` `ecmaVersion: 2021` → **成立**：`src/models/` 20 条 Parsing error。
- **d** 测试夹具 `{pos:{…}}` vs 生产扁平 → **成立（静态）**；绿路径本机 EPERM 不可执行。
- **e** `board_store_converge_unit.mjs:218` XFAIL ②-6 → **部分成立**（同一根因，断言对象不同）。
- **f** `nav_lock_unit` 零 `adhoc` → **成立**。

v1 当时那 4 项"无法独立验证"（板套件 EPERM、`SQLITE_BUSY` errcode、`!newAction` 实弹、父单时间戳动态），其中 2 项在 v2 已被 `09-empirical.md` 落地为实测（板套件 188 用例全 PASS、B5 的 lock 实测），**这是 v2 相对 v1 的实质进步**。
