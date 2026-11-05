/**
 * 第31条 回归护栏：模型层「失败伪装成模型的话」+ usage 记录 + 429。
 *
 * 缺陷原貌：
 *   - 17 处 `catch { res = '（一句假台词）' }` 后 `return res`；`sendRequest` 契约是 `Promise<string>`、
 *     没有 ok/code 通道 ⇒ prompter 拿到的"回答"和真实输出**同形**：写进 history、真的对玩家说出来、
 *     白消费一次 response 预算；
 *   - 19 个适配器零 `usage` ⇒ 成本永远算不出来；
 *   - hyperbolic / ollama / replicate 撞 429 不重试，`ollama.send()` 还把网络异常吞成 null。
 *
 * 本测分四组（都不联网：把各家的网络客户端换成桩）：
 *   A. 标记与 sink 本身（FAILED_REPLY / isFailedReply / recordUsage / 累计 / 429 判据）；
 *   B. **每个适配器真跑一遍**：成功 → sink 收到 `[llm] model=… prompt=… completion=…`；
 *      失败 → 返回值是失败标记（不是假台词）；
 *   C. prompter：失败**不当回答**（不写 history、不发玩家、不污染 memory、不当 code、不接话）；
 *   D. ollama 的 429 重试 + 网络异常不再被吞。
 *
 * 输出：PASS <用例> / FAIL <用例> <实际>，全过退出码 0。
 */

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

// 构造适配器需要 API key（getKey 会读 keys.json / 环境变量）；本测给出假值，绝不发请求。
for (const k of ['CEREBRAS_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY',
    'XAI_API_KEY', 'GROQCLOUD_API_KEY', 'HUGGINGFACE_API_KEY', 'HYPERBOLIC_API_KEY',
    'MERCURY_API_KEY', 'MISTRAL_API_KEY', 'NOVITA_API_KEY', 'OPENROUTER_API_KEY',
    'QWEN_API_KEY', 'REPLICATE_API_KEY', 'OPENAI_API_KEY']) {
    process.env[k] ||= 'test-key-not-real';
}

const S = await import('../src/models/_shared.js');
const { FAILED_REPLY, failedReply, isFailedReply, recordUsage, setUsageSink, usageTotals, isRateLimit, rateLimitDelayMs } = S;
const { Prompter } = await import('../src/models/prompter.js');

const lines = [];
setUsageSink((l) => lines.push(l));

// ════════════════════════════════════════════════════════════
// A. 标记 + sink 本身
// ════════════════════════════════════════════════════════════
check('FAILED_REPLY 是稳定前缀常量', typeof FAILED_REPLY === 'string' && FAILED_REPLY.length > 0, `→ ${FAILED_REPLY}`);
check('failedReply("x") 带标记', failedReply('x').startsWith(FAILED_REPLY));
check('failedReply 保留原因', failedReply('boom-42').includes('boom-42'));
check('isFailedReply: 标记串 → true', isFailedReply(failedReply('x')));
check('isFailedReply: 正常模型回答 → false', !isFailedReply('hello, I am a bot'));
check('isFailedReply: 非字符串不炸', !isFailedReply(null) && !isFailedReply(undefined) && !isFailedReply(42));
check('isFailedReply: 标记在中间不算（必须前缀）', !isFailedReply('text ' + FAILED_REPLY));

lines.length = 0;
{
    const before = usageTotals();
    const line = recordUsage({ prompt_tokens: 100, completion_tokens: 20 }, 'gpt-x');
    const after = usageTotals();
    check('recordUsage: OpenAI 形状 → 日志行格式正确',
        /^\[llm\] model=gpt-x prompt=100 completion=20$/.test(line), `→ ${line}`);
    check('recordUsage: 写进了 sink', lines.includes(line));
    check('recordUsage: 累计器 +1 次、token 累加',
        after.calls === before.calls + 1 && after.prompt === before.prompt + 100 && after.completion === before.completion + 20,
        `→ ${JSON.stringify(after)}`);
}
check('recordUsage: Anthropic 形状（input/output_tokens）',
    recordUsage({ input_tokens: 7, output_tokens: 3 }, 'claude-x') === '[llm] model=claude-x prompt=7 completion=3');
