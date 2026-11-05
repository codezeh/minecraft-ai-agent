# recon-scout 侦察日志（夜班漏洞猎杀 · 部门制）

## R1 2026-11-06 01:14–01:32 | D1 依赖与供应链部 · 侦察 | 10 条 finding（2 high / 3 medium / 5 low） | 无阻塞

**做了什么**
- 用真实 lock 版本跑 `npm audit --json`，两处各一遍：
  `mindcraft/`（547 个 lock 条目）+ `web/`（112 个条目）。
  注意：默认 registry 是 `registry.npmmirror.com`，它**不支持** audit bulk 端点
  （`404 NOT_FOUND [NOT_IMPLEMENTED] /-/npm/v1/security/*`），必须
  `npm audit --json --registry=https://registry.npmjs.org` 才能拿到真结果 —— 这条写下来给后面的人省时间。
- 实测结果：mindcraft = critical 1 / high 13 / moderate 15 / low 0；web = moderate 3，**无 high/critical**。
- 逐条查了 high/critical 的 `via` 明细（GHSA 号 + range + cwe）与 `npm ls` 依赖路径，
  并**逐个核查运行时可达性**（有没有挂 body 解析中间件、有没有 require tar/glob、监听地址），
  据此把 3 条"audit 说 high/critical"降级到 low 并写明理由 —— 不为清数字升依赖，也不为吓人报虚警。
- `patch-package` 专项（本部门指定的高危点）：读完全部 6 个补丁、比对已装 node_modules、
  `git apply --check` 逐条验、查 gate 是否覆盖 patches/、查 postinstall 是否 dev-only。
- 供应链周边：lock 的 resolved host 统计、integrity 覆盖率、`hasInstallScript` 包清点、
  `.githooks/pre-commit|pre-push` 执行链、start.bat 自动 `npm install`、
  package.json 从初始提交到 HEAD 的依赖增删（**结论：无新增生产依赖，未见 typosquat 迹象**）。
- `npm view` 在本沙箱被 EPERM（npm cache 在 workspace 之外）拦死，涉及"某包是否有回补版本"的结论
  我都在 finding 里标了"未能核实，修补者请自行确认"，没有编版本号。

**结论（写入 queue/inbox/）**

| id | sev | 一句话 |
|---|---|---|
| F-DEP-003 | high | `mineflayer+4.33.0.patch` 与实际 4.39.0 完全不匹配，3 处 hunk 一处没生效；`npm ci` 会 postinstall 失败 |
| F-DEP-004 | high | `postinstall: patch-package` = 完整性校验之后的任意代码注入面，14k 行补丁 diff 无任何 gate 看管 |
| F-DEP-005 | medium | lock 全量 659 个 tarball 走第三方镜像 + `clean:modules` 会**删掉 package-lock.json** |
| F-DEP-006 | medium | `gl@8.1.6` 这条 lock 条目缺 resolved/integrity，而它有 install 脚本（安装期执行） |
| F-DEP-007 | medium | zod 3.25.76 GHSA-mrhx-c7xc-m3w5（openai/mistralai 生产链路），修复下界 4.6.6 = 跨主版本，今晚不动 |
| F-DEP-008 | low | tar 6.2.1（audit 里唯一的 critical）仅构建期可达，只升小版本或记录风险 |
| F-DEP-009 | low | glob 10.4.5 CLI 命令注入（audit high）但本仓从不调用 glob CLI |
| F-DEP-010 | low | body-parser 1.20.8（audit high）但全仓无 body 解析中间件、只监听 localhost |
| F-DEP-011 | low | web 3 条 moderate 全在 devDependencies（vue-tsc 链），不进构建产物 |
| F-DEP-012 | low | `start.bat` 在 node_modules 缺失时自动 `npm install`（不是 `ci`），启动即安装期执行 |

**给修补席的优先级**：F-DEP-003 → F-DEP-004（同一根因，一晚上能一起收）→ F-DEP-012（一行改动）→
F-DEP-005/F-DEP-006（要重建 lock，需在干净环境，建议单独一个 commit）→ F-DEP-008/009/010/011（择机/记录即可）。
F-DEP-007 明确**不要动**。

**阻塞 / 需要 captain 知道的两件事**
1. 队列里已有 patch-smith 用 F-DEP-001 / F-DEP-002 两个 id（prismarine-schematic 死依赖、缺 audit 门），
   我从 F-DEP-003 起编号，未覆盖其文件。
2. 基线不是绿的：`docs/audit/night/logs/` 里那份 unit_all 转储显示
   `TOTAL n=97 pass=89 fail=8`，其中 `preflight_regex_unit` 因 **CRLF 控制字符（0x0d）**
   判 FAIL、多条单测因沙箱 `EPERM mkdir`（写 C:\Users\...\Temp 被拒）失败。
   也就是说"与基线一致"的判据目前不能直接等于"全绿"，复核席需要先确认这 8 个红的归属
   （是环境沙箱导致的，还是真的回归），否则 D1 的 verify 会被误判。

