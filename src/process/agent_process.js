import { spawn } from 'child_process';
// F-EXEC-102：停子进程要"等 + 强杀 + 确认"，不是发个信号就返回
import { stopChildAndWait } from './proc_lifecycle.js';
import { fileURLToPath } from 'url';
import { logoutAgent } from '../mindcraft/mindserver.js';

const init_agent_path = fileURLToPath(new URL('./init_agent.js', import.meta.url));

/** 「起不足这么久就退出」= 这次启动**没起来**（报告第 7 条的 10 秒口径）。 */
export const QUICK_EXIT_MS = 10_000;

/** 连续这么多次"起不足 10 秒"才放弃。★ 不是第一次就放弃 —— 见 planExit 的注释。 */
export const MAX_QUICK_EXITS = 8;

/** 退避基数：2s, 4s, 8s, 16s, 32s, 60s(封顶), … */
export const BACKOFF_BASE_MS = 2_000;

/** 退避上限。★ 必须有上限：Paper 重启要 20~60 秒，退避超过 60 秒只会让"回来得更晚"。 */
export const BACKOFF_MAX_MS = 60_000;

/**
 * 第 n 次连续快速退出之后等多久再拉起：`min(2^n * 2s, 60s)`。
 *
 * @param {number} attempt 已经连续快速退出几次（**1 表示第一次**）
 * @returns {number} 毫秒
 */
export function backoffDelayMs(attempt) {
    const n = Math.max(0, Math.floor(Number(attempt) || 0));
    return Math.min(BACKOFF_BASE_MS * (2 ** Math.max(0, n - 1)), BACKOFF_MAX_MS);
}

/**
 * 退出之后该做什么 —— **纯决策函数**，不碰进程、不碰定时器。
 *
 * 抽成纯函数的理由：第 7、19 条都是"退出之后"的分支，而"真的起一个子进程再让它死"
 * 在离线用例里既慢又不稳。把决策抽出来，`tools/agent_process_backoff_unit.mjs`
 * 就能把整张矩阵（含退避序列）逐格钉死。
 *
 * @param {object} args
 * @param {number|null} args.code 退出码
 * @param {string|null} args.signal 信号
 * @param {number} args.livedMs 这次活了多久
 * @param {number} args.quickExits 加上这次之后的"连续快速退出"次数（调用方算好传进来）
 * @returns {{action:'none'|'unregister'|'restart', delayMs?:number, quickExits?:number, reason:string}}
 */
export function planExit({ code = 0, signal = null, livedMs = 0, quickExits = 0 } = {}) {
    // ★★★ 第19条：**单个 agent 退出不许拖垮整个 mindserver。**
    //   原来：`if (code > 1) { console.log('Ending task'); process.exit(code); }`
    //   触发源：`agent.js:496 cleanKill('Not all required players/bots are present', 4)`。
    //   后果：**缺一个人（或任何一个 bot 主动终止）就让整套服务退出** ——
    //   其他 bot、面板、任务板数据库一起没了。这是"一个零件坏了把整机拉闸"。
    //   现在：只摘掉**这个** agent（注销 + 从 agent_processes 删除自己），进程继续活。
    if (Number(code) > 1) {
        return { action: 'unregister', reason: `退出码 ${code} > 1：只摘掉这个 agent，不动其他进程` };
    }

    // 正常结束 / 被人为停掉（SIGINT）：不重启，保持原语义
    if (code === 0 || signal === 'SIGINT') {
        return { action: 'none', reason: `正常结束（code=${code}, signal=${signal ?? '-'}）` };
    }

    // 连续快速退出太多次 → 放弃（真正的"它起不来"，需要人工介入）
    if (quickExits >= MAX_QUICK_EXITS) {
        return {
            action: 'unregister',
            reason: `连续 ${quickExits} 次起不足 ${QUICK_EXIT_MS}ms 就退出 → 放弃重启，摘掉这个 agent（需要人工介入）`,
        };
    }

    // ★★★ 第7条：**指数退避，而不是"10 秒内退出就永久不重启"。**
    //   现场：Paper 重启要 20~60 秒，期间 agent 连不上 → 起来马上就退 → 落在
    //   原来那条 `Date.now() - last_restart < 10000` 的打击范围内 → **永久死亡且不自愈**。
    //   现在：只把这次算成"快速退出"、记一笔，然后等 `min(2^n*2s, 60s)` 再拉起来；
    //   只有**连续** MAX_QUICK_EXITS 次都起不来才放弃（真正的坏配置/坏环境）。
    return {
        action: 'restart',
        delayMs: backoffDelayMs(quickExits),
        quickExits,
        reason: livedMs < QUICK_EXIT_MS
            ? `起不足 ${QUICK_EXIT_MS}ms 就退出（第 ${quickExits} 次）→ ${backoffDelayMs(quickExits)}ms 后重试`
            : `活了 ${livedMs}ms 后退出，计数清零 → ${backoffDelayMs(quickExits)}ms 后重试`,
    };
}

