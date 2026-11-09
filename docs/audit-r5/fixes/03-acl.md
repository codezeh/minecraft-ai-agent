# 修复 03：R5-009（server-test 配置 ACL）+ R5-010（mindcraft 父目录写权限）

> 只改 **ACL/权限**，未改任何 `.properties` 的**内容**，未碰 `server/`、`server-test/` 的 `world/`、`logs/`。
> 唯一的代码改动：扩展 `scripts/harden-credentials-acl.ps1`（保留原行为，新增 2 项能力）。

## 0. 结论速览

| 项 | 修复前 | 修复后 | 复跑命令 |
|---|---|---|---|
| R5-009 `server-test/server.properties` | 继承 ACL：`Authenticated Users:(I)(M)` + `Users:(I)(RX)` + AppContainer SID `(I)(W,D,DC)` ⇒ 本机任何用户**能读**明文 RCON 口令 | 非继承，只剩 `SYSTEM / Administrators / 当前账户` 三条 `(F)` | `powershell -File scripts\harden-credentials-acl.ps1 -Apply` |
| R5-010 `mindcraft/` 目录 | 显式 ACE 里 `Authenticated Users:(M)` + `(OI)(CI)(IO)(M)`，`Users` 也有可继承写位 ⇒ 别人可**删掉 keys.json 再放一个** | 非继承；`Authenticated Users:(OI)(CI)(RX)` 只读+遍历，**写/删/改位为 0** | 同上 `-Apply -GuardParentWrites` |

自检：**11/11 断言 PASS**（`acl-assert-after.txt`），harden 脚本 **exit 0**，幂等复跑 **exit 0**。

## 1. 复现命令（修复前 → 修复后）

```powershell
# ① 体检（不改）：默认只看三个文件；加 -GuardParentWrites 连 mindcraft 目录一起看
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\harden-credentials-acl.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\harden-credentials-acl.ps1 -GuardParentWrites

# ② 看原始 ACL
icacls server-test\server.properties
icacls mindcraft

# ③ 应用（幂等，可反复跑）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\harden-credentials-acl.ps1 -Apply -GuardParentWrites

# ④ 回归
node scripts/tests/acl-regression.mjs
```

## 2. 前后对比（`icacls` 真实输出）

### 2.1 R5-009 `server-test\server.properties`

**修复前**（`docs/audit-r5/evidence/fix/acl-before.txt`）

```
E:\\我的世界ai\\server-test\\server.properties S-1-4-48068235-1068318981:(I)(W,D,DC)
                                        BUILTIN\Administrators:(I)(F)
                                        NT AUTHORITY\SYSTEM:(I)(F)
                                        NT AUTHORITY\Authenticated Users:(I)(M)
                                        BUILTIN\Users:(I)(RX)
                                        Mandatory Label\Low Mandatory Level:(I)(NW)
```

**修复后**（`acl-after.txt`）

```
E:\\我的世界ai\\server-test\\server.properties NT AUTHORITY\SYSTEM:(F)
                                        BUILTIN\Administrators:(F)
                                        LAPTOP-GDE992NS\zeh:(F)
                                        Mandatory Label\Low Mandatory Level:(I)(NW)
```

- `(I)` 全部消失 ⇒ 继承已断开（显式 DACL）。
- `Authenticated Users`、`BUILTIN\Users`、AppContainer SID 三条过宽 ACE 全部移除。
- ★ **保留** `Mandatory Label\Low Mandatory Level:(I)(NW)`：那是**完整性标签（SACL）**，不是 DACL 授权；
  它限制"低完整性进程写入"，删掉反而是**放宽**。`Set-Acl` 只改 DACL，这条自然保留（这也证明本次没动 SACL）。

### 2.2 R5-010 `mindcraft\` 目录

**修复前**（`acl-before.txt`）

```
E:\\我的世界ai\\mindcraft NT AUTHORITY\Authenticated Users:(OI)(CI)(IO)(M)
                      NT AUTHORITY\Authenticated Users:(M)
                      NT AUTHORITY\SYSTEM:(F)
                      NT AUTHORITY\SYSTEM:(OI)(CI)(IO)(F)
                      BUILTIN\Administrators:(OI)(CI)(IO)(F)
                      BUILTIN\Administrators:(F)
                      BUILTIN\Users:(RX)
                      BUILTIN\Users:(OI)(CI)(IO)(GR,GE)
                      LAPTOP-GDE992NS\zeh:(F)
```

