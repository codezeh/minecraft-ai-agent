/**
 * `_global` 记忆库（events 追加写 + relations）—— 离线，真 sqlite。
 *
 * 钉死的六件事：
 *   ① 路径形状 `<bots>/_global/mind.sqlite`，幂等建表（user_version 不被反复重写、事件不丢）；
 *   ② **追加写**：没有 update/delete 导出、源码里没有 UPDATE/DELETE events，库层触发器还要再拦一次；
 *   ③ kind **白名单**封闭（未注册 kind 不落库），payload 上限按**字节**算；
 *   ④ 查询口径：时间游标（含边界、宁重不漏）/ `{at,id}` 元组游标 / kind / worldId / limit；
 *   ⑤ relations 绝对写 vs 增量写（delta 在 SQL 里加，tags 不被 delta 抹掉）；
 *   ⑥ 写失败**不抛**给调用方（但必须打日志）；多进程并发写不丢。
 *
 * 输出：PASS/FAIL 逐条，全过退出码 0。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as G from '../src/mindcraft/global_store.js';

let pass = 0;
let fail = 0;
const chk = (n, c, i) => {
    if (c) { pass++; console.log(`  PASS  ${n}${i === undefined ? '' : '   ' + JSON.stringify(i)}`); } else { fail++; console.log(`  FAIL  ${n}   ${JSON.stringify(i)}`); }
};
/** 断言"这行必须抛错"，并可校验错误码（返回抛出的错误，方便继续看 message）。 */
const chkThrow = (n, fn, code) => {
    try {
        const v = fn();
        chk(n, false, { threw: false, returned: v });
        return null;
    } catch (e) {
        chk(n, code == null || e?.code === code, { code: e?.code, message: String(e?.message ?? e).slice(0, 120) });
        return e;
    }
};

/* 收走模块日志：本测试要断言"拒绝/写失败真的打了日志"，同时别把 gate 输出刷满。 */
const warns = [];
const errs = [];
const realWarn = console.warn;
const realErr = console.error;
console.warn = (...a) => { warns.push(a.map(String).join(' ')); };
console.error = (...a) => { errs.push(a.map(String).join(' ')); };

const ROOT = mkdtempSync(join(tmpdir(), 'global-store-test-'));
const BOTS = join(ROOT, 'bots');
const norm = (s) => String(s).replace(/\\/g, '/');
process.env.MC_BOTS_ROOT = BOTS;

const MOD_URL = new URL('../src/mindcraft/global_store.js', import.meta.url);
const MOD = pathToFileURL(fileURLToPath(MOD_URL)).href;
const MOD_SRC = readFileSync(MOD_URL, 'utf8');
/** 去注释后的源码（追加写扫描要看**真代码**，不能被注释里的字眼骗过）。 */
const SRC = MOD_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const count = (re) => (SRC.match(re) || []).length;

/** 世界 id 用一个专属值隔离本节数据，避免前面几节的事件混进查询断言。 */
const W1 = 'w-20261112-aaaaaaaa';
const W2 = 'w-20261112-bbbbbbbb';
const W3 = 'w-20261112-cccccccc';   // ⑥ 专用：隔离查询断言，不受其他小节写入影响

// ══════════════════════════════════════════════════════════════════════════
// ① 路径形状
// ══════════════════════════════════════════════════════════════════════════
console.log('① 路径形状');
chk('GLOBAL_DIR_NAME = _global', G.GLOBAL_DIR_NAME === '_global');
chk('GLOBAL_DB_FILE = mind.sqlite', G.GLOBAL_DB_FILE === 'mind.sqlite');
chk('globalDirOf() = <bots>/_global', norm(G.globalDirOf()) === norm(`${BOTS}/_global`), norm(G.globalDirOf()));
chk('globalDbPathOf() 落在 _global/mind.sqlite', norm(G.globalDbPathOf()) === norm(`${BOTS}/_global/mind.sqlite`),
    norm(G.globalDbPathOf()));
