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
    [switch]$IncludeParents
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot
$me   = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

# 三个真实存在的凭据/隐私文件（报告点名的位置）
$fileTargets = @(
    'mindcraft\.mindserver-token',   # 控制台握手 token
    'mindcraft\keys.json',           # 模型 API Key
    'server\server.properties'       # RCON 密码 + 服务器参数
)
$dirTargets = @('mindcraft')

# 允许的三类主体
$allowed = @($me, 'NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators')

# 判定"这个 ACE 该不该消失"：主体不在允许清单里就算问题
function Get-Verdict([System.Security.AccessControl.FileSystemAccessRule]$rule) {
    $id = $rule.IdentityReference.Value
    if ($allowed -contains $id) { return 'ok' }
    if ($rule.AccessControlType -eq 'Deny') { return 'ok' }   # 显式拒绝不构成放开
    return 'too-broad'
}

function Show-Acl([string]$path) {
    $acl = Get-Acl -Path $path
    $inherited = -not $acl.AreAccessRulesProtected
    Write-Host ("  DACL: {0}" -f $(if ($inherited) { '继承父目录（需要收口）' } else { '非继承（已收口）' })) `
        -ForegroundColor $(if ($inherited) { 'Yellow' } else { 'Green' })
    foreach ($rule in $acl.Access) {
        $v = Get-Verdict $rule
        $mark = if ($v -eq 'ok') { '  ok ' } else { '  !! ' }
        $color = if ($v -eq 'ok') { 'DarkGray' } else { 'Red' }
        Write-Host ("{0}{1} | {2} | {3} | 继承={4}" -f $mark, $rule.IdentityReference.Value,
            $rule.FileSystemRights, $rule.AccessControlType, $rule.IsInherited) -ForegroundColor $color
    }
    return ($acl.Access | Where-Object { (Get-Verdict $_) -ne 'ok' }).Count
}

function Test-NeedsHardening([string]$path) {
    $acl = Get-Acl -Path $path
    if (-not $acl.AreAccessRulesProtected) { return $true }
    return (@($acl.Access | Where-Object { (Get-Verdict $_) -eq 'too-broad' }).Count -gt 0)
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

Write-Host '============================================================' -ForegroundColor DarkCyan
Write-Host '  凭据文件 ACL 加固（OPS-004）' -ForegroundColor White
Write-Host ("  模式：{0}" -f $(if ($Apply) { 'APPLY（会真的改）' } else { '体检（不改；加 -Apply 才动手）' })) -ForegroundColor $(if ($Apply) { 'Yellow' } else { 'Gray' })
Write-Host ("  当前账户：{0}" -f $me) -ForegroundColor DarkGray
Write-Host '============================================================' -ForegroundColor DarkCyan
Write-Host ''

$targets = @()
foreach ($rel in $fileTargets) {
    $p = Join-Path $root $rel
    if (Test-Path -LiteralPath $p) { $targets += [pscustomobject]@{ Path = $p; Dir = $false } }
    else { Write-Host ("[跳过] 不存在：{0}" -f $rel) -ForegroundColor DarkYellow }
}
if ($IncludeParents) {
    foreach ($rel in $dirTargets) {
        $p = Join-Path $root $rel
        if (Test-Path -LiteralPath $p) { $targets += [pscustomobject]@{ Path = $p; Dir = $true } }
    }
}

$problems = 0
foreach ($t in $targets) {
    Write-Host ("--- {0}" -f $t.Path) -ForegroundColor Cyan
    $problems += Show-Acl $t.Path
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
    if (-not (Test-NeedsHardening $t.Path)) {
        Write-Host ("[已是收口] {0}" -f $t.Path) -ForegroundColor Green
        continue
    }
    Write-Host ("[加固] {0}" -f $t.Path) -ForegroundColor Yellow
    Set-HardenedAcl -path $t.Path -isDir $t.Dir
}

Write-Host ''
Write-Host '--- 复验 ---' -ForegroundColor Cyan
$after = 0
foreach ($t in $targets) {
    Write-Host ("--- {0}" -f $t.Path) -ForegroundColor Cyan
    $after += Show-Acl $t.Path
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
