<#
.SYNOPSIS
    假 RCON 服务器 —— **按真实 Paper 的协议校验**，专供离线回归用。

.DESCRIPTION
    为什么需要它（R4 审计 T22）：
      当初"验证" RCON 用的假服务器**根本不校验 auth 正文**，客户端又**不校验应答**，
      于是"把命令当密码发"这种错误两边都放过去了 —— `save-off`/`save-on` 在真机上从未生效，
      却一路显示成功。这个假服务器就是为了堵住这个盲区：
        · 收 auth 包（type=3），正文**必须**等于 `-Password`，否则回 `id=-1` 并断开（与 Paper 一致）；
        · 收命令包（type=2），回 `type=0` 且正文含 `Handled: <命令>`；
        · 每个收到的包都追加一行 JSON 到 `-LogPath`，方便断言"auth 正文到底是什么"。

    ⚠ 它只用于测试，不监听外网（绑 127.0.0.1），跑完即退。

.PARAMETER Port
    监听端口（默认 25599）。

.PARAMETER Password
    期望的 RCON 密码。

.PARAMETER LogPath
    收到的包逐行写到这里（JSON Lines）。

.PARAMETER MaxConnections
    处理多少个连接后退出（默认 8）。

.PARAMETER TimeoutSec
    最长存活秒数（默认 90），防止忘了关留下常驻进程。

.EXAMPLE
    powershell -File scripts\tests\fake-rcon-server.ps1 -Port 25599 -Password testpass -LogPath tmp\fake.log
#>
param(
    [int]$Port = 25599,
    [string]$Password = 'testpass',
    [string]$LogPath,
    [int]$MaxConnections = 8,
    [int]$TimeoutSec = 90
)

$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'lib/rcon.ps1')

if (-not $LogPath) { $LogPath = Join-Path ([System.IO.Path]::GetTempPath()) 'fake-rcon.log' }
$LogPath = [System.IO.Path]::GetFullPath($LogPath)
$logDir = Split-Path -Parent $LogPath
if ($logDir -and -not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
Set-Content -LiteralPath $LogPath -Value '' -Encoding UTF8

function Write-Log([string]$kind, [string]$detail) {
    $rec = [ordered]@{ at = (Get-Date).ToString('o'); kind = $kind; detail = $detail }
    Add-Content -LiteralPath $LogPath -Value ($rec | ConvertTo-Json -Compress) -Encoding UTF8
}

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
try { $listener.Start() } catch {
    Write-Log 'error' "无法监听 $Port：$($_.Exception.Message)"
    exit 2
}
Write-Log 'listen' "127.0.0.1:$Port"

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$handled = 0
try {
    while ($handled -lt $MaxConnections -and (Get-Date) -lt $deadline) {
        if (-not $listener.Pending()) { Start-Sleep -Milliseconds 50; continue }

        $client = $listener.AcceptTcpClient()
        $handled++
        try {
            $st = $client.GetStream()

            # ── ① auth：正文必须等于密码（这是关键的校验）──
            $p = Read-RconPacket -Stream $st -TimeoutMs 5000
            Write-Log 'packet' ("type=$($p.Type) id=$($p.Id) body=$($p.Body)")

            if ($p.Type -ne 3) {
                # 真实服务器会直接断；这里也断，且记录原因
                Write-Log 'reject' "首个包不是 auth（type=$($p.Type)）"
                try { $client.Close() } catch { }
                continue
            }
            if ($p.Body -cne $Password) {
                Write-Log 'authfail' ("auth 正文不是密码（收到 '$($p.Body)'，期望 '$Password'）→ 回 id=-1")
                $bad = New-RconPacket -Id -1 -Type 2 -Body ''
                $st.Write($bad, 0, $bad.Length); $st.Flush()
                try { $client.Close() } catch { }
                continue
            }
            Write-Log 'authok' '认证通过'
            $okPkt = New-RconPacket -Id $p.Id -Type 2 -Body ''
            $st.Write($okPkt, 0, $okPkt.Length); $st.Flush()

            # ── ② 命令：type=2，逐条回应答 ──
            while ($true) {
                try { $c = Read-RconPacket -Stream $st -TimeoutMs 4000 } catch { break }
                Write-Log 'packet' ("type=$($c.Type) id=$($c.Id) body=$($c.Body)")
                if ($c.Type -ne 2) { continue }
                $reply = New-RconPacket -Id $c.Id -Type 0 -Body ("Handled: " + $c.Body)
                $st.Write($reply, 0, $reply.Length); $st.Flush()
                Write-Log 'handled' $c.Body
                if ($c.Body -eq 'stop') { break }
            }
        } catch {
            Write-Log 'connerr' $_.Exception.Message
        } finally {
            try { $client.Close() } catch { }
        }
    }
} finally {
    try { $listener.Stop() } catch { }
    Write-Log 'bye' "处理了 $handled 个连接"
}
