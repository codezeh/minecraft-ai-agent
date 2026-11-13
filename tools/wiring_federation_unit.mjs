/**
 * 阶段 4 联邦 / 身份事件 / CoreProtect 体检 / isVisitor —— **mindserver 接线**（R6 fixes4 · t1）。
 *
 * 钉死的是什么（都是"实现了但生产不可达"那一族的反面）：
 *   A. 面板闸门：拿不到 `role==='panel'` 就**拒**（agent / 未知角色一个都不放）；
 *   B. ★ **token 不出日志**：签发回执里有、日志里一个字都没有（捕获 log/warn/error 全量断言）；
 *   C. 拒绝必须带**原因**（bad-signature / pubkey-mismatch / stale-card / unknown-grant / ttl-invalid …）；
 *   D. events 是**旁路**：写失败 / 记录器抛错都**不影响主流程**（返回值不参与业务判断）；
 *   E. 面板只读视图**脱敏**：grants 不含 token/hash、对端不含公钥；
 *   F. 实现抛错翻成 `reason:'internal'`，不许把异常抛进 socket.io 回调；
 *   G. **接线**（源码断言）：8 个事件真的注册了、都过闸门、各自限流桶、isVisitor 真的注入、
 *      身份事件真的写、CP 体检真的调 —— 防"函数改对了但没人调用"；
 *   H. **真模块可达性**：用真 `federation.js` + 真 `_global` 库 + 真 Ed25519 跑一遍
 *      签发 → 预览 → 作废 → 收名片（含三种拒绝）→ 关系增量 → 只读视图，
 *      并断言 **token 明文不落盘**。
 *   I. 来源 IP / 访客接缝：`visitorOf()` 现在恒 false（凭证没接上 ⇒ 没人会被判访客）。
 *
 * ⚠ 本测试**不验**真跨机交换（网络层/证书/时钟），见 docs/audit-r6/fixes4/federation.md §7；
 *   本批**没有接** `identity.claim`（游戏内 `!claim` 在 agent 子进程核销，mindserver 没有收口点），
 *   缺口与下一步写在 docs/audit-r6/fixes4/wiring-control.md。
 *
 * 输出：PASS/FAIL 逐条，全过退出码 0（unit_all 按 PASS 行数判"真的跑了用例"）。
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    sourceIpOf, requirePanelRole, visitorOf, VISITOR_JUDGEMENT_WIRED,
    recordIdentityEvent, sanitizeGrantRow, safeFederationCall, normalizeEmitArgs,
    federationIssueGrant, federationRevokeGrant, federationListGrants,
    federationAcceptCard, federationListCards, federationRelationsSince,
    federationRelationsPush, federationStatus,
} from '../src/mindcraft/mindserver.js';
import { closeGlobalDb, countEvents } from '../src/mindcraft/global_store.js';
import { signPeerCard } from '../src/mindcraft/federation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
const realLog = console.log;
const realWarn = console.warn;
const realErr = console.error;
/**
 * 收走模块日志：B 段要断言"**日志里没有 token**" —— 所以 console.log 也必须被捕获
 * （只捕 warn/error 的话，`console.log(token)` 这种最直接的泄漏会看不见）。
 */
const logs = [];
const warns = [];
const errs = [];
console.log = (...a) => { logs.push(a.map(String).join(' ')); };
console.warn = (...a) => { warns.push(a.map(String).join(' ')); };
console.error = (...a) => { errs.push(a.map(String).join(' ')); };
const clearLogs = () => { logs.length = 0; warns.length = 0; errs.length = 0; };
const allLogText = () => [...logs, ...warns, ...errs].join('\n');
const check = (name, cond, detail = '') => {
    if (cond) { pass++; realLog(`PASS ${name}${detail ? '   ' + detail : ''}`); }
    else { fail++; realLog(`FAIL ${name}${detail ? '   ' + detail : ''}`); }
};

/** 假 socket：只提供 socketRole() 看的 `data.role` 与 emit 收集器。 */
const mkSocket = (role) => {
    const emitted = [];
    return { emitted, data: role ? { role } : undefined, emit: (ev, payload) => emitted.push([ev, payload]) };
};

