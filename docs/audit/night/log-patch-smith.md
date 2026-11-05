# log — patch-smith

格式照 PLAYBOOK §5：`## R<轮次> <时间> | 做了什么 | 结论 | 阻塞`

## R0 2026-11-06 01:25 | D0 预热：把历史审计欠账转成队列（t12） | 历史欠账转化：**24 条**（DEP 2 / SEC 5 / EXEC 12 / AI 3 / WEB 2），其中**已过期 51 条** | 无阻塞

**输入**：`docs/audit/00-REPORT.md`（v2.1，34 条硬发现 + E1/E2 + S33~S45）、`01~19` 分册、
`20/21` 两份 R2 复核（拿来交叉核对哪些已修）。

**先做的事（否则会把已修的写成待办）**：拿 `17-review-r1-verdict.md`、`21-review-r2-verdict.md`
的判定表当"候选真相"，然后**逐条在当前代码里复核**。结果：R1+R2 修的 33 条硬发现、E1/E2、
S33~S45、I6/I14 全部**真的在位**（复核方式逐条写在 `queue/HISTORY-EXPIRED.md`）。
有 5 条批量 grep 出现"像没修"的假信号，逐条查清后全部为**已修**（记在这里防下一轮重复挖）：

| 假信号 | 真相 |
|---|---|
| `grep -c 'c?.pos' landmarks.js` → 仍 1 命中 | 命中在**注释**里。实现已改 `normalizePos`（`:83-86`），第 8 条 J3 真修 |
| `grep 'toISOString' src/agent/agent.js` → 0 | 第 12 条的时间戳在 `src/infra/log_prefix.js:66`（幂等包 console），不在 agent.js |
| `grep 'Math.min(32' skills.js` → 0 | 第 13 条的硬夹在 `terrain3d.js:273 SCAN_MAX_RADIUS=32`（唯一入口），不在 skills.js |
| `grep 'sharedMerge' board_store.js` → 0 | 第 16 条的合并实现在**客户端** `board_client.js:437` + `flow_store.js:81`，服务端没有同名函数 |
| `grep '心跳内异常' agent.js` → 0 | 第 32 条把循环**搬**到了 `library/heartbeat_loop.js`，agent.js 只留 12 行调用 |

**产出的 24 条待办**（全部在当前代码复核"仍成立"，每条都带 `文件:行号`、可复现证据、最小修法、验证命令）：

- **D1 DEP 2 条**：`F-DEP-101` `prismarine-schematic` 未使用依赖（R2-7）；
  `F-DEP-102` **依赖 CVE 审计从未落账**（`gate`/`gate:full` 不含任何 audit，`docs/audit` 里 "npm audit" 0 命中）——这是 D1 今晚的判据缺口。
- **D2 SEC 5 条**：`F-SEC-101` RCON 开启 + `server-ip=` 空（绑全网卡）+ 口令明文落盘（口令**已脱敏，未抄录真值**）；
  `F-SEC-102` **19 个适配器 `console.log(err)`** 可能把 `Authorization` 打进日志（P11，历史标"未实测"，本轮给了金丝雀验证法）；
  `F-SEC-103` `get-profile`/`get-profiles` 交全文与绝对路径（I19/R2-6）；
  `F-SEC-104` 贴图代理 `itemName` 无字符集校验（I17/R2-4）；
  `F-SEC-105` 提示词两个开关、`LOG_PROMPTS` 绕开 spec/白名单（R2-8）。
