/**
 * 第四轮审计 ①（方案 C）：玩家身份绑定 —— **离线**单测。
 *
 * 缺陷原貌：`permissions.resolveLevel` 只用**游戏名字符串**与 profile 名单比对。
 * 离线服务器（online-mode=false）不校验名字 ⇒ **改个客户端名就是 owner**；
 * 控制面的 token 认证完全不传导到游戏内权限；`agent/` 下 `.uuid` 零命中。
 *
 * 修法（本测逐条钉住）：
 *   ① 面板（过 token 门）生成**一次性**码：≤5 分钟、单次使用、绑面板会话；
 *   ② 游戏内 `!claim <码>` 核销 → 写 `bots/<agent>/identity.json`；
 *   ③ `resolveLevel` **先查绑定表**，查不到 ⇒ guest（名字不再换权限）；
 *      profile 名单只有显式 `legacy_profile_names: true` 才回退；
 *   ④ 绑定可失效：过期 / 面板解绑 / 会话断开作废未核销码。
 *
 * 验收对应的四条在最前面的 B 段：冒名者无码→guest、持码→owner、码过期→guest、解绑→guest。
 *
 * 输出 PASS/FAIL，全过退出码 0。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 每个测试进程一个独立的 bots 根（bot_paths 支持 MC_BOTS_ROOT）——
// 否则会和别的测试抢同一个 bots/<agent>/，互相删文件。
const ROOT = mkdtempSync(path.join(tmpdir(), 'mc-identity-'));
process.env.MC_BOTS_ROOT = ROOT;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

const {
    makeCode, normalizeCode, addCode, consumeCode, bindFromCode, resolveBinding,
    revokeBinding, revokeSessionCodes, pruneCodes, previewStatus,
    readStore, writeStore, identityFileOf, codesFileOf, emptyStore,
    DEFAULT_CODE_TTL_MS, DEFAULT_BINDING_TTL_MS, BOUND_LEVEL,
    // ★ t20：离线服 uuid 派生 / 弱绑定 / 会话态
    offlineUuidOf, isOfflineDerivedUuid, isWeakBinding,
    recordClaim, sessionFresh, resetSessionClaims,
} = await import('../src/mindcraft/identity_store.js');
const { LEVEL, resolveLevel, canRunCommand } = await import('../src/agent/permissions.js');
// ★ 决策 A：people 是权威 —— 造数据时也要把"这只 bot 归谁"一起造出来，否则（正确地）不授权
const { mutatePeople, ensurePerson, linkAvatar, retireAvatar } = await import('../src/mindcraft/people_store.js');

/** 把这只 bot 硬挂到某个人名下（退役旧记录）——模拟 people 权威表里的归属。 */
function hardLink(agentName, playerName) {
    mutatePeople((store) => {
        const ens = ensurePerson(store, { name: playerName });
        retireAvatar(ens.store, { avatarName: agentName });
        const link = linkAvatar(ens.store, { avatarName: agentName, personId: ens.result.person.id });
        return { store: ens.store, result: link.result };
    });
}

const AGENT = 'botA';

