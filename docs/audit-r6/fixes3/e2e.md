# R6 真机 E2E 验收：chest 取物精确性 + 场景验收（ADR §11.5 #4）

> 执行者：qa-e2e（attempt 1，2026-11-11 21:53–22:57 CST）
> 机器：本机（Windows，仓库 `E:\我的世界ai`），测试服端口 25566 / RCON 25576
> 硬约束：未修改任何产品代码；只用 `server-test/` 与 `test-template/`，未碰 `server/` 生产存档；全程串行。
> 原始日志：`docs/audit-r6/fixes3/evidence/`

---

## 0. 结论（先说要紧的）

| # | 判断 | 依据 |
|---|---|---|
| 1 | **R6 头号缺陷「chest 取物要 8 搬 11」在真服上未复现** —— `fetch(8)` 精确搬 8 件 | 服务端真值（RCON）连续 10 次取物全部 `箱子 16→8 / 背包 +8`；`+16`、`16→0`、账目错 三种坏签名 **0 次** |
| 2 | ~~**`scripts/e2e.ps1` 在这台机器上跑不起来**（JDK 预检 FATAL，1 秒退出）~~ —— **已闭（2026-11-11 修复，复跑 30/30 exit 0）** | 修复前：只有 Windows PowerShell 5.1，无 pwsh 7；见 §3.1。修复后见 §7（`Resolve-Java` 临时降 `ErrorActionPreference`） |
| 3 | **`store` 路径的账目仍不可信**（箱子已有同类物品时自报 < 物理） | 3 轮里 1 轮：物理 `+16`，自报 `stored=9` 且 `ok=false`；见 §3.2 |
| 4 | **live 工具缺 `<botsRoot>/<name>/map` 目录 → 3D 扫描打不开库 → 需要走路的场景间歇失败** | 不建目录 3/5，补建目录 6/6；见 §3.3 |
| 5 | 场景「跨重启丢不丢」通过 | 重启后箱内 8 个 oak_log 仍在（bot 读 + RCON 读双证） |
| 6 | **`-Scenario restart` 一条命令跑通：13/13 全过**（箱子 / 熔炉 / bot 记忆跨重启） | exit 0，55s；见 §8.2 |
| 7 | **`-Scenario claims` 失败：5/10**，13 条争用断言里 **12 条红、全部 `NO_PERMISSION`** | 不是产品缺陷，是 **t37 工具没跟上 R6 身份门**（agent 凭据下没做 `login-agent` → `board:hello` 被拒）；且第 ⑤ 条是**空断言假通过**；见 §8.1 / §8.3 |

**一句话**：ADR §11.5 #4 原本要证明的两件事里，「取物精确性」在真服上**成立**；但「一条命令跑完」在这台机器上**不成立**（脚本预检自身有缺陷 —— **该缺陷已于 2026-11-11 修复：chest 30/30、restart 13/13，见 §7/§8**），且 `store` 的账目、以及 e2e 工具的 mock 目录缺口是两个新查实的缺陷。

**§8 补充（预检修好之后）**：`restart` 场景已一条命令跑通（13/13）；`claims` 场景仍**红**，但红在**测试工具**一侧 —— t37 拿的是 agent 凭据却只发 `board:hello`、没先 `login-agent`，被 R6 身份门按 `NO_PERMISSION` 拒；产品侧的预约/冲突逻辑本轮**没有被真正验证到**（失败断言原文见 §8.1）。

---

## 1. 前置核对

| 项 | 结果 |
|---|---|
| 端口 25565/25566/25576/18093/8080 | 开工前全部空闲（`netstat -ano` 无监听）；收工后再次确认全空闲 |
| 残留 java/node | 开工前无；收工后无 |
| JDK | `.tools/jdk-21.0.12.1+1`（Temurin 21.0.12.1）存在 |
| `server/server.jar` | 52.8 MB，存在（Paper 1.21.8） |
| `server-test/{libraries,versions,cache}` | 75M / 28M / 55M（119 个文件），作为只读大件被 junction 复用 |
| `test-template/world` | 3.4M，干净模板世界 |

---

## 2. 跑过的场景（命令 / 耗时 / 退出码 / 结果）

### 2.1 先按 ADR 的说法跑官方入口 —— 起不来

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/e2e.ps1 -Scenario chest -KeepRun
```
- 耗时 **1s**，exit code **1**
- 输出尾段：`FATAL 解析不出任何 JDK 的主版本号`（原文见 `evidence/e2e-ps1-jdk-fatal.log`）
- 相对路径 / 绝对路径 `-File` 各试一次，结果一致

⇒ 官方「一条命令跑完」的路在这台机器上走不通（根因见 §3.1）。于是改走 §7 文档记载的**手工起服 + live 工具**路径，仍用同一套模板 / 同一守护器 / 同一 junction 只读复用，行为等价于 `New-RunDir`。

### 2.2 手工等价运行目录（未改任何产品代码）

```bash
# 运行目录：tmp/e2e-manual/chest
cp -r test-template/world            tmp/e2e-manual/chest/world
sed 's/__E2E_RCON_PASSWORD__/<随机24位>/' test-template/server.properties > .../server.properties
printf 'eula=true' > .../eula.txt
New-Item -ItemType Junction libraries|versions|cache → server-test/…   # 只读复用
node mindcraft/tools/e2e_server_ctl.mjs --run-dir ... --java .tools/jdk-21.0.12.1+1/bin/java.exe \
     --jar server/server.jar --log .../server.log --err .../server.err.log
