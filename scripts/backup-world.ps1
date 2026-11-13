<#
.SYNOPSIS
    世界 + 机器人数据 + 服务端配置的一致性快照（OPS-012；R4 审计 B1/B2/B5/B6 + 覆盖缺口 + 双 bots 目录）。

.DESCRIPTION
    为什么需要这个脚本：
      报告盘点发现项目内可见的世界备份**停留在 10 月 18 日**，之后所有建造都没有快照，
      而且从来没有人验证过"备份真的能恢复"。CoreProtect 记录方块改动，**不能替代完整存档备份**
      （它不含实体/区块 NBT/玩家数据，也回不去到另一个时间点）。

    ═══ t7 修过的四个硬伤（保留） ═══
      B1 热备份物理上不可能：运行期 Paper 独占 `world/session.lock` 并缓存 `region/*.mca` 句柄，
         `Compress-Archive` 直接抛 IOException。所以默认 `-Mode Cold`：**检测到服务端在跑就显式拒绝**
         （exit 2）；`-Mode Hot` 要 `-Force` 才尝试。
      B5 `save-off` 一旦成功就置位；finally 只看该标志决定是否 `save-on`（flush 成败单独记录）。
      半成品：先写 `world-<stamp>.partial/`，manifest **最后写**，成功后再原子 rename；失败清理。
      假绿灯：manifest 记录清单摘要/计数，verify 逐项相等比对。

    ═══ t8 新增（这份文件的主体） ═══
      B6 **活跃 SQLite 库不能直接压**：直接拷 `board.sqlite` 会丢掉还在 `-wal` 里的提交 ——
         实测 `integrity_check` 仍为 `ok`，但 `shared` 表 1→0（静默回退）。现在统一用
         **`VACUUM INTO`** 落一份一致副本再入包；`-shm` 永不进包，`-wal` 的语义由快照消化。
         CoreProtect 的 `database.db` 是 WAL 模式，同样处理。

      覆盖缺口（旧脚本只备 4 项，恢复回来是"半成品服务器"）：
         · `plugins.zip`        —— 插件配置与数据库（**排除 `*.jar`**：53MB 可重新部署）
         · `server-config.zip`  —— server.properties / ops / whitelist / banned / usercache /
                                   bukkit.yml / spigot.yml / commands.yml / help.yml / permissions.yml /
                                   server/config/**、仓库 config/**
         · `logs.zip`           —— `server/logs` 最近 N 天（`-LogDays`，默认 7）
         · `bots.zip`           —— 机器人记忆/历史/地图 + **任务板快照**

      **双 bots 目录歧义**（根 `bots/` 与 `mindcraft/bots/`，`bot_paths.js:41-52`）：
         唯一真相是 **`mindcraft/bots`** —— mindserver 以 `-WorkingDirectory <repo>\mindcraft` 启动
         （`scripts/start-panel.ps1:245`），所以 `./bots` 解析到 `mindcraft/bots`。
         仓库根的 `bots/` 是历史遗留（`user_version=0`、`shared` 表 0 行，早就不迁移了）。
         现在 manifest 明确写出：`botsSource.canonical = 'mindcraft/bots'`、两个绝对路径、
         以及旧目录的处置说明；verify 会**拒绝**来源不是 `mindcraft/bots` 的备份（避免恢复到错库）。

    安全边界：
      · 默认冷备：world 侧被占用（java/session.lock）就拒绝；任务板库被 mindserver 开着不拒绝，
        改为"复制前后比对 (大小,mtime) 零变更"来证明快照是同一时刻的（manifest.sourceQuiescent）。
      · `server.properties` 含 RCON 口令，默认按 `config/backup.json` 的 `excludeSecrets` 处理 ——
        ★ R6 #7-②（2026-11-10）：配置**永远读**，手动裸跑也算（以前只有 `-FromConfig` 才读，
          于是 README 教的那种裸跑会产出含明文口令的备份）。
          `excludeSecrets=true`（默认）⇒ 文件仍入包，但 `rcon.password` 抹空，
          manifest 记 `containsSecrets=false` 并在 `redacted` 里说明动了哪个字段；
          要带明文口令必须**显式** `-IncludeSecrets`，此时 manifest 记 `containsSecrets=true`
          并警告备份目录属敏感数据。两个参数同时给 ⇒ 直接 exit 1（不猜用户想要哪个）。
      · 不删除任何非本脚本产出的目录（旧备份目录必须含 manifest.json 才参与保留策略）。

.PARAMETER OutDir
    备份根目录，默认 <repo>/backups。

.PARAMETER Keep
    保留最近多少个 world-* 备份。不传则取 `config/backup.json` 的 `keep`（缺省 7）。
    0 表示不清理。只清理**含 manifest.json** 的目录。

.PARAMETER Mode
    Cold（默认，推荐）：服务端在跑就拒绝。Hot：需要 -Force，预期失败但保证 save-on。

.PARAMETER Force
    Hot 模式的二次确认开关。

.PARAMETER KeepPartial
    失败时保留 `*.partial` 目录（便于排查），默认删除。

.PARAMETER WaitLockSec
    冷备检测到 world 侧被占用时，最多等待多少秒再复查（默认 0 = 立即拒绝）。

.PARAMETER LogDays
    `server/logs` 只备份最近多少天（默认 7；0 = 不备份日志）。

.PARAMETER ExcludeSecrets
    `server/server.properties` 里的 `rcon.password` 抹空后入包（其余设置全保留，保证可恢复）。
    不传则按 `config/backup.json` 的 `excludeSecrets`（默认 true ⇒ 抹空）。

.PARAMETER IncludeSecrets
    显式要求**带明文 RCON 口令**备份（覆盖 `config/backup.json`）。与 `-ExcludeSecrets` 互斥。
    默认不会给你明文口令 —— 想要就得明说。

.PARAMETER FromConfig
    自动备份模式（停止面板 / 每日计划任务用）：`enabled=false` 时跳过并记日志，退出码 **4**
    （不是 0：跳过 ≠ 成功，上层据此记 SKIP 而非 OK，见 R6 #51）。
    手动备份**不需要**它 —— 配置永远会被读取，只是手动跑不会因为 `enabled=false` 被拦下。

.EXAMPLE
    # 手动冷备（先关服）。会读 config/backup.json：keep / excludeSecrets 都生效
    powershell -ExecutionPolicy Bypass -File scripts\backup-world.ps1

.EXAMPLE
    # 手动冷备，但这次要把明文 RCON 口令一起备（默认不会，必须显式说）
    powershell -ExecutionPolicy Bypass -File scripts\backup-world.ps1 -IncludeSecrets

.NOTES
    退出码：0 成功；1 失败；2 拒绝（服务端在跑，需先关服）；3 拒绝（Hot 未加 -Force）；
            4 跳过（-FromConfig 模式下 config/backup.json 的 enabled=false —— 这是"没备份"，不是"备份成功"，R6 #51）。
#>
[CmdletBinding()]
param(
    [string]$OutDir,
    [int]$Keep = 7,
    [ValidateSet('Cold', 'Hot')][string]$Mode = 'Cold',
    [switch]$Force,
    [switch]$KeepPartial,
    [int]$WaitLockSec = 0,
    [int]$LogDays = 7,
    [switch]$ExcludeSecrets,
    # 显式要求"带明文 RCON 口令"备份（覆盖 config/backup.json 的 excludeSecrets=true）
    [switch]$IncludeSecrets,
    # 自动备份模式（停服后备份 / 每日计划任务）：enabled=false ⇒ 跳过并记日志
    [switch]$FromConfig
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# RCON 只有一份实现（scripts/lib/rcon.ps1）：auth 正文=密码、且必须校验应答。
# 老的自制实现在真实 Paper 上从未通过认证（type=3 正文发的是命令），save-off/save-on 全部空转。
$rconLib = Join-Path $PSScriptRoot 'lib/rcon.ps1'
if (-not (Test-Path -LiteralPath $rconLib)) { throw "缺少 RCON 库：$rconLib" }
. $rconLib

# ★ P2-7："这个 java 是不是本项目服务端"只有一份判据（scripts/lib/server_proc.ps1）。
$procLib = Join-Path $PSScriptRoot 'lib/server_proc.ps1'
if (-not (Test-Path -LiteralPath $procLib)) { throw "缺少进程判据库：$procLib" }
. $procLib

# ── 备份配置（config/backup.json）────────────────────────────────────
# ★ R6 #7-②（2026-11-10）：以前配置**只有 -FromConfig 才读**，而 README 教的是裸跑
#   （`powershell -File scripts\backup-world.ps1`）⇒ 人工备份永远不读 excludeSecrets，
#   会产出**含明文 RCON 口令**的备份。现在配置**永远**读：
#     · 手动裸跑：keep / excludeSecrets 照样生效，但**不**受 enabled=false 拦截
#                 （总开关只关"自动备份"；手动备份是用户明确要求）；
#     · -FromConfig：停服后自动备份 / 每日计划任务用，enabled=false ⇒ 跳过（exit 0）并记日志；
#     · 命令行永远优先：-Keep / -ExcludeSecrets / -IncludeSecrets，用 $PSBoundParameters 判断，
#       不靠默认值猜。想要明文口令必须显式 -IncludeSecrets。
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'lib/backup_config.ps1'))) {
    throw "缺少备份配置库：$(Join-Path $PSScriptRoot 'lib/backup_config.ps1')"
}
. (Join-Path $PSScriptRoot 'lib/backup_config.ps1')
$backupCfg = Get-BackupConfig -Root $root
foreach ($w in $backupCfg.warnings) { Write-Host "WARN $w" -ForegroundColor Yellow }

if ($FromConfig -and -not $backupCfg.enabled) {
    # ★ R6 #51（2026-11-11）：这里原来 `exit 0` —— 于是"总开关关着、根本没备份"和
    #   "备份成功"在退出码上完全一样，上层（scripts/lib/backup_config.ps1）就照抄一句
    #   `OK 停服后自动备份成功` 进 backup-auto.log。日志里同时出现 SKIP 与 OK，
    #   与 #10 叠加就是"以为有备份"的完整链条。
    #   现在：跳过用独立退出码 4，上层据此记 SKIP 而不是 OK。
    Write-Host 'SKIP 自动备份已关闭（config/backup.json enabled=false）—— 本次不备份（exit 4）' -ForegroundColor Yellow
    Write-BackupAutoLog -Root $root -Level 'SKIP' -Message '计划任务/自动备份跳过：总开关 enabled=false（exit 4，不是成功）'
    exit 4
}
if (-not $FromConfig -and -not $backupCfg.enabled) {
    Write-Host '注意：config/backup.json 的 enabled=false 只关"自动备份"；本次是手动备份，继续执行。' -ForegroundColor DarkGray
}

if (-not $PSBoundParameters.ContainsKey('Keep')) { $Keep = $backupCfg.keep }

if ($ExcludeSecrets -and $IncludeSecrets) {
    Write-Host 'FAIL -ExcludeSecrets 与 -IncludeSecrets 互斥，请只留一个（不带任何就是按 config/backup.json）。' -ForegroundColor Red
    exit 1
}
$secretsSource = 'config/backup.json'
if ($IncludeSecrets) {
    $ExcludeSecrets = $false
    $secretsSource = '命令行 -IncludeSecrets（显式要求带明文口令）'
}
elseif ($PSBoundParameters.ContainsKey('ExcludeSecrets')) {
    $secretsSource = $(if ($ExcludeSecrets) { '命令行 -ExcludeSecrets' } else { '命令行 -ExcludeSecrets:$false' })
}
else {
    $ExcludeSecrets = [bool]$backupCfg.excludeSecrets
}

Write-Host ("配置：{0}（{1}）keep={2}" -f $backupCfg.configPath,
        $(if ($backupCfg.fromFile) { '已读取' } else { '文件缺失/损坏 ⇒ 用默认值' }), $Keep) -ForegroundColor DarkGray
Write-Host ("口令：excludeSecrets={0}（来源：{1}）" -f [bool]$ExcludeSecrets, $secretsSource) -ForegroundColor DarkGray
if ($FromConfig) {
    Write-Host ("自动备份配置：enabled={0} dailyAt={1}" -f $backupCfg.enabled, $backupCfg.dailyAt) -ForegroundColor DarkGray
}
if (-not $OutDir) { $OutDir = Join-Path $root 'backups' }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$finalName = "world-$stamp"
$partialName = "$finalName.partial"

function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Info([string]$msg) { Write-Host "    $msg" -ForegroundColor DarkGray }
function Write-Warn2([string]$msg) { Write-Host "WARN $msg" -ForegroundColor Yellow }
function Write-Fail([string]$msg) { Write-Host "FAIL $msg" -ForegroundColor Red }

# ── 通用工具 ────────────────────────────────────────────────────────
function Get-TextSha256([string]$Text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally { $sha.Dispose() }
}

function Get-FileSha256Shared([string]$Path) {
    # 与 Get-FileHash 等价，但以 FileShare.ReadWrite 打开：任务板库可能被 mindserver 开着
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try { $hash = $sha.ComputeHash($fs) } finally { $fs.Dispose() }
        return (($hash | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally { $sha.Dispose() }
}

function Test-PathLocked([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        $fs.Dispose()
        return $false
    } catch { return $true }
}

function Get-WorldEvidence {
    # 世界侧硬闸门：Paper 在跑就必然压不动（B1）。空 = 世界是静止的。
    $ev = @()
    foreach ($dim in @('world', 'world_nether', 'world_the_end')) {
        $lock = Join-Path $root "server/$dim/session.lock"
        if (Test-PathLocked $lock) { $ev += "session.lock 被独占：server/$dim/session.lock" }
    }
    # P2-7：只认**本项目** server.jar 的 java（别的 MC 装 / 普通 java 不算占用）；session.lock 仍是硬闸门。
    try {
        $procs = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='java.exe' OR Name='javaw.exe'" -ErrorAction Stop)
        foreach ($p in @(Get-OwnServerJava -ProjectRoot $root -ProcessTable $procs)) {
            $ev += "本项目服务端进程 PID=$($p.ProcessId)：$([string]$p.CommandLine)"
        }
    } catch {
        # 读不到命令行时不拿"所有 java"当占用（那正是 P2-7 的缺陷）；服务端在跑必然独占 session.lock。
        Write-Host '  WARN 读不到进程命令行（CIM 不可用）：只靠 session.lock 判断服务端是否在跑' -ForegroundColor Yellow
    }
    return $ev
}

# P1（真机验收发现，2026-11-13）：任务板库已按 ADR-0001 D6 阶段 3 迁到
# `boss/_worlds/<world_id>/_board/board.sqlite`，而本脚本还硬要求旧路径
# `bots/_board/board.sqlite` ⇒ **每次停服自动备份 100% 失败**（throw "找不到"）。
# 现在：优先找 `_worlds/*/_board/board.sqlite`（多于一个就报错，绝不猜），回退旧路径。
#
# 返回 @{ Ok; Abs; Rel; Reason }。Rel 是相对 `mindcraft/bots` 的 POSIX 风格路径 ——
# 它同时是 Replace 映射的键，键写错的话快照换不进去（备份看起来成功、内容却不一致）。
function Resolve-BotsBoardPath([string]$BotsDir) {
    $worldsRoot = Join-Path $BotsDir '_worlds'
    if (Test-Path -LiteralPath $worldsRoot) {
        $hits = @(Get-ChildItem -LiteralPath $worldsRoot -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName '_board/board.sqlite' } |
            Where-Object { Test-Path -LiteralPath $_ })
        if ($hits.Count -gt 1) {
            return @{ Ok = $false; Abs = $null; Rel = $null
                Reason = ("发现多个存档的任务板库（{0} 个）：{1} —— 不猜该备份哪个，请显式指定" -f $hits.Count, ($hits -join '; ')) }
        }
        if ($hits.Count -eq 1) {
            $abs = $hits[0]
            $rel = ($abs.Substring($BotsDir.Length).TrimStart('\', '/')) -replace '\\', '/'
            return @{ Ok = $true; Abs = $abs; Rel = $rel; Reason = $null }
        }
    }
    $legacy = Join-Path $BotsDir '_board/board.sqlite'
    if (Test-Path -LiteralPath $legacy) {
        return @{ Ok = $true; Abs = $legacy; Rel = '_board/board.sqlite'; Reason = $null }
    }
    return @{ Ok = $false; Abs = $null; Rel = $null
        Reason = '找不到任务板库：既没有 _worlds/<id>/_board/board.sqlite，也没有 _board/board.sqlite' }
}

function Get-OpenDbHandles {
    # 只是"谁还开着任务板库"的信息，**不**作为拒绝理由（一致性由 quiescence 证明兜底）
    $out = @()
    $botsRoot2 = Join-Path $root 'mindcraft/bots'
    $rb = Resolve-BotsBoardPath $botsRoot2
    if ($rb.Ok -and (Test-PathLocked $rb.Abs)) { $out += ('mindcraft/bots/' + $rb.Rel) }
    return $out
}

function Get-QuiescenceMap([object[]]$Files) {
    $map = @{}
    foreach ($f in $Files) { $map[$f.Rel] = "$($f.Size)|$($f.MTimeUtc)" }
    return $map
}

function Get-FileEntry([string]$FullPath, [string]$Rel) {
    $fi = Get-Item -LiteralPath $FullPath
    return [pscustomobject]@{ FullName = $fi.FullName; Rel = $Rel; Size = [int64]$fi.Length; MTimeUtc = $fi.LastWriteTimeUtc.Ticks }
}

function Get-FileList([string]$Dir) {
    $dirFull = (Resolve-Path -LiteralPath $Dir).Path.TrimEnd('\', '/')
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($f in @(Get-ChildItem -LiteralPath $dirFull -Recurse -File -Force -ErrorAction Stop)) {
        $rel = $f.FullName.Substring($dirFull.Length + 1).Replace('\', '/')
        $out.Add([pscustomobject]@{ FullName = $f.FullName; Rel = $rel; Size = [int64]$f.Length; MTimeUtc = $f.LastWriteTimeUtc.Ticks })
    }
    return $out.ToArray()
}

function Get-ExclusionReason([string]$Rel) {
    $leafName = ($Rel -split '/')[-1]
    if ($leafName -eq 'session.lock') { return 'session.lock：服务端运行期的独占锁文件，恢复后由服务端重建' }
    if ($leafName -like '*-shm') { return '*-shm：SQLite 共享内存索引，可重建（恢复时只还原 db + -wal）' }
    if ($leafName -like '*.jar') { return '*.jar：插件/服务端 jar 可重新下载（约 53MB），恢复时按同名部署即可' }
    return $null
}

# ── SQLite：一致性快照 + 只读查询（node:sqlite 优先，python 兜底）────
$script:sqlHelperDir = $null
function Get-SqlHelper {
    if ($script:sqlHelperDir) { return $script:sqlHelperDir }
    $dir = Join-Path ([System.IO.Path]::GetTempPath()) ('wbackup-sql-' + [guid]::NewGuid().ToString('n').Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $dir | Out-Null

    $js = @'
const { DatabaseSync } = require('node:sqlite');
const dbPath = process.argv[2];
const mode = process.argv[3];
if (mode === 'vacuum') {
  const dest = process.argv[4];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec("VACUUM INTO '" + dest.replace(/'/g, "''") + "'");
  db.close();
  console.log(JSON.stringify({ ok: true }));
} else {
  const ro = mode === 'ro';
  const db = new DatabaseSync(dbPath, { readOnly: ro });
  const uv = db.prepare('PRAGMA user_version').get().user_version;
  const ic = db.prepare('PRAGMA integrity_check').all().map(r => Object.values(r)[0]).join(';');
  const tables = {};
  const want = (process.argv[4] || '').split(',').filter(Boolean);
  for (const t of want) {
    try { tables[t] = db.prepare('select count(*) as c from "' + t + '"').get().c; } catch (e) { tables[t] = null; }
  }
  console.log(JSON.stringify({ userVersion: uv, integrity: ic, tables }));
  db.close();
}
'@
    Set-Content -LiteralPath (Join-Path $dir 'q.js') -Value $js -Encoding UTF8

    $py = @'
import json, sqlite3, sys
p, mode = sys.argv[1], sys.argv[2]
if mode == 'vacuum':
    dest = sys.argv[3].replace('\\', '/')
    c = sqlite3.connect('file:' + p.replace('\\', '/') + '?mode=ro', uri=True)
    c.execute("VACUUM INTO ?", (dest,))
    c.close()
    print(json.dumps({'ok': True}))
else:
    uri = 'file:' + p.replace('\\', '/') + ('?mode=ro' if mode == 'ro' else '')
    c = sqlite3.connect(uri, uri=True)
    out = {'userVersion': c.execute('pragma user_version').fetchone()[0],
           'integrity': ';'.join(r[0] for r in c.execute('pragma integrity_check')),
           'tables': {}}
    for t in [x for x in sys.argv[3].split(',') if x]:
        try:
            out['tables'][t] = c.execute('select count(*) from "' + t + '"').fetchone()[0]
        except Exception:
            out['tables'][t] = None
    print(json.dumps(out))
    c.close()
'@
    Set-Content -LiteralPath (Join-Path $dir 'q.py') -Value $py -Encoding UTF8

    $script:sqlHelperDir = $dir
    return $dir
}

function Remove-SqlHelper {
    if ($script:sqlHelperDir) {
        Remove-Item $script:sqlHelperDir -Recurse -Force -ErrorAction SilentlyContinue
        $script:sqlHelperDir = $null
    }
}

function Invoke-Sqlite {
    param([string]$DbPath, [ValidateSet('ro', 'rw', 'vacuum')][string]$Mode = 'ro', [string]$Dest, [string[]]$Tables = @())
    $dir = Get-SqlHelper
    $tblArg = ($Tables -join ',')

    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) {
        $args = @((Join-Path $dir 'q.js'), $DbPath, $Mode)
        if ($Mode -eq 'vacuum') { $args += $Dest } else { $args += $tblArg }
        $out = & $nodeCmd.Path @args 2>$null
        if ($LASTEXITCODE -eq 0 -and $out) { return ($out | Out-String | ConvertFrom-Json) }
    }
    $pyCmd = Get-Command python -ErrorAction SilentlyContinue
    if ($pyCmd) {
        $args = @((Join-Path $dir 'q.py'), $DbPath, $Mode)
        if ($Mode -eq 'vacuum') { $args += $Dest } else { $args += $tblArg }
        $out = & $pyCmd.Path @args 2>$null
        if ($LASTEXITCODE -eq 0 -and $out) { return ($out | Out-String | ConvertFrom-Json) }
    }
    return $null
}

function New-SqliteSnapshot {
    # VACUUM INTO 出一份一致副本：把 -wal 里未 checkpoint 的提交也包含进去（B6 的解法）
    param([string]$SrcDb, [string]$DestDb, [string[]]$Tables = @())
    if (Test-Path -LiteralPath $DestDb) { Remove-Item -LiteralPath $DestDb -Force }
    $r = Invoke-Sqlite -DbPath $SrcDb -Mode 'vacuum' -Dest $DestDb
    if (-not $r -or -not $r.ok) { throw "VACUUM INTO 失败（node:sqlite / python 都可用吗？）：$SrcDb" }
    if (-not (Test-Path -LiteralPath $DestDb)) { throw "VACUUM INTO 没有产出文件：$DestDb" }

    $q = Invoke-Sqlite -DbPath $DestDb -Mode 'ro' -Tables $Tables
    if (-not $q) { throw "无法校验快照：$DestDb" }
    if ($q.integrity -ne 'ok') { throw "快照 integrity_check 不是 ok（$($q.integrity)）：$DestDb" }
    $tbl = [ordered]@{}
    foreach ($t in $Tables) { $tbl[$t] = $q.tables.$t }
    return [ordered]@{
        method      = 'VACUUM INTO'
        dest        = $DestDb
        bytes       = [int64](Get-Item -LiteralPath $DestDb).Length
        sha256      = (Get-FileSha256Shared $DestDb)
        userVersion = [int64]$q.userVersion
        tables      = $tbl
        integrity   = [string]$q.integrity
    }
}

# ── zip：流式写入 + 从 zip 反读清单 ─────────────────────────────────
function New-WorldZip {
    param([string]$Leaf, [string]$ZipPath, [object[]]$Files, [hashtable]$Replace = @{})

    Add-Type -AssemblyName System.IO.Compression -ErrorAction SilentlyContinue
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue

    $fs = [System.IO.File]::Open($ZipPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
    $written = 0
    $excluded = 0
    $reasons = @{}
    try {
        foreach ($f in $Files) {
            # 被快照替换的原始库（含 -wal/-shm）不直接入包
            $baseRel = $f.Rel
            $baseRel = $baseRel -replace '-wal$', ''
            $baseRel = $baseRel -replace '-shm$', ''
            $isReplaced = $Replace.ContainsKey($f.Rel)
            if (-not $isReplaced) { $isReplaced = $Replace.ContainsKey($baseRel) }
            if ($isReplaced) { $excluded++; $k = '活跃 SQLite 库原文件：改用 VACUUM INTO 快照入包（-wal 语义由快照消化）'; if (-not $reasons.ContainsKey($k)) { $reasons[$k] = 0 }; $reasons[$k]++; continue }

            $reason = Get-ExclusionReason $f.Rel
            if ($reason) {
                $excluded++
                if (-not $reasons.ContainsKey($reason)) { $reasons[$reason] = 0 }
                $reasons[$reason]++
                continue
            }
            $entry = $zip.CreateEntry("$Leaf/$($f.Rel)", [System.IO.Compression.CompressionLevel]::Optimal)
            $entryStream = $entry.Open()
            try {
                $in = [System.IO.File]::Open($f.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
                try { $in.CopyTo($entryStream) } finally { $in.Dispose() }
            } finally { $entryStream.Dispose() }
            $written++
            if ($written % 300 -eq 0) { Write-Info "… 已写入 $written 个条目" }
        }
        foreach ($rel in $Replace.Keys) {
            $src = $Replace[$rel]
            $entry = $zip.CreateEntry("$Leaf/$rel", [System.IO.Compression.CompressionLevel]::Optimal)
            $entryStream = $entry.Open()
            try {
                $in = [System.IO.File]::Open($src, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
                try { $in.CopyTo($entryStream) } finally { $in.Dispose() }
            } finally { $entryStream.Dispose() }
            $written++
        }
    } finally {
        try { $zip.Dispose() } catch { }
        try { $fs.Dispose() } catch { }
    }
    return [pscustomobject]@{ FileCount = $written; ExcludedCount = $excluded; ExclusionReasons = $reasons }
}

function Get-ZipInventory {
    param([string]$ZipPath)
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
    $items = New-Object System.Collections.Generic.List[object]
    $zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        foreach ($e in $zip.Entries) {
            if ($e.FullName.EndsWith('/')) { continue }
            $items.Add([pscustomobject]@{ Name = $e.FullName; Size = [int64]$e.Length })
        }
    } finally { $zip.Dispose() }

    $total = [int64]0
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($i in $items) { $total += $i.Size; $lines.Add("$($i.Name)`t$($i.Size)") }
    $arr = $lines.ToArray()
    [Array]::Sort($arr, [System.StringComparer]::Ordinal)
    return [pscustomobject]@{
        Entries                = $items.ToArray()
        FileCount              = $items.Count
        TotalUncompressedBytes = $total
        InventoryDigest        = (Get-TextSha256 (($arr -join "`n") + "`n"))
    }
}