- **D3 EXEC 12 条**：`F-EXEC-101` **`src/agent/tasks/**` 约 38 处裸 `bot.chat('/…')`**（含 `/kill @e`、`/fill` 100×100 清空），
  而 preflight 用"不是运行时链路"的豁免把整目录放过 —— 但 `tasks.js` 就是 `!do` 的运行时引擎（第 29 条同族，skills.js 侧已修、这一侧没跟）；
  `F-EXEC-102` 退出不回收 agent 子进程（R2-1/I7，后果落在任务板：孤儿继续领单+续租）；
  `F-EXEC-103` `takeFromChest`/`putInChest` 意图即成功；`F-EXEC-104` `equip` 不校验结果/中断；
  `F-EXEC-105` executor 高度不足仍 `return r`（08 F2）；`F-EXEC-106` `/air/i` 吞真实挖失败（08 F3，**3 处**，08 只记了 2 处）；
  `F-EXEC-107` `loop_lag` 最大值不衰减（R2-3/I15）；`F-EXEC-108` 垫脚清单第五份实现（R2-9）；
  `F-EXEC-109` `checkLevelBlueprint` 解引用崩溃（E3，`!checkBlueprintLevel` 可直达）；
  `F-EXEC-110` `embellishments` 传 `newZ` 当 x（E4）；`F-EXEC-111` `runCraft` 不传 ctx（E6）；
  `F-EXEC-112` `settings_spec.type/options` 从不校验（R2-2/I8）。
- **D4 AI 3 条**：`F-AI-101` 5 个适配器 catch 内 `err.message.includes` 二次抛（P3，00-REPORT 零落点）；
  `F-AI-102` `FAILED_REPLY` 仍是字符串契约（R2 记的"次生风险"，防下一次漏调）；`F-AI-103` 模型可见技能目录仍含 3 处未对齐旧实现。
- **D5 WEB 2 条**：`F-WEB-101` `bot-output`/`agent-event` 不校验发送方（I18/R2-5）；
  `F-WEB-102` `web/tsconfig` `strict:false` 且 web typecheck **不在 `gate:full`**（T11）。

**两条口径修正（比历史文档更准，请复核采纳）**：
1. **I17 的"已部分缓解"对 HTTP 端不成立**（`F-SEC-104`）：`mindserver.js:85-92` 的 `app.use` 只做
   `?token=` → `Set-Cookie`，然后**无条件 `next()`**，从不拒绝请求；握手门 `:103 io.use(...)` 只管 socket.io。
   ⇒ 贴图代理、`/console`、`express.static` 三个 HTTP 出口**仍然零鉴权**。
2. **I15 的"永久误报"要看窗口**（`F-EXEC-107`）：`describeLoopLag()` 输出的"最大值"没有窗口概念，
   一次抖动后会永久说"主线程确实被占用"，直接污染 `run-live.log:39` 那句被 00-REPORT 当作反证引用的话。

**未转化、留给下一轮侦察的（诚实边界，别当已清）**：08 的 F4/F6、13 的 P4（流式半截，未实跑）、
04 的 T12/T13/T14、06 的文档漂移与瘦身、以及 00-REPORT §4.3 说的"≈68 条分册发现不可追溯"里
本轮没复核到的部分。已写进 `queue/HISTORY-EXPIRED.md` §六。

**并发处置（今晚三人同时在写 inbox）**：`recon-scout` 已在用 `F-DEP-001…008` 段。`mv` 只保证认领互斥，
**写入不互斥**（`cat >` 会覆盖同名文件），所以本任务的单**一律用 1xx 段**（`F-SEC-101`、`F-EXEC-101`…），
与侦察兵的 0xx 段天然不重叠。约定写在 `queue/HISTORY-EXPIRED.md` §五。

**红线自查**：未改 `mindcraft/` 任何文件（`git status` 我只在 `docs/audit/night/` 下写）；
未抄录任何真实密钥值（`F-SEC-101` 里 RCON 口令写"已脱敏"）；未创建/修改任何 `claimed|done|verified|rejected` 里的文件；
未碰 `backups/ logs/ tmp/ server-test/`。

