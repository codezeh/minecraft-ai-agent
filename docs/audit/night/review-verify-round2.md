# 复验 · D4 三条重做 + captain 必改项（第二轮）

> 复核官：gate-keeper ｜ 2026-11-06 03:5x–04:1x
> 对象：`6f46182`（F-AI-201 接线 + 执行侧 fail-closed）、`125b244`（F-AI-203）、`08e0f65`（F-EXEC-202 重做）、
> `bfdaca8`（一次性警告）、`5013250`/`8268c50`（我上轮的必改项 + 便宜改进）
> 方法：**读本体代码，不信单测的源码断言**（你的要求，也正合我意 —— 断言本身也可能是假的）。

---

## 判决

| 项 | 判决 | 一句话 |
|---|---|---|
| ① `6f46182` 接线是否真生效 | **通过** | 我自己读了 `prompter.js`/`history.js`，**四处调用点全部真的接上了**，不是死代码 |
| ② `permissions_unit 68/0` 是否真绿 | **通过（是加强）** | 3 条断言改写成新语义、**新增 1 条验执行侧行为**、`!endGoal` **双向都钉住**；无删除无 skip |
| ③ `08e0f65` 是否真不腰斩 | **通过** | `teleportBots()` 无条件在路径上；日志逐条如实，且主动写明"这是部分解决" |
| ④ `bfdaca8` 的 `globalThis` | **通过（建议改一处）** | 单进程单 profile 下没问题；但用 `Set` 比布尔更稳（理由见 §4） |
| ⑤ 我上轮的必改项 | **已修到位** | `exit 1` 前两行警告 + `$t.Length -eq 36` + `port` 归一 + `req.path` 去控制字符 |
| 🔴 **新发现（本轮最重要）** | **需你决定** | **fail-closed + 持久化 goal + `used_command` 无条件置 true ⇒ 一个"无人能停的 2 秒烧钱循环"** |

---

## 1. `6f46182` 接线 —— 我读了本体，**是真的**

你说"别信那 5 条断言"，我照做了。以下是我自己 grep 到的**实际调用点**：

```js
// src/models/prompter.js
219:  prompt = prompt.replaceAll('$MEMORY', fenceUntrusted(this.agent.history.memory, 'memory'));
221:  prompt = prompt.replaceAll('$TO_SUMMARIZE', stringifyTurns(to_summarize, { fenced: true }));
223:  prompt = prompt.replaceAll('$CONVO', 'Recent conversation:\n' + stringifyTurns(messages, { fenced: true }));

// src/agent/history.js
70:   this.memory = sanitizeExternalText(this.memory, 1500);

// src/utils/examples.js
79:   msg += `Example ${i+1}:\n${stringifyTurns(example)}\n\n`;   ← 按我的要求**不** fence（自有数据）✅
```

**四处全部接上**：
- `$CONVO`、`$TO_SUMMARIZE` → `fenced: true` ✅
- `$MEMORY` → `fenceUntrusted(memory, 'memory')` ✅
- 记忆**落盘前** → `sanitizeExternalText(memory, 1500)` ✅
- `examples.js` **正确地没有** fence（我上轮明确要求"别一把梭"，遵守了）✅

**我还顺手查了一条你没提的旁路**：`prompter.js:407` 有一段
```js
user_message += '$LAST_GOALS\n$STATS\n$INVENTORY\n$CONVO';
user_message = await this.replaceStrings(user_message, messages, null, null, last_goals);
```
这是**第二条**经过 `$CONVO` 的路径（user 消息，不是 system）。我确认它走的是**同一个** `replaceStrings`，
所以同样命中 222-223 行的 fenced 分支 ✅ **没有漏网。**

⇒ **上轮的"死代码"问题已彻底解决，本条从"防护=0"变成"防护在位"。**

---

## 2. `permissions_unit 68/0` —— **是真绿，且是加强**

我逐条比了 diff（`6f46182 -- tools/permissions_unit.mjs`）：

