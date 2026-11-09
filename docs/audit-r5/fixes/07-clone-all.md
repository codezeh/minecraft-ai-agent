# R5-004 实质改善：把「两个仓一起拉起来」做成一条可验证命令

> 任务：t19（attempt 2）。
> 前置约束（用户已定）：**不改 submodule、不配远端、不推送**，本轮只做本地提交。
> 因此这里的"实质改善"不是把父仓改成能跟踪子仓，而是：**让"从零部署"从"靠人记得 clone 两次"变成一条会自检、会明确报错的命令。**

## 0. 结论

| 项 | 结果 |
|---|---|
| 新增 `scripts/clone-all.ps1` | ✅ UTF-8 **with BOM**、CRLF、PS 5.1 解析器 `0 errors` |
| `-LocalSource` 端到端 | ✅ **EXIT 0**，两仓就位：父仓 `92d405c` / 子仓 `33b4327` |
| 半成品状态（父仓成功、子仓失败） | ✅ **EXIT 1** + 明确报错 + 可照做的修复命令 |
| `-Ref` 正常 / 不存在 | ✅ EXIT 0 检出成功 / ✅ EXIT 1 明确报错 |
| 目标目录非空 | ✅ 拒绝覆盖，EXIT 1 |
| 干净克隆里 `release.ps1 -VerifyOnly` | ⚠️ **EXIT 1** —— 见第 4 节：**依赖 T14 的暂存被提交** |
| 干净克隆里 `npm ci` | ✅ **EXIT 0**，548 包，5 个补丁全应用 |
| README 顶部「从零开始」 | ✅ 已补（3 条命令 + clone-all 说明），并把"必须两个仓都 clone"改成可执行命令 |

## 1. 为什么需要这个脚本（R5-004 的用户体感）

父仓 `.gitignore:13` 是 `/mindcraft/`，所以：

```
$ git ls-tree HEAD -- mindcraft
（空输出）
$ git ls-files mindcraft | wc -l
0
```

只 clone 父仓拿到的是"控制脚本 + 前端源码"，**没有 `main.js`、没有 `mindserver`、没有 `Dockerfile`、没有 `web-dist`**。
以前这件事只写在 README 里靠人记，漏一步的报错是运行期"找不到 main.js"这种毫无指向性的错误。

脚本把这一步变成：**clone 父仓 → 显式检查有没有 `mindcraft/` → 没有就补 clone → 校验两仓 HEAD/ref → 打印下一步命令**，任何一步不对就带修复建议退出。

## 2. 脚本行为（`scripts/clone-all.ps1`）

### 2.1 参数

| 参数 | 说明 |
|---|---|
| `-ParentUrl` | 父仓地址。`-LocalSource` 时省略则取本脚本所在仓库根 |
| `-MindcraftUrl` | 子仓地址。`-LocalSource` 时省略则取 `<父仓根>/mindcraft` |
| `-Dest` | **必填**。父仓落到这里，子仓落到 `<Dest>/mindcraft` |
| `-Ref` | 可选。两个仓都检出该 ref（分支/标签/提交哈希） |
| `-LocalSource` | 从本机路径 clone（`git clone --no-hardlinks <路径>`），用于"没有远端也能真跑验证" |

### 2.2 七个步骤

1. **环境前置**：`git --version` 必须可用；`-LocalSource` 时校验两条路径都存在且都是 git 仓库（否则给出比 git 原生更易懂的报错）。
2. **建目标目录**：已存在且非空 → **拒绝**，绝不覆盖（不替用户删东西）。
3. **clone 父仓**。
4. **关键检查：父仓里有没有 `mindcraft/`** —— 三种情况分别处理：
   - 不存在 → 正常（说明父仓确实没跟踪子仓），提示"只 clone 父仓跑不起来，下面补"；
   - 存在但**空目录** → 视为未就位，删掉后补 clone；
   - 存在且是 git 仓库 → 说明父仓把它当 gitlink 收了，**跳过**第 2 次 clone（避免嵌套覆盖）并 warn。
5. **clone 子仓到 `<Dest>/mindcraft`**；失败时：清掉 git 留下的"只有 `.git` 的空壳目录"，然后报**半成品状态**错误。
6. **校验**：两仓都在、都是 git 仓库、打印 HEAD 短哈希 + 分支 + 提交数 + 提交标题；带 `-Ref` 时校验 HEAD 与该 ref 指向同一提交。
7. **打印下一步命令**，并额外自检 `mindcraft/web-dist/` 与 `MANIFEST.json` 是否随仓库到位（缺了会明说镜像会构建失败）。