chk('库文件一开始不存在（没有凭空建库）', !existsSync(G.globalDbPathOf()));

// ══════════════════════════════════════════════════════════════════════════
// ② 幂等建表
// ══════════════════════════════════════════════════════════════════════════
console.log('② 幂等建表');
let h = G.openGlobalDb();
chk('首次打开 created=true', h.created === true);
chk('首次打开建出库文件', existsSync(G.globalDbPathOf()));
const uv1 = Number(h.db.prepare('PRAGMA user_version').get()?.user_version ?? -1);
chk('user_version = GLOBAL_SCHEMA_VERSION', uv1 === G.GLOBAL_SCHEMA_VERSION, uv1);
const tablesOf = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => String(r.name));
chk('建出 events / relations 两张表',
    ['events', 'relations'].every((t) => tablesOf(h.db).includes(t)), tablesOf(h.db));
const triggersOf = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all().map((r) => String(r.name));
chk('建出两个追加写触发器',
    ['events_no_delete', 'events_no_update'].every((t) => triggersOf(h.db).includes(t)), triggersOf(h.db));
const idxNames = h.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name").all().map((r) => String(r.name));
// v2（阶段 4 联邦）新增 idx_grants_guest，共 5 个。**枚举名字**而不是只数个数：
// 少一个索引只会让查询变慢（看不出来），多一个重复索引会白占写入成本。
chk('建出 5 个查询索引且名字对得上',
    idxNames.join(',') === 'idx_events_at,idx_events_kind_at,idx_events_world_at,idx_grants_guest,idx_relations_to', idxNames);
const e1 = G.recordEvent('world.migrate', { to: 'x' }, { worldId: W1 });
const e2 = G.recordEvent('team.create', { name: 't' }, { worldId: W1, avatarId: 'botA' });
chk('写入两条事件成功', e1.ok === true && e2.ok === true, [e1, e2]);
const masterBefore = Number(h.db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get()?.n);
G.closeGlobalDb();
h = G.openGlobalDb();
chk('二次打开 created=false', h.created === false);
chk('二次打开 user_version 未被改乱', Number(h.db.prepare('PRAGMA user_version').get()?.user_version) === G.GLOBAL_SCHEMA_VERSION);
chk('二次打开事件没丢（2 条）', G.countEvents() === 2, G.countEvents());
chk('二次打开 sqlite_master 条目数不变（没有重复建表/建索引）',
    Number(h.db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get()?.n) === masterBefore);

// ══════════════════════════════════════════════════════════════════════════
// ③ 追加写（导出面 + 源码 + 库层三层）
// ══════════════════════════════════════════════════════════════════════════
console.log('③ 追加写');
const exportNames = Object.keys(G);
chk('导出面没有"改/删事件"的函数',
    !exportNames.some((n) => /^(update|delete|remove|drop|truncate|edit|patch|set|clear|purge).*(event)/i.test(n)),
    exportNames.filter((n) => /event/i.test(n)));
chk('源码里 "INSERT ... INTO events" 只有 1 处（唯一写入口）', count(/INSERT\s+(OR\s+IGNORE\s+)?INTO\s+events/gi) === 1,
    count(/INSERT\s+(OR\s+IGNORE\s+)?INTO\s+events/gi));
chk('源码里没有 "UPDATE events"', count(/UPDATE\s+events\b/gi) === 0, count(/UPDATE\s+events\b/gi));
chk('源码里没有 "DELETE FROM events"', count(/DELETE\s+FROM\s+events\b/gi) === 0, count(/DELETE\s+FROM\s+events\b/gi));
const beforeRow = h.db.prepare('SELECT id, kind, payload_json FROM events ORDER BY id').all();
chkThrow('库层 UPDATE events 被触发器拒绝', () => h.db.exec("UPDATE events SET kind='chat.say'"));
chkThrow('库层 DELETE FROM events 被触发器拒绝', () => h.db.exec('DELETE FROM events'));
const afterRow = h.db.prepare('SELECT id, kind, payload_json FROM events ORDER BY id').all();
chk('两次破坏尝试之后事件内容一字未变', JSON.stringify(beforeRow) === JSON.stringify(afterRow));

