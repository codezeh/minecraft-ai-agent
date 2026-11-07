# T5 —— Docker 实际构建（OPS-005 / OPS-007 / OPS-010）

> 真机验收，2026-11-06。本目录只产出**真机结论与证据**，未改动 `mindcraft/Dockerfile`、`.dockerignore`、`docker-compose.yml`（全程只读）。
>
> **一句话结论**：
> - **OPS-005**：`.dockerignore` + 显式 COPY 两层修复在**上下文与镜像两个口径上都成立**——本机真实存在的 14 个凭据/私有文件**一个都没进上下文**；但仍留 **3 类口径漏项**（`*.token` 通配等），且**修得过头**排掉了镜像必需的 `bots/*.js` 源码模板。
> - **OPS-007**：**未同步**。`Dockerfile:33` 仍是 `RUN npm install`；锁文件已入库且与 `package.json` 完全一致（lockfileVersion=3），改 `npm ci` 安全。
> - **OPS-010**：**发现 1 个真缺陷**——镜像里没有控制台 UI（`/console` 静默不挂载），因为 UI 产物在**构建上下文之外**。
> - **真 build 未执行**：本机**没有安装任何容器运行时**，连 WSL 子系统都没有（`wsl -l -v` 原文见下）⇒ 结论状态为「**被用户动作阻塞**」，待跑命令已备好。

---

## 0. 交付物

| 文件 | 作用 |
|---|---|
| [runtime-probe.json](runtime-probe.json) | A 步骤运行时探测**原始结果**（首次） |
| [runtime-probe-rerun.json](runtime-probe-rerun.json) | A 步骤**唯一一次**复查（任务开始后 ~5 分钟） |
| [probe-runtime.ps1](probe-runtime.ps1) | 运行时探测器（可重复跑，只读） |
| [context-manifest.json](context-manifest.json) | B 步骤构建上下文**物化清单**（280 文件 + 逐条敏感判定） |
| [make-context-manifest.mjs](make-context-manifest.mjs) | 上下文物化器（按 docker 真实匹配语义实现） |
| [verify-manifest.mjs](verify-manifest.mjs) | 上述清单的**独立自校验**（12/12 PASS，两套实现逐文件一致） |
| [run-docker-build.ps1](run-docker-build.ps1) | C 步骤真 build + 镜像内敏感文件检查 + 清理（待运行时就绪即跑） |

---

## 1. A 步骤：运行时探测（原始输出）

探测覆盖 5 路，全部落盘在 [runtime-probe.json](runtime-probe.json)：

| 探测面 | 结果 |
|---|---|
| PATH（docker / docker-compose / podman / nerdctl / buildah / containerd / limactl / colima） | **全部未找到**；只有 `wsl` 在 `C:\Windows\system32\wsl.exe` |
| 常见安装路径（22 条：Docker Desktop / Rancher / Podman / chocolatey / scoop …） | **一条都不存在**（`installPaths` 里 `exists=true` 的数量 = 0） |
| Docker Desktop 元数据（version.json / componentsVersion.json / `%ProgramData%\DockerDesktop`） | **全部不存在** |
| 服务（`com.docker.service` / `docker` / `com.docker.buildkit`）与进程（docker / podman / containerd / vmmem） | **全部未找到** |
| **WSL**（Docker Desktop 的 WSL2 后端前提） | `wsl -l -v` → exit 1，原文：**「未安装适用于 Linux 的 Windows 子系统。可通过运行 “wsl.exe --install” 进行安装。」** |

宿主机：`LAPTOP-GDE992NS` / Windows 11 家庭版 中文版 10.0.26300 / PowerShell 5.1.26100.9711 / AMD64。

`Get-WindowsOptionalFeature` 因非管理员报 `requires elevation`，三项（WSL / VirtualMachinePlatform / Containers）记 `UNKNOWN`——**非结论性**，仅说明未取到。

