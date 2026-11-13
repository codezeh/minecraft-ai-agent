#!/usr/bin/env node
/**
 * P2-4（第五轮审查）+ t7（同源竞态）离线回归 —— 事件筛选与四个 loader 的**乱序回执**都不许覆盖新结果。
 *
 * 缺陷原貌：
 *   · P2-4：`loadEvents()` / `loadEventStats()` 都是「发请求 → await → 无条件写回视图」，
 *     快速连改筛选时**旧请求最后返回就覆盖新筛选的结果**（"选 inventory.reserve，列表却显示 team.create"）。
 *   · t7：`loadTeams()` / `loadTeamChests()` / `loadStock()` / `loadLedger()` / `loadFederation()`
 *     同样是无条件写回。风险**低于 P2-4**（旧数据也是真的，只是不最新），但"队伍换了、仓库还是上一队的"
 *     必须挡掉，所以共享仓子请求也单独编号。
 *
 * 修复口径：每次请求取一个**单调递增的代号（seq）**，只有 `seq === 当前代号` 的回执才允许写回；
 * 旧回执（无论先到还是后到）一律丢弃。事件筛选 / 统计 / 五个 loader 各自独立编号。
 *
 * 怎么做到"跑真实代码"：用 vite 自带的 esbuild 把 `src/stores/world.ts` 打包成 ESM，
 * 把 `../api/socket` 换成**可控回执**的假 socket（手动决定每个请求何时、以什么内容 resolve）。
 * 断言的是真实模块的导出函数，不是复制品；不需要浏览器、不需要 8080、不建网络连接。
 *
 * ★ "证明能红"：同一组断言跑三遍 ——
 *   ① 真实源码（必须全绿）；
 *   ② 变异体-events（删掉 `RACE-GUARD events/stats` = 回到修复前）：事件断言必须红，
 *      **loader 断言必须仍绿**；
 *   ③ 变异体-stock（只删 `RACE-GUARD stock`）：**只有**库存那条断言红，其它 loader 断言与事件断言
 *      必须仍绿 —— 证明这些断言是**逐条**有效的，不是"一删全红"。
 *
 * 用法：node scripts/world-events-race-unit.mjs
 * 输出：PASS/FAIL 逐条，全过退出码 0。
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const WEB_ROOT = path.resolve(import.meta.dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'race-p24-'))

// ── 假 socket：requestRead 返回**由测试决定的** promise（不超时、不自动 resolve） ──
// ★ 状态挂在 globalThis 上：stub 会被 esbuild 打包进各自的 bundle（独立副本），
//   只有 globalThis 上的对象是几份 bundle 共享的同一份。
const stubPath = path.join(tmp, 'socket-stub.mjs')
fs.writeFileSync(stubPath, `
const S = (globalThis.__P24_RACE_STATE__ ||= { calls: [] })
export const __state = S
export function requestRead(event, payload = {}, timeoutMs = 6000) {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  S.calls.push({ event, payload, timeoutMs, resolve, reject })
  return promise
}
export function isOnline() { return true }
export function connect() {}
export function disconnect() {}
export function pauseReconnect() {}
export function resumeReconnect() {}
export function reconnectNow() {}
export function request() { throw new Error('race-unit 不该用到 request()') }
export function emitControl() { throw new Error('race-unit 不该用到 emitControl()') }
export class RequestError extends Error {}
export const socket = { connected: true }
export default { requestRead }
`)

const STATE = (globalThis.__P24_RACE_STATE__ ||= { calls: [] })

/**
 * 打包一份 world.ts。
 * @param {string} tag            变体名（用于产物文件名）
 * @param {string[]} stripLabels  要删掉的守卫标签（空数组 = 真实源码；否则是"回到修复前"的变异体）
 */
async function loadVariant(tag, stripLabels = []) {
  const entry = path.join(WEB_ROOT, 'src/stores/world.ts')
  const built = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{
      name: 'p24-race-fixture',
      setup(b) {
        // `import { requestRead } from '../api/socket'` → 换成可控回执的假模块
        b.onResolve({ filter: /(^|\/)api\/socket$/ }, () => ({ path: stubPath }))
        // 变异体：把指定守卫整行删掉（回到"无条件写回视图"的旧行为）
        b.onLoad({ filter: /stores[\\/]world\.ts$/ }, (args) => {
          let src = fs.readFileSync(args.path, 'utf8')
          for (const label of stripLabels) {
            src = src.replace(new RegExp(`^.*RACE-GUARD ${label}.*$`, 'gm'), `  // [变异体] ${label} 守卫已删除`)
          }
          return { contents: src, loader: 'ts', resolveDir: path.dirname(args.path) }
        })
      },
    }],
  })
  const out = path.join(tmp, `world-${tag}.mjs`)
  fs.writeFileSync(out, built.outputFiles[0].text, 'utf8')
  return import(pathToFileURL(out).href)
}

