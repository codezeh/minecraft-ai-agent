# Minecraft AI 陪玩面板 —— 一键启动
# 由 启动面板.bat 调起。所有中文都在这里（UTF-8+BOM），cmd 那层只留 ASCII。
#
# 设计要点（都是实测踩出来的）：
#  1. 只看端口不够：Paper 在插件加载前就监听端口，bot 6s 冲进去会被
#     "Took too long to log in" 踢掉 → 必须等日志出现 `Done (xx.xxxs)!`
#  2. 上一个服关服要等 chunk 系统停（实测 10s+），端口关了进程可能还在。
#     抢端口会启动失败 → 启动前先等旧 java 退干净
#  3. 日志全部重定向到文件：弹窗里看不到的错，这里能自己打印出来
#  4. ★ t34：本脚本有演练模式。-DryRun 或 MC_PANEL_NO_SPAWN=1 ⇒ 走完全部前置检查
#     （JDK / Node / server.jar / 旧 java / 端口 / 目录），但**一个进程都不 spawn**
#     （java、node、浏览器都不起），只打印『将要执行的命令 + 工作目录 + 端口』，然后 exit 0。
#     用途：验证面板脚本本身（编码/语法/依赖/路径）而不产生任何副作用。
#     ⚠ 生产启动**不要**带它。用法：
#       powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-panel.ps1 -DryRun
#       $env:MC_PANEL_NO_SPAWN='1'; .\启动面板.bat

param(
    [switch]$DryRun
)

# 演练判定：参数优先，其次环境变量（任一成立即演练）
$dryRun = [bool]$DryRun -or ($env:MC_PANEL_NO_SPAWN -eq '1')

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

# 演练模式专用输出：[DRYRUN] 前缀 + 将要执行的命令/工作目录（便于脚本化 grep 与人工核对）
function Write-DryRun([string]$text) { Write-Host ("      [DRYRUN] " + $text) -ForegroundColor Magenta }

# ★ t34：防误起生产服的自检 —— 在任何 spawn 之前把「谁 / 在哪 / 什么时候」打进输出，
#   让日志本身成为证据链（T32 §8 的要求）。
function Write-SpawnContext([string]$what, [string]$workDir) {
    Write-Host ("      [ctx] " + $what + "   cwd=" + $workDir) -ForegroundColor DarkGray
    Write-Host ("      [ctx] 启动者=" + $env:USERNAME + "   时间=" + (Get-Date).ToString("o")) -ForegroundColor DarkGray
    $latestLog = Join-Path $workDir "logs\latest.log"
    if (Test-Path -LiteralPath $latestLog) {
        $fi = Get-Item -LiteralPath $latestLog
        Write-Host ("      [ctx] 该目录 logs\latest.log 上次写入=" + $fi.LastWriteTime.ToString("o") + "  (" + $fi.Length + " B)") -ForegroundColor DarkGray
    }
}

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

