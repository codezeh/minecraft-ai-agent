# P1-3 + P2-7 部署侧修复：compose 重复 `environment` + Java 进程按**本项目绝对路径**识别

> 第五轮外部审查（fixes5）· 2026-11-13 · 任务 **t3**
> 改动范围：`mindcraft/docker-compose.yml`、`scripts/**`、`docs/**`。
> 未动：`mindserver.js`、`web/**`、`board_*`、`src/agent/**`。
> 回归：`node scripts/tests/ops-regression.mjs` → **117 passed / 0 failed**（基线 87 + 新增 30）。

---

## 1. P1-3：`docker-compose.yml` 同级 `environment` 重复

### 1.1 缺陷原貌（实测，不是推测）

`mindcraft/docker-compose.yml` 的 `services.mindcraft` 下有两个**同级** `environment:`：

| 行 | 内容 |
|---|---|
| `:4` | `environment:` → `SETTINGS_JSON`、`MIND_SERVER_HOST: "0.0.0.0"`、`MINDSERVER_TOKEN` |
| `:21` | `environment:` → `MC_WORLD_DIR: /app/world` |

两种解析器给出两种坏结果：

| 解析器行为 | 后果 |
|---|---|
| 严格 YAML（`yaml` 包的 `uniqueKeys: true`、Go/Python 严格模式） | **直接报错**：`mapping key "environment" already defined at line 4` ⇒ compose 起不来 |
| 宽容解析（js-yaml 默认以外的宽松实现、部分 compose 方言） | 后者覆盖前者 ⇒ 只剩 `MC_WORLD_DIR`，**`MIND_SERVER_HOST` 与 `MINDSERVER_TOKEN` 静默丢失** |

第二种更危险：容器照样起来，但（a）容器内只绑回环，发布出去的端口永远连不到；(b) 宿主拿不到控制台令牌。两种症状都只在容器日志里留下间接痕迹。

新增门禁在**提交版**（缺陷版）上的实测输出：

```
FAIL  compose 门禁：.tmp-old-compose.yml
      · 重复键：environment（第 4 行与第 21 行同级重复）
      · environment 缺变量 SETTINGS_JSON（容器内的 settings.js 覆盖项）
      · environment 缺变量 MIND_SERVER_HOST（控制台监听地址（丢了容器就只绑回环，发布后连不到））
      · environment 缺变量 MINDSERVER_TOKEN（控制台握手令牌（丢了宿主拿不到 token））
      · services.mindcraft 的 environment 出现了 2 次（必须是 1 次）
```

行号与报告一致（4 / 21），说明门禁复现的是**真缺陷**，不是别的东西。

### 1.2 修法：合并成一个映射（不是"删掉后一组"）

`docker-compose.yml` 的改动是**只删掉 `:21` 那一行 `environment:` 键**，让它原有的注释与 `MC_WORLD_DIR` 落到 `:4` 那个映射里。
用 diff 的话就是 1 行删除 + 1 行说明注释；**没有重排、没有改写任何变量值**。

合并后（`mindcraft/docker-compose.yml`）：

```yaml
    # ★ P1-3：所有环境变量收在这一个 environment 映射里（重复的同级键会让严格 YAML 报错，宽容解析只留最后一个 ⇒ 静默丢键）
    environment:
      SETTINGS_JSON: |
        {"auto_open_ui": false}
      MIND_SERVER_HOST: "0.0.0.0"
      MINDSERVER_TOKEN: "${MINDSERVER_TOKEN:?请先设置 MINDSERVER_TOKEN…}"
      MC_WORLD_DIR: /app/world
```

为什么不是"把两个块内容拼起来重写"：原文件里 `MIND_SERVER_HOST`（OPS-010）与 `MINDSERVER_TOKEN`（F3）都带着**事故复盘注释**（为什么用 env 而不是 bind-mount token 文件）。重写会顺手丢掉这些证据。合并保留全部原有注释。

### 1.3 发布门禁：`scripts/compose-gate.mjs`（node 解析，不依赖 docker CLI）

约束与取舍：

