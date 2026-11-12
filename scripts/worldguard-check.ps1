<#
.SYNOPSIS
    WorldGuard「事前区域限制」的只读体检（D5 三件套之一）。

.DESCRIPTION
    回答四个问题，全部只读：

      1. **装没装**：server/plugins 下有没有 worldguard*.jar / worldedit*.jar；
         只有 plugins/WorldGuard/ 文档目录、没有 jar 的，判「未安装」而不是「已装」。
      2. **版本配不配**：从 jar 文件名取世界版本，与内置的 MC↔WorldGuard 对应表比对
         （表来源：Modrinth 官方项目元数据，2026-11-12 抓取）。同时拦一个真实的坑：
         WorldEdit 7.4.x 的发布说明写「只兼容 WorldGuard 7.0.15 Beta 1 或更新」，
         而 WorldGuard 7.0.15+ 已不支持 1.21.8 —— 这台服是 1.21.8，配 7.4.x 就是错配。
      3. **配置能不能解析**：plugins/WorldGuard/config.yml、worlds/<世界>/regions.yml
         （两种文件名 region.yml / regions.yml 都认）、以及仓库里的区域草案
         config/worldguard-regions.yml，全部走同一个块风格 YAML 解析器，逐项报错。
      4. **和白名单/权限有没有矛盾**：区域成员不在 whitelist.json（人进不来，成员等于空）、
         UUID 版本与 online-mode 自相矛盾（离线 v3 vs 正版）、区域用了 owners.groups
         但本服没有权限插件（组名不生效）、whitelist/ops 设置本身不自洽。

    本脚本 **只读**：只调用 Get-ChildItem / Get-Content / Select-String / Test-Path，
    不写文件、不建目录、不启停服务器、不碰 RCON。跑一百次和跑一次的结果必须一样。

    退出码：
      0 = 没有硬矛盾（**包含「未安装」** —— 没装不是错误，是待办）
      1 = 有硬矛盾（版本错配、配置解析失败、UUID/online-mode 矛盾、区域成员构成矛盾等）

.PARAMETER ServerDir
    服务端目录，默认 <仓库根>/server。

.PARAMETER RepoRoot
    仓库根，默认本脚本的上一级目录。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\worldguard-check.ps1

.EXAMPLE
    # 未装插件时应看到「未安装 WorldGuard」并 exit 0
    powershell -ExecutionPolicy Bypass -File scripts\worldguard-check.ps1; echo "exit=$LASTEXITCODE"
#>
[CmdletBinding()]
param(
    [string]$ServerDir,
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'

# ── 计数与输出（口径抄 verify-world-backup.ps1，读日志的人不用换脑子）──────
$script:pass = 0
$script:fail = 0
$script:warn = 0
function Ok([string]$name, [string]$detail = '') { $script:pass++; Write-Host "PASS $name $detail" -ForegroundColor Green }
function Bad([string]$name, [string]$detail = '') { $script:fail++; Write-Host "FAIL $name $detail" -ForegroundColor Red }
function Warn([string]$name, [string]$detail = '') { $script:warn++; Write-Host "WARN $name $detail" -ForegroundColor Yellow }
function Info([string]$msg) { Write-Host "     $msg" -ForegroundColor DarkGray }
function Section([string]$title) {
    Write-Host ''
    Write-Host "──── $title " -ForegroundColor Cyan
}

# ── 路径解析 ───────────────────────────────────────────────────────────────
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
if (-not [System.IO.Path]::IsPathRooted($RepoRoot)) { $RepoRoot = Join-Path (Get-Location).Path $RepoRoot }
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)

if (-not $ServerDir) { $ServerDir = Join-Path $RepoRoot 'server' }
elseif (-not [System.IO.Path]::IsPathRooted($ServerDir)) { $ServerDir = Join-Path $RepoRoot $ServerDir }
$ServerDir = [System.IO.Path]::GetFullPath($ServerDir)

$pluginDir = Join-Path $ServerDir 'plugins'
$draftPath = Join-Path $RepoRoot 'config/worldguard-regions.yml'

Write-Host ''
Write-Host 'WorldGuard 只读体检（事前区域限制）' -ForegroundColor White
Info "仓库根  : $RepoRoot"
Info "服务端  : $ServerDir"
Info '模式    : 只读（不写文件 / 不起服 / 不碰 RCON）'

if (-not (Test-Path -LiteralPath $ServerDir -PathType Container)) {
    Bad '服务端目录存在' "找不到 $ServerDir"
    Write-Host ''
    Write-Host ("结果：PASS {0} / WARN {1} / FAIL {2}" -f $script:pass, $script:warn, $script:fail)
    exit 1
}
if (-not (Test-Path -LiteralPath $pluginDir -PathType Container)) {
    Warn 'plugins 目录' "找不到 $pluginDir（服务端没起过？）"
}

# ══════════════════════════════════════════════════════════════════════════
# 通用工具
# ══════════════════════════════════════════════════════════════════════════

function Test-IsMap($node) {
    return ($node -is [System.Collections.Specialized.OrderedDictionary]) -or ($node -is [hashtable])
}

function Test-IsList($node) {
    return ($node -is [System.Collections.ArrayList]) -or ($node -is [System.Collections.IList] -and -not (Test-IsMap $node))
}

function Get-MapValue($map, [string]$key) {
    # ⚠️ 必须 -NoEnumerate：普通 return 会把集合值"展开"进管道 ——
    # 单元素 ArrayList 变成那个字符串本身，空 ArrayList 变成 $null，
    # 于是 players: [a] 会被当成标量、players: [] 会被当成"没写"（第一版实测踩到）。
    if ((Test-IsMap $map) -and $map.Contains($key)) {
        Write-Output -NoEnumerate $map[$key]
        return
    }
    return $null
}

function Get-MapKeys($map) {
    if (Test-IsMap $map) { return @($map.Keys) }
    return @()
}

$script:PlaceholderPattern = '^__[A-Z0-9_]+__$'
function Test-Placeholder([string]$value) {
    if ($null -eq $value) { return $false }
    return ($value -match $script:PlaceholderPattern)
}

# ── 块风格 YAML 解析器（PS 5.1 没有 YAML 模块，这里自带一个够用的）─────────
# 支持：嵌套 map、标量、块列表（- item）、单行 flow map {a: b}、flow 列表 [a, b]。
# 不支持：锚点/别名、多文档、块标量（| >）。区域文件用不到这些；遇到就报解析错误，
# 宁可喊出来，也不要"看起来解析成功了"。
$script:yamlErrors = New-Object System.Collections.ArrayList
$script:yamlDupKeys = New-Object System.Collections.ArrayList

