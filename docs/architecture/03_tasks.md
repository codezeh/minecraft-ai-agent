# 任务层 (Layer 2: Tasks)

> **本文列的是规划清单（30-40 个），现状只有 5 个**：`task_collect` / `task_follow` / `task_hop` /
> `task_platform` / `task_modes`（最后一个是 mode 管理器，不是任务）。
> 契约（返回结构、错误码、参数命名）以 [`ARCHITECTURE_REDESIGN.md §6`](./ARCHITECTURE_REDESIGN.md) 为准。
>
> ⚠️ 六层架构中任务层**直接调导航层**（`nav_core.goTo`），不经过 Actions 层——本文若出现
> 调用"动作层"的链路，按"直接调 atom_*"理解。

## 设计原则

任务层实现**具体的游戏目标**，管理多阶段流程、状态机、失败重试等复杂逻辑。

**任务 vs 动作**:
- **动作**: 单阶段，线性流程，简单重试
- **任务**: 多阶段，状态机，复杂决策

## 接口规范

```javascript
/**
 * 任务标准签名
 * @param {Bot} bot
 * @param {Object} params - 任务参数
 * @param {Object} options - 可选配置
 * @returns {Promise<ActionResult>}
 */
async function task_xxx(bot, params, options = {}) {
  const { onProgress, deadline, priority = 5 } = options;
  
  // 1. 初始化状态
  const state = initializeState(params);
  
  // 2. 执行状态机
  while (!state.done) {
    const result = await executeState(bot, state, options);
    
    if (!result.success) {
      // 决定是否重试、切换状态、或失败
      const decision = handleFailure(result, state);
      if (decision === 'abort') {
        return result;
      }
    }
    
    // 3. 进度报告
    if (onProgress) {
      onProgress(state.progress);
    }
    
    // 4. 超时检查
    if (deadline && Date.now() > deadline) {
      return fail('TIMEOUT', 'Task deadline exceeded', { state });
    }
  }
  
  return ok(state.result);
}
```

## 完整任务清单 (30-40 个)

### 1. 采集任务 (8 个)

#### task_collect_blocks
采集方块（带规划和黑名单）

```javascript
async function task_collect_blocks(bot, { blockType, count, near }, options = {})
```

**状态机**:
```
PLAN → NAVIGATE → COLLECT → CHECK_COUNT → (PLAN | DONE)
```

**特性**:
- 规划最优采集路径
- 失败目标加黑名单
- 工具耐久管理
- 背包满处理

**当前问题（D3）**: onFail 只处理 NO_PATH/TIMEOUT，漏处理 NO_REACH/STUCK

#### task_gather_resources
收集多种资源

```javascript
async function task_gather_resources(bot, { resources }, options = {})
// resources: [{ type, count, priority }, ...]
```

#### task_harvest_farm
收获农场

```javascript
async function task_harvest_farm(bot, { farmArea, crops }, options = {})
```

#### task_chop_forest
砍伐森林

```javascript
async function task_chop_forest(bot, { area, treeType }, options = {})
```

#### task_mine_vein
挖掘矿脉

```javascript
async function task_mine_vein(bot, { oreType, startPosition }, options = {})
```

**流程**:
1. 找到矿脉起点
2. 递归挖掘相邻矿石
3. 收集掉落物

#### task_collect_drops
收集掉落物

```javascript
async function task_collect_drops(bot, { itemTypes, area }, options = {})
```

#### task_strip_mine
挖掘隧道式采矿

```javascript
async function task_strip_mine(bot, { startPos, length, branches }, options = {})
```

#### task_quarry
露天采矿场

```javascript
async function task_quarry(bot, { area, depth }, options = {})
```

---

### 2. 建造任务 (7 个)

#### task_build_structure
建造结构

```javascript
async function task_build_structure(bot, { schematic, position }, options = {})
```

**状态机**:
```
LOAD_SCHEMATIC → CHECK_MATERIALS → GATHER_MATERIALS → 
CLEAR_SITE → BUILD_FOUNDATION → BUILD_WALLS → BUILD_ROOF → DONE
```

#### task_build_house
建造房屋

```javascript
async function task_build_house(bot, { position, size, style }, options = {})
```

#### task_build_farm
建造农场

```javascript
async function task_build_farm(bot, { position, cropType, size }, options = {})
```

#### task_build_road
修建道路

```javascript
async function task_build_road(bot, { waypoints, material }, options = {})
```

#### task_build_wall
建造防御墙

