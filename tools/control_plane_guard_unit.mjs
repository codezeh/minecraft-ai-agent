/**
 * R4 控制面缺陷批 —— **离线**：不起服务、不 spawn 真进程、不连 socket。
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ 本文件钉的是第四轮审计 §7 里控制面那 6 条（+ 同文件的 S2#12）：              │
 * │                                                                          │
 * │  S1#3  双开：`start-agent` 无限流 + `forceRestart()` 在 `process.killed`    │
 * │        时直接 spawn（killed 只表示"信号发过了"，不代表进程已退）           │
 * │  S1#4  孤儿：`destroy-agent` 用 fire-and-forget `stop()` 后立刻删表 ⇒      │
 * │        忽略 SIGINT 的子进程仍持租约领单，而控制面再也管不到它               │
 * │  S1#5  类型：`create-agent` 的 settings 未校验类型 ⇒ 畸形事件打挂控制面      │
 * │  S2#9  身份：`login-agent`/`connect-agent-process` 无身份校验 ⇒ 多客户端     │
 * │        互踢、玩家消息静默丢失                                              │
 * │  S2#10 幂等：`listen-to-agents` 非幂等 ⇒ relay 重复注册、1 Hz 轮询永不停止   │
 * │  S3#20 泄漏：`get-profiles` 回本机绝对路径                                 │
 * │  S2#12 spawn `'error'` 不置 `running=false` ⇒ 以为还在跑，再也不重启        │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * 分五段：
 *   A. 纯判据：settings 形状校验 / agent 身份 / 通道唯一占用裁决 / 顶层兜底
 *   B. AgentProcess：双开闸、forceRestart 并发与"未确认退出就不 spawn"、spawn error
 *   C. mindcraft：`destroyAgent` 未确认退出不删表、`startAgent` 把结果传出来
 *   D. 订阅幂等：`addListener`/`removeListener`/relay 只注册一次、轮询能停
 *   E. 源码接线断言：函数改对了还得真的接上（防"改了但没人调用"）
 *
 * 输出：PASS / FAIL，全过退出码 0（unit_all 按 *PASS 行数* 判"真的跑了用例"）。
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentProcess } from '../src/process/agent_process.js';
import * as mindcraft from '../src/mindcraft/mindcraft.js';
import {
    validateSettingsShape, isAgentIdentity, claimAgentChannel, installCrashGuards,
    addListener, removeListener, isStatePolling, numStateListeners,
} from '../src/mindcraft/mindserver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

// ════════════════════════════════════════════════════════════════════════════
// A. 纯判据
// ════════════════════════════════════════════════════════════════════════════

// ── A1. S1#5：create-agent 的 settings 形状 ─────────────────────────────────
{
    const cases = [
        [null, 'null'],
        [undefined, 'undefined'],
        ['{"profile":{"name":"x"}}', '字符串（JSON 文本，最常见的误传）'],
        [[{ profile: { name: 'x' } }], '数组'],
        [42, '数字'],
        [{}, '缺 profile'],
        [{ profile: null }, 'profile 为 null'],
        [{ profile: 'bot' }, 'profile 是字符串'],
        [{ profile: ['bot'] }, 'profile 是数组'],
        [{ profile: {} }, 'profile 缺 name'],
        [{ profile: { name: 123 } }, 'name 不是字符串'],
        [{ profile: { name: '   ' } }, 'name 全是空格'],
    ];
    let ok = true, bad = null;
    for (const [v, label] of cases) {
        const r = validateSettingsShape(v);
        if (typeof r !== 'string' || r.length === 0) { ok = false; bad = label; break; }
    }
    check('A1 畸形 settings 全部被**当场拒绝**（而不是让 `key in settings` 抛异常打挂控制面）',
        ok, bad ? `→ 漏了: ${bad}` : `${cases.length} 种形状都被拒`);
    check('A1b 合法 settings 放行', validateSettingsShape({ profile: { name: 'bot1' } }) === null);
    check('A1c 拒绝原因里有可读信息（不是 "error" 三个字母）',
        String(validateSettingsShape(null)).includes('profile'));
}

// ── A2. S2#9：agent 身份判据 ────────────────────────────────────────────────
{
    const TOKEN = 'tok-abc';
    check('A2 auth.token 正确 → agent 身份',
        isAgentIdentity({ handshake: { auth: { token: TOKEN } } }, TOKEN) === true);
    check('A2b 面板（只有 cookie，无 auth payload）→ 不是 agent 身份',
        isAgentIdentity({ handshake: { headers: { cookie: 'x=1' } } }, TOKEN) === false);
    check('A2c token 不对 → 不是 agent 身份',
        isAgentIdentity({ handshake: { auth: { token: 'other' } } }, TOKEN) === false);
    check('A2d 空 token / 空 socket 不炸',
        isAgentIdentity({ handshake: { auth: { token: '' } } }, TOKEN) === false && isAgentIdentity(null, TOKEN) === false);
}

// ── A3. S2#9：通道唯一占用裁决 ─────────────────────────────────────────────
{
    const S = (id) => ({ id, connected: true });
    const conn = { socket: null };
    const a = S('a');

    const r0 = claimAgentChannel(conn, a, { agentIdentity: false });
    check('A3 面板连接不许占用 agent 通道（identity-required）',
        r0.ok === false && r0.reason === 'identity-required');

    const r1 = claimAgentChannel(conn, a, { agentIdentity: true, now: 1000 });
    check('A3b agent 身份首次绑定成功', r1.ok === true && r1.reason === 'claim' && r1.takeover === false);
    conn.socket = a;

    const r2 = claimAgentChannel(conn, a, { agentIdentity: true, now: 1000 });
    check('A3c 同一个 socket 重复声明 = 幂等 rebind（connect-agent-process 后紧跟 login-agent 就走这条）',
        r2.ok === true && r2.reason === 'rebind' && r2.takeover === false);

    // agent 进程重启/瞬断重连是常态：允许接管，但限速
    let last = null;
    for (let i = 0; i < 3; i++) {
        const s = S('next' + i);
        last = claimAgentChannel(conn, s, { agentIdentity: true, now: 2000 + i * 10 });
        if (last.ok) conn.socket = s;
    }
    check('A3d 换连接允许接管（接管后通道只有一个主人）',
        last.ok === true && last.reason === 'takeover-live' && last.takeover === true);
    const over = claimAgentChannel(conn, S('boom'), { agentIdentity: true, now: 2100 });
    check('A3e 同一个 agent 短时间内被反复抢 ⇒ channel-busy（"两个进程互相踢"不再无声循环）',
        over.ok === false && over.reason === 'channel-busy');
    const later = claimAgentChannel(conn, S('after-window'), { agentIdentity: true, now: 2100 + 30_001 });
    check('A3f 过了窗口就能重新接管（不会把合法重连永久锁死）', later.ok === true);

    // 旧连接已经掉了 —— 接手死连接不该计入限速
    const deadConn = { socket: { id: 'dead', connected: false } };
    const rDead = claimAgentChannel(deadConn, S('fresh'), { agentIdentity: true, now: 0 });
    check('A3g 接手已断开的旧连接不算抢占、不消耗接管额度',
        rDead.ok === true && rDead.reason === 'takeover-stale' && (deadConn._channelTakeovers?.count ?? 0) === 0);

    check('A3h 未注册的 agent / 没有 socket 都不炸',
        claimAgentChannel(null, S('x'), { agentIdentity: true }).reason === 'unknown-agent'
        && claimAgentChannel({ socket: null }, null, { agentIdentity: true }).reason === 'no-socket');
}

// ── A4. S1#5 兜底：顶层 unhandledRejection / uncaughtException ──────────────
{
    const fakeProc = new EventEmitter();
    const first = installCrashGuards({ proc: fakeProc, exitOnUncaught: false });
    const second = installCrashGuards({ proc: fakeProc, exitOnUncaught: false });
    check('A4 兜底装上且幂等（同一进程只装一次）', first === true && second === false);
    check('A4b 两类事件各有一个监听',
        fakeProc.listenerCount('unhandledRejection') === 1 && fakeProc.listenerCount('uncaughtException') === 1);
    let threw = false;
    try {
        fakeProc.emit('unhandledRejection', new Error('boom'));
        fakeProc.emit('uncaughtException', new Error('boom2'));
    } catch { threw = true; }
    check('A4c 兜住一个畸形事件之后进程**没有**退出（这正是 S1#5 的现场：一条坏消息打挂整套控制面）',
        threw === false);
}

// ════════════════════════════════════════════════════════════════════════════
// B. AgentProcess：双开 / 孤儿 / spawn 失败
// ════════════════════════════════════════════════════════════════════════════

/** 假子进程：EventEmitter 形状 + kill/pid/killed（stopChildAndWait 只需要这些）。 */
function makeFakeChild({ dieOn = 'SIGINT' } = {}) {
    const child = new EventEmitter();
    child.pid = 4000;
    child.killed = false;
    child.exitCode = null;
    child.signalCode = null;
    child.kills = [];
    child.kill = (sig) => {
        child.kills.push(sig);
        child.killed = true;                       // ★ 与真 child_process 一致：只表示"信号发过了"
        if (dieOn === 'SIGINT' && sig === 'SIGINT') setTimeout(() => child.emit('exit', 0, 'SIGINT'), 0);
        if (dieOn === 'SIGKILL' && sig === 'SIGKILL') setTimeout(() => child.emit('exit', null, 'SIGKILL'), 0);
        return true;                               // dieOn === 'NEVER'：连 SIGKILL 都不退（顽固孤儿）
    };
    return child;
}