function ConvertTo-ScalarValue {
    param([string]$Text)
    $v = $Text.Trim()
    # ⚠️ 不要在这里 return 空集合：PowerShell 函数返回空 ArrayList/空字典时，管道没有
    # 对象可发，调用方拿到的是 $null —— flags: {} / players: [] 会静默变成"没写"。
    # 空 [] / {} 由 ConvertFrom-BlockYaml 在调用点直接建对象。
    if ($v.StartsWith('[') -and $v.EndsWith(']')) {
        $inner = $v.Substring(1, $v.Length - 2).Trim()
        $list = New-Object System.Collections.ArrayList
        if ($inner -ne '') {
            foreach ($part in ($inner -split ',')) {
                $p = $part.Trim().Trim('"').Trim("'").Trim()
                if ($p -ne '') { [void]$list.Add($p) }
            }
        }
        Write-Output -NoEnumerate $list
        return
    }
    if ($v.StartsWith('{') -and $v.EndsWith('}')) {
        $inner = $v.Substring(1, $v.Length - 2).Trim()
        $map = [ordered]@{}
        if ($inner -ne '') {
            foreach ($part in ($inner -split ',')) {
                $kv = $part -split ':', 2
                if ($kv.Count -eq 2) {
                    $k = $kv[0].Trim().Trim('"').Trim("'").Trim()
                    $map[$k] = (ConvertTo-ScalarValue $kv[1])
                }
            }
        }
        return $map
    }
    $quoted = (($v.StartsWith('"') -and $v.EndsWith('"') -and $v.Length -ge 2) -or
               ($v.StartsWith("'") -and $v.EndsWith("'") -and $v.Length -ge 2))
    if ($quoted) { return $v.Substring(1, $v.Length - 2) }
    $hash = $v.IndexOf(' #')
    if ($hash -gt 0) { $v = $v.Substring(0, $hash).Trim() }
    return $v
}

function ConvertFrom-BlockYaml {
    param([string[]]$Lines, [string]$Source)

    $root = [ordered]@{}
    $frames = New-Object System.Collections.ArrayList
    [void]$frames.Add(@{ Indent = -1; Node = $root; Kind = 'map' })

    for ($i = 0; $i -lt $Lines.Count; $i++) {
        $line = $Lines[$i]
        if ($line -match '^\s*$') { continue }
        if ($line -match '^\s*#') { continue }
        if ($line -match "`t") {
            [void]$script:yamlErrors.Add("$Source 第 $($i + 1) 行：含 TAB 缩进（YAML 禁止用 TAB 缩进）")
            continue
        }

        $indent = 0
        while ($indent -lt $line.Length -and $line[$indent] -eq ' ') { $indent++ }
        $content = $line.Substring($indent)

        while ($frames.Count -gt 1 -and $frames[$frames.Count - 1].Indent -ge $indent) {
            $frames.RemoveAt($frames.Count - 1)
        }
        $top = $frames[$frames.Count - 1]

        if ($content.StartsWith('- ')) {
            if ($top.Kind -ne 'list') {
                [void]$script:yamlErrors.Add("$Source 第 $($i + 1) 行：列表项不在列表上下文里")
                continue
            }
            [void]$top.Node.Add((ConvertTo-ScalarValue $content.Substring(2)))
            continue
        }

        $m = [regex]::Match($content, '^([^:]+):(.*)$')
        if (-not $m.Success) {
            [void]$script:yamlErrors.Add("$Source 第 $($i + 1) 行：不是 key: value → $content")
            continue
        }
        $key = $m.Groups[1].Value.Trim()
        $valueText = $m.Groups[2].Value.Trim()

        if ($top.Kind -ne 'map') {
            [void]$script:yamlErrors.Add("$Source 第 $($i + 1) 行：映射键出现在列表上下文里 → $key")
            continue
        }
        if ($top.Node.Contains($key)) {
            [void]$script:yamlDupKeys.Add("$Source 重复键：$key")
        }

        if ($valueText -ne '') {
            # 空集合在调用点建：从函数 return 空集合会被 PowerShell 吞成 $null（见 ConvertTo-ScalarValue 注释）
            if ($valueText -eq '[]') { $top.Node[$key] = (New-Object System.Collections.ArrayList); continue }
            if ($valueText -eq '{}') { $top.Node[$key] = [ordered]@{}; continue }
            $top.Node[$key] = ConvertTo-ScalarValue $valueText
            continue
        }

        # 空值：看下一行缩进决定是 map 还是 list
        $nextLine = $null
        for ($j = $i + 1; $j -lt $Lines.Count; $j++) {
            if ($Lines[$j] -match '^\s*$') { continue }
            if ($Lines[$j] -match '^\s*#') { continue }
            $nextLine = $Lines[$j]
            break
        }
        $nextIndent = 0
        if ($null -ne $nextLine) {
            while ($nextIndent -lt $nextLine.Length -and $nextLine[$nextIndent] -eq ' ') { $nextIndent++ }
        }
        $isList = ($null -ne $nextLine) -and ($nextIndent -gt $indent) -and ($nextLine.Substring($nextIndent).StartsWith('- '))

        if ($isList) {
            $list = New-Object System.Collections.ArrayList
            $top.Node[$key] = $list
            [void]$frames.Add(@{ Indent = $indent; Node = $list; Kind = 'list' })
        }
        else {
            $map = [ordered]@{}
            $top.Node[$key] = $map
            [void]$frames.Add(@{ Indent = $indent; Node = $map; Kind = 'map' })
        }
    }
    return $root
}

function Read-YamlFile {
    param([string]$Path)
    $script:yamlErrors = New-Object System.Collections.ArrayList
    $script:yamlDupKeys = New-Object System.Collections.ArrayList
    $lines = @(Get-Content -LiteralPath $Path -Encoding UTF8)
    $tree = ConvertFrom-BlockYaml -Lines $lines -Source (Split-Path -Leaf $Path)
    return @{
        Tree   = $tree
        Errors = @($script:yamlErrors)
        Dups   = @($script:yamlDupKeys)
        Lines  = $lines.Count
    }
}

# ── server.properties / whitelist.json / ops.json ──────────────────────────
function Read-ServerProperties {
    param([string]$Path)
    $props = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $props }
    foreach ($line in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
        if ($line -match '^\s*#') { continue }
        if ($line -match '^\s*$') { continue }
        $idx = $line.IndexOf('=')
        if ($idx -lt 1) { continue }
        $props[$line.Substring(0, $idx).Trim()] = $line.Substring($idx + 1).Trim()
    }
    return $props
}

function Read-JsonList {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    try {
        $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
        if (-not $raw -or $raw.Trim() -eq '') { return @() }
        # 这里要的就是"逐条展开"：调用方用 @(...) 收成数组，Count 才不会退化成 1。
        # （踩过的坑：写成 Write-Output -NoEnumerate 会把整个数组当一个对象，16 条变 1 条。）
        return @($raw | ConvertFrom-Json)
    }
    catch {
        return @()
    }
}