## R2 2026-11-06 01:34–01:52 | D2 密钥与配置部 · 侦察 | 7 条 finding（2 high / 4 medium / 1 medium-BlueMap） | 无阻塞（1 条需用户拍板）

**做了什么**
- 全部按"先证实、再定级"做的，密钥一律**不抄明文**：只用前缀/尾 4 位/长度 + sha256 前 16 位指纹表示，
  便于 patch-smith 核对同一把钥匙而不把密钥再抄进一个入库的文档里（本目录是 git 跟踪的！）。
- 明文凭据面：`mindcraft/keys.json`（1 把非空 key）、`profiles/my-local.json`、全仓扫 `sk-*` / `rcon.password=` / `*.pem` / `id_rsa` / `.env*`。
- git 面：`git ls-files` 逐个查跟踪状态、`git check-ignore -v` 逐个查忽略理由、
  `git log --all -p -S"..."` 查历史（根仓 + mindcraft 仓，含所有 remote 分支）。
- 配置面：`server/server.properties`、`config/network.json`、`paper-global.yml`、全部插件配置、
  `ops.json`/`whitelist.json`、`mindcraft/settings.js`、`web/vite.config.ts`。
- 暴露面用**运行时实证**而非读配置猜：`netstat -ano` 看 8100/25575，`logs/server-console.log` 里的
  `RCON running on 0.0.0.0:25575`、`netstat` 里 `0.0.0.0:8100 LISTENING`。

**结论（写入 queue/inbox/）**

| id | sev | 一句话 |
|---|---|---|
| F-SEC-201 | high | `mindcraft/keys.json:2` 明文真实 key（`sk-0aa7…`，67 位，指纹 7396a9cbdd8e0227）；未跟踪、未入历史，但明文落盘 |
| F-SEC-202 | high | RCON 开在 **0.0.0.0:25575**（`enable-rcon=true` + `server-ip=` 空 + `network.json bind:"all"`），协议明文无速率限制 |
| F-SEC-203 | medium | 旧 8 位弱口令（sha `e9501a252b77`）残留在 3 份备份里；当前 32 位口令另有 2 份副本（轮换只改了生效文件） |
| F-SEC-204 | medium | 离线模式 + 白名单只有 1 个名字 ⇒ 冒用 `HEAVENZEH` 即身份接管；`ops.json` 里 341 个 lvl4 op bot 且入库 |
| F-SEC-205 | medium | 握手 token 被打印到 stdout，而 `start-panel.ps1:189` 把 stdout 重定向进 `logs/mindcraft-console.log` ⇒ 下次启动就落盘 |
| F-SEC-206 | medium | 两个仓的 .gitignore 都**不忽略** `.env`/`.env.local`/`secrets.json`/`id_rsa` ⇒ 修 F-SEC-201 时会当场造出新的可提交明文密钥 |
| F-SEC-207 | medium | BlueMap Web 服务开在 **0.0.0.0:8100**（netstat 实证正在 LISTENING），无鉴权，暴露世界地图与在线玩家位置 |

**已核实的负面结论（别再重复排查）**
- 无 `.env*`、无 `*.pem`/`id_rsa`/`*.keystore` 任何私钥文件（全盘 find，排除 node_modules/.git）。
- **历史里没有真实密钥**：`git log --all -p -S"OPENAI_API_KEY" | grep -oE "sk-[A-Za-z0-9]{20,}"` → 空；
  `rcon.password` 的历史 diff 里只出现过 `CHANGE_ME`；`git log --all -- keys.json` → 空（从未提交）。
- `web/src` 与 `web/dist` **无硬编码凭据**（`sk-` 正则 0 命中）。
- 根目录三个 `*.mjs` 探针（m6probe / m6_furnace_probe / m6_harvest_probe）**无凭据**。
- `profiles/my-local.json`（中转站 URL + owner 名单）**已被 gitignore 且不含 key**。
- 插件配置里只有默认占位（CoreProtect `mysql-password:` 空、SkinsRestorer `password: pass`、
  BlueMap `password: ""`），没有真实值。
- `mindcraft/settings.js` 的默认值是**安全侧**：`allow_insecure_coding: false`、
  `render_bot_view: false`、`allow_vision: false`、`log_all_prompts: false`、`host: 127.0.0.1`。
- 代码不打印 key：`grep -rnE "console\.(log|warn|error)\([^)]*getKey"` → 空。
- `tmp/rotate_rcon_password.mjs` 本身干净（只打印长度，不打印口令）。

**给修补席的优先级**：F-SEC-201（外部化，`src/utils/keys.js` 已支持 env 回落，零代码改动）
→ F-SEC-206（三行 .gitignore，**必须先于** F-SEC-201 落地，否则搬家当天就写出可提交的 .env）
→ F-SEC-202（RCON 收回 loopback，一行 server-ip）→ F-SEC-203（清残留副本）→
F-SEC-205（不打印 token）→ F-SEC-207（8100 关掉或不放行）。
F-SEC-204 **需要用户拍板**，patch-smith 只做"配置里标注剩余风险 + ops/whitelist 移出 git 跟踪"。

