# t5：全量验证 + 真机 E2E + 七条缺陷逐条反向验证

> 轮次：R6 fixes5（2026-11-13） · 验证者：gate-runner（t5）
> 对象：P1-1 / P1-2 / P1-3 / P2-4 / P2-5 / P2-6 / P2-7 七条缺陷的修复（t1 / t2 / t3 / t4 / t7）
> 环境：Windows 10 + MSYS bash · Node v24.16.0 / npm 11.13.0 · JDK 21.0.12.1（`.tools/`）· PowerShell 5.1
> 口径：**只读验证**。除门禁脚本（`scripts/tests/ops-regression.mjs`，本次按任务书第 7 条追加 5 条断言）外，
> 未改任何产品代码；所有变异都按 **sha256 逐字节复原**并复验。

---

## 0. 结论速览

**全绿。** 七条缺陷的修复在"离线门禁 + 真机 E2E + 真 socket + 逐条反向（改回缺陷态必须红）"四条线上都成立；
另有 **1 个与本批无关的既有 P1（自动备份 100% 失败）** 被真机验证暴露，见 §10 —— 它不改变本批的结论，
但不修的话"停服即丢一次备份"。

| # | 项目 | 期望 | 实测 | 结论 |
|---|---|---|---|---|
| 1 | `mindcraft: npm test` | 基线 158 脚本 + 5 跳过 | **159/159 脚本通过，5 跳过**（基线 +1 = 新增 `sec_review_unit`） | ✅ |
| 2 | `mindcraft: npm run gate` | exit 0 | **exit 0**（含 lint:hard `no-undef=0`、deps 注入 A 档 0 处） | ✅ |
| 3 | `node tools/preflight.mjs` | exit 0 | **exit 0** | ✅ |
| 4 | `node tools/deps_injection_audit.mjs` | A 档 0 处 | **A 档 0 处**（C 档 2 处"要人判断"，非本批） | ✅ |
| 5 | `web: vue-tsc --noEmit` | 0 error | **0 error** | ✅ |
| 6 | `web: npm run build` → `release.ps1 -SkipDocker` | 通过 | **6/0 + 8/0 全 PASS**（source `ce56f338…` / artifact `5f6413eb…`，与 t4/t7 记录一致 ⇒ 构建可复现） | ✅ |
| 7 | `release.ps1 -VerifyOnly` | 8/8 | **8/8** | ✅ |
| 8 | 父仓 `ops-regression` | 117（现 **122**） | **122 passed / 0 failed**（117 + 本次新增 5 条） | ✅ |
| 9 | 全部 `.ps1` Parser | ERRORS=0 | **27 个文件（26 跟踪 + 1 新增）ERRORS=0** | ✅ |
| 10 | `scripts/**` BOM | 全带 BOM | **21/21 带 BOM** | ✅ |
| 11 | `node scripts/compose-gate.mjs` | exit 0 | **exit 0**；对"重现重复键"的夹具 **exit 1 且理由是重复键** | ✅ |
| 12 | `scripts/e2e.ps1 -Scenario all` | 53/53 | **53/53**（claims 10 + restart 13 + chest 30，逐条来自日志 `^  \[<场景>\] PASS` 计数） | ✅ |
| 13 | 真冷启动 `start-panel.ps1`（非 DryRun） | 不被误判"进程已退出" | **exit 0**，日志 `服务器已完全加载（8s）` | ✅ |
| 14 | 七条逐条反向验证 | 改回缺陷态必红、复原必绿 | **7/7 成立**（4 条行为变异 + 3 条夹具/内建变异） | ✅ |
| 15 | 真 socket（agent vs 面板凭据） | 凭据类型决定结果 | **9/9** | ✅ |
| 16 | 新增 4 条常驻断言 | 装得上且能红 | **122 全绿；3 种变异各自精确变红** | ✅ |

---

## 1. 全量离线门禁（mindcraft）

```
cd mindcraft
npm test
  → 159/159 个脚本通过，5 个跳过        （跳过项：4 个需真机数据 + chest_withdraw_race_unit 需测试服）
  → 新增 sec_review_unit 47 个用例；bot002_action_start_unit 39 个用例
npm run gate                             → exit 0
node tools/preflight.mjs                 → exit 0（"启动自检通过（含函数体冒烟测试）"）
node tools/deps_injection_audit.mjs      → exit 0（A 档 0 处）
```