// ══════════════════════════════════════════════════════════════════════════
// ④ kind 白名单
// ══════════════════════════════════════════════════════════════════════════
console.log('④ kind 白名单');
chk('白名单非空且是冻结数组', Array.isArray(G.EVENT_KINDS) && G.EVENT_KINDS.length > 0 && Object.isFrozen(G.EVENT_KINDS),
    G.EVENT_KINDS.length);
const n0 = G.countEvents();
const accepted = G.EVENT_KINDS.filter((k) => G.recordEvent(k, {}, { worldId: W1 }).ok !== true);
chk('白名单里每个 kind 都能写（0 个被拒）', accepted.length === 0, accepted);
chk('白名单条目数 = 新增条数', G.countEvents() - n0 === G.EVENT_KINDS.length, [n0, G.countEvents()]);
const before = G.countEvents();
const badKind = G.recordEvent('nope.not-a-kind', {});
chk('语法非法 kind 被拒（reason=kind-not-allowed）', badKind.ok === false && badKind.reason === 'kind-not-allowed', badKind);
// ★ 关键用例：**语法完全合法、但没登记**的 kind 也必须被拒 —— 否则"只做正则校验"也能骗过上面那条。
const unregistered = G.recordEvent('identity.hacked', {});
chk('语法合法但未注册的 kind 被拒（白名单真的在起作用）',
    unregistered.ok === false && unregistered.reason === 'kind-not-allowed', unregistered);
chk('大写 kind 被拒', G.recordEvent('Chat.Say', {}).ok === false);
chk('空串 / 数字 / null 被拒',
    G.recordEvent('', {}).ok === false && G.recordEvent(123, {}).ok === false && G.recordEvent(null, {}).ok === false);
chk('未注册 kind 一条都没落库', G.countEvents() === before, [before, G.countEvents()]);
chk('eventKindAllowed 与白名单一致',
    G.eventKindAllowed('chat.say') === true && G.eventKindAllowed('chat') === false && G.eventKindAllowed('') === false);
chk('拒绝时打了 warn 日志', warns.some((w) => w.includes('kind-not-allowed')), warns.slice(-2));

// ══════════════════════════════════════════════════════════════════════════
// ⑤ payload 上限与序列化
// ══════════════════════════════════════════════════════════════════════════
console.log('⑤ payload');
const MAX = G.MAX_EVENT_PAYLOAD_BYTES;
chk('MAX_EVENT_PAYLOAD_BYTES = 8192', MAX === 8192, MAX);
// 精确边界：JSON 字符串本身（带引号）正好 MAX 字节
const exactPayload = 'a'.repeat(MAX - 2);
chk('恰好 MAX 字节被接受', G.recordEvent('chat.say', exactPayload, { worldId: W1 }).ok === true);
chk('MAX+1 字节被拒（payload-too-large）', (() => {
    const r = G.recordEvent('chat.say', 'a'.repeat(MAX - 1), { worldId: W1 });
    return r.ok === false && r.reason === 'payload-too-large' && r.bytes === MAX + 1;
})());
const beforeBytes = G.countEvents();
const multiByte = G.recordEvent('chat.say', '中'.repeat(3000), { worldId: W1 });   // 3000 字符 = 9000 字节
chk('上限按 UTF-8 字节算（3000 个汉字 9000 字节被拒）',
    multiByte.ok === false && multiByte.reason === 'payload-too-large' && multiByte.bytes > MAX, multiByte);
chk('被拒的超大 payload 没落库', G.countEvents() === beforeBytes);
const circular = { a: 1 };
circular.self = circular;
const circRes = G.recordEvent('chat.say', circular);
chk('循环引用 payload 被拒（payload-not-serializable）',
    circRes.ok === false && circRes.reason === 'payload-not-serializable', circRes);
