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

# ★ R6 #44/#49/#56（2026-11-11）：三条「没成功也报成功」的判据、bot 进游戏判定、
#   「被服务的产物 vs 被校验的产物」比对，全部收进 scripts/lib/panel_guard.ps1。
#   理由：这些判据以前是内联的 Write-Ok，除了真起一个服之外无法验证；而 ops-regression
#   只能 grep 标识符（正是 #56 点名的「文本正则门禁」）。搬到 lib 之后，回归门禁可以
#   **真的 dot-source 并喂假事实**，判据翻回「成功」就会红。
$guardLib = Join-Path $PSScriptRoot 'lib\panel_guard.ps1'
if (-not (Test-Path -LiteralPath $guardLib)) {
    Write-Bad "[错误] 缺少判据库：$guardLib"
    Write-Bad '        修法：从仓库重新检出 scripts/lib/panel_guard.ps1。'
    exit 1
}
. $guardLib

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
#
# ★ R6 #44（2026-11-11）：实现搬到 lib/panel_guard.ps1 的 Wait-BotSpawned ——
#   唯一的行为变化是**超时返回 $false**。原来这里超时也 `return $true` ⇒
#   调用点 `if (-not (Wait-BotSpawned 120)) { exit 1 }` 永远不触发，
#   脚本会在一只没进游戏的 bot 上打印「已启动完成」。
#   现在 spawned / 明确失败 / 超时 三态由 Get-BotSpawnHint 判定，超时按失败收尾。

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
# ★ R6 #7（2026-11-10）：这三条报错以前只报"缺什么"，不说"怎么补" —— 干净 clone 里
#   这三样必然都缺（.gitignore 排除 .tools/ 与 *.jar；server.properties 只跟踪 .example），
#   用户只能自己猜。现在每条都指向唯一供给入口 scripts\provision.ps1。
if (-not $java)               {
    Write-Bad '[错误] 找不到 JDK（.tools\jdk-*\bin\java.exe）'
    Write-Bad '        修法（一次性供给）：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision.ps1 -DryRun'
    Write-Bad '        照它的输出做完再重跑本脚本（说明见 README「从零供给（provision.ps1）」）。'
    exit 1
}
if (-not (Test-Path $node))   { Write-Bad "[错误] 找不到 Node: $node"; exit 1 }
if (-not (Test-Path (Join-Path $root 'server\server.jar'))) {
    Write-Bad '[错误] 找不到 server\server.jar'
    Write-Bad '        修法（一次性供给）：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision.ps1'
    Write-Bad '        它会按 server\.paper-url 下载并按 sha256 校验（离线可用 -JarFile <本地 jar>）。'
    exit 1
}

# ---------- 前置自检：RCON 暴露缓解是否还在（R6 #48）----------
# 「收紧RCON.bat」是一条**不入库、换机即失效**的防火墙规则，之前没有任何脚本检查它：
# 新机器上 25575 明文端口裸奔而没人知道。这里做只读自检（不拦不 WARN，不拦不 exit）：
# 它是"部署硬要求"，缺了明确告知并指向那一条双击动作。
$rconDenyScript = Join-Path $PSScriptRoot 'deny-rcon-25575-in.ps1'
if (Test-Path -LiteralPath $rconDenyScript) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $rconDenyScript -Verify | Out-Null
    $rconState = $LASTEXITCODE
    if ($rconState -eq 0) {
        Write-Ok 'RCON 入站已收紧（防火墙规则 deny-rcon-25575-in 在位且形态正确）'
    } elseif ($rconState -eq 1) {
        Write-Warn2 '[警告] 没有防火墙规则 deny-rcon-25575-in：RCON 25575 对外暴露（server-ip 为空 ⇒ 监听 0.0.0.0）。'
        Write-Warn2 '        修法：双击仓库根的「收紧RCON.bat」（需要一次 UAC），它会验证规则真的生效。'
    } else {
        Write-Warn2 '[警告] 防火墙规则 deny-rcon-25575-in 存在但形态不对（不是 TCP 25575 入站 block / 未启用）。'
        Write-Warn2 '        修法：双击「收紧RCON.bat」重装一次（它是幂等的：先删后加）。'
    }
}

