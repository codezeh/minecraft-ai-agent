/**
 * S43 / S44 回归护栏（报告「三、小项」最后两条）。
 *
 * S43 —— `src/agent/agent.js`
 *   ① 同一文件里 `bot.on('error')` 注册了两处（`start()` 与 `startEvents()`），
 *      同一次错误被打两遍：一份走「致命与否」判定，另一份只 `console.error('Error event!')`。
 *      修法：合并成一处（保留能判致命的那份，把 err 本体带堆栈的信息并进去）。
 *   ② 调用点裸调 `this._setupEventHandlers(...)`（fire-and-forget）：
 *      **这个方法是真的 async**（内部有 3 处 await），裸调的后果是
 *      ①它内部抛错 = unhandled rejection，外层 try/catch 抓不到；
 *      ②`startEvents()` / `task.initBotTask()` 会和它并发。
 *      修法：显式 `await`，异常进外层 catch。
 * S44 —— `src/models/_model_map.js`
 *   `profile.model` 缺省时直接 `.includes(...)` / `.replace(...)` 崩：
 *   `{"api":"deepseek"}`（合法！用该 api 默认模型）原来在 `.replace` 上 TypeError，
 *   profile 里连 model 都没写则在 `.includes` 上 TypeError。修法：归一成空串 ⇒ model 置 null。
 *
 * ⚠️ 桩函数不要写 `async`：本仓 `lint:tools` 是棘轮（基线 278，只许降不许升），
 *    `async` 里没有 `await` 会记 require-await。只返回固定值就 `return Promise.resolve(x)`。
 *
 * 输出：PASS <用例> / FAIL <用例> <实际>，全过退出码 0。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentSrcPath = path.join(__dirname, '../src/agent/agent.js');
const src = fs.readFileSync(agentSrcPath, 'utf8');
// 注释里会**故意**引用被删掉的旧代码（好让后来的人知道删了什么），
// 所以判「还在不在」时必须先剥掉注释，否则会把自己的说明文字当成代码。
const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')     // 块注释
    .replace(/^\s*\/\/.*$/gm, '')        // 整行行注释
    .replace(/\s\/\/.*$/gm, '');         // 行尾行注释

// ════════════════════════════════════════════════════════════
// S43-① 同一错误只处理一遍
// ════════════════════════════════════════════════════════════
{
    // 只数「代码里的注册」，注释里的提及不算：`bot.on('error'` 后面跟的必须是真的注册
    const regs = [...code.matchAll(/this\.bot\.on\(\s*'error'\s*,/g)];
    check('S43-① agent.js 里 bot.on(\'error\') 只有 1 处注册', regs.length === 1,
        `→ 找到 ${regs.length} 处`);

    // 保留的那处必须仍在（含致命判定），且带堆栈信息的日志也在
    check('S43-① 保留的那处仍能区分致命错误（Duplicate / ECONNREFUSED → onDisconnect）',
        /const fatal = String\(err\)\.includes\('Duplicate'\) \|\| String\(err\)\.includes\('ECONNREFUSED'\)/.test(code));
    check('S43-① 被删那份的价值（err 本体带堆栈）已并进来',
        /console\.error\(`\[\$\{this\.name\}\] bot error:`, err\)/.test(code));
    check('S43-① 原来那句裸打印已从代码里消失（注释里保留说明不算）',
        !/console\.error\('Error event!', err\)/.test(code));
}

// ════════════════════════════════════════════════════════════
// S43-② _setupEventHandlers 的调用点必须 await
// ════════════════════════════════════════════════════════════
{
    check('S43-② 前置事实：_setupEventHandlers 确实是 async 且内部有 await',
        /async _setupEventHandlers\(/.test(src) &&
        (src.slice(src.indexOf('async _setupEventHandlers(')).match(/await /g) || []).length > 0);

    const callSite = /await this\._setupEventHandlers\(save_data, init_message\);/;
    check('S43-② 调用点显式 await（异常会进外层 try/catch）', callSite.test(src));

    // 反例：不许再出现裸调用（未 await、也没有 .catch 兜）
    const bare = [...src.matchAll(/^(?!.*await).*this\._setupEventHandlers\(save_data, init_message\);(?!.*catch)/gm)]
        .filter((m) => !/await/.test(m[0]));
    check('S43-② 没有留下 fire-and-forget 的裸调用', bare.length === 0, `→ 裸调用 ${bare.length} 处`);

    // 且它确实位于 try 块内（外层 catch 现在真的能兜住）
    const callIdx = src.indexOf('await this._setupEventHandlers(');
    const tryIdx = src.lastIndexOf('try {', callIdx);
    const catchIdx = src.indexOf('} catch (error)', callIdx);
    check('S43-② await 在 try 块内、后面有 catch 兜底',
        tryIdx > 0 && catchIdx > callIdx && catchIdx - callIdx < 2000,
        `→ try=${tryIdx}, call=${callIdx}, catch=${catchIdx}`);
}

// ════════════════════════════════════════════════════════════
// S44 selectAPI：profile.model 缺省/非字符串不能崩
// ════════════════════════════════════════════════════════════
// 构造模型对象需要 key；给假值，绝不发请求
for (const k of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY']) {
    process.env[k] ||= 'test-key-not-real';
}
const { selectAPI, createModel } = await import('../src/models/_model_map.js');

const tryCall = (fn) => {
    try { return { ok: true, value: fn() }; }
    catch (e) { return { ok: false, error: `${e.constructor.name}: ${e.message}` }; }
};

{
    // ① 报告点名的合法写法：只写 api，用该 api 的默认模型
    const r = tryCall(() => selectAPI({ api: 'deepseek' }));
    check('S44-① {"api":"deepseek"} 不再崩', r.ok, `→ ${r.error ?? ''}`);
    check('S44-① 归一成 model=null（= 用供应商默认模型）',
        r.ok && r.value.api === 'deepseek' && r.value.model === null, `→ ${JSON.stringify(r.value)}`);
}
{
    // ② 走到 createModel 也必须是「默认模型」而不是崩
    const r = tryCall(() => createModel(selectAPI({ api: 'deepseek' })));
    check('S44-② {"api":"deepseek"} 能一路建出模型实例', r.ok, `→ ${r.error ?? ''}`);
    check('S44-② 实例的 model_name 是 null（供应商侧会用自己的默认值）',
        r.ok && r.value.model_name === null, `→ ${r.ok ? String(r.value.model_name) : ''}`);
}
{
    // ③ 连 api 都没有：给一条能看懂的错误，而不是 TypeError 崩在 .includes
    const r = tryCall(() => selectAPI({}));
    check('S44-③ 空 profile → 明确报错（不是 TypeError: reading \'includes\'）',
        !r.ok && /^Error: Unknown model:/.test(r.error), `→ ${r.error}`);
}
{
    // ④ 非字符串的 model（数字 / 对象）也不能崩
    for (const bad of [42, { a: 1 }, true]) {
        const r = tryCall(() => selectAPI({ api: 'deepseek', model: bad }));
        check(`S44-④ model=${JSON.stringify(bad)} 不崩且回到默认模型`,
            r.ok && r.value.model === null, `→ ${r.error ?? JSON.stringify(r.value)}`);
    }
}
{
    // ⑤ 正常路径不能被这次改动误伤
    const r1 = tryCall(() => selectAPI({ api: 'deepseek', model: 'deepseek-chat' }));
    check('S44-⑤ 正常 {api,model} 原样保留',
        r1.ok && r1.value.model === 'deepseek-chat' && r1.value.api === 'deepseek', `→ ${JSON.stringify(r1.value)}`);
    const r2 = tryCall(() => selectAPI({ model: 'gpt-4o' }));
    check('S44-⑤ 只给 model → 仍能推断 api=openai',
        r2.ok && r2.value.api === 'openai' && r2.value.model === 'gpt-4o', `→ ${JSON.stringify(r2.value)}`);
    const r3 = tryCall(() => selectAPI('claude-sonnet-4-6'));
    check('S44-⑤ 字符串 profile 仍按 model 处理并推断 api=anthropic',
        r3.ok && r3.value.api === 'anthropic', `→ ${JSON.stringify(r3.value)}`);
    const r4 = tryCall(() => selectAPI({ model: 'local/llama3' }));
    check('S44-⑤ 老写法 local→ollama 兼容仍生效',
        r4.ok && r4.value.api === 'ollama' && r4.value.model === 'llama3', `→ ${JSON.stringify(r4.value)}`);
}
{
    // ⑥ 非法的 api 名仍然是明确错误（别被空值保护顺手吞掉）
    const r = tryCall(() => selectAPI({ api: 'nope' }));
    check('S44-⑥ 未知 api → 明确报错 Unknown api:',
        !r.ok && /Unknown api:/.test(r.error), `→ ${r.error}`);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