chk('BigInt payload 被拒', (() => {
    const r = G.recordEvent('chat.say', { big: 1n });
    return r.ok === false && r.reason === 'payload-not-serializable';
})());
const nullPayload = G.recordEvent('chat.say', null, { worldId: W2, id: 'pl-null' });
const undefPayload = G.recordEvent('chat.say', undefined, { worldId: W2, id: 'pl-undef' });
chk('payload=null 允许，读回仍是 null 且 payloadOk', (() => {
    if (!nullPayload.ok || !undefPayload.ok) return false;
    const row = G.sinceEvents(0, { worldId: W2, limit: 2000 }).find((x) => x.id === nullPayload.id);
    return row && row.payload === null && row.payloadOk === true;
})());
chk('payload=undefined 写成 {}', (() => {
    const row = G.sinceEvents(0, { worldId: W2 }).find((x) => x.id === 'pl-undef');
    return row && JSON.stringify(row.payload) === '{}';
})());
const unicodeText = 'hi 🙂 世界';
const uniRes = G.recordEvent('chat.say', { text: unicodeText }, { worldId: W2, id: 'pl-uni' });
chk('带 emoji/中文的 payload 原样读回', (() => {
    if (!uniRes.ok) return false;
    const row = G.sinceEvents(0, { worldId: W2 }).find((x) => x.id === 'pl-uni');
    return row && row.payload.text === unicodeText;
})());

// ══════════════════════════════════════════════════════════════════════════
// ⑥ sinceEvents 查询口径
// ══════════════════════════════════════════════════════════════════════════
console.log('⑥ sinceEvents');
for (const e of [
    { at: 1_700_000_000_000, id: 'c-1', kind: 'chat.say' },
    { at: 1_700_000_000_001, id: 'c-2', kind: 'player.join' },
    { at: 1_700_000_000_002, id: 'c-3', kind: 'chat.say' },
]) G.recordEvent(e.kind, { id: e.id }, { worldId: W3, at: e.at, id: e.id, avatarId: 'botA' });
const seq = G.sinceEvents(1_700_000_000_000, { worldId: W3, kind: 'chat.say' });
chk('按时间游标（含边界）取到同档同类事件', seq.map((r) => r.id).join(',') === 'c-1,c-3', seq.map((r) => r.id));
chk('时间游标不跨档（别的档事件没混进来）', seq.every((r) => r.worldId === W3));
const tuple = G.sinceEvents({ at: 1_700_000_000_000, id: 'c-1' }, { worldId: W3 });
chk('元组游标严格大于（同毫秒也不漏/不重）', !tuple.some((r) => r.id === 'c-1'), tuple.map((r) => [r.at, r.id]));
// 同毫秒两条：元组游标必须不漏
G.recordEvent('chat.say', {}, { worldId: W3, at: 1_700_000_000_500, id: 's-1' });
G.recordEvent('chat.say', {}, { worldId: W3, at: 1_700_000_000_500, id: 's-2' });
chk('同毫秒两条：时间游标都返回（宁重不漏）',
    G.sinceEvents(1_700_000_000_500, { worldId: W3 }).filter((r) => r.id.startsWith('s-')).length === 2);
chk('同毫秒两条：元组游标精确跳过第一条',
    G.sinceEvents({ at: 1_700_000_000_500, id: 's-1' }, { worldId: W3 }).filter((r) => r.id.startsWith('s-')).map((r) => r.id).join(',') === 's-2');
