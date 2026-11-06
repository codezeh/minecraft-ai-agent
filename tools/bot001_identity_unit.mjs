/**
 * BOT-001（2026-11-06 深度检查）—— 玩家名与内部角色标签碰撞，不得借用信任/主人权限。
 *
 * 缺陷原貌（三处叠起来才成立）：
 *   ① `permissions.js` 有 `INTERNAL_AUTHORS = new Set(['system','internal','self'])`，
 *      `resolveLevel` 里 `INTERNAL_AUTHORS.has(name) || internalNames.includes(name) → TRUSTED`；
 *   ② `agent.js` 的 `self_prompt = source === 'system' || source === this.name`；
 *   ③ `perm_author = self_prompt ? (self_prompter.author ?? source) : source`。
 * 于是玩家把游戏名起成 `system`（或用 bot 自己的名字）后：
 *   - 单独一句聊天 ⇒ 被判 trusted（报告实测：attacker→other，system/internal/self→trusted）；
 *   - 若当时 self_prompter 正跑着（有人设过 !goal）⇒ author 被换成那个主人 ⇒ **owner**。
 *
 * 修复口径：内部来源只认**调用点显式声明**的 `internal: true`（代码传的布尔，玩家伪造不了）；
 * 名字只与 profile 的 owner/trusted 名单比对，没有任何"特殊名字"分支；
 * 只有 self_prompter 的目标循环（`{internal:true, selfPrompt:true}`）可以继承
 * `self_prompter.author` 的主人权限，其它内部回合 author=null ⇒ 信任级。
 *
 * 分四层，全部离线：
 *   A. resolveLevel 判级矩阵（含报告点名的 system/internal/self 与同名 bot）；
 *   B. 后果断言：这些名字**拿不到**主人级命令；
 *   C. 接线断言：源码里必须没有按名字判内部的分支，内部调用点必须显式带标记；
 *   D. 复现报告里的两条实测路径（借 owner / 借 trusted）现在都必须落到 other。
 *
 * 输出：PASS/FAIL 逐条，全过退出码 0。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    LEVEL, resolveLevel, canRunCommand, commandLevel,
} from '../src/agent/permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src', 'agent');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

const OWNER = { owner: 'HEAVENZEH', trusted: ['Alice'] };
const NO_OWNER = {};

// ════════════════════════════════════════════════════════════
// A. 判级矩阵
// ════════════════════════════════════════════════════════════
const lvl = (author, extra = {}) => resolveLevel({ author, permissions: OWNER, ...extra });

check('真实主人 → owner', lvl('HEAVENZEH') === LEVEL.OWNER);
check('信任名单 → trusted', lvl('Alice') === LEVEL.TRUSTED);
check('普通玩家 → other', lvl('Mallory') === LEVEL.OTHER);

// ★ 报告点名的三个保留名：配了 owner 时必须是 other，不能是 trusted
for (const name of ['system', 'internal', 'self']) {
    check(`保留名 ${name} 不得被判 trusted（BOT-001 主回归）`, lvl(name) !== LEVEL.TRUSTED, `→ ${lvl(name)}`);
    check(`保留名 ${name} 在配了 owner 时 → other`, lvl(name) === LEVEL.OTHER, `→ ${lvl(name)}`);
}
// 大小写/空白同样不许借
for (const name of ['System', 'SYSTEM', ' system ', 'Internal', 'SELF']) {
    check(`保留名变体 ${JSON.stringify(name)} → other`, lvl(name) === LEVEL.OTHER, `→ ${lvl(name)}`);
}
// 主人本人叫 system 的极端配置：那是 owner 名单命中，属于显式配置，允许
check('主人名单本身就是 "system" 时仍按 owner（显式配置优先）',
    resolveLevel({ author: 'system', permissions: { owner: 'system' } }) === LEVEL.OWNER);

// internalNames 参数已删除：即使调用方还传，也不许放宽
check('传 internalNames 不再放宽（参数已移除）',
    resolveLevel({ author: 'deepseek', permissions: OWNER, internalNames: ['deepseek'] }) === LEVEL.OTHER);

// 空/非字符串 author：代码路径漏传 → 信任级（不会给主人权）
check('author=null → trusted（不是 owner）', resolveLevel({ author: null, permissions: OWNER }) === LEVEL.TRUSTED);
check('author 缺省 → trusted', resolveLevel({ permissions: OWNER }) === LEVEL.TRUSTED);
check('author 是对象 → trusted', resolveLevel({ author: { name: 'x' }, permissions: OWNER }) === LEVEL.TRUSTED);

// 显式 internal 仍然 → owner（代码自己的命令，这条不能被修坏）
check('internal:true → owner', resolveLevel({ author: null, permissions: OWNER, internal: true }) === LEVEL.OWNER);
check('internal:true 且 author=玩家名 也 → owner（显式声明优先）',
    resolveLevel({ author: 'Mallory', permissions: OWNER, internal: true }) === LEVEL.OWNER);
// 别的 bot 只聊天
check('isOtherBot → other', resolveLevel({ author: 'Alice', permissions: OWNER, isOtherBot: true }) === LEVEL.OTHER);
check('isOtherBot 且名字是 system → other',
    resolveLevel({ author: 'system', permissions: OWNER, isOtherBot: true }) === LEVEL.OTHER);

// 没配 owner：仍然 fail-closed（F-AI-201），保留名也一样
for (const name of ['system', 'internal', 'self', 'Mallory']) {
    check(`没配 owner 时 ${name} → other（fail-closed）`,
        resolveLevel({ author: name, permissions: NO_OWNER }) === LEVEL.OTHER,
        `→ ${resolveLevel({ author: name, permissions: NO_OWNER })}`);
}

// ════════════════════════════════════════════════════════════
// B. 后果：这些名字拿不到主人级命令
// ════════════════════════════════════════════════════════════
const OWNER_CMDS = ['!newAction', '!restart', '!goal', '!setMode', '!attackPlayer', '!givePlayer'];
const TRUSTED_CMDS = ['!lookAtPosition', '!goToPlayer', '!stop'];

for (const name of ['system', 'internal', 'self']) {
    const level = lvl(name);
    for (const cmd of OWNER_CMDS) {
        check(`玩家名 ${name} 不能执行主人级 ${cmd}`, !canRunCommand(level, cmd), `→ level=${level}`);
    }
    for (const cmd of TRUSTED_CMDS) {
        check(`玩家名 ${name} 连信任级 ${cmd} 也不能执行`, !canRunCommand(level, cmd), `→ level=${level}`);
    }
}
// 别把正常等级修坏
check('owner 能跑 !newAction', canRunCommand(LEVEL.OWNER, '!newAction'));
check('trusted 能跑 !lookAtPosition', canRunCommand(LEVEL.TRUSTED, '!lookAtPosition'));
check('trusted 跑不了 !newAction', !canRunCommand(LEVEL.TRUSTED, '!newAction'));
check('命令分级没变（!lookAtPosition=trusted, !newAction=owner）',
    commandLevel('!lookAtPosition') === LEVEL.TRUSTED && commandLevel('!newAction') === LEVEL.OWNER);

// ════════════════════════════════════════════════════════════
// C. 接线断言：源码不能再有"按名字判内部"的路径
// ════════════════════════════════════════════════════════════
const permsSrc = read('permissions.js');
const agentSrc = read('agent.js');
/** 去掉注释后再断言：文档里写着"原来有 XXX"是应该的，代码里重新出现才是缺陷。 */
const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const permsCode = stripComments(permsSrc);
const agentCode = stripComments(agentSrc);

