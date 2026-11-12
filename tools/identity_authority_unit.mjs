/**
 * 决策 A 单测：**people 是权威，identity.json 只是缓存**（ADR 阶段 2 收尾）。
 *
 * 钉住的是"撤销/缺失必须穿透缓存"这一条：哪怕 identity.json 里明明白白写着 owner，
 * 只要 people 里没有这个人、或人被撤销、或缓存与权威对不上 ⇒ **不生效**（fail-closed）
 * 并把原因写进返回值/日志。另含 `!claim` 把人建进 people 的端到端链路。
 *
 * 输出 PASS/FAIL，全过退出码 0（unit_all 自动纳入）。
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = mkdtempSync(path.join(tmpdir(), 'mc-authz-'));
process.env.MC_BOTS_ROOT = ROOT;

const {
    identityFileOf, codesFileOf, writeStore, emptyStore, bindFromCode, issueCodeAtomic, BOUND_LEVEL,
} = await import('../src/mindcraft/identity_store.js');
const {
    mutatePeople, ensurePerson, linkAvatar, retireAvatar, PERSON_STATE, personForAvatar,
} = await import('../src/mindcraft/people_store.js');
const { resolveIdentityAuthority, explainAuthorityReason } = await import('../src/mindcraft/identity_authority.js');
const { LEVEL, resolveLevel } = await import('../src/agent/permissions.js');
const { identityContextOf } = await import('../src/agent/commands/index.js');
const { identityList } = await import('../src/agent/commands/identity.js');

let pass = 0; let fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass += 1; console.log(`  PASS ${name}${detail ? ` ${detail}` : ''}`); }
    else { fail += 1; console.log(`  FAIL ${name}${detail ? ` —— ${detail}` : ''}`); }
};

/** 写一份"缓存"（identity.json）。 */
function bindCache(agentName, { uuid, name, level = BOUND_LEVEL, expired = false }) {
    const now = expired ? Date.now() - 60_000 : Date.now();
    const store = bindFromCode(emptyStore(), {
        uuid, name, level, now, ttlMs: expired ? 1000 : undefined,
    }).store;
    writeStore(identityFileOf(agentName), store);
}

/** 在 people（权威）里把这只 bot 挂给某个人；可选直接置成 revoked。 */
function ownBot(agentName, playerName, { revoked = false } = {}) {
    mutatePeople((store) => {
        const ens = ensurePerson(store, { name: playerName });
        retireAvatar(ens.store, { avatarName: agentName });
        const link = linkAvatar(ens.store, { avatarName: agentName, personId: ens.result.person.id });
        if (revoked) ens.result.person.state = PERSON_STATE.REVOKED;
        return { store: ens.store, result: link.result };
    });
}

