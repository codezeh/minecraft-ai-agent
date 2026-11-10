/**
 * 等其它 bot 到齐 —— 可注入时钟的轮询等待（★ R6 #17）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 病根（报告 #17）
 *
 *   `tasks.js` 里两处 `// TODO wait for other bots to join` 的实现是
 *   **固定 `setTimeout(10000)` 然后判人数**：
 *
 *       await new Promise((resolve) => setTimeout(resolve, 10000));
 *       if (this.available_agents.length < this.data.agent_count) {
 *           console.log(`Missing N bot(s).`);
 *           this.agent.killAll();          // ← 整机拉闸
 *       }
 *
 *   两个问题叠在一起：
 *     ① **等待量是固定的**，不看成败 —— Paper 重启/玩家手动开导致某只 bot 晚到 11 秒，
 *        早到的那只就判「人不齐」；
 *     ② 判「人不齐」之后调 `killAll()` → `mindserver_proxy.shutdown()` →
 *        `socket.emit('shutdown')` ⇒ **整套服务退出**：其它 bot、面板、任务板数据库一起没。
 *        这与 `agent_process.js:47-55` 刚修好的「单个 agent 退出不许拖垮整个 mindserver」直接冲突。
 *
 * 现在：
 *   · **轮询等待**（默认每 500ms 查一次、最多 60s），人齐了立刻继续，不再空等固定 10 秒；
 *   · 超时**只摘自己**（调用方用 `cleanKill(msg, 4)`；退出码 > 1 ⇒ 父进程 unregister 这一个 agent），
 *     绝不 `killAll()`；
 *   · 时钟与 sleep 都可注入 ⇒ 离线用例能在毫秒级钉死整张矩阵，不必真的等 60 秒。
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 为什么单独一个模块而不是写在 `tasks.js` 里：`tasks.js` 顶层 import 了
 * `commands/index.js` → mineflayer 一整条依赖链，离线用例导入它既慢又容易连带崩。
 * 这个文件**零依赖**，可以被 `tools/*_unit.mjs` 直接导入。
 */

/** 默认最多等 60 秒（Paper 重启要 20~60 秒，见 `agent_process.js` 的 BACKOFF_MAX_MS）。 */
export const DEFAULT_WAIT_TIMEOUT_MS = 60_000;

/** 默认轮询间隔：500ms —— 人齐了最多晚半秒继续，比固定 10 秒等待精确得多。 */
export const DEFAULT_POLL_INTERVAL_MS = 500;

export const MIN_WAIT_TIMEOUT_MS = 1_000;
export const MAX_WAIT_TIMEOUT_MS = 600_000;
export const MIN_POLL_INTERVAL_MS = 50;
export const MAX_POLL_INTERVAL_MS = 10_000;

/**
 * 「缺同伙」时**只摘自己**用的退出码。
 *
 * 语义见 `src/process/agent_process.js` 的 `planExit()`：
 *   · 0 = 正常结束（不重启）· 1 = 重启 · **> 1 = 只注销、摘掉这一个 agent，不动别的进程**。
 * 用 4 与此前 `cleanKill('Not all required players/bots are present', 4)` 保持一致。
 */
export const TEAMMATE_WAIT_EXIT_CODE = 4;

/**
 * 读一个「毫秒数」环境变量并夹在 `[min, max]` 内。
 *
 * 存在的理由：默认 60s/500ms 对生产是对的，对离线用例是灾难（一条用例真等 60 秒）。
 * 用环境变量而不是构造参数，是因为 `Task` 由 `agent.start()` 内部 `new` 出来，
 * 用例拿不到构造点；而环境变量是 `MC_BOTS_ROOT` 已经在用的同一套覆盖手法。
 *
 * @param {string} name 环境变量名
 * @param {number} fallback 未设置/非法时用它
 * @param {number} min 下限（含）
 * @param {number} max 上限（含）
 * @returns {number}
 */
