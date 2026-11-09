# R5-003 / R5-011 修复记录：钉换行 + 重建产物入库

> 任务：t14（attempt 2）。修复 **R5-003（P1，产物与源码未绑定）** 与 **R5-011（P2，换行未钉）**。
> 两条必须一起做 —— 只钉换行不重建产物 = 把指纹盖成 LF 值、产物却是旧的 CRLF 构建，换台机器又红（自锁循环）。
> 约束遵守：只改 `.gitattributes`（新建）、`web/` 的行尾字节、`mindcraft/web-dist/**` 与 `MANIFEST.json`；**未改任何业务逻辑**；本机无 docker，镜像部分记 `CANNOT-RUN`。

## 0. 验收结果一览

| 验收点 | 修复前 | 修复后 | 结论 |
|---|---|---|---|
| `git check-attr -a -- web/tsconfig.json` | **空输出**（无属性） | `text: set` + `eol: lf` | ✅ |
| `scripts/release.ps1 -VerifyOnly` 退出码 | **1**（`FAIL 产物与源码不一致`） | **0**（`ALL PASS: 8 passed, 0 failed`），连跑 2 次都是 0 | ✅ |
| `MANIFEST.json.source.hash` 与当前 `web/` 指纹 | 不一致（`7a45c9b2…` vs `8a1714aa…`） | **一致**（都是 `82405964…`） | ✅ |
| `source.hash` 是否可对到 commit | 对不到任何 commit（未入库中间树） | **== HEAD 的 blob 口径值** ⇒ 干净克隆可复现 | ✅ |
| 二次构建 9 个产物 sha256 | — | **逐字节相同**（`diff` 为空） | ✅ |
| 跨平台：LF 副本指纹 == 清单 `source.hash` | — | `EQUAL = true` | ✅ |
| `docker build` | — | **CANNOT-RUN**（本机无 docker，未尝试） | ⚠️ 交 CI |

## 1. 修 R5-011：给父仓加换行钉

### 1.1 新建 `.gitattributes`（父仓此前**根本没有**这个文件）

```bash
# 修复前
$ ls .gitattributes
ls: cannot access '.gitattributes': No such file or directory
```

新建后（完整内容见 `evidence/fix/01-gitattributes-parent.txt`），核心就一条：

```gitattributes
web/** text eol=lf
```

外加 `*.png binary` 等二进制白名单，以及一段注释说明"父仓 `.gitignore` 排除了 `/mindcraft/`，所以在这里写 `mindcraft/web-dist/**` 不会生效，产物侧的钉在子仓自己的 `.gitattributes` 里"。

### 1.2 check-attr 前后对照（验收点）

```
=== 修复前 ===
$ git check-attr -a -- web/tsconfig.json
（空输出 —— 无任何属性）

=== 修复后 ===
$ git check-attr -a -- web/tsconfig.json
web/tsconfig.json: text: set
web/tsconfig.json: eol: lf

$ git check-attr -a -- web/src/api/socket.ts
web/src/api/socket.ts: text: set
web/src/api/socket.ts: eol: lf

$ git check-attr text eol -- web/src/views/SetupView.vue
web/src/views/SetupView.vue: text: set
web/src/views/SetupView.vue: eol: lf
```

### 1.3 子仓属性**未被破坏**（已存在，没动）

```
$ git -C mindcraft check-attr -a -- web-dist/index.html
web-dist/index.html: text: unset          ← 产物侧 -text 仍在

$ git -C mindcraft check-attr -a -- patches/mineflayer+4.39.0.patch
patches/mineflayer+4.39.0.patch: text: unset   ← 补丁侧 -text 仍在
```

## 2. 重新归一化工作树（这一步有个坑，值得记下来）

按任务跑了 `git add --renormalize .`：

```
$ git add --renormalize .
（无输出）
$ git status --porcelain
?? .gitattributes
?? docs/audit-r5/
```

**没有任何 `web/` 文件被列为改动。** 原因：HEAD 里的 blob **本来就是 LF**（`core.autocrlf=true` 在提交时已把 CRLF 归一成 LF 存进对象库），所以 renormalize 后索引内容与 HEAD 完全一致 —— 索引没什么可改的。

