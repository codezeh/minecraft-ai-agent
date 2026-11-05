# 审计与执行记录 · 归档约定

> 最后更新：2026-11-05（t6 收尾，起因：`R1-收尾-gate.md` 曾误落在 `mindcraft/` 内）

---

## 1. 唯一归档位置（硬规则）

**审计与执行记录一律放外层仓 `E:/我的世界ai/docs/audit-执行/`。**

两个仓的分工是**一边倒**的，没有例外：

| 仓 | 角色 | 放什么 | 不得放什么 |
|---|---|---|---|
| `E:/我的世界ai/`（外层仓） | **审计方 / 记录方** | `docs/audit/`（审查报告、verdict、probes）、`docs/audit-执行/`（每次执行的台账与证据）、`scripts/`、`config/`、`web/`、`server/` 配置 | 被审项目的源码 |
| `E:/我的世界ai/mindcraft/` | **被审对象** | 项目自己的 `docs/`（架构规范、交接文档、runbook）、源码、测试 | **任何审计文档**（本目录的东西一份都不许进） |

**为什么不是"随便放哪都行"**：把审计记录塞进被审对象里，等于**证据写在被告口袋**。
后果很具体：下一轮换人审，按惯例只翻外层仓 `docs/audit-执行/`，就会**漏掉** mindcraft 里那份，
于是同一件事被重复审、或者某条结论被当成"没做过"。这不是洁癖，是可复现的丢结论路径 ——
本轮就真发生过一次（见 §4）。

**判定口诀**：文档在回答"我们查了什么、结论是什么"→ 外层仓；
在回答"这个项目该怎么写代码、架构怎么分层"→ mindcraft 的 `docs/`。

---

## 2. 本目录文件清单（共 **23** 个，含本 README）

按用途分四组，逐个点名（与 `ls -1 docs/audit-执行/` 对齐，共 23 行）：

### 2.1 基线与总览（2）
1. `README.md` —— 本文件（归档约定）
2. `00-基线.md` —— 开工基线

### 2.2 分任务执行台账 T\*（13）
3. `T02-门禁.md`
4. `T03-门禁.md`
5. `T04-日志时间戳.md`
6. `T05-文档.md`
7. `T10-控制面-沙箱-注入.md`
8. `T11-模型层失败标记与usage.md`
9. `T14-小项假成功与死代码.md`
10. `T15-测试临时目录并发隔离.md`
11. `T17-测试bots路径并发隔离.md`
12. `T18-门禁自写盘并发隔离.md`
13. `T20-技能财产保护.md`
14. `T21-正确性与可中断性.md`
15. `T30-任务板数据完整性.md`

### 2.3 轮次 / 小项报告（4）
16. `S43-S44-小项.md` —— S43/S44 小项执行记录（第二轮批次）
17. `T31-调度停止与共享箱.md`
18. `T32-运行时自愈与浮空promise.md`
19. `第二轮-执行报告.md`

### 2.4 R1 收尾（4）
20. `R1-收尾-gate.md` —— R1-a / R1-b / 第11条复核 + S35 + 第27条（**t6 从 mindcraft 迁入**，见 §4）
21. `R1-收尾-第15条.md` —— 合成重试不重复扣料
22. `R1-收尾-第20条.md` —— 三处分叉改薄包装
23. `R1-收尾-执行报告.md` —— **终局验证与执行报告**（8 项验收 + 全量复跑；§7 内含「归档位置体检」）

> 分组只是导航，**总数固定 23**：2（基线与总览）+ 13（T\* 台账）+ 4（轮次/小项）+ 4（R1 收尾）= 23。
> 其中 `T31` / `T32` / `S43-S44` 是分任务台账，与 `第二轮-执行报告.md` 同属第二轮批次，故列在一起。

---

## 3. 归档方自检（每轮收尾各跑一次）

```bash
cd "E:/我的世界ai"

# ① 被审仓里不许有审计文档 —— 期望：无输出
find mindcraft -name "*.md" -path "*audit*" -not -path "*/node_modules/*"

# ② 外层仓的 docs 只有一处 —— 期望：./docs
find . -maxdepth 1 -name "docs"

# ③ 归档目录文件数 —— 期望：与 §2 的 23 一致
ls -1 docs/audit-执行/ | wc -l
```

**2026-11-05 实测**：① 无输出；② `./docs`；③ `23`。✅

---

## 4. 本轮实际发生的跑偏与订正

**事件**：t1 产出 `R1-收尾-gate.md` 时落在了 `mindcraft/docs/audit-执行/`（随 mindcraft 提交 `5d28800`），
而同期其他所有审计文档都在外层仓。

**订正（先落盘后删源，顺序不可颠倒）**：
1. 外层仓：`cp` 到 `docs/audit-执行/R1-收尾-gate.md`，`md5` / `cmp` 确认**逐字节一致**
   （`95a00ac35a7ec5ababeb5ceda8859421`，18890 B，`cmp` exit 0）→ 提交 `0bae6ca`；
2. mindcraft 仓：`git rm` 该文件 + `rmdir` 掉空目录 → 提交 `d8267ed`（该提交过了 pre-commit 门禁）。

