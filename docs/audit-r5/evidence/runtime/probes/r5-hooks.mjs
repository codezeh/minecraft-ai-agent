/**
 * t-r5 探针专用 ESM 加载钩子：**只追加一行 export**，不改被测代码任何一行逻辑。
 *
 * 用途：`takeToken` / `isSpeaking` 都是模块内部符号。要么改源码（不允许，会把审计对象改了），
 *   要么在加载期把内部符号"开个观察窗"。这里选后者 —— 被测逻辑逐字未变，
 *   探针只是拿到了读它内部状态的把手。
 */
import { readFile } from 'node:fs/promises';

const TARGETS = [
    {
        match: /\/src\/agent\/speak\.js$/,
        extra: '\nexport const __r5_speakState = () => ({ isSpeaking, queue: speakingQueue.length });\n',
    },
    {
        match: /\/src\/mindcraft\/mindserver\.js$/,
        extra: '\nexport const __r5_rate = { takeToken, RATE_BUCKETS, RATE_BUCKETS_MAX: (typeof RATE_BUCKETS_MAX !== "undefined" ? RATE_BUCKETS_MAX : null) };\n',
    },
];

export async function load(url, context, nextLoad) {
    const result = await nextLoad(url, context);
    const hit = TARGETS.find((t) => t.match.test(url));
    if (!hit) return result;
    if (result.format !== 'module') return result;
    const src = typeof result.source === 'string'
        ? result.source
        : Buffer.from(result.source).toString('utf8');
    return { ...result, source: src + hit.extra };
}
