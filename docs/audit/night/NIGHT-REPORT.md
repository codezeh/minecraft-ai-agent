# 夜班漏洞猎杀 · 持续报告

用户授权：当前目录 `E:\我的世界ai`，token 不限，**并发上限 3**，跑通宵直到叫停。
范围：依赖供应链 / 密钥配置 / 执行体注入 / AI-Agent 安全 / 面板 API（全要，按风险排序）。
修复政策：独立分支自动改 + 逐条提交，不动主干。停止开关：`docs/audit/night/STOP` 或对 captain 说"停"。

---

> 说明：本文按发现顺序追加。时间戳为各阶段实际时刻（以 git 提交时间为锚），非撰写时刻。

## 01:40 阶段小结（开工约 35 分钟）

### 团队
固定 3 席，吃满三并发：`recon-scout`（侦察）· `patch-smith`（修补）· `gate-keeper`（复核）。
部门制推进：D1 依赖 → D2 密钥 → D3 执行体 → D4 AI/Agent → D5 面板。17 个任务，14 条依赖。

### 已完成
- **D1 依赖部侦察**：10 条（2 high / 3 medium / 5 low）
- **D2 密钥部侦察**：7 条（2 high / 5 medium）
- **D0 门禁基线**：建立完成，含"哪些检查其实是假的"评估
- **D0 历史欠账转化**：24 条待办 + 51 条"已修复"台账（含 5 个假信号的逐条排除）
- **D3 执行体侦察**：进行中

### 今晚最值钱的五个发现（按可利用性）

| id | 级 | 一句话 |
|---|---|---|
| `F-EXEC-201` | **high** | `speak.js:110` 把模型输出拼进 PowerShell / `say` / `espeak` 命令行再 `exec()` ⇒ **聊天可诱导宿主机 RCE**。Windows 侧只转义单引号、双引号未转义；`speak` 默认 false 但在**运行期白名单**里，持 token 客户端可远程打开 |
| `F-SEC-201` | high | `mindcraft/keys.json:2` 明文真实 API key。已核实非 git 泄漏（gitignore 覆盖、从未提交、历史无该串），但 D1 的 postinstall 一旦执行，第一件事就是读它 |
| `F-SEC-202` | high | RCON 开在 `0.0.0.0:25575`（**运行日志实证**，非读配置推测）。明文协议无速率限制 → 同网段可爆破/嗅探，进去即服务器完全接管 |
| `F-EXEC-101` | high | `src/agent/tasks/**` 约 38 处裸 `bot.chat('/…')`，含 `/kill @e[...,distance=..200]` 与 8 条 `/fill` 清 100×100×10。历史审计被 preflight 用"不是运行时链路"的豁免放过，但 `tasks.js` 就是 `!do` 的运行时引擎——豁免理由不成立 |
| `F-DEP-003` | high | `mineflayer+4.33.0.patch` 与实装 4.39.0 完全不匹配，3 处 hunk **零生效** → 今天任何人 `npm ci` 都会在 postinstall 失败 |
| `F-DEP-004` | high | `postinstall: patch-package` = 完整性校验之后的任意代码注入面，14k 行补丁 diff 零 gate 覆盖 |

**最有价值的排序判断**（`recon-scout`）：`F-SEC-206` 必须排在 `F-SEC-201` 之前——两个仓的 `.gitignore` 都不忽略 `.env*` / `secrets.json` / `id_rsa`，若先把密钥搬进 `.env` 再补规则，会当场造出一个**可被 `git add` 提交的明文密钥文件**。修 A 洞时打开 B 洞，这个陷阱抓得准。

**两条口径修正**（`patch-smith` 复核历史结论得出）：
- 00-REPORT 说 `I17` "已在握手门后" **对 HTTP 端不成立**：`mindserver.js:85-92` 的 `app.use` 只做 `?token=` → `Set-Cookie` 然后无条件 `next()`，从不拒绝；握手门 `:103 io.use` 只管 socket.io ⇒ 贴图代理 / `/console` / `express.static` 三个 HTTP 出口**仍零鉴权**。
- `I15` 的 loop_lag 问题更准确的说法是"最大值**没有窗口概念**"，一次抖动后永久污染那句被当成反证引用的日志。

### 今晚修掉的两个真问题（不是漏洞，是让"验证"这个前提成立）

