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

// ════════════════════════════════════════════════════════════
// P1-3：compose 重复 environment 键 ⇒ 发布门禁用 node 解析断言（不依赖 docker CLI）
// ════════════════════════════════════════════════════════════
{
  const composeFile = path.join(ROOT, 'mindcraft/docker-compose.yml')
  const gate = path.join(ROOT, 'scripts/compose-gate.mjs')
  const composeSrc = readSrc('mindcraft/docker-compose.yml')

  check('P1-3 compose 门禁脚本存在', fs.existsSync(gate), `→ ${gate}`)
  const envLines = (composeSrc.match(/^\s{4}environment:/gm) || []).length
  check('P1-3 同级 environment 只出现一次（原缺陷是 2 次）', envLines === 1, `→ ${envLines} 次`)
  // 原本会被"只留后者"丢掉的那批变量必须都还在
  for (const v of ['SETTINGS_JSON', 'MIND_SERVER_HOST', 'MINDSERVER_TOKEN', 'MC_WORLD_DIR']) {
    check(`P1-3 合并后仍保留 ${v}`, new RegExp(`^ {6}${v}:`, 'm').test(composeSrc))
  }
  check('P1-3 旧缺陷形态（两个 environment 块）已消失',
    !/^ {4}environment:\n(?: {6}.*\n)*? {4}environment:/m.test(composeSrc.replace(/\r/g, '')))

  const runGate = (f) => spawnSync('node', [gate, f], { encoding: 'utf8' })
  const live = runGate(composeFile)
  check('P1-3 仓库里的 compose 通过门禁（可解析 + 变量齐全）', live.status === 0,
    `→ status=${live.status} ${(live.stdout || '').trim().slice(0, 200)}`)

  // 三条夹具：证明门禁不是恒绿，也不是恒红
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'composegate-'))
  const envToken = '      MINDSERVER_TOKEN: "' + '${MINDSERVER_TOKEN:?need token}' + '"'
  const good = [
    'services:', '  mindcraft:', '    build: .', '    environment:',
    '      SETTINGS_JSON: |', '        {"auto_open_ui": false}',
    '      MIND_SERVER_HOST: "0.0.0.0"', envToken, '      MC_WORLD_DIR: /app/world',
    '    ports:', '      - "127.0.0.1:8080:8080"', '',
  ].join('\n')
  const dup = [
    'services:', '  mindcraft:', '    environment:', '      MIND_SERVER_HOST: "0.0.0.0"',
    '    environment:', '      MC_WORLD_DIR: /app/world', '',
  ].join('\n')
  const missing = good.split('\n').filter((l) => !/MIND_SERVER_HOST/.test(l)).join('\n')
  const w = (name, body) => { const f = path.join(fx, name); fs.writeFileSync(f, body); return f }

  const gGood = runGate(w('good.yml', good))
  check('P1-3 夹具：合并正确的 compose ⇒ 绿（门禁不是恒红）', gGood.status === 0,
    `→ status=${gGood.status} ${(gGood.stdout || '').trim().slice(0, 160)}`)
  const gDup = runGate(w('dup.yml', dup))
  check('P1-3 夹具：复现原缺陷（重复 environment）⇒ 红', gDup.status === 1, `→ status=${gDup.status}`)
  check('P1-3 夹具红的理由是"重复键"（不是靠别的规则蒙对）', /重复键/.test(gDup.stdout || ''),
    `→ ${((gDup.stdout || '').split('\n').filter((l) => /重复键/.test(l))[0] || '').trim()}`)
  const gMissing = runGate(w('missing.yml', missing))
  check('P1-3 夹具：缺 MIND_SERVER_HOST ⇒ 红（丢键会被门禁拦住）', gMissing.status === 1, `→ status=${gMissing.status}`)
  check('P1-3 夹具报出缺的是 MIND_SERVER_HOST', /MIND_SERVER_HOST/.test(gMissing.stdout || ''))
  fs.rmSync(fx, { recursive: true, force: true })
}