**我打算下一轮自己认领的顺序**（供 captain 排程；不影响任何人从 inbox 领单）：
1. `F-SEC-102`（19 处 `console.log(err)` → 一处 `logErrOnce`，改动小、泄密面直接关）
2. `F-EXEC-110`（E4 两个标识符，但要先读 `addWindows*` 签名）
3. `F-AI-101`（5 处 `err.message.includes`）
4. `F-EXEC-106`（3 处 `/air/i` → 结构化判据）
5. `F-SEC-105` / `F-EXEC-112`（配置契约两条，可一起跑 `settings_check` 验证）

**风险提示给 captain**：`F-EXEC-101` 是**唯一一条会立刻把门禁打红**的（加了判据后 preflight 会报 10+ 条
`tasks.js` 违规）。这是"门禁恢复视力"，不是回归 —— 但它会让 pre-commit 拦住所有提交，
所以必须排在一个专门的窗口里做（先改 `tasks.js` 的 10 处再收紧判据，或反之，二选一，别半截）。

## R1 2026-11-06 01:47 | D1 依赖部修补（t6）| 落地 4 条（+1 新发现），blocked 4 条，accepted-risk 4 条，提交数 0（归 captain） | 阻塞：本会话不能 git 提交/删文件/spawn

**入口条件核实（先做的三件事，都跟"能不能落盘"有关）**
- `bash`/`node`/`git` 对 `mindcraft/` 仍然只读（`echo x > mindcraft/.p` → Permission denied；`node fs.writeFileSync` → EPERM；
  `git add` → `Unable to create .git/index.lock: Permission denied`），**但 DSH 的 write/edit 文件工具可以写**。
  ⇒ 全程用 write/edit 改内容，git 与删除一律交 captain（已与其确认为 A 方案）。
- `node spawnSync(process.execPath,...)` → **status=null EPERM** ⇒ `gate:full` / `unit_all` / `lint_hard` 在我这里恒红（环境红）。
  captain 那边 exit 0（96/97），所以 **gate 由 captain 跑，我不以"跑不了"降级判据**。
- 用 `npm view ... --cache E:/我的世界ai/.tmp_probe/npmcache` 打通了 registry 元数据（recon 当时 `npm view` 被 EPERM 挡住）。

**落地（4 条，全部门禁中性，详见 `manifest-D1.md`）**
1. `F-DEP-003`：新建 `patches/mineflayer+4.39.0.patch`（只重建 hunk 1：`incorrect_for_wooden_tool → mineable/pickaxe`）。
   关键发现：**patch-package 对"文件名版本≠实装版本"只警告不失败**（`createVersionMismatchWarning`），
   真正的失败是**上下文对不上**。所以修法是"让内容对上 4.39.0"，而不是改文件名。
   hunk 2/3 不重建：上游 4.39.0 已用 `_getBlockAtEyeLevel()` / `toNotchianYaw()` 覆盖。
   验证：`patch -p1` 套到 **pristine 4.39.0 副本** → 结果与我构造的目标文件 `diff -q` **IDENTICAL**。
   **旧补丁删除归 captain**（我删不掉）⇒ 状态 `fix-ready-awaiting-commit`。
2. `F-DEP-004`：新增 `tools/patch_integrity.mjs`（零依赖）+ `patches/SHA256SUMS`。
   **故意不接进 gate**：旧补丁未删时会立刻报 2 条 FAIL，`.githooks/pre-commit` 会把全队提交拦死。
   五组对抗性实测：干净=绿；篡改一字节/漏登记/删文件/版本漂移=红（逐条记录在 manifest §2）。
   已主动声明局限：**"补丁与 SHA256SUMS 一起改"挡不住**（仓库内哈希基线的固有上限），建议 gate-keeper 就测这条。
3. `F-DEP-005`：`reinstall` → `npm ci` **且** `clean:modules` 不再删 `package-lock.json`（两条一起改才成立）。
4. `F-DEP-006`：`gl@8.1.6` 补 `resolved`+`integrity`。**integrity 是实测的**：下载 tarball（5,913,101 B）算 sha512 → 与 registry 一致 MATCH=true。
   全树缺 integrity 条目 **1 → 0**。