check('recordUsage: Ollama 形状（prompt_eval_count/eval_count）',
    recordUsage({ prompt_eval_count: 9, eval_count: 4 }, 'llama') === '[llm] model=llama prompt=9 completion=4');
check('recordUsage: Gemini 形状（promptTokenCount/candidatesTokenCount）',
    recordUsage({ promptTokenCount: 5, candidatesTokenCount: 2 }, 'gemini') === '[llm] model=gemini prompt=5 completion=2');
check('recordUsage: Mistral 形状（promptTokens/completionTokens）',
    recordUsage({ promptTokens: 3, completionTokens: 6 }, 'mistral') === '[llm] model=mistral prompt=3 completion=6');
{
    const before = usageTotals();
    const line = recordUsage(null, 'local');
    const after = usageTotals();
    check('recordUsage: 拿不到 usage → 记 -（不假装是 0）', line === '[llm] model=local prompt=- completion=-', `→ ${line}`);
    check('recordUsage: 同时计入 missing', after.missing === before.missing + 1);
}
check('recordUsage: tag 追加在末尾', recordUsage({ prompt_tokens: 1, completion_tokens: 1 }, 'm', 'vision').endsWith('tag=vision'));

check('isRateLimit: status=429 → true', isRateLimit({ status: 429 }));
check('isRateLimit: 消息含 429 → true', isRateLimit(new Error('HTTP 429 rate limited')));
check('isRateLimit: 消息含 rate limit → true', isRateLimit(new Error('Rate limit exceeded')));
check('isRateLimit: 普通错误 → false', !isRateLimit(new Error('boom')) && !isRateLimit(null));
{
    const d1 = rateLimitDelayMs(1), d2 = rateLimitDelayMs(2), d3 = rateLimitDelayMs(99);
    check('rateLimitDelayMs: 递增且有上限（≤30s+抖动）',
        d1 >= 1000 && d2 >= 2000 && d3 <= 30500, `→ ${d1}/${d2}/${d3}`);
}

// ════════════════════════════════════════════════════════════
// B. 每个适配器真跑：成功记 usage / 失败给标记
// ════════════════════════════════════════════════════════════
const CHAT = (content, usage) => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage });
const okChat = (usage) => ({ chat: { completions: { create: async () => CHAT('模型说的话', usage) } } });
const badChat = () => ({ chat: { completions: { create: async () => { throw new Error('stub-network-down'); } } } });