但**工作树里的文件还是 CRLF**（它们是旧配置检出时被 smudge 成 CRLF 的），而 `release.ps1` 算指纹读的是**磁盘字节**。所以必须让工作树也变成 LF，否则下一步重建会把 CRLF 指纹盖进清单，白干。

尝试与结果：

```
$ git checkout-index -a -f         # 无效：Git 认为文件已是最新，不重走 smudge 过滤
$ # 实际有效做法：删掉这些文件再检出一遍，强制走 smudge/eol 过滤
$ rm <19 个含 CR 的文件> && git checkout -- web/
$ # 结果：web/ 受跟踪文件中含 CR 的个数 19 → 1
```

剩下那 1 个是 `web/poc/render-check.png` —— **PNG 二进制**，本来就含 `0x0D` 字节，它由 `*.png binary` 属性排除、**不应**参与换行归一。核验它逐字节未变：

```
$ sha256sum web/poc/render-check.png
accd20ebda28b695211660ae7d9097cb79d6a1b04b0a7daa599c0c42d1a5c841
$ git cat-file -p HEAD:web/poc/render-check.png | sha256sum
accd20ebda28b695211660ae7d9097cb79d6a1b04b0a7daa599c0c42d1a5c841
```

归一化后源码指纹：

```
$ node <srcfp.mjs> web          # 同 release.ps1 第 417-436 行的算法
SOURCE_HASH sha256:824059647d14761ffbddbb80f5e6b291500eb14ff859baf401a92da131e79ab2
FILE_COUNT 25
```

这正是 R5-011 实验里 LF 那一侧的值（`8a1714aa…` → `82405964…`）。

> **关于"web/ 下被改的文件"**：由于归一化后字节与索引一致，Git **不会**把它们报成改动（`git status` 里没有 `web/` 条目）。这是正常的：这次改动落在**工作树字节**上，不是仓库内容 —— 任何机器用 `eol=lf` 检出都会自动得到同样的 LF 字节。

## 3. 修 R5-003：重建产物并入库

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -SkipDocker
```

第一次构建：`EXIT_BUILD1=0`，关键输出：

```
[4/8] 产物校验：清单自洽 + index.html 引用 + 源码 hash 绑定
  PASS  9 个产物文件与清单逐条一致
  PASS  产物目录没有清单未记录的野文件
  PASS  index.html 的 2 个入口引用都能在产物里找到
  PASS  源码指纹 sha256:824059647d14761ffbddbb80f5e6b291500eb14ff859baf401a92da131e79ab2（25 个输入文件）
  PASS  产物指纹 sha256:a7e42b428f565f79952bce3df7ee36fa1358fa550f0757cd12c0fa177bf56d1f（9 个产物文件）
  PASS  已写回发布元数据（generatedAt = 2026-11-08T11:09:43Z）
  PASS  产物与 web/ 源码指纹一致（产物确实是这份源码构建出来的）
  PASS  产物指纹与清单一致
  PASS  入口引用与清单一致
  ALL PASS: 8 passed, 0 failed