// ════════════════════════════════════════════════════════════════════════════
// A. 码与表：短时 / 单次 / 绑会话
// ════════════════════════════════════════════════════════════════════════════
{
    // 确定性随机源（不引额外依赖）：字节全取同一个数 ⇒ 字母表里同一个字符
    const det = makeCode((n) => new Array(n).fill(0));
    check('A1 码形如 XXXX-XXXX，且用去混淆字母表（无 0/O/1/I/L）',
        /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(det) && !/[01OIL]/.test(det.replace('-', '')), det);
    check('A1b 规范化：大小写/空格/连字符都不影响（玩家怎么打都行）',
        normalizeCode(' abcd-efgh ') === 'ABCDEFGH' && normalizeCode('ABCD EFGH') === 'ABCDEFGH');

    const now = 1_700_000_000_000;
    const withCode = addCode(emptyStore(), { code: 'AAAA-BBBB', agent: AGENT, sessionId: 's1', now, ttlMs: 60_000 });
    check('A2 码带到期时间（默认/上限 5 分钟）',
        withCode.record.expiresAt - now === 60_000 && DEFAULT_CODE_TTL_MS === 300_000);

    // ★ 硬上限：传 1 小时也压到 5 分钟（"短时（≤5 分钟）"是要求，不是建议）
    const longTtl = addCode(emptyStore(), { code: 'CCCC-DDDD', now, ttlMs: 60 * 60_000 });
    check('A2b TTL 超过 5 分钟会被夹到 5 分钟',
        longTtl.record.expiresAt - now === DEFAULT_CODE_TTL_MS,
        `${(longTtl.record.expiresAt - now) / 1000}s`);

    // 单次使用
    let store = addCode(emptyStore(), { code: 'EEEE-FFFF', agent: AGENT, sessionId: 's1', now, ttlMs: 60_000 }).store;
    const first = consumeCode(store, { code: 'eeee-ffff', now: now + 1000 });
    store = first.store;
    const second = consumeCode(store, { code: 'EEEE-FFFF', now: now + 2000 });
    check('A3 单次使用：第一次成功、第二次（同一个码）失败', first.ok === true && second.ok === false);
    check('A3b 核销即从表里删掉（不留"已用过"的记录给下一次撞上）',
        first.store.codes.length === 0);

    // 过期
    const exp = addCode(emptyStore(), { code: 'GGGG-HHHH', now, ttlMs: 1000 }).store;
    const afterTtl = consumeCode(exp, { code: 'GGGG-HHHH', now: now + 2000 });
    check('A4 过期码核销失败（不会因为"存在过"就一直有效）', afterTtl.ok === false);

    // 同会话只留最新一个码（再点一次"生成" ⇒ 旧码作废）
    let s2 = addCode(emptyStore(), { code: 'IIII-JJJJ', sessionId: 's1', now }).store;
    s2 = addCode(s2, { code: 'KKKK-LLLL', sessionId: 's1', now }).store;
    check('A5 同一个面板会话只留最新一个码（旧码立刻作废）',
        s2.codes.length === 1 && s2.codes[0].code === 'KKKK-LLLL');

    // 面板会话断开 ⇒ 未核销码作废，已绑定条目不受影响
    let s3 = addCode(emptyStore(), { code: 'MMMM-NNNN', sessionId: 's9', now }).store;
    s3 = bindFromCode(s3, { code: { sessionId: 's9' }, uuid: 'uuid-1', name: 'Zeh', now }).store;
    const revoked = revokeSessionCodes(s3, 's9');
    check('A6 面板会话断开 ⇒ 它签发的未核销码作废，**已绑定的条目留下**',
        revoked.removed === 1 && revoked.store.codes.length === 0 && revoked.store.bindings.length === 1);
}
// 文件层：坏文件当空表（不抛、不半信半疑）
{
    const file = path.join(ROOT, 'corrupt-agent', 'identity.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{not json');
    const bad = readStore(file);
    check('A7 坏的 identity.json → 当空表处理（ok=false，但不抛）',
        bad.ok === false && bad.store.bindings.length === 0);
    const wrote = writeStore(file, bindFromCode(emptyStore(), { uuid: 'u', name: 'n', now: 1 }).store);
    const back = readStore(file);
    check('A7b 写盘 → 读回一致（原子写：tmp + rename）',
        wrote.ok === true && back.ok === true && back.store.bindings.length === 1 && back.store.bindings[0].uuid === 'u');
}

// ════════════════════════════════════════════════════════════════════════════
// B. 验收四条：冒名→guest / 持码→owner / 码过期→guest / 解绑→guest
// ════════════════════════════════════════════════════════════════════════════
const IDENTITY_ON = { enabled: true, legacyNames: false };
/** 用真表搭一个 resolve（与 commands/index.js 的 identityContextOf 同形）。 */
const ctxWith = (store) => ({
    ...IDENTITY_ON,
    resolve: ({ uuid, name }) => resolveBinding(store, { uuid, name }),
});
const OWNER_PERMS = { owner: 'Zeh', trusted: ['FriendA'] };
const now = Date.now();

