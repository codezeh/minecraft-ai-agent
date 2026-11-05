# 终审 R2①：技能与门禁线

> 分支 `audit/remediation-2026-11-05`（26 提交 / 138 文件；R1 后新增 6 个，其中 3 个落在本线）。
> 规程：`docs/audit/REVIEW-PROTOCOL.md`（含 R1 后新增的 §3.5「探针本身可能假绿」、§「反向覆盖核对」）。
> 基线：`00-REPORT.md` v2.1 + R1 的 `14/15/16/17`。
> **未改 `mindcraft/` 任何文件**（`git status` 为空，见 §8）。新增 2 个探针在 `docs/audit/probes/`，可复跑。

---

## 1. 一句话结论

# `PASS`

**挡门清单：空。** 本线 6 项（R1-a、R1-b、第 20、第 33、`ac477f3`、回归）**全部真修好**，0 条没修、**0 条修出新问题**。最危险的一处（第 20 条把 `waitUntil` 语义翻成原子语义，可能把 R1 刚修好的第 22 条打回去）**作者已经预判并挡住**——调用方谓词全部改成 `x || undefined`，且把陷阱写进了注释。

**但发现 2 条残留**（都低于挡门标准，见 §7）：① R1-a 不是"统一门控"，是给 `hyperbolic` 单独加了一个**新环境变量** `LOG_PROMPTS`，与既有的 `settings.log_all_prompts` 并存（两个开关）；② `skills.goodScaffold:1777` 与 `scaffold_blocks.isScaffoldBlock` 仍是**两份实现**（行为已对齐，但没合并）。

## 2. 判定总表

| # | 条目 | 判定 | 关键证据 | 三态 |
|---|---|---|---|---|
| **R1-a** | `hyperbolic.js` 无条件打印完整提示词 | **真修好** | `hyperbolic.js:50` 改为 `if (process.env.LOG_PROMPTS === '1') console.log(...)`；实测未设该变量时 `false`（不打印）。**全仓 19 适配器扫描：5 处已注释、1 处已门控、0 处无门控残留**。⚠ 但不是统一门控（见 §3） | **已实测**（门控语义 + 全量 grep） |
| **R1-b** | 错误码正则两个词法盲区（只认单引号、`[A-Z_]` 不含数字） | **真修好** | `preflight.mjs:64` 现为 `/\bfail\(\s*["']([A-Z0-9_]+)["']/g` —— **引号归一 + 含 0-9**；第二条 `:71` 收紧成「对象里带 `ok:` 的 code」。**三条注入（全大写/含数字/双引号）全部命中**（§4 实测输出）；作者自检 `preflight_regex_unit.mjs` **37 通过 0 失败** | **已实测** |
| **20①** | `isSafeHere` 只取 1 个敌对生物 | **真修好（薄包装）** | 改为 `hostilesNear(bot, pos, { radius: 12 })`（`query_safe` 里那个函数）——两边同一个函数、同一个半径、同一套名字表 | 静态确证（`skills.js:77`） |
| **20②** | `canReach` 硬编码 4.3 vs 原子层 5.1 | **真修好（薄包装）** | `skills.js:2035` `export function canReach(bot, pos, max = digReach())`；**实测 `digReach() = 5.1`**（`GOAL_LOOK_AT_DEFAULT_REACH = 4.5` 是交互距离，两者不同名不同值，用对了） | **已实测**（`digReach()` 取值） |
| **20③** | `waitUntil` 对 `false` 语义与原子层相反 | **真修好（薄包装）** | `skills.js:68` 改为 `atomWaitUntil(predicate, {timeoutMs, intervalMs, bot})` 再映射成 `{ok,waitedMs,reason,label,value}`；**两个真调用方谓词都改成 `\|\| undefined`**（`:529` waitForSmelt、`:1674` giveToPlayer），JSDoc 明写"返回 `false` 算完成" | 静态确证 + 调用方全量核查 |
| **33** | `goToGoal` 180s 不可中断（上轮"修好但零测试"） | **真修好 + 测试有鉴别力** | 基线 `goToGoal_interrupt_unit` **7/7 PASS**；**回滚版 3/7（4 条 FAIL 全是中断相关）** —— 见 §5 实测 | **已实测**（双向） |
| **`ac477f3`** | 垫脚清单喂 block id 而非 item id（活 bug） | **真修好** | **实测 block id ≠ item id**：`dirt 9/28`、`cobblestone 12/35`、`oak_planks 13/36`、`netherrack 272/347`（只 `stone 1/1` 巧合相同）；`scaffoldItemIds` 只查 `itemsByName`；A* 回归 `scaffold_ids_unit` **12/12**，含"错 id → count=0/`partial`/过不去 vs 正确 id → 9 节点/3 次放置" | **已实测** |
| **回归** | R1 已修项是否被本轮碰坏 | **全部通过** | 沙箱逃逸 **20 BLOCKED / 0 ESCAPED**；第 8 条 J3 `protectedPlaces` 长度 1 + `isProtected`→`landmark`；第 21 条 `isAttackable(player)=false`/`zombie)=true`、skills.js 引用 5 处 | **已实测（复跑）** |

