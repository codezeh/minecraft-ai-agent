/**
 * 第31条（agent.js 消费 FAILED_REPLY）+ 第11条遗留（modes/item_goal 的未声明变量）—— 离线。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 第31条 的两半：
 *   · 生产端（T11 已交）：模型层 17 处 `catch { return 'My brain disconnected' }` 改成
 *     `failedReply(...)`，标记是 `src/models/_shared.js` 的 `FAILED_REPLY`。
 *   · **消费端（本条）**：agent.js 若不认这个标记，这条"回答"会照旧写进 history、
 *     真的 routeResponse 给玩家说出来、还吃掉一次 response 预算 —— 标记等于没用。
 *     约定：认出来就当**空响应**（等于这一轮没产出），不写 history、不回复。
 *
 * 第11条遗留：`modes.js` 的 `if (placed)` / `if (walked)`、`item_goal.js` 的 `res = ...`
 *   都是**未声明变量**（ReferenceError）。item_goal 是必抛；modes 三处被 execute() 的
 *   try/catch 吞成一行 console.warn → **身上着火时水桶灭火永久静默失效**。
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 输出：PASS / FAIL，全过退出码 0。
 */
import { readFileSync } from 'node:fs';
import { FAILED_REPLY, failedReply, isFailedReply } from '../src/models/_shared.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

const NEWLINE = String.fromCharCode(10);
/** 去掉注释行后的代码（守卫要看行为，不看文案 —— 这轮已经栽过一次） */
const codeOf = (path) => readFileSync(path, 'utf8')
    .split(NEWLINE).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join(NEWLINE);

// ══════════════════════════════════════════════════════════════════════════
// ① FAILED_REPLY 契约（生产端语义）：标记能被认出来，且**普通回答不会被误判**
// ══════════════════════════════════════════════════════════════════════════
{
    const cases = [
        ['标记本身', failedReply('timeout'), true],
        ['带原因', failedReply('http 500'), true],
        ['裸标记', FAILED_REPLY, true],
        ['普通回答', '好的，我去挖树', false],
        ['提到这个牌子但不在开头', '模型说：' + FAILED_REPLY + ' 是失败标记', false],
        ['空串', '', false],
        ['null', null, false],
        ['undefined', undefined, false],
    ];
    const wrong = cases.filter(([, text, want]) => isFailedReply(text) !== want).map(([n]) => n);
    if (!wrong.length) {
        okCase('★ ① isFailedReply 判据：正例 3 条、反例 5 条（普通回答/提到牌子但不在开头 都不误判）',
            `${cases.length} 例`);
    } else {
        badCase('① isFailedReply 判据不对', { wrong });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ② ★ 消费端接线（agent.js）：认标记 → **当空响应 break**
//    关键不是"有没有这行"，而是**它在写 history / routeResponse 之前**。
// ══════════════════════════════════════════════════════════════════════════
{
    const src = readFileSync('src/agent/agent.js', 'utf8');
    const code = codeOf('src/agent/agent.js');

    const imported = /import\s*\{[^}]*isFailedReply[^}]*\}\s*from\s*'\.\.\/models\/_shared\.js'/.test(src);
    const guardIdx = code.indexOf('if (isFailedReply(res))');
    const breakIdx = guardIdx >= 0 ? code.indexOf('break;', guardIdx) : -1;
    // 会话分支里真正的"落库/回声"两处
    const convoHistoryIdx = code.indexOf('this.history.add(this.name, res);');
    const routeIdx = code.indexOf('this.routeResponse(source, res);');

    const guardBeforeEffects = guardIdx > 0
        && breakIdx > guardIdx && breakIdx - guardIdx < 400
        && convoHistoryIdx > guardIdx && routeIdx > guardIdx;

    if (imported && guardBeforeEffects) {
        okCase('★ ② agent.js 认 FAILED_REPLY：guard 在 history.add / routeResponse **之前**，且命中即 break',
            `guard@${guardIdx} < history@${convoHistoryIdx},route@${routeIdx}`);
    } else {
        badCase('② 消费端没认标记（或认了但排在落库之后 = 白认）', {
            imported, guardIdx, breakIdx, convoHistoryIdx, routeIdx,
        });
    }
}

