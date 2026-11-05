# Minecraft AI 陪玩面板 —— 停止 / 优雅关服
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot
$node = 'D:\Node\node.exe'
$script = Join-Path $root 'web\scripts\stop-all.mjs'

Write-Host '============================================================' -ForegroundColor DarkCyan
Write-Host '    停止面板 / 优雅关服' -ForegroundColor White
Write-Host '============================================================' -ForegroundColor DarkCyan
Write-Host ''

if (-not (Test-Path $node))   { Write-Host "[错误] 找不到 Node: $node" -ForegroundColor Red; Read-Host; exit 1 }
if (-not (Test-Path $script)) { Write-Host "[错误] 找不到 $script" -ForegroundColor Red; Read-Host; exit 1 }

& $node $script

Write-Host ''
Write-Host '说明：' -ForegroundColor DarkGray
Write-Host '  · Minecraft 走 RCON stop，会自己刷盘关闭（不是强杀）'
Write-Host '  · 若 "MC Server" / "Mindcraft" 窗口还在，直接关掉即可'
Write-Host ''
Read-Host '按回车关闭' | Out-Null