### 2.3 两个实现上的坑（都实测踩到并修掉了）

**(a) `$ErrorActionPreference='Stop'` 会让"git 写 stderr"直接终止脚本。**
第一版脚本在子仓 clone 失败时**崩溃**（抛 `NativeCommandError`），根本没走到我写的明确报错分支 —— 这恰好违反了本任务的核心验收。修法：在 `Invoke-Git` 内部局部把 `$ErrorActionPreference` 放宽成 `Continue`，把 stderr 当普通文本收集，失败一律按 `ExitCode` 判断。顺带过滤掉 PowerShell 包装产生的 `System.Management.Automation.RemoteException` 噪声行。

**(b) `git clone` 失败会留下一个只含 `.git` 的空壳目录。**
如果不清理，下次再跑第 4 步会把它当成"父仓自带 mindcraft/"，把问题藏起来。现在失败路径会先 `Remove-Item` 再报错。

**(c) `-Ref` 到本地分支会失败（不是参数错，是 clone 语义）。**
本地分支/未推送的提交不会随 clone 过来。第一版直接报"ref 不存在"，容易误导人以参数写错。现在依次尝试：直接 `rev-parse` → `origin/<ref>` → `git fetch origin <ref>`，并在最终报错里写明原因（"本地分支/未推送的提交不会随 clone 过来"）和排查命令。

## 3. 端到端实测：主路径

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/clone-all.ps1 -LocalSource -Dest tmp/r5-bootstrap/repo
```

```
EXIT_CLONEALL=0

[1] 环境前置：git 可用性与参数解析
  PASS  git 2.56.0.windows.4.niugit
  INFO  -LocalSource：父仓 ← E:/我的世界ai
  INFO  -LocalSource：子仓 ← E:\我的世界ai\mindcraft
  INFO  目标目录：E:\我的世界ai\tmp\r5-bootstrap\repo

[2] 建立目标目录（已存在且非空则拒绝，绝不覆盖）
  PASS  已创建 E:\我的世界ai\tmp\r5-bootstrap\repo

[3] clone 父仓
  PASS  父仓已 clone 到 E:\我的世界ai\tmp\r5-bootstrap\repo

[4] 检查父仓克隆里是否自带 mindcraft/（这就是 R5-004 的坑）
  INFO  父仓克隆里没有可用的 mindcraft/ —— 符合预期（父仓 .gitignore:13 排除了 /mindcraft/）。
  INFO  → 只 clone 父仓 = 有控制脚本、没有业务代码，跑不起来。这一步必须补，下面补。

[5] clone mindcraft 子仓到 <Dest>/mindcraft
  PASS  子仓已 clone 到 E:\我的世界ai\tmp\r5-bootstrap\repo\mindcraft

[6] 校验：两个仓都已就位，HEAD 与 ref 一致
  PASS  [父仓] HEAD 92d405c (main) · branch main · 79 commits · feat(ops): 地图备份做成开关且默认开启…
  PASS  [子仓] HEAD 33b4327 (main) · branch main · 302 commits · feat(identity): 允许离线 + 保留正版验证开关 (R4 t27)
  PASS  父仓：92d405c  子仓：33b4327
  PASS  子仓自带 web-dist/（含 index.html）—— 镜像所需的固化产物随仓库到位
  PASS  web-dist/MANIFEST.json 存在