**阻塞 / 需要 captain 知道**
1. F-SEC-204 是**用户在 `config/network.json` 里明确权衡过的取舍**（文件里自己写着"离线模式下任何人都能
   冒用 op 名字进服"）。改它要么加插件、要么改 online-mode、要么收 bind —— 三条都影响"手机/局域网能不能连"，
   属用户决策，不是修补席能定的。
2. F-SEC-203 的彻底清理要删 3 个备份文件，属破坏性动作 → 我给的是"非破坏"替代（只把值清成 CHANGE_ME），
   captain 若允许删除再让 patch-smith 删。
3. 上一轮 R1 报的"基线 8 红（CRLF + 沙箱 EPERM mkdir）"仍然没定论，D2 的 verify 同样会撞到它。
   【captain 已定案，以这条为准：8 红作废。最终基线 = `gate:full` exit 0、96/97 通过、4 个真实跳过、
   `preflight_regex_unit` 37 通过 0 失败、`web typecheck` exit 0、`npm run lint` 197（存量）。
   后续所有 verify 一律按这套判据写，不再引用 8 红。】

## R3 2026-11-06 01:36–02:05 | D3 执行体与注入部 · 侦察 | 3 条 finding（1 high / 1 medium / 1 low）+ 独立复核 38 处裸斜杠 | 无阻塞

**做了什么**
- 先把 D3 的全部危险 sink 拉清单（`child_process` / `exec` / `spawn` / `eval` / `new Function` /
  `vm.runIn*` / 动态 `import()` / 带变量的 `fs.*`），再**逐个回溯到入口**。回溯不出
  "外部输入 → sink" 完整链的一律不写 finding，只进下面的"已排除"清单（宁可少报，不报虚警）。
- 顺手把 patch-smith 从历史挖出的"38 处裸 `bot.chat('/…')`"**独立数了一遍**，
  并**修正了危险度表述**（见 F-EXEC-202 的三点核对）。
- 继续"实测优于读配置"：注入的命令行是**打印出来**验证的（未执行），路径穿越是**算路径**验证的（未读文件）。

**结论（写入 queue/inbox/）**

| id | sev | 一句话 |
|---|---|---|
| F-EXEC-201 | high | `speak.js:110` 把模型输出拼进 `powershell/say/espeak` 命令行再 `exec()` ⇒ 游戏内聊天可诱导本机命令执行；`speak` 默认 false，但**在 `SAFE_RUNTIME_SETTINGS` 里可远程打开** |
| F-EXEC-202 | medium | tasks/ 下 **38 处**裸斜杠 chat 绕过 `command()` 白名单：8 条 `/fill`（单条 25000 格、合并 100×100×10）+ `/kill @e[type=X,distance=..200]`；被 `settings.task` 挡住，**默认不可达**（真打开时按 critical 处理） |
| F-EXEC-203 | low | `/assets/item/:agent/:name.png` 的 `:name` 只小写不清洗 → `path.join` + `readFileSync` 路径穿越，可读盘上任意 `*.png`（后缀强制 `.png`，读不到 keys.json） |

**对 patch-smith 那条的独立复核（三点更正）**
1. 数字成立：代码级（排除注释）**38 处** = `cooking_tasks.js` 27 + `tasks.js` 10 +
   `construction_tasks.js` 0（它那 1 处 `:1092` 是注释，不算）。
2. `/kill` 原文是 `distance=..200`（**≤200 格内全部该类实体**），不是"距离 200 处"，
   影响面比传闻更大：200 格足以覆盖整片基地（玩家宠物、村民、展示框盔甲架、别的 bot 全在内）。
3. `/fill` 是 **8 条**（`cooking_tasks.js:17-24`）：4 条铺草 50×50×3 + 4 条清空 50×50×10，
   单条最大 25000 格，4 条清空合并 **100×100×10** ⇒ "清 100×100×10" 成立。
   **但危险度要修正**：这 38 处全被 `agent.js:334 if (settings.task)` 挡住，而 `settings.js` **没有
   `task` 键**、README/FAQ 也**没教**用户开它 ⇒ 默认配置下零处执行（连 `/clear` 都在 `initBotTask()` 里，
   一起被挡）。所以按 medium 报 + 一句"一旦有人打开 `settings.task`，这几条应升级为 critical"。

**已排除（核实过但**不报**，免得修补席白干）**
- `coder.js:203 compartment.evaluate(src)`：唯一入口 `actions.js:119` 有 `if (!settings.allow_insecure_coding)
  return` 硬闸，`grep generateCode` 全仓只有一个调用点；`eval`/`new Function` 在 src 下零命中。
- `_model_map.js:17 await import(moduleUrl)`：只遍历自己目录的 `fs.readdir(__dirname)`，无外部输入。
- `get-profile`（`mindserver.js:262`）已用 `path.basename` 防穿越 ✓（同文件图标路由漏了 = F-EXEC-203）。
- `schematic.js` 读/枚举全部收口到 `resolveSchemPath()+isUnder()`（`:52/:67`），`../` 逃逸被拒 ✓。
- `proc_control.js:179 spawn(java,args)`：args 是字面量数组、无 `shell:true`，java 来自 `findJava()` ⇒ 无注入面。
- `rcon_client.js:153 rcon(\`data get entity ${name} Pos\`)` 看着像注入，但上游 `query_target.js:150`
  先用 `bot.players?.[name] !== undefined` 精确键查挡住 ⇒ 名字必须是在线玩家名，注不进任意串
  （**这条我原本准备报，回溯后自己否掉了**）。
