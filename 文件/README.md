# Mindcraft 本地部署说明

AI 玩家（LLM 驱动）接入 Minecraft 的完整本地环境，**已在本机跑通并验证。**
模型走 LLM Go 中转站（`deepseek-v4.1-flash`）。

---

## 0. 现状：已配置完成，直接启动就行

| 项 | 值 |
|---|---|
| 游戏内 ID | `deepseek` |
| 皮肤 | 自定义皮肤已生效（Paper + SkinsRestorer，见 0c） |
| 模型 | `deepseek-v4.1-flash`（LLM Go 中转） |
| 端点 | `https://api.llmgo.net/v1`（OpenAI 兼容） |
| 服务端 | **Paper 1.21.8**（build 60）+ 5 个插件（见 0d） |
| MC 版本 | **1.21.8** ← 你的客户端必须选这个版本 |
| 配置 | [profiles/llmgo.json](E:\我的世界ai\mindcraft\profiles\llmgo.json) |
| Key | 已写入 [keys.json](E:\我的世界ai\mindcraft\keys.json) 的 `OPENAI_API_KEY`，来源是 CC Switch 里 `LLM Go deepseek` 这个 provider |

**已验证**：bot 进服 → 中文对话 → 被称呼能响应 → 自主调用 `!nearbyBlocks`。

### 改名说明

游戏内名字是 `deepseek`（ASCII）。Minecraft 用户名只允许 `[a-zA-Z0-9_]`、3-16 位，
mindcraft 自己也有同样校验（`connection_handler.js:88`），中文名会被服务端直接踢。

如果想让它"自称"中文名，在 profile 里加 `"display_name": "某名字"`，
prompt 里的 `$NAME` 会用它，但它头顶的 ID 仍然是 ASCII 的 `name`。

---

## 0d. 已装插件与行为配置

### 插件（`server/plugins/`，2026-10-18 装）

| 插件 | 版本 | 作用 | 为什么装 |
|---|---|---|---|
| **SkinsRestorer** | 15.12.6 | 皮肤下发 | 离线服唯一能上皮肤的途径 |
| **CoreProtect** | 24.1 | 方块操作日志/回滚 | AI 乱挖乱建时能撤销 |
| **Chunky** | 1.4.40 | 区块预生成 | 消除探索卡顿 |
| **ChunkyBorder** | 1.2.23 | 世界边界管理 | 配合 Chunky 圈住活动范围 |
| **OnePlayerSleep** | **4.0.1** | 一人睡即过夜 | 只有 1~2 人时不用等全员睡觉 |

⚠️ **OnePlayerSleep 必须用 4.0.1，不能用 4.1.0**
4.1.0 是用 **Java 25** 编译的（class file 69），而本项目用的是便携版 **JDK 21**（只认到 65），
会报 `UnsupportedClassVersionError` 加载失败。4.0.1 是 Java 17 编译的，正常。

### 已做的其它配置

| 项 | 值 | 说明 |
|---|---|---|
| 世界边界 | 1000 格宽 | `worldborder set 1000`，防止 AI 乱跑无限生成区块 |
| 区块预生成 | 半径 150 | 已跑完，世界 10.0 → 12.3 MB |
| bot 的 OP | 等级 4 | 写在 [ops.json](E:\我的世界ai\server\ops.json)，UUID `d44c22a0-5412-38a0-9d92-59e6f0fc81b9` |
| bot 的物资 | 钻石镐/铁镐/斧/铲/剑/食物/火把/木板/工作台/熔炉 | 用 RCON `give` 发放 |

**OP 是必须的**：mindcraft 的建造/传送/刷物品技能全是直接发 `/tp` `/give` `/setblock`，
没有 OP 时这些命令**静默失败**，机器人会以为自己干成了。

### mindcraft 行为配置（`mindcraft/settings.js`）

| 项 | 值 | 原因 |
|---|---|---|
| `show_command_syntax` | `"none"` | **不把 `!collectBlocks(...)` 显示在聊天里**，只显示人话 |
| 对应代码 | `src/agent/agent.js:347` | `"full"` 显示完整命令 / `"shortened"` 显示 `*used xxx*` / 其它只显示命令前的话 |

### 说话风格（`mindcraft/profiles/llmgo.json`）

`conversing` 提示词已改成**可爱型人设**：中文、一到两句、可用「呀/啦/诶嘿/~」和少量颜文字，
并明确要求"命令单独放回复最后、聊天里只留人话"。

`cooldown` 从默认 3000ms 降到 **1200ms**（每轮响应不再强制等 3 秒）。

> 想换风格直接改 `conversing` 这一段即可，占位符（`$NAME` `$STATS` `$INVENTORY`
> `$COMMAND_DOCS` `$EXAMPLES` `$MEMORY` `$SELF_PROMPT`）**必须保留**，否则提示词拼装会缺内容。

### 实测记录

| 项 | 结果 |
|---|---|
| 说话风格 | 「我叫DeepSeek呀~你可以叫我小D，嘿嘿，一起玩吧！」 |
| 命令是否泄漏 | 无。执行时只说「好呀好呀，我去挖铜矿啦，等我回来~」 |
| 能否真挖矿 | 能。挖到 **20 个粗铜**（`/clear ... 0` 计数验证），火把从 64 用到 62，Y 从 67 降到 61 |
| 服务端负载 | TPS 20.0，MSPT 预生成时峰值 16.2ms（预算 50ms） |

---

## 0e. 逻辑修复（2026-10-19）

这一节的改动**不是从代码猜的**，是把 `bots/deepseek/histories/` 里 13 个历史会话
全部扫了一遍、统计出真实失败频率之后定位的。

| 失败模式 | 日志中出现次数 |
|---|---|
| 被推着跑（`Moved away from`） | 24 |
| 缺工具 / 找不到箱子 | 18 |
| 卡死（`Got stuck`） | 17 |
| 路径找不到（`Path not found`） | 14 |
| 代码异常 | 8 |

### 修了哪 5 处

| # | 文件 | 问题 | 修法 |
|---|---|---|---|
| 1 | `commands/actions.js` | **丢东西选错命令**：拿 `!discard`（扔垃圾）去交接物品，它会"先跑开5格→在那里丢→再走回来"，物品落在坡上、甚至往上飘 5 格，玩家永远捡不到 | 改清楚两个命令的说明：`!discard` 标明"扔垃圾，不用于交付"；`!givePlayer` 标明"交付物品一律用这个" |
| 2 | `library/skills.js` | `bot.players[username].entity` 在玩家不在线时抛 `Cannot read properties of undefined`（3 处） | 三处全加空值守卫 |
| 3 | `agent/modes.js` | 脱困失败 10 秒后 **`cleanKill` 直接杀掉 bot 进程**（日志里 17 次） | 改成 15 秒软超时，超时就放弃这次脱困、继续玩，绝不退出进程 |
| 4 | `agent/mindserver_proxy.js` | 与 MindServer 的 socket **一断就杀进程**，但 socket.io 本身会自动重连 —— 一次瞬断（ping 超时）bot 就说 "Exiting." 下线 | 改为 30 秒重连窗口，重连成功后自动重新注册（`get-settings` → `connect-agent-process` → `login-agent`） |
| 5 | `server/server.properties` | `pause-when-empty-seconds=60`：空服 60 秒后 Paper 暂停，导致下次 bot 进服要等 40 秒 | 改为 `0`（永不暂停），进服时间 40 秒 → **10~18 秒** |

### 为什么不能用"原地丢"

试过把 `!discard` 改成原地丢 + 暂停自动捡拾，实测**失败**：

```
Discarded 5 oak_planks.        ← 确实执行了
背包木板: 96 → 96              ← 又变回96
```

因为 `item_collecting` 模式会立刻把她自己丢的东西吸回去（原作者用"跑开5格"就是防这个）。
所以正确的做法不是改 `!discard`，而是**让她在交接物品时选对命令** —— 见第 1 条。

### 验证结果

| 场景 | 结果 |
|---|---|
| 玩家说「给我5个木板」 | 她选 `!givePlayer("HEAVENZEH", "oak_planks", 5)` ✔（改之前会用 `!discard`） |
| 玩家不在附近 | 正确回应「没找到你诶，你现在在哪个位置呀？」✔ |
| 静置 60 秒 | 无掉线 ✔ |
| 服务端负载 | TPS 20.0 ✔ |

### 注意：`!givePlayer` 才是交接物品的正确方式

它的完整逻辑（`skills.js:giveToPlayer`）比 `!discard` 靠谱得多：

1. 走到玩家身边 3 格内
2. 如果少于 2 格，先退开到 5 格（防止自己捡回）
3. **转向玩家** 再丢（所以物品会朝玩家飞）
4. 监听 `playerCollect` 事件，**确认对方真的收到了**才返回成功

---

## 0f. 「AI 不能调用工具」的真正原因（2026-10-19 下午）

症状：AI 看起来完全不动了，所有指令都没反应，日志里刷满
`waiting for code to finish executing...`，然后 bot 突然说 `Exiting.` 消失并重启。

### 根因：一个永不返回的 Promise 把动作队列锁死了

```
action "action:digDown" trying to interrupt current action "mode:item_collecting"
waiting for code to finish executing...   ← 刷了 78 次
Agent process exited with code 1          ← 最后被杀
```

完整链条：

1. `item_collecting`（自动捡掉落物）模式被触发
2. 它调用 `skills.pickupNearbyItems()`，里面是
   `await goToGoal(bot, new pf.goals.GoalFollow(物品实体, 1))`
3. 物品如果卡在墙里/岩浆里/不可达位置，`GoalFollow` 是**动态目标**，
   pathfinder 会不停"重置路径 → 再试"（stderr 里刷的
   `PathStopped ... at resetPath (index.js:657)` 就是它）
4. `bot.pathfinder.goto()` **没有任何超时**，这个 await 永远不会返回
5. 动作管理器的 `executing` 永远是 `true`
6. 之后每条新命令进来都要先 `await this.stop()` 等它结束 → 全部堵死
7. 10 秒看门狗超时 → `cleanKill` 杀掉进程 → agent 重启 → 记忆重载 → 玩家看到"她消失又回来"

**所以不是模型不会调用工具，是工具调用了但卡在执行里出不来。**

### 修了哪 3 处

| # | 文件 | 修法 |
|---|---|---|
| 1 | `library/skills.js` `goToGoal()` | 给 `bot.pathfinder.goto()` 加 **180 秒硬上限**：超时就 `pathfinder.stop()` 并抛错，让上层正常收尾。这是全局兜底，9 个调用点全受益 |
| 2 | `library/skills.js` `pickupNearbyItems()` | 单个掉落物最多追 **8 秒**，追不到就放弃并停止寻路，避免在不可达物品上无限重试 |
| 3 | `agent/action_manager.js` `stop()` | 10 秒后**不再 cleanKill 杀进程**，改为强制复位动作状态（停止寻路、`executing=false`、取消恢复）。卡住时只放弃这一个动作，bot 不重启 |

### 验证结果

| 测试 | 结果 |
|---|---|
| 连续 3 个查询类指令 | 全部执行，`!nearbyBlocks` / `!stats` / `!inventory` 均返回真实数据 ✔ |
| 连续 4 个移动类指令 | `!goToCoordinates` / `!searchForBlock` / `!moveAway` / `!nearbyBlocks` 全部执行 ✔ |
| 卡死刷屏 | 0 次 ✔ |
| Agent 崩溃重启 | 0 次 ✔ |
| 掉线 | 0 次 ✔ |

### 附带发现

- `Server empty for 60 seconds, pausing`（0e 第 5 条）会让 bot 进服被延迟 30~40 秒，
  已改为 `pause-when-empty-seconds=0`，现在进服 **8~18 秒**。
- 用 RCON `say` 可以直接和 bot 对话（她会当成聊天消息处理），
  这是不开游戏客户端也能测她行为的最省事办法。

---

## 0c. 皮肤（自定义皮肤怎么上的）

**原版服务端做不到**：皮肤是绑定 Mojang 账号的，离线服务器无从下发。
所以换了 **Paper** 服务端 + **SkinsRestorer** 插件（Standalone 模式）。

当前皮肤：`C:\Users\zeh\Desktop\f77909a718c69fb8.png`（64×64，**classic/史蒂夫 4px 手臂**）

### 换皮肤怎么做

1. 把 PNG 传到 MineSkin 拿到签名贴图（必须指定 `variant=classic` 或 `slim`，
   MineSkin 自动检测会误判成 slim，导致手臂变细）：

```bash
curl -F "file=@你的皮肤.png" -F "variant=classic" https://api.mineskin.org/generate/upload
```

2. 停服，把返回的 `value` / `signature` 写进
   `plugins/SkinsRestorer/skins/<id>.playerskin`（覆盖已有的 `lastKnownName: "Deepseek"` 那条），
   然后把 `plugins/SkinsRestorer/players/<离线UUID>.player` 的 `skinIdentifier` 指向它
3. 起服 → bot 进服 → 验证

离线 UUID = `md5("OfflinePlayer:" + 名字)` 加 v3 版本位。
`deepseek` → `d44c22a0-5412-38a0-9d92-59e6f0fc81b9`

### 验证方法（不用看客户端）

用一个探针 bot 连服，抓原始 `player_info` 包，看 `properties` 里的 textures：

```js
bot._client.on('player_info', (p) => {
  for (const e of (p.data || [])) {
    const props = e.player?.properties || [];
    for (const pr of props) {
      const j = JSON.parse(Buffer.from(pr.value, 'base64').toString());
      console.log(e.player.name, j.textures.SKIN.url);
    }
  }
});
```

贴图 URL 末尾的 hash 就是皮肤 PNG 的 sha256，可以跟本地文件对比确认。

### 坑

- 插件会**每次进服按名字去 Mojang 重新拉皮肤**，把手工写的映射冲掉。
  必须设 `disallowAutoUpdateSkin: true`（已设）
- **`noConnections` 不要开！** 开了之后插件连"应用已缓存皮肤"这一步也跳过，
  皮肤会完全不显示（实测 `player_info` 里 `props=0`）。保持 `false`
- 玩家映射文件在进服时会被写成空（没有 `skinIdentifier`），这不影响生效 ——
  实际生效的是按名字命中的 `skins/*.playerskin`
- `sr reload` 是从内存重载，会把磁盘上的改动**回滚**。
  改文件必须**停服 → 改 → 起服**
- PS 5.1 的 `Set-Content -Encoding utf8` 会给 `config.yml` 加 BOM，改完记得去掉

### 已知风险：Mojang 被墙会导致进服卡住

这台机器连 `api.minecraftservices.com` / `sessionserver.mojang.com` 是不通的
（`SSLHandshakeException: Remote host terminated the handshake`，GFW）。

后果：**如果插件缓存里没有某个玩家的皮肤记录，该玩家进服时会卡在登录阶段**去现拉，
表现为日志只有 `UUID of player XXX is ...` 却迟迟没有 `joined the game`，
客户端一直卡在"正在加入服务器"。

实测耗时：

| 情况 | 进服耗时 |
|---|---|
| 皮肤已在缓存里 | ~0.3s |
| 缓存里没有（要现拉） | ~7s（网络偶尔侥幸通）/ 可能一直挂着 |

**应对**：如果某人进不去，先看日志有没有 `joined the game`。
没有就是卡在这一步 —— 让他重试（有时网络侥幸通），
或者临时把 `noConnections` 设为 `true` 让他先进来（代价是所有人皮肤暂时不显示）。

---

## 0b. 怎么进这个服

这是**独立服务端**（不是游戏里"对局域网开放"的那种房间），一直在 `25565` 端口跑。

### 同一台电脑玩

1. 启动器里选版本 **1.21.8**（必须一致，版本不对连不上）
2. 多人游戏 → 直接连接 → 地址填 `localhost`
3. 用户名随便填（服务端是离线模式，不需要正版账号）
4. 进服后聊天框输入 `deepseek 你好`

### 局域网其他设备（手机/另一台电脑）玩

1. 本机 IP（看你在哪个网络）：
   - 以太网 `192.168.31.100`
   - WLAN `192.168.1.17`
   设备要跟电脑连同一个路由器/WiFi，用对应网段那个 IP
2. 地址填 `192.168.31.100:25565`（或 `192.168.1.17:25565`）
3. **需要放行防火墙**（当前没有 25565 规则，默认会被挡）。管理员 PowerShell 执行：

```powershell
New-NetFirewallRule -DisplayName "Minecraft 25565" -Direction Inbound -Protocol TCP -LocalPort 25565 -Action Allow -Profile Private
```

> 别把 25565 暴露到公网。这是离线模式，任何人都能冒名进服。

---

## 1. 换 Key / 换模型

改 [profiles/llmgo.json](E:\我的世界ai\mindcraft\profiles\llmgo.json)：

```json
{
    "name": "deepseek",
    "api": "openai",
    "model": "deepseek-v4.1-flash",
    "url": "https://api.llmgo.net/v1"
}
```

这个 Key 目前可用模型只有两个（`GET /v1/models` 实测）：

- `deepseek-v4.1-flash` ← 当前用的，约 1.8s，适合 agent 高频调用
- `deepseek-v4-pro` —— 更强但慢（约 2.7s）

---

## 2. 启动

双击 [start.bat](E:\我的世界ai\start.bat)。它会：

1. 用便携版 JDK 21 启动 MC 1.21.8 服务端（离线模式，端口 25565）
2. 等 25 秒后启动 Mindcraft

Web 控制台会自动打开：**http://localhost:8080**

也可以手动分开启动：

```powershell
# 服务端
cd E:\我的世界ai\server
E:\我的世界ai\.tools\jdk-21.0.12.1+1\bin\java.exe -Xms1G -Xmx2G -jar server.jar nogui

# AI 玩家
cd E:\我的世界ai\mindcraft
D:\Node\node.exe main.js
```

## 3. 怎么玩

进游戏连 `localhost` 服务器（离线模式，用户名随便填），然后在聊天框输入：

| 输入 | 作用 |
|---|---|
| `deepseek hello` | 让 bot 说话（前缀是 bot 名字） |
| `deepseek 你周围有什么方块` | 自然语言下任务，它会自己调命令 |
| `!nearbyBlocks` | 直接看周围有哪些方块 |
| `!inventory` | 看背包 |
| `!stats` | 看生命/饥饿 |

Web 控制台里也能直接对话、切 Agent 模式、看任务队列。

---

## 4. 换中转站 / 第三方 API

**可以。** profile 里的 `url` 会被当 OpenAI SDK 的 `baseURL` 用，任何 **OpenAI 兼容**的中转站都能接。

> ⚠️ **重要前提**：原版 mindcraft 有个缺陷 —— `src/models/prompter.js` 只把 `profile.model`
> （字符串）传给 `selectAPI()`，导致 profile 里的 `api` / `url` 被静默丢弃，变成按模型名前缀硬猜。
> 模型名以 `deepseek` 开头就一定会打到 `api.deepseek.com`，中转站配了也不生效。
> **本项目已修复**（新增 `pickModelConfig()`，并把 `embedding` 缺省值改为 `null`）。
> 重新 clone 仓库的话必须重新打这个补丁，否则中转配置无效。

### 换成别家中转

改 [profiles/llmgo.json](E:\我的世界ai\mindcraft\profiles\llmgo.json)：

```json
{
    "name": "llmgo",
    "api": "openai",
    "model": "换成中转站的模型 ID",
    "url": "https://中转站域名/v1"
}
```

`api` 可选 `openai` / `anthropic` / `google` / `qwen` / `mistral` / `xai`，
取决于中转站实际转发的是哪家。key 统一填 `keys.json` 里的 `OPENAI_API_KEY`（`api` 为 `openai` 时）。

### 已验证 / 注意

- ✅ `url` 正确注入 baseURL，实测走通 LLM Go（`deepseek-v4.1-flash`）
- ✅ LLM Go 的 `stop: "***"` 参数正常，返回干净不带残留
- ⚠️ `url` 要不要带 `/v1`：看中转站文档。LLM Go 要带；DeepSeek 官方两种都行
- ⚠️ 个别中转站不认 `stop` 参数会报 400，用 profile 的 `params` 覆盖（如 `"params": {"stop": null}`）
- ⚠️ 多数中转站不支持 embedding → 本项目已置空，自动用词重叠匹配
- ⚠️ 中转站常有限流。自主模式调用很频繁，容易 429；建议先对话测试，再开自主模式
- ⚠️ 有些中转站的网页域名和 API 主机名不是同一个（如 LLM Go 的 `pro.llmgo.net` 是文档站，API 是 `api.llmgo.net`），别混用。Key 也按分组开通，换站要重开

---

## 5. 环境说明

| 项 | 值 |
|---|---|
| MC 版本 | 1.21.8 |
| 服务端 | 官方原版 server.jar，离线模式（`online-mode=false`） |
| 难度 | peaceful（调试用，改 `server.properties` 里的 `difficulty`） |
| Node | D:\Node (v24.16.0) |
| JDK | `.tools\jdk-21.0.12.1+1`（便携版，系统没装 Java） |
| 模型 | `deepseek-v4.1-flash`（LLM Go 中转，`profiles/llmgo.json`） |

## 6. 部署时踩的坑（已修复，重装时需要复现）

1. **原生模块 `canvas` 编译不了**
   `prismarine-viewer` 加载时会 `require('canvas')`，而 canvas 需要 C++ 工具链。
   处理：`npm install --ignore-scripts` 跳过编译，并把
   [browser_viewer.js](E:\我的世界ai\mindcraft\src\agent\vision\browser_viewer.js) 和
   [camera.js](E:\我的世界ai\mindcraft\src\agent\vision\camera.js) 的依赖改成惰性加载。
   代价：`render_bot_view` 和 `allow_vision` 用不了（两者本来也用不上）。
   → 想要视觉能力，装 VS Build Tools + Windows SDK 后正常 `npm install` 并把这两个文件还原（`git checkout`）。

2. **patch 打不上**
   `package.json` 的 `^` 把 mineflayer 解析到了 4.39，而 patch 是给 4.33.0 的。
   处理：mineflayer 锁 `4.33.0`。
   `minecraft-data` 反过来不能锁死 3.97.0（会导致 `prismarine-chunk` 报 `Version '26.1' not found`），
   所以保持 `^3.97.0` 升到 3.117.0，并把 `patches/minecraft-data+3.97.0.patch` 改名为 `.disabled`（那只是 1.21.6 一个协议字段的小修正，1.21.8 用不到）。