**1. 仓库边界：修复差点全部落进空白** ⚠️ 我排计划时漏掉的硬伤
`mindcraft/` 是**独立 git 仓**，外层 `.gitignore:13` 把它整个排除（外层 `git ls-files mindcraft` = 0）。
只在外层审计仓提交，等于**修复从来没进过任何审计历史**。
已补建 mindcraft 仓内的 `audit/night-20261106` 分支，并确立双仓提交规则。

**2. 门禁整夜恒红：根因不是代码，是检出配置**
`gate:full` 卡在 `preflight_regex_unit`（2 FAIL）。根因排查：仓库 blob 一直是**纯 LF**，是本地 `core.autocrlf=true` 每次检出时把磁盘转成 CRLF（叠加 01:05 那次 fast-forward 重新检出）。
处置：`core.autocrlf=false` + `core.eol=lf`，按 LF 重新落盘 —— **零内容变更、未产生任何提交**。`preflight.mjs` 的 CR 计数 1332 → 0。
意义：如果没修，`.githooks` 会恒红 → 全队只能 `SKIP_GATE=1` 绕过 → 今晚所有"已验证"都是假的。

顺便清掉了 Windows 上的 stat 缓存假脏（曾误报 421 个 `M`，实际 `git diff` 为空、两侧 blob sha 相同）。**教训：判断改动一律以 `git diff` 为准，不看 `git status` 行数。**

### 门禁真基线（captain 实测）

```
cd mindcraft && npm run gate:full  → exit 0
  settings_check ✅ ｜ preflight_regex_unit ✅ 37/0 ｜ preflight ✅ ｜ lint_hard ✅ ｜ unit_all ✅ 96/97（4 个真实跳过）
cd web && npm run typecheck        → exit 0
npm run lint                       → 197 errors（存量基线，不可新增）
```

### 一个必须交代的作业模式变化

成员会话是 `workspace-write` 派生的，**不能 spawn 子进程、不能 `git commit`、不能删文件**；captain 会话是 `danger-full-access`，全部可以。这是会话策略差异，热改不了。
于是改成：**成员判断，captain 执行**。成员只写文件 + 写 manifest，captain 逐条提交并回填 sha。
副作用是好的：全队只有一个 gate runner，消除了"两人同时跑 gate 互相污染"的风险。
副作用是坏的：**提交权与判决权分离后，captain 同时是执行者和最终复核人，独立性与理想状态有差距**——已要求 gate-keeper 对每条改动做独立代码级推演，不依赖我的 gate 输出下结论。

---

## 01:47 第一批修复落地 + 一个新闸被自己人打穿

### 已入库 4 条（mindcraft 仓 `audit/night-20261106`）

```
119f45f  fix(deps): start.bat 改用 npm ci 并在失败时中止 — F-DEP-012
7331ba5  fix(deps): reinstall 改用 npm ci，clean:modules 不再删 lock — F-DEP-005
4c006bc  feat(deps): 新增补丁完整性闸与 SHA256 基线 — F-DEP-004（部分解决）
7a5e5d0  fix(deps): 用 4.39.0 补丁替换零生效的 4.33.0 补丁 — F-DEP-003
```

**里程碑：4 次提交每一次都真的过了 `pre-commit` 钩子**（输出 `✓ 门禁通过`）。
这就是今晚修 CRLF 的兑现——门禁从"恒红只能 `SKIP_GATE=1` 绕过"变成真在拦。提交后 `gate:full` 仍 **96/97 通过，无回归**。

**一条被纠正的事实**（patch-smith 读 patch-package 源码得出）：`文件名版本 ≠ 实装版本` **只触发警告、不导致失败**；真正失败是补丁上下文对不上。所以 `F-DEP-003` 的正确修法是让补丁内容对上 4.39.0，不是改文件名。

### 🔴 新闸被复核席打穿：`F-DEP-004` 只做到"事后能发现"

复核席写了 16 个对抗性用例（夹具隔离，`mindcraft/` 零改动）。**判决原文**：

> 作为"漂移探测器"**可信**，作为"防篡改防线"**不可信**——现在接进 gate 只会制造假安全感。

**该报的都报了（11 条）**：改 1 字节、删 SUMS、植入后门 patch、版本漂移、基线张冠李戴……并且确认**闸不 eval 补丁内容**（塞 `$(touch /tmp/PWNED)` 没触发）。它还真抓到过本仓那个陈旧补丁（`F-DEP-003` 的形状）——**不是恒绿闸**。

**挡不住的三个结构性缺陷 + 一个接线问题**：