// ════════════════════════════════════════════════════════════════════════════
// A. 面板闸门：拿不到面板角色 ⇒ 拒
// ════════════════════════════════════════════════════════════════════════════
{
    let acked = 'unset';
    const panel = mkSocket('panel');
    const okPanel = requirePanelRole(panel, 'federation:grant-issue', (p) => { acked = p; });
    check('A1 面板角色 ⇒ 放行（且不回 control-denied）',
        okPanel === true && acked === 'unset' && panel.emitted.length === 0, `acked=${JSON.stringify(acked)}`);

    const agentSock = mkSocket('agent');
    let a2 = null;
    const okAgent = requirePanelRole(agentSock, 'federation:grant-issue', (p) => { a2 = p; });
    check('A2 ★ agent 角色 ⇒ 拒，并回 reason=panel_only + 当前角色',
        okAgent === false && a2?.ok === false && a2?.reason === 'panel_only' && a2?.role === 'agent',
        JSON.stringify(a2));
    check('A2b 拒绝的同时发 control-denied（面板能解释"这次为什么没生效"）',
        agentSock.emitted.some(([ev, p]) => ev === 'control-denied' && p?.reason === 'panel_only'));

    const anon = mkSocket(null);
    let a3 = null;
    const okAnon = requirePanelRole(anon, 'federation-status', (p) => { a3 = p; });
    check('A3 拿不到角色（null）⇒ 拒：管理面必须**明确证明**自己是面板',
        okAnon === false && a3?.ok === false && a3?.role === 'unknown', JSON.stringify(a3));

    let threw = false;
    try { requirePanelRole(mkSocket('agent'), 'x'); } catch { threw = true; }
    check('A4 没传 ack 也不炸（裸 emit 不许打挂控制面）', threw === false);
}

// ════════════════════════════════════════════════════════════════════════════
// B. ★ token 只在回执里，不进日志
// ════════════════════════════════════════════════════════════════════════════
const SECRET_TOKEN = 'SEKRIT-TOKEN-MUST-NOT-BE-LOGGED-0123456789';
{
    const api = {
        issueVisitGrant: () => ({
            ok: true, grantId: 'vg-log-1', token: SECRET_TOKEN, idempotent: false, expiresAt: 111, maxUses: 1,
        }),
    };
    clearLogs();
    const r = federationIssueGrant({ hostId: 'hostA', guestId: 'guestB' }, { sourceIp: '127.0.0.1' }, api);
    check('B1 签发回执里**有** token（面板只在这一次能看到）', r.ok === true && r.token === SECRET_TOKEN);
    check('B2 ★ token 不出现在任何日志里（log/warn/error 全捕）', !allLogText().includes(SECRET_TOKEN),
        allLogText().slice(0, 120));
    check('B3 但排障信息还在：日志里有 grantId', allLogText().includes('vg-log-1'), allLogText().slice(0, 120));

    clearLogs();
    const i2 = federationIssueGrant({ hostId: 'hostA', guestId: 'guestB' }, {}, {
        issueVisitGrant: () => ({
            ok: true, grantId: 'vg-log-1', token: null, idempotent: true, expiresAt: 111, maxUses: 1, usedCount: 1,
        }),
    });
    check('B4 幂等再签：token 回 null（绝不"再吐一个"）', i2.ok === true && i2.token === null && i2.idempotent === true);

    clearLogs();
    const bad = federationIssueGrant({ hostId: 'hostA', guestId: 'guestB' }, {}, {
        issueVisitGrant: () => ({ ok: false, reason: 'ttl-invalid' }),
    });
    check('B5 签发失败回原因（不是只说 ok:false）', bad.ok === false && bad.reason === 'ttl-invalid');
    check('B5b 失败也留一行日志说明原因', allLogText().includes('ttl-invalid'));
}

// ════════════════════════════════════════════════════════════════════════════
// C. 拒绝必须带原因（三个名片判据 + 凭证判据都原样透出）
// ════════════════════════════════════════════════════════════════════════════
{
    const cardReasons = ['bad-signature', 'pubkey-mismatch', 'stale-card'];
    const wrong = cardReasons.filter((reason) => {
        const r = federationAcceptCard({ peerId: 'peer-1' }, {}, {
            acceptPeerCard: () => ({ ok: false, reason, peerId: 'peer-1' }),
        });
        return !(r.ok === false && r.reason === reason && r.peerId === 'peer-1');
    });
    check('C1 名片三种拒绝原因一条不少地回给面板（bad-signature / pubkey-mismatch / stale-card）',
        wrong.length === 0, wrong.join(','));

    const rev = federationRevokeGrant('vg-x', {}, { revokeVisitGrant: () => ({ ok: false, reason: 'unknown-grant' }) });
    check('C2 作废不存在的凭证 ⇒ unknown-grant', rev.ok === false && rev.reason === 'unknown-grant');

    const noReason = federationAcceptCard(null, {}, { acceptPeerCard: () => ({ ok: false }) });
    check('C3 实现没给 reason 时也不许回空对象（占位 unknown，面板能显示"未说明"）',
        noReason.ok === false && noReason.reason === 'unknown', JSON.stringify(noReason));
}

