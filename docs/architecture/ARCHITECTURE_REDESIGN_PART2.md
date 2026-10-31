# Minecraft Agent 架构重新设计 - 第二部分

## 10. 测试策略

### 10.1 测试金字塔

```
        /\
       /  \  E2E测试 (5%) - 完整场景，真实服务器
      /____\
     /      \  集成测试 (25%) - 任务/技能层，Mock bot
    /________\
   /          \  单元测试 (70%) - 原子层，纯函数
  /__________\
```

### 10.2 单元测试（原子层）

**目标**：每个原子100%覆盖，Mock bot API

```javascript
// tests/atoms/atom_dig.test.js
import { digBlock } from '../../src/agent/library/atoms/atom_dig.js';
import { createMockBot } from '../mocks/bot.js';

describe('atom_dig', () => {
  let bot;
  
  beforeEach(() => {
    bot = createMockBot();
  });
  
  it('should dig a block successfully', async () => {
    const pos = {x: 0, y: 64, z: 0};
    bot.blockAt = jest.fn().mockReturnValue({name: 'stone', hardness: 1.5});
    bot.dig = jest.fn().mockResolvedValue();
    
    const r = await digBlock(bot, pos);
    
    expect(r.ok).toBe(true);
    expect(bot.dig).toHaveBeenCalledWith(expect.objectContaining(pos));
  });
  
  it('should fail if block is unbreakable', async () => {
    const pos = {x: 0, y: 64, z: 0};
    bot.blockAt = jest.fn().mockReturnValue({name: 'bedrock', hardness: -1});
    
    const r = await digBlock(bot, pos);
    
    expect(r.ok).toBe(false);
    expect(r.code).toBe('UNBREAKABLE');
  });
  
  it('should timeout after specified duration', async () => {
    const pos = {x: 0, y: 64, z: 0};
    bot.blockAt = jest.fn().mockReturnValue({name: 'obsidian', hardness: 50});
    bot.dig = jest.fn().mockImplementation(() => new Promise(() => {})); // 永不resolve
    
    const r = await digBlock(bot, pos, {timeout: 100});
    
    expect(r.ok).toBe(false);
    expect(r.code).toBe('TIMEOUT');
  });
});
```

### 10.3 集成测试（任务层）

**目标**：任务流程测试，Mock原子/导航

```javascript
// tests/tasks/task_collect.test.js
import { collect } from '../../src/agent/library/tasks/task_collect.js';
import { createMockBot } from '../mocks/bot.js';
import * as atoms from '../../src/agent/library/atoms/index.js';
import * as nav from '../../src/agent/library/nav/nav_core.js';

jest.mock('../../src/agent/library/atoms/index.js');
jest.mock('../../src/agent/library/nav/nav_core.js');

describe('task_collect', () => {
  let bot;
  
  beforeEach(() => {
    bot = createMockBot();
    atoms.perceive.mockResolvedValue(ok({blocks: [{x: 0, y: 64, z: 0, name: 'oak_log'}]}));
    atoms.digBlock.mockResolvedValue(ok({}));
    nav.goTo.mockResolvedValue(ok({dist: 0}));
  });
  
  it('should collect 10 oak_logs successfully', async () => {
    const r = await collect(bot, 'oak_log', {count: 10, mapDir: '/tmp/map'});
    
    expect(r.ok).toBe(true);
    expect(r.data.collected).toBe(10);
    expect(nav.goTo).toHaveBeenCalled();
    expect(atoms.digBlock).toHaveBeenCalledTimes(10);
  });
  
  it('should handle navigation failure gracefully', async () => {
    nav.goTo.mockResolvedValue(fail('UNREACHABLE', 'Too far'));
    
    const r = await collect(bot, 'diamond_ore', {count: 1});
    
    expect(r.ok).toBe(false);
    expect(r.code).toBe('UNREACHABLE');
  });
  
  it('should cleanup resources on interrupt', async () => {
    const interruptAfter = 2;
    let digCount = 0;
    
    atoms.digBlock.mockImplementation(async () => {
      digCount++;
      if (digCount >= interruptAfter) {
        bot.interrupt_code = 'USER_STOP';
      }
      return ok({});
    });
    
    const r = await collect(bot, 'stone', {count: 10});
    
    expect(r.code).toBe('INTERRUPTED');
    expect(digCount).toBe(interruptAfter);
    // 验证modes已恢复
    expect(bot.modes.paused).toEqual([]);
  });
});
```

### 10.4 E2E测试（真实场景）

**目标**：在测试服务器上跑完整场景

