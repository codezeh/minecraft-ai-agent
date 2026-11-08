/**
 * 第四轮复审 D0 止血批 —— 模型层 4 条：H2 / H3 / H5 / H4。**全部离线，不发任何网络请求。**
 *
 * ══════════════════════════════════════════════════════════════════════
 * H2（S1）截断假成功：`prompter.promptCoding` 截断兜底串自带三反引号
 *   → `coder.js` 判"有代码" → 抽出 `//no response (truncated)` 一行注释执行 → **报成功**。
 *   钉住三件事：① 生产端信号不含反引号；② 消费端显式拒绝该信号；
 *   ③ **即使喂回旧的带反引号兜底串，也不得有任何东西被执行**（只含注释 = 没有代码）。
 * H3（S1）SDK 适配器吃默认值 timeout=600000 × (1+2 重试) = 最坏 30 分钟不可取消。
 *   钉住：每个 SDK 客户端**实例上**的 timeout ≤120s、maxRetries ≤1（grog/cerebras 为 60s 档）。
 * H5 超时四档并存（600s×11 / 60s×2 / 120s×2 / 无×3）。钉住：gemini 真有期限、
 *   hyperbolic 的 timeoutMs 真的读 params 且真的生效、huggingface/replicate 真的把 signal 传下去。
 * H4（S2）截断的摘要覆盖 memory.json。钉住：截断时**保留旧摘要**，且 history 那道闸独立成立。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import {
    NO_CODE_PREFIX, noCodeReply, isNoCodeReply, TRUNCATED_SUFFIX, isTruncatedReply,
    LLM_MAX_CALL_MS, LLM_MAX_RETRIES, callDeadlineSignal,
} from '../src/models/_shared.js';

// 适配器构造函数会读 key；这里给假 key，绝不发真实请求
for (const k of ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'MERCURY_API_KEY', 'NOVITA_API_KEY',
    'OPENROUTER_API_KEY', 'QWEN_API_KEY', 'ANTHROPIC_API_KEY', 'GROQCLOUD_API_KEY', 'CEREBRAS_API_KEY',
    'GEMINI_API_KEY', 'HYPERBOLIC_API_KEY', 'AZURE_OPENAI_API_KEY']) {
    process.env[k] = process.env[k] || 'test-key-not-real';
}

import { Prompter } from '../src/models/prompter.js';
import { toModelResult } from '../src/models/result.js';
import { Coder } from '../src/agent/coder.js';
import { History } from '../src/agent/history.js';
import { GPT } from '../src/models/gpt.js';
import { AzureGPT } from '../src/models/azure.js';
import { DeepSeek } from '../src/models/deepseek.js';
import { Grok } from '../src/models/grok.js';
import { Mercury } from '../src/models/mercury.js';
import { Novita } from '../src/models/novita.js';
import { OpenRouter } from '../src/models/openrouter.js';
import { Qwen } from '../src/models/qwen.js';
import { LMStudio } from '../src/models/lmstudio.js';
import { VLLM } from '../src/models/vllm.js';
import { Claude } from '../src/models/claude.js';
import { GroqCloudAPI } from '../src/models/groq.js';
import { Cerebras } from '../src/models/cerebras.js';
import { Gemini } from '../src/models/gemini.js';
import { Hyperbolic } from '../src/models/hyperbolic.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};
const read = (p) => readFileSync(p, 'utf8');
/** 去掉注释行后的源码（守卫要看**代码**，不看文案 —— 注释里引用旧兜底串是正常的） */
const codeOf = (p) => read(p).split(String.fromCharCode(10))
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join(String.fromCharCode(10));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 老兜底串（H2 缺陷原文），用来做反证 */
const OLD_TRUNCATED_FALLBACK = '```//no response (truncated)```';

