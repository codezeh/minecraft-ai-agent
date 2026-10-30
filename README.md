# minecraft-ai-agent

基于 [mineflayer](https://github.com/PrismarineJS/mineflayer) 的 Minecraft AI 智能体框架。
由大语言模型驱动，可在游戏内自主导航、采集资源、挖掘建造，并支持自然语言交互（中文/英文）。

本项目 fork 自 [Mindcraft](https://github.com/mindcraft-bots/mindcraft)（MIT 许可证），
在导航层做了完整重写，并补充了测试套件与工程约束。协议、许可证与版权声明均完整保留。

---

## 主要能力

| 能力 | 说明 |
|---|---|
| **自主导航** | 真 3D 地形规划，能处理洞穴、桥、水下地面等一列多面的地形；滚动重规划 |
| **资源采集** | 识别整棵树的结构、判断是否为自然生成、从底部往上有序砍伐；自动准备工具与垫脚方块 |
| **挖掘掘进** | 挖一格走一格，内置安全范围（边界、地板、液体防护） |
| **攀爬** | 梯子、藤蔓的上下移动 |
| **卡死自救** | 被方块困住时自行挖掘脱出 |
| **自然语言交互** | 用中文对话下指令，模型自主调用技能 |

---

## 与上游的差异

本分支的工作集中在导航层与工程质量。

| 方向 | 内容 |
|---|---|
| **导航层重写** | 移除四套并存的寻路实现（`heatmap` / `tile_map` / `path_long` / `chunk_map`，约 2000 行），统一为单链路：扫描球体 → 3D 体素 A* → 按动作分发 → 重扫重规划 |
| **3D 地形库** | `terrain3d.js`：一列可记录多个可站立面（洞穴、桥、水下地面），SQLite 持久化 |
| **原子层重构** | 21 个 `atom_*.js` 模块，单一副作用、错误码封闭 |
| **启动自检** | `tools/preflight.mjs`：规则审计、错误码审计、新模块申报检查、字段标准、文档漂移检查 |
| **测试** | 8 套共 156 项，全部离线运行，无需启动 Minecraft 服务器 |

### 实测数据

| 场景 | 结果 |
|---|---|
| 长距离导航 | 4/4 完成，平均 1.41 格/秒；302 格任务推进 168 格 |
| 爬梯子 | 上 4 格 `y 62.00 → 66.21`，下到底 `66.21 → 63.00` |
| 挖掘爬升 | 6 格高实心台地：`(58,63) → (63.5,68.25)`，上升 5.2 格 |
| 采集 | 树底旁 `jungle_log ×3`；跨 6 格水沟采到对岸 `oak_log ×2` |
| 水中下沉 | 稳定 1 格/秒（重力驱动） |

---

## 快速开始

### 环境要求

- Minecraft Java 版（支持至 1.21.11，推荐 1.21.6）
- Node.js 18 或 20 LTS（Node 24+ 可能与原生依赖冲突）
- 至少一个模型 API Key（OpenAI / DeepSeek / Claude / Gemini 等）

### 安装

```bash
git clone https://github.com/codezeh/minecraft-ai-agent.git
cd minecraft-ai-agent

# 配置密钥：复制 keys.example.json 为 keys.json，填入 API Key
cp keys.example.json keys.json

npm install
```

### 运行

启动 Minecraft 世界并「对局域网开放」，然后在项目目录执行：

```bash
node main.js
```

默认使用 `profiles/deepseek.json`。切换模型修改 `settings.js` 的 `profiles` 字段，
可选配置见 `profiles/`（claude / gpt / gemini / qwen / mistral 等）。

> Windows 安装 Node 时需勾选 `Automatically install the necessary tools`。

### 自定义端点

仓库只包含各家官方 API 的通用配置，密钥从 `keys.json` 读取（已被 `.gitignore` 忽略）。

自建端点或私有配置请放在本地，命名为 `profiles/*-private.json` 或 `profiles/*-local.json`，
这两种模式已在 `.gitignore` 中排除。

---

## 架构

```
agent 层     技能（skills.js）+ 命令（!collectBlocks / !followEntity …）
              ↑
复合层       task_*.js —— 组合原子、管理流程与降级
              ↑
原子层       atom_*.js —— 21 个模块，单一副作用，错误码封闭
              ↑
导航         executor.js（唯一任务层）
              ↑            ↑
        path_3d.js     terrain3d.js
        （体素 A*）     （3D 可站立面库）
```

---

## 测试

```bash
node tools/preflight.mjs        # 启动自检（5 项审计），须先通过
node tools/test_tunnel.mjs      # 单项测试
```

| 测试 | 项数 | 覆盖 |
|---|---|---|
| `test_codes` | 5 | 错误码注册完整性 |
| `test_tunnel` | 36 | 掘进安全范围、树体扫描、水下地面标记 |
| `test_climb` | 21 | 攀爬判定 |
| `test_nav_opt` | 18 | 导航优化 |
| `test_path3d` | 16 | 体素 A* |
| `test_terrain3d` | 28 | 3D 地形库 |
| `test_escape` | 23 | 卡死自救 |
| `test_scaffold_inventory` | 9 | 垫脚方块清点 |

全部离线运行，不需要 Minecraft 服务器。

> **注意**：单元测试使用模拟 bot，无法覆盖物理引擎与随时间变化的状态。
> 涉及攀爬、挖掘、游泳等能力必须进行真机验证 —— 详见 `docs/经验教训.md`。

---

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/交接文档.md`](docs/交接文档.md) | 项目现状、能力清单、遗留问题（建议先读） |
| [`docs/自研申报.md`](docs/自研申报.md) | 各模块设计说明：问题背景、候选方案对比、选型理由、实测数据 |
| [`docs/经验教训.md`](docs/经验教训.md) | 踩坑记录与实测数据 |
| [`docs/README.md`](docs/README.md) | 文档索引 |
| [`docs/readme-upstream.md`](docs/readme-upstream.md) | 上游 Mindcraft 原版 README |

---

## 已知限制

| 项 | 说明 |
|---|---|
| **乘船渡水** | Paper 1.21.8 上，载具浮于水面时服务端会在 29~45ms 内解除乘坐（干地上的船与矿车正常）。协议层 `use_entity` 挂载在该版本不可用，已穷尽 [PR #4089](https://github.com/PrismarineJS/mineflayer/pull/4089) 的方案。渡水建议直接使用导航（实测跨湖无失败） |
| **潜水** | 可以下潜，速度约 1 格/秒（重力驱动）。规划层对水下地面施加高代价，优先绕行 |
| **玩家距离过远** | `followEntity` 依赖实体列表，超出加载范围时无法追踪 |
| **掉落物拾取** | 目前为轮询实现，尚未改为订阅 `itemDrop` 事件 |

---

## 上游与许可

本项目基于 **[Mindcraft](https://github.com/mindcraft-bots/mindcraft)**：

- 原作者：Kolby Nottingham
- 许可证：MIT —— 完整声明见 [LICENSE](LICENSE)，版权归原作者所有，未做修改
- 原项目 README：[docs/readme-upstream.md](docs/readme-upstream.md)

按 MIT 许可证要求，本仓库保留原项目的版权声明与许可证文本。
本分支新增与修改的部分同样以 MIT 发布。

底层依赖：
[mineflayer](https://github.com/PrismarineJS/mineflayer) ·
[minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol) ·
[prismarine-physics](https://github.com/PrismarineJS/prismarine-physics) ·
[mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) ·
[minecraft-data](https://github.com/PrismarineJS/minecraft-data)

---

## 安全提示

> **不要将本 bot 连接到启用了代码执行的公开服务器。**
> 本项目允许 LLM 在本机编写与执行代码。代码运行于沙箱中，但仍存在提示注入风险。
> 代码执行默认关闭，如需开启请在 `settings.js` 中将 `allow_insecure_coding` 设为 `true`。