---

## 3. R1-a：提示词日志

**改法**（`hyperbolic.js:49-50`）：
```js
// 无条件写进 stdout / logs/mindcraft-console.log。要看提示词请显式开 LOG_PROMPTS=1。
if (process.env.LOG_PROMPTS === '1') console.log('Messages:', messages);
```

**全 19 个适配器状态（`grep -rn "Messages:" src/models/*.js`）**：

| 文件:行 | 原状态 | 现在 |
|---|---|---|
| `hyperbolic.js:50` | **无条件打印**（R1 指出的那一处） | **已门控** `LOG_PROMPTS === '1'` |
| `deepseek.js:36` | 已注释 | 注释（不变） |
| `grok.js:37` | 已注释 | 注释（不变） |
| `mercury.js:43` | 已注释 | 注释（不变） |
| `qwen.js:35` | 已注释 | 注释（不变） |
| `vllm.js:51` | 已注释 | 注释（不变） |
| 其余 13 个 | 无该语句 | 无 |

**门控默认值实测**：
```
LOG_PROMPTS 未设 → false (不打印)
LOG_PROMPTS=1  → true  (打印)
```

**判定：真修好**（泄漏面已关，默认关闭）。**但回答队长的那个问题：不是"统一门控"，只改了 `hyperbolic` 一个文件。**

残留（Nice 级）：现在有**两个开关**——
- `settings.log_all_prompts`（默认 `false`，`settings.js:57`），由 `prompter.js:419` 用于**写文件**；
- `process.env.LOG_PROMPTS`（默认未设），只管 `hyperbolic` 的 **stdout**。

两个都默认关，所以**不泄漏**。但运维要知道"想抓提示词得开两个地方"，且 `LOG_PROMPTS` 没进 `settings_spec.json` / `auth_gate.js:140` 的白名单（那里只有 `log_all_prompts`）。**建议合并成一个**（用 `settings.log_all_prompts` 覆盖适配器级打印），避免将来有人只开一个以为全开了。

---

## 4. R1-b：错误码正则的词法盲区

**现值**（`preflight.mjs:64` 与 `:71`，从源码抽出验证）：
```
[0] /\bfail\(\s*["']([A-Z0-9_]+)["']/g
[1] /\{\s*ok:\s*(?:true|false)[^{}]{0,300}?\bcode:\s*["']([A-Z0-9_]+)["']/g
```
→ ① 引号归一 `["']`（原来只认 `'`）② 字符类含 `0-9`（原来 `[A-Z_]`）。**两个盲区都补了。**