/** 造一个 spawn 可控的 AgentProcess（毫秒级等待，不真起进程）。 */
function makeProc(name, { dieOn = 'SIGINT' } = {}) {
    const p = new AgentProcess(name, 8080);
    p.stopOpts = { graceMs: 20, killGraceMs: 20 };
    const kids = [];
    p._spawn = () => { const c = makeFakeChild({ dieOn }); kids.push(c); return c; };
    return { p, kids };
}

// ── B1. S1#3：start() 的重复启动闸 ─────────────────────────────────────────
{
    const { p, kids } = makeProc('dup');
    const r1 = p.start();
    const r2 = p.start();
    check('B1 连续两次 start() 只 spawn **一个**子进程（第二次被拒并返回 false）',
        r1 === true && r2 === false && kids.length === 1, `spawn=${kids.length}`);

    kids[0].killed = true;   // 信号已发、进程仍在 —— 旧代码正是在这里走 else 直接 spawn 第二个
    const r3 = p.start();
    check('B1b `process.killed===true` 不等于已退出：仍然拒绝第二次启动（这就是面板双击双开的那条路）',
        r3 === false && kids.length === 1, `spawn=${kids.length}`);

    kids[0].emit('exit', 0, null);   // 真的退了
    check('B1c 子进程真的退出后 running 才落回 false', p.running === false);
    const r4 = p.start();
    check('B1d 退出之后可以正常再启动（闸不是"永久锁死"）', r4 === true && kids.length === 2);
    kids[1].emit('exit', 0, null);
}

