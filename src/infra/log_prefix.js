/**
 * 统一日志前缀（报告第12条）。
 *
 * 问题（已实测）：agent 侧的 console 输出**没有任何时间前缀** ——
 * tmp-t59-agent.log 293 行里 0 条带时间、run-live.log 85 行里 0 条。
 * 后果不是"日志难看"，而是：
 *   - 任何事故定位不到**秒**，只能靠上下文猜；
 *   - LLM 调用 / 技能执行**耗时物理上算不出来**（没有起点时间戳）；
 *   - 连"两次 goal 冲突之间隔了多久"这种最基本的问题都答不了。
 *
 * 做法：把 console.log / error / warn 包一层，前缀 'YYYY-MM-DDTHH:MM:SS.sssZ '。
 *
 * 几个必须守住的点（都对应一条真实会咬人的坑）：
 *  1) **保留 printf 语义**：用 util.format 而不是字符串拼接。
 *     `console.log('%s 走了 %d 格', name, n)` 与 `console.log({a:1})` 的对象展开
 *     都必须和原来一模一样，否则日志内容会被这次改造改坏。
 *  2) **幂等**：重复调用不叠加前缀。靠两层保险 ——
 *     (a) 包装过的函数带 Symbol 标记，已标记的就跳过；
 *     (b) 兜底再查一次"这行是不是已经有 ISO 前缀了"，防止本模块被重复加载
 *         （两个不同 specifier 加载同一份代码时 Symbol.for 也会命中，但多一层不亏）。
 *  3) **不改返回值**：把原函数的返回值原样返回。
 *  4) **不吞异常**：格式化/原函数抛错就让它抛出去，不 try/catch 兜住。
 *     静默吞掉日志错误 = 又一个"看起来没报错"。
 *  5) **单调可排序**：前缀统一用 `Date.toISOString()`（UTC，定长毫秒），
 *     字典序 = 时间序，跨进程/跨机器也能直接 sort。
 *
 * 范围：不引入依赖（只用 node:util）、不改任何调用点、不碰 main.js。
 */

import { format } from 'node:util';

/** 已经带 ISO 前缀的行（允许结尾没有空格，覆盖空消息那种情况）。 */
const ALREADY_PREFIXED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z(?: |$)/;

/** 包装标记。用 Symbol.for 是为了"同一份代码被加载两次"时也能认出彼此。 */
const WRAPPED = Symbol.for('mindcraft.log_prefix.wrapped');

/** 默认处理这三个。debug/info 不在第12条范围内，不擅自扩大。 */
const DEFAULT_METHODS = ['log', 'error', 'warn'];

/** UTC ISO8601 毫秒精度：'2026-11-05T10:23:45.123Z'。定长 ⇒ 字典序 = 时间序。 */
function stamp() {
    return new Date().toISOString();
}

/**
 * 把一个 console 方法包上时间前缀。
 * @param {Function} orig 原始方法
 * @returns {Function} 包装后的方法（带 WRAPPED 标记）
 */
function wrapOne(orig) {
    const wrapped = function wrappedConsole(...args) {
        const ts = stamp();
        // util.format 保留 %s/%d/%o/%j 语义与多参数拼接，等价于 console 原本的输出。
        const text = format(...args);
        // 兜底幂等：如果内容自己已经带前缀（理论上只会发生在被包了两层时），不再加第二个。
        const line = ALREADY_PREFIXED.test(text) ? text : (text === '' ? ts : `${ts} ${text}`);
        // 用 apply 保留 this（`const {log}=console` 这类解构调用时 this 会变，原函数行为照样保持）。
        return orig.apply(this, [line]);
    };
    wrapped[WRAPPED] = true;
    return wrapped;
}

/**
 * 给当前进程的 console 打上 ISO 时间戳前缀。**幂等**：重复调用不会叠加。
 *
 * @param {{ methods?: string[] }} [opts] 只用于测试时收窄范围；默认 log/error/warn。
 * @returns {{ installed: string[], skipped: string[] }} 本次真正装上 / 因已装而跳过的
 */
export function installLogPrefix(opts = {}) {
    const methods = Array.isArray(opts?.methods) && opts.methods.length
        ? opts.methods
        : DEFAULT_METHODS;

    const installed = [];
    const skipped = [];

    for (const name of methods) {
        const cur = console[name];
        if (typeof cur !== 'function') continue;      // 环境里没有这个方法就跳过
        if (cur[WRAPPED]) {                           // ① 已经包过 → 幂等跳过
            skipped.push(name);
            continue;
        }
        console[name] = wrapOne(cur);
        installed.push(name);
    }

    return { installed, skipped };
}

/** 供测试/诊断：当前是否已经装过。 */
export function isLogPrefixInstalled(opts = {}) {
    const methods = Array.isArray(opts?.methods) && opts.methods.length
        ? opts.methods
        : DEFAULT_METHODS;
    return methods.every((n) => typeof console[n] === 'function' && Boolean(console[n][WRAPPED]));
}
