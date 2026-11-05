id: F-DEP-008
severity: low
class: deps
file: mindcraft/package-lock.json:node_modules/tar
evidence: |
  审计里唯一的 critical 就在这条，必须写清"是不是 prod、能不能真被利用"：

  $ cd mindcraft && npm audit --json --registry=https://registry.npmjs.org
  metadata.vulnerabilities = {"moderate":15,"high":13,"critical":1,"total":29}

  ===== tar [critical] direct=false fix=true
  nodes: node_modules/tar
  critical node-tar: Decompression/parse DoS via unlimited input  GHSA-23hp-3jrh-7fpw  range=<=7.5.18
  high     Arbitrary File Creation/Overwrite via Hardlink Path Traversal  GHSA-34x7-hfp2-rc4v  range=<7.5.7
  high     Arbitrary File Overwrite / Symlink Poisoning  GHSA-8qq5-rm4j-mr97  range=<=7.5.2
  high     Arbitrary File Read/Write via Hardlink Target Escape  GHSA-83g3-92jg-28cx  range=<7.5.8
  high     Hardlink Path Traversal via Drive-Relative Linkpath  GHSA-qffp-2rhf-9h96  range=<=7.5.9
  high     Symlink Path Traversal via Drive-Relative Linkpath  GHSA-9ppj-qmqm-q256  range=<=7.5.10
  high     Race Condition in Path Reservations (Unicode ligature)  GHSA-r6q2-hw4h-h46w  range=<=7.5.3
  high     Unbounded recursion in mapHas/filesFilter  GHSA-r292-9mhp-454m  range=<=7.5.20

  命中版本 = 6.2.1（prod 树，但只在构建/安装期被调用）：
  $ node -e "..." # 读 lock
  tar 6.2.1  node_modules/tar  [prod]
  $ npm ls tar --all
  minecraft-ai-agent@
  `-- node-canvas-webgl@0.3.0
    `-- gl@8.1.6
      `-- node-gyp@10.3.1
        +-- make-fetch-happen@13.0.1
        | `-- cacache@18.0.4
        |   `-- tar@6.2.1 deduped
        `-- tar@6.2.1

  运行时可达性核查（这是把 critical 降到 low 的依据）：
  $ grep -rn "require('tar')\|from 'tar'" mindcraft/src mindcraft/main.js   → 无输出
  tar 只被 node-gyp（下载/解包 node headers）与 cacache 用到，即 `npm install` / `npm rebuild gl` 时。
  本仓没有任何运行时路径把外部 tarball 喂给 tar。
exploitability: |
  要触发路径穿越/无限解压，攻击者必须让 tar 去解一个**他控制内容的 tarball**，且发生在安装期：
  现实链条是"投毒 registry 响应或 MITM HTTPS"（与 F-DEP-005 / F-DEP-006 的镜像与 integrity 缺口叠加）。
  能拿到什么：任意文件写入（写 ~/.bashrc、写 node_modules 内的 .js 被后续 require）→ 安装期代码执行；
  或对超大流的 DoS 让安装卡死。
  拿不到什么：没有远程、无认证的运行时入口；不碰 keys.json 的读取（除非配合写入投递）。
  影响半径：仅安装/重建原生模块的那台机器，且需先攻破下载通道。
  诚实降级理由：审计口径 critical，但可达性=构建期 + 需通道失陷；与本仓真实的"安装期执行面"
  （F-DEP-004 patch-package、F-DEP-012 start.bat 自动 install）合起来才会构成完整链，
  因此本条按 low 排，修 F-DEP-004/005/006 的收益远大于本条。
suggested_fix: |
  1. **不要单独为了它跨主版本升 node-gyp**（node-gyp 10 的 tar 是 ^6；升到 node-gyp 11 才带 tar 7，
     属于主版本跳跃且 node-gyp 是 gl 的 native 构建工具，风险大于收益）。
  2. 若要做，最小改动是 overrides 里钉 tar 的补丁版本（只升小版本）：
     `"overrides": { ..., "tar": "^6.2.2" }`（6.x 是否已回补 GHSA-23hp-3jrh-7fpw 需修补者先用
     `npm view tar versions --registry=https://registry.npmjs.org` 核实；本机 `npm view` 被沙箱 EPERM 拦住，未能确认）
     然后 `cd mindcraft && rm -rf node_modules && npm ci && npm rebuild gl` 验证原生模块仍能构建。
  3. 若 6.x 无回补版本：**接受风险并记录**到 `docs/audit/night/deps-baseline.md`
     （tar 6.2.1 / 构建期-only / 依赖 F-DEP-005+006 修复后不可达），不要为了清 audit 数字乱升。
