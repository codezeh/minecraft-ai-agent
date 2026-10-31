# Mindcraft 架构概览

> **本目录是新规范（权威）**。`docs/legacy/` 下那批旧文档只作历史参考，
> 与本文档冲突时一律以本目录为准。
>
> **按问题找文档**：
>
> | 你要回答的问题 | 看哪份 |
> |---|---|
> | 分层怎么划、谁调谁、智能放在哪层 | 本文件 + `ARCHITECTURE_REDESIGN.md §4` |
> | 返回什么、错误码有哪些、参数怎么传 | `ARCHITECTURE_REDESIGN.md §6`（**唯一契约来源**） |
> | 现有代码哪里烂了、有几处 | `REFACTOR_ANALYSIS.md §3` |
> | 缺哪些能力、优先级怎么排 | `ARCHITECTURE_REDESIGN.md §2 §5` + `PART2 §11` |
> | 怎么测、怎么验收 | `ARCHITECTURE_REDESIGN_PART2.md §10` |
> | 某个原子的详细规格 | `01_primitives.md`（清单）+ 代码里的 JSDoc（真依据） |

## 整体架构

Mindcraft 采用 **分层技能系统** 架构，从底层原子操作到高层智能决策，共分为 4+1 层：

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 0: LLM Agent (智能决策层)                              │
│  - 理解自然语言指令                                            │
│  - 选择合适的技能执行                                          │
│  - 动态调整计划                                               │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: Skills (复合技能层)                                 │
│  - 高层目标分解 (如"建立基地"、"制作铁工具")                     │
│  - 多任务编排与资源规划                                        │
│  - 长期策略执行                                               │
│  → 30-50 个技能                                              │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: Tasks (任务层)                                      │
│  - 具体任务执行 (如"采集木头"、"挖铁矿")                        │
│  - 状态机控制、失败重试                                        │
│  - 多阶段流程管理                                             │
│  → 30-40 个任务                                              │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: Actions (动作层)                                    │
│  - 基础操作序列 (如"装备物品"、"砍树"、"合成")                   │
│  - 单一目标完成                                               │
│  - 错误处理与恢复                                             │
│  → 40-50 个动作                                              │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  Layer 4: Primitives (原子层)                                 │
│  - 单一原子操作 (如"挖方块"、"放置方块"、"移动")                 │
│  - 直接调用 Mineflayer API                                   │
│  - 无副作用、可组合                                           │
│  → 约 35 个原子                                              │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  Mineflayer API (bot.dig, bot.place, bot.navigate, ...)     │
└─────────────────────────────────────────────────────────────┘
```

**图上写的是目标数量，不是现状**：

| 层 | 图上（目标） | 现状 |
|---|---|---|
| 技能 | 30-50 | **4** 个 `skill_*.js` |
| 任务 | 30-40 | **5** 个 `task_*.js` |
| 动作 | 40-50 | ⚠️ **该层在六层架构里已并入 Tasks**（见 `ARCHITECTURE_REDESIGN.md §4.1`）——原 `02_actions.md` 已归档到 `../legacy/02_actions.md`，只作能力盘点参考 |
| 原子 | 约 35 | **22** 个 `atom_*.js`（`ARCHITECTURE_REDESIGN` 目标为 38） |

## 核心系统

### 1. 导航系统 (Navigation)
- **terrain3d.js**: SQLite 地形数据库，存储可行走表面
- **path_3d.js**: 体素 A* 路径规划
- **executor.js**: 路径执行器，处理障碍、爬梯、游泳
- **nav.js**: 统一导航入口

### 2. 任务队列系统 (Task Queue)
- **个人任务队列**: 每个 Bot 独立的任务队列
- **共享任务池**: 所有空闲 Bot 可认领的任务
- **优先级调度**: 0-10 级优先级
- **依赖管理**: 任务间依赖关系处理

### 3. 多 Bot 协调 (Bot Manager)
- **Bot 注册与管理**: 统一管理多个 Bot 实例
- **任务分配**: 基于能力和位置智能分配
- **协作模式**: 流水线、并行、主从、竞争
- **状态同步**: 实时同步各 Bot 状态

## 调用规则

```
✓ 允许:
  Layer 1 → Layer 2, 3, 4
  Layer 2 → Layer 2 (其他任务), 3, 4
  Layer 3 → Layer 4
  Layer 4 → bot.* API

✗ 禁止:
  - 下层调用上层
  - 跨层调用 (除非有充分理由)
  - 原子层包含复合逻辑
  - 动作层直接调用 bot.* API (应通过原子)