| 原断言 | 现断言 | 性质 |
|---|---|---|
| 没配 owner：陌生人按**信任** | 没配 owner：陌生人按**其他玩家（默认拒绝）** | **改写成新语义**（不是删） |
| 没配 owner：连 null 权限也按信任 | …也按其他玩家 | 改写 |
| 没配 owner：主人字段是空串也算没配（→信任） | …⇒ **其他玩家** | 改写 |
| —— | **新增**：`没配 owner：执行侧判据真的生效（走/停都不可用）` ← 直接验 `canRunCommand('!goToPlayer')` 与 `('!stop')` | **新增，且验的是行为不是等级** |
| 没配 owner：信任级**仍能用** `!endGoal` 急停 | 没配 owner：`!endGoal` **也不可用**（fail-closed，不是漏掉了） | 改写 |
| —— | **新增**：`配了 owner 后：信任级仍能用 !endGoal 急停（故意不升权）` | **新增 —— 正是我要求的"急停没被误伤"正向守门** |

我另外实跑了代价等级查询（不靠单测）：
```
$ node -e "commandLevel('!goal'/'!endGoal'/'!stop'/'!newAction')"
  !goal        owner      ← 仍是 owner-only ✅
  !endGoal     trusted    ← **仍是 trusted**（没被顺手升权）✅
  !stop        trusted
  !newAction   owner
```
`resolveLevel` 的默认分支也已实测改成 `return LEVEL.OTHER`（`permissions.js:154-175`）。

⇒ **断言一条没删、没 skip，反而多了 1 条"验行为"和 1 条"正向守门"。68/0 是真绿。**

**关于你那条推理，我认同**："fail-closed 后没人能设目标 ⇒ 不存在需要别人叫停的失控目标 ⇒ 不需要为急停保留信任级"。
逻辑成立。**但是** —— 有一个它没覆盖到的情形，见 §5（这是我本轮唯一的实质发现）。

---

## 3. `08e0f65`（F-EXEC-202 重做）—— **真的不腰斩了，日志也如实**

逐条核：
- **`teleportBots()` 无条件执行**：`tasks.js:526 await this.teleportBots();` —— 不在任何 `if (!cheatsAllowed)` 里 ✅
- **只跳 cheat 三段**：① `/clear <bot>` ② cooking 场景（`initiator = null` 而不是 `return`）③ `/clear <玩家>`
  三段各自带独立日志，且 `initiator = null` 后**流程继续** ✅
- **日志如实（这条我最看重）**：现在的输出是
  ```
  ✗ 跳过：`/clear <bot名>`（清空 bot 背包）
  ✗ 跳过：cooking 任务的场景搭建（内含 8 条 /fill = 100×100×10 不可撤销，以及 /kill …）
  ✗ 跳过：`/clear <玩家名>`（清人类背包）
  ✓ 照常：等待、teleportBots()、agent_count 检查、killAll()、startConversation
  ⇒ 结果：**场景没有搭起来**（这是"部分解决"，不是"cheat 被拦、其它全好"）。
  ```
  —— **它把"跳了什么 / 什么照常 / 结论是什么"三件事都写清了**，不再低报 ✅
- **它还主动交代了未修部分**：注释里明写"闸在调用方不在 sink，将来任何新调用都会静默绕过；
  彻底修法是 guardedChat 下沉，已单独立单" ✅ —— 这是**如实记账**，不是over-claim。

⇒ 我上轮的打回理由（功能回归 + 日志低报 + 校验在调用方）**前两条已解决**，第三条已被**如实登记为未修**。
**本条从"打回"改为"部分解决（已如实标注）"，通过。**

---

## 4. `bfdaca8` 的 `globalThis.__noOwnerWarned` —— 能用，但建议换一种写法

**你的判断（单进程单 profile 下没问题）我同意**，我核了三点：
1. 它只在"确实没配 owner"的分支里执行（`permissions.js:154` 之后、`return LEVEL.OTHER` 之前）
   —— 配了 owner 的 profile **不会**置位 ✅
2. `internal` / `otherBot` 两条路径在前面就 return 了（142/145 行）⇒ 只有**真实外部玩家**会触发，不会刷屏 ✅
3. 每个 agent 是**独立子进程**（`agent_process.js` 分别 spawn）⇒ 每个进程各有一份 `globalThis`，
   不会互相串味 ✅

**但两个建议（都不影响通过）**：
1. **用 `Set` 而不是布尔**：`globalThis.__noOwnerWarnedSet = new Set()`，key 用 `owner ?? ''`。
   理由：万一将来一个进程里跑多个 Agent（或 profile 热切换），布尔会把第二个 profile 的警告**吞掉**；
   而 Set 天然按"哪个 profile 缺 owner"分别记。**成本 1 行，消掉一个未来的坑。**
