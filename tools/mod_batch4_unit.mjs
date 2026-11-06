/**
 * MOD-001 ~ MOD-006（2026-11-06 深度检查）—— 模型适配器层六条，全部离线。
 *
 * 不调用任何真实模型/网络：SDK 与 fetch 全部用假对象替换。
 *
 * MOD-001 输出长度截断被误当上下文超限（DeepSeek/GPT/Hyperbolic）
 * MOD-002 strictFormat 修改调用方数组内对象 → 重试重复拼接
 * MOD-003 GPT 视觉请求把图像内容数组拼成字符串（图片丢失）
 * MOD-004 Gemini 嵌入返回对象数组 → 相似度 NaN
 * MOD-005 代码提示准备失败后 awaiting_coding 永久为 true
 * MOD-006 裸 fetch 没有应用级总期限/取消信号
 *
 * 输出：PASS/FAIL，全过退出码 0。
 */
import {
    isFailedReply, isTruncatedReply, markTruncated, isContextLengthError, fetchWithDeadline,
} from '../src/models/_shared.js';

// ★ 适配器构造函数会读 key（keys.json / 环境变量）。这里给**假 key**，
//   只为通过构造检查；所有请求都走被替换掉的假 SDK，绝不发真实网络请求。
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test-key-not-real';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key-not-real';
process.env.HYPERBOLIC_API_KEY = process.env.HYPERBOLIC_API_KEY || 'test-key-not-real';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key-not-real';
import { strictFormat } from '../src/utils/text.js';
import { cosineSimilarity } from '../src/utils/math.js';
import { DeepSeek } from '../src/models/deepseek.js';
import { GPT } from '../src/models/gpt.js';
import { Hyperbolic } from '../src/models/hyperbolic.js';
import { Prompter } from '../src/models/prompter.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

// ══════════════════════════════════════════════════════════════════════
// MOD-002：格式化不得改输入、两次结果一致、冻结输入也能跑
// ══════════════════════════════════════════════════════════════════════
{
    const turns = [
        { role: 'user', content: 'A' },
        { role: 'user', content: 'B' },
        { role: 'system', content: 'S' },
    ];
    const snapshot = JSON.stringify(turns);
    const first = strictFormat(turns);
    check('MOD-002 格式化不改调用方对象（逐字比对）', JSON.stringify(turns) === snapshot,
        `输入=${JSON.stringify(turns).slice(0, 60)}`);
    const second = strictFormat(turns);
    check('MOD-002 两次格式化结果一致（不重复拼接）',
        JSON.stringify(first) === JSON.stringify(second),
        `first=${JSON.stringify(first).slice(0, 70)}`);
    check('MOD-002 连续 user 回合被合并成一条',
        first.length === 1 && first[0].role === 'user' && first[0].content === 'A\nB\nSYSTEM: S',
        JSON.stringify(first));
    check('MOD-002 system 被改成 user 并加 SYSTEM: 前缀（原对象不动）',
        first[0].content.includes('SYSTEM: S') && turns[2].role === 'system',
        `输出=${first[0].content} 输入角色=${turns[2].role}`);

    // 冻结输入也必须能跑（真实场景：上层把历史 freeze 后传下来）
    const frozen = Object.freeze([Object.freeze({ role: 'user', content: ' X ' })]);
    let threw = null;
    try { strictFormat(frozen); } catch (e) { threw = e; }
    check('MOD-002 冻结输入不抛异常', threw === null, threw ? String(threw.message) : '');

    // 多模态数组：结构必须保留
    const vision = [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }];
    const visionOut = strictFormat(vision);
    check('MOD-002 多模态数组内容不被拼成字符串',
        Array.isArray(visionOut[0].content) && visionOut[0].content[0].type === 'input_text',
        JSON.stringify(visionOut[0].content));
    check('MOD-002 多模态数组是**副本**（不是同一引用）',
        visionOut[0].content !== vision[0].content, '');
}

