# 审计⑨ · 实证：把「机制明确、现场未复现」的判断跑出来

> 工作目录 `E:\我的世界ai`。**未修改 `mindcraft/` 任何文件**（`git status` 为空，见文末）。
> **未启动 Minecraft 服务端**（它本来就在跑，我只做只读探测）。
> 唯一写入：`docs/audit/09-empirical.md` 与 `docs/audit/probes/**`（探针脚本，按任务要求留存）。
> 审查时刻：2026-11-05 17:00~17:12。Node **v24.16.0** / win32。

## 0. 结论速览

| # | 待验断言 | 判定 | 一句话依据 |
|---|---|---|---|
| P1 | 前几轮"EPERM 拦 spawn"与"npx 能跑"的矛盾 | **本环境：spawn 全被拦** | `execFileSync`/`execSync`/`spawn`/`npx` 全部 `EPERM`，见 §1 |
| P2 | B5「一次 SQLITE_BUSY 就删库」 | **机制成立，但破坏性需放宽** | BUSY 确实进入"当坏库→改名/删"分支（`rebuilt=true, error="database is locked"`）；但实测那一刻 Windows 锁住文件，`rename/rm` 都失败 → **当次数据侥幸保住**。另测出**更易触发的同类路径：schema 不匹配也删库** |
| P3 | `skills.js:5750` 的 `ok` 必崩 | **成立（实测 ReferenceError）** | stub bot 让 digTunnel 走到正常返回 → `ReferenceError: ok is not defined` |
| P3 | `modes.js:118/126/133` 的 `placed/walked` | **成立，但影响比报告写的小** | 三处变量确实未声明；但 `execute()` 用 try/catch 吞掉 → **不崩进程，只是灭火永不生效** |
| P3 | `npc/item_goal.js:163` 的 `res` | **成立（作用域已证明）** | `let res` 在第 141 行 `getNext()` 里；`execute()`(154-172) 内无声明 → 严格模式必抛 |
| P4 | 「`unit_all` 打印 0/64」 | **成立，但原因是环境不是测试** | `unit_all.mjs:125` 用 `execFileSync` 拉起每个子脚本 → 本环境 EPERM → 64 个全部 `exit error` |
| P4 | board 测试「一条用例都没跑到」 | **不成立** | 13 个 board unit 直跑：11 个 exit=0 全绿（**170** 用例）+ 2 个功能段全 PASS（18 用例）= **188 用例全部通过、0 条断言失败**（见 §4.2） |
| P4 | preflight §6 失败 | **成立，但仅此一处** | 7 段里 6 段绿，只有 `[6/6]` 因自测子进程 spawn 不起来而"不可信"（它按设计 fail-closed） |
| P5 | README「1.41 格/秒 / 302 格推进 168 格」 | **不可复算** | 从 55 个 artifact、3484 条记录重算：**没有任何 ≥250 格的场景，也没有任何聚合值=1.41**；`long-route` n=17 = **56.1 格 / 18.0 s = 3.12 格/秒** |
| P6 | 面板 socket 零认证 | **静态确证，无法实弹** | 8080 当前**无 listener**（mindserver 未跑）；按任务要求不启动它 |
| P6 | `create-agent` 路径穿越 | **成立（已解析到具体绝对路径）** | `name='../../pwn'` → `E:\我的世界ai\pwn\last_profile.json` |
| P6 | RCON 对局域网监听 | **成立（复核仍在）** | `0.0.0.0:25575` + `[::]:25575` LISTENING |

---

## 1. P1 环境能力表（这台机器、当前沙箱）

探针：`docs/audit/probes/p1_env.mjs`　运行：`node docs/audit/probes/p1_env.mjs`

```
--- ENV ---
node v24.16.0 | platform win32 | cwd E:\我的世界ai
--- TABLE ---
PASS spawn node -e                            status=null out= err=        ← 见下方说明
FAIL spawn (async, stdout pipe)               EPERM spawn EPERM
FAIL execFileSync                             EPERM spawnSync D:\Node\node.exe EPERM
FAIL execSync (shell)                         EPERM spawnSync C:\Windows\system32\cmd.exe EPERM
FAIL npx eslint --version                     EPERM spawnSync C:\Windows\system32\cmd.exe EPERM
FAIL node tools/audit_codes.mjs               EPERM spawnSync D:\Node\node.exe EPERM
FAIL mkdir+write mindcraft/bots/_p1probe      EPERM EPERM: operation not permitted, mkdir 'E:\mindcraft\bots\_p1probe'
PASS mkdir+write os.tmpdir()                  C:\Users\zeh\AppData\Local\Temp\dsh-FMppzm\p1-TbVtEH
PASS mkdir+write docs/audit/probes/           ok
FAIL write 到盘符根（仓库外）                 EPERM EPERM: operation not permitted, open 'E:\p1_outside_probe.txt'
PASS net.connect 127.0.0.1:25565 (MC)         open
PASS net.connect 127.0.0.1:25575 (RCON)       open
FAIL net.connect 127.0.0.1:8080 (mindserver)  closed/ECONNREFUSED
PASS node:sqlite DatabaseSync                 n=1 node=v24.16.0
```

