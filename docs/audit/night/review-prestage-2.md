# 预审 · 下一个实现窗口的三条（F-EXEC-201 / F-AI-202 / F-WEB-205）

> 复核官：gate-keeper ｜ 2026-11-06 02:0x–02:2x
> 方法：读单 → 读代码现状 → **能实测的一律实测**（不靠推理下结论）。
> 特别说明：审的过程中发现 **F-EXEC-201 与 F-WEB-205 已经被 patch-smith 实现了**，
> 所以这两条的预审实际变成了"**对已落地实现的事后复核**"；只有 **F-AI-202 还是原样未动**。

---

## 0. 判决一览

| 单 | 现状 | 我的判决 | 一句话 |
|---|---|---|---|
| `F-EXEC-201` speak RCE | **已实现**（spawn + stdin） | **通过**（附 2 条 caveat） | 结构改对了；有一条"看起来该做、其实会把中文弄坏"的优化陷阱，**千万别加** |
| `F-AI-202` `!goal` | **完全未实现** | **修法需修正后再动手** | `!goal` 升权可行（用户不受影响），但**`!endGoal` 绝不能一起升**；且"限长 500"不是重点、**转义才是** |
| `F-WEB-205` 停止面板 | **已实现**（token + pushd） | **通过**（附 2 条残留） | cwd 链条我逐环验过，对得上；token 缺失的报错已经是人话 |

---

## 1. 先更正我自己的一处错误（captain 第 ② 点）

captain 说"`config/network.json` 仍留旧论断"是**我的陈旧读数**——**他是对的，我错了**。

我实测：
```
$ grep -nE "白名单|white-?list|只有你|冒用|挡不住" config/network.json
  line  5: "…开白名单（只挡名单外的人；**挡不住冒用 HEAVENZEH 这个名字**，见 F-SEC-204
             —— 2026-11-06 审计更正：旧文案声称「名单内的人才进得来」，那是错的）…"
  line 10: "_剩余风险": "…任何人把游戏名改成 HEAVENZEH 即可**冒用**主人身份进服…"
$ grep -n "只有你能进" config/network.json → **零命中**
```
⇒ `d80caeb` 确实已经改掉了，**没有残留**。

**错在哪**：我上一轮写"`config/network.json` 还留着一处简版论断"时，靠的是**对修复前文本的记忆**，
**没有 grep 就跑出结论**。这正是我反复要求别人别犯的错（拿印象当证据）。已记进 log，不再犯。

---

## 2. `F-EXEC-201`（speak.js RCE）—— 已实现，我实测了最关键的一环

### 2.1 现状（patch-smith 已改，逐行确认）

```js
// src/agent/speak.js:99-141
const file = isWin ? 'powershell' : isMac ? 'say' : 'espeak';
const argv = isWin
    ? ['-NoProfile', '-NonInteractive', '-Command',
       'Add-Type -AssemblyName System.Speech; ' +
       '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
       '$s.Rate = 2; ' +
       '$t = [Console]::In.ReadToEnd(); ' +      // 文本只从 stdin 进
       '$s.Speak($t); $s.Dispose()']
    : isMac ? []            // say 无参数 = 从 stdin 读
            : ['--stdin'];  // espeak 显式 stdin

child = spawn(file, argv, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
child.on('error', err => { console.error('TTS error', err); done(); });
child.on('close', () => done());
if (child.stdin) { child.stdin.on('error', ()=>{/* EPIPE */}); child.stdin.end(String(txt)); }
```

**结构上已经安全**：`exec(拼串)` → `spawn(字面量 argv)`，用户文本只经 `stdin`，
且 `shell: true` 在**全仓 grep 为空**（`grep -rn "shell:\s*true" src/ main.js` → 无输出）。
⇒ "文本进命令行解析"这个前提**已被彻底消除** ✅

### 2.2 ⚠️ 我踩到的一个陷阱，必须写下来以免后人"优化"坏掉它

我最初的"专家直觉"是：Windows 上 `[Console]::In.ReadToEnd()` 用默认控制台编码解 stdin，
而 Node 写的是 UTF-8 字节 ⇒ **中文会乱码**，应该加 `[Console]::InputEncoding = UTF8`。