门禁输出里的关键行（原文）：

```
✓ [control-state-owner] 0 处  ✓ [mouse-input-owner] 0 处  ✓ [slash-command-owner] 0 处
✓ [chat-via-openchat] 0 处     ✓ [rcon-password-literal] 0 处
✓ 依赖注入审计：A 档 0 处（没有"单测能测到、生产走不到"的死分支）
✓ [lint:hard] no-undef = 0 · no-floating-promise = 0（扫 187 个文件）
```

> t1 报告里"抽到模块级后默认 `findAgent` 仍指向闭包 `knownAgent` ⇒ 生产 ReferenceError"那条，
> 本次由 `lint:hard` + `sec_review_unit` 的 **A7 / C7（不注入的默认路径）** 双重复核通过。

---

## 2. 前端产物链（web → mindcraft/web-dist）

```
cd web && npx vue-tsc --noEmit            → 0 error
cd .. && powershell -File scripts/release.ps1 -SkipDocker
  [2/8] 构建前端      PASS  web/dist 构建完成（17 个产物）
  [3/8] 同步产物      PASS  已同步 17 个文件
  [4/8] 产物校验      ALL PASS: 6 passed, 0 failed
        源码指纹 sha256:ce56f338…（39 个输入文件）
        产物指纹 sha256:5f6413eb…（17 个产物文件）
powershell -File scripts/release.ps1 -VerifyOnly
  → ALL PASS: 8 passed, 0 failed（产物 ↔ 清单 ↔ 源码三方一致）
```

> 指纹与 t4 / t7 报告里的完全一致 ⇒ 这一步是**可复现**的，不是"重建后凑巧通过"。
> `release.ps1 [1/8]` 现在也接了 `compose-gate`（t3），本次一并跑过。

---

## 3. 父仓运维链

```
node scripts/tests/ops-regression.mjs     → ALL PASS: 122 passed, 0 failed
node scripts/compose-gate.mjs             → PASS（environment 单一 + 四个变量齐全）exit 0
```

### 3.1 `.ps1` Parser + BOM

```
跟踪 + 新增共 27 个 .ps1：
  TRACKED_PS1=26  PARSER_ERRORS=0
  UNTRACKED scripts/lib/server_proc.ps1  errs=0  bom=True
scripts/**（21 个）：PARSER_ERRORS=0  NO_BOM=0
```

**NO_BOM=4 全部是 docs 下的历史脚本**，与本次无关、也未改动（git status 里没有它们的记录）：

```
docs/audit/night/parse-ps1.ps1
docs/真机-20261106/T0/check-health.ps1
docs/真机-20261106/T0/start-mindserver.ps1
docs/真机-20261106/T2/start-env-r3.ps1
```

> 任务书写"22 个 .ps1（scripts/** 21 + 文档 1）"，实测**全仓**是 27 个（26 跟踪 + `server_proc.ps1`）。
> 多出来的全是 docs 的历史快照，Parser 也是 0 错误；BOM 只对 `scripts/**` 是硬要求（21/21 满足）。

### 3.2 P1-3 复跑（门禁红/绿两态）

```
真文件：  PASS  compose 可解析，environment 单一且变量完整（SETTINGS_JSON, MIND_SERVER_HOST, MINDSERVER_TOKEN, MC_WORLD_DIR）  → 0
合并后：  environment: 只出现 1 次（第 5 行）
夹具"拆回重复键"：
  FAIL  · 重复键：environment（第 5 行与第 7 行同级重复）
        · services.mindcraft 的 environment 出现了 2 次（必须是 1 次）        → exit 1
```

---

## 4. 真机 E2E（`scripts/e2e.ps1 -Scenario all`）

**53/53 全部通过，exit 0。** 三个场景各自独立运行目录（`tmp/e2e/<scenario>/`），互不影响。

| 场景 | 断言 | 关键点 |
|---|---|---|
| claims | 10 | 起服前世界=模板、起服就绪、脚本 13 条断言全过（预约/抢同一 key/没落行/反向对照/entity 预约泄漏）、优雅停服、世界重置 |
| restart | 13 | 两段起服、场地与记忆就绪、箱子内容跨重启完好、熔炉产物与进度自洽（煤 8→7、产物 iron_ingot\|1）、bot 记忆（`E2E-MEMORY-KEEP-20261113222447`）与地点库存活 |
| chest | 30 | 存 16 / 取 8 的守恒 + 三条反证（不存在物品、满箱、距离过远都**不许假成功**）+ 跨重启守恒（bot 读 + RCON 独立读） |