**结论**：`anyContainerRuntimeFound=false`、`dockerCliOnPath=false`、`dockerUsable=false`。

> 与任务前提的差异（如实记录）：任务书写「用户已在本机装 Docker Desktop」，但**实测本机没有装**，连 WSL 都没有。因此 `docker build` 在本轮**无法执行**。

---

## 2. B 步骤：构建上下文物化（不依赖 Docker 的硬证据）

### 2.1 方法

`make-context-manifest.mjs` 按 **moby/patternmatcher 的真实语义**复算 `.dockerignore`：

- 后规则覆盖前规则；`!` 反向放行（本文件 **0 条**）；`*` 不跨 `/`；`**` 跨 `/`；
- **路径本身或其任一祖先目录命中即算命中**（`MatchesOrParentMatches`）——这是"排除 `profiles` 就连带排除 `profiles/x.json`"的正解；
- 无 `!` 规则 ⇒ 排除目录可安全剪枝（清单里记了 `directoryPruningUsed=true` 与剪枝样本）。

只记 `path / size / mtime`，**从不读敏感文件内容**。

### 2.2 体量

| 口径 | 文件数 | 字节 |
|---|---|---|
| 全量（含 `node_modules`、`.git`） | 106,898 | — |
| **构建上下文**（`COPY . .` 会送进 daemon 的） | **280** | 4,583,006 |
| **镜像层**（Dockerfile 显式 COPY 清单） | **268** | 4,546,846 |
| 上下文有、镜像没有（多送的 12 个） | 12 | — |

那 12 个"只在上下文、不在镜像"的文件是：
`.dockerignore`、`Dockerfile`、`Tasks.Dockerfile`、`docker-compose.yml`、`andy.json`、`start.bat`、`eslint.config.js`、`FAQ.md`、`keys.example.json`、`LICENSE`、`minecollab.md`、`requirements.txt`。
（都不含凭据；`keys.example.json` 是示例文件。仍属"没必要的上下文体积"。）

### 2.3 逐条敏感路径判定

判定口径**只看规则、不看文件是否存在**；`EXCLUDED` = 被 `.dockerignore` 排除。

| 路径 | 本机真实存在 | dockerignore 排除 | 在上下文 | 在镜像 | 判定 |
|---|---|---|---|---|---|
| `.mindserver-token`（36 B） | ✅ | ✅ L24 | ❌ | ❌ | **EXCLUDED** |
| `.mindserver-token.bak` | — | ✅ L25 | ❌ | ❌ | EXCLUDED |
| `.env` / `.env.local` / `.env.production` | — | ✅ L27/28 | ❌ | ❌ | EXCLUDED |
| `keys.json`（575 B） | ✅ | ✅ L26 | ❌ | ❌ | **EXCLUDED** |
| `profiles/my-local.json`（1951 B） | ✅ | ✅ L32 | ❌ | ❌ | **EXCLUDED** |
| `profiles/andy-4.json` | ✅ | ✅ L32 | ❌ | ❌ | EXCLUDED |
| `.git/config`、`.git/HEAD` | ✅ | ✅ L16 | ❌ | ❌ | **EXCLUDED** |
| `bots/deepseek/memory.json` | ✅ | ✅ L35 | ❌ | ❌ | EXCLUDED |
| `logs/`、`logs/mindserver.log` | — | ✅ L36/42 | ❌ | ❌ | EXCLUDED |
| `tmp/whatever.json` | — | ✅ L37 | ❌ | ❌ | EXCLUDED |
| **`auth.token` / `deploy.token` / `mindserver.token` / `sub/dir/nested.token`** | — | ❌ **无规则** | ❌ | ❌ | **LATENT-GAP** |
| **`id_rsa` / `id_ed25519`** | — | ❌ 无规则 | ❌ | ❌ | LATENT-GAP |
| **`credentials.json` / `secrets.json`** | — | ❌ 无规则 | ❌ | ❌ | LATENT-GAP |
| **`server.pfx` / `server.crt` / `server.jks`** | — | ❌ 无规则（只有 pem/key/p12） | ❌ | ❌ | LATENT-GAP |
| **`mindserver-token`**（无前导点） | — | ❌ 无规则 | ❌ | ❌ | LATENT-GAP |
| **`config/` / `config/network.json` / `config.local.js`** | — | ❌ 无规则 | ❌ | ❌ | LATENT-GAP |

