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

# F-WEB-205：stop-all.mjs 要读 mindcraft/.mindserver-token，而该文件写在 mindserver 的 **cwd** 下
# ⇒ 必须切到 mindcraft 再跑。以前没有 pushd，脚本永远拿不到 token（只能靠人从日志里手抄）。
Push-Location (Join-Path $root 'mindcraft')
try {
    & $node $script
    $stopCode = $LASTEXITCODE
} finally {
    Pop-Location
}
if ($stopCode -eq 2) {
    Write-Host ''
    Write-Host '[未完成] 拿不到握手 token。服务器仍在运行，请不要直接关窗口（会丢未刷盘的存档）。' -ForegroundColor Yellow
    Write-Host '         token 位置：mindcraft\.mindserver-token' -ForegroundColor Yellow
}
if ($stopCode -eq 3) {
    Write-Host ''
    Write-Host '[未完成] 握手被拒（token 已过期）。服务器仍在运行，请重跑本脚本而不是强关。' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '说明：' -ForegroundColor DarkGray
Write-Host '  · Minecraft 走 RCON stop，会自己刷盘关闭（不是强杀）'
Write-Host '  · 若 "MC Server" / "Mindcraft" 窗口还在，直接关掉即可'
Write-Host ''
Read-Host '按回车关闭' | Out-Null