2. **不要挂在 `globalThis` 上，用模块级变量**（`let warnedProfiles = new Set()`）。
   理由：`globalThis` 让**单测无法隔离**（跑过一次就永久置位，后续断言里想再验"会警告"就得手动清 `globalThis`）。
   你现在没测这条，所以暂时无碍；但一旦要测，会被迫写 `delete globalThis.__noOwnerWarned` 这种脏东西。

---

## 5. 🔴 新发现：**fail-closed + 持久化 goal + `used_command` 无条件置 true ⇒ 一个"无人能停的 2 秒烧钱循环"**

这是本轮唯一的实质问题，**它不是你们任何单个修复的错，是两个"各自合理"的改动组合出来的新故障**。

### 5.1 链条（每一跳我都实读代码确认）

**第 1 跳：goal 会跨重启存活，且连"作者"一起存**
```js
src/agent/history.js:144-149
  self_prompting_state: …,
  self_prompt: this.agent.self_prompter.isStopped() ? null : this.agent.self_prompter.prompt,
  self_prompt_author: … this.agent.self_prompter.author ?? null,
```

**第 2 跳：恢复后，自提示回合按那个 author 定级**
（`agent.js` 注释原文：`自提示回合 → 设 !goal 的那个人（self_prompter.author），不是 'system'`）

**第 3 跳：fail-closed 之后，如果 profile 现在没有 owner（或被写成空串 / 名字打错一个字）**
```js
src/agent/permissions.js:148-154
  if (owner) { … }                 // 没配 owner 或 owner 是空串 → 不进来
  // 5) 没配主人：默认拒绝
  return LEVEL.OTHER;              // ← 所有命令（含 !endGoal）全部被拒
```

**第 4 跳（决定性）：命令被拒，但 `used_command` 仍然置 true**
```js
src/agent/agent.js:672-676
  let execute_res = await executeCommand(this, res, perm);   // 被拒时返回 '[权限] 拒绝 …'
  console.log('Agent executed:', command_name, 'and got:', execute_res);
  used_command = true;                                       // ← **无条件置 true**
```

**第 5 跳：`used_command = true` ⇒ `no_command_count` 归零 ⇒ 自提示循环永不自停**
```js
src/agent/self_prompter.js:78-91
  let used_command = await this.agent.handleMessage('system', msg, -1);
  if (!used_command) { no_command_count++; if (>= 3) STOPPED }
  else { no_command_count = 0; await sleep(this.cooldown) }   // cooldown = 2000ms
```

### 5.2 结果

**一个"有人设过、但当前 profile 不认主人"的 goal，会变成每 2 秒一次 LLM 调用的循环，且：**
- 模型每轮都会发命令（自提示提示词明写 "Your next response MUST contain a command"），
- 命令 100% 被权限拒（OTHER），
- **但 `used_command` 仍 true ⇒ 循环永不停**，
- 而 `!endGoal` 也是 TRUSTED ⇒ 同样被拒 ⇒ **玩家在游戏里叫不停它**，
- `max_commands: -1` ⇒ 单轮命令数还是 Infinity。

⇒ **只能靠改/删 `memory.json` 或把 owner 补回去才能停。** 按量计费下这是**真金白银**，而且它恰好是
`F-AI-202 ③（循环无上限）`那个"最费钱的一条"**被 fail-closed 意外点燃**。

### 5.3 触发条件有多现实（我不想夸大，所以列清楚）

| 触发方式 | 现实度 |
|---|---|
| 用过 `my-local`（owner=HEAVENZEH）设过 `!goal` → 之后切到 `deepseek`/`defaults/*`（owner 实测全 null） | **很现实**（切 profile 是常规操作） |
| profile 里 `owner` 打错一个字 / 写成 `" "`（空串，`permissions.js` 明确按"没配"处理） | **很现实**（我上轮就见过这个判据被单测覆盖） |
| 把配置分享给别人、对方没改 owner | 可能 |

### 5.4 requiredFix（三选一，我推荐第 1 条）

