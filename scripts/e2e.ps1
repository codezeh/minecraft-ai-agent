<#
.SYNOPSIS
    隔离服 E2E：一条命令完成「起服 → 跑场景 → 断言 → 停服 → 重置世界 → 汇总」。

.DESCRIPTION
    第四轮审计 ③ 的问题：18 个 `*_live.mjs` 全都要求**人工先把测试服开好**，没有起服/重置脚本，
    场地靠 `fill`/`forceload` 自建、跑完不复位 —— 于是"跑过一次"和"能重复跑"是两件事。

    这个脚本把那套手工流程固化成一条命令，并且每条断言都可重复执行：

      1. 在 `tmp/e2e/<scenario>/` 建一个**一次性运行目录**（不碰 server-test，也不碰生产服）
         · server.properties 来自 test-template（端口 25566 / RCON 25576、超平坦、离线、关白名单）
         · world/ 来自 test-template/world（干净模板世界）
         · libraries/ versions/ cache/ 用 junction 指到 server-test（只读复用，避免每次拷 158MB）
      2. 起服（JDK 21 + server/server.jar），等日志出现 `Done (`，再用 RCON 确认真的能下指令
      3. 跑场景（claims / restart）
      4. 停服（RCON `stop`，超时再强杀）
      5. 重置：删掉本次世界，从模板重建；并**校验**运行目录与模板逐文件一致（重置生效的证据）
      6. 汇总 PASS/FAIL，退出码 0/1

    每个场景用独立的 `MC_BOTS_ROOT`，所以板库（claims）、bot 记忆都落在运行目录里，
    不会污染仓库的 `mindcraft/bots/`，重置时一起消失。

.PARAMETER Scenario
    claims  —— 多 bot 抢单争用（驱动 tools/t37_claims_contention_live.mjs）
    restart —— 重启恢复（箱子 / 熔炉进度 / bot 记忆跨停服存活）
    chest   —— bot **主动**存/取箱子 + 物品守恒（驱动 tools/e2e_chest_store_live.mjs，T23 覆盖缺口）
    all     —— 三个都跑

.PARAMETER KeepRun
    保留运行目录（默认跑完删除，只在排查时用）。

.PARAMETER SkipReset
    跑完不重置世界（默认重置；仅用于排查"重置前后差异"）。

.PARAMETER BootTimeoutSec
    等 `Done (` 的上限秒数，默认 180。

.EXAMPLE
    pwsh scripts/e2e.ps1 -Scenario restart
    起服 → 建场地 → 停服 → 起服 → 断言 → 停服 → 重置 → 汇总。

.EXAMPLE
    pwsh scripts/e2e.ps1 -Scenario all
    两个场景顺序跑（每个场景独立运行目录，互不影响）。

.NOTES
    退出码：0 = 全部场景/断言通过；1 = 有失败（逐条 PASS/FAIL 已打印，日志留在运行目录）。
#>
[CmdletBinding()]
param(
    [ValidateSet('claims', 'restart', 'chest', 'all')]
    [string]$Scenario = 'restart',
    [switch]$KeepRun,
    [switch]$SkipReset,
    [int]$BootTimeoutSec = 180
)

$ErrorActionPreference = 'Stop'

# ── 路径 ──────────────────────────────────────────────────────────
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = Split-Path -Parent $ScriptDir
$MindDir    = Join-Path $RepoRoot 'mindcraft'
$TemplateDir= Join-Path $RepoRoot 'test-template'
$ServerJar  = Join-Path $RepoRoot 'server/server.jar'
$SrvTestDir = Join-Path $RepoRoot 'server-test'
$RunRoot    = Join-Path $RepoRoot 'tmp/e2e'

$RCON_PORT = 25576
$MC_PORT   = 25566
$MS_PORT   = 18093      # t37 内置 mindserver 用的端口（固定值写死在 t37 里）

$script:Results = @()
$script:CurrentScenario = ''
$script:JavaPids = @()

function Write-Step {
    param([string]$Message)
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor DarkGray
    Write-Host $Message -ForegroundColor Cyan
    Write-Host ('=' * 78) -ForegroundColor DarkGray
}
function Write-Ok   { param([string]$m) Write-Host ('  PASS  ' + $m) -ForegroundColor Green }
function Write-Bad  { param([string]$m) Write-Host ('  FAIL  ' + $m) -ForegroundColor Red }

