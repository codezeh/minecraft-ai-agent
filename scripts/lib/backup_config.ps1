<#
.SYNOPSIS
    自动备份的配置读取 + 统一日志（backup-world / stop-panel / install-backup-task 共用）。

.DESCRIPTION
    为什么要有这个文件（用户拍板⑥：地图备份做成开关、默认开启）：
      自动备份有两个触发点 —— ①停服后（主路径）②每日计划任务（兜底）。
      两处都要问同一件事："开没开？keep 多少？要不要排除口令？" 如果各写一份，
      迟早漂移成两套语义（本项目的老毛病）。所以配置读取与日志只留这一份。

    配置：`config/backup.json`
        {
          "enabled": true,          # 总开关（false ⇒ 停服不备、计划任务也跳过）
          "onServerStop": true,     # 停服后自动备份（主路径）
          "dailyAt": "04:30",       # 每日计划任务时间（install-backup-task.ps1 用）
          "keep": 7,                # 保留最近几份
          "excludeSecrets": true    # 备份里是否排除 server.properties（含 RCON 口令）
        }

    设计原则：
      · 文件缺失/损坏/字段非法 ⇒ **退回默认值并记 warning**，绝不让"配置坏了"变成"备份悄悄停了"；
      · 默认值就是用户拍板的那套：enabled=true, onServerStop=true, dailyAt=04:30, keep=7, excludeSecrets=true；
      · 自动备份的每一次尝试（成功/失败/跳过/因服务端运行跳过）都追加一行到 `logs/backup-auto.log` —— 
        用户要能回答"到底备没备、为什么没备"。

.NOTES
    dot-source 使用：`. (Join-Path $PSScriptRoot 'lib/backup_config.ps1')`
#>

# 用户拍板的默认值（config/backup.json 缺失时就是这套）
function Get-BackupConfigDefaults {
    return [ordered]@{
        enabled        = $true
        onServerStop   = $true
        dailyAt        = '04:30'
        keep           = 7
        excludeSecrets = $true
    }
}

# 读配置：永远返回一份完整、可用的配置（附 warnings，不抛错）
function Get-BackupConfig {
    param(
        [string]$Root,
        [string]$ConfigPath
    )
    if (-not $Root) {
        $Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    }
    if (-not $ConfigPath) { $ConfigPath = Join-Path $Root 'config/backup.json' }

    $cfg = Get-BackupConfigDefaults
    $warnings = New-Object System.Collections.Generic.List[string]
    $fromFile = $false

    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        $warnings.Add("配置文件不存在：$ConfigPath（按默认值：enabled=true, onServerStop=true, dailyAt=04:30, keep=7）")
    } else {
        try {
            $raw = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $fromFile = $true

            if ($null -ne $raw.enabled) {
                if ($raw.enabled -is [bool]) { $cfg.enabled = $raw.enabled }
                else { $warnings.Add("enabled 不是布尔值（$($raw.enabled)）→ 用默认 true") }
            }
            if ($null -ne $raw.onServerStop) {
                if ($raw.onServerStop -is [bool]) { $cfg.onServerStop = $raw.onServerStop }
                else { $warnings.Add("onServerStop 不是布尔值 → 用默认 true") }
            }
            if ($null -ne $raw.dailyAt) {
                $s = [string]$raw.dailyAt
                if ($s -match '^([01]\d|2[0-3]):[0-5]\d$') { $cfg.dailyAt = $s }
                else { $warnings.Add("dailyAt 格式非法（$s，应为 HH:mm）→ 用默认 04:30") }
            }
            if ($null -ne $raw.keep) {
                $k = 0
                if ([int]::TryParse([string]$raw.keep, [ref]$k) -and $k -ge 0 -and $k -le 365) { $cfg.keep = $k }
                else { $warnings.Add("keep 非法（$($raw.keep)，应为 0-365）→ 用默认 7") }
            }
            if ($null -ne $raw.excludeSecrets) {
                if ($raw.excludeSecrets -is [bool]) { $cfg.excludeSecrets = $raw.excludeSecrets }
                else { $warnings.Add("excludeSecrets 不是布尔值 → 用默认 true") }
            }
        } catch {
            $warnings.Add("配置解析失败：$($_.Exception.Message) → 全部按默认值")
        }
    }

    return [pscustomobject]@{
        enabled        = [bool]$cfg.enabled
        onServerStop   = [bool]$cfg.onServerStop
        dailyAt        = [string]$cfg.dailyAt
        keep           = [int]$cfg.keep
        excludeSecrets = [bool]$cfg.excludeSecrets
        configPath     = $ConfigPath
        fromFile       = $fromFile
        warnings       = $warnings
    }
}

