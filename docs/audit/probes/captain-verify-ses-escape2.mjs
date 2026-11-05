import { lockdown, makeCompartment } from 'file:///E:/我的世界ai/mindcraft/src/agent/library/lockdown.js';
lockdown();
const hostSkills = { log: (b, m) => {}, mine: async () => ({}) };
const c = makeCompartment({ skills: hostSkills });
const H = "skills.log.constructor";   // 宿主 Function 构造器（已证实）
const probes = [
  ["宿主 process.version",            `${H}('return process.version')()`],
  ["宿主 process.platform",           `${H}('return process.platform')()`],
  ["宿主 process.mainModule 是否存在", `${H}('return typeof process.mainModule')()`],
  ["宿主 globalThis 上有没有 require", `${H}('return typeof globalThis.require')()`],
  ["能否取到 fs 模块（ESM 动态 import 的同步替代）", `${H}('return typeof process.binding')()`],
];
for (const [label, expr] of probes) {
  let r; try { r = c.evaluate(expr); } catch (e) { r = 'THREW: ' + e.message; }
  console.log(String(r).padEnd(40), '<-', label);
}
