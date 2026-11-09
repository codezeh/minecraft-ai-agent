#!/usr/bin/env node
/**
 * OPS-004 离线回归（2026-11-06 深度检查）—— 凭据文件不得对普通用户/认证用户开放。
 *
 * 缺陷原貌（实测 Get-Acl）：mindcraft/.mindserver-token、mindcraft/keys.json、
 * server/server.properties 三个文件的 DACL 都是从父目录**继承**来的，含
 *   NT AUTHORITY\Authenticated Users | Modify
 *   BUILTIN\Users                  | ReadAndExecute
 * ⇒ 同一台 Windows 主机上的另一个非管理员账户能读控制台令牌 / 模型 API Key / RCON 密码，还能改。
 *   mindserver.js 给 token 文件设的 POSIX mode 0600 在 NTFS 上不生效。
 *
 * 修复：scripts/harden-credentials-acl.ps1 把这三个文件改成**非继承** DACL，
 * 只留 当前账户 / SYSTEM / Administrators，并自带"应用仍可读写"的自检。
 *
 * 本测做两件事（不修改任何 ACL）：
 *   A. **现状断言**：真跑 Get-Acl，断言没有过宽主体、继承已关闭；
 *   B. **脚本能力断言**：脚本必须存在、语法可解析、默认是"体检不改"、
 *      并且真的包含收口逻辑（不能只写个报告了事）。
 *
 * R5-002（2026-11-08）：`.mindserver-token` 是**运行时产物**（mindserver 启动才写 cwd），
 *   干净仓库/CI 本来就没有它。原来断言"必须存在"⇒ 干净仓库必红一条，
 *   与凭据安全无关却让本脚本无法当门禁。现在：不存在 → SKIP 并打印原因；
 *   存在 → 照旧校验它的 DACL。其余断言不变。
 *
 * 用法：node scripts/tests/acl-regression.mjs
 * 输出：PASS/FAIL 逐条，全过退出码 0。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
let pass = 0, fail = 0, skip = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name} ${detail}`) }
  else { fail++; console.log(`FAIL ${name} ${detail}`) }
}
// SKIP：不判红也不判绿。用于**运行时产物**（跑起来才有、干净仓库本不该存在）——
// 把它们当"仓库不变量"去断言，会让干净 clone / CI 永远红一条（R5-002）。
const skipCheck = (name, detail = '') => { skip++; console.log(`SKIP ${name} ${detail}`) }

// t20 B（R5-收口）：原来只覆盖三个**文件**，t11 刚加固的 `server-test/server.properties`
//   （RCON 口令）却没被回归覆盖 ⇒ 有人一把 `icacls <文件> /inheritance:e` 就能让它静默复发、
//   而回归仍全绿。`mindcraft/`（目录）同理，判据不同，单独在下面 A2 段里查。
const TARGETS = [
  'mindcraft\\.mindserver-token',
  'mindcraft\\keys.json',
  'server\\server.properties',
  'server-test\\server.properties',   // t11 加固（R5-009）：测试服 RCON 口令
]

// ════════════════════════════════════════════════════════════
// A. 现状：真读 ACL
// ════════════════════════════════════════════════════════════
const probe = `
$ErrorActionPreference = 'Stop'
$out = @()
foreach ($rel in @(${TARGETS.map(t => `'${t}'`).join(',')})) {
    $p = Join-Path '${ROOT.replace(/'/g, "''")}' $rel
    if (-not (Test-Path -LiteralPath $p)) { $out += [pscustomobject]@{ rel = $rel; missing = $true }; continue }
    $acl = Get-Acl -LiteralPath $p
    $broad = @()
    foreach ($r in $acl.Access) {
        $id = $r.IdentityReference.Value
        # 允许清单：当前账户 / SYSTEM / Administrators；显式 Deny 不算放开
        $allowed = ($id -eq [System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -or
                   ($id -eq 'NT AUTHORITY\\SYSTEM') -or
                   ($id -eq 'BUILTIN\\Administrators')
        if (-not $allowed -and $r.AccessControlType -ne 'Deny') { $broad += ($id + ':' + $r.FileSystemRights) }
    }
    $out += [pscustomobject]@{
        rel = $rel
        missing = $false
        protected = $acl.AreAccessRulesProtected
        broad = $broad
        rules = $acl.Access.Count
    }
}
$out | ConvertTo-Json -Compress -Depth 5
`
const r = spawnSync('powershell', ['-NoProfile', '-Command', probe], { encoding: 'utf8' })
check('A 能读到 ACL 现状', r.status === 0, `→ status=${r.status} stderr=${(r.stderr || '').slice(0, 300)}`)

let acls = null
try { acls = JSON.parse((r.stdout || '').trim()) } catch { /* ignore */ }
if (acls && !Array.isArray(acls)) acls = [acls]
check('A ACL 探测返回了三个目标', Array.isArray(acls) && acls.length === TARGETS.length,
  `→ ${JSON.stringify(acls)}`)