chk('limit 生效', G.sinceEvents(0, { worldId: W3, limit: 2 }).length === 2);
chk('limit 超上限被夹到 MAX_EVENT_LIMIT', G.sinceEvents(0, { limit: 10_000_000 }).length <= G.MAX_EVENT_LIMIT);
chk('结果按 at 升序、同 at 按 id 升序', (() => {
    const rows = G.sinceEvents(0, { worldId: W3, limit: 1000 });
    for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1]; const b = rows[i];
        if (a.at > b.at || (a.at === b.at && a.id > b.id)) return false;
    }
    return true;
})());
chk('映射字段齐全（worldId/avatarId/kind/payload/at/sourceIp）', (() => {
    const r = G.sinceEvents(1_700_000_000_002, { worldId: W3, kind: 'chat.say' }).find((x) => x.id === 'c-3');
    return r && r.avatarId === 'botA' && r.kind === 'chat.say' && r.payload.id === 'c-3'
        && typeof r.at === 'number' && r.worldId === W3 && r.sourceIp === null;
})());
chkThrow('非法 since 抛 SINCE_INVALID', () => G.sinceEvents('yesterday'), 'SINCE_INVALID');
chkThrow('非法 kind 抛 KIND_INVALID', () => G.sinceEvents(0, { kind: 'nope.nope' }), 'KIND_INVALID');

// 参数校验（拒绝但不抛）
console.log('⑥b 参数校验');
const beforeParams = G.countEvents();
chk('world_id 不合法被拒',
    G.recordEvent('chat.say', {}, { worldId: '../etc' }).reason === 'world-id-invalid');
chk('avatar_id 不合法被拒（含控制字符）',
    G.recordEvent('chat.say', {}, { avatarId: 'a\nb' }).reason === 'avatar-id-invalid');
chk('source_ip 不合法被拒（超长）',
    G.recordEvent('chat.say', {}, { sourceIp: 'x'.repeat(65) }).reason === 'source-ip-invalid');
chk('非法 at 被拒',
    G.recordEvent('chat.say', {}, { at: 'now' }).reason === 'time-invalid');
chk('显式 id 非法被拒',
    G.recordEvent('chat.say', {}, { id: 'bad id!' }).reason === 'event-id-invalid');
chk('被拒的参数一条都没落库', G.countEvents() === beforeParams);
const sameId = G.recordEvent('chat.say', {}, { id: 'dup-1', worldId: W1 });
const sameId2 = G.recordEvent('chat.say', {}, { id: 'dup-1', worldId: W1 });
chk('同 id 第二次写是 duplicate-id（联邦重放不重复落库）',
    sameId.ok === true && sameId2.ok === false && sameId2.reason === 'duplicate-id', [sameId, sameId2]);
chk('duplicate-id 之后条数只 +1', G.sinceEvents(0, { worldId: W1 }).filter((r) => r.id === 'dup-1').length === 1);

// ══════════════════════════════════════════════════════════════════════════
// ⑦ statsByKind / countEvents
// ══════════════════════════════════════════════════════════════════════════
console.log('⑦ 统计');
const st = G.statsByKind({ worldId: W1 });
chk('statsByKind 按 kind 分组', st.length > 0 && st.every((s) => typeof s.kind === 'string' && s.count > 0));
chk('statsByKind 条数之和 = countEvents（同档）',
    st.reduce((a, b) => a + b.count, 0) === G.countEvents({ worldId: W1 }), [st, G.countEvents({ worldId: W1 })]);
chk('statsByKind 的 firstAt/lastAt 对得上', st.every((s) => s.firstAt <= s.lastAt && s.firstAt > 0));
const stAll = G.statsByKind();
chk('不带 worldId 时统计全库', stAll.reduce((a, b) => a + b.count, 0) === G.countEvents());
chk('countEvents 支持 kind 过滤',
    G.countEvents({ worldId: W1, kind: 'chat.say' }) === G.sinceEvents(0, { worldId: W1, kind: 'chat.say', limit: 2000 }).length);