5. `F-DEP-012`：`start.bat` 的 `npm install` → `npm ci` + 失败 `exit /b 1` 不继续启动 + 补丁完整性前置闸；括号 6/6 配平。

**新发现（我的，已立单）**：`F-DEP-103` —— **`mindcraft/package-lock.json` 被 `.gitignore:4` 排除**（而 `web/` 的被追踪）。
后果：生产依赖树无 git 历史；**`F-DEP-005/006/010` 三条修的都是 lock，未入库就没落脚点**（我改完 `git status` 里根本不出现）。
这条是我在落地 F-DEP-006 时"改完发现 git 看不到"反查出来的，历史 06 分册/00-REPORT 都没提。

**两条把 recon 的"未核实"补成硬事实**
- `F-DEP-008`：`npm view tar versions` → **6.x 最大就是 6.2.1**，无 6.2.2+ ⇒ overrides `^6.2.2` 会指向不存在的版本，**不能写**。
- `F-DEP-007`：`npm view zod versions` → 3.x 末尾只有 3.25.76 + 3.26.0-canary ⇒ **3.x 无稳定回补版**，确实只能跨主版本。

**未落地**：`F-DEP-007/009/011` accepted-risk（已 mv done/）、`F-DEP-008/010/101/102/103` blocked/partial（已 mv done/）。
`inbox/` 的 DEP 条目已清空；`claimed/` 留 5 条 `fix-ready-awaiting-commit` 等 captain 提交后进 done/。

**D1 报表**：提交数 **0**（全部交 captain 代提交）/ blocked **5**（003 差删除、008、010、101、103）/ accepted-risk **4**（007、009、011、011 同族）/ 落地 4（004、005、006、012）+ 003 的补丁文件。

## R2 2026-11-06 02:05 | D2 密钥部修补（t7）| 落地 5 条 / blocked 5 条 / deferred 3 条 / superseded 1 条 | 阻塞：server.properties 与 backups/ 对我会话只读（server.properties 另被 gitignore）

**铁律自查**：**没有修改任何真实密钥/口令**（`rcon.password`、`keys.json`、API key 全未动）。

**落地 5 条（等 captain 提交，详见 manifest-D2.md）**
1. `F-SEC-206` 两仓 .gitignore 通用凭据兜底（含 `!.env.example`）。实测两仓 16/16 命中、例外可用、**已跟踪文件命中 0**。
2. `F-SEC-208` 删掉 `tools/server-net.mjs` 头部"白名单=安全边界"的错误论断（**纯注释**：非注释改动 0 行；`server-net.mjs show` 输出逐字不变）+ `config/network.json:5` 文案更正。
3. `F-SEC-205` 握手 token 不再无条件打印：默认只打指纹，完整值落 `.mindserver-token`（0600，已 gitignore），
   `MINDSERVER_PRINT_TOKEN=1` 才打完整值；`start-panel.ps1` 改为读该文件拼 `?token=` —— **顺带修了"面板打开时不带 token 所以连不上"的既有缺口**。
4. `F-SEC-209` `server.properties:7` `broadcast-rcon-to-ops` true→false（**手改，未跑 apply**，避免 CRLF 归一；改动 +1 字节，行尾符未变，其余键逐条核对未动）。
5. `F-SEC-104` 贴图代理加白名单断言（`^[a-z0-9_]{1,64}$`，非法 400）：5 非法全拒 / 4 合法全放行。

**blocked 5 条**：201（需用户 setx+轮换，手册已写，含"清理≠安全"的轮换提醒）、202（需管理员防火墙，引用 gate-keeper 手册）、
203（backups/ 只读 + 彻底清理是破坏性）、204（需用户三选一；我已加 `_剩余风险` 字段）、207（server/ 只读 + 需选 A/B）。

