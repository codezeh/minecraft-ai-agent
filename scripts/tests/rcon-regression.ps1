<#
.SYNOPSIS
    RCON 协议回归（离线可跑）—— 一条命令验证 scripts/lib/rcon.ps1 是对的。

.DESCRIPTION
    为什么有这个测试（R4 审计 T22）：
      `backup-world.ps1` 的 RCON 曾把**命令**当成 auth 包正文发出去（type=3 的正文必须是密码），
      而且**不校验应答**、无条件 `return $true`。真实 Paper 会回 `id=-1` 并断开，
      但在"自己写的假服务器"上完全看不出来 —— 于是 save-off / save-all flush / save-on
      在真机上**从未生效过一次**，脚本却一直以为成功。

    这个回归把两个盲区都堵上：
      假服务器**按真实协议校验** auth 正文（不等于密码就回 -1），
      客户端**必须校验应答**（id 不符/超时/断开都算失败）。

    用例：
      ① 正确密码 + 命令 'save-all flush' ⇒ 成功，且服务端收到的命令就是这条；
      ② 错误密码 ⇒ 必须失败（不是"没抛异常就算成功"）；
      ③ **反向用例**：照老 bug 的写法把「命令」当 auth 正文发 ⇒ 必须失败 ——
         这条如果变绿，说明假服务器又退化回"不校验协议"了；
      ④ 断言假服务器看到的 auth 正文是密码、**不是**命令。

.PARAMETER Port
    假服务器端口；默认自动挑一个空闲口。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\tests\rcon-regression.ps1

.NOTES
    退出码：0 = 全部通过；1 = 有用例失败（会指出是哪条）。
#>
[CmdletBinding()]
param(
    [int]$Port = 0,
    [string]$Password = 'regress-pass'
)

$ErrorActionPreference = 'Stop'
$scriptsDir = Split-Path -Parent $PSScriptRoot
$root = Split-Path -Parent $scriptsDir
. (Join-Path $scriptsDir 'lib/rcon.ps1')

$script:fail = 0
$script:pass = 0
function Ok([string]$name, [string]$detail = '') { $script:pass++; Write-Host "PASS $name $detail" -ForegroundColor Green }
function Bad([string]$name, [string]$detail = '') { $script:fail++; Write-Host "FAIL $name $detail" -ForegroundColor Red }

# 带布尔判定的小助手：ok=true 记 PASS，否则记 FAIL（避免每处都写 if/else）
function Ok2Help([string]$name, [bool]$ok, [string]$detail = '') {
    if ($ok) { Ok $name $detail } else { Bad $name $detail }
}

function Test-PortFree([int]$p) {
    try {
        $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
        $l.Start(); $l.Stop()
        return $true
    } catch { return $false }
}

# ── 挑端口 + 起假服务器 ────────────────────────────────────────────
if ($Port -le 0) {
    $Port = 0
    foreach ($cand in 25599..25620) {
        if (Test-PortFree $cand) { $Port = $cand; break }
    }
    if ($Port -eq 0) { Bad '找到空闲端口' '25599-25620 全被占用'; exit 1 }
}

$logPath = Join-Path $root "tmp/rcon-regression.log"
$logDir = Split-Path -Parent $logPath
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }

$fakeScript = Join-Path $PSScriptRoot 'fake-rcon-server.ps1'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$srv = Start-Process -FilePath $psExe `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$fakeScript`"",
        '-Port', $Port, '-Password', "`"$Password`"", '-LogPath', "`"$logPath`"",
        '-MaxConnections', '8', '-TimeoutSec', '90') `
    -PassThru -WindowStyle Hidden

try {
    # 等假服务器真的开始监听
    $ready = $false
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt 15) {
        if (Test-Path -LiteralPath $logPath) {
            $txt = Get-Content -LiteralPath $logPath -Raw -ErrorAction SilentlyContinue
            if ($txt -match '"listen"') { $ready = $true; break }
        }
        Start-Sleep -Milliseconds 200
    }
    if (-not $ready) { Bad '假 RCON 服务器已启动' "15s 内没看到 listen 记录（端口 $Port）"; exit 1 }
    Ok '假 RCON 服务器已启动' "127.0.0.1:$Port"

    # ── 用例 ①：正确密码 + 命令 ────────────────────────────────────
    $r1 = Invoke-Rcon -Password $Password -Port $Port -Command 'save-all flush' -TimeoutMs 5000
    $okA = $r1.ok -and ($r1.body -match 'Handled:\s*save-all flush')
    Ok2Help '①正确密码+命令 ⇒ 成功并拿到应答' $okA ("ok=$($r1.ok) body=$($r1.body) err=$($r1.error)")

    # ── 用例 ②：错误密码 ⇒ 必须失败 ────────────────────────────────
    $r2 = Invoke-Rcon -Password 'wrong-password' -Port $Port -Command 'save-all flush' -TimeoutMs 5000
    $okB = (-not $r2.ok) -and ($r2.error -match '认证失败')
    Ok2Help '②错误密码 ⇒ 判失败（不能被当成成功）' $okB ("ok=$($r2.ok) err=$($r2.error)")

    # ── 用例 ③：反向 —— 照老 bug 把「命令」当 auth 正文 ────────────
    #    老代码：payload = GetBytes($Command) 然后当作 type=3 的正文发出去
    $buggy = Invoke-Rcon -Password 'save-all flush' -Port $Port -Command 'save-all flush' -TimeoutMs 5000
    $okC = (-not $buggy.ok)
    Ok2Help '③反向：auth 正文写成命令 ⇒ 必须失败（老 bug 的写法）' $okC ("ok=$($buggy.ok) err=$($buggy.error)")

    # ── 用例 ④：服务端看到的 auth 正文是密码，不是命令 ──────────────
    Start-Sleep -Milliseconds 300
    $lines = @(Get-Content -LiteralPath $logPath -ErrorAction SilentlyContinue)
    $authBodies = @()
    foreach ($l in $lines) {
        if ($l -match 'authok|authfail') { continue }
        try { $rec = $l | ConvertFrom-Json } catch { continue }
        if ($rec.kind -ne 'packet') { continue }
        if ($rec.detail -match '^type=3 ') {
            $m = [regex]::Match($rec.detail, 'body=(.*)$')
            if ($m.Success) { $authBodies += $m.Groups[1].Value }
        }
    }
    $sawPassword = @($authBodies | Where-Object { $_ -ceq $Password }).Count -gt 0
    $sawCommandAsAuth = @($authBodies | Where-Object { $_ -eq 'save-all flush' }).Count -gt 0
    Ok2Help '④假服务器收到的 auth 正文是密码（说明协议对）' $sawPassword ("auth 正文样本：" + (($authBodies | Select-Object -First 3) -join ' / '))
    Ok2Help '⑤用例③里 auth 正文确实是命令（证明这条反例真的走到了错误分支）' $sawCommandAsAuth ("共收到 $($authBodies.Count) 个 auth 包")

    # ── 用例 ⑥：无人监听 ⇒ 判失败而不是卡死 ────────────────────────
    $r6 = Invoke-Rcon -Password $Password -Port 1 -Command 'save-all flush' -TimeoutMs 1500
    $okF = (-not $r6.ok)
    Ok2Help '⑥端口没人监听 ⇒ 快速判失败（不卡死）' $okF ("ok=$($r6.ok) err=$($r6.error)")
} finally {
    try { if (-not $srv.HasExited) { $srv.Kill() } } catch { }
}

Write-Host ''
if ($script:fail -eq 0) {
    Write-Host "ALL PASS：$script:pass 项通过（RCON 协议回归）" -ForegroundColor Green
    Write-Host "证据：$logPath"
    exit 0
} else {
    Write-Host "HAS FAILURES：$script:pass 项通过，$script:fail 项失败" -ForegroundColor Red
    Write-Host "证据：$logPath"
    exit 1
}