function Get-EntryCounts {
    # 与 verify 完全一致的计数口径
    param([object[]]$Entries, [string]$Leaf)
    $levelDat = @($Entries | Where-Object { $_.Name -eq "$Leaf/level.dat" })
    $botDirs = @()
    if ($Leaf -eq 'bots') {
        $botDirs = @($Entries | ForEach-Object { ($_.Name -split '/')[1] } | Where-Object { $_ } | Sort-Object -Unique)
    }
    return [ordered]@{
        fileCount     = $Entries.Count
        regions       = @($Entries | Where-Object { $_.Name -like '*/region/*.mca' }).Count
        playerdata    = @($Entries | Where-Object { $_.Name -like '*/playerdata/*.dat' }).Count
        memoryJson    = @($Entries | Where-Object { $_.Name -like '*/memory.json' }).Count
        bots          = $botDirs.Count
        mcaTotal      = @($Entries | Where-Object { $_.Name -like '*.mca' }).Count
        levelDatBytes = $(if ($levelDat.Count -eq 1) { [int64]$levelDat[0].Size } else { [int64]0 })
    }
}

# ════════════════════════════════════════════════════════════════════
# 0) 前置：模式闸门（B1）
# ════════════════════════════════════════════════════════════════════
if (-not (Test-Path -LiteralPath (Join-Path $root 'server'))) {
    Write-Fail "找不到 server 目录（$root）"
    exit 1
}

