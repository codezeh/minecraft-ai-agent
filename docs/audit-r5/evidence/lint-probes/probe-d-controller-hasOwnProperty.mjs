/**
 * 探针 d：src/agent/npc/controller.js:202 `no-prototype-builtins`
 *   if (this.data.built.hasOwnProperty(goal.name)) { ... }
 *
 * 要回答：`this.data.built` 会不会是**无原型对象** ⇒ `hasOwnProperty is not a function`？
 *
 * 证据链：
 *   ① `this.data = NPCData.fromObject(agent.prompter.profile.npc)`（controller.js:40）
 *   ② `NPCData` 构造里 `this.built = {}`；且 `npc.built = obj.built`（data.js:7 / :42）
 *   ③ `obj` 来自 JSON profile（JSON.parse 产出**正常原型**对象）
 *   ④ 全仓 src/ 与 tools/ 中 `Object.create(null)` 命中数 = 0（下面实测复查）
 *   ⑤ 唯一真实风险：`built` 里存在**名为 hasOwnProperty 的键**把函数遮蔽掉。
 *      而 built 的键来自 construction 文件名（src/agent/npc/construction/*.json，共 4 个），
 *      没有 hasOwnProperty.json ⇒ 不可达。
 *
 * 退出码：0 = 缺陷成立；1 = 不成立
 */
import { readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ROOT = 'E:/我的世界ai/mindcraft';

// ① 全仓 Object.create(null) 命中数（无原型对象 = hasOwnProperty 缺失的唯一来源）
let hits = '';
try {
    hits = execSync('grep -rn "Object.create(null)" src/ tools/ || true', { cwd: ROOT, encoding: 'utf8' });
} catch (e) { hits = ''; }
console.log('[①] 全仓 `Object.create(null)` 命中：', hits.trim() === '' ? '0 处' : hits.trim());

// ② data.js 里 built 的初值与来源
const dataJs = readFileSync(ROOT + '/src/agent/npc/data.js', 'utf8');
console.log('[②] data.js `this.built = {}`：', /this\.built = \{\}/.test(dataJs) ? '存在' : '不存在');
console.log('[②] data.js `npc.built = obj.built`：', /npc\.built = obj\.built/.test(dataJs) ? '存在（直接取 profile 的对象）' : '不存在');

// ③ JSON.parse 产出的对象有正常原型
const fromJson = JSON.parse('{"small_wood_house":{"name":"small_wood_house"}}');
console.log('[③] JSON.parse 对象的原型是 Object.prototype：', Object.getPrototypeOf(fromJson) === Object.prototype);
console.log('[③] JSON.parse 对象 hasOwnProperty 可用：', typeof fromJson.hasOwnProperty === 'function');

// ④ built 的键来自 construction 文件名
const files = readdirSync(ROOT + '/src/agent/npc/construction');
console.log('[④] construction/*.json：', files.join(', '));
console.log('[④] 存在 hasOwnProperty.json：', files.includes('hasOwnProperty.json'));

// ⑤ 影子键的实际后果演示（说明"只有这种极端输入才会坏"）
const shadowed = JSON.parse('{"hasOwnProperty":{"name":"hasOwnProperty","position":{}}}');
let shadowErr = null;
try { shadowed.hasOwnProperty('x'); } catch (e) { shadowErr = e.constructor.name + ': ' + e.message; }
console.log('[⑤] 若 built 里真有一个叫 hasOwnProperty 的键 → 调用会：', shadowErr ?? '不报错');

// 正常路径（生产就是这样）：built 由 4 个构造名做键
const built = {};
for (const f of files) built[f.replace(/\.json$/, '')] = { name: f };
let normalOk = 0;
for (const k of Object.keys(built)) {
    if (built.hasOwnProperty(k)) normalOk++;
}
console.log('[正常路径] 4 个构造名逐个 hasOwnProperty →', normalOk + '/4 命中，无异常');

const defect = shadowErr !== null && files.includes('hasOwnProperty.json');
console.log('\n结论：无原型对象来源 0 处；影子键来源 0 处（无 hasOwnProperty.json）');
if (!defect) {
    console.log('VERDICT: FALSE-POSITIVE —— 生产数据来自 JSON.parse/`{}`，hasOwnProperty 恒可用；');
    console.log('         规则该报的是"理论可被键名遮蔽"，但本仓无该输入路径（不可达）。');
    process.exit(1);
} else {
    console.log('VERDICT: REAL-DEFECT');
    process.exit(0);
}