| 序 | 缺陷 | 为什么严重 |
|---|---|---|
| **D1** | **检查跑在载荷落盘之后** | `start.bat:73` 先 `npm ci`（触发 postinstall→patch-package 套补丁），`:82` 才检查；**且整块在 `if not exist node_modules` 内 ⇒ 只有首次安装检查、之后永不复查** ⇒ 被投毒的 node_modules 直接用 |
| D2 | `--write` 可洗白 | 篡改补丁后重建基线 → exit 0 |
| D3 | 删掉整个 `patches/` 静默放行 | 最省力的攻击：不植入后门，只**删掉安全补丁**，闸不报 |
| D4 | 根本没接线 | `npm run gate` 4 步不含它 |

已下令按最小改造顺序修：① 检查移到 `npm ci` **之前**（`--no-version-check`）并移出 `if not exist node_modules` 块 ② gate 路径拒收 `--write` ③ SUMS 在但 `patches/` 缺失 ⇒ FAIL ④ 最后接线。
**`F-DEP-004` 定性为"部分解决（仅事后可发现，未阻止注入）"，不标已修。**

> 这是今晚最有教育意义的一段：**我们写了个安全闸，然后自己人把它打穿了。** 如果没人做这一步，早报上会写着"补丁完整性已加固"，而实际上一次 `--write` 就洗白了。诚实边界也记下：D1 那条是**读执行顺序推出**的，不是端到端实跑 `npm ci`。

### D4（AI/Agent）侦察 4 条

| id | 级 | 一句话 |
|---|---|---|
| `F-AI-201` | high | 外部内容与系统指令在提示里**不可区分**：`text.js:9` 把所有非 assistant 轮渲染成同一行 `User input: ${content}`（无发言人、无不可信围栏），经 `$CONVO`/`$MEMORY`/`$SELF_PROMPT` **裸插值进 system 提示**。后果精确到"可驱动 48 条 TRUSTED_COMMANDS，拿不到 10 条主人级"——**没有**虚报成提权 |
| `F-AI-202` | high | `!goal` 是**信任级** → 文本原样进 `YOUR CURRENT ASSIGNED GOAL: "${prompt}"`（引号不转义、无长度上限）→ 每 2 秒重复注入系统提示；循环停不下来的三种绕法都实测过；goal 还写进 `memory.json` **跨重启** ⇒ 持久注入 + 持续烧 token |
| `F-AI-203` | medium | 记忆闭环污染：聊天 → 摘要 → `memory.json` → 每轮 `$MEMORY`，只限长度不过滤内容。**注入记忆不需要任何命令权限，会聊天就行** |
| `F-AI-204` | medium | `companion_mode` 未声明 ⇒ 面板创建的 agent 模型可见命令 **8 → 70**（实测真实 import，不是我转述的 64） |

**`F-AI-201` 里最要命的默认值**：`permissions.js:146-147` 没配 owner 时 `return LEVEL.TRUSTED` ⇒ **新装即"任一玩家可驱动"**（仓库默认 profiles 大多没有 permissions 段）。

**`F-AI-204` 的修法方向**（侦察兵提出，已批准）：改成 `companion_mode === false` 才全开、键缺失按**收敛**处理。理由——将来再漏一个键，后果是"功能不灵"而不是"安全失效"。**同一个仓库里两种默认方向（`permissions.js:100` 默认拒绝 vs 这里默认放行），本身就是缺陷。**
⚠️ 修完是 **70 → 8**，用户可能立刻觉得"她变笨了"——**这是恢复到设计意图**，并保留 `companion_mode: false` 作显式全开开关。

### 侦察席三次主动"不报"，比多报十条更值钱
- 否掉 `rcon_client.js:153` 命令注入：回溯到上游 `bot.players?.[name]` 精确键查挡住
- 不把 `F-AI-201` 写成"提权"：权限模型真挡住了 10 条主人级
- 不报"模型可指定任意工具"：模型输出走 `containsCommand` 正则 + 白名单 + 等级判定，**不是**自由 tool-call

### 又一条"改完才发现没落脚点"
`F-DEP-103`（新，blocked）：**`mindcraft/package-lock.json` 被 `mindcraft/.gitignore:4` 排除**，而 `web/` 的被追踪 ⇒ 生产依赖树（547 条、13 个 high 全在这）**没有任何 git 历史**，`F-DEP-005/006/010` 三条 lock 修复**没有落脚点**。历史 06 分册和 00-REPORT 都没提这条。需用户决定是否删 `.gitignore:4` 并首次入库 lock（6409 行 / 286KB）。

