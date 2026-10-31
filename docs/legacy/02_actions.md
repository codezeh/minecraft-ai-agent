# 动作层 (Layer 3: Actions)

> ## 🗄️ 本文已归档（2026-10-31），属于旧文档
>
> **新规范在 [`../architecture/`](../architecture/)**。本层在六层架构中**已取消**：
> `ARCHITECTURE_REDESIGN.md §4.1` 的六层是 **Agent → Skills → Tasks → Navigation → Atoms → Bot**，
> **没有 Actions 层**：原来归 Actions 的"基础操作序列"拆到了 **Tasks**（单一目标流程）
> 与 **Atoms**（单次操作），导航独立提上一层。
>
> 那本文还有什么用？**当组件清单用**：这里是动作粒度的能力盘点（移动/采集/建造/合成/战斗/交互/存储/农业），
> 写 `task_*` 之前用来查"这件事以前是怎么切的"。
>
> **不要**按本文新增独立的 `action_*.js`：新增一律落到 `atom_*`（单次）或 `task_*`（流程）。

## 设计原则

动作层封装了**基础操作序列**，每个动作完成一个明确的子目标。与原子的区别：

- **原子**: 单一 API 调用，无重试，无状态
- **动作**: 多个原子组合，有重试逻辑，有错误处理

## 接口规范

```javascript
/**
 * 动作标准签名
 * @param {Bot} bot
 * @param {Object} params - 动作参数
 * @param {Object} options - 可选配置
 * @returns {Promise<ActionResult>}
 */
async function action_xxx(bot, params, options = {}) {
  const { maxRetries = 3, timeout = 60000 } = options;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // 1. 调用原子序列
    // 2. 检查结果
    // 3. 失败时重试或返回
  }
  
  return fail('MAX_RETRIES', 'Failed after retries');
}
```

## 完整动作清单 (40-50 个)

### 1. 基础移动 (5 个)

#### action_go_to_position
移动到坐标（带重试和stuck检测）

```javascript
async function action_go_to_position(bot, { x, y, z }, options = {})
```

**调用**: `atom_move_to` + stuck 检测 + 重试

#### action_follow_player
跟随玩家

```javascript
async function action_follow_player(bot, { playerName, distance = 3 }, options = {})
```

**调用**: `atom_find_entity` → `atom_move_to` 循环

#### action_follow_entity
跟随实体

```javascript
async function action_follow_entity(bot, { entity, distance = 3 }, options = {})
```

#### action_flee_from
逃离危险

```javascript
async function action_flee_from(bot, { position, distance = 20 }, options = {})
```

**调用**: `atom_retreat` + 检查安全

#### action_patrol
在多个点之间巡逻

```javascript
async function action_patrol(bot, { waypoints, loop = true }, options = {})
```

---

### 2. 采集类 (8 个)

#### action_mine_block
挖掘指定方块

```javascript
async function action_mine_block(bot, { blockType, count = 1 }, options = {})
```

**流程**:
1. `atom_find_blocks` 查找方块
2. `atom_approach` 接近
3. `atom_equip_item` 装备工具
4. `atom_dig_block` 挖掘
5. 重复直到达到数量

#### action_chop_tree
砍树

```javascript
async function action_chop_tree(bot, { position }, options = {})
```

**流程**:
1. 找到树干底部
2. 装备斧头
3. 从下往上砍
4. 收集掉落物

#### action_collect_items
收集地上的物品

```javascript
async function action_collect_items(bot, { itemType, maxDistance = 32 }, options = {})
```

#### action_harvest_crop
收获农作物

```javascript
async function action_harvest_crop(bot, { cropType, area }, options = {})
```

#### action_shear_sheep
剪羊毛

```javascript
async function action_shear_sheep(bot, { sheep }, options = {})
```

#### action_milk_cow
挤牛奶

```javascript
async function action_milk_cow(bot, { cow }, options = {})
```

#### action_fish
钓鱼

```javascript
async function action_fish(bot, { duration = 60000 }, options = {})
```

#### action_hunt_animal
狩猎动物

```javascript
async function action_hunt_animal(bot, { animalType, count = 1 }, options = {})
```

---

### 3. 建造类 (6 个)

#### action_place_structure
放置结构

```javascript
async function action_place_structure(bot, { structure, position }, options = {})
```

**流程**:
1. 检查材料
2. 逐方块放置
3. 处理放置失败

#### action_build_wall
建墙

