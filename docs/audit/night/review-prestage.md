# 预审裁决 · D2 三条最高价值单子的"修法是否成立"

> 复核官：gate-keeper
> 时间：2026-11-06 01:30–01:55 +08:00
> 范围：`F-SEC-201` + `F-SEC-206`（顺序与 .gitignore 覆盖面）、`F-SEC-202`（RCON 绑定）、`F-SEC-204`（冒名登录）
> 方法：**不采信任何转述**，逐条重跑侦察兵的命令、自己读代码。
> 分工前提（captain 2026-11-06 裁决）：captain 是唯一执行者（跑 gate / commit / 删文件），
> 我是唯一判决者。故本文件只出裁决与判据，不含任何写操作建议之外的动作。

---

## 0. 三条裁决一览

| 单子 | 侦察兵给的修法 | 我的裁决 | 一句话理由 |
|---|---|---|---|
| `F-SEC-201`+`F-SEC-206` | "必须先 206 后 201" | **顺序成立，但理由不完整；真正的致命顺序不是这个** | 201 按其写法不产生 `.env` ⇒ 206 不是硬前置；真正会翻车的是"先清 keys.json 后 setx"→ 模型全挂 |
| `F-SEC-202` | `server-ip=127.0.0.1`，称"最小改动、不动玩法" | **前半对、后半不成立；修法选错了首选方案** | RCON 无独立绑定参数 ⇒ 收 `server-ip` 必然连游戏端口一起收 ⇒ 手机/局域网上不了服，而这正是该配置的唯一目的 |
| `F-SEC-204` | "用户已明知并权衡过" | **该说法成立（有三处书面证据），但权衡的前提里有一处事实错误** | 项目自己的安全论断"开白名单后冒用名字就没用了"在**只有一个名字**时**不成立** |

---

## 1. `F-SEC-201`（明文 key）+ `F-SEC-206`（.gitignore 兜底）

### 1.1 我独立核证了什么（全部复现，与侦察兵一致）

```
mindcraft/keys.json：16 个键，仅 1 个非空 → OPENAI_API_KEY，长度 67
被忽略：git check-ignore → mindcraft/.gitignore:9:keys.json          ✅
未入库：git ls-files | grep -i keys → 只有 keys.example.json        ✅
读取顺序：src/utils/keys.js 先 keys.json、再 process.env[name]      ✅（这条决定下面 1.2）
两个仓的 .env 均不被忽略：git check-ignore .env → 无输出             ✅（206 的指控成立）
根仓下列全部不忽略：.env .env.local .env.production secrets.json
  credentials.json keys.json id_rsa id_ed25519 config.local.js .mindserver-token  ✅
两个仓当前都没有已跟踪的敏感文件（git ls-files 逐条查，命中 0）      ✅
```

⇒ `F-SEC-206` 的**事实指控完全成立**，不是吹毛求疵。

### 1.2 顺序：**"206 先"成立，但不是因为"201 会写出 .env"**

侦察兵的理由是"201 的修法要把密钥搬到 `.env`，所以先补 .gitignore"。**这个理由与 201 自己的写法矛盾**：
201 推荐的落地是 `setx OPENAI_API_KEY "<值>"`（用户级环境变量，见 201 的 suggested_fix 2b），
**根本不产生 `.env` 文件**。按 201 原样执行，206 并非硬前置。

**那为什么仍然应该 206 先？三条理由，都是真实风险：**

1. **落地漂移**：`.env` 是"把密钥搬出仓库"的行业标准形态。201 写着 `setx`，但真到落地时，
   包括用户本人在内，极可能改成写 `.env`（更便携、更好备份）。**修 A 洞时开 B 洞**是这类任务
   最常见的失败模式，206 就是那道保险。
2. **成本极不对称**：206 是纯追加、零行为变化、5 分钟、失败概率≈0；201 要动一把**活密钥**。
   先做零风险的那件，是排程常识。
3. **本仓有前科**：`mindcraft/.gitignore:45-46` 的注释自己记载"`git add -A` 被误提交进仓库 6 个"。
   一旦密钥进了 git 历史，代价是改历史 + 轮换，比现在加十行规则贵两个数量级。

