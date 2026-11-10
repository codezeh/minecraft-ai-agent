#Requires -Version 5.1
<#
.SYNOPSIS
    一条命令把「父仓 + mindcraft 子仓」一起拉起来，并在结束时给出可验证的下一步。

.DESCRIPTION
    背景（第五轮审计 R5-004）：
      父仓 `.gitignore:13` 排除了 `/mindcraft/`（因为子仓自带 .git，硬纳进来会变成伪子模块），
      于是**只 clone 父仓 = 拿到一堆控制脚本 + 前端源码，但没有业务代码**，
      新机器上跑不起来。以前这件事只写在 README 里靠人记，漏一步的报错是运行期
      "找不到 main.js / 找不到 mindserver"这种毫无指向性的错误。

    本脚本把这件事变成一条可验证的命令：
      1. 建目标目录（已存在且非空则拒绝，绝不覆盖）
      2. clone 父仓
      3. **显式检查**父仓克隆里有没有 `mindcraft/`（正常情况下没有 —— 这就是 R5-004 的用户体感），
         有则说明父仓把它当 gitlink 收了，给出提示
      4. clone mindcraft 到 `<Dest>/mindcraft`
      5. 校验两个仓都存在且是 git 仓库、HEAD 短哈希与 ref 一致
      6. 打印后续命令（`scripts/release.ps1 -VerifyOnly` 等）

    `-LocalSource` 模式：从**本机现有仓库路径** clone（`git clone <本地路径>`），
    这样在"没有远端、只有本地两棵树"的情况下也能真实跑通验证。

.PARAMETER ParentUrl
    父仓地址。`-LocalSource` 时省略则自动取本脚本所在仓库的根目录。

.PARAMETER MindcraftUrl
    mindcraft 仓地址。`-LocalSource` 时省略则自动取 `<父仓根>/mindcraft`。

.PARAMETER Dest
    目标目录（父仓将被 clone 到这里，子仓落到 `<Dest>/mindcraft`）。必填。

.PARAMETER Ref
    可选。两个仓都检出这个 ref（分支/标签/提交）。不传则用各自默认分支。
    若某个仓里不存在该 ref，脚本报错退出，不做半吊子检出。

.PARAMETER LocalSource
    从本机路径 clone（等价于 `git clone <路径>`）。此时 ParentUrl/MindcraftUrl
    可以是路径，也可以省略（自动推断）。

.EXAMPLE
    # 本机两棵树 → 模拟"新机器"干净检出（推荐用于验证）
    pwsh scripts/clone-all.ps1 -LocalSource -Dest tmp/r5-bootstrap/repo

