# 陪玩控制台（web/）

Vue 3 + Vite + Three.js。**独立工程**，不改 mindcraft 的构建；数据全部走 mindserver 的 socket.io。

## 最省事的用法：双击根目录的启动器

```
E:\我的世界ai\启动面板.bat     ← 一键：构建面板 → 起 MC 服 → 起 mindserver+bot → 打开浏览器
E:\我的世界ai\停止面板.bat     ← RCON 优雅关服 + 关 mindserver（不强杀，不损坏存档）
```

启动器做的事和「人工三步」完全等价，只是代你把两个坑填了：
- 等 Paper 输出 `Done (xx.xxxs)!` 才起 bot（只看端口会让 bot 被 `Took too long to log in` 踢掉）
- 上一个服还在关服时先等它退干净（否则抢端口必失败）

日志在 `E:\我的世界ai\logs\`：`server-console.log` / `mindcraft-console.log`。
启动失败时会自动打印这两个文件的末尾，不用去翻弹窗。

> 启动器用的是**构建产物**（`/console`），不需要 vite dev server。
> dev server（5173）只在改前端代码时用。

## 手动跑（改前端时用）

```powershell
cd web
D:\Node\npm.cmd install --ignore-scripts --cache .\.npm-cache   # 首次
D:\Node\node.exe .\node_modules\vite\bin\vite.js dev            # → http://localhost:5173
```

dev 模式下 `/socket.io` 与 `/assets` 由 vite 代理到 `localhost:8080`，不用改代码。

## 上线（由 mindserver 托管）

```powershell
cd web
D:\Node\node.exe .\node_modules\vite\bin\vite.js build   # → web/dist
```

`mindserver.js` 启动时若发现 `../web/dist` 存在，会自动挂到
**http://localhost:8080/console** （SPA fallback 已处理，`/console/terrain` 这类前端路由可直接刷新）。
旧面板仍在 `http://localhost:8080/`，两者互不影响。

## 页面

| 路由 | 内容 |
|---|---|
| `/` | 陪玩控制台：状态卡 + 背包/装备 + 对话流 + 快捷指令 |
| `/terrain` | 3D 地形（Three.js）：按类型着色、高度切片、失败点、她的位置 |
| `/debug` | `full_state` 原始 JSON + 输出日志 |
| `/setup` | agent 启停/删除/读设置（profile 表单与 paper 管理待做） |

## 后端新增（都在 mindcraft 侧，只新增不改语义）

| 位置 | 内容 |
|---|---|
| `src/agent/mindserver_proxy.js` | `get-terrain`：读 `terrain3d.db` 的 `boxSurfaces` + `readFails`，打包成整型数组 + base64 |
| `src/mindcraft/mindserver.js` | `request-terrain` 中继（30s 超时）+ `/console` 静态托管与 SPA fallback |

## 两个已踩的坑（改配置时别改回去）

1. **代理目标必须是 `127.0.0.1`，不能写 `localhost`**
   mindserver 只绑 IPv4（`127.0.0.1:8080`），而 Node 18+ 解析 `localhost` 会优先给 `::1`，
   于是 vite 代理报 `xhr poll error` / ECONNREFUSED，面板显示连不上。
2. **`server.watch.ignored` 必须排除 `poc/`**
   在 `poc/` 里跑脚本会产生临时文件，vite 的 watcher 撞上会抛 `EBUSY` 并**把整个 dev server 带崩**
   （表现为 5173 突然没人监听，但日志里只有一行 FSWatcher error）。

## 排查顺序（面板连不上时）

```powershell
# 1) 三个端口在不在
foreach ($p in 25565,8080,5173) { if (Get-NetTCPConnection -LocalPort $p -State Listen -EA SilentlyContinue) {"$p UP"} else {"$p DOWN"} }
# 2) 直连 mindserver（绕过代理）
D:\Node\node.exe poc\probe-terrain.mjs
# 3) 走 5173 代理（等同浏览器）
D:\Node\node.exe poc\probe-proxy.mjs
```

## 验证脚本

```powershell
cd ..\mindcraft
D:\Node\node.exe tmp\verify_payload.mjs        # 3D 数据打包/解码往返（真实库，0 条不一致）
D:\Node\node.exe tmp\test_console_mount.mjs    # /console 路由与 SPA fallback
```