// ══════════════════════════════════════════════════════════════════════════
// ⑧ relations：绝对写 vs 增量写
// ══════════════════════════════════════════════════════════════════════════
console.log('⑧ relations');
const eventsBeforeRel = G.countEvents();
const s1 = G.setRelation('a', 'b', { affinity: 10, tags: ['friend', 'ally', 'friend'] });
chk('setRelation 建行成功', s1.ok === true);
chk('tags 去重保序', JSON.stringify(s1.relation.tags) === JSON.stringify(['friend', 'ally']), s1.relation.tags);
chk('affinity = 10', s1.relation.affinity === 10);
const s2 = G.setRelation('a', 'b', { affinity: 2 });
chk('绝对写覆盖 affinity', s2.ok === true && s2.relation.affinity === 2);
chk('绝对写未给 tags → tags 归零（绝对语义）', JSON.stringify(s2.relation.tags) === '[]', s2.relation.tags);
const a1 = G.addRelationAffinity('a', 'b', 3);
chk('增量写 +3 → 5', a1.ok === true && a1.relation.affinity === 5, a1.relation?.affinity);
G.setRelation('a', 'b', { affinity: 5, tags: ['x'] });
const a2 = G.addRelationAffinity('a', 'b', -2);
chk('增量写 -2 → 3 且不抹掉已有 tags',
    a2.ok === true && a2.relation.affinity === 3 && JSON.stringify(a2.relation.tags) === JSON.stringify(['x']), a2.relation);
const a3 = G.addRelationAffinity('a', 'b', 1, { tags: ['y'] });
chk('增量写带 tags → 覆盖 tags',
    a3.ok === true && JSON.stringify(a3.relation.tags) === JSON.stringify(['y']), a3.relation.tags);
chk('relations 不写 events（两套数据互不污染）', G.countEvents() === eventsBeforeRel);
chk('自指关系被拒', G.setRelation('a', 'a', {}).reason === 'self-relation-refused');
chk('空 from 被拒', G.setRelation('', 'b', {}).reason === 'from-avatar-invalid');
chk('非整数 affinity 被拒', G.setRelation('a', 'b', { affinity: 1.5 }).reason === 'affinity-invalid');
chk('超大 affinity 被拒', G.setRelation('a', 'b', { affinity: 1e9 }).reason === 'affinity-invalid');
chk('delta=0 被拒', G.addRelationAffinity('a', 'b', 0).reason === 'delta-invalid');
chk('tags 非数组被拒', G.setRelation('a', 'b', { tags: 'friend' }).reason === 'tags-invalid');
chk('单个 tag 超长被拒', G.setRelation('a', 'b', { tags: ['t'.repeat(G.MAX_TAG_LEN + 1)] }).reason === 'tags-invalid');
chk('tag 数量超上限被拒',
    G.setRelation('a', 'b', { tags: Array.from({ length: G.MAX_RELATION_TAGS + 1 }, (_, i) => `t${i}`) }).reason === 'tags-invalid');
chk('不存在的关系统返回 null', G.getRelation('nobody', 'nobody2') === null);
G.setRelation('a', 'c', { affinity: -20 });
G.setRelation('d', 'b', { affinity: 7 });
const listA = G.listRelations({ from: 'a' });
chk('listRelations(from) 按 |affinity| 降序', listA.length === 2 && Math.abs(listA[0].affinity) >= Math.abs(listA[1].affinity),
    listA.map((r) => r.affinity));
chk('listRelations(to) 过滤', G.listRelations({ to: 'b' }).every((r) => r.to === 'b'));
chk('listRelations limit', G.listRelations({ limit: 1 }).length === 1);
chk('listRelations 带控制字符端点不炸（query 侧只做参数绑定）', Array.isArray(G.listRelations({ from: 'a\nb' })));

// ══════════════════════════════════════════════════════════════════════════
// ⑨ applyRelationDeltas（联邦增量）
// ══════════════════════════════════════════════════════════════════════════
console.log('⑨ 批量增量');
G.setRelation('f', 'g', { affinity: 100 });
const batch = G.applyRelationDeltas([
    { from: 'f', to: 'g', delta: 5 },
    { from: 'f', to: 'f', delta: 1 },
    { from: 'h', to: 'i', delta: 2, tags: ['met'] },
    { from: 'h', to: 'i', delta: 0 },
    { from: 'x', to: 'y', delta: 1, tags: 'bad' },
]);
chk('批量：合法条目全部应用', batch.ok === true && batch.applied === 2, batch);
chk('批量：坏条目被跳过并给出原因',
    batch.rejected.length === 3 && batch.rejected[0].reason === 'self-relation-refused'
    && batch.rejected[1].reason === 'delta-invalid' && batch.rejected[2].reason === 'tags-invalid', batch.rejected);
