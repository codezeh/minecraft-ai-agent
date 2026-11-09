# 修复 06：R5-008 主服 RCON 全网卡监听 + 明文口令

> 用户已明确授权：改绑 `127.0.0.1` + 轮换口令。
> 只改 `server/server.properties` 的 **2 行**（详见 §2 说明），未动 `world/`、未动 `server-test/`。
> **生产进程未重启**（本来也没在跑）—— 见 §6 的待办。

## 0. 结论速览

| 项 | 改前 | 改后 | 验证方式 |
|---|---|---|---|
| `server-ip` | `server-ip=`（空 = 监听所有网卡） | `server-ip=127.0.0.1` | 临时实例 A/B 实测：`0.0.0.0:25590`+`[::]:25590` → `127.0.0.1:25591` |
| `rcon.password` | 旧口令（48 字符，**已随 `docs/audit-r5/00-缺陷清单.md` 泄漏**） | **已轮换，长度 32，前 4 位 `434d`** | 新口令 `list` 通、旧口令 `auth-failed` |
| `enable-rcon` | `true` | `true`（**未动**，面板/关服链依赖它） | diff 中不出现该行 |
| `rcon.port` | `25575` | `25575`（**未动**） | diff 中不出现该行 |
| 文件 ACL | 非继承三条 ACE（t11 已收口） | 同左，复跑 harden `[已是收口]` exit 0 | `rcon-acl-apply.txt` |

## 1. 备份（改坏了能还原）

```bash
cp -p server/server.properties tmp/r5-fix-rcon/server.properties.bak-20261108-195535
```

| 项 | 值 |
|---|---|
| 备份路径 | `tmp/r5-fix-rcon/server.properties.bak-20261108-195535` |
| 原文件 sha256 | `b5d414f6e3b072fd5e8e45f4f310499ca10439fde7689c2d4a4b5b2f3cb054cf` |
| 备份 sha256 | `b5d414f6e3b072fd5e8e45f4f310499ca10439fde7689c2d4a4b5b2f3cb054cf`（一致） |
| 原文件 mtime | `2026-11-07 15:21:51.556129100 +0800`（`cp -p` 保留） |
| 原文件大小 | 1520 字节 → 改后 1513 字节（口令 48→32 为 −16，`server-ip` 空→`127.0.0.1` 为 +9） |
| 是否进版本控制 | **否** —— `tmp/` 在 `.gitignore:23`，实测 `git check-ignore` 命中 |

## 2. 改动（`diff` 真实输出，口令行已脱敏）

```
--- tmp/r5-fix-rcon/server.properties.bak-20261108-195535	2026-11-07 15:21:51.556129100 +0800
+++ server/server.properties	2026-11-08 19:56:33.984058900 +0800
@@ -43,7 +43,7 @@
 pvp=true
 query.port=25565
 rate-limit=0
-rcon.password=<REDACTED>
+rcon.password=<REDACTED>
 rcon.port=25575
 region-file-compression=deflate
 require-resource-pack=false
@@ -51,7 +51,7 @@
 resource-pack-id=
 resource-pack-prompt=
 resource-pack-sha1=
-server-ip=
+server-ip=127.0.0.1
 server-port=25565
 simulation-distance=6
 spawn-monsters=true
```

**改动统计：diff 里 4 行（2 删 2 增）= 实际改 2 个键。**

> ⚠ 与任务书措辞的差异（如实记录）：任务写「改三项 / diff 仅三行」，但清单里第 2 条本身写着
> "`enable-rcon=true` **保留**"，第 4 条写着 "`rcon.port=25575` **若原本是它则保留**"。
> 实测这两个键原本就已是目标值，**因此不应改动**（改了反而会碰无关行）。
> 所以本轮**实际改的是 2 个键**（`server-ip`、`rcon.password`），`enable-rcon` / `rcon.port` 保持原值。
> 这与"只改该改的、其余行逐字不动"的约束一致。

原始证据：`docs/audit-r5/evidence/fix/rcon-diff.txt`。

## 3. 绑定行为实测（A/B 对照，不改生产）

**为什么需要 A/B**：`server-ip` 只在**服务端启动时**决定监听地址；生产服当时**没在跑**
（`tasklist` 无 java、`netstat` 无 25565/25575 监听），所以"改完立刻 netstat"看不到任何变化。
为了拿到**改前 vs 改后**的真实差异，用同一份 Paper jar 起两个临时实例：

- **A 组**：用**改动前**的备份配置（`server-ip=` 空）
- **B 组**：用**改动后**的生产配置（`server-ip=127.0.0.1`，口令也是新的）
- 端口改到 25580/25590、25581/25591，避免占生产端口（本机随时可能有别的任务起服）

命令：`node docs/audit-r5/evidence/fix/rcon_bind_check.mjs`

**真实输出**（`rcon-bind-check.txt`，exit 0）

```
--- A-old-empty-ip（server-port=25580, rcon.port=25590）
    netstat 中 25590 的 LISTENING 行：
      TCP 0.0.0.0:25590 0.0.0.0:0 LISTENING 26064
      TCP [::]:25590 [::]:0 LISTENING 26064
    使用配置里的口令跑 list → OK: There are 0 of a max of 10 players online:

--- B-new-127（server-port=25581, rcon.port=25591）
    netstat 中 25591 的 LISTENING 行：
      TCP 127.0.0.1:25591 0.0.0.0:0 LISTENING 11488
    使用配置里的口令跑 list → OK: There are 0 of a max of 10 players online:
    用**旧口令**跑 list → rejected: auth-failed

=== 结论 ===
A 为全网卡监听（0.0.0.0/[::]）: PASS
B 为仅本机监听（127.0.0.1）: PASS
B 组新口令可通: PASS
B 组旧口令被拒: PASS
RESULT=ALL PASS
```