⇒ **裁决：维持"206 先、201 后"，但 commit body 要写清真实理由（防漂移 + 成本不对称），
不要写成"因为 201 要写 .env"——那与 201 的实际修法不符，会误导下一个人。**

### 1.3 ⚠️ 真正致命的顺序问题（侦察兵漏了，这条比 206/201 顺序更重要）

`src/utils/keys.js` 的读取顺序是 **`keys.json` 优先 → `process.env` 兜底**：

```js
let key = keys[name];
if (!key) { key = process.env[name]; }
if (!key) { throw new Error(`API key "${name}" not found in keys.json or environment variables!`); }
```

后果：**若先把 `keys.json` 清空、而 `setx` 尚未生效，`getKey()` 直接 throw，
所有模型调用当场全挂**（不是降级，是异常）。而 `setx` 有两个坑：

- **只对之后新起的进程生效**，当前正在跑的 mindserver/agent 取不到；
- **必须由用户本人执行**（patch-smith 不能替用户设系统环境变量，属红线内"不改用户环境"更妥）。

⇒ **唯一正确的落地顺序是三步，不可颠倒：**

| 步 | 谁做 | 动作 | 通过判据 |
|---|---|---|---|
| 1 | **用户** | `setx OPENAI_API_KEY "<原值>"`，然后**关掉并重开**命令行/agent | `echo %OPENAI_API_KEY%` 有值 |
| 2 | patch-smith | 在**新进程**里验证外部化通路已通（不改文件） | `node -e "import('./src/utils/keys.js').then(m=>console.log(m.getKey('OPENAI_API_KEY').length))"` → 输出 67 |
| 3 | patch-smith | 才把 `keys.json` 的 `OPENAI_API_KEY` 清成 `""` | `getKey` 仍能返回（来自 env），长度 67 |

**若跳过步 1/2 直接做步 3，凌晨三点的现象是"bot 一句话不说、日志只有 API key not found"，
排查成本远高于本单的收益。这条必须写进 finding 的 commit body 与 README。**

### 1.4 `.gitignore` 到底补哪几行才够

**两仓都要加（顺序无关，纯追加）：**

```gitignore
# ---------- 通用密钥兜底（不依赖"记得给每个新文件加一条"） ----------
.env
.env.*
!.env.example
*.pem
*.key
*.pfx
*.p12
id_rsa*
id_ed25519*
*credentials*.json
*secrets*.json
```

**裁定要点（我逐条实测过，不是抄的）：**

1. **`!.env.example` 不是可选项**：`.env.*` 会把 `.env.example` 一起吞掉，示例文件就进不来了。
   必须紧跟一条否定规则。
2. **不会误伤已跟踪文件**：我拿每条规则去比 `git ls-files`，两仓命中数**全为 0**
   （`*.key`/`*.pem`/`id_rsa*`/`*credentials*.json`/`*secrets*.json`/`*.p12`/`*.pfx` 逐条查过）。
   ⇒ 可以放心加，不会出现"加了规则导致某个已入库文件突然算改动"的假象。
3. **`keys.json` 两仓区别**：mindcraft 已被 `.gitignore:9` 覆盖，**不要重复加**；
   根仓**没有** `keys.json`（该文件只存在于 mindcraft），206 表里把根仓的 `keys.json` 列为
   `[不忽略]` 技术上成立但**是噪音**，建议从证据里删掉，免得后人以为根仓真有一把 key。
4. **`.mindserver-token` 建议保留，但要标清性质**：我查了 `src/mindcraft/auth_gate.js`，
   当前 token 是 `crypto.randomUUID()` **每次启动现生成**，经 cookie / `process.env.MINDSERVER_TOKEN`
   传递，**没有任何 `.mindserver-token` 文件**。所以这行是**面向未来的**（`F-SEC-205` 正是要
   把 token 落到本地 gitignore 文件），不是"既有约定"。**别在 commit body 里写成"已存在的文件"**。
5. **一个必须提醒的 gitignore 语义**：规则对**已跟踪**文件无效。当前两仓实测都无已跟踪敏感文件，
   所以加规则即生效；但若将来某人先提交了 `.env` 再加规则，**不会**把它踢出跟踪，
   得 `git rm --cached`。写进 body 一句话即可。
