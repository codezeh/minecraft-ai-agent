# Mindcraft 重构架构分析

基于四个子agent的深入调研报告，本文档评估现有组件、识别缺失层次、提出目标架构。

---

## 1. 现有组件盘点

### 1.1 原子层（22个）
**移动与感知**
- ✅ atom_move.js - moveTo/moveToXZ/setControlState
- ✅ atom_stand.js - canStand/standHere
- ✅ atom_look.js - lookAt
- ✅ atom_perceive.js - perceive/scanBlocks
- ✅ atom_wait.js - sleep

**操作方块**
- ✅ atom_dig.js - digBlock
- ✅ atom_place.js - placeBlockAt
- ✅ atom_tunnel.js - tunnelStep/tunnelAlong（**违规：含复合逻辑**）

**物品与容器**
- ✅ atom_items.js - equipItem/hasItem/countItem
- ✅ atom_drops.js - collectDrops（**违规：多轮循环+moveTo调用**）
- ✅ atom_find_drops.js - findNearbyDrops
- ✅ atom_container.js - openContainer/takeFromContainer
- ✅ atom_wait_item.js - waitForItem

**战斗与交互**
- ✅ atom_attack.js - attackNearest
- ✅ atom_use.js - activateItem/useOnBlock

**资源相关**
- ✅ atom_tree.js - chopTree
- ✅ atom_climb.js - climbUp/climbDown

**数据管理**
- ✅ atom_classify.js - classifyBlock（**违规：读写landmarks**）
- ✅ atom_query.js - 查询工具
- ✅ atom_safe.js - 安全判断
- ✅ atom_boat.js - 船操作

**契约机制**
- ✅ atom_contract.js - ok/fail/CODES

### 1.2 复合层（8个任务 + 3个技能）
**任务**
- ✅ task_hop.js - 薄包装walkTo（应并入导航）
- ✅ task_follow.js - follow/goToPlayer/followEntity（**混杂被困BFS、直接按键**）
- ✅ task_collect.js - 采集调度器
- ✅ task_platform.js - 3×3平台
- ✅ task_modes.js - mode暂停/恢复

**技能**
- ✅ skill_collect.js - 采集规划+处理器链
- ✅ skill_escape.js - 垂直自救（~~直接按键、自定义返回值~~ **已于 2026-11-01 整改**：改 ok/fail 信封、按键与垫脚交给 atom_pillar、挖不动判定交给 atom_dig.isDiggable）
- ✅ skill_clear.js - 清理障碍物步骤生成

**支持**
- ✅ step_runner.js - 步骤序列执行器
- ✅ collect_planner.js - 树干侦察
- ✅ collect_targets.js - 名称解析
- ✅ tool_prep.js - 备工具/垫脚块（**绕过原子：直接dig/craft/goto**）
- ✅ scaffold_cleanup.js - 垫脚块清理（**bug: 清所有空气→方块**）

### 1.3 导航层（4个）
- ✅ executor.js - 3D导航主循环（**直接按键、管mode、混杂策略**）
- ✅ path_3d.js - 体素A*
- ✅ terrain3d.js - SQLite地形面库（**每次开关库、不清fail表**）
- ⚠️ path_short.js - **死代码，无调用方**

### 1.4 数据与工具（不需重构）
- storage.js, schematic.js, landmarks.js, memory_store.js
- world_model.js, trace_bus.js
- terrain_view.js, map_query.js, mca_import.js

---

## 2. 缺失组件识别

### 2.1 核心原子缺失

#### A. 移动与导航基础
- ✅ **atom_pillar.js** - 跳垫垫高（2026-11-01 新增 `pillarUpOnce`；executor.stepUp 与 skill_escape 都改用它）
- ❌ **atom_pathfind.js** - 原生pathfinder封装（统一goto/setGoal/setMovements调用）
- ✅ **atom_stuck_detect.js** - 卡住判据（2026-11-01 提取 movedEnough/weightedMove/realMove；task_follow 的 BFS 仍未迁移，见 §5 Phase4）

#### B. 合成与工具准备
- ❌ **atom_craft.js** - 合成单个物品（替代tool_prep直接craft，含工作台放置）
- ❌ **atom_smelt.js** - 熔炉操作
- ❌ **atom_enchant.js** - 附魔台操作

