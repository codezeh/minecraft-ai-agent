# D4 AI部 · 复核记录（t16）

> 复核官：gate-keeper ｜ 2026-11-06 02:3x–02:5x
> 对象：`queue/claimed/`（**`done/` 为空**）+ 工作区 diff + `queue/inbox/` 里仍挂着的条目
> 环境：本会话 node 不能 spawn ⇒ `gate:full` 由 captain 跑。**注意：D4 相关改动仍全部未提交**（13 个文件 `M`）。

---

## 0. 判决

**通过 1 / 打回 3。**

| 条目 | 严重度 | 判决 | 一句话 |
|---|---|---|---|
| `F-AI-202` `!goal` 系统提示注入 | high | **通过** | 代码正确；**测试是加强不是删弱**（断言一条没删、多 3 处守门），66 passed / 0 failed |
| `F-AI-201` 外部内容无围栏 | high | **打回（未完成）** | 围栏函数写好了但**是死代码**：三个调用点全不传 `fenced`、`sanitizeExternalText` 零调用 ⇒ **当前实际防护为 0** |
| `F-AI-203` 记忆闭环污染 | medium | **打回（未完成）** | 四条修法（落盘净化 / `$MEMORY` 围栏 / 硬规则 / `!forgetMemory`）**一条没落地** |
| `F-AI-204` `companion_mode` 未声明 | medium | **打回（未完成）** | spec 仍未声明；`if (!settings.companion_mode) return true` 的**默认放行方向没反转** |

**必须先说清的一句**：D4 这一部**只有 1 条真正交付**。另外 3 条仍挂在 `inbox/`，
其中 `F-AI-201/203` 的"实现"是**未被任何调用点引用的死代码**。
**请不要因为 `git diff` 里看得见 `fenceUntrusted` 就以为修好了 —— 它现在对安全的作用是 0。**

---

## 1. `F-AI-202`（`!goal`）—— 通过

### 1.1 代码层（①②）
```js
permissions.js  OWNER_ONLY_COMMANDS: +'!goal'
                TRUSTED_COMMANDS:    '!stop','!stay','!stfu','!endGoal'    ← !endGoal 正确保留
prompter.js     rawGoal → 折叠 \r\n\t → replace(/\\/g,'\\\\') → replace(/"/g,'\\"') → 超 500 可见截断
```
对任务判据的回答：
- **不是"提示里加一句请忽略恶意指令"** —— 它是**编码式转义**（`\` 先于 `"`，顺序正确），
  让 goal 文本无法闭合引号、无法另起一行伪造段落。这是结构性的，不是软化措辞 ✅
- **有硬上限**：500 字 + 超限**可见截断**（`…[已截断，原长 N]`），不是静默 slice ✅
- **主防线在执行侧**（`!goal` 升 OWNER_ONLY），转义只是纵深 —— 代码注释自己写明了这一点 ✅

### 1.2 测试层：**加强，不是删弱**（这是我最看重的一点）

任务点名"抽查相关单测是否被删/跳过"。我逐条比了 `tools/permissions_unit.mjs` 的 diff：

| 改动 | 性质 |
|---|---|
| `'!goal'` 从 `trustedCan` **移入** `trustedCannot`（标签 7→8 条） | 断言**保留并反向加强**（不是删掉） |
| `'!endGoal'` **显式加进** `trustedCan` 并写理由 | **新增**"急停必须可用"的守门 |
| 8g 改写为 owner(`Zeh`) 用例 | **新增**"主人没被误伤"的守门（我预审时特别要求） |
| **8g2 新增**：信任级 `!goal` 被拒 **且** 没真的设上目标（2 条断言） | **新增** |
| 8h **反向改写**（不是删除）：没配 owner 时 `!goal` 不可用 + **新增**"`!endGoal` 仍可用" + 保留 `!newAction` 断言 | 语义变更被钉住 |

```
$ grep -nE "SKIP|skip\(" tools/permissions_unit.mjs → 无 skip / 无 TODO
$ node tools/permissions_unit.mjs     → 66 passed / 0 failed（exit 0；修前 59/4）
$ node tools/mindserver_gate_unit.mjs → 49 passed / 0 failed（exit 0）
$ node tools/atom_classify_unit.mjs   → 6/6
```

⇒ **一条断言都没被删、没被 skip，反而多了 3 处守门。** 这正是我在 D1/D2 里反复要求的标准。

### 1.3 禁止项核查（任务点名）
`git diff prompter.js / permissions.js` 中 **无** 空 catch、**无** 换模型、**无** 新增重试/fallback ✅