function Add-Result {
    param([string]$Name, [bool]$Pass, [string]$Detail = '')
    $script:Results += [pscustomobject]@{ Scenario = $script:CurrentScenario; Name = $Name; Pass = $Pass; Detail = $Detail }
    if ($Pass) { Write-Ok "$Name —— $Detail" } else { Write-Bad "$Name —— $Detail" }
}

function Stop-E2E {
    param([string]$Message, [string]$Fix = '')
    Write-Host ''
    Write-Host ('  FATAL ' + $Message) -ForegroundColor Red
    if ($Fix) { Write-Host ('        修复：' + $Fix) -ForegroundColor Yellow }
    Write-Host ''
    exit 1
}

# ── 找 JDK ────────────────────────────────────────────────────────
function Resolve-Java {
    # R6 #53：原来取 $cands[0]（顺序不确定）；多 JDK 时可能拿到 17，报错却只说"起服超时"。
    $cands = @(Get-ChildItem -Path (Join-Path $RepoRoot '.tools') -Filter 'jdk*' -Directory -ErrorAction SilentlyContinue |
               ForEach-Object { Join-Path $_.FullName 'bin/java.exe' } | Where-Object { Test-Path $_ })
    if ($cands.Count -eq 0) { Stop-E2E '找不到 JDK：.tools/jdk*/bin/java.exe' '把 JDK 21 放到 .tools/ 下（与 server/server.jar 配套）。' }
    $best = $null
    foreach ($c in $cands) {
        $ver = $null
        $prevEap = $ErrorActionPreference
        $raw = $null
        try {
            # 修（PS 5.1 专属坑）：本脚本 EAP=Stop 时，java -version 把版本行写到 stderr，
            # 经 2>&1 会变成 ErrorRecord 并抛 NativeCommandError，被 catch 吞掉 ⇒ 版本号恒 null，
            # 上层报 "解析不出任何 JDK 的主版本号"。这里只在读版本时临时降级为 Continue
            # （与 Invoke-Rcon 同法），读完立刻还原；不用 -ErrorAction 掩盖真错。
            $ErrorActionPreference = 'Continue'
            $raw = (& $c -version 2>&1 | Select-Object -First 1) -join ' '
        } catch { } finally { $ErrorActionPreference = $prevEap }
        if ($raw -match 'version "(\d+)(?:\.(\d+))?') { $ver = if ($Matches[1] -eq '1') { [int]$Matches[2] } else { [int]$Matches[1] } }
        if ($null -eq $ver) { continue }
        if ($null -eq $best -or $ver -gt $best.Ver) { $best = [pscustomobject]@{ Path = $c; Ver = $ver } }
    }
    if (-not $best) { Stop-E2E '解析不出任何 JDK 的主版本号' '手动跑 .tools/jdk*/bin/java.exe -version 看输出。' }
    if ($best.Ver -lt 21) { Stop-E2E ("JDK 主版本是 {0}，Paper 1.21.8 需要 21+" -f $best.Ver) '把 JDK 21 放到 .tools/ 下。' }
    return $best.Path
}

