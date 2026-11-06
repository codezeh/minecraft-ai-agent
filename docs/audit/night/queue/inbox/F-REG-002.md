id: F-REG-002
severity: high
class: deps
file: mindcraft/package.json:56
evidence: |
  **F-DEP-005 与 F-DEP-012 把 `npm install` 换成了 `npm ci`，但 `package-lock.json`
  至今仍被 `.gitignore` 排除且从未入库 ⇒ 新机器/新 clone 上 `npm ci` 必然失败，启动链路当场断。**

  ## 一、两个修复都依赖同一个前提，而前提不成立
  `mindcraft/package.json:56`（F-DEP-005 改的）：
  ```json
  "reinstall": "npm run clean:modules && npm ci"
  ```
  `mindcraft/start.bat:88-98`（F-DEP-012 改的）：
  ```bat
  if not exist "%ROOT%mindcraft\node_modules" (
      echo [WARN] mindcraft\node_modules missing. Running npm ci first (strict, per lock) ...
      call npm ci
      if errorlevel 1 (
          echo [ERROR] npm ci failed - do NOT use --ignore-scripts, it silently drops patches/.
          echo [ERROR] Fix the node_modules / package-lock.json mismatch, then run this file again.
          popd
          pause
          exit /b 1
      )
  )
  ```
  两处都写着 "strict, per lock" —— 但 lock **没入库**：
  ```
  $ cd mindcraft && git ls-files | grep -c package-lock.json
  0                                    ← 未跟踪
  $ git check-ignore -v package-lock.json
  .gitignore:4:package-lock.json       ← 被忽略
  $ ls -la package-lock.json
  286159 bytes                         ← 只存在于这台机器的磁盘上
  ```

  ## 二、失败是确定性的，不是概率问题
  `npm ci` 的硬性前提就是"存在 package-lock.json 且与 package.json 同步"。新机器上：
  ```
  $ git clone <mindcraft 仓> && cd mindcraft && npm ci
  npm error The `npm ci` command can only install with an existing package-lock.json
  ```
  而 `start.bat` 现在**失败即中止**（F-DEP-012 的改动），所以：
  **新机器双击 start.bat → 直接退出，一句 "Fix the node_modules / package-lock.json mismatch"
  让人去修一个根本不存在的文件。**
  `npm run reinstall` 同理（虽然它不再删 lock，但新机器上没有 lock 可留）。

  ## 三、这不是"理论上的新机器"，三条现实触发路径
  1. 换机 / 重装系统 / 把仓库 clone 到第二台电脑（本项目是多机使用的：`config/network.json`
     整段在讲"手机/局域网连"，说明用户至少有另一台设备）。
  2. `git clean -xdf` 或任何人按 `.gitignore` 语义"清掉未跟踪文件" —— lock 会被清掉。
  3. **`clean:modules` 的另一半语义仍被文档承诺**：`mindcraft/docs/architecture/09_crosscut.md:110`
     至今写着"依赖锁 | `package-lock.json` 被忽略 | **提交它**"（待做项），
     而 F-DEP-005 已经让 `reinstall` 依赖它了 —— **文档说"待做"，代码已经"必须做"**。

  ## 四、还抵消了 D1 自己的结论
  D1 我给 `F-DEP-005` 的证据是"659 个 tarball 全走 `registry.npmmirror.com`"，
  那 659 条 **resolved + integrity** 只存在于**未入库的 lock** 里。
  ⇒ 新机器上不仅装不了，就算手动 `npm install` 也会按 `^` 范围重新解析
  （package.json 里 33 个生产依赖全是 `^`），**D1 想要的"可复现 + 完整性基线"在新机器上等于零**。
  这与 `F-DEP-004`（patch_integrity + SUMS）想守的东西是同一件事的两半：
  补丁有基线，依赖没有基线。
exploitability: |
  攻击者视角：无直接攻击收益（这是可用性 + 供应链可复现性问题）。
  但供应链视角有实质意义：**未入库的 lock = 每台新机器都重新解析一次浮动版本**，
  正是 D1 的 F-DEP-005 想治理的"镜像/解析漂移"窗口，只是现在被"新机器"这个场景反复打开。
  用户视角：新机器上"启动不了"，而错误信息指向一个不存在的文件；
  最常见的自救是 `npm install`（浮动解析）或 `npm ci --ignore-scripts`
  —— 后者**恰好是 F-DEP-012 自己警告"会静默丢掉 patches/"的那条路**。
  影响半径：新机器完全无法启动；存量机器不受影响（lock 还在磁盘上）。
  为什么定 high：它是**我们自己的两个修复直接造成的确定性失败**，
  触发条件（换机/clone/clean）在真实使用中必然发生，且失败后的自救路径会把用户
  推回我们刚堵上的那个坑（`--ignore-scripts`）。
suggested_fix: |
  **一行改动 + 一次重新生成，把前提补上**（这也是 `09_crosscut.md:110` 早就写着的待做项）：
  1. `mindcraft/.gitignore:4` **删掉 `package-lock.json` 这一行**（该文件在 mindcraft 仓里
     被忽略是本项目历史选择；但既然 `npm ci` 已成为唯一安装路径，就必须入库）。
  2. `git add mindcraft/package-lock.json` 并按 §7 规矩**逐文件显式 add**（禁 `-A`）。
     注意：本仓有 `421 M` 的 stat 缓存噪音（gate-keeper 已记录），别被 `git status` 吓到。
  3. 提交前确认 lock 与 package.json 同步：`npm ci --dry-run`（不装、只校验）应 exit 0。
  4. **可选但推荐**：lock 入库时顺带把它从 `registry.npmmirror.com` 重建为
     `registry.npmjs.org`（D1 的 `F-DEP-005` 主诉求），这样"锁 + 官方源"一起落地。
     但**别混进同一个 commit**：先"入库"（本条），再"换源"（F-DEP-005 剩余部分），
     避免 diff 里既有 659 行 host 变更又有新增文件，复核没法看。
  5. `mindcraft/docs/architecture/09_crosscut.md:110` 的"提交它 / 待做"改成"已入库"。
verify: |
  cd mindcraft
  # 1) lock 已入库（硬判据）
  git ls-files | grep -c "^package-lock.json$"; echo "期望 1"
  git check-ignore -q package-lock.json && echo "FAIL 仍被忽略" || echo "OK 不再忽略"
  # 2) 模拟新机器：从 HEAD 导出一份干净副本，只靠 git 内容能否装起来
  git worktree add /tmp/reg002 HEAD && cd /tmp/reg002
  ls package-lock.json && npm ci --dry-run; echo "npm ci --dry-run exit=$?  期望 0"
  # 3) 同步性：lock 与 package.json 不漂移
  node -e "const l=require('./package-lock.json'), p=require('./package.json');
           const a=Object.keys(p.dependencies||{}).sort(), b=Object.keys(l.packages[''].dependencies||{}).sort();
           console.log(JSON.stringify(a)===JSON.stringify(b) ? 'OK 依赖集合一致' : 'FAIL 漂移');"
  # 4) start.bat 的失败分支不再被这条触发（人工：干净副本上双击 start.bat 应能装完并启动）
  # 5) 门禁不回归
  npm run gate:full
discovered_by: recon-scout
dept: REG

---
> **别名（R3-7 台账收口）**：`F-REG-002 ≡ F-DEP-103` —— 同一缺陷，**主号是 `F-DEP-103`**（在 `verified/`，状态 blocked）。