**三条注入实测**（`probes/t24-r1b-regex-injection.mjs`，从源码抽正则后逐条喂样本）：
```
PASS 命中[0]   1 全大写+下划线+单引号（原来能抓）   ←  "fail('T23_UNREGISTERED_CODE')"
PASS 命中[0]   2 含数字（R1-b 前会漏）              ←  "fail('ZZPROBE2X')"
PASS 命中[0]   3 双引号（R1-b 前会漏）              ←  'fail("ZZPROBEDQ")'
PASS 命中[0]   4 常规 fail 调用（不能坏）           ←  "  fail('NO_TARGET', 'x')"
PASS 命中[1]   5 ActionResult 形态（第二条正则的目标）←  "{ ok: false, code: 'PREEMPTED' }"
PASS 正确不命中  6 纯数据载荷 code（收紧后应不命中）  ←  "code: 'DIED'"
结论：三条注入（含数字码、双引号码）全部命中 —— R1-b 两个词法盲区都已修好。
```
作者自带的 `tools/preflight_regex_unit.mjs`：**37 通过 / 0 失败**，其中包含「正例：**字符串里**的码也必须仍被抓（剥注释 ≠ 剥字符串）」「正例：含引号的正则字面量之后，代码里的码仍被抓（防整段错位）」——这两条正好覆盖 R1 踩过的"剥注释把代码剥掉"的坑。

**判定：真修好。** 顺带确认：第二条正则收紧成"对象里带 `ok:`"之后，`code: 'DIED'`（任务板停止码）**正确不再命中**——这正是 R1 里判据错、源码没错的那一处，现在口径修正了。

**§3.5 自省（我的探针会不会假绿）**：我这条探针是**从源码抽出正则字面量再喂样本**，不是跑完整 preflight 的扫描链路。若 preflight 的"读文件→剥注释→喂正则"链路本身坏了，我的探针看不出来。**补偿证据**：作者自检 37/0 走的是真实链路；且 R1 阶段已实注入验证过 §3 会变红并点名文件。**结论：不假绿，但我的探针只证明"判据对"，不证明"链路通"——后者由作者自检覆盖。**

---

## 5. 第 20 条：三处分叉逐一

| # | 分叉点 | 修法 | 判定 |
|---|---|---|---|
| ① | `isSafeHere` 只报 1 个敌对生物 | 改调 `query_safe.hostilesNear(bot, pos, {radius:12})`，与原子层**同一个函数** | 薄包装 ✅ |
| ② | `canReach` 默认 `4.3` | 改 `max = digReach()`，**实测 = 5.1** | 薄包装 ✅ 语义判断见下 |
| ③ | `waitUntil` 的 `false` 语义相反 | 改调 `atomWaitUntil` 并映射返回形状 | 薄包装 ✅ 回归风险见下 |

**② 的语义判断（队长特别点名）**：`digReach()` 返回 **5.1**，而 `GOAL_LOOK_AT_DEFAULT_REACH` = **4.5**。这两个是**不同的量**：5.1 是"挖掘能达到的距离"（`act_dig` 的 `maxReach` 也是 5.1），4.5 是"射线交互（右键）的距离"。`skills.canReach` 在 v2.1 被指出的问题就是"同一问题两个答案（4.3 vs 5.1）"，对齐到原子层的 5.1 = 对齐到既有唯一真相。**对挖掘场景正确**。若将来有调用方拿它判"能不能右键交互"，应该用 4.5（`GOAL_LOOK_AT_DEFAULT_REACH`）——目前 `canReach` 的调用方（`collectBlock` 等）都是挖掘语境，**当前无误**。

**③ 的回归风险（本轮最该盯的一处，作者已挡住）**：原子语义下 `predicate()` 返回 `false` = **已完成**。而 `giveToPlayer` 的谓词原来是 `() => given`（布尔）——"还没收到"返回 `false` → 会被判成完成 → `got.ok=true` → **giveToPlayer 立即返回 true**，把 R1 的第 22 条修复打回去。
**实测调用方全部已改**：
```
skills.js:529  waitForSmelt:  () => !!furnace.outputItem() || undefined
skills.js:1674 giveToPlayer:  () => given || undefined
```
并且 `giveToPlayer:66` 留了注释：「`() => given` 在'还没收到'时返回 false，原子层会把 false 当已完成」。
**外部调用方核查**：`grep` 全树，`skills.waitUntil` 只在 `skill_library.js:43` 作为**技能名注册**出现，`tasks/` 下 0 处，无其他调用方 ⇒ **改动面封闭**。
模型侧影响：`skills.waitUntil` 在 `always_show_skills` 白名单里，模型会直接调；JSDoc 与示例（`:79`）已改成 `> 3 || undefined` 并明写"返回 `false` 算完成" ⇒ **模型有明确指引**。