verify: |
  cd mindcraft
  # 1) 若做了 overrides，确认落在 6.x 且被 gl 构建接受
  node -e "console.log(require('./node_modules/tar/package.json').version)"        # 期望 6.2.x
  npm rebuild gl 2>&1 | tail -3                                                    # 必须成功
  # 2) 运行时确实不引 tar（守住"降级合理"这个前提）
  grep -rn "require('tar')\|from 'tar'" src main.js || echo "no runtime tar usage (expected)"
  # 3) 审计计数与基线一致
  npm audit --json --registry=https://registry.npmjs.org \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);
      console.log(JSON.stringify(a.metadata.vulnerabilities))})"
  # 4) 门禁不回归
  npm run gate:full
discovered_by: recon-scout
dept: D1-DEP

---
resolution: blocked（不修补；patch-smith · D1 修补）
verified_by_patch_smith: |
  recon 标注"6.x 是否已回补 GHSA-23hp-3jrh-7fpw 未核实（npm view 被 EPERM）"——**本轮已核实**：
    $ npm view tar versions --json --registry=https://registry.npmjs.org
    6.x 末尾: 6.2.0, 6.2.1  ⇒ **6.x 没有任何 >6.2.1 的版本**
  ⇒ 想修只能上 tar 7.x，而 tar 7 只从 node-gyp 11 起带上；node-gyp 是 gl 的 native 构建工具，
    属于跨主版本跳跃，PLAYBOOK §3 明确不做。overrides 钉 `tar@^6.2.2` **指向一个不存在的版本，写了就装不上**。
blocked: |
  无 6.x 回补版本 ⇒ 不存在"只升小版本"的修法。唯一路径（node-gyp 10→11 ⇒ tar 7）属跨主版本，
  且会动 native 构建链（gl/canvas 要 node-gyp 现场编译），风险远大于收益（本条可达性=构建期+通道失陷）。
  已按 recon 建议记入 deps-baseline.md 的接受风险清单，并把"6.x 无回补"这条硬事实写进去，避免下一个人重复查。
  若将来 node-gyp 自然升到 11（随 canvas/gl 升级），tar 会自动跟着上 7.x，那条链才算收口。
verify_after: `node -p "require('./package-lock.json').packages['node_modules/tar'].version"` 仍为 6.2.1；
  `grep -rn "require('tar')" src main.js` 仍无输出（运行时不可达的前提未变）。

## review（gate-keeper · t13 · 2026-11-06 02:2x）
**结论：通过（blocked 成立，理由经独立证实）。** commit：无代码改动。

实际执行 & 关键输出：
```
== tar [critical] fixAvailable=true
   range=<=7.5.18  GHSA-23hp-3jrh-7fpw  (Decompression/parse DoS via unlimited input)
   range=<=7.5.20  GHSA-r292-9mhp-454m
   …共 12 条 via，最大受影响上界 = 7.5.20
```
- **决定性证据**：所有 tar advisory 的上界都在 7.5.x（最高 `<=7.5.20`）⇒ **6.x 全部落在受影响区间内，
  数学上不可能存在"6.x 回补版"**。patch-smith 的"6.x 无回补"结论**成立**，且不依赖 `npm view`。
- ⚠️ 一条与 recon 口径的差异要记：recon 列了 8 条 via，现为 **12 条**（新增涉及 7.5.15/7.5.16/7.5.17/7.5.20
  的几条）。**包级计数没变**（critical 1 / high 13），所以基线不受影响，但"advisory 条目数"不是稳定判据，
  以后比对请用 `metadata.vulnerabilities` 的包级计数。
- "运行时零 `require('tar')`"我复核过：`grep -rn "require('tar')" src main.js` 无输出 ⇒ 仅 node-gyp/cacache 构建期可达。
裁定：跨主版本升 node-gyp（10→11）风险 > 收益，**blocked 正确**。**通过。**