```

## 4. 端到端实测：干净克隆里到底好不好（如实表）

克隆目录 `tmp/r5-bootstrap/repo` 的实际内容：

```
$ ls -1 tmp/r5-bootstrap/repo
README.md  bugs  config  docs  mindcraft  scripts  server  test-template  web
停止面板.bat  启动面板.bat  收紧RCON.bat  文件
```

**关键：clone 本地仓库只带"已提交"内容，未提交改动不会过去。** 这正是本次能暴露"哪些修复还没入库"的地方。

| 检查项 | 干净克隆里的状态 | 说明 |
|---|---|---|
| `mindcraft/` 是否存在 | ✅ 存在 | clone-all 的第二步补上了 |
| `mindcraft/web-dist/`（含 index.html） | ✅ 存在（8 个 assets + index.html + MANIFEST.json + README.md） | 第四轮已入库，属既有成果 |
| `mindcraft/web-dist/assets` 内容 | ⚠️ 是**旧 chunk**：`index-BRGdExsB.js` / `index-BYekMoBu.css` 等 | T14 重建的新 chunk（`index-DKGTVhDR.js` 等）**尚未提交** |
| 父仓 `.gitattributes` | ❌ **不存在** | T14 的换行钉**尚未提交**（只是在父仓索引里 `A` 状态） |
| `MANIFEST.json` 的 `source.hash` | ⚠️ 仍是旧值 `7a45c9b2…`，`generatedAt` 仍是 `2026-11-08T04:47:29Z` | 同上 |
| `release.ps1 -VerifyOnly` | ❌ **EXIT 1** | 见下方输出 |
| `npm ci`（mindcraft） | ✅ **EXIT 0**，548 包，5 个补丁全应用（2 分钟，缓存命中） | 锁与补丁都在库里，这块本来就是好的 |

干净克隆里的 `-VerifyOnly` 真实输出：

```
$ cd tmp/r5-bootstrap/repo && powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -VerifyOnly
  |   PASS  源码指纹 sha256:0085a9700f69e3cd63ee2a607dea05b20690940be8c298d8a38a0b55f5ff978c（25 个输入文件）
  |   FAIL  产物与源码不一致：清单记录 sha256:7a45c9b2ea63d4a84f41261deba14fdcd4470ec3fdfbf7a1f174c593457c3585，当前 web/ 源码是 sha256:0085a9700f69e3cd63ee2a607dea05b20690940be8c298d8a38a0b55f5ff978c
EXIT_VERIFY_IN_CLONE=1
```

> 注意 `0085a970…` 这个值：它是 `ca39e76` 那棵树的 **git blob（LF）口径** 指纹 —— 干净克隆在 Linux/CI 上是 LF、在本机（旧配置）是 CRLF，所以和 T2/T9 的两个值都对得上。这条 FAIL **不是新问题**，就是 R5-003 在干净克隆上的原样复现。

## 5. 剩余缺口清单（跑出来的，不是猜的）

| # | 缺口 | 现状 | 修法 |
|---|---|---|---|
| G-1 | 干净克隆里 `-VerifyOnly` **红**（EXIT 1） | 因为 T14 的 `web-dist` 重建 + `MANIFEST.json` 新指纹**只在暂存区，尚未提交** | **提交 T14 的暂存**（子仓 `mindcraft/web-dist/` 全部 10 项） |
| G-2 | 干净克隆里没有父仓 `.gitattributes` | T14 的新文件也是 `A`（已暂存、未提交） | **提交 T14 的暂存**（父仓 `.gitattributes`） |
| G-3 | 干净克隆里的产物是旧 chunk | 同 G-1 | 同 G-1 |
| G-4 | 父仓不跟踪子仓这件事本身没变 | 设计如此（不改成 submodule） | 由 `clone-all.ps1` 兜住；README 已改成可执行命令 |
| G-5 | 本机无 docker，镜像链路未验 | `docker build` 仍 CANNOT-RUN | 交未来 CI |
| G-6 | 子仓 302 个提交未推送 | 用户明确本轮不配远端 | 保留为已知状态，不属本次范围 |

**一句话**：`clone-all.ps1` 解决的是"两个仓会不会都被拉下来"；**"拉下来的东西是否一致"仍然卡在 T14 的暂存没提交**。这两件事必须都做完，干净克隆上的 `-VerifyOnly` 才会是 0。

## 6. 其他边界行为（都实测过）

### 6.1 半成品状态：父仓成功、子仓失败 → 明确报错（R5-004 核心验收）

```
$ powershell ... -ParentUrl E:/我的世界ai -MindcraftUrl E:/我的世界ai/没有这个子仓 -Dest tmp/r5-bootstrap/half/repo

[5] clone mindcraft 子仓到 <Dest>/mindcraft
  FAIL  子仓 clone 失败，当前处于**半成品状态**：父仓已就位（E:\我的世界ai\tmp\r5-bootstrap\half\repo），
        但 E:\…\half\repo\mindcraft 缺失/不可用，这样跑不起来。