# ── 起服/停服 ─────────────────────────────────────────────────────
# R6 #53：先摘 junction 再 -Recurse 删（PS 5.1 会跟随 junction 删到 server-test 的真数据）。
function Remove-RunDirSafe {
    param([string]$Dir)
    if (-not (Test-Path -LiteralPath $Dir)) { return }
    foreach ($name in @('libraries', 'versions', 'cache')) {
        $link = Join-Path $Dir $name
        if (Test-Path -LiteralPath $link) {
            $item = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
            if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                cmd /c rmdir "`"$link`"" 2>$null | Out-Null
            }
        }
    }
    Remove-Item -LiteralPath $Dir -Recurse -Force -ErrorAction SilentlyContinue
}

function New-RunDir {
    param([string]$ScenarioName, [string]$RconPassword)

    $runDir = Join-Path $RunRoot $ScenarioName
    Remove-RunDirSafe -Dir $runDir
    New-Item -ItemType Directory -Path $runDir -Force | Out-Null

    # server.properties：模板 + 每次随机的 RCON 密码（密码不进仓库、不进日志）
    $props = Get-Content -LiteralPath (Join-Path $TemplateDir 'server.properties') -Raw -Encoding UTF8
    $props = $props.Replace('__E2E_RCON_PASSWORD__', $RconPassword)
    Set-Content -LiteralPath (Join-Path $runDir 'server.properties') -Value $props -Encoding ASCII -NoNewline

    'eula=true' | Set-Content -LiteralPath (Join-Path $runDir 'eula.txt') -Encoding ASCII

    # 世界：从模板拷（这就是"重置"的来源）
    Copy-Item -LiteralPath (Join-Path $TemplateDir 'world') -Destination (Join-Path $runDir 'world') -Recurse -Force

    # 只读大件：junction 复用 server-test（Paper 的 libraries/versions/cache 合计数百 MB）
    foreach ($d in @('libraries', 'versions', 'cache')) {
        $src = Join-Path $SrvTestDir $d
        $dst = Join-Path $runDir $d
        if (Test-Path -LiteralPath $src) {
            New-Item -ItemType Junction -Path $dst -Target $src | Out-Null
        }
    }
    return $runDir
}

function Start-TestServer {
    param([string]$RunDir, [string]$Java)

    $log = Join-Path $RunDir 'server.log'
    $err = Join-Path $RunDir 'server.err.log'
    $pidFile = Join-Path $RunDir 'server.pid'
    $ctl = Join-Path $MindDir 'tools/e2e_server_ctl.mjs'
    if (Test-Path -LiteralPath $log) { Remove-Item -LiteralPath $log -Force }
    if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile -Force }

    # 用 `cmd /c start /b` 起守护器：让它脱离 PowerShell 的控制台（实测直接 Start-Process 时，
    # 外层 powershell 一收尾，java 会跟着消失 —— 表现为"场景跑到一半服务端没了"）。
    $inner = 'node "' + $ctl + '" --run-dir "' + $RunDir + '" --java "' + $Java + '" --jar "' + $ServerJar +
             '" --log "' + $log + '" --err "' + $err + '"'
    Start-Process -FilePath 'cmd' -ArgumentList @('/c', 'start', '""', '/b', $inner) `
        -WorkingDirectory $MindDir -WindowStyle Hidden | Out-Null

    # 等守护器把 java 的 pid 写出来（它 spawn 完立刻写）
    $deadline = (Get-Date).AddSeconds(30)
    $javaPid = 0
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        if (Test-Path -LiteralPath $pidFile) {
            $txt = (Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue)
            if ($txt -and [int]::TryParse($txt.Trim(), [ref]$javaPid) -and $javaPid -gt 0) { break }
        }
    }
    if ($javaPid -gt 0) { $script:JavaPids += $javaPid }
    return @{ JavaPid = $javaPid; Log = $log; Err = $err }
}

function Wait-ServerReady {
    param([string]$Log, [int]$TimeoutSec)

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        $text = ''
        try { $text = Get-Content -LiteralPath $Log -Raw -Encoding UTF8 -ErrorAction SilentlyContinue } catch { }
        if ($text -and $text -match 'Done \(') { return $true }
        if ($text -and $text -match 'You need to agree to the EULA') { Stop-E2E '服务端拒绝启动：EULA 未同意' '运行目录里的 eula.txt 必须为 true。' }
    }
    return $false
}

function Invoke-Rcon {
    param([string]$Command, [switch]$AllowFail)

    # 用 tools/e2e_rcon.mjs 而不是 `node -e "<内联 JS>"`：
    # PS 5.1 把含双引号的内联 JS 传给 node.exe 时会拆参数（实测 RCON 探测因此一直失败）。
    # 传文件 + 单个命令参数没有转义问题。
    $rconTool = Join-Path $MindDir 'tools/e2e_rcon.mjs'
    Push-Location $MindDir
    try {
        # Windows PowerShell 5.1 会把原生命令写到 stderr 的内容变成**终止性**错误；
        # node 正常工作时也会写 stderr，所以这里局部降级，成败只看退出码。
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { $out = & node $rconTool $Command 2>&1; $code = $LASTEXITCODE }
        finally { $ErrorActionPreference = $prevEap }
    }
    finally { Pop-Location }

    if ($code -ne 0 -and -not $AllowFail) {
        Stop-E2E ("RCON 命令失败：" + $Command) ($out | Out-String).Trim()
    }
    return [pscustomobject]@{ Output = ($out | Out-String); Code = $code }
}