#### C. 生存与战斗
- ❌ **atom_eat.js** - 进食恢复饥饿
- ❌ **atom_heal.js** - 使用治疗物品
- ❌ **atom_shield.js** - 盾牌格挡

#### D. 复杂交互
- ❌ **atom_trade.js** - 村民交易
- ❌ **atom_bed.js** - 睡觉设置重生点
- ❌ **atom_ride.js** - 骑乘实体（马、猪）

#### E. 红石与机械
- ❌ **atom_lever.js** - 拉杆/按钮
- ❌ **atom_door.js** - 开关门

### 2.2 复合层缺失

#### A. 核心任务
- ❌ **task_build.js** - 建造结构（从蓝图构建，需schematic集成）
- ❌ **task_mine.js** - 挖矿（条带挖矿、找矿脉）
- ❌ **task_farm.js** - 农业（种植、收割、骨粉）
- ❌ **task_fish.js** - 钓鱼
- ❌ **task_trade.js** - 批量交易流程
- ❌ **task_smelt.js** - 批量熔炼（含燃料管理）

#### B. 生存策略
- ❌ **task_shelter.js** - 建造庇护所
- ❌ **task_survive_night.js** - 夜间生存策略
- ❌ **task_equipment.js** - 装备升级流程（挖矿→合成→装备）

#### C. 战斗与探索
- ❌ **task_combat.js** - 战斗编排（风筝、躲避、治疗）
- ❌ **task_explore.js** - 区域探索（螺旋扫描、标记兴趣点）
- ❌ **task_raid.js** - 袭击末地城/林地府邸

### 2.3 技能层缺失

#### A. 资源获取技能
- ❌ **skill_wood.js** - 伐木（识别树种、砍完整棵树）
- ❌ **skill_stone.js** - 采石（大面积采石场）
- ❌ **skill_farm.js** - 农场管理（检测成熟、自动收割补种）

#### B. 制造技能
- ❌ **skill_craft_chain.js** - 复杂合成链（木头→木板→棍子→工具）
- ❌ **skill_smelt_chain.js** - 熔炼链（挖矿→熔炼→合成）

#### C. 导航技能
- ❌ **skill_path_smooth.js** - 路径平滑优化
- ❌ **skill_unstuck.js** - 脱困策略库（挖、跳、后退、绕路）

---

## 3. 已识别的架构问题

### 3.1 分层违规（已记录 12 条）
来自子agent报告的证据：

1. **原子含复合逻辑**
   - atom_drops.collectDrops: 多轮循环+调moveTo (:95-160)
   - atom_tunnel: 调digBlock/moveToXZ，tunnelAlong是循环 (:28-29, :306)
   - atom_dig: 直接按forward (:68-74)、装备工具 (:97)
   - atom_classify: 读写landmarks (:13)

2. **复合层绕过原子**
   - tool_prep: 直接dig/goto/craft/placeBlock/equip
   - task_follow: 直接setGoal/setMovements、110行被困BFS (:321-433)
   - executor/skill_escape: 直接按键

3. **导航层管策略**
   - executor自带mode暂停列表 (:530-541)，与task_modes重复

4. **任务改中断标志**
   - task_follow:84写 `bot.interrupt_code=false`

5. **不守契约**
   - execStep返回字面量绕过fail() (:128/170/191)
   - runEscape、ensureScaffold自定义形状
   - plan3D的BUDGET、planEscape的`code: undefined`不在CODES

### 3.2 功能重复（已记录 7 处）
1. "走到坐标"两套引擎：pathfinder vs walkTo
2. follow只在>40格时hop，goToPlayer已改RCON但follow未改
3. skill_collect三机制兜底链，违背executor"零兜底"声明
4. 上游skills.js与新task重叠5处（collectBlock、goToPlayer、followPlayer、goToPosition、followEntity）
5. 垫脚块清单三处不一致（tool_prep、executor、skill_escape）
6. mode暂停列表三套（task_modes、executor、skills.js）
7. mapDir路径拼接8处

### 3.3 数据竞态与资源泄漏（6处）
1. terrain3d每函数开关库，语句缓存永不命中 (:153)
2. fail表从不清理，readFails全表扫 (:495)
3. task_collect中断时不恢复mode、不stop scaffolder (:97)
4. ScaffoldTracker监听blockUpdate泄漏，清理时含他人放置的块 (:28-46)
5. onEvent包装两层，trace_bus重复记录 (executor:95/506/738)
6. 潜水循环30s不查中断 (executor:349-355)

