# Minecraft AI 陪玩面板 —— 凭据文件 ACL 加固
#
# ★ OPS-004（2026-11-06 深度检查）[P1]
#
# 缺陷原貌：实测这三个文件的 DACL 都是从父目录**继承**来的，包含
#     NT AUTHORITY\Authenticated Users | Modify
#     BUILTIN\Users                  | ReadAndExecute
#   ⇒ 同一台 Windows 主机上的另一个非管理员账户**能读**控制台令牌、模型 API Key、RCON 密码，
#     而且**能改**（改 RCON 密码 = 让优雅关服失效；改 token = 抢控制台）。
#   mindserver.js 给 token 文件设的 POSIX mode 0600 在 NTFS 上完全不生效，
#   报告里那句"看起来设了权限其实没设"就是这个。
#
# 修法：把这三个文件的 DACL 改成**非继承**，只留三类主体：
#     当前账户（应用自己以它运行）、SYSTEM、Administrators。
#   不碰父目录（默认）：NTFS 判断"能不能读这个文件"看的是文件自己的 DACL，
#   目录只提供"能不能穿过"，所以文件级收口就够，且不会把 git / 编辑器搞坏。
#
# 用法：
#   powershell -NoProfile -File scripts\harden-credentials-acl.ps1            # 只体检，不改（默认）
#   powershell -NoProfile -File scripts\harden-credentials-acl.ps1 -Apply     # 真的改
#   powershell -NoProfile -File scripts\harden-credentials-acl.ps1 -Apply -IncludeParents
#
# 回滚（任意一项）：
#   icacls <文件> /inheritance:e          # 恢复继承
#   再按需 icacls <文件> /remove:g "Users" "Authenticated Users" 之类微调
#
# 幂等：重复跑不会叠加 ACE（每轮先清掉该文件上的显式规则再写回固定的三条）。