```
- 第一次起服：`Done (13.806s)`，RCON 25576 可用（`evidence/server-boot1.log`）
- 重启：`Done (10.248s)`（`evidence/server-boot2.log`）

> 注：手工搭的目录与 `e2e.ps1` 的 `New-RunDir` 有两处差异，已在下文当作缺陷记录：
> ① 没有 `Reset-World` 的「逐文件 sha256 一致」校验；② 没有建 `<botsRoot>/<name>/map`（§3.3）。

### 2.3 场景 A：chest 主动存取守恒 + 三条反证（干净世界）

```bash
cd mindcraft
RCON_PORT=25576 RCON_PASSWORD=<随机> MC_BOTS_ROOT=<run>/bots \
  node tools/e2e_chest_store_live.mjs
```
- 耗时 **48s**，exit code **0**
- **20/20 断言全 PASS**，`=== 小计：PASS 20 / 20，FAIL 0 ===`
- 全文：`evidence/chest-live-run1.log`

关键行（服务端 RCON 与会话广播双向一致）：

```
[存后] 技能返回 {"ok":true,"code":"OK","data":{"item":"oak_log","want":16,"stored":16,...}}
[存后] 背包 32 → 16；chest1 {} → {"oak_log":16}；RCON 16
[RCON 原文] -98, -60, -600 has the following block data: [{Slot: 0b, id: "minecraft:oak_log", count: 16}]
PASS  断言A 存后背包 -16    32 → 16
PASS  断言B2 存后箱子 +16（RCON 独立读）  data get block Items → 16（条目 1）
PASS  断言C 存后总数守恒      32+0 → 16+16

[取后] 技能返回 {"ok":true,"code":"OK","data":{"item":"oak_log","want":8,"taken":8,"takenSource":"server"}}
[取后] 背包 16 → 24；chest1 {"oak_log":16} → {"oak_log":8}；RCON 8
PASS  断言D 取后背包 +8      16 → 24          ← 头号缺陷的正题
PASS  断言D2 取后箱子 -8     16 → 8
PASS  断言D3 取后总数守恒     16+16 → 24+8
PASS  取后 RCON 独立读箱子 = 8   data get block Items → 8
```

三条反证（防「永远返回成功」）也都正确失败：`NO_ITEM`（取没有的 diamond，背包 4→4）、`INTERNAL`（满箱存，背包 24→24）、`OUT_OF_REACH`（20 格外，背包 4→4）。

### 2.4 场景 B：跨重启持久化

```bash
node tools/e2e_chest_store_live.mjs --verify-persist   # 重启后（同一运行目录）
```
- 耗时 **7s**，exit code **0**，**2/2 PASS**（`evidence/chest-live-persist.log`）
```
PASS  重启后：箱子里仍有 8 个 oak_log（bot 读）      containerItems → {"oak_log":8}
PASS  重启后：箱子里仍有 8 个 oak_log（RCON 独立读） data get block Items → 8
```

### 2.5 重复跑（世界未重置）—— 15/20、14/20、15/20，但**不是精确性缺陷**

同一运行目录连跑 3 次（run2/3/4，各 33–35s，exit 1）：箱子内容累计 `8→16→24→32`，于是「前置：chest1 是空的」「取后 RCON = 8」这类**绝对量断言**必然失败。
- 这三轮里 `断言D / D2 / D3`（+8、-8、守恒）**全部 PASS** —— 头号缺陷依然没复现。
- 结论：**场景不可幂等重跑**（`setblock chest` 不清理已有 BlockEntity 内容）。官方入口每次 `Reset-World` 所以无碍；但 §7 记载的手工复跑方式会踩到，需在世界重置后跑，或先清箱（`setblock … air` → `setblock … chest`，注意需先 `forceload add`）。

### 2.6 清箱后重跑（run5/6/7）—— 暴露测量侧抖动

清箱 + fresh 背包后各跑一次：run5 15/20、run6 19/20、run7 18/20，exit 1，各 32–35s。
- `断言D / D2 / D3` 全部 PASS，`fetch` 返回 `taken=8, takenSource:'server'`，**RCON 每次都是 8**。
- 失败项全是**客户侧读数**：fetch 刚结束 `containerItems()` 读到 `{}`（实际 8）、`clear`+`give` 之后 `bot.inventory` 读到 0（实际 4/24）。run5 那轮连「反证2 满箱存」都因读数是 0 而判错。
- 判读：物理真值（RCON）全程正确，**bot 客户端读数是抖动源**，不是搬错。详见 §3.4。

### 2.7 决定性对照：只用 RCON 真值验精确性

为把「产品行为」与「测量抖动」彻底分开，写了一个只用 RCON 真值的探针（临时文件，跑完即删；不属产品代码）：

```bash
# 每轮：setblock air→chest 清箱、clear+give 32、store(16)、fetch(8)
# 真值全部取 data get block … Items 与 data get entity <bot> Inventory（不经 bot 客户端）
node mindcraft/.tmp-probe/rcon_fetch_probe.mjs 5
```

| 组 | 条件 | 结果 |
|---|---|---|
| 对照 A | 不建 `<botsRoot>/<name>/map` | **3/5**（round4/5 `store` 直接失败，`stored=0`，伴随 `[walkTo] 3D 扫描失败: unable to open database file`） |
| 对照 B | 预建 `<botsRoot>/<name>/map` | **6/6** 精确：每轮 `store 0→16 / 背包 32→16`、`fetch 16→8 / 背包 16→24`、守恒成立、零扫描报错 |

日志：`evidence/rcon-truth-probe.log`（3/5）、`evidence/rcon-truth-probe-mapfix.log`（6/6）。

**合计精确性证据**：官方工具 1 次干净 20/20 + run6/run7 各一次 `+8/-8` + RCON 探针 9 轮 `16→8` = **共 10+ 次 `fetch(8)`，无一次多搬（`+16`/`16→0` 均 0 次）**，与 `docs/audit-r5/fixes/09-chest-e2e.md` §14（T38 修好）结论一致，且这次是**独立复核**。

---

## 3. 查实的缺陷（只记录，未改代码）

### 3.1 【阻塞】`scripts/e2e.ps1` 在只有 PowerShell 5.1 的机器上必死在 JDK 预检

- 文件:行：`scripts/e2e.ps1:59`（`$ErrorActionPreference = 'Stop'`）+ `scripts/e2e.ps1:111-118`（`Resolve-Java` 的 `& $c -version 2>&1` 包在 `try/catch{}` 里）
- 现象：`java -version` 把版本号写到 **stderr**；PS 5.1 在 `Stop` 下把原生命令的 stderr 当**终止性错误**抛出 → 被 `catch {}` 吞掉 → `$ver` 恒为 `null` → 所有候选 `continue` → `$best` 为 null → `FATAL 解析不出任何 JDK 的主版本号`。**exit 1，耗时 1 秒**，一个断言都没跑。
- 直接证据（把该函数原样抽出来跑）：
  ```
  cands=1
    CAUGHT: openjdk version "21.0.12.1" 2026-08-18 LTS
    ver=
  best=
  ```
  同一段逻辑若不设 `ErrorActionPreference='Stop'`，`$raw` 正常解析出 `21`（已单独验证）。
- 复现命令：
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/e2e.ps1 -Scenario chest
  ```
  （本机无 pwsh 7：`where pwsh` 为空、`C:\Program Files\PowerShell\7` 不存在 ⇒ 无绕道）
