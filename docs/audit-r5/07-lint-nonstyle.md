# 07 · 8 条 lint 非风格项真伪核验（R5）

> 背景：T1 实测 `npm run lint` = 200 errors/47 文件，其中 8 条为**非风格**规则。
> 本文件逐条判定真伪。**未修改任何产品代码**（`git status --porcelain` 输出为空）。
> 探针口径：**退出码 0 = 缺陷成立，1 = 不成立**。

## 0. 结论速览

| 判定 | 条数 | 编号 |
|---|---|---|
| **REAL-DEFECT** | **1** | c（`action_manager.js:422`） |
| FALSE-POSITIVE | 7 | a、b、d、e、f、g、h |
| DEBT | 0 | — |

一句话：**8 条里只有 1 条是真缺陷（c：异常对象被转成字符串后再读 `.stack`，失败消息里的堆栈恒为 `undefined`）；其余 7 条全部误报**，不是"消不掉的红"，是 eslint 规则打在了**故意为之**（a/b/f）或**本仓不可达**（d/e）或**纯冗余转义**（g/h）的写法上。

## 1. 总表

| 编号 | 位置 | rule | 真实输出（eslint 原文） | 判定 | 影响面 | 证据文件 |
|---|---|---|---|---|---|---|
| a | `src/agent/library/flow_craft.js:415:9` | `no-dupe-keys` | `415:9  error  Duplicate key 'count'  no-dupe-keys` | **FALSE-POSITIVE** | 无。末尾 `count: produced` 是**故意压住** `...(lastData)` 可能带来的同名键；删掉它才会出错（探针实测会变成 999） | `evidence/lint-probes/repro-a-flow_craft.log`、`probe-a-flow_craft-dupe-count.log` |
| b | `src/agent/commands/index.js:204:13` | `no-fallthrough` | `204:13  error  Expected a 'break' statement before 'case'  no-fallthrough` | **FALSE-POSITIVE** | 无。`ItemName` 等分支补 `s` 后落入 `case 'string':`，而该分支体**只有一条 `break;`**；实测加显式 `break` 后 12 组输入行为差异 **0** | `evidence/lint-probes/repro-b-index.log`、`probe-b-index-fallthrough.log` |
| c | `src/agent/action_manager.js:422:13` | `no-ex-assign` | `422:13  error  Do not assign to the exception parameter  no-ex-assign` | **REAL-DEFECT**（低-中） | 每次代码执行抛异常，返回给模型的失败消息里 `Stack trace:` 后面恒为字面量 `undefined`；且错误行出现 `Error: Error:` 双前缀。堆栈只剩进程 stderr 里那两行 `console.error` | `evidence/lint-probes/repro-c-action_manager.log`、`probe-c-action_manager-ex-assign.log` |
| d | `src/agent/npc/controller.js:202:37`（**任务书写的 `library/npc/` 路径不存在，实际在 `agent/npc/`**） | `no-prototype-builtins` | `202:37  error  Do not access Object.prototype method 'hasOwnProperty' from target object  no-prototype-builtins` | **FALSE-POSITIVE** | 无。`this.data.built` 来自 `{}` 或 JSON.parse 的 profile（原型正常）；全仓 `Object.create(null)` 命中 **0** 处；唯一坏输入是"存在名为 `hasOwnProperty` 的键"，而键来自 4 个 construction 文件名，无此文件 ⇒ 不可达 | `evidence/lint-probes/repro-d-controller-realpath.log`、`probe-d-controller-hasOwnProperty.log` |
| e | `src/agent/tasks/construction_tasks.js:149:53` | `no-prototype-builtins` | `149:53  error  Do not access Object.prototype method 'hasOwnProperty' from target object  no-prototype-builtins` | **FALSE-POSITIVE** | 无。`bot.blockAt` 是 mineflayer 在 `inject()` 里赋的**实例自有属性**（`blocks.js:612`），`hasOwnProperty('blockAt')` 对真 bot 恒 true ⇒ 守卫按设计工作，不会误拦 `!checkBlueprint` | `evidence/lint-probes/repro-e-construction_tasks.log`、`probe-e-construction-bot-hasOwnProperty.log` |
| f | `src/utils/text.js:49:18` | `no-control-regex` | `49:18  error  Unexpected control character(s) in regular expression: \x00, \x08, \x0b, \x0c, \x0e, \x1f  no-control-regex` | **FALSE-POSITIVE** | 无。这是**专门用来剥控制字符**的净化正则（控制字符是"要删的目标"）；实测 0x00-0x1f+0x7f 除 `\t`/`\n` 外全部剥掉、零漏网、正文原样保留 | `evidence/lint-probes/repro-f-text.log`、`probe-f-text-control-regex.log` |
| g | `src/agent/commands/queries.js:59:21` | `no-useless-escape` | `59:21  error  Unnecessary escape character: \-  no-useless-escape` | **FALSE-POSITIVE** | 无。`\-` 在**模板字符串**里被 JS 丢弃，输出与 `-` **逐字节相同**（笔误，零行为差异） | `evidence/lint-probes/repro-g-queries.log`、`probe-g-queries-useless-escape.log` |
| h | `src/mindcraft/mindserver.js:491:46` | `no-useless-escape` | `491:46  error  Unnecessary escape character: \.  no-useless-escape` | **FALSE-POSITIVE**（规则维度）＋**附注：低危文案不一致** | 规则维度行为无损（单引号串里 `\.` → `.`）。附注：401 HTML 提示因此渲染成 `mindcraft.mindserver-token`，而同函数 `:499` 写的是 `mindcraft/.mindserver-token`，真实文件是 `<cwd>/.mindserver-token` ⇒ 用户照 HTML 提示去找会看到一个不存在的文件名 | `evidence/lint-probes/repro-h-mindserver.log`、`probe-h-mindserver-useless-escape.log` |

