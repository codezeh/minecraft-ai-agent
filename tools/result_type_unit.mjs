/**
 * 架构收敛项(1)：模型返回值类型化（A5 §3）—— 离线单测。
 *
 * 钉住的契约：
 *   ① `ModelResult` 字段/状态机/过渡兼容（toString 重现旧标记语义）；content **永不含标记**；
 *   ② 桥 `toModelResult()` 把老字符串逐条分类（失败→error+errorCode 推断；截断→truncated 且已剥离）；
 *   ③ 结构化提级：`finishReason='length'|'max_tokens'|'MAX_TOKENS'|'model_length'` ⇒ status=truncated
 *      **不需要适配器再往字符串拼 `[LLM_TRUNCATED]`**（A 项：6 个此前没有截断检测的适配器）；
 *   ④ prompter 的 *Result() 出口：失败/截断/取消各有 status；旧方法仍返回老形状字符串（迁移期兼容）；
 *   ⑤ 分布计数（`modelResultTotals`）与 `formatModelTotals()` —— 也就是 `usageTotals()` 的**真实消费者**；
 *   ⑥ `last_convo_truncated` 死标志已被真实消费者读取（不是只写不读）。
 */
import {
    ModelResult, STATUS, ERROR_CODE, toModelResult, inferErrorCode, assertModelResult, coerceModelResult,
    isOutputLimit, noteModelResult, modelResultTotals, resetModelResultTotals, formatModelTotals,
} from '../src/models/result.js';
import { TRUNCATED_SUFFIX, FAILED_REPLY, failedReply } from '../src/models/_shared.js';

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key-not-real';
import { Prompter } from '../src/models/prompter.js';
import { Coder } from '../src/agent/coder.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

// ══════════════════════════════════════════════════════════════════════
// ① ModelResult 本体
// ══════════════════════════════════════════════════════════════════════
{
    const r = new ModelResult({ content: '正文' });
    check('① 默认值是安全默认（status=ok、elapsedMs=0、attempts=1、usage/finishReason=null）',
        r.status === STATUS.OK && r.elapsedMs === 0 && r.attempts === 1 && r.usage === null && r.finishReason === null);
    check('① ok / truncated / failed / hasContent 四个派生判据互斥正确',
        r.ok && !r.truncated && !r.failed && r.hasContent);
    check('① status 非法值回落到 ok（不让脏数据把状态机带偏）',
        new ModelResult({ status: 'nonsense' }).status === STATUS.OK);
    check('① toString 重现旧语义：ok→正文', String(new ModelResult({ content: 'a' })) === 'a');
    check('① toString 重现旧语义：truncated→正文+标记',
        String(new ModelResult({ content: 'a', status: STATUS.TRUNCATED })) === 'a' + TRUNCATED_SUFFIX);
    check('① toString 重现旧语义：error→[LLM_ERROR] 前缀',
        String(new ModelResult({ status: STATUS.ERROR, errorCode: 'NETWORK', errorMessage: 'boom' })) === failedReply('boom'));
    check('① toJSON 只含业务字段（不含 getter/原型）',
        Object.keys(r.toJSON()).sort().join(',') === 'attempts,content,elapsedMs,errorCode,errorMessage,finishReason,status,usage');
}

