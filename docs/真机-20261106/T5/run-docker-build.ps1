# T5 —— OPS-005 真 build 验证脚本（C 步骤）
#
# 作用：在有容器运行时的机器上，一条命令把「`.dockerignore` 修复是否真成立」验到镜像里：
#   1. 真跑 `docker build`（原始输出落盘）
#   2. 起一个容器，在镜像里 `find` / `stat` 逐条查敏感文件是否真的**不在**镜像里
#   3. 对照构建时 "transferring context" 的体积与宿主机实测上下文体积
#      （两者量级一致 ⇒ .dockerignore 确实在 daemon 侧生效，而不只是写在文件里）
#   4. 清理容器与镜像
#
# 硬约束：只报 **路径 / 大小 / 数量**，绝不对任何令牌或密钥文件 `cat`。
#
# 用法（在仓库根 E:\我的世界ai 下）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File docs\真机-20261106\T5\run-docker-build.ps1
#   powershell ... -File ...\run-docker-build.ps1 -DryRun          # 只打印将要执行的命令
#   powershell ... -File ...\run-docker-build.ps1 -KeepImage       # 保留镜像便于人工复查
#
# 退出码：
#   0 = build 成功 **且** 镜像内未发现任何敏感文件（OPS-005 修复成立）
#   1 = 镜像内发现敏感文件（修复不成立）—— 会逐条打印
#   2 = build 失败（构建错误，非安全结论）
#   3 = 本机无可用容器运行时（被环境阻塞，不是修复结论）
#
# 前置：Docker Desktop 需已安装并**已启动**。Windows 上 Docker Desktop 依赖 WSL2 后端，
#       所以还需要先装 WSL：`wsl.exe --install`（管理员）→ 重启 → 启动 Docker Desktop。

[CmdletBinding()]
param(
    [string]$Context  = '',
    [string]$ImageTag = 'mindcraft-t5-verify:latest',
    [string]$OutDir   = '',
    [switch]$KeepImage,
    [switch]$KeepContainer,
    [switch]$DryRun,
    [int]$BuildTimeoutMin = 40
)

$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
if (-not $Context)  { $Context  = (Resolve-Path (Join-Path $here '..\..\..\mindcraft')).Path }
if (-not $OutDir)   { $OutDir   = $here }
$Context = (Resolve-Path -LiteralPath $Context).Path

$stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
$buildLog = Join-Path $OutDir "build-$stamp.log"
$checkLog = Join-Path $OutDir "image-check-$stamp.log"
$summary  = Join-Path $OutDir "build-result-$stamp.json"
$containerName = "t5-verify-$stamp"

function Write-Both {
    param([string]$Text, [string]$LogPath, [switch]$NoNewline)
    if ($NoNewline) { Write-Host -NoNewline $Text } else { Write-Host $Text }
    Add-Content -LiteralPath $LogPath -Value $Text -Encoding utf8
}

# 镜像内要查的敏感路径（与 .dockerignore / check_secret_filenames.mjs 口径对齐）
$sensitiveExact = @(
    '/app/.mindserver-token',
    '/app/keys.json',
    '/app/keys.local.json',
    '/app/.env',
    '/app/.env.local',
    '/app/.env.production',
    '/app/mindserver-token',
    '/app/andy.json'
)
$sensitiveDirs = @('/app/profiles', '/app/bots', '/app/logs', '/app/tmp', '/app/.git', '/app/docs', '/app/tools', '/app/.vscode')
# 按**模式**在整镜像里扫（这才是 *.token 通配有没有漏的真正判据）
$sensitivePatterns = @('*.token', '*.pem', '*.key', '*.p12', '*.pfx', '*.crt', '*.jks',
    'credentials*.json', 'secrets*.json', 'config.local.*', 'id_rsa*', 'id_ed25519*',
    '.env', '.env.*', '.mindserver-token', '.mindserver-token.*', '*.log', 'run-live*')
$mustExist = @('/app/main.js', '/app/settings.js', '/app/package.json', '/app/package-lock.json',
    '/app/src', '/app/services', '/app/tasks', '/app/schematics', '/app/node_modules', '/app/patches')

