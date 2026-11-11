#!/usr/bin/env node
/**
 * OPS-001 / OPS-002 离线回归（2026-11-06 深度检查）。
 *
 * OPS-001 [P1] 一键启动最后一步构造了错误 URL
 *   缺陷：`$panelUrl = "$panel?token=$tok"`。PowerShell 把 `?` 算进变量名 ⇒
 *         实际展开成 `=DUMMY_ONLY`，浏览器被叫去打开一个相对地址，进不了控制台
 *         （服务其实已经起来了）。修复：`"${panel}?token=$tok"`。
 *   本测**真的让 PowerShell 执行那行字符串**（从脚本里抽出来跑），不信注释。
 *
 * OPS-002 [P1] RCON 关服失败仍关闭管理端并报告完成
 *   缺陷：server-stop 的 ack 失败时也往下走 → shutdown 管理端 → exit 0 + "完成。"，
 *         而 Minecraft 还在后台跑，用户接着强关窗口就丢存档。
 *   修复：失败 ⇒ 保留管理端 + 退出码 4；成功 ⇒ 必须确认端口已关闭才算完。
 *   本测断言 `web/scripts/stop-policy.mjs` 的三态决策，并核对 stop-all.mjs 真的按它分支。
 *
 * 用法：node scripts/tests/ops-regression.mjs
 * 输出：PASS/FAIL 逐条，全过退出码 0。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name} ${detail}`) }
  else { fail++; console.log(`FAIL ${name} ${detail}`) }
}

const readSrc = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

// ════════════════════════════════════════════════════════════
// OPS-001：PowerShell 里真实求值
// ════════════════════════════════════════════════════════════
const startSrc = readSrc('scripts/start-panel.ps1')

// 抽出脚本里给 $panelUrl 赋值的那一行（不含注释），原样交给 PowerShell 求值。
const assignLine = startSrc
  .split(/\r?\n/)
  .find(l => /^\s*\$panelUrl\s*=/.test(l) && !/^\s*#/.test(l))

check('OPS-001 找到 $panelUrl 赋值行', Boolean(assignLine), `→ ${assignLine}`)
check('OPS-001 赋值行用 ${panel} 划定变量边界（不再是裸 $panel?）',
  /\$\{panel\}/.test(assignLine || ''), `→ ${assignLine}`)
check('OPS-001 脚本里不再有裸 `$panel?token` 写法',
  !/\$panel\?token/.test(startSrc.replace(/^\s*#.*$/gm, '')))

if (assignLine) {
  // 用真 PowerShell 跑这一行，模拟三种 token，断言 URL 结构正确。
  const probe = `
$panel = 'http://127.0.0.1:8080/'
$tok = 'TOK123'
${assignLine.trim()}
Write-Output $panelUrl
`
  const r = spawnSync('powershell', ['-NoProfile', '-Command', probe], { encoding: 'utf8' })
  const out = (r.stdout || '').trim()
  check('OPS-001 PowerShell 求值成功', r.status === 0, `→ status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`)
  check('OPS-001 求值结果带完整 host（不是 /?token= 相对地址）',
    /^http:\/\/127\.0\.0\.1:8080\/\?token=TOK123$/.test(out), `→ "${out}"`)
  check('OPS-001 求值结果不是报告里的 bug 形态（=TOK123）', out !== '=TOK123', `→ "${out}"`)

  // 再钉一次"当时的 bug 形态"，证明这条测试真的能抓到它
  const bugProbe = `
$panel = 'http://127.0.0.1:8080/'
$tok = 'TOK123'
$batchBug = "$panel?token=$tok"
Write-Output $batchBug
`
  const rb = spawnSync('powershell', ['-NoProfile', '-Command', bugProbe], { encoding: 'utf8' })
  check('OPS-001 旧写法确实产出坏的 URL（说明这条断言有效）',
    (rb.stdout || '').trim() === '=TOK123', `→ "${(rb.stdout || '').trim()}"`)
}

// ════════════════════════════════════════════════════════════
// OPS-002：决策三态
// ════════════════════════════════════════════════════════════
const policy = await import(pathToFileURL(path.join(ROOT, 'web/scripts/stop-policy.mjs')).href)
const { decideAfterStop, decideAfterExitWait, STOP_EXIT } = policy

check('OPS-002 有独立的"关服失败"退出码（不是 0）',
  STOP_EXIT.STOP_FAILED === 4 && STOP_EXIT.OK === 0, `→ ${JSON.stringify(STOP_EXIT)}`)

const okRes = decideAfterStop({ ok: true, response: 'stop' })
check('OPS-002 ok=true → proceed', okRes.action === 'proceed')

const notRunning = decideAfterStop({ ok: false, reason: 'not_running' })
check('OPS-002 not_running → proceed（本来就没跑，跳过是对的）', notRunning.action === 'proceed')

for (const reason of ['rcon_failed', 'rcon_disabled', '超时（mindserver 可能没开）', '空响应', 'unknown']) {
  const d = decideAfterStop({ ok: false, reason, hint: 'hint' })
  check(`OPS-002 ${reason} → fail（不许继续关管理端）`, d.action === 'fail', `→ ${JSON.stringify(d)}`)
}
// 报告复现值：rcon_failed 必须 fail
check('OPS-002 报告复现：rcon_failed 判为失败',
  decideAfterStop({ ok: false, reason: 'rcon_failed', hint: 'ECONNREFUSED' }).action === 'fail')
// 空/undefined 响应也要 fail，不能当成功
check('OPS-002 null 响应 → fail', decideAfterStop(null).action === 'fail')
check('OPS-002 undefined 响应 → fail', decideAfterStop(undefined).action === 'fail')

// 事后确认：指令发了但服务器没退出 → 也算失败
check('OPS-002 端口仍开着（没退出）→ fail', decideAfterExitWait(false).action === 'fail')
check('OPS-002 端口已关（真退出）→ proceed', decideAfterExitWait(true).action === 'proceed')

// ════════════════════════════════════════════════════════════
// OPS-002：接线断言（脚本必须真的按决策分支，不能"算了不用"）
// ════════════════════════════════════════════════════════════
const stopAll = readSrc('web/scripts/stop-all.mjs')
check('OPS-002 stop-all 引入决策模块', /from '\.\/stop-policy\.mjs'/.test(stopAll))
check('OPS-002 stop-all 用 decideAfterStop', /decideAfterStop\(/.test(stopAll))
check('OPS-002 stop-all 用 decideAfterExitWait', /decideAfterExitWait\(/.test(stopAll))
check('OPS-002 stop-all 失败时非零退出', /process\.exit\(STOP_EXIT\.STOP_FAILED\)/.test(stopAll))
check('OPS-002 stop-all 在失败分支里不 emit shutdown',
  // failStop 里必须没有 shutdown；shutdown 只能在正常路径之后
  !/function failStop[\s\S]{0,600}?emit\('shutdown'\)/.test(stopAll))
check('OPS-002 stop-all 有端口探测（确认真的退出）', /isPortOpen\(/.test(stopAll) && /waitServerExit\(/.test(stopAll))
check('OPS-002 旧文案"跳过：rcon_failed 后照样完成"已消失',
  !/console\.log\('   跳过：' \+ \(r\?\.reason/.test(stopAll))

// stop-panel.ps1 必须解释退出码 4
const stopPanel = readSrc('scripts/stop-panel.ps1')
check('OPS-002 stop-panel.ps1 处理退出码 4', /\$stopCode -eq 4/.test(stopPanel))
check('OPS-002 stop-panel.ps1 明确"管理端仍在运行"', /管理端\*\*仍在运行\*\*/.test(stopPanel))

