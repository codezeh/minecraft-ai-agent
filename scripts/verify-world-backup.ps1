<#
.SYNOPSIS
    验证一个世界备份**真的可用**（OPS-012；R4 审计 B2 假绿灯修复）。

.DESCRIPTION
    报告的核心批评不是"没备份"，而是"**恢复能力尚无验证证据**"：
    有 zip 不等于能恢复 —— 可能缺 region、level.dat 坏、压缩包只成功了一半。
    上一版验证器的实际判据是"`regions.Count -gt 0`"和"至少一个 memory.json"，
    于是"只剩 1/6 个 region、完全没有 bots.zip"的备份照样 ALL PASS、exit 0（R4 审计 B2，已实测）。

    本脚本现在做**只读**核验（绝不写世界目录），判据全部来自 manifest 的**逐项相等**：

      1. 目录本身不是半成品（`.partial` 一律 FAIL —— 那说明 backup-world.ps1 没走完 rename）；
      2. manifest.json 存在、可解析，且 **schemaVersion >= 2**（旧 manifest 没有计数，无法证明完整性 → FAIL）；
      3. 每个条目：文件存在、字节数相等、SHA256 相等；
      4. 每个 zip：条目数 == manifest.fileCount、解压总字节 == manifest.totalUncompressedBytes、
         **清单摘要（排序后的 `路径<TAB>字节数` 的 SHA256）逐字节相等** —— 少一个文件/大小变了都会 FAIL；
      5. 计数逐项相等：region 数、playerdata 数、memory.json 数、bot 数、mca 总数、level.dat 字节数；
      6. 世界：level.dat 必须能 gunzip 且首字节是 0x0a（TAG_Compound）；每个 `region/*.mca` 头部
         必须可解析（≥8192 字节、4096 字节扇区表、至少 1 个 chunk 偏移非 0）；
      7. 机器人：`bots/_board/board.sqlite` **必须存在**且字节/SHA256 与 manifest 相等，
         解出来跑 **PRAGMA integrity_check = ok**，并核对 user_version 与 jobs/claims/shared 行数；
      8. 完整性：manifest.components 必须同时含 `world` 与 `bots`，每个组件都要有对应 zip 且出现在 entries 里 ——
         **缺 bots.zip 不再是"跳过"，而是 FAIL**。

    一条都不满足就 exit 1。这里宁可响一声，也不要再给假绿灯。

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
$script:warn = 0
function Ok([string]$name, [string]$detail = '') { $script:pass++; Write-Host "PASS $name $detail" -ForegroundColor Green }
function Bad([string]$name, [string]$detail = '') { $script:fail++; Write-Host "FAIL $name $detail" -ForegroundColor Red }
function Warn([string]$name, [string]$detail = '') { $script:warn++; Write-Host "WARN $name $detail" -ForegroundColor Yellow }
function Info([string]$msg) { Write-Host "    $msg" -ForegroundColor DarkGray }

# ── 与 backup-world.ps1 完全一致的计数/摘要口径 ───────────────────────
function Get-TextSha256([string]$Text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally { $sha.Dispose() }
}

function Get-EntryCounts {
    param([object[]]$Entries, [string]$Leaf)

    $levelDat = @($Entries | Where-Object { $_.Name -eq "$Leaf/level.dat" })
    $botDirs = @()
    if ($Leaf -eq 'bots') {
        $botDirs = @($Entries |
            ForEach-Object { ($_.Name -split '/')[1] } |
            Where-Object { $_ } |
            Sort-Object -Unique)
    }
    return [ordered]@{
        fileCount     = $Entries.Count
        regions       = @($Entries | Where-Object { $_.Name -like '*/region/*.mca' }).Count
        playerdata    = @($Entries | Where-Object { $_.Name -like '*/playerdata/*.dat' }).Count
        memoryJson    = @($Entries | Where-Object { $_.Name -like '*/memory.json' }).Count
        bots          = $botDirs.Count
        mcaTotal      = @($Entries | Where-Object { $_.Name -like '*.mca' }).Count
        levelDatBytes = $(if ($levelDat.Count -eq 1) { [int64]$levelDat[0].Size } else { [int64]0 })
    }
}