- 影响：**ADR §11.5 #4「e2e 三场景一条命令跑完」在本机无法执行**；`#53` 修的端口三预检、junction 清理逻辑因此一次都没被执行到（无法验收）。
- 备注（供修复参考，未落地）：`Invoke-Rcon`（`:222-229`）已经为同一坑做过局部降级（`$ErrorActionPreference='Continue'`），`Resolve-Java` 漏了同样处理 —— 属同类问题的第二处，符合仓库「同一判据抄多份就漂移」的既有教训。

### 3.2 `store` 的账目仍信客户端：箱内已有同类物品时自报 < 物理

- 文件:行：`mindcraft/src/agent/library/act_container.js:665`（`fail('INVENTORY_FULL', '只存进去 ${m.stored}/${take}')`）→ `mindcraft/src/agent/library/flow_store.js:235`（`只存进去 ${storedTotal}/${target}`，`partial:true`）
- 现象（3 轮里 1 轮）：
  ```
  round1: 箱 16->32 (物理 +16)；背包 32->16；自报 stored=9 ok=false code=INVENTORY_FULL msg=只存进去 9/16
  round2: 箱 16->32 (物理 +16)；背包 32->16；自报 stored=16 ok=true
  round3: 箱 16->32 (物理 +16)；背包 32->16；自报 stored=16 ok=true
  ```
  → **物理搬了 16 件，却报「只存进去 9/16」并返回失败**；上层若按 `stored` 重试就会重复搬运。
- 触发条件：目标箱**已有同类可叠加物品**（此处预置 16 个 oak_log 在 slot0）。箱子为空时 6/6 全对（§2.7 对照 B 的 store 全部 `stored=16`）。
- 对照：`fetch` 已经在 T38 用「关窗→重开读服务端真值」修正过（`flow_store.js:313` `takenSource:'server'`）；**`store` 路径没有同样的服务端真值修正** —— 这是 `fetch` 修好了、`store` 没跟上的不对称。
- 复现命令（临时探针，逻辑即上表；产品代码未改）：
  ```bash
  RCON_PORT=25576 RCON_PASSWORD=*** MC_BOTS_ROOT=<run>/bots \
    node mindcraft/.tmp-probe/store_account_probe.mjs
  ```
  探针做的事：`setblock air` → `setblock chest` → `item replace block … container.0 with minecraft:oak_log 16` → `clear`+`give 32` → `store(bot,'oak_log',16)` → 用 RCON 读箱子真值对比 `r.data.stored`。
- 日志：`evidence/store-account-probe.log`

### 3.3 live 工具不建 `<botsRoot>/<name>/map` → 3D 扫描打不开库

- 文件:行：`mindcraft/src/agent/library/bot_paths.js:mapDirOf`（返回 `<botsRoot>/<name>/map`）→ `mindcraft/src/agent/library/terrain3d.js:95-96`（`new DatabaseSync(`${baseDir}/terrain3d.db`)`）；调用点 `mindcraft/src/agent/library/executor.js:987`（`[walkTo] 3D 扫描失败:`）
- 现象：`[walkTo] 3D 扫描失败: unable to open database file` + `[walkTo] 3D 规划异常: unable to open database file`，成对刷屏。sqlite **不会**自动创建父目录，而 `MC_BOTS_ROOT` 指过去的那棵树里根本没有 `<name>/map`（实测 `find <run>/bots` 为空）。
- 后果（真实功能影响）：一旦目标不在交互距离内、需要走路，`walkTo` 失去 3D 规划 → `store`/`fetch` 直接失败（`stored=0`，物品守恒、无损失）。对照 A 里 round4/5 就是这样挂的。
- 因果证明：预建 `<botsRoot>/<name>/map` 后，同一探针 **6/6 全绿、零扫描报错**（§2.7 对照 B）。
- 复现命令：
  ```bash
  MC_BOTS_ROOT=<空目录> node mindcraft/tools/e2e_chest_store_live.mjs   # 观察 [walkTo] 刷屏
  ```