check('permissions.js 不再有 INTERNAL_AUTHORS 集合',
    !/INTERNAL_AUTHORS\s*=\s*new Set/.test(permsCode));
check('permissions.js 不再按 internalNames 放宽',
    !/internalNames\.includes/.test(permsCode));
check('permissions.js 声明了"名字不再当身份用"（BOT-001）', /BOT-001/.test(permsSrc));

check('agent.js 不再用 source === \'system\' 判内部',
    !/source === 'system'/.test(agentCode));
check('agent.js 不再用 source === this.name 判内部',
    !/source === this\.name/.test(agentCode));
check('agent.js 用 opts.internal 判内部来源',
    /opts\?\.internal === true/.test(agentSrc));
check('agent.js 用 opts.selfPrompt 区分目标循环',
    /opts\?\.selfPrompt === true/.test(agentSrc) && /is_self_prompt_loop/.test(agentSrc));

// 所有内部调用点都必须显式带 internal:true（漏一个 = 那条内部回合降级成"玩家名"）
const INTERNAL_CALL_SITES = [
    ['agent.js', /handleMessage\('system', init_message, 2, \{ internal: true \}\)/],
    ['agent.js', /Previous actions were stopped and you have respawned\.`,\s*\n\s*null, \{ internal: true \}\)/],
    ['conversation.js', /hasn't responded in[\s\S]{0,120}\{ internal: true \}\)/],
    ['conversation.js', /disconnected, conversation has ended\.`, null, \{ internal: true \}\)/],
    ['conversation.js', /from_system \? \{ internal: true \} : \{\}\)/],
    ['modes.js', /in_convo \? \{\} : \{ internal: true \}\)/],
    ['self_prompter.js', /\{ internal: true, selfPrompt: true \}/],
];
for (const [file, re] of INTERNAL_CALL_SITES) {
    check(`${file} 的内部调用点显式声明 internal`, re.test(read(file)), `→ /${re.source.slice(0, 60)}…/`);
}