## 2. 唯一真缺陷：c) `action_manager.js:422`（no-ex-assign）

### 2.1 代码原文（`src/agent/action_manager.js:401-434`）

```js
} catch (err) {
    this._retireOperation(this.currentOperation);
    ...
    console.error("Code execution triggered catch:", err);
    console.error(err.stack);          // ← 417-419：这里打到进程 stderr
    await this.stop(stopReason);
    err = err.toString();              // ← 422：err 从此变成**字符串**

    let message = this.getBotOutputSummary() +
        '!!Code threw exception!!\n' +
        'Error: ' + err + '\n' +
        'Stack trace:\n' + err.stack+'\n';   // ← 427：字符串没有 .stack
    ...
    return { success: false, message, interrupted, timedout: false };
```

### 2.2 实测（探针 `probe-c-action_manager-ex-assign.mjs`，exit 0）

```
[静态] `err = err.toString()` 出现在源码位置 17064
[静态] `+ err.stack`                出现在源码位置 17246
[静态] toString 在读取 .stack 之前： 是（符合疑点）

[运行时] err = err.toString() 之后，typeof err.stack = undefined
[运行时] 生成的 message 末尾：
-----------
!!Code threw exception!!
Error: Error: boom-from-action
Stack trace:
undefined
-----------
```

两处真实后果：

1. **堆栈丢失**：`Stack trace:` 后面恒为 `undefined`。终端里另有两行 `console.error` 还有堆栈，但**消息本身**（给模型/网页的那份）永久失去堆栈。
2. **`Error: Error:` 双前缀**：`err.toString()` 已经产出 `"Error: boom"`，代码又拼了一次 `'Error: '`。同一行造成，一并记。

### 2.3 影响链（谁会被踩到）

- 触发条件：**任何** `runAction` 里执行的代码抛异常 —— 即模型的 `!newAction` / 任何动作函数 / 反射 mode 内部报错。这不是边角路径，是最常见的失败路径。
- 消息去向（已核对，三级）：① `action_manager` 返回 `{success:false, message, ...}`；② `commands/actions.js:78/81` 调 `formatActionResult(actionLabel, code_return, result)` → `src/agent/library/contract.js:212` 的 `truncate(codeReturn?.message ?? '')`；③ 该字符串作为动作结果回给模型（`modes.js:559` 另外直接 `console.log(... code_return.message)`）。
- 截断是否会把这一行吃掉（特意核实）：`truncate` 默认 `maxLines=80, maxChars=6000, head=25, tail=25`；消息第 3-4 行是 `Stack trace:` 与 `undefined`，属 head 保留区 ⇒ **不会被截掉**，模型确实看到 `Stack trace: undefined`。
- 后果：模型无法从失败消息里读出堆栈（它本来能据此判断是自己的参数错还是库内部错），排障信息降级为"unknown"。**不崩溃、不影响功能正确性**，属**诊断能力缺陷**（低-中）。
- 修法（本任务不改，仅供参考）：把 `err = err.toString()` 换成另起一个变量（如 `const errText = err.toString()`），并去掉重复的 `'Error: '` 前缀。改动 2 行，零风险。