**判定：三处全真修好，且第 ③ 处最危险的回归被作者提前挡住。**

---

## 6. 第 33 条：测试鉴别力实证（回滚会不会变红）

**做法**：不改 `mindcraft/`。测试自带反向入口 `SKILLS_MODULE=<path>`（`goToGoal_interrupt_unit.mjs:30`）。我写了一个 ESM 垫片 `probes/t24-red33-skills.mjs`：`export *` 全量转发真实 `skills.js`，**本地显式导出 `goToGoal` 覆盖成修复前行为**（只有 180s 硬上限、不查 `interrupt_code`）。

**基线（真模块）**：
```
PASS 没中断时 goToGoal 正常返回 true（守卫没遮挡正常路径）  耗时=24ms goto=1
PASS goToGoal 置 interrupt_code ⇒ INTERRUPTED              code=INTERRUPTED 耗时=223ms
PASS 用时远小于 180s 硬超时（不是靠超时兜底）                223ms << 180000ms
PASS 中断分支调了 pathfinder.stop()（goto 仍在进行中时就叫停） 最早 223ms
PASS useDoor：isMoving 恒 true 时被打断                     1013ms
PASS goToBed：isSleeping 恒 true 时被打断                   513ms
PASS 三处中断守卫 + 180s 硬超时都在源码里
===== 7/7 通过 =====
```

**红版（回滚后）**：
```
被测模块：skills=…/t24-red33-skills.mjs
PASS 没中断时 goToGoal 正常返回 true（守卫没遮挡正常路径）
FAIL 中断后应尽快返回                看门狗 5s 到了还没返回（goto 从未 settle ⇒ 没有中断支）
FAIL 中断必须是"真的停下来"而不是等超时  耗时=5007ms
FAIL 中断分支应调用 pathfinder.stop()   stop=[] 中断时仍在跑的=0
PASS useDoor / PASS goToBed
FAIL 源码里缺少中断守卫               ← 结构断言：垫片里没有那三处守卫
===== 3/7 通过 =====
```

**判定：测试真有鉴别力。** 关键设计细节（值得记录）：
- 桩 `pathfinder.goto` **永不 resolve**（模拟"目标不可达但还在傻走"），所以去掉中断支后只能等看门狗 → **5s 超时即红**，不会"碰巧通过"；
- 用例 ④ 用**会 resolve 的 goto** 单独验"守卫没把正常路径也掐掉"，并断言 `中断式 stop === 0`；
- 断言 `< 1000ms` 而不是 `< 180s`，**排除了"靠硬超时兜底"的假过**。

**§3.5 自省**：红版是我手写的垫片，不是"真实源码回滚"。它忠实还原了"无中断轮询"这一件事（其余导出走真模块），但**不能证明"整份旧 skills.js 会红"** —— 只能证明"去掉中断支会红"。对"测试是否有鉴别力"这个问题，这已经足够。

---

## 7. `ac477f3` 专项：垫脚清单 block id vs item id

### 7.1 这个 bug 是真的，而且面很大（实测 minecraft-data 1.21.8）
```
dirt blockId= 9   itemId= 28   相同? false
  stone:        blockId=1   itemId=1   同=true   ← 唯一巧合相同
  cobblestone:  blockId=12  itemId=35  同=false
  oak_planks:   blockId=13  itemId=36  同=false
  netherrack:   blockId=272 itemId=347 同=false
```
⇒ 提交说明里的「dirt blockId=9 / itemId=28」**完全属实**。pathfinder 的 `scafoldingBlocks` 按 `item.type === id` 计数，喂 block id 时**除 stone 外全部数不到** → `countScaffoldingItems()=0` → A* `remainingBlocks=0` → 垫脚分支静默 return。后果正是"背包里有木板、遇沟坎却绕远路或过不去，且不报错"。