# 有没有还在跑的**本项目** server.jar 进程
#
# ★★★ OPS-009（2026-11-06 深度检查）：原来只匹配 `'server\.jar'` —— 于是**任意目录**下
#   别人的 Minecraft 服务器（另一套整合包、另一个项目）都会被当成本项目的服：
#   报告实测：两个其他目录的 server.jar 都被 Get-ServerJava 匹配到 ⇒
#   面板会一直等那个无关服务器退出（120 秒）然后拒绝启动，而本项目的服其实根本没跑。
#
#   现在按**本项目的 jar 绝对路径**匹配：先把路径规范化（统一分隔符、忽略大小写），
#   再要求命令行里出现 `<root>\server\server.jar` 这个完整路径。
#   参数：-Root 项目根目录（默认 `$root`，函数可能在建好 $root 之前被调用）。
function Get-ServerJava {
    param([string]$ProjectRoot)
    if (-not $ProjectRoot) { $ProjectRoot = $root }
    $jar = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot 'server\server.jar'))
    # 命令行里的路径可能是 `/` 也可能是 `\`，统一成 `\` 再比（大小写不敏感由 -like 负责）
    $needle = $jar.ToLowerInvariant().Replace('/', '\')
    Get-CimInstance Win32_Process -Filter "Name='java.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            if (-not $_.CommandLine) { return $false }
            $cmd = $_.CommandLine.ToLowerInvariant().Replace('/', '\')
            return $cmd.Contains($needle)
        }
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
$distIndex = Join-Path $root 'web\dist\index.html'
# ★ R6 #8（2026-11-10）：缺依赖时**不许**静默跳过、更不许在跳过之后打印"已启动完成"并打开一个 404 的面板。
#   这两种情况必须分开处理：
#     · 已经有 web\dist  → 跳过构建是合理的（沿用上次产物），但要说清"用的是旧产物"
#     · 没有 web\dist    → 面板必然 404，当场停手并给出可照做的命令（此时一个进程都还没起）
if (-not (Test-Path $vite)) {
    if (Test-Path $distIndex) {
        Write-Warn2 '跳过构建：web\node_modules 未安装；沿用已存在的 web\dist'
    } else {
        Write-Bad '[错误] 缺少面板构建依赖，且没有可用的 web\dist —— 面板打开必然 404。'
        Write-Bad '        修法：cd web; npm install   然后重跑本脚本。'
        if (-not $dryRun) { exit 1 }
    }
} else {
    if ($dryRun) {
        Write-DryRun ('& "' + $node + '" "' + $vite + '" build     # cwd=' + (Join-Path $root 'web'))
    } else {
        Push-Location (Join-Path $root 'web')
        & $node $vite build 2>&1 | Out-Null
        $code = $LASTEXITCODE
        Pop-Location
        if ($code -eq 0) { Write-Ok '面板已构建' }
        elseif (Test-Path $distIndex) { Write-Warn2 '[警告] 构建失败，沿用上一次的 dist' }
        else {
            Write-Bad '[错误] 面板构建失败，且没有可用的 web\dist —— 面板打开必然 404。'
            Write-Bad '        先单独跑 cd web; npm run build 看详细报错，修好再重跑本脚本。'
            exit 1
        }
    }
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

    $srvDir = Join-Path $root 'server'
    Write-SpawnContext '将启动 Minecraft 服务端' $srvDir
    if ($dryRun) {
        Write-Ok '[DRYRUN] 本应启动（已短路，不会 spawn）'
        Write-DryRun ('Start-Process -FilePath "' + $java + '" -ArgumentList "-Xms1G","-Xmx2G","-XX:+UseG1GC","-jar","server.jar","nogui" -WorkingDirectory "' + $srvDir + '" -RedirectStandardOutput "' + $srvOut + '" -WindowStyle Hidden')
        Write-DryRun ('端口：25565（RCON 25575）')
    } else {
    Write-Ok '正在启动（冷启动约 15~40 秒）'
    $launchAt = Get-Date
    Start-Process -FilePath $java `
        -ArgumentList '-Xms1G', '-Xmx2G', '-XX:+UseG1GC', '-jar', 'server.jar', 'nogui' `
        -WorkingDirectory $srvDir `
        -RedirectStandardOutput $srvOut `
        -RedirectStandardError (Join-Path $logDir 'server-console.err.log') `
        -WindowStyle Hidden | Out-Null
    if (-not (Wait-Port 25565 180 'Minecraft'))  { exit 1 }
    if (-not (Wait-ServerReady $launchAt 300))   { exit 1 }
    }
}

# ---------- 2) mindserver + bot ----------
Write-Step '2/4' 'mindserver + bot'
if (Test-Port 8080) {
    Write-Ok '已在运行（8080 已监听），跳过'
} else {
    # ★ F-REG-004（2026-11-06）：**启动前预检 mindcraft\node_modules**。
    #
    # 原来 0/4 那段只检查了 web/node_modules，对 **mindcraft/node_modules 零预检**。
    # 缺依赖时的实际行为：`node main.js` 立刻因 ERR_MODULE_NOT_FOUND 死掉，
    # 而脚本还傻等 `Wait-Port 8080` **空耗 90 秒**再 exit 1，日志只会说"mindserver 没起来"，
    # 把人往"端口冲突/服务异常"方向带 —— 真正原因是"依赖没装"。
    # 现在：先探；缺了就按与 start.bat 一致的策略兜底（有 lock 走 npm ci，无 lock 明确告警不硬装）。
    $mcDir = Join-Path $root 'mindcraft'
    $mcModules = Join-Path $mcDir 'node_modules'
    if (-not (Test-Path $mcModules)) {
        Write-Warn2 '[预检] mindcraft\node_modules 不存在 —— mindserver 起不来（否则会空等 90 秒后失败）。'
        $mcLock = Join-Path $mcDir 'package-lock.json'
        if (Test-Path $mcLock) {
            $npmCli = Join-Path (Split-Path -Parent $node) 'node_modules\npm\bin\npm-cli.js'
            if (-not (Test-Path $npmCli)) {
                Write-Bad "[错误] 找不到 npm CLI：$npmCli"
                Write-Bad '        请到 mindcraft 目录手动执行：npm ci（不要加 --ignore-scripts，会静默丢掉 patches/）'
                Read-Host '按回车退出'
                exit 1
            }
            Write-Ok '检测到 package-lock.json，正在 npm ci（严格按 lock，可能需要几分钟）...'
            Push-Location $mcDir
            try { & $node $npmCli ci 2>&1 | Out-Null; $ciCode = $LASTEXITCODE }
            catch { $ciCode = 1 }
            finally { Pop-Location }
            if ($ciCode -ne 0) {
                Write-Bad '[错误] npm ci 失败。请到 mindcraft 目录手动执行：npm ci'
                Write-Bad '        然后重跑本脚本。不要用 --ignore-scripts，它会静默丢掉 patches/。'
                Read-Host '按回车退出'
                exit 1
            }
            Write-Ok 'npm ci 完成'
        } else {
            Write-Bad '[错误] mindcraft\node_modules 缺失，且没有 package-lock.json，无法按 lock 严格安装。'
            Write-Bad '        请到 mindcraft 目录手动执行 npm install，并确认 patches/ 已套用后再重跑。'
            Read-Host '按回车退出'
            exit 1
        }
    }
    Write-SpawnContext '将启动 mindserver（node main.js）' $mcDir
    if ($dryRun) {
        Write-Ok '[DRYRUN] 本应启动（已短路，不会 spawn）'
        Write-DryRun ('Start-Process -FilePath "' + $node + '" -ArgumentList "main.js" -WorkingDirectory "' + $mcDir + '" -RedirectStandardOutput "' + $mcOut + '" -WindowStyle Hidden')
        Write-DryRun ('端口：8080（面板 /console）')
    } else {
    Write-Ok '正在启动'
    Start-Process -FilePath $node -ArgumentList 'main.js' `
        -WorkingDirectory $mcDir `
        -RedirectStandardOutput $mcOut `
        -RedirectStandardError (Join-Path $logDir 'mindcraft-console.err.log') `
        -WindowStyle Hidden | Out-Null
    if (-not (Wait-Port 8080 90 'mindserver')) { exit 1 }
    }
}

# ---------- 3) 等 bot 进游戏 ----------
Write-Step '3/4' '等她进游戏'
if ($dryRun) {
    Write-DryRun '本应等待 bot 进游戏（Wait-BotSpawned 120s，已跳过）'
} elseif (-not (Wait-BotSpawned 120)) { exit 1 }

# ★ t34：演练到这里收尾。后面的 token 逻辑依赖 mindserver 真的写出 token 文件，
#   演练没起服必然取不到 token —— 若继续往下走只会以 exit 1 结束，那就失去演练意义了。
if ($dryRun) {
    Write-Step '4/4' '打开面板（演练：不打开浏览器）'
    Write-DryRun ('Start-Process ' + $panel + '?token=<运行时从 mindcraft\.mindserver-token 读取>')
    Write-Host ''
    Write-Host '------------------------------------------------------------' -ForegroundColor DarkGray
    Write-Host '  [DRYRUN] 演练完成：前置检查全部通过，未启动任何进程、未打开浏览器。' -ForegroundColor Green
    Write-Host '  生产启动请去掉 -DryRun（并确保没有设 MC_PANEL_NO_SPAWN=1）。' -ForegroundColor DarkGray
    Write-Host '------------------------------------------------------------' -ForegroundColor DarkGray
    exit 0
}

# ---------- 4) 打开面板 ----------
# F-SEC-205（2026-11-06）：token 不再打印进日志，改从 mindcraft/.mindserver-token 读。
# 顺带修一个既有缺口：原来打开的是干净的 /console（无 ?token=），socket 握手会被
# io.use(makeHandshakeGate) 拒掉 ⇒ 面板连不上。现在带上 token，浏览器会拿到 HttpOnly cookie。
# ★ F-WEB-201 P0（复核席实测发现的确定白屏路径，captain 补修）：
#   HTTP 层现在也要 token。若这里拿不到 token 却照样打开裸 /console，
#   浏览器只会显示一行 "unauthorized…" 纯文本 —— 看起来像服务器坏了，比打不开更糟。
#   另：token 文件由 mindserver 启动时写出，与这里是时序竞争，必须重试。
$tokenFile = Join-Path $root 'mindcraft/.mindserver-token'
$tok = $null
for ($i = 0; $i -lt 20 -and -not $tok; $i++) {
    if (Test-Path $tokenFile) {
        $raw = (Get-Content $tokenFile -Raw)
        # writeFileSync 不是原子的，可能读到半截 —— 用定长做硬判据
        # （crypto.randomUUID() 恒为 36 字符，零成本的决定性判断）
        if ($raw) { $t = $raw.Trim(); if ($t.Length -eq 36) { $tok = $t } }
    }
    if (-not $tok) { Start-Sleep -Milliseconds 500 }
}
if (-not $tok) {
    Write-Host ''
    Write-Host '  [错误] 拿不到握手 token，因此**没有**打开面板（打开也只会看到 unauthorized）。' -ForegroundColor Red
    Write-Host "         期望位置：$tokenFile" -ForegroundColor Yellow
    Write-Host '         常见原因：mindserver 未能写出该文件（权限或工作目录不对），或它还没起来。' -ForegroundColor Yellow
    Write-Host '         排查：看日志里有没有「写 .mindserver-token 失败」（F-RT-002 起该开关在重定向下会被忽略）。' -ForegroundColor Yellow
    Write-Host ''
    # ★ 复核席指出的必改项：token 块在脚本最后，此时 java 与 node 都已 Start-Process 起来。
    #   Start-Process 起的是独立进程，父脚本 exit 带不走它们 ⇒ 用户看到红字会**再双击一次**，
    #   第二次 java 撞 25565、第二次 node 撞 8080 ⇒ 双开。必须明确告知"服务已在跑、别重复启动"。
    Write-Host '  [重要] Minecraft 服务端与 Mindserver 已在后台运行（本脚本已启动它们）。' -ForegroundColor Yellow
    Write-Host '         不要重复双击本脚本（会撞端口）。要停止请双击 停止面板.bat（RCON 优雅关服，不会损坏存档）。' -ForegroundColor Yellow
    Read-Host '按回车退出'
    exit 1
}
# ★ OPS-001（2026-11-06 深度检查）：这里原来用的是不带花括号的 $panel 紧跟 ?token。
#   PowerShell 把 `?` 当成变量名的一部分 ⇒ 整段展开成 `=DUMMY_ONLY`（实测），
#   于是浏览器打开的是一个相对地址，进不了控制台 —— 服务其实已经起来了，
#   用户只看到"打不开面板"。改成 ${panel} 显式划定变量边界。
$panelUrl = "${panel}?token=$tok"
Write-Step '4/4' "打开面板"
if ($dryRun) { Write-DryRun ('将打开浏览器：' + $panelUrl) } else { Start-Process $panelUrl | Out-Null }

Write-Host ''
Write-Host '------------------------------------------------------------' -ForegroundColor DarkGray
Write-Host '  已启动完成。' -ForegroundColor White
Write-Host ''
Write-Host '  · 停止：双击 停止面板.bat（RCON 优雅关服，不会损坏存档）'
Write-Host "  · 日志：$logDir"
Write-Host '------------------------------------------------------------' -ForegroundColor DarkGray
Write-Host ''
Read-Host '按回车关闭这个窗口（不影响后台运行）' | Out-Null
