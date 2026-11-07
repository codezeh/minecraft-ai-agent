# mindcraft/web-dist —— 控制台 UI 的**固化构建产物**（请勿手改）

这是镜像发布用的产物目录，内容 = 仓库根 `web/`（Vue3 + Vite 控制台）执行 `npm run build` 的输出。

## 为什么它会被提交进版本库

- `web/dist/` 本身被 `web/.gitignore` 忽略 —— 那是**开发产物**，随时可再生成，不该进版本库；
- 而 `mindcraft/web-dist/` 是**镜像发布所需的固化产物**：Docker 的构建上下文是 `mindcraft/`，
  取不到仓库根的 `../web`；而把上下文改成仓库根又会让
  `tools/dockerignore_coverage_unit.mjs`（按 mindcraft 相对路径断言 COPY 源存在）全红。
  两者角色不同，所以这里是**有意提交**的。

## 必须与 web/ 源码保持一致

改过 `web/` 的任何源码/样式/依赖之后，**必须**重新生成，否则镜像里的控制台与源码不一致：

```sh
cd web && npm ci && npm run build && rm -rf ../mindcraft/web-dist && cp -r dist ../mindcraft/web-dist
```

生成后请确认 `index.html` 里的资源前缀是 `/console/assets/...`（`web/vite.config.ts` 在 build 时把
`base` 设成 `/console/`，mindserver 也把静态目录挂在 `/console`），否则页面会白屏。

## 运行时如何被找到

`src/mindcraft/mindserver.js` 按候选列表查找 UI 目录，取第一个存在的：

1. `$WEB_DIST`（显式覆盖）
2. `<repo>/web/dist`（本机开发：直接跑 `node main.js` 时命中）
3. `/app/web-dist`（镜像内：即本目录被 `COPY web-dist ./web-dist` 拷进去的位置）

三者都找不到时会打一条 `console.warn`，说明 `/console` 将 404 —— 不再静默失败。
