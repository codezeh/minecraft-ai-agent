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

### 3.4 可证缺陷（D1–D27 台账）
D1–D13 **全部有记录**，但原先分散在 4 份文档（本文件、`05_navigation.md`、`03_tasks.md`、`PART2`）。
D14–D27 是 2026-11-01 对照源码逐条核实后补登的（D18、D25 是推断，标了"需复现"）。
下表是唯一台账：新增缺陷沿用编号，并在此登记。

| 编号 | 缺陷 | 原文位置 | 修复项 |
|------|------|---------|--------|
| **D1** | y 语义混乱（方块本身 vs 脚格）→ 下坡挖错列、上 2 格跳不上 | 本文 §3.4 / `05_navigation.md` §D1 | Phase1 1.1（方案 1B：统一面位 = 脚下实心块的 y；`ba84907`） |
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
| **D14** | `execStep` 用了没定义的 `mapDir`（`columnSurfaces(mapDir, …)`，调用处只传 `{ onEvent }`）→ ReferenceError 被空 `catch` 吞掉，**10-28 加的"落点安全检查"从未执行** | `executor.js` execStep 落点检查段 | ✅ 2026-11-01 已修：walkTo 传 `mapDir`；catch 改发 `landing-check-error`；判据收窄为"落点那格是 `T.LAVA`"（原判据会拦掉水面过河，理由见 executor 注释）。回归 `tools/exec_landing_unit.mjs` |
| **D15** | `isLiquid(floorB.name)` 传了字符串，`isLiquid` 读 `b.name` → 恒假，**液体地板被当实心** | `atom_tunnel.js:85/176` | ✅ 2026-11-01 已修：`isLiquid(floorB)`。回归 `tools/test_tunnel.mjs` 7b（已接进 unit_all） |
| **D16** | `waitUntil` 没传 `bot`，中断谓词返回 `undefined`（=继续等）→ 爬梯中喊停仍按住跳直到超时（`climbUp` 默认 8 秒） | `atom_climb.js:200/256` | 传 `bot`，中断返回 `INTERRUPTED` |
| **D17** | `this.timedout = true` 之后从不复位 → 之后每个动作都带着 timedout，中断消息被吞 | `action_manager.js:9/137/205` | `_executeAction` 开头复位（任务板 B0） |
| **D18** | `stop()` 等 10 秒后强制 `executing=false`，但旧动作函数没被取消、还在跑；新动作开头 `clearBotLogs` 又清了 `interrupt_code` → 可能两个流程同时驱动 bot（推测，需真机复现） | `action_manager.js:30-41` | 任务板 B0 |
| **D19** | 自己写 `bot.interrupt_code = false`，与 `stop()` 竞速，可能吞掉真中断 | `task_follow.js:85` | 删掉；`action_manager.js:106` 已在新动作开始时清过 |
| **D20** | 注释说用精确坐标，下一行却 `Math.floor` → 落点差半格吸不到 | `task_pickup.js:123-126` | 直接用 `dest`，`tol` 0.5 |
| **D21** | `waitGone` / `waitForBlock` 循环里不查 `interrupt_code` → 被取消时多等最多 1.5 秒 | `atom_dig.js:144` / `atom_place.js:145` | 循环内加检查 |
| **D22** | 本地 `waitFor` 中断时返回 `null`，调用方当成"没变化"报 `BLOCKED` | `atom_use.js:183` → `:93` / `:130` | 区分中断与超时 |
| **D23** | `settings_spec.json` 没有 `companion_mode` → 面板创建/编辑 agent 时被删掉，`!followPlayer` 等走旧路径 | `mindserver.js:222-226` | 补 key；长期按 5.2 删开关 |
| **D24** | docHelper 用 `indexOf('**/')` 截 JSDoc；注释以 `*/` 结尾时返回 -1 → 截错，模型看到的技能文档残缺 | `src/agent/library/index.js:11` | 改正则；`!listSkills` 改走 manifest（`04_skills.md §5`） |
| **D25** | `restart-agent` 对已停止的 agent（socket 为 null）直接 `.socket.emit` → mindserver 崩（推断；第一轮审查已报） | `mindserver.js:303-306` | ✅ 2026-11-01 已修：判空；`chat-message` / `set-agent-settings` 的同类问题一并判空 |
| **D26** | `nav_core.withEngine` 往 `data` 里加 `engine`，不在 §6.3 白名单 | `nav_core.js:119-122` | 白名单加 `engine`，或改进 trace |
| **D27** | `PASSABLE` 含 `water` / `lava`，`canStand` 只查"可穿过 + 下方有支撑"，**脚位或头位是岩浆也判能站**；`findStandSpot` 直接用它的结论 | `atom_stand.js:24` / `:62-84` | ✅ 2026-11-01 已修：`PASSABLE` 去掉 `lava`。没加"选点后过 `isSafe`"：它把 4 格内有水、12 格内有敌对生物都算不安全，会拒掉大量正常站位。回归 `tools/atom_stand_unit.mjs` |

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

> 2026-11-01：按新定义（原子 = 一次玩家输入），下面 P1 / P2 的 craft / eat / smelt / trade / bed / ride / lever / door / enchant 都是**动作**，
> 归 [`02_actions.md §3`](02_actions.md)；原子补齐另见 Phase A。

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
>
> **✅ 已修（2026-11-01，commit 4b4ac1c）**：根因是「目标格是可攀爬方块（梯子/藤蔓），
> 物理上走不进去 → `GoalNearXZ` 永远不 resolve → isStalled 等满 20 秒」。
> 判据钉在成因上（目标格可攀爬 + 已在格里 + 高度对）才短路。
> 效果：climb-ladder 21958ms → **1959ms（-91%）**，climb-vine 2256 → 1945ms，
> 其余场景无回归（pillar-up2 8251ms、digdown 13398ms、gap-bridge 7340ms）。
>
> ⚠️ **过程中的教训**：第一版守卫写成"水平 ≤1.0 就算到位"（只看距离），
> 结果静默改变了别的场景：pillar-up2 8674→14490ms（双峰，jump 从相邻格起跳 → NO_PATH），
> gap-bridge 出现过掉到 y=-181.5。**收紧到 0.8 仍复现**，只有改成"目标格走不进去"
> 才干净。→ 这类"提前判到位"的优化，判据必须钉在具体成因上，不能用距离近似；
> 而且必须在**多场景**基线上验证，单场景（只看爬梯）发现不了。

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
  - [x] 删除executor mode列表 — `a5e48e7`：executor 改调 `task_modes`
  - [ ] 删除skills.js mode列表
  - ~~修复空闲时unPauseAll竞态~~（2026-11-01 复核：不构成竞态，撤销此项）

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
  - [ ] 缺陷D1-D27回归测试（D14–D27 见 §3.4）

**交付物**: 性能提升30%+，测试覆盖率60%+

---

### Phase A: 原子收拢（2026-11-01 新增）
**目标**: 所有按键、点击、斜杠命令只从 `atom_input_*.js` 出去（[`01_primitives.md`](01_primitives.md)）

- [x] A.1 `atom_input_move` + `atom_read`；executor 潜水、`atom_climb`、`atom_pillar` 改调 `holdKey`（顺手修 D16）
  - 2026-11-01：`atom_input_move`（holdKey / pressKey / setSprint / setSneak / releaseAll）与 `atom_read`（14 个读取，
    不抛异常、读不到给 null/[]）。executor 潜水循环、`atom_climb.climbUp/climbDown`、`atom_pillar`、`atom_tunnel`
    全部改调 `holdKey`。**D16 已修**：中断不再靠谓词返回 undefined 拖到超时，`holdKey` 每 ~100ms 查
    `interrupt_code` 并在 `finally` 松键。回归 `tools/atom_input_unit.mjs`（19 用例，含「爬梯中断 219ms 内返回且 jump 已松」）。
- [x] A.2 `atom_input_mouse`；dig / place / use 改走 `holdDig` / `placeAgainst` / `useOnBlock`（顺手修 D21、D22）
  - 2026-11-01：`atom_input_mouse`（holdDig / stopDig / placeAgainst / useOnBlock / useOnEntity / useHeld /
    releaseUse / attackOnce / setLook / lookAtPoint / swing；`lookAt` 转出 `atom_look`，不重复实现）。
    **D21 已修**：`waitGone` / `waitForBlock` 改 `waitUntil({ bot })`，中断即返回。
    **D22 已修**：`atom_use` 的本地 `waitFor` 删除，门 / 床 / 作物三处都区分「中断」与「世界没变」。
- [x] A.3 `atom_input_misc` + 带白名单的 `command()`；`skills.js` 的斜杠命令改调它
  - 2026-11-01：白名单**只有一张表** —— `permissions.SLASH_COMMANDS`（`permissions.js:217`；
    `:242` 的 `SLASH_WHITELIST` 是同一对象的别名，不是副本）。每条形如
    `{ cmd, level: 'owner' | 'trusted', cheat?: true }`；作弊类（`tp` / `setblock` / `fill` / `gamemode`）
    标 `level: 'owner'` + `cheat: true`。
    `atom_input_misc.command()` **只问这一张表**（`slashVerdict`），该文件内**没有**第二份 SAFE/CHEAT 清单。
    调用侧仍要求显式 `{ cheat: true }` —— 那是调用者的自我约束，与表里的等级判定是两层**防御**，
    不是两份**真相**。
    > ⚠️ 早期设计写的是"两层：先问 M1 的 SLASH_WHITELIST、再问本文件的 SAFE/CHEAT"，
    > 已按 captain 2026-11-01 决策**并成一张表**。以本行为准。
    > 理由：两个真相是本项目反复出问题的根源（mode 列表三套、垫脚块四处、站立判据两份、y 语义混用）。
    `skills.js` 的 9 处斜杠命令全部改 `command()`，2 处 `setControlState('forward')` 改 `pressKey`。
- [x] A.4 preflight 扫描 A1 列的 API，清空豁免名单

  **A.4 豁免台账（2026-11-01 逐条核对真实命中，已排除注释）** —— 「5 条规则 0 命中」**不等于**「豁免已清空」，
  下面每一条都是「仍允许从 atom_input_* 之外发出输入」的窗口，Phase R / 对应里程碑必须逐条销账：

  | 豁免 | 真实命中 | 为什么留 | 销账里程碑 |
  |---|---|---|---|
  | `library/atom_boat.js` | setControlState ×9（176/183/249/250/251/252/258/356/362）、`/ride` ×2（208/380） | 零调用方（已 grep 确认 src 里没人 import）；Paper 1.21.8 上船过水走不通 | **Phase R 直接删除**（2026-11-01 决定，**不再是「冻结」**）：载具能力已由 `atom_input_misc.mountEntity/dismount` 承接，删掉不丢功能。**不要再去维护这个文件** |
  | `modes.js` | setControlState ×1（:43 jump）；另有 `bot.look*` ×4（296/298/311/313；294/310 是 `smoothLook.*`，另一种 API，不在此列） | t3 收口后仍在，属 M2 控制层（自保跳跃/扭头） | **M2 残项**（t3 已收口，本轮不重开）：Phase R 前收敛到 `holdKey` / `atom_input_mouse.lookAt` |
  | `tasks/**`（= `src/agent/tasks/`） | 斜杠命令 ×45（tasks.js / cooking_tasks.js / construction_tasks.js） | 上游评测任务（mindcraft 原版烹饪/建造评测），**不在陪玩运行路径** | 长期豁免，但只限这三个文件；新文件不许以「反正在 tasks 下」为由加进来 |
  | `library/skills.js` | 鼠标输入 ×14（attack 732；dig 908/1057；placeBlock 1257；activateBlock 1858/2352/2368/2473/2486/2511/2930；activateItem 2842/2927；stopDigging 1933） | 运行路径（采集/建造/开关门），量最大、风险最高 | **Phase R**（按前缀重排时一起搬）。注意：这 14 处是**既定的直发行为**，Phase A 没有让它们变得更差，窗口期可接受 |
  | ~~`library/tool_prep.js`~~ | ~~×2（dig 160；placeBlock 298）~~ | **已于 2026-11-01 本轮改掉**：改调 `holdDig`（保留 D12 的 withTimeout 兜底，并按 ActionResult 判成败）与 `placeAgainst` | ✅ 已销账 |
  | ~~`library/atom_attack.js`~~ | ~~×1（bot.attack 143）~~ | **已于 2026-11-01 本轮改掉**：`bareAttack` 改调 `atom_input_mouse.attackOnce` + `lookAtPoint`（挥击与扭头同一个出口） | ✅ 已销账 |
  | `agent.js` | ×1（`this.bot.stopDigging()` 342） | 停任务时的收尾清理，agent.js 属 M1（t2 交付）。**2026-11-01 决定：明留到此表，留到 Phase R 改调 `stopDig`** —— 不是隐形豁免，本条就是它的销账依据 | **Phase R** |
  | ~~`library/skill_clear.js`、`library/scaffold_cleanup.js`~~ | **0**（当初把注释里的提及也算进去了） | — | ✅ 2026-11-01 已从 `allow` 删除（空豁免比没有更坏：让人以为「确实违规但我们原谅了」） |

  **扫描覆盖缺口（必须记下，别当成「没发现」）**

  - ✅ **2026-11-01 已把 `bot.look*` 纳入扫描**（`mouse-input-owner` 的 pattern 补齐 lookAt / look）。
    纳入后 `bot.look*` 的真实命中（已排除注释，全仓共 **21** 处）：
    `skills.js` 7、`modes.js` 4、`vision_interpreter.js` 3、`atom_boat.js` 2、
    `atom_input_mouse.js` 2 与 `atom_look.js` 1（**这两个是正当的实现方**）、
    `atom_move.js` 1（507，与 `atom_look.lookAt` 重复实现）、`task_follow.js` 1（384）。
    也就是说：**归属方之外仍有 18 处**；其中 `skills.js`(7) 与 `atom_boat.js`(2) 本来就在既有豁免内，
    新暴露出来的是 `modes.js` 4 + `vision_interpreter.js` 3 + `atom_move.js` 1 + `task_follow.js` 1 = **9 处**，
    已逐条具名写进 `allow` 并注明归属。
    另：`atom_attack.js` 本轮改调 `lookAtPoint` 后自己不再命中。
    **这句话现在仍然不成立**（「look 只从 atom_input_mouse 出去」尚未做到），但**从今往后违规会被扫出来** ——
    t5 请按「具名豁免 + 命中数」判定，不要按「0 命中」判定 A1 的 look 一半已完成。
    规则自验：临时摘掉 `atom_move.js` 的豁免，preflight 立刻报 `✗ mouse-input-owner 1 处`（已实测）。
  - `atom_input_inventory`（selectSlot / clickWindow / closeWindow / dropSlot）**尚未建**，但**当前没有绕过口**：
    全仓 `clickWindow` 0 处、`setQuickBarSlot` 0 处；`atom_container` 只用 `bot.closeWindow`、
    `atom_items` 只用 `bot.equip`（两者都不在 A1 清单里）。这是「缺原子」而不是「有后门」，
    但 A1 的「物品栏」那一格确实是空的。

  - 2026-11-01：先给扫描器加**跳过注释 / 字符串**的判据（否则 `atom_boat` 文档注释里提到的 setControlState 也算
    命中，只能靠给注释加豁免让门禁变绿 —— 名单立刻变脏）。五条规则：control-state-owner / mouse-input-owner /
    slash-command-owner / chat-via-openchat / rcon-password-literal，**命中即判失败**（`--report-api` 退回只报告）。
    当前全部 0 处。豁免名单里只留**具名**残余，每条写了理由与归属：`atom_boat`（冻结、无人 import）、
    `modes.js`（M2 / t3）、`tasks/**`（开发用任务脚本）、以及 `skills.js` / `tool_prep` / `skill_clear` /
    `scaffold_cleanup` / `atom_attack` 的鼠标输入存量（Phase R 迁）。迁一个删一行。

**交付物**: 输入原子 4 个文件共 36 个（`atom_input_move` 5 + `atom_input_mouse` 11 + `atom_input_misc` 6 + `atom_read` 14）；
`atom_input_inventory` 的 4 个（selectSlot / clickSlot / closeWindow / dropSlot）尚未建，`closeWindow` 现由 `atom_container.closeContainer` 提供。
`setControlState` 只出现在 `atom_input_move.js`（`atom_boat` 冻结、`modes.js` 属 M2 —— 见 A.4 的具名残余）。

---

### 里程碑 M1–M3 统一验收（2026-11-01，t5）
**目标**: 按 [`09_crosscut.md §5`](09_crosscut.md)（测试）/ §6（版本）对 M1 安全、M2 控制、M3 原子收拢做统一验收

> **数据溯源（污染留档，不隐藏）**：`verify-run1` 因 `control` 收尾时误踢了本轮的 bot
> （`19:14:43 kick ma75354 "M2 bench finished"`，它自己的 bot 是 `ma70482`），bot 断线后 13 行是
> 传送失败/SKIP 的假数据，**已作废并归档**为 `tmp/bench/2026-11-01-move-actions.verify-run1-killed.jsonl`
> （不参与任何统计）；正式数据来自 run2。`control` 自己的 424 行归档为 `...control-m2.jsonl`。

- [x] 1 离线全量 `node tools/unit_all.mjs` → **19/19 脚本通过、1 跳过、exit 0**
  - 用例数：atom_input_unit 19 / control_reasons_unit 35 / permissions_unit 64 / server_props_unit 29 /
    test_tunnel 39 / test_escape 25 / mindserver_local_only_unit 16 / atom_stand_unit 7 / atom_stuck_detect_unit 7 /
    detect_trapped_unit 6 / exec_landing_unit 6 / nav_core_unit 6 / scaffold_tracker_unit 6 / atom_classify_unit 5 /
    task_pickup_unit 4 / terrain3d_unit 4 / exec_step_y_unit 3 / exec_step_dig_unit 3 / tool_prep_timeout_unit 3
  - `needsRealData` 三条都实测：默认 → `⏭ verify_y_semantics` + exit 0；只筛真机脚本
    （`node tools/unit_all.mjs verify_y_semantics`）→ `0/0 通过、1 跳过`、exit 0（**不假红**）；
    `--real` 没被当过滤器。
- [x] 1b `node tools/unit_all.mjs --real` → **20/20 通过**（补上一直跳过的真机量化）。`verify_y_semantics`：
  真实地形库 `bots/deepseek/map/terrain3d.db` 抽 2000 条，**面位(y) 命中 2000/2000 = 100.0%**，
  **脚位(y+1) 命中 134/2000 = 6.7%** —— 与 1.1 结论一致，y 语义（面位）落地成立。
- [x] 2 `preflight` 三种模式全 exit 0，5 条 API 规则各 **0 命中**（默认 / `--strict-api` / `--report-api`）
  - 94/94 模块导入；新模块申报 5 个全部已批准；规则表 18 条自洽；错误码 31 个合法；裸常量 11 处（基线 14）
- [x] 3 真机 `node tools/atom_all.mjs` → **18/18 通过**，每项都有真实用例数，**无 `NO_CASES_RAN`**
  - ⚠️ **atom_all 的用例计数系统性 +1**（低危，本轮未修）：18 个脚本结尾都打印一行
    `xxx 原子：N PASS / M FAIL`，而 `tools/atom_all.mjs:71` 用 `/\bPASS\b/g` 计数，把这行汇总里的
    `PASS` 也算成一条用例。所以显示数 = 真实数 + 1。以下括号前是**真实用例数**：
    atom_move 10、atom_dig 14、atom_place 10、atom_items 10、atom_container 13、atom_use 13、
    atom_attack 10、atom_stand 17、atom_drops 13、atom_look 21、atom_safe 12、atom_query 22、
    atom_wait 14、atom_move_landing 9、atom_pickup_parts 16、vine_physics_test 7、
    skill_collect 22、skill_clear 11 —— 共 **244 条真实用例、0 FAIL**（显示总数 262 = 244 + 18 行汇总）。
    这不影响「有没有真跑用例」的判据（PASS>0 仍成立），但**别把显示数当用例数引用**。
  - **`skill_collect`：真实 22/22、0 FAIL**（显示 23）。这是 A.4 里 `tool_prep.js:165`
    （`bot.dig` → `holdDig`，顺手修「挖失败当挖到」）在**采集路径**上的唯一覆盖
    （`task_collect.js:12` import → `:89 ensureScaffold`），覆盖成立。
  - **`atom_attack`：真实 10/10、0 FAIL**（显示 11）。覆盖 `atom_attack.js:13` 改走
    `atom_input_mouse.attackOnce` + `:143 lookAtPoint` + `:145 attackOnce`（挥击与扭头同一出口），覆盖成立。
