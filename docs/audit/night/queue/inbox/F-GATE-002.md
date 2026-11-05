id: F-GATE-002
severity: low
class: config
file: tools/unit_all.mjs:37
evidence: |
  `unit_all` 用 `EXCLUDE` 表把 4 个脚本排除出默认集合，其中**两个是永久必红的死测试**，
  排除理由是"引用已删除的模块"——也就是说：它们永远不会通过，而门禁从此再也看不见它们。

  tools/unit_all.mjs:36-39 原文：
    const EXCLUDE = new Map([
        ['test_mca_import', '引用已删除的 src/agent/library/chunk_map.js（ERR_MODULE_NOT_FOUND）；陈旧测试，删/重写不在 T03 范围'],
        ['test_tile_map',   '同上：引用已删除的 chunk_map.js；陈旧测试'],
    ...

  实测三个模块的存在性：
    src/agent/library/chunk_map.js   → MISSING
    src/agent/library/tile_map.js    → MISSING
    src/agent/library/mca_import.js  → EXISTS

  而两个测试的 import 行直接指向这些已删模块：
    tools/test_mca_import.mjs:3   import { getChunk, openMapReader } from '../src/agent/library/chunk_map.js';
    tools/test_mca_import.mjs:4   import { classifyChunk, renderTileGrid } from '../src/agent/library/tile_map.js';
    tools/test_tile_map.mjs:4     import { scanArea, getChunk } from '../src/agent/library/chunk_map.js';
  ⇒ 两者一执行就 `ERR_MODULE_NOT_FOUND`，**必然 exit 1**。排除不是"暂时跳过"，是永久失明。

  附带的连锁盲区（同一条根因、顺带发现）：
  `EXCLUDE`/`EXTRA_OFFLINE`/`NEEDS_REAL_DATA` 三张表**只校验名字与文件是否成对**，
  **从不校验文件里的 import 是否还能解析**。所以"测试引用了不存在的模块"这类腐烂
  永远只能在有人手动跑它时暴露 —— 而它恰恰被排除了，于是永远没人跑。

exploitability: |
  不是可直接利用的漏洞，是**门禁盲区**（也是"藏红"的先例）：

  1. 覆盖缺口：`chunk_map`/`tile_map` 相关的行为（区块地图读取、战棋层标签/格图/代价 A* 路由）
     当前**零测试守护**。谁来重写这块逻辑、改坏了，`gate:full` 不会有任何反应。
  2. 程序性风险更大：`EXCLUDE` 里"只要写个理由就能把红测试拿掉"这个模式一旦被当成惯例，
     后面任何人都能照抄——理由写得好听，实质是删掉护栏。PLAYBOOK §7 明确把
     "删测试"列为**事故**，但 `EXCLUDE` 让它以"登记"的形式合法发生了。
  3. 影响半径：仅影响回归防护，不影响运行时。

suggested_fix: |
  三步，按顺序做：

  1. **先判死活**（10 分钟）：确认 `chunk_map`/`tile_map` 的职责是否已被别的模块接管
     （`mca_import.js` 存在；`terrain3d.js` 承担了部分地图读取）。
     `git log --diff-filter=D --oneline -- src/agent/library/chunk_map.js` 找到删除它的提交，
     读 commit body 看当年是否声明了"测试已一并迁移"。
  2. **按结论处置，二选一，不要留第三种**：
     (a) 功能仍在（已迁移到新模块）→ **重写这两个测试**指向新模块，从 `EXCLUDE` 移除；
     (b) 功能已删除 → **删除这两个 .mjs 文件**，并在
         `docs/audit/night/queue/HISTORY-EXPIRED.md` 追加一行"已删除，原因/替代"，
         同时清掉 `EXCLUDE` 里对应两条（表里的死条目本身也会腐烂）。
  3. **补机械化守卫**（防止下一次腐烂）：在 `tools/preflight.mjs` 加一节
     —— 遍历 `tools/*.mjs`，用静态方式抽出其相对 import 并 `existsSync` 逐个校验，
     任一解析不到即红。这样"测试引用了不存在的模块"会**当场红在门禁里**，
     而不是靠谁记得去跑它。
     （实现提示：`tools/audit_rules.mjs` 已有 `existsSync` 硬校验的先例，可复用同一模式。）

verify: |
  1. `cd mindcraft && node tools/unit_all.mjs` → 输出里**不再含** `excluded: [test_mca_import, test_tile_map]`
     （或该表已为空），且执行数等于发现数（`executed + skipped === registered` 的等式仍成立）。
  2. `node tools/preflight.mjs` → 含新的一节 import 解析校验，且当前仓库 0 处失败
     （若加完立刻红，说明还有别的脚本也在引用死模块 —— 那正是它该抓的）。
  3. 反向验证（必须做，否则又是"恒绿的新检查"）：临时把某个 `tools/*.mjs` 的 import 改成
     一个不存在的路径，确认 preflight **变红**；改回来后恢复绿。
  4. `git diff --stat` → 仅触及 `tools/` 下的测试与 preflight，不动 `src/`。

discovered_by: gate-keeper
note: |
  id 段 `F-GATE-*` 为 gate-keeper 自查门禁产生的新段位，不在 0xx/1xx 两个已批准段内，
  如 captain 要并入既有段位请指示改号。
  另：本条与 `EXCLUDE` 的另外两条（`test_reconnect`/`test_s0_afk`，需要在线 bot）性质不同，
  那两条是**设计性**跳过（机器上本来就不该跑），本条的这两条是**死掉后被藏起来**，不可混为一谈。