**汇总**：真泄漏（LEAK-IN-IMAGE）**0**；上下文有但镜像没有 **0**；潜在漏项 **16**；被正确排除 **14**。

### 2.4 三层交叉验证

1. **两套独立实现逐文件比对**（[verify-manifest.mjs](verify-manifest.mjs)，剪枝版 vs 全量不剪枝版）：`indep=280 / manifest=280`，两边差集均为 0 ⇒ **无剪枝漏项**。
2. **与 git 交叉**：上下文 280 个文件**全部被 git 跟踪**（`tracked∩ctx=280`，未跟踪 0）⇒ 没有"本机私有、未入库"的东西混进上下文。
3. **不变量 `gitignored ⊆ dockerignored`**：`git status --ignored` 列出的 14 个被忽略文件，**全部被 `.dockerignore` 挡住**（0 漏出）。

> 第 3 条是本次最有说服力的一条：**今天凡是 git 认为不该入库的私有文件，docker 也一个都没放进构建上下文。**

### 2.5 顺带核对：镜像里没有硬编码凭据

对**会进镜像的 267 个文本文件**做轻量模式扫描（`sk-*`、`sk-ant-*`、`AKIA*`、`AIza*`、`Bearer <长串>`、`BEGIN ... PRIVATE KEY`、`gh?_*`）：
**命中 0 条**（命中内容一律不输出，只记 文件:行 + 模式名）。

---

## 3. OPS-005 判定：**修复成立，但仍有漏项**

### 3.1 成立的证据（两层都成立）

- **第一层（真正的闸门）**：`Dockerfile` 已**不再** `COPY . .`（`bulkCopyPresent=false`），改为 8 条显式 COPY：`package*.json` / `patches` / `main.js settings.js` / `src` / `services` / `tasks` / `schematics` / `README.md`。COPY 清单里**不含** `profiles`、`keys.json`、`.env`、`bots`、`.git`、`.mindserver-token`、`logs`、`tmp`。
- **第二层（兜底）**：`.dockerignore` 35 条规则把 `gitignored` 全集挡在上下文之外（§2.4-3）。
- **反向断言**：镜像必需的 10 个路径（`main.js` / `settings.js` / `package.json` / `package-lock.json` / `patches` / `src/agent/agent.js` / `src/mindcraft/mindserver.js` / `services` / `tasks` / `schematics`）**全部既在上下文也在镜像**，没有被"为了安全把镜像搞坏"误伤。
- **项目自带断言也过**：`node tools/dockerignore_coverage_unit.mjs` → **62 passed, 0 failed**。

### 3.2 仍有漏项（按严重度）

| # | 漏项 | 证据 | 严重度 |
|---|---|---|---|
| **G1** | **无 `*.token` 通配**。只有 `.mindserver-token` 与 `.mindserver-token.*`，任何别的 `*.token` 都放行 | 与 F-SEC-206 同源：项目自己的 `tools/check_secret_filenames.mjs:52` 有 `/\.token$/`，`.dockerignore` 没有 ⇒ **两道防线口径不一致** | 中（当前无实例，属潜在） |
| **G2** | `.dockerignore` 的凭据模式集是 `check_secret_filenames.mjs` 的**真子集**：缺 `*.pfx` `*.crt` `*.jks` `id_rsa*` `id_ed25519*` `credentials*.json` `secrets*.json` `config.local.*` `mindserver-token`(无点) | 机械比对：**13 项口径分歧**（`patternDiff.divergences`） | 中 |
| **G3** | `config` 无规则 | 但**当前不构成真实泄漏**：`.dockerignore` 属 `mindcraft/`，`mindcraft/config` 不存在；根 `E:\我的世界ai\config\network.json` 在 `build: .` 的上下文之外。**队长点名的这条：当前布局下不泄漏，属潜在口径缺口** | 低 |
| **G4** | **修得过头**：`bots` 整目录排除，连带排掉了 `bots/execTemplate.js`、`bots/lintTemplate.js` 两片**git 跟踪的源码模板** | 二者 `inContext=0 inImage=0`，但 `git ls-files` 确认被跟踪；`src/agent/coder.js:20-27` 会 `readFile` 它们，且回调里 `if (err) throw err` ⇒ **异步抛异常 = 进程崩**，不是降级 | **中高**（见 §5-F2） |