- [x] 4 真机 `node tools/bench_move_actions.mjs 5` → **49/55（89.1%）**，失败**全部 NO_PATH ×6**，无新问题
  - 基线 `261/297 = 87.9%`（同口径 5 轮期望 ≈ 48.4/55）→ 本轮 49/55，**持平略好**
  - 逐场景（本轮 n/5 + 中位；基线中位取自 27 轮）；「动作直方图」是本轮 5 轮合计：

    | 场景 | 本轮 | 中位 ms | 范围 ms | wantHit | 动作直方图 | 基线中位 | 基线通过 |
    |---|---|---|---|---|---|---|---|
    | walk-flat | 5/5 | 7643 | 7415–7728 | 5/5 | walk 55 | 6248 | 27/27 |
    | jump-up1 | 5/5 | 6571 | 6405–6694 | 5/5 | walk 110 | 5515 | 27/27 |
    | pillar-up2 | 5/5 | 9533 | 7992–11091 | 5/5 | walk 105, jump 5 | 8050 | 27/27 |
    | down1 | 5/5 | 6764 | 6479–6868 | 5/5 | walk 105, down 5 | 6059 | 27/27 |
    | down5 | **0/5** | 2809 | 2586–2817 | 5/5 | walk 40 | 2218 | 0/27（NO_PATH） |
    | dig-through | 4/5 | 5502 | 5053–18137 | 5/5 | walk 40, dig 5 | 5497 | 21/27（NO_PATH×6） |
    | **digdown** | **5/5** | **14991** | 12502–15146 | **5/5** | walk 110, jump 5, down 5 | （旧场地不可比） | —— |
    | climb-ladder | 5/5 | 1922 | 1719–2050 | 5/5 | walk 40, dig 5, climb 5 | 1532 | 27/27 |
    | climb-vine | 5/5 | 1922 | 1704–2028 | 5/5 | walk 40, dig 5, climb 5 | 1614 | 27/27 |
    | water-cross | 5/5 | 33959 | 16435–66530 | 5/5 | walk 95, down 5 | 24707 | 27/27 |
    | gap-bridge | 5/5 | 7677 | 7330–12461 | 5/5 | walk 95, down 5 | 7039 | 24/27（NO_DATA×1, TIMEOUT×2） |

  - **digdown 单列：场景已修为台子横贯全场 `AZ±26`（`bench_move_actions.mjs:174`），本轮是首次有效数据，
    不与旧基线混算。`wantHit = 5/5（true）`，直方图里 `dig 5 / down 5 / jump 5` 都在 —— 场景封住了。**
    基线旧场地的 digdown 27/27 是在「她会从南北绕过去」的场地上量的，只作参考不作对照。
  - **失败归类（四类口径）**：① `down5` 5/5 NO_PATH —— `maxDrop=4` 已知边界，基线同样 0/27；
    ② `dig-through` 1/5 NO_PATH（r1 = 18137ms）—— 基线本就 21/27（78%），本轮 4/5 = 80%，同水位；
    ③ `gap-bridge` 0 失败（5/5，基线 24/27，**好于基线**）；④ **其它类：0 条**。
  - **climb-ladder 1906–2050ms，落在「约 1.5–2s」区间内**（基线中位 1532、范围 1371–1840）——
    比中位慢约 25%，见下两条口径。
  - **基线口径警告（必须与数字一起读）**：`baseline-m2.jsonl` 是 `appendFileSync` **跨多次运行累积**的混合物
    （297 行 = 27 轮，来自今晚多个不同代码状态），**不是一次干净的会话基线**。证据：`climb-ladder` 27 行里
    只有 r1–r3 三行是 21840/21947/21825ms（守卫收窄前），其余 24 行 1371–1840ms → **双峰**：
    中位 1532、平均 3862、max 21947。同病：`pillar-up2` 8 行 >12s（max 34976）、
    `gap-bridge` 2 行 TIMEOUT（60.9/63.1s）、`dig-through` r1 有 5 行 14–17.9s。
    **因此对比一律用中位数**；用平均数会得出「改后快 10 倍」的假结论。
  - **全场景一致偏慢 8%–37%（中位对比）待同环境 A/B 定量**：动作直方图、wantHit、失败结构三项与基线完全一致，
    却每个场景都慢一点（walk-flat +22%、jump-up1 +19%、down1 +12%、pillar-up2 +18%、climb-ladder +25%、
    climb-vine +19%、gap-bridge +9%、water-cross +37% 且方差极大 16–66s）。「每个场景都慢、但行为和失败结构
    一点没变」更像**服务器状态/负载**（同一台测试服连续跑了数小时，沉积实体与 TPS 漂移），不是行为回归 ——
    但**没有同会话 A/B 就只是推测**，记入「仍需真机确认」。
- [x] 5 安全检查
  - RCON 口令：`server/server.properties:46`、`server-test/server.properties:46` 各 32 字符随机值；
    `server-ip=127.0.0.1` 两处（`:54`）；`enable-rcon=true` 保留；测试服 `level-type=flat`、`server-port=25566`。
  - **口令泄露扫描**：当前口令全仓仅出现在 `server*.properties` 自身；`*.log` 里 **0 次**
    （`logs/`、`mindcraft/run-live*.log`、服务器控制台日志都查了）。残留 `localdev` 的 10 个文件
    全是注释与 `docs/legacy` 历史说明，非代码字面量 → 与 preflight `rcon-password-literal` 0 命中一致。
  - 口令**真的生效**（不是只改了文件）：用 `tools/rcon.mjs` 走 `resolveRconCreds` 实连 25576 成功返回
    `There are N of a max of 4 players online`，说明服务器已重启并接受新口令。
  - `openChat` 拦 `/`：`agent.js:519` 起，安检在「换行变空格」**之前**（防 `/op` 藏第二行）；
    `sendSlashCommand`（`:568`）是唯一出口且也过 `inspectChatText`。单测：`permissions_unit.mjs:97`（表驱动）。
  - 非 owner 的 `!newAction` 被拒：`permissions_unit.mjs:131` 走真 `executeCommand`，断言返回以 `[权限]` 开头
    且点名 `!newAction`；`:183` 另测「没配 owner 时陌生人 `!newAction` 仍不行」；
    `commandLevel` 未登记命令仍默认主人级（`:74`）。
- [x] 6 `npm test` 接线：`package.json` 加 `"test": "node tools/unit_all.mjs"`（= 不带 `--real` 的离线全量），
  实跑 **exit 0**（19/19 + 1 跳过）。

**未覆盖项 / 仍需真机确认**

1. **「全场景一致偏慢」需要一次同环境 A/B**（同一会话内先跑基线代码 3 轮、再跑现码 3 轮），否则不能排除环境。
   本轮只能给「失败结构与动作直方图未变」这个定性结论。
2. ~~A.1 的 `bot.look*` 一半**不在扫描覆盖内**（pattern 不含 look）~~
   **⚠️ 2026-11-01 captain 核实纠正：这条说错了。** `tools/preflight.mjs:295` 的 pattern
   `…|lookAt|look)\s*\(/` **已含 look**（t6 补的）—— look 是**被扫到的**，不是漏扫。
   真实情况是 `modes.js`（4 处）与 `agent.js`（1 处 `stopDigging`）属**具名豁免**，
   规则绿是因为豁免，不是因为没查。**结论仍然成立：不能按「0 命中」判这一半完成**，
   但理由必须改成"有具名豁免"，不是"pattern 不含 look"。
   其余调用方（`vision_interpreter` 3 / `skills.js` 6 / `task_follow` 1 / `atom_move` 的重复 `lookAt`）已在 t6 全部销账。
3. ~~`atom_input_inventory` 的 4 个原子（selectSlot / clickSlot / closeWindow / dropSlot）**尚未建**~~
   → **已销账（t6，2026-11-01）**：`src/agent/library/atom_input_inventory.js` 新建 4 个原子，申报 40 已写；
   `closeWindow` 转出既有 `atom_container.closeContainer`（不重写）。建前 grep 确认无存量行为
   （`clickWindow` 0 处、`setQuickBarSlot` 0 处），所以这是「补缺口」不是「改行为」。
   t8 复核：preflight 字段标准通过、错误码审计 31 个全合法、申报 1 个新增全部已批准；
   `atom_input_unit` 19 → **23 用例**（新增 4 条 inventory 用例）。
4. ~~`modes.js:43` 仍有 1 处 `setControlState('jump')`（M2 收尾或 Phase R 销账）~~
   → **已销账（t7，2026-11-01）**：改走 `atom_input_move.holdKey`。但 `modes.js` 里还有
   **4 处 `bot.look*`**（现 `:349/:351/:364/:366`）仍属 M2 残项，见「遗留清理 B」§3。
5. ~~`atom_all.mjs:71` 的 PASS 计数 +1（见第 3 条内注）~~
   → **已销账（t6，2026-11-01）**：改成只数行首 `^\s*PASS\s`，注释里写明「实测后果：显示 262 / 真实 244」。
   t8 复核：18 项显示数 = 真实数（`atom_move 10`、`skill_collect 22`、`skill_clear 11`…），
   总 **244 条真实用例、0 FAIL**。**从本轮起引用显示数不再虚高。**
6. ~~M2 的 `control.js` 只有离线覆盖（`control_reasons_unit` 35 例）；真机部分（僵尸动作 10 秒自杀并重新拉起、
   死亡捡单、任务单 deadline）**尚未在真机上触发过**，需一次人工真机演练。~~
   → **僵尸动作已真机演练（t7，2026-11-01）**：`tools/control_zombie_live.mjs` 21 条断言全过，见「遗留清理 B」§1–§2。
   **死亡捡单与任务单 deadline 仍只有离线覆盖**（依赖 M8 任务板/调度器，接上后才能真机验）。

**文档-代码不一致（只列不改，由 captain 统一收口）**

1. 本文件 `:615`（A.3）写「白名单**两层**：先问 M1 的 `SLASH_WHITELIST`，再问本文件的 SAFE(`ride`)/CHEAT(`tp`…)」，
   与最终实现**相反** —— 现在是**一张表** `permissions.SLASH_COMMANDS`（`permissions.js:217`；
   `:242 SLASH_WHITELIST = SLASH_COMMANDS` 是同一对象别名），`atom_input_misc.js` 只 `import { slashVerdict }` 问表，
   文件里已无 SAFE/CHEAT 清单。按现文档读会以为有两个真相。
2. ~~本文件 `:608`（A.1）写 `atom_input_unit`「18 用例」，实跑 **19 用例**~~ → **已修（captain 2026-11-01 改为 19）**。
3. ~~t3 报 `control_reasons_unit` 34 条，`unit_all` 实跑 **35 用例**~~ → **已核实 35 为准**（t3 报告少报 1）。

---

### 遗留清理 B：modes.js 按键收口 + D18 真机演练（2026-11-01，t7）
**目标**: 清掉 M2 的两项遗留 —— ① `modes.js` 最后一处绕开输入原子的按键；② `control.js` 的真机空白（D18）

#### 1) D18 真机演练：实测证据（`tools/control_zombie_live.mjs`，21 条断言全过）

跑法：`node tools/control_zombie_live.mjs`（父进程 spawn 子进程、自己收尸；真 mineflayer bot + 真 `ActionManager`
+ 真 `Agent`（只跳过 `start()`，于是 `requestInterrupt`/`clearBotLogs`/`cleanKill`/`isIdle` 都是生产代码）。
子进程往 stdout 打 `#EV {json}`，父进程逐条解析成断言。原始日志：`mindcraft/tmp/zombie-live.log`。

| 断言 | 实测值 |
|---|---|
| 等满 `stopWaitMs` 才动身体 | `zombie-action` 事件 `{label:"job:zombie", reason:"timeout", waitedMs:10015}`；探针 `clearControlStates` **@11955ms**（>9000 才动手，排除"秒退但恰好也调了"） |
| 松键完成 | 退出时 7 个移动键**全 false**；stop 之前 `forward=true`（"松键"不是空集） |
| `cleanKill(msg,1)` → **退出码 1** | 子进程 `exit code=1, signal=null`（不是 SIGINT/0/>1）；且必须同时满足 `reachedZombiePath`（动作在跑 + stop 被调用 + history 收到 msg）——**因为崩溃也给 1**，第一版就被这个假阳性坑过 |
| 存活 >10 秒 | `uptime=11956ms`（不撞 `agent_process.js:44-47` 的"太快不重启"保护） |
| 拉起后能干活 | 新进程 `after-alive uptime=10609ms`；跑完两条命令 `ok=true`、`executing=false` |
| 没连主服 25565 | 仪表记录的实际远端端口 `[25566]`，活 socket `remotePort=25566`；`net.Socket.prototype.connect` 钩子在 `createBot` **之前**装 |
| 收尸自证 | 演练后 `rcon list` 无 `zb*`；演练前后快照 diff 无缺失（没误踢任何人）；r1 `exit=1` / r2 `exit=0` 都收到；源码里无 `kick`/`stop` 调用 |

> **诚实边界（原文保留，别被以后读成"已完整验证"）**：本演练**没有**真的跑 `AgentProcess` 的重启循环
> （它只会 spawn `init_agent.js`，而 init_agent 依赖 mindserver + profile，本演练明确不碰 mindserver）。
> 所以「被重新拉起」是**三段事实合成**，不是观察到拉起日志：
> **(a)** 真代码产出 exit 1（演练实测）+ **(b)** 真 `agent_process.js` 对 code 1 走重启分支（源码契约断言：
> `code > 1 → process.exit` 结束任务 / `code !== 0 && signal !== 'SIGINT' → this.start(true,'Agent process restarted.')` /
> `Date.now() - last_restart < 10000` 保护）+ **(c)** 新进程能连服跑命令（实测）。
> **要变成实测，需要把 AgentProcess 真跑起来（依赖 mindserver + profile），需另行授权。**

#### 2) `modes.js` 按键收口（M2 残项销账）
- `modes.js` 自保分支里最后一处裸按键 `bot.setControlState('jump', true)` → `atom_input_move.holdKey(bot,'jump',{...})`：
  `until: 出水即松` / `timeout: 3000ms 后原子自己松、下一 tick 续（等价"一直按着"）` / `interrupt_code → 原子自己松`
  （与 D16 的 `finally` 松键同一套保证）/ WeakMap 去重（每 tick 不叠层）/ Promise 存模块作用域（不挂到 LLM 可达对象）。
- 离线用例 3 条（`control_reasons_unit` §13）：在水里按住 ✅ / 出水后自动松 ✅ / 源码里再无裸 `setControlState` ✅
  （判据**先剥注释**，否则说明文字里引用的旧代码会被当成违规）。`control_reasons_unit` 现 **38 用例**。

#### 3) 仍在的正经残项（不是遗漏，是排期）
- **`modes.js` 的 4 处 `bot.look*`**（`:349/:351/:364/:366`，`idle_staring` 的看人/随机转头）仍直调 mineflayer，
  未走 `atom_input_mouse`。`preflight` 的 `mouse-input-owner` 规则里已把 `modes.js` 列为**具名豁免**（归属 M2），
  所以扫描是绿的、但债还在。
- ~~该规则的 pattern 不含 look（只查挖/放/右键/挥击）~~ → **2026-11-01 captain 核实纠正：说错了。**
  `tools/preflight.mjs:295` 的 pattern 已含 `lookAt|look`（t6 补的）。look **是被扫到的**；
  `modes.js` 这 4 处绿是因为它在 `allow` 里具名豁免，不是因为没查。
  **结论不变：别按"0 命中"判完成** —— 理由改成"有具名豁免"，与上面 t5 §未覆盖项 2 是同一条。

### 遗留清理 C：干净基线重建 + 收口验收（2026-11-01，t8）

**为什么要重做基线**：`baseline-m2.jsonl` 是 `appendFileSync` 跨多次运行**累积**的混合物（297 行 = 27 轮，
来自今晚多个不同代码状态）。证据：`climb-ladder` 27 行里只有 r1–r3 是三行 21840/21947/21825ms（守卫收窄前），
其余 24 行 1371–1840ms → 中位 1532、**平均 3862**、max 21947（双峰）；`pillar-up2` 8 行 >12s（max 34976）、
`gap-bridge` 2 行 TIMEOUT（60.9/63.1s）。**这种文件不能当干净对照**：用平均数会得出「改后快 10 倍」的假结论。

**做法**：把 `tmp/bench/` 下 12 个旧 jsonl 全部移入 `tmp/bench/archive/`（原名 + 用途后缀，
其中混杂基线特意标成 `baseline-m2-ACCUMULATED-MIX.jsonl`），然后在**当前代码**上重跑
`node tools/bench_move_actions.mjs 5` 作为新基线。

> **基线口径（本文件今后一律按这个）**：**基线 = 新单会话 5 轮、单一代码状态、取中位数**。
> 文件：`tmp/bench/2026-11-01-move-actions.jsonl`（55 行）；控制台：`tmp/t8_baseline5.log`。

**新基线逐场景（5 轮，中位数）**

| 场景 | 通过 | 中位 ms | 范围 ms | 失败码 | 动作直方图 |
|---|---|---|---|---|---|
| walk-flat | 5/5 | 7732 | 7372–7781 | — | walk 55 |
| jump-up1 | 5/5 | 6716 | 6547–6762 | — | walk 110 |
| pillar-up2 | 5/5 | 8476 | 7518–10368 | — | walk 105, jump 5 |
| down1 | 5/5 | 6734 | 6531–6863 | — | walk 105, down 5 |
| down5 | **0/5** | 2804 | 2575–2884 | NO_PATH×5 | walk 40 |
| dig-through | 4/5 | 5628 | 5200–18846 | NO_PATH×1 | walk 40, dig 5 |
| digdown | 5/5 | 7214 | 7103–7367 | — | walk 95, down 5 |
| climb-ladder | 5/5 | 1945 | 1773–1968 | — | walk 40, dig 5, climb 5 |
| climb-vine | 5/5 | 1863 | 1721–1959 | — | walk 40, dig 5, climb 5 |
| water-cross | 5/5 | 33033 | 16803–57503 | — | walk 95, down 5 |
| gap-bridge | 4/5 | 7695 | 3967–8030 | NO_PATH×1 | walk 95, down 5 |

合计 **48/55 = 87.3%**，失败 **全部 NO_PATH ×7**（`down5` 5 + `dig-through` 1 + `gap-bridge` 1），
**无其它类失败**。与旧混杂基线（261/297 = 87.9%，同口径 5 轮期望 48.4/55）**同一水位** ——
差异在噪声内，不构成回归。`down5` 依旧是 `maxDrop=4` 的已知边界。`climb-ladder` 中位 **1945ms**（1.5–2s 内）。

**收口验收（本轮机跑，全部 exit 0）**

| 项 | 结果 |
|---|---|
| `unit_all` | **19/19 脚本通过、1 跳过、exit 0**（atom_input_unit 23、control_reasons_unit 38、permissions_unit 64、server_props_unit 29、test_escape 24、test_tunnel 38…） |
| `preflight` 默认 / `--strict-api` / `--report-api` | 三模式 **exit 0**；5 条规则各 **0 命中**；扫 **233** 文件（-`atom_boat` +`atom_input_inventory`）；申报 1 个新增全批准；字段标准通过；错误码 31 个合法；`npm test` exit 0 |
| `atom_all` 18 项 | **18/18，0 FAIL，无 `NO_CASES_RAN`**；真实 **244 条**用例（显示数已等于真实数） |
| `bench 5` | **48/55**，失败全 NO_PATH（见上表） |

**逐条复核（captain 指定的五项）**

1. **`atom_boat.js` 删除后无残留 import** ✅：文件不存在；`grep -rn atom_boat src/ tools/` 只剩 3 处**注释**
   （`atom_contract.js:28` 说明载具错误码归属、`atom_input_misc.js:9-10` 说明历史、`preflight.mjs:394` 说明判据由来），
   **零 import、零调用**。preflight 里该文件的 4 条豁免已清零。
2. **`atom_input_inventory` 字段标准与错误码合规** ✅：4 个原子都返回标准 `ActionResult`
   （`ok(data)` / `fail(code)`），错误码用已注册的 `NO_TARGET` / `WINDOW_CLOSED` / `INTERRUPTED` / `INTERNAL`，
   入口处查 `bot.interrupt_code`；preflight「字段标准：通过」「错误码审计：31 个已注册，全部合法」。
