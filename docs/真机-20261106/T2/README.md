# T2 · 熔炼与容器真机时序（BOT-003 / BOT-006 / BOT-009）

> 真机验收 · 团队 `真机验收-20261106` · 采集时间 **2026-11-06 19:59 – 21:2x (UTC+8)**
> 环境：Paper 1.21.8（25565 + RCON 25575）+ 裸 mineflayer 4.39.0 bot（probe2）+ 真 furnace / 真 chest。
> **口径**：本任务验证「修复在真机成立」，不是复现旧缺陷。所有数字均为真机实测；做不到的写明卡点。
> **未改产品源码**（`git status` 只有 `?? docs/真机-20261106/`）；未改 `server.properties`；未关服。

---

## 0. 结论总表（一条一行：编号 / 原缺陷 / 真机实测值 / 是否成立 / 证据）

| 编号 | 原缺陷（深度检查报告） | 真机实测值 | 修复成立? | 证据文件 |
|---|---|---|---|---|
| **BOT-003-1** | 「一件 10 秒」只是推算，没有真机墙钟 | 单件 `want=1`：**wall 11.053 s**，`got=1`，背包 `iron_ingot` 0→1；炉内曲线 16 件 = 每 10.0 s 一件 | ✅ 成立（200 tick=10 s 是真机事实） | `result-A1-single-item.json` / `result-A2-want16.json` |
| **BOT-003-2** | 燃料固定只投 1 份 → `want=16` 只烧出 8，剩 8 件干等到 600 s deadline | `want=16`+煤充足：`fuelNeededFor('coal',16)=2`；**炉内直接观测 `input=raw_iron×16`、`fuel=coal`（燃烧首刻消耗 1 份后仍有 1 份）**，服务端背包煤 **8→6 = 恰好取走 2 份**；最终 **`got=16`**（不是 8），背包 `iron_ingot` 0→16；端到端 wall **186.337 s**（A2）/ **168.669 s**（A6 干净复跑） | ✅ 成立（fuel 2 份一次投够、got=16 有直接观测，不再靠推断） | `result-A2-want16.json`、`result-A2c-load-precise.json`、`result-A2d-coal-truth.json`、`result-S3-read-method-diff.json` |
| **BOT-003-2b** | 「16×10 s=160 s」与实测 wall 的差额没有归因 | 拆解：放料 **0.307 s** + 燃烧 **每件 avg 10 010 ms**（14 个间隔 9.63–10.27 s）+ 收产物开窗 **32 次共 306 ms** + **末件迟滞 ≈7.9 s**（燃料 2 煤=3200 tick 与 16 件=3200 tick **恰好卡满**；此归因为最合理解释，**未直接证实**，卡点：本轮未采 `Items[1]`/`litTime`） | ⚠️ 部分归因（速率已钉死为 10.0 s/件；末件 7.9 s 待证实） | `result-A6-timeline.json`（`windowOps` 33 次开窗时间表 + 297 帧采样） |
| **BOT-003-3** | 燃料不足会先占住炉子、烧到 600 s 才报「8/16」 | 只给 1 煤要 16：**wall 0.001 s** 返 **`NO_ITEM`** + **`missing.fuel:1`**；同一时刻 `data get` 逐格读炉子 → **输入槽/燃料槽/产物槽全空（0 件进炉）**，背包 16 件原料原封不动 | ✅ 成立（早失败 1 ms 级，绝不烧到 600 s） | `result-A3-fuel-short.json` |
| **BOT-003-4** | `putInput` 总是塞最多 64 件 → 只要 1 个也把 64 件全塞进炉 | `want=1` 且背包 64 原料：炉内输入槽 **=1 件**（不是 64），背包 `raw_iron` **64→63**，`got=1`，wall 10.884 s | ✅ 成立（只装本次要的量） | `result-A4-want1-64.json` |
| **BOT-003-5** | 返回的 `got` 可能与真实产出不符（谎报） | `want=16`：`data.got=16` 与背包真实增量 **完全一致**（`gotMatchesRealDelta:true`）；`want=1`：`got=1` 与增量 1 一致；炉内取空后 NBT 为空 | ✅ 成立（不谎报） | `result-A2-want16.json`、`result-A1-single-item.json` |
| **BOT-009-1** | `deposit` 抛错 → `INTERNAL/stored:0`，上层按零进度重试 → 重复搬运 | 真箱只剩 3 格（24/27 已填）×存 10 把铁剑（不可堆叠）：返 **`INVENTORY_FULL` + `partial:true` + `stored=4`**；**服务端背包 10→7、箱子真实 +3**（slot 24/25/26 各 1）；**不再是 INTERNAL/stored=0** | ⚠️ **部分成立**：`INTERNAL→INVENTORY_FULL` 与「不再报 0」已成立；**但 `stored` 多报 1 件（4 vs 真实 3）**，见下条 | `result-B-store-partial.json`（+ 连跑 2 次 `result-B2-...`） |
| **BOT-009-2** | （同上，残留）partial 的**数值**是否可信 | 3/3 次复现：报 `stored=4`，真实 **3**（`deposit` 自己的账 `inv 10→6 / win 0→3`；第 4 把**当时还在容器光标上** `{iron_sword ×1, slot 56}`；关窗后守恒回到 `背包 7 + 箱 3 = 10`） | ❌ **不成立（残留缺陷，非测量假象）**：`act_container.js:450` 用 `Math.max(invBefore-invAfter, winAfter-winBefore)` ⇒ 把「已离开背包、还在光标上」的那 1 件算成已存 | `result-B2-deposit-attribution.json` |
| **BOT-006-1** | 该场景本地**无法自然触发**超时 | 真实 `openContainer` 延迟实测 **290 / 19 / 3 / 3 / 4 ms**（首次含建连）；默认超时 4000 ms、注入用 300 ms ⇒ **本机回环不存在自然超时** | —（说明项：只能注入构造） | `result-C-container-open.json` |
| **BOT-006-2** | 超时后 opener 无人管、`sleep(timeout)` 计时器一直挂着 | 注入「永不 resolve」+ `timeout:300`：**311 ms** 返 **`TIMEOUT`**；计时器探针记录该 300 ms 定时器 **`cleared:true` 且 `_destroyed:true`**（真的被 `clearTimeout`） | ✅ 成立（超时真结束 + 计时器已清） | `result-C-container-open.json` |
| **BOT-006-3** | 超时后迟到的窗口污染下一个任务的 `bot.currentWindow` | 超时 300 ms 后才落地的窗口：`closeLateIfOwned` 把它关掉（`closeCalls:["LATE-GHOST"]`），**`bot.currentWindow` 归 `null`（未被污染）** | ✅ 成立（迟到结果不污染） | `result-C-container-open.json` |
| **BOT-006-4** | 等待期被取消，opener 回来仍报 `ok` | 等待期内置 `interrupt_code`：开窗 400 ms 才回来，结果仍是 **`INTERRUPTED`（`notOk:true`）**，窗口被关、`currentWindow=null` | ✅ 成立（取消后不报 ok） | `result-C-container-open.json` |
| **负载** | 测量期间服务器是否被拖慢 | 全程 `/tps` = **20.0 / 20.0 / 20.0**；16 件熔炼的 186 s 内每 30 s 采样一次，全部 20.0 | —（真机负载无异常） | `result-A2-want16.json`（`tpsDuring` 5 个采样点） |