> 建议（**不在本任务改动范围内**，仅记录）：把 `.dockerignore` 的凭据段补齐为与 `check_secret_filenames.mjs` 同一套模式（`*.token` `*.pfx` `*.crt` `*.jks` `id_rsa*` `id_ed25519*` `credentials*.json` `secrets*.json` `config.local.*` `config` `mindserver-token`），并对 `bots/execTemplate.js`、`bots/lintTemplate.js` 加两条 `!` 反向放行。

---

## 4. OPS-007 判定：**未同步**

- `Dockerfile:33` = `RUN npm install`（`npmCiPresent=false`）。
- 但仓库侧已就绪：`package-lock.json` 281,586 B、**lockfileVersion=3**、549 个 package 条目、与 `package.json` 的 `dependencies` **逐项完全一致**（差异 0）。`COPY package*.json .` 已经把锁文件带进构建阶段。
- ⇒ 改 `RUN npm ci` 是**安全且能直接做**的：可复现、且 `npm ci` 在校验锁文件不一致时会失败（正好变成一道门）。
- 附带（未列为缺陷，仅提示）：镜像未设 `NODE_ENV=production`，`devDependencies`（eslint 等）也会装进镜像；但 `postinstall: patch-package` 依赖 devDependency，**不能简单 `--omit=dev`**，否则 postinstall 会失败。

---

## 5. OPS-010 判定：**发现 1 个真缺陷 + 2 个摩擦点**

### F1（真缺陷，高）镜像里**没有控制台 UI**，`/console` 静默 404

```
src/mindcraft/mindserver.js:495-504
const webDist = path.join(__dirname, '../../../web/dist');
if (existsSync(webDist)) { app.use('/console', express.static(webDist)); ... }
```

- 容器内 `__dirname = /app/src/mindcraft` ⇒ `../../../web/dist` 解析为 **`/web/dist`，在 `/app` 之外**。
- UI 产物实际在 **仓库根** `E:\我的世界ai\web\dist`（本地实测 EXISTS，含 `index.html`）。而 `docker-compose.yml` 的 `build: .` 上下文是 **`mindcraft/`** ⇒ **根 `web/` 完全不在上下文内**（`contextSet` 里 `web/*` = 0 个，`imageSet` 里 = 0 个）。
- 又因为 `existsSync` 守卫存在，**不会报错**，只是 `/console` 不挂载 ⇒ 用户按注释访问 8080 只会看到旧面板，**没有任何提示**。
- 补充：`.dockerignore` 里那条 `web` 规则实际是**空转**（`mindcraft/web` 不存在），它并不能解决这个问题。

### F2（真缺陷，中高）`bots/*.js` 源码模板不在镜像内 → 触发代码生成时崩进程

