# 台账对账：inbox 29 + claimed 10 = 39 条逐条核实（权威未完成清单）

- **对账人**：recon-scout（t20）
- **对账时间**：2026-11-06 12:10–12:35
- **对账口径**：`git log --oneline -- <path>` + **直接读当前代码**。**不使用 `git status`**（stat 缓存会假脏）。
  **不采信 finding 自述、也不采信 captain 转述**，每条都以我读到的代码/跑出的输出为准。
- **覆盖**：inbox 29 条 + claimed 10 条，**39 条一条不漏**。
- **一句话结论**：39 条中 **✅已修 10 条**、**🟡部分修 6 条**、**❌真未修 22 条**、**⏸决策/blocked 1 条**
  （`F-SEC-101`，它本身又是"部分缓解"，故标 ⏸🟡）。
  > 注：§三「决策项」列了 4 个**议题**，但其中只有 `F-SEC-101` 是独立一行；
  > 另外 3 个（`F-DEP-005` 残留 / `F-DEP-004` 残留 / `F-AI-103`）**已分别计入上表的 🟡/🟡/🟡**，
  > 不重复计数——写在这里是因为它们**需要用户拍板**，容易被误当成"纯技术活"派下去。

---

## 一、总表（39 条）

图例：✅已修 ｜ 🟡部分修 ｜ ❌真未修 ｜ ⏸决策/blocked

### inbox（29 条）