// ③ 失败反证：**老逻辑**在同一输入下的行为（复刻）
//   老代码没有这道 guard → 只要 `res.trim().length > 0` 就往下走 →
//   落 history + routeResponse(source, res) ⇒ 玩家会真收到一句 "[LLM_ERROR] timeout"。
{
    // ↓ 复刻"老分支"（只为反证，不参与生产）
    const oldBranch = (res) => {
        const effects = [];
        if (res.trim().length === 0) return { effects, ended: 'empty' };
        // 无 command 的会话分支
        effects.push('history.add(bot, res)');
        effects.push('routeResponse(player, res)');
        return { effects, ended: 'conversation' };
    };
    const bad = oldBranch(failedReply('timeout'));
    const leaked = bad.effects.length === 2;

    // 新分支（同一个输入）：guard 命中 → 直接 break，零副作用
    const newBranch = (res) => {
        const effects = [];
        if (isFailedReply(res)) return { effects, ended: 'failed-reply' };
        effects.push('history.add(bot, res)');
        effects.push('routeResponse(player, res)');
        return { effects, ended: 'conversation' };
    };
    const good = newBranch(failedReply('timeout'));

    if (leaked && good.effects.length === 0 && good.ended === 'failed-reply') {
        okCase('★ ③ 失败反证：老逻辑会把 "[LLM_ERROR] timeout" **写进 history 并说给玩家**；新逻辑零副作用',
            `旧 effects=${bad.effects.length} 新 effects=${good.effects.length}`);
    } else {
        badCase('③ 反证不成立', { bad, good });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ④ 第11条遗留：modes.js 三个未声明变量必须消失（否则水桶灭火永久静默失效）
// ══════════════════════════════════════════════════════════════════════════
{
    const code = codeOf('src/agent/modes.js');
    const hasPlaced = /(?<![.\w])placed(?![.\w])/.test(code);
    const hasWalked = /(?<![.\w])walked(?![.\w])/.test(code);
    const ifSuccess = (code.match(/if \(success\)/g) ?? []).length;
    if (!hasPlaced && !hasWalked && ifSuccess === 3) {
        okCase('★ ④ modes.js：`placed`/`walked` 已全部改为 `success`（3 处判空真生效）', `if(success)=${ifSuccess}`);
    } else {
        badCase('④ modes.js 还有未声明变量（水桶灭火会静默失效）', { hasPlaced, hasWalked, ifSuccess });
    }
}

// ⑤ 第11条遗留：item_goal.js 的 `res` 必须声明（原来必抛 ReferenceError）
{
    const code = codeOf('src/agent/npc/item_goal.js');
    const declared = /const res = await skills\.attackNearest\(/.test(code);
    const bareAssign = /(?<![.\w])res = await skills\.attackNearest\(/.test(code) && !declared;
    if (declared && !bareAssign) {
        okCase('★ ⑤ item_goal.js：`res` 已用 const 声明（原来给未声明标识符赋值 = 必抛 ReferenceError）', 'ok');
    } else {
        badCase('⑤ item_goal.js 的 res 仍未声明', { declared, bareAssign });
    }
}

// ⑥ 浮空 promise：这一批文件里不许再有"没人管的 promise"
//    （eslint 是硬指标，但这条守卫防的是"以后有人顺手写回去"）
{
    const files = [
        'src/agent/modes.js', 'src/agent/speak.js', 'src/agent/conversation.js',
        'src/agent/mindserver_proxy.js', 'src/agent/library/heartbeat_loop.js',
    ];
    const suspicious = [];
    for (const f of files) {
        const code = codeOf(f);
        // 裸调 async 泵/IIFE 的两种典型形态
        if (/^\s*processQueue\(\);\s*$/m.test(code)) suspicious.push(`${f}: 裸 processQueue()`);
        if (/^\s*\}\)\(\);\s*$/m.test(code)) suspicious.push(`${f}: 裸 async IIFE`);
    }
    if (!suspicious.length) okCase('⑥ 五个文件的代码里没有"裸调 async 泵 / 裸 async IIFE"的形态', `files=${files.length}`);
    else badCase('⑥ 又出现了浮空 promise 的典型形态', { suspicious });
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