// ════════════════════════════════════════════════════════════════════════════
// D. events 是旁路：写失败 / 抛错都不影响主流程
// ════════════════════════════════════════════════════════════════════════════
{
    clearLogs();
    let threw = false;
    let r1 = null;
    try {
        r1 = recordIdentityEvent('identity.invite', { person: null, avatar: 'bot1' }, {}, () => (
            { ok: false, reason: 'write-failed', detail: 'disk full' }
        ));
    } catch { threw = true; }
    check('D1 落库失败：**不抛**、返回 ok:false + 原因', threw === false && r1?.ok === false && r1?.reason === 'write-failed');
    check('D1b 但必须留日志（静默吞掉 = "看起来记了、实际没记"）',
        allLogText().includes('identity.invite') && allLogText().includes('write-failed'));

    clearLogs();
    let threw2 = false;
    let r2 = null;
    try {
        r2 = recordIdentityEvent('identity.revoke', {}, {}, () => { throw new Error('boom'); });
    } catch { threw2 = true; }
    check('D2 ★ 记录器抛错也不冒泡到业务（events 是最不值钱的东西，不能拖垮最值钱的）',
        threw2 === false && r2?.ok === false && r2?.reason === 'threw');

    clearLogs();
    const r3 = recordIdentityEvent('identity.relink', {}, {}, () => ({ ok: true, id: 'ev-ok-1' }));
    check('D3 正常写入返回 id', r3.ok === true && r3.id === 'ev-ok-1');
    check('D3b 成功时不打日志（不刷屏）', warns.length === 0 && errs.length === 0);
}

// ════════════════════════════════════════════════════════════════════════════
// E. 面板只读视图：脱敏（不含 token / hash / 公钥）
// ════════════════════════════════════════════════════════════════════════════
{
    const leakyGrant = {
        grantId: 'vg-1', hostId: 'h', guestId: 'g', issuedAt: 1, expiresAt: 2, maxUses: 1, usedCount: 0,
        usedAt: null, revokedAt: null, note: 'n',
        token: SECRET_TOKEN, tokenSha256: 'deadbeef', token_sha256: 'deadbeef', secretExtra: 'x',
    };
    const clean = sanitizeGrantRow(leakyGrant);
    check('E1 凭证行是**白名单拷贝**：token/token_sha256/未知字段全部丢掉',
        !('token' in clean) && !('tokenSha256' in clean) && !('token_sha256' in clean) && !('secretExtra' in clean)
        && clean.grantId === 'vg-1' && clean.note === 'n', JSON.stringify(Object.keys(clean)));

    const api = {
        previewVisitGrants: () => [leakyGrant],
        listKnownPeers: () => [{
            peerId: 'peer-1', pubkey: 'BEGIN PUBLIC KEY-----AAA', lastAddr: '1.2.3.4',
            firstSeen: 1, lastSeen: 2, cardSeq: 3, card: { peerId: 'peer-1' },
        }],
        listAllowedPeers: () => [{ peerId: 'peer-2', addedAt: 10, note: '朋友' }],
    };
    const st = federationStatus({}, { sourceIp: '127.0.0.1' }, api);
    const json = JSON.stringify(st);
    check('E2 ★ federation-status 的整串 JSON 里不出现 token / hash / 公钥',
        !/token/i.test(json) && !json.includes(SECRET_TOKEN) && !/pubkey|public key/i.test(json),
        json.slice(0, 160));
    check('E3 三段视图都在（grants / knownPeers / allowedPeers）',
        st.ok === true && st.grants.length === 1 && st.knownPeers.length === 1 && st.allowedPeers.length === 1
        && st.knownPeers[0].peerId === 'peer-1' && st.allowedPeers[0].peerId === 'peer-2');
    check('E4 visitorWired=false（诚实标注：凭证没接上，没人会被判访客）',
        st.visitorWired === false && VISITOR_JUDGEMENT_WIRED === false);
}