（第 1 行 `status=null` 是同一件事的另一种表现：`spawnSync` 被拦后 status 为 null、stderr 为空。）

### 1.1 能力边界（这张表解释了后面所有"跑不动"）

| 能力 | 可用性 | 真实报错 |
|---|---|---|
| **node 起子进程**（`spawn`/`spawnSync`/`execFileSync`/`execSync`） | ❌ **全部 EPERM** | `EPERM spawn EPERM` / `EPERM spawnSync D:\Node\node.exe EPERM` |
| `npx` / 任何 shell 调用 | ❌ EPERM | `EPERM spawnSync C:\Windows\system32\cmd.exe EPERM` |
| **shell 里直接 `node xxx.mjs`**（由 ops_bash 起进程） | ✅ 可用 | 本文所有测试都是这样跑的 |
| 写 `docs/audit/probes/`（本任务授权目录） | ✅ | `ok` |
| 写 `os.tmpdir()`（**仅** `dsh-*` 前缀目录） | ✅ | `C:\Users\zeh\AppData\Local\Temp\dsh-FMppzm\...` |
| 写 `mindcraft/bots`、`mindcraft/tmp` | ❌ **EPERM** | `mkdir 'E:\我的世界ai\mindcraft\bots\_p1probe_...'` |
| 写盘符根（仓库外） | ❌ EPERM | `open 'E:\p1_outside_probe.txt'` |
| `net.connect` 本地端口 | ✅ | 25565/25575 `open`；8080 `ECONNREFUSED` |
| `node:sqlite`（`DatabaseSync`） | ✅ | `n=1` |

### 1.2 对前几轮矛盾现象的解释（这条很重要）

* **t4 说 `execFileSync` 被 EPERM 拦住** → **正确**，本环境复现：`EPERM spawnSync D:\Node\node.exe EPERM`。
* **t8 说它的环境里 `npx eslint` 能跑** → **在本沙箱不成立**（`EPERM spawnSync cmd.exe`）。
  两者不矛盾，是**不同成员拿到的沙箱能力不同**。所以任何依赖"起子进程"的结论都必须在报告里
  标注"取决于沙箱"，不能当成项目事实。
* **推论**：凡是走 `child_process` 的门禁（`unit_all`、`preflight` 的 §6、`atom_all`）在本环境
  **必然失败**，而这个失败**与代码质量无关**。§4 给出绕行后的真实成绩单。

### 1.3 我用的绕行办法（后面每一节都依赖它）

`mindcraft/tmp` 与 `mindcraft/bots` 只读，而多数测试用**相对路径**写 `tmp/...` 或 `bots/...`。
办法：**cwd 换成可写目录，脚本用绝对路径** —— 这样相对路径的数据落到可写 cwd，
而 ESM 的 `import` 是相对模块文件解析的，不受 cwd 影响。

```bash
cd docs/audit/probes/run            # 可写
node "E:/我的世界ai/mindcraft/tools/board_store_unit.mjs"
```
实测代价：**有些测试用 cwd 相对路径读源码**（`readFileSync('src/agent/library/...')`），
在这个 cwd 下会 ENOENT —— §4.3 因此分两个 cwd 各跑一遍，才得出可信成绩单。

---

## 2. P2：`openBoard` 遇到 SQLITE_BUSY 会不会删库

**断言（审计② B5）**：`board_store.js:145-201` 的 `openBoard` 把所有异常当"库损坏"→ 改名/删除整份板库，
一次 `SQLITE_BUSY` 就能让整个任务列表蒸发。

### 2.1 实测方法

真实 `openBoard` 源码：`PRAGMA journal_mode=WAL`（包了 try/catch 忽略）→ `PRAGMA busy_timeout=5000`
（也包了）→ **`db.exec(SCHEMA)`（没包，是唯一能抛的点）**。SCHEMA 全是 `CREATE TABLE/INDEX IF NOT EXISTS`。

三个场景，全部用**真实** `openBoard`（探针直接 import 源码，不改一行）：

| 场景 | A 进程 | B 进程（`openBoard(同目录)`） |
|---|---|---|
| ① 无竞争 | — | 建库，`rebuilt=false` |
| ② WAL + `BEGIN IMMEDIATE` 持锁 9s | `p2_lockholder.mjs` | `p2_openboard.mjs` |
| ③ 切回 rollback journal + `BEGIN EXCLUSIVE` 持锁 10s | `p2_lockholder_exclusive.mjs` | `p2_openboard.mjs` |

### 2.2 真实输出

**场景①（基线）**
```
[B] 打开前 exists=false
[B] openBoard 正常返回（30ms）
[B]   rebuilt = false
```

**场景② WAL + BEGIN IMMEDIATE 持锁 9 秒 —— 没有 BUSY，没触发重建**
```
[A] BEGIN IMMEDIATE OK → 已持有写锁，保持 9000ms
[B] 打开前 exists=true size=45056
[B] openBoard 正常返回（1ms）
[B]   rebuilt = false
[B]   重建后 jobs 行 = [{"skill":"mine",...,"priority":5,...}]   ← 数据完好
[A] 释放写锁，共持有 9005ms
```
→ **原因**：WAL 下读不被写者阻塞；且 SCHEMA 全是 `IF NOT EXISTS`，表已存在时 `exec` 不需要写锁。
**所以"常规写事务"根本撞不到 BUSY**，t2 报告里这条需要收紧表述。