// ── 断言执行器：结果按（变体, 套件）收集，最后一起裁决 ──
function makeCheck(tag, bucket) {
  return (name, cond, detail = '') => {
    const ok = !!cond
    bucket.push({ name, ok, detail })
    console.log(`${ok ? 'PASS' : 'FAIL'} [${tag}] ${name}${detail ? '  ' + detail : ''}`)
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const sameKind = (rows, kind) => rows.length > 0 && rows.every((r) => r.kind === kind)
const kindList = (rows) => rows.map((r) => r.kind).join(',') || '(空)'

// ══════════════════════════════════════════════════════════════
// 套件 A：事件筛选 / 统计（P2-4）
// ══════════════════════════════════════════════════════════════
async function eventsSuite(tag, mod) {
  const { eventsView, eventsStats, loadEvents, loadMoreEvents, loadEventStats } = mod
  const results = []
  const check = makeCheck(tag, results)
  const lastCall = () => STATE.calls[STATE.calls.length - 1]
  const row = (kind, id) => ({ id, at: 1_700_000_000_000, kind, avatarId: 'a', worldId: 'w', payload: {} })

  const resetView = () => {
    eventsView.phase = 'idle'
    eventsView.message = ''
    eventsView.kind = ''
    eventsView.windowMs = 24 * 60 * 60_000
    eventsView.events = []
    eventsView.cursor = null
    eventsView.mayHaveMore = false
    eventsView.loadingMore = false
    eventsView.moreMessage = ''
  }
  const resetStats = () => {
    eventsStats.phase = 'idle'
    eventsStats.message = ''
    eventsStats.kinds = []
  }

  STATE.calls.length = 0
  resetView()
  resetStats()

  // ── A1 新请求**先**返回、旧请求**后**返回 ⇒ 旧结果不许覆盖新结果 ──
  eventsView.kind = 'team.create'
  const p1 = loadEvents(true)
  const c1 = lastCall()
  eventsView.kind = 'inventory.reserve'
  const p2 = loadEvents(true)
  const c2 = lastCall()
  check('A1 每次筛选各发一次 events:since（带自己的 kind）',
    c1 && c2 && c1 !== c2 && c1.payload.kind === 'team.create' && c2.payload.kind === 'inventory.reserve',
    `→ ${c1?.payload.kind} / ${c2?.payload.kind}`)

  c2.resolve({ ok: true, events: [row('inventory.reserve', 'e2')] })
  await p2
  check('A1 新回执到达 ⇒ 已落库',
    eventsView.phase === 'ok' && sameKind(eventsView.events, 'inventory.reserve'),
    `→ phase=${eventsView.phase} kinds=${kindList(eventsView.events)}`)

  c1.resolve({ ok: true, events: [row('team.create', 'e1')] })
  await p1
  check('A1 旧回执最后到达 ⇒ 不覆盖新结果',
    sameKind(eventsView.events, 'inventory.reserve'),
    `→ kinds=${kindList(eventsView.events)}`)
  check('A1 旧回执也没把 phase 改回别的结论', eventsView.phase === 'ok', `→ phase=${eventsView.phase}`)

  // ── A2 反向时序：旧请求**先**返回、新请求**后**返回 ⇒ 旧结果同样不许落库 ──
  resetView()
  eventsView.kind = 'team.create'
  const q1 = loadEvents(true)
  const d1 = lastCall()
  eventsView.kind = 'inventory.reserve'
  const q2 = loadEvents(true)
  const d2 = lastCall()

  d1.resolve({ ok: true, events: [row('team.create', 'e1')] })
  await q1
  check('A2 旧回执先到（新请求还在飞）⇒ 仍在 loading、不落旧结果',
    eventsView.phase === 'loading' && eventsView.events.length === 0,
    `→ phase=${eventsView.phase} kinds=${kindList(eventsView.events)}`)

  d2.resolve({ ok: true, events: [row('inventory.reserve', 'e2')] })
  await q2
  check('A2 新回执到达 ⇒ 落库（且只有这一份）',
    eventsView.phase === 'ok' && sameKind(eventsView.events, 'inventory.reserve'),
    `→ phase=${eventsView.phase} kinds=${kindList(eventsView.events)}`)

  // ── A3 events:stats —— 新回执先、旧回执后 ──
  resetStats()
  const s1 = loadEventStats()
  const t1 = lastCall()
  check('A3 stats 走 events:stats', t1?.event === 'events:stats', `→ ${t1?.event}`)
  const s2 = loadEventStats()
  const t2 = lastCall()
  t2.resolve({ ok: true, kinds: [{ kind: 'inventory.reserve', count: 1, firstAt: 1, lastAt: 1 }] })
  await s2
  t1.resolve({ ok: true, kinds: [{ kind: 'team.create', count: 9, firstAt: 1, lastAt: 1 }] })
  await s1
  check('A3 旧的 events:stats 回执最后到达 ⇒ 不覆盖新统计',
    eventsStats.kinds.length === 1 && eventsStats.kinds[0].kind === 'inventory.reserve',
    `→ ${eventsStats.kinds.map((k) => k.kind).join(',') || '(空)'}`)

  // ── A4 events:stats —— 旧回执先、新回执后 ──
  resetStats()
  const u1 = loadEventStats()
  const v1 = lastCall()
  const u2 = loadEventStats()
  const v2 = lastCall()
  v1.resolve({ ok: true, kinds: [{ kind: 'team.create', count: 9, firstAt: 1, lastAt: 1 }] })
  await u1
  check('A4 旧 stats 回执先到 ⇒ 仍在 loading、kinds 为空',
    eventsStats.phase === 'loading' && eventsStats.kinds.length === 0,
    `→ phase=${eventsStats.phase} n=${eventsStats.kinds.length}`)
  v2.resolve({ ok: true, kinds: [{ kind: 'inventory.reserve', count: 1, firstAt: 1, lastAt: 1 }] })
  await u2
  check('A4 新 stats 回执到达 ⇒ 落库',
    eventsStats.phase === 'ok' && eventsStats.kinds.length === 1 && eventsStats.kinds[0].kind === 'inventory.reserve',
    `→ ${eventsStats.kinds.map((k) => k.kind).join(',') || '(空)'}`)

  // ── A5 正向对照：没有并发时行为不变（证明上面的绿不是"把功能关掉"换来的） ──
  resetView()
  eventsView.kind = 'chat.say'
  const w = loadEvents(true)
  lastCall().resolve({ ok: true, events: [row('chat.say', 'c1')] })
  await w
  check('A5 无并发 ⇒ 正常落库（正向对照）',
    eventsView.phase === 'ok' && sameKind(eventsView.events, 'chat.say'),
    `→ phase=${eventsView.phase} kinds=${kindList(eventsView.events)}`)

  // ── A6 "继续往后读"的旧回执，不许追加到切换筛选后的新列表里 ──
  resetView()
  eventsView.kind = 'team.create'
  const first = loadEvents(true)
  lastCall().resolve({ ok: true, events: [row('team.create', 'e1'), row('team.create', 'e2')] })
  await first
  check('A6 首屏已载入', eventsView.events.length === 2, `→ n=${eventsView.events.length}`)

  const moreP = loadMoreEvents()
  const moreCall = lastCall()
  eventsView.kind = 'inventory.reserve'
  const freshP = loadEvents(true)
  const freshCall = lastCall()
  freshCall.resolve({ ok: true, events: [row('inventory.reserve', 'e9')] })
  await freshP
  moreCall.resolve({ ok: true, events: [row('team.create', 'e3')] })
  await moreP
  check('A6 分页旧回执不追加到新筛选的列表里',
    sameKind(eventsView.events, 'inventory.reserve'),
    `→ kinds=${kindList(eventsView.events)}`)

  return results
}

// ══════════════════════════════════════════════════════════════
// 套件 B：四个 loader（t7）—— 每个 loader 一条"旧后到 ⇒ 不覆盖"
// ══════════════════════════════════════════════════════════════
async function loaderSuite(tag, mod) {
  const { teamView, stockView, federationView, loadTeams, loadTeamChests, loadStock, loadLedger, loadFederation } = mod
  const results = []
  const check = makeCheck(tag, results)
  const lastCall = () => STATE.calls[STATE.calls.length - 1]
  const callsOf = (event) => STATE.calls.filter((c) => c.event === event)

  const team = (id, member) => ({
    id, world_id: 'w', name: id, created_by: 'x', created_at: 1, chests: 0,
    members: [{ avatar_id: member, role: 'owner', joined_at: 1 }],
  })
  const chest = (x) => ({ x, y: 0, z: 0, added_by: 'a', added_at: 1 })

  const resetViews = () => {
    Object.assign(teamView, {
      phase: 'idle', message: '', worldId: '', teams: [], botTeam: null, botName: '',
      chestPhase: 'idle', chestMessage: '', chests: [],
    })
    Object.assign(stockView, {
      phase: 'idle', message: '', worldId: '', items: [], containers: [], reservations: [], expired: [],
      ledgerPhase: 'idle', ledgerMessage: '', ledger: [], ledgerLimit: 100,
    })
    Object.assign(federationView, {
      phase: 'idle', message: '', grants: [], knownPeers: [], allowedPeers: [], visitorWired: null,
    })
  }

  STATE.calls.length = 0
  resetViews()

  // ── B0 正向对照：无并发时 loader 行为不变 ──
  const b0 = loadStock()
  lastCall().resolve({ ok: true, items: [{ item: 'solo', known: 1, reserved: 0, available: 1 }], worldId: 'w0' })
  await b0
  check('B0 无并发 ⇒ loadStock 正常落库（正向对照）',
    stockView.phase === 'ok' && stockView.items[0]?.item === 'solo' && stockView.worldId === 'w0',
    `→ ${stockView.items.map((i) => i.item).join(',')}`)

  // ── B1 loadTeams + 共享仓子请求：换 bot 后旧队伍回执最后到达 ──
  resetViews()
  // 不 await 这一条：变异体里旧回执会真的提交，并再抛出一个永不回执的共享仓请求 ⇒ promise 永远不 settle。
  void loadTeams('botA')
  const listA = lastCall()
  const t2 = loadTeams('botB')
  const listB = lastCall()
  check('B1 换 bot 各发一次 team:list', listA !== listB && listB.event === 'team:list',
    `→ ${listA?.event} / ${listB?.event}`)

  listB.resolve({ ok: true, teams: [team('teamB', 'botB')], worldId: 'w2' })
  await tick() // 让 loadTeams 走到共享仓子请求
  const chestB = callsOf('team:chest-list').at(-1)
  check('B1 新队伍回执后立刻拉本队共享仓', chestB?.payload?.teamId === 'teamB', `→ ${chestB?.payload?.teamId}`)
  chestB.resolve({ ok: true, chests: [chest(9)] })
  await t2
  check('B1 新队伍与仓库都已落库',
    teamView.teams[0]?.id === 'teamB' && teamView.botTeam?.id === 'teamB' && teamView.chests[0]?.x === 9,
    `→ team=${teamView.teams[0]?.id} chest.x=${teamView.chests[0]?.x}`)

  listA.resolve({ ok: true, teams: [team('teamA', 'botA')], worldId: 'w1' })
  await tick() // 只等一拍：让真实源码的"丢弃"、变异体的"提交 + 再抛一次仓库请求"都发生完
  check('B1 旧的 team:list 回执最后到达 ⇒ 不覆盖新队伍',
    teamView.teams.length === 1 && teamView.teams[0].id === 'teamB' && teamView.botTeam?.id === 'teamB',
    `→ teams=${teamView.teams.map((x) => x.id).join(',')}`)
  check('B1 旧队伍回执也不会再去拉上一队的共享仓',
    !callsOf('team:chest-list').some((c) => c.payload?.teamId === 'teamA'),
    `→ ${callsOf('team:chest-list').map((c) => c.payload?.teamId).join(',')}`)
  check('B1 共享仓仍是新队伍的（队伍换了、仓库没跟着换才算过）',
    teamView.chests.length === 1 && teamView.chests[0].x === 9,
    `→ chest.x=${teamView.chests[0]?.x}`)

  // ── B2 共享仓子请求自身的乱序：旧队仓库回执最后到达 ──
  resetViews()
  const p = loadTeams('botA')
  lastCall().resolve({ ok: true, teams: [team('teamA', 'botA')] })
  await tick()
  const chestOld = callsOf('team:chest-list').at(-1)
  const p2 = loadTeamChests('teamB', 'botB')
  const chestNew = lastCall()
  check('B2 两次仓库请求各带自己的 teamId',
    chestOld?.payload?.teamId === 'teamA' && chestNew?.payload?.teamId === 'teamB',
    `→ ${chestOld?.payload?.teamId} / ${chestNew?.payload?.teamId}`)
  chestNew.resolve({ ok: true, chests: [chest(9)] })
  await p2
  chestOld.resolve({ ok: true, chests: [chest(1)] })
  await p
  check('B2 旧队仓库回执最后到达 ⇒ 不覆盖新队仓库',
    teamView.chests.length === 1 && teamView.chests[0].x === 9,
    `→ chest.x=${teamView.chests[0]?.x}`)

  // ── B3 loadStock：旧快照回执最后到达 ──
  resetViews()
  const s1 = loadStock()
  const snap1 = lastCall()
  const s2 = loadStock()
  const snap2 = lastCall()
  snap2.resolve({ ok: true, items: [{ item: 'new', known: 1, reserved: 0, available: 1 }], worldId: 'w2' })
  await s2
  snap1.resolve({ ok: true, items: [{ item: 'old', known: 1, reserved: 0, available: 1 }], worldId: 'w1' })
  await s1
  check('B3 旧快照回执最后到达 ⇒ 不覆盖新快照',
    stockView.items.length === 1 && stockView.items[0].item === 'new' && stockView.worldId === 'w2',
    `→ items=${stockView.items.map((i) => i.item).join(',')} world=${stockView.worldId}`)

  // ── B4 loadLedger：反向时序（旧先到、新后到）⇒ 旧的不许提前落库 ──
  resetViews()
  const l1 = loadLedger(50)
  const led1 = lastCall()
  const l2 = loadLedger(200)
  const led2 = lastCall()
  check('B4 两次账本请求各带自己的 limit',
    led1?.payload?.limit === 50 && led2?.payload?.limit === 200,
    `→ ${led1?.payload?.limit} / ${led2?.payload?.limit}`)
  led1.resolve({ ok: true, entries: [{ id: 'old', world_id: 'w', item: 'i', delta: 1, holder: null, reason: 'take', at: 1 }] })
  await l1
  check('B4 旧账本回执先到（新的还在飞）⇒ 仍 loading、不落旧数据',
    stockView.ledgerPhase === 'loading' && stockView.ledger.length === 0,
    `→ phase=${stockView.ledgerPhase} n=${stockView.ledger.length}`)
  led2.resolve({ ok: true, entries: [{ id: 'new', world_id: 'w', item: 'i', delta: 2, holder: null, reason: 'take', at: 2 }] })
  await l2
  check('B4 新账本回执到达 ⇒ 落库（且只有新的）',
    stockView.ledger.length === 1 && stockView.ledger[0].id === 'new',
    `→ ${stockView.ledger.map((r) => r.id).join(',')}`)

  // ── B5 loadFederation：旧联邦回执最后到达 ──
  resetViews()
  const f1 = loadFederation()
  const fed1 = lastCall()
  const f2 = loadFederation()
  const fed2 = lastCall()
  fed2.resolve({ ok: true, grants: [{ grantId: 'new' }], knownPeers: [], allowedPeers: [], visitorWired: true })
  await f2
  fed1.resolve({ ok: true, grants: [{ grantId: 'old' }], knownPeers: [], allowedPeers: [], visitorWired: false })
  await f1
  check('B5 旧联邦回执最后到达 ⇒ 不覆盖新结果',
    federationView.grants.length === 1 && federationView.grants[0].grantId === 'new' && federationView.visitorWired === true,
    `→ grants=${federationView.grants.map((g) => g.grantId).join(',')} wired=${federationView.visitorWired}`)

  return results
}

// ══════════════════════════════════════════════════════════════
// 变体 × 套件：真实源码 + 事件变异体 + **每个 loader 各一个**变异体
// ══════════════════════════════════════════════════════════════
// 每个 loader 守卫对应的"应该红"的断言集合。teams 那条旧回执一旦提交，还会**顺手再抛一次**
// 上一队的共享仓请求，所以它有两条后果断言；其余 loader 各自一条。
const EXPECTED_RED = {
  teams: [
    'B1 旧的 team:list 回执最后到达 ⇒ 不覆盖新队伍',
    'B1 旧队伍回执也不会再去拉上一队的共享仓',
  ],
  chest: ['B2 旧队仓库回执最后到达 ⇒ 不覆盖新队仓库'],
  stock: ['B3 旧快照回执最后到达 ⇒ 不覆盖新快照'],
  ledger: ['B4 旧账本回执先到（新的还在飞）⇒ 仍 loading、不落旧数据'],
  fed: ['B5 旧联邦回执最后到达 ⇒ 不覆盖新结果'],
}
const LOADER_LABELS = Object.keys(EXPECTED_RED)

const VARIANTS = [
  { tag: '真实源码', key: 'real', strip: [] },
  { tag: '变异体-events', key: 'mut-events', strip: ['events', 'stats'] },
  ...LOADER_LABELS.map((label) => ({ tag: `变异体-${label}`, key: `mut-${label}`, strip: [label] })),
]

const runs = {}
for (const v of VARIANTS) {
  const mod = await loadVariant(v.key, v.strip)
  const events = await eventsSuite(v.tag, mod)
  const loaders = await loaderSuite(v.tag, mod)
  runs[v.key] = { events, loaders }
}

const failed = (list) => list.filter((r) => !r.ok).map((r) => r.name)
const passed = (list) => list.filter((r) => r.ok).map((r) => r.name)
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x))

