<#
.SYNOPSIS
    R6 #54 冒烟判定逻辑的离线验证 —— 不注册任何计划任务，不改本机状态。

.DESCRIPTION
    报告原文（§#54）：计划任务只证"注册成功"，不证"真能跑"。
    `install-backup-task.ps1` 已经实现了冒烟（Start-ScheduledTask → 轮询
    Get-ScheduledTaskInfo → **LastTaskResult** 且 **backup-auto.log 新增行**），
    但这条判定没有任何测试锁着：谁把 `$grew` 那一项删掉，所有测试照样绿，
    于是"任务从没成功过"又变回不可见。

    本脚本**从 `install-backup-task.ps1` 里原样抽取 `Invoke-TaskSmokeTest`**
    （不另写一份实现，否则测的是副本而不是生产代码），把外部 cmdlet 换成桩，
    然后验证 5 种状态下的判定：

      ① 正常跑完（LastTaskResult=0）+ 日志新增  → Ok=true
      ② 跑完了但**日志没新增**（任务没真的执行 backup-world）→ Ok=false（这是 #54 的核心判据）
      ③ 跑完了但 LastTaskResult=1（失败）        → Ok=false
      ④ 读不到任务信息                            → Ok=false
      ⑤ Start-ScheduledTask 抛错                  → Ok=false（不能当成功）

    **不会**调用真实的 Start-ScheduledTask / Get-ScheduledTaskInfo / 注册任务：
    三个都定义成本脚本内的桩函数，作用域覆盖同名的 Cmdlet。

.PARAMETER InstallScript
    要抽取函数体的脚本，默认 <仓库根>/scripts/install-backup-task.ps1。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\tests\schtask-smoke.ps1
#>
[CmdletBinding()]
param(
    [string]$InstallScript
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $InstallScript) { $InstallScript = Join-Path $root 'scripts/install-backup-task.ps1' }

$script:pass = 0
$script:fail = 0
function Ok([string]$name, [string]$detail = '') { $script:pass++; Write-Host "PASS $name $detail" -ForegroundColor Green }
function Bad([string]$name, [string]$detail = '') { $script:fail++; Write-Host "FAIL $name $detail" -ForegroundColor Red }

if (-not (Test-Path -LiteralPath $InstallScript)) {
    Bad '找到安装脚本' $InstallScript
    Write-Host ''
    Write-Host ("PASS {0} / FAIL {1}" -f $script:pass, $script:fail)
    exit 1
}

# ── 1. 从生产脚本里**原样抽取** Invoke-TaskSmokeTest ───────────────────────
$lines = @(Get-Content -LiteralPath $InstallScript -Encoding UTF8)
$start = -1
$end = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($start -lt 0 -and $lines[$i] -match '^function Invoke-TaskSmokeTest\b') { $start = $i }
    elseif ($start -ge 0 -and $lines[$i] -eq '}') { $end = $i; break }
}
if ($start -lt 0 -or $end -lt 0) {
    Bad '抽取 Invoke-TaskSmokeTest' '在安装脚本里找不到该函数（改名了就要同步更新本测试）'
    Write-Host ''
    Write-Host ("PASS {0} / FAIL {1}" -f $script:pass, $script:fail)
    exit 1
}
$fnText = ($lines[$start..$end] -join "`n")
Ok '抽取 Invoke-TaskSmokeTest' "第 $($start + 1)-$($end + 1) 行，$($end - $start + 1) 行"

# 判据必须还在（防止有人抽掉 grew / LastTaskResult 这两项又让测试变绿）
$hasGrew = $fnText -match '\$grew\s*='
$hasLtr = $fnText -match 'LastTaskResult'
$hasStart = $fnText -match 'Start-ScheduledTask'
if ($hasGrew -and $hasLtr -and $hasStart) { Ok '判定三要素齐全' 'LastTaskResult + 日志新增行(grew) + Start-ScheduledTask' }
else { Bad '判定三要素齐全' "grew=$hasGrew LastTaskResult=$hasLtr StartScheduledTask=$hasStart" }

# 注入后用 Invoke-Expression 定义到当前作用域
try {
    Invoke-Expression $fnText
    Ok '函数可被解析并定义'
}
catch {
    Bad '函数可被解析并定义' $_.Exception.Message
}

# ── 2. 桩：把外部依赖全部换掉（绝不触碰真实计划任务）──────────────────────
$script:stub = @{
    StartThrows = $false
    LastResult  = 0
    InfoNull    = $false
    LogGrow     = 0
    Root        = ''
}

function Start-ScheduledTask {
    param([string]$TaskName, $ErrorAction)
    if ($script:stub.StartThrows) { throw '桩：拒绝访问（模拟无权限）' }
    # 模拟任务执行时写入日志
    if ($script:stub.LogGrow -gt 0) {
        $logPath = Join-Path $script:stub.Root 'logs/backup-auto.log'
        $new = @(1..$script:stub.LogGrow | ForEach-Object { "stub line $_" })
        Add-Content -LiteralPath $logPath -Value $new -Encoding UTF8
    }
}