```javascript
async function task_build_wall(bot, { perimeter, height }, options = {})
```

#### task_landscape
地形改造

```javascript
async function task_landscape(bot, { area, targetHeight }, options = {})
```

#### task_decorate
装饰区域

```javascript
async function task_decorate(bot, { area, theme }, options = {})
```

---

### 3. 合成任务 (5 个)

#### task_craft_item
合成物品（自动收集材料）

```javascript
async function task_craft_item(bot, { item, count }, options = {})
```

**状态机**:
```
CHECK_RECIPE → CHECK_MATERIALS → 
(GATHER_MATERIALS | FIND_CRAFTING_TABLE) → CRAFT → DONE
```

#### task_craft_tools
制作工具套装

```javascript
async function task_craft_tools(bot, { material, tools }, options = {})
// tools: ['pickaxe', 'axe', 'shovel', 'sword']
```

#### task_smelt_batch
批量熔炼

```javascript
async function task_smelt_batch(bot, { item, count, furnacePos }, options = {})
```

**流程**:
1. 准备燃料和材料
2. 找到/放置熔炉
3. 放入材料和燃料
4. 等待完成
5. 取出产物

#### task_brew_potions
批量酿造药水

```javascript
async function task_brew_potions(bot, { potions, brewingStand }, options = {})
```

#### task_upgrade_equipment
升级装备

```javascript
async function task_upgrade_equipment(bot, { target }, options = {})
```

**流程**: 收集材料 → 合成更好的装备 → 附魔 → 装备

---

### 4. 战斗任务 (4 个)

#### task_hunt_mobs
狩猎生物

```javascript
async function task_hunt_mobs(bot, { mobType, count }, options = {})
```

#### task_defend_area
防守区域

```javascript
async function task_defend_area(bot, { area, duration }, options = {})
```

**状态机**:
```
PATROL → (DETECT_THREAT → ENGAGE → PATROL | TIMEOUT)
```

#### task_raid_dungeon
清理地牢

```javascript
async function task_raid_dungeon(bot, { entrance }, options = {})
```

#### task_boss_fight
Boss 战

```javascript
async function task_boss_fight(bot, { bossType, arena }, options = {})
```

---

### 5. 探索任务 (5 个)

#### task_explore_area
探索区域

```javascript
async function task_explore_area(bot, { center, radius }, options = {})
```

**状态机**:
```
PLAN_WAYPOINTS → NAVIGATE → SCAN → RECORD → 
(NEXT_WAYPOINT | DONE)
```

#### task_find_structure
寻找结构

```javascript
async function task_find_structure(bot, { structureType }, options = {})
// structureType: 'village', 'stronghold', 'dungeon', ...
```

#### task_map_area
绘制地图

```javascript
async function task_map_area(bot, { area }, options = {})
```

#### task_find_biome
寻找生物群系

```javascript
async function task_find_biome(bot, { biomeType }, options = {})
```

#### task_scout_ahead
侦察前方

```javascript
async function task_scout_ahead(bot, { direction, distance }, options = {})
```

---

### 6. 跟随任务 (3 个)

#### task_follow_player
跟随玩家

```javascript
async function task_follow_player(bot, { playerName, distance }, options = {})
```

**状态机**:
```
LOCATE_PLAYER → (CLOSE_FOLLOW | DISTANT_NAVIGATE) → 
LOST → SEARCH → TIMEOUT
```

**当前问题**:
- D5: followEntity 高差时空转超时
- D13: goToPlayer attempt >= 1 恒真

#### task_follow_entity
跟随实体

```javascript
async function task_follow_entity(bot, { entity, distance }, options = {})
```

#### task_escort
护送目标

```javascript
async function task_escort(bot, { target, destination }, options = {})
```

**流程**: 跟随 + 清除威胁 + 引导路径

---

### 7. 农业任务 (6 个)

#### task_farm_crops
种植并维护农场

```javascript
async function task_farm_crops(bot, { farmArea, cropType }, options = {})
```

**循环状态机**:
```
CHECK_CROPS → (HARVEST | PLANT | WATER | WAIT) → CHECK_CROPS
```

#### task_plant_field
种植田地

```javascript
async function task_plant_field(bot, { area, crop }, options = {})
```

#### task_breed_animals
繁殖动物

```javascript
async function task_breed_animals(bot, { animalType, targetCount }, options = {})
```

#### task_manage_ranch
管理牧场

```javascript
async function task_manage_ranch(bot, { ranch }, options = {})
```