// 事件侧：删掉 events/stats 守卫必须红的 5 条
const EVENTS_MUST_BE_RED = [
  'A1 旧回执最后到达 ⇒ 不覆盖新结果',
  'A2 旧回执先到（新请求还在飞）⇒ 仍在 loading、不落旧结果',
  'A3 旧的 events:stats 回执最后到达 ⇒ 不覆盖新统计',
  'A4 旧 stats 回执先到 ⇒ 仍在 loading、kinds 为空',
  'A6 分页旧回执不追加到新筛选的列表里',
]

console.log('')
let pass = 0
let fail = 0
const verdict = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? '  ' + detail : ''}`) }
  else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`) }
}

const realEventsFail = failed(runs.real.events)
const realLoadersFail = failed(runs.real.loaders)
verdict('真实源码：事件侧乱序断言全部通过', realEventsFail.length === 0,
  `→ ${runs.real.events.length - realEventsFail.length}/${runs.real.events.length}` +
  (realEventsFail.length ? ` 失败：${realEventsFail.join(' | ')}` : ''))
verdict('真实源码：四个 loader 乱序断言全部通过', realLoadersFail.length === 0,
  `→ ${runs.real.loaders.length - realLoadersFail.length}/${runs.real.loaders.length}` +
  (realLoadersFail.length ? ` 失败：${realLoadersFail.join(' | ')}` : ''))