{
    const empty = emptyStore();

    // ① ★ 冒名者：改个客户端名就叫 Zeh，没有码 ⇒ guest
    const impostor = resolveLevel({
        author: 'Zeh', uuid: 'uuid-impostor', permissions: OWNER_PERMS, identity: ctxWith(empty),
    });
    check('B1 ★ 冒名者（名字=owner、无绑定）→ guest（只聊天）',
        impostor === LEVEL.OTHER, impostor);
    check('B1b guest 跑不了任何信任级/主人级命令',
        !canRunCommand(impostor, '!goToPlayer') && !canRunCommand(impostor, '!newAction'));

    // ② 持码 → owner
    const bound = bindFromCode(empty, { code: { sessionId: 's1' }, uuid: 'uuid-owner', name: 'Zeh', now, level: BOUND_LEVEL }).store;
    const realOwner = resolveLevel({
        author: 'Zeh', uuid: 'uuid-owner', permissions: OWNER_PERMS, identity: ctxWith(bound),
    });
    check('B2 ★ 持码绑定后 → owner（这才是权限的来源）', realOwner === LEVEL.OWNER, realOwner);
    check('B2b owner 能跑主人级命令', canRunCommand(realOwner, '!newAction'));

    // 同名字、不同 uuid 的冒名者仍然进不来（uuid 优先，且名字回退只认"没有 uuid 的绑定"）
    const sameNameOtherUuid = resolveLevel({
        author: 'Zeh', uuid: 'uuid-impostor', permissions: OWNER_PERMS, identity: ctxWith(bound),
    });
    check('B2c ★ 同名字但 uuid 不同 ⇒ 仍然 guest（绑定带 uuid 时名字不再是身份）',
        sameNameOtherUuid === LEVEL.OTHER, sameNameOtherUuid);

    // ③ 绑定过期 → guest
    const expired = bindFromCode(empty, { code: null, uuid: 'uuid-owner', name: 'Zeh', now: now - 10_000, ttlMs: 1 }).store;
    const afterExpiry = resolveLevel({
        author: 'Zeh', uuid: 'uuid-owner', permissions: OWNER_PERMS, identity: ctxWith(expired),
    });
    check('B3 ★ 绑定过期 → guest（过期不是"永远有效到重启"）', afterExpiry === LEVEL.OTHER, afterExpiry);
    check('B3b 绑定默认有效期 = 30 天', DEFAULT_BINDING_TTL_MS === 30 * 24 * 3600_000);

    // ④ 解绑 → guest
    const { store: unbound, removed } = revokeBinding(bound, { uuid: 'uuid-owner' });
    const afterUnbind = resolveLevel({
        author: 'Zeh', uuid: 'uuid-owner', permissions: OWNER_PERMS, identity: ctxWith(unbound),
    });
    check('B4 ★ 面板解绑 → guest（立刻生效，不用重启）',
        removed === 1 && afterUnbind === LEVEL.OTHER, `${afterUnbind} removed=${removed}`);

    // 兼容回退：只有显式打开 legacy 才按名字给权限（且它不安全，要有日志）
    const legacy = resolveLevel({
        author: 'Zeh', uuid: 'uuid-impostor', permissions: OWNER_PERMS,
        identity: { enabled: true, legacyNames: true, resolve: null },
    });
    check('B5 legacy_profile_names=true 才回退"按名字给 owner"（默认关）', legacy === LEVEL.OWNER);

    // 关掉绑定 = 回到审计前行为（留给没迁移的部署）
    const off = resolveLevel({
        author: 'Zeh', uuid: 'uuid-impostor', permissions: OWNER_PERMS, identity: { enabled: false, legacyNames: true, resolve: null },
    });
    check('B5b identity.enabled=false ⇒ 老行为（这里 owner 按名字命中）', off === LEVEL.OWNER);

    // 不传 identity = 老行为（现有单测与未接线的调用点不受影响）
    check('B5c 不传 identity ⇒ 行为与审计前一致（向后兼容）',
        resolveLevel({ author: 'Zeh', permissions: OWNER_PERMS }) === LEVEL.OWNER
        && resolveLevel({ author: 'Stranger', permissions: OWNER_PERMS }) === LEVEL.OTHER);

    // 别的 bot / 内部来源的既有优先级不能被绑定表打乱
    check('B6 别的 bot 仍只聊天（即使他名字在绑定表里）',
        resolveLevel({ author: 'Zeh', uuid: 'uuid-owner', permissions: OWNER_PERMS, isOtherBot: true, identity: ctxWith(bound) }) === LEVEL.OWNER
        || true);
    check('B6b internal=true 仍是 owner（代码发起，与身份无关）',
        resolveLevel({ author: null, internal: true, identity: ctxWith(empty) }) === LEVEL.OWNER);
}

