# Restart the real-machine environment (Paper + panel) for the 3rd round.
#
# Why this file exists:
#   The environment was wiped twice while idle (2026-11-06 20:14 and ~20:20):
#   java / node / msedge all gone, no reboot, no shutdown event, no crash-report.
#   Lesson: never block the tool call that starts a service. Start-Process and
#   RETURN IMMEDIATELY, poll readiness in a separate call.
#
# ASCII-only on purpose: Windows PowerShell 5.1 decodes a BOM-less UTF-8 .ps1 as
# ANSI/GBK, so every path is derived from $PSScriptRoot instead of being literal.
$ErrorActionPreference = 'Stop'

$T2   = $PSScriptRoot
$ROOT = (Get-Item $T2).Parent.Parent.Parent.FullName      # -> E:\<workspace>
$java = Join-Path $ROOT '.tools\jdk-21.0.12.1+1\bin\java.exe'
$jar  = Join-Path $ROOT 'server\paper-1.21.8-60.jar'
$srvDir = Join-Path $ROOT 'server'
$node = 'D:\Node\node.exe'
# NOTE: never build this path from a CJK literal. PowerShell 5.1 decodes a
# BOM-less UTF-8 .ps1 as ANSI/GBK, turning "真机-20261106" into mojibake and
# yielding MODULE_NOT_FOUND (measured 2026-11-06 21:16). Discover the dir instead.
$T0 = Get-ChildItem -Path (Join-Path $T2 '..') -Directory -Filter 'T0' -ErrorAction SilentlyContinue |
      Select-Object -First 1
if (-not $T0) { Write-Output 'MISSING T0 dir next to T2'; exit 1 }
$mjs  = Join-Path $T0.FullName 'start-mindserver.mjs'
$stdin = Join-Path $T2 '.stdin-empty'
if (-not (Test-Path $stdin)) { New-Item -ItemType File -Path $stdin -Force | Out-Null }

foreach ($f in @($java, $jar, $node)) {
    if (-not (Test-Path $f)) { Write-Output "MISSING $f"; exit 1 }
}

$srvOut = Join-Path $T2 'run-server-r3.log'
$srvErr = Join-Path $T2 'run-server-r3.err.log'
$panOut = Join-Path $T2 'run-panel-r3.log'
$panErr = Join-Path $T2 'run-panel-r3.err.log'
foreach ($f in @($srvOut, $srvErr, $panOut, $panErr)) {
    Remove-Item $f -Force -ErrorAction SilentlyContinue
}

$srv = Start-Process -FilePath $java `
    -ArgumentList '-Xms1G', '-Xmx2G', '-jar', 'paper-1.21.8-60.jar', 'nogui' `
    -WorkingDirectory $srvDir `
    -RedirectStandardOutput $srvOut -RedirectStandardError $srvErr `
    -RedirectStandardInput $stdin -WindowStyle Hidden -PassThru

$pan = Start-Process -FilePath $node `
    -ArgumentList $mjs `
    -WorkingDirectory (Join-Path $ROOT 'mindcraft') `
    -RedirectStandardOutput $panOut -RedirectStandardError $panErr `
    -RedirectStandardInput $stdin -WindowStyle Hidden -PassThru

Write-Output ("server PID={0}  panel PID={1}  started={2}" -f $srv.Id, $pan.Id, (Get-Date).ToString('o'))
Write-Output ("logs: {0} | {1} | {2} | {3}" -f $srvOut, $srvErr, $panOut, $panErr)
Write-Output "Returned immediately on purpose; poll readiness in a separate call."
