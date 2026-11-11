# ============================================================================
# panel_guard.ps1 -- testable decision logic for scripts/start-panel.ps1
#
# Why this file exists (R6 #44 / #49 / #56, 2026-11-11):
#   start-panel.ps1 used to answer "did it work?" with inline `Write-Ok` calls
#   that could not be tested without spawning a real server.  The regression
#   gate could only grep for identifiers, which is exactly what R6 #56 calls
#   "text-regex gate".  Every decision that used to be an inline happy-path
#   message now lives here as a pure function: it takes facts, returns a
#   verdict, and prints nothing.  scripts/tests/ops-regression.mjs runs these
#   FOR REAL (dot-sourced) with fabricated facts -- and it fails if the
#   verdict flips back to "success".
#
#   ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI,
#   so Chinese text here would be mojibake.  User-facing Chinese stays in
#   start-panel.ps1 (which is UTF-8 + BOM).
#
# Nothing in this file touches the filesystem, the network or the process
# table (the only exception is Get-PanelProbe / Get-DistDrift, which are
# read-only probes used by start-panel and by the gate).
# ============================================================================

# --- output helpers: only defined when the host script has not defined them ---
if (-not (Get-Command Write-Ok -ErrorAction SilentlyContinue)) {
    function Write-Ok([string]$t)    { Write-Host ("      " + $t) -ForegroundColor Green }
}
if (-not (Get-Command Write-Warn2 -ErrorAction SilentlyContinue)) {
    function Write-Warn2([string]$t) { Write-Host ("      " + $t) -ForegroundColor Yellow }
}
if (-not (Get-Command Write-Bad -ErrorAction SilentlyContinue)) {
    function Write-Bad([string]$t)   { Write-Host ("      " + $t) -ForegroundColor Red }
}

# ============================================================================
# #44-1  build outcome: a failed build is a failure, even if an old dist exists
# ============================================================================
# Old behaviour (the bug): `node vite.js build` non-zero -> Write-Warn2
# "build failed, reusing the last dist" -> the script went on and printed
# "startup complete", so a stale UI was served with a success signal.
# New behaviour: only exit code 0 counts as built; anything else aborts.
function Resolve-BuildOutcome {
    param(
        [int]$ExitCode,
        [bool]$HasDist,
        [string]$DistPath = ''
    )
    if ($ExitCode -eq 0) {
        return [pscustomobject]@{
            Action  = 'ok'
            ExitCode = 0
            Message = 'panel artifacts rebuilt, stamped and verified (release.ps1 -SkipDocker)'
        }
    }
    $where = if ($HasDist) { "an OLD dist is still present at $DistPath, but it is NOT this source tree" }
             else { 'there is no usable dist at all' }
    return [pscustomobject]@{
        Action   = 'abort'
        ExitCode = 1
        Message  = ("build/verify failed (exit=$ExitCode): $where. Refusing to report a successful start.")
    }
}

# ============================================================================
# #44-2  port 25565: "listening" is not the same as "it is our server"
# ============================================================================
# Old behaviour (the bug): any listener on 25565 -> "already running, skip".
# New: we also require that our own server.jar process is alive (Get-ServerJava
# matches the project-absolute jar path).  Otherwise the port is foreign.
function Resolve-McPortState {
    param(
        [bool]$Listening,
        [bool]$OurJavaPresent,
        [int]$Port = 25565
    )
    if (-not $Listening) { return 'free' }
    if ($OurJavaPresent) { return 'ours' }
    return 'foreign'
}

# ============================================================================
# #44-3  port 8080: identify the panel by what it answers, not by "something listens"
# ============================================================================
# Old behaviour (the bug): any listener on 8080 -> "already running, skip".
# An unrelated service on 8080 meant the browser opened a stranger's page while
# the script claimed the panel was up.
# New: probe GET /console.
#   * our mindserver answers 401 with a body starting "unauthorized: ..." when
#     no handshake token is supplied (mindserver.js HTTP gate), or 200 with the
#     Vue shell when the gate is relaxed -> both are recognisably ours.
#   * anything else -> foreign.
function Resolve-PanelPortState {
    param(
        [bool]$Listening,
        $Probe = $null,
        [int]$Port = 8080
    )
    if (-not $Listening) { return 'free' }
    if ($Probe) {
        $status = 0
        if ($Probe.PSObject.Properties.Name -contains 'Status') { $status = [int]$Probe.Status }
        $body = ''
        if ($Probe.PSObject.Properties.Name -contains 'Body') { $body = [string]$Probe.Body }
        if ($body -match 'unauthorized') { return 'ours' }
        if ($status -eq 200 -and $body -match 'id="app"') { return 'ours' }
        if ($status -ge 400 -and $body -match 'mindserver') { return 'ours' }
    }
    return 'foreign'
}

# ============================================================================
# #44-4  bot spawn: a 120s timeout is NOT success
# ============================================================================
# Old behaviour (the bug): after the timeout Wait-BotSpawned printed a hint and
# did `return $true`, so the caller's `if (-not (Wait-BotSpawned 120)) { exit 1 }`
# could never fire.
function Resolve-BotSpawnOutcome {
    param([bool]$Spawned, [int]$Seconds = 120)
    if ($Spawned) {
        return [pscustomobject]@{ Ok = $true; ExitCode = 0; Message = 'bot entered the game (log said "spawned.")' }
    }
    return [pscustomobject]@{
        Ok       = $false
        ExitCode = 1
        Message  = ("waited ${Seconds}s and the log never said 'spawned.': the start signal is NOT trustworthy")
    }
}