**一句话总结**：BOT-003 的四条全部真机成立（含「只装本次量」「燃料早失败」「got 不谎报」）；BOT-006 的三条全部成立；**BOT-009 只修好了一半 —— 返回码对了，但 `stored` 会多报 1 件**（详见 §3）。

---

## 1. 环境与数据来源

| 项 | 值 |
|---|---|
| 服务端 | Paper 1.21.8-60，`127.0.0.1:25565`，RCON `25575`（口令运行时从 `server.properties` 读，**从不打印**） |
| bot | 裸 mineflayer **4.39.0**（`createRequire('mindcraft/package.json')` 复用依赖），`auth:'offline'`，协议 1.21.8，用户名 `probe2` |
| 被测函数 | **项目真实源码**：`flow_smelt.smelt()`、`act_craft.furnaceLoad/furnaceCollect/fuelNeededFor`、`act_container.openContainer/deposit`、`flow_store.store()`（`file:///E:/.../mindcraft/src/agent/library/...` 直接 import，非复刻） |
| 炉子/箱子 | 真实方块实体：`/setblock` 放 furnace、chest；内容用 `/item replace block ... container.N` 精确填充 |
| 观测手段 | 逐格 `data get block ... Items[i].id/count` + 服务端权威计数 `clear <p> <item> 0`（只报告不删除）+ bot 侧 `inventory.items()` + 服务端 `/tps` |