**场景③ EXCLUSIVE 持锁 10 秒 —— BUSY 命中，走了"当坏库"分支**
```
[A2] BEGIN EXCLUSIVE OK → 库级独占锁，保持 10000ms
[B] 打开前 exists=true size=45056
[B] openBoard 正常返回（8246ms）          ← 卡了 5s busy_timeout + 重试
[B]   rebuilt = true                       ← ★ 把「锁冲突」判定成「库损坏」
[B]   backup  = (none)                     ← ★ 改名失败，走了 rmSync 兜底
[B]   error   = database is locked         ← ★ 原始错误就是 SQLITE_BUSY 的文案
[B]   重建后 jobs 行 = [...]               ← 数据居然还在（见下）
[B] 打开后目录内容：["board.sqlite"]        ← 没有 .corrupt-* 备份文件
```
→ **关键**：`rebuilt=true` + `error="database is locked"` 证明**BUSY 确实被当成损坏**。
数据之所以还在，是因为那一刻 A 仍占着文件，Windows 上 `rename`/`rm` 都失败（落到 `catch{}` 静默），
随后 `tryOpen()` 重试时 A 恰好释放 → 打开的是**同一个文件**。
也就是说：**这一次不是"删库成功"，而是"判定成坏库但没能删掉"——两种都不是好结果。**

**对照场景（时序卡在 busy_timeout 内）**：A 持锁 5.2s、B 0.2s 进入 →
```
[B] openBoard 正常返回（5036ms）
[B]   rebuilt = false
```
→ 只要锁在 5 秒内释放就一切正常。**所以 BUSY 是否触发是一条 5 秒的边界，不是"必然"。**

### 2.3 意外收获：比 BUSY 更容易触发的同类路径 —— schema 不匹配也删库

第一次实验我误用了一个**只有 `jobs(id,state)` 两列**的假库，B 调 `openBoard` 得到：
```
[B] openBoard 抛出异常（29ms）
[B]   message = 任务板库损坏且重建失败：原始错误=no such column: priority；重建错误=no such column: priority
```
→ `no such column`（**schema 版本不匹配**）同样走"当坏库→改名→重建"路径，而且**不需要任何并发**。
这意味着：**任何一次 schema 升级（加列/改列）都会让旧库被当成坏的**。这条比 B5 原来的表述更容易触发。

### 2.4 判定

| 分句 | 判定 |
|---|---|
| "`openBoard` 把**所有**异常当库损坏" | ✅ **成立**（代码结构 + BUSY/schema 两条实测都进同一分支） |
| "一次 `SQLITE_BUSY` 就会触发该分支" | ⚠️ **需放宽**：必须是**独占锁/长事务超过 busy_timeout(5s)**；普通写事务（WAL + BEGIN IMMEDIATE）打不到 |
| "会**删掉**整份任务列表" | ⚠️ **需放宽**：进分支是确定的；**是否真删**取决于那一刻文件能否改名/删除。实测 Windows 上被占用时改名/删除都失败 → 数据侥幸保住（但已记为 `rebuilt=true`）。删成功的路径要看 `board_store.js:200-206` 的 `rmSync(f,{force:true})` 兜底 |

**复现命令**（留在 `docs/audit/probes/`）：
```bash
cd docs/audit/probes/run && rm -rf p2c
node "E:/我的世界ai/docs/audit/probes/p2_lockholder_exclusive.mjs" p2c 10000 & sleep 2
node "E:/我的世界ai/docs/audit/probes/p2_openboard.mjs" p2c
wait
```
**作者修完后应该看到**：`rebuilt = false`（或抛一个明确的"库忙，稍后重试"而不是"损坏"），
且目录里**不会**出现 `.corrupt-*`，`board.sqlite` 原文件与其中数据保持不变。

---

## 3. P3：6 处 ReferenceError 的真实可触发性

### 3.1 `skills.js:5750` `return ok({ steps: n, to })` —— **实测崩溃，成立**

静态事实：`ok` 在整个 `skills.js` 里**只作为调用出现 1 次**（`grep -c "return ok("` = 1），
既没有 `import { ok }`，也没有模块级 `function ok`（第 96 行的 `const ok = ...` 是另一个函数里的局部变量）。

运行时：用 stub bot 让 `digTunnel` 的 `runSteps` 正常返回（`run.ok === true`）→ 走到第 5750 行：
```
=== P3 结果 ===
P3-1   digTunnel 抛异常   ReferenceError: ok is not defined
```
探针：`docs/audit/probes/p3_reference_errors.mjs`
**判定：✅ 成立。** `skills.digTunnel` 只要挖成功就必抛 `ReferenceError`（不是"可能"，是必）。

### 3.2 `modes.js:118 / 126 / 133` `if (placed)` / `if (walked)` —— **成立，但影响要下调**

