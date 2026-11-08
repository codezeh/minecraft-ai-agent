/**
 * t4 —— 取消与截止贯穿（A5 §5 方案 B）：operationId + deadline + AbortSignal 4 跳下传。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这条要证明的三件事（队长按此验收）：
 *   ① **signal 真的到了最底层**：适配器拿到的是**同一个** AbortSignal 实例
 *      （不是"传了个对象"），且 `timeoutMs` 由 deadline 反算（≤ LLM_MAX_CALL_MS）。
 *   ② **deadline / 取消真的能中断底层**：`fetchWithDeadline` 在期限到期与"外部取消"
 *      两条路径上都以 abort 结束（`LLM_TIMEOUT` / 取消文案），不再是把 Promise 放着不管。
 *   ③ **迟到结果三重不得**：operationId 已过期 ⇒ 不写 history、不说给玩家、不 finish 租约。
 *
 * 另钉两条结构不变量：
 *   ④ `!stop` 取消的是**同一个** operationId（不另造新 id；epoch/序号不变）；
 *   ⑤ operation 的唯一创建点是 `ActionManager._newOperation`（agent.js 不自己造）。
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 全离线：假适配器 / 假 fetch / 真 Prompter 出口 / 真 ActionManager / 真 Agent.handleMessage。
 * 输出 PASS / FAIL，全过退出码 0。
 */

// ⚠ import 顺序：先 agent.js（把它那条命令链按正确顺序求值），再 actions/index。
import { Agent } from '../src/agent/agent.js';
import { ActionManager } from '../src/agent/action_manager.js';
import { Prompter } from '../src/models/prompter.js';
import { ModelResult, STATUS } from '../src/models/result.js';
import { fetchWithDeadline, LLM_MAX_CALL_MS } from '../src/models/_shared.js';
import settings from '../src/agent/settings.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

settings.language = 'en';
settings.only_chat_with = settings.only_chat_with ?? [];
settings.max_commands = 1;
settings.show_command_syntax = 'none';

const PLAYER = 'deepseek';
const REPLY = '好的，我这就去挖树';

/** 只装真出口（Prompter.prototype）+ 记账桩的 prompter 壳 */
function makePrompter({ adapter }) {
    const p = Object.create(Prompter.prototype);
    p.agent = { name: 't4probe' };
    p.most_recent_msg_time = 0;
    p.profile = { conversing: 'P', coding: 'P' };
    p.convo_examples = [];
    p.coding_examples = [];
    p.awaiting_coding = false;
    p.checkCooldown = async () => {};
    p.replaceStrings = (prompt) => Promise.resolve(prompt);
    p._saveLog = async () => {};
    p.chat_model = adapter;
    p.code_model = adapter;
    return p;
}

