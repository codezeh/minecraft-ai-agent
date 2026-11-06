<#
.SYNOPSIS
    验证一个世界备份**真的可用**（OPS-012，2026-11-06 深度检查）。

.DESCRIPTION
    报告的核心批评不是"没备份"，而是"**恢复能力尚无验证证据**"：
    有 zip 不等于能恢复 —— 可能缺 region、level.dat 坏、压缩包只成功了一半。

    本脚本做**只读**核验（绝不写世界目录）：
      1. 读 manifest.json，逐项核对大小与 SHA256（证明文件没坏、没被替换）；
      2. 打开每个 zip，检查"恢复所需的关键条目"是否存在：
         · world/world_nether/world_the_end → 必须有 level.dat 与至少一个 region/*.mca
         · bots → 必须有至少一个 <bot>/memory.json 或 map/terrain3d.db
      3. 解压到**系统临时目录**做一次真实读取（level.dat 能被识别为 NBT 头、mca 长度合理），
         随后删除临时目录 —— 全程不碰 server/ 下的真实世界；
      4. 输出 PASS/FAIL 与明确的恢复步骤提示。

.PARAMETER BackupDir
    备份目录（backup-world.ps1 生成的 backups/world-<时间戳>）。

.EXAMPLE
    powershell -File scripts\verify-world-backup.ps1 -BackupDir backups\world-20261106-183000
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BackupDir
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not [System.IO.Path]::IsPathRooted($BackupDir)) { $BackupDir = Join-Path $root $BackupDir }

$script:pass = 0
$script:fail = 0
function Ok([string]$name, [string]$detail = '') { $script:pass++; Write-Host "PASS $name $detail" -ForegroundColor Green }
function Bad([string]$name, [string]$detail = '') { $script:fail++; Write-Host "FAIL $name $detail" -ForegroundColor Red }

if (-not (Test-Path $BackupDir)) { Bad "备份目录存在" $BackupDir; exit 1 }
Ok '备份目录存在' $BackupDir

# ── 1) manifest 与 SHA256 ───────────────────────────────────────────
$mf = Join-Path $BackupDir 'manifest.json'
if (-not (Test-Path $mf)) {
    Bad 'manifest.json 存在' '（旧备份可能没有 manifest；无法核验完整性）'
} else {
    $manifest = Get-Content $mf -Raw | ConvertFrom-Json
    Ok 'manifest.json 可解析' "createdAt=$($manifest.createdAt)"
    if ($manifest.consistent -eq $true) { Ok '备份时做过 save-off（一致性有保障）' }
    else { Write-Host "WARN 备份时未做 save-off：$($manifest.note)" -ForegroundColor Yellow }

    foreach ($e in $manifest.entries) {
        $p = Join-Path $BackupDir $e.name
        if (-not (Test-Path $p)) { Bad "存在 $($e.name)"; continue }
        $size = (Get-Item $p).Length
        if ($size -ne $e.bytes) { Bad "$($e.name) 大小一致" "manifest=$($e.bytes) 实际=$size" }
        else { Ok "$($e.name) 大小一致" "$size 字节" }
        $h = (Get-FileHash -Path $p -Algorithm SHA256).Hash
        if ($h -ne $e.sha256) { Bad "$($e.name) SHA256 一致" "manifest=$($e.sha256) 实际=$h" }
        else { Ok "$($e.name) SHA256 一致" }
    }
}

# ── 2) zip 内关键条目 ───────────────────────────────────────────────
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zips = Get-ChildItem $BackupDir -Filter '*.zip'
if (-not $zips) { Bad '至少有一个 .zip' }
foreach ($z in $zips) {
    $entries = $null
    try {
        $entries = [System.IO.Compression.ZipFile]::OpenRead($z.FullName)
        Ok "$($z.Name) 可打开" "条目数=$($entries.Entries.Count)"
    } catch {
        Bad "$($z.Name) 可打开" "$($_.Exception.Message)"; continue
    }
    try {
        $names = $entries.Entries | ForEach-Object { $_.FullName.Replace('\', '/') }
        switch -Wildcard ($z.BaseName) {
            'world*' {
                if ($names -contains 'world/level.dat' -or ($names | Where-Object { $_ -like '*/level.dat' })) {
                    Ok "$($z.Name) 含 level.dat"
                } else { Bad "$($z.Name) 含 level.dat" }
                $regions = @($names | Where-Object { $_ -like '*region/*.mca' })
                if ($regions.Count -gt 0) { Ok "$($z.Name) 含 region/*.mca" "$($regions.Count) 个" }
                else { Bad "$($z.Name) 含 region/*.mca" '没有任何 region 文件 = 恢复出来是空世界' }
            }
            'bots' {
                $hasMem = @($names | Where-Object { $_ -like '*/memory.json' -or $_ -like '*/map/terrain3d.db' })
                if ($hasMem.Count -gt 0) { Ok "$($z.Name) 含记忆/地形库" "$($hasMem.Count) 项" }
                else { Bad "$($z.Name) 含记忆/地形库" '机器人记忆与地形库缺失' }
            }
        }
    } finally { $entries.Dispose() }
}

# ── 3) 真解压到临时目录读一次（不碰真实世界）────────────────────────
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("wbackup-verify-" + [guid]::NewGuid().ToString('n').Substring(0, 8))
try {
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $worldZip = $zips | Where-Object { $_.BaseName -eq 'world' } | Select-Object -First 1
    if ($worldZip) {
        [System.IO.Compression.ZipFile]::ExtractToDirectory($worldZip.FullName, $tmp)
        $level = Get-ChildItem $tmp -Recurse -Filter 'level.dat' | Select-Object -First 1
        if ($level) {
            # level.dat 是 gzip 压缩的 NBT：前两字节必须是 1f 8b
            $bytes = [System.IO.File]::ReadAllBytes($level.FullName)
            if ($bytes.Length -gt 2 -and $bytes[0] -eq 0x1f -and $bytes[1] -eq 0x8b) {
                Ok '解压后 level.dat 是合法 gzip/NBT' "$($bytes.Length) 字节"
            } else {
                Bad '解压后 level.dat 是合法 gzip/NBT' "头字节=$($bytes[0]),$($bytes[1])"
            }
        } else { Bad '解压后能找到 level.dat' }
        $mca = Get-ChildItem $tmp -Recurse -Filter '*.mca' | Select-Object -First 1
        if ($mca) {
            if ($mca.Length -ge 8192) { Ok '解压后 region 文件长度合理' "$($mca.Name) $($mca.Length) 字节" }
            else { Bad '解压后 region 文件长度合理' "$($mca.Name) 只有 $($mca.Length) 字节（<8192 = 头部不完整）" }
        } else { Bad '解压后能找到 .mca' }
    } else {
        Bad '存在名为 world.zip 的主世界备份'
    }
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
if ($script:fail -eq 0) {
    Write-Host "ALL PASS: $script:pass 项通过，0 失败" -ForegroundColor Green
    Write-Host ''
    Write-Host '恢复步骤（**确认服务器已停**再执行，本脚本不代做）：'
    Write-Host '  1) 关服（scripts\stop-panel.ps1）并确认 java 进程已退出'
    Write-Host "  2) 把现有 server\world* 改名留底（例如 world.bak-<时间戳>）"
    Write-Host "  3) 解压备份里的 world*.zip 到 server\"
    Write-Host '  4) 启动并检查日志里没有 chunk/level 相关报错'
    exit 0
} else {
    Write-Host "HAS FAILURES: $script:pass 项通过，$script:fail 项失败" -ForegroundColor Red
    exit 1
}