```javascript
async function action_build_wall(bot, { from, to, height, material }, options = {})
```

#### action_build_floor
铺地板

```javascript
async function action_build_floor(bot, { area, material }, options = {})
```

#### action_build_bridge
搭桥

```javascript
async function action_build_bridge(bot, { from, to, material }, options = {})
```

#### action_fill_area
填充区域

```javascript
async function action_fill_area(bot, { area, material }, options = {})
```

#### action_clear_area
清理区域

```javascript
async function action_clear_area(bot, { area }, options = {})
```

---

### 4. 合成类 (5 个)

#### action_craft_items
合成物品

```javascript
async function action_craft_items(bot, { recipe, count }, options = {})
```

**流程**:
1. 检查配方
2. 收集材料
3. 找工作台（如需要）
4. 执行合成

#### action_smelt_items
熔炼物品

```javascript
async function action_smelt_items(bot, { item, count, fuel }, options = {})
```

#### action_brew_potion
酿造药水

```javascript
async function action_brew_potion(bot, { potion }, options = {})
```

#### action_enchant_item
附魔物品

```javascript
async function action_enchant_item(bot, { item, enchantments }, options = {})
```

#### action_repair_item
修复物品

```javascript
async function action_repair_item(bot, { item }, options = {})
```

---

### 5. 战斗类 (4 个)

#### action_attack_mob
攻击生物

```javascript
async function action_attack_mob(bot, { mobType }, options = {})
```

**流程**:
1. 找到目标
2. 装备武器
3. 接近并攻击
4. 躲避攻击

#### action_defend_position
防守位置

```javascript
async function action_defend_position(bot, { position, radius = 10 }, options = {})
```

#### action_use_shield
使用盾牌防御

```javascript
async function action_use_shield(bot, { duration }, options = {})
```

#### action_shoot_arrow
射箭

```javascript
async function action_shoot_arrow(bot, { target }, options = {})
```

---

### 6. 交互类 (6 个)

#### action_open_door
开门

```javascript
async function action_open_door(bot, { position }, options = {})
```

#### action_press_button
按按钮

```javascript
async function action_press_button(bot, { position }, options = {})
```

#### action_pull_lever
拉拉杆

```javascript
async function action_pull_lever(bot, { position }, options = {})
```

#### action_use_bed
睡觉

```javascript
async function action_use_bed(bot, { position }, options = {})
```

#### action_ride_vehicle
骑乘载具

```javascript
async function action_ride_vehicle(bot, { vehicle }, options = {})
```

#### action_trade_villager
与村民交易

```javascript
async function action_trade_villager(bot, { villager, trades }, options = {})
```

---

### 7. 存储类 (5 个)

#### action_store_items
存储物品到容器

```javascript
async function action_store_items(bot, { chest, items }, options = {})
```

**流程**:
1. `atom_open_container` 打开箱子
2. `atom_transfer_item` 转移物品
3. `atom_close_container` 关闭

#### action_retrieve_items
从容器取物品

```javascript
async function action_retrieve_items(bot, { chest, items }, options = {})
```

#### action_sort_chest
整理箱子

```javascript
async function action_sort_chest(bot, { chest }, options = {})
```

#### action_dump_inventory
清空背包到箱子

```javascript
async function action_dump_inventory(bot, { chest, keep = [] }, options = {})
```

#### action_organize_storage
整理存储系统

```javascript
async function action_organize_storage(bot, { chests, categories }, options = {})
```

---

### 8. 农业类 (6 个)

#### action_plant_crops
种植作物

```javascript
async function action_plant_crops(bot, { crop, area }, options = {})
```

#### action_till_soil
耕地

```javascript
async function action_till_soil(bot, { area }, options = {})
```

#### action_water_crops
浇水

```javascript
async function action_water_crops(bot, { area }, options = {})
```

#### action_bone_meal
使用骨粉

```javascript
async function action_bone_meal(bot, { position }, options = {})
```

#### action_breed_animals
繁殖动物

```javascript
async function action_breed_animals(bot, { animalType, count }, options = {})
```

#### action_feed_animals
喂养动物

```javascript
async function action_feed_animals(bot, { animals, food }, options = {})
```

## 动作组合示例

### 示例：自动挖矿动作