P1-2 动的正是"动作排队"，chest / restart 全靠它 ⇒ 这两个场景 53/53 是 P1-2 **真机**层面的有力旁证。

### 4.1 跑完的残留核查（任务书第 4 条）

```
生产 server/world/world-id.json ： id 与 mtime 均未变（w-20261113-96c12b98 / 2026-11-13 14:27:33）⇒ 没有新 id
java / javaw 进程                ： 0
监听端口 25565/25566/25575/25576/8080/18090 ： 0
tmp/e2e/                         ： 已清空（默认删运行目录）
```

---

## 5. 真冷启动（t3 只能做到一半的那件事）

t3 用"抽函数 + stub"证了 `Get-ServerJava` 的**协议**，但没真起过服。本次真起：

```
powershell -File scripts/start-panel.ps1        （非 -DryRun，stdin 接 /dev/null）
  [1/4] 正在启动（冷启动约 15~40 秒）
        .....  Minecraft 端口已就绪（10s）
        ....   服务器已完全加载（8s）        ← ★ 关键
  [2/4] .    mindserver 端口已就绪（2s）
  [3/4] ........  bot entered the game (16s)
  [4/4] 打开面板（Start-Process 真开了浏览器）
  已启动完成
  COLDSTART_EXIT=0
```

**为什么这一行是关键**：`Wait-ServerReady` 每 2 秒的第一句就是
`if ($null -eq (Get-ServerJava)) { '服务器进程已经退出了' ; return $false }`。
判据一旦退化成"空数组 / `$false`"，这里会**立刻**报"进程已经退出了"并 exit 1 ——
而实测走的是 `服务器已完全加载（8s）` 这条分支，说明**委托后的判据在真冷启动上是对的**
（不是"靠 stub 蒙对"）。

随后：

```
powershell -File scripts/stop-panel.ps1
  1) 优雅停止 Minecraft 服务器（RCON stop）... 已确认 Minecraft 退出（25565 端口已关闭）
  2) 停止 agent 并关闭 mindserver...
  完成。
```

**副作用（如实登记）**：真冷启动会真起服，因此生产 `server/world` 的 `level.dat`
（22:50 关服保存）与 `session.lock`（22:44 起服创建）被正常改动 —— 这是"真起一次服"的必然结果，
不是缺陷；`world-id.json` 没变（同 id）。

---

## 6. 七条缺陷逐条反向验证

**方法**：每条都"改回缺陷态 → 跑该条的行为断言 → 必须红在指定用例上 → 按 sha256 逐字节复原 → 必须绿"。
驱动器 `tmp/verify7/reverse.mjs`（一次性脚本，不入库；做法在下面写全，可手工重做）。

### 6.1 行为级变异（4 条，全部 RED-then-GREEN 成立）

| 缺陷 | 改回缺陷态的做法 | 实测红在哪几条 | 复验 |
|---|---|---|---|
| **P1-1** | `deliverSendMessage` 里的 `const gate = deps.gate ?? ((s,ev,cb)=>requirePanelRole(...))` → `() => true` | A1 / A1b / A1c / A1d 全红；**A1b 打出 `[["send-message",{"from":"HEAVENZEH","message":"!newAction(\"给个钻石\")"}]]`** —— 伪造的 owner 名真的进了目标 bot | sha256 一致，复原后 47/47 绿 |
| **P2-5** | `mindcraft.js` 两处 `revokeAgentTokenByName(agentName)` → `void 0` | B4（旧 token 仍可认证）/ B4b（登记表 `baseline=1, now=6`）/ B6 / B7 | 同上，复原后绿 |
| **P2-6** | `readProfilesList` / `readProfileFile` 里的闸门 → `() => true` | C1（拿到 `api/model/bytes` 列表）/ C1b（拿到 `raw`，含 `permissions.owners:["ServerOwner"]`）/ C6b | 同上，复原后绿 |
| **P1-2** | 注释掉 `stop()` 里 `if (CANCELLED_PENDING_STOP_REASONS.has(r)) this._cancelPendingLaunch(r, exceptTicket)` | E 组 4 条全红，红点就是原始缺陷：`secondRan=true`、`state:"claimed"`、`superseded:false`、`message:""` | 同上，复原后 39/39 绿 |

