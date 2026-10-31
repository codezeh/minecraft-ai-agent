# 导航系统架构 (Navigation System)

> ## ⚠️ 本文拆分与仓库现状不一致
>
> 图上那两个模块**在代码里都不存在**：
>
> | 文中模块 | 现状 |
> |---|---|
> | `nav.js`（统一入口） | ❌ **不存在** —— 这正是 `ARCHITECTURE_REDESIGN.md §4.1` 要补的 `nav_core`（P0 新增） |
> | `pathfinder.js`（短距离封装） | ❌ **不存在** —— 短途能力实际在 `path_short.js`（`moveToXZEx` 等） |
> | `executor.js` | ✅ 存在 |
> | `path_3d.js` / `terrain3d.js` | ✅ 存在（另有 `terrain_view.js`、`path_short.js` 未在本文提及） |
>
> 所以本文应当成**目标设计**读：它描述的"统一入口"是要新建的，不是现状。
> 阅读时把 `nav.js` 一律替换成"计划中的 `nav_core`"，把 `pathfinder.js` 替换成 `path_short.js`。
>
> 另外 §分层原则里"所有移动走 nav.goTo"目前**尚无强制入口**——今天直接调 `moveTo`/`executor` 的地方仍在。

## 概述

导航系统是 Mindcraft 的核心基础设施，负责所有 3D 空间移动、路径规划和障碍处理。基于调研报告发现的问题，本文档定义清晰的导航架构。

## 系统组件

```
┌─────────────────────────────────────────────────────────┐
│  nav.js (统一入口)                                        │
│  - goTo(bot, dest, options)                             │
│  - 短距离/动态目标自动选择 pathfinder                      │
│  - 长距离/静态目标使用 3D 路径规划                         │
└─────────────────────────────────────────────────────────┘
                         ↓
         ┌───────────────┴───────────────┐
         ↓                               ↓
┌────────────────────┐         ┌────────────────────┐
│  pathfinder.js     │         │  executor.js       │
│  (原生 pathfinder)  │         │  (3D 路径执行器)    │
│  - 短距离 (<40格)   │         │  - 长距离 (>40格)   │
│  - 动态目标         │         │  - 静态坐标         │
│  - GoalFollow 等    │         │  - 障碍处理         │
└────────────────────┘         └────────────────────┘
                                        ↓
                               ┌────────────────────┐
                               │  path_3d.js        │
                               │  (体素 A* 规划)     │
                               └────────────────────┘
                                        ↓
                               ┌────────────────────┐
                               │  terrain3d.js      │
                               │  (SQLite 地形库)    │
                               └────────────────────┘
```

## 模块详细设计

### 1. nav.js - 统一导航入口

**职责**: 根据目标类型和距离自动选择最佳导航方式

```javascript
/**
 * 统一导航入口
 * @param {Bot} bot
 * @param {Object} dest - 目标描述
 * @param {Vec3} dest.position - 目标坐标
 * @param {Entity} dest.entity - 跟随的实体
 * @param {Player} dest.player - 跟随的玩家
 * @param {Object} options
 * @param {number} options.distance - 接受的到达距离 (默认 2)
 * @param {number} options.timeout - 超时时间 (默认 60000)
 * @param {string} options.mapDir - 地形数据库路径
 * @param {Function} options.onEvent - 事件回调
 * @returns {Promise<ActionResult>}
 */
async function goTo(bot, dest, options = {}) {
  const { distance = 2, timeout = 60000, mapDir } = options;

  // 1. 解析目标
  const target = resolveTarget(dest);
  
  // 2. 计算距离
  const dist = bot.entity.position.distanceTo(target.position);
  
  // 3. 选择导航方式
  if (target.isDynamic || dist < 40) {
    // 短距离或动态目标：使用 pathfinder
    return navigateWithPathfinder(bot, target, options);
  } else {
    // 长距离静态目标：使用 3D 路径规划
    return navigateWith3D(bot, target, options);
  }
}

/**
 * 解析目标描述
 */
function resolveTarget(dest) {
  if (dest.entity) {
    return {
      type: 'entity',
      entity: dest.entity,
      position: dest.entity.position,
      isDynamic: true
    };
  }
  
  if (dest.player) {
    // 使用 RCON 查询玩家位置（远距离）
    const entity = bot.players[dest.player]?.entity;
    return {
      type: 'player',
      player: dest.player,
      entity: entity,
      position: entity?.position || null,
      isDynamic: true
    };
  }
  
  if (dest.position) {
    return {
      type: 'position',
      position: dest.position,
      isDynamic: false
    };
  }
  
  throw new Error('Invalid destination');
}
```

