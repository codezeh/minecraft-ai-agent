# 提交地图（finding → sha → 文件）

> 采纳复核席建议：**归属清晰 = COMMIT-MAP + body 分节，不是一个 finding 一个 commit**。
> 本表是**机器可读的权威答案** —— 查某条 finding 改了哪些文件、在哪次提交，看这里，不要翻 diff。

> 规则（PLAYBOOK §8.14）：**一个 commit 一个可独立回滚单元**。
> 同文件交织改动天然是一个回滚单元，硬拆会产生"单独 revert 都会坏"的提交，反而降低可回滚性；
> 归属清晰靠本表 + body 分节解决。跨文件 / 跨子系统时仍坚持拆开。

> ⚠️ **已知的混提交（如实登记，不改写历史，理由见 PLAYBOOK §8.13）**：
> - `7ba7b5e` 标题写 F-DEP-004，实际**还含 F-DEP-003 的 patches 补丁对**（前一次提交被 pre-commit 拦下，文件留在暂存区被带走）
> - `69b3a14` 标题写 F-RT-002，实际含 **F-WEB-201/202/203/204/101** 五条（提交信息含反引号触发 shell 替换导致 commit 失败，随后一次无 pathspec 的提交把暂存内容一并带走；已 amend 修正信息）
> - `62a93a5` / `76ee07b` / `9e7253c` 各含 2 条

生成时间：2026-11-06 02:50

## mindcraft 仓（分支 audit/night-20261106，相对 main）—— 共 22 个提交

| sha | 时间 | finding | 主要文件 |
|---|---|---|---|
| `7a5e5d0` | 01:46 | F-DEP-003 | patches/mineflayer+4.33.0.patch / patches/mineflayer+4.39.0.patch |
| `4c006bc` | 01:46 | F-DEP-004 | patches/SHA256SUMS / tools/patch_integrity.mjs |
| `7331ba5` | 01:46 | F-DEP-005 F-DEP-103 | package.json |
| `119f45f` | 01:47 | F-DEP-005 F-DEP-012 | start.bat |
| `58d2fb1` | 01:56 | F-SEC-206 | .gitignore |
| `8c983c4` | 01:56 | F-SEC-208 | tools/server-net.mjs |
| `62a93a5` | 01:56 | F-SEC-104 F-SEC-205 | src/mindcraft/mindserver.js |
| `76ee07b` | 02:02 | F-SEC-205 F-SEC-206 | .gitignore / src/mindcraft/mindserver.js |
| `7ba7b5e` | 02:18 | F-DEP-004 | patches/SHA256SUMS / patches/mineflayer+4.39.0.patch / tools/patch_integrity.mjs |
| `9e7253c` | 02:18 | F-DEP-004 F-REG-001 F-RT-002 F-SEC-205 | start.bat |
| `d42f796` | 02:19 | F-EXEC-201 | src/agent/speak.js / src/mindcraft/auth_gate.js / tools/mindserver_gate_unit.mjs |
| `c8df8ce` | 02:19 | F-AI-202 | src/agent/permissions.js / src/models/prompter.js / tools/permissions_unit.mjs |
| `7d15339` | 02:19 | F-REG-001 F-SEC-205 | src/agent/mindserver_proxy.js |
| `69b3a14` | 02:23 | F-REG-001 F-RT-002 F-WEB-101 F-WEB-201 F-WEB-202 F-WEB-203 F-WEB-204 | src/mindcraft/mindserver.js / start.bat |
| `0ecc241` | 02:26 | F-WEB-201 F-WEB-203 | src/mindcraft/mindserver.js |
| `8268c50` | 02:31 | （无单：复核必改项/文档） | src/mindcraft/mindserver.js |
| `6f46182` | 02:36 | F-AI-201 | src/agent/permissions.js / src/models/prompter.js / src/utils/text.js |
| `125b244` | 02:36 | F-AI-203 | src/agent/history.js |
| `08e0f65` | 02:36 | F-EXEC-202 F-EXEC-204 | src/agent/tasks/tasks.js |
| `bfdaca8` | 02:37 | F-AI-201 | src/agent/permissions.js |
| `2a4f80e` | 02:47 | F-AI-205 | src/agent/agent.js |
| `bdba2e6` | 02:47 | F-DEP-003 F-RT-001 F-RT-003 F-RT-005 F-WEB-202 F-WEB-203 | src/agent/library/tool_prep.js / src/mindcraft/mindserver.js |

## 外层仓（分支 audit/night-20261106，仅修复类）—— 共 7 个提交

| sha | 时间 | finding | 主要文件 |
|---|---|---|---|
| `49a9cfd` | 01:56 | F-SEC-201 F-SEC-206 | .gitignore |
| `5e2694b` | 01:56 | F-SEC-205 | scripts/start-panel.ps1 |
| `25d83fd` | 02:02 | F-SEC-206 F-SEC-209 | server/server.properties.example |
| `7b8cbb2` | 02:02 | F-SEC-206 | .gitignore |
| `2e84818` | 02:26 | F-WEB-201 F-WEB-203 | scripts/start-panel.ps1 |
| `f8496a9` | 02:26 | F-SEC-205 F-WEB-205 | scripts/stop-panel.ps1 / web/scripts/stop-all.mjs |
| `5013250` | 02:31 | （无单：复核必改项/文档） | scripts/start-panel.ps1 |

## 怎么用这张表

- 想知道某条 finding 改了什么：在表里搜 id。
- 想回滚某条修复：`git revert <sha>`（注意混提交会连带回滚同提交的其它 finding，见上方清单）。
- **想确认"这条到底修没修"：不要看本表判断** —— 去看 `queue/verified/` 里那份单有没有 `## review` 段。有才算复核通过。
