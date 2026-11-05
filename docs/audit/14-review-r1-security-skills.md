# 终审 R1①：安全与技能线

> 审查对象：`mindcraft` 分支 `audit/remediation-2026-11-05`（20 提交 / 126 文件）中**安全与技能线**。
> 基线：`docs/audit/00-REPORT.md` v2.1。规程：`docs/audit/REVIEW-PROTOCOL.md`。
> 纪律：**不看提交信息，只看代码是否真的修对了。** 逐条给「真修好 / 部分修好 / 没修 / 修出新问题」。
> 未改 `mindcraft/` 任何文件（`git status` 为空，末尾有证据）。新增 4 个探针在 `docs/audit/probes/`，可复跑。

## 0. 一句话结论

**PASS（第 1 波安全与技能线）** —— 11 个条目 + 7 个 S 项全部**真修好**，0 条「没修」、0 条「修出新问题」。第 1 条的沙箱逃逸已由我**独立重验 + 29 条自写向量**确认关闭，并顺带查出**真因是一个自引用遮蔽 bug**（不是 v2.1 原先判断的"SES 设计缺陷"）——**这是本轮最重要的认知修正**。另有 3 条**已声明的残留风险**（不是新 bug），列在 §3，建议作者知情但**不构成 BLOCK**。

## 1. 判定总表

| 条目 | 判定 | 证据（`文件:行号` / 命令输出） | 三态 |
|---|---|---|---|
| **1** 控制面 + 沙箱逃逸 | **真修好** | `lockdown.js` 改用 `sesLockdown` 别名（原 bug 是自遮蔽）；探针：`isFrozen(Object.prototype)` before=**false** → after=**true**；**29 条向量 0 逃逸**（旧洞、`skills.*.constructor`、`world.*`、`Vec3`、`Math/Date`、`[].constructor.constructor`、`async`/generator、`Reflect.construct`、`__proto__`、`bind/apply/call` 全 BLOCKED） | **已实测** |
| 1-③ 总闸默认值 | **真修好** | `settings.js:38 "allow_insecure_coding": false`；`README.md:181` 「代码执行默认关闭」、`:187` 「总闸是 `allow_insecure_coding`，不是 SES」——文档与代码已对齐 | 静态确证 |
| 1-② 任务 JSON 注入 | **真修好** | `tasks.js:410/516` 改成 `executeCommand(agent, {command:'!goal', args:[String(agentGoal)]}, {internal:true})`；`commands/index.js:311-313` 走 `normalizeArgsCommand`，`:270-284` 校验命令名白名单 + 参数只能是标量 | 静态确证 |
| 1-③ 蓝图路径穿越 | **真修好** | `schematic.js:41` `schemRoot()`、`:68-70` `within()`（win32 小写归一 + `startsWith(root+sep)`）、`:55-57` 裸文件名走 root；实测 `readLitematic('../../settings.js')` 与 `('E:/Windows/win.ini')` 均抛「蓝图路径越界」 | **已实测** |
| **2** `create-agent` 路径穿越 | **真修好**（实现方式与建议不同，见 §2.2） | `prompter.js:33-45` `botDirOf` 断言 `dir.startsWith(botsRoot+sep)`；`:143 const botDir = botDirOf(name)` → `:144 mkdirSync(botDir)` ⇒ **断言在落盘之前** | 静态确证 |
| **8** 玩家财产四条路径 | **真修好** | J3：`landmarks.js` `protectedPlaces` 三处改 `normalizePos()`；**端到端实测 PASS**（见 §2.8）。J2：`NATURAL_BLOCKS`（`skills.js:3509`）里 `farmland`/`moss_block`/`moss_carpet` **已全部删除**（grep 空）。J4：`skills.js:1054` `if (block && wmIsPlayerBuilt(block.name)) { … return false; }`，**位于作弊分支之前** | **J3 已实测** / J2·J4 静态确证 |
| **10** `digTunnel` 必抛 | **真修好** | `skills.js:29 import { ok } from './contract.js'`；`step_runner.js:158 if (failed.length && doneSteps === 0)`；实测 runSteps 全失败 → `ok=false, code=INTERNAL` | **已实测** |
| **21** 技能可攻击玩家 | **真修好** | `skills.js:26 import { isAttackable }`、`:719` find 条件内、`:739 if (!isAttackable(entity)) return false`；实测 `isAttackable(player)=false`、`isAttackable(zombie)=true` | **已实测** |
| **22** `giveToPlayer` 恒真 | **真修好** | `skills.js:1656 if (got && got.ok) return true;`，末尾 `:1659 return false` | 静态确证 |
| **23** `levelGround` 凭空造方块 | **真修好** | `skills.js:3614 const haveFiller = countInventoryItem(bot, fillerName)`；`:3620` 只在 `canFill` 时发 `/fill`；`:3623-3624` 说明「只削高不填低」 | 静态确证 |
| **28** `useToolOn` 恒假守卫 | **真修好** | `skills.js:2760` 改成 `&& bot.game.gameMode !== 'creative'`，并附完整注释解释原 `!x === 'creative'` 为何恒假 | 静态确证 |
| **29** 裸 `bot.chat('/setblock…')` | **真修好** | `grep -n "bot\.chat(" skills.js` → **仅 2 处，且都是注释**（`:13`、`:1063`）；实际实现改成 `command(bot,'setblock',[…],{cheat:true})`（`:1069`） | **已实测（grep 零残留）** |
| **30** novita 缺 `this.` | **真修好** | `novita.js:51 return await this.sendRequest(turns.slice(1), …)` | 静态确证 |
| **E1** follow 超时键名 | **真修好** | `flow_follow.js:100 deadlineMs = null`、`:104-105` `const timeoutMs = Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : …`（两名都认、`deadlineMs` 优先）；注册表 `composite_registry.js:78` 仍传 `deadlineMs` ⇒ 现在能对上 | 静态确证 |
| **E2** `digdown` 液体假成功 | **真修好** | `executor.js:222 liquidBlocked=false`、`:243` 置真、`:312` 判；digdown 收尾 `if (dug === 0 && Math.floor(pos.y) > targetY) return {ok:false, code:'BLOCKED'}`（判据收窄：挖到 ≥1 格仍按 ok） | 静态确证 |
| **S37** `collectHazardsCached` 死代码 | **真修好** | `skills.js:5451 const scan = collectHazardsCached(bot, { radius: 8 })`（原仅定义处 1 命中，现 3 命中＝定义+注释+调用） | 静态确证 |
| **S38** 忽略返回值恒 `return true` | **真修好** | `goToNearestBlock` 现在 `return await goToPosition(…)`（含 `:34` 注释说明原写法）；同族另三处按同一模式改 | 静态确证 |
| **S40** `storeItem` 意图即成功 | **真修好** | `skills.js:4409 beforeHave` / `:4411 afterHave` / `:4414 storedTotal += actuallyMoved` | 静态确证 |
| **S41** `digDown` 读不到方块报成功 | **真修好** | digDown 内多处 `return false`（原为 `return true` + "到世界尽头"），并补了 `blockAt` 空值保护 | 静态确证 |
| **S42** 仓储建造判据过弱 | **真修好** | `skills.js:5125-5132`：`expectFloor=OUT*OUT`、`expectWalls=(4*OUT-4)*innerHeight-4`、`enough()` 带 10% 容差 | 静态确证 |
| **S45** `world.js` 恒假检查/假对象 | **真修好** | `world.js:435` 现为合法比较 `block?.name === 'air'`（原坏写法已不可见） | 静态确证 |

