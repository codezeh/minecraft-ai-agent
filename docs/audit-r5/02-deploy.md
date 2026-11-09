# 第五轮实测 · 02 部署与克隆可复现性（T2）

> 口径：**只写能跑出来的东西**。每条 = 结论 | 命令 | 真实输出摘录 | 判定 | 证据文件。
> 判定只有三种：`CONFIRMED`（实测复现）/ `NOT-REPRODUCED`（实测不成立）/ `CANNOT-RUN`（环境缺件，不算通过）。
> 全部实验在本机 `E:\我的世界ai` 与其临时目录 `tmp/r5-deploy/` 完成；**未改动任何被 git 跟踪的文件**。

## 0. 复现环境

| 项 | 值 |
|---|---|
| 主机 | Windows（`LAPTOP-GDE992NS`），MSYS Bash（GNU tar/sha256sum） |
| node / npm | `v24.16.0` / `11.13.0` |
| docker | **未安装**（`docker: command not found`）⇒ 第 4 节只能 `CANNOT-RUN` |
| 父仓 | `E:\我的世界ai`，branch `main` @ `92d405c`，**0 个远端**，本地 79 个提交 |
| 子仓 | `E:\我的世界ai\mindcraft`，branch `main` @ `33b4327`，645 个跟踪文件，远端 `mine` / `origin` |

> 采集期间有并发干扰：本文件 4.1 记录的 `web/dist` 在 15:07 被**同工作区其他成员**重建覆盖（该目录不入库），因此产物比对一律改用隔离目录重建（4.3），不依赖 `web/dist` 的当前状态。

## 1. 汇总表

| # | 结论 | 判定 | 严重度 |
|---|---|---|---|
| D-01 | 父仓**完全不跟踪** `mindcraft/`（0 文件），克隆父仓拿不到子仓 ⇒ 从父仓"从零部署"必然失败 | CONFIRMED | 高 |
| D-02 | 子仓 **302 个提交未推送**：本地 HEAD `33b4327`(11-08) vs 远端 `mine/main` `129bcff`(10-29) | CONFIRMED | 高 |
| D-03 | 父仓**零远端**（79 个提交只存在于本机）⇒ 无异地副本、无克隆来源 | CONFIRMED | 高 |
| D-04 | 子仓 `package-lock.json` 已入库且与 `package.json` 一致；干净克隆 `npm ci` **成功** | NOT-REPRODUCED | — |
| D-05 | 仅拷 `package.json`+lock（无 `patches/`）时 `npm ci` 仍**成功**，postinstall 打印 `No patch files found` **静默跳过补丁** | CONFIRMED | 中 |
| D-06 | 审计开始时 `mindcraft/web-dist` 与 `web/dist` 的 9 个产物文件**逐字节一致** | NOT-REPRODUCED | — |
| D-07 | `MANIFEST.json.source.hash` ≠ 当前 `web/` 源码指纹；`release.ps1 -VerifyOnly` **退出码 1** | CONFIRMED | 高 |
| D-08 | 用当前源码隔离重建，4 个 JS chunk 名称/哈希**全变**（3 个 CSS 不变）⇒ 已提交产物是旧源码构建的 | CONFIRMED | 高 |
| D-09 | 清单里的 `source.hash` **无法从任何 commit 复现**（HEAD / `ca39e76` / `717308f` 三值均不等）⇒ 指向未入库的中间工作树状态 | CONFIRMED | 高 |
| D-10 | `Dockerfile` 有 `COPY web-dist` + 构建期校验；`.dockerignore` 反向放行；但真实 `docker build` **缺 docker** | CANNOT-RUN | — |
| D-11 | 构建期校验只比"产物 vs 清单"，**不比源码指纹** ⇒ 产物过期时 `docker build` 照样通过（本地实跑通过） | CONFIRMED | 中 |
| D-12 | `chmod 600` 在 NTFS 上**无效**（ACL 前后完全一致）；`keys.json` 自身 ACL 已收紧，但父目录给 `Authenticated Users:(M)` ⇒ 可被替换 | CONFIRMED | 中 |
| D-13 | `*.token` / `.env` / `.env.*` / `keys.json` / `.mindserver-token` 在两仓**都被忽略** | NOT-REPRODUCED | — |
| D-14 | RCON 明文口令在 `server.properties`(48 位) / `server-test`(32 位)，`enable-rcon=true`；主服 `server-ip=` 为空 ⇒ **全网卡监听** | CONFIRMED | 中 |
| D-15 | 该口令**未出现在任何被跟踪文件**中（两仓零命中） | NOT-REPRODUCED | — |
| D-16 | `server-test/server.properties` 走**继承 ACL**，`Authenticated Users:(M)`、`Users:(RX)` ⇒ 含口令的文件对本机所有用户可读 | CONFIRMED | 中 |
| D-17 | 源码指纹对换行敏感（T9 已钉实）：`web/` 未钉换行，13/25 个源文件在本机工作树是 CRLF；**产物构建也随换行变化**，同一产物下源码换行一变，校验从 EXIT 0 翻成 EXIT 1 | CONFIRMED（条件：跨平台/不同 autocrlf） | 中 |