| id | sev | 状态 | 证据（sha / 文件:行 / 命令） |
|---|---|---|---|
| F-AI-101 | medium | ❌ | `src/models/gpt.js:83` 仍 `err.message.includes('image_url')`，err.message 非字符串即 TypeError；19 个适配器同类未改 |
| F-AI-102 | low | 🟡 | `_shared.js:25,29,33` 已有 `FAILED_REPLY` / `failedReply()` / `isFailedReply()` 三个具名 helper（原为散落字符串）⇒ 收敛了；但**机制仍是字符串前缀**，未改成 ok/code 通道 |
| F-AI-103 | medium | 🟡 | `skill_library.js:31-44` 新增 `always_show_skills` 精选 11 条 + `skill_index` 目录 + 按需加载 ⇒ 全量注入收窄；但**技能仍在注册表里可被调用**（目录≠权限），高破坏性技能未被移出可调用集 |
| F-DEP-003 | high | ✅ | 补丁已换 `patches/mineflayer+4.39.0.patch`（2 个 hunk，4.33.0 已删，sha `7a5e5d0`）；**已装 node_modules 哨兵实测**：`grep -c incorrect_for_wooden_tool digging.js` = **2**、`timeout: 500,` = **1** |
| F-DEP-013 | medium | ❌ | 安装期脚本面仍在：`package-lock.json` 里 `hasInstallScript` 的包 **5 个**（canvas/gl/protobufjs/@google/genai + 本包 postinstall）；`grep ignore-scripts` 仅出现在 start.bat 的**警告文案**（`:101/:113` 说"别用"），无白名单策略 |
| F-EXEC-101 | high | ❌ | `src/agent/tasks/**` 代码级裸斜杠 chat = **37 处**（node 精确统计：`cooking_tasks.js` 27 + `tasks.js` 10 + `construction_tasks.js` 0；含注释共 46）。新增的只有 `ALLOW_TASK_CHEATS` 闸（`tasks.js:429-438`）跳过 cheat 段 ⇒ **绕过 command() 白名单的本质未变**。※ 全仓另有 1 处 `atom_input_misc.js:118` 的 `/msg`（D3 已判定实际不可达），故"全仓 38"这个数在 D3 里被我混用成了"tasks 内 38"，**以本行 37 为准**（见 §五 更正说明） |
| F-EXEC-102 | high | ❌ | `mindserver.js` 的 `socket.on('shutdown')` 仍是 `stopAgent()` 循环 + `setTimeout(()=>process.exit(0), 2000)`，**不 await 子进程退出**（无 `child.on('exit')` / `Promise.all`） |
| F-EXEC-103 | medium | ❌ | `skills.js:1500-1502` `await opened.container.deposit(...)` 后**直接 `return true`**，不比对容器/背包实际差值 ⇒ 仍是"按意图判成功" |
| F-EXEC-104 | low | ❌ | `skills.js:1348-1397` `equip()` 里 7 处 `await bot.equip(...)` **均不检查返回值**，函数末尾无条件 `return true`；也不查 `interrupt_code` |
| F-EXEC-105 | medium | ❌ | `executor.js:686-693` 高度不足分支仍把 `moveToXZ` 的 ok 当结果返回，补垫高失败不回传 |
| F-EXEC-106 | medium | ❌ | `executor.js:252`、`:354`、`:739` 三处 `/air/i` 仍在，把"挖掘失败"判成"已经挖掉" |
| F-EXEC-107 | low | ❌ | `utils/loop_lag.js:28-33` 仍只有 `maxLagMs` 单调累加，**无窗口/无衰减** ⇒ 一次抖动永久污染 |
| F-EXEC-108 | low | ❌ | `skills.js:1774-1803` 仍**自己内联构造 `scaffoldIds`**，未引用唯一真相源 `scaffold_blocks.js`（`grep scaffold_blocks skills.js` 无命中）⇒ 清单双份仍在 |
| F-EXEC-109 | low | ❌ | `construction_tasks.js:47-49` `const result = blueprint.checkLevel(...)` 后直接 `result.mismatches.length`，**无 null/类型判断** |
| F-EXEC-110 | low | ❌ | `construction_tasks.js:738` `addWindowsAsSquares(matrix, newZ, newY, newZ, …)` — 第 2 个数参仍是 `newZ`（应为 `newX`）⇒ **房子没有窗户的 bug 仍在**（`:741` 的 Plane 同理） |
| F-EXEC-111 | medium | ❌ | `composite_registry.js:109` `run: (bot, args, ctx) => runCraft(bot, args.item, args.count)` —— ctx 仍未传 |
| F-EXEC-112 | medium | ❌ | `mindserver.js:516-521` create-agent 只读 `settings_spec[key].required` / `default`，`type`/`options` 全树仍零读取 |
| F-GATE-001 | medium | ❌ | `commands/index.js:30-33` 仍 `if (!settings.companion_mode) return true;`；`settings_spec.json` 仍**无** `companion_mode` 键 ⇒ 面板创建的 agent 全开（与 F-AI-204 同一根因） |
| F-GATE-002 | low | ❌ | `tools/unit_all.mjs:36-41` EXCLUDE 仍 4 条，含 2 个"引用已删除 chunk_map.js"的死测试（`test_mca_import` / `test_tile_map`） |
| F-GATE-003 | low | ❌ | `eslint.config.js:40-42` `curly`/`no-unused-vars`/`no-unreachable` 仍全 `"off"` |
| F-REG-002 | high | ✅ | `6c1b798`（`fix(deps): 缺 lock 时降级 npm install 并告警，而非硬失败`）；`start.bat:93` 起有降级分支、`:101/:113` 两处均给 `--ignore-scripts` 警告 ⇒ **新 clone 不再硬失败**。残留：lock 仍未入库（见 §二 ⏸） |
| F-REG-003 | medium | ✅ | `6c8758e`（`完整性闸接进 gate`）；实测 `package.json` 的 **`gate` 第一段就是 `node tools/patch_integrity.mjs`** ⇒ 提交时即拦，不再只拦启动 |
| F-RT-004 | low | 🟡 | 实测覆盖：`.env`✓ `.token`✓ `.mindserver-token`✓；**`server.crt`✗ `keystore.jks`✗ `config.local.ts`✗** ⇒ 三条缺口仍在（`git check-ignore` 逐个验过） |
| F-SEC-101 | high | ⏸🟡 | 见 F-SEC-202：`enable-rcon=true`、`server-ip=`（=绑所有网卡，`:14/:47/:54` 现状未变）；口令已轮换（32→48 位，值不抄录）；**防火墙规则查询需管理员，实测 `netsh ... show rule` 返回"请求的操作需要提升"** ⇒ 无法在不提权前提下证实已生效 |
| F-SEC-102 | medium | ❌ | `grep -rn "console.log(err)" src/models/*.js \| wc -l` = **19**（与 finding 原文一致，未改） |
| F-SEC-105 | low | 🟡 | `hyperbolic.js:50` 已改为"要看提示词请显式开 `LOG_PROMPTS=1`"✓（**这 1 处已加门**）；但**仍有 5 处无条件打印**：`deepseek.js:36`、`grok.js:37`、`mercury.js:43`、`qwen.js:35`、`vllm.js:51` ⇒ 6 个里只改好 1 个 |
| F-SEC-206 | medium | ✅ | `58d2fb1` + `76ee07b` + `25d83fd` + `7b8cbb2` + `8fbd51c`（两仓）；实测 `.env`/`.env.local`/`*.pem`/`*.key`/`id_rsa*`/`*credentials*.json`/`*secrets*.json`/`.token`/`config.local.js` 全部命中 ⇒ 主目标达成（遗留缺口单列为 F-RT-004） |
| F-SEC-209 | low | ✅ | `server/server.properties:7` = `broadcast-rcon-to-ops=false`；且 `server/server.properties.example:7` 同步为 false（`25d83fd`）⇒ 生效 + 有可入库落脚点 |
| F-WEB-102 | medium | ❌ | `web/tsconfig.json:7-9` `"strict": false` / `"noImplicitAny": false` / `"skipLibCheck": true` 仍全关；`typecheck` = `vue-tsc --noEmit`（能跑但基本不设防） |