**修复后**（`acl-after.txt`）

```
E:\\我的世界ai\\mindcraft NT AUTHORITY\SYSTEM:(F)
                      NT AUTHORITY\Authenticated Users:(OI)(CI)(RX)
                      BUILTIN\Administrators:(OI)(CI)(F)
                      NT AUTHORITY\SYSTEM:(OI)(CI)(F)
                      LAPTOP-GDE992NS\zeh:(OI)(CI)(F)
                      NT AUTHORITY\SYSTEM:(OI)(CI)(IO)(F)
                      BUILTIN\Administrators:(OI)(CI)(IO)(F)
                      BUILTIN\Administrators:(F)
                      LAPTOP-GDE992NS\zeh:(F)
```

- `Authenticated Users` 由 **`(M)` / `(OI)(CI)(IO)(M)`** 变成 **`(OI)(CI)(RX)`** ⇒ 只剩 读+遍历，**没有任何写/删位**。
- `BUILTIN\Users` 的 `(RX)` / `(OI)(CI)(IO)(GR,GE)` 被摘下（`Authenticated Users:(RX)` 已覆盖"已认证账户可读"这一诉求，不重复留两条）。
- 剩下的 `268435456`（= `GENERIC_ALL`）条目只属于 `SYSTEM` / `Administrators`（白名单主体），不影响判定。

### 2.3 子对象继承（证明"别人删不掉再放一个"）

```
E:\\我的世界ai\\mindcraft\\settings.js NT AUTHORITY\Authenticated Users:(I)(RX)
                                BUILTIN\Administrators:(I)(F)
                                NT AUTHORITY\SYSTEM:(I)(F)
                                LAPTOP-GDE992NS\zeh:(I)(F)
```

子文件现在只继承到 `(I)(RX)`。关键点不是"文件可读"，而是**父目录不再给 `DeleteChild`**：
别人即使能读 `keys.json`，也不能删掉它再放一个新的同名文件。

## 3. 脚本改了什么（唯一被改的代码文件）

`scripts/harden-credentials-acl.ps1`（原 204 行 → 现 259 行）。**保留原有全部行为**，新增三处：

| 改动 | 说明 |
|---|---|
| `$fileTargets` 增加 `'server-test\server.properties'` | R5-009：把它纳入与主服同一套"非继承 + 三条 ACE"收口 |
| 新参数 `-GuardParentWrites` | R5-010：对 `$dirTargets`（`mindcraft`）做**去写保读**；不传则目录完全不被触碰（= 原行为） |
| 新函数 `Set-DirWriteGuard` | 用 **`icacls`**（`/inheritance:r` → `/remove:g` → `/grant:r`）实现，而不是 `Set-Acl` |
| `Get-Verdict`/`Show-Acl`/`Test-NeedsHardening` 增加 `$allowReadOnlyForOthers` | 目录场景下把 `ReadAndExecute` 判为 `ro`（允许），只有写类才算过宽；文件场景行为不变 |

**为什么目录那步不能用 `Set-Acl`（实测踩到的坑）**：

```
Set-Acl : The process does not possess the 'SeSecurityPrivilege' privilege which is required for this operation.
  + FullyQualifiedErrorId : System.Security.AccessControl.PrivilegeNotHeldException
```

`Set-Acl` 会连 **SACL** 一起写，非管理员进程没有 `SeSecurityPrivilege` 直接失败。
`icacls` 只动 DACL —— 既符合 R5-010 原本"用 icacls 去写权限"的要求，也不需要提权。

UTF-8 **BOM 与 CRLF 行尾都保留**（`acl-regression.mjs` 有 BOM 断言，实测 `ef bb bf` 通过）。

## 4. 验证（真实 exit code）