[5/8] 跳过 docker build / 运行期断言（-SkipDocker）
EXIT_BUILD1=0
```

`-SkipDocker` 阶段明确打印「跳过 docker build / 运行期断言」⇒ 镜像部分 `CANNOT-RUN`，未尝试。

### 3.1 清单新旧对照

| 字段 | 修复前（HEAD 里提交的那份） | 修复后（本次重建） |
|---|---|---|
| `source.hash` | `sha256:7a45c9b2ea63d4a84f41261deba14fdcd4470ec3fdfbf7a1f174c593457c3585` | `sha256:824059647d14761ffbddbb80f5e6b291500eb14ff859baf401a92da131e79ab2` |
| `source.files` | 25 | 25 |
| `artifact.hash` | `sha256:55bc9624642a4e4eebe9618c8359ffb51379616266a156d79273967cf0cc2bae` | `sha256:a7e42b428f565f79952bce3df7ee36fa1358fa550f0757cd12c0fa177bf56d1f` |
| `generatedAt` | `2026-11-08T04:47:29Z` | `2026-11-08T11:14:46Z`（第二次构建后） |
| `entryAssets` | `index-BRGdExsB.js` / `index-BYekMoBu.css` | `index-DKGTVhDR.js` / `index-Hcxgqz-Q.css` |

### 3.2 新旧 `source.hash` 分别对应哪个 commit

按 git blob（LF）口径逐 commit 复算：

```
HEAD                 : sha256:824059647d14761ffbddbb80f5e6b291500eb14ff859baf401a92da131e79ab2 (25 files)
ca39e76 (=HEAD 的 web/): sha256:824059647d14761ffbddbb80f5e6b291500eb14ff859baf401a92da131e79ab2 (25 files)
717308f (t27 前一版)  : sha256:cc0c9ab420bff384c2af80f5a2985d1cb3f42346464cf10612577e33f6243649 (25 files)
```

- **旧 `7a45c9b2…`**：不等于 HEAD、`ca39e76`、`717308f` 中的任何一个 ⇒ 它指向一个**未入库的中间工作树**（当时的 CRLF 状态），git 里无从核对。这就是 R5-003 的病根。
- **新 `82405964…`**：**等于 HEAD 的 blob 口径值**，也就是任何机器 `git clone` + `eol=lf` 检出后会算出的值 ⇒ 可核对、可复现。

清单里旧哈希已清零：

```
$ grep -c "7a45c9b2" mindcraft/web-dist/MANIFEST.json
0
```

### 3.3 `generatedAt` 不早于 `web/` 最后改动

```
清单 generatedAt = 2026-11-08T11:14:46Z        （= 本地 19:14:46）
web/ 最新 mtime  = 2026-11-08T19:06:15 web/tsconfig.json
```

19:14:46 > 19:06:15 ✅（`generatedAt` 是 UTC，本地时区 +08）

### 3.4 入库（暂存）范围

只暂存本任务范围内的路径，**没有**创建 commit（原因见第 7 节）：

```
父仓：A  .gitattributes
子仓：M  web-dist/MANIFEST.json
      M  web-dist/index.html
      R  web-dist/assets/DebugView-BkBssVOn.js   -> DebugView-94geOrTx.js
      R  web-dist/assets/SetupView-BqZvFAjd.js   -> SetupView-FniJwIn7.js
      R  web-dist/assets/TerrainView-CLvOw5wc.js -> TerrainView-BH9oWS7R.js
      R  web-dist/assets/TerrainView-Dc9bwTkz.css-> TerrainView-BkR-DBrX.css
      R  web-dist/assets/index-BRGdExsB.js       -> index-DKGTVhDR.js
      R  web-dist/assets/index-BYekMoBu.css      -> index-Hcxgqz-Q.css
      D  web-dist/assets/SetupView-B6mvS54m.css
      A  web-dist/assets/SetupView-CQeN4yGC.css
```

## 4. 证明可复现：第二次构建 + 再验一次

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -SkipDocker   # 第二次
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -VerifyOnly
```

### 4.1 两次构建 9 个产物 sha256 对照

| 文件 | sha256 | 对比 |
|---|---|---|
| `./assets/DebugView-94geOrTx.js` | `635c8c4f263e8db656fa721cb0b5bc7825c1532e57c1351ff0382770e2d40518` | SAME |
| `./assets/DebugView-Pp-4MEq7.css` | `eb7df7a3b8cc9cac12a6e7a1620f5c391972411d245596c93028eb0b43734087` | SAME |
| `./assets/SetupView-CQeN4yGC.css` | `adc453016a946b5f0ca0c642f4252332b51ef12611dbeed5637bdb4c4744f12a` | SAME |
| `./assets/SetupView-FniJwIn7.js` | `8a801e20177368dfc59689d68633d53b74dd5046158957392cf93f19c79cb9c1` | SAME |
| `./assets/TerrainView-BH9oWS7R.js` | `6511c678a8f5663c6019be2195522023fe5050c5cc2974cfb85eb0d962fa2002` | SAME |
| `./assets/TerrainView-BkR-DBrX.css` | `0039fd6f30ac9c258d0b4a33351f7cf8af95cb6cfd800c1c595dc7da10dfecec` | SAME |
| `./assets/index-DKGTVhDR.js` | `02debb27f56bf85eeb3cf690bb5e6ff53b9655393f54069ef8273a4dd68c2a5f` | SAME |
| `./assets/index-Hcxgqz-Q.css` | `be7f5826de4f7f8d47e7ff96265f2eaba70dcaf2a557c071da14314c668b558a` | SAME |
| `./index.html` | `e1bc39d516480a081a13fb02d2128b3c12f4beb730e9d0f6a8c17193717ce5e1` | SAME |

