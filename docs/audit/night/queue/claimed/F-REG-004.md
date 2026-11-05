id: F-REG-004
severity: low
class: config
file: mindcraft/start.bat:88
evidence: |
  **F-DEP-012 的 `npm ci` 修复落在一个"没有调用方"的文件里；真正被用户点的
  `启动面板.bat` 走的是另一条链，那条链在 node_modules 缺失时没有任何安装兜底。**

  ## 一、`mindcraft/start.bat` 在本仓没有调用方（实测）
  ```
  $ cd "E:/我的世界ai" && grep -rn "start.bat" --include="*.bat" --include="*.ps1" . | grep -v node_modules
  （无输出）
  ```
  `启动面板.bat` 的实际链路是：
  ```bat
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-panel.ps1"
  ```
  而 `scripts/start-panel.ps1:187-191` 是**直接起 main.js**，不经过 start.bat：
  ```powershell
  Start-Process -FilePath $node -ArgumentList 'main.js' `
      -WorkingDirectory (Join-Path $root 'mindcraft') `
      -RedirectStandardOutput $mcOut ... -WindowStyle Hidden
  if (-not (Wait-Port 8080 90 'mindserver')) { exit 1 }
  ```
  ⇒ 两条启动路径完全独立：
  | 入口 | 会不会自动装依赖 | 失败时 |
  |---|---|---|
  | `启动面板.bat` → `start-panel.ps1` | **不会**（只有一处 `web\node_modules` 的警告，`:141`） | 等 90 秒 `Wait-Port` 超时 → `exit 1` |
  | `mindcraft/start.bat`（双击/命令行） | 会（`npm ci` + 完整性预检） | 明确报错并中止（F-DEP-012 改的） |

  ## 二、所以面板链路缺依赖时的表现是"静默等 90 秒然后退出"
  `node main.js` 在 node_modules 缺失时会立刻抛 `ERR_MODULE_NOT_FOUND`（如 `express`/`mineflayer`），
  进程直接死；而 `start-panel.ps1` 只会在 `Wait-Port 8080 90` 上耗满 90 秒再 `exit 1`，
   用户看到的是"一直在等"而不是"依赖没装"。
  `start-panel.ps1:141` 那行警告**只针对 `web\node_modules`**，对 `mindcraft\node_modules` 没有任何检查。

  ## 三、与 F-REG-002 叠加后是同一个坑的两面
  F-REG-002 说"新 clone 上 `npm ci` 必失败"；本条说"面板链路根本不会尝试装"。
  两条合起来的现实后果：**新机器上只有双击 `mindcraft/start.bat` 这一条路能看到"到底哪儿错了"，
  而它会因为 lock 不在库里直接失败**（F-REG-002）—— 用户于是两头都走不通。
exploitability: |
  不是攻击面，是运维可用性 + 排障体验：
  - 用户视角：双击"启动面板"→ 黑窗口等 90 秒 → 什么都没说就退了；
    或者双击 `mindcraft/start.bat` → 被告知 `package-lock.json mismatch`。
  - 攻击者视角：无收益。
  影响半径：首次部署/换机（其他时候 node_modules 都在，不触发）。
  定 low：不改安全结论，只是"我们修的那条路不是用户走的那条路"——
  但如果不记下来，F-DEP-012 会被后人读成"依赖安装已经兜住了"，而实际上主路径没兜。
suggested_fix: |
  **在 `scripts/start-panel.ps1` 里补一段与 start.bat 等价的预检**（约 8 行，不改其它逻辑）：
  ```powershell
  # 2) 起 mindcraft 之前：依赖与补丁完整性必须先在，否则 node main.js 立刻死，用户只会看到"等 90 秒"
  $mcDir = Join-Path $root 'mindcraft'
  if (-not (Test-Path (Join-Path $mcDir 'node_modules'))) {
      Write-Warn2 'mindcraft\node_modules 缺失 —— 先跑 npm ci（需要 package-lock.json）'
      Push-Location $mcDir
      try {
          & npm ci
          if ($LASTEXITCODE -ne 0) {
              Write-Bad '[错误] npm ci 失败。不要用 --ignore-scripts（会静默丢掉 patches/）。'
              Write-Bad '       若报 package-lock.json missing，说明 lock 未入库 —— 见 F-REG-002。'
              exit 1
          }
      } finally { Pop-Location }
  }
  # 补丁完整性（与 start.bat:76-79 同一判据，单一真相源）
  Push-Location $mcDir
  try { & node tools\patch_integrity.mjs --no-version-check; if ($LASTEXITCODE -ne 0) { Write-Bad '[错误] 补丁完整性失败'; exit 1 } }
  finally { Pop-Location }
  ```
  要点：① 判据与 `start.bat` **同一份**（别抄逻辑，直接调同一个脚本）；
  ② 失败要说人话并指向 F-REG-002 的 lock 问题；
  ③ `Wait-Port` 的超时提示也应区分"没起来"与"依赖没装"。
  另一条更彻底的方案：**让 `启动面板.bat` 统一走 `mindcraft/start.bat` 的环境准备部分**
  （把"装依赖 + 验补丁"抽成 `scripts/prepare-mindcraft.ps1`，两条链都调），消除双份真相。
verify: |
  cd "E:/我的世界ai"
  # 1) 静态：面板链路有依赖预检
  grep -nE "node_modules|npm ci|patch_integrity" scripts/start-panel.ps1 | head   # 期望看到 mindcraft 的检查
  # 2) 动态：模拟 node_modules 缺失
  #    （别真删共享目录！用临时 worktree 验证：见 F-REG-002 的 git worktree 手法）
  git worktree add /tmp/reg004 HEAD
  cd /tmp/reg004 && mv mindcraft/node_modules mindcraft/node_modules.bak
  # 触发面板脚本的预检分支，期望：立刻给出"缺依赖 + 该跑什么"，而不是等 90 秒
  # 3) 正向对照：依赖齐全时面板行为不变（不多花时间、不误报）
  #    人工：node_modules 存在时双击 启动面板.bat，应直接进面板且无新增告警
discovered_by: recon-scout
dept: REG

---
status: 已并入 F-DEP-004 的 D1 修复（同一处启动接线）
见: docs/audit/night/manifest-D1.md 的 "D1 检查跑在载荷落盘之后" 行 —— start.bat 的完整性闸已前移到 npm ci 之前且每次启动都跑。