function Invoke-BoardQuery {
    param([string]$DbPath, [bool]$ReadOnly = $false)

    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('wbackup-sql-' + [guid]::NewGuid().ToString('n').Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $roArg = 'rw'
    if ($ReadOnly) { $roArg = 'ro' }
    try {
        $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
        if ($nodeCmd) {
            $jsPath = Join-Path $tmp 'q.js'
            $js = @'
const { DatabaseSync } = require('node:sqlite');
const ro = process.argv[3] === 'ro';
const db = new DatabaseSync(process.argv[2], { readOnly: ro });
const uv = db.prepare('PRAGMA user_version').get().user_version;
const ic = db.prepare('PRAGMA integrity_check').all().map(r => Object.values(r)[0]).join(';');
const tables = {};
for (const t of ['jobs', 'claims', 'shared']) {
  try { tables[t] = db.prepare('select count(*) as c from ' + t).get().c; }
  catch (e) { tables[t] = null; }
}
console.log(JSON.stringify({ userVersion: uv, integrity: ic, tables }));
db.close();
'@
            Set-Content -LiteralPath $jsPath -Value $js -Encoding UTF8
            $out = & $nodeCmd.Path $jsPath $DbPath $roArg 2>$null
            if ($LASTEXITCODE -eq 0 -and $out) {
                return ($out | Out-String | ConvertFrom-Json)
            }
        }

        $pyCmd = Get-Command python -ErrorAction SilentlyContinue
        if ($pyCmd) {
            $pyPath = Join-Path $tmp 'q.py'
            $py = @'
import json, sqlite3, sys
p = sys.argv[1].replace('\\', '/')
uri = 'file:' + p + ('?mode=ro' if sys.argv[2] == 'ro' else '')
c = sqlite3.connect(uri, uri=True)
out = {'userVersion': c.execute('pragma user_version').fetchone()[0],
       'integrity': ';'.join(r[0] for r in c.execute('pragma integrity_check')),
       'tables': {}}
for t in ('jobs', 'claims', 'shared'):
    try:
        out['tables'][t] = c.execute('select count(*) from ' + t).fetchone()[0]
    except Exception:
        out['tables'][t] = None
print(json.dumps(out))
c.close()
'@
            Set-Content -LiteralPath $pyPath -Value $py -Encoding UTF8
            $out = & $pyCmd.Path $pyPath $DbPath $roArg 2>$null
            if ($LASTEXITCODE -eq 0 -and $out) {
                return ($out | Out-String | ConvertFrom-Json)
            }
        }
        return $null
    } finally {
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Test-McaHeader([System.IO.Compression.ZipArchiveEntry]$Entry) {
    # 返回 $null = 正常，否则返回问题描述
    if ($Entry.Length -lt 8192) { return "只有 $($Entry.Length) 字节（<8192 = 头部不完整）" }
    $s = $Entry.Open()
    try {
        $buf = New-Object byte[] 4096
        $read = 0
        while ($read -lt 4096) {
            $n = $s.Read($buf, $read, 4096 - $read)
            if ($n -le 0) { break }
            $read += $n
        }
    } finally { $s.Dispose() }
    if ($read -lt 4096) { return "扇区表不足 4096 字节（只有 $read）" }
    $nz = 0
    for ($i = 0; $i -lt 1024; $i++) {
        $o = $i * 4
        if ($buf[$o] -ne 0 -or $buf[$o + 1] -ne 0 -or $buf[$o + 2] -ne 0 -or $buf[$o + 3] -ne 0) { $nz++ }
    }
    if ($nz -eq 0) { return '扇区表全 0（没有任何 chunk → 空白区块）' }
    return $null
}

function Expand-ZipEntry([System.IO.Compression.ZipArchiveEntry]$Entry, [string]$DestPath) {
    $s = $Entry.Open()
    try {
        $out = [System.IO.File]::Create($DestPath)
        try { $s.CopyTo($out) } finally { $out.Dispose() }
    } finally { $s.Dispose() }
}

Add-Type -AssemblyName System.IO.Compression -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue

# ── 0) 目录本身 ─────────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $BackupDir)) { Bad '备份目录存在' $BackupDir; exit 1 }
Ok '备份目录存在' $BackupDir

$dirItem = Get-Item -LiteralPath $BackupDir
if ($dirItem.Name -like '*.partial') {
    Bad '备份目录是完成品' "目录名以 .partial 结尾（$($dirItem.Name)）—— 说明 backup-world.ps1 没走完原子 rename，这是半成品，不是备份"
}

# ── 1) manifest ─────────────────────────────────────────────────────
$manifest = $null
$mf = Join-Path $BackupDir 'manifest.json'
if (-not (Test-Path -LiteralPath $mf)) {
    Bad 'manifest.json 存在' '（没有 manifest 就无法证明完整性；旧的手工拷贝不算备份）'
    Write-Host ''
    Write-Host "HAS FAILURES: $script:pass 项通过，$script:fail 项失败" -ForegroundColor Red
    exit 1
}
try {
    $manifest = Get-Content -LiteralPath $mf -Raw -Encoding UTF8 | ConvertFrom-Json
    Ok 'manifest.json 可解析' "createdAt=$($manifest.createdAt)"
} catch {
    Bad 'manifest.json 可解析' $_.Exception.Message
    Write-Host ''
    Write-Host "HAS FAILURES: $script:pass 项通过，$script:fail 项失败" -ForegroundColor Red
    exit 1
}

$schema = 0
if ($null -ne $manifest.schemaVersion) { $schema = [int]$manifest.schemaVersion }
if ($schema -ge 3) {
    Ok 'manifest 含计数/清单摘要/来源（schemaVersion>=3）' "schemaVersion=$schema mode=$($manifest.mode)"
} else {
    Bad 'manifest 含计数/清单摘要/来源（schemaVersion>=3）' ("schemaVersion=$schema —— 旧格式没有来源与 SQLite 快照字段（t8 之前），请用新版 backup-world.ps1 重做")
}

if ($manifest.consistent -eq $true) {
    Ok '备份时保证了一致性' $manifest.note
} else {
    Warn '备份时未保证一致性' "$($manifest.note)"
}
if ($manifest.mode -eq 'Cold' -and $manifest.consistent -ne $true) {
    Bad '冷备标记与一致性自洽' "mode=Cold 但 consistent=$($manifest.consistent)"
}
if ($manifest.sourceQuiescent -eq $true) {
    Ok '复制期间源目录零变更（快照是同一时刻的）'
} else {
    Bad '复制期间源目录零变更（快照是同一时刻的）' 'manifest 没有 sourceQuiescent=true —— 无法证明备份不是"边写边拷"，请用新版 backup-world.ps1 重做'
}
if ($manifest.openDbHandles -and @($manifest.openDbHandles).Count -gt 0) {
    Info ("备份时仍有进程开着任务板库：{0}（已通过「零变更」证明兜底）" -f (@($manifest.openDbHandles) -join ', '))
}

$entries = @($manifest.entries)
if ($entries.Count -eq 0) { Bad 'manifest 列出了条目' 'entries 为空' }

# ── 2) 逐条目：字节 / SHA256 / zip 清单 ──────────────────────────────
$kindSeen = @{}
$zipByLeaf = @{}
$tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('wbackup-verify-' + [guid]::NewGuid().ToString('n').Substring(0, 8))

try {
    foreach ($e in $entries) {
        if (-not $e.name) { Bad '条目有 name 字段' 'manifest 条目缺 name'; continue }
        $leaf = $e.name
        if ($leaf -like '*.zip') { $leaf = $leaf.Substring(0, $leaf.Length - 4) }

        $p = Join-Path $BackupDir $e.name
        if (-not (Test-Path -LiteralPath $p)) {
            Bad "存在 $($e.name)" "manifest 声明了但它不在备份目录里"
            continue
        }
        Ok "存在 $($e.name)"

        $size = (Get-Item -LiteralPath $p).Length
        if ($null -eq $e.bytes) { Bad "$($e.name) 有字节数记录" 'manifest 缺 bytes' }
        elseif ($size -ne [int64]$e.bytes) { Bad "$($e.name) 大小一致" "manifest=$($e.bytes) 实际=$size" }
        else { Ok "$($e.name) 大小一致" "$size 字节" }

        if ($null -eq $e.sha256) {
            Bad "$($e.name) 有 SHA256 记录" 'manifest 缺 sha256'
        } else {
            $h = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash
            if ($h -ne $e.sha256) { Bad "$($e.name) SHA256 一致" "manifest=$($e.sha256) 实际=$h" }
            else { Ok "$($e.name) SHA256 一致" }
        }

        if (-not $e.kind) {
            Bad "$($e.name) 有组件类型（kind）" 'manifest 缺 kind（旧格式），无法判断该用哪套断言'
        } else {
            $kindSeen[$e.kind] = $true
        }

        # 来源可追溯（t8）：每个条目必须写明它到底来自磁盘哪里，否则"恢复到哪"全靠猜
        if ($e.source) { Ok "$($e.name) 记录了来源路径" $e.source }
        else { Bad "$($e.name) 记录了来源路径" 'manifest 缺 source —— 看不出这个包是从哪拷来的' }
        if ($e.sourceAbs) { } else { Bad "$($e.name) 记录了来源绝对路径" 'manifest 缺 sourceAbs' }

        if ($e.name -notlike '*.zip') { continue }

        # —— 打开 zip，重算清单 ——
        $zip = $null
        try {
            $zip = [System.IO.Compression.ZipFile]::OpenRead($p)
            Ok "$($e.name) 可打开" "条目数=$($zip.Entries.Count)"
        } catch {
            Bad "$($e.name) 可打开" $_.Exception.Message
            continue
        }

        try {
            $items = New-Object System.Collections.Generic.List[object]
            foreach ($ze in $zip.Entries) {
                if ($ze.FullName.EndsWith('/')) { continue }
                $items.Add([pscustomobject]@{ Name = $ze.FullName; Size = [int64]$ze.Length })
            }
            $itemsArr = $items.ToArray()

            $total = [int64]0
            $lines = New-Object System.Collections.Generic.List[string]
            foreach ($i in $itemsArr) {
                $total += $i.Size
                $lines.Add("$($i.Name)`t$($i.Size)")
            }
            $arr = $lines.ToArray()
            [Array]::Sort($arr, [System.StringComparer]::Ordinal)
            $digest = Get-TextSha256 (($arr -join "`n") + "`n")

            $counts = Get-EntryCounts -Entries $itemsArr -Leaf $leaf
            $mc = $e.counts

            # 条目数 / 总字节 / 清单摘要（"少 5/6 个 region" 就死在这里）
            if ($null -eq $mc) {
                Bad "$($e.name) 有计数记录" 'manifest 缺 counts（旧格式）'
            } else {
                if ($null -ne $mc.fileCount) {
                    if ([int64]$mc.fileCount -ne [int64]$itemsArr.Count) {
                        Bad "$($e.name) 文件数一致" "manifest=$($mc.fileCount) 实际=$($itemsArr.Count)"
                    } else { Ok "$($e.name) 文件数一致" "$($itemsArr.Count)" }
                } else { Bad "$($e.name) 文件数一致" 'manifest 缺 counts.fileCount' }

                if ($null -ne $e.totalUncompressedBytes) {
                    if ([int64]$e.totalUncompressedBytes -ne $total) {
                        Bad "$($e.name) 解压总字节一致" "manifest=$($e.totalUncompressedBytes) 实际=$total"
                    } else { Ok "$($e.name) 解压总字节一致" "$total" }
                } else { Bad "$($e.name) 解压总字节一致" 'manifest 缺 totalUncompressedBytes' }

                if ($e.inventoryDigest) {
                    if ($e.inventoryDigest -ne $digest) {
                        Bad "$($e.name) 清单摘要一致" "manifest=$($e.inventoryDigest) 实际=$digest（有文件增删或大小变化）"
                    } else { Ok "$($e.name) 清单摘要一致" $digest.Substring(0, 12) + '…' }
                } else { Bad "$($e.name) 清单摘要一致" 'manifest 缺 inventoryDigest' }

                # 计数逐项相等
                $pairs = @(
                    @{ key = 'regions'; label = 'region/*.mca' },
                    @{ key = 'playerdata'; label = 'playerdata/*.dat' },
                    @{ key = 'memoryJson'; label = 'memory.json' },
                    @{ key = 'bots'; label = 'bot 目录' },
                    @{ key = 'mcaTotal'; label = '*.mca 总数' }
                )
                foreach ($pr in $pairs) {
                    $want = $mc.($pr.key)
                    $got = $counts[$pr.key]
                    if ($null -eq $want) { continue }   # 该组件不适用（例如世界没有 bots 计数）
                    if ([int64]$want -ne [int64]$got) {
                        Bad "$($e.name) 含 $($pr.label) 数量相等" "manifest=$want 实际=$got"
                    } else { Ok "$($e.name) 含 $($pr.label) 数量相等" "$got" }
                }
                if ($null -ne $mc.levelDatBytes) {
                    if ([int64]$mc.levelDatBytes -ne [int64]$counts['levelDatBytes']) {
                        Bad "$($e.name) level.dat 大小一致" "manifest=$($mc.levelDatBytes) 实际=$($counts['levelDatBytes'])"
                    } else { Ok "$($e.name) level.dat 大小一致" "$($counts['levelDatBytes'])" }
                }
            }

            # —— 世界：level.dat 真解压 + 每个 region 头部可解析 ——
            if ($e.kind -eq 'world') {
                $levelEntry = $zip.GetEntry("$leaf/level.dat")
                if (-not $levelEntry) {
                    Bad "$($e.name) 含 level.dat" "没有 $leaf/level.dat"
                } else {
                    $s = $levelEntry.Open()
                    try {
                        $gz = New-Object System.IO.Compression.GZipStream($s, [System.IO.Compression.CompressionMode]::Decompress)
                        $first = $gz.ReadByte()
                        $gz.Dispose()
                    } finally { $s.Dispose() }
                    if ($first -eq 0x0a) { Ok "$($e.name) level.dat 是合法 gzip/NBT" '首字节 0x0a（TAG_Compound）' }
                    else { Bad "$($e.name) level.dat 是合法 gzip/NBT" "解压后首字节=$first（不是 0x0a）" }
                }

                $regionEntries = @($zip.Entries | Where-Object { -not $_.FullName.EndsWith('/') -and $_.FullName -like '*/region/*.mca' })
                if ($regionEntries.Count -eq 0) {
                    Bad "$($e.name) 含 region/*.mca" '没有任何 region 文件 = 恢复出来是空世界'
                } else {
                    $brokenList = New-Object System.Collections.Generic.List[string]
                    foreach ($re in $regionEntries) {
                        $problem = Test-McaHeader $re
                        if ($problem) { $brokenList.Add("$($re.FullName)：$problem") }
                    }
                    if ($brokenList.Count -eq 0) {
                        Ok "$($e.name) 每个 region/*.mca 头部可解析" "$($regionEntries.Count) 个都至少有 1 个 chunk"
                    } else {
                        Bad "$($e.name) 每个 region/*.mca 头部可解析" (($brokenList | Select-Object -First 5) -join ' / ')
                    }
                }
            }

            # —— SQLite 快照（VACUUM INTO）：存在、字节/SHA256 相等、integrity_check=ok、行数一致 ——
            # 为什么必须核对 method：直接复制活跃库会丢掉还在 -wal 里的提交 ——
            # 实测 integrity_check 仍为 ok，但 shared 表 1→0（静默回退，任何"库能打开"的检查都发现不了）。
            $dbMap = $e.databases
            if ($e.kind -eq 'bots') {
                $boardKey = 'bots/_board/board.sqlite'
                $hasBoard = $false
                if ($dbMap) { $hasBoard = ($null -ne $dbMap.PSObject.Properties[$boardKey]) }
                if ($hasBoard) { Ok "$($e.name) 含任务板快照 $boardKey" }
                else { Bad "$($e.name) 含任务板快照 $boardKey" '任务板库不在包里 = 恢复后任务单/预约/共享地标全丢' }
            }
            if ($dbMap) {
                foreach ($dbProp in $dbMap.PSObject.Properties) {
                    $dbPath = $dbProp.Name
                    $meta = $dbProp.Value
                    $dbEntry = $zip.GetEntry($dbPath)   # databases 的键就是包内完整路径（如 bots/_board/board.sqlite）
                    if (-not $dbEntry) {
                        Bad "$($e.name) 含 $dbPath" 'manifest 声明了这个库，但包里没有'
                        continue
                    }
                    Ok "$($e.name) 含 $dbPath" "$($dbEntry.Length) 字节"

                    if ($meta.method -eq 'VACUUM INTO') { Ok "$dbPath 用 VACUUM INTO 取快照" }
                    else { Bad "$dbPath 用 VACUUM INTO 取快照" "method=$($meta.method) —— 直接复制活跃库会丢 -wal 里的提交（integrity_check 仍 ok，但行数会静默回退）" }

                    if ($null -ne $meta.bytes) {
                        if ([int64]$meta.bytes -ne [int64]$dbEntry.Length) { Bad "$dbPath 大小一致" "manifest=$($meta.bytes) 实际=$($dbEntry.Length)" }
                        else { Ok "$dbPath 大小一致" "$($dbEntry.Length)" }
                    } else { Bad "$dbPath 大小一致" 'manifest 缺 bytes' }

                    $work = Join-Path $tmpRoot ($leaf + '-' + ($dbPath -replace '[^A-Za-z0-9]', '_'))
                    New-Item -ItemType Directory -Force -Path $work | Out-Null
                    $dbCopy = Join-Path $work 'db.sqlite'
                    Expand-ZipEntry -Entry $dbEntry -DestPath $dbCopy

                    if ($meta.sha256) {
                        $h2 = (Get-FileHash -LiteralPath $dbCopy -Algorithm SHA256).Hash
                        if ($h2 -ne $meta.sha256) { Bad "$dbPath SHA256 一致" "manifest=$($meta.sha256) 实际=$h2" }
                        else { Ok "$dbPath SHA256 一致" }
                    } else { Bad "$dbPath 有 SHA256" 'manifest 缺 sha256' }

                    $q = Invoke-BoardQuery -DbPath $dbCopy -ReadOnly $false
                    if (-not $q) {
                        Bad "$dbPath integrity_check" '无法打开（node:sqlite / python 都不可用，不能假装通过）'
                    } else {
                        if ($q.integrity -eq 'ok') { Ok "$dbPath integrity_check=ok" }
                        else { Bad "$dbPath integrity_check" "$($q.integrity)" }

                        if ($null -ne $meta.userVersion) {
                            if ([int64]$meta.userVersion -ne [int64]$q.userVersion) { Bad "$dbPath user_version 一致" "manifest=$($meta.userVersion) 实际=$($q.userVersion)" }
                            else { Ok "$dbPath user_version 一致" "$($q.userVersion)" }
                        }
                        if ($meta.tables) {
                            foreach ($tProp in $meta.tables.PSObject.Properties) {
                                $t = $tProp.Name
                                $want = $tProp.Value
                                if ($null -eq $want) { continue }
                                $got = $null
                                if ($q.tables) { $got = $q.tables.$t }
                                if ($null -eq $got) { Bad "$dbPath 表 $t 行数与快照一致" "库里没有 $t 表" }
                                elseif ([int64]$want -ne [int64]$got) { Bad "$dbPath 表 $t 行数与快照一致" "manifest=$want 实际=$got" }
                                else { Ok "$dbPath 表 $t 行数与快照一致" "$got" }
                            }
                        }
                    }
                }
            }

        } finally { $zip.Dispose() }

        $zipByLeaf[$leaf] = $p
    }

    # ── 3) 完整性：清单声明的组件必须齐全（缺 bots.zip → FAIL，不再"跳过"）──
    foreach ($required in @('world', 'bots')) {
        if ($kindSeen.ContainsKey($required)) { Ok "备份含 $required 组件" }
        else { Bad "备份含 $required 组件" "manifest 里没有任何 kind=$required 的条目 —— 这类缺失以前会被静默跳过" }
    }

    # 双 bots 目录（根 bots/ 与 mindcraft/bots/）会让人恢复到错库：只认唯一真相 mindcraft/bots
    $botsEntries = @($entries | Where-Object { $_.kind -eq 'bots' })
    foreach ($be in $botsEntries) {
        if ($be.source -eq 'mindcraft/bots') { Ok '任务板/记忆来自唯一真相 mindcraft/bots' $be.source }
        else { Bad '任务板/记忆来自唯一真相 mindcraft/bots' "source=$($be.source) —— 恢复到错目录会让机器人和任务板读到另一份（旧的）数据" }
    }
    if ($manifest.botsSource) {
        if ($manifest.botsSource.canonical -eq 'mindcraft/bots') { Ok 'manifest 声明了 bots 唯一真相' $manifest.botsSource.canonical }
        else { Bad 'manifest 声明了 bots 唯一真相' "canonical=$($manifest.botsSource.canonical)" }
        if ($manifest.botsSource.legacy -and $manifest.botsSource.legacy.exists) {
            Info ("遗留目录 {0} 未纳入备份：{1}" -f $manifest.botsSource.legacy.path, $manifest.botsSource.legacy.note)
        }
    } else {
        Bad 'manifest 声明了 bots 唯一真相' '缺 botsSource 段'
    }

    $components = @($manifest.components)
    if ($components.Count -eq 0) {
        Bad 'manifest 声明了组件清单' 'components 为空，无法判断"该有的都有没有"'
    } else {
        foreach ($c in $components) {
            if ($zipByLeaf.ContainsKey($c)) { Ok "组件 $c 有对应压缩包" }
            else { Bad "组件 $c 有对应压缩包" "components 声明了 $c，但 entries 里没有 $c.zip" }
        }
    }
    foreach ($s in @($manifest.skipped)) {
        if (-not $s -or -not $s.name) { continue }
        if ($zipByLeaf.ContainsKey($s.name)) {
            Bad "skipped 组件 $($s.name) 不在备份里" 'manifest 既说跳过又说备份了，自相矛盾'
        }
    }

    if ($manifest.excluded -and @($manifest.excluded).Count -gt 0) {
        $ex = (@($manifest.excluded) | ForEach-Object { "$($_.files)×$($_.pattern)" }) -join '; '
        Ok '排除项已显式记录' $ex
    }
} finally {
    Remove-Item $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue
}

# ── 4) 结论 ─────────────────────────────────────────────────────────
Write-Host ''
if ($script:fail -eq 0) {
    Write-Host "ALL PASS: $script:pass 项通过，0 失败（$($script:warn) 项警告）" -ForegroundColor Green
    Write-Host ''
    Write-Host '恢复步骤（**确认服务器已停**再执行，本脚本不代做）：'
    Write-Host '  1) 关服（scripts\stop-panel.ps1）并确认 java 进程已退出'
    Write-Host '  2) 把现有 server\world* 改名留底（例如 world.bak-<时间戳>）'
    Write-Host '  3) 解压备份里的 world*.zip 到 server\'
    Write-Host '  4) 解压 bots.zip 到 mindcraft\，任务板只还原 board.sqlite + board.sqlite-wal（**丢掉 -shm**，SQLite 会重建）'
    Write-Host '  5) 启动并检查日志里没有 chunk/level 相关报错'
    exit 0
} else {
    Write-Host "HAS FAILURES: $script:pass 项通过，$script:fail 项失败（$($script:warn) 项警告）" -ForegroundColor Red
    exit 1
}
