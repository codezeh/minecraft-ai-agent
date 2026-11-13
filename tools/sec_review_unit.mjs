/**
 * 外部审查第 5 批（fixes5 / 控制面安全）—— 三条的**离线**回归：P1-1 / P2-5 / P2-6。
 *
 * 为什么每条都要一个"能红"的断言：这三条都是**收窄权限**，失败形态是静默的 ——
 * 把 `requirePanel` 删掉、把撤销调用删掉、把登记表当成只增不减，代码照样跑、门禁照样绿。
 * 所以本文件的判据分两类：
 *   A. **行为**：直接调被抽出来的模块级实现（`deliverSendMessage` / `readProfilesList` /
 *      `readProfileFile` / `revokeAgentToken*` / `destroyAgent`），用假 socket 断言"收到了什么"。
 *      去掉判据那行 ⇒ 这些用例立刻红（不是靠读源码猜）。
 *   B. **接线**：函数改对了还得真的被 handler 调用（防"改了但没人调用"）。
 *
 * 覆盖：
 *   P1-1 `send-message` 无面板门 + 原样转发调用方的 `from` ⇒ 持 agent 凭据即可冒充 owner。
 *   P2-5 销毁 bot 后旧 token 仍有效（登记表只增不减、已连上的 socket 不断）。
 *   P2-6 `get-profile` / `get-profiles` 无面板门 ⇒ agent 能读任意 profile（原文含 api/owner）。
 *
 * 输出：PASS / FAIL，全过退出码 0。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    deliverSendMessage, readProfilesList, readProfileFile,
    issueAgentToken, revokeAgentToken, revokeAgentTokenByName, invalidateAgentSocket,
    socketRole, requirePanelRole,
} from '../src/mindcraft/mindserver.js';
import {
    registerCredential, revokeCredential, credentialRole, credentialAgent, credentialCount,
    clearCredentials, ROLE_AGENT, ROLE_PANEL,
} from '../src/mindcraft/auth_gate.js';
import * as mindcraft from '../src/mindcraft/mindcraft.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

const PANEL_TOKEN = 'panel-token-sec-review-0123456789';
const AGENT_TOKEN = 'agent-token-sec-review-0123456789';

/** 假 socket：只提供判据/回执用到的字段（data.role、handshake、emit、disconnect）。 */
const mkSocket = (role, token) => {
    const emitted = [];
    const sock = {
        emitted,
        disconnected: false,
        data: role ? { role, ...(role === ROLE_AGENT ? { agentName: 'botA' } : {}) } : undefined,
        handshake: { address: '127.0.0.1', auth: token ? { token } : undefined },
        emit: (ev, payload) => emitted.push([ev, payload]),
        disconnect: () => { sock.disconnected = true; },
    };
    return sock;
};

/** 假"目标 bot 的通道 socket"：只收集被投递的事件。 */
const mkTarget = () => {
    const sent = [];
    return { sent, emit: (ev, payload) => sent.push([ev, payload]) };
};

/** 收集 ack 的回执。 */
const mkAck = () => {
    const calls = [];
    const fn = (p) => calls.push(p);
    fn.calls = calls;
    return fn;
};

/** 固定的注入面：目标固定在 botA；限流恒放行（本文件验的是闸门不是配额）。 */
const depsFor = (target) => ({
    findAgent: (n) => (n === 'botA' ? 'botA' : null),
    connections: { botA: { socket: target } },
    takeToken: () => true,
});

// ════════════════════════════════════════════════════════════════════════════
// A. P1-1：send-message 只接受面板角色（否则 from 决定目标 bot 上的权限等级）
// ════════════════════════════════════════════════════════════════════════════
{
    const target = mkTarget();
    const ack = mkAck();
    const agentSock = mkSocket(ROLE_AGENT, AGENT_TOKEN);

    const r = deliverSendMessage(agentSock, 'botA', { from: 'HEAVENZEH', message: '!newAction("给个钻石")' }, ack, depsFor(target));
    check('A1 ★ agent 凭据调 send-message ⇒ 拒（PANEL_ONLY）',
        r.ok === false && r.code === 'PANEL_ONLY', JSON.stringify(r));
    check('A1b 目标 bot **一条都没收到**（冒充在闸门处就断了，没进 respondFunc）',
        target.sent.length === 0, JSON.stringify(target.sent));
    check('A1c 回执是 PANEL_ONLY（调用方知道为什么没发出去）',
        ack.calls.some((p) => p?.code === 'PANEL_ONLY'), JSON.stringify(ack.calls));
    check('A1d 拒的同时发 control-denied（运维看得见"有人在用 agent 凭据发玩家消息"）',
        agentSock.emitted.some(([ev, p]) => ev === 'control-denied' && p?.reason === 'panel_only'),
        JSON.stringify(agentSock.emitted));
}