### 7.2 与 `git-rescue` 里那段 stash 的关系
`docs/git-rescue-20261105/README.md` 记录的未落地功能叫 `scaffoldItemIds`；本次落地的导出名**就是 `scaffoldItemIds`**（`scaffold_blocks.js:117`）+ `scaffoldIdReport`（诊断用）。⇒ **就是同一段功能被落地了**，不是另起一套。（我未逐字比对 stash 原文，见 §8 盲区。）

### 7.3 两处入口都修了吗
- `scaffold_blocks.js:117 scaffoldItemIds()` → 内部只查 `itemsByName`（契约断言 `scaffold_ids_unit` 有覆盖：「只查 itemsByName（不再碰 blocksByName）」）。
- `nav_pathfinder.js:83 const ids = scaffoldItemIds(bot)` ← 生产入口已切。
- `skills.js` 侧同族：`goodScaffold` 正则仍在（见 7.4）。

### 7.4 选材口径对齐（队长点名）
`scaffold_blocks` 的判定是 `SCAFFOLD_EXACT`(Set) + `SCAFFOLD_SUFFIX ['_planks','_log']`；`skills.goodScaffold:1777` 是另一条正则。**逐名对比 10 个样本，两者判定完全一致**：
```
dirt/stone/cobblestone/oak_planks/oak_log/netherrack/gravel → 两边都 true
stone_bricks / oak_slab / diamond_block                    → 两边都 false
```
⇒ **口径已对齐**（注意：`goodScaffold` 里那个 `_slab` 选项因 `^…$` 锚定是死分支，两边都不认 `oak_slab`，所以不产生分歧）。
**但仍是两份实现** → 残留（Nice）：改一处忘另一处就会重新分叉，这正是 v2.1 反复记的同一种病。建议 `goodScaffold` 直接改调 `isScaffoldBlock()`（一行）。

### 7.5 "真 A* 回归"是什么
`tools/scaffold_ids_unit.mjs`（新，274 行）—— **12/12 通过**，其中真的跑了 A*：
```
PASS skills.buildMovements：清单喂 block id ⇒ 数到 0、**到不了对岸**（这就是那个 bug）  count=0 status=partial 节点=2 toPlace=0
PASS skills.buildMovements：id 类型决定"垫过去"还是"过不去"  垫脚 9 节点/3 次放置 vs 错 id 2 节点/0 次放置(status=partial)
PASS 对照（背包无垫脚料）⇒ 关掉搭桥、过不去
PASS scaffold_blocks.js 只查 itemsByName（不再碰 blocksByName）  itemsByName ✓ / blocksByName ✗
PASS skills.buildMovements 的垫脚清单只查 itemsByName            itemsByName ✓ / getBlockId ✗（已剥注释，只看代码）
```
⇒ 不是"断言某个字段等于某个值"的弱测试，是**跑真 A\* 比较两条路径的节点数与放置次数**。这是本轮质量最高的一处测试。

**判定：真修好。**

---

## 8. 回归检查（复跑，不转述上轮）

| 项 | 复跑命令 | 结果 |
|---|---|---|
| **第 1 条 沙箱逃逸** | `node docs/audit/probes/t19-ses-escape-review.mjs` | **BLOCKED=20 / ESCAPED=0**；`skills.log` 仍不可替换（`Cannot assign to read only property`）→ 未回退 |
| **第 8 条 J3 保护清单** | `node docs/audit/probes/t19-j3-protected-places.mjs` | 写入端仍扁平 `{x,y,z,note,lastUsed}` → `protectedPlaces` 长度 **1** → `isProtected: protectedBy=landmark` → **PASS** |
| **第 21 条 攻击闸** | `node -e` 直调 `act_attack.isAttackable` | `player=false` / `zombie=true`；`skills.js` 引用 `isAttackable` **5 处** → 未回退 |
| **第 20 条本身** | 见 §5 | 三处薄包装，调用方已改 |
| **第 26 条 0x08 / 第 34 条 partial** | 不在本线（R1 已实测） | 本轮改动未触及 `preflight.mjs` 的这两段（该文件的改动是 `:64/:71` 的正则，与 0x08 无关） |