**循环**: 喂食 → 繁殖 → 收获产物（羊毛/牛奶）→ 控制数量

#### task_automated_farm
自动化农场

```javascript
async function task_automated_farm(bot, { farmArea, schedule }, options = {})
```

#### task_tree_farm
树场循环

```javascript
async function task_tree_farm(bot, { area, treeType }, options = {})
```

---

### 8. 管理任务 (2 个)

#### task_organize_storage
整理存储系统

```javascript
async function task_organize_storage(bot, { storageArea, rules }, options = {})
```

**流程**:
1. 扫描所有箱子
2. 按规则分类物品
3. 转移到对应箱子
4. 标记箱子

#### task_inventory_management
背包管理

```javascript
async function task_inventory_management(bot, { keep, discard }, options = {})
```

---

## 状态机框架

### 通用状态机实现

```javascript
class TaskStateMachine {
  constructor(initialState, transitions) {
    this.state = initialState;
    this.transitions = transitions;
    this.history = [];
  }
  
  async run(bot, context) {
    while (this.state !== 'DONE' && this.state !== 'FAILED') {
      this.history.push(this.state);
      
      const handler = this.transitions[this.state];
      if (!handler) {
        return fail('INVALID_STATE', `No handler for state: ${this.state}`);
      }
      
      const result = await handler(bot, context, this);
      
      if (!result.success) {
        const nextState = this.onFailure(result);
        if (nextState) {
          this.state = nextState;
        } else {
          this.state = 'FAILED';
          return result;
        }
      } else {
        this.state = result.data.nextState || 'DONE';
      }
    }
    
    return this.state === 'DONE' 
      ? ok({ history: this.history }) 
      : fail('TASK_FAILED', 'State machine failed');
  }
  
  onFailure(result) {
    // 子类重写，决定失败后的状态转换
    return null;
  }
}
```

### 使用示例

```javascript
async function task_collect_blocks(bot, { blockType, count }, options = {}) {
  const context = {
    blockType,
    targetCount: count,
    collected: 0,
    blacklist: new Set()
  };
  
  const sm = new TaskStateMachine('PLAN', {
    PLAN: async (bot, ctx, sm) => {
      const targets = await planCollect(bot, ctx);
      if (targets.length === 0) {
        return fail('NO_TARGETS', 'Cannot find blocks');
      }
      ctx.targets = targets;
      return ok({ nextState: 'NAVIGATE' });
    },
    
    NAVIGATE: async (bot, ctx, sm) => {
      const target = ctx.targets[ctx.currentIndex];
      const result = await nav.goTo(bot, { position: target });
      if (!result.success) {
        ctx.blacklist.add(target);
        return fail(result.code, result.message);
      }
      return ok({ nextState: 'COLLECT' });
    },
    
    COLLECT: async (bot, ctx, sm) => {
      const target = ctx.targets[ctx.currentIndex];
      const result = await action_mine_block(bot, { 
        position: target, 
        blockType: ctx.blockType 
      });
      if (result.success) {
        ctx.collected++;
      }
      return ok({ nextState: 'CHECK' });
    },
    
    CHECK: async (bot, ctx, sm) => {
      if (ctx.collected >= ctx.targetCount) {
        return ok({ nextState: 'DONE' });
      }
      ctx.currentIndex++;
      if (ctx.currentIndex >= ctx.targets.length) {
        return ok({ nextState: 'PLAN' }); // 重新规划
      }
      return ok({ nextState: 'NAVIGATE' });
    }
  });
  
  sm.onFailure = (result) => {
    // NO_PATH 或 STUCK 时跳过当前目标
    if (['NO_PATH', 'STUCK', 'NO_REACH'].includes(result.code)) {
      context.currentIndex++;
      return context.currentIndex < context.targets.length 
        ? 'NAVIGATE' 
        : 'PLAN';
    }
    return null; // 其他错误直接失败
  };
  
  return await sm.run(bot, context);
}
```

## 任务依赖管理

