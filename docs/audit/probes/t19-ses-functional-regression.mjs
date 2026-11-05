// t19：功能性回归检查 —— lockdown 之后，模型代码还能不能用 endowment 里的宿主类/函数。
// 若 `new Vec3()` 抛，任何用 Vec3 的模型代码都会坏（这是"修出新问题"的嫌疑点）。
// 运行：cd E:\我的世界ai && node docs/audit/probes/t19-ses-functional-regression.mjs
import { lockdown, makeCompartment } from '../../../mindcraft/src/agent/library/lockdown.js';
import * as skills from '../../../mindcraft/src/agent/library/skills.js';
import * as world from '../../../mindcraft/src/agent/library/world.js';
import { pathToFileURL } from 'url';
const _v3 = await import(pathToFileURL('E:/我的世界ai/mindcraft/node_modules/vec3/index.js').href);
const Vec3 = _v3.Vec3 ?? _v3.default;

lockdown();
const comp = makeCompartment({ skills, log: skills.log, world, Vec3 });

const CASES = [
    ['typeof Vec3', `typeof Vec3`],
    ['new Vec3(1,2,3)', `String(new Vec3(1,2,3))`],
    ['Vec3(1,2,3) 无 new', `String(Vec3(1,2,3))`],
    ['new Vec3 的 .x', `new Vec3(1,2,3).x`],
    ['new Vec3 的 .distanceTo', `new Vec3(1,2,3).distanceTo(new Vec3(0,0,0))`],
    ['typeof skills.log', `typeof skills.log`],
    ['调用 skills.log（宿主函数，会 console.log）', `(skills.log({}, 'hello-from-compartment'), 'called-ok')`],
    ['typeof world.getPosition', `typeof world.getPosition`],
    ['宿主普通对象字面量', `({ok:true}).ok`],
    ['new Map / new Set', `[new Map().size, new Set().size].join(',')`],
    ['JSON 往返', `JSON.stringify({a:1})`],
    ['Math.max', `Math.max(1,2,3)`],
    ['Date.now 形状', `typeof Date.now()`],
];

for (const [name, expr] of CASES) {
    try {
        const r = comp.evaluate(expr);
        console.log(`OK       ${name} => ${String(r).slice(0, 70)}`);
    } catch (e) {
        console.log(`THROWS   ${name} => ${String(e?.message ?? e).slice(0, 95)}`);
    }
}