- 影响面：`tools/*_live.mjs` 里凡设 `MC_BOTS_ROOT` 却不建子目录的都会踩；官方 `scripts/e2e.ps1` 同样只设 `MC_BOTS_ROOT`（`:296/:343/:470`），没有建 map 目录 —— 只是 `chest` 场景恰好站在 3 格内（交互距离内）掩盖了它。

### 3.4 客户侧读数抖动（观察项，非搬运错误）

- 现象：`fetch` 刚结束 `containerItems()` 读到 `{}`（RCON 同期是 8）；`clear`+`give`/`tp` 之后 `bot.inventory` 读到 0。
- 频次：清箱后 3 次运行出现 1–2 项（run5 最严重，5 条 FAIL）。
- 判读：**物理真值始终正确**（RCON 每轮 8），是 live 断言的测量面在抖，不是搬错。`e2e_chest_store_live.mjs:67 settleWindow` 已为此加了「等同步 + 1200ms 静默」，但在本机这套时序下仍不够。
- 影响：会让官方 chest 场景**间歇性红**（FAIL 的是「bot 读」那几条），容易被误当回归。建议后续把关键断言改为**以 RCON 真值为准**（fetch 的 `takenSource:'server'` 已是这个思路，场景断言层还没跟）。

---

## 4. 清理记录（必须项）

| 动作 | 结果 |
|---|---|
| 停服 | RCON `stop`；java exit code **0**；`tasklist` 无 java |
| junction | `libraries/versions/cache` 三个**逐个**以 `[System.IO.Directory]::Delete` 只删链接本身（**未** `-Recurse` 跟随），删前确认 `ReparsePoint` 属性为真 |
| 临时目录 | `tmp/e2e-manual/`、`tmp/e2e-logs/`、`mindcraft/.tmp-probe/` 全部删除 |
| RCON 口令 | 随机 24 位，只存在于临时 `rcon.pw`（已删）；**已核对归档日志不含口令**（`grep` 无命中） |
| `server-test/` 完整性 | 复查 `libraries 75M / versions 28M / cache 55M`，与清理前一致（未被 junction 递归误删） |
| `server/` 生产存档 | **全程未触碰**（只用 `test-template/world` + `server-test/` 只读件） |
| 产品代码 | **零修改**；`git status --porcelain` 为空 |
| 收工后端口/进程 | 25565/25566/25576/18093/8080 全空闲；无 java/node |

---

## 5. 未覆盖 / 边界（如实说明）

1. **没跑成官方三场景入口**（`claims` / `restart` / `all`）—— 被 §3.1 卡在起跑线；因此 `#53` 的「端口三预检不误报」「异常中断后无残留 junction」两项**仍未验收**。
2. **没跑 `claims` / `restart` 场景**：串行端口限制下，仅完成本单被指派的 `chest`。
3. `store` 的「第一箱半满 → 自动换第二箱（storefull）」分支**只触发过失败**，未验证「成功换箱」。
4. 大数量（>64/跨多格）、nbt/components 物品（潜影盒、命名物品）未覆盖。
5. bot 死亡/掉线后的窗口残留（`WINDOW_CLOSED` 重开）未覆盖。
6. §3.2 的账目缺陷只做了 3 轮（1 次复现），未统计稳定频次；`INVENTORY_FULL` 分支的 `m.stored` 具体错在哪一步（读槽 vs 按键计数）未定位到行内表达式 —— 需要下一单在 `deposit` 内部打点。

---

## 6. 证据文件清单

| 文件 | 内容 |
|---|---|
| `evidence/e2e-ps1-jdk-fatal.log` | 官方入口 1 秒 FATAL 的原始输出（exit 1） |
| `evidence/chest-live-run1.log` | 干净世界 20/20 全绿（含 `[RCON 原文]`） |
| `evidence/chest-live-persist.log` | 跨重启 2/2 |
| `evidence/chest-live-run5.log` | 测量抖动最严重的一轮（15/20，RCON 仍 = 8） |
| `evidence/chest-live-run6.log` / `run7.log` | 19/20、18/20（抖动项） |
| `evidence/rcon-truth-probe.log` | 只用 RCON 真值：3/5（缺 map 目录） |
| `evidence/rcon-truth-probe-mapfix.log` | 补建 map 目录：**6/6 精确** |
| `evidence/store-account-probe.log` | `store` 自报 9 / 物理 16 |
| `evidence/server-boot1.log` / `server-boot2.log` | 起服与重启日志（`Done (…)`、RCON 监听 25576） |

---

## 7. 阻塞项修复（fix-e2e-jdk · 2026-11-11 23:0x–23:2x CST）

> 执行者：fix-e2e-jdk（attempt 1）。只改 §3.1 的 `Resolve-Java`，未动其它逻辑；
> `#53` 已修的三端口预检与 junction 清理**未触碰**。

### 7.1 改动

文件：`scripts/e2e.ps1`（`Resolve-Java`，原 :110-117）