> **bot 不是 mindcraft agent**（无本地模型可用，理由同 T0）：它不经 mindserver，所以**面板 agent 列表里看不到 `probe2`**；T2 的所有数据都来自「bot 的 mineflayer 状态 + 服务端 RCON」，与面板无关。

---

## 2. A 组：熔炼真机时序（BOT-003）

### 2.1 A1 单件：11.053 s（不是 10.000 s，差在轮询粒度）

`smelt(bot,'raw_iron',1)` → `ok`，`got=1`，`costMs=11052`，墙钟 **11.053 s**；背包 `iron_ingot` 0→1，炉内取空。
10 s 是**燃烧时长**（200 tick）；多出的 ~1 s = 首次 `furnaceCollect` 前的 500 ms 试探 + 开窗取物开销。

### 2.2 A2 `want=16`：186.337 s，且**燃料真的只投 2 份**

- `fuelBurnOf('coal')=8`、`fuelNeededFor('coal',16)=2`（产品函数直接算）。
- **直接观测**（`result-A2d-coal-truth.json`，服务端权威计数 + 逐格 NBT）：
  - 装料后 `serverCoal`：**8 → 6**（随后 5 s 内稳定为 6）⇒ 只取走 **2 份煤**，没有"多拿丢掉"；
  - 炉内 `Items[0] = raw_iron × 16`、`Items[1] = coal`（count 1：**开始燃烧立刻消耗 1 份，剩 1 份在烧**）；
  - 产品返回 `inputCount=16, fuelCount=2`。
  - 判定：**「2 份煤一次投够」是直接观测，不是从 8→6 推的**。
- 燃烧曲线（`result-A2-want16.json` 的 `tpsDuring[].furnace`）：剩余原料
  `36.3 s → 13`、`66.3 s → 10`、`96.3 s → 7`、`126.3 s → 4`、`156.3 s → 1` ⇒ **每 30 s 恰好 3 件 = 10.0 s/件**。
- 终局：`ok, got=16`，背包 `iron_ingot` **0→16**、`raw_iron 16→0`、`coal 8→6`；`gotMatchesRealDelta:true`。

### 2.3 A2 的 186.3 s 与理论 160 s 的 26 s 从哪来

> 这一节的口径：160 s 是**纯燃烧**（16×10 s）。拆解见 §2.4 的 A6 时间线（窗口操作时间表 + 燃烧曲线 + 收尾段）。

### 2.4 A6 时间线拆解（200 ms 采样 + 包 `bot.openFurnace` 记录每次开窗）

> 干净炉 `(202,71,200)`（先 `/setblock … air` 再放 furnace，避免"同类型 setblock 保留旧库存"这个坑）。
> 两次 16 件全流程：**A2 = 186.337 s**、**A6（带时间线仪器的干净复跑）= 168.669 s**，都是 `got=16`。

| 段 | 实测 | 说明 |
|---|---|---|
| ① 放料（`furnaceLoad` 一次开窗 + putInput + putFuel） | **0.307 s**（开窗本身 254 ms） | 冷启动首次开窗约 0.9–1.5 s（A2c/S3 实测 926–1459 ms），热态 0.25 s |
| ② 燃烧 16 件 | **每件间隔 avg = 10 010 ms**（14 个间隔：9 630–10 267 ms，抖动来自我 200 ms 采样粒度） | ⇒ **200 tick = 10 s 是真机事实**，不是推算 |
| ③ 轮询/收产物 | **32 次 collect 开窗，每次 1–3 ms，合计 306 ms**；开窗间隔呈现 `10.0 s → 0.5 s` 交替 | 0.5 s 是"刚收成功后的短试探"，10 s 是 `POLL_MS` |
| ④ 收尾（最后一件落地到 `smelt()` 返回） | **约 0.1 s**（末次 poll 167.9 s 起、168.577 s 收到第 16 件，168.669 s 返回） | |
| 合计 | 168.669 s = 160.1 s（燃烧）+ 0.31 s（放料）+ 0.31 s（开窗总开销）+ **约 7.9 s 末件迟滞** | |