复验原文（每条的 green 前置 + 变异 + 红 + 复原 + green 后置）都是 `OK`：

```
OK   P1-1 send-message 的面板闸门（deliverSendMessage 里的 gate）
OK   P2-5 destroyAgent 里的 revokeAgentTokenByName 撤销
OK   P2-6 readProfilesList / readProfileFile 的面板闸门
OK   P1-2 stop() 里作废待启动票那一行
```

### 6.2 P1-2 的"另一半"：`preempt` 不许被误作废

只验"该停的停了"不够 —— 还得验"不该停的没停"（否则把抢占语义改坏也是"修好了"的假象）：

```
PASS G preempt 的新动作照常开工（票不许被误作废） → {"old":true,"new":true}
PASS G preempt 后 maxConcurrent === 1
PASS G preempt 把被抢占的单放回 ready（原有语义）
PASS H 旧动作超时后，等待中的新单照常开工（票不许被误作废） → {"new":true}
PASS I 单被暂停时，即时命令仍能开工（不许误拒）
```

### 6.3 P1-3：合并后只 1 个 `environment`；拆回去必须红

见 §3.2。合并后 `environment` 出现 **1 次**，四个变量齐全；夹具拆回重复键 ⇒ `exit 1`
且理由**正是**"重复键：environment（第 5 行与第 7 行同级重复）"（不是靠别的规则蒙对）。

### 6.4 P2-4 + 四个 loader 的同源竞态（内建变异体）

`web/scripts/world-events-race-unit.mjs`（esbuild 打包**真实 store** + 可控假 socket）：

```
PASS 真实源码：事件侧乱序断言全部通过            → 13/13
PASS 真实源码：四个 loader 乱序断言全部通过      → 14/14
PASS 变异体-events（删掉 events/stats 守卫）能红：恰好红在 5 条乱序断言上 → 红了 5/5
PASS 变异体-teams / chest / stock / ledger / fed：只删该 loader 的守卫 ⇒ 恰好红在它自己的断言上
PASS 上述五个变异体：其它 loader 断言仍全绿（逐条有效，不是一删全红）
PASS 上述五个变异体：事件断言仍全绿（两套机制互不牵连）
ALL PASS: 20 passed, 0 failed
```

> 这条同时回答了"乱序回执（新先回/旧后回）旧结果不覆盖"和"四个 loader 同源竞态"两个要求。
> 注意：它是**离线**证据（真实源码语义 + 假 socket 时间序），不是真浏览器 —— 见 §9。

### 6.5 P2-5：销毁后旧 token 拒 / 同名重建仍拒 / 新 token 可用

除单测 B4–B7 外，另用**真登记表**（`auth_gate` 的 `issueAgentToken` / `revokeAgentTokenByName` /
`credentialRole`，不注入桩）直接跑：

```
PASS 旧 token 签出后可用（凭据 → agent 角色）
PASS 销毁后旧 token 立刻失效（credentialRole ⇒ null）
PASS 同名重建签出的是**另一条** token
PASS 重建后旧 token 仍然拒（同名不复活旧凭据）
PASS 重建后新 token 可用
PASS 再销毁一次后新 token 也失效
PASS 反复 create/destroy 后登记表回到基线（不留残留、不增长） → base=0 now=0
ALL PASS: 7 passed, 0 failed
```

### 6.6 P2-7：另起一个 java（非本项目路径）⇒ 不阻塞备份

真造一个"别人的 MC"：用 `.tools` 的 javac/jar 打一个 `server.jar`（**同名**），放在
`tmp/verify7/foreignmc/`，跑起来（`Thread.sleep(900000)` 保活）：

```
ALL_JAVA=1
  JAVA_PID=35116 CMD=...\java.exe -Xmx256M -jar E:/我的世界ai/tmp/verify7/foreignmc/server.jar
OWN_COUNT=0            ← ★ 同名但不同路径，不被认（P2-7 的判据）
```

在它活着的时候跑备份：

```
FAIL 备份失败：找不到 mindcraft/bots/_board/board.sqlite —— 备份会丢掉任务板，拒绝继续
```

失败原因是**任务板路径**（见 §10），**不是**"java 占用/世界不静止" ⇒ 外部 java 没有阻塞备份这条链。
"本项目进程仍能被识别"由 §5 的真冷启动反证（`Get-ServerJava` 非空才可能走到"服务器已完全加载"）。

