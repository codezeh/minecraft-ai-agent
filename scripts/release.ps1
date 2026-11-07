<#
.SYNOPSIS
    控制台 UI 一键发布与自检：build → 同步产物 → 校验清单 → docker build → 起容器
    → 断言 /console 与首个 asset 均 200 → 清理。

.DESCRIPTION
    第四轮审计 ④「发布可复现」的落地脚本。它回答一个问题：
    **把仓库干净 clone 到一台新机器上，一条命令能不能证明"镜像里的控制台是好的"？**

    审计当时的原始状态是：web-dist/ 从未 git add、HEAD 的 Dockerfile 没有 COPY web-dist、
    mindserver 只查 /web/dist —— 干净克隆要么构建失败，要么镜像构建成功但 /console 静默 404。
    本脚本把「构建 → 产物 → 清单 → 镜像 → 运行时 200」串成一条可重复执行的断言链。

    每一步失败都带**可照做的修复动作**，而不是只抛一句 docker 的原始报错。

.PARAMETER ImageTag
    构建出的镜像名。默认 mindcraft-console:release。

.PARAMETER HostPort
    映射到宿主机的端口（容器内固定 8080）。默认 18090，避开日常 8080。

.PARAMETER DockerExe
    docker 命令前缀，允许带参数。默认 'docker'。
    本机没有 Windows 版 docker、但 WSL 里有守护进程时，用：
        -DockerExe 'wsl -e sudo docker'
    这时建议同时给 -ProbeExe 'wsl -e curl'（端口发布在 WSL 的网络命名空间里）。

.PARAMETER DockerContextPath
    docker build 的构建上下文路径。默认 mindcraft/ 的绝对路径。
    远端 docker（如上面的 wsl）看不到 Windows 路径时，用 /mnt/e/... 这种形式显式指定。

.PARAMETER ProbeExe
    用来发 HTTP 探测的命令，默认 'curl'。要与 docker 的"同侧"（见 -DockerExe 说明）。

.PARAMETER SourceRoot
    从**另一棵 web/ 源码树**构建（默认用仓库根的 web/）。
    用途：工作树里有别人未提交的改动时，发布会把那些改动一起烤进产物；此时用
    `git worktree add tmp/rel-src <tag>` 开一棵干净树，再 `-SourceRoot tmp/rel-src/web`。
    产物仍写入 mindcraft/web-dist，清单元数据按这棵树计算。

.PARAMETER SkipDocker
    只做 build + 同步 + 清单校验（步骤 1~4），不构建镜像、不起容器。
    用于自测/CI，以及"只想刷新产物"的场景。

.PARAMETER VerifyOnly
    只做清单与产物校验（不重新 build web、不动产物），用于快速确认"产物与源码是否一致"。

.PARAMETER KeepImage
    结束后保留镜像（默认删除；容器总是会被删除）。

.EXAMPLE
    pwsh scripts/release.ps1
    本机有 docker：完整发布自检。

.EXAMPLE
    pwsh scripts/release.ps1 -SkipDocker
    只重新生成产物并校验清单（0.5 分钟内跑完）。

.EXAMPLE
    pwsh scripts/release.ps1 -VerifyOnly
    只校验"web-dist 是否仍与 web/ 源码一致、清单是否自洽"。

.EXAMPLE
    pwsh scripts/release.ps1 -DockerExe 'wsl -e sudo docker' -ProbeExe 'wsl -e curl' -DockerContextPath /mnt/e/repo/mindcraft
    本机只有 WSL 里的 docker 时的跑法。

.NOTES
    退出码：0 = 全链路通过；1 = 任一步失败（消息里写明失败点与修复动作）。