### 3.4 可证缺陷（D1–D13 台账）
13 条**全部有记录**，但原先分散在 4 份文档（本文件、`05_navigation.md`、`03_tasks.md`、`PART2`）。
下表是唯一台账：新增缺陷沿用编号，并在此登记。

| 编号 | 缺陷 | 原文位置 | 修复项 |
|------|------|---------|--------|
| **D1** | y 语义混乱（方块本身 vs 脚格）→ 下坡挖错列、上 2 格跳不上 | 本文 §3.4 / `05_navigation.md` §D1 | Phase1 1.1（方案 B：统一脚格） |
| **D2** | dig 步骤忽略 x/z（挖邻列的边），液体头顶假成功 | 本文 §3.4 / `05_navigation.md` §D2 | Phase1 1.3 |
| **D3** | `onFail` 只处理 `NO_PATH`/`TIMEOUT`，`NO_REACH` 等落默认 next | 本文 §3.4 | Phase4 4.1（task_collect） |
| **D4** | `followEntity` 不传 `mapDir` → 立刻 `INTERNAL` 失败 | 本文 §3.4 | Phase4 4.1 |
| **D5** | `followEntity` 用 3D 距离判到达、`walkTo` 用水平距离 → 有高差时空转超时 | 本文 §3.4 / `03_tasks.md`·task_follow_player / `05_navigation.md` §D5 | Phase4 4.1 |
| **D6** | `task_collect` 中断时不恢复 mode、不 stop scaffolder（资源泄漏） | §5 Phase1 1.4 / `03_tasks.md`·Mode 协调 | Phase1 1.4 |
| **D7** | `ScaffoldTracker` 清理时连别人放的块一起清 | §5 Phase1 1.5 / `PART2` §10.5 回归用例 | Phase1 1.5 |
| **D8** | 垫脚块清单三处不一致（tool_prep / executor / skill_escape） | §5 Phase1 1.6 | Phase1 1.6（统一进 config） |
| **D9** | 超时控制不严格：下沉循环 30s 不查中断、deadline 只在每轮开头查、单步 moveToXZ 可 30s | `05_navigation.md` §D9 | Phase6 6.3 |
| **D10** | `trace_bus` 同一事件重复记录（executor 95/506/738） | §5 Phase6 6.2 / §3.3 | Phase6 6.2 |
| **D11** | SQLite 语句缓存用 WeakMap，永不命中 | 本文 §3.4 / §3.3 | Phase6 6.1 |
| **D12** | `tool_prep` 的 goto 无超时，可能永不返回 | 本文 §3.4 / §5 Phase1 1.7 | Phase1 1.7 |
| **D13** | `goToPlayer` 的 `attempt >= 1` 恒真（重试条件失效） | `03_tasks.md`·task_follow_player | Phase4 4.1 |

> ⚠️ `PART2` §11 写"10 个回归用例覆盖 D1–D13"，13 条缺陷对 10 个用例，缺口要么补用例要么补说明。

---

## 4. 目标架构设计

### 4.1 分层原则

```
┌─────────────────────────────────────────────┐
│            Agent Control Layer              │
│    (agent.js, action_manager.js, coder)     │
└─────────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────┐
│          Skills Layer (skills/)             │
│  复杂策略、多任务编排、LLM决策桥接         │
│  skill_wood, skill_farm, skill_craft_chain  │
└─────────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────┐
│          Tasks Layer (tasks/)               │
│  单一目标的完整流程（有重试、超时、中断）  │
│  task_build, task_mine, task_collect        │
└─────────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────┐
│       Navigation Layer (nav/)               │
│  所有移动决策的唯一入口，管理mode暂停      │
│  nav_core.js, executor.js, path_3d.js       │
└─────────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────┐
│          Atoms Layer (atoms/)               │
│  纯函数，单一职责，返回契约ok/fail         │
│  atom_dig, atom_place, atom_craft           │
└─────────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────┐
│      Mineflayer Bot (bot.* methods)         │
└─────────────────────────────────────────────┘
```

### 4.2 接口契约