// 这三个目标里有**运行时产物**：.mindserver-token 由 mindserver 启动时写到自己的 cwd，
// 干净仓库（未启动过面板 / CI）本来就不该存在。要求它"必须存在"等于把运行时状态
// 当成仓库不变量 —— 面板没跑就必红一条，而这条红与凭据安全毫无关系（R5-002）。
const RUNTIME_ARTIFACTS = new Set(['mindcraft\\.mindserver-token'])

for (const a of acls || []) {
  if (a.missing === true) {
    if (RUNTIME_ARTIFACTS.has(a.rel)) {
      skipCheck(`A ${a.rel} 存在`, '→ 跳过：token 由 mindserver 启动时生成，干净仓库本不该存在')
    } else {
      check(`A ${a.rel} 存在`, false)
    }
    continue
  }
  check(`A ${a.rel} 存在`, true)
  check(`A ${a.rel} DACL 已断开继承`, a.protected === true, `→ protected=${a.protected}`)
  check(`A ${a.rel} 没有 Users/Authenticated Users 之类过宽主体`,
    Array.isArray(a.broad) && a.broad.length === 0, `→ ${JSON.stringify(a.broad)}`)
  check(`A ${a.rel} 仍留有 ACE（没把自己锁死）`, (a.rules || 0) > 0, `→ rules=${a.rules}`)
}

// ════════════════════════════════════════════════════════════
// A2. 目录目标：mindcraft/（t20 B；判据与文件不同）
//   目录必须允许别的进程"读+穿过"，所以不能要求"无过宽主体"；
//   真正要守住的是：**非白名单主体没有任何写类位**（否则能删/换 keys.json 再放一个假文件），
//   以及**当前账户仍是 FullControl**（别把应用自己锁在外面）。
// ════════════════════════════════════════════════════════════
const dirProbe = `
$ErrorActionPreference = 'Stop'
$p = Join-Path '${ROOT.replace(/'/g, "''")}' 'mindcraft'
if (-not (Test-Path -LiteralPath $p)) { '{"missing":true}' ; exit 0 }
$acl = Get-Acl -LiteralPath $p
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$writeWords = @('Write', 'Modify', 'FullControl', 'Delete', 'ChangePermissions', 'TakeOwnership', 'AppendData', 'CreateFiles', 'CreateDirectories')
$broad = @()
$broadWrite = @()
$meFull = $false
foreach ($r in $acl.Access) {
    $id = $r.IdentityReference.Value
    $rights = $r.FileSystemRights.ToString()
    if (($id -eq $me) -and ($r.AccessControlType -eq 'Allow') -and ($rights -match 'FullControl')) { $meFull = $true }
    $allowed = ($id -eq $me) -or ($id -eq 'NT AUTHORITY\\SYSTEM') -or ($id -eq 'BUILTIN\\Administrators')
    if (-not $allowed -and $r.AccessControlType -ne 'Deny') {
        $broad += ($id + ':' + $rights)
        $hasWrite = $false
        foreach ($w in $writeWords) { if ($rights -like ('*' + $w + '*')) { $hasWrite = $true } }
        if ($hasWrite) { $broadWrite += ($id + ':' + $rights) }
    }
}
[pscustomobject]@{
    missing = $false
    protected = $acl.AreAccessRulesProtected
    broad = $broad
    broadWrite = $broadWrite
    meFull = $meFull
    rules = $acl.Access.Count
} | ConvertTo-Json -Compress -Depth 5
`
const dr = spawnSync('powershell', ['-NoProfile', '-Command', dirProbe], { encoding: 'utf8' })
let dacl = null
try { dacl = JSON.parse((dr.stdout || '').trim()) } catch { /* ignore */ }
check('A2 能读到 mindcraft/ 目录的 ACL', dr.status === 0 && dacl !== null,
  `→ status=${dr.status} stderr=${(dr.stderr || '').slice(0, 200)}`)
