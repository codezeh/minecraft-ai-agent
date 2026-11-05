# 用户手册草案 · `F-SEC-202` RCON 收口（Windows 防火墙拦 25575 入站）

> 起草：gate-keeper（复核官）｜2026-11-06 02:0x
> 状态：**草案，待用户执行**（需管理员；agent 不执行、不入库）
> 对应 finding：`F-SEC-202`（RCON 监听 `0.0.0.0:25575`）
> 裁决依据：见 `docs/audit/night/review-prestage.md` §2

---

## 0. 一句话

**不动 `server.properties` 一个字节**，只加一条 Windows 防火墙入站拦截规则，
把 25575（RCON）对外关掉，**同时保住手机/局域网联机**（25565 不动），
也保住 bot 的本机 RCON（防火墙不检查 loopback 流量）。

---

## 1. 为什么不是把 `server-ip=127.0.0.1`

| 方案 | 关掉 RCON 暴露 | 手机/局域网能玩 | 会复发 | 可入库验证 |
|---|---|---|---|---|
| 改 `server-ip=127.0.0.1` | ✅ | ❌ **不能**（游戏端口一起收到本机） | ❌ **会**：`config/network.json` 仍是 `bind: all`，下次 `server-net.mjs apply` 一键改回空 ⇒ 洞复活 | ✅ |
| 关 `enable-rcon=false` | ✅ | ✅ | — | ✅ 但**打断功能**：`proc_control.js`（停服/重启）、`query_target`、`server_props` 及 5 个 `tools/*.mjs` 依赖 RCON |
| **防火墙拦 25575 入站（本方案）** | ✅ | ✅ | ✅ 不复发（不动仓库文件） | ❌ **不能**（见 §6，这是本方案唯一的代价） |

**已核证的前置事实**（不是推测）：
- `server/server.properties` 里 rcon 相关键**只有** `enable-rcon` / `rcon.password` / `rcon.port` / `broadcast-rcon-to-ops` —— **没有独立 rcon 绑定参数**（`grep -niE "rcon.*(ip|bind|host)"` 只命中 password 行）⇒ RCON 只能跟 `server-ip` 走，这也是"为什么不能单独收 RCON"的原因。
- bot 连的是本机：`mindcraft/settings.js:3 "host": "127.0.0.1"`；`rcon_client.js` 的 `rcon()` 默认 `host='127.0.0.1'` ⇒ 收掉外部 25575 **不影响** bot。
- 面板只**显示** RCON 状态（`web/src/views/SetupView.vue:247-249`），不连 RCON ⇒ 面板不受影响。
- 运行期实证：`logs/server-console.log:152` `RCON running on 0.0.0.0:25575`。

---

## 2. 执行步骤（用户本人，管理员权限）

### 步骤 1：记录现状（30 秒，留证据）

管理员命令提示符：

```cmd
netstat -ano | findstr ":25575"
```

预期（改之前）：
```
TCP    0.0.0.0:25575    0.0.0.0:0    LISTENING    <pid>
```
把这一行**抄下来存档**（后面要对比说明"监听没变、暴露面变了"）。

### 步骤 2：确认没有现存的"放行 25575"规则抢在前面

```cmd
netsh advfirewall firewall show rule name=all dir=in | findstr /i "25575 rcon"
```

- 无输出 = 干净，继续。
- **有输出且是 `Allow`** = 那条规则会让流量被放行。本方案的 block 规则通常仍然优先（Windows 防火墙 **block 优先于 allow**），但请把输出抄给我，我逐条判。
- **不要**在这里顺手删别人的规则。

### 步骤 3：加拦截规则

```cmd
netsh advfirewall firewall add rule name="deny-rcon-25575-in" dir=in action=block protocol=TCP localport=25575 profile=any
```

预期输出：`确定。`

> `profile=any` 是必须的：只拦"专用网络"而漏掉"公用网络"等于没拦
> （在咖啡厅 Wi-Fi 下系统会把网络判为"公用"，那正是最危险的环境）。

### 步骤 4：规则确实落盘

