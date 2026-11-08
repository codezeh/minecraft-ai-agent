// 控制层（M2，08 §2）：有任务单在跑或排队时不催模型
import { jobsBusy } from './library/control.js';

const STOPPED = 0
const ACTIVE = 1
const PAUSED = 2

/**
 * ★ R4 §7-③：目标循环**连续**抛错多少次才认定"真的坏了"并停下状态。
 * 单次异常（模型层超时、一次工具报错）不该把目标判死 —— `finally` 会让
 * `update()` 在空闲后按既有节流自动重启下一轮；只有连续失败才置 STOPPED。
 */
const MAX_LOOP_ERRORS = 3;
export class SelfPrompter {
    constructor(agent) {
        this.agent = agent;
        this.state = STOPPED;
        this.loop_active = false;
        this.interrupt = false;
        this.prompt = '';
        this.idle_time = 0;
        this.cooldown = 2000;
        // ★ 2026-11-01（M1，08 §5）：目标是**谁**设的。自提示回合发出的命令按这个人的
        // 等级执行（prompt 里的字不算数），提示词注入借不到自提示的路子提权。
        // null = 不知道（系统 / NPCController 设的目标），executeCommand 按「信任」处理。
        this.author = null;
        /** ★ R4 §7-③：目标循环连续异常计数（成功跑完一轮就清零）。 */
        this.loop_errors = 0;
    }

    start(prompt, author = null) {
        console.log('Self-prompting started.');
        if (!prompt) {
            if (!this.prompt)
                return 'No prompt specified. Ignoring request.';
            prompt = this.prompt;
        }
        if (author) this.author = author;
        this.state = ACTIVE;
        this.prompt = prompt;
        this.loop_errors = 0;   // 新目标 = 新的失败预算
        this.startLoop();
    }

    isActive() {
        return this.state === ACTIVE;
    }

    isStopped() {
        return this.state === STOPPED;
    }

    isPaused() {
        return this.state === PAUSED;
    }

    async handleLoad(prompt, state, author = null) {
        if (state == undefined)
            state = STOPPED;
        this.state = state;
        this.prompt = prompt;
        if (author) this.author = author;
        if (state !== STOPPED && !prompt)
            throw new Error('No prompt loaded when self-prompting is active');
        if (state === ACTIVE) {
            await this.start(prompt);
        }
    }

    setPromptPaused(prompt, author = null) {
        this.prompt = prompt;
        if (author) this.author = author;
        this.state = PAUSED;
    }

