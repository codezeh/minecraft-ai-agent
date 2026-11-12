/**
 * 阶段 4 联邦串门（D5/D9）—— 离线单测，真 sqlite + 真 Ed25519。
 *
 * 钉死的六件事：
 *   ① 老库（`_global` v1）升级到 v2 幂等、事件不丢；
 *   ② 访问凭证：token 不落明文、签发幂等、**重放/过期/撤销后核销必须失败**、白名单硬门；
 *   ③ 名片：Ed25519 验签（篡改/换钥/旧 seq 都拒），people_store 的钥匙能签能验；
 *   ④ 关系增量：推两次结果一致（幂等）、较旧丢弃、同时间戳冲突**确定性收敛**；
 *   ⑤ CoreProtect 导入：未安装明确报错不假成功、游标+确定性 id 双保险去重；
 *   ⑥ 审计事件（`federation.grant` / `federation.peer` / `federation.relations`）真的落库。
 *
 * ⚠ 本测试**只验本地两个角色的判定**：真跨机交换（网络层、证书、时钟）**未验证**，
 *   见 docs/audit-r6/fixes4/federation.md §7。
 *
 * 输出：PASS/FAIL 逐条，全过退出码 0。
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as F from '../src/mindcraft/federation.js';
import * as G from '../src/mindcraft/global_store.js';
import * as P from '../src/mindcraft/people_store.js';

let pass = 0;
let fail = 0;
const chk = (n, c, i) => {
    if (c) { pass++; console.log(`  PASS  ${n}${i === undefined ? '' : '   ' + JSON.stringify(i)}`); } else { fail++; console.log(`  FAIL  ${n}   ${JSON.stringify(i)}`); }
};

/* 收走模块日志：要断言"该告警的地方真的告警了"，同时别把 gate 输出刷满。 */
const warns = [];
const errs = [];
const realWarn = console.warn;
const realErr = console.error;
console.warn = (...a) => { warns.push(a.map(String).join(' ')); };
console.error = (...a) => { errs.push(a.map(String).join(' ')); };

const ROOT = mkdtempSync(join(tmpdir(), 'federation-test-'));
const BOTS = join(ROOT, 'bots');
process.env.MC_BOTS_ROOT = BOTS;
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
/** 换一个干净的 bots 根（模拟"另一台机器/另一份 _global"）。 */
function useRoot(name) {
    G.closeGlobalDb();
    process.env.MC_BOTS_ROOT = join(ROOT, name, 'bots');
    return process.env.MC_BOTS_ROOT;
}
const dbOf = () => G.openGlobalDb().db;