## 01:50 复核席推翻了三条修法（今晚最重要的质量控制）

复核席独立重跑，把侦察兵和我的修法各推翻了两条。**我逐条核证后确认它对。** 记录在此，因为"差点误改"比"改对了"更有教育意义。

**① 一个会让整套修复当场崩的顺序错误（`F-SEC-201`）**
侦察兵说"把密钥搬到 `.env`"。我核了 `src/utils/keys.js`：第 5 行 `keys.json` **优先**、第 14 行才回落环境变量、**第 17 行取不到就 `throw`**。
⇒ 若先清空 `keys.json` 而用户还没 `setx`（且 `setx` 只对**新进程**生效、只能用户本人执行），**所有模型调用当场抛异常全崩**，不是"暂时不可用"。
**最终做法**：今晚不清空。只写三步手册，标 blocked 等用户。
```
1. 用户本人：setx OPENAI_API_KEY "<真值>"
2. 新开进程验证：getKey('OPENAI_API_KEY').length === 67
3. 验证通过后，才允许把 keys.json 清成 CHANGE_ME
```
实测现状：`keys.json` 里只有 `OPENAI_API_KEY` 有真值（67 位），其余 15 个键全空。

**② `F-SEC-202` 首选修法是错的（会砍掉手机联机）**
侦察兵建议 `server-ip=127.0.0.1`。复核席指出：`server.properties` **没有独立的 rcon 绑定项**，RCON 只能跟 `server-ip` 走 ⇒ 收了 loopback **25565 也一起收**，而手机能连正是 `config/network.json` 存在的唯一理由。
更关键的是**会复发**：`network.json` 仍 `bind: all`，下次谁跑 `server-net.mjs apply` 就把 `server-ip` 改回空 —— 修完当天有效、下次切配置即还原。
**最终做法**：Windows 防火墙拦 25575 入站，`server.properties` 一个字节不改。防火墙不检查 loopback ⇒ bot 走 `127.0.0.1:25575` 照常、手机照玩。
代价：**规则不入库、换机失效、无法用 `git diff` 证明**，只能实测；且判据不能用 `netstat`（拦包不拦监听），必须从另一台机器 `Test-NetConnection <本机LAN IP> -Port 25575` 应失败。

**③ `F-SEC-204` 升 high，且项目自己的安全论断是错的**
`server-net.mjs` 头部写"开白名单之后冒用名字就没用了"——**在"白名单只有一个名字"时这句是错的**：白名单只拦"不在名单上的名字"，而攻击者冒用的恰恰是名单上那唯一一个。
升 high 的依据：`profiles/my-local.json:6 owner=HEAVENZEH` + `settings.js:19` 激活该 profile ⇒ 冒名 = **OWNER 级**，`OWNER_ONLY_COMMANDS` 含 `!newAction`（执行代码）、`!restart`、`!attackPlayer`。
**减轻因素（如实记录，不夸大）**：HEAVENZEH 本人**不是 op**，所以单看 204 是"控制 bot + 主人身份"；拿服务器管理权要走 RCON（那是 202 的链）。**两条链合起来才是完全接管。**

## 01:56 D2 密钥部 5 条入库 + 三条定性纠正

### 已入库 6 个 commit（跨两仓，每次过钩子）

| 仓 | sha | finding |
|---|---|---|
| 外层 | `49a9cfd` | F-SEC-206 `.gitignore` 凭据兜底 |
| 外层 | `d80caeb` | F-SEC-208 更正"白名单=安全边界"错误论断 |
| 外层 | `5e2694b` | F-SEC-205 面板从 token 文件取地址 |
| mindcraft | `58d2fb1` | F-SEC-206 同批兜底规则 |
| mindcraft | `8c983c4` | F-SEC-208 注释更正 |
| mindcraft | `62a93a5` | F-SEC-104 贴图路由白名单 + F-SEC-205 token 脱敏 |

累计已入库 **10 个修复 commit**。

### 🔴 三条必须纠正的定性（复核席实测，早报以此为准）