// ══════════════════════════════════════════════════════════════════════
// ② 桥：老字符串 → 结构化（A5 §3.3 步 0）
// ══════════════════════════════════════════════════════════════════════
{
    const ok = toModelResult('她说话了', { elapsedMs: 12, attempts: 2 });
    check('② 普通正文 → ok，且观测字段带过去', ok.ok && ok.content === '她说话了' && ok.elapsedMs === 12 && ok.attempts === 2);

    const tr = toModelResult('半句话' + TRUNCATED_SUFFIX);
    check('② 截断串 → status=truncated 且 content **已剥离**标记',
        tr.truncated && tr.content === '半句话' && !tr.content.includes('[LLM_TRUNCATED]'));

    const er = toModelResult(failedReply('429 rate limited'));
    check('② 失败串 → status=error 且 content 为空（不是"模型说的话"）', er.failed && er.content === '');
    check('② 失败串 → errorCode 推断 RATE_LIMIT', er.errorCode === ERROR_CODE.RATE_LIMIT);
    check('② 失败串 → errorMessage 去掉前缀（可写日志）', er.errorMessage === '429 rate limited');

    check('② errorCode 推断：timeout', toModelResult(failedReply('模型请求超过总期限 120000ms')).errorCode === ERROR_CODE.TIMEOUT);
    check('② errorCode 推断：auth', toModelResult(failedReply('401 Unauthorized')).errorCode === ERROR_CODE.AUTH);
    check('② errorCode 推断：context length', toModelResult('[LLM_ERROR] maximum context length exceeded').errorCode === ERROR_CODE.CONTEXT_LENGTH);
    check('② errorCode 推断：network', toModelResult(failedReply('ECONNREFUSED')).errorCode === ERROR_CODE.NETWORK);
    check('② errorCode 推断：默认 BAD_RESPONSE', inferErrorCode('something odd') === ERROR_CODE.BAD_RESPONSE);

    check('② 空串/null 仍算 ok（与旧语义一致：空 ≠ 失败，但可选性由 status 表达）',
        toModelResult('').ok && toModelResult(null).ok && toModelResult(null).content === '');
    const passthrough = toModelResult(ok, { elapsedMs: 99 });
    check('② ModelResult 输入原样通过并合并观测字段（elapsedMs 覆盖）', passthrough.elapsedMs === 99 && passthrough.content === '她说话了');
}

// ══════════════════════════════════════════════════════════════════════
// ③ 结构化提级：finishReason 承载截断（A 项：6 个适配器不再各自编标记）
// ══════════════════════════════════════════════════════════════════════
{
    check('③ isOutputLimit 认四家取值', isOutputLimit('length') && isOutputLimit('max_tokens')
        && isOutputLimit('MAX_TOKENS') && isOutputLimit('model_length'));
    check('③ isOutputLimit 不误判 stop/tool_use/null',
        !isOutputLimit('stop') && !isOutputLimit('tool_use') && !isOutputLimit(null));

    const t = toModelResult('半截代码', { finishReason: 'length' });
    check('③ ★ finishReason=length ⇒ status=truncated（正文不带标记）',
        t.truncated && t.content === '半截代码' && !t.content.includes('[LLM_TRUNCATED]') && t.finishReason === 'length');
    const s = toModelResult('完整', { finishReason: 'stop' });
    check('③ finishReason=stop ⇒ status=ok', s.ok, `status=${s.status}`);
    const usageShape = toModelResult('x', { usage: { prompt: 3, completion: 2, missing: false } });
    check('③ usage 进结果字段（成本可传递）', usageShape.usage.prompt === 3 && usageShape.usage.completion === 2);
}

// ══════════════════════════════════════════════════════════════════════
// ④ 不变量断言：content 永不含标记 / error 必有 errorCode
// ══════════════════════════════════════════════════════════════════════
{
    const bad1 = new ModelResult({ content: '正文' + TRUNCATED_SUFFIX });
    const bad2 = new ModelResult({ content: FAILED_REPLY + ' boom' });
    const bad3 = new ModelResult({ status: STATUS.ERROR });
    const throws = (r) => { try { assertModelResult(r, 'probe'); return false; } catch { return true; } };
    check('④ 断言：content 混进截断标记 → 抛', throws(bad1));
    check('④ 断言：content 混进失败标记 → 抛', throws(bad2));
    check('④ 断言：status=error 但没有 errorCode → 抛', throws(bad3));
    check('④ 断言：合法结果不抛', !throws(new ModelResult({ content: 'ok' })));
    const coerced = coerceModelResult(bad1, 'probe');
    check('④ coerce 把非法结果降级成 error（生产路径不因断言崩溃）',
        coerced.status === STATUS.ERROR && coerced.errorCode === ERROR_CODE.BAD_RESPONSE);
    check('④ 断言能认出不是 ModelResult 的输入',
        (() => { try { assertModelResult('字符串', 'probe'); return false; } catch { return true; } })());
}

