# 文档索引

> **别按文件名猜，按下面的顺序读。**
> 最后更新：2026-10-31（文档分家：新规范入 `architecture/`，旧文档入 `legacy/`）

---

## 0. 一句话说清现在有两套

| 目录 | 状态 | 什么时候看 |
|---|---|---|
| **`architecture/`** | ✅ **新规范，唯一权威** | 想知道"该怎么做"。分层、契约、错误码、路线图全在这 |
| **`legacy/`** | ⚠️ 旧文档，**历史参考** | 想知道"当初为什么这么定"。与 `architecture/` 冲突时**一律以 architecture 为准** |

旧文档没有被删除，是因为里面有一批**已经落到代码里的事实**（接口命名、字段名、踩坑证据）。
它们现在的角色是"证据与教训"，不是"规范"。

---

## 1. 第一次接手？按这个顺序读

| # | 文档 | 为什么 |
|---|---|---|
| 1 | [architecture/00_overview.md](architecture/00_overview.md) | 新的六层架构、现状 vs 目标、本目录每份文档干什么 |
| 2 | [architecture/ARCHITECTURE_REDESIGN.md](architecture/ARCHITECTURE_REDESIGN.md) | **§6 是唯一契约来源**：返回结构 / 31 条错误码 / 字段白名单 / 参数命名 / 中断规则 |
| 3 | [architecture/REFACTOR_ANALYSIS.md](architecture/REFACTOR_ANALYSIS.md) | 现状哪里烂了，带行号证据；**§5 是勾选式验收清单，§3.4 是 D1–D13 台账** |
| 4 | [architecture/ARCHITECTURE_REDESIGN_PART2.md](architecture/ARCHITECTURE_REDESIGN_PART2.md) | 怎么测、分几期做（§11 Phase 表 = 按周排的执行清单） |
| 5 | [交接文档.md](交接文档.md) | 项目现状、怎么启动、已知限制（**仍在用**，preflight 会检查它是否过时） |

> ⚠️ **空着的部分（暂不补）**：`04_skills.md`、`06_task_queue.md`、`07_multi_bot.md` 不存在；
> `ARCHITECTURE_REDESIGN.md` 的 §7 配置 / §8 错误恢复 / §9 多Bot 三节未写。
> 已定：**不补新规范**——落地按 `REFACTOR_ANALYSIS.md §5` 的勾选清单 + `PART2 §11` 的 Phase 表执行；
> **多 Bot 协作模式后续再搭**。遇到这三块时按代码现状处理，别拿旧文档当规范。

---

## 2. 还有操作性价值的旧文档（`legacy/`）

这几份虽然降级为参考，但**内容仍然有效**，值得翻：

| 文档 | 为什么还值得读 |
|---|---|
| [legacy/经验教训.md](legacy/经验教训.md) | **15 类坑，每条都有实测证据**。跳过它就会重犯 |
| [legacy/改进规划.md](legacy/改进规划.md) | 四条不可谈判的约束（规则必须有出处 / 标准流程 / 原子化 / 不重复造轮子）+ 四支柱方法论 |
| [legacy/标准流程-v2.md](legacy/标准流程-v2.md) | 实操五步闭环：证事实→定契约→量基线→改一层→记账 |
| [legacy/验收记录.md](legacy/验收记录.md) | 所有实测数字（不写感受，只写数字） |
| [legacy/原子接口标准.md](legacy/原子接口标准.md) | `{kind,...}` 目标对象、`normalizeTarget`、opts 命名**为什么这么定** |
| [legacy/字段标准.md](legacy/字段标准.md) | 返回字段字典（`pos` / `distEyeToBlock` / `standable`）；新规范 §6.3 的字段名出自这里 |
| [legacy/原子动作规格-v2.md](legacy/原子动作规格-v2.md) | 每个原子的前置/后置写得很细，可当"验收清单"参考（注意它的错误码只列了 12 条，现已扩到 31 条） |
| [legacy/技能返回值契约.md](legacy/技能返回值契约.md) | "动作类返回 boolean、查询类返回对象"的由来，以及**为什么曾试图统一成对象又回滚** |

### 纯历史（基本只用于追溯）