// ════════════════════════════════════════════════════════════
// P2-7：别的 java 进程不许挡住停服 / 备份（按本项目 server.jar 绝对路径识别）
// ════════════════════════════════════════════════════════════
{
  const probe = `param([string]$Lib, [string]$Root)
$ErrorActionPreference = 'Stop'
. $Lib
$own = 'C:\\Java\\bin\\java.exe -Xmx2G -jar E:\\proj\\server\\server.jar nogui'
$other = 'C:\\Java\\bin\\java.exe -jar D:\\OtherMC\\server.jar nogui'
$adjacent = 'C:\\Java\\bin\\java.exe -jar E:\\proj2\\server\\server.jar nogui'
$plain = 'C:\\Java\\bin\\java.exe -jar C:\\tools\\desktop-app.jar'
$nullCmd = $null
$fwd = 'C:\\Java\\bin\\java.exe -jar E:/proj/server/server.jar nogui'
$upper = 'C:\\Java\\bin\\java.exe -jar E:\\PROJ\\SERVER\\SERVER.JAR nogui'
$tbl = @(
  [pscustomobject]@{ ProcessId = 100; CommandLine = $own },
  [pscustomobject]@{ ProcessId = 200; CommandLine = $other },
  [pscustomobject]@{ ProcessId = 300; CommandLine = $plain },
  [pscustomobject]@{ ProcessId = 400; CommandLine = $nullCmd }
)
$r = [ordered]@{}
$r.own = Test-OwnServerCommandLine -CommandLine $own -ProjectRoot $Root
$r.other = Test-OwnServerCommandLine -CommandLine $other -ProjectRoot $Root
$r.adjacent = Test-OwnServerCommandLine -CommandLine $adjacent -ProjectRoot $Root
$r.plain = Test-OwnServerCommandLine -CommandLine $plain -ProjectRoot $Root
$r.nullCmd = Test-OwnServerCommandLine -CommandLine $nullCmd -ProjectRoot $Root
$r.fwd = Test-OwnServerCommandLine -CommandLine $fwd -ProjectRoot $Root
$r.upper = Test-OwnServerCommandLine -CommandLine $upper -ProjectRoot $Root
$ownList = @(Get-OwnServerJava -ProjectRoot $Root -ProcessTable $tbl)
$r.count = $ownList.Count
$r.pid = $(if ($ownList.Count -gt 0) { $ownList[0].ProcessId } else { -1 })
$r | ConvertTo-Json -Compress
`
  const tmp = path.join(os.tmpdir(), `srvproc-${process.pid}-${Date.now()}.ps1`)
  fs.writeFileSync(tmp, probe, 'utf8')
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp,
    path.join(ROOT, 'scripts/lib/server_proc.ps1'), 'E:\\proj'], { encoding: 'utf8', cwd: ROOT })
  fs.rmSync(tmp, { force: true })
  const out = (r.stdout || '').trim().split(/\r?\n/).pop() || ''
  let P = null
  try { P = JSON.parse(out) } catch { /* 下面逐条 FAIL 会说明 */ }
  check('P2-7 判据库能被真 PowerShell 加载', P !== null,
    `→ status=${r.status} out=${out.slice(0, 160)}${(r.stderr || '').slice(0, 200)}`)
  if (P) {
    check('P2-7 ① 本项目 server.jar 进程被识别', P.own === true, `→ ${P.own}`)
    check('P2-7 ② 其他目录的 server.jar 不被认', P.other === false, `→ ${P.other}`)
    check('P2-7 ② 名字相近的旁路目录（E:\\proj2）也不被认', P.adjacent === false, `→ ${P.adjacent}`)
    check('P2-7 ③ 普通 java 进程（-jar 别的应用）不算本项目服务端', P.plain === false, `→ ${P.plain}`)
    check('P2-7 命令行读不到（null）时不误判', P.nullCmd === false, `→ ${P.nullCmd}`)
    check('P2-7 正斜杠命令行同样能认', P.fwd === true, `→ ${P.fwd}`)
    check('P2-7 大小写不敏感', P.upper === true, `→ ${P.upper}`)
    check('P2-7 注入的进程表里只挑出 1 个本项目进程', P.count === 1, `→ ${P.count}`)
    check('P2-7 挑出来的是本项目那个 PID', P.pid === 100, `→ ${P.pid}`)
  }

  // 接线：三处必须共用同一判据
  const stopSrc = readSrc('scripts/stop-panel.ps1')
  const bkSrc = readSrc('scripts/backup-world.ps1')
  check('P2-7 stop-panel 引入共享判据库', /lib[\\/]server_proc\.ps1/.test(stopSrc))
  check('P2-7 stop-panel 只等本项目服务端（不再 Get-Process 全部 java）',
    /Get-OwnServerJava/.test(stopSrc) && !/Get-Process\s+-Name\s+java/.test(stopSrc))
  check('P2-7 backup-world 引入共享判据库', /lib[\\/]server_proc\.ps1/.test(bkSrc))
  check('P2-7 backup-world 不再按 server.jar/paper 字样匹配任意 java',
    /Get-OwnServerJava/.test(bkSrc) && !/server\\\.jar\|paper\|spigot\|bukkit/.test(bkSrc))
  check('P2-7 backup-world 仍保留 session.lock 闸门',
    /session\.lock 被独占/.test(bkSrc) && /Test-PathLocked\s+\$lock/.test(bkSrc))
  check('P2-7 start-panel 也用同一判据（三处判据一致）',
    /lib[\\/]server_proc\.ps1/.test(startSrc) && /Get-OwnServerJava/.test(startSrc))
  check('P2-7 start-panel 没有第二份内联匹配实现',
    !/function Get-ServerJava[\s\S]{0,400}Get-CimInstance/.test(startSrc))
}