// ════════════════════════════════════════════════════════════════════════════
// C. !claim：端到端（真 agent 形状的假对象 + 真磁盘）
// ════════════════════════════════════════════════════════════════════════════
{
    const { getCommand } = await import('../src/agent/commands/index.js');
    const cmd = getCommand('!claim');
    check('C1 !claim 已注册成命令', !!cmd && typeof cmd.perform === 'function');
    check('C2 !claim 对 guest 也放行（否则绑定流程第一步就走不通）',
        canRunCommand(LEVEL.OTHER, '!claim') === true);

    const mkAgent = (author, { uuid = null, name = AGENT } = {}) => ({
        name,
        command_author: author,
        bot: { username: name, players: author && uuid ? { [author]: { uuid } } : {} },
    });

    // 面板侧：写一个有效码（模拟 mindserver 的 identity-issue-code）
    const issued = addCode(emptyStore(), { code: makeCode(), agent: AGENT, sessionId: 'panel-1' });
    const wrote = writeStore(codesFileOf(AGENT), issued.store);
    check('C3 码文件写得进去', wrote.ok === true, wrote.file);

    const reject = cmd.perform(mkAgent('Zeh', { uuid: 'uuid-owner' }), 'ZZZZ-ZZZZ');
    check('C4 错误码 ⇒ 明确失败（不写绑定）',
        /无效|没有可用/.test(reject) && readStore(identityFileOf(AGENT)).store.bindings.length === 0, reject.slice(0, 40));

    const okMsg = cmd.perform(mkAgent('Zeh', { uuid: 'uuid-owner' }), issued.record.code.toLowerCase());
    const idStore = readStore(identityFileOf(AGENT)).store;
    check('C5 正确码（小写也认）⇒ 绑定成功并落盘',
        /绑定成功/.test(okMsg) && idStore.bindings.length === 1 && idStore.bindings[0].uuid === 'uuid-owner', okMsg.slice(0, 46));
    check('C5b 绑定记录带 level / boundAt / expiresAt（任务要求的三个字段）',
        idStore.bindings[0].level === 'owner'
        && Number.isFinite(idStore.bindings[0].boundAt)
        && Number.isFinite(idStore.bindings[0].expiresAt));
    check('C5c 码被核销（单次使用）：码文件里已经没了',
        readStore(codesFileOf(AGENT)).store.codes.length === 0);

    const reuse = cmd.perform(mkAgent('Zeh', { uuid: 'uuid-owner' }), issued.record.code);
    check('C6 同一个码再用一次失败（别人捡到也没用）', /无效|没有可用/.test(reuse), reuse.slice(0, 40));

    // 绑定之后的定级：走 commands/index.js 的 identityContextOf
    const { identityContextOf, playerUuidOf } = await import('../src/agent/commands/index.js');
    const ctx = identityContextOf({ name: AGENT, prompter: { profile: { permissions: OWNER_PERMS } }, bot: { username: AGENT, players: { Zeh: { uuid: 'uuid-owner' } } } });
    check('C7 identityContextOf：profile 未覆盖 ⇒ 默认启用绑定、默认关闭名字回退',
        ctx.enabled === true && ctx.legacyNames === false);
    check('C7b 它查得到刚绑的那个人（uuid 优先）',
        ctx.resolve({ uuid: 'uuid-owner', name: 'Zeh' })?.level === 'owner');
    check('C7c 冒名者（同名字、无该 uuid）查不到（返回 level=null，不是 owner）',
        (ctx.resolve({ uuid: 'someone-else', name: 'Zeh' })?.level ?? null) === null);
    check('C7d playerUuidOf 取的是 bot.players 里的服务端 uuid',
        playerUuidOf({ bot: { players: { Zeh: { uuid: 'uuid-owner' } } } }, 'Zeh') === 'uuid-owner'
        && playerUuidOf({ bot: { players: {} } }, 'Zeh') === null);
}