**教训**：写文档前先问一句"这份是给谁看的"。
给审计方的 → 外层仓；给项目开发者的 → mindcraft `docs/`。

---

## 5. 归档口径处置结果（t6 列出 → t7 按 captain 裁决执行完毕）

t6 列出的混乱项，t7 已分类处置。**下表是最终状态，不再是"待办"**：

| 类别 | 内容 | 处置 | 结果 |
|---|---|---|---|
| 探针源码（证据本体） | 8 个 t19/t20 探针 `.mjs` + 4 份 R1 终审报告 + 第20条文档 = **13 个** | ✅ **已入库**（`fa6f29d`） | `git ls-files docs/audit/probes/` 由 **17 → 25** |
| 运行产物（非证据） | `probes/r1/`(11M，含嵌套 `.git`) + `probes/run/`(14M) = 25M | ✅ **已 gitignore**（见 §7） | `git check-ignore -v` 有命中 |
| 规程/清单更新 | `REVIEW-PROTOCOL.md`、`verify-checklist.md` | ✅ **已提交**（`c29c5be`） | 工作区不再有这类未提交改动 |
| stash 补丁归档 | `docs/git-rescue-20261105/` | ⏳ **保持未提交，待 captain 与用户定**（见 §8） | 已写清是什么 + 建议 |

### 5.1 `mindcraft/tmp/` 里的探针会被静默丢弃（**仍未解决**）

`gate-r1a-probe.mjs`（R1-a 运行时反证）与 `gate-r1b-probe.mjs`（R1-b 误报回归）写在 `mindcraft/tmp/`，
而 `tmp/` 在 mindcraft 的 `.gitignore` 里 → **这两份证据不入库、随时可能被清掉**。

缓解现状：两份探针的**全部断言已逐条抄进** `R1-收尾-执行报告.md` §2.1 / `R1-收尾-gate.md`，
所以结论不依赖文件本体存活。**但"照抄"不如"存原件"** —— 建议后续把这类探针移入
外层 `docs/audit/probes/`（那里正是探针归档地），再在文档里引用路径。
（t7 未做：本轮授权只到 `.gitignore` + `docs/`，移动探针属于新增归档内容，留待确认。）

---

## 6. 给下一轮的三条硬提醒

1. **审计文档不要写进 `mindcraft/`。** 一次都不行 —— 漏读成本由下一轮的人承担。
2. **提交前看 `git status` 的落点仓。** 两个仓分支同名（`audit/remediation-2026-11-05`），极易看错；
   `mindcraft` 有自己的 `.git`，外层仓的 `.gitignore` 里写着 `/mindcraft/`（禁止嵌套纳入）。
3. **运行产物与证据要分开。** 探针脚本入库，`run/` `bots/` `logs/` 之类产物走 ignore。

---

## 7. 为什么 `probes/r1/` 与 `probes/run/` 被排除（**故意的，不是忘了**）

两个目录已写进外层仓 `.gitignore`（:88、:89）。排除理由三层，任何一层都足以排除：

1. **有害**：`probes/r1/trepo2/` 里有一个**嵌套 `.git`**。一旦提交，git 只会记成 gitlink（伪子模块），
   内容无法回滚、父仓 status 还会永远显示"有变化"—— 与 `/mindcraft/` 被排除是同一个理由。
2. **体积**：`r1/` 11M + `run/` 14M = **25M**，且每次重跑都会变。
3. **性质**：它们是**可重建的运行产物**，不是证据本体。
   **证据是生成它们的 `.mjs` 探针**（已在 `docs/audit/probes/*.mjs`，25 个入库）。
   `run/` 里是日志与 `bots/` 快照，`r1/` 里是沙箱现场 —— 离开环境无法解读，留着只占地方。

**想复现某条结论时**：读对应 `probes/<名字>.mjs` 的用法注释重跑一遍。
**不要指望从这两个目录里"恢复"证据** —— 它们本来就不是证据。

### 7.1 自检命令（每轮收尾跑一次）

```bash
cd "E:/我的世界ai"

# ① 必须命中（说明排除规则还在生效）—— 期望各打印一行 .gitignore:NN
git check-ignore -v docs/audit/probes/r1 docs/audit/probes/run

# ② status 里不应再出现它们 —— 期望：无输出
git status --short | grep -E "probes/(r1|run)/" || echo "OK：未被跟踪"

# ③ 被 ignore 的东西仍看得见（确认是"故意排除"而非"文件丢了"）—— 期望：能列出
git status --short --ignored | grep -E "probes/(r1|run)/"
```

**2026-11-05 实测**：① 命中 `.gitignore:88` / `.gitignore:89`；② 无输出；③ 可见。

---

## 8. `docs/git-rescue-20261105/` 是什么（**待裁决：未提交、未删除**）

7 个文件、32K：`README.md` + `stash-0..5.patch`。
**当前 `git stash list` 为空（0 条）** —— 这些 stash 对象**已被 drop，这 7 个补丁是现存的唯一副本**；
`git reflog show stash` 也报 `unknown revision`（stash 引用已不存在）。