静态事实（`sed -n 110,140p`）：三处都写成
```js
const success = await skills.placeBlock(...);   // 赋值给 success
if (placed) say(...);                            // 却读 placed  ← 未声明
```
`placed` / `walked` 在整个 `modes.js` 里没有任何声明。

运行时：我用完整 stub agent 让 `ModeController.update()`（`modes.js:586`）真的跑进 `self_preservation`
的"身上着火"分支，实际观测到：
```
Mode self_preservation finished executing, code_return: TypeError: bot.entity.position.distanceTo is not a function
```
—— 说明**分支可达**，但 `skills.placeBlock` 需要真 bot 才能走完；我的 stub 在它内部就断了（连续补了
`distanceTo`/`gameMode`/`canHarvest` 仍未走完），因此**没能把执行点推进到 `if (placed)` 那一行**。
要真正触发需要真服务端 + 真 bot（本任务禁止启动服务端）。

**关键改判（比"会不会崩"更重要）**：`modes.js:466` 的 `execute()` 是
```js
try { code_return = await agent.actions.runAction(...) }
catch (err) { console.warn(`Mode ${mode.name} threw: ${err}`); ... }
```
→ **ReferenceError 会被这里吞掉**，只留一条 `console.warn`，**不会崩进程**。
后果是：**身上着火时"用水桶灭火"这个动作永远不会生效，且没人知道**（只有 console 一行 warn）。
所以这三处的严重度应低于 `skills.js:5750`（后者直接抛到调用方）。

### 3.3 `npc/item_goal.js:163-164` `res = await skills.attackNearest(...)` —— **成立（作用域已证明）**

```
137:    getNext(q=1) {
141:            let res = child.node.getNext(child.quantity);   ← 这里的 res 属于 getNext()
...
154:    async execute(quantity=1) {                              ← execute 从这里开始
...
163:                res = await skills.attackNearest(...)         ← execute 内没有任何 res 声明
164:                if (!res || ...)
```
`let res`(141) 在**另一个方法** `getNext()` 里；`execute()`(154-172) 内只有 `for (let i=...)`。
ESM 是严格模式 → 第 163 行必抛 `ReferenceError: res is not defined`。
且 `skills.attackNearest` 确实存在（`skills.js:695`），所以不会先被 TypeError 挡住。
**判定：✅ 成立（静态作用域已钉死）；触发需要 `type==='hunt'` 的 NPC 任务节点，本轮未跑真机。**

---

## 4. P4：把被 EPERM 挡住的东西跑出来

### 4.1 `unit_all.mjs`：0/64 的真因

```
$ cd mindcraft && node tools/unit_all.mjs
  ❌ scaffold_tracker_unit  (exit error)
  ...
  0/64 个脚本通过，1 个跳过
```
根因（不是测试坏了）：
```
$ grep -n "execFileSync\|spawn" tools/unit_all.mjs
17:import { execFileSync } from 'child_process';
125:        const out = execFileSync(process.execPath, [script], {
```
```
$ node -e 'try{require("child_process").execFileSync(process.execPath,["-e","0"]);console.log("spawn OK")}catch(e){console.log("spawn BLOCKED ->",e.code)}'
spawn BLOCKED -> EPERM
```
→ **`unit_all` 用 `execFileSync` 拉起每个子脚本，本沙箱把 spawn 拦死，所以 64 个全部 "exit error"。**
t4 观察到的 "0/64" 是真实的，但**归因必须是"沙箱限制"，不是"测试全挂"**。

### 4.2 board 测试套件：**188 个用例全部通过**（推翻"一条用例都没跑到"）

`ls tools | grep -i board` → 19 个文件（13 个 unit + 5 个 live + 1 个 diag）。
13 个 unit 直跑（cwd=可写目录，脚本用绝对路径）：

| 脚本 | exit | PASS | 备注 |
|---|---:|---:|---|
| board_store_unit | 0 | 25 | 25/25 |
| board_store_finish_unit | 0 | 15 | 15/15 |
| board_store_converge_unit | 0 | 9 | 9/9（另 1 条 XFAIL） |
| board_scheduler_unit | 0 | 34 | 34/34 |
| board_scope_unit | 0 | 10 | |
| board_payload_unit | 0 | 14 | |
| board_iface_unit | 0 | 16 | 16/16 |
| board_cmd_unit | 0 | 11 | 11/11 |
| board_nofallback_unit | 0 | 7 | 7/7 |
| board_add_recall_unit | 0 | 6 | 6/6 |
| board_b3_unit | 0 | 23 | 23/23 |
| board_b4_unit | 1 | 8 | 功能 8 条全 PASS，随后**用 cwd 相对路径读源码** → ENOENT |
| board_orphan_parent_unit | 1 | 10 | 同上 |

**合计 188 个 PASS，0 个 FAIL。**（11 个 exit=0 的脚本合计 170 条；两个 exit=1 的脚本功能段另计 8+10=18 条。）
两个 exit=1 不是断言失败，是我换 cwd 导致它读不到
`src/agent/library/*.js`（`board_b4_unit.mjs:166`、`board_orphan_parent_unit.mjs:183` 用的是
`readFileSync('src/agent/library/...')`，即**cwd 相对**）。在作者的真实 cwd（`mindcraft/`）下这两个
会因为 `mindcraft/tmp` 只读而 EPERM，但在作者机器上是能跑完的。

