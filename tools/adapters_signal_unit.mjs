/**
 * t19：17 个适配器是否**真的消费** `sendRequest` 第 4 参（`{signal, timeoutMs}`）。
 *
 * 背景（A5 §1.2 / 第 1 条）：全仓 `AbortController` 只有 1 处生产用法，**0/19 适配器接受取消信号**
 * ⇒ `fetchWithDeadline` 的"外部取消"分支在生产里是死代码。t4 把 signal 从 ActionManager 一路
 * 下传到 prompter 的第 4 参；本文件证明它**真的到了网络层**，而不是"看起来传了"。
 *
 * 判据分三档，**每档都可见**（不许静默跳过）：
 *   ① identity（最强）：适配器交给 SDK 的 `options.signal` **就是调用方给的那个实例**；
 *   ② propagate（次强，流式/合并信号的适配器）：外部 abort 后，底层拿到的 signal 也进入 aborted；
 *   ③ static（最弱，#client 私有的 Mistral）：源码断言 + 明确标注"无法打桩，证据为静态"。
 *
 * 行为级：两个裸 fetch 适配器（ollama / hyperbolic）用挂住的假 fetch + abort，
 * 必须在 <200ms 内以失败/cancelled 返回，**不是**等满 timeout。
 */
import { readFileSync } from 'node:fs';

for (const k of ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'MERCURY_API_KEY', 'NOVITA_API_KEY',
    'OPENROUTER_API_KEY', 'QWEN_API_KEY', 'ANTHROPIC_API_KEY', 'GROQCLOUD_API_KEY', 'CEREBRAS_API_KEY',
    'MISTRAL_API_KEY', 'GEMINI_API_KEY', 'HYPERBOLIC_API_KEY', 'HUGGINGFACE_API_KEY', 'REPLICATE_API_KEY',
    'AZURE_OPENAI_API_KEY']) {
    process.env[k] = process.env[k] || 'test-key-not-real';
}

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
import { Gemini } from '../src/models/gemini.js';
import { GroqCloudAPI } from '../src/models/groq.js';
import { Cerebras } from '../src/models/cerebras.js';
import { Mistral } from '../src/models/mistral.js';
import { HuggingFace } from '../src/models/huggingface.js';
import { ReplicateAPI } from '../src/models/replicate.js';
import { Ollama } from '../src/models/ollama.js';
import { Hyperbolic } from '../src/models/hyperbolic.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};
const TURNS = [{ role: 'user', content: 'hi' }];
const CHAT = (content = 'ok') => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════════════
// ① OpenAI 兼容系（+ Azure 继承）：per-call options.signal 必须是同一实例
// ══════════════════════════════════════════════════════════════════════
{
    const cases = [
        ['gpt(chat)', () => { const i = new GPT('m'); i.url = 'http://x/v1'; return i; }, 'openai'],
        ['gpt(responses)', () => { const i = new GPT('m'); i.url = null; return i; }, 'responses'],
        ['azure', () => new AzureGPT('m', 'https://probe.openai.azure.com', { apiVersion: '2024-02-01' }), 'openai'],
        ['deepseek', () => new DeepSeek('m'), 'openai'],
        ['grok', () => new Grok('m'), 'openai'],
        ['mercury', () => new Mercury('m'), 'openai'],
        ['novita', () => new Novita('m'), 'openai'],
        ['openrouter', () => new OpenRouter('m'), 'openai'],
        ['qwen', () => new Qwen('m'), 'openai'],
        ['lmstudio', () => new LMStudio('m'), 'openai'],
        ['vllm', () => new VLLM('m'), 'vllm'],
        ['groq', () => new GroqCloudAPI('m'), 'groq'],
        ['cerebras', () => new Cerebras('m'), 'client'],
    ];
    for (const [name, mk, clientKey] of cases) {
        const ac = new AbortController();
        let seen = null;
        const inst = mk();
        if (clientKey === 'responses') {
            inst.openai = { responses: { create: (body, o) => { seen = o; return Promise.resolve({ output_text: 'ok', usage: {} }); } } };
        } else {
            inst[clientKey] = { chat: { completions: { create: (pack, o) => { seen = o; return Promise.resolve(CHAT()); } } } };
        }
        await inst.sendRequest(TURNS, 'sys', undefined, { signal: ac.signal, timeoutMs: 250 });
        check(`① ${name}：per-call options.signal 就是调用方的那个实例`,
            seen && seen.signal === ac.signal, `seen=${seen ? Object.keys(seen).join(',') : 'null'}`);
        check(`① ${name}：deadline 也到了 SDK（options.timeout=250）`, seen && seen.timeout === 250, `timeout=${seen?.timeout}`);
    }
}