```
$ diff build1-artifacts.txt build2-artifacts.txt
（空）  IDENTICAL：两次构建产物逐字节相同
```

旁证这不是偶然：本次 build1 的产物（`index-DKGTVhDR.js` 等）与 **T9 实验里用纯 LF 源码构建出的结果逐条相同**，而旧产物是 `index-BRGdExsB.js`（CRLF 构建）⇒ 说明这次确实是 LF 构建。

### 4.2 VerifyOnly 两次都是 0

```
第 1 次：  |   ALL PASS: 8 passed, 0 failed
          PASS  VerifyOnly：清单/产物/源码三方一致
          EXIT_VERIFY1=0

第 2 次：  |   ALL PASS: 8 passed, 0 failed
          PASS  VerifyOnly：清单/产物/源码三方一致
          EXIT_VERIFY2=0
```

对比修复前：`EXIT_BEFORE=1`，`FAIL 产物与源码不一致：清单记录 7a45c9b2…，当前 web/ 源码是 8a1714aa…`。

## 5. 证明跨平台可复现（R5-011 的关键验收）

```bash
# 把 web/ 整棵拷到 tmp/r5-fix-eol/web-lf（此时 web/ 已是 LF，无需再做转换）
node <copy> web → tmp/r5-fix-eol/web-lf
```

```
copied files = 47，副本中含 CRLF 的文件 = 0

$ node <srcfp.mjs> tmp/r5-fix-eol/web-lf
SOURCE_HASH sha256:824059647d14761ffbddbb80f5e6b291500eb14ff859baf401a92da131e79ab2
FILE_COUNT 25

副本指纹 = sha256:824059647d14761ffbddbb80f5e6b291500eb14ff859baf401a92da131e79ab2
清单登记 = sha256:824059647d14761ffbddbb80f5e6b291500eb14ff859baf401a92da131e79ab2
EQUAL = true
```

⇒ 在另一台机器（Linux/docker/CI，天然 LF）上，只要按 HEAD 克隆，算出的指纹就是清单里那个值，`-VerifyOnly` 会绿。**自锁循环被解掉：指纹与产物现在都是 LF 口径，且都绑定到 HEAD。**

## 6. 改动清单

| 仓库 | 路径 | 性质 |
|---|---|---|
| 父仓 | `.gitattributes` | **新增**（`web/** text eol=lf` + 二进制白名单 + 说明注释） |
| 父仓 | `web/` 下 18 个文本文件 | **仅行尾字节** CRLF→LF（内容零变化；git 不报为改动，因为归一化后与索引一致） |
| 子仓 | `mindcraft/web-dist/` 9 个产物文件 | 删除 2 / 新增 2 / 重命名 6（旧 chunk → 新 chunk） |
| 子仓 | `mindcraft/web-dist/MANIFEST.json` | `source.hash`、`artifact.hash`、`generatedAt`、`entryAssets`、`files` 全部更新 |
| 子仓 | `mindcraft/web-dist/index.html` | 入口引用改为新 chunk（构建产物，非手改） |

未触碰：任何业务逻辑代码（`mindcraft/src/**`、`web/src/**` 的内容零改动）、`mindcraft/.gitattributes`、`patches/`。

## 7. 两点必须说明的现场情况（不是本任务的改动）

审计/修复期间**同工作区还有其他成员在并发改文件**，以下改动**不属于本任务**，我既没有制造也没有撤销：

