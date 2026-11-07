# A2 · 可验证的备份与恢复（世界 + 任务板库 + 机器人记忆）

- 审计面：用户优先级 2 —— "不只是定期复制世界文件，还要对 **世界 + 任务板 DB + 机器人记忆** 做一致性备份，并定期验证能恢复"
- 日期：2026-11-07（Asia/Shanghai）
- 纪律：**未修改任何代码**；实验只在 `tmp/` 与 `%TEMP%` 内进行；`server/`、`backups/`、`bots/` 只读
- 标注口径：**已实测**（本轮跑过）/ **静态确证**（读码或读盘可确定）/ **推断**（未直接验证）
- 已知未修 `(已知未修)`；本轮新发现 `(新)`

---

## 0. 结论先行

| # | 结论 | 标注 |
|---|---|---|
| C1 | 仓库里**没有任何一次**由 `backup-world.ps1` 产出的备份（`backups/world-<时间戳>/` 一个都不存在），最新世界快照仍是 **2026-10-18** 的手工 zip/解压目录 | 静态确证 |
| C2 | `backup-world.ps1` 的**热备份路径根本跑不通**：服务端运行时会独占 `world/session.lock` 与 `world/region/*.mca`，`Compress-Archive` 随即抛错，**连 zip 都不会生成**（脚本 `$ErrorActionPreference='Stop'` → 直接 `exit 1`） | 已实测 |
| C3 | 同一机制下，mindserver 运行时 `board.sqlite`（WAL）也被独占打开 → `bots.zip` 同样压不出来。**热备份对"世界"和"机器人数据"两半都失败** | 世界侧已实测；bots 侧已实测（用真实 WAL 库复现） |
| C4 | `verify-world-backup.ps1` **会给出假绿灯**：我构造了"只剩 1/6 个 region、且完全没有 bots.zip"的备份 → 仍然 `ALL PASS`、退出码 0。它证明的只是"zip 没坏 + 至少有 1 个 mca"，**不证明能恢复** | 已实测 |
| C5 | 验证器**从不检查 `board.sqlite` 是否存在**（只认 `memory.json` 或 `terrain3d.db` 之一）。把 bots.zip 换成"只有一个 memory.json" → 仍然 `ALL PASS` | 已实测 |
| C6 | 不备份 WAL 会**静默丢数据**：只恢复 `board.sqlite`（不带 `-wal`）后 `integrity_check` 仍为 `ok`，但 `shared` 表行数 1→0。**任何"库能打开"的检查都发现不了** | 已实测 |
| C7 | `save-off` 成功、`save-all flush` 失败时，`$savedOff` 仍为 false → **finally 不会 save-on**，服务器自动保存被永久关闭（直到重启），此后所有改动只在内存 | 静态确证 |
| C8 | 全仓**零恢复演练**：`docs/真机-20261106/00-真机验收报告.md:4` 自陈"未执行…备份恢复"；`docs/audit/22-收口决定-OPS007与OPS012.md:53-59` 把 OPS-012 定为"不做（不建立定期备份，不做恢复演练）" | 静态确证 |
| C9 | 所有状态**都不在 git 里**：根仓 `.gitignore:13` 忽略整个 `/mindcraft/`、`:25` 忽略 `/backups/`、`:58-60` 忽略 `/server/world*/`、`:50-53` 忽略 `*.db`/`*.sqlite`；mindcraft 自己的 `.gitignore:8,72` 忽略 `bots/**/` 与 `bots/_board/`。**没有任何"从版本库回滚"的退路** | 静态确证 |
| C10 | 恢复**本身是可行的**：我用本轮真实快照在 `%TEMP%` 起了一个隔离服务端，`Done (17.318s)`、零 ERROR，RCON `stop` 后"All chunks are saved"。缺的不是能力，是**脚本、断言与例行执行** | 已实测 |

---

## 1. 覆盖矩阵（现有 `backup-world.ps1` 实际备份了什么）

脚本的实际取数只有 **4 项**（`scripts/backup-world.ps1:113-118`）：
`server/world`、`server/world_nether`、`server/world_the_end`、`mindcraft/bots`。

> 路径澄清：mindserver 以 `-WorkingDirectory <repo>\mindcraft` 启动（`scripts/start-panel.ps1:245`），
> `botsRootOf()` 默认返回 `./bots`（`mindcraft/src/agent/library/bot_paths.js:41-52`），
> 因此**线上机器人数据在 `mindcraft/bots`** —— 脚本这一处路径是**对的**。
> 仓库根的 `bots/` 是历史遗留（陈旧的第二份 `_board`），脚本不备份它。

