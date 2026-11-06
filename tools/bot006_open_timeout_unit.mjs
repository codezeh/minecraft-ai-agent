/**
 * BOT-006（2026-11-06 深度检查）—— 开容器超时/取消不结束底层开窗，晚到结果污染下一任务。
 *
 * 缺陷原貌（`act_container.openContainer`）：
 *   原来只有 `Promise.race([opener, sleep(timeout)])`。race 结束后**原始 opener 既没人取消
 *   也没人管**（包已经发出去了，取消不了），它的副作用照样由 mineflayer 落地：
 *     · 已经返回 TIMEOUT，几秒后窗口却突然打开 → 下一个任务看到 BLOCKED / 错窗口；
 *     · 等待期间 `interrupt_code=true`，opener 回来后函数**仍然报 ok**。
 *   报告验证：TIMEOUT 后 lateOpen=true；interrupt 时开窗结果仍 ok。
 *
 * 修法（报告给的最小修复）：开窗操作代次 + 取消清理 + 成功前复核取消 + 清掉超时计时器。
 *
 * 全部离线：假 bot / 假窗口 / 受控 Promise 时序，不连服务器。
 */
import Vec3 from 'vec3';
import { openContainer } from '../src/agent/library/act_container.js';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHEST_POS = new Vec3(1, 64, 0);
const chestBlock = { name: 'chest', position: CHEST_POS };
const winOf = (title) => ({ slots: new Array(63).fill(null), title });

/**
 * 假 bot。
 * @param {Function} openerFactory 返回 Promise 的 opener（可自己决定何时/如何 resolve）
 */
function makeBot(openerFactory) {
    const closed = [];              // 记录被关掉的窗口（用来判"关的是不是别人的窗"）
    const bot = {
        entity: { position: new Vec3(0, 64, 0), height: 1.8 },
        registry: { blocksByName: { chest: { id: 54 } } },
        currentWindow: null,
        interrupt_code: false,
        blockAt: () => chestBlock,
        closeWindow(w) { closed.push(w?.title ?? null); bot.currentWindow = null; },
        openContainer: () => openerFactory(bot),
        __closed: closed,
    };
    return bot;
}

// ══════════════════════════════════════════════════════════════════════
// ① 超时之后才到的开窗：窗口必须被收拾掉（修复前 lateOpen=true）
// ══════════════════════════════════════════════════════════════════════
{
    let resolveOpen = null;
    const bot = makeBot(() => new Promise((res) => {
        resolveOpen = () => {
            const w = winOf('late');
            bot.currentWindow = w;
            res(w);
        };
    }));
    const r = await openContainer(bot, { kind: 'block', pos: CHEST_POS }, { timeout: 10 });
    check('① 慢开窗 → TIMEOUT', r.code === 'TIMEOUT', `code=${r.code}`);
    check('① 返回时还没有窗口', bot.currentWindow === null);

    // 服务端的开窗响应"迟到"了
    resolveOpen();
    await sleep(5);
    check('① 迟到开出来的窗口被清掉（修复前 lateOpen=true）', bot.currentWindow === null,
        `currentWindow=${bot.currentWindow?.title ?? null}`);
    check('① 清掉的正是那个迟到窗口', bot.__closed.includes('late'),
        `closed=${JSON.stringify(bot.__closed)}`);
}

// ══════════════════════════════════════════════════════════════════════
// ② 等待期间被取消：开窗结果回来了也不许报 ok（修复前报 ok）
// ══════════════════════════════════════════════════════════════════════
{
    const bot = makeBot(() => new Promise((res) => {
        setTimeout(() => {
            bot.interrupt_code = true;
            const w = winOf('cancelled');
            bot.currentWindow = w;
            res(w);
        }, 5);
    }));
    const r = await openContainer(bot, { kind: 'block', pos: CHEST_POS }, { timeout: 200 });
    check('② 取消后 opener 才返回 → INTERRUPTED（修复前 ok）',
        r.ok === false && r.code === 'INTERRUPTED', `ok=${r.ok} code=${r.code}`);
    check('② 取消时把开出来的窗口收拾掉（不留 BLOCKED）', bot.currentWindow === null,
        `currentWindow=${bot.currentWindow?.title ?? null}`);
}

// ══════════════════════════════════════════════════════════════════════
// ③ 迟到的旧结果不得误关**新任务**的窗口
// ══════════════════════════════════════════════════════════════════════
{
    let resolveOld = null;
    let n = 0;
    const bot = makeBot((b) => {
        n++;
        if (n === 1) {
            return new Promise((res) => {
                resolveOld = () => {
                    const w = winOf('old-late');
                    b.currentWindow = w;      // 服务端确实把它开出来了
                    res(w);
                };
            });
        }
        // 第二次（新任务）：立刻成功
        return Promise.resolve().then(() => {
            const w = winOf('new-task');
            b.currentWindow = w;
            return w;
        });
    });

    const r1 = await openContainer(bot, { kind: 'block', pos: CHEST_POS }, { timeout: 10 });
    check('③ 第一次开窗超时', r1.code === 'TIMEOUT', `code=${r1.code}`);

    const r2 = await openContainer(bot, { kind: 'block', pos: CHEST_POS }, { timeout: 200 });
    check('③ 新任务开窗成功', r2.ok === true, `code=${r2.code}`);
    check('③ 新任务的窗口是它自己的', bot.currentWindow?.title === 'new-task',
        `title=${bot.currentWindow?.title}`);

    // 旧 opener 此刻才回来
    resolveOld();
    await sleep(5);
    const closedNew = bot.__closed.includes('new-task');
    check('③ 旧操作没有把新任务的窗口关掉', closedNew === false,
        `closed=${JSON.stringify(bot.__closed)}`);
}

// ══════════════════════════════════════════════════════════════════════
// ④ 成功路径：超时计时器必须被清掉（修复前 sleep(timeout) 一直挂着）
// ══════════════════════════════════════════════════════════════════════
{
    const bot = makeBot(() => Promise.resolve().then(() => {
        const w = winOf('fast');
        bot.currentWindow = w;
        return w;
    }));
    const realClear = globalThis.clearTimeout;
    let cleared = 0;
    globalThis.clearTimeout = (t) => { cleared++; return realClear(t); };
    let r;
    try {
        r = await openContainer(bot, { kind: 'block', pos: CHEST_POS }, { timeout: 5000 });
    } finally {
        globalThis.clearTimeout = realClear;
    }
    check('④ 正常开窗 → ok', r.ok === true, `code=${r.code}`);
    check('④ 超时计时器被清掉（clearTimeout 至少调用一次）', cleared >= 1, `cleared=${cleared}`);
    check('④ 窗口保留（正常路径不许误关）', bot.currentWindow?.title === 'fast',
        `title=${bot.currentWindow?.title}`);
}

// ══════════════════════════════════════════════════════════════════════
// ⑤ opener 直接抛错 → INTERNAL，且不留下半开的窗口
// ══════════════════════════════════════════════════════════════════════
{
    const bot = makeBot(() => Promise.reject(new Error('server said no')));
    const r = await openContainer(bot, { kind: 'block', pos: CHEST_POS }, { timeout: 200 });
    check('⑤ opener 抛错 → INTERNAL', r.ok === false && r.code === 'INTERNAL',
        `code=${r.code} msg=${r.message}`);
    check('⑤ 抛错后没有残留窗口', bot.currentWindow === null);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