// ══════════════════════════════════════════════════════════════════════════
// ① ★ signal 身份 + 期限折算：prompter 把**同一个** signal 实例交给适配器
// ══════════════════════════════════════════════════════════════════════════
{
    const ac = new AbortController();
    const deadline = Date.now() + 30_000;      // 动作还剩 30 秒
    let seen = null;
    const adapter = {
        sendRequest: (_turns, _sys, _stop, opts) => { seen = opts; return Promise.resolve('hi'); },
    };
    const p = makePrompter({ adapter });
    const r = await p.promptConvoResult([{ role: 'user', content: 'x' }], {
        signal: ac.signal, deadline, operationId: 't4bot:7',
    });

    const sameInstance = seen?.signal === ac.signal;
    const timeoutOk = Number.isFinite(seen?.timeoutMs)
        && seen.timeoutMs > 1000 && seen.timeoutMs <= LLM_MAX_CALL_MS
        && seen.timeoutMs <= 30_000 + 50;
    const opIdOk = seen?.operationId === 't4bot:7';
    const statusOk = r?.status === STATUS.OK && r?.content === 'hi';

    if (sameInstance && timeoutOk && opIdOk && statusOk) {
        okCase('★ ① 适配器收到**同一个** AbortSignal 实例；timeoutMs 由 deadline 反算（不是 120s 硬编码）',
            `same=${sameInstance} timeoutMs=${seen?.timeoutMs} op=${seen?.operationId}`);
    } else {
        badCase('① signal 没按实例透传 / 期限没折算', { sameInstance, timeoutOk, opIdOk, statusOk, seen, r });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ② ★ 迟到结果按 cancelled 交上去：请求期间被取消，即使模型回了内容也不算回答
// ══════════════════════════════════════════════════════════════════════════
{
    const ac = new AbortController();
    const adapter = {
        sendRequest: () => {
            ac.abort('stopped');            // 请求还没回来，玩家按了 !stop
            return Promise.resolve('这句是迟到的（不许当回答）');
        },
    };
    const p = makePrompter({ adapter });
    const r = await p.promptConvoResult([{ role: 'user', content: 'x' }], {
        signal: ac.signal, deadline: null, operationId: 't4bot:8',
    });

    const cancelled = r?.status === STATUS.CANCELLED;
    const noContent = (r?.content ?? '') === '';
    const tagged = r?.operationId === 't4bot:8';

    if (cancelled && noContent && tagged) {
        okCase('★ ② 请求期间被取消 ⇒ status=cancelled、content 为空、结果带 operationId',
            `status=${r?.status} op=${r?.operationId}`);
    } else {
        badCase('② 迟到结果被当成回答', { cancelled, noContent, tagged, r });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ③ ★ 迟到结果三重不得：operationId 已过期 ⇒ 不写 history、不进聊天、不 finish 租约
// ══════════════════════════════════════════════════════════════════════════
{
    const op = { id: 't4bot:9', deadline: null, ac: new AbortController() };
    op.ac.abort('stopped');                    // 已经作废的旧操作

    const effects = { history: [], chat: [], finishCalls: 0, seenOpts: null };
    const agent = Object.create(Agent.prototype);
    agent.name = 't4bot';
    agent.shut_up = false;
    agent._cancelEpoch = 0;
    agent.currentOperation = op;               // 第 2 跳要读它
    agent.bot = {
        interrupt_code: false, output: '', lastFailure: null,
        modes: { flushBehaviorLog: () => '' },
    };
    agent.history = {
        add(who, text) { effects.history.push([who, String(text)]); },
        getHistory() { return []; },
        save() {},
    };
    agent.self_prompter = { shouldInterrupt: () => false, isActive: () => false, author: null,
        handleUserPromptedCmd() {}, stop() {} };
    agent.actions = {
        // 真判据在 ActionManager；这里把它按"op 已作废"钉死，验证 agent 侧的消费
        isOperationCurrent: (opId) => opId === op.id && op.ac.signal.aborted === false,
        executing: false,
    };
    agent.board = { finishJob: () => { effects.finishCalls++; } };
    agent.checkTaskDone = async () => {};
    agent.routeResponse = (to, msg) => { effects.chat.push([to, String(msg)]); };
    agent.openChat = (msg) => { effects.chat.push(['openChat', String(msg)]); };
    agent.prompter = {
        promptConvoResult: (_h, opts) => {
            effects.seenOpts = opts;           // 第 2 跳确实带上了 op 的三件套
            return Promise.resolve(new ModelResult({ status: STATUS.OK, content: REPLY }));
        },
    };

    await agent.handleMessage(PLAYER, '帮我挖点木头', 1);

    const wroteReply = effects.history.some(([, t]) => t.includes(REPLY));
    const saidReply = effects.chat.some(([, m]) => m.includes(REPLY));
    const finished = effects.finishCalls;
    const opForwarded = effects.seenOpts?.operationId === op.id
        && effects.seenOpts?.signal === op.ac.signal;
    const finishDropped = agent.finishOperation(op, 'job-1') === false && effects.finishCalls === 0;

    if (!wroteReply && !saidReply && finished === 0 && finishDropped && opForwarded) {
        okCase('★ ③ operationId 过期 ⇒ 三重不得（history=0 / 聊天=0 / finish=0），且取消信号已下传',
            `op=${op.id} 转发=${opForwarded}`);
    } else {
        badCase('③ 迟到结果漏出去了', { wroteReply, saidReply, finished, finishDropped, opForwarded, effects });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ④ ★ 入口唯一：`!stop` 取消**同一个** operationId，不另造新 id
// ══════════════════════════════════════════════════════════════════════════
{
    const interrupts = { n: 0 };
    const fakeAgent = {
        name: 't4bot',
        bot: { interrupt_code: false, modes: {}, output: '' },
        self_prompter: { isActive: () => false },
        history: { add() {} },
        requestInterrupt() { interrupts.n++; this.bot.interrupt_code = true; },
        noteCancel() {},
    };
    const am = new ActionManager(fakeAgent);
    const op = am._newOperation(10);
    am.currentOperation = op;
    fakeAgent.currentOperation = op;

    const seqBefore = am._opSeq;
    const idBefore = op.id;
    await am.stop('player');              // = 玩家按 !stop / 面板停止

    const aborted = op.ac.signal.aborted === true;
    const noNewId = am._opSeq === seqBefore;
    const slotCleared = am.currentOperation === null;
    const notCurrent = am.isOperationCurrent(idBefore) === false;
    const deadlineOk = Number.isFinite(op.deadline) && op.deadline > Date.now();

    if (aborted && noNewId && slotCleared && notCurrent && deadlineOk) {
        okCase('★ ④ !stop 取消同一个 op（abort 生效、id 序号不变、槽位清空、判据立即失效）',
            `op=${idBefore} seq=${am._opSeq}`);
    } else {
        badCase('④ 停止没复用同一个 opId / 没 abort', { aborted, noNewId, slotCleared, notCurrent, deadlineOk });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ⑤ ★ 最底层真的被中断：fetchWithDeadline 的期限与"外部取消"两条路径
//    （t1 建的那条外部 signal 分支在 t4 之前是**死代码**，这里把它钉活）
// ══════════════════════════════════════════════════════════════════════════
{
    const realFetch = globalThis.fetch;
    // 挂住不回的假 fetch：只有 signal abort 才会结束
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (init?.signal?.aborted) return onAbort();
        init?.signal?.addEventListener('abort', onAbort, { once: true });
    });

    // ⑤-a 期限到期
    let timeoutErr = null, timeoutMs = 0;
    const t0 = Date.now();
    try {
        await fetchWithDeadline('http://probe.invalid', {}, { timeoutMs: 40 });
    } catch (e) { timeoutErr = e; timeoutMs = Date.now() - t0; }

    // ⑤-b 外部取消（= 4 跳传下来的那个 signal）
    const ac = new AbortController();
    let cancelErr = null, cancelMs = 0;
    const t1 = Date.now();
    const p = fetchWithDeadline('http://probe.invalid', { signal: ac.signal }, { timeoutMs: 5000 })
        .catch((e) => { cancelErr = e; cancelMs = Date.now() - t1; });
    setTimeout(() => ac.abort('stopped'), 20);
    await p;

    globalThis.fetch = realFetch;

    const deadlineHit = timeoutErr?.code === 'LLM_TIMEOUT' && timeoutMs >= 30 && timeoutMs < 1000;
    const cancelHit = String(cancelErr?.message ?? '').includes('取消') && cancelMs < 1000;

    if (deadlineHit && cancelHit) {
        okCase('★ ⑤ 最底层被中断：期限 40ms 命中 LLM_TIMEOUT；外部 signal 20ms 取消命中"被取消"',
            `timeout=${timeoutMs}ms cancel=${cancelMs}ms`);
    } else {
        badCase('⑤ fetchWithDeadline 没被期限/外部取消中断', {
            deadlineHit, cancelHit, timeoutCode: timeoutErr?.code, cancelMsg: cancelErr?.message, timeoutMs, cancelMs,
        });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ⑥ ★ 结构不变量：operation 的唯一创建点
// ══════════════════════════════════════════════════════════════════════════
{
    const { readFileSync } = await import('node:fs');
    const amSrc = readFileSync('src/agent/action_manager.js', 'utf8');
    const agSrc = readFileSync('src/agent/agent.js', 'utf8');

    const defs = (amSrc.match(/^\s*_newOperation\(/gm) ?? []).length;
    const calls = (amSrc.match(/_newOperation\(/g) ?? []).length - defs;   // 定义 1 次 + 调用 1 次
    const agentCreates = /new AbortController\(/.test(agSrc);
    const agentMakesOpId = /_newOperation\(/.test(agSrc);

    if (defs === 1 && calls === 1 && !agentCreates && !agentMakesOpId) {
        okCase('★ ⑥ operationId 只在 ActionManager._executeAction 创建一处（agent.js 不自己造 op/不造 AbortController）',
            `def=${defs} call=${calls}`);
    } else {
        badCase('⑥ 存在第二个创建点', { defs, calls, agentCreates, agentMakesOpId });
    }
}

console.log(`\nt4 取消贯穿：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);