#>
[CmdletBinding()]
param(
    [string]$ImageTag = 'mindcraft-console:release',
    [int]$HostPort = 18090,
    [string]$DockerExe = 'docker',
    [string]$DockerContextPath = '',
    [string]$ProbeExe = 'curl',
    [string]$SourceRoot = '',
    [switch]$SkipDocker,
    [switch]$VerifyOnly,
    [switch]$KeepImage
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ──────────────────────────────────────────────────────────────
# 基础设施：步骤标题 / 失败退出 / 子命令执行
# ──────────────────────────────────────────────────────────────
$script:StepNo = 0
function Write-Step {
    param([string]$Message)
    $script:StepNo++
    Write-Host ''
    Write-Host ("=" * 78) -ForegroundColor DarkGray
    Write-Host ("[{0}/8] {1}" -f $script:StepNo, $Message) -ForegroundColor Cyan
    Write-Host ("=" * 78) -ForegroundColor DarkGray
}

function Write-Ok   { param([string]$Message) Write-Host ("  PASS  " + $Message) -ForegroundColor Green }
function Write-Warn2{ param([string]$Message) Write-Host ("  WARN  " + $Message) -ForegroundColor Yellow }

function Stop-Release {
    param([string]$Message, [string]$Fix = '')
    Write-Host ''
    Write-Host ("  FAIL  " + $Message) -ForegroundColor Red
    if ($Fix) { Write-Host ("        修复：" + $Fix) -ForegroundColor Yellow }
    Write-Host ''
    exit 1
}

# 把 'wsl -e sudo docker' 这类"命令前缀"拆成 exe + 参数
function Split-CommandPrefix {
    param([string]$Prefix)
    $parts = @($Prefix -split '\s+' | Where-Object { $_ -ne '' })
    if ($parts.Count -eq 0) { Stop-Release "命令前缀为空。" }
    return $parts
}

# 执行外部命令；不走 PowerShell 的解析歧义（参数按数组原样传）
function Invoke-Tool {
    param(
        [string[]]$Command,
        [string[]]$Arguments,
        [string]$WorkDir = $null,
        [switch]$AllowFailure
    )
    $exe = $Command[0]
    $pre = @()
    if ($Command.Count -gt 1) { $pre = $Command[1..($Command.Count - 1)] }
    $all = @($pre) + @($Arguments)

    # Windows PowerShell 5.1 会把原生命令写到 stderr 的内容变成 **终止性错误**
    # （"NativeCommandError"），而 docker/npm 正常工作时也会往 stderr 写进度。
    # 所以这一小段把 ErrorActionPreference 降成 Continue，成败一律看退出码。
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $saved = $null
    if ($WorkDir) { $saved = Get-Location; Set-Location -LiteralPath $WorkDir }
    try {
        & $exe @all 2>&1 | ForEach-Object { Write-Host ("  | " + $_) }
        $code = $LASTEXITCODE
    }
    finally {
        if ($saved) { Set-Location -LiteralPath $saved }
        $ErrorActionPreference = $prevEap
    }
    if (-not $AllowFailure -and $code -ne 0) {
        Stop-Release ("命令失败（退出码 {0}）：{1}" -f $code, ($all -join ' '))
    }
    return $code
}

function Test-HaveCommand {
    param([string[]]$Command)
    $exe = $Command[0]
    $pre = @()
    if ($Command.Count -gt 1) { $pre = $Command[1..($Command.Count - 1)] }
    try {
        & $exe @pre '--version' *> $null
        return ($LASTEXITCODE -eq 0)
    }
    catch { return $false }
}

# Windows 路径 → WSL 路径（/mnt/e/foo/bar）
function Convert-ToWslPath {
    param([string]$WinPath)
    $p = $WinPath -replace '\\', '/'
    if ($p -match '^([A-Za-z]):(.*)$') {
        $drive = $Matches[1].ToLowerInvariant()
        $rest = $Matches[2]
        return "/mnt/$drive$rest"
    }
    return $p
}

function Get-UtcStamp { (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }

function New-Token {
    $bytes = New-Object byte[] 24
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
}

# HTTP 状态码探测（跟随重定向；只取状态码）
function Get-HttpProbe {
    param([string]$Url)

    $cmd = Split-CommandPrefix $ProbeExe
    $exe = $cmd[0]
    $pre = @()
    if ($cmd.Count -gt 1) { $pre = $cmd[1..($cmd.Count - 1)] }

    $probeArgs = @('-s', '-L', '-o', '/dev/null', '-w', '%{http_code}', $Url)
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $raw = & $exe @pre @probeArgs 2>&1 }
    finally { $ErrorActionPreference = $prevEap }
    $codeText = ($raw | Out-String).Trim()
    $code = 0
    if ($codeText -match '(\d{3})\s*$') { $code = [int]$Matches[1] }
    return @{ Code = $code; Raw = $codeText }
}

# 把响应体落到指定文件（远端探测时自动把 Windows 路径翻成 WSL 路径）
function Save-HttpBody {
    param([string]$Url, [string]$OutPath)

    $cmd = Split-CommandPrefix $ProbeExe
    $exe = $cmd[0]
    $pre = @()
    if ($cmd.Count -gt 1) { $pre = $cmd[1..($cmd.Count - 1)] }

    $target = $OutPath
    if ($cmd[0] -eq 'wsl') { $target = Convert-ToWslPath $OutPath }
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $exe @pre @('-s', '-L', '-o', $target, $Url) *> $null }
    finally { $ErrorActionPreference = $prevEap }
}