export class AgentProcess {
    constructor(name, port) {
        this.name = name;
        this.port = port;
        /** 连续"起不足 10 秒就退出"的次数（正常活过 10 秒就清零）。 */
        this._quickExits = 0;
        /** 本次 spawn 的时刻（判"活了多久"）。 */
        this._spawnedAt = 0;
        /** 待执行的退避重启定时器（stop() 要能取消它）。 */
        this._restartTimer = null;
        /** 由宿主注入：把这个 agent 从注册表里摘掉（默认什么也不做，保持可独立使用）。 */
        this.unregister = null;
        /** 可注入的定时器（用例换成收集器 → 退避序列可逐格断言；生产用全局 setTimeout）。 */
        this._setTimeout = null;
    }

    start(load_memory=false, init_message=null, count_id=0) {
        this.count_id = count_id;
        this.running = true;
        // 主动 start（用户点启动/强制重启）→ 清掉"用户要求停"的标记
        this._stoppedByUser = false;

        let args = [init_agent_path, this.name];
        args.push('-n', this.name);
        args.push('-c', count_id);
        if (load_memory)
            args.push('-l', load_memory);
        if (init_message)
            args.push('-m', init_message);
        args.push('-p', this.port);

        const agentProcess = spawn(process.execPath, args, {
            stdio: 'inherit',
            stderr: 'inherit',
            // ★ F-EXEC-102（2026-11-06）：把自己的 pid 告诉子进程，子进程据此做**孤儿自杀**。
            // 为什么需要：agent 用 stdio:'inherit' 起，**没有 IPC**（拿不到 'disconnect'），
            // 而 Windows 上父进程死掉后 process.ppid 不会变成 1 ⇒ 只能靠"定期问 pid 还活着吗"。
            env: { ...process.env, MINDSERVER_PID: String(process.pid) },
        });
        this._spawnedAt = Date.now();
        
        agentProcess.on('exit', (code, signal) => {
            this._onChildExit(code, signal, count_id);
        });
    
        agentProcess.on('error', (err) => {
            console.error('Agent process error:', err);
        });

        this.process = agentProcess;
    }