**1. 依赖 CVE 一条都没消除，别写"依赖漏洞已修复"**
实测 `mindcraft {moderate:15, high:13, critical:1, total:29}`、`web {moderate:3, high:0, critical:0}`，与侦察基线**逐项相同**。根因：4 个 commit 里**零依赖版本变化**（`package.json` 只改了 2 行 scripts，无 overrides）。
准确说法：**"依赖审计首次建立可复现基线（本仓 29 条 / 面板 3 条），CVE 面本轮未缩小；4 条需升版本的按风险分级登记为 blocked / accepted-risk。"**

**2. `F-DEP-012` 是"部分解决"，不是"已修"**
`npm ci` **仍然执行 lifecycle scripts**（`postinstall=patch-package` + canvas / gl / protobufjs / @google/genai）。修复让"安装期脚本执行"从**不确定变成确定**，风险**没消除**。真正消除要靠脚本白名单或 `--ignore-scripts` + 显式 rebuild，另开单。

**3. `F-DEP-003` 被打回：补丁本体对，但理由错、且尚未生效**
复核席没采信修补者的 `diff -q`，自己复制 pristine `digging.js` 套了一遍：`267→273` 行、`diff` 仅 `246a247,252` 六行插入、其余零改动 ⇒ **补丁内容正确、无夹带**（这比"逐字节相同"更强）。
但 **hunk 3 的丢弃理由错了**：`_getBlockAtEyeLevel` 只存在于 `digging.js:251/258`，与 `place_block` 无关，而 `place_block.js:29` 的 `timeout: 5000` 仍在。旧 hunk 客观上套不上（4.39.0 重构了那段），但**"套不上" ≠ "意图不重要"**——它要把放置失败从 5s 压到 0.5s，丢掉意味着每次失败多等 4.5 秒。**这个行为变化无人记录、无人决策，被夹在"依赖补丁重建"里静默发生了。**
**另：修复尚未生效** —— `grep -c incorrect_for_wooden_tool node_modules/.../digging.js` = 0，说明补丁能套但没套，需跑一次 `npm ci` 才真正生效。

### 🔴 我们自己的修复打瘸了一个功能（连带后果）
`F-SEC-205` 改完后，**"停止面板"按钮 100% 失败**。链路：`停止面板.bat` → `stop-panel.ps1` → `web/scripts/stop-all.mjs`，而 `stop-all.mjs` 的连接参数里**没有任何 token 来源**（`auth_gate.js` 只认 auth payload / 自定义头 / query / cookie 四种）。
这条链**本来就坏**，但改完后从"还能手抄日志里的 token 救一下"变成"完全没救"——因为只印指纹了，而新通道 `.mindserver-token` 脚本又不读。
**严重性不在"按钮不灵"，在于**：`stop-panel.ps1` 注释写明"走 RCON stop 会自己刷盘关闭，不是强杀"。链断之后用户看到的是 **20 秒超时 + "mindserver 可能没开"（把人往错方向带）**，实际是鉴权失败；用户自然反应是直接关窗口 ⇒ **非优雅关停 ⇒ 世界存档未刷盘风险**。
已立 `F-WEB-205`，要求与 F-SEC-205 同窗口修。

### 一条被工具吞掉的东西
`scripts/start-panel.ps1` 的 **UTF-8 BOM 在编辑过程中被删了**（HEAD `ef bb bf` → 改后 `23 20 4d`）。这文件头注释写明"所有中文都在这里（UTF-8+BOM）"——**PowerShell 5.1 无 BOM 会把中文读成 ANSI 乱码**。我在提交前发现并恢复，已把检查写进 PLAYBOOK §8.8。

### 一条流程违规，已立规矩
D1 收尾时 `F-DEP-003/004/005/006/012` 五条的 finding 文件被**清空** ⇒ 复核席只能对着 commit 和摘要复核，**无法按"读原始单"的规程独立判断**。已立 PLAYBOOK §8.7：修补者只 `mv`，不得删除或清空 finding。

## 02:02 五部门侦察全部收官 · 总账

| 状态 | 数量 |
|---|---|
| 已复核通过 `verified/` | 8 |
| 待复核 `done/` | 10 |
| 修复中 `claimed/` | 9 |
| 待认领 `inbox/` | 33 |
| **活跃 finding 合计** | **52**（13 high / 24 medium / 15 low） |

按来源：`F-EXEC` 15 ｜ `F-SEC` 14 ｜ `F-WEB` 7 ｜ `F-AI` 7 ｜ `F-DEP` 6 ｜ `F-GATE` 3
按表现：**已入库修复 10 个 commit**（mindcraft 7 + 外层 3），每次提交都真的过了 pre-commit 钩子。