# ──────────────────────────────────────────────────────────────
# 路径解析
# ──────────────────────────────────────────────────────────────
$RepoRoot = Split-Path -Parent $PSScriptRoot          # <仓库根>/scripts/release.ps1 → <仓库根>
$WebDir   = Join-Path $RepoRoot 'web'
$MindDir  = Join-Path $RepoRoot 'mindcraft'
$DistDir  = Join-Path $WebDir 'dist'
$WebDist  = Join-Path $MindDir 'web-dist'
$Manifest = Join-Path $WebDist 'MANIFEST.json'
$SyncTool = Join-Path $MindDir 'tools/sync_web_dist.mjs'

# 构建用的源码树：默认仓库根的 web/，可用 -SourceRoot 指定（例如 git worktree 出来的干净树）
$BuildWebDir = $WebDir
if ($SourceRoot) {
    if (-not [System.IO.Path]::IsPathRooted($SourceRoot)) { $SourceRoot = Join-Path $RepoRoot $SourceRoot }
    $BuildWebDir = $SourceRoot
    if (Test-Path -LiteralPath (Join-Path $BuildWebDir 'package.json')) { $BuildWebDir = $BuildWebDir }
    elseif (Test-Path -LiteralPath (Join-Path $BuildWebDir 'web/package.json')) { $BuildWebDir = Join-Path $BuildWebDir 'web' }
    else { Stop-Release ("-SourceRoot 里找不到 package.json：{0}" -f $SourceRoot) '传 web/ 源码目录，或含 web/ 的仓库根。' }
}

Write-Host ''
Write-Host '控制台 UI 发布自检（第四轮审计 ④ 发布可复现）' -ForegroundColor White
Write-Host ("  仓库根      : " + $RepoRoot)
Write-Host ("  镜像标签    : " + $ImageTag)
Write-Host ("  宿主机端口  : " + $HostPort + "  →  容器 8080")
Write-Host ("  docker      : " + $DockerExe)
Write-Host ("  模式        : " + ($(if ($VerifyOnly) { 'VerifyOnly（只校验）' } elseif ($SkipDocker) { 'SkipDocker（不建镜像）' } else { '全链路' })))
if ($SourceRoot) { Write-Host ("  源码树      : " + $BuildWebDir) }

# ──────────────────────────────────────────────────────────────
# [1/8] 环境前置
# ──────────────────────────────────────────────────────────────
Write-Step '环境前置：node / npm / 目录布局'

if (-not (Test-Path -LiteralPath $WebDir))  { Stop-Release "找不到 web/ 目录：$WebDir" '确认脚本位于 <仓库根>/scripts/release.ps1。' }
if (-not (Test-Path -LiteralPath $MindDir)) { Stop-Release "找不到 mindcraft/ 目录：$MindDir" 'mindcraft 是独立的嵌套仓库，必须先 clone 到仓库根。' }
Write-Ok "web/ 与 mindcraft/ 均存在"

if (-not (Test-HaveCommand @('node'))) { Stop-Release '找不到 node，无法构建前端产物。' '安装 Node 22+ 后重试。' }
if (-not (Test-HaveCommand @('npm')))  { Stop-Release '找不到 npm，无法构建前端产物。' '安装 Node 22+ 后重试。' }
Write-Ok ("node {0} / npm {1}" -f (& node --version), (& npm --version))

if (-not $SkipDocker -and -not $VerifyOnly) {
    $dockerCmd = Split-CommandPrefix $DockerExe
    if (-not (Test-HaveCommand $dockerCmd)) {
        Stop-Release ("执行不了 docker 命令：{0}" -f $DockerExe) '装 Docker；或本机只有 WSL 里的 docker 时用 -DockerExe "wsl -e sudo docker"。只想刷新产物可加 -SkipDocker。'
    }
    Write-Ok ("docker 可用：{0}" -f $DockerExe)
}

# ──────────────────────────────────────────────────────────────
# [2/8] 构建前端
# ──────────────────────────────────────────────────────────────
Write-Step '构建前端：web/ → web/dist'