// ── B2. S1#3：forceRestart 并发保护（面板双击）─────────────────────────────
{
    const { p, kids } = makeProc('dbl');
    p.start();                                        // kid0 在跑
    const [a, b] = await Promise.all([p.forceRestart(), p.forceRestart()]);
    check('B2 面板双击（两个并发 forceRestart）只产生**一个**新进程', kids.length === 2, `spawn=${kids.length}`);
    check('B2b 第二个请求明确返回 in-progress（不是静默成功、也不是又 spawn 一个）',
        b.started === false && b.reason === 'in-progress');
    check('B2c 第一个请求正常完成重启', a.started === true && a.reason === 'restarted' && a.exited === true);
    kids[1].emit('exit', 0, null);
}

// ── B3. S1#3：旧进程没确认退出 ⇒ 绝不 spawn 新的（宁可不起，也不双开）────────
{
    const { p, kids } = makeProc('orphan', { dieOn: 'NEVER' });
    p.start();                                        // 顽固子进程：SIGINT/SIGKILL 都不退
    const r = await p.forceRestart();
    check('B3 旧进程未确认退出 → **拒绝**拉起新进程（旧代码会在 killed===true 时直接 spawn ⇒ 双开）',
        r.started === false && r.exited === false && kids.length === 1, `spawn=${kids.length}`);
    check('B3b 如实上报原因（still-alive），不假装重启成功', r.reason === 'still-alive' && r.escalated === true);
    check('B3c 已经试过强杀（SIGINT → SIGKILL），不是只发个信号就放弃',
        JSON.stringify(kids[0].kills) === '["SIGINT","SIGKILL"]', JSON.stringify(kids[0].kills));
}