| 文件 | 现象 | 判断依据 |
|---|---|---|
| `scripts/start-panel.ps1` | 第 1 行加了 UTF-8 BOM | mtime 19:05:42；`git check-attr` 空（不受我的 `web/**` 规则影响）；diff 是 BOM 变化 |
| `启动面板.bat` / `停止面板.bat` | `errorlevel` 处理被改成保留退出码（+4/-2 行） | mtime 19:08:10；内容是业务逻辑改动 |
| `scripts/harden-credentials-acl.ps1` | 未提交修改 | 与本任务无关 |
| `mindcraft/src/agent/action_manager.js`、`mindcraft/package.json`、`tools/*.mjs` | 未提交修改 / 新增 | 与本任务无关 |

因此我**只按路径暂存**了 `.gitattributes` 与 `mindcraft/web-dist`，**没有创建 commit**：若用 `git commit -a`，会把上面这些半成品一起卷进提交，破坏他人的工作。**提交动作留给队长统一收口。**

## 8. 复现命令（照抄即可）

```bash
cd /e/我的世界ai

# 0 修复前基线（应为 EXIT 1）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -VerifyOnly

# 1 换行钉
cat .gitattributes                        # web/** text eol=lf
git check-attr -a -- web/tsconfig.json    # text: set / eol: lf

# 2 工作树归一化（renormalize 不会改工作树，需强制重走 smudge）
git add --renormalize .
for f in $(git ls-files 'web/*'); do grep -qU $'\r' "$f" && rm -f "$f"; done
git checkout -- web/
git ls-files 'web/*' | while read f; do grep -qU $'\r' "$f" && echo "still CRLF: $f"; done   # 仅剩 PNG

# 3 重建产物（两次）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -SkipDocker
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -SkipDocker

# 4 验收
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -VerifyOnly    # 期望 0
node -e "console.log(require('E:/我的世界ai/mindcraft/web-dist/MANIFEST.json').source.hash)"
# 期望 sha256:824059647d14761ffbddbb80f5e6b291500eb14ff859baf401a92da131e79ab2
```

## 9. 证据索引（`docs/audit-r5/evidence/fix/`）

| 文件 | 内容 |
|---|---|
| `00-baseline.txt` | 修复前基线：check-attr 空、清单旧值、`-VerifyOnly` EXIT 1 |
| `01-gitattributes-and-renormalize.txt` | check-attr 前后对照、归一化过程、二进制未变、源码指纹 |
| `01-gitattributes-parent.txt` | 新建 `.gitattributes` 全文快照 |
| `02-build-1-skipdocker.log` / `02-build-2-skipdocker.log` | 两次 `-SkipDocker` 构建全量输出（均 EXIT 0） |
| `03-verifyonly-1.log` / `03-verifyonly-2.log` | 两次 `-VerifyOnly` 全量输出（均 EXIT 0） |
| `04-artifacts-build1.txt` / `04-artifacts-build2.txt` | 两次构建的 9 个产物 sha256（`diff` 为空） |
| `05-manifest-after.json` | 重建后的 `MANIFEST.json` 快照 |
| `06-manifest-before-after.txt` | 清单新旧对照、`source.hash` 对 commit、旧哈希清零、`generatedAt` 新鲜度 |
| `07-reproducibility.txt` | 两次构建对照表、VerifyOnly 两次、跨平台指纹 `EQUAL = true` |
| `08b-t25-integration.txt` | **第 10 节（集成收尾）全部证据**：Vault chunk、清单、独立复算、三次 VerifyOnly、三次构建确定性、dev `/api` 代理实测、`.dockerignore` 探针 |
| `08b-build1/2/3-with-vault.log` | 三次 `-SkipDocker` 全量输出（均 EXIT 0） |
| `08b-verifyonly-1/2/final.log` | 三次 `-VerifyOnly` 全量输出（均 EXIT 0） |
| `08b-typecheck.log` | `npm run typecheck`（EXIT 0） |
| `08b-artifacts-final-11.txt` | 最终 11 个产物 sha256 |
| `08b-dockerignore-db-probe.mjs` | 复用仓库自带匹配器验 `*.db` 语义的探针脚本 |
| `08b-dockerignore-unit.log` | `tools/dockerignore_coverage_unit.mjs`（65/65 PASS） |
| `08b-vite-dev-server.log` | vite dev 起服日志（用于 `/api` 透传实测） |

