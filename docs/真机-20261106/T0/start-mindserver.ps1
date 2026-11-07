# T0: start the mindserver/panel (port 8080) with logs redirected into T0.
#
# ASCII-only on purpose: Windows PowerShell 5.1 decodes a BOM-less UTF-8 .ps1 as
# ANSI/GBK, so a CJK path literal would be corrupted. Every path is derived from
# $PSScriptRoot instead.
#
# Why a wrapper (start-mindserver.mjs) instead of "node src/mindcraft/mindserver.js":
#   mindserver.js only EXPORTS createMindServer(); running it directly prints
#   nothing and exits 0 (measured 2026-11-06 19:50). The real entry is
#   mindcraft/main.js -> Mindcraft.init() -> createMindServer(), but main.js also
#   spawns agent child processes from settings.profiles (my-local.json -> paid
#   remote endpoint). T0 only needs the panel on 8080, so the wrapper calls
#   createMindServer(false, 8080) directly.
#
# Working directory is intentionally the mindcraft/ dir, so the panel finds
# settings/profile paths and writes the board + token to their normal places
# (mindcraft\bots\_board\board.sqlite, mindcraft\.mindserver-token).
#
# Run: powershell.exe -NoProfile -ExecutionPolicy Bypass -File "...\T0\start-mindserver.ps1"
$ErrorActionPreference = 'Stop'

$T0    = $PSScriptRoot
$ROOT  = (Get-Item $T0).Parent.Parent.Parent.FullName
$node  = 'D:\Node\node.exe'
$log   = Join-Path $T0 'run-mindserver.log'
$err   = Join-Path $T0 'run-mindserver.err.log'
$stdin = Join-Path $T0 '.stdin-empty'
if (-not (Test-Path $stdin)) { New-Item -ItemType File -Path $stdin -Force | Out-Null }
foreach ($f in @($log, $err)) { Remove-Item $f -Force -ErrorAction SilentlyContinue }

$p = Start-Process -FilePath $node `
    -ArgumentList (Join-Path $T0 'start-mindserver.mjs') `
    -WorkingDirectory (Join-Path $ROOT 'mindcraft') `
    -RedirectStandardOutput $log -RedirectStandardError $err -RedirectStandardInput $stdin `
    -WindowStyle Hidden -PassThru

Write-Output ("mindserver node PID={0} started={1}" -f $p.Id, (Get-Date).ToString('o'))
Write-Output ("logs: {0} / {1}" -f $log, $err)
Write-Output ("note: token value lives in {0} - do NOT paste it into reports" -f (Join-Path $ROOT 'mindcraft\.mindserver-token'))