**① 最小、最准（推荐）**：让"被权限拒绝的命令"不算 `used_command`。
```js
// src/agent/agent.js 命令分支
let execute_res = await executeCommand(this, res, perm);
used_command = true;
if (typeof execute_res === 'string' && execute_res.startsWith('[权限]')) {
    // 权限拒 = 这条命令**没有真的执行** ⇒ 不该算"用过命令"，否则自提示循环会被永久喂活
    used_command = false;
}
```
> 注意：这会让"权限拒绝"在自提示回合里等同于"没命令"⇒ 连续 3 轮就 STOPPED，正是想要的。

**② 也可（治本但改动大）**：给 `self_prompter` 加 `max_turns` + 总时长上限（即 `F-AI-202 ③`，一直 blocked 的那条）。

**③ 也可（最保守）**：`history.js` 恢复 goal 时校验作者等级——若 `resolveLevel(该 author)` 低于 TRUSTED，
**不恢复 goal**（`self_prompt = null`），并打一行日志说明"因 profile 未认主人，已丢弃上次的目标"。

**任何一条都能把这个洞堵上；三条一起做最稳。**

---

## 6. 我上轮的必改项 + 便宜改进：**已修到位**

`5013250` / `8268c50` 我抽查了：
- `start-panel.ps1`：`$t.Length -eq 36` 定长判据 + `exit 1` 前明确"服务已在后台运行、别重复双击（会撞端口）、要停请用 停止面板.bat" ✅
- `mindserver.js`：`port` 经 `Number.parseInt` 归一、`req.path` 去控制字符、`RATE_BUCKETS` 注释改成"防将来放开绑定后的长期累积，不是无限增长"（**注释与行为对齐了**）✅

---

## 7. 关于你问的第 ④ 条：commit 粒度，我的判断

**我不认为"宁可拆成红门禁的中间态"是对的。** 理由：

**commit 的价值是两个，而"一个 finding 一个 commit"只服务其中一个：**
1. **可回滚单元**（revert 一个 revert 干净）—— 这个要求的是"**内聚**"，不是"一个 finding"；
2. **归属可查**（"F-WEB-203 是哪个 commit 修的"）—— 这个要求的是"**可查**"，不是"一个 finding"。

**同文件交织改动天然是一个回滚单元**：拆开会得到两个"单独 revert 都会坏"的 commit ——
这**降低** 了价值 1，而你换来的价值 2 完全可以用更便宜的方式拿到。

**我建议的做法（三步，都不需要改写历史）：**
1. **加一份 `docs/audit/night/COMMIT-MAP.md`**：一行一个 finding → 对应的 commit sha + 文件 + 一句话。
   这样"归属可查"这件事有了**机器可读的权威答案**，谁都不用去解析 commit subject
   （我今晚三次因为 subject 里只写了部分 id 而去翻 diff，就是在为缺这份表付代价）。
2. **把"一个 commit 一个 finding"改成"一个 commit 一个可独立回滚单元"**，并在 commit body 里
   **按 finding 分节**写（你已经在这么做，做得很好 —— `6f46182` 的 body 就是我见过最清楚的）。
3. **只在"跨文件/跨子系统"时坚持拆开**：那种情况下拆开是**便宜的**（不同文件、无交织），
   而且能真正提升可回滚性。**同文件就不必硬拆。**

**一句话**：**归属清晰 ≠ 一个 finding 一个 commit；归属清晰 = 有一份 COMMIT-MAP + body 分节。**
你现在的做法只差第 1 步（COMMIT-MAP），不需要改提交习惯。

---

## 8. 复核动作（可审计）
```
读：git show 6f46182 / 08e0f65 / bfdaca8 的 diff 与 body
    prompter.js:218-223、history.js:68-70/144-149、permissions.js:142-175、
    tasks.js:411-460/524-530、agent.js:540-700（handleMessage 的 used_command 路径）、
    self_prompter.js:74-91
跑：grep stringifyTurns / fenceUntrusted / sanitizeExternalText 的真实调用点（不信单测断言）
    node -e 查 commandLevel('!goal'/'!endGoal'/…) → owner/trusted 与此前一致
    git show 6f46182 -- tools/permissions_unit.mjs 逐条比断言（改写 vs 删除）
    grep teleportBots 确认无条件调用
未做：起真实例跑自提示循环（node 不能 spawn）；gate:full（captain 跑）
```