// ══════════════════════════════════════════════════════════════════════
// ① H2：信号本体 —— 不含反引号、可判别
// ══════════════════════════════════════════════════════════════════════
{
    const sig = noCodeReply('coding reply truncated by output limit');
    check('H2 无代码信号不含三反引号', !sig.includes('`'), `sig=${JSON.stringify(sig)}`);
    check('H2 无代码信号有稳定前缀', sig.startsWith(NO_CODE_PREFIX) && isNoCodeReply(sig), sig.slice(0, 40));
    check('H2 普通代码回复不会被误判成无代码', !isNoCodeReply('```js\nskills.foo();\n```'), '');
    check('H2 空串/undefined 不被误判', !isNoCodeReply('') && !isNoCodeReply(undefined), '');

    // 生产端不得再出现老兜底串；两个出口都走同一信号
    const prompterSrc = read('src/models/prompter.js');
    check('H2 prompter 的**代码**里不再产出老兜底串（自带三反引号）',
        !codeOf('src/models/prompter.js').includes(OLD_TRUNCATED_FALLBACK), '');
    check('H2 prompter 的「没代码」出口统一走 noCodeReply()',
        (prompterSrc.match(/noCodeReply\(/g) || []).length >= 2,
        `次数=${(prompterSrc.match(/noCodeReply\(/g) || []).length}`);
    // 消费端：抽码前显式拒绝该信号（双保险之一）
    const coderSrc = read('src/agent/coder.js');
    check('H2 coder 抽码前显式认无代码信号',
        /import\s*\{[^}]*isNoCodeReply[^}]*\}\s*from\s*'\.\.\/models\/_shared\.js'/.test(coderSrc)
        && coderSrc.includes('isNoCodeReply(res)'), '');
    check('H2 coder 还有「只有注释 = 没有代码」的执行前判据', coderSrc.includes('hasStatements('), '');
}