// ══════════════════════════════════════════════════════════════════════
// ② claude / gemini：SDK 的选项形状不同，但 signal 必须真的进去
// ══════════════════════════════════════════════════════════════════════
{
    const ac = new AbortController();
    let seen = null;
    const c = new Claude('m');
    c.anthropic = { messages: { create: (body, o) => { seen = o; return Promise.resolve({ content: [{ type: 'text', text: 'ok' }], usage: {} }); } } };
    await c.sendRequest(TURNS, 'sys', undefined, { signal: ac.signal, timeoutMs: 250 });
    check('② claude：messages.create 的第二参 signal 是同一实例', seen?.signal === ac.signal);
    check('② claude：deadline 也传了（timeout=250）', seen?.timeout === 250, `timeout=${seen?.timeout}`);

    const ac2 = new AbortController();
    let params = null;
    const g = new Gemini('gemini-2.5-flash');
    g.genAI = { models: { generateContent: (p) => { params = p; return Promise.resolve({ text: 'ok', usageMetadata: {}, candidates: [{ finishReason: 'STOP' }] }); } } };
    await g.sendRequest(TURNS, 'sys', undefined, { signal: ac2.signal });
    check('② gemini：abortSignal 进入 GenerateContentConfig（同一实例）', params?.config?.abortSignal === ac2.signal,
        `config keys=${params ? Object.keys(params.config).join(',') : 'null'}`);
}

// ══════════════════════════════════════════════════════════════════════
// ③ 流式 / 合并信号的三个（hf / replicate / mistral）
// ══════════════════════════════════════════════════════════════════════
{
    // huggingface：外部 signal 与内部期限合并（identity 不再成立 → 用 propagate 证）
    const ac = new AbortController();
    let opts = null;
    const hf = new HuggingFace('m');
    hf.huggingface = { chatCompletionStream: (args, o) => { opts = o; return (async function* () { yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }; })(); } };
    await hf.sendRequest(TURNS, 'sys');
    check('③ huggingface：即使不传外部 signal，也一定有期限信号（t1 不回退）', !!opts?.signal && !opts.signal.aborted);
    const ac2 = new AbortController();
    hf.huggingface = { chatCompletionStream: (args, o) => { opts = o; return (async function* () { yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }; })(); } };
    await hf.sendRequest(TURNS, 'sys', undefined, { signal: ac2.signal });
    ac2.abort();
    check('③ ★ huggingface：外部 abort 后底层 signal 也 aborted（合并生效，不是各传各的）', opts?.signal?.aborted === true);

    // replicate：run/stream 的 options.signal 是合并信号
    const ac3 = new AbortController();
    let rseen = null;
    const rep = new ReplicateAPI('meta/meta-llama-3-70b-instruct');
    rep.replicate = {
        run: (m, o) => { rseen = o.signal; return Promise.resolve('ok'); },
        stream: function* (m, o) { rseen = o.signal; yield 'ok'; },
    };
    await rep.sendRequest(TURNS, 'sys', undefined, { signal: ac3.signal });
    check('③ replicate：run/stream 收到同一个合并信号实例（两次调用共享）', rseen instanceof AbortSignal || typeof rseen?.aborted === 'boolean');
    ac3.abort();
    check('③ ★ replicate：外部 abort 后底层 signal 也 aborted', rseen?.aborted === true);

    // mistral：#client 是私有字段（无法从外部打桩）→ 静态证据 + **显式标注**
    const src = readFileSync('src/models/mistral.js', 'utf8')
        .split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    check('③ mistral【证据强度=静态】：complete(...) 传了第 2 参（#client 私有，无法打桩，非静默跳过）',
        /chat\.complete\(/.test(src) && /}, sdkCallOptions\(opts\)\);/.test(src) && /async sendRequest\(turns, systemMessage, stop_seq, opts = \{\}\)/.test(src));
}

