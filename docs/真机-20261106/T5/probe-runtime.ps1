# T5 —— 容器运行时探测（A 步骤）
#
# 目的：把"本机到底有没有可用的容器运行时"变成**可复现的原始证据**，而不是一句"没有"。
# 覆盖：PATH / 常见安装路径 / Docker Desktop 元数据 / WSL（Docker Desktop 的 WSL2 后端前提）
#       / 服务与进程 / Windows 可选功能 / 本地镜像与上下文。
#
# 用法：
#   pwsh -File docs/真机-20261106/T5/probe-runtime.ps1                      # 写 runtime-probe.json
#   pwsh -File docs/真机-20261106/T5/probe-runtime.ps1 -Out runtime-rerun.json
#
# 只读：不安装、不启动、不改任何系统状态。

[CmdletBinding()]
param(
    [string]$Out = 'runtime-probe.json'
)

$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
$outPath = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $here $Out }

function Invoke-Raw {
    param([string]$Exe, [string[]]$Args)
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $Exe
        $psi.Arguments = ($Args -join ' ')
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        # wsl.exe 输出是 UTF-16LE；统一按 Unicode 解，其他程序按 UTF-8 解后再判
        $psi.StandardOutputEncoding = [System.Text.Encoding]::Unicode
        $psi.StandardErrorEncoding = [System.Text.Encoding]::Unicode
        $p = [System.Diagnostics.Process]::Start($psi)
        $so = $p.StandardOutput.ReadToEnd()
        $se = $p.StandardError.ReadToEnd()
        $p.WaitForExit(15000) | Out-Null
        # 若 Unicode 解出来是乱码（含大量替换字符/空字符），退回 UTF-8 再试一次
        $garbled = ($so -match "`0") -or (($so.ToCharArray() | Where-Object { $_ -eq [char]0xFFFD }).Count -gt 3)
        if ($garbled) {
            $psi2 = New-Object System.Diagnostics.ProcessStartInfo
            $psi2.FileName = $Exe
            $psi2.Arguments = ($Args -join ' ')
            $psi2.RedirectStandardOutput = $true
            $psi2.RedirectStandardError = $true
            $psi2.UseShellExecute = $false
            $psi2.CreateNoWindow = $true
            $psi2.StandardOutputEncoding = [System.Text.Encoding]::UTF8
            $psi2.StandardErrorEncoding = [System.Text.Encoding]::UTF8
            $p2 = [System.Diagnostics.Process]::Start($psi2)
            $so = $p2.StandardOutput.ReadToEnd()
            $se = $p2.StandardError.ReadToEnd()
            $p2.WaitForExit(15000) | Out-Null
            $code = $p2.ExitCode
        }
        else { $code = $p.ExitCode }
        return [pscustomobject]@{
            exe     = $Exe
            args    = ($Args -join ' ')
            exitCode = $code
            stdout  = ($so -replace "`0", '').Trim()
            stderr  = ($se -replace "`0", '').Trim()
        }
    }
    catch {
        return [pscustomobject]@{
            exe = $Exe; args = ($Args -join ' '); exitCode = $null
            stdout = ''; stderr = "LAUNCH-FAILED: $($_.Exception.Message)"
        }
    }
}

# ── 1. PATH 探测 ──────────────────────────────────────────────
$names = @('docker', 'docker-compose', 'podman', 'nerdctl', 'nerdctl-full', 'wsl', 'containerd', 'buildah', 'limactl', 'colima')
$pathProbe = foreach ($n in $names) {
    $c = Get-Command $n -ErrorAction SilentlyContinue
    [pscustomobject]@{
        name  = $n
        found = [bool]$c
        source = if ($c) { ($c | Select-Object -First 1).Source } else { $null }
        version = if ($c) { ($c | Select-Object -First 1).Version -as [string] } else { $null }
    }
}

# ── 2. 常见安装路径 ───────────────────────────────────────────
$cands = @(
    "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe",
    "$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe",
    "$env:ProgramFiles\Docker\Docker\resources\bin\docker-compose.exe",
    "$env:ProgramFiles\Docker\Docker\resources\com.docker.backend.exe",
    "${env:ProgramFiles(x86)}\Docker\Docker\Docker Desktop.exe",
    "$env:LOCALAPPDATA\Docker\Docker\Docker Desktop.exe",
    "$env:LOCALAPPDATA\Docker\Docker\resources\bin\docker.exe",
    "$env:LOCALAPPDATA\Docker\wsl",
    "$env:ProgramData\DockerDesktop",
    "$env:ProgramData\Docker",
    "$env:USERPROFILE\.docker",
    "$env:USERPROFILE\.docker\config.json",
    "$env:USERPROFILE\.docker\contexts",
    "$env:ProgramFiles\podman\podman.exe",
    "$env:ProgramFiles\RedHat\Podman\podman.exe",
    "$env:ProgramFiles\containerd\ctr.exe",
    "$env:ProgramFiles\Rancher Desktop\Rancher Desktop.exe",
    "$env:LOCALAPPDATA\Programs\Rancher Desktop\Rancher Desktop.exe",
    "$env:ProgramFiles\Nerdctl\nerdctl.exe",
    "C:\Program Files\Docker\Docker\resources\bin\docker.exe",
    "C:\ProgramData\chocolatey\bin\docker.exe",
    "$env:USERPROFILE\scoop\shims\docker.exe"
) | Select-Object -Unique
$pathList = foreach ($p in $cands) {
    [pscustomobject]@{
        path   = $p
        exists = Test-Path -LiteralPath $p
        kind   = if (Test-Path -LiteralPath $p) { if ((Get-Item -LiteralPath $p).PSIsContainer) { 'dir' } else { 'file' } } else { $null }
    }
}