// ── B4. 正常重启：旧进程响应 SIGINT 退出后才 spawn 新的 ─────────────────────
{
    const { p, kids } = makeProc('normal');
    p.start();
    const r = await p.forceRestart();
    check('B4 旧进程自己退了 → 才拉起新进程（顺序对，不会重叠）',
        r.started === true && r.reason === 'restarted' && kids.length === 2);
    check('B4b 旧进程收到的是 SIGINT（礼貌优先，不是一上来就 SIGKILL）',
        kids[0].kills[0] === 'SIGINT', JSON.stringify(kids[0].kills));
    kids[1].emit('exit', 0, null);
}

// ── B5. S2#12：spawn 'error' 必须把 running 落回 false ──────────────────────
{
    const p = new AgentProcess('spawnfail', 8080);
    p.stopOpts = { graceMs: 20, killGraceMs: 20 };
    const kids = [];
    p._spawn = () => {
        const c = makeFakeChild();
        kids.push(c);
        setTimeout(() => c.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })), 0);
        return c;
    };
    p.start();
    await new Promise((r) => setTimeout(r, 20));
    check('B5 spawn 失败后 running=false（原来永远是 true ⇒ start/stop/forceRestart 全都以为它还在跑）',
        p.running === false);
    const again = p.start();
    check('B5b 失败之后可以重新拉起（不会永久卡在"以为在跑"）', again === true && kids.length === 2);
    kids[1].emit('exit', 0, null);
}

// ── B6. 过期子进程事件不许动新一代的状态 ───────────────────────────────────
{
    const { p, kids } = makeProc('stale');
    p.start();                                    // gen 1
    const gen = p._gen;
    const plan = p._onChildExit(0, null, 0, gen - 1);
    check('B6 上一代子进程迟到的 exit 被丢弃（否则新进程的状态会被打成"没在跑"）',
        plan.action === 'stale' && p.running === true, plan.action);
    kids[0].emit('exit', 0, null);
}

// ════════════════════════════════════════════════════════════════════════════
// C. mindcraft：S1#4 未确认退出不删表
// ════════════════════════════════════════════════════════════════════════════
const fakeAgentProcess = (stopResult) => ({
    running: true,
    process: { pid: 1 },
    count_id: 0,
    stop() { return { exited: false, sent: true, reason: 'sent-sigint' }; },
    // 不做 async（无 await 的 async 会被 require-await 判为问题）：返回已决的 Promise 即可
    stopAndWait() { return Promise.resolve(stopResult); },
});