// ══════════════════════════════════════════════════════════════════════════
// ① 老库 v1 → v2 升级（幂等、事件不丢）
// ══════════════════════════════════════════════════════════════════════════
console.log('① 老库升级 v1 → v2');
{
    const oldRoot = useRoot('legacy');
    mkdirSync(join(oldRoot, '_global'), { recursive: true });
    const legacyPath = join(oldRoot, '_global', 'mind.sqlite');
    const raw = new DatabaseSync(legacyPath);
    raw.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, world_id TEXT, avatar_id TEXT, kind TEXT NOT NULL,
                payload_json TEXT NOT NULL, at INTEGER NOT NULL, source_ip TEXT);
              CREATE TABLE relations (from_avatar TEXT NOT NULL, to_avatar TEXT NOT NULL,
                affinity INTEGER NOT NULL DEFAULT 0, tags_json TEXT NOT NULL DEFAULT '[]',
                updated_at INTEGER NOT NULL, PRIMARY KEY (from_avatar, to_avatar));`);
    raw.prepare('INSERT INTO events(id,kind,payload_json,at) VALUES(?,?,?,?)').run('legacy-1', 'chat.say', '{"t":1}', 1000);
    raw.exec('PRAGMA user_version = 1');
    raw.close();
    const h = G.openGlobalDb();
    const uv = Number(h.db.prepare('PRAGMA user_version').get()?.user_version);
    chk('v1 老库升级到 v2', uv === 2 && G.GLOBAL_SCHEMA_VERSION === 2, { uv, expect: G.GLOBAL_SCHEMA_VERSION });
    chk('升级后老事件还在', G.countEvents() === 1 && G.sinceEvents(0)[0]?.id === 'legacy-1');
    const t = h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => String(r.name));
    chk('v2 四张新表都建出来',
        ['import_cursors', 'known_peers', 'peer_allowlist', 'visit_grants'].every((x) => t.includes(x)), t);
    G.closeGlobalDb();
    const h2 = G.openGlobalDb();
    chk('二次打开幂等（版本不变、表不重复、事件不丢）',
        Number(h2.db.prepare('PRAGMA user_version').get()?.user_version) === 2 && G.countEvents() === 1);
    G.closeGlobalDb();
}

// ══════════════════════════════════════════════════════════════════════════
// ② 白名单
// ══════════════════════════════════════════════════════════════════════════
console.log('② 白名单');
useRoot('main');
{
    chk('空名单 = 谁都不许（不做"没配置就放行"）', F.isPeerAllowed('peer-a') === false);
    chk('allowPeer 首次 added=true', F.allowPeer('peer-a')?.added === true);
    chk('allowPeer 幂等（第二次 added=false）', F.allowPeer('peer-a')?.added === false);
    chk('名单里有 peer-a', F.isPeerAllowed('peer-a') === true && F.isPeerAllowed('peer-b') === false);
    chk('非法 peerId 被拒', F.allowPeer('')?.reason === 'peer-id-invalid' && F.allowPeer('a b')?.reason === 'peer-id-invalid');
    chk('listAllowedPeers 能列出来', F.listAllowedPeers().map((p) => p.peerId).includes('peer-a'));
    chk('revokePeer 移除', F.revokePeer('peer-a')?.removed === true && F.isPeerAllowed('peer-a') === false);
    chk('revokePeer 幂等（第二次 removed=false）', F.revokePeer('peer-a')?.removed === false);
    F.allowPeer('peer-a');   // 后面凭证用例要用
}

// ══════════════════════════════════════════════════════════════════════════
// ③ 凭证签发（token 不落明文 / 签发幂等 / grantId 冲突）
// ══════════════════════════════════════════════════════════════════════════
console.log('③ 凭证签发');
{
    const g = F.issueVisitGrant({ hostId: 'host-1', guestId: 'peer-a', grantId: 'vg-1', ttlMs: 60_000, maxUses: 1 }, { now: 1000 });
    chk('签发成功并吐出 token', g.ok === true && typeof g.token === 'string' && g.token.length >= 32, { grantId: g.grantId, expiresAt: g.expiresAt });
    chk('expiresAt = now + ttl', g.expiresAt === 1000 + 60_000, g.expiresAt);
    const row = dbOf().prepare('SELECT * FROM visit_grants WHERE grant_id = ?').get('vg-1');
    chk('库里存的是 sha256（不是明文 token）', String(row.token_sha256) === sha(g.token), { stored: String(row.token_sha256).slice(0, 12) });
    const dump = JSON.stringify(dbOf().prepare('SELECT * FROM visit_grants').all());
    chk('整张表里找不到 token 明文', !dump.includes(g.token));
    const again = F.issueVisitGrant({ hostId: 'host-1', guestId: 'peer-a', grantId: 'vg-1' }, { now: 2000 });
    chk('同 grantId 再签：幂等、不吐第二个 token、不新增行',
        again.ok === true && again.idempotent === true && again.token === null
        && dbOf().prepare('SELECT COUNT(*) AS n FROM visit_grants WHERE grant_id = ?').get('vg-1').n === 1, again);
    const taken = F.issueVisitGrant({ hostId: 'host-1', guestId: 'peer-b', grantId: 'vg-1' }, { now: 2000 });
    chk('同 grantId 换 guest → grant-id-taken', taken.ok === false && taken.reason === 'grant-id-taken', taken);
    chk('ttl 上限/非法值被拒',
        F.issueVisitGrant({ hostId: 'h', guestId: 'peer-a', ttlMs: 0 }).reason === 'ttl-invalid'
        && F.issueVisitGrant({ hostId: 'h', guestId: 'peer-a', ttlMs: F.MAX_GRANT_TTL_MS + 1 }).reason === 'ttl-invalid');
    chk('maxUses 非法被拒',
        F.issueVisitGrant({ hostId: 'h', guestId: 'peer-a', maxUses: 0 }).reason === 'max-uses-invalid'
        && F.issueVisitGrant({ hostId: 'h', guestId: 'peer-a', maxUses: 999 }).reason === 'max-uses-invalid');
    chk('host/guest 缺失被拒',
        F.issueVisitGrant({ guestId: 'peer-a' }).reason === 'host-id-invalid'
        && F.issueVisitGrant({ hostId: 'h' }).reason === 'guest-id-invalid');
    const prev = F.previewVisitGrants({ guestId: 'peer-a' }).find((p) => p.grantId === 'vg-1');
    chk('preview 不含 token/token_sha256 字段',
        prev && !('token' in prev) && !('token_sha256' in prev) && prev.maxUses === 1 && prev.usedCount === 0, prev && Object.keys(prev));
}

// ══════════════════════════════════════════════════════════════════════════
// ④ 凭证核销（重放 / 过期 / 撤销 / 白名单）
// ══════════════════════════════════════════════════════════════════════════
console.log('④ 凭证核销');
{
    const g = F.issueVisitGrant({ hostId: 'host-1', guestId: 'peer-a', grantId: 'vg-ok', ttlMs: 60_000 }, { now: 10_000 });
    chk('错 token 被拒（不烧码）', (() => {
        const r = F.redeemVisitGrant({ grantId: 'vg-ok', token: 'wrong-token' }, { now: 11_000 });
        return r.ok === false && r.reason === 'bad-token';
    })());
    const ok = F.redeemVisitGrant({ grantId: 'vg-ok', token: g.token, guestId: 'peer-a' }, { now: 12_000 });
    chk('错 token 之后正确 token 仍然可用（失败不烧码）', ok.ok === true && ok.usesLeft === 0, ok);
    const replay = F.redeemVisitGrant({ grantId: 'vg-ok', token: g.token }, { now: 13_000 });
    chk('★ 重放必须失败（already-used）', replay.ok === false && replay.reason === 'already-used', replay);
    const row = dbOf().prepare('SELECT used_count, used_at FROM visit_grants WHERE grant_id = ?').get('vg-ok');
    chk('库里 used_count 只加了 1 次', Number(row.used_count) === 1, row);

    const exp = F.issueVisitGrant({ hostId: 'host-1', guestId: 'peer-a', grantId: 'vg-exp', ttlMs: 1000 }, { now: 1000 });
    const e1 = F.redeemVisitGrant({ grantId: 'vg-exp', token: exp.token }, { now: 5000 });
    chk('★ 过期核销失败（expired）', e1.ok === false && e1.reason === 'expired', e1);

    const rev = F.issueVisitGrant({ hostId: 'host-1', guestId: 'peer-a', grantId: 'vg-rev', ttlMs: 60_000 }, { now: 1000 });
    F.revokeVisitGrant('vg-rev', { now: 1500 });
    const r1 = F.redeemVisitGrant({ grantId: 'vg-rev', token: rev.token }, { now: 2000 });
    chk('★ 吐销后核销失败（revoked）', r1.ok === false && r1.reason === 'revoked', r1);
    chk('重复撤销幂等', F.revokeVisitGrant('vg-rev').alreadyRevoked === true);
    chk('撤销未知凭证 → unknown-grant', F.revokeVisitGrant('vg-nope').reason === 'unknown-grant');

    chk('未知 grantId → unknown-grant', F.redeemVisitGrant({ grantId: 'vg-nope', token: 'x' }).reason === 'unknown-grant');
    const gm = F.issueVisitGrant({ hostId: 'host-1', guestId: 'peer-a', grantId: 'vg-gm' }, { now: 1000 });
    chk('guest 不匹配被拒', F.redeemVisitGrant({ grantId: 'vg-gm', token: gm.token, guestId: 'peer-b' }).reason === 'guest-mismatch');
    F.revokePeer('peer-a');
    const na = F.redeemVisitGrant({ grantId: 'vg-gm', token: gm.token }, { now: 1100 });
    chk('★ 白名单外的 guest 核销失败（not-allowlisted）', na.ok === false && na.reason === 'not-allowlisted', na);
    F.allowPeer('peer-a');
    chk('加回白名单后可核销', F.redeemVisitGrant({ grantId: 'vg-gm', token: gm.token }, { now: 1200 }).ok === true);
    const many = F.issueVisitGrant({ hostId: 'host-1', guestId: 'peer-a', grantId: 'vg-many', maxUses: 3 }, { now: 1000 });
    const uses = [1, 2, 3, 4].map((i) => F.redeemVisitGrant({ grantId: 'vg-many', token: many.token }, { now: 2000 + i }));
    chk('maxUses=3 时第 4 次失败（多用途也不越界）',
        uses.slice(0, 3).every((r) => r.ok) && uses[3].ok === false && uses[3].reason === 'already-used',
        uses.map((r) => r.ok ? r.usesLeft : r.reason));

    // ★ 真并发：4 个进程同时核销同一张一次性凭证，**只许 1 个成功**。
    //   这条才钉住 UPDATE 里的 `used_count < max_uses`（只靠上面的 diagnose，单进程永远看不出差别：
    //   4 个进程都会在 UPDATE 之前读到 used_count=0）。
    {
        const g = F.issueVisitGrant({ hostId: 'host-1', guestId: 'peer-a', grantId: 'vg-race', ttlMs: 600_000 }, { now: Date.now() });
        G.closeGlobalDb();
        const modUrl = new URL('../src/mindcraft/federation.js', import.meta.url).href;
        // 子进程先自旋到同一个 startAt，再同时核销 —— 否则 spawn 的启动抖动会把"并发"退化成"串行"。
        const startAt = Date.now() + 1200;
        const child = `