#### 原子层契约
```javascript
// atoms/ 所有函数必须：
// 1. 返回 {ok:true, data} 或 {ok:false, code, msg}
// 2. 无循环/重试（单次尝试）
// 3. 不调用其他原子（除工具函数如canStand）
// 4. 不读写全局状态（landmarks/memory除外，通过参数传递）
// 5. 不管理mode/中断（由调用者处理）

async function atomName(bot, ...args, {timeout=5000}={}) {
  // 单一操作
  return ok({...}) | fail(CODE, msg)
}
```

#### 导航层契约
```javascript
// nav/ 职责：
// 1. 所有移动决策的唯一入口
// 2. 管理mode暂停/恢复
// 3. 选择pathfinder vs walkTo
// 4. 处理被困检测
// 5. 返回标准契约

async function goTo(bot, dest, {
  near = 5,          // 到达阈值
  entity = null,     // 跟随实体
  mapDir = null,     // 3D地图目录
  deadline = 300000, // 超时
  onEvent = null     // 进度回调
} = {}) {
  // 暂停goal_modes
  // 选择引擎
  // 执行移动
  // 恢复modes
  return ok({dist}) | fail(NO_REACH|NO_PATH|TIMEOUT, msg)
}
```

#### 任务层契约
```javascript
// tasks/ 职责：
// 1. 完整流程（准备→执行→收尾）
// 2. 重试与超时管理
// 3. 中断检查（每步前）
// 4. 资源清理（finally块）
// 5. 返回标准契约+业务数据

async function taskName(bot, target, {
  deadline = 600000,
  onProgress = null,
  mapDir = null
} = {}) {
  const modes = pauseGoalModes(bot)
  try {
    // 准备阶段
    // 执行循环（含中断检查）
    // 成功返回
    return ok({count, items, ...})
  } catch (e) {
    return fail(CODE, e.message)
  } finally {
    restoreGoalModes(bot, modes)
    // 清理资源
  }
}
```

#### 技能层契约
```javascript
// skills/ 职责：
// 1. 多任务编排
// 2. 资源规划（需要X才能做Y）
// 3. 策略选择（根据情况选不同路径）
// 4. 不保证原子性（可部分完成）

async function skillName(bot, goal, context = {}) {
  // 规划阶段
  const plan = await analyzeSituation(...)
  
  // 执行多任务
  for (const step of plan) {
    const r = await executeTask(step)
    if (!r.ok) {
      // 策略调整
    }
  }
  
  return {completed, partial, failed, ...}
}
```

---

## 5. 重构优先级路线图

### Phase 1: 基础设施修复（高风险bug）
**目标**: 修复D1-D13缺陷，统一y语义，防止数据竞态

> ✅ **2026-10-31 全部完成**。每项都有离线回归测试；D1 另有真机地图库上的量化验证。
> ✅ **2026-11-01 补上真机回归**：测试服起来后跑了 `tools/verify_d1_live.mjs` 8 个场景全过
> （平地/上1格/上2格垫方块/挖自己列/邻列挖/液体头顶/下来/同列挖上2格），
> 以及全量 `atom_all` 18/18（234 个用例，每项都有真实用例数）。
> 🔴 教训：`atom_all` 原来在服务器关着时会**假绿**（各脚本吞掉连接错误、退出码 0），
> 已修为"连不上即失败 + 子测试必须至少一条 PASS"。引用历史原子测试结果时注意这一点。

- [x] 1.1 统一y语义（terrain3d + path_3d + executor）— 结论：terrain3d 本来就存面位、path_3d 也按面位工作，**只有 executor 内部混用**（已在 execStep 换算 targetFeetY，并修掉 walkTo 传错面位的问题）
- [x] 1.2 修复terrain3d连接复用、fail表查询优化 — 连接按目录复用（实测 0.41ms→0.003ms/次）；fail 表 TTL 从未生效的真因是 SQL 没取 last_at（NaN 判据），已下推到 SQL + 加索引 + pruneFails
- [x] 1.3 修复executor挖邻列逻辑（D2）— 按 step.x/z 取列；同列才垫高；液体头顶不再假成功
- [x] 1.4 修复task_collect mode泄漏+scaffolder泄漏（D6）— try 起点提前到"改过全局状态之后"
- [x] 1.5 修复ScaffoldTracker只清自己放的块（D7）— 改记 bot.placeBlock 真正放成功的那格
- [x] 1.6 统一垫脚块清单为一份（D8）— 新增 scaffold_blocks.js，4 处调用点归一
- [x] 1.7 修复tool_prep goto超时问题（D12）— goto/dig/craft 全部加上限 + 超时后 pathfinder.stop()