```diff
     foreach ($c in $cands) {
         $ver = $null
+        $prevEap = $ErrorActionPreference
+        $raw = $null
         try {
+            # 修（PS 5.1 专属坑）：本脚本 EAP=Stop 时，java -version 把版本行写到 stderr，
+            # 经 2>&1 会变成 ErrorRecord 并抛 NativeCommandError，被 catch 吞掉 ⇒ 版本号恒 null，
+            # 上层报 "解析不出任何 JDK 的主版本号"。这里只在读版本时临时降级为 Continue
+            # （与 Invoke-Rcon 同法），读完立刻还原；不用 -ErrorAction 掩盖真错。
+            $ErrorActionPreference = 'Continue'
             $raw = (& $c -version 2>&1 | Select-Object -First 1) -join ' '
-            if ($raw -match 'version "(\d+)(?:\.(\d+))?') { $ver = ... }
-        } catch { }
+        } catch { } finally { $ErrorActionPreference = $prevEap }
+        if ($raw -match 'version "(\d+)(?:\.(\d+))?') { $ver = ... }
```

- **做法**：只把「读版本」这一行的 EAP 临时降到 `Continue`，`finally` 里还原；正则解析挪到 `try` 外面（`$raw` 为 `$null` 时 `-match` 返回 `$false`，自然 `continue`）。
- **没有**用 `-ErrorAction SilentlyContinue` 掩盖真错：`& $c` 找不到/不可执行仍是终止性错误，会被同一个 `catch` 吞掉、`$ver` 保持 `null`，最终照样报 FATAL。
- **未改**：候选枚举（`Get-ChildItem .tools/jdk*`）、取最高版本而非 `$cands[0]`（`#53`）、`< 21` 的硬门槛、错误文案与退出码。

### 7.2 真机复跑（本次实测，非推演）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/e2e.ps1 -Scenario chest
```

- 耗时：远大于 1 秒（起服→两段→重置，正常把整条链路走完）
- **exit code 0**，输出尾部：`E2E 通过：30/30 条断言全部通过`
- `JDK : E:\\我的世界ai\\.tools\\jdk-21.0.12.1+1\\bin\\java.exe`（版本号解析成功）
- 日志里 `FATAL` 出现次数 **0**（`grep -c FATAL` = 0）
- 原始日志：`evidence/e2e-ps1-jdk-fixed-chest.log`

顺带被这次运行**首次真正执行到**的、原先一次都没跑到的东西（§5 第 1 条列的未覆盖项）：

| `#53` 修复项 | 本次结果 |
|---|---|
| 起服前三个端口预检（25566/25576/18093） | 通过（未误报） |
| `Resolve-Java` 取最高版本且 `>= 21` | 通过 |
| 停服后 junction 先摘再删（不追进 `server-test/`） | 通过：`tmp/e2e` 已清空，`server-test/{libraries,versions,cache}` 未被删除 |

### 7.3 回归与清理

| 检查 | 结果 |
|---|---|
| Parser（`[Parser]::ParseFile`）语法错误数 | **ERR=0** |
| `node scripts/tests/ops-regression.mjs` | **87 passed, 0 failed**（含 `R6#53 e2e 预检三个端口` / `断言 JDK 主版本 >= 21` / `先摘 junction 再删目录` 三条） |
| 端口 25565/25566/25576/18093 收工后 | 全部空闲（`netstat -ano` 无监听） |
| 残留 `java` / `node` 进程 | 无（`Get-Process java,node` 空） |
| `tmp/e2e` | 已由脚本自行清空 |

### 7.4 排版副作用（记录，已复原）

用编辑器改文件时把 `scripts/e2e.ps1` 开头的 **UTF-8 BOM 删掉了**，PS 5.1 会按 ANSI 解析中文注释 → Parser 报一片 `Missing closing ')'`。已把 BOM 补回（`ef bb bf`），Parser 回到 ERR=0；行尾仍是 CRLF。**教训**：这个仓库的 `.ps1` 依赖 BOM，改完必须验 Parser 和 `git diff`（改动应只有目标那几行）。

### 7.5 §0 结论表第 2 条的更新

§0 表里「`scripts/e2e.ps1` 在这台机器上跑不起来（JDK 预检 FATAL）」**已失效** —— 该阻塞项已修复并真机复跑通过（30/30）。§3.1 保留作为历史缺陷记录，状态可视为**已修**。

---

## 8. 其余场景：claims / restart

> 承接 §7：`t-jdk` 修好 JDK 预检后，这里补跑上一轮**未覆盖**的两个场景。
> **没有重跑 `chest`** —— §7.2 已有 `exit 0 / 30/30` 的真机证据，重跑只占时间。
> 命令一律用 ADR 的官方入口（本机只有 PowerShell 5.1，故 `powershell` 而非 `pwsh`）。
> 执行时间：2026-11-11 23:26–23:47 CST；**未改任何产品代码**（`git status`：`M scripts/e2e.ps1` 是 t-jdk 的预检修复，`?? docs/audit-r6/fixes3/` 是本报告目录）。

### 8.0 前置与收工状态

