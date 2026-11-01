# 横切：数据、事件、配置、安全、测试、版本

> 2026-11-01 新增。各层都要遵守、但不属于哪一层的规矩。
> `ARCHITECTURE_REDESIGN.md` 原计划的 §7 配置在这里（§3）；测试分层和排期仍以 `ARCHITECTURE_REDESIGN_PART2.md` 为准，这里只补它没写到的。

## 1. 数据归谁

| 数据 | 在哪 | 谁写 | 谁读 |
|---|---|---|---|
| 3D 地形 | `bots/<名字>/map/terrain3d.db`（`node:sqlite`） | `scanSphere`、.mca 导入、`recordFail` | 规划器、落点检查、`!map` |
| 长期记忆 | `bots/<名字>/memory/*.json`，按域分文件（箱子、地标、危险点…，`memory_store.js`） | 记忆类命令和流程 | 提示词、流程 |
| 对话历史、自提示状态 | 上游的存档（`agent.js` 启动时读 `save_data`） | 上游 | 上游 |
| 任务板 | `bots/_board/board.sqlite`（计划，06 §3） | **只有 mindserver** | 各 agent 经 socket（06 §14） |
| 运行轨迹 | `trace_bus` 内存环形缓冲 | 各层 `onEvent` | 诊断面板（`get-events`） |
| MC 规则 | `src/agent/rules/`（`rules.runtime.js` 读） | 人 | 各层 |
| 配置 | `settings.js`、`profiles/*.json`、`src/mindcraft/public/settings_spec.json` | 人 / 面板 | 进程启动时 |
| 世界存档、`server.properties` | `server/`（Paper，不在本仓库） | 服务端 | — |

- 一份数据只有一个写入方；跨进程共享只经 mindserver（任务板）
- 改结构要带版本号和迁移（先例：`memory_store.migrateFromLegacyLandmarks`、`tools/verify_memory_version.mjs`）
- B4 把地标、危险点、箱子内容搬进任务板库后，`memory/*.json` 里对应的域只读（06 §9.3）

## 2. 事件

现在 `trace_bus.collectSilent(e)` 收任意对象，`type` 各写各的。规矩：

| 字段 | 要求 |
|---|---|
| `type` | 必填，小写加连字符（`unsafe-landing`、`landing-check-error`、`walk-already-there`） |
| `jobId` / `skill` | 在任务单里跑时由 `ctx.onEvent` 自动带上（04 §4.6） |
| 其余 | 平铺，只放数字和短字符串，不超过 10 个 |

**trace_bus 只在最外层写一次。** 现在 `walkTo` 和 `execStep` 各包了一层 `tracePush`，`walkTo` 又把自己那层传给 `execStep`，于是 `execStep` 发的每个事件记两次（D10 的根因）。
改成：只有 `ctx.onEvent`（没有任务单时由 `nav_core` 入口）写 trace_bus，里面各层只调传进来的 `onEvent`。

| 级别 | 放什么 | 去哪 |
|---|---|---|
| trace | 每一步、每个原子 | 只进 trace_bus |
| info | 流程开始 / 结束 / 结果 | trace_bus + 控制台 |
| warn | 降级、绕路、重试 | 同上 |
| error | 返回 `fail` 且没被 `onFail` 接住 | 同上，并写进任务单 `result` |

## 3. 配置放哪

| 放什么 | 放哪 | 例 |
|---|---|---|
| MC 机制事实（要有出处） | `src/agent/rules/` | 眼高、挖掘距离（`EYE_HEIGHT`、`digReach`）、矿种目标高度 |
| 每只 bot 的偏好 | `profiles/*.json` | 模型、`owner` / `trusted`（08 §5）、`roles`（06 §9.4） |
| 进程级 | `settings.js` | 端口、`allow_insecure_coding` |
| 流程自己的可调值 | 流程文件顶部的命名常量，或 manifest 的默认值 | 支巷间距、熔炉轮询间隔 |

- 流程里不写裸数字；MC 事实带出处（`legacy/改进规划.md` 第一条约束：规则必须有出处）
- `settings.js` / profile 新加 key 要同步进 `settings_spec.json`：面板创建或编辑 agent 时会删掉 spec 里没有的 key（`mindserver.js` 的 `create-agent`），D23 就是这么来的

## 4. 安全

| 入口 | 风险 | 现状 | 怎么补 |
|---|---|---|---|
| 浏览器网页 → mindserver socket | 冒充面板发 `create-agent` / `send-message` / `shutdown` | ✅ `local_only.js`（`b1793d9`） | — |
| 同一局域网 → MC 服务器 | 离线模式下冒用 op 的名字进服（第一轮：监听所有网卡，ops 里 341 个名字） | 待你定 | `server-ip=127.0.0.1`；或开正版验证（离线模式下白名单挡不住冒名） |
| 同一局域网 → RCON | 默认密码写死在 `rcon_client.js` 和几个 tools 脚本里，已推到 GitHub | 待做 | 只绑本机（同上）；换密码；客户端从 `server.properties` 读（`proc_control.js` 已经这样读） |
| 游戏里任何玩家 → bot | 诱导她写代码执行、发斜杠命令（她是 op） | ❌ | 08 §5 分级，按发言人过滤 |
| 模型回复 → 聊天 | 回复以 `/` 开头会被当成命令执行 | ❌ `agent.js:507` 直接 `bot.chat` | `openChat` 拦 `/` 开头 |
| `!newAction` 生成的代码 | 跑在 SES 沙箱里，但拿得到 `bot`，游戏里能做的都能做 | 设计如此 | 只给主人；不用时关 `allow_insecure_coding` |
| 依赖 | `package-lock.json` 被忽略；patch-package 的补丁按 mineflayer 4.33.0 写，装的是 4.39.0（第一轮） | 待做 | §6 |

密钥（`keys.json`、RCON 密码）不进日志、不进提交，也不在对话里读出来。

## 5. 测试（补 PART2 没写到的）

1. 假 bot 抽成公共夹具 `tools/fixtures/fake_bot.mjs`：现在 `exec_step_y_unit` / `exec_landing_unit` / `test_tunnel` / `atom_stand_unit` 各写一份，bot 接口一改要改四处
2. `npm test` = `unit_all` 去掉要真机数据的；`UNITS` 给这类加 `needsRealData` 标记（现在只有 `verify_y_semantics`，它读真机地图库），默认跳过
3. 真机测试只在测试服 25566 上跑，用 `tools/arena.mjs` 租场地；不碰主服 25565
4. 改 executor / 导航前后都跑逐 action 基线（99/110），看全部场景，不能只看改的那个（`4b4ac1c` 的教训）
5. 新文件命名：离线 `*_unit.mjs`，真机 `*_live.mjs`，基线 `bench_*.mjs`；旧文件不改名

## 6. 版本

| 组件 | 现在 | 规矩 |
|---|---|---|
| Minecraft / Paper | 1.21.8 | 换版本前 `unit_all`、逐 action 基线、真机 `tools/atom_all.mjs` 全过 |
| mineflayer | 4.39.0，补丁按 4.33.0 写 | 升级前确认每个补丁还在生效；补丁文件名带目标版本 |
| Node | v24（`D:\Node\node.exe`） | 任务板用 `node:sqlite`，至少 22.13（不用加 flag） |
| 依赖锁 | `package-lock.json` 被忽略 | 提交它 |