## 3. 逐条误报的证据

### a) flow_craft.js:415 —— **FALSE-POSITIVE**（Lead 预判正确，已独立确认）

源码（`src/agent/library/flow_craft.js:404-417`）：

```js
return ok({
    craftedItem: itemName,
    count: produced,
    ...
    jobId,
    ...(lastData ?? {}),           // ★ 保留底层诊断（invAfter / limitUsed / tableBlockUsed …）
    count: produced,               // 但本层的 count 语义（产出数）要压在最后，别被覆盖
});
```

三条独立理由：

1. `...(lastData ?? {})` 是**运行时才知道内容**的展开。`lastData` 是 `craftOnce` 的 data，里面本来就可能带 `count` 字段 ⇒ **必须**在它之后再写一次 `count` 才能保证本层语义。
2. JS 对象字面量同名键**后者覆盖前者**（`{k:1,k:2}.k === 2`，探针实测）。
3. 探针反证：**删掉末尾那行**，`count` 会变成 `lastData.count = 999` —— 这才是错误。所以这一行不是冗余，是"最后压住"。

探针实测（exit 1）：

```
lastData.count            = 999
result.count              = 3
result.invAfter           = ["log"] (spread 带来的诊断字段仍在)
若删掉末尾 count 行 → count = 999 （错误的产出数）
字面量重复键 { k:1, k:2 } → 2 （后者胜）
```

> 说明：eslint 的 `no-dupe-keys` 无法区分"手误重复"与"故意覆盖 spread"。本处属后者，且**代码里自带注释说明**。想要 eslint 闭嘴应加 `// eslint-disable-next-line no-dupe-keys`，但那属于风格取舍，不是缺陷。

### b) commands/index.js:204 —— **FALSE-POSITIVE**（有意的 fallthrough）

`case 'BlockName': case 'BlockOrItemName': case 'ItemName':` 三个分支共用一句"补 `s`"，然后**落入** `case 'string':`。

关键事实：**`case 'string':` 的分支体只有一条 `break;`**（源码 204-205 行）⇒ 落进去等于什么都不做。

探针实测（exit 1）：5 组输入全对（`oak_plank`→`oak_planks`、`wheat_seed`→`wheat_seeds`、`diamond`→`diamond`、`string` 不补 s、`int('42')`→42），且**改成显式 `break` 后 12 组对照行为差异 = 0**。

⇒ 唯一"问题"是缺一条 `// fallthrough` 注释让规则满意，属风格。

### d) npc/controller.js:202 —— **FALSE-POSITIVE**（本仓无该输入路径）

链条：`this.data = NPCData.fromObject(agent.prompter.profile.npc)`（`:40`）→ `NPCData` 里 `this.built = {}`（`data.js:7`）→ `npc.built = obj.built`（`data.js:42`，`obj` 来自 JSON profile）。

探针实测（exit 1）：

```
[①] 全仓 `Object.create(null)` 命中： 0 处
[②] data.js `this.built = {}`： 存在
[②] data.js `npc.built = obj.built`： 存在（直接取 profile 的对象）
[③] JSON.parse 对象的原型是 Object.prototype： true
[④] construction/*.json： dirt_shelter.json, large_house.json, small_stone_house.json, small_wood_house.json
[④] 存在 hasOwnProperty.json： false
[⑤] 若 built 里真有一个叫 hasOwnProperty 的键 → 调用会： TypeError: shadowed.hasOwnProperty is not a function
[正常路径] 4 个构造名逐个 hasOwnProperty → 4/4 命中，无异常
```

即：**无原型对象 0 处**、**影子键来源 0 处**。规则描述的风险（无原型对象）在本仓不存在；影子键要 `hasOwnProperty.json` 才能造出来，没有。⇒ 误报。