**迁移映射**:
- `task_hop.hopTo` → `nav.goTo`
- `executor.walkTo` → `nav.goTo` (长距离)
- `atom_move_to` → `nav.goTo` (短距离)
- `skills.goToPosition` → `nav.goTo`

### 2. executor.js - 3D 路径执行器

**职责**: 执行 path_3d 规划的路径，处理各种障碍和特殊情况

#### 当前问题（调研发现）

**D1: y 坐标语义不一致**
- terrain3d 存的是实心方块本身的 y（脚下那块）
- executor 用脚所在格计算 `dy = step.y - floor(p.y)`，恒偏 -1
- 结果：
  - 下坡时提前触发 `needDigDown`，竖直往下挖当前列
  - 上 2 格时 `dy >= 2` 不成立，只上 1 格

**解决方案**: 统一语义为"脚所在格的 y"
```javascript
// terrain3d.js: 存储时转换
function saveSurface(x, y, z, type) {
  // y 存储为脚格（实心方块 + 1）
  db.run('INSERT ... VALUES (?, ?, ?, ?)', [x, y + 1, z, type]);
}

// executor.js: 直接使用
const dy = step.y - Math.floor(bot.entity.position.y); // 现在对齐了
```

**D2: dig 步骤忽略 x/z**
- path_3d 生成挖邻列的 dig 边（:427-452）
- executor dig 分支只挖当前列向上（:177-205）

**解决方案**: dig 步骤携带完整坐标
```javascript
// executor.js
case 'dig': {
  const targetPos = new Vec3(step.x, step.y, step.z); // 使用步骤坐标
  const block = bot.blockAt(targetPos);
  if (!block || block.name === 'air') {
    return ok({ dug: 0 }); // 已空
  }
  await digBlock(bot, { block });
  break;
}
```

**D5: followEntity 高差判定问题**
- 到达判定用 3D 距离
- walkTo 只看水平距离
- 有高差时空转到超时

**解决方案**: 到达判定改为水平+垂直分开
```javascript
const dx = bot.entity.position.x - entity.position.x;
const dz = bot.entity.position.z - entity.position.z;
const dy = Math.abs(bot.entity.position.y - entity.position.y);
const distH = Math.sqrt(dx * dx + dz * dz);

if (distH <= distance + 0.5 && dy <= 2) {
  return ok({ distFeet: distH, distVert: dy });
}
```

**D9: 超时控制不严格**
- 下沉循环最长 30s 不查中断
- deadline 只在每轮开头查
- 单步 moveToXZ 最长 30s

**解决方案**: 每个阻塞操作都传入剩余时间
```javascript
async function walkTo(bot, dest, options = {}) {
  const startTime = Date.now();
  const { deadlineMs = 300000 } = options;
  
  while (rounds < MAX_ROUNDS) {
    const elapsed = Date.now() - startTime;
    const remaining = deadlineMs - elapsed;
    
    if (remaining <= 0) {
      return fail('TIMEOUT', 'Deadline exceeded');
    }
    
    // 每步传入剩余时间
    await moveToXZ(bot, step, { timeout: Math.min(remaining, 30000) });
  }
}
```

#### 重构计划

将 executor.js 拆分为：