> **附带发现（真实缺陷，与本沙箱无关）**：`tools/` 里至少 **10 个**测试用 cwd 相对路径读源码：
> `act_craft_limit_unit:110`、`board_b4_unit:166/183/185`、`board_orphan_parent_unit:183/243`、
> `craft_diagnostic_reachability_unit:26/27`、`flow_mine_orenames_unit:87`、`flow_mine_pickup_unit:35`。
> 后果：从任何非 `mindcraft/` 的目录运行都会 ENOENT。轻微但真实（`join(dirname(fileURLToPath(import.meta.url)),'..','src',...)` 即可修）。

### 4.3 全部 62 个 `*_unit.mjs` 的真实成绩单

完整表格在 `docs/audit/probes/p4_unit_results.txt`（脚本 `p4_run_all.sh` 生成）。汇总：

| 口径 | 结果 |
|---|---|
| cwd=可写目录（`docs/audit/probes/run`） | **62 个脚本：50 个 exit=0，12 个 exit≠0** |
| 其中 12 个失败里，**10 个是 ENOENT**（读 `src/...` 失败，纯属我换了 cwd） | |
| 把这 12 个**改回 `cwd=mindcraft/` 重跑** | **8 个转为全绿**（如 `find_stand_unit` 30/30、`flow_mine_orenames_unit` 25/25、`craft_diagnostic_reachability_unit` 15/15、`strat_obtain_reverse_unit` 14/14、`job_budget_unit` 10/10、`flow_mine_pickup_unit` 10/10、`act_craft_limit_unit` 9/9、`board_*` 2 个见上） |
| 剩下 4 个改 cwd 后仍失败，**全部是 EPERM（写不进只读目录）** | `path3d_tunnel_unit`（`EPERM mkdir C:\Users\...\Temp\tunnel-*`）、`server_props_unit`（`EPERM mkdir mindcraft\tmp\_serverprops_*\root\server`）、`strat_alloc_unit` 的 1 条 `FAIL ⑦`（`EPERM mkdir mindcraft\tools\.tmp_mut`）、`board_b4_unit`/`board_orphan_parent_unit` |
| **真正的断言失败（非环境）** | **0 条** |

→ **结论：62 个 unit 测试在"宿主机正常权限"下应为 62/62 全绿；本环境观察到的 12 个红全是沙箱限制（10 个由我换 cwd 引起、2~4 个由只读目录引起），没有一条是代码 bug。**

### 4.4 `preflight.mjs`：能跑，且只挂在一处

```
$ cd mindcraft && node tools/preflight.mjs
  ✓ 所有模块导入成功（122/122），没有未定义引用
[3/4] 规则与申报审计
  ✓ 规则审计通过
  ✓ 错误码审计通过（38 个已注册，全部合法）
[4/4] API 扫描   ✓ 6 项全 0 处
[5/5] 前缀 import 规矩  扫 122 个文件、387 条 import，违规 0
[6/6] 依赖注入审计（A 档…）
  ✗ 扫描器自测**没跑起来**（输出里没有「扫描器自测：N passed, M failed」指纹）
     status=null  输出前 120 字=
     → **审计结果不可信**：自测不过时"审计报 0 处"没有意义，本段不判干净
[7/7] 代码规模 …
启动自检失败：1 处有问题。不要重启 agent。
```
→ **7 段里 6 段绿**，唯一红的是 `[6/6]`：它的"扫描器自测"要起子进程 → EPERM → `status=null`、
输出为空 → 该段按**设计** fail-closed（"自测不过时审计报 0 处没有意义"）。**这是环境的锅，不是代码的锅。**
它甚至顺手证明了 preflight 本身是好的：它没有把"跑不起来"当成"通过"。

同时它给出了权威的规模数字（`[7/7]`）：**src 文件 162、注册技能 18、测试脚本 64(+1 跳过)、CODES 38**；
并因为 `git` 也要 spawn 而显示"⚠ git 不可用"。

---

## 5. P5：README 的「1.41 格/秒」能不能复算

探针：`docs/audit/probes/p5_recompute.mjs`（遍历 `tmp/bench`、`mindcraft/tmp/bench`、`.../archive`）

### 5.1 产物清单（真实字段）

| 文件 | 行数 | 字段 | 能否算格/秒 |
|---|---:|---|---|
| `tmp/bench/*.jsonl`（s2-main，19 份） | 合计 46 行 | `run/at/logsNear/ok/code/kicked/reported/gained/honest/costMs/events/message` | ❌ **只有采集语义**，无移动距离 |
| `mindcraft/tmp/bench/deepwater-2026-11-03.jsonl` | 10 | `scenario/round/riverW/riverD/plan/ok/ms/moved/remain/execActions` | ✅ `moved/ms` |
| `mindcraft/tmp/bench/archive/*.jsonl`（move-actions 系列） | 数千行 | `scenario/dist/ms/ok/...` | ✅ |
| `mindcraft/tmp/*.log`、`tmp/bench/*.log` | — | 人读日志 | ❌ |

