/**
 * 第20条（R1 终审 §9 第 3 项）的回归测试 —— 「skills.js 与原子层给出同一个答案」。
 *
 * 这一条的核心不是"代码重复"，而是**同一个问题两处判据给出不同答案**：
 *   · isSafeHere：问它"周围安全吗"，它只数**最近的一只**敌对生物 ⇒ 10 只怪围上来也报 1；
 *   · canReach  ：阈值 4.3，而原子层（act_dig / query_perceive）是 5.1 ⇒ 4.8 格说"够不着"；
 *   · waitUntil ：谓词返回 false 算"还没好"，原子层算"已完成" ⇒ "等到超时"变成"立刻完成"。
 * 三处现在都是**薄包装**，判据只在原子层一份。所以本测试的写法是**比对**，不是背数字：
 * 同一个 bot、同一个局面，skills 侧和原子侧的答案必须完全相同，人把任一侧改回去就变红。
 *
 * 不需要服务器（假 bot）。用法：node tools/skills_atom_parity_unit.mjs
 * 输出：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import { readFileSync } from 'node:fs';
import Vec3 from 'vec3';

import * as skills from '../src/agent/library/skills.js';
import { isSafe as atomIsSafe, hostilesNear } from '../src/agent/library/query_safe.js';
import { canReach as atomDistanceReach, reachDistanceTo as atomReachDistanceTo } from '../src/agent/library/query_perceive.js';
import { waitUntil as atomWaitUntil } from '../src/agent/library/atom_wait.js';
import { digReach } from '../src/agent/rules/rules.runtime.js';

let pass = 0, fail = 0;
const okCase = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const badCase = (n, actual) => { fail++; console.log(`FAIL ${n} ${actual}`); };

/** 最小假 bot：坐标、实体表、方块表都是死的 —— 只让被测函数读得到东西。 */
function makeBot({ entities = {}, eyeHeight = 1.62, position = new Vec3(0.5, 64, 0.5) } = {}) {
    return {
        username: 'unit_atom_parity',
        entity: { position, eyeHeight },
        entities,
        registry: { blocksByName: { lava: { id: 51 }, fire: { id: 52 } } },
        // 世界全空：危险/液体都数 0，这样"安不安全"只由敌对生物决定，用来隔离被测判据
        blockAt: () => null,
        findBlocks: () => [],
        nearestEntity: (pred) => Object.values(entities).find((e) => pred(e)) ?? null,
        inventory: { slots: [], items: () => [], emptySlotCount: () => 20, findInventoryItem: () => null },
        game: { dimension: 'overworld', gameMode: 'survival' },
        modes: { isOn: () => false, pause: () => { }, unpause: () => { } },
        output: '',
    };
}

// ── 1. isSafeHere 数**全部**敌对生物，且与 query_safe.hostilesNear 同一个答案 ──────
{
    // 10 只僵尸：半径 12 内 4800 格的三维网格里铺开，彼此都算"附近"
    const entities = {};
    for (let i = 0; i < 10; i++) {
        entities[`z${i}`] = { name: 'zombie', isValid: true, position: new Vec3(i, 64, 0) };
    }
    const bot = makeBot({ entities });
    let r = null, threw = null;
    try { r = await skills.isSafeHere(bot); } catch (e) { threw = e; }
    const atom = atomIsSafe(bot, { kind: 'point', pos: { x: 0, y: 64, z: 0 } });
    const atomHostiles = atom.ok ? atom.data.hostiles : null;
    const shared = hostilesNear(bot, { x: 0, y: 64, z: 0 }, { radius: 12 }).count;

    if (!threw && r?.hostiles === 10 && atomHostiles === 10 && shared === 10) {
        okCase('isSafeHere 数全部敌对生物（10 只 ⇒ hostiles=10，与 isSafe 同源）',
            `skills=${r.hostiles} atom=${atomHostiles} hostilesNear=${shared}`);
    } else {
        badCase('isSafeHere 应报 10 只（改前只报 1 只）',
            `skills=${r?.hostiles} atom=${atomHostiles} hostilesNear=${shared}${threw ? ' 抛错=' + threw.message : ''}`);
    }
    // 而且两边对"安不安全"的结论也必须一致（同一批怪，同一半径）
    if (!threw && atom.ok && r?.safe === atom.data.safe) {
        okCase('isSafeHere 与 isSafe 的 safe 结论一致', `safe=${r.safe}/${atom.data.safe}`);
    } else {
        badCase('safe 结论应一致', `skills=${r?.safe} atom=${atom.data?.safe}`);
    }
}

