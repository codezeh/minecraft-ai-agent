id: F-SEC-204
severity: high
class: authz
file: config/network.json:12
evidence: |
  主服是"离线模式 + 只绑名字白名单"的组合，而白名单只有 1 个名字、op 名单里有 341 个 bot。

  $ cd "E:/我的世界ai" && node -e "
      const n=require('./config/network.json');
      console.log(JSON.stringify(n.servers.main,null,1));"
  { "bind": "all", "whiteList": true, "enforceWhiteList": true,
    "onlineMode": false, "players": ["HEAVENZEH"] }

  $ grep -nE "online-mode|white-list|enforce-whitelist|server-ip" server/server.properties
  38:online-mode=false
  54:server-ip=                     ← 绑所有网卡
  64:white-list=true
  17:enforce-whitelist=true

  $ node -e "const ops=require('./server/ops.json'); const wl=require('./server/whitelist.json');
      console.log('ops:',ops.length,'| whitelist:',wl.length,'| 真实玩家是 op?',ops.some(o=>o.name==='HEAVENZEH'));"
  ops: 341 | whitelist: 1 | 真实玩家是 op? false
  ops 前 3 条: v57665(lvl4), tgt2207(lvl4), s2bench914(lvl4)   ← 全是测试脚本刷出来的 bot

  两个文件都被 git 跟踪（公开仓会看到清单）：
  $ git ls-files server/ | grep -E "ops.json|whitelist.json"
  server/ops.json
  server/whitelist.json
exploitability: |
  离线模式（online-mode=false）下 Minecraft **不做正版校验**，服务端只认客户端自己报的名字
  ⇒ 任何人把客户端用户名改成 `HEAVENZEH` 就能以主人身份进服（白名单只校验名字，不校验密码）。
  能拿到什么：主人身份 ⇒ 私聊/指令权限/位置信息/能指挥 bot（权限模型里 owner 级 = 最高）；
  以及"主人"看到的、bot 记得的一切。
  另一条更远的：`ops.json` 里 341 个 lvl4 op 账号存在但**没进白名单**，所以现在登不进来；
  一旦 `whiteList` 被关（`config/network.json` 的 test 段默认就是 `whiteList:false`，
  切换 main→test 的配置只要改一个字），这 341 个名字全部变成可登录的 **op 账号** —— 等于后门池。
  且 `ops.json` 入库意味着任何能看仓库的人拿到全部 bot 名清单（用户名即凭据，离线模式下尤其致命）。
  影响半径：主人身份 / 服务器管理权。前置条件是能连到 25565（bind=all 时同网段即可）。
  诚实说明：这是用户在 `config/network.json` 里**明确权衡过的**设置（文件里写着理由：
  "绑所有网卡方便，离线模式下任何人都能冒用 op 名字进服"）。所以本条不是"配置写错了"，
  而是"风险被写下来了但仍没有任何缓解手段"——需要用户拍板。
suggested_fix: |
  先明确：**这需要用户拍板**（改 online-mode 会影响"手机/局域网随便连"的便利性）。
  patch-smith 能做、且不改变玩法的部分：
  1. 在 `config/network.json` 的 main 段加显式告警字段（纯注释式，不改变行为）：
     `"_剩余风险": "离线模式 + 白名单按名字 ⇒ 冒用 HEAVENZEH 即可接管主人身份。缓解见 docs/audit/night/..."`，
     让下一次改配置的人看得见。
  2. `ops.json` 收敛：把 341 个测试 bot 的 op 清成 0 级或移出 ops.json（**这是运行时状态文件、
     不在本夜红线里但没有测试基准，建议只做备份 + 提醒用户**，不要擅自改）；
     同时把 `server/ops.json`、`server/whitelist.json` 从 git 跟踪里移除（`git rm --cached`），
     改成 `server/*.json.example` + .gitignore —— 它们是运行期状态，不是配置源码。
  3. 真正的修法（需用户同意，且属"改身份体系"）：
     a. 想保持便利 → 用 **AuthMe/类似登录插件**（离线模式 + 密码登录）—— 新增插件，本夜红线不允许；
     b. 或 `online-mode=true`（正版校验）—— 但 bot 全部要真账号，不现实；
     c. 或维持现状但把 bind 收回 `127.0.0.1`，只在需要局域网联机时临时切（`tools/server-net.mjs`）。
  4. `mindcraft/settings.js` 里 `"auth": "offline"` 与服务器一致，无需改。