.EXAMPLE
    # 有远端时的正常用法
    pwsh scripts/clone-all.ps1 -ParentUrl git@host:me/parent.git `
        -MindcraftUrl git@github.com:me/minecraft-ai-agent.git -Dest D:\repo

.EXAMPLE
    # 固定到某个提交
    pwsh scripts/clone-all.ps1 -LocalSource -Dest tmp/x -Ref 33b4327

.NOTES
    退出码：0 = 两个仓都就位且校验通过；1 = 任一步失败（消息里写明失败点与修复动作）。
    不推送、不配置远端、不修改任何源仓库。
#>
[CmdletBinding()]
param(
    [string]$ParentUrl = '',
    [string]$MindcraftUrl = '',
    [Parameter(Mandatory = $true)][string]$Dest = '',
    [string]$Ref = '',
    [switch]$LocalSource
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ──────────────────────────────────────────────────────────────
# 输出小工具（与 scripts/release.ps1 的风格保持一致）
# ──────────────────────────────────────────────────────────────
$script:StepNo = 0
function Write-Step {
    param([string]$Message)
    $script:StepNo++
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor DarkGray
    Write-Host ('[{0}] {1}' -f $script:StepNo, $Message) -ForegroundColor Cyan
    Write-Host ('=' * 78) -ForegroundColor DarkGray
}
function Write-Ok    { param([string]$Message) Write-Host ('  PASS  ' + $Message) -ForegroundColor Green }
function Write-Info2 { param([string]$Message) Write-Host ('  INFO  ' + $Message) -ForegroundColor Gray }
function Write-Warn2 { param([string]$Message) Write-Host ('  WARN  ' + $Message) -ForegroundColor Yellow }
function Stop-Bootstrap {
    param([string]$Message, [string]$Fix = '')
    Write-Host ''
    Write-Host ('  FAIL  ' + $Message) -ForegroundColor Red
    if ($Fix) { Write-Host ('        修复：' + $Fix) -ForegroundColor Yellow }
    Write-Host ''
    exit 1
}

# 执行 git 并返回输出；失败抛错（由调用方决定是 fatal 还是可容忍）
function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$WorkDir = ''
    )
    $prev = $PWD
    # 关键：$ErrorActionPreference='Stop' 时，原生命令写到 stderr 的内容会被包成
    # NativeCommandError 并**终止脚本**（而不是让我们自己判断退出码）。
    # 这里局部放宽成 Continue，把 stderr 当普通文本收集，失败由调用方按 ExitCode 处理。
    $prevEap = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        if ($WorkDir) { Set-Location -LiteralPath $WorkDir }
        $out = & git @Arguments 2>&1
        $code = $LASTEXITCODE
    }
    finally {
        if ($WorkDir) { Set-Location -LiteralPath $prev }
        $ErrorActionPreference = $prevEap
    }
    return [pscustomobject]@{
        ExitCode = $code
        # 过滤掉 PowerShell 把 stderr 包成 ErrorRecord 时产生的类型名噪声行
        Output = (($out | ForEach-Object { "$_" } | Where-Object { $_ -notmatch '^System\.Management\.Automation\.\w+Exception$' }) -join "`n").Trim()
    }
}

function Resolve-FullPath {
    param([string]$Path, [string]$Base = '')
    if ([System.IO.Path]::IsPathRooted($Path)) { return [System.IO.Path]::GetFullPath($Path) }
    if ($Base) { return [System.IO.Path]::GetFullPath((Join-Path $Base $Path)) }
    return [System.IO.Path]::GetFullPath($Path)
}

function Get-RepoIdentity {
    param([string]$RepoPath)
    $head = Invoke-Git -Arguments @('rev-parse', 'HEAD') -WorkDir $RepoPath
    if ($head.ExitCode -ne 0) { return $null }
    $short = Invoke-Git -Arguments @('rev-parse', '--short', 'HEAD') -WorkDir $RepoPath
    $subj = Invoke-Git -Arguments @('log', '-1', '--format=%s') -WorkDir $RepoPath
    $br = Invoke-Git -Arguments @('rev-parse', '--abbrev-ref', 'HEAD') -WorkDir $RepoPath
    $count = Invoke-Git -Arguments @('rev-list', '--count', 'HEAD') -WorkDir $RepoPath
    return [pscustomobject]@{
        Head  = $head.Output
        Short = $short.Output
        Subject = $subj.Output
        Branch = $br.Output
        Commits = $count.Output
    }
}

# ──────────────────────────────────────────────────────────────
# 0. 前置：git 可用 + 参数推断
# ──────────────────────────────────────────────────────────────
Write-Step '环境前置：git 可用性与参数解析'

$gv = Invoke-Git -Arguments @('--version')
if ($gv.ExitCode -ne 0) {
    Stop-Bootstrap 'git 不可用（PATH 里找不到 git）。' '先装 Git for Windows，或在能跑 git 的终端里执行。'
}
Write-Ok ('git ' + ($gv.Output -replace '^git version ', ''))

# 脚本自身所在仓库根（用于 -LocalSource 自动推断）
$ScriptDir = $PSScriptRoot
$SelfRepoRoot = ''
if ($ScriptDir) {
    $r = Invoke-Git -Arguments @('rev-parse', '--show-toplevel') -WorkDir $ScriptDir
    if ($r.ExitCode -eq 0) { $SelfRepoRoot = $r.Output }
}