// ══════════════════════════════════════════════════════════════════════
// ⑤ prompter 的 *Result() 出口（步 1）+ 旧方法仍是老形状字符串
// ══════════════════════════════════════════════════════════════════════
const mkPrompter = (chatReply, codeReply) => {
    const p = Object.create(Prompter.prototype);
    p.agent = { name: 'probe', history: { memory: 'old', getHistory: () => [] } };
    p.most_recent_msg_time = 0;
    p.profile = { conversing: 'P', coding: 'P', saving_memory: 'P', bot_responder: 'P', image_analysis: 'P' };
    p.convo_examples = [];
    p.coding_examples = [];
    p.awaiting_coding = false;
    p.checkCooldown = async () => { };
    p.replaceStrings = (x) => Promise.resolve(x);
    p._saveLog = async () => { };
    p.chat_model = { sendRequest: () => Promise.resolve(chatReply) };
    p.code_model = { sendRequest: () => Promise.resolve(codeReply) };
    p.vision_model = { sendVisionRequest: () => Promise.resolve(chatReply) };
    return p;
};

{
    resetModelResultTotals();
    const p = mkPrompter('她说完了');
    const r = await p.promptConvoResult([{ role: 'user', content: 'hi' }]);
    check('⑤ promptConvoResult：正常 ⇒ ok + content', r.ok && r.content === '她说完了');
    check('⑤ promptConvoResult：带 elapsedMs/attempts 观测字段',
        Number.isFinite(r.elapsedMs) && r.attempts === 1);
    check('⑤ promptConvo（旧名）仍返回老形状字符串（迁移期兼容）',
        (await mkPrompter('她说完了').promptConvo([{ role: 'user', content: 'hi' }])) === '她说完了');

    const pt = mkPrompter('半句' + TRUNCATED_SUFFIX);
    const rt = await pt.promptConvoResult([{ role: 'user', content: 'hi' }]);
    check('⑤ promptConvoResult：截断 ⇒ status=truncated，content 干净',
        rt.truncated && rt.content === '半句' && !rt.content.includes('LLM_TRUNCATED'));
    check('⑤ promptConvo（旧名）截断时仍返回"无标记正文"（玩家看不到暗号）',
        (await mkPrompter('半句' + TRUNCATED_SUFFIX).promptConvo([])) === '半句');

    const pf = mkPrompter(failedReply('429 rate limited'));
    const rf = await pf.promptConvoResult([{ role: 'user', content: 'hi' }]);
    check('⑤ promptConvoResult：失败 ⇒ status=error + RATE_LIMIT（不再是"空串"）',
        rf.failed && rf.errorCode === ERROR_CODE.RATE_LIMIT);
    check('⑤ promptConvo（旧名）失败时仍返回空串（agent.js 见空串即 break，逐字不变）',
        (await mkPrompter(failedReply('boom')).promptConvo([])) === '');

    // 被新消息取代 ⇒ cancelled（旧语义不可区分，现在可判别）
    const pc = mkPrompter('a');
    pc.most_recent_msg_time = 111;
    pc.checkCooldown = () => { pc.most_recent_msg_time = 222; };  // 冷却期间来了新消息
    const rc = await pc.promptConvoResult([]);
    check('⑤ promptConvoResult：被新消息取代 ⇒ status=cancelled（旧实现返回空串、不可区分）', rc.status === STATUS.CANCELLED);
    check('⑤ promptConvo（旧名）被取代时仍返回空串', (await (() => {
        const q = mkPrompter('a'); q.checkCooldown = () => { q.most_recent_msg_time = 999; };
        return q.promptConvo([]);
    })()) === '');

    // 代码生成：截断 ⇒ truncated 且给无代码信号（H2 契约不回退）
    const pcode = mkPrompter(null, '```js\nskills.foo();\n' + TRUNCATED_SUFFIX);
    const rcode = await pcode.promptCodingResult([]);
    check('⑤ promptCodingResult：截断 ⇒ status=truncated + content 是 NO_CODE 信号',
        rcode.truncated && rcode.isNoCode);
    check('⑤ promptCoding（旧名）截断时仍给无代码信号（coder 不会被骗去执行）',
        (await mkPrompter(null, '```js\n1;\n' + TRUNCATED_SUFFIX).promptCoding([])).startsWith('[NO_CODE]'));

    // 记忆摘要：截断 ⇒ truncated，且旧名返回旧记忆（H4 不回退）
    const pm = mkPrompter('新摘要' + TRUNCATED_SUFFIX);
    const rm = await pm.promptMemSavingResult('t');
    check('⑤ promptMemSavingResult：截断 ⇒ status=truncated', rm.truncated);
    check('⑤ promptMemSaving（旧名）截断时返回旧记忆（不覆盖 memory.json）',
        (await mkPrompter('新摘要' + TRUNCATED_SUFFIX).promptMemSaving('t')) === 'old');

    // bot_responder：失败 ⇒ false（旧语义），成功 ⇒ 比较 content
    check('⑤ promptShouldRespondToBot：respond ⇒ true', (await mkPrompter('respond').promptShouldRespondToBot('hi')) === true);
    check('⑤ promptShouldRespondToBot：失败 ⇒ false（不接话）',
        (await mkPrompter(failedReply('boom')).promptShouldRespondToBot('hi')) === false);

    // 视觉：失败不再以 [LLM_ERROR] 字符串混进"图像分析"（缺口 C 的入口）
    const pv = mkPrompter(failedReply('vision down'));
    const rv = await pv.promptVisionResult([], Buffer.from('x'));
    check('⑤ promptVisionResult：失败 ⇒ status=error（可判别，不再是一根带标记的字符串）', rv.failed);
    check('⑤ promptVision（旧名）仍是字符串（vision_interpreter 未迁移）',
        typeof (await mkPrompter('图里有个箱子').promptVision([], Buffer.from('x'))) === 'string');
}