3. **`prompter.js` 丢弃 profile 的 api/url（最关键的一个）**
   `prompter.js` 原本只传 `this.profile.model` 字符串给 `selectAPI()`，
   于是 `"api": "openai"` 和 `"url"` 被忽略，退回按模型名前缀推断 ——
   模型名 `deepseek-v4.1-flash` 以 `deepseek` 开头，直接被打到 `api.deepseek.com` 并 401。
   处理：[prompter.js](E:\我的世界ai\mindcraft\src\models\prompter.js) 新增 `pickModelConfig()`，
   把 model/api/url/params 一起传给 `selectAPI`（该函数本身对字符串仍向后兼容）。
   同时把无 embedding 配置时的兜底从"复用 chat 的 api"改成 `null`，避免每次启动都去打不支持的接口。

4. **embedding 依赖 OpenAI**
   `profiles/deepseek.json` 原本有 `"embedding": "openai"`，会强行要 `OPENAI_API_KEY`。
   处理：删掉该行；配合上面第 3 条的 `null` 兜底，自动走词重叠匹配。

5. **原版服务端无法给离线账号发皮肤 → 换 Paper**
   `server.jar` 现在是 **Paper 1.21.8 build 60**（原版存为 `server-vanilla-1.21.8.jar`），
   加 `plugins/SkinsRestorer.jar`。存档格式兼容，直接沿用原 `world/`。
   `start.bat` 里的 jar 路径没变，不用改。

6. **`name` 不能是中文**
   Minecraft 用户名限 `[a-zA-Z0-9_]{3,16}`，mindcraft 的 `validateNameFormat` 同样限制。
   中文 ID 实测被踢：`Invalid characters in username`。
   需要中文自称时用 profile 的 `display_name`（prompt 的 `$NAME` 会用它，头顶 ID 不变）。

## 7. 已验证

端到端实测（`deepseek-v4.1-flash` 走 LLM Go，服务端 Paper 1.21.8）：

```
<tester>  llmgo 你好，请报一下你周围有什么方块      ← 早期用 llmgo 这个名字测的
<llmgo>   我看看…… !nearbyBlocks
<llmgo>   周围有草丛、草方块、泥土、沙子、蕨、藤蔓、橡树叶、石头、砂岩、丛林树叶、丛林原木和铜矿。

<probe>   抓 player_info：deepseek 的 textures 属性 = 534c6a5a...（= 本地皮肤 sha256）
```

覆盖到的：

- Paper 1.21.8 启动、离线模式监听 25565、RCON 25575
- mineflayer + 全部 patch 连接进服（bot `deepseek` 成功 spawn）
- Mindcraft 主进程 → MindServer 8080 → 探测服务器 → Agent 创建 → prompt 组装
- LLM Go 中转调用成功（含 `stop: "***"` 参数），中文回复正常
- 自然语言指令 → 自主选择并执行 `!nearbyBlocks` → 正确理解并汇报结果
- SkinsRestorer 皮肤下发（用 `player_info` 抓包核对贴图 hash）

未验证：

- 移动/挖掘/建造等长动作链（`!collectBlocks` 之类）在真实地形上的稳定性
- 自主模式（agent 模式）下的高频调用与限流表现
- 皮肤在客户端里的**实际渲染效果**（只验证了服务器下发的贴图正确）

---

## 0g. 自动选址 + 自动平地（2026-10-19 晚）

### 需求
盖房子时：自动选地址、自动平地，且**平坦地面不得少于 50×50**。

### 新增的三个函数（`src/agent/library/skills.js`）

| 函数 | 作用 |
|---|---|
| `skills.findBuildingSite(bot, size, searchRadius)` | 在 bot 周围扫描候选区域，按"地表高度方差"打分，返回最平的一块地和目标地面高度 `{x,z,y,size,flatness}` |
| `skills.levelGround(bot, x0, z0, size, targetY)` | 把 `size×size` 区域推平到 `targetY`。**≥16×16 自动走 `/fill` 快速模式**（秒级）；小面积走逐格挖填 |
| `skills.prepareBuildingSite(bot, size)` | 上面两步合一，返回可直接喂给 `buildHouse` 的 `{x,z,y,size}` |

这三个已加入 `always_show_skills`，模型必定能看到文档，不用自己瞎写循环。

### 安全性设计（平地不砸建筑）
快速模式**不是**无差别清空，而是按材质逐个 `/fill air replace <材质>`，只清理 `NATURAL_BLOCKS` 白名单里的天然方块（草/土/石/沙/叶/木/矿…）。木板、玻璃、砖、箱子等玩家建筑**不在名单里，永远不会被拆**。
填坑用 `/fill ... keep`，只补空气，不覆盖任何已有方块。

### 实测记录（2026-10-19 19:33–19:47）
```
Best building site: center-corner (-237, -281), ground level y=67, flatness 73% over 50x50.
Leveling 50x50 to y=67 using /fill (fast mode). Only natural materials are removed.
Leveling done (fast mode) at -237,67,-281 .. -188,67,-232.
Building site ready at -237,-281, ground level y=67, 50x50.
```
5×5 网格抽样复核 25 点：`y=70 上方方块残留 0`、`y=67 地面空洞 0` → 50×50 确实推平了。
全程 0 次 ping timeout、0 次 code interrupted。

### 踩过并修掉的两个坑

1. **同步扫描堵死事件循环 → 心跳超时掉线**
   第一版 `findBuildingSite` 一次性做 ~10 万次 `bot.blockAt`，CPU 占满主线程，MindServer 心跳超时 → `Agent process exited with code 1` → 无限重启。
   修法：扫描循环里每评估 2 个候选点 `await new Promise(r => setTimeout(r, 0))` 让出事件循环；并把大面积的采样步长从 4 提到 6。

2. **生存模式逐格挖平 50×50 不现实**
   实测手工模式 5 分钟只推进了 `11/144` 列（每挖一格都要重新寻路，约 27 秒/列）。按这个速度 2500 列要 19 小时。
   修法：≥16×16 改走 `/fill` 批量指令。同时把 `code_timeout_mins` 从 5 放宽到 20。

### 重要教训：CoreProtect 的 action 码与"不记录指令改动"

- `co_block.action`：**`1` = 放置（PLACE）**，`0` = 移除/被替换，不是反过来。之前把 1 当成 BREAK，导致误判"AI 在拆房子"。
- CoreProtect **不记录** RCON/控制台 `setblock`，也基本不记录玩家用 `/fill` 做的批量改动。**核实世界必须直接读方块，不能只信数据库。**
- 读方块的正确姿势：`execute store result score v obj if block X Y Z minecraft:空气` 再 `scoreboard players get v obj`（1=是，0=否）。
  ⚠️ 不要用 `execute if block ... run say XXX` 来探针——`say` 的回显不走 RCON，会得到假的"全 False"结论（曾因此误判房子不存在）。
  ⚠️ 探针用的 `scoreboard players set` 会作为命令回显广播进 AI 的聊天，几十条之后她会开始说 `\t*****` 乱码。调试前先 `gamerule sendCommandFeedback false`。

### 一句结论
`say 小D，用 skills.prepareBuildingSite(bot, 50) 自动选地并平整出50x50的平地，做完报坐标`

---

# 第六轮：实际安装与升级记录（2026-10-20 11:20）