| 检查 | 开工前（23:26） | 收工后（23:47） |
|---|---|---|
| 端口 25566 / 25576 / 18093 | 全部空闲（`netstat -ano` 无监听） | 全部空闲 |
| 本线遗留 `java` / `node` | 无 | **无**（`Get-CimInstance` 按命令行核过：现存进程属于并行其它线，见 §8.4） |
| JDK | `E:\我的世界ai\.tools\jdk-21.0.12.1+1\bin\java.exe`（`Resolve-Java` 解析成功） | 同 |
| 被测提交 | `963579b81ce538393268e308e815deedf913fd78`（t37 自证，见日志首段） | 同 |
| `tmp/e2e` | 空 | 空（运行目录已清，见 §8.4） |

### 8.1 claims：**exit 1，5/10**（13 条争用断言里 12 条红）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/e2e.ps1 -Scenario claims
```

| 轮次 | 命令差异 | 耗时 | exit | 断言统计 |
|---|---|---|---|---|
| 第 1 轮 23:27 | 原样 | 59s | **1** | 汇总 `5/10`；脚本内部 `1/13` |
| 第 2 轮 23:35 | 加 `-KeepRun`（为留现场） | 43s | **1** | 汇总 `5/10`；脚本内部 `1/13`（**与第 1 轮逐条一致**，可复现） |

日志：`evidence/e2e-ps1-claims.log`（第 1 轮）、`evidence/e2e-ps1-claims-keeprun.log`（第 2 轮）、`evidence/e2e-claims-scenario.log`（t37 原始输出）

**失败断言原文**（12 条，全部 `code=NO_PERMISSION`；三种 key 各 4 条，形态完全一样）：

```
=== container：container:6200,-60,8800 ===
FAIL container ①A 预约成功且查库有 1 行(owner=A, until 在未来) —— {"ok":false,"rows":[],"code":"NO_PERMISSION"}
FAIL container ②B 抢同一 key → CLAIM_CONFLICT 且点名该 key —— {"ok":false,"code":"NO_PERMISSION","conflicts":[]}
FAIL container ③B 没落行（该 key 仍 1 行且 owner=A） —— {"rows":[]}
FAIL container ④反向对照：B 用**不同坐标**的同类 key → 必须成功（防"恒冲突"假通过） —— {"ok":false,"code":"NO_PERMISSION","altKey":"container:6205,-60,8800"}

=== station：station:furnace@6202,-60,8800 ===
FAIL station ①A 预约成功且查库有 1 行(owner=A, until 在未来) —— {"ok":false,"rows":[],"code":"NO_PERMISSION"}
FAIL station ②B 抢同一 key → CLAIM_CONFLICT 且点名该 key —— {"ok":false,"code":"NO_PERMISSION","conflicts":[]}
FAIL station ③B 没落行（该 key 仍 1 行且 owner=A） —— {"rows":[]}
FAIL station ④反向对照：B 用**不同坐标**的同类 key → 必须成功（防"恒冲突"假通过） —— {"ok":false,"code":"NO_PERMISSION","altKey":"station:furnace@6207,-60,8800"}

=== entity：entity:83f6b14d-d743-4e55-b76f-fe4dc76f7d60 ===
FAIL entity ①A 预约成功且查库有 1 行(owner=A, until 在未来) —— {"ok":false,"rows":[],"code":"NO_PERMISSION"}
FAIL entity ②B 抢同一 key → CLAIM_CONFLICT 且点名该 key —— {"ok":false,"code":"NO_PERMISSION","conflicts":[]}
FAIL entity ③B 没落行（该 key 仍 1 行且 owner=A） —— {"rows":[]}
FAIL entity ④反向对照：B 用**不同坐标**的同类 key → 必须成功（防"恒冲突"假通过） —— {"ok":false,"code":"NO_PERMISSION","altKey":"entity:83f6b14d-d743-4e55-b76f-fe4dc76f7d60-other"}
```

e2e.ps1 侧因此额外红 4 条「关键断言出现」（①②③④ 没有 PASS 行；⑤ 命中）：

```
FAIL claims 场景脚本全部断言通过 —— 退出码=1, PASS=1, FAIL=12
FAIL claims 关键断言出现：①A 预约成功 —— 日志里没有该断言的 PASS 行（见 scenario-claims.log）
FAIL claims 关键断言出现：②B 抢同一 key —— 日志里没有该断言的 PASS 行
FAIL claims 关键断言出现：③B 没落行 —— 日志里没有该断言的 PASS 行
FAIL claims 关键断言出现：④反向对照 —— 日志里没有该断言的 PASS 行
E2E 失败：5/10 条通过，5 条失败
```

**通过的 5 条**（说明起服/停服/世界重置链路本身没问题，红的只有争用断言）：`起服前世界=模板世界`、`claims：起服就绪`、`⑤ entity 预约泄漏`、`claims：停服（优雅退出）`、`重置后世界=模板世界`。

#### 8.1.1 根因：**不是产品缺陷，是 t37 工具没跟上 R6 身份门**

链条（每一环都有代码位置 + 探针原文）：

1. `tools/t37_claims_contention_live.mjs:57` 在**父进程内**起 mindserver（`createMindServer(false, 18093)`）。
2. `src/mindcraft/mindserver.js:1019-1021` 这段代码把**父进程自己的** `process.env.MINDSERVER_TOKEN` 覆盖成 **agent 凭据**：`registerCredential(agentToken, ROLE_AGENT)`（注意：**没有** agentName 绑定）。
3. `tools/t37_claims_contention_live.mjs:111-116` 用 `tools/lib/ms_token.mjs` 的 `connectMindserver()` 建 BoardClient；该 helper 取 token 是 **env 优先**（`readMindserverToken()` 先读 `process.env.MINDSERVER_TOKEN`）⇒ 拿到的是 agent 凭据。
4. `src/mindcraft/auth_gate.js:195-207` `credentialRole()` 据此判定 `role = 'agent'`。
5. `src/agent/library/board_server.js:248-254`：`board:hello` 的 **agent 分支**要求 `socket.data.agentName` 已被 `login-agent` 盖戳，为空即 `NO_PERMISSION`。t37 **从未发过 `login-agent`**；而 `t37:121` 又把 hello 的失败用 `try/catch` 吞了（`for (const c of [A,B]) { try { await c.hello(); } catch {} }`）。
6. `src/agent/library/board_server.js:296-298`：随后每次 `board:reserve` 走 `actingBot()`，`role=agent` 且 `bots` 为空 → `NO_PERMISSION`「这条 agent 连接还没发 board:hello」⇒ 12 条断言全红。

**探针实证**（`evidence/probe-board-role.log`，临时脚本已删；起 mindserver + 1 条 socket，`MC_BOTS_ROOT` 指向临时目录，不碰任务板真库）：

```
env MINDSERVER_TOKEN 前 8 位: dc5cb0b0          ← 父进程内被换成了 agent 凭据（每次随机，故与 t37 的取值不同）
board:hello ack   = {"ok":false,"code":"NO_PERMISSION",
  "reason":"这条 agent 连接还没完成 agent 握手（socket.data.agentName 为空）：先 login-agent 再来 board:hello"}