```javascript
// tests/e2e/survival_scenario.test.js
import { createBot } from 'mineflayer';
import { Agent } from '../../src/agent/agent.js';

describe('E2E: Basic Survival', () => {
  let bot;
  let agent;
  
  beforeAll(async () => {
    bot = createBot({
      host: 'localhost',
      port: 25565,
      username: 'test_agent'
    });
    
    await new Promise(resolve => bot.once('spawn', resolve));
    agent = new Agent(bot);
  }, 30000);
  
  afterAll(async () => {
    bot.quit();
  });
  
  it('should collect wood, craft tools, build shelter', async () => {
    // 1. 采集木头
    await agent.performAction('!collectBlocks', 'oak_log', 10);
    expect(bot.inventory.count('oak_log')).toBeGreaterThanOrEqual(10);
    
    // 2. 合成工作台
    await agent.performAction('!craftRecipe', 'crafting_table', 1);
    expect(bot.inventory.count('crafting_table')).toBe(1);
    
    // 3. 合成工具
    await agent.performAction('!craftRecipe', 'wooden_pickaxe', 1);
    expect(bot.inventory.count('wooden_pickaxe')).toBe(1);
    
    // 4. 建造3x3平台
    await agent.performAction('!buildPlatform', 3);
    // 验证平台存在
    const pos = bot.entity.position.floored();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const block = bot.blockAt({x: pos.x + dx, y: pos.y - 1, z: pos.z + dz});
        expect(block.name).not.toBe('air');
      }
    }
  }, 120000); // 2分钟超时
});
```

### 10.5 回归测试（D1-D13缺陷）

**目标**：确保已知缺陷不再出现

```javascript
// tests/regression/defects.test.js
describe('Regression: D1 y语义混乱', () => {
  it('should use floor y consistently', async () => {
    const bot = createMockBot({position: {x: 0, y: 64.3, z: 0}});
    const mapDir = '/tmp/map';
    
    // 记录到terrain3d的y应该是64（脚格）
    const db = getTerrainDB(mapDir);
    await db.recordBlock(0, 64, 0, 'grass_block');
    
    // executor读取的y也应该是64
    const col = await db.readColumn(0, 0);
    expect(col.find(b => b.type === 'grass_block').y).toBe(64);
  });
});

describe('Regression: D7 ScaffoldTracker清错块', () => {
  it('should only clean self-placed blocks', async () => {
    const bot = createMockBot();
    const tracker = new ScaffoldTracker(bot);
    
    // bot自己放置
    const pos1 = {x: 0, y: 64, z: 0};
    tracker.recordPlacement(pos1, 'dirt');
    bot.emit('blockUpdate', null, bot.blockAt(pos1));
    
    // 其他玩家放置
    const pos2 = {x: 1, y: 64, z: 0};
    bot.emit('blockUpdate', null, bot.blockAt(pos2));
    
    // 清理
    const cleaned = await tracker.cleanup();
    
    expect(cleaned).toEqual([pos1]);
    expect(cleaned).not.toContainEqual(pos2);
  });
});
```

### 10.6 性能测试

```javascript
// tests/performance/terrain3d.perf.js
describe('Performance: terrain3d', () => {
  it('should query column in <10ms with connection pool', async () => {
    const db = getTerrainDB('/tmp/map');
    await db.connect();
    
    // 预热
    await db.readColumn(0, 0);
    
    // 测量
    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      await db.readColumn(i, i);
    }
    const elapsed = Date.now() - start;
    
    expect(elapsed / 100).toBeLessThan(10); // 平均<10ms
  });
});
```

---

## 11. 实施路线图

### Phase 1: 基础设施修复（1-2周）

**目标**：修复D1-D13缺陷，无新功能

| 任务 | 工作量 | 交付物 | 风险 |
|------|--------|--------|------|
| 1.1 统一y语义 | 3天 | terrain3d+executor+path_3d统一为脚格 | 🔴高：破坏现有路径 |
| 1.2 SQLite连接池 | 2天 | 连接池+预编译语句缓存 | 🟢低 |
| 1.3 fail表TTL | 1天 | timestamp列+清理函数 | 🟢低 |
| 1.4 ScaffoldTracker修复 | 1天 | 只清自己放的块 | 🟡中 |
| 1.5 垫脚块清单统一 | 1天 | config/blocks.js | 🟢低 |
| 1.6 task_collect泄漏 | 1天 | finally块+ResourceTracker | 🟢低 |
| 1.7 tool_prep超时 | 1天 | 添加deadline检查 | 🟢低 |

**测试**：10个回归测试case（D1-D13）

**交付物**：mindcraft-v0.2-hotfix

---

