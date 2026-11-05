id: F-DEP-006
severity: medium
class: deps
file: mindcraft/package-lock.json:3260
evidence: |
  lock 里 `gl` 这条**没有 resolved、没有 integrity**，而它恰好是会执行安装脚本的原生包：

  $ cd mindcraft && node -e "console.log(JSON.stringify(require('./package-lock.json').packages['node_modules/gl'],null,1))"
  {
   "version": "8.1.6",
   "hasInstallScript": true,
   "license": "BSD-2-Clause",
   "dependencies": { "bindings", "bit-twiddle", "glsl-tokenizer", "nan", "node-abi",
                     "node-gyp": "^10.2.0", "prebuild-install": "^7.1.2" },
   "engines": { "node": ">=18.0.0" }
  }

  $ cd mindcraft && node -e "console.log(require('./node_modules/gl/package.json').scripts.install)"
  prebuild-install || node-gyp rebuild

  同一次扫描：mindcraft 里"有 integrity"的条目 546/547，唯一缺口就是这条；
  而带 install 脚本的包共 5 个（canvas、gl、protobufjs、@google/genai、以及本包自己的 postinstall）。

  成因：package.json 用 `overrides` 把 gl 钉到 8.1.6（`"overrides": {"canvas":"^3.1.0","gl":"^8.1.6"}`），
  这条 override 生成的 lock 条目没有回填 resolved/integrity —— 等于这条依赖**不受 lock 的完整性保护**。
exploitability: |
  前置条件：npm registry（或镜像，见 F-DEP-005）对该包名+版本返回被替换的 tarball，
  或本地网络被中间人。
  能拿到什么：因为 `gl` 有 `prebuild-install || node-gyp rebuild` 的 install 脚本，
  安装即执行 —— 在被污染的 tarball 下，恶意脚本以当前用户身份运行，无需任何运行时前提。
  没有 integrity 就等于 npm 无法发现 tarball 与"首次记录的摘要"不一致（首次安装时算出的摘要
  恰恰会被写进内存而不是这里已提交的 lock）。

  影响半径：开发机/机器人主机（含 keys.json 里的真实 key）。触发时机是每次 `npm install`/`npm ci`
  在没有预置 node_modules 的机器上。
suggested_fix: |
  1. 让 lock 重新回填 integrity（在有网、干净目录里做，不要直接改 lock 文本）：
     `cd mindcraft && rm -rf node_modules package-lock.json && npm install --registry=https://registry.npmjs.org`
     然后确认 `packages['node_modules/gl'].integrity` 以 `sha512-` 开头。
  2. 顺带把 `overrides` 的目的写清楚：如果 gl 8.1.6 的钉版只是为了兼容 node 版本，
     保留 override，但必须在 lock 里带 integrity（override 不应产生无摘要条目）。
  3. 若重建后仍缺 integrity，退而求其次：在 `docs/audit/night/deps-baseline.md` 里记录
     `sha512` 摘要（`npm view gl@8.1.6 dist.integrity` 在有网机器上取一次），
     并在安装脚本里比对；不要放任它裸奔。
verify: |
  cd mindcraft
  node -e "const v=require('./package-lock.json').packages['node_modules/gl'];
           if(!v.integrity){console.log('FAIL: gl still has no integrity');process.exit(1)}
           console.log('OK', v.integrity.slice(0,20)+'…')"
  # 全树完整性覆盖率
  node -e "const l=require('./package-lock.json');
           const bad=Object.entries(l.packages).filter(([p,v])=>p&&!v.integrity&&!v.link);
           console.log('missing integrity:', bad.length, bad.map(x=>x[0]).join(',')||'none');
           if(bad.length) process.exit(1)"
  # 安装仍然可用
  npm ci --dry-run 2>&1 | tail -3
discovered_by: recon-scout
dept: D1-DEP

---
status: fix-ready-awaiting-commit（patch-smith · D1 修补）
see: docs/audit/night/manifest-D1.md 的对应小节（改动清单 + commit message 草稿 + 自检证据）

---
status_update: fix-applied-on-disk-verified / not-durable
note: |
  `gl@8.1.6` 的 `resolved`+`integrity` 已写入 `mindcraft/package-lock.json` 并验证（全树 integrity 覆盖 547/547，
  sha512 用真实 tarball 下载+哈希比对过：5913101 bytes，MATCH=true）。
  **但 `package-lock.json` 被 `mindcraft/.gitignore:4` 排除** ⇒ 这次修复**进不了 git 历史**，
  captain 提交时 `git status` 里根本看不到它。durability 依赖 **F-DEP-103**（取消 ignore 并首次入库 lock）。
  ⇒ 本条的实际状态是"已修好且已验证，但需 F-DEP-103 落地后才真正生效/可回滚"。
