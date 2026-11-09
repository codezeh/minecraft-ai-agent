/**
 * t-r5-6 —— 「speak.js 的 catch 不重置 isSpeaking ⇒ 一次异常永久静音」
 *
 * 缺陷形态（老实现）：`continueQueue()` 的 `catch(e => console.error(...))` **只打一行日志**，
 *   不把 `isSpeaking` 放回 false。而 `isSpeaking` 是泵的闸门：
 *   `speak()` 里 `if (!isSpeaking) continueQueue()` ⇒ 一次异常之后
 *   所有 TTS 请求**只入队、永远没人播**（"她突然永久哑了"）。
 *
 * 判定方式（不靠读码，靠跑）：喂一条**必炸**的文本（`toString()` 抛错 ——
 *   老实现 `txt.trim()` 会 TypeError，新实现 `String(item.text)` 会抛），
 *   等异常落地后读模块内部的 `isSpeaking` 闸门：
 *     · 闸门卡在 true → 缺陷复现，退出码 0；
 *     · 闸门回到 false → 未复现，退出码 1。
 *
 * 为什么用 toString 抛错：它保证**不会真的启动 TTS 进程**（不会在这台机器上出声），
 *   故障点又正好落在老实现那句 `txt.trim()`（非字符串）之前/之中的同一条路径上。
 *
 * isSpeaking 是模块内部变量：用 r5-hooks.mjs 在加载期开观察窗，被测逻辑一行未改。
 *
 * 用法：node .../t-r5-6.mjs ；R5_SRC=<pre-fix>/src node .../t-r5-6.mjs
 * 退出码：0=缺陷复现，1=未复现，2=CANNOT-RUN。
 */
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(process.env.R5_SRC || path.resolve(HERE, '../../../../../mindcraft/src'));
const say = (...a) => console.log('[t-r5-6]', ...a);

register(pathToFileURL(path.join(HERE, 'r5-hooks.mjs')));

// 一次 unhandled rejection 不该把探针带走：先接住（这正是老缺陷的另一半坑）
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(String(e?.message ?? e)));

let speakMod;
try {
    speakMod = await import(pathToFileURL(path.join(SRC, 'agent/speak.js')).href);
} catch (e) {
    console.error('[t-r5-6] CANNOT-RUN：导入 speak.js 失败：', e?.message ?? e);
    process.exit(2);
}
const state = speakMod.__r5_speakState;
if (typeof state !== 'function') {
    console.error('[t-r5-6] CANNOT-RUN：加载钩子没能从 speak.js 取出 isSpeaking');
    process.exit(2);
}

say('调用前闸门：', JSON.stringify(state()));

// 必炸文本：老实现 txt.trim() → TypeError；新实现 String(obj) → 抛出自定义错误
const bomb = { toString() { throw new Error('[t-r5-6] 故意制造的 TTS 单条故障'); } };
speakMod.speak(bomb, 'system');

// 等异常沿 promise 链落地（不启动任何 TTS 进程，所以很快）
await new Promise((r) => setTimeout(r, 300));

const after = state();
say('异常落地后闸门：', JSON.stringify(after));
say('unhandledRejection 次数：', unhandled.length, unhandled.length ? JSON.stringify(unhandled) : '');

if (after.isSpeaking === true) {
    say('REPRODUCED：一次异常后 isSpeaking 永久卡在 true —— 队列泵已死，之后所有 TTS 请求只入队、永远不播');
    process.exit(0);
}
say('NOT-REPRODUCED：异常后闸门已复位（isSpeaking=false），队列泵可继续工作');
process.exit(1);