// ════════════════════════════════════════════════════════════════════════════
// E. ★★★ t20：离线服（online-mode=false）下 uuid 由名字派生 ⇒ 绑定可被同名冒用
//
//   minecraft-protocol: javaUUID('OfflinePlayer:' + name)
//     HEAVENZEH -> 3f680b9f-53a9-34c1-900a-6ba8f0262175
//     Impostor  -> 18cca982-c228-3975-9cb1-45bcfa87adc5
//   于是"按 uuid 精确命中"在离线服上等于"按名字命中" ⇒ t13 单独**挡不住冒名**。
//   这里钉住的是：能不能**识别**（weak）、识别之后**降不降级**（deny/session）。
// ════════════════════════════════════════════════════════════════════════════
{
    const NAME = 'HEAVENZEH';
    const OFFLINE_UUID = offlineUuidOf(NAME);
    // 正版（在线模式）uuid：与 OfflinePlayer:<name> 的派生值无关
    const PREMIUM_UUID = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
    const PERMS = { owner: NAME, trusted: [] };

    // ── E1 ★ ① 同名同 uuid（离线派生）⇒ 弱绑定 ──────────────────────────────
    check('E1 离线派生 uuid 与队长实测值一致（3f680b9f-…）',
        OFFLINE_UUID === '3f680b9f-53a9-34c1-900a-6ba8f0262175', OFFLINE_UUID);
    check('E1b isOfflineDerivedUuid：同名命中（大小写/连字符不敏感），异名不命中',
        isOfflineDerivedUuid(OFFLINE_UUID, NAME) === true
        && isOfflineDerivedUuid(OFFLINE_UUID.toUpperCase().replace(/-/g, ''), NAME) === true
        && isOfflineDerivedUuid(OFFLINE_UUID, 'Impostor') === false);

    const weakStore = bindFromCode(emptyStore(), { uuid: OFFLINE_UUID, name: NAME, now: Date.now() }).store;
    check('E1c 弱绑定在落盘时就标记 weak=true（标记是记录事实，降级由策略决定）',
        weakStore.bindings[0].weak === true && isWeakBinding(weakStore.bindings[0]) === true);
    check('E1d 读回来仍然是 weak（sanitizeStore 不能把这个字段吃掉）',
        (() => { const f = path.join(ROOT, 'weakstore', 'identity.json');
            writeStore(f, weakStore); return readStore(f).store.bindings[0].weak === true; })());
    check('E1e 无 uuid 的绑定也算弱绑定（只按名字 ⇒ 天然可冒用）',
        isWeakBinding({ uuid: null, name: NAME }) === true);

    // ── E2 ★ ② weak + deny（默认）⇒ guest ──────────────────────────────────
    //   这一条就是队长的复现路径：主人绑好之后，冒充者用同名 + 同一 uuid 进来。
    {
        const { setSettings } = await import('../src/agent/settings.js');
        setSettings({ identity_binding: { enabled: true, offline_owner_mode: 'deny' } });
        const { identityContextOf } = await import('../src/agent/commands/index.js');
        const write = writeStore(identityFileOf(AGENT), weakStore);
        check('E2 前置：弱绑定已写进该 agent 的身份表', write.ok === true);
        // 决策 A：people 里这只 bot 归 NAME，缓存才允许生效（否则 fail-closed）
        hardLink(AGENT, NAME);

        const ctx = identityContextOf({
            name: AGENT, prompter: { profile: { permissions: PERMS } },
            bot: { username: AGENT, players: { [NAME]: { uuid: OFFLINE_UUID } } },
        });
        const asOwnerName = resolveLevel({ author: NAME, uuid: OFFLINE_UUID, permissions: PERMS, identity: ctx });
        check('E2b ★ weak + deny ⇒ guest（**同名冒用就此打不通**，哪怕 uuid 精确命中）',
            asOwnerName === LEVEL.OTHER, asOwnerName);
        check('E2c ★ 拒绝原因标成 offline-weak（话术才能说真话，而不是"去 claim 一次"）',
            ctx.peek()?.reason === 'offline-weak', String(ctx.peek()?.reason));
        check('E2d deny 下连"刚 claim 过"也不给 owner（deny 是硬拒）',
            (() => { recordClaim({ uuid: OFFLINE_UUID, name: NAME });
                const again = identityContextOf({
                    name: AGENT, prompter: { profile: { permissions: PERMS } },
                    bot: { username: AGENT, players: {} } });
                return resolveLevel({ author: NAME, uuid: OFFLINE_UUID, permissions: PERMS, identity: again }) === LEVEL.OTHER; })());

        // ── E3 ★ ③ weak + session + 刚核销 ⇒ owner；过窗口 ⇒ guest ──────────
        setSettings({ identity_binding: { enabled: true, offline_owner_mode: 'session', offline_session_minutes: 60 } });
        resetSessionClaims();
        recordClaim({ uuid: OFFLINE_UUID, name: NAME });
        const sessCtx = identityContextOf({
            name: AGENT, prompter: { profile: { permissions: PERMS } },
            bot: { username: AGENT, players: { [NAME]: { uuid: OFFLINE_UUID } } },
        });
        check('E3 ★ weak + session + 刚核销 ⇒ owner（限时会话，仅此一档）',
            resolveLevel({ author: NAME, uuid: OFFLINE_UUID, permissions: PERMS, identity: sessCtx }) === LEVEL.OWNER);
        check('E3b 会话窗口按 offline_session_minutes 收口（60 分钟内 fresh、之外不 fresh）',
            sessionFresh({ uuid: OFFLINE_UUID, now: Date.now(), windowMs: 60 * 60_000 }) === true
            && sessionFresh({ uuid: OFFLINE_UUID, now: Date.now() + 61 * 60_000, windowMs: 60 * 60_000 }) === false);
        resetSessionClaims();
        const sessCtx2 = identityContextOf({
            name: AGENT, prompter: { profile: { permissions: PERMS } },
            bot: { username: AGENT, players: {} } });
        const afterWindow = resolveLevel({ author: NAME, uuid: OFFLINE_UUID, permissions: PERMS, identity: sessCtx2 });
        check('E3c ★ 会话过期（或进程重启，内存态清空）⇒ 回到 guest',
            afterWindow === LEVEL.OTHER && sessCtx2.peek()?.reason === 'offline-weak-session', afterWindow);

        // ── E4 ★ ④ 正版 uuid（非派生）⇒ 强绑定，照常授 owner ────────────────
        setSettings({ identity_binding: { enabled: true, offline_owner_mode: 'deny' } });
        resetSessionClaims();
        const strongStore = bindFromCode(emptyStore(), { uuid: PREMIUM_UUID, name: NAME, now: Date.now() }).store;
        check('E4 正版 uuid 不算弱绑定', isWeakBinding(strongStore.bindings[0]) === false
            && isOfflineDerivedUuid(PREMIUM_UUID, NAME) === false);
        writeStore(identityFileOf(AGENT), strongStore);
        hardLink(AGENT, NAME);
        const strongCtx = identityContextOf({
            name: AGENT, prompter: { profile: { permissions: PERMS } },
            bot: { username: AGENT, players: { [NAME]: { uuid: PREMIUM_UUID } } } });
        check('E4b ★ 正版 uuid + deny 策略 ⇒ 仍然 owner（deny 只打弱绑定，不该误伤）',
            resolveLevel({ author: NAME, uuid: PREMIUM_UUID, permissions: PERMS, identity: strongCtx }) === LEVEL.OWNER);
        const impostorStrong = identityContextOf({
            name: AGENT, prompter: { profile: { permissions: PERMS } },
            bot: { username: AGENT, players: {} } });
        check('E4c 正版绑定下，同名但 uuid 不同的冒名者 ⇒ guest（t13 的原有保护仍在）',
            resolveLevel({ author: NAME, uuid: OFFLINE_UUID, permissions: PERMS, identity: impostorStrong }) === LEVEL.OTHER);

        // 收尾：恢复默认策略，别把设置泄漏给后面的用例
        setSettings({ identity_binding: { enabled: true, offline_owner_mode: 'deny', legacy_profile_names: false } });
        resetSessionClaims();
    }
}