/** 每个适配器：怎么造 + 怎么替换网络层 + 期望的 usage 形状 */
const ADAPTERS = [
    { name: 'cerebras', file: 'cerebras.js', cls: 'Cerebras', usage: { prompt_tokens: 11, completion_tokens: 3 },
        ok: (m) => { m.client = okChat({ prompt_tokens: 11, completion_tokens: 3 }); },
        bad: (m) => { m.client = badChat(); } },
    { name: 'deepseek', file: 'deepseek.js', cls: 'DeepSeek', usage: { prompt_tokens: 12, completion_tokens: 4 },
        ok: (m) => { m.openai = okChat({ prompt_tokens: 12, completion_tokens: 4 }); },
        bad: (m) => { m.openai = badChat(); } },
    { name: 'gpt', file: 'gpt.js', cls: 'GPT', usage: { prompt_tokens: 13, completion_tokens: 5 },
        ok: (m) => { m.openai = { responses: { create: async () => ({ output_text: '模型说的话', usage: { prompt_tokens: 13, completion_tokens: 5 } }) } }; },
        bad: (m) => { m.openai = { responses: { create: async () => { throw new Error('stub-network-down'); } } }; } },
    { name: 'grok', file: 'grok.js', cls: 'Grok', usage: { prompt_tokens: 14, completion_tokens: 6 },
        ok: (m) => { m.openai = okChat({ prompt_tokens: 14, completion_tokens: 6 }); },
        bad: (m) => { m.openai = badChat(); } },
    { name: 'groq', file: 'groq.js', cls: 'GroqCloudAPI', usage: { prompt_tokens: 15, completion_tokens: 7 },
        ok: (m) => { m.groq = okChat({ prompt_tokens: 15, completion_tokens: 7 }); },
        bad: (m) => { m.groq = badChat(); } },
    { name: 'lmstudio', file: 'lmstudio.js', cls: 'LMStudio', usage: { prompt_tokens: 16, completion_tokens: 8 },
        ok: (m) => { m.openai = okChat({ prompt_tokens: 16, completion_tokens: 8 }); },
        bad: (m) => { m.openai = badChat(); } },
    { name: 'mercury', file: 'mercury.js', cls: 'Mercury', usage: { prompt_tokens: 17, completion_tokens: 9 },
        ok: (m) => { m.openai = okChat({ prompt_tokens: 17, completion_tokens: 9 }); },
        bad: (m) => { m.openai = badChat(); } },
    { name: 'novita', file: 'novita.js', cls: 'Novita', usage: { prompt_tokens: 18, completion_tokens: 10 },
        ok: (m) => { m.openai = okChat({ prompt_tokens: 18, completion_tokens: 10 }); },
        bad: (m) => { m.openai = badChat(); } },
    { name: 'openrouter', file: 'openrouter.js', cls: 'OpenRouter', usage: { prompt_tokens: 19, completion_tokens: 11 },
        ok: (m) => { m.openai = okChat({ prompt_tokens: 19, completion_tokens: 11 }); },
        bad: (m) => { m.openai = badChat(); } },
    { name: 'qwen', file: 'qwen.js', cls: 'Qwen', usage: { prompt_tokens: 20, completion_tokens: 12 },
        ok: (m) => { m.openai = okChat({ prompt_tokens: 20, completion_tokens: 12 }); },
        bad: (m) => { m.openai = badChat(); } },
    { name: 'vllm', file: 'vllm.js', cls: 'VLLM', usage: { prompt_tokens: 21, completion_tokens: 13 },
        ok: (m) => { m.vllm = okChat({ prompt_tokens: 21, completion_tokens: 13 }); },
        bad: (m) => { m.vllm = badChat(); } },
    { name: 'claude', file: 'claude.js', cls: 'Claude', usage: { input_tokens: 22, output_tokens: 14 },
        ok: (m) => { m.anthropic = { messages: { create: async () => ({ content: [{ type: 'text', text: '模型说的话' }], usage: { input_tokens: 22, output_tokens: 14 } }) } }; },
        bad: (m) => { m.anthropic = { messages: { create: async () => { throw new Error('stub-network-down'); } } }; } },
    { name: 'gemini', file: 'gemini.js', cls: 'Gemini', usage: { promptTokenCount: 23, candidatesTokenCount: 15 },
        ok: (m) => { m.genAI = { models: { generateContent: async () => ({ text: '模型说的话', usageMetadata: { promptTokenCount: 23, candidatesTokenCount: 15 } }) } }; },
        bad: (m) => { m.genAI = { models: { generateContent: async () => { throw new Error('stub-network-down'); } } }; } },
    { name: 'huggingface', file: 'huggingface.js', cls: 'HuggingFace', usage: null,
        ok: (m) => { m.huggingface = { chatCompletionStream: async function* () { yield { choices: [{ delta: { content: '模型说的话' } }] }; } }; },
        bad: (m) => { m.huggingface = { chatCompletionStream: async function* () { throw new Error('stub-network-down'); } }; } },
];

