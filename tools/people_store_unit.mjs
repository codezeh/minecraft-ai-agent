/**
 * people_store 单测（ADR 阶段 2 / D4）：
 *   people 幂等 + 别名累积、avatar 唯一占用、退役可追溯、Ed25519 轮换与验签、
 *   损坏留证（改名 + corrupt 标记）、rev 冲突。
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    emptyPeopleStore, readPeopleStore, writePeopleStore, mutatePeople,
    ensurePerson, findPerson, linkAvatar, retireAvatar, issueAvatarKey,
    activeKeyOf, verifyAvatarSignature, signWithAvatarKey, previewPeople,
    AVATAR_STATE, PERSON_STATE,
} from '../src/mindcraft/people_store.js';

let pass = 0; let fail = 0;
function check(name, cond, detail = '') {
    if (cond) { pass += 1; console.log(`  PASS ${name}`); }
    else { fail += 1; console.log(`  FAIL ${name}${detail ? ` —— ${detail}` : ''}`); }
}

const dir = mkdtempSync(join(tmpdir(), 'mc-people-'));
const file = join(dir, 'people.json');

try {
    // ① 缺失 = 空表，不是崩溃
    const r0 = readPeopleStore(file);
    check('① 文件缺失 → 空表 + ok:false/missing', r0.ok === false && r0.reason === 'missing'
        && r0.store.people.length === 0 && r0.store.rev === 0);

    // ② 建人幂等 + 别名累积
    const a1 = mutatePeople((s) => ensurePerson(s, { name: 'Steve', now: 1 }), { file });
    check('② 首次建人 created:true', a1.ok && a1.result.created === true && a1.result.person.id);
    const pid = a1.result.person.id;
    const a2 = mutatePeople((s) => ensurePerson(s, { name: 'Steve', now: 2 }), { file });
    check('② 同名再建 → created:false 且同 id（幂等）', a2.result.created === false && a2.result.person.id === pid);
    const a3 = mutatePeople((s) => ensurePerson(s, { name: 'Steve_Old', now: 3 }), { file });
    check('② 未知名不会误配到别人', a3.result.created === true);
    // 同一个人换名：用别名认
    const a4 = mutatePeople((s) => {
        const p = findPerson(s, { name: 'Steve' });
        p.aliases = [...(p.aliases ?? []), 'SteveTheMiner'];
        return { store: s, result: p };
    }, { file });
    check('② 别名可反查同一个人', findPerson(a4.store, { name: 'stevethemier' }) === null
        || findPerson(a4.store, { name: 'SteveTheMiner' })?.id === pid);

    // ③ avatar 唯一占用
    const b1 = mutatePeople((s) => linkAvatar(s, { avatarName: 'botA', personId: pid, now: 10 }), { file });
    check('③ 挂 avatar 成功', b1.result.ok === true && b1.result.created === true);
    const b2 = mutatePeople((s) => {
        const other = ensurePerson(s, { name: 'Alex', now: 11 });
        const l = linkAvatar(other.store, { avatarName: 'botA', personId: other.result.person.id, now: 11 });
        return { store: other.store, result: l.result };
    }, { file });
    check('③ 同一 bot 被别人抢 → avatar-taken', b2.result.ok === false && b2.result.reason === 'avatar-taken');

    // ④ 退役可追溯
    const c1 = mutatePeople((s) => retireAvatar(s, { avatarName: 'botA', now: 20 }), { file });
    check('④ 退役 1 条', c1.result.retired === 1);
    check('④ 退役后不再算 active', c1.store.avatars.find((a) => a.name === 'botA')?.state === AVATAR_STATE.RETIRED);
    check('④ 退役记录仍在（可追溯谁的）', previewPeople(c1.store).people.find((p) => p.id === pid)?.avatars.length === 0);

    // ⑤ Ed25519 签发 / 验签 / 轮换
    const avatar = c1.store.avatars.find((a) => a.name === 'botA');
    const d1 = mutatePeople((s) => issueAvatarKey(s, { avatarId: avatar.id, now: 30 }), { file });
    check('⑤ 首次签发 → rotated:0', d1.result.rotated === 0 && activeKeyOf(d1.store, avatar.id));
    const msg = 'hello-federation';
    const sig1 = signWithAvatarKey(d1.store, avatar.id, msg);
    check('⑤ 新钥匙能验签', sig1.ok === true
        && verifyAvatarSignature(d1.store, avatar.id, msg, sig1.signature).ok === true);
    check('⑤ 改内容验不过', verifyAvatarSignature(d1.store, avatar.id, msg + 'x', sig1.signature).ok === false);
    const d2 = mutatePeople((s) => issueAvatarKey(s, { avatarId: avatar.id, now: 40 }), { file });
    check('⑤ 轮换 → 旧钥匙置 rotated', d2.result.rotated === 1
        && d2.store.keys.filter((k) => k.avatar_id === avatar.id && k.state === 'rotated').length === 1);
    check('⑤ 旧签名在轮换后失效（新钥匙验不过）',
        verifyAvatarSignature(d2.store, avatar.id, msg, sig1.signature).ok === false);
    const sig2 = signWithAvatarKey(d2.store, avatar.id, msg);
    check('⑤ 新钥匙签名可用', sig2.ok === true
        && verifyAvatarSignature(d2.store, avatar.id, msg, sig2.signature).ok === true);

    // ⑥ 损坏 → 改名留证 + 不覆盖证据
    writeFileSync(file, '{ this is not json', 'utf8');
    const e1 = readPeopleStore(file);
    check('⑥ 损坏 → corrupt:true + backup 路径', e1.corrupt === true && typeof e1.backup === 'string');
    check('⑥ 坏文件已改名留证', existsSync(e1.backup) === true && existsSync(file) === false);
    const e2 = mutatePeople((s) => ensurePerson(s, { name: 'AfterCrash', now: 50 }), { file });
    check('⑥ 损坏后仍可继续写入（按空表）', e2.ok === true && e2.result.created === true);
    check('⑥ 留证文件没被覆盖', existsSync(e1.backup) === true
        && readdirSync(dir).some((n) => n.includes('.corrupt-')));

    // ⑦ rev 冲突可检出
    const cur = readPeopleStore(file).store;
    const stale = writePeopleStore(file, cur, { expectRev: cur.rev - 1 });
    check('⑦ 过期 rev 写被拒', stale.ok === false && stale.reason === 'conflict');

    // ⑧ 私钥不外泄到预览
    const pv = previewPeople(readPeopleStore(file).store);
    check('⑧ previewPeople 不含私钥字段', !JSON.stringify(pv).includes('priv')
        && !JSON.stringify(pv).includes('BEGIN PRIVATE KEY'));
} finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${fail === 0 ? `ALL PASS: ${pass} passed, 0 failed` : `HAS FAILURES: ${fail} failed, ${pass} passed`}`);
process.exit(fail === 0 ? 0 : 1);
