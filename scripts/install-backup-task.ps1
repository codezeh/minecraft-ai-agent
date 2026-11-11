<#
.SYNOPSIS
    注册 / 卸载「每日自动备份」计划任务（用户拍板⑥的兜底路径）。

.DESCRIPTION
    为什么需要它：
      停服后自动备份（主路径）只在"用面板优雅关服"时触发。如果服务端一直开着，
      或者用户直接关窗口，就没有备份。这个计划任务是**兜底**：每天固定时间跑一次冷备。

    ⚠ 两条硬约束（设计时就避坑，不是事后补）：
      1) **不会为了备份去杀服务端**：冷备要求服务端已停（运行期 `session.lock` /
         `region/*.mca` 被独占，热备物理上不可能 —— t7 已实测）。任务发现服务端在跑，
         就**跳过并留痕**（`logs/backup-auto.log` 记"因服务端运行跳过（第 N 次连续跳过）"）。
      2) **本脚本必须由用户显式运行**：绝不自动、静默地改任务计划。

    开关：`config/backup.json`
      · `enabled:false`      ⇒ 任务照跑但**立刻跳过**并记 warn（不用卸载任务）；
      · `onServerStop:false` ⇒ 只是停服不备份，计划任务照常；
      · `dailyAt` / `keep` / `excludeSecrets` 都从这里读（任务命令就是 `backup-world.ps1 -FromConfig`）。

    ⚠ 权限：`Register-ScheduledTask` 在部分环境需要管理员。失败时本脚本**如实报错并退出 1**，
      不会假装成功。

.PARAMETER Uninstall
    删除已注册的任务。

.PARAMETER TaskName
    任务名，默认 `Minecraft-AutoBackup`。

.PARAMETER WhatIf
    只打印将要注册的任务定义，不真正注册。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install-backup-task.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install-backup-task.ps1 -Uninstall

.NOTES
    退出码：0 成功（含"已卸载"/"已存在且一致"）；1 失败（权限/注册错误，会打印原始错误）。
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [string]$TaskName = 'Minecraft-AutoBackup',
        [switch]$WhatIf,
    # R6 #54：Interactive = 重启后未登录就不跑；S4U = 用户不登录也跑（不要密码）。
    [ValidateSet('Interactive', 'S4U')][string]$LogonType = 'Interactive',
    # R6 #54：默认注册后立即跑一次并读 LastTaskResult（-SkipSmokeTest 可跳过）。
    [switch]$SkipSmokeTest
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib/backup_config.ps1')

# R6 #54：判定"计划任务真能跑"。判据 = LastTaskResult 已知且为 0/267009（运行中），
# 且 backup-auto.log 在本次触发后新增了行（说明脚本真的被执行过）。
function Invoke-TaskSmokeTest {
    param([string]$TaskName, [string]$Root, [int]$TimeoutSec = 90)
    $logPath = Join-Path $Root 'logs/backup-auto.log'
    $before = 0
    if (Test-Path -LiteralPath $logPath) { $before = @(Get-Content -LiteralPath $logPath).Count }
    try { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop }
    catch { return [pscustomobject]@{ Ok = $false; ExitCode = $null; Detail = ("Start-ScheduledTask 失败：" + $_.Exception.Message) } }
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $info = $null
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($info -and $info.LastTaskResult -ne 267009) { break }
    }
    $after = 0
    if (Test-Path -LiteralPath $logPath) { $after = @(Get-Content -LiteralPath $logPath).Count }
    $grew = ($after -gt $before)
    if (-not $info) { return [pscustomobject]@{ Ok = $false; ExitCode = $null; Detail = '读不到任务运行信息' } }
    $code = $info.LastTaskResult
    $ok = ($code -eq 0 -or $code -eq 267009) -and $grew
    $detail = if ($grew) { ("backup-auto.log 新增 {0} 行" -f ($after - $before)) } else { 'backup-auto.log 没有新增行（任务可能没真的执行 backup-world.ps1）' }
    return [pscustomobject]@{ Ok = $ok; ExitCode = $code; Detail = $detail }
}