const F = await import(process.env.FED_MOD);
while (Date.now() < Number(process.env.FED_START)) { /* 同步起跑线 */ }
const r = F.redeemVisitGrant({ grantId: process.env.FED_GRANT, token: process.env.FED_TOKEN });
process.stdout.write(JSON.stringify(r) + '\\n');
`;
        const spawnOne = () => new Promise((resolve) => {
            const cp = spawn(process.execPath, ['--input-type=module', '-e', child], {
                env: { ...process.env, FED_MOD: modUrl, FED_GRANT: 'vg-race', FED_TOKEN: g.token, FED_START: String(startAt) },
            });
            let out = '';
            let err = '';
            cp.stdout.on('data', (d) => { out += d; });
            cp.stderr.on('data', (d) => { err += d; });
            cp.on('close', (code) => resolve({ code, out, err }));
        });
        const outs = await Promise.all([spawnOne(), spawnOne(), spawnOne(), spawnOne()]);
        const results = outs.map((o) => {
            const line = String(o.out).trim().split('\n').filter(Boolean).pop();
            try { return JSON.parse(line); } catch { return { ok: false, reason: `child-exit-${o.code}`, err: String(o.err).slice(0, 200) }; }
        });
        const winners = results.filter((r) => r.ok === true);
        chk('★ 4 进程同时核销同一张一次性凭证：恰好 1 个成功', winners.length === 1,
            results.map((r) => (r.ok ? 'ok' : r.reason)));
        chk('★ 并发里失败的那 3 个必须是 already-used（不是别的错）',
            results.filter((r) => !r.ok).every((r) => r.reason === 'already-used' || r.reason === 'lost-race'),
            results.filter((r) => !r.ok).map((r) => r.reason));
        const used = dbOf().prepare('SELECT used_count FROM visit_grants WHERE grant_id = ?').get('vg-race');
        chk('★ 库里 used_count = 1（没有双花）', Number(used.used_count) === 1, used);
    }

    // 防御纵深：核销 SQL **语句本身**必须带三道守卫（否则并发下 diagnose 与 UPDATE 之间会双花）。
    // ★ 只扫那条 UPDATE 语句的文本，不扫整个文件：上一版扫全文时，注释里引用的同一串字把它喂绿了
    //   （"命中 ≠ 命中被测对象"，同 kind 白名单那次的教训）。
    const fedSrc = readFileSync(new URL('../src/mindcraft/federation.js', import.meta.url), 'utf8');
    const redeemSql = (fedSrc.match(/UPDATE visit_grants SET used_count = used_count \+ 1[\s\S]*?`/) ?? [''])[0];
    chk('核销用的那条 UPDATE 语句带三道 WHERE 守卫（revoked / expires / uses）',
        /revoked_at IS NULL/.test(redeemSql) && /expires_at >= \?/.test(redeemSql) && /used_count < max_uses/.test(redeemSql),
        redeemSql.replace(/\s+/g, ' ').slice(0, 160));
}