**我实测了，结论与我直觉相反：**

```
$ printf '中文测试HELLO' | powershell -NoProfile -NonInteractive -Command '[Console]::In.ReadToEnd()'
中文测试HELLO                                        ← ✅ 默认就对
$ printf '中文测试HELLO' | powershell -NoProfile -NonInteractive -Command '[Console]::InputEncoding=[System.Text.Encoding]::UTF8; [Console]::In.ReadToEnd()'
���Ĳ���HELLO                                        ← ❌ 加了反而乱码
```

⇒ **现有实现（不加 InputEncoding）在中文上是正确的；加那一行会把中文弄乱。**
**请在 commit body 或代码注释里写死这条实测结论**，否则下一个人（很可能是未来的我）会"顺手加固"然后弄坏中文 TTS。

### 2.3 三个平台的写法是否正确（逐条判，附诚实边界）

| 平台 | 现写法 | 是否正确 | 依据 |
|---|---|---|---|
| **Windows** | `powershell -Command '<固定脚本>'` + `[Console]::In.ReadToEnd()` | **正确，且已实测** | 上面的编码实验证明 stdin 通路可用、中文正确；`-NonInteractive` 不影响读 stdin |
| **macOS** | `say`（**无参数**） | **正确**（标准行为：`say` 不给文本时从 stdin 读） | 无法在本机实测（无 mac） |
| **Linux** | `espeak --stdin` | **正确**（espeak/espeak-ng 的 `--stdin` 即"从 stdin 读输入"） | 无法在本机实测（无 linux、未装 espeak） |

**诚实边界（要写进 finding 的 review）**：我只在 **Windows** 上实测过。
mac/linux 两个分支**是依据工具的标准 CLI 行为判定的，不是实跑验证**。
若这两个平台有用户，落地后需各跑一次正向对照（正常中文能播、注入串被当文本朗读）。

一个可选的稳健化（不必须）：`espeak --stdin` 是**按行**读，`child.stdin.end(String(txt))` 若文本无换行，
部分版本可能等到 EOF 才播 —— 现在的 `end()` 会关流，所以不会卡住，但建议在 finding 的 verify 里
加一句"linux 上确认无换行文本也能播"。

### 2.4 `speak` 移出 `SAFE_RUNTIME_SETTINGS` 会打断测试吗？—— **不会**

实测：
```
$ sed -n '139,145p' src/mindcraft/auth_gate.js
  SAFE_RUNTIME_SETTINGS = [ 'minecraft_version','host','port','auth','base_profile','load_memory',
    'init_message','only_chat_with','language','allow_vision','relevant_docs_count','max_messages',
    'num_examples','max_commands','narrate_behavior','log_all_prompts','show_command_syntax',
    'chat_ingame','chat_bot_messages','render_bot_view','code_timeout_mins','spawn_timeout' ]
⇒ **已经没有 'speak'**（patch-smith 已删）
```
- `mindserver_gate_unit` 的相关断言是 `SAFE_RUNTIME_SETTINGS` 里**不含** `allow_insecure_coding` / `blocked_actions` / `profile`（:100-102），
  以及"白名单里每个键都真的存在于 spec"（:103）—— 删掉一个键**不会让这两类断言失败**。
- `settings_check` 仍然 **exit 0**（我在 02:4x 跑过）：`speak` **仍被代码读取**（`agent.js:746 if (settings.speak)`）
  且**仍在 spec 里声明**（`settings_spec.json:49`）⇒ "代码读的键 = spec 声明的键" 不被破坏 ✅
- **面板不会变哑**：我 grep `web/src` 的 `speak` → **零命中**，`SetupView.vue:40` 明确写"只暴露真正常改的几项"，
  即面板不渲染 speak 开关 ⇒ **没有"开关点了没反应"的 UX 回归** ✅
- 行为变化：`speak` 现在只能改 `settings.js` 文件 + 重启，不能运行期开。**这正是本条想要的**（远程开宿主机行为）。

### 2.5 第三条问题：还有别的路径能把 LLM 输出送进 shell 吗？—— **没有（就运行时而言）**

