/**
 * 身份绑定命令（第四轮审计 ①，方案 C）。
 *
 * 这一条是**唯一的"给权限"入口**：面板（已过 token 门）生成一次性码，
 * 玩家在游戏里 `!claim <码>`，码核销后写 `bots/<agent>/identity.json`，
 * 之后 `permissions.resolveLevel` 按绑定表定级 —— 名字不再能换权限。
 *
 * 为什么不放在 actions.js 里：它跟"做事"无关，是身份/授权这一层的命令；
 * 单独一个文件（`identityList`）让"授权入口只有这一处"在目录结构上就看得出来。
 */
import {
    codesFileOf, identityFileOf, readStore, writeStore,
    consumeCodeAtomic, bindFromCode, recordClaim, isWeakBinding, BOUND_LEVEL,
} from '../../mindcraft/identity_store.js';
// 阶段 2 切片 2：邀请/撤销 = 改"人"与白名单，走 people_store + 服务端 RCON（不双写 whitelist.json）
import {
    mutatePeople, ensurePerson, findPerson, linkAvatar, PERSON_STATE, personForAvatar, readPeopleStore, recoverAvatar,
} from '../../mindcraft/people_store.js';
// ★ 决策 A：people 为权威，identity.json 只是本 bot 的绑定缓存 —— 判定只走这一个入口
import { resolveIdentityAuthority, explainAuthorityReason } from '../../mindcraft/identity_authority.js';
import { applyWhitelist } from '../library/whitelist_gate.js';
// 面板按钮的**唯一真相**住在 permissions.js（拒绝话术与 !claim 都引它，改一处即可）
import { PANEL_CODE_LOCATION } from '../permissions.js';

/**
 * 取发言人这一局的 uuid。
 *
 * 为什么用 `bot.players[name].uuid`：mineflayer 在玩家列表里给的 uuid 就是服务端认的那个
 * （离线模式下由名字派生，仍然是**服务端生成**，不是客户端随便报的字符串 —— 比名字稳）。
 * 取不到就退回只按名字绑（并明确告诉玩家"没拿到 uuid"）。
 *
 * @param {object} agent
 * @param {string|null} author
 * @returns {{uuid:string|null, name:string|null}}
 */
export function whois(agent, author) {
    const name = typeof author === 'string' && author.trim() ? author.trim() : null;
    if (!name) return { uuid: null, name: null };
    let uuid = null;
    try {
        const p = agent?.bot?.players?.[name];
        if (p && typeof p.uuid === 'string') uuid = p.uuid;
    } catch { /* 玩家列表可能还没同步 */ }
    return { uuid, name };
}

/**
 * 读码表（vendor 侧由 mindserver 写；这里只读一次再核销）。
 * @param {object} agent
 * @returns {object}
 */
function readCodes(agent) {
    const file = codesFileOf(agent?.name ?? agent?.bot?.username ?? 'agent');
    return readStore(file).store;
}

/** 人表里的这个人是不是这个名字（含别名，大小写不敏感）。 */
function personNameMatches(person, name) {
    const key = String(name ?? '').trim().toLowerCase();
    if (!person || !key) return false;
    if (String(person.name ?? '').toLowerCase() === key) return true;
    return (person.aliases ?? []).some((a) => String(a ?? '').toLowerCase() === key);
}

/**
 * `!claim <code>`：核销一次性码 → 落绑定。
 *
 * 失败一律**不改任何状态**（码不消耗、绑定不写），并把原因说人话：
 *   · 没有码文件 ⇒ "面板还没生成过码"
 *   · 码不对/已被用过 ⇒ 明确说"无效或已使用"
 *   · 码过期 ⇒ 明确说"已过期，请让面板重新生成"
 * 这三种在提示上必须可区分，否则玩家只会反复重试同一个废码。
 *
 * @returns {Promise<string>} 回给玩家/模型的一句话
 */
