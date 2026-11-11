/**
 * R6 #24 回归：`botRegistry` 有上限、有清理；`roles` 明确只是 hello 自报的提示。
 *
 * 病根（00-缺陷报告 §3 #24）：`board:hello` 直接 `botRegistry.set(bot, …)`，
 *   表无上限、无清理（agent 销毁/连接断了都留着）⇒ 反复创建/改名能把表撑爆；
 *   而 `roles` 是 hello 里**自报**的，`claimFor` 却按它过滤资格 —— 看着像权限，其实谁都能说。
 * 修法：准入判据 + 连接断开摘掉 + 每条登记记 `rolesSource`（提示，不是授权依据）。
 */
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { openBoard } from '../src/agent/library/board_store.js';
import { attachBoardServer, MAX_REGISTERED_BOTS } from '../src/agent/library/board_server.js';
import { BoardClient } from '../src/agent/library/board_client.js';

let pass = 0, fail = 0;
const okCase = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const badCase = (n, a) => { fail++; console.log(`FAIL ${n} ${JSON.stringify(a)}`); };

const DIR = mkdtempSync(join(os.tmpdir(), 'board-registry-'));
let seq = 0;

/** 假 io：能按需"接入"多个 socket，并暴露每个 socket 的 disconnect 触发器。 */
function makeHub() {
    const handlers = new Map();
    let onConn = null;
    const io = {
        on(event, fn) { if (event === 'connection') onConn = fn; },
        emit() {},
    };
    const { db } = openBoard(join(DIR, `db${++seq}`));
    const server = attachBoardServer({
        io, db, registry: new Map([['collect', {}]]),
        validateArgs: (s, a) => ({ ok: true, args: a ?? {} }),
    });
    const sockets = [];
    const connect = (id) => {
        const sockHandlers = new Map();
        const sock = {
            id,
            data: { role: 'panel' },
            on(ev, fn) { sockHandlers.set(ev, fn); },
            fire(ev, payload) {
                const h = sockHandlers.get(ev);
                if (!h) return { ok: false, reason: `no handler ${ev}` };
                let out = null;
                h(payload, (r) => { out = r; });
                return out;
            },
            emit() {},
        };
        sockets.push(sock);
        onConn?.(sock);
        return sock;
    };
    const cleanup = () => { for (const s of sockets) s.fire('disconnect', {}); };
    return { db, server, connect, sockets, cleanup };
}

// ① hello 登记：带 rolesSource + socketId（面板连接可以 hello 多个 bot）
{
    const hub = makeHub();
    const s = hub.connect('sock-1');
    const hello = s.fire('board:hello', { bot: 'alpha', skills: ['collect'], roles: ['miner'] });
    const snap = hub.server.registrySnapshot();
    const reg = snap.get('alpha');
    if (hello.ok && snap.size === 1 && reg?.rolesSource === 'hello-self-reported' && reg?.socketId === 'sock-1') {
        okCase('① hello 登记带 rolesSource / socketId（roles 标明是自报提示）', `size=${snap.size}`);
    } else {
        badCase('① 登记项形状不对', { hello, reg });
    }
    hub.cleanup();
}

// ② 连接断开 → 该连接登记的 bot 被摘掉（同连接上的其它 bot 也摘）
{
    const hub = makeHub();
    const s1 = hub.connect('sock-A');
    const s2 = hub.connect('sock-B');
    s1.fire('board:hello', { bot: 'alpha', skills: ['collect'] });
    s1.fire('board:hello', { bot: 'alpha2', skills: ['collect'] });
    s2.fire('board:hello', { bot: 'beta', skills: ['collect'] });
    const before = hub.server.registrySnapshot().size;
    s1.fire('disconnect', {});
    const snap = hub.server.registrySnapshot();
    if (before === 3 && snap.size === 1 && snap.has('beta')) {
        okCase('② 断开一条连接 → 它登记的 bot 全摘掉，别的连接的不受影响', `3 → ${snap.size}`);
    } else {
        badCase('② 断开清理不对', { before, after: [...snap.keys()] });
    }
    hub.cleanup();
}

// ③ 上限：第 MAX+1 只被明确拒绝（TOO_MUCH），表不增长
{
    const hub = makeHub();
    const sock = hub.connect('sock-many');
    let last = null;
    for (let i = 0; i <= MAX_REGISTERED_BOTS; i++) {
        last = sock.fire('board:hello', { bot: `bot${i}`, skills: ['collect'] });
    }
    const size = hub.server.registrySnapshot().size;
    if (size === MAX_REGISTERED_BOTS && last?.ok === false && last?.code === 'TOO_MUCH' && /上限/.test(last?.reason ?? '')) {
        okCase(`③ 超过上限（${MAX_REGISTERED_BOTS}）→ 拒绝且回明确 reason，表不增长`, `size=${size} reason=${last.reason.slice(0, 24)}`);
    } else {
        badCase('③ 上限没生效', { size, last });
    }
    hub.cleanup();
}

// ④ 同一个 bot 重复 hello 不占额外名额（幂等覆盖）
{
    const hub = makeHub();
    const sock = hub.connect('sock-re');
    sock.fire('board:hello', { bot: 'alpha', skills: ['collect'] });
    sock.fire('board:hello', { bot: 'alpha', skills: ['collect', 'mine'] });
    const reg = hub.server.registrySnapshot().get('alpha');
    if (hub.server.registrySnapshot().size === 1 && reg.skills.has('mine')) {
        okCase('④ 同一 bot 重复 hello 是覆盖（不新增条目，能力更新）', `skills=${[...reg.skills].join(',')}`);
    } else {
        badCase('④ 重复 hello 行为不对', { size: hub.server.registrySnapshot().size });
    }
    hub.cleanup();
}

// ⑤ roles 只作提示：claimFor 仍拿它过滤（现状），但登记里留了 rolesSource 供上层辨别
{
    const hub = makeHub();
    const sock = hub.connect('sock-roles');
    sock.fire('board:hello', { bot: 'gamma', skills: ['collect'], roles: ['i-am-owner'] });
    const reg = hub.server.registrySnapshot().get('gamma');
    if (reg.roles.includes('i-am-owner') && reg.rolesSource === 'hello-self-reported') {
        okCase('⑤ roles 原样记下但带 rolesSource=hello-self-reported（不作授权依据，见 board.md #24）', 'ok');
    } else {
        badCase('⑤ rolesSource 缺失', reg);
    }
    hub.cleanup();
    hub.server.stop();
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