# ── 版本与兼容表 ───────────────────────────────────────────────────────────
# 来源：Modrinth 官方元数据 api.modrinth.com/v2/project/worldguard/version（2026-11-12 抓取）。
# 这张表只用来"发现明显错配"，不能替代官方发布页；表里没有的版本一律 WARN 人工核对。
$script:WgCompatibility = [ordered]@{
    '7.0.13' = @('1.21.4')
    '7.0.14' = @('1.21.5', '1.21.6', '1.21.7', '1.21.8')
    '7.0.15' = @('1.21.10', '1.21.11')
    '7.0.16' = @('1.21.11', '26.1', '26.1.1', '26.1.2')
    '7.0.17' = @('1.21.11', '26.1', '26.1.1', '26.1.2', '26.2')
    '7.0.18' = @('26.1', '26.1.1', '26.1.2', '26.2', '26.3')
    '7.0.19' = @('26.2', '26.3')
    '7.0.20' = @('26.3')
    '7.0.21' = @('26.3')
}

function Get-JarVersion {
    param([string]$FileName)
    # worldguard-bukkit-7.0.14-dist.jar / worldedit-bukkit-7.3.16.jar
    $m = [regex]::Match($FileName, '^(worldguard|worldedit)-bukkit-(\d+)\.(\d+)\.(\d+)(?:-(.+?))?(?:-dist)?\.jar$')
    if (-not $m.Success) { return $null }
    $suffix = $m.Groups[5].Value
    # "-dist" 是卷构建标记，不是预发布后缀：worldguard-bukkit-7.0.14-dist.jar 要报 7.0.14，
    # 不能报 7.0.14-dist（否则版本显示与兼容表比对都会带上噪声）。
    if ($suffix) { $suffix = ($suffix -replace '(^|-)dist$', '').Trim('-') }
    $isPre = $false
    if ($suffix) {
        $isPre = ($suffix -match 'beta|rc|alpha|snapshot|SNAPSHOT')
    }
    return @{
        Base     = "$($m.Groups[2].Value).$($m.Groups[3].Value).$($m.Groups[4].Value)"
        Suffix   = $suffix
        IsPre    = $isPre
        Numeric  = (New-Object System.Version "$($m.Groups[2].Value).$($m.Groups[3].Value).$($m.Groups[4].Value)")
        Raw      = $FileName
    }
}

function Get-MinecraftVersion {
    param([string]$ServerDirPath)
    $version = ''
    $source = ''

    $paperJar = @(Get-ChildItem -LiteralPath $ServerDirPath -File -Filter 'paper-*.jar' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1)
    if ($paperJar.Count -gt 0 -and $paperJar[0].Name -match 'paper-(\d+\.\d+(?:\.\d+)?)-\d+') {
        $version = $Matches[1]
        $source = "jar 文件名 $($paperJar[0].Name)"
    }

    $logPath = Join-Path $ServerDirPath 'logs/latest.log'
    if (Test-Path -LiteralPath $logPath) {
        $head = @(Get-Content -LiteralPath $logPath -Encoding UTF8 -TotalCount 400 -ErrorAction SilentlyContinue)
        $hit = @($head | Select-String -Pattern 'Starting minecraft server version ([\w\.\-]+)' | Select-Object -First 1)
        if ($hit.Count -gt 0) {
            $version = $hit[0].Matches[0].Groups[1].Value
            $source = 'logs/latest.log（比文件名权威）'
        }
    }
    return @{ Version = $version; Source = $source }
}

# ── flag 名清单（来自官方 Region Flags 文档，用于抓拼写错误）────────────────
$script:StateFlags = @(
    'build', 'interact', 'block-break', 'block-place', 'use', 'damage-animals',
    'chest-access', 'ride', 'pvp', 'sleep', 'respawn-anchors', 'tnt',
    'vehicle-place', 'vehicle-destroy', 'lighter', 'block-trampling',
    'frosted-ice-form', 'item-frame-rotation', 'firework-damage', 'use-anvil',
    'use-dripleaf', 'passthrough', 'entry', 'exit', 'enderpearl',
    'chorus-fruit-teleport', 'item-pickup', 'item-drop', 'exp-drops',
    'invincible', 'fall-damage', 'natural-health-regen', 'natural-hunger-drain',
    'pistons', 'send-chat', 'receive-chat', 'potion-splash',
    'creeper-explosion', 'enderdragon-block-damage', 'ghast-fireball',
    'other-explosion', 'fire-spread', 'enderman-grief', 'snowman-trails',
    'ravager-grief', 'mob-damage', 'mob-spawning', 'entity-painting-destroy',
    'entity-item-frame-destroy', 'wither-damage', 'lava-fire', 'lightning',
    'water-flow', 'lava-flow', 'snow-fall', 'snow-melt', 'ice-form', 'ice-melt',
    'frosted-ice-melt', 'mushroom-growth', 'leaf-decay', 'grass-growth',
    'mycelium-spread', 'vine-growth', 'rock-growth', 'sculk-growth',
    'crop-growth', 'soil-dry', 'coral-fade', 'copper-fade', 'lava-harden'
)
$script:OtherFlags = @(
    'greeting', 'farewell', 'greeting-title', 'farewell-title',
    'entry-deny-message', 'exit-deny-message', 'notify-enter', 'notify-leave',
    'teleport', 'spawn', 'teleport-message', 'deny-message', 'game-mode',
    'time-lock', 'weather-lock', 'heal-delay', 'heal-amount', 'heal-min-health',
    'heal-max-health', 'feed-delay', 'feed-amount', 'feed-min-hunger',
    'feed-max-hunger', 'blocked-cmds', 'allowed-cmds', 'deny-spawn',
    'nonplayer-protection-domains', 'exit-override', 'exit-via-teleport'
)
$script:KnownFlags = @($script:StateFlags) + @($script:OtherFlags)

# ── 单个区域的规格校验（草案与线上 regions.yml 共用同一套判据）──────────────
# 抽成函数的原因很实际：第一版只对草案做了逐项校验，线上 regions.yml 只查了"能不能解析"，
# 于是 min>max、pvp: maybe、bulid 拼写错误、chest-access: allow 全都被放过 —— 那是假绿灯。
$script:specPlaceholders = 0
$script:specMemberRefs = New-Object System.Collections.ArrayList
$script:specUsesGroups = $false
$script:specRegionCount = 0

function Reset-SpecCounters {
    $script:specPlaceholders = 0
    $script:specMemberRefs = New-Object System.Collections.ArrayList
    $script:specUsesGroups = $false
    $script:specRegionCount = 0
}