// ══════════════════════════════════════════════════════════════════════
// MOD-001：输出截断 ≠ 上下文超限
// ══════════════════════════════════════════════════════════════════════
{
    // 判据本身：不再把"我们用来自证的假错误"当上下文超限
    check('MOD-001 length 截断不被判成上下文超限',
        isContextLengthError(new Error('Context length exceeded')) === true
        && isContextLengthError({ code: 'context_length_exceeded' }) === true
        && isContextLengthError(new Error('finish_reason=length')) === false,
        '');
    check('MOD-001 截断标记可判别且幂等',
        isTruncatedReply(markTruncated('abc')) && markTruncated(markTruncated('abc')) === markTruncated('abc'), '');

    // DeepSeek：finish_reason=length 时只发 1 次请求、返回内容+标记、**不删历史**
    const calls = [];
    const ds = new DeepSeek('deepseek-chat', null, null);
    ds.openai = {
        chat: { completions: { create: async (pack) => { calls.push(pack); return {
            choices: [{ finish_reason: 'length', message: { content: '半句话' } }],
            usage: { prompt_tokens: 1, completion_tokens: 2 },
        }; } } },
    };
    const dsOut = await ds.sendRequest([{ role: 'user', content: 'hi' }], 'sys');
    check('MOD-001 DeepSeek 截断只调用 1 次（不再 6 次递归）', calls.length === 1, `calls=${calls.length}`);
    check('MOD-001 DeepSeek 截断返回已得内容并打标记',
        isTruncatedReply(dsOut) && dsOut.includes('半句话'), `out=${String(dsOut).slice(0, 40)}`);
    check('MOD-001 DeepSeek 截断不是失败标记', !isFailedReply(dsOut), '');

    // DeepSeek：真正的上下文超限仍然裁历史重试（行为保留）
    const calls2 = [];
    let n = 0;
    const ds2 = new DeepSeek('deepseek-chat', null, null);
    ds2.openai = { chat: { completions: { create: async (pack) => {
        calls2.push(pack);
        if (n++ === 0) throw Object.assign(new Error('max context'), { code: 'context_length_exceeded' });
        return { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: {} };
    } } } };
    const dsOut2 = await ds2.sendRequest([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }], 'sys');
    check('MOD-001 真上下文超限才裁历史重试', calls2.length === 2 && dsOut2 === 'ok',
        `calls=${calls2.length} out=${dsOut2}`);
}

// ══════════════════════════════════════════════════════════════════════
// MOD-003：视觉请求的图片数组不许被拼成字符串
// ══════════════════════════════════════════════════════════════════════
{
    const captured = [];
    const gpt = new GPT('gpt-5.4-mini', null, null);   // 无自定义 url → 走 responses
    gpt.openai = {
        responses: { create: async (req) => { captured.push(req); return {
            output_text: 'ok***', status: 'completed', usage: {},
        }; } },
        chat: { completions: { create: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'x' } }], usage: {} }) } },
    };
    const out = await gpt.sendVisionRequest(
        [{ role: 'user', content: 'hi' }], 'sys', Buffer.from('FAKE-IMAGE'),
    );
    const input = captured[0]?.input ?? [];
    const last = input[input.length - 1];
    check('MOD-003 视觉请求最后一条是数组内容（不是字符串）',
        Array.isArray(last?.content), `type=${typeof last?.content}`);
    const imgPart = Array.isArray(last?.content) ? last.content.find(p => p?.type === 'input_image') : null;
    check('MOD-003 图片 data URL 完整保留',
        !!imgPart && String(imgPart.image_url).includes('data:image'),
        `part=${JSON.stringify(imgPart)?.slice(0, 80)}`);
    check('MOD-003 内容里不再出现 [object Object]',
        !JSON.stringify(input).includes('[object Object]'), '');
    check('MOD-003 视觉请求正常返回', out === 'ok', `out=${String(out).slice(0, 30)}`);

    // 自定义 URL（Chat Completions 分支）同样不许把数组拼成字符串
    const captured2 = [];
    const gpt2 = new GPT('gpt-5.4-mini', 'https://example.invalid/v1', null);
    gpt2.openai = { chat: { completions: { create: async (pack) => {
        captured2.push(pack);
        return { choices: [{ finish_reason: 'stop', message: { content: 'y' } }], usage: {} };
    } } } };
    await gpt2.sendRequest([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], 'sys');
    const msgs = captured2[0]?.messages ?? [];
    check('MOD-003 Chat-Completions 分支的数组内容也没被拼字符串',
        !JSON.stringify(msgs).includes('[object Object]'), JSON.stringify(msgs).slice(0, 80));
}