// ════════════════════════════════════════════════════════════
// R6 #44 / #56：start-panel 的"假成功"分支 —— 行为断言（不是正则）
// ════════════════════════════════════════════════════════════
// 判据实现已搬到 scripts/lib/panel_guard.ps1；这里 dot-source 它、喂**假事实**、断言判据。
// 只要有人把"构建失败仍当成功""端口有监听就算本项目""bot 超时算成功"改回来，这里就红。
const guardProbe = `
param([string]$Lib)
. $Lib
$r = [ordered]@{}
$b1 = Resolve-BuildOutcome -ExitCode 1 -HasDist $true -DistPath 'web/dist'
$r.buildFailAction = $b1.Action
$r.buildFailExit = $b1.ExitCode
$r.buildOk = (Resolve-BuildOutcome -ExitCode 0 -HasDist $false).Action
$r.mcForeign = Resolve-McPortState -Listening $true -OurJavaPresent $false
$r.mcOurs = Resolve-McPortState -Listening $true -OurJavaPresent $true
$r.mcFree = Resolve-McPortState -Listening $false -OurJavaPresent $false
$r.panelForeign = Resolve-PanelPortState -Listening $true -Probe ([pscustomobject]@{Status=200; Body='<h1>nginx</h1>'})
$r.panelOurs = Resolve-PanelPortState -Listening $true -Probe ([pscustomobject]@{Status=401; Body='unauthorized: x'})
$r.panelFree = Resolve-PanelPortState -Listening $false
$r.spawnFailOk = (Resolve-BotSpawnOutcome -Spawned $false).Ok
$r.spawnFailExit = (Resolve-BotSpawnOutcome -Spawned $false).ExitCode
$log = Join-Path $env:TEMP ((New-Guid).ToString('N') + '.log')
Set-Content -LiteralPath $log -Value 'nothing yet' -Encoding ASCII
$r.botTimeoutIsSuccess = ((Wait-BotSpawned -Seconds 1 -LogFile $log) -eq $true)
Remove-Item -LiteralPath $log -Force
$r | ConvertTo-Json -Compress
`
const guardTmp = path.join(os.tmpdir(), `guard-${process.pid}-${Date.now()}.ps1`)
fs.writeFileSync(guardTmp, guardProbe, 'utf8')
const gres = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', guardTmp,
  path.join(ROOT, 'scripts/lib/panel_guard.ps1')], { encoding: 'utf8', cwd: ROOT })