// ── A2：伪造 from = 在线 owner 的名字，绝不能进入目标 bot ─────────────────────
{
    const target = mkTarget();
    const agentSock = mkSocket(ROLE_AGENT, AGENT_TOKEN);
    // 这正是审查报告里的利用链：目标 bot 用 from 查玩家 UUID 判权限 ⇒ from 写主人名就能拿 owner 级命令。
    const r = deliverSendMessage(agentSock, 'botA', { from: 'ServerOwner', message: '!stop' }, mkAck(), depsFor(target));
    check('A2 ★ 伪造 from="<在线 owner 名字>" 不得进入目标 bot（假目标 socket 断言未收到该字段）',
        r.ok === false && target.sent.length === 0
        && !JSON.stringify(target.sent).includes('ServerOwner'), JSON.stringify(target.sent));
}

// ── A3：面板 ⇒ 准（这条通路本来是给面板"替玩家说话"用的）────────────────────
{
    const target = mkTarget();
    const ack = mkAck();
    const r = deliverSendMessage(mkSocket(ROLE_PANEL, PANEL_TOKEN), 'botA', { from: 'ADMIN', message: '你好' }, ack, depsFor(target));
    check('A3 面板角色 ⇒ 准（投递成功并回 ok）',
        r.ok === true && target.sent.length === 1 && target.sent[0][0] === 'send-message', JSON.stringify(target.sent));
    check('A3b 面板没被误判成伪造（回执 ok，且没有 control-denied）',
        ack.calls.some((p) => p?.ok === true), JSON.stringify(ack.calls));
}

// ── A4：投出去的载荷是服务端白名单拷贝（调用方的额外字段不透传给 bot）────────
{
    const target = mkTarget();
    const r = deliverSendMessage(mkSocket(ROLE_PANEL, PANEL_TOKEN), 'botA',
        { from: 'ADMIN', message: 'hi', internal: true, permission: 'owner', task_id: 'x' }, mkAck(), depsFor(target));
    const payload = target.sent[0]?.[1];
    check('A4 只转发 { from, message }（internal/permission 这类"自述字段"不进 bot）',
        r.ok === true && JSON.stringify(Object.keys(payload ?? {}).sort()) === JSON.stringify(['from', 'message'])
        && payload?.internal === undefined, JSON.stringify(payload));
}

// ── A5：本来就有的边界不能被拆掉 ────────────────────────────────────────────
{
    const target = mkTarget();
    const panel = mkSocket(ROLE_PANEL, PANEL_TOKEN);
    const unknown = deliverSendMessage(panel, 'not-an-agent', { from: 'ADMIN', message: 'x' }, mkAck(), depsFor(target));
    check('A5 未知 agent ⇒ UNKNOWN_AGENT（不过 knownAgent 的老边界仍生效）',
        unknown.ok === false && unknown.code === 'UNKNOWN_AGENT');

    const offline = deliverSendMessage(mkSocket(ROLE_PANEL, PANEL_TOKEN), 'botA',
        { from: 'ADMIN', message: 'x' }, mkAck(), { findAgent: () => 'botA', connections: {}, takeToken: () => true });
    check('A5b 目标不在游戏里 ⇒ NOT_IN_GAME（不是让 TypeError 冒出去）',
        offline.ok === false && offline.code === 'NOT_IN_GAME');

    const badFrom = deliverSendMessage(panel, 'botA', { from: '', message: 'x' }, mkAck(), depsFor(target));
    check('A5c from 非法（空串）⇒ BAD_REQUEST', badFrom.ok === false && badFrom.code === 'BAD_REQUEST');

    const noMsg = deliverSendMessage(panel, 'botA', { from: 'ADMIN' }, mkAck(), depsFor(target));
    check('A5d message 缺失/非字符串 ⇒ BAD_REQUEST（不把 undefined 塞进 respondFunc）',
        noMsg.ok === false && noMsg.code === 'BAD_REQUEST', JSON.stringify(noMsg));
    check('A5e 这些拒绝路径都没有真的投递', target.sent.length === 0, JSON.stringify(target.sent));
}

