# T5 补充 · 真 Docker 构建与镜像内核查（2026-11-07）

> 本文件补上 T5/README 里「真 build 未做」那一块。
> 前置变化：用户的 WSL（`Ubuntu-24.04`，注册在 `D:\WSL\Ubuntu-24.04`）已就绪；Docker Desktop 未装，
> 改为**在 WSL 发行版内装 docker.io 29.1.3**（overlayfs），daemon 起在发行版内。

## 0. 结论速览

| 项 | 结果 |
|---|---|
| 真 `docker build` | ✅ **成功**：`Successfully built ef36d2ab2fce` / `mc-ai-audit:20261107` |
| 凭据泄漏 | ✅ **0 泄漏**（镜像内 `.mindserver-token`/`keys.json`/`.env`/`profiles`/`.git` 全 clean） |
| **F1 控制台 UI** | ❌ **实测成立**：带正确 token 请求 `/console` → **404**（本机同请求是 200） |
| **F2 bots 模板** | ❌ **实测成立**：`/app/bots` 整个目录不存在 |
| **F6（新）** | 🔴 **P1：`COPY package*.json .` 让 `docker build` 直接失败** |
| OPS-010 回环绑定 | ❌ **实测成立**：默认绑 `localhost`，端口映射进不来（`curl` = 000） |

## 1. 构建环境的搭建（可复现）

```bash
# 1) 发行版内装 docker（Windows 侧没有 Docker Desktop）
wsl -d Ubuntu-24.04 -u root -e sh -lc 'apt-get update && apt-get install -y docker.io'

# 2) 起 daemon（不依赖 systemd）
wsl -d Ubuntu-24.04 -u root -e sh -lc 'nohup dockerd >/var/log/dockerd.log 2>&1 &'

# 3) Docker Hub 直连超时 ⇒ 配镜像源
cat > /etc/docker/daemon.json <<'EOF'
{ "registry-mirrors": ["https://docker.m.daocloud.io", "https://docker.1ms.run"] }
EOF
# 重启 dockerd 后 docker pull node:22-bookworm-slim 成功
```

**测速依据**：`deb.debian.org` 约 **60 KB/s**；清华源 **26 MB/s**（差 400 倍）。构建里 apt 那步必须换源，否则装不完。

## 2. ★ F6（新发现，P1）：lock 入库把 `docker build` 打死了

### 现象

```
Step 6/15 : COPY package*.json .
When using COPY with more than one source file, the destination must be a directory and end with a /
BUILD_EXIT=1
```

### 根因

- `Dockerfile:31` 写的是 `COPY package*.json .`（目标是 `.`，**不是目录形式**）
- 这条是**单文件语义**：原本上下文里只有 `package.json` 一个匹配，能过
- 但 `package-lock.json` 在 **2026-11-06 18:50 的 `a5446ce`（OPS-007 修 lock 入库）** 之后进入了上下文
- 于是 `package*.json` 匹配到 **2 个文件**，Docker 判定「多源文件 ⇒ 目标必须以 `/` 结尾」⇒ **构建失败**

### 定性

**这是 OPS-007 那次修复引入的构建回归**：修复本身（把 lock 入库）是对的，但它和 `Dockerfile:31` 的写法冲突，
导致**从那笔提交起，`docker build` 已经不可能成功**。因为此前没有人跑过真 build（无 WSL/无 Docker），
这个缺陷一直没暴露——**只有真机构建才能发现它**。

### 修法（一行）

```diff
-COPY package*.json .
+COPY package*.json ./
```
（这会同时把 `package.json` 与 `package-lock.json` 拷进 `/app`，正好满足 OPS-007 想要的 `npm ci` 前提。）

### 本轮的验证方式（未改产品文件）

复制一份 `T5/Dockerfile.audit`，**只加两处**：① apt 换源（网络原因）；② 上述 `./` 修复。
`diff` 结果仅这两处，其余 53 行逐字一致——**产品 `Dockerfile` 一个字节未动**。
用该副本构建成功，证明「修掉这两处后，构建链路是通的」。

## 3. F1 实测：镜像里 `GET /console?token=…` → 404

### 代码机制（`mindserver.js:494-503`）

```js
const webDist = path.join(__dirname, '../../../web/dist');   // __dirname=/app/src/mindcraft ⇒ /web/dist
if (existsSync(webDist)) {
    app.use('/console', express.static(webDist));
    app.get(['/console','/console/*'], (req,res)=> res.sendFile(path.join(webDist,'index.html')));
    console.log(`Console UI mounted at ...`);
}
```