3. **`skills.js` 14 处改完后 `skill_collect` 仍 0 FAIL** ✅：`skill_collect：22 PASS / 0 FAIL`（真实 22 条）。
   另 `atom_attack：10 PASS / 0 FAIL`、`skill_clear：11 PASS / 0 FAIL`。
4. **`digdown` 的执行期证据** ✅（口径按 t6 纠正后）：干跑直方图里**本来就不该**出现 `digdown`
   —— `path_3d` 从不产出这个 key，它是 `executor.js` 的**执行期派生分支**。所以判据改成数执行期事件：
   本轮 5 轮 `execActions` 全部 `{"scan3d":2,"plan3d":2,"digdown":1}`、`digdownSeen = 5/5 = true`、
   `y −57 → −60`。**场景确实封死了**（旧场地她是绕过去的）。
5. **`control_zombie_live` 的退出码与拉起证据** ✅（引用 t7 实测，本轮未复跑）：
   `tmp/zombie-live.log` 尾部 `21 passed, 0 failed`；关键行 `子进程 exit code=1 signal=null`、
   `zombie-action {label:"job:zombie",reason:"timeout",waitedMs:10015}`、`clearControlStates@11955ms`、
   7 个移动键全 false、`r1 exit=1 / r2 exit=0`、演练后 `rcon list` 无残留。
   **诚实边界不变**：这是「退出码实测 + 源码契约 + 新进程能干活」三段合成，**不是**观察到 `AgentProcess` 拉起日志。

**三类台账（收口后）**

**A. 已销账（本轮或近期，可划掉）**

| 事项 | 销账依据 |
|---|---|
| `atom_boat.js` 冻结/豁免 | t6 直接删（零调用方），preflight 4 条豁免清零 |
| `skills.js` 14 处鼠标输入 + 6 处 `bot.look*` | t6 全部改调 `atom_input_mouse`；`skill_collect` 22/0 为回归证据 |
| `vision_interpreter` 3 / `task_follow` 1 / `atom_move` 重复 `lookAt` | t6 收口（`atom_move` 的重复实现已删，2 个测试脚本改调 `lookAtPoint`） |
| `atom_input_inventory` 缺口 | t6 新建 4 原子 + 申报 40 + 4 条单测 |
| `modes.js` 最后一处裸按键 | t7 改 `holdKey`，3 条离线用例，源码里再无裸 `setControlState` |
| `atom_all` 用例计数 +1 | t6 改 `^\s*PASS\s`，本轮复核显示数 = 真实数（244 条） |
| 僵尸动作（D18）真机空白 | t7 `control_zombie_live` 21/21（见「遗留清理 B」§1） |
| `digdown` 场景"测的是走路" | t6 修场地几何 + t8 用 `execActions`/`digdownSeen` 复核 5/5 |
| 混杂基线 double-peak 陷阱 | t8 归档旧 12 份 jsonl、重跑单会话 5 轮，口径固定为“中位数” |

**B. 待 M8（结构性阻塞，不是遗漏 —— 依赖任务板与调度器）**

| 事项 | 为什么只能等 M8 |
|---|---|
| `requeueStaleBrief()` **无生产调用方** | 全仓只有 `tools/control_reasons_unit.mjs` 调它；它要回收的是**任务板上** 60 秒内没被认领的 brief 单，板子不存在就无处可回收 |
| `applyStop()` 在 `board=null` 时空操作 | `const board = agent?.board ?? null`，写操作全在 `if (board && …)` 里；没有板子时它只算 `planStop()` 然后返回，一行都不落库 |
| 死亡捡单（`onDeath` → 8 级单） | 捡单要 `board.add(job)`；`board=null` 时只 `trace` 不落库 |
| 任务单 deadline（`jobDeadlineTimeoutMinutes` / `runJobAction`） | 计时依赖单子本身与调度器派单，无板无单可计 |
| 死亡捡单 / deadline 的**真机**覆盖 | 需先有板才能真机触发；当前只有 `control_reasons_unit` 离线覆盖 |

**C. 仍需真机（本轮做不了或没做）**

| 事项 | 现状 / 怎么补 |
|---|---|
| 「全场景一致偏慢」定量 | 本轮新基线 48/55 与旧混杂基线 87.9% 同水位、失败结构一致 → **本轮不再支持"回归"结论**；但 t5 观察到的 +8%~37% 偏慢仍需**同环境 A/B**（同会话先 3 轮旧码再 3 轮现码）才能定量 |
| `AgentProcess` 真拉起 | t7 演练明确不碰 mindserver；要变实测需跑 `AgentProcess`（依赖 mindserver + profile），**需另行授权** |
| `modes.js` 4 处 `bot.look*` | M2 残项（`idle_staring` 看人/随机转头）；`preflight` 具名豁免，扫描绿≠债已清 |
| 死亡捡单 / 任务单 deadline | 见 B 表：等 M8 有板后真机验 |
| 水/岩浆/虚空等边界地形 | `water-cross` 方差极大（16.8–57.5s），仍属不稳定场景，需要专项 |

---


### Phase R: 按层改前缀（2026-11-01 新增；时间已确认：Phase A 之后、补动作之前）
**目标**: 文件名就是层级（[`02_actions.md §5`](02_actions.md)）

- [x] R.1 新文件直接用新前缀（`act_*` / `query_*` / `flow_*` / `strat_*` / `board_*`）—— 2026-11-01 t9 完成
- [x] R.2 旧文件 `git mv`，原路径留 `export *` 转发 —— 转发行**在同一 commit 内即删**（`export * from` 全仓 0 处）
- [x] R.3 preflight 按前缀查 import 规矩；全部通过后删转发文件 —— 2026-11-01 **t10 完成规则并自证**：
  跨层 + 同层（按符号名、白名单默认拒绝）两层判据；转发文件已删（`export * from` 0 处）。
  仍留 5 处**点名违规**（含收紧后新暴露的 `act_use→openContainer`），已在下方台账逐条写清「谁 + 哪一期」。
  口径：**默认模式 exit 0**（已知违规只报告）；**`--strict-api` exit 1**（那 1 处新暴露的真问题判失败）。
  5 处销账后 strict 应恢复 0 —— 那是 Phase 5.4 / Phase R 收尾的事，不是规则的事。

**交付物**: `task_*` 前缀退役；`commands/` 不再直接 import 原子和动作

#### 改名台账（t9 / 2026-11-01 / commit `071fc74`，37 个文件）

| 层 | 新名 | 旧名 |
|---|---|---|
| 基础设施 | `contract` `modes` | `atom_contract` `task_modes` |
| 查询（8） | `query_perceive` `query_stand` `query_safe` `query_classify` `query_tree` `query_drops` `query_stuck` `query_target` | `atom_perceive` `atom_stand` `atom_safe` `atom_classify` `atom_tree` `atom_find_drops` `atom_stuck_detect` `atom_query` |
| 动作（8） | `act_dig` `act_place` `act_use` `act_container` `act_attack` `act_items` `act_climb` `act_pillar` | `atom_dig` `atom_place` `atom_use` `atom_container` `atom_attack` `atom_items` `atom_climb` `atom_pillar` |
| 导航（2） | `nav_hop` `nav_pathfinder` | `task_hop` `atom_move` |
| 流程（7） | `flow_collect` `flow_collect_plan` `flow_follow` `flow_pickup` `flow_platform` `flow_escape` `flow_clear` | `task_collect` `skill_collect` `task_follow` `task_pickup` `task_platform` `skill_escape` `skill_clear` |

**保留旧名但符合映射表**（不是漏改）：`atom_input_move/mouse/misc/inventory`、`atom_read`、`atom_look`、
`atom_wait`、`atom_wait_item` —— 02 §5 的原子层那一行就是这些名字。`skill_library`（04 §173：上游已占名，改不得）。
`nav_core` / `executor` / 规划器 / `step_runner` / `trace_bus` / `terrain3d` —— 基础设施或导航保留原名（02 §5 明列）。

**核对结果（t10 独立复核）**：`export * from` 转发 **0 处**；28 个旧名逐个 grep **0 悬空 import**；
`preflight` **94/94 模块导入成功**；`nav_core`/`nav_hop`/`nav_pathfinder` 三件齐全。

**转发文件删除点**：转发行是 t9 分 5 批加的，**在同一提交 `071fc74` 内一次性删净**（`library/` 92 → 65 个文件）。
判据：`grep -rn "^export \* from" src/agent/library/` = **0**（t10 复核）。另 `audit_rules.mjs` 已改成
「只有 `export *` 的转发文件不算新模块」，免得删干净后仍按旧规则报"未申报"。

**仍用旧名 / 无前缀的文件与理由**（逐个核过，不是漏改）：

| 文件 | 为什么不动 |
|---|---|
| `skill_library.js` | **上游已占名**（[`04_skills.md:173`](04_skills.md)），改名会和上游冲突 |
| `skills.js` | **上游原函数库**（mindcraft 自带），不属于本次分层重构范围；Phase 5 才逐步退役 |
| `nav_core` `executor` `path_3d` `terrain3d` | t9 任务书**明确批准保留原名**（导航/基础设施的中枢，改名收益低、风险高） |
| `contract` `step_runner` `trace_bus` `modes` | 02 §5「不带前缀」那一行的基础设施（`contract`/`modes` 是本次改出来的新名） |

**偏离映射表的地方（t10 列出，供后续收口）** —— 下面这些**无前缀但不是纯基础设施**，
02 §5 的「…」给了口子，但严格说该有前缀：

| 文件 | 实际层 | 建议 | 归属 |
|---|---|---|---|
| `path_short.js` | 导航（短规划） | **死代码**（REFACTOR §附录「死代码」列为整文件删除）→ 直接删，不必改名 | Phase R 收尾 |
| `map_query.js` | 查询（`!map` 的地形查询） | 应 → `query_map` | Phase R 收尾 |
| `collect_targets.js` | 查询（`resolveCollectTarget` 是解析/查询） | 应 → `query_collect_targets` | Phase R 收尾 |
| `collect_planner.js` | 流程（采集前的侦察与规划） | 应 → `flow_collect_planner`（与 `flow_collect` 合并时一并处理） | Phase R 收尾 / M7 |
| `tool_prep.js` `scaffold_blocks.js` `scaffold_cleanup.js` | 动作/流程辅助 | 建议随「垫脚」链路整体挪进 `flow_*` | Phase R 收尾 |
| `control.js` | M2 控制层（07 control） | 02 §5 表里没有这一层；**建议在 02 §5 补一行 `control_*` 或明确归基础设施** | 规范补齐 |

> 以上都不是 M4 的验收缺陷：t9 的任务范围是「旧前缀退役 + 转发删除 + import 规矩」，
> 这些文件**本来就不带旧前缀**（`task_`/`skill_`/`atom_`），所以不违反「旧前缀退役」这条。

#### M4 验收结论（t10 / 2026-11-01，真机实测）

| 项 | 结果 |
|---|---|
| 旧前缀退役 | ✅ `library/` 里 `task_*` / `skill_*` 只剩 `skill_library`（上游占名）；`atom_*` 剩 9 个，全部是 02 §5 明列的原子层名字 |
| 转发文件 | ✅ `export * from` **0 处**（删除点 `071fc74`） |
| 悬空 import | ✅ 28 个旧名逐个 grep 0 处；`preflight` **94/94 模块导入成功** |
| 新名合规 | ✅ `query_*` 8 / `act_*` 8 / `flow_*` 7 / `nav_*` 3，全部对上 02 §5；6 处无前缀偏离已列上表 |
| `commands/` 不许碰动作与原子 | ⚠️ **1 处豁免**：`commands/actions.js:8 → act_place.placeBlockAt`（Phase 5.4 销账，见「已知前缀违规 5 处」#1）。grep `src/agent/commands/` 里 `act_`/`atom_` 的真实 import **仅此 1 条** |
| 前缀规矩能抓违规 | ✅ 五次注入实测（见「前缀规矩」节）：同层副作用**红**、同层纯工具**绿**、跨层**红**、注释**绿**、字符串**绿** |
| `unit_all` | ✅ 19/19 + 1 跳过，exit 0 |
| `preflight` 三模式 | ✅ 默认 **exit 0**（5 处违规）/ `--strict-api` **exit 1**（第 5 处新暴露判失败）/ `--report-api` **exit 0** —— 与台账口径一致 |
| `atom_all` | ✅ **18/18，244 条真实用例 0 FAIL**，无 `NO_CASES_RAN`。`skill_collect`（=`flow_collect_plan`）**22 PASS / 0 FAIL**；`atom_attack`（=`act_attack`）**10 PASS / 0 FAIL**；`skill_clear`（=`flow_clear`）**11 PASS / 0 FAIL** —— 改名后真机链路通 |
| `bench 5` | ✅ **48/55**，与 t8 干净基线 48/55 持平；`climb-ladder` 中位 **1956ms**（基线 1945ms，+0.6%）；`digdown` 5/5 `execActions={"digdown":1}`、`y −57→−60` |
| `task_collect`+`skill_collect` 合并 | ❌ **未合并**（只改名成 `flow_collect` + `flow_collect_plan`）。合并待办见「待办 4」：`flow_collect` 内部化 `planCollect`/`makeHandlers` |

**bench 待修：gap-bridge 会产出一轮假失败 —— 真因是死亡重生，不是 tpFlake**（**已修 `74eb3f5`**）

`gap-bridge #1`：`moved 11456.7` 格、`remain 11473.1`、`60364ms TIMEOUT`、`execActions {"scan3d":10,"plan3d":10}`；
同场景 #2–#5 全部 `moved 19.8 / remain 0.5 / ~7.7s`。

> ⚠️ **t10 当时的定性是错的。** t10（及 t9）都归因成"`arena.tpSafe()` 有洞、传送没生效"，
> 并据此写下"应在 `tpSafe` 失败时 skip"的修法。
> **captain 实测更正**：服务器日志有 `[23:48:12] ma67453 fell out of the world` ——
> **她掉进虚空摔死了**，重生在出生点 (0,0)，于是 `walkTo` 从出生点往 10000 格外走。
> tp 明明生效了，不是传送问题。**"她不在起点"≠"传送失败"**，中间还有"跑着跑着死掉"这一类。
>
> 教训：只看"结果位置不对"就推断原因，会得出方向错误的修法。
> **查服务器日志 30 秒能定性的事，不要靠推测。**

**实际修法（`74eb3f5`）**：
1. **场景层（根因）**：`gap-bridge` 原来把地面挖到 `G`，而 `G` 下面是虚空 →
   沟底补一层实心（`G-3`）。掉下去只是"困在坑里"这种正常失败，不会死、不会重生。
2. **兜底检测**：位移 >200 格或剩余 >256 格即判"死亡重生"，单列 `⊘` 并**排除出通过率分母**
   （场地最大跨度 ~56 格，200 格不可能是场景内正常移动）。

**验证**：修前 `61s TIMEOUT / 剩 11484`；修后 **PASS 12059ms / 剩 0.7 格**，死亡日志无新增。

**另：bench 归档纪律**（今晚两人各犯一次，已写进文件头）
`bench_move_actions.mjs` 是 `appendFileSync`，跑之前必须 `mv` 上一次的 jsonl 到 `archive/`，
否则基线和新数据混进同一文件（实测出现过 110 行 = 两轮各 55 行）。

#### 前缀规矩：判据与白名单（t10 实现，2026-11-01）

**判据**（`tools/preflight.mjs` 的 `[5/5]`，两层）：

1. **跨层**：按文件层判（`PREFIX_IMPORT_ALLOW`，照抄 02 §5 那张表）—— 原有的那一半，未改动。
2. **同层**（`act_*`→`act_*`、`query_*`→`query_*`）：**按 named import 的符号名判**。
   **一份白名单 + 默认拒绝**：符号 ∈ `PURE_SIBLING_IMPORTS` → 放行；**其余一律违规（含不认识的符号）**。
   因此 `digBlock` / `placeBlockAt` 这些副作用入口**不需要黑名单** —— 不在白名单里就自然违规。
   非具名形式（`import * as ns` / default import）**一律违规**：审计不了调的是哪个函数。

**白名单**（`PURE_SIBLING_IMPORTS`，每个都写清"为什么纯读/纯判断"；新增必须显式加 + 说明为何不搬去 `query_*`）：

| 符号 | 出处 | 为什么放行 |
|---|---|---|
| `findItem` | `act_items` | 查"包里有没有这个物品、在第几格"：只读 inventory，不动手（**待办 2 搬 `query_items` 后从名单删**） |
| `countItem` | `query_perceive` | 数"某物品有几个"：只读 inventory |
| `containerKindOf` | `act_container` | 判"这个方块名对应哪类容器"：查 registry + 正则，纯判断 |
| `windowItems` | `act_container` | 列"当前窗口有哪些格子/物品"：读 `bot.currentWindow` 快照，纯读 |
| `isDiggable` | `act_dig` | 判"这类方块能不能挖"：查不可挖表，纯判断 |
| `canDigWithInventory` | `act_dig` | 判"手上工具够不够挖它"：查背包 + 工具等级，纯判断 |
| `nearestAttackable` | `act_attack` | 找"最近的可攻击目标"：只遍历 entities 比距离，**不挥击** |
| `blockAt` | `query_perceive` | 读"那一格是什么方块"：一次世界查询 |
| `findBlocks` | `query_perceive` | 找"符合名字的方块都在哪"：一次世界查询 |
| `canStand` | `query_stand` | 判"那一格能不能站人"：读脚下/头顶，纯判断 |

> 判据只跑在**剥掉注释后**的代码上（`maskJsSource`）—— 文档注释里提到 `digBlock(bot,pos)` 不算违规
> （`atom_boat` 那次注释假命中的教训）。已实测：注释里写 `import { digBlock } from './act_dig.js'` → 绿。

**当前模式（写清楚，别猜）**：

| 模式 | 行为 | exit |
|---|---|---|
| 默认 `node tools/preflight.mjs` | 已知违规只报告；**白名单外符号违规随时判失败**；「收紧后新暴露」的 1 处（见下）**只报告** | **0** |
| `--strict-api` | 同上 + 「收紧后新暴露」**也判失败** | **1**（当前期望值） |
| `--report-api` | 只报告 | 0 |

为什么这么分：那 1 处是**真问题**，不能塞进白名单（塞进去规则就又是纸做的），
但也不该让日常开机天天红着、红久了就会有人顺手加白名单。所以**默认只报告、strict 判失败**。

**五次注入自证（t10 实测，在独立 worktree 做，不污染主仓 src；全部在 HEAD `ad5956f` 上重跑过）**

| # | 注入 | 期望 | 实测 |
|---|---|---|---|
| 1 | 同层副作用：`act_pillar.js` 加 `import { digBlock } from './act_dig.js'` | 红 | ✅ `✗ 新违规 act_pillar.js:22 act → act [符号 digBlock]`，**exit 1** |
| 2 | 同层纯工具：`act_pillar.js` 加 `import { findItem } from './act_items.js'` | 绿 | ✅ 无新违规，**exit 0** |
| 3 | 跨层：`commands/actions.js` 加 `import { digBlock } from '../library/act_dig.js'` | 仍红 | ✅ `✗ 新违规 commands → act`，**exit 1** |
| 4 | 注释干扰：`act_pillar.js` 注释里写同一条 import | 绿（不误判） | ✅ **exit 0** |
| 5 | 字符串干扰：`const MSG = "import { digBlock } from './act_dig.js'"` | 绿（剥字符串） | ✅ **exit 0** |

**改动前**（`071fc74` 里的旧判据）同一条 #1 注入是 **exit 0**（检查条数 256→257 扫到了，违规数不变）——
即「同层一律放过」，那条规矩等于纸做的。根因就一行 `if (targetLayer === selfLayer) { checked++; return; }`。

#### 已知前缀违规 5 处（点名 + 谁 + 哪一期）