if ($LocalSource) {
    if (-not $ParentUrl) {
        if (-not $SelfRepoRoot) {
            Stop-Bootstrap '-LocalSource 需要能定位本机父仓，但本脚本不在 git 仓库里。' '显式传 -ParentUrl <本机父仓路径>。'
        }
        $ParentUrl = $SelfRepoRoot
    }
    if (-not $MindcraftUrl) {
        $MindcraftUrl = Join-Path $ParentUrl 'mindcraft'
    }
    Write-Info2 ('-LocalSource：父仓 ← ' + $ParentUrl)
    Write-Info2 ('-LocalSource：子仓 ← ' + $MindcraftUrl)
}

if (-not $ParentUrl) { Stop-Bootstrap '缺少 -ParentUrl。' '传 -ParentUrl <url或路径>，或加 -LocalSource 自动推断。' }
if (-not $MindcraftUrl) { Stop-Bootstrap '缺少 -MindcraftUrl。' '传 -MindcraftUrl <url或路径>，或加 -LocalSource 自动推断。' }

# -LocalSource 时，被 clone 的路径必须真实存在（否则 git clone 会给出更难懂的错误）
if ($LocalSource) {
    foreach ($p in @($ParentUrl, $MindcraftUrl)) {
        if (-not (Test-Path -LiteralPath $p)) {
            Stop-Bootstrap ('-LocalSource 指定的路径不存在：' + $p) '确认本机两棵树的位置；子仓通常是 <父仓根>/mindcraft。'
        }
        $chk = Invoke-Git -Arguments @('rev-parse', '--git-dir') -WorkDir $p
        if ($chk.ExitCode -ne 0) {
            Stop-Bootstrap ('-LocalSource 指定的路径不是 git 仓库：' + $p) '父仓与子仓都必须是 git 仓库（子仓 mindcraft 自带 .git）。'
        }
    }
}

$DestFull = Resolve-FullPath -Path $Dest
Write-Info2 ('目标目录：' + $DestFull)
if ($Ref) { Write-Info2 ('目标 ref：' + $Ref) } else { Write-Info2 '目标 ref：（各仓默认分支）' }

# ──────────────────────────────────────────────────────────────
# 1. 建立目标目录（绝不覆盖已有内容）
# ──────────────────────────────────────────────────────────────
Write-Step '建立目标目录（已存在且非空则拒绝，绝不覆盖）'

if (Test-Path -LiteralPath $DestFull) {
    $existing = @(Get-ChildItem -LiteralPath $DestFull -Force -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0) {
        Stop-Bootstrap ('目标目录已存在且非空：' + $DestFull) '换一个 -Dest，或先自行清理该目录（脚本不替你删东西）。'
    }
    Write-Info2 '目标目录已存在但为空，继续。'
}
else {
    New-Item -ItemType Directory -Path $DestFull -Force | Out-Null
    Write-Ok ('已创建 ' + $DestFull)
}

$CloneArgs = @('clone', '--quiet')
if ($LocalSource) { $CloneArgs += '--no-hardlinks' }

# ──────────────────────────────────────────────────────────────
# 2. clone 父仓
# ──────────────────────────────────────────────────────────────
Write-Step 'clone 父仓'

$r = Invoke-Git -Arguments ($CloneArgs + @($ParentUrl, $DestFull))
if ($r.ExitCode -ne 0) {
    Stop-Bootstrap ('clone 父仓失败：' + $ParentUrl + "`n" + $r.Output) '检查地址/路径与网络；-LocalSource 时确认该路径是 git 仓库。'
}
Write-Ok ('父仓已 clone 到 ' + $DestFull)

# ──────────────────────────────────────────────────────────────
# 3. 关键检查：父仓里有没有 mindcraft/（R5-004 的用户体感）
# ──────────────────────────────────────────────────────────────
Write-Step '检查父仓克隆里是否自带 mindcraft/（这就是 R5-004 的坑）'

$MindcraftDir = Join-Path $DestFull 'mindcraft'
$parentHasMindcraft = Test-Path -LiteralPath $MindcraftDir