> 唯一可以说的实话：这个写法**理论上**不如 `Object.prototype.hasOwnProperty.call(this.data.built, goal.name)` 稳。但它不是"当前会坏的代码"，不该记成缺陷。

### e) construction_tasks.js:149 —— **FALSE-POSITIVE**（`blockAt` 是实例自有属性）

```js
if (!bot || typeof bot !== 'object' || !bot.hasOwnProperty('blockAt')) {
    throw new Error('Invalid bot object. Expected a mineflayer bot.');
}
```

这条守卫会**恒假并误拦用户命令**的前提是：`blockAt` 在原型上而非实例上。实测否定：

```
[①] blocks.js 导出的是 inject 函数： true
[①] inject 体内有 `bot.blockAt = blockAt`（实例赋值 ⇒ 自有属性）： true
[①] 该行行号： 612 （位于 function inject 作用域内，不在 class 原型上）
[②] 模拟 mineflayer 注入后的 bot.hasOwnProperty("blockAt") = true
[②] 守卫判定： 通过（不会抛 Invalid bot object）
[③] 若 blockAt 在原型上 → hasOwnProperty("blockAt") = false （那才会误判；但 mineflayer 不是这种写法）
[④] 能 import construction_tasks.js： true
```

`!checkBlueprint` 确实是用户可直达命令（`src/agent/commands/queries.js:249-252`，且在 `settings_spec.json:84` 默认白名单里），所以这条**值得核实**——但核实结果是守卫正确工作，不会误拦。

### f) text.js:49 —— **FALSE-POSITIVE**（控制字符是"要删的目标"）

被点名的正则：

```js
.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')   // sanitizeExternalText 内
```

这是"剥不可见/控制字符"的净化实现。ESLint 的 `no-control-regex` 本意是抓"不小心把控制字符写进正则"，此处是**反向使用**（控制字符正是要匹配删除的对象），属规则的本意反例。

探针实测（exit 1）——同时验证了"清洗是否彻底 / 是否误杀"：

```
[①] 被剥掉的： 0x00 0x01 ... 0x08 0x0b 0x0c 0x0d ... 0x1f 0x7f
[①] 被保留的： 0x09 0x0a
[②] 应该被剥但活下来的（漏网）： 无
[③] "a\r\nb"  → "a\nb" ; "a\rb" → "a\nb" ; 三个换行 → "a\n\nb"
[④] 正文是否原样保留： 是
[⑤] 定界符插 0x08 后 → "<<UNTRUSTED_EXTERNAL_DATAspeaker=evil>>"
```

精确说明（别写成"全剥"）：`\t`(0x09)、`\n`(0x0a) 保留；`\r`(0x0d) 不在该字符类里，是被**下一行** `/\r\n?/g → '\n'` 归一化成 `\n` 的——两行配合才完整，这也解释了为什么字符类故意跳过 `0x0d`。**没有漏网，也没有误杀正文**。⇒ 误报。

### g) queries.js:59 —— **FALSE-POSITIVE**（模板串里的冗余转义）

源码：`res += \`\- Current Action: ${action}\`;` —— 是**模板字符串**，不是正则。

```
[①] `\- Current Action: Idle` → "- Current Action: Idle"
[①] 两者逐字节相等： true
```

JS 对非转义序列（`\-`）规定丢弃反斜杠 ⇒ 输出与 `- Current Action` 完全一致。⇒ 纯笔误、零行为差异。

### h) mindserver.js:491 —— **FALSE-POSITIVE（规则维度）＋ 附注低危文案**

源码：`'<ol><li>打开文件 <code>mindcraft\.mindserver-token</code>，复制里面的值</li>' +`

```
[①] `'mindcraft\.mindserver-token'` 实际渲染 → "mindcraft.mindserver-token"
[①] 与 499 行那种 `mindcraft/.mindserver-token` 相等： false
[③] 401 HTML 提示的文件名写法： 带反斜杠（渲染成点）
[③] 401 纯文本提示的文件名写法： 带斜杠（mindcraft/.mindserver-token）
```

两层要分开说：