if (dacl) {
  check('A2 mindcraft/ 存在', dacl.missing !== true)
  if (dacl.missing !== true) {
    check('A2 mindcraft/ 非白名单主体没有写类权限（防删除重建 keys.json）',
      Array.isArray(dacl.broadWrite) && dacl.broadWrite.length === 0,
      `→ 写类过宽 ACE ${JSON.stringify(dacl.broadWrite)}（只读类可接受，如 Authenticated Users:(RX)）`)
    check('A2 mindcraft/ 当前账户仍 FullControl（应用自己别被锁在外面）',
      dacl.meFull === true, `→ meFull=${dacl.meFull}`)
    check('A2 mindcraft/ 仍留有 ACE（没把自己锁死）', (dacl.rules || 0) > 0, `→ rules=${dacl.rules}`)
  }
}

// ════════════════════════════════════════════════════════════
// B. 脚本能力
// ════════════════════════════════════════════════════════════
const scriptPath = path.join(ROOT, 'scripts', 'harden-credentials-acl.ps1')
check('B 加固脚本存在', fs.existsSync(scriptPath))
const src = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : ''

check('B 脚本默认只体检（-Apply 才改）', /\$Apply/.test(src) && /-Apply/.test(src))
check('B 脚本用 SetAccessRuleProtection 断开继承', /SetAccessRuleProtection\(\$true,\s*\$false\)/.test(src))
check('B 脚本只放行 当前账户/SYSTEM/Administrators',
  /NT AUTHORITY\\SYSTEM/.test(src) && /BUILTIN\\Administrators/.test(src) && /\$me/.test(src))
check('B 脚本带应用可用性自检（可读可写）', /应用可用性自检/.test(src) && /ReadAllBytes/.test(src))
check('B 脚本给出回滚方式', /inheritance:e/.test(src))

// UTF-8 BOM：PS 5.1 读无 BOM 的 UTF-8 会按 ANSI 解，中文注释里常出现"半个汉字吃掉引号"的解析错误。
const head = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath).subarray(0, 3) : Buffer.alloc(0)
check('B 脚本带 UTF-8 BOM（PowerShell 5.1 才不乱码）',
  head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF,
  `→ ${[...head].map(b => b.toString(16)).join(' ')}`)

// 语法必须可解析（不执行）
const syntax = spawnSync('powershell', ['-NoProfile', '-Command',
  `$e=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile('${scriptPath.replace(/'/g, "''")}',[ref]$null,[ref]$e); if($e.Count -gt 0){ $e | ForEach-Object { Write-Output $_.Message }; exit 1 } else { Write-Output 'OK' }`,
], { encoding: 'utf8' })
check('B 脚本语法可解析', syntax.status === 0 && /OK/.test(syntax.stdout || ''),
  `→ ${(syntax.stdout || '').slice(0, 200)}`)

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed` +
  (skip > 0 ? `, ${skip} skipped（运行时产物：干净仓库不该有，不计红）` : ''))
process.exit(fail === 0 ? 0 : 1)
