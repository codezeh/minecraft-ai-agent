/**
 * R4 §7（第四轮审计）杂项 S2/S3 的离线回归 —— **不需要 Minecraft 服务器**。
 *
 * 覆盖本 task（t14-misc）改的 7 条里能离线断言的 6 条：
 *
 *  ① `history.appendFullHistory` 追写化（原来是每 5 条「全量读 → parse → 全量写回」= O(n²)，
 *     且解析失败被 catch 吞掉 ⇒ 文件坏一次就**永久停写**）。
 *     这里断言：追加后文件仍是**合法 JSON 数组**、顺序正确；文件被外部截断/写坏后
 *     **能自愈**（换新文件继续写、失败批次不丢），不会永久静默。
 *  ② `memory_bank` 截断方向：保留**最新** 120 条（原来保留最旧 120 条，刚记的地点最先被扔）。
 *  ③ `self_prompter.startLoop` 有 try/finally：一次异常不许留下「state=ACTIVE 但 loop 已死」
 *     （原来 loop_active 永远是 true ⇒ update() 的自动重启判据恒假 ⇒ 目标循环永久不再启动）。
 *  ④ `speak.js` 的队列泵：一次未捕获异常后 `isSpeaking` 必须复位，且泵要继续处理后续句子
 *     （原来 catch 里不重置 ⇒ 整个 TTS 永久静音）。
 *  ⑤ `vision_interpreter`：模型层的 `[LLM_ERROR] …` **不得**进模型上下文（整段省略）。
 *  ⑥ `act_fish.fishOnce` 超时：计时器清掉 + 底层 `bot.fish()` 被收掉（deactivateItem），
 *     而不是留着在后台继续钓。
 *
 * 全部离线：模型/摄像头/bot 一律用桩，bots 根指向系统临时目录（不碰真实 bots/）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'r4misc-'));
process.env.MC_BOTS_ROOT = TMP_ROOT;

const { History } = await import('../src/agent/history.js');
const { SelfPrompter } = await import('../src/agent/self_prompter.js');
const { VisionInterpreter } = await import('../src/agent/vision/vision_interpreter.js');
const { speak, __ttsDiagnostics } = await import('../src/agent/speak.js');
const { fishOnce } = await import('../src/agent/library/act_fish.js');
const { failedReply } = await import('../src/models/_shared.js');

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** History 只用到 agent 的这几个字段。 */
function makeAgent(name) {
    return {
        name,
        last_sender: null,
        memory_bank: { getJson: () => ({}) },
        self_prompter: { state: 0, prompt: '', author: null, isStopped: () => true },
        task: { taskStartTime: 0 },
        actions: { executing: false },
        prompter: {},
    };
}

// ════════════════════════════════════════════════════════════
// ① appendFullHistory：追写 + 自愈（R4 §7-①）
// ════════════════════════════════════════════════════════════
{
    const h = new History(makeAgent('r4hist'));
    await h.appendFullHistory([{ role: 'user', content: 'a' }]);
    const raw1 = fs.readFileSync(h.full_history_fp, 'utf8');
    await h.appendFullHistory([
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
    ]);
    const fp = h.full_history_fp;
    const raw2 = fs.readFileSync(fp, 'utf8');

    let parsed = null;
    try { parsed = JSON.parse(raw2); } catch (e) { parsed = { error: String(e?.message ?? e) }; }

    check('① 追加两次后文件仍是合法 JSON 数组', Array.isArray(parsed), `→ ${raw2.slice(0, 40)}…`);
    check('① 追加内容完整且顺序正确',
        Array.isArray(parsed) && parsed.length === 3
        && parsed[0].content === 'a' && parsed[1].content === 'b' && parsed[2].content === 'c',
        `→ ${Array.isArray(parsed) ? parsed.length : 'n/a'} 条`);
    check('① 第一批内容仍在（追写不是覆盖）', raw2.includes('"a"') && raw1.includes('"a"'));

    // —— 空批：不写盘、不报错（不能让"没有要记的"变成一次写失败）
    const sizeBefore = fs.statSync(fp).size;
    await h.appendFullHistory([]);
    await h.appendFullHistory(null);
    check('① 空批/非数组入参不写盘、不报错',
        fs.statSync(fp).size === sizeBefore && h.fullHistoryError === null);

    // —— 坏文件自愈：模拟"文件被外部截断"，老实现会在这里永久停写
    fs.writeFileSync(fp, '{"broken":', 'utf8');
    await h.appendFullHistory([{ role: 'user', content: 'x1' }]);
    check('① 结尾不是 JSON 数组 ⇒ 识别为坏文件（不再静默吞掉）',
        !!h.fullHistoryError && h.full_history_fp === undefined,
        `→ ${h.fullHistoryError?.message ?? 'no error'}`);

    await h.appendFullHistory([{ role: 'user', content: 'x2' }]);
    const fp2 = h.full_history_fp;
    let parsed2 = null;
    try { parsed2 = JSON.parse(fs.readFileSync(fp2, 'utf8')); } catch (e) { parsed2 = null; }
    check('① 坏文件之后**换新文件继续写**（永久停写已修）', typeof fp2 === 'string' && fs.existsSync(fp2),
        `→ ${path.basename(String(fp2))}`);
    check('① 写失败的那一批不丢（下次一起写进去）',
        Array.isArray(parsed2) && parsed2.length === 2
        && parsed2[0].content === 'x1' && parsed2[1].content === 'x2',
        `→ ${Array.isArray(parsed2) ? parsed2.length : 'n/a'} 条`);
    check('① 自愈成功后错误状态清空', h.fullHistoryError === null);
}