```
navigation/
├── executor.js          # 主循环：扫描→规划→执行
├── steps/
│   ├── walk.js         # 平地行走
│   ├── climb.js        # 爬梯子/藤蔓
│   ├── dig.js          # 挖掘障碍
│   ├── swim.js         # 游泳/潜水
│   ├── pillar.js       # 垫高跳（合并 stepUp + escapeUp）
│   └── drop.js         # 下落
└── terrain_scanner.js  # 扫描周围地形
```

**executor.js 简化为**:
```javascript
async function walkTo(bot, dest, options = {}) {
  // 1. 暂停 goal modes
  pauseGoalModes(bot);
  
  try {
    let round = 0;
    while (round < MAX_ROUNDS) {
      // 2. 扫描地形
      await scanSphere(bot, mapDir);
      
      // 3. 规划路径
      const plan = await plan3D(mapDir, from, to, planOptions);
      
      // 4. 执行路径
      for (const step of plan.path) {
        const result = await executeStep(bot, step, options);
        if (!result.success) {
          break; // 重新规划
        }
      }
      
      // 5. 检查到达
      if (arrived()) {
        return ok();
      }
      
      round++;
    }
    
    return fail('NO_REACH', 'Max rounds exceeded');
  } finally {
    restoreGoalModes(bot);
  }
}

async function executeStep(bot, step, options) {
  switch (step.type) {
    case 'walk': return await steps.walk(bot, step, options);
    case 'climb': return await steps.climb(bot, step, options);
    case 'dig': return await steps.dig(bot, step, options);
    case 'swim': return await steps.swim(bot, step, options);
    case 'up': return await steps.pillar(bot, step, options);
    default:
      return fail('UNKNOWN_STEP', `Unknown step type: ${step.type}`);
  }
}
```

### 3. path_3d.js - 体素 A* 规划

**职责**: 在 3D 地形数据上规划路径

**当前问题**: 
- 返回 `BUDGET` 不在 CODES 中
- 不可达时返回最近点，但没有文档说明

**改进**:
```javascript
const CODES = {
  OK: 'OK',
  NO_DATA: 'NO_DATA',     // 缺少地形数据
  NO_START: 'NO_START',   // 起点不可行走
  NO_PATH: 'NO_PATH',     // 完全不可达
  BUDGET: 'BUDGET'        // 超出节点预算（应视为 NO_PATH 的子类）
};

async function plan3D(dir, from, to, options = {}) {
  const { maxNodes = 80000, maxDrop = 4, maxClimb = 3 } = options;
  
  // ... A* 算法 ...
  
  if (nodes > maxNodes) {
    // 如果访问过目标附近，返回最近点
    if (closestNode && closestNode.dist < 20) {
      return ok({
        path: reconstructPath(closestNode),
        partial: true,
        remaining: closestNode.dist
      });
    }
    return fail('BUDGET', 'Node budget exceeded');
  }
  
  if (!foundPath) {
    return fail('NO_PATH', 'No path found');
  }
  
  return ok({ path: reconstructPath(goalNode) });
}
```

### 4. terrain3d.js - 地形数据库

**职责**: SQLite 存储可行走表面，支持快速查询

**当前问题（D11）**:
- 每函数开关一次库，语句缓存永不命中
- fail 表从不清理
- readFails 每次全表扫

