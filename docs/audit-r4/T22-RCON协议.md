# T22 · RCON 协议修复：为什么 `save-off` 从来没生效过

- 日期：2026-11-08（Asia/Shanghai）
- 范围：`scripts/lib/rcon.ps1`（新增，唯一实现）、`scripts/backup-world.ps1`、`scripts/restore-drill.ps1`、`scripts/tests/{fake-rcon-server,rcon-regression}.ps1`（新增）
- 结论：**RCON 客户端协议写错 + 不校验应答**，两者叠加使 `save-off` / `save-all flush` / `save-on` 在真实 Paper 上**一次都没成功过**，而脚本一路报告"已 save-off（推荐）"。

---

## 1. 缺陷本体

`backup-world.ps1` 原来的 `Invoke-Rcon`：

```powershell
$payload = [Text.Encoding]::ASCII.GetBytes($Command)          # ← 命令
$writer.Write([int32]($payload.Length + 10))
$writer.Write([int32]1)
$writer.Write([int32]3)                                       # ← type=3 是 auth 包
$writer.Write($payload)                                       # ← 正文却是命令，不是密码
```

三个错误叠在一起：

| # | 错误 | 后果 |
|---|---|---|
| 1 | `type=3`（auth）的正文必须是**密码**，写成了**命令** | 真实 Paper 立刻回 `id=-1` 并关闭连接 |
| 2 | 之后又用**同一个 payload**（仍是命令）发 `type=2` | 等于**从来没发过**真正的命令 |
| 3 | 末尾无条件 `return $true`，**不校验应答** | 失败被当成成功，`$savedOff = $true` 照常置位 |

净效果：`save-off`（停自动写盘）、`save-all flush`（强制落盘）、`save-on`（恢复写盘）三条一致性动作全部空转，
但脚本只在"RCON 不可用"时才警告 —— 这里是"RCON 可用但认证失败"，于是**连警告都没有**。

## 2. 为什么能藏这么久（这是本条最值得记的部分）

两个盲同时在：

**(a) 验证用的假 RCON 服务器不校验协议。**
t7 为了验证 B5（`save-off` 成功但 `save-all flush` 失败时仍必须 `save-on`）写了一个假服务器。
它收到任何包都回成功，**从不检查 auth 正文是不是密码**。于是"把命令当密码发"这个错误，
在假服务器上表现得和正确实现一模一样 —— 测试全绿。

**(b) 客户端不校验应答。**
`Invoke-Rcon` 只在抛异常时返回 false，从不看 `id`。即使对方（真实 Paper）回了 `id=-1`，
只要 TCP 没当场抛错，就被当成成功。

> 两者缺一，这个 bug 都会当场暴露：
> 假服务器校验协议 → 第一次跑就红；客户端校验应答 → 第一次连真机就红。
> 因为两者同时缺失，bug 活过了两轮审计。

这正是 T9 里那条教训的翻版：**"自己写的假服务端"必须校验协议，否则它证明的只是"我按自己的理解实现了两遍"。**

## 3. 修法

### 3.1 只有一份实现：`scripts/lib/rcon.ps1`

`backup-world.ps1` 与 `restore-drill.ps1` 都不再各写一份，统一 dot-source：

```powershell
. (Join-Path $PSScriptRoot 'lib/rcon.ps1')
```

导出：

| 函数 | 说明 |
|---|---|
| `New-RconPacket -Id -Type -Body` | 组包（`length = 10 + len(body)`，尾部两个 `0x00`） |
| `Read-RconPacket -Stream [-TimeoutMs]` | **读满一个完整包**；读不满/超时/长度非法都抛错 |
| `Invoke-RconCommand -Password -Port [-Command] [-TimeoutMs]` | 认证 → 可选命令；返回 `@{ ok; body; error; authId }` |
| `Invoke-RconCommandWithRetry -Password -Port -Command [-Attempts] [-DelayMs]` | 供"RCON 线程刚起来还没 bind"的场景 |
| `Invoke-Rcon` | 兼容别名（老调用点写法） |

协议要点（已在本机 Paper 1.21.8 实测）：

```
auth  : length, id=1, type=3, body=PASSWORD, 0x00 0x00   → 服务端回 id=1（失败回 id=-1）
command: length, id=2, type=2, body=COMMAND, 0x00 0x00   → 服务端回 type=0 + 命令输出
```