| 数据 | 位置 | 在备份里？ | 被验证器检查？ | 证据 |
|---|---|---|---|---|
| 主世界 region/entities/poi/data | `server/world/` | 是（world.zip） | 仅"至少 1 个 `region/*.mca` 且首文件 ≥8192B" | `backup-world.ps1:113-116`；`verify-world-backup.ps1:82-84` |
| `world/level.dat` | 同上 | 是 | 仅 gzip 魔数 `1f 8b`（不解 NBT、不比对 LevelName） | `verify:102-110` |
| `world/playerdata/*.dat` | 同上 | 是（含在 world 目录内） | **完全不检查** | `verify` 无 playerdata 分支 |
| `world/advancements`、`stats`、`datapacks` | 同上 | 是 | 不检查 | 同上 |
| 下界 `world_nether/` | `server/world_nether/` | 是 | 只查 level.dat + 1 个 mca，**不解压** | `verify:99`（只解压 `world.zip`） |
| 末地 `world_the_end/` | `server/world_the_end/` | 是 | 同上 | 同上 |
| 机器人记忆 `memory.json` | `mindcraft/bots/<bot>/` | 是（bots.zip） | 仅"存在 ≥1 个" | `verify:86-90` |
| 地形库 `terrain3d.db`、`chunks.db`（WAL） | `mindcraft/bots/<bot>/map/` | 是（连 `-wal`/`-shm` 一起） | 仅"存在 ≥1 个" | 同上 |
| **任务板 `board.sqlite`（+ `-wal`/`-shm`）** | `mindcraft/bots/_board/` | 是（原始文件复制） | **完全不检查**（不在 `verify` 的匹配式里） | `verify:87` 只匹配 `memory.json`/`map/terrain3d.db` |
| 聊天历史 `histories/*.json` | `mindcraft/bots/<bot>/histories/` | 是 | 不检查 | — |
| bot 日志/action-code | `mindcraft/bots/<bot>/` | 是 | 不检查 | — |
| **CoreProtect 方块改动库（45.9 MB）** | `server/plugins/CoreProtect/database.db` | **否** | — | 脚本取数只有 4 项 |
| **服务端配置 `server.properties`（含 RCON 口令）** | `server/` | **否** | — | 同上 |
| **`ops.json` / `whitelist.json` / `banned-*.json` / `usercache.json` / `bukkit.yml` / `spigot.yml` / `config/`** | `server/` | **否** | — | 同上 |
| BlueMap 渲染数据（`server/bluemap` 175 MB） | `server/bluemap/` | **否** | — | 同上 |
| 服务端日志 `server/logs/` | `server/logs/` | **否** | — | 同上 |
| 根仓库遗留 `bots/`（第二份 `_board`） | `bots/` | **否** | — | 设计如此，但会造成"恢复到哪个库"的歧义 |
| mindcraft 配置/人格 | `mindcraft/config`、`profiles` | **否** | — | 同上 |

**明确没覆盖的（按恢复价值排序）**：CoreProtect 方块改动库 → 服务端权限与配置（`ops/whitelist/server.properties`）→ 插件配置与 BlueMap → 日志 → 根 `bots/`。

> 关于 CoreProtect：`backup-world.ps1` 头注释（`:7-9`）说"CoreProtect 记录方块改动，不能替代完整存档备份"——这句本身对，
> 但反过来也成立：**存档备份也不能替代 CoreProtect**（它是唯一的"谁改了什么"审计链，且不可重建）。

---

## 2. 一致性：`save-off` / `save-all flush` / finally / WAL / 跨进程

### 2.1 顺序本身是对的（已实测）
我按脚本的 RCON 报文序列（`backup-world.ps1:64-92`）对一个真实 Paper 1.21.8 发命令，逐包计时：

```
save-off        auth t=3ms   reply t=31ms  "Automatic saving is now disabled"
save-all flush  auth t=1ms   reply t=343ms "Saving the game (this may take a moment!)Saved the game"
save-on         auth t=2ms   reply t=5ms   "Automatic saving is now enabled"
```

