#Requires -Version 5.1
<#
.SYNOPSIS
    从零供给：把「干净 clone」变成「能跑的服务端」（R6 #7）。

.DESCRIPTION
    问题（R6 #7，CONFIRMED）：
      干净 clone 里没有跑起来所需的三件硬前置，而且**没有任何代码去读**现成的线索：
        · `.tools/`（JDK）             —— `.gitignore` 排除了（约 300 MB 二进制）
        · `server/server.jar`          —— `*.jar` 被排除
        · `server/server.properties`   —— 只跟踪 `server.properties.example`
        · `server/world*` / `plugins/` —— 被排除（首次启动自动生成，不需要供给）
      于是照 README 走完 clone 之后，双击「启动面板.bat」必然停在
      `[错误] 找不到 JDK（.tools\jdk-*\bin\java.exe）` 或 `[错误] 找不到 server\server.jar`。
      唯一的供给线索是 `server/.paper-url` 里那条 Paper 下载 URL —— 以前**没有任何代码读它**。

    本脚本就是那条「照做即可」的路径。三步都**幂等**，可以反复跑：

      1) JDK 21    优先用 `.tools/jdk*\bin\java.exe`；没有则
                   · `-JdkZip <zip>`   本地 zip 解压到 `.tools/`
                   · `-JdkUrl <url>`   下载 zip 再解压
                   · `-JavaHome <dir>` 把机器上已有的 JDK 21 做成 `.tools/jdk-system` 目录联接
                                       （junction，不复制 300 MB）
                   都没有就打印**具体候选路径**与**照抄即可的命令**（不猜、不瞎下）。

      2) Paper jar 读 `server/.paper-url` ⇒ 落到 `server/server.jar`，并用 URL 段里的
                   **sha256** 校验（PaperMC `fill-data` 的 URL 最后一段就是文件指纹，
                   实测 `server/server.jar` 的 sha256 == `8de7c52c…7f1e`）。
                   `-JarFile <jar>` 可完全离线（从旧机器拷一份）。
                   已存在且指纹一致 ⇒ 直接跳过（**不会**拿新版覆盖你正在跑的那份）；
                   指纹不一致 ⇒ 拒绝，要覆盖必须显式 `-Force`。

      3) 服务端配置 缺失时从 `server/server.properties.example` 生成 `server/server.properties`，
                   并把模板里的 `rcon.password=CHANGE_ME` 换成随机 32 位十六进制口令
                   （`enable-rcon=true` 保留 —— `stop-panel` 的优雅关服链依赖 RCON）。
                   `server/eula.txt` 缺失时补 `eula=true`。
                   已存在则**只体检不修改**（可能正是在跑的那台服）。

    安全与仓库卫生：
      · 口令只写进被 `.gitignore` 排除的 `server/server.properties`，**不打印全文、不入库**；
      · 下载的 `server/server.jar` 与解出的 `.tools/**` 同样被 `.gitignore` 排除 ⇒ 不会污染仓库；
      · 本脚本**不下载大文件进仓库**，只落到被忽略的本地路径。

.PARAMETER DryRun
    只体检 + 打印计划：不下载、不解压、不建 junction、不写任何文件（零副作用）。

.PARAMETER Force
    允许覆盖已存在但指纹不符的 `server/server.jar`（默认拒绝）。

.PARAMETER JarFile
    离线模式：用本地已有的 paper jar，而不是走网络。

.PARAMETER JdkZip
    离线模式：本地 JDK 21 zip（Temurin / OpenJDK 均可），解压到 `.tools/`。

.PARAMETER JdkUrl
    在线模式：JDK zip 的下载地址（不传就不用网络，见 README「从零供给」）。

.PARAMETER JavaHome
    把机器上已有的 JDK 21 目录做成 `.tools/jdk-system` junction（不复制整包）。

.PARAMETER SkipJdk
    只供给 jar 与配置，JDK 由你自己准备（此时本脚本不校验 JDK）。

.EXAMPLE
    # 先体检（零副作用，最适合第一次跑）
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision.ps1 -DryRun