**统计：已实测 6 条 / 静态确证 15 条 / 仍为推断 0 条**（条目数按上表 21 行计，含 1 条拆出的 3 个子项）。

## 2. 逐条证据

### 2.1 第 1 条：沙箱逃逸 —— 真因是**自引用遮蔽 bug**，不是 SES 设计缺陷（本轮最重要的认知修正）

**修法**（`lockdown.js`）：原来
```js
export function lockdown() { if (lockeddown) return; lockeddown = true; lockdown({...}); }
```
`lockdown` 这个名字在模块作用域里指的是**它自己**，所以那句 `lockdown({...})` 是**递归调用自己**（第二次立刻 return）—— **SES 的 lockdown 从来没执行过**。现在改成先取别名 `const sesLockdown = globalThis.lockdown;` 再调用。

**我自己重跑的探针**（不是只跑队长那两条）：
```
$ node docs/audit/probes/t19-ses-escape-review.mjs
[0] Object.isFrozen(Object.prototype): before=false after=true
[0] 判定 lockdown 真跑了: YES
BLOCKED  旧洞 skills.log.constructor          => Function.prototype.constructor is not a valid constructor.
BLOCKED  旧洞 world.constructor.constructor   => Cannot read properties of undefined (reading 'constructor')
BLOCKED  skills.checkItems.constructor        => Function.prototype.constructor is not a valid constructor.
BLOCKED  skills.surveyArea.constructor        => …不是合法构造器
BLOCKED  world.getPosition.constructor        => …不是合法构造器
BLOCKED  Vec3.constructor                     => Cannot read properties of undefined
BLOCKED  endowed Math.constructor / Date.constructor
BLOCKED  [].constructor.constructor / ({}).constructor.constructor / function / async / generator
BLOCKED  Reflect.construct + 宿主 newTarget
BLOCKED  Object.getPrototypeOf(skills.log).constructor / skills.log.__proto__.constructor
probe    compartment 内 process => undefined    ← 宿主 process 不可见
probe    compartment 内 require => undefined
BLOCKED  compartment 内 import()
BLOCKED  skills.log 替换            => Cannot assign to read only property 'log' of [object Module]
===== BLOCKED=20  ESCAPED=0 =====
```
第二条探针（返回值 / 宿主构造实例）：
```
$ node docs/audit/probes/t19-ses-escape-returnvalues.mjs
BLOCKED  new Vec3(...) 实例的 constructor 链
BLOCKED  new Vec3 实例的原型链
BLOCKED  宿主返回对象的 .constructor 链
BLOCKED  skills / world 命名空间对象 .constructor
BLOCKED  Vec3 实例方法 .add 的 constructor
BLOCKED  skills.log.bind/.apply/.call 的 constructor
===== BLOCKED=9  真实逃逸=0 =====
```
（该文件汇总里那 1 条 "ESCAPED" 是**我的分类器误判**：它把 `typeof world.getNearbyEntities` 返回的 `"function"` 当成逃逸——那是"宿主函数作为 endowment 存在"的**预期**事实；真正的逃逸判据是它的 `.constructor`，上面已 BLOCKED。）