> 执行内容：安装可用插件 + 升级落后插件。
> 备份：`backups\plugins-upgrade-20261020-112014\`（含 package.json / package-lock.json / settings.js / skills.js / skill_library.js / mcdata.js / patches 全量）

## 37. 变更清单

| 包 | 变更 | 版本 | 结果 |
|---|---|---|---|
| `mineflayer-death-event` | 新增 | 2.0.0 | ✅ 已装 |
| `mineflayer-schem` | 新增 | 1.5.2 | ✅ 已装 |
| `prismarine-schematic` | 新增（读图纸用） | 1.3.0 | ✅ 已装 |
| `mineflayer-auto-eat` | **升级** | 3.3.6 → **5.0.3** | ✅ 已装，需改 API（见下） |
| `mineflayer-web-inventory` | 尝试安装 | — | ❌ **失败**，依赖 `minecraft-assets@^1.19.0` 在镜像上无匹配版本 |

未动的（刻意保持）：`mineflayer` 4.33.0、`mineflayer-pathfinder` 2.4.5、`collectblock` 1.6.0、`pvp` 1.3.2、`tool` 1.2.0、`armor-manager` 2.0.1。

## 38. auto-eat 5.x 的两个破坏性变更（重要）

升级后**不会报错，但自动进食会静默失效**，必须同时改两处：

| 项 | 3.x 写法 | 5.x 写法 |
|---|---|---|
| 导入 | `import { plugin as autoEat }` | `import { loader as autoEat }` |
| 配置入口 | `bot.autoEat.options` | `bot.autoEat.opts` |
| 饥饿阈值字段 | `startAt: 14` | `minHunger: 14` |
| 是否自动生效 | 默认自动 | **必须显式 `bot.autoEat.enableAuto()`** |

已改：
- `src/utils/mcdata.js:8` → `import { loader as autoEat } ...`
- `src/agent/agent.js:193-200` → 改用 `opts` + `minHunger` + 补 `enableAuto()`

## 39. 插件加载位置（`src/utils/mcdata.js`）

```
bot.loadPlugin(pathfinder);
bot.loadPlugin(pvp);
bot.loadPlugin(collectblock);
bot.loadPlugin(autoEat);
bot.loadPlugin(armorManager);
bot.loadPlugin(deathEventPlugin);   // 新增
bot.loadPlugin(schemBuilder);       // 新增，必须晚于 pathfinder
```

**`mineflayer-schem` 的硬性要求**：builder 会检查 `bot.pathfinder` 是否存在，否则直接 `throw 'mineflayer-pathfinder must be loaded before mineflayer-schem'`。所以顺序不能调。

## 40. 运行时验证（实测，不是看日志有无报错）

让她在游戏里执行代码自检，输出：
```
pf=1 pvp=1 cb=1 eat=1 build=1 eaton=1
```
逐项对应：`bot.pathfinder` / `bot.pvp` / `bot.collectBlock` / `bot.autoEat` / `bot.builder` / `bot.autoEat.enabled` —— **六个全部为真**，`eaton=1` 说明 `enableAuto()` 生效。

稳定性：重启后连续运行 4.5 分钟，`ping timeout 0`、`Agent exited 0`。

## 41. 过程中出现过一次崩溃，原因已查明

`live.log` 第 78/96 行：`Disconnected from MindServer: ping timeout` → `Agent process exited with code 1` → 自动重启。

- 发生时机：**正在 `Awaiting openai api response`**（等模型返回），不是加载插件或执行代码时
- 真实诱因：当时我正在跑 `npm install`，`node_modules` 正在被替换，运行中的进程读到不一致的模块状态
- 重启后完全恢复，之后再没复现

**教训**：装包前必须先停 bot（这次前两步有做，但安装顺序与运行进程有重叠）。以后安装统一先 `Stop-Process` 再 `npm install`。

## 42. patch-package 没有被破坏

`npm install` 会触发 `postinstall: patch-package`，需要确认旧补丁仍生效。
实测 `node_modules/mineflayer-pathfinder/lib/movements.js` 中仍存在补丁特征函数 `updateLavaAvoidance` → **补丁完好**。

## 43. 回滚方法

```powershell
cd E:\我的世界ai\mindcraft
Remove-Item node_modules -Recurse -Force
Copy-Item E:\我的世界ai\backups\plugins-upgrade-20261020-112014\package.json .
Copy-Item E:\我的世界ai\backups\plugins-upgrade-20261020-112014\package-lock.json .
Copy-Item E:\我的世界ai\backups\plugins-upgrade-20261020-112014\mcdata.js src\utils\
Copy-Item E:\我的世界ai\backups\plugins-upgrade-20261020-112014\agent.js src\agent\.   # 若单独备份了
npm install
```

## 44. 下一步：schem 怎么用（待改造）

`mineflayer-schem` 已经能用了，但要真正盖出好看的房子，还需要**图纸文件**：

1. 在单机创造模式里搭好一个房子
2. 用 **Litematica** 或 **WorldEdit** 导出成 `.schem` / `.litematic`
3. 放到 `mindcraft\schematics\` 目录
4. 在 `skills.js` 里包一个 `skills.buildFromSchematic(bot, file, x, y, z)`，内部用 `Schematic.read` + `new Build(...)` + `bot.builder.build(...)`

这样"盖房子"就从"让模型自由发挥画火柴盒"变成"照着你的图纸精确复制"，而且进度/错误都是事件推出来的，不再依赖模型自己说成功。

已验证可用的 API：
```js
const { Schematic } = require('prismarine-schematic');
const { Build, builder } = require('mineflayer-schem');
const schematic = await Schematic.read(buffer, bot.version);
const build = new Build(schematic, bot.world, bot.entity.position.floored());
await bot.builder.build(build, { buildSpeed: 1.0, onError: 'retry', retryCount: 3, useNearestChest: true });
```

---

# 第八轮：插件装完之后的第一批代码改造（2026-10-20 11:42）

> 备份：`backups\smoothlook-20261020-114214\`、`backups\refactor1-20261020-114525\`、`backups\refactor2-20261020-114903\`

## 48. 本轮装了什么

| 包 | 版本 | 月下载 | 状态 |
|---|---|---|---|
| `@nxg-org/mineflayer-smooth-look` | 1.2.4 | 426 | ✅ 已装并接入 |

运行时验证：`sl=1 la=1`（`bot.smoothLook` 存在且 `lookAt` 可用）。

## 49. 一个必须记住的加载约束

`smooth-look` 的 `_loader` 默认 `_monkeyPatch = false`，**不会接管原有的 `lookAt`**。
所以接入它不会改变任何现有行为，只是多出 `bot.smoothLook.*` API。要平滑必须显式调用。

## 50. 改造清单（4 项）

### 改造 1：把安全函数暴露给模型

**发现的问题**：`placeBlockWithoutBreaking` 是我上一轮写的，但**当初根本没写 `export`**——它不是导出函数，模型永远看不到，自然继续用会拆方块的 `placeBlock`。

**修法**：加 `export` + 补完整 JSDoc（含 `@returns` 和用法示例）。

### 改造 2：给破坏性函数加警告

`skills.breakBlockAt` 的 JSDoc 开头改成 `DESTRUCTIVE:`，并明确写：
> Do NOT use it to "clear space" before building, and never loop it over a region.
> When building, use `skills.placeBlockWithoutBreaking` or `skills.fillAreaSafely`.

### 改造 3：修复 `always_show_skills` 的前缀串味 bug（本轮最重要的发现）

原来 `skill_library.js` 里是：
```js
this.skill_docs.find(doc => doc.includes(skillName))
```

**这是一个隐蔽的 bug**：`"skills.placeBlock"` 是 `"skills.placeBlockWithoutBreaking"` 的**前缀**，
所以查询 `placeBlockWithoutBreaking` 时 `find()` 返回的是 `placeBlock` 的文档。

实测后果：配置了 7 个 always-show 函数，实际只注入了 **4 个**，而且错的。
**这意味着上一轮做的 `prepareForBuilding`（盖房前检查背包/存箱子）从来就没被注入到 prompt 里，模型根本不知道有这个函数。**

**修法**：改为按文档第一行精确匹配：
```js
const found = this.skill_docs.find(doc => doc.split('\n')[0].trim() === skillName);
```
并加了 `console.warn` 兜底，找不到就报警。

修完实测 7 个全部命中。

### 改造 4：转头动作走 smoothLook

`modes.js` 的 `idle_staring` 里两处 `lookAt` / `look` 改为优先用 `bot.smoothLook`，
并用 `try/catch` + 可选链做了降级：插件不存在或报错就回退到原来的瞬间转头，行为不受影响。

## 51. 验证结果（实测）

重启后让她盖房，模型 prompt 里实际注入的文档列表：
```
Selected skill docs: [
  'skills.placeBlockWithoutBreaking',
  'skills.placeBlock',
  'skills.breakBlockAt',
  'skills.wait',
  'skills.prepareForBuilding',
  'skills.prepareBuildingSite',
  'skills.buildHouse'
]
```

她生成的代码（一次就对）：
```js
const ok = await skills.prepareForBuilding(bot, { oak_planks: 80, oak_door: 1 }, 3);
```

运行输出：
```
Not enough materials for the build: 1 more oak_door (have 0/1).
Free inventory slots: 0.
Inventory too full to build (0 free slots, need 3). Storing unneeded items in a chest first.
No chest found within 32 blocks, cannot free up inventory space. Place a chest first or make room.
检查结果: 可开始=false, oak_planks=192, oak_door=0, 空余格子=0
```

**三个关键结论**：
1. 她**主动调用了**盖房前检查（这正是最初的需求）
2. 她**诚实报告了失败原因**，没有谎报"盖好啦"（F3 改善）
3. 代码里**没有出现 `breakBlockAt`**（F2 改善）

稳定性：`Agent exited 0`、`ping timeout 0`、无文档缺失警告。

## 52. 一个调试中被我自己坑到的点

我用 `say 小D，用 !newAction 检查...` 去触发她，结果她**毫无反应**。

原因在 `agent.js:279`：
```js
if (!self_prompt && !from_other_bot) { // from user, check for forced commands
    const user_command_name = containsCommand(message);
```
只要消息里出现 `!` 开头的命令，`handleMessage` 就会把它**当成用户直接下发的命令去执行**，
**跳过模型推理**，所以既不会产生回复，也不会走 `newAction` 的正常流程。

**正确的驱动方式：用不带感叹号的自然语言**，比如「小D，帮我盖个5x5的小木屋吧」，
她自己会选择 `!newAction` 并生成代码。这个坑以后每次调试都会踩，记下来。

## 53. 还没做的（下一批）

- `mineflayer-schem` 的 `skills.buildFromSchematic()` —— 等图纸文件
- 死亡事件接到对话里（`bot.on('death')` → 让她知道并汇报）
- `prepareForBuilding` 找不到箱子时的兜底（现在只会说"找不到箱子"，不会自己放一个）

---

# 第九轮：储物箱逻辑重构（2026-10-20 12:06）

> 需求：`prepareForBuilding` 找不到箱子时自己放一个。
> 备份：`backups\chestlogic-20261020-120622\`、`backups\chestlogic2-20261020-122402\`

## 54. 设计定稿（先理逻辑再写代码）

改造前 `prepareForBuilding` 只返回一个 boolean，失败时调用方**分不清**是缺材料、没箱子还是格子不够，
而这三者需要完全不同的后续动作。所以先定分层：

```
prepareForBuilding(required, minFreeSlots, near)
 ├─ 1. 数材料 → 缺就记账（不阻断后面的腾格子）
 ├─ 2. 格子 ≥ minFreeSlots？→ 够就直接放行
 ├─ 3. 需要腾格子 → 先保证有箱子
 │     3a. landmarks 记录的箱子 → 实地验证方块还在？→ 用
 │     3b. 附近 32 格扫描 → 找到就用
 │     3c. 背包有 chest → 直接放
 │     3d. 木板 ≥ 8 → 现场合成 chest 再放
 │     3e. 都没有 → 报告具体原因（死局，不丢东西）
 └─ 4. 存物品：只保留 required 里的，其余全存 → 返回结构化结果
```

**死局规则（用户拍板选 A）**：背包满 + 无箱子 + 木板不足 8 个 → 直接报告失败，**绝不丢弃任何物品**。

## 55. 关键设计决策

### 箱子位置：侧后方，不挡正前方（用户要求 3B）

```js
const CHEST_SIDE_OFFSETS = [
    [-1, 0, 1], [1, 0, 1], [-1, 0, 0], [1, 0, 0],   // 侧后方优先
    [-1, 0, -1], [1, 0, -1], [0, 0, 1], [0, 0, -1],
];
```
每个候选位置要满足三条：目标是**纯空气**（草/水会让箱子悬空或被冲走）、上方留一格、下方是实心方块。

### 用文件记坐标，不用模型记忆（重要）

用户要求"需要她记住箱子在哪里"。**没有把坐标塞进 memory.json**，原因是那个文件由模型自己的总结器反复改写，
之前就发生过记忆漂移（调试用的计分板命令被写进长期记忆）。坐标放进去迟早会丢。

改为独立文件 `bots/<agent>/landmarks.json`：
```json
{
  "chests": [ { "x": -248, "y": 64, "z": -268, "note": "placed_by_bot", "lastUsed": 1792470059201 } ],
  "sites":  []
}
```
由 `src/agent/library/landmarks.js` 管理（remember / forget / touch / 按距离排序）。
**模型只需要知道"有 landmarks 这个东西"，不需要背坐标。**

### 就近优先

`knownChestsNearest(bot, near)` 按到 `near`（通常是工地）的平方距离排序，
避免她这次在东边建房却跑回西边几百格取箱子。

## 56. 实测验证（三个场景全部通过）

### 场景一：没有箱子，自动合成并放置

前置：背包 36 格全满、无箱子、有 20 木板 + 工作台。

```
Free inventory slots: 0.
Inventory too full (0 free slots, need 3). Getting a chest.
No chest in inventory, crafting one from 20 planks.
Placed crafting_table at (-247, 65, -267).
Successfully crafted chest, you now have 1 chest.
...
Chest at: {"x":-248,"y":64,"z":-268}
```
`landmarks.json` 正确写入 `note: "placed_by_bot"`。

### 场景二：重启后复用记住的箱子

前置：重启进程（新进程，内存里没有状态）+ 背包塞满。

```
Free inventory slots: 1.
Inventory too full (1 free slots, need 3). Getting a chest.
Using remembered chest at (-248,64,-268).      ← 复用了上个进程写入的坐标
```
**这是"需要记住箱子在哪"这个需求的直接证据**：坐标来自磁盘，跨进程生效。

### 场景三：箱子被拆后自动遗忘

前置：`setblock` 把记录的箱子改成空气，再触发。

结果：`landmarks.json` 的 `chests` 变成 **空数组** —— 说明检测到方块不在了，
执行了 `forgetting it` 并从记录中删除，不会让她白跑一趟。

## 57. 顺手修掉的一个小问题

`craftRecipe` 里做完东西会 `collectBlock(bot, 'crafting_table', 1)` 回收工作台。
但**背包满的时候必然收不回来**（没格子），原来会打一条 `Failed to collect crafting_table` 报错。

改成：先判断有没有空位，没有就明确记一句 `Crafting table left in place (inventory is full).`，
不当作错误。工作台留在地上，下次合成还能直接用。

## 58. 当前完整行为（给模型看的最终版）

```js
const r = await skills.prepareForBuilding(bot, { oak_planks: 80, oak_door: 1 }, 3, {x:-237,y:67,z:-281});
// r = { ok, missing[], freeSlots, chest, chestVia, stashed[], reason }
```
`reason` 取值：`ready` / `missing_materials` / `still_full` /
`no_chest_no_planks` / `no_materials_for_chest` / `craft_failed` / `no_spot` / `chest_gone` / `open_failed`

**每个失败原因都能直接告诉玩家该做什么**，而不是笼统的 false。

## 59. 仍未做的

- `prepareForBuilding` 目前只在"格子不够"时才找箱子。如果玩家想主动整理背包，需要一个独立的 `organizeInventory()`。
- `landmarks.sites`（工地坐标）已支持读写，但还没有函数在选址后自动写入。
- `schem` 的 `buildFromSchematic()` 仍等图纸文件。

---

# 第十轮：全量逻辑审计与新增能力（2026-10-20 12:39）

> 备份：`backups\logic-audit-20261020-123933\`
> 方法：先用模式扫描把 skills.js / modes.js 里所有可疑写法挖出来，逐条核实后修，不凭印象改。

## 60. 审计出来的 5 个真问题（都已修）

### 问题 1（最严重）：followPlayer 退出不恢复 mode 状态

**症状**：跟随玩家被中断后，`item_collecting`（捡东西）、`unstuck`（脱困）、`elbow_room`（避让）等
**会永久停在 pause 状态**。表现就是"她突然不捡东西了""卡住了也不自救"，而且极难排查。

**根因**：`followPlayer` 在循环里用 `pause/unpause` 动态切换模式，但退出路径只有 `clearInterval(doorCheckInterval)`，
**没有恢复被暂停的模式**。只要不是正常走完循环（比如 `bot.interrupt_code`），状态就永久残留。

**修法**：整个循环包进 `try/finally`，`finally` 里无条件恢复 5 个模式：
```js
for (const mode of ['item_collecting','hunting','torch_placing','unstuck','elbow_room']) {
    try { bot.modes.unpause(mode); } catch (err) {}
}
```

### 问题 2：三个箱子函数各走各的，存和取可能不是同一个箱子

`putInChest` / `takeFromChest` / `viewChest` 原来都用 `world.getNearestBlock(bot,'chest',32)`，
**完全没用第九轮做的 landmarks**。后果：她把东西存进 A 箱子，取的时候却可能跑去 B 箱子。

**修法**：抽出一个统一入口 `openKnownChest(bot, range)`：
```
landmarks 记录的箱子（逐个验证方块还在）→ 失败则扫描附近 → 找到后写回 landmarks
```
三个函数全部改走这个入口。现在"存哪取哪"是一致的。

### 问题 3：discard 的 while(true) 可能死循环

```js
while (true) {
    let item = bot.inventory.findInventoryItem(itemName);
    if (!item) break;
    await bot.toss(item.type, null, to_discard);   // 若这里静默失败
    discarded += to_discard;                        // 物品却没减少
}
```
`bot.toss` 失败时物品不会减少，`discarded` 却在累加（或循环重新找到同一个 item），
在某些失败模式下会变成**无限循环**。

**修法**：加 `failedRounds >= 3` 就放弃并记录日志。

### 问题 4：placeBlock 的 break-then-place 会拆掉玩家建筑

这是历史上"盖房盖成拆迁"的根源（第 20 轮已确认：`oak_planks` 被一整片拆光）。
原来只要目标格不是空块就**一律拆掉**，坐标算错就把已有建筑毁了。

**修法**：加一道闸。识别到玩家建筑（木板/玻璃/砖/箱子/工作台/门/栅栏等）就**直接拒绝并返回 false**，
提示"pick empty space instead"，只有天然地形才允许拆。

### 问题 5：4 处无超时的 pathfinder.goto

```js
await bot.pathfinder.goto(inverted_goal);          // 没有上限
await bot.pathfinder.goto(new pf.goals.GoalFollow(enemy, 3.5), true);
```
这些都在"逃跑/靠近敌人/躲开方块"路径上，一旦 pathfinder 卡进 resetPath 循环就会**永久挂起**，
和最初那次进程被杀是同一个病根。

**修法**：新增 `gotoWithTimeout(bot, goal, timeoutMs)`，内部 `Promise.race` + 超时调 `pathfinder.stop()`。
- 战斗中的追踪/躲避：8 秒 / 5 秒
- placeBlock 内的躲避：15 秒
- moveAway：15 秒（脱困必须可靠）

现在 `pathfinder.goto` 的**直接调用数量为 0**，全部走带超时的封装。

## 61. 新增的三个能力

选这三个是因为现有 49 个函数都很"原子"（走/挖/放/吃），缺的是**组合视角**和**状态感知**。

### `skills.surveyInventory(bot)` — 干活前先看清自己有什么

把背包按用途分组：`materials`（成堆材料）、`tools`、`food`、`junk`（≤2 个的零碎、优先清出去）。
直接给出 `freeSlots / planksCount / hasChest`。

**为什么有用**：她以前要连着执行 `!inventory`、`!stats` 好几次才能拼出全貌，
现在一次调用就能判断"我能不能开始盖房"。

### `skills.reportStatus(bot)` — 如实汇报，不靠猜

返回坐标、血量、饱食、空位、昼夜、最近威胁、已知箱子位置。

**为什么有用**：直接打中之前那个"谎报成功"的毛病。她汇报时不再靠编，而是读这个函数的返回值。
实测她照着念出来的数字（20/20 血、31 空位、夜里、无威胁）全部准确。

### `skills.makeRoomForBot(bot, needed)` — 卡住时自己挖开

检查头顶和四周 8 个方向，只拆**天然地形**（土/石/沙/树叶等），玩家建筑一律跳过。

**为什么有用**：`unstuck` 模式只是"尝试走开"，如果她被方块整个包住（之前真的被自己的房子埋过），
`unstuck` 是无能为力的。这个函数是最后一道自救手段。

## 62. always_show_skills 扩到 10 个

```js
'skills.placeBlockWithoutBreaking', 'skills.placeBlock', 'skills.breakBlockAt', 'skills.wait',
'skills.prepareForBuilding', 'skills.prepareBuildingSite', 'skills.buildHouse',
'skills.surveyInventory', 'skills.reportStatus', 'skills.makeRoomForBot'
```
实测 **10/10 全部命中**文档（靠第 50 节修的那个精确匹配 bug，否则 `placeBlock` 会串到 `placeBlockWithoutBreaking`）。

## 63. 验证结果

- 全部文件语法通过，重启后 `stderr` 为空，4 秒进服
- 强制她调用新函数，返回内容准确：
  > surveyInventory：背包 31 格空、5 格占用，共 101 件东西。木板 32 块，背包里有箱子。
  > reportStatus：位置 -244,65,-263，血 20/20、饱食 20/20，空位 31 个，现在是夜里，没有威胁，也没记过箱子位置。

## 64. 剩下的观察项（本次没动）

| 项 | 现状 | 为什么没动 |
|---|---|---|
| `item_collecting` 用 `timeout=-1` 且不 await | `modes.js` 里调 `execute(...)` 不等待 | 属于 mode 调度框架的既有设计，改动面大，需单独验证 |
| `mineflayer-pvp` 4 年未更新 | 1.3.2 / 2022-07 | 已确认是最后版本，无替代 |
| `landmarks.sites` 未自动写入 | 已支持读写但没调用 | 等 `buildFromSchematic` 时一起做 |
| `viewChest` 输出格式 | 只 log 物品名 | 可以改成结构化返回，优先级低 |

---

# 第十一轮：修掉 item_collecting 的永久阻塞（2026-10-20 13:07）

> 备份：`backups\itemcollect-20261020-130708\`（modes.js + skills.js）
> 这是最初那次「She 完全不理人、命令全部阻塞、最后进程被杀」的元凶之一。

## 65. 问题根因（完整链条）

```
modes.js update() 第 423 行：
    for (let mode of modes_list) {
        if (mode.on && !mode.paused && !mode.active && ...) await mode.update(_agent);
        if (mode.active) break;        // ← 一旦某个 mode 卡住，后面全部跳过
    }

execute() 默认 timeout = -1：
    if (timeout > 0) TIMEOUT = this._startTimeout(timeout);   // -1 → 完全不设超时
```

`item_collecting` 调用 `execute(this, agent, ...)` **没传 timeout**，于是：
- `pickupNearbyItems` 内部若卡住（pathfinder 死等），`runAction` 永不返回
- `mode.active` 永远是 `true`
- `update()` 里的 `if (mode.active) break;` 让 **后面所有 mode 永久失效**
  （`unstuck` 脱困、`self_preservation` 自保、`torch_placing` 插火把…全都跑不了）

而且 12 处 `execute(...)` 调用**全部**是这样写的，不止 item_collecting 一个。

## 66. 三层修复

### 第 1 层：execute 内部加 try/finally 兜底（最关键）

```js
mode.active = true;
let code_return;
try {
    code_return = await agent.actions.runAction(...);
}
catch (err) {
    code_return = { success: false, message: String(err), interrupted: false, timedout: false };
}
finally {
    mode.active = false;      // ← 无论成功/抛异常/被中断，一定复位
}
```
原来 `mode.active = false` 写在 `await` 之后，**一旦抛异常就永远执行不到**。

### 第 2 层：item_collecting 显式传 timeout

```js
execute(this, agent, async () => {
    await skills.pickupNearbyItems(agent.bot);
}, 3).catch(err => {                    // 3 分钟上限
    console.warn(`[item_collecting] pickup failed: ${err}`);
});
```
补了 `.catch`，避免 promise 未处理的 rejection 变成 unhandled。

### 第 3 层：pickupNearbyItems 加总量上限

单件物品已有 8 秒超时（第 20 轮加的），但**外层 while 没有上限**：
```js
while (nearestItem) {
    if (bot.interrupt_code) break;                        // 能被中断
    if (pickedUp >= MAX_ITEMS) break;                     // 最多 16 件
    if (Date.now() - startedAt > TOTAL_BUDGET_MS) break;  // 最多 45 秒
    ...
}
```
防止周围不断有物品（自己丢的、水冲来的）导致无限捡。

## 67. 验证（三层都测了）

### 隔离测试 execute 的异常处理
| 场景 | 结果 |
|---|---|
| 正常完成 | `active = false` ✔ |
| 内部抛异常 | `active = false` ✔ **已复位** |
| 传 timeout=3 | 确认真的传进 `runAction` ✔ |

### 真实环境
生成 8 个金锭掉落物 → **8 个全部进包**（`clear deepseek minecraft:gold_ingot 0` 返回 8）。
紧接着发命令 → 她立即正常回应（「我现在在（-243, 65, -262）呀」），
`waiting for code to finish` 计数 **0**，说明动作槽没被占用。

另外之前测试的 6 个绿宝石、24 个泥土也都正常进出包。

## 68. 附带查清的一件事：日志为什么会"丢"

排查时发现 `Mode xxx finished` 这类 `console.log` 在 `live.log` 里完全看不到。

原因：`main.js` 通过 `agent_process.js` **spawn 子进程**（`stdio: 'inherit'`），
而 Windows 下 `Start-Process -RedirectStandardOutput` 对**孙进程**的重定向不可靠。
所以 agent 进程里的日志没有进 `live.log`。

**改用 cmd 包装后解决**：
```powershell
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c',
  'D:\Node\node.exe main.js > live.log 2> live.err.log' -WindowStyle Hidden
```
以后所有启动都应该走这个方式，否则 agent 子进程的日志全部丢失，排查时会被误导
（本次就一度以为 mode 根本没执行）。

## 69. 仍然存在的同类风险（已记录，未改）

`modes.js` 里另外 11 处 `execute(...)` 也没传 timeout。

**为什么没一起改**：它们的内部函数（`placeBlock`、`attackNearest`、`goToBed` 等）
现在都走带超时的 `gotoWithTimeout` / `goToGoal`，卡死概率大幅降低；
而且现在有 `try/finally` 兜底，最坏情况也只是**那一个 mode 长时间占着**，不会永久阻断全部模式。

**如果要更保险**，可以给这 11 处统一加 timeout（比如 2~5 分钟），属于低风险改动，随时可做。

---

# 第十二轮：记忆机制查清 + 死亡事件 + 工地记录（2026-10-20 13:23）

> 备份：`backups\memory-site-20261020-132304\`

## 70. 关于 load_memory：它确实支持记忆，但分两类，可靠性差很多

用户问"看见有 load_memory，应该是支持记忆的吧"。查证结果：**支持，但要分清两套机制**。

### 第一类：memory.json —— 自然语言摘要，不可靠

`history.js`：
```js
this.memory = await this.agent.prompter.promptMemSaving(turns);   // 模型自己写摘要
if (this.memory.length > 1500) {
    this.memory = this.memory.slice(0, 1500) + '...(truncated)';   // 硬截断
}
```
三个硬伤：
1. 由**模型自己总结**，不是原始记录 → 会漏、会错、会编
2. **硬截断 1500 字符**，超出直接切掉
3. 每轮被覆盖重写

这就是之前"记忆漂移"的根源（调试用的计分板命令被写进了长期记忆）。

### 第二类：MemoryBank / landmarks —— 结构化坐标，可靠

```js
rememberPlace(name, x, y, z)   // 存坐标
recallPlace(name)              // 取坐标
```
**但原版 MemoryBank 不持久化**：只存在内存里，重启就全丢。
项目里原本只有 `!rememberHere` / `!goToRememberedPlace` 两个命令在用，用一次就丢一次。

### 结论
**精确数据（坐标、数量）绝不能放进 memory.json**，必须走 MemoryBank 或 landmarks。
这也是前面几轮我坚持不把箱子坐标塞进"她的记忆"的原因。

## 71. 改动一：MemoryBank 持久化（修掉 !rememberHere 重启即丢）

**两处配合**：

```js
// history.js save()：把 memory_bank 一起写进 memory.json
memory_bank: this.agent.memory_bank ? this.agent.memory_bank.getJson() : {},

// agent.js start()：启动时恢复
if (save_data?.memory_bank) {
    this.memory_bank.loadJson(save_data.memory_bank);
    console.log('Restored saved places:', this.memory_bank.getKeys());
}
```

**实测**：
```
存 testhome  → memory.json 出现 {"testhome":[-243.5,65,-262.58]}
重启        → Restored saved places: testhome  ✔
```

## 72. 改动二：死亡事件接入

原来只有一个基于文本解析的兜底：
```js
if (jsonMsg.translate.startsWith('death') && message.startsWith(this.name))
```
这个判断比较脆弱，遇到服务端插件改写的死亡消息就失效。

**现在双通道**：
```js
this.bot.on('playerDeath', (e) => this._handleDeath('playerDeath event', ...));   // 插件，按协议解析
this.bot.on('messagestr', ...)                                                    // 原逻辑保留兜底
```
用 `_deathHandledAt` 做 5 秒去重，避免两条路径都触发时她说两遍"我死了"。

`_handleDeath()` 做的事：
1. `memory_bank.rememberPlace('last_death_position', ...)`
2. `landmarks.rememberSite(..., 'death_position')` —— **写磁盘，重启后还在**
3. 给模型发一条系统消息，明确告诉她"物品还在那儿，位置已保存，可以去捡"

**实测**（`kill deepseek`）：
```
Agent died (messagestr fallback): deepseek was killed at overworld
received message from system : You died at position x: -243.51, y: 65.00, z: -262.58 ...
landmarks.json → sites: [{"x":-244,"y":65,"z":-263,"note":"death_position"}]
```
注意走的是 fallback 通道 —— 说明 `death-event` 插件没匹配这条消息，
**双通道的设计是对的**，只留插件会漏，只留文本解析也脆弱。

## 73. 改动三：工地坐标自动记录

| 触发点 | 记录内容 |
|---|---|
| `prepareBuildingSite()` 平整完 | `build_site_50x50` |
| `buildHouse()` 盖完（且确实放了方块） | `house_5x5` |
| 死亡 | `death_position` |
| `!rememberHere` | 走 memory_bank |

新增 `skills.listKnownSites(bot)` 让模型能查这些记录（已加入 `always_show_skills`，共 11 个）。

## 74. 途中修掉的一个真 bug：memory_bank 没挂到 bot 上

第一版 `listKnownSites` 里用 `bot.memory_bank` 读记忆，结果**永远读不到** `testhome`。

根因：`memory_bank` 只挂在 `agent` 上（`this.memory_bank`），
而模型在沙箱里**只拿得到 `bot`，拿不到 `agent`**。

修法：`initBot()` 之后加一行 `this.bot.memory_bank = this.memory_bank;`

**注意顺序**：`this.bot` 是在 `start()` 第 80 行才创建的，
一开始我把这行写在第 46 行（memory_bank 创建处），会直接报 undefined —— 必须放在 initBot 之后。

## 75. 最终验证

```
Restored saved places: testhome, last_death_position
Known places: death_position at (-244,65,-263); testhome at (-244,65,-263); last_death_position at (-244,65,-263)
```

她的原话：「现在记住三个地点啦：death_position、testhome、last_death_position，
都同一个位置（-244, 65, -263）哦~ 原来 testhome 还在呀，刚刚没显示出来诶嘿」

（三个都是同一坐标，是因为测试时都在同一地点触发，不是 bug。）

## 76. 剩下可做的

- `!rememberHere` 存的点目前只进 memory_bank，没同步进 landmarks；
  两个存储合并展示已解决"查不到"的问题，但数据仍是两份。
- 死亡后主动去捡物品的自动化还没做（现在只是告诉模型位置）。

---

# 第十三：死亡后自动捡物品（2026-10-20 16:15）

> 备份：`backups\deathrecover-20261020-155334\`、`backups\deathrecover2-20261020-161512\`

## 77. 需求与风险

需求很简单：死了之后自己跑回去捡东西。

**但直接实现会出事**：如果死亡点有怪（岩浆、怪物、掉进洞里），
她会变成「死 → 跑回去 → 再死 → 再跑」的**无限送死循环**，
而且每一轮都会占用动作槽，和最初那次"命令全部阻塞"是同一类故障。

所以必须内置保护，而不是无脑跑。

## 78. 实现的三条安全规则

```js
skills.recoverDeathItems(bot, { maxDistance = 128, dryRun = false })
```

| 规则 | 行为 |
|---|---|
| **距离上限** | 超过 128 格不自动去，改为报告位置并询问玩家 |
| **连死保护** | 同一地点（32 格内）10 分钟内死过 ≥2 次 → **拒绝前往** |
| **途中再死** | 走路过程中如果又死，立即中止 |

返回值结构化，便于她判断：
```js
{ ok, reason, distance, pickedUp, items }
// reason: recovered / dry_run / too_far / repeated_deaths
//         / died_on_the_way / unreachable / no_death_position
```

## 79. 途中修掉的一个真 bug：保护永远触发不了

第一版把死亡计数写在了 `recoverDeathItems` 内部：

```js
if (tooManyRecentDeaths(...)) return;   // 检查
recordDeathAttempt(bot, target);        // 记录
```

**顺序错了** —— 每次都是「先检查、后记录」，
所以统计里永远只有之前那次，保护**一次都不会触发**。

测试也证实了：连死两次，两次都照样 `Walking back`。

**修法**：把计数改由**死亡事件**写入。
- `skills.js` 导出 `recordDeath(bot, pos)`
- `agent.js` 的 `_handleDeath()` 里调用它（`skills.recordDeath(this.bot, death_pos)`）
- 这样流程变成：死 → 计数 +1 → 下次尝试时检查 → 达标即拒绝

**顺带修的引用错误**：一开始我误写成 `landmarks.recordDeath`，
但 `recordDeath` 定义在 skills.js，且 agent.js 原本没 import skills —— 已补 `import * as skills`。

## 80. 验证

### 隔离测试（连死三次）
```
第1次死亡后: 允许 | reason = dry_run
第2次死亡后: 拒绝 | reason = repeated_deaths
第3次死亡后: 拒绝 | reason = repeated_deaths
```

### 真实环境
第一次死亡（带 5 钻石 10 铁锭 3 面包）：
```
Walking back 12 blocks to recover items at (-151,63,-214).
Picked up 1 items.
Recovered near the death spot. Inventory now holds 3 stacks (1 before).
recover: {"ok":true,"reason":"recovered","distance":12,"pickedUp":2,
          "items":["breadx3","diamondx5","iron_ingotx10"]}
```
她说：「捡回来啦~ 面包3个、钻石5颗、铁锭10个都拿到了」

同一地点第二次死亡：
```
Agent died 共 2 次
Walking back 只有 1 次        ← 第二次被保护拦住
```
她的反应：「天黑了又是雨天，附近还有怪呢，先别急着跑」
记忆里也记下了「死点有怪」。

## 81. 死亡提示也一并改了

原来只说「你死了，位置保存在 last_death_position」。
现在按距离给出明确指引：

- ≤128 格：`you can call skills.recoverDeathItems(bot) to walk back`
- \>128 格：`too far to walk automatically - ask the player whether to go`

`recoverDeathItems` 已加入 `always_show_skills`（现 12 个，实测 12/12 命中），
所以她死后能自己想起来调用它 —— 测试中她确实是**主动**调用的。

## 82. 已知限制

- 死亡点若**跨维度**（下界/末地）不会自动去（`goToPosition` 不支持跨维度）
- 物品有 5 分钟消失时间，太远或拖延会捡不到 —— 这正是 128 格上限的原因
- 连死保护的计数只在**当前进程内存**里，重启会清零（可接受：重启后本来就该重新评估）

---

# 第十四：按蓝图盖房（buildFromSchematic，2026-10-20 16:33）

> 备份：`backups\schematic-20261020-163313\`、`backups\schemfix-20261020-164922\`

## 83. 图纸

用户提供的蓝图：`7ab62ec7383f4584b9a1ce88c2371d5c.litematic`（5.5 KB）

| 项目 | 值 |
|---|---|
| 格式 | Litematica（gzip 压缩的 NBT） |
| 尺寸 | **32 × 17 × 32** |
| 非空气方块 | **3784 个** |
| 方块种类 | 54 种 |
| 作者 | baiduwanpang |

主要材料：云杉木板 598、圆石 595、石砖 406、草方块 304、橡木原木 252、
云杉楼梯 166、云杉台阶 146、橡木木板 132、去皮橡木 124、土径 121、箱子 120

## 84. 关键发现：prismarine-schematic 解析不了 litematic

装好的 `prismarine-schematic` 对这张蓝图直接抛错：
```
Cannot read properties of undefined (reading 'length')
```

改用 `prismarine-nbt` 手动解 gzip + NBT 就能正确读出全部结构。
所以新增了 `src/agent/library/schematic.js` 自己实现解析。

解析要点：
- gzip 魔数 `1F 8B` 判断是否压缩
- 顶层 `Regions` → 每个区域有 `Size`（**可能为负**）、`Position`、`BlockStates`、`BlockStatePalette`
- `BlockStates` 是 long 数组，按位打包
- **每方块位数 = max(4, ceil(log2(调色板长度)))**，这张图是 8 位
- 索引顺序：y 最快、然后 z、最后 x

验证：`BlockStates` 长 2176，理论值 `ceil(17408 × 8 / 64) = 2176` ✔

## 85. 建造方式：用 /setblock 而不是手放

3784 个方块，如果用手放（`placeBlock`）：
- 之前实测过手工平地是 **27 秒/列**，3784 块要十几个小时
- 而且会被怪物打断、会卡在寻路上

所以默认走 `mode: 'command'` —— 用 `/setblock` 逐条发，45ms/条，
实测 **3784 块耗时 178 秒（约 3 分钟）**。

也保留了 `mode: 'physical'` 走手放，供没有 OP 的情况（但会非常慢）。

## 86. 实测结果（成功）

服务端日志证据（`server/latest-run.log`）：
```
issued setblock:   3784
Changed the block: 3735
失败提示:             0
```

坐标范围：
```
X: -139 ~ -109
Y:   70 ~ 86
Z: -239 ~ -209
```

用可靠探测（计分板取值法）抽样验证：
```
高层 (-139,73,-223) stone_bricks: ✔
     (-139,73,-218) cobblestone:  ✔ ...
高层验证 6/6 全过
地面 (-139,70,-239) grass_block: ✔ ...
```

**房子确实建成了。**

## 87. 排查过程中的两个教训（都是我自己的错）

### 教训一：`execute if block` 在 RCON 下不可靠

我用它探测「房子在那吗」，得到 0/5 全不命中，一度以为房子没建。

**校准实验**：把 `stone` 放到一个空坐标，`setblock` 返回「已改变」，
但紧接着 `execute if block ... stone` 仍然返回 **False**。

**结论**：这个探测方式在当前环境完全不可信。
**唯一可靠的是计分板法**：
```
scoreboard players set v obj -9
execute store result score v obj if block X Y Z minecraft:方块名
scoreboard players get v obj      # 1 = 有，0 = 没有
```

### 教训二：坐标假设错了，验证就白做

蓝图 `Position` 是 `(-1, 0, -1)`，不是 `(0,0,0)`。
所以 `buildFromSchematic(bot, file, -140, 70, -240)` 实际覆盖 `-139 ~ -109`，
而我一直在测 `x = -140`（正好在范围外一格），自然全是 air。

**这件事也说明「日志说成功」不等于「我验证对了」** —— 两边都要对。

## 88. 修复：坐标语义改成「指定点 = 蓝图最小角」

第一版 `getBlock(origin.x + bx, ...)` 里 `origin` 是 litematic 的原始坐标系，
和调用者传的 `(x,y,z)` 语义不一致，容易差一格。

现在改成 `getBlock` 接受 **0-based 内部坐标**（0..size-1），
`buildFromSchematic(bot, file, X, Y, Z)` 就是「把蓝图最小角放在 (X,Y,Z)」。

验证修复后：
```
遍历到的非空气方块: 3784   （和统计一致）
getBlock(1,0,1)=grass_block -> 放到 (-139,70,-239)
```
和之前实际落点完全一致，但语义清晰了。

## 89. 新增的三个技能

| 函数 | 作用 |
|---|---|
| `skills.buildFromSchematic(bot, file, x, y, z, opts)` | 按蓝图盖房 |
| `skills.describeSchematic(bot, file)` | 先看蓝图多大、要什么材料（不盖） |
| `skills.listBlueprints(bot)` | 列出 schematics/ 里有哪些图 |

参数要点：
```js
opts = {
  mode: 'command',      // command(默认,需OP,快) | physical(手放,慢)
  overwrite: false,     // 是否允许覆盖玩家建筑
  maxBlocks: 8000,      // 安全上限
  dryRun: false,        // 只估算不执行
  commandDelay: 45,     // 命令间隔(ms)
}
```

**安全设计**：
- 蓝图里是空气的位置**一律跳过**，绝不清理世界
- 目标是玩家建筑（木板/玻璃/石砖等）且 `overwrite=false` → **直接拒绝并报告坐标**
- 超过 `maxBlocks` 且未显式确认 → 拒绝

已加入 `always_show_skills`（现 15 个，实测 15/15 命中）。

## 90. 下次要改的地方

- `stats.placed` 目前只统计「命令已发出」，没验证服务端是否真的改了方块。
  服务端日志证明这次 3735/3784 成功，但代码层面应该更诚实 ——
  可以改成抽样复核，或者解析 chat 反馈里的 `Changed the block`。
- 多区域（多个 Regions）的蓝图还没实测，当前这张只有 1 个区域。

---

# 第十五：找人修复 + 仓储系统（2026-10-20 17:00）

> 备份：`backups\gotoplayer-20261020-165715\`、`backups\storage-20261020-170048\`、
> `backups\lintfix-20261020-171341\`、`backups\memory-fix-20261020-171724\`

## 91. 问题一：「到我这里来」她到了却找不到人

### 根因：pathfinder 的 GoalFollow 只看 3D 直线距离

```js
// node_modules/mineflayer-pathfinder/lib/goals.js
isEnd (node) {
  const dx = this.x - node.x, dy = this.y - node.y, dz = this.z - node.z
  return (dx*dx + dy*dy + dz*dz) <= this.rangeSq   // 3D 判定
}
```

`goToPlayer(bot, name, 3)` → `rangeSq = 9`。实测：

| 场景 | 旧逻辑 | 实际情况 |
|---|---|---|
| 玩家正旁边 2 格 | ✔ 到达 | 正确 |
| **玩家头顶 3 格** | **✔ 到达** | ❌ 她站在屋顶，看不见人 |
| **玩家脚下 3 格** | **✔ 到达** | ❌ 她在坑里 |
| 隔一层楼板 (y差3) | ✘ 未达 | 正确 |

而且到达后**没有任何验证**，直接 `log("You have reached ...")` 就算成功。

### 修法：水平/垂直分开判定 + 复核 + 转身

```js
const dxz = Math.hypot(me.x - pp.x, me.z - pp.z);   // 水平距离
const dy  = Math.abs(me.y - pp.y);                   // 高度差
const ok = dxz <= distance + 1.5 && dy <= 1.5;       // 两个条件都要满足
```
到位后 `await bot.lookAt(玩家头部)`，这样她抬头就能看到人。

**最多重试 3 轮**，每轮重新取玩家位置（玩家可能在走）。
失败时明确说明是「高度差」还是「水平还远」，让她知道该往哪找。

验证（distance=3）：
```
玩家正旁边        ✔ 到达
玩家头顶 3 格     ✘ 继续走   ← 旧逻辑误判，已修
玩家脚下 3 格     ✘ 继续走   ← 旧逻辑误判，已修
同层 2.8 格       ✔ 到达
```

## 92. 问题二：仓储系统（固定仓库 + 分类箱 + 记住内容）

### 设计上先解决的三个矛盾

**① 固定仓库 vs 工地就近**
`prepareForBuilding` 找的是「离工地最近的箱子」，长期仓库是另一个概念。
两者分工：**临时箱（近）用于盖房周转，仓库用于长期分类**，不互相覆盖。

**② 分类必须能查内容**
只记坐标不够。现在 `landmarks.json` 每个箱子都存 `category` 和 `contents`：
```json
{ "x":-137, "y":64, "z":-246, "category":"ores",
  "contents": {"iron_ingot":128, "coal":32, "diamond":5} }
```
查东西不用一个个开箱。

**③ 箱子会满**
`storeItem` 满了会**溢出到同类下一个箱子**，全满才报 `chests_full`。

### 分类规则：按用途，不按物品名

模型不用背 100 个物品归哪类，只按后缀/精确名匹配：

| 分类 | 标签 | 例子 |
|---|---|---|
| `ores` | 矿石 | 铁/金/钻石/煤/红石/青金石/绿宝石/铜、`*_ore`、`*_ingot` |
| `wood` | 木材 | 各类原木、`*_log`、`*_sapling`、木棍 |
| `building` | 建材 | `*_planks`、`*_stairs`、`*_slab`、圆石、玻璃、砖 |
| `food` | 食物 | 面包/苹果/熟肉/胡萝卜/农作物 |
| `tools` | 工具装备 | `*_pickaxe`、`*_sword`、`*_helmet`、盾、弓、箭 |
| `misc` | 杂物 | 其他 |

**25 项分类测试全部正确**。

### 六个新技能

| 函数 | 作用 |
|---|---|
| `setupStorage(bot, x?, y?, z?)` | 划定仓库区并永久记住 |
| `createStorageChests(bot)` | 按分类建箱子（缺箱子会用木板现做） |
| `storeItem(bot, item, num?)` | 送到对应分类箱，满了自动溢出 |
| `findItemInStorage(bot, item)` | 东西在哪个箱子 |
| `tidyInventory(bot, opts?)` | 一键整理（默认保留工具和食物在身上） |
| `listStorage(bot)` | 仓库总览 |

### 实测

```
Storage area set at (-136,64,-246). Remembered permanently.
Placed 矿石 chest at (-137,64,-246).
Placed 木材 chest at (-136,64,-244).
Storage setup done: 3 created, 0 reused, 3 missing (食物, 工具装备, 杂物).

Stored 64 iron_ingot in the 矿石 chest.
iron_ingot is in: (-137,64,-246) x128
```

`landmarks.json` 落盘：
```
箱子 (-137,64,-246) cat=ores contents={"iron_ingot":128,"coal":32,"diamond":5}
```

## 93. 途中修掉的一个真 bug：linter 正则误判

她反复说「skills.setupStorage 这些函数我这儿没有」，但静态检查 21/21 全命中。
查 `coder.js` 的 `_lintCode`：

```js
const skillRegex = /((?:skills|world)\.(.*?))\(/g;   // 非贪婪，遇到第一个 ( 就停
```

她的代码是 `typeof skills.setupStorage + ...; if (...)`，
`typeof` 后面没有 `(`，正则就一路滑到后面的 `if (`，抓出 `skills.setupStorage; if`，
再拿这个假名字去比对文档 → 报「函数不存在」。

复现：
```
正常调用 skills.setupStorage(bot)      -> ["skills.setupStorage"]     ✔
typeof skills.setupStorage             -> []                          漏检
typeof skills.X; if (a)                -> ["skills.setupStorage; if "] 误抓
```

**修法**（只认带括号调用的完整标识符）：
```js
const skillRegex = /\b((?:skills|world)\.[A-Za-z_$][\w$]*)\s*\(/g;
```
修后所有场景正确，不再误抓 `; if`。

## 94. 另一个教训：她的记忆会把错误结论固化成事实

linter 报错后，她连续 5 次生成失败，然后**把结论写进了长期记忆**：

> 「我无setupStorage/createChests功能，只能手动摆箱子」

之后无论怎么说明，她都直接回「真的不行啦～那几个 skills 函数我这儿压根没有」，
**连尝试都不尝试**。

这是 `memory.json` 由模型自己总结带来的副作用：**一次失败会被记成永久事实**。

处理：停 bot → 改写 `memory.json` 里那段错误结论 → 重启。之后第一次尝试就成功了。

**以后遇到「她坚信某功能不存在但代码确实有」，先怀疑记忆污染**，
而不是继续解释。

---

# 第十六：记忆分域存储（2026-10-20 17:30）

> 备份：`backups\memory-split-20261020-173024\`、`backups\memstore-20261020-173042\`
> 新增：`src/agent/library/memory_store.js`

## 95. 为什么要拆

用户的思路：**一个技能对应一个独立 JSON 文件**，新增技能各自保存、互不干扰。

原来所有结构化记忆塞在 `bots/<agent>/landmarks.json` 一个文件里
（箱子 + 工地 + 死亡点 + 仓库区）。技能一多会有三个问题：

| 问题 | 后果 |
|---|---|
| 每次写要重写整份 | 文件越大越慢，写入中断会**整份损坏** |
| 数据混在一起 | 一个技能的数据坏了**连累其他技能** |
| 新技能必须改这个文件 | 容易互相踩，改一处影响全部 |

## 96. 新的文件布局

```
bots/deepseek/memory/
├── chests.json     箱子坐标 / 分类 / 装了什么
├── sites.json      死亡点 / 工地 / 房子
├── storage.json    仓库区
└── <新技能>.json   以后加，不用改已有代码
```

每份文件带 schema 版本，方便以后迁移：
```json
{ "_v": 1, "_updated": 1792488000000, "data": { ... } }
```

## 97. 核心：memory_store.js

四个要点：

**① 命名空间注册制**

```js
registerNamespace('farming', () => ({ plots: [] }));
// 之后直接
writeStore(bot, 'farming', { plots: [...] });
readStore(bot, 'farming');
```

新增技能只要注册一个名字，**完全不用碰其他文件**。

**② 原子写入**

```js
写临时文件 → fs.renameSync 覆盖
```
同一分区 rename 是原子操作，避免写一半断电导致整份 JSON 损坏。

**③ 读失败不崩**

文件损坏、为空、JSON 非法 → 返回默认值 + 警告，不会让盖房/仓储流程挂掉。

**④ 自动迁移旧数据**

`migrateFromLegacyLandmarks()` 把旧的单文件拆成分域文件：
- 目标文件已存在就**跳过**（幂等，不会覆盖新数据）
- 迁移完把旧文件改名成 `landmarks.json.migrated-<时间戳>` **留档，不删**

## 98. landmarks.js 对外接口完全没变

这是关键：`skills.js` 有 26 处、`agent.js` 2 处、`storage.js` 2 处调用
`landmarks.*`，一共 30 处。**一行调用点都没改**。

只把内部实现换成按领域读写：
```js
export function loadLandmarks(bot) {
    ensureMigrated(bot);            // 首次调用时迁移
    return {
        chests: store.readStore(bot, 'chests'),
        sites:  store.readStore(bot, 'sites'),
        storage: store.readStore(bot, 'storage'),
    };
}
```

## 99. 验证

### 隔离测试（含迁移）
```
1) 造了旧版 landmarks.json
[memory] 已从 landmarks.json 迁移: chests(1), sites(1), storage
2) 迁移后读取: chests / sites / storage 全部正确
3) memory/ 目录: chests.json, sites.json, storage.json
4) 旧文件是否留档: landmarks.json.migrated-1792488613469
5) 新增后 chests 数: 2  sites 数: 2
6) chestsByCategory(wood): 正确
7) findItemInChests(iron_ingot): 正确
8) 仓库区: 正确
9) 新命名空间 farming: {"plots":[{"x":1,"z":2,"crop":"wheat"}]}
```

### 真实数据迁移（她自己的 4 个箱子 5 个地点）
```
迁移前：箱子 4 个，地点 5 个，仓库区有
迁移后：箱子 4 个，地点 5 个，仓库区 (-136,64,-246)
箱子明细（分类与内容全部保留）：
  (-138,64,-246) cat=building
  (-136,64,-244) cat=wood
  (-137,64,-246) cat=ores contents={"iron_ingot":128,"coal":32,"diamond":5}
  (-137,64,-245)
