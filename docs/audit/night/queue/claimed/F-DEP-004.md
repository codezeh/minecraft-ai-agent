id: F-DEP-004
severity: high
class: deps
file: mindcraft/package.json:47
evidence: |
  $ cd mindcraft && grep -n postinstall package.json
  47:        "postinstall": "patch-package",

  这就是本仓的**安装期任意代码执行面**，而且没有任何门禁看着它：

  1) 补丁是"npm 完整性校验之后"再往 node_modules 里写源码。npm 校验的是 tarball 的 integrity
     （lock 里的 sha512）；patch-package 在校验通过后把 patches/*.patch apply 到源码上 ——
     **跑起来的代码不是 npm 校验过的那份**。
  2) 补丁内容是可执行代码，体量不小：
     $ wc -l mindcraft/patches/*.patch
       12677 mineflayer-pathfinder+2.4.5.patch   （新增函数、改 A* 邻接、插入
                                                   `bot.world.setBlockStateId(refBlock.position..., 1)`
                                                   这种直接改客户端世界状态的调用）
        2417 mineflayer+4.33.0.patch / 905 protodef / 679 prismarine-viewer / 678 mineflayer-pvp
  3) 没有任何门禁校验补丁内容或"补丁是否还对得上版本"：
     $ grep -rln "patch-package\|patches/" mindcraft/tools/     → 空输出
     `npm run gate` / `gate:full` / `.githooks/pre-commit` 都不看 patches/。
  4) patch-package 是 devDependency（^8.0.0，实装 8.0.1）却挂在 postinstall：
     `npm ci --omit=dev` / `npm install --production` 会因为找不到 patch-package 直接失败，
     实践中会被人用 `--ignore-scripts` 绕过 → 补丁全丢（F-DEP-003 已经在发生）。
  5) 补丁集是手工维护、无人负责的证据：`patches/minecraft-data+3.97.0.patch.disabled` 躺着，
     而实际装的是 minecraft-data@3.117.0；`patches/mineflayer+4.33.0.patch` 与已装 4.39.0 完全不匹配。
  6) git 侧审计：`git log --oneline -- mindcraft/patches/` 只有初始提交 —— 本地没有被动过的历史，
     但这也说明"补丁改动"从未被任何评审流程覆盖过。
exploitability: |
  前置条件：对 mindcraft 仓库有写权限的人 —— 协作者一次 PR、一次"顺手修个 bug"的提交、
  或任何能在 patches/ 落文件的上游投递（fork/PR 流程、被投毒的维护者账号）。

  拿到什么：一次 `npm install`（日常动作；start.bat 在 node_modules 缺失时还会自动跑，见 F-DEP-012）
  即以当前用户身份执行任意代码 —— 直接读 `keys.json` / `.env`（本仓有真实 key）、连本机 MC server
  （bot 是 op）、写持久化。无需任何运行时漏洞。

  影响半径：本机全部真实密钥与本地服务。审查难度低：本仓 patches/ 共 14k 行 diff，没人把它们当"要审的代码"。
suggested_fix: |
  1. 新增 `mindcraft/tools/patch_integrity.mjs`（只用 node:crypto，不引第三方）：
     - 读 `patches/SHA256SUMS`，逐文件算 sha256，不一致 → FAIL 并点名文件；
     - 校验"补丁文件名里的包版本 == node_modules 里该包版本"，不一致 → FAIL（直接拦 F-DEP-003 那类漂移）。
  2. `node tools/patch_integrity.mjs --write` 生成基线 `patches/SHA256SUMS` 并提交。
  3. 接门禁：`"gate": "node tools/patch_integrity.mjs && node tools/settings_check.mjs && node tools/preflight_regex_unit.mjs && node tools/preflight.mjs && node tools/lint_hard.mjs"`
     —— 这样 `.githooks/pre-commit`（跑 npm run gate）与 gate:full 都覆盖到。
  4. postinstall 改为 `"postinstall": "node tools/apply_patches.mjs"`（校验通过后再调 patch-package），
     并把 `patch-package` 从 devDependencies 移到 dependencies（否则 --omit=dev 装不出来）。
  5. 清理：删 `patches/minecraft-data+3.97.0.patch.disabled`（或挪到 `patches/disabled/` 并在
     README 写清为什么留），旧 mineflayer 补丁按 F-DEP-003 处理。
verify: |
  cd mindcraft
  # 1) 正常状态 PASS（不回归基线）
  node tools/patch_integrity.mjs && echo OK      # exit 0
  npm run gate                                   # exit 0，且输出含 patch_integrity 行
  # 2) 篡改必须被抓到（这条 finding 的全部意义）
  cp patches/protodef+1.19.0.patch /tmp/p.bak
  printf '\n' >> patches/protodef+1.19.0.patch
  node tools/patch_integrity.mjs; echo "tamper_exit=$?"   # 非 0 且点名 protodef+1.19.0.patch
  npm run gate; echo "gate_exit=$?"                       # FAIL
  cp /tmp/p.bak patches/protodef+1.19.0.patch
  # 3) 干净安装不再依赖 dev-only 工具
  npm ci --omit=dev 2>&1 | tail -3               # 不应出现 patch-package not found
discovered_by: recon-scout
dept: D1-DEP

---
status: fix-ready-awaiting-commit（patch-smith · D1 修补）
see: docs/audit/night/manifest-D1.md 的对应小节（改动清单 + commit message 草稿 + 自检证据）