    /**
     * 子进程退出之后做什么（第 7、19 条）。
     *
     * ★ 抽成方法而不是内联在 `on('exit')` 里，就是为了**能被离线用例直接驱动**：
     *   "真的起一个子进程再让它死"既慢又不稳，而这里的分支（退避、放弃、摘掉自己）
     *   才是两条缺陷真正的所在。用例通过注入 `_setTimeout` 把定时器换成收集器，
     *   于是退避序列可以逐格断言。
     *
     * @returns {{action:string, delayMs?:number, reason:string}} 本次决策（便于断言）
     */
    _onChildExit(code, signal, count_id = this.count_id) {
        console.log(`Agent process exited with code ${code} and signal ${signal}`);
        this.running = false;
        logoutAgent(this.name);

        // 先更新"连续快速退出"计数，再交给纯函数决策
        const livedMs = Date.now() - (this._spawnedAt || 0);
        if (livedMs < QUICK_EXIT_MS) this._quickExits += 1;
        else this._quickExits = 0;

        const plan = planExit({ code, signal, livedMs, quickExits: this._quickExits });

        if (plan.action === 'none') return plan;

        if (plan.action === 'unregister') {
            console.warn(`[agent:${this.name}] ${plan.reason}`);
            // 只摘掉自己：注销 + 从 agent_processes 删除（由宿主注入）
            try { this.unregister?.(); } catch (e) {
                console.error(`[agent:${this.name}] 摘除失败：`, e);
            }
            return plan;
        }

        // plan.action === 'restart'：指数退避后再拉起
        console.log(`[agent:${this.name}] ${plan.reason}`);
        try { clearTimeout(this._restartTimer); } catch { /* ignore */ }
        const schedule = this._setTimeout ?? setTimeout;
        this._restartTimer = schedule(() => {
            this._restartTimer = null;
            // 期间可能被 stop()/destroyAgent() 停掉了
            if (this._stoppedByUser) return;
            this.start(true, 'Agent process restarted.', count_id);
        }, plan.delayMs);
        try { this._restartTimer?.unref?.(); } catch { /* ignore */ }
        return plan;
    }

    stop() {
        // ★ 用户明确要停：连"退避中的重启"也一起取消，否则它过几秒又活过来
        this._stoppedByUser = true;
        try { clearTimeout(this._restartTimer); } catch { /* ignore */ }
        this._restartTimer = null;
        if (!this.running) return;
        this.process.kill('SIGINT');
    }

    /**
     * ★ F-EXEC-102（2026-11-06）：停掉并**等到它真的没了**。
     *
     * 为什么需要：原来的 `stop()` 只发 SIGINT 就返回，调用方（`mindcraft.shutdown`）
     * 紧接着 `setTimeout(2000) → process.exit(0)` —— 子进程如果没在 2 秒内退干净，
     * 它就成了孤儿：仍然持有 `board_client` 连接，**继续领单 + 续租**，
     * 面板看着"还有人在干活"、`!stop` 也到不了它。这就是 F-EXEC-102/R2-1 的症状。
     *
     * 这里做完整的"礼貌 → 等 → 强杀 → 再等"，返回结果便于调用方记录/断言：
     *   { exited: true, escalated: false, reason: 'exited' }   ← 自己退了
     *   { exited: true, escalated: true,  reason: 'killed' }   ← 强杀后退了
     *   { exited: false, escalated: true, reason: 'still-alive' } ← 强杀后仍没收到 exit（如实上报，不假装成功）
     */
    async stopAndWait(opts = {}) {
        this._stoppedByUser = true;               // 连"退避中的重启"一起取消
        try { clearTimeout(this._restartTimer); } catch { /* ignore */ }
        this._restartTimer = null;
        if (!this.running || !this.process) {
            return { exited: true, escalated: false, reason: 'no-child' };
        }
        const r = await stopChildAndWait(this.process, opts);
        // 无论结果如何，这个句柄都不该再被当成"在跑"
        this.running = false;
        if (!r.exited) {
            console.error(`[agent:${this.name}] 强杀后仍未确认退出（${r.reason}）—— 可能残留孤儿，请检查进程表`);
        }
        return r;
    }

    forceRestart() {
        if (this.running && this.process && !this.process.killed) {
            console.log(`Agent process for ${this.name} is still running. Attempting to force restart.`);
            
            const restartTimeout = setTimeout(() => {
                console.warn(`Agent ${this.name} did not stop in time. It might be stuck.`);
            }, 5000); // 5 seconds to exit

            this.process.once('exit', () => {
                 clearTimeout(restartTimeout);
                 console.log(`Stopped hanging agent ${this.name}. Now restarting.`);
                 this.start(true, 'Agent process restarted.', this.count_id);
            });
            this.stop(); // sends SIGINT
        } else {
             this.start(true, 'Agent process restarted.', this.count_id);
        }
    }
}