[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$IncludeParents,
    # ★ R5-010：对 $dirTargets 做「去写保读」收口 —— 去掉 Authenticated Users 等非白名单主体的写/删权限
    #   （否则别人可以删掉 keys.json 再放一个），但**保留 读+遍历**（git / 编辑器 / node 仍要能读）。
    #   与 -IncludeParents（把目录整体锁成三条 FullControl）是两种强度，互不覆盖。
    [switch]$GuardParentWrites
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot
$me   = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

# 三个真实存在的凭据/隐私文件（报告点名的位置）
# R6 #55：覆盖面。人设文件可能内嵌 API Key、vault 有盐、config 有准入策略。
$fileTargets = @(
    'mindcraft\.mindserver-token',
    'mindcraft\keys.json',
    'server\server.properties',
    'server-test\server.properties',
    'mindcraft\profiles\*.json',
    'mindcraft\.env*',
    'mindcraft\vault\*',
    'config\*.json'
)
$dirTargets = @('mindcraft')

# 允许的三类主体
$allowed = @($me, 'NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators')

# 判定"这个 ACE 该不该消失"：主体不在允许清单里就算问题
# 只读类权限（R5-010：目录上保留 读+遍历 是**允许**的，只有写/删才算过宽）
$readOnlyRights = @('ReadAndExecute', 'Read', 'ReadAndExecute, Synchronize', 'Read, Synchronize')

function Get-Verdict([System.Security.AccessControl.FileSystemAccessRule]$rule, [bool]$allowReadOnlyForOthers = $false) {
    $id = $rule.IdentityReference.Value
    if ($allowed -contains $id) { return 'ok' }
    if ($rule.AccessControlType -eq 'Deny') { return 'ok' }   # 显式拒绝不构成放开
    if ($allowReadOnlyForOthers -and ($readOnlyRights -contains $rule.FileSystemRights.ToString())) { return 'ok-readonly' }
    return 'too-broad'
}

function Show-Acl([string]$path, [bool]$allowReadOnlyForOthers = $false) {
    $acl = Get-Acl -Path $path
    $inherited = -not $acl.AreAccessRulesProtected
    Write-Host ("  DACL: {0}" -f $(if ($inherited) { '继承父目录（需要收口）' } else { '非继承（已收口）' })) `
        -ForegroundColor $(if ($inherited) { 'Yellow' } else { 'Green' })
    foreach ($rule in $acl.Access) {
        $v = Get-Verdict $rule $allowReadOnlyForOthers
        $mark = if ($v -eq 'ok') { '  ok ' } elseif ($v -eq 'ok-readonly') { '  ro ' } else { '  !! ' }
        $color = if ($v -eq 'ok') { 'DarkGray' } elseif ($v -eq 'ok-readonly') { 'DarkCyan' } else { 'Red' }
        Write-Host ("{0}{1} | {2} | {3} | 继承={4}" -f $mark, $rule.IdentityReference.Value,
            $rule.FileSystemRights, $rule.AccessControlType, $rule.IsInherited) -ForegroundColor $color
    }
    return ($acl.Access | Where-Object { (Get-Verdict $_ $allowReadOnlyForOthers) -notin @('ok', 'ok-readonly') }).Count
}

function Test-NeedsHardening([string]$path, [bool]$allowReadOnlyForOthers = $false) {
    $acl = Get-Acl -Path $path
    if (-not $acl.AreAccessRulesProtected) { return $true }
    return (@($acl.Access | Where-Object { (Get-Verdict $_ $allowReadOnlyForOthers) -eq 'too-broad' }).Count -gt 0)
}

function Set-HardenedAcl([string]$path, [bool]$isDir) {
    $acl = Get-Acl -Path $path

    # 1) 断开继承，并且**不保留**已继承的规则
    $acl.SetAccessRuleProtection($true, $false)

    # 2) 清掉所有现存的显式规则（先快照成数组再删，边遍历边删会漏）
    $existing = @($acl.Access)
    foreach ($rule in $existing) {
        [void]$acl.RemoveAccessRule($rule)
    }

    # 3) 只写回三条：当前账户 / SYSTEM / Administrators
    $inheritFlags = if ($isDir) {
        [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else {
        [System.Security.AccessControl.InheritanceFlags]'None'
    }
    $propagation = if ($isDir) {
        [System.Security.AccessControl.PropagationFlags]'None'
    } else {
        [System.Security.AccessControl.PropagationFlags]'None'
    }
    foreach ($id in $allowed) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $id,
            [System.Security.AccessControl.FileSystemRights]'FullControl',
            $inheritFlags,
            $propagation,
            [System.Security.AccessControl.AccessControlType]'Allow'
        )
        $acl.AddAccessRule($rule)
    }

    Set-Acl -Path $path -AclObject $acl
}

# ── R5-010：目录的「去写保读」收口 ───────────────────────────────────────────
#
# 为什么不能直接用 Set-HardenedAcl：那会把目录锁成「只有三条 FullControl」，
# 把 读/遍历 也一起收回 —— git、编辑器、node 都可能因为读不到而报错，
# 属于「修安全问题顺手把工具链弄坏」。
#
# R5-010 要挡的是**写**：Authenticated Users:(M) 意味着别人可以把 keys.json
# 删掉再放一个（文件自身 ACL 收得再紧也没用，因为目录允许 DeleteChild）。
# 所以这里：断开继承 → 清空 → 白名单三条 FullControl（含子对象）
#           → 其他已认证账户只留 ReadAndExecute（读+遍历，不含写/删）。
function Set-DirWriteGuard([string]$path) {
    # ★ 用 icacls 而不是 Set-Acl：
    #   Set-Acl 会连 **SACL** 一起写，非管理员进程没有 SeSecurityPrivilege 就会直接失败
    #   （实测报 "The process does not possess the SeSecurityPrivilege privilege"）。
    #   而 R5-010 要的本来只是「去掉目录上的写权限」，icacls 只动 DACL，正好够用、也不需要提权。
    $who = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

    # 1) 断开继承，并且**不保留**继承来的规则
    & icacls $path /inheritance:r | Out-Null
    if ($LASTEXITCODE -ne 0) { throw ("icacls /inheritance:r 失败：" + $path) }

    # 2) 摘掉所有「已认证账户 / Users」的 ACE（里面就含着 Modify）
    #    remove 对"本来就没有"的主体返回非 0，这里不当作失败。
    & icacls $path /remove:g "NT AUTHORITY\Authenticated Users" "BUILTIN\Users" | Out-Null

    # 3) 白名单三条 FullControl（含子对象）+ 其他已认证账户只读（读+遍历，不含写/删）
    $grants = @(
        ($who + ":(OI)(CI)F"),
        "NT AUTHORITY\SYSTEM:(OI)(CI)F",
        "BUILTIN\Administrators:(OI)(CI)F",
        "NT AUTHORITY\Authenticated Users:(OI)(CI)RX"
    )
    & icacls $path /grant:r $grants | Out-Null
    if ($LASTEXITCODE -ne 0) { throw ("icacls /grant:r 失败：" + $path) }
}

Write-Host '============================================================' -ForegroundColor DarkCyan
Write-Host '  凭据文件 ACL 加固（OPS-004）' -ForegroundColor White
Write-Host ("  模式：{0}" -f $(if ($Apply) { 'APPLY（会真的改）' } else { '体检（不改；加 -Apply 才动手）' })) -ForegroundColor $(if ($Apply) { 'Yellow' } else { 'Gray' })
Write-Host ("  当前账户：{0}" -f $me) -ForegroundColor DarkGray
Write-Host '============================================================' -ForegroundColor DarkCyan
Write-Host ''

$targets = @()
foreach ($rel in $fileTargets) {
    # R6 #55：支持通配（profiles\*.json / vault\* / .env*），逐个展开成真实文件。
    if ($rel -match '[*?]') {
        $hits = @(Get-Item -Path (Join-Path $root $rel) -ErrorAction SilentlyContinue | Where-Object { -not $_.PSIsContainer })
        if ($hits.Count -eq 0) { Write-Host ("[跳过] 无匹配：{0}" -f $rel) -ForegroundColor DarkYellow; continue }
        foreach ($h in $hits) { $targets += [pscustomobject]@{ Path = $h.FullName; Dir = $false; Mode = 'file' } }
        continue
    }
    $p = Join-Path $root $rel
    if (Test-Path -LiteralPath $p) { $targets += [pscustomobject]@{ Path = $p; Dir = $false; Mode = 'file' } }
    else { Write-Host ("[跳过] 不存在：{0}" -f $rel) -ForegroundColor DarkYellow }
}
# ★ R5-009/R5-010：文件目标记 Mode='file'；目录目标按开关记 'lockdown' 或 'writeguard'
if ($IncludeParents -or $GuardParentWrites) {
    foreach ($rel in $dirTargets) {
        $p = Join-Path $root $rel
        if (Test-Path -LiteralPath $p) {
            $mode = if ($IncludeParents) { 'lockdown' } else { 'writeguard' }
            $targets += [pscustomobject]@{ Path = $p; Dir = $true; Mode = $mode }
        }
    }
}

$problems = 0
foreach ($t in $targets) {
    Write-Host ("--- {0}" -f $t.Path) -ForegroundColor Cyan
    $problems += Show-Acl $t.Path ($t.Mode -eq 'writeguard')
    Write-Host ''
}

if (-not $Apply) {
    if ($problems -gt 0) {
        Write-Host ("[体检结果] 发现 {0} 条过宽 ACE。跑一次加 -Apply 收口：" -f $problems) -ForegroundColor Yellow
        Write-Host '            powershell -NoProfile -File scripts\harden-credentials-acl.ps1 -Apply' -ForegroundColor Yellow
        exit 3
    }
    Write-Host '[体检结果] 已经是收口状态，无需改动。' -ForegroundColor Green
    exit 0
}

foreach ($t in $targets) {
    $allowRo = ($t.Mode -eq 'writeguard')
    if (-not (Test-NeedsHardening $t.Path $allowRo)) {
        Write-Host ("[已是收口] {0}" -f $t.Path) -ForegroundColor Green
        continue
    }
    if ($t.Mode -eq 'writeguard') {
        Write-Host ("[去写保读] {0}" -f $t.Path) -ForegroundColor Yellow
        Set-DirWriteGuard $t.Path
    } else {
        Write-Host ("[加固] {0}" -f $t.Path) -ForegroundColor Yellow
        Set-HardenedAcl -path $t.Path -isDir $t.Dir
    }
}

Write-Host ''
Write-Host '--- 复验 ---' -ForegroundColor Cyan
$after = 0
foreach ($t in $targets) {
    Write-Host ("--- {0}" -f $t.Path) -ForegroundColor Cyan
    $after += Show-Acl $t.Path ($t.Mode -eq 'writeguard')
    Write-Host ''
}

if ($after -gt 0) {
    Write-Host ("[结果] 仍有 {0} 条过宽 ACE —— 没修干净，请人工核对。" -f $after) -ForegroundColor Red
    exit 4
}

Write-Host '--- 应用可用性自检 ---' -ForegroundColor Cyan
# 加固后必须确认"当前账户"仍能读写（应用就是用它跑的），否则等于把应用自己锁在外面。
$rwOk = $true
foreach ($t in $targets | Where-Object { -not $_.Dir }) {
    try {
        $bytes = [System.IO.File]::ReadAllBytes($t.Path)
        if ($bytes.Length -eq 0) { throw '读到了空文件' }
        # 以"追加 0 字节"的方式验证可写，不改内容也不动修改时间之外的任何东西
        $fs = [System.IO.File]::Open($t.Path, 'Open', 'Write', 'ReadWrite')
        $fs.Close()
        Write-Host ("  ok  可读可写：{0}" -f (Split-Path -Leaf $t.Path)) -ForegroundColor DarkGray
    }
    catch {
        $rwOk = $false
        Write-Host ("  !!  当前账户读写失败：{0} — {1}" -f $t.Path, $_.Exception.Message) -ForegroundColor Red
    }
}

if (-not $rwOk) {
    Write-Host '[结果] 加固把应用自己锁在外面了，请用 icacls 恢复继承后重来。' -ForegroundColor Red
    exit 5
}

Write-Host ''
Write-Host '[完成] 凭据文件已只允许 当前账户/SYSTEM/Administrators。' -ForegroundColor Green
Write-Host '       回滚：icacls <文件> /inheritance:e' -ForegroundColor DarkGray
exit 0
