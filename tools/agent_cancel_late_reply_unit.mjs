/**
 * A5-1（S1）—— 取消语义止血：`!stop` 之后**迟到的回复**不得写 history、不得说给玩家。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 审计 A5 §4 表最后一行（"最锋利的一条"）：
 *   `agent.js` 的会话分支在 `promptConvo` 返回后**没有任何 interrupt 复查**
 *   （老代码 agent.js:773-777），而 `checkInterrupt()` 的判据里也没有
 *   `bot.interrupt_code`（老代码 agent.js:668：shouldInterrupt / shut_up /
 *   responseScheduledFor 三条）。于是：
 *
 *     玩家说"帮我挖点木头" → 模型开始生成（最坏 30 分钟不可取消）
 *     → 玩家按 `!stop` → `actions.stop('player')` + `clearBotLogs()`
 *     → 模型那句"其实已经生成好"的回复回来 → **照样写进 history、照样说给玩家**。
 *
 * 为什么"只看标志位"修不好（本文件 ①③ 两例就是在钉这一条）：
 *   `!stop` 的实现是 `actions.stop('player')` **紧接着** `agent.clearBotLogs()`
 *   （commands/actions.js:140-141），而 clearBotLogs 里就写着 `interrupt_code = false`。
 *   ⇒ 迟到回复回来时标志位早已是 false；取消这件事必须用**只增不减的序号**
 *      （`agent.cancelEpoch()`）记下来。
 *
 * 另一个反向陷阱（本文件 ④⑤ 两例）：把 `interrupt_code` 直接塞进判据、又不在
 *   "新回合"这一侧收口，会让**上一轮遗留**的标志把新回合在第一个 checkInterrupt
 *   就打断 —— 从"多说一句"变成"再也不说话"。所以清标志的时机必须以
 *   `actions.executing` 为界：没有动作在跑才是"新动作"；旧动作还在跑时**绝不能清**
 *   （action_manager 的 `interrupted` / getBotOutputSummary 还在读这一位）。
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 全部离线：假 bot + 真 Agent.prototype.handleMessage。
 * 输出 PASS / FAIL，全过退出码 0。
 */

// ⚠ import 顺序有讲究：先 agent.js（它把 commands/ 那条循环链按正确顺序求值），
//   再 commands/actions.js —— 反过来单独 import actions.js 会撞上循环依赖的 TDZ。
import { Agent } from '../src/agent/agent.js';
import settings from '../src/agent/settings.js';
import { actionsList } from '../src/agent/commands/actions.js';
import convoManager from '../src/agent/conversation.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

const PLAYER = 'deepseek';
const REPLY = '好的，我这就去挖树';

// 关掉翻译/多余输出：handleEnglishTranslation 看到 'en' 直接原样返回（不联网）
settings.language = 'en';
settings.only_chat_with = settings.only_chat_with ?? [];
settings.max_commands = 1;
settings.show_command_syntax = 'none';

const STOP_CMD = actionsList.find((a) => a.name === '!stop');

/**
 * 假 agent：用 `Object.create(Agent.prototype)` 拿到**真的** noteCancel / cancelEpoch /
 * requestInterrupt / clearBotLogs / shutUp / handleMessage，只把外部世界（bot / 模型 /
 * 历史 / 说话）换成会记账的桩。
 */
function makeAgent({ onPrompt = null } = {}) {
    const agent = Object.create(Agent.prototype);
    const effects = { history: [], chat: [], promptCalls: 0, marks: {} };

    agent.name = 'botc';
    agent.shut_up = false;
    agent._cancelEpoch = 0;

    agent.bot = {
        interrupt_code: false,
        output: '',
        lastFailure: null,
        modes: { flushBehaviorLog: () => '' },
        stopDigging() {},
        collectBlock: { cancelTask() {} },
        pathfinder: { stop() {} },
        pvp: { stop() {} },
        emit() {},
        chat(msg) { effects.chat.push(['chat', String(msg)]); },
        whisper(_user, msg) { effects.chat.push(['whisper', String(msg)]); },
    };
    agent.history = {
        add(who, text) { effects.history.push([who, String(text)]); },
        getHistory() { return []; },
        save() {},
    };
    agent.self_prompter = {
        author: null,
        shouldInterrupt: () => false,
        isActive: () => false,
        handleUserPromptedCmd() {},
        stop() {},
    };
    agent.actions = {
        executing: false,
        stop_reason: null,
        stop: async () => {},
        cancelResume() {},
    };
    agent.prompter = {
        // ★ t4 起 agent.js 走带类型的出口（promptConvoResult）；旧的 promptConvo 仍保留
        //   在桩里，确保两个调用点都被覆盖（哪个被调到都不会静默变成 undefined）。
        promptConvo: async () => {
            effects.promptCalls++;
            if (onPrompt) await onPrompt(agent, effects);
            return REPLY;
        },
        promptConvoResult: async () => {
            effects.promptCalls++;
            if (onPrompt) await onPrompt(agent, effects);
            return { status: 'ok', content: REPLY, failed: false, toString: () => REPLY };
        },
    };
    agent.checkTaskDone = async () => {};
    // "说给玩家"这件事的落点：routeResponse / openChat。两个都记账。
    agent.routeResponse = (to, msg) => { effects.chat.push([to, String(msg)]); };
    agent.openChat = (msg) => { effects.chat.push(['openChat', String(msg)]); };

    return { agent, effects };
}