- `save-all flush` 的应答**在落盘完成后才返回**（343 ms），且两条文案在同一包里 → 脚本"读两个包 + 睡 800ms"**确实等到了 flush**。顺序正确。
- 但 `Invoke-Rcon` 从不校验认证应答 id（-1=失败），只以"没抛异常"判成功（`:76-86`）→ **认证失败时可能被当成成功**（推断，未构造该场景）。

### 2.2 `finally` 恢复不可靠：标志位语义错了（静态确证）
```powershell
$ok1 = Invoke-Rcon ... 'save-off'
$ok2 = Invoke-Rcon ... 'save-all flush'
if ($ok1 -and $ok2) { $savedOff = $true }      # :101-104
...
finally { if ($savedOff) { Invoke-Rcon ... 'save-on' } }   # :150-155
```
- **只要 `save-off` 成功、`save-all flush` 失败**，`$savedOff` 就是 `false` → **永远不发 `save-on`**。
  而 `save-off` 已经生效，服务器此后**不再自动保存**，直到进程重启。这是"备份失败却把存档置于更危险状态"的典型反模式。
- 正确写法：`save-off` 一旦确认成功就置标志，`finally` 只依据该标志决定是否 `save-on`；`flush` 的成败单独记录。
- 另有：备份窗口内若 PowerShell 进程被 Ctrl+C/关窗杀掉，`finally` 不一定执行 → 自动保存可能一直关着（推断，取决于中断方式）。

### 2.3 热备份不可行（已实测，两条独立证据）
在同一台机器、真实 Paper 运行时，执行脚本的同一动作（`Compress-Archive` + `-ErrorAction Stop`）：

```
# 整目录（= backup-world.ps1:134 的行为）
RESULT=ZIP_FAIL: The process cannot access the file '...\world\session.lock'
                 because it is being used by another process.
no zip produced

# 只压 region/（把 session.lock 排除掉也不行）
FAIL world\region 0.03s  The process cannot access the file '...\world\region\r.-1.-1.mca'
                         because it is being used by another process.

# 只压其它部分（可行）
OK   world\level.dat 0.29s / world\playerdata 3.75s / world\data 0.06s
```

原因：Paper 在整个运行期持有 `session.lock` 的独占字节锁，并把 `region/*.mca` 的 `FileChannel` 缓存在
区域文件缓存里保持打开（具体缓存类名随版本不同，不影响结论）；`.NET` 的 `Compress-Archive` 以 `FileShare.Read` 打开文件，
与"另一进程持有写句柄/字节锁"冲突 → 抛 `IOException`。
脚本 `$ErrorActionPreference='Stop'`（`:38`）会把这条**非终止错误升级为终止错误** → 走 `catch`（`:147-149`）→ `exit 1`，
**manifest 不写、目录 `backups/world-<stamp>/` 已建但为空**。

> `save-off` 并不能救：它只关"自动保存"，**不会释放已打开的 region 句柄**。

### 2.4 机器人侧同样被锁（已实测）
用一个持有 WAL 连接的 `node:sqlite` 进程复现 mindserver 的持有方式，再压该目录：

```
RESULT=ZIP_FAIL: The process cannot access the file '...\board.sqlite'
                 because it is being used by another process.
```

即：**只要 mindserver 在跑，`bots.zip` 也压不出来**。结论：现脚本只能在**服务端与 mindserver 都停止**时工作（我按此模式实测成功，见 §4）。

### 2.5 WAL 一起备份了吗？—— 形式上备份了，语义上没有
`bots.zip` 是整目录压缩，`board.sqlite-wal`（32,992 B）与 `-shm`（32,768 B）会一起进包。
但"一起进包"不等于"一致"：

- `openBoard` 打开 WAL 且 `busy_timeout=5000`（`board_store.js:270-272`）；SQLite 自动 checkpoint 阈值约 1000 页（≈4 MB），
  而线上 WAL 只有 32 KB → **不会触发自动 checkpoint**。
- mindserver 关停走 `process.exit`（`mindcraft/src/mindcraft/mindserver.js:869-888` 只有 `shutdownOnce`；板库句柄在 `:337-358` 打开后**没有任何 `close()`**）
  → 进程退出时 WAL **不会 checkpoint、不会合并回主库**。
  ⇒ **最近的提交几乎全在 `-wal` 里**，主库 `board.sqlite` 停在上一次 checkpoint 的状态。

实测（把线上库拷到 `tmp/`，分别开）：

```
with WAL  integrity=ok uv=2 jobs=0 claims=0 shared=1
db only   integrity=ok uv=2 jobs=0 claims=0 shared=0     <-- 静默丢了 1 行
```

