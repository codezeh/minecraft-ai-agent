/**
 * 阶段 2 切片 2 单测：`!invite` / `!revoke` 的权限闸门与**顺序**。
 *
 * 重点不是"能加白名单"，而是：
 *   ① 非 owner / 未绑定 → 拒绝，且白名单与人表都不动
 *   ② 白名单失败 → 人表**不写**（不许出现"表里邀请了、服务端没加"的假记录）
 *   ③ 白名单成功 → 人才记进表，且绑定 owner 与邀请人
 *   ④ 撤销时白名单失败 → 状态不变
 *   ⑤ 服务端回执分类：认不出的文案必须算失败
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'mc-invite-'));
process.env.MC_BOTS_ROOT = join(root, 'bots').replace(/\\/g, '/');
mkdirSync(process.env.MC_BOTS_ROOT, { recursive: true });

const { classifyWhitelistReply, readRconConfig } = await import('../src/agent/library/whitelist_gate.js');
const { invite, revoke, ownerGate } = await import('../src/agent/commands/identity.js');
const { identityFileOf, writeStore, emptyStore, bindFromCode, BOUND_LEVEL } = await import('../src/mindcraft/identity_store.js');
const { readPeopleStore, findPerson, PERSON_STATE, mutatePeople, ensurePerson, linkAvatar, retireAvatar, personForAvatar } = await import('../src/mindcraft/people_store.js');

let pass = 0; let fail = 0;
function check(name, cond, detail = '') {
    if (cond) { pass += 1; console.log(`  PASS ${name}`); }
    else { fail += 1; console.log(`  FAIL ${name}${detail ? ` —— ${detail}` : ''}`); }
}

const mkAgent = (name, author) => ({
    name,
    command_author: author,
    bot: { username: name, players: author ? { [author]: { uuid: `uuid-${author}` } } : {} },
});

/** 把这只 bot 硬挂到某个人名下（退役旧记录）——模拟"这只分身归谁"。 */
function hardLink(agentName, playerName) {
    const r = mutatePeople((store) => {
        const ens = ensurePerson(store, { name: playerName });
        retireAvatar(ens.store, { avatarName: agentName });
        const link = linkAvatar(ens.store, { avatarName: agentName, personId: ens.result.person.id });
        return { store: ens.store, result: link.result };
    });
    return r.result;
}

function bindOwner(agentName, playerName) {
    const file = identityFileOf(agentName);
    const base = emptyStore();
    const r = bindFromCode(base, {
        code: 'AAAA-BBBB', uuid: `uuid-${playerName}`, name: playerName,
        level: BOUND_LEVEL, agent: agentName, now: Date.now(),
    });
    writeStore(file, r?.store ?? r, { expectRev: 0 });
    // ★ 决策 A：people 是权威 —— 人表里没有这个人/这只 avatar，缓存里的 owner 不生效
    hardLink(agentName, playerName);
}