// ── 2. 0 只敌对生物时两边都说安全（确认第 1 条不是"永远报危险"）──────────────
{
    const bot = makeBot({ entities: {} });
    const r = await skills.isSafeHere(bot);
    const atom = atomIsSafe(bot, { kind: 'point', pos: { x: 0, y: 64, z: 0 } });
    if (r.hostiles === 0 && r.safe === true && atom.ok && atom.data.hostiles === 0 && atom.data.safe === true) {
        okCase('空场地：两边 hostiles=0 且 safe=true', `safe=${r.safe}/${atom.data.safe}`);
    } else {
        badCase('空场地两边都该说安全', `skills hostiles=${r.hostiles} safe=${r.safe} atom=${JSON.stringify(atom.data)}`);
    }
}

// ── 3. canReach 的阈值与原子层同源（5.1，不再是旧值）─────────────────────────
{
    // 眼睛在 y=64+1.62=65.62；方块中心 = (x+0.5, y+0.5, z+0.5)。
    // 同层方块（y=64）时 dy=1.12，所以水平偏移决定距离：
    //   (4,2) → 4.61 格（落在旧阈值 4.3 ~ 原子层 5.1 之间 ← 正是分叉带）
    //   (5,0) → 5.12 格（超过 5.1）
    //   (4,1) → 4.27 格（低于旧阈值，两边都说够得着）
    const bot = makeBot({ position: new Vec3(0.5, 64, 0.5) });
    const cfg = [{ x: 4, z: 2 }, { x: 5, z: 0 }, { x: 4, z: 1 }];
    let allSame = true;
    const detail = [];
    for (const c of cfg) {
        const pos = { x: c.x, y: 64, z: c.z };
        const d = atomReachDistanceTo(bot, pos);
        const bySkill = skills.canReach(bot, pos);
        // 同源判据：距离 ≤ digReach()（规则层 5.1）。阈值不许是别的数。
        const expect = d <= digReach();
        const expectOld = d <= 4.3;
        detail.push(`(${c.x},${c.z}) d=${d.toFixed(2)} skills=${bySkill} 期望(5.1)=${expect} 旧阈值=${expectOld}`);
        if (bySkill !== expect) allSame = false;
    }
    if (allSame) {
        okCase('canReach 与 digReach()（5.1）同源', detail.join(' | '));
    } else {
        badCase('canReach 应等于 d <= digReach()', detail.join(' | '));
    }

    // 关键一条：4.3~5.1 之间的方块，旧实现说"够不着"，新实现说"够得着"
    const pos = { x: 4, y: 64, z: 2 };
    const d = atomReachDistanceTo(bot, pos);
    if (d > 4.3 && d <= digReach() && skills.canReach(bot, pos) === true) {
        okCase('分叉带内的方块判"够得着"（改前判够不着）', `d=${d.toFixed(2)} 阈值=${digReach()}`);
    } else {
        badCase('分叉带内应判够得着', `d=${d.toFixed(2)} 阈值=${digReach()} 实际=${skills.canReach(bot, pos)}`);
    }

    // 阈值只有一个来源：传 max 时应覆盖，不传时不许出现第二份常量
    if (skills.canReach(bot, pos, 3) === false && skills.canReach(bot, pos, 9) === true) {
        okCase('canReach 的 max 参数仍可覆盖（薄包装不掉能力）', 'max=3→false, max=9→true');
    } else {
        badCase('max 覆盖失效', `max3=${skills.canReach(bot, pos, 3)} max9=${skills.canReach(bot, pos, 9)}`);
    }
}

// ── 4. canReach 的距离与原子层 query_perceive.reachDistanceTo 完全一致 ─────────
{
    const bot = makeBot({ position: new Vec3(0.5, 64, 0.5) });
    const probes = [{ x: 3, y: 64, z: 2 }, { x: -6, y: 66, z: 5 }, { x: 0, y: 60, z: -9 }];
    let same = true;
    const detail = [];
    for (const p of probes) {
        const a = Number(skills.reachDistanceTo(bot, p).toFixed(6));
        const b = Number(atomReachDistanceTo(bot, p).toFixed(6));
        detail.push(`${JSON.stringify(p)}=${a}`);
        if (a !== b) same = false;
    }
    if (same) okCase('reachDistanceTo 与原子层同一份计算', detail.join(' '));
    else badCase('reachDistanceTo 与原子层不一致', detail.join(' '));
}