**恢复后丢什么**：上一次 checkpoint 之后的所有 write（任务单状态变更、claims 预约、shared 地标/箱子内容）。
它们的共同点是——**库仍然能打开、`integrity_check` 仍然 `ok`、界面照常工作**，只是"回到过去"。
对任务板尤其危险：`running` 的单会退回 `ready/done`，租约与 `attemptSeq` 一起回退 → 重复执行、重复扣料。

**恢复时的正确姿势**：`-wal` 必须与主库**作为一套**恢复，`-shm` 可丢（SQLite 会重建）。
若三份来自不同时刻（热备时必然如此），应**只保留 `db + wal`**，删掉 `-shm` 再打开。

### 2.6 bots/ 是否被 bot 进程同时写入？—— 是
- 写者：mindserver（board.sqlite，唯一写者，`board_store.js:1-25` 的设计说明）+ 每个 agent 子进程
  （`memory.json`、`histories/`、`map/terrain3d.db`、`map/chunks.db`）。
- 三者都**不是**原子快照：`writeFileSync` 直写 `memory.json`（`history.js:187`），
  SQLite 各自独立连接。备份期间任何一次写入都会与复制竞争。
- 因此存在**跨进程一致性**问题：board 记录"某箱已装 64 铁" ↔ 世界里的箱子 NBT（在 region 里）↔
  `memory.json` 的"记住的地点"三者可能来自三个不同时刻。

---

## 3. `verify-world-backup.ps1` 证明了什么 / 没证明什么

### 3.1 它实际做的（`verify-world-backup.ps1`）
1. manifest 存在可解析，大小与 SHA256 逐项比对（`:42-61`）；
2. 每个 zip 能打开，且：
   - `world*`：含 `level.dat`，含 **≥1** 个 `region/*.mca`（`:79-85`）；
   - `bots`：含 **≥1** 个 `memory.json` 或 `map/terrain3d.db`（`:86-90`）；
3. 只把 **`world.zip`** 解压到系统临时目录（`:99-101`），读 `level.dat` 前两字节是否 `1f 8b`（`:104-110`），
   第一个 `.mca` 是否 ≥8192 字节（`:112-116`）；随后删除临时目录；
4. 全过 → `ALL PASS` + 打印人工恢复步骤，`exit 0`；否则 `exit 1`（已实测退出码正确）。

### 3.2 它证明了什么
- zip 文件**字节级完整**（SHA256 对得上）；
- 有 `level.dat` 这个文件、有至少一个看起来像 mca 的文件、gzip 魔数对；
- 备份目录**不是空的**。

### 3.3 它**没有**证明什么（逐条，全部可从代码确证；(a)(b) 已实测）
| # | 未证明 | 说明 |
|---|---|---|
| a | **完整性**：少 5/6 个 region 也算 PASS（已实测） | 判据是 `Count -gt 0`（`:83-84`） |
| b | **`bots.zip` 存在**：整个机器人数据缺失也算 PASS（已实测） | 循环只遍历"存在的 zip"（`:67`），没有"manifest 应含 N 项"的清单断言 |
| c | **`board.sqlite` 在包里**：换成只有一个 `memory.json` 的 bots.zip 仍 PASS（已实测） | 匹配式只有 memory/terrain（`:87`） |
| d | 世界能**起服** | 从不启动任何进程 |
| e | 区块**能解析** | 只查首个 mca 的文件长度，不开 NBT |
| f | `level.dat` 内容有效 | 只查 gzip 魔数，不解压、不校验 NBT 结构与 `LevelName` |
| g | `playerdata` 存在/可读 | 无任何 playerdata 断言 |
| h | 净界/末地可读 | 只解压 `world.zip`（`:99`） |
| i | 任务板**行数**对不对 | 从不开库查询 |
| j | 记忆条数对不对 | 从不解析 `memory.json` |
| k | 备份是**同一时刻**的 | manifest 的 `consistent` 只反映"是否 save-off 过"（`:48-49`），且未 save-off 只 WARN 不 FAIL |

### 3.4 我构造的假绿灯（已实测，可复现）
取真实的 10-18 世界 zip（6 个 region），只留 1 个 region、**不放 bots.zip**，写一个自洽的 manifest，然后跑真脚本：

