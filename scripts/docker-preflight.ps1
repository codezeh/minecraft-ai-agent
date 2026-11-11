<#
.SYNOPSIS
    Docker 部署的前置检查（R6 #52）：宿主机缺文件时 docker 只会"静默建目录"。
.DESCRIPTION
    docker compose 把 ./keys.json、./settings.js 之类 bind-mount 进容器。宿主侧**不存在**时，
    docker 会把它建成一个**目录** => 容器里 readFileSync 得到 EISDIR，报错文本像"文件坏了"，
    而不像"你没建这个文件"。compose 本身没有 test -f 的能力，所以这一步放在这里。
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\docker-preflight.ps1
.NOTES
    退出码：0 = 可以 up；1 = 有硬前置缺失（已打印修法）。只读，不改任何东西。
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$mc = Join-Path $root 'mindcraft'
$bad = 0

function Write-Ok2([string]$m)   { Write-Host ("  ok    " + $m) -ForegroundColor Green }
function Write-Bad2([string]$m)  { Write-Host ("  MISS  " + $m) -ForegroundColor Red }
function Write-Warn2([string]$m) { Write-Host ("  warn  " + $m) -ForegroundColor Yellow }

Write-Host 'Docker 部署前置检查（R6 #52）' -ForegroundColor Cyan

foreach ($rel in @('settings.js', 'keys.json')) {
    $p = Join-Path $mc $rel
    if (-not (Test-Path -LiteralPath $p)) {
        Write-Bad2 "mindcraft/$rel 不存在（compose 会把它建成目录，容器里报 EISDIR）"
        Write-Host "        修法：cp mindcraft/keys.example.json mindcraft/keys.json，再填 API key" -ForegroundColor Yellow
        $bad++
    } elseif ((Get-Item -LiteralPath $p).PSIsContainer) {
        Write-Bad2 "mindcraft/$rel 是**目录**（多半就是之前 compose 建的坑），必须是文件"
        Write-Host "        修法：rmdir mindcraft/$rel 后按上面新建文件" -ForegroundColor Yellow
        $bad++
    } else { Write-Ok2 "mindcraft/$rel（文件）" }
}

foreach ($rel in @('profiles', 'bots')) {
    $p = Join-Path $mc $rel
    if (-not (Test-Path -LiteralPath $p)) {
        Write-Bad2 "mindcraft/$rel 不存在（compose 会静默建空目录）"
        Write-Host "        修法：mkdir mindcraft/$rel 并按 README 放入人设/世界数据" -ForegroundColor Yellow
        $bad++
    } elseif (-not (Get-Item -LiteralPath $p).PSIsContainer) {
        Write-Bad2 "mindcraft/$rel 是文件，应为目录"
        $bad++
    } else { Write-Ok2 "mindcraft/$rel（目录）" }
}

if (-not $env:MINDSERVER_TOKEN) {
    Write-Warn2 'MINDSERVER_TOKEN 未设置：compose 会立刻报错（这是有意的，别改）。'
    Write-Host '        例：export MINDSERVER_TOKEN=$(openssl rand -hex 24)   # 任意长度都可以' -ForegroundColor Yellow
}

if (-not (Test-Path -LiteralPath (Join-Path $mc 'web-dist/MANIFEST.json'))) {
    Write-Bad2 'mindcraft/web-dist/MANIFEST.json 不存在：镜像构建期的产物校验必然失败'
    Write-Host '        修法：在仓库根跑 scripts\release.ps1（清单的唯一写者）' -ForegroundColor Yellow
    $bad++
} else { Write-Ok2 'mindcraft/web-dist/MANIFEST.json' }

if ($bad -gt 0) {
    Write-Host ''
    Write-Host ("结果：{0} 项硬前置缺失 —— 现在 docker compose up 会得到误导性报错。" -f $bad) -ForegroundColor Red
    exit 1
}
Write-Host ''
Write-Host '结果：前置齐全，可以 docker compose up。' -ForegroundColor Green
exit 0