// ══════════════════════════════════════════════════════════════════════
// MOD-004：Gemini 嵌入必须是数值向量，否则相似度是 NaN
// ══════════════════════════════════════════════════════════════════════
{
    const { Gemini } = await import('../src/models/gemini.js');
    // 直接构造会要求 API key；用一个最小替身，只验证 embed() 的形状收敛逻辑
    const g = Object.create(Gemini.prototype);
    g.model_name = 'gemini-embedding-001';
    let shape = 'ok';
    g.genAI = { models: { embedContent: async () => {
        if (shape === 'ok') return { embeddings: [{ values: [0.1, 0.2, 0.3] }] };
        if (shape === 'empty') return { embeddings: [] };
        if (shape === 'nan') return { embeddings: [{ values: [0.1, 'x'] }] };
        return { embeddings: [{ values: [1, 2] }, { values: [3, 4] }] };
    } } };

    const v = await g.embed('t');
    check('MOD-004 正常情况返回数值数组', Array.isArray(v) && v.length === 3 && typeof v[0] === 'number',
        JSON.stringify(v));
    check('MOD-004 相同向量余弦相似度≈1', Math.abs(cosineSimilarity(v, v) - 1) < 1e-9,
        String(cosineSimilarity(v, v)));

    shape = 'empty';
    const vEmpty = await g.embed('t');
    check('MOD-004 空结果返回 null（不再把对象交给消费者）', vEmpty === null, String(vEmpty));

    shape = 'nan';
    const vNan = await g.embed('t');
    check('MOD-004 含非数返回 null（不产生 NaN 相似度）', vNan === null, String(vNan));

    shape = 'multi';
    const vMulti = await g.embed('t');
    check('MOD-004 多向量时取第一条（形状确定）',
        Array.isArray(vMulti) && vMulti.length === 2 && vMulti[0] === 1, JSON.stringify(vMulti));

    // 消费者的 NaN 也必须在向量层面消失
    check('MOD-004 修复后不再出现 NaN 相似度',
        !Number.isNaN(cosineSimilarity([0.1, 0.2], [0.1, 0.2])), '');
}

// ══════════════════════════════════════════════════════════════════════
// MOD-005：准备失败后 awaiting_coding 必须被清掉
// ══════════════════════════════════════════════════════════════════════
{
    const p = Object.create(Prompter.prototype);
    p.awaiting_coding = false;
    p.profile = { coding: 'PROMPT' };
    p.coding_examples = null;
    p.checkCooldown = async () => { };
    p._saveLog = async () => { };
    p.code_model = { sendRequest: async () => '```js\n1\n```' };
    let boom = true;
    p.replaceStrings = async () => {
        if (boom) { boom = false; throw new Error('replaceStrings 炸了'); }
        return 'PROMPT';
    };

    let threw = null;
    try { await p.promptCoding([{ role: 'user', content: 'x' }]); } catch (e) { threw = e; }
    check('MOD-005 准备失败如实抛给调用方（不吞）', threw !== null, threw ? String(threw.message) : '');
    check('MOD-005 准备失败后 awaiting_coding 已清零', p.awaiting_coding === false,
        `awaiting_coding=${p.awaiting_coding}`);

    const second = await p.promptCoding([{ role: 'user', content: 'y' }]);
    check('MOD-005 下一次正常请求能进入（不再永久 no response）',
        second === '```js\n1\n```', String(second).slice(0, 30));
    check('MOD-005 正常路径结束后标记也是 false', p.awaiting_coding === false, '');
}

// ══════════════════════════════════════════════════════════════════════
// MOD-006：总期限 + 取消 → 不挂死、不留定时器
// ══════════════════════════════════════════════════════════════════════
{
    // ① 真·不返回的 fetch（受 signal 控制）→ 必须在期限后结束
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => new Promise((resolve, reject) => {
        const sig = init?.signal;
        if (sig) sig.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        // 永不 resolve
    });
    const t0 = Date.now();
    let err = null;
    try { await fetchWithDeadline('http://x.invalid', {}, { timeoutMs: 60 }); } catch (e) { err = e; }
    const cost = Date.now() - t0;
    check('MOD-006 请求不返回时按期失败（不再无限等待）',
        err && err.code === 'LLM_TIMEOUT' && cost < 2000, `code=${err?.code} 耗时=${cost}ms`);
    check('MOD-006 超时错误可判别为 AbortError', err?.name === 'AbortError', String(err?.name));

    // ② 外部取消（用户打断/新消息取代）→ 立刻结束
    const ac = new AbortController();
    const p2 = fetchWithDeadline('http://x.invalid', { signal: ac.signal }, { timeoutMs: 60000 });
    setTimeout(() => ac.abort(), 30);
    let err2 = null;
    try { await p2; } catch (e) { err2 = e; }
    check('MOD-006 外部取消能真的打断请求', err2 && err2.code === 'LLM_TIMEOUT',
        `code=${err2?.code}`);

    // ③ 正常返回时也必须清掉定时器（不留残留 timer）
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    const r = await fetchWithDeadline('http://x.invalid', {}, { timeoutMs: 60000 });
    check('MOD-006 正常路径返回 Response', r.ok === true, `ok=${r.ok}`);
    const alive = process.getActiveResourcesInfo?.() ?? [];
    check('MOD-006 正常返回后没有残留定时器',
        !alive.includes('Timeout'), `active=${JSON.stringify(alive)}`);

    globalThis.fetch = realFetch;
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