fs.rmSync(guardTmp, { force: true })
const rawOut = (gres.stdout || '').trim().split(/\r?\n/).pop() || ''
let G = null
try { G = JSON.parse(rawOut) } catch { /* 下面逐条 FAIL 会说明 */ }
check('R6#44 判据库能被真 PowerShell 加载', G !== null, `→ status=${gres.status} out=${rawOut.slice(0, 160)}${(gres.stderr || '').slice(0, 200)}`)
if (G) {
  check('R6#44 构建失败+旧 dist 仍在 ⇒ abort（不许"沿用旧 dist 报成功"）', G.buildFailAction === 'abort', `→ ${G.buildFailAction}`)
  check('R6#44 构建失败 ⇒ 退出码 1', G.buildFailExit === 1, `→ ${G.buildFailExit}`)
  check('R6#44 构建成功 ⇒ ok', G.buildOk === 'ok', `→ ${G.buildOk}`)
  check('R6#44 25565 有监听但非本项目 java ⇒ foreign（不许当"已运行"）', G.mcForeign === 'foreign', `→ ${G.mcForeign}`)
  check('R6#44 25565 是本项目 java ⇒ ours', G.mcOurs === 'ours', `→ ${G.mcOurs}`)
  check('R6#44 25565 无人监听 ⇒ free', G.mcFree === 'free', `→ ${G.mcFree}`)
  check('R6#44 8080 被陌生服务占用 ⇒ foreign', G.panelForeign === 'foreign', `→ ${G.panelForeign}`)
  check('R6#44 8080 应答本项目握手门 ⇒ ours', G.panelOurs === 'ours', `→ ${G.panelOurs}`)
  check('R6#44 8080 无人监听 ⇒ free', G.panelFree === 'free', `→ ${G.panelFree}`)
  check('R6#44 bot 没进游戏 ⇒ 失败（Ok=false）', G.spawnFailOk === false, `→ ${G.spawnFailOk}`)
  check('R6#44 bot 没进游戏 ⇒ 退出码 1', G.spawnFailExit === 1, `→ ${G.spawnFailExit}`)
  check('R6#44 等超时 **不再**返回成功（这条就是原缺陷本身）', G.botTimeoutIsSuccess === false, `→ ${G.botTimeoutIsSuccess}`)
}