board:reserve ack = {"ok":false,"code":"NO_PERMISSION",
  "reason":"这条 agent 连接还没发 board:hello，无法确定身份"}
```

⇒ **claims 场景本轮结论 = 「未验证」**：产品侧的预约/冲突/反向对照逻辑**一条都没被执行到**，不能据此说产品有问题，也不能说它没问题。t23 当初给 t37 补握手 token 时修的是「裸 socket 被 `AUTH_REQUIRED` 拒」；R6 阶段 1 引入 **agent/panel 双凭据**后，这条路又断了一次 —— 属于同一族「看起来跑了、其实没跑」，只是这次**至少 exit 1 + 逐条 FAIL**，没有假绿。

### 8.2 restart：**exit 0，13/13 全通过**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/e2e.ps1 -Scenario restart -KeepRun
```

| 耗时 | exit | 断言统计 |
|---|---|---|
| **55s** | **0** | **`E2E 通过：13/13 条断言全部通过`** |

日志：`evidence/e2e-ps1-restart-keeprun.log`（总）、`evidence/e2e-restart-stage.log`（第一段 2/2）、`evidence/e2e-restart-verify.log`（重启后 5/5）

关键日志行（t37 之外的场景工具 `tools/e2e_restart_live.mjs`，两段起服各一次 `Done (` + RCON 可用）：

```
PASS  第一次起服：Done ( 且 RCON 可用 —— 日志 ...\tmp\e2e\restart\server.log
[stage]  Saved memory to: ...\bots/e2eRestart/memory.json
PASS  停服前：箱子内容已就位（真 bot 复核） —— 3 种物品
──────── 2/2 条通过 ────────
PASS  第一次停服（优雅退出） —— RCON stop → java 进程退出
PASS  重启后起服：Done ( 且 RCON 可用
PASS  箱子内容在重启后完好（真 bot 打开箱子逐项比对 id + 数量） —— 3 种物品逐项一致
PASS  熔炉产物在重启后仍在（真 bot 读产物槽） —— input=?|0 fuel=coal|7 output=iron_ingot|1
PASS  熔炉确实工作过且状态跨重启保留（煤被消耗 + 产出铁锭 + 进度区间自洽） —— 煤 8→7（燃烧过）
PASS  bot 记忆在重启后可读回（真实 History.load()） —— 命中标记 E2E-MEMORY-KEEP-20261111234046
PASS  bot 记忆里的地点库（memory_bank）也还在 —— memory_bank 命中
──────── 5/5 条通过 ────────
PASS  第二次停服（优雅退出） —— RCON stop → java 进程退出
PASS  重置后世界 = 模板世界（重置生效） —— 逐文件 sha256 比对
```

⇒ 「跨重启丢不丢」这条 ADR 判据（箱子 / 熔炉产物与燃烧进度 / `memory.json` / `memory_bank`）**在真服、真 bot、官方一条命令下全部成立**，比 §2.4 那轮手工路径的证据更强（这次两段起服都是脚本自己起的）。

### 8.3 本轮查实的缺陷（只记录，**未改代码**）

#### 8.3.1【高】`tools/t37_claims_contention_live.mjs` 在 R6 agent 凭据下必红（12/13）