# ---------- 前置自检：凭据 ACL 覆盖面（R6 #55）----------
$aclScript = Join-Path $PSScriptRoot 'harden-credentials-acl.ps1'
if (Test-Path -LiteralPath $aclScript) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $aclScript | Out-Null
    if ($LASTEXITCODE -eq 3) {
        Write-Warn2 '[警告] 有凭据类文件仍是"本机所有用户可读"（体检 exit 3）。'
        Write-Warn2 '        修法：powershell -NoProfile -File scripts\harden-credentials-acl.ps1 -Apply'
    }
}

# ---------- 0) 构建并校验面板产物 ----------
# ★ R6 #44-①（2026-11-11）：原来这里直接 `node vite.js build`，失败只 Write-Warn2
#   「沿用上一次的 dist」，然后照常往下走并打印「已启动完成」—— 改过前端但没构建成功时，
#   服务的是旧 UI 而脚本说成功。现在构建失败 = 启动失败。
# ★ R6 #49（2026-11-11）：更重要的是**校验对象**。mindserver 本机实际服务
#   `web\dist`（候选 ②），而 release.ps1 只验证 `mindcraft\web-dist`。
#   以前这里直接把 vite 输出到 web\dist 且不做任何校验 ⇒ `release.ps1 -VerifyOnly`
#   的 ALL PASS 会被读成「你打开的面板是这个版本」，其实它证明的是另一个目录。
#   现在：构建/同步/打指纹/校验全部走 release.ps1 -SkipDocker（唯一产物写者），
#   再逐文件比对 web\dist 与 mindcraft\web-dist —— 被服务的那份必须就是被校验的那份。
Write-Step '0/4' '构建并校验面板产物（release.ps1 -SkipDocker）...'
$releasePs1 = Join-Path $root 'scripts\release.ps1'
$distIndex = Join-Path $root 'web\dist\index.html'
$shippedDist = Join-Path $root 'mindcraft\web-dist'
if (-not (Test-Path -LiteralPath $releasePs1)) {
    Write-Bad "[错误] 找不到发布脚本：$releasePs1"
    Write-Bad '        修法：从仓库重新检出 scripts/release.ps1（它是产物的唯一写者）。'
    exit 1
}

if ($dryRun) {
    Write-DryRun ('powershell -NoProfile -ExecutionPolicy Bypass -File "' + $releasePs1 + '" -SkipDocker    # 构建→同步→打指纹→校验（唯一产物写者）')
    Write-DryRun ('比对 "' + (Join-Path $root 'web\dist') + '" 与 "' + $shippedDist + '"（被服务的必须就是被校验的）')
} else {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $releasePs1 -SkipDocker
    $buildCode = $LASTEXITCODE
    $buildOutcome = Resolve-BuildOutcome -ExitCode $buildCode -HasDist (Test-Path -LiteralPath $distIndex) -DistPath (Join-Path $root 'web\dist')
    if ($buildOutcome.Action -ne 'ok') {
        Write-Bad ('[错误] ' + $buildOutcome.Message)
        Write-Bad '        修法：单独跑 cd web; npm run build 看完整报错；或跑 scripts\release.ps1 -SkipDocker 看发布链的哪一步失败。'
        Write-Bad '        注意：此时不会启动任何东西 —— 宁可不启动，也不要在"不知道服务的是哪个版本"的状态下说已启动。'
        exit $buildOutcome.ExitCode
    }
    Write-Ok '面板产物已构建并通过发布链校验'

    $drift = @(Get-DistDrift -Left (Join-Path $root 'web\dist') -Right $shippedDist)
    if ($drift.Count -gt 0) {
        Write-Bad '[错误] web\dist 与 mindcraft\web-dist 不一致 —— 被服务的产物不是被校验的产物（#49）'
        foreach ($d in $drift | Select-Object -First 12) { Write-Bad ('        ' + $d) }
        Write-Bad '        修法：跑 scripts\release.ps1（不带 -SkipDocker 也行）把两边重新对齐；不要手工改产物。'
        exit 1
    }
    Write-Ok 'web\dist 与 mindcraft\web-dist 逐文件一致（被服务的就是被校验的那份）'
}