{
    mindcraft.__test.set('keep', fakeAgentProcess({ exited: false, escalated: true, reason: 'still-alive' }));
    const r = await mindcraft.destroyAgent('keep');
    check('C1 未确认退出 ⇒ **不删表**（否则忽略 SIGINT 的孤儿仍在领单/续租，而控制面再也管不到它）',
        r.ok === false && r.removed === false && mindcraft.__test.names().includes('keep'));
    check('C1b 失败原因如实上报（still-alive / 已强杀）', r.reason === 'still-alive' && r.escalated === true);
    mindcraft.__test.remove('keep');

    mindcraft.__test.set('gone', fakeAgentProcess({ exited: true, escalated: true, reason: 'killed' }));
    const r2 = await mindcraft.destroyAgent('gone');
    check('C2 确认退出之后才删表', r2.ok === true && r2.removed === true && !mindcraft.__test.names().includes('gone'));
    check('C2b "强杀后才退"也要标出来（运维要知道这次是打死的）', r2.escalated === true && r2.exited === true);

    const r3 = await mindcraft.destroyAgent('never-existed');
    check('C3 不存在的 agent → 幂等返回（不抛、不假装删了）', r3.ok === true && r3.removed === false);

    // startAgent 必须把 forceRestart 的结果传出去（原来同步调用、结果丢了）
    mindcraft.__test.set('s1', {
        count_id: 0,
        forceRestart() { return Promise.resolve({ started: false, exited: false, reason: 'still-alive' }); },
    });
    const sr = await mindcraft.startAgent('s1');
    check('C4 startAgent 把"这次没起来"如实返回（面板才能提示，而不是以为点了就起来了）',
        sr.started === false && sr.reason === 'still-alive');
    mindcraft.__test.remove('s1');

    const sr2 = await mindcraft.startAgent('nope');
    check('C5 startAgent 对不存在的 agent 返回 not-found（而不是 undefined 让调用方炸）',
        sr2.started === false && sr2.reason === 'not-found');
}

// ════════════════════════════════════════════════════════════════════════════
// D. S2#10：订阅幂等 + 1 Hz 轮询能停
// ════════════════════════════════════════════════════════════════════════════
function makeFakeSocket(id) {
    return {
        id,
        connected: true,
        handlers: {},
        on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return this; },
        emit() { return true; },
    };
}
{
    const s = makeFakeSocket('L1');
    const added1 = addListener(s);
    const added2 = addListener(s);
    check('D1 同一个 socket 重复订阅是**幂等**的（原来会往集合里塞第二个自己）',
        added1 === true && added2 === false && numStateListeners() === 1, `n=${numStateListeners()}`);
    check('D1b relay 只注册一次：request-map / request-terrain / get-events 各恰好 1 个处理器' +
        '（`socket.on` 是追加语义，重复注册会让一次请求变成 N 次 agent.emit）',
        s.handlers['request-map']?.length === 1
        && s.handlers['request-terrain']?.length === 1
        && s.handlers['get-events']?.length === 1,
        JSON.stringify(Object.fromEntries(Object.entries(s.handlers).map(([k, v]) => [k, v.length]))));
    check('D1c 有订阅时 1 Hz 状态轮询在跑', isStatePolling() === true);

    const removed1 = removeListener(s);
    const removed2 = removeListener(s);
    check('D2 退订也是幂等的，且**轮询真的停下**（"1 Hz 永不停止"的判据）',
        removed1 === true && removed2 === false && numStateListeners() === 0 && isStatePolling() === false);

    // 关键回归：退订一个"没订阅过"的 socket 不许误伤别人
    const a = makeFakeSocket('A'), b = makeFakeSocket('B'), stranger = makeFakeSocket('X');
    addListener(a);
    addListener(b);
    const r = removeListener(stranger);
    check('D3 退订一个没订阅过的 socket 不会误删别人的订阅（原来 `splice(indexOf(-1),1)` 会删掉**最后一个**监听者）',
        r === false && numStateListeners() === 2, `n=${numStateListeners()}`);
    removeListener(a);
    removeListener(b);
    check('D4 全部退订后集合归零、轮询停止', numStateListeners() === 0 && isStatePolling() === false);
}

