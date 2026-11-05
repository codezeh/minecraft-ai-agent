# Minecraft AI 陪玩面板 —— 一键启动
# 由 启动面板.bat 调起。所有中文都在这里（UTF-8+BOM），cmd 那层只留 ASCII。
#
# 设计要点（都是实测踩出来的）：
#  1. 只看端口不够：Paper 在插件加载前就监听端口，bot 6s 冲进去会被
#     "Took too long to log in" 踢掉 → 必须等日志出现 `Done (xx.xxxs)!`
#  2. 上一个服关服要等 chunk 系统停（实测 10s+），端口关了进程可能还在。
#     抢端口会启动失败 → 启动前先等旧 java 退干净
#  3. 日志全部重定向到文件：弹窗里看不到的错，这里能自己打印出来
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root  = Split-Path -Parent $PSScriptRoot
$node  = 'D:\Node\node.exe'
$panel = 'http://localhost:8080/console'
$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$srvOut = Join-Path $logDir 'server-console.log'
$mcOut  = Join-Path $logDir 'mindcraft-console.log'

function Write-Step($n, $text) { Write-Host "[$n] $text" -ForegroundColor Cyan }
function Write-Ok($text)       { Write-Host "      $text" -ForegroundColor Green }
function Write-Warn2($text)    { Write-Host "      $text" -ForegroundColor Yellow }
function Write-Bad($text)      { Write-Host "      $text" -ForegroundColor Red }

function Test-Port([int]$port) {
    $c = New-Object Net.Sockets.TcpClient
    try { $c.Connect('127.0.0.1', $port); return $true }
    catch { return $false }
    finally { try { $c.Dispose() } catch { } }
}

function Show-Tail([string]$file, [int]$n = 15) {
    if (Test-Path $file) {
        Write-Host "      ---- $file 末尾 ----" -ForegroundColor DarkGray
        Get-Content $file -Tail $n -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
    }
}

# 有没有还在跑的 server.jar 进程
function Get-ServerJava {
    Get-CimInstance Win32_Process -Filter "Name='java.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'server\.jar' }
}

function Wait-Port([int]$port, [int]$seconds, [string]$label) {
    $elapsed = 0
    while ($elapsed -lt $seconds) {
        if (Test-Port $port) { Write-Ok "$label 端口已就绪（${elapsed}s）"; return $true }
        Start-Sleep -Seconds 2
        $elapsed += 2
        Write-Host '.' -NoNewline -ForegroundColor DarkGray
    }
    Write-Host ''
    Write-Bad "[错误] 等了 $seconds 秒 $label 端口还没起"
    return $false
}

# 等 Paper 输出 Done（认本次启动后写过的 latest.log）
function Wait-ServerReady([datetime]$launchedAt, [int]$seconds) {
    $log = Join-Path $root 'server\logs\latest.log'
    $elapsed = 0
    while ($elapsed -lt $seconds) {
        if ($null -eq (Get-ServerJava)) {
            Write-Host ''
            Write-Bad '[错误] 服务器进程已经退出了，没能启动成功'
            Show-Tail $srvOut 20
            return $false
        }
        if (Test-Path $log) {
            $f = Get-Item $log
            if ($f.LastWriteTime -gt $launchedAt) {
                $tail = Get-Content $log -Tail 300 -ErrorAction SilentlyContinue
                if ($tail -match 'Done \([\d.]+s\)!') {
                    Write-Ok "服务器已完全加载（${elapsed}s）"
                    Start-Sleep -Seconds 2
                    return $true
                }
            }
        }
        Start-Sleep -Seconds 2
        $elapsed += 2
        Write-Host '.' -NoNewline -ForegroundColor DarkGray
    }
    Write-Host ''
    Write-Bad "[错误] 等了 $seconds 秒还没看到 Done"
    Show-Tail $srvOut 20
    return $false
}

# 等 bot 真的进游戏（mindcraft 输出 spawned.）
function Wait-BotSpawned([int]$seconds) {
    $elapsed = 0
    while ($elapsed -lt $seconds) {
        if (Test-Path $mcOut) {
            $tail = Get-Content $mcOut -Tail 200 -ErrorAction SilentlyContinue
            if ($tail -match 'spawned\.') { Write-Ok "bot 已进游戏（${elapsed}s）"; return $true }
            if ($tail -match 'not found in keys|exited too quickly') {
                Write-Bad '[错误] bot 启动失败（缺 API key 或进程退出）'
                Show-Tail $mcOut 20
                return $false
            }
        }
        Start-Sleep -Seconds 2
        $elapsed += 2
        Write-Host '.' -NoNewline -ForegroundColor DarkGray
    }
    Write-Host ''
    Write-Warn2 "[提示] 等了 $seconds 秒还没看到 bot 进游戏，先打开面板看看（可能只是模型响应慢）"
    Show-Tail $mcOut 12
    return $true
}