| # | 位置 | 层间 | 为什么现在动不了 | 销账归属（谁 + 哪一期） |
|---|---|---|---|---|
| 1 | `commands/actions.js:8` → `act_place` | commands → act | 命令层直接 import `placeBlockAt`（02 §5 原文点的就是这处） | **atoms / Phase 5.4**：改调流程（如 `flow_build.placeOne`），commands 只碰流程/查询 |
| 2 | `atom_read.js:16` → `query_perceive` | atom → query | `atom_read` 转出 `findBlocks`（真身在查询层） | **atoms / Phase R 收尾**：`findBlocks` 实现搬进 `atom_read`，`query_perceive` 反向复用 |
| 3 | `atom_read.js:17` → `act_container` | atom → act | `atom_read` 转出 `windowItems`（真身在动作层） | **atoms / Phase R 收尾**：`windowItems` 是纯读取，搬进 `atom_read`，`act_container` 反向复用 |
| 4 | `atom_input_inventory.js:18` → `act_container` | atom → act | `closeWindow` 转出 `closeContainer`（避免两份实现） | **atoms / Phase R 收尾**：`bot.closeWindow` 那层搬进 `atom_input_inventory`，`act_container` 反向复用 |
| **5** | **`act_use.js:15` → `act_container.openContainer`** | **act → act（副作用）** | **收紧同层规则后新暴露**：动作调动作的副作用入口（真开窗、改世界状态）。**不许进白名单** | **atoms / Phase 5.4 或补动作时**：容器交互走 `flow_store`/`flow_fetch`，`act_use` 只做"右键这一下"；或把"开窗"下沉成 `atom_input_inventory.openWindow`。修完删 `TIGHTENED_NEW_VIOLATIONS` 那条，strict 必须恢复 exit 0 |

> 前 4 条的病根是同一件事：**纯读取的实现住进了 `act_*`，原子层只好反向 import**。
> 第 5 条不同：那才是真正的**分层违规**（动作调动作的副作用），所以它单独占一档、默认只报告但 strict 判失败。

#### 待办（必须销账，不许变永久放宽）

1. **`act_items` 的只读工具搬去 `query_items`**（归属：**atoms / Phase R 收尾**）——
   `findItem` / `countItem` / `hasItem` 是**查询**（"包里有没有/有几个"），住在 `act_items` 才逼得 `act_dig`、`act_place`
   必须 import 兄弟层。**搬完才能把同层白名单收回到"动作之间零 import"**，并把 `findItem` 从 `PURE_SIBLING_IMPORTS` 删掉。
2. **`atom_tunnel.js` 拆分**（归属：**atoms / Phase R 收尾**）—— 02 §5 把 `atom_tunnel.tunnelStep` 归 `flow_*`，
   但它是**混合文件**：纯查询 `computeSafeZone` / `inSafeZone` / `checkStep` / `findDryClimbColumn`
   + 多步复合 `tunnelStep`（只被 `flow_collect_plan.js` import）。正确处置是**拆**（查询进 `query_*`、`tunnelStep` 进 `flow_*`），
   不是改名 —— 只改名会把查询拖进流程层，所以 t9 没动它。**必须留账，不能当"已改名完成"。**
3. **`act_use → openContainer` 销账**（归属：**atoms / Phase 5.4**）—— 见上表第 5 条。
4. **`flow_collect` 与 `flow_collect_plan` 未合并**（归属：**atoms / Phase R 收尾 或 M7**）——
   `task_collect`+`skill_collect` 是同一件事的两半，合并要改语义（`flow_collect` 内部化 `planCollect`/`makeHandlers`），
   改名安全、合并另开。

---

### 动作补齐（2026-11-01 新增）
**目标**: 43 个动作（[`02_actions.md §3`](02_actions.md)），21 个复用或拆分、22 个新写

> 🔴 **M6 的第一件事（阻塞性，不是建议）**：把 `02_actions.md §4` 的 **7 个新码加进
> `contract.js` 的 `CODES`**：
> `CLAIM_CONFLICT` / `INVENTORY_FULL` / `LEASE_LOST` / `NOT_READY` / `NO_RECIPE` /
> `NO_WORKSTATION` / `PREEMPTED`。
>
> **依据（M5 实测）**：M5 建了 `composite_registry` 的 manifest 启动校验，`codes` 字段里
> 引用未注册的码会**模块加载即 throw**。t11 就当场撞上：
> `[collect] codes 里的 INVENTORY_FULL 没在 CODES 注册` → 启动崩。
> 所以：**不先注册这 7 个码，M6 的任何流程/动作一写就启动失败**。
> 未注册状态下不要把它们写进任何 manifest 的 `codes`。

- [x] 先把 7 个新错误码加进 `CODES`（`02_actions.md §4`） ← **M6 完成（`1976cb6`）**：`CODES` 现 **38 个**（t14 复核：`sed -n '/export const CODES/,/\];/p'` 计数 = 38，且 11 个动作用到的 13 个码全部在册）
- [x] P0（P0 流程要用）：`craftOnce` `furnaceLoad` / `furnaceCollect` `eat` `equip`（补护甲槽校验）`deposit` / `withdraw` `attackOnce` `harvestCrop` `plantSeed` `tillSoil` —— **M6 完成（`2cfc43f`），t14 逐条验收见下**
- [x] P1：`sleepInBed` / `wake` / `fishOnce` / `feedEntity` / `tradeOnce` / `toggleBlock` / `boneMeal` / `swimStep`（05 末节）—— **8 个动作已完成（`9c8c7a2`）**，32 条离线用例
- [ ] P1 的 `stepInto`：**动作本体已交付、接入两次失败后回滚**（详见下面「`stepInto` 接入失败调查」）
- [ ] P2：`brewOnce` `enchantOnce` `anvilCombine`；其余（盾、弓、投掷、剪毛、挤奶、拴绳、载具）按流程需要再补 —— **未做**

#### `stepInto` 接入失败调查（2026-11-02，两次尝试都回滚）

`act_step.js` 本体（102 行 + 用例）**已交付并保留**，但**没有接进 `executor`**。
`executor.js` 当前与 HEAD 逐字节一致；回滚后 bench 复跑确认 **49/55**（与基线一致）。

**收益是真的**：第一次接入时前 31 条明显变好，`dig-through` **8368ms → 4269ms**
（`执行={"step-into":14}`），`digdown #1` 正常且仍有 `digdown:1`。

**但两次都在 `digdown #2` 卡死**（13 分钟无进展，进程活着、无日志）。

| 尝试 | 判据/门槛 | 结果 |
|---|---|---|
| 第一次（atoms） | `until` = 到格心水平 ≤0.5 | `digdown #2` 卡死 13 分钟 |
| 第二次（captain） | 改成"脚位格子 == 目标格"（`insideCell`，三轴都比）+ 返回前后置复核 | **仍卡死**（31 行 = 卡在 `digdown #2`）|
| 第三次（captain） | 再加门槛：**只处理同一层**（`targetFeetY === nowFeet`）| **仍卡死**（同样 31 行）|

**被证伪的假设**（别再重复走）：
- ❌ "谓词太宽导致假成功" —— 换成 `insideCell` 精确判据后照样卡
- ❌ "不该用于不同高度（走出盖板边缘掉下去）" —— 加 `sameLevel` 门槛后照样卡

**仍未被证伪的方向**（下一轮从这里查，别再从头猜）：
1. **`holdKey('forward')` 的超时/中断路径是否真的松键**。若某次失败后 forward 仍被按住，
   她会持续移动 → 位置一直变 → walkTo 永远重规划。查法：卡住时 `rcon data get` 位置、
   或临时在 `stepInto` 的 finally 里打日志确认 `setControlState('forward', false)` 真发出去。
2. **`lookAtPoint` 失败是否静默继续**。视线不对时 forward 会朝错方向走。
3. **`digdown` 场景本身的特殊性**：她站在 1 格厚盖板上，`down` 之前那步 `walk` 的
   目标格可能就在盖板边缘 —— 任何"按 forward"的动作都可能把她推下去。
   查法：在 `digdown` 场景里打 `step-into-fallback` 事件计数（现在 `execActions` 里有，
   但默认不打印），看是不是每轮都在 fallback。

**接入前必须具备的护栏**（比判据更重要）：
- `stepInto` 的 `finally` 必须**无条件** `releaseAll`，且要有用例锁住"超时后键已松"
- 卡住检测：若连续 N 次 `step-into-fallback` 且位置未变，直接返回 `STUCK`，不要继续重规划
- 只在**位置真的变了**之后才让 walkTo 的 `stalled` 计数归零

> 注：P1 里"换 `stepInto` 之前先跑基线"的基准数已更新为**新干净基线 49/55（89.1%）**
> （2026-11-01 `gap-bridge` 修好之后重建；旧 99/110 那套是跨多次运行累积的混合物，已废弃）。

#### M6 P0 验收记录（t14 / 2026-11-02，全部实测）

> 🔴 **M6 起新增的验收项（2026-11-02 由 t17 真机抽验的教训得出，务必执行）**
>
> **「每个动作的后置判据，在真机上到底读不读得到？」**
>
> 起因：`act_attack.attackOnce` 的后置判据是"被打的血量下降了"，而
> **mineflayer 默认不暴露生物血量** —— `entity.health` 对僵尸/牛是 `undefined`（只有玩家有）。
> 于是判据永远不成立，每次挥击都被判"挥了但没掉血"，`flow_fight` 一拳也打不出去。
>
> 这个 bug **离线假 bot 永远发现不了**（假 bot 的 `entity.health` 是我们自己给的），
> **bench 也发现不了**（`bench_move_actions` 不碰 fight/mine 路径）。所以它一路绿灯活到真机抽验。
>
> **从 M6 起，每个动作的验收必须多问一句**：它的后置判据读的是**引擎真的提供的**数据吗？
> 如果是"读不到"的情况，动作必须如实返回（如 `ok({damaged:null, verified:false})`），
> **不许把"读不到"当成"没发生"**（那会谎报失败），也不许当成"发生了"（那会谎报成功）。
>
> 同类已修案例：`equip` 读不到护甲槽 → `ok + verified:false`；
> `vine_physics.installed` 查不到藤蔓 → `installed:false` 且 `isClimbing()` 恒 false；
> `flow_fight.enemiesLeft` 数不到 → `null` 而不是 `0`。

**① 11 个动作清单 + 失败码（每一条都实测过返回形态）**


| 动作 | 文件 | 用到的失败码 | 关键语义（为什么是这些码） |
|---|---|---|---|
| `craftOnce` | `act_craft` | NO_RECIPE / NO_ITEM / NO_WORKSTATION / NO_TARGET / INTERRUPTED / INTERNAL | `NO_RECIPE`=永远做不了（补料也没用）；`NO_ITEM`=补齐材料能续；`NO_WORKSTATION`=放个工作台就能做 —— 三种上层的处置**完全不同** |
| `furnaceLoad` | `act_craft` | OUT_OF_REACH / NO_ITEM / **OCCUPIED** / NO_TARGET / INTERRUPTED / INTERNAL | 够不着 → `OUT_OF_REACH`（走近就行，**不是** `NO_WORKSTATION`「没熔炉」）；输入槽被别人占 → `OCCUPIED` |
| `furnaceCollect` | `act_craft` | NOT_READY / OUT_OF_REACH / INVENTORY_FULL / NO_TARGET / INTERRUPTED / INTERNAL | 还没烧完 → `NOT_READY`（等一会，不是 `TIMEOUT`）；背包满 → `INVENTORY_FULL` |
| `harvestCrop` | `act_farm` | **NOT_READY** / NO_TARGET / TIMEOUT / INTERRUPTED | 没熟 → `NOT_READY` 带 `age/maxAge`（**不是 `BLOCKED`**：BLOCKED 是"路被挡"，这里是"还没长好"，上层应等而不是换目标） |
| `plantSeed` | `act_farm` | OCCUPIED / NO_ITEM / NO_TARGET / BLOCKED / INTERRUPTED / INTERNAL | 那格被占 → `OCCUPIED`（换一格）；脚下不能种 → `BLOCKED` |
| `tillSoil` | `act_farm` | NO_TOOL / NO_TARGET / … | 手上没锄 → `NO_TOOL`（提示"去拿工具"，与"没材料"方向不同） |
| `eat` | `act_items` | NO_ITEM / NOT_READY / INTERRUPTED / INTERNAL | 饱食度满 → `NOT_READY`（别浪费食物） |
| `equip` | `act_items` | NO_ITEM / NO_TARGET / INTERRUPTED / INTERNAL | 读不到护甲槽时 **`ok()` + `verified:false`**（不假装验证过） |
| `deposit` / `withdraw` | `act_container` | WINDOW_CLOSED / NO_ITEM / INVENTORY_FULL / NO_TARGET / INTERRUPTED / INTERNAL | 窗口没开 → `WINDOW_CLOSED`（先开箱，不是"没目标"） |
| `attackOnce` | `act_attack` | **NOT_READY** / OUT_OF_REACH / NO_TARGET / BLOCKED / INTERRUPTED / INTERNAL | 冷却没好 → `NOT_READY` + `waitMs`（**不是 `TIMEOUT`**：TIMEOUT 是"这次操作超时了"，冷却是"等一下再挥就行"，上层不该重试整段） |

**契约核对（机械 + 动态双证）**

- **静态**：11 个动作函数体里每个 `return` 都是 `ok(...)` / `fail(...)`，**没有裸 boolean / 对象字面量**；
  `fail('CODE'` 用到的 **13 个码全部在 `CODES`（38 个）里**。
- **动态**：用"敌对 stub"（没背包/没窗口/没 registry/不给 dig+placeBlock）逐个调用 11 个动作 →
  **11/11 返回 `Object.isFrozen` 的 ActionResult**、`ok` 是 boolean、`code` 合法、**没有一个抛异常**：
  `craftOnce→NO_RECIPE` / `furnaceLoad→NO_TARGET` / `furnaceCollect→NO_TARGET` / `harvestCrop→NO_TARGET` /
  `plantSeed→NO_TARGET` / `tillSoil→NO_TARGET` / `eat→NOT_READY` / `equip→NO_TARGET` /
  `deposit→WINDOW_CLOSED` / `withdraw→WINDOW_CLOSED` / `attackOnce→NO_TARGET`。

**② `furnaceLoad` 的 OCCUPIED 保护（captain 抓的真回归）—— 独立用例 15/15**

我**自造了与 atoms 用例不同的预置状态**（熔炉里烧的是第三种物品 `raw_copper`，我放 `raw_gold`），双向都验：

| 场景 | 期望 | 实测 |
|---|---|---|
| 熔炉里是别人在炼的**第三种**料 | `OCCUPIED` + 零放料 | ✅ `OCCUPIED`，`putInput`/`putFuel` **各 0 次**，`occupantNow='raw_copper'`、`count=7`，窗口已关 |
| 熔炉里是**同种**料 | 正常续料 | ✅ `ok`，`putInput`+`putFuel` 各 1 次（**没误判 OCCUPIED**） |
| 输入槽空（`inputItem()` 返回 null） | 放行 | ✅ `ok` |
| 输入槽空、但 `slots[0]` 有货（fallback 路径） | 拦住 | ✅ `OCCUPIED`、零放料 |
| 读输入槽**抛异常** | 当"没有"处理，不崩不误判 | ✅ `ok`、放料 1 次 |
| 槽里同种但 `count=0` | 不算占位 | ✅ `ok` |
| 只有**燃料槽/输出槽**有货、输入槽空 | 不算占位 | ✅ `ok` |

**③ `skills.js` 胶水层兼容（防连锁崩）**

- `craftRecipe` / `smeltItem` / `consume` **仍返回严格 boolean**（实测 `typeof out === 'boolean'`，
  三条路径都返回 `false` 而不是对象）。
- **内部确实改调新动作**（不是两套实现并存）：
  `craftRecipe` → `craftOnce`（`return crafted.ok`）；`smeltItem` → `furnaceLoad` + `furnaceCollect`；
  `consume` → `act_items.eat`（`import { eat as eatAction }`）。
- **上游调用点行为没变**：`commands/actions.js:359/495/506`（`!consume` / `!craftRecipe` / `!smeltItem`）、
  `npc/item_goal.js:160/168` 全部 `await` 后按 boolean 用，没有一处期待 ActionResult。
- **最关键的一处兼容**：`skills.js:5079` 有短路用法
  `have = (await craftRecipe(bot,'chest',1)) && countInventoryItem(bot,'chest') > 0`。
  如果 `craftRecipe` 改成返回 ActionResult **对象**，`&&` 会永远为真 → 静默行为变化。
  实测它仍返回 boolean，**短路语义安全**。

**④ 动作层规矩**

- **动作之间不互相调用**：`grep "from './act_"` 只剩 3 条，全部合规 ——
  `act_dig → act_items.findItem`、`act_place → act_items.findItem`（白名单纯工具）；
  `act_use → act_container.{openContainer, containerKindOf}` 是**已入册的第 5 处**（`TIGHTENED_NEW_VIOLATIONS`）。
- **不自己拼 map 路径**：`grep 'bots/${' src/agent/library/act_*.js` = **0** ✅
  （`7722b1f` 把 mapDirOf 真正落地了，11 处硬编码收成一处 —— t12 报的 M5 遗留 1 已销账）
- **前缀规矩 0 新增违规**：preflight 仍 **5 处**（4 旧债 + `act_use→openContainer`），`--strict-api` exit 1（预期）。

**⑤ 真机回归（t14 独立跑）**

- `unit_all` **21/21 + 1 跳过**，exit 0
- `preflight` 默认 **exit 0** / `--strict-api` **exit 1**（Phase 5.4 旧债，未修绿）/ `--report-api` exit 0；模块 **97/97** 导入
- `atom_all` **17/18** —— `vine_physics_test` 崩了 1 条，**判定为偶发，非回归**，见下方 ⑥
- `bench 5` → **49/55（89.1%）**，与基线 49/55 一致；失败全 `NO_PATH ×6`（down5×5 + dig-through r1）；
  `climb-ladder` 中位 **1947ms**；`digdown` **5/5** `digdownSeen=true`、`execActions={"digdown":1}`、`y −57→−60`

**⑥ `vine_physics_test` 偶发的根因（已定位，属测试脚手架问题、不是 M6 回归）**

现象：整轮里 `爬藤蔓: 升高 0.00 格，前进 2.20 格` → FAIL；单跑 **3/3 全过**（升高 6.47 / 6.59 / 6.82）。
关键观测：**前进距离通过/失败两种情况下都是 2.20**（她走到藤蔓柱、被挡住停下，位置对），**只有 `dy` 不同**
→ 不是"没走到"，是**爬升没被激活**。

根因（实测证明）：`src/sim/vine_physics.js` 在 `vineIds.size === 0`（**注册表里查不到藤蔓**）时
**静默返回一个空壳** `{ setClimbing(){} , isClimbing(){return false} , uninstall(){} }` ——
我实测：这种情况下 `setClimbing(true)` 之后 `isClimbing()` **仍是 false**，而且**返回对象里没有任何
`installed`/`ok` 标记**能让调用方察觉。测试只断言了"藤蔓方块就位"（`blockAt` 读到 vine），
**从没断言补丁真的装上了** → 注册表未就绪时，失败会伪装成"爬不上去"。

**建议（待办，属测试脚手架）**：`installVinePhysics` 失败时返回 `installed:false`（或直接 throw），
测试在"爬模式"前断言 `vine.isClimbing() === true`；另 `pushInto` 里的 `TP` 是**未校验的裸 RCON**
（和第 3 次 bench tpFlake 同源），建议加"传送后确认坐标"再开始推。

**⑦ 已知偏差 / 待办**

1. **`harvestCrop` 后置失败用 `TIMEOUT` 语义不准**（归属：`atoms` / M7 前收口）——
   实测：熟了、`dig` 成功返回但方块还在 → `fail('TIMEOUT', '收了但 wheat 还在')`，
   可**并没有超时发生**（`holdDig` 已 ok）。`CODES` 里现成有 `DIG_FAIL`（"挖了但没生效"）更贴切。
   上层看到 `TIMEOUT` 会"加时间重试"，而真相是"挖不动"（保护区域/工具不对）。
   现有单测只断言了 `NOT_READY` 与 `NO_TARGET` 两条，**这条路径无覆盖**。
2. **`walk-flat` 干跑动作数从 11 变 23**（观察项，非失败）——本轮 5 轮每轮都是 `{"walk":23}`，
   通过率 5/5、中位 7781ms（上轮 7594ms）都没变。数值翻倍但行为没变，先记着，若后续导航改动再对照。

---

### 复合技能（2026-11-01 新增）
**目标**: 24 个流程 + 6 个策略，另有 4 个 P2 策略（[`04_skills.md`](04_skills.md)）

- [x] 现有 6 个流程补 manifest 和 ctx —— **M5 完成（2026-11-02，t11）**：5 个流程有 `manifest` + 走 `makeCtx`；
  `flow_collect_plan` / `flow_clear` 不补 manifest（见下「为什么只登记 5 个」）