### claimed（10 条）

| id | sev | 状态 | 证据（sha / 文件:行 / 命令） |
|---|---|---|---|
| F-AI-204 | medium | ❌ | 与 F-GATE-001 同一根因，同一现状：`commands/index.js:30` + spec 无键 ⇒ 面板 agent 仍 70 条可见（我 D4 实测 8 vs 70） |
| F-DEP-004 | high | 🟡 | 主诉"补丁完整性无 gate 覆盖"**已修**（`gate` 首段 = `patch_integrity.mjs`，`6c8758e`）；但 **`patch-package` 仍在 `devDependencies`**（`--omit=dev` 仍会断）且 **`patches/minecraft-data+3.97.0.patch.disabled` 仍残留** |
| F-DEP-005 | medium | 🟡 | `clean:modules` 已不再删 lock（`['node_modules']`，`7331ba5`）✓；但 lock **仍未入库**（`git ls-files \| grep -c package-lock` = **0**）、659 个 tarball 仍走 npmmirror ⇒ 镜像与可复现性两点未动 |
| F-DEP-006 | medium | ✅ | 实测 lock 里 `node_modules/gl`：`integrity: 有`、`resolved: 有`（8.1.6）⇒ 完整性缺口已补 |
| F-DEP-012 | low | ✅ | `start.bat` 已 `npm ci` + 失败中止 + `9e7253c` 前移完整性校验；`6c1b798` 加缺 lock 降级 ⇒ 原 finding 的"自动 npm install"已替换（安装期脚本面另立 F-DEP-013） |
| F-REG-001 | medium | ✅ | `mindserver_proxy.js:57` 注释已改（"不能说启动日志里的 token"）；`start.bat:146` 实测有 `Read it from: mindcraft\.mindserver-token` + URL 模板（`7d15339` + `9e7253c`） |
| F-REG-004 | low | ❌ | `scripts/start-panel.ps1` 仍只有 `:139-141` 的 **web/node_modules** 检查；对 `mindcraft/node_modules` **无任何预检/无 npm 兜底** ⇒ 缺依赖仍会空耗 90s `Wait-Port` |
| F-RT-001 | medium | ❌ | `grep icacls\|inheritance:r src/mindcraft/mindserver.js` → **无命中** ⇒ token 文件 ACL 仍是继承的 `Authenticated Users:(M)` + `Users:(RX)`（我实测过：mode 落地 666） |
| F-RT-003 | low | ✅ | `mindserver.js:148` `cleanupTokenFile()`（`unlinkSync` 已接）+ `:177` `res.redirect(302, req.path+qs)` 抹掉 `?token=`；`b0e7ca7` 再收窄为"只对页面导航生效，避免打断数据接口" |
| F-RT-005 | low | ✅ | `tool_prep.js:317-323` 已改成"**先读回、再判失败**"（注释明写 `F-RT-005`：先 `blockAt` 确认，读回也没有才 throw） |