// ════════════════════════════════════════════════════════════
// P2-7 复发坑常驻断言：Get-ServerJava 的"没匹配"必须是**严格 $null**
//
// 症状（t3 已识别的复发坑）：返回 @() 或 $false 时，下游的
//   `$null -eq (Get-ServerJava)` 判"进程已退出"永远不成立 ——
//   表现为 **冷启动被判成服务端还活着 ⇒ 起不来、而且不报错**（最难查的那种）。
// 这个判据现在三处共用（start / stop / backup），所以把"函数形态"钉死：
//   ① 断言对象是 start-panel.ps1 里的**真身**（正则抽取），不是另写一份副本；
//   ②③ 用 stub 把 Get-OwnServerJava 分别喂 0 / 1 / 2 个进程，看返回值形态；
//   ④ start-panel.ps1 里不得再有第二份内联 CIM 匹配（只许委托判据库）。
// 注：只 stub `Get-OwnServerJava`，不 stub 被测的 `Get-ServerJava` 本身。
// ════════════════════════════════════════════════════════════
{
  const m = startSrc.match(/^function Get-ServerJava\s*\{[\s\S]*?^\}$/m)
  const fnText = m ? m[0] : ''
  check('P2-7① 从 start-panel.ps1 抽出真身 Get-ServerJava（不是副本）',
    fnText.length > 0 && /Get-OwnServerJava/.test(fnText),
    `→ ${(fnText.split(/\r?\n/)[0] || '(没抽到)')}`)

  const probe = `param()
$ErrorActionPreference = 'Stop'
$root = 'E:/proj'
$global:P2Mode = 'none'
function Get-OwnServerJava {
    param([string]$ProjectRoot, $ProcessTable)
    switch ($global:P2Mode) {
        'one' { return @([pscustomobject]@{ ProcessId = 4242; CommandLine = 'java -jar E:/proj/server/server.jar' }) }
        'two' { return @([pscustomobject]@{ ProcessId = 1; CommandLine = 'a' },
                         [pscustomobject]@{ ProcessId = 2; CommandLine = 'b' }) }
        default { return @() }
    }
}
${fnText}
$res = @()
foreach ($mode in @('none', 'one', 'two')) {
    $global:P2Mode = $mode
    $x = Get-ServerJava
    $isNull = ($null -eq $x)
    $arr = @()
    if (-not $isNull) { $arr = @($x) }
    $props = $null
    if ($arr.Count -gt 0) { $props = $arr[0].PSObject.Properties['ProcessId'] }
    $res += [ordered]@{
        mode    = $mode
        isNull  = $isNull
        isArray = ($x -is [array])
        count   = $(if ($isNull) { -1 } else { $arr.Count })
        pid     = $(if ($arr.Count -gt 0) { $arr[0].ProcessId } else { -1 })
        hasPid  = ($null -ne $props)
        type    = $(if ($isNull) { 'null' } else { $x.GetType().Name })
    }
}
ConvertTo-Json -InputObject @($res) -Compress
`
  const tmp = path.join(os.tmpdir(), `srvjava-${process.pid}-${Date.now()}.ps1`)
  fs.writeFileSync(tmp, probe, 'utf8')
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], { encoding: 'utf8', cwd: ROOT })
  fs.rmSync(tmp, { force: true })
  const out = (r.stdout || '').trim().split(/\r?\n/).pop() || ''
  let rows = null
  try { rows = JSON.parse(out) } catch { /* 下面逐条 FAIL 会带出原始输出 */ }
  check('P2-7② 真身 Get-ServerJava 无匹配 ⇒ 严格 $null（不是 @() / $false）',
    Boolean(rows) && rows[0].isNull === true && rows[0].type === 'null' && rows[0].count === -1,
    `→ ${JSON.stringify(rows ? rows[0] : null)} raw=${out.slice(0, 160)}${(r.stderr || '').slice(0, 200)}`)
  check('P2-7③ 真身 Get-ServerJava 有匹配 ⇒ 返回带 ProcessId 的对象',
    Boolean(rows) && rows[1].isNull === false && rows[1].hasPid === true && rows[1].pid === 4242,
    `→ ${JSON.stringify(rows ? rows[1] : null)}`)
  check('P2-7③b 多个进程时仍是数组、逐个可取 ProcessId',
    Boolean(rows) && rows[2].count === 2 && rows[2].pid === 1 && rows[2].isArray === true,
    `→ ${JSON.stringify(rows ? rows[2] : null)}`)
  check('P2-7④ start-panel.ps1 里没有第二份内联 CIM 匹配（只许委托判据库）',
    !/Get-CimInstance/.test(startSrc) && !/Win32_Process/.test(startSrc),
    `→ CIM 出现 ${(startSrc.match(/Get-CimInstance/g) || []).length} 次`)
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
