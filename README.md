# 我的世界 AI 陪玩 —— 仓库总览

这个工作区是**两个 git 仓库**叠在一起的：

| 路径 | 仓库 | 装什么 |
|---|---|---|
| `./`（仓库根） | 父仓 | 启动/关服脚本、世界备份、控制台前端源码 `web/`、文档与审计台账 |
| `./mindcraft/` | 独立嵌套仓（父仓 `.gitignore:13` 排除） | Minecraft bot 运行时 + mindserver、Dockerfile、**固化产物 `web-dist/`** |

⚠️ **父仓不跟踪 `mindcraft/`**。只 clone 父仓拿到的是"控制脚本"，没有业务代码；
新机器上要跑起来必须**两个仓都 clone**（见下）。

## 从干净检出到可运行镜像（发布路径）

第四轮审计 ④ 的问题就是这条路径不可复现：`web-dist/` 从未入库、HEAD 的 Dockerfile 没有
`COPY web-dist`、mindserver 只查 `/web/dist` —— 干净克隆要么构建失败，要么镜像里 `/console` 静默 404。
现在这条路径被一条命令管住：

```powershell
# 1) 两个仓都 clone（mindcraft 不是子模块，父仓不会替你拉）
git clone <parent-url> repo && cd repo
git clone <mindcraft-url> mindcraft

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