function Get-ScheduledTaskInfo {
    param([string]$TaskName, $ErrorAction)
    if ($script:stub.InfoNull) { return $null }
    return [pscustomobject]@{ LastTaskResult = $script:stub.LastResult; NextRunTime = (Get-Date) }
}

# 轮询里每轮 Start-Sleep 3s；测试中改成空操作，否则五个场景要跑几分钟
function Start-Sleep {
    param([int]$Seconds, $Milliseconds)
}

# ── 3. 五个场景 ────────────────────────────────────────────────────────────
$work = Join-Path ([System.IO.Path]::GetTempPath()) ('schtask-smoke-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path (Join-Path $work 'logs') -Force | Out-Null
$logFile = Join-Path $work 'logs/backup-auto.log'

function Reset-Stub {
    param([bool]$StartThrows = $false, [int]$LastResult = 0, [bool]$InfoNull = $false, [int]$LogGrow = 0)
    $script:stub.StartThrows = $StartThrows
    $script:stub.LastResult = $LastResult
    $script:stub.InfoNull = $InfoNull
    $script:stub.LogGrow = $LogGrow
    $script:stub.Root = $work
}

try {
    # ① 正常：LastTaskResult=0 且日志新增 3 行
    Set-Content -LiteralPath $logFile -Value @('old line 1') -Encoding UTF8
    Reset-Stub -LastResult 0 -LogGrow 3
    $r = Invoke-TaskSmokeTest -TaskName 'StubTask' -Root $work -TimeoutSec 1
    if ($r.Ok -and $r.ExitCode -eq 0 -and $r.Detail -match '新增 3 行') { Ok '① 正常跑完 + 日志新增 → Ok' $r.Detail }
    else { Bad '① 正常跑完 + 日志新增 → Ok' ("Ok=$($r.Ok) ExitCode=$($r.ExitCode) $($r.Detail)") }

    # ② 关键场景：跑完了但日志没新增（#54 的核心判据）
    Set-Content -LiteralPath $logFile -Value @('old line 1') -Encoding UTF8
    Reset-Stub -LastResult 0 -LogGrow 0
    $r = Invoke-TaskSmokeTest -TaskName 'StubTask' -Root $work -TimeoutSec 1
    if (-not $r.Ok -and $r.Detail -match '没有新增行') { Ok '② 日志没新增 → 判定失败（核心判据）' $r.Detail }
    else { Bad '② 日志没新增 → 判定失败（核心判据）' ("Ok=$($r.Ok) $($r.Detail)") }

    # ③ 任务跑了但失败：LastTaskResult=1，日志有新增也不算通过
    Set-Content -LiteralPath $logFile -Value @('old line 1') -Encoding UTF8
    Reset-Stub -LastResult 1 -LogGrow 2
    $r = Invoke-TaskSmokeTest -TaskName 'StubTask' -Root $work -TimeoutSec 1
    if (-not $r.Ok -and $r.ExitCode -eq 1) { Ok '③ LastTaskResult=1 → 判定失败' $r.Detail }
    else { Bad '③ LastTaskResult=1 → 判定失败' ("Ok=$($r.Ok) ExitCode=$($r.ExitCode)") }

    # ④ 读不到任务信息
    Reset-Stub -InfoNull $true
    $r = Invoke-TaskSmokeTest -TaskName 'StubTask' -Root $work -TimeoutSec 1
    if (-not $r.Ok -and $r.Detail -match '读不到') { Ok '④ 读不到任务信息 → 判定失败' $r.Detail }
    else { Bad '④ 读不到任务信息 → 判定失败' ("Ok=$($r.Ok) $($r.Detail)") }

    # ⑤ Start-ScheduledTask 抛错（无权限等）：必须如实失败，不能当成功
    Reset-Stub -StartThrows $true
    $r = Invoke-TaskSmokeTest -TaskName 'StubTask' -Root $work -TimeoutSec 1
    if (-not $r.Ok -and $r.Detail -match 'Start-ScheduledTask 失败') { Ok '⑤ 启动任务抛错 → 判定失败' $r.Detail }
    else { Bad '⑤ 启动任务抛错 → 判定失败' ("Ok=$($r.Ok) $($r.Detail)") }
}
finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host ("PASS {0} / FAIL {1}" -f $script:pass, $script:fail)
if ($script:fail -gt 0) {
    Write-Host '有失败项，exit 1' -ForegroundColor Red
    exit 1
}
Write-Host '全部通过，exit 0（未注册、未触发任何真实计划任务）' -ForegroundColor Green
exit 0