chk('批量：增量累加正确（100+5）', G.getRelation('f', 'g').affinity === 105, G.getRelation('f', 'g').affinity);
chk('批量：新关系带 tags 落库',
    G.getRelation('h', 'i').affinity === 2 && JSON.stringify(G.getRelation('h', 'i').tags) === JSON.stringify(['met']));
chk('批量：非数组被拒', G.applyRelationDeltas('nope').ok === false);
chk('批量：全坏 → ok=false 且 applied=0', (() => {
    const r = G.applyRelationDeltas([{ from: 'a', to: 'a', delta: 1 }]);
    return r.ok === false && r.applied === 0 && r.rejected.length === 1;
})());

// ══════════════════════════════════════════════════════════════════════════
// ⑩ 写失败不拖垮调用方（但必须打日志）
// ══════════════════════════════════════════════════════════════════════════
console.log('⑩ 写失败');
{
    const badRoot = join(mkdtempSync(join(tmpdir(), 'global-store-bad-')), 'bots');
    mkdirSync(join(badRoot, '_global', 'mind.sqlite'), { recursive: true });   // 路径被目录占住，必然打不开
    G.closeGlobalDb();
    process.env.MC_BOTS_ROOT = badRoot;
    const errsBefore = errs.length;
    let threw = false;
    let res;
    try {
        res = G.recordEvent('chat.say', { x: 1 });
    } catch { threw = true; }
    chk('库打不开时 recordEvent 不抛', threw === false);
    chk('库打不开时返回 write-failed', res && res.ok === false && res.reason === 'write-failed', res);
    chk('写失败必须打日志（console.error）', errs.length > errsBefore && errs[errs.length - 1].includes('事件写入失败'),
        errs.slice(errsBefore));
    let relThrew = false;
    let relRes;
    try {
        relRes = G.setRelation('a', 'b', { affinity: 1 });
    } catch { relThrew = true; }
    chk('关系写入失败同样不抛（ok=false write-failed）',
        relThrew === false && relRes.ok === false && relRes.reason === 'write-failed', relRes);
    process.env.MC_BOTS_ROOT = BOTS;
    G.closeGlobalDb();
}

// ══════════════════════════════════════════════════════════════════════════
// ⑪ 只读打开
// ══════════════════════════════════════════════════════════════════════════
console.log('⑪ 只读');
{
    const ro = G.openGlobalDb({ readOnly: true });
    chk('只读打开成功', ro.readOnly === true && typeof ro.db.prepare === 'function');
    chk('只读句柄能查事件', Array.isArray(G.sinceEvents(0, { readOnly: true })));
    let writeThrew = false;
    try { ro.db.exec("INSERT INTO events(id,kind,payload_json,at) VALUES('x','chat.say','{}',1)"); } catch { writeThrew = true; }
    chk('只读句柄写不进事件', writeThrew);
    ro.db.close();
    const missing = join(ROOT, 'no-such-dir', '_global', 'mind.sqlite');
    chkThrow('只读打开不存在的库 → GLOBAL_DB_MISSING（不凭空建库）',
        () => G.openGlobalDb({ path: missing, readOnly: true }), 'GLOBAL_DB_MISSING');
    chk('只读打开后没有建出文件', !existsSync(missing));
}