if ($parentHasMindcraft) {
    $inner = @(Get-ChildItem -LiteralPath $MindcraftDir -Force -ErrorAction SilentlyContinue)
    if ($inner.Count -eq 0) {
        Write-Warn2 '父仓克隆里存在 mindcraft/ 但它是**空目录**（git 不跟踪空目录，通常是 .gitignore 的残留效果）。'
        Write-Warn2 '这不是可用的子仓 —— 下面会把它当"未就位"，继续单独 clone 子仓。'
        $parentHasMindcraft = $false
        Remove-Item -LiteralPath $MindcraftDir -Force -ErrorAction SilentlyContinue
    }
    else {
        $isGit = Invoke-Git -Arguments @('rev-parse', '--git-dir') -WorkDir $MindcraftDir
        if ($isGit.ExitCode -eq 0) {
            Write-Warn2 '父仓克隆里**已经带了** mindcraft/ 且是 git 仓库 —— 说明父仓把它当 gitlink/子模块收了。'
            Write-Warn2 '本脚本会跳过第 2 次 clone（避免嵌套覆盖）。若你不确定，清空目标目录重跑。'
        }
        else {
            Write-Warn2 '父仓克隆里存在 mindcraft/，但它不是 git 仓库（多半是残留的源码副本）。'
            Write-Warn2 '为避免"半新半旧"的混淆，本脚本将用一个干净 clone 覆盖它。'
            Remove-Item -LiteralPath $MindcraftDir -Recurse -Force -ErrorAction SilentlyContinue
            $parentHasMindcraft = $false
        }
    }
}

if (-not $parentHasMindcraft) {
    Write-Info2 '父仓克隆里没有可用的 mindcraft/ —— 符合预期（父仓 .gitignore:13 排除了 /mindcraft/）。'
    Write-Info2 '→ 只 clone 父仓 = 有控制脚本、没有业务代码，跑不起来。这一步必须补，下面补。'
}

# ──────────────────────────────────────────────────────────────
# 4. clone 子仓到 <Dest>/mindcraft
# ──────────────────────────────────────────────────────────────
Write-Step 'clone mindcraft 子仓到 <Dest>/mindcraft'

if ($parentHasMindcraft) {
    Write-Info2 '父仓已自带 mindcraft/，跳过本次 clone。'
}
else {
    $r = Invoke-Git -Arguments ($CloneArgs + @($MindcraftUrl, $MindcraftDir))
    if ($r.ExitCode -ne 0) {
        # git clone 失败时会**留下一个只有 .git 的残留目录**，如果不清理，
        # 下一次跑会误以为"父仓自带 mindcraft/"。先清掉再报错。
        if (Test-Path -LiteralPath $MindcraftDir) {
            Remove-Item -LiteralPath $MindcraftDir -Recurse -Force -ErrorAction SilentlyContinue
            Write-Info2 '已清理 clone 失败留下的空壳目录 mindcraft/（只含 .git，不是可用仓库）'
        }
        # 半成品状态的明确报错（R5-004 的核心）
        Stop-Bootstrap `
            ("子仓 clone 失败，当前处于**半成品状态**：父仓已就位（" + $DestFull + "），但 " + $MindcraftDir + " 缺失/不可用，这样跑不起来。`n" + $r.Output) `
            ('补跑：git clone ' + $MindcraftUrl + ' "' + $MindcraftDir + '"；或清空 ' + $DestFull + ' 后重跑本脚本。')
    }
    Write-Ok ('子仓已 clone 到 ' + $MindcraftDir)
}