**交付物**: 补丁版本 mindcraft-v0.1-hotfix
**回归脚本**: `tools/{scaffold_tracker,tool_prep_timeout,exec_step_dig,terrain3d,exec_step_y}_unit.mjs`、`tools/verify_y_semantics.mjs`

---

### Phase 2: 原子层规范化
**目标**: 所有原子遵守契约，移除复合逻辑

#### 2.1 拆分违规原子
- [x] atom_drops.js → 删除循环，只返回最近掉落物坐标
      — 实际做法：整个 `collectDrops` 上移到复合层 `task_pickup.js`（原子已由
        `atom_find_drops` / `atom_wait_item` / `atom_stand` 提供零件），原文件删除
- [x] atom_tunnel.js → 只做单步tunnelStep，删除tunnelAlong循环
      — 循环改由调用方 `skills.digTunnel` 用 `runSteps` + `tunnelStep` 处理器表达
- [x] atom_dig.js → 移除直接按键，改为参数控制bot.dig行为
      — 删掉"蹬一下"的 setControlState 兜底，悬空时如实返回 BLOCKED
- [x] atom_classify.js → landmarks读写改为参数传递
      — `isProtected(pos, { spots })` 变纯函数；加载+缓存移到数据层 `landmarks.protectedPlaces(bot)`（WeakMap 按 bot 隔离）

#### 2.2 新增缺失基础原子（优先级排序）
**P0（核心移动）**
- [x] atom_pillar.js - 统一跳垫逻辑
      — `pillarUpOnce`（单次：起跳→等顶点→垫脚下）；重试/清头顶留在 `executor.stepUp`。
        真机 `verify_d1_live` [3][8] 两条走这条路，全过
- [ ] atom_pathfind.js - 封装原生pathfinder
      — **建议不做**：`atom_move` 已经在封装 `pathfinder.goto`（moveTo / moveToXZ 都走它），
        再包一层只是改名，违反 C4 复用优先。除非有新需求（如 GoalFollow 统一入口）再议
- [x] atom_stuck_detect.js - 被困检测提取
      — 已提取为纯函数原子（movedEnough / weightedMove / realMove），
        executor 改为调用它，判据与阈值原值不变（2 / 1.5）

**P1（生存必需）**
- [ ] atom_craft.js - 合成单物品
- [ ] atom_eat.js - 进食
- [ ] atom_smelt.js - 熔炉操作

**P2（功能扩展）**
- [ ] atom_trade.js, atom_bed.js, atom_ride.js
- [ ] atom_lever.js, atom_door.js, atom_enchant.js

**交付物**: atoms/ 目录完全符合契约，新增10+原子

---

### Phase 3: 导航层统一
**目标**: 单一移动入口，消除pathfinder vs walkTo分裂

#### 3.1 核心重构