$evidence = @(Get-WorldEvidence)
$openDbHandles = @(Get-OpenDbHandles)

if ($Mode -eq 'Hot' -and -not $Force) {
    Write-Fail '拒绝执行：Hot（在线）备份在运行期物理上不可能成功。'
    Write-Host '     运行期的 Paper 会独占 server\world\session.lock 并缓存 region\*.mca 的写句柄，' -ForegroundColor Yellow
    Write-Host '     压缩时必然抛 "The process cannot access the file ... because it is being used by another process"，' -ForegroundColor Yellow
    Write-Host '     结果只会是：没有 zip、没有 manifest、留下一个空目录（R4 审计 B1，已实测）。' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '     正确做法（任选其一）：' -ForegroundColor Cyan
    Write-Host '       1) 关服后冷备（推荐）：scripts\stop-panel.ps1  →  再跑本脚本（默认 -Mode Cold）'
    Write-Host '       2) 确认接受风险后再试：本脚本 -Mode Hot -Force（仍很可能失败，但保证 save-on 会执行）'
    exit 3
}

if ($Mode -eq 'Cold' -and $evidence.Count -gt 0 -and $WaitLockSec -gt 0) {
    Write-Warn2 "世界里还有进程占着 session.lock/java，最多等 $WaitLockSec 秒再复查"
    $deadline = (Get-Date).AddSeconds($WaitLockSec)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        $evidence = @(Get-WorldEvidence)
        if ($evidence.Count -eq 0) { break }
    }
    if ($evidence.Count -eq 0) { Write-Info '占用已释放，继续冷备' }
}

