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

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