```
$ grep -rn "from 'child_process'" src/ main.js
  src/agent/speak.js:1          ← 已修（spawn + stdin）
  src/process/agent_process.js:1 ← spawn(process.execPath, args)，args 是 ['main.js','-n',<name>,'-p',<port>]
$ grep -rn "shell:\s*true" src/ main.js → 无输出
```
- `agent_process.js:114` 的 `spawn` **不带 shell**，且 `args` 里的 agent 名字经
  `validateNameFormat`（`mindserver.js` 的 create-agent 校验）⇒ 不构成命令注入面。
- `tools/*.mjs` 里用 `execFileSync` 的是**开发工具**（`unit_all` / `audit_rules` / `atom_all`），不在运行时链路。
- `coder.js`（`!newAction`）走 SES/vm 沙箱、不是 shell，且受 `allow_insecure_coding` + owner 双重限制。
- `mindserver` 的 `server-stop` 走 **RCON 协议**（TCP），不是 shell。

**但有一条"半条"要提醒**：`permissions.js:310 inspectChatText` 只拦"以 `/` 开头的行"——
它守的是**斜杠命令**，不是 shell。现在 speak 不再拼 shell 所以无所谓，但**将来任何新增的"文本→外部进程"**
都必须记得：`inspectChatText` **不是** shell 过滤器。建议在 `speak.js` 那段注释里加这一句。

---

## 3. `F-AI-202`（`!goal`）—— **完全未实现**，且原修法有一处会反伤

### 3.1 现状（我实测，全部仍是原样）

```
$ node -e "commandLevel('!goal')"        → trusted      ← 仍是信任级
$ node -e "commandLevel('!endGoal')"     → trusted
$ sed -n '224,228p' src/models/prompter.js
    226: let self_prompt = … ? `YOUR CURRENT ASSIGNED GOAL: "${this.agent.self_prompter.prompt}"\n` : '';
    → **没有转义、没有限长**（原样 `${…}` 插进双引号）
$ grep -nE "max_turns|MAX_NO_COMMAND" src/agent/self_prompter.js
    → 只有 MAX_NO_COMMAND = 3（"连续 3 轮无命令就停"），**没有轮次/时长硬上限**
```

### 3.2 ① `!goal` 升 `OWNER_ONLY` 会不会让正常用户用不了？—— **对你不会，但有前提**

- **当前唯一启用的 profile 是 `./profiles/my-local.json`，`owner = "HEAVENZEH"`**
  （`settings.js:19` 只列了它一个）⇒ 你是主人 ⇒ 升权后**照常可用** ✅
- **但有一个必须写清楚的后果**：`resolveLevel` 在**没配 owner 时返回 TRUSTED**，
  而 **OWNER 级只有在 owner 名单命中时才可达**。
  ⇒ 一旦升权，**任何 owner 为空的 profile 就彻底用不了 `!goal`**（不是"降级"，是 100% 拒绝）。
  实测这些 profile 的 owner 全为 null：`profiles/deepseek.json`、`profiles/defaults/*.json`（assistant/creative/god_mode/survival）。
  ⇒ 用户将来只要把 `settings.js` 的 `profiles` 换成 deepseek 或某个 defaults，**`!goal` 就整体失效**。
  **建议**：升权的同时，在 `settings.js` 注释和 PLAYBOOK 写明"用 `!goal` 必须配 owner"，
  否则这会变成一个"功能莫名不见"的幽灵 bug。

### 3.3 ⚠️ 原修法里有一处我不同意：**`!endGoal` 千万不要一起升**

finding 写"把 `'!goal'`（与 `'!endGoal'` 一并考虑）从 `TRUSTED_COMMANDS` 移到 `OWNER_ONLY_COMMANDS`"。

**我的判定：`!endGoal` 应留在信任级。** 理由：
- `!endGoal` 是**急停**（停掉自提示循环）。它的危险方向是"停止"，不是"授权"。
- 如果把 `!goal` 升到 owner 而 `!endGoal` 也升到 owner，那么 **owner 之外的任何人发现 bot
  被套上了一个疯狂目标时，将无法叫停** —— 这与"降低风险"的目标相反。
