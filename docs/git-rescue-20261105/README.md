# stash 归档对账  2026-11-05

| stash | reflog 来源 | 提交信息 | tree | 改动文件 |
|---|---|---|---|---|
| @{0} | filter-branch: rewrite | On nav-legacy-backup: 私有配置清理 | d581469 | .gitignore docs/README.md settings.js  |
| @{1} | filter-branch: rewrite | On nav-legacy-backup: 私有配置清理 | d581469 | .gitignore docs/README.md settings.js  |
| @{2} | filter-branch: rewrite | On nav-legacy-backup: 私有配置清理 | 380c059 | .gitignore docs/README.md settings.js  |
| @{3} | filter-branch: rewrite | On nav-legacy-backup: 私有配置清理 | da59b82 | .gitignore docs/README.md settings.js  |
| @{4} | On nav-legacy-backup: 私有配置清理 | On nav-legacy-backup: 私有配置清理 | da59b82 | .gitignore docs/README.md settings.js  |
| @{5} | On companion-v2: tmp-verify | On companion-v2: tmp-verify | 49585a7 | src/agent/library/atom_move.js  |

> 上表是**清理前**的 6 个 stash 快照。清理结果见下方。

---

## 清理结果（2026-11-05 21:20）

### 已 drop（4 个 filter-branch 重写残留）

| stash | tree | 判定理由 |
|---|---|---|
| @{0} | d581469 | 与 @{1} 完全相同；且 @{4} 已是原始件 |
| @{1} | d581469 | 与 @{0} 完全相同 |
| @{2} | 380c059 | filter-branch 中间态 |
| @{3} | da59b82 | 与 @{4} 完全相同，重复件 |

原始件是 @{4}（reflog 记的是 `On nav-legacy-backup: 私有配置清理`，不是 filter-branch），
所以保留它、清掉 4 个重写过程产物。补丁已全部导出于本目录，可 `git apply` 恢复。

### 保留（有价值的，不做删除）

| 现编号 | 原编号 | 内容 | 为什么保留 |
|---|---|---|---|
| `stash@{0}` | 原 @{4} | `.gitignore` / `docs/README.md` / `settings.js` 的"私有配置清理" | 原始件，非重写产物 |
| `stash@{1}` | 原 @{5} | `src/agent/library/atom_move.js`：搭桥脚手架选材 | **真实未落地功能**，见下 |

### `stash@{1}` 的具体价值（别误删）

它给 `makeMovements()` 加了 `scaffoldItemIds(bot)`：从背包挑出可当脚手架的方块。

关键点是选材口径**必须用 item id 而不是 block id** —— 因为 `movements.js:156-159` 的判定是
`item.type === id`，而 `item.type` 是 item id。在 1.21.8 里 `dirt` 的 blockId=9、itemId=28，
混用就永远匹配不上，表现为**「搭桥静默失效」**，属于最难查的那类。

落地状态核实（2026-11-05）：
```
grep -c "scaffoldItemIds" src/agent/library/atom_move.js  →  0
```
即这段功能**至今没有在任何分支上落地过**。要用时：
```bash
git apply ../docs/git-rescue-20261105/stash-5.patch
```

### 未处理（需另行决定）

- `mine/main`（远程，停 10-29，落后主线 86 个提交）—— 删了图更干净，但以后推送要重新 fetch
- `mine/nav-legacy-backup` —— 导航层重构前的完整快照，**建议长期保留**
- `origin/develop` —— 上游 Mindcraft 起点（10-02），保留
- 图上仍有的"同信息重复 2~3 次"，是三个真实分支各自提交过同一改动所致，属真实历史，不是残留

---

## 处置（2026-11-06 归档裁决，t9 执行）

### 结论：本目录**只有 2 个文件入库**，其余 5 个刻意排除

| 文件 | 是否入库 | 理由 |
|---|---|---|
| `README.md`（本文） | ✅ **入库** | 没有它，下面那份补丁就是"来历不明的 diff" |
| `stash-5.patch` | ✅ **入库** | 见下节 —— 它是**唯一**记录了一条判据的原始文字 |
| `stash-0..4.patch` | ❌ **不入库、不删除** | 价值低（效果已落地）但**删了不可恢复**，留工作区交用户定；已写进 `.gitignore` 明确"刻意排除" |

`.gitignore` 里对应条目：`docs/git-rescue-20261105/stash-[0-4].patch`
（与 `docs/audit/probes/r1|run/` 同一个处理原则：**排除要有明确条目，不能靠"忘了提交"**）。

### 为什么 `stash-5.patch` 必须入库

它是"`movements.scafoldingBlocks` 要 **item id**、不能喂 block id"这条判据**唯一现存**的原始文字记录。
`git stash list` 现为 0 条、`git reflog show stash` 报 `unknown revision` —— 原 stash 对象已 drop，
这批补丁是唯一副本。

而这条判据对应的是一个**刚刚才被修掉的活 bug**：生产代码一直在喂 block id，
`countScaffoldingItems()` 恒为 0 → A* `remainingBlocks === 0` → 放弃所有"放方块走过去"的分支
→ 她背着木板却绕远路或根本过不去，**且不打任何日志**。
修复于 `ac477f3`（`scaffold_blocks.js` + `skills.js:buildMovements` 两处入口一并改成 `itemsByName`），
执行记录见 `docs/audit-执行/R1-收尾-拐杖-id错配.md`。

**把这份记录长期留在工作区、不入库，等于重复同一个错误**：证据存在，但下一轮换人审时依然看不见它。

### ⚠️ 更正：本文上方的恢复命令已失效

本文前面写的
```bash
git apply ../docs/git-rescue-20261105/stash-5.patch
```
**现在跑不通**，会报 `error: src/agent/library/atom_move.js: No such file or directory`。
原因：`atom_move.js` 已在导航层重构中被拆掉，`makeMovements` 现在住在 `nav_pathfinder.js:28`。
所以这份补丁的价值**不是"可直接打上"**，而是**判据的书面记录**（item id vs block id、以及
"没材料就关掉 `allow1by1towers`，别让 A* 规划一条永远搭不出来的桥"这个设计意图）。
要看落到代码里的最终形态，请直接读 `src/agent/library/scaffold_blocks.js` 与 `ac477f3`。

### `stash-0..4` 的状态（为什么判定"价值低"但不删）

内容是同一件事的 5 份近似重复：把 `profiles/llmgo.json`、`profiles/*-private.json` 等私有配置
与若干部署文档加进 `.gitignore`，并从 `docs/README.md` 索引里摘掉对应链接。
经核实**其效果早已落地**（现行 `.gitignore` 已有这些条目、`docs/README.md` 也已有那段说明），
且逐个扫描**不含口令/密钥/端点**，只有策略文字。

`stash-1..4` 的 md5 完全相同（`4c8d4809…`），`stash-0` 略异（`b0f29a33…`）—— 即 5 份里 4 份是重复件。
**不删**的原因只有一个：删了不可恢复，而"确认无用"应由用户拍板，不由归档人代判。

### 若要彻底清理（**由用户决定，归档人不代劳**）

1. 确认 `stash-0..4` 的私有配置清理不需要留档后，直接 `rm` 这 5 个文件；
2. 如仍想留一份，只保留 `stash-4.patch`（原始件）即可，其余 4 份是重复；
3. 无论删不删，**`stash-5.patch` 与本文都已入库**，删本地副本不会丢判据。