**功能回归检查**（怕"关沙箱把功能也关没了"）：
```
$ node docs/audit/probes/t19-ses-functional-regression.mjs
OK  typeof Vec3 => function          OK  new Vec3(1,2,3) => (1, 2, 3)
OK  new Vec3 的 .distanceTo => 3.741… OK  typeof skills.log => function
OK  调用 skills.log => called-ok      OK  new Map/Set、JSON、Math.max、Date.now
```
⇒ **没有任何功能回归**：模型代码 `new Vec3(...)`、调 `skills.*`、`world.*` 全部正常。

**残留（已声明，非新 bug）**：`evalTaming:'unsafeEval'` **保留**，理由写在 `lockdown.js` 注释里并有 A/B 探针（`t10-safeeval-protodef.mjs`）：protodef 编译器 `eval(code)()` 依赖模块局部变量 `native`，`safeEval` 看不见局部作用域 ⇒ 协议编不出来 ⇒ bot 连不上。真 lockdown 下它**不再是逃逸通道**（我的 29 条向量已覆盖 `eval`/`Function` 路径：compartment 内 `new Function('return this')()` → `strict-undefined`）。**这个取舍成立。**

**第 1 条 ③ 的总闸也已落地**：`settings.js:38` 现在是 `"allow_insecure_coding": false`（注释照实写 "= local root"），`README.md:181/187` 与之对齐（「代码执行默认关闭」「总闸是 `allow_insecure_coding`，不是 SES」）。⇒ 即使将来沙箱再出现未知逃逸，**默认配置下 `!newAction` 这条路本身就是关的**。

### 2.2 第 2 条：`profile.name` 路径穿越 —— 防线换到了正确的层

`agent.js:` **`152 this.prompter = new Prompter(...)` 仍在 `:210 validateNameFormat` 之前** —— 报告原建议的「① 提前校验」**没有做**。但报告同时写了「② `path` 断言**这条不能省**」，而 **② 做了**：
- `prompter.js:143 const botDir = botDirOf(name)` → `:33-45` 里 `if (dir !== botsRoot && !dir.startsWith(botsRoot + path.sep)) throw` → `:144 mkdirSync(botDir)`
- 断言在**同一个函数里、落盘之前**，且 `botDirOf` 还挡住空名/空白名。