### Phase 2: 原子层规范化（2-3周）

**目标**：所有原子遵守契约，新增P0原子

#### 2.1 重构现有原子（1周）
| 任务 | 改动 |
|------|------|
| atom_drops | 删除循环，只返回最近drop坐标 |
| atom_tunnel | 只保留tunnelStep，删tunnelAlong |
| atom_dig | 移除直接按键，参数化 |
| atom_classify | landmarks通过参数传递 |

#### 2.2 新增P0原子（1-2周）
| 原子 | 工作量 | 依赖 |
|------|--------|------|
| atom_pathfind | 2天 | bot.pathfinder |
| atom_pillar | 2天 | bot.setControlState |
| atom_stuck_detect | 1天 | 位置历史 |
| atom_craft | 3天 | bot.craft + 工作台放置 |
| atom_smelt | 2天 | 熔炉交互 |
| atom_eat | 1天 | bot.consume |

**测试**：每个原子3-5个单元测试

**交付物**：mindcraft-v0.3-atoms

---

### Phase 3: 导航层统一（2-3周）

**目标**：单一移动入口，消除pathfinder vs walkTo分裂

#### 3.1 nav_core.js（1周）
```javascript
// 实现goTo统一入口
export async function goTo(bot, dest, options) {
  // 引擎选择逻辑
  // mode管理
  // 被困检测集成
}
```

#### 3.2 executor重构（1周）
- 拆分为walkLoop + steps/目录
- 移除mode管理
- 移除直接按键（调atom_pillar）

#### 3.3 集成（1周）
- task_hop并入nav_core
- actions.js所有移动改调goTo
- 删除path_short.js

**测试**：AB测试pathfinder vs walkTo 10个场景

**交付物**：mindcraft-v0.4-nav

---

### Phase 4: 任务与技能层扩展（4-6周）

**目标**：新增P0任务/技能，支持核心游戏循环

#### 4.1 P0任务（3周）
| 任务 | 工作量 | 优先级理由 |
|------|--------|-----------|
| task_build | 5天 | LLM最高频命令 |
| task_mine | 3天 | 资源循环核心 |
| task_farm | 4天 | 食物循环核心 |
| task_craft | 3天 | 合成链支撑 |
| task_smelt | 2天 | 矿石加工必需 |

#### 4.2 P0技能（2周）
| 技能 | 工作量 |
|------|--------|
| skill_craft_chain | 3天 |
| skill_wood | 2天 |
| skill_unstuck | 2天 |
| skill_survival | 3天 |

#### 4.3 命令层集成（1周）
- actions.js添加新命令
- 路由到新任务/技能
- 更新LLM提示

**测试**：每个任务1个集成测试 + 3个E2E场景

**交付物**：mindcraft-v0.5-gameplay

---

### Phase 5: 配置与上游清理（1-2周）

**目标**：消除功能重复，统一配置

| 任务 | 工作量 |
|------|--------|
| config统一 | 2天 |
| skills.js废弃标记 | 1天 |
| mode管理统一 | 2天 |
| mapDir统一 | 1天 |
| 文档更新 | 2天 |

**交付物**：mindcraft-v0.6-cleanup

---

### Phase 6: 多Bot协作（2-3周，可选）

**目标**：支持多bot协作场景

| 组件 | 工作量 |
|------|--------|
| bot_registry | 2天 |
| resource_manager | 3天 |
| comm_bus | 2天 |
| task_coordinator | 3天 |
| 协作场景测试 | 3天 |

**交付物**：mindcraft-v0.7-multi

---

### Phase 7: 性能优化与测试（2-3周）

**目标**：生产级质量

| 任务 | 工作量 | 目标 |
|------|--------|------|
| 单元测试补全 | 5天 | 70%+ 覆盖率 |
| 集成测试 | 3天 | 25%+ 覆盖率 |
| E2E测试 | 3天 | 5个核心场景 |
| 性能优化 | 3天 | terrain3d <10ms, walkTo <200ms |
| 文档完善 | 2天 | API文档 + 架构图 |

**交付物**：mindcraft-v1.0

---

## 12. 附录：Minecraft机制参考

### 12.1 核心机制清单

#### A. 生存机制
| 机制 | 优先级 | 当前状态 | 所需组件 |
|------|--------|---------|---------|
| 饥饿值（0-20） | P0 | ⚠️ 能吃但不监控 | skill_survival监控 |
| 健康值（0-20） | P0 | ⚠️ self_preservation部分 | atom_heal |
| 氧气值（潜水） | P1 | ❌ 无 | 导航层已有潜水 |
| 摔落伤害 | P1 | ✅ pathfinder避免 | - |
| 状态效果（中毒等） | P1 | ❌ 无 | atom_potion |