- [x] 注册表 + `!do` / `!listSkills`（顺手修 D24）—— **M5 完成（2026-11-02，t11）**，t12 逐条实测见下
- [ ] P0 流程：craft → smelt → store/fetch → eat → mine（D15 已修）→ farm → fight → build
  - ⚠️ **M6 第一件事：先把 `02 §4` 的 7 个新错误码加进 `contract.js` 的 `CODES`**（见下「M6 阻塞前置」）
- [ ] 策略：`strat_obtain` → `strat_tool_tier` → `strat_first_night`；其余等任务板 B2

#### M5 验收记录（t12 / 2026-11-02，全部实测，不读码猜）

**① 注册的技能名清单（5 个，不是任务书的 6 个）**

`collect` / `follow` / `pickup` / `platform` / `escape`。
各自 manifest 的关键字段（实测读出来）：

| 技能 | level | timeoutMs | params | codes |
|---|---|---|---|---|
| collect | flow | 480000（→8 分钟） | block / count / radius | NO_TARGET NO_TOOL NO_PATH NO_REACH OUT_OF_REACH STUCK TIMEOUT INTERRUPTED |
| follow | flow | 1800000（→30 分钟） | player / distance | NO_TARGET NO_PATH NO_REACH STUCK TIMEOUT INTERRUPTED |
| pickup | flow | 180000 | at / radius | NO_TARGET NO_PATH TIMEOUT INTERRUPTED |
| platform | flow | 600000 | item / at | NO_ITEM NO_TARGET OCCUPIED OUT_OF_REACH NO_SUPPORT TIMEOUT INTERRUPTED |
| escape | flow | 120000 | timeoutMs | NO_TARGET NO_TOOL STUCK NO_ITEM TIMEOUT INTERRUPTED |

**为什么只登记 5 个**（不是漏了 `flow_collect_plan` / `flow_clear`）：按 §4.4，
manifest 描述的必须是「能执行并返回 ActionResult 的技能」。
`flow_collect_plan` 只导出 `planCollect` / `makeHandlers`（纯规划），`flow_clear` 只产出"清障碍"的步骤序列、
由 `flow_collect` 拼进自己的 plan —— **两者都没有 `run()`，也没有独立执行入口**。
把它们登记进表 = 把内部实现当能力暴露给模型（模型会 `!do collect_plan` 去打一个只返回计划的函数）。
补 `run()` 属于**新能力**，不在 M5（改名/注册表）范围。文件里 39–40 行已把这个理由写成注释。

**② manifest 校验行为：模块加载即 throw（实测四种坏法，逐个隔离测）**

| 坏法 | 实测结果 |
|---|---|
| 删掉 `summary` | ✅ 加载即抛 `[pickup] summary 缺失（给模型看的一句话，不能空）` |
| `params` 改成字符串 `"nope"` | ✅ `[pickup] params 缺失或不是对象` |
| `params.radius` 区间写反 `int 32..1` | ✅ `params.radius 的区间写反了或读不出` |
| `codes` 加未注册的 `INVENTORY_FULL` | ✅ `codes 里的 INVENTORY_FULL 没在 CODES 注册` |

注册表级（同一条 `validateRegistry` 路径）：缺 `run()` / `run:42` / 名字重复 / manifest 非对象 —— 四种全拦。
**校验在 `import` 时执行**（`composite_registry.js:174` 的 `STARTUP_CHECK`），不是等到 `!do` 运行时。
显式 import、不扫目录：`grep "readdir\|import(" composite_registry.js` = **0**。

**③ `makeCtx` 五条语义（逐条实测）**

| 语义 | 实测 |
|---|---|
| `deadline` 两种来源 | 无单子 → `now + manifest.timeoutMs`（collect 实测 480000ms ✅）；有单子 → 用单子的 `deadline`（实测 `deadline===jobDeadline`，`jobId=J1` ✅） |
| `reserve` / `release` 无板恒成功 | 实测 `ok=true code=OK data.noBoard=true`（两个都是）✅ |
| `checkpoint` / `save` 无单存内存 | `save({n:7})` → `checkpoint()` 原样读回 `{n:7,tag:'probe'}` ✅ |
| `mapDir` 统一函数 | `makeCtx().mapDir` 与 `mapDirOf()` 结果一致（`./bots/p/map`）✅ —— **但见下方 ⑤ 的遗留** |
| `onEvent` 是唯一写 trace_bus 的入口 | 调 `ctx.onEvent` 两次 → `trace_bus.since()` 恰好 **2 条**、按 step 去重 `{1:1,2:1}`（**无 D10 重复**）✅；且自动带上 `jobId` / `skill:'collect'` |

**④ `!do` / `!listSkills`**

`!do` 实测输出原文（假 agent，`runAction` 记录入参）：
- `!do collect "radius=9999"` → `"!do collect 没执行：参数错：参数 radius 要 4..128（现在 9999）"`
- `!do collect "count=999"` → `"!do collect 没执行：参数错：参数 count 要 1..64（现在 999）"`
- `!do nope "x=1"` → `"!do: 没有叫 nope 的复合技能。先 !listSkills 看有哪些。"`（**在 runAction 之前**就返回）

- **无错误码**：上面三条输出里 `NO_TARGET` / `NO_TOOL` / `TIMEOUT` / `NO_PATH` **一个都没有**；
  `runSkill` 参数错与技能名错都返回 `code: null` + `data.paramError=true`（实测 5 种错法全部 `code=null`）✅
- **无任务板路径能跑**：`runAction` 收到的 label = `action:do:collect`、`opts={"timeout":8}`（= 480000ms 换算成分钟）✅
  —— 没有吃默认 10 分钟，30 分钟的 `follow` 会拿到 `timeout:30`
- **`!listSkills` 完全来自 manifest**：把 `flow_pickup` 的 `summary` 改成「【探针改过】…」→ 输出立刻变成
  `pickup: 【探针改过】把附近掉落物捡起来`，改回即恢复；**完全不碰 JSDoc** ✅
- **不会撑爆上下文**：5 个技能合计 **364 字符**（平均 73 字符/技能），含参数说明。

**⑤ D24 修法：前/后对比证据**

修法：`index.js` 的 `docHelper` 从 `str.substring(indexOf('/**')+3, indexOf('**/'))`
改成非贪婪正则 `/\/\*\*([\s\S]*?)\*\//`，并剥掉每行行首 `* `；没有注释块的函数**整条跳过**。

用 **git HEAD 里的真实旧实现** vs 现实现，跑同一批 104 个函数：

| | 条数 | 总字符 | 最长单条 | >600 字条数 |
|---|---|---|---|---|
| 修前（旧 `indexOf('**/')`） | 104 | 55,115 | 1,425 | **36** |
| 修后（非贪婪正则） | 104 | 51,165 | 1,301 | **26** |

**最硬的证据是那 6 个"外层注释以单星号 `*/` 结尾"的函数**：旧实现里 `indexOf('**/')` 返回 `-1`，
`substring(pos, -1)` 被钳成 `substring(0, pos)` → **返回的是「函数签名 + `/**`」这种垃圾**（不是文档）：

| 函数 | 修前截出 | 修后截出 |
|---|---|---|
| `buildStorageWarehouse` | 65 字，结尾是 `async function buildStorageWarehouse(bot, options = {}) {\n    /**` | 479 字，结尾是 `@example …await skills.buildStorageWarehouse(bot);` |
| `planRoute` | 50 字，结尾 `function planRoute(bot, x, z, opts = {}) {\n    /**` | 318 字，结尾 `@example …const p = skills.planRoute(bot, 100, -200);` |
| `useToolOn` | 61 字，垃圾签名 | 300 字，正常 `@returns …` |

> **口径更正（t12）**：t11 报告里写「把**整段函数体**当文档」——对这批函数不准确。
> 真实后果是 **`substring(pos,-1)` 被钳成 `substring(0,pos)`，返回函数签名 + `/**` 的垃圾**；
> 而总量减少的另外一部分来自"剥掉行首 `*`"。两种都得修，方向一致，但描述要准 —— 免得下一个人按"函数体泄漏"去找别的 bug。
> 另外抽 4 条最长的（`buildHouse` 1,295 / `prepareForBuilding` 1,215 / `digTunnel` 1,155 等）结尾均为 `@example`，
> `@example` 之前**零函数体特征**（`=>{` / `return` / `const` / `for` / `if` 全 false）✅

**⑥ 新增前缀违规：0**（`composite_registry.js` 属 infra，`commands → composite_registry` 合规）。
preflight 前缀规矩仍是 **5 处**（4 处旧债 + `act_use→openContainer` 那 1 处已入册），本轮无新增。

**⑦ 真机回归（t12 独立跑，非抄 t11）**

- `atom_all` **18/18**，真实 **244 条**用例 0 FAIL（move 10 / dig 14 / place 10 / items 10 / container 13 / use 13 /
  attack 10 / stand 17 / drops 13 / look 21 / safe 12 / query 22 / wait 14 / move_landing 9 / pickup_parts 16 /
  vine 7 / skill_collect 22 / skill_clear 11）
- `bench_move_actions 5` → **49/55（89.1%）**，与新基线 49/55 一致；失败 **全 NO_PATH ×6**
  （down5 ×5 = `maxDrop=4` 已知边界；dig-through r1 = 基线同水位）
- `climb-ladder` 中位 **1971ms**（范围 1863–1974；基线 1945ms，+1.3% 在噪声内）
- `digdown` **5/5** `digdownSeen=true`、`execActions={"scan3d":2,"plan3d":2,"digdown":1}`、`y −57→−60`
- `unit_all` **20/20 + 1 跳过** exit 0（新增 `composite_registry_unit`）
- `preflight`：默认 **exit 0**（违规 5 处）/ `--strict-api` **exit 1**（那 1 处 Phase 5.4 旧债，**按规定没有修绿**）/ `--report-api` exit 0

**⑧ 遗留（M5 范围内发现，归属已写清）**

1. **`mapDirOf` 建好了但没人用**（归属：**Phase 5.4 / atoms**）——
   `mapDirOf` 目前**只有单测在调**，零生产调用；全仓仍有 **13 处**硬编码
   `` `./bots/${...}/map` `` 分布 5 个文件：`commands/actions.js` **6 处**（:177/:212/:231/:269/:459/:477）、
   `library/skills.js`、`library/map_query.js:20`、`mindserver_proxy.js`、`composite_registry.js`（唯一正当的一处）。
   t11 说"收拢原 6 处拼接"——**helper 有了，但那 6 处没搬**，所以"唯一的真相"目前实际是**两个**。
   **M5 的验收标准里这条只算半个**：`makeCtx().mapDir` 调用链是对的，但"不许有第二处拼法"还没兑现。
2. **`flow_collect_plan` / `flow_clear` 没有 `run()`**（归属：**M7 P0 流程**）——
   要让它们成为可执行技能得补 `run()` + manifest，那属于新能力，不在 M5。

#### M7 第一批验收记录（t18 / 2026-11-02，全部实测；基准提交 `a62bbe0`）

> **验收基准说明**：本节所有结论都在**提交态 `a62bbe0`**（M7 第一批，注册表 **9** 个技能）上复现，
> 用独立 worktree 跑的。原因：验收期间工作区正被 M7 第二批占用（`flow_eat/mine/farm/fight/build` 为未跟踪文件、
> 注册表已被改成 14 个）—— 若直接在主仓跑，测到的是**半成品状态**，不能当结论。
> 第二批（`6c4da70` 9→14、`2342a11` 再改）不在本任务范围，另行验收。

**① 三个流程与 04 §6.1 卡片逐条对应**

| 卡片要求 | 实测 |
|---|---|
| `flow_craft`：`recipesAll` 空 → `NO_RECIPE`（abort） | ✅ `flow_craft.js:110` `return fail('NO_RECIPE', ...)`，在 plan 第 1 步就返回 |
| `flow_craft`：有配方但 `recipesFor` 空 → `NO_ITEM` + `data.missing` | ✅ `missingFor()` 逐项算差额，返回 `{缺失物: 差几个}` 交给 `strat_obtain` |
| `flow_craft`：缺工作台先合一个再放 | ✅ `tableSpotFor()` + 背包没有工作台时先 `craftOnce` 合 4 木板→工作台 |
| `flow_craft`：`goTo` 经 `nav_core` | ✅ `import { goTo } from './nav_core.js'`（:27），不自己走 pathfinder |
| `flow_smelt`：`POLL_MS = 10s` | ✅ `export const POLL_MS = 10000`（:51） |
| `flow_smelt`：燃料优先级 煤>木炭>木板>原木 | ✅ `const FUEL_ORDER = ['coal','charcoal','oak_planks','oak_log']`（:54）+ `pickFuel` 按序取第一个有货的 |
| `flow_smelt`：**等待是流程职责、不是动作职责** | ✅ 双向实测：`furnaceCollect` 函数体里 `sleep/setTimeout/waitUntil/waitFor/POLL` **0 处**；`flow_smelt` 里 `sleepWithinDeadline` **2 处** |
| `flow_store`/`flow_fetch`：`finally` 里关窗 | ✅ 实测：存侧开窗 2 次 → **关窗 2 次**（`finally` 关窗次数 = 开窗次数） |

**② 等待策略实测（自己造 deadline，不看代码猜）**

| deadline | 实测耗时 | 结论 |
|---|---|---|
| `now + 800ms` | **801ms** | 没有睡到 `POLL_MS`（10000ms），也没睡过头 |
| `now + 1500ms` | **1503ms** | 同上，误差 ≤3ms |

`sleepWithinDeadline` 的实现是 `Math.min(ms, deadline - now)`，`left <= 0` 直接返回 0；
`flow_smelt` 的轮询循环每圈先算 `left = ctx.deadline - Date.now()`，`left <= 0` 就 `break`。
**这条是"卡十分钟"的唯一来源，已亲眼确认它不会越过 deadline。**

**③ 两种 `INVENTORY_FULL` 的不对称（重点，用"数开箱次数"验方向）**

判据是"换个做法能不能解决"：取的时候背包满，**换个大箱子也没用**（背包满跟箱子多大无关），所以必须 abort。

| 方向 | 期望 | 实测（自己数 `openContainer` 调用次数） |
|---|---|---|
| **存**：容器满 | 换下一个箱子（可恢复） | ✅ 3 个箱子时**开了 2 次**（第 2 个之后要走去第 3 个，我的 stub 没有地图库所以 `walkTo` 失败而收尾），最终 `INVENTORY_FULL`「箱子都存不下了（试了 2 个）」→ **确实在换箱子续试** |
| **取**：背包满 | **立刻 abort** | ✅ 3 个箱子时**只开了 1 次**（`opened=[1]`），立刻 `INVENTORY_FULL` → **没有"换箱子继续试"** |

代码位置也一致：存侧 `flow_store.js:187-190` 是 `storefull++; lastCode='INVENTORY_FULL'; continue;`（继续下一个箱子），
取侧 `:249-251` 是直接 `return fail('INVENTORY_FULL', '背包满了，取出来没地方放（先腾背包）')`。

**④ 可恢复 vs abort 全表（按"换个做法能不能解决"）**

| 码 | 处置 | 实测 |
|---|---|---|
| `OCCUPIED`（熔炉在炼别人的） | 可恢复：换熔炉 | ✅ `smelt` 换下一个熔炉；`furnaceLoad` 本身不抢（见 M6 记录的 15 条用例） |
| `WINDOW_CLOSED` | 可恢复：重开（最多 2 次） | ✅ `flow_store.js` 内层 `for (attempt=0; attempt<2 && !win; attempt++)` |
| `INVENTORY_FULL`（存） | 可恢复：换箱子；都满才 abort | ✅ 见上表 |
| `INVENTORY_FULL`（取） | **abort** | ✅ 见上表 |
| `NO_ITEM` | abort + `data.missing` | ✅ `flow_craft`/`flow_smelt` 都带 `missing` |
| `NO_RECIPE` | abort（永远做不出） | ✅ 见 ① |
| `INTERRUPTED` | **立刻返回，不重试** | ✅ 见下 |

**`INTERRUPTED` 四条独立实测（这条最要命：重试 = 用户喊停停不下来）**

| 场景 | 期望 | 实测 |
|---|---|---|
| `store` 一开始就 `interrupt_code=1` | 一个箱子都不开、立刻返回 | ✅ `open=0`、`INTERRUPTED`、耗时 **0ms** |
| `store` 开完第 1 个箱后被中断 | 不再试第 2 个 | ✅ `open=1`、`INTERRUPTED` |
| `smelt` 一开始就中断 | 立刻 `INTERRUPTED` | ✅ |
| （对照）M6 的 `furnaceLoad`/`harvestCrop` 等动作 | 入口先查 `interrupt_code` | ✅ M6 记录里已验 |

**⑤ 注册表闸门仍然有效**

- 我独立塞假码：`validateRegistry([{manifest: {...craft, codes:[...,'MADE_UP_CODE_XYZ']}, run}])`
  → **`ok:false`**、`problems: ["[craft] codes 里的 MADE_UP_CODE_XYZ 没在 CODES 注册"]` ✅ 闸门有效
- 提交态 `!listSkills` = **9 个**：`collect follow pickup platform escape craft smelt store fetch` ✅（与任务书一致）
- `!do` 参数错 `code` = **`null`** + `data.paramError=true`（实测 `craft` 传 `count=99999` → 「参数 count 要 1..64（现在 99999）」）✅

**⑥ 功能未回归（在 `a62bbe0` 上跑，真机）**

- `unit_all` **24/24 + 1 跳过**，exit 0
- `preflight`：默认 **exit 0**（违规 5 处、**0 新增**）/ `--strict-api` **exit 1**（Phase 5.4 旧债，**未修绿**）/ `--report-api` exit 0；**106/106** 模块导入
- `atom_all` **18/18**，真实 **244 条**用例 0 FAIL；**`vine_physics_test` 本轮 7/7 通过**（与 t14 定位的"偶发=补丁因注册表未就绪而静默空壳"一致）
- `bench_move_actions 5` → **49/55（89.1%）**，与基线 49/55 一致；失败全 `NO_PATH ×6`（down5×5 已知边界 + dig-through r1）
- `climb-ladder` 中位 **1988ms**（各轮 1987/2000/1988/2015/1889；atoms 报 2001）
- `digdown` **5/5** `digdownSeen=true`、`execActions={"digdown":1}`、`y −57→−60`

**⑦ 关于 `climb-ladder` 慢 3~5% 的复核结论：认可"抖动"，且能给出结构性理由**

- **模块图完全不相交**：`bench_move_actions.mjs` 只 import `mineflayer` / `mineflayer-pathfinder` / `vec3` / `fs` / `path` /
  `./rcon.mjs` / `./arena.mjs` / `position_guard` / `executor.walkTo` / `terrain3d` / `path_3d`；
  `executor.js` 的 import 里**没有 `skills.js`、没有任何 `flow_*`**；`nav_core` / `nav_pathfinder` / `path_3d` 同样不 import 这三个流程。
  → **M7 这三个流程在 bench 的调用路径上根本不会被加载，更不会被执行**，不可能是它导致变慢。
- 时间线也支持"漂移而非跳变"：`climb-ladder` 中位 1947（t14）→1947/1956（t12）→1971（t12 复跑）→1976（t18 主仓）→**1988（t18 worktree）**，
  是一条缓慢上移的带，而不是 M7 提交后的一次抬升。
- 结论：**同意"抖动"**。但提醒一句：这条已经从 1905 漂到 1988（+4.4%），若后面继续单向上移，值得单独查服务器 TPS 与实体残留，而不是一直归给噪声。

**⑧ M7 剩余流程的待办状态**

| 流程 | 状态 |
|---|---|
| `flow_collect` / `flow_collect_plan` / `flow_clear` / `flow_follow` / `flow_pickup` / `flow_platform` / `flow_escape` | ✅ 已注册（M5） |
| `flow_craft` / `flow_smelt` / `flow_store` / `flow_fetch` | ✅ 本批（`a62bbe0`） |
| `flow_eat` / `flow_mine` / `flow_farm` / `flow_fight` / `flow_build` | ⏳ 第二批（`6c4da70`，注册表 9→14）—— **不在本任务范围，待单独验收** |
| `flow_collect_plan` / `flow_clear` 补 `run()` | ⏳ 仍无 `run()`，要成为可执行技能属新能力（M7 后续） |
| `flow_collect` 与 `flow_collect_plan` 合并 | ⏳ 未合并（见 Phase R 待办 4） |

---

### Phase B: 任务板（2026-11-01 新增）
**目标**: 个人单和多人单（[`06_task_board.md`](06_task_board.md)），验收用例见 06 §11