```

## 统一结果规范

**原子层与执行器之间**统一使用 `ActionResult`（实现见 `src/agent/library/atom_contract.js`）：

```javascript
{
  ok: boolean,               // 是否成功（不是 success！）
  code: string,              // 只能取自 31 条白名单，见 ARCHITECTURE_REDESIGN §6.2
  message: string,           // 人类可读消息（失败时不能为空）
  data: object               // 字段受白名单约束，见 §6.3
}
```

辅助函数:
- `ok(data)`: 返回 `{ok:true, code:'OK', message:'', data}`
- `fail(code, message, data)`: 码不在白名单内会**抛异常**

> ⚠️ 两个常犯的错：
> 1. 写成 `success: true` —— 代码里没有这个字段，`if (result.success)` 恒为 `undefined`。
> 2. `fail('OPERATION_FAILED', ...)` 自创码名 —— 直接抛异常。
>
> **技能层例外**：`skills.js` 的老函数仍是「动作类返回 boolean / 查询类返回对象」，
> 只有 `atom_*.js` 和读 `.ok` 的执行器用 `ActionResult`。两套并存是有意的，别去"统一"。

## 目录结构

**现状（可直接对照仓库）**：所有组件**平铺在 `src/agent/library/` 一个目录里**，
没有 `primitives/`、`actions/`、`tasks/`、`skills/`、`navigation/`、`core/` 这些子目录。

```
mindcraft/
├── src/agent/
│   ├── library/                 # 现状：全部平铺在这里
│   │   ├── atom_*.js            # 22 个原子
│   │   ├── task_*.js            # 5 个（含 task_modes：mode 管理器）
│   │   ├── skill_*.js           # 4 个（+ 遗留 skills.js）
│   │   ├── executor.js          # 3D 导航执行器
│   │   ├── path_3d.js / path_short.js / terrain3d.js
│   │   └── atom_contract.js     # ActionResult / CODES / normalizeTarget
│   ├── commands/                # LLM 命令层（actions / queries / index）
│   ├── agent.js / action_manager.js / conversation.js
│   └── ...
├── tools/                       # preflight、原子测试脚本 atom_*.mjs
└── docs/
    ├── architecture/            # 本目录 = 新规范（权威）
    └── legacy/                  # 旧规范（历史参考，已被本目录取代）
```

**目标结构（分层目录）** 见 `ARCHITECTURE_REDESIGN.md §4.1` 与 `REFACTOR_ANALYSIS.md §6`。
⚠️ 该结构**尚未创建**：`library/atoms/`、`library/nav/` 这类路径只存在于设计稿和示例代码里，
现在照抄 import 路径会直接报模块找不到。

**本目录文档清单（实际存在的 7 份）**：

| 文件 | 角色 |
|------|------|
| `00_overview.md` | 本文件：总览与阅读顺序 |
| `01_primitives.md` | 原子层组件清单（规划态 35 个 / 现状 22 个） |
| `03_tasks.md` | 任务层清单（规划态 30-40 / 现状 5） |
| `04_skills.md` | ❌ **未创建** |
| `05_navigation.md` | 导航系统（注意：文中 `nav.js` 实际不存在） |
| `06_task_queue.md` | ❌ **未创建** |
| `07_multi_bot.md` | ❌ **未创建** |
| `REFACTOR_ANALYSIS.md` | 现状诊断 + **D1–D13 台账** + 勾选式路线图 |
| `ARCHITECTURE_REDESIGN.md` | 六层目标架构 + **§6 契约（权威）** |
| `ARCHITECTURE_REDESIGN_PART2.md` | 测试策略 + 实施路线图 + 机制附录 |

> `02_actions.md`（动作层 40-50 个）**已归档到 `../legacy/02_actions.md`**：
> 六层架构里没有动作层，它的内容是"能力盘点"，不是现行规范。

## 开发流程

### 添加新功能的步骤:

1. **需求分析**: 确定功能属于哪一层
2. **接口设计**: 定义输入参数和返回值
3. **依赖梳理**: 列出需要调用的下层函数
4. **实现**: 编写代码，遵循分层规则
5. **测试**: 编写单元测试
6. **注册**: 将新功能注册到 registry
7. **文档**: 更新相关文档

### 示例: 添加"钓鱼"功能

```
需求: 实现自动钓鱼
分层:
  - 原子: atom_use_item (使用钓鱼竿), atom_wait_event (等待鱼上钩)
  - 动作: action_cast_fishing_rod (抛竿+等待+收竿)
  - 任务: task_fish (循环钓鱼，管理耐久度和库存)
  - 技能: skill_auto_fish (找水→钓鱼→整理鱼获→修复钓竿)
```

## 迁移计划

当前代码库中的 `library/skills.js` 需要逐步迁移到新架构:

1. **Phase 1**: 建立新架构框架
   - 创建目录结构
   - 实现核心系统 (ActionResult, Registry, TaskQueue)
   - 迁移导航系统

2. **Phase 2**: 迁移基础能力
   - 实现所有原子 (35 个)
   - 迁移常用动作 (10-15 个)
   - 迁移核心任务 (5-10 个)

3. **Phase 3**: 迁移高级功能
   - 迁移剩余动作和任务
   - 实现复合技能
   - 建立 LLM 调用接口

4. **Phase 4**: 多 Bot 支持
   - 实现任务队列
   - 实现 Bot 管理器
   - 实现协作任务

5. **Phase 5**: 清理与优化
   - 删除旧代码
   - 性能优化
   - 完善文档

## 相关文档

- [01_primitives.md](./01_primitives.md) - 原子层完整清单与开发指南
- [03_tasks.md](./03_tasks.md) - 任务层完整清单与开发指南
- [05_navigation.md](./05_navigation.md) - 导航系统架构与使用
- [REFACTOR_ANALYSIS.md](./REFACTOR_ANALYSIS.md) - 现状盘点与问题台账
- [ARCHITECTURE_REDESIGN.md](./ARCHITECTURE_REDESIGN.md) - 目标架构与**契约（权威）**
- [ARCHITECTURE_REDESIGN_PART2.md](./ARCHITECTURE_REDESIGN_PART2.md) - 测试策略与路线图

**不存在的文档**（原计划有，实际未写）：`04_skills.md`、`06_task_queue.md`、`07_multi_bot.md`。
需要技能层/任务队列/多 Bot 的正式规范时，得先补写，不要引用空链接。