**deferred 3 条（诚实顺延，不是已修）**：102（19 适配器 `console.log(err)`，修法已备好在单子里）、
103（get-profile 脱敏会改面板契约，需 web build 回归，本会话跑不了）、105（settings_spec 契约变更）。
**superseded 1 条**：101 = 202 同一件事，以 202 为准。

**两条必须进早报的事实**
- **`server/server.properties` 被 `.gitignore:74` 排除** ⇒ `F-SEC-209` 的修复**进不了 git**，无历史、不可回滚，
  重建服务器会回退成 `true`。与 D1 的 `F-DEP-103`（lock 被忽略）同一类。建议把安全取值同步进**可入库的** `server.properties.example`。
- `start-panel.ps1` 原本打开的是**无 token 的 /console** ⇒ 面板 socket 握手应当一直被拒（`AUTH_REQUIRED`），
  即"面板连不上"这个既有现象可能一直存在，只是被"用户手动复制日志里的 token 地址"绕过了。本轮一并修好。

**我犯过并已纠正的一个错（如实记录）**：改 `config/network.json` 时把英文双引号写进 JSON 字符串 → 文件非法，
`JSON.parse` 立刻报错；改用全角引号后复验 `JSON_OK`。教训：改 JSON 文案只用全角引号或转义。

## R3 2026-11-06 02:15 | D3 执行体修补（t8）+ 完整性闸四修 + F-WEB-205/REG 返工 | 落地 6 / 部分 2 / blocked 3 | 阻塞：node 不能 spawn（gate 与真机验证归 captain）

**本会话能力边界（不变）**：bash/node/git 对 `mindcraft/`、`server/`、`backups/` 只读（仅 write/edit 文件工具可写）；
node 不能 spawn ⇒ `gate:full`/`unit_all`/`lint_hard` 跑不了，一切"通过"我用可跑的等价判据给出并留证。

**① F-DEP-004 完整性闸四修（依 review-patch-integrity.md）**
- D1 载荷先落盘：`start.bat` 把内容完整性（`--no-version-check`）移到 **`npm ci` 之前**，并**移出 `if not exist node_modules`** ⇒ 每次启动都验；装完再验一次完整版。
- D2 `--write` 洗白：必须同时 `PATCH_INTEGRITY_ALLOW_WRITE=1`，否则 exit 1 拒绝。实测：无 env → exit 1。
- D3 删 patches 静默放行：`patches/` 缺失由 exit 0 改为 **exit 1**（除非 `--allow-no-patches`）。实测：exit 1 / 带开关 exit 0。
- D4 接线未做（按 captain 指示留他接）。
- 现状：`node tools/patch_integrity.mjs` → **exit 0**（5 补丁一致 + 5 版本对应）。

**② F-DEP-003 hunk 3 重建（采纳复核席打回，选方案 a）**
- 我原写"上游已用 `_getBlockAtEyeLevel` 覆盖 hunk3"**是错的**（该函数只在 digging.js，与 place_block 无关；`timeout: 5000` 仍在）。
- 按 4.39.0 新结构重建：`place_block.js` `timeout: 5000` → `500`（1 行）。`patch -p1` 套到 pristine 双文件副本，两文件都与目标副本 `diff -q` **IDENTICAL**。
- `SHA256SUMS` 同步（`c2372a4c…`），**与 patch 同 commit**（按 captain 新纪律）。
- ⚠️ **补丁尚未生效**：node_modules 里 `incorrect_for_wooden_tool` = 0 ⇒ 需 captain 跑一次 `npm ci`。

