/**
 * 2026-11-07 复审（05-本轮复审修复建议.md）—— 四条修复的回归测试，全部离线。
 *
 * 覆盖：
 *   第1条 容器槽位更新延迟时被过早判断为零进度（act_container.settleTransferCounts）
 *         附：中断时把光标在途件送回原侧（不许掉地上）
 *   第2条 模型请求期限没有覆盖响应体读取（_shared.fetchWithDeadline）
 *   第3A条 OpenRouter / Gemini 的输出截断未被识别
 *   第3B条 截断标记泄漏到玩家可见内容；截断代码不许进入执行路径
 *
 * 不连服务器、不发真实网络请求：假 bot / 假窗口 / 假 fetch / 假 SDK。
 */
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key-not-real';
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key-not-real';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key-not-real';

import { deposit } from '../src/agent/library/act_container.js';
import { fetchWithDeadline, isTruncatedReply, stripTruncatedMark, TRUNCATED_SUFFIX } from '../src/models/_shared.js';
import { OpenRouter } from '../src/models/openrouter.js';
import { Gemini } from '../src/models/gemini.js';
import { Prompter } from '../src/models/prompter.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

// ── 标准箱子窗口：27 格容器 + 36 格背包 ──────────────────────────────
const INV_START = 27;
const INV_END = 63;

/**
 * 造一个"服务端槽位更新会延迟"的箱子窗口。
 * @param {object} o
 *   inv        背包里该物品数量
 *   chest      箱子里该物品数量
 *   delayMs    deposit/withdraw 调用后多久才把变化写进 slots（模拟服务端推送延迟）
 *   onTransfer(kind, n) 自定义行为；抛错 = 模拟中途失败
 */
function makeChestBot({ inv = 10, chest = 0, delayMs = 0, item = 'iron_sword', onTransfer = null } = {}) {
    const state = { inv, chest };
    const timers = [];

    const win = {
        inventoryStart: INV_START,
        inventoryEnd: INV_END,
        slots: new Array(INV_END).fill(null),
        selectedItem: null,
        sync() {
            for (let i = 0; i < INV_END; i++) win.slots[i] = null;
            if (state.chest > 0) win.slots[0] = { name: item, type: 1, count: state.chest, slot: 0 };
            if (state.inv > 0) win.slots[INV_START] = { name: item, type: 1, count: state.inv, slot: INV_START };
        },
        containerItems() {
            return win.slots.slice(0, INV_START).filter(Boolean);
        },
        deposit(_type, _m, n) {
            if (onTransfer && onTransfer('deposit', n) === 'throw') return Promise.reject(new Error('destination full'));
            const moved = Math.min(n, onTransfer ? 0 : 3);   // 默认最多挪走 3 件（模拟箱子只剩 3 空位）
            const apply = () => { state.inv -= moved; state.chest += moved; win.sync(); };
            if (delayMs > 0) timers.push(setTimeout(apply, delayMs));
            else apply();
            return Promise.resolve();
        },
        withdraw(_type, _m, n) {
            if (onTransfer && onTransfer('withdraw', n) === 'throw') return Promise.reject(new Error('destination full'));
            const moved = Math.min(n, state.chest);
            const apply = () => { state.chest -= moved; state.inv += moved; win.sync(); };
            if (delayMs > 0) timers.push(setTimeout(apply, delayMs));
            else apply();
            return Promise.resolve();
        },
        close() { },
    };
    win.sync();

    const bot = {
        currentWindow: win,
        entity: { position: { x: 0, y: 64, z: 0 } },
        inventory: {
            items: () => (state.inv > 0 ? [{ name: item, type: 1, count: state.inv, slot: INV_START }] : []),
            slots: [],
        },
        registry: {
            itemsByName: { [item]: { id: 1 } },
            items: { [item]: { id: 1 } },
            blocksByName: {},
        },
        interrupt_code: null,
    };
    return { bot, win, state, timers, cleanup: () => timers.forEach(clearTimeout) };
}

