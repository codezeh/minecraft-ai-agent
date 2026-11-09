/**
 * t-r5-4 —— 「任务板心跳不看停止标志：paused 的单仍每 10 秒续租」
 *
 * 缺陷形态（老实现）：`_runJob()` 里无条件 `board.heartbeat(job.id)`。只要流程还没走到 finally，
 *   被 **paused**（玩家 !stop / 死亡 / 别人在面板上暂停）或被取消的单**照样续租**。
 *   而 `_runJob` 卡住的最长来源正是 30 分钟的模型调用 / 10 分钟动作超时
 *   ⇒ 面板上单子已是 paused，租约仍归自己，别的 bot 一直到进程被杀都拿不到这张单。
 *
 * 判定方式（不靠读码，靠跑）：假板子（heartbeat 计数；getAsync 回报服务端状态 paused），
 *   假 runSkill 睡一段时间，`heartbeatMs` 调成 40ms 让心跳密集发生。
 *   在"单已被暂停"之后继续观察心跳计数：
 *     · 心跳继续增长 → 缺陷复现，退出码 0；
 *     · 心跳停止（并主动释放租约）→ 未复现，退出码 1。
 *
 * 用法：node .../t-r5-4.mjs ；R5_SRC=<pre-fix>/src node .../t-r5-4.mjs
 * 退出码：0=缺陷复现，1=未复现，2=CANNOT-RUN。
 */
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(process.env.R5_SRC || path.resolve(HERE, '../../../../../mindcraft/src'));
const say = (...a) => console.log('[t-r5-4]', ...a);

let BoardScheduler;
try {
    ({ BoardScheduler } = await import(pathToFileURL(path.join(SRC, 'agent/library/board_scheduler.js')).href));
} catch (e) {
    console.error('[t-r5-4] CANNOT-RUN：导入 board_scheduler.js 失败：', e?.message ?? e);
    process.exit(2);
}

// ── 假板子 ────────────────────────────────────────────────────────────────
const book = { heartbeats: 0, updates: [], releases: [], resumes: [] };
let serverState = 'running';       // 服务端权威状态（中途改成 paused）
const job = { id: 'job-1', skill: 'collect', args: { target: 'oak_log' }, state: 'running', attempts: 1, priority: 5 };

const board = {
    heartbeat(id, progress) { book.heartbeats++; return { ok: true, data: { job: { ...job, state: serverState } } }; },
    get(id) { return id === job.id ? { ...job, state: serverState } : null; },          // 本地镜像
    async getAsync(id) { return { ok: true, data: { job: id === job.id ? { ...job, state: serverState } : null } }; },
    async update(id, patch) { book.updates.push({ id, patch }); return { ok: true }; },
    async setState(id, state) { book.updates.push({ id, state }); return { ok: true }; },
    async reserve() { return { ok: true }; },
    async release(k) { book.releases.push(k); return { ok: true }; },
    async finish() { return { ok: true }; },
    list() { return [{ ...job, state: serverState }]; },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const agent = {
    name: 'probe4', roles: [], bot: { inventory: { items: () => [] } },
    // actions 必须能跑 runAction：调度器走 control.runJobAction → actions.runAction(...)
    // 没有它，每张单都会立刻 run-failed（心跳根本来不及发生）—— 那会让探针变成空转。
    actions: {
        executing: true, stop_reason: null, stopReason: null,
        async stop() {},
        async runAction(_label, fn) { return { success: true, message: '', interrupted: false, timedout: false, result: await fn() }; },
    },
    history: { memory: '' },
    isIdle: () => false, board, boardClient: board,
};

const sched = new BoardScheduler({
    agent, board, actions: agent.actions,
    heartbeatMs: 40,
    now: () => Date.now(),
    sleep: async (ms) => { await sleep(ms); },
    onEvent: (e) => { if (e?.type && /lease|stopped/.test(e.type)) book.resumes.push(e); },
    runSkill: async () => { await sleep(260); return { ok: true, message: 'done' }; },
});

// ── 驱动 ──────────────────────────────────────────────────────────────────
// 直接驱动单张单的执行段（_runJob 是新旧两版都有的方法名）
if (typeof sched._runJob !== 'function') {
    console.error('[t-r5-4] CANNOT-RUN：该版本没有 _runJob()，无法在离线环境驱动心跳段');
    process.exit(2);
}

let runErr = null;
const running = sched._runJob(job, Date.now()).catch((e) => { runErr = e; return null; });

// 100ms 之后：别人（另一路进程/面板）把这张单暂停了
await sleep(100);
serverState = 'paused';
const atPause = book.heartbeats;
say('暂停时刻的累计心跳数：', atPause);

// 再等一会儿：如果心跳不看停止标志，计数会继续涨
await sleep(240);
const atEnd = book.heartbeats;
say('暂停后继续观察 240ms：累计心跳数 =', atEnd, `（暂停后新增 ${atEnd - atPause} 次）`);
say('释放租约的 update：', JSON.stringify(book.updates));
say('_runJob 抛错：', runErr ? String(runErr.message) : 'no');

await running;
const afterRun = book.heartbeats;
await sleep(120);
const afterIdle = book.heartbeats;
say('流程结束后再等 120ms：心跳数', afterRun, '→', afterIdle);
say('事件：', JSON.stringify(book.resumes).slice(0, 400));

const grewAfterPause = atEnd > atPause || afterIdle > afterRun;
const released = book.updates.some((u) => u?.patch && 'lease_owner' in u.patch);

if (grewAfterPause) {
    say('REPRODUCED：单已被服务端暂停后心跳仍在续租（心跳不增长才是对的）'
        + `（暂停后新增 ${Math.max(atEnd - atPause, afterIdle - afterRun)} 次）`);
    process.exit(0);
}
say(`NOT-REPRODUCED：暂停后心跳停止${released ? '，并主动放掉了租约' : ''}（心跳数停在 ${atEnd}）`);
process.exit(1);