- [x] B0 修 D17、D18；流程注入 ctx（不依赖任务板，可与 Phase A 并行）
- [x] B1 个人单 + 持久化（socket 的 `allowRequest` 已于 2026-11-01 提前做完）—— **M8 B1 完成（`cfebbd4`），t20 验收见下**
- [ ] B2 调度：自动领单、优先级、抢占 —— **未做**（`board_scheduler` 本期不做；`requeueStaleBrief()` 仍无生产调用方，属 B2）
- [ ] B3 多人单、预约、角色 —— **未做**
- [ ] B4 共享地标、危险点、箱子内容 —— **未做**

#### M8 B1 验收记录（t20 / 2026-11-02，全部实测）

**① 四模块与接线**

| 模块 | 位置 | 结论 |
|---|---|---|
| `board_store.js` | `src/agent/library/` | ✅ node:sqlite 唯一写库；claimFor/heartbeat/finish/expireLeases |
| `board_server.js` | `src/agent/library/` | ✅ 10 个 socket 事件 + `board:changed` 广播 |
| `board_client.js` | `src/agent/library/` | ✅ 5 个控制层契约方法（**同步**）+ `*Async` |
| `board_scheduler` | —— | 本期不做（B2） |

**`board_server` 确实挂进了 mindserver**：`src/mindcraft/mindserver.js:12-13` import `openBoard` / `attachBoardServer`，
`:83` `attachBoardServer({...})`；失败则 `board=null` 走降级。**不是"写了模块没接线"。**

**② client 的 5 个控制层契约（独立断言 20/20）**

- `list()`：**不是 Promise**、`Array.isArray` 为真、**空镜像返回 `[]` 而不是 `undefined`** ✅
- `get()`：返回 `null`（非 Promise/undefined）✅；`list/get/update/add/setAutoClaim` 五方法齐 ✅
- **用真实 `control.js` 跑**：有板时 `jobsBusy(agent)===true`、`resolveJob({board,jobId})` 拿得到真单（**不降级**）；
  无板时才 `false`/`null` ✅
- `makeNullBoard()` 行为一致（同步 `[]` / `null` / `isNullBoard`）✅

**③ 三条最容易写错的规则（自造用例 20/20）**

| 规则 | 实测 |
|---|---|
| **领单原子性** | 两 bot 抢同一张 → **只有一个领到**（另一个 `null`）；手动置 `claimed`+`lease_owner='other'` → `claimFor` 返回 `null` 且 **owner 保持 other 不动** ✅ |
| **attempts 三分类** | `INTERRUPTED`/`PREEMPTED` → 不变、回 ready；`TIMEOUT`/`STUCK`/`NO_PATH` → **+1**；`NO_ITEM`/`NO_TOOL`/`NO_RECIPE` → **blocked 且不变** ✅ |
| **完成判据** | `ok=true` 但 `count=3 < want=8` → **不算 done**（进度如实记 3）；`count=8=want` → done ✅ |

**④ 真机额外 4 个 bug 的复验**

| bug | 复验 |
|---|---|
| `board:get` payload 形状（`String({id})` → `"[object Object]"` → 恒 null） | ✅ 表驱动用例断言 `payload.keys=id` 且 `id` 是字符串；真机 `!jobs` 显示真实单 |
| id 跨进程撞号 | ✅ 关库重开 → 再 add 成功、库里 id 无重复 |
| 进度倒退 | ✅ 报 0 而库里 2 → 仍 2；`heartbeat` 返回 `progressClamped=true / reported=0` 留痕 |
| `canDigWithInventory` 只看第一把镐 | ✅ 第一把 durability=1 + 第二把 1560 → **可挖**；无镐才 false |

**⑤ payload 形状契约测试（t20 新增，落地 atoms 的建议）**

- **评估**：`board_iface_unit` 里真正验 payload 形状的**只有 1 条**（case 6b，正是 `board:get` 那个回归），
  其余多是"业务结果对不对"，不是"发出去的形状对不对"。
- **已补**：新增 `tools/board_payload_unit.mjs`（**表驱动 14 用例**），对 **10 个 `board:*` 事件逐个断言 payload 形状**
  （hello/add/list/get/claim/heartbeat/checkpoint/finish/set-state/update），含反例
  "`board:add` 的 payload **就是 job 本身**、不许再包一层 `{job}`"，并对 `board:get` 做三入参断言。已进 `unit_all`（31/31）。
- **它立刻抓到了残余**：`getAsync({id:'J-1'})` 仍被 `String()` 压成 `"[object Object]"` —— 与原 bug 同一指纹（已修，见⑥）。

**⑥ t20 修复的 B1 真 bug：已达标的单被重复派发（「不重复计数」从没真正通过）**

**现象（修复前真机）**：A 跑 `mine`（want=8）被 SIGKILL 时进度已到 **15**；租约过期后单回 `ready`，
B 重新领到**同一张单**又挖 9 → 最终 **24/8**；`!jobs` 显示 `mine 24/8`。

**根因（两条定向用例坐实）**：
1. `claimFor` 只看 `state='ready' + assignee + notBefore`，**完全不看 progress 是否已达标** →
   被 kill 在"已跑够但没 finish"时刻的单会被原样再派一遍（真 bug）；
2. `!jobs` 直接显示 `24/8`，人看着像坏了（**不是 bug，是展示**）。

**修法（按 captain 定稿口径）**

| 改动 | 内容 |
|---|---|
| ✅ `claimFor` | 派发前 `convergeIfSatisfied()`：`want>0 && count>=want` 的 ready 单 **直接收敛成 done**（记 result），**不派发** |
| ✅ `heartbeat` | 心跳报到已达标 → **当场收敛 done**（返回 `convergedToDone:true`），不等 finish |
| ❌ **不截断 count** | captain 否决 `Math.min(count,want)`：24 是**真实事实**（背包确实多了 24 个），截断=篡改记录；超额有信息量（want 定小了） |
| ✅ `!jobs` | `done && count>want` → 标 **`（超额 N，实际做到 count）`** |
| ✅ `getAsync/get` | **不再静默 `String(id)`**：字符串/数字正常；`{id}` 取 `.id`；其余 `getAsync` 返回 `fail('NO_TARGET','id 必须是字符串')` 且**根本不发事件**；同步 `get()` 返回 `null` |

**修复后真机复跑**：A 心跳报 24≥8 → 单**当场收敛 done**；B 重启 `AGENT_NO_JOB`（不再重跑）；
**count 24→24 零增长**（修复前 15→24）；`!jobs` 显示 `mine 24/8（超额 16，实际做到 24）`。

**⑦ 真机 B1 六条断言（修复后）**

| 断言 | 结果 |
|---|---|
| ① 同 id 存活 | ✅ |
| ② count 不倒退 | ✅ 0 → 24 → 24 |
| ③ **不重复计数** | ✅ **机制已成立 + 阈值已改**（见⑧-1）：`board_b1_live.mjs` 的判据已从 `cAfter <= ceil(want×1.6)=13` 改成 **`cAfter === cMid`**（重启前后计数不变）。修复后实测 24 → 24 零增长。 |
| ③b 确实采到了（防空跑） | ✅ 24 > 0 |
| ①b 回报后到 done | ✅ state=done |
| ④ attempts 未因 kill +1 | ✅ 0 → 0 |
| ⑤ 无板时 `!jobs` 说人话 | ✅ 「任务板没连上（mindserver 未连通），现在没有单可看。!do 仍然可用。」 |

**⑧ B1 范围内的待办（归属已写清）**

1. ✅ **已完成（t20 收尾，captain 授权改）**：`board_b1_live.mjs` 断言③的判据从
   `cAfter <= ceil(want×1.6)`（want=8 → 上限 13）改成 **`cAfter === cMid`**（重启前后计数不变）。
   为什么原判据是错的：`mine` 是**成批挖**的（一批里挖几块），单次运行就能到 **3×want**（实测 want=8 挖到 24），
   于是"机制完全正确"时这条也会红 —— 那不是验收，是掷骰子。真正该断言的是**重启不改变计数**，
   不是"总量不超过某个魔数"。（单次运行内的超挖是合法事实，不归这条管；`!jobs` 标"超额 N"给人看。）
2. **`!do` 仍走 `runAction`、没改走任务板**（按用户决策，B3 再说）。
3. `claims` 表填充（预约）属 B3。

**⑨ 两项「待 M8」遗留的销账核查（captain 要求：写清"为什么是部分/为什么不能销"）**

| 项目 | 结论 | **为什么**（别只看状态） |
|---|---|---|
| `applyStop()` 在 `board=null` 时空操作 | **部分销账** | **销账的部分**：B1 让生产路径上 `agent.board` 是真的 `BoardClient`（`agent.js:86` 接线），实测 `applyStop(player)` → `plan={to:'paused',patch:{state:'paused',lease:null,result:{code:'INTERRUPTED'}},pauseAutoClaim:true}` 且**真的发出了 `board:update`**（写板了，不是空转）。<br>**不能全销的部分**：`board=null` 仍然是**断线降级路径**（`agent.js:94`：client 连接失败就保持 null）。🔴 **那段空操作必须保留，不许当死代码删掉** —— 删了的话，一旦 mindserver 连不上，`applyStop` 就会去调 `null.update()` 直接抛异常，把"板子没连上"变成"动作停不下来"。它的正确身份是**降级护栏**，不是遗留物。 |
| `requeueStaleBrief()` 无调用方 | **不能销账** | 它扫的是**"60 秒内没被认领的 brief 单"**——这需要有人**定期扫**（定时器/调度循环）。B1 只做了存储 + 事件 + 命令，**没有调度器**（`board_scheduler` 本期不做，属 B2）。现在全仓只有 `control_reasons_unit` 在调它（测的是纯函数语义），**生产上零调用**。所以它不是"忘了接线"，而是**缺了会调它的那个组件**；接到 B2 的调度循环里才有意义。 |
| 死亡捡单 / 任务单 deadline 真机覆盖 | **部分推进** | B1 让 `board.add()` 可用（捡单在存储层已经能落）；但"谁去捡、多久过期、几级调度"这些属于 **B2 调度器**，真机尚未验证。 |

**⑩ 功能未回归（t20 实测）**

| 项 | 结果 |
|---|---|
| `unit_all` | **31/31 + 1 跳过**，exit 0（任务书写的是 29；实际多 2 —— atoms 新增 `act_p1_unit`/`flow_p1_unit`，我按第 4 条加了 `board_payload_unit`，都是**新增用例**不是失败） |
| `preflight` | 默认 **exit 0**（违规 5 处、**0 新增**）/ `--strict-api` **exit 1**（Phase 5.4 旧债，**未修绿**）/ `--report-api` exit 0；**114/114** 模块导入 |
| `atom_all` | **18/18**，真实 **244 条**用例 0 FAIL |
| `bench_move_actions 5` | **49/55（89.1%）**，与基线一致；失败全 `NO_PATH ×6`（down5×5 已知边界 + dig-through r1）；`climb-ladder` 中位 **2061ms**；`digdown` **5/5** `digdownSeen=true`、`execActions={"digdown":1}`、`y −57→−60` |

> 🔴 **`water-cross` 曾因并发作废，已重跑干净窗口**（保留这段是因为它是今晚第 N 次同一个坑）：
> 第一次跑时 25566 上有**另一个 bot**（`skc79700`，不是我的；atoms 当时在跑 t21 的真机），
> bench 的固定 arena（`10000,6000`）被两个 bot 同时 `fillSafe` 互相清填 ——
> 该场景中位 31416ms 正常、但单轮出现 **85144ms** 离群 → **那一轮数据作废**（已归档 `*.t20-b1-contaminated.jsonl`）。
>
> **重跑（确认 25566 只有自己）**：`water-cross` **5/5、中位 19219ms**（各轮 29013/16382/19219/37140/18710），
> 离群消失；总通过率仍 **49/55**。→ **最终数取重跑这轮**。
>
> 纪律（captain 记）：**调度器/任务板这类"多进程"改动上线后，真机测试必须严格串行** ——
> 现在真的可能有多个 bot 同时在跑，而 arena 只有一个。跑前先 `rcon list` 确认 0 玩家，
> 跑时确认在线的是**自己的 bot**（bench 的 bot 名是 `ma<时间戳>`）。

---

#### M8 B2 验收记录（t23 / 2026-11-02，全部实测）

**① B2 主循环五步**（`board_scheduler.js` 的 `tick()`，每 tick 只跑一遍、不内部循环）

| 步 | 做什么 | 关键约束 |
|---|---|---|
| 0 | **先 `refresh({scope:'claimable'})`** | 收拾残局与抢占都依赖"看到别人/共享的单"（见 ②） |
| ① | `requeueStaleBrief()` 收拾残局 | **在 autoClaim 判断之前**、且开关关着也做 —— 收残局 ≠ 领新单 |
| ② | `autoClaim === false` → 直接返回 | 不领新单、不抢占；正在跑的单继续 |
| ③ | 正忙 → 抢占判定（再 refresh + `_findPreemptor`） | 抢占前必须再拉一次（别人新加的单不在镜像里） |
| ④ | 空闲 → 先续做自己的 `paused`，再领新单，然后 `reserve → run → finish/release` | 退避中不重领（06 §8） |

**② 🔴 t23 抓到并修掉的核心缺陷：`refresh()` 只拉"我的单" → 抢占对真实场景不生效**

`refresh()` 原来只发 `{mine: this.name}`，服务端 `listJobs({assignee: f.mine})` → `WHERE assignee='me'`
→ **共享单（assignee=null）和别的 bot 的单永远拿不到** → `_findPreemptor` 看不到 →
**真正的多 bot 抢占场景压根不工作，而且不报错**。

> 这是"验证场景选错 → 缺陷被绿灯放过"的又一例：atoms 加的 refresh 是**必要但不充分**的，
> 它验的是"我自己的两张单"（当然能过），而真实抢占目标是**别人/共享的 9 级单**。

**修法（captain 定稿：显式契约，不靠 `??` 隐式穿透）**

| 层 | 改动 |
|---|---|
| `board:list` payload | 新增**显式** `scope: 'mine' \| 'claimable' \| 'all'`（默认 `mine`） |
| `board_server` | 按 scope **显式**决定过滤：`mine` → `assignee=me`；`claimable` → `claimableFor`（`assignee IS NULL OR assignee=me`，**与 `claimFor` 候选条件逐字一致**）；`all` → 不过滤。**未知 scope 回 `ok:false` 报错**，不许静默当 mine/all |
| `board_store.listJobs` | 新增 `claimableFor` 过滤（`(assignee IS NULL OR assignee = ?)`） |
| `board_client.refresh({scope})` | 默认 `mine`（语义不变）；**本地也校验**未知 scope 直接 `fail` |
| `board_scheduler` | **残局回收**与**抢占判定**两处都改成 `refresh({ scope:'claimable' })` |

> 为什么不用 `assignee: null`：`null` 在"过滤条件"这一层天然有歧义（是"不过滤"还是"assignee 为空那些"？），
> 靠 `??` 不拦 null 的隐式链路太脆 —— 哪天服务端加个默认值就静默退回"只拉自己的单"，症状又是"抢占不触发"这种不报错的。

**语义边界用例**（新增 `tools/board_scope_unit.mjs`，10 用例，已进 `unit_all`）

| # | 断言 | 实测 |
|---|---|---|
| 1 | 库里有 `mine(ready)` / `shared(ready,assignee=null)` / `other(assignee=otherBot)`；`refresh({scope:'mine'})` → **只有 mine** | ✅ |
| 2 | `refresh({scope:'claimable'})` → **mine + shared**，**不含 other** | ✅ |
| 3 | `refresh({scope:'all'})` → 三张全在 | ✅ |
| 4 | **未知 scope 报错**（客户端本地拦 + 服务端也拦，绕过 client 直接发也拒） | ✅ 两边都 `fail('未知 scope…')` |
| 5 | **端到端**：忙在 3 级单 + 库里一张**共享 9 级** ready 单 → `tick()` **必须抢占** | ✅ 修复前 `{"acted":false,"reason":"busy"}`（❗没抢占）；修复后 **`preempt-start` + `preempt-start.id==='J-shared9'` + 3 级单 → paused** |

**③ 真机 B2 五条语义（`tools/board_b2_live.mjs`，5/5）**

| 断言 | 结果 |
|---|---|
| ① 抢占后**旧流程没再动身体**（数 server 侧痕迹：1 秒内 trace/位置无变化） | ✅ |
| ② 被抢占单 `state=paused` 且 **`attempts=0`**（INTERRUPTED 不算失败，从服务端拉真值） | ✅ |
| ③ 9 级单确实执行（done） | ✅ `job-finished code=OK costMs=14249` |
| ④ 3 级单 `progress` **不倒退** | ✅ 前=0 后=0 |
| ⑤ 3 级单能被 **resume**（ready/running/claimed） | ✅ |

事件序列（真机）：`preempt-start(prio9)` → `skip-finish-preempted`（被抢占单**只走 setState(paused)**、绝不走 finish，防收尾逻辑把 paused 抹掉）→ `job-paused-preempted` → `job-claimed(prio9)` → `job-finished(prio9)`。
`!jobs` 真机输出：`[暂停] mine 优先级3` / `[完成] mine 3/2（超额 1，实际做到 3） 优先级9`（超额标注是 t20 加的，此处正常显示）。

**④ 真机残局回收 + `setAutoClaim` 语义（`tools/board_b2_brief_live.mjs`，3/3）**

| 断言 | 结果 |
|---|---|
| ① 悬单确实造出来（`running` + 过期的 `interrupted`） | ✅ |
| ② **`requeueStaleBrief` 在真机生效**（悬单被退回 `ready`） | ✅ `brief-requeued ids=[j_...19et]` |
| ③ **`autoClaim=false` 时仍然收拾残局**（收残局 ≠ 领新单） | ✅ |

→ 这三条同时**端到端证明了 `interrupted` 字段修复生效**（B2 抓的那个"字段从来不存在、brief 回收从上线起就不可能生效"）。

**⑤ 「静默丢弃字段」全量交叉核对：没有第二处有害的（一个有价值的否定结论）**

方法（脚本 `t23_patch_audit.mjs`）：抽所有 `updateJob(...)` / `.update(...)` 调用的**顶层 key**，
与 `PATCHABLE` / **真实表列（PRAGMA table_info）** / `JSON_COLS` 求差集。

写入方全量（3 处）：
```
board_server.js:200   {checkpoint}
control.js:280        {state, lease, interrupted}
control.js:440        {state, lease, result, countAttempt}
```

| 检查 | 结果 |
|---|---|
| A) 写了但 updateJob 不收（不在 PATCHABLE、也无特判） | **只有 `countAttempt`** |
| B) 其中连表里都没这一列的 | 同上（`countAttempt`） |
| C) 有列但不可 patch、且有写入方在写 | （无） |
| D) 该按 JSON 存却没进 JSON_COLS | （无） |

- **`lease` 不是问题（我第一版误报过）**：`updateJob` 在 `PATCHABLE` 检查**之前**对 `lease` 有特判
  （`{lease:null}` → 清 `lease_owner`/`lease_until`）。实测确认租约真的被清掉。
- **`countAttempt:false` 是死字段**（`control.js:440` 死亡暂停路径）→ **已删**，并在注释里写明：
  "`updateJob` 根本不碰 `attempts`，所以这个字段从来没起过作用；'死亡不算 attempts'靠的是**这里不走 `finish()`**，
  不是靠这个字段"。留着会让下一个人以为它在起作用。

> **结论**：`interrupted` 那类是**孤例**，没有第二处有害的静默丢弃。
> 但这次核对本身值得留 —— 它是"两个地方都以为自己在管同一件事"这个型的**机械检查手段**（差集为空才算过）。

**⑥ t23 修复汇总**

| 文件 | 改动 |
|---|---|
| `board_store.js` | `listJobs` 新增 `claimableFor`（`assignee IS NULL OR assignee = ?`，与 `claimFor` 候选一致） |
| `board_server.js` | `board:list` 支持显式 `scope`（mine/claimable/all），**未知 scope 报错** |
| `board_client.js` | `refresh({scope})` 显式契约 + 本地校验；不再依赖 `??` 隐式穿透 |
| `board_scheduler.js` | 残局回收 + 抢占判定两处改 `refresh({scope:'claimable'})` |
| `control.js` | 删掉死字段 `countAttempt:false` 并注释说明 |
| `tools/board_scope_unit.mjs` | **新增**：5 组语义边界 / 10 个断言（含共享单抢占端到端） |

**⑦ 四项「待 M8」的最终销账状态**