```cmd
netsh advfirewall firewall show rule name="deny-rcon-25575-in"
```
预期看到：`已启用: 是`、`方向: 入站`、`操作: 阻止`、`协议: TCP`、`本地端口: 25575`、`配置文件: 任何`。

---

## 3. 判据（**这一节是重点，侦察兵原来的判据是错的**）

### ⚠️ 先说清一个坑：`netstat` **看不出**这个修复

加完规则后：

```cmd
netstat -ano | findstr ":25575"
```

**仍然会显示 `0.0.0.0:25575 LISTENING`** —— 这**是正常的，不是修复失败**。
原因：Windows 防火墙拦的是**入站数据包**，不改变进程的**监听地址**。
所以：

> **`netstat` 的"只出现 127.0.0.1"这个期望是错的**（`F-SEC-202` 原文 verify 第 1 条即此错）。
> 谁拿 `netstat` 判这条修复，谁就会得出错误结论。

### ✅ 正确判据：必须"两台机器"对照

| # | 从哪测 | 目标 | 期望 | 说明 |
|---|---|---|---|---|
| A | **本机** | `127.0.0.1:25575` | **通** | 证明 bot 的 RCON 没被误伤（loopback 不受防火墙影响） |
| B | **另一台机器**（同网段） | `<本机LAN IP>:25575` | **不通/超时** | **这才是修复生效的唯一硬证据** |
| C | 另一台机器 | `<本机LAN IP>:25565` | **通** | 证明手机/局域网联机没被破坏 |

**取本机 LAN IP**：
```cmd
ipconfig | findstr /i "IPv4"
```
或 PowerShell：`Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -notlike '127.*'} | Select IPAddress`

**A（本机 loopback）验证** —— 用仓库自带工具，最贴近真实使用：
```cmd
cd E:\我的世界ai\mindcraft
node -e "import('./src/agent/library/rcon_client.js').then(async m=>{try{console.log(await m.rcon('list'))}catch(e){console.log('ERR',e.message)}})"
```
期望：返回玩家列表（或空列表 `[]`），**不是** `ECONNREFUSED`/`ETIMEDOUT`。

**B（跨机）验证** —— 在**另一台电脑**上（PowerShell）：
```powershell
Test-NetConnection -ComputerName <本机LAN IP> -Port 25575
```
期望：`TcpTestSucceeded : False`（或长时间 `Pending` 后失败）。
**若返回 True ⇒ 修复没生效**，见 §5 排查。

> 没有第二台电脑时：手机装任意端口扫描器（如 Fing / Network Analyzer）扫 `<LAN IP>` 的 25575，
> 期望"关闭/超时"。或用另一台机器 `telnet <LAN IP> 25575`（期望连不上）。
> **注意：不能用本机 `telnet 127.0.0.1 25575` 代替 B** —— 那测的是 loopback，必然通。

**C（游戏端口）验证**：手机上用 Minecraft 客户端连 `<LAN IP>:25565`，期望**正常进服**。

---

## 3.5 只用手机怎么测 B 和 C（点击级步骤）

> 你大概率是拿手机测，所以这一节按"手机 + Wi-Fi"写死。**前提：手机和电脑连的是同一个 Wi-Fi**
> （不是手机流量，也不是访客网络——很多路由器的"访客网络"会做客户端隔离，测出来一定是"不通"，
> 那是假阴性，会误导你以为修好了）。测之前先确认手机 Wi-Fi 和电脑在同一个网段
> （对比手机上显示的 IP 与电脑 `ipconfig` 的 IPv4，前三段应该一样，例如都是 `192.168.1.x`）。

### 3.5.1 先用手机拿"本机 LAN IP"（不用开电脑）

手机上任意一个能看网络信息的入口都行，最快的是**系统设置**：

- **Android**：设置 → WLAN（Wi-Fi）→ 点当前连接的那个网络 → 看「IP 地址」，形如 `192.168.1.23`。
- **iPhone**：设置 → 无线局域网 → 点当前 Wi-Fi 右侧的 ⓘ → 看「IP 地址」。