# ── 0. DryRun：只把命令打出来 ────────────────────────────────
$findExpr = ($sensitivePatterns | ForEach-Object { "-name '$_'" }) -join ' -o '
# 注意：这段要穿过 PowerShell → docker.exe → sh 三层，所以**内部一律用单引号**，
#       不出现任何 `"`，避免 Windows 命令行转义把脚本拆坏（secrets 内容也绝不读）。
$checkScript = @(
    "echo '=== PWD / 顶层清单 ==='"
    'pwd'
    'ls -la /app'
    "echo '=== 文件数与总字节 ==='"
    'find /app -type f | wc -l'
    'du -sb /app'
    "echo '=== 敏感文件（仅路径+大小，绝不打印内容）==='"
    ('find /app -type f \( ' + $findExpr + ' \) -printf ''%p %s\n'' 2>/dev/null | sort')
    "echo '=== 敏感目录 ==='"
    ('for d in ' + ($sensitiveDirs -join ' ') + '; do if [ -e $d ]; then ls -ld $d; else echo ABSENT $d; fi; done')
    "echo '=== 必需文件 ==='"
    ('for f in ' + ($mustExist -join ' ') + '; do if [ -e $f ]; then echo OK $f; else echo MISSING $f; fi; done')
    "echo '=== 整镜像范围内的 *.token / 私钥 ==='"
    ('find / -xdev \( -name ''*.token'' -o -name ''id_rsa*'' -o -name ''id_ed25519*'' -o -name ''*.pem'' -o -name ''*.p12'' \) -printf ''%p %s\n'' 2>/dev/null | sort')
) -join "`n"

$cmds = [ordered]@{
    'docker version'  = 'docker version'
    'docker info'     = 'docker info --format ''{{json .}}'''
    'docker build'    = "docker build --progress=plain --no-cache -t $ImageTag `"$Context`""
    'image inspect'   = "docker image inspect $ImageTag --format '{{.Id}} {{.Size}} {{json .Config.Labels}}'"
    'image check'     = "docker run --rm --name $containerName --entrypoint /bin/sh $ImageTag -c <下面那段 checkScript>"
    'cleanup'         = "docker rm -f $containerName; docker rmi -f $ImageTag"
}

if ($DryRun) {
    Write-Host '── DryRun：将要执行的命令 ──'
    foreach ($k in $cmds.Keys) { Write-Host ("[{0}]`n  {1}`n" -f $k, $cmds[$k]) }
    Write-Host ('上下文目录: {0}' -f $Context)
    Write-Host ('镜像内检查脚本:`n{0}' -f $checkScript)
    exit 0
}

# ── 1. 前置：运行时可用吗 ────────────────────────────────────
$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) {
    Write-Host '✗ 本机 PATH 上没有 docker。先装 Docker Desktop 并启动（Windows 还需 WSL2 后端）。' -ForegroundColor Red
    Write-Host '  安装步骤见 docs/真机-20261106/T5/README.md 的「待跑命令」一节。'
    exit 3
}
$infoProbe = & docker info --format '{{json .ServerVersion}}' 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host '✗ docker CLI 存在但 daemon 连不上（Docker Desktop 未启动？）' -ForegroundColor Red
    Write-Host ($infoProbe | Out-String)
    exit 3
}

"===== T5 真 build 验证 $stamp =====" | Out-File -LiteralPath $buildLog -Encoding utf8
Write-Both ('上下文: ' + $Context) $buildLog
Write-Both ('镜像标签: ' + $ImageTag) $buildLog

# 宿主机侧上下文体积（对照 BuildKit 的 "transferring context"）
$hostCtxBytes = 0
if (Test-Path -LiteralPath (Join-Path $Context '.dockerignore')) {
    $manifestPath = Join-Path $OutDir 'context-manifest.json'
    if (Test-Path -LiteralPath $manifestPath) {
        $m = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $hostCtxBytes = $m.contextSet.totalBytes
        Write-Both ('宿主机实测上下文体积（按 .dockerignore 复算）: {0} B / {1} 个文件' -f $hostCtxBytes, $m.contextSet.fileCount) $buildLog
    }
}

& docker version 2>&1 | Tee-Object -FilePath $buildLog -Append | Out-Host
& docker info --format '{{json .}}' 2>&1 | Tee-Object -FilePath $buildLog -Append | Out-Host

# ── 2. 真 build ──────────────────────────────────────────────
Write-Both '' $buildLog
Write-Both '===== docker build（--progress=plain --no-cache）=====' $buildLog
$buildStart = Get-Date
$buildOut = & docker build --progress=plain --no-cache -t $ImageTag $Context 2>&1
$buildCode = $LASTEXITCODE
$buildOut | Tee-Object -FilePath $buildLog -Append | Out-Host
$buildSec = [math]::Round(((Get-Date) - $buildStart).TotalSeconds, 1)
Write-Both ('docker build exit=' + $buildCode + ' 耗时=' + $buildSec + 's') $buildLog

