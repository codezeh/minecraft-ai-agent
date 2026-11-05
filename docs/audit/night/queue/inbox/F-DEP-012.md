id: F-DEP-012
severity: low
class: deps
file: mindcraft/start.bat:71
evidence: |
  正常启动路径里藏着一次"无审查的安装期代码执行"：

  $ sed -n '70,75p' mindcraft/start.bat
  if not exist "%ROOT%mindcraft\node_modules" (
      echo [WARN] mindcraft\node_modules missing. Running npm install first ...
      pushd "%ROOT%mindcraft"
      call npm install
      popd
  )

  谁触发：`启动面板.bat` → `scripts/start-panel.ps1`；以及 start.bat 被直接双击/被计划任务调用时。
  也就是说"用户点一下启动"就可能变成"跑一次 npm install"，而 npm install 会执行：
  $ node -e "..." # 统计两个 lock 里 hasInstallScript 的包
  mindcraft/package-lock.json  install-script packages: 5  (canvas, gl, protobufjs, @google/genai, +本包 postinstall)
  web/package-lock.json        install-script packages: 2  (esbuild, fsevents)

  其中：
  $ node -p "require('./mindcraft/node_modules/canvas/package.json').scripts.install"
  prebuild-install -r napi || node-gyp rebuild
  $ node -p "require('./mindcraft/node_modules/gl/package.json').scripts.install"
  prebuild-install || node-gyp rebuild
  $ node -p "JSON.stringify(require('./mindcraft/node_modules/@google/genai/package.json').scripts.preinstall)"
  "echo 'preinstall: no-op'"

  并且这条 install 用的是 `npm install` 而不是 `npm ci` —— 会按 package.json 的 `^` 范围
  重新解析（lock 只在"允许范围内浮动"时被沿用），再叠加 F-DEP-005 里 `clean:modules` 会删 lock 的
  脚本，等价于"启动时可能拉进未经审计的新版本并执行其安装脚本"。
  同一路径还有个副作用：`npm install` 会重跑 postinstall（patch-package），而当前补丁集已漂移
  （F-DEP-003）→ 一次正常启动可能直接把 mindcraft 的 node_modules 搞成半应用/报错状态。
exploitability: |
  前置条件：node_modules 缺失（新机器、清理过、`npm run reinstall` 之后）+ 上游某依赖版本被投毒
  或 lock 被浮动解析到带恶意 install 脚本的版本。
  能拿到什么：以当前用户身份执行任意代码（安装脚本），读 keys.json/.env、连本机 MC server。
  与 F-DEP-004（patch-package 注入）叠加时，攻击者只要拿到"能改 patches/ 或某个依赖版本"的位置，
  就能在用户点"启动"时稳定复现执行，不需要用户主动跑 npm。
  影响半径：本机全部密钥。触发频率低（仅 node_modules 缺失时），但触发者完全不知情。
suggested_fix: |
  1. `start.bat` 里把 `call npm install` 换成 `call npm ci`（严格按 lock 装，且 lock 与 package.json
     不一致时直接报错而不是偷偷升版）；并在失败时 `echo [ERROR] 依赖安装失败，请手动检查 lock/补丁`
     `exit /b 1`，不要继续往下 `start Mindcraft`。
  2. 安装前加一步完整性预检（复用 F-DEP-004 的脚本）：
     `node tools/patch_integrity.mjs || (echo [ERROR] 补丁被改动 & exit /b 1)`
  3. 更保守的选择：把这段自动安装改成**提示**（打印"请先运行 npm ci"并退出），
     让"要不要装依赖"永远是人的显式决定 —— 供应链上，自动安装 = 自动执行。
verify: |
  # 1) 不再用 npm install
  cd "E:/我的世界ai" && grep -n "npm install" mindcraft/start.bat && echo "FAIL: still npm install" || echo "OK"
  grep -n "npm ci" mindcraft/start.bat                     # 期望命中
  # 2) 安装失败必须阻断启动（人工验：临时把 lock 改坏 → 双击启动 → 不应起 Mindcraft 窗口）
  cd mindcraft && cp package-lock.json /tmp/l.bak && printf ' ' >> package-lock.json
  cmd //c start.bat 2>&1 | grep -i "error\|依赖安装失败"   # 期望报错并退出
  cp /tmp/l.bak package-lock.json
  # 3) 正常路径仍能起（node_modules 存在时不走安装分支）
  cmd //c start.bat 2>&1 | grep -c "Running npm install first"   # 期望 0
discovered_by: recon-scout
dept: D1-DEP
