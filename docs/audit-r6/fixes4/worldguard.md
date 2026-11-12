# WorldGuard 事前区域限制：三件套分工与离线模式局限

> R6 / fixes4 · D5（区域限制三件套）· 2026-11-12
> 配套交付：`server/plugins/WorldGuard/README-安装.md`（怎么装、装哪个版本）、
> `config/worldguard-regions.yml`（区域草案，坐标待填）、`scripts/worldguard-check.ps1`（只读体检）。

## 0. 一句话结论

三件套不是"三重保险"，而是**三个不同时刻、回答三个不同问题**的东西：

| 层 | 时刻 | 回答的问题 | 当前状态 |
|---|---|---|---|
| **WorldGuard**（事前） | 动手的**那一刻** | 「你这只手能不能碰到这个方块/箱子」 | **未安装**（只有文档与草案） |
| **CoreProtect**（事后） | 事后**回查** | 「这是谁干的、能不能撤销」 | 已装（CE-24.1），`block-place/block-break` 记录开着 |
| **白名单**（准入） | **连进来的那一刻** | 「这个身份允不允许上线」 | 已开（`white-list=true`、`enforce-whitelist=true`，16 人） |

**缺任何一层，另外两层都补不上**（见 §2 的盲区表）。当前缺口是"事前"这一层，
所以现在的真实能力是：**能查到、能回滚、能限制谁能进服，但拦不住已经在服里的人动手**。

## 1. 三件套各自的能力边界

### 1.1 WorldGuard（事前拦截）

能：按区域拒绝建造/破坏/开箱/交互、按区域禁 PvP/TNT/火焰蔓延/生物生成、拒绝非成员进入私区。

不能：
- **不记账**。它只做 allow/deny，不知道"谁从共享仓拿走了 3 个钻石"。库存真相在板库
  `team_chest(world_id, team_id, x, y, z)`（ADR-0001），WorldGuard 与那张表**必须逐格对齐**，
  否则会出现「WG 放行、账本不记」的黑洞。
- **不区分玩家与机器**。`block-break: deny` 连活塞一起挡（官方文档明说保护类 flag 不是"玩家专属"）。
  所以正确的做法是**用成员资格**，不是堆保护 flag —— 草案里几乎没有 `build: deny` 就是这个原因。
- **挡不住 op**。`/rg bypass` 一开，区域保护对本人失效（`ops.json` 里 `HEAVENZEH` 是 level 4）。这是设计，不是漏洞。
- **不校验物品真伪**。刷物品、假箱子、数量不符都归账本 + CoreProtect，不归 WG。

### 1.2 CoreProtect（事后取证与回滚）

能：回查某方块/容器在什么时间被谁改成什么，按半径/时间回滚（`/co rollback`），作为纠纷证据。

不能：
- **不能阻止**。它永远是"已经发生了"。
- 容器内容层面的"谁拿走了什么"依赖它自己的记录口径，与队伍账本是**两套账**，不能互相当真。
- 回滚是**破坏性操作**，用错半径/时间会把正常建设一起抹掉。

### 1.3 白名单（准入）

能：只让 `whitelist.json` 里的身份上线（`enforce-whitelist=true` 时连已在服的人被移出也会被踢）。

不能：
- **不是身份证明**。见 §3 —— `online-mode=false` 下白名单只是"名字清单"。
- 不限制白名单内的人做什么（那正是 WorldGuard 的活）。

## 2. 为什么三层都要：盲区对照

| 场景 | 白名单 | WorldGuard | CoreProtect |
|---|---|---|---|
| 陌生人连进来搞破坏 | ✅ 挡住 | — | — |
| 白名单内的人拆别人房子 | ❌ | ✅ 事前挡住 | ✅ 事后可回滚 |
| 白名单内的人从共享仓顺走东西 | ❌ | ✅ 只能挡住"开箱"，不记数量 | ✅ 可回查 |
| 活塞/TNT 把建筑推进保护区 | ❌ | ✅ | ✅ |
| op 自己手滑拆了东西 | ❌ | ❌（bypass） | ✅ |
| 刷物品 / 数量对不上 | ❌ | ❌ | ⚠️ 只能看方块事件 |
| 事后追责"是谁" | — | — | ✅（但身份可信度见 §3） |