---

## 7. 真 socket 验证（P1-1 / P2-6 的 socket 层）

不是桩：`createMindServer(false, 18099)` 起**真** express + http + socket.io，用 `socket.io-client` 真连三方：

- **面板连接** = 出示**真面板凭据**（`getHandshakeToken()`，即 `.mindserver-token` 里那条）；
- **目标 bot** = `issueAgentToken('bot901')` 签出的**真 agent 凭据** + `login-agent` 认领通道（真实 bot 子进程走的就是这条）；
- **攻击者** = `issueAgentToken('bot902')` 的另一条真 agent 凭据。

```
PASS 真 socket：面板凭据与两份 agent 凭据都能过握手门
PASS P1-1（真 socket）agent 凭据 send-message ⇒ 拒（PANEL_ONLY） → {"ok":false,"code":"PANEL_ONLY",...}
PASS P1-1（真 socket）伪造 from=ServerOwner 的载荷**一条都没到**目标 bot → 收到 []
PASS P1-1（真 socket）面板凭据 send-message ⇒ 放行 → {"ok":true}
PASS P1-1（真 socket）投递载荷是白名单拷贝（只有 from/message，internal/permission 被丢掉） → {"from":"ServerOwner","message":"!stop"}
PASS P2-6（真 socket）agent 凭据 get-profiles ⇒ 拒（PANEL_ONLY）
PASS P2-6（真 socket）agent 凭据 get-profile ⇒ 拒，且没有 raw
PASS P2-6（真 socket）面板凭据 get-profiles ⇒ 放行（功能没被误伤）
PASS 结论（真 socket）：结果由**凭据类型**决定，不由 payload 字段决定
ALL PASS: 9 passed, 0 failed
```

服务端侧同时打出可审计的拒绝日志：

```
[mindserver] 拒绝 send-message：这是管理面事件，只允许面板连接（当前角色=agent）
[mindserver] 拒绝 get-profiles：这是管理面事件，只允许面板连接（当前角色=agent）
```

### 7.1 一处必须说准的口径

任务书写"伪造 `from`=在线 owner 名 ⇒ 目标 bot 收不到该字段"。实测的准确事实是：

- **agent 凭据**伪造 `from` ⇒ **整条消息都到不了**目标 bot（在闸门处就断了，连字段都没有）；
- **面板凭据**发 `from` ⇒ 服务端**保留** `from`（这是设计：面板的语义就是"替玩家说话"），
  但载荷被**白名单拷贝**成 `{from, message}`，调用方自带的 `internal` / `permission` / `task_id`
  等自述字段一律丢弃（§7 第 5 条实测）。

所以正确的说法是"**另一份凭据（agent）不再能自称 owner**"，而不是"`from` 字段被剥离"。
面板凭据能自称玩家属于既有权限模型边界（同机同用户可读 `.mindserver-token`），
t1 已在 `control.md` §1.3 / §6 如实登记，本批不修。

---

## 8. 新增 4 条常驻断言（任务书第 7 条）

加在 `scripts/tests/ops-regression.mjs`（**122 passed / 0 failed**，基线 117 + 新增 5 条 check）：

| 断言 | 做法 | 实测 |
|---|---|---|
| ① 抽**真身** | 正则从 `scripts/start-panel.ps1` 里抽出 `function Get-ServerJava {…}`，原样塞进探针脚本执行（不另写副本） | PASS → `function Get-ServerJava {` |
| ② 无匹配 ⇒ **严格 `$null`** | stub `Get-OwnServerJava` 返回空表，断言 `$null -eq $x` 且 `type == 'null'` 且 `count == -1` | PASS → `{"mode":"none","isNull":true,"isArray":false,"count":-1,"type":"null"}` |
| ③ 有匹配 ⇒ 带 `ProcessId` 的对象 | stub 返回 1 个进程 | PASS → `{"count":1,"pid":4242,"hasPid":true,"type":"PSCustomObject"}` |
| ③b 多进程仍可取 | stub 返回 2 个 | PASS → `{"count":2,"pid":1,"isArray":true}` |
| ④ 不许第二份内联 CIM | `start-panel.ps1` 里 `Get-CimInstance` / `Win32_Process` 必须 0 次 | PASS → `CIM 出现 0 次` |