---

## 二、真未修清单（**按可利用性排序** —— 另两条流的工作依据）

排序原则：① 外部可达 + 能造成主机/系统级后果优先；② 同等后果看触发难度；③ 纯质量/正确性放最后。

| # | id | sev | 一句话（为什么这个顺序） | 关键位置 |
|---|---|---|---|---|
| **1** | **F-EXEC-101** | **high** | **37 处裸 `bot.chat('/…')` 绕过 command() 白名单**（cooking_tasks 27 + tasks.js 10），含 `/kill @e[...,distance=..200]` 与 8 条 `/fill`（合并清 100×100×10）。`ALLOW_TASK_CHEATS` 只挡住 cheat 段，**剩余裸斜杠仍直连服务端**，且这是"毁掉整个世界存档"级别 | `src/agent/tasks/cooking_tasks.js:17-24,276` / `tasks.js:372,440,473,504,514,582,586,605,627,631` |
| **2** | **F-EXEC-102** | **high** | **退出不回收 agent 子进程**：孤儿继续持 board_client 领单/续租 ⇒ 面板看着正常但停不掉，第 4/6 条防护在孤儿场景失效。任何一次"关面板"都可能留下孤儿 | `mindserver.js` `socket.on('shutdown')` |
| **3** | F-SEC-101 / F-SEC-202 | high | **RCON 仍绑 0.0.0.0:25575**（`server-ip=` 空 + `enable-rcon=true`）。口令已加固、`broadcast` 已关，但**协议仍明文对外**；防火墙规则需用户以管理员执行，**agent 无法验证、无法代做** ⇒ 只能算"部分缓解" | `server/server.properties:14,47,54` |
| **4** | F-GATE-001 / F-AI-204 | medium | **工具面 70 条对面板创建的 agent 全开**（设计 8 条）。注入/误导可用的动作集放大 8.75 倍；改 1 个函数即可修 | `commands/index.js:30` + `settings_spec.json` |
| **5** | F-AI-101 | medium | **19 个适配器 `err.message.includes` 不判类型**：上游/中间层 reject 非 Error（字符串/对象）即 TypeError ⇒ 整条模型链路崩。触发条件真实（代理/网关错误体不规范） | `src/models/*.js:83` 等 |
| **6** | F-SEC-102 | medium | **19 处 `console.log(err)` 打整个 error 对象** ⇒ 可能把请求头/含 key 的报错打进 stdout，而 `start-panel.ps1:189` 把 stdout 重定向进 `logs/` ⇒ **落盘** | `src/models/*.js` |
| **7** | F-EXEC-112 | medium | create-agent **不校验 type/options**：任意类型值直入 settings（`max_messages: "abc"` 之类），配置面可被写成非法态 | `mindserver.js:516-521` |
| **8** | F-EXEC-111 | medium | craft **不传 ctx** ⇒ 与其余 17 个注册项行为不一致，任务板/中断上下文丢失 | `composite_registry.js:109` |
| **9** | F-EXEC-103 | medium | putInChest **按意图判成功** ⇒ 库存账与实际不符，后续合成/交付会算错 | `skills.js:1500-1502` |
| **10** | F-EXEC-105 | medium | 高度不足时**补垫高失败仍返回 ok** ⇒ 上层以为到了，后续动作全在错位置执行 | `executor.js:686-693` |
| **11** | F-EXEC-106 | medium | 3 处 `/air/i` **把挖掘失败当成功** ⇒ 方块没挖掉却继续走，卡住/穿墙类怪象 | `executor.js:252,354,739` |
| **12** | F-DEP-013 | medium | **安装期脚本执行面 5 个包**无白名单策略；无 `--ignore-scripts` + 显式 rebuild 方案 ⇒ 供应链执行面敞开（与 F-DEP-004 的 postinstall 同源） | `package-lock.json` hasInstallScript |
| **13** | F-WEB-102 | medium | 面板 **strict/noImplicitAny 全关** ⇒ 类型检查形同虚设，接口契约漂移无人拦 | `web/tsconfig.json:7-9` |
| **14** | F-EXEC-104 | low | equip **无条件 return true**，不查 bot.equip 结果与中断 | `skills.js:1348-1397` |
| **15** | F-EXEC-109 | low | checkLevelBlueprint **不判空** ⇒ checkLevel 返回 null 即崩 | `construction_tasks.js:47-49` |
| **16** | F-EXEC-110 | low | embellishments **z/x 传参错位** ⇒ 程序化房子永远没窗户（功能缺陷，用户可见） | `construction_tasks.js:738,741` |
| **17** | F-EXEC-108 | low | scaffold 清单**双份**（skills.js 内联 1774-1803 vs 唯一源 scaffold_blocks.js）⇒ 将来改一处必漏另一处 | `skills.js:1774-1803` |
| **18** | F-EXEC-107 | low | loop_lag **只有历史最大值**、无窗口 ⇒ 一次抖动永久误报"主线程被占用"，污染 00-REPORT 的反证 | `utils/loop_lag.js:28-33` |
| **19** | F-GATE-002 | low | unit_all **EXCLUDE 4 条含 2 死测试** ⇒ 门禁覆盖面缺口 | `tools/unit_all.mjs:36-41` |
| **20** | F-GATE-003 | low | eslint **3 条规则从初始提交起就是 off**（curly/no-unused-vars/no-unreachable） | `eslint.config.js:40-42` |
| **21** | F-REG-004 | low | 面板链**无 mindcraft 依赖预检** ⇒ 缺 node_modules 时空耗 90s 再退，提示方向错 | `scripts/start-panel.ps1:139-141` |
| **22** | F-RT-001 | medium | token 文件 ACL 未收紧（Windows 上 `0600` 无效，实测 666；`Users:(RX)` 可读、`Authenticated Users:(M)` 可改）⇒ **同机其他账户可读 token = 完全控制 mindserver**（需第二账户，故排在 SEC-101 之后） | `mindserver.js:92-97` |
| **23** | F-RT-004 | low | `.crt`/`.jks`/`config.local.ts` 未进 gitignore 兜底 | 两仓 `.gitignore` |