---

## 10. 集成收尾（R5 t25，2026-11-08 21:0x）

凭据保管库（t15）落地后，产物与源码再度失绑（`82405964…` → `8c2c6490…`），且产物里**没有 Vault chunk** ⇒ 用该产物起面板会整份是旧前端、**没有「凭据」入口**（不 404，更隐蔽）。本节是收尾结果。

### 10.1 三处改动（顺序：先改 vite 配置 → 再 build）

| # | 文件 | 改了什么 | 为什么 |
|---|---|---|---|
| 1 | `web/vite.config.ts` | proxy 增加 `'/api': { target: 'http://127.0.0.1:8080', changeOrigin: true }` | `npm run dev`(5173) 下凭据页连不上后端（只有 `/socket.io` 与 `/assets`）。沿用了文件里"必须写 `127.0.0.1` 而不是 `localhost`（Node 18+ 解析成 ::1）"的既有注释。prod 不受影响（同源 `/console/`） |
| 2 | `mindcraft/.dockerignore` | 加 `*.db` **和** `**/*.db`（带注释说明） | 凭据库 `.secrets.db` / 板库不该进构建上下文 |
| 3 | `mindcraft/web-dist/**` + `MANIFEST.json` | 由 `release.ps1 -SkipDocker` 重新生成（含 Vault chunk） | 见下 |

### 10.2 产物与清单：新旧值对照（旧值保留）

| 字段 | 第 10 节之前（t14 收口时） | 现在（t25 收尾后） | 为什么变 |
|---|---|---|---|
| `source.hash` | `sha256:824059647d14761ffbddbb80f5e6b291500eb14ff859baf401a92da131e79ab2` | **`sha256:e7ef2670035f522552b5570f1216bd39ce834ecd86aa53dac6c2e60a1b3a4554`** | 源码输入 **25 → 27**：新增 `src/stores/vault.ts`、`src/views/VaultView.vue`；另有 `src/App.vue`、`src/router.ts` 改动；**加上本次 `vite.config.ts` 增加 `/api` 代理** |
| `source.files` | 25 | **27** | 同上（`vite.config.ts` 本来就在名单里，不增加计数） |
| `artifact.hash` | `sha256:a7e42b428f565f79952bce3df7ee36fa1358fa550f0757cd12c0fa177bf56d1f` | **`sha256:43b30d43bd71c7d9523a1a524991f9b1f2730687b57b67d8954439cc4b0edf2c`** | 产物 **9 → 11**：多了 `VaultView-*.js` / `VaultView-*.css`；其余 chunk 因主 bundle 变化而改 hash |
| `artifact.files` | 9 | **11** | 同上 |
| `generatedAt` | `2026-11-08T11:14:46Z` | **`2026-11-08T12:55:50Z`**（本地 20:55:50） | 第 3 次构建写回；晚于 `web/` 最后修改（`vite.config.ts` 约 20:47） |
| `entryAssets` | `index-DKGTVhDR.js` / `index-Hcxgqz-Q.css` | **`index-BsQBlTfW.js`** / **`index-De2pyrG7.css`** | 主入口 chunk 随源码变化 |

**Vault chunk（验收点）**：

```
assets/VaultView-BKt1AB9v.css  51a8f9a9fd24192253d3edf0c37c95ef21c4bbae4f6a5dc5a216db5795a1edef
assets/VaultView-D2hCoSQF.js   412b67162874b073f5db44df7e4ac7c6e9953db5c90e946e3ef3cf9e0b111e86
```

### 10.3 验收实测