export function readEnvMs(name, fallback, min, max) {
    const raw = typeof process !== 'undefined' ? process.env?.[name] : undefined;
    const n = Number(raw);
    if (raw === undefined || raw === '' || !Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
}

/** 生产用的 sleep（用例会换成假时钟）。 */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 轮询等待「到齐 required 个人」。
 *
 * 语义（**每一个分支都要能被用例钉死**）：
 *   · `required <= 1` ⇒ 立刻 `ok:true`（单机任务根本不用等；也不该有 0/1 人的空转）；
 *   · 人数够 ⇒ 立刻 `ok:true`，**一次 sleep 都不做**（早到的 bot 不该白等）；
 *   · 人数不够 ⇒ 每 `intervalMs` 重新数一次，直到够或超时；
 *   · 超时 ⇒ `ok:false`，并把 `present / required / waitedMs` 原样带回去，
 *     让调用方能写清楚「缺几只」。
 *
 * @param {object} args
 * @param {number} args.required 需要几只 bot（`data.agent_count`）
 * @param {() => number} args.present 当前到齐几只（每次都重新调用 ⇒ 能看见「后来进来的」）
 * @param {number} [args.timeoutMs] 最多等多久
 * @param {number} [args.intervalMs] 轮询间隔
 * @param {(ms:number)=>Promise<void>} [args.sleep] 可注入（用例用假时钟）
 * @param {() => number} [args.now] 可注入时钟（毫秒）
 * @returns {Promise<{ok:boolean, required:number, present:number, waitedMs:number, polls:number}>}
 */
export async function waitForAgents({
    required,
    present,
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    sleep = defaultSleep,
    now = () => Date.now(),
} = {}) {
    const need = Math.max(0, Math.floor(Number(required) || 0));
    const count = typeof present === 'function' ? present : () => 0;
    const readPresent = () => Math.max(0, Math.floor(Number(count()) || 0));

    const startedAt = now();
    let current = readPresent();
    let polls = 0;

    // 单机/不需要等人：立刻放过（也不做任何 sleep）
    if (need <= 1 || current >= need) {
        return { ok: true, required: need, present: current, waitedMs: 0, polls: 0 };
    }

    const timeout = Math.max(0, Math.floor(Number(timeoutMs) || 0));
    const interval = Math.max(1, Math.floor(Number(intervalMs) || DEFAULT_POLL_INTERVAL_MS));

    while (current < need) {
        const elapsed = now() - startedAt;
        if (elapsed >= timeout) break;
        // 只等到 deadline 为止，最后一跳不会被 interval 拖过超时
        await sleep(Math.min(interval, Math.max(1, timeout - elapsed)));
        polls += 1;
        current = readPresent();
    }

    const waitedMs = now() - startedAt;
    return { ok: current >= need, required: need, present: current, waitedMs, polls };
}

/**
 * 把等待结果写成一句人话（日志/告警用）。
 *
 * 为什么单独抽出来：这句话会出现在**用户能看到的日志**里，而这一类缺陷的教训是
 * 「日志说的和实际发生的不是一回事」（见 cleanKill 里 Restarting/Exiting 说反的那次）。
 * 抽成纯函数就能被用例逐字钉住。
 *
 * @param {{required:number, present:number, waitedMs:number}} r
 * @returns {string}
 */
export function describeWaitResult({ required = 0, present = 0, waitedMs = 0 } = {}) {
    const need = Math.max(0, Math.floor(Number(required) || 0));
    const got = Math.max(0, Math.floor(Number(present) || 0));
    const waited = Math.max(0, Math.floor(Number(waitedMs) || 0));
    return `等 ${need} 只 bot 到齐超时：${waited}ms 内只到了 ${got} 只`
        + `（缺 ${Math.max(0, need - got)} 只）⇒ 只摘掉自己，不影响其它 bot / 面板 / 任务板`;
}