function claim(agent, code) {
    const agentName = agent?.name ?? agent?.bot?.username ?? 'agent';
    const who = whois(agent, agent?.command_author ?? null);
    if (!who.name) {
        return '[身份] 没能识别你是谁（没有发言人），这次绑定没有生效。';
    }
    const raw = String(code ?? '').trim();
    if (!raw) {
        return `[身份] 用法：!claim <码>（例如 !claim ABCD-EFGH）。码从面板取：${PANEL_CODE_LOCATION}。`
    }

    // ★ 决策 A：先只读检查人表 —— 这只分身已归别人时当场拒绝（**不烧码**）
    const ownedNow = personForAvatar(readPeopleStore().store, agentName);
    if (ownedNow && !personNameMatches(ownedNow.person, who.name)) {
        return `[身份] 这只分身已经挂在「${ownedNow.person.name}」名下，不能直接 claim。`
            + '这个码没有核销。要换挂：让面板「改挂到这只 bot」，或原主人先解绑。';
    }

    const codesPath = codesFileOf(agentName);
    // ★ t2 移交：核销走**原子版**（加锁读改写 + rev 乐观锁 + 冲突重试），不再"读→算→写"三步裸跑。
    const consumed = consumeCodeAtomic(codesPath, raw);
    if (!consumed.ok) {
        const why = String(consumed.reason ?? '');
        if (why === 'no-codes' || why === 'missing') {
            // 失败时才读一次表拿诊断（成功路径不额外读盘）
            const diag = readStore(codesPath);
            return `[身份] 现在没有可用的绑定码。取码：打开面板 → ${PANEL_CODE_LOCATION}（5 分钟内有效、只能用一次）。`
                + (diag.ok ? '' : `（码文件：${diag.reason}）`);
        }
        if (why === 'conflict' || why === 'lock-timeout' || why.startsWith('lock')) {
            // 码表正被面板侧（签发/作废）占着：**没有**核销任何码，玩家重试一次即可
            return '[身份] 绑定失败：码表正被另一个进程占用（面板可能正在签发/作废绑定码），'
                + '这次没有核销任何码，请过几秒**重试**一次。';
        }
        if (why === 'invalid' || why === 'empty') {
            // ★ 区分"过期"与"无效"：到期时间在 addCode 时就写进去了，这里只能按找不到来判 ——
            //   为了能说清，过期的码在 pruneCodes 时就被删掉了，所以走到这里 = 没用过也是无效。
            return '[身份] 绑定码无效或已被使用（每码只能用一次）。重新取码：打开面板 → '
                + `${PANEL_CODE_LOCATION}。`;
        }
        return `[身份] 绑定失败：码表写不进去（${why || '未知原因'}）。这次没有核销任何码，`
            + '请检查目录权限后重试。';
    }

    // ★ 决策 A：把这只 bot 挂到人（people）名下 —— 权威表里没有这个人，缓存里的 owner 不生效
    const linked = mutatePeople((store) => {
        const ens = ensurePerson(store, { name: who.name });
        const person = ens.result.person;
        if (person.state === PERSON_STATE.REVOKED) {
            return { store, result: { ok: false, reason: 'person-revoked', name: person.name } };
        }
        const link = linkAvatar(ens.store, { avatarName: agentName, personId: person.id });
        if (!link.result.ok) return { store: ens.store, result: { ok: false, reason: link.result.reason } };
        return { store: ens.store, result: { ok: true, person } };
    });
    if (!linked.ok) {
        return `[身份] 码已核销，但人表（people）写不进去（${linked.reason}）——这次绑定**没有生效**，`
            + '请让面板核对后再要一个新码。';
    }
    if (linked.result?.ok === false) {
        const why = linked.result.reason === 'avatar-taken'
            ? '这只分身已经归别人所有' : explainAuthorityReason(linked.result.reason);
        return `[身份] 码已核销，但这次绑定**没有生效**：${why}。`
            + '要换挂请用面板的「改挂」，或让原主人先用恢复码/解绑处理。';
    }

    const idPath = identityFileOf(agentName);
    const idRead = readStore(idPath);
    const bound = bindFromCode(idRead.store, {
        code: consumed.record,
        uuid: who.uuid,
        name: who.name,
        level: BOUND_LEVEL,
    });
    const idWrite = writeStore(idPath, bound.store);
    if (!idWrite.ok) {
        return `[身份] 绑定失败：写 ${idPath} 出错（${idWrite.reason}）。这次没有绑定。`;
    }

    // ★ t20：记一次"刚核销过"（内存态）。只有 offline_owner_mode='session' 会用到它，
    //   deny 模式下记了也不授 owner（但记着无害：切换策略时窗口仍然有效）。
    recordClaim({ uuid: who.uuid, name: who.name });

    const weak = isWeakBinding(bound.binding);
    const how = who.uuid ? `uuid=${who.uuid}` : '没有 uuid（只按名字绑定）';
    console.log(`[identity] ${who.name} 已绑定为 ${bound.binding.level}（${how}${weak ? '，弱绑定' : ''}，`
        + `面板会话 ${consumed.record?.sessionId ?? '-'}）`);

    // ★ t20：**弱绑定不许报"绑定成功"就完事** —— 必须当场说清它能被同名冒用。
    if (weak) {
        return `[身份] 码已核销，但你这条绑定是**弱绑定**：服务端下发的 uuid 由名字派生`
            + `（离线服 online-mode=false），任何人把客户端名改成「${who.name}」都会拿到同一个 uuid。`
            + ' 因此它**不能证明你是你**：离线服上要么按当前策略只聊天/仅限刚才那段时间，'
            + '要么开正版验证，或装登录插件（如 AuthMe）。';
    }
    return `[身份] 绑定成功：你现在的等级是 ${bound.binding.level}（${how}）。`;
}

