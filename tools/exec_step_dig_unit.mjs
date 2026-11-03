/**
 * executor.execStep 挖方块分支的回归测试（D2）—— 不需要服务器。
 *
 * 缺陷原貌：path_3d 会生成「挖邻列」的 dig 边（相邻 4 向、落差 ≤40），
 * 步骤里带着目标列 (step.x, step.z)。但 executor 的 dig 分支用的是
 * 当前位置的列（p.x / p.z），于是：
 *   规划要挖邻列 → 实际挖的是自己头顶 → 邻列没通 → 下一轮又规划同一条边
 * 表现为「反复挖同一处、原地不动」。
 *
 * 另一个症状是「液体头顶假成功」：头顶是水时旧代码直接 break 后 return ok({dug})，
 * 上层以为她已经上去了，实际停在原地，于是不再重规划。
 *
 * 本测试锁三件事：
 *   1) 邻列 dig 必须挖 step.x/step.z 那一列（不是自己这一列）；
 *   2) 邻列 dig 不能把自己垫高（stepUp 只用于同列）；
 *   3) 头顶液体且没到目标高度 → 必须返回失败，不能 ok。
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import { execStep } from '../src/agent/library/executor.js';
import Vec3 from 'vec3';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${actual}`); };

const key = (x, y, z) => `${x},${y},${z}`;

/**
 * 假 bot。
 * @param {object} opts
 * @param {Map} opts.world  "x,y,z" -> 方块名
 * @param {object} opts.pos 她的位置（脚位）
 */
