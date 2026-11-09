/**
 * t-r5-1 —— 「!stop 之后迟到的回复仍然写 history、仍然说给玩家」
 *
 * 缺陷形态（老实现）：`handleMessage()` 的会话分支在 `promptConvo()` 返回之后**没有任何复查**：
 *   玩家说"帮我挖点木头" → 模型开始生成 → 玩家按 `!stop`
 *   → 生成好的那句回复回来 → **照样写进 history、照样说给玩家**。
 *   而且"只看标志位"修不好：`!stop` = `actions.stop('player')` 紧接着 `clearBotLogs()`，
 *   后者把 `interrupt_code` 清回 false，迟到回复回来时标志位早已是 false。
 *
 * 判定方式（不靠读码，靠跑）：用真的 `Agent.prototype.handleMessage` + 真的 `!stop` 命令实现，
 *   只把外部世界（bot / 模型 / history / 说话）换成记账桩。在"模型正在生成"的窗口里执行 `!stop`，
 *   然后看那句迟到的回复有没有漏出去：
 *     · 写进 history 或说给玩家 → 缺陷复现，退出码 0；
 *     · 零副作用 → 未复现，退出码 1。
 *
 * 用法：node .../t-r5-1.mjs ；R5_SRC=<pre-fix>/src node .../t-r5-1.mjs
 * 退出码：0=缺陷复现，1=未复现，2=CANNOT-RUN。
 */
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(process.env.R5_SRC || path.resolve(HERE, '../../../../../mindcraft/src'));
const say = (...a) => console.log('[t-r5-1]', ...a);
const p = (rel) => pathToFileURL(path.join(SRC, rel)).href;

const PLAYER = 'deepseek';
const REPLY = '好的，我这就去挖树';

let Agent, settings, actionsList, convoManager;
try {
    // ⚠ import 顺序：先 agent.js（它把 commands/ 那条循环链按正确顺序求值），再 commands/actions.js
    ({ Agent } = await import(p('agent/agent.js')));
    ({ default: settings } = await import(p('agent/settings.js')));
    ({ actionsList } = await import(p('agent/commands/actions.js')));
    ({ default: convoManager } = await import(p('agent/conversation.js')));
} catch (e) {
    console.error('[t-r5-1] CANNOT-RUN：导入失败：', e?.message ?? e);
    process.exit(2);
}

// 关掉翻译/多余输出：handleEnglishTranslation 看到 'en' 直接原样返回（不联网）
settings.language = 'en';
settings.only_chat_with = settings.only_chat_with ?? [];
settings.max_commands = 1;
settings.show_command_syntax = 'none';

const STOP_CMD = actionsList.find((a) => a.name === '!stop');
if (!STOP_CMD) {
    console.error('[t-r5-1] CANNOT-RUN：该版本没有 !stop 命令');
    process.exit(2);
}

function makeAgent(onPrompt) {
    const agent = Object.create(Agent.prototype);
    const effects = { history: [], chat: [], promptCalls: 0, marks: {} };

    agent.name = 'botc';
    agent.shut_up = false;
    if ('_cancelEpoch' in agent || true) agent._cancelEpoch = 0;

    agent.bot = {
        interrupt_code: false,
        output: '',
        lastFailure: null,
        modes: { flushBehaviorLog: () => '' },
        stopDigging() {}, collectBlock: { cancelTask() {} },
        pathfinder: { stop() {} }, pvp: { stop() {} },
        emit() {},
        chat(msg) { effects.chat.push(['chat', String(msg)]); },
        whisper(_u, msg) { effects.chat.push(['whisper', String(msg)]); },
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
    agent.actions = { executing: false, stop_reason: null, stop: async () => {}, cancelResume() {} };
    agent.prompter = {
        async promptConvo() {
            effects.promptCalls++;
            if (onPrompt) await onPrompt(agent, effects);
            return REPLY;
        },
        async promptConvoResult() {
            effects.promptCalls++;
            if (onPrompt) await onPrompt(agent, effects);
            return { status: 'ok', content: REPLY, failed: false, truncated: false, toString: () => REPLY };
        },
    };
    agent.checkTaskDone = async () => {};
    agent.routeResponse = (to, msg) => { effects.chat.push([to, String(msg)]); };
    agent.openChat = (msg) => Promise.resolve(effects.chat.push(['openChat', String(msg)]));
    return { agent, effects };
}

const { agent, effects } = makeAgent(async (a, fx) => {
    // 模型"正在生成"时，玩家按了 !stop（走**真的** !stop 实现）
    await STOP_CMD.perform(a);
    fx.marks.flagAfterStop = a.bot.interrupt_code;
    fx.marks.epochAfterStop = (typeof a.cancelEpoch === 'function') ? a.cancelEpoch() : '(无 cancelEpoch)';
});

let ret;
try {
    ret = await agent.handleMessage(PLAYER, '帮我挖点木头', 1);
} catch (e) {
    console.error('[t-r5-1] CANNOT-RUN：handleMessage 抛错：', e?.message ?? e);
    process.exit(2);
}

const leakedHistory = effects.history.filter(([, t]) => t.includes(REPLY));
const leakedChat = effects.chat.filter(([, m]) => m.includes(REPLY));

say('模型调用次数：', effects.promptCalls, ' handleMessage 返回：', ret);
say('!stop 之后的标志位 interrupt_code =', effects.marks.flagAfterStop,
    ' 取消序号 =', effects.marks.epochAfterStop);
say('迟到回复写进 history 的次数：', leakedHistory.length, leakedHistory.length ? JSON.stringify(leakedHistory) : '');
say('迟到回复说给玩家的次数：', leakedChat.length, leakedChat.length ? JSON.stringify(leakedChat) : '');

if (leakedHistory.length > 0 || leakedChat.length > 0) {
    say('REPRODUCED：!stop 之后迟到的回复仍然产生了副作用'
        + `（history ${leakedHistory.length} 条、聊天 ${leakedChat.length} 条）`);
    process.exit(0);
}
say('NOT-REPRODUCED：迟到的回复被丢弃（既不写 history、也不说给玩家）');
process.exit(1);