// ══════════════════════════════════════════════════════════════════════════
// ⑤ 名片（Ed25519 验签 + 公钥固定 + seq 单调）
// ══════════════════════════════════════════════════════════════════════════
console.log('⑤ 名片');
{
    const mk = () => {
        const { publicKey, privateKey } = generateKeyPairSync('ed25519');
        return {
            pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
            priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        };
    };
    const A = mk();
    const B = mk();
    const cardA = F.signPeerCard({ peerId: 'peer-x', addr: '10.1.1.1:25566', caps: ['visit'], seq: 1, at: 5000 }, A);
    chk('签名成功且带 sig', cardA.ok === true && typeof cardA.card.sig === 'string' && cardA.card.v === 1);
    const acc = F.acceptPeerCard(cardA.card, { now: 6000 });
    chk('名片验签通过并落 known_peers', acc.ok === true && acc.newPeer === true, acc);
    const kp = F.knownPeerRow('peer-x');
    chk('known_peers 记住公钥/地址/seq', kp && kp.pubkey === A.pub && kp.lastAddr === '10.1.1.1:25566' && kp.cardSeq === 1);
    const tampered = { ...cardA.card, addr: 'evil:1' };
    const bad = F.acceptPeerCard(tampered, { now: 7000 });
    chk('★ 篡改字段 → bad-signature 且不覆盖 known_peers', bad.ok === false && bad.reason === 'bad-signature' && F.knownPeerRow('peer-x').lastAddr === '10.1.1.1:25566', bad);
    // ★ 更强的篡改用例：**seq 更大**，这样"旧名片"判据救不了它 —— 只有验签能挡。
    //   去掉验签时这条必然变红（其它判据都满足）。
    const tamperedNew = { ...cardA.card, addr: 'evil:2', seq: 9 };
    const badNew = F.acceptPeerCard(tamperedNew, { now: 7500 });
    chk('★ 篡改且 seq 更大（只剩验签能挡）→ bad-signature', badNew.ok === false && badNew.reason === 'bad-signature', badNew);
    chk('篡改的名片没有写进 known_peers', F.knownPeerRow('peer-x').cardSeq === 1, F.knownPeerRow('peer-x').cardSeq);
    const forged = F.signPeerCard({ peerId: 'peer-x', addr: 'evil:1', seq: 2, at: 5100 }, B);
    const wrongKey = F.acceptPeerCard(forged.card, { now: 7100 });
    chk('★ 同 peerId 换一把钥匙 → pubkey-mismatch', wrongKey.ok === false && wrongKey.reason === 'pubkey-mismatch', wrongKey);
    const card2 = F.signPeerCard({ peerId: 'peer-x', addr: '10.1.1.1:25566', seq: 2, at: 5200 }, A);
    chk('同钥 seq 递增 → 接受', F.acceptPeerCard(card2.card, { now: 8000 }).ok === true);
    chk('★ 旧名片重放（seq 不增）→ stale-card', F.acceptPeerCard(cardA.card, { now: 9000 }).reason === 'stale-card');
    chk('结构非法 → card-invalid/seq-invalid',
        F.acceptPeerCard(null).reason === 'card-invalid'
        && F.verifyPeerCard({ v: 1, peerId: 'p', pubkey: A.pub, seq: 0, at: 1, sig: 'x' }).reason === 'seq-invalid');
    chk('版本不认识 → card-version-unsupported',
        F.verifyPeerCard({ ...cardA.card, v: 99 }).reason === 'card-version-unsupported');
    chk('pubkey 不是 PEM → pubkey-invalid', F.verifyPeerCard({ ...cardA.card, pubkey: 'not-a-key' }).reason === 'pubkey-invalid');

    // people_store 的 Ed25519 钥匙（同一套 PEM 口径）也能签能验
    const store = P.emptyPeopleStore();
    const created = P.ensurePerson(store, { name: '主人' });
    P.linkAvatar(created.store, { avatarName: 'botA', personId: created.result.person.id });
    const issued = P.issueAvatarKey(created.store, { avatarId: created.store.avatars[0].id });
    const signed = F.signPeerCardWithAvatar(issued.store, issued.store.avatars[0].id, { peerId: 'peer-y', addr: '10.2.2.2:25566', seq: 1, at: 7000 });
    chk('people_store 的 avatar 钥匙能签名片', signed.ok === true && typeof signed.card.sig === 'string');
    const accY = F.acceptPeerCard(signed.card, { now: 8000 });
    chk('该名片能通过本模块验签', accY.ok === true && accY.peerId === 'peer-y', accY);
    chk('无生效钥匙 → no-active-key',
        F.signPeerCardWithAvatar(issued.store, 'no-such-avatar', { peerId: 'p', seq: 1, at: 1 }).reason === 'no-active-key');
    chk('forgetPeer 后可以重新钉钥（换钥的唯一合法途径）',
        F.forgetPeer('peer-x').removed === true && F.acceptPeerCard({ ...F.signPeerCard({ peerId: 'peer-x', seq: 1, at: 9000 }, B).card }, { now: 9000 }).ok === true);
}