function Test-RconReady {
    param([int]$TimeoutSec = 60)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        $r = Invoke-Rcon -Command 'list' -AllowFail
        if ($r.Code -eq 0 -and $r.Output -match 'players online') { return $true }
    }
    return $false
}

function Stop-TestServer {
    param([hashtable]$Server, [int]$GraceSec = 60)

    if (-not $Server) { return }
    $javaPid = [int]$Server.JavaPid

    # 优雅停：RCON stop → 等 java 自己退（这样世界才会被正常保存）
    Invoke-Rcon -Command 'stop' -AllowFail | Out-Null
    $deadline = (Get-Date).AddSeconds($GraceSec)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        if ($javaPid -le 0 -or -not (Get-Process -Id $javaPid -ErrorAction SilentlyContinue)) { return $true }
    }
    # 兜底：只 kill 我们自己那个 pid（绝不按名字扫 java —— 可能有人在跑别的服）
    if ($javaPid -gt 0) {
        try { Stop-Process -Id $javaPid -Force -ErrorAction SilentlyContinue } catch { }
        Start-Sleep -Seconds 2
    }
    return $false
}

# ── 世界重置 + 校验 ───────────────────────────────────────────────
function Reset-World {
    param([string]$RunDir)

    $world = Join-Path $RunDir 'world'
    if (Test-Path -LiteralPath $world) { Remove-Item -LiteralPath $world -Recurse -Force }
    Copy-Item -LiteralPath (Join-Path $TemplateDir 'world') -Destination $world -Recurse -Force
}

