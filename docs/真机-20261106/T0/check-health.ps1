# T0 health check.
# ASCII-only by design AND all paths derived from $PSScriptRoot:
# Windows PowerShell 5.1 decodes a BOM-less UTF-8 .ps1 as ANSI/GBK, so any CJK
# path literal inside this file would be corrupted ("鎴戠殑涓栫晫ai"). $PSScriptRoot
# comes from argv and is always correct, so nothing Chinese is hardcoded here.
#
# Run (execution policy blocks unsigned .ps1 otherwise):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File "...\T0\check-health.ps1"
# Prints: port/PID per service, Paper Done line, /list, /tps, /mspt, bot artifacts.
# No secrets are printed (panel token is redacted).
$ErrorActionPreference = 'Continue'

$T0     = $PSScriptRoot
$ROOT   = (Get-Item $T0).Parent.Parent.Parent.FullName   # ...\T0 -> docs -> project root
$node   = 'D:\Node\node.exe'
$rconJs = Join-Path $T0 'rcon.mjs'
$srvLog = Join-Path $T0 'run-server.log'
$tokFile = Join-Path $ROOT 'mindcraft\.mindserver-token'

function Rcon([string]$cmd) { ((& $node $rconJs $cmd) 2>&1) -join "`n" }

Write-Output "===== paths ====="
Write-Output ("  T0   = " + $T0)
Write-Output ("  ROOT = " + $ROOT)

Write-Output "===== ports ====="
$ok = $true
foreach ($p in 25565, 25575, 8080) {
    $c = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) {
        $pr = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
        Write-Output ("  {0} LISTENING addr={1} pid={2} proc={3} start={4}" -f $p, $c.LocalAddress, $c.OwningProcess, $pr.ProcessName, $pr.StartTime)
    } else {
        Write-Output ("  {0} NOT LISTENING" -f $p); $ok = $false
    }
}

Write-Output "===== paper ====="
if (Test-Path $srvLog) {
    $done = Select-String -Path $srvLog -Pattern 'Done \(' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($done) { Write-Output ("  " + $done.Line.Trim()) } else { Write-Output "  NO 'Done (' IN run-server.log"; $ok = $false }
} else { Write-Output ("  missing " + $srvLog); $ok = $false }

Write-Output "===== panel http ====="
if (Test-Path $tokFile) {
    $tok = (Get-Content $tokFile -Raw).Trim()
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:8080/console?token=$tok" -UseBasicParsing -TimeoutSec 8
        Write-Output ("  /console?token=<redacted> -> " + $r.StatusCode)
    } catch { Write-Output ("  /console -> ERR " + $_.Exception.Message); $ok = $false }
    try {
        Invoke-WebRequest -Uri "http://localhost:8080/console" -UseBasicParsing -TimeoutSec 8 | Out-Null
        Write-Output "  /console (no token) -> 200 (UNEXPECTED: auth gate should 401)"
    } catch { Write-Output ("  /console (no token) -> " + $_.Exception.Response.StatusCode.value__ + " (expected 401)") }
} else { Write-Output ("  token file missing: " + $tokFile); $ok = $false }

Write-Output "===== minecraft state ====="
Write-Output ("  list : " + (Rcon 'list'))
Write-Output ("  tps  : " + (Rcon 'tps'))
Write-Output ("  mspt : " + ((Rcon 'mspt') -replace "`r?`n", ' | '))

Write-Output "===== bot artifacts ====="
foreach ($f in 'bot-join.json', 'bot-last.json') {
    $p = Join-Path $T0 $f
    if (Test-Path $p) {
        Write-Output ("  {0} mtime={1}" -f $f, (Get-Item $p).LastWriteTime)
        Write-Output ("    " + ((Get-Content $p -Raw) -replace "`r?`n", ' '))
    } else { Write-Output ("  $f MISSING") }
}

Write-Output ("===== RESULT: " + $(if ($ok) { 'HEALTHY' } else { 'DEGRADED' }) + " =====")