| 方案 | 结论 |
|---|---|
| `docker compose config` | ❌ 本机 docker compose 插件不可用（captain 实测），门禁不能依赖 docker CLI |
| `import yaml from 'yaml'` / `js-yaml` | ❌ 这两个包只作为 `mindcraft/node_modules` 的**传递**依赖存在，本仓 `package.json` 没声明；重装依赖树就可能消失 ⇒ 门禁会变成"有的机器过、有的机器炸" |
| 自写最小校验（本方案） | ✅ 只用 node 内置 `fs`/`path`，零新依赖 |

`compose-gate.mjs` 做的事：

1. **解析**（compose 用得到的 YAML 子集）：块映射、块序列、块标量（`|` / `>`）、单双引号、行内注释、Tab 缩进报错。
   解析器**故意保守**：只认「冒号后跟空白或行尾」的映射写法（`a:b` 在 block 上下文里是普通标量，正好避开 `- ./settings.js:/app/settings.js` 这种端口/卷写法被误当键）。
2. **重复键判死**：同一映射层级出现同名键 ⇒ `重复键：<key>（第 X 行与第 Y 行同级重复）`。这条就是 P1-3 的缺陷本体，且不依赖任何变量名。
3. **预期变量都在**（这是"宽容解析只留后者"的兜底）：

| 变量 | 期望 | 丢了会怎样 |
|---|---|---|
| `SETTINGS_JSON` | 非空块标量 | 容器 settings 覆盖项丢失 |
| `MIND_SERVER_HOST` | `"0.0.0.0"` | 容器只绑回环，发布后连不到 |
| `MINDSERVER_TOKEN` | 必须是 `${MINDSERVER_TOKEN:?…}` 形式 | 宿主拿不到握手令牌（或起一个拿不到令牌的容器） |
| `MC_WORLD_DIR` | `/app/world` | 重建容器即换 `world_id`，面板看起来"被清空" |

4. **`environment` 只出现一次**：按 `^ {4}environment:` 计数（可读的第二道，第一道是重复键判死）。

接线：`scripts/release.ps1` 的 `[1/8] 环境前置` 里，`node` 可用性检查之后立刻跑门禁；非零退出由 `Invoke-Tool` 直接 `Stop-Release`（不会落到 `docker build` 才炸）：

```
$composeGate = Join-Path $PSScriptRoot 'compose-gate.mjs'
Invoke-Tool -Command @('node') -Arguments @($composeGate) -WorkDir $RepoRoot | Out-Null
```

覆盖边界（写在代码注释里、也写在这里）：序列项**不展开**成嵌套映射（本项目 compose 没有这种构造），flow 风格（`{a: b}`）不支持。这两类如果以后真的用上，门禁会报"不是合法的键值行"而不是静默放过 —— 宁可红，不可假绿。

---

## 2. P2-7：别的 Java 进程阻塞停服后备份

### 2.1 缺陷原貌

| 位置 | 原实现 | 后果 |
|---|---|---|
| `scripts/stop-panel.ps1:66`（原行号） | `Get-Process -Name java, javaw` 等**系统里所有** java 退出（最多 60s） | 另跑一台 MC / 一个 IDE / 一个普通 java 应用 ⇒ 等满 60s ⇒ 跳过自动备份 |
| `scripts/backup-world.ps1:225`（原行号） | 命令行 `-match 'server\.jar|paper|spigot|bukkit'` 的**任意** java 都算"本项目服务端在跑" | 别的目录的 `server.jar`、甚至 `paper-api.jar` 的开发机 ⇒ 冷备被拒（exit 2），本项目服务端其实已经停了 |

两处判据还**不一致**：`start-panel.ps1` 早在 OPS-009 就已改成"只认 `<root>\server\server.jar` 绝对路径"，而 stop/backup 还停在旧判据。这就是"同一个事实有两份实现"的典型后果。

### 2.2 判据收敛：`scripts/lib/server_proc.ps1`（唯一真相）

```powershell
ConvertTo-CmdKey              # 小写 + '/' → '\'
Get-ServerJarNeedle           # <root>\server\server.jar 的规范绝对路径
Test-OwnServerCommandLine     # 纯函数：命令行里是否含上面这个绝对路径
Get-OwnServerJava             # 进程表 → 本项目的 java 进程（-ProcessTable 可注入）
```