function Get-WorldFingerprint {
    param([string]$WorldDir)
    $files = Get-ChildItem -LiteralPath $WorldDir -Recurse -File -ErrorAction SilentlyContinue |
             Where-Object { $_.Name -notin @('session.lock') } |
             Sort-Object FullName
    $lines = foreach ($f in $files) {
        $rel = $f.FullName.Substring($WorldDir.Length).Replace('\', '/')
        $h = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
        "$rel $h"
    }
    return ($lines -join "`n")
}

# ── 场景：claims ─────────────────────────────────────────────────
function Invoke-ClaimsScenario {
    param([string]$RunDir)

    $env:MC_BOTS_ROOT = Join-Path $RunDir 'bots'
    # 直接驱动既有 tools/t37_claims_contention_live.mjs。
    # t11 期间它曾被 ① 身份门打死（自建 socket 不带握手 token），当时的临时替代
    # e2e_claims_live.mjs 已删除：t23 给 t37 补了 token（走 tools/lib/ms_token.mjs），
    # 判据只有这一份，不再各写一遍防止漂移。
    $script = Join-Path $MindDir 'tools/t37_claims_contention_live.mjs'
    if (-not (Test-Path -LiteralPath $script)) { Stop-E2E "找不到 $script" 'mindcraft 仓库不完整。' }

    Push-Location $MindDir
    try {
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { $out = & node $script 2>&1; $code = $LASTEXITCODE }
        finally { $ErrorActionPreference = $prevEap }
    }
    finally { Pop-Location }

    $text = ($out | Out-String)
    $text | Set-Content -LiteralPath (Join-Path $RunDir 'scenario-claims.log') -Encoding UTF8

    $passLines = @($text -split "`n" | Where-Object { $_ -match '^PASS ' })
    $failLines = @($text -split "`n" | Where-Object { $_ -match '^FAIL ' })

    Add-Result 'claims 场景脚本全部断言通过' ($code -eq 0 -and $failLines.Count -eq 0) ("退出码=$code, PASS=$($passLines.Count), FAIL=$($failLines.Count)")

    # 关键断言必须**真的出现过**（防止脚本早退却"零失败"）
    $must = @(
        '①A 预约成功',
        '②B 抢同一 key',
        '③B 没落行',
        '④反向对照',
        '⑤ entity 预约泄漏'
    )
    foreach ($m in $must) {
        $hit = ($passLines | Where-Object { $_ -like "*$m*" }).Count -gt 0
        Add-Result ("claims 关键断言出现：" + $m) $hit ($(if ($hit) { '命中' } else { "日志里没有该断言的 PASS 行（见 scenario-claims.log）" }))
    }
}

# ── 场景：restart ────────────────────────────────────────────────
function Invoke-RestartScenario {
    param([string]$RunDir, [string]$Java, [string]$RconPassword)

    $state = Join-Path $RunDir 'restart-expect.json'
    $script = Join-Path $MindDir 'tools/e2e_restart_live.mjs'
    if (-not (Test-Path -LiteralPath $script)) { Stop-E2E "找不到 $script" 'mindcraft 仓库不完整。' }

    $env:MC_BOTS_ROOT = Join-Path $RunDir 'bots'
    $env:E2E_RUN_ID = (Get-Date -Format 'yyyyMMddHHmmss')

    # ── 第一次起服：建场地 ──
    $server = Start-TestServer -RunDir $RunDir -Java $Java
    try {
        if (-not (Wait-ServerReady -Log $server.Log -TimeoutSec $BootTimeoutSec)) {
            Stop-E2E '第一次起服超时：日志里没有出现 Done (' "看 $($server.Log)（多半是端口被占或 jar 依赖缺失）"
        }
        if (-not (Test-RconReady)) { Stop-E2E 'RCON 在 60 秒内没准备好' '检查 server.properties 的 enable-rcon/rcon.password。' }
        Add-Result '第一次起服：Done ( 且 RCON 可用' $true "日志 $($server.Log)"

        Push-Location $MindDir
        try {
            $prevEap = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            try { $out = & node $script 'stage' '--state' $state 2>&1; $code = $LASTEXITCODE }
            finally { $ErrorActionPreference = $prevEap }
        }
        finally { Pop-Location }
        ($out | Out-String) | Set-Content -LiteralPath (Join-Path $RunDir 'scenario-restart-stage.log') -Encoding UTF8

        $passStage = @($out | Where-Object { $_ -match '^PASS ' }).Count
        $failStage = @($out | Where-Object { $_ -match '^FAIL ' }).Count
        Add-Result 'restart/stage：场地与记忆已就绪' ($code -eq 0 -and $failStage -eq 0) ("退出码=$code, PASS=$passStage, FAIL=$failStage")
        if ($code -ne 0) { Stop-E2E 'stage 阶段失败，后续 verify 没有意义' "见 $(Join-Path $RunDir 'scenario-restart-stage.log')" }
    }
    finally {
        $stopped = Stop-TestServer -Server $server
        Add-Result '第一次停服（优雅退出）' $stopped 'RCON stop → java 进程退出'
    }

    # ── 第二次起服：重启后断言 ──
    $server2 = Start-TestServer -RunDir $RunDir -Java $Java
    try {
        if (-not (Wait-ServerReady -Log $server2.Log -TimeoutSec $BootTimeoutSec)) {
            Stop-E2E '重启后起服超时' "看 $($server2.Log)"
        }
        if (-not (Test-RconReady)) { Stop-E2E '重启后 RCON 未就绪' '' }
        Add-Result '重启后起服：Done ( 且 RCON 可用' $true "日志 $($server2.Log)"

        Push-Location $MindDir
        try {
            $prevEap2 = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            try { $out2 = & node $script 'verify' '--state' $state 2>&1; $code2 = $LASTEXITCODE }
            finally { $ErrorActionPreference = $prevEap2 }
        }
        finally { Pop-Location }
        ($out2 | Out-String) | Set-Content -LiteralPath (Join-Path $RunDir 'scenario-restart-verify.log') -Encoding UTF8

        $passV = @($out2 | Where-Object { $_ -match '^PASS ' }).Count
        $failV = @($out2 | Where-Object { $_ -match '^FAIL ' }).Count
        Add-Result 'restart/verify：重启前写的状态都读回来了' ($code2 -eq 0 -and $failV -eq 0) ("退出码=$code2, PASS=$passV, FAIL=$failV")

        foreach ($line in ($out2 | Where-Object { $_ -match '^(PASS|FAIL) ' })) {
            $isPass = $line.StartsWith('PASS')
            Add-Result ('  ' + ($line -replace '^(PASS|FAIL) ', '')) $isPass ''
        }
    }
    finally {
        $stopped2 = Stop-TestServer -Server $server2
        Add-Result '第二次停服（优雅退出）' $stopped2 'RCON stop → java 进程退出'
    }
}

# ── 通用：跑一个 live 脚本并把它的 PASS/FAIL 逐条搬进汇总 ──────
function Invoke-LiveScript {
    param(
        [string]$Script,
        [string]$LogName,
        [string]$RunDir,
        [string]$Title,
        [string[]]$ExtraArgs = @()
    )

    Push-Location $MindDir
    try {
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            if ($ExtraArgs.Count -gt 0) { $out = & node $Script @ExtraArgs 2>&1; $code = $LASTEXITCODE }
            else { $out = & node $Script 2>&1; $code = $LASTEXITCODE }
        }
        finally { $ErrorActionPreference = $prevEap }
    }
    finally { Pop-Location }

    $text = ($out | Out-String)
    $text | Set-Content -LiteralPath (Join-Path $RunDir $LogName) -Encoding UTF8

    $passLines = @($text -split "`n" | Where-Object { $_ -match '^\s*PASS\s' })
    $failLines = @($text -split "`n" | Where-Object { $_ -match '^\s*FAIL\s' })
    Add-Result ("$Title —— 脚本全部断言通过") ($code -eq 0 -and $failLines.Count -eq 0) ("退出码=$code, PASS=$($passLines.Count), FAIL=$($failLines.Count)")

    # 逐条搬（与 restart 场景风格一致：每条断言一行汇总）
    foreach ($line in @($passLines + $failLines)) {
        $isPass = $line -match '^\s*PASS\s'
        $name = ($line -replace '^\s*(PASS|FAIL)\s+', '').Trim()
        if ($name.Length -gt 90) { $name = $name.Substring(0, 90) }
        Add-Result ("  " + $name) $isPass ''
    }

    if ($code -ne 0 -and $failLines.Count -eq 0) {
        Add-Result ("$Title —— 退出码非 0 但没有 FAIL 行（脚本异常退出）") $false ("退出码=$code")
    }

    # ★ 已知缺陷显式告警（**不跳过、不降级**：结果仍是 FAIL，只是把"这不是新问题"说清楚）。
    #   背景：docs/audit-r5/fixes/09-chest-e2e.md §9/§10 —— fetch(N) 偶尔会多搬并把账目算错，
    #   表现为「箱子被搬空 / 背包多进 / 技能报只取到 k/N」。在根因修掉之前这里会间歇性红，
    #   所以失败时额外提示一句，避免每次都被当成新的回归来查；但**不会**因此变绿。
    if ($code -ne 0 -and $Script -match 'e2e_chest_store_live') {
        Write-Host '  [已知缺陷] withdraw/fetch 的请求语义被破坏（多搬 + 账目错）—— 见 docs/audit-r5/fixes/09-chest-e2e.md §9/§10' -ForegroundColor Yellow
        Write-Host '             本条仍按 FAIL 计入，不跳过、不放宽断言；根因修复后应自然转绿。' -ForegroundColor Yellow
    }
}