```
PASS world.zip 含 region/*.mca 1 个
PASS 解压后 level.dat 是合法 gzip/NBT
PASS 解压后 region 文件长度合理 r.-1.-1.mca 209439 字节
ALL PASS: 10 项通过，0 失败          [exit 0]
```

再补一个"只有一个 `memory.json`、没有 `board.sqlite`/`terrain3d.db`"的 bots.zip：

```
PASS bots.zip 含记忆/地形库 1 项
ALL PASS: 14 项通过，0 失败          [exit 0]
```

> 对照：真实的旧备份目录 `backups/world-preinstall-20261018-220642`（无 manifest、无 zip）→ 3 项 FAIL、`exit 1`。
> 也就是说：**验证器只擅长抓"目录放错/文件被改"，不擅长抓"内容不全"**。

---

## 4. 恢复演练：仓库里有没有"真恢复过一次"的证据？

### 4.1 结论：**没有**。一条都没有。
`grep -rIl '恢复演练|restore-drill|演练' docs scripts mindcraft/src` 在文档里只命中 1 个文件，
即**决定不做**的那份：

- `docs/audit/22-收口决定-OPS007与OPS012.md:53-59`
  > `## OPS-012 · 世界备份 —— 按用户决定：不做`
  > `- 不建立定期备份，不做恢复演练，不修改 server/ 运行时数据；`
  > 并注明两个脚本"保留为可选工具"。
- `docs/真机-20261106/00-真机验收报告.md:4`
  > `目的：补上…自陈未做的真机验证：「未执行真实游戏/收费模型、Docker 构建或备份恢复」。`
- `:65` 声称"用构造夹具做过 **PASS / FAIL 双向实测**"——那是**脚本单测**（把 mca 改成 100 字节），
  不是恢复演练，也**没有覆盖"缺文件"这一类**（见 §3.4）。

盘面证据同样为空：
- `backups/` 下**不存在任何 `world-<时间戳>/`**（脚本的产出目录）→ **该脚本从未成功跑过一次**；
- 仅有 `backups/world-1.21.8-20261018-185639.zip`（3.8 MB，6 region，10-18 18:56）与
  `backups/world-preinstall-20261018-220642/`（同日 22:06 的解压副本）——都是 **10 月 18 日、bot 上线之前**的手工快照；
- 无 manifest、无校验记录、无 drill 报告、无计划任务（`Get-ScheduledTask` 中没有任何与 Minecraft 备份相关的项）。

**能否证明"能恢复"？不能。** 现有材料最多能证明"有一个 20 天前的旧世界 zip，且它的 SHA256 能对上自己"。

### 4.2 但我可以证明"恢复路径本身是可用的"（已实测）
为了把"缺证据"与"做不到"分开，我在 `%TEMP%` 里做了一次**完整的一次性演练**（未触碰 `server/`）：

1. 用脚本同款方法冷备当前世界：`Compress-Archive server/world` → **74,209,079 B / 25.6 s**（源 121 MB、1503 文件、39 region）；
2. 把 `paper-1.21.8-60.jar` + `libraries`/`versions`/`cache` + `eula.txt` + 改写端口的 `server.properties`
   组装成隔离服务端（`%TEMP%\r4boot`，端口 25599 / RCON 25600）；
3. 解压备份进去（**1.4 s**，1503/1503 文件、39/39 region、`level.dat` 魔数 `1f 8b`）；
4. 用仓库自带 `.tools\jdk-21.0.12.1+1\bin\java.exe` 起服：
   `Done (17.318s)!`，日志中 **0 条 ERROR/Exception**，`Preparing level "world"` 正常；
5. RCON `stop` → `Stopping the server` → `All chunks are saved` / `All dimensions are saved`，进程退出码 0。

（该隔离端共起停 3 次，`Done` 分别 17.318 s / 11.977 s / 11.083 s，均零错误。）

**这说明**：世界数据本身是健康可恢复的；**缺的是把这条路径固化成脚本 + 断言 + 例行执行**。
也就是说，用户的诉求**可以通过纯增量交付满足**，不需要改游戏逻辑。

---

## 5. 最小可行方案：可重复的 restore-drill

### 5.1 设计原则
1. **绝不写真实数据**：一切在 `tmp/drill-<stamp>/` 内；用**独立端口**（25599/25600）与独立 `level-name`；
   演练结束可选保留产物，否则整体删除。
2. **恢复的是"备份包"，不是"服务器目录"**：先把 zip 解开，再装进"最小服务端骨架"——骨架来自
   `server/` 的只读复制（jar/libraries/versions/cache/eula），配置用模板覆盖（端口、RCON、`online-mode=false`）。