### 1.4 唯一 caveat
③（自提示循环的 `max_turns` / 时长上限）仍 blocked。**我认可这个 blocked**（要动运行期循环语义、本会话无法观察 2 秒节拍）。
但请保持"**部分解决**"的定性：①② 已修 ≠ 本条已修，
"**每轮用任意命令就让 `no_command_count` 归零 ⇒ 无限循环**"这个机制仍在（按量计费下最费钱的一条）。

---

## 2. `F-AI-201`（外部内容无围栏）—— 打回：**写在纸上，没接上线**

### 2.1 决定性证据：这是死代码

`src/utils/text.js` 新增了 `fenceUntrusted()` / `sanitizeExternalText()`，`stringifyTurns(turns, opts)` 也加了 `opts.fenced` 分支。
但**没有任何调用点用它**：

```
$ grep -rn "stringifyTurns(" src/ tools/ | grep -v node_modules
  src/models/prompter.js:221   stringifyTurns(to_summarize)    ← 无 opts
  src/models/prompter.js:223   stringifyTurns(messages)        ← 无 opts
  src/utils/examples.js:79     stringifyTurns(example)         ← 无 opts
$ grep -rn "fenceUntrusted|sanitizeExternalText" src/ tools/
  text.js:15 定义 / text.js:24 定义 / text.js:42 仅 fenced 分支内调用
```
⇒ `fenced` 恒 `false` ⇒ 围栏分支**永不执行**；`sanitizeExternalText` **零调用点**。
**这条 high 级注入面，此刻的实际防护是 0。** 不是"防护不足"，是"没有防护"。
（patch-smith 自己也在交接里说 text.js 是 WIP、"请勿并入提交" —— 所以我不按"质量不合格"打回，而是打回**状态**：
本条仍是未完成，且工作区里那份代码对安全没有实际作用。）

### 2.2 即使接上线，按本任务判据也**不足以关闭**

任务判据原文：
> "修补是否只是'提示里加了一句请忽略恶意指令'——这种软化措辞不构成控制，直接打回。"
> "是否把防线放在前端/提示层，而执行侧仍无校验（提示可被绕过 = 打回）。"

我的判定（分两半说，不想一棍打死）：
- **设计上半对**：围栏 = 显式边界标记 + 打散伪造定界符 + speaker 归属 + 长度硬上限 1500。
  这**属于**任务允许的结构性手段（"外部内容有明确边界标记"、"有硬上限"）。这部分我认可。
- **但它不是控制，只是降低成功率**：它作用在 **system 提示文本**上，强注入仍可让模型照做 —— **提示可被绕过**。
- **执行侧的真控制只有权限模型**，而它**只挡 10 条主人级、不挡 48 条信任级被驱动**；
  且 `permissions.js` **没配 owner 时 return TRUSTED** ⇒ 新装即"任一玩家可驱动 48 条"。

⇒ **本条关闭条件不能是"加了围栏"，必须是"执行侧有硬约束"。** finding 自己写的彻底方案
（命令走结构化 tool-call，而不是用正则从自由文本捞）也还没做。

### 2.3 requiredFix
1. **接上线**（否则连"缓解"都不是）：`$CONVO`、`$TO_SUMMARIZE` 传 `{ fenced: true }`；
   `$MEMORY` 注入点用 `fenceUntrusted(memory, 'memory')` 包一层；
   **`examples.js:79` 不要 fenced**（示例是我们自己的数据，不是外部输入）——别一把梭。
2. **执行侧硬约束**（决定本条能否关闭）：至少给出一条**非提示层**的控制，例如
   "有 owner 配置时，玩家来源回合不允许驱动任何命令（只允许聊天）"，或把
   `!attack` / `!putInChest` / `!takeFromChest` 这类破坏性子集降为"仅 trusted 名单内"。
3. **补单测**：`fenceUntrusted` 的伪造定界符必须被打散（正反各一）、`sanitizeExternalText` 的长度上限与控制字符（各一）。
   **现在这三个新函数零测试引用** —— 又是一个"没人守"的新代码。

---

## 3. `F-AI-203`（记忆闭环污染）—— 打回：四条修法一条没落地

```
· sanitizeExternalText 已写但零调用点
· history.js 的 memory 落盘路径未改（仍 promptMemSaving(turns) 原文写 memory.json）
· prompter.js 的 $MEMORY 注入点未加围栏
· 没有 !forgetMemory 之类的主人清理命令
```
**为什么不按"中等"放过**：本条门槛极低 —— **只要会聊天就能污染记忆，跨重启存活，不需要任何命令权限**。
记忆是**数据不是命令**，所以**没有执行侧判据可依赖**；围栏+净化是唯一手段 ⇒
"写了函数不调用"在这里等于零防护。

---

## 4. `F-AI-204`（`companion_mode`）—— 打回：默认放行方向没反转

