// C · BOT-006 开窗超时 / 取消（真机 + 受控注入）
//
// 真机事实先说清楚：
//   本机回环 + Paper，真实 openContainer 延迟是**毫秒级**（本探针实测 5 次），
//   所以**不可能自然触发**默认 4000ms 超时 —— 超时/取消场景只能用注入构造：
//     · 让 bot.openContainer 返回一个"永不 resolve"的 Promise（模拟服务端不回 window_open）
//     · 让它在超时之后才 resolve 并真的把窗口落到 bot.currentWindow 上（模拟"迟到窗口"）
//
// 验证三条（对应报告的三处修复）：
//   ① 超时真的结束：返回 TIMEOUT，且 **自己设的超时计时器被 clearTimeout**
//      （用 setTimeout/clearTimeout 探针直接观测，不靠感觉）
//   ② 迟到窗口不污染状态：TIMEOUT 之后才到的窗口必须被关掉，`bot.currentWindow` 归 null
//      （原来会残留 → 下一个任务 BLOCKED / 用错窗口）
//   ③ 等待期间被取消不许报 ok：interrupt_code=true 时，opener 回来也必须是 INTERRUPTED
import {
    Rcon, connectBot, setupPlatform, setChest, give, clearInv,
    writeResult, log, sleep, nowIso, T2,
} from './lib-probe.mjs';
import { openContainer, closeContainer } from 'file:///E:/我的世界ai/mindcraft/src/agent/library/act_container.js';

const USER = 'probe2';
const CX = 400, CY = 70, CZ = 400;
const HX = CX + 3, HY = CY + 1, HZ = CZ;

const rcon = new Rcon();
let bot;
const evidence = { probe: 'C-container-open-timeout-cancel', startedAt: nowIso() };

/** 计时器探针：记录 openContainer 自己创建的 setTimeout 是否被 clearTimeout。 */
function withTimerSpy(fn) {
    const realSet = global.setTimeout;
    const realClear = global.clearTimeout;
    const created = [];
    global.setTimeout = (cb, ms, ...a) => {
        const id = realSet(cb, ms, ...a);
        created.push({ id, ms, cleared: false });
        return id;
    };
    global.clearTimeout = (id) => {
        const rec = created.find((c) => c.id === id);
        if (rec) rec.cleared = true;
        return realClear(id);
    };
    return Promise.resolve()
        .then(fn)
        .finally(() => { global.setTimeout = realSet; global.clearTimeout = realClear; })
        .then((r) => ({ value: r, timers: created }));
}