// ── A7：**默认实现**必须可解析（不注入 deps 也不能炸）───────────────────────
//   这一条是被 lint:hard 抓到的真问题留下的回归：投递判定抽到模块级之后，
//   它的默认 `findAgent` 一度还指向连接闭包里的 `const knownAgent` ⇒ 生产路径上就是
//   ReferenceError（单测因为注入了 findAgent 反而看不到）。所以这里**不注入** findAgent。
{
    const ack = mkAck();
    let threw = null;
    let r = null;
    try {
        r = deliverSendMessage(mkSocket(ROLE_PANEL, PANEL_TOKEN), 'constructor', { from: 'ADMIN', message: 'x' }, ack);
    } catch (e) { threw = e; }
    check('A7 默认 findAgent 可解析（不注入也不抛 ReferenceError），且原型链键被当成未知 agent',
        threw === null && r?.ok === false && r?.code === 'UNKNOWN_AGENT',
        threw ? String(threw?.message) : JSON.stringify(r));
}

// ── A6：接线断言（改对了还得真的接上）─────────────────────────────────────
{
    const ms = readFileSync(path.join(__dirname, '../src/mindcraft/mindserver.js'), 'utf8');
    const pos = ms.indexOf("socket.on('send-message'");
    const blk = pos === -1 ? '' : ms.slice(pos, pos + 700);
    check('A6 send-message handler 只委托 deliverSendMessage（不再在 handler 里自己 emit）',
        /deliverSendMessage\(socket, agentName, data,/.test(blk) && !/emit\('send-message', data\)/.test(ms),
        blk.slice(0, 90).replace(/\s+/g, ' '));
    check('A6b 交付实现的闸门走 requirePanelRole（判据只有一处，没有第二份实现）',
        /if \(!gate\(socket, 'send-message'/.test(ms)
        && /deps\.gate \?\? \(\(s, ev, cb\) => requirePanelRole\(s, ev, cb\)\)/.test(ms));
    check('A6c bot 之间的通信用的是 chat-message（发送者由服务端按通道绑定填），不是 send-message',
        /socket\.on\('chat-message'/.test(ms) && /target\.socket\.emit\('chat-message', curAgentName, json\)/.test(ms));
}

// ════════════════════════════════════════════════════════════════════════════
// B. P2-5：销毁 bot 之后旧 token 必须失效（且已建连接一起失效、登记表不再只增）
// ════════════════════════════════════════════════════════════════════════════
clearCredentials();   // 本文件自成一个进程：先清空，后面的断言只看自己造的数据

{
    const token = 'tok-single-revoke-0001';
    registerCredential(token, ROLE_AGENT, 'botP5a');
    check('B1 登记过的 bot 凭据 ⇒ 角色 agent',
        credentialRole({ auth: { token } }, PANEL_TOKEN) === ROLE_AGENT);
    const before = credentialCount();
    check('B1b revokeCredential(token) 真的删掉了这一条（新增的单条撤销 API）',
        revokeCredential(token) === true && credentialCount() === before - 1);
    check('B1c 撤销之后同一份 token 再也认不出来（握手门会按未授权拒）',
        credentialRole({ auth: { token } }, PANEL_TOKEN) === null);
    check('B1d 重复撤销是幂等的（不抛、不误删别人）', revokeCredential(token) === false);
    check('B1e 撤销单条**动不到**面板凭据（面板仍能过门，控制面不会自锁）',
        credentialRole({ auth: { token: PANEL_TOKEN } }, PANEL_TOKEN) === ROLE_PANEL);
}

{
    const t1 = issueAgentToken('botP5b');
    const roleBefore = credentialRole({ auth: { token: t1 } }, PANEL_TOKEN);
    const cred = revokeAgentTokenByName('botP5b');            // = 销毁流程里的那一步
    const t2 = issueAgentToken('botP5b');                     // 同名重建
    check('B2 同名重建后新 token 可用（重建这条路没被堵死）',
        credentialRole({ auth: { token: t2 } }, PANEL_TOKEN) === ROLE_AGENT && credentialAgent(t2) === 'botP5b');
    check('B2b ★ 同名重建后**旧 token 仍被拒**（撤销不可逆，重建不会把旧凭据复活）',
        roleBefore === ROLE_AGENT && credentialRole({ auth: { token: t1 } }, PANEL_TOKEN) === null);
    check('B2c 撤销结果如实上报（revoked:true）', cred.revoked === true, JSON.stringify(cred));
    revokeAgentTokenByName('botP5b');
}

{
    const t = issueAgentToken('botP5c');
    const other = issueAgentToken('botP5d');
    const sOld = mkSocket(ROLE_AGENT, t);
    const sOther = mkSocket(ROLE_AGENT, other);
    const r = revokeAgentToken(t, [sOld, sOther]);
    check('B3 ★ 撤销时把**已建立**的连接一起断掉（不是只挡下一次握手）',
        r.revoked === true && r.dropped === 1 && sOld.disconnected === true, JSON.stringify({ r, d: sOld.disconnected }));
    check('B3b 被撤销的连接后续事件一律被拒（revoked 戳 ⇒ 角色未知 ⇒ 管理面事件全拒）',
        socketRole(sOld) === null && requirePanelRole(sOld, 'sec-review', () => {}) === false);
    check('B3c 别人的连接不受影响（撤销是按 token 精确匹配的）',
        sOther.disconnected === false && socketRole(sOther) === ROLE_AGENT);
    check('B3d 撤销后凭据不再可认证', credentialRole({ auth: { token: t } }, PANEL_TOKEN) === null);
    check('B3e invalidateAgentSocket 对 null 不抛（下线中的 socket 不该打挂控制面）',
        invalidateAgentSocket(null) === false);
    revokeAgentTokenByName('botP5d');
}

/** 假 AgentProcess：stopAndWait 返回已决的 Promise（不真起进程）。 */
const fakeAP = (stopResult) => ({
    running: true,
    process: { pid: 1 },
    count_id: 0,
    stop() { return { exited: false, sent: true, reason: 'sent-sigint' }; },
    stopAndWait() { return Promise.resolve(stopResult); },
});

{
    const t = issueAgentToken('botP5e');
    mindcraft.__test.set('botP5e', fakeAP({ exited: true, escalated: false, reason: 'graceful' }));
    const r = await mindcraft.destroyAgent('botP5e');
    check('B4 ★ destroyAgent 确认退出后撤凭据（旧 token 立刻失效）',
        r.ok === true && r.credential?.revoked === true
        && credentialRole({ auth: { token: t } }, PANEL_TOKEN) === null, JSON.stringify(r.credential));

    const baseline = credentialCount();
    for (let i = 0; i < 5; i++) {
        issueAgentToken('botP5f');
        mindcraft.__test.set('botP5f', fakeAP({ exited: true, escalated: false, reason: 'graceful' }));
        await mindcraft.destroyAgent('botP5f');
    }
    check('B4b 反复 create/destroy 5 轮后登记表**不增长**（原来只增不减）',
        credentialCount() === baseline, `baseline=${baseline}, now=${credentialCount()}`);
}

{
    const t = issueAgentToken('botP5g');
    mindcraft.__test.set('botP5g', fakeAP({ exited: false, escalated: true, reason: 'still-alive' }));
    const r = await mindcraft.destroyAgent('botP5g');
    check('B5 未确认退出 ⇒ **不撤**凭据（否则还在跑的那个进程会立刻失联，孤儿问题反而更糟）',
        r.ok === false && credentialRole({ auth: { token: t } }, PANEL_TOKEN) === ROLE_AGENT);
    mindcraft.__test.remove('botP5g');
    revokeAgentTokenByName('botP5g');
}

{
    const t = issueAgentToken('botP5h');
    const r = await mindcraft.destroyAgent('botP5h');       // 没有进程条目（createAgent 失败路径/自杀残留）
    check('B6 没有进程条目也撤残留凭据（幂等；createAgent 的失败路径会走到这里）',
        r.ok === true && r.removed === false && r.credential?.revoked === true
        && credentialRole({ auth: { token: t } }, PANEL_TOKEN) === null);
}

{
    const mc = readFileSync(path.join(__dirname, '../src/mindcraft/mindcraft.js'), 'utf8');
    const at = readFileSync(path.join(__dirname, '../src/mindcraft/auth_gate.js'), 'utf8');
    check('B7 接线：撤销发生在 `delete agent_processes[...]` **之后**（先确认退出，再撤凭据）',
        /delete agent_processes\[agentName\][\s\S]{0,700}?revokeAgentTokenByName\(agentName\)/.test(mc));
    check('B7b 接线：mindcraft 从 mindserver 取撤销入口（不是自己再造一份登记表）',
        /revokeAgentTokenByName/.test(mc) && /from '\.\/mindserver\.js'/.test(mc));
    check('B7c 撤销是**单条** API（auth_gate.revokeCredential 按 token 删），不是整体清空',
        /export function revokeCredential\(token\)/.test(at) && /revokeCredential\(token\)/.test(at));
}

// ════════════════════════════════════════════════════════════════════════════
// C. P2-6：get-profile / get-profiles 只给面板
// ════════════════════════════════════════════════════════════════════════════
{
    const dir = mkdtempSync(path.join(tmpdir(), 'sec-review-profiles-'));
    writeFileSync(path.join(dir, 'alpha.json'),
        JSON.stringify({ name: 'alpha', api: 'openai', model: 'gpt-x', permissions: { owners: ['ServerOwner'] } }), 'utf8');
    writeFileSync(path.join(dir, 'beta.json'), JSON.stringify({ name: 'beta', api: 'anthropic' }), 'utf8');
    try {
        // ── agent 凭据：两个入口都拒，且一个字都没回 ──
        const agentSock = mkSocket(ROLE_AGENT, AGENT_TOKEN);
        let gotList = null;
        const r1 = readProfilesList(agentSock, (p) => { gotList = p; }, { dir });
        check('C1 ★ agent 凭据 get-profiles ⇒ 拒（PANEL_ONLY），且没回任何 profile 元数据',
            r1.ok === false && r1.code === 'PANEL_ONLY' && gotList?.ok === false
            && gotList?.code === 'PANEL_ONLY' && gotList?.profiles === undefined, JSON.stringify(gotList));

        let gotOne = null;
        const r2 = readProfileFile(agentSock, 'alpha.json', (p) => { gotOne = p; }, { dir });
        check('C1b ★ agent 凭据 get-profile ⇒ 拒，且拿不到 raw（原文含 api/model/owner 名单）',
            r2.ok === false && r2.code === 'PANEL_ONLY' && gotOne?.raw === undefined && gotOne?.json === undefined,
            JSON.stringify(gotOne));

        // ── 面板：照常可用（不能因为加门就把配置向导锁死）──
        let list = null;
        const r3 = readProfilesList(mkSocket(ROLE_PANEL, PANEL_TOKEN), (p) => { list = p; }, { dir });
        check('C2 面板 ⇒ 准：拿到 2 个 profile 的元数据',
            r3.ok === true && list?.ok === true && list?.profiles?.length === 2, JSON.stringify(list?.profiles?.map((p) => p.file)));
        check('C2b 列表只回相对名（F-WEB-204：不泄漏本机绝对路径）',
            (list?.profiles ?? []).every((p) => typeof p.path === 'string' && p.path === path.basename(p.path))
            && !String(list?.dir ?? '').includes(path.sep));

        let one = null;
        const r4 = readProfileFile(mkSocket(ROLE_PANEL, PANEL_TOKEN), 'alpha.json', (p) => { one = p; }, { dir });
        check('C3 面板 ⇒ 准：读到原文 + 解析结果（配置向导要用）',
            r4.ok === true && typeof one?.raw === 'string' && one?.json?.name === 'alpha');

        let missing = null;
        readProfileFile(mkSocket(ROLE_PANEL, PANEL_TOKEN), 'nope.json', (p) => { missing = p; }, { dir });
        check('C4 不存在的 profile ⇒ 回 reason（不抛，不打挂控制面）',
            missing?.ok === false && /不存在/.test(String(missing?.reason)));

        let trav = null;
        readProfileFile(mkSocket(ROLE_PANEL, PANEL_TOKEN), '../../package.json', (p) => { trav = p; }, { dir });
        check('C5 目录穿越仍被 basename 挡掉（拿不到 profiles 之外的文件）',
            trav?.ok === false, JSON.stringify(trav));

        // 默认目录也要能算出来（同 A7：抽到模块级后默认值不能指向闭包变量）
        let realList = null;
        let threwDefault = null;
        try {
            readProfilesList(mkSocket(ROLE_PANEL, PANEL_TOKEN), (p) => { realList = p; });
        } catch (e) { threwDefault = e; }
        check('C7 默认 profiles 目录可解析（不注入 dir 也不抛），面板照常拿到回执',
            threwDefault === null && realList !== null && typeof realList?.ok === 'boolean',
            threwDefault ? String(threwDefault?.message) : JSON.stringify(realList?.ok));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

{
    const ms = readFileSync(path.join(__dirname, '../src/mindcraft/mindserver.js'), 'utf8');
    check('C6 接线：get-profiles / get-profile 两个 handler 都委托到模块级实现（判据在其中）',
        /socket\.on\('get-profiles', \(callback\) => \{\s*readProfilesList\(socket, callback\);/.test(ms)
        && /socket\.on\('get-profile', \(file, callback\) => \{\s*readProfileFile\(socket, file, callback\);/.test(ms));
    check('C6b 两个入口的闸门都走 requirePanelRole（不是各写一份 `role === panel` 判据）',
        (ms.match(/deps\.gate \?\? \(\(s, ev, cb\) => requirePanelRole\(s, ev, cb\)\)/g) || []).length >= 3,
        `matches=${(ms.match(/deps\.gate \?\? \(\(s, ev, cb\) => requirePanelRole\(s, ev, cb\)\)/g) || []).length}`);
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
