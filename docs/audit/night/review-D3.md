# D3 执行体部 · 复核记录（t15）

> 复核官：gate-keeper ｜ 2026-11-06 02:1x–02:3x
> 对象：`queue/claimed/` 里的 D3 条目（**`done/` 是空的**）+ 工作区 diff
> 环境：本会话 node 不能 spawn ⇒ `gate:full` 无法运行（captain 执行且当前 95/97）。
> **注意：D3 全部改动尚未提交**（`git status` 11 个文件 `M`）⇒ 本复核对象是**工作区**，没有 commit sha 可引用。

---

## 0. 判决

**通过 2 / 打回 1**（另有 1 条部分完成、2 项门禁/流程问题）

| 条目 | 判决 | 一句话 |
|---|---|---|
| `F-EXEC-201` speak RCE | **通过** | 结构性堵死（spawn + 字面量 argv + 文本只走 stdin），不是黑名单过滤 |
| `F-EXEC-202` 38 处裸斜杠 | **打回** | 闸**确实挡住了**（我一开始怀疑错了，已自查纠正）；但它靠"跳过整个后续流程"实现 ⇒ ①**功能性回归远超 cheat 范围且日志低报** ②闸在调用方不在 sink ⇒ 换调用方即绕过 |
| `F-EXEC-203` 贴图路径穿越 | **通过** | 白名单 `^[a-z0-9_]{1,64}$` **强于** resolve+前缀（连点与斜杠都不允许）；`agentName` 只作对象键不当路径 |
| `F-AI-202` ①②（本轮一并做） | **通过（①②）** | `!goal` 升 OWNER_ONLY、**`!endGoal` 被正确保留在 TRUSTED**、转义顺序正确、超限可见截断；③ blocked 合理 —— **但单测未同步，仍红** |

**两条必须先说清的门禁事实**：
1. **`gate:full` 现在不绿**（captain 实测 95/97）。`permissions_unit` 4 条红 = 我在预审里预告的那几条断言（`trustedCan` 仍含 `!goal`、"没配 owner 陌生人可用"）。**按本任务判据「gate:full 必须真绿」，D3 现在不能 PASS** —— 这条不是 202 的错，但它是 PASS 的前置。
2. **所有 D3 改动未提交**。PLAYBOOK §3 要求"一条修复一个 commit"，现在 11 个文件混在工作区，**无法按 sha 归档，也无法回滚单条**。

---

## 1. `F-EXEC-201`（speak.js 命令注入）—— 通过

### 1.1 是不是结构性堵死？—— 是，这是本条的关键

```js
const file = isWin ? 'powershell' : isMac ? 'say' : 'espeak';
const argv = isWin ? ['-NoProfile','-NonInteractive','-Command', <常量脚本>]
           : isMac ? [] : ['--stdin'];
child = spawn(file, argv, { stdio: ['pipe','ignore','ignore'], windowsHide: true });
child.stdin.end(String(txt));
```

我逐项核了任务点名的"参数是否仍正确传递"：

| 检查项 | 结果 |
|---|---|
| 还有没有 `exec`？ | `-import { exec, spawn }` → `+import { spawn }`；**`exec` 已完全移除** ✅ |
| 还有没有把文本拼进命令串？ | **没有**：`argv` 四个元素全是字面量，唯一变量 `file` 也来自三选一字面量 ✅ |
| 有没有 `shell: true`？ | 全仓 `grep -rn "shell:\s*true" src/ main.js` → **无输出** ✅ |
| 参数类型/顺序 | PowerShell 的 `-NoProfile -NonInteractive -Command <script>` 顺序正确；`say` 空数组＝读 stdin；`espeak --stdin` 正确 ✅ |
| 文本类型 | `child.stdin.end(String(txt))` 显式转字符串 ✅ |
| 生命周期 | `finished` 标志防 `error`+`close` 双触发；stdin `EPIPE` 被吞（由 close 推进）；`spawn` 同步抛错被 try/catch 兜住 ✅ |

⇒ **"命令行内不存在任何可变文本"这个前提成立**，所以没有 shell 层可逃逸。
这与我原 finding 里说的"转义黑名单永远漏"是本质区别：**没有可转义的东西了**。**不是黑名单式过滤，通过。**

### 1.2 `speak` 移出运行期白名单 —— 已落地且未破坏门禁