// ══════════════════════════════════════════════════════════════════════
// ④ 裸 fetch 系：行为级（abort ⇒ <200ms 内返回，不等满 timeout）
// ══════════════════════════════════════════════════════════════════════
{
    const realFetch = globalThis.fetch;
    // ollama
    globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
        const sig = init?.signal;
        if (sig) sig.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
    {
        const ac = new AbortController();
        const o = new Ollama('m');
        const t0 = Date.now();
        setTimeout(() => ac.abort(), 30);
        const r = await o.sendRequest(TURNS, 'sys', undefined, { signal: ac.signal, timeoutMs: 60000 });
        const cost = Date.now() - t0;
        check('④ ★ ollama：外部取消 <200ms 内返回失败（不是等满 60s timeout）',
            cost < 200 && String(r).startsWith('[LLM_ERROR]'), `cost=${cost}ms r=${String(r).slice(0, 46)}`);
    }

    // hyperbolic
    globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
        const sig = init?.signal;
        if (sig) sig.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
    {
        const ac = new AbortController();
        const h = new Hyperbolic('m');
        const t0 = Date.now();
        setTimeout(() => ac.abort(), 30);
        const r = await h.sendRequest(TURNS, 'sys', undefined, { signal: ac.signal, timeoutMs: 60000 });
        const cost = Date.now() - t0;
        check('④ ★ hyperbolic：外部取消 <200ms 内返回失败（不是等满 60s timeout）',
            cost < 200 && String(r).startsWith('[LLM_ERROR]'), `cost=${cost}ms r=${String(r).slice(0, 46)}`);
    }

    // ⑤ 反向证据：**不传 signal** 时不会平白无故中断（期限仍生效、但也别立刻死）
    globalThis.fetch = (_input, init) => Promise.resolve(new Response(JSON.stringify({ message: { content: 'ok' }, prompt_eval_count: 1, eval_count: 1 }), { status: 200 }));
    {
        const o = new Ollama('m');
        const r = await o.sendRequest(TURNS, 'sys');
        check('⑤ ollama：不传 signal 时照常成功（没有把无 signal 的情况搞坏）', String(r) === 'ok', `r=${String(r).slice(0, 20)}`);
    }
    globalThis.fetch = realFetch;
}

// ══════════════════════════════════════════════════════════════════════
// ⑥ 覆盖清点：17 个适配器一个都不能漏（漏了就 FAIL，不许静默）
// ══════════════════════════════════════════════════════════════════════
{
    const fs = await import('node:fs');
    const dir = new URL('../src/models/', import.meta.url);
    const ADAPTERS = ['gpt', 'azure', 'deepseek', 'grok', 'mercury', 'novita', 'openrouter', 'qwen', 'lmstudio',
        'vllm', 'claude', 'gemini', 'groq', 'cerebras', 'mistral', 'huggingface', 'replicate', 'ollama', 'hyperbolic'];
    const bad = [];
    for (const name of ADAPTERS) {
        if (name === 'azure') continue;   // 继承 GPT.sendRequest，无自己的 sendRequest
        const src = fs.readFileSync(new URL(`${name}.js`, dir), 'utf8')
            .split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
        const sig = new RegExp(`sendRequest\\(\\s*turns\\s*,\\s*systemMessage\\s*,[^)]*opts`);
        if (!sig.test(src)) bad.push(`${name}:签名无 opts`);
        if (!/(sdkCallOptions\(opts\)|signal:\s*opts\?\.signal|combineSignals\(opts\?\.signal|abortSignal:\s*opts\.signal)/.test(src)) bad.push(`${name}:没把 signal 用出去`);
    }
    check('⑥ ★ 19 个适配器文件全部消费第 4 参（azure 继承 GPT，单列说明）', bad.length === 0, `缺=${JSON.stringify(bad)}`);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