### 8.1 内容摘要

| 补丁 | 目标文件 | 内容 | 价值判断 |
|---|---|---|---|
| `stash-0..4.patch`（5 个，几乎相同） | `.gitignore` / `docs/README.md` / `settings.js` | "私有配置清理"：把 `profiles/llmgo.json`、`profiles/*-private.json`、部署类文档加进 `.gitignore`，并从文档索引摘掉链接 | **低**。效果**早已落地**（现行 `.gitignore` 已有这些条目，`docs/README.md` 也已有那段说明）。经扫描**不含口令/密钥/端点**，只有策略文字 |
| `stash-5.patch` | `src/agent/library/atom_move.js` | `scaffoldItemIds(bot)`：从背包挑可垫脚方块，**用 item id** 而非 block id 喂给 `movements.scafoldingBlocks`；没材料时关掉 `allow1by1towers` | **高**（见 §8.2）。但补丁**已无法直接 apply**：目标文件 `atom_move.js` 已不存在 |

### 8.2 ⚠️ 高价值发现：`stash-5` 想修的那个 bug，**今天仍然活着**（只是换了文件）

**结论**：stash-5 想在 `atom_move.js` 修的"搭桥静默失效"，现在**以同样的形态**存在于
`nav_pathfinder.js` → `scaffold_blocks.js`。当年没合入的那版修复，等于**丢了**。

**证据链（三层，可逐层复核）**：

1. **pathfinder 的字段要的是 item id**
   `node_modules/mineflayer-pathfinder/lib/movements.js:86-88` 默认值用 `registry.itemsByName.dirt.id`；
   而 `:159` / `:170` 判定是 `if (item.type === id)`，`item` 来自 `bot.inventory.items()` ——
   **`item.type` 是 item id**。所以 `scafoldingBlocks` 这个字段要的是 **item id**。

2. **我们喂的是 block id**
   `src/agent/library/scaffold_blocks.js` 的 `scaffoldBlockIds()`：
   ```js
   const id = bot.registry?.blocksByName?.[it.name]?.id;   // ← blocksByName = block id
   ```
   `nav_pathfinder.js:76-83` 把它直接赋给 `m.scafoldingBlocks`。**id 域不匹配。**

3. **两者在 1.21.8 上确实不同**（本机 `minecraft-data` 实测；项目 `minecraft_version` = 1.21.8）：

   | 方块 | block id | item id | 现在能搭桥吗 |
   |---|---|---|---|
   | dirt | 9 | 28 | ❌ 静默失效 |
   | cobblestone | 12 | 35 | ❌ 静默失效 |
   | oak_planks | 13 | 36 | ❌ 静默失效 |
   | sand | 37 | 59 | ❌ 静默失效 |
   | gravel | 40 | 63 | ❌ 静默失效 |
   | **stone** | **1** | **1** | ✅ **唯一碰巧能用的** |

**后果**：`countScaffoldingItems()` 把这些方块数成 0 → A* 的 `remainingBlocks = 0` →
pathfinder 判定"没有垫脚材料"，**拒绝规划需要垫脚的路径**。表现为：背包里明明有木板/圆石，
遇到沟坎就是不搭，绕远路或直接 NO_PATH，**且不报错**。
（`stone` 因 block id 与 item id 都是 1 恰好绕过，会让人误以为"功能是好的"。）

**为什么值得单独立项**：这正是 captain 说的"几个月后才发现丢了"——
修复写在 stash 里、stash 被 drop、补丁躺在文档目录没人看，而线上 bug 一直健在。

### 8.3 建议处置（**最终由 captain 与用户定**）

| 对象 | 建议 | 理由 |
|---|---|---|
| `stash-0..4.patch` | 确认无用后删除（或只留 `stash-4` 作原始件） | 效果已落地、无密钥、5 份近乎重复 |
| `stash-5.patch` | **不要删**。按 §8.2 单独立项修复；修好后可只作历史留档 | 它记录了**仍然存在**的真 bug 的原始诊断 |
| 整个目录 | 若采纳"入库留档"：只提交 `README.md` + `stash-5.patch` 两个即可 | 32K 不大，但 5 个重复补丁是噪音 |

> ⚠️ 特别标注：`stash-5` 是**唯一**记录了"item id vs block id"判据的文字，而该判据今天仍在犯。
> 丢掉它 = 下次还得从头再查一遍 blockId=9 / itemId=28 这种坑。
> **属"价值不明但可能有用的代码改动"**，按 captain 要求特别标出。

---

## 9. 归档自检（每轮收尾）

```bash
cd "E:/我的世界ai"
find mindcraft -name "*.md" -path "*audit*" -not -path "*/node_modules/*"   # 期望：无输出
find . -maxdepth 1 -name "docs"                                            # 期望：./docs
ls -1 docs/audit-执行/ | wc -l                                             # 期望：与 §2 一致
git check-ignore -v docs/audit/probes/r1 docs/audit/probes/run             # 期望：各有命中
```

**2026-11-05 实测**：无输出 / `./docs` / `23`（§2 已按 23 校准）/ 命中 `.gitignore:88`、`:89`。