---

## 2. 仓库拓扑（任务 1）

**结论 D-01 / D-02 / D-03**

```bash
git ls-files mindcraft | wc -l          # 0
git -C mindcraft ls-files | wc -l       # 645
git status --porcelain                  # 空（父仓干净）
git -C mindcraft status --porcelain     # 空（子仓干净）
git remote -v                           # 空 —— 父仓没有任何远端
git for-each-ref refs/remotes | wc -l   # 0
git rev-list --count HEAD               # 79
git -C mindcraft rev-list --count mine/main..HEAD   # 302
git -C mindcraft rev-parse HEAD mine/main
```

真实输出摘录：

```
$ git ls-files mindcraft | wc -l
0
$ git -C mindcraft ls-files | wc -l
645
$ git remote -v
（空输出 = 无任何远端）
$ git rev-list --count HEAD
79
$ git -C mindcraft rev-list --count mine/main..HEAD
302
$ git -C mindcraft rev-parse HEAD mine/main
33b432703ccf2a4b8c2b47f3cbc44825defed602
129bcffa3ceedd5d081db58baf56f4e21a472cfd
$ git -C mindcraft log -1 --format='%h %ai %s' mine/main
129bcff 2026-10-29 20:25:24 +0800 docs(readme): 加开源归属声明 + 说明本分支做了什么
```

父仓 `.gitignore` 的相关行：

```
10:# ---------- 独立子仓库：mindcraft 自带 .git，禁止嵌套纳入 ----------
13:/mindcraft/
```

父仓 HEAD 树里确实没有 mindcraft：

```
$ git ls-tree HEAD -- mindcraft
（空输出）
$ git ls-tree --name-only HEAD
.gitignore  README.md  bugs  config  docs  scripts  server  test-template  web  *.bat  文件
```

**判定**：

- D-01 `CONFIRMED` —— `git ls-tree HEAD -- mindcraft` 空 ⇒ **克隆父仓不会得到子仓**，而启动面板/服务端代码全在子仓里。新机器只克隆父仓 = 拿到一个跑不起来的壳。
- D-02 `CONFIRMED` —— 302 个提交（含本轮 R4 t27 身份改动）只在本地。远端停在 2026-10-29，`git clone` 远端仓库得到的是 10 天前的版本。
- D-03 `CONFIRMED` —— 父仓 0 远端、79 个提交只在本机 ⇒ 父仓侧无任何异地副本。

证据：`docs/audit-r5/evidence/deploy/01-topology.txt`

---

## 3. 锁文件与 `npm ci`（任务 2）

### 3.1 D-04：干净克隆能不能 `npm ci` —— **能**

```bash
git -C mindcraft ls-files package-lock.json          # 有入库
git check-ignore -v mindcraft/package-lock.json      # 父仓：命中 /mindcraft/
git -C mindcraft check-ignore -v package-lock.json   # 子仓：无输出=不忽略
git clone --no-hardlinks E:/我的世界ai/mindcraft tmp/r5-deploy/clone2
cd tmp/r5-deploy/clone2 && npm ci --no-audit --no-fund
```

真实输出摘录：

```
$ git -C mindcraft ls-files package-lock.json
package-lock.json
$ git check-ignore -v mindcraft/package-lock.json
.gitignore:13:/mindcraft/	mindcraft/package-lock.json
$ git -C mindcraft show HEAD:package-lock.json | sha256sum
6674185ec3f794673c8e49271c62a068aa9bd241a2a502bb4d5396663da08a8f  -
$ sha256sum mindcraft/package-lock.json
6674185ec3f794673c8e49271c62a068aa9bd241a2a502bb4d5396663da08a8f  mindcraft/package-lock.json
```

子仓 `.gitignore` 第 4 行 `package-lock.json` 是历史条目，第 137 行用 `!package-lock.json` 反向放行，所以锁**确实入库**。

干净克隆（645 个跟踪文件，无 `node_modules`，含 `patches/`）真实安装结果：

```
Cloning into 'tmp/r5-deploy/clone2'...
$ npm ci --no-audit --no-fund
> postinstall
> patch-package
patch-package 8.0.1
Applying patches...
mineflayer@4.39.0 ✔
mineflayer-pathfinder@2.4.5 ✔
mineflayer-pvp@1.3.2 ✔
prismarine-viewer@1.33.0 ✔
protodef@1.19.0 ✔

added 548 packages in 10m
EXIT_CODE=0
```