| 命令 | 修复前 | 修复后 | 证据 |
|---|---|---|---|
| `node scripts/tests/acl-regression.mjs`（旧版） | exit **1**（18 passed, **1 failed**：token 文件不存在） | exit **1**（18 passed, **1 failed**：同一条） | `acl-regression-before.txt` / `acl-regression-after.txt` |
| `node scripts/tests/acl-regression.mjs`（**当前版本**） | — | **exit 0，ALL PASS：22 passed, 0 failed** | `acl-regression-after-current.txt` |
| `powershell -File scripts\harden-credentials-acl.ps1`（体检，默认） | exit **0**（← 正是漏掉 R5-009 的证据） | exit **0** | `harden-before.txt` / `harden-verify-after-default.txt` |
| `… -GuardParentWrites`（体检含目录，补丁后未应用时） | exit **3**，报 3 条过宽 ACE（server-test）+ 6 条（mindcraft） | exit **0** | `harden-audit-after-patch.txt` / `harden-audit-guard.txt` / `harden-verify-after.txt` |
| `… -Apply -GuardParentWrites` | — | exit **0** | `harden-apply.txt` |
| 幂等复跑 `-Apply -GuardParentWrites` | — | exit **0**，4 个目标全部 `[已是收口]` | `harden-apply-rerun.txt` |
| 目标断言脚本（11 条） | — | exit **0**，**11 PASS / 0 FAIL** | `acl-assert-after.txt` |
| 新出现的 token 文件再加固 | — | `[加固] …\.mindserver-token`，exit **0**，4 项"可读可写"自检全 ok | `harden-apply-token.txt` |

> ⚠ `scripts/tests/acl-regression.mjs` **在本轮期间被另一张单改过**（+29 行，不是本次修复改的），
> 所以"修复前 18 条"与"修复后 22 条"总数不同 —— 不是同一份判据。可对比的是**逐条绿红是否翻转**，
> 而本次改动的目标（server-test 配置、mindcraft 目录、token）没有任何一条从绿变红。

### 中途出现的 `.mindserver-token`（顺带验证了「可重复修复」）

跑回归时 `.mindserver-token` 出现了（mindserver 被另一个任务启动），它**继承自我改后的目录**
⇒ 拿到的是 `Authenticated Users:(I)(RX)`（只读），而不是修复前的 `(I)(M)`（可写）；
但它仍然「走继承」，而回归脚本要求文件级非继承 ⇒ 当时报 2 条 FAIL。
再跑一次 `-Apply -GuardParentWrites` 就修好（不需要手工 icacls）：

```
[加固] E:\我的世界ai\mindcraft\.mindserver-token
[已是收口] …（其余 4 个目标）
  ok  可读可写：.mindserver-token
EXITCODE=0
```

之后 `icacls` 显示该文件只剩三条 ACE，回归 **ALL PASS 22/0**。
这条顺带证明：**新出现的凭据文件能被同一条命令收口**，修复是可重复的，不是一次性的手工操作。

### ⚠ 已知会复发：`.mindserver-token` 是**运行时重建**的 → 一次性加固会被冲掉

**实测时序（同一台机、几分钟内）**：

1. `-Apply -GuardParentWrites` 后，token 三条 ACE、非继承 → 回归 `ALL PASS 22/0`；
2. 另一个任务把 mindserver 起起来 → token 被**重建**，ACL 重新变成继承：
   `NT AUTHORITY\Authenticated Users:(I)(ReadAndExecute)` → 回归掉到 `20 passed / 2 failed`；
3. 再跑一次 `-Apply -GuardParentWrites` → 又回到 `ALL PASS 22/0`。

**这不是修复失败，而是"被修对象会被应用重建"**：文件级 DACL 只在文件存在期间有效，
进程重新创建同名文件时，新文件继承的是**父目录**的 ACE。

**当前缓解**：父目录（`mindcraft`）现在只给 `Authenticated Users:(OI)(CI)(RX)`，
所以重建出来的 token **也拿不到写权限**（修复前是 `(M)`，可写）—— R5-010 的修复
顺带把这条的风险从"可改"降到"可读"。