verify: |
  cd "E:/我的世界ai"
  # 1) 运行期状态文件不再被 git 跟踪
  git ls-files server/ | grep -E "ops.json|whitelist.json"; echo "exit=$?"
  # 期望：无输出（已被 .gitignore + git rm --cached 移出）
  # 2) 冒用名字仍然会被挡（这是"白名单仍生效"的正向对照，不是要求改行为）
  #    人工：用非白名单名字连服 → 应被踢；用 HEAVENZEH 连 → 能进（说明风险仍在，需用户决策）
  # 3) 配置里留下了显式告警
  node -e "const n=require('./config/network.json');
    const ok = JSON.stringify(n.servers.main).includes('冒用');
    console.log(ok?'OK 已标注剩余风险':'FAIL 未标注'); process.exit(ok?0:1)"
discovered_by: recon-scout
dept: D2-SEC

---

## review（gate-keeper 预审 · 2026-11-06 02:0x）

**裁决：成立，且严重度上调 `medium → high`（captain 已批准）。配套单：`F-SEC-208`（注释纠错，low）。**

### 1. 我独立核证过的事实（逐条重跑，与侦察兵一致）
```
server.properties: online-mode=false / server-ip=(空) / white-list=true / enforce-whitelist=true  ✅
server/ops.json: 341 条，全部 level 4；whitelist.json: 仅 1 条 = HEAVENZEH                     ✅
HEAVENZEH 本人是否 op: false（341 个 op 全是测试 bot）                                          ✅
ops.json / whitelist.json 均被跟踪，各自历史仅 1 次提交（快照性质）                              ✅
profiles/my-local.json:6  "owner": "HEAVENZEH"                                                  ✅
mindcraft/settings.js:19  激活的正是 ./profiles/my-local.json                                    ✅
config/network.json: main.players = ["HEAVENZEH"]（**名字本身入库**）                            ✅
```

### 2. 为什么升到 high（本机后果比原描述更重）
`src/agent/permissions.js` 的等级由 `profile.permissions.owner` **按名字**比对（区分大小写），
而该 profile 写的是 `owner: "HEAVENZEH"` ⇒ **冒名者 = OWNER 级**。
`OWNER_ONLY_COMMANDS` 含 **`!newAction`（在 SES 沙箱里写代码执行）**、`!restart`、`!attackPlayer`、
`!discard`、`!givePlayer`、`!addJob` 及白名单斜杠命令。

⇒ 冒名者拿到的**不只是"主人身份/信息"，而是"让 bot 执行任意代码"的入口**。
前置条件只有"能连到 25565"，同网段即可，不需要破解任何凭据（离线模式无第二道校验）。

### 3. 必须如实保留的减轻因素（别夸大成"服务器被接管"）
- **HEAVENZEH 本人不是 op**（341 个 op 全是测试 bot）⇒ 冒名者**拿不到 MC 服务器管理权**
  （`op`/`stop`/`fill` 都做不到）。
- 要拿服务器管理权得走 **RCON**（那是 `F-SEC-202` 的链）。
- ⇒ **单看 204 = 控制 bot + 主人身份 + 代码执行入口；单看 202 = 接管服务器；
  两条链合起来才是"完全接管"。** 早报按这个分寸写，不要合并夸大为单一结论。

### 4. 对原 `suggested_fix` 的逐条裁定
| 原建议 | 裁定 |
|---|---|
| ① `config/network.json` 加 `_剩余风险` 告警字段 | ✅ 采纳（零行为变化）。**但必须同时改掉 `server-net.mjs` 那句错误论断** → 已另立 `F-SEC-208` |
| ② `ops.json` 收敛 341 个 op / 从 git 移除 | ⚠️ **拆成两件事**：`git rm --cached` + .gitignore **可做、低风险**；但**改 ops 内容不应由 agent 做**（运行期状态、无测试基准、历史仅 1 次提交 = 用户既有状态）⇒ **只备份 + 提醒** |
| ③ a. 登录插件 / b. online-mode=true / c. 收回 `127.0.0.1` | ✅ 三方向都对且已标"需用户同意"。**补充**：c 的代价是**砍掉手机/局域网联机**（见 `F-SEC-202` 复核），不能写成"只是更安全" |
| ④ `settings.js` 的 `"auth": "offline"` 无需改 | ✅ 同意（与服务端一致，改它反而错） |