if ($VerifyOnly) {
    Write-Warn2 'VerifyOnly：跳过 npm run build，只校验已有产物与源码是否一致'
}
else {
    Write-Host ("  构建源码树: " + $BuildWebDir)
    if ($BuildWebDir -ne $WebDir) { Write-Warn2 ("-SourceRoot 生效：产物将绑定到这棵树，而不是仓库根的 web/") }
    else {
        # 工作树脏 ⇒ 产物会把"别人没提交的改动"一起烤进去。这不是错误（可能就是你想发的），
        # 但它意味着产物绑定的是**工作树**而不是任何一次提交，别人无法复现。提醒一句。
        try {
            $dirty = @(& git -C $RepoRoot status --porcelain -- web 2>$null)
            if ($LASTEXITCODE -eq 0 -and $dirty.Count -gt 0) {
                Write-Warn2 ("web/ 有 {0} 处未提交改动：产物将绑定当前工作树（不是某次提交）。" -f $dirty.Count)
                Write-Warn2 '  要发布"某次提交"的产物：git worktree add tmp/rel-src <ref>，再 -SourceRoot tmp/rel-src/web'
            }
        }
        catch { }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $BuildWebDir 'node_modules'))) {
        Write-Host '  web/node_modules 不存在 → npm ci（首次约 1~2 分钟）'
        Invoke-Tool -Command @('npm') -Arguments @('ci') -WorkDir $BuildWebDir | Out-Null
    }
    Invoke-Tool -Command @('npm') -Arguments @('run', 'build') -WorkDir $BuildWebDir | Out-Null
    $buildDist = Join-Path $BuildWebDir 'dist'
    if (-not (Test-Path -LiteralPath (Join-Path $buildDist 'index.html'))) {
        Stop-Release "dist/index.html 不存在：vite build 没产出可用结果。" '单独跑 `npm run build` 看完整报错。'
    }
    Write-Ok 'web/dist 构建完成'

    # -SourceRoot 时把该树的 dist 暂存到仓库根的 web/dist，好让同步工具（唯一同步入口）继续工作
    if ($BuildWebDir -ne $WebDir) {
        if (Test-Path -LiteralPath $DistDir) { Remove-Item -LiteralPath $DistDir -Recurse -Force }
        Copy-Item -LiteralPath $buildDist -Destination $DistDir -Recurse -Force
        Write-Ok ("已把 {0}/dist 暂存到 {1}" -f $BuildWebDir, $DistDir)
    }
}

# ──────────────────────────────────────────────────────────────
# [3/8] 同步产物到 mindcraft/web-dist
# ──────────────────────────────────────────────────────────────
Write-Step '同步产物：web/dist → mindcraft/web-dist（含逐文件 sha256 清单）'

if ($VerifyOnly) {
    Write-Warn2 'VerifyOnly：跳过同步，直接校验 mindcraft/web-dist 现有内容'
}
else {
    if (-not (Test-Path -LiteralPath $SyncTool)) {
        Stop-Release "找不到同步工具：$SyncTool" 'mindcraft 仓库不完整，请重新 clone 或切到正确分支。'
    }
    Invoke-Tool -Command @('node') -Arguments @($SyncTool) -WorkDir $MindDir | Out-Null
    Write-Ok 'web-dist 已同步，MANIFEST.json 的 files 表已重写'
}

# ──────────────────────────────────────────────────────────────
# [4/8] 产物前置校验 + 清单元数据（源码 hash / 产物 hash / 生成时间）
# ──────────────────────────────────────────────────────────────
Write-Step '产物校验：清单自洽 + index.html 引用 + 源码 hash 绑定'

# ★ 这一步就是"构建期明确报错"的仓库侧对应物：docker build 之前先证明产物是完整的。
#   缺产物时这里先给出人话报错（docker 那层也会失败，但报错文本更容易被误读）。
if (-not (Test-Path -LiteralPath $WebDist)) {
    Stop-Release "产物目录不存在：$WebDist" '在仓库根运行 scripts/release.ps1 重新生成（不要手工建空目录）。'
}
if (-not (Test-Path -LiteralPath (Join-Path $WebDist 'index.html'))) {
    Stop-Release "产物里没有 index.html：$WebDist" '产物是空壳，镜像里 /console 会 404。重新运行本脚本（去掉 -VerifyOnly）。'
}
if (-not (Test-Path -LiteralPath $Manifest)) {
    Stop-Release "产物里没有 MANIFEST.json：$Manifest" '重新运行本脚本（去掉 -VerifyOnly）让同步步骤重写清单。'
}
Write-Ok 'web-dist 结构完整（index.html + MANIFEST.json）'