**关于那 7.9 s（诚实标注：部分归因，不是全归因）**
- 前 15 件的间隔稳定在 10.0 s（第 1 件在 10.73 s 落地，第 15 件在 150.88 s 完成）；
- **第 16 件却拖到 168.5 s 才完成**（150.88 → 168.5 ≈ 17.6 s）。这不是轮询粒度：轮询每 10 s 一次，最多多等 10 s，而且末次 poll 恰好抓住了它。
- 最可能的原因：`fuelNeededFor('coal',16)=2` ⇒ 2 煤 = **3200 tick = 恰好 16 件所需的 3200 tick**，燃料预算**刚好卡满、没有余量**，末件踩在"燃料见底"的边界上。**但本轮探针没有采样燃料槽/litTime，这条只是最合理解释，未直接证实** —— 具体卡点：本轮只采了 `Items[0]`/`Items[2]`，要证实需同时采 `Items[1]`（fuel）与 `litTime`/`BurnTime`。
- 这解释了两次跑同一场景的差异：A2 = 186.3 s、A6 = 168.7 s（差 17.6 s），符合"末件在燃料边界多等一拍"的量级，也说明 **`want=16` 的端到端耗时不稳（±10~20 s），不可用于"精确等于 16×10 s"的断言**；但"每件 10.0 s"这个**燃烧速率**是稳的（10 010 ms avg）。

**给后续的可用结论**：要精确量"16 件要多久"，请用 `want=15`（2 煤 = 16 件有余量）或给 3 煤但把 `count` 设为 15 —— 避开"燃料恰好用尽"的边界。本次不重跑（时间成本 ~3 min/次，且结论已足够）。

### 2.5 A3 燃料不足：1 ms 早失败，炉内 0 件

`1 煤 + 16 原料`，`smelt(...,16)` → **wall 0.001 s**，`NO_ITEM`，`message="燃料不够：烧 16 个 raw_iron 要 2 个 coal，只有 1"`，`data.missing.fuel=1`；
同一时刻逐格读炉子：**`Items` 全空**（输入/燃料/产物都是 0），背包 `raw_iron` 仍 16、`coal` 仍 1。
⇒ 对比旧行为（占住炉子烧 8 件、空转到 600 s 才报 8/16）：**修复成立**。

### 2.6 A4 `want=1` 但背包 64：炉内只进 1 件

装料快照（逐格 NBT）：`Items[0]=raw_iron × 1`；背包 `raw_iron 64→63`，`coal 8→7`，`got=1`，wall 10.884 s。
⇒ 旧行为是 `Math.min(have,64)`（64 件全塞）：**修复成立**。

---

## 3. B 组：BOT-009 容器部分进度 —— **半成立，`stored` 多报 1 件**

### 3.1 场景与真实账单

真 chest 27 格，先填满 24 格（每格 64 泥土）→ **只剩 3 格**；背包 10 把 `iron_sword`（不可堆叠 ⇒ 3 格最多吃 3 把）；`store(bot,'iron_sword',10)`。

| 量 | 真机值 |
|---|---|
| 返回码 | **`INVENTORY_FULL`**（**不再是 `INTERNAL`**） |
| `data.partial` | **`true`** |
| `data.stored` | **4**（❌ 多报 1） |
| 服务端背包（`clear ... 0` 权威） | **10 → 7**（真实少 3） |
| 箱子真实内容 | **+3 把**（槽 24/25/26 各 1，逐格 NBT） |
| 墙钟 | 73–121 ms |

**成立的部分**：`INTERNAL/stored:0` → `INVENTORY_FULL/partial:true` 的语义修复是真的；上层不会再"按零进度重试"（因为它至少知道有进展）。
**不成立的部分**：报出去的数字比真实多 1。对账本的影响是**账报大**（以为存进 4、实际 3），比原来的"报 0"隐蔽得多。