**结论**：`server-ip=` 空时 RCON 在 **IPv4 与 IPv6 全网卡**上监听（这就是 R5-008 的风险面）；
填 `127.0.0.1` 后**只**监听回环。这条语义已在真 Paper 上验证，不是推断。

## 4. 口令轮换验证

| 检查 | 结果 |
|---|---|
| 新口令能连 RCON 并执行 `list` | **PASS** —— `There are 0 of a max of 10 players online` |
| 旧口令被拒 | **PASS** —— `auth-failed`（RCON 协议返回 id=-1） |
| 新口令长度 / 前 4 位 | 32 字符 / `434d` |
| 生成方式 | `crypto.randomBytes(16).toString('hex')`（32 位 hex） |
| 旧口令长度 | 48 字符（原值也是随机串，不是 `localdev` 这类弱口令） |

**口令泄漏扫描**（落盘后自查，只统计不打印）：

```
docs/ 命中新口令文件数: 0
tmp/r5-fix-rcon 命中新口令文件数: 0
```

> 扫描口径：`grep -rlF "$PW" docs/ tmp/r5-fix-rcon/`，输出被替换成计数，**口令本身从未写入任何报告/日志**。
> 绑定脚本自己实现了极简 RCON，错误只报 `auth-failed` / `timeout`，不打印口令。

### ⚠ 一条必须上报的存量问题：旧口令**早已**以明文存在于仓库文档里

扫描时发现 `docs/` 下**有 2 个文件**含旧口令明文（**不是本轮写的**，是更早任务留下的）：

```
docs/audit-r5/00-缺陷清单.md
docs/audit-r5/evidence/verify/d14-rcon.log
```

- 这本身就是 R5-008 的证据（"口令明文可读"），但从**交付物**角度它是**新的泄漏面**：
  任何人拿到报告就等于拿到口令。
- 本轮已轮换口令 ⇒ 这两处记载**已失效**（旧口令现在连不上，实测 `auth-failed`），
  但**明文仍在文件里**。
- 我没有直接改这两个文件：它们属于**其他任务的产物**（`00-缺陷清单.md` 是团队主清单），
  并发编辑有冲突风险。**建议**：由该文件的属主把口令替换为 `<REDACTED(长度48)>`，
  或在本单后续追加一个"文档脱敏"步骤。

## 5. ACL 收口（复用 t11 的 harden 脚本）

```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/harden-credentials-acl.ps1 -Apply
→ EXITCODE=0
[已是收口] E:\\我的世界ai\\server\\server.properties
  ok  可读可写：server.properties
```

`icacls server\server.properties`：

```
E:\\我的世界ai\\server\\server.properties NT AUTHORITY\SYSTEM:(F)
                                   BUILTIN\Administrators:(F)
                                   LAPTOP-GDE992NS\zeh:(F)
```

非继承（无 `(I)`）、只有三条白名单 ACE。证据：`rcon-acl-apply.txt`。

## 6. ⚠ 生产重启待办（必须由用户择机执行）

**当前状态：生产服没有在跑**（改前改后都实测 `tasklist` 无 java、`netstat` 无 25565/25575 监听）。
所以**配置已改好，但尚未在任何生产进程上生效**。我没有擅自启动生产服（会加载生产世界、可能影响玩家）。

生效步骤（请用户在确认可以停服/开服的窗口执行）：

1. 启动主服（照原有方式，例如 `启动面板.bat` 或 `scripts/start-panel.ps1`）；
2. 启动后立刻核对绑定地址：
   ```cmd
   netstat -ano | findstr :25575
   ```
   期望：**只有** `TCP 127.0.0.1:25575 ... LISTENING`
   （**不应**再出现 `0.0.0.0:25575` 或 `[::]:25575`）；
   同时 `netstat -ano | findstr :25565` 也应为 `127.0.0.1:25565`（`server-ip` 同时作用于游戏端口）；
3. 面板/关服链会用 `server/server.properties` 里的**新口令**连 RCON —— 因为它们都是读同一个文件，
   无需额外改配置；若面板进程常驻且**缓存了旧口令**，需要重启面板进程让它重读；
4. 若 25575 仍显示 `0.0.0.0` ⇒ 说明有另一个 `server.properties` 生效（例如 `-D` 参数或别的目录），
   请回滚后排查（回滚见 §7）。

## 7. 回滚

```bash
cp -p tmp/r5-fix-rcon/server.properties.bak-20261108-195535 server/server.properties
# 或只回滚口令/绑定：手工把那两行改回（旧口令值在备份文件里）
```

回滚后需再次重启主服才生效；ACL 不需要回滚（收口不影响使用）。

## 8. 影响面

| 对象 | 影响 | 风险 |
|---|---|---|
| RCON 监听 | 从全网卡 → 仅回环 | 若有人从**别的机器**用 25575 连过 RCON，会连不上（本机面板/脚本不受影响） |
| 游戏端口 25565 | 同样因 `server-ip` 变仅回环 | 若有过**局域网/外网直连**玩家的用法，会连不上 —— **这是本次预期的收紧**；如需对外开服，应对"对外"这件事单独决策（而不是把 RCON 一起暴露） |
| 旧口令持有者 | 旧值失效（实测 `auth-failed`） | 任何写死旧口令的脚本/书签需同步更新；仓库内据此认领口令的代码读的是 `server.properties`，无需改 |
| 备份文件 | `tmp/r5-fix-rcon/server.properties.bak-*` 含**旧口令**明文 | `tmp/` 已 gitignore；验证完不再需要，可在确认无需回滚后删除 |
| 世界/存档 | 未触碰 | — |