// ════════════════════════════════════════════════════════════
// ② memory_bank 截断方向（R4 §7-②）
// ════════════════════════════════════════════════════════════
{
    const h = new History(makeAgent('r4bank'));
    const bank = {};
    for (let i = 0; i < 200; i++) bank[`k${i}`] = [i, 64, 0];
    const out = h.capSize({
        memory: 'm',
        turns: [],
        self_prompt: null,
        memory_bank: bank,
    });
    const keys = Object.keys(out.memory_bank ?? {});
    check('② 超 120 条时压到 120 条', keys.length === 120, `→ ${keys.length}`);
    check('② 保留的是**最新**登记的（k199 在，k0 不在）',
        keys.includes('k199') && !keys.includes('k0'),
        `→ 首 ${keys[0]} / 尾 ${keys[keys.length - 1]}`);
    check('② 最终落盘仍不超 20KB',
        Buffer.byteLength(JSON.stringify(out, null, 2), 'utf8') <= 20 * 1024);
}

// ════════════════════════════════════════════════════════════
// ③ self_prompter.startLoop 的 try/finally（R4 §7-③）
// ════════════════════════════════════════════════════════════
{
    const mk = (handleMessage) => {
        const sp = new SelfPrompter({ handleMessage, openChat: async () => {} });
        sp.state = 1;            // ACTIVE
        sp.prompt = 'test-goal';
        sp.cooldown = 0;         // 单测不要真的等 2 秒
        return sp;
    };

    // ③-1 一次异常：循环退出，但**状态与循环标志必须一致**（不能 ACTIVE + loop 已死）
    const sp1 = mk(() => Promise.reject(new Error('boom')));
    let threw = false;
    try { await sp1.startLoop(); } catch { threw = true; }
    check('③ 循环内异常不让 startLoop 抛出（不再变成 unhandled rejection）', !threw);
    check('③ 异常后 loop_active 已复位（老实现永远卡在 true）', sp1.loop_active === false);
    check('③ 异常只记账、不立刻把目标判死（state 仍 ACTIVE，交给 update() 重启）',
        sp1.isActive() && sp1.loop_errors === 1, `→ errors=${sp1.loop_errors}`);

    // ③-2 重启能力：异常之后再跑一轮必须还能停干净
    let opened = 0;
    const sp2 = mk(() => { sp2.interrupt = true; return Promise.resolve(true); });
    await sp2.startLoop();
    check('③ 异常后循环仍可再次启动并正常退出',
        sp2.loop_active === false && sp2.interrupt === false);

    // ③-3 连续失败到上限：诚实停下，不再假装 ACTIVE
    const sp3 = mk(() => Promise.reject(new Error('persistent')));
    for (let i = 0; i < 3; i++) await sp3.startLoop();
    check('③ 连续 3 次异常 ⇒ state 置 STOPPED（不假装还在自驱）',
        sp3.isStopped() && sp3.loop_active === false, `→ errors=${sp3.loop_errors}`);

    // ③-4 一轮正常跑通就把失败计数清零（偶发失败不该累计成"连续失败"）
    const sp4 = mk(() => { sp4.interrupt = true; return Promise.resolve(true); });
    sp4.loop_errors = 2;
    await sp4.startLoop();
    check('③ 成功跑完一轮后连续失败计数清零', sp4.loop_errors === 0);
    void opened;
}