// ══════════════════════════════════════════════════════════════════════
// 第1条：计数延迟更新时，不得在更新到达前就把"零进度"报出去
// ══════════════════════════════════════════════════════════════════════
{
    // 服务端 180ms 后才写槽位；旧实现（连续两次相同即收敛）会在 ~50ms 就报 stored:0
    const h = makeChestBot({ inv: 10, chest: 0, delayMs: 180 });
    const t0 = Date.now();
    const r = await deposit(h.bot, 'iron_sword', 10);
    const cost = Date.now() - t0;
    h.cleanup();

    check('第1条 延迟 180ms 时不会在更新到达前返回（耗时 ≥ 更新延迟）',
        cost >= 170, `耗时=${cost}ms`);
    check('第1条 最终报出真实部分进度 stored=3（不是 0）',
        r && !r.ok && r.data?.stored === 3, `code=${r?.code} stored=${r?.data?.stored}`);
    check('第1条 返回码仍是 INVENTORY_FULL（不引入破坏既有契约的新码）',
        r?.code === 'INVENTORY_FULL', `code=${r?.code}`);
    check('第1条 这份报告是"已确认"的（settled=true, unconfirmed=false）',
        r?.data?.settled === true && r?.data?.unconfirmed === false,
        `settled=${r?.data?.settled} unconfirmed=${r?.data?.unconfirmed}`);
    check('第1条 与真实账单一致（背包 10→7、箱子 0→3）',
        h.state.inv === 7 && h.state.chest === 3, `inv=${h.state.inv} chest=${h.state.chest}`);
}

// ── 第1条附：真·零进度（确实没动）仍返回零进度失败，但要显式标 unconfirmed ──
{
    const h = makeChestBot({ inv: 4, chest: 0, delayMs: 0, item: 'coal', onTransfer: () => 'none' });
    // onTransfer 返回 'none' 时 moved=0，槽位不变
    h.win.deposit = async () => { /* 什么都不发生，也不抛错 */ };
    const r = await deposit(h.bot, 'coal', 2);
    h.cleanup();
    check('第1条 确实没动时仍返回零进度失败（INVENTORY_FULL，契约不变）',
        r && !r.ok && r.data?.stored === 0, `code=${r?.code} stored=${r?.data?.stored}`);
    check('第1条 未确认被显式标出（unconfirmed=true），且不谎称 verified',
        r?.data?.unconfirmed === true && r?.data?.verified !== true,
        `unconfirmed=${r?.data?.unconfirmed} verified=${r?.data?.verified}`);
}

// ── 第1条附：中断时把光标在途件送回原侧 ──
{
    let putBack = 0;
    const h = makeChestBot({ inv: 4, chest: 0, item: 'coal' });
    h.win.selectedItem = { name: 'coal', type: 11, count: 1 };
    h.win.deposit = () => Promise.reject(new Error('interrupted by user'));
    h.win.withdraw = (_t, _m, n) => { putBack += n; h.win.selectedItem = null; };  // 送回背包
    const r = await deposit(h.bot, 'coal', 2);
    h.cleanup();
    check('第1条·附 中断仍报 INTERRUPTED（契约不变）', r?.code === 'INTERRUPTED', `code=${r?.code}`);
    check('第1条·附 中断时执行了光标归还（不再残留、不掉地上）',
        putBack > 0 && r?.data?.cursorReturned === true,
        `putBack=${putBack} cursorReturned=${r?.data?.cursorReturned}`);
}