/** 迟到回复有没有漏出去（写进 history / 进了聊天） */
const leak = (effects) => ({
    history: effects.history.filter(([, t]) => t.includes(REPLY)),
    chat: effects.chat.filter(([, m]) => m.includes(REPLY)),
});

const runTurn = (agent) => agent.handleMessage(PLAYER, '帮我挖点木头', 1);

// ══════════════════════════════════════════════════════════════════════════
// ① ★ 核心：生成期间来了 `!stop`（此刻**没有动作在跑**，正是审计说的那种情况）
//    迟到回复必须零副作用：不写 history、不说给玩家。
// ══════════════════════════════════════════════════════════════════════════
{
    const { agent, effects } = makeAgent({
        onPrompt: async (a, fx) => {
            // 玩家按了「停下」：走**真的** `!stop` 命令实现
            await STOP_CMD.perform(a);
            // 记录事实：!stop 自己已经把停止标志清掉了（clearBotLogs）——
            // 这就是"只看标志位修不好"的现场证据。
            fx.marks.flagAfterStop = a.bot.interrupt_code;
            fx.marks.epochAfterStop = a.cancelEpoch();
            fx.marks.executingDuringPrompt = a.actions.executing;
        },
    });

    const out = await runTurn(agent);
    const leaked = leak(effects);

    const noSideEffect = leaked.history.length === 0 && leaked.chat.length === 0;
    const flagCleared = effects.marks.flagAfterStop === false;
    const epochAdvanced = effects.marks.epochAfterStop === 1;
    const noActionRunning = effects.marks.executingDuringPrompt === false;

    if (noSideEffect && flagCleared && epochAdvanced && noActionRunning) {
        okCase('★ ① 生成期间 !stop（无动作在跑）：迟到回复**不写 history、不说给玩家**',
            `epoch=${effects.marks.epochAfterStop} flag=${effects.marks.flagAfterStop} 泄漏=0`);
    } else {
        badCase('① 迟到回复漏出去了（或 !stop 没记取消）', {
            leaked, flagCleared, epochAdvanced, noActionRunning,
            history: effects.history, chat: effects.chat, ret: out,
        });
    }
}