function Test-RegionSpec {
    param(
        [string]$RegionId,
        $Region,
        [string]$Context,
        [switch]$AllowPlaceholders
    )

    $label = "$Context $RegionId"
    $script:specRegionCount++

    if (-not (Test-IsMap $Region)) { Bad $label '不是一个映射'; return }

    $type = Get-MapValue $Region 'type'
    if (-not $type) {
        Bad $label '缺 type（cuboid / global）'
    }
    elseif ($type -notin @('cuboid', 'global', 'poly2d', 'prism')) {
        Bad $label "未知 type：$type"
    }
    if ($type -eq 'global' -and $RegionId -ne '__global__') {
        Warn $label 'type=global 但 id 不是 __global__'
    }

    $priority = Get-MapValue $Region 'priority'
    if ($null -eq $priority -or $priority -eq '') {
        Warn $label '没写 priority（默认 0，重叠时会被别的区域盖掉）'
    }
    else {
        $pInt = 0
        if (-not [int]::TryParse([string]$priority, [ref]$pInt)) {
            Bad $label "priority 不是整数：$priority"
        }
    }

    # ── 立方体边界：存在性 / 数值 / min<=max ──────────────────────────────
    if ($type -eq 'cuboid') {
        $minNode = Get-MapValue $Region 'min'
        $maxNode = Get-MapValue $Region 'max'
        $mins = @{}
        $maxs = @{}
        $allNumeric = $true

        foreach ($corner in @('min', 'max')) {
            $cornerNode = Get-MapValue $Region $corner
            if (-not (Test-IsMap $cornerNode)) {
                Bad $label "缺 $corner（或不是 x/y/z 映射）"
                $allNumeric = $false
                continue
            }
            foreach ($axis in @('x', 'y', 'z')) {
                $val = Get-MapValue $cornerNode $axis
                if ($null -eq $val -or $val -eq '') {
                    Bad $label "$corner.$axis 缺失"
                    $allNumeric = $false
                    continue
                }
                if (Test-Placeholder ([string]$val)) {
                    if ($AllowPlaceholders) { $script:specPlaceholders++ }
                    else { Bad $label "$corner.$axis 还是占位符 $val（线上文件不能有占位符）" }
                    $allNumeric = $false
                    continue
                }
                $dbl = 0.0
                if (-not [double]::TryParse([string]$val, [ref]$dbl)) {
                    Bad $label "$corner.$axis 不是数字：$val"
                    $allNumeric = $false
                    continue
                }
                if ($corner -eq 'min') { $mins[$axis] = $dbl } else { $maxs[$axis] = $dbl }
            }
        }

        if ($allNumeric -and $minNode -and $maxNode) {
            foreach ($axis in @('x', 'y', 'z')) {
                if ($mins.ContainsKey($axis) -and $maxs.ContainsKey($axis) -and $mins[$axis] -gt $maxs[$axis]) {
                    Bad $label "$axis：min($($mins[$axis])) > max($($maxs[$axis]))，这是个空区域"
                }
            }
        }
    }

    # ── flags：名字拼写 / 状态型取值 / chest-access 的坑 ──────────────────
    $flagsNode = Get-MapValue $Region 'flags'
    if ($null -ne $flagsNode -and (Test-IsMap $flagsNode)) {
        foreach ($flagKey in @(Get-MapKeys $flagsNode)) {
            $flagVal = $flagsNode[$flagKey]
            $isGroup = $false
            $baseFlag = $flagKey
            if ($flagKey.EndsWith('-group')) {
                $isGroup = $true
                $baseFlag = $flagKey.Substring(0, $flagKey.Length - 6)
            }
            if ($script:KnownFlags -notcontains $baseFlag) {
                Warn "$label flag" "不认识的 flag：$flagKey（拼错了 WorldGuard 会直接忽略，你以为设了其实没设）"
                continue
            }
            if (-not $isGroup -and ($script:StateFlags -contains $baseFlag)) {
                if ($null -ne $flagVal -and -not (Test-Placeholder ([string]$flagVal))) {
                    $fv = ([string]$flagVal).Trim().ToLower()
                    if ($fv -notin @('allow', 'deny', 'none')) {
                        Bad "$label flag" "$flagKey 是状态型 flag，只接受 allow/deny/none，给的是 $flagVal"
                    }
                }
            }
            if ($baseFlag -eq 'chest-access' -and $null -ne $flagVal -and ([string]$flagVal).Trim().ToLower() -eq 'allow') {
                Warn "$label flag" 'chest-access: allow 的默认作用组是 everyone —— 会让非成员也能开箱；成员本来就能开，删掉这条'
            }
        }
    }

    # ── 成员 / 属主 ───────────────────────────────────────────────────────
    foreach ($section in @('members', 'owners')) {
        $secNode = Get-MapValue $Region $section
        if (-not (Test-IsMap $secNode)) { continue }

        $groupsNode = Get-MapValue $secNode 'groups'
        if ((Test-IsList $groupsNode) -and $groupsNode.Count -gt 0) { $script:specUsesGroups = $true }

        $playersNode = Get-MapValue $secNode 'players'
        if (Test-IsList $playersNode) {
            foreach ($name in @($playersNode)) {
                if (Test-Placeholder ([string]$name)) {
                    if ($AllowPlaceholders) { $script:specPlaceholders++ }
                    else { Warn "$label 成员" "成员名是占位符 $name（线上文件里不会生效）" }
                    continue
                }
                [void]$script:specMemberRefs.Add(@{ Region = $RegionId; Section = $section; Name = [string]$name })
            }
        }
    }
}

# ══════════════════════════════════════════════════════════════════════════
# 1. 装没装
# ══════════════════════════════════════════════════════════════════════════
Section '1. 插件安装状态'