3. **断言分三层**：静态（不用起服，秒级）→ 起服（~20 s）→ 关停（~5 s）。任一层失败即 FAIL，并保留日志。
4. **报告结构化**：`report.json` + `report.md`，每项 PASS/FAIL + 实测值 + 耗时 + 备份来源路径。
5. **可重复**：`-BackupDir` 取"最新一份"或指定；退出码 0/1 可直接接计划任务或 CI。

### 5.2 需要的脚本（2 个新增 + 2 个改造）

**新增 `scripts/restore-drill.ps1`**（核心，约 200 行）
```
参数：-BackupDir <path>（默认 backups 下最新 world-*，无则 FAIL）
      -KeepArtefacts  保留 tmp/drill-<stamp>（默认删）
      -TimeoutSec 240
步骤：
 0 预检：.tools\jdk-*\bin\java.exe 存在；端口 25599/25600 空闲；剩余空间 ≥ 备份大小×2 + 400 MB
 1 建骨架：tmp/drill-<stamp>/server ← 只读复制 server\{paper jar→server.jar,libraries,versions,cache,eula.txt}
           写 server.properties 模板（server-port=25599, rcon.port=25600, rcon.password=<随机>, online-mode=false,
           level-name=world, sync-chunk-writes=true）
 2 恢复：解压 world.zip/world_nether.zip/world_the_end.zip → server\；bots.zip → drill\bots\
           （bots 拷贝时**只还原 db+wal，丢弃 -shm**）
 3 静态断言（不起服）
   A1 每个 world 的 region 数 == manifest.counts.<dim>.regions        （**这一条就能抓住 §3.4 的假绿灯**）
   A2 level.dat 魔数 1f 8b，且解压后 NBT 首字节为 0x0a（TAG_Compound）
   A3 playerdata 文件数 == manifest.counts.playerdata
   A4 每个 .mca 头可解析：扇区表长度 4096B，至少 1 个 chunk 偏移非 0
   A5 board.sqlite：打开成功、PRAGMA integrity_check = ok、user_version = 2
   A6 board 行数：jobs/claims/shared 三表 count == manifest.counts.board.*
   A7 memory.json：每个 bot 文件可 JSON.parse；bot 数 == manifest.counts.bots
   A8 覆盖完整性：manifest 声明的每类数据都存在（缺 world_nether/bots.zip 直接 FAIL）
 4 起服断言：Start-Process java -Xms1G -Xmx2G -jar server.jar nogui
   A9  180 s 内日志出现 `Done (`
   A10 日志 ERROR|Exception|corrupt|Failed to load 计数 == 0
   A11 RCON 可用（`list` 有回应）
 5 关停断言：RCON stop → 60 s 内退出 → 日志含 `All chunks are saved` / `All dimensions are saved`
 6 报告：tmp/drill-<stamp>/report.{json,md}；写 docs/audit-r4/drill-<stamp>/report.md 留档；exit 0/1
```

**新增 `scripts/backup-manifest-counts.ps1`（或并入 backup-world.ps1）**
- 备份**前**用只读连接统计：三世界 region 数、playerdata 数、bots 数、board 三表行数、各库 `user_version`；
- 连同 `git rev-parse HEAD`（根仓 + mindcraft 仓）、Paper/Java 版本、每个组件的 `snapshotAt` 一起写进 `manifest.json`。
- 没有这一步，drill 的 A1/A3/A6/A7 就**没有比对基准**。

**改造 `scripts/backup-world.ps1`（4 处，按必要性排序）**
1. **模式二选一，不再假装能热备**：
   - `-Mode Cold`（默认、推荐）：要求"java 进程不存在"（否则报错退出并提示 `stop-panel.ps1`）→ 直接压缩，不做 save-off；
   - `-Mode Hot`：仅在实现了"逐文件 `FileShare.ReadWrite` 复制到 staging + 锁定文件重试 + 复制后比对 size/mtime"后才允许；
     否则**明确拒绝执行**，并打印"请改用 Cold 或停机窗口"。
2. **SQLite 用原生快照**：先 `PRAGMA wal_checkpoint(TRUNCATE)`，再 `VACUUM INTO '<dest>/board.sqlite'`（或 `sqlite3 .backup`），
   **不要**直接复制 `db+wal`；`-shm` 永远不进包。
3. **修 finally 标志位**：`save-off` 成功即置 `$savedOff`；`save-on` 依据它执行，`flush` 成败单独记入 manifest。
4. **失败不留半成品**：写到 `world-<stamp>.partial/`，成功后 `Rename-Item`；并把 `session.lock`、`*-shm` 排除。
   另外把 `CoreProtect/database.db`、`server.properties`、`ops/whitelist/banned/usercache`、`config/`、`plugins/` 的
   **配置与数据库**（不含 jar/渲染图）纳入清单，或显式写入 manifest 的 `excluded` 字段并给出理由。

**改造 `scripts/verify-world-backup.ps1`（3 处）**
1. 把"≥1 个"改成"**与 manifest 计数相等**"（region/playerdata/bots/board 行数）；
2. 增加"manifest 声明的组件必须齐全"（缺 `bots.zip` → FAIL，而不是跳过）；
3. `bots` 分支必须**显式要求 `_board/board.sqlite`**，并做 `integrity_check`。

### 5.3 一条可重复执行的流程（建议 nightly）
```
每天 04:00（服务器无人）
  scripts\stop-panel.ps1                       # 优雅关服（已有，RCON stop）
  scripts\backup-world.ps1 -Mode Cold          # ~40 s（25.6 s 世界 + 12 s bots）+ 计数
  scripts\restore-drill.ps1                    # ~60-90 s：恢复→起服→断言→关停→报告
  scripts\start-panel.ps1
  失败则不要删除旧备份，并在面板/日志置红
```
（若不想每天停服：改成每周一次 Cold 全量 + 每日 Hot 只备 `bots`（SQLite 原生快照，秒级），
世界则依赖"玩家/机器人可接受回滚"的显式声明。）

### 5.4 成本
| 项 | 人时 | 说明 |
|---|---|---|
| `backup-world.ps1` 改造（冷/热分离、SQLite 快照、finally、partial、排除项） | 4–6 h | 主要是边界与错误路径 |
| manifest 计数 + `excluded` 清单 | 2–3 h | 需要只读开库与计数 SQL |
| `restore-drill.ps1`（骨架组装、12 条断言、报告、超时与清理） | 8–10 h | 一次写成后可复用 |
| `verify-world-backup.ps1` 收紧（计数、齐全性、board） | 2–3 h | 与 drill 共用计数逻辑 |
| 计划任务 + 失败告警 + 文档 | 1–2 h | `schtasks` 或面板按钮 |
| **合计（MVP）** | **17–24 h ≈ 2–3 人日** | 磁盘增量：每份备份 ~85 MB（74+9），7 份 ≈ 600 MB |
| 演练单次机器时间 | ~90 s | 实测：解压 1.4 s + 起服 17 s + 关停 5 s + 压缩 40 s |

> 若只做"能自证"的最小版本：先做 `restore-drill.ps1` 的 A1/A5/A9/A10 四条断言 + 计数 manifest，
> 约 **8–10 h**，即可把"能恢复"从口号变成每次可复现的证据。

---

## 6. board.sqlite 与 world 的一致性窗口 / bot 在备份期间继续改世界

### 6.1 当前的真实情况：不是"窗口多大"，而是"根本跑不起来"
热备路径在 `Compress-Archive` 第一步就失败（§2.3/§2.4），因此**今天不存在可观测的一致性窗口**——
只有"备份失败"。下面按"修好之后"讨论窗口，因为这是设计时必须回答的问题。

### 6.2 若按现有顺序冷备：窗口 = 0
`save-off` + `save-all flush` + **停掉 mindserver** 后，world 与 bots 都不再变化，
窗口为 0；代价是停机 ≈ 40 s（实测 25.6 s + 12.0 s + 开销）。

### 6.3 若保持"边跑边备"的原始设计：窗口 ≈ 26–38 s，且**方向固定**
脚本的取数顺序是 world → nether → end → bots（`backup-world.ps1:113-118`），实测：
- `world.zip` 25.6 s、`bots.zip` 12.0 s ⇒ **bots（含 board）比 world 晚 25.6 s 开始、最晚晚 37.6 s 结束**；
- 世界在 `save-all flush`（t≈0.34 s）时被"语义冻结"，而 board/memory 是 t≈26–38 s 的状态。

**恢复后的表现**（推断，机理明确）：
- board 说"这张单 done，方块已放置"，但 world 里那块方块**不存在** → 交付物缺失且无人报错；
- `memory.json` 说"某箱子已装满"，世界里箱子是 26 s 前的状态 → 后续取料失败/重复补料；
- `running` 单的租约/`attemptSeq` 回退 → 重启后重跑 → **合成单再扣一次材料**（`board_store.js` 的重试语义）。
- 反向问题也存在：world 里 26 s 内的改动（bot 放置/挖掘）在恢复后消失，而 board 已记完成。

### 6.4 bot 在备份期间继续改世界怎么办？三个可选答案
| 方案 | 做法 | 窗口 | 代价 |
|---|---|---|---|
| **A 停机（推荐）** | `stop-panel.ps1` → 冷备 → 起服 | **0** | 停机 ~40 s + 起服 ~17 s |
| **B 冻结板 + 只读世界** | ① 暂停派单（`board` 拒绝新 claim）；② `save-off`+`flush`；③ **先**用 `VACUUM INTO` 秒级快照 board/memory；④ 再慢慢压世界；⑤ `save-on` | ≈ **1 s**（板与世界 flush 的间隔） | 25.6 s 内 bot 仍会动世界但写不进磁盘（`save-off`），这些改动会**在备份里缺失**，需在 manifest 写明 `worldFrozenAt` 与 `botActiveDuringCopy=true` |
| **C 快照技术** | VSS 卷影复制 / `robocopy` 逐文件 `FileShare.ReadWrite` 复制到 staging 再压 | ≈ 0（VSS）/ 不确定（复制） | VSS 需要管理员与卷影配置；逐文件复制仍可能读到"半个 mca" |

**建议**：默认 A（成本最低、语义最干净）；需要"不停服"时用 B，并把 `worldFrozenAt` / `boardSnapshotAt`
两个时间戳写进 manifest，drill 时若两者相差 > 2 s 就输出 WARN（不 FAIL）。

---

## 7. 附：本轮实验产物与复现命令

产物（全部在 `tmp/` 或 `%TEMP%`，可删）：

| 路径 | 内容 |
|---|---|
| `tmp/r4-locktest/locktest2.ps1` | 字节锁 vs `Compress-Archive` 的最小复现（证明锁→抛错） |
| `tmp/r4-locktest/livezip.ps1` | 对真实运行中的 world / 目录做压缩（证明 session.lock、region、sqlite 三种锁） |
| `tmp/r4-locktest/measure.ps1` | 真实世界压缩+解压计时（25.6 s / 1.4 s，1503 文件、39 region 全等） |
| `tmp/r4-locktest/mkfixture.ps1` + `addbots.ps1` | 构造"只 1/6 region、无 bots.zip、bots 只含 memory.json"的假备份，用于打穿验证器 |
| `tmp/r4-locktest/rcon.mjs` / `rconprobe.mjs` | RCON 逐包计时（save-off / save-all flush / save-on） |
| `tmp/r4-board/{wal,nowal,root}/` | 线上 board 库的"带 WAL / 不带 WAL"对照（shared 1→0） |
| `%TEMP%\r4boot\` | 隔离恢复演练服务端（已停止；`boot.log`/`boot2.log`/`boot3.log`） |

关键复现命令：
```powershell
# 1) 热备必然失败（服务端在跑）
powershell -File tmp/r4-locktest/livezip.ps1 "<repo>\server\world" "$env:TEMP\x.zip"

# 2) 验证器假绿灯
powershell -File scripts/verify-world-backup.ps1 -BackupDir "$env:TEMP\r4verify\bk"   # -> ALL PASS, exit 0

# 3) 带/不带 WAL 的 board 还原对照
node tmp/r4-board/probe.mjs      # with WAL shared=1 ; db only shared=0 ; 两者 integrity 都 ok
```

## 8. 与既有审计文档的关系
- 报告第 3 条（`docs/audit/00-REPORT.md:80`）是"板库坏库重建"，已经修好（T30 §1）；
  **本文件不重复那条**，但指出它留下的近亲风险：`board.sqlite` 的**快照一致性**从未被处理过。
- `docs/audit/22-收口决定…:53-59` 把 OPS-012 判为"不做"。本轮不改这个决定，
  但把"不做"的**前置条件**写清楚：既然不做，就**不要**保留一个会在运行时失败、且验证器会假绿灯的工具链，
  否则它会在某天被当成"我们有备份"的依据（当前 `verify` 的 `ALL PASS` 正是这种误导）。
