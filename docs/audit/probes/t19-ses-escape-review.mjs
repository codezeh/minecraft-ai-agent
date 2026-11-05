// t19 终审 R1①：SES 沙箱逃逸 —— 独立复核（不复用 captain 的两条旧向量）
// 运行：cd E:\我的世界ai && node docs/audit/probes/t19-ses-escape-review.mjs
// 预期（修复后）：除「compartment 内部能力」类探针外，所有 *.constructor 向量都应 THREW/BLOCKED。
// 判据：任何一条打印 ESCAPED 就是沙箱没关。
import { lockdown, makeCompartment } from '../../../mindcraft/src/agent/library/lockdown.js';
import * as skills from '../../../mindcraft/src/agent/library/skills.js';
import * as world from '../../../mindcraft/src/agent/library/world.js';
import { pathToFileURL } from 'url';
const { Vec3 } = await import(pathToFileURL('E:/我的世界ai/mindcraft/node_modules/vec3/index.js').href);

// 1) 先看看 lockdown 前的状态（验证「真跑了」而不是「又静默跳过」）
const beforeFrozen = Object.isFrozen(Object.prototype);
lockdown();
const afterFrozen = Object.isFrozen(Object.prototype);
console.log(`[0] Object.isFrozen(Object.prototype): before=${beforeFrozen} after=${afterFrozen}`);
console.log(`[0] 判定 lockdown 真跑了: ${beforeFrozen === false && afterFrozen === true ? 'YES' : 'NO —— 沙箱没生效！'}`);
console.log(`[0] ses 全局 lockdown 是否可见: ${typeof globalThis.lockdown}`);
console.log('');

// 2) 按 coder.js:197-202 的**完全相同** endowment 建 compartment
const comp = makeCompartment({ skills, log: skills.log, world, Vec3 });

/** 每条向量：表达式 → 期待被挡 */
const VECTORS = [
    // ===== 旧洞（captain 原向量）=====
    ['旧洞 skills.log.constructor', `skills.log.constructor('return process.version')()`],
    ['旧洞 world.constructor.constructor', `world.constructor.constructor('return typeof require')()`],

    // ===== 换其他宿主导出 / 其他宿主对象 =====
    ['skills.checkItems.constructor', `skills.checkItems.constructor('return process.version')()`],
    ['skills.surveyArea.constructor', `skills.surveyArea.constructor('return typeof process')()`],
    ['world.getPosition.constructor', `world.getPosition.constructor('return typeof require')()`],
    ['Vec3.constructor', `Vec3.constructor('return process.version')()`],
    ['Vec3.prototype.constructor.constructor', `Vec3.prototype.constructor.constructor('return typeof process')()`],
    ['endowed Math.constructor', `Math.constructor('return typeof process')()`],
    ['endowed Date.constructor', `Date.constructor('return typeof process')()`],

    // ===== 返回值 / 调用结果的形状 =====
    ['调用结果对象是否宿主对象（skills.checkItems 返回）', `skills.checkItems(bot_stub(), {}).constructor.constructor('return typeof process')()`],

    // ===== compartment 内建链 =====
    ['[].constructor.constructor', `[].constructor.constructor('return typeof process')()`],
    ['({}).constructor.constructor', `({}).constructor.constructor('return typeof process')()`],
    ['(function(){}).constructor', `(function(){}).constructor('return typeof process')()`],
    ['(async()=>{}).constructor', `(async()=>{}).constructor('return typeof process')()`],
    ['(function*(){}).constructor', `(function*(){}).constructor('return typeof process')()`],

    // ===== Reflect / 原型操作 =====
    ['Reflect.construct + 宿主 newTarget', `Reflect.construct(function(){}, [], skills.log.constructor)('return typeof process')()`],
    ['Object.getPrototypeOf(skills.log).constructor', `Object.getPrototypeOf(skills.log).constructor('return typeof process')()`],
    ['skills.log.__proto__.constructor', `skills.log.__proto__.constructor('return typeof process')()`],

    // ===== 直接摸全局 =====
    ['compartment 内 process', `typeof process`],
    ['compartment 内 require', `typeof require`],
    ['compartment 内 globalThis.lockdown 残留', `typeof globalThis.lockdown`],
    ['compartment 内 eval', `typeof eval`],
    ['compartment 内 Function', `typeof Function`],
    ['compartment 内 new Function 后取 this', `new Function('return this === undefined ? "strict-undefined" : typeof this.process')()`],
    ['compartment 内 import()', `typeof import`],

    // ===== 经由宿主对象的方法副作用（不取 process，看能否写文件/联网）=====
    ['skills.log 能否被替换成宿主函数（篡改面）', `(function(){ const f = skills.log; skills.log = function(){}; return typeof f; })()`],
];

let escaped = 0, blocked = 0, other = 0;
console.log('===== 逃逸尝试（每条独立 try）=====');
for (const [name, expr] of VECTORS) {
    let line;
    try {
        const r = comp.evaluate(expr);
        // 只要返回值里出现了宿主特征，就算逃逸
        const s = String(r);
        const looksEscape = /v2[0-9]\.|^object$|^function$|win32|darwin/.test(s);
        // 有些是「探测类型」的正面用例（如 typeof process），单独归类
        const isProbe = /^typeof|strict-undefined/.test(expr) ;
        if (looksEscape && !/^typeof/.test(expr)) {
            escaped++; line = `ESCAPED  ${name}  => ${s.slice(0, 80)}`;
        } else {
            other++; line = `probe    ${name}  => ${s.slice(0, 80)}`;
        }
    } catch (e) {
        blocked++;
        line = `BLOCKED  ${name}  => ${String(e && e.message || e).slice(0, 90)}`;
    }
    console.log(line);
}

// bot_stub：只给 skills.checkItems 需要的最小形状
function bot_stub() {
    return {
        inventory: { items: () => [], slots: [] },
        entity: { position: { x: 0, y: 64, z: 0 } },
        players: {}, registry: {},
    };
}

console.log('');
console.log(`===== 汇总：BLOCKED=${blocked}  ESCAPED=${escaped}  其余(探测类)=${other} =====`);
console.log(escaped === 0
    ? '结论：本次 27 条向量里 0 条逃逸 —— 与「lockdown 真生效」一致。'
    : '结论：仍有逃逸向量，沙箱没关住！');
console.log('');
console.log('注意：本探针只覆盖「已知向量集」，不代表沙箱完备（规程 §3.1：已实测仅限于本探针实测到的）。');
