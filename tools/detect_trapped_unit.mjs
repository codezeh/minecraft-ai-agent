/**
 * atom_stuck_detect.detectTrapped 单元测试 —— 不需要服务器。
 *
 * 这段判据是从 task_follow 的 110 行 BFS 提出来的，历史上为它改过 5 次
 * （第十二~十七次修）。每个用例对应**一次真实踩坑**，别再改回去：
 *
 *   1) 封闭小房间（可达面积小 + 四周封死）→ 被困
 *   2) 开阔草原（面积大）→ 不被困（不能因为"头顶有东西"就乱挖）
 *   3) 地表 3×3 平台、四周能跳下去 → 不被困（只看面积会误判）
 *   4) 1×1 竖井、头顶已挖穿（capped=false）但面积=1、四周封死 → 被困
 *   5) 找地表：第一段连续 3 格空气的起点，不是"头顶第一格实心"
 *   6) goalY = 地表 + 2；找不到地表 → 当前位置 + 12
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import { detectTrapped } from '../src/agent/library/query_stuck.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${actual}`); };

/**
 * 假 bot：world 是 "x,y,z" -> 方块名 的 Map。缺省 air。
 * 提供了 canStand 需要的 blockAt（读不到返回 null）。
 */
function makeBot({ world, feet = { x: 0, y: 64, z: 0 } } = {}) {
    const key = (x, y, z) => `${x},${y},${z}`;
    return {
        entity: { position: { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 } },
        blockAt: (v) => {
            const p = v && typeof v === 'object' ? v : { x: 0, y: 0, z: 0 };
            const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
            const name = world.get(key(x, y, z)) ?? 'air';
            return { name, position: { x, y, z }, boundingBox: name === 'air' ? null : 'block' };
        },
    };
}

/** 造一个封闭房间：内部 air，四周与上下 stone。 */
function sealedRoom({ x0, y0, z0, x1, y1, z1 }) {
    const w = new Map();
    for (let x = x0 - 1; x <= x1 + 1; x++) {
        for (let y = y0 - 1; y <= y1 + 1; y++) {
            for (let z = z0 - 1; z <= z1 + 1; z++) {
                const inner = x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1;
                if (!inner) w.set(`${x},${y},${z}`, 'stone');
            }
        }
    }
    return w;
}

// ── 1) 封闭小房间 → 被困 ──────────────────────────────────────────────
{
    const world = sealedRoom({ x0: 0, y0: 64, z0: 0, x1: 2, y1: 65, z1: 2 });
    const bot = makeBot({ world });
    const r = detectTrapped(bot);
    const d = r.data;
    // 注意：这里**不**断言 walled===true。继承下来的 openDirs 探法有个已知弱点：
    // 它探"8 格内有没有能站的地方"，房间**内部自己的格子**也会被算成"有出口"，
    // 所以封闭小房间照样能探出 openDirs>0。小房间靠 capped（有遮挡）兜住。
    // 这个弱点不在此次整改范围内（改了会变行为），已写进原子的注释。
    if (r.ok && d.trapped === true && d.area < 300 && d.capped === true) {
        okCase('封闭小房间 → 被困（靠 capped 兜住）', `area=${d.area} walled=${d.walled} capped=${d.capped}`);
    } else {
        badCase('封闭小房间 → 被困（靠 capped 兜住）', JSON.stringify(d));
    }
}

// ── 2) 开阔草原（面积大）→ 不被困 ────────────────────────────────────
{
    // 一望无际的平地：脚下 stone，上面 air
    const w = new Map();
    for (let x = -25; x <= 25; x++) for (let z = -25; z <= 25; z++) w.set(`${x},63,${z}`, 'stone');
    const bot = makeBot({ world: w });
    const r = detectTrapped(bot);
    const d = r.data;
    if (r.ok && d.trapped === false && d.area >= 300) {
        okCase('开阔草原 → 不被困', `area=${d.area}`);
    } else {
        badCase('开阔草原 → 不被困', JSON.stringify(d));
    }
}