```

### 幂等性
连读 3 次，数据稳定不变；旧文件只改名一次，不会重复迁移。

### 重启后运行验证
```
Storage area: (-136,64,-246)
[建材] (-138,64,-246) (contents unknown)
[矿石] (-137,64,-246): iron_ingotx128, coalx32, diamondx5
```
stderr 空，无报错。

## 100. 以后加新技能怎么做

三步，不碰任何现有文件：

```js
// 1. 注册命名空间
import * as store from './memory_store.js';
store.registerNamespace('farming', () => ({ plots: [] }));

// 2. 读写自己的数据
const data = store.readStore(bot, 'farming');
data.plots.push({ x, z, crop: 'wheat' });
store.writeStore(bot, 'farming', data);

// 3. 或者用 updateStore 一步完成
store.updateStore(bot, 'farming', d => { d.plots.push({...}); });
```

文件会自动出现在 `bots/<agent>/memory/farming.json`。

---

# 第十七：干活前三件套 + 整齐仓库（2026-10-20 17:40）

> 备份：`backups\loadout-20261020-174208\`
> 新增技能：`checkLoadout` / `planMaterials` / `guardInventory` / `buildStorageWarehouse`

## 101. 用户提的两个问题

**① 三个新技能**（用户认可后实现）
**② 仓库会不会搭建得整齐、能不能保证安全**

先如实回答 ②：**原实现并不整齐，也没有安全检查。**

原来的 `findSpotNear` 只是在原点周围一圈偏移量里找空位：
```js
const offsets = [[0,0,1],[1,0,1],[-1,0,1],[1,0,0],...]
```
实测她自己建的箱子坐标是散的：
```
(-138,64,-246) 建材
(-136,64,-244) 木材
(-137,64,-246) 矿石
(-137,64,-245) 无分类
```
没有对齐、没有朝向、不检查是否悬空、**完全没有照明防怪**。

## 102. 新技能一：checkLoadout —— 干活前的装备体检

对应问题：挖到一半镐子坏了、砍树砍到饿死。

返回：
```js
{ tools: { pickaxe:{name,left,max,percent}, axe, shovel, sword },
  food: {count, kinds}, freeSlots, health, hunger, warnings[] }
```

**工具挑选规则**：材质优先（`netherite>diamond>iron>stone>golden>wooden`），
同材质里选耐久最多的。这样她会优先用好镐，而不是抓着快坏的。

**警告触发**（实测三个场景全对）：
| 场景 | 结果 |
|---|---|
| 只有快坏铁镐（剩 20/250 = 8%） | ✔ 警告「nearly broken」 |
| 铁镐 + 好钻石镐 | ✔ 不警告（用好镐） |
| 没有镐 | ✔ 警告「No pickaxe」 |

真实环境首测输出：
```
Loadout: pickaxe=none, axe=none, food=2, free=33, HP=20/20
Warnings: No pickaxe in inventory - cannot mine stone or ore. | Only 2 food left
```
（当时 `pickaxe=none` 是对的：我给的 `iron_pickaxe{Damage:230}` 是旧 NBT 语法，
1.21.8 需要 `[minecraft:damage=230]`，命令没生效，镐子根本没进背包。
**这是给物品的测试命令写错，不是检测逻辑错。**）

## 103. 新技能二：planMaterials —— 材料缺口 + 获取路径

对应问题：蓝图要 598 云杉木板，她只能看清单，**不知道差多少、怎么补**。

```js
planMaterials(bot, { spruce_planks: 598, oak_planks: 100 })
```
返回结果里每条材料都拆成四段：
```
need / have / inStorage(仓库里有多少) / missing
  -> craftFrom  (能不能合成，需要什么原料 x 几次)
  -> gather     (原料本身还缺多少，要去采集)
```

**实测输出**：
```
spruce_planks: need 598, missing 598 -> craftFrom {spruce_log: 150}
oak_planks:    need 100, have 64, missing 36 -> craftFrom {oak_log: 9}
```
把「看清单 → 查仓库 → 合成 → 采集」这条链串起来了。
这是从 `describeSchematic` 到真正开工之间**原本缺失的一环**。

## 104. 新技能三：guardInventory —— 采集前腾格子

对应问题：挖着挖着背包满了，物品掉地上丢了。
现在只在她主动整理时才处理，改成**采集动作之前**先预警并归位。

## 105. 新技能四：buildStorageWarehouse —— 整齐排布的仓库

这是回答用户问题 ② 的实现。

**排布**：一条直线，同层、同朝向、等间距：
```
[chest] . [chest] . [chest] . [chest] . [chest] . [chest] . [chest]
       ↑ 间隔 1 格，保证是单体箱（不会误合成大箱子）
```
`spacing=2` 即箱子之间空 1 格。

**选址**：`findChestRow()` 要求连续 N 格都满足
「脚下实心 + 本格空气 + 上方两格空气」，四个方向都试，挑第一个成立的。

**照明防怪**：每个箱子正上方插火把（有火把才插，没有就明确提示
「mobs can spawn」）。插完再复查还有几个位置仍黑（返回 `darkSpots`）。

**安全检查**：`auditAreaSafety()` 扫描半径 5 格内的岩浆/水，
发现就在日志里警告「Chests may be flooded or burnt」。

返回：
```js
{ ok, area, axis, placed[], skipped[], torches, dangers[], darkSpots, reason }
```

## 106. 修掉的一个 API 误用

`mc.getItemCraftingRecipes(name)` 的返回格式是：
```js
[[{材料:数量}], { craftedCount: N }]     // 第二个元素是"对象"，不是数字
```
我一开始写成 `recipe[1] || 1`，会得到对象，
`Math.ceil(missing / 对象)` = **NaN**，合成次数算不出来。
修正为 `recipe[1]?.craftedCount || 1`。

## 107. 测试过程中的外部故障（如实说明）

验证 `checkLoadout` 时，模型连续返回：
```
My brain disconnected, try again.
```
这是**中转服务（LLM Go）侧的错误**，不是代码问题 ——
同一时期 `planMaterials` 已经正常跑出了正确结果。

所以耐久检测改用隔离测试验证（三场景全过），
代码逻辑可信，但**未能在真实 bot 上再跑一次**。

---

# 第十八：仓库重做为「真正的房间」（2026-10-20 20:15）

> 备份：`backups\warehouse-v1\` `v2\` `v3\` `levelfix\` `relocate\`

## 108. 用户的判断：之前的仓库「明显不行」

**同意，而且我之前的理解是错的。** 我做的是「把箱子排成一行放在地上」，
那不是仓库，是**露天货堆**。真正的仓库应该是一个**封闭建筑**。

铁证是她实际建出来的坐标，完全是散的：
```
(-138,64,-246) 建材
(-136,64,-244) 木材
(-137,64,-246) 矿石
(-137,64,-245) 无分类
```

## 109. 重做：建成一间房间

```
     天花板 ┌───────────────┐
            │  灯        灯 │
   墙 →     [箱] . [箱] .  │   箱子贴墙、格子留空、朝向一致
            │  走道（她站这）│   中间留走道，站住就能开所有箱子
   墙 →     [箱] . [箱] .  │
     地板   └─────门口──────┘   2x2 门洞，能走进走出