### D5（面板与 API）5 条——全部用"起真实例 + curl + 真实 socket.io-client"取证

| id | 级 | 一句话 |
|---|---|---|
| `F-WEB-201` | **high** | HTTP 三个出口**零鉴权**（实测无 token 全 200）：`/` 58752B、`/settings_spec.json` 5226B、`/console/` 398B；**零安全响应头**（只有 `X-Powered-By`）。high 的理由不是"能读到东西"，而是**认证边界摆错位置**（同一次会话里 socket 要 token、HTTP 不要）+ `settings_spec.json` 把 `allow_insecure_coding`、`task` 这两个隐藏开关**直接列成清单** |
| `F-WEB-205` | medium | **停止面板.bat 必然失败** → 优雅关服失效 → 用户硬关窗口 → **存档未刷盘风险**（详见上一节） |
| `F-WEB-202` | medium | 无鉴权贴图代理每请求做重活，实测**合法名与穿越名都 10 秒打满不返回**（CLOSE_WAIT 堆积）⇒ 任意网页一个 `<img>` 就能打 |
| `F-WEB-203` | medium | socket 事件**零速率限制**；`send-message` 只校验 `from`（≤32），**不限 message 长度与频率**；叠加 `max_commands=-1` + 按量计费 ⇒ 刷爆 token |
| `F-WEB-204` | low | token 门内事件回传**本机绝对路径** + 整份 settings ⇒ 是 `F-SEC-204`（冒名）与 `F-EXEC-201`（RCE 后找目标）的前置侦察件 |

### 正面结论（同样重要：证明"没报的也都查过"）
- **握手门真的有效**：用真实 socket.io-client 复刻 `stop-all.mjs` 的参数打真实例 → `AUTH_REQUIRED`。27 个 `socket.on` 全在 `io.on('connection')` 内；`request-map`/`request-terrain` 经 `registerMapRelay` 注册也确认在门内（**特意查了缩进**，排除"注册在 io 上绕过中间件"那个经典错误）。
- **前端注入面干净**：`web/src` 零 `v-html`/`innerHTML`/`eval`/`new Function`；`dist` 里 7 处 `innerHTML` 逐个看上下文，全是 Vue 运行时内部。
- **同族 `:param` 只有 1 处**（即 `F-EXEC-203`）——据此确认它维持 low 是对的。
- `.mindserver-token` 已被 gitignore ⇒ `F-SEC-205` 的修复**没有引入新泄漏面**。

### 侦察席三次"自我证伪"，比多报十条更值钱
1. 否掉 `rcon_client.js:153` 命令注入（上游 `bot.players?.[name]` 精确键查挡住）
2. 不把 `F-AI-201` 写成"提权"（10 条主人级真挡住了）
3. **否掉我转述的"消息体无大小上限"** —— engine.io 默认 `maxHttpBufferSize=1e6`，本仓未覆盖。**是我错了，它纠正对了。**

## 02:05 消费方审计：我们自己改坏了三处（全部成立）

侦察席转做"消费方审计"——专门查**我们的修复打坏了什么**。这类问题**不在任何漏洞单里**，只能靠"改完之后回头看谁在消费"。

| id | 级 | 我们是怎么把它弄坏的 |
|---|---|---|
| `F-REG-002` | **high** | 把 `npm install` 改成 `npm ci`（"严格按 lock 装"），但 **`package-lock.json` 从来没进过 git**（`.gitignore:4` 忽略、`git ls-files`=0，286 KB 只在这台机器的磁盘上）。本机有 lock 所以没事，**换一台机器 `npm ci` 确定性失败 → 启动链路当场断** |
| `F-REG-001` | medium | token 不再打印进日志后，**两处提示还在教用户"去启动日志里找 token"**：`mindserver_proxy.js:55-58` 的 AUTH_REQUIRED 提示、`start.bat:122` 的 `http://localhost:8080`（不带 token）。用 `start.bat` 的人**无路可走** |
| `F-REG-003` | medium | 完整性闸要求 `sha256(patch) == SHA256SUMS`，所以**任何半截提交都会让整台机器起不来**（不是降级，是全断），而报错文案却是"可能被投毒"——最容易诱使人把闸注释掉 |
| `F-REG-004` | low | `mindcraft/start.bat` **全仓无调用方**（面板走 `start-panel.ps1` 直起 `main.js`）；面板链缺 `mindcraft/node_modules` 时不说"缺依赖"，而是 `node main.js` 立刻死、`Wait-Port 8080` **空耗 90 秒**再 `exit 1`，且 `start-panel.ps1:141` 的警告只针对 `web\node_modules` |