### 5. 关闭条件（这条单子怎样才算修好）
**不能只看代码改动**——它本质是**用户决策**（便利 vs 安全）。关闭条件二选一：
- (a) 用户明确选择并落地了某一缓解（收回监听 / 登录插件 / 不玩时停服），**且**本单的
  `config/network.json` 告警字段已就位、`ops.json`/`whitelist.json` 已从 git 移除；
- (b) 用户**书面**接受该剩余风险（写进 `docs/audit/night/NIGHT-REPORT.md` 待用户清单），
  由 captain 标记 `accepted-risk` 并归档。
> 未经 (a)/(b) 不得把本条移入 `verified/`。

---
resolution: partially-delivered + blocked（patch-smith · D2 修补）
已做（零行为变化的两件）: |
  1. `config/network.json` 的 `servers.main` 增加 `_剩余风险` 字段（含"冒名 HEAVENZEH 即可拿到 OWNER 级权限"与三条缓解），
     verify 判据 `JSON.stringify(main).includes('冒用')` → **OK**。
     注：顺带把该文件第 5 行"开白名单（只有你能进）"的错误论断改掉了 —— 那是 F-SEC-208 的范围，
     两处都在同一文件，提交时可用 `git add -p` 分开，或合并提交（body 同列 204+208）。
需 captain 代为执行（我用不了 git）: |
  `git rm --cached server/ops.json server/whitelist.json` + 在 `.gitignore` 加这两条，
  并补 `server/ops.json.example` / `server/whitelist.json.example`（内容同当前，仅作形状示例）。
  **不移除工作区文件**（它们仍在磁盘上供服务器读取）。
  ⚠️ 这条与 F-DEP-103 是同一类问题：`server/` 下的运行期状态不该进版本库；但**改了也没法由我提交**。
blocked（需用户拍板）: |
  三选一（都会影响"手机/局域网能不能连"，必须用户定）：
  A 收回监听 `bind: localhost`（牺牲局域网/手机）；B 加登录插件（离线模式+密码，新增插件=红线外）；
  C 维持现状 + 书面接受风险（写进 NIGHT-REPORT 待用户清单，由 captain 标 accepted-risk）。
  关闭条件（复核席 204 §5）：(a) 用户落地某一缓解 **且** 告警字段+git 移除都已就位；或 (b) 用户书面接受。
  未经 (a)/(b) 不得移入 verified/。
未做（有意）: 未改 `ops.json` 的 341 条 op（运行期状态、无测试基准、历史仅 1 次提交 = 用户既有状态）
  ⇒ 只备份 + 提醒，不擅自改。

## review（gate-keeper · t14 · 2026-11-06 02:4x）
**结论：通过（partially-delivered + blocked 定性准确）。** commit：见 config/network.json 改动。

核证：
```
node -e 读 config/network.json → JSON 合法；main keys = _说明,_剩余风险,bind,nic,whiteList,enforceWhiteList,onlineMode,players
含"冒用"标签: true
```
- `_剩余风险` 字段已在位、JSON 可正常解析 ✅（patch-smith 自报的"引号写错后修正"确实修好了，我验的是能 parse）
- blocked 理由成立：三条修法都影响"手机/局域网能否连"，属用户决策（我 t13 复核 `F-SEC-202` 时也独立得出同一结论）。
- **未越权**：没有擅自改 `online-mode` / 白名单 / `ops.json` 内容 ✅（我 t13 已确认 ops.json 无改动痕迹）。
裁定：**通过**。关闭条件仍需用户三选一，见该文件 `## review`（D1 轮我写的 204 复核段仍适用）。
