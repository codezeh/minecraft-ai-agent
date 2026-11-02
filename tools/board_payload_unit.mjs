/**
 * 任务板 payload 形状契约（表驱动）—— t20 落地 captain 的建议。
 *
 * 为什么需要：`board:get` 曾经把 payload 写成 `String({id})` = "[object Object]"，
 * 服务端 `String(payload?.id ?? '')` 拿到那串字符 → 永远查不到 → **恒 null**。
 * 它不抛错、不报警，只是永远返回空 —— 这类"形状不一致"比业务 bug 更难查。
 *
 * 所以：**每个 board:* 事件都断言一次"client 发出去的 payload 键名/类型"**。
 * 判据是"服务端 handler 实际解构哪些字段"（见 board_server.js 的 `payload?.xxx`）。
 *
 * 表里 `want` 的每个键都必须出现在 payload 里且类型对；`forbid` 的键不许出现
 * （典型的 forbid：把整个对象 String 化后塞进 id）。
 */
import { BoardClient } from '../src/agent/library/board_client.js';

let pass = 0, fail = 0, warn = 0;
/** 已知限制：不判失败，但必须留痕（否则"静默两套行为"就藏起来了）。 */
const known = (name, info) => { warn++; console.log(`  ⚠ 已知限制：${name}   ${info}`); };
const chk = (name, cond, info) => {
    // 注意：unit_all 只数行首 `PASS`，所以这里必须打 PASS/FAIL 前缀（不能只打 ✅/❌）
    if (cond) { pass++; console.log(`  PASS  ${name}${info === undefined ? '' : `   ${info}`}`); }
    else { fail++; console.log(`  FAIL  ${name}   ${JSON.stringify(info)}`); }
};

/** 捕获型 socket：记录 client 发出的每个事件与 payload，并立刻回 ack。 */
function makeCaptureSocket() {
    const sent = [];
    return {
        sent,
        on() { /* 忽略服务端推的事件 */ },
        emit(event, payload, cb) {
            sent.push({ event, payload });
            if (typeof cb === 'function') {
                // 回一个形状正确的 ok ack，让 client 的 .then 走 ok 分支
                setTimeout(() => cb({ ok: true, code: 'OK', data: { job: null, jobs: [], id: 'X', helloOk: true } }), 0);
            }
            return true;
        },
        close() {},
    };
}

const isStr = (v) => typeof v === 'string';
const isObj = (v) => v !== null && typeof v === 'object';

/**
 * 表：一行 = 一个事件。
 *   call(client)        → 触发该事件的方法
 *   event               → 期望的事件名
 *   want                → 必须出现的键及类型断言
 *   forbidObjectString  → 关键键不许是 "[object Object]"（形状事故的指纹）
 */
const CASES = [
    {
        name: 'board:hello', event: 'board:hello',
        call: (c) => c.hello(),
        want: { bot: isStr, skills: Array.isArray },
    },
    {
        name: 'board:add', event: 'board:add',
        call: (c) => c.add({ skill: 'collect', params: {}, want: 1 }),
        // 服务端第一个参数就是 job 本身（不是 {job: ...}）—— 这条能抓住"多包一层"的形状错误
        want: { skill: isStr }, forbidObjectString: 'skill'
    },
    {
        name: 'board:list', event: 'board:list',
        call: (c) => c.refresh({ states: ['ready'] }),   // 远端列表走 refresh（list 是本地镜像）
        want: {},                  // filter 对象（可为空对象，但必须是对象）
        wantObject: true,
    },
    {
        name: 'board:get', event: 'board:get',
        call: (c) => c.getAsync('J-1'),
        want: { id: isStr },       // ★ 形状事故原址：id 必须是字符串，不是 "[object Object]"
        forbidObjectString: 'id',
    },
    {
        name: 'board:claim', event: 'board:claim',
        call: (c) => c.claim(),
        want: { bot: isStr },
    },
    {
        name: 'board:heartbeat', event: 'board:heartbeat',
        call: (c) => c.heartbeat('J-1', { progress: { count: 1, want: 2 } }),
        want: { id: isStr, bot: isStr },
        forbidObjectString: 'id',
    },
    {
        name: 'board:checkpoint', event: 'board:checkpoint',
        call: (c) => c.checkpoint('J-1', { step: 2 }),
        want: { id: isStr },
        forbidObjectString: 'id',
    },
    {
        name: 'board:finish', event: 'board:finish',
        call: (c) => c.finish('J-1', { ok: true, code: 'OK', progress: { count: 2, want: 2 } }),
        want: { id: isStr, result: isObj },
        forbidObjectString: 'id',
    },
    {
        name: 'board:set-state', event: 'board:set-state',
        call: (c) => c.setState('J-1', 'paused'),
        want: { id: isStr, state: isStr },
        forbidObjectString: 'id',
    },
    {
        name: 'board:update', event: 'board:update',
        call: (c) => c.update('J-1', { priority: 3 }),
        want: { id: isStr, patch: isObj },
        forbidObjectString: 'id',
    },
];