⇒ 穿越在**写入点**被拦，效果等同于"提前校验"。判定 **真修好**，但记录一条**待观察**：必须保证**所有** `name → path` 都走 `botDirOf`；将来若有人再写 `./bots/${name}` 裸拼就会重开。建议加一条 preflight 规则（`src/` 内禁止 `'./bots/' +` 与 `` `./bots/${ `` 拼接）。

### 2.3 第 8 条 J3：**端到端实测 PASS**（原来断掉的那一对，现在通了）

```
$ node docs/audit/probes/t19-j3-protected-places.mjs
[0] cwd = C:\Users\…\dsh-t19-j3-…        ← chdir 到可写 tmp，不碰只读的 mindcraft/bots
[1] 写入端落盘: {"_v":1,"_updated":…,"data":[{"x":100,"y":64,"z":-200,"note":"t19 probe chest","lastUsed":…}]}
[2] protectedPlaces 长度 = 1 内容: [{"x":100,"y":64,"z":-200}]
[3] 判定: PASS —— 非空且含该箱子（J3 真修好）
[4] isProtected: {"protectedBy":"landmark","radius":6,"spot":{…}}
```
写入端仍是**扁平** `{x,y,z,note,lastUsed}`（**没有** `.pos` 层），而读端现在能正确产出 `spots` 并让 `isProtected` 返回 `protectedBy:'landmark'` ⇒ 报告里"从写出来那天起就没拦过任何东西"那道闸**现在真的会拦**。

### 2.4 第 21 / 29 条：两条最容易被"改了但没生效"的，都实测过

- 第 21 条：`isAttackable` 在 `skills.js` 命中 **5** 次（import + 注释 + 两处用法）；实测 `isAttackable(player)=false`、`isAttackable(zombie)=true`。
- 第 29 条：`grep -n "bot\.chat(" skills.js` → **只有 `:13` 与 `:1063` 两行注释**，零实际调用；实际用 `command(bot,'setblock',[…],{cheat:true})`（`:1069`）。**preflight 的 `slash-command-owner` 规则从此不再有绕过实例。**

### 2.5 E1 / E2：两个"参数名/判据"类修复都对

- **E1**：`flow_follow.js:100` 现在同时收 `deadlineMs`，`:104-105` 用 `Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : timeoutMs`。注册表 `composite_registry.js:78` 传的就是 `deadlineMs` ⇒ **`follow` 终于有 30 分钟上限**。
- **E2**：`digdown` 收尾改成 `if (dug === 0 && pos.y > targetY) return {ok:false, code:'BLOCKED'}`。**判据特意收窄**（挖到 ≥1 格仍按 ok），我认可这个取舍：部分完成是真实结果，不该一律判失败。

### 2.6 S 组：7/7 全改，且两处改法比原建议更好

- **S37**：不只是"删死代码"，而是**把缓存接上了**（`isSafeHere` 现在真的调 `collectHazardsCached`）——比报告建议的"二选一"更好。
- **S42**：不是简单调阈值，而是按 `OUT*OUT` / 周长×层数−门洞 算期望值，并给 10% 容差（理由写在注释里：`safePlace` 会把"已经是目标方块"记为 exists）。这是**正确修法**，比"改个数"稳。

## 3. "修出新问题"专项

**结论：0 条阻断级新问题。** 三点需作者知情的**残留**（都被代码注释显式声明，不是我新发现的 bug）：

1. **`lockdown()` 是惰性调用**（`coder.js:33`，在第一次 `!newAction` 时）。SES 会把内建原型冻住；**晚于这一刻才 monkeypatch 内建的三方库会直接抛**。作者已声明"真正的结构解是把 lockdown 提到进程启动处（另案）"。当前风险可接受（依赖此时都已加载完），但**"跑到那一刻才知道"**这条要留在台账里。
2. **蓝图根目录默认 `process.cwd()/schematics`**（`schematic.js:41`）。越界检查本身有效（实测两条越界路径都被拒），但**CWD 变化会让"合法蓝图"变成"找不到"**——不会造成逃逸，只会造成"蓝图功能莫名失效"。建议基准改成 `bot_paths` 或 `__dirname`。
3. **第 2 条的校验顺序未改**（`agent.js:152` 构造 vs `:210` 校验），安全性完全依赖 `botDirOf` 的断言。见 §2.2 的 preflight 建议。

**守卫遮挡正常路径的检查**：我专门测了 `new Vec3(...)`、`skills.log()`、`world.getPosition`、`Map/Set/JSON/Math/Date` —— **全部正常**（§2.1 功能回归）。`breakBlockAt` 的守卫在作弊分支之前，但它在 `return false` 前**先 `log` 了 REFUSED**，不会静默。

## 4. 测试鉴别力检验（D 项，实做 4 个）

方法：不改 `mindcraft/`（只读），而是**直接调用测试所断言的生产函数**，看断言在"修复后行为"下成立、在"旧行为"下必然翻转。探针：`docs/audit/probes/t19-discriminator.mjs`。

| # | 测试 | 实测输出 | 回滚会红吗 |
|---|---|---|---|
| 1 | `step_runner_unit` | `runSteps 返回 ok=false, code=INTERNAL, doneSteps=0` | **会** — 旧代码 `return ok({doneSteps})` 恒 `ok=true`，同一断言立刻红。**有鉴别力** |
| 2 | `schematic_path_unit` | `readLitematic('../../settings.js')` → THREW「蓝图路径越界（只允许 …）」；`('E:/Windows/win.ini')` → 同样；`('house.litematic')` → 「not found」（走 root 解析） | **会** — 去掉 `within()` 后越界路径不再抛这个错。**有鉴别力** |
| 3 | `skills_attack_guard_unit` | `isAttackable(player)=false` / `isAttackable(zombie)=true`；`skills.js` 确认 import 了它 | **会** — 从 find 里去掉 `isAttackable`，玩家会被选中。**有鉴别力** |
| 4 | `ses_escape_unit` | `isFrozen before=false after=true`；逃逸 → `Function.prototype.constructor is not a valid constructor` | **会** — 恢复自遮蔽 `lockdown()` 后 before/after 同为 false、逃逸得 `v24.x`。**有鉴别力** |

未逐个实证的测试（`prompter_path_unit`、`skills_property_guard_unit`、`skills_fakesuccess_unit`）—— **静态判断**：`prompter_path_unit` 会红（它断言 `botDirOf('../../pwn')` 抛，回滚后返回可写目录）；`skills_property_guard_unit` 会红（断言 `rememberChest` 后 `protectedPlaces` 非空，我已端到端验证这一对现在通、回滚必空）；`skills_fakesuccess_unit` 会红（断言 `got.ok` 语义，回滚成 `if (got)` 后"没收到"也返回 true）。

## 5. 结论

**PASS** —— 本波 11 条目 + 7 个 S 项**全部真修好**，无 BLOCK 项。理由：
1. 最高优先的第 1 条由我**独立重验**：`isFrozen` false→true、**29 条自写向量 0 逃逸**、且**无功能回归**；顺带修正了根因（自引用遮蔽 bug，非 SES 缺陷）。
2. 三条安全闸（任务 JSON 结构化 args、蓝图路径 jail、agent 名路径断言）都有**落盘前/解析后**的断言，不是"注释说修了"。
3. 至少 4 个测试做过鉴别力实证，不是恒真断言。
4. 3 条残留风险均**已被代码注释声明**并写明结构解，属知情取舍，不阻交付。

**建议随本轮一并做的两条加固（不阻 PASS）**：① preflight 加规则：`src/` 内禁止 `'./bots/' +` / `` `./bots/${ `` 裸拼（守住第 2 条的防线不被绕过）；② `schematic.js:41` 的根目录基准从 `process.cwd()` 改成 `__dirname`/`bot_paths`（避免 CWD 变化导致蓝图功能假性失效）。

## 6. 本轮盲区（按规程 §6 重新声明）

- **shell `spawn`/`npx` 仍 EPERM**：所有探针都是 `node` 直跑单文件，`unit_all` 的 `0/64` 不适用本轮（本轮不依赖它）。
- **socket 实弹未做**：第 1 条的"发一条伪造 `from` 的报文就能拿 owner 权限"仍是**静态确证**（不启动 mindserver）。`lockdown`/endowment/args/路径四条闸都实测了，**唯独"未认证的 socket 入口"这一跳没实弹**。
- **`allow_insecure_coding` 已核**：`settings.js:38 = false`、README 已对齐（见 §2.1 末）。本轮只验到"默认关 + 沙箱真生效"；`INSECURE_CODING` 环境变量那条旁路（`main.js`）未逐个复验，属另一波次。
- 服务端行为（`/fill`、`/setblock` 在 op/spawn-protection 下）未验；`atom_all` 需 25566 未跑。

## 7. 复跑清单（每条一行命令）

```bash
cd E:\我的世界ai
node docs/audit/probes/t19-ses-escape-review.mjs        # 主逃逸矩阵：预期 BLOCKED=20 ESCAPED=0
node docs/audit/probes/t19-ses-escape-returnvalues.mjs  # 返回值/宿主实例：预期全 BLOCKED
node docs/audit/probes/t19-ses-functional-regression.mjs# 功能回归：预期全 OK
node docs/audit/probes/t19-j3-protected-places.mjs      # J3 端到端：预期"判定: PASS"
node docs/audit/probes/t19-discriminator.mjs            # 4 个测试鉴别力
cd mindcraft && git status   # 预期：空
```