// executeCommand 不再传 internalNames
const cmdSrc = fs.readFileSync(path.join(SRC, 'commands', 'index.js'), 'utf8');
check('commands/index.js 不再传 internalNames', !/internalNames:/.test(cmdSrc));
check('commands/index.js 仍把 internal 传进 resolveLevel', /\b internal,\n/.test(cmdSrc) || /internal,\s*\n\s*\}\)/.test(cmdSrc));

// ════════════════════════════════════════════════════════════
// D. 复现报告里的两条实测路径
// ════════════════════════════════════════════════════════════
// 复现 perm 的计算过程（与 agent.js handleMessage 同式），确认借不到 owner/trusted。
const simulatePerm = ({ source, internal = false, selfPrompt = false, selfPrompterAuthor = null }) => {
    const is_internal = internal === true;
    const is_self_prompt_loop = is_internal && selfPrompt === true;
    const perm_author = is_self_prompt_loop ? (selfPrompterAuthor ?? null) : (is_internal ? null : source);
    return { author: perm_author, isOtherBot: false };
};

// 路径 1：玩家自称 system，且此刻 self_prompter 正带着主人的目标在跑
const p1 = simulatePerm({ source: 'system', selfPrompterAuthor: 'HEAVENZEH' });
check('复现1：玩家名 system 借 self_prompter.author → 仍是 other',
    resolveLevel({ ...p1, permissions: OWNER }) === LEVEL.OTHER,
    `→ author=${JSON.stringify(p1.author)} level=${resolveLevel({ ...p1, permissions: OWNER })}`);

// 路径 2：玩家自称 system 单独发言
const p2 = simulatePerm({ source: 'system' });
check('复现2：玩家名 system 单独发言 → other',
    resolveLevel({ ...p2, permissions: OWNER }) === LEVEL.OTHER);

// 路径 3：与 bot 同名
const p3 = simulatePerm({ source: 'deepseek' });
check('复现3：与 bot 同名的玩家 → other',
    resolveLevel({ ...p3, permissions: OWNER }) === LEVEL.OTHER);

// 正路不许坏：真实自提示循环仍按主人级
const loop = simulatePerm({ source: 'system', internal: true, selfPrompt: true, selfPrompterAuthor: 'HEAVENZEH' });
check('正路：self_prompter 目标循环仍按主人级执行',
    resolveLevel({ ...loop, permissions: OWNER }) === LEVEL.OWNER);
// 正路不许坏：其它内部回合按信任级（且不给主人权）
const other_internal = simulatePerm({ source: 'system', internal: true, selfPrompterAuthor: 'HEAVENZEH' });
check('正路：非目标循环的内部回合只有信任级',
    resolveLevel({ ...other_internal, permissions: OWNER }) === LEVEL.TRUSTED);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