function Write-Step([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Info([string]$m) { Write-Host "    $m" -ForegroundColor DarkGray }

$cfg = Get-BackupConfig -Root $root

# ── 卸载 ────────────────────────────────────────────────────────────
if ($Uninstall) {
    Write-Step "卸载计划任务：$TaskName"
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $existing) {
        Write-Host "    任务不存在（无需卸载）" -ForegroundColor DarkGray
        exit 0
    }
    try {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
        Write-Host "    已删除：$TaskName" -ForegroundColor Green
        Write-BackupAutoLog -Root $root -Level 'INFO' -Message "已卸载计划任务 $TaskName"
        exit 0
    } catch {
        Write-Host "FAIL 删除失败：$($_.Exception.Message)" -ForegroundColor Red
        Write-Host "     若提示权限不足，请用管理员 PowerShell 重跑本脚本 -Uninstall" -ForegroundColor Yellow
        exit 1
    }
}

# ── 安装 ────────────────────────────────────────────────────────────
Write-Step "注册每日自动备份：$TaskName"
Write-Info ("配置：enabled={0} onServerStop={1} dailyAt={2} keep={3} excludeSecrets={4}" -f `
        $cfg.enabled, $cfg.onServerStop, $cfg.dailyAt, $cfg.keep, $cfg.excludeSecrets)
Write-Info ("配置来源：{0}" -f $cfg.configPath)
foreach ($w in $cfg.warnings) { Write-Host "WARN $w" -ForegroundColor Yellow }

if (-not $cfg.enabled) {
    Write-Host '    注意：config/backup.json 里 enabled=false —— 任务仍会注册，但每天执行时会立刻跳过并记 warn。' -ForegroundColor Yellow
    Write-Host '          想彻底不跑，请用 -Uninstall。' -ForegroundColor Yellow
}

$backupScript = Join-Path $root 'scripts\backup-world.ps1'
if (-not (Test-Path -LiteralPath $backupScript)) {
    Write-Host "FAIL 找不到 $backupScript" -ForegroundColor Red
    exit 1
}

$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$argStr = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -FromConfig' -f $backupScript

# 解析 dailyAt → Trigger
$parts = $cfg.dailyAt.Split(':')
$hour = [int]$parts[0]; $minute = [int]$parts[1]
$at = (Get-Date).Date.AddHours($hour).AddMinutes($minute)

$action = New-ScheduledTaskAction -Execute $psExe -Argument $argStr -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Daily -At $at
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
    -MultipleInstances IgnoreNew
# 当前用户、交互式登录时运行：不需要存密码，也不会因为"未登录"而静默失败于凭据
# R6 #54：默认 Interactive（不需要存密码）；-LogonType S4U 用于"重启后未登录也要跑"。
$principal = New-ScheduledTaskPrincipal -UserId ("{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME) -LogonType $LogonType -RunLevel Limited

Write-Info "动作：$psExe $argStr"
Write-Info ("触发：每天 {0}；工作目录：{1}" -f $cfg.dailyAt, $root)

if ($WhatIf) {
    Write-Host '    -WhatIf：只打印定义，不注册' -ForegroundColor DarkGray
    exit 0
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Info "任务已存在 → 覆盖更新定义"
}

try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
} catch {
    Write-Host "FAIL 注册失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "     常见原因：当前会话没有注册计划任务的权限（需要管理员），或任务名被占用/被策略禁止。" -ForegroundColor Yellow
    Write-Host "     可尝试：右键『以管理员身份运行』PowerShell 后重跑本脚本。" -ForegroundColor Yellow
    Write-BackupAutoLog -Root $root -Level 'ERROR' -Message "计划任务注册失败：$($_.Exception.Message)"
    exit 1
}

# 回读校验：不信任"注册没报错"，必须能查到
$check = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $check) {
    Write-Host 'FAIL 注册后查不到任务（注册可能没生效）' -ForegroundColor Red
    exit 1
}
$info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
Write-Host "    已注册：$TaskName" -ForegroundColor Green
Write-Host ("    状态={0}  下次运行={1}" -f $check.State, $(if ($info) { $info.NextRunTime } else { '(未知)' }))
Write-Host ("    触发器={0}" -f (($check.Triggers | ForEach-Object { $_.StartBoundary }) -join ', '))
Write-Host ''
Write-Host '说明：' -ForegroundColor DarkGray
Write-Host '  · 任务只在**服务端已停**时真正备份；发现服务端在跑会跳过并写 logs/backup-auto.log'
Write-Host '  · 关掉自动备份：把 config/backup.json 的 enabled 改成 false（任务会自动跳过），或本脚本 -Uninstall 彻底删掉'
Write-BackupAutoLog -Root $root -Level 'INFO' -Message ("已注册计划任务 {0}（每日 {1}，keep={2}）" -f $TaskName, $cfg.dailyAt, $cfg.keep)

# R6 #54：注册成功 != 真能跑。立即跑一次并读 LastTaskResult。
if (-not $SkipSmokeTest) {
    $smoke = Invoke-TaskSmokeTest -TaskName $TaskName -Root $root
    if (-not $smoke.Ok) {
        Write-Host ("FAIL 冒烟执行未通过：{0}" -f $smoke.Detail) -ForegroundColor Red
        Write-Host '     任务注册成功，但没有证据表明它能真的备份。' -ForegroundColor Yellow
        Write-BackupAutoLog -Root $root -Level 'ERROR' -Message ("计划任务冒烟失败：{0}" -f $smoke.Detail)
        exit 1
    }
    Write-Host ("    冒烟通过：LastTaskResult={0}；{1}" -f $smoke.ExitCode, $smoke.Detail) -ForegroundColor Green
    Write-BackupAutoLog -Root $root -Level 'INFO' -Message ("计划任务冒烟通过（LastTaskResult={0}）" -f $smoke.ExitCode)
}
exit 0
