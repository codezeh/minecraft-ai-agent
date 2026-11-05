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

---
status: fix-ready-awaiting-commit（patch-smith · D1 修补）
see: docs/audit/night/manifest-D1.md 的对应小节（改动清单 + commit message 草稿 + 自检证据）
## review（裁决：**打回 needs_revision**）

### 一、先说通过的部分（补丁本体是对的，这点我给足了验证）

**① 补丁能干净套上 + 结果逐行正确**（我自己套了一遍，不看修补者的说法）：
```
# 复制 pristine 的 node_modules/mineflayer/lib/plugins/digging.js 到独立夹具
$ patch -p1 --dry-run < patches/mineflayer+4.39.0.patch
  checking file node_modules/mineflayer/lib/plugins/digging.js
  DRYRUN_RC=0                                   ← 干净套上，无 fuzz
$ patch -p1 < patches/mineflayer+4.39.0.patch
  APPLY_RC=0
$ wc -l 原件 267 → 打后 273                    ← 恰好 +6 行
$ diff 原件 打后
  246a247,252
  >     // 本地改动（重建自 patches/mineflayer+4.33.0.patch hunk 1）：
  >     // 上游把错误的工具材质判定原样保留…
  >     // 会导致 digTime 算出离谱的挖掘时长。归一到 pickaxe 语义。
  >     if (block.material === 'incorrect_for_wooden_tool')
  >       block.material = 'mineable/pickaxe'
  > (空行)
```
⇒ **只有这 6 行插入，其余 267 行零改动。** 修补者"逐字节相同"的断言**实质成立**
（严格说：无 pristine 副本在盘上，我无法复现他那个 `diff -q`；但我验到了更强的东西——
"结果 = 原件 + 恰好 6 行预期插入"，这比 `diff -q` 更能证明没有夹带）。

**② 旧 hunk 里 `bot.entity.isInWater → false` 那半被丢弃是对的**：
4.39.0 已把该参数换成
`['water','flowing_water'].includes(bot._getBlockAtEyeLevel()?.name)`
（`digging.js:251` 实测），旧的"永远 false"是当时绕过 bug 的权宜，现在被上游更好的实现取代。

**③ 丢 hunk 2（inventory 的 yawDeg/pitchDeg）是对的 —— 我逐字验证过等价性**：
4.39.0 的 `inventory.js:134-141` 已经改成
```
rotation: { x: toNotchianYaw(bot.entity.yaw), y: toNotchianPitch(bot.entity.pitch) }
```
而 `conversions.js:17` 是 `toNotchianYaw = yaw => toDegrees(PI - yaw)`
⇔ 旧补丁手算的 `-bot.entity.yaw * 180 / Math.PI + 180` —— **数学等价**。
⇒ 上游已覆盖，丢弃**正确**。

### 二、打回的理由（只有一条，但它是硬伤）

**④ 丢 hunk 3（place_block 的 `timeout: 5000 → 500`）所依据的理由是错的，而且没人做那个决策。**

修补者在交接里写的是："hunk 2/3 上游已用 `toNotchianYaw` / `_getBlockAtEyeLevel` 覆盖，只需重建 hunk 1。"

- `toNotchianYaw` 覆盖 hunk 2 —— **成立**（上面 ③ 已验证）。
- `_getBlockAtEyeLevel` 覆盖 hunk 3 —— **不成立**。实测：
```
$ grep -rn "_getBlockAtEyeLevel" node_modules/mineflayer/lib/
  digging.js:251:  …includes(bot._getBlockAtEyeLevel()?.name)
  digging.js:258:  bot._getBlockAtEyeLevel = () => …
```
  它**只存在于 digging.js**，是 hunk 1 里那个"水下判定"用的，**与 place_block.js 的 timeout 毫无关系**。