```
$ grep -n "companion_mode" src/mindcraft/public/settings_spec.json → 无输出（仍未声明）
$ node tools/settings_check.mjs
  ⚠ settings.companion_mode … 【待用户决策 · 2026-11-06】…从未在 spec 声明 → 恒 falsy → 全部命令对模型可见…
```
仍挂在 `settings_check.mjs` 的 `KNOWN_UNDECLARED` **已登记例外**里（每次运行都打印、**没有静默变绿** —— 这点诚实）。
但两条实质修法都没做：
1. **没补进 `settings_spec.json`**；
2. **没反转默认值** —— `if (!settings.companion_mode) return true` 仍然是"**键缺失 = 全放行**"，正是本条要反的。

**口径补充（我这边的独立实测）**：我 t13 复核 D1 时按同一份代码数过 **白名单 8 条 / 实际注册 64 条**；
recon 用的是"70 / 8"（差在是否把 `!do`/`!listSkills` 这类"登记未实现"的算进去）。
**无论哪个口径，"键缺失 = 全放行"都成立。**

**requiredFix**：spec 声明 `companion_mode`（boolean，default false）；把判断改成**默认拒绝**语义
（键缺失 ⇒ 收敛，只有显式 false 才全开）；配一条单测"不传该键时 `isVisibleToModel('!newAction') === false`"；
改完必须真机回归（会隐藏 56 条命令）；并从 `KNOWN_UNDECLARED` 删掉该条。
**注意这是行为变更，需用户拍板**（与 `F-SEC-204` 同类）。

---

## 5. 门禁与流程

- **`gate:full`**：本会话不能 spawn，我跑不了。**相关单测我全跑了**：`permissions_unit` 66/0 ✅、
  `mindserver_gate_unit` 49/0 ✅、`step_runner_unit` exit 0、`atom_classify_unit` 6/6 ⇒ **D4 改动没有打坏这些**。
  但 `permissions_unit` 从红转绿是**因为断言被正确改写**（我已逐条核过是加强），不是被屏蔽。
- **13 个文件仍全部未提交** ⇒ 无 sha 可引用、无法单条回滚。这是第三次提同一问题（D1/D3/D4 都这样）。
- **单测删/跳过核查**：`permissions_unit` 无 `skip`/`TODO`；`text.js` 的三个新函数**没有任何测试**（见 requiredFix 第 3 条）。

---

## 6. 我在本轮核过、但**不属于 D4 打回范围**的两件事
1. `speak.js` 的两条实测注释（"不要加 InputEncoding" / "`inspectChatText` 不是 shell 过滤器"）——
   patch-smith 说已写死，我确认 diff 里**确实已加**（属于 D3/`F-EXEC-201` 的 follow-up，D3 复核里已记）。
2. `F-AI-202` 的 `!endGoal` 保留决策 —— 本轮已在单测里被"急停必须可用"的断言钉住，**不会再被人顺手改回去**。

---

## 7. 复核动作（可审计）
```
读：claimed/F-AI-202.md、inbox/F-AI-201/203/204.md；git diff 的 permissions.js / prompter.js / text.js /
    permissions_unit.mjs；settings_check.mjs 的 KNOWN_UNDECLARED
跑：grep stringifyTurns 三个调用点（确认无 opts）→ 判定围栏为死代码
    grep fenceUntrusted / sanitizeExternalText 调用点 → 零外部调用
    grep companion_mode settings_spec.json → 无
    node tools/settings_check.mjs（确认 companion_mode 仍在已登记例外、未静默变绿）
    node tools/permissions_unit.mjs（66/0）／mindserver_gate_unit（49/0）／atom_classify_unit（6/6）／step_runner_unit
    grep SKIP|skip( tools/permissions_unit.mjs（无）
    git diff 扫空 catch / 换模型 / 重试（无）
未做：gate:full（本会话不能 spawn）
```

---

## 更正（2026-11-06 03:1x）：本文两处事实需要更新
1. **"13 个文件全未提交"是陈旧读数**。实测 `git log --oneline`：
   `c8df8ce`（F-AI-202 !goal）、`d42f796`（F-EXEC-201）、`7ba7b5e`（F-DEP-004，含 F-DEP-003 补丁对）、
   `9e7253c`、`7d15339`、`76ee07b` —— **六个 commit 都在**。
   仍扣住的只有 `tasks.js`（F-EXEC-202 待重做）与 `text.js`（**F-AI-201 死代码待接线**）⇒ 与我的两条打回一致，合理。
2. **`permissions_unit` 66/0 与 `mindserver_gate_unit` 49/0 已随 `c8df8ce`/`d42f796` 提交** ⇒ 我的"测试是加强不是删弱"结论
   现在有 sha 可锚定。
**教训**：判提交用 `git log`，不用 `git status`。