if ($buildCode -ne 0) {
    Write-Host '✗ docker build 失败（这是构建错误，不是安全结论）' -ForegroundColor Red
    [pscustomobject]@{
        step = 'build'; exitCode = $buildCode; log = $buildLog
        conclusion = 'BUILD-FAILED'
    } | ConvertTo-Json -Depth 5 | Out-File -LiteralPath $summary -Encoding utf8
    exit 2
}

# 从 build 输出里抓 BuildKit 的上下文体积，作为".dockerignore 真的生效"的运行期证据
$ctxLine = ($buildOut | Select-String -Pattern 'transferring context').Line
Write-Both ('BuildKit 上下文传输行: ' + ($ctxLine -join ' | ')) $buildLog

& docker image inspect $ImageTag --format '{{.Id}} {{.Size}} {{json .Config.Labels}}' 2>&1 |
    Tee-Object -FilePath $buildLog -Append | Out-Host

# ── 3. 镜像内敏感文件检查（只 stat，不 cat）──────────────────
"===== 镜像内检查 $stamp =====" | Out-File -LiteralPath $checkLog -Encoding utf8
Write-Host ''
$checkOut = & docker run --rm --name $containerName --entrypoint /bin/sh $ImageTag -c $checkScript 2>&1
$checkCode = $LASTEXITCODE
$checkOut | Tee-Object -FilePath $checkLog -Append | Out-Host

# ── 4. 判定 ──────────────────────────────────────────────────
$text = ($checkOut | Out-String)
$leakLines = @()
foreach ($p in $sensitiveExact) {
    if ($text -match [regex]::Escape($p + ' ')) { $leakLines += "存在: $p" }
}
foreach ($d in $sensitiveDirs) {
    if ($text -match ('(?m)^d.* ' + [regex]::Escape($d) + '$')) { $leakLines += "存在目录: $d" }
}
# 敏感模式段里出现的每一行都算命中（该段以 "=== 敏感文件" 开头，到下一个 "===" 结束）
$inSens = $false
foreach ($line in ($checkOut -split "`r?`n")) {
    if ($line -match '^===\s*敏感文件') { $inSens = $true; continue }
    if ($line -match '^===\s*') { $inSens = $false; continue }
    if ($inSens -and $line.Trim()) { $leakLines += ('模式命中: ' + $line.Trim()) }
}
$missing = @()
foreach ($m in $mustExist) {
    if ($text -match ('(?m)^MISSING ' + [regex]::Escape($m) + '$')) { $missing += $m }
}

$verdict = if ($leakLines.Count -gt 0) { 'LEAK-FOUND（OPS-005 修复不成立）' }
           elseif ($missing.Count -gt 0) { 'IMAGE-INCOMPLETE（没泄漏，但镜像缺必需文件）' }
           else { 'PASS（镜像内无敏感文件，OPS-005 修复成立）' }

Write-Host ''
Write-Host "结论: $verdict" -ForegroundColor $(if ($leakLines.Count -eq 0 -and $missing.Count -eq 0) { 'Green' } else { 'Red' })
if ($leakLines.Count) { $leakLines | ForEach-Object { Write-Host "  ✗ $_" -ForegroundColor Red } }
if ($missing.Count)   { $missing   | ForEach-Object { Write-Host "  ! 缺 $_" -ForegroundColor Yellow } }

[pscustomobject]@{
    step              = 'build+image-check'
    imageTag          = $ImageTag
    context           = $Context
    buildExitCode     = $buildCode
    buildSeconds      = $buildSec
    buildkitCtxLine   = $ctxLine
    hostContextBytes  = $hostCtxBytes
    checkExitCode     = $checkCode
    leaks             = $leakLines
    missingInImage    = $missing
    verdict           = $verdict
    logs              = [pscustomobject]@{ build = $buildLog; imageCheck = $checkLog }
} | ConvertTo-Json -Depth 6 | Out-File -LiteralPath $summary -Encoding utf8
Write-Host "已写出: $summary"

# ── 5. 清理 ──────────────────────────────────────────────────
if ($KeepContainer) { Write-Host "保留容器检查痕迹（--rm 已用，未留容器）" }
if ($KeepImage) { Write-Host "保留镜像: $ImageTag（-KeepImage）" }
else {
    & docker rmi -f $ImageTag 2>&1 | Out-Null
    Write-Host "已清理镜像: $ImageTag"
}

if ($leakLines.Count -gt 0) { exit 1 }
if ($missing.Count -gt 0)   { exit 1 }
exit 0