const mutEventsRed = failed(runs['mut-events'].events)
verdict('变异体-events（删掉 events/stats 守卫）能红：恰好红在 5 条乱序断言上',
  sameSet(mutEventsRed, EVENTS_MUST_BE_RED),
  `→ 红了 ${EVENTS_MUST_BE_RED.filter((n) => mutEventsRed.includes(n)).length}/${EVENTS_MUST_BE_RED.length}`)
verdict('变异体-events 的 loader 断言仍全绿（删事件守卫不误伤 loader）',
  failed(runs['mut-events'].loaders).length === 0,
  `→ ${runs['mut-events'].loaders.length - failed(runs['mut-events'].loaders).length}/${runs['mut-events'].loaders.length}`)

// 逐 loader：删掉它的守卫 ⇒ **只有**它那组后果断言红，其它 loader 与事件断言全绿（不是"一删全红"）
for (const label of LOADER_LABELS) {
  const key = `mut-${label}`
  const red = failed(runs[key].loaders)
  const expect = EXPECTED_RED[label]
  verdict(`变异体-${label}：只删该 loader 的守卫 ⇒ 恰好红在它自己的断言上`,
    sameSet(red, expect), `→ 红：${red.join(' | ') || '(无)'}`)
  verdict(`变异体-${label}：其它 loader 断言仍全绿（逐条有效，不是一删全红）`,
    passed(runs[key].loaders).length === runs.real.loaders.length - expect.length,
    `→ 绿 ${passed(runs[key].loaders).length}/${runs.real.loaders.length}`)
  verdict(`变异体-${label}：事件断言仍全绿（两套机制互不牵连）`,
    failed(runs[key].events).length === 0,
    `→ ${runs[key].events.length - failed(runs[key].events).length}/${runs[key].events.length}`)
}

// 每个 loader 都确实有一条乱序断言在真实源码里绿着（否则上面的"对应关系"就是空话）
verdict('teams/chest/stock/ledger/fed 每个 loader 都有对应乱序断言',
  LOADER_LABELS.every((l) => EXPECTED_RED[l].every((n) => passed(runs.real.loaders).includes(n))),
  `→ ${LOADER_LABELS.join(',')}`)

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`)
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* Windows 上偶尔文件占用 */ }
process.exit(fail === 0 ? 0 : 1)
