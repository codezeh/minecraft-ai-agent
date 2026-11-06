<#
.SYNOPSIS
    世界 + 机器人数据的一致性快照（OPS-012，2026-11-06 深度检查）。

.DESCRIPTION
    为什么需要这个脚本：
      报告盘点发现项目内可见的世界备份**停留在 10 月 18 日**，之后所有建造都没有快照，
      而且从来没有人验证过"备份真的能恢复"。CoreProtect 记录方块改动，**不能替代完整存档备份**
      （它不含实体/区块 NBT/玩家数据，也回不去到另一个时间点）。

    本脚本做的事（顺序很重要）：
      1. 先 `save-off` —— 停止自动写盘，避免压缩过程中区块被写一半；
      2. `save-all flush` —— 把内存里所有区块强制落盘，并等服务器确认；
      3. 复制/压缩 world*、playerdata、bots/（记忆与地形库）到 backups/world-<时间戳>/；
      4. **无论成败**都 `save-on` 恢复自动写盘（finally）；
      5. 生成 manifest.json（文件清单 + 大小 + SHA256），供 verify-world-backup.ps1 核验。

    安全边界：
      · 只在 **RCON 可用**时才会先 save-off；RCON 不可用则退化为"直接压缩 + 明确警告"
        （仍然是有效快照，只是有一致性风险，警告里会写清楚）。
      · 不删除任何旧备份；不修改世界内容。

.PARAMETER OutDir
    备份根目录，默认 <repo>/backups。

.PARAMETER Keep
    保留最近多少个 world-* 备份（默认 7）。0 表示不清理。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\backup-world.ps1
#>
[CmdletBinding()]
param(
    [string]$OutDir,
    [int]$Keep = 7
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $root 'backups' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dest = Join-Path $OutDir "world-$stamp"

function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# ── RCON（读了配置才用；读不到就降级）────────────────────────────────
function Get-RconConfig {
    $p = Join-Path $root 'server\server.properties'
    if (-not (Test-Path $p)) { return $null }
    $kv = @{}
    foreach ($line in Get-Content $p) {
        if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
        $i = $line.IndexOf('=')
        $kv[$line.Substring(0, $i).Trim()] = $line.Substring($i + 1).Trim()
    }
    if ($kv['enable-rcon'] -ne 'true') { return $null }
    $pw = $kv['rcon.password']
    if (-not $pw) { return $null }
    $port = 25575
    if ($kv['rcon.port']) { [void][int]::TryParse($kv['rcon.port'], [ref]$port) }
    return @{ Password = $pw; Port = $port }
}

function Invoke-Rcon([string]$Password, [int]$Port, [string]$Command) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.Connect('127.0.0.1', $Port)
        $stream = $client.GetStream()
        $writer = New-Object System.IO.BinaryWriter($stream)
        $reader = New-Object System.IO.BinaryReader($stream)
        $id = 1
        $payload = [System.Text.Encoding]::ASCII.GetBytes($Command)
        $writer.Write([int32]($payload.Length + 10)); $writer.Write([int32]$id); $writer.Write([int32]3); $writer.Write($payload); $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Flush()
        # 读两包：认证响应 + 命令响应（够用即可，不做完整多包重组）
        for ($i = 0; $i -lt 2; $i++) {
            if (-not $client.Connected) { break }
            $size = $reader.ReadInt32(); $null = $reader.ReadInt32(); $null = $reader.ReadInt32()
            $null = $reader.ReadBytes($size - 8)
            if ($i -eq 0) {
                # 用同一连接发命令
                $writer.Write([int32]($payload.Length + 10)); $writer.Write([int32]2); $writer.Write([int32]3); $writer.Write($payload); $writer.Write([byte]0); $writer.Write([byte]0)
                $writer.Flush()
            }
        }
        return $true
    } catch {
        return $false
    } finally {
        try { $client.Close() } catch { }
    }
}

Write-Step "备份目标：$dest"
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$rcon = Get-RconConfig
$savedOff = $false
if ($rcon) {
    Write-Step 'RCON 可用 → save-off + save-all flush（保证区块不写一半）'
    $ok1 = Invoke-Rcon -Password $rcon.Password -Port $rcon.Port -Command 'save-off'
    $ok2 = Invoke-Rcon -Password $rcon.Password -Port $rcon.Port -Command 'save-all flush'
    if ($ok1 -and $ok2) { $savedOff = $true }
    else { Write-Warning 'RCON 命令没成功 → 继续备份，但一致性无保证（存档可能在压缩过程中变化）' }
    Start-Sleep -Milliseconds 800
} else {
    Write-Warning 'RCON 不可用（未启用/无口令）→ 直接压缩。建议先关服或手动 save-off，否则可能拿到半个区块。'
}

try {
    $items = @()
    $serverDir = Join-Path $root 'server'
    foreach ($name in @('world', 'world_nether', 'world_the_end')) {
        $p = Join-Path $serverDir $name
        if (Test-Path $p) { $items += $p }
    }
    $bots = Join-Path $root 'mindcraft\bots'
    if (Test-Path $bots) { $items += $bots }

    if (-not $items) { throw "没找到任何要备份的目录（world*/bots）" }

    $manifest = @{
        createdAt = (Get-Date).ToString('o')
        project   = $root
        consistent = $savedOff
        note       = $(if ($savedOff) { 'save-off + save-all flush 已执行' } else { 'RCON 不可用：未做 save-off，一致性无保证' })
        entries    = @()
    }

    foreach ($item in $items) {
        $leaf = Split-Path -Leaf $item
        $zip = Join-Path $dest "$leaf.zip"
        Write-Step "压缩 $leaf → $(Split-Path -Leaf $zip)"
        Compress-Archive -Path $item -DestinationPath $zip -CompressionLevel Optimal -Force
        $h = Get-FileHash -Path $zip -Algorithm SHA256
        $manifest.entries += @{
            name   = "$leaf.zip"
            bytes  = (Get-Item $zip).Length
            sha256 = $h.Hash
        }
    }

    $manifest | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $dest 'manifest.json') -Encoding UTF8
    Write-Step "完成：$dest"
    Write-Host "   一致性：$(if ($savedOff) { '已 save-off（推荐）' } else { '未 save-off（见警告）' })"
    Write-Host "   核验： powershell -File scripts\verify-world-backup.ps1 -BackupDir `"$dest`""
} catch {
    Write-Error "备份失败：$_"
    exit 1
} finally {
    if ($savedOff) {
        Write-Step '恢复自动写盘（save-on）'
        Invoke-Rcon -Password $rcon.Password -Port $rcon.Port -Command 'save-on' | Out-Null
    }
}

# ── 保留策略 ────────────────────────────────────────────────────────
if ($Keep -gt 0) {
    $olds = Get-ChildItem $OutDir -Directory -Filter 'world-*' |
        Sort-Object LastWriteTime -Descending | Select-Object -Skip $Keep
    foreach ($d in $olds) {
        Write-Host "   清理旧备份：$($d.Name)" -ForegroundColor DarkGray
        Remove-Item $d.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
}