/**
 * 判断发言人是不是这只 bot 的 **owner**（`!invite`/`!revoke` 的权限来源）。
 *
 * 口径：只有已绑定的 owner 能邀请——"玩家自己邀请朋友"，而不是"面板替所有人决定"。
 * 未绑定时明确拒绝，并告诉他先 `!claim`。
 */
export function ownerGate(agent) {
    const who = whois(agent, agent?.command_author ?? null);
    if (!who.name) return { ok: false, say: '[身份] 没能识别你是谁（没有发言人），这次操作没有生效。' };
    const agentName = agent?.name ?? agent?.bot?.username ?? 'agent';
    // ★ 决策 A：唯一判定入口（people 校真，fail-closed），不再自己读表拼判据
    const hit = resolveIdentityAuthority(agentName, { uuid: who.uuid, name: who.name });
    if (!hit.level) {
        const why = hit.reason === 'expired' ? '你的绑定已过期，请重新 !claim。'
            : hit.reason === 'unbound' ? '你还没绑定这只分身。先在面板拿一次性码，然后 !claim <码>。'
                : `${explainAuthorityReason(hit.reason)}——先 !claim，或让面板把这只分身「改挂」到你名下。`;
        return { ok: false, say: `[身份] ${why}` };
    }
    if (hit.level !== BOUND_LEVEL) {
        return { ok: false, say: `[身份] 你的权限是 ${hit.level}，不是 ${BOUND_LEVEL}；邀请/撤销只给 owner。` };
    }
    return { ok: true, who, binding: hit };
}

/**
 * `!invite <玩家名>`：把一个人加进"人"表 + 让服务端把他加进白名单。
 *
 * 顺序很重要：**先让服务端改白名单，成功了才写人表**。
 * 反过来写会造出"表里说邀请了、服务端其实没加"的假记录（R6 的假成功就是这么来的）。
 */
export async function invite(agent, playerName, apply = applyWhitelist) {
    const gate = ownerGate(agent);
    if (!gate.ok) return gate.say;
    const target = String(playerName ?? '').trim();
    if (!target) return '[身份] 用法：!invite <玩家名>（对方用同一个名字进服）。';

    const wl = await apply('add', target);
    if (!wl.ok) {
        return `[身份] 没加进白名单，所以这次邀请**没有生效**：${wl.reason}`
            + (wl.reply ? `（服务端原文：${wl.reply}）` : '');
    }

    // ★ 决策 A：`!invite` 只建"人"并记邀请人，**不再把这只 bot 挂到被邀请人**。
    //   原来那样做等于邀请一次就把分身判给别人（owner 立刻失去权威）——与 people 权威冲突。
    const out = mutatePeople((store) => {
        const ens = ensurePerson(store, { name: target });
        const person = ens.result.person;
        person.state = PERSON_STATE.ACTIVE;
        person.invited_by = gate.who.name;
        person.invited_at = Date.now();
        return { store: ens.store, result: { person } };
    });
    if (!out.ok) {
        return `[身份] 白名单已加，但人表写不进去（${out.reason}）——这次邀请只完成了一半，请让面板核对。`;
    }
    return `[身份] 已邀请 ${target}：白名单已生效（服务端确认），并把他/她记进人表。`
        + ` ${target} 现在可以用这个名字进服。`;
}

/**
 * `!revoke <玩家名>`：撤邀请——先让服务端移出白名单，成功了再把状态标成 revoked。
 * 人表**不删**（留证：谁在什么时候撤过谁）。
 */
export async function revoke(agent, playerName, apply = applyWhitelist) {
    const gate = ownerGate(agent);
    if (!gate.ok) return gate.say;
    const target = String(playerName ?? '').trim();
    if (!target) return '[身份] 用法：!revoke <玩家名>。';

    const wl = await apply('remove', target);
    if (!wl.ok) {
        return `[身份] 没能把他移出白名单，所以这次撤销**没有生效**：${wl.reason}`
            + (wl.reply ? `（服务端原文：${wl.reply}）` : '');
    }

    const out = mutatePeople((store) => {
        const person = findPerson(store, { name: target });
        if (!person) return null;                       // 不在人表：白名单已移出，无事可做
        person.state = PERSON_STATE.REVOKED;
        person.revoked_at = Date.now();
        person.revoked_by = gate.who.name;
        return { store, result: { person } };
    });
    if (!out.ok) {
        return `[身份] 白名单已移出，但人表写不进去（${out.reason}）——请让面板核对。`;
    }
    return `[身份] 已撤销 ${target} 的邀请：服务端已把他/她移出白名单。`
        + (out.skipped ? '（人表里本来就没有这个人，只改了白名单。）' : '');
}