**判定 D-04 `NOT-REPRODUCED`** —— 「干净克隆没有锁 ⇒ `npm ci` 报 EUSAGE / not in sync」这一条**在本轮实测中不成立**：锁已入库、与 `package.json` 同步、`npm ci` 零错误通过（10 分钟，548 包，5 个补丁全部应用）。这是真实的**正面**结论，不记为缺陷。

证据：`docs/audit-r5/evidence/deploy/02-lockfile.txt`、`02-npm-ci-clean-clone.log`

### 3.2 D-05：只拷 `package.json` + lock（无 `patches/`）—— 也"成功"，但补丁被静默跳过

```bash
cp mindcraft/package.json mindcraft/package-lock.json tmp/r5-deploy/clean-checkout/
cd tmp/r5-deploy/clean-checkout && npm ci --no-audit --no-fund
```

真实输出摘录：

```
package-lock.json
package.json
> postinstall
> patch-package
patch-package 8.0.1
Applying patches...
No patch files found

added 548 packages in 2m
EXIT_CODE=0
```

**判定 D-05 `CONFIRMED`** —— 缺 `patches/` 时 `patch-package` **不报错、退出码 0**，548 个包以未打补丁状态装好。真实克隆里 `patches/` 是 7 个跟踪文件所以不受影响；但任何"只搬 `package.json`+lock"的裁剪部署（或构建上下文漏拷 `patches/`）都会**静默拿到与 `package.json` 版本绑定不上的依赖树**，且 CI 是绿的。补丁是按 `mineflayer 4.39.0` 等精确版本打的，装出别的版本就是错的。

> 附注（不单列缺陷）：`npm ci --dry-run` 在空目录会因 postinstall 调 `patch-package` 而失败，这是 dry-run 的假象，已用真实 `npm ci` 排除，不作为判定依据。

证据：`docs/audit-r5/evidence/deploy/02-npm-ci-minimal.log`

---

## 4. 发布产物绑定（任务 3）

### 4.1 D-06：`mindcraft/web-dist` 与 `web/dist` 的产物比对

```bash
(cd mindcraft/web-dist && find . -type f | sort | xargs -d '\n' sha256sum)   # 11 个文件
(cd web/dist && find . -type f | sort | xargs -d '\n' sha256sum)             # 9 个文件
```

文件数差异：`web-dist` 11 个 = 9 个产物 + `MANIFEST.json` + `README.md`；`web/dist` 9 个。**9 个产物文件在审计开始时逐字节相同**（15:04 实测，含 `assets/index-BRGdExsB.js` = `97626305…`、`index.html` = `475a82b2…` 等全部 9 条一致）。

> 15:07 之后 `web/dist` 被同工作区其他成员用当前源码重建覆盖，故现在再跑这条命令会看到差异 —— 那反映的是重建后的新产物，不是发布事实。为避免这种并发干扰，下面的判定改用隔离目录重建（4.3）。

**判定 D-06 `NOT-REPRODUCED`** —— 「`web-dist` 与 `web/dist` 两份产物不一致」在本轮实测中不成立（审计开始时 9/9 逐字节相同）。

### 4.2 D-07：`MANIFEST.json` 的 `source.hash` 与当前 `web/src` 指纹 —— **不一致**

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -VerifyOnly
```

真实输出摘录（退出码 **1**）：

```
[4/8] 产物校验：清单自洽 + index.html 引用 + 源码 hash 绑定
  PASS  web-dist 结构完整（index.html + MANIFEST.json）
  |   PASS  9 个产物文件与清单逐条一致
  |   PASS  产物目录没有清单未记录的野文件
  |   PASS  index.html 的 2 个入口引用都能在产物里找到
  |   PASS  源码指纹 sha256:8a1714aadc5570d216fb2517d145b0cfdd5bc33bbe0953b1d408527554431977（25 个输入文件）
  |   PASS  产物指纹 sha256:55bc9624642a4e4eebe9618c8359ffb51379616266a156d79273967cf0cc2bae（9 个产物文件）
  |   FAIL  产物与源码不一致：清单记录 sha256:7a45c9b2ea63d4a84f41261deba14fdcd4470ec3fdfbf7a1f174c593457c3585，当前 web/ 源码是 sha256:8a1714aadc5570d216fb2517d145b0cfdd5bc33bbe0953b1d408527554431977
