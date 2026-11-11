# 收紧 RCON 入站暴露（需管理员权限）
#
# 背景（2026-11-06 终审 R3 / F-SEC-202）：
#   Paper 1.21.8 **没有独立的 rcon 绑定参数** —— RCON 只能跟 server-ip 走。
#   而收 server-ip 到 127.0.0.1 会**连带收窄 25565**，手机/局域网就进不来了
#   （这正是 config/network.json 里 bind:all 的用途）。
#
#   所以推荐用**防火墙**拦 RCON 端口：Windows 防火墙不检查 loopback，
#   bot 走 127.0.0.1:25575 照常，25565 不动、手机照玩。
#
# 已做的缓解（不需要管理员）：
#   · rcon.password 已从 32 位轮换为 48 位随机串（爆破不可行）
#   · broadcast-rcon-to-ops=false（不给 341 个 op 播报运维动作）
#
# 本脚本做两件事：
#   1. 拦 TCP 25575 入站（任何 profile，含"公用网络"——只拦"专用网络"会漏掉咖啡厅 Wi-Fi 场景）
#   2. 打印验证方法
#
# 回滚：netsh advfirewall firewall delete rule name="deny-rcon-25575-in"
#
# 注意：防火墙规则**不入库、换机失效**，属"部署硬要求"。
#       无法用 git diff 证明，只能实测（这也是 F-SEC-202 的 honest 边界）。

# ★ R6 #48（2026-11-11）：新增 -Verify —— 只读自检，不需要管理员、不改任何东西。
#   为什么必须有它：这条防火墙规则**不入库、换机即失效**，在此之前没有任何脚本能验证它
#   （报告原话："该防护无法被任何脚本验证"）。start-panel 的前置检查现在会调用它，
#   于是"新机器上 25575 裸奔"从"没人知道"变成"每次启动都提示"。
#   退出码：0 = 规则在位且形态正确；1 = 规则不存在；2 = 规则存在但形态不对（未启用/方向错/端口错）。
[CmdletBinding()]
param(
    [switch]$Verify
)

$ruleName = 'deny-rcon-25575-in'

# 只读地判定规则当前形态：ok / missing / malformed
function Get-RconRuleState {
    param([string]$Name)
    $rule = Get-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $rule) { return 'missing' }
    $portOk = $false; $protoOk = $false
    try {
        $pf = $rule | Get-NetFirewallPortFilter
        $protoOk = ("{0}" -f $pf.Protocol) -eq 'TCP'
        $portOk = (@("$($pf.LocalPort)" -split ',') -contains '25575')
    } catch { return 'malformed' }
    $dirOk = ("{0}" -f $rule.Direction) -eq 'Inbound'
    $actOk = ("{0}" -f $rule.Action) -eq 'Block'
    $enaOk = ("{0}" -f $rule.Enabled) -eq 'True'
    if ($dirOk -and $actOk -and $enaOk -and $protoOk -and $portOk) { return 'ok' }
    return 'malformed'
}