关键设计：

* **判据 = 绝对路径包含**。`E:\proj2\server\server.jar` 不会被 `E:\proj\...` 误匹配（目录名多一个字符就不行），`D:\OtherMC\server.jar` 更不行。
* **进程表可注入**：`-ProcessTable @([pscustomobject]@{ProcessId=…; CommandLine=…})`。所以判据能被单测**直接调用**，不必真起一台服；默认 `$null` 时才去查 `Get-CimInstance Win32_Process`（`java.exe` / `javaw.exe`）。
* **ASCII-only + 无导入期 I/O**：Windows PowerShell 5.1 把无 BOM 的 `.ps1` 当 ANSI 读，中文会变乱码；本文件不含中文，可被任何脚本或测试安全 dot-source。文件本身仍按仓规存成 **UTF-8 + BOM**。

三处接线（判据只有一份）：

| 脚本 | 改动 |
|---|---|
| `scripts/start-panel.ps1` | `Get-ServerJava` 改为委托 `Get-OwnServerJava`（删掉内联的 CIM 匹配）。**注意**：无匹配时仍返回 `$null`（不是空数组）—— 下游 `if ($null -eq (Get-ServerJava))` 就是"进程已退出"的判据，返回空数组会让它永假 ⇒ 冷启动被当成"进程还活着"而一直等 |
| `scripts/stop-panel.ps1` | 等待循环 `Get-Process -Name java, javaw` → `Get-OwnServerJava -ProjectRoot $root`；日志与提示改成"本项目的服务端进程" |
| `scripts/backup-world.ps1` | `Get-WorldEvidence` 里"任意 java 匹配 `server.jar|paper|…`" → `Get-OwnServerJava`；`session.lock` 检查**原样保留**（三个维度各查一次 `Test-PathLocked`） |

### 2.3 保留 `session.lock`，并说清"CIM 读不到"时的新语义

`Get-WorldEvidence` 的第一段（`server/world|world_nether|world_the_end/session.lock` 是否被独占）**未改动**，它才是运行期的硬证据：Paper 在跑就必然独占 `session.lock`。

变化的是 catch 分支：原来 CIM 失败时把**所有** java 进程当占用（`$ev += "java 进程 PID=…（无法读取命令行）"`），这正好是 P2-7 的缺陷本身。现在改为：CIM 读不到时**不**拿"所有 java"当占用，只打一行 WARN，靠 `session.lock` 兜底。

风险评估：CIM 读不到命令行 = 拿不到任何进程级证据，此时"宁可错放"比"宁可错挡"更符合本缺陷的目标（正常运行期由 `session.lock` 拦住；能读到命令行时按路径精确判）。这条取舍写在代码注释里，避免以后被当成"漏判"改回去。

---

## 3. 验证（全部为本机实测输出）

### 3.1 回归（基线不回归 + 新增断言）

```
$ node scripts/tests/ops-regression.mjs
...
ALL PASS: 117 passed, 0 failed        # 基线 87 + 新增 30
```

