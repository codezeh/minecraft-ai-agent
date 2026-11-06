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
 * 用法：node scripts/tests/acl-regression.mjs
 * 输出：PASS/FAIL 逐条，全过退出码 0。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name} ${detail}`) }
  else { fail++; console.log(`FAIL ${name} ${detail}`) }
}

const TARGETS = [
  'mindcraft\\.mindserver-token',
  'mindcraft\\keys.json',
  'server\\server.properties',
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

for (const a of acls || []) {
  check(`A ${a.rel} 存在`, a.missing !== true)
  if (a.missing) continue
  check(`A ${a.rel} DACL 已断开继承`, a.protected === true, `→ protected=${a.protected}`)
  check(`A ${a.rel} 没有 Users/Authenticated Users 之类过宽主体`,
    Array.isArray(a.broad) && a.broad.length === 0, `→ ${JSON.stringify(a.broad)}`)
  check(`A ${a.rel} 仍留有 ACE（没把自己锁死）`, (a.rules || 0) > 0, `→ rules=${a.rules}`)
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

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