#### B. 战斗机制
| 机制 | 优先级 | 当前状态 | 所需组件 |
|------|--------|---------|---------|
| 攻击（近战） | P0 | ✅ atom_attack | - |
| 盾牌格挡 | P1 | ❌ 无 | atom_shield |
| 弓箭射击 | P1 | ❌ 无 | atom_shoot |
| 暴击（跳跃攻击） | P2 | ❌ 无 | skill_combat |
| 附魔武器 | P1 | ❌ 无 | atom_enchant |

#### C. 合成机制
| 类型 | 优先级 | 当前状态 | 所需组件 |
|------|--------|---------|---------|
| 2x2合成 | P0 | ✅ craftRecipe | atom_craft统一 |
| 3x3合成（工作台） | P0 | ✅ craftRecipe | atom_craft |
| 熔炉 | P0 | ❌ 无 | atom_smelt |
| 高炉 | P2 | ❌ 无 | atom_smelt扩展 |
| 烟熏炉 | P2 | ❌ 无 | atom_smelt扩展 |
| 酿造台 | P1 | ❌ 无 | atom_brew |
| 附魔台 | P1 | ❌ 无 | atom_enchant |
| 铁砧 | P2 | ❌ 无 | atom_anvil |
| 锻造台 | P2 | ❌ 无 | atom_smithing |

#### D. 农业机制
| 机制 | 优先级 | 当前状态 | 所需组件 |
|------|--------|---------|---------|
| 种植作物 | P0 | ❌ 无（仅作弊） | atom_plant |
| 收割作物 | P0 | ❌ 无 | task_farm |
| 骨粉催熟 | P1 | ❌ 无 | atom_use |
| 堆肥桶 | P2 | ❌ 无 | atom_container扩展 |
| 动物繁殖 | P2 | ❌ 无 | atom_breed |

#### E. 交易机制
| 机制 | 优先级 | 当前状态 | 所需组件 |
|------|--------|---------|---------|
| 村民交易 | P1 | ⚠️ 手动 | atom_trade |
| 刷新交易 | P2 | ❌ 无 | task_trade循环 |
| 村民职业 | P2 | ❌ 无 | skill_villager |
| 降价机制 | P2 | ❌ 无 | skill_trade |

#### F. 红石机制
| 机制 | 优先级 | 当前状态 | 所需组件 |
|------|--------|---------|---------|
| 拉杆/按钮 | P2 | ❌ 无 | atom_lever |
| 门 | P2 | ❌ 无 | atom_door |
| 活塞 | P2 | ❌ 无 | atom_piston |
| 红石线 | P2 | ❌ 无 | task_automate |
| 比较器/中继器 | P2 | ❌ 无 | 复杂，待定 |

#### G. 探索机制
| 机制 | 优先级 | 当前状态 | 所需组件 |
|------|--------|---------|---------|
| 下界传送门 | P2 | ❌ 无 | task_dimension |
| 末地传送门 | P2 | ❌ 无 | task_dimension |
| 地图 | P2 | ❌ 无 | atom_map |
| 指南针 | P1 | ❌ 无 | 导航层已有坐标 |

### 12.2 方块类型分类

#### 可挖掘方块
```javascript
// config/blocks.js
export const MINEABLE_BLOCKS = {
  pickaxe: ['stone', 'cobblestone', 'iron_ore', 'gold_ore', ...],
  axe: ['oak_log', 'birch_log', 'oak_planks', ...],
  shovel: ['dirt', 'sand', 'gravel', ...],
  sword: ['cobweb'],
  shears: ['wool', 'leaves'],
  none: ['dirt', 'sand', 'gravel', 'oak_log', ...] // 徒手可挖
};
```

#### 重力方块
```javascript
export const GRAVITY_BLOCKS = [
  'sand', 'red_sand', 'gravel',
  'concrete_powder', // 16色
  'anvil', 'damaged_anvil', 'chipped_anvil'
];
```

#### 不可破坏方块
```javascript
export const UNBREAKABLE_BLOCKS = [
  'bedrock', 'barrier', 'command_block',
  'structure_block', 'jigsaw', 'light'
];
```

#### 垫脚块（便宜+可回收）
```javascript
export const SCAFFOLD_BLOCKS = [
  'dirt', 'cobblestone', 'netherrack', 'stone'
];
```

### 12.3 物品分类

#### 工具耐久度
```javascript
export const TOOL_DURABILITY = {
  wooden: 59,
  stone: 131,
  iron: 250,
  gold: 32,
  diamond: 1561,
  netherite: 2031
};
```

