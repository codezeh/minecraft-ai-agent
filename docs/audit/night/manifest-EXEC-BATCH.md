# manifest · t23 — `src/agent` + `src/utils` 的 9 条

> patch-smith · 2026-11-06 12:5x
> **诚实边界**：本会话 `spawnSync` = EPERM（node 不能起子进程）⇒ `gate:full` / `unit_all` 跑不了，归 captain。
> 下面每条的"验证"都是**静态断言 + 可跑单测/等价脚本**，**没有真机 Minecraft 验证**，不冒充。

## 我的文件组（7 个）
```
A  src/agent/tasks/task_chat.js          （新增：sink 级斜杠闸）
M  src/agent/tasks/tasks.js              （① 装闸）
M  src/agent/tasks/cooking_tasks.js      （① 装闸）
M  src/agent/tasks/construction_tasks.js （② 窗户 bug + ⑧ null 判断）
M  src/agent/library/executor.js         （③ /air/i×3 + ⑥ 垫高失败）
M  src/agent/library/skills.js           （④ 箱子差值 + ⑤ equip + ⑦ 垫脚清单）
M  src/utils/loop_lag.js                 （⑨ 滑动窗口）
```
⚠️ 工作区里还有**大量不属于我**的改动（`src/models/*` 16 个、`src/mindcraft/*`、`tools/*`、`src/agent/commands/index.js`、`library/composite_registry.js`、`library/flow_craft.js`、`.gitignore`）。
**我没碰它们**，请按各自作者认领，别混进本提交。

---

## ① `F-EXEC-101`（high）37 处裸斜杠 — **校验下沉到 sink**

### 改了什么
新增 `src/agent/tasks/task_chat.js`（放 `tasks/` 而**不是** `library/`，遵 captain 的"新模块别进 library"）：
- `classifyTaskChat(text, {allowCheats})` —— **复用 `permissions.slashVerdict` 的同一张白名单**（不新增第二真相源）；
  非 `/` 开头 → 放行；白名单外 → 拦；作弊类且未 `ALLOW_TASK_CHEATS=1` → 拦。
- `installTaskChatGuard(bot)` —— **包住 `bot.chat`**（sink 级），幂等；被拦的命令**不发出去**并打日志。
- `uninstallTaskChatGuard(bot)` / `isTaskChatGuardInstalled(bot)`。

装闸点：`tasks.js:437`（`initBotTask`）+ `cooking_tasks.js:12`（`CookingTaskInitiator` 构造器）。

### 这条回答"新增一个调用点会不会静默绕过" —— **不会**
因为闸在 **sink**（`bot.chat` 本身），不在调用方：**谁调用都得过**。
实测（假 bot，装闸后）：
```
bot.chat("/fill … air")   → 拦住（作弊命令，需 ALLOW_TASK_CHEATS=1）
bot.chat("/op Stranger")  → 拦住（不在白名单）        ← 这是"新增的调用点"，同样被拦
bot.chat("大家好")         → 放行（普通聊天不归本闸管）
实际发出: ["大家好"]
```
打开 `ALLOW_TASK_CHEATS=1` 后 `/fill` 才放行（实测）。

### 为什么保留原来那 37 处 `bot.chat('/…')` 文本不变
它们现在是**被闸罩住的**；逐处改成 `command()` 属重构，且我无法真机验证场景脚本仍能建起来
（captain 明确"不要顺手重构"）。**真正的收益（新增调用点不可绕过）已经由 sink 闸拿到。**

### 已知边界（如实写）
- 闸只在**任务流程**里安装（任务不跑时无闸）。不在全局装的原因：`atom_input_misc` 会发 `/msg`（悄悄话），
  全局装会误伤它。
- 闸装上后，任务期间 `/msg` 也会被拦（它不在白名单）。**这是有意的取舍**：任务场景里不该发悄悄话。
  若将来需要，把 `msg` 登记进 `SLASH_COMMANDS` 即可（一处）。

### 验证 / 回滚
验证：上面的假 bot 实测（可复跑）；`node --check` OK。
回滚：删 `task_chat.js` + 撤两处 `installTaskChatGuard` 调用（37 处文本未动，回滚面极小）。

---

## ② `F-EXEC-110` 房子没有窗户（功能性 bug，用户可见）

`construction_tasks.js:738/741`：`addWindowsAsSquares/Plane(matrix, **newZ**, newY, newZ, …)` → 第 2 个参数应为 **`newX`**。
**先核对了签名**：`addWindowsAsSquares(matrix, x, y, z, …)` / `addWindowsAsPlane(matrix, x, y, z, …)`（:508/:591），
且同函数下方 `addCarpet(matrix, newX, newY, newZ, …)` 是正确的对照 ⇒ 确认 x 是第 2 参。

**验证**：`grep addWindowsAsSquares(matrix,` → 只剩定义处 + `newX, newY, newZ` 的调用（无 `newZ` 当 x）。
真机验证建议：生成一栋 `windowStyle=1` 的房子 → 统计玻璃块数应 > 0（改前为 0）。
**回滚**：把两处 `newX` 改回 `newZ`。

---

## ③ `F-EXEC-106` `/air/i` 三处（按方块状态判，不看错误文本）

新增 `isAirNow(bot,x,y,z)`（读实际方块 + `IS_AIR`）；三处（`:271`/`:374`/`:760`）全部改为
`if (!r.ok && !isAirNow(...)) return 失败`。
理由：`message` 是自由文本，`stair`/`repair`/`airborne`/`No air above` 都会误命中 ⇒ 真实失败被当成功，
`dug++` 照加、terrain3d 照更新 ⇒ 库与现实分叉。

