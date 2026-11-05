id: F-EXEC-108
severity: low
class: config
file: mindcraft/src/agent/library/skills.js:1777
evidence: |
  垫脚方块清单已经有一个"唯一真相源"文件（`src/agent/library/scaffold_blocks.js`，
  文件头 `:1-17` 明确写着"清单原本散在 4 处，且互不一致……现在以并集为准，**改名只改这里**"），
  但 `skills.js` 里还留着第五份自己的正则：
    skills.js:1777  const goodScaffold = /^(dirt|grass_block|cobblestone|stone|andesite|diorite|granite|
                        deepslate|sand|gravel|netherrack|_planks|_log|_slab)$|(_planks|_log)$/;
    skills.js:1789      if (goodScaffold.test(it.name)) { … }
    skills.js:1801  const haveBlocks = had.some(it => goodScaffold.test(it.name) && it.count > 0);
  对照真相源：`scaffold_blocks.js:18-41` = `SCAFFOLD_EXACT`(11 项 Set) + `SCAFFOLD_SUFFIX`(['_planks','_log'])
  与 `isScaffoldBlock()`。两者的差异在这一处最实际：正则里的 `_slab` 备选**永远匹配不到任何真实方块名**
  （它被钉在 `^(…)$` 里面，要求名字**正好等于** `"_slab"`），而真相源里根本没有 slab —— 也就是说
  这行正则是一个"读起来像支持半砖、实际不支持"的死备选；反过来，哪天真相源加了一个新垫脚块
  （比如 `blackstone`），`skills.js` 这条路径**不会跟着变**。
  出处：docs/audit/21-review-r2-verdict.md §3 **R2-9**（"垫脚选材两份实现……改一处忘另一处就重新分叉"，Nice）；
  同类历史：该文件正是 D8「垫脚块清单三处不一致」的修复产物（`scaffold_blocks.js:12-16` 记录了四处不一致的后果：
  `ensureScaffold` 数了 8 个但 `executor` 认不出木板 → NO_ITEM 卡住）。
  本轮在当前代码复核：**仍存在**（`skills.js:1777` 的第五份实现未改）。
exploitability: |
  无直接攻击面。危害是**会复发同一个已修过的 bug**：
  `ac477f3`（"垫脚清单喂 block id 而非 item id"）那次修复就把这条链动过，
  而现在"清单本体"在一个文件、"skills 侧的选材判据"在另一个文件 —— 下一次改清单时漏一处，
  就会重演"数了 N 个 / 认不出其中几个 → 判 NO_ITEM → 挖掘路径卡住"（`:1-16` 记载的真实事故）。
  影响半径：挖掘/垫高/逃困（`flow_escape`）三条链。
suggested_fix: |
  `skills.js:1777` 那一行删掉，改成薄包装（1 行）：
  ```js
  import { isScaffoldBlock } from './scaffold_blocks.js';   // 文件顶部 import 区
  // :1777 删除正则；:1789/:1801 的 goodScaffold.test(x) → isScaffoldBlock(x)
  ```
  若担心 `isScaffoldBlock` 未导出（它已 `export`，见 `:39`），直接用即可。
  **顺带**：`skills.js` 里同一处若还有 `_slab` 的语义意图（"半砖也能垫"），应当改进真相源（加
  `_slab` 后缀）而不是留在本地正则里 —— 但那是行为变更，需单独立单，别混在这一条里。
verify: |
  cd mindcraft
  grep -c "goodScaffold" src/agent/library/skills.js         # 期望 0
  grep -c "isScaffoldBlock" src/agent/library/skills.js      # 期望 ≥1（薄包装已接）
  # 一致性回归：同一份名字样本，两条路径判定必须完全相同
  node -e "
    const {isScaffoldBlock} = await import('./src/agent/library/scaffold_blocks.js');
    const names=['dirt','grass_block','cobblestone','oak_planks','oak_log','oak_slab','stone_bricks','sand'];
    console.log(names.map(n=>n+':'+isScaffoldBlock(n)).join(' '));
  "
  node tools/unit_all.mjs 2>&1 | tail -5                     # 与基线一致
discovered_by: patch-smith(from history)
dept: D3-EXEC
