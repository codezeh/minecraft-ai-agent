# ============================================================================
# server_proc.ps1 -- "is this java process OUR server?"  (single owner, P2-7)
#
# Criterion (same as start-panel.ps1's Get-ServerJava): the command line must
# contain the canonical absolute path <root>\server\server.jar.  Other MC
# installs and plain Java apps must NOT match.  No I/O at import time; the
# process table is injectable so scripts/tests/ops-regression.mjs can feed
# fixtures and call the predicate directly.
# ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI.
# ============================================================================

function ConvertTo-CmdKey {
    param([AllowNull()][string]$Text)
    if (-not $Text) { return '' }
    return $Text.ToLowerInvariant().Replace('/', '\')
}

function Get-ServerJarNeedle {
    param([string]$ProjectRoot)
    if (-not $ProjectRoot) { throw 'Get-ServerJarNeedle: -ProjectRoot is required' }
    $jar = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot 'server\server.jar'))
    return (ConvertTo-CmdKey $jar)
}

function Test-OwnServerCommandLine {
    param([AllowNull()][string]$CommandLine, [string]$ProjectRoot)
    $cmd = ConvertTo-CmdKey $CommandLine
    if (-not $cmd) { return $false }
    $needle = Get-ServerJarNeedle -ProjectRoot $ProjectRoot
    return $cmd.Contains($needle)
}

function Get-OwnServerJava {
    param([string]$ProjectRoot, [object[]]$ProcessTable)
    $own = @()
    if ($null -eq $ProcessTable) {
        $ProcessTable = @(Get-CimInstance -ClassName Win32_Process `
                -Filter "Name='java.exe' OR Name='javaw.exe'" -ErrorAction SilentlyContinue)
    }
    foreach ($p in @($ProcessTable)) {
        if ($null -eq $p) { continue }
        $cl = $null
        try { $cl = [string]$p.CommandLine } catch { $cl = $null }
        if (Test-OwnServerCommandLine -CommandLine $cl -ProjectRoot $ProjectRoot) { $own += $p }
    }
    return $own
}