#### 食物恢复值
```javascript
export const FOOD_VALUES = {
  apple: {hunger: 4, saturation: 2.4},
  bread: {hunger: 5, saturation: 6.0},
  cooked_beef: {hunger: 8, saturation: 12.8},
  golden_apple: {hunger: 4, saturation: 9.6, effects: ['regeneration', 'absorption']},
  ...
};
```

### 12.4 合成配方示例

```javascript
// 木板 ← 木头（任意树种）
{
  result: 'oak_planks',
  count: 4,
  ingredients: ['oak_log'],
  requiresTable: false
}

// 工作台 ← 木板
{
  result: 'crafting_table',
  count: 1,
  ingredients: ['planks', 'planks', 'planks', 'planks'],
  requiresTable: false,
  shape: [[1,1], [1,1]]
}

// 木镐 ← 木板 + 木棍
{
  result: 'wooden_pickaxe',
  count: 1,
  ingredients: ['planks:3', 'stick:2'],
  requiresTable: true,
  shape: [[1,1,1], [0,2,0], [0,2,0]]
}

// 铁锭 ← 铁矿石（熔炼）
{
  result: 'iron_ingot',
  count: 1,
  input: 'iron_ore',
  fuel: 'coal', // 或木炭、木板
  time: 10000, // 10秒
  requiresFurnace: true
}
```

---

## 总结与下一步

### 设计亮点

1. **完整机制覆盖**：从40%提升到90%+，支持生存/建造/战斗/社交全循环
2. **严格分层**：六层架构，职责清晰，强制契约，可测试
3. **LLM友好**：决策层分离，简化参数，丰富反馈，错误可恢复
4. **多Bot就绪**：去中心化协调，共享资源锁，角色专化
5. **生产级质量**：80%测试覆盖，性能优化，错误恢复，日志完善

### 关键指标对比

| 指标 | 现状 | 目标 | 提升 |
|------|------|------|------|
| 游戏机制覆盖 | 40% (11/27) | 90% (24/27) | +125% |
| 原子层组件 | 22个 | 38个 | +73% |
| 任务层组件 | 8个 | 22个 | +175% |
| 技能层组件 | 3个 | 14个 | +367% |
| LLM可用命令 | 42个 | 60+个 | +43% |
| 测试覆盖率 | ~5% | 80% | +1500% |
| terrain3d查询 | ~50ms | <10ms | +400% |
| 分层违规 | 13处 | 0处 | -100% |
| 功能重复 | 11处 | 0处 | -100% |

### 立即可做

**Phase 1（1-2周）已准备就绪**：
1. 统一y语义（方案B已确定）
2. SQLite连接池（设计完成）
3. 修复D1-D13缺陷（已分析）

**用户确认项**：
- ✅ y语义方案B（实心方块）
- ✅ 全部Phase都要做
- ✅ P0+P1+P2组件都规划

### 实施建议

1. **渐进式重构**：每个Phase可独立工作，无需大爆炸式重写
2. **向后兼容**：保留废弃包装器6个月，给LLM提示足够时间更新
3. **测试驱动**：先写回归测试（D1-D13），再改代码
4. **灰度发布**：10% → 50% → 100%，每阶段观察7天
5. **文档先行**：每个Phase开始前更新API文档

### 风险控制

| 风险 | 缓解措施 |
|------|---------|
| y语义破坏现有路径 | 真机回归测试10场景 + AB测试 |
| 导航层统一引入新bug | 保留旧引擎1个月，双轨运行 |
| 多bot竞态条件 | Phase 6独立，先单bot稳定 |
| LLM调用旧命令 | 废弃包装器 + 提示更新 |
| 开发周期过长 | P2组件可延后，先完成P0+P1 |

### 成功标准

**Phase 1-5完成后（3-4个月）**：
- ✅ 所有D1-D13缺陷修复
- ✅ 所有P0组件就位（生存循环完整）
- ✅ 测试覆盖率60%+
- ✅ 性能提升30%+
- ✅ 无分层违规、无功能重复

**v1.0完成后（5-6个月）**：
- ✅ P0+P1组件全部完成
- ✅ 测试覆盖率80%+
- ✅ 多bot协作基础设施就绪
- ✅ 生产级文档和示例

---

**文档结束**

此架构设计基于：
- 现有代码库深度分析（22原子+11复合+4导航）
- Minecraft游戏机制完整梳理（6大循环×27子能力）
- 13处可证缺陷诊断
- 11处功能重复识别
- LLM可调用性优化
- 多Bot协作前瞻设计

已准备好进入Phase 1实施。