// ══════════════════════════════════════════════════════════════════════════
// ⑥ 关系增量（幂等 / 冲突确定性）
// ══════════════════════════════════════════════════════════════════════════
console.log('⑥ 关系增量');
{
    G.setRelation('a', 'b', { affinity: 5, tags: ['friend'], at: 1000 });
    G.setRelation('c', 'd', { affinity: -2, at: 2000 });
    const ex = F.exportRelationDelta({ since: 0 });
    chk('导出按 updated_at 升序、游标=最后一行的 updated_at',
        ex.ok === true && ex.rows.length === 2 && ex.rows[0].updatedAt <= ex.rows[1].updatedAt && ex.cursor === 2000, ex);
    const p1 = F.pushRelationDelta(ex.rows, { sourcePeerId: 'peer-z' });
    chk('推送自己已有的行 → identical（不改数据）', p1.ok === true && p1.identical === 2 && p1.inserted === 0 && p1.updated === 0, p1);
    const p2 = F.pushRelationDelta(ex.rows, { sourcePeerId: 'peer-z' });
    chk('★ 同一批推两次结果完全一致（幂等）', JSON.stringify({ ...p1, rejected: undefined }) === JSON.stringify({ ...p2, rejected: undefined }), [p1, p2]);
    const pushed = F.pushRelationDelta([{ from: 'e', to: 'f', affinity: 7, tags: ['met'], updatedAt: 3000 }]);
    chk('新关系被插入', pushed.inserted === 1 && G.getRelation('e', 'f').affinity === 7);
    const older = F.pushRelationDelta([{ from: 'e', to: 'f', affinity: 99, updatedAt: 2000 }]);
    chk('较旧的行被丢弃（本地更新）', older.older === 1 && older.updated === 0 && G.getRelation('e', 'f').affinity === 7, older);
    const c1 = F.pushRelationDelta([{ from: 'e', to: 'f', affinity: 8, tags: [], updatedAt: 3000 }]);
    chk('同一时间戳、内容不同：算冲突并按确定性规则收敛',
        c1.conflicts === 1 && G.getRelation('e', 'f').affinity === 8, { c1, now: G.getRelation('e', 'f').affinity });
    const c2 = F.pushRelationDelta([{ from: 'e', to: 'f', affinity: 8, tags: [], updatedAt: 3000 }]);
    chk('★ 冲突之后重推同一批 → identical（收敛后幂等）', c2.identical === 1 && c2.updated === 0 && c2.conflicts === 0, c2);
    const c3 = F.pushRelationDelta([{ from: 'e', to: 'f', affinity: 3, tags: [], updatedAt: 3000 }]);
    chk('同时间戳、内容更小 → 不改（tie-break 稳定）', c3.updated === 0 && G.getRelation('e', 'f').affinity === 8, c3);
    const badRows = F.pushRelationDelta([
        { from: 'a', to: 'a', affinity: 1, updatedAt: 4000 },
        { from: 'g', to: 'h', affinity: 1.5, updatedAt: 4000 },
        { from: 'g', to: 'h', affinity: 1, updatedAt: 0 },
    ]);
    chk('坏行被拒并给出原因',
        badRows.rejected.length === 3 && badRows.rejected[0].reason === 'self-relation-refused'
        && badRows.rejected[1].reason === 'affinity-invalid' && badRows.rejected[2].reason === 'updated-at-invalid', badRows.rejected);
    chk('非数组入参被拒', F.pushRelationDelta('nope').reason === 'rows-invalid');
}