// ── 3) 地表 3×3 平台、四周能跳下去 → 不被困 ──────────────────────────
// 只看面积会误判成被困（面积 9 < 300），但四周有出口（能跳下去）
{
    const w = new Map();
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) w.set(`${x},63,${z}`, 'stone');  // 平台顶面 64
    // 平台外的地面在 y=43（够低），站在平台边缘往下 1~2 格探不到 → 靠 openDirs 判定
    for (let x = -10; x <= 10; x++) for (let z = -10; z <= 10; z++) {
        if (x >= -1 && x <= 1 && z >= -1 && z <= 1) continue;
        w.set(`${x},42,${z}`, 'stone');
    }
    const bot = makeBot({ world: w, feet: { x: 0, y: 64, z: 0 } });
    const r = detectTrapped(bot);
    const d = r.data;
    // 关键：面积小但 openDirs>0（能跳下去）→ trapped=false
    if (r.ok && d.trapped === false && d.openDirs > 0) {
        okCase('小平台但四周可跳下 → 不被困', `area=${d.area} openDirs=${d.openDirs}`);
    } else {
        badCase('小平台但四周可跳下 → 不被困', JSON.stringify(d));
    }
}

// ── 4) 1×1 竖井、头顶已挖穿（capped=false）但四周封死 → 被困 ────────────
{
    // 竖井：她的列从 64 往上都是 air（头顶开阔），四周是 stone
    const w = new Map();
    for (let y = 40; y <= 80; y++) {
        for (let x = -1; x <= 1; x++) {
            for (let z = -1; z <= 1; z++) {
                if (x === 0 && z === 0) continue;              // 竖井本身留空
                w.set(`${x},${y},${z}`, 'stone');
            }
        }
    }
    w.set('0,63,0', 'stone');                                   // 脚下有支撑
    const bot = makeBot({ world: w, feet: { x: 0, y: 64, z: 0 } });
    const r = detectTrapped(bot);
    const d = r.data;
    if (r.ok && d.trapped === true && d.capped === false && d.walled === true) {
        okCase('1×1 竖井（头顶开阔但封死四周）→ 被困', `area=${d.area} capped=${d.capped} walled=${d.walled}`);
    } else {
        badCase('1×1 竖井（头顶开阔但封死四周）→ 被困', JSON.stringify(d));
    }
}

// ── 5) 找地表：第一段连续 3 格空气的起点（不是头顶第一格实心）──────────
// 实测场景：y=58 位置，头顶 59 空、60~67 stone、68~70 土、71 草、72+ 天空
{
    const w = new Map();
    w.set('0,57,0', 'stone');                 // 脚下
    for (let y = 60; y <= 67; y++) w.set(`0,${y},0`, 'stone');   // 石层
    for (let y = 68; y <= 70; y++) w.set(`0,${y},0`, 'dirt');    // 土层
    w.set('0,71,0', 'grass_block');           // 草
    // 四周封死（避免被当成开阔地）
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) for (let y = 40; y <= 100; y++) {
        if (x === 0 && z === 0) continue;
        w.set(`${x},${y},${z}`, 'stone');
    }
    const bot = makeBot({ world: w, feet: { x: 0, y: 58, z: 0 } });
    const r = detectTrapped(bot);
    const d = r.data;
    // 地表应是 72（71 是草，72 起连续空气）
    if (r.ok && d.surfaceY === 72 && d.ceilingAt === 60 && d.goalY === 74) {
        okCase('地表取「连续3格空气的起点」', `surfaceY=${d.surfaceY} ceiling=${d.ceilingAt} goalY=${d.goalY}`);
    } else {
        badCase('地表取「连续3格空气的起点」', `surfaceY=${d.surfaceY} ceiling=${d.ceilingAt} goalY=${d.goalY}（期望 72/60/74）`);
    }
}

// ── 6) 找不到地表（头顶全是石头）：goalY = 当前位置 + 12 ────────────────
{
    const w = new Map();
    w.set('0,63,0', 'stone');
    for (let y = 64; y <= 160; y++) w.set(`0,${y},0`, 'stone');   // 一路实心
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) for (let y = 40; y <= 160; y++) {
        if (x === 0 && z === 0) continue;
        w.set(`${x},${y},${z}`, 'stone');
    }
    const bot = makeBot({ world: w, feet: { x: 0, y: 64, z: 0 } });
    const r = detectTrapped(bot);
    const d = r.data;
    if (r.ok && d.surfaceY === null && d.goalY === 64 + 12 && d.trapped === true) {
        okCase('无地表 → goalY = 当前+12', `surfaceY=${d.surfaceY} goalY=${d.goalY}`);
    } else {
        badCase('无地表 → goalY = 当前+12', `surfaceY=${d.surfaceY} goalY=${d.goalY} trapped=${d.trapped}`);
    }
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