```
auth_gate.js: -'init_message','only_chat_with','speak','language','allow_vision'
             +'init_message','only_chat_with','language','allow_vision'
注释也从"三条故意排除"改成"四条故意排除"，并把理由写清（语音＝把模型输出送进本机进程，应由人改 settings 后重启决定）
mindserver_gate_unit: 49 passed / 0 failed（exit 0）← 比上轮多 1 条断言，说明确实加了断言
```

### 1.3 两条 caveat（不阻塞通过，但要留档）
1. **mac/linux 两个分支仍未实测**（无该平台）。`say` 无参数读 stdin、`espeak --stdin` 依据标准 CLI 行为判定正确，但"正确"是推理不是实跑。落地后需各跑一次正向对照。
2. **我那条"别加 `InputEncoding=UTF8`"的实测结论还没写进代码注释**。当前注释只写了"文本只从 stdin 进，绝不进命令行"，**没有**"Windows 上加了 InputEncoding 反而中文乱码（2026-11-06 实测）"这句。captain 已列为强制要求，还差这一笔 —— 否则下一个人会"顺手加固"把中文 TTS 弄坏。

---

## 2. `F-EXEC-202`（38 处裸斜杠）—— **打回**

### 2.1 先纠正我自己：闸**确实**挡住了，patch-smith 的断言成立

我一开始怀疑"`initBotTask()` 不是唯一入口、`/fill` 在 `CookingTaskInitiator.init()` 里、`/kill` 在 `killEntities()` 里 ⇒ 闸漏了"。**我把调用链走完，发现我错了**：

```
agent.js:336   if (settings.task) { this.task.initBotTask(); … }        ← 唯一外部入口（已 grep 确认）
tasks.js:429   if (process.env.ALLOW_TASK_CHEATS !== '1') { … return; }  ← 闸
tasks.js:434   await bot.chat(`/clear ${this.name}`)                     ← 闸后，被跳过
tasks.js:444   this.initiator = new CookingTaskInitiator(...)            ← 闸后 ⇒ 闸生效时 initiator 从不被创建
tasks.js:504   if (this.initiator && …) await this.initiator.init();     ← 因此 8 条 /fill 不会执行 ✅
tasks.js:508   await this.teleportBots();                                ← 闸后 ⇒ /tp 不会执行 ✅
```
全仓 `initiator.init()` 与 `teleportBots()` 各自**只有这一个调用点**（`grep` 确认）。
⇒ **在当前代码里，闸确实切断了 38 处全部 cheat。patch-smith 的"fail-closed 于唯一入口"成立，我先前怀疑是错的。**

（我把这个纠正过程写出来，是因为我不想用"结论对了但论证是错的"去打分——闸有效，但**它有效的方式**有问题，见下。）

### 2.2 打回理由 1：**功能性回归远超 cheat 范围，而且日志低报了影响**

闸的 `return` 跳过的**不只是 cheat**，而是 `initBotTask()` 的**整个后半段**：

| 被一起跳过的东西 | 是不是 cheat | 后果 |
|---|---|---|
| `/clear <bot>` | 是 | — |
| 500ms / 3000ms 等待 | 否 | — |
| `this.initiator` 赋值 | 否 | cooking 场景完全不搭 |
| 人类玩家 `/clear` | 是 | — |
| **`teleportBots()`** | **否** | **bot 不会被传送到测试点**，会在原地乱走 |
| `agent_count` 检查 + `killAll()` | 否 | 缺人时不会清理，卡住 |
| `!startConversation` | 否 | 多 bot 任务不会开始对话 |
| **`setAgentGoal()`**（agent.js:337，**与 initBotTask 并列、不在闸内**） | 否 | **仍然会执行** ⇒ 半初始化状态：目标设了但场景没搭 |

而日志只说：
```
[F-EXEC-202] 拒绝执行任务脚本的 cheat 初始化：未设 ALLOW_TASK_CHEATS=1。
  本次本会执行：/clear <bot名>，以及 cooking 任务下的 8 条 /fill…与 /kill…
```
⇒ **低报**。真实影响是"任务初始化被腰斩"，不是"只跳过几条 cheat"。
用户（或未来的我）照这条日志排查，会得出"只有 cheat 被挡、其它正常"的错误结论 —— 而这正是我今晚一直在防的"提示在骗人"。

**可复现路径（给修补者）**：设 `settings.task = true`、**不设** `ALLOW_TASK_CHEATS`，起两个 bot 跑 cooking 任务：
期望（按日志）"只是不执行 /fill"；**实际**是 bot 不传送、不对话、缺人也不 killAll，而 `setAgentGoal()` 照样设目标。