> **2026-11-01 进度**：`nav_core.goTo` 已落地并有基线对比；`executor` 拆 `steps/` 尚未做
> （风险最高的一块，需另立基线再动）。
>
> **移动基线（改前 X，测试服真机，5 地形 × 10 轮 = 50/50 全成功）**：
> flat 7652ms / stairs 8486ms / wall 6414ms / gap 6768ms / long 18014ms，
> 明细 `tmp/bench/2026-10-31-move-walkto.jsonl`。
> **改后 Y（同一套 bench 走 goTo，5 轮）**：25/25，耗时全在噪声内（±10%）。
>
> **逐 action 基线（拆 executor 的对照基准，11 场景 × 10 轮 = 99/110）**：
>
> | 场景 | 成功率 | 平均耗时 | 动作 |
> |---|---|---|---|
> | walk-flat | 10/10 | 7666ms | walk |
> | jump-up1 | 10/10 | 6587ms | walk |
> | pillar-up2 | 10/10 | 8674ms | walk+jump |
> | down1 | 10/10 | 6741ms | walk+down |
> | **down5** | **0/10** | 2778ms | walk —— **稳定 NO_PATH，maxDrop=4 的能力边界** |
> | **dig-through** | **9/10** | 6332ms | walk+dig |
> | digdown | 10/10 | 12969ms | walk+jump+down |
> | climb-ladder | 10/10 | 21958ms | walk+dig+climb |
> | climb-vine | 10/10 | 2256ms | walk+dig+climb |
> | water-cross | 10/10 | 27304ms（16~57s 波动大） | walk+down |
> | gap-bridge | 10/10 | 8048ms | walk+down |
>
> 明细 `tmp/bench/2026-10-31-move-actions.jsonl`。
> 失败码仅 `NO_PATH`×11。**拆 executor 之后必须逐行对比这张表。**
>
> 基线暴露、属于 Phase 3 要修的：`climb-ladder` 每次都是 22s，且日志必然出现一次
> `步7 walk 失败: STUCK 连续 20 秒没靠近（还差 0.7 格）` —— 规划先给了一个走不到的
> walk 步，白等 20 秒才重规划（walk 分支对垂直目标处理不当）。

- [x] 新增 nav_core.js - goTo统一入口
      — 三引擎按输入选：有 mapDir→walkTo(3D)、给了 y→moveTo、只有 x/z→moveToXZ。
        `task_hop.hopTo` 改为转调它，对外契约与行为未变；
        实体跟随仍走 task_follow（目标失效/重定位是另一套语义）
  ```javascript
  export async function goTo(bot, dest, options) {
    // 自动选择引擎：
    // - entity跟随且<40格 → GoalFollow
    // - mapDir存在 → walkTo (3D)
    // - 其他 → pathfinder.goto (2D)
  }
  ```

- [ ] 重构 executor.js
  - [ ] 拆分为 walkLoop + steps/目录
  - [ ] steps/walk.js, steps/dig.js, steps/climb.js, steps/swim.js
  - [ ] 移除mode管理（交nav_core）
  - [ ] 移除直接按键（调atom_pillar）

- [ ] 删除 path_short.js + moveToXZEx

#### 3.2 统一调用
- [x] task_hop.js 并入 nav_core（2026-11-01：hopTo 转调 goTo，签名与行为不变）
- [ ] actions.js 所有移动命令改调 goTo
- [ ] skills.js 移动函数改为薄包装

**交付物**: nav/ 目录，所有移动走唯一入口

---

### Phase 4: 复合层规范化
**目标**: 任务/技能符合契约，消除功能重复

#### 4.1 任务层重构
- [ ] task_follow.js
  - [x] 被困BFS提取到atom_stuck_detect（2026-11-01：`detectTrapped` 纯查询；task_follow 净删 111 行；判据原样保留，两条已知弱点写进原子注释）
  - [x] 自救交给skill_escape（已在 2026-10-27 就是这么做的；2026-11-01 又按契约整改了 skill_escape 本身）
  - [ ] 删除直接setGoal/setMovements

- [ ] task_collect.js + skill_collect.js
  - [ ] 保留pipeline，修复D3失败码处理
  - [ ] moveTo处理器只调nav.goTo
  - [ ] climbByTunneling移到nav

- [ ] tool_prep.js
  - [ ] ensureAxe改用atom_craft
  - [ ] ensureScaffold改用atom_dig+collectDrops
  - [ ] 删除直接dig/craft/goto

#### 4.2 新增核心任务（优先级排序）
**P0（命令系统需要）**
- [ ] task_build.js - 建造结构
- [ ] task_mine.js - 挖矿

**P1（生存循环）**
- [ ] task_farm.js - 农业
- [ ] task_smelt.js - 批量熔炼
- [ ] task_equipment.js - 装备升级

**P2（探索战斗）**
- [ ] task_explore.js, task_combat.js, task_shelter.js

#### 4.3 技能层新增
**P0**
- [ ] skill_wood.js - 伐木策略
- [ ] skill_unstuck.js - 脱困策略库

**P1**
- [ ] skill_craft_chain.js - 复杂合成链
- [ ] skill_farm.js - 农场管理

**交付物**: tasks/ 和 skills/ 目录重组，新增8+任务

---

### Phase 5: 上游集成清理
**目标**: 消除skills.js冗余，统一命令路由