// ════════════════════════════════════════════════════════════════════════════
// F. 实现抛错不许抛进 socket.io 回调
// ════════════════════════════════════════════════════════════════════════════
{
    let threw = false;
    let r = null;
    try { r = safeFederationCall('federation:grant-issue', () => { throw new Error('sqlite busy'); }); } catch { threw = true; }
    check('F1 实现抛错 ⇒ {ok:false, reason:internal}，不冒泡（否则客户端只看到 ack 超时）',
        threw === false && r?.ok === false && r.reason === 'internal');
    check('F2 正常返回值原样透传', safeFederationCall('x', () => ({ ok: true, n: 1 })).n === 1);
}

// ════════════════════════════════════════════════════════════════════════════
// K. ack 形状归一（`emit(ev, cb)` 与 `emit(ev, payload, cb)` 两种调用形状）
//    注：这里驱动的是**归一逻辑**，不是真 socket 传输 —— 真 socket.io 的参数传递
//    是否与假设一致，只有真机 E2E 能证（见文档 §12 第 1 条）。
// ════════════════════════════════════════════════════════════════════════════
{
    const fn = () => { };
    const fn2 = () => { };
    const a = normalizeEmitArgs(fn, undefined);
    check('K1 emit(ev, cb)：payload 还原成 undefined、cb 是那个函数',
        a.payload === undefined && a.callback === fn);

    const b = normalizeEmitArgs({ hostId: 'hostA' }, fn);
    check('K2 emit(ev, payload, cb)：两参数原样保留（不许把 payload 当 ack 吞掉）',
        b.payload?.hostId === 'hostA' && b.callback === fn);

    const c = normalizeEmitArgs(undefined, undefined);
    check('K3 两个都不传：不炸，二者皆 undefined', c.payload === undefined && c.callback === undefined);

    const d = normalizeEmitArgs(fn, fn2);
    check('K4 误用（两个函数）：按"第一个函数是 ack"处理，不把函数当 payload 塞进业务',
        d.payload === undefined && d.callback === fn);
}

