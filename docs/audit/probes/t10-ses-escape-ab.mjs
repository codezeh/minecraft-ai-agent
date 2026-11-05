/**
 * 第1条 ④ 证据之二：逃逸在「真 lockdown」与「无 lockdown」下的 A/B。
 *
 * 注入面照抄 `mindcraft/src/agent/coder.js` 的 `makeCompartment({ skills, log, world, Vec3 })`。
 *
 * 用法：node docs/audit/probes/t10-ses-escape-ab.mjs real
 *       node docs/audit/probes/t10-ses-escape-ab.mjs off
 * 判读：
 *   - off  → `skills.log.constructor('return process.version')()` 返回 `v24.16.0`（= 本机 RCE）
 *   - real → 同一表达式抛 `TypeError: Function.prototype.constructor is not a valid constructor`
 * ⇒ 逃逸的真原因是 lockdown.js 的自引用遮蔽 bug（SES 的 lockdown 从未跑），
 *   不是 SES 本身设计不住。回归护栏：mindcraft/tools/ses_escape_unit.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MINDCRAFT = path.resolve(__dirname, '../../../mindcraft');
const load = (rel) => import(pathToFileURL(path.join(MINDCRAFT, rel)).href);

// node_modules 在 mindcraft/ 下，裸包名导不到 ses（见 t10-lockdown-shadow-bug.mjs 的说明）
await load('node_modules/ses/index.js');

const mode = process.argv[2] === 'real' ? 'real' : 'off';
if (mode === 'real') {
    globalThis.lockdown({
        localeTaming: 'unsafe', consoleTaming: 'unsafe', errorTaming: 'unsafe',
        stackFiltering: 'verbose', evalTaming: 'unsafeEval',
    });
    console.log('[probe] SES lockdown = 真跑了；Object.prototype 冻结 =', Object.isFrozen(Object.prototype));
} else {
    console.log('[probe] SES lockdown = 没跑（= 修复前仓库的实际状态）');
}

const Compartment = globalThis.Compartment;
const skills = await load('src/agent/library/skills.js');
const { Vec3 } = await load('node_modules/vec3/index.js');
const c = new Compartment({ Math, Date, skills, log: skills.log, world: { getBlock: () => null }, Vec3 });

const t = (label, expr) => {
    let out;
    try { out = JSON.stringify(c.evaluate(expr)); } catch (e) { out = `THROW ${e?.constructor?.name}: ${e?.message}`; }
    console.log(`[probe] ${label} → ${out}`);
};
t('自带 Function', "new Function('return typeof process')()");
t('skills.log.constructor → typeof process', "skills.log.constructor('return typeof process')()");
t('skills.log.constructor → process.version', "skills.log.constructor('return process.version')()");
t('world.constructor.constructor → typeof process', "world.constructor.constructor('return typeof process')()");
t('Vec3.constructor → typeof process', "Vec3.constructor('return typeof process')()");
t('async 函数 constructor', "(async()=>{}).constructor('return typeof process')()");
t('数组方法 constructor', "[].filter.constructor('return typeof process')()");
