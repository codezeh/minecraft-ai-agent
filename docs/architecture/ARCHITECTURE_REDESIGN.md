# Minecraft Agent 完整架构重新设计

**版本**: 2.0  
**生成时间**: 2026-10-31  
**基于**: REFACTOR_ANALYSIS.md + 现有代码库全面评估  
**y语义决策**: 方案B — 统一为实心方块（脚下那块地面块）

---

## 目录

1. [执行摘要](#1-执行摘要)
2. [Minecraft游戏机制覆盖分析](#2-minecraft游戏机制覆盖分析)
3. [现有架构问题诊断](#3-现有架构问题诊断)
4. [目标架构设计](#4-目标架构设计)
5. [完整组件清单](#5-完整组件清单)
6. [分层契约与接口](#6-分层契约与接口)
7. [配置与数据管理](#7-配置与数据管理)
8. [错误处理与恢复策略](#8-错误处理与恢复策略)
9. [多Bot协作设计](#9-多bot协作设计)
10. [测试策略](#10-测试策略)
11. [实施路线图](#11-实施路线图)
12. [附录：Minecraft机制参考](#12-附录minecraft机制参考)

> ⚠️ **未完成的章节**：§6.2 之后的契约已补齐（见本文件末尾），但
> **§7 配置与数据管理 / §8 错误处理与恢复 / §9 多Bot协作 尚未撰写**（第二部分从 §10 开始）。
> 已定：**暂不补写**。落地按 `REFACTOR_ANALYSIS.md §5` 的勾选清单执行；
> **多 Bot 协作模式后续再搭**。这三块在补齐前不要被当作已定义的设计。

---

## 1. 执行摘要

### 1.1 核心发现

**现有代码库状态**：
- ✅ 22 个原子（`src/agent/library/atom_*.js`）
- ⚠️ 复合层：**5 个 `task_*.js`**（其中 `task_modes.js` 是 mode 管理器，不算任务）+ **4 个 `skill_*.js`**
- ✅ 4 个导航组件（`executor` / `path_3d` / `terrain3d` / `path_short`）—— ⚠️ 文档提到的 `nav.js` **并不存在**
- ✅ **44** 个 LLM 命令在 `commands/actions.js`（`commands/` 全目录去重后 **62** 个）
- ⚠️ **13 处可证缺陷（D1–D13）** —— 台账见 `REFACTOR_ANALYSIS.md §3.4`
- ⚠️ 功能重复：**已记录 7 处**（见 §3.2）
- ❌ **60%+ Minecraft核心机制无覆盖**

**关键架构缺陷**：
1. **分层违规严重**：原子层包含循环逻辑，复合层直接按键
2. **功能碎片化**：两套移动引擎、三套mode列表、mapDir散落8处
3. **职责不清**：导航层管理策略、任务层修改中断标志
4. **游戏机制缺失**：无合成链、无熔炼、无附魔、无农业、无红石
5. **多Bot支持缺失**：所有代码都是单Bot设计

### 1.2 重新设计目标

1. **完整机制覆盖**：支持90%+ Minecraft生存/建造循环
2. **严格分层**：原子→导航→任务→技能→决策，层次清晰
3. **LLM友好**：简化参数、丰富反馈、增强可组合性
4. **多Bot就绪**：共享资源管理、任务协调、通信协议
5. **生产级质量**：80%+测试覆盖、完整错误恢复、性能优化

---

## 2. Minecraft游戏机制覆盖分析

### 2.1 游戏循环矩阵

从Minecraft游戏机制出发，一个完整Agent需要支持以下循环：

| 循环类型 | 子能力 | 现有覆盖 | 缺失组件 | 优先级 |
|---------|-------|---------|---------|--------|
| **生存循环** | 食物获取 | ⚠️ 部分(吃/给) | task_farm, task_fish, task_hunt | P0 |
| | 饥饿管理 | ❌ 无主动监控 | skill_survival_check | P0 |
| | 健康恢复 | ❌ 无治疗物品使用 | atom_heal, atom_potion | P0 |
| | 危险应对 | ✅ self_preservation mode | skill_escape(加强) | P1 |
| | 睡眠重生 | ❌ 无 | atom_bed, task_shelter | P1 |
| **资源循环** | 采集 | ✅ task_collect | 扩展支持多类型 | P0 |
| | 加工 | ❌ 无 | atom_smelt, atom_brew | P0 |
| | 合成 | ⚠️ 单物品(actions) | atom_craft(统一), skill_craft_chain | P0 |
| | 装备 | ❌ 无升级流程 | task_equipment | P1 |
| | 存储 | ✅ container atoms | 仓库管理skill | P2 |
| **建造循环** | 规划 | ⚠️ schematic读取 | task_build(蓝图→执行) | P0 |
| | 材料准备 | ✅ collect/tree | skill_material_plan | P1 |
| | 建造执行 | ⚠️ platform | task_build(多结构) | P0 |
| | 装饰 | ❌ 无 | task_decorate | P2 |
| **探索循环** | 导航 | ✅ hopTo/walkTo | skill_navigate(增强) | P0 |
| | 标记 | ✅ memory_bank | skill_marks(结构化) | P1 |
| | 记录 | ✅ landmarks | world_scan(自动) | P1 |
| | 返回 | ✅ goToRemembered | task_return | P1 |
| **战斗循环** | 攻击 | ✅ atom_attack | skill_combat(编排) | P0 |
| | 防御 | ❌ 盾牌格挡 | atom_shield | P1 |
| | 装备战斗 | ❌ 无附魔 | atom_enchant | P1 |
| | 药水增益 | ❌ 无 | atom_potion, task_potion | P1 |
| **社交循环** | 村民交易 | ⚠️ 手动(actions) | atom_trade, task_trade | P1 |
| | 村民保护 | ❌ 无 | skill_villager_guard | P2 |
| | 铁傀儡利用 | ❌ 无 | task_iron_farm | P2 |
| **高级机制** | 红石机械 | ❌ 无 | atom_lever, atom_piston | P2 |
| | 附魔台 | ❌ 无 | atom_enchant | P1 |
| | 酿造台 | ❌ 无 | atom_brew | P1 |
| | 信标 | ❌ 无 | task_beacon | P2 |
| | 下界/末地 | ❌ 无 | task_dimension(传送门) | P2 |

**统计**：
- 现有覆盖：40% (11/27 子能力)
- P0缺失：13个组件
- P1缺失：15个组件
- P2缺失：8个组件

### 2.2 关键机制缺失详解

#### 2.2.1 合成系统（当前最严重缺口）
**现状**：
- `!craftRecipe` 在actions.js中直接调用skills.craftRecipe
- 无合成链概念：木→木板→木棍→工具需要3步，但无编排
- 工作台放置/收回无原子支持
- tool_prep.js直接调用craft，绕过任何抽象

**影响**：
- LLM无法表达"做一个钻石镐需要什么"
- 无法自动判断"当前材料缺什么"
- 多步合成容易中断失败

**所需组件**：
- `atom_craft.js` - 单物品合成（含工作台放置）
- `skill_craft_chain.js` - 多步合成规划与执行
- `task_craft.js` - 合成任务编排（材料检查、重试）

#### 2.2.2 熔炼系统（完全缺失）
**现状**：
- 只有cooking_tasks.js用/setblock作弊放置
- 无atom_smelt封装熔炉交互
- 无燃料管理
- 无熔炼进度监控

**影响**：
- 无法冶炼矿石（铁、金、铜）
- 无法烧制食物（牛排、烤土豆）
- 无法制作玻璃、砖块等

**所需组件**：
- `atom_smelt.js` - 熔炉操作原子（放入、取出、读燃料）
- `task_smelt.js` - 批量熔炼流程（燃料管理、进度监控）

#### 2.2.3 农业循环（仅作弊版本）
**现状**：
- cooking_tasks.js用/setblock直接种
- 无task_farm封装真实农业
- 无骨粉使用原子
- 无收割/补种逻辑

**影响**：
- Agent无法维持食物供应链
- 无法利用农业作为稳定食物源
- 小麦→面包、甘蔗→糖等加工链断开

**所需组件**：
- `atom_plant.js` - 种植/收割/骨粉使用
- `task_farm.js` - 农业循环任务（检测成熟、收割、补种）
- `skill_farm.js` - 农场管理策略（多种作物调度）

#### 2.2.4 红石与机械（完全缺失）
**现状**：
- 无拉杆/按钮原子
- 无活塞原子
- 无红石线路规划
- 无观察者/比较器逻辑

**影响**：
- 无法自动化任何过程
- 无法建造门/陷阱/农场机械
- 无法利用红石电路增强基地

**所需组件**：
- `atom_lever.js`, `atom_door.js`, `atom_piston.js` - 红石交互原子
- `task_automate.js` - 红石机械任务
- `skill_automation.js` - 自动化设计策略

#### 2.2.5 附魔与酿造（完全缺失）
**现状**：
- 无附魔台交互
- 无经验管理（XP等级读取都有问题）
- 无酿造台操作
- 无药水效果监控

**影响**：
- 装备无法强化（效率、保护、锋利）
- 无法制作治疗/力量/抗火药水
- 下界/末地探索几乎不可能

**所需组件**：
- `atom_enchant.js` - 附魔台操作（读书架、选附魔）
- `atom_brew.js` - 酿造台操作
- `atom_potion.js` - 药水使用与效果监控
- `task_brew.js` - 批量酿造任务

---

## 3. 现有架构问题诊断

### 3.1 分层违规（已记录 12 条）

#### A. 原子层包含复合逻辑
| 组件 | 违规点 | 证据 | 影响 | 修复方案 |
|------|--------|------|------|---------|
| atom_drops.collectDrops | 多轮循环+moveTo调用 | :95-160 | 非原子性 | 拆为findDrops+task层收集 |
| atom_tunnel.tunnelAlong | 循环调用dig/move | :28-29 | 含复合逻辑 | 只保留tunnelStep |
| atom_dig | 直接按键forward+装备 | :68-74, :97 | 绕过抽象 | 参数化bot.dig |
| atom_classify | 读写landmarks | :13 | 副作用 | 参数传递 |

#### B. 复合层绕过原子
| 组件 | 违规点 | 证据 | 影响 | 修复方案 |
|------|--------|------|------|---------|
| tool_prep | 直接dig/craft/goto | :88+ | 职责混乱 | 改用atom_craft+nav.goTo |
| task_follow | 直接setGoal/setMovements | :321-433 | 绕过导航层 | 移交nav_core |
| executor | 直接按键 | :100+ | 绕过原子 | 调用atom_pillar |
| skill_escape | 自定义返回值 | 全文 | 契约不统一 | 统一ok/fail |

#### C. 导航层管策略
- executor自带mode暂停列表 (:530-541) → 移交task_modes统一管理
- executor管"挖还是走"决策 → 这是导航职责，但应下沉到steps/

#### D. 任务改中断标志
- task_follow:84 `bot.interrupt_code=false` → 中断管理应在action_manager层

**违规后果**：
1. 测试困难 - 原子不原子，mock不了
2. 复用困难 - 逻辑分散，改一处牵连多处
3. 理解困难 - 职责不清，新人不知道改哪
4. 并行困难 - 多bot时竞态条件难控制

### 3.2 功能重复（已记录 7 处）

| 重复项 | 位置 | 行为差异 | 后果 | 合并方案 |
|--------|------|---------|------|---------|
| 移动引擎 | pathfinder vs walkTo | 2D vs 3D | 改一套另一套不变 | nav_core统一入口 |
| follow实现 | task_follow vs skills.followPlayer | 前者未启用 | 代码死掉 | 删skills版本 |
| collect兜底 | skill_collect三机制 | 冗余 | 维护负担 | 只保留一套 |
| skills vs tasks | 5个函数重叠 | 废弃包装 | 调用混乱 | 统一路由 |
| 垫脚块清单 | tool_prep/executor/skill_escape | 三处不一致 | 行为不一致 | config统一 |
| mode列表 | task_modes/executor/skills.js | 三套 | 暂停逻辑混乱 | 只保留task_modes |
| mapDir拼接 | 8处重复字符串 | 容易写错 | 路径不一致 | helpers统一 |

### 3.3 数据竞态与泄漏（6处）

| 问题 | 位置 | 症状 | 影响 | 修复 |
|------|------|------|------|------|
| SQLite每次开关库 | terrain3d:153 | 每次查询50ms | 性能差 | 连接池 |
| fail表从不清理 | terrain3d:495 | readFails全表扫 | 越查越慢 | TTL机制+索引 |
| task_collect中断泄漏 | task_collect:97 | mode/scaffolder不恢复 | 后续任务失败 | finally块 |
| ScaffoldTracker泄漏 | scaffold_cleanup:28-46 | 清他人方块 | 多bot冲突 | 只清自己的 |
| trace_bus重复记录 | executor:95/506/738 | 同一事件3次 | 日志膨胀 | 单点记录 |
| 潜水循环不查中断 | executor:349-355 | 卡死30s | 无法打断 | 每tick检查 |

### 3.4 y语义混乱（D1，方案B决策）

**问题**：
- terrain3d用脚格（实心方块）
- executor用头格（空气层）
- path_3d混合使用
- 导致下坡挖错列、上2格跳不上

**决策**：统一为"脚下那块地面块"（方案B，实心方块语义）

**理由**：
1. 与terrain3d现状一致（它已经用脚格）
2. 与Minecraft渲染一致（实体站在y=脚格上方）
3. 避免"下坡挖错列"问题（D1的核心）
4. 导航层所有高度判断统一基准

**实施影响**：
- executor所有的`bot.entity.position.y` 改为 `floor(y)`
- path_3d的goal_y统一为脚格
- atom_stand的standableAt接受脚格坐标
- 所有命令参数y统一为脚格（文档明确说明）

---

## 4. 目标架构设计

### 4.1 六层架构

```
┌─────────────────────────────────────────────────────────┐
│  Layer 0: Agent Control (决策层)                         │
│  agent.js, action_manager.js, coder, conversation       │
│  - LLM提示构建、命令路由、上下文管理                     │
│  - 中断管理、调度优先级                                 │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│  Layer 1: Skills (策略编排层)                            │
│  skills/ — 复杂决策、多任务编排、LLM语义桥接            │
│  - skill_wood, skill_farm, skill_craft_chain            │
│  - 不保证原子性，可部分完成                             │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│  Layer 2: Tasks (任务层)                                 │
│  tasks/ — 单一目标完整流程                               │
│  - task_build, task_mine, task_collect                  │
│  - 重试、超时、中断检查、资源清理                       │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│  Layer 3: Navigation (导航层)                            │
│  nav/ — 所有移动决策唯一入口                             │
│  - nav_core.goTo, executor, path_3d                     │
│  - 引擎选择、mode管理、被困检测                         │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│  Layer 4: Atoms (原子层)                                 │
│  atoms/ — 纯函数、单一职责、契约返回                    │
│  - atom_dig, atom_place, atom_craft                     │
│  - 无循环、无全局状态、无直接按键                       │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│  Layer 5: Mineflayer Bot (执行层)                        │
│  bot.* — mineflayer API直接调用                         │
└─────────────────────────────────────────────────────────┘

横向支撑：
- data/：storage, landmarks, memory_store, world_model, trace_bus
- utils/：atom_contract, step_runner, helpers, config
- multi/：多bot协调（bot_registry, task_coordinator, comm_bus）
```

### 4.2 分层原则（强制）

| 原则 | 描述 | 违规检测 | 实施工具 |
|------|------|---------|---------|
| **单一职责** | 每个组件只做一件事 | 代码审查+LOC限制 | ESLint规则 |
| **方向依赖** | 只允许上层↓下层调用 | 依赖图CI检查 | dependency-cruiser |
| **契约返回** | 所有函数返回ok/fail | 编译时装饰器 | JSDoc+TypeScript |
| **无全局状态** | 状态通过参数/返回值 | 静态分析 | eslint-plugin-no-global |
| **无循环** | 原子层单次尝试 | 代码审查 | AST检查for/while |
| **无直接按键** | 控制状态通过抽象 | 正则扫描 | grep检查setControlState |
| **单入口导航** | 所有移动走nav.goTo | 调用图分析 | 测试时mock nav.goTo |
| **单mode管理** | 只有task_modes管 | 静态检查 | 搜索pauseGoalModes |

### 4.3 智能分层（决策在哪里？）

| 智能类型 | 层 | 实现方式 | 例子 |
|---------|---|---------|------|
| **战略决策** | Layer 0 | LLM选择目标 | "建个家" → 选择task_shelter |
| **战术规划** | Layer 1 | Skill分析资源、拆解步骤 | "需要木头50→先砍树→合成木板" |
| **执行编排** | Layer 2 | Task管理流程、重试策略 | "采集失败重试3次，超时返回TIMEOUT" |
| **路径决策** | Layer 3 | Nav选择引擎、绕障 | "距离>40用walkTo，<40用pathfinder" |
| **机械执行** | Layer 4 | Atom单次操作 | "挖这一个方块" |
| **物理模拟** | Layer 5 | Mineflayer | "发送dig包、等待blockBreak事件" |

**关键设计原则**：
- LLM只在Layer 0做战略决策（降低调用频率）
- Layer 1-2做战术/执行决策（确定性逻辑，快速响应）
- Layer 3-4纯算法（无LLM，最高性能）


---

## 5. 完整组件清单

### 5.1 原子层（Atoms）— 按功能分类

> **参数列约定**：一律写成 `目标描述对象, opts`（见 §6.4）。表里保留的 `name` / `pos` 是目标对象内的字段，
> **不是**位置参数。`reach` 这个名字已废除（→ `maxReach`），若在下游文档里看到 `reach`，按旧名处理。

#### A. 移动与空间（Movement & Spatial）
| 名称 | 职责 | 参数 | 优先级 | 状态 |
|------|------|------|--------|------|
| atom_move | moveToXZ(x,z), stepTo(dir) | `target, {tol, timeout, canDig, scaffold}` | P0 | ✅存在，重构 |
| atom_pathfind | 封装pathfinder.goto | `target, {maxReach, timeout}` | P0 | 🆕新增 |
| atom_pillar | 跳垫上升/下降 | {up:bool, block} | P0 | 🆕新增 |
| atom_stuck_detect | 检测卡住 | {window:5s} | P0 | 🆕新增 |
| atom_stand | canStand(pos), standHere() | pos | P0 | ✅存在 |
| atom_climb | climbUp/climbDown | {dir} | P1 | ✅存在 |
| atom_look | lookAt(target) | pos/entity | P0 | ✅存在 |

#### B. 方块操作（Block Manipulation）
| 名称 | 职责 | 参数 | 优先级 | 状态 |
|------|------|------|--------|------|
| atom_dig | digBlock(pos) | `target, {canDig, timeout}` | P0 | ✅重构 |
| atom_place | placeBlockAt(pos, type) | pos, type | P0 | ✅存在 |
| atom_tunnel | tunnelStep(dir) | dir | P0 | ✅重构 |
| atom_use | useOnBlock(pos) | pos | P0 | ✅存在 |

#### C. 物品与容器（Items & Containers）
| 名称 | 职责 | 参数 | 优先级 | 状态 |
|------|------|------|--------|------|
| atom_items | equip/has/count | name | P0 | ✅存在 |
| atom_drops | findNearbyDrops() | {range} | P0 | ✅重构 |
| atom_container | open/take/put | chest, item | P0 | ✅存在 |
| atom_craft | craftItem(recipe) | recipe, {table} | P0 | 🆕新增 |
| atom_smelt | smeltItem(input) | input, fuel | P0 | 🆕新增 |
| atom_brew | brewPotion(recipe) | recipe | P1 | 🆕新增 |

#### D. 交互与实体（Interaction & Entities）
| 名称 | 职责 | 参数 | 优先级 | 状态 |
|------|------|------|--------|------|
| atom_attack | attackNearest(type) | type, {range} | P0 | ✅存在 |
| atom_trade | tradeWithVillager(offer) | villager, offer | P1 | 🆕新增 |
| atom_bed | sleep/respawn | bed_pos | P1 | 🆕新增 |
| atom_ride | mount(entity) | entity | P2 | ✅存在(boat) |
| atom_talk | chatWith(entity) | entity, msg | P2 | 🆕新增 |

#### E. 生存与状态（Survival & Status）
| 名称 | 职责 | 参数 | 优先级 | 状态 |
|------|------|------|--------|------|
| atom_eat | consumeFood(item) | item | P0 | 🆕新增 |
| atom_heal | useHealing(item) | item | P1 | 🆕新增 |
| atom_potion | applyPotion(active) | effect | P1 | 🆕新增 |
| atom_shield | blockWithShield() | - | P1 | 🆕新增 |

#### F. 机械与红石（Mechanics & Redstone）
| 名称 | 职责 | 参数 | 优先级 | 状态 |
|------|------|------|--------|------|
| atom_lever | toggleLever(pos) | pos, state | P2 | 🆕新增 |
| atom_door | openCloseDoor(pos) | pos, open | P2 | 🆕新增 |
| atom_piston | activatePiston(pos) | pos | P2 | 🆕新增 |

#### G. 感知与查询（Perception & Query）
| 名称 | 职责 | 参数 | 优先级 | 状态 |
|------|------|------|--------|------|
| atom_perceive | scanBlocks(types) | types, range | P0 | ✅存在 |
| atom_query | queryState(path) | path | P0 | ✅存在 |
| atom_safe | isSafe(pos) | pos | P0 | ✅存在 |
| atom_classify | classifyBlock(pos) | pos | P1 | ✅重构 |
| atom_enchant | enchantItem(table) | item, lvl | P1 | 🆕新增 |

**原子层统计**：现有22个 → 目标38个（16新增 + 22重构/保留）

### 5.2 导航层（Navigation）

| 名称 | 职责 | 优先级 | 状态 |
|------|------|--------|------|
| nav_core | goTo统一入口，引擎选择 | P0 | 🆕新增 |
| executor | 3D导航主循环（重构） | P0 | ✅重构 |
| path_3d | 体素A*（优化） | P0 | ✅存在 |
| terrain3d | 地形库（连接池） | P0 | ✅重构 |
| steps/step_walk | 行走步骤 | P0 | 🆕新增 |
| steps/step_dig | 挖掘步骤 | P0 | 🆕新增 |
| steps/step_climb | 攀爬步骤 | P1 | 🆕新增 |
| steps/step_swim | 潜水步骤 | P1 | 🆕新增 |
| steps/step_pillar | 跳垫步骤 | P0 | 🆕新增 |

### 5.3 任务层（Tasks）

#### P0（核心命令需要）
| 名称 | 职责 | 依赖 | LLM命令 |
|------|------|------|---------|
| task_collect | 采集调度（重构） | atoms, nav | !collectBlocks |
| task_follow | 跟随玩家（重构） | nav, stuck | !followPlayer |
| task_build | 蓝图建造 | schematic, atoms | !build |
| task_mine | 挖矿（条带/矿脉） | nav, dig | !mine |
| task_farm | 农业循环 | plant, nav | !farm |
| task_craft | 合成链执行 | craft, items | !craft |
| task_smelt | 批量熔炼 | smelt, fuel | !smelt |
| task_combat | 战斗编排 | attack, shield | !attack |

#### P1（生存循环）
| 名称 | 职责 | 依赖 | LLM命令 |
|------|------|------|---------|
| task_equipment | 装备升级 | craft, enchant | !upgrade |
| task_shelter | 庇护所建造 | build, bed | !buildShelter |
| task_explore | 区域探索 | nav, perceive | !explore |
| task_trade | 批量交易 | trade | !trade |
| task_fish | 钓鱼 | use | !fish |
| task_hunt | 狩猎 | combat, collect | !hunt |
| task_brew | 批量酿造 | brew | !brewPotion |

#### P2（高级机制）
| 名称 | 职责 | 依赖 | LLM命令 |
|------|------|------|---------|
| task_decorate | 装饰建造 | build | !decorate |
| task_raid | 袭击副本 | combat, navigate | !raid |
| task_beacon | 信标激活 | build, redstone | !beacon |
| task_dimension | 维度穿越 | portal, navigate | !portal |
| task_automate | 红石机械 | redstone atoms | !automate |
| task_iron_farm | 铁傀儡农场 | villager, redstone | !ironFarm |

**任务层统计**：现有 **5** 个（`task_collect` / `task_follow` / `task_hop` / `task_platform` / `task_modes`，其中 `task_modes` 是 mode 管理器而非任务）→ 目标 22 个

### 5.4 技能层（Skills）

#### P0（核心策略）
| 名称 | 职责 | 依赖 |
|------|------|------|
| skill_wood | 伐木策略（识别树种） | task_collect, craft |
| skill_unstuck | 脱困策略库 | nav, pillar |
| skill_survival | 生存检查（饥饿/健康） | eat, heal, escape |
| skill_navigate | 导航策略（选路） | nav, explore |

#### P1（资源策略）
| 名称 | 职责 | 依赖 |
|------|------|------|
| skill_craft_chain | 复杂合成链 | task_craft, items |
| skill_farm | 农场管理 | task_farm, collect |
| skill_material_plan | 材料规划 | query, craft |
| skill_combat | 战斗战术 | task_combat, potion |
| skill_trade | 交易优化 | task_trade, query |

#### P2（高级策略）
| 名称 | 职责 | 依赖 |
|------|------|------|
| skill_build_plan | 建造规划 | build, material |
| skill_villager | 村民管理 | trade, guard |
| skill_automation | 自动化设计 | redstone, build |
| skill_explore_map | 地图探索 | explore, marks |

**技能层统计**：现有 **4** 个（`skill_collect` / `skill_escape` / `skill_clear` / `skill_library`，另有遗留 `skills.js`）→ 目标 14 个

### 5.5 多Bot协调层（Multi-Bot）— 新增

| 名称 | 职责 | 优先级 |
|------|------|--------|
| bot_registry | bot实例注册/发现 | P1 |
| task_coordinator | 任务分配/冲突解决 | P1 |
| comm_bus | bot间通信（共享事件） | P1 |
| resource_manager | 共享资源锁（箱子/熔炉） | P1 |
| role_assigner | 角色分配（矿工/农夫/建筑师） | P2 |

---

## 6. 分层契约与接口

### 6.1 原子层契约（强制）

```javascript
/**
 * 原子层函数模板
 *
 * 必须遵守：
 * 1. 返回 {ok:true, code:'OK', message:'', data} 或 {ok:false, code, message, data}
 *    —— 四个键名固定为 ok / code / message / data，不许再改名
 * 2. 单次尝试，无循环/重试（重试属于策略层）
 * 3. 不调用其他原子（除工具函数如 canStand / normalizeTarget）
 * 4. 不读写全局状态（通过参数传递）
 * 5. 不管理 mode / 调度（由调用者处理），但**必须响应中断**（见 §6.5）
 * 6. 超时由本原子用 opts.timeout（毫秒）自己实现，不用外部 Promise 包装
 *    —— 否则分不清"超时"和"内部异常"
 */
async function atomName(bot, target, opts = {}) {
  const { timeout = 5000 } = opts;
  try {
    // 前置断言：不满足立刻返回明确 code，不做任何尝试
    if (!precondition) {
      return fail('NO_TARGET', '人话原因');
    }

    // 单一操作（无循环）
    const result = await singleOperation();

    // 后置校验：读世界确认，不信返回值
    return ok({ pos, costMs });
  } catch (e) {
    return fail('INTERNAL', e.message);   // 不许自创码名，见 §6.2
  }
}
```

### 6.2 错误码表（唯一合法取值，31 条）

`code` 只能取自下表，**实现在 `src/agent/library/atom_contract.js` 的 `CODES`**。
`fail()` 对表外 code 直接抛异常，且 `message` 不能为空 —— 所以自创码名不是"风格问题"，是运行时崩溃。

| 分组 | code | 含义 | 上层该怎么做 |
|------|------|------|-------------|
| **通用** | `OK` | 成功 | 继续 |
| | `TIMEOUT` | 等超时，且无有效推进 | 换参数重试或放弃 |
| | `INTERRUPTED` | 收到 `bot.interrupt_code` | 立刻收尾，不重试 |
| | `INTERNAL` | 代码内部异常 | 记录并上报，别重试 |
| | `BLOCKED` | 目标/路线被别的动作改动 | 重新规划 |
| **目标与可达** | `NO_TARGET` | 找不到目标（不知道在哪） | 换目标 |
| | `NO_PATH` | 算不出路 | 放弃或换目标 |
| | `NO_REACH` | 知道在哪、也走了，但停在差一段 | 换路 / 搭方块 |
| | `STUCK` | 有路但原地不动（连续 STALL_MS 没靠近） | 重试 / 换路 / 搭方块 |
| | `OUT_OF_REACH` | 超出交互距离 | 先靠近 |
| | `NO_DATA` | 目标格未加载，读不到方块 | 等区块加载 |
| | `NO_START` | 起点周围找不到可站立面 | 先脱困 |
| **移动与站位** | `UNSAFE` | 落点不安全（下方悬空/只有水面） | 换落点 |
| | `HEIGHT_MISS` | 垂直没到位 | 重新定位再走 |
| | `NOT_CLIMBABLE` | 不在藤蔓/梯子上 | 换路径 |
| | `NO_MOVE` | 挖通了但走不过去 | 换路径 |
| **物品与容器** | `NO_TOOL` | 没有能挖动它的工具 | 先合成/换工具 |
| | `NO_ITEM` | 背包里没有该物品 | 先采集/合成 |
| | `OCCUPIED` | 目标格已有别的方块 | 换位置（不替上层拆） |
| | `NO_SUPPORT` | 没有可放置的支撑面 | 换位置 |
| | `WINDOW_CLOSED` | 容器/窗口已关闭 | 重新打开 |
| **掘进（tunnel）** | `OUT_OF_ZONE` | 目标格出了安全范围 | 缩回范围内 |
| | `TOO_MUCH` | 一步要挖的格数超上限 | 拆成多步 |
| | `NO_FLOOR` | 挖完脚下没地板 | 先搭地板 |
| | `LIQUID_RISK` | 周围有液体，挖了会灌进来 | 先封堵 |
| | `DIG_FAIL` | 挖方块失败 | 换工具 |
| **载具（boat/ride）** | `NO_VEHICLE` | 附近没有可骑的船/矿车 | 先放置 |
| | `RIDE_FAILED` | 发了 /ride 但没上船 | 重试或换位置 |
| | `NO_PERMISSION` | /ride 被拒（需 op） | 提示权限 |
| | `NOT_MOUNTED` | 不在载具上 | 先上船 |
| | `DRIVE_FAILED` | 在载具上但动不了（搁浅/陆地） | 换水路 |

**两组必须区分的码（混用会让降级策略错掉）**：

| 对比 | 区别 | 为什么不能合并 |
|------|------|---------------|
| `STUCK` vs `NO_PATH` | `NO_PATH` 是算不出路；`STUCK` 是路有但走不动 | 前者该放弃/换目标，后者该重试/换路/搭方块 |
| `NO_REACH` vs `NO_TARGET` | `NO_REACH` 是知道坐标但这段路走不过去；`NO_TARGET` 是压根不知道在哪 | 混用会导致反复问"你在哪"，而坐标一直查得到（实测踩过） |

**新增错误码的流程**：先在本表和 `atom_contract.js` 的 `CODES` 同时加（含一行注释说明"为什么必须区分"），再加到代码里。
**禁止**：`FAILED` / `NOT_FOUND` / `TOO_FAR` / `ERROR` 这类同义词。

### 6.3 data 字段白名单

`data` 只允许下列字段。**表外字段 = 违规**；确实需要新字段时，先改这张表再加代码。

| 字段 | 类型 | 口径 |
|------|------|------|
| `pos` | `{x,y,z}` 整数 | 方块/格子坐标 |
| `posXZ` | `{x,z}` 整数 | 只要水平位置时用（禁用 `reached` 这个名字） |
| `dist` | number | **方块中心 → 眼睛** 的直线距离 |
| `count` / `want` | number | 已完成 / 目标 |
| `costMs` | number | **本原子自身**耗时（不含调用方重试） |
| `failed` | `[{pos,code,message}]` | 失败明细 |
| `step` | number | 复合技能里的步骤序号（1 起） |
| `partial` | boolean | 仅 `moveTo`：超时/失败但有推进，上层可就地续跑 |
| `existed` | boolean | 仅 `place`：目标已经是该方块（幂等命中） |

**动作标识字段必须"名字说清动作"**（同名不同义是最危险的一类矛盾）：

| 错误写法 | 正确写法 | 原因 |
|---------|---------|------|
| `block: 'oak_log'`（放进去的） | `placedBlock: 'oak_log'` | `block: 'dirt'` 到底是"我放了 dirt"还是"那里已经是 dirt"，读代码才能分辨 |
| `block: 'dirt'`（那里已有的） | `occupiedBy: 'dirt'` | 同上 |
| `block: 'stone'`（挖掉的） | `dugBlock: 'stone'` | 同上 |
| `item: 'iron_pickaxe'`（装上的） | `equippedItem: 'iron_pickaxe'` | 对齐 placedBlock/dugBlock 的命名法 |
| `item: 'dirt'`（丢掉的） | `droppedItem: 'dirt'` | 同上 |

原子专属字段（同样受白名单约束，不许扩用）：

| 原子 | 专属字段 |
|------|---------|
| `openContainer` | `containerKind`, `slots`, `containerSlots`, `title` |
| `useBlock` | `useKind`（door/bed/workstation/crop）, `state` |
| `attackEntity` | `killed`, `hpLeft`, `target: {kind:'entity', name}` |
| `placeBlockAt` | `support`, `existed`, `placedBlock`, `occupiedBy`, `occupantNow` |
| `equipItem` / `dropItem` | `equippedItem`, `count` / `droppedItem`, `left` |

> 例外：`fail()` 里的 `block: block.name` 属于**诊断上下文**（"哪个方块挖不动"），不算歧义，放行。

### 6.4 参数规范（怎么传进去）

**一、目标一律传描述对象**，不许拆成位置参数，也不许传 Vec3（跨模块传 Vec3 会变成隐式依赖，且曾导致 `pos.floored is not a function`）：

```js
{ kind: 'point',  pos: {x, y, z} }        // 走到某点
{ kind: 'point',  posXZ: {x, z} }         // 只给水平位置，高度自己找
{ kind: 'block',  pos: {x, y, z}, name? } // 挖/放/交互某个方块
{ kind: 'entity', entity }                // 攻击某实体
{ kind: 'player', name: 'xxx' }           // 面向某玩家
{ kind: 'self' }                          // 她自己
```

统一由 `normalizeTarget()` 归一与校验。**裸坐标（`{x,y,z}` / `{x,z}`）已废弃**：现在传裸坐标会立刻返回 `NO_TARGET`，不静默降级。

**二、可变参数一律进 `opts`，同名同义同单位（毫秒）**：

| 概念 | 唯一名字 | 默认 |
|------|---------|------|
| 可达距离 | `maxReach` | 见下 |
| 移动停止容差 | `tol` | 1（moveTo）/ 2（仅 XZ） |
| 超时 | `timeout` | 见下，**毫秒** |
| 后置校验等待 | `verifyMs` | 800 |
| 能否挖掘 | `canDig` | false |
| 能否搭方块 | `scaffold` | false |

**已废除的名字**：`reach`（→ `maxReach`）、`extraMs`（→ `verifyMs`）、`allowBreak`（→ `canDig` + `scaffold`）。
**禁止硬编码游戏常量**：距离/眼高一律从规则表取（`digReach()` / `EYE_HEIGHT`），不许再写字面量 5.1 / 1.62 / 4.317。

| 原子 | `maxReach` | `timeout` |
|------|-----------|-----------|
| `digBlock` | `digReach()` = 5.1 | `digTime*2 + 500` |
| `placeBlockAt` | 4.3 + 1 | 3000 |
| `useBlock` / `openContainer` | 4.5 | 3000 / 4000 |
| `attackEntity` | 3.0 | 8000 |
| `moveTo` | —（用 `tol`） | 30000 |

> 超时默认值不同是**有意的**：开箱子 4 秒、开门 3 秒是实测正常上限；统一成 30 秒会让失败检测变迟钝。

### 6.5 中断、超时与 mode 的边界

三者归属必须分清，否则多 Bot 并发时无法停下：

| 事项 | 归谁管 | 原子层的要求 |
|------|--------|-------------|
| **中断信号**（`bot.interrupt_code`） | 发出方是命令层，**响应方包含原子** | 原子**入口必须检查**；长等待循环内每 ~100ms 检查一次 → 返回 `INTERRUPTED` |
| **mode 暂停/恢复**（`task_modes`） | 只有 task 层 | 原子不碰、不恢复 |
| **超时** | 原子自己（`opts.timeout`） | 自己计时、自己返回 `TIMEOUT`；不用外部 Promise 包装 |
| **重试** | task/skill 层 | 原子内部不许重试 |

> §6.1 里"不管理 mode/中断"只针对**调度语义**（原子不该决定暂停哪些 mode），**不是**说原子可以不响应中断。现状 22 个原子中 16 个已在入口检查 `interrupt_code`，这是既有事实，新原子照此办理。

失败先写日志再返回：`log(bot, '没有木板可以放（背包里 0 个 oak_planks）。')` → `return false`（旧风格）或 `return fail('NO_ITEM', '...')`（原子风格）。**不许让失败静默**。

### 6.6 机器检查（进 preflight，不靠自觉）

| 规则 | 检查方式 |
|------|---------|
| `code` 必须在 31 条白名单内 | 扫 `ok()` / `fail()` 首参 |
| `fail()` 的 `message` 非空 | 同上 |
| 返回里不许出现 `block:` / 平铺 `kind:` | 正则扫 `ok({...})` / `fail(..., {...})` |
| 原子调用不许传裸坐标 | 扫 `digBlock(bot, { x: ... })` 一类调用 |
| `opts` 不许出现 `reach` / `extraMs` / `allowBreak` | 正则扫 |
| 返回里不许出现 `reached:` | 正则扫 |
| 原子内不许 `for` / `while` | AST 检查（策略循环归上层） |
| 原子内不许 `setControlState` | 正则扫（按键必须经原子封装） |
| 所有移动必须走 `nav_core.goTo` | 调用图 / 测试时 mock |

> ⚠️ **"原子内不许 for/while"这条不能照字面实现**（2026-10-31 核对）：
> 现状 22 个原子里 **19 个都有循环**，绝大多数是**合法的遍历查询**
> （例如 `atom_classify` 扫 11×11×13 找树叶、`atom_tree` 走连通原木、`atom_wait` 轮询判据）。
> 真正违禁的是**重复动作/重试**那类循环（同一动作做 N 次、失败再试），
> 例如原来的 `atom_tunnel.tunnelAlong`、`atom_drops.collectDrops`。
>
> 所以机器检查要查的是：
> 1. 循环体里是否**再次调用动作类原子**（`digBlock` / `placeBlockAt` / `moveTo` …）——那是重试，违禁；
> 2. 纯查询循环（只读 `bot.blockAt` / 遍历实体 / 等待判据）**允许**。
>
> 光扫 `for|while` 会把这 19 个文件一起判红，属于规则写得比事实粗。
