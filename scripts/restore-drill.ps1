<#
.SYNOPSIS
    恢复演练：证明"备份真的能恢复"（OPS-012 / R4 审计 A2 §5，用户优先级 ② 的核心交付）。

.DESCRIPTION
    为什么需要这个脚本：
      审计的结论不是"没备份"，而是"**恢复能力尚无验证证据**"。有 zip 不等于能恢复 ——
      可能缺 region、level.dat 坏、板库丢了 WAL 里的行、名字对但内容空。
      这个脚本把"能恢复"跑成一条可重复的命令：解压 → 起一台隔离服务端 → 12 条断言 → PASS/FAIL + 证据文件。

    安全边界（重要）：
      · **绝不写 server/ 与 backups/**：所有产物都在 `<repo>/tmp/drill-<时间戳>/` 里，
        骨架（server.jar / libraries / versions / cache）是从 server/ **只读复制**过去的；
      · 隔离端口：Minecraft `25567`、RCON `25568`，与主服（25565 / 25575）互不干扰；
      · 演练用的 server.properties 由本脚本生成（独立世界目录、online-mode=false），不读也不改主服配置；
      · 结束时（含失败/异常路径）一定把 java 进程收掉，不会留下孤儿服占端口。

    12 条断言：
       1  manifest 可读且 schemaVersion>=3（v3 才有来源与计数）
       2  每个压缩包的字节与 SHA256 与 manifest 相等（坏包当场暴露）
       3  每个世界的 region/*.mca 数量与 manifest 相等
       4  每个世界的 playerdata/*.dat 数量与 manifest 相等
       5  每个 .mca 头部可解析（扇区表 4096B、至少 1 个 chunk 偏移非 0）
       6  每个世界的 level.dat 解压后首字节是 0x0a（TAG_Compound）
       7  任务板 board.sqlite integrity_check = ok
       8  任务板 jobs / claims / shared 行数与 manifest 快照相等
       9  每个 bot 的 memory.json 都能 JSON.parse
      10  隔离服启动日志出现 `Done (`
      11  启动日志里 ERROR 数为 0（离线网络噪音可显式豁免，见 -StrictErrors）
      12  RCON `stop` 之后日志出现 `All chunks are saved` / `All dimensions are saved`

    失败时明确指出是第几条断言红了，并把证据（报告 + 日志）留在演练目录里。

.PARAMETER BackupDir
    要演练的备份目录；默认取 backups/ 下**最新**一个含 manifest.json 的 world-*。

.PARAMETER Port
    隔离服端口（默认 25567）。

.PARAMETER RconPort
    隔离服 RCON 端口（默认 25568）。

.PARAMETER TimeoutSec
    等待 `Done (` 的上限秒数（默认 240）。

.PARAMETER KeepArtefacts
    保留整个演练目录（含 225MB 骨架与还原出来的世界）。默认只保留 report.json / report.md / latest.log。

.PARAMETER StrictErrors
    严格模式：不加任何豁免，日志里出现任何 ERROR 都判 11 红。

.PARAMETER JavaPath
    指定 java.exe；默认在 `<repo>/.tools/jdk-*/bin/java.exe` 里找，其次 PATH。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\restore-drill.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\restore-drill.ps1 -BackupDir backups\world-20261108-034843 -KeepArtefacts

.NOTES
    退出码：0 = 12 条全 PASS；1 = 有 FAIL（含前置条件不满足）。
#>
[CmdletBinding()]
param(
    [string]$BackupDir,
    [int]$Port = 25567,
    [int]$RconPort = 25568,
    [int]$TimeoutSec = 240,
    [switch]$KeepArtefacts,
    [switch]$StrictErrors,
    [string]$JavaPath
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# RCON 只有一份实现（scripts/lib/rcon.ps1）：auth 正文=密码、且必须校验应答。
. (Join-Path $PSScriptRoot 'lib/rcon.ps1')
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$drillRoot = Join-Path $root "tmp/drill-$stamp"
$serverDir = Join-Path $drillRoot 'server'
$rconPass = 'drill-' + [guid]::NewGuid().ToString('n').Substring(0, 12)

$script:results = New-Object System.Collections.Generic.List[object]
# R6 #10：断言条数用于 verdict 判定（原来写死 12；新增 13/14 后必须同步，否则永远 FAIL）
$script:expectedAssertions = 14
$script:ignored = New-Object System.Collections.Generic.List[object]
$script:javaProc = $null
$script:javaKilled = $false

function Write-Step([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Info([string]$m) { Write-Host "    $m" -ForegroundColor DarkGray }

function Add-Result([int]$id, [string]$name, [bool]$ok, [string]$detail = '') {
    # 断言结果统一收集：控制台 + 报告都用它，失败时能一眼看出是第几条
    $status = 'PASS'
    if (-not $ok) { $status = 'FAIL' }
    $script:results.Add([pscustomobject]@{ id = $id; name = $name; status = $status; detail = $detail })
    if ($ok) { Write-Host ("PASS #{0,-2} {1} {2}" -f $id, $name, $detail) -ForegroundColor Green }
    else { Write-Host ("FAIL #{0,-2} {1} {2}" -f $id, $name, $detail) -ForegroundColor Red }
}

function Test-PortFree([int]$p) {
    try {
        $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
        $l.Start(); $l.Stop()
        return $true
    } catch { return $false }
}

# ── SQLite 只读查询（node:sqlite 优先，python 兜底）──────────────────
function Invoke-SqliteQuery([string]$DbPath, [string[]]$Tables) {
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('drill-sql-' + [guid]::NewGuid().ToString('n').Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    try {
        $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
        if ($nodeCmd) {
            $js = Join-Path $tmp 'q.js'
            $code = @'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const ic = db.prepare('PRAGMA integrity_check').all().map(r => Object.values(r)[0]).join(';');
const uv = db.prepare('PRAGMA user_version').get().user_version;
const tables = {};
for (const t of (process.argv[3] || '').split(',').filter(Boolean)) {
  try { tables[t] = db.prepare('select count(*) as c from "' + t + '"').get().c; } catch (e) { tables[t] = null; }
}
console.log(JSON.stringify({ integrity: ic, userVersion: uv, tables }));
db.close();
'@
            Set-Content -LiteralPath $js -Value $code -Encoding UTF8
            $out = & $nodeCmd.Path $js $DbPath (($Tables) -join ',') 2>$null
            if ($LASTEXITCODE -eq 0 -and $out) { return ($out | Out-String | ConvertFrom-Json) }
        }
        $pyCmd = Get-Command python -ErrorAction SilentlyContinue
        if ($pyCmd) {
            $py = Join-Path $tmp 'q.py'
            $code = @'
import json, sqlite3, sys
c = sqlite3.connect('file:' + sys.argv[1].replace('\\', '/') + '?mode=ro', uri=True)
out = {'integrity': ';'.join(r[0] for r in c.execute('pragma integrity_check')),
       'userVersion': c.execute('pragma user_version').fetchone()[0], 'tables': {}}
for t in [x for x in sys.argv[2].split(',') if x]:
    try:
        out['tables'][t] = c.execute('select count(*) from "' + t + '"').fetchone()[0]
    except Exception:
        out['tables'][t] = None
print(json.dumps(out))
c.close()
'@
            Set-Content -LiteralPath $py -Value $code -Encoding UTF8
            $out = & $pyCmd.Path $py $DbPath (($Tables) -join ',') 2>$null
            if ($LASTEXITCODE -eq 0 -and $out) { return ($out | Out-String | ConvertFrom-Json) }
        }
        return $null
    } finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

# ── RCON：见 scripts/lib/rcon.ps1（dot-source 在上面）──────────────
function Get-JavaExe {
    if ($JavaPath -and (Test-Path -LiteralPath $JavaPath)) { return (Resolve-Path -LiteralPath $JavaPath).Path }
    $tools = Join-Path $root '.tools'
    if (Test-Path -LiteralPath $tools) {
        $cand = Get-ChildItem $tools -Directory -Filter 'jdk-*' -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending | Select-Object -First 1
        if ($cand) {
            $exe = Join-Path $cand.FullName 'bin/java.exe'
            if (Test-Path -LiteralPath $exe) { return $exe }
        }
    }
    $cmd = Get-Command java -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Path }
    return $null
}

function Stop-DrillJava {
    if ($script:javaProc -and -not $script:javaProc.HasExited) {
        try {
            $null = Invoke-RconCommandWithRetry -Password $rconPass -Port $RconPort -Command 'stop' -Attempts 2 -DelayMs 500
            if (-not $script:javaProc.WaitForExit(30000)) {
                Write-Host '    收尾：java 未在 30s 内退出，强制结束' -ForegroundColor Yellow
                $script:javaProc.Kill()
                $script:javaKilled = $true
            }
        } catch {
            try { $script:javaProc.Kill(); $script:javaKilled = $true } catch { }
        }
    }
}

function Write-Report {
    # ★ R6 #47（2026-11-10）：**先把 Java 侧证据收进 logs/，再写报告**。
    #
    #   原状：`$bootOut/$bootErr` 建在 $serverDir（= drill-*/server/boot.out），
    #   而收尾只把 `server/logs/*` 拷到 `drill/logs/`、随后删掉整个骨架。
    #   于是**最需要证据的"起服失败"场景**里，Java 的堆栈正好被删掉；
    #   而 report.json 的 evidence.javaOut 写的是 'logs/boot.out' —— 这个路径从来不存在。
    #   用户拿到的是"断言 10 FAIL + 超时"，没有任何 Java 侧报错。
    #
    #   现在：写报告前无条件把 boot.out/boot.err 复制进 drill/logs/（存在才拷）。
    #   报告里的路径因此是真的；-KeepArtefacts 与否都不影响。
    $logDir = Join-Path $drillRoot 'logs'
    if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
    foreach ($n in @('boot.out', 'boot.err')) {
        $srcBoot = Join-Path $serverDir $n
        $dstBoot = Join-Path $logDir $n
        if ((Test-Path -LiteralPath $srcBoot) -and -not (Test-Path -LiteralPath $dstBoot)) {
            try { Copy-Item -LiteralPath $srcBoot -Destination $dstBoot -Force -ErrorAction Stop } catch { }
        }
    }
    # ★ 同一类问题的第二处（本次实测发现）：latest.log 此时也还在 server/logs/，
    #   而报告用 Test-Path drill/logs/latest.log 判断 ⇒ 明明起服成功，evidence.serverLog
    #   仍写「（未起服）」。证据字段撒谎比缺字段更糟，所以一并在写报告前收进来。
    $srvLogs = Join-Path $serverDir 'logs'
    if (Test-Path -LiteralPath $srvLogs) {
        try { Copy-Item (Join-Path $srvLogs '*') -Destination $logDir -Recurse -Force -ErrorAction SilentlyContinue } catch { }
    }

    $passed = @($script:results | Where-Object { $_.status -eq 'PASS' }).Count
    $failed = @($script:results | Where-Object { $_.status -eq 'FAIL' }).Count
    $report = [ordered]@{
        createdAt   = (Get-Date).ToString('o')
        backupDir   = $script:resolvedBackup
        drillDir    = $drillRoot
        ports       = [ordered]@{ server = $Port; rcon = $RconPort }
        summary     = [ordered]@{ pass = $passed; fail = $failed; total = $script:results.Count }
        verdict     = $(if ($failed -eq 0 -and $script:results.Count -eq $script:expectedAssertions) { 'PASS' } else { 'FAIL' })
        assertions  = $script:results.ToArray()
        ignoredNetworkErrors = $script:ignored.ToArray()
        evidence    = [ordered]@{
            serverLog = $(if (Test-Path (Join-Path $drillRoot 'logs/latest.log')) { 'logs/latest.log' } else { '（未起服）' })
            javaOut   = $(if (Test-Path (Join-Path $drillRoot 'logs/boot.out')) { 'logs/boot.out' } else { '（未起服）' })
        }
    }
    $jsonPath = Join-Path $drillRoot 'report.json'
    [System.IO.File]::WriteAllText($jsonPath, ($report | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("# 恢复演练报告 $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))")
    $lines.Add('')
    $lines.Add("- 备份：``$($script:resolvedBackup)``")
    $lines.Add("- 演练目录：``$drillRoot``")
    $lines.Add("- 端口：server=$Port rcon=$RconPort")
    $lines.Add("- 结论：**$($report.verdict)**（PASS $passed / FAIL $failed，共 $($script:results.Count) 条）")
    $lines.Add('')
    $lines.Add('| # | 断言 | 结果 | 证据 |')
    $lines.Add('|---|---|---|---|')
    foreach ($r in $script:results) {
        $d = ($r.detail -replace '\|', '/')
        $lines.Add("| $($r.id) | $($r.name) | $($r.status) | $d |")
    }
    if ($script:ignored.Count -gt 0) {
        $lines.Add('')
        $lines.Add('## 被豁免的离线网络噪音')
        foreach ($i in $script:ignored) { $lines.Add("- " + ($i -replace '`', "'")) }
    }
    $mdPath = Join-Path $drillRoot 'report.md'
    [System.IO.File]::WriteAllText($mdPath, (($lines -join "`r`n") + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
    return @{ json = $jsonPath; md = $mdPath; pass = $passed; fail = $failed }
}

# ════════════════════════════════════════════════════════════════════
# 前置：找备份 / 找 java / 端口 / 空间
# ════════════════════════════════════════════════════════════════════
$resolved = $null
if ($BackupDir) {
    $cand = $BackupDir
    if (-not [System.IO.Path]::IsPathRooted($cand)) { $cand = Join-Path $root $cand }
    if (Test-Path -LiteralPath $cand) { $resolved = (Resolve-Path -LiteralPath $cand).Path }
} else {
    $bk = Join-Path $root 'backups'
    $cand = @(Get-ChildItem $bk -Directory -Filter 'world-*' -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -notlike '*.partial' -and (Test-Path (Join-Path $_.FullName 'manifest.json')) } |
            Sort-Object LastWriteTime -Descending)
    if ($cand.Count -gt 0) { $resolved = $cand[0].FullName }
}
$script:resolvedBackup = $resolved

if (-not $resolved) {
    Write-Host 'FAIL 前置：找不到可演练的备份目录（需要含 manifest.json 的 world-*）' -ForegroundColor Red
    exit 1
}

$javaExe = Get-JavaExe
$problems = @()
if (-not $javaExe) { $problems += '找不到 java（.tools/jdk-*/bin/java.exe 或 PATH）' }
if (-not (Test-PortFree $Port)) { $problems += "端口 $Port 已被占用" }
if (-not (Test-PortFree $RconPort)) { $problems += "端口 $RconPort 已被占用" }
$d = Get-PSDrive -Name ([System.IO.Path]::GetPathRoot($root).TrimEnd(':')) -ErrorAction SilentlyContinue
if ($d -and $d.Free -lt 2GB) { $problems += "磁盘剩余不足 2GB（当前 $([math]::Round($d.Free/1GB,1))GB）" }