新增断言分两组（运行时断言 30 条 = P1-3 13 + P2-7 17；源码里 27 个 check( 调用点，其中 1 个在 4 元素循环里）：

**P1-3（13 条）**：门禁脚本存在 / 真实 compose 通过 / 同级 `environment` 计数 = 1 / 四个变量都在 / 旧缺陷形态（两段 environment）已消失 / **三条夹具**：

| 夹具 | 期望 | 实测 |
|---|---|---|
| 合并正确的 compose | 绿 | `status=0` |
| 复现原缺陷（两个同级 `environment`） | 红，且理由是"重复键" | `· 重复键：environment（第 3 行与第 5 行同级重复）` |
| 合并正确但缺 `MIND_SERVER_HOST` | 红，并点名缺的变量 | `缺变量 MIND_SERVER_HOST` |

绿/红双向都有，说明门禁既不是恒红也不是同义反复。

**P2-7（17 条）**：真 PowerShell dot-source 判据库 + 注入假进程表：

```
{"own":true,"other":false,"adjacent":false,"plain":false,"nullCmd":false,"fwd":true,"upper":true,"count":1,"pid":100}
```

| 用例 | 结果 |
|---|---|
| ① 本项目 `E:\proj\server\server.jar` 进程 | `own=true`、`count=1`、`pid=100`（只挑出它） |
| ② `D:\OtherMC\server.jar`（别的 MC） | `other=false` |
| ② `E:\proj2\server\server.jar`（名字相近的旁路目录） | `adjacent=false` |
| ③ `-jar C:\\tools\\desktop-app.jar`（普通 java 应用） | `plain=false`（不阻塞） |
| 命令行读不到（null） | `nullCmd=false`（不误判） |
| 正斜杠 / 大小写混合 | `fwd=true`、`upper=true` |

外加接线断言：stop-panel 不再 `Get-Process -Name java`；backup-world 不再有 `server\.jar|paper|spigot|bukkit` 字样匹配；`session.lock` 闸门仍在；start-panel 与 stop/backup 共用同一判据且无第二份内联实现。

### 3.2 `.ps1` 语法与编码（PS 5.1 解析器）

```
FILES=21 ERRORS=0
NO_BOM=                     # 空：scripts/** 下 21 个 .ps1 全部 UTF-8 带 BOM（EF BB BF）
```

### 3.3 真机干跑（不 spawn 任何进程）

```
$ powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-panel.ps1 -DryRun
[1/4] Minecraft 服务器    → [DRYRUN] 本应启动（已短路，不会 spawn）
...
[DRYRUN] 演练完成：前置检查全部通过，未启动任何进程、未打开浏览器。
exit=0
```

同时验证了共享判据在真机上的行为（默认 CIM 分支，本机当前没有 java 进程）：

```
jar 判据 = e:\\我的世界ai\\server\\server.jar
系统 java 进程数 = 0 ; 本项目 = 0
```

### 3.4 反向验证（证明这些断言能抓到回退）

| 回退 | 结果 |
|---|---|
| 把 `git show HEAD:docker-compose.yml`（缺陷版）喂给门禁 | 红，行号 4/21 与报告一致 |
| 夹具里复现两个 `environment` | 红，理由"重复键" |

---

## 4. 变更清单

| 文件 | 性质 | 说明 |
|---|---|---|
| `mindcraft/docker-compose.yml` | 改 | 删掉第二个同级 `environment:` 键（1 行）+ 1 行说明；四个变量与原有复盘注释全保留 |
| `scripts/compose-gate.mjs` | 新增 | compose 门禁：YAML 子集解析 + 重复键判死 + 预期变量断言；零新依赖 |
| `scripts/lib/server_proc.ps1` | 新增 | "这个 java 是不是本项目服务端"唯一判据；可注入进程表，纯函数可单测 |
| `scripts/stop-panel.ps1` | 改 | 只等本项目服务端进程；dot-source 共享判据 |
| `scripts/backup-world.ps1` | 改 | 证据只收本项目服务端进程；`session.lock` 保留；CIM 失败不再拿"所有 java"当占用 |
| `scripts/start-panel.ps1` | 改 | `Get-ServerJava` 委托共享判据（保留 `$null` 语义） |
| `scripts/release.ps1` | 改 | `[1/8]` 环境前置里加 compose 门禁（`Stop-Release` 硬失败） |
| `scripts/tests/ops-regression.mjs` | 改 | 新增 30 条断言（P1-3 夹具三态 + P2-7 三组用例 + 接线） |
| `docs/audit-r6/fixes5/deploy.md` | 新增 | 本文 |

## 5. 已知边界（未做 / 不在本任务）

* `scripts/verify-world-backup.ps1`、`scripts/e2e.ps1` 未改动：它们不参与"停服后备份"的进程判据，改动会扩大回归面。
* 门禁只校验 `services.mindcraft.environment`；其他 service（`viaproxy`）的端口/卷不在 P1-3 的验收范围内（R6 #52 已由既有断言覆盖"只绑回环"）。
* `docker compose config` 在本机不可用 ⇒ 没有做"真实 compose 语义"的交叉验证；门禁的严格性由"重复键判死 + 显式变量期望值"承担，不依赖 docker。