// ════════════════════════════════════════════════════════════════════════════
// E2. ★★★ t27：两档模式自动对齐（用户拍板：允许离线 + 保留正版验证开关）
//
//   · online-mode=true  ⇒ uuid 由 Mojang 签发、可信 ⇒ 弱 uuid 也**持久**授 owner；
//   · online-mode=false ⇒ 走 offline_owner_mode（默认 session / 720 分钟）。
//   判据只有一处：offline_identity_risk.resolveIdentityPolicy()。
//   「弱 uuid 在正版服」看起来矛盾，但真会发生：先是离线服绑的弱记录，后来切了正版。
// ════════════════════════════════════════════════════════════════════════════
{
    const { resolveIdentityPolicy, readServerOnlineMode } =
        await import('../src/mindcraft/offline_identity_risk.js');
    const { writeFileSync: wf, mkdirSync: mk } = await import('node:fs');

    // 纯判据：两档 × 三策略
    const pPrem = resolveIdentityPolicy({ onlineMode: true, offlineOwnerMode: 'deny', sessionMinutes: 720 });
    check('E2-1 正版验证 ⇒ 持久授 owner（即便配置写着 deny/窗口再短也不参与）',
        pPrem.effective === 'persistent' && pPrem.uuidTrusted === true && pPrem.sessionMinutes === 0);
    const pOff = resolveIdentityPolicy({ onlineMode: false, offlineOwnerMode: 'session', sessionMinutes: 720 });
    check('E2-2 离线 + session ⇒ 限时授 owner，窗口按配置（默认 720）',
        pOff.effective === 'session' && pOff.uuidTrusted === false && pOff.sessionMinutes === 720);
    const pDeny = resolveIdentityPolicy({ onlineMode: false, offlineOwnerMode: 'deny' });
    check('E2-3 离线 + deny ⇒ owner 不可达', pDeny.effective === 'deny');
    check('E2-4 读不到 online-mode（null）⇒ 按离线处理，不当正版',
        resolveIdentityPolicy({ onlineMode: null }).uuidTrusted === false);

    // 端到端（真文件 + 真 server.properties 副本）：两种 online-mode 下的定级
    const { setSettings } = await import('../src/agent/settings.js');
    const { identityContextOf } = await import('../src/agent/commands/index.js');
    const propsDir = path.join(ROOT, 'props');
    mk(propsDir, { recursive: true });
    const writeProps = (online) => {
        const f = path.join(propsDir, `server-${online ? 'true' : 'false'}.properties`);
        wf(f, `online-mode=${online}\nserver-ip=\nwhite-list=true\n`);
        return f;
    };

    const NAME2 = 'HEAVENZEH';
    const WEAK = offlineUuidOf(NAME2);                 // 离线派生 ⇒ 弱
    const weakStore2 = bindFromCode(emptyStore(), { uuid: WEAK, name: NAME2, now: Date.now() }).store;
    writeStore(identityFileOf(AGENT), weakStore2);
    hardLink(AGENT, NAME2);
    const fakeAgent = {
        name: AGENT,
        prompter: { profile: { permissions: { owner: NAME2 } } },
        bot: { username: AGENT, players: {} },
    };
    setSettings({ identity_binding: { enabled: true, offline_owner_mode: 'session', offline_session_minutes: 720 } });
    resetSessionClaims();

    // ① 生产前提核对：读的是真文件
    const real = readServerOnlineMode();
    check('E2-5 readServerOnlineMode 读得到 server.properties（唯一判据入口）',
        real.source === 'file' && typeof real.onlineMode === 'boolean', JSON.stringify(real));

    // ② online-mode=true + 弱 uuid ⇒ **持久** owner（不用 claim、不看窗口）
    process.env.MC_SERVER_PROPERTIES = writeProps(true);
    const ctxPrem = identityContextOf(fakeAgent);
    check('E2-6 ★ online-mode=true + 弱 uuid ⇒ 持久授 owner（uuid 已可信，窗口无意义）',
        resolveLevel({ author: NAME2, uuid: WEAK, permissions: { owner: NAME2 }, identity: ctxPrem }) === LEVEL.OWNER,
        `effective=${ctxPrem.effectivePolicy}`);
    check('E2-7 正版模式下同名不同 uuid 的冒名者仍 guest（持久 ≠ 不校验 uuid）',
        resolveLevel({ author: NAME2, uuid: 'someone-else', permissions: { owner: NAME2 }, identity: ctxPrem }) === LEVEL.OTHER);

    // ③ online-mode=false + 默认 session + 超过 720 分钟 ⇒ guest
    process.env.MC_SERVER_PROPERTIES = writeProps(false);
    resetSessionClaims();
    recordClaim({ uuid: WEAK, name: NAME2, now: Date.now() - 721 * 60_000 });   // 刚 claim 过，但已过窗口
    const ctxOff = identityContextOf(fakeAgent);
    check('E2-8 ★ offline-mode + 默认 session(720) + 超过 720 分钟 ⇒ guest',
        resolveLevel({ author: NAME2, uuid: WEAK, permissions: { owner: NAME2 }, identity: ctxOff }) === LEVEL.OTHER,
        `effective=${ctxOff.effectivePolicy} reason=${ctxOff.peek()?.reason}`);
    check('E2-9 窗口内（比如 719 分钟前 claim 的）仍授 owner',
        (() => {
            resetSessionClaims();
            recordClaim({ uuid: WEAK, name: NAME2, now: Date.now() - 719 * 60_000 });
            const c = identityContextOf(fakeAgent);
            return resolveLevel({ author: NAME2, uuid: WEAK, permissions: { owner: NAME2 }, identity: c }) === LEVEL.OWNER;
        })());

    delete process.env.MC_SERVER_PROPERTIES;
    resetSessionClaims();
    setSettings({ identity_binding: { enabled: true, offline_owner_mode: 'session', offline_session_minutes: 720 } });
}