**扫描结果：55 个文件、3484 条可复算记录。**

### 5.2 从 artifact 重算（真实输出节选）

```
=== 按场景汇总（从 artifact 重算）===
scenario                      n      平均格      平均秒      平均格/秒   最小~最大
deep-water                   10      14.2      13.3        1.07   0.904~1.172
walk-flat                   322      23.7       7.1        3.32   0~4.329
jump-up1                    321      19.8       6.3        3.16   0~4.03
dig-through                 316      12.6       8.8        1.43   0~3.768
climb-ladder                300       6.6       3.9        1.68   0~4.376
flat-straight                17      23.8       7.6        3.12   3.012~3.295
stairs-up-1                  17      23.9       8.5        2.82   2.714~2.953
wall-to-dig                  17      10.5       6.5        1.61   1.224~2.778
long-route                   17      56.1      18.0        3.12   3.081~3.156
```

### 5.3 三个明确回答

1. **「1.41 格/秒」能不能从现存产物推出来？→ 不能。**
   把"接近 1.41(±0.15)"的记录全列出来，命中项**全部**是 `wall-to-dig` / `dig-through` / `down1` /
   `gap-bridge` 这些**别的场景**的单次记录（例：`wall-to-dig 10格/7052ms = 1.418`），
   **没有任何一条属于长距离导航，也没有任何按场景的聚合值等于 1.41**。
2. **「302 格推进 168 格」有没有对应场景？→ 没有。**
   `dist >= 250` 的命中项只有 `gap-bridge` 的 `dist=11457.3` / `11428.9` 这类**明显异常的字段值**
   （单次 11 457 格，配 10 秒 → 1 895 格/秒），属于该场景的 `dist` 语义有问题（疑似按 tick 累加，
   不是净位移）。**不存在 302 格级别的真实导航记录。**
3. **`long-route` 到底多少？→ 56.1 格 / 18.0 s = 3.12 格/秒（n=17，区间 3.081~3.156，非常稳）。**
   这与审计⑤的结论**完全一致**（它说 56.1 格 / 18.0 s / 3.12）。

### 5.4 判定与建议

* README:40 / 交接文档.md:129 / legacy/技术总结.md:194 的「1.41 格/秒」：**无法复算，应改**。
  要么删掉这个数，要么写明"来源：2026-10 某次真机长跑，无归档产物"，要么换成可复算的
  **long-route 3.12 格/秒（n=17）**——但必须同时说明**那是 56 格短程，不是 302 格长途**，两者不可比。
* **"302 格推进 168 格"同样无归档**，且它暗示的 55% 完成率没有任何记录支撑。
* 附带缺陷（真实、影响任何做基准的人）：`gap-bridge` 场景的 `dist` 字段不可信（11457 格）。
  用它算性能会得出"189 格/秒"的荒谬值 → **bench 产物里 `dist` 的定义需要一句话说明**（净位移 vs 累计路程）。
* **本轮无法实测的部分**：任何**新的**真机性能数字（需要启动 Minecraft 服务端 + 真 bot），
  本任务明确禁止启动服务端。上面所有数字都是**从既有产物重算**的，不是新跑出来的。

---

## 6. P6：安全类实弹验证（只做无破坏的那几条）

### 6.1 面板 socket 零认证 —— 静态确证，无法实弹（且按任务要求不启动）

```
$ netstat -an | grep -c ":8080.*LISTENING"
0
```
→ **mindserver 当前没在跑**。按任务要求"不要启动它"，因此**无法做连接级实弹验证**。
静态确证（来自审计③，未变）：`mindserver.js:421` 只 `bind('localhost')`；
`socket.io` 仅靠 `allowRequest=allowLocalOnly`（`local_only.js:34-40`）判 Host/Origin，**无任何认证**。
**给作者的一条复现命令**（在 mindserver 运行时执行，只订只读事件、不发指令）：
```bash
node -e "const {io}=require('socket.io-client');const s=io('http://localhost:8080',{transports:['websocket']});s.on('connect',()=>{console.log('connected WITHOUT any token');s.emit('get-profiles',r=>{console.log('profiles:',JSON.stringify(r).slice(0,200));process.exit(0)})})"
```
预期：打印 `connected WITHOUT any token` + profile 列表 —— 即"零认证即可读服务端文件清单"。

### 6.2 `create-agent` 路径穿越 —— **已解析到具体绝对路径（未落盘）**

探针 `docs/audit/probes/p6_path_traversal.mjs`（复刻 `prompter.js:110-111` 的 `./bots/${name}` 拼接，
**只调 `path.resolve` 算字符串，不 mkdir、不 writeFile**）：