try {
    // ── A0 入口本身：没有 agent 名就什么都不判 ──
    check('A0 空 agent ⇒ reason=no-agent（不误判成别人）',
        resolveIdentityAuthority('', { uuid: 'u', name: 'n' }).reason === 'no-agent');

    // ── A1 缓存写着 owner，但 people 里没这人 ⇒ **不生效**（核心 fail-closed） ──
    bindCache('botA', { uuid: 'uuid-owner', name: 'Zeh' });
    const a1 = resolveIdentityAuthority('botA', { uuid: 'uuid-owner', name: 'Zeh' });
    check('A1 ★ 缓存=owner + people 缺失 ⇒ level:null（不生效）', a1.level === null && a1.reason === 'no-people', a1.reason);

    // ── A2 people 有人、但这只 bot 没挂到人 ⇒ 不生效 ──
    mutatePeople((store) => {
        const ens = ensurePerson(store, { name: 'Zeh' });
        return { store: ens.store, result: null };
    });
    const a2 = resolveIdentityAuthority('botA', { uuid: 'uuid-owner', name: 'Zeh' });
    check('A2 ★ people 里没挂这只 bot ⇒ no-person（缓存不生效）', a2.level === null && a2.reason === 'no-person', a2.reason);

    // ── A3 挂上了且对得上 ⇒ owner ──
    ownBot('botA', 'Zeh');
    const a3 = resolveIdentityAuthority('botA', { uuid: 'uuid-owner', name: 'Zeh' });
    check('A3 ★ 权威表对得上 ⇒ 按缓存授 owner', a3.level === 'owner' && a3.reason === 'ok',
        `${a3.level}/${a3.reason}`);
    check('A3b 返回值带上权威里的这个人（面板/话术要用）',
        a3.person?.name === 'Zeh' && a3.person?.state === PERSON_STATE.ACTIVE);

    // ── A4 人一被撤销，缓存立刻不生效（决策 A 的关键穿透） ──
    mutatePeople((store) => {
        const p = store.people.find((x) => x.name === 'Zeh');
        p.state = PERSON_STATE.REVOKED;
        p.revoked_at = Date.now();
        return { store, result: null };
    });
    const a4 = resolveIdentityAuthority('botA', { uuid: 'uuid-owner', name: 'Zeh' });
    check('A4 ★ 人 revoked ⇒ 缓存里的 owner 不生效', a4.level === null && a4.reason === 'person-revoked', a4.reason);

    // ── A5 缓存与权威不是同一个人 ⇒ 不生效 ──
    bindCache('botB', { uuid: 'uuid-bob', name: 'Bob' });
    ownBot('botB', 'Alice');
    const a5 = resolveIdentityAuthority('botB', { uuid: 'uuid-bob', name: 'Bob' });
    check('A5 ★ 缓存说 Bob、权威里是 Alice ⇒ person-mismatch（不生效）',
        a5.level === null && a5.reason === 'person-mismatch', a5.reason);

    // ── A6 别名也算对得上（同一个人换了游戏名） ──
    mutatePeople((store) => {
        const p = store.people.find((x) => x.name === 'Alice');
        p.aliases = ['Bob'];
        return { store, result: null };
    });
    check('A6 别名命中 ⇒ 视为同一个人（不再 mismatch）',
        resolveIdentityAuthority('botB', { uuid: 'uuid-bob', name: 'Bob' }).level === 'owner');

    // ── A7 过期 / 未绑定仍按缓存自己的原因 ──
    bindCache('botC', { uuid: 'uuid-c', name: 'Cara', expired: true });
    ownBot('botC', 'Cara');
    check('A7 缓存过期 ⇒ expired（不是 owner）',
        resolveIdentityAuthority('botC', { uuid: 'uuid-c', name: 'Cara' }).reason === 'expired');
    bindCache('botD', { uuid: 'uuid-d', name: 'Dan' });
    ownBot('botD', 'Dan');
    check('A7b 没绑过 ⇒ unbound',
        resolveIdentityAuthority('botD', { uuid: 'uuid-zzz', name: 'Dan' }).reason === 'unbound');

    // ── A8 people.json 损坏 ⇒ people-corrupt（fail-closed，不是"照授"） ──
    const badPeople = path.join(ROOT, 'bad-people.json');
    writeFileSync(badPeople, '{ this is not json', 'utf8');
    const a8 = resolveIdentityAuthority('botA', { uuid: 'uuid-owner', name: 'Zeh' }, { peopleFile: badPeople });
    check('A8 ★ people 损坏 ⇒ people-corrupt（fail-closed）',
        a8.level === null && a8.reason === 'people-corrupt', a8.reason);

    // ── A9 权限判定真的走它（不是只在单测里能调） ──
    const perms = { owner: 'Zeh', trusted: [] };
    const mkAgent = (name, author, uuid) => ({
        name, prompter: { profile: { permissions: perms } },
        bot: { username: name, players: author ? { [author]: { uuid } } : {} },
    });
    // botE：缓存 owner，但 people 里没挂 ⇒ guest
    bindCache('botE', { uuid: 'uuid-zed', name: 'Zed' });
    const ctxE = identityContextOf(mkAgent('botE', 'Zed', 'uuid-zed'));
    const lvlE = resolveLevel({ author: 'Zed', uuid: 'uuid-zed', permissions: perms, identity: ctxE });
    check('A9 ★ 权限判定走权威：people 里没挂 ⇒ guest（哪怕缓存写 owner）',
        lvlE === LEVEL.OTHER && ctxE.peek()?.reason === 'no-person', `${lvlE}/${ctxE.peek()?.reason}`);
    // 挂上之后同一个 agent ⇒ owner
    ownBot('botE', 'Zed');
    const ctxE2 = identityContextOf(mkAgent('botE', 'Zed', 'uuid-zed'));
    check('A9b 挂到人之后 ⇒ owner（同一份缓存，权威变了判定就变）',
        resolveLevel({ author: 'Zed', uuid: 'uuid-zed', permissions: perms, identity: ctxE2 }) === LEVEL.OWNER);

    // ── A10 撤销穿透到权限层（这一条就是决策 A 的验收） ──
    mutatePeople((store) => {
        const p = store.people.find((x) => x.name === 'Zed');
        p.state = PERSON_STATE.REVOKED;
        return { store, result: null };
    });
    const ctxE3 = identityContextOf(mkAgent('botE', 'Zed', 'uuid-zed'));
    check('A10 ★ people 撤销 ⇒ 立刻降级 guest（不用解绑/重启）',
        resolveLevel({ author: 'Zed', uuid: 'uuid-zed', permissions: perms, identity: ctxE3 }) === LEVEL.OTHER
        && ctxE3.peek()?.reason === 'person-revoked', String(ctxE3.peek()?.reason));

    // ── A11 `!claim` 把人建进 people（否则新装机器 claim 完仍不生效） ──
    const claim = identityList.find((c) => c.name === '!claim');
    const AG = 'botF';
    issueCodeAtomic(codesFileOf(AG), { code: 'AAAA-BBBB', agent: AG, sessionId: 's1' });
    const msg = claim.perform({
        name: AG, command_author: 'Fay',
        bot: { username: AG, players: { Fay: { uuid: 'uuid-fay' } } },
    }, 'AAAA-BBBB');
    const owned = personForAvatar(
        (await import('../src/mindcraft/people_store.js')).readPeopleStore().store, AG,
    );
    check('A11 ★ !claim 成功并把人+avatar 建进 people', /绑定成功/.test(msg) && owned?.person?.name === 'Fay', msg.slice(0, 40));
    const ctxF = identityContextOf(mkAgent(AG, 'Fay', 'uuid-fay'));
    check('A11b claim 之后权限判定立刻给 owner（缓存+权威都在）',
        resolveLevel({ author: 'Fay', uuid: 'uuid-fay', permissions: perms, identity: ctxF }) === LEVEL.OWNER);

    // ── A12 分身已归别人时 `!claim` 拒绝，且**不烧码** ──
    issueCodeAtomic(codesFileOf(AG), { code: 'CCCC-DDDD', agent: AG, sessionId: 's2' });
    const msg2 = claim.perform({
        name: AG, command_author: 'Gus',
        bot: { username: AG, players: { Gus: { uuid: 'uuid-gus' } } },
    }, 'CCCC-DDDD');
    const codesLeft = (await import('../src/mindcraft/identity_store.js')).readStore(codesFileOf(AG)).store.codes;
    check('A12 ★ 分身归别人 ⇒ claim 拒绝且码没被核销',
        /已经挂在/.test(msg2) && codesLeft.some((c) => c.code === 'CCCC-DDDD'), msg2.slice(0, 40));

    // ── A13 每条失败原因都有人话（面板/话术不会显示空字符串） ──
    const reasons = ['unbound', 'expired', 'no-people', 'people-corrupt', 'no-person', 'person-revoked', 'person-mismatch'];
    check('A13 所有失败原因都有中文解释', reasons.every((r) => {
        const t = explainAuthorityReason(r);
        return typeof t === 'string' && t.length > 3 && !t.startsWith('未知原因');
    }));
} finally {
    try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${fail === 0 ? `ALL PASS: ${pass} passed, 0 failed` : `HAS FAILURES: ${fail} failed, ${pass} passed`}`);
process.exit(fail === 0 ? 0 : 1);
