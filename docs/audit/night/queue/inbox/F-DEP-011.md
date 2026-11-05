id: F-DEP-011
severity: low
class: deps
file: web/package-lock.json:node_modules/minimatch
evidence: |
  web/ 面板有独立 lock，之前从没被审计过（patch-smith 的 F-DEP-002 也指出这点）。本轮实测：

  $ cd web && npm audit --json --registry=https://registry.npmjs.org
  metadata.vulnerabilities = {"info":0,"low":0,"moderate":3,"high":0,"critical":0,"total":3}

  ===== @vue/language-core [moderate] direct=false effects=["vue-tsc"] fix=false
     via-> minimatch
  ===== minimatch [moderate] direct=false effects=["@vue/language-core"]
  moderate minimatch has potential denial of service via globparts amplification
       GHSA-g3hv-75wg-m249  range=>=7.0.0 <11.0.1  cwe=CWE-400
  ===== vue-tsc [moderate] direct=true fix=false

  版本与 prod/dev 归属（关键：**全部是 devDependencies**）：
  $ node -e "..." # 读 web/package-lock.json
  vue          3.5.44   [prod]
  socket.io-client 4.8.4 [prod]
  three        0.170.0  [prod]
  vite         6.4.5    [dev]
  typescript   5.9.3    [dev]
  vue-tsc      2.2.12   [dev]
  @vue/language-core 2.2.12 [dev]
  minimatch    9.0.9    [dev]

  结论：web 侧 **0 条 critical / 0 条 high**；3 条 moderate 全部落在 `vue-tsc`（typecheck 工具）链上，
  不进 `vite build` 产物、不进运行时 bundle、不随面板发布。
  另：web/package.json 无 postinstall / 无自定义 install 脚本（只有 dev/build/preview/typecheck），
  lock 里带 install 脚本的仅 esbuild（vite 必需）与 fsevents（macOS 可选）。
exploitability: |
  minimatch ReDoS 需要攻击者控制传给 minimatch 的 glob 字符串。此处的 glob 来源是
  vue-tsc 读取本地 tsconfig 的 include/exclude —— 即"能改仓库 tsconfig 的人"，
  而那种人本来就能直接改源码。开发机本地跑 typecheck 时最多卡住 CI/本地命令。
  影响半径：开发/CI 机，且需本地输入；生产面板与机器人进程零影响。
suggested_fix: |
  **本轮不动。** 理由：无 high/critical；唯一修复路径是把 vue-tsc/@vue/language-core 提到
  minimatch >=11 的版本线（跨 minor/major），会改变 typecheck 行为，属于 PLAYBOOK §3 的"不做大规模重构"。
  建议动作只有一条：把本次审计结果写进 `docs/audit/night/baseline.md` / `deps-baseline.md`
  （web: 3 moderate, 全 dev-only, 无 high/critical），作为后续回归的比对基线。
  若后续 vite/vue-tsc 自然升级到带 minimatch 11 的版本线，再随常规升级一起走，不要为它单独跨版本。
verify: |
  cd web
  # 基线计数必须仍是 0 high / 0 critical
  npm audit --json --registry=https://registry.npmjs.org \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);
       const v=a.metadata.vulnerabilities;
       console.log(JSON.stringify(v));
       if(v.high||v.critical){console.log('REGRESSION');process.exit(1)}})"
  # 已有的门禁仍然通过（这是 web 侧唯一硬要求）
  npm run typecheck && npm run build
discovered_by: recon-scout
dept: D1-DEP