# 清单元数据的计算/写入/校验交给 node 做：
#   · 只有一处实现（不在 PowerShell 里重复 sha256 与 JSON 拼装）
#   · PowerShell 5.1 的 ConvertTo-Json 会把中文转成 \uXXXX，manifest 的 diff 会不可读
$metaHelper = Join-Path ([System.IO.Path]::GetTempPath()) ('t10-manifest-' + [guid]::NewGuid().ToString('N') + '.mjs')
$metaScript = @'
// 由 scripts/release.ps1 现场写出的临时助手：给 web-dist/MANIFEST.json 打"发布元数据"并校验。
//   node <helper> <stamp|verify> <manifest 绝对路径> <web 源码目录绝对路径>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [mode, manifestPath, webSrc] = process.argv.slice(2);
if (!mode || !manifestPath || !webSrc) {
  console.error('用法: node helper <stamp|verify> <manifest> <webSrc>');
  process.exit(2);
}

const distDir = path.dirname(manifestPath);
const sha256Buf = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sha256File = (p) => sha256Buf(fs.readFileSync(p));
let pass = 0;
const bad = (m, fix) => {
  console.error(`  FAIL  ${m}`);
  if (fix) console.error(`        修复：${fix}`);
  process.exit(1);
};
const ok = (m) => { pass++; console.log(`  PASS  ${m}`); };

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const files = manifest.files || {};
const names = Object.keys(files).sort();
if (names.length === 0) bad('MANIFEST.json 的 files 为空', '重新运行 scripts/release.ps1 生成产物。');

// ── 1. 逐文件核对（防手改 / 防漏拷） ──
for (const rel of names) {
  const abs = path.join(distDir, rel);
  if (!fs.existsSync(abs)) bad(`清单里有、磁盘上没有的文件: ${rel}`, '重新同步产物。');
  const got = sha256File(abs);
  if (got !== files[rel]) bad(`产物内容与清单不一致: ${rel}`, '产物被手改过；重新运行 scripts/release.ps1。');
}
ok(`${names.length} 个产物文件与清单逐条一致`);

// ── 2. 反向：不许有清单未记录的野文件（上一版残留最容易卡在这） ──
const walk = (dir, base = '') => {
  const out = [];
  for (const n of fs.readdirSync(dir)) {
    const abs = path.join(dir, n);
    const rel = base ? `${base}/${n}` : n;
    if (fs.statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else out.push(rel);
  }
  return out;
};
const SELF = new Set(['MANIFEST.json', 'README.md']);
const extras = walk(distDir).filter((f) => !SELF.has(f) && !names.includes(f));
if (extras.length) bad(`产物里有清单未记录的野文件: ${extras.join(', ')}`, '产物目录被污染；重新运行 scripts/release.ps1。');
ok('产物目录没有清单未记录的野文件');

// ── 3. index.html 引用的每个 /console/... 资源都必须真实存在 ──
const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
const refs = [...new Set([...html.matchAll(/\/console\/([A-Za-z0-9._/-]+)/g)].map((m) => m[1]))].sort();
if (refs.length === 0) bad('index.html 里没有任何 /console/ 资源引用', 'web/vite.config.ts 的 base 必须是 /console/。');
for (const r of refs) {
  if (!fs.existsSync(path.join(distDir, r))) bad(`index.html 引用了产物里不存在的资源: ${r}`, '产物与源码不同步；重新构建。');
}
ok(`index.html 的 ${refs.length} 个入口引用都能在产物里找到`);

// ── 4. 源码 hash：把产物绑到"是哪一版 web/ 源码构建出来的" ──
//  只纳入真正影响产物的输入（src/** + 构建配置 + 锁定依赖）；node_modules/ dist/ 不算。
const SOURCE_ENTRIES = ['src', 'index.html', 'vite.config.ts', 'tsconfig.json', 'package.json', 'package-lock.json'];
const sourceFiles = [];
const collect = (abs, rel) => {
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(abs).sort()) collect(path.join(abs, n), `${rel}/${n}`);
  } else {
    sourceFiles.push({ rel, hash: sha256File(abs) });
  }
};
for (const entry of SOURCE_ENTRIES) {
  const abs = path.join(webSrc, entry);
  if (!fs.existsSync(abs)) bad(`找不到源码输入: web/${entry}`, 'web/ 目录不完整；确认在仓库根运行。');
  collect(abs, entry);
}
sourceFiles.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
const sourceHash = 'sha256:' + sha256Buf(sourceFiles.map((f) => `${f.rel}\0${f.hash}\n`).join(''));
ok(`源码指纹 ${sourceHash}（${sourceFiles.length} 个输入文件）`);

const artifactHash = 'sha256:' + sha256Buf(names.map((rel) => `${rel}\0${files[rel]}\n`).join(''));
ok(`产物指纹 ${artifactHash}（${names.length} 个产物文件）`);