```
cwd(mindcraft) = E:\我的世界ai\mindcraft
profile.name                  mkdir 解析到                                            write 解析到
deepseek                      E:\我的世界ai\mindcraft\bots\deepseek                    E:\我的世界ai\mindcraft\bots\deepseek\last_profile.json
../../pwn                    E:\我的世界ai\pwn                                        E:\我的世界ai\pwn\last_profile.json   ← 逃出 mindcraft/
../../../pwn2                E:\pwn2                                                   E:\pwn2\last_profile.json   ← 逃出 mindcraft/
..\..\pwn_win                E:\我的世界ai\pwn_win                                    E:\我的世界ai\pwn_win\last_profile.json   ← 逃出 mindcraft/

=== 判定 ===
✅ 已证明：3/5 个 name 会把写入路径解析到 mindcraft/ 之外
=== 对照：validateNameFormat 的判据（connection_handler.js:88）===
   "../../pwn"                    REJECT(会被 agent.js:205 拦)
```
→ **穿越成立**：`profile.name='../../pwn'` → 会写到 `E:\我的世界ai\pwn\last_profile.json`。
**但**同一个名字会被 `validateNameFormat` 拒绝 —— 问题在于它跑在 `agent.js:205`，
而 `Prompter` 构造器（`prompter.js:110-111` 的 mkdir/writeFileSync）在 `agent.js:147` 就已经执行完了。
**判定：✅ 成立（顺序问题），已用具体绝对路径证明，且未在本机真的落盘。**
注：`C:\Windows\Temp\pwn_abs` 这种绝对路径**没能**逃出去（被拼成 `bots\C:\Windows\...` 的相对段），
所以可用的穿越形式是 `../` 与 `..\` 两种。

### 6.3 RCON 局域网暴露 —— 复核仍在

```
$ netstat -an | grep 25575
  TCP    0.0.0.0:25575          0.0.0.0:0              LISTENING
  TCP    [::]:25575             [::]:0                 LISTENING
$ netstat -an | grep 25565
  TCP    0.0.0.0:25565          0.0.0.0:0              LISTENING
  TCP    [::]:25565             [::]:0                 LISTENING