// ══════════════════════════════════════════════════════════════════════
// ② H2：promptCoding 截断 → 无代码信号（不再是带反引号的"代码"）
// ══════════════════════════════════════════════════════════════════════
const mkPrompter = (codeReply, chatReply = null) => {
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

{
    const p = mkPrompter('```js\nawait foo();\n' + TRUNCATED_SUFFIX);
    const out = await p.promptCoding([{ role: 'user', content: 'do it' }]);
    check('H2 截断的代码生成返回「无代码」信号', isNoCodeReply(out), `out=${JSON.stringify(out)}`);
    check('H2 截断回复里没有反引号（coder 不会判成有代码）', !out.includes('`'), '');
    check('H2 截断的半截代码没有被带出来', !out.includes('await foo()') && !out.includes('LLM_TRUNCATED'), '');
    check('H2 截断路径结束后 awaiting_coding 已清零', p.awaiting_coding === false, '');

    const p2 = mkPrompter(null);
    p2.awaiting_coding = true;   // 「已有一次代码生成在等」的早退分支
    const out2 = await p2.promptCoding([{ role: 'user', content: 'x' }]);
    check('H2 awaiting_coding 早退也是同一信号（原来同样带三反引号）',
        isNoCodeReply(out2) && !out2.includes('`'), `out=${JSON.stringify(out2)}`);
}

// ══════════════════════════════════════════════════════════════════════
// ③ ★ H2 核心：coder 端 —— 截断的回应**任何东西都不得被执行**
// ══════════════════════════════════════════════════════════════════════
const mkCoder = (promptCoding) => {
    const c = Object.create(Coder.prototype);
    const stats = { staged: 0, stagedCodes: [], prompted: 0 };
    c.file_counter = 0;
    c.fp = '/bots/probe/action-code/';
    c.agent = {
        name: 'probe',
        bot: { modes: { pause: () => { } }, interrupt_code: false },
        history: { getHistory: () => [] },
        prompter: {
            // coder.js 已改读结果类型（架构收敛项 1 步 1）：桩要按**新出口**给 ModelResult，
            // 同时保留 promptCoding（老形状 string），本文件其它断言还在用它。
            promptCodingResult: (msgs) => Promise.resolve().then(() => {
                stats.prompted++;
                return toModelResult(promptCoding(msgs));
            }),
            promptCoding: (msgs) => Promise.resolve().then(() => promptCoding(msgs)),
            skill_libary: { getAllSkillDocs: () => Promise.resolve([]) },
        },
        actions: { getBotOutputSummary: () => '' },
    };
    c._stageCode = (code) => { stats.staged++; stats.stagedCodes.push(code); return Promise.resolve({ func: null, src_lint_copy: '' }); };
    c._lintCode = () => Promise.resolve(null);
    return { c, stats };
};

{
    // (a) 真·截断路径（生产端现在给的就是这个信号）
    const { c, stats } = mkCoder(() => noCodeReply('coding reply truncated by output limit'));
    const r = await c.generateCode({ getHistory: () => [] });
    check('H2 ★ 截断信号不会被当代码执行（_stageCode 调用 0 次）', stats.staged === 0, `staged=${stats.staged}`);
    check('H2 ★ 截断路径的结果是「没写代码」而不是"成功"',
        r === 'Action failed, agent would not write code.', `r=${String(r).slice(0, 60)}`);
    check('H2 结果里不含"Agent wrote this code"（没有假成功）',
        !String(r).includes('Agent wrote this code'), '');
    check('H2 截断后按既有约定重试（4 次调用 = 3 次无代码 + 1 次放弃）',
        stats.prompted === 4, `prompted=${stats.prompted}`);

    // (b) 反证：把**旧兜底串**直接喂进 coder（模拟"上游又改回带反引号"）
    const { c: c2, stats: s2 } = mkCoder(() => OLD_TRUNCATED_FALLBACK);
    const r2 = await c2.generateCode({ getHistory: () => [] });
    check('H2 ★★ 反证：旧兜底串即便带三反引号也不被执行', s2.staged === 0,
        `staged=${s2.staged} 抽出=${JSON.stringify(s2.stagedCodes[0] || '')}`);
    check('H2 ★★ 反证：旧兜底串不会产出假成功摘要',
        !String(r2).includes('Agent wrote this code'), `r=${String(r2).slice(0, 60)}`);

    // (c) 正向：正常代码照旧进入执行路径（守卫没有把功能一起关掉）
    const { c: c3, stats: s3 } = mkCoder(() => '```js\nskills.foo();\n```');
    const r3 = await c3.generateCode({ getHistory: () => [] });
    check('H2 正常代码仍然会进入 _stageCode（守卫不误杀）', s3.staged === 1,
        `staged=${s3.staged} code=${JSON.stringify(s3.stagedCodes[0] || '')}`);
    check('H2 正常代码抽出的正文正确', (s3.stagedCodes[0] || '').includes('skills.foo()'), '');
}

// ══════════════════════════════════════════════════════════════════════
// ④ H3：SDK 适配器的**实例上**的 timeout / maxRetries（不看注释，看真实字段）
// ══════════════════════════════════════════════════════════════════════
{
    const clients = [
        ['gpt', new GPT('m').openai],
        ['azure', new AzureGPT('m', 'https://probe.openai.azure.com', { apiVersion: '2024-02-01' }).openai],
        ['deepseek', new DeepSeek('m').openai],
        ['grok', new Grok('m').openai],
        ['mercury', new Mercury('m').openai],
        ['novita', new Novita('m').openai],
        ['openrouter', new OpenRouter('m').openai],
        ['qwen', new Qwen('m').openai],
        ['lmstudio', new LMStudio('m').openai],
        ['vllm', new VLLM('m').vllm],
        ['claude', new Claude('m').anthropic],
    ];
    const bad = clients.filter(([, c]) => !(c.timeout <= 120000 && c.maxRetries <= 1))
        .map(([n, c]) => `${n}:${c.timeout}/${c.maxRetries}`);
    check('H3 ★ 11 个 600s 档 SDK 适配器实例上 timeout ≤120s、maxRetries ≤1',
        bad.length === 0, `异常=${JSON.stringify(bad)}`);

    const fast = [['groq', new GroqCloudAPI('m').groq], ['cerebras', new Cerebras('m').client]];
    const badFast = fast.filter(([, c]) => !(c.timeout <= 60000 && c.maxRetries <= 1))
        .map(([n, c]) => `${n}:${c.timeout}/${c.maxRetries}`);
    check('H3 ★ 60s 档（groq/cerebras）保持 60s，且重试 ≤1（原来 60s×3=3 分钟）',
        badFast.length === 0, `异常=${JSON.stringify(badFast)}`);
    check('H3 上限常量与裸 fetch 那条路对齐（120s / 1 次）',
        LLM_MAX_CALL_MS === 120000 && LLM_MAX_RETRIES === 1, '');
}

// ══════════════════════════════════════════════════════════════════════
// ⑤ H5：gemini 真有期限 / hyperbolic 的 timeoutMs 真生效 / hf・replicate 真传 signal
// ══════════════════════════════════════════════════════════════════════
{
    const g = new Gemini('gemini-2.5-flash');
    const gTimeout = g.genAI?.apiClient?.clientOptions?.httpOptions?.timeout;
    check('H5 ★ gemini 构造期传了 httpOptions.timeout（原来完全无期限）',
        gTimeout === LLM_MAX_CALL_MS, `timeout=${gTimeout}`);

    check('H5 hyperbolic 无 params 时 timeoutMs 为空（用 _shared 默认 120s）',
        new Hyperbolic('m').timeoutMs === undefined, '');
    check('H5 ★ hyperbolic 真读 params.timeoutMs（原来恒 undefined）',
        new Hyperbolic('m', null, { timeoutMs: 45000 }).timeoutMs === 45000, '');

    // 行为验证：timeoutMs 真的会把挂住的请求切断
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => new Promise((resolve, reject) => {
        const sig = init?.signal;
        if (sig) sig.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        // 永不 resolve：模拟"服务端不响应"
    });
    const h = new Hyperbolic('m', null, { timeoutMs: 60 });
    const t0 = Date.now();
    const out = await h.sendRequest([{ role: 'user', content: 'hi' }], 'sys');
    const cost = Date.now() - t0;
    globalThis.fetch = realFetch;
    check('H5 ★ hyperbolic 的 timeoutMs 真的生效（挂住的请求按期限失败）',
        String(out).startsWith('[LLM_ERROR]') && cost < 3000, `out=${String(out).slice(0, 50)} 耗时=${cost}ms`);

    // hf / replicate：SDK 只有 signal 可用 —— 检查真的接上了（结构判据）
    const hfSrc = read('src/models/huggingface.js');
    // t19 之后：期限信号 + **外部取消信号**合并（combineSignals），两者缺一不可
    check('H5 ★ huggingface 每次尝试都带期限信号（并与外部取消信号合并）', /callDeadlineSignal\(/.test(hfSrc)
        && /combineSignals\(opts\?\.signal, dl\.signal\)/.test(hfSrc) && /dl\.cancel\(\)/.test(hfSrc), '');
    const repSrc = read('src/models/replicate.js');
    check('H5 ★ replicate 的 run/stream 都带期限信号（并与外部取消信号合并）', /callDeadlineSignal\(/.test(repSrc)
        && (repSrc.match(/combineSignals\(opts\?\.signal, dl\.signal\)/g) || []).length >= 2
        && /dl\.cancel\(\)/.test(repSrc), '');

    // 期限信号的纯行为（含清理）
    const d1 = callDeadlineSignal(40);
    await sleep(90);
    check('H5 期限信号到期会 abort', d1.signal.aborted === true, '');
    const d2 = callDeadlineSignal(40);
    d2.cancel();
    await sleep(90);
    check('H5 cancel() 之后不再 abort（不留挂起的定时器副作用）', d2.signal.aborted === false, '');
}

// ══════════════════════════════════════════════════════════════════════
// ⑥ H4：截断的摘要**不覆盖** memory.json
// ══════════════════════════════════════════════════════════════════════
{
    // 生产端：prompter 截断 → 返回旧摘要 + 结构化标志
    const p = mkPrompter(null, '新记忆摘要' + TRUNCATED_SUFFIX);
    check('H4 生产端：截断摘要不返回半截正文（保留旧记忆 old）',
        (await p.promptMemSaving('to summarize')) === 'old', '');
    check('H4 生产端：留结构化标志 last_memory_summary_truncated', p.last_memory_summary_truncated === true, '');

    // 成功路径照旧写
    const pOk = mkPrompter(null, '新记忆摘要');
    check('H4 生产端：正常摘要照旧返回', (await pOk.promptMemSaving('t')) === '新记忆摘要', '');
    check('H4 生产端：正常摘要的标志为 false', pOk.last_memory_summary_truncated === false, '');

    // 消费端（history 那道闸）：标志为真 → 不赋值
    const mkHistory = (memory, prompter) => {
        const h = Object.create(History.prototype);
        h.name = 'probe';
        h.memory = memory;
        h.turns = [];
        h.agent = { prompter };
        return h;
    };
    const h1 = mkHistory('OLD', { promptMemSaving: () => Promise.resolve('OLD'), last_memory_summary_truncated: true });
    await h1.summarizeMemories([{ role: 'user', content: 'x' }]);
    check('H4 ★ history：标志为真时 memory.json 不被覆盖（memory 仍是 OLD）', h1.memory === 'OLD', `memory=${h1.memory}`);

    // 独立判据：即使 prompter 的标志丢了，只要返回的文本还带截断标记也不许写
    const h2 = mkHistory('OLD2', { promptMemSaving: () => Promise.resolve('半截摘要' + TRUNCATED_SUFFIX )});
    await h2.summarizeMemories([{ role: 'user', content: 'x' }]);
    check('H4 ★ history：返回文本仍带 [LLM_TRUNCATED] 时也不覆盖（不依赖标志）',
        h2.memory === 'OLD2', `memory=${h2.memory}`);

    // 正常路径仍然写（守卫不误杀）
    const h3 = mkHistory('OLD3', { promptMemSaving: () => Promise.resolve('新摘要'), last_memory_summary_truncated: false });
    await h3.summarizeMemories([{ role: 'user', content: 'x' }]);
    check('H4 history：正常摘要仍然写入', h3.memory === '新摘要', `memory=${h3.memory}`);

    check('H4 截断标记可判别（契约自检）', isTruncatedReply('x' + TRUNCATED_SUFFIX), '');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