# ──────────────────────────────────────────────────────────────
# 5. 可选：切到指定 ref（两个仓都切，任何一个失败即整体失败）
# ──────────────────────────────────────────────────────────────
if ($Ref) {
    Write-Step ('检出指定 ref：' + $Ref)
    foreach ($pair in @(@{ Name = '父仓'; Path = $DestFull }, @{ Name = '子仓'; Path = $MindcraftDir })) {
        $target = $Ref
        $has = Invoke-Git -Arguments @('rev-parse', '--verify', '--quiet', ($target + '^{commit}')) -WorkDir $pair.Path
        if ($has.ExitCode -ne 0) {
            # 本地分支/未推送的分支不会随 clone 过来；先试远端跟踪分支，再试 fetch 一次
            $remoteCandidate = 'origin/' + $Ref
            $hasR = Invoke-Git -Arguments @('rev-parse', '--verify', '--quiet', ($remoteCandidate + '^{commit}')) -WorkDir $pair.Path
            if ($hasR.ExitCode -eq 0) {
                $target = $remoteCandidate
                $has = $hasR
            }
            else {
                $f = Invoke-Git -Arguments @('fetch', '--quiet', 'origin', $Ref) -WorkDir $pair.Path
                if ($f.ExitCode -eq 0) {
                    $target = 'FETCH_HEAD'
                    $has = Invoke-Git -Arguments @('rev-parse', '--verify', '--quiet', ($target + '^{commit}')) -WorkDir $pair.Path
                }
            }
        }
        if ($has.ExitCode -ne 0) {
            Stop-Bootstrap `
                ('[' + $pair.Name + '] 里不存在 ref：' + $Ref + '（本地分支/未推送的提交不会随 clone 过来）') `
                ('确认该 ref 已推送到被 clone 的那个仓库；或用提交哈希（只要有该对象即可），或换一个两边都有的 ref。可先看：git -C "' + $pair.Path + '" branch -a')
        }
        $co = Invoke-Git -Arguments @('checkout', '--quiet', $target) -WorkDir $pair.Path
        if ($co.ExitCode -ne 0) {
            Stop-Bootstrap ('[' + $pair.Name + '] 检出 ' + $target + ' 失败：' + $co.Output) '检查是否有本地修改冲突。'
        }
        Write-Ok ('[' + $pair.Name + '] 已检出 ' + $target)
    }
}

# ──────────────────────────────────────────────────────────────
# 6. 校验：两个仓都在、HEAD 与 ref 一致
# ──────────────────────────────────────────────────────────────
Write-Step '校验：两个仓都已就位，HEAD 与 ref 一致'

foreach ($pair in @(@{ Name = '父仓'; Path = $DestFull }, @{ Name = '子仓'; Path = $MindcraftDir })) {
    if (-not (Test-Path -LiteralPath $pair.Path)) {
        Stop-Bootstrap ('[' + $pair.Name + '] 目录不存在：' + $pair.Path) '重跑本脚本；不要手工拼一个目录出来。'
    }
    $id = Get-RepoIdentity -RepoPath $pair.Path
    if (-not $id) {
        Stop-Bootstrap ('[' + $pair.Name + '] 不是可用的 git 仓库：' + $pair.Path) '删掉该目录重跑本脚本。'
    }
    Write-Ok ('[{0}] HEAD {1} ({2}) · branch {3} · {4} commits · {5}' -f $pair.Name, $id.Short, $id.Branch, $id.Branch, $id.Commits, $id.Subject)
    if ($Ref) {
        $want = Invoke-Git -Arguments @('rev-parse', '--short', ($Ref + '^{commit}')) -WorkDir $pair.Path
        if ($want.ExitCode -eq 0 -and $want.Output -ne $id.Short) {
            Stop-Bootstrap ('[' + $pair.Name + '] HEAD ' + $id.Short + ' 与 ref ' + $Ref + ' (' + $want.Output + ') 不一致') '重新检出：git -C <repo> checkout <ref>'
        }
    }
}

# 子仓必须是一个真仓库，不能是空壳
if (-not (Test-Path -LiteralPath (Join-Path $MindcraftDir '.git'))) {
    Stop-Bootstrap ('子仓目录缺少 .git：' + $MindcraftDir) '它不是 clone 出来的仓库；删掉后重跑本脚本。'
}
$mId = Get-RepoIdentity -RepoPath $MindcraftDir
$parentId = Get-RepoIdentity -RepoPath $DestFull

# 关键产物是否随仓库带过来（这正是"哪些修复还没入库"的观测点）
$webDist = Join-Path $MindcraftDir 'web-dist'
$manifest = Join-Path $webDist 'MANIFEST.json'
$hasWebDist = (Test-Path -LiteralPath $webDist) -and (Test-Path -LiteralPath (Join-Path $webDist 'index.html'))
$hasManifest = Test-Path -LiteralPath $manifest