.EXAMPLE
    # 有网络：只差 jar 和配置时
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision.ps1

.EXAMPLE
    # 全离线：自带 JDK zip 与 paper jar
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision.ps1 `
        -JdkZip D:\downloads\OpenJDK21U-jdk_x64_windows_hotspot_21.0.5_11.zip `
        -JarFile D:\old-machine\server.jar

.EXAMPLE
    # 机器上已装 JDK 21，别复制 300 MB，做目录联接
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision.ps1 `
        -JavaHome 'C:\Program Files\Eclipse Adoptium\jdk-21.0.5.11-hotspot'

.NOTES
    退出码：
      0 = 三项前置全部就绪（`-DryRun` 下表示「照此执行即可就绪」）；
      1 = 还有未满足项（已打印可照做的下一步）；
      2 = 参数/环境错误（缺 `server/`、缺 `.paper-url`、给定的 zip/jar 路径不存在等）。
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Force,
    [string]$JarFile = '',
    [string]$JdkZip = '',
    [string]$JdkUrl = '',
    [string]$JavaHome = '',
    [switch]$SkipJdk
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root   = Split-Path -Parent $PSScriptRoot
$server = Join-Path $root 'server'
$tools  = Join-Path $root '.tools'

# ── 输出小工具（与 clone-all.ps1 / release.ps1 风格一致）──────────────
$script:StepNo = 0
function Write-Step([string]$m) {
    $script:StepNo++
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor DarkGray
    Write-Host ('[{0}/3] {1}' -f $script:StepNo, $m) -ForegroundColor Cyan
}
function Write-Ok([string]$m)   { Write-Host "      OK   $m" -ForegroundColor Green }
function Write-Info([string]$m) { Write-Host "           $m" -ForegroundColor DarkGray }
function Write-Warn2([string]$m) { Write-Host "      WARN $m" -ForegroundColor Yellow }
function Write-Bad([string]$m)  { Write-Host "      FAIL $m" -ForegroundColor Red }
function Write-Plan([string]$m) { Write-Host "      [DRYRUN] $m" -ForegroundColor Magenta }

$script:needAction = $false

function Get-ToolsJava {
    if (-not (Test-Path -LiteralPath $tools)) { return $null }
    foreach ($d in @(Get-ChildItem -LiteralPath $tools -Directory -ErrorAction SilentlyContinue)) {
        if ($d.Name -notmatch '^jdk') { continue }
        $j = Join-Path $d.FullName 'bin\java.exe'
        if (Test-Path -LiteralPath $j) { return $j }
    }
    return $null
}

function Get-JavaMajor([string]$exe) {
    # 注意：本脚本是 $ErrorActionPreference='Stop'。java.exe 把 -version 打到 stderr，
    # `2>&1` 会把那条 stderr 变成 ErrorRecord 并**立即中止**（实测：major 恒为 0）。
    # 所以这里临时把 EAP 降回 Continue 取文本，不依赖 try/catch 兜底。
    if (-not $exe -or -not (Test-Path -LiteralPath $exe)) { return 0 }
    $prevEap = $ErrorActionPreference
    $out = ''
    try {
        $ErrorActionPreference = 'Continue'
        $out = (& $exe -version 2>&1 | Out-String)
    }
    catch { $out = '' }
    finally { $ErrorActionPreference = $prevEap }
    if ($out -match 'version "(\d+)(?:\.(\d+))?') {
        $maj = [int]$Matches[1]
        if ($maj -eq 1 -and $Matches[2]) { $maj = [int]$Matches[2] }
        return $maj
    }
    return 0
}

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower()
}

function Find-SystemJdks {
    $cands = New-Object System.Collections.Generic.List[string]
    if ($env:JAVA_HOME) { $cands.Add($env:JAVA_HOME) }
    $cmd = Get-Command java -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Path) {
        # <jdk>\bin\java.exe ⇒ <jdk>
        # $HOME is read-only in PowerShell; do not name it $home
        $jdkHome = Split-Path -Parent (Split-Path -Parent $cmd.Path)
        if ($jdkHome) { $cands.Add($jdkHome) }
    }
    $bases = @(
        (Join-Path $env:ProgramFiles 'Eclipse Adoptium'),
        (Join-Path $env:ProgramFiles 'Java'),
        (Join-Path $env:ProgramFiles 'Microsoft'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Eclipse Adoptium')
    )
    if (${env:ProgramFiles(x86)}) { $bases += (Join-Path ${env:ProgramFiles(x86)} 'Java') }
    foreach ($base in $bases) {
        if (-not $base -or -not (Test-Path -LiteralPath $base)) { continue }
        foreach ($d in @(Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue)) {
            if ($d.Name -match 'jdk') { $cands.Add($d.FullName) }
        }
    }
    return @($cands | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ 'bin\java.exe')) } | Sort-Object -Unique)
}

function New-JavaHomeJunction([string]$Link, [string]$Target) {
    # junction 不复制内容；删除时只能用 Directory::Delete（Remove-Item -Recurse 会进到目标里）
    if (Test-Path -LiteralPath $Link) {
        $item = Get-Item -LiteralPath $Link -Force
        if (-not ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw "已存在同名目录且不是 junction：$Link（请先手动处理，不替你删）"
        }
        [System.IO.Directory]::Delete($Link)
    }
    $prevEap = $ErrorActionPreference
    $out = ''
    try {
        $ErrorActionPreference = 'Continue'
        $out = & cmd.exe /c ('mklink /J "{0}" "{1}"' -f $Link, $Target) 2>&1
    }
    finally { $ErrorActionPreference = $prevEap }
    if ($LASTEXITCODE -ne 0) { throw "mklink /J 失败：$($out -join ' ')" }
}

function Expand-JdkZip([string]$ZipPath) {
    if (-not (Test-Path -LiteralPath $tools)) { New-Item -ItemType Directory -Force -Path $tools | Out-Null }
    Write-Info "解压 $ZipPath → $tools"
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $tools -Force
}

# ════════════════════════════════════════════════════════════════════
Write-Host '============================================================' -ForegroundColor DarkCyan
Write-Host '    从零供给：JDK + Paper jar + server.properties' -ForegroundColor White
Write-Host '    （R6 #7；幂等，可反复跑；-DryRun 零副作用）' -ForegroundColor DarkGray
Write-Host '============================================================' -ForegroundColor DarkCyan

if (-not (Test-Path -LiteralPath $server)) {
    Write-Bad "找不到 server 目录：$server"
    Write-Info '这里应该是仓库根目录下的 scripts/ 旁边。确认 clone 下来的是父仓（而不是只有 mindcraft/）。'
    exit 2
}
if ($DryRun) { Write-Info '模式：DRYRUN（只体检 + 打印计划，不写任何文件）' } else { Write-Info "仓库根：$root" }

# ════════════════════════════════════════════════════════════════════
# 1) JDK 21
# ════════════════════════════════════════════════════════════════════
Write-Step 'JDK 21（.tools\jdk*\bin\java.exe）'

$jdkOk = $false
$java = Get-ToolsJava

if ($java) {
    $maj = Get-JavaMajor $java
    if ($maj -ge 21) {
        Write-Ok "已就绪：$java（Java $maj）"
        $jdkOk = $true
    }
    else {
        Write-Bad "找到 JDK 但版本太低：$java（Java $maj；Paper 1.21 需要 Java ≥ 21）"
        Write-Info '删掉那个 .tools\jdk-* 目录后重跑本脚本（会重新解压/联接正确的 JDK 21）。'
        $script:needAction = $true
    }
}
elseif ($SkipJdk) {
    Write-Warn2 '按 -SkipJdk 跳过：本脚本不校验 JDK（start-panel 仍要求 .tools\jdk*\bin\java.exe）'
}
elseif ($JdkZip) {
    if (-not (Test-Path -LiteralPath $JdkZip)) {
        Write-Bad "给的 -JdkZip 不存在：$JdkZip"
        exit 2
    }
    if ($DryRun) {
        Write-Plan "解压 $JdkZip → $tools（得到一个 .tools\jdk-* 目录）"
        $jdkOk = $true
    }
    else {
        try {
            Expand-JdkZip $JdkZip
            $java = Get-ToolsJava
            $maj = Get-JavaMajor $java
            if ($java -and $maj -ge 21) { Write-Ok "已解压并就绪：$java（Java $maj）"; $jdkOk = $true }
            else {
                Write-Bad '解压完成但仍找不到 .tools\jdk*\bin\java.exe（zip 里可能不是 JDK，或结构不是单层 jdk-* 目录）'
                $script:needAction = $true
            }
        }
        catch {
            Write-Bad "解压失败：$($_.Exception.Message)"
            $script:needAction = $true
        }
    }
}
elseif ($JdkUrl) {
    if ($DryRun) {
        Write-Plan "下载 $JdkUrl"
        Write-Plan "解压到 $tools（得到一个 .tools\jdk-* 目录）"
        $jdkOk = $true
    }
    else {
        $tmp = Join-Path $env:TEMP ('provision-jdk-' + [guid]::NewGuid().ToString('n').Substring(0, 8) + '.zip')
        try {
            Write-Info "下载 $JdkUrl"
            Invoke-WebRequest -Uri $JdkUrl -OutFile $tmp -UseBasicParsing
            Expand-JdkZip $tmp
            $java = Get-ToolsJava
            $maj = Get-JavaMajor $java
            if ($java -and $maj -ge 21) { Write-Ok "已解压并就绪：$java（Java $maj）"; $jdkOk = $true }
            else { Write-Bad '解压完成但仍找不到 .tools\jdk*\bin\java.exe'; $script:needAction = $true }
        }
        catch {
            Write-Bad "下载/解压失败：$($_.Exception.Message)"
            Write-Info '离线环境请改用 -JdkZip（把 JDK 21 的 Windows x64 .zip 拷过来）。'
            $script:needAction = $true
        }
        finally {
            if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
        }
    }
}
elseif ($JavaHome) {
    if (-not (Test-Path -LiteralPath (Join-Path $JavaHome 'bin\java.exe'))) {
        Write-Bad "给的 -JavaHome 不是 JDK 目录（缺 bin\java.exe）：$JavaHome"
        exit 2
    }
    $maj = Get-JavaMajor (Join-Path $JavaHome 'bin\java.exe')
    if ($maj -lt 21) {
        Write-Bad "-JavaHome 指向的 JDK 版本太低：Java $maj（需要 ≥ 21）"
        exit 2
    }
    $link = Join-Path $tools 'jdk-system'
    if ($DryRun) {
        Write-Plan "建目录联接：$link → $JavaHome（不复制文件）"
        $jdkOk = $true
    }
    else {
        try {
            if (-not (Test-Path -LiteralPath $tools)) { New-Item -ItemType Directory -Force -Path $tools | Out-Null }
            New-JavaHomeJunction $link $JavaHome
            $java = Get-ToolsJava
            if ($java) { Write-Ok "已建立 .tools\jdk-system → $JavaHome（Java $maj）"; $jdkOk = $true }
            else { Write-Bad "junction 建好但 .tools\jdk*\bin\java.exe 仍不可见：$link"; $script:needAction = $true }
        }
        catch {
            Write-Bad "建立目录联接失败：$($_.Exception.Message)"
            Write-Info '可直接用 -JdkZip 解压一份 JDK 21，或手动把 JDK 解开到 .tools\jdk-21*。'
            $script:needAction = $true
        }
    }
}
else {
    $cands = @(Find-SystemJdks)
    Write-Warn2 '没有 .tools\jdk*（.gitignore 排除了它，干净 clone 里必然没有）'
    if ($cands.Count -gt 0) {
        Write-Info '本机已有 JDK，挑一个版本 ≥ 21 的做成目录联接即可 —— 照抄其中一条：'
        foreach ($c in $cands) {
            $maj = Get-JavaMajor (Join-Path $c 'bin\java.exe')
            $tag = if ($maj -ge 21) { "Java $maj" } else { "Java $maj（太低，需要 21）" }
            Write-Info ('  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision.ps1 -JavaHome "{0}"   # {1}' -f $c, $tag)
        }
    }
    else {
        Write-Info '本机也没有 JDK 21。两条路任选其一（都需要你提供一次文件/下载）：'
        Write-Info '  A) 下载 JDK 21（Windows x64 的 .zip，Temurin/OpenJDK 都行）：https://adoptium.net/temurin/releases/?version=21'
        Write-Info '     然后：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision.ps1 -JdkZip <下载到的.zip>'
        Write-Info '  B) 已有 JDK 21 在别处：加 -JavaHome "<那个目录>"'
    }
    $script:needAction = $true
}

# ════════════════════════════════════════════════════════════════════
# 2) Paper jar（读 server/.paper-url）
# ════════════════════════════════════════════════════════════════════
Write-Step 'Paper 服务端 jar（server\server.jar）'

$urlFile = Join-Path $server '.paper-url'
if (-not (Test-Path -LiteralPath $urlFile)) {
    Write-Bad "缺少 $urlFile —— 不知道要供给哪个版本的 Paper（这个文件是入库的，别删）"
    exit 2
}
$paperUrl = (Get-Content -LiteralPath $urlFile -Raw).Trim()
if ($paperUrl -notmatch '^https?://') {
    Write-Bad "$urlFile 的内容不是 URL：$paperUrl"
    exit 2
}
# PaperMC fill-data 的 URL 最后一段就是文件 sha256；有它就顺便校验，没有也不硬要求
$expectSha = ''
if ($paperUrl -match '([0-9a-fA-F]{64})') { $expectSha = $Matches[1].ToLower() }
$jarLeaf = 'paper.jar'
try { $jarLeaf = [System.IO.Path]::GetFileName(([uri]$paperUrl).AbsolutePath) } catch { }

$jarTarget = Join-Path $server 'server.jar'
$jarOk = $false
$needDownload = $true

if (Test-Path -LiteralPath $jarTarget) {
    $have = Get-Sha256 $jarTarget
    if (-not $expectSha) {
        Write-Warn2 "server\server.jar 已存在；.paper-url 里没有 sha256 段 ⇒ 无法校验指纹，按已就绪处理"
        Write-Info "  sha256=$have"
        $jarOk = $true
        $needDownload = $false
    }
    elseif ($have -eq $expectSha) {
        Write-Ok "已就绪：server\server.jar（sha256 与 .paper-url 一致：$($expectSha.Substring(0, 16))…）"
        $jarOk = $true
        $needDownload = $false
    }
    elseif ($Force) {
        Write-Warn2 "server\server.jar 指纹不符（期望 $expectSha，实际 $have）—— 按 -Force 重新供给"
    }
    else {
        Write-Bad "server\server.jar 已存在但指纹不符（期望 $expectSha，实际 $have）"
        Write-Info '这可能正是你**在跑**的另一个版本；确认要覆盖再加 -Force。'
        $script:needAction = $true
        $needDownload = $false
    }
}

if ($needDownload) {
    if ($JarFile) {
        if (-not (Test-Path -LiteralPath $JarFile)) {
            Write-Bad "给的 -JarFile 不存在：$JarFile"
            exit 2
        }
        $have = Get-Sha256 $JarFile
        if ($expectSha -and $have -ne $expectSha) {
            Write-Bad "-JarFile 的 sha256 与 .paper-url 不一致（期望 $expectSha，实际 $have）"
            Write-Info '要么换一份正确的 jar，要么确认 .paper-url 与实际要跑的版本一致。'
            $script:needAction = $true
        }
        elseif ($DryRun) {
            Write-Plan "复制 $JarFile → $jarTarget"
            $jarOk = $true
        }
        else {
            Copy-Item -LiteralPath $JarFile -Destination $jarTarget -Force
            Write-Ok "已从本地拷入：$jarTarget（sha256 校验通过）"
            $jarOk = $true
        }
    }
    else {
        if ($DryRun) {
            Write-Plan "下载 $paperUrl"
            Write-Plan "校验 sha256（期望 $expectSha）"
            Write-Plan "落到 $jarTarget（文件名来自 URL：$jarLeaf）"
            $jarOk = $true
        }
        else {
            $tmp = Join-Path $env:TEMP ('provision-paper-' + [guid]::NewGuid().ToString('n').Substring(0, 8) + '.jar')
            try {
                Write-Info "下载 $paperUrl"
                Invoke-WebRequest -Uri $paperUrl -OutFile $tmp -UseBasicParsing
                $have = Get-Sha256 $tmp
                if ($expectSha -and $have -ne $expectSha) {
                    Write-Bad "下载到的文件 sha256 不符（期望 $expectSha，实际 $have）—— 拒绝落盘，可能是镜像/代理改了内容"
                    $script:needAction = $true
                }
                else {
                    Move-Item -LiteralPath $tmp -Destination $jarTarget -Force
                    if ($expectSha) { Write-Ok "已就绪：$jarTarget（来自 $jarLeaf，sha256 校验通过）" }
                    else { Write-Ok "已就绪：$jarTarget（来自 $jarLeaf，未校验 sha256）" }
                    $jarOk = $true
                }
            }
            catch {
                Write-Bad "下载失败：$($_.Exception.Message)"
                Write-Info '离线/被墙时用 -JarFile <本地 jar>（sha256 必须与 .paper-url 一致）。'
                $script:needAction = $true
            }
            finally {
                if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
            }
        }
    }
}

# ════════════════════════════════════════════════════════════════════
# 3) server.properties / eula.txt
# ════════════════════════════════════════════════════════════════════
Write-Step '服务端配置（server\server.properties + eula.txt）'

$propsPath   = Join-Path $server 'server.properties'
$examplePath = Join-Path $server 'server.properties.example'
$eulaPath    = Join-Path $server 'eula.txt'
$cfgOk = $false

function Read-Props([string]$Path) {
    $kv = @{}
    foreach ($line in @(Get-Content -LiteralPath $Path -ErrorAction Stop)) {
        if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
        $i = $line.IndexOf('=')
        $kv[$line.Substring(0, $i).Trim()] = $line.Substring($i + 1).Trim()
    }
    return $kv
}

if (Test-Path -LiteralPath $propsPath) {
    $kv = Read-Props $propsPath
    $rconOn = ($kv['enable-rcon'] -eq 'true')
    $rconPw = [string]$kv['rcon.password']
    if (-not $rconOn) {
        Write-Warn2 'server.properties 已存在，但 enable-rcon 不是 true ⇒ 优雅关服（stop-panel）会失败'
        Write-Info '  修法：把 enable-rcon 改成 true，并给 rcon.password 设一个强口令；或删掉该文件后重跑本脚本'
        $script:needAction = $true
    }
    elseif (-not $rconPw -or $rconPw -eq 'CHANGE_ME') {
        Write-Warn2 'server.properties 已存在，但 rcon.password 还是空的/CHANGE_ME ⇒ RCON 认证会失败'
        Write-Info '  修法：设一个强口令（例如 openssl rand -hex 16 的结果）。本脚本不替你改**已存在**的文件（可能是在跑的服）。'
        $script:needAction = $true
    }
    else {
        Write-Ok '已就绪：server\server.properties（enable-rcon=true 且口令已设置）'
        Write-Info '  （口令内容不打印）'
        $cfgOk = $true
    }
}
elseif (-not (Test-Path -LiteralPath $examplePath)) {
    Write-Bad "既没有 server\server.properties，也没有 server\server.properties.example —— 无法生成配置"
    exit 2
}
else {
    # 生成一份：模板全保留，只把 CHANGE_ME 口令换成随机 32 位十六进制
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $bytes = New-Object byte[] 16
        $rng.GetBytes($bytes)
        $newPw = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    }
    finally { $rng.Dispose() }

    $outLines = New-Object System.Collections.Generic.List[string]
    foreach ($line in @(Get-Content -LiteralPath $examplePath -ErrorAction Stop)) {
        if ($line -match '^\s*rcon\.password\s*=') {
            $outLines.Add("rcon.password=$newPw")
        }
        else {
            $outLines.Add($line)
        }
    }
    if (-not ($outLines | Where-Object { $_ -match '^\s*rcon\.password\s*=' })) {
        $outLines.Add("rcon.password=$newPw")
    }

    if ($DryRun) {
        Write-Plan "从 server.properties.example 生成 $propsPath（模板 $($outLines.Count) 行）"
        Write-Plan 'rcon.password：随机 32 位十六进制（不打印；enable-rcon=true 保留）'
        $cfgOk = $true
    }
    else {
        [System.IO.File]::WriteAllLines($propsPath, $outLines, (New-Object System.Text.UTF8Encoding($false)))
        Write-Ok "已生成：$propsPath（来自 server.properties.example，rcon.password 已换成随机 32 位十六进制）"
        Write-Info '口令只写在被 .gitignore 排除的文件里；要查看：Select-String "rcon.password" server\server.properties'
        $cfgOk = $true
    }
}

# eula.txt：Paper 要求 eula=true，否则首次启动直接退出
if (Test-Path -LiteralPath $eulaPath) {
    $eulaLine = @(Get-Content -LiteralPath $eulaPath -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\s*eula\s*=' })
    if ($eulaLine -and (($eulaLine -join '') -match '=\s*true')) {
        Write-Ok '已就绪：server\eula.txt（eula=true）'
    }
    else {
        Write-Warn2 'server\eula.txt 存在但不是 eula=true —— 服务端会拒绝启动'
        Write-Info '  修法：把该文件改成 eula=true（同意 Minecraft EULA：https://aka.ms/MinecraftEULA）'
        $script:needAction = $true
    }
}
elseif ($DryRun) {
    Write-Plan "写 $eulaPath（eula=true）"
}
else {
    [System.IO.File]::WriteAllText($eulaPath, "eula=true`r`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-Ok "已补写：$eulaPath（eula=true）"
}

# ════════════════════════════════════════════════════════════════════
# 结果
# ════════════════════════════════════════════════════════════════════
Write-Host ''
Write-Host ('=' * 78) -ForegroundColor DarkGray
Write-Host '[结果] 三项前置' -ForegroundColor Cyan

$rows = @(
    [pscustomobject]@{ name = 'JDK 21'; ok = $jdkOk; where = '.tools\jdk*\bin\java.exe' },
    [pscustomobject]@{ name = 'Paper jar'; ok = $jarOk; where = 'server\server.jar' },
    [pscustomobject]@{ name = '服务端配置'; ok = $cfgOk; where = 'server\server.properties + eula.txt' }
)
foreach ($r in $rows) {
    if ($r.ok) { Write-Host ('      OK   {0,-10} {1}' -f $r.name, $r.where) -ForegroundColor Green }
    else { Write-Host ('      FAIL {0,-10} {1}' -f $r.name, $r.where) -ForegroundColor Red }
}

$allOk = ($jdkOk -and $jarOk -and $cfgOk)
Write-Host ''
if ($allOk) {
    if ($DryRun) {
        Write-Host '      DRYRUN：按上面的计划执行即可就绪（本次没有写任何文件）。' -ForegroundColor Magenta
        Write-Host '      去掉 -DryRun 重跑一次来真正落地：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision.ps1' -ForegroundColor Gray
    }
    else {
        Write-Host '      三项前置全部就绪 —— 现在可以启动：' -ForegroundColor Green
        Write-Host '        双击 启动面板.bat' -ForegroundColor Gray
        Write-Host '        （或 powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-panel.ps1）' -ForegroundColor Gray
        Write-Host '      首次启动较慢（Paper 要在 server\ 里生成 libraries/cache/world），属正常。' -ForegroundColor DarkGray
        Write-Host '      这些文件都被 .gitignore 排除：不会进仓库，换机器请重跑本脚本。' -ForegroundColor DarkGray
    }
    exit 0
}

Write-Host '      还有未满足项 —— 按上面每条 FAIL 后面的「修法」处理，然后重跑本脚本。' -ForegroundColor Yellow
Write-Host '      完整说明见 README「从零供给（provision.ps1）」或 docs/audit-r6/fixes/ops.md。' -ForegroundColor Gray
exit 1