**③ F-WEB-205（紧急）+ F-REG-001 返工**
- `stop-all.mjs`：token 从 env→`./.mindserver-token`，塞 `auth:{token}`；`AUTH_REQUIRED` 单独判为 exit 3 并明说"服务器仍在运行，别强关"（原来一律说"mindserver 可能没开"，把人往强关引 ⇒ 存档未刷盘风险）。
- `stop-panel.ps1`：`Push-Location mindcraft`（token 在 mindserver 的 cwd）+ exit 2/3 中文提示。
- `F-REG-001`：`mindserver_proxy.js` 的 AUTH_REQUIRED 提示不再说"启动日志里的 token"；`start.bat` 打印 token 文件路径；`auth_gate.js:26` 注释同步。
- **BOM 坑**：编辑工具吃掉 `stop-panel.ps1` 的 BOM，我用 node 补回并复验 `ef bb bf`（captain 提醒的正是这条）。

**④ F-EXEC-201（high）speak.js 命令注入 —— 结构性修复**
- `exec(cmd)` → `spawn(file, argv)` + **文本走 stdin**（win `[Console]::In.ReadToEnd()` / mac `say` 无参 / linux `espeak --stdin`）；模板串拼与 `replace` 转义全删。
- **为什么原注入串失效（不是过滤字符）**：文本只进子进程 stdin，argv 全是字面量常量 ⇒ **命令行里不存在可变文本**，`& | ; " $() \`` 与换行都没有"shel​l 这一层"可逃逸。
- `speak` 移出 `SAFE_RUNTIME_SETTINGS`（持 token 客户端不能再运行期打开）；单测补一条断言。
- 行为变更：只能在 `settings.js` 开 speak 后重启。**未真机验证发声**（无 spawn）—— 已在 manifest 标注为第一嫌疑点与回滚方式。

**⑤ F-EXEC-202（medium）38 处裸斜杠 —— 总闸已上，逐条改造 blocked**
- `tasks.js initBotTask()` 开头加 fail-closed 闸：`ALLOW_TASK_CHEATS !== '1'` 就打印"会执行 /clear + 8 条 /fill(100×100×10) + /kill @e[...,distance=..200]"并 return。
- 这是 38 处的**唯一入口**（`/clear` 在下一行，`CookingTaskInitiator.init()` 也由此 new）⇒ 一处闸覆盖全部。
- 逐条改 `command()` 需在 permissions 白名单登记 6 条命令并验证 NBT/`~` 语义；本会话无法真机跑场景 ⇒ **不赌**，另立 `F-EXEC-204`。

**⑥ F-AI-202（high）`!goal` 持久注入 —— ①② 已做，③ blocked**
- ① `!goal` 从 TRUSTED → OWNER_ONLY（permissions.js）。行为变更：没配 owner 时玩家不能再自己设目标。
- ② `$SELF_PROMPT` 折叠换行 + 转义 `\` `"` + 限长 500（prompter.js）。自检脚本可复跑：5 项断言全 true。
- ③ 循环上限 blocked：动行为语义，无法观察 2 秒节拍真机行为。

**⑦ 两条新单**
- `F-DEP-013`（安装期脚本执行面仍在，`npm ci` 照样跑 lifecycle scripts）—— 依 captain 转述复核席裁定立单；`F-DEP-012` 定性已改为"部分解决"。
- `F-DEP-003/005/012` 的边界描述已补进 `manifest-D1.md`（lock 未入库 ⇒ 新机器 `npm ci` 必失败，别读成"换机也能用"）。

**④ 队列纪律**：本轮全程只 `mv`，未覆盖/未删除任何 finding 文件。附一条事实更正：D1 那 5 条**未曾被清空**，
它们当时在 `claimed/`（4.1~4.8KB 完整）；SEC 那批后来由复核席移入 `verified/`，也在。所以"inbox/done 里没有"≠"文件被销毁"。

## R5 2026-11-06 02:26 | D5 面板部修补（t10）+ F-RT-002 | 落地 6 条（其中 202 为部分解决）/ 提交 0（归 captain）| 阻塞：node 不能 spawn ⇒ 真机冒烟归 captain