- `commandRegex/argRegex`（`commands/index.js:59-60`）4 组敌意输入实测（8000 引号 / 4000 个 `"x,` /
  8000 个 `1,` / 4000 个 `(`）：最慢 1.14ms ⇒ 无灾难性回溯。
- `bot.chat(\`/msg ${user} ${t}\`)`（`atom_input_misc.js:118`）：只在 `bot.whisper` 不存在时走
  （mineflayer 恒有 ⇒ 实际不可达），且 `t` 过了 `inspectChatText`。
- `storeFileFor`/`memoryDir` 用内部 namespace 常量 + 已校验 bot 名；`board_store`/`terrain3d` 的 SQL
  模板串插的是**静态 DDL 常量** ⇒ 无 SQL 注入。`camera.js:83` 截图为时间戳名 ⇒ 无穿越。

**给修补席的优先级**：F-EXEC-201（本部门唯一能到"宿主机 RCE"的；`exec`→`spawn`+stdin 三处改）
→ F-EXEC-203（3 行，复用现成 `isUnder`）→ F-EXEC-202（38 处改造量大，先加 `ALLOW_TASK_CHEATS`
显式闸止血，治本留后续）。

**阻塞 / 需 captain 知道**
1. 按 §8.1 新分工，本轮**只落 docs（finding + log），没有任何业务代码改动** ⇒ 没有 `manifest-D3.md`
   要写；三条 finding 的 `suggested_fix` 都是可直接照做的函数级补丁描述。
2. 我无法提交（会话限制），三份 finding + log 都在外层仓 `docs/audit/night/`，等 captain 代提交。
3. F-EXEC-201 与 D2 的 F-SEC-201 构成**同一条攻击链**（聊天 → 本机 RCE → 读明文 key），
   建议早报把这两条挨着写。

## R4 2026-11-06 01:40–02:20 | D4 AI/Agent 安全部 · 侦察 | 4 条 finding（2 high / 2 medium） | 无阻塞

**做了什么**
- 沿着"提示怎么拼出来"这条主线读完了 `prompter.js`（`replaceStrings` 的 11 个占位符）、
  `utils/text.js` 的渲染、`permissions.js` 的分级、`commands/index.js` 的可见性、`history.js` 的记忆，
  每一处都追到"外部文本从哪个字段进来、最后落在哪个字符串里"。
- 关键数字全部**用真实导入实测**，不靠读代码推断：写了个 `node -e` 直接 import
  `src/agent/settings.js` + `commands/index.js`，分别灌"根 settings"与"settings_spec 默认值"两套配置，
  数 `isVisibleToModel` 的结果（8 vs 70）。这一步把 captain 给的 F-GATE-001 从"配置不一致"
  变成了"工具面放大 8.75 倍"的可复现事实。
- 沿用前几轮的习惯：能证伪的自己证伪（见文末"已排除"）。

**结论（写入 queue/inbox/）**

| id | sev | 一句话 |
|---|---|---|
| F-AI-201 | high | 外部内容（玩家聊天/别的 bot/命令回显）以同一行 `User input:` 进系统提示，**无不可信围栏**；模型回合按 TRUSTED 执行 ⇒ 注入可驱动 48 条信任级命令；**无 owner 配置时人人都是 TRUSTED** |
| F-AI-202 | high | `!goal` 是信任级 → 文本原样进 `$SELF_PROMPT`（引号不转义、无限长）→ 每 2 秒重复注入系统提示、无次数上限（`MAX_NO_COMMAND` 被"每轮都用命令"绕过 + `update()` 自动重启）、写进 memory.json 跨重启存活 ⇒ 持久注入 + 持续烧 token |
| F-AI-203 | medium | 记忆闭环：聊天 → LLM 摘要 → `memory.json` → 每轮 `$MEMORY` 注入，**只限长度不过滤内容**，跨重启存活（仅 codeVersion 变更才丢） |
| F-AI-204 | medium | `companion_mode` 不在 settings_spec ⇒ 面板创建的 agent `isVisibleToModel` 永远 `return true`：实测**模型可见命令 8 → 70**（设计意图的 8.75 倍），放大 F-AI-201/202 |

**几条支撑性事实（都已实证）**
- `permissions.js:131-134` 的注释自己承认"历史里可能已混进玩家诱导出来的内容"，所以模型回合只给 TRUSTED
  —— 这个设计是对的，我据此把"能拿到什么"精确到 48 条信任级命令，而**不是**笼统说 RCE。
- `permissions.js:146-147`：没配 owner 时 `return LEVEL.TRUSTED`（人人信任级）；
  仓库默认 profiles 大多没有 `permissions` 段 ⇒ **新装即处于"任一玩家可驱动"状态**。
