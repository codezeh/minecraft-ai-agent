import { push as trace } from './library/trace_bus.js';
import {
    STOP_REASONS, DEFAULT_STOP_REASON, normalizeStopReason, applyStop,
} from './library/control.js';

/**
 * 一个前台动作槽 + 一个 resume 槽。
 *
 * ★ 2026-11-01（M2，07 §4 / §5 / §8）：`stop()` 现在要带**原因**，调用方不说清
 * "谁在停她"，被打断的任务单就没法决定回 ready 还是留在手里（07 §4 那张表）。
 * 另外 07 §5（D17 / D18）的两个老毛病在这里修：
 *   - D17：`timedout` 从复位不清 → 之后每一次中断都被当成超时，中断消息被吞
 *   - D18：`stop()` 等满 10 秒就强制复位 `executing=false`，旧动作还在跑，
 *          新动作照开 —— 两个流程同时驱动身体。现在改成"当 bug 处理：让身体停住 + 重启进程"
 */
export class ActionManager {
    constructor(agent) {
        this.agent = agent;
        this.executing = false;
        this.currentActionLabel = '';
        this.currentActionFn = null;
        this.timedout = false;
        this.resume_func = null;
        this.resume_name = '';
        this.last_action_time = 0;
        this.recent_action_counter = 0;
        /** 最近一次 `stop()` 的原因（07 §4：记在 `actions.stop_reason`，调度器读它）。 */
        this.stop_reason = null;
        /** 正在跑的任务单 id（由 control.runJobAction 置；不是任务单时为 null）。 */
        this.currentJobId = null;
        /** `stop()` 等多久算"停不下来"（07 §5 写的是 10 秒；测试传小值）。 */
        this.stopWaitMs = 10000;
        /** 已经判定"停不下来、要重启进程"：之后不许再开新动作（D18）。 */
        this.killed = false;
        /**
         * BOT-002：启动票的序号与"当前未兑现的启动票"。
         *
         * 为什么要票：`executing` 的置位发生在 `await this.stop()` 之后，
         * 两条并发动作都能在等待期间越过检查（实测 maxConcurrent=2）。
         * 票在第一个 await 之前登记、由后来者作废，保证同一时刻只有一个动作能认领槽位。
         */
        this._launchSeq = 0;
        this._pendingLaunch = null;
    }

    async resumeAction(actionFn, timeout) {
        return this._executeResume(actionFn, timeout);
    }

    /**
     * @param {string} actionLabel 动作名（任务单用 `job:<skill>`，mode 用 `mode:<name>`）
     * @param {Function} actionFn
     * @param {{timeout?:number, resume?:boolean, stopReason?:string}} [opts]
     *   stopReason：这一轮要打断上一轮时用的原因（07 §4）。默认 brief（即时命令 / 反射）。
     */
    async runAction(actionLabel, actionFn, { timeout, resume = false, stopReason = DEFAULT_STOP_REASON } = {}) {
        if (resume) {
            return this._executeResume(actionLabel, actionFn, timeout, stopReason);
        } else {
            return this._executeAction(actionLabel, actionFn, timeout, stopReason);
        }
    }