- 反过来，**保留 `!endGoal` 在信任级是纯收益**：多一个人能按下急停，且它不能被用来做任何坏事。
- 唯一要留意的配套：goal 会写进 `memory.json` 并在重启后恢复（`history.js:133-137`），
  所以"跨重启的旧 goal"需要能被信任级 `!endGoal` 停掉 —— 更说明它不能升权。

⇒ **建议修法改为：只移动 `'!goal'`，明确保留 `'!endGoal'`，并在 commit body 写清理由。**

### 3.4 会打断哪些测试 —— 我定位到了具体行号（必须在同一 commit 里改）

`tools/permissions_unit.mjs`：
| 行 | 断言 | 升权后会怎样 |
|---|---|---|
| **64** | `trustedCan = [… '!goal' …]` → `check('信任级能用走/跟/采集/…')` | **红**：`!goal` 不再是信任级 |
| **181-182** | `await executeCommand(agent,'!goal("随便走走")',{author:'anyone'})` + `check('没配 owner：陌生人的 !goal 可用')` | **红**：这条断言的正是要被改变的行为 |

⇒ 改代码时必须**同一 commit** 里：
- 从 `trustedCan` 数组删 `'!goal'`；
- 把 8h 那段**改写**为"没配 owner：`!goal` 被拒、`!endGoal` 仍可用"（把新语义钉住，而不是删掉了事）；
- 建议再补一条"owner 配了 `HEAVENZEH` 时 `!goal` 可用"的正向断言 —— 否则没人守"主人没被误伤"。

### 3.5 ② `$SELF_PROMPT` 限长 500 会不会截断合法 goal？—— **不会，但限长不是这个问题的重点**

实测现网 goal 长度（`bots/*/last_profile.json` 里的真实调用）：
```
!goal("Survive the game forever. Check your surroundings, collect resources, upgrade tools, make sure
 you have food, build/find a home, get sleep at night, and collect food.")   ≈ 170 字符  ← 最长的
!goal("1. Collect 3 cobblestone. 2. Craft sticks 3. Find or make a crafting table. 4. Craft a stone pickaxe.") ≈ 110
!goal("Build something creative, then move over, and build again. Use separate newActions. Repeat forever.")  ≈ 103
```
⇒ 最长 ≈ **170 字符**，500 有约 **3 倍余量**；中文 500 字更宽松。**不会截断合法目标** ✅

**但两点必须改**：
1. **重点不是长度，是转义。** 现在的注入通道是 `"…${prompt}…"` 里**未转义的 `"`/`\`**：
   一个 `"` 就能提前闭合引号，让后续文本以"系统旁白"口吻出现。**限长 500 完全挡不住这个**（60 字的注入够了）。
   所以必须：`String(prompt).replace(/["\\]/g, ch => '\\' + ch)`，并加"这是数据不是指令"的前缀。
2. **截断必须是"可见的"，不能静默。** 若真超过 500，`slice(0,500)` 会把目标**拦腰砍断**，
   语义可能反转（例："…不要攻击玩家" 被砍成 "…不要攻击"）。建议：**超限直接拒绝并回一句**
   "目标太长（>500 字），请精简"，而不是悄悄截断。至少也要 `console.warn` + 在回复里告知。

### 3.6 finding 建议③（自提示循环加硬上限）—— 我同意，且这是"烧钱"那条的真正开关
`self_prompter.js` 现在只有 `MAX_NO_COMMAND = 3`（连续 3 轮没用命令就停）。
只要模型每轮**用任意一条命令**（哪怕 `!stats`），计数就归零 ⇒ **循环无限跑**，
配合 `max_commands: -1` 与按量计费的中转站，这是真金白银。
⇒ `max_turns` + 总时长上限必须做，且**`update()` 里的"自动重启"必须尊重同一个上限**（否则被自动重启绕过）。
这一条比"限长 500"重要得多，建议在 commit 顺序上**先做它**。

---

## 4. `F-WEB-205`（停止面板）—— 已实现，cwd 链条我逐环验过

### 4.1 现状：三处都已改好