// ── 5. waitUntil：false 算"已完成"，与原子层判定完全一致 ──────────────────────
{
    const bot = makeBot();

    // 5a. 谓词立即返回 false ⇒ 原子语义是"完成"，value=false。skills 版必须同答案。
    const s1 = await skills.waitUntil(bot, () => false, { timeoutMs: 200, intervalMs: 10, label: 'x' });
    const a1 = await atomWaitUntil(() => false, { timeoutMs: 200, intervalMs: 10 });
    if (s1.ok === true && s1.value === false && a1.ok === true && a1.data.value === false) {
        okCase('waitUntil：false 立即完成（改前会一直等到超时）',
            `skills ok=${s1.ok} value=${s1.value} / atom ok=${a1.ok} value=${a1.data.value}`);
    } else {
        badCase('waitUntil 对 false 的判定应与原子层一致',
            `skills=${JSON.stringify(s1)} atom=${JSON.stringify(a1)}`);
    }

    // 5b. 谓词返回 undefined ⇒ 继续等直到超时，两边都是 TIMEOUT/timeout
    const t0 = Date.now();
    const s2 = await skills.waitUntil(bot, () => undefined, { timeoutMs: 60, intervalMs: 10, label: 'x' });
    const s2ms = Date.now() - t0;
    const a2 = await atomWaitUntil(() => undefined, { timeoutMs: 60, intervalMs: 10 });
    if (s2.ok === false && s2.reason === 'timeout' && a2.ok === false && a2.code === 'TIMEOUT' && s2ms >= 40) {
        okCase('waitUntil：undefined 等到超时', `skills ok=${s2.ok} reason=${s2.reason} ${s2ms}ms / atom code=${a2.code}`);
    } else {
        badCase('waitUntil undefined 应超时', `skills=${JSON.stringify(s2)} atom=${JSON.stringify(a2)}`);
    }

    // 5c. 谓词先 undefined 后给值 ⇒ 拿到那个值（0 / '' 也算完成，与原子层同）
    let n = 0;
    const s3 = await skills.waitUntil(bot, () => (++n >= 3 ? 0 : undefined), { timeoutMs: 500, intervalMs: 5, label: 'x' });
    if (s3.ok === true && s3.value === 0 && n === 3) {
        okCase('waitUntil：0 也算完成值，且只在第 3 次轮询拿到', `ok=${s3.ok} value=${s3.value} 轮询=${n} 次`);
    } else {
        badCase('waitUntil 应在第 3 次轮询返回 0', JSON.stringify({ ...s3, n }));
    }

    // 5d. 中断：bot.interrupt_code ⇒ ok:false / interrupted（原子层 INTERRUPTED）
    const ib = makeBot();
    let k = 0;
    const s4 = await skills.waitUntil(ib, () => { ib.interrupt_code = ++k >= 2; return undefined; },
        { timeoutMs: 500, intervalMs: 5, label: 'x' });
    if (s4.ok === false && s4.reason === 'interrupted') {
        okCase('waitUntil：interrupt_code ⇒ reason=interrupted', `reason=${s4.reason}`);
    } else {
        badCase('中断应返回 reason=interrupted', JSON.stringify(s4));
    }

    // 5e. 内部调用方已按原子语义改写（结构断言，防止"等熔炼"退回立刻返回 true）
    const src = readFileSync(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
    const smeltOk = /waitUntil\(bot, \(\) => !!furnace\.outputItem\(\) \|\| undefined/.test(src);
    const giveOk = /waitUntil\(bot, \(\) => given \|\| undefined/.test(src);
    const legacy = /waitUntil\(bot, \(\) => !!furnace\.outputItem\(\),/.test(src) || /waitUntil\(bot, \(\) => given,/.test(src);
    if (smeltOk && giveOk && !legacy) {
        okCase('waitForSmelt / giveToPlayer 的谓词已改成原子语义', 'cond || undefined');
    } else {
        badCase('内部谓词仍是旧语义', `smelt=${smeltOk} give=${giveOk} 旧写法仍在=${legacy}`);
    }
}

// ── 6. 结构断言：skills.js 里不许再出现 4.3 这个阈值 ────────────────────────
{
    const src = readFileSync(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
    const hits = (src.match(/4\.3/g) || []).length;
    if (hits === 0) okCase('skills.js 里没有硬编码 4.3', 'grep 4.3 → 0 处');
    else badCase('skills.js 仍出现 4.3', `${hits} 处`);
    // 且 canReach 默认阈值来自规则层（digReach），不是字面量
    if (/canReach\(bot, pos, max = digReach\(\)\)/.test(src)) {
        okCase('canReach 默认阈值取自 digReach()', 'max = digReach()');
    } else {
        badCase('canReach 默认阈值不是 digReach()', '没找到 max = digReach()');
    }
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