- [ ] 5.1 skills.js重复函数标记为废弃
  - [ ] collectBlock → 调task_collect（已做）
  - [ ] goToPlayer/followPlayer → 调task_follow（已做）
  - [ ] goToPosition → 调nav.goTo

- [ ] 5.2 删除companion_mode四处分支

- [ ] 5.3 统一mapDir路径构建（helpers.js）

- [ ] 5.4 actions.js命令全部路由到task/nav

- [ ] 5.5 mode管理统一到task_modes
  - [ ] 删除executor mode列表
  - [ ] 删除skills.js mode列表
  - [ ] 修复空闲时unPauseAll竞态

**交付物**: 上游代码只保留LLM决策层

---

### Phase 6: 性能与可观测性
**目标**: 优化热路径，增强调试能力

- [ ] 6.1 terrain3d性能优化
  - [ ] 连接池模式（复用SQLite连接）
  - [ ] fail表分区查询
  - [ ] 语句缓存改为static WeakMap

- [ ] 6.2 trace_bus增强
  - [ ] 事件去重（修复D10）
  - [ ] 时间窗口清理（>5min丢弃）
  - [ ] 导出为结构化日志

- [ ] 6.3 deadlineMs统一检查
  - [ ] 所有循环首行查deadline
  - [ ] 单步超时独立配置

- [ ] 6.4 测试覆盖
  - [ ] 每个原子单元测试
  - [ ] 关键任务集成测试（collect/follow/build）
  - [ ] 缺陷D1-D13回归测试

**交付物**: 性能提升30%+，测试覆盖率60%+

---

## 6. 文件组织结构（目标）

```
src/agent/library/
├── atoms/                    # 原子层（纯函数）
│   ├── movement/
│   │   ├── atom_move.js
│   │   ├── atom_pathfind.js
│   │   ├── atom_pillar.js
│   │   ├── atom_stuck_detect.js
│   │   └── atom_stand.js
│   ├── blocks/
│   │   ├── atom_dig.js
│   │   ├── atom_place.js
│   │   └── atom_tunnel.js
│   ├── items/
│   │   ├── atom_craft.js
│   │   ├── atom_items.js
│   │   ├── atom_drops.js
│   │   └── atom_smelt.js
│   ├── interaction/
│   │   ├── atom_container.js
│   │   ├── atom_trade.js
│   │   ├── atom_use.js
│   │   └── atom_bed.js
│   ├── combat/
│   │   ├── atom_attack.js
│   │   ├── atom_eat.js
│   │   └── atom_shield.js
│   └── perception/
│       ├── atom_perceive.js
│       ├── atom_look.js
│       └── atom_query.js
│
├── nav/                      # 导航层（移动决策）
│   ├── nav_core.js          # 统一入口goTo
│   ├── executor.js          # 3D导航循环（重构后）
│   ├── path_3d.js           # 体素A*
│   ├── terrain3d.js         # 地形库（优化后）
│   └── steps/               # 执行器步骤
│       ├── step_walk.js
│       ├── step_dig.js
│       ├── step_climb.js
│       └── step_swim.js
│
├── tasks/                    # 任务层（完整流程）
│   ├── task_collect.js
│   ├── task_follow.js
│   ├── task_platform.js
│   ├── task_build.js        # 新增
│   ├── task_mine.js         # 新增
│   ├── task_farm.js         # 新增
│   ├── task_smelt.js        # 新增
│   ├── task_equipment.js    # 新增
│   ├── task_explore.js      # 新增
│   └── task_modes.js        # mode管理（唯一）
│
├── skills/                   # 技能层（策略编排）
│   ├── skill_collect.js
│   ├── skill_escape.js
│   ├── skill_wood.js        # 新增
│   ├── skill_farm.js        # 新增
│   ├── skill_unstuck.js     # 新增
│   └── skill_craft_chain.js # 新增
│
├── utils/                    # 工具与支持
│   ├── atom_contract.js     # 契约机制
│   ├── step_runner.js       # 步骤执行器
│   ├── collect_planner.js
│   ├── scaffold_cleanup.js  # 修复后
│   └── helpers.js           # mapDir等
│
└── data/                     # 数据层（不变）
    ├── storage.js
    ├── landmarks.js
    ├── memory_store.js
    ├── world_model.js
    ├── trace_bus.js         # 增强后
    └── terrain_view.js
```

