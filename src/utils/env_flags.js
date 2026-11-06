/**
 * 启动期的环境变量开关解析（SEC-002，2026-11-06 深度检查）。
 *
 * 缺陷原貌（main.js:47-60）：`INSECURE_CODING` 用了「排除法」——
 *   只把 `0/false/no/off` 当关闭，其它**任何非空值**都当开启：
 *   ```js
 *   if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') { … }
 *   else { settings.allow_insecure_coding = true; }
 *   ```
 * 于是 `INSECURE_CODING=disabled`、`=nope`、`=我关了` 这类明显想"关"的拼写，
 * 全部变成「打开本机代码执行 = 本机 root」。注释写着"只认 1/true/yes/on"，代码并不认。
 *
 * 现在的口径：**白名单开启**。只有显式开启值才开；关闭值就是关；
 * 其余（含拼错、空串、未知文本）一律**保持关闭**并给出可操作的告警。
 * 之所以选"报错退出"以外的做法：一键启动脚本/CI 里环境变量拼错很常见，
 * 让进程因为一个布尔开关直接起不来，会把「安全默认」换成「不可用的服务」；
 * 而 fail-closed（关着代码执行）+ 醒目告警，既不会静默开闸，也不会挡住正常启动。
 *
 * 为什么不写在 main.js 里：main.js 是入口、import 即执行，没法单测。
 * 抽成纯函数后 tools/sec002_env_flags_unit.mjs 可以逐值断言。
 */

/** 显式开启：只有这四个值算"开"。 */
const ENABLE_VALUES = Object.freeze(['1', 'true', 'yes', 'on']);

/** 显式关闭（写出来只是让人确认自己关了，行为与"未知值"一致）。 */
const DISABLE_VALUES = Object.freeze(['0', 'false', 'no', 'off']);

/**
 * 解析 `INSECURE_CODING`。
 *
 * @param {unknown} raw 环境变量原文（可能 undefined / 空白 / 任意文本）
 * @returns {{enabled: boolean, explicit: boolean, warn: string|null}}
 *   - `enabled`：最终是否开闸（未知值 = false）
 *   - `explicit`：是否是**显式开启值**（true 才允许打印"开闸"横幅）
 *   - `warn`：需要打印的告警（null = 无需告警）
 */
export function parseInsecureCoding(raw) {
    // 没设这个变量：最常见的正路，什么都不用说。
    if (raw === undefined || raw === null) {
        return { enabled: false, explicit: false, warn: null };
    }
    const text = String(raw).trim();
    const norm = text.toLowerCase();

    if (text === '') {
        // 设了但为空（`set INSECURE_CODING=`）：不是"开启"，也不是"关闭"的明确表达。
        return {
            enabled: false,
            explicit: false,
            warn: '[安全] INSECURE_CODING 被设为空值，按「关闭」处理（只认 1/true/yes/on）。',
        };
    }
    if (ENABLE_VALUES.includes(norm)) {
        return { enabled: true, explicit: true, warn: null };
    }
    if (DISABLE_VALUES.includes(norm)) {
        return { enabled: false, explicit: false, warn: null };
    }
    // 未知值：SEC-002 的核心 —— 不再默认开闸。
    return {
        enabled: false,
        explicit: false,
        warn: `[安全] INSECURE_CODING=${text} 不是可识别的值，按「关闭」处理（只认 1/true/yes/on，`
            + '0/false/no/off 为关）。如果本意是开启本机代码执行，请显式写 INSECURE_CODING=1。',
    };
}

/** 开闸横幅（只在显式开启时打印），单独抽出来便于测试断言文案。 */
export function insecureCodingBanner() {
    const bar = '='.repeat(72);
    return [
        bar,
        '[安全] 代码执行已开启 = 本机 root 权限',
        '[安全] INSECURE_CODING 生效：模型可以写并运行任意 JS（不是沙箱，逃逸已实测）。',
        '[安全] 只有本机、可信输入、临时调试时才这么跑；用完删掉这个环境变量。',
        bar,
    ].join('\n');
}

export const INSECURE_CODING_VALUES = Object.freeze({
    enable: ENABLE_VALUES,
    disable: DISABLE_VALUES,
});