if ($Mode -eq 'Cold') {
    if ($evidence.Count -gt 0) {
        Write-Fail '拒绝执行：检测到 Minecraft 服务端还在运行（冷备无法保证一致，R4 审计 B1）。'
        foreach ($e in $evidence) { Write-Host "     · $e" -ForegroundColor Yellow }
        Write-Host ''
        Write-Host '     请先优雅关服，再重跑本脚本：' -ForegroundColor Cyan
        Write-Host '       powershell -ExecutionPolicy Bypass -File scripts\stop-panel.ps1'
        Write-Host '       （或双击 停止面板.bat；确认 java 进程已退出、session.lock 不再被独占）'
        Write-Host '     如果只是瞬时占用（例如另一个终端在跑单元测试）：加 -WaitLockSec 60 再试'
        Write-Host '     注意：任务板库被别的进程（mindserver/测试）开着不会拒绝 —— 一致性靠「VACUUM INTO 快照 + 复制期间零变更」证明。'
        Write-Host '     若确实要在运行期尝试：-Mode Hot -Force（预期失败，见脚本注释 B1）'
        if ($FromConfig) {
            # 计划任务不许为了备份去杀服务端：跳过 + 留痕，且把"连续跳过多少天"写出来
            $n = (Get-ConsecutiveSkipCount -Root $root) + 1
            Write-BackupAutoLog -Root $root -Level 'SKIP' -Message ("自动备份因服务端运行跳过（第 {0} 次连续跳过；不杀服务端，等服务端停服后由关服流程备份）" -f $n)
            Write-Host ("     已记录到 logs/backup-auto.log：因服务端运行跳过（第 {0} 次连续）" -f $n) -ForegroundColor Yellow
        }
        exit 2
    }
} else {
    Write-Warn2 'Hot 模式：仍在运行期强行备份 —— 预期会因文件独占失败，但 save-on 一定会补上（B5）。'
}