### 3.2 归因：是代码口径，不是测量假象（3/3 复现）

`result-B2-deposit-attribution.json` —— 直接调 `deposit()` 并把它自己的账、光标、关窗后守恒一起抓：

| 观测 | 值 |
|---|---|
| `deposit` 自己返回的账 | `invBefore=10, invAfter=6, winBefore=0, winAfter=3` ⇒ `stored = 10-6 = 4` |
| **同一瞬间容器光标** | `{name:'iron_sword', count:1, slot:56}` ⇒ **第 4 把"已离开背包、还没落进箱子"** |
| 箱子真实增量 | `winAfter-winBefore = 3` |
| 关窗后守恒 | 背包 **7** + 箱子 **3** = **10**（那把剑回背包了） |
| 连跑 2 次 `store()` | 报 `4 / 4`，真实 `3 / 3` ⇒ **确定性，不是偶发** |

**根因（行号）**：`src/agent/library/act_container.js`
- `:447` catch 分支先 `waitCountsSettled(() => invCount(bot,item) < invBefore || winCount(bot,item) > winBefore)`
  —— 谓词是「**任一边变了**」，第一件一移动就返回，**不等两边一致**；
- `:450` `const moved = Math.max(invBefore - invAfter, winAfter - winBefore, 0);`
  —— `Math.max` 在「背包已减 4、箱子只增 3、1 件在光标」时取到 **4**；
- `:452` 用它当 `stored` 返回（`flow_store.js:203` 再把它累进 `storedTotal`）。
- 成功分支 `:466` `const stored = invBefore - invAfter;` 同一口径（同样会把在途件算进去）。

**建议修法（不改代码，只给方案）**：
1. **以容器增量为准**：`stored = winAfter - winBefore`（"真的进了箱子"的唯一直接证据），背包增量只做兜底；
2. 或把 `waitCountsSettled` 的谓词换成「**连续两次读数相同**且光标（`win.selectedItem`）为空」，再取差值；
3. 或异常后**先关窗再读**（关窗会把光标物品退回背包），再算 `invBefore - invAfter` —— 本报告实测关窗后守恒为 10，正好可用。

### 3.3 顺带记录：跨箱累计没被这次场景覆盖

本次只有一个箱子（`chestsNearby` 只找到它），所以 `flow_store` 的"跨箱累计"分支没被触发。要单独验它需要"两个箱子、第一个只收一部分、第二个继续收"的真机场景 —— **本次没做，明确标为未覆盖**（不是失败，是范围外）。

---

## 4. C 组：BOT-006 开窗超时/取消

### 4.1 真机开窗延迟：3–19 ms（首次 290 ms）⇒ **本地无法自然超时**

5 次真实 `openContainer(chest)`：`290 / 19 / 3 / 3 / 4 ms`（首次数含建连+首包）。默认超时 4000 ms 远大于此。
另外试了「远处未加载 chunk 的箱子」：返回 **`NO_TARGET`「那个位置没有方块」** —— 客户端根本看不到方块，构造不出"一直在等"的等待期。
⇒ 结论：**超时/取消只能用注入构造**（下面三条都是注入，注入的只是 mineflayer 的 `openContainer` 返回值，产品代码路径原样执行）。

### 4.2 超时真的结束，且计时器被清

注入 `bot.openContainer = () => new Promise(() => {})`（永不 resolve）+ `{timeout:300}`：
- **311 ms** 返回 **`TIMEOUT`**（`开了 311ms 还没开`）；
- 计时器探针（包 `global.setTimeout/clearTimeout`）记录：该 300 ms 定时器 **`cleared:true`、`_destroyed:true`** ⇒ `finally { clearTimeout(timer) }` 真的执行了。

### 4.3 迟到窗口不污染 `currentWindow`

超时返回后，让 opener 在 800 ms 才 resolve，并模拟 mineflayer 真把窗口落到 `bot.currentWindow`：
- `closeLateIfOwned` 把它关掉（`closeCalls:["LATE-GHOST"]`）；
- 事后 `bot.currentWindow === null` ⇒ **没有残留窗口**（下一个任务不会撞 `BLOCKED`）。

### 4.4 等待期被取消后不许报 ok