| 文档 | 内容 |
|---|---|
| [legacy/陪玩改造方案.md](legacy/陪玩改造方案.md) | 最初的方案设计（历史起点） |
| [legacy/02_actions.md](legacy/02_actions.md) | 动作层 40-50 个（**六层架构中该层已取消**，只当能力盘点表看） |
| [legacy/原子动作规格.md](legacy/原子动作规格.md) | 更旧的规格，已被 -v2 取代 |
| [legacy/复合层改造规划.md](legacy/复合层改造规划.md) | plan/runSteps 的契约（对应现在的 task 层） |
| [legacy/原子层清理规划-拆分collectDrops.md](legacy/原子层清理规划-拆分collectDrops.md) | 为什么把 collectDrops 拆成三个原子 |
| [legacy/原子层清理规划-移动与攀爬.md](legacy/原子层清理规划-移动与攀爬.md) | 移动与攀爬为什么必须分开 |
| [legacy/原子层清理规划-移动与攀爬拆分.md](legacy/原子层清理规划-移动与攀爬拆分.md) | 上一份的细则（`climbTo` 已撤回） |
| [legacy/原子层缺口清单.md](legacy/原子层缺口清单.md) | 缺口清账（大部分已解决） |
| [legacy/并发协调机制.md](legacy/并发协调机制.md) | 早期的并发协调设想 |
| [legacy/技术总结.md](legacy/技术总结.md) | 阶段性技术总结 |
| [legacy/项目调研.md](legacy/项目调研.md) / [legacy/Minecraft-AI-项目调研.md](legacy/Minecraft-AI-项目调研.md) | 上游项目调研 |
| [legacy/readme-upstream.md](legacy/readme-upstream.md) | 上游仓库 README 存档 |

---

## 3. 根目录里仍在用的两份

| 文档 | 为什么留在根目录 |
|---|---|
| [交接文档.md](交接文档.md) | 现况手册；`tools/preflight.mjs` 会比对它与代码的提交时间，提示是否过时 |
| [自研申报.md](自研申报.md) | **20 条自研申报**：为什么不重复造轮子，每条列出检索过的候选；`tools/audit_rules.mjs` 靠它检查新模块有没有申报 |

> 这两份是**工具依赖**，别挪位置——挪了 preflight / 新模块审计会静默失效。

> 部署类文档（`本地部署说明.md` / `部署指南.md` / `部署与改造记录.md`）含本机路径与私有端点配置，
> 已从公开仓库移除并加入 `.gitignore`，只保留在本地。部署请以仓库根目录的 `README.md` 为准。

---

## 4. Bug 记录

| 文档 | 一句话 |
|---|---|
| [bugs/BUG-001-tp物理崩溃.md](bugs/BUG-001-tp物理崩溃.md) | tp 超过 5 格 → 客户端物理算出 NaN → 被踢。**升级 mineflayer 4.39 解决** |
| [bugs/BUG-002-判据基准错位.md](bugs/BUG-002-判据基准错位.md) | 用任务级基准判断单次调用 → 第一次成功后再也不干活（静默失效） |
| [bugs/BUG-003-远处区块不掉落.md](bugs/BUG-003-远处区块不掉落.md) | 远处区块"挖了不掉落物"。待实测确认 |

---

## 5. 三条最重要的结论（如果只记三件事）

**1. 规则必须有出处，不许凭想象。**
`src/agent/rules/game_rules.json` 里 18 条规则，每条带 R1/R2/R3 来源级别和证据脚本。
没有出处的判断不许进代码。这条是从"凭空写树会塌、白写 110 行"换来的。

**2. 允许升级依赖，优先于自己打补丁。**
BUG-001 花了 3 小时调服务端配置、写物理兜底，全没用；查了一下 npm 有没有新版本，问题消失。

**3. 原子要最小但可维护，不是越小越好。**
"爬一格"这种原子在藤蔓上物理不成立（松手就滑落），拆太细反而不可维护。

---

## 6. 测试怎么跑

```bash
cd mindcraft
node tools/preflight.mjs      # 四层自检：导入 / 冒烟 / 规则审计 / 新模块申报
node tools/atom_all.mjs       # 全套：18/18
```

需要 Minecraft 服务器在跑（测试服 25566 + RCON 25576）。