---

## 7. 迁移策略

### 7.1 向后兼容
- 保留旧函数作为废弃包装器（6个月）
- 在控制台输出警告：`[DEPRECATED] Use nav.goTo instead of skills.goToPosition`
- 文档标记迁移路径

### 7.2 渐进式重构
每个Phase产出可工作版本：
- Phase 1: v0.1-hotfix（修bug）
- Phase 2: v0.2-atoms（新原子）
- Phase 3: v0.3-nav（导航统一）
- Phase 4: v0.4-tasks（任务完善）
- Phase 5: v0.5-upstream（清理集成）
- Phase 6: v1.0（性能优化+测试）

### 7.3 测试覆盖
每个Phase前：
- 记录当前行为为baseline测试
- 重构后回归测试必须通过
- 新功能需新测试

---

## 8. 风险与缓解

### 8.1 高风险项
| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| y语义修复破坏现有路径 | 🔴高 | 中 | 真机回归测试10个场景 |
| 导航层统一引入新bug | 🔴高 | 中 | AB测试pathfinder vs walkTo |
| SQLite并发竞态 | 🟡中 | 低 | 连接池+事务日志 |
| mode恢复时序错误 | 🟡中 | 中 | 单元测试所有嵌套场景 |
| LLM调用旧命令 | 🟡中 | 高 | 废弃包装器+文档更新 |

### 8.2 回滚策略
- 每个Phase打git tag
- 保留旧代码分支6个月
- 生产环境灰度发布（10% → 50% → 100%）

---

## 9. 成功指标

### 代码质量
- [ ] 所有原子返回契约 ok/fail
- [ ] 移动调用收敛到1个入口（goTo）
- [ ] 消除11处功能重复
- [ ] 修复13处可证缺陷

### 性能
- [ ] terrain3d查询 <10ms（现在~50ms）
- [ ] walkTo规划 <200ms（现在~500ms）
- [ ] 内存泄漏为0（现在ScaffoldTracker泄漏）

### 可维护性
- [ ] 新增原子 <50 LOC
- [ ] 新增任务 <200 LOC
- [ ] 测试覆盖率 >60%

### 功能完整性
- [ ] 支持10种核心任务（现在5种）
- [ ] 支持20+种物品合成（现在0）
- [ ] 支持农业循环（种植→收割→合成）

---

## 10. 下一步行动

### 立即可做（无依赖）
1. **补丁D7-D8**（1天）
   - 修复ScaffoldTracker只清自己放的块
   - 统一垫脚块清单

2. **新增atom_craft.js**（2天）
   - 单物品合成
   - 工作台放置
   - 单元测试

3. **文档清理**（1天）
   - 标记废弃函数
   - 写迁移指南

### 需用户确认
1. **y语义选择**（必须先决定）
   - 方案A: 统一为脚格（executor现状）
   - 方案B: 统一为实心方块（terrain3d现状）
   - 推荐方案A，但需真机测试

2. **导航引擎选择策略**
   - 是否保留pathfinder？（建议保留用于<40格动态目标）
   - 是否保留walkTo？（建议保留用于有mapDir的长距离）
   - 统一入口如何自动选择？

3. **Phase优先级调整**
   - 是否先做Phase 4（任务层）再做Phase 3（导航层）？
   - 是否跳过某些P2优先级的新原子？

---

## 附录：关键代码位置速查

### 高风险修改点
- terrain3d.js:328-338 - y值存储
- executor.js:100 - dy计算
- executor.js:177-205 - dig分支
- task_collect.js:50/97 - mode泄漏
- scaffold_cleanup.js:28-46 - blockUpdate监听

### 功能重复点
- actions.js:208/299/375 vs actions.js:233 - 移动命令分裂
- task_modes:13 vs executor:535 vs skills:2175 - mode列表
- tool_prep:88 vs executor:63 vs skill_escape:35 - 垫脚块清单

### 死代码
- path_short.js - 整个文件
- atom_move.js:474 moveToXZEx
- executor.js:793 describeStore
- collect_planner.js:77 describeSurvey

---

**文档版本**: 1.0  
**生成时间**: 2026-10-31  
**基于报告**: 4个子agent只读调研（token总计~2.1M）