# ── 场景：chest（bot 主动存取 + 物品守恒）────────────────────────
#
# T23 查实的覆盖缺口：restart 场景的箱子物品是 RCON `item replace` 塞进去的、bot 只读回；
# 全仓没有任何 live 工具调用真实技能搬物品。这条补「存 N → 背包-N/箱+N → 守恒 → 取 M → 守恒」，
# 另加三条反证（取不存在的物品 / 满箱存 / 距离过远），防止"永远返回成功"也能过。
function Invoke-ChestScenario {
    param([string]$RunDir, [string]$Java)

    $liveScript = Join-Path $MindDir 'tools/e2e_chest_store_live.mjs'
    if (-not (Test-Path -LiteralPath $liveScript)) { Stop-E2E "找不到 $liveScript" 'mindcraft 仓库不完整。' }
    $env:MC_BOTS_ROOT = Join-Path $RunDir 'bots'

    # ── 第一段：起服 → 守恒 + 反证 → 停服 ──
    $server = Start-TestServer -RunDir $RunDir -Java $Java
    try {
        if (-not (Wait-ServerReady -Log $server.Log -TimeoutSec $BootTimeoutSec)) { Stop-E2E '起服超时（chest）' "看 $($server.Log)" }
        if (-not (Test-RconReady)) { Stop-E2E 'RCON 未就绪（chest）' '' }
        Add-Result 'chest：起服就绪（第一段）' $true "日志 $($server.Log)"
        Invoke-LiveScript -Script $liveScript -LogName 'scenario-chest-store.log' -RunDir $RunDir -Title 'chest 主动存取守恒（存16/取8 + 三条反证）'
    }
    finally {
        $stoppedC1 = Stop-TestServer -Server $server
        Add-Result 'chest：停服（第一段，优雅退出）' $stoppedC1 'RCON stop → java 进程退出'
    }

    # ── 第二段：重启后只读校验箱子内容没丢（跨重启守恒）──
    $server2 = Start-TestServer -RunDir $RunDir -Java $Java
    try {
        if (-not (Wait-ServerReady -Log $server2.Log -TimeoutSec $BootTimeoutSec)) { Stop-E2E '重启后起服超时（chest）' "看 $($server2.Log)" }
        if (-not (Test-RconReady)) { Stop-E2E '重启后 RCON 未就绪（chest）' '' }
        Add-Result 'chest：重启后起服就绪（第二段）' $true "日志 $($server2.Log)"
        Invoke-LiveScript -Script $liveScript -LogName 'scenario-chest-persist.log' -RunDir $RunDir -Title 'chest 跨重启守恒（箱内 8 个 oak_log 仍在）' -ExtraArgs @('--verify-persist')
    }
    finally {
        $stoppedC2 = Stop-TestServer -Server $server2
        Add-Result 'chest：停服（第二段，优雅退出）' $stoppedC2 'RCON stop → java 进程退出'
    }
}
# ══════════════════════════════════════════════════════════════════
# 主流程
# ══════════════════════════════════════════════════════════════════
Write-Host ''
Write-Host '隔离服 E2E（第四轮审计 ③）' -ForegroundColor White
Write-Host "  仓库根    : $RepoRoot"
Write-Host "  场景      : $Scenario"
Write-Host "  运行根目录: $RunRoot"
Write-Host "  测试服端口: $MC_PORT / RCON $RCON_PORT"

