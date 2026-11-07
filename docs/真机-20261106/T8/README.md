# T8 · Docker/部署 6 条修复 —— 真镜像验证（2026-11-07）

> 成员 `ops-probe` 在收尾时**被上游 502 中断**（`api.llmgo.net` 源站故障），代码改动已完成，
> 但最终验证由 **Lead 接手重跑**。本文所有数字均为 Lead 亲自执行所得，不转述成员自述。

## 0. 验证结论

| 缺陷 | 修复 | 真镜像验证 |
|---|---|---|
| **F6** `docker build` 必然失败 | `COPY package*.json .` → `./` | ✅ 构建过第 6 步，`BUILD_EXIT=0` |
| **OPS-007** `npm install` | → `npm ci` | ✅ Step 8 `RUN npm ci` 成功 |
| **F1** 镜像缺控制台 UI | `COPY web-dist` + 三候选 + 缺 UI 时 warn | ✅ `/console?token=T` → **200**，取到 `assets/index-Bh1enPsf.js` |
| **F2** `bots/*.js` 被排除 | `.dockerignore` 白名单 | ✅ `bots/` 下正好 2 个条目，两片模板均在 |
| **G1** 缺 `*.token` | 补 `*.token` + `**/*.token` | ✅ 镜像内 `*.token` = **0 个** |
| **F3** compose 无 token | 改 `MINDSERVER_TOKEN` env | ✅（静态核对 + `:?` 语法，未起 compose） |
| **F4** 端口绑 0.0.0.0 | `127.0.0.1:3000-3003` | ✅（静态核对） |
| **F5** `Tasks.Dockerfile` | 删除 | ✅ 文件已删 |
| **OPS-005** 凭据泄漏 | 无回归 | ✅ 8 项全 clean |

## 1. 构建

```
=== mirror-only audit build 2026-11-07T21:0x ===
Step 8/17 : RUN npm ci
...
Step 17/17 : CMD ["npm","start"]
Successfully built 9d9ae851ca08
Successfully tagged mc-ai-audit:fixed
BUILD_EXIT=0
```

**关于构建方式的说明（重要）**

- **交付版 `mindcraft/Dockerfile` 未换源**，用官方 `deb.debian.org`。实测该源在本机约 **15 B/s ~ 60 KB/s**，
  774 MB 的 apt 增量下载耗时不可接受，因此**原版构建仍在后台慢跑**（日志 `docker-build-FIXED.log`，已跑到 Get:62）。
- 为拿到完整镜像做内容核查，另用 `T8/Dockerfile.mirror-audit`（**只比交付版多一行 apt 换源**，`diff` 可证：
  `COPY package*.json ./`、`RUN npm ci`、`COPY web-dist ./web-dist` 全部逐字保留）构建出 `mc-ai-audit:fixed`。
- ⇒ **F6/镜像内容的结论与 apt 源无关**：F6 只涉及 `COPY package*.json` 那一步（已过），
  镜像内容只取决于 COPY 清单。换源副本在「文件是否在镜像里」上的证据效力与原版**完全相同**。
  唯一不同的是「官方源可达性」，而那不影响任何一条结论。

## 2. F1 实测（修复前 404 → 修复后 200）

```
=== 日志关键行 ===
Console UI mounted at http://localhost:8080/console (from /app/web-dist)
MindServer running on port 8080 on host 0.0.0.0

--- 301 目标 ---
  /console?token=T -> 301  redirect=http://127.0.0.1:18090/console/?token=audit-fixed-token-0001
--- 跟随重定向 ---
  /console/?token=T -L -> 200  (body 398 字节)
--- body 引用 ---
  assets/index-Bh1enPsf.js
--- 直接取该 js ---
  GET /console/assets/index-Bh1enPsf.js -> 200
```

对照修复前（`T5/console-404-REAL.txt`）：同一请求返回 **404**，且日志**没有** `Console UI mounted` 这行。

## 3. 镜像内容核查

```
=== F1: 控制台 UI ===
  EXISTS /app/web-dist (3 entries)
  index.html: /app/web-dist/index.html
  assets js: 4 个

=== F2: bots 源码模板 ===
  EXISTS /app/bots/execTemplate.js
  EXISTS /app/bots/lintTemplate.js
  bots/ 下条目数: 2

=== 凭据泄漏（只看存在性）===
  clean /app/.mindserver-token / /app/keys.json / /app/.env / /app/profiles
  clean /app/.git / /app/bots/_board / /app/logs / /app/tmp
  *.token: 0 个
```

## 4. F1 的实现取舍：为什么是 vendoring 而不是多阶段构建

原任务建议「多阶段 + `COPY --from=ui`」。**这条路走不通**，是读门禁源码后确认的：

`tools/dockerignore_coverage_unit.mjs:126-128` 把每个 `COPY` 行**除最后一个之外的所有 token** 都当源路径，
并要求 `existsSync(path.join(mindcraft, src))`：
- `COPY --from=ui /build/web/dist ./web-dist` ⇒ 它把 `--from=ui` 也当 src ⇒ `existsSync('--from=ui')=false` ⇒ **门禁红**；
- 改用仓库根作上下文 ⇒ 所有 `src/...` 在 mindcraft 相对下不存在 ⇒ **门禁全红**。

⇒ 三者（零补丁构建 + 门禁绿 + 镜像带 UI）同时成立，UI 产物**必须落在 `mindcraft/` 内**。
故取 `mindcraft/web-dist/`（git 跟踪的固化产物，约 700 KB），并在其 `README.md` 写清
「发布产物、勿手改、改过 `web/` 必须重新生成、以及再生成命令」。

**代价**：版本库多约 700 KB 构建产物。**收益**：零补丁构建 + 门禁可过 + 镜像真带 UI。

## 5. 交付版官方源构建（后台继续）

原版 `docker build`（官方源）仍在跑，日志 `docker-build-FIXED.log`。
它若最终成功，可与本文互为佐证；若因网络最终失败，**不影响上述结论**（原因见 §1 说明）。
判读方式：`grep BUILD_EXIT=0 docker-build-FIXED.log`。

## 6. 未在真镜像验证的两条（如实说明）

- **F3**（compose 的 `MINDSERVER_TOKEN`）：只做了静态核对与 YAML 解析，**没有**真跑 `docker compose up`
  （需要额外设置 env，且与本轮验收目标无关）。
- **F4**（`127.0.0.1:3000-3003`）：只做静态核对，未起 compose 验证绑定地址。
  > 注：OPS-010 的 `MIND_SERVER_HOST=0.0.0.0` 已在 §2 的容器启动中实测生效。