// ════════════════════════════════════════════════════════════════════════════
// E. 接线断言：函数改对了，还得真的接上
// ════════════════════════════════════════════════════════════════════════════
{
    const read = (p) => readFileSync(path.join(__dirname, p), 'utf8');
    const ms = read('../src/mindcraft/mindserver.js');
    const mc = read('../src/mindcraft/mindcraft.js');
    const ap = read('../src/process/agent_process.js');
    const at = (needle, from = 0) => ms.indexOf(needle, from);
    const block = (needle, len) => {
        const i = at(needle);
        return i === -1 ? '' : ms.slice(i, i + len);
    };

    const startBlock = block("socket.on('start-agent'", 1200);
    check('E1 start-agent 有来源限流（原来完全无限流，而它每次都可能 spawn 一个进程）',
        /takeToken\(socket, 'start-agent'/.test(startBlock));
    check('E1b start-agent 等 forceRestart 的结果并检查"没起来"',
        /await mindcraft\.startAgent\(/.test(startBlock) && /start-agent-failed/.test(startBlock));

    const destroyBlock = block("socket.on('destroy-agent'", 2000);
    check('E2 destroy-agent 等确认退出（await destroyAgent）', /await mindcraft\.destroyAgent\(/.test(destroyBlock));
    check('E2b destroy-agent 未确认退出时**不删**注册项、并告知面板',
        /if \(!r\?\.ok\)/.test(destroyBlock) && /destroy-agent-failed/.test(destroyBlock));

    const createBlock = block("socket.on('create-agent'", 1800);
    check('E3 create-agent 先校验 settings 形状，再走到 `for (let key in settings_spec)`',
        /validateSettingsShape\(settings\)/.test(createBlock)
        && createBlock.indexOf('validateSettingsShape(settings)') < createBlock.indexOf('for (let key in settings_spec)'));
    check('E3b create-agent 的回执走 ack()（裸 callback(...) 在客户端不带 ack 时会抛 TypeError 打挂控制面）',
        /const ack = \(payload\)/.test(createBlock) && !/callback\(\{ success/.test(createBlock));
    check('E4 顶层兜底真的装了（installCrashGuards 在 createMindServer 里被调用）',
        /installCrashGuards\(\);/.test(ms));

    check('E5 login-agent / connect-agent-process 统一走身份裁决（agent 身份 + 唯一占用）',
        /function bindAgentChannel/.test(ms)
        && /claimAgentChannel\(conn, socket, \{ agentIdentity: isAgentIdentity\(socket\) \}\)/.test(ms)
        && /bindAgentChannel\(agentName, 'login-agent'\)/.test(ms)
        && /bindAgentChannel\(agentName, 'connect-agent-process'\)/.test(ms));
    check('E5b disconnect 只清"自己仍然是持有者"的绑定（旧连接迟到的事件不许抹掉新主人）',
        /agent_connections\[curAgentName\]\?\.socket === socket/.test(ms));

    const listenBlock = block("socket.on('listen-to-agents'", 900);
    check('E6 listen-to-agents 先做幂等检查再限流（重复订阅不消耗令牌、不重复注册）',
        /agent_listeners\.includes\(socket\)/.test(listenBlock)
        && listenBlock.indexOf('agent_listeners.includes(socket)') < listenBlock.indexOf('takeToken('));

    check('E7 get-profiles 不再回本机绝对路径（F-WEB-204 同类第 4 处）',
        // 只看**代码**那行（注释里为解释缺陷会引用旧写法 `dir: profilesDir`，拿注释当锚点会误判）
        /callback\(\{ ok: true, dir: path\.basename\(profilesDir\), profiles: out \}\)/.test(ms)
        && !/dir: profilesDir,/.test(ms.replace(/^\s*\/\/.*$/gm, '')));
    check('E7b get-profiles 里每个 path 字段都是 basename',
        !/path: full[,}\s]/.test(ms));

    const apCode = ap.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    check('E8 agent_process 不再用 `process.killed` 判断"已经停了"（它只表示信号发过了）',
        !/process\.killed/.test(apCode));
    check('E9 spawn 的 error 事件把 running 落回 false',
        /agentProcess\.on\('error'[\s\S]{0,700}this\.running = false/.test(ap));
    check('E10 AgentProcess.start 对"仍在运行"直接拒绝（双开闸）',
        /if \(this\.running && this\.process\) \{[\s\S]{0,300}return false;/.test(ap));
    check('E11 forceRestart 先 stopAndWait、未确认退出不 spawn',
        /async forceRestart\(\)/.test(ap) && /const r = await this\.stopAndWait\(\)/.test(ap)
        && /if \(!r\.exited\)/.test(ap));

    check('E12 mindcraft.destroyAgent 是 async 且走 stopAndWait、未确认退出不删表',
        /export async function destroyAgent/.test(mc) && /stopAndWait\(/.test(mc)
        && /if \(!r\.exited\)/.test(mc));
    check('E13 mindcraft.createAgent 拒绝"同名进程仍在跑"时再建（删了再建也是双开）',
        /拒绝重复创建/.test(mc));
    check('E14 createAgent 失败路径 await destroyAgent（不再 fire-and-forget）',
        /await destroyAgent\(agent_name\)/.test(mc));
}

// ════════════════════════════════════════════════════════════════════════════
// F. 停手契约：**先摘租约、放预约，再退出**（S1#4 的另一半）
//    scheduler / boardClient 只活在**子进程**里，所以"停手"必须由子进程在 SIGINT
//    之后、process.exit 之前做完；父进程的顺序保证"先 SIGINT、等 grace、才 SIGKILL"。
// ════════════════════════════════════════════════════════════════════════════
{
    const ia = readFileSync(path.join(__dirname, '../src/process/init_agent.js'), 'utf8');
    check('F1 子进程装了 SIGINT/SIGTERM 优雅停手（原来 SIGINT 直接死，调度器/心跳一行都不跑）',
        /for \(const sig of \['SIGINT', 'SIGTERM'\]\)/.test(ia) && /gracefulStop\(`signal:/.test(ia));
    check('F2 停手调了 scheduler.stop + boardClient.stop（不再续租的判据来源）',
        /scheduler\?\.stop\?\.\('preempt'\)/.test(ia) && /board\?\.stop\?\.\('preempt'\)/.test(ia));

    const iUpdate = ia.indexOf("state: 'ready', lease_owner: null");
    const iRelease = ia.indexOf('board?.release?.(id)');
    const iDisconnect = ia.lastIndexOf('board?.socket?.disconnect?.()');
    const iExit = ia.lastIndexOf('process.exit(0)');
    check('F3 顺序 = 交还单 → 放预约 → 断连 → 退出（不是"先死再摘"，那样就没人能摘了）',
        iUpdate > 0 && iUpdate < iRelease && iRelease < iDisconnect && iDisconnect < iExit,
        `update=${iUpdate} release=${iRelease} disconnect=${iDisconnect} exit=${iExit}`);
    check('F4 交还时连 assignee 一起清（claimFor 的候选条件是 assignee IS NULL 或 = 我，不清就别人抢不到）',
        /assignee: null/.test(ia.slice(Math.max(0, iUpdate - 200), iUpdate + 200)));
    // 断言只看代码（注释里为了解释"为什么不用"会提到 releaseLease，拿注释当锚点会误判）
    const iaCode = ia.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    check('F5 不用"只清租约"的 releaseLease 收尾：租约清成 NULL 后 `expireLeases`（只收 lease_until IS NOT NULL）永远回收不到 = 僵尸单',
        !/releaseLease/.test(iaCode));
    check('F5b cleanKill（被踢/断线/缺玩家）也走同一套停手（它直接 process.exit，绕过信号）',
        /agent\.cleanKill = \(msg, code\) =>/.test(iaCode) && /gracefulStop\(`cleanKill:/.test(iaCode));

    // 父进程侧的顺序保证：SIGINT 先行、SIGKILL 只在宽限到期后
    const apSrc = readFileSync(path.join(__dirname, '../src/process/agent_process.js'), 'utf8');
    check('F6 父进程的 stopAndWait 走 stopChildAndWait（SIGINT → 等 grace → SIGKILL），给"停手"留出时间',
        /stopChildAndWait\(this\.process/.test(apSrc));
    const pl = readFileSync(path.join(__dirname, '../src/process/proc_lifecycle.js'), 'utf8');
    check('F7 stopChildAndWait 里 SIGINT 早于 SIGKILL（顺序写死在实现里，不是调用方自觉）',
        pl.indexOf("child.kill('SIGINT')") < pl.indexOf("child.kill('SIGKILL')"));
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);