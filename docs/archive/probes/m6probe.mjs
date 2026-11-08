/**
 * t14 契约核对：11 个 act_* 动作。
 *
 * 1) 静态：函数体内每个 `return` 都必须是 ok(...)/fail(...)/内层 await 结果，不许裸 boolean / 对象字面量
 * 2) 静态：fail('CODE' ...) 的 CODE 全部在 CODES 里
 * 3) 动态：用"敌对 stub"（没背包/没窗口/没 registry）调用每个动作，返回必须
 *    (a) 是 Object.isFrozen 的 ActionResult (b) ok 是 boolean (c) code 是字符串且在 CODES ∪ {OK}
 *    (d) 不许抛异常
 */
import { CODES } from '../mindcraft/src/agent/library/contract.js';
import { readFileSync } from 'node:fs';

const BASE = '../mindcraft/src/agent/library/';
const LEGAL = new Set([...CODES, 'OK']);

const ACTIONS = [
    ['craftOnce', 'act_craft.js'], ['furnaceLoad', 'act_craft.js'], ['furnaceCollect', 'act_craft.js'],
    ['harvestCrop', 'act_farm.js'], ['plantSeed', 'act_farm.js'], ['tillSoil', 'act_farm.js'],
    ['eat', 'act_items.js'], ['equip', 'act_items.js'],
    ['deposit', 'act_container.js'], ['withdraw', 'act_container.js'],
    ['attackOnce', 'act_attack.js'],
];

/** 从源码里抠出一个具名函数的函数体（按花括号配平，够用）。 */
function fnBody(src, name) {
    const re = new RegExp(`export\\s+async\\s+function\\s+${name}\\s*\\(`);
    const m = src.match(re);
    if (!m) return null;
    let i = src.indexOf('{', m.index);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
    }
    return null;
}

console.log('=== 静态检查：return 形式 + fail 码 ===');
let staticBad = 0;
const allCodes = new Map();
for (const [name, file] of ACTIONS) {
    const src = readFileSync(BASE + file, 'utf8');
    const body = fnBody(src, name);
    if (!body) { console.log(`  ❌ ${name}: 取不到函数体`); staticBad++; continue; }

    // return 语句形态
    const returns = [...body.matchAll(/return\s+([^;]+);/g)].map((m) => m[1].trim());
    const bad = returns.filter((r) => !/^(ok|fail)\s*\(/.test(r) && !/^(await\s+)?[a-zA-Z_$][\w$.]*\s*\(/.test(r));
    // fail('CODE' / fail("CODE"
    const codes = [...body.matchAll(/fail\(\s*['"]([A-Z_]+)['"]/g)].map((m) => m[1]);
    codes.forEach((c) => allCodes.set(c, (allCodes.get(c) ?? 0) + 1));
    const illegal = codes.filter((c) => !LEGAL.has(c));

    const flag = (bad.length || illegal.length) ? '❌' : '✅';
    if (bad.length || illegal.length) staticBad++;
    console.log(`  ${flag} ${name.padEnd(15)} return ${returns.length} 处 | fail 码 [${[...new Set(codes)].join(',')}]`
        + (bad.length ? `  ⚠ 可疑 return: ${bad.join(' / ').slice(0, 120)}` : '')
        + (illegal.length ? `  ❌ 未注册码: ${illegal.join(',')}` : ''));
}
console.log(`\n全部动作用到的码: ${[...allCodes.keys()].sort().join(' ')}`);
console.log(`CODES 里共有 ${CODES.length} 个码；上面全部合法: ${[...allCodes.keys()].every((c) => LEGAL.has(c)) ? '✅' : '❌'}`);

// ── 动态：敌对 stub ────────────────────────────────────────────────
console.log('\n=== 动态检查：敌对 stub 下必须返回冻结的 ActionResult ===');
const hostileBot = {
    username: 'probe',
    entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 999, offset: () => ({ x: 0, y: 64, z: 0 }) } },
    inventory: { items: () => [], slots: [], emptySlotCount: () => 0 },
    registry: { blocksByName: {}, itemsByName: {}, foodsByName: {} },
    currentWindow: null,
    blockAt: () => null,
    findBlock: () => null,
    nearestEntity: () => null,
    entities: {},
    players: {},
    equip: async () => { throw new Error('stub: equip'); },
    // 故意不给 dig/placeBlock/attack/clickWindow/lookAt → 动作必须优雅 fail，不许崩
};

const modCache = new Map();
async function loadMod(file) {
    if (!modCache.has(file)) modCache.set(file, await import(BASE + file));
    return modCache.get(file);
}

let dynBad = 0;
for (const [name, file] of ACTIONS) {
    let out;
    try {
        const mod = await loadMod(file);
        const fn = mod[name];
        if (typeof fn !== 'function') { console.log(`  ❌ ${name}: 不是函数`); dynBad++; continue; }
        out = await fn(hostileBot, {}, {});
    } catch (e) {
        console.log(`  ❌ ${name}: 抛异常 → ${String(e?.message ?? e).slice(0, 80)}`);
        dynBad++;
        continue;
    }
    const isObj = out && typeof out === 'object';
    const frozen = isObj && Object.isFrozen(out);
    const okBool = isObj && typeof out.ok === 'boolean';
    const codeOk = isObj && typeof out.code === 'string' && LEGAL.has(out.code);
    const bare = typeof out === 'boolean' || !isObj;
    const flag = (!bare && frozen && okBool && codeOk) ? '✅' : '❌';
    if (flag === '❌') dynBad++;
    console.log(`  ${flag} ${name.padEnd(15)} ok=${isObj ? out.ok : out} code=${isObj ? out.code : '-'} frozen=${frozen} bare=${bare}`);
}
console.log(`\n静态可疑 ${staticBad} 处 | 动态不合格 ${dynBad} 处`);
