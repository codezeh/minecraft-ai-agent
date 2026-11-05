// t19 补充：任务点名的「返回值 / 宿主构造出来的对象」是否仍能长出宿主 Function。
// 运行：cd E:\我的世界ai && node docs/audit/probes/t19-ses-escape-returnvalues.mjs
// 说明：上一条探针里 `skills.checkItems(bot_stub())` 那条失败是**我的探针 bug**（bot_stub 是宿主侧
// 标识符，compartment 内不存在），不是修复无效。这里用「compartment 内自己 new 出来的宿主实例」重测。
import { lockdown, makeCompartment } from '../../../mindcraft/src/agent/library/lockdown.js';
import * as skills from '../../../mindcraft/src/agent/library/skills.js';
import * as world from '../../../mindcraft/src/agent/library/world.js';
import { pathToFileURL } from 'url';
const _v3 = await import(pathToFileURL('E:/我的世界ai/mindcraft/node_modules/vec3/index.js').href);
const Vec3 = _v3.Vec3 ?? _v3.default;

lockdown();
const comp = makeCompartment({ skills, log: skills.log, world, Vec3 });

const CASES = [
    // 宿主构造器 new 出来的实例（Vec3 是宿主类）
    ['new Vec3(...) 实例的 constructor 链', `new Vec3(1,2,3).constructor.constructor('return typeof process')()`],
    ['new Vec3 实例的原型链', `Object.getPrototypeOf(new Vec3(1,2,3)).constructor.constructor('return typeof process')()`],
    // 宿主函数返回的普通对象（就地造一个：用 skills 里不依赖 bot 的纯函数）
    ['skills.eyePosition 缺失时宿主返回对象的链', `(skills.readFileSafeProbe === undefined ? {ok:true} : skills.readFileSafeProbe).constructor.constructor('return typeof process')()`],
    // 宿主模块命名空间对象本身
    ['skills 命名空间对象 .constructor', `skills.constructor.constructor('return typeof process')()`],
    ['world 命名空间对象 .constructor', `world.constructor.constructor('return typeof process')()`],
    // 宿主数组/Map/Set（endowment 里没有，但宿主函数可能返回）
    ['宿主返回数组的情形（world.getNearbyEntities 缺 bot）', `typeof world.getNearbyEntities`],
    // 通过 Symbol / valueOf 等钩子
    ['Symbol.toPrimitive 链', `(new Vec3(1,2,3))[Symbol.toPrimitive] ? 'has-toPrimitive' : 'no'`],
    // 尝试用宿主实例的方法拿到它的 realm
    ['Vec3 实例方法 .add 的 constructor', `new Vec3(1,2,3).add.constructor('return typeof process')()`],
    ['skills.log.bind(...) 的 constructor', `skills.log.bind(null).constructor('return typeof process')()`],
    ['skills.log.apply 的 constructor', `skills.log.apply.constructor('return typeof process')()`],
    ['skills.log.call 的 constructor', `skills.log.call.constructor('return typeof process')()`],
];

let esc = 0, blk = 0, oth = 0;
for (const [name, expr] of CASES) {
    try {
        const r = comp.evaluate(expr);
        const s = String(r);
        if (/^object$|^function$|v2[0-9]\.|win32/.test(s)) { esc++; console.log(`ESCAPED  ${name} => ${s.slice(0,90)}`); }
        else { oth++; console.log(`probe    ${name} => ${s.slice(0,90)}`); }
    } catch (e) {
        blk++; console.log(`BLOCKED  ${name} => ${String(e?.message ?? e).slice(0,95)}`);
    }
}
console.log('');
console.log(`===== 汇总：BLOCKED=${blk} ESCAPED=${esc} 探测类=${oth} =====`);