$wgJars = @()
$weJars = @()
if (Test-Path -LiteralPath $pluginDir -PathType Container) {
    $wgJars = @(Get-ChildItem -LiteralPath $pluginDir -File -Filter '*.jar' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^worldguard' })
    $weJars = @(Get-ChildItem -LiteralPath $pluginDir -File -Filter '*.jar' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^worldedit' })
}

$wgDataDir = Join-Path $pluginDir 'WorldGuard'
$wgDataDirExists = Test-Path -LiteralPath $wgDataDir -PathType Container
$wgInstalled = ($wgJars.Count -gt 0)

if (-not $wgInstalled) {
    if ($wgDataDirExists) {
        $docFiles = @(Get-ChildItem -LiteralPath $wgDataDir -Recurse -File -ErrorAction SilentlyContinue)
        Ok '安装状态' "未安装 WorldGuard（无 worldguard*.jar；$pluginDir\WorldGuard 只有 $($docFiles.Count) 个文档文件）"
        Info '该目录是本次交付的安装说明，不是插件本体；插件加载只看 plugins 顶层 jar。'
    }
    else {
        Ok '安装状态' "未安装 WorldGuard（$pluginDir 下无 worldguard*.jar）"
    }
    Info '未安装 = 待办，不是失败：本脚本按此退出码 0，其余检查（草案/白名单）照常做。'
}
else {
    Ok '安装状态' "发现 $($wgJars.Count) 个 worldguard jar：$(($wgJars | ForEach-Object { $_.Name }) -join ', ')"
    if ($wgJars.Count -gt 1) {
        Bad '单一版本' "plugins 下有 $($wgJars.Count) 个 worldguard jar —— 会互相顶掉，只加载一个；删到只剩一个"
    }
}

# 已经装了才谈依赖与版本；没装就跳过，避免用假版本报警
$wgVersion = $null
if ($wgInstalled) {
    $wgVersion = Get-JarVersion -FileName $wgJars[0].Name
    if ($null -eq $wgVersion) {
        Warn '版本解析' "文件名 $($wgJars[0].Name) 不符合 worldguard-bukkit-<major>.<minor>.<patch>[-dist].jar，无法判版本"
    }
    else {
        Ok 'WorldGuard 版本' "$($wgVersion.Base)$(if ($wgVersion.Suffix) { '-' + $wgVersion.Suffix } else { '' })"
        if ($wgVersion.IsPre) {
            Warn '预发布版' '装的是 beta/rc —— 真机排障会多一倍变量，日常请用正式版'
        }
    }

    if ($weJars.Count -eq 0) {
        Bad 'WorldEdit 依赖' '没装 WorldEdit —— WorldGuard 官方要求必须装，否则直接加载失败'
    }
    else {
        Ok 'WorldEdit 依赖' "发现 $(($weJars | ForEach-Object { $_.Name }) -join ', ')"
        if ($weJars.Count -gt 1) {
            Bad 'WorldEdit 单一版本' "plugins 下有 $($weJars.Count) 个 worldedit jar"
        }
    }
}

# ══════════════════════════════════════════════════════════════════════════
# 2. 版本配不配
# ══════════════════════════════════════════════════════════════════════════
Section '2. 版本与 Minecraft 是否匹配'

$mc = Get-MinecraftVersion -ServerDirPath $ServerDir
if ($mc.Version) {
    Ok 'Minecraft 版本' "$($mc.Version)（来源：$($mc.Source)）"
}
else {
    Warn 'Minecraft 版本' '既没从 paper-*.jar 文件名也没从 logs/latest.log 取到；跳过兼容性比对'
}

if ($mc.Version -and $wgInstalled -and $wgVersion) {
    $base = $wgVersion.Base
    if ($script:WgCompatibility.Contains($base)) {
        $supported = @($script:WgCompatibility[$base])
        if ($supported -contains $mc.Version) {
            Ok 'WorldGuard ↔ MC' "WorldGuard $base 官方支持 $($supported -join ' / ')，当前 $($mc.Version) 在列表内"
        }
        else {
            Bad 'WorldGuard ↔ MC' "WorldGuard $base 只支持 $($supported -join ' / ')，当前是 $($mc.Version) —— 加载期可能 UnsupportedClassVersionError / 静默不生效"
            Info '1.21.8 应装 WorldGuard 7.0.14（7.0.15 起只支持 1.21.10+）。见 server/plugins/WorldGuard/README-安装.md'
        }
    }
    else {
        Warn 'WorldGuard ↔ MC' "内置表里没有 $base（表为 2026-11 快照），请人工核对官方发布页"
    }

    # WorldEdit 7.4.x 明确要求 WorldGuard 7.0.15+，而 1.21.8 只能跑 7.0.14 → 交叉矛盾
    if ($weJars.Count -gt 0) {
        $weVersion = Get-JarVersion -FileName $weJars[0].Name
        if ($weVersion -and $weVersion.Numeric -ge (New-Object System.Version '7.4.0') -and $mc.Version -eq '1.21.8') {
            Bad 'WorldEdit ↔ WorldGuard' "WorldEdit $($weVersion.Base) 要求 WorldGuard 7.0.15+，但 1.21.8 只能用 7.0.14 —— 换 WorldEdit 7.3.16"
        }
        elseif ($weVersion -and $weVersion.Numeric -lt (New-Object System.Version '7.3.0')) {
            Warn 'WorldEdit 版本偏低' "$($weVersion.Base) 早于 7.3.x，1.21.8 上不支持"
        }
    }
}

# ══════════════════════════════════════════════════════════════════════════
# 3. 配置能不能解析
# ══════════════════════════════════════════════════════════════════════════
Section '3. 配置解析'

$props = Read-ServerProperties -Path (Join-Path $ServerDir 'server.properties')
$levelName = Get-MapValue $props 'level-name'
if (-not $levelName) { $levelName = 'world' }

# 3.1 插件配置（只有装了才有）
if ($wgInstalled) {
    $cfgPath = Join-Path $wgDataDir 'config.yml'
    if (-not (Test-Path -LiteralPath $cfgPath)) {
        Warn 'WorldGuard config.yml' '还不存在（首次启动后才生成，正常）'
    }
    else {
        $cfg = Read-YamlFile -Path $cfgPath
        if ($cfg.Errors.Count -gt 0) {
            Bad 'WorldGuard config.yml 可解析' (($cfg.Errors | Select-Object -First 3) -join ' | ')
        }
        elseif ($cfg.Dups.Count -gt 0) {
            Warn 'WorldGuard config.yml 重复键' (($cfg.Dups | Select-Object -First 3) -join ' | ')
        }
        else {
            Ok 'WorldGuard config.yml 可解析' "$($cfg.Lines) 行，无语法错误"
        }

        $moveEvent = Get-MapValue (Get-MapValue $cfg.Tree 'use-player-move-event') 'use-player-move-event'
        if ($moveEvent -is [string] -and $moveEvent -eq 'false') {
            Warn 'use-player-move-event=false' 'greeting/farewell/heal/feed 这类 flag 依赖移动事件，关掉后静默不生效'
        }

        $sqlUse = Get-MapValue (Get-MapValue (Get-MapValue $cfg.Tree 'regions') 'sql') 'use'
        if ($sqlUse -is [string] -and $sqlUse -eq 'true') {
            Warn 'regions.sql.use=true' '官方文档明确不推荐用 SQL 存区域（"highly recommended to never use"），建议回 YAML'
        }
    }
}

# 3.2 线上区域数据（每个世界一份）
$regionFiles = @()
if ($wgDataDirExists) {
    $worldsRoot = Join-Path $wgDataDir 'worlds'
    if (Test-Path -LiteralPath $worldsRoot -PathType Container) {
        foreach ($worldDir in @(Get-ChildItem -LiteralPath $worldsRoot -Directory -ErrorAction SilentlyContinue)) {
            foreach ($candidate in @('regions.yml', 'region.yml')) {
                $p = Join-Path $worldDir.FullName $candidate
                if (Test-Path -LiteralPath $p) {
                    $regionFiles += @{ Path = $p; World = $worldDir.Name; Name = $candidate }
                }
            }
        }
    }
}

if ($wgInstalled) {
    if ($regionFiles.Count -eq 0) {
        Warn '线上区域数据' "没有 worlds/*/regions.yml（还没建区域，正常；建完 /rg list 应有输出）"
    }
    else {
        foreach ($rf in $regionFiles) {
            $parsed = Read-YamlFile -Path $rf.Path
            $label = "区域文件 $($rf.World)/$($rf.Name)"
            if ($parsed.Errors.Count -gt 0) {
                Bad "$label 可解析" (($parsed.Errors | Select-Object -First 3) -join ' | ')
                continue
            }
            $regionsNode = Get-MapValue $parsed.Tree 'regions'
            if (-not (Test-IsMap $regionsNode)) {
                Bad "$label 结构" '顶层缺 regions: 映射（WorldGuard 的 YAML 存储要求这一层）'
                continue
            }
            Ok "$label 可解析" "$($parsed.Lines) 行，$((Get-MapKeys $regionsNode).Count) 个区域"
            if ($rf.World -ne $levelName) {
                Warn "$label 世界名" "目录名字是 $($rf.World)，但 server.properties 的 level-name=$levelName —— 这套区域不会在当前世界生效"
            }
        }
    }
}

# 3.3 仓库区域草案（无论装没装都查：这是给人填的东西）
$draftPlaceholders = 0
$draftRegions = 0
$draftAllowsGroups = $false
$draftMemberNames = @()

if (-not (Test-Path -LiteralPath $draftPath)) {
    Warn '区域草案' "找不到 config/worldguard-regions.yml（应随本次交付存在）"
}
else {
    $draft = Read-YamlFile -Path $draftPath
    if ($draft.Errors.Count -gt 0) {
        Bad '区域草案 可解析' (($draft.Errors | Select-Object -First 5) -join ' | ')
    }
    else {
        Ok '区域草案 可解析' "$($draft.Lines) 行，无语法/TAB 问题"
    }
    if ($draft.Dups.Count -gt 0) {
        Bad '区域草案 重复键' (($draft.Dups | Select-Object -First 5) -join ' | ')
    }

    $draftWorld = Get-MapValue $draft.Tree 'world'
    if ($draftWorld -is [string]) {
        if (Test-Placeholder $draftWorld) {
            Warn '区域草案 world' "world 还是占位符 $draftWorld —— 落地前填成 $levelName"
        }
        elseif ($draftWorld -ne $levelName) {
            Warn '区域草案 world' "world=$draftWorld，与 server.properties 的 level-name=$levelName 不一致"
        }
        else {
            Ok '区域草案 world' $draftWorld
        }
    }

    $draftRegionsNode = Get-MapValue $draft.Tree 'regions'
    if (-not (Test-IsMap $draftRegionsNode)) {
        Bad '区域草案 结构' '顶层缺 regions: 映射'
    }
    else {
        $ids = @(Get-MapKeys $draftRegionsNode)
        $draftRegions = $ids.Count
        if ($ids.Count -eq 0) { Bad '区域草案 结构' 'regions: 是空的' }

        foreach ($id in $ids) {
            $region = $draftRegionsNode[$id]
            if (-not (Test-IsMap $region)) {
                Bad "区域草案 $id" '不是一个映射'
                continue
            }
            $type = Get-MapValue $region 'type'
            if (-not $type) {
                Bad "区域草案 $id" '缺 type（cuboid / global）'
            }
            elseif ($type -notin @('cuboid', 'global', 'poly2d', 'prism')) {
                Bad "区域草案 $id" "未知 type：$type"
            }

            $priority = Get-MapValue $region 'priority'
            if ($null -eq $priority -or $priority -eq '') {
                Warn "区域草案 $id" '没写 priority（默认 0，重叠时会被别的区域盖掉）'
            }
            else {
                $pInt = 0
                if (-not [int]::TryParse([string]$priority, [ref]$pInt)) {
                    Bad "区域草案 $id" "priority 不是整数：$priority"
                }
            }

            if ($type -eq 'global' -and $id -ne '__global__') {
                Warn "区域草案 $id" "type=global 但 id 不是 __global__"
            }

            # 立方体边界
            if ($type -eq 'cuboid') {
                foreach ($corner in @('min', 'max')) {
                    $cornerNode = Get-MapValue $region $corner
                    if (-not (Test-IsMap $cornerNode)) {
                        Bad "区域草案 $id" "缺 $corner（或不是 x/y/z 映射）"
                        continue
                    }
                    foreach ($axis in @('x', 'y', 'z')) {
                        $val = Get-MapValue $cornerNode $axis
                        if ($null -eq $val -or $val -eq '') {
                            Bad "区域草案 $id" "$corner.$axis 缺失"
                            continue
                        }
                        if (Test-Placeholder ([string]$val)) { $draftPlaceholders++; continue }
                        $dbl = 0.0
                        if (-not [double]::TryParse([string]$val, [ref]$dbl)) {
                            Bad "区域草案 $id" "$corner.$axis 不是数字：$val"
                        }
                    }
                }
                $minNode = Get-MapValue $region 'min'
                $maxNode = Get-MapValue $region 'max'
                if ((Test-IsMap $minNode) -and (Test-IsMap $maxNode)) {
                    $allNumeric = $true
                    $mins = @{}
                    $maxs = @{}
                    foreach ($axis in @('x', 'y', 'z')) {
                        $mv = Get-MapValue $minNode $axis
                        $xv = Get-MapValue $maxNode $axis
                        if ($null -eq $mv -or $null -eq $xv) { $allNumeric = $false; continue }
                        if ((Test-Placeholder ([string]$mv)) -or (Test-Placeholder ([string]$xv))) { $allNumeric = $false; continue }
                        $a = 0.0
                        $b = 0.0
                        if ([double]::TryParse([string]$mv, [ref]$a) -and [double]::TryParse([string]$xv, [ref]$b)) {
                            $mins[$axis] = $a
                            $maxs[$axis] = $b
                        }
                        else { $allNumeric = $false }
                    }
                    if ($allNumeric) {
                        foreach ($axis in @('x', 'y', 'z')) {
                            if ($mins.ContainsKey($axis) -and $maxs.ContainsKey($axis) -and $mins[$axis] -gt $maxs[$axis]) {
                                Bad "区域草案 $id" "$axis：min($($mins[$axis])) > max($($maxs[$axis]))，这是个空区域"
                            }
                        }
                    }
                }
            }

            # flags
            $flagsNode = Get-MapValue $region 'flags'
            if ($null -ne $flagsNode -and (Test-IsMap $flagsNode)) {
                foreach ($flagKey in @(Get-MapKeys $flagsNode)) {
                    $flagVal = $flagsNode[$flagKey]
                    $isGroup = $false
                    $baseFlag = $flagKey
                    if ($flagKey.EndsWith('-group')) {
                        $isGroup = $true
                        $baseFlag = $flagKey.Substring(0, $flagKey.Length - 6)
                    }
                    if ($script:KnownFlags -notcontains $baseFlag) {
                        Warn "区域草案 $id flag" "不认识的 flag：$flagKey（拼错了 WorldGuard 会直接忽略）"
                        continue
                    }
                    if (-not $isGroup -and ($script:StateFlags -contains $baseFlag)) {
                        if ($null -ne $flagVal -and -not (Test-Placeholder ([string]$flagVal))) {
                            $fv = ([string]$flagVal).Trim().ToLower()
                            if ($fv -notin @('allow', 'deny', 'none')) {
                                Bad "区域草案 $id flag" "$flagKey 是状态型 flag，只接受 allow/deny/none，给的是 $flagVal"
                            }
                        }
                    }
                    if ($baseFlag -eq 'chest-access' -and $null -ne $flagVal -and ([string]$flagVal).Trim().ToLower() -eq 'allow') {
                        Warn "区域草案 $id flag" 'chest-access: allow 的默认作用组是 everyone —— 会让非成员也能开箱；成员本来就能开，删掉这条'
                    }
                }
            }

            # 成员 / 属主
            foreach ($section in @('members', 'owners')) {
                $secNode = Get-MapValue $region $section
                if (-not (Test-IsMap $secNode)) { continue }
                $groupsNode = Get-MapValue $secNode 'groups'
                if ((Test-IsList $groupsNode) -and $groupsNode.Count -gt 0) {
                    $draftAllowsGroups = $true
                }
                $playersNode = Get-MapValue $secNode 'players'
                if (Test-IsList $playersNode) {
                    foreach ($name in @($playersNode)) {
                        if (Test-Placeholder ([string]$name)) { $draftPlaceholders++; continue }
                        $draftMemberNames += @{ Region = $id; Section = $section; Name = [string]$name }
                    }
                }
            }
        }

        if ($draftPlaceholders -gt 0) {
            Warn '区域草案 未填项' "还有 $draftPlaceholders 处占位符未填 —— 未填 = 未生效，别当成已经保护好了"
        }
        else {
            Ok '区域草案 未填项' '没有残留占位符'
        }
        Ok '区域草案 规模' "$draftRegions 个区域"
    }
}

# ══════════════════════════════════════════════════════════════════════════
# 4. 与白名单 / 权限的矛盾
# ══════════════════════════════════════════════════════════════════════════
Section '4. 白名单 / 权限一致性'

# ⚠️ PowerShell 变量名不区分大小写：这里不能叫 $whiteList —— 会和下面的 $whitelist
# （whitelist.json 解析出来的数组）撞成同一个变量，于是 'true' 被数组覆盖，
# 4.1 的准入开关判断永远走 else 分支（第一版实测踩到过，输出 white-list=false 而文件里是 true）。
$onlineModeProp = Get-MapValue $props 'online-mode'
$whiteListProp = Get-MapValue $props 'white-list'
$enforceWhiteListProp = Get-MapValue $props 'enforce-whitelist'
$spawnProtectionProp = Get-MapValue $props 'spawn-protection'

# ⚠️ 不要再套 @(...)：Read-JsonList 内部已经 return @(...)，外面再包一层会把整个数组
# 当成"一个元素"（实测：16 条白名单被读成 1 条，进而让 4.2 的 v3 统计完全失真）。
# 空文件时函数什么也不返回，这里兜个底。
$whitelist = Read-JsonList -Path (Join-Path $ServerDir 'whitelist.json')
if ($null -eq $whitelist) { $whitelist = @() }
$ops = Read-JsonList -Path (Join-Path $ServerDir 'ops.json')
if ($null -eq $ops) { $ops = @() }

$wlNames = @()
$wlUuids = @()
$v3Count = 0
foreach ($entry in $whitelist) {
    if ($entry -and $entry.name) { $wlNames += [string]$entry.name }
    if ($entry -and $entry.uuid) {
        $u = [string]$entry.uuid
        $wlUuids += $u
        $flat = $u.Replace('-', '')
        if ($flat.Length -ge 13 -and $flat[12] -eq '3') { $v3Count++ }
    }
}
Ok 'whitelist.json' "$($whitelist.Count) 条记录（名字 $($wlNames.Count)，UUID $($wlUuids.Count)）"
if ($whitelist.Count -eq 0) { Warn 'whitelist.json' '读不到或为空 —— 下面的成员比对会失去基准' }

# 4.1 准入开关自洽性
if ($whiteListProp -eq 'true') {
    if ($enforceWhiteListProp -eq 'true') {
        Ok '准入开关' 'white-list=true 且 enforce-whitelist=true'
    }
    else {
        Warn '准入开关' 'white-list=true 但 enforce-whitelist=false：已在服里的人被移出白名单也不会被踢，等于只挡新登录'
    }
}
else {
    Warn '准入开关' 'white-list=false —— 任何能连端口的人都能进，WorldGuard 是唯一的事前限制（而它还没装）'
}

if ($spawnProtectionProp -eq '0') {
    Info 'spawn-protection=0：出生点没有任何原版保护，访客区完全依赖 WorldGuard'
}

# 4.2 online-mode 与 UUID 版本（离线模式的身份局限）
if ($onlineModeProp -eq 'false') {
    if ($v3Count -eq $whitelist.Count -and $whitelist.Count -gt 0) {
        Ok 'online-mode/UUID 自洽' "online-mode=false，$v3Count/$($whitelist.Count) 个 UUID 是离线派生 v3 —— 自洽"
    }
    elseif ($v3Count -gt 0) {
        Warn 'online-mode/UUID 混合' "online-mode=false，但只有 $v3Count/$($whitelist.Count) 个 UUID 是 v3（混了正版 UUID）"
    }
    Warn '离线模式局限' 'online-mode=false 下用户名由客户端自报，UUID 由名字派生：谁用这个名字谁就是这个 UUID。区域成员/白名单都只防手滑，不防顶替'
}
else {
    if ($v3Count -gt 0) {
        Bad 'online-mode/UUID 矛盾' "online-mode=true，但白名单里有 $v3Count 个离线 v3 UUID —— 这些人正版登录时 UUID 对不上，会被挡或掉权限"
    }
    else {
        Ok 'online-mode/UUID 自洽' 'online-mode=true，白名单 UUID 非离线派生'
    }
}

# 4.3 有没有人能管区域
$maxOpLevel = 0
foreach ($o in $ops) {
    if ($o -and $null -ne $o.level) {
        $lv = 0
        if ([int]::TryParse([string]$o.level, [ref]$lv) -and $lv -gt $maxOpLevel) { $maxOpLevel = $lv }
    }
}
$permPluginJars = @()
if (Test-Path -LiteralPath $pluginDir -PathType Container) {
    $permPluginJars = @(Get-ChildItem -LiteralPath $pluginDir -File -Filter '*.jar' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match 'luckperms|permissionsex|groupmanager|privileges|bpermissions' })
}
if ($maxOpLevel -ge 2) {
    Ok '区域管理权限' "ops.json 最高 level=$maxOpLevel（level>=2 可用 /rg 命令）"
}
elseif ($permPluginJars.Count -gt 0) {
    Ok '区域管理权限' "无高等级 op，但有权限插件：$(($permPluginJars | ForEach-Object { $_.Name }) -join ', ')"
}
else {
    Bad '区域管理权限' 'ops.json 里没有 level>=2 的玩家，也没有权限插件 —— 装上 WorldGuard 后没人能在游戏内建区域'
}

# 4.4 区域成员是否真能进服
if ($draftMemberNames.Count -gt 0) {
    $missing = @()
    foreach ($m in $draftMemberNames) {
        if ($wlNames -notcontains $m.Name) { $missing += "$($m.Region)/$($m.Section)=$($m.Name)" }
    }
    if ($missing.Count -gt 0) {
        Warn '草案成员不在白名单' "$($missing.Count) 处：$(($missing | Select-Object -First 8) -join ', ')"
        Info '这些人进不来服，成员关系等于空的；先决定是加白名单还是改区域成员。'
    }
    else {
        Ok '草案成员都在白名单' "$($draftMemberNames.Count) 处引用都能对上名字"
    }
}
elseif ($draftRegions -gt 0) {
    Warn '草案成员' '草案里没有任何实名成员（全是占位符或空）—— 落地前必须填'
}

if ($draftAllowsGroups -and $permPluginJars.Count -eq 0) {
    Warn 'owners.groups 无效' '区域草案用了 groups，但本服没有权限插件 —— WorldGuard 的组名来自权限系统，组里没人就是空'
}

# 4.5 线上区域文件：规格校验 + 成员与白名单一致性（装了才有）
# 第一版这里只查了"能不能解析"，于是 min>max、pvp: maybe、bulid 拼写错误、
# chest-access: allow、成员不在白名单全被放过，还打印"成员与白名单一致"—— 假绿灯。
foreach ($rf in $regionFiles) {
    $parsed = Read-YamlFile -Path $rf.Path
    $regionsNode = Get-MapValue $parsed.Tree 'regions'
    if (-not (Test-IsMap $regionsNode)) { continue }

    Reset-SpecCounters
    foreach ($rid in @(Get-MapKeys $regionsNode)) {
        Test-RegionSpec -RegionId $rid -Region $regionsNode[$rid] -Context "线上 $($rf.World)/$($rf.Name)"
    }

    # 名字类成员（WorldGuard 也允许用 -n 只存名字）
    $orphanNames = @()
    foreach ($m in $script:specMemberRefs) {
        if ($wlNames -notcontains $m.Name) { $orphanNames += "$($m.Region)/$($m.Section)=$($m.Name)" }
    }
    if ($orphanNames.Count -gt 0) {
        Warn "线上区域成员名字不在白名单（$($rf.World)）" "$($orphanNames.Count) 处：$(($orphanNames | Select-Object -First 8) -join ', ')"
    }
    elseif ($script:specMemberRefs.Count -gt 0) {
        Ok "线上区域成员名字在白名单（$($rf.World)）" "$($script:specMemberRefs.Count) 处引用都能对上"
    }
    else {
        Info "区域文件 $($rf.World)/$($rf.Name)：没有按名字记的成员（可能只用了 UUID 或组）"
    }

    # UUID 类成员
    $wlUuidsLower = @($wlUuids | ForEach-Object { $_.ToLower() })
    $orphanUuids = @()
    foreach ($rid in @(Get-MapKeys $regionsNode)) {
        $rnode = $regionsNode[$rid]
        if (-not (Test-IsMap $rnode)) { continue }
        foreach ($section in @('members', 'owners')) {
            $secNode = Get-MapValue $rnode $section
            if (-not (Test-IsMap $secNode)) { continue }
            $ids = Get-MapValue $secNode 'unique-ids'
            if (Test-IsList $ids) {
                foreach ($u in @($ids)) {
                    $us = ([string]$u).Trim().ToLower()
                    if ($us -ne '' -and $wlUuidsLower -notcontains $us) {
                        $orphanUuids += "$rid=$us"
                    }
                }
            }
        }
    }
    if ($orphanUuids.Count -gt 0) {
        Warn "线上区域成员 UUID 不在白名单（$($rf.World)）" "$($orphanUuids.Count) 处：$(($orphanUuids | Select-Object -First 8) -join ', ')"
    }
    elseif ($wlUuids.Count -gt 0) {
        Ok "线上区域成员 UUID 在白名单（$($rf.World)）" '引用的 UUID 都能对上'
    }

    if ($script:specUsesGroups -and $permPluginJars.Count -eq 0) {
        Warn "线上 regions.yml 用了组（$($rf.World)）" 'owners/members 里写了 groups，但本服没有权限插件 —— 组名解析不到人，等于空的'
    }
}

# ══════════════════════════════════════════════════════════════════════════
# 汇总
# ══════════════════════════════════════════════════════════════════════════
Write-Host ''
Write-Host '──── 汇总 ' -ForegroundColor Cyan
if (-not $wgInstalled) {
    Write-Host 'WorldGuard: 未安装（事前限制目前是空的，只有白名单 + CoreProtect 事后）' -ForegroundColor Yellow
    Write-Host '  安装路径: server/plugins/WorldGuard/README-安装.md' -ForegroundColor DarkGray
}
else {
    Write-Host 'WorldGuard: 已安装' -ForegroundColor Green
}
Write-Host ''
Write-Host ("PASS {0} / WARN {1} / FAIL {2}" -f $script:pass, $script:warn, $script:fail)
Write-Host 'MODE=read-only：本脚本没有写入任何文件、没有启停服务器、没有连 RCON' -ForegroundColor DarkGray

if ($script:fail -gt 0) {
    Write-Host '有硬矛盾，exit 1' -ForegroundColor Red
    exit 1
}
Write-Host '没有硬矛盾，exit 0' -ForegroundColor Green
exit 0