判定规则（不再"没抛异常就算成功"）：
- `id = -1` ⇒ **认证失败**，返回 `ok=false` 并带上明确文案；
- `id` 与请求 id 不符 ⇒ 失败；
- 读不到完整包（对端断开/超时） ⇒ 失败，**不会死等**；
- 连接阶段超时用 `BeginConnect + WaitOne` 兜住。

### 3.2 `backup-world.ps1`：分别判成功 + 留档

- `save-off` 与 `save-all flush` **各自**判定：不仅要 `ok`，还要正文对得上
  （`disabled` / `Saved|Saving`），否则 Warn 并记原因；
- **任一失败 ⇒ `consistent=false`**，`note` 里逐项写清是哪一条失败；
- manifest 新增 `rcon` 段，原样记录三条命令的 `ok / reply / error`：

```json
"rcon": {
  "saveOff": { "ok": true,  "reply": "Automatic saving is now disabled", "error": "" },
  "flush":   { "ok": true,  "reply": "Saving the game (this may take a moment!)Saved the game", "error": "" },
  "saveOn":  { "ok": true,  "reply": "Automatic saving is now enabled", "error": "" }
}
```

冷备（`-Mode Cold`）不发 RCON，该字段为 `null` —— 行为与之前一致。

### 3.3 `restore-drill.ps1`

只做"抽公共库"这一件事：删掉本地的 `Invoke-Rcon` / `Invoke-RconWithRetry`，改 dot-source；
调用点参数名统一为 `-Password/-Port/-Command`。**12 条断言逻辑一字未动**（它此前已在真机 Paper 上实测通过）。

## 4. 证据

### 4.1 离线回归（一条命令）

```
powershell -ExecutionPolicy Bypass -File scripts/tests/rcon-regression.ps1
```

假服务器 **按真实协议校验** auth 正文（`scripts/tests/fake-rcon-server.ps1`：不等于密码就回 `id=-1` 并断开）。

| 用例 | 期望 | 实测 |
|---|---|---|
| ① 正确密码 + `save-all flush` | 成功且收到应答 | `ok=True body=Handled: save-all flush` |
| ② 错误密码 | 必须失败 | `ok=False err=RCON 认证失败（服务端回 id=-1…）` |
| ③ **反向**：照老 bug 把命令当 auth 正文 | **必须失败** | `ok=False`（同样回 id=-1） |
| ④ 服务端看到的 auth 正文 | 是密码、不是命令 | 收到 3 个 auth 包：`regress-pass` / `wrong-password` / `save-all flush` |
| ⑤ 用例③确实走了错误分支 | 是 | auth 包里确实出现过 `save-all flush` |
| ⑥ 端口无人监听 | 快速失败不卡死 | `ok=False err=连接超时` |

结果：`ALL PASS：7 项通过`，exit 0。**③ 若变绿，说明假服务器又退化回"不校验协议"了。**

### 4.2 真机 Paper（隔离服，还原自真实备份）

在还原出来的世界（`backups/world-20261108-034843`）上起 Paper 1.21.8（端口 25567 / RCON 25568），
用修好的库连发三条：

```
save-off        ok=True reply='Automatic saving is now disabled'
save-all flush  ok=True reply='Saving the game (this may take a moment!)Saved the game'
save-on         ok=True reply='Automatic saving is now enabled'
stop            ok=True reply='Stopping the server'
AllChunksSaved=True
```

**连接全程未被断开、每条都读到真实应答** —— 与旧实现（`id=-1` + 断开）形成直接对照。

### 4.3 回归面不被破坏

- `scripts/backup-world.ps1 -Mode Cold`：exit 0，产出 `backups/world-20261108-051635`（7 组件）；
- `scripts/verify-world-backup.ps1` 对该备份：**ALL PASS 137 项 / 0 失败**；
- manifest 中 `rcon: null`、`consistent: true`（冷备不经 RCON，行为不变）。

## 5. 留给后面的规矩

1. **假服务端必须校验协议**，不能"来什么回什么" —— 否则它只是把同一份误解实现了两遍。
2. **任何 RPC 客户端都必须校验应答**（id / 状态字段），"没抛异常"永远不等于"对方执行了"。
3. 同一件事只留一份实现：`scripts/lib/rcon.ps1` 是 RCON 的唯一真相，两处 dot-source。
4. 回归要有**反向用例**：只证明"对的能过"不够，还要证明"错的会红"。