fatal: 'E:/我的世界ai/没有这个子仓' does not appear to be a git repository
fatal: Could not read from remote repository.
Please make sure you have the correct access rights
and the repository exists.
        修复：补跑：git clone E:/我的世界ai/没有这个子仓 "E:\…\half\repo\mindcraft"；
              或清空 E:\…\half\repo 后重跑本脚本。
EXIT_HALF=1
```

同时确认它把 git 留下的空壳目录清掉了：

```
$ ls -d tmp/r5-bootstrap/half/repo/mindcraft
ls: cannot access '…': No such file or directory     ← 已清理
```

### 6.2 `-Ref` 正常

```
$ … -LocalSource -Dest tmp/r5-bootstrap/ref1 -Ref audit/night-20261106
  INFO  目标 ref：audit/night-20261106
  PASS  [父仓] 已检出 origin/audit/night-20261106
  PASS  [子仓] 已检出 origin/audit/night-20261106
EXIT_REF1=0
```

### 6.3 `-Ref` 不存在 → 明确报错

```
  FAIL  [父仓] 里不存在 ref：33b4327（本地分支/未推送的提交不会随 clone 过来）
        修复：确认该 ref 已推送到被 clone 的那个仓库；或用提交哈希（只要有该对象即可）…
EXIT_REF2=1
```

### 6.4 目标目录非空 → 拒绝覆盖

```
  FAIL  目标目录已存在且非空：E:\我的世界ai\tmp\r5-bootstrap\repo
        修复：换一个 -Dest，或先自行清理该目录（脚本不替你删东西）。
EXIT_BUSY=1
```

## 7. README 顶部改动

- 把原来那句"新机器上要跑起来必须**两个仓都 clone**（见下）"改成：**由 `scripts/clone-all.ps1` 一条命令负责，不再靠人记**。
- 新增 **「从零开始（3 条命令）」** 小节：① clone-all → ② `npm ci` → ③ `release.ps1 -VerifyOnly`，并给出有无远端两种调用方式。
- 原文那块"`git clone <parent-url> repo && cd repo; git clone <mindcraft-url> mindcraft`"替换为"用上面第 1 条命令（`scripts/clone-all.ps1`），它会连子仓一起拉"。

## 8. 复现命令

```bash
cd /e/我的世界ai

# 冒烟：一条命令拉起两个仓（本机无远端也能真跑）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/clone-all.ps1 -LocalSource -Dest tmp/r5-bootstrap/repo
echo $?                                    # 期望 0

# 干净克隆里逐项检查
ls -d tmp/r5-bootstrap/repo/mindcraft                    # 存在
ls -1 tmp/r5-bootstrap/repo/mindcraft/web-dist           # MANIFEST.json README.md assets index.html
ls -l  tmp/r5-bootstrap/repo/.gitattributes               # 目前应"不存在"（T14 未提交）
cd tmp/r5-bootstrap/repo && powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -VerifyOnly
echo $?                                    # 目前 1（T14 提交后应为 0）
cd mindcraft && npm ci                     # 期望 0，548 包

# 半成品检测
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/clone-all.ps1 \
  -ParentUrl E:/我的世界ai -MindcraftUrl E:/我的世界ai/没有这个子仓 -Dest tmp/r5-bootstrap/half/repo
echo $?                                    # 期望 1，且打印"半成品状态"
```

## 9. 证据索引（`docs/audit-r5/evidence/fix/`）

| 文件 | 内容 |
|---|---|
| `08-clone-all-e2e.txt` | 本任务全部实测的合并记录（脚本约定/主路径/目录清单/VerifyOnly/半成品/Ref/非空目录） |
| `08-clone-all-e2e-happy.log` | `-LocalSource` 主路径完整输出（EXIT 0） |
| `08-clone-all-e2e-run2.log` | 第二次干净重建（EXIT 0，复现性） |
| `08-clone-all-half-state.log` | 半成品状态报错全文（EXIT 1） |
| `08-clone-all-ref-ok.log` / `08-clone-all-ref-missing.log` | `-Ref` 正常 / 不存在 |
| `08-clone-all-dest-busy.log` | 目标目录非空被拒绝 |
| `08-verifyonly-in-clean-clone.log` | 干净克隆里 `-VerifyOnly` 全文（EXIT 1） |
| `08-npm-ci-in-clean-clone.log` | 干净克隆里 `npm ci`（EXIT 0，548 包） |
| `08-clone-all.ps1.snapshot` | 脚本快照（便于比对后续改动） |