- **文件:行**：`mindcraft/tools/t37_claims_contention_live.mjs:57`、`:111-116`、`:121`
- **现象**：`board:hello` / `board:reserve` 全部 `NO_PERMISSION`；`E2E 失败：5/10`，exit 1
- **服务端原文**：`这条 agent 连接还没完成 agent 握手（socket.data.agentName 为空）：先 login-agent 再来 board:hello`
- **复现命令**：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/e2e.ps1 -Scenario claims`（43–59s，稳定复现 2/2）
- **成因**：见 §8.1.1（父进程内起 mindserver → env 被换成无 agentName 的 agent 凭据 → 没 `login-agent` 就 hello）
- **两种修法（供拍板，本轮不动）**：
  - (a) t37 显式用**面板**凭据（读 `.mindserver-token` 文件那条路径，而不是 env 优先），并把 `hello()` 的返回值断言出来；
  - (b) t37 在 `board:hello` 前补 `login-agent`（需要按名字拿一只 bot 的凭据）。
  - 顺带建议：`ms_token.readMindserverToken()` 的「env 优先」对**在父进程内起 mindserver**的工具是个陷阱，可在拿到 agent 凭据且未 `login-agent` 时直接显式报错（别让它退化成逐条 FAIL）。

#### 8.3.2【中】t37 第 ⑤ 条是**空断言假通过**

- **文件:行**：`mindcraft/tools/t37_claims_contention_live.mjs:184-185`
- **现象**：本轮 12 条全红的情况下，⑤ 仍 `PASS`，附 `{"before":0,"after":0}` —— 因为 `reserve` 根本没落行，`before=0`，于是「`after.length===0`」**恒真**。
- **危害**：直接违反该断言自己的目的（防"永久占用"）。空断言会在别的失败旁边冒充绿灯，正是本任务的「不要假绿」要求要挡住的东西。
- **应改为**：断言 `before.length === 1 && after.length === 0`（先证明约上了，再证明被清掉）。
- **复现命令**：同 §8.3.1；看 `evidence/e2e-claims-scenario.log` 末段 `{"before":0,"after":0}`。

#### 8.3.3【中】失败现场被脚本自己删掉 —— 默认跑法拿不到失败证据

- **文件:行**：`scripts/e2e.ps1:575-577`（`if (-not $KeepRun) { Remove-RunDirSafe -Dir $runDir }`，`finally` 里 `:597` 还有一次）
- **现象**：`-Scenario claims` 默认跑法（不带 `-KeepRun`）在失败后照样删掉 `tmp/e2e/claims/`，而 t37 的原始输出（`scenario-claims.log`，含每条 FAIL 的 `{ok,code,...}` 原文）**只**写在该目录里 ⇒ 想知道"为什么红"，必须**再跑一遍并加 `-KeepRun`**（本次就是这么取的证，白花一轮 43s）。
- **建议**：失败路径（`$ok -lt $all`）也保留运行目录，或把 `scenario-*.log` 复制进 `evidence/` 后再删。
- **复现命令**：`... -Scenario claims`（不加 `-KeepRun`）→ `ls tmp/e2e/` 为空。

#### 8.3.4【低】`progress=nulls` 是字符串化伪影，不是状态异常

- **文件:行**：`mindcraft/tools/e2e_restart_live.mjs`（熔炉进度拼接处）
- **现象**：PASS 行里出现 `progress=nulls fuelSeconds=nulls`。原因是模板串里 `${v}s` 遇上 `undefined` ⇒ `"undefineds"` 被截断/未定义值先被 `String()` 处理成了 `null` 前缀；**不影响判定**（那条断言看的是「煤被消耗 + 有产物 + 区间自洽」，实际煤 8→7、产出 `iron_ingot|1`），但读日志的人会误以为进度丢了。
- **建议**：改成 `progress=${v ?? '(无)'}`。

### 8.4 清理记录（必须项）

| 检查 | 结果 |
|---|---|
| 端口 25566 / 25576 / 18093 | **全部空闲**（`netstat -ano` 无监听） |
| 本线 `java` 进程 | **0**（按命令行过滤 `*tmp\e2e*` 的 `java.exe` 计数 = 0；两段起服都由 `Stop-TestServer` 的 RCON `stop` 优雅退出，`Add-Result 停服` 均 PASS） |
| 本线 `node` 进程 | **0**（t37 的 mindserver 随 t37 进程退出；探针进程已退） |
| `tmp/e2e/{claims,restart}` | 已删（先 `cmd /c rmdir` 摘 `libraries`/`versions`/`cache` 三个 junction，再 `-Recurse`），`tmp/e2e` 现为空 |
| `server-test/{libraries,versions,cache}` | **完好未被删**：75M / 28M / 55M，`libraries` 119 文件（与 §1 前置核对一致）—— junction 先摘再删的修复在本轮两次清理里都生效 |
| 探针临时物 | `/tmp/probe-board-role.mjs`、`%TEMP%\probe-bots-*` 已删；只在 `mindcraft/.mindserver-token`（gitignore）留下正常轮换的 token |
| 残留进程归属（**未动，非本线**） | `node serve-8081.mjs`（并行「冒烟 8081」线）、`java ...tmp\panel-accept\root\server\server.jar` + `node init_agent.js -p 8080`（并行「启动链 8080+25565」线）。按 e2e.ps1 的原则**只杀自己起的 pid**，这些一律未碰 |

### 8.5 证据文件清单（新增）

| 文件 | 内容 |
|---|---|
| `evidence/e2e-ps1-claims.log` | claims 第 1 轮总日志（59s，exit 1，5/10） |
| `evidence/e2e-ps1-claims-keeprun.log` | claims 第 2 轮（`-KeepRun`，43s，exit 1，逐条同） |
| `evidence/e2e-claims-scenario.log` | t37 原始输出：版本自证 + 12 条 FAIL 原文 + `1/13` |
| `evidence/e2e-ps1-restart-keeprun.log` | restart 总日志（55s，exit 0，13/13） |
| `evidence/e2e-restart-stage.log` | restart 第一段（stage 2/2） |
| `evidence/e2e-restart-verify.log` | restart 第二段（verify 5/5） |
| `evidence/probe-board-role.log` | 只读探针：`board:hello` / `board:reserve` 的 `NO_PERMISSION` 服务端 reason 原文 |