// ── 5. verify 模式：与清单里记录的值比对（这就是"漂移检测"的绑定处） ──
if (mode === 'verify') {
  const rec = manifest.source && manifest.source.hash;
  const recArtifact = manifest.artifact && manifest.artifact.hash;
  if (!rec || !recArtifact) {
    bad('MANIFEST.json 里没有发布元数据（source.hash / artifact.hash / generatedAt）',
      '清单是旧格式；在仓库根运行 scripts/release.ps1（不要只跑 tools/sync_web_dist.mjs）。');
  }
  if (rec !== sourceHash) {
    bad(`产物与源码不一致：清单记录 ${rec}，当前 web/ 源码是 ${sourceHash}`,
      'web/ 改过但产物没重新生成 → 运行 scripts/release.ps1 重新构建并同步。');
  }
  ok('产物与 web/ 源码指纹一致（产物确实是这份源码构建出来的）');
  if (recArtifact !== artifactHash) {
    bad(`产物指纹与清单不一致：记录 ${recArtifact}，实际 ${artifactHash}`, '重新生成产物。');
  }
  ok('产物指纹与清单一致');
  const recRefs = Array.isArray(manifest.entryAssets) ? manifest.entryAssets.slice().sort() : [];
  if (recRefs.join('|') !== refs.join('|')) {
    bad(`index.html 入口引用与清单不一致：记录 [${recRefs.join(', ')}]，实际 [${refs.join(', ')}]`, '重新生成产物。');
  }
  ok('入口引用与清单一致');
  console.log(`  INFO  generatedAt = ${manifest.generatedAt || '(未记录)'}`);
  console.log(`\n  ALL PASS: ${pass} passed, 0 failed`);
  process.exit(0);
}

// ── 6. stamp 模式：写回元数据（保持 key 顺序可读） ──
const stamped = {
  schemaVersion: 2,
  generatedFrom: manifest.generatedFrom || 'web/dist (Vue3 + Vite console)',
  generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  source: { root: 'web/', files: sourceFiles.length, hash: sourceHash, inputs: SOURCE_ENTRIES },
  artifact: { files: names.length, hash: artifactHash },
  entryAssets: refs,
  note: manifest.note || '镜像用的固化产物。改过 web/ 之后必须重新生成；本清单供 web_dist_manifest_unit 做漂移检测。',
  files,
};
fs.writeFileSync(manifestPath, JSON.stringify(stamped, null, 2) + '\n');
console.log(`  PASS  已写回发布元数据（generatedAt = ${stamped.generatedAt}）`);
console.log(`\n  ALL PASS: ${pass + 1} passed, 0 failed`);
'@

try {
    Set-Content -LiteralPath $metaHelper -Value $metaScript -Encoding UTF8
    if ($VerifyOnly) {
        Invoke-Tool -Command @('node') -Arguments @($metaHelper, 'verify', $Manifest, $BuildWebDir) -WorkDir $RepoRoot | Out-Null
        Write-Ok 'VerifyOnly：清单/产物/源码三方一致'
    }
    else {
        Invoke-Tool -Command @('node') -Arguments @($metaHelper, 'stamp', $Manifest, $BuildWebDir) -WorkDir $RepoRoot | Out-Null
        Invoke-Tool -Command @('node') -Arguments @($metaHelper, 'verify', $Manifest, $BuildWebDir) -WorkDir $RepoRoot | Out-Null
        Write-Ok '清单已写入源码/产物指纹与生成时间，并复核通过'
    }
}
finally {
    if (Test-Path -LiteralPath $metaHelper) { Remove-Item -LiteralPath $metaHelper -Force -ErrorAction SilentlyContinue }
}

if ($VerifyOnly) {
    Write-Host ''
    Write-Host 'VerifyOnly 完成：产物、清单、源码三方一致。' -ForegroundColor Green
    exit 0
}

# ──────────────────────────────────────────────────────────────
# [5/8] docker build（构建期硬校验在 Dockerfile 里，缺产物会直接失败）
# ──────────────────────────────────────────────────────────────
if ($SkipDocker) {
    Write-Step '跳过 docker build / 运行期断言（-SkipDocker）'
    Write-Host ''
    Write-Host '产物已刷新并校验通过。要验证镜像与运行时 200，请去掉 -SkipDocker 重跑。' -ForegroundColor Green
    exit 0
}

Write-Step ("构建镜像：docker build -t {0}" -f $ImageTag)