function makeBot({ world, pos = { x: 0, y: 64, z: 0 } } = {}) {
    const dugBlocks = [];        // 记录 bot.dig 实际挖的坐标
    const controlStates = [];
    // ★ 2026-11-03（t46）：脚位要落在**格心**（x/z 带 .5）—— 真机 bot 永远在格心。
    //   放整数会让"到隔壁一格"算成 hypot(1.5,0.5)=1.58 > STEP_ADJACENT_MAX(1.5)
    //   → stepInto 在"不是相邻一格"就返回了，邻列走的用例会假红。
    const bot = {
        entity: { position: new Vec3(pos.x + 0.5, pos.y, pos.z + 0.5), onGround: true, height: 1.8, eyeHeight: 1.62 },
        inventory: {
            items: () => [{ name: 'diamond_pickaxe', count: 1, type: 1, slot: 36 }],
        },
        registry: {
            blocksByName: { dirt: { id: 3 }, stone: { id: 1 }, air: { id: 0 } },
            itemsByName: { diamond_pickaxe: { id: 900 } },
        },
        dig: async (b) => {
            const p = b.position;
            dugBlocks.push({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
            world.set(key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), 'air');
        },
        blockAt: (v, defaultVal) => {
            const p = v && typeof v === 'object' ? v : { x: 0, y: 0, z: 0 };
            const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
            const name = world.get(key(fx, fy, fz)) ?? 'air';
            const block = {
                name,
                position: { x: fx, y: fy, z: fz },
                diggable: name !== 'bedrock',
                boundingBox: 'block',
                // atom_dig 会问"手上这个工具能不能收获它"，假 bot 一律说能
                canHarvest: () => true,
                harvestTools: undefined,
            };
            if (typeof defaultVal === 'function') return defaultVal(block);
            return block;
        },
        // ★ 2026-11-03（t46）：邻列 dig 挖通后 executor 会调 `stepInto` 真的走进隧道，
        //   它靠 lookAt(格心) + setControlState('forward') + 轮询 `insideCell`。
        //   这里补最小模拟（只走水平相邻一格）：记住 lookAt 目标，按下 forward 就挪进去。
        //   不补的话这两条邻列用例会假红（挖本身是成功的）。
        lookAt: async (point) => { if (point) bot.__lookTarget = { x: point.x, y: point.y, z: point.z }; },
        setControlState: (s, on) => {
            controlStates.push([s, on]);
            if (on && s === 'forward' && bot.__lookTarget) {
                const t = bot.__lookTarget;
                const cur = bot.entity.position;
                const tx = Math.floor(t.x), ty = Math.floor(t.y) - 1, tz = Math.floor(t.z);
                if (Math.hypot(tx + 0.5 - cur.x, tz + 0.5 - cur.z) <= 1.6) {
                    bot.entity.position = new Vec3(tx + 0.5, ty, tz + 0.5);
                }
            }
        },
        equip: async () => { },
        pathfinder: { stop: () => { }, setMovements: () => { }, goals: {} },
        // 用来判断有没有被"垫高"
        __dug: dugBlocks,
        __controls: controlStates,
        __world: world,
    };
    return bot;
}

/** 由她脚位构造基础世界：脚下实心，其余空气（好让 dig 只有目标那几格）。 */
function baseWorld(extra = []) {
    const w = new Map();
    w.set(key(0, 63, 0), 'stone');      // 她脚下
    // ★ 2026-11-03（t46）：邻列 `(1,63,0)` 也要有地板。
    //   邻列 dig 挖通后 executor 会 `stepInto` 走进去，而 stepInto 会检查
    //   "落点脚下有没有东西"（防按前进走进空气掉下去）。
    //   本文件的 `blockAt` 对未登记格返回 **'air'**，所以这里若不给地板，
    //   stepInto 会正确地报 UNSAFE —— 那是**场地缺地板**，不是产品错。
    //   （真机上她本来就是沿地面走到墙边，脚下方必然是实心。）
    w.set(key(1, 63, 0), 'stone');
    for (const [x, y, z, name] of extra) w.set(key(x, y, z), name);
    return w;
}

// ── 1. 邻列 dig：必须挖 (1,65,0)，不是自己头顶 (0,65,0) ────────────────
{
    const world = baseWorld([
        [0, 65, 0, 'stone'],            // 自己头顶（邻列步骤不该动它）
        [1, 65, 0, 'dirt'],             // 邻列目标（该挖）
        [1, 66, 0, 'stone'],            // 邻列往上一格（要到 y=66 才需要挖）
    ]);
    const bot = makeBot({ world, pos: { x: 0, y: 64, z: 0 } });
    const r = await execStep(bot, { action: 'dig', x: 1, y: 66, z: 0 }, { onEvent: () => { } });
    const dugOwnColumn = bot.__dug.some((d) => d.x === 0 && d.z === 0);
    const dugTargetColumn = bot.__dug.some((d) => d.x === 1 && d.z === 0);
    if (r.ok && dugTargetColumn && !dugOwnColumn) {
        okCase('邻列 dig 挖的是目标列', `dug=${JSON.stringify(bot.__dug)}`);
    } else {
        badCase('邻列 dig 挖的是目标列', `ok=${r.ok} dug=${JSON.stringify(bot.__dug)}`);
    }
}

// ── 2. 邻列 dig 不许把自己垫高（不应出现 jump/place 控制）──────────────
{
    const world = baseWorld([
        [1, 65, 0, 'dirt'],
        [1, 66, 0, 'dirt'],
    ]);
    const bot = makeBot({ world, pos: { x: 0, y: 64, z: 0 } });
    const r = await execStep(bot, { action: 'dig', x: 1, y: 66, z: 0 }, { onEvent: () => { } });
    const jumped = bot.__controls.some(([s, on]) => s === 'jump' && on === true);
    if (r.ok && !jumped) {
        okCase('邻列 dig 不把自己垫高', `controls=${JSON.stringify(bot.__controls)}`);
    } else {
        badCase('邻列 dig 不把自己垫高', `ok=${r.ok} controls=${JSON.stringify(bot.__controls)}`);
    }
}

// ── 3. 头顶是液体且没到目标高度 → 必须失败（不许假成功）────────────────
{
    const world = baseWorld([
        [0, 65, 0, 'water'],            // 自己头顶是水
    ]);
    const bot = makeBot({ world, pos: { x: 0, y: 64, z: 0 } });
    const r = await execStep(bot, { action: 'dig', x: 0, y: 67, z: 0 }, { onEvent: () => { } });
    if (!r.ok && (r.code === 'BLOCKED' || r.code === 'NO_REACH')) {
        okCase('液体头顶不再假成功', `code=${r.code}`);
    } else {
        badCase('液体头顶不再假成功', `ok=${r.ok} code=${r.code}`);
    }
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
