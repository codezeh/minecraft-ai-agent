# 我的世界 AI 陪玩 —— 仓库总览

这个工作区是**两个 git 仓库**叠在一起的：

| 路径 | 仓库 | 装什么 |
|---|---|---|
| `./`（仓库根） | 父仓 | 启动/关服脚本、世界备份、控制台前端源码 `web/`、文档与审计台账 |
| `./mindcraft/` | 独立嵌套仓（父仓 `.gitignore:13` 排除） | Minecraft bot 运行时 + mindserver、Dockerfile、**固化产物 `web-dist/`** |

⚠️ **父仓不跟踪 `mindcraft/`**（`.gitignore:13` 排除，因为子仓自带 `.git`，硬纳进来会变成伪子模块）。
只 clone 父仓拿到的是"控制脚本 + 前端源码"，**没有业务代码，跑不起来**；
新机器上必须**两个仓都 clone** —— 这件事现在由 `scripts/clone-all.ps1` 一条命令负责，不再靠人记。

## 从零开始（3 条命令）

```powershell
# 1) 两个仓一起拉下来（父仓 → <Dest>，子仓 → <Dest>/mindcraft）
#    有远端时：
pwsh scripts/clone-all.ps1 -ParentUrl <parent-url> -MindcraftUrl <mindcraft-url> -Dest D:\repo
#    只想在本机复现"干净检出"（没有远端也能真跑）：先 clone 父仓，再用 -LocalSource
pwsh scripts/clone-all.ps1 -LocalSource -Dest D:\repo

# 2) 装运行时依赖（548 个包，首次约 10 分钟）
cd D:\repo\mindcraft; npm ci

# 3) 校验"产物 ↔ 清单 ↔ 源码指纹"是否一致（秒级，不需要 docker）
cd D:\repo; pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -VerifyOnly
```

`clone-all.ps1` 会做三件容易漏掉的事：**(a)** 检测"父仓 clone 完但没有 `mindcraft/`"的半成品状态并给出明确报错（这正是 R5-004 的用户体感）；**(b)** 校验两个仓的 HEAD 短哈希与 `-Ref` 是否一致；**(c)** 自检 `mindcraft/web-dist/` 与 `MANIFEST.json` 是否随仓库到位（缺了就明说镜像会构建失败）。参数：`-ParentUrl` / `-MindcraftUrl` / `-Dest`（必填）/ `-Ref`（可选）/ `-LocalSource`。

## 从干净检出到可运行镜像（发布路径）

第四轮审计 ④ 的问题就是这条路径不可复现：`web-dist/` 从未入库、HEAD 的 Dockerfile 没有
`COPY web-dist`、mindserver 只查 `/web/dist` —— 干净克隆要么构建失败，要么镜像里 `/console` 静默 404。
现在这条路径被一条命令管住：

```powershell
# 1) 两个仓都 clone —— 用上面第 1 条命令（scripts/clone-all.ps1），它会连子仓一起拉

# 2) 一条命令：构建前端 → 同步固化产物 → 校验清单/源码指纹 → docker build
#    → 起容器 → 断言 /console 与首个静态资源均 200 → 清理
pwsh scripts/release.ps1
```

常用变体：

| 命令 | 作用 | 耗时 |
|---|---|---|
| `pwsh scripts/release.ps1` | 全链路（含镜像与运行时 200 断言） | 首次几分钟（apt/npm 有缓存后更快） |
| `pwsh scripts/release.ps1 -SkipDocker` | 只刷新 `mindcraft/web-dist` 并校验，不建镜像 | 秒级~1 分钟 |
| `pwsh scripts/release.ps1 -VerifyOnly` | 只校验"产物 ↔ 清单 ↔ 源码指纹"是否一致 | 秒级 |
| `pwsh scripts/release.ps1 -DockerExe 'wsl -e sudo docker' -ProbeExe 'wsl -e curl'` | 本机只有 WSL 里的 docker 时 | 同上 |

### 为什么构建期会拦住"缺产物"

`mindcraft/Dockerfile` 在 `COPY web-dist ./web-dist` 之后有一段 `RUN` 做硬校验：
缺 `index.html`/`MANIFEST.json`、文件与清单 sha256 不符、`index.html` 引用了产物里不存在的
chunk、或产物目录里有清单未记录的野文件 ⇒ **docker build 直接失败**。
所以"删掉 `web-dist/` 再构建"得到的是一条明确报错，而不是一个 `/console` 404 的镜像。

产物本身的指纹与生成时间记在 `mindcraft/web-dist/MANIFEST.json`
（`source.hash` = 源码指纹，`artifact.hash` = 产物指纹，`generatedAt` = 生成时间），
字段说明见 `mindcraft/web-dist/README.md`。

### 发布纪律

- 改过 `web/`（前端源码）之后**必须**重跑 `scripts/release.ps1 -SkipDocker` 并把
  `mindcraft/web-dist/**` 一起提交，否则镜像里的控制台是旧版本，`-VerifyOnly` 会红。
- 要发布"某次提交"的产物、而工作树里还有别人的改动时：
  `git worktree add tmp/rel-src <ref>` 然后用 `-SourceRoot tmp/rel-src/web`。
- 推送远端需要人工确认——脚本只做本地构建与自检，不推送。