```
→ **仍是 0.0.0.0 监听**（IPv4+IPv6 都听），与审计③的实测一致。
只做了**连接性**探测（`net.connect` 返回 `open`），**没有发任何 RCON 命令**（避免影响在跑的主服）。

---

## 7. 把推断变成实测后，报告里需要改判的条目

| 原报告位置 | 原表述 | 实测后应改为 |
|---|---|---|
| **02 组 B5** | 「一次 SQLITE_BUSY 就会删库 → 整个任务列表蒸发」 | **拆成两句**：①「`openBoard` 把所有异常当损坏」= 成立（BUSY 与 schema 不匹配两条实测都进同一分支）；②「一旦进分支就**删掉**」= 需放宽：进分支确定，**是否真删**取决于当时文件能否 rename/rm（实测 Windows 上被占用时都失败 → 数据侥幸保住，但仍被标 `rebuilt=true`）。另**新增**：`no such column`（schema 不匹配）是**不需要并发**就能触发的同类路径，风险更高 |
| **02 组 B5 的触发条件** | 隐含"任何写冲突" | 明确为「**独占锁 / 长事务超过 busy_timeout(5000ms)**」；普通 WAL 写事务（`BEGIN IMMEDIATE`）**打不到**（实测 9 秒持锁下 `openBoard` 1ms 正常返回） |
| **01 组 N6 / 相关** | 「`skills.digTunnel` 把"一格没挖"报成"挖了 N 步"」 | **补一条更硬的**：digTunnel **只要挖成功就必抛 `ReferenceError: ok is not defined`**（实测），所以它根本走不到"报成功"那一步 —— 真实症状是"每次都抛异常"，比"假成功"更严重 |
| **某处（modes 三条）** | 「ReferenceError 会崩」 | **下调**：`modes.js:118/126/133` 的 ReferenceError 被 `execute()`（`modes.js:466` 的 try/catch）**吞成一行 console.warn**，不崩进程；真实后果是"身上着火→水桶灭火永久静默失效" |
| **04 组（测试门禁）** | 「`unit_all` 0/64 / board 一条没跑到」 | **改判**：`unit_all` 0/64 的真因是 `execFileSync`（`unit_all.mjs:125`）被沙箱 EPERM（**环境**）；board unit **13 个文件的 188 条用例全部通过**（"一条没跑到"不成立）。62 个 unit 里**没有一条真实断言失败** |
| **04 组（preflight）** | 「preflight §6 失败」 | 精确化为：**7 段 6 绿**，只有 `[6/6]` 因自测子进程 spawn 不起来而按设计 fail-closed。**不是代码问题** |
| **05 组 / README:40** | 「1.41 格/秒 复不出来」 | **已证实不可复算**（3484 条记录无一条支撑），且 `long-route` 实测 **3.12 格/秒（n=17）**；「302 格推进 168 格」**无任何 ≥250 格的归档场景** |
| **05 组（bench 可信度）** | — | **新增**：`gap-bridge` 场景的 `dist` 字段不可信（单次 11 457 格），据此算出的 189 格/秒是假的；bench 产物需注明 `dist` 是"净位移"还是"累计路程" |
| **03 组 I2** | 「profile.name 未校验 → 任意文件写」 | **成立，已给出精确落点**：`../../pwn` → `E:\我的世界ai\pwn\last_profile.json`；`../../../pwn2` → `E:\pwn2\...`。同时确认 `validateNameFormat` 会拦但**跑得太晚**（`agent.js:205` vs `prompter.js:110`） |
| **03 组 I4** | 「RCON 0.0.0.0:25575」 | **复核成立**（IPv4+IPv6 都在听），无需改 |
| **任何"npx/eslint 能跑"的说法** | — | 本沙箱 **不成立**（`EPERM cmd.exe`）；依赖子进程的结论须标注"取决于沙箱" |

---

## 8. 留给作者复跑的探针清单（`docs/audit/probes/`）

| 脚本 | 用途 | 一行运行 | 预期输出 |
|---|---|---|---|
| `p1_env.mjs` | 环境能力表（spawn/npx/mkdir/net/sqlite） | `node docs/audit/probes/p1_env.mjs` | `--- TABLE ---` 后 14 行 PASS/FAIL；宿主机上 spawn 应为 PASS |
| `p2_lockholder.mjs` | 持写锁（WAL + BEGIN IMMEDIATE） | `node docs/audit/probes/p2_lockholder.mjs <dir> 9000` | `[A] BEGIN IMMEDIATE OK … 保持 9000ms` |
| `p2_lockholder_exclusive.mjs` | 持独占锁（rollback journal + BEGIN EXCLUSIVE） | `node docs/audit/probes/p2_lockholder_exclusive.mjs <dir> 10000` | `[A2] BEGIN EXCLUSIVE OK` |
| `p2_openboard.mjs` | 调真实 `openBoard` 看是否被判"损坏" | `node docs/audit/probes/p2_openboard.mjs <dir>` | 修复后应为 `rebuilt = false`；当前版本锁冲突时 `rebuilt = true  error = database is locked` |
| **P2 一键复现** | 上面两个串起来 | 见 §2.4 的命令块 | — |
| `p3_reference_errors.mjs` | 触发 `skills.js:5750` 的 `ok` | `node docs/audit/probes/p3_reference_errors.mjs` | `P3-1 … ReferenceError: ok is not defined` |
| `p3_modes_placed.mjs` | 尝试触发 `modes.js:118` 的 `placed` | `node docs/audit/probes/p3_modes_placed.mjs` | 当前输出 `Mode self_preservation threw: TypeError: …`（分支可达但需真 bot 才能走到 `if (placed)`；`execute()` 会吞掉异常） |
| `p4_run_all.sh` | 全量 unit 成绩单（含 PASS/FAIL/退出码/耗时） | `bash docs/audit/probes/p4_run_all.sh "*_unit.mjs" > out.txt` | 表头 + 62 行 |
| `p5_recompute.mjs` | 从 bench artifact 重算格/秒 | `node docs/audit/probes/p5_recompute.mjs` | 场景汇总表；`long-route 56.1 格 / 18.0 s / 3.12` |
| `p6_path_traversal.mjs` | 证明 `profile.name` 会解析到哪（**不落盘**） | `node docs/audit/probes/p6_path_traversal.mjs` | `✅ 3/5 个 name 会把写入路径解析到 mindcraft/ 之外` |
| `p4_unit_results.txt` | （产物，非脚本）62 个脚本的完整成绩单 | — | 63 行表格 |

> 所有探针**只读源码 + 只写 `docs/audit/probes/` 或其下的 `run/`**；
> 没有一个会启动 Minecraft 服务端、修改 `mindcraft/` 或向仓库外写文件。

---

## 9. 未实测 / 无法实测的部分（诚实清单）

| 项 | 为什么不能测 | 缺什么条件 |
|---|---|---|
| 面板 socket 实弹连接 | mindserver 当前未运行，任务禁止启动它 | 作者本机启动 mindserver 后跑 §6.1 那条命令 |
| `modes.js:118` 精确命中 `if (placed)` | `skills.placeBlock` 需要真 bot 的方块/背包/物理，stub 无法穷尽；本任务不许启动服务端 | 真 Paper 服 + 真 bot，让 bot 站到火里且背包有 water_bucket |
| `npc/item_goal.js:163` 运行时触发 | 需要 `type='hunt'` 的 NPC 任务节点 + 真 bot | 真机 NPC 任务（`!givePlayer` 触发的 item goal） |
| 新的真机性能数字 | 需启动服务端跑 bench | 真 Paper 服；本轮只做**历史产物重算** |
| `atom_all.mjs`（需 25566 测试服） | 测试服在跑，但它 spawn 子进程（EPERM）+ 需真机 | 宿主机权限 |
| 12 个 unit 的"完全绿" | `mindcraft/tmp`、`mindcraft/tools` 在本沙箱只读 | 在作者机器上 `cd mindcraft && node tools/unit_all.mjs` 一次即可 |

**收尾核对**：
```
$ cd mindcraft && git status --porcelain
(空)
```
`mindcraft/` 工作树干净，未改任何被审查源码。

---

*报告完。所有判定均附真实命令与真实输出；跑不了的已明确标注"无法实测"及缺什么。*