结论：**"事前"这一层现在是空的**，上表第 2、3、4 行目前只能靠事后回滚兜底 —— 而回滚不是每次都能全额还原。

## 3. `online-mode=false` 下的局限（这是本项目的硬约束，必须写清）

实测事实（`scripts/worldguard-check.ps1` 每次都会复读）：`server.properties` 里
`online-mode=false`，`whitelist.json` 的 **16/16 个 UUID 都是离线派生 v3**（形如
`3f680b9f-53a9-34c1-…`，第 13 位十六进制是 `3`）。

这意味着：

1. **用户名由客户端自报**。服务端不做 Mojang 校验，谁都可以把客户端名字设成 `HEAVENZEH`。
2. **UUID 是 MD5("OfflinePlayer:" + 名字) 派生的**，名字一样 UUID 就一样。于是：
   - 白名单挡的是"这个名字"，不是"这个人"；
   - WorldGuard 的区域成员按 UUID 记（`unique-ids`），而离线 UUID 与名字一一对应 ⇒
     **任何人用成员的名字登录，就自动成为该区域成员**（能进私区、能开共享仓）；
   - CoreProtect 的 user 归属同样基于离线 UUID ⇒ 事后追溯的"是谁"只能定位到"用了这个名字的某个客户端"。
3. 因此三件套在当前离线模式下的**真实语义**是：

   > **防手滑、防误操作、可回滚** —— 不是"防恶意攻击"。

   恶意玩家只要知道一个白名单名字，就能绕过"准入"这一层；进去之后 WorldGuard 会因为
   名字撞上成员而**放行**。这不是配置能修的，是 `online-mode=false` 的固有结果。

4. **要真正解决只有两条路**（都超出本任务范围，属 D 系列决策）：
   - 改 `online-mode=true`（会改变现有 bot/客户端的接入方式，需要单独评估与实测）；
   - 或者在前面加一个**真正的鉴权代理**（如带 auth 的 Velocity/BungeeCord），
     让后端只接受代理转发的已鉴权连接。
   
   在那之前，**不要在对外文档/承诺里把白名单与区域成员说成"访问控制"**。

## 4. 落地顺序（WorldGuard 装好之后）

本文只给流程与判据；**具体命令语法以服务器里 `/rg help` 的输出为准**
（本轮为只读准备，未联网核对 `regions/commands` 文档页，故不逐字抄命令以免写错参数位置）。

1. **装**：按 `server/plugins/WorldGuard/README-安装.md` 装 7.0.14 + WorldEdit 7.3.16，`/wg version` 验证。
2. **体检基线**：`powershell -ExecutionPolicy Bypass -File scripts\worldguard-check.ps1` → 应 exit 0。
3. **取坐标**：按 `config/worldguard-regions.yml` 顶部说明，实地 F3 取两个角点，填掉 21 处占位符。
4. **建区**：用 WorldEdit 选区（`//wand` 左右键取两角）→ `/rg define <id>`；再逐个
   `/rg addmember <id> <玩家名>` 和 `/rg flag <id> <flag> <value>`（草案里每个 flag 都写了理由）。
5. **核对**：`/rg list` 看区域名，`/rg info <id>` 看 flags 与成员；再跑一次体检脚本，
   此时第 3 节应变成「区域数据可解析 + 规格无错 + 成员都在白名单」。
6. **共享仓对齐**：`team_chest` 表里登记的坐标必须与 `team_chest_*` 区域的包围盒一致；
   改一处就要改另一处，否则账本与保护面错位。
7. **验证纵深**：故意用非成员账号试开一次共享仓（应被拒），并确认 CoreProtect 有记录。

