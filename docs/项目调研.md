# AI 接入《我的世界》—— GitHub 成熟项目调研

> 调研时间：2026-10-18　｜　星数为抓取时近似值

## 一句话结论

- **想马上看到一个 LLM 自己玩 MC** → `mindcraft-bots/mindcraft`（最成熟的框架，直接用）
- **想给现成服务器加"AI 玩家"，不想额外开进程/账号** → `zoyluoblue/mc_aiplayer`（纯 Fabric 服务端 mod）
- **想让 Claude / Cursor 直接操控服务器** → MCP 系列（`mcpfabric`、`mcp-server-mod`）
- **想做研究 / 复现论文** → `Voyager`、`Odyssey`、`VillagerAgent`
- **要造轮子** → 底座是 `PrismarineJS/mineflayer`

---

## 1. 通用 Agent 框架（最主流路线）

| 项目 | 星 | 技术栈 | 说明 |
|---|---|---|---|
| [mindcraft-bots/mindcraft](https://github.com/mindcraft-bots/mindcraft) | ~5.9k | Node.js + Mineflayer | **事实标准**。LLM 驱动的 MC 智能体，支持自主模式、命令（!build / !task 等）、任务分解、长期记忆、自动建造。可接 OpenAI / Gemini / Claude / Ollama / Groq 等，也支持任意 OpenAI 兼容端点（DeepSeek 等）。文档和示例最全，2026 年仍在更新。 |
| [MineDojo/Voyager](https://github.com/MineDojo/Voyager) | ~7.3k | Python + Mineflayer | **学术里程碑**（"Open-Ended Embodied Agent"）。自动课程 + 可执行代码技能库 + 迭代式自我修正，靠写 JS 代码调用 Mineflayer API 来行动。星最多但**基本停止维护**，MC 版本较老，适合学习架构而非落地。 |
| [zju-vipa/Odyssey](https://github.com/zju-vipa/Odyssey) | ~411 | Python | 浙大，"开放世界技能库"。提供大量可复用技能（采集/建造/战斗/合成）与微调数据，偏研究。 |
| [cnsdqd-dyb/VillagerAgent](https://github.com/cnsdqd-dyb/VillagerAgent-Minecraft-multiagent-framework) | ~188 | Python + 图编排 | ACL 2024 多智能体框架，按角色分工（Manager / Worker）用图结构协作，做多 Agent 协作首选参考。 |
| [bigph00t/hermescraft](https://github.com/bigph00t/hermescraft) | ~73 | Node/Python | "具身 AI 伙伴"：持久记忆 + 视觉 + 学习 + 多智能体，偏陪伴向。 |
| [sei-studio/sei](https://github.com/sei-studio/sei) | ~22 | — | AI 游戏伙伴（MC / 星露谷 / 饥荒），带语音通话与记忆，社区活跃度不错。 |
| [gigio1023/minecraft-llm-agent-community](https://github.com/gigio1023/minecraft-llm-agent-community) | ~25 | Mineflayer | 社会模拟运行时，actor 追求 LifeGoal，带可验证的技能与转录。 |

## 2. 做成服务端 Mod / 插件（落地最省事）

| 项目 | 星 | 说明 |
|---|---|---|
| [zoyluoblue/mc_aiplayer](https://github.com/zoyluoblue/mc_aiplayer) | ~161 | **Fabric 服务端 mod，MC 1.21.3，Java**。LLM 负责规划、确定性任务负责执行，**不需要 Python 环境、不需要 bot 小号**。支持 DeepSeek / OpenAI 兼容接口，用自然语言下指令就能挖矿、建造、种田、战斗。2026 年新项目，活跃。 |
| [MaoXiaoYuZ/minecraft-ai-npc](https://github.com/MaoXiaoYuZ/minecraft-ai-npc) | — | 中文项目，**全流程方案**：服务器搭建 → 底层行为逻辑 → 数据集构建 → 模型训练。想自己训一个 MC 专用模型看这个。 |
| [CyniaAI/BuilderGPT](https://github.com/CyniaAI/BuilderGPT) | ~165 | 专攻"AI 生成建筑"：文本 → MC 结构文件，Apache-2.0。 |
| [Boyan253/minemind](https://github.com/Boyan253/minemind) | ~8 | 面向**整合包**：LLM 读任务书，服务端伴生实体帮你挖矿合成，Forge 1.20.1。 |
| [piggy4/steveX](https://github.com/piggy4/steveX) | ~3 | 中文，Mineflayer 多 Agent 框架 + Web 面板实时监控。 |
| [ighti35/mc-bot](https://github.com/ighti35/mc-bot) | ~13 | 中文，Mineflayer + DeepSeek，中文对话、自动漫游战斗、24 套建筑蓝图。 |

## 3. MCP 路线（让 Claude / Cursor 当"遥控器"）

| 项目 | 星 | 说明 |
|---|---|---|
| [denfry/mcpfabric](https://github.com/denfry/mcpfabric) | ~10 | Fabric + NeoForge 的 MCP mod，Modrinth 有发布版，把 MC 变成 MCP 工具集。 |
| [cuspymd/mcp-server-mod](https://github.com/cuspymd/mcp-server-mod) | ~11 | Fabric mod 内嵌 MCP server，让 Claude 通过结构化命令操作游戏。 |
| [InventivetalentDev/minecraft-mcp](https://github.com/InventivetalentDev/minecraft-mcp) | ~14 | 面向**开发**：让 Claude Code 直连运行中的服务端/客户端，改代码即测。 |
| [gerred/mcpmc](https://github.com/gerred/mcpmc) | ~39 | 独立的 MCP Minecraft Server。 |
| [OGMatrix/mcmodding-mcp](https://github.com/OGMatrix/mcmodding-mcp) | ~68 | Mod 开发文档检索 MCP，解决模型知识过时问题。 |
| [rgbkrk/rcon-mcp](https://github.com/rgbkrk/rcon-mcp) | ~10 | 通过 RCON 做服务器管理。 |

## 4. 底座与基建（自己造轮子必看）

| 项目 | 星 | 说明 |
|---|---|---|
| [PrismarineJS/mineflayer](https://github.com/PrismarineJS/mineflayer) | ~7.6k | **绝对核心**。Node.js 无头 MC 客户端，几乎所有 AI 玩 MC 的项目都跑在它上面。 |
| [PrismarineJS/mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) | — | 寻路，AI 移动必备。 |
| [PrismarineJS/mineflayer-statemachine](https://github.com/PrismarineJS/mineflayer-statemachine) | ~138 | 行为树/状态机，把 LLM 的"想法"落成稳定动作。 |
| [PrismarineJS/prismarine-viewer](https://github.com/PrismarineJS/prismarine-viewer) | — | 浏览器实时看 bot 眼中的世界，调试神器。 |
| [MineDojo/MineDojo](https://github.com/MineDojo/MineDojo) | ~2.3k | 研究基准套件（含 MineCLIP 等），不是产品，做实验/评测用。 |

---

## 选型建议

| 你的目标 | 选它 |
|---|---|
| 最快跑起来、接自己的模型 | mindcraft |
| 已有服务器，想加个 AI 玩家 | mc_aiplayer（1.21.3） |
| 想让 Claude/Cursor 直接玩/调 | mcpfabric、mcp-server-mod |
| 多 Agent 协作、角色扮演 | VillagerAgent、hermescraft、sei |
| 论文复现 / 技能库研究 | Voyager → Odyssey |
| 完全自研 | mineflayer + pathfinder + statemachine + viewer |

## 踩坑提醒

1. **版本强绑定**：mineflayer 跟进 MC 版本有滞后，mod 方案（mc_aiplayer 1.21.3）更吃版本。先定 MC 版本再选方案。
2. **API 成本**：自主模式会高频调用 LLM，建议用本地模型（Ollama）或便宜模型做"执行层"，大模型只做"规划层"——mc_aiplayer 的"LLM 规划 + 确定性任务执行"就是这个思路。
3. **稳定性**：纯 LLM 直接输出动作很容易卡死，成熟项目普遍是 **LLM 决策 + 硬编码技能库** 的混合架构。
4. **服务器规则**：多数公益服禁止机器人/自动化，自建服或单机测试更稳妥。
5. **许可证**：mindcraft、mc_aiplayer MIT；BuilderGPT Apache-2.0；Voyager/MineDojo 为研究用途，商用前看清条款。