**彻底修法（建议，不在本单范围，属产品代码）**：在 `mindserver.js` 创建 token 文件后立刻设置
非继承 DACL（相当于把本脚本的 `Set-HardenedAcl` 逻辑用 .NET 调用内联一次），
或把 `harden-credentials-acl.ps1 -Apply` 挂成"每次启动面板后跑一次"的收尾步骤。
只靠"人工记得跑一次脚本"必然会复发 —— 本轮已经实测到一次。

### 关于 `acl-regression.mjs` 那 1 条失败（**与本次修复无关，修复前后一模一样**）

```
FAIL A mindcraft\.mindserver-token 存在
HAS FAILURES: 18 passed, 1 failed
```

`mindcraft\.mindserver-token` 只有 **mindserver 在跑时**才存在，当前没跑 ⇒ 文件不存在 ⇒ 这条断言必红。
这是**环境前置**，不是 ACL 退化。关键结论：**我改动的目标上没有任何断言从绿变红** ——

- `mindcraft\keys.json`：修复前后都 `protected=true`、`broad=[]`、`rules=3`（未被本次改动影响，本来就没问题）；
- `server\server.properties`：同上（本来就已收口）；
- `server-test\server.properties` **不在该回归脚本的 `TARGETS` 里**，`mindcraft` 目录同理 —— 所以它对 R5-009/R5-010 **没有覆盖**（见 §6 建议）。

另外任务里给的命令 `powershell -File scripts/tests/acl-regression.mjs` 不成立（`.mjs` 不是 PS 脚本）：

```
Processing -File 'scripts/tests/acl-regression.mjs' failed because the file does not have a '.ps1' extension.
```

正确跑法是 `node scripts/tests/acl-regression.mjs`（本轮用的就是它）。

## 5. 影响面

| 对象 | 影响 | 风险 |
|---|---|---|
| `server-test/server.properties` | 非管理员且非当前账户的**其他本机账户**不再能读该文件 | 无：应用只以当前账户运行；主服 `server/server.properties` 早已是同样待遇 |
| `mindcraft/` 目录及子对象 | 其他本机账户：可读+遍历，**不可写/删/改** | 无：当前账户仍 `FullControl`（实测可建/删文件）；git / node / 编辑器均以当前账户运行 |
| `keys.json` | 未改动（本来就已收口） | 无：实测 `ReadAllBytes` 成功，`node` 能解析出顶层键 |
| `server-test/` 目录本身 | **未改动**（仍是继承 ACL） | 已知残留：`server-test` 目录仍 `Authenticated Users:(I)(M)`。该目录是**手工测试服工作目录**，需要可写才能起服；本轮按任务范围只收口"配置文件本体"，目录级收口留作后续（见 §6） |
| 存档 | `world/`、`logs/` **未触碰** | — |
| 文件内容 | 未改动（只有 `icacls`/`Set-Acl` 元数据操作） | sha256 记录在 `acl-content-sha256.txt` |

### 回滚

```powershell
# 单文件恢复继承
icacls server-test\server.properties /inheritance:e
# 目录恢复继承（会重新拿到父目录的 Authenticated Users:(M)）
icacls mindcraft /inheritance:e
```
（`icacls` 的 `/restore` 也可用，但上面两条足够，且不要用 `/reset` —— 那会连子对象 ACL 一起重置。）

## 6. 已知限制与建议（未在本轮改动）

1. **`acl-regression.mjs` 未覆盖这两个目标** —— 建议把 `server-test\server.properties` 加进 `TARGETS`，
   并为 `mindcraft` 目录加一条"AU 无写位"的断言。否则将来有人 `icacls /inheritance:e` 一把，
   回归仍会全绿，R5-009/R5-010 会静默复发。
2. **`server-test` 目录本身仍是继承 ACL（AU:M）** —— 别人仍可在该目录里新建/替换文件（例如再放一个
   `server.properties` 覆盖）。要彻底阻断需要对该目录也做去写保读；但它同时是测试服的工作目录
   （Paper 要写 `logs/`、`world/`、`usercache.json`），需要先确认"谁在什么身份下起服"再动，
   否则会把测试服起不来当成新缺陷。
3. `.mindserver-token` 当前不存在，R5-009 里"token 文件"那一项要等 mindserver 起过之后才有对象可查。