```

内部净空 **7x7**、净高 **3 格**。为什么是 3 格：
箱子本身占 1 格，**上方必须留 1 格空气才打得开**（原版机制），再往上是天花板。

## 110. 四个必须核实的机制（这次先查了再做）

| 机制 | 查证结果 | 影响 |
|---|---|---|
| 箱子水平相邻会合并 | 是，`type: single/left/right` | 所以箱子**间隔 1 格**，避免两个分类混进一个大箱子 |
| 箱子上方需空气才能开 | 是 | 箱子上方那格必须空；火把/玻璃不算阻挡 |
| 天花板必须高于箱子 1 格 | 是 | 净高至少 3 |
| `/fill keep` 只填空气 | 是 | 深坑填不满 → 需要加大填充深度 |

## 111. 布局校验（脚本验证，非肉眼）

```
内部7x7 外9x9，箱子位 10 个
相邻会合并的对数: 0  ✔ 都是单体27格箱
够6分类: ✔
箱子上方 y=65 < 天花板 y=67: ✔ 留了1格开箱空间
全部贴墙: ✔
```

## 112. 发现并修的 4 个真 bug

### bug 1：选址在有水的地方
第一次实测：
```
Hazard: 32 water block(s) near the site.
```
原来只警告不换地方。而**水会把 `/fill keep` 填的方块冲走**，
所以在湿地上永远整不平。

**修法**：检测到水/岩浆就**自动换址**（半径 12→56 试探 12 个方位，
找干燥且地形可用的位置）。实测生效：
```
Hazard: 32 water block(s) near the site.
Relocating: searching for a dry flat spot instead of building here.
Moved the site to a drier spot: (-124,-246).
```

### bug 2：目标高度取了最低点
```js
const targetY = flat.y - 1;   // flat.y = minY+1 → 目标 = 最低点
```
以最低点为目标 = 要把整片都填上来，土方量最大，也最容易填不满。

**修法**：改用**中位数**，挖填量最小。

### bug 3：填坑深度写死 6 格
```js
/fill ... ${TY - 6} ... keep
```
落差超过 6 格就填不满。实测「铲平后仍有 3 格高差」正是这个原因。

**修法**：改成 20 格深。

### bug 4（我的低级错误）：ReferenceError
我给 `levelGround` 写了 `options?.fillDepth`，但**该函数签名里根本没有 `options` 参数**：
```
ReferenceError: options is not defined
```
导致铲平**完全没执行**。她因此说「看来这技能自己搞不定」。
**修法**：去掉该引用，改成常量。这个错误本可以被单元测试拦住。

### 附带：NATURAL_BLOCKS 白名单太少
原来只有 8 行、约 50 种。而**最常「高出一格」的恰恰是草和花**
（`short_grass`/`tall_grass`/`dandelion` 等）。白名单缺它们就永远挖不掉。

**修法**：扩到 96 种，覆盖所有树种、花草、竹子、甘蔗、苔藓、深板岩矿石等。

## 113. 当前状态：诚实评估

**已确认可用**：
- 房间布局计算（10 个箱子位、无相邻合并、上方留空、全部贴墙）
- 自动避水换址（实测换到 -124,-246）
- 自动铲平会触发（`mode: fill`）
- 地形预检会拒绝不合格场地

**仍未完全跑通**：
在 `(-124,-246)` 那次实测中，铲平后仍有 3 格高差，所以 `ok:false` 没建成。
原因是当时的填坑深度只有 6 格 + 白名单缺花草。**这两处刚修完，还没重新实测**。

也就是说：**布局和防护逻辑是验证过的，但「在真实不平地形上一次建成」还没有成功案例。**
下次要做的第一件事就是拿修复后的版本再跑一次。

---

# 第十九：箱子朝向修正 + 铲平策略改向（2026-10-20 20:35）

> 备份：`backups\facing-20261020-203224\`

## 114. 用户指出的问题：箱子朝向不对

**对，这是我的疏漏。** 箱子有 `facing` 状态（`north/south/east/west`），
决定锁扣（正面）朝哪一面。我原来调用
```js
safePlace(bot, 'chest', x, y, z)   // 完全没有 facing
```
`placeBlockWithoutBreaking` 不保证朝向，结果箱子可能锁扣朝墙、正面贴墙，
既难看又不像仓库。

## 115. 正确规则：背靠墙、正面朝走道

箱子 `facing` 指**锁扣所在那一面**（玩家从这一面打开）。所以：

| 位置 | 背靠 | 正面应朝 | facing |
|---|---|---|---|
| 北墙（z 最小） | 北墙 | 南（+z，走道方向） | `south` |
| 南墙（z 最大） | 南墙 | 北（-z） | `north` |
| 西墙（x 最小） | 西墙 | 东（+x） | `east` |
| 东墙（x 最大） | 东墙 | 西（-x） | `west` |

## 116. 实现：用 /setblock 精确指定朝向

```js
async function placeChestFacing(bot, x, y, z, facing) {
    // 位置已有东西 -> 跳过（不破坏）
    // 否则 /setblock ... minecraft:chest[facing=south]
    // 失败则退回普通放置（朝向不保证）
}
```

**实测验证**（不是推测）：
```
放 facing=south 的箱子，用方块谓词逐一判定：
  判定 facing=south: ✔ 匹配
  判定 facing=north: 不匹配
  判定 facing=east:  不匹配
  判定 facing=west:  不匹配
```
说明 `setblock` 的 facing 确实生效且语义正确。

布局脚本校验（10 个箱子位）：
```
(-2,-2) north墙 facing=south 朝向走道 ✔
(-2, 4) south墙 facing=north 朝向走道 ✔
(-2, 0) west墙  facing=east  朝向走道 ✔
( 4, 0) east墙  facing=west  朝向走道 ✔
...
全部朝向走道: ✔
```

## 117. 铲平策略改向：优先找天然平地

**实测证明"铲平"这条路的根本问题**：
```
铲平前: 地面高差 3 格
铲平后: 地面高差 4 格   ← 越铲越糟
```

原因：`/fill air replace <材质>` 是**按材质逐条挖**的。
挖掉支撑地面的方块会产生**新坑**，而填坑用的是另一批命令，追不上。
在起伏地形上，这个"先挖后填"的快速模式本质不可靠。

**新策略**：
1. **先在半径 8~56 格内找天然平坦的地方**（八方位 × 7 个半径）
   - 判据：`surveyFlatArea` 高差 ≤1 且上方净空
   - 同时排除有水的（水会冲掉建筑）
2. 找不到才退回铲平（仅作兜底，并明确告知不可靠）

这样绝大多数情况**根本不需要动土**，直接找块平地盖。

## 118. 当前状态（诚实）

**已验证可用**：
- 箱子朝向（背靠墙、正面朝走道）—— 用方块谓词实测确认
- 房间布局（10 位、无相邻合并、上方留空、全部贴墙）—— 脚本校验
- 自动避水换址（实测从 -136,-246 换到 -124,-246）
- 天然平地搜索（刚实现，未实测）

**仍未跑通**：
「一次调用就建出完整仓库」还没有成功案例。
原因是之前的选址都落在起伏地形上，而铲平不可靠。

**下一步**：拿"找天然平地"的版本再测一次。如果附近 56 格内确实没有平地，
那就需要考虑换个方位或换个区域建仓库，而不是硬铲。

---

# 第二十：仓库建造进展与未解决项（2026-10-20 21:30）

> 备份：`backups\groundfix\` `setblock\` `floorfix\`

## 119. 本次修掉的 4 个真问题

### ① 手放需要依附方块 → 改用 /setblock（最大突破）
原来用 `placeBlockWithoutBreaking`，它内部要走 `placeBlock`，
而 `placeBlock` **必须先找到一个能贴的实心面**。盖房间时地板下方常是空气，
于是报 `Cannot place chest at (...): nothing to place on.`，**一个方块都放不上**。

改用 `/setblock`（bot 有 OP）。这条路径已被 `buildFromSchematic`（3784 块）验证过。

**实测**：403 条 setblock 全部成功，失败 0 条。

### ② 地板铺不上（0/81）
`safePlace` 的保护逻辑是「目标格有别的实体方块就不动」，
但地板本来就要盖在草地上 —— 草块被当成"已有建筑"，于是 81 格地板一块没铺。

修法：保护逻辑只挡**玩家建筑**，自然地形（`NATURAL_BLOCKS` / `NOT_GROUND`）允许被覆盖。

**实测**：地板 81 块铺出来了。

### ③ 树冠被当成"地面"
`surveyFlatArea` 找地面时用 `isSolidOpaque`，而**树叶和原木的 boundingBox 也是 block**。
一棵树就能让高差虚高 8 格，于是永远"地面不平"。

修法：新增 `NOT_GROUND` 集合 + `findGroundY()`，找地面时跳过树叶/树干/花草/雪。

### ④ y 语义不一致
不平的时候返回 `medianY`（地面高度），平的时候返回 `minY+1`（地面上方一层），
而调用方统一 `-1`，导致目标高度差一格。已统一为「地面方块的 y」。

## 120. 策略改变：优先找天然平地

**实测证明铲平不可靠**：
```
铲平前: 高差 3 格
铲平后: 高差 4 格   ← 越铲越糟
```
`/fill air replace <材质>` 按材质逐条挖，挖掉支撑会产生新坑，填坑追不上。

新策略：先在半径 8~56 格、八方位找天然平地（高差≤1、无水火），找不到才铲平。

**实测生效**：
```
Ground here is not flat. Searching for a naturally flat spot nearby.
Found naturally flat ground at (-81,-235), 16 blocks away. No digging needed.
```

## 121. 现在能建出什么（实测）

```
Warehouse done: 0 chests, 92 walls, 81 ceiling, 81 floor, 3 torches, door at (-80,-238)
```

用正确坐标复查确认房子真实存在：
```
cobblestone=254, torch=3, air=324（内部空间）
```

**所以：地板、墙、天花板、门、火把都能建出来了。**

## 122. 仍未解决：箱子放不进去

`Warehouse done: 0 chests`，服务端日志里**一条箱子命令都没有**。
说明箱子循环在到达之前就退出了。

已加诊断日志 `Chest plan: N spot(s) for M categories`，但两次实测**这行日志都没出现**，
说明函数在更早的地方 return 了（最近一次是在"找平地"阶段反复换址消耗掉了）。

**另一个暴露的问题**：自动避水换址会换到更差的地方 ——
上一次从 `(-81,-235)`（旁边 71 格水）换到 `(-109,-219)`，**旁边还是有 71 格水**。
换址逻辑只检查了首个候选的小范围，没有全局评估。

## 123. 我在这个问题上的失误（如实记录）

1. **方向错了很久**：一开始执着于"把不平的地方铲平"，
   而没有先想"为什么不直接找平地"。这个判断本该第一步就做。
2. **反复加补丁而没有先验证根因**：自动换址、自适应深度、扩白名单…
   每次都是修一个表象，下一轮又冒出新的。
3. **`options` 未定义的低级错误**：导致铲平完全没执行，浪费了一轮实测。
4. **验证坐标算错**：让 bot 扫描 y 60-68，而房子建在 y=69-73，
   于是得出"一个方块都没建"的错误结论，又白追了一轮。

## 124. 下一步建议

这个技能的复杂度已经超出"一次对话内可靠做完"的范围。建议：

**方案 A（推荐）：拆成两个独立技能**
- `buildStorageRoom(bot)` —— 只建房间外壳（已验证可用）
- `fillRoomWithChests(bot)` —— 只负责往已有房间里摆分类箱

分开后每一步都能独立验证，出问题也好定位。现在的问题是"一串步骤中某一步静默失败"，
外面看不见。

**方案 B：把换址逻辑做得全局一些**
先扫描周围一片、给每个候选打分（平坦度、水量、距离），选最优，
而不是"找到第一个凑合的就用"。

**方案 C：接受交互式做法**
建房间 → 让人确认位置 → 再摆箱子。牺牲自动化换可靠性。

---

# 第二十一：仓库拆分后全部跑通（2026-10-20 22:20）

> 备份：`backups\split-20261020-221159\`、`backups\split3-20261020-221508\`

## 125. 拆分方案生效

按上次建议拆成三个独立技能，每步可单独验证：

| 技能 | 职责 |
|---|---|
| `skills.findStorageSite(bot)` | **只选址**，只读世界不改方块 |
| `skills.buildStorageRoom(bot, {x,z})` | **只建外壳**（地板/墙/顶/门/火把） |
| `skills.fillRoomWithChests(bot)` | **只摆箱子**（先验证房间存在） |
| `skills.buildStorageWarehouse(bot)` | 三步合一，每步单独打印 |

## 126. 分步实测：三步全部成功

### 第 1 步 选址
```
Best site: (-151,-260) floor y=65, 28 blocks away, 6 candidate(s) evaluated, wet samples=0.
```
**关键改进**：现在会评估**多个候选并打分**（水量 × 100 + 距离），
而不是"找到第一个凑合的就用"。6 个候选里选了 0 个水样本的那块。

### 第 2 步 建外壳
```
Building room at (-151,-260), floor y=65, using oak_planks (480 available, ~110 needed).
  floor: 74
  walls: 84
  ceiling: 81/81
  torches: 4
Room OK: floor=74 walls=84 ceiling=81 torches=4.
```

### 第 3 步 摆箱子
```
Room found at (-151,-260). Placing 6 chest(s) from 10 spot(s), chest material: 12.
Chests placed: 6 ok, 0 skipped.
```

### 实地核实（不只看日志）
让 bot 扫房间范围统计方块：
```
oak_planks=254, chest=6, torch=4, air=421
```
服务端日志复核：
```
chest setblock 命令 6 条，全部带 facing
  /setblock -153 66 -262 minecraft:chest[facing=south]   ← 北墙，正面朝南（走道）
  /setblock -153 66 -256 minecraft:chest[facing=north]   ← 南墙，正面朝北（走道）
  ...