    /**
     * 停掉前台动作。
     *
     * ★ 2026-11-01（M2，07 §4）：`reason` 必带，调用方不许省略 —— 省略就看不出
     * "谁在停她"，被打断的任务单也就没有去处。原因记在 `this.stop_reason`，
     * 同时交给 control.applyStop() 落到任务板上：
     *
     * | 原因 | 谁调 | 单子去哪 |
     * |---|---|---|
     * | brief    | 反射 mode / 即时命令 | 留在本 bot，打断完接着做；60 秒没结束回 ready |
     * | preempt  | 调度器（来了更高优先级的单） | ready，放掉租约和预约，PREEMPTED |
     * | player   | !stop / !stay | paused，并暂停自动领单，INTERRUPTED |
     * | timeout  | 这里的总超时 | 按 attempts 重试或 failed，TIMEOUT |
     * | shutdown | 进程退出 | 不动，等租约过期 |
     * | death    | 死亡（07 §7） | paused，记 died，不算 attempts |
     *
     * ★ D18（07 §5）：等满 `stopWaitMs` 还没退出 = **bug**，不是慢。原来的做法是
     * 强制复位 `executing=false` 再开新动作，于是旧流程还在跑 —— 两个流程同时驱动身体。
     * 现在按 07 §5：让身体停住（松键 / 停寻路 / 停挖）、发 `zombie-action` 事件、
     * 重启 agent 进程（任务单靠租约过期 + checkpoint 接着做）。
     */
    async stop(reason = DEFAULT_STOP_REASON) {
        const r = normalizeStopReason(reason);
        this.stop_reason = r;

        // 把"停"的后果交给控制层（打的是任务单时才有转移；不是单就只留 stop_reason）
        try {
            applyStop({
                agent: this.agent,
                reason: r,
                label: this.currentActionLabel,
                jobId: this.currentJobId,
            });
        } catch { /* 控制层的失败不能挡住"停"本身 */ }

        if (!this.executing) {
            // ★★★ T31 第6条②：**这里原来是一句直接 `return`。**
            //
            //   而调度器跑单时 `executing` 完全可能是 false（流程正处在两个动作之间的
            //   等待里，甚至还没轮到第一个动作）→ 一次 `requestInterrupt()` 都不发 →
            //   流程永远收不到"停"：玩家按 `!stop`，面板上的单变 paused 了，**身体却接着干活**。
            //
            //   现在：只要有**在飞的任务单**（`currentJobId` 非空）就补发一次中断。
            //   ★ 刻意**不进入**下面那个 10 秒等待循环、也不触发 zombie 重启：
            //     那套机制是给"真有动作在跑却停不下来"（D18）准备的，
            //     套在这里会把"调度器在等模型/等 IO"误判成僵尸动作 → 白重启一次进程。
            if (this.currentJobId != null) {
                try { this.agent.requestInterrupt(); } catch { /* 发不出中断不该让 stop 抛 */ }
            }
            return;
        }
        if (this.killed) return;   // 已经判定要重启了，别再发中断空转

        const waitedFrom = Date.now();
        let zombieFired = false;
        const timeout = setTimeout(() => {
            zombieFired = true;
            this._onZombieAction({
                label: this.currentActionLabel,
                reason: r,
                waitedMs: Date.now() - waitedFrom,
            });
        }, this.stopWaitMs);

        while (this.executing && !zombieFired) {
            this.agent.requestInterrupt();
            console.log('waiting for code to finish executing...');
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        clearTimeout(timeout);
    }

    /**
     * 07 §5 / D18：「停不下来」的处理。
     *
     * 顺序很关键 —— 先让身体停住再重启，否则重启前这几秒她还在挖 / 还在跑：
     *   1) 松键、停寻路、停挖、停 PvP（尽力而为，每一步都不许抛）
     *   2) 发 `zombie-action` 事件（动作名、等了多久、原因），面板看得见这次她为什么重启
     *   3) `cleanKill(msg, 1)`：退出码 1 → agent_process 重新拉起（退出码 > 1 会让
     *      mindserver 整体退出并结束任务，那是"别玩了"不是"重启"）
     */
    _onZombieAction({ label = '', reason = null, waitedMs = 0 } = {}) {
        this.killed = true;
        const bot = this.agent?.bot;
        try { bot?.clearControlStates?.(); } catch { /* ignore */ }
        try { bot?.releaseAll?.(); } catch { /* 新版本 mineflayer 才有 */ }
        try { bot?.pathfinder?.stop?.(); } catch { /* ignore */ }
        try { bot?.stopDigging?.(); } catch { /* ignore */ }
        try { bot?.pvp?.stop?.(); } catch { /* ignore */ }

        try { trace('zombie-action', { label: String(label ?? '').slice(0, 40), reason: reason ?? '', waitedMs }); } catch { /* ignore */ }
        console.error(`[控制] 动作 "${label}" 等了 ${waitedMs}ms 还没退出 —— 按 bug 处理（07 §5 D18），重启 agent 进程。`);
        this.agent?.history?.add?.('system', `Action "${label}" did not stop in ${waitedMs}ms; restarting agent process.`);
        try {
            this.agent?.cleanKill?.('Action did not stop in time, restarting agent process.', 1);
        } catch { /* 测试里的假 agent 可能没有 cleanKill */ }
    }


    cancelResume() {
        this.resume_func = null;
        this.resume_name = null;
    }

    async _executeResume(actionLabel = null, actionFn = null, timeout = 10, stopReason = DEFAULT_STOP_REASON) {
        const new_resume = actionFn != null;
        if (new_resume) { // start new resume
            this.resume_func = actionFn;
            // ★★★ T31（T03 的 no-undef 实测点名）：`assert` 在本文件里**从来没 import 过** ——
            //   全仓唯一一处"以为有、其实没有"的名字，真跑到这里是 ReferenceError。
            //   本仓 src/ 里**没有任何 assert 约定**（`node:assert` 0 处 import），
            //   所以不引入新依赖，直接显式抛错：语义完全等价（就是"这个参数不该是 null"），
            //   而且不再是个未声明标识符（T90 硬指标 no-undef = 0 的一部分）。
            if (actionLabel == null) throw new Error('actionLabel is required for new resume');
            this.resume_name = actionLabel;
        }
        if (this.resume_func != null && (this.agent.isIdle() || new_resume) && (!this.agent.self_prompter.isActive() || new_resume)) {
            this.currentActionLabel = this.resume_name;
            let res = await this._executeAction(this.resume_name, this.resume_func, timeout, stopReason);
            this.currentActionLabel = '';
            return res;
        } else {
            return { success: false, message: null, interrupted: false, timedout: false };
        }
    }

    async _executeAction(actionLabel, actionFn, timeout = 10, stopReason = DEFAULT_STOP_REASON) {
        let TIMEOUT;
        // ★ BOT-002（2026-11-06 深度检查）：**启动临界区必须串行**。
        //
        //   缺陷原貌：`this.executing = true` 写在 `await this.stop()` **之后**。
        //   两条并发动作（两条聊天命令 / 聊天与反射 mode 相撞 / 调度器与主人同时开口）
        //   会同时通过"没人在跑"的检查，一起走到这里 →
        //   实测 maxConcurrent=2，顺序 start1/start2/end1/end2：两个流程同时控制视角/容器/挖掘，
        //   而且**先完成者**还会把 executing 与中断状态清掉，槽位状态失真。
        //
        //   修法：在第一个 await 之前登记一张"启动票"，并把上一张未兑现的票作废。
        //   规则是**后来者取代先来者**（不是排队）：最新的动作赢了才符合"打断=接管"的语义，
        //   排队会让"跟着我"等在上一条 10 分钟的活后面 —— 那是另一个 bug。
        //   认领动作槽（清票 + executing=true）在 await 返回后**同步**完成，中间没有 await 间隙，
        //   所以同一时刻只可能有一个启动者真正开工。
        const ticket = { seq: ++this._launchSeq, superseded: false };
        const previous = this._pendingLaunch;
        this._pendingLaunch = ticket;
        if (previous) previous.superseded = true;
        try {
            // ★ D17（07 §5）：**每次开工前清掉 `timedout`**。
            // 原来这个标志置上之后再也不复位：一次超时之后，后面每一次
            // INTERRUPTED 都被当成 timedout（`getBotOutputSummary` 直接返回空、
            // 上层把"被打断"报成"超时"），等于把中断消息永久吞掉。
            this.timedout = false;

            if (this.last_action_time > 0) {
                let time_diff = Date.now() - this.last_action_time;
                if (time_diff < 20) {
                    this.recent_action_counter++;
                }
                else {
                    this.recent_action_counter = 0;
                }
                if (this.recent_action_counter > 3) {
                    console.warn('Fast action loop detected, cancelling resume.');
                    this.cancelResume(); // likely cause of repetition
                }
                if (this.recent_action_counter > 5) {
                    console.error('Infinite action loop detected, shutting down.');
                    this.agent.cleanKill('Infinite action loop detected, shutting down.');
                    return { success: false, message: 'Infinite action loop detected, shutting down.', interrupted: false, timedout: false };
                }
            }
            this.last_action_time = Date.now();
            console.log('executing code...\n');

            // await current action to finish (executing=false), with 10 seconds timeout
            // also tell agent.bot to stop various actions
            if (this.executing) {
                console.log(`action "${actionLabel}" trying to interrupt current action "${this.currentActionLabel}"`);
            }
            await this.stop(stopReason);

            // ★ BOT-002：我在这段时间里被后来的启动请求取代了吗？
            //   是 ⇒ 不许开工（否则就是两个流程同时驱动身体，正是本条要消灭的现象）。
            //   这里只做"不开工"，不去动 executing —— 槽位归赢家所有。
            if (ticket.superseded || this._pendingLaunch !== ticket) {
                console.warn(`action "${actionLabel}" not started: superseded by a newer action.`);
                return {
                    success: false,
                    message: 'Superseded by a newer action; this one did not start.',
                    interrupted: true,
                    timedout: false,
                };
            }
            // 认领动作槽：清票 + 置 executing 是**同步**完成的（往下到 await actionFn() 之间没有 await），
            // 所以不存在"两个都以为自己在跑"的窗口。
            this._pendingLaunch = null;

            // 上一条被判"停不下来、要重启进程"（07 §5 D18）：不许在它上面开新动作，
            // 否则就是两个流程同时驱动身体 —— 正是 D18 要消灭的现象。
            if (this.killed) {
                console.error(`action "${actionLabel}" not started: previous action did not stop (zombie), process is restarting.`);
                return {
                    success: false,
                    message: 'Previous action did not stop; agent process is restarting.',
                    interrupted: true,
                    timedout: false,
                };
            }

            // stop() 里的 requestInterrupt() 会把 interrupt_code 置真，那是给「旧动作」看的。
            // 如果不清掉，接下来这个新动作一启动就读到 interrupt_code=true，
            // 立刻以 INTERRUPTED 返回 —— 实测现象：连说两次「跟着我」，第二次必然「不跟了」。
            this.agent.clearBotLogs();

            this.executing = true;
            this.currentActionLabel = actionLabel;
            this.currentActionFn = actionFn;
            // 面板上"她刚接了个什么活"就靠这条
            try { trace('action-begin', { label: actionLabel }); } catch { /* ignore */ }

            // timeout in minutes
            if (timeout > 0) {
                TIMEOUT = this._startTimeout(timeout);
            }

            // start the action
            await actionFn();

            // mark action as finished + cleanup
            this.executing = false;
            try {
                trace('action-end', {
                    label: actionLabel,
                    ms: Date.now() - this.last_action_time,
                });
            } catch { /* ignore */ }
            this.currentActionLabel = '';
            this.currentActionFn = null;
            clearTimeout(TIMEOUT);

            // get bot activity summary
            let output = this.getBotOutputSummary();
            let interrupted = this.agent.bot.interrupt_code;
            let timedout = this.timedout;
            this.agent.clearBotLogs();

            // if not interrupted and not generating, emit idle event
            if (!interrupted) {
                this.agent.bot.emit('idle');
            }

            // return action status report
            return { success: true, message: output, interrupted, timedout };
        } catch (err) {
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            clearTimeout(TIMEOUT);
            this.cancelResume();
            // 记下最近一次失败，供 Web 界面显示（比翻日志快）。
            // 只存一行摘要，不存整个堆栈，避免把状态包撑大。
            try {
                this.agent.bot.lastFailure = {
                    at: Date.now(),
                    action: this.currentActionLabel || '(unknown)',
                    message: String(err && err.message ? err.message : err).slice(0, 300),
                };
            } catch (e) { /* 记录失败本身不该再抛 */ }
            console.error("Code execution triggered catch:", err);
            // Log the full stack trace
            console.error(err.stack);
            // 异常退出也要带原因（07 §4）：沿用这一轮开工时定的原因，不是"没见过"。
            await this.stop(stopReason);
            err = err.toString();

            let message = this.getBotOutputSummary() +
                '!!Code threw exception!!\n' +
                'Error: ' + err + '\n' +
                'Stack trace:\n' + err.stack+'\n';

            let interrupted = this.agent.bot.interrupt_code;
            this.agent.clearBotLogs();
            if (!interrupted) {
                this.agent.bot.emit('idle');
            }
            return { success: false, message, interrupted, timedout: false };
        }
    }

    getBotOutputSummary() {
        const { bot } = this.agent;
        if (bot.interrupt_code && !this.timedout) return '';
        let output = bot.output;
        // 原来是 500，太紧：一次结构化技能输出（摘要 + 一张 9x9 地图 + 图例）就 ~400 字符，
        // 再带一点其它 log 就超了，而超过之后是"前 250 + 后 250"腰斩 ——
        // 中间的地图整块消失，模型却以为自己看到了（实测踩过：她完全没提地图）。
        // 1500 足够容纳结构化结果；循环打印几千行的情况依然被兜底截断。
        const MAX_OUT = 1500;
        if (output.length > MAX_OUT) {
            output = `Action output is very long (${output.length} chars) and has been shortened.\n
          First outputs:\n${output.substring(0, MAX_OUT / 2)}\n...skipping many lines.\nFinal outputs:\n ${output.substring(output.length - MAX_OUT / 2)}`;
        }
        else {
            output = 'Action output:\n' + output.toString();
        }
        bot.output = '';
        return output;
    }

    _startTimeout(TIMEOUT_MINS = 10) {
        return setTimeout(async () => {
            console.warn(`Code execution timed out after ${TIMEOUT_MINS} minutes. Attempting force stop.`);
            this.timedout = true;
            this.agent.history.add('system', `Code execution timed out after ${TIMEOUT_MINS} minutes. Attempting force stop.`);
            // 07 §4：总超时的原因就是 `timeout`，任务单按 attempts 重试或判 failed。
            await this.stop(STOP_REASONS.TIMEOUT);
        }, TIMEOUT_MINS * 60 * 1000);
    }

}