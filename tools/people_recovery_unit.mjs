/**
 * 恢复码单测（ADR 阶段 2 收尾 / D4）：人丢了分身怎么找回。
 *
 * 钉住四条硬约束：**只存 sha256**（表里/预览里都没有明文）、**带过期**、**单次使用**、
 * 核销后把当前 bot 挂到该 person（旧 avatar 置 retired）。失败路径一律**不改状态**。
 *
 * 输出 PASS/FAIL，全过退出码 0。
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = mkdtempSync(path.join(tmpdir(), 'mc-recover-'));
process.env.MC_BOTS_ROOT = ROOT;

const {
    peopleFileOf, readPeopleStore, writePeopleStore, mutatePeople, ensurePerson, linkAvatar, retireAvatar,
    personForAvatar, makeRecoveryCode, hashRecoveryCode, normalizeRecoveryCode, addRecoveryCode,
    consumeRecoveryCode, revokeRecoveryCodes, previewRecoveries, recoverAvatar,
    DEFAULT_RECOVERY_TTL_MS, MAX_RECOVERY_TTL_MS, PERSON_STATE, AVATAR_STATE,
} = await import('../src/mindcraft/people_store.js');
const {
    identityFileOf, readStore, issueCodeAtomic, codesFileOf,
} = await import('../src/mindcraft/identity_store.js');
const { identityList } = await import('../src/agent/commands/identity.js');
const { LEVEL, canRunCommand } = await import('../src/agent/permissions.js');

let pass = 0; let fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass += 1; console.log(`  PASS ${name}${detail ? ` ${detail}` : ''}`); }
    else { fail += 1; console.log(`  FAIL ${name}${detail ? ` —— ${detail}` : ''}`); }
};

const setPersonState = (name, state) => mutatePeople((store) => {
    const p = store.people.find((x) => x.name === name);
    if (p) p.state = state;
    return { store, result: null };
}, { file: peopleFileOf() });

const ownBot = (agentName, playerName) => mutatePeople((store) => {
    const ens = ensurePerson(store, { name: playerName });
    retireAvatar(ens.store, { avatarName: agentName });
    const link = linkAvatar(ens.store, { avatarName: agentName, personId: ens.result.person.id });
    return { store: ens.store, result: link.result };
}, { file: peopleFileOf() });

try {
    // ── R1 码形：XXXX-XXXX-XXXX，去混淆字母表 ──
    const det = makeRecoveryCode((n) => new Array(n).fill(0));
    check('R1 恢复码形如 XXXX-XXXX-XXXX 且不含易混字符 0/O/1/I/L',
        /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(det) && !/[01OIL]/.test(det.replace(/-/g, '')), det);
    check('R1b 规范化：大小写/空格/连字符都不影响',
        normalizeRecoveryCode(' abcd-efgh-jkmn ') === 'ABCDEFGHJKMN');

    // ── R2 只存 sha256 ──
    check('R2 哈希 = sha256(规范化码)，64 位十六进制',
        hashRecoveryCode('abcd-efgh-jkmn') === hashRecoveryCode('ABCD EFGH JKMN')
        && /^[0-9a-f]{64}$/.test(hashRecoveryCode('ABCD-EFGH-JKMN')));
    check('R2b 不同码哈希不同（不然等于一个万能码）',
        hashRecoveryCode('ABCD-EFGH-JKMN') !== hashRecoveryCode('ABCD-EFGH-JKMP'));

    // ── R3 落盘：带过期、**没有明文** ──
    mutatePeople((store) => {
        const ens = ensurePerson(store, { name: 'Steve' });
        return { store: ens.store, result: null };
    }, { file: peopleFileOf() });
    const steve = readPeopleStore(peopleFileOf()).store.people.find((p) => p.name === 'Steve');
    const now = Date.now();
    const added = mutatePeople((store) => {
        const r = addRecoveryCode(store, { personId: steve.id, code: 'ABCD-EFGH-JKMN', now, createdBy: 'panel' });
        return r.result.ok ? { store: r.store, result: r.result.record } : null;
    }, { file: peopleFileOf() });
    check('R3 签发成功', added.ok && added.result?.expires_at === now + DEFAULT_RECOVERY_TTL_MS);
    check('R3b 记录里只有 sha256（hash 字段 = 该码的哈希）',
        added.result?.hash === hashRecoveryCode('ABCD-EFGH-JKMN') && !('code' in (added.result ?? {})));
    {
        const disk = readFileSync(peopleFileOf(), 'utf8');
        check('R3c ★ people.json 里搜不到恢复码明文', !disk.includes('ABCD-EFGH-JKMN')
            && !disk.includes('ABCDEFGHJKMN'));
        const overTtl = mutatePeople((store) => {
            const r = addRecoveryCode(store, {
                personId: steve.id, code: 'ZZZZ-ZZZZ-ZZZZ', now, ttlMs: 999 * 24 * 3600_000,
            });
            return r.result.ok ? { store: r.store, result: r.result.record } : null;
        }, { file: peopleFileOf() });
        check('R3d TTL 有硬上限（传 999 天也只到 ' + (MAX_RECOVERY_TTL_MS / 3600000) + ' 小时）',
            overTtl.result.expires_at - now === MAX_RECOVERY_TTL_MS);
    }

    // ── R4 重签 ⇒ 旧码作废（同一个人只留最新一个未用码） ──
    const pendingNow = readPeopleStore(peopleFileOf()).store.recoveries
        .filter((r) => r.person_id === steve.id && !Number(r.used_at));
    check('R4 同一个人重签后只剩 1 个未用码', pendingNow.length === 1);

    // ── R5 单次使用 ──
    const issued = mutatePeople((store) => {
        const r = addRecoveryCode(store, { personId: steve.id, code: 'MMMM-NNNN-PPPP', now: Date.now() });
        return r.result.ok ? { store: r.store, result: null } : null;
    }, { file: peopleFileOf() });
    check('R5 签发新码', issued.ok);
    const c1 = mutatePeople((store) => {
        const r = consumeRecoveryCode(store, { code: 'MMMM-NNNN-PPPP' });
        return r.ok ? { store: r.store, result: r.person?.name ?? null } : null;
    }, { file: peopleFileOf() });
    check('R5b 首次核销成功且能定位到这个人', c1.ok && c1.result === 'Steve');
    const c2 = mutatePeople((store) => {
        const r = consumeRecoveryCode(store, { code: 'MMMM-NNNN-PPPP' });
        return r.ok ? { store: r.store, result: null } : null;
    }, { file: peopleFileOf() });
    check('R5c ★ 同一个码再用一次失败（一次性）', c2.skipped === true);

    // ── R6 过期 ──
    mutatePeople((store) => {
        addRecoveryCode(store, { personId: steve.id, code: 'QQQQ-RRRR-SSSS', now: Date.now() });
        return { store, result: null };
    }, { file: peopleFileOf() });
    {
        const store = readPeopleStore(peopleFileOf()).store;
        const rec = store.recoveries.find((r) => r.hash === hashRecoveryCode('QQQQ-RRRR-SSSS'));
        rec.expires_at = Date.now() - 1;                  // 手工置过期：模拟"放了一夜"
        writePeopleStore(peopleFileOf(), store, { expectRev: store.rev });
    }
    const c3 = mutatePeople((store) => {
        const r = consumeRecoveryCode(store, { code: 'QQQQ-RRRR-SSSS' });
        return r.ok ? { store: r.store, result: null } : null;
    }, { file: peopleFileOf() });
    check('R6 ★ 过期码核销失败（不会因为"存在过"一直有效）', c3.skipped === true);

    // ── R7 人被撤销 ⇒ 码不能用，也不烧掉（恢复后还能用） ──
    setPersonState('Steve', PERSON_STATE.REVOKED);
    mutatePeople((store) => {
        addRecoveryCode(store, { personId: steve.id, code: 'TTTT-UUUU-VVVV', now: Date.now() });
        return { store, result: null };
    }, { file: peopleFileOf() });
    const c4 = mutatePeople((store) => {
        const r = consumeRecoveryCode(store, { code: 'TTTT-UUUU-VVVV' });
        return r.ok ? { store: r.store, result: true } : null;
    }, { file: peopleFileOf() });
    const stillUnused = readPeopleStore(peopleFileOf()).store.recoveries
        .find((r) => r.hash === hashRecoveryCode('TTTT-UUUU-VVVV'));
    check('R7 ★ 人 revoked ⇒ 核销失败', c4.skipped === true);
    check('R7b 失败不烧码（used_at 仍为空 ⇒ 重新启用后还能用）', !Number(stillUnused?.used_at));
    setPersonState('Steve', PERSON_STATE.ACTIVE);

    // ── R8 核销后改挂：旧 avatar 退役、当前 bot 归该 person ──
    ownBot('botR', 'Bob');
    const beforeBotR = personForAvatar(readPeopleStore(peopleFileOf()).store, 'botR');
    check('R8 前置：botR 原来归 Bob', beforeBotR?.person?.name === 'Bob');
    mutatePeople((store) => {
        addRecoveryCode(store, { personId: steve.id, code: 'WWWW-XXXX-YYYY', now: Date.now() });
        return { store, result: null };
    }, { file: peopleFileOf() });
    const rec = mutatePeople((store) => {
        const r = recoverAvatar(store, { code: 'WWWW-XXXX-YYYY', avatarName: 'botR', actorName: 'Steve_New' });
        return r.result.ok ? { store: r.store, result: r.result } : null;
    }, { file: peopleFileOf() });
    check('R8b ★ 恢复成功：botR 现在归 Steve', rec.ok
        && personForAvatar(readPeopleStore(peopleFileOf()).store, 'botR')?.person?.name === 'Steve');
    check('R8c ★ 旧 avatar 记录退役（可追溯），不是删掉', rec.result?.retired === 1
        && readPeopleStore(peopleFileOf()).store.avatars
            .some((a) => a.name === 'botR' && a.state === AVATAR_STATE.RETIRED));
    check('R8d 别名累积：恢复时的名字记进这个人',
        readPeopleStore(peopleFileOf()).store.people.find((p) => p.name === 'Steve')
            ?.aliases?.includes('Steve_New') === true);

    // ── R9 面板作废 ──
    mutatePeople((store) => {
        addRecoveryCode(store, { personId: steve.id, code: 'AAAA-BBBB-CCCC', now: Date.now() });
        return { store, result: null };
    }, { file: peopleFileOf() });
    const rev = mutatePeople((store) => {
        const r = revokeRecoveryCodes(store, { personId: steve.id });
        return r.result.removed ? { store: r.store, result: r.result.removed } : null;
    }, { file: peopleFileOf() });
    check('R9 作废后未用码清空', rev.ok && rev.result >= 1
        && previewRecoveries(readPeopleStore(peopleFileOf()).store).every((r) => r.person_id !== steve.id));

    // ── R10 预览不含哈希/明文 ──
    const pv = previewRecoveries(readPeopleStore(peopleFileOf()).store);
    check('R10 预览只给元数据（无 hash、无明文码）',
        !JSON.stringify(pv).includes('hash') && !JSON.stringify(pv).includes('ABCD'));

    // ── R11 `!recover` 端到端 ──
    const cmd = identityList.find((c) => c.name === '!recover');
    check('R11 !recover 已注册成命令', !!cmd && typeof cmd.perform === 'function');
    check('R11b !recover 对 guest 也放行（丢分身的人还没身份）',
        canRunCommand(LEVEL.OTHER, '!recover') === true);
    ownBot('botS', 'Bob');
    const issuedCode = mutatePeople((store) => {
        const r = addRecoveryCode(store, { personId: steve.id, code: 'EEEE-FFFF-GGGG', now: Date.now() });
        return r.result.ok ? { store: r.store, result: null } : null;
    }, { file: peopleFileOf() });
    check('R11c 前置：恢复码已签发', issuedCode.ok);
    const mkAgent = (author) => ({
        name: 'botS', command_author: author,
        bot: { username: 'botS', players: { [author]: { uuid: 'uuid-steve' } } },
    });
    const okMsg = cmd.perform(mkAgent('Steve'), 'eeee ffff gggg');
    check('R11d ★ 恢复成功（大小写/空格不敏感）', /恢复成功/.test(okMsg), okMsg.slice(0, 40));
    check('R11e 恢复后落了 owner 绑定缓存',
        readStore(identityFileOf('botS')).store.bindings.some((b) => b.level === 'owner' && b.name === 'Steve'));
    const again = cmd.perform(mkAgent('Steve'), 'EEEE-FFFF-GGGG');
    check('R11f ★ 同一个恢复码不能再用', /无效|过期/.test(again), again.slice(0, 40));

    // ── R12 面板接线：身份状态新增人表字段 + 三个新事件（不改旧字段） ──
    const src = readFileSync(new URL('../src/mindcraft/mindserver.js', import.meta.url), 'utf8');
    check('R12 identity-status 新增 people/recoveries/thisBotPerson 字段',
        /people: peoplePreview\.people/.test(src) && /recoveries: previewRecoveries/.test(src)
        && /thisBotPerson:/.test(src));
    check('R12b 旧字段形状没动（pendingCodes / bindings / corrupt / backup 仍在）',
        /pendingCodes: st\.codes\.map/.test(src) && /bindings,\n/.test(src)
        && /corrupt: idRead\.corrupt === true/.test(src) && /backup: idRead\.backup \?\? null/.test(src));
    check('R12c 三个新事件都在（生成恢复码 / 作废 / 改挂 avatar）',
        /socket\.on\('identity-recovery-issue'/.test(src)
        && /socket\.on\('identity-recovery-revoke'/.test(src)
        && /socket\.on\('identity-avatar-relink'/.test(src));
    check('R12d 新事件只给面板 + 有独立限流',
        /identity-recovery-issue'[\s\S]{0,900}takeToken\(socket, 'identity-recovery-issue'/.test(src)
        && /identity-avatar-relink'[\s\S]{0,900}takeToken\(socket, 'identity-avatar-relink'/.test(src)
        && (src.match(/panel_only/g) || []).length >= 6);
} finally {
    try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${fail === 0 ? `ALL PASS: ${pass} passed, 0 failed` : `HAS FAILURES: ${fail} failed, ${pass} passed`}`);
process.exit(fail === 0 ? 0 : 1);