**但注意**：这是**手机自己**的 IP，我们要测的是**电脑**的 IP。所以电脑那台仍需跑一次
```cmd
ipconfig | findstr /i "IPv4"
```
把电脑的 IPv4 记下来（下面叫它 `<电脑IP>`）。

### 3.5.2 装一个端口扫描 App（一次性，免费即可）

任选一个，都能扫单个端口：

| App | 平台 | 说明 |
|---|---|---|
| **Fing**（推荐） | Android / iOS | 免费版够用；能发现设备 + 扫端口 |
| **Network Analyzer** | Android / iOS | 免费版有端口扫描 |
| **NetX / Port Scanner** | Android | 轻量，可直接填 IP+端口 |

> 只用 C 项（能不能进服）时**不需要**装任何 App —— 直接用 Minecraft 客户端连就行。
> 只有 B 项（25575 该不该通）才需要扫端口。

### 3.5.3 B 项：扫 25575（**必须"不通"**）

以 **Fing** 为例（其它 App 大同小异）：

1. 打开 Fing → 底部选「设备 / Devices」→ 确保列表里能看到你的**电脑**（按 `<电脑IP>` 找）。
2. 点开那台电脑 → 找「**服务 / Services**」页（有的版本叫「开放端口 / Open Ports」）。
3. Fing 会自动扫常用端口。若列表里**看不到 25575**，这已经是"不通"的好迹象。
4. **要更确定就手动指定端口**（不同 App 叫法不同，一般是「工具 → 端口扫描 / Port Scan」）：
   - 目标地址填 `<电脑IP>`
   - 端口填 `25575`（协议选 TCP）
   - 开始扫描

**判读**：

| 扫描结果显示 | 含义 | 结论 |
|---|---|---|
| `closed` / `关闭` / `timeout` / `超时` / 无响应 | 包被防火墙丢了 | ✅ **B 通过** |
| `open` / `开放` / `开启` | 25575 还能从局域网访问 | ❌ **B 失败** → 按 §5 排查，**不要**签"已修好" |
| 扫描立刻报错/拒绝连接 | 也算不通（RST） | ✅ B 通过（见下方说明） |

> **一个容易误判的点**：`block` 规则通常表现为**超时（无响应）**，而不是"连接被拒绝"。
> 两者都算"不通"，都通过。**只有 `open` 才是失败。**

### 3.5.4 C 项：连 25565（**必须"能进"**）

1. 手机打开 Minecraft（**Java 版**客户端，PC 版；手机上的基岩版/Bedrock **连不上 Java 服**，
   如果你手机上装的是基岩版，C 项请改用另一台电脑的 Java 客户端测）。
2. 多人游戏 → 添加服务器：
   - 服务器地址：`<电脑IP>`
   - 端口：`25565`
3. 加入。

| 结果 | 结论 |
|---|---|
| 能进到服务器里、能看到世界 | ✅ **C 通过**（玩法没被破坏） |
| 提示"无法连接/连接超时" | ❌ **C 失败** —— 说明规则误伤了游戏端口，立刻回滚（§7）并报 captain |

> 若手机只有基岩版：改用「另一台电脑的 Java 客户端」做 C；或临时用 `ping <电脑IP>` 只能证明
> "能到达主机"，**不能**证明 25565 通 —— 端口必须用上面 3.5.3 的方式扫 `25565` 得到 `open`。

### 3.5.5 手机端最简签字组合（只有手机时）

只填这三行也能签字：
- **B**：Fing 扫 `<电脑IP>:25575` → **不是 open**（记下具体显示词，如 `timeout`）
- **C**：Java 客户端（手机或另一台电脑）连 `<电脑IP>:25565` → **能进**
- **A**：在**电脑上**跑 §3 的 `rcon_client.js` 那条命令 → 有返回

三项都过 ⇒ 可以签。**B 没有明确"非 open"就不许签。**

---

## 4. 签字表（用户填，交回即可归档）