总 setblock 382 条，Changed 382，失败 0
```

**仓库真的建成了。**

## 127. 拆分为什么解决了问题

之前所有失败都源于"一串步骤串联，某步静默失败，外面看不见"。
拆开后立刻定位到问题所在：

- 第 1 步单独跑 → 确认选址逻辑没问题（之前怀疑它换到更差的地方，实测证明打分是有效的）
- 第 2 步单独跑 → 确认房间能建（之前 `floor=0` 是自然地形被当成"已有建筑"挡住了）
- 第 3 步单独跑 → 加了一条"先验证房间存在"的检查，房间不在就直接报错而不是静默失败

## 128. 又一个关键发现：JSDoc 必须写在函数体内

拆分后 `always_show_skills` 报"找不到文档"，排查发现：

项目 `docHelper` 的提取逻辑是：
```js
let str = skillFunc.toString();          // 只拿到函数体
if (str.includes('/**')) { ... }
```

**`toString()` 不包含函数上方的注释**。所以：
- ❌ 写在 `export async function xxx(...) {` **上面** → 提取不到
- ✅ 写在 `function xxx(...) {` **内部第一行** → 能提取到

我的三个新函数一开始写在了上面，全部提取失败。
移到函数体内 + 结尾用 `**/`（不是标准 `*/`）后，`always_show` 恢复 **28/28 命中**。

**这条约定值得记住**：本项目所有技能函数的 JSDoc 都写在函数体内，且以 `**/` 闭合。

## 129. 最终产物

一个能用的仓库系统：

```
                    ┌─ 天花板（81 块）
   [箱] . [箱] .    │  火把 4 个
   ─── 走道（她站这）───
   [箱] . [箱] .    │  6 个分类箱：矿石/木材/建材/食物/工具/杂物
                    └─ 2x2 门洞
```

- 箱子**贴墙、格子留空**（不合并成大箱子、不混分类）
- 箱子**正面朝走道**（facing 已实测验证）
- 有地板/墙/天花板/门/照明
- 位置**自动选**（评估多个候选，优选无水且平坦的）
- 三份代码分别可独立调用、独立验证

---

# 第二十二：补齐搁置项（2026-10-21 00:40）

> 备份：`backups\pending-20261021-003236\`

## 130. 新增 6 个技能

| 技能 | 作用 |
|---|---|
| `verifyChest(bot, pos?)` | **实地开箱核对**，修正过期的 contents 记录 |
| `markDanger(bot, x,y,z, reason, radius)` | 记住某处危险（岩浆/坑/怪物），重复记录会累加 hits |
| `isSafeHere(bot, x?,y?,z?)` | 某处安全吗（查记忆危险区 + 附近水火 + 12格内敌对生物） |
| `recordTaskProgress(bot, id, total, done, note)` | 长任务存进度 |
| `resumeTask(bot, id?)` | 中断后读出进度，从断点接着做 |
| `clearTask(bot, id)` | 清掉已完成/放弃的任务 |

两个新命名空间（`memory/dangers.json`、`memory/tasks.json`），
走已有的分域存储 —— 新增技能不用碰其他文件。

## 131. 实测结果

### verifyChest（真实环境）
```
No chest at (-137,64,-246) - the record is stale, forgetting it.
```
**这正是设计目的**：它发现记录里的箱子已经不存在了，自动忘掉这条记录，
而不是让 `findItemInStorage` 一直返回假地址。

### markDanger + resumeTask
```
Marked danger at (-138,63,-248) r=6: lava pit.
Task "build_test": 40/100 done (40%), 60 left, note: 测试.
```

### isSafeHere（修 bug 后）
```
(-138,63,-248) NOT safe: known danger here (lava pit, 1x).
isSafeHere: safe=false, reasons=known danger here (lava pit, 1x), dangers=1, hostiles=0
```
坐标正确、检测到记忆危险区、明确返回 `safe=false`。

## 132. 途中修掉的一个 bug

`isSafeHere` 第一次跑输出 `(-138,63,0) looks safe` —— **z 变成了 0**。

原因是我写成了：
```js
z: z == null ? Math.floor(z === undefined ? p.z : z) : Math.floor(z),
```
`z` 传 `null` 时走的是 `Math.floor(null)` = `0`，而不是用 `p.z`。
正确写法：
```js
z: z == null ? Math.floor(p.z) : Math.floor(z),
```

这个 bug 导致安全检查**永远查错位置**，而且返回"安全"，
属于最危险的那类错误 —— 明明有岩浆却报安全。
幸好实测时看了坐标才发现。

## 133. 隔离测试（不依赖模型）

任务进度与危险区逻辑单独验证：
```
任务持久化: ✔ 1200/3784 (32%) note=./schematics/house.litematic
剩余: 2584
未完成任务数: 1 ✔
危险区持久化: ✔ {"x":100,"y":64,"z":200,"radius":8,"reason":"lava pit",...}
重复记录 hits 累加: ✔ 2
半径内判定(3格): ✔ 命中
半径外判定(28格): ✔ 不命中
```

## 134. 当前技能总数

- `skills.js` 导出 **76 个**函数
- `always_show_skills` **34 个**，实测 **34/34 命中**

## 135. 这些技能怎么配合使用

```
盖长任务前：
  checkLoadout()        看工具/食物够不够
  isSafeHere()          确认工地安全
  planMaterials()       算材料缺口
  guardInventory()      腾格子

干活过程中（每 N 步）：
  recordTaskProgress()  存进度

中断/重启后：
  resumeTask()          读出断点，接着做

收工后：
  storeItem() / tidyInventory()   归位
  verifyChest()                   核对记录是否准

出事时：
  markDanger()          记住这里危险
  下次 isSafeHere() 会拦住
```

---

# 总结：全部改动与踩过的坑（2026-10-21 01:00）

> 12 个提交，15 个文件，+5911 / -73 行
> `skills.js` 74 个函数 + `world.js` 21 个 = **95 个技能**
> `always_show_skills` 34 个，实测 34/34 命中

---

# 一、改动总览

## 1. 新增文件（4 个模块 + 1 张蓝图）

| 文件 | 行数 | 作用 |
|---|---|---|
| `src/agent/library/memory_store.js` | 168 | **分域持久化**：一个领域一个 JSON 文件，原子写入、损坏不崩、自动迁移 |
| `src/agent/library/schematic.js` | 174 | **litematic 解析器**：自己实现 gzip+NBT+位解包（prismarine-schematic 解析不了） |
| `src/agent/library/storage.js` | 139 | **仓储分类**：按用途分 6 类 + 箱子容量计算 |
| `schematics/house.litematic` | 5.6 KB | 你的房子蓝图（32×17×32，3784 块，54 种材料） |

## 2. 修改的核心文件

| 文件 | 改动 |
|---|---|
| `src/agent/library/skills.js` | +1613 行，从 47 个函数扩到 74 个 |
| `src/agent/agent.js` | 死亡处理重写、autoEat 适配 5.x、memory_bank 挂到 bot |
| `src/agent/library/landmarks.js` | 底层换成 memory_store，对外接口不变 |
| `src/agent/library/skill_library.js` | always_show 从 6 个扩到 34 个，修复前缀串味 bug |
| `src/agent/coder.js` | 修复 linter 正则误判 |
| `start.bat` | 自动探测 Node/Java，不再写死路径 |

## 3. 新增的技能（按功能分组）

### 寻路与动作（修 bug 为主）
- `gotoWithTimeout()` 内部封装 —— 所有 pathfinder 调用都有硬超时
- `goToPlayer()` 重写 —— 水平/垂直分开判定 + 转身面向 + 重试 3 轮
- `makeRoomForBot()` —— 卡住时只拆天然地形自救

### 建造
| 技能 | 说明 |
|---|---|
| `placeBlockWithoutBreaking()` | 安全放置，绝不拆方块 |
| `fillAreaSafely()` | 区域填充，只填空地 |
| `findFlatBuildingSpot()` | 找平地盖房 |
| `findBuildingSite()` / `levelGround()` / `prepareBuildingSite()` | 选址 + 平地 |
| `buildHouse()` | 火柴盒房子 |
| `buildFromSchematic()` | **按蓝图精确建造** |
| `describeSchematic()` / `listBlueprints()` | 看蓝图信息 |

### 仓储（三层）
| 技能 | 说明 |
|---|---|
| `setupStorage()` | 划定仓库区 |
| `findStorageSite()` | **选址**（评估多候选，优选无水+平坦） |
| `buildStorageRoom()` | **建外壳**（地板/墙/顶/门/火把） |
| `fillRoomWithChests()` | **摆分类箱**（贴墙、朝走道、留空防合并） |
| `buildStorageWarehouse()` | 三步合一 |
| `storeItem()` / `tidyInventory()` / `listStorage()` | 存/整理/查看 |
| `findItemInStorage()` | 东西在哪个箱子 |
| `verifyChest()` | **实地核对**，修正过期记录 |

### 状态与安全
| 技能 | 说明 |
|---|---|
| `checkLoadout()` | 工具耐久/食物/空格体检 |
| `planMaterials()` | 材料缺口 + 合成/采集路径推导 |
| `guardInventory()` | 采集前腾格子 |
| `surveyInventory()` / `reportStatus()` | 背包/状态快照 |
| `markDanger()` / `isSafeHere()` | 危险区记忆与检查 |
| `recoverDeathItems()` | 死后捡物品（带送死保护） |

### 记忆与任务
| 技能 | 说明 |
|---|---|
| `listKnownSites()` / `listBlueprints()` | 查记住的地点 |
| `recordTaskProgress()` / `resumeTask()` / `clearTask()` | 长任务进度与续做 |

---

# 二、踩过的坑（按性质分类）

## A 类：我自己的低级错误（4 个）

### A1. `options` 未定义 → 铲平根本没执行
给 `levelGround` 写了 `options?.fillDepth`，但那个函数签名里**没有 `options`**：
```
ReferenceError: options is not defined
```
后果：自动铲平完全没跑，我却以为是"地形太差"。
**教训**：改函数体前先看函数签名。

### A2. `isSafeHere` 的 z 坐标永远为 0
```js
z: z == null ? Math.floor(z === undefined ? p.z : z) : Math.floor(z)
//                z 传 null 时走 Math.floor(null) = 0
```
后果：**安全检查永远查错位置，而且返回"安全"** —— 明明有岩浆却报安全。
这类「错得很自信」的 bug 比直接报错危险得多。
**教训**：安全类函数必须有实测用例，不能只靠"看起来对"。

### A3. linter 正则误判 → 她以为函数不存在
```js
const skillRegex = /((?:skills|world)\.(.*?))\(/g;   // 非贪婪
```
她写 `typeof skills.setupStorage + ...; if (...)`，
正则一路滑到后面的 `if (`，抓出 `skills.setupStorage; if` 这个**假函数名**，
报"函数不存在"。
**修**：`/\b((?:skills|world)\.[A-Za-z_$][\w$]*)\s*\(/g`

### A4. 验证坐标算错 → 误判"没建成"
让 bot 扫描 y 60-68，而房子实际建在 y 69-73，
于是得出"一个方块都没建"的错误结论，白追了一轮。
**教训**：验证前先确认坐标来源（从服务端日志还原，而不是凭印象）。

## B 类：对机制的误解（5 个）

### B1. `peer` 需要依附方块 → 一个方块都放不上
`placeBlock` 内部必须先找一个能贴的实心面。
盖房间时地板下方常是空气，报：
```
Cannot place chest at (...): nothing to place on.
```
**修**：改用 `/setblock`（bot 有 OP），这条路径已被 3784 块蓝图验证过。

### B2. JSDoc 必须写在函数体内
`docHelper` 用 `skillFunc.toString()` 提取，而 **`toString()` 不包含函数上方的注释**。
- ❌ 写在 `export async function xxx()` 上面 → 提取不到，模型看不见
- ✅ 写在函数体内第一行 → 能提取
- 且结尾要用 `**/` 而不是标准 `*/`

**这条踩了两次**（写新技能时又犯）。

### B3. 树冠被当成"地面"
`surveyFlatArea` 用 `isSolidOpaque` 找地面，而**树叶/原木的 boundingBox 也是 block**。
一棵树就让高差虚高 8 格，永远"地面不平"。
**修**：加 `NOT_GROUND` 集合，找地面时跳过树叶/树干/花草/雪。

### B4. 箱子上方必须留空气
箱子占 1 格，**上方必须没有不透明方块**才能打开。
所以房间净高至少 3（地板/箱子/开箱空间/天花板）。
火把、玻璃这类非完整方块不挡。

### B5. 相邻箱子会合并成大箱子
箱子有 `type: single/left/right`。水平相邻且朝向一致会合并成 54 格大箱子。
如果不希望两个分类混在一起，**箱子之间必须留 1 格**。

## C 类：方向性错误（3 个，代价最大）

### C1. 执着于"把不平的地方铲平"
实测证据：
```
铲平前: 高差 3 格
铲平后: 高差 4 格   ← 越铲越糟
```
`/fill air replace <材质>` 按材质逐条挖，**挖掉支撑会产生新坑**，填坑追不上。

**正确思路本该是第一步就想**：盖 9×9 的房间，为什么不直接找一块已经平的地？

改成「优先找天然平地」后一次就成功：
```
Found naturally flat ground at (-81,-235), 16 blocks away. No digging needed.
```

### C2. 反复加补丁，没有先验证根因
在仓库问题上连续加了：自动换址 → 自适应填坑深度 → 扩 NATURAL_BLOCKS 白名单…
每轮修一个表象，下轮又冒新的。
**教训**：症状反复出现时，先怀疑方向，而不是继续加补丁。

### C3. 把"多步串联"做成一个函数
`buildStorageWarehouse` 一条链跑完选址+铲平+建壳+摆箱，
某步静默失败时**外面完全看不见**，只能看到最终的 `ok:false`。

**拆成三个技能后立刻定位到问题**：
- 第 1 步单独跑 → 确认选址有效
- 第 2 步单独跑 → 确认房间能建（`floor=0` 是自然地形被当成"已有建筑"挡了）
- 第 3 步单独跑 → 加"先验证房间存在"，不在就直接报错

### C4.（原 D 类提前）目标高度取最低点
```js
const targetY = flat.y - 1;   // flat.y = minY+1 → 目标 = 最低点
```
以最低点为目标 = 要把整片填到最低高度，土方量最大。
**改**：用中位数。

## D 类：环境与工具链（5 个）

### D1. 浅克隆导致推送失败
```
remote: fatal: did not receive expected object a44dba38...
```
`is-shallow-repository: true`，只有 2 个提交，
`f6a9556` 是合并提交但父提交缺失，push 时校验失败。
**解**：建孤儿分支 `main`，让当前代码成为独立根提交。

### D2. SSH 私钥被加了密码短语
`ssh-keygen -N '""'` —— PowerShell 把这对引号当成**两个真实双引号字符**，
`ssh-keygen` 把它们当密码短语。表现是 `Server accepts key` 后仍 `Permission denied`。
**诊断法**：`ssh-keygen -y -f 私钥` 卡住 = 有密码，立即返回 = 没有。

### D3. Windows 下孙进程日志丢失
`main.js` 用 `stdio:'inherit'` spawn 子进程，
但 `Start-Process -RedirectStandardOutput` 对**孙进程**重定向不可靠。
结果 agent 进程的 `console.log` 全丢，一度以为代码没执行。
**解**：用 `cmd.exe /c "... > live.log 2> live.err.log"` 包装。

### D4. `execute if block` 在 RCON 下不可靠
校准实验：放 `stone` 后立刻验证，`setblock` 说"已改变"，但判词返回 **False**。
**唯一可靠**：计分板法
```
execute store result score v obj if block X Y Z minecraft:方块名
scoreboard players get v obj     # 1=有 0=没有
```

### D5. 探针命令污染她的聊天
用 RCON 反复执行 `scoreboard players set v pr2 -999`，
每条都作为聊天广播给她，几十条后她的回复退化成 `\t*****`，
记忆里还被写成"用户反复Rcon将[pr2]设为-999"。
**解**：`gamerule sendCommandFeedback false`。

## E 类：模型行为（3 个）

### E1. 记忆会被错误结论固化成事实
linter 报错 5 次后，她把「**我无 setupStorage/createChests 功能**」写进长期记忆。
之后无论怎么解释，她直接回「真的不行啦」，**连试都不试**。
**解**：停 bot → 改写 `memory.json` 那段 → 重启，第一次就成功。
**教训**：遇到「她坚信某功能不存在但代码确实有」，先怀疑记忆污染。

### E2. 消息里带 `!` 会被当作用户命令
`agent.js:279` 检测到 `!` 开头的命令就**直接执行，跳过模型推理**。
所以 `say 小D，用 !newAction 检查...` 她完全没反应。
**正确**：用不带感叹号的自然语言。

### E3. 她会谎报成功
说"建好啦"，实际一个方块没建；说"3784 块全放上"，需要核实。
**根因**：动作成功与否是**模型自己写在 `log()` 里的文字**，没有自动校验。
**对策**：技能内置自检（放置后 `bot.blockAt` 复核）、返回结构化结果、用服务端日志交叉验证。

## F 类：CoreProtect 的坑（2 个）

### F1. `action` 码读反了
`co_block.action`：**`1` = 放置（PLACE）**，`0` = 移除/被替换。
我一度把 `1` 当 BREAK，得出"她在拆房子"的错误结论（实际房子好好的）。

### F2. CoreProtect 不记录指令改动
不记录 RCON/控制台 `setblock`，也基本不记录玩家用 `/fill` 的批量改动。
**结论**：核实世界必须直接读方块，不能只信数据库。

---

# 三、几条通用经验

1. **先验证机制，再写代码**。箱子能不能开、能不能合并、JSDoc 从哪取 ——
   这些花 2 分钟查，能省掉 2 小时的错误方向。

2. **症状反复出现 → 怀疑方向，而不是继续加补丁**。
   铲平连改三轮都不行，说明"铲平"本身不是答案。

3. **多步串联要拆开**。每步能单独跑、单独返回，
   失败点才看得见。这是仓库问题最终解决的唯一原因。

4. **安全类函数必须有实测用例**。
   `isSafeHere` 返回"安全"但坐标是 0 —— 这种错误不看实测数据发现不了。

5. **"日志说成功" ≠ "验证对了"**。
   我自己就两次误判：一次坐标算错、一次探针方法不可靠。
   交叉验证（服务端日志 + 实地读方块）才靠谱。

6. **改函数体前先看函数签名**（`options` 那次）。

7. **文档必须写在模型看得见的地方**，否则等于没写。

---

# 第二十三：不重复造轮子——用现成规范改「模型怎么用技能」（2026-10-21 10:30）

> 需求原话：「看全部改动和踩坑总结，我希望不要重复造轮子。你去找已经做好的 skills
> 试着优化游戏中 ai 的行为。」

## 136. 第一步先查：外部到底有什么现成的

动手前先把「能抄的」查清楚，避免又造一个轮子。结论是**上游没有可抄的代码**：

| 对比项 | 上游 mindcraft (develop) | 本地 fork |
|---|---|---|
| `skills.js` 函数 | **38 个** | **74 个** |
| `world.js` 函数 | 21 个 | 21 个（一致） |
| 上游有、本地没有的 | **0 个** | — |
| 本地新增的 | — | 36 个 |

> 结论：我们的 fork 比上游超前，`git fetch` 拉上游学不到东西。
> 所以「现成资产」不是上游代码，而是**已经发表的做法/规范**。

真正被复用的两个现成资产：

1. **Agent Skills 渐进披露规范**（agentskills.io/specification）
   - 第 1 层「目录」：只给 `name + 一句话说明`，每个技能约 50–100 tokens；
   - 第 2 层「说明」：模型确定要用时，再加载完整文档；
   - 第 3 层「资源」：本项目的技能是 JS 函数，没有附带脚本，这层不适用。
2. **Voyager 的 critic 判定规则**（NVIDIA，`voyager/prompts/critic.txt`）
   - 给模型一堆**世界事实**（背包/方块/箱子/血量/坐标），让它判 `success: true/false`；
   - 关键是每种任务「该看哪个字段」写得死死的：
     挖矿看背包、合成看成品、建造看方块、存箱看箱子、吃东西看饥饿值。

## 137. 改之前先量化：prompt 里到底塞了多少东西

用 `getSkillDocs()` 实测（脚本：`tmp/test_skill_library.mjs`）：

```
技能总数: 87
全部文档字符: 45,349
always_show 34 个:  22,518 字符   ← 每次 !newAction 都重复付一遍
其中最长: buildHouse 1449 / placeBlock 1433 / prepareForBuilding 1367
```

而 `relevant_docs_count: 15` + 34 个 always_show ≈ **30k 字符**，且**只有 49/87 个技能模型看得见**，
剩下 38 个它完全不知道存在，只能瞎编函数名或自己拼 `breakBlockAt` 循环。

## 138. 改动（3 个文件 + 1 个配置）

### ① `skill_library.js` 重写为渐进披露

- 新增 `skill_index`：`{name, summary, doc}`，summary 取文档正文第一句；
- 新增 `getSkillCatalog()`：87 个技能全量目录，`- skills.foo — 一句话`；
- 新增 `getSkillDoc(name)`：按名取完整 JSDoc，支持省略 `skills.` 前缀，
  找不到时给「你是不是想找…」候选；
- `getRelevantSkillDocs()` 输出改成：**全量目录 + 少量全文 + 使用说明**；
- `always_show_skills` 从 **34 个砍到 6 个**，只留「不看文档就会用错、且用错代价大」的：
  `placeBlockWithoutBreaking` / `breakBlockAt` / `wait` / `surveyInventory` /
  `reportStatus` / `makeRoomForBot`。

### ② 新增两个命令（`queries.js`）

| 命令 | 作用 |
|---|---|
| `!skillDoc("skills.foo")` | 取某个技能的完整文档（参数/返回值/示例） |
| `!checkTask("任务是什么")` | 摆出世界事实 + Voyager 判定规则，逼她先判真伪再说话 |

`!checkTask` 没有写任何新逻辑，全是拼现成的：
`!stats`（坐标/血量/饥饿/生物群系/时间）+ `!inventory` + `!nearbyBlocks` +
`skills.reportStatus()`（威胁/空格子/记住的箱子）。

### ③ `settings.js`

`relevant_docs_count: 15 → 6`（全量文档数量，目录不受影响）。

### ④ `profiles/llmgo.json` 两条硬规则

- 说「完成啦」之前必须先 `!checkTask`，证据对不上就说还差什么；
- 不确定函数怎么用就先 `!skillDoc`，不许猜参数、不许编函数名。

## 139. 实测结果（隔离测试，13 项全过）

```
技能条数: 87 | 目录字符: 7,446
新版 $CODE_DOCS 字符: 12,927    ← 原来约 30,000
COMMAND_DOCS 字符: 8,618
PASS 目录覆盖全部技能 / 每条都有说明 / 摘要不超长
PASS getSkillDoc 取到全文(1449) / 支持省略前缀 / 未命中给候选
PASS !skillDoc、!checkTask 已注册且能被 getCommand 找到
PASS !checkTask 不崩、含判定规则、含禁谎报要求
```

一句话：**每次代码生成的技能文档从 ~30k 字符降到 ~12.9k，可见技能从 49 个变成 87 个。**

## 140. 踩到的三个坑

### 坑 1：循环依赖把测试打挂了（TDZ）

`queries.js` 顶层 `import { getCommand } from './index.js'`，而 `index.js` 第 7 行
`queryList.concat(actionsList)` 在模块求值期就要用 `queryList`。
只要**先**加载 `queries.js`，就报：

```
ReferenceError: Cannot access 'queryList' before initialization
```

这个循环本来就有（原来只 import `getCommandDocs`，函数调用时才用到，所以没炸）。
**修**：`!checkTask` 里改成调用时 `await import('./index.js')`，不给模块求值期添新环。

> 教训：往已有循环依赖里加顶层 import，等于给未来的自己埋雷。测试的 import 顺序
> 还要和真实启动顺序一致（先 `commands/index.js`）。

### 坑 2：`docHelper` 截出来的正文带 `*` 和 `@param`

`docHelper` 是 `substring(indexOf('/**')+3, indexOf('**/'))`，所以正文每行开头都是
`*`，后面还跟着一堆 `@param/@returns`。第一版摘要直接 join，目录里变成：

```
- skills.activateNearestBlock — * Activate the nearest block of the given type.
```

**修**：逐行去 `*` 前缀、丢掉 `@` 开头的行，再取第一句。

### 坑 3：环境权限（和代码无关，但会卡住流程）

- bash 执行器**不能写** `mindcraft/` 和 `backups/`（连 `touch` 都 Permission denied），
  但文件写入工具可以写 `mindcraft/`，bash 只能写 `tmp/`；
- 所以：**改代码用文件工具，备份放 `tmp/backup-skilldocs/`，bash 只读+跑 node**；
- `git add` 同样被拒（`.git/index.lock: Permission denied`），**这一轮没有提交**，
  提交命令留在下面。

## 141. 还没做的（如实说）

1. **没有联网实测**：MC 服务器当时没开（`25565` 无监听、无 java 进程），
   所以只做了隔离测试，行为层面的效果要等她真的跑起来才知道。
2. **没验证 `!checkTask` 在真实世界里的输出长度**：`!inventory` + `!nearbyBlocks`
   在大背包/复杂地形下可能很长，届时再看要不要截断。
3. 想让「按需加载」更省一步，可以后续把 `$CODE_DOCS` 里自动带上的 6 篇
   也改成只给目录——但先看这版的实测表现，别一次改太多。

## 142. 下一步怎么验

```bat
:: 1) 起服
cd /d E:\我的世界ai\server && java -Xmx4G -jar paper-1.21.8-60.jar nogui
:: 2) 起 AI
cd /d E:\我的世界ai\mindcraft && node main.js
```

观察三件事：

1. 让她建点东西，然后问「建好了吗」——看她会不会先说 `!checkTask`，以及证据对不上时
   会不会还嘴硬；
2. 让她用一个冷门技能（比如 `!skillDoc("skills.buildFromSchematic")`），看目录里
   87 个名字是否够她找到东西；
3. 看 `live.log` 里 `$CODE_DOCS` 的体积是否真的降下来了。

如果想恢复旧行为：把 `skill_library.js` 里 `always_show_skills` 加回那 34 个，
`settings.js` 的 `relevant_docs_count` 改回 15 即可（旧文件备份在
`tmp/backup-skilldocs/`）。

---

# 第二十四：地形热力图 + 贪心规划（2026-10-21 11:10）

> 需求原话：「先规划，后行动」「用热力图的形式会不会更好一点？危险区域绕开，
> 水面、悬崖之类的先进行行为规划，用贪心策略」「128 格就够了吧」「几十秒太慢，
> 先简化地图格式」。

## 143. 为什么不做「逐列存档」，也没用地图插件

调研结论（都是查过的，不是拍脑袋）：

| 方案 | 结论 |
|---|---|
| **BlueMap / Dynmap / squaremap** | 服务端渲染的网页地图，**实时更新**没错，但产物是**渲染好的像素/网格**，读不出「这列地表几格、什么方块、有没有水」。机器可读的只有玩家位置/标记 → 只能回答「她在哪」，回答不了「路怎么走」 |
| **逐列存档 + `.mca` 离线全图** | 数据精确，但要装 `prismarine-provider-anvil`、读 20MB 区域文件，**几十秒**才出结果（用户明确否掉） |
| **自己扫 `bot.blockAt` 逐列** | 又慢又只看得到身边，还容易把「未加载」误判成「没地面」 |
| **✅ 热力图（采用）** | 128 格半径压成 65×65 代价网格，**几千个数字**，重算是毫秒级；危险=禁行，水/崖=高价但可走，交给上层做行为决策 |

顺带确认的事实：`prismarine-chunk 1.41.0` + `prismarine-world 3.7.0` **已随 mineflayer 装好**，
服务器 `view-distance=8` → 实时可见半径正好 **128 格**，和需求对得上，不需要任何新依赖。

## 144. 新增 `src/agent/library/heatmap.js`

| 导出 | 作用 |
|---|---|
| `makeBotAdapter(bot)` | 给 (x,z) 找地表，返回 `{y, block}`；竖扫限制在脚下 ±16，避免扫穿世界 |
| `buildHeatmap(adapter, cx, cz, opts)` | 建图：`heights`(地表 y) + `flags`(位掩码) + `cost`(代价) |
| `planGreedy(hm, from, to)` | 贪心优先，**卡住自动切 A\*** |
| `planAStar(hm, from, to)` | 同一张图上的 A*（几千格，毫秒级） |
| `renderAscii(hm)` | 字符画，调试和塞进 prompt 都用它 |
| `costAt(hm, x, z)` | 查某点代价 |

**代价表**（全在 `DEFAULT_COSTS`，随时调）：

```
平地 1 | 下一格 2 | 上一格 3 | 坡 6 | 树 4 | 水 12 | 悬崖 20 | 未加载 40 | 岩浆/火/玩家建筑/危险区 255(禁行)
```

关键设计：**水/悬崖不是禁行，是高代价**——因为你要的是「先做行为决策」，
如果直接判禁行，路线就断了；给高价则贪心会自然倾向绕开，真要走也能走，
并由 `actionFor()` 标出 `swim / pillar_up / drop_down / clear_or_around`，
上层据此决定「游泳还是绕路」。

## 145. 实测（隔离测试 15 项全过，合成地形）

合成地形：平地 + 河 + 岩浆池 + 6 格高悬崖 + 树。规划从 `(-40,4)` 到 `(60,4)`：

```
网格 65x65 | 4225 单元 | 构建 1-4ms | surfaceAt 调用 4225 次（每单元一次）
识别：未加载 3201 / 水 96 / 岩浆 6

规划结果：ok=true  reason=astar_fallback  步数=25  累计代价=98
动作统计：walk 20, swim 3, step_up 1, pillar_up 1
PASS 岩浆=禁行(255) / 水面=12可走 / 未加载=40可走 / 平地=1
PASS 没有一步踩进岩浆池 / 没有一步进入禁行格
PASS 目标在岩浆里时如实拒绝(goal_forbidden)
PASS 上悬崖标出 pillar_up（需要行为决策）
```

字符画（每格 8×8，北在上）：

```
    56 ·········~.··##·?
    24 ·········~.··##·?
     8 ·········~.··##·?
     0 ·········~.·X##·?
   -24 ·········~.··##·?
```
`~` 河、`X` 岩浆、`##` 悬崖、`?` 未加载边界。

## 146. 这一轮抓到的 3 个真 bug（都是测试抓的）

### bug 1：采样点和步点错开半格（最严重）

建图时按 `originX + i*cell`（**格子角**）采样，输出步点时却用**格子中心**。
结果岩浆池被记到了隔壁单元 —— **规划照着一张错位的图在走**，能从岩浆边上"穿"过去。

**修**：采样也改用 `originX + i*cell + floor(cell/2)`，和 `indexToWorld()` 对齐。
> 教训：建图和查询必须共用同一套坐标约定，否则错位是静默的。

### bug 2：纯贪心在悬崖前"走通了但绕得离谱"

悬崖整条都有代价 20，贪心发现「往前走代价陡增、原地更便宜」，于是沿崖底来回蹭，
**460 步才到**（正常 25 步）。它没超步数上限，所以兜底根本没触发。

**修**：把贪心的步数预算改成「直线距离 × 2.5 + 40」，超了判失败 → 自动切 A*。
现在 `reason=astar_fallback`，25 步。

> 这和 README 第 C2 条（反复加补丁不验根因）是同一类：**贪心不是不能用，是不能没有兜底**。

### bug 3：我自己写的测试断言是错的

断言「x=63 是未加载」，但半径 128 的图里那地方其实是实地。改成 x=120 才对。
> 教训：断言写错比代码写错更危险——它会给你一个假的"全绿"。

## 147. 下一步（还没做）

1. **接进技能**：`surveyArea` / `planRoute` / `mapStatus` 三个命令，`goToPosition` 改成
   「先规划后行动」（走 waypoints），失败回写热力图（`blocked`）。
2. **真实性能未测**：4225 次 `bot.blockAt` 的真实耗时取决于地形（见到地表就停），
   必须在真服上量一次，慢的话把 `cell` 调到 8（单元数降到 1089）。
3. **持久化**：热力图本身压成 RLE 存 `bots/<名字>/heatmap.json`，只存危险区和已探范围。
4. **BlueMap**：只为「你自己用眼睛看」，**不接进规划器**。下载地址
   <https://modrinth.com/plugin/bluemap>（认 `BlueMap-5.16-paper.jar`），扔进
   `server/plugins/`，默认 `localhost:8100`。
   > 本机 shell 没有可用 TLS（`curl` 报 `SEC_E_NO_CREDENTIALS`），jar 需要手动下载。

---

# 第二十五：危险区加「1 格精确轮廓」+ 两级规划（2026-10-21 11:35）

> 需求原话：「我们把危险区域加个细轮廓不就可以了？」「1 格 / 1 格 / 终点细化开」

## 148. 为什么这个方案比我原来的两阶段更好

我原来提的是「整条走廊都算细图」，等于**用面积换准确**。加细轮廓之后，
准确度和面积解耦了：

```
粗栅格 cell=8   → 只负责地形代价（高差/坡/水/树）
细轮廓 cell=1   → 只负责「哪里绝对不能进」（岩浆/火/仙人掌，精确枚举 + 膨胀 1 格）
```

三条好处：粗阶段不再靠采样猜危险；不会「有危险就整格涂黑」误伤窄通道；地形探针数量不变。

## 149. 三个决定成败的细节（都实现了）

### ① 危险不靠采样，靠 `bot.findBlocks` 精确枚举

`cell=8` 的点采样完全可能跳过 3×3 的岩浆池（测试①专门证明了这点）。
改用 `bot.findBlocks({matching, maxDistance, count})` 枚举危险方块，聚成团块：

```js
collectHazards(bot, { radius: 128 })
→ [{ x0:10, z0:10, x1:13, z1:12, type:'hazard', count:12 }, ...]
```

相近的合并成矩形，一块岩浆池只留一条记录，落盘只有几 KB。

### ② 轮廓必须膨胀 1 格

岩浆/火有流体扩散，**视觉边界 ≠ 判定边界**。不膨胀的话路线会贴着最外圈擦过去。
实现是 Chebyshev 3×3 外扩（`HAZARD_DILATE = 1`）。

### ③ 粗单元按「覆盖比例」给代价，不是一刀切

```
覆盖 ≥ 50% → 255 禁行（核心区）
0 < 覆盖 < 50% → 200 软惩罚（强烈绕开，但没别的路时允许过）
```

不这样会被误伤：一个 8×8 粗单元只被岩浆蹭到一角就封死，唯一的窄通道也就没了。

## 150. 关键发现：粗图表达不了「3 格宽通道」，所以轮廓还得当校验器

测试③暴露的真问题：3 格宽通道在 `cell=8` 下，两侧的粗单元覆盖都过半 → 都禁行，
**粗图直接把通道堵死**。反过来如果只给软惩罚，路点又可能正踩在膨胀圈里。

所以 `planHierarchical()` 加了一条硬规则：

> **粗路径算出来后，必须拿 1 格精确掩膜逐个校验路点。任何落在轮廓里的路点都触发局部细化。**

触发细化的两种情况：

| 触发 | 条件 | 结果 |
|---|---|---|
| `hazard_on_waypoint` | 路点踩进危险轮廓 | 细图重规划，reason = `refined_for_hazard` |
| `goal` | 接近终点（洞里/屋里/箱子旁） | reason = `reached_with_goal_refinement` |
| `coarse_failed` | 粗规划整个失败 | 细图兜底，reason = `coarse_failed_fine_ok` |

而且**细图对危险用零容忍**（`hazardMode: 'strict'`：沾到一点就禁行），
粗图才用覆盖比例——两级语义不同是故意的。

## 151. 实测（隔离测试 44 项全过）

| 测试 | 验证什么 | 结果 |
|---|---|---|
| ① | 采样漏掉的 3×3 岩浆被轮廓抓住 | cost 1 → **200**，膨胀后正好 25 像素 |
| ② | 擦边只加价、覆盖过半才封死 | 25% → 200，100% → 255 |
| ③ | 两片铺满整幅的岩浆湖只留 3 格通道 | 粗图 `goal_forbidden` → **细图钻过去**，23 步全在通道内 |
| ④ | 终点细化 | `reached_with_goal_refinement`，最后一步 (21,1)，距目标 1.4 格 |
| ⑤ | 空旷地形不被误封 | 直接通 |
| ⑥ | `collectHazards` 团块合并 | 12 格岩浆 → 1 块，孤立点单独 1 块 |

```
危险轮廓测试: 27 PASS / 0 FAIL
基础热力图测试: 17 PASS / 0 FAIL
```

## 152. 这一轮抓到的 2 个真 bug

### bug 1：终点细化的入口点算到了细图窗口外 → 静默失效

原来用「离目标 `fineRadius` 内第一个路点」再往前退一格当入口，结果那个点
**在细图窗口之外**，`planGreedy` 直接返回 `start_outside_map`，细化悄悄没生效
（`reason` 还是 `reached`，看起来一切正常）。

**修**：入口改成「**已经在细图窗口内**的第一个路点」（`firstInside`），
并断言 `fine.reason !== 'start_outside_map'`。
> 教训和 A2（`isSafeHere` 坐标恒为 0）同类：**静默失效比报错危险**，所以现在细化失败会在
> `fine.reason` 里留下痕迹，测试也钉住了这一点。

### bug 2：我自己把测试断言写错了（又一次）

`flags[12 * w + 17]` 是手算的单元下标，实际应该是 `j*w+i = 17*33+17`。
**修**：改用 `worldToIndex()` 算，不再手写。
> 第二次犯（第一次是 x=63 当成未加载）。**手写坐标/下标就该一律用函数算**。

## 153. 还没做的

1. **接进技能**：`surveyArea` / `planRoute` / `mapStatus`；`goToPosition` 改成走 waypoints。
2. **真实性能未测**：`bot.findBlocks(maxDistance=128)` 的耗时还没在真服上量过。
   如果超过 300ms，退路是限制 y 范围只扫地表附近，或复用上次枚举结果。
3. **持久化**：团块列表 + `seenAt` 存 `bots/<名字>/hazards.json`（几 KB），
   重扫时增删——**岩浆可能被填掉，轮廓必须有失效机制**，否则会永久封死一块地。

---

# 第二十六：把热力图接成技能（2026-10-21 11:45）

## 154. 新增 3 个技能（87 → 90）

| 技能 | 作用 | 是否动世界 |
|---|---|---|
| `skills.surveyArea(radius)` | 探地形，返回摘要 + 字符画（危险点/未加载/水在哪） | ❌ 只读 |
| `skills.planRoute(x, z)` | **只规划不动身**，返回途经点 + 动作序列 + 风险 | ❌ 只读 |
| `skills.goToPositionPlanned(x, z)` | 按规划逐段走，自动绕开危险轮廓 | ✅ 会走 |

三个都进了 `always_show_skills`（6 → 9），模型一进来就知道「先探、再规划、后行动」这套。

**设计上刻意不动老函数**：`goToPosition` 保持原样。理由是新路线会改变所有走路行为，
先并存跑一轮看质量，别一次换掉所有东西（README C2 的教训）。

## 155. 实现中踩到的两个坑

### 坑 1：`goToPosition` 不能传 null y

第一版我写 `goToPosition(bot, w.x, null, w.z, near)`，但它的第 2 行就是：

```js
if (x == null || y == null || z == null) { log('Missing coordinates'); return false; }
```

所有途经点直接失败。**修**：改用 pathfinder 的 `GoalNearXZ`——它本来就是为
「只要 XZ、没有确切 y」设计的：

```js
await goToGoal(bot, new pf.goals.GoalNearXZ(w.x, w.z, near));
```

> 教训：调用现成函数前先看它的参数校验，别假设「null = 用当前值」。

### 坑 2：摘要文案会自相矛盾

`surveyArea` 最初报告「危险点 1 处、禁行 0 格」——读起来像 bug。实际是**几何**：
一个 4×4 的岩浆池正好压在 `cell=8` 的网格边界上，被切进 4 个格子，
每格覆盖都不足 50% → 全是「擦边软惩罚」，没有一格到「封死」。

**修**：文案改成报告「**受危险影响 N 格（封死 a、擦边 b）**」。
> 教训：给用户/模型看的摘要，不能只报一个会让人误解的单一数字。

## 156. 实测（隔离测试 66 项全过）

```
基础热力图        17 PASS / 0 FAIL
危险轮廓 + 两级规划  27 PASS / 0 FAIL
技能层            22 PASS / 0 FAIL
```

技能层覆盖：

- 三个技能文档都能被 `docHelper` 提取（>200 字符，模型看得见）
- `surveyArea`：认出危险点、摘要不说矛盾话、字符画非空、**写进 `bot.output`**
  （这点很关键——不写 output 模型就看不见结果，等于白做）
- `planRoute`：绕开岩浆、途经点不在膨胀圈内、目标在岩浆里时**如实拒绝**
- 过河时标 `swim` 而不是硬走

lint：我改的三个文件零新增问题（剩 32 条都是既有代码的 `require-await` 风格问题）。

## 157. 还没做

1. **真实性能未测**：`collectHazards` 里 `bot.findBlocks(maxDistance=128)` 的耗时
   还没在真服上量过。这是接技能后唯一可能翻车的点（同步函数，卡住会挡事件循环）。
2. **`!survey` / `!plan` 命令**：现在只能通过 `!newAction` 写代码调用，
   加两个直接命令会更顺手（像 `!stats` 那样）。
3. **persist 危险团块**：带 `seenAt` 存盘，重扫增删。

---

# 第二十七：真服实测（2026-10-21 11:55）

> 提交 `8fcdcc3`

## 158. 实测方法

不起完整 agent，**先用裸 mineflayer bot 连服只量性能**（不发指令、不乱动），
避免 agent 的行为干扰测量；测完再起真 agent 验行为。

坑：脚本放 `tmp/` 里会报 `Cannot find package 'mineflayer'`（模块解析从脚本位置开始），
放 `mindcraft/` 下才找得到 `node_modules`。

另一个坑：裸 bot 刚 spawn 就等着会被踢 —— `Invalid move player packet received`。
**必须先等 `bot.entity.onGround` 再等 2-3 秒**，不能一上来就空等。

## 159. 第一轮实测：2047ms，正好是我担心的地方

```
findBlocks(maxDistance=128, count=4096)   1004 ms   ← 占 98%
collectHazards                             992 ms
buildHeatmap(cell=8)                        15 ms   ← 建图很快
planHierarchical                            36 ms   ← 规划很快
──────────────────────────────────────────────────
合计                                      2047 ms   ⚠️ 同步阻塞 2 秒，心跳必超时
```

**参数扫描**（这是关键，不猜）：

| 配置 | 耗时 | 找到 |
|---|---|---|
| maxDistance=128, count=4096 | 1000 ms | 454 |
| maxDistance=128, count=512 | 985 ms | 454 |
| **maxDistance=64, count=512** | **183 ms** | 110 |
| maxDistance=32, count=512 | 51 ms | 63 |

结论：**耗时与「扫描体积」成正比，和 `count` 基本无关**——`findBlocks` 必须扫完
整个半径才肯停（要凑够 count 个才提前 break，而 128 格内根本没那么多危险方块）。

**试过但失败的优化**：想在 `matching` 里按 y 过滤只扫地表。
崩了：

```
TypeError: Cannot read properties of null (reading 'y')
  at isBlockInSection → Block.fromStateId(stateId, 0)
```

mineflayer 的 `isBlockInSection` 会用一个**没有 position** 的临时方块去查 section palette，
matcher 里碰 `p.position` 就炸。所以 y 过滤这条路走不通。

**修**：`collectHazards` 默认 `radius 128 → 64`、`count 4096 → 512`。

## 160. 修完：236ms

```
collectHazards    204 ms  -> 6 团块
buildHeatmap        8 ms  -> 17x17
planHierarchical   24 ms  -> ok=true, 19 途经点
────────────────────────
合计              236 ms  ✅ 不阻塞心跳
```

## 161. 实测发现的两个地形判定 bug（只有真数据才暴露）

### bug 1：水里被判成悬崖 → 海边地图 60% 格子涂满 `#`

第一版地图长这样，`#` 连成片，完全没有区分度。

原因：水下的地表高度落差大（海岸线从 y=62 到 y=78），而悬崖判定只看「相邻格高差 ≥4」。

**修**：**水的格子不判悬崖，也不拿水格当高差参照**。
水下深一点只是"游泳深一点"，不是悬崖；水的代价（12）本来就该主导。

### bug 2：`cliffDiff=4` 在 cell=8 下太敏感

改完水之后，陆地上仍有 46% 被判成悬崖。这次用数据说话：

| cliffDiff (cell=8) | CLIFF 占陆地 |
|---|---|
| 4 | **51%** |
| 6 | 28% |
| 8 | 19% |
| 10 | 12% |

根因：`cell=8` 时「相邻格子」实际相距 **8 格**，真实地形里 8 格爬升 4 格太常见。

**修**：阈值随 cell 缩放 —— `cliffDiff = max(4, ceil(cell * 0.75))`（cell=8 → 6）。

**修完的地图**（可读了）：

```
  -155 ·~~~:~~~~~~~~~~~~
  -195 ·.~:::····.#~~~~~
  -219 #::·.·.·.#!X####~
  -243 ····:·#####·::···
```
`·`平地、`:`缓坡、`#`真悬崖（零散条带）、`!`危险擦边、`X`危险封死、`~`水。

## 162. 行为实测：她自己学会用了（最强验证）

起真 agent，用另一个玩家号进去说话（**注意不能带 `!`，否则会被当命令直接执行**，README E2）：

> 「小D，先用 surveyArea 看看你周围 64 格的地形，然后用 planRoute 规划一条到 x+40 z+10 的路线」

她的回复：

> 扫描结果：半径64格扫完啦，可达289格，水33格，岩浆0、树0。**危险影响19格（封死6、擦边13），一共10处危险点**。诶嘿，主要是我之前标记的那块 lava pit 在捣乱~
>
> 路线到 (-97,-237) 是通的！**一共13个路点，走10段、爬台阶2次、柱子上升1次**，总距离约42格，没触发什么大风险。**要我真的沿着这条走吗？**

四条都验到了：

| 验证点 | 证据 |
|---|---|
| 技能目录注入生效 | prompt 里出现 `skills.surveyArea` / `skills.planRoute` 两项 |
| 她自己会调用 | 自己写了 `!newAction(...)` → `skills.surveyArea(bot, 64)` |
| 数据正确 | 19 格 = 封死 6 + 擦边 13，和脚本测的一致 |
| **"先规划后行动"成立** | 她**主动问「要我真的沿着这条走吗」**，没有擅自出发 |

日志原文（`live-test.log:232`）：

```
surveyArea @(-138,-248): 扫了半径 64 格（每格 8x8）：可达地形 289 格，
未加载 0 格；受危险影响 19 格（封死 6、擦边 13）；水 33 格、岩浆 0 格、树 0 格。
危险点 10 处（已合并），用时 7ms。
```

## 163. 实测中发现的另外两件事（都不是这轮引入的）

### ① 等模型响应时会 `ping timeout` 掉线

```
Disconnected from MindServer: ping timeout
Received.   ← 模型响应其实已经回来了
```

发生在 `Awaiting openai api response` 期间——**等 API 时主线程没空回 socket.io 心跳**。
这是既有架构问题，和 236ms 的规划无关（差了两个数量级）。已记录，未动。

### ② `Action output is very long (605 chars) and has been shortened.`

`surveyArea` 返回的 ASCII 地图被截断了，她可能看不到完整地图。
如果想让她真看全，得考虑只给她**摘要 + 局部切片**，而不是整张 17×17 图。

## 164. 当前状态

| 项 | 结果 |
|---|---|
| 探查 + 规划耗时 | **236 ms**（原来 2047ms） |
| 隔离测试 | 66 项断言全过 |
| 真服行为 | 她自己会探、会规划、会先问再动 |
| 提交 | `d02ba63`（接技能）→ `8fcdcc3`（调参） |
| 服务器 | 实测完仍在运行（PID 23188） |

---

# 第二十八：地图其实从没被她看到过（2026-10-21 12:05）

> 提交 `932dabb`

## 165. 问题：500 字符截断把地图「腰斩」

上一轮实测日志里有这么一行，我当时只当是"输出有点长"：

```
Action output is very long (605 chars) and has been shortened.
```

实际 `action_manager.js:161` 的实现是：

```js
const MAX_OUT = 500;
if (output.length > MAX_OUT) {
    output = `... First outputs:\n${output.substring(0, MAX_OUT/2)}
    ...skipping many lines.
    Final outputs:\n ${output.substring(output.length - MAX_OUT/2)}`;
}
```

**只保留前 250 + 后 250 字符，中间整块丢弃。** 而 `surveyArea` 的返回值里，
地图正好排在中间（摘要 → 地图 → 图例），于是：

- 她收到了：摘要 ✓、路线信息 ✓
- 她没收到：**整张地图** ✗

回看她的回复，她确实**一句都没提地图**——因为根本没看到。
但她自己也不知道自己没看到。这就是这个项目里反复出现的**静默失效**：
数据在中间被吃掉，没有报错，双方都以为一切正常。

## 166. 修法：两处一起改（只改一处不够）

### ① 让地图本来就小：降采样

`renderAscii(hm, marks, { maxWidth: 9 })`，按块取**「最严重」**的字符：

```
X(禁行) 10 > !(擦边) 9 > ?(未加载) 7 > ~(水) 6 > #(悬崖) 5 > T(树) 3 > 平地 1
```

为什么取最严重而不是平均：**安全地图上不能把危险平均掉**。
一个降采样块里有 1 格岩浆，整块就得显示成危险——否则她会以为那里能走。

同时返回 `blockSize`（一格代表几格）和 `covers`，并在图例里说明
「每格约 16 格，精度只看方向」——否则她会拿这张粗图当精确坐标用。

### ② 抬高上限：500 → 1500

一次结构化技能输出（摘要 98 + 图例 70 + 地图 152 = 322 字符）本来就接近 500，
再多两行 log 就超。1500 足够容纳结构化结果，循环打印几千行的情况仍被兜底截断。

### ③ 顺带：地图上标出「我在哪」

用 `@` 标自己、`G` 标目标。这一条看似可有可无，实际决定了地图能不能用——
没有 `@`，一张全是符号的图对模型毫无意义。

## 167. 修的时候又踩一个

`const maxWidth = Math.max(3, Math.floor(opts.maxWidth ?? 0))`
——想给个下限 3，结果**不传 maxWidth 时也变成 3 列**了（`Math.max(3,0)=3`），
默认行为被悄悄改掉。测试立刻抓到（`默认宽度 = 网格宽度 17` FAIL）。

**修**：`opts.maxWidth ? Math.max(3, floor(...)) : 0` —— 没传就不降采样。

> 这是"默认值表示不启用"和"下限保护"打架的经典写法错误。
> 又一次说明：**回归测试必须覆盖"不传参数"的默认路径**。

## 168. 实测对比（同一台服，同一片地形）

| | 修复前 | 修复后 |
|---|---|---|
| 输出行 | `Action output is very long (605 chars) and has been shortened.` | `Action output:` |
| 她收到地图 | ❌ 整块丢失 | ✅ 完整 9×9 |
| 她的回复 | 只复述摘要数字，**一句没提地图** | 见下 |

她现在的原话：

> 图上 X 是我之前标记的 lava pit 那片。就在我 **@ 的正西边**——第 **-240 行**左边一个 X，
> 再往西北 **-224、-208** 那行也有 X，一路斜着往西北延伸，大概贴着我西侧 10~50 格。
> 另外 **-288、-304** 那行西北角也有 X!，方向还是**西偏北**。
>
> 我脚下 @ 本身还算稳，就是**别往西走太近**啦~ 要绕的话**往东或南**走会安全点！

她做到的五件事，一个都不能少：

1. 看到完整地图（含 `@` `X` `#` `!`）
2. **用行首 z 坐标定位**（"第 -240 行"）
3. **用 `@` 认出自己**在图里哪个位置
4. **推出方向结论**（正西边 / 往西北延伸 / 西偏北）
5. **给出可执行建议**（往东或南走），并理解精度提示（"每格约16格，只看方向"）

## 169. 测试

新增 `tmp/test_map_output.mjs`（14 项断言）：

- 输出预算：322 字符 < 500（连旧上限都不撞）< 1500
- 地图 9 行、每行 ≤9 列
- `blockSize` / `covers` 有返回
- **危险不被降采样平均掉**（小块里的岩浆仍显示 X/!）
- `@` 标记出现
- **不传 maxWidth 时保持原样**（这条抓出了上面那个 bug）
- 截断阈值边界（1500 不截、1501 才截、实测的 605 在新上限下安全）

回归：原有 66 项断言全过。lint：我改的 3 个文件零新增（`action_manager.js`
的 4 条都是既有代码的 14/18/57/145 行）。

## 170. 剩下的

1. `ping timeout`（等模型响应时心跳断线）——既有架构问题，未动。
2. 危险团块持久化 + `seenAt` 失效机制。
3. `!survey` / `!plan` 直接命令（现在只能走 `!newAction`）。

---

# 第二十九：修掉三件遗留（2026-10-21 12:45）

> 提交 `f231fd4`（连接）/ `56a1dc1`（记忆）/ `c3b1d17`（命令）

## 171. ① 控制通道抖动不再杀进程（ping timeout）

之前实测看到 `ping timeout` → agent 重启，当时判断"不是我这轮引入的"就放过了。
这次查完整条链，**是个真 bug**：

```
等模型 API 期间心跳超时（默认 pingTimeout 20s，偏紧）
  → socket.io 断连
  → 自动重连，但每次连接尝试也要 20s 超时
  → 而重连宽限期只有 30s，勉强够 1.5 次尝试
  → 宽限期到，cleanKill
  → 子进程 exit code 1
  → agent_process.js 判定"非正常退出"，重启
```

玩家侧看到的就是**她突然不见了**。

四处一起改：

| 位置 | 改动 |
|---|---|
| 客户端 transport | 默认 `['polling','websocket']` → **`['websocket']`**（本地回环没必要先长轮询再升级，多一层故障面） |
| 客户端超时 | pingTimeout 20s→60s、连接 timeout 30s、重连退避 500ms~3s、无限次重试 |
| 服务端 | `new Server(server)` → `pingInterval 25s / pingTimeout 60s` |
| 重连宽限 | 30s → **120s**（够 5~6 次尝试） |

外加一条：`connect_error` 只在**首连失败**时 reject。原来连上之后每次重连失败都会
往一个早就 settle 的 Promise 上 `reject`（无效操作），日志里那句 `Connection failed: timeout`
就是这么来的，误导排查。

**实测**：连续 7 轮问答（多次模型长等待）→ **0 次 ping timeout、0 次重启**。

## 172. ② 危险团块持久化 + 重扫失效

危险是长期的（岩浆一直在），但**也会变**（玩家填掉、水冲走）。所以不能只叠加也不能只替换。

合并规则（`heatmap.mergeHazardBlobs`）：

| 情况 | 处理 | 为什么 |
|---|---|---|
| 本次扫到 | 更新 `seenAt`、`hits+1`、矩形取并集 | 越老越不可信，hits 记确认次数 |
| 在扫描范围内、却没再扫到 | **删除** | 说明被清理了 |
| 在扫描范围外 | **保留** | 这次没查 ≠ 没有 |
| 超过 TTL（10 分钟）没复核 | 失效 | 太久不敢当真相 |
| 缺 `seenAt` 的旧数据 | 按「刚见过」处理并盖章 | 见下 |

最后那条是刻意选的方向：**忘掉岩浆会导致走进岩浆，多记一条只是多绕路**。
但盖章之后如果一直没再观测到，TTL 到期照样失效——不会变成永久封锁。

实现上没造新轮子：`memory_store.js` 本来就有 `registerNamespace`，加一个
`hazards` 命名空间即可（和手工标记的 `dangers` 分开：一个是人标的，一个是世界枚举的）。

**实测**：7 条团块落盘，重扫后 `hits` 2→3 累加、**数量仍是 7**（没有重复堆积），
跨进程继续累积。

## 173. ③ `!survey` / `!plan` 直接命令

之前这两个只读操作也得走 `!newAction` 写代码，绕一大圈。

```
!survey                    → 摘要 + 9x9 地图（349 字符，351ms）
!plan(x, z)                → 途经点 + 动作标注（273 字符，332ms）
```

`!survey` 不设参数——64 是实测安全值（危险枚举 183ms；128 格要 1 秒会掉心跳）。

实际输出示例：

```
去 (-109,-217) 可行：17 个途经点，动作 walkx14, pillar_upx2, step_upx1，直线约 42 格
途经点：1.(-150,-235) 2.(-142,-243) 3.(-134,-251) pillar_up 4.(-126,-243) step_up …
```

## 174. 意外收获：她自己会质疑规划结果了

压力测试时她对这个规划的评价：

> 诶？这路线有点怪呀，目标是往东，可途经点先往西南跑了一大圈诶……
> 是不是中间被悬崖和水挡住了绕路呀？

这正是这套设计想要的：`!plan` **只规划不动身**，她拿到路线后能自己审一遍再决定。
第 162 节那次她问"要我真的沿着这条走吗"，这次她能指出"这条路绕"，说明她真的在读途经点，
不是机械复述。

## 175. 本轮测试

```
test_heatmap         17 PASS / 0 FAIL
test_heatmap_hazard  27 PASS / 0 FAIL
test_skills_heatmap  22 PASS / 0 FAIL
test_map_output      14 PASS / 0 FAIL
test_hazard_memory   21 PASS / 0 FAIL   ← 本轮新增（记忆合并/失效/命令注册）
────────────────────────────────────
合计                101 PASS / 0 FAIL
```

lint：改的 6 个文件零新增问题（剩下的全是既有代码的 `require-await` / `semi` / `process 未定义`）。

## 176. 修的过程中抓到的语义错误

`mergeHazardBlobs` 最初写的是「调用方没给扫描范围 → 当成全部重扫过 → 删掉旧记忆」。
测试里那条 `不给 scanned 也不崩` 直接挂了。

这个错很隐蔽：调用方不传范围时，**它并不是说"我扫了全部"，而是说"我没告诉你范围"**。
按"扫过"处理等于静默清空所有旧知识——又是静默失效。

改成：范围未知 → 当作没查过 → 保留（靠 TTL 自然失效）。

## 177. 现在整个地图链路的全貌

```
!survey / surveyArea ──┐
                       ├─→ collectHazardsCached ─→ findBlocks 精确枚举
进服/重扫 ─────────────┘         │                    （64 格，183ms）
                                 ├─→ mergeHazardBlobs ←── memory_store 'hazards'
                                 │     （新观测 ∪ 旧记忆，超期失效）
                                 ↓
                         buildHeatmap（cell=8 地形 + 1 格危险轮廓）
                                 ↓
                    planHierarchical（粗规划 → 路点校验 → 终点细化）
                                 ↓
                       !plan（只看） / goToPositionPlanned（真走）
```

## 178. 还没做

1. **`!survey` 半径写死 64**：想要更大范围得走技能。要支持得改命令参数解析支持可选参数。
2. **没有 `!forgetHazards` 清理命令**：万一记错了只能等 TTL（10 分钟）。
3. **`ping timeout` 只做到"不再杀进程"**：如果根因是主线程被长任务阻塞导致心跳发不出，
   那个根因还在；现在的 60s 容忍度能盖住绝大多数情况。

---

# 第三十：她说"路线有点怪"——查到不是绕路的错，是方向读反了（2026-10-21 13:15）

> 提交 `ef25f93`

## 179. 症状与取证

她在压力测试时说：

> 诶？这路线有点怪呀，目标是往东，可途经点先往西南跑了一大圈诶……
> 是不是中间被悬崖和水挡住了绕路呀？

**先取证，不猜。** 用实测那次的**确切坐标**复现
（起点 `(-149,-227)`、目标 `(-109,-217)`，这两个数是从当时的 `!plan` 输出反推的）：

```
直线距离 41 格
直线采样 15 个点：flat 2、CLIFF 5、HAZARD 8  → 直线代价 1867（直接撞禁行区）
规划：12 步，代价 51
```

**结论：绕路是对的，不是 bug。** 直线上 15 个采样点里有 8 个落在危险轮廓里。

## 180. 真问题在输出层

规划器没错，错在**它不说人话**：

- 只给原始坐标对 + 动作名，**不说"为什么绕"**
- 也**不说"先往哪走"**，模型必须自己从 `(x,z)` 推断方向

而 Minecraft 里 **-Z 是北、+Z 是南**，跟"地图上方是北"一致，但跟一部分人的坐标直觉相反。
她第一段路是从 `(-149,-227)` 到 `(-149,-234)`——**z 减小 7 格 = 正北**，她读成了"西南"。

> 这类"数据给全了但没翻译"的问题，和前面几次静默失效是同一族：
> 信息没缺，缺的是**把它变成对方能直接用的话**。

`Decision: code-change`，所有者 = **规划的呈现层**（规划算法一行没改）。

## 181. 改了什么

| 新增 | 作用 |
|---|---|
| `heatmap.compassOf` | 坐标差 → 中文方位词（东南 / 西南 / 东北 / 西北，**东西在前**符合中文习惯） |
| `heatmap.directLineProfile` | 沿直线**按网格步长**采样，统计沿途 flat/water/cliff/hazard |
| `heatmap.explainDetour` | 拼成人话："直线上有 2 段悬崖、5 段危险区，所以先往西南绕，再往东" |

`planRoute` / `!plan` 输出新增 `direction` / `startDirection` / `why`，并写进 `bot.output`。

实际输出：

```
去 (-106,-222) 可行：目标在东方，但第一步先往西南。17 个途经点，动作 step_downx1, walkx14…
为什么这么走：直线上有 2 段悬崖、5 段危险区，所以先往西南绕，再往东。
```

## 182. 真服又抓出两个 bug（测试没覆盖到）

### bug 1：`why` 永远是空的 —— 字段名对不上

`explainDetour` 里读的是 `plan.steps`，但 `planHierarchical` 返回的字段叫 **`waypoints`**，
第一行 `if (!plan.steps?.length) return ''` 直接短路返回空串。

第一次真服验证时 `带「为什么这么走」的目标数: 0/3`——**功能整个没生效，而且不报错**。

**为什么测试没抓到**：前面的测试都直接调 `planGreedy`（它返回 `steps`），
没人用 `planHierarchical`（返回 `waypoints`）的形状去测。**测试绕过了真实的接缝。**

**修**：`const route = plan?.waypoints ?? plan?.steps;`，两种形状都认。

### bug 2：起点≈终点时输出自相矛盾

目标就在脚下时，`planGreedy` 立刻返回 `reached` 但 0 步，而
`ok = waypoints.length > 0` 判成 `false`，于是输出：

```
去 (-146,-222) 没有可行路线：reached
```

"没有可行路线"和"已到达"是两件相反的事。

**修**：加 `alreadyThere`（距离 ≤ max(2, coarseCell)），返回 `ok=true` + `reason='already_there'`，
输出改成「已经在 (x,z) 附近了，不用走」。

## 183. 还修了一处文案 bug

回归测试里出现了 **"先往原地绕"**——起点和第一个路点重合时 `compassOf` 返回"原地"，
拼进句子就是废话。改成：方向是"原地"或与目标同向时，用「路线不是直的（目标在X方）」。

## 184. 测试

```
test_heatmap         17 PASS
test_heatmap_hazard  27 PASS
test_skills_heatmap  22 PASS
test_map_output      14 PASS
test_hazard_memory   21 PASS
test_direction       23 PASS   ← 本轮新增：方向词/直线剖面/绕行解释 + 上面两个 bug 的回归
─────────────────────────────
合计                124 PASS / 0 FAIL
```

`test_direction` 特意**两种返回形状都测**（`steps` 和 `waypoints`），
并在注释里写明"这个 bug 测试没覆盖到"——避免下一个人（或下一轮的我）再绕过去。

## 185. 方法论收获

这次按「先取证不猜」走，避免了一个典型误判：

- 她的描述（"绕了一大圈，被悬崖水挡住"）**听起来像是规划器有 bug**
- 如果直接去调代价权重/启发式，就会改坏一个本来正确的东西
- 实际测下来：**绕路正确，方向和解释缺失**

> 用户/模型的**抱怨是症状，不是诊断**。抱怨说得越具体（"往西南"），越要先验证它的每个断言
> ——这次就发现她的方向读反了，连"抱怨本身"都不完全对。

## 186. 还没做

1. `!survey` 半径写死 64（要支持可选参数得改命令参数解析）
2. 没有 `!forgetHazards`
3. `ping timeout` 只做到"不再杀进程"，主线程长时间阻塞的根因仍在

---

# 第三十一：清掉最后三件（2026-10-21 14:10）

> 提交 `99fffcd`（可选参数 + forgetHazards）/ `8242f4e`（延迟监控）

## 187. ① 命令支持可选参数

原来解析器要求参数个数**严格相等**：

```js
if (args.length !== params.length)
    return `...was given 0 args, but requires 1 args.`;
```

所以 `!survey` 要么固定 64、要么模型必须随便填个数字。

改成：**尾部声明了 `default` 的参数可以省略**，多传仍然报错（防止模型乱塞参数）。
这是通用改动，以后任何命令都能用 `default` 声明可选参数。

顺带改好报错文案：缺参数时从"given 0 args, but requires 1"（不说是哪个）
改成 **`is missing param 'z'`** —— 告诉模型到底缺什么。

`!survey` 现在：省略 = 64，`!survey(96)` / `!survey(32)` 都行。
实测三种半径分别 **189ms / 444ms / 55ms**（和 scan 体积成正比，符合预期）。

## 188. ② `!forgetHazards`

之前记错了只能干等 10 分钟 TTL。现在可以主动清。

语义边界写进了命令描述里：**Memory only - does not change the world**。
实测她执行后自己就复述对了：

> 清完啦，14处危险记忆都删掉了~ 现在记忆里是干净的，**不过地图上那些危险可没消失呀**，
> 只是我得重新扫一遍才能再记住。要我马上再扫一次重新建个记录吗？

## 189. ③ 主线程阻塞：找不到证据，就把它变成可测

之前我判断 ping timeout 的根因是"等模型 API 时主线程被占住"。
这次认真找了一遍**具体在哪阻塞**：

| 怀疑点 | 检查结果 |
|---|---|
| `prompter._saveLog` / `_saveToFile` | 用的是 `fs.promises`（`await fs.appendFile`），**不是同步** |
| `writeFileSync` at prompter.js:111 | 只在**启动时**写一次 profile，请求路径上没有 |
| 模型请求 | 全是 `await fetch`，不阻塞 |
| `findBlocks(128)` | 1000ms，差一个数量级 |

**没找到 20 秒级的同步阻塞点。**

那就不能硬改一个猜出来的根因（这正是 README C2「反复加补丁不验根因」）。

改成**让它可测量**（`src/utils/loop_lag.js`）：

- 每 500ms 比对 `setTimeout` 的预定时间与实际时间，记录最大延迟
- `unref()` 掉，不阻止进程退出；开销可忽略
- **断线时额外打一行** `[disconnect-diag] 事件循环延迟最大 XXXms`：
  - 延迟很大 → 确实是主线程被占住，下一步去定位那段同步代码
  - 延迟正常 → 不是阻塞，得往 socket / 网络 / 上游 API 慢 方向查

实测：人为 busy-wait 1.5 秒，监控记录到 **1188ms** 并正确判定，
正常空闲时是 **15ms** 且判定为"不是阻塞导致"。

> 这条的价值不在"修好了"，而在**下次出问题不用再猜**。
> 有些根因当下查不出来，正确做法是把它变成一次可观测的实验，而不是编一个解释。

## 190. 测试

```
test_heatmap          17 PASS
test_heatmap_hazard   27 PASS
test_skills_heatmap   22 PASS
test_map_output       14 PASS
test_hazard_memory    22 PASS
test_direction        23 PASS
test_optional_and_lag 15 PASS   ← 本轮新增（可选参数/forgetHazards/延迟监控）
──────────────────────────────
合计                 140 PASS / 0 FAIL
```

## 191. 一个自己写错的断言（值得记）

`!forgetHazards` 之后我断言"重新扫描条数应等于清空前"，结果 10 → 5，报失败。

**其实是断言错了**：清空前那 10 条混入了之前**不同半径扫描**（96/32）累积的旧团块，
清空后只剩当前半径一次扫描的结果。条数变少是正常的。

正确判据不是"条数相等"，而是**连续扫描稳定 + hits 累加 + 危险面积不变**。
用这个重测：

```
清空 -> 第1次扫 5 条/110 格 hits=[1,1,1,1,1]
      -> 第2次扫 5 条/110 格 hits=[2,2,2,2,2]
      -> 第3次扫 5 条/110 格 hits=[3,3,3,3,3]
```

条数稳定、面积稳定、hits 累加 —— 功能是对的。

> 教训：**断言选错了观测点，会把正确行为报成 bug**。
> 这和"断言写错给出假绿灯"是一对：一个假红，一个假绿，都来自观测点选错。

## 192. 到这里的整体状态

| 能力 | 状态 |
|---|---|
| 地形探查 `!survey` | ✅ 可选半径 16~128，347 字符输出 |
| 路线规划 `!plan` | ✅ 说清"先往哪 + 为什么绕" |
| 按规划走 `goToPositionPlanned` | ✅ 途经点校验 + 失败如实报告 |
| 危险记忆 | ✅ 落盘、重扫失效、可手动清空 |
| 控制通道稳定性 | ✅ 0 次 ping timeout（7 轮压力测试） |
| 事件循环延迟 | ✅ 可观测（为下次排查留证据） |
| 技能文档注入 | ✅ 90 个技能全量目录 + 按需取全文 |
| 任务自检 `!checkTask` | ✅ Voyager 风格判定规则 |

## 193. 还能做的（按价值排序）

1. **`!survey` 结果缓存**：短时间内连续扫同一片地形可以复用（现在每次都重算，虽然只要 200ms）
2. **危险记忆的可视化核对**：`!forgetHazards` 只能全清，还不能"删掉某一条"
3. **规划与执行的一致性**：`goToPositionPlanned` 用的是规划时的图，执行途中地形变了不会重新规划
   （现在靠"路段失败就停"兜底，不做途中重规划）

---

# 第三十二：热力图带高度 + 2D 接雨水 + 揪出"走不动"的真根因（2026-10-21 14:50）

> 提交 `6aa87f4`（高度/接雨水）/ `9154750`（寻路异常）

## 194. 用户的两个提法都是对的

> 「热力图带 1 2 3 这样的高度标识不就可以了？你知道"接雨水"算法吧」

我原来的做法是把高度当"隐藏维度"：只在执行失败后补一句高度诊断。那是治标。
用户的意思是 —— **高度本来就在数据里，直接画到图上**。

而「接雨水」正好是算出「相对高度」的工具：绝对 y=62/63/64 在 9×9 图里看不出名堂，
**相对周围凹下去多少**才有意义。

## 195. 接雨水：1D 双指针 → 2D 优先队列渗流

经典「接雨水」是 1D 双指针（左右各自最大值取小）。二维网格要用
**Trapping Rain Water II**：

```
把边界全部丢进最小堆 →
  弹出最低的格子，水位 = max(弹出的水位, 邻居高度)
  邻居水深 = 水位 − 邻居高度，再把邻居压回去
水从边界漫进来，先填满浅处 → 每格算出来就是"下雨后能积多深"
```

`heatmap.js` 里本来就有 A* 用的 `MinHeap`，直接复用（加了 `lastPriority` 记弹出水位），
没造新轮子。

**未加载格当墙**：否则边界外全是"未知高度"，会把整片地图算成一个大水坑。

## 196. 高度数字地图

`renderAscii(hm, marks, { style: 'height' })`：每格输出 **0-9 相对高度**
（按图上 min/max 归一化），`surveyArea` / `!survey` 默认用它。

**安全标记优先级永远高于数字** —— `X`/`!`/`@`/`G` 不会被高度数字盖掉。

真服实测（`@(-148,61,-230)`，371 字符 / 168ms）：

```
扫了半径 64 格：可达 289 格，受危险影响 22 格（封死 6、擦边 16）；
水 61 格、岩浆 0、树 0、洼地 20 格
每格约 16 格，覆盖 144x144 格（实际高度 y=51~77）
0-9 相对高度（9 最高，0 最低）  水=~  悬崖=#  洼地=v  禁行=X  擦边=!  @ 我

  -158 441444444      ← 4 = 她所在海拔档，@ = 她自己
  -206 2!!44!774      ← XX = 禁行(她标的 lava pit)，! = 擦边
  -238 X!444!777
  -270 655557987      ← 西边 7/9 = 高地，东南 5/6 = 中低地
```

## 197. 洼地 = 会积水/会困住 bot 的地方

`FLAGS.PIT` + `costs.pit`：水深 ≥ 2 判为洼地（字符 `v`），**加价但不封死**
（洼地不一定是坏的 —— 她可能就是要下去，比如矿洞）。

## 198. 修了个静默失效：Uint8Array 装不下第 9 个标志位

`FLAGS.PIT = 1 << 8 = 256`，而 `flags` 是 **`Uint8Array`（最大 255）**
→ **256 溢出成 0，标记永远设不上，而且不报错**。

阴在：`stats.pitCells = 64` 统计是对的（那个走的是 depth 数组），
只有真去查 `flags[idx] & FLAGS.PIT` 才暴露 —— 测试 `有 PIT 标记` 当场挂了。

**修**：`Uint16Array`。

> 这类"位掩码宽度不够"的 bug，靠读代码很难发现，必须写断言去查实际位。

## 199. 然后揪出了「一步都不走」的真根因

排查 `goToPositionPlanned` 为什么完全不移动时，沿着"能走 → 不能走"的差异往上钻：

```
裸 pathfinder.goto(GoalNearXZ)        → 能走 6~26 格 ✓
skills.goToGoal(...)                  → Cannot read properties of null (reading 'blocksByName')
```

**两层问题**：

### 根因：`mcdata` 未初始化就抛空指针

`mcdata` 是在 `initBot()` 的 **login 事件**里才赋值的。裸 mineflayer bot
（隔离测试、探针脚本）不走 `initBot` → `mcdata` 为 null →
`getBlockId('glass')` 里 `mcdata.blocksByName` 空指针。

**修**：`getItemId` / `getItemName` / `getBlockId` / `getBlockName` / `getEntityId`
统一加 `if (!mcdata) return null`，返回 null 而不是抛。
`goToGoal` 里 `blocksCantBreak.add(null)` 也改成 `id != null` 才 add。

### 更严重：它被吞掉了

`goToPositionPlanned` 的 catch 只写了 `ok = false` —— 于是
**"代码炸了"和"没路可走"在返回值里完全一样**。

我因此白查了很久：先怀疑高度（以为她在屋顶），又怀疑重规划逻辑，又怀疑热力图。

**修**：记录 `legError`，异常时直接返回 `reason: 'pathfinder_error'` + `error` 信息，
日志打 `寻路抛错: ...`，**不重试也不伪装**。

### 真服验证

修完后 **`goToPositionPlanned` 第一次真正走通**：

```
起点 (-152,64,-216) → 目标 (-164,-228)，距离 18 格
ok=true reason=reached replans=0 用时=3542ms
实际移动 14.8 格，距目标还剩 3.1 格
```

## 200. 这轮最值得记的一条

> **"能走的组件"和"我的封装"之间出错时，先测组件本身。**

我一直在调自己的封装（重规划、高度、热力图），而底层 `goToGoal` 从一开始就是坏的。
正确顺序本该是：**先用最小的裸调用验证底层能力，再查自己的封装**。

这也解释了为什么之前 `!plan`（只规划不算）看起来一切正常 —— 规划路径里
**根本不需要 `mcdata`**，所以规划全对、执行全废。

## 201. 测试

```
test_heatmap          17 PASS
test_heatmap_hazard   27 PASS
test_skills_heatmap   22 PASS
test_map_output       14 PASS
test_hazard_memory    22 PASS
test_direction        23 PASS
test_optional_and_lag 15 PASS
test_forget_cache     18 PASS
test_pit_height       17 PASS   ← 本轮：接雨水正确性/高度数字/洼地
test_pathfinder_error 10 PASS   ← 本轮：mcdata 守卫/异常如实上报
──────────────────────────────
合计                 185 PASS / 0 FAIL
```

接雨水专项用例：中心坑 → 水深 2 ✓；斜坡 → 全 0（不误判）✓；深坑 10 格 → 10 ✓；
未加载格 → 当墙不算坑 ✓。

lint：`mcdata.js` 改动前后都是 13 个既有分号问题，**零新增**。

## 202. 现在的完整能力

| 能力 | 状态 |
|---|---|
| 地形探查 `!survey(半径?)` | ✅ 高度数字地图 + 危险轮廓 + 洼地 |
| 路线规划 `!plan(x,z)` | ✅ 方向词 + 绕行原因 + 高度/落差提示 |
| 按规划行走 | ✅ **真能走了**（本轮修复）+ 途中重规划 + 高度预检 |
| 危险记忆 | ✅ 落盘 / 重扫失效 / 单条删除 / 全清 |
| `!hazards` 列表 | ✅ 带编号、坐标、格数、确认次数 |
| 控制通道 | ✅ 0 ping timeout（7 轮压测） |
| 事件循环延迟 | ✅ 可观测 |

## 203. 还能做的

1. **执行途中地形变化不重规划**：现在靠"路段失败→重规划"兜底，但没有"走一半发现路被封了"的主动检测
2. **`!survey` 结果缓存**：缓存危险枚举（已做），但整张图仍每次重算（8~15ms，可接受）
3. **洼地水深可以用来找水/找矿**：现在只用来避开，没用来做"去哪里挖"的正向决策