| 验收点 | 结果 |
|---|---|
| Vault chunk 存在 | ✅ `ls mindcraft/web-dist/assets/ \| grep -i vault` → 2 个（上面那两个） |
| `-VerifyOnly` → exit 0 | ✅ **连跑 3 次都是 EXIT 0**（`ALL PASS: 8 passed, 0 failed`） |
| 清单 `source.hash` == 当前 web/ 指纹（**独立复算**） | ✅ 自写实现（`fs`+`crypto`，按 `rel\0hash\n` 拼接）算出 `e7ef2670…`，与清单 `EQUAL = true`，输入 27 个 |
| 二次（三次）构建产物 sha256 逐字节不变 | ✅ build1/2/3 的 `artifact.hash` 都是 `43b30d43…`；build2 vs build3 **逐文件 `diff` 为空**（11 个文件全 SAME） |
| `npm run typecheck` | ✅ EXIT 0（`vue-tsc --noEmit`，无输出即无错误） |
| `npm run build` | ✅ 由 `release.ps1 -SkipDocker` 的 `[2/8]` 步骤执行，`✓ 100 modules transformed`，产出含 `VaultView-*` |
| dev 模式 `/api` 透传 | ✅ **实测**：临时假后端占 `127.0.0.1:8080` 回 JSON，起 vite dev(5173)，`curl 5173/api/vault/status` → `{"ok":true,"path":"/api/vault/status","backend":"fake-8080"}`；`/socket.io/` 代理仍工作 |
| `.dockerignore` 的 `*.db` 生效 | ⚠️ **CANNOT-RUN（无 docker）** + 语义自证，见 10.4 |

### 10.4 `.dockerignore`：为什么写了 `*.db` **和** `**/*.db`

`docker` 本机不存在，**没有尝试 `docker build`**（记 CANNOT-RUN）。为确认规则语义，把仓库自带 `tools/dockerignore_coverage_unit.mjs` 里的匹配器**从源码原文切出来**（不重写），对真实 `.dockerignore` 跑断言（`08b-dockerignore-db-probe.mjs`）：

```
PASS  .secrets.db                    ignored=true
PASS  services/vault/.secrets.db     ignored=true     ← 靠 **/*.db
PASS  data/board.db                  ignored=true     ← 靠 **/*.db
PASS  Thumbs.db                      ignored=true
PASS  main.js / src/agent/agent.js / src/mindcraft/mindserver.js
      / web-dist/index.html / patches/… / package-lock.json / settings.js  ignored=false
ALL PASS：*.db 命中凭据/板库，且未误伤镜像必需路径
```

**发现一处语义分歧**（已写进 `.dockerignore` 注释）：只写 `*.db` 时，仓库这个"docker 语义"匹配器给出 `services/vault/.secrets.db → ignored=false`——因为它按**整条相对路径锚定**；而真实 Docker（moby patternmatcher，1.13+）对**不含 `/` 的 pattern** 按 basename 在任意层级匹配。本机无法用 docker 裁定，所以**两条都写**：`*.db` 覆盖根层、`**/*.db` 覆盖深层，两种解释下都排除，且对已未排除的路径是无操作，不会误伤。

仓库自带的 `dockerignore_coverage_unit.mjs` 在加规则后仍 **65/65 PASS**（说明没有把 Dockerfile 的 COPY 源误排除）。

附带：`.secrets.db` 本来就被 `.gitignore:14` 忽略（`git -C mindcraft check-ignore -v .secrets.db` 命中），所以它不会进 git；本次只是补上"不进 docker 上下文"这一层。

### 10.5 必须记住的边界：产物绑定的是【工作树】，不是某次提交

`release.ps1` 在构建时自己就警告了：

```
WARN  web/ 有 5 处未提交改动：产物将绑定当前工作树（不是某次提交）。
```

实际情况：

```
$ git status --porcelain web/
 M web/src/App.vue
 M web/src/router.ts
 M web/vite.config.ts
?? web/src/stores/vault.ts
?? web/src/views/VaultView.vue
```

这 5 处**全部落在 `SOURCE_ENTRIES` 内**，所以：

- 当前指纹 `e7ef2670…`（27 个输入）= **工作树口径**；
- 从 **HEAD** 克隆算出的指纹仍是 `82405964…`（25 个输入）。

⇒ 和 D-09 同一类问题：**在 vault 的 5 处改动 + `vite.config.ts` 被提交之前，干净克隆无法复现这份产物**。收口时必须把 `web/src/**`（vault-dev 的）与 `web/vite.config.ts`（我的）一起提交，再重跑一次 `-SkipDocker` + `-VerifyOnly`。本节只负责"工作树内自洽"。

