/**
 * t7：面板**只读**入口 `events:since` / `events:stats` —— 离线单测（真 sqlite，不连 socket）。
 *
 * 为什么要这一层：`global_store.sinceEvents` / `statsByKind` 实现齐全但**零生产调用方**，
 * 面板的 events 视图一直是死路。本批把两个只读事件接上控制面，本文件钉死它们的边界：
 *
 *   A. `limit` 归一（缺省 200 / 超上限夹到 500 / 非正整数 ⇒ limit-invalid）
 *   B. **两种游标语义不同**（number = `at >= since` 宁重不漏；`{at,id}` = 严格 `>`，同毫秒也不漏）
 *   C. 参数错误**翻成 reason，绝不抛**（global_store 读侧是直接 throw 的）
 *   D. 非面板连接 ⇒ 拒
 *   E. **只读**：`readOnly:true` 真的传下去、只读句柄 INSERT 被拒、回执不漏句柄
 *   F. `payload_json` 解析失败 ⇒ `payload:null`（不抛、不假装成 `{}`）
 *   G. `stats` 形状与排序、失败翻 `internal`
 *   H. 接线（源码断言）：两个事件经 `fedOn` 注册（闸门 + 独立限流桶），且形参不叫 `ctx`
 *      （叫 `ctx` 会被 `deps_injection_audit` 的 A 档误报成"生产走不到的死分支"）
 *
 * ⚠ 边界：本文件**直调处理函数**，不是真 socket 通路（真 socket 归 t5 真机 E2E）。
 * 输出：PASS/FAIL 逐条，全过退出码 0。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    readEventsSince, readEventsStats, normalizeEventsLimit, requirePanelRole,
    EVENTS_LIMIT_DEFAULT, EVENTS_LIMIT_MAX,
} from '../src/mindcraft/mindserver.js';
import { recordEvent, closeGlobalDb, openGlobalDb } from '../src/mindcraft/global_store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
const realLog = console.log;
const realWarn = console.warn;
const logs = [];
const warns = [];
console.log = (...a) => { logs.push(a.map(String).join(' ')); };
console.warn = (...a) => { warns.push(a.map(String).join(' ')); };
const clearLogs = () => { logs.length = 0; warns.length = 0; };
const check = (name, cond, detail = '') => {
    if (cond) { pass++; realLog(`PASS ${name}${detail ? '   ' + detail : ''}`); }
    else { fail++; realLog(`FAIL ${name}${detail ? '   ' + detail : ''}`); }
};
const mkSocket = (role) => {
    const emitted = [];
    return { emitted, data: role ? { role } : undefined, emit: (ev, payload) => emitted.push([ev, payload]) };
};

// ════════════════════════════════════════════════════════════════════════════
// A. limit 归一
// ════════════════════════════════════════════════════════════════════════════
{
    check('A1 常量：默认 200 / 上限 500（事件表只增不减，面板不许一次拉全表）',
        EVENTS_LIMIT_DEFAULT === 200 && EVENTS_LIMIT_MAX === 500,
        `default=${EVENTS_LIMIT_DEFAULT} max=${EVENTS_LIMIT_MAX}`);
    check('A2 不传 limit ⇒ 默认 200', normalizeEventsLimit(undefined).limit === 200
        && normalizeEventsLimit(null).limit === 200 && normalizeEventsLimit('').limit === 200);
    check('A3 超上限 ⇒ **夹到 500**（不是报错：面板按"满页=可能还有"翻页）',
        normalizeEventsLimit(9999).limit === 500 && normalizeEventsLimit(501).limit === 500);
    check('A4 边界 500 原样通过', normalizeEventsLimit(500).limit === 500);
    check('A5 数字字符串按数字处理（"50" ⇒ 50，与 Number() 口径一致）', normalizeEventsLimit('50').limit === 50);
    check('A6 0 / 负数 / 非数字 ⇒ limit-invalid',
        normalizeEventsLimit(0).reason === 'limit-invalid'
        && normalizeEventsLimit(-5).reason === 'limit-invalid'
        && normalizeEventsLimit('abc').reason === 'limit-invalid');
}

// ════════════════════════════════════════════════════════════════════════════
// D. 非面板连接 ⇒ 拒（闸门与联邦那批同一份实现）
// ════════════════════════════════════════════════════════════════════════════
{
    let got = null;
    const ok = requirePanelRole(mkSocket('agent'), 'events:since', (p) => { got = p; });
    check('D1 agent 连接 ⇒ 拒 + reason=panel_only（events 也是管理面只读）',
        ok === false && got?.reason === 'panel_only' && got?.role === 'agent', JSON.stringify(got));
    let got2 = null;
    check('D2 拿不到角色 ⇒ 拒', requirePanelRole(mkSocket(null), 'events:stats', (p) => { got2 = p; }) === false
        && got2?.role === 'unknown');
    check('D3 面板角色 ⇒ 放行', requirePanelRole(mkSocket('panel'), 'events:since', () => { }) === true);
}

// ════════════════════════════════════════════════════════════════════════════
// B/C/F/G. 真库行为（临时 bots 根，各进程各自一库）
// ════════════════════════════════════════════════════════════════════════════
const ROOT = mkdtempSync(path.join(tmpdir(), 'wire-events-'));
{
    const prevRoot = process.env.MC_BOTS_ROOT;
    process.env.MC_BOTS_ROOT = path.join(ROOT, 'bots');
    clearLogs();
    try {
        // 三条事件：两条同一毫秒（用来证两种游标语义不同），一条更晚
        const w = 'w-20261113-events01';
        recordEvent('team.join', { teamId: 'tm1' }, { id: 'ev-a', at: 1000, worldId: w, avatarId: 'bot1' });
        recordEvent('chat.say', { text: 'hi' }, { id: 'ev-b', at: 1000, avatarId: 'bot1', sourceIp: '127.0.0.1' });
        recordEvent('chat.say', { text: 'later' }, { id: 'ev-c', at: 2000, avatarId: 'bot1' });

        // ── B. 两种游标语义 ──
        const all = readEventsSince({ since: 0 });
        check('B1 since=0 ⇒ 全取到 3 条，按 at/id 升序',
            all.ok === true && all.count === 3 && all.events.map((e) => e.id).join(',') === 'ev-a,ev-b,ev-c',
            all.events.map((e) => `${e.id}@${e.at}`).join(','));

        check('B2 行形状只有面板约定的 6 个字段（不把 payloadOk/sourceIp 塞给面板）',
            Object.keys(all.events[0]).sort().join(',') === 'at,avatarId,id,kind,payload,worldId',
            Object.keys(all.events[0]).join(','));

        // number 游标 = `at >= since`（宁重不漏，含边界）⇒ 同毫秒两条都回来
        const byNumber = readEventsSince({ since: 1000 });
        check('B3 number 游标 `at >= since`：含边界（1000 那两条都回来）—— 宁重不漏',
            byNumber.count === 3, `count=${byNumber.count}`);

        // {at,id} 游标 = 严格 `>`：同毫秒也只取 id 更大的那条
        const byTuple = readEventsSince({ since: { at: 1000, id: 'ev-a' } });
        check('B4 {at,id} 游标严格 `>`：游标那行排除、同毫秒的 ev-b 仍回来（同毫秒也不漏）',
            byTuple.count === 2 && byTuple.events.map((e) => e.id).join(',') === 'ev-b,ev-c',
            byTuple.events.map((e) => e.id).join(','));

        const tupleLast = readEventsSince({ since: { at: 2000, id: 'ev-c' } });
        check('B5 游标指向最后一条 ⇒ 空结果（不是"把最后一条再给一次"）', tupleLast.count === 0);

        check('B6 payload 是**解析后的对象**（不二次 JSON 序列化）',
            typeof all.events[0].payload === 'object' && all.events[0].payload !== null
            && all.events[0].payload.teamId === 'tm1');

        // kind 过滤
        const onlyChat = readEventsSince({ since: 0, kind: 'chat.say' });
        check('B7 kind 过滤生效（只回 chat.say 两条）', onlyChat.count === 2
            && onlyChat.events.every((e) => e.kind === 'chat.say'));

        // worldId 过滤（面板可带）
        const onlyWorld = readEventsSince({ since: 0, worldId: w });
        check('B8 worldId 过滤生效（只回该存档那条）', onlyWorld.count === 1 && onlyWorld.events[0].worldId === w);

        // limit 真的生效（并回执里带回生效值）
        const limited = readEventsSince({ since: 0, limit: 2 });
        check('B9 limit 生效且回执带**生效值**（面板据此判"满页=可能还有"）',
            limited.count === 2 && limited.limit === 2);
        check('B10 limit 超上限被夹到 500', readEventsSince({ since: 0, limit: 99999 }).limit === 500);

        // ── C. 参数错误：翻成 reason，绝不抛 ──
        let threw = false;
        let rSince = null;
        let rKind = null;
        let rLimit = null;
        try {
            rSince = readEventsSince({ since: -1 });
            rKind = readEventsSince({ since: 0, kind: 'nope.not-a-kind' });
            rLimit = readEventsSince({ since: 0, limit: 0 });
        } catch { threw = true; }
        check('C1 ★ 非法参数**不抛**（global_store 读侧是直接 throw 的，必须在 handler 里翻）', threw === false);
        check('C2 since=-1 ⇒ reason:since-invalid', rSince?.ok === false && rSince.reason === 'since-invalid');
        check('C3 since="abc" ⇒ reason:since-invalid',
            readEventsSince({ since: 'abc' }).reason === 'since-invalid');
        check('C4 未注册 kind ⇒ reason:kind-invalid', rKind?.ok === false && rKind.reason === 'kind-invalid');
        check('C5 limit=0 ⇒ reason:limit-invalid（不是静默退默认值）', rLimit?.ok === false && rLimit.reason === 'limit-invalid');
        check('C6 每种拒绝都留了一行日志（面板能解释，也便于排障）',
            warns.join('\n').includes('since-invalid') && warns.join('\n').includes('kind-invalid'));

        // 实现层抛错也要翻（不只依赖参数预检）
        const throwing = (code) => ({
            sinceEvents: () => { const e = new Error('impl boom'); e.code = code; throw e; },
        });
        let threw2 = false;
        let t1 = null;
        let t2 = null;
        try {
            t1 = readEventsSince({ since: 0 }, {}, throwing('SINCE_INVALID'));
            t2 = readEventsSince({ since: 0 }, {}, throwing('KIND_INVALID'));
        } catch { threw2 = true; }
        check('C7 实现抛 SINCE_INVALID/KIND_INVALID ⇒ 仍翻成 reason（不冒泡到 socket.io）',
            threw2 === false && t1?.reason === 'since-invalid' && t2?.reason === 'kind-invalid');
        check('C8 未知异常 ⇒ reason:internal（面板至少知道"服务端炸了"，而不是 ack 超时）',
            readEventsSince({ since: 0 }, {}, { sinceEvents: () => { throw new Error('disk'); } }).reason === 'internal');

        // ── E. 只读 ──
        let seenOpts = null;
        readEventsSince({ since: 0, kind: 'chat.say', limit: 10 }, {}, {
            sinceEvents: (since, opts) => { seenOpts = opts; return []; },
        });
        check('E1 ★ readOnly:true 真的传下去（面板绝不能拿到写能力）',
            seenOpts?.readOnly === true && seenOpts?.limit === 10 && seenOpts?.kind === 'chat.say');
        let seenStats = null;
        readEventsStats({}, {}, { statsByKind: (opts) => { seenStats = opts; return []; } });
        check('E1b stats 同样只读', seenStats?.readOnly === true);

        let insertBlocked = false;
        const h = openGlobalDb({ readOnly: true });
        try {
            h.db.prepare("INSERT INTO events(id, world_id, avatar_id, kind, payload_json, at, source_ip) VALUES('ev-x',NULL,NULL,'chat.say','{}',1,NULL)").run();
        } catch { insertBlocked = true; }
        finally { try { h.db.close(); } catch { /* 关不掉不影响结论 */ } }
        check('E2 只读句柄上 INSERT 被 SQLite 直接拒（SQLITE_READONLY）', insertBlocked);

        const out = readEventsSince({ since: 0 });
        check('E3 回执里不泄漏任何句柄/连接（只有 ok/events/count/limit）',
            Object.keys(out).every((k) => ['ok', 'events', 'count', 'limit'].includes(k)),
            Object.keys(out).join(','));

        // ── F. 坏 payload_json ──
        // events 是追加写（触发器只禁 UPDATE/DELETE），INSERT 一条坏 JSON 模拟"历史里已有脏行"
        openGlobalDb().db.prepare(
            "INSERT INTO events(id, world_id, avatar_id, kind, payload_json, at, source_ip) VALUES('ev-bad',NULL,NULL,'chat.say','{not-json',3000,NULL)",
        ).run();
        let badThrew = false;
        let badRow = null;
        try {
            badRow = readEventsSince({ since: 3000 }).events.find((e) => e.id === 'ev-bad');
        } catch { badThrew = true; }
        check('F1 ★ payload_json 解析失败 ⇒ payload:null（不抛、不假装成 {}）',
            badThrew === false && badRow !== undefined && badRow.payload === null);

        // F2 让 handler 的 `?? null` **承重**：global_store 解析失败时给 payload:undefined（不是 null），
        //    只有 handler 兜底了才会变成 null —— 否则面板会拿到 undefined（JSON 里直接消失）。
        let undef = null;
        try {
            undef = readEventsSince({ since: 0 }, {}, {
                sinceEvents: () => [{
                    id: 'ev-u', worldId: null, avatarId: null, kind: 'chat.say',
                    payload: undefined, payloadOk: false, at: 1, sourceIp: null,
                }],
            });
        } catch { undef = 'threw'; }
        check('F2 payload 为 undefined 时兜底成 null（面板看到 null，不是字段消失）',
            undef !== 'threw' && undef.events[0].payload === null, JSON.stringify(undef?.events?.[0]));

        // ── G. stats ──
        const st = readEventsStats({});
        check('G1 ok + kinds 是数组', st.ok === true && Array.isArray(st.kinds));
        check('G2 每行形状 = {kind,count,firstAt,lastAt}（面板下拉直接用）',
            st.kinds.every((k) => Object.keys(k).sort().join(',') === 'count,firstAt,kind,lastAt'),
            JSON.stringify(st.kinds[0]));
        const chat = st.kinds.find((k) => k.kind === 'chat.say');
        check('G3 计数与首末时间对得上（chat.say 3 条：1000/2000/3000）',
            chat && chat.count === 3 && chat.firstAt === 1000 && chat.lastAt === 3000, JSON.stringify(chat));
        check('G4 按 count 降序（chat.say 3 条在 team.join 1 条前面）',
            st.kinds[0].kind === 'chat.say' && st.kinds[st.kinds.length - 1].kind === 'team.join',
            st.kinds.map((k) => `${k.kind}:${k.count}`).join(','));
        check('G5 带 worldId 时只看那一档', readEventsStats({ worldId: w }).kinds.every((k) => k.kind === 'team.join'),
            JSON.stringify(readEventsStats({ worldId: w }).kinds));
        check('G6 stats 实现抛错 ⇒ reason:internal（不冒泡）',
            readEventsStats({}, {}, { statsByKind: () => { throw new Error('boom'); } }).reason === 'internal');
    } catch (e) {
        check('B/C/E/F/G 真库段没有抛异常', false, String(e?.message ?? e));
    } finally {
        closeGlobalDb();
        process.env.MC_BOTS_ROOT = prevRoot;
    }
}

