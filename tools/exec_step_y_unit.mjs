/**
 * executor 的 y 语义回归测试（D1）—— 不需要服务器。
 *
 * 缺陷原貌：两个 y 混着用，且**同一个文件里就不一致**：
 *   step.y      = 可站立面的 y = **实心方块自己那一格**（terrain3d 存的就是它）
 *   position.y  = 脚的高度 = 脚所在那格空气 → 站在 y=63 的方块上时是 64
 *   即：floor(position.y) === step.y + 1
 *
 * 文件里"走完校验高度"那段早就按 step.y+1 写了，
 * 但 dy 计算、垫高判据、攀爬、挖掘分支用的是裸 step.y。实测症状：
 *   - 真要上 2 格时 dy 被算成 1 → 不进"垫方块"分支 → pathfinder 跳不上 → NO_PATH
 *   - 挖掘循环以 step.y 为终点 → 少挖一格，永远到不了目标高度
 *
 * 修复：在 execStep 入口统一算出 targetFeetY = step.y + 1，其余一律按脚位比较。
 *
 * 测试手段：假 bot 的"跳"不生效（setControlState('jump') 不抬升位置），
 * 于是 stepUp 必然返回 STUCK。这样"进没进垫高分支"就能从返回码看出来：
 *   - 进了  → STUCK
 *   - 没进  → 走水平移动分支，返回 ok
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import Vec3 from 'vec3';
import mcDataFactory from 'minecraft-data';
import { execStep } from '../src/agent/library/executor.js';

// 真注册表：executor 的水平移动分支会走 atom_move → new pf.Movements(bot)，
// 它要求 bot.registry 完整（会读 blocksByName.chest 等一堆）。用真数据，别手搓。
const MC_VERSION = '1.21.8';
const REG = mcDataFactory(MC_VERSION);

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${actual}`); };

const key = (x, y, z) => `${x},${y},${z}`;

/**
 * 假 bot：站在 (0,64,0)（脚下 y=63 是实心）。
 * - jump 不生效（无物理），stepUp 必然 STUCK
 * - pathfinder.goto 直接把位置挪到目标（让水平分支"成功"）
 */
function makeBot({ world, feetY = 64 } = {}) {
    const dug = [];
    const bot = {
        entity: {
            position: new Vec3(0, feetY, 0),
            onGround: true,
            height: 1.8,
            eyeHeight: 1.62,
        },
        inventory: {
            items: () => [],       // 没有垫脚方块也不影响：dy 分支判定在任何 stepUp 之前
        },
        registry: REG,
        version: MC_VERSION,
        dig: async (b) => {
            const p = b.position;
            dug.push({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
            world.set(key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), 'air');
        },
        blockAt: (v, dflt) => {
            const p = v && typeof v === 'object' ? v : { x: 0, y: 0, z: 0 };
            const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
            const name = world.get(key(fx, fy, fz)) ?? 'air';
            const block = {
                name, position: { x: fx, y: fy, z: fz },
                diggable: name !== 'bedrock',
                boundingBox: name === 'air' ? null : 'block',
                canHarvest: () => true,
            };
            if (typeof dflt === 'function') return dflt(block);
            return block;
        },
        setControlState: () => { },            // 跳不起来 → stepUp 会 STUCK
        equip: async () => { },
        pathfinder: {
            goals: {},
            setMovements: () => { },
            stop: () => { },
            // 水平移动"成功"：直接把脚挪到目标格上方
            goto: async (goal) => { bot.entity.position = new Vec3(goal.x, feetY, goal.z); },
        },
        __dug: dug,
    };
    return bot;
}

function baseWorld(extra = []) {
    const w = new Map();
    w.set(key(0, 63, 0), 'stone');   // 她脚下
    for (const [x, y, z, name] of extra) w.set(key(x, y, z), name);
    return w;
}

// ── 1. 真要上 2 格：必须进"垫方块"分支（旧代码 dy 少算 1，会漏）─────────
// 她脚在 64 → 目标面 y=65 → 目标脚位 66 → 高差 2
// 进了垫高分支就会调 stepUp，而假 bot 背包里没有垫脚方块 → NO_ITEM
{
    const bot = makeBot({ world: baseWorld() });
    const r = await execStep(bot, { action: 'jump', x: 0, y: 65, z: 0 }, { onEvent: () => { } });
    if (!r.ok && r.code === 'NO_ITEM' && /垫脚/.test(String(r.message ?? ''))) {
        okCase('上 2 格会尝试垫方块', `code=${r.code}（说明进了 stepUp）`);
    } else {
        badCase('上 2 格会尝试垫方块', `ok=${r.ok} code=${r.code} msg=${r.message}（旧代码这里是 ok，说明没垫高）`);
    }
}

// ── 2. 只上 1 格：不该进垫高分支（交给 pathfinder 跳）──────────────────
// 她脚在 64 → 目标面 y=64 → 目标脚位 65 → 高差 1
// 判据：不能是"垫脚方块"那条 NO_ITEM（那不是 1 格该走的路）
{
    const bot = makeBot({ world: baseWorld() });
    const r = await execStep(bot, { action: 'jump', x: 0, y: 64, z: 0 }, { onEvent: () => { } });
    const wentPillar = r.code === 'NO_ITEM' && /垫脚/.test(String(r.message ?? ''));
    if (!wentPillar) {
        okCase('上 1 格不走垫高分支', `ok=${r.ok} code=${r.code}`);
    } else {
        badCase('上 1 格不走垫高分支', `code=${r.code} msg=${r.message}（1 格不该垫方块）`);
    }
}

// ── 3. dig 必须以脚位为终点：目标面 y=64 → 脚位 65，要挖开 y=65 ────────
// 旧代码 targetY = step.y = 64，而 y 已是 64 → 循环一次都不进 → 一个方块都不挖
{
    const world = baseWorld([
        [0, 64, 0, 'air'],      // 她的脚格（空）
        [0, 65, 0, 'stone'],    // 头顶那格：必须挖掉才能上到脚位 65
        [0, 66, 0, 'air'],
    ]);
    const bot = makeBot({ world });
    await execStep(bot, { action: 'dig', x: 0, y: 64, z: 0 }, { onEvent: () => { } });
    const dugHead = bot.__dug.some((d) => d.y === 65);
    if (dugHead) {
        okCase('dig 挖到脚位那一格', `dug=${JSON.stringify(bot.__dug)}`);
    } else {
        badCase('dig 挖到脚位那一格', `dug=${JSON.stringify(bot.__dug)}（旧代码在这里一个都不挖）`);
    }
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
