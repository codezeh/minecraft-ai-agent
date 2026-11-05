/**
 * 第1条 ④ 证据之三：为什么 `evalTaming` 不能改成 `safeEval`（硬依赖，不是图方便）。
 *
 * 用法：node docs/audit/probes/t10-safeeval-protodef.mjs safeEval|unsafeEval
 * 判读：
 *   - unsafeEval → ① 最小形状 `eval(code)()` 取到模块局部变量；② minecraft-protocol 的
 *                  compiled 协议（createSerializer/createDeserializer）编译成功。
 *   - safeEval   → 两条都抛 `TypeError: Cannot read properties of undefined (reading 'i8')`。
 * 根因：protodef 的编译器是 `node_modules/protodef/src/compiler.js:262` 的 `eval(code)()`，
 *       它依赖**模块局部变量** `native`；safeEval 的 eval 看不见局部作用域 ⇒ `native` 是 undefined
 *       ⇒ bot 连第一个包都发不出去。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MINDCRAFT = path.resolve(__dirname, '../../../mindcraft');
const load = (rel) => import(pathToFileURL(path.join(MINDCRAFT, rel)).href);

await load('node_modules/ses/index.js');

const mode = process.argv[2] === 'safeEval' ? 'safeEval' : 'unsafeEval';
globalThis.lockdown({
    localeTaming: 'unsafe', consoleTaming: 'unsafe', errorTaming: 'unsafe',
    stackFiltering: 'verbose', evalTaming: mode,
});
console.log('[probe] evalTaming =', mode);

// ① protodef Compiler.compile 的最小形状：eval 出来的代码要能看见「模块局部」变量 native
function compileLikeProtoDef(code) {
    const native = { i8: 1 };            // eslint-disable-line
    return eval(code)();                  // eslint-disable-line
}
try {
    const out = compileLikeProtoDef('() => () => native.i8');
    console.log('[probe] ① eval(code)() 最小形状 → OK, 取到 native.i8 =', out());
} catch (e) {
    console.log('[probe] ① eval(code)() 最小形状 → THROW', e?.constructor?.name, ':', e?.message);
}

// ② 真实路径：mineflayer 收发每个包都要先建这个 compiled 协议
try {
    const serializer = await load('node_modules/minecraft-protocol/src/transforms/serializer.js');
    serializer.createSerializer({ state: 'play', isServer: true, version: '1.21.8' });
    serializer.createDeserializer({ state: 'play', isServer: false, version: '1.21.8' });
    console.log('[probe] ② compiled 协议编译 → OK（mineflayer 可收发）');
} catch (e) {
    console.log('[probe] ② compiled 协议编译 → THROW', e?.constructor?.name, ':', e?.message);
    console.log('[probe] RESULT: safeEval 不可行 ⇒ evalTaming 只能保留 unsafeEval；'
        + '「不是沙箱」必须在 README 与 coder.js 写清（已写）');
}
