# 原子层 (Layer 4: Primitives)

> **本文是"组件清单"，不是契约**。契约（返回结构、31 条错误码、data 白名单、参数命名、中断要求）
> 一律以 [`ARCHITECTURE_REDESIGN.md §6`](./ARCHITECTURE_REDESIGN.md) 为准；冲突时以 §6 为准。
>
> **现状 vs 本文**：仓库里实际有 **22 个** `atom_*.js`（本文列 35 个是规划清单）。
> 下文第 13–33 行的示例签名（`atom_xxx(bot, params, options)`、`fail('ERROR_CODE', ...)`）
> 是**示意**：真实签名是 `digBlock(bot, target, opts)`，且 `fail()` 只接受 31 条白名单码，
> 写 `ERROR_CODE` 会直接抛异常。

## 设计原则

原子是系统的最底层构建块，直接封装 Mineflayer API 调用。每个原子应该：

1. **单一职责**: 只做一件事
2. **无副作用**: 不修改全局状态（除了 bot 本身的动作）
3. **可组合**: 能被安全地串联调用
4. **同步返回**: 返回统一的 `ActionResult`
5. **最小参数**: 只接收完成任务必需的参数

## 统一接口规范

```javascript
/**
 * 原子操作标准签名
 * @param {Bot} bot - Mineflayer bot 实例
 * @param {Object} params - 操作参数
 * @param {Object} options - 可选配置 (timeout, maxRetries 等)
 * @returns {Promise<ActionResult>}
 */
async function atom_xxx(bot, params, options = {}) {
  try {
    // 1. 参数验证
    // 2. 执行操作
    // 3. 返回结果
    return ok({ /* 数据 */ });
  } catch (err) {
    return fail('ERROR_CODE', err.message, { error: err });
  }
}
```

## 完整原子清单 (35 个)

### 1. 移动类 (5 个)

#### atom_move_to
移动到指定坐标（使用 pathfinder）

```javascript
async function atom_move_to(bot, { x, y, z }, options = {}) {
  const { timeout = 60000, distance = 2 } = options;
  // 使用 bot.pathfinder.goto(Goal)
}
```

**参数**:
- `x, y, z`: 目标坐标
- `options.timeout`: 超时时间 (ms)
- `options.distance`: 接受的到达距离

**返回码**:
- `OK`: 到达目标
- `TIMEOUT`: 超时
- `NO_PATH`: 找不到路径
- `STUCK`: 被卡住

#### atom_look_at
看向指定位置或实体

```javascript
async function atom_look_at(bot, { position, entity, yaw, pitch })
```

**参数**:
- `position`: Vec3 坐标
- `entity`: 实体对象
- `yaw, pitch`: 直接指定角度

#### atom_approach
接近指定位置（可配置距离）

```javascript
async function atom_approach(bot, { target }, options = {}) {
  const { distance = 2, timeout = 30000 } = options;
}
```

#### atom_retreat
远离指定位置

```javascript
async function atom_retreat(bot, { from, distance = 10 }, options = {})
```

#### atom_follow_path
沿给定路径移动（不规划，只执行）

```javascript
async function atom_follow_path(bot, { path }, options = {})
// path: [Vec3, Vec3, ...]
```

---

### 2. 方块操作类 (8 个)

#### atom_dig_block
挖掘指定方块

```javascript
async function atom_dig_block(bot, { position, block }, options = {}) {
  const { timeout = 60000, forceTool = false } = options;
}
```

**参数**:
- `position`: Vec3 坐标
- `block`: Block 对象（position 和 block 至少提供一个）
- `options.forceTool`: 是否强制使用最佳工具

**返回码**:
- `OK`: 挖掘成功
- `NO_BLOCK`: 方块不存在
- `OUT_OF_REACH`: 距离太远
- `TIMEOUT`: 超时
- `NO_TOOL`: 需要工具但没有

#### atom_place_block
放置方块到指定位置

```javascript
async function atom_place_block(bot, { position, item, against }, options = {})
```

**参数**:
- `position`: 目标位置
- `item`: 要放置的物品（名称或对象）
- `against`: 参考面（哪个方块的哪个面）

#### atom_break_block_at
指定坐标挖方块（兼容旧接口）

```javascript
async function atom_break_block_at(bot, { x, y, z }, options = {})
```

#### atom_find_blocks
查找附近的方块

```javascript
async function atom_find_blocks(bot, { matching, maxDistance = 64, count = 1 }, options = {})
```

**参数**:
- `matching`: 方块匹配条件（ID/名称/函数）
- `maxDistance`: 最大搜索距离
- `count`: 最多返回数量

**返回**:
- `data.blocks`: `[Vec3, ...]`

#### atom_find_nearest_block
查找最近的匹配方块

```javascript
async function atom_find_nearest_block(bot, { matching, maxDistance = 64 })
```

**返回**:
- `data.position`: Vec3
- `data.block`: Block 对象

#### atom_check_block
检查指定位置的方块