for (const a of ADAPTERS) {
    const mod = await import(`../src/models/${a.file}`);
    const Cls = mod[a.cls];
    if (typeof Cls !== 'function') { check(`${a.name}: 找不到类 ${a.cls}`, false, `→ ${Object.keys(mod)}`); continue; }

    // 成功路径
    let inst;
    try { inst = new Cls('test-model'); } catch (e) { check(`${a.name}: 构造`, false, `→ ${e.message}`); continue; }
    a.ok(inst);
    lines.length = 0;
    const out = await inst.sendRequest([{ role: 'user', content: 'hi' }], 'sys');
    const llmLine = lines.find((l) => l.startsWith('[llm]'));
    check(`${a.name}: 成功时记录了 usage`, !!llmLine, `→ ${llmLine ?? '(没有 [llm] 行)'}`);
    if (a.usage) {
        const p = Object.values(a.usage)[0], c = Object.values(a.usage)[1];
        check(`${a.name}: usage 数值正确`, !!llmLine && llmLine.includes(`prompt=${p}`) && llmLine.includes(`completion=${c}`),
            `→ ${llmLine}`);
    }
    check(`${a.name}: 成功时返回模型内容`, out === '模型说的话', `→ ${JSON.stringify(out)}`);

    // 失败路径
    const inst2 = new Cls('test-model');
    a.bad(inst2);
    const bad = await inst2.sendRequest([{ role: 'user', content: 'hi' }], 'sys');
    check(`${a.name}: 失败时返回 FAILED_REPLY 标记（不是假台词）`, isFailedReply(bad), `→ ${JSON.stringify(bad)}`);
    check(`${a.name}: 失败时返回值里不含假台词`, !/brain disconnected|thought too hard|No response (received|data|from)/i.test(String(bad)),
        `→ ${JSON.stringify(bad)}`);
}

// mistral 的客户端是私有字段（#client），没法从外部打桩 → 用源码断言覆盖（见本文件末尾的静态检查）
{
    const src = (await import('node:fs')).readFileSync(new URL('../src/models/mistral.js', import.meta.url), 'utf8');
    check('mistral: 取 content 前调用了 recordUsage(response?.usage, …)', /recordUsage\(response\?\.usage/.test(src));
    check('mistral: 失败分支给 failedReply', /result = failedReply\(/.test(src));
}

// Replicate：SDK 字段是公开的，可以直接打桩真跑
{
    const { ReplicateAPI } = await import('../src/models/replicate.js');
    const good = new ReplicateAPI('test-model');
    good.replicate = { run: async () => '模型说的话', stream: async function* () { yield '模型说的话'; } };
    lines.length = 0;
    const out = await good.sendRequest([{ role: 'user', content: 'hi' }], 'sys');
    check('replicate: 成功时返回内容', out === '模型说的话', `→ ${JSON.stringify(out)}`);
    check('replicate: 成功时记了 usage（流式无 usage → 记 missing 并带 tag）',
        lines.some((l) => l.startsWith('[llm]') && l.includes('tag=replicate')), `→ ${JSON.stringify(lines)}`);

    let tries = 0;
    const bad = new ReplicateAPI('test-model');
    bad.replicate = {
        run: async () => { throw new Error('boom'); },
        stream: async function* () { tries++; if (tries <= 2) throw Object.assign(new Error('rate limited'), { status: 429 }); yield '重试后成功'; },
    };
    const out2 = await bad.sendRequest([{ role: 'user', content: 'hi' }], 'sys');
    check('replicate: 429 会退避重试（stream 被调用 ≥3 次）', tries >= 3, `→ tries=${tries}`);
    check('replicate: 429 重试后拿到正常回答', out2 === '重试后成功', `→ ${JSON.stringify(out2)}`);
}

// Hyperbolic：裸 fetch，用全局 fetch 桩
{
    const { Hyperbolic } = await import('../src/models/hyperbolic.js');
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
        calls++;
        if (calls <= 2) return { ok: false, status: 429, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '重试后成功' }, finish_reason: 'stop' }], usage: { prompt_tokens: 31, completion_tokens: 17 } }) };
    };
    const h = new Hyperbolic('test-model');
    lines.length = 0;
    const out = await h.sendRequest([{ role: 'user', content: 'hi' }], 'sys');
    check('hyperbolic: 429 会退避重试（fetch 被调用 ≥3 次）', calls >= 3, `→ calls=${calls}`);
    check('hyperbolic: 429 重试后拿到正常回答', out === '重试后成功', `→ ${JSON.stringify(out)}`);
    check('hyperbolic: 记了 usage（prompt=31 completion=17）',
        lines.some((l) => l.includes('prompt=31') && l.includes('completion=17')), `→ ${JSON.stringify(lines)}`);

    globalThis.fetch = async () => { throw new Error('ECONNRESET stub'); };
    const h2 = new Hyperbolic('test-model');
    const out2 = await h2.sendRequest([{ role: 'user', content: 'hi' }], 'sys');
    check('hyperbolic: 网络异常 → 返回 FAILED_REPLY（不是假台词）', isFailedReply(out2), `→ ${JSON.stringify(out2)}`);
    globalThis.fetch = realFetch;
}

