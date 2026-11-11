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
];