6. **206 不要把 `server/ops.json`/`whitelist.json` 一起加**——侦察兵自己也说了，那是 204 的范围。
   赞同：一个 commit 只解决一个 finding。

---

## 2. `F-SEC-202`：RCON 绑 `0.0.0.0:25575`

### 2.1 我独立核证了什么

```
server/server.properties：
  enable-rcon=true / rcon.port=25575 / server-ip=（空） / server-port=25565
  online-mode=false / white-list=true / enforce-whitelist=true / broadcast-rcon-to-ops=true
  rcon 相关键**只有**：enable-rcon、rcon.password、rcon.port、broadcast-rcon-to-ops
  → grep -niE "rcon.*(ip|bind|host)" 只命中 rcon.password 那一行 = **没有独立绑定参数** ✅

config/network.json：servers.main.bind = "all"   ✅（且注释写明"主服要绑所有网卡（局域网/手机能连）"）
bot 连接目标：mindcraft/settings.js:3  "host": "127.0.0.1"   ✅（本地）
rcon_client：rcon() 的 host 默认 '127.0.0.1'；rconOptsFromBot 用 sock.remoteAddress 兜底 ✅
面板：web/src/views/SetupView.vue:247-249 **只显示** RCON 的 port/enabled/hasPassword ⇒ 不连 RCON ✅
server-net.mjs：存在于 mindcraft/tools/（**不是**根 tools/），只写 server-ip 与 white-list 类键，
  **全文没有任何 rcon 相关代码** ✅
```

### 2.2 裁决：`server-ip=127.0.0.1` **确实能关掉暴露**，但"最小改动、不动玩法"**不成立**

**成立的半句**：Minecraft 的 RCON 监听地址跟着 `server-ip` 走（`server.properties` 里没有
独立 rcon 绑定键，我上面实测确认了）。把 `server-ip` 收成 `127.0.0.1`，RCON 必然只在 loopback。
侦察兵对机制的判断是**对的**。

**不成立的三点（这才是要改 commit 的地方）：**

1. **它同时把游戏端口 25565 收到 loopback ⇒ 手机/局域网直接连不上服。**
   而 `config/network.json` 存在的**唯一理由**就是"主服要局域网/手机能连"（文件注释原文）。
   ⇒ 这不是"不动玩法"，这是**砍掉主玩法**。侦察兵把它列为"第 1 条最小改动"是排错了优先级。
2. **单子第 2 条"若必须保留局域网玩就单独把 RCON 关掉"在 `server.properties` 层面做不到**
   —— 没有独立 rcon 绑定键（已实测）。它接着说"写进 `config/network.json` 的 apply 逻辑"，
   但 `server-net.mjs` **全文没有 rcon 代码**，现有工具无法实现"绑 all 但 RCON 只走本机"。
   ⇒ 这句话是**不可执行的建议**，必须删掉或改写，否则 patch-smith 会照抄一个做不出来的方案。
3. **`config/network.json` 会变成谎言**：若手工把 `server.properties` 改成 `127.0.0.1` 而
   `network.json` 仍写 `bind: "all"`，两个来源不一致（该文件自称"单一真相源"）。
   下次谁跑 `server-net.mjs apply` 就会把 `server-ip` 又改回空 ⇒ **修好的洞被一键还原**。
   这条尤其危险：**修完当天有效，下次切配置就复发。**

### 2.3 我建议的正确修法（按"既关暴露又不砍玩法"排序）

**首选：用 Windows 防火墙拦 25575 入站，`server.properties` 一个字节都不改。**

```powershell
# 管理员 PowerShell / cmd（一次性，换机需重做）
netsh advfirewall firewall add rule name="deny-rcon-25575-in" dir=in action=block protocol=TCP localport=25575
```

为什么这是**唯一同时满足两个约束**的解（依据：Windows 防火墙不检查 loopback 流量）：