## 5. 体检脚本：能查出什么、查不出什么

`scripts/worldguard-check.ps1` 是**只读**的（不写文件、不起服、不连 RCON），退出码：
`0` = 无硬矛盾（**含「未安装」**，未安装是待办不是失败）；`1` = 有硬矛盾。

查得出（每条都有负向样本验证过，见 §6）：
- jar 在不在 / 是不是**两个版本并存**（会互相顶掉）
- 版本与 1.21.8 配不配（内置 Modrinth 2026-11 快照表）
- **WorldEdit 7.4.x 配 WorldGuard 7.0.14 的错配**（7.4.x 要求 WG 7.0.15+，而 1.21.8 只能用 7.0.14）
- `config.yml` / `regions.yml` 能否解析（自带块风格 YAML 解析器，TAB 缩进、重复键都报）
- 区域规格：`min > max`、`type` 缺失、`priority` 非整数、**flag 拼写错误**、状态型 flag 值非法、
  **`chest-access: allow` 的 `everyone` 陷阱**
- 成员与白名单矛盾：名字不在白名单、UUID 不在白名单、用了 `groups` 但本服没有权限插件
- `online-mode` 与 UUID 版本自相矛盾（`online-mode=true` 却有 v3 UUID）
- 准入开关自洽性、有没有人能管区域（`ops.json` 等级 / 权限插件）

查不出：
- 区域坐标是否**合理**（围错地方它不知道）
- 容器清单与 `team_chest` 表是否真的一致（要连板库，属阶段 3 的对账）
- 运行时行为（flag 是否真的生效）—— 需要起服 + 实测，本任务明确不做

## 6. 防假修复：负向样本

体检脚本第一版有两个**假绿灯**，是拿坏样本喂出来的，记录在此以免回退：

| 假绿灯 | 现象 | 修法 |
|---|---|---|
| 线上 `regions.yml` 只查"能否解析" | `min>max`、`pvp: maybe`、`bulid` 错拼、`chest-access: allow` 全放过，还打印"成员与白名单一致" | 抽出 `Test-RegionSpec`，草案与线上文件共用同一套判据 |
| `Get-MapValue` 返回集合被管道展开 | 单元素 `players` 变成字符串、空 `players` 变成 `$null` ⇒ 成员检查整段失效 | `Write-Output -NoEnumerate` |

另外两处踩坑（都属"看起来对、其实错"）：
- `$whiteList` 与 `$whitelist` 在 PowerShell 里**是同一个变量**（大小写不敏感）⇒
  `white-list=true` 被白名单数组覆盖，输出成 `white-list=false`。已改名 `$whiteListProp`。
- `@(Read-JsonList ...)` 会**再包一层**，16 条白名单被读成 1 条 ⇒ v3 统计失真。已改裸赋值 + 空保护。

回归方式：造一个坏样本目录（两个 WG jar、WE 7.4.6、`online-mode=true` + v3 UUID、
`regions.yml` 里 `min>max`/`pvp: maybe`/`bulid`/`chest-access: allow`/`ghost_player`），
`-ServerDir <fixture>` 应报 **10 个 FAIL、exit 1**；真实环境应 **exit 0 + 「未安装」**。

## 7. 边界（本轮明确没做）

- **没下载任何 jar**、**没改 `server/` 下任何运行态文件**、**没起服**。
- `server/plugins/WorldGuard/README-安装.md` 是**文档**，不是插件；体检脚本靠"有没有
  `worldguard*.jar`"判定安装状态，不会被这个文档目录骗成"已安装"。
- 区域坐标一个都没有编造：`config/worldguard-regions.yml` 里全是 `__FILL_ME__` /
  `__PLAYER_NAME__` / `__TEAM_MEMBER__` 占位符，填法写在文件头。
- 版本表与 SHA-512 是 Modrinth API 的**抓取快照**（2026-11-12）；装之前应回官方页面复核。