// ② 反向：**没取消**的正常回合必须照常落库 + 照常说 —— 修取消不许把回复一起掐死
{
    const { agent, effects } = makeAgent();
    await runTurn(agent);
    const said = effects.chat.filter(([to, m]) => to === PLAYER && m === REPLY);
    const wrote = effects.history.filter(([who, t]) => who === 'botc' && t === REPLY);

    if (said.length === 1 && wrote.length === 1 && effects.promptCalls === 1) {
        okCase('★ ② 正常回合（无取消）：回复照常写 history + 照常说给玩家（没有过度抑制）',
            `chat=${said.length} history=${wrote.length}`);
    } else {
        badCase('② 正常回复被误杀', { said, wrote, effects });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ③ 新回合不许被**上一轮遗留**的停止标志判死（"清标志只影响新动作"）
//    现场：上一轮动作被停，标志位留在 true，之后玩家又说了句话。
// ══════════════════════════════════════════════════════════════════════════
{
    const { agent, effects } = makeAgent();
    agent.bot.interrupt_code = true;      // 遗留标志
    agent.actions.executing = false;      // 没有动作在跑 = 这是"新动作"

    await runTurn(agent);
    const leaked = leak(effects);
    const replied = leaked.history.length === 1 && leaked.chat.length === 1;
    const flagCollected = agent.bot.interrupt_code === false;

    if (replied && flagCollected) {
        okCase('★ ③ 上一轮遗留的停止标志：新回合照样回答，且标志在回合起点被收掉',
                `history=${leaked.history.length} chat=${leaked.chat.length} flag=${agent.bot.interrupt_code}`);
    } else {
        badCase('③ 遗留标志把新回合判死了（"再也不说话"）或标志没被收掉', {
            replied, flagCollected, effects,
        });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ④ **旧动作还在跑**时不许清标志（否则旧动作的收尾判定失真：停了的东西接着跑）
//    预期：本回合一个模型调用都不发（checkInterrupt 在循环口就命中），标志原样保留。
// ══════════════════════════════════════════════════════════════════════════
{
    const { agent, effects } = makeAgent();
    agent.bot.interrupt_code = true;
    agent.actions.executing = true;       // 旧动作还没退出

    await runTurn(agent);
    const leaked = leak(effects);
    const stillFlagged = agent.bot.interrupt_code === true;
    const noModelCall = effects.promptCalls === 0;

    if (stillFlagged && noModelCall && leaked.chat.length === 0) {
        okCase('★ ④ 旧动作在跑（executing=true）：不清标志（收尾判定不变），本回合不再调模型',
            `flag=${agent.bot.interrupt_code} promptCalls=${effects.promptCalls}`);
    } else {
        badCase('④ 旧动作在跑时被清了标志（或仍在调模型）', {
            stillFlagged, noModelCall, effects,
        });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ⑤ 停止标志本身就必须在 checkInterrupt 判据里：生成期间单独置起 interrupt_code
//    （不经 requestInterrupt、不涨取消序号）→ 回复同样要被丢弃。
// ══════════════════════════════════════════════════════════════════════════
{
    const { agent, effects } = makeAgent({
        onPrompt: (a, fx) => {
            a.bot.interrupt_code = true;   // 只有标志，没有 noteCancel
            fx.marks.epoch = a.cancelEpoch();
        },
    });

    await runTurn(agent);
    const leaked = leak(effects);

    if (leaked.history.length === 0 && leaked.chat.length === 0) {
        okCase('★ ⑤ 停止标志纳入 checkInterrupt：只置 interrupt_code 也能拦住迟到回复',
            `epoch 未变=${effects.marks.epoch}`);
    } else {
        badCase('⑤ 只置 interrupt_code 时回复仍漏出去（判据里没有停止标志）', { leaked, effects });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ⑥ `!stfu`（shutUp）同样算取消：闭嘴之后那句已生成好的回复不许再说出口
// ══════════════════════════════════════════════════════════════════════════
{
    const { agent, effects } = makeAgent({
        onPrompt: (a) => {
            // shutUp() 里还会调 convoManager.endAllConversations()，而它用的是
            // conversation.js 的**模块级** agent（离线桩里没有那个单例指针）——
            // 这里只替换这一跳：本用例要证明的是"shutUp 记了取消"，不是会话拆除。
            const orig = convoManager.endAllConversations;
            convoManager.endAllConversations = () => {};
            try { Agent.prototype.shutUp.call(a); } finally {
                convoManager.endAllConversations = orig;
            }
        },
    });

    await runTurn(agent);
    const leaked = leak(effects);

    if (leaked.chat.length === 0 && leaked.history.length === 0 && agent.shut_up === true) {
        okCase('★ ⑥ !stfu（shutUp）之后：已生成好的回复不写 history、不说给玩家',
            `epoch=${agent.cancelEpoch()}`);
    } else {
        badCase('⑥ !stfu 之后迟到回复漏出去', { leaked, shut_up: agent.shut_up, effects });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ⑦ 取消序号只增不减：clearBotLogs（!stop 收尾）不许把它抹回去
// ══════════════════════════════════════════════════════════════════════════
{
    const { agent } = makeAgent();
    agent.noteCancel('t1');
    const afterFirst = agent.cancelEpoch();
    agent.clearBotLogs();          // 老判据的"清标志"，不该影响取消事实
    const afterClear = agent.cancelEpoch();
    await STOP_CMD.perform(agent); // !stop 也会再记一次
    const afterStop = agent.cancelEpoch();

    if (afterFirst === 1 && afterClear === 1 && afterStop > afterClear) {
        okCase('★ ⑦ 取消序号单调：clearBotLogs 不清序号，!stop 会再记一次',
            `${afterFirst} → ${afterClear} → ${afterStop}`);
    } else {
        badCase('⑦ 取消序号被 clearBotLogs 抹掉了', { afterFirst, afterClear, afterStop });
    }
}

console.log(`\nA5-1 取消语义：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);