if ($openDbHandles.Count -gt 0) {
    Write-Warn2 ("有进程还开着任务板库（{0}）—— 不阻止备份：会用 VACUUM INTO 取一致快照，并比对复制期间零变更。" -f ($openDbHandles -join ', '))
}

# ════════════════════════════════════════════════════════════════════
# 1) 目标目录：先 .partial，成功后再原子 rename
# ════════════════════════════════════════════════════════════════════
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
$outFull = (Resolve-Path -LiteralPath $OutDir).Path
$partial = Join-Path $outFull $partialName
$final = Join-Path $outFull $finalName

if (Test-Path -LiteralPath $final) {
    Write-Fail "目标目录已存在：$final（请稍后重试，避免覆盖）"
    exit 1
}

Write-Step "备份目标：$final"
Write-Info "工作目录：$partialName（成功后原子改名）"

$snapDir = Join-Path ([System.IO.Path]::GetTempPath()) ("wbackup-snap-" + $stamp)
$rcon = $null
$savedOff = $false
$flushed = $false
# 每条一致性动作的应答原样留档：不再用"没抛异常"当成成功
$rconLog = [ordered]@{}
$manifestWritten = $false
$exitCode = 0

# RCON 实现见 scripts/lib/rcon.ps1（dot-source 在上面）

if ($Mode -eq 'Hot') {
    $propsPath = Join-Path $root 'server\server.properties'
    if (Test-Path -LiteralPath $propsPath) {
        $kv = @{}
        foreach ($line in Get-Content -LiteralPath $propsPath) {
            if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
            $i = $line.IndexOf('=')
            $kv[$line.Substring(0, $i).Trim()] = $line.Substring($i + 1).Trim()
        }
        if ($kv['enable-rcon'] -eq 'true' -and $kv['rcon.password']) {
            $port = 25575
            if ($kv['rcon.port']) { [void][int]::TryParse($kv['rcon.port'], [ref]$port) }
            $rcon = @{ Password = $kv['rcon.password']; Port = $port }
        }
    }
    if (-not $rcon) { Write-Warn2 'RCON 不可用（未启用/无口令）→ 无法 save-off/all，一致性无保证。' }
}