// ════════════════════════════════════════════════════════════
// C. prompter：失败不当回答
// ════════════════════════════════════════════════════════════
/** 造一个只带本测需要字段的 Prompter（不走真构造器：那会去 createModel/读 profile） */
function makePrompter(reply) {
    const p = Object.create(Prompter.prototype);
    p.agent = { name: 'bot1', history: { memory: '旧记忆：我找到过 3 个铁', getHistory: () => [{ role: 'user', content: 'old' }] } };

    p.profile = { conversing: 'CONV', coding: 'CODE', saving_memory: 'MEM', bot_responder: 'BOT', goal_setting: 'GOAL' };
    p.most_recent_msg_time = 0;
    p.awaiting_coding = false;
    p.convo_examples = null;
    p.coding_examples = null;
    p.checkCooldown = async () => {};
    p.replaceStrings = async (s) => s;
    p._saveLog = async (prompt, msgs, gen, tag) => { (p.saved ||= []).push(tag); };
    p.chat_model = { sendRequest: async () => (typeof reply === 'function' ? reply() : reply) };
    p.code_model = p.chat_model;
    p.vision_model = p.chat_model;
    return p;
}

{
    const p = makePrompter(failedReply('boom'));
    const out = await p.promptConvo([{ role: 'user', content: 'hi' }]);
    check('prompter.promptConvo: 失败 → 返回空串（= 无响应，不写 history）', out === '', `→ ${JSON.stringify(out)}`);
    check('prompter.promptConvo: 失败 → 绝不含标记（不会对玩家说出来）', !String(out).includes(FAILED_REPLY));
    check('prompter.promptConvo: 失败 → 记了 conversation-failed 日志',
        (p.saved || []).includes('conversation-failed'), `→ ${JSON.stringify(p.saved)}`);
    check('prompter.promptConvo: 失败 → 只尝试 1 次就收手（不把一次超时放大成三次）',
        (p.saved || []).filter((t) => t === 'conversation-failed').length === 1, `→ ${JSON.stringify(p.saved)}`);
}
{
    const p = makePrompter('模型说的话');
    const out = await p.promptConvo([{ role: 'user', content: 'hi' }]);
    check('prompter.promptConvo: 正常回答照旧返回', out === '模型说的话');
    check('prompter.promptConvo: 正常回答记正常 tag', (p.saved || []).includes('conversation'));
}
{
    const p = makePrompter(failedReply('boom'));
    const out = await p.promptCoding([{ role: 'user', content: 'hi' }]);
    check('prompter.promptCoding: 失败 → 把标记原样往上传（不会被当代码）', isFailedReply(out), `→ ${JSON.stringify(out)}`);
    check('prompter.promptCoding: 失败 → 标记里没有代码围栏（coder 的 indexOf("```") === -1 成立）',
        !String(out).includes('```'));
    check('prompter.promptCoding: 失败 → tag 是 coding-failed', (p.saved || []).includes('coding-failed'));
}
{
    const p = makePrompter(failedReply('boom'));
    const out = await p.promptMemSaving([{ role: 'user', content: 'hi' }]);
    check('prompter.promptMemSaving: 失败 → 保留原记忆（不覆盖成假台词）',
        out === '旧记忆：我找到过 3 个铁', `→ ${JSON.stringify(out)}`);
    check('prompter.promptMemSaving: 失败 → 不含标记', !String(out).includes(FAILED_REPLY));
}
{
    const p = makePrompter(failedReply('boom'));
    check('prompter.promptShouldRespondToBot: 失败 → false（不接话）',
        (await p.promptShouldRespondToBot('hey')) === false);
    const p2 = makePrompter('respond');
    check('prompter.promptShouldRespondToBot: 正常 respond → true',
        (await p2.promptShouldRespondToBot('hey')) === true);
}
{
    const p = makePrompter(failedReply('boom'));
    check('prompter.promptGoalSetting: 失败 → null（不会按 res.split 崩）',
        (await p.promptGoalSetting([], [])) === null);
}