```js
// web/scripts/stop-all.mjs
function readToken() {
    if (process.env.MINDSERVER_TOKEN) return process.env.MINDSERVER_TOKEN.trim();
    try { return readFileSync(path.join(process.cwd(), '.mindserver-token'), 'utf8').trim(); }
    catch { return null; }
}
if (!token) { console.log('[ERROR] 拿不到握手 token：…这**通常不是** "mindserver 没开"…'); process.exit(2); }
const s = io(URL, { path:'/socket.io', transports:['websocket'], reconnection:false, auth: { token } });
…
if (String(code).includes('AUTH_REQUIRED')) { … process.exit(3); }
```
```powershell
# scripts/stop-panel.ps1
$root   = Split-Path -Parent $PSScriptRoot                 # = 仓库根（scripts/ 的上一级）
$script = Join-Path $root 'web\scripts\stop-all.mjs'
Push-Location (Join-Path $root 'mindcraft')                # ← 关键：切到 mindcraft
try { & $node $script; $stopCode = $LASTEXITCODE } finally { Pop-Location }
if ($stopCode -eq 2) { … '拿不到握手 token。服务器仍在运行，请不要直接关窗口（会丢未刷盘的存档）。' }
if ($stopCode -eq 3) { … '握手被拒（token 已过期）。服务器仍在运行，请重跑本脚本而不是强关。' }
```

### 4.2 ① token 文件确实写在 mindserver 的 cwd，`pushd` 到 mindcraft 够不够？—— **够，链条对得上**

我把整条链的 cwd 逐环验了：

| 环节 | 事实 | 结论 |
|---|---|---|
| mindserver 写 token 的位置 | `mindserver.js`：`TOKEN_FILE = path.join(process.cwd(), '.mindserver-token')` | 与 cwd 绑定 |
| mindserver 由谁、以什么 cwd 启动 | `scripts/start-panel.ps1:187-188`：`Start-Process -FilePath $node -ArgumentList 'main.js' -WorkingDirectory (Join-Path $root 'mindcraft')` | **cwd = `<repo>\mindcraft`** ✅ |
| 所以 token 落在 | `<repo>\mindcraft\.mindserver-token` | ✅ |
| stop-panel.ps1 切到哪 | `Push-Location (Join-Path $root 'mindcraft')` | **同一个目录** ✅ |
| 面板自己怎么读 token | `start-panel.ps1:203`：`$tokenFile = Join-Path $root 'mindcraft/.mindserver-token'` | 三处口径一致 ✅ |

⇒ **`pushd` 到 mindcraft 是够的，且与 start-panel.ps1 读的是同一个文件。** 这一环设计正确。

### 4.3 ② 调用链里还有没有别的地方假设了 cwd？

链路：`停止面板.bat` → `powershell -File "%~dp0scripts\stop-panel.ps1"` → `& $node $script`。

- `停止面板.bat`：用 `%~dp0` 拼绝对路径，**不依赖 cwd** ✅
- `stop-panel.ps1`：`$root` 由 `$PSScriptRoot` 推导（不是 cwd），`$script` 是绝对路径，**唯一依赖 cwd 的是 Push-Location 之后那一行**，而那是**故意**的 ✅
- `stop-all.mjs`：只用 `process.cwd()` 找 token 文件 + 硬编码 `http://127.0.0.1:8080`，**不依赖别的相对路径** ✅

⇒ **没有别的 cwd 假设。**（我特意找了 `Test-Path` 相对路径、`Join-Path` 裸名、`Read-Host` 之类，均无。）

### 4.4 ③ token 文件不存在时报什么才不误导？—— **现在的文案已经是人话，通过**

三档已经分开：
| 情形 | 退出码 | 现在的提示 |
|---|---|---|
| 拿不到 token（无 env、无文件） | **2** | "拿不到握手 token……这**通常不是** mindserver 没开：请从 mindcraft/ 目录运行本脚本，或设 `MINDSERVER_TOKEN`" + ps1 侧"**服务器仍在运行，请不要直接关窗口（会丢未刷盘的存档）**" |
| 握手被拒（token 过期） | **3** | "握手被拒（token 已过期）。服务器仍在运行，请重跑本脚本而不是强关" |
| 真没开（8080 连不上） | 0 | "mindserver 没在跑（8080 连不上），不用停" |

