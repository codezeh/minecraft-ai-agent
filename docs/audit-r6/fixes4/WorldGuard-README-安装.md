# WorldGuard 安装说明（本服：Paper 1.21.8）

> 本目录**只放文档**。WorldGuard 的 jar 由人工从官方来源下载后放进 `server/plugins/`，
> 不纳入版本库、不由脚本下载。本文件写清「哪个版本配得上这台服」「装完怎么验」。
>
> 当前状态：`server/plugins/` 里**没有** WorldGuard（`scripts/worldguard-check.ps1` 会报「未安装」）。
> 三件套的分工与局限见 [`docs/audit-r6/fixes4/worldguard.md`](../../../docs/audit-r6/fixes4/worldguard.md)。

## 0. 本服基线（先确认，再选版本）

| 项 | 值 | 依据 |
|---|---|---|
| 服务端 | **Paper 1.21.8-60**（`1.21.8-60-main@29c8822`，2025-09-06） | `server/logs/latest.log`：`This server is running Paper version 1.21.8-60` |
| Minecraft | **1.21.8** | 同上：`Starting minecraft server version 1.21.8` |
| 现有插件 | BlueMap / Chunky / ChunkyBorder / CoreProtect CE-24.1 / OnePlayerSleep / SkinsRestorer / spark | 启动日志 `Loading server plugin ...` |
| 权限插件 | **无**（只有 `server/ops.json`，`HEAVENZEH` level 4） | `server/ops.json` |
| 模式 | `online-mode=false`、`white-list=true`、`enforce-whitelist=true`、`spawn-protection=0` | `server/server.properties` |

## 1. 版本对应：1.21.8 只能配 WorldGuard 7.0.14

WorldGuard 每个版本的 Minecraft 适配是**跟着上升**的，不是向下全兼容。
按 Modrinth 官方项目元数据（`api.modrinth.com/v2/project/worldguard/version`，抓取于 2026-11-12）整理：

| Minecraft | WorldGuard | WorldEdit（必需依赖） | 说明 |
|---|---|---|---|
| 1.21.4 | 7.0.13 | 7.3.x | — |
| **1.21.5 – 1.21.8** | **7.0.14** | **7.3.16**（7.3.17–7.3.19 也列了 1.21.8） | **← 本服这一行** |
| 1.21.10 – 1.21.11 | 7.0.15 | 7.3.17+ / 7.4.x | 1.21.8 **不在**支持列表 |
| 1.21.11 / 26.1.x | 7.0.16、7.0.17 | 7.4.x | 同上 |
| 26.1 – 26.3 | 7.0.18 起 | 7.4.x | 需要先升级 Paper，别跳太多版本 |

**7.0.14 是最后一个把 1.21.8 写进支持列表的 WorldGuard 版本**（7.0.15 起直接转 1.21.10+）。
在 Paper 1.21.8 上装 7.0.15+ 属于跨版本，加载期就可能报 `UnsupportedClassVersionError`/`NoSuchMethodError`
或静默不生效 —— 不要试。

### ⚠️ WorldEdit 的坑：别顺手拿最新版

WorldEdit 7.4.x 的发布说明（7.4.0 Beta 1）明确写：**"only compatible with WorldGuard 7.0.15 Beta 1 or newer"**；
而 WorldGuard 7.0.15+ 已经不再支持 1.21.8。两者交叉，结论是：

- **1.21.8 上请用 WorldEdit 7.3.16**（官方标注支持 1.21.3–1.21.8 的版本），配 WorldGuard 7.0.14；
- 想用 WorldEdit 7.4.x，就得连 WorldGuard 7.0.15+ 一起，而那要求 MC 1.21.10+ —— 即先升级 Paper；
- 7.4.x 正式版更新日志没再重复这条约束，但也没否认。真要用必须**实机起服验证**，别只信本文。

## 2. 官方来源（只从这里下，别用网盘/转载站）

| 来源 | 地址 | 用途 |
|---|---|---|
| EngineHub 官网（项目页） | https://enginehub.org/worldguard | 官方项目页；Bukkit 下载入口指向 Dev Bukkit / CurseForge |
| 官方文档 | https://worldguard.enginehub.org/en/latest/ | 安装/配置/区域/flag/命令 |
| Modrinth | https://modrinth.com/plugin/worldguard · https://modrinth.com/plugin/worldedit | 版本↔MC 对应表、文件校验值 |
| GitHub | https://github.com/EngineHub/WorldGuard | 变更记录、issue |
| 官方构建站（experimental） | https://builds.enginehub.org/job/worldguard | 只在追 bug 时用，日常别用 beta |

**WorldGuard 必须装 WorldEdit**（官网原文："WorldGuard requires that WorldEdit is installed"）。
两个 jar 都放 `server/plugins/` 扁平目录，不要放子目录。

### 文件校验值（SHA-512，来自 Modrinth 版本元数据）

下载后先校验再放进去，防止装到被改过的 jar：