| 项 | 状态 | 依据 |
|---|---|---|
| `applyStop()` 在 `board=null` 时空操作 | **✅ 销账（null 分支保留为降级护栏）** | B1/B2 让 `agent.board` 生产上是真 client；实测有板时真的发 `board:update`。`board=null` 只作断线降级路径存在，必须保留 |
| `requeueStaleBrief()` 无调用方 | **✅ 销账（t23 真机验证）** | 现由 `board_scheduler.tick()` 每 tick 调用；真机 3/3 证明悬单被退回 ready，且 `autoClaim=false` 时仍生效 |
| 死亡捡单（`onDeath` → 8 级单） | **✅ 有执行路径** | `_runJob` 已接；B2 的 tick 会通过 `claimFor` 领到 8 级单（与 9 级抢占同一路径） |
| 任务单 deadline（`jobDeadlineTimeoutMinutes`/`runJobAction`） | **✅ 有执行路径** | `_runJob` 按 `job.deadline` 传给流程；deadline 到期由流程自身 timeout 收尾 |
| 无人值守长跑（B2 调度循环持续 tick） | ⏳ 需看 `agent.js` 是否起了循环（**t23 未验**） | 调度器本身每 tick 只跑一遍（"空闲不空转"），由外部驱动；驱动处需另行确认 |

**⑧ 功能未回归（t23 实测）**

| 项 | 结果 |
|---|---|
| `unit_all` | **33/33 + 1 跳过**，exit 0（任务书写 32；多出的 1 是 t23 新增的 `board_scope_unit`） |
| `preflight` | 默认 **exit 0**（违规 5 处、**0 新增**）/ `--strict-api` **exit 1**（Phase 5.4 旧债，**未修绿**）/ `--report-api` exit 0；**115/115** 模块导入 |
| `atom_all` | **18/18**，真实 **244 条**用例 0 FAIL |
| `bench_move_actions 5` | **49/55（89.1%）**，与基线一致；失败全 `NO_PATH ×6`（down5×5 已知边界 + dig-through r1）；`climb-ladder` 中位 **1964ms**（atoms 报 1967ms，一致）；`digdown` **5/5** `digdownSeen=true`、`execActions={"digdown":1}`、`y −57→−60` |
| `water-cross` | 5/5、中位 **30615ms**（各轮 31854/30615/…），**正常带内**（本轮跑前 `rcon list` 确认 0 玩家、跑时在线的是自己的 bot，无并发干扰） |
| 真机 B2 | `board_b2_live.mjs` **5/5**、`board_b2_brief_live.mjs` **3/3** |

**⑨ B3 待办（B2 时列的，B3 已落地 —— 见下一节）**

1. ~~`claims` 表填充~~ → ✅ **B3 已做**（六种 key + TTL，真机查库有行）
2. ~~6 种预约 key~~ → ✅ **B3 已做**（`block/area/container/station/entity/item`）
3. ~~`requires` 角色过滤~~ → ✅ **B3 已做**（t25 修了"没配角色=不受限"的语义）
4. ~~多人单拆单~~ → ✅ **B3 已做**（`splitByCount` / `splitByArea` + 父子收敛）

---

#### M8 B3 验收记录（t25 / 2026-11-02，全部实测）

**① 六种预约 key（06 §9.2）**

`CLAIM_KINDS = block / area / container / station / entity / item`

| key | 格式 | 解析实测 |
|---|---|---|
| `block` | `block:100,64,100` | ✅ |
| `area` | `area:100,64,100:8`（半径） | ✅ |
| `container` | `container:100,64,100` | ✅ |
| `station` | `station:furnace@100,64,100`（**名字@坐标**，不是冒号） | ✅（我第一版按 `station:furnace:100,64,100` 测，是**我的样本写错**，实现本身对） |
| `entity` | `entity:abc-123` | ✅ |
| `item` | `item:iron_ingot:5` | ✅ |

**冲突判定（共 8 组实测）**

| 场景 | 期望 | 实测 |
|---|---|---|
| `area(半径8)` vs 其内部的 `block` | 冲突 | ✅ **跨类型也判** |
| 远处的 `block` | 不冲突 | ✅ |
| 两个 `area` 半径都 8、中心距 **恰好 16**（=半径和，相切） | **不冲突** | ✅ **严格 `<`，相切不算重叠** |
| 中心距 15（略小） | 冲突 | ✅ |
| 中心距 17（略大） | 不冲突 | ✅ |

**"单 bot 恒成功"没有 if 分支（同一个函数两个方向都验过）**

- 单 bot 连约 **3 个互相重叠**的 key → **全成功**（同 owner 不算冲突）✅
- 另一个 bot 约到同一片 → **立刻 `CLAIM_CONFLICT`**，且 `conflicts` 明细点名占位的 key ✅
- 单 bot 继续追加约 → 仍成功（没有隐藏上限）✅

**② 角色过滤（`requires.roles`）—— t25 抓到并修掉一处"注释与实现相反"**

🔴 **缺陷**：`meetsRequires` 原来是 `new Set(who.roles ?? [])` + `!some(...)` → **空角色集合必然"一个都对不上"** →
**没配角色的 bot 什么带角色的单都领不到**。而该函数的注释自己写着「不配就什么都能领」（06 §9.4），
atoms 的单测第 269 行甚至把错的行为写成了期望值（`{} → false`）—— **注释说一套、测试写另一套、实现跟着测试走**。

🔴 **更严重**：`meetsRequires` 当时有**两份实现**（`board_store.js:809` 与 `board_scheduler.js:117`），
且行为相反；`claimFor` 用的是 store 那份（**真正决定能不能领**），scheduler 的抢占/领单判定用本地那份 →
"没配角色能不能领"取决于走哪条路。

**修法（两处都改，缺一不可）**

| 处 | 改动 |
|---|---|
| `board_store.meetsRequires` | 只有"**明确配了角色、且一个都对不上**"才拒：`if (Array.isArray(have) && have.length && !wantRoles.some(r => have.includes(r))) return false;` |
| `board_scheduler` | **删掉本地副本**，改成 `import { meetsRequires } from './board_store.js'` + `export { meetsRequires }`（**只有一份实现**，同时保留对外导出做兼容） |
| `tools/board_b3_unit.mjs` | 原来那条 `{} → false` 换成 **11 组完整判定矩阵** |

**完整判定矩阵（11 组，`tools/board_b3_unit.mjs`，全过）**

| `requires.roles` | `who.roles` | 期望 | 实测 |
|---|---|---|---|
| 无 | 无 | ✅ 可领 | ✅ |
| `[]` | `[]` | ✅ 可领 | ✅ |
| 无 | `['miner']` | ✅ 可领 | ✅ |
| `[]` | `['miner']` | ✅ 可领 | ✅ |
| `['miner']` | **无** | ✅ **可领**（本次修的） | ✅ |
| `['miner']` | **`[]`** | ✅ **可领**（本次修的） | ✅ |
| `['miner']` | `['miner']` | ✅ 可领 | ✅ |
| `['miner']` | `['builder']` | ❌ 拒 | ✅ |
| `['miner','farmer']` | `['farmer']` | ✅ **任一命中即可**（`some` 不是 `every`） | ✅ |
| `['miner']` | `['builder','miner']` | ✅ 可领 | ✅ |
| `['miner','farmer']` | `['builder']` | ❌ 拒 | ✅ |

> 三条语义已写进**实现注释**钉死：①`requires.roles` 空 → 不受限；②`who.roles` 空 → 也不受限；
> ③两边都配 → **任一命中即可（`some`）**，⚠️ 别"顺手"改成 `every`。

**③ 真机 B3（`tools/board_b3_live.mjs`，**7/7 全过**）**

| 断言 | 实测 |
|---|---|
| ① 两个 bot 都参与（不同 assignee、各领不同子单） | ✅ `assignee=["b3a","b3b"]` |
| ② **claims 表真的落了行**（两个 owner、until 在未来） | ✅ 2 行，owners=`["b3a","b3b"]` |
| ③ 两 bot 的预约 key 无重叠 | ✅ `area:6100,…:8` 与 `area:6124,…:8` 互不冲突 |
| ④ **TTL 续期真的在走**（until 被 heartbeat 推后） | ✅ `…357082 → …377110`、`…360083 → …370092` |
| ⑤ **掉线 bot 的预约自动释放**（不永久锁地） | ✅ 残留=[]、别人能约到 |
| ⑥ 合计产出 ≥ 64 | ✅ 合计 **90**（目标 64） |
| **⑦ 父单收敛为 done**（06 §11 B3 原文验收项） | ✅ **`parent=done`**，4 张子单全 done |

⑦ 的复跑说明：**本次按原样跑就过了**（不需要改矿密度）—— `board_b3_live.mjs:159` 每块区域本来就填
`15×3×15 = 675` 块 `iron_ore`，挖 16 个绰绰有余。atoms 那次第 4 张 14/16 blocked 应是**偶发**。

**④ 「静默 no-board」同类排查（t25，结论：**没有第三处**）**

B3 真机最狠的一条是 `ctx.reserve()` 静默走 no-board → jobs 全 done、合计 85、**claims 表 0 行**
（根因：`makeCtx` 只认 `agent.boardClient`，而 `agent.js` 存的是 `this.board`；调度器也没把板塞进传给 makeCtx 的 agent）。

我逐个验了 `makeCtx` 暴露的 5 个方法在**有板/无板**两种情况下的实际行为，并**直接查库**断言"接口说 ok ⇒ 库里真有东西"：

| ctx 方法 | 有板时（实测） | 无板时（设计） |
|---|---|---|
| `reserve` | ✅ **claims 表真有行**（key/owner/until 全对），不走 no-board 分支 | 返回 `{ok:true, data.noBoard:true}` —— **降级但可识别** |
| `release` | ✅ claims 行真的被删 | 同上，带 `noBoard` |
| `save` | ✅ checkpoint **真的落库** | 存内存 |
| `checkpoint` | ✅ 读回刚存的 | 读内存 |
| `onEvent` | 永远写 trace_bus（不走板），无板也不丢 | 同 |

> 两个调用点都已修好：`makeCtx` 用 `agent?.boardClient ?? agent?.board`；调度器 `_runJob` 把
> `board`+`boardClient` 都塞进 `agentView`。**结论：这一类已闭合，没有第三处"静默走 no-board"。**
> **判据（写给以后）**：一个"本该写库"的调用在无板时 no-op，**只有在返回值里带可识别标记（`noBoard:true`）**才算"设计如此"；
> 否则就是"拿错对象走了降级"——静默降级等于没人会发现问题（今晚反复出现的教训）。

**⑤ 功能未回归（t25 实测）**

| 项 | 结果 |
|---|---|
| `unit_all` | **34/34 + 1 跳过**，exit 0（与 06 §11 的期望一致） |
| `preflight` | 默认 **exit 0**（违规 5 处、0 新增）/ `--strict-api` **exit 1**（Phase 5.4 旧债，**未修绿**）/ `--report-api` exit 0；**116/116** 模块导入 |
| `atom_all` | **17/18** —— `vine_physics_test` 偶发（见下），其余 17 项全过、244 条真实用例 |
| `bench_move_actions 5` | **49/55（89.1%）**，与基线一致；失败全 `NO_PATH ×6` |

**⑥ 遗留 / 观察项**

1. ✅ **已修（`e484627`）**：`vine_physics_test` 偶发 —— 真根因是 **spawn 前 install 时 registry 未就绪、
   装成空壳后不再重试**。t27 整轮实测 **18/18、vine 7/7 通过**（t14 以来第一次干净整轮）。
2. **B3 真机用例偏慢且可能偶发**：单张子单实测 `costMs=427928`（**7 分 8 秒**）才挖 16 个矿。
   量级解释：`flow_mine` 每次找矿用 `findBlocks(bot, name, 32, 32)`（半径 32/取 32 个），
   每块矿的走近预算 `APPROACH_BUDGET_MS = 40000`（40 秒）→ **16 × ~27s ≈ 427s**，属"逐块走近"的结构成本，
   不是矿稀。→ **观察项**：下次 ⑦ 若复现 blocked/超时，按顺序查①造矿时机 ②挖矿中途掉落物没捡
   ③耗时超 deadline，**不要归给"矿稀"**；若要在意耗时，可考虑"相邻矿批处理"（不逐块重新 approach）。
3. **`item:` key 是否真被用到**：解析与冲突判定都已验，但**运行路径上没有流程会去约 `item:`**（当前只有 `area` 被 `splitByArea`/流程使用）。
4. **多 bot 场景的其它未覆盖面**：`container`/`station`/`entity` 三种 key 只验了"解析 + 冲突判定"，
   **没有真机演练两个 bot 争同一个箱子/工作台/实体**。`requires.items` 也只在离线验证。
5. **`board_b3_live` 的 ⑤（掉线释放）有偶发**：t27 复跑时 ⑤ 报「未触发」—— 该步依赖
   "b3a 在 40 秒内领到演练单并预约上"，而阶段1 跑完 b3a 可能已空闲/退出 → 演练根本没开始。
   **机制本身是好的**：离线 6/6 证实 `expireClaims` 到点后 claims 行消失、别的 bot 能约到同一块地
   （t25 真机 ⑤ 也是 PASS）。→ 属**用例时序偶发**，建议把"等 b3a 领到"改成主动唤醒/或直接在库里造
   "botA 持租约"的状态，别依赖另一个子进程的调度时机。

---

#### M8 B4 验收 + M8 四期收口总表（t27 / 2026-11-02，全部实测）

**① `deposit` / `withdraw` 修复的独立复核（t27 自己写探针，查**箱内地面真相**）**

真根因（atoms 打点推翻了我此前的假设）：`deposit` 传的是 `itemsByName[item].type`，
而 **minecraft-data 的物品表只有 `.id`、没有 `.type`** → 恒 `undefined` → 传 null → 内部断言崩。
连带两个"计数口径"bug：`winCount` 用 `win.slots`（含玩家背包段 27..62）、`invCount` 用
`bot.inventory.items()`（开窗时混进容器格子）→ `stored = invBefore - invAfter` 恒 0 →
**明明搬成功却报"容器满了"**。

我的独立验证（`t27_deposit_probe.mjs`，**12/12**，用 RCON `data get block` 做地面真相）：

| 步骤 | 期望 | 实测 |
|---|---|---|
| deposit 16 圆石 | 箱内 **16**、背包 **0** | ✅ RCON 读到 `{id:"minecraft:cobblestone", count:16}`；背包 0 |
| withdraw 10 | 箱内 **6**、背包 **10** | ✅ 6 / 10 |
| 存超持有量（只有 5 dirt 要存 99） | 非静默成功 | ✅ `stored=5 < 99` |
| 存背包没有的物品 | `NO_ITEM` | ✅ |
| 窗口没开好 | `assertUsableWindow` 明确报错 | ✅ 未初始化 → `INTERNAL`（带 inventoryStart 诊断）；没窗 → `WINDOW_CLOSED`；真调 deposit 也 `WINDOW_CLOSED` **不崩** |

> ⚠️ **我第一版探针自己踩了 bug③ 那个坑**：用 `bot.inventory.items()` 数背包 → 得到 16（因为开窗时它
> 混进了容器格子）→ 差点误判"deposit 没生效"。改用 **RCON 地面真相 + 关窗后数背包** 才对。
> **教训**：验"东西搬没搬动"必须用**与实现无关的地面真相**，不能用同一个被污染的 mirror。

**② 🔴 `store` / `fetch` 的历史可用性更正（必须写清，别让历史看起来像"一直能用"）**

| 阶段 | 当时记录 | **真相** |
|---|---|---|
| B1 / B2 / B3（t20/t23/t25） | 台账写"`flow_store`/`flow_fetch` 已交付、离线用例通过" | **只代表代码与离线用例存在**。`deposit` 在真机上**100% 失败**（物品 id 恒 null），所以 **B1–B3 期间 `store`/`fetch` 从未真机可用** |
| B4（t27） | — | 修完 `itemIdOf`/`winCount`/`invCount` 三处口径后，**真机首次可用**（本节①的 12/12 + B4 ①②） |

**结论**：B1–B3 的"已交付"应理解为**"代码已写、离线用例已过"**，不等于"运行可用"。
根因是**假窗口把三个口径 bug 藏住了**（见③）。这条写在这里，是为了不让后人以为它一直能用。

**③ 假窗口修正是否合理 —— 我用"回退实现"实测过（不是读代码判断）**

判据：把实现退回旧 bug 版本，新用例会不会红？

| 回退 | 结果 |
|---|---|
| `itemIdOf` 回退成只用 `.type` | `container_fix_unit` → **① 变红**（`FAIL ① itemIdOf {"id":null}`）、exit 1 ✅ |
| `winCount` 回退成直接用 `win.slots` | **`act_p0_unit` → 2 条变红**：`deposit 存 3 个` / `withdraw 取 2 个`，报的正是旧 bug 指纹 `winBefore:5, winAfter:5`（容器计数不变）✅ |
| 恢复后 | `container_fix_unit` 5/5、`act_p0_unit` 32/32、`flow_p0_unit` 20/20 全绿 ✅ |

→ **结论：假窗口是"改得像真的"，不是"改测试迁就代码"。** 新用例在实现退回旧版时确实会红。
（一个小观察：`container_fix_unit` 的 ③ 是**自己算两个口径做对比**，不调真函数，所以回退 `winCount` 它不会红 ——
真正守住 `winCount` 的是 `act_p0_unit` 那两条集成用例。）

**④ B4 真机（`tools/board_b4_live.mjs`，5/5）+ 我对 ④ 收窄口径的判断**

| 断言 | 实测 |
|---|---|
| ① `flow_store.store` 把箱子内容写进板库（有 chest 行） | ✅ `6303,-60,8303={"cobblestone":16}` |
| ② 板库记到"某箱子有 cobblestone" | ✅ 16 个 |
| ③ **B 不开箱就知道坐标 + 数量** | ✅ 查到 `6303,-60,8303` → 16 个 |
| ④ B 据板库坐标直接走过去 | ⚠️ **收窄为"以坐标为 goTo 目标"**：`[b4b-GOTO] NO_DATA`（目标区块未加载） |
| ⑤ B 全程没开箱 | ✅ 没开过箱 |

**我对 ④ 收窄的判断：字面上合理，但功能上不完整 —— 两者都要记。**
- **字面合理**：06 §11 B4 原文是「A 存进箱子的东西，**B 不开箱就知道**在哪个箱子」，
  契约的**明确断言**只有"知道"（③ 已 100% 通过），**没有一个字**要求"走到"。
  所以把 ④ 收窄成"拿到坐标并把它当作导航目标（而不是自己挨个开箱试）"是**忠于原文**的。
- **功能不完整**：实践中"知道在哪却走不过去"等于用不了。`NO_DATA` = 目标区块未加载，
  属**导航/地形层**（`nav_core.goTo`/`terrain3d` 需要地图库或已加载区块），**不是 B4 的错**。
  → **记为遗留**：B4 的"知道"已交付；"走下去"受导航层 `NO_DATA` 阻塞，需在导航侧
  （远程目标预加载 / 不依赖本地地图库的前往策略）单独立项。

**⑤ M8 四期收口总表（06 §11 原文 × 真机证据）**

| 期 | 06 §11 原文 | 真机证据（t27 同窗口连跑） | 结论 |
|---|---|---|---|
| **B1** | 加单 → 重启 bot → 单还在、从断点接着做、不重复计数 | `board_b1_live` **7/7**：同 id 存活 / count 0→30→30 不倒退且**重启后零增长** / attempts 未因 kill +1 / state=done | ✅ **通过** |
| **B2** | 3 级单在跑时下 9 级 → 先做 9 级 → 回去接着做 3 级、进度不丢 | `board_b2_live` **5/5**（旧流程 server 侧 1 秒无变化、被抢占单 paused+attempts=0、9 级 done、3 级不倒退、可 resume）+ `board_b2_brief_live` **3/3**（悬单回收、autoClaim=false 仍收残局） | ✅ **通过** |
| **B3** | 两个 bot 领"采 64 原木"4 张子单：不砍同一棵树、合计 ≥64 | `board_b3_live` **6/7**：①②③④⑥⑦ 全过（**parent=done、合计 93≥64**、claims 无重叠、TTL 续期）；⑤ 掉线释放**本轮"未触发"** | ⚠️ **实质通过**：⑦ 已闭合；⑤ 是**用例时序偶发**（机制离线 6/6 + t25 真机 PASS 已证） |
| **B4** | A 存进箱子，B 不开箱就知道在哪个箱子 | `board_b4_live` **5/5** | ✅ **通过**（④ 按原文收窄；"走到"受导航 `NO_DATA` 阻塞，记遗留） |

