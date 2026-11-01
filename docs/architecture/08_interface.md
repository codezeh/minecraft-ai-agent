# 接驳层：模型、命令、结果、权限

> 2026-11-01 新增。讲模型和系统之间那一层：模型什么时候被叫、它能用哪些命令、结果怎么回给它、谁的话它该听。
> 复合技能怎么暴露（`!do` / `!listSkills`）见 04 §5，任务板命令见 06 §10。

## 1. 一条消息怎么走（现状）

```
聊天 / 私聊（agent.js:202-204，only_chat_with 过滤 :180）
  → handleMessage(source, message)（agent.js:335）→ 拼提示词 → 模型
  → 回复里有 !命令 → executeCommand(agent, message)（commands/index.js:253）→ 结果写回对话历史 → 必要时再叫模型
  → 回复里的文字 → openChat（agent.js:485）→ bot.chat（:507）
```

另外两个入口：`self_prompter`（空闲时按目标催，`agent.js:48`），mode 打断后的 AUTO MESSAGE（`modes.js:360`）。

## 2. 什么时候叫模型

| 触发 | 现在 | 目标 |
|---|---|---|
| 玩家聊天 | 叫 | 叫，带上发言人的等级（§5） |
| mode 打断了动作 | AUTO MESSAGE 叫 | 被打断的是任务单 → 不叫，调度器接着做（07 §4）；不是任务单 → 照旧 |
| 任务单完成 / 失败 / blocked | 无 | 往对话历史塞一行状态（§4 的格式），不立刻叫；同一张单 30 秒内最多一行。玩家下的单完成或失败时叫一次，让模型告诉玩家 |
| 死亡 | 叫（`agent.js:297`） | 叫，附上"回去捡"那张单（07 §7） |
| 空闲 | 有目标就由 `self_prompter` 催 | 有任务单在跑或排队时不催 |

## 3. 命令的去向

`legacy/陪玩改造方案.md §7` 有一版旧命令映射，这里按新分层重排（`actions.js` 44 条 + `queries.js` 21 条）。
**命令名不改**（模型已经会用），只改它们背后调什么。

| 组 | 命令 | 去向 |
|---|---|---|
| 走 | `!goToCoordinates` `!walkTo` `!goToPlayer` `!moveAway` `!goToRememberedPlace` | `flow_goto`（`nav_core.goTo`）。`!goToCoordinates` 现在还走 `skills.goToPosition`（Phase 5.1） |
| 脱困 / 下挖 | `!goToSurface` `!digDown` | `flow_escape` / `flow_tunnel` |
| 跟 | `!followPlayer` `!followEntity` | `flow_follow` |
| 采集 / 制作 | `!collectBlocks` `!craftRecipe` `!smeltItem` `!clearFurnace` | `flow_collect` / `flow_craft` / `flow_smelt` |
| 物品 | `!putInChest` `!takeFromChest` `!givePlayer` `!consume` | `flow_store` / `flow_fetch` / `flow_give` / `flow_eat` |
| 单个动作 | `!equip` `!discard` `!viewChest` `!useOn` `!lookAtPlayer` `!lookAtPosition` | 直接调动作 / 查询 / 原子，不进任务板（07 §2 的即时命令） |
| 建造 | `!placeHere` `!buildPlatform` | `flow_build` / `flow_platform`。`!placeHere` 现在直接 import `atom_place`（`commands/actions.js:8`），Phase 5.4 改调流程 |
| 战斗 | `!attack` `!attackPlayer` | `flow_fight`；`!attackPlayer` 只给主人（§5） |
| 其他 | `!goToBed` `!showVillagerTrades` `!tradeWithVillager` `!searchForBlock` `!searchForEntity` | `flow_sleep` / `flow_trade` / 查询 + `flow_goto` |
| 控制 | `!stop` `!stay` `!stfu` `!restart` `!clearChat` `!setMode` | 控制层（07）；`!stop` 同时暂停自动领单 |
| 目标 | `!goal` `!endGoal` | 留给开放目标（§7）；具体的活由模型用 `!addJob` 落成任务单 |
| 写代码 | `!newAction` | 只给主人（§5） |
| bot 对话 | `!startConversation` `!endConversation` | 只用来聊天；bot 之间分工走任务板（06 §9.4） |
| 查询与记忆 | `!stats` `!inventory` `!nearbyBlocks` `!craftable` `!entities` `!modes` `!savedPlaces` `!rememberHere` `!survey` `!hazards` `!forgetHazards` `!map` `!plan` `!getCraftingPlan` `!searchWiki` `!checkTask` `!help`，蓝图 4 条 | 不变 |
| 换掉 | `!skillDoc` | `!listSkills`（04 §5，D24） |
| 新加 | `!do` `!listSkills` `!addJob` `!addSharedJob` `!jobs` `!cancelJob` `!pauseJob` `!resumeJob` | 04 §5、06 §10 |