# 自动备份专用日志（用户要能回答"到底备没备、为什么没备"）
function Get-BackupLogPath {
    param([string]$Root)
    if (-not $Root) { $Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
    return (Join-Path $Root 'logs/backup-auto.log')
}

function Write-BackupAutoLog {
    param(
        [string]$Root,
        [Parameter(Mandatory = $true)][string]$Message,
        [ValidateSet('INFO', 'WARN', 'ERROR', 'SKIP', 'OK')][string]$Level = 'INFO'
    )
    $path = Get-BackupLogPath -Root $Root
    $dir = Split-Path -Parent $path
    try {
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        $line = ('[{0}] {1,-5} {2}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Level, $Message)
        Add-Content -LiteralPath $path -Value $line -Encoding UTF8
    } catch {
        # 日志写不进去也不能让备份/停服流程炸掉
        Write-Host "WARN 自动备份日志写入失败：$($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# 统计"连续因服务端运行而跳过"了多少次（用日志尾巴算，避免再加一个状态文件）
function Get-ConsecutiveSkipCount {
    param([string]$Root, [int]$MaxLook = 50)
    $path = Get-BackupLogPath -Root $Root
    if (-not (Test-Path -LiteralPath $path)) { return 0 }
    $lines = @(Get-Content -LiteralPath $path -Tail $MaxLook -ErrorAction SilentlyContinue)
    $n = 0
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
        if ($lines[$i] -match '因服务端运行跳过') { $n++ } else { break }
    }
    return $n
}

<#
    停服后自动备份 —— stop-panel.ps1 在**确认 java 已退出**之后调用。
    返回 @{ ran; exitCode; skipped; reason; backupDir }，**永不抛错**（停服优先，备份失败不影响关服）。
#>
function Invoke-BackupOnServerStop {
    param(
        [string]$Root,
        [switch]$DryRun
    )
    if (-not $Root) { $Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }

    $result = [pscustomobject]@{
        ran = $false; exitCode = $null; skipped = $false; reason = ''; backupDir = $null
    }

    $cfg = Get-BackupConfig -Root $Root
    foreach ($w in $cfg.warnings) { Write-BackupAutoLog -Root $Root -Level 'WARN' -Message $w }

    if (-not $cfg.enabled) {
        Write-Host '  · 自动备份：已关闭（config/backup.json enabled=false）—— 跳过' -ForegroundColor DarkGray
        Write-BackupAutoLog -Root $Root -Level 'SKIP' -Message '停服后备份跳过：总开关 enabled=false'
        $result.skipped = $true; $result.reason = 'enabled=false'
        return $result
    }
    if (-not $cfg.onServerStop) {
        Write-Host '  · 自动备份：onServerStop=false —— 停服不备份（只走每日计划任务）' -ForegroundColor DarkGray
        Write-BackupAutoLog -Root $Root -Level 'SKIP' -Message '停服后备份跳过：onServerStop=false（交给每日计划任务）'
        $result.skipped = $true; $result.reason = 'onServerStop=false'
        return $result
    }

    if ($DryRun) {
        Write-Host '  · 自动备份：DryRun，不实际执行' -ForegroundColor DarkGray
        $result.skipped = $true; $result.reason = 'dryrun'
        return $result
    }

    $script = Join-Path $Root 'scripts/backup-world.ps1'
    if (-not (Test-Path -LiteralPath $script)) {
        Write-BackupAutoLog -Root $Root -Level 'ERROR' -Message "停服后备份失败：找不到 $script"
        $result.exitCode = -1; $result.reason = 'script missing'
        return $result
    }

    Write-Host ("  · 自动备份：服务端已停，开始冷备（keep={0}，excludeSecrets={1}）" -f $cfg.keep, $cfg.excludeSecrets) -ForegroundColor Cyan
    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$script`"", '-FromConfig')
    $result.ran = $true
    try {
        & $psExe @argv
        $code = $LASTEXITCODE
        $result.exitCode = $code
        if ($code -eq 0) {
            Write-BackupAutoLog -Root $Root -Level 'OK' -Message '停服后自动备份成功（见 backups/ 下最新的 world-*）'
            Write-Host '  · 自动备份：完成' -ForegroundColor Green
        } elseif ($code -eq 2) {
            Write-BackupAutoLog -Root $Root -Level 'SKIP' -Message '停服后自动备份跳过：检测到服务端仍在运行（exit 2）'
            Write-Host '  · 自动备份：跳过（检测到服务端仍在运行）' -ForegroundColor Yellow
            $result.skipped = $true; $result.reason = 'server running'
        } else {
            Write-BackupAutoLog -Root $Root -Level 'ERROR' -Message "停服后自动备份失败：backup-world.ps1 exit=$code（停服不受影响）"
            Write-Host "  · 自动备份：失败（exit=$code），停服已完成，不受影响" -ForegroundColor Yellow
        }
    } catch {
        $result.exitCode = -1
        Write-BackupAutoLog -Root $Root -Level 'ERROR' -Message "停服后自动备份异常：$($_.Exception.Message)（停服不受影响）"
        Write-Host "  · 自动备份：异常（$($_.Exception.Message)），停服已完成，不受影响" -ForegroundColor Yellow
    }
    return $result
}