**落地（全部在 `mindcraft/src/mindcraft/mindserver.js`，另 start.bat 一行）**
- `F-WEB-201`（high）：HTTP token 门 + 安全头 + `disable('x-powered-by')`。判定真值表 **6/6**（无 token 一律 401；对 query/cookie 放行）。不打死面板的推理写进 manifest §1（首屏 `?token=` → 种 cookie；`/socket.io/` 由 engine.io 接管不经 express）。
- `F-WEB-204`（low）：`path: full` ×3 → `basename`（绝对路径不再回给客户端）。
- `F-WEB-203`（medium）：`send-message` 加 **message ≤2000** + **30 条/10 秒令牌桶**（无依赖）。
- `F-WEB-202`（medium）：**部分解决** —— 外部触发面已被 201 关掉；另加**在飞并发上限 4**（res finish/close 回收）。结果缓存未做（性能项，非安全判据）。
- `F-WEB-101`（我 t12 的历史单）：`bot-output`/`agent-event` 加**发送方身份判据**（只有 `auth.token`==handshakeToken 的 agent 连接能转发）⇒ 面板客户端不能再伪造 bot 台词/诊断事件。判据成立依据：agent 走 auth payload，面板走 Httponly cookie。
- `F-RT-002`（红队，captain 列最高优先）：**我们自己埋的雷** —— t8 为修 F-REG-001 在 start.bat 推荐 `MINDSERVER_PRINT_TOKEN=1`，而 stdout 被重定向进 logs ⇒ 照做即让 F-SEC-205 复活。修：node 侧**stdout 是文件就忽略该开关**（`fstatSync(1).isFile()` + isTTY 判断）并 warn 指回 `.mindserver-token`；start.bat 侧删掉建议、改成反向提示。

**自检**：`node --check` OK；`mindserver_gate_unit` 49/0；`permissions_unit` 66/0；start.bat 括号 23/23（与 HEAD 一致）；真值表脚本 `tmp/test-web201.mjs` 6/6。
**未做（记账）**：202 缓存、203 的 listen-to-agents 上限、204 的 get-settings 白名单、全部真机冒烟。

**队列**：F-WEB-201/202/203/204 已 `mv` 到 claimed/（**只 mv**）；F-WEB-205 在 t8 已交。

**待办（按 captain ⑥ 顺序，下一步做）**：F-EXEC-202 重做（guardedChat 或如实口径标部分解决）→ F-AI-201 接上线+补单测（**死代码变活代码**）→ F-AI-203 → F-AI-204 标 blocked（需用户拍板）。
**教训已记**：今晚第三次"写了但没接到真实执行路径"（前两次：F-SEC-205 消费方、patch_integrity 没接 gate）。以后**每新增一个安全函数，必须同时给出它的调用点与单测**，否则等于没修。

## R6 2026-11-06 02:36 | D4 返工（依复核席 3 条打回）+ F-EXEC-202 重做 | 落地 3 / blocked 1 / 部分解决 1 | 阻塞：gate:full 需 captain

**核心转变：把"写好的安全函数"接进真实执行路径**（复核席打回要点，也是今晚第三次同类问题）

- **F-AI-201**：`$CONVO`/`$TO_SUMMARIZE` 传 `{fenced:true}`；`$MEMORY` 用 `fenceUntrusted`；`examples.js` 按复核席要求**不动**。
  **执行侧判据**：`permissions.js` 没配 owner 由 `TRUSTED` 改为 **`OTHER`（默认拒绝）** —— 理由写进注释：
  提示层围栏可被绕过，必须有执行侧闸；且 fail-closed 后"没人能设目标"⇒ 不存在"需要别人叫停的失控目标"，故不需保留急停。