- `bots/execTemplate.js`、`bots/lintTemplate.js` 是 **git 跟踪的源码**，但被 `.dockerignore` 的 `bots` 规则排除，也不在 COPY 清单 ⇒ 镜像里没有。
- `src/agent/coder.js:20-27`：`readFile(... '../../bots/execTemplate.js', 'utf8', (err,data)=>{ if (err) throw err; ... })` —— 在**异步回调里 throw**，Node 会按 uncaughtException 退出，**不是优雅降级**。
- `docker-compose.yml` 恰好挂载了 `./bots:/app/bots`（L15），所以**compose 路径侥幸可用**；但 `docker run <image>` 直接用镜像（或 compose 去掉该挂载）时，一旦走到 `!newAction` 代码生成就崩。
- 这一条正是"安全修复修过头"的代价：为了不漏运行期数据，把同目录下的源码模板也排掉了。

### F3（摩擦点，中）compose 没挂 `.mindserver-token`，也不设 `MINDSERVER_TOKEN` ⇒ 宿主机拿不到 token

- `mindserver.js:211` 把 token 写到 `process.cwd()`，容器内即 `/app/.mindserver-token`；`compose` 的 4 个挂载（settings.js / keys.json / profiles / bots）**不含它**。
- 日志只打指纹（`F-SEC-205` 故意不打全值）⇒ 宿主机要么 `docker compose exec mindcraft cat /app/.mindserver-token`，要么在 compose 里显式注入 `MINDSERVER_TOKEN`。
- 安全上正确（token 不该进镜像），但**可用性上缺一步**，文档/compose 应写明。

### F4（一致性，低）`3000-3003` 端口实际绑 `0.0.0.0`，与"只绑回环"的注释口径不一致

- `docker-compose.yml:17` `"3000-3003:3000-3003"` —— 未指定宿主 IP ⇒ 绑 `0.0.0.0`（局域网可达）；而同文件 `:22` 的 8080 已修成 `127.0.0.1:8080:8080`。
- 注释说那是"bot 头上摄像头的画面"，属于有意暴露；但与 OPS-010 修复宣称的"只绑回环"口径**不一致**，建议在注释里明确"这两个端口是刻意对局域网开放的"，或也收回到 `127.0.0.1`。

### F5（死文件，低）`Tasks.Dockerfile` 若被使用会直接失败

- `Tasks.Dockerfile:18` `COPY ./server_data.zip /mindcraft`，而 `server_data.zip` **不存在** ⇒ 该 Dockerfile 一用就失败。它不被 compose 引用（`build: .` 走 `Dockerfile`），属上游遗留死文件。

### OPS-010 已成立的部分（给证据）

- `MIND_SERVER_HOST` 支持已落地：`mindserver.js:840` 读环境变量，默认仍 `localhost`；`docker-compose.yml:10` 设 `MIND_SERVER_HOST: "0.0.0.0"` ⇒ 容器内可被发布端口访问。
- 8080 已固定宿主端口并只绑回环：`"127.0.0.1:8080:8080"`。

---

## 6. C 步骤：真 build 脚本（已就绪，待运行时）

[run-docker-build.ps1](run-docker-build.ps1) 做的事：

1. 前置检查：`docker` 在 PATH + `docker info` 通；
2. `docker version` / `docker info` 原始输出落盘；
3. `docker build --progress=plain --no-cache -t mindcraft-t5-verify:latest <mindcraft>`，全量原始输出落盘 `build-<stamp>.log`；
4. 抓 BuildKit 的 `transferring context:` 行，与宿主机复算的上下文体积（4,583,006 B）对照 —— **这是 `.dockerignore` 在 daemon 侧真的生效**的运行期证据；
5. `docker run --rm ... -c '<检查脚本>'` 在镜像内：
   - `ls -la /app`、`find /app -type f | wc -l`、`du -sb /app`
   - 按 `*.token *.pem *.key *.p12 *.pfx *.crt *.jks credentials*.json secrets*.json config.local.* id_rsa* id_ed25519* .env .env.* .mindserver-token(. *)* *.log run-live*` **逐模式 find**（只 `-printf '%p %s'`，**绝不 cat**）
   - 敏感目录 `/app/{profiles,bots,logs,tmp,.git,docs,tools,.vscode}` 存在性
   - 必需文件 10 项存在性
   - 整镜像范围（`find / -xdev`）的 `*.token` / 私钥