**改进**:
```javascript
class TerrainDB {
  constructor(dbPath) {
    this.db = null;
    this.stmts = {}; // 预编译语句
  }
  
  open() {
    if (!this.db) {
      this.db = new Database(dbPath);
      this.prepareStatements();
    }
  }
  
  prepareStatements() {
    this.stmts.saveSurf = this.db.prepare(
      'INSERT OR REPLACE INTO surfaces ...'
    );
    this.stmts.boxSurfaces = this.db.prepare(
      'SELECT * FROM surfaces WHERE x BETWEEN ? AND ? ...'
    );
    this.stmts.readFails = this.db.prepare(
      'SELECT * FROM fails WHERE x BETWEEN ? AND ? AND timestamp > ?'
    );
    this.stmts.clearOldFails = this.db.prepare(
      'DELETE FROM fails WHERE timestamp < ?'
    );
  }
  
  // 保持连接打开，只在 close() 时关闭
  saveSurfaces(surfaces) {
    this.open();
    const tx = this.db.transaction(() => {
      for (const s of surfaces) {
        this.stmts.saveSurf.run(s.x, s.y + 1, s.z, s.type); // 统一 y 语义
      }
    });
    tx();
  }
  
  readFails(box, ttl = 600000) {
    this.open();
    const cutoff = Date.now() - ttl;
    // 清理过期记录
    this.stmts.clearOldFails.run(cutoff);
    // 按区域查询
    return this.stmts.readFails.all(
      box.minX, box.maxX, box.minY, box.maxY, box.minZ, box.maxZ, cutoff
    );
  }
  
  close() {
    if (this.db) {
      for (const stmt of Object.values(this.stmts)) {
        stmt.finalize();
      }
      this.db.close();
      this.db = null;
      this.stmts = {};
    }
  }
}

// 全局单例
let terrainDB = null;

export function getTerrainDB(dbPath) {
  if (!terrainDB) {
    terrainDB = new TerrainDB(dbPath);
  }
  return terrainDB;
}
```

### 5. pathfinder.js - 原生导航封装

**职责**: 封装 mineflayer-pathfinder，用于短距离和动态目标

```javascript
async function navigateWithPathfinder(bot, target, options = {}) {
  const { distance = 2, timeout = 60000 } = options;
  
  let goal;
  if (target.entity) {
    goal = new GoalFollow(target.entity, distance);
  } else {
    goal = new GoalNear(target.position.x, target.position.y, target.position.z, distance);
  }
  
  // 设置移动参数
  bot.pathfinder.setMovements(new Movements(bot));
  
  // 启动导航
  bot.pathfinder.setGoal(goal);
  
  // 等待到达或超时
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      bot.pathfinder.setGoal(null);
      resolve(fail('TIMEOUT', 'Navigation timeout'));
    }, timeout);
    
    bot.once('goal_reached', () => {
      clearTimeout(timer);
      resolve(ok());
    });
    
    bot.pathfinder.on('path_stop', (reason) => {
      clearTimeout(timer);
      if (reason === 'goal_reached') {
        resolve(ok());
      } else {
        resolve(fail('NO_PATH', `Path stopped: ${reason}`));
      }
    });
  });
}
```

## Mode 协调机制

**问题（调研发现）**:
- 三套暂停列表：task_modes、executor、skills
- task_collect 中断时不恢复 mode
- skills.followPlayer 无条件恢复，清掉外层暂停

**解决方案**: 只使用 task_modes.js，所有导航都通过它

```javascript
// task_modes.js
const NAVIGATION_MODES = [
  'self_preservation',
  'unstuck',
  'cowardice',
  'self_defense',
  'hunting'
];

let pausedModes = new Map(); // bot -> Set<modeName>

export function pauseGoalModes(bot) {
  if (!pausedModes.has(bot)) {
    pausedModes.set(bot, new Set());
  }
  
  const paused = pausedModes.get(bot);
  for (const modeName of NAVIGATION_MODES) {
    if (bot.modes.isActive(modeName)) {
      bot.modes.pause(modeName);
      paused.add(modeName);
    }
  }
}

export function restoreGoalModes(bot) {
  const paused = pausedModes.get(bot);
  if (!paused) return;
  
  for (const modeName of paused) {
    bot.modes.resume(modeName);
  }
  paused.clear();
}

export function clearPausedModes(bot) {
  pausedModes.delete(bot);
}
```

**使用**:
```javascript
// nav.js
async function goTo(bot, dest, options = {}) {
  pauseGoalModes(bot);
  try {
    return await navigate(bot, dest, options);
  } finally {
    restoreGoalModes(bot);
  }
}
```

## 事件通知