if ($problems.Count -gt 0) {
    Write-Host 'FAIL 前置条件不满足：' -ForegroundColor Red
    foreach ($p in $problems) { Write-Host "     · $p" -ForegroundColor Yellow }
    exit 1
}

Write-Step "演练备份：$resolved"
Write-Info "演练目录：$drillRoot"
Write-Info "java：$javaExe"

$exitCode = 1
try {
    New-Item -ItemType Directory -Force -Path $drillRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $serverDir | Out-Null

    # ── 断言 1：manifest ────────────────────────────────────────────
    $mf = Join-Path $resolved 'manifest.json'
    $manifest = $null
    if (Test-Path -LiteralPath $mf) {
        try { $manifest = Get-Content -LiteralPath $mf -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $manifest = $null }
    }
    $schema = 0
    if ($manifest -and $null -ne $manifest.schemaVersion) { $schema = [int]$manifest.schemaVersion }
    $ok1 = ($null -ne $manifest) -and ($schema -ge 3) -and (@($manifest.entries).Count -gt 0)
    Add-Result 1 'manifest 可读且 schemaVersion>=3' $ok1 "schemaVersion=$schema entries=$(@($manifest.entries).Count)"
    if (-not $ok1) { throw '断言 1 失败：manifest 不可用，后续断言无意义' }

    $entries = @($manifest.entries)

    # ── 断言 2：每个压缩包字节/SHA256 ───────────────────────────────
    $bad = New-Object System.Collections.Generic.List[string]
    foreach ($e in $entries) {
        $p = Join-Path $resolved $e.name
        if (-not (Test-Path -LiteralPath $p)) { $bad.Add("$($e.name) 不存在"); continue }
        $len = (Get-Item -LiteralPath $p).Length
        if ($null -ne $e.bytes -and [int64]$e.bytes -ne $len) { $bad.Add("$($e.name) 字节不符 manifest=$($e.bytes) 实际=$len"); continue }
        $h = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash
        if ($h -ne $e.sha256) { $bad.Add("$($e.name) SHA256 不符") }
    }
    Add-Result 2 '每个压缩包字节与 SHA256 与 manifest 相等' ($bad.Count -eq 0) $(if ($bad.Count -eq 0) { "$($entries.Count) 个包全部核对通过" } else { ($bad -join '; ') })
    if ($bad.Count -gt 0) { throw '断言 2 失败：备份包已损坏，停止演练（不浪费时间起服）' }

    # ── 骨架（只读复制 server/ 的运行时，绝不写 server/）────────────
    Write-Step '搭隔离服骨架（只读复制 server.jar/libraries/versions/cache）'
    $jar = Join-Path $root 'server/paper-1.21.8-60.jar'
    if (-not (Test-Path -LiteralPath $jar)) {
        $jar = Get-ChildItem (Join-Path $root 'server') -Filter 'paper-*.jar' | Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $jar) { throw '找不到 paper-*.jar（server/ 下）' }
    Copy-Item -LiteralPath $jar -Destination (Join-Path $serverDir 'server.jar') -Force
    foreach ($sub in @('libraries', 'versions', 'cache')) {
        $src = Join-Path $root "server/$sub"
        if (Test-Path -LiteralPath $src) {
            Copy-Item -LiteralPath $src -Destination (Join-Path $serverDir $sub) -Recurse -Force
        }
    }
    Set-Content -LiteralPath (Join-Path $serverDir 'eula.txt') -Value 'eula=true' -Encoding ASCII

    $props = @(
        "server-port=$Port",
        'server-ip=127.0.0.1',
        'enable-rcon=true',
        "rcon.port=$RconPort",
        "rcon.password=$rconPass",
        'broadcast-rcon-to-ops=false',
        'online-mode=false',
        'enforce-secure-profile=false',
        'level-name=world',
        'max-players=1',
        'view-distance=4',
        'simulation-distance=4',
        'sync-chunk-writes=true',
        'enable-query=false',
        'spawn-protection=0',
        'motd=restore-drill'
    )
    Set-Content -LiteralPath (Join-Path $serverDir 'server.properties') -Value $props -Encoding ASCII

    # ── 还原：世界 → server/，bots → drill/ ─────────────────────────
    Write-Step '解压备份（世界 → server/，bots → drill/）'
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
    $worldNames = @()
    foreach ($e in $entries) {
        if ($e.kind -eq 'world') { $worldNames += $e.name }
    }
    foreach ($e in $entries) {
        $zipPath = Join-Path $resolved $e.name
        switch ($e.kind) {
            'world' { [System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $serverDir) }
            'bots' { [System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $drillRoot) }
            # ★ R6 #10（2026-11-10）：原来这两类**根本不解压**（走 default 丢弃），
            #   于是"12 条断言全过"只证明了世界和 bots 能还原，
            #   证明不了"原服务器能恢复"——插件配置、服务端配置从未被验证过。
            #   server-config 解到 drillRoot：包内路径是 server/... 与 config/...，
            #   解到根下正好落到 drill/server 与 drill/config（与仓库布局一致）。
            'config' { [System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $drillRoot) }
            'plugins' { [System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $serverDir) }
            default { }
        }
    }

    # ── 用备份里的 server.properties 作基底，只覆盖"隔离必需"的键 ──
    #   为什么要有这一步：上面 348 行合成的是一份**最小可启动**配置，不是"原服务器的配置"。
    #   备份还原后真正的 server.properties 会覆盖它 —— 但端口/RCON/在线模式必须改回演练口，
    #   否则要么撞生产端口，要么连不回本机。其余键（white-list / view-distance / 各类策略）
    #   一律保留原值，这样断言才能证明"配置真的还原了"。
    $propsPath = Join-Path $serverDir 'server.properties'
    $drillOverride = [ordered]@{
        'server-port'            = "$Port"
        'server-ip'              = '127.0.0.1'
        'enable-rcon'            = 'true'
        'rcon.port'              = "$RconPort"
        'rcon.password'          = $rconPass
        'broadcast-rcon-to-ops'  = 'false'
        'online-mode'            = 'false'
        'enforce-secure-profile' = 'false'
        'level-name'             = 'world'
        'max-players'            = '1'
        'enable-query'           = 'false'
        'motd'                   = 'restore-drill'
    }
    $propsFromBackup = $false
    if (Test-Path -LiteralPath $propsPath) {
        $outProps = New-Object System.Collections.Generic.List[string]
        $applied = @{}
        foreach ($line in @(Get-Content -LiteralPath $propsPath -ErrorAction Stop)) {
            if ($line -match '^\s*([A-Za-z0-9._-]+)\s*=') {
                $k = $Matches[1]
                if ($drillOverride.Contains($k)) { $outProps.Add("$k=$($drillOverride[$k])"); $applied[$k] = $true; continue }
            }
            $outProps.Add($line)
        }
        foreach ($k in $drillOverride.Keys) { if (-not $applied.ContainsKey($k)) { $outProps.Add("$k=$($drillOverride[$k])") } }
        Set-Content -LiteralPath $propsPath -Value $outProps -Encoding ASCII
        $propsFromBackup = $true
        Write-Info "server.properties：以备份内容为基底，覆盖 $($drillOverride.Count) 个隔离必需键"
    }

    # ── 断言 3/4/5/6：世界内容 ─────────────────────────────────────
    $regionBad = New-Object System.Collections.Generic.List[string]
    $pdBad = New-Object System.Collections.Generic.List[string]
    $mcaBad = New-Object System.Collections.Generic.List[string]
    $nbtBad = New-Object System.Collections.Generic.List[string]

    foreach ($e in $entries) {
        if ($e.kind -ne 'world') { continue }
        $leaf = $e.name.Substring(0, $e.name.Length - 4)
        $wdir = Join-Path $serverDir $leaf
        $counts = $e.counts

        $regions = @()
        if (Test-Path -LiteralPath $wdir) {
            $regions = @(Get-ChildItem $wdir -Recurse -File -Filter '*.mca' -ErrorAction SilentlyContinue |
                    Where-Object { $_.DirectoryName -like '*\region' })
        }
        $wantRegions = 0
        if ($null -ne $counts.regions) { $wantRegions = [int64]$counts.regions }
        if ($regions.Count -ne $wantRegions) {
            $regionBad.Add("$leaf 期望 $wantRegions 个，实际 $($regions.Count) 个")
        }

        $pd = @()
        if (Test-Path -LiteralPath $wdir) {
            $pd = @(Get-ChildItem $wdir -Recurse -File -Filter '*.dat' -ErrorAction SilentlyContinue |
                    Where-Object { $_.DirectoryName -like '*\playerdata' })
        }
        $wantPd = 0
        if ($null -ne $counts.playerdata) { $wantPd = [int64]$counts.playerdata }
        if ($pd.Count -ne $wantPd) { $pdBad.Add("$leaf 期望 $wantPd 个，实际 $($pd.Count) 个") }

        foreach ($m in $regions) {
            if ($m.Length -lt 8192) { $mcaBad.Add("$($m.Name) 只有 $($m.Length)B（<8192）"); continue }
            $fs = [System.IO.File]::OpenRead($m.FullName)
            try {
                $buf = New-Object byte[] 4096
                $nn = $fs.Read($buf, 0, 4096)
            } finally { $fs.Dispose() }
            if ($nn -lt 4096) { $mcaBad.Add("$($m.Name) 扇区表不足 4096B"); continue }
            $nz = 0
            for ($i = 0; $i -lt 1024; $i++) {
                $o = $i * 4
                if ($buf[$o] -ne 0 -or $buf[$o + 1] -ne 0 -or $buf[$o + 2] -ne 0 -or $buf[$o + 3] -ne 0) { $nz++ }
            }
            if ($nz -eq 0) { $mcaBad.Add("$($m.Name) 扇区表全 0（没有 chunk）") }
        }

        $lvl = Join-Path $wdir 'level.dat'
        if (-not (Test-Path -LiteralPath $lvl)) {
            $nbtBad.Add("$leaf 缺 level.dat")
        } else {
            try {
                $in = [System.IO.File]::OpenRead($lvl)
                try {
                    $gz = New-Object System.IO.Compression.GZipStream($in, [System.IO.Compression.CompressionMode]::Decompress)
                    $first = $gz.ReadByte(); $gz.Dispose()
                } finally { $in.Dispose() }
                if ($first -ne 0x0a) { $nbtBad.Add("$leaf level.dat 解压后首字节=$first（应为 10）") }
            } catch { $nbtBad.Add("$leaf level.dat 不是合法 gzip：$($_.Exception.Message)") }
        }
    }
    Add-Result 3 'region/*.mca 数与 manifest 相等' ($regionBad.Count -eq 0) $(if ($regionBad.Count -eq 0) { "世界 $($worldNames.Count) 个维度全部相符" } else { ($regionBad -join '; ') })
    Add-Result 4 'playerdata/*.dat 数与 manifest 相等' ($pdBad.Count -eq 0) $(if ($pdBad.Count -eq 0) { '全部相符' } else { ($pdBad -join '; ') })
    Add-Result 5 '每个 .mca 头部可解析（扇区表+至少 1 chunk）' ($mcaBad.Count -eq 0) $(if ($mcaBad.Count -eq 0) { '全部可解析' } else { (($mcaBad | Select-Object -First 3) -join '; ') })
    Add-Result 6 '每个 level.dat 是合法 gzip/NBT' ($nbtBad.Count -eq 0) $(if ($nbtBad.Count -eq 0) { '首字节均为 0x0a（TAG_Compound）' } else { ($nbtBad -join '; ') })

    # ── 断言 7/8：任务板 ───────────────────────────────────────────
    $botsEntry = @($entries | Where-Object { $_.kind -eq 'bots' }) | Select-Object -First 1
    # P1（2026-11-13）：任务板库已按 ADR-0001 D6 阶段 3 迁到 `bots/_worlds/<id>/_board/board.sqlite`。
    # 这里**从备份 manifest 里读真实路径**（备份是真相），只回退旧路径给老备份。
    # 硬编码旧路径的后果：解压后找不到 → 断言 7/8 恒红（恢复演练形同虚设）。
    $boardRel = $null
    $boardMeta = $null
    if ($botsEntry -and $botsEntry.databases) {
        $cands = @($botsEntry.databases.PSObject.Properties | Where-Object { $_.Name -like '*/board.sqlite' })
        if ($cands.Count -eq 1) { $boardRel = $cands[0].Name; $boardMeta = $cands[0].Value }
        elseif ($cands.Count -gt 1) {
            Add-Result 7 '任务板 integrity_check=ok' $false ("manifest 里有 {0} 个 board.sqlite，无法判定" -f $cands.Count)
            Add-Result 8 '任务板 jobs/claims/shared 行数与 manifest 相等' $false '多份候选'
            return
        }
    }
    if (-not $boardRel) { $boardRel = 'bots/_board/board.sqlite' }   # 老备份回退
    $boardFile = Join-Path $drillRoot ($boardRel -replace '/', '\')

    if (-not (Test-Path -LiteralPath $boardFile)) {
        Add-Result 7 '任务板 integrity_check=ok' $false '解压后找不到 bots/_board/board.sqlite'
        Add-Result 8 '任务板 jobs/claims/shared 行数与 manifest 相等' $false '板库缺失'
    } else {
        $q = Invoke-SqliteQuery -DbPath $boardFile -Tables @('jobs', 'claims', 'shared')
        if (-not $q) {
            Add-Result 7 '任务板 integrity_check=ok' $false '无法打开（node:sqlite / python 都不可用）'
            Add-Result 8 '任务板 jobs/claims/shared 行数与 manifest 相等' $false '无法查询'
        } else {
            Add-Result 7 '任务板 integrity_check=ok' ($q.integrity -eq 'ok') "integrity=$($q.integrity) user_version=$($q.userVersion)"
            $rowBad = New-Object System.Collections.Generic.List[string]
            if ($boardMeta -and $boardMeta.tables) {
                foreach ($tp in $boardMeta.tables.PSObject.Properties) {
                    $t = $tp.Name
                    $want = $tp.Value
                    $got = $null
                    if ($q.tables) { $got = $q.tables.$t }
                    if ($null -eq $want) { continue }
                    if ($null -eq $got) { $rowBad.Add("$t 表不存在") }
                    elseif ([int64]$want -ne [int64]$got) { $rowBad.Add("$t 期望 $want 实际 $got") }
                }
            } else {
                $rowBad.Add('manifest 没记录行数基准')
            }
            $detail = @($boardMeta.tables.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ' '
            Add-Result 8 '任务板 jobs/claims/shared 行数与 manifest 相等' ($rowBad.Count -eq 0) $(if ($rowBad.Count -eq 0) { $detail } else { ($rowBad -join '; ') })
        }
    }

    # ── 断言 9：机器人记忆可解析 ───────────────────────────────────
    $memBad = New-Object System.Collections.Generic.List[string]
    $memCount = 0
    $botsDir = Join-Path $drillRoot 'bots'
    if (Test-Path -LiteralPath $botsDir) {
        foreach ($f in @(Get-ChildItem $botsDir -Recurse -File -Filter 'memory.json' -ErrorAction SilentlyContinue)) {
            $memCount++
            try { $null = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json }
            catch { $memBad.Add("$($f.FullName.Substring($botsDir.Length + 1)) 解析失败") }
        }
    }
    Add-Result 9 '每个 bot 的 memory.json 可 JSON 解析' ($memBad.Count -eq 0 -and $memCount -gt 0) $(if ($memBad.Count -eq 0) { "$memCount 个全部可解析" } else { (($memBad | Select-Object -First 3) -join '; ') })

    # ── 起服 ───────────────────────────────────────────────────────
    Write-Step "启动隔离服（端口 $Port / RCON $RconPort）"
    $emptyIn = Join-Path $drillRoot 'stdin.empty'
    Set-Content -LiteralPath $emptyIn -Value '' -Encoding ASCII
    $bootOut = Join-Path $serverDir 'boot.out'
    $bootErr = Join-Path $serverDir 'boot.err'
    $script:javaProc = Start-Process -FilePath $javaExe `
        -ArgumentList @('-Xms1G', '-Xmx2G', '-Dterminal.jline=false', '-Dterminal.ansi=false', '-jar', 'server.jar', 'nogui') `
        -WorkingDirectory $serverDir -RedirectStandardOutput $bootOut -RedirectStandardError $bootErr `
        -RedirectStandardInput $emptyIn -PassThru -WindowStyle Hidden
    Write-Info "java pid=$($script:javaProc.Id)"

    $latest = Join-Path $serverDir 'logs\latest.log'
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $done = $false
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
        Start-Sleep -Milliseconds 500
        if ($script:javaProc.HasExited) { break }
        if (Test-Path -LiteralPath $latest) {
            try { $t = Get-Content -LiteralPath $latest -Raw -ErrorAction Stop } catch { $t = '' }
            if ($t -match 'Done \(') { $done = $true; break }
        }
    }
    $bootSec = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    $sw.Stop()
    if ($done) { Start-Sleep -Seconds 2 }   # RCON 线程在 Done 之后才稳定接受连接

    # ── 断言 10：Done ( ────────────────────────────────────────────
    Add-Result 10 '启动日志出现 Done (' $done $(if ($done) { "${bootSec}s" } else { "超时 ${TimeoutSec}s（java 是否已退出=$($script:javaProc.HasExited)）" })

    # ── 断言 11：ERROR 数 ──────────────────────────────────────────
    $logText = ''
    if (Test-Path -LiteralPath $latest) { $logText = Get-Content -LiteralPath $latest -Raw }
    $errLines = @([regex]::Matches($logText, '(?m)^[^\r\n]*\[[^\]]*ERROR\][^\r\n]*') | ForEach-Object { $_.Value })
    $excLines = @([regex]::Matches($logText, '(?m)^[^\r\n]*Exception[^\r\n]*') | ForEach-Object { $_.Value })
    # 离线环境噪音白名单：Mojang 会话/公钥服务不可达（与本机存档可恢复性无关）
    $noisePattern = 'api\.minecraftservices\.com|yggdrasil|authlib|Failed to request .*public key|Remote host terminated the handshake|SSLHandshakeException|EOFException'
    $real = New-Object System.Collections.Generic.List[string]
    foreach ($l in ($errLines + $excLines)) {
        if (-not $StrictErrors -and $l -match $noisePattern) { $script:ignored.Add($l.Trim()); continue }
        $real.Add($l.Trim())
    }
    $ok11 = ($real.Count -eq 0)
    $detail11 = "ERROR=$($errLines.Count) Exception=$($excLines.Count)"
    if ($script:ignored.Count -gt 0) { $detail11 += "（豁免离线网络噪音 $($script:ignored.Count) 条，见报告）" }
    if (-not $ok11) { $detail11 += "；首条：" + $real[0] }
    Add-Result 11 '启动日志 ERROR 数为 0' $ok11 $detail11

    # ── 断言 12：RCON stop → All chunks are saved ──────────────────
    $rconOk = $false
    $savedOk = $false
    $rconDetail = ''
    if ($script:javaProc.HasExited) {
        $rconDetail = 'java 已退出，无法做 RCON stop'
    } else {
        $r = Invoke-RconCommandWithRetry -Password $rconPass -Port $RconPort -Command 'stop'
        $rconOk = [bool]$r.ok
        if (-not $r.ok) { $rconDetail = "RCON 失败：$($r.error)" }
        if (-not $script:javaProc.WaitForExit(90000)) {
            $rconDetail += ' java 90s 内未退出'
            try { $script:javaProc.Kill(); $script:javaKilled = $true } catch { }
        }
        $logText2 = ''
        if (Test-Path -LiteralPath $latest) { $logText2 = Get-Content -LiteralPath $latest -Raw }
        $savedOk = [bool]($logText2 -match 'All chunks are saved|All dimensions are saved')
        if (-not $savedOk) { $rconDetail += ' 日志里没有 All chunks are saved' }
    }
    Add-Result 12 'RCON stop 后日志出现 All chunks are saved' ($rconOk -and $savedOk) $rconDetail

    # ── 断言 13：服务端配置真的还原了（不是"合成一份能启动的"）──────────
    $cfgEntry = @($entries | Where-Object { $_.kind -eq 'config' })[0]
    $wantCfgFiles = 0
    if ($cfgEntry -and $null -ne $cfgEntry.counts.fileCount) { $wantCfgFiles = [int64]$cfgEntry.counts.fileCount }
    $cfgOk = (Test-Path -LiteralPath $propsPath)
    $cfgDetail = "properties=$cfgOk 来源=$(if ($propsFromBackup) { '备份' } else { '合成/缺失' })"
    if ($cfgOk) {
        $propsText = Get-Content -LiteralPath $propsPath -Raw
        # 这几个键演练的合成基线里没有：它们在，就说明用的确实是备份那份配置
        $markers = @('white-list', 'enforce-whitelist', 'difficulty', 'spawn-monsters')
        $foundMarkers = @($markers | Where-Object { $propsText -match "(?m)^\s*$_\s*=" })
        $cfgOk = $propsFromBackup -and ($foundMarkers.Count -ge 2)
        $cfgDetail += "；备份特征键=$($foundMarkers -join '/')"
        # 口令必须是演练自己注入的，不能是备份里那份（可能为空、也可能是生产口令）
        $pwOk = [bool]($propsText -match "(?m)^\s*rcon\.password\s*=\s*$([regex]::Escape($rconPass))\s*$")
        $cfgOk = $cfgOk -and $pwOk
        $cfgDetail += "；演练口令已注入=$pwOk"
        if ($wantCfgFiles -gt 0) {
            $cfgDetail += "；清单登记 $wantCfgFiles 个配置文件"
        }
    }
    Add-Result 13 'server.properties 与配置文件来自备份（非合成）' $cfgOk $cfgDetail

    # ── 断言 14：插件配置与数据库真的还原了 ──────────────────────────
    $plugEntry = @($entries | Where-Object { $_.kind -eq 'plugins' })[0]
    $wantPlugFiles = 0
    if ($plugEntry -and $null -ne $plugEntry.counts.fileCount) { $wantPlugFiles = [int64]$plugEntry.counts.fileCount }
    $plugDir = Join-Path $serverDir 'plugins'
    $havePlugFiles = 0
    if (Test-Path -LiteralPath $plugDir) {
        $havePlugFiles = @(Get-ChildItem -LiteralPath $plugDir -Recurse -File -Force -ErrorAction SilentlyContinue).Count
    }
    # 允许少量差异（.paper-remapped 等运行期缓存），但主体必须在
    $plugOk = ($wantPlugFiles -gt 0 -and $havePlugFiles -ge [math]::Floor($wantPlugFiles * 0.9))
    $coreProtect = Test-Path -LiteralPath (Join-Path $plugDir 'CoreProtect/database.db')
    Add-Result 14 '插件目录与配置从备份还原（≥90% 条目）' $plugOk ("期望 $wantPlugFiles 个，实际 $havePlugFiles 个；CoreProtect 库=$coreProtect")

    $rep = Write-Report
    $exitCode = 0
    if ($rep.fail -gt 0) { $exitCode = 1 }
} catch {
    Write-Host "演练中断：$($_.Exception.Message)" -ForegroundColor Red
    # 不是一条断言，而是"演练被中断"的显式记录：报告里必须能看出为什么没跑完
    Add-Result 99 '演练完整跑完（未被中断）' $false ("中断于：" + $_.Exception.Message)
    try { $rep = Write-Report } catch { }
    $exitCode = 1
} finally {
    Stop-DrillJava
}

# ── 收尾：清理大件，只留报告与证据日志 ────────────────────────────
if (-not $KeepArtefacts) {
    # 先把证据日志搬到演练根下，再删掉整个骨架（含还原出来的世界、bots、plugins）
    $logSrc = Join-Path $serverDir 'logs'
    $logDst = Join-Path $drillRoot 'logs'
    if (Test-Path -LiteralPath $logSrc) {
        New-Item -ItemType Directory -Force -Path $logDst | Out-Null
        Copy-Item (Join-Path $logSrc '*') -Destination $logDst -Recurse -Force -ErrorAction SilentlyContinue
    }
    $keepNames = @('report.json', 'report.md', 'logs')
    foreach ($item in @(Get-ChildItem $drillRoot -Force -ErrorAction SilentlyContinue)) {
        if ($keepNames -contains $item.Name) { continue }
        Remove-Item $item.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$passed = @($script:results | Where-Object { $_.status -eq 'PASS' }).Count
$failed = @($script:results | Where-Object { $_.status -eq 'FAIL' }).Count
Write-Host ''
Write-Host '────────────────────────────────────────────'
if ($failed -eq 0) {
    Write-Host "恢复演练 PASS：$passed/$($script:results.Count) 条断言通过" -ForegroundColor Green
} else {
    Write-Host "恢复演练 FAIL：$passed 通过 / $failed 失败" -ForegroundColor Red
    foreach ($r in @($script:results | Where-Object { $_.status -eq 'FAIL' })) {
        Write-Host "   ✗ #$($r.id) $($r.name) — $($r.detail)" -ForegroundColor Red
    }
}
if (Test-Path (Join-Path $drillRoot 'report.json')) {
    Write-Host "证据：$(Join-Path $drillRoot 'report.json')"
    Write-Host "      $(Join-Path $drillRoot 'report.md')"
}
if (-not $KeepArtefacts) { Write-Host '（骨架已清理；要保留现场请加 -KeepArtefacts）' -ForegroundColor DarkGray }
exit $exitCode