/**
 * `!recover <码>`：人丢了分身怎么找回 —— 核销 **person 级** 一次性恢复码，
 * 把当前 bot 挂到该 person 名下（旧 avatar 置 retired），并给调用者落 owner 绑定缓存。
 *
 * 码表只存 sha256、带过期、单次使用；失败一律**什么都不改**并把原因说人话。
 */
export function recover(agent, code) {
    const agentName = agent?.name ?? agent?.bot?.username ?? 'agent';
    const who = whois(agent, agent?.command_author ?? null);
    if (!who.name) return '[身份] 没能识别你是谁（没有发言人），这次恢复没有生效。';
    const raw = String(code ?? '').trim();
    if (!raw) {
        return '[身份] 用法：!recover <恢复码>（码从面板人表的「生成恢复码」取：一次性、有有效期）。';
    }

    let why = null;
    const out = mutatePeople((store) => {
        const r = recoverAvatar(store, { code: raw, avatarName: agentName, actorName: who.name });
        if (!r.result.ok) { why = r.result.reason; return null; }
        return { store: r.store, result: r.result };
    });
    if (!out.ok) {
        return `[身份] 恢复失败：人表正被占用或写不进去（${out.reason}），请过几秒重试。`;
    }
    if (out.skipped) {
        if (why === 'person-revoked') {
            return '[身份] 这个恢复码对应的人已被撤销（state=revoked），恢复没有生效。请让主人在面板重新启用后再要新码。';
        }
        if (why === 'invalid' || why === 'no-codes' || why === 'empty') {
            return '[身份] 恢复码无效、已用过或已过期（一次性码）。请让面板重新生成。';
        }
        if (why === 'no-person') return '[身份] 恢复码对应的人不在人表里（数据不一致），恢复没有生效。';
        return `[身份] 恢复失败：${why ?? '未知原因'}。这次没有改动任何东西。`;
    }
    const person = out.result.person;

    // 绑定缓存：恢复成功 ⇒ 这个人现在持有这只 bot（owner）
    const idPath = identityFileOf(agentName);
    const bound = bindFromCode(readStore(idPath).store, {
        code: null, uuid: who.uuid, name: who.name, level: BOUND_LEVEL,
    });
    const idWrite = writeStore(idPath, bound.store);
    recordClaim({ uuid: who.uuid, name: who.name });
    if (!idWrite.ok) {
        return `[身份] 已把这只分身挂到「${person.name}」名下，但绑定缓存写不进去（${idWrite.reason}）——`;
    }
    return `[身份] 恢复成功：这只分身现在归「${person.name}」所有（旧的分身记录已退役），`
        + `你现在的等级是 ${BOUND_LEVEL}。` + (out.result.retired ? `（退役旧记录 ${out.result.retired} 条）` : '');
}

export const identityList = [
    {
        name: '!claim',
        description: 'Bind your in-game identity with the one-time code shown on the panel (grants the level tied to that code).',
        params: {
            code: { type: 'string', description: 'One-time binding code from the panel, e.g. ABCD-EFGH.' },
        },
        perform: function (agent, code) {
            return claim(agent, code);
        },
    },
    {
        name: '!invite',
        description: 'Invite a player: add them to the server whitelist and record them as a person (owner only).',
        params: {
            player: { type: 'string', description: 'Their in-game name.' },
        },
        perform: function (agent, player) {
            return invite(agent, player);
        },
    },
    {
        name: '!revoke',
        description: 'Revoke an invitation: remove them from the whitelist (owner only). Keeps an audit record.',
        params: {
            player: { type: 'string', description: 'Their in-game name.' },
        },
        perform: function (agent, player) {
            return revoke(agent, player);
        },
    },
    {
        name: '!recover',
        description: 'Recover ownership of this bot with a one-time person-level recovery code from the panel.',
        params: {
            code: { type: 'string', description: 'One-time recovery code from the panel, e.g. ABCD-EFGH-JKMN.' },
        },
        perform: function (agent, code) {
            return recover(agent, code);
        },
    },
];