- 局域网来的 25575 → 被丢弃 ⇒ **外网/同网段彻底摸不到 RCON**；
- 本机 `127.0.0.1:25575` → 不受防火墙影响 ⇒ **bot 的 RCON（proc_control 停止/重启、
  `query_target`、若干 `tools/*.mjs`）照常工作**；
- 25565 不动 ⇒ **手机/局域网照常能玩**；
- 不产生"单一真相源"冲突（改的是系统策略，不是仓库文件）。

**验证方法必须写对**（侦察兵的第 1 条判据会误判）：`netstat | findstr :25575` 仍会显示
`0.0.0.0:25575 LISTENING` —— **这是正常的**，防火墙拦的是入站数据包，不改变监听地址。
真正的判据是**从另一台机器**测：`Test-NetConnection -ComputerName <本机LAN IP> -Port 25575`
应失败；本机 `Test-NetConnection 127.0.0.1 -Port 25575` 应成功。

**代价必须写清**：防火墙规则**不入库、换机/重装即失效**，属"部署硬要求"，
要写进 README 部署段 + 在本 finding 的 commit body 里标明"这不是仓库内可验证的修复"。
**诚实地说：这意味着 F-SEC-202 的修复无法用 `git diff` 证明，只能用人/机器实测证明。**

**次选（若用户愿意牺牲手机联机）**：把 `config/network.json` 的 main.bind 改 `"localhost"`，
跑 `node tools/server-net.mjs apply`（单一真相源，工具会先备份）。此时 RCON 与游戏端口
一起收本机，**两个来源一致，不会复发**。

**不推荐：`enable-rcon=false`。** 我查了消费者：`src/mindcraft/proc_control.js`（用它做 `stop`）、
`query_target.js`、`server_props.js`，以及 `tools/rcon.mjs`、`probe_flat.mjs`、`repro_stuck.mjs`、
`inv.mjs`、`bench_live_nav.mjs`。关掉 RCON 会打断"停服/重启"与一批探针，属于功能性破坏。

**顺手可做（零风险、不砍玩法、纯配置）**：`broadcast-rcon-to-ops=true` → `false`。
现在 341 个 op 都在，RCON 命令会回显到 op 聊天里，等于把运维动作广播给所有人看。
这不在本单范围，建议单开一条 low 单。

---

## 3. `F-SEC-204`：冒名登录——"用户已明知并权衡过"能否成立？

### 3.1 我独立核证了什么

```
server.properties：online-mode=false / server-ip=（空） / white-list=true / enforce-whitelist=true  ✅
server/ops.json：341 条，**全部 level 4**；whitelist.json：仅 1 条 = HEAVENZEH
HEAVENZEH 本人是否 op：false（341 个 op 全是测试 bot）                                          ✅
两个文件都被 git 跟踪（git ls-files server/ 命中），且各自历史只有 **1 次提交**（快照性质）        ✅
profiles/my-local.json:6  "owner": "HEAVENZEH"                                                  ✅
mindcraft/settings.js:19  激活的正是 ./profiles/my-local.json                                    ✅
该 profile 被 .gitignore:55 忽略（profiles/*-local.json）→ 名单本身没入库                       ✅（好）
config/network.json:players = ["HEAVENZEH"] → **这个名字本身在入库文件里**                        ✅（放大器）
```

### 3.2 裁决一："用户已明知并权衡过"——**成立，有三处书面证据**

1. `config/network.json` 的 `_为什么需要这个文件` 原文：
   "绑所有网卡方便但离线模式下**任何人都能冒用 op 名字进服**（ops.json 里有 341 个 bot 账号）"
2. `mindcraft/tools/server-net.mjs` 头部注释重复了同一段权衡。
3. `server-net.mjs` 在 `bind === 'all' && whiteList !== true` 时会**运行期告警**：
   "离线模式下任何人都能冒用任意名字（含 op 名）进服"。

⇒ **这不是"配置写错了"，也不是 agent 发现的意外**，而是一个**被写下理由的、用户主动选择的取舍**。
这条判断我完全同意侦察兵，并且能给出证据链，不是转述用户口头说法。

### 3.3 裁决二：**但那个权衡的前提里有一处事实错误，必须纠正**

`server-net.mjs` 头部写着：

