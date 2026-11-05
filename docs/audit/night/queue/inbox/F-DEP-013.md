id: F-DEP-013
severity: medium
class: deps
file: mindcraft/package.json:45
evidence: |
  `F-DEP-012` 把 `start.bat` 的安装从 `npm install` 改成 `npm ci` —— 这解决的是**可复现性**，
  但**没有**解决安装期脚本执行面。复核席实测（我采信并复核了脚本清单）：

  ① `npm ci` **照样跑 lifecycle scripts**（`--omit=dev` 也一样）。本仓 `package.json:45` 就是
     `"postinstall": "patch-package"` —— 它必然要跑，否则 5 个补丁不生效。
  ② lock 里带 install/preinstall 脚本的包（recon D1 已统计）：
     `canvas`（`prebuild-install -r napi || node-gyp rebuild`）、`gl`（`prebuild-install || node-gyp rebuild`）、
     `protobufjs`、`@google/genai`（preinstall 是 no-op）、以及本包自己的 postinstall。
     `web/` 侧另有 `esbuild`、`fsevents`。
  ③ 也就是说：**"装依赖"这件事在结构上就等于"以当前用户身份执行若干第三方脚本"**。
     `npm ci` 只是让"装的是哪一版"变确定，没让"会不会执行脚本"变确定。

  出处：captain 2026-11-06 转述复核席裁定（"`npm ci` 仍然执行 lifecycle scripts ⇒ F-DEP-012 定性应改为
  '部分解决'"）；与 `F-DEP-004`（补丁=可执行代码）、`F-DEP-005/006`（lock 不受版本控制 / 缺 integrity）同一条链。
exploitability: |
  前置：投毒某个会被 `npm ci` 拉到并执行 install 脚本的包（transitive 也算）。
  能拿到什么：以当前用户身份执行任意代码 ⇒ 读 `keys.json`（真实 API key）、连本机 MC server、写持久化。
  **与 F-DEP-012 的差别**：改前是"可能 `npm install` 也可能不装"，改后是"`npm ci` 一定装且一定跑脚本" ——
  触发确定性提高了（这是好事：可复现），但**暴露面本身没变**。
  缓解现状：`gl` 条目已有 integrity（F-DEP-006 已补），所以"镜像换 tarball"这条路被摘要挡住；
  但 `sha256` 只证明"tarball 与首次记录一致"，不证明"这个包本身没有恶意 install 脚本"。
  影响半径：本机全部密钥与本地服务（安装期即执行）。
suggested_fix: |
  三选一或组合（都不新增依赖）：
  1. **安装期脚本白名单**：新增 `tools/verify_install_scripts.mjs`（纯 node，读 `package-lock.json` 的
     `hasInstallScript`）+ 在 README/启动脚本里列出"本仓预期只有这 5~7 个包有 install 脚本"，
     数量或名单变化即让人停下来看一眼（把它接进 `gate`，与 `patch_integrity` 同一族）。
  2. **`--ignore-scripts` + 显式 rebuild**：`npm ci --ignore-scripts` 后只对**白名单内的包**跑
     `npm rebuild canvas gl`（protobufjs/@google/genai 不需要编译），再单独跑 `patch-package`（它要在 finally 里跑）。
     代价：脚本变了但没 rebuild 时原生模块会静默失效 ⇒ 必须配一条"启动时自检 canvas/gl 能否 require"的探针。
  3. **接受风险并记录**：写进 `docs/audit/night/deps-baseline.md` 的接受风险清单，
     明确"装依赖 = 执行第三方脚本"这一事实，并要求"装依赖前先看 lock diff"。
  **不要**在没接入自检探针的情况下擅自上 `--ignore-scripts`（会让 canvas/gl 静默坏掉）。
verify: |
  # 1) 现状基线：有 install 脚本的包清单（应稳定）
  cd mindcraft && node -e "
    const l=require('./package-lock.json');
    const s=Object.entries(l.packages).filter(([k,v])=>v.hasInstallScript).map(([k])=>k);
    console.log(s.length, s.join(', '));"
  # 2) 若做了 (1)：名单变化必须让门禁红
  # 3) 若做了 (2)：装完后原生模块仍可用
  node -e "require('./node_modules/canvas'); require('./node_modules/gl'); console.log('native OK')"
  npm run gate:full
discovered_by: gate-keeper
note: |
  本条由 captain 转述的复核席裁定单独立项（原 F-DEP-012 的定性拆分）。
  与 `F-DEP-103`（lock 不入库）有交集：lock 入库后，"install 脚本名单变化"才有 diff 可看（本条修法 1 的前提）。