EXIT_CODE=1
```

清单自身是自洽的（`artifact.hash` 复算一致）：

```
recorded artifact.hash : sha256:55bc9624642a4e4eebe9618c8359ffb51379616266a156d79273967cf0cc2bae
recomputed artifact.hash: sha256:55bc9624642a4e4eebe9618c8359ffb51379616266a156d79273967cf0cc2bae
match: true
recorded source.files: 25 hash: sha256:7a45c9b2ea63d4a84f41261deba14fdcd4470ec3fdfbf7a1f174c593457c3585
```

**判定 D-07 `CONFIRMED`** —— 发布门禁 `release.ps1 -VerifyOnly` 在本机**退出码 1**。产物指纹与清单一致、清单内部自洽，但清单记录的源码指纹 `7a45c9…` 与当前 `web/` 源码 `8a1714…` 不符 ⇒ **已提交的 /console 产物不是当前源码构建出来的**。

证据：`docs/audit-r5/evidence/deploy/03-release-verifyonly.log`、`03-artifact-binding.txt`

### 4.3 D-08：用当前源码隔离重建，产物**确实变了**

```bash
tar -c --exclude=node_modules --exclude=dist -C web . | tar -x -C tmp/r5-deploy/webbuild
cd tmp/r5-deploy/webbuild && npm ci --no-audit --no-fund && npm run build
```

真实输出摘录：

```
dist/assets/index-XrhiKJjk.css         12.44 kB
dist/assets/DebugView-DghAYUGJ.js       6.88 kB
dist/assets/SetupView-CLC7EFHX.js      10.19 kB
dist/assets/index-Df7SBz-6.js         164.15 kB
dist/assets/TerrainView-D3mzsL_g.js   504.89 kB
✓ built in 1.77s
EXIT_CODE=0
```

与已提交 `web-dist` 的文件名集合逐条 diff：

```
1c1
< assets/DebugView-DghAYUGJ.js
---
> assets/DebugView-BkBssVOn.js
4,5c4,5
< assets/SetupView-CLC7EFHX.js
< assets/TerrainView-D3mzsL_g.js
---
> assets/SetupView-BqZvFAjd.js
> assets/TerrainView-CLvOw5wc.js
7,8c7,8
< assets/index-Df7SBz-6.js
< assets/index-XrhiKJjk.css
---
> assets/index-BRGdExsB.js
> assets/index-BYekMoBu.css
```

**判定 D-08 `CONFIRMED`** —— 4 个 JS chunk（`index`、`DebugView`、`SetupView`、`TerrainView`）文件名与内容哈希全变；3 个 CSS chunk 未变（对应样式未改动）。`index.html` 因引用新 chunk 也变（`093bf1…` vs `475a82…`）。⇒ 已提交产物确实由**旧**源码构建。

### 4.4 D-09：清单里的 `source.hash` 无法从任何 commit 复现

按 `scripts/release.ps1` 第 417–436 行同一算法，用 `git cat-file` 读**原始 blob**（避开换行转换）逐 commit 复算：

```
22c41e8 sha256:30425c5ebc0d0b9694fdc12aef94ad7b5696cf3c79353b99b0bdda090f0e4a5c 23
f8496a9 sha256:30425c5ebc0d0b9694fdc12aef94ad7b5696cf3c79353b99b0bdda090f0e4a5c 23
a27cea7 sha256:ece5df34b1dd3b8a8778f7da0fcaebe0110bbc5bb9e1284c119564d3bd7f41bd 24
af4aa22 sha256:20724a7537ee284b2584a31ccf784a849fe6a5de52b93231d3f775fc1995b17c 24
57499b7 sha256:a9f827db44fd804857f20c39475ce6b5f3d27f687fd493d5b2a2d46a79ea693e 24
99f844d sha256:a34508c70d96169c918f3f8683c2722acc82ac6ca59a714cab300ba6af230ce2 24
717308f sha256:cc0c9ab420bff384c2af80f5a2985d1cb3f42346464cf10612577e33f6243649 25
ca39e76 sha256:824059647d14761ffbddbb80f5e6b291500eb14ff859baf401a92da131e79ab2 25
HEAD    sha256:824059647d14761ffbddbb80f5e6b291500eb14ff859baf401a92da131e79ab2 25
```

清单记录 `7a45c9b2…`，本机工作树算得 `8a1714aa…`（`release.ps1` 与我的复算脚本一致），HEAD/`ca39e76` 的 blob 口径 `82405964…`，上一个源码版本 `717308f` 是 `cc0c9ab4…` —— **四者互不相等**。

时间线佐证：

```
$ git -C mindcraft log -1 --format='%H|%ai|%s' -- web-dist/MANIFEST.json
33b432703ccf2a4b8c2b47f3cbc44825defed602|2026-11-08 12:54:21 +0800|feat(identity): … (R4 t27)
$ git log -1 --format='%h|%ai|%s' -- web/
ca39e76|2026-11-08 12:55:19 +0800|feat(panel+config): 显示身份模式 + 正版验证切换说明 (R4 t27)
清单 generatedAt = 2026-11-08T04:47:29Z（= 本地 12:47:29）
```

**判定 D-09 `CONFIRMED`** —— 清单的 `generatedAt`（12:47:29）早于 `web/` 最后一次提交（12:55:19）58 秒；记录的 `source.hash` 不对应任何**已入库**的 `web/` 状态。⇒ 产物是在一个**未入库的中间工作树**上盖的章，之后源码又改了、产物没重建。这意味着"产物绑定到哪一版源码"这件事**在 git 里无法核对**，只能信清单里那个字符串。

证据：`docs/audit-r5/evidence/deploy/03-web-src-hash-by-commit.txt`、`03-web-src-fingerprint-current.txt`、`03-web-rebuild.log`

### 4.5 D-17：源码指纹对换行敏感（换台机器必然不同）

```bash
git config --get core.autocrlf            # true（父仓本地配置）
grep -qU $'\r' <每个 web/ 跟踪文件>        # 逐个检测 CRLF
git check-attr text eol web/src/api/socket.ts
```

真实输出摘录：

```
=== files with CRLF in web/ worktree ===
CRLF  web/src/api/socket.ts
CRLF  web/src/components/ChatStream.vue
CRLF  web/src/components/IdentityPanel.vue
CRLF  web/src/components/InventoryGrid.vue
CRLF  web/src/components/StatusCard.vue
CRLF  web/src/components/TerrainCanvas.vue
CRLF  web/src/stores/agents.ts
CRLF  web/src/stores/diag.ts
CRLF  web/src/stores/terrain.ts
CRLF  web/src/types/three-shim.d.ts
CRLF  web/src/views/ConsoleView.vue
CRLF  web/src/views/SetupView.vue
CRLF  web/tsconfig.json
（web/ 跟踪文件共 47 个）
$ git check-attr text eol web/src/api/socket.ts
eol: text: unspecified
```

**判定 D-17 `CONFIRMED`（已由决定性实验钉实，见 [02b-换行指纹.md](02b-换行指纹.md)）** —— 25 个源码输入里有 **13 个**在本机工作树是 CRLF（`core.autocrlf=true` 检出转换），而父仓**没有 `.gitattributes`** 给 `web/` 钉换行（`mindcraft/.gitattributes` 只钉了 `web-dist/**` 和 `patches/**`）。`release.ps1` 的源码指纹是**按字节**算的。

T9 的决定性实验（`tmp/r5-deploy-2/`，同一份语义相同的源码只改行尾）实测到三件事：

| 观测 | CRLF（本机检出） | LF（副本） |
|---|---|---|
| 源码指纹 | `sha256:8a1714aa…` | `sha256:82405964…` |
| 同一份产物副本下的校验结论 | `FAIL` / **EXIT 1** | `ALL PASS 8/0` / **EXIT 0** |
| 构建出的产物 chunk | `index-Df7SBz-6.js` 等 | `index-DKGTVhDR.js` 等（8/9 个不同） |

⇒ 不仅**指纹**敏感，**构建产物本身也随换行变化**（同一棵 CRLF 树连跑两次结果一致，已排除构建不确定性）；而翻转实验里 3 项产物自检两次都 PASS，唯一变量就是源码换行 —— 所以这是**独立于 D-07（产物过期）**的缺陷。且 FAIL 打印的修复指令（"web/ 改过但产物没重新生成"）是**错的**，照着做会把清单盖成 LF 指纹、回到 CRLF 机器又红，形成自锁循环。

前置条件（写清，避免夸大）：仅在行尾归一化不同的机器间触发 —— Windows 默认 `autocrlf=true` vs Linux/docker/CI 的 LF，**跨平台必然触发**；同平台同配置不触发。已提交产物的 3 个 CSS 哈希与 CRLF 构建完全一致 ⇒ 那份产物只能在本机 CRLF 检出上复现，**LF 机器上永远不可字节级复现**。

证据：`docs/audit-r5/evidence/deploy/03-artifact-binding.txt`（3.2 / 3.5 节）；决定性实验全部证据见 [02b](02b-换行指纹.md) 与 `evidence/deploy/07-eol-*`

---

## 5. Dockerfile 与构建期校验（任务 4）

### 5.1 D-10：文件层面齐全，但真实构建 **CANNOT-RUN**

```bash
which docker; docker --version
git -C mindcraft diff --stat HEAD -- Dockerfile      # 空 = HEAD 与工作树一致
grep -n "web-dist" mindcraft/Dockerfile
grep -n "web-dist" mindcraft/.dockerignore
```

真实输出摘录：

```
$ docker --version
niu: line 1: docker: command not found
$ git -C mindcraft diff --stat HEAD -- Dockerfile
(空 = 完全一致)
$ sha256sum mindcraft/Dockerfile
6718f0c85b088fddf1064f4872301462b553b504d8a4691195dd062d0b1b6739
$ grep -n "web-dist" mindcraft/Dockerfile
77:COPY web-dist ./web-dist
97:    cd /app/web-dist; \
98:    node --input-type=commonjs -e '…构建期校验…'
$ grep -n "web-dist" mindcraft/.dockerignore
96:!web-dist
97:!web-dist/**
```

**判定 D-10 `CANNOT-RUN`** —— `COPY web-dist ./web-dist`（第 77 行）与构建期校验段（第 96–98 行 `RUN set -eu; cd /app/web-dist; node -e '…'`）**都存在**，`.dockerignore` 也显式 `!web-dist` 反向放行；但**本机没有 docker**，无法执行 `docker build`。按口径记 `CANNOT-RUN`，**不记为通过**。

证据：`docs/audit-r5/evidence/deploy/04-dockerfile.txt`、`04-dockerfile-head.txt`

### 5.2 D-11：把那段构建期校验原样跑一遍 —— 在"产物过期"的情况下**通过**

本机无 docker，但第 98 行的校验是一段纯 node 脚本，可以原样执行（只把 `/app/web-dist` 换成相对路径）：

```bash
cd mindcraft/web-dist && node --input-type=commonjs -e '<Dockerfile 第 98 行同一段代码>'
```

真实输出：

```
[T10] web-dist 构建期校验通过: 9 个文件 / 2 个入口引用
[exit=0]
```

**判定 D-11 `CONFIRMED`** —— 该段只校验四件事：`index.html` 在、`MANIFEST.json` 在且逐文件 sha256 与磁盘一致、`index.html` 引用的 chunk 存在、无清单外野文件。它**不校验 `source.hash` 与当前 `web/` 是否一致**。于是出现这个组合：

- `release.ps1 -VerifyOnly`（仓库根）→ **退出码 1**（产物过期）
- `Dockerfile` 构建期校验（镜像里）→ **exit 0 通过**

⇒ **产物过期时 `docker build` 仍会成功**，镜像带着一份与源码不符的控制台发布出去。第四轮审计修的是"缺产物要构建失败"，这一条（"产物过期要构建失败"）仍留缺口。

证据：`docs/audit-r5/evidence/deploy/04-dockerfile.txt` 4.5 节

---

## 6. 凭据 ACL（任务 5）

### 6.1 D-12：`chmod 600` 在 Windows 无效；`keys.json` 自身已收紧但可被替换

```bash
git -C mindcraft ls-files keys.json            # 空 = 未入库
git -C mindcraft check-ignore -v keys.json
icacls "mindcraft\keys.json"
icacls "mindcraft"
# 直接实验
echo '{"api_key":"dummy-test-value"}' > tmp/r5-deploy/acltest/secret.test.json
icacls ...; chmod 600 ...; icacls ...
```

真实输出摘录：

```
$ git -C mindcraft ls-files keys.json
（空输出 = 未被 git 跟踪）
$ git -C mindcraft check-ignore -v keys.json
.gitignore:9:keys.json	keys.json
$ icacls mindcraft\keys.json
mindcraft\keys.json NT AUTHORITY\SYSTEM:(F)
                    BUILTIN\Administrators:(F)
                    LAPTOP-GDE992NS\zeh:(F)
$ icacls mindcraft
mindcraft NT AUTHORITY\Authenticated Users:(OI)(CI)(IO)(M)
          NT AUTHORITY\Authenticated Users:(M)
          NT AUTHORITY\SYSTEM:(F)
          BUILTIN\Administrators:(F)
          BUILTIN\Users:(RX)
          LAPTOP-GDE992NS\zeh:(F)
```

`chmod 600` 前后（同一个临时文件）：

```
$ icacls（chmod 前）
…secret.test.json S-1-4-48068235-…:(I)(W,D,DC)
                  BUILTIN\Administrators:(I)(F)
                  NT AUTHORITY\SYSTEM:(I)(F)
                  NT AUTHORITY\Authenticated Users:(I)(M)
                  BUILTIN\Users:(I)(RX)
$ chmod 600 secret.test.json
$ ls -l
-rwxrwxrwx 1 zeh zeh       31 … secret.test.json
$ icacls（chmod 后）
（与 chmod 前逐行完全相同）
```

**判定 D-12 `CONFIRMED`** ——

1. `chmod 600` 在 NTFS ACL 上**完全不生效**：ACL 逐行不变，连 `ls -l` 的 `-rwxrwxrwx` 都没变。任何"靠 `chmod 600` 保护凭据"的做法在 Windows 上是零作用。
2. `mindcraft/keys.json` 自身是**显式 ACL**（无 `(I)` 继承标记，继承已被移除），只有 SYSTEM / Administrators / 当前用户三个 `(F)` —— 这一份是收紧了的。
3. 但**父目录** `mindcraft/` 对 `Authenticated Users` 给 `(M)`（含 `Delete`）⇒ 本机其他用户即便读不到 `keys.json` 的内容，也能**删掉它再放一个同名文件**（或改目录名）实现替换。凭据文件的保密性与完整性在这里不同档。

证据：`docs/audit-r5/evidence/deploy/05-credentials-acl.txt`

### 6.2 D-13：忽略规则 —— 都生效

```bash
for f in x.token .env .env.local .env.production keys.json .mindserver-token; do git -C mindcraft check-ignore -v "$f"; done
for f in .env x.token .env.local .mindserver-token; do git check-ignore -v "$f"; done
```

真实输出摘录：

```
mindcraft: x.token              .gitignore:99:*.token	x.token
mindcraft: .env                 .gitignore:110:.Env	.env
mindcraft: .env.local           .gitignore:111:.Env.*	.env.local
mindcraft: .env.production      .gitignore:111:.Env.*	.env.production
mindcraft: keys.json            .gitignore:9:keys.json	keys.json
mindcraft: .mindserver-token    .gitignore:96:.mindserver-token	.mindserver-token
父仓     : .env                 .gitignore:154:.Env	.env
父仓     : x.token              .gitignore:135:*.token	x.token
父仓     : .env.local           .gitignore:155:.Env.*	.env.local
父仓     : .mindserver-token    .gitignore:132:.mindserver-token	.mindserver-token
```

**判定 D-13 `NOT-REPRODUCED`** —— 「`*.token` / `.env.*` 没被忽略」在本轮实测中不成立，两仓都命中规则（`.env` 由大小写不敏感的 `.Env` 规则吃掉，`core.ignorecase=true` 下等价）。

证据：`docs/audit-r5/evidence/deploy/05-credentials-acl.txt` 5.4 节

---

## 7. RCON 明文（任务 6）

> **本报告不写任何口令明文**，只给行号、长度与"是否被跟踪"。

### 7.1 D-14 / D-15：口令存在于配置文件、监听面不同，但**未入库**

```bash
grep -nE "^broadcast-rcon|^enable-rcon|^rcon\.password|^rcon\.port|^server-ip|^server-port|^online-mode" server/server.properties
git ls-files server/server.properties server-test/server.properties
git check-ignore -v server/server.properties server-test/server.properties
git grep -n -I -F "<口令前12字符>" -- .        # 两仓各跑一次
```

真实输出摘录（口令值已脱敏）：

```
## server/server.properties
7:broadcast-rcon-to-ops=false
14:enable-rcon=true
38:online-mode=false
46:rcon.password=<REDACTED>
47:rcon.port=25575
54:server-ip=
55:server-port=25565
  口令长度 = 48 字符

## server-test/server.properties
7:broadcast-rcon-to-ops=false
14:enable-rcon=true
38:online-mode=false
46:rcon.password=<REDACTED>
47:rcon.port=25576
54:server-ip=127.0.0.1
55:server-port=25566
  口令长度 = 32 字符

$ git ls-files server/server.properties server-test/server.properties
（空输出 = 两份都未入库）
$ git check-ignore -v server/server.properties server-test/server.properties
.gitignore:74:/server/server.properties	server/server.properties
.gitignore:26:/server-test/	server-test/server.properties

$ git grep -n -I -F "<前12字符>" -- .   # 父仓
[父仓命中数 = 0]
$ 同上（mindcraft 子仓）
[mindcraft 命中数 = 0]
```

已入库的示例文件里是占位符：

```
$ grep -n "rcon" server/server.properties.example
14:enable-rcon=true
46:rcon.password=CHANGE_ME
47:rcon.port=25575
```

**判定**：

- D-14 `CONFIRMED` —— `enable-rcon=true` 在两份配置里都开着；主服 `server-ip=`（空）+ `rcon.port=25575` ⇒ RCON 监听**所有网卡**；口令**明文**躺在 `server.properties:46`（48 位）。测试服绑定 `127.0.0.1:25576`、口令 32 位。
- D-15 `NOT-REPRODUCED` —— 「口令被提交进 git」**不成立**：两份 `server.properties` 都被忽略且未跟踪，两个仓库的跟踪文件里该口令**零命中**。

> 边界说明：本轮只做**静态**核对（文件现状 + 跟踪集检索），未做 `netstat` 端口实测、未启动服务端，故"是否真的在监听"记为**静态事实**而非运行实测。

证据：`docs/audit-r5/evidence/deploy/06-rcon.txt`

### 7.2 D-16：测试服那份配置的 ACL 是继承的 —— 含口令的文件对本机所有用户可读

```bash
icacls "server\server.properties"
icacls "server-test\server.properties"
```

真实输出摘录：

```
$ icacls server\server.properties
server\server.properties NT AUTHORITY\SYSTEM:(F)
                         BUILTIN\Administrators:(F)
                         LAPTOP-GDE992NS\zeh:(F)

$ icacls server-test\server.properties
server-test\server.properties S-1-4-48068235-…:(I)(W,D,DC)
                              BUILTIN\Administrators:(I)(F)
                              NT AUTHORITY\SYSTEM:(I)(F)
                              NT AUTHORITY\Authenticated Users:(I)(M)
                              BUILTIN\Users:(I)(RX)
                              Mandatory Label\Low Mandatory Level:(I)(NW)
```

**判定 D-16 `CONFIRMED`** —— 主服那份是**显式 ACL**（3 个主体，继承已移除）；测试服那份**全部带 `(I)` 继承标记**，`Authenticated Users:(M)`、`Users:(RX)` ⇒ 本机任何用户都能**读**这份含 32 位 RCON 口令的配置。凭据硬化只覆盖了 `server/`，**漏了 `server-test/`**。

证据：`docs/audit-r5/evidence/deploy/06-rcon.txt` 6.6 节

---

## 8. 复现清单（一键照抄）

```bash
cd /e/我的世界ai

# 1 拓扑
git ls-files mindcraft | wc -l                      # 期望 0（缺陷 D-01）
git remote -v                                       # 期望空（缺陷 D-03）
git -C mindcraft rev-list --count mine/main..HEAD   # 期望 302（缺陷 D-02）

# 2 锁与安装
git -C mindcraft ls-files package-lock.json         # 有
git clone --no-hardlinks E:/我的世界ai/mindcraft tmp/r5-deploy/clone2
( cd tmp/r5-deploy/clone2 && npm ci --no-audit --no-fund )   # 期望 EXIT 0（D-04 不成立）

# 3 产物绑定
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -VerifyOnly
                                                    # 期望 EXIT 1（缺陷 D-07）

# 4 Dockerfile（无 docker 时只能看文件）
grep -n "COPY web-dist" mindcraft/Dockerfile         # 第 77 行
( cd mindcraft/web-dist && node --input-type=commonjs -e '<第98行那段>' )  # 期望通过（缺口 D-11）

# 5 凭据 ACL
icacls "mindcraft\keys.json"
icacls "server\server.properties"; icacls "server-test\server.properties"   # 对比（缺陷 D-16）

# 6 RCON 现状（不要打印口令）
grep -nE "^enable-rcon|^rcon\.port|^server-ip|^rcon\.password" server/server.properties \
  | sed -E 's/^(.*:rcon\.password=).*$/\1<REDACTED>/'
git grep -l -I -F "<口令前12字符>" -- .              # 期望零命中（D-15 不成立）
```

---

## 9. 证据文件索引（`docs/audit-r5/evidence/deploy/`）

| 文件 | 内容 |
|---|---|
| `01-topology.txt` | 两仓 ls-files / status / remote / 未推送计数 / .gitignore 相关行 |
| `02-lockfile.txt` | 锁入库与忽略判定、HEAD 与工作树 lock 哈希 |
| `02-npm-ci-clean-clone.log` | 干净克隆真实 `npm ci` 全量输出（EXIT 0，548 包） |
| `02-npm-ci-minimal.log` | 仅 package.json+lock 的真实 `npm ci`（`No patch files found`，EXIT 0） |
| `03-artifact-binding.txt` | web-dist 全量 sha256、清单原文、自洽复算、源码指纹、隔离重建比对、历史 commit 指纹 |
| `03-release-verifyonly.log` | `release.ps1 -VerifyOnly` 完整输出（EXIT 1） |
| `03-web-src-fingerprint-current.txt` | 当前 25 个源码输入的逐文件 sha256 与总指纹 |
| `03-web-src-hash-by-commit.txt` | 9 个 commit 的源码指纹复算结果 |
| `03-web-rebuild.log` | 隔离重建 `npm ci + npm run build` 输出 |
| `04-dockerfile.txt` | docker 缺失、HEAD/工作树一致性、COPY 与校验段、.dockerignore、构建期校验本地实跑 |
| `04-dockerfile-head.txt` | `mindcraft/Dockerfile` 原文快照 |
| `05-credentials-acl.txt` | keys.json/父目录 icacls、`chmod 600` 前后对比、忽略规则 |
| `06-rcon.txt` | 两份 properties 现状（口令脱敏）、跟踪与忽略判定、跟踪集零命中、ACL 对比 |

---

## 10. 与"新机器从零部署"这条链路的净结论

按实际操作顺序，链路断在**三处**，且都不是"代码 bug"而是"发布动作没做完 / 校验放错了地方"：

1. **拿不到代码**：父仓不跟踪子仓（D-01）、父仓无远端（D-03）、子仓 302 个提交没推（D-02）。新机器无论克隆父仓还是克隆远端，都得不到当前这一版。
2. **拿到了也白拿**：镜像里的控制台产物是旧源码构建的（D-07/D-08/D-09），而 `docker build` 的构建期校验**抓不到**这一点（D-11）。
3. **装起来能跑，但补丁可能静默缺失**（D-05），凭据文件的保护在 Windows 上依赖 ACL 而非 `chmod`，且测试服那份漏了（D-12/D-16）。

反过来，本轮**实测证伪**了三条常见指控，可以作为"不必再改"的依据：`npm ci` 在干净克隆上能成功（D-04）、`web-dist` 与 `web/dist` 曾是逐字节一致（D-06）、RCON 口令没有进 git（D-15）。