`/web/dist` 在 `/app` **之外**，镜像里不存在 ⇒ `existsSync` 为 false ⇒ **`/console` 路由压根不注册**，
且因为整个 `if` 块被跳过，**连一行日志都没有**（静默）。

### 实测对照

| 环境 | `GET /console`（无 token） | `GET /console?token=…`（正确 token） | 日志有 `Console UI mounted` |
|---|---|---|---|
| **本机**（仓库根有 `web/dist`） | 401 | **301 → 200**（返回 `assets/index-*.js`） | 有 |
| **真镜像** | 401 | **404** | **无** |

⇒ F1 从「静态推断」升级为**真镜像实证**。

### 修法

把 UI 产物纳入构建（两种任选）：
1. **多阶段构建**：`FROM node:22 AS ui` → `cd web && npm ci && npm run build` → `COPY --from=ui /web/dist /app/web/dist`，同时改 `webDist` 指向 `/app/web/dist`；
2. 或在 CI 里先构建 `web/dist`，再把它作为构建上下文的一部分（需同步放宽 `.dockerignore` 的 `web` 规则）。

**另建议**：`existsSync` 失败时**打一条 warn**，不要让「没有 UI」变成静默状态。

## 4. F2 实测：`/app/bots` 不存在

```
MISSING  /app/bots/execTemplate.js
MISSING  /app/bots/lintTemplate.js
MISSING  /app/bots
```

`.dockerignore:35` 的 `bots` 是整目录排除（为的是不让运行期数据进镜像，方向正确），
但连带排掉了 **git 跟踪的源码模板** `bots/execTemplate.js`、`bots/lintTemplate.js`。

后果（静态已确认、本次未构造触发）：`coder.js` 在 `readFile` 回调里 `if (err) throw err`，属**异步抛异常 → 崩进程**。
`docker compose` 因为挂了 `./bots` 才侥幸能用；**`docker run <image>` 直接用镜像时，一旦触发代码生成就崩**。

**修法**：把 `.dockerignore` 的 `bots` 改成 `bots/*` + `!bots/*.js` 之类的白名单写法，只放行两片模板。

## 5. OPS-010 实测：默认绑回环，映射进不来

- `mindserver.js:840`：`const host = (process.env.MIND_SERVER_HOST || 'localhost').trim() || 'localhost'` ⇒ **默认只绑回环**
- 容器内 `/proc/net/tcp`：默认 `0100007F:1F90`（127.0.0.1）⇒ 宿主 `curl 127.0.0.1:18080/console` = **000**
- 加 `-e MIND_SERVER_HOST=0.0.0.0` 后：`00000000:1F90`（0.0.0.0）⇒ 探测正常返回 **401**

⇒ 「安全默认（只绑回环）」与「容器端口映射」天然冲突；容器部署必须显式设 `MIND_SERVER_HOST=0.0.0.0`，
且应把这条写进 `docker-compose.yml` / 文档，否则用户装上也连不上。

## 6. 凭据核查（真镜像，只看存在性）

```
clean  /app/.mindserver-token
clean  /app/keys.json
clean  /app/.env
clean  /app/profiles
clean  /app/.git
clean  /app/bots/_board
clean  /app/logs
clean  /app/tmp
*.token wildcard probe: 空
```

⇒ **OPS-005 的修复在真镜像上成立，0 泄漏**。

## 7. 另一条实测边界（非缺陷，但值得记）

容器以**默认 `CMD ["npm","start"]`** 启动时，`main.js:88` 会对 `settings.profiles` 里的每个路径直接
`readFileSync('./profiles/my-local.json')`；该文件被 `.dockerignore` 排除（**正确**，凭据不该进镜像），
所以不挂载就 **`ENOENT` 直接崩**：

```
Error: ENOENT: no such file or directory, open './profiles/my-local.json'
    at file:///app/main.js:88:37
```

Dockerfile 注释确实要求运行时挂载 `profiles/`，所以「必须挂载」是**设计意图**；
但**失败方式是裸异常 + 堆栈**，建议改成一句可行动的提示（"profiles/ 必须挂载，参见 README"）。

## 8. 产物

| 文件 | 内容 |
|---|---|
| `docker-build-real.log` | 三次构建原始输出（失败/失败(COPY)/成功） |
| `Dockerfile.audit` | 仅两处差异的审计副本（产品 Dockerfile 未动） |
| `inspect-image.sh` | 镜像内核查脚本 |
| `image-inspect-REAL.txt` | 真镜像核查输出 |
| `console-404-REAL.txt` | `/console` 404 与 0.0.0.0 绑定的实测记录 |
