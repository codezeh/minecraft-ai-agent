/**
 * 第20条「改前 vs 改后」对照探针（只在 tmp/ 里跑，不进 git）。
 *
 * 左边 = HEAD 的 skills.js（改前），右边 = 工作区的 skills.js（改后）。
 * 同一个假 bot、同一个局面，各问一次同样的问题，把两个答案并排打出来。
 */
import Vec3 from 'vec3';

const OLD = './src/agent/library/skills.js';          // tmp/baseline20/src/... ← HEAD 版本
const NEW = '../../src/agent/library/skills.js';      // 工作区版本
const oldSkills = await import(OLD);
const newSkills = await import(NEW);

function makeBot({ entities = {} } = {}) {
    return {
        username: 'probe20',
        entity: { position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62 },
        entities,
        registry: { blocksByName: { lava: { id: 51 }, fire: { id: 52 } } },
        blockAt: () => null,
        findBlocks: () => [],
        nearestEntity: (pred) => Object.values(entities).find((e) => pred(e)) ?? null,
        inventory: { slots: [], items: () => [], emptySlotCount: () => 20, findInventoryItem: () => null },
        game: { dimension: 'overworld', gameMode: 'survival' },
        modes: { isOn: () => false, pause: () => { }, unpause: () => { } },
        output: '',
    };
}

const line = (k, v) => console.log(`  ${k.padEnd(28)} ${v}`);

// ── 1. isSafeHere：10 只僵尸围上来 ─────────────────────────────────────────────
console.log('\n[1] isSafeHere：半径 12 内 10 只僵尸');
{
    const entities = {};
    for (let i = 0; i < 10; i++) entities[`z${i}`] = { name: 'zombie', type: 'mob', isValid: true, position: new Vec3(i, 64, 0) };
    const bot = makeBot({ entities });
    const before = await oldSkills.isSafeHere(bot);
    const after = await newSkills.isSafeHere(bot);
    line('改前 hostiles', `${before.hostiles}  ← 只数最近的一只`);
    line('改后 hostiles', `${after.hostiles}  ← 全数（同 hostilesNear）`);
    line('改前 reason', JSON.stringify(before.reasons));
    line('改后 reason', JSON.stringify(after.reasons));
}

// ── 2. canReach：4.61 格的方块（落在 4.3 ~ 5.1 之间）──────────────────────────
console.log('\n[2] canReach：眼睛到方块中心 4.61 格（同一层，水平偏 (4,2)）');
{
    const bot = makeBot();
    const pos = { x: 4, y: 64, z: 2 };
    const d = newSkills.reachDistanceTo(bot, pos);   // 改前改后这个函数算的是同一件事
    line('眼睛到方块中心', `${d.toFixed(2)} 格`);
    line('改前 canReach', `${oldSkills.canReach(bot, pos)}  ← 阈值 4.3`);
    line('改后 canReach', `${newSkills.canReach(bot, pos)}  ← 阈值 digReach()=5.1`);
    line('act_dig 判据(5.1)', `${d <= 5.1}`);
}

// ── 3. waitUntil：谓词返回 false（"还没好"还是"已完成"？）────────────────────
console.log('\n[3] waitUntil：谓词恒返回 false，超时 200ms');
{
    const bot = makeBot();
    const t0 = Date.now();
    const before = await oldSkills.waitUntil(bot, () => false, { timeoutMs: 200, intervalMs: 20, label: 'probe' });
    const beforeMs = Date.now() - t0;
    const t1 = Date.now();
    const after = await newSkills.waitUntil(bot, () => false, { timeoutMs: 200, intervalMs: 20, label: 'probe' });
    const afterMs = Date.now() - t1;
    line('改前', `ok=${before.ok} reason=${before.reason} 耗时=${beforeMs}ms（等到超时）`);
    line('改后', `ok=${after.ok} value=${after.value} reason=${after.reason} 耗时=${afterMs}ms（false 即完成）`);
    line('原子层同一谓词', `ok=${(await (await import('../../src/agent/library/atom_wait.js')).waitUntil(() => false, { timeoutMs: 200 })).ok}（同改后）`);
}

// ── 4. waitUntil 在内部调用方上的后果（waitForSmelt 的谓词形态）───────────────
console.log('\n[4] 内部调用方：waitForSmelt 的谓词 `() => !!furnace.outputItem()`，产物还没出');
{
    const bot = makeBot();
    // 改前：skills.waitUntil 在 false 时继续等 ⇒ 等满超时才返回 ok:false
    const t0 = Date.now();
    const before = await oldSkills.waitUntil(bot, () => false || undefined, { timeoutMs: 150, intervalMs: 20 });
    const beforeMs = Date.now() - t0;
    // 改后：谓词已改成 `... || undefined`，行为不变（等满超时）
    const t1 = Date.now();
    const after = await newSkills.waitUntil(bot, () => false || undefined, { timeoutMs: 150, intervalMs: 20 });
    const afterMs = Date.now() - t1;
    line('改前（旧谓词形态）', `ok=${before.ok} reason=${before.reason} 耗时≈${beforeMs}ms`);
    line('改后（谓词已改）', `ok=${after.ok} reason=${after.reason} 耗时≈${afterMs}ms`);
    line('若只换实现不改谓词', `ok=${(await newSkills.waitUntil(bot, () => false, { timeoutMs: 150 })).ok} ← 立刻"完成"，正是 13.3 警告的那一幕`);
}
console.log('');