置 `bot.interrupt_code`，opener 400 ms 后带窗口返回：
- 返回 **`INTERRUPTED`**（`ok:false`），窗口被关闭，`currentWindow=null`。

---

## 5. 探针自纠错（Captain 要求：给出「改前/改后」两版差异）

第一次 A2 跑出 `loadSnapshot: null`（燃料槽读成"没有"），我当时误以为是服务端行为。**实际是我探针的两个坑**，与产品无关：

| | 改前 | 改后 |
|---|---|---|
| NBT 读法 | 一次性 `data get block … Items` | 逐格 `Items[i].id` / `Items[i].count` |
| 为什么错 | **vanilla `/data get` 会把长结果截断成 `...`**：实测正文只有 **111 字符**，结尾就是 `{Slot: 1b, id: "minecraft:`（见 `probe-S2-rcon-packets.mjs` 的裸包转储：`bodyLen=111`）。一条多格容器只看到前 1–2 格 | 每次查询返回短值，不受截断影响 |
| RCON 客户端 | 首版**只读第一个响应包就 resolve** | 同一 id 的分片累加，静默 80 ms 再收尾 |
| 结果 | 熔炉"只有第 0 格"，燃料槽恒 `null`；箱子"只填了 1 格"（实际 24 格） | 直接读到 `input=16 / fuel=coal×1`、箱子 `used=24 / free=3` |

`result-S3-read-method-diff.json` 把三种读法在**同一个熔炉、同一时刻**并排跑了一遍（干净炉，先 `air` 后放 furnace）：

| 读法 | 实测结果 |
|---|---|
| ① 一次性 `data get … Items` | 正文 **112 字符**，结尾 `… {Slot: 1b, id: "…` 被截断（`endsWithEllipsis:true`）；用旧正则解析**只得到 1 格**：`[{slot:0, raw_iron, 16}]` —— **燃料槽直接"消失"** |
| ② 首版 RCON 客户端（首包定案） | 同样只有 112 字符（`legacyFirstPacketLen=112`，与①一致）⇒ 就算服务端不截断，多包响应也会被腰斩 |
| ③ 逐格 `Items[i].id/count` | `idx0=raw_iron×16`、**`idx1=coal×1`**、`idx2=空` ⇒ 燃料槽读得到 |

同一探针再跑一次真实装料：产品返回 `inputCount=16, fuelCount=2`（costMs 926），**逐格直接观测** `Items[0]=raw_iron×16`、`Items[1]=coal×1`，服务端 `clear … coal 0` = **6**（8−2）。
⇒ 「原 `loadSnapshot=null` 是**我的探针假象**，不是服务端把燃料槽清了」这句话，现在有直接对照证据。

**教训（写进流程）**：`data get block` 的长 NBT 不可用于"数格子"；数容器/熔炉内容一律逐格查，或用 `clear <p> <item> 0` 做服务端权威计数。

---

## 6. 环境副作用（Captain 要的回滚清单）

| 时间 | 动作 | 影响 | 回滚 |
|---|---|---|---|
| 2026-11-06 19:59:31 | `whitelist add probe2`（RCON） | 只写 `server/whitelist.json` 增加一条 `probe2`；**`server.properties` 未改** | `node T0/rcon.mjs "whitelist remove probe2"` |
| 2026-11-06 19:52:34 | `whitelist add probe1`（T0 阶段，仍生效） | 同上，`probe1` | `node T0/rcon.mjs "whitelist remove probe1"` |

**一行回滚（收尾时整条执行即可把白名单恢复成"没有这两条"）**：

```
node "E:\我的世界ai\docs\真机-20261106\T0\rcon.mjs" "whitelist remove probe2" ; node "E:\我的世界ai\docs\真机-20261106\T0\rcon.mjs" "whitelist remove probe1"
```

其它副作用（都是真机测试的正常痕迹，不是配置变更）：
- 世界内：测试平台 `(196..204, 70, 196..204)` 石台 + 熔炉 `(202,71,200)`；`(296..304,70,296..304)` 石台 + 箱子 `(303,71,300)`；测试区 `(400,70,400)` 附近一个箱子。**要清就 `/setblock` 成 air，不影响存档完整性**。
- 面板 `mindcraft/.mindserver-token` 每次启动重写（产品行为）。