// ══════════════════════════════════════════════════════════════════════
// 第2条：期限必须覆盖响应体读取
// ══════════════════════════════════════════════════════════════════════
{
    const realFetch = globalThis.fetch;

    // ① 响应头立即返回，但 body 要 150ms 才读出；期限 35ms ⇒ 必须在期限内中止。
    //    真实 Response 的 body 在 abort 时会 reject，这里如实模拟这一点。
    globalThis.fetch = (_input, init) => {
        const sig = init?.signal;
        return {
            ok: true,
            status: 200,
            json: () => new Promise((resolve, reject) => {
                const t = setTimeout(() => resolve({ late: true }), 150);
                if (sig) {
                    sig.addEventListener('abort', () => {
                        clearTimeout(t);
                        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                    }, { once: true });
                }
            }),
        };
    };
    const t0 = Date.now();
    let err = null;
    try {
        await fetchWithDeadline('http://x.invalid', {}, {
            timeoutMs: 35,
            parse: async (res) => await res.json(),
        });
    } catch (e) { err = e; }
    const cost = Date.now() - t0;
    check('第2条 body 延迟超过期限时按期中止（不再一路等到 body 读完）',
        err && err.code === 'LLM_TIMEOUT' && cost < 120, `code=${err?.code} 耗时=${cost}ms`);

    // ② 不传 parse 时保持旧行为：直接拿到 Response
    globalThis.fetch = () => new Response('{}', { status: 200 });
    const r2 = await fetchWithDeadline('http://x.invalid', {}, { timeoutMs: 60000 });
    check('第2条 未传 parse 时仍返回 Response（旧调用方式不破坏）',
        r2 && r2.ok === true, `ok=${r2?.ok}`);

    // ③ parse 内的非超时错误原样抛（不能被误标成 LLM_TIMEOUT）
    globalThis.fetch = () => ({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('bad json')) });
    let err3 = null;
    try {
        await fetchWithDeadline('http://x.invalid', {}, { timeoutMs: 60000, parse: async (res) => await res.json() });
    } catch (e) { err3 = e; }
    check('第2条 JSON 解析错误不被误判为超时', err3 instanceof SyntaxError, `name=${err3?.name} code=${err3?.code}`);

    // ④ 成功路径返回解析结果，且不留残留定时器
    globalThis.fetch = () => ({ ok: true, status: 200, json: () => Promise.resolve({ ok: 1 }) });
    const v = await fetchWithDeadline('http://x.invalid', {}, { timeoutMs: 60000, parse: async (res) => await res.json() });
    const alive = process.getActiveResourcesInfo?.() ?? [];
    check('第2条 parse 成功路径返回解析结果且无残留定时器',
        v?.ok === 1 && !alive.includes('Timeout'), `v=${JSON.stringify(v)}`);

    // ⑤ 外部取消在 body 读取中的行为由下面独立用例覆盖（这里不再重复，避免顺序写法空转）

    globalThis.fetch = realFetch;
}

// ── 第2条⑤ 补：外部取消（并发写法，避免上面顺序写法的空转） ──
{
    const realFetch = globalThis.fetch;
    globalThis.fetch = (_input, init) => {
        const sig = init?.signal;
        return {
            ok: true, status: 200,
            json: () => new Promise((resolve, reject) => {
                const t = setTimeout(() => resolve({ late: true }), 5000);
                if (sig) sig.addEventListener('abort', () => {
                    clearTimeout(t);
                    reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                }, { once: true });
            }),
        };
    };
    const ac = new AbortController();
    const p = fetchWithDeadline('http://x.invalid', { signal: ac.signal }, {
        timeoutMs: 60000, parse: async (res) => await res.json(),
    });
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 40);
    let e = null;
    try { await p; } catch (x) { e = x; }
    const cost = Date.now() - t0;
    check('第2条 外部 AbortSignal 在 body 读取中触发后请求结束并可区分',
        e && e.code === 'LLM_TIMEOUT' && cost < 1000, `code=${e?.code} 耗时=${cost}ms`);
    globalThis.fetch = realFetch;
}

// ══════════════════════════════════════════════════════════════════════
// 第3A条：OpenRouter / Gemini 的截断识别
// ══════════════════════════════════════════════════════════════════════
{
    const or = new OpenRouter('test-model');
    or.openai = { chat: { completions: { create: () => ({
        choices: [{ finish_reason: 'length', message: { content: '半句回答' } }],
        usage: {},
    }) } } };
    const r = await or.sendRequest([{ role: 'user', content: 'hi' }], 'sys');
    check('第3A OpenRouter 截断返回内容本身（不是 [LLM_ERROR]）',
        typeof r === 'string' && r.startsWith('半句回答'), `r=${String(r).slice(0, 30)}`);
    check('第3A OpenRouter 截断被标记为可识别截断', isTruncatedReply(r));

    const or2 = new OpenRouter('test-model');
    or2.openai = { chat: { completions: { create: () => ({
        choices: [{ finish_reason: 'stop', message: { content: '完整回答' } }], usage: {},
    }) } } };
    const r2 = await or2.sendRequest([{ role: 'user', content: 'hi' }], 'sys');
    check('第3A OpenRouter 正常结束不带截断标记', r2 === '完整回答' && !isTruncatedReply(r2), `r=${r2}`);

    const g = new Gemini('test-model');
    g.genAI = { models: { generateContent: () => ({
        text: '半句', candidates: [{ finishReason: 'MAX_TOKENS' }], usageMetadata: {},
    }) } };
    const gr = await g.sendRequest([{ role: 'user', content: 'hi' }], 'sys');
    check('第3A Gemini MAX_TOKENS 被识别为截断', isTruncatedReply(gr));

    const g2 = new Gemini('test-model');
    g2.genAI = { models: { generateContent: () => ({
        text: '完整', candidates: [{ finishReason: 'STOP' }], usageMetadata: {},
    }) } };
    const gr2 = await g2.sendRequest([{ role: 'user', content: 'hi' }], 'sys');
    check('第3A Gemini STOP 不带截断标记', gr2 === '完整', `r=${gr2}`);

    const g3 = new Gemini('test-model');
    g3.genAI = { models: { generateContent: () => ({
        text: '', candidates: [{ finishReason: 'SAFETY' }], usageMetadata: {},
    }) } };
    const gr3 = await g3.sendRequest([{ role: 'user', content: 'hi' }], 'sys');
    check('第3A Gemini SAFETY 不被误标为截断（安全拦截 ≠ 额度截断）',
        !isTruncatedReply(gr3), `r=${JSON.stringify(gr3).slice(0, 20)}`);
}