# ---------- 1) Minecraft 服务器 ----------
Write-Step '1/4' 'Minecraft 服务器'
# ★ R6 #44-③（2026-11-11）：原来「25565 有监听」就等于「本项目已在运行」。
#   8080 被别的服务占 ⇒ 面板不是本项目；25565 被别的整合包占 ⇒ 等的是别人的服。
#   现在：监听着还不够，必须**同时**存在本项目的 server.jar 进程（Get-ServerJava 按绝对路径匹配）。
$mcListening = Test-Port 25565
$mcState = Resolve-McPortState -Listening $mcListening -OurJavaPresent ([bool](Get-ServerJava)) -Port 25565
if ($mcState -eq 'ours') {
    Write-Ok '本项目服务端已在运行（25565 已监听，且是本项目的 server.jar），跳过'
} elseif ($mcState -eq 'foreign') {
    Write-Bad '[错误] 25565 已被**别的程序**占用：端口在监听，但找不到本项目的 server\server.jar 进程。'
    Write-Bad '        这不是"已启动"，也不是"本项目在跑"——继续下去只会连到别人的服务器上。'
    Write-Bad '        修法：netstat -ano | findstr :25565 找到 pid；若是别的整合包请先关掉，或改本项目端口。'
    exit 1
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
# ★ R6 #44-③（2026-11-11）：原来「8080 有监听」就等于「面板已在运行」。
#   8080 被别的服务占时，浏览器打开的是别人的页面，而脚本说"已启动完成"。
#   现在：探一次 GET /console，只认本项目 mindserver 的应答
#   （无 token 时它回 401 + "unauthorized: 需要握手 token…"；闸门放开时回 Vue 外壳）。
$panelListening = Test-Port 8080
$panelState = 'free'
if ($panelListening) {
    $probe = Get-PanelProbe -Port 8080
    $panelState = Resolve-PanelPortState -Listening $true -Probe $probe -Port 8080
}
if ($panelState -eq 'ours') {
    Write-Ok '本项目 mindserver 已在运行（8080 应答本项目握手门），跳过'
} elseif ($panelState -eq 'foreign') {
    Write-Bad '[错误] 8080 已被**别的东西**占用：端口在监听，但应答的不是本项目面板。'
    Write-Bad ("        探测结果：HTTP {0} {1}" -f $probe.Status, $(if ($probe.Ok) { '' } else { '（' + $probe.Error + '）' }))
    Write-Bad '        继续下去会在一个陌生页面上说"已启动完成"。请先让出 8080 再重跑。'
    exit 1
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
} elseif (-not (Wait-BotSpawned -Seconds 120 -LogFile $mcOut)) {
    # ★ R6 #44-②（2026-11-11）：这里以前**永远不会**进来（超时也 return $true）。
    #   现在超时/失败都会到这里，并且必须把"服务已在跑、别重复启动"讲清楚。
    Show-Tail $mcOut 20
    Write-Host ''
    Write-Bad '[错误] 启动未确认：节点已起，但 bot 没进游戏（脚本不把这种情况算成功）。'
    Write-Bad '        排查顺序：① logs\mindcraft-console.log 里的报错 ② keys.json 是否有可用 API key'
    Write-Bad '                  ③ 服务器是否真的加载完（logs\server-console.log 有 Done 吗）'
    Write-Host '  [重要] Minecraft 服务端与 Mindserver 已在后台运行（本脚本已启动它们）。' -ForegroundColor Yellow
    Write-Host '         不要重复双击本脚本（会撞端口）。要停止请双击 停止面板.bat。' -ForegroundColor Yellow
    Read-Host '按回车退出'
    exit 1
}

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