> "★ 关键认知：**真正的安全边界是白名单，不是绑定地址。**…开了 white-list 之后
> 只有名单里的人能进 —— **冒用名字就没用了**。"

**这句话在"多名字白名单"下成立，在"白名单只有一个名字"下不成立。**

白名单挡的是"**不在名单上的名字**"；而攻击者要做的恰恰是**冒用名单上那唯一一个名字**
（HEAVENZEH）。这一步白名单**完全不起作用**——它只会热情地把"HEAVENZEH"放进来。
而且**离线模式下没有第二道校验**（没有密码、没有正版校验，服务端只认客户端自报的名字）。

⇒ 用户以为自己留有"白名单这道防线"，实际上那道防线只拦"别人"，**不拦"伪装成你"**。
这是本次预审里我认为**最重要的一条**：不是新技术风险，而是**一个被写进代码注释的错误安全感**，
它会让人长期不去修真正该修的东西。建议：把 `server-net.mjs` 与 `config/network.json` 里
那句"冒用名字就没用了"**改掉**（属注释级改动，零行为风险），否则它会继续骗下一个人。

### 3.4 裁决三：真实后果比单子写的**更重**（这条要升级严重度）

单子说"主人身份 ⇒ 指令权限/位置信息/能指挥 bot"。实测更具体：

- `src/agent/permissions.js` 的等级由 `profile.permissions.owner` **按名字**比对（区分大小写）；
- 该 profile 里 `"owner": "HEAVENZEH"` ⇒ 冒用该名字 = **OWNER 级**；
- `OWNER_ONLY_COMMANDS` 含 **`!newAction`（在 SES 沙箱里写代码执行）**、`!restart`、
  `!attackPlayer`、`!discard`、`!givePlayer`、`!addJob`，以及白名单斜杠命令。

⇒ **冒名者拿到的不只是"聊天权限"，而是"让 bot 执行任意代码"的入口**（`!newAction`）。
这已经越过"信息泄露"，进入"代码执行"档。建议 `severity: medium → high`，
理由：`online-mode=false` + `bind=all` + `owner` 名字公开（`config/network.json` 入库）
⇒ 前置条件只有"能连到 25565"，而同网段即可。

**同时要诚实说明一个减轻因素**：HEAVENZEH 本人**不是 op**（341 个 op 全是 bot），
所以冒名者拿不到 MC 服务器管理权（`op`/`stop`/`fill`）；他拿到的是 **bot 的 owner 权**。
要拿服务器管理权得走 RCON（那是 F-SEC-202 的链）。**两条链合起来才是"完全接管"**，
单看 204 是"控制 bot 与主人身份"，单看 202 是"接管服务器"。这个区分要留在单子里，
免得夸大后被打回。

### 3.5 给用户的一句话（可直接转给用户，我已按"能签字"的标准写）

> 你这台服的准入其实是"离线模式 + 白名单只有 HEAVENZEH 一个名字"。离线模式下服务端不做正版校验、
> 只认客户端自己报的名字，所以**任何人把游戏名改成 HEAVENZEH 就能当"你"进服**——
> 白名单在这里不是防线，因为它只会把"HEAVENZEH"放进来。
> 进来之后拿到的是 bot 的**主人权限**，其中包括 `!newAction`（让 bot 执行代码）——
> 也就是说，同网段的人不需要破解任何东西，改个名字就能让 bot 替他干活。
> 这是我们**没法替你决定**的事，因为它直接和你"手机/局域网随时能连"的便利性冲突。三条路，选一条：
> **① 不玩时停服**（最省事，暴露窗口最小，什么都不用改）；
> **② 接受冒名风险，但把服务器收回本机**（`bind=localhost`，牺牲手机联机，换来只有本机能连）；
> **③ 装登录插件**（离线模式 + 密码登录，能保住手机联机，但要新增插件——今晚红线不允许，需你另行同意）。
> 在①②③之间，我们**不会替你选**；但在你选之前，建议先做一件零代价的事：
> 把 `ops.json`/`whitelist.json` 从 git 里移除（它们是运行期状态，入库等于公开 341 个 bot 名 + 你的名字）。

### 3.6 对 204 suggested_fix 的逐条裁定