function Find-Java {
    $tools = Join-Path $root '.tools'
    if (Test-Path $tools) {
        foreach ($d in Get-ChildItem $tools -Directory -ErrorAction SilentlyContinue) {
            if ($d.Name -notmatch '^jdk') { continue }
            $j = Join-Path $d.FullName 'bin\java.exe'
            if (Test-Path $j) { return $j }
        }
    }
    return $null
}

Write-Host '============================================================' -ForegroundColor DarkCyan
Write-Host '    Minecraft AI 陪玩面板   一键启动' -ForegroundColor White
Write-Host '============================================================' -ForegroundColor DarkCyan
Write-Host ''

# ---------- 环境检查 ----------
$java = Find-Java
if (-not $java)                { Write-Bad "[错误] 找不到 JDK（.tools\jdk-*\bin\java.exe）"; exit 1 }
if (-not (Test-Path $node))    { Write-Bad "[错误] 找不到 Node: $node"; exit 1 }
if (-not (Test-Path (Join-Path $root 'server\server.jar'))) { Write-Bad '[错误] 找不到 server\server.jar'; exit 1 }

# ---------- 0) 构建面板 ----------
Write-Step '0/4' '构建面板（约 1~2 秒）...'
$vite = Join-Path $root 'web\node_modules\vite\bin\vite.js'
if (-not (Test-Path $vite)) {
    Write-Warn2 '跳过：web\node_modules 未安装（先在 web 目录跑一次 npm install）'
} else {
    Push-Location (Join-Path $root 'web')
    & $node $vite build 2>&1 | Out-Null
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -eq 0) { Write-Ok '面板已构建' }
    else { Write-Warn2 '[警告] 构建失败，将沿用上一次的 dist' }
}

# ---------- 1) Minecraft 服务器 ----------
Write-Step '1/4' 'Minecraft 服务器'
if (Test-Port 25565) {
    Write-Ok '已在运行（25565 已监听），跳过'
} else {
    $stale = Get-ServerJava
    if ($stale) {
        Write-Warn2 "检测到上一个服务器还在关闭中（pid=$($stale.ProcessId)），等它退干净…"
        $w = 0
        while ((Get-ServerJava) -and $w -lt 120) { Start-Sleep -Seconds 2; $w += 2; Write-Host '.' -NoNewline -ForegroundColor DarkGray }
        Write-Host ''
        if (Get-ServerJava) {
            Write-Bad "[错误] 等了 $w 秒旧服务器还没退，请手动关掉它的窗口再试"
            exit 1
        }
        Write-Ok "旧服务器已退出（${w}s）"
    }

    Write-Ok '正在启动（冷启动约 15~40 秒）'
    $launchAt = Get-Date
    Start-Process -FilePath $java `
        -ArgumentList '-Xms1G', '-Xmx2G', '-XX:+UseG1GC', '-jar', 'server.jar', 'nogui' `
        -WorkingDirectory (Join-Path $root 'server') `
        -RedirectStandardOutput $srvOut `
        -RedirectStandardError (Join-Path $logDir 'server-console.err.log') `
        -WindowStyle Hidden | Out-Null
    if (-not (Wait-Port 25565 180 'Minecraft'))  { exit 1 }
    if (-not (Wait-ServerReady $launchAt 300))   { exit 1 }
}

# ---------- 2) mindserver + bot ----------
Write-Step '2/4' 'mindserver + bot'
if (Test-Port 8080) {
    Write-Ok '已在运行（8080 已监听），跳过'
} else {
    Write-Ok '正在启动'
    Start-Process -FilePath $node -ArgumentList 'main.js' `
        -WorkingDirectory (Join-Path $root 'mindcraft') `
        -RedirectStandardOutput $mcOut `
        -RedirectStandardError (Join-Path $logDir 'mindcraft-console.err.log') `
        -WindowStyle Hidden | Out-Null
    if (-not (Wait-Port 8080 90 'mindserver')) { exit 1 }
}

# ---------- 3) 等 bot 进游戏 ----------
Write-Step '3/4' '等她进游戏'
if (-not (Wait-BotSpawned 120)) { exit 1 }

# ---------- 4) 打开面板 ----------
Write-Step '4/4' "打开面板 $panel"
Start-Process $panel | Out-Null

Write-Host ''
Write-Host '------------------------------------------------------------' -ForegroundColor DarkGray
Write-Host '  已启动完成。' -ForegroundColor White
Write-Host ''
Write-Host '  · 停止：双击 停止面板.bat（RCON 优雅关服，不会损坏存档）'
Write-Host "  · 日志：$logDir"
Write-Host '------------------------------------------------------------' -ForegroundColor DarkGray
Write-Host ''
Read-Host '按回车关闭这个窗口（不影响后台运行）' | Out-Null