```javascript
async function atom_check_block(bot, { position })
```

**返回**:
- `data.block`: Block 对象或 null
- `data.name`: 方块名称

#### atom_can_place_at
检查是否可以在指定位置放置方块

```javascript
async function atom_can_place_at(bot, { position })
```

#### atom_get_block_drops
获取方块掉落物

```javascript
async function atom_get_block_drops(bot, { block })
```

---

### 3. 物品操作类 (8 个)

#### atom_equip_item
装备物品到指定槽位

```javascript
async function atom_equip_item(bot, { item, destination = 'hand' }, options = {})
```

**参数**:
- `item`: 物品名称、ID 或物品对象
- `destination`: 'hand' | 'head' | 'torso' | 'legs' | 'feet' | 'off-hand'

**返回码**:
- `OK`: 装备成功
- `NO_ITEM`: 物品不存在
- `ALREADY_EQUIPPED`: 已装备

#### atom_unequip
卸下装备

```javascript
async function atom_unequip(bot, { destination })
```

#### atom_use_item
使用当前手持物品

```javascript
async function atom_use_item(bot, options = {}) {
  const { offHand = false } = options;
}
```

**场景**: 吃食物、使用水桶、使用钓鱼竿等

#### atom_activate_block
激活方块（右键点击）

```javascript
async function atom_activate_block(bot, { position, block }, options = {})
```

**场景**: 开门、按按钮、打开箱子等

#### atom_toss_item
丢弃物品

```javascript
async function atom_toss_item(bot, { item, count = 1 }, options = {})
```

#### atom_transfer_item
在容器间转移物品

```javascript
async function atom_transfer_item(bot, { item, count, sourceWindow, destWindow }, options = {})
```

#### atom_count_items
统计物品数量

```javascript
async function atom_count_items(bot, { item })
```

**返回**:
- `data.count`: 总数量
- `data.slots`: [slot, ...]

#### atom_has_item
检查是否拥有物品

```javascript
async function atom_has_item(bot, { item, count = 1 })
```

---

### 4. 合成类 (3 个)

#### atom_craft_item
合成物品

```javascript
async function atom_craft_item(bot, { recipe, count = 1 }, options = {}) {
  const { requireCraftingTable = true } = options;
}
```

**参数**:
- `recipe`: 配方 ID 或物品名称
- `count`: 合成数量
- `options.requireCraftingTable`: 是否需要工作台

**返回码**:
- `OK`: 合成成功
- `NO_RECIPE`: 配方不存在
- `NO_MATERIALS`: 材料不足
- `NO_CRAFTING_TABLE`: 需要工作台但不在附近

#### atom_smelt_item
熔炼物品

```javascript
async function atom_smelt_item(bot, { item, fuel, count = 1 }, options = {})
```

#### atom_list_recipes
列出可用配方

```javascript
async function atom_list_recipes(bot, { forItem, withMaterials = false })
```

---

### 5. 实体交互类 (4 个)

#### atom_attack_entity
攻击实体

```javascript
async function atom_attack_entity(bot, { entity }, options = {}) {
  const { once = false, interval = 500 } = options;
}
```

**参数**:
- `entity`: 实体对象
- `options.once`: 是否只攻击一次
- `options.interval`: 连续攻击间隔

#### atom_mount_entity
骑乘实体

```javascript
async function atom_mount_entity(bot, { entity })
```

#### atom_dismount
下马/下船

```javascript
async function atom_dismount(bot)
```

#### atom_feed_entity
喂食实体

```javascript
async function atom_feed_entity(bot, { entity, item })
```

---

### 6. 容器操作类 (3 个)

#### atom_open_container
打开容器

```javascript
async function atom_open_container(bot, { position, block }, options = {})
```

**返回**:
- `data.window`: 容器窗口对象

#### atom_close_container
关闭当前容器

```javascript
async function atom_close_container(bot)
```

#### atom_interact_chest
与箱子交互（开箱→操作→关箱的便捷封装）

```javascript
async function atom_interact_chest(bot, { position }, callback)
```

---

### 7. 感知类 (4 个)

#### atom_find_entity
查找附近实体

```javascript
async function atom_find_entity(bot, { type, name, maxDistance = 64 }, options = {})
```

**参数**:
- `type`: 实体类型（如 'mob', 'player', 'object'）
- `name`: 实体名称
- `maxDistance`: 最大距离

**返回**:
- `data.entities`: [Entity, ...]

#### atom_scan_area
扫描区域（收集方块、实体信息）

```javascript
async function atom_scan_area(bot, { center, radius = 16 }, options = {})
```

**返回**:
- `data.blocks`: Map<blockName, [Vec3, ...]>
- `data.entities`: [Entity, ...]

#### atom_get_player_position
获取玩家位置

```javascript
async function atom_get_player_position(bot, { playerName })
```

#### atom_check_path_clear
检查路径是否畅通

```javascript
async function atom_check_path_clear(bot, { from, to })
```