// ════════════════════════════════════════════════════════════
// ④ speak.js 队列泵：一次异常不许永久静音（R4 §7-④）
// ════════════════════════════════════════════════════════════
{
    check('④ 初始未在播', __ttsDiagnostics.isSpeaking() === false);
    // 造一个"取字符串就抛"的入参：processQueue 在 try 之外炸掉 ⇒ 走到 continueQueue 的 catch
    speak({ toString() { throw new Error('boom-in-tts'); } });
    await sleep(60);
    check('④ 泵异常后 isSpeaking 复位（老实现永久卡 true ⇒ 永久静音）',
        __ttsDiagnostics.isSpeaking() === false);

    // 泵还必须活着：再来一句（空文本走"空字符串"分支，不 spawn 任何进程）
    speak('');
    await sleep(60);
    check('④ 异常之后队列仍能继续被处理（泵没死）',
        __ttsDiagnostics.pending() === 0 && __ttsDiagnostics.isSpeaking() === false,
        `→ pending=${__ttsDiagnostics.pending()}`);
}

// ════════════════════════════════════════════════════════════
// ⑤ vision：[LLM_ERROR] 不得进模型上下文（R4 §7-⑤）
// ════════════════════════════════════════════════════════════
{
    const shotDir = path.join(TMP_ROOT, 'shots');
    fs.mkdirSync(shotDir, { recursive: true });
    fs.writeFileSync(path.join(shotDir, 'shot.jpg'), Buffer.from([0xff, 0xd8, 0xff]));

    const mkVision = (promptVision) => {
        const agent = {
            name: 'r4vision',
            history: { getHistory: () => [] },
            prompter: { promptVision },
            bot: { blockAtCursor: () => null },
        };
        const v = new VisionInterpreter(agent, false);   // allow_vision=false ⇒ 不建 Camera
        v.fp = shotDir;
        return v;
    };

    const bad = mkVision(() => Promise.resolve(failedReply('timeout')));
    const badRes = await bad.analyzeImage('shot');
    check('⑤ 模型返回失败标记时 analyse 结果为 null（不是那句失败文本）', badRes === null);

    const head = 'Looking at coordinate 1, 64, 1\n';
    check('⑤ 失败时整段省略，上下文里没有 [LLM_ERROR]',
        !bad._withAnalysis(head, null).includes('LLM_ERROR')
        && bad._withAnalysis(head, null) === head);

    const good = mkVision(() => Promise.resolve('一只羊在左边'));
    const goodRes = await good.analyzeImage('shot');
    check('⑤ 成功时照旧给出分析 + 中心方块信息',
        typeof goodRes === 'string' && goodRes.includes('一只羊在左边'), `→ ${String(goodRes).slice(0, 30)}`);
    check('⑤ 成功路径的拼句仍是 Image analysis: "…"',
        good._withAnalysis(head, '一只羊在左边') === `${head}Image analysis: "一只羊在左边"`);

    const err = mkVision(() => Promise.reject(new Error('network down')));
    const errRes = await err.analyzeImage('shot');
    check('⑤ 视觉调用抛异常时也不把错误文本放进上下文', errRes === null);
}