**它们的"能红"（3 次变异，每次按 sha256 复原）**：

| 变异 | 结果 |
|---|---|
| `return $null` → `return ,$own`（**空数组**形态） | **②红**：`{"isNull":false,"count":0,"type":"Object[]"}`；③/③b 仍绿（断言范围精准，不是一红全红） |
| `return $null` → `return $false` | **②红**：`{"isNull":false,"type":"Boolean"}`；③/③b 仍绿 |
| 在 `start-panel.ps1` 里插一份 `Get-CimInstance Win32_Process` | **④红**（`CIM 出现 1 次`）+ 既有弱正则那条一起红 |

**一个必须写下来的诚实说明**：先试的变异是 `return @()`，它**没有**把 ② 弄红 ——
因为 PowerShell 会把"空数组输出"展开成"什么都没有"，`$x` 仍然是 `$null`。
也就是说 `@()` 这个写法本身**不是**真回归形态；真正危险的是 **`,$own`（逗号保数组）**、
`Write-Output -NoEnumerate`、`return $false` 这三种。上面两次红用的就是真形态。
这条"哪个变异其实不敏感"的结论比"测试是绿的"更值钱：它说明断言钉的是**契约**（严格 `$null`），
而不是某个具体拼写。

---

## 9. 只到单测 / 未真机的项（诚实清单）

| 项 | 证据到哪一层 | 没做真机的原因 |
|---|---|---|
| P1-2 的 `!stop` 打断"等待中的票" | 单测 39/39 + 变异必红；E2E 53/53 只旁证了动作排队可用 | 需要一个"旧动作正跑、新单已拿票、此刻按 !stop"的**精确时序**，真机无法稳定制造该窗口（不是不愿做，是不可重复） |
| P2-4 乱序回执 | 真实 store 源码 + 假 socket 时间序（A 13/13、B 14/14、7 个变异体） | 没在真浏览器里人为制造"旧回执后到"；`events:since` 的乱序靠服务端时序，浏览器侧不可控 |
| P2-5 的"断不掉的连接"分支（`data.revoked` 戳） | 离线单测（`invalidateAgentSocket` + `socketRole`） | 真 socket 上做"销毁瞬间不断连"需要精确竞态；只验了"撤销后新连接被拒"（§6.5） |
| P2-7 的"CIM 不可用"分支 | 单测（`nullCmd` 用例 + 注释/文档口径） | 真机上无法安全模拟 WMI 不可用 |
| P2-6 的"目录穿越"边界 | 既有单测保留（`basename` 防穿越、只回相对名） | 属于既有行为，本批未改 |

---

## 10. 本次验证发现的问题（**不是本批 7 条之一**）

### ⚠ P1（既有，HEAD 就有）：自动备份 100% 失败 —— 任务板库迁移后路径没跟着改

现象（真机，两次）：

```
scripts/stop-panel.ps1  → 自动备份：失败（exit=1），停服已完成，不受影响
scripts/backup-world.ps1 → FAIL 备份失败：找不到 mindcraft/bots/_board/board.sqlite —— 备份会丢掉任务板，拒绝继续
                            位置：backup-world.ps1: line 653
```

根因：ADR-0001 D6 阶段 3（提交 `7f904e4` / 接线 `861b82b`，**均早于本批**）把任务板库迁到
"存档维度"：`mindcraft/bots/_board/board.sqlite` →
`mindcraft/bots/_worlds/<world_id>/_board/board.sqlite`（旧位置留 `MIGRATED-TO.txt` + 三份 `.bak`）。
迁移在**本次真冷启动**（22:44:22）第一次真正执行，于是 `backup-world.ps1:649-650` 的硬闸门
（`Test-Path mindcraft/bots/_board/board.sqlite`，否则 `throw`）从此必然失败。

证据链：

- `git show HEAD:scripts/backup-world.ps1` 里也有同一行 ⇒ **不是本批改动引入**；
- 迁移前的最后一次成功备份：`backups/world-20261113-043001`（04:30）；迁移后（22:52 / 23:17）两次都失败；
- 新库确实在：`mindcraft/bots/_worlds/w-20261113-96c12b98/_board/board.sqlite`（81920 B，22:44:22）。

影响：**每次停服都会少一次备份**，而且失败信息只说"找不到文件"，不指向"库已迁移"。
建议（超出 t5 范围，留给 captain 派单）：

1. `backup-world.ps1` 的板库定位改成"先认 `_worlds/<world_id>/_board/`，回退旧路径"；
2. 迁移器在旧位置留的 `MIGRATED-TO.txt` 应被备份脚本当成**指路牌**（它已经写了新路径）；
3. 顺带把 `Get-OpenDbHandles` / `boardMeta.path` 的展示路径一起改成新维度（否则清单里写的还是旧路径）。

> 这条**不影响**本批 7 条缺陷的结论（7 条逐条都绿 + 都能红），但它是"停服即丢备份"级别的运维风险，
> 建议在下一批里优先修。

---

## 11. 工作区残留与副作用

**代码状态**：与验证开始时一致，只有本批预期的改动 + 本次允许追加的门禁断言。

```
父仓    M scripts/{backup-world,release,start-panel,stop-panel}.ps1
        M scripts/tests/ops-regression.mjs        ← 本次按任务书第 7 条追加 5 条 check（唯一改动）
        M web/src/{stores/world.ts,components/world/EventsPanel.vue}
        ?? scripts/{compose-gate.mjs,lib/server_proc.ps1} · web/scripts/world-events-race-unit.mjs
        ?? docs/audit-r6/fixes5/                  ← 本报告所在目录
mindcraft  M docker-compose.yml · src/agent/{action_manager.js,library/control.js}
           M src/mindcraft/{auth_gate.js,mindcraft.js,mindserver.js}
           M tools/bot002_action_start_unit.mjs · ?? tools/sec_review_unit.mjs
           M web-dist/**（重新构建 + 清单，t4/t7 的产物，指纹一致）
```

**进程 / 端口**：java 0 个；25565/25566/25575/25576/8080/18099 全部无监听。
遗留的 3 个 `node` 进程是 13:41 / 21:31 启动的**本会话工具进程**（非本仓服务、无监听端口）。

**文件系统副作用（如实登记）**：

- 生产 `server/world`：`level.dat`（真冷启动关服保存）、`session.lock`（起服创建）被正常改动；
  `world-id.json` **未变**（同 id / 同 mtime）。
- `mindcraft/.mindserver-token`：被真 socket 验证的临时 mindserver 覆写过，进程退出时按 F-RT-003 **已删除**
  （下次启动重新生成，属设计行为）。
- `backups/`：两次失败备份都自行清理了 `.partial`，没有留下会被误认成备份的目录；没有新增备份。
- 临时目录：`tmp/verify7/`（一次性脚本与"别人的 server.jar"）、`tmp/e2e/`（E2E 已自清）。

---

## 12. 复现命令索引

```
# 1) 离线门禁
cd mindcraft && npm test && npm run gate
node tools/preflight.mjs && node tools/deps_injection_audit.mjs

# 2) 前端产物链
cd web && npx vue-tsc --noEmit
cd .. && powershell -File scripts/release.ps1 -SkipDocker
powershell -File scripts/release.ps1 -VerifyOnly

# 3) 父仓
node scripts/tests/ops-regression.mjs
node scripts/compose-gate.mjs
powershell -Command "全部 .ps1 走 [Parser]::ParseFile + 读前 3 字节查 BOM"

# 4) 真机
powershell -File scripts/e2e.ps1 -Scenario all          # 53/53
powershell -File scripts/start-panel.ps1                # 真冷启动（会弹浏览器）
powershell -File scripts/stop-panel.ps1

# 5) 七条反向验证（一次性脚本，做法见 §6/§8，可手工重做）
node tmp/verify7/reverse.mjs        # P1-1 / P2-5 / P2-6 / P1-2：变异→红→sha256 复原→绿
cd web && node scripts/world-events-race-unit.mjs       # P2-4 + 四个 loader

# 6) 真 socket
cd mindcraft && node tmp/verify7/socket_verify.mjs      # 真面板凭据 vs 真 agent 凭据

# 7) P2-5 / P2-7 的真登记表 / 真进程
cd mindcraft && node tmp/verify7/p25_rebuild.mjs
powershell -File tmp/verify7/probe_own.ps1              # 外部 java 活着时：OWN_COUNT=0 / ALL_JAVA=1
```

> `tmp/verify7/*` 是**一次性驱动脚本**（不入库）。它们要证明的东西已经在本文档正文里落到"可手工重做"的程度
> （每条都写了"改哪一行、期望红在哪几条"）。