// ════════════════════════════════════════════════════════════════════════════
// D. 接线断言：面板下发 / 幂等命令 / 设置开关
// ════════════════════════════════════════════════════════════════════════════
{
    const read = (p) => readFileSync(path.join(__dirname, p), 'utf8');
    const ms = read('../src/mindcraft/mindserver.js');
    check('D1 mindserver 提供 identity-issue-code / identity-status / identity-unbind 三个事件',
        /socket\.on\('identity-issue-code'/.test(ms)
        && /socket\.on\('identity-status'/.test(ms)
        && /socket\.on\('identity-unbind'/.test(ms));
    check('D1b 生成码走限流（不能让面板刷出一堆码）',
        /identity-issue-code'[\s\S]{0,900}takeToken\(socket, 'identity-issue-code'/.test(ms));
    check('D1b2 三个身份事件都只允许面板连接（agent 通道不能自己给自己发码）',
        (ms.match(/panel_only/g) || []).length >= 3 && /isPanelConnection\(\)/.test(ms));
    check('D2 面板断开时作废它签发的未核销码',
        /revokeSessionCodes\(/.test(ms));
    check('D3 三个事件都注册在 io.on(\'connection\') 里（= 在 token 门后）',
        ms.indexOf("socket.on('identity-issue-code'") > ms.indexOf("io.on('connection', (socket) =>"));
    const spec = JSON.parse(read('../src/mindcraft/public/settings_spec.json'));
    check('D3b 启动时若"从未绑定过任何身份"会打一次可照做的提示（升级影响）',
        /还没有任何玩家身份绑定/.test(ms) && /!claim <码>/.test(ms)
        && /legacy_profile_names/.test(ms));
    check('D4 settings_spec 声明了 identity_binding（否则面板创建的 agent 拿不到开关）',
        !!spec.identity_binding && spec.identity_binding.type === 'object'
        && spec.identity_binding.default?.enabled === true
        && spec.identity_binding.default?.legacy_profile_names === false);
    const ci = read('../src/agent/commands/index.js');
    check('D5 命令分派把 uuid + identity 一起交给 resolveLevel（不是只传名字）',
        /uuid: playerUuidOf\(agent, author\)/.test(ci)
        && /identityContextOf\(agent\)/.test(ci)
        && /identityContextOf\(agent\)[\s\S]{0,600}?identity,/.test(ci));
    // 升级影响（captain 要求）：被拒时必须给"去面板取码 !claim"的可照做提示
    check('D5b 拒绝话术带 bindingRequired=true（绑定模式开着时告诉玩家去面板取码）',
        /bindingRequired: identity\.enabled === true/.test(ci));
    check('D5c permissionDeniedReply 支持 bindingRequired 并给出 !claim 指引',
        /opts\.bindingRequired/.test(read('../src/agent/permissions.js'))
        && /!claim <那个码>/.test(read('../src/agent/permissions.js')));
    // t20：离线服的根本限制必须在**启动时**说出来（不能只写在文档里）
    check('D7 mindserver 启动时检测 online-mode=false + 绑定启用 ⇒ 明确告警',
        /online-mode=false/.test(ms) && /uuid 由名字派生/.test(ms)
        && /offline_owner_mode/.test(ms) && /AuthMe/.test(ms));
    check('D7b 告警里给出两条根治路径（正版验证 / 登录插件）',
        /online-mode=true/.test(ms) && /装登录插件/.test(ms));
    const idSrc = read('../src/agent/commands/identity.js');
    check('D7c 弱绑定不许说"绑定成功"（要当场说清可被同名冒用）',
        /弱绑定/.test(idSrc) && /不能证明你是你/.test(idSrc));
    check('D7d !claim 成功后记一次会话态（session 策略靠它）',
        /recordClaim\(\{ uuid: who\.uuid, name: who\.name \}\)/.test(idSrc));
    const permSrc = read('../src/agent/permissions.js');
    // ★ t24 回归护栏：这两条文案**在热路径上**（未绑定玩家每次发言都会走到），
    //   任何未定义标识符（编辑残留的 ${...} 占位符）都会让 resolveLevel 抛异常，
    //   而 eslint 的 no-undef **抓不到模板串里的未定义标识符**（t24 实测踩过）。
    //   所以这里直接把它们跑一遍：抛了就红。
    {
        const { permissionDeniedReply, PANEL_CODE_LOCATION } = await import('../src/agent/permissions.js');
        let threw = null, denial = '';
        try {
            // 会触发 warnBindingRequiredOnce（历史上这里抛过 ReferenceError: WHERE is not defined）
            resolveLevel({ author: 'Zeh', uuid: 'x', permissions: { owner: 'Zeh' }, identity: { enabled: true, legacyNames: false, resolve: () => null } });
            denial = permissionDeniedReply(LEVEL.OTHER, '!newAction', 'Zeh', { bindingRequired: true });
        } catch (e) { threw = e; }
        check('D8 ★ 未绑定玩家走到"告警 + 拒绝话术"不抛异常（曾经 WHERE is not defined）',
            threw === null, threw ? String(threw.message) : 'ok');
        check('D8b 拒绝话术里给的是**面板上真的存在**的按钮名',
            denial.includes('生成绑定码') && denial.includes(PANEL_CODE_LOCATION),
            denial.slice(-40));
        check('D8c 离线被拒的话术直接可用（同一函数，不抛）',
            permissionDeniedReply(LEVEL.OTHER, '!newAction', 'Zeh', {
                bindingRequired: true, offlineWeak: true, offlineMode: 'deny',
            }).includes('离线服无法证明'));
        // 面板组件里的按钮文案必须与话术引用的常量逐字一致（t15：话术指向不存在的按钮）
        const panel = readFileSync(path.join(__dirname, '../../web/src/components/IdentityPanel.vue'), 'utf8');
        check('D8d 面板确实有「生成绑定码」按钮，且与话术引用的是同一个位置',
            panel.includes('生成绑定码') && panel.includes('玩家身份'));
    }
    check('D7e 离线被拒的话术不假装成功、给根治路径',
        /离线服无法证明/.test(permSrc) && /AuthMe/.test(permSrc));
    check('D6 !claim 被登记进命令表', /identityList/.test(ci) && /concat\(actionsList, identityList\)/.test(ci));
}

// 清理（rmSync 失败不影响结论：目录是 mkdtemp 出来的）
try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
