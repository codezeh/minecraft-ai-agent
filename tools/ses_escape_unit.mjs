/**
 * SES 边界回归护栏（第一轮审查 第 1 条 ④）—— 不需要 Minecraft 服务器。
 *
 * 为什么需要这个测试：`src/agent/library/lockdown.js` 曾经**看着在设防、实际什么都没做**：
 *
 * ```js
 * export function lockdown() { ... lockdown({ evalTaming:'unsafeEval' }); }   // 调的是它自己
 * ```
 *
 * 模块作用域里的同名导出把 SES 的全局 `lockdown` 遮住了，第一次调用就把 `lockeddown` 置 true
 * 再「调用自己」，第二层立刻 return ⇒ **SES lockdown 从未执行**。
 * 后果（本文件同时验证）：注入给模型的宿主对象，其 `.constructor` 就是宿主 `Function`：
 *   `skills.log.constructor('return process.version')()` → `v24.16.0` = 本机任意代码执行。
 *
 * 修复：显式调 `globalThis.lockdown`（别名 `sesLockdown`）。修好后同样的表达式抛
 * `TypeError: Function.prototype.constructor is not a valid constructor`。
 *
 * 本测的断言分三组：
 *   1) lockdown 真的跑了（`Object.isFrozen(Object.prototype)`）—— 这条就是遮蔽 bug 的回归位；
 *   2) 六类 `.constructor` 逃逸向量全部打不通；
 *   3) **不误伤**：compartment 里正常的 endowment 调用、Math/Date、以及 protodef 的协议编译照旧可用。
 *
 * 注意：SES lockdown 是不可逆的全局操作，所以这个脚本必须独进程跑（unit_all 就是独进程）。
 * 输出：PASS <用例> / FAIL <用例> <实际>，全过退出码 0。
 */
import 'ses';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

// ── 0. 前置：lockdown 之前内建对象当然是可写的（否则下面第 1 组断言没有意义）──
check('前置：lockdown 前 Object.prototype 未冻结', !Object.isFrozen(Object.prototype));

// ── 1. 仓库的 lockdown() 必须真的把 SES lockdown 跑起来 ─────────────
const { lockdown, makeCompartment } = await import('../src/agent/library/lockdown.js');
lockdown();

check('lockdown() 真的执行了 SES lockdown（Object.prototype 已冻结）',
    Object.isFrozen(Object.prototype),
    `→ isFrozen=${Object.isFrozen(Object.prototype)}（false ⇒ 又回到了"自引用遮蔽"那个 bug）`);
check('lockdown() 幂等：再调一次不抛', (() => { try { lockdown(); return true; } catch { return false; } })());

// ── 2. 逃逸向量：全部必须打不通 ──────────────────────────────────
// 注入面与 coder.js:189-194 一致：宿主 skills / log / world / Vec3
const skills = await import('../src/agent/library/skills.js');
const { Vec3 } = await import('vec3');
const compartment = makeCompartment({
    skills,
    log: skills.log,
    world: { getBlock: () => null },
    Vec3,
});

const attempt = (expr) => {
    try { return { ok: true, value: compartment.evaluate(expr) }; }
    catch (e) { return { ok: false, error: e }; }
};
const blocked = (expr) => {
    const r = attempt(expr);
    return { r, blocked: !r.ok && /is not a valid constructor|SES_EVAL_REJECTED/.test(String(r.error?.message)) };
};

// 这些表达式的意思统一是「从注入的宿主对象拿到宿主 Function，再去摸宿主的 process」
const VECTORS = {
    'skills.log.constructor → typeof process': "skills.log.constructor('return typeof process')()",
    'skills.log.constructor → process.version': "skills.log.constructor('return process.version')()",
    'world.constructor.constructor → typeof process': "world.constructor.constructor('return typeof process')()",
    'Vec3.constructor → typeof process': "Vec3.constructor('return typeof process')()",
    'async 函数 constructor': "(async()=>{}).constructor('return typeof process')()",
    '生成器 constructor': "(function*(){}).constructor('return typeof process')()",
    '数组方法 constructor': "[].filter.constructor('return typeof process')()",
    '对象 constructor 链': "({}).constructor.constructor('return typeof process')()",
    'bind 后再取 constructor': "skills.log.bind(null).constructor('return typeof process')()",
};
for (const [label, expr] of Object.entries(VECTORS)) {
    const { r, blocked: isBlocked } = blocked(expr);
    check(`逃逸被挡：${label}`, isBlocked,
        isBlocked ? `→ ${r.error.message}` : `→ 逃逸成立！返回 ${JSON.stringify(r.value ?? r.error?.message)}`);
}

// 反例保护：不能靠"compartment 什么都干不了"来伪装成防住了
{
    const r = attempt('String(typeof skills)');
    check('不误伤：compartment 能正常看到 endowment', r.ok && r.value === 'object', `→ ${JSON.stringify(r.value ?? r.error?.message)}`);
}
{
    const r = attempt('Math.max(1,2) + new Date(0).getTime()');
    check('不误伤：Math/Date 仍可用', r.ok && r.value === 2, `→ ${JSON.stringify(r.value ?? r.error?.message)}`);
}
{
    const r = attempt("(function(){ return [1,2,3].map(x=>x*2).join(','); })()");
    check('不误伤：普通 JS 计算正常', r.ok && r.value === '2,4,6', `→ ${JSON.stringify(r.value ?? r.error?.message)}`);
}

// ── 3. evalTaming:'unsafeEval' 是硬依赖：真 lockdown 下 protodef 仍要能编译 ──
// （换成 safeEval 会 TypeError: reading 'i8' ⇒ bot 连不上服务器；详见 lockdown.js 注释）
{
    try {
        const { createSerializer, createDeserializer } = await import('minecraft-protocol/src/transforms/serializer.js');
        createSerializer({ state: 'play', isServer: true, version: '1.21.8' });
        createDeserializer({ state: 'play', isServer: false, version: '1.21.8' });
        check('不误伤：真 lockdown 下 protodef compiled 协议仍能编译', true);
    } catch (e) {
        check('不误伤：真 lockdown 下 protodef compiled 协议仍能编译', false, `→ ${e?.constructor?.name}: ${e?.message}`);
    }
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