try {
    await rcon.connect();
    bot = await connectBot(USER);
    await setupPlatform(rcon, USER, CX, CY, CZ);
    await setChest(rcon, HX, HY, HZ);
    await clearInv(rcon, USER);
    await give(rcon, USER, 'dirt', 5);
    await sleep(800);
    evidence.chestPos = { x: HX, y: HY, z: HZ };

    // ───────── ① 真实开窗延迟（证明本地无法自然超时）─────────
    const realLatency = [];
    for (let i = 0; i < 5; i++) {
        const t = Date.now();
        const r = await openContainer(bot, { kind: 'block', pos: { x: HX, y: HY, z: HZ } }, {});
        const ms = Date.now() - t;
        realLatency.push({ ms, ok: r.ok, code: r.code, dataCostMs: r.data?.costMs ?? null });
        closeContainer(bot);
        await sleep(250);
    }
    evidence.realOpenLatency = realLatency;
    evidence.naturalTimeoutPossible = false;
    evidence.naturalTimeoutWhy = `实测真实开窗 ${realLatency.map((x) => x.ms).join('/')} ms，远小于默认 4000ms 超时；本机回环不存在自然超时`;

    // 远端未加载 chunk 的箱子：尝试"自然构造等待期"（真实结果：立刻 NO_TARGET，不是等待）
    const far = await openContainer(bot, { kind: 'block', pos: { x: 30000, y: 70, z: 30000 } }, {});
    evidence.farUnloadedChunkAttempt = { ok: far.ok, code: far.code, message: far.message };

    // ───────── ② 超时注入：永不 resolve，且验证计时器被清 ─────────
    const TIMEOUT_MS = 300;
    const origOpen = bot.openContainer.bind(bot);
    let neverResolve = null;
    bot.openContainer = () => new Promise((res) => { neverResolve = res; });
    bot.currentWindow = null;

    const tA = Date.now();
    const spyA = await withTimerSpy(() => openContainer(bot, { kind: 'block', pos: { x: HX, y: HY, z: HZ } }, { timeout: TIMEOUT_MS }));
    const elapsedA = Date.now() - tA;
    const rA = spyA.value;
    evidence.timeoutInjection = {
        timeoutMs: TIMEOUT_MS,
        elapsedMs: elapsedA,
        result: { ok: rA.ok, code: rA.code, message: rA.message, data: rA.data },
        timersCreated: spyA.timers,
        timerForTimeoutCleared: spyA.timers.filter((t) => t.ms === TIMEOUT_MS).every((t) => t.cleared),
        timerCount: spyA.timers.filter((t) => t.ms === TIMEOUT_MS).length,
    };

    // ───────── ③ 迟到窗口不得污染 currentWindow ─────────
    // 模拟 mineflayer 在超时之后真的把窗口开了：先落到 currentWindow，再 resolve
    const fakeWin = { title: 'LATE-GHOST', slots: [] };
    let closeCalls = [];
    const origClose = bot.closeWindow.bind(bot);
    bot.closeWindow = (w) => { closeCalls.push(w?.title ?? 'none'); bot.currentWindow = null; return origClose(w); };
    if (neverResolve) {
        bot.currentWindow = fakeWin;            // ← 迟到的副作用落地
        neverResolve(fakeWin);                  // ← opener 终于 resolve
    }
    await sleep(900);                           // 等 settled.then → closeLateIfOwned 跑完
    evidence.lateWindow = {
        currentWindowAfterLate: bot.currentWindow === null ? null : (bot.currentWindow?.title ?? 'non-null'),
        closeCalls,
        notPolluted: bot.currentWindow === null,
        closedLateWindow: closeCalls.includes('LATE-GHOST'),
    };

    // ───────── ④ 等待期间被取消：回来也不许报 ok ─────────
    bot.openContainer = () => new Promise((res) => {
        setTimeout(() => {
            const w = { title: 'LATE-AFTER-INTERRUPT', slots: [] };
            bot.currentWindow = w;
            res(w);
        }, 400);
    });
    bot.currentWindow = null;
    closeCalls = [];
    const pC = openContainer(bot, { kind: 'block', pos: { x: HX, y: HY, z: HZ } }, { timeout: 3000 });
    await sleep(120);                           // 等待期内取消
    bot.interrupt_code = 'probe-interrupt';
    const rC = await pC;
    delete bot.interrupt_code;
    await sleep(300);
    evidence.interruptDuringWait = {
        result: { ok: rC.ok, code: rC.code, message: rC.message },
        currentWindowAfter: bot.currentWindow === null ? null : (bot.currentWindow?.title ?? 'non-null'),
        closeCalls,
        notOk: rC.ok === false,
        codeIsInterrupted: rC.code === 'INTERRUPTED',
        windowNotLeftBehind: bot.currentWindow === null,
    };

    // 复原（不污染后续探测）
    bot.openContainer = origOpen;
    bot.closeWindow = origClose;

    evidence.verdict = {
        timeoutReturnedTimeoutCode: rA.code === 'TIMEOUT',
        timeoutTimerCleared: evidence.timeoutInjection.timerForTimeoutCleared,
        timeoutElapsedNearInjected: Math.abs(elapsedA - TIMEOUT_MS) < 400,
        lateWindowDidNotPollute: evidence.lateWindow.notPolluted,
        lateWindowWasClosed: evidence.lateWindow.closedLateWindow,
        interruptNotReportedOk: evidence.interruptDuringWait.notOk,
        interruptCodeIsInterrupted: evidence.interruptDuringWait.codeIsInterrupted,
        interruptLeftNoWindow: evidence.interruptDuringWait.windowNotLeftBehind,
    };
    writeResult('result-C-container-open.json', evidence);
    log('RESULT', JSON.stringify(evidence.verdict));
    console.log(JSON.stringify(evidence, null, 2));
} catch (e) {
    evidence.error = String(e?.stack ?? e);
    writeResult('result-C-container-open.json', evidence);
    console.error('PROBE FAILED:', evidence.error);
    process.exitCode = 1;
} finally {
    try { bot?.quit('done'); } catch { }
    rcon.close();
    await sleep(300);
    process.exit(process.exitCode ?? 0);
}
