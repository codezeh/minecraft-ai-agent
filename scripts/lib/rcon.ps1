<#
.SYNOPSIS
    Minecraft RCON 客户端 —— **唯一实现**（backup-world.ps1 / restore-drill.ps1 共用）。

.DESCRIPTION
    为什么要有这个文件（R4 审计 T22）：
      `backup-world.ps1` 曾经自己写了一份 RCON 客户端，协议是错的：
        · type=3 是 **auth 包**，正文必须是**密码**，它发的却是**命令**；
        · 于是真实 Paper 立刻回 `id=-1` 并断开连接；
        · 之后又用同一个 payload（仍是命令）发 type=2，等于**从来没发过真正的命令**；
        · 最后无条件 `return $true` —— **不校验应答**，所以失败也看不出来。
      净效果：`save-off` / `save-all flush` / `save-on` 这三条一致性动作在真实服务器上
      **从未生效过一次**，而脚本一直以为成功了。它之所以能藏这么久，是因为当时的
      "验证"用的是自己写的假 RCON 服务器，而假服务器既**不校验 auth 正文**、客户端也**不校验应答**。

    正确协议（Minecraft / Paper，已在本机 Paper 1.21.8 实测）：
      1) 连接 TCP；
      2) 发 auth 包：`length = 10 + len(password)`, `id = 1`, `type = 3`, `body = password`, `0x00 0x00`；
         服务器回 `id = 1`（成功）或 `id = -1`（失败）；
      3) 发命令包：`id = 2`, `type = 2`, `body = command`；
         服务器回 `type = 0` 的应答，正文是命令输出；
      4) 任何一步读不到完整包 / 超时 / id 不符 ⇒ **判失败**，绝不假装成功。

    导出（dot-source 后可用）：
      · New-RconPacket    -Id -Type -Body            → byte[]
      · Read-RconPacket   -Stream [-TimeoutMs]       → @{ Id; Type; Body }
      · Invoke-RconCommand -Password -Port [-Command] [-Server] [-TimeoutMs]
                                                      → @{ ok; body; error; authId }
      · Invoke-RconCommandWithRetry -Password -Port -Command [-Attempts] [-DelayMs]
      · Invoke-Rcon        （= Invoke-RconCommand 的别名，保持老调用点可读）

    用法：
        . (Join-Path $PSScriptRoot 'lib/rcon.ps1')
        $r = Invoke-RconCommand -Password $pw -Port 25575 -Command 'save-all flush'
        if (-not $r.ok) { Write-Warning $r.error }

.NOTES
    只依赖 .NET 基础类；无第三方模块。PowerShell 5.1 可用。
#>

# 一个 RCON 包：length(4) + id(4) + type(4) + body + 2 个 0x00
function New-RconPacket {
    param(
        [Parameter(Mandatory = $true)][int]$Id,
        [Parameter(Mandatory = $true)][int]$Type,
        [string]$Body = ''
    )
    $b = [System.Text.Encoding]::ASCII.GetBytes($Body)
    $ms = New-Object System.IO.MemoryStream
    $w = New-Object System.IO.BinaryWriter($ms)
    try {
        $w.Write([int32]($b.Length + 10))   # 4(id) + 4(type) + body + 2(nul)
        $w.Write([int32]$Id)
        $w.Write([int32]$Type)
        $w.Write($b)
        $w.Write([byte]0)
        $w.Write([byte]0)
        $w.Flush()
        return $ms.ToArray()
    } finally { $w.Dispose(); $ms.Dispose() }
}