### 2.3 打回理由 2：闸写在**调用方**，不在 sink —— 换个调用方就绕过

任务判据原文："**有没有把校验写在调用方而不是危险函数内部（换个调用方就绕过 = 打回）**"。

现状：闸在 `initBotTask()` 里；而 cheat 实际住在这些**公开方法**里，它们自身不带任何判据：
- `CookingTaskInitiator.init()`（cooking_tasks.js:9-24，8 条 /fill）
- `CookingTaskInitiator.plantCrops / plantSugarCane / plantMushrooms / killEntities`（:222-276）
- `Task.teleportBots()`（tasks.js:542，6 处 /tp）
- `tasks.js:456/486/496` 的 `/clear`、`/give`

今天没有第二个调用点（我 grep 过），所以**当前不可利用**；但 `teleportBots()` 是 `Task` 的公开方法，
`initiator` 也可以被别处 new 出来。**任何一次未来的重构/新调用都会静默绕过这道闸**，而日志不会响。

这正是本任务要打回的形态，也是 patch-smith 自己在注释里承认的"先上总闸止血"——
**止血可以接受，但必须留下"血还没止住"的准确标记**，而现在日志的口径是"cheat 已拒绝"，
读起来像已经治好了。

### 2.4 requiredFix（两条，第 1 条是本质）

**① 把闸下沉到 cheat 的唯一出口**（治本，成本不高）：
在 `src/agent/tasks/` 内部加一个守卫出口，只对以 `/` 开头的聊天生效：

```js
// tasks/cheat_guard.js
export function guardedChat(bot, cmd) {
    if (String(cmd).trimStart().startsWith('/') && process.env.ALLOW_TASK_CHEATS !== '1') {
        console.error('[F-EXEC-202] 已拒绝一条 cheat 指令（未设 ALLOW_TASK_CHEATS=1）：', String(cmd).slice(0, 60));
        return Promise.resolve();
    }
    return bot.chat(cmd);
}
```
然后把 38 处的 `bot.chat(`/…`)` 换成 `guardedChat(bot, `/…`)`。
这样①校验在危险处（换调用方也绕不过）②**只拦 cheat，不再腰斩正常初始化**（teleport/对话/killAll 照常跑）
③每条被拒都有日志，不再是"静默半初始化"。

**② 若这一轮确实来不及逐处改**，那至少：
- 把 `return` 改成**只跳过 cheat 相关的三段**（`/clear`、`initiator`、人类清包），**保留 `teleportBots()` 等非 cheat 流程**；
- **把日志改成如实口径**：明确写"本次将跳过：/clear、8 条 /fill、/kill、**以及 teleportBots/对话初始化**"，别只列 cheat；
- 在 finding 里明确标 `部分解决（总闸止血，38 处未逐条收口）`，并**别把本条标成"已修"**。

---

## 3. `F-EXEC-203`（贴图路由路径穿越）—— 通过

与 `F-SEC-104` 是同一处代码的两个编号（patch-smith 已说明），我在 D2 轮已复核过，这里复核当前状态：

```js
app.get('/assets/item/:agent/:name.png', async (req, res) => {
    const agentName = req.params.agent;          // 只作 agent_connections[agentName] 的键，不进路径
    const rawName  = req.params.name;
    const itemName = String(rawName).toLowerCase();
    if (!/^[a-z0-9_]{1,64}$/.test(itemName)) {   // ← 白名单，在拼路径之前
        res.status(400).json({ ok:false, error:'invalid texture name' }); return;
    }
```

对任务判据"路径校验是否 `path.resolve` 后做前缀比对（只查 `..` 字符串 = 打回）"的回答：
- **这里用的是白名单正则，比 resolve+前缀更强** —— 白名单内**不可能出现 `.`、`/`、`\`**，
  所以 `..%2f..%2fsettings` 在进入任何路径拼接之前就被拦掉（我 t14 跑过 12 条正反用例，全对）。
- 前端真实请求是 mineflayer 裸名（`oak_planks`），与 `assets.items[itemName]` 查表口径一致 ⇒ **无误伤**。
- `agentName` 不作路径使用 ⇒ 无需前缀断言。
⇒ **通过**（白名单优于前缀比对，不必强求 resolve 式）。

---

## 4. `F-AI-202` ①②（D4 条目，本轮一并落地）—— 通过（①②），但单测未同步

### 4.1 我提的三处修正，patch-smith 全部采纳

```js
// permissions.js
+OWNER_ONLY_COMMANDS: [ '!goal', … ]        ← !goal 升权 ✅
 TRUSTED_COMMANDS:   '!stop','!stay','!stfu','!endGoal'   ← **!endGoal 被正确保留** ✅（我建议的核心）
