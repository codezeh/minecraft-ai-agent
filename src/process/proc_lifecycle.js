/**
 * F-EXEC-102（2026-11-06）：子进程生命周期 —— 关停要等、孤儿要自杀。
 *
 * 为什么单独一个模块：这三件事都必须**能在没有真机的条件下被单测驱动**。
 * "真的起一个 node 子进程再等它死"既慢又不稳；所以这里把决策与计时器全部做成**可注入**的：
 *   - `isProcessAlive(pid, killFn)`：判存活，killFn 可替换；
 *   - `makeParentWatcher(...)`：父进程消失检测，定时器与 kill 全部可注入；
 *   - `stopChildAndWait(child, opts)`：SIGINT → 等 → SIGKILL → 再等，定时器可注入。
 *
 * 不引入任何依赖（只用 node 内置能力，且连 child_process 都不 import —— 由调用方传 child）。
 */

/** 判某个 pid 还活着吗。ESRCH = 不存在；EPERM = 存在但没权限（也算活着）。 */
export function isProcessAlive(pid, killFn = (p, s) => process.kill(p, s)) {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) return false;
    try {
        killFn(n, 0);
        return true;
    } catch (e) {
        // EPERM：进程存在但当前用户没权限发信号 —— 仍然是"活着"
        if (e && e.code === 'EPERM') return true;
        return false;
    }
}

/**
 * 父进程存活监视器（**孤儿自杀**的核心）。
 *
 * 为什么不用 `process.on('disconnect')`：agent 子进程是用 `stdio:'inherit'` 起的，**没有 IPC 通道**，
 * 拿不到 disconnect 事件。所以改成"父进程 pid 被写进环境变量，子进程定期问它还活着吗"。
 * 为什么不用 `process.ppid` 比对：Windows 上父进程死掉后 `ppid` 不会变成 1（值会停在原来的 pid），
 * 拿它判断会永远认为"父还在"。用 `kill(pid, 0)` 才是跨平台可靠的。
 *
 * @param {object} o
 * @param {number|string} o.parentPid 父进程 pid（来自 MINDSERVER_PID）
 * @param {number} [o.intervalMs=5000]
 * @param {Function} [o.killFn] 判存活用的 kill（测试注入）
 * @param {Function} [o.setIntervalFn]
 * @param {Function} [o.clearIntervalFn]
 * @param {Function} o.onOrphan 父进程消失时调用（通常是"记日志 + 退出"）
 * @returns {{stop: Function, checkNow: Function, hit: boolean}} stop() 用于正常退出前解绑
 */
export function makeParentWatcher({
    parentPid,
    intervalMs = 5000,
    killFn,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    onOrphan,
} = {}) {
    const pid = Number(parentPid);
    const state = { hit: false, timer: null };

    // 没有父 pid（例如手动 `node init_agent.js` 调试）⇒ 不装监视器，保持可手动运行
    if (!Number.isInteger(pid) || pid <= 0) {
        return { stop() { }, checkNow() { return false; }, hit: false };
    }

    const check = () => {
        if (state.hit) return true;
        if (isProcessAlive(pid, killFn)) return false;
        state.hit = true;
        try { onOrphan?.(pid); } catch { /* 退出路径里不要再抛 */ }
        return true;
    };

    state.timer = setIntervalFn(check, intervalMs);
    try { state.timer?.unref?.(); } catch { /* ignore */ }

    return {
        stop() {
            if (state.timer) { clearIntervalFn(state.timer); state.timer = null; }
        },
        checkNow: check,
        get hit() { return state.hit; },
    };
}

/**
 * 停一个子进程并**等到它真的没了**（不能"发个信号就返回"）。
 *
 * 流程：SIGINT → 等 graceMs（期间收到 exit 就返回）→ 还在就 SIGKILL → 再等 killGraceMs。
 * 返回结构便于断言：
 *   { exited: boolean, escalated: boolean, reason: 'exited'|'killed'|'still-alive'|'no-child' }
 *
 * @param {object} child 需要有 once('exit') 与 kill(sig)（EventEmitter 形状即可，测试用假对象）
 */
export function stopChildAndWait(child, {
    graceMs = 5000,
    killGraceMs = 3000,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
} = {}) {
    if (!child || typeof child.once !== 'function' || typeof child.kill !== 'function') {
        return Promise.resolve({ exited: true, escalated: false, reason: 'no-child' });
    }
    // 已经死了（exitCode/signalCode 有值，或 killed 且无 pid）就别再等
    const alreadyGone = child.exitCode !== null && child.exitCode !== undefined
        || child.signalCode !== null && child.signalCode !== undefined
        || child.killed === true && !child.pid;
    if (alreadyGone) {
        return Promise.resolve({ exited: true, escalated: false, reason: 'exited' });
    }

    return new Promise((resolve) => {
        let settled = false;
        let timer = null;
        let escalated = false;

        const finish = (r) => {
            if (settled) return;
            settled = true;
            if (timer) { try { clearTimeoutFn(timer); } catch { /* ignore */ } timer = null; }
            try { child.removeListener?.('exit', onExit); } catch { /* ignore */ }
            resolve(r);
        };
        const onExit = () => finish({ exited: true, escalated, reason: escalated ? 'killed' : 'exited' });

        const later = (ms, fn) => {
            // 注意：这里**不能 unref**。unref 掉的定时器在事件循环空时会不触发，
            // 而调用方正在 `await` 这个 Promise ⇒ 进程会被判定"没有待办事项"提前退出，
            // 表现为 unsettled top-level await（单测实测踩到）。这些定时器是有界短时的，留着是对的。
            timer = setTimeoutFn(fn, ms);
        };

        try { child.once('exit', onExit); } catch { /* ignore */ }

        // ① 先 SIGINT（礼貌），等 graceMs
        try { child.kill('SIGINT'); } catch { /* 已死/无权限 */ }

        later(graceMs, () => {
            if (settled) return;
            // ② 还活着 ⇒ SIGKILL（强杀），再等 killGraceMs
            escalated = true;
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
            later(killGraceMs, () => {
                if (settled) return;
                // ③ 强杀之后仍没收到 exit ⇒ 如实上报"可能还活着"，不假装成功
                finish({ exited: false, escalated: true, reason: 'still-alive' });
            });
        });
    });
}
