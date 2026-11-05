/**
 * S42 + S45c 回归 —— 仓库建造的成功判据 & 蓝图全盒遍历的边界/静默空蓝图。
 *
 * S42：`buildStorageRoom` 原来用 `floorN>0 && wallN>0 && ceilN>0` 判定"房间建好了"
 *      —— 1 块地板 + 1 块墙 + 1 块天花板就算成功，上层接着往里摆箱子。
 *      现在按**期望面积 / 周长**（OUT×OUT、周长×层数−门洞）判定，容差 10%。
 *      另：`fillRoomWithChests` 的房间探针过去把 `+4` 硬编码（绑死 innerSize=7）。
 *
 * S45c：`readLitematic` 的全盒遍历没有上限；且坐标落不进任何 region 时静默当空气，
 *      于是"结构读坏了"表现为**一张空蓝图**而不是报错。
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import Vec3 from 'vec3';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import nbt from 'prismarine-nbt';

const SKILLS = process.env.SKILLS_MODULE ?? '../src/agent/library/skills.js';
const skills = await import(SKILLS);

let pass = 0, fail = 0;
const okCase = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const badCase = (n, actual) => { fail++; console.log(`FAIL ${n} ${actual}`); };

console.log(`被测模块：skills=${SKILLS}`);

// ─────────────────────────────────────────────────────────────────────────
// S42：只放下 1 块地板 + 1 块墙 + 1 块天花板 ⇒ 必须判定为"没建好"
// ─────────────────────────────────────────────────────────────────────────
{
    // 可变世界：记录放过的方块；y=63 是地面（stone），其余是 air。
    const world = new Map();
    const key = (x, y, z) => `${x},${y},${z}`;
    const blockAt = (p) => {
        const k = key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
        if (world.has(k)) return { name: world.get(k), position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: 'block', diggable: true, drops: [{}] };
        const y = Math.floor(p.y);
        if (y === 63) return { name: 'stone', position: new Vec3(Math.floor(p.x), y, Math.floor(p.z)), boundingBox: 'block', diggable: true, drops: [{}] };
        return { name: 'air', position: new Vec3(Math.floor(p.x), y, Math.floor(p.z)), boundingBox: 'empty', diggable: false, drops: [] };
    };
    const placedLog = [];
    const seenY = new Set();     // 每个高度只放行第一块

    const bot = {
        username: 'unit_warehouse',
        entity: { position: new Vec3(0.5, 64, 0.5) },
        game: { dimension: 'overworld', gameMode: 'creative' },
        inventory: {
            slots: [{ name: 'oak_planks', type: 5, count: 999 }],
            items: () => [{ name: 'oak_planks', type: 5, count: 999 }],
            emptySlotCount: () => 30,
            findInventoryItem: () => ({ name: 'oak_planks', type: 5, count: 999 }),
        },
        modes: { isOn: () => false, pause: () => { }, unpause: () => { }, isPaused: () => false },
        pathfinder: { setMovements() { }, setGoal() { }, stop() { }, isMoving: () => false, goto: async () => { } },
        controlState: {},
        clearControlStates() { },
        output: '',
        blockAt,
        findBlocks: () => [],
        // ★ 精确夹具：只让**每个高度层的第一块**放成功 —— 即恰好 1 块地板 + 1 块墙 + 1 块天花板。
        //   修复前判据是 `floorN>0 && wallN>0 && ceilN>0` ⇒ 这种"三块零件"会被判成
        //   "房间建好了"（ok:true），这正是本用例要抓的假成功。
        chat: (t) => {
            placedLog.push(t);
            const m = /setblock (-?\d+) (-?\d+) (-?\d+) (\S+)/.exec(t);
            if (!m) return;
            const y = +m[2];
            if (!seenY.has(y)) {
                seenY.add(y);
                world.set(key(+m[1], y, +m[3]), String(m[4]).replace('minecraft:', ''));
            }
        },
    };
    let r = null, threw = null;
    try {
        r = await skills.buildStorageRoom(bot, { x: 0, z: 0 });
    } catch (e) { threw = e; }
    const expects = r?.expected;
    // 修复前：floor=1 wall=1 ceil=1 → ok:true。修复后必须 ok:false 且带 expected 期望值。
    if (!threw && r && r.ok === false && expects && expects.floor > 1 && expects.walls > 1 && expects.ceiling > 1) {
        okCase('S42 只放 3 块 ⇒ 判"没建好"（判据按期望面积/周长）',
            `floor=${r.floor}/${expects.floor} walls=${r.walls}/${expects.walls} ceil=${r.ceiling}/${expects.ceiling} ok=${r.ok}`);
    } else {
        badCase('S42 3 块就报成功应已修（要求 floor/walls/ceiling 接近期望值）',
            `ok=${r?.ok} floor=${r?.floor} walls=${r?.walls} ceiling=${r?.ceiling} expected=${JSON.stringify(expects)}${threw ? ' 抛错=' + threw.message : ''}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────
// S42b：fillRoomWithChests 的房间探针必须按几何推导（不再硬编码 +4）
//        造一个 innerSize 改过的场景不现实，这里验"探针落在房间中心"这个不变量：
//        默认 OUT=9 时中心偏移必须是 4（= floor(OUT/2)）。
// ─────────────────────────────────────────────────────────────────────────
{
    // 读**被测的那份** skills.js（不是固定读仓库里那份），否则反向验证时这条永远绿
    const srcPath = new URL(SKILLS, import.meta.url);
    const src = fs.readFileSync(srcPath, 'utf8');
    const hardcoded = /probe\(x0 \+ 4, CHEST_Y - 1, z0 \+ 4\)/.test(src);
    const derived = /probeMid\s*=\s*Math\.floor\(OUT \/ 2\)/.test(src);
    if (!hardcoded && derived) {
        okCase('S42b 房间探针按 floor(OUT/2) 推导（无硬编码 +4）', 'probeMid = floor(OUT/2)');
    } else {
        badCase('S42b 探针不应硬编码 +4', `hardcoded=${hardcoded} derived=${derived} src=${srcPath.pathname.split('/').pop()}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────
// S45c：包围盒与 region 数据对不上 ⇒ 必须报错，不能静默变空蓝图
// ─────────────────────────────────────────────────────────────────────────
{
    // 造一个"大小声称 40×40×40、但调色板是空的"的 litematic：
    // 每个坐标都取不到 palette 条目 → getBlock 返回 null → 修复前全部当空气跳过
    // → 得到一张 totalBlocks=0 的**空蓝图**且不报错。
    const mkLitematicWithMismatch = () => {
        const compound = (size) => ({
            type: 'compound',
            name: '',
            value: {
                Version: { type: 'int', value: 6 },
                MinecraftDataVersion: { type: 'int', value: 3953 },
                Regions: {
                    type: 'compound',
                    value: {
                        Main: {
                            type: 'compound',
                            value: {
                                Size: {
                                    type: 'compound', value: {
                                        x: { type: 'int', value: size },
                                        y: { type: 'int', value: size },
                                        z: { type: 'int', value: size },
                                    },
                                },
                                Position: {
                                    type: 'compound', value: {
                                        x: { type: 'int', value: 0 },
                                        y: { type: 'int', value: 0 },
                                        z: { type: 'int', value: 0 },
                                    },
                                },
                                // ★ 空调色板 = 每个坐标都查不到方块定义
                                BlockStatePalette: {
                                    type: 'list', value: { type: 'compound', value: [] },
                                },
                                BlockStates: { type: 'longArray', value: [0n] },
                            },
                        },
                    },
                },
            },
        });
        return nbt.writeUncompressed(compound(40));
    };

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't14-schem-'));
    const schemRoot = path.join(tmp, 'schematics');
    fs.mkdirSync(schemRoot, { recursive: true });
    const file = path.join(schemRoot, 'broken.litematic');
    // readLitematic 走 gzip 分支：自己压一下
    fs.writeFileSync(file, zlib.gzipSync(mkLitematicWithMismatch()));
    process.env.SCHEM_ROOT = schemRoot;

    const schematic = await import('../src/agent/library/schematic.js');
    let r = null, threw = null;
    try {
        r = schematic.readLitematic(file);
    } catch (e) { threw = e; }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 临时目录清理失败不影响结论 */ }

    // 修复前：不抛，返回一张"几乎空"的蓝图（totalBlocks 很小/0）。
    // 修复后：抛错说明包围盒与 region 数据对不上（或没有非空气方块）。
    if (threw && /does not match its region data|no non-air blocks/i.test(String(threw.message))) {
        okCase('S45c 包围盒与 region 数据不符 ⇒ 报错（不再静默空蓝图）',
            String(threw.message).slice(0, 90));
    } else if (threw) {
        badCase('S45c 抛错但原因不对', String(threw.message).slice(0, 120));
    } else {
        badCase('S45c 应报错，不能静默返回空蓝图',
            `totalBlocks=${r?.totalBlocks} size=${JSON.stringify(r?.size)}`);
    }
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