// ════════════════════════════════════════════════════════════════════════════
// H. 接线（源码断言）：防"函数改对了但没人调用"
// ════════════════════════════════════════════════════════════════════════════
{
    const ms = readFileSync(path.join(__dirname, '../src/mindcraft/mindserver.js'), 'utf8');
    check('H1 两个只读事件真的注册了，且都走 fedOn（闸门 + 独立限流桶 + 异常兜底）',
        /fedOn\('events:since',\s*30,\s*readEventsSince\)/.test(ms)
        && /fedOn\('events:stats',\s*20,\s*readEventsStats\)/.test(ms));
    const iStatus = ms.indexOf("fedOn('federation-status'");
    const iSince = ms.indexOf("fedOn('events:since'");
    check('H2 紧跟在 federation-status 那批之后（同一段、同一个包装）',
        iStatus > 0 && iSince > iStatus, `status=${iStatus} since=${iSince}`);
    check('H3 ★ 形参不叫 ctx（叫 ctx 会被 deps_injection_audit 的 A 档误报成死分支）',
        !/function readEvents(?:Since|Stats)\([^)]*\bctx\b/.test(ms)
        && /function readEventsSince\(input, evCtx = \{\}, api = EVENTS_READ_API\)/.test(ms));
    check('H4 ★ mindserver 根本不 import openGlobalDb ⇒ 结构上拿不到句柄（readOnly 由 global_store 用完即关）',
        !/openGlobalDb/.test(ms.replace(/^\s*\/\/.*$/gm, '')));
}

// ════════════════════════════════════════════════════════════════════════════
// 清理
// ════════════════════════════════════════════════════════════════════════════
closeGlobalDb();
let cleaned = true;
try { rmSync(ROOT, { recursive: true, force: true }); } catch { cleaned = false; }

console.warn = realWarn;
console.log = realLog;
check('J1 临时目录清理完成（Windows 上句柄没关会 EPERM）', cleaned || !existsSync(ROOT));
realLog(`\n合计：${pass} 通过 / ${fail} 失败（模块日志：log ${logs.length} / warn ${warns.length}）`);
if (fail) realLog('FAILED');
process.exit(fail ? 1 : 0);