# 从流里读**一个完整**回包。读不满/超时/长度非法都抛错（调用方据此判失败）。
function Read-RconPacket {
    param(
        [Parameter(Mandatory = $true)]$Stream,
        [int]$TimeoutMs = 5000
    )
    $Stream.ReadTimeout = $TimeoutMs

    $hdr = New-Object byte[] 4
    $got = 0
    while ($got -lt 4) {
        $n = $Stream.Read($hdr, $got, 4 - $got)
        if ($n -le 0) { throw '连接被对端关闭（没读到包长度）' }
        $got += $n
    }
    $size = [System.BitConverter]::ToInt32($hdr, 0)
    if ($size -lt 10 -or $size -gt 65536) { throw "非法的 RCON 包长度：$size" }

    $buf = New-Object byte[] $size
    $got = 0
    while ($got -lt $size) {
        $n = $Stream.Read($buf, $got, $size - $got)
        if ($n -le 0) { throw '连接被对端关闭（包正文不完整）' }
        $got += $n
    }

    $id = [System.BitConverter]::ToInt32($buf, 0)
    $type = [System.BitConverter]::ToInt32($buf, 4)
    $bodyLen = $size - 8 - 2
    if ($bodyLen -lt 0) { $bodyLen = 0 }
    $body = ''
    if ($bodyLen -gt 0) { $body = [System.Text.Encoding]::ASCII.GetString($buf, 8, $bodyLen) }
    return @{ Id = $id; Type = $type; Body = $body }
}

# 执行一条 RCON 命令（不传 -Command 则只做认证，用来探活）
function Invoke-RconCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Password,
        [Parameter(Mandatory = $true)][int]$Port,
        [string]$Command = '',
        [string]$Server = '127.0.0.1',
        [int]$TimeoutMs = 5000
    )
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect($Server, $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs)) {
            return @{ ok = $false; error = "连接超时：$Server`:$Port"; authId = $null; body = '' }
        }
        $client.EndConnect($iar)
        $st = $client.GetStream()
        $st.ReadTimeout = $TimeoutMs
        $st.WriteTimeout = $TimeoutMs

        # ① auth：正文必须是**密码**
        $auth = New-RconPacket -Id 1 -Type 3 -Body $Password
        $st.Write($auth, 0, $auth.Length); $st.Flush()

        $resp = Read-RconPacket -Stream $st -TimeoutMs $TimeoutMs
        if ($resp.Id -eq -1) {
            return @{ ok = $false; error = 'RCON 认证失败（服务端回 id=-1：密码不对，或把命令当密码发了）'; authId = $resp.Id; body = '' }
        }
        if ($resp.Id -ne 1) {
            return @{ ok = $false; error = "RCON 认证应答 id 异常：$($resp.Id)（期望 1）"; authId = $resp.Id; body = '' }
        }
        if (-not $Command) { return @{ ok = $true; body = ''; error = $null; authId = $resp.Id } }

        # ② 命令：type=2，正文是命令本身
        $pkt = New-RconPacket -Id 2 -Type 2 -Body $Command
        $st.Write($pkt, 0, $pkt.Length); $st.Flush()

        $resp2 = Read-RconPacket -Stream $st -TimeoutMs $TimeoutMs
        if ($resp2.Id -ne 2) {
            return @{ ok = $false; error = "命令应答 id 异常：$($resp2.Id)（期望 2）"; authId = $resp.Id; body = $resp2.Body }
        }
        return @{ ok = $true; body = $resp2.Body; error = $null; authId = $resp.Id }
    } catch {
        return @{ ok = $false; error = $_.Exception.Message; authId = $null; body = '' }
    } finally { try { $client.Close() } catch { } }
}

# 带重试（服务端 RCON 线程刚起来时可能还没 bind）
function Invoke-RconCommandWithRetry {
    param(
        [Parameter(Mandatory = $true)][string]$Password,
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$Command,
        [int]$Attempts = 5,
        [int]$DelayMs = 800
    )
    $last = @{ ok = $false; error = '未执行'; authId = $null; body = '' }
    for ($i = 1; $i -le $Attempts; $i++) {
        $last = Invoke-RconCommand -Password $Password -Port $Port -Command $Command
        if ($last.ok) { return $last }
        if ($i -lt $Attempts) { Start-Sleep -Milliseconds $DelayMs }
    }
    return $last
}

# 兼容名：老调用点写的是 Invoke-Rcon -Password/-Port/-Command
function Invoke-Rcon {
    param(
        [Parameter(Mandatory = $true)][string]$Password,
        [Parameter(Mandatory = $true)][int]$Port,
        [string]$Command = '',
        [string]$Server = '127.0.0.1',
        [int]$TimeoutMs = 5000
    )
    return Invoke-RconCommand -Password $Password -Port $Port -Command $Command -Server $Server -TimeoutMs $TimeoutMs
}