$dockerCmd = Split-CommandPrefix $DockerExe
$contextPath = $DockerContextPath
if (-not $contextPath) { $contextPath = $MindDir }
# wsl 里的 docker 看不到 Windows 路径：无论路径是显式给还是默认来的，都翻成 /mnt/<drive>/...
if ($dockerCmd[0] -eq 'wsl' -and $contextPath -match '^[A-Za-z]:') { $contextPath = Convert-ToWslPath $contextPath }
Write-Host ("  构建上下文: " + $contextPath)

$buildCode = Invoke-Tool -Command $dockerCmd -Arguments @('build', '-t', $ImageTag, $contextPath) -WorkDir $MindDir -AllowFailure
if ($buildCode -ne 0) {
    Stop-Release ("docker build 失败（退出码 {0}）" -f $buildCode) `
        ('若是 COPY web-dist 报错：产物目录不存在/被 .dockerignore 排除。先跑 scripts/release.ps1 -SkipDocker 生成产物；' +
         '若是 ERROR[T10]：产物与清单不一致，删掉 web-dist 重新生成。')
}
Write-Ok ("镜像构建成功：{0}" -f $ImageTag)

# 镜像级断言：产物确实在镜像里（而不是只在宿主机上）
$probeInImage = Invoke-Tool -Command $dockerCmd -Arguments @(
    'run', '--rm', '--entrypoint', 'sh', $ImageTag, '-c',
    'test -f /app/web-dist/index.html && test -f /app/web-dist/MANIFEST.json && ls /app/web-dist/assets | wc -l'
) -WorkDir $MindDir -AllowFailure
if ($probeInImage -ne 0) {
    Stop-Release '镜像里没有 /app/web-dist/index.html 或 MANIFEST.json' '检查 Dockerfile 的 COPY web-dist 是否被删改。'
}
Write-Ok '镜像内 /app/web-dist 结构完整'

# ──────────────────────────────────────────────────────────────
# [6/8] 起容器
# ──────────────────────────────────────────────────────────────
Write-Step '启动容器并等待控制台就绪'

$token = New-Token
$containerName = 't10-release-' + (Get-Random -Minimum 1000 -Maximum 9999)

# 用 --env-file 而不是一串 -e：SETTINGS_JSON 里有引号和花括号，经 Windows→WSL 传参极易被拆坏。
# profiles 置空是必须的：容器里没有 profiles/（被 .dockerignore 排除），
# main.js 会对每个 profile 做 readFileSync ⇒ 缺文件直接抛异常、进程退出 ⇒ 容器起不来。
$envFileWin = Join-Path ([System.IO.Path]::GetTempPath()) ('t10-env-' + [guid]::NewGuid().ToString('N') + '.env')
$envLines = @(
    "MINDSERVER_TOKEN=$token",
    'MIND_SERVER_HOST=0.0.0.0',
    'SETTINGS_JSON={"auto_open_ui":false,"profiles":[]}'
)
Set-Content -LiteralPath $envFileWin -Value $envLines -Encoding ASCII
$envFile = $envFileWin
if ($dockerCmd[0] -eq 'wsl') { $envFile = Convert-ToWslPath $envFileWin }

$runArgs = @(
    'run', '-d', '--name', $containerName,
    '--env-file', $envFile,
    '-p', ("127.0.0.1:{0}:8080" -f $HostPort),
    $ImageTag
)

$started = $false
try {
    $runCode = Invoke-Tool -Command $dockerCmd -Arguments $runArgs -WorkDir $MindDir -AllowFailure
    if ($runCode -ne 0) {
        Stop-Release ("docker run 失败（退出码 {0}）" -f $runCode) '若端口被占用，换 -HostPort。'
    }
    $started = $true
    Write-Ok ("容器已启动：{0}（宿主 127.0.0.1:{1}）" -f $containerName, $HostPort)

    # ──────────────────────────────────────────────────────────
    # [7/8] 运行期断言：/console 与首个 asset 必须 200
    # ──────────────────────────────────────────────────────────
    Write-Step '/console 与首个静态资源必须 200'

    $baseUrl = "http://127.0.0.1:$HostPort"
    $consoleUrl = "$baseUrl/console?token=$token"

    $ready = $false
    $lastCode = 0
    for ($i = 1; $i -le 30; $i++) {
        Start-Sleep -Seconds 2
        $probe = Get-HttpProbe -Url $consoleUrl
        $lastCode = $probe.Code
        if ($lastCode -eq 200) { $ready = $true; break }
        Write-Host ("  ... 第 {0} 次探测：HTTP {1}" -f $i, $lastCode)
    }
    if (-not $ready) {
        Write-Host '  --- 容器日志（末 40 行）---' -ForegroundColor Yellow
        Invoke-Tool -Command $dockerCmd -Arguments @('logs', '--tail', '40', $containerName) -AllowFailure | Out-Null
        Stop-Release ("/console 在 60 秒内没有返回 200（最后一次 HTTP {0}）" -f $lastCode) `
            '看上面容器日志：报 "未找到控制台 UI" 说明镜像里缺 web-dist；报 token 相关说明 env 没传进去。'
    }
    Write-Ok ("GET /console → 200（跟随 301 到 /console/）")

    # 首个 asset：从刚刚生成的清单里取（与镜像内清单同源），避免"猜文件名"
    # ⚠️ -Encoding UTF8 不能省：MANIFEST.json 里有中文 note 字段，
    #    Windows PowerShell 5.1 默认按 ANSI 读，会把多字节字符读坏，ConvertFrom-Json 直接抛异常。
    $manifestJson = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    $firstAsset = $null
    if ($manifestJson.PSObject.Properties.Name -contains 'entryAssets' -and $manifestJson.entryAssets.Count -gt 0) {
        $firstAsset = @($manifestJson.entryAssets | Where-Object { $_ -like 'assets/*.js' })[0]
        if (-not $firstAsset) { $firstAsset = @($manifestJson.entryAssets)[0] }
    }
    if (-not $firstAsset) {
        Stop-Release 'MANIFEST.json 里没有 entryAssets，取不到"首个 asset"' '重新运行本脚本生成清单。'
    }

    $assetUrl = "$baseUrl/console/$firstAsset`?token=$token"
    $assetProbe = Get-HttpProbe -Url $assetUrl
    if ($assetProbe.Code -ne 200) {
        Stop-Release ("GET /console/{0} → HTTP {1}（期望 200）" -f $firstAsset, $assetProbe.Code) `
            '静态资源 404：产物与 index.html 不同源，或镜像里 web-dist 与清单不一致。'
    }
    Write-Ok ("GET /console/{0} → 200" -f $firstAsset)

    # 内容断言：/console 的 HTML 必须引用我们刚构建的那个 asset（证明"镜像里的就是这份产物"）
    $bodyPath = Join-Path ([System.IO.Path]::GetTempPath()) ('t10-body-' + [guid]::NewGuid().ToString('N') + '.html')
    $body = ''
    try {
        Save-HttpBody -Url $consoleUrl -OutPath $bodyPath
        if (Test-Path -LiteralPath $bodyPath) { $body = Get-Content -LiteralPath $bodyPath -Raw -Encoding UTF8 }
    }
    finally {
        if (Test-Path -LiteralPath $bodyPath) { Remove-Item -LiteralPath $bodyPath -Force -ErrorAction SilentlyContinue }
    }
    if (-not $body -or $body -notmatch [regex]::Escape($firstAsset)) {
        Stop-Release ("/console 的 HTML 里没有引用 {0}" -f $firstAsset) `
            '镜像里的 index.html 与宿主机产物不同源：重新 docker build（别复用旧镜像）。'
    }
    Write-Ok ("/console 的 HTML 确实引用了 {0}（镜像内产物 = 本次构建产物）" -f $firstAsset)
}
finally {
    # ──────────────────────────────────────────────────────────
    # [8/8] 清理
    # ──────────────────────────────────────────────────────────
    Write-Step '清理：删容器（可选删镜像）'
    if ($started) {
        Invoke-Tool -Command $dockerCmd -Arguments @('rm', '-f', $containerName) -AllowFailure | Out-Null
        Write-Ok ("容器已删除：{0}" -f $containerName)
    }
    if (Test-Path -LiteralPath $envFileWin) { Remove-Item -LiteralPath $envFileWin -Force -ErrorAction SilentlyContinue }
    if (-not $KeepImage) {
        Invoke-Tool -Command $dockerCmd -Arguments @('rmi', '-f', $ImageTag) -AllowFailure | Out-Null
        Write-Ok ("镜像已删除：{0}（-KeepImage 可保留）" -f $ImageTag)
    }
    else {
        Write-Warn2 ("保留镜像：{0}" -f $ImageTag)
    }
}

Write-Host ''
Write-Host ("发布自检通过：镜像 {0} 的 /console 与静态资源均返回 200。" -f $ImageTag) -ForegroundColor Green
Write-Host '提醒：产物（mindcraft/web-dist）与 MANIFEST.json 需要一起 git add —— 干净克隆的构建依赖它们。' -ForegroundColor DarkGray
exit 0