# --- classify one mindcraft console log tail (pure: takes text, returns word) ---
function Get-BotSpawnHint {
    param([string]$LogText)
    if (-not $LogText) { return 'pending' }
    if ($LogText -match 'spawned\.') { return 'spawned' }
    if ($LogText -match 'not found in keys|exited too quickly') { return 'failed' }
    return 'pending'
}

# --- wait for the bot, using Get-BotSpawnHint; returns $true/$false honestly ---
# -Seconds 0/1 makes this cheap enough for the regression gate (no server needed).
function Wait-BotSpawned {
    param(
        [int]$Seconds = 120,
        [string]$LogFile
    )
    $elapsed = 0
    while ($elapsed -lt $Seconds) {
        if ($LogFile -and (Test-Path -LiteralPath $LogFile)) {
            $text = (Get-Content -LiteralPath $LogFile -Tail 200 -ErrorAction SilentlyContinue) -join "`n"
            $hint = Get-BotSpawnHint -LogText $text
            if ($hint -eq 'spawned') { Write-Ok ("bot entered the game ({0}s)" -f $elapsed); return $true }
            if ($hint -eq 'failed')  { Write-Bad "[error] bot failed to start (missing API key or process exited)"; return $false }
        }
        Start-Sleep -Seconds 2
        $elapsed += 2
        Write-Host '.' -NoNewline -ForegroundColor DarkGray
    }
    Write-Host ''
    $verdict = Resolve-BotSpawnOutcome -Spawned $false -Seconds $Seconds
    Write-Bad ("[error] " + $verdict.Message)
    return $false
}

# ============================================================================
# #49  "verified artifact" vs "actually served artifact"
# ============================================================================
# release.ps1 verifies mindcraft/web-dist; mindserver (local dev) serves
# web/dist first.  They must be byte-identical, otherwise -VerifyOnly proves
# something about a directory nobody is looking at.
# Returns an array of human-readable drift lines; empty array == identical.
function Get-DistDrift {
    param(
        [Parameter(Mandatory = $true)][string]$Left,    # served dir (web/dist)
        [Parameter(Mandatory = $true)][string]$Right,   # shipped dir (mindcraft/web-dist)
        [string[]]$IgnoreNames = @('MANIFEST.json', 'README.md')
    )
    $out = @()
    if (-not (Test-Path -LiteralPath $Left))  { return @("MISSING-DIR: $Left") }
    if (-not (Test-Path -LiteralPath $Right)) { return @("MISSING-DIR: $Right") }

    $listFiles = {
        param([string]$Base)
        $acc = @{}
        $walk = {
            param([string]$Dir, [string]$Rel)
            foreach ($item in Get-ChildItem -LiteralPath $Dir -Force -ErrorAction Stop) {
                $childRel = if ($Rel) { "$Rel/$($item.Name)" } else { $item.Name }
                if ($item.PSIsContainer) {
                    & $walk $item.FullName $childRel
                } else {
                    $acc[$childRel.Replace('\', '/')] = $item.FullName
                }
            }
        }
        & $walk $Base ''
        return $acc
    }

    $l = & $listFiles $Left
    $r = & $listFiles $Right

    $sha = {
        param([string]$Path)
        (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    }

    foreach ($rel in ($l.Keys | Sort-Object)) {
        if (-not $r.ContainsKey($rel)) { $out += "MISSING-IN-SHIPPED: $rel"; continue }
        if ((& $sha $l[$rel]) -ne (& $sha $r[$rel])) { $out += "DIFFERS: $rel" }
    }
    foreach ($rel in ($r.Keys | Sort-Object)) {
        if ($IgnoreNames -contains (Split-Path -Leaf $rel)) { continue }
        if (-not $l.ContainsKey($rel)) { $out += "EXTRA-IN-SHIPPED: $rel" }
    }
    return $out
}

# ============================================================================
# probe used by start-panel for port 8080 (read-only, bounded)
# ============================================================================
# Raw socket HTTP/1.0 GET /console.  We do NOT use Invoke-WebRequest because it
# throws on 401 and needs a Response object dance on PS 5.1; here we only need
# "what does this port answer", including the 401 body.
function Get-PanelProbe {
    param(
        [int]$Port = 8080,
        [int]$TimeoutMs = 1500,
        [string]$Path = '/console'
    )
    $result = [pscustomobject]@{ Ok = $false; Status = 0; Body = ''; Error = '' }
    $client = $null
    try {
        $client = New-Object Net.Sockets.TcpClient
        $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { throw 'connect timeout' }
        $client.EndConnect($iar)
        $stream = $client.GetStream()
        $stream.ReadTimeout = $TimeoutMs
        $req = "GET $Path HTTP/1.0`r`nHost: 127.0.0.1:$Port`r`nConnection: close`r`n`r`n"
        $buf = [Text.Encoding]::ASCII.GetBytes($req)
        $stream.Write($buf, 0, $buf.Length)
        $stream.Flush()
        $chunk = New-Object byte[] 65536
        $sb = New-Object Text.StringBuilder
        while ($true) {
            $n = $stream.Read($chunk, 0, $chunk.Length)
            if ($n -le 0) { break }
            [void]$sb.Append([Text.Encoding]::UTF8.GetString($chunk, 0, $n))
            if ($sb.Length -gt 262144) { break }
        }
        $raw = $sb.ToString()
        $m = [regex]::Match($raw, '^HTTP/1\.[01]\s+(\d{3})')
        if ($m.Success) { $result.Status = [int]$m.Groups[1].Value }
        $result.Body = $raw
        $result.Ok = $true
    } catch {
        $result.Error = $_.Exception.Message
    } finally {
        if ($client) { try { $client.Dispose() } catch { } }
    }
    return $result
}