- **规则维度（判定依据）**：`\.` 在单引号串里被丢弃，行为与不写反斜杠**完全一致** ⇒ 冗余转义，误报。
- **附注（顺带发现，不作为本规则缺陷）**：真实 token 文件是 `path.join(process.cwd(), '.mindserver-token')`（`mindserver.js:394`），同函数 499 行的纯文本提示写的是 `mindcraft/.mindserver-token`；而 491 行这条 HTML 会渲染成 `mindcraft.mindserver-token`（点，不是斜杠）——**用户照 HTML 提示会找不到文件**。属**低危文案不一致**，修法是把 `\.` 改成 `/.`（同一个字符改动，顺手就好）。`start.bat:171` 的 `mindcraft\.mindserver-token` 在 cmd 里是字面反斜杠，那个没问题，别一起改。

## 4. 证据文件清单（`docs/audit-r5/evidence/lint-probes/`）

| 文件 | 内容 | 退出码 |
|---|---|---|
| `repro-a-flow_craft.log` … `repro-h-mindserver.log`（8 份） | 每条的 `npx eslint <文件>` 原始输出（含 rule 名与 file:line） | 各文件自身 exit=1（有告警） |
| `repro-d-controller-realpath.log` | **路径勘误**：`src/agent/npc/controller.js` 才是真身（任务书里的 `library/npc/` 不存在） | 1 |
| `probe-a-flow_craft-dupe-count.mjs/.log` | 重复键 + spread 覆盖语义 + 删除反证 | **1 = 不成立** |
| `probe-b-index-fallthrough.mjs/.log` | 5 组类型强制 + 12 组"加显式 break"对照 | **1 = 不成立** |
| `probe-c-action_manager-ex-assign.mjs/.log` | 静态位序 + 运行时复刻 catch 体 | **0 = 缺陷成立** |
| `probe-d-controller-hasOwnProperty.mjs/.log` | 原型链/JSON.parse/影子键/构造文件名 | **1 = 不成立** |
| `probe-e-construction-bot-hasOwnProperty.mjs/.log` | mineflayer `inject` 自有属性 + 守卫判定 | **1 = 不成立** |
| `probe-f-text-control-regex.mjs/.log` | 0x00-0x1f+0x7f 全覆盖 + 漏网/误杀检查 | **1 = 不成立** |
| `probe-g-queries-useless-escape.mjs/.log` | 模板串转义逐字节对照 | **1 = 不成立** |
| `probe-h-mindserver-useless-escape.mjs/.log` | 渲染结果 + 与 499 行/真实 TOKEN_FILE 对照 | **1 = 不成立** |

## 5. 复现命令（拷贝即用）

```bash
cd /e/我的世界ai/mindcraft

# ① 复现告警（8 条，逐文件）
npx eslint src/agent/library/flow_craft.js
npx eslint src/agent/commands/index.js
npx eslint src/agent/action_manager.js
npx eslint src/agent/npc/controller.js          # ← 注意：不是 library/npc/
npx eslint src/agent/tasks/construction_tasks.js
npx eslint src/utils/text.js
npx eslint src/agent/commands/queries.js
npx eslint src/mindcraft/mindserver.js

# ② 跑探针（退出码 0=缺陷成立 / 1=不成立）
for p in a b c d e f g h; do node /e/我的世界ai/docs/audit-r5/evidence/lint-probes/probe-$p-*.mjs; echo "$p => $?"; done
```

## 6. 给 verifier 的口径提醒

1. **不要把 a/b/f 当成"应该修掉的错"**：三条都是**故意写法**，改掉反而破坏语义（a 会丢本层 count、b/f 属无意义改动）。要消红只能加 eslint-disable 或调规则配置，属**风格决策**。
2. **c 是本轮唯一可上报的新缺陷**，严重度**低-中**：不崩溃、不影响行为正确性，只让失败消息里的堆栈变成 `undefined`（外加 `Error: Error:` 双前缀）。若缺陷清单需要严格分级，建议记"诊断能力/可观测性"类，而不是 P0/P1。
3. **d/e 是"规则描述的风险在本仓不可达"**：值得在报告里写一句"理论上更稳的写法是 `Object.prototype.hasOwnProperty.call(...)`"，但**不要**计为缺陷——本任务已实测否定其触发路径。
4. **h 的附注（文案渲染成 `mindcraft.mindserver-token`）可以单独进"低危文案"清单**，但它与 lint 这条规则无关，别混在一起说。
5. 180 条 `semi`/`require-await` **未纳入本次核验**（按任务口径，属 lint_hard 已声明的历史欠账）。