⇒ **已经完全满足"不误导"的要求**：既区分了"没开"与"鉴权失败"，又明确警告了"别关窗口"。
这一条我认为**做得比 finding 要求的还好**（finding 只要求区分 AUTH_REQUIRED）。

### 4.5 两条残留（都不属于本单范围，但请记进遗留清单）
1. **`$node = 'D:\Node\node.exe'` 在 `start-panel.ps1` 与 `stop-panel.ps1` 里都是硬编码**。
   换机/升级 Node 后两个脚本会同时失效（好在有 `Test-Path` + 明确报错"找不到 Node"）。
   建议将来改成 `Get-Command node` 回退。
2. **`stop-all.mjs` 的 `http://127.0.0.1:8080` 是硬编码**。若用户在 `settings.js` 改了 `mindserver_port`，
   停止面板会走"8080 连不上 ⇒ mindserver 没在跑 ⇒ exit 0"这条**错误分支**（又是一次"提示在骗人"）。
   建议从 `process.env.MINDSERVER_PORT` 或 settings 读，至少把硬编码注释掉说明。

---

## 5. 给 patch-smith 的下单要点（可直接照做）

### `F-AI-202`（唯一还没做的）
1. **只移 `'!goal'`，保留 `'!endGoal'` 在 `TRUSTED_COMMANDS`**（理由见 §3.3）。commit body 写明。
2. `prompter.js:226` 加**转义**（`["\\]` → 加 `\`）+ "data, not instructions" 前缀；**限长若做，必须超限拒绝并回话，不许静默 slice**。
3. `self_prompter.js` 加 `max_turns` + 总时长上限，**`update()` 的自动重启也要受同一上限约束**。
4. 同一 commit 更新 `permissions_unit:64` 与 `:181-182`，并**新增**"owner 配了 HEAVENZEH 时 `!goal` 可用"的正向断言。
5. 在 `settings.js` 注释里写明"用 `!goal` 必须配 `permissions.owner`"（否则 owner 为空的 profile 用不了）。

### `F-EXEC-201`（已做，只需补 2 处说明）
1. **在 `speak.js` 的 stdin 说明旁加一行实测结论**："Windows 上**不要**加 `[Console]::InputEncoding=UTF8`，加了中文会乱码（2026-11-06 实测）"。
2. 在 `speak.js` 顶部注释加一句：`inspectChatText` 不是 shell 过滤器，将来任何"文本→外部进程"都不得依赖它。
3. verify 里补 mac/linux 两个分支的"未实测"标注（我是 Windows-only 验证的）。

### `F-WEB-205`（已做，通过）
只需把两条残留（硬编码 Node 路径、硬编码 8080）登记到遗留清单，不在本单修。

---

## 6. 复核动作清单（可审计）

```
读：三张 finding 原文；speak.js(全文关键段)；auth_gate.js:139-165；permissions.js:83；prompter.js:224-228；
    self_prompter.js；stop-all.mjs；scripts/stop-panel.ps1(全文)；停止面板.bat；start-panel.ps1:171-210
跑：printf|powershell 编码实验 ×2（关键：证明"别加 InputEncoding"）
    grep：child_process 全仓导入、shell:true、SAFE_RUNTIME_SETTINGS、'speak' 在 spec、
          web/src 的 speak、settings_spec 用法、!goal/!endGoal 等级
    node -e：commandLevel('!goal'/'!endGoal'/'!newAction')
    sed：permissions_unit:55-70 与 165-190（定位会红的两条断言）
    grep：bots/*/last_profile.json 里的 !goal 实例（量长度）
未做：mac/linux 上的 say/espeak 实跑（无该平台）；gate:full（本会话不能 spawn）
```

## 7. 我这一轮的失误（主动记录）
§1 那条——**"`config/network.json` 仍留旧论断"是我没 grep 就凭记忆下的结论，已证实是错的**。
教训与我前两次泄露口令同源：**不要拿印象代替实测**。本轮之后，凡涉及"某文件里还有没有某句话"，
一律先 `grep` 再说。