# ── 3. Docker Desktop 元数据 ──────────────────────────────────
$versionJsonFiles = @(
    "$env:ProgramFiles\Docker\Docker\version.json",
    "$env:ProgramFiles\Docker\Docker\componentsVersion.json",
    "$env:LOCALAPPDATA\Docker\Docker\version.json",
    "$env:ProgramData\DockerDesktop\version.json"
)
$versionJson = foreach ($f in $versionJsonFiles) {
    [pscustomobject]@{
        path  = $f
        exists = Test-Path -LiteralPath $f
        content = if (Test-Path -LiteralPath $f) { (Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue) } else { $null }
    }
}

# ── 4. 服务 / 进程 ────────────────────────────────────────────
$services = @('com.docker.service', 'docker', 'docker-engine', 'com.docker.buildkit') | ForEach-Object {
    $s = Get-Service -Name $_ -ErrorAction SilentlyContinue
    [pscustomobject]@{ name = $_; found = [bool]$s; status = if ($s) { "$($s.Status)" } else { $null } }
}
$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -match 'docker|podman|nerdctl|containerd|rancher|vmmem|dockerd'
} | Select-Object ProcessName, Id, @{ n = 'StartTime'; e = { try { $_.StartTime.ToString('s') } catch { $null } } }

# ── 5. WSL（Docker Desktop 的 WSL2 后端前提）──────────────────
$wslVersion = $null; $wslList = $null; $wslStatus = $null
if (Get-Command wsl -ErrorAction SilentlyContinue) {
    $wslVersion = Invoke-Raw -Exe 'wsl.exe' -Args @('--version')
    $wslList    = Invoke-Raw -Exe 'wsl.exe' -Args @('-l', '-v')
    $wslStatus  = Invoke-Raw -Exe 'wsl.exe' -Args @('--status')
}

# ── 6. Windows 可选功能（WSL / 虚拟机平台）────────────────────
$features = @()
foreach ($fn in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform', 'Containers')) {
    try {
        $f = Get-WindowsOptionalFeature -Online -FeatureName $fn -ErrorAction Stop
        $features += [pscustomobject]@{ feature = $fn; state = "$($f.State)"; source = 'Get-WindowsOptionalFeature' }
    }
    catch {
        $features += [pscustomobject]@{ feature = $fn; state = "UNKNOWN"; source = "ERR: $($_.Exception.Message)" }
    }
}

# ── 7. 运行时可用性结论 ───────────────────────────────────────
$dockerCmd = $pathProbe | Where-Object { $_.name -eq 'docker' -and $_.found }
$dockerVer = if ($dockerCmd) { Invoke-Raw -Exe 'docker.exe' -Args @('version', '--format', '{{json .}}') } else { $null }
$dockerInfo = if ($dockerCmd) { Invoke-Raw -Exe 'docker.exe' -Args @('info', '--format', '{{json .ServerVersion}}') } else { $null }

$anyRuntime = [bool]($dockerCmd -or ($pathProbe | Where-Object { $_.found -and $_.name -in @('podman', 'nerdctl', 'buildah') }))

$result = [pscustomobject]@{
    probe              = 'T5 runtime probe (OPS-005 真 build 前置)'
    generatedAt        = (Get-Date).ToString('o')
    host               = [pscustomobject]@{
        computerName = $env:COMPUTERNAME
        user         = $env:USERNAME
        os           = (Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue | ForEach-Object { $_.Caption })
        osVersion    = (Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue | ForEach-Object { $_.Version })
        psVersion    = $PSVersionTable.PSVersion.ToString()
        arch         = $env:PROCESSOR_ARCHITECTURE
    }
    pathProbe          = $pathProbe
    installPaths       = $pathList
    dockerDesktopMeta  = $versionJson
    services           = $services
    processes          = $procs
    wsl                = [pscustomobject]@{
        version = $wslVersion
        list    = $wslList
        status  = $wslStatus
    }
    windowsFeatures    = $features
    dockerVersionCmd   = $dockerVer
    dockerInfoCmd      = $dockerInfo
    conclusion         = [pscustomobject]@{
        anyContainerRuntimeFound = $anyRuntime
        dockerCliOnPath          = [bool]$dockerCmd
        dockerUsable             = [bool]($dockerCmd -and $dockerInfo -and $dockerInfo.exitCode -eq 0)
        blockedReason            = if (-not $anyRuntime) {
            '本机未找到 docker / podman / nerdctl / buildah 任一容器运行时（PATH 与常见安装路径均未命中，Docker Desktop 元数据与服务均不存在，WSL 子系统亦未安装）⇒ 真 build 无法执行。'
        } elseif ($dockerCmd -and -not ($dockerInfo -and $dockerInfo.exitCode -eq 0)) {
            'docker CLI 存在但 `docker info` 未成功 ⇒ daemon 未运行或不可连（Docker Desktop 可能未启动 / WSL2 后端未就绪）。'
        } else { $null }
    }
}

$result | ConvertTo-Json -Depth 8 | Out-File -LiteralPath $outPath -Encoding utf8
Write-Host "已写出: $outPath"
Write-Host ("结论: anyContainerRuntimeFound={0} dockerCliOnPath={1} dockerUsable={2}" -f `
    $result.conclusion.anyContainerRuntimeFound, $result.conclusion.dockerCliOnPath, $result.conclusion.dockerUsable)
if ($result.conclusion.blockedReason) { Write-Host "阻塞原因: $($result.conclusion.blockedReason)" }