```
```js
// prompter.js
let safeGoal = rawGoal
    .replace(/[\r\n\t]+/g, ' ')   // 折叠换行，不能另起一行伪造段落
    .replace(/\\/g, '\\\\')       // 反斜杠先转 ← **顺序正确**
    .replace(/"/g, '\\"');        // 再转双引号
if (safeGoal.length > 500) safeGoal = safeGoal.slice(0,500) + `…[已截断，原长 ${rawGoal.length}]`;
```
- 转义是**编码式**（不是黑名单）：`\` 先于 `"` 转，顺序正确，不会二次转义漏洞 ✅
- 换行/制表被折叠 ⇒ 无法伪造"（系统更新）…"段落 ✅
- 超限**可见截断**（带"已截断，原长 N"标记），**不是静默 slice** ✅ 且注释明确写了"这不是主防线，主防线是 owner-only"✅

### 4.2 但**单测没同步**，所以现在是红的
```
node tools/permissions_unit.mjs → exit 1，59 passed
```
正是我在预审里定位的两处：`trustedCan`（:64）仍含 `'!goal'`、`:181-182` 仍断言"没配 owner 陌生人可用"。
⇒ 这一条**代码对了、测试没跟上**，按"gate 必须真绿"的口径，**D3 整体不能 PASS**。
（captain 已交待 patch-smith 修，并同意新增"owner 配了 HEAVENZEH 时 `!goal` 可用"的正向断言——这条必须有，否则没人守"主人没被误伤"。）

---

## 5. 给 captain 的四句话

1. **`F-EXEC-201` 通过**：结构性堵死，不是黑名单。剩两笔小事：mac/linux 未实测要在 verify 里标注；**"别加 InputEncoding"那条实测结论必须写进注释**。
2. **`F-EXEC-202` 打回**，但**不是因为"没挡住"**（挡是挡住了，我一开始怀疑错了、已自查纠正）——
   而是因为①**它靠腰斩整个 initBotTask 实现**，把 teleportBots/对话/killAll 一起干掉，而日志只说"拒绝 cheat"，**低报了影响**；
   ②闸在调用方不在 sink，`teleportBots()`/`initiator.init()` 自身无判据，**换个调用方就静默绕过**。
   建议按 §2.4 的 `guardedChat` 下沉，或至少"只跳 cheat 段 + 日志说实话 + 标部分解决"。
3. **`F-EXEC-203` 通过**（白名单强于 resolve+前缀，不必强求前缀断言）。
4. **现在 D3 整体不能 PASS 的两个硬前提**：`gate:full` 未绿（permissions_unit 4 红）＋ **11 个文件全未提交**（无 sha、无法单条回滚）。

---

## 6. 复核动作（可审计）
```
读：claimed/{F-EXEC-201,F-EXEC-202,F-EXEC-203,F-AI-202}.md；git diff 的 speak.js / auth_gate.js /
    tasks.js / permissions.js / prompter.js / mindserver.js 关键段；agent.js:329-345
跑：grep 裸斜杠全量（templates/双引号两种写法）→ 分布 33+12+1（含注释）
    grep initBotTask/initiator/teleportBots 调用点（确认唯一入口）
    node tools/permissions_unit.mjs（exit 1，59 passed）、mindserver_gate_unit（49 passed，exit 0）、
         task_pickup_unit（exit 0）
    grep shell:true 全仓（无）
未做：gate:full（本会话不能 spawn）、真机跑 cooking 任务、mac/linux 实测
```

## 7. 我这一轮的两处自查纠正（主动记录）
1. **"D1 那 5 条 finding 被清空"是我错了** —— 它们在 `claimed/`，我 t13/t14 只看了 `inbox/` 与 `done/`。
   我已把因此误造的 4 份"重建记录"（F-SEC-104/205/206/208）与原件**合并成一份**（review 段落并入原件，
   `claimed → verified/inbox`），现在每份都含 `## review`，不再有重复。**教训：判"文件在不在"必须 `find queue -name "*.md"` 全目录扫。**
2. **我一开始怀疑 `ALLOW_TASK_CHEATS` 没盖住 `/fill`** —— 走完调用链发现**盖住了**。
   我在判决里把这个纠正过程写出来了，因为我不想用"结论恰好对上"掩盖"论证曾经是错的"。