## 4. 结果怎么回给模型

一行，不超过 200 字：

```
[单 #12 collect oak_log] 失败 NO_TOOL：采到 3/16。建议：先弄石镐 !do("obtain", "item=stone_pickaxe")
```

每个 code 一句建议，放在 `atom_contract.js` 旁边的 `code_hints.js`：

| code | 建议 |
|---|---|
| `NO_TOOL` | 先 `obtain` 对应工具 |
| `NO_ITEM` | 列出 `missing`，问要不要先 `obtain` |
| `NO_TARGET` | 换个地方，或问玩家 |
| `NO_PATH` / `STUCK` | 换目标；连着两次就问玩家 |
| `INVENTORY_FULL` | 先 `store` |
| `TIMEOUT` | 报进度，问要不要继续 |
| `CLAIM_CONFLICT` | 别的 bot 在做，不用管 |
| 其他 | 原样报 code 和 message |

## 5. 谁的话她该听

**现在的漏洞**：
- `only_chat_with` 为空，谁说话都听（`settings.js:24`）；`allow_insecure_coding: true`（`:33`），任何人都能让她写代码执行；bot 账号是 op
- 回复里的文字直接 `bot.chat`（`agent.js:507`），`agent.js` 里没有拦 `/` 开头的地方：有人诱导模型回一句 `/op 某人`，就以 op 身份执行了

| 等级 | 谁 | 能用 |
|---|---|---|
| 主人 | profile 的 `owner` | 全部，包括 `!newAction` `!setMode` `!restart` `!attackPlayer` `!discard` `!givePlayer` 和白名单里的斜杠命令 |
| 信任 | profile 的 `trusted` | 聊天、走、跟、采集、制作、建造、存取、`!jobs`；下的单最高 6 级 |
| 其他玩家 | 其余所有人 | 只聊天；由他们的话引出的命令一律不执行 |
| 别的 bot | 同一 mindserver 下的 agent | 只聊天；分工走任务板 |

- **按发言人判，不按模型说了什么判**：`handleMessage(source, …)` 已经知道是谁说的；`executeCommand(agent, message)` 加一个 `{ author }` 参数，按等级查命令类别，不够就不执行、回一句。提示词注入改不了等级
- `self_prompter` 发出的命令按设目标的人（`!goal` 的发言人）算；调度器跑的单按 `job.source` 算
- 回复文字：`openChat` 拦 `/` 开头（以后并进原子 `say()`，01 §3.4）；斜杠命令只走 `command()` 的白名单。`agent.js:119-121` 的 `/skin` 也进白名单
- 没配 `owner` 的老 profile 按"信任"处理，所以默认没人能用 `!newAction` 和斜杠命令（行为变化，§8）

## 6. 陪玩的默认行为

| 情况 | 默认 | 怎么做 |
|---|---|---|
| 主人在线、没有任务单 | 跟在主人 3–6 格内（待你定） | 空闲行为，不做成任务单：任何单来了都要立刻让路，做成单还得先抢占它 |
| 主人下线 | 原地待着；记了 home 就回去 | 空闲行为 |
| 主人说"帮我做 X" | 9 级个人单 | §3 的命令 → 任务单 |
| 主人说"有空做 X" | 4 级个人单 | 同上 |
| 主人被怪打 | 现在不管（`self_defense` 只保护自己） | 建议加反射 `protect_owner`，默认关（待你定） |
| 长任务的进度 | 每完成 25% 或每 2 分钟说一句 | 任务板事件 → `say()`，不叫模型 |

## 7. 三个旧机制

| 机制 | 现在 | 怎么办 |
|---|---|---|
| `self_prompter` | 空闲时按 `!goal` 的目标催模型 | 留给开放目标（"活下去"、"去探索"）；有单在跑或排队时不催；催出来的具体活用 `!addJob` 落成单 |
| `NPCContoller`（`npc/controller.js`，`agent.js:9/46`） | 按 profile 的目标自己建造 / 采集，直接调旧 `skills.*` | 它的需求图（`item_goal.js`）给 `strat_obtain` 用（04 §3.2）；它自己的执行循环在 `strat_obtain` 能用之后关掉 |
| `companion_mode` | 四处分支（Phase 5.2）；面板会把它删掉（D23） | 先补进 `settings_spec`；任务板成了唯一路径之后删掉开关 |

## 8. 待你定

1. 没配 `owner` 时按"信任"处理（§5）：现在依赖 `!newAction` 的用法会失效
2. 空闲时默认跟随主人（§6）
3. 加不加 `protect_owner` 反射（§6）