```javascript
async function action_auto_mine(bot, { oreType, count }, options = {}) {
  const collected = [];
  
  while (collected.length < count) {
    // 1. 查找矿石
    const findResult = await atom_find_nearest_block(bot, {
      matching: (b) => b.name === oreType,
      maxDistance: 64
    });
    
    if (!findResult.success) {
      return fail('NO_ORE', `Cannot find ${oreType}`);
    }
    
    // 2. 移动到矿石
    const moveResult = await atom_approach(bot, {
      target: findResult.data.position,
      distance: 3
    });
    
    if (!moveResult.success) {
      continue; // 找下一个
    }
    
    // 3. 装备镐子
    await atom_equip_item(bot, {
      item: 'iron_pickaxe'
    });
    
    // 4. 挖掘
    const digResult = await atom_dig_block(bot, {
      block: findResult.data.block
    });
    
    if (digResult.success) {
      collected.push(findResult.data.position);
    }
    
    // 5. 检查工具耐久
    const tool = bot.heldItem;
    if (tool && tool.durability < 10) {
      return fail('TOOL_BROKEN', 'Tool almost broken', { collected });
    }
  }
  
  return ok({ collected: collected.length });
}
```

## 错误处理策略

### 1. 重试机制

```javascript
async function action_with_retry(bot, params, options = {}) {
  const { maxRetries = 3, retryDelay = 1000 } = options;
  
  for (let i = 0; i < maxRetries; i++) {
    const result = await doAction(bot, params);
    
    if (result.success) {
      return result;
    }
    
    // 可重试的错误
    if (['TIMEOUT', 'STUCK', 'BLOCKED'].includes(result.code)) {
      await sleep(retryDelay);
      continue;
    }
    
    // 不可重试的错误
    return result;
  }
  
  return fail('MAX_RETRIES', `Failed after ${maxRetries} attempts`);
}
```

### 2. 部分成功处理

```javascript
async function action_collect_multiple(bot, { items }, options = {}) {
  const results = {
    success: [],
    failed: []
  };
  
  for (const item of items) {
    const result = await action_collect(bot, { item });
    if (result.success) {
      results.success.push(item);
    } else {
      results.failed.push({ item, reason: result.code });
    }
  }
  
  if (results.success.length === 0) {
    return fail('ALL_FAILED', 'All collection attempts failed', results);
  }
  
  if (results.failed.length > 0) {
    return ok({
      ...results,
      partial: true
    });
  }
  
  return ok(results);
}
```

## 测试要求

```javascript
describe('action_mine_block', () => {
  it('should mine and collect block', async () => {
    const result = await action_mine_block(mockBot, {
      blockType: 'stone',
      count: 5
    });
    
    expect(result.success).toBe(true);
    expect(result.data.collected).toBe(5);
  });
  
  it('should handle no tool', async () => {
    mockBot.inventory = [];
    const result = await action_mine_block(mockBot, {
      blockType: 'diamond_ore',
      count: 1
    });
    
    expect(result.code).toBe('NO_TOOL');
  });
  
  it('should retry on stuck', async () => {
    let attempts = 0;
    mockBot.pathfinder.goto = async () => {
      attempts++;
      if (attempts < 3) throw new Error('stuck');
      return true;
    };
    
    const result = await action_mine_block(mockBot, {
      blockType: 'stone',
      count: 1
    }, {
      maxRetries: 3
    });
    
    expect(attempts).toBe(3);
    expect(result.success).toBe(true);
  });
});
```

## 迁移检查表

从 skills.js 迁移动作时：

- [ ] 拆分为原子调用序列
- [ ] 添加重试逻辑
- [ ] 处理所有错误情况
- [ ] 返回 ActionResult
- [ ] 编写测试
- [ ] 注册到 registry
- [ ] 更新文档

## 常见错误码

| 错误码 | 含义 | 处理建议 |
|--------|------|----------|
| OK | 成功 | - |
| PARTIAL | 部分成功 | 检查 data 中的详情 |
| NO_ITEM | 物品不足 | 先收集材料 |
| NO_TOOL | 工具不足 | 制作或获取工具 |
| TOOL_BROKEN | 工具损坏 | 修复或更换 |
| NO_SPACE | 空间不足 | 清理背包 |
| BLOCKED | 被阻挡 | 清除障碍 |
| STUCK | 卡住 | 尝试逃脱 |
| MAX_RETRIES | 重试次数用尽 | 放弃或换目标 |

## 相关文档

- [00_overview.md](../architecture/00_overview.md) - 整体架构
- [01_primitives.md](../architecture/01_primitives.md) - 原子层
- [03_tasks.md](../architecture/03_tasks.md) - 任务层
