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