try {
    New-Item -ItemType Directory -Force -Path $partial | Out-Null
    New-Item -ItemType Directory -Force -Path $snapDir | Out-Null

    if ($Mode -eq 'Hot' -and $rcon) {
        Write-Step 'RCON：save-off + save-all flush'

        # ① save-off —— 只有应答 id 校验通过 + 正文确认"disabled"才算成功
        $r1 = Invoke-Rcon -Password $rcon.Password -Port $rcon.Port -Command 'save-off'
        $rconLog['saveOff'] = [ordered]@{ ok = [bool]$r1.ok; reply = [string]$r1.body; error = [string]$r1.error }
        if ($r1.ok -and ($r1.body -match 'disabl')) {
            $savedOff = $true
            Write-Info "save-off 生效：$($r1.body)"
        } else {
            $why = $(if ($r1.ok) { "应答不含 disabled（原文：$($r1.body)）" } else { $r1.error })
            Write-Warn2 "save-off 失败：$why → 不做 save-on（本来也没关），且一致性标记为 false。"
        }

        # ② save-all flush —— 成功=拿到应答；正文含 Saved 才算真的落盘
        $r2 = Invoke-Rcon -Password $rcon.Password -Port $rcon.Port -Command 'save-all flush'
        $rconLog['flush'] = [ordered]@{ ok = [bool]$r2.ok; reply = [string]$r2.body; error = [string]$r2.error }
        if ($r2.ok -and ($r2.body -match 'Saved|Saving')) {
            $flushed = $true
            Write-Info "save-all flush 生效：$($r2.body)"
        } else {
            $why = $(if ($r2.ok) { "应答不含 Saved（原文：$($r2.body)）" } else { $r2.error })
            Write-Warn2 "save-all flush 失败：$why → 一致性无保证（但 save-on 仍会执行）。"
        }
        Start-Sleep -Milliseconds 800
    }

    # ── 收集组件 ────────────────────────────────────────────────────
    $targets = New-Object System.Collections.Generic.List[object]
    $skipped = New-Object System.Collections.Generic.List[object]
    $exclusions = @{}

    foreach ($name in @('world', 'world_nether', 'world_the_end')) {
        $p = Join-Path $root "server/$name"
        if (Test-Path -LiteralPath $p) {
            $targets.Add([pscustomobject]@{
                    Leaf = $name; Kind = 'world'; Source = "server/$name"
                    SourceAbs = (Resolve-Path -LiteralPath $p).Path
                    Files = @(Get-FileList $p); Replace = @{}; DbTables = @{}
                    Databases = [ordered]@{}
                })
        } else {
            $skipped.Add([ordered]@{ name = $name; reason = "目录不存在：server/$name（该维度从未生成）" })
        }
    }

    # ── robots：单一真相 = mindcraft/bots（mindserver 的 cwd）─────────
    $botsDir = Join-Path $root 'mindcraft/bots'
    if (-not (Test-Path -LiteralPath $botsDir)) { throw "找不到 mindcraft/bots（唯一真相目录）—— 备份会丢掉任务板与全部机器人记忆" }
    $resolved = Resolve-BotsBoardPath $botsDir
    if (-not $resolved.Ok) { throw ("任务板库解析失败，备份会丢掉任务板，拒绝继续：" + $resolved.Reason) }
    $botsBoard = $resolved.Abs
    $boardRel = 'bots/' + $resolved.Rel          # 例：bots/_worlds/w-xxx/_board/board.sqlite

    $botsFiles = @(Get-FileList $botsDir)
    $boardSnap = Join-Path $snapDir 'board.sqlite'
    $boardMeta = New-SqliteSnapshot -SrcDb $botsBoard -DestDb $boardSnap -Tables @('jobs', 'claims', 'shared')
    $boardMeta['path'] = $boardRel
    $boardMeta['sourceDb'] = ('mindcraft/bots/' + $resolved.Rel)
    $boardMeta['walIncluded'] = $false
    Write-Info ("任务板快照：user_version={0} jobs={1} claims={2} shared={3}（VACUUM INTO，{4} 字节）" -f `
            $boardMeta.userVersion, $boardMeta.tables.jobs, $boardMeta.tables.claims, $boardMeta.tables.shared, $boardMeta.bytes)

    $botsDbs = [ordered]@{}
    $botsDbs[$boardRel] = $boardMeta
    $targets.Add([pscustomobject]@{
            Leaf = 'bots'; Kind = 'bots'; Source = 'mindcraft/bots'
            SourceAbs = (Resolve-Path -LiteralPath $botsDir).Path
            Files = $botsFiles
            Replace = @{ $resolved.Rel = $boardSnap }
            DbTables = @{}
            Databases = $botsDbs
        })

    # ── plugins：配置与数据库（排除 jar）────────────────────────────
    $pluginsDir = Join-Path $root 'server/plugins'
    if (Test-Path -LiteralPath $pluginsDir) {
        $cpDb = Join-Path $pluginsDir 'CoreProtect/database.db'
        $replace = @{}
        $dbs = [ordered]@{}
        if (Test-Path -LiteralPath $cpDb) {
            $cpSnap = Join-Path $snapDir 'coreprotect.db'
            $cpMeta = New-SqliteSnapshot -SrcDb $cpDb -DestDb $cpSnap -Tables @()
            $cpMeta['path'] = 'plugins/CoreProtect/database.db'
            $cpMeta['sourceDb'] = 'server/plugins/CoreProtect/database.db'
            $cpMeta['walIncluded'] = $false
            $replace['CoreProtect/database.db'] = $cpSnap
            $dbs['plugins/CoreProtect/database.db'] = $cpMeta
            Write-Info ("CoreProtect 快照：{0:N1} MB（VACUUM INTO）" -f ($cpMeta.bytes / 1MB))
        }
        $targets.Add([pscustomobject]@{
                Leaf = 'plugins'; Kind = 'plugins'; Source = 'server/plugins'
                SourceAbs = (Resolve-Path -LiteralPath $pluginsDir).Path
                Files = @(Get-FileList $pluginsDir); Replace = $replace; DbTables = @{}
                Databases = $dbs
            })
    } else {
        $skipped.Add([ordered]@{ name = 'plugins'; reason = '目录不存在：server/plugins' })
    }

    # ── server-config：恢复出一台"能跑的服务器"必需的文件 ──────────
    $cfgFiles = New-Object System.Collections.Generic.List[object]
    $cfgExcluded = New-Object System.Collections.Generic.List[object]
    $cfgRedacted = New-Object System.Collections.Generic.List[object]
    $serverCfgNames = @('server.properties', 'eula.txt', 'ops.json', 'whitelist.json',
        'banned-ips.json', 'banned-players.json', 'usercache.json',
        'bukkit.yml', 'spigot.yml', 'commands.yml', 'help.yml', 'permissions.yml', 'version_history.json')
    foreach ($n in $serverCfgNames) {
        $p = Join-Path $root "server/$n"
        if (-not (Test-Path -LiteralPath $p)) { continue }
        # ★ R6 #9（2026-11-10）：`-ExcludeSecrets` 原来是**整份丢掉** server.properties。
        #   后果：备份恢复出来的是另一台服（enable-rcon/online-mode/white-list/view-distance
        #   全丢），而且 stop-panel 的优雅关服链依赖 RCON ⇒ 恢复后只能硬关。
        #   现在改为**脱敏入包**：保留全部非敏感行，只把 rcon.password 抹成空。
        #   演练侧本来就会自己注入端口与口令（restore-drill:353-354），所以抹空不影响演练。
        if ($ExcludeSecrets -and $n -eq 'server.properties') {
            $redacted = Join-Path $snapDir 'server.properties.redacted'
            $outLines = foreach ($l in @(Get-Content -LiteralPath $p -ErrorAction Stop)) {
                if ($l -match '^\s*rcon\.password\s*=') { 'rcon.password=' } else { $l }
            }
            Set-Content -LiteralPath $redacted -Value $outLines -Encoding ASCII
            $cfgFiles.Add((Get-FileEntry $redacted "server/$n"))
            $cfgRedacted.Add([ordered]@{ path = "server/$n"; field = 'rcon.password'; reason = '-ExcludeSecrets：口令抹空后入包（其余设置全保留，保证可复现）' })
            Write-Info 'server.properties：已脱敏入包（rcon.password 置空）'
            continue
        }
        $cfgFiles.Add((Get-FileEntry $p "server/$n"))
    }
    foreach ($sub in @('server/config', 'config')) {
        $p = Join-Path $root $sub
        if (-not (Test-Path -LiteralPath $p)) { continue }
        $pFull = (Resolve-Path -LiteralPath $p).Path.TrimEnd('\', '/')
        foreach ($f in @(Get-ChildItem -LiteralPath $pFull -Recurse -File -Force -ErrorAction Stop)) {
            $rel = $sub + '/' + $f.FullName.Substring($pFull.Length + 1).Replace('\', '/')
            $cfgFiles.Add((Get-FileEntry $f.FullName $rel))
        }
    }
    if ($cfgFiles.Count -gt 0) {
        $targets.Add([pscustomobject]@{
                Leaf = 'server-config'; Kind = 'config'; Source = 'server/*.json|*.yml|*.properties + server/config + config'
                SourceAbs = (Resolve-Path -LiteralPath (Join-Path $root 'server')).Path
                Files = $cfgFiles.ToArray(); Replace = @{}; DbTables = @{}
                Databases = [ordered]@{}
            })
    } else {
        $skipped.Add([ordered]@{ name = 'server-config'; reason = '没有找到任何服务端配置文件' })
    }

    # ── logs：只留最近 N 天 ─────────────────────────────────────────
    if ($LogDays -gt 0) {
        $logsDir = Join-Path $root 'server/logs'
        if (Test-Path -LiteralPath $logsDir) {
            $cutoff = (Get-Date).AddDays(-$LogDays)
            $lf = @(Get-FileList $logsDir | Where-Object { $_.MTimeUtc -ge $cutoff.Ticks })
            if ($lf.Count -gt 0) {
                $targets.Add([pscustomobject]@{
                        Leaf = 'logs'; Kind = 'logs'; Source = "server/logs（最近 $LogDays 天）"
                        SourceAbs = (Resolve-Path -LiteralPath $logsDir).Path
                        Files = $lf; Replace = @{}; DbTables = @{}
                        Databases = [ordered]@{}
                    })
            } else {
                $skipped.Add([ordered]@{ name = 'logs'; reason = "最近 $LogDays 天没有日志" })
            }
        } else {
            $skipped.Add([ordered]@{ name = 'logs'; reason = '目录不存在：server/logs' })
        }
    }

    if ($targets.Count -eq 0) { throw '没找到任何要备份的目录/文件' }

    # ── 压缩 + 自检 ────────────────────────────────────────────────
    $entries = New-Object System.Collections.Generic.List[object]

    foreach ($t in $targets) {
        Write-Step "压缩 $($t.Leaf) ← $($t.Source)"
        if ($t.Files.Count -eq 0) { throw "$($t.Source) 里一个文件都没有（空组件不值得备份）" }

        $preMap = Get-QuiescenceMap $t.Files

        $zipPath = Join-Path $partial "$($t.Leaf).zip"
        $zipStat = New-WorldZip -Leaf $t.Leaf -ZipPath $zipPath -Files $t.Files -Replace $t.Replace

        # 复制期间零变更（快照与源目录必须同一时刻）
        $postMap = @{}
        foreach ($f in $t.Files) { $postMap[$f.Rel] = "$($f.Size)|$($f.MTimeUtc)" }
        if ($t.Kind -in @('world', 'bots', 'plugins', 'logs')) {
            $srcDir = $t.SourceAbs
            if ($t.Kind -eq 'logs') { $postMap = Get-QuiescenceMap (Get-FileList $srcDir | Where-Object { $_.MTimeUtc -ge ((Get-Date).AddDays(-$LogDays)).Ticks }) } elseif ($t.Kind -ne 'config') { $postMap = Get-QuiescenceMap (Get-FileList $srcDir) }
        }
        $changed = New-Object System.Collections.Generic.List[string]
        foreach ($k in $preMap.Keys) {
            if (-not $postMap.ContainsKey($k)) { $changed.Add("$k（复制期间被删除）") }
            elseif ($postMap[$k] -ne $preMap[$k]) { $changed.Add($k) }
        }
        foreach ($k in $postMap.Keys) { if (-not $preMap.ContainsKey($k)) { $changed.Add("$k（复制期间新增）") } }
        # 被快照替换的库文件本身会变（VACUUM 也在读它），不计入"源目录漂移"
        $changed = @($changed | Where-Object { $_ -notmatch 'board\.sqlite|database\.db' })
        if ($changed.Count -gt 0) {
            throw ("备份期间 $($t.Source) 仍在被写入（$($changed.Count) 个文件，例如 {0}）→ 快照不是同一时刻，拒绝出报告" -f $changed[0])
        }

        foreach ($k in $zipStat.ExclusionReasons.Keys) {
            if (-not $exclusions.ContainsKey($k)) { $exclusions[$k] = 0 }
            $exclusions[$k] += $zipStat.ExclusionReasons[$k]
        }

        $inv = Get-ZipInventory -ZipPath $zipPath
        $counts = Get-EntryCounts -Entries $inv.Entries -Leaf $t.Leaf

        # 应入包条目 = 源文件数 - 被排除数 + 快照替换新增的条目数
        $expectedCount = $t.Files.Count - $zipStat.ExcludedCount + $t.Replace.Count
        if ($inv.FileCount -ne $expectedCount) {
            throw "自检失败：$($t.Leaf) 应有 $expectedCount 个条目，zip 里只有 $($inv.FileCount)"
        }
        $byName = @{}
        foreach ($it in $inv.Entries) { $byName[$it.Name] = $it.Size }
        foreach ($f in $t.Files) {
            $relBase = ($f.Rel -replace '-wal$', '') -replace '-shm$', ''
            if ($t.Replace.ContainsKey($f.Rel) -or $t.Replace.ContainsKey($relBase)) { continue }
            if (Get-ExclusionReason $f.Rel) { continue }
            $entryName = "$($t.Leaf)/$($f.Rel)"
            if (-not $byName.ContainsKey($entryName)) { throw "自检失败：zip 缺少条目 $entryName" }
            if ($byName[$entryName] -ne $f.Size) { throw "自检失败：条目 $entryName 大小不符（源 $($f.Size)，包 $($byName[$entryName])）" }
        }
        foreach ($rel in $t.Replace.Keys) {
            if (-not $byName.ContainsKey("$($t.Leaf)/$rel")) { throw "自检失败：快照条目缺失 $($t.Leaf)/$rel" }
        }

        $zipItem = Get-Item -LiteralPath $zipPath
        $entry = [ordered]@{
            name                   = "$($t.Leaf).zip"
            kind                   = $t.Kind
            source                 = $t.Source
            sourceAbs              = $t.SourceAbs
            bytes                  = [int64]$zipItem.Length
            sha256                 = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
            fileCount              = [int64]$inv.FileCount
            totalUncompressedBytes = [int64]$inv.TotalUncompressedBytes
            inventoryDigest        = $inv.InventoryDigest
            counts                 = $counts
            databases              = $t.Databases
        }
        $entries.Add($entry)

        Write-Info ("{0}.zip：{1:N1} MB，{2} 条目（排除 {3}），region={4} playerdata={5}" -f `
                $t.Leaf, ($zipItem.Length / 1MB), $inv.FileCount, $zipStat.ExcludedCount, $counts.regions, $counts.playerdata)
    }

    # ── 单一真相说明（双 bots 目录）────────────────────────────────
    $legacyBots = Join-Path $root 'bots'
    $legacyInfo = [ordered]@{ path = 'bots'; exists = (Test-Path -LiteralPath $legacyBots); note = '' }
    if ($legacyInfo.exists) {
        $legacyBoard = Join-Path $legacyBots '_board/board.sqlite'
        $legacyNote = '仓库根的 bots\ 是 11-02 之前的遗留目录，脚本不备份它'
        if (Test-Path -LiteralPath $legacyBoard) {
            $lq = Invoke-Sqlite -DbPath $legacyBoard -Mode 'ro' -Tables @('jobs', 'claims', 'shared')
            if ($lq) { $legacyNote += "；其 _board 已过期（user_version=$($lq.userVersion)，shared=$($lq.tables.shared) 行）" }
        }
        $legacyInfo.note = $legacyNote
    }

    # ── manifest（最后写；写完才允许 rename）────────────────────────
    $excludedList = New-Object System.Collections.Generic.List[object]
    foreach ($k in ($exclusions.Keys | Sort-Object)) {
        $excludedList.Add([ordered]@{ pattern = $k; files = $exclusions[$k] })
    }
    foreach ($ce in $cfgExcluded) { $excludedList.Add([ordered]@{ pattern = "$($ce.path)：$($ce.reason)"; files = 1 }) }

    $consistent = $false
    $note = ''
    if ($Mode -eq 'Cold') {
        $consistent = $true
        $note = '冷备：Minecraft 服务端已停止（java/session.lock 检测通过）；每个组件复制前后比对 (大小,mtime) 零变更；SQLite 用 VACUUM INTO 取一致快照'
    } else {
        # T22：save-off 与 save-all flush **分别**判成功，任一失败就如实标 false
        $consistent = ($savedOff -and $flushed)
        if ($consistent) {
            $note = 'save-off + save-all flush 均已确认应答（Hot 模式，仍有并发写入风险）'
        } else {
            $parts = @()
            if (-not $savedOff) { $parts += 'save-off 未成功' }
            if (-not $flushed) { $parts += 'save-all flush 未确认' }
            $note = ('一致性无保证：' + ($parts -join '；') + '（Hot 模式）')
        }
    }

    $manifest = [ordered]@{
        schemaVersion   = 3
        createdAt       = (Get-Date).ToString('o')
        mode            = $Mode
        consistent      = $consistent
        note            = $note
        project         = $root
        partialName     = $partialName
        components      = @($targets | ForEach-Object { $_.Leaf })
        sourceQuiescent = $true
        openDbHandles   = @($openDbHandles)
        rcon            = $(if ($rconLog.Count -gt 0) { $rconLog } else { $null })
        botsSource      = [ordered]@{
            canonical = 'mindcraft/bots'
            absolute  = (Resolve-Path -LiteralPath $botsDir).Path
            why       = 'mindserver 以 -WorkingDirectory <repo>\mindcraft 启动（scripts/start-panel.ps1:245），bot_paths.js 的 botsRootOf() 默认 ./bots 因此解析到 mindcraft/bots'
            legacy    = $legacyInfo
        }
        # ★ R6 #46：插件 jar 按约定不进备份（53MB 可重下），但**清单必须留**，
        #   否则恢复者不知道原来装了哪几个插件、什么版本 —— "恢复可重现"就不成立。
        pluginJars      = @(Get-ChildItem (Join-Path $root 'server/plugins') -Filter '*.jar' -File -ErrorAction SilentlyContinue |
            Sort-Object Name |
            ForEach-Object { [ordered]@{ name = $_.Name; bytes = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } })
        containsSecrets = (-not $ExcludeSecrets)
        # ★ R6 #7-②：manifest 要能回答"这份备份为什么带/不带口令"
        secretsPolicy   = [ordered]@{
            excludeSecrets = [bool]$ExcludeSecrets
            source         = $secretsSource
            configPath     = $backupCfg.configPath
            configFromFile = [bool]$backupCfg.fromFile
        }
        redacted        = $cfgRedacted.ToArray()
        secretNote      = $(if ($ExcludeSecrets) { 'server-config.zip 内含 server/server.properties，但 rcon.password 已抹空（其余设置完整保留）；恢复后按 manifest.redacted 填回口令即可' } else { 'server-config.zip 内含 server/server.properties（含 rcon.password）：备份目录等同敏感数据，请勿外传/入库' })
        skipped         = $skipped.ToArray()
        excluded        = $excludedList.ToArray()
        entries         = $entries.ToArray()
    }

    $json = $manifest | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText((Join-Path $partial 'manifest.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
    $manifestWritten = $true

    Rename-Item -LiteralPath $partial -NewName $finalName -ErrorAction Stop

    Write-Step "完成：$final"
    Write-Info "组件：$(($targets | ForEach-Object { $_.Leaf }) -join ', ')"
    Write-Info "一致性：$(if ($consistent) { '已保证（' + $Mode + '）' } else { '无保证（见 WARN）' })"
    if (-not $ExcludeSecrets) {
        Write-Warn2 '备份内含 server\server.properties（RCON 口令）—— 备份目录属敏感数据，别外传、别提交进 git。'
        Write-Info '        下次想脱敏：去掉 -IncludeSecrets（默认按 config/backup.json 的 excludeSecrets=true 抹空口令）。'
    }
    Write-Info "核验：powershell -File scripts\verify-world-backup.ps1 -BackupDir `"$final`""
    if ($FromConfig) {
        Write-BackupAutoLog -Root $root -Level 'OK' -Message ("自动备份成功：{0}（{1:N0} MB，keep={2}）" -f `
                (Split-Path -Leaf $final), ((Get-ChildItem $final -File | Measure-Object Length -Sum).Sum / 1MB), $Keep)
    }
    $exitCode = 0
} catch {
    Write-Fail "备份失败：$($_.Exception.Message)"
    if ($_.ScriptStackTrace) { Write-Info "位置：$($_.ScriptStackTrace)" }
    if ($FromConfig) {
        Write-BackupAutoLog -Root $root -Level 'ERROR' -Message "自动备份失败：$($_.Exception.Message)"
    }
    $exitCode = 1
} finally {
    if ($savedOff -and $rcon) {
        Write-Step '恢复自动写盘（save-on）'
        $r3 = Invoke-Rcon -Password $rcon.Password -Port $rcon.Port -Command 'save-on'
        $rconLog['saveOn'] = [ordered]@{ ok = [bool]$r3.ok; reply = [string]$r3.body; error = [string]$r3.error }
        if ($r3.ok) { Write-Info "save-on 生效：$($r3.body)" }
        if (-not $r3.ok) {
            Write-Fail 'save-on 没成功！服务器自动写盘可能仍处于关闭状态 —— 请立刻手动执行 RCON save-on 或重启服务端。'
            $exitCode = 1
        }
    }
    Remove-Item $snapDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-SqlHelper

    if ($exitCode -ne 0) {
        if (Test-Path -LiteralPath $partial) {
            if (-not $manifestWritten -and -not $KeepPartial) {
                Remove-Item -LiteralPath $partial -Recurse -Force -ErrorAction SilentlyContinue
                Write-Info "已清理半成品目录（$partialName）—— 失败不会留下会被误认为备份的目录"
            } else {
                Write-Warn2 "保留半成品目录供排查：$partial（不含有效 manifest，不会被当成备份；确认后请手动删除）"
            }
        }
    }
}

if ($exitCode -ne 0) { exit $exitCode }

# ── 保留策略（只清理本脚本产出的目录：必须含 manifest.json）──────────
if ($Keep -gt 0) {
    $olds = @(Get-ChildItem $outFull -Directory -Filter 'world-*' |
            Where-Object { $_.Name -notlike '*.partial' -and (Test-Path (Join-Path $_.FullName 'manifest.json')) } |
            Sort-Object LastWriteTime -Descending |
            Select-Object -Skip $Keep)
    foreach ($d in $olds) {
        Write-Info "清理旧备份：$($d.Name)"
        Remove-Item $d.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
}

exit 0