// ════════════════════════════════════════════════════════════
// D. ollama：429 会重试、网络异常不再被吞
// ════════════════════════════════════════════════════════════
{
    const { Ollama } = await import('../src/models/ollama.js');
    const realFetch = globalThis.fetch;

    // D1: 网络异常 → 不再是 null / "No response data."，而是失败标记
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED stub'); };
    const m1 = new Ollama('test-model');
    const r1 = await m1.sendRequest([{ role: 'user', content: 'hi' }], 'sys');
    check('ollama: 网络异常 → 返回 FAILED_REPLY（不再吞成 null→"No response data."）',
        isFailedReply(r1), `→ ${JSON.stringify(r1)}`);

    // D2: 前两次 429、第三次 200 → 必须重试到成功
    let calls = 0;
    globalThis.fetch = async () => {
        calls++;
        if (calls <= 2) return { ok: false, status: 429, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ message: { content: '重试后成功' }, prompt_eval_count: 7, eval_count: 2 }) };
    };
    const m2 = new Ollama('test-model');
    lines.length = 0;
    const r2 = await m2.sendRequest([{ role: 'user', content: 'hi' }], 'sys');
    check('ollama: 429 会重试（fetch 被调用 ≥3 次）', calls >= 3, `→ calls=${calls}`);
    check('ollama: 429 重试后拿到正常回答', r2 === '重试后成功', `→ ${JSON.stringify(r2)}`);
    check('ollama: 重试成功后仍记了 usage', lines.some((l) => l.includes('prompt=7') && l.includes('completion=2')),
        `→ ${JSON.stringify(lines)}`);

    globalThis.fetch = realFetch;
}

// ════════════════════════════════════════════════════════════
// E. 静态覆盖：19 个适配器一个都不能漏
// ════════════════════════════════════════════════════════════
{
    const fs = await import('node:fs');
    const dir = new URL('../src/models/', import.meta.url);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')
        && !['_shared.js', '_model_map.js', 'prompter.js', 'azure.js'].includes(f));
    const missing = [];
    for (const f of files) {
        const src = fs.readFileSync(new URL(f, dir), 'utf8');
        if (!/recordUsage\(/.test(src)) missing.push(f);
    }
    check('19 个适配器全都调用了 recordUsage', missing.length === 0, `→ 缺: ${JSON.stringify(missing)}`);

    const leftovers = [];
    for (const f of files) {
        const src = fs.readFileSync(new URL(f, dir), 'utf8');
        if (/brain disconnected|thought too hard|No response received|No response data|No response from Claude|An unexpected error occurred/i.test(src)) leftovers.push(f);
    }
    check('src/models/ 里没有残留的「失败装成话」字面量', leftovers.length === 0, `→ 残留: ${JSON.stringify(leftovers)}`);

    const noRetry = [];
    for (const f of ['hyperbolic.js', 'ollama.js', 'replicate.js']) {
        const src = fs.readFileSync(new URL(f, dir), 'utf8');
        if (!/isRateLimit\(/.test(src) || !/rateLimitDelayMs\(/.test(src)) noRetry.push(f);
    }
    check('hyperbolic / ollama / replicate 都接上了 429 退避重试', noRetry.length === 0, `→ 缺: ${JSON.stringify(noRetry)}`);

    const ollamaSrc = fs.readFileSync(new URL('ollama.js', dir), 'utf8');
    const swallow = /catch \(err\) \{[\s\S]{0,400}?console\.error\(err\);[\s\S]{0,80}?\n        \}\n        return data;/;
    check('ollama.send() 不再把异常吞成 null（catch 里重新 throw）',
        /console\.error\('Failed to send Ollama request\.'\);[\s\S]{0,120}?throw err;/.test(ollamaSrc), `→ ${swallow.test(ollamaSrc)}`);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