// ══════════════════════════════════════════════════════════════════════════
// ⑦ 审计事件确实落库
// ══════════════════════════════════════════════════════════════════════════
console.log('⑦ 审计事件');
{
    const st = G.statsByKind();
    const of = (k) => st.find((s) => s.kind === k)?.count ?? 0;
    chk('federation.grant 有记录（签发/核销/拒绝）', of('federation.grant') >= 5, of('federation.grant'));
    chk('federation.peer 有记录（名片收发与白名单）', of('federation.peer') >= 3, of('federation.peer'));
    chk('federation.relations 有记录（推送）', of('federation.relations') >= 1, of('federation.relations'));
    const rejects = G.sinceEvents(0, { kind: 'federation.grant', limit: 500 }).filter((e) => e.payload?.action === 'reject');
    chk('拒绝也留审计（含 reason）', rejects.length >= 2 && rejects.every((e) => typeof e.payload.reason === 'string'), rejects.map((e) => e.payload.reason));
}

// ══════════════════════════════════════════════════════════════════════════
// ⑧ CoreProtect 导入
// ══════════════════════════════════════════════════════════════════════════
console.log('⑧ CoreProtect 导入');
{
    // 8a 未安装：明确报 not-installed，且一条事件都不写（不假成功）
    const before = G.countEvents();
    const missing = F.importCoreProtect({ dbPath: join(ROOT, 'no-such', 'database.db') });
    chk('★ 库不存在 → ok:false / status=not-installed', missing.ok === false && missing.status === 'not-installed', missing);
    chk('未安装时 0 条事件（不假成功）', G.countEvents() === before && missing.imported === 0);
    chk('体检也是 not-installed', F.coreProtectStatus({ dbPath: join(ROOT, 'no-such', 'database.db') }).status === 'not-installed');

    // 8b 假 CP 库（用**旧表名 co_blocks**，证明两种表名都认）+ 映射表
    const cpDir = join(ROOT, 'cp-fake');
    mkdirSync(cpDir, { recursive: true });
    const cpPath = join(cpDir, 'database.db');
    const cp = new DatabaseSync(cpPath);
    cp.exec(`
        CREATE TABLE co_blocks (time INTEGER, user INTEGER, wid INTEGER, x INTEGER, y INTEGER, z INTEGER,
            type INTEGER, data INTEGER, action INTEGER, rolled_back INTEGER);
        CREATE TABLE co_user (id INTEGER PRIMARY KEY, time INTEGER, user TEXT, uuid TEXT);
        CREATE TABLE co_world (id INTEGER PRIMARY KEY, world TEXT);
        CREATE TABLE co_material_map (id INTEGER PRIMARY KEY, material TEXT);
        CREATE TABLE co_blockdata_map (id INTEGER PRIMARY KEY, data TEXT);
    `);
    cp.prepare('INSERT INTO co_user(id,time,user,uuid) VALUES(1,0,?,?)').run('Alice', 'uuid-a');
    cp.prepare('INSERT INTO co_world(id,world) VALUES(1,?)').run('world');
    cp.prepare('INSERT INTO co_material_map(id,material) VALUES(1,?)').run('minecraft:stone');
    cp.prepare('INSERT INTO co_blockdata_map(id,data) VALUES(1,?)').run('facing=north');
    const insBlock = cp.prepare('INSERT INTO co_blocks(time,user,wid,x,y,z,type,data,action,rolled_back) VALUES(?,?,?,?,?,?,?,?,?,?)');
    insBlock.run(1_700_000_000, 1, 1, 10, 64, 10, 1, 1, 1, 0);   // place
    insBlock.run(1_700_000_001, 1, 1, 10, 64, 10, 1, 0, 0, 0);   // break
    insBlock.run(1_700_000_002, 1, 1, 11, 64, 10, 1, 0, 1, 1);   // place 但已回滚
    cp.close();
    chk('假库体检 installed（认 co_blocks 旧表名）', F.coreProtectStatus({ dbPath: cpPath }).installed === true);
    const dry = F.importCoreProtect({ dbPath: cpPath, dryRun: true, limit: 10, worldId: 'w-20261112-1a2b3c4d' });
    chk('dry-run 不写事件、能看到样本', dry.ok === true && dry.status === 'dry-run' && dry.wouldImport === 3
        && G.countEvents() === before && dry.samples[0].user === 'Alice' && dry.samples[0].block === 'minecraft:stone', dry.status);
    const imp1 = F.importCoreProtect({ dbPath: cpPath, limit: 10, worldId: 'w-20261112-1a2b3c4d' });
    chk('首次导入 3 条', imp1.ok === true && imp1.imported === 3 && imp1.skipped === 0 && imp1.hasMore === false, imp1);
    const ev = G.sinceEvents(0, { kind: 'block-change', limit: 10 });
    chk('事件 kind = block-change 且 payload 名字来自映射表',
        ev.length === 3 && ev[0].kind === 'block-change' && ev[0].payload.block === 'minecraft:stone'
        && ev[0].payload.user === 'Alice' && ev[0].payload.blockData === 'facing=north', ev[0]?.payload);
    chk('action 映射：0=break / 1=place，rolled_back 透传',
        ev[0].payload.action === 'place' && ev[1].payload.action === 'break' && ev[2].payload.rolledBack === true,
        ev.map((e) => [e.payload.action, e.payload.rolledBack]));
    chk('CP 的秒级时间转成毫秒', ev[0].at === 1_700_000_000_000, ev[0].at);
    chk('事件 id 带 source（多库同 rowid 不撞车）', ev.every((e) => e.id.startsWith('cp-coreprotect-')), ev.map((e) => e.id));
    chk('游标推进到 3', F.importCursorOf() === 3, F.importCursorOf());
    const imp2 = F.importCoreProtect({ dbPath: cpPath, limit: 10, worldId: 'w-20261112-1a2b3c4d' });
    chk('★ 再导一次 0 条（游标挡住）', imp2.ok === true && imp2.imported === 0 && G.countEvents() === before + 3, imp2);
    // 游标被清掉也必须幂等：确定性 id + duplicate-id 兜底
    const imp3 = F.importCoreProtect({ dbPath: cpPath, limit: 10, worldId: 'w-20261112-1a2b3c4d', cursor: 0 });
    chk('★ 游标归零重导：3 条全被 duplicate-id 跳过（双保险）',
        imp3.ok === true && imp3.imported === 0 && imp3.skipped === 3 && G.countEvents() === before + 3, imp3);
    chk('游标不会因为重导而倒退', F.importCursorOf() === 3);
    // 新行只导新的
    const cp2 = new DatabaseSync(cpPath);
    cp2.prepare('INSERT INTO co_blocks(time,user,wid,x,y,z,type,data,action,rolled_back) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(1_700_000_010, 1, 1, 12, 64, 10, 1, 0, 0, 0);
    cp2.close();
    const imp4 = F.importCoreProtect({ dbPath: cpPath, limit: 10, worldId: 'w-20261112-1a2b3c4d' });
    chk('新增行只导新增的（游标续跑）', imp4.ok === true && imp4.imported === 1 && imp4.nextCursor === 4, imp4);
    chk('非 CP 库（有表但无 co_block*）→ unrecognized-schema', (() => {
        const other = join(ROOT, 'not-cp', 'x.db');
        mkdirSync(join(ROOT, 'not-cp'), { recursive: true });
        const d = new DatabaseSync(other);
        d.exec('CREATE TABLE something(x TEXT)');
        d.close();
        const r = F.coreProtectStatus({ dbPath: other });
        return r.installed === false && r.status === 'unrecognized-schema';
    })());
    chk('world_id 非法被拒', F.importCoreProtect({ dbPath: cpPath, worldId: '../etc' }).status === 'world-id-invalid');
    chk('source 非法被拒', F.importCoreProtect({ dbPath: cpPath, source: 'bad source!' }).status === 'source-invalid');

    // 8c 真机库（本机装了就核对一次；干净克隆上没有就 SKIP —— 不静默当通过）
    const real = F.coreProtectStatus();
    if (real.installed) {
        const rd = F.importCoreProtect({ dryRun: true, limit: 2 });
        chk('真机 CP 库 dry-run 可用（表名/列名/时间单位都对）',
            rd.ok === true && rd.samples.length === 2 && rd.samples[0].rowid > 0
            && ['place', 'break', 'other'].includes(rd.samples[0].action)
            && typeof rd.samples[0].at === 'number' && rd.samples[0].at > 1_600_000_000_000,
            { table: real.table, rows: real.rows, sample: rd.samples?.[0] });
        console.log(`  NOTE  真机 CP 库：table=${real.table} rows=${real.rows}（只读 dry-run，未写任何事件）`);
    } else {
        console.log(`  SKIP  本机没装 CoreProtect（status=${real.status}，path=${real.path}）——真机库核对跳过`);
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 清理
// ══════════════════════════════════════════════════════════════════════════
console.log('⑨ 清理');
G.closeGlobalDb();
let cleaned = true;
try { rmSync(ROOT, { recursive: true, force: true }); } catch { cleaned = false; }
chk('临时目录清理完成（Windows 上句柄没关会 EPERM）', cleaned || !existsSync(ROOT));

console.warn = realWarn;
console.error = realErr;
console.log(`\n合计：${pass} 通过 / ${fail} 失败（日志：warn ${warns.length} / error ${errs.length}）`);
if (fail) console.log('FAILED');
process.exit(fail ? 1 : 0);