foreach ($p in @($MindDir, $TemplateDir, $ServerJar)) {
    if (-not (Test-Path -LiteralPath $p)) { Stop-E2E "缺少必需路径：$p" '把 mindcraft 仓 clone 到仓库根、保留 test-template/ 与 server/server.jar。' }
}
$Java = Resolve-Java
Write-Host "  JDK       : $Java"

$env:RCON_PORT = $RCON_PORT
$scenarios = if ($Scenario -eq 'all') { @('claims', 'restart', 'chest') } else { @($Scenario) }

try {
    foreach ($sc in $scenarios) {
        $script:CurrentScenario = $sc
        Write-Step "场景：$sc"

        # 端口占用检查（宁可报错，也不要连到别人开的服上做断言）
        # R6 #53：三个端口都要预检（原来只查 MC_PORT，撞 RCON/18093 会伪装成"起服超时"）。
        foreach ($p in @($MC_PORT, $RCON_PORT, $MS_PORT)) {
            $busy = @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
            if ($busy.Count -gt 0) {
                Stop-E2E "端口 $p 已被占用（pid $($busy[0].OwningProcess)）" '先停掉占用的实例：测试必须跑在自己起的那个实例上。'
            }
        }

        $rconPass = -join ((1..24) | ForEach-Object { 'abcdef0123456789'[(Get-Random -Maximum 16)] })
        $env:RCON_PASSWORD = $rconPass
        $runDir = New-RunDir -ScenarioName $sc -RconPassword $rconPass

        $templateFp = Get-WorldFingerprint -WorldDir (Join-Path $TemplateDir 'world')
        $runFp = Get-WorldFingerprint -WorldDir (Join-Path $runDir 'world')
        Add-Result '起服前世界 = 模板世界（干净起点）' ($templateFp -eq $runFp) '逐文件 sha256 比对'

        if ($sc -eq 'claims') {
            # claims 只需要一个已在跑的服：起→跑→停
            $server = Start-TestServer -RunDir $runDir -Java $Java
            try {
                if (-not (Wait-ServerReady -Log $server.Log -TimeoutSec $BootTimeoutSec)) { Stop-E2E '起服超时（claims）' "看 $($server.Log)" }
                if (-not (Test-RconReady)) { Stop-E2E 'RCON 未就绪（claims）' '' }
                Add-Result 'claims：起服就绪' $true "日志 $($server.Log)"
                Invoke-ClaimsScenario -RunDir $runDir
            }
            finally {
                $stoppedC = Stop-TestServer -Server $server
                Add-Result 'claims：停服（优雅退出）' $stoppedC 'RCON stop → java 进程退出'
            }
        }
        elseif ($sc -eq 'restart') {
            Invoke-RestartScenario -RunDir $runDir -Java $Java -RconPassword $rconPass
        }
        else {
            # chest：两段起服 —— 第一段做守恒+反证，第二段验证跨重启不丢
            Invoke-ChestScenario -RunDir $runDir -Java $Java
        }

        # ── 重置：世界回模板，运行目录清掉（下次从零开始）──
        if (-not $SkipReset) {
            Reset-World -RunDir $runDir
            $afterFp = Get-WorldFingerprint -WorldDir (Join-Path $runDir 'world')
            Add-Result '重置后世界 = 模板世界（重置生效）' ($templateFp -eq $afterFp) '逐文件 sha256 比对'
        }

        # ★ 真机验收发现：失败场景原来把运行目录一起删掉 ⇒ 最需要的现场（scenario-*.log）消失，
        #   取证只能加 -KeepRun 重跑一轮。现在：**失败时自动保留**，成功时仍按 -KeepRun 决定。
        $scenarioFailed = @($script:Results | Where-Object { $_.Scenario -eq $sc -and -not $_.Pass }).Count
        if (-not $KeepRun -and $scenarioFailed -eq 0) {
            Remove-RunDirSafe -Dir $runDir
        }
        else {
            $why = if ($KeepRun) { '-KeepRun' } else { "本场景有 $scenarioFailed 条失败，保留现场" }
            Write-Host "  INFO  保留运行目录：$runDir（$why）" -ForegroundColor DarkGray
        }
    }
}
finally {
    # 只清**本脚本自己起的**进程；绝不 `Get-Process java | Kill` ——
    # 这台机器上可能同时有别人开的测试服/主服，一刀切会把别人的跑批打断。
    foreach ($jp in @($script:JavaPids)) {
        if (-not $jp) { continue }
        try { Stop-Process -Id $jp -Force -ErrorAction SilentlyContinue } catch { }
    }
    $left = @(Get-Process java -ErrorAction SilentlyContinue)
    if ($left.Count -gt 0) {
        Write-Host ("  INFO  机器上还有 $($left.Count) 个 java 进程（可能是别人的跑批，未动）") -ForegroundColor DarkGray
    }
    Remove-Item Env:\MC_BOTS_ROOT -ErrorAction SilentlyContinue
    Remove-Item Env:\E2E_RUN_ID -ErrorAction SilentlyContinue
    # R6 #53：异常路径（Stop-E2E 直接 exit 1）原来会把 junction 留到下一轮。
    if (-not $KeepRun -and $runDir) { Remove-RunDirSafe -Dir $runDir }
}

# ── 汇总 ─────────────────────────────────────────────────────────
Write-Step '汇总'
foreach ($r in $script:Results) {
    $tag = if ($r.Pass) { 'PASS' } else { 'FAIL' }
    $color = if ($r.Pass) { 'Green' } else { 'Red' }
    Write-Host ("  [{0}] {1,-6} {2} {3}" -f $r.Scenario, $tag, $r.Name, $(if ($r.Detail) { "—— " + $r.Detail } else { '' })) -ForegroundColor $color
}
$ok = @($script:Results | Where-Object { $_.Pass }).Count
$all = $script:Results.Count
Write-Host ''
if ($all -eq 0) {
    Write-Host '没有任何断言被执行 —— 视为失败' -ForegroundColor Red
    exit 1
}
if ($ok -eq $all) {
    Write-Host ("E2E 通过：$ok/$all 条断言全部通过") -ForegroundColor Green
    exit 0
}
Write-Host ("E2E 失败：$ok/$all 条通过，$($all - $ok) 条失败") -ForegroundColor Red
exit 1