- `agent.js:549` + `settings.js:49 "max_commands": -1` ⇒ 单轮命令数 `Infinity`。
- `self_prompter.js:15 cooldown=2000`、`:74 MAX_NO_COMMAND=3`、`update()` 里"automatically restarts loop"。

**已排除（核实过但**不报**）**
- 权限模型本身（`canRunCommand`/`commandLevel`/`resolveLevel`）：10 条主人级命令的口子是真的挡住了，
  注入抬不到主人级 —— 我没有把它写成"提权"。
- 模型输出 → 命令的映射走 `containsCommand` 的正则 + `commandExists` 白名单 + `canRunCommand` 等级判定
  （`agent.js:567-580`），**不是**自由形式的工具调用 ⇒ 我没有报"模型可指定任意工具"这种虚警；
  真正的缺陷在"文本与指令不可区分"（F-AI-201）与"可见面漂移"（F-AI-204）。
- `prompter.promptGoalSetting` 里 `res.split('```')[1].replace('json','')` + `JSON.parse`：
  有 try/catch 且只取 `{name, quantity}`，`goal_setting` 已标 deprecated、默认流程不走它 ⇒ 不报。
- `_saveLog`（`log_all_prompts`）：默认 false，且文件名是时间戳（无穿越）⇒ 不报。
- `promptShouldRespondToBot`、`promptVision`：同样走 `replaceStrings` 裸插值，但它们是
  "要不要接话"/"看图"这两条低后果路径，已并入 F-AI-201 的同一根因，不单独占 id。
- `memory_bank`（`!rememberHere`）只作为数据回流，D3 已核实无文件路径穿越 ⇒ 不报。

**给修补席的优先级**：F-AI-202（`!goal` 升主人级 = 1 行 + `$SELF_PROMPT` 转义限长 + 循环上限，
一次改完就把"持久注入 + 烧 token"两条一起收）→ F-AI-204（`isVisibleToModel` 改"默认拒绝"方向，
1 个函数，立刻让工具面回到 8）→ F-AI-201（围栏 + 系统提示硬规则，改 `text.js` 与 profiles）→
F-AI-203（记忆过滤，可与 201 的围栏一次做完）。

**阻塞 / 需 captain 知道**
1. 本轮同样**只落 docs，零业务代码改动** ⇒ 无 `manifest-D4.md`；四条 `suggested_fix` 均为可直接照做的函数级描述。
2. **F-AI-202 与 F-EXEC-201 会互相放大**：`!goal` 注入（D4）可以诱导模型输出含引号的文本，
   而 `speak` 打开时那段文本进 shell（D3）。两条建议同一个 commit 窗口修。
3. **F-AI-204 的修法会改变行为**（工具面 70→8），用户可能立刻感觉"她变笨了"——
   建议在早报里明确写"这是恢复到设计意图"，并给一条显式开关（`companion_mode: false`）留给想全开的人。
4. 我实测用的是真实 import（不跑 bot、不连服务器），命令是 `node -e` 一次性脚本，未落任何文件。

## R5 2026-11-06 01:48–02:25 | D5 面板与 API 部 · 侦察 | 5 条 finding（1 high / 3 medium / 1 low） | 无阻塞（1 条已中途预警 captain）

**做了什么**
- **起了 6 次真实例做运行时实证**（临时端口 18080–18089，`createMindServer(false, port)`，
  不用改配置、不连 Minecraft、跑完 taskkill 清场；已确认 18080–18089 无 LISTENING 残留）：
  用 curl 打 HTTP 三出口、抓响应头、用真实 `socket.io-client` 打握手门。
  这是本轮最有效的手法 —— 三条结论（HTTP 零鉴权、门真的有效、stop-all 必然失败）全部来自实测而非读码。
- 前端注入面：`web/src` 全量 grep `v-html/innerHTML/eval/new Function` → 0 命中；
  `dist/assets/*.js` 里的 7 处 `innerHTML` 逐个看上下文，确认是 **Vue 运行时内部**
  （`_i.innerHTML=hl(...)`、`t==="innerHTML"` patchProp 等），不是应用代码。
- 脚本面：`scripts/*.ps1` 与根 `*.mjs` 查破坏性默认值（`rm -rf`/`Remove-Item -Recurse`）与硬编码凭据 → 均无。
- 沿途发现 patch-smith 已在我取证期间改过 `mindserver.js`（F-SEC-205 修复），我**没有回退它**，
  而是把"改动后的真实行为"当作基线重新取证（见 F-WEB-205 与下面的即时预警）。

**结论（写入 queue/inbox/）**