| 项 | 结果 | 时间 | 备注 |
|---|---|---|---|
| 步骤 1 现状 `netstat` 已抄录 | ☐ | | |
| 步骤 2 无现存 Allow 规则（或已交 captain 判） | ☐ | | |
| 步骤 3 规则已添加（`确定。`） | ☐ | | |
| 步骤 4 `show rule` 六项均符合 | ☐ | | |
| A 本机 loopback RCON **通** | ☐ | | 关键：bot 没坏 |
| B 跨机 `<LAN IP>:25575` **不通** | ☐ | | **关键：修复生效** |
| C 跨机 `<LAN IP>:25565` **通** | ☐ | | 关键：玩法没坏 |

> 判定：**A、B、C 三项全对，才算修好。** 缺 B 等于没验证；缺 A 等于可能把 bot 打坏了。

---

## 5. 若 B 仍然通（排查顺序）

1. **规则在不在**：`netsh advfirewall firewall show rule name="deny-rcon-25575-in"`。
2. **防火墙是不是被第三方接管**：若装了 360/火绒/卡巴，Windows 防火墙可能被禁用，
   规则不生效 ⇒ 需在第三方防火墙里加同样的拦截，或临时停用第三方防火墙复测（仅为定位）。
3. **有无更靠前的 Allow 规则**：重跑步骤 2 的 `show rule name=all` 全量导出给我。
4. **是不是被测的是另一台机器**：确认 B 测的 `<LAN IP>` 确实是本机 `ipconfig` 里那个地址，
   而不是路由器地址或另一台机器。
5. **公司/酒店网络做了端口映射**：若路由器把 25575 映射到本机，外部仍可能从公网进来 ——
   这属于路由器配置，需在路由器上关掉该映射（`server-ip` 空 + 无映射 = 外部进不来）。

---

## 6. 本方案的**代价与边界**（必须让用户知道，不要美化）

1. **不是仓库内的修复**：`git diff` 里**看不到任何东西**。换机、重装系统、恢复出厂 ⇒ **规则消失，洞复发**。
   ⇒ 所以它是"部署硬要求"，必须写进 README 部署段 + 换机清单。
2. **`config/network.json` 与实际一致**（这点反而是优点）：`bind: all` 仍是真的，
   不存在两个真相源打架，也不会被 `server-net.mjs apply` 意外改回。
3. **端口仍是开放的监听**：只是**外部包被丢弃**。若将来有人**临时关了防火墙**做排查忘了开回来，洞即复活。
4. **不是"零风险"**：若 bot 或未来工具改用**其它机器的 IP** 连 RCON（例如把 bot 迁到另一台机器），
   会被自己的规则挡住。当前实测所有消费者都是 `127.0.0.1`，所以现在安全；
   **将来加机器要回来改这条规则**。
5. **`broadcast-rcon-to-ops=true` 未处理**：341 个 op 会把 RCON 命令回显到 op 聊天。
   与本方案无关，建议单开一条 low（纯配置、零风险）。

---

## 7. 回滚（一条命令）

```cmd
netsh advfirewall firewall delete rule name="deny-rcon-25575-in"
```

---

## 8. 我没法替你做的部分（诚实声明）

- 我（agent）**不能执行** `netsh`（需管理员；且本会话不具备该权限）。
- 我**不能**从另一台机器发起 B 测试（需要第二台设备）。
- 因此本方案的**最终生效证明只能由你（或 captain）实测签字**，我只提供可签字步骤与判据。
  **`F-SEC-202` 的关闭条件 = §4 签字表 A/B/C 三项全对**，不是"代码里改了配置"。

---

## 附：本草案核证过的原始事实（复现命令）

```bash
# 1) rcon 键只有 4 个，无独立绑定
grep -nE "^rcon|^enable-rcon|^broadcast-rcon" server/server.properties
grep -niE "rcon.*(ip|bind|host)" server/server.properties      # 只应命中 rcon.password

# 2) bot 走本机
sed -n '1,6p' mindcraft/settings.js                            # "host": "127.0.0.1"
grep -n "host = '127.0.0.1'" mindcraft/src/agent/library/rcon_client.js

# 3) 面板只显示、不连
grep -rn "rcon" web/src/ | head

# 4) 运行期实证
grep -n "RCON running on" logs/server-console.log | tail -1     # 0.0.0.0:25575
```