// ════════════════════════════════════════════════════════════════════════════
// G. 接线（源码断言）：防"函数改对了但没人调用"
// ════════════════════════════════════════════════════════════════════════════
{
    const ms = readFileSync(path.join(__dirname, '../src/mindcraft/mindserver.js'), 'utf8');
    const EVENTS = [
        'federation:grant-issue', 'federation:grant-revoke', 'federation:grant-list',
        'federation:card-accept', 'federation:card-list',
        'federation:relations-since', 'federation:relations-push', 'federation-status',
    ];
    const missing = EVENTS.filter((e) => !new RegExp(`fedOn\\('${e}',\\s*\\d+,`).test(ms));
    check('G1 八个联邦 socket 事件真的注册了（含面板只读的 federation-status）',
        missing.length === 0, missing.length ? `漏: ${missing.join(',')}` : `${EVENTS.length} 个`);

    const i = ms.indexOf('const fedOn = (event, capacity, run) =>');
    const body = i === -1 ? '' : ms.slice(i, i + 900);
    check('G2 联邦事件统一过面板闸门（不是"注册了但谁都能调"）',
        /requirePanel\(event, cb\)/.test(body) && /if \(!requirePanel\(event, cb\)\) return;/.test(body));
    check('G3 每个事件用自己的限流桶（label = 事件名，不共用一个桶）',
        /takeToken\(socket, event, capacity, 60000\)/.test(body));

    check('G4 ★ attachBoardServer 真的注入了 isVisitor（t4 只留了接缝，mindserver 之前没传）',
        /isVisitor:\s*visitorOf\b/.test(ms));
    check('G4b 访客判定恒 false 的那个占位真的存在（不是"看起来接了"）',
        /export function visitorOf\(\) \{\s*return false;\s*\}/.test(ms));

    const idKinds = ["'identity.invite'", "'identity.revoke'", "'identity.recover'", "'identity.relink'"];
    // 判据写窄：必须是**行首的独立调用语句**，且先剥掉行注释。
    // 教训（本仓反复踩）：只判 `includes('recordIdentityEvent(\'identity.invite\'')` 的话，
    // 把它改成 `void 0 && recordIdentityEvent(...)` 或整段注释掉，断言**照样绿** —— 破坏实测抓到了这一点。
    const msCode = ms.replace(/^\s*\/\/.*$/gm, '');
    const missingKinds = idKinds.filter((k) => !new RegExp(`^\\s*recordIdentityEvent\\(${k}`, 'm').test(msCode));
    check('G5 身份变更写 events：invite / revoke / recover / relink 四条路径都接上了（行首独立调用）',
        missingKinds.length === 0, missingKinds.join(','));
    check('G6 events 的返回值**不参与业务判断**（旁路：全文没有 if (!recordIdentityEvent…)）',
        !/if\s*\(\s*!\s*recordIdentityEvent\(/.test(ms) && !/=\s*recordIdentityEvent\(/.test(ms));

    check('G7 启动时调了 coreProtectStatus，且未装时**明说未装**（不静默）',
        /const cp = coreProtectStatus\(\);/.test(ms) && /CoreProtect 未安装\/不可用/.test(ms));
    check('G8 启动体检失败只 warn，不许弄挂启动',
        /CoreProtect 体检失败（不影响启动）/.test(ms));
}

// ════════════════════════════════════════════════════════════════════════════
// H. 真模块可达性：真 federation.js + 真 _global 库 + 真 Ed25519
//    （这一段的失败形态就是"接线断了/导入错了"——正是本批要根除的那个"不可达"）
// ════════════════════════════════════════════════════════════════════════════
const ROOT = mkdtempSync(path.join(tmpdir(), 'wire-fed-'));
{
    const prevRoot = process.env.MC_BOTS_ROOT;
    process.env.MC_BOTS_ROOT = path.join(ROOT, 'bots');
    clearLogs();
    try {
        // ── 凭证：签发 → 预览 → 作废（幂等） ──
        const iss = federationIssueGrant({ hostId: 'hostA', guestId: 'guestB' }, { sourceIp: '::ffff:127.0.0.1' });
        check('H1 生产入口真的能签发凭证（federation.js 不再"实现了但不可达"）',
            iss.ok === true && typeof iss.token === 'string' && iss.token.length >= 20 && iss.grantId);

        const list = federationListGrants({}, {});
        const listJson = JSON.stringify(list);
        check('H2 grant-list 读得到，且响应里没有 token/hash',
            list.ok === true && list.count === 1 && list.grants[0].grantId === iss.grantId && !/token/i.test(listJson),
            listJson.slice(0, 120));

        // token 明文不落盘：先把写句柄关掉（否则 Windows 上读 -wal 可能 EBUSY），再扫 _global 全部文件
        closeGlobalDb();
        const gdir = path.join(ROOT, 'bots', '_global');
        const bytes = readdirSync(gdir)
            .map((f) => readFileSync(path.join(gdir, f)))
            .reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0));
        check('H3 ★ token 明文不落盘（_global 全部文件里都找不到）', !bytes.includes(Buffer.from(iss.token)));

        const rev1 = federationRevokeGrant(iss.grantId, {});
        const rev2 = federationRevokeGrant(iss.grantId, {});
        check('H4 grant-revoke 真的作废，且幂等（第二次 alreadyRevoked=true）',
            rev1.ok === true && rev1.alreadyRevoked === false && rev2.ok === true && rev2.alreadyRevoked === true);

        // ── 名片：真签名 → 收下；篡改 / 换钥 / 旧 seq 三种拒绝 ──
        const keys = () => generateKeyPairSync('ed25519', {
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });
        const k1 = keys();
        const sign = (key, over) => signPeerCard({
            peerId: 'peer-H1', seq: 1, at: Date.now(), addr: '10.0.0.5', caps: ['visit'], ...over,
        }, { pubkey: key.publicKey, privateKeyPem: key.privateKey });
        const c1 = sign(k1, {});
        check('H5 能签出自己的名片（测试前提）', c1.ok === true && typeof c1.card?.sig === 'string');

        const acc = federationAcceptCard(c1.card, { sourceIp: '10.0.0.5' });
        check('H6 收名片走真验签 ⇒ ok，并标出"首次见面"', acc.ok === true && acc.newPeer === true && acc.peerId === 'peer-H1');

        const tampered = federationAcceptCard({ ...c1.card, addr: '6.6.6.6' }, {});
        check('H7 篡改一个字段 ⇒ bad-signature（签名对象是规范 JSON，不依赖键序）',
            tampered.ok === false && tampered.reason === 'bad-signature', tampered.reason);

        const k2 = keys();
        const otherKey = federationAcceptCard(sign(k2, { seq: 2 }).card, {});
        check('H8 同 peerId 换公钥 ⇒ pubkey-mismatch（TOFU 钉扎，换钥须人工 forgetPeer）',
            otherKey.ok === false && otherKey.reason === 'pubkey-mismatch', otherKey.reason);

        const replay = federationAcceptCard(sign(k1, { seq: 1 }).card, {});
        check('H9 旧 seq 重放 ⇒ stale-card', replay.ok === false && replay.reason === 'stale-card', replay.reason);

        const peers = federationListCards({}, {});
        check('H10 card-list 有那只对端，且**不含公钥**',
            peers.ok === true && peers.count === 1 && !/pubkey|public key/i.test(JSON.stringify(peers)));

        // ── 关系增量 ──
        const since = federationRelationsSince({ since: 0 }, {});
        check('H11 relations-since 打通（空库也回 cursor + rows）',
            since.ok === true && Array.isArray(since.rows) && since.count === 0);
        const pushed = federationRelationsPush({
            rows: [{ from: 'a', to: 'b', affinity: 5, tags: ['friend'], updatedAt: 1000 }],
        }, { sourcePeerId: 'peer-H1' });
        check('H12 relations-push 收下对端增量（inserted=1）', pushed.ok === true && pushed.inserted === 1);
        check('H13 空批次被拒 ⇒ no-rows（不许把"什么都没推"报成成功）',
            federationRelationsPush({ rows: [] }, {}).reason === 'no-rows');

        // ── 只读视图 + 审计事件真的落库 ──
        const st = federationStatus({}, {});
        check('H14 federation-status 用真库也能出三段视图、且 visitorWired=false',
            st.ok === true && st.grants.length === 1 && st.knownPeers.length === 1 && st.visitorWired === false);
        check('H15 联邦动作真的写了审计事件（federation.* 落 events 表）',
            countEvents({ kind: 'federation.grant' }) >= 1 && countEvents({ kind: 'federation.peer' }) >= 1,
            `grant=${countEvents({ kind: 'federation.grant' })}, peer=${countEvents({ kind: 'federation.peer' })}`);
    } catch (e) {
        check('H* 真模块可达性段没有抛异常', false, String(e?.message ?? e));
    } finally {
        closeGlobalDb();
        process.env.MC_BOTS_ROOT = prevRoot;
    }
}

// ════════════════════════════════════════════════════════════════════════════
// I. 来源 IP / 访客接缝
// ════════════════════════════════════════════════════════════════════════════
{
    check('I1 ::ffff: 前缀被剥掉（::ffff:127.0.0.1 → 127.0.0.1）',
        sourceIpOf({ handshake: { address: '::ffff:127.0.0.1' } }) === '127.0.0.1');
    check('I2 拿不到地址 ⇒ null（不编一个 0.0.0.0 当来源）',
        sourceIpOf({}) === null && sourceIpOf(null) === null);
    check('I3 visitorOf 现在**恒 false**（凭证没接上 ⇒ 没有任何连接会被判成访客）',
        visitorOf({ socket: {}, bot: 'guestBot', worldId: 'w-1' }) === false && visitorOf() === false);
}

// ════════════════════════════════════════════════════════════════════════════
// 清理（closeGlobalDb 之后再删目录；Windows 上句柄没关会 EPERM）
// ════════════════════════════════════════════════════════════════════════════
closeGlobalDb();
let cleaned = true;
try { rmSync(ROOT, { recursive: true, force: true }); } catch { cleaned = false; }

// 先把控制台还原，再打总结 —— 否则最后几行会被自己的捕获吞掉（"看起来跑完了，其实没输出"）
console.warn = realWarn;
console.error = realErr;
console.log = realLog;

check('J1 临时目录清理完成（Windows 上句柄没关会 EPERM）', cleaned || !existsSync(ROOT));

realLog(`\n合计：${pass} 通过 / ${fail} 失败（模块日志：warn ${warns.length} / error ${errs.length}）`);
if (fail) realLog('FAILED');
process.exit(fail ? 1 : 0);