**两条因此改掉的规矩**：
1. **今晚不擅自把 lock 入库** —— 如果 lock 与 `package.json` 不同步，`npm ci` 会失败，而 `start.bat` 现在"失败即退出" ⇒ 我会亲手把启动盘打死。改成标记"本机有效、换机即断，依赖 `F-DEP-103` 解锁"，等你决定。
2. **`patch` 与 `SHA256SUMS` 必须同一个 commit**，禁止分两次提交（否则中间态机器起不来）。

### 三条"查完没问题"的证明（同样是结论，不是推测）
- **`F-SEC-104` 零误杀**：拿 minecraft-data 真实名字集实测 —— `items 1416`、`blocks 1105`，被白名单拒绝 **0 / 0**；无含非 `[a-z0-9_]` 的名字、无大写名；前端传的是无命名空间的 `item.name`。⇒ **面板贴图不会变白，功能零退化。**
- **`F-SEC-206` 零误伤**：两仓 `git ls-files` 对新规则命中 **0**（包括 `*.key`：两仓没有任何非密钥的 `.key` 文件）。
- **`F-DEP-003` 无第三消费方**：4 个 `placeAgainst` 调用点（`act_pillar:103` / `act_place:159` / `skills:1335` / `tool_prep:317`）**都不传 `timeout`**，那个 `Promise.race` 分支从未被启用 ⇒ 丢掉 hunk 3 的影响仅是"失败多等 4.5 秒"，没有额外断裂点。

### 🔴 token / 口令外泄：今晚三起，这是轮换的第一优先理由
1. 复核席核证 RCON 时，`grep -nE "^rcon"` 把 `rcon.password` 明文打进会话输出
2. 复核席比对 `server.properties` 与备份时，**又**把当前口令明文打进会话输出（选错对照文件用了含旧口令的备份）
3. 侦察席 D5 取证时，`.tmp_probe/d5srv.log`、`d5probe2.log` 里落了**两枚完整 token 明文**（已被它自己删除并复验）

三次都不是漏洞，是**操作卫生问题**——但会话记录本身就是不可撤回的泄漏面。
已立 PLAYBOOK §8.11：**含 secret 的文件禁止直接 diff**，必须先 `grep -v '^<secret_key>'` 过滤或只输出哈希前缀。
**结论：RCON 口令与那把 OpenAI key 都必须在今晚/今早轮换。** 清理代码 ≠ 密钥安全。

## 02:12 宿主机 RCE 已修好，但门禁红 —— 所以我按住了不提交

### `F-EXEC-201`（聊天 → 宿主机 RCE）：结构性修复完成

修法不是"过滤危险字符"，而是**把可被逃逸的那一层删掉**：
- `exec(cmd)`（cmd 由模型输出拼成）→ `spawn(file, argv)`，**argv 全是字面量常量**
- 文本只走**子进程 stdin**（Windows `[Console]::In.ReadToEnd()` / mac `say` 无参 / linux `espeak --stdin`）
- 命令行里**不存在可变文本** ⇒ `& | ; " $() \`` 与换行都没有"shell 这一层"可逃逸
- `speak` 同时移出 `SAFE_RUNTIME_SETTINGS`（持 token 客户端不能再运行期打开它）
- 单测**加了一条断言**（`!SAFE_RUNTIME_SETTINGS.includes('speak')`）防回归——是加严不是放宽

**一条反直觉的实测（复核席推翻自己的专家直觉）**：原以为 Windows 要加 `[Console]::InputEncoding=UTF8` 才不会乱中文，**实测相反——默认就对，加了那行反而把中文弄成乱码**。
⇒ 已要求把这条写死进注释，否则下一个人"顺手加固"就会弄坏中文 TTS。**这类"以为要加固、实测反而有害"的结论，比找到一个漏洞更有价值。**

### 其余已改好、待提交
- `F-WEB-205` 停止面板：`stop-all.mjs` 从 `MINDSERVER_TOKEN` → `./.mindserver-token` 取 token 塞 `auth:{token}`；`stop-panel.ps1` `pushd` 到 `mindcraft`；**退出码 2/3 分开**，两种失败都警告"服务器仍在运行，别关窗口（会丢未刷盘存档）"
- `F-REG-001`：`mindserver_proxy.js` 与 `start.bat` 的提示改为指向 `.mindserver-token`
- 完整性闸四修：**我实测四种行为全对** —— patches 缺失 `exit 1` / 正常 `exit 0` / `--write` 未解锁 `exit 1` / 篡改一字节 `exit 1`
- `F-DEP-003` hunk 3 按复核打回重建（`timeout: 5000→500`），已进补丁且 `patch_integrity` 自洽