> **M8 四期判定**：**B1/B2/B4 通过；B3 实质通过（⑦ 已闭合，仅 ⑤ 用例时序偶发）**。
> **M8 可以收口**，但下面三项要留账（不是阻塞项）。

**⑥ M8 剩余遗留（合并前面各期）**

1. **`item:` key 没有真实调用方** —— 解析/冲突都验过，但运行路径上没有流程去约 `item:`（只用 `area`）。
2. **`container` / `station` / `entity` 三种 key 未做多 bot 真机争用** —— 只验了解析与冲突判定。
3. 🔴 **bench 48/55 vs 49/55 —— 已确认是 `water-cross` 的 `r2` 系统性问题，不是随机抖动**
   t25 与 t27 **连续两轮**都在 **`water-cross` 的第 2 轮**以 `NO_REACH` 失败，签名几乎一致：
   | 轮次 | 结果 | moved | pillar-attempt | clear-feet | oscillation |
   |---|---|---|---|---|---|
   | t25 r2 | NO_REACH 38851ms | 9.6 | 26 | ? | 1 |
   | t27 r2 | NO_REACH 50981ms | 12.5 | 38 | 14 | 1 |
   而同两次的 r1/r3/r4/r5 都过（r4 也挣扎：15 次 pillar-attempt 但过了）。
   **根因（结构性，非产品回归）**：`bench_move_actions` 的 `build()` **每个场景只跑一次**，5 轮共用同一场地。
   `water-cross` 是最"破坏性"的场景 —— 她在水里会 `clear-feet`（挖掉脚下水块）、反复 `pillar-attempt`，
   **r1 把这些扰动留在池子里**，r2 面对的已经不是原始几何。
   → **建议**：①`water-cross`（或所有场景）**每轮重建场地**，让 5 轮真正独立；
   ②在那之前，48/55 应理解为"含 `water-cross` 这一格结构性的 ~1/5 失败"，**不是相对 49/55 的回归**。
   ③这也说明"基线 49/55"本身带运气成分（几次跑到过 water-cross 5/5）。
4. **B4 的"走到箱子"受导航层 `NO_DATA` 阻塞**（见④）。
5. **`board_b3_live` 的 ⑤ 依赖子进程调度时机**（见上"遗留 5"），建议改成不依赖另一进程的确定性构造。

---

#### M9 接驳层验收（t29 / 2026-11-03，全部实测）

**① ★ 全仓「假 PASS」排查：没有残留（用脚本扫 167 个 tools/*.mjs）**

**方法**：抽所有工具脚本的自定义辅助函数定义（906 个），按**两条同时成立**判可疑：
A) 函数体里没有依赖形参的 `if`/三元；B) **调用点把布尔表达式**（`===`/`!==`/`&&`/`Array.isArray`/裸 `!`/比较）
传给了它的第 2/3 参。

```
真判条件的辅助函数：106 个
纯上报函数（体内无 if，但调用点没传布尔条件）：452 个 —— 正常
可疑：4 个 → 逐一人工核，全是"解析器自己误报"
```

**4 个误报的原因（记下来，免得下次重跑被 4 个红点误导）**：
1. `badCase(name, actual)` —— 布尔算子出现在**证据模板串**里（`` `...${x === null ? ...}` ``），那是文本不是条件；
2. `check(name, cond, evidence, actual)` **两处** —— 实现是**单行箭头** `cond ? okCase(...) : badCase(...)`，
   **真判**，是我的花括号提取器漏了简洁箭头；
3. `rec(type, extra)` —— 那是**记录器**不是断言。

**另外两种"假 PASS"形状也查了，都没有**：恒真条件 `if (true)` / `if ('…')` → **0 处**；
`catch { pass++ }` 吞断言 → **0 处**。

**atoms 自曝那处已修**：`tools/m9_smoke_live.mjs:58` 现在是
`const check = (n, cond, e) => { if (cond) ok(n, e); else bad(n, e); }` —— 真判；
文件里剩下的 `ok(...)` 调用都在 `if (...) { ok() } else { bad() }` 分支内，是正常上报用法。

> **结论：这一类在全仓没有第二处。** 但这次排查的方法本身值得留（脚本扫 + 两条同时成立 + 人工核误报）。

**② `code_hints` 覆盖与格式（独立断言，不只信它那条用例）**

- **覆盖 38/38**：`CODES` 38 个码，`hintedCodes()` 38 个，`CODES.filter(c => !hasHintFor(c))` = **0**。
- **抽查 3 个码的 hint 是否可执行**（不是"再试一次"这种废话）：
  `NO_PATH → "过不去：换个目标；连着两次还是不行就问玩家"`、
  `INVENTORY_FULL → "背包满了：先 !do \"store\" 把东西存起来"`（点名叫具体流程）、
  `NOT_READY → "时机不对（比如作物还没熟、还没烧完）：等一会再试"`。
- **格式实测**：造 **600+ 字**的长 message → 输出**正好 200 字、单行、「建议：」完整保留**；
  无 message 时也产出带建议的一行（60 字）。
  → **实现顺序是对的**：先给 head+code+进度+建议留预算，message 用剩余空间。
  如果反过来（先拼好再整体截断），建议必然被吃掉 —— 那正是 atoms 第一版栽的坑。

**③ 命令改路由的行为等价性 + 可观测证据（"怎么证明走的是 flow，不是旧 skills.\*"）**

| 证据 | 内容 |
|---|---|
| **1. 命令层已无旧调用** | 剥离注释后，`skills.collectBlock(` / `skills.placeBlock(` / `skills.followPlayer(` / `skills.craftRecipe(` / `skills.smeltItem(` / `skills.attackNearest(` / `skills.putInChest(` / `skills.takeFromChest(` 在 `commands/actions.js` **0 处真实调用**（只剩注释里的历史说明） |
| **2. 六条命令都 import + 调用了对应 flow** | `!collectBlocks→collectTask(flow_collect)`、`!craftRecipe→craftFlow`、`!putInChest→storeFlow`、`!placeHere→buildTask(flow_build)`、`!attack→fightFlow`、`!followPlayer→followTask` —— 六个「import 存在 + 调用存在」全部为真 |
| **3. flow 有 `onEvent` 通道、旧 `skills.*` 没有** | `flow_collect.collect` / `flow_build.build` / `flow_store.store` 的签名与内部都用 `onEvent`/`ctx`；而 `skills.collectBlock` **没有** `onEvent` → **事件本身就是"走了 flow"的指纹** |
| **4. 真机可观测事件** | 我自己跑的 `m9_smoke_live`：`!attack` 返回 `[!attack] 失败 NO_TARGET。建议：附近没有目标…`（flow_fight + code_hints 的措辞，旧 `skills.attackNearest` 不产生这种格式）；`!collectBlocks` 失败行带「建议」且 ≤200 字 |

**bench 行为等价性（逐场景）**：`bench 5` 实测 **45/55（81.8%）**，与 M9 期基线 **45/55 一致**，
**且逐场景构成也一致**（`dig-through` 两边都是 **0/5**；存档 4 次 M9 期基线：45/55、44/54、45/55、45/55 —— 可复现）。
`climb-ladder` 中位 **1928ms**（≈1900 ✔）、`water-cross` 中位 **28491ms**（落在 27000–35000 区间 ✔）。

> **为什么必须写"逐场景构成也一致"而不是笼统的"一致"**：
> 总数一样但**构成变了**就是两回事 —— 那会掩盖"某个场景能力变了、另一个场景恰好补回来"。
> 本次恰好两边都是 `dig-through 0/5`，但**这个核对动作本身不能省**（与"atoms 报的唯一未过项被换掉了"同一类警觉）。

**关于 `dig-through` 4/5 → 0/5 的口径更正（2026-11-03，重要，别记反）**

我最初把 4/5→0/5 归因成「bench 环境改动（`2ebea3a` 在 `G-6` 铺 bedrock）」，**这个归因是错的**，现更正：

- **真因是 `59b22b0`（每轮重建场地）**。提交说明原文：「旧基线一直在"复用上一轮挖的洞"，测的不是能力」。
- **铁证**（旧归档 `pre-t6.jsonl` 的 dig-through 逐轮）：
  ```
  round 1      ok=false  remain=7.5   ← 完好墙，挖不穿
  round 2      ok=true   remain=0.6   ← 走的是 r1 挖的洞
  round 3..10  ok=true   remain=0.6~0.8
  ```
  而 `bench_move_actions.mjs` **文档自己就写着**：dig-through「能挖 1 格（动作里有 dig）但随后 NO_PATH，**挖不穿**」。
- 所以历史上的 **4/5、21/27、24/27 全部测的是"能不能走过上一轮挖的洞"** —— 是**假分数**。
  每轮重建后 5 轮都面对完好墙 → **`0/5` 才是真实能力**。
- **`2ebea3a`（`G-6` 铺 bedrock）与 dig-through 无关**：墙在 `G+1..G+2`（地面以上），bedrock 在 `G-6`，不相干；
  它解决的是另一个问题（她挖/垫/踩空会掉出世界）。

> **结论**：`49→45` 这 4 分确实全部来自 `dig-through` 一个场景，但那是**「从假分数回到真分数」**，
> **不是 M9 的产品回归**，也**不是 bench 环境损坏**。→ 原"需专门查"的遗留项**销账**。
> 口径已按 captain 要求写死：**"不算 M9 产品回归，但也不能笼统记成'一致'"—— 要写"且逐场景构成也一致"。**

> 📌 **方法论留档（这条比结论更值钱）**：`bench` 的场景如果**不在每轮之间重建场地**，
> 5 轮就不是 5 个独立样本 —— 上一轮的破坏（挖洞、清脚、垫方块）会变成下一轮的"环境"。
> 于是"通过率"里混进了"场地被改好了"的分数。**看到 `r1` 挂而 `r2..r5` 全过，就该怀疑这个。**

**④ D23 残余检查（措辞必须准确）**

- `grep -rn companion_mode src/` → **只剩注释**（`actions.js:214/242/456/465/560`、`index.js:16`）✅
- **"唯一路径"的准确说法是「命令层唯一路径」，不是「全仓唯一」** —— 旧 `skills.*` 仍有别的调用方：

| 函数 | 还有谁在用 | 性质 |
|---|---|---|
| `skills.collectBlock` | `src/agent/npc/item_goal.js:156` | 上游 NPC 评测路径 |
| `skills.placeBlock` | `src/agent/modes.js:117/125/374`（自保放水桶、插火把）、`src/agent/npc/build_goal.js:64` | 运行路径 + 上游评测 |
| `skills.followPlayer` | **无调用方** | **真死代码，可以删** |

> **说"全仓唯一"就是新的谎。** D23 删掉的是**命令层的开关**；`skills.*` 的收敛是 **Phase R** 的对象，本轮不动。

**⑤ 两处"没做到"的判定（我的结论）**

| 项 | 我的判断 |
|---|---|
| **`protect_owner`** | **"判定链 + 11 条计数断言"不够** —— 我用真机跑就抓到：僵尸 `distToOwner=5.80` 但 `dyToOwner=3.60 > VERTICAL_SLACK(3)` → 按设计 `no-threat`。**判定链本身没错，但用例的几何是假的**，等于在测一个不可能触发的分支。→ 已按 captain 要求补**真实几何用例**（见⑥）。**不需要真打一场**（那要第二个真人客户端），但**几何必须真实**。 |
| **`idle_planner`** | **可以在无真人情况下验**：`THINK_EVERY_MS` 可注入、`idle_planner` 是纯策略函数（输入 bot 状态 → 输出想做的事），所以**"真空闲 30 秒"可以用假时钟 + 连续调用模拟**，不需要真等 30 秒、也不需要真人。→ 本轮**未做**（没在 t29 范围内落地用例），记为**可补项而不是阻塞项** |

**⑥ t29 修的一处测试口径错误（captain 授权）**

`tools/m9_smoke_live.mjs` 的 ⑤ 原来把僵尸 `summon` 在 `by`（主人脚位）但**没等重力落定**，
实测 `dyToOwner=3.60` → 被设计正确拒绝，脚本却断言"该打" → **假红**。
修法（三处）：
1. summon 后**先等落定、再两次 `tp` 到主人同一层**（否则它会落到下方方块上，dy 超标）；
2. **新增前置断言**：`dist ≤ 6 且 dy ≤ 3`，几何不达标就明确判"验收无效"，**不许当通过**；
3. 几何达标后断言 **`act===true && reason==='threat-near-owner'`**，并保留"不跟随时 `not-following`"。
**修后真机 8/8 全过**：`现场候选 dist=1.96 dy=0.00` → `act=true reason=threat-near-owner`。

**⑦ 回归（t29 实测）**

| 项 | 结果 |
|---|---|
| `unit_all` | **41/41 + 1 跳过**，exit 0（任务书写 39；atoms 又加了 `protect_owner`/`idle_planner` 等用例） |
| `preflight` | 默认 **exit 0**、**前缀违规 4 处**（`actions.js→act_place` 已销，与 captain 说的一致）/ `--strict-api` **exit 1**（Phase 5.4/Phase R 旧债，**未修绿**）/ `--report-api` exit 0；**121/121** 模块导入 |
| `atom_all` | **18/18**，真实 **244 条**用例 0 FAIL；`vine_physics_test` 7/7 |
| `bench 5` | **45/55（81.8%）**，与 M9 期基线一致**且逐场景构成也一致**（`dig-through` 两边都是 0/5）；`dig-through` 4/5→0/5 的口径更正见③ —— **是"从假分数回到真分数"，非回归** |

**⑧ M9 剩余遗留**

1. ~~`dig-through` 4/5 → 0/5 需专门查~~ → **✅ 已澄清并销账**（2026-11-03）：
   真因是 `59b22b0`「每轮重建场地」；旧的 4/5 测的是**走上一轮挖的洞**
   （`pre-t6.jsonl`：r1 `remain=7.5` 挖不穿 → r2..r10 `remain=0.6` 全过），
   而 `bench_move_actions.mjs` 文档自己写着「挖不穿」。
   → **`0/5` 是真实能力，属"假分数回到真分数"，不是回归。**
   我最初误归因为 `2ebea3a`（在 `G-6` 铺 bedrock）—— **更正：与 dig-through 无关**（墙在 `G+1..G+2`）。
2. **`idle_planner` 的"真空闲"验证**可用假时钟 + 纯策略函数离线做，本轮未落地。
3. **`skills.followPlayer` 是真死代码**，可以删；`skills.collectBlock`/`placeBlock` 属 Phase R 收敛对象。
4. `protect_owner` 只验到"判定链 + 真实几何"，**未真打一场**（需第二个真人客户端）。

---

## 6. 文件组织结构（目标）

> ⚠️ 2026-11-01：本节的子目录方案被 [`02_actions.md §5`](02_actions.md) 的**前缀方案**取代：`library/` 保持平铺，靠文件名前缀区分层级
> （分子目录要改所有相对 import，收益只是好看）。下面保留作历史参考。

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

> 2026-11-01：按依赖排好的实施顺序（M0–M11）见 [`00_overview.md §10`](00_overview.md)。

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

### M10 策略级（2026-11-03）

**目标**（04 §6.3）：策略不自己做动作，只拆子单、等子单结果。B1 之后用 `parentId` 子单。

#### 已交付（`45d4ccc`）

| 策略 | 状态 | 要点 |
|---|---|---|
| `strat_obtain` | ✅ 离线完成 | 来源顺序：箱子 > 合成 > 熔炼 > 采集 > 交易 > 打怪（前一个能满足就不往后试）；先判箱子，有就不下单 |
| `strat_tool_tier` | ✅ 离线完成 | 从 `haveRank+1` 逐档往上（**不跳档**）；三件工具（镐/斧/剑）都覆盖；已是该档 → 空计划且 `obtain` 调用 0 次 |
| `strat_first_night` | ⛔ **被依赖阻塞** | 需要 `flow_shelter`，而它**不存在**。04 §7 落地顺序也写着"要先做 flow_shelter" |

#### ★ 防无限展开（策略层最容易炸的地方）

三道闸，撞任一即停并返回缺口清单（04 §3.3）：

| 闸 | 值 | 行为 |
|---|---|---|
| `MAX_DEPTH` | 6 | 超过层数 → 记缺口，不再展开 |
| `MAX_JOBS` | 30 | 产出到 30 张 → 立刻停 |
| 环检测 | — | 同一物品在同一条链上重复出现 → 记缺口，不递归 |

用例证据（造"永远缺料"的链）：
```
jobs=6  maxDepth=6  hitDepth=true  hitJobs=false  gaps={"mat_6":1}
```
另：宽链守 `jobs<=30 且 maxDepth<=6`；环依赖 `A->B->A` → `jobs=2` 不无限递归。

**为什么这条最重要**：递归拆单 + 自动重试，炸了会表现为"她在疯狂下单、单越堆越多"，人工极难发现。

#### 关于 `ItemGoal`：没有 import，理由经核实成立

`ItemGoal.executeNext()` **自己执行动作** —— 核实 `item_goal.js` 里有 4 处直接调
`skills.moveAway / collectBlock / craftRecipe / smeltItem`。那是"旧世界"的同步做法：
不可中断、不进任务板，直接违反「策略不自己做动作」。而 `ItemWrapper`/`ItemNode` 没有 export，拿不到。

做法：沿用它的**需求图思路 + 完全同一批 mcdata 数据源**（核实：strat 文件用的正是
`item_goal.createChildren` 用的那 4 个 —— `getItemCraftingRecipes` / `getItemBlockSources` /
`getItemSmeltingIngredient` / `getItemAnimalSource`，逐字相同）
→ **没有复制第二套「物品→来源」真相**。

#### ★ M10 还有两项未完成

| 项 | 说明 |
|---|---|
| **关掉 `NPCContoller` 执行循环**（08 §7 原文要求） | `controller.js:70` 的 `bot.on('idle')` → `executeNext()` → 用旧 `skills.*` 自己动身体。**与新的 `idle_planner` 直接冲突**（两边都会在空闲时动手），且绕过任务板、不可中断。08 §7 明写"在 `strat_obtain` 能用之后关掉"，而 `strat_obtain` 现在有了。**这是行为变更**（她会停止自主建造/采集），已派 t31 处理并要求写清恢复方法 |
| **`flow_shelter`** | 不存在。阻塞 `strat_first_night`，还让 `idle_planner` 第 1 层"天黑没地方待→shelter"**空转**（`availableSkills` 里没有 shelter）。已派 t31 补 |

#### 顺带修的一处假红测试

`flow_p1_unit` 写死 `SKILL_NAMES.length === 14`，加两个策略就红了。
改成"这 5 个必须在 + 总数 ≥14" —— **加技能不该红，技能被误删必须红**。写死总数是脆的。

---

### M11 多 bot —— **实际已由 M8 的 B3/B4 完成**

`00_overview.md §10` 里 M11 的定义就是"**B3 / B4**，依赖 M8"。B3/B4 已在 M8 完成并验收：

| M11 的内容 | 对应 B 期 | 真机证据 |
|---|---|---|
| 多人单、拆单、预约、角色 | B3 | `board_b3_live` **6/7 实质通过**：4 张子单全 done、`parent=done`、合计 **93 ≥ 64**、claims 无重叠、TTL 续期实测（`…357082 → …377110`）、掉线自动释放（SIGKILL 后 `残留=[]`）。⑤ 曾"未触发"属**用例时序偶发**（机制离线 6/6 + t25 真机 PASS 已证）|
| 共享地标/危险点/箱子内容 | B4 | `board_b4_live` **5/5**：A 存 → 板库有 chest 行 → **B 不开箱就查到坐标+数量**（6303,-60,8303 → 16 个）→ B 直接以该坐标为目标 → B 全程没开箱 |

**结论：M11 无需单独开发**，只是"多 bot 协同"这件事的落地形态；
`terrain3d` 明确不共享（06 §9.3：多进程写同一 SQLite 要处理 WAL+busy 重试，收益不值），已写进 `board_store.js` 注释并有用例断言"板库拒绝 `kind='terrain'`"。

**M11 剩余遗留**：`container`/`station`/`entity` 三种预约 key 只验了解析+冲突，**未做多 bot 真机争用**（需要起 2 个 bot 真的抢同一个箱子/熔炉/村民）；`item:` key 无真实调用方。


---

**文档版本**: 1.0  
**生成时间**: 2026-10-31  
**基于报告**: 4个子agent只读调研（token总计~2.1M）