---

## 7. 面板 agent 列表为空 —— 共享前提（web-probe 的 T4 依赖这条）

**T2 全程没有让 bot 经过 mindserver**：`probe2` 是裸 mineflayer 直连 25565，进程自己持有连接（连上即用，跑完即退）。
因此：① 面板 agent 列表**始终为空**；② 面板"停止"按钮停不掉它；③ 面板 `/console` 与 bot 的数据互不相干。
**这不是缺陷，是 T0 定的零费用方案**（本机无本地模型：profiles 只有指向 `api.llmgo.net` 收费中转的 `my-local.json`，`vllm.json` 指的 `127.0.0.1:8000` 无监听）。T4 若要往 Pinia store 注入地形 payload，请按"列表本来为空"这个前提做。

---

## 8. 环境拉起要点（复跑必读）

真机环境按轮次拉起，**PID 每轮都会变**，跨轮次的脚本不要复用旧 PID、更不要复用旧 token：

| 服务 | 端口 | 日志 | 注意 |
|---|---|---|---|
| Paper | 25565 + RCON 25575 | `T2/run-server-restart2.log`（`Done (20.229s)`）；首次启动证据在 `T0/run-server.log` | 起服后日志文件 `server/logs/latest.log` 会被占用 |
| 面板 | `127.0.0.1:8080` | `T2/run-mindserver-restart2.log` | **每次启动重写 `mindcraft/.mindserver-token`** ⇒ 旧 token 立即失效，脚本必须重读 |

**两条真机坑（都会让"再起一遍"失败，已各有实测证据）**：

1. **重复启动会撞日志文件锁**
   `Unable to delete file ...\server\logs\latest.log … 另一个程序正在使用此文件`
   —— 存活的 java 正占着该文件，**第二个服务端起不来**。
   ⇒ 「看到端口没起就再起一遍」是错的；先确认是不是已经在起（`Done (` 有延迟）。

2. **`.ps1` 里写中文路径会变乱码**
   `Cannot find module '...\docs\鐪熸満-20261106\T0\start-mindserver.mjs'`
   —— PowerShell 5.1 把无 BOM 的 UTF-8 脚本按 GBK 解码（同 §5 的坑）。
   ⇒ 脚本内一律用 `$PSScriptRoot` 推导路径，**不写字面量**。

> `T2/` 下的 `start-env-r3.ps1` / `run-server-r3.log` / `run-panel-r3.err.log`（21:15–21:21）
> 是 **Lead 的一次重复启动尝试**，两次都失败（正因上面两条坑），**不是验收证据**，可删；
> 保留它们只是为了给上面两条坑留实证。

---

## 9. 复现方法

```bash
cd E:/我的世界ai/docs/真机-20261106/T2
D:/Node/node.exe probe-A1-smelt-single.mjs      # 单件墙钟
D:/Node/node.exe probe-A3-fuel-short.mjs        # 1 煤要 16 → 早失败
D:/Node/node.exe probe-A4-want1-64.mjs          # want=1 背包 64 → 炉内只 1
D:/Node/node.exe probe-A2-want16.mjs            # want=16 全流程（~190s）
D:/Node/node.exe probe-A2d-coal-truth.mjs       # 燃料 2 份的直接观测（服务端权威计数）
D:/Node/node.exe probe-A6-timeline.mjs          # 186s 拆解（开窗时间表 + 燃烧曲线）
D:/Node/node.exe probe-B-store-partial.mjs      # 存 10 进只剩 3 格的箱子
D:/Node/node.exe probe-B2-deposit-attribution.mjs  # stored 多报 1 件的归因（含光标/守恒）
D:/Node/node.exe probe-C-container-open.mjs     # 开窗超时/取消/迟到窗口
D:/Node/node.exe probe-S3-read-method-diff.mjs  # 探针读法改前/改后对照
```

前置：`whitelist add probe2`（否则被踢）；每个探针自带建平台/放炉子/发物品/清背包，可独立跑；**跑 A2/A6 各约 3 分钟**。
所有结果 JSON 在 `result-*.json`，探针日志在 `run-*.log`。