### 🔴 为什么还不提交：`gate:full` = exit 1（95/97）
`permissions_unit` **59 passed / 4 failed** —— `!goal` 升成 `OWNER_ONLY` 了，但四条断言还在断言"它是信任级"：
```
信任级能用…!goal ／ !goal 记下发言人 null ／ !goal 执行期间 command_author 就是发言人 ／ 没配 owner：陌生人的 !goal 可用
```
已按复核席给的行号下令修，并要求**新增一条正向断言**（`owner` 配了 `HEAVENZEH` 时 `!goal` 仍可用）——只改旧断言会导致没人守"主人没被误伤"。
**另一个失败 `craft_diagnostic_reachability_unit` 是基线里就有的那条**（96/97 里的"1"），与本次改动无关，已排除。

**决策留痕：带着红的门禁进历史，比不提交更糟。所以在 `permissions_unit` 回绿之前，这批代码一律不提交。**

### `F-AI-202`（!goal）的三处修法被复核席推翻，我采纳
1. **`!endGoal` 绝不能跟着升权** —— 它是**急停**，危险方向是"停不下来"而不是"授权"。若也变 owner-only，**owner 之外的人发现 bot 被套上疯狂目标时无法叫停**，与降险目标正好相反；且 goal 写进 `memory.json` 跨重启恢复，更需要信任级能停。
2. **转义优先于限长** —— 现在是 `"${prompt}"` 未转义 `"`，60 字注入就够，限长根本挡不住。若做限长也**不许静默 `slice`**：会把目标拦腰砍断（"…不要攻击玩家"→"…不要攻击"），语义可能反转 ⇒ 超限应拒绝并回话。实测现网最长 goal ≈170 字，500 有 3 倍余量。
3. **先做 `self_prompter` 的轮次/时长上限**，且 `update()` 的"自动重启"必须受同一上限约束。机制：`MAX_NO_COMMAND=3` 只数"连续没命令"，而模型每轮只要用任意一条命令（哪怕 `!stats`）`no_command_count` 就归零 ⇒ **循环可以无限跑**。叠加 `max_commands:-1` 与按量计费中转站 = 真金白银。

## 待用户决定（promise：攒着一次性说，不半夜弹）

0. **⚠️ 今晚就换 RCON 口令**（最高优先）：复核席核证时把口令明文 grep 进了会话输出（**已主动上报，未写入任何文件**）。虽然只落在会话记录里，但按"已暴露即视为泄漏"处理。这也是 `F-SEC-203` 从"建议"升为"今晚必须换"的原因。
1. **`F-SEC-204` 冒名登录（已升 high）**：离线模式 + 白名单只有 `HEAVENZEH` + `bind: all` ⇒ 把客户端用户名改成 `HEAVENZEH` 就能以主人身份进服，拿到 OWNER 级权限含 `!newAction`（执行代码）。另外 `ops.json` 有 **341 个 lvl4 op bot**（测试刷的）且被 git 跟踪。
   **这是你自己在 `config/network.json` 里权衡过的取舍**（三处书面证据）。三条真修法——①不玩时停服 ②收回本机（牺牲手机联机）③装登录插件（今晚红线不允许）——我们不替你选。**先做零代价的一件**：把 `ops.json` / `whitelist.json` 从 git 移除（`git rm --cached`，不删文件）。
2. **`F-SEC-202` RCON 收 bind 到 `127.0.0.1`**：会连带收窄游戏端口可达性。若手机是走局域网直连，这条要你确认。
3. **`F-DEP-007` zod 3.x → 4.x**：修复需要跨主版本，今晚只做缓解（响应体尺寸上限 + 超时），不升级。
4. **需要你手动轮换的密钥**：`keys.json` 里那把（修代码不等于密钥安全）；RCON 口令的旧 8 位弱口令残留 3 份备份（已清成 `CHANGE_ME`，不删文件）。

---

## 停止方式
- 对 captain 说"停"
- 或创建空文件 `docs/audit/night/STOP`

两个都生效，成员会在下一个检查点收工。
