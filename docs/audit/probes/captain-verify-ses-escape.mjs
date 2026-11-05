// 队长复现探针：验证 SES Compartment 注入宿主对象后能否拿回宿主 realm
import { lockdown, makeCompartment } from 'file:///E:/我的世界ai/mindcraft/src/agent/library/lockdown.js';

lockdown();

// 模拟 coder.js:189-194 的注入方式：把宿主的 skills/world 当 endowment
const hostSkills = { log: (b, m) => console.log(m), mine: async () => ({ ok: true }) };
const hostWorld = { getInventoryCounts: () => ({}) };

const c = makeCompartment({ skills: hostSkills, world: hostWorld, Vec3: class {} });

const tests = [
  ["compartment 内部 new Function('return typeof process')()", () => c.evaluate("new Function('return typeof process')()")],
  ["skills.log.constructor('return typeof process')()", () => c.evaluate("skills.log.constructor('return typeof process')()")],
  ["world.constructor.constructor('return typeof require')()", () => c.evaluate("world.constructor.constructor('return typeof require')()")],
  ["skills.constructor.constructor('return typeof process')()", () => c.evaluate("skills.constructor.constructor('return typeof process')()")],
];
for (const [name, fn] of tests) {
  let r; try { r = fn(); } catch (e) { r = 'THREW: ' + e.message; }
  console.log(String(r).padEnd(60), '<-', name);
}
