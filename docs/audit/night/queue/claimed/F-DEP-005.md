id: F-DEP-005
severity: medium
class: deps
file: mindcraft/package.json:53
evidence: |
  lock 里 100% 的 tarball 都指向第三方镜像，且有一个 script 会**删掉 lock 本身**：

  $ node -e "..." # 统计两个 lock 的 resolved host
  mindcraft/package-lock.json  entries=547  {"registry.npmmirror.com":547}
  web/package-lock.json       entries=112  {"registry.npmmirror.com":112}

  $ cd mindcraft && node -e "console.log(require('./package.json').scripts['clean:modules'])"
  node -e "const fs=require('fs');const p=require('path');['node_modules','package-lock.json']
  .forEach(f=>{...fs.rmSync(f,{recursive:true,force:true})...})"

  $ grep -n "clean:modules\|reinstall" mindcraft/package.json
  53: "reinstall": "npm run clean:modules && npm install"
  54: "clean:modules": "node -e \"...['node_modules','package-lock.json']...\""

  即：`npm run reinstall` = 删掉 package-lock.json 再用浮动 semver 重新解析全树。
  本仓 package.json 里 33 个生产依赖全是 `^` 范围 —— 删 lock 后每个 `^` 都会被解析到"当时最新"，
  包括传递依赖（`^` 的下游同样浮动）。
exploitability: |
  两条链：
  1) 镜像信任：全部 659 个 tarball 走 registry.npmmirror.com（第三方）。lock 里带 sha512 时镜像篡改会被
     完整性校验挡住；但**镜像本身是这份 lock 的生成者** —— lock 的 integrity 值也是从镜像返回的元数据抄来的，
     所以"镜像投毒 + 重新生成 lock"这一组合下完整性校验等于自证。攻击者需要控制镜像或中间人。
  2) 删 lock 重装：任何人（或"依赖装坏了，跑一下 npm run reinstall"这种日常操作）执行一次
     → 所有 `^` 重新解析到最新 → 新版本/新传递依赖未经任何审计进入 node_modules，
     且新 lock 的 integrity 基线全新，之后没人能对比"变了什么"。这是 typosquat / 依赖混淆
     （dependency-confusion）唯一的现实落地窗口 —— 本仓 package.json 里的依赖名没有 scope 保护的那几个
     （`mineflayer-schem`、`minecraft-assets`、`node-canvas-webgl`、`google-translate-api-x`）都属于
     容易被占位的形态。
  影响半径：本机（安装期即执行 install 脚本，见 F-DEP-006/F-DEP-012）。
suggested_fix: |
  1. 从 `clean:modules` 里去掉 `package-lock.json`，只删 node_modules：
     `"clean:modules": "node -e \"require('fs').rmSync('node_modules',{recursive:true,force:true})\"`，
     `reinstall` 改成 `npm run clean:modules && npm ci`（`ci` 严格按 lock 装，lock 缺失或与 package.json 不一致会直接失败）。
  2. lock 改回官方源重建（一次性动作，须在干净环境做）：
     `cd mindcraft && rm -rf node_modules package-lock.json && npm install --registry=https://registry.npmjs.org`
     然后**把 lock 的 diff 单独提交**（commit body 写明"仅切换 registry，依赖版本未变；diff 里出现的
     版本变化逐条列出"）。web/ 同样处理。
  3. 若坚持用镜像：至少在 lock 里保留 integrity（当前 `node_modules/gl` 那条是缺的，见 F-DEP-006），
     并在 `docs/audit/night/deps-baseline.md` 记录 659 个 tarball 的 integrity 摘要。
verify: |
  # 1) lock 全部指向官方源
  cd "E:/我的世界ai" && node -e "
    for (const f of ['mindcraft/package-lock.json','web/package-lock.json']){
      const l=require('./'+f); const h={};
      for(const v of Object.values(l.packages)) if(v.resolved){const x=new URL(v.resolved).host; h[x]=(h[x]||0)+1;}
      console.log(f, JSON.stringify(h)); }"
  # 期望：{"registry.npmjs.org":N}，npmmirror 计数为 0
  # 2) 不再删 lock
  cd mindcraft && node -e "const s=require('./package.json').scripts; if(/package-lock/.test(s['clean:modules'])) {console.log('FAIL: still deletes lock'); process.exit(1)} else console.log('OK')"
  # 3) ci 可用（lock 与 package.json 一致）
  npm ci --dry-run 2>&1 | tail -3
discovered_by: recon-scout
dept: D1-DEP

---
status: fix-ready-awaiting-commit（patch-smith · D1 修补）
see: docs/audit/night/manifest-D1.md 的对应小节（改动清单 + commit message 草稿 + 自检证据）