// ══════════════════════════════════════════════════════════════════════
// 第3B条：标记不泄漏到玩家可见内容 + 截断代码不进执行路径
// ══════════════════════════════════════════════════════════════════════
{
    check('第3B stripTruncatedMark 纯函数行为',
        (() => {
            const a = stripTruncatedMark('正文' + TRUNCATED_SUFFIX);
            const b = stripTruncatedMark('正文');
            return a.text === '正文' && a.truncated === true && b.text === '正文' && b.truncated === false;
        })());

    const mkPrompter = (chatReply, codeReply) => {
        const p = Object.create(Prompter.prototype);
        p.agent = { name: 'probe', history: { memory: 'old', getHistory: () => [] } };
        p.most_recent_msg_time = 0;
        p.profile = { conversing: 'P', coding: 'P', saving_memory: 'P', bot_responder: 'P' };
        p.convo_examples = [];
        p.coding_examples = [];
        p.awaiting_coding = false;
        p.checkCooldown = async () => { };
        p.replaceStrings = (x) => Promise.resolve(x);
        p._saveLog = async () => { };
        p.chat_model = { sendRequest: () => Promise.resolve(chatReply) };
        p.code_model = { sendRequest: () => Promise.resolve(codeReply) };
        return p;
    };

    const p1 = mkPrompter('她说了半句' + TRUNCATED_SUFFIX, null);
    const convo = await p1.promptConvo([{ role: 'user', content: 'hi' }]);
    check('第3B 对话正文已剥离 [LLM_TRUNCATED]（玩家看不到内部标记）',
        convo === '她说了半句' && !convo.includes('LLM_TRUNCATED'), `convo=${convo}`);
    check('第3B 剥离后仍保留结构化诊断（last_convo_truncated=true）',
        p1.last_convo_truncated === true);

    const p2 = mkPrompter(null, '```js\nawait foo();\n' + TRUNCATED_SUFFIX);
    const code = await p2.promptCoding([{ role: 'user', content: 'do it' }]);
    check('第3B 截断的代码不被执行（走 no response 约定）',
        code.includes('no response') && !code.includes('await foo()'), `code=${JSON.stringify(code)}`);
    check('第3B 截断代码响应不含原始半截代码', !code.includes('LLM_TRUNCATED'));

    // ★ H4（第四轮复审）：截断的摘要**不许覆盖** memory.json。
    //   原断言是「剥掉标记后返回前半截摘要」，那正是被 H4 判成缺陷的行为
    //   （半截摘要覆盖旧摘要 = 两头都亏，且 turns 已 splice、没有重来的机会）。
    //   新契约：返回**旧摘要**（等于本轮摘要没发生）+ 结构化标志。
    const p3 = mkPrompter('新记忆摘要' + TRUNCATED_SUFFIX, null);
    const mem = await p3.promptMemSaving('to summarize');
    check('第3B/H4 截断摘要不覆盖旧记忆（返回旧摘要 old）', mem === 'old', `mem=${mem}`);
    check('第3B/H4 截断摘要留结构化标志', p3.last_memory_summary_truncated === true,
        `flag=${p3.last_memory_summary_truncated}`);

    const p4 = mkPrompter('respond' + TRUNCATED_SUFFIX, null);
    const yes = await p4.promptShouldRespondToBot('hey');
    check('第3B bot_responder 判断不被标记干扰', yes === true, `yes=${yes}`);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