try {
    // ── ⑤ 回执分类 ──
    check('⑤ add 成功', classifyWhitelistReply('add', 'Added Steve to the whitelist').ok === true);
    check('⑤ remove 成功', classifyWhitelistReply('remove', 'Removed Steve from the whitelist').ok === true);
    check('⑤ add 幂等', classifyWhitelistReply('add', 'Player Steve is already whitelisted').ok === true);
    check('⑤ remove 幂等', classifyWhitelistReply('remove', 'Player Steve is not whitelisted').ok === true);
    check('⑤ 不存在 → 失败', classifyWhitelistReply('add', 'That player does not exist').ok === false);
    check('⑤ 空回执 → 失败', classifyWhitelistReply('add', '').ok === false);
    check('⑤ 认不出的文案 → 失败（不假成功）',
        classifyWhitelistReply('add', 'Unknown command. Type "/help"').ok === false);

    // ── readRconConfig ──
    const srv = join(root, 'server');
    mkdirSync(srv, { recursive: true });
    const cfgFile = join(srv, 'server.properties');
    check('readRconConfig：没有文件 → 失败', readRconConfig(srv).ok === false);
    writeFileSync(cfgFile, 'enable-rcon=false\nrcon.password=x\n');
    check('readRconConfig：enable-rcon 非 true → 失败', readRconConfig(srv).ok === false);
    writeFileSync(cfgFile, 'enable-rcon=true\nrcon.password=\n');
    check('readRconConfig：口令为空 → 失败', readRconConfig(srv).ok === false);
    writeFileSync(cfgFile, 'enable-rcon=true\nrcon.password=abc123\nrcon.port=25575\n');
    const okCfg = readRconConfig(srv);
    check('readRconConfig：正常 → ok + port/password', okCfg.ok === true && okCfg.port === 25575 && okCfg.password === 'abc123');

    // ── ① 未绑定 → 拒绝 ──
    const stranger = mkAgent('botX', 'Stranger');
    const g0 = ownerGate(stranger);
    check('① 未绑定 → 拒绝且提示先 claim', g0.ok === false && g0.say.includes('!claim'));
    // 断言更严：不只查措辞，还要求**白名单一次都没被调用**
    let called = 0;
    const r1 = await invite(stranger, 'Friend', async () => { called += 1; return { ok: true }; });
    check('① 未绑定时 invite 拒绝且完全不碰白名单',
        called === 0 && r1.includes('还没绑定'), `${r1}（调用次数=${called}）`);

    // ── ② 白名单失败 → 人表不写 ──
    bindOwner('botA', 'Steve');
    const steve = mkAgent('botA', 'Steve');
    check('ownerGate：owner 通过', ownerGate(steve).ok === true);
    const r2 = await invite(steve, 'Bob', async () => ({ ok: false, reason: 'rcon 认证失败', reply: 'auth failed' }));
    check('② 白名单失败 → 明确说没生效', r2.includes('没有生效') && r2.includes('rcon 认证失败'), r2);
    check('② 白名单失败 → 人表里没有 Bob', findPerson(readPeopleStore().store, { name: 'Bob' }) === null);

    // ── ③ 白名单成功 → 记人 + 绑定 ──
    const r3 = await invite(steve, 'Bob', async () => ({ ok: true, reply: 'Added Bob to the whitelist' }));
    check('③ 成功话术含"已邀请"', r3.includes('已邀请'), r3);
    const bob = findPerson(readPeopleStore().store, { name: 'Bob' });
    check('③ 人表里出现 Bob 且 state=active', !!bob && bob.state === PERSON_STATE.ACTIVE);
    check('③ 记录邀请人 = Steve', bob?.invited_by === 'Steve');
    const st3 = readPeopleStore().store;
    // ★ 决策 A：邀请**不**改分身归属（否则邀请一次就把 bot 判给别人，owner 立刻失去权威）
    const owned3 = personForAvatar(st3, 'botA');
    check('③ 邀请不改归属：botA 仍归 Steve', owned3?.person?.name === 'Steve', JSON.stringify(owned3?.person?.name ?? null));
    check('③ 重复邀请同一个人 → 不新建第二个 Bob',
        (readPeopleStore().store.people.filter((p) => p.name === 'Bob').length) === 1
        && (await invite(steve, 'Bob', async () => ({ ok: true }))).includes('已邀请'));

    // ── ④ 撤销：白名单失败 → 状态不变 ──
    const r4 = await revoke(steve, 'Bob', async () => ({ ok: false, reason: 'rcon timeout' }));
    check('④ 撤销失败 → 明确说没生效', r4.includes('没有生效'), r4);
    check('④ 撤销失败 → Bob 仍是 active',
        findPerson(readPeopleStore().store, { name: 'Bob' })?.state === PERSON_STATE.ACTIVE);

    // ── ④b 撤销成功 → revoked 且保留记录 ──
    const r5 = await revoke(steve, 'Bob', async () => ({ ok: true, reply: 'Removed Bob from the whitelist' }));
    check('④ 撤销成功话术', r5.includes('已撤销'), r5);
    const bobAfter = findPerson(readPeopleStore().store, { name: 'Bob' });
    check('④ 状态变 revoked 且记录仍在', bobAfter?.state === PERSON_STATE.REVOKED && !!bobAfter.revoked_at);
    check('④ 撤销人也记下来', bobAfter?.revoked_by === 'Steve');

    // ── ⑤ 非 owner 等级被拒 ──
    const file = identityFileOf('botA');
    const base = emptyStore();
    const r6 = bindFromCode(base, {
        code: 'CCCC-DDDD', uuid: 'uuid-Guest', name: 'Guest',
        level: 'guest', agent: 'botA', now: Date.now(),
    });
    writeStore(file, r6?.store ?? r6, { expectRev: readPeopleStore(file) ? undefined : 0 });
    // 权威人表里这只 bot 现在归 Guest（level 仍是 guest，用来验"等级不够"而不是"没绑定"）
    hardLink('botA', 'Guest');
    const guest = mkAgent('botA', 'Guest');
    const gg = ownerGate(guest);
    check('⑤ 非 owner（guest）→ 拒绝', gg.ok === false && gg.say.includes('只给 owner'), gg.say);
} finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${fail === 0 ? `ALL PASS: ${pass} passed, 0 failed` : `HAS FAILURES: ${fail} failed, ${pass} passed`}`);
process.exit(fail === 0 ? 0 : 1);