// ══════════════════════════════════════════════════════════════════════
// ⑥ 分布计数 + 真实消费者（usageTotals / last_convo_truncated 死标志）
// ══════════════════════════════════════════════════════════════════════
{
    resetModelResultTotals();
    noteModelResult(new ModelResult({ content: 'a' }));
    noteModelResult(new ModelResult({ content: 'b', status: STATUS.TRUNCATED }));
    noteModelResult(new ModelResult({ status: STATUS.ERROR, errorCode: 'NETWORK' }));
    noteModelResult(new ModelResult({ status: STATUS.TIMEOUT, errorCode: 'TIMEOUT' }));
    const t = modelResultTotals();
    check('⑥ 分布计数：calls/ok/truncated/error/timeout 各就位',
        t.calls === 4 && t.ok === 1 && t.truncated === 1 && t.error === 1 && t.timeout === 1, JSON.stringify(t));

    const line = formatModelTotals();
    check('⑥ ★ formatModelTotals 是真实消费者：一行同时含结果分布与用量累计',
        /\[llm\] totals calls=4 ok=1 truncated=1/.test(line) && /usage calls=/.test(line), line);

    // last_convo_truncated：不是死标志 —— 值由 status 派生，并被 logTotals() 读出来
    resetModelResultTotals();
    const p = mkPrompter('半句' + TRUNCATED_SUFFIX);
    await p.promptConvoResult([]);
    const totalsLine = p.logTotals();
    check('⑥ ★ last_convo_truncated 现在**有人读**（logTotals 打出它）',
        /lastConvoTruncated=true/.test(totalsLine) && /lastConvoStatus=truncated/.test(totalsLine), totalsLine);
    check('⑥ 语义仍然正确：非截断时该行是 false',
        /lastConvoTruncated=false/.test(mkPrompter('完整').logTotals()));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