---

## 原子组合示例

### 示例 1: 砍树原子序列

```javascript
// 1. 找到最近的木头
const findResult = await atom_find_nearest_block(bot, { 
  matching: (block) => block.name.includes('log')
});

// 2. 移动到木头旁边
await atom_approach(bot, { 
  target: findResult.data.position,
  distance: 3
});

// 3. 装备斧头
await atom_equip_item(bot, { item: 'wooden_axe' });

// 4. 挖掘木头
await atom_dig_block(bot, { 
  block: findResult.data.block 
});
```

### 示例 2: 开箱取物

```javascript
// 1. 打开箱子
const openResult = await atom_open_container(bot, { 
  position: chestPos 
});

// 2. 转移物品
await atom_transfer_item(bot, {
  item: 'diamond',
  count: 5,
  sourceWindow: openResult.data.window,
  destWindow: bot.inventory
});

// 3. 关闭箱子
await atom_close_container(bot);
```

## 实现注意事项

### 1. 错误处理

所有原子必须捕获异常并转换为标准错误码：

```javascript
try {
  await bot.pathfinder.goto(goal);
  return ok();
} catch (err) {
  // 根据错误类型返回不同错误码
  if (err.message.includes('timeout')) {
    return fail('TIMEOUT', 'Movement timeout', { error: err });
  }
  if (err.message.includes('no path')) {
    return fail('NO_PATH', 'Cannot find path', { error: err });
  }
  return fail('UNKNOWN_ERROR', err.message, { error: err });
}
```

### 2. 超时控制

使用 Promise.race 实现超时：

```javascript
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('timeout')), ms)
    )
  ]);
}
```

### 3. 状态检查

在操作前检查前置条件：

```javascript
// 挖掘前检查是否有方块
if (!block) {
  return fail('NO_BLOCK', 'Block does not exist');
}

// 移动前检查距离
const distance = bot.entity.position.distanceTo(target);
if (distance > 256) {
  return fail('TOO_FAR', `Target is ${distance} blocks away`);
}
```

### 4. 资源清理

确保操作完成后清理资源：

```javascript
try {
  const window = await bot.openContainer(chest);
  // ... 操作 ...
  return ok();
} finally {
  if (bot.currentWindow) {
    bot.closeWindow(bot.currentWindow);
  }
}
```

## 测试要求

每个原子必须有单元测试：

```javascript
describe('atom_dig_block', () => {
  it('should dig block successfully', async () => {
    const result = await atom_dig_block(mockBot, { 
      position: new Vec3(0, 0, 0) 
    });
    expect(result.success).toBe(true);
    expect(result.code).toBe('OK');
  });

  it('should return NO_BLOCK if block does not exist', async () => {
    const result = await atom_dig_block(mockBot, { 
      position: new Vec3(0, 0, 0) 
    });
    expect(result.code).toBe('NO_BLOCK');
  });

  it('should timeout after specified time', async () => {
    const result = await atom_dig_block(mockBot, 
      { position: new Vec3(0, 0, 0) },
      { timeout: 100 }
    );
    expect(result.code).toBe('TIMEOUT');
  });
});
```

## 原子注册

所有原子需要注册到统一注册表：

```javascript
// src/agent/primitives/index.js
import { registerPrimitive } from '../core/registry.js';

registerPrimitive('move_to', atom_move_to);
registerPrimitive('dig_block', atom_dig_block);
registerPrimitive('equip_item', atom_equip_item);
// ...
```

## 迁移检查表

从 `library/skills.js` 迁移时检查：

- [ ] 是否直接调用 bot.* API？（应该）
- [ ] 是否包含循环/重试逻辑？（应移到上层）
- [ ] 是否有多个职责？（应拆分为多个原子）
- [ ] 返回值是否符合 ActionResult？
- [ ] 是否有单元测试？
- [ ] 是否注册到 registry？
- [ ] 是否更新了文档？

## 常见错误码

原子层应该返回的标准错误码：

| 错误码 | 含义 | 使用场景 |
|--------|------|----------|
| OK | 成功 | 所有操作 |
| TIMEOUT | 超时 | 长时间操作 |
| NO_ITEM | 物品不存在 | 物品操作 |
| NO_BLOCK | 方块不存在 | 方块操作 |
| NO_PATH | 无路径 | 移动操作 |
| OUT_OF_REACH | 距离太远 | 交互操作 |
| STUCK | 被卡住 | 移动操作 |
| NO_SPACE | 空间不足 | 放置操作 |
| ALREADY_EXISTS | 已存在 | 放置操作 |
| NOT_EQUIPPED | 未装备 | 使用操作 |
| NO_TARGET | 无目标 | 攻击/交互 |

## 扩展指南

添加新原子时：

1. 确认是否真的需要新原子（是否可通过组合现有原子实现）
2. 在本文档中添加规格说明
3. 在 `src/agent/primitives/` 创建文件
4. 实现并注册
5. 编写测试
6. 更新本文档