| 单子建议 | 我的裁定 |
|---|---|
| ① 在 `config/network.json` 加 `_剩余风险` 告警字段 | ✅ **采纳**，零行为变化。但**必须同时改掉那句错误的"冒用名字就没用了"**（见 3.3），否则加了告警还留着假安慰 |
| ② `ops.json` 收敛 341 个 op / 从 git 移除 | ⚠️ **拆成两件事**：从 git 移除（`git rm --cached` + .gitignore）**可做、低风险**；但**改 ops 内容不建议 agent 做**——它是运行期状态、无测试基准、改错会让用户失去某些 bot 的 op（且历史只有 1 次提交，说明长期没动过，属"用户既有状态"）。**只备份 + 提醒**，与侦察兵结论一致 |
| ③ a. AuthMe 插件 / b. `online-mode=true` / c. 收回 `127.0.0.1` | ✅ 三条方向都对，且侦察兵正确地标了"需用户同意"。补充：**c 的代价是砍掉手机联机**（同 202），必须明说，不能写成"只是更安全" |
| ④ `mindcraft/settings.js` 的 `"auth": "offline"` 无需改 | ✅ 同意（与服务端一致，改它反而错） |

---

## 4. 两条"跑题但必须说"的现场异常

### 4.1 ⚠️ 我自己的操作失误（主动报告）
核证 F-SEC-202 时我用 `grep -nE "^rcon" server/server.properties` 想确认键名，
**把 `rcon.password` 的明文打进了本次会话输出**（本应只 grep 键名、排除 password）。
该值因此多留存在一份 agent 会话记录里。
**处置建议**：这正是 `F-SEC-203`（口令在 5 处明文副本）要解决的问题——
本机这把 RCON 口令的轮换优先级应从"建议"提到"今晚就换"。
我未把它写进任何文件，也不会在后续报告里重复该值。这是我的失误，记录在此。

### 4.2 captain 说"421 个 M 已 reset 清掉"——**我这边实测仍在**
```
$ git -C mindcraft status --porcelain=v1 | awk '{print $1}' | sort | uniq -c
      1 ??
    421 M
```
与你上一轮的判断一致（`git diff` 为空、porcelain v2 两侧 blob sha 相同 ⇒ 纯 stat 缓存），
但 **`git reset` 并没有清掉它**（`git reset` 重置的是 index 到 HEAD，不动这些 stat 缓存；
真正能清的是 `git update-index --refresh`（我试过返回 1 未清）或重建 index）。
**影响**：修补组若用 `git status` 判"工作区干净"会看到 421 个 M；用 `git add -A` 提交会把
这些条目一并纳入（虽然内容相同，但会在 commit 里出现 421 个文件的噪点，且极易夹带别人的改动）。
**建议**：提交一律逐文件显式 `git add <file>`（PLAYBOOK §7 已禁 `-A`），
并在需要"干净树"判据时改用 `git diff --quiet && git diff --cached --quiet`（内容判据，不信 stat）。

---

## 5. 预审结论（给 captain 的三句话）

1. **`F-SEC-206` 先做、`F-SEC-201` 后做** 成立，但要改 commit body 的理由；
   **真正必须盯的是"用户 setx → 新进程验证 → 才清 keys.json"这三步，跳步会让模型全挂。**
2. **`F-SEC-202` 的首选修法选错了**：`server-ip=127.0.0.1` 会连游戏端口一起收、砍掉手机联机，
   且下次 `server-net.mjs apply` 会把它改回去（复发）。**首选应是 Windows 防火墙拦 25575 入站**
   （loopback 不受防火墙影响 ⇒ bot 照常，手机照常）。必须接受一个代价：这条修复**无法用 `git diff` 证明**。
3. **`F-SEC-204` 的"用户已明知"成立、有三处书面证据；但项目注释里"开白名单后冒用名字就没用了"
   是错的**（单名字白名单挡不住冒用那唯一一个名字）。且后果比单子写的重——
   `owner: HEAVENZEH` ⇒ `!newAction`（代码执行）。建议 **severity 升 high**，
   并把"纠正那句注释"加进本单修法。