6. 判定并写 `build-result-<stamp>.json`；**发现泄漏 exit 1**
7. 清理镜像/容器（`-KeepImage` 可保留）

已验证：`-DryRun` 正确打印全部命令与镜像内检查脚本；无运行时环境下正确 `exit 3`（不误判成安全结论）。

---

## 7. D 步骤：为什么真 build 没跑 + 待跑命令

**阻塞原因（不是结论）**：本机无任何容器运行时，且 **WSL 子系统未安装**——Docker Desktop 在 Windows 上依赖 WSL2 后端，所以这不是"启动一下 Docker Desktop"就能解决的，需要先装 WSL 并重启。

任务规定的复查只做了一次（`runtime-probe-rerun.json`，2026-11-06T19:53:50+08:00），结论与首次一致；**未轮询空等**。

### 待跑命令（用户装好 WSL + Docker Desktop 并启动后）

```powershell
# 0) 管理员 PowerShell，一次性的系统准备（需要重启）
wsl.exe --install
#    重启后确认：
wsl -l -v
wsl --status

# 1) 装 Docker Desktop（winget 或官网安装包），启动后确认 daemon 可用
docker version
docker info --format '{{.ServerVersion}}'

# 2) 复查运行时（应变为 anyContainerRuntimeFound=true / dockerUsable=true）
powershell -NoProfile -ExecutionPolicy Bypass -File docs\真机-20261106\T5\probe-runtime.ps1 -Out runtime-probe-ready.json

# 3) 真 build + 镜像内敏感文件检查（本任务唯一待补的真机步骤）
powershell -NoProfile -ExecutionPolicy Bypass -File docs\真机-20261106\T5\run-docker-build.ps1

# 4) 顺带验证 OPS-010 的两个真缺陷（F1 / F2）
docker build -t mindcraft-t5-verify:latest mindcraft
docker run --rm mindcraft-t5-verify:latest ls /web 2>&1        # 期望: No such file（F1 证据）
docker run --rm mindcraft-t5-verify:latest ls /app/bots 2>&1   # 期望: No such file（F2 证据）
```

预期（基于本报告 §2/§3 的静态结论）：
- 步骤 3 应输出 `PASS（镜像内无敏感文件，OPS-005 修复成立）`，`leaks=[]`；若出现 `模式命中: /app/... .token` 之类，则 G1/G2 已从"潜在"变成"实际"。
- 步骤 4 的两条 `ls` 都应为 `No such file`，从而**用镜像本身**证明 F1 与 F2。

---

## 8. 结论一览

| 项 | 判定 | 证据强度 |
|---|---|---|
| OPS-005 上下文/镜像不带凭据 | **成立**（0 真泄漏） | 强：机器复算 + 两实现交叉 + git 不变量 + 项目自带断言 62/62 |
| OPS-005 口径仍有漏项 | **是**（G1 `*.token` 等 13 项分歧、G3 config、G4 修过头） | 强：与 `check_secret_filenames.mjs` 机械比对 |
| OPS-007 `npm ci` | **未同步**（仍 `npm install`），且改造成本低、锁文件已就绪 | 强 |
| OPS-010 容器内监听 0.0.0.0 | **成立** | 强 |
| OPS-010 控制台 UI 在镜像里 | **不成立（F1，新发现）** | 强：路径算术 + 上下文清单双向确认 |
| OPS-010 代码生成模板在镜像里 | **不成立（F2，新发现）** | 强：同上 + coder.js 异步 throw |
| 真 `docker build` | **未执行——被环境阻塞** | 运行时探测两次原始输出 |

**OPS-005 的"修复成立"与本目录的"G1/G4 漏项"不矛盾**：前者说的是"本机真实的凭据文件有没有漏"（没有），后者说的是"规则的覆盖面够不够"（不够，且有一处过宽）。