> **另两条流请按 1→2→3 先动**（两条 high + RCON），这三条是"外部可达 / 系统级 / 世界级"后果；4-13 属"能用但需前置"，可按窗口批量做。

## 三、决策项 / blocked（4 条）

| id | 为什么必须先问用户或依赖外部 | 需要用户做什么 |
|---|---|---|
| **F-SEC-101 / F-SEC-202** | **防火墙规则必须管理员权限执行**。我实测 `netsh advfirewall firewall show rule name="deny-rcon-25575-in"` → **"请求的操作需要提升"** ⇒ agent 连"查"都做不到，更谈不上代做。另外三条真修法（收回 bind 牺牲手机联机 / 装登录插件 / online-mode）都改变玩法 | 以管理员运行 `scripts\tighten-rcon.ps1`（外层仓 `4baeb7b` 已备），或明确接受 RCON 对外 |
| **F-DEP-005 残留** | lock 入库 = 把 286KB 的 lock 提交进仓。captain 已裁定"今晚不动"，理由成立：若 lock 与 package.json 不同步，`npm ci` 立刻失败 ⇒ 反而打死启动盘（虽有 `6c1b798` 降级，但仍是风险） | 用户决定何时入库 + 是否同时切回官方源 |
| **F-DEP-004 残留** | `patch-package` 在 devDependencies（`--omit=dev` 断）+ `.patch.disabled` 残留 ⇒ 要不要把 patch-package 移进 dependencies、要不要删 disabled 补丁，涉及构建链判断 | 与 F-DEP-013 一并决策（安装期脚本策略） |
| **F-AI-103** | "高破坏性技能是否从可调用集移除"是产品决策（会影响 bot 能力），不是纯技术修复 | 用户/产品拍板技能白名单 |

## 四、我建议先修哪 5 条 + 为什么