// ══════════════════════════════════════════════════════════════════════════
// ⑫ 并发写不丢（真多进程：4 × 50 事件 / 4 × 25 增量）
// ══════════════════════════════════════════════════════════════════════════
console.log('⑫ 并发写');
{
    G.closeGlobalDb();
    const before = G.countEvents();
    const relBefore = G.getRelation('conc', 'peer')?.affinity ?? 0;
    const child = `
import { pathToFileURL } from 'node:url';
const mod = await import(process.env.GS_MOD);
const n = Number(process.env.GS_N);
const mode = process.env.GS_MODE;
let bad = 0;
for (let i = 0; i < n; i++) {
    if (mode === 'events') {
        const r = mod.recordEvent('chat.say', { i, pid: process.pid }, { worldId: process.env.GS_WORLD });
        if (!r.ok) { bad++; console.error('record-failed', JSON.stringify(r)); }
    } else {
        const r = mod.addRelationAffinity('conc', 'peer', 1);
        if (!r.ok) { bad++; console.error('rel-failed', JSON.stringify(r)); }
    }
}
mod.closeGlobalDb();
process.exit(bad === 0 ? 0 : 3);
`;
    const run = (mode, n, workers) => {
        const outs = [];
        for (let w = 0; w < workers; w++) {
            outs.push(execFileSync(process.execPath, ['--input-type=module', '-e', child], {
                encoding: 'utf8',
                env: { ...process.env, GS_MOD: MOD, GS_N: String(n), GS_MODE: mode, GS_WORLD: W2 },
                stdio: ['ignore', 'pipe', 'pipe'],
            }));
        }
        return outs;
    };
    let eventErr = null;
    try { run('events', 50, 4); } catch (e) { eventErr = e; }
    const after = G.countEvents();
    chk('4 进程 × 50 条事件一条不丢', eventErr === null && after - before === 200,
        { delta: after - before, err: eventErr ? String(eventErr.message).slice(0, 300) : null });
    const payloadOk = G.sinceEvents(0, { worldId: W2, limit: 2000 }).filter((r) => r.payload && r.payload.pid).length;
    chk('并发写入的 payload 都是完整 JSON', payloadOk >= 200, payloadOk);
    let relErr = null;
    try { run('relations', 25, 4); } catch (e) { relErr = e; }
    const relAfter = G.getRelation('conc', 'peer')?.affinity ?? null;
    chk('4 进程 × 25 次增量 = +100（SQL 里累加，不丢更新）',
        relErr === null && relAfter === relBefore + 100, { relBefore, relAfter, err: relErr ? String(relErr.message).slice(0, 300) : null });
}

// ══════════════════════════════════════════════════════════════════════════
// ⑬ 库比代码新 → 拒绝打开
// ══════════════════════════════════════════════════════════════════════════
console.log('⑬ 版本护栏');
{
    G.closeGlobalDb();
    const raw = new DatabaseSync(G.globalDbPathOf());
    raw.exec('PRAGMA user_version = 99');
    raw.close();
    const e = chkThrow('库结构版本更新时拒绝打开（GLOBAL_SCHEMA_TOO_NEW）', () => G.openGlobalDb(), 'GLOBAL_SCHEMA_TOO_NEW');
    chk('错误信息说清是哪两个版本', Boolean(e && String(e.message).includes('99')), e && String(e.message));
    G.closeGlobalDb();
    const fix = new DatabaseSync(G.globalDbPathOf());
    fix.exec(`PRAGMA user_version = ${G.GLOBAL_SCHEMA_VERSION}`);
    fix.close();
    chk('版本改回后能正常打开（拒绝不是永久锁死）', G.openGlobalDb().created === false);
}

// ══════════════════════════════════════════════════════════════════════════
// 清理
// ══════════════════════════════════════════════════════════════════════════
console.log('⑭ 清理');
G.closeGlobalDb();
chk('closeGlobalDb 之后没有残留写句柄（再开是新的）', G.openGlobalDb().created === false);
G.closeGlobalDb();
let cleaned = true;
try { rmSync(ROOT, { recursive: true, force: true }); } catch { cleaned = false; }
chk('临时目录清理完成（Windows 上句柄没关会 EPERM → 这里必须绿）', cleaned || !existsSync(ROOT));

console.warn = realWarn;
console.error = realErr;
console.log(`\n合计：${pass} 通过 / ${fail} 失败（日志：warn ${warns.length} 条 / error ${errs.length} 条）`);
if (fail) console.log('FAILED');
process.exit(fail ? 1 : 0);
