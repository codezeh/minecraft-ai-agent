id: F-DEP-003
severity: high
class: deps
file: mindcraft/patches/mineflayer+4.33.0.patch:1
evidence: |
  补丁文件名写 4.33.0，实际装的是 4.39.0，三处 hunk 一处都没落到已装代码里：

  $ cd mindcraft
  $ node -p "require('./node_modules/mineflayer/package.json').version"
  4.39.0

  $ grep -n incorrect_for_wooden_tool node_modules/mineflayer/lib/plugins/digging.js
  （无输出 —— hunk 1 未应用）
  $ grep -n "timeout: 500" node_modules/mineflayer/lib/plugins/place_block.js
  29:      timeout: 5000,          # 补丁要改成 500，仍是上游 5000 —— hunk 2 未应用
  $ grep -n yawDeg node_modules/mineflayer/lib/plugins/inventory.js
  （无输出 —— hunk 3 未应用；上游 4.39.0 已改用 toNotchianYaw/toNotchianPitch，见 inventory.js:137-140）

  对照：其余 4 个补丁确实生效（说明 postinstall 曾经跑过，是后来单独换了 mineflayer 版本没重跑）：
  $ grep -n updateLavaAvoidance node_modules/mineflayer-pathfinder/lib/movements.js      → 745 命中
  $ grep -n "return; //throw new Error" node_modules/prismarine-viewer/viewer/lib/entity/Entity.js → 206 命中
  $ grep -n physicsTick node_modules/mineflayer-pvp/lib/PVP.js                          → 51 命中
  $ grep -n "Chunk size is" node_modules/protodef/src/serializer.js                     → 76 命中（已注释）

  后果链：postinstall = `patch-package`（package.json:47）。patch-package 拿 4.33.0 的上下文去 match
  4.39.0 的 place_block.js:11 —— 上下文已经是 `timeout: 5000`（补丁写的正是把它改掉），必然不匹配
  → 干净安装时 `ERROR Failed to apply patch for package mineflayer` 并 exit≠0 → `npm ci` 直接失败。

  补充事实：3 个 hunk 里 2 个上游 4.39.0 已用别的写法覆盖（water 计算走
  `['water','flowing_water'].includes(bot._getBlockAtEyeLevel()?.name)`；rotation 走 toNotchianYaw），
  只有 hunk 1（`incorrect_for_wooden_tool` → `mineable/pickaxe`）在 4.39.0 里确实还缺
  （`grep -rn incorrect_for node_modules/mineflayer/lib/` 无输出）。
exploitability: |
  不是远程可利用漏洞，是"依赖树不可复现 + 补丁状态与团队认知相反"的供应链完整性缺口：
  - 今天任何人（新机器 / CI / agent 自己）跑 `npm ci` 都会在 postinstall 失败。
  - 失败的现实处置是加 `--ignore-scripts`，一旦这么做，另外 4 个真实需要的补丁
    （pathfinder 避岩浆+开门、pvp 的 physicsTick 拼写、protodef 日志、viewer 崩溃）也全失效，
    运行时行为与团队认知彻底脱节，而且没有任何检查会发现。
  - 团队以为 mineflayer 被本地改过挖矿材质判定，实际没改：采集类 skill 的时长/卡住问题
    会被误判为"上游 bug"，把排障方向带偏。
  - 也是 F-DEP-004（补丁=可执行代码、无闸）成立的实证：补丁集与版本早已漂移，没人管。
suggested_fix: |
  二选一，都在红线内（只动已有依赖，不新增包）：
  A) 首选，把补丁集对齐到 4.39.0：
     1. 先留底：`cp mindcraft/patches/mineflayer+4.33.0.patch /tmp/`；
     2. 只重建仍需要的 hunk 1 —— 在 `node_modules/mineflayer/lib/plugins/digging.js` 的
        `const creative = bot.game.gameMode === 'creative'` 之前插入一行：
        `if (block.material === 'incorrect_for_wooden_tool') block.material = 'mineable/pickaxe'`
     3. `cd mindcraft && npx patch-package mineflayer` → 生成 `patches/mineflayer+4.39.0.patch`；
     4. 删掉 `patches/mineflayer+4.33.0.patch`。一个 commit 只做这一件事。
     hunk 2/3 不要重建：上游已用正确写法覆盖（见 evidence）。
  B) 只想止血：把 postinstall 的失败暴露出来而不是靠人来绕过 —— 见 F-DEP-004 的
     `tools/apply_patches.mjs`（先校验再 apply，并对比版本），同时 README/start.bat 明令禁止 `--ignore-scripts`。
verify: |
  cd mindcraft
  # 1) 干净副本上验证安装不再失败（隔离跑，别动共享 node_modules）
  git worktree add /tmp/dep003 HEAD && cd /tmp/dep003 && npm ci   # postinstall 必须 exit 0
  # 2) 补丁内容确实在
  grep -n incorrect_for_wooden_tool node_modules/mineflayer/lib/plugins/digging.js          # 必须命中
  ls patches/mineflayer+4.39.0.patch && ls patches/mineflayer+4.33.0.patch 2>/dev/null     # 旧的无、新的有
  # 3) 其余 4 个补丁仍在
  grep -c updateLavaAvoidance node_modules/mineflayer-pathfinder/lib/movements.js           # >0
  # 4) 门禁不回归
  npm run gate:full
discovered_by: recon-scout
dept: D1-DEP
