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
# ★ OPS-002（2026-11-06 深度检查）：关服失败现在是**独立退出码 4**。
#   过去这种情况也走到"完成"，用户以为停了，其实 Minecraft 还在后台跑 —— 接着强关窗口就丢存档。
if ($stopCode -eq 4) {
    Write-Host ''
    Write-Host '[未完成] 关服没有成功（RCON 没配好 / 认证失败 / 服务器没退出）。' -ForegroundColor Red
    Write-Host '        管理端**仍在运行**，Minecraft 可能也还在运行 —— 别强关窗口（会丢未刷盘的存档）。' -ForegroundColor Red
    Write-Host '        修好 server.properties 的 enable-rcon / rcon.password 后，重跑本脚本。' -ForegroundColor Yellow
}
if ($stopCode -ne 0 -and $stopCode -ne 2 -and $stopCode -ne 3 -and $stopCode -ne 4) {
    Write-Host ''
    Write-Host "[未完成] stop-all.mjs 以退出码 $stopCode 结束，详见上面的输出。" -ForegroundColor Yellow
}

Write-Host ''
Write-Host '说明：' -ForegroundColor DarkGray
Write-Host '  · Minecraft 走 RCON stop，会自己刷盘关闭（不是强杀）'
Write-Host '  · 若 "MC Server" / "Mindcraft" 窗口还在，直接关掉即可'
Write-Host ''

# ════════════════════════════════════════════════════════════════════
# 停服后自动备份（用户拍板⑥：默认开启，可在 config/backup.json 关掉）
#
# 只有在**确认 java 已经退出**之后才备份 —— 冷备要求服务端已停
# （运行期 session.lock 与 region/*.mca 被独占，热备物理上不可能，t7 已实测）。
# 备份失败**绝不能**影响停服流程：这里全部 try/catch 兜住，停服优先。
# ════════════════════════════════════════════════════════════════════
if ($stopCode -eq 0) {
    Write-Host '自动备份：' -ForegroundColor Cyan
    try {
        $waitSec = 60
        $deadline = (Get-Date).AddSeconds($waitSec)
        $javaLeft = @(Get-Process -Name java, javaw -ErrorAction SilentlyContinue)
        while ($javaLeft.Count -gt 0 -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 500
            $javaLeft = @(Get-Process -Name java, javaw -ErrorAction SilentlyContinue)
        }
        if ($javaLeft.Count -gt 0) {
            Write-Host '  · 仍有 java 进程未退出（等 60s）→ 跳过自动备份（不冒险热备）' -ForegroundColor Yellow
            try {
                . (Join-Path $PSScriptRoot 'lib/backup_config.ps1')
                Write-BackupAutoLog -Root $root -Level 'SKIP' -Message ("停服后备份跳过：{0} 个 java 进程在 60s 内未退出" -f $javaLeft.Count)
            } catch { }
        } else {
            . (Join-Path $PSScriptRoot 'lib/backup_config.ps1')
            $null = Invoke-BackupOnServerStop -Root $root
        }
    } catch {
        Write-Host "  · 自动备份环节异常（已忽略，停服不受影响）：$($_.Exception.Message)" -ForegroundColor Yellow
    }
    Write-Host ''
} else {
    Write-Host '自动备份：跳过（本次没有成功停服，不做备份）' -ForegroundColor DarkGray
    Write-Host ''
}

Read-Host '按回车关闭' | Out-Null

# ★ t20 A：把停止结果码透传给**进程退出码**。以前本脚本以 Read-Host 结束，
#   PowerShell 进程恒返回 0（t12 实测：屏幕上写着“[ERROR] 拿不到握手 token”“[ERROR] 关服没有成功”，
#   但停止面板.bat / 计划任务 / 快捷方式看到的都是“成功”）。
#   stop-all.mjs 码义：0=已停或本来就没跑，2=拿不到 token，3=握手被拒，4=关服没成功。
if ($null -eq $stopCode) { exit 1 }   # stop-all 根本没跑成（异常路径）也不能当成功
exit $stopCode