**验证**：`grep -c "/air/i"` → 2，且两处都在**注释**里（`:80`、`:268`）；`isAirNow` 定义 1 处 + 调用 3 处；`node --check` OK。
**回滚**：三处换回 `/air/i`（不推荐）。

---

## ④ `F-EXEC-103` 箱子"按意图判成功"

`skills.js` `putInChest`：`deposit` 前后用 **`countInventoryItem`** 取背包实际数量，
`moved = before - after`；`moved <= 0` → **返回 false**；部分成功会打 `Partially put X/Y`。
（复用文件里已有 helper，不新增第二实现。）

**验证**：`grep beforeHave/afterHave` 在位；`node --check` OK。
**回滚**：恢复成 `deposit` 后无条件 `return true`。

---

## ⑤ `F-EXEC-104` equip 不检查返回值

`skills.js` `equip`：7 支调用合并为"按名称映射目标位 + 一次 `bot.equip`"，
并加 ① 入口 `interrupt_code` 检查 ② `try/catch` ③ **读回校验**（`bot.heldItem` 或护甲槽 5..8 真的是它）才算成功。

**验证**：`node --check` OK；函数内 `bot.equip` 只剩 1 处且结果被校验。
**未真机验证**：读回用的槽位索引（5..8）是基于 mineflayer 惯例，**未在真机核对**；
若某版本护甲槽不同，表现会是"穿上却报失败"（fail-safe 方向，不会误报成功）。
**回滚**：恢复 7 支 if/else。

---

## ⑥ `F-EXEC-105` 垫高失败不回传

`executor.js` 高度不足分支：垫高循环记录 `lastErr`，若最终仍低于 `targetFeetY-1` →
**返回 `{ok:false, code: lastErr.code ?? 'HEIGHT_MISS'}`**，不再 `return r`（r 是 moveToXZ 的 ok）。
与上方"走过头（y 太高）"那支对称。

**验证**：`node --check` OK；该分支现在有 `HEIGHT_MISS` 返回。
**回滚**：删掉新增的 if 块，恢复 `return r`。

---

## ⑦ `F-EXEC-108` 垫脚清单双份

`skills.js` 删掉内联 `goodScaffold` 正则（含一个永远匹配不到的 `_slab` 死备选），
改为 `import { isScaffoldBlock } from './scaffold_blocks.js'` 并在两处调用（`:1803`、`:1815`）。

**验证**：`grep -c goodScaffold` → **0**；`isScaffoldBlock` 1 处 import + 2 处调用；`node --check` OK。
**回滚**：恢复正则与两处 `.test()`。

---

## ⑧ `F-EXEC-109` `checkLevel` 结果无 null 判断

`construction_tasks.js` `checkLevelBlueprint`：解引用前加
`if (!result || typeof result !== 'object' || !Array.isArray(result.mismatches))` → 返回"检查失败：非预期值"。
调用方是用户可直达的 `!checkBlueprintLevel`。

**验证**：`node --check` OK。
**已知残留（未改）**：同文件 `:15/:19/:71` 还有三处同型解引用（`result.mismatches.length`）。
它们在**别的函数**里，本单范围是 `:47-49`；要一并收口需逐个确认调用方（可能抛在教育性的 validate 路径里）。
**已在下面的"遗留"里登记**，不在这轮硬改。

---

## ⑨ `F-EXEC-107` loop_lag 无窗口

`src/utils/loop_lag.js`：新增 60 秒滑动窗口（`WINDOW_MS`）+ 样本上限 240；
`loopLagStats()` 新增 `windowMaxMs/windowMaxAt/windowSamples/windowMs`（历史 `maxLagMs` 保留但**只作参考**）；
`describeLoopLag()` 改用窗口值，并**显式写出窗口长度**（"最近 60 秒最大 …"）+"历史峰值仅供参考（不是当前状态）"。

**验证**（等价脚本 `docs/audit/night/tmp/test-looplag-window.mjs`，6/6）：
- 刚抖动时窗口峰值 5000 ✓
- **60 秒后旧峰值被淘汰**（不再污染判断）✓ ← 本条的核心
- 新样本进来后只看新样本（5000 旧峰值不参与，显示"正常"）✓
- `MAX_SAMPLES` 生效（len=240）✓
- 无样本 → `null`（描述说"无样本"而不是"最大 0ms"）✓
外加 `describeLoopLag()` 静态含"最近 … 秒"字样。
**回滚**：恢复单调 `maxLagMs` 版本。

---

## 不回归 / 自检汇总
| 检查 | 结果 |
|---|---|
| `node --check`（7 个改动文件） | 全 OK |
| `text_fence_unit` / `permissions_unit` / `proc_lifecycle_unit` / `ai205_used_command_unit` / `mindserver_gate_unit` / `agent_process_backoff_unit` | **全部 exit 0**（无回归） |
| `task_chat` 假 bot 实测 | 拦截/放行行为符合预期（含"新增调用点被拦"） |
| loop_lag 窗口等价脚本 | **6/6** |
| `npm run gate:full` | **本会话跑不了**（spawn EPERM）⇒ 归 captain |

## 遗留（明确登记，未在本轮改）
1. `construction_tasks.js:15/:19/:71` 三处同型 `result.mismatches.length` 解引用（见 ⑧）
2. `equip` 的读回槽位索引未真机核对（见 ⑤）
3. 任务期间 `/msg` 会被闸拦（见 ①，可一处登记解决）