**结论：本轮新改动没有碰坏 R1 已确认修好的东西。**

---

## 9. 残留（都不挡门）

| # | 残留 | 级别 | 最小修复 |
|---|---|---|---|
| 1 | R1-a 形成了**两个开关**：`settings.log_all_prompts`（写文件）与 `process.env.LOG_PROMPTS`（hyperbolic 的 stdout）。两者都默认关，故不泄漏；但只开一个会以为全开了。且 `LOG_PROMPTS` 不在 `settings_spec.json` / `auth_gate.js:140` 白名单里。 | Nice | 删掉 `LOG_PROMPTS`，让 `hyperbolic` 也读 `settings.log_all_prompts`（1 行） |
| 2 | `skills.goodScaffold:1777` 与 `scaffold_blocks.isScaffoldBlock` 是**两份选材实现**（行为已对齐，10 样本逐一验证一致）。 | Nice | `goodScaffold` 改成 `isScaffoldBlock(name)` 薄包装（1 行） |
| 3 | 第 20③ 把 `waitUntil` 语义翻成原子语义后，**模型侧**若写 `() => boolean` 会立即返回。已用 JSDoc + 示例明确"返回 `false` 算完成"，但这是**行为变更**，历史对话里若有旧写法会静默变快。 | Nice | 无（已文档化；若担心可在 `waitUntil` 里对"首轮即 false"打一条 debug 日志） |

---

## 10. 盲区（按规程 §6 重新声明）

1. **shell `spawn`/`npx` 仍 EPERM**：`unit_all` 全量没跑；我只跑单文件测试（`goToGoal_interrupt_unit`、`scaffold_ids_unit`、`preflight_regex_unit`）。
2. **文件复制在本机挂起**（E: 盘 `cp -r`/`tar` 两次超时）⇒ 第 33 条的回滚用的是**手写 ESM 垫片**而非真实源码副本。它证明"去掉中断支 → 测试变红"，不证明"整份旧 skills.js 会红"。
3. **未真跑 LLM 调用**：`LOG_PROMPTS` 只验了布尔语义，没在真适配器上调一次看有没有输出。
4. **`git-rescue` 的 stash 原文未逐字比对**：我只核了导出名 `scaffoldItemIds` 与之相符，没做行级 diff（该目录属历史归档）。
5. **`ac477f3` 自称跑了 `unit_all 97/97 + 4 跳过、lint_hard ✓、lint:tools 273 ≤ 278`** —— 这三项我**无法复跑**（EPERM），只能记录为"作者自报，未独立复核"。

## 11. 复跑清单

```bash
cd E:\我的世界ai
node docs/audit/probes/t24-r1b-regex-injection.mjs        # 预期：三条注入全 PASS
node docs/audit/probes/t19-ses-escape-review.mjs          # 预期：BLOCKED=20 ESCAPED=0（回归）
node docs/audit/probes/t19-j3-protected-places.mjs        # 预期：判定 PASS（回归）
cd mindcraft
node tools/goToGoal_interrupt_unit.mjs                     # 预期：7/7
SKILLS_MODULE="file:///E:/%E6%88%91%E7%9A%84%E4%B8%96%E7%95%8Cai/docs/audit/probes/t24-red33-skills.mjs" \
  node tools/goToGoal_interrupt_unit.mjs                   # 预期：3/7（4 条中断相关 FAIL）= 鉴别力
node tools/scaffold_ids_unit.mjs                           # 预期：12/12
node tools/preflight_regex_unit.mjs                        # 预期：37 通过 0 失败
cd .. && cd mindcraft && git status                        # 预期：空
```