    async startLoop() {
        if (this.loop_active) {
            console.warn('Self-prompt loop is already active. Ignoring request.');
            return;
        }
        console.log('starting self-prompt loop')
        this.loop_active = true;
        let no_command_count = 0;
        const MAX_NO_COMMAND = 3;
        try {
            while (!this.interrupt) {
                const msg = `You are self-prompting with the goal: '${this.prompt}'. Your next response MUST contain a command with this syntax: !commandName. Respond:`;

                // BOT-001：目标循环是**唯一**可以继承主人权限的内部回合
                // （目标是人设的 !goal，「谁设的目标就是谁的意图」），所以显式带 selfPrompt。
                let used_command = await this.agent.handleMessage('system', msg, -1, { internal: true, selfPrompt: true });
                if (!used_command) {
                    no_command_count++;
                    if (no_command_count >= MAX_NO_COMMAND) {
                        let out = `Agent did not use command in the last ${MAX_NO_COMMAND} auto-prompts. Stopping auto-prompting.`;
                        this.agent.openChat(out)?.catch?.((e) => {
                            console.warn(`[self-prompt] 播报失败：${String(e?.message ?? e)}`);
                        });
                        console.warn(out);
                        this.state = STOPPED;
                        break;
                    }
                }
                else {
                    no_command_count = 0;
                    this.loop_errors = 0;      // 这轮正常跑通了 ⇒ 连续失败计数清零
                    await new Promise(r => setTimeout(r, this.cooldown));
                }
            }
        } catch (err) {
            /**
             * ★ R4 §7-③（2026-11-07 第四轮审计）：一次异常不许把目标循环**悄悄弄死**。
             *
             * 缺陷原貌：循环体里没有任何 try/finally。`handleMessage()` 一旦 reject
             * （模型层/网络/工具里任何一处向上抛），`startLoop()` 就地中断：
             *   ① `this.loop_active` **永远停在 true** ⇒ `update()` 的"自动重启"判据
             *      `!this.loop_active` 恒假 ⇒ 目标循环**永久不再启动**；
             *   ② `this.state` 仍是 ACTIVE ⇒ 界面/存档都说"目标在跑"，实际早就死了。
             * 两者合起来就是"看起来在自驱，其实再也不会动了"。
             *
             * 修法：catch 记日志并把状态**说清楚**；`finally` 无条件复位 loop_active /
             * interrupt（下面的 update() 因此能按既有节流自动重启这一个回合）。
             * 连续失败 MAX_LOOP_ERRORS 次才认定是真的坏了 → state 置 STOPPED，
             * 不再假装 ACTIVE（避免"每 2 秒重试一次、每 2 秒失败一次"的无声空转）。
             */
            this.loop_errors = (this.loop_errors ?? 0) + 1;
            console.error(`[self-prompt] 目标循环异常（第 ${this.loop_errors} 次），已退出本轮循环: ${err?.stack ?? err}`);
            if (this.loop_errors >= MAX_LOOP_ERRORS && this.state === ACTIVE) {
                this.state = STOPPED;
                const out = `Self-prompt loop failed ${this.loop_errors} times in a row, stopping auto-prompting. (${String(err?.message ?? err)})`;
                console.error(out);
                try { this.agent.openChat?.(out)?.catch?.(() => {}); } catch { /* 播报失败不影响停循环 */ }
            }
        } finally {
            console.log('self prompt loop stopped')
            this.loop_active = false;
            this.interrupt = false;
        }
    }

    update(delta) {
        // automatically restarts loop
        if (this.state === ACTIVE && !this.loop_active && !this.interrupt) {
            // ★ 2026-11-01（M2，08 §2）：**有任务单在跑或排队时都不催。**
            // 单子是调度器的事，模型这时候插一句只会下出重复命令，把正在续做的单冲掉。
            // 没有任务板（M8 之前）时 jobsBusy 恒为 false，行为与原来一致。
            if (jobsBusy(this.agent)) {
                this.idle_time = 0;
                return;
            }
            if (this.agent.isIdle())
                this.idle_time += delta;
            else
                this.idle_time = 0;

            if (this.idle_time >= this.cooldown) {
                console.log('Restarting self-prompting...');
                this.startLoop();
                this.idle_time = 0;
            }
        }
        else {
            this.idle_time = 0;
        }
    }

    async stopLoop() {
        // you can call this without await if you don't need to wait for it to finish
        if (this.interrupt)
            return;
        console.log('stopping self-prompt loop')
        this.interrupt = true;
        while (this.loop_active) {
            await new Promise(r => setTimeout(r, 500));
        }
        this.interrupt = false;
    }

    async stop(stop_action=true) {
        this.interrupt = true;
        if (stop_action)
            // 07 §4：停自提示顺带停动作，属于"即时命令"这一档 —— 原因 brief
            await this.agent.actions.stop('brief');
        this.stopLoop();
        this.state = STOPPED;
        this.author = null;   // 目标没了，等级来源一并清掉
    }

    async pause() {
        this.interrupt = true;
        await this.agent.actions.stop('brief');
        this.stopLoop();
        this.state = PAUSED;
    }

    shouldInterrupt(is_self_prompt) { // to be called from handleMessage
        return is_self_prompt && (this.state === ACTIVE || this.state === PAUSED) && this.interrupt;
    }

    handleUserPromptedCmd(is_self_prompt, is_action) {
        // if a user messages and the bot responds with an action, stop the self-prompt loop
        if (!is_self_prompt && is_action) {
            this.stopLoop();
            // this stops it from responding from the handlemessage loop and the self-prompt loop at the same time
        }
    }
}