// ════════════════════════════════════════════════════════════
// ⑦ t21（缺口 C）：视觉结果**读 status**，失败/截断不得进上下文
// ════════════════════════════════════════════════════════════
{
    const shotDir2 = path.join(TMP_ROOT, 'shots2');
    fs.mkdirSync(shotDir2, { recursive: true });
    fs.writeFileSync(path.join(shotDir2, 'shot2.jpg'), Buffer.from([0xff, 0xd8, 0xff]));

    const HEAD = 'Looking at player Alice\n';
    const MARKERS = ['[LLM_ERROR]', '[LLM_TRUNCATED]', '[NO_CODE]'];
    const hasMarker = (s) => MARKERS.some((m) => String(s ?? '').includes(m));

    /** prompter 桩：给哪个方法就挂哪个（result=带类型新出口，legacy=旧字符串出口）。 */
    const mkV = ({ result, legacy }) => {
        const agent = {
            name: 'r4vision2',
            history: { getHistory: () => [] },
            prompter: {},
            bot: { blockAtCursor: () => null },
        };
        if (result) agent.prompter.promptVisionResult = () => Promise.resolve(result);
        if (legacy) agent.prompter.promptVision = () => Promise.resolve(legacy);
        const v = new VisionInterpreter(agent, false);
        v.fp = shotDir2;
        return v;
    };

    // ① status=error ⇒ 不注入，且产物里没有任何标记
    const vErr = mkV({ result: { status: 'error', content: '', errorCode: 'TIMEOUT', errorMessage: '[LLM_ERROR] timeout' } });
    const rErr = await vErr.analyzeImage('shot2');
    check('⑦① status=error ⇒ 不注入分析（null）', rErr === null);
    check('⑦① error 路径拼句不含任何内部标记', !hasMarker(vErr._withAnalysis(HEAD, rErr)));

    // ② status=truncated ⇒ 半截文本也不许进
    const vTr = mkV({ result: { status: 'truncated', content: '画面左半边是[LLM_TRUNCATED]' } });
    const rTr = await vTr.analyzeImage('shot2');
    check('⑦② status=truncated ⇒ 不注入半截文本', rTr === null);
    check('⑦② truncated 路径拼句等于原样 head', vTr._withAnalysis(HEAD, rTr) === HEAD);

    // ③ status=ok ⇒ 正文正常注入
    const vOk = mkV({ result: { status: 'ok', content: '一只羊在左边' } });
    const rOk = await vOk.analyzeImage('shot2');
    check('⑦③ status=ok ⇒ 正文正常进入分析',
        typeof rOk === 'string' && rOk.includes('一只羊在左边'), `→ ${String(rOk).slice(0, 30)}`);

    // ④ 旧字符串出口：带任一种内部标记 ⇒ 视同失败
    check('⑦④ 旧出口 [LLM_ERROR] ⇒ 不注入',
        (await mkV({ legacy: '[LLM_ERROR] timeout' }).analyzeImage('shot2')) === null);
    check('⑦④ 旧出口 [LLM_TRUNCATED] ⇒ 不注入',
        (await mkV({ legacy: '半截画面[LLM_TRUNCATED]' }).analyzeImage('shot2')) === null);
    check('⑦④ 旧出口 [NO_CODE] ⇒ 不注入',
        (await mkV({ legacy: '[NO_CODE] no response' }).analyzeImage('shot2')) === null);

    // 拼句终检：即便上游漏了净化，带标记的正文也不许出现在产物里
    for (const m of MARKERS) {
        check(`⑦ 拼句终检：正文含 ${m} ⇒ 整段省略`, vOk._withAnalysis(HEAD, `画面里有 ${m}`) === HEAD);
    }
    // 旧出口的正常正文仍然可用（并去掉首尾空白）
    const rLegacyOk = await mkV({ legacy: '  一只羊在右边  ' }).analyzeImage('shot2');
    check('⑦ 旧出口正常正文仍可用（去首尾空白）',
        typeof rLegacyOk === 'string' && rLegacyOk.startsWith('一只羊在右边'), `→ ${String(rLegacyOk).slice(0, 20)}`);
}

// ════════════════════════════════════════════════════════════
// ⑥ act_fish 超时：计时器清掉 + 底层收掉（R4 §7-⑥）
// ════════════════════════════════════════════════════════════
{
    let deactivated = false;
    const bot = {
        interrupt_code: null,
        inventory: { items: () => [{ name: 'fishing_rod', count: 1 }] },
        heldItem: { name: 'fishing_rod' },
        fish: () => new Promise(() => {}),          // 永远不收竿
        deactivateItem: () => { deactivated = true; },
    };
    const t0 = Date.now();
    const r = await fishOnce(bot, null, { timeoutMs: 30 });
    const cost = Date.now() - t0;
    check('⑥ 超时如实返回 TIMEOUT（不是假成功）', !r.ok && r.code === 'TIMEOUT', `→ ${r.code}`);
    check('⑥ 超时按配置触发（不是卡满 30 秒）', cost < 2000, `→ ${cost}ms`);
    check('⑥ 超时后把底层 bot.fish() 收掉（deactivateItem 被调用）', deactivated);

    // 正常收竿：不应被超时逻辑干扰
    const okBot = {
        interrupt_code: null,
        inventory: { items: () => [{ name: 'fishing_rod', count: 1 }] },
        heldItem: { name: 'fishing_rod' },
        fish: async () => {},
        deactivateItem: () => {},
    };
    const r2 = await fishOnce(okBot, null, { timeoutMs: 200 });
    check('⑥ 收竿但没钓到 ⇒ NOT_READY（既有语义不变）', !r2.ok && r2.code === 'NOT_READY', `→ ${r2.code}`);
}

// ════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响结论 */ }
process.exit(fail === 0 ? 0 : 1);