- **F-AI-203**：`history.js summarizeMemories()` 落盘前调 `sanitizeExternalText`（去控制字符/折叠空行/限长，不删正文）。
- **F-AI-201/203 的死代码问题用单测钉住**：新增 `tools/text_fence_unit.mjs`（22/0），其中 **5 条是"接线断言"**
  （直接读源码 grep `$CONVO`/`$TO_SUMMARIZE`/`$MEMORY`/`history.js`/`examples.js`）⇒ 以后把接线改回去会立刻红。
  **这是今晚第一次做到"新增安全函数 = 调用点 + 单测"同时交付。**
- **F-EXEC-202 重做（如实口径）**：只跳三段 cheat（`/clear bot`、cooking 场景、`/clear 玩家`），
  **保留 `teleportBots()`（526 行仍执行）/agent_count/killAll/startConversation**；日志逐条列"✗跳过/✓照常"，
  并明写「结果是**场景没搭起来**（部分解决）」。闸在调用方不在 sink 的边界已立新单 **F-EXEC-204**。

**单测**：`text_fence_unit` 22/0、`permissions_unit` **68/0**（新增 2 条：默认拒绝真的生效、配上 owner 后 `!endGoal` 仍可用）、
`mindserver_gate_unit` 49/0。
**行为变更（需用户知晓）**：没配 `permissions.owner` 的 profile（deepseek / defaults/*）⇒ **所有聊天命令不响应**（fail-closed）。
**F-AI-204**：标 blocked（会隐藏 56 条命令，需用户拍板），只把事实与两条修法写进单子。

**承认的教训（第三条同类）**：F-SEC-205 消费方 → patch_integrity 没接 gate → fenceUntrusted 死代码。
规则已落地：**新增安全函数必须同时交出"调用点 + 单测（含接线断言）"**。R6 是第一次真正做到。

## R7 2026-11-06 02:52 | 任务 A（F-WEB-202/203 精修）+ 任务 B（F-RT-001/003/005）| 落地 4 / blocked 1 | 阻塞：真机压测与 icacls 归 captain/用户

**A-202（按复核席裁决重做）**：采纳"缓存 import() 解决的是不存在的问题"。真正做：把 handler 拆成
`fetchTextureBuffer`（干活，不碰 res）+ `getTexture`（调度）——**同 key 合并**（Map<key,Promise>）+
**并发上限 4** + **8 秒硬超时**（504，不缓存）+ **finally 清理**（`TEX_INFLIGHT.delete`，漏了就是永久 503+泄漏）
+ 结果缓存 300 条 + `Cache-Control: max-age=86400`。

**A-203（扩面 + 抽共用实现）**：新增模块级 `takeToken(socket,label,cap,window)`，按**远端地址+事件label**分桶
（挂 socket.data 断开即清零可绕过）；四个事件统一走它：send-message 30/10s、**restart-agent 3/60s**、
**create-agent 5/60s**、listen-to-agents 10/60s。原来 send-message 的内联块已删除（消除重复——今晚多次因重复逻辑出事）。
**明确不解决**：`max_commands=-1` 的单次放大（captain 已定另行处理）。

**B-003**：① 种完 cookie 后 GET **302 去掉 ?token=**（不进历史/书签同步）；② 退出/SIGINT/SIGTERM 时 **unlink token 文件**。

**B-005**：`tool_prep.js` 把 `if (!placed.ok) throw` **挪到读回之后** —— 因为 patches 把 place_block 等待压到 500ms，
`placeAgainst` 可能 ok=false 但方块已放上；先 throw 会误判"没有工作台"白扔台子。

**B-001**：**blocked**，手册 `manual-F-RT-001-token-acl.md` 已写（icacls 三步 + 两个可持续方案 A/B）。
关键坑：token 每次启动重建 ⇒ ACL 退回继承值 ⇒ 必须收紧父目录或每次重设，否则"改完就回退"。

**自检**：`node --check`（mindserver/tool_prep）OK；`mindserver_gate_unit` 49/0；`text_fence_unit` 22/0；`permissions_unit` 68/0。
**未做**：202 的并发压测与 8s 超时真机实测、icacls 执行、F-RT-004（未指派）。
