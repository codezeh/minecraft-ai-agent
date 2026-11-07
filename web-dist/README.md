# mindcraft/web-dist —— 控制台 UI 的**固化构建产物**（请勿手改）

这是镜像发布用的产物目录，内容 = 仓库根 `web/`（Vue3 + Vite 控制台）执行 `npm run build` 的输出。

## 为什么它会被提交进版本库

- `web/dist/` 本身被 `web/.gitignore` 忽略 —— 那是**开发产物**，随时可再生成，不该进版本库；
- 而 `mindcraft/web-dist/` 是**镜像发布所需的固化产物**：Docker 的构建上下文是 `mindcraft/`，
  取不到仓库根的 `../web`；而把上下文改成仓库根又会让
  `tools/dockerignore_coverage_unit.mjs`（按 mindcraft 相对路径断言 COPY 源存在）全红。
  两者角色不同，所以这里是**有意提交**的。

## 必须与 web/ 源码保持一致

改过 `web/` 的任何源码/样式/依赖之后，**必须**重新生成，否则镜像里的控制台与源码不一致。

**推荐（一条命令，构建 + 同步 + 校验 + 清单）**，在仓库根执行：

```powershell
pwsh scripts/release.ps1 -SkipDocker     # 只刷新产物并校验（不加 -SkipDocker 会连镜像一起验证）
```

等价的手工步骤（只有在 release.ps1 不可用时才用）：

```sh
cd web && npm ci && npm run build && rm -rf ../mindcraft/web-dist && cp -r dist ../mindcraft/web-dist
node ../mindcraft/tools/sync_web_dist.mjs   # 重写 MANIFEST.json 的 files 表
```

⚠️ 注意 `tools/sync_web_dist.mjs` 只写 `files`（逐文件 sha256）。
`source` / `artifact` / `generatedAt` / `entryAssets`（见下）由 `scripts/release.ps1` 写入 ——
**只跑 sync 会让清单退回旧格式**，随后 `release.ps1 -VerifyOnly` 会明确报错。

## MANIFEST.json 的字段（T10，2026-11-08）

```jsonc
{
  "schemaVersion": 2,
  "generatedAt": "2026-11-08T02:44:31Z",          // 生成时间（UTC）
  "source":    { "hash": "sha256:…", "files": 24,
                 "inputs": ["src", "index.html", "vite.config.ts", "tsconfig.json",
                            "package.json", "package-lock.json"] },   // 源码指纹
  "artifact":  { "hash": "sha256:…", "files": 9 },                   // 产物指纹
  "entryAssets": ["assets/index-….js", "assets/index-….css"],        // index.html 实际引用的入口
  "files": { "assets/index-….js": "…sha256…" }                       // 逐文件 sha256
}
```

- `source.hash`：对这 24 个输入文件按 `相对路径\0文件sha256` 排序后整体 sha256 ⇒ **产物绑定到"哪一版源码"**。
- `artifact.hash`：对 9 个产物文件同样算法 ⇒ **产物内容指纹**。
- 三者关系由 `scripts/release.ps1 -VerifyOnly` 与 `tools/web_dist_manifest_unit.mjs` 共同守着：
  **改了 web/ 却没重新生成产物 = 门禁红**（这正是审计说的"属侥幸"的那条缺口）。
- 容器构建期还有一道同源校验（`Dockerfile` 里 `COPY web-dist` 之后的 `RUN`）：
  缺 `index.html`/`MANIFEST.json`、文件与清单不符、`index.html` 引用了不存在的 chunk、
  或产物里有清单未记录的野文件 ⇒ **docker build 直接失败**，而不是起个 `/console` 404 的镜像。


## 运行时如何被找到

`src/mindcraft/mindserver.js` 按候选列表查找 UI 目录，取第一个存在的：

1. `$WEB_DIST`（显式覆盖）
2. `<repo>/web/dist`（本机开发：直接跑 `node main.js` 时命中）
3. `/app/web-dist`（镜像内：即本目录被 `COPY web-dist ./web-dist` 拷进去的位置）

三者都找不到时会打一条 `console.warn`，说明 `/console` 将 404 —— 不再静默失败。