```javascript
class TaskDependency {
  constructor() {
    this.tasks = new Map(); // taskId -> TaskNode
  }
  
  addTask(taskId, task, dependencies = []) {
    this.tasks.set(taskId, {
      id: taskId,
      task,
      dependencies,
      status: 'pending',
      result: null
    });
  }
  
  async executeTasks(bot) {
    const order = this.topologicalSort();
    
    for (const taskId of order) {
      const node = this.tasks.get(taskId);
      
      // 检查依赖是否都成功
      for (const depId of node.dependencies) {
        const dep = this.tasks.get(depId);
        if (dep.status !== 'success') {
          node.status = 'skipped';
          continue;
        }
      }
      
      // 执行任务
      node.status = 'running';
      node.result = await node.task(bot);
      node.status = node.result.success ? 'success' : 'failed';
    }
    
    return ok({
      results: Array.from(this.tasks.values())
    });
  }
  
  topologicalSort() {
    // Kahn's algorithm
    const inDegree = new Map();
    const queue = [];
    const result = [];
    
    for (const [id, node] of this.tasks) {
      inDegree.set(id, node.dependencies.length);
      if (node.dependencies.length === 0) {
        queue.push(id);
      }
    }
    
    while (queue.length > 0) {
      const id = queue.shift();
      result.push(id);
      
      for (const [otherId, other] of this.tasks) {
        if (other.dependencies.includes(id)) {
          inDegree.set(otherId, inDegree.get(otherId) - 1);
          if (inDegree.get(otherId) === 0) {
            queue.push(otherId);
          }
        }
      }
    }
    
    return result;
  }
}
```

### 使用示例

```javascript
const deps = new TaskDependency();

deps.addTask('gather_wood', async (bot) => 
  await task_collect_blocks(bot, { blockType: 'oak_log', count: 10 })
);

deps.addTask('craft_planks', async (bot) => 
  await task_craft_item(bot, { item: 'oak_planks', count: 40 }),
  ['gather_wood']
);

deps.addTask('craft_sticks', async (bot) => 
  await task_craft_item(bot, { item: 'stick', count: 10 }),
  ['craft_planks']
);

deps.addTask('craft_tools', async (bot) => 
  await task_craft_tools(bot, { material: 'wood', tools: ['pickaxe', 'axe'] }),
  ['craft_planks', 'craft_sticks']
);

await deps.executeTasks(bot);
```

## Mode 协调

所有导航任务必须暂停 goal modes：

```javascript
async function task_with_navigation(bot, params, options = {}) {
  pauseGoalModes(bot);
  try {
    return await doTask(bot, params, options);
  } finally {
    restoreGoalModes(bot);
  }
}
```

**当前问题（D6）**: task_collect 中断返回时不恢复 mode

**解决方案**: 确保 finally 块包含所有可能的返回路径

## 中断处理

```javascript
async function task_interruptible(bot, params, options = {}) {
  bot.interrupt_code = null; // 由 action_manager 设置
  
  while (!done) {
    // 检查中断
    if (bot.interrupt_code) {
      return fail('INTERRUPTED', `Interrupted: ${bot.interrupt_code}`);
    }
    
    await doWork();
  }
  
  return ok();
}
```

## 测试策略

```javascript
describe('task_collect_blocks', () => {
  it('should collect blocks and handle blacklist', async () => {
    const result = await task_collect_blocks(mockBot, {
      blockType: 'stone',
      count: 10
    });
    
    expect(result.success).toBe(true);
    expect(result.data.collected).toBe(10);
  });
  
  it('should retry with new plan after failures', async () => {
    let planCalls = 0;
    mockPlanCollect.mockImplementation(() => {
      planCalls++;
      return generateTargets(5);
    });
    
    const result = await task_collect_blocks(mockBot, {
      blockType: 'stone',
      count: 20
    });
    
    expect(planCalls).toBeGreaterThan(1);
  });
  
  it('should respect deadline', async () => {
    const result = await task_collect_blocks(mockBot, {
      blockType: 'stone',
      count: 100
    }, {
      deadline: Date.now() + 1000
    });
    
    expect(result.code).toBe('TIMEOUT');
  });
});
```

## 迁移检查表

- [ ] 识别所有状态和转换
- [ ] 实现状态机或依赖图
- [ ] 添加失败恢复逻辑
- [ ] 处理中断
- [ ] 管理 mode 暂停/恢复
- [ ] 进度报告
- [ ] 超时控制
- [ ] 测试所有路径
- [ ] 注册到 registry
- [ ] 更新文档

## 相关文档

- [00_overview.md](./00_overview.md) - 整体架构
- `02_actions.md` - 动作层（**已归档到 `../legacy/02_actions.md`**；六层架构中该层并入本层）
- `04_skills.md` - 技能层（**尚未创建**，见 [00_overview.md](./00_overview.md) 的文档清单）
- [05_navigation.md](./05_navigation.md) - 导航系统