| 优先 | id | 为什么是它 | 成本 |
|---|---|---|---|
| **1** | **F-EXEC-101**（37 处裸斜杠） | 唯一能**一次性毁掉整个世界存档**的活口子（`/fill` 万格级 + `/kill` 200 格）。且已被 `ALLOW_TASK_CHEATS` 部分挡，说明**改造已在路上**，剩下的收敛到 `command()` 相对顺手 | 中（27+10 处替换，需白名单登记 6 条斜杠命令） |
| **2** | **F-EXEC-102**（退出不回收子进程） | 每次关面板都可能留孤儿（继续领单/续租），**用户会直接感受到"停不掉、重启后两份在跑"**；且它是第 4/6 条防护失效的前提 | 小（`shutdown` 里 `await Promise.all(children.map(waitExit))` + 超时强杀） |
| **3** | **F-GATE-001 + F-AI-204**（同一处，改 1 个函数） | 一次改动同时销两条账，且**恢复设计意图**（70→8）。方向改"默认拒绝"后，将来再漏键也不会变成安全失效 | 极小（`isVisibleToModel` 改 `=== false` + spec 补键 + settings_check 断言） |
| **4** | **F-AI-101**（err.message 不判类型） | **19 处同一个 bug**，触发条件真实（代理/网关返回非标准错误体）⇒ 一次崩溃整条模型链路。改成 `String(err?.message ?? err)` 是机械替换 | 小（19 处 + 可加 lint 规则防复发） |
| **5** | **F-SEC-102**（19 处 console.log(err)） | 直接接上"token/报错落盘"那条链（`start-panel.ps1:189` 重定向进 logs）——**它会把带凭据的错误体写进日志**，属于我们自己刚花一整晚治理的同一类问题 | 小（19 处改 `console.error(err?.message ?? err)` 或走统一 logger） |

> 不把 F-SEC-101/202 放进前 5，**不是因为不重要，而是因为 agent 做不了**（需管理员）——
> 它应该出现在"请用户执行"清单第一行，而不是修补流的队列里。

---

## 五、对账方法与可复现性（便于复核）

1. **补丁类**：`ls patches/` + `grep -c "^@@" <patch>` + **查已装 node_modules 哨兵**（`grep -c incorrect_for_wooden_tool node_modules/mineflayer/lib/plugins/digging.js`）
2. **脚本/配置类**：`node -e "require('./package.json').scripts"` 直接读**当前**值，不看 commit message
3. **gitignore 类**：`git check-ignore -v <name>` 逐个验（不看规则文本，看实际命中）
4. **进程/服务类**：`grep` 当前源码 + （涉及运行时的）`netsh`/`icacls` 实跑
5. **未采用 `git status`**：本轮全程未用它判定任何一条（避免 stat 缓存假脏）
6. **一处需标注的局限**：F-SEC-101/202 的防火墙规则**我无法证实是否已生效**（查询需管理员）；
7. **本轮自我更正两处数字**（初次用 bash 管道统计时被引号/注释过滤坑了，改用 node 逐行统计后更正）：
   - **F-EXEC-101**：初稿写"37（原 38，减 1）"→ **错**。真实情况是 `src/agent/tasks/**` **一直是 37 处代码级**；
     D3 里那个"38"是**全仓**计数（37 + `atom_input_misc.js:118` 的 `/msg` 1 处），
     D3 报告把它写成了"38 处全在 tasks/" —— 那是我的口径混用。**以 37（tasks 内）/ 38（全仓）为准。**
   - **F-SEC-105**：初稿写"仍有 6 处无条件打印"→ **错**。真实是 **5 处无条件**（deepseek:36 / grok:37 /
     mercury:43 / qwen:35 / vllm:51）+ **1 处已加门**（hyperbolic:50）。
   两处更正都用 `node` 逐行统计复核过，命令见本节 1-4 条的同款手法。

**给下游的提醒**：本表 39 行是我逐条读代码得出的；若某条你读到的与我不一致，**以代码为准并回报我**——
本轮的意义就是把"自证体系与实际状态脱节"这件事一次性对齐，不要再引入第三份口径。