// 接线：start-panel 必须真的用这些判据，而不是只在库里放着
check('R6#44 start-panel 引入判据库', /lib[\\/]panel_guard\.ps1/.test(startSrc))
for (const fn of ['Resolve-BuildOutcome', 'Resolve-McPortState', 'Resolve-PanelPortState', 'Wait-BotSpawned', 'Get-DistDrift']) {
  check(`R6#44 start-panel 用到 ${fn}`, new RegExp(String.raw`${fn}\b`).test(startSrc))
}
check('R6#44 旧文案"已在运行（25565 已监听），跳过"已消失', !/已在运行（25565 已监听）/.test(startSrc))
check('R6#44 旧文案"已在运行（8080 已监听），跳过"已消失', !/已在运行（8080 已监听）/.test(startSrc))
check('R6#44 旧文案"构建失败，沿用上一次的 dist"已消失', !/构建失败，沿用上一次的 dist/.test(startSrc))

// ════════════════════════════════════════════════════════════
// R6 #50 / #56：MANIFEST 单一写者 —— 行为断言（真跑同步工具）
// ════════════════════════════════════════════════════════════
// 用夹具目录跑真身：同步工具**不许**改写/删除 MANIFEST.json，否则 release.ps1 的
// source.hash/artifact.hash/generatedAt 会被一条"合规"的同步命令静默抹掉。
{
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'webdist-'))
  const src = path.join(fx, 'dist')
  const dest = path.join(fx, 'web-dist')
  fs.mkdirSync(path.join(src, 'assets'), { recursive: true })
  fs.mkdirSync(dest, { recursive: true })
  fs.writeFileSync(path.join(src, 'index.html'), '<div id="app"></div>')
  fs.writeFileSync(path.join(src, 'assets/app.js'), 'console.log(1)')
  const stamp = {
    schemaVersion: 2,
    generatedFrom: 'web/dist (Vue3 + Vite console)',
    generatedAt: '2026-11-11T00:00:00Z',
    source: { root: 'web/', files: 29, hash: 'sha256:AAAA', inputs: ['src'] },
    artifact: { files: 2, hash: 'sha256:BBBB' },
    entryAssets: ['assets/app.js'],
    note: 'x',
    files: { 'index.html': 'deadbeef' },
  }
  fs.writeFileSync(path.join(dest, 'MANIFEST.json'), JSON.stringify(stamp, null, 2) + '\n')
  fs.writeFileSync(path.join(dest, 'README.md'), '# keep me\n')

  const r = spawnSync('node', [path.join(ROOT, 'mindcraft/tools/sync_web_dist.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, SYNC_WEB_DIST_SRC: src, SYNC_WEB_DIST_DEST: dest },
  })
  check('R6#50 夹具同步执行成功', r.status === 0, `→ status=${r.status} ${(r.stderr || '').slice(0, 200)}`)

  const manifestPath = path.join(dest, 'MANIFEST.json')
  check('R6#50 同步后 MANIFEST.json 仍在', fs.existsSync(manifestPath))
  if (fs.existsSync(manifestPath)) {
    let after = null
    try { after = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { }
    check('R6#50 同步后可解析', after !== null)
    check('R6#50 发布元数据 source.hash 未被抹掉（原缺陷就是这个）',
      after && after.source && after.source.hash === 'sha256:AAAA', `→ ${after && after.source && after.source.hash}`)
    check('R6#50 artifact.hash 未被抹掉', after && after.artifact && after.artifact.hash === 'sha256:BBBB')
    check('R6#50 generatedAt 未被重写', after && after.generatedAt === '2026-11-11T00:00:00Z', `→ ${after && after.generatedAt}`)
    check('R6#50 entryAssets 未被抹掉', after && Array.isArray(after.entryAssets) && after.entryAssets.length === 1)
  }
  check('R6#50 README.md 仍被保留', fs.existsSync(path.join(dest, 'README.md')))
  check('R6#50 产物文件真的被同步了（index.html）', fs.existsSync(path.join(dest, 'index.html')))
  check('R6#50 产物文件真的被同步了（assets/app.js）', fs.existsSync(path.join(dest, 'assets/app.js')))
  fs.rmSync(fx, { recursive: true, force: true })
}

// release.ps1 必须按磁盘重算 files（另一个写者退场后，它是唯一来源）
const releaseSrc = readSrc('scripts/release.ps1')
check('R6#50 release.ps1 的 files 表按磁盘重算', /for \(const rel of walk\(distDir\)\)/.test(releaseSrc))

// ════════════════════════════════════════════════════════════
// R6 #51：跳过 ≠ 成功（退出码分离）
// ════════════════════════════════════════════════════════════
const backupSrc = readSrc('scripts/backup-world.ps1')
const cfgSrc = readSrc('scripts/lib/backup_config.ps1')
check('R6#51 -FromConfig+enabled=false 用独立退出码 4（不是 0）', /enabled=false（exit 4/.test(backupSrc))
check('R6#51 enabled=false 分支不再 exit 0', !/本次不备份'[\s\S]{0,120}?exit 0/.test(backupSrc))
check('R6#51 上层把 exit 4 记成 SKIP 而不是 OK', /\$code -eq 4/.test(cfgSrc) && /enabled=false/.test(cfgSrc))

// ════════════════════════════════════════════════════════════
// R6 #48 / #54 / #55 / #52：接线断言（行为面在 ops.md 里给证据）
// ════════════════════════════════════════════════════════════
const denySrc = readSrc('scripts/deny-rcon-25575-in.ps1')
check('R6#48 deny-rcon 有只读 -Verify 自检', /\[switch\]\$Verify/.test(denySrc) && /Get-RconRuleState/.test(denySrc))
check('R6#48 start-panel 前置检查以 -Verify 调 deny-rcon 自检',
  /deny-rcon-25575-in\.ps1'/.test(startSrc) && /rconDenyScript -Verify/.test(startSrc))
check('R6#48 收紧RCON.bat 透传子进程真实退出码', /-Wait -PassThru/.test(readSrc('收紧RCON.bat')) && /exit %RC%/.test(readSrc('收紧RCON.bat')))

const taskSrc = readSrc('scripts/install-backup-task.ps1')
check('R6#54 注册后有冒烟执行（Start-ScheduledTask）', /Start-ScheduledTask/.test(taskSrc))
check('R6#54 冒烟读 LastTaskResult', /LastTaskResult/.test(taskSrc))
check('R6#54 提供 S4U 登录类型', /S4U/.test(taskSrc))

const hardenSrc = readSrc('scripts/harden-credentials-acl.ps1')
check('R6#55 ACL 覆盖人设文件', /profiles\\\*\.json/.test(hardenSrc))
check('R6#55 ACL 覆盖 vault 与 config', /vault\\\*/.test(hardenSrc) && /config\\\*\.json/.test(hardenSrc))
check('R6#55 start-panel 前置检查接进 ACL 体检', /harden-credentials-acl\.ps1/.test(startSrc))

const e2eSrc = readSrc('scripts/e2e.ps1')
check('R6#53 e2e 预检三个端口', /\$MC_PORT, \$RCON_PORT, \$MS_PORT/.test(e2eSrc))
check('R6#53 e2e 断言 JDK 主版本 >= 21', /-lt 21/.test(e2eSrc))
check('R6#53 e2e 先摘 junction 再删目录', /Remove-RunDirSafe/.test(e2eSrc) && /ReparsePoint/.test(e2eSrc))

const composeSrc = readSrc('mindcraft/docker-compose.yml')
check('R6#52 viaproxy 端口只绑回环', /"127\.0\.0\.1:25568:25568"/.test(composeSrc))
const dockerfileSrc = readSrc('mindcraft/Dockerfile')
check('R6#52 镜像 CMD 直接 exec node（PID 1 能收到 SIGTERM）', /CMD \["node", "main\.js"\]/.test(dockerfileSrc))
check('R6#52 镜像非 root 运行', /^USER node$/m.test(dockerfileSrc))

// ════════════════════════════════════════════════════════════
// R6 #50 复核补强 / #56：release.ps1 的 verify 助手**不是同义反复**
// ════════════════════════════════════════════════════════════
// 从 release.ps1 里抽出那个临时助手（= 生产实现，不另写一份），喂夹具目录跑三种状态：
//   ① 干净       → 8/8 全 PASS
//   ② 源码漂移   → "产物与源码不一致"
//   ③ 产物被改   → "产物内容与清单不一致"（逐文件那条必须自己拦，不能只靠 artifact.hash）
{
  const relSrc = fs.readFileSync(path.join(ROOT, 'scripts/release.ps1'), 'utf8')
  const open = relSrc.indexOf("$metaScript = @'")
  const close = relSrc.indexOf("\n'@", open)
  check('R6#50 能从 release.ps1 抽出 verify 助手', open > 0 && close > open)
  const helper = relSrc.slice(relSrc.indexOf('\n', open) + 1, close)

  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'relverify-'))
  const dist = path.join(fx, 'web-dist')
  const web = path.join(fx, 'web')
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true })
  fs.mkdirSync(path.join(web, 'src'), { recursive: true })
  fs.writeFileSync(path.join(web, 'index.html'), '<div id="app"><script src="/console/assets/a.js"></script></div>')
  fs.writeFileSync(path.join(web, 'src/main.ts'), 'export const v = 1\n')
  for (const need of ['vite.config.ts', 'tsconfig.json', 'package.json', 'package-lock.json']) {
    fs.writeFileSync(path.join(web, need), '{}')
  }
  fs.writeFileSync(path.join(dist, 'index.html'), '<div id="app"><script src="/console/assets/a.js"></script></div>')
  fs.writeFileSync(path.join(dist, 'assets/a.js'), 'console.log(1)')
  fs.writeFileSync(path.join(dist, 'MANIFEST.json'), '{}')
  fs.writeFileSync(path.join(dist, 'README.md'), '# x\n')
  const helperPath = path.join(fx, 'helper.mjs')
  fs.writeFileSync(helperPath, helper, 'utf8')
  const run = (mode) => spawnSync('node', [helperPath, mode, path.join(dist, 'MANIFEST.json'), web], { encoding: 'utf8' })

  const stamp = run('stamp')
  check('R6#50 夹具 stamp 成功', stamp.status === 0, `→ ${(stamp.stderr || '').slice(0, 200)}`)
  const clean = run('verify')
  check('R6#50 夹具干净时 verify 通过（否则下面的"能红"没有意义）', clean.status === 0, `→ ${(clean.stderr || '').slice(0, 200)}`)

  // ② 源码漂移
  fs.appendFileSync(path.join(web, 'src/main.ts'), 'export const v = 2\n')
  const drift = run('verify')
  check('R6#50 源码漂移 ⇒ verify 红（不是永远绿）', drift.status === 1, `→ status=${drift.status}`)
  check('R6#50 红的理由是"产物与源码不一致"', /产物与源码不一致/.test(drift.stderr || drift.stdout || ''))
  fs.writeFileSync(path.join(web, 'src/main.ts'), 'export const v = 1\n')

  // ③ 产物被改：逐文件比对必须自己拦住（不能只靠 artifact.hash）
  fs.appendFileSync(path.join(dist, 'assets/a.js'), '/*tamper*/')
  const tamper = run('verify')
  check('R6#50 产物被改 ⇒ verify 红', tamper.status === 1, `→ status=${tamper.status}`)
  check('R6#50 逐文件比对自己就拦住（不是同义反复）',
    /产物内容与清单不一致/.test(tamper.stderr || tamper.stdout || ''),
    `→ ${((tamper.stderr || tamper.stdout || '').split('\n').filter((l) => /FAIL/.test(l))[0] || '').slice(0, 120)}`)
  fs.rmSync(fx, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