if ($Verify) {
    $state = Get-RconRuleState -Name $ruleName
    if ($state -eq 'ok') {
        Write-Host "  [ok] 防火墙规则 $ruleName 在位：TCP 25575 入站 block、已启用" -ForegroundColor Green
        exit 0
    }
    if ($state -eq 'missing') {
        Write-Host "  [missing] 没有防火墙规则 $ruleName —— RCON 25575 仍对外暴露" -ForegroundColor Yellow
        exit 1
    }
    Write-Host "  [malformed] 防火墙规则 $ruleName 存在但形态不对（应: 入站/Block/TCP/25575/已启用）" -ForegroundColor Yellow
    try {
        $r = Get-NetFirewallRule -DisplayName $ruleName | Select-Object -First 1
        $pf = $r | Get-NetFirewallPortFilter
        Write-Host ("      实际: Enabled={0} Direction={1} Action={2} Protocol={3} LocalPort={4}" -f `
            $r.Enabled, $r.Direction, $r.Action, $pf.Protocol, $pf.LocalPort) -ForegroundColor DarkGray
    } catch { }
    exit 2
}

$ErrorActionPreference = 'Stop'

# 管理员检查
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host ''
    Write-Host '  [错误] 需要管理员权限。' -ForegroundColor Red
    Write-Host '         请右键本文件 → “以管理员身份运行”，或在管理员 PowerShell 里执行：' -ForegroundColor Yellow
    Write-Host '         powershell -ExecutionPolicy Bypass -File .\scripts\deny-rcon-25575-in.ps1' -ForegroundColor Yellow
    Write-Host ''
    Read-Host '按回车退出'
    exit 1
}

$ruleName = 'deny-rcon-25575-in'   # 定义在文件上部（-Verify 也要用）

# 先删同名旧规则（幂等）
netsh advfirewall firewall delete rule name="$ruleName" 2>$null | Out-Null

# 加拒绝规则。profile=any 覆盖 专用/公用/域 三种网络。
# 只拦"专用网络"会漏掉"公用网络"（酒店/咖啡厅 Wi-Fi），等于没拦。
netsh advfirewall firewall add rule `
    name="$ruleName" `
    dir=in action=block protocol=TCP localport=25575 profile=any `
    description="Block inbound RCON. Bot uses loopback; firewall does not filter loopback."

if ($LASTEXITCODE -ne 0) {
    Write-Host '  [错误] 添加规则失败（退出码 ' $LASTEXITCODE '）' -ForegroundColor Red
    Read-Host '按回车退出'
    exit 1
}

# ★ R6 #48（2026-11-11）：netsh 退出码 0 只证明"命令没报错"，不证明规则长成了要的样子
#   （组策略/安全软件可以吞掉它）。加完必须**独立回读**一次，形态不对就如实失败。
$state = Get-RconRuleState -Name $ruleName
if ($state -ne 'ok') {
    Write-Host ("  [错误] 规则已提交但回读形态不对：{0}" -f $state) -ForegroundColor Red
    Write-Host '         期望：入站 / Block / TCP / 本地端口 25575 / 已启用。' -ForegroundColor Yellow
    Write-Host '         可能原因：组策略接管了防火墙、或安全软件还原了规则。' -ForegroundColor Yellow
    Read-Host '按回车退出'
    exit 1
}

Write-Host ''
Write-Host '  ✅ 已添加入站拒绝规则：TCP 25575（RCON），profile=any' -ForegroundColor Green
Write-Host ''
Write-Host '  ── 怎么验证（缺一不可）───────────────────────────────' -ForegroundColor Cyan
Write-Host '  A. 本机 loopback 仍通（证明 bot 没被误伤）：'
Write-Host '       node -e "const net=require(\"net\");const s=net.connect(25575,\"127.0.0.1\",()=>{console.log(\"loopback OK\");s.end()});s.on(\"error\",e=>console.log(\"loopback FAIL\",e.message))"'
Write-Host ''
Write-Host '  B. 另一台机器打本机 LAN IP 的 25575 应【不通】：'
Write-Host '       在另一台机器 PowerShell：Test-NetConnection <本机LANIP> -Port 25575'
Write-Host '       判定：TcpTestSucceeded=False（或超时）= ✅ 通过；只有 True 才算失败。'
Write-Host '       注意：block 规则通常表现为**超时**而非"拒绝连接"，两者都算通过。'
Write-Host ''
Write-Host '  C. 另一台机器打 25565 应【仍通】（证明手机/局域网没坏）：'
Write-Host '       Test-NetConnection <本机LANIP> -Port 25565  →  TcpTestSucceeded=True'
Write-Host ''
Write-Host '  ⚠️ 不要用 netstat 判断这条修复：防火墙拦的是**数据包**，不改**监听地址**，'
Write-Host '     所以 0.0.0.0:25575 仍会显示 LISTENING —— 那是正常的。'
Write-Host ''
Write-Host '  ── 回滚 ──────────────────────────────────────────────' -ForegroundColor DarkGray
Write-Host ("  netsh advfirewall firewall delete rule name=" + [char]34 + $ruleName + [char]34) -ForegroundColor DarkGray
Write-Host ''
Read-Host '按回车退出'