导航过程中发送事件：

```javascript
const events = {
  NAV_START: { type: 'nav_start', position, distance },
  NAV_PROGRESS: { type: 'nav_progress', current, remaining },
  NAV_OBSTACLE: { type: 'nav_obstacle', obstacle, action },
  NAV_STUCK: { type: 'nav_stuck', position, attempts },
  NAV_SUCCESS: { type: 'nav_success', duration, distance },
  NAV_FAILED: { type: 'nav_failed', code, message }
};

// 使用
if (options.onEvent) {
  options.onEvent(events.NAV_PROGRESS);
}
```

## 错误码规范

导航系统返回的标准错误码：

| 错误码 | 含义 | 来源 |
|--------|------|------|
| OK | 到达目标 | 所有模块 |
| TIMEOUT | 超时 | executor, pathfinder |
| NO_PATH | 找不到路径 | path_3d, pathfinder |
| NO_DATA | 缺少地形数据 | path_3d |
| NO_START | 起点不可行走 | path_3d |
| NO_REACH | 多次尝试未到达 | executor |
| STUCK | 被卡住不动 | executor |
| INTERRUPTED | 被中断 | executor |

## 性能优化

### 1. 地形数据缓存
```javascript
// 保持数据库连接，避免重复打开
const dbPool = new Map(); // mapDir -> TerrainDB

function getDB(mapDir) {
  if (!dbPool.has(mapDir)) {
    dbPool.set(mapDir, new TerrainDB(mapDir));
  }
  return dbPool.get(mapDir);
}
```

### 2. 路径缓存
```javascript
const pathCache = new LRUCache({
  max: 100,
  ttl: 60000 // 1 分钟过期
});

function getCachedPath(from, to, mapDir) {
  const key = `${mapDir}:${from.toString()}:${to.toString()}`;
  return pathCache.get(key);
}
```

### 3. 分块扫描
```javascript
// 只扫描必要的区块
async function scanNecessary(bot, dest, mapDir) {
  const from = bot.entity.position;
  const to = dest.position;
  
  // 计算需要扫描的区域
  const bbox = expandBox(boxBetween(from, to), 16);
  
  // 只扫描缺失数据的区块
  const missing = await findMissingChunks(bbox, mapDir);
  for (const chunk of missing) {
    await scanChunk(bot, chunk, mapDir);
  }
}
```

## 测试策略

### 单元测试
- 每个模块独立测试
- Mock bot 和地形数据
- 覆盖所有错误码路径

### 集成测试
```javascript
describe('Navigation Integration', () => {
  it('should navigate short distance with pathfinder', async () => {
    const result = await nav.goTo(bot, { 
      position: new Vec3(10, 64, 10) 
    });
    expect(result.code).toBe('OK');
  });

  it('should navigate long distance with 3D planner', async () => {
    const result = await nav.goTo(bot, { 
      position: new Vec3(1000, 64, 1000) 
    }, {
      mapDir: './test_terrain.db'
    });
    expect(result.code).toBe('OK');
  });

  it('should follow moving entity', async () => {
    const result = await nav.goTo(bot, { 
      entity: mockPlayer 
    }, {
      distance: 3
    });
    expect(result.code).toBe('OK');
  });
});
```

## 迁移检查表

- [ ] 统一 y 坐标语义（脚格）
- [ ] 修复 dig 步骤坐标
- [ ] 修复 followEntity 高差判定
- [ ] 严格超时控制
- [ ] 地形数据库连接池
- [ ] 统一 mode 暂停机制
- [ ] 删除重复代码（task_hop）
- [ ] 实现 nav.goTo 统一入口
- [ ] 更新所有调用方
- [ ] 编写测试
- [ ] 性能测试与优化

## 相关文档

- [00_overview.md](./00_overview.md) - 整体架构
- [01_primitives.md](./01_primitives.md) - 原子层（移动原子）
- [03_tasks.md](./03_tasks.md) - 任务层（导航任务）