Write-Ok ('父仓：' + $parentId.Short + '  子仓：' + $mId.Short)
if ($hasWebDist) {
    Write-Ok '子仓自带 web-dist/（含 index.html）—— 镜像所需的固化产物随仓库到位'
}
else {
    Write-Warn2 '子仓**没有**可用的 web-dist/ —— 镜像会构建失败（Dockerfile 的 COPY web-dist + 构建期校验会拦下）'
}
if ($hasManifest) {
    Write-Ok 'web-dist/MANIFEST.json 存在'
}
else {
    Write-Warn2 'web-dist/MANIFEST.json 缺失 —— 无法校验产物与源码的绑定关系'
}

# ──────────────────────────────────────────────────────────────
# 7. 打印后续命令
# ──────────────────────────────────────────────────────────────
Write-Step '下一步（照抄即可）'

$ps = if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh' } else { 'powershell' }
$hasServerJar = Test-Path -LiteralPath (Join-Path $DestFull 'server/server.jar')
$hasProps     = Test-Path -LiteralPath (Join-Path $DestFull 'server/server.properties')
Write-Host ''
Write-Host '  # 1) 进目录' -ForegroundColor Gray
Write-Host ('  cd "' + $DestFull + '"')
Write-Host ''
Write-Host '  # 2) 供给服务端（JDK 21 + Paper jar + server.properties）—— R6 #7 缺的就是这一步' -ForegroundColor Gray
Write-Host ('  ' + $ps + ' -NoProfile -ExecutionPolicy Bypass -File scripts/provision.ps1 -DryRun   # 先体检，零副作用')
Write-Host ('  ' + $ps + ' -NoProfile -ExecutionPolicy Bypass -File scripts/provision.ps1')
Write-Host '     # 离线机器：-JdkZip <JDK21.zip> -JarFile <paper.jar>；已有 JDK 21：-JavaHome <dir>' -ForegroundColor DarkGray
Write-Host '     # 它读 server/.paper-url 下 jar（sha256 校验），并从 server.properties.example 生成配置' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  # 3) 装运行时依赖（mindcraft 548 个包，首次约 10 分钟；web 是面板与关服脚本要用的）' -ForegroundColor Gray
Write-Host ('  cd mindcraft; npm ci')
Write-Host ('  cd ../web; npm ci')
Write-Host ''
Write-Host '  # 4) 只校验：产物 ↔ 清单 ↔ 源码指纹 是否一致（秒级，不需要 docker）' -ForegroundColor Gray
Write-Host ('  cd "' + $DestFull + '"; ' + $ps + ' -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -VerifyOnly')
Write-Host ''
Write-Host '  # 5) 改了 web/ 源码后：重建产物并校验（不建镜像）' -ForegroundColor Gray
Write-Host ('  ' + $ps + ' -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -SkipDocker')
Write-Host ''
Write-Host '  # 6) 有 docker 时全链路（构建镜像 + 运行时 200 断言）' -ForegroundColor Gray
Write-Host ('  ' + $ps + ' -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1')
Write-Host ''

# ★ R6 #7：干净 clone 里 JDK / server.jar / server.properties 一定是缺的
#   （.gitignore 排除二进制与口令文件），不说明这一步，「启动面板.bat」必然停在
#   "找不到 JDK" 或 "找不到 server\server.jar"。这里按实际检出状态给出针对性提示。
if (-not $hasServerJar -or -not $hasProps) {
    $missing = @()
    if (-not $hasServerJar) { $missing += 'server\server.jar（Paper 服务端核心）' }
    if (-not $hasProps) { $missing += 'server\server.properties（含 RCON 口令，仓库只跟踪 .example）' }
    if (-not (Test-Path -LiteralPath (Join-Path $DestFull '.tools'))) { $missing += '.tools\（JDK 21）' }
    Write-Warn2 ('注意：这份检出里没有 ' + ($missing -join '、') + ' —— 这就是第 2 步要补齐的')
    Write-Warn2 '不跑第 2 步，「启动面板.bat」会停在 [错误] 找不到 JDK / 找不到 server\server.jar。'
}

if (-not $hasWebDist) {
    Write-Warn2 '注意：上面第 4 步很可能失败，因为这次克隆出来的子仓缺 web-dist。原因与修法见 docs/audit-r5/fixes/07-clone-all.md。'
}

Write-Host ('  两个仓都就位：' + $DestFull) -ForegroundColor Green
Write-Host ''
exit 0