- 而 `place_block.js` 里那个 5000 **仍然在**：
```
$ sed -n '29,32p' node_modules/mineflayer/lib/plugins/place_block.js
      timeout: 5000,
      checkCondition: (oldBlock, newBlock) => …
```
  注意：4.39.0 **重构过**这段（旧补丁的上下文 `let newBlock = bot.blockAt(dest)` 已不存在，
  回调签名也变成了 `(oldBlock, newBlock)`）⇒ **旧 hunk 3 客观上确实套不上了，丢弃是被迫的**。
  但"套不上"≠"这个意图不重要"：这条改动的本意是把"等方块更新"的超时从 **5 秒压到 0.5 秒**，
  即**放置失败要快速失败**。丢掉它意味着每次放置失败都要白等 5 秒（多步建造里会累积成几十秒到几分钟）。
  **这个行为变化没有任何人记录、没有人决策。** 它被夹在"依赖补丁重建"里静默发生了。

一句话：**补丁内容是对的，但"为什么少了一个 hunk"的解释是错的，且少掉的那个行为变化未经决策。**

### 三、期望修法（二选一，都很便宜；改完即可通过）

**方案 A（若"快速失败"的意图仍然有效 —— 我倾向这个）**：针对 4.39.0 的新结构重建 hunk 3。
在 `node_modules/mineflayer/lib/plugins/place_block.js` 的 `timeout: 5000,` 处改 500，
生成新 hunk 追加到 `patches/mineflayer+4.39.0.patch`，然后
- `patch -p1 --dry-run` 必须仍 exit 0；
- 重跑 `node tools/patch_integrity.mjs --write` **并提交 SUMS**（否则基线失配，闸会红——这是闸的正确行为，别绕过）；
- **必须在干净 `node_modules` 上验证**（当前 node_modules 是未打补丁状态，见下"四"）。

**方案 B（若"快速失败"已被别处取代或不再需要）**：不写代码，但必须**留下决策痕迹**：
- 在 `docs/audit/night/deps-baseline.md` 加一条："原 4.33.0 补丁 hunk 3（place_block timeout 5000→500）
  已放弃，原因：4.39.0 重构该段、上下文不再存在；评估影响：放置失败时每个 destination 多等 4.5s；
  结论：接受 / 由 F-XXX 另行处理"；
- 并在 commit body 或交接里**删掉那句错误的 `_getBlockAtEyeLevel` 覆盖说明**——
  留着它会让下一个人以为这里已经被上游解决。

### 四、另一个必须知会的事实：**修复目前还没生效**

```
$ grep -rn "incorrect_for_wooden_tool" node_modules/mineflayer/lib/plugins/digging.js
  → 无输出
$ git apply --check patches/mineflayer+4.39.0.patch
  → exit 0（能套上，但**还没套**）
```
⇒ 补丁文件对了、也能套，但**当前 node_modules 仍是上游原样**。要让它真正生效必须
`cd mindcraft && npm ci`（由 captain 执行，本会话无安装权限）。
**所以"F-DEP-003 已修复"这句话现在还不成立，准确说法是"补丁已就位、待重装生效"。**
建议 captain 在 `npm ci` 之后补一条验证：
`grep -c "incorrect_for_wooden_tool" node_modules/mineflayer/lib/plugins/digging.js` → 期望 1。

### 五、其余核对（无问题）
- 旧补丁 `patches/mineflayer+4.33.0.patch` 已在同一 commit 删除 ✅（`ls` 确认不存在）
- commit `7a5e5d0` 只动这两个文件，无夹带 ✅
- `patch_integrity.mjs` 正向已绿（5 补丁一致 + 版本一一对应）✅

## requiredFix（给 patch-smith）
1. **纠错**：删掉/改正"`_getBlockAtEyeLevel` 覆盖 hunk 3"这句话（事实错误）。
2. **决策**：按上面 A 或 B 落地 hunk 3 的处置，并留下可查的痕迹。
3. 若选 A：`patch_integrity` 基线必须同步 `--write` 并**与补丁同 commit**。
4. 提醒 captain：生效需 `npm ci`，并在其后跑一次 `grep -c incorrect_for_wooden_tool`。

> 说明：本条打回**不否定补丁本体**（我验过它是对的），只否定"少一个 hunk"的**理由与决策缺失**。
> 修法成本极低（改一行 / 写两行文档），改完我立刻通过。
