# 用户手册 · `F-RT-001` `.mindserver-token` 的文件权限收紧（icacls）

> 起草：patch-smith（2026-11-06）｜状态：**待用户/部署执行**（需管理员，agent 不执行）
> 对应 finding：`F-RT-001`（medium）—— token 文件的真实 ACL 允许同机其他账户读写删

---

## 0. 这条到底在说什么（先看清它不是什么）

`mindserver` 会在 `mindcraft/.mindserver-token` 写一个**每次启动都不同的握手 token**。
拿到它的人可以：`send-message` 指挥 bot、`set-agent-settings` 改配置、`server-stop`/`shutdown` 停服。

复核席用 `icacls` 实测：该文件继承到
```
Authenticated Users:(M)      ← 修改（可写可删）
Users:(RX)                   ← 读+执行
```
⇒ **同一台机器上任何其他本地账户都能读它**。

**它不是什么**（避免过度恐慌，也避免被当成"已经安全了"）：
- 不是远程漏洞：mindserver 只绑 `localhost`，token 也只在启动时生成。
- `mode: 0o600` 那行在 **Windows/NTFS 上基本无效**（mode 只管 POSIX 位）—— 代码注释里已经如实写明，
  真正决定权限的是 NTFS ACL，也就是本手册要改的东西。
- 所以这条的真实威胁模型是：**同机的另一个用户账户**（共享电脑、其他服务账户、被投放的低权限进程）。

---

## 1. 三步（PowerShell，管理员）

> 下面的路径按你的实际仓库位置改。示例假设仓库在 `E:\我的世界ai`。

```powershell
# 第 1 步：先关掉继承（否则删掉 ACE 也会被父目录加回来）
icacls "E:\我的世界ai\mindcraft\.mindserver-token" /inheritance:r

# 第 2 步：只留"当前用户 + SYSTEM + Administrators"三个，其余全删
icacls "E:\我的世界ai\mindcraft\.mindserver-token" /grant:r "$env:USERNAME:(R,W)"
icacls "E:\我的世界ai\mindcraft\.mindserver-token" /grant:r "SYSTEM:(F)"
icacls "E:\我的世界ai\mindcraft\.mindserver-token" /grant:r "Administrators:(F)"

# 第 3 步：验收（应当只剩三条，且没有 Authenticated Users / Users）
icacls "E:\我的世界ai\mindcraft\.mindserver-token"
```

**期望输出**（大致）：
```
.mindserver-token  <你>:(R,W)
                   NT AUTHORITY\SYSTEM:(F)
                   BUILTIN\Administrators:(F)
```

---

## 2. 一个现实问题：文件是**每次启动重建**的

`mindserver` 每次启动都会 `writeFileSync` 重建这个文件 ⇒ **ACL 会退回继承值**（新文件继承父目录 ACL）。
所以严格说，上面三步只对"当前这份文件"有效。

**两种可持续做法（选一）**：

**A) 父目录收紧（推荐，一次到位）**
```powershell
icacls "E:\我的世界ai\mindcraft" /inheritance:r
icacls "E:\我的世界ai\mindcraft" /grant:r "$env:USERNAME:(OI)(CI)(F)"
icacls "E:\我的世界ai\mindcraft" /grant:r "SYSTEM:(OI)(CI)(F)"
```
⚠️ 副作用：会让**整个 mindcraft 目录**对其他账户不可读。如果你有"别的账户跑 bot / 备份工具"这类用法，
先确认它们还读得到，否则会打断现有流程。**这条要你判断，我不替你决定。**

**B) 每次启动后重设（脚本化）**
把第 1 节的三步写成 `scripts/tighten-token-acl.ps1`，在 `start-panel.ps1` 启动完 mindserver 后调一次。
代价：多一个脚本依赖；好处：不影响目录其他部分。**我可以写这个脚本 —— 说一声就行。**

---

## 3. 顺带提醒（与 F-RT-003 配套）

- token 文件现在会在 **进程退出时自动删除**（`F-RT-003` 已改），所以"长期躺盘"的窗口已经收窄到"运行期"。
- `?token=…` 也已经 **302 抹掉**，不再进浏览器历史/书签同步。
- ⇒ 剩下的就只有"运行期 + 同机其他账户"这一段，正是本手册要关的口子。

## 4. 什么时候可以认为这条关闭

- (a) `icacls` 验收输出里**没有** `Authenticated Users` 与 `Users`；**且**
- (b) 你用另一个本地账户实测 `type .mindserver-token` → **拒绝访问**。
- 只做到 (a) 但重建后又变回继承值 ⇒ 视为**未关闭**（这也是为什么推荐 §2-A 或 §2-B）。