console.log('=== 表驱动：每个 board:* 事件的 payload 形状 ===');
for (const tc of CASES) {
    const sock = makeCaptureSocket();
    const c = new BoardClient({ name: 'bot1', skills: ['collect'], socket: sock });
    let called = true;
    try { const r = tc.call(c); if (r === null) called = false; } catch { /* 忽略业务异常，只看发出去的形状 */ }
    if (!called) { chk(`${tc.name}（client 没有对应方法，跳过）`, false, '缺少方法'); continue; }

    const hit = sock.sent.find((s) => s.event === tc.event);
    if (!hit) { chk(`${tc.name} 发出了 ${tc.event}`, false, { sent: sock.sent.map((s) => s.event) }); continue; }

    const problems = [];
    if (tc.wantObject && !isObj(hit.payload)) problems.push(`payload 不是对象：${typeof hit.payload}`);
    for (const [k, pred] of Object.entries(tc.want ?? {})) {
        if (!(k in (hit.payload ?? {}))) problems.push(`缺键 ${k}`);
        else if (!pred(hit.payload[k])) problems.push(`${k} 类型不对：${typeof hit.payload[k]} = ${JSON.stringify(hit.payload[k])?.slice(0, 40)}`);
    }
    if (tc.forbidObjectString && isStr(hit.payload?.[tc.forbidObjectString]) && hit.payload[tc.forbidObjectString] === '[object Object]') {
        problems.push(`${tc.forbidObjectString} 是 "[object Object]"（形状事故指纹）`);
    }
    chk(`${tc.name} → ${tc.event}`, problems.length === 0,
        problems.length ? problems : `keys=${Object.keys(hit.payload ?? {}).join(',')}`);
}

console.log('\n=== 专项：board:get 的 id 在三种入参下都必须是字符串 ===');
for (const raw of ['J-1', 123, { id: 'J-1' }]) {
    const sock = makeCaptureSocket();
    const c = new BoardClient({ name: 'bot1', skills: ['collect'], socket: sock });
    try { c.getAsync(raw); } catch { /* ignore */ }
    const hit = sock.sent.find((s) => s.event === 'board:get');
    const id = hit?.payload?.id;
    if (isStr(raw) || typeof raw === 'number') {
        chk(`getAsync(${JSON.stringify(raw)}) → payload.id 是字符串且非 "[object Object]"`,
            isStr(id) && id !== '[object Object]', { id });
    } else if (id === undefined) {
        // 2026-11-02（t20 修复后）：无 .id 的对象 → getAsync 直接 fail、**根本不发事件**
        // → 所以这里拿不到 payload。断言"确实没发"。
        chk(`getAsync(对象无 id) → 不发送 board:get（当面报错，不静默转换）`, true, '未发事件=正确');
    } else if (id === '[object Object]') {
        chk(`getAsync(对象) 不许被 String() 压成 "[object Object]"`, false, { id });
    } else {
        // 2026-11-02（t20 修复后）：{id:'J-1'} → 取 .id，"J-1"
        chk(`getAsync(${JSON.stringify(raw)}) → 取 .id 发出去（${JSON.stringify(id)}）`,
            isStr(id) && id === raw.id, { id });
    }
}

console.log('\n=== 每个事件都真的发到了 server（事件名一一对应）===');
{
    const clientEvents = new Set();
    const probeSock = makeCaptureSocket();
    const c = new BoardClient({ name: 'b', skills: [], socket: probeSock });
    // 触发全部事件
    CASES.forEach((tc) => { try { tc.call(c); } catch { /* ignore */ } });
    probeSock.sent.forEach((s) => clientEvents.add(s.event));
    const want = new Set(CASES.map((t) => t.event));
    const missing = [...want].filter((e) => !clientEvents.has(e));
    chk(`这 ${want.size} 个事件 client 全都发得出来`, missing.length === 0, { missing });
}

console.log(`\n合计 ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