| id | sev | 一句话 |
|---|---|---|
| F-WEB-201 | high | HTTP 三出口零鉴权（实测无 token 全 200）：`/` 58752B、`/settings_spec.json` 5226B（28 项配置 schema，含 `allow_insecure_coding`/`task`）、`/console/` 398B；握手门只管 socket.io；且零安全响应头 + `X-Powered-By` |
| F-WEB-202 | medium | 无鉴权贴图代理每请求都做重活（`import('minecraft-assets')` + 资源索引），实测 **10s 打满不返回**（合法名与穿越名都一样）⇒ 未授权资源占用/轻量 DoS；同族 `:param` 已排查，只有 1 处（F-EXEC-203） |
| F-WEB-203 | medium | socket.io 事件无速率限制；`send-message` 只校验 `from`（≤32）**不限制 message 长度**，叠加 `max_commands=-1` + 按量计费 ⇒ 单连接可刷爆 token |
| F-WEB-204 | low | token 门内事件回传**本机绝对路径**（`path: full`）与整份 settings；配合 F-SEC-204（冒名）与 F-EXEC-201（找目标）是前置侦察件；另缺 CSP/X-Frame-Options/nosniff |
| F-WEB-205 | medium | **`停止面板.bat` 必然失败**：`web/scripts/stop-all.mjs:8` 连接不带任何 token ⇒ 实测 `AUTH_REQUIRED`；而 F-SEC-205 修完后 token 不再打印、脚本又不读 `.mindserver-token` ⇒ 优雅关服失效，用户会硬关窗口（存档未刷盘风险），且报错误导成"mindserver 没在跑" |

**实测证据（关键几条，已进各 finding）**
```
无 token：
  /                    → 200  58752 B      /settings_spec.json → 200  5226 B
  /console/            → 200  398 B        /console/           → 301
  HTTP 头：X-Powered-By: Express + CSP/X-Frame/nosniff/Referrer 一个都没有
握手门（真实 socket.io-client）：
  不带 token → connect_error: unauthorized: mindserver 需要握手 token | code=AUTH_REQUIRED   ← 门有效
  stop-all.mjs 的连接参数完全等同于上一行 ⇒ 脚本拿不到连接
贴图代理：合法名 10.011s 未返回 / 穿越名 10.017s 未返回（服务端 CLOSE_WAIT 堆积）
```

**已排除（核实过但**不报**）**
- **"消息体无大小上限"不成立**：`engine.io` 默认 `maxHttpBufferSize: 1e6`（1 MB），
  `grep -rn "maxHttpBufferSize" src/` → 空（本仓没覆盖它）⇒ 我没有按这条报，只在 F-WEB-203 里
  写成"1 MB 帧内但足以撑爆上下文窗口"。（**这是今晚第三次自我证伪**）
- 前端注入面：`web/src` 零 `v-html`/`innerHTML`/`eval`；`dist` 里 7 处 `innerHTML` 全是 Vue 运行时内部。
- `scripts/*.ps1`、根 `*.mjs`：无破坏性默认值、无硬编码凭据（D2 也核过一遍）。
- `get-profile`（`:262`）已用 `path.basename` 防穿越 ✓；`request-map`/`request-terrain`
  通过 `registerMapRelay(listener_socket)`（`:521`）在 `io.on('connection')` **内部**注册 ⇒ 在门后 ✓
  （我特意查了这两条的缩进，确认不是"注册在 io 上绕过中间件"那种经典错误）。
- `.mindserver-token`（patch-smith 新引入的 token 通道）**已被 gitignore**（`mindcraft/.gitignore:89`）
  ⇒ 修 F-SEC-205 没有引入新的泄漏面，这点是**正面结论**。
- `shutdown`/`stop-all-agents`/`destroy-agent` 无角色区分 = 本机单用户模型下的设计使然，
  我**没有**把它报成越权（只在 F-WEB-203 里标注"token 即完全管理员"）。

**给修补席的优先级**：F-WEB-201（把 token 门提到 HTTP 层 + 补安全头，一处中间件；
**注意同步改 `start-panel.ps1:15` 的 `$panel` URL 带上 token，否则用户点面板会 401**）→
F-WEB-205（与 F-SEC-205 同一 commit 窗口，改 `stop-all.mjs` 取 token + `stop-panel.ps1` 的 cwd）→
F-WEB-203（限流 20 行 + message 长度上限）→ F-WEB-202（缓存 + 并发上限 + 路由级超时）→ F-WEB-204（去绝对路径 + 安全头）。

**阻塞 / 需 captain 知道**
1. 本轮**只落 docs，零业务代码改动** ⇒ 无 `manifest-D5.md`。
2. **我取证期间 patch-smith 正在改 `mindserver.js`**（`git status` 显示 `.gitignore`/`mindserver.js`/`tools/server-net.mjs` 已修改）。
   我没有回退或覆盖它的改动，F-WEB-201 里引用的行号（`:85-92` `:143` `:146` `:207`）是**改动后**的现状；
   如果 patch-smith 继续改这个文件，请让它以 F-WEB-201 的 `suggested_fix` 为准做增量，别重排整段。
3. 我起过 6 个临时 mindserver 实例，其中一个在 `mindcraft/bots/_board/board.sqlite` 上做了一次
   `openBoard()`（日志原文 `[任务板] 已启用（18 个技能可派单，库 bots\_board\board.sqlite）`）。
   该文件本就在 `.gitignore` 里（`bots/_board/`），且 `openBoard` 是既有启动路径、无副作用；
   但**如实登记**：这是我今晚唯一写到的运行时状态，除此之外零写入。
4. 临时端口探针全部已 taskkill（18080–18089 无 LISTENING 残留，只有 TIME_WAIT 客户端套接字）。

## R6 2026-11-06 02:00–02:40 | 消费方审计（regression，防自己改坏自己）| 4 条 finding（1 high / 2 medium / 1 low）| 无阻塞

**做了什么**
- 逐个 commit 读 diff（mindcraft 7 个 + 外层 3 个），不看摘要；再对每个"改动点"做
  "谁在消费它"的全仓搜索（排除 node_modules / .agent-teams / docs 噪音）。
- 三处用了实测而不是读码：`patch_integrity.mjs` 真跑（exit 0）、`server-net.mjs show` 真跑（exit 0）、
  贴图白名单拿 **minecraft-data 的真实名字集**（1416 items + 1105 blocks）做匹配测试。
- 顺手清掉了我自己 D5 留下的污染：`.tmp_probe/d5srv.log` 与 `d5probe2.log` 里
  **存着两枚完整 token 明文**（那是 F-SEC-205 修复**之前**的实例打的），已 `rm` 删除并复验目录只剩 `npmcache/`。
  （d5probe3.log 是修复后实例，只有指纹——顺带证明修复生效。）

**结论（写入 queue/inbox/）**

| id | sev | 一句话 |
|---|---|---|
| F-REG-001 | medium | F-SEC-205 只改了打印侧，两处提示仍在教用户"从启动日志里拿 token"（`mindserver_proxy.js:57`、`start.bat:122`），而日志已无 complete token ⇒ `start.bat` 用户**面板无路可开** |
| F-REG-002 | **high** | F-DEP-005/012 把安装改成 `npm ci`，但 `package-lock.json` **仍被 `.gitignore:4` 忽略且未入库**（`git ls-files` = 0）⇒ 新机器/新 clone 上 `npm ci` **必失败**，start.bat 失败即中止；同时使 D1 的"可复现+完整性"在新机器上归零 |
| F-REG-003 | medium | 完整性闸**只拦启动不拦提交**（`patch_integrity` 不在 `npm run gate` 里），且要求 patch 与 SUMS 严格原子——漏一个就"整机起不来"，而报错文案是"可能被投毒"，最易诱发的自救是把它注释掉 |
| F-REG-004 | low | `mindcraft/start.bat` **全仓无调用方**（面板走 `start-panel.ps1` 直起 main.js）；面板链在 `mindcraft/node_modules` 缺失时**没有任何安装兜底**，只会在 `Wait-Port 80` 上耗满 90 秒再退出 |

**逐条落实 captain 的 7 个问题（含"查完没问题"的证明）**

1. **F-SEC-205 消费方 —— 列全了，2 处有伤**
   | 消费方 | 位置 | 结论 |
   |---|---|---|
   | agent 子进程 | `mindserver_proxy.js:46` env 继承 | ✓ 好（mindserver `:81` 先写 env 再 spawn） |
   | 自动开浏览器 | `mindcraft.js:25 getHandshakeToken()` | ✓ 好（同进程） |
   | 面板启动 | `start-panel.ps1:203-207` 读 `mindcraft/.mindserver-token` | ✓ 好，且**路径对得上**（mindcraft 以 `-WorkingDirectory mindcraft` 起，token 写 `process.cwd()`） |
   | 停止面板 | `web/scripts/stop-all.mjs:8` | ✗ **已在 F-WEB-205 报过，不重复** |
   | 单测 | `tools/mindserver_gate_unit.mjs:240` | ✓ 好（只断言源码含两个字符串） |
   | 根 `*.mjs` / `*.bat` / `mindcraft/tools/**` | — | ✓ **零消费方** |
   | **agent 侧错误提示** | `mindserver_proxy.js:57` | ✗ **F-REG-001** |
   | **start.bat 收尾提示** | `start.bat:122` | ✗ **F-REG-001** |

2. **F-SEC-104 白名单 —— 零误杀（实测，这是本轮最重要的"没问题"结论）**
   ```
   items   总数=1416  白名单拒绝=0
   blocks  总数=1105  白名单拒绝=0
   含非 [a-z0-9_] 字符的实际名字：共 0 个
   大写名：0 个（且 itemName 在测试前已 toLowerCase，大写输入也安全）
   ```
   ⇒ `^[a-z0-9_]{1,64}$` **不会让任何真实物品/方块贴图变白**。
   前端 `iconUrl()` 传的是 `encodeURIComponent(name)`，`name` 来自 minecraft-data 的 `item.name`（无命名空间），
   所以不存在 `minecraft:xxx` 被误拒的问题。

3. **F-SEC-206 `.gitignore` 兜底 —— 零误伤（实测）**
   两仓分别用 `git ls-files` 对新规则做匹配：`\.env|\.pem$|\.key$|\.pfx$|\.p12$|id_rsa|id_ed25519|credentials.*\.json|secrets.*\.json`
   → **根仓 0 命中、mindcraft 仓 0 命中**（已跟踪文件一个都没被新规则罩住）。

4. **F-DEP-005 `clean:modules` 不删 lock —— 假设检查：找到一处文档级矛盾（并入 F-REG-002）**
   `mindcraft/docs/architecture/09_crosscut.md:91,110` 至今写着
   "`package-lock.json` 被忽略 | **提交它**（待做）"，而 `package.json:56` 已经 `reinstall: … && npm ci`。
   **文档说"待做"、代码已经"必须做"** —— 且这条恰好是 F-REG-002 的根因。
   `backups/` 与 `tmp/uplink/` 里的 `npm install` 是历史快照副本，不参与当前链路，不算。

5. **F-DEP-012 `start.bat` 失败中止 —— 没有调用方依赖"失败也继续"**
   `grep -rn "start.bat" --include=*.bat --include=*.ps1` → **无输出**；
   `启动面板.bat` 走 `start-panel.ps1`，与 start.bat 完全独立 ⇒ 中止行为不会打断面板链。
   （但也因此暴露 F-REG-004：修的那条路不是用户走的那条路。）

6. **F-DEP-003 补丁替换 —— 没有第三个消费方（且 hunk 3 已在工作区重建）**
   - hunk 1（`incorrect_for_wooden_tool`）→ 保留在 `mineflayer+4.39.0.patch` ✓；
   - hunk 2（水算）→ 上游 `_getBlockAtEyeLevel` 确实覆盖；消费方只有 `block.digTime()`，
     我们的代码 `act_dig.js`/`atom_read.js` 都只是**取 digTime 当预算**，没有依赖 `isInWater` 被强制 false 的语义 ✓；
   - hunk 3（`place_block` 5s→0.5s）→ **复核席打回后 patch-smith 已按 (a) 重建**：
     工作区 `patches/mineflayer+4.39.0.patch` 里能看到 `@@ -26,7 +26,7 @@` 与 `-      timeout: 5000, / +      timeout: 500,`
     （HEAD 里还没有，属在途改动）。**第三消费方：无** —— 4 个 `placeAgainst` 调用点
     （`act_pillar.js:103`/`act_place.js:159`/`skills.js:1335`/`tool_prep.js:317`）**都不传 `timeout`**，
     所以新版 `placeAgainst` 的 `Promise.race` 分支根本没被用到，只受 mineflayer 内部超时支配
     ⇒ 影响仅是"失败时多等 4.5 秒"，与复核单结论一致，**没有额外的功能断裂点**。

7. **F-SEC-208 `_剩余风险` 字段 —— 零消费方影响（实测）**
   ```
   $ node tools/server-net.mjs show     → 正常输出两个服务器、✓ 已一致、exit=0
   servers.main 键: _说明, _剩余风险, bind, nic, whiteList, enforceWhiteList, onlineMode, players
   ```
   `loadCfg()` 只读 `one.bind / one.nic / one.whiteList / one.onlineMode / one.players`，
   不遍历字段名做校验（`Object.keys(want)` 里的 `want` 是 `desiredProps()` 现算的固定键集）
   ⇒ `_剩余风险` 不会被当成配置项，也不会触发 unknown-key 报错。与已有的 `_说明` 同一模式。

**给修补席的优先级**：**F-REG-002（删 `mindcraft/.gitignore:4` 那行 + 把 lock 入库，一次解决"新机器起不来"与"锁不稳定"）**
→ F-REG-001（两处文案，10 分钟）→ F-REG-003（把 patch_integrity 接进 gate + 错误分类，防闸被注释掉）→
F-REG-004（面板链补依赖预检，可与 003 同一窗口）。

**阻塞 / 需 captain 知道**
1. 本轮**只落 docs，零业务代码改动** ⇒ 无 `manifest-REG.md`。
2. **提交提醒（最要紧的一条）**：patch-smith 现在工作区里有
   `M patches/SHA256SUMS` + `M patches/mineflayer+4.39.0.patch` + `M tools/patch_integrity.mjs`。
   前两个**必须同一个 commit**，否则 `start.bat:77` 的完整性闸会让机器起不来（F-REG-003）。
   我已实测当前工作区这一对是自洽的（`patch_integrity` exit 0、"5 个补丁内容与基线一致"），
   也核了 **HEAD 自身自洽**（`git show HEAD:...patch | sha256sum` = `f46c3e04…` = HEAD 的 SUMS 首行）。
3. **我自己的一处污染已清除**（如实登记）：D5 遗留的 `.tmp_probe/d5srv.log`、`d5probe2.log` 内含**完整 token 明文**
   （F-SEC-205 修复前的实例打的），已删除并复验。教训：**起真实例取 token 时，日志不要落在工作区**
   （`/tmp` 在沙箱里时灵时不灵，我因此退到 `.tmp_probe`，反而把 token 写进了仓库目录树 —— 虽然被 gitignore）。
   后续同类取证我会把 token 分支用 `MINDSERVER_PRINT_TOKEN` 固定值、或直接把日志 `/dev/null`。
4. 本轮没起任何长驻实例（只跑了 `patch_integrity.mjs` 与 `server-net.mjs show` 两个只读命令），无端口占用。