| 文件 | 版本 | SHA-512 |
|---|---|---|
| `worldguard-bukkit-7.0.14-dist.jar` | 7.0.14 | `2d0f513d3c78a51fe840c33bec5f7be98091a41e38cad86d2a0dc341e01b00cd427ecaa6372b42925a9dae4f058f6b40240e23f217030f81e07b299978c02347` |
| `worldedit-bukkit-7.3.16.jar` | 7.3.16 | `079cbf54518b996bb3cac41d102477c88defa14b8c45598829dce9589846b2d63c9e76c49c44a25425a6bb295895b8433c5f70a07d6a2abf83c5932fe3578a5c` |

```powershell
# 校验（在下载目录执行；输出要和上表逐字相等）
Get-FileHash .\worldguard-bukkit-7.0.14-dist.jar -Algorithm SHA512 | Format-List
Get-FileHash .\worldedit-bukkit-7.3.16.jar     -Algorithm SHA512 | Format-List
```

> 上表是抓取当时的元数据快照。隔了很久才装的话，**去 Modrinth/GitHub 页面重新抄一遍校验值**，
> 不要用本文的旧值硬比 —— 那会把「文件被人换过」误判成「我下错了」。

## 3. 安装步骤（本仓库的规矩）

1. **先停服**：`powershell -File scripts\stop-panel.ps1`（走 RCON 优雅关服，别直接关窗口 —— 会丢存档）。
2. 把两个 jar 放进 `server/plugins/`：
   - `worldguard-bukkit-7.0.14-dist.jar`
   - `worldedit-bukkit-7.3.16.jar`
3. **只放一份**：同一插件多个 jar 会出现「两个版本互相顶掉、只有一个被加载」的假象。
4. 起服：`powershell -File scripts\start-panel.ps1`。
5. 首次启动 WorldGuard 会自己生成 `server/plugins/WorldGuard/`（`config.yml`、`worlds/<世界>/regions.yml`）。
   生成完再动配置，**不要在它生成之前手写这些文件**。

> 本任务不下载 jar、不起服：以上步骤由人工执行。装之前可以先跑
> `powershell -File scripts\worldguard-check.ps1` —— 未安装时它会明确说「未安装」并 exit 0。

## 4. 装完怎么验（三条都要过）

### 4.1 游戏内：`/wg version`

```
/wg version
```

期望输出：`WorldGuard 7.0.14` + WorldEdit 版本号。若提示命令不存在 ⇒ 插件没被加载，去看 4.2 的日志。
其它可用的确认命令（都需要 op / `worldguard.*` 权限，本服目前只有 `HEAVENZEH` 是 op）：

```
/wg report      # 生成 plugins/WorldGuard/report.txt：插件清单+世界设置+WG 配置，排查用
/rg list        # 列出已定义区域（没建过就是空的，正常）
```

### 4.2 启动日志：必须能看到插件加载，且不能有错误

```powershell
# 只看 WorldGuard / WorldEdit 相关行
Select-String -Path server\logs\latest.log -Pattern 'WorldGuard|WorldEdit' | Select-Object -Last 30
```

**必须看到**：

```
[... INFO]: [WorldGuard] Loading server plugin WorldGuard v7.0.14
[... INFO]: [WorldEdit] Loading server plugin WorldEdit v7.3.16
[... INFO]: [WorldGuard] Enabling WorldGuard v7.0.14
```

**出现以下任一条 = 没装成，先修再谈区域**：

| 日志字样 | 含义 | 处理 |
|---|---|---|
| `Unknown/missing dependency: WorldEdit` | 没装 WorldEdit 或版本不兼容 | 按 §1 配对重下 |
| `UnsupportedClassVersionError` | Java 版本太低（Paper 1.21.8 需要 Java 21） | 换 Java 21 |
| `NoSuchMethodError` / `NoClassDefFoundError` | WG/WE 版本与 1.21.8 不匹配 | 回 §1 配对 |
| `Could not load ... worldguard` | jar 损坏 | 重下 + 校验 SHA-512 |
| 启动后 `/wg` 无此命令 | jar 放错目录 / 有两个 WG jar | 见 §3.3 |

### 4.3 仓库侧：只读体检脚本

```powershell
powershell -ExecutionPolicy Bypass -File scripts\worldguard-check.ps1
```

它做**只读**检查（不改任何文件、不起服）：jar 在不在、版本与 1.21.8 配不配、WorldEdit 依赖、
配置能不能解析、区域草案还有没有没填的占位符、区域成员与白名单是否矛盾。
`exit 0` = 没发现问题（含「未安装」）；`exit 1` = 有硬矛盾（例如装了 7.0.15 配 1.21.8）。

## 5. 装完之后的下一步

1. 按 `config/worldguard-regions.yml` 的说明实地取坐标，逐条 `/rg define` 建区
   （命令清单一节在 `docs/audit-r6/fixes4/worldguard.md`）。
2. 区域成员必须来自 `server/whitelist.json`，否则人进不来、成员关系无效。
3. 别把 WorldGuard 当唯一的账：它只管「谁能动箱子」，**不记账**；共享仓的真相在 `team_chest` 表，
   事后追溯靠 CoreProtect。三者分工见 `docs/audit-r6/fixes4/worldguard.md`。
4. `online-mode=false` 下名字可被顶替，区域成员与白名单都**不是身份证明** —— 同一份文档里写清了这点，
   别在真机上把它当访问控制来承诺。
