/**
 * 公共假 bot 夹具 —— 离线单测用，不连服务器。
 *
 * 为什么要有这个（docs/architecture/09_crosscut.md §5.1）：
 * 原来 `exec_step_y_unit` / `exec_landing_unit` / `test_tunnel` / `atom_stand_unit`
 * 各自手写了一版假 bot，四处长得不一样（有的未加载返回 air、有的返回 null），
 * bot 接口一改就要改四处，而且"哪一版才是真的"没人说得清。
 * 现在合成一份，各处用 opts 描述**差异**，形状只在这里维护。
 *
 * 用法（详见各测试文件）：
 *   import { makeFakeBot, worldOf, realRegistry, MC_VERSION } from './fixtures/fake_bot.mjs';
 *   const bot = makeFakeBot({
 *       world: worldOf([['0, 63, 0', 'stone']]),
 *       feet: { x: 0, y: 64, z: 0 },   // 脚位（整格坐标）
 *   });
 *
 * 约定（都是为了"和真 mineflayer 一致，且测试能从副作用看出差异"）：
 *   - `blockAt(v, dflt)`：**未登记的格子返回 null**（= 未加载），不假装是 air。
 *     真要当空气用就传 `unloaded: 'air'`（executor 的用例需要）。
 *     `dflt` 是函数时用它包装方块对象；不是函数时不返回假值（避免把 null 变成 false）。
 *   - `dig` / `placeBlock` 会真的改 world，并记到 `bot.__dug` / `bot.__placed`。
 *   - `pathfinder.goto` **不模拟物理**：直接把位置挪到目标格上方，并置 `bot.__moved`。
 *     跳不起来（`setControlState('jump')` 只记录不抬升），所以 stepUp 必然 STUCK。
 *   - 控制键记到 `bot.__controls`，`clearControlStates()` 清空 —— 用来断言"键松没松"。
 *   - `bot.__chats` / `bot.__equips` / `bot.__goals` 同理，断言"到底调了什么"。
 *
 * 想改某个接口的桩：各处传 `stubs: { chat: () => {...} }` 覆盖，别在这里开后门。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ★ 写用例时的三个坑（2026-11-02，M7 流程用例踩出来的；都不是被测代码的 bug，
 *   但每个都会让你以为"代码坏了"。写在这儿，免得下一个人再踩一次）
 *
 *   1) **有后置复核的动作，桩必须真的改世界。**
 *      `act_farm.harvestCrop` / `act_dig.digBlock` / `act_place.placeBlockAt` 都会在操作后
 *      **再读一次方块**来确认"真的成了"（幽灵方块是真实存在的问题）。
 *      所以假 bot 的 `dig` 如果只 `count++` 而不把方块从 world 里删掉，
 *      动作会如实报 `TIMEOUT/DIG_FAIL`，流程就把这一步记成 skip —— 看起来像流程错了。
 *      正确做法：桩里 `world.set(key, 'air')`（或用下面的 `setBlock`）。
 *
 *   2) **需要 Vec3 形状的字段，别给裸对象。**
 *      `act_attack.attackOnce` 会调 `entity.position.offset(0, height, 0)`；
 *      `atom_place.placeBlockAt` 会调 `block.position.offset(...)`。
 *      假实体/假方块只写 `{x,y,z}` 会直接 `TypeError: offset is not a function`。
 *      正确做法：位置用 `new Vec3(x,y,z)`，或给裸对象补一个 `offset(dx,dy,dz)`。
 *
 *   3) **"先给道具再清空 slots"不生效。**
 *      `makeFakeBot` 在构造时就把 `heldItem = slots[0]` 与 `inventory.count()` 的闭包算好了；
 *      事后 `bot.inventory.slots = []` 只改了数组，`heldItem` 仍指着旧物品。
 *      要测"没有这个物品"，请**直接构造时传 `items: []`**，不要事后清空。
 * ───────────────────────────────────────────────────────────────────────────
 */
import Vec3 from 'vec3';
import mcDataFactory from 'minecraft-data';

/** 与 docs/architecture/09_crosscut.md §6 对齐的版本，别在测试里各写一处。 */
export const MC_VERSION = '1.21.8';

let cachedRegistry = null;

/**
 * 真注册表（executor / pathfinder 需要 blocksByName 完整）。
 *
 * 什么时候要：走 `atom_move` → `new pf.Movements(bot)` 这类路径，
 * 它会读 blocksByName.chest 等一堆；手搓空表会炸。纯几何判定用不上。
 */
export function realRegistry(version = MC_VERSION) {
    if (cachedRegistry && version === MC_VERSION) return cachedRegistry;
    const reg = mcDataFactory(version);
    if (version === MC_VERSION) cachedRegistry = reg;
    return reg;
}

/** 方块坐标 → world 的键。小数坐标一律向下取整（和游戏一致）。 */
export const blockKey = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;

/**
 * 造 world：Map<"x,y,z", 方块名>。
 *
 * 接受三种写法，省得每个测试自己拼字符串：
 *   - Map（复制一份，不改调用方的）
 *   - `[[x, y, z, name], ...]`
 *   - `[{ x, y, z, name }, ...]`（atom_* 里那种位置对象）
 *   - `{ '0,63,0': 'stone' }`
 */
export function worldOf(entries = []) {
    const w = new Map();
    if (entries instanceof Map) {
        for (const [k, v] of entries) w.set(k, v);
        return w;
    }
    if (Array.isArray(entries)) {
        for (const e of entries) {
            if (Array.isArray(e)) w.set(blockKey(e[0], e[1], e[2]), e[3]);
            else if (e && typeof e === 'object') w.set(blockKey(e.x, e.y, e.z), e.name);
        }
        return w;
    }
    for (const [k, v] of Object.entries(entries ?? {})) w.set(k, v);
    return w;
}

/**
 * 造一个假 bot。
 *
 * @param {object}  [opts]
 * @param {Map|Array|object} [opts.world]        方块表（见 worldOf），默认空
 * @param {{x:number,y:number,z:number}} [opts.feet] 脚位整格坐标，默认 (0,64,0)
 * @param {number}  [opts.posOffset]   entity.position 在脚位上加多少（0 = 整格，0.5 = 格中心）
 * @param {'null'|'air'} [opts.unloaded] 未登记格子返回 null 还是 'air'
 * @param {object}  [opts.registry]    bot.registry，默认空表（要真的用 realRegistry()）
 * @param {string}  [opts.version]
 * @param {Array}   [opts.items]       背包物品（{name,type,count,slot}），默认空手
 * @param {(name:string)=>boolean} [opts.diggable] 默认 bedrock/水/岩浆 不可挖
 * @param {number}  [opts.gotoOffset]  goto 成功后位置在目标格上偏移多少（exec_step_y 用 0）
 * @param {Error|null} [opts.gotoError] 传了就让 goto 失败（模拟 NO_PATH）
 * @param {string}  [opts.placeAs]     放下的方块名，默认取手持物品名，否则 stone
 * @param {object}  [opts.stubs]       覆盖任意字段
 */
export function makeFakeBot(opts = {}) {
    const {
        world: rawWorld = new Map(),
        feet = { x: 0, y: 64, z: 0 },
        posOffset = 0.5,
        unloaded = 'null',
        registry = { blocksByName: {}, itemsByName: {} },
        version = MC_VERSION,
        items = [],
        diggable = (name) => !/^(bedrock|water|lava)$/.test(name),
        gotoOffset = 0.5,
        gotoError = null,
        placeAs = null,
        username = 'fixture',
        stubs = {},
    } = opts;

    const world = worldOf(rawWorld);

    /** world 里的名字 → null（未加载）；`unloaded: 'air'` 时当空气。 */
    function readName(x, y, z) {
        const name = world.get(blockKey(x, y, z));
        if (name !== undefined) return name;
        return unloaded === 'air' ? 'air' : null;
    }

    function readBlock(v, dflt) {
        if (!v || typeof v !== 'object') {
            return typeof dflt === 'function' ? dflt(null) : null;
        }
        const fx = Math.floor(v.x), fy = Math.floor(v.y), fz = Math.floor(v.z);
        const name = readName(fx, fy, fz);
        // 未加载：返回 null，不用 dflt 造一个假方块（会把"没数据"变成"是空气"）
        if (name === null) return typeof dflt === 'function' ? dflt(null) : null;
        const block = {
            name,
            position: new Vec3(fx, fy, fz),
            diggable: diggable(name),
            boundingBox: name === 'air' ? null : 'block',
            canHarvest: () => true,
            type: 0,
        };
        return typeof dflt === 'function' ? dflt(block) : block;
    }

    const slots = items.map((it, i) => ({ count: 1, slot: i, ...it }));

    const bot = {
        username,
        version,
        registry,
        game: { dimension: 'overworld' },
        entity: {
            position: new Vec3(feet.x + posOffset, feet.y, feet.z + posOffset),
            velocity: new Vec3(0, 0, 0),
            onGround: true,
            height: 1.8,
            eyeHeight: 1.62,
            yaw: 0,
            pitch: 0,
        },
        inventory: {
            slots,
            items: () => slots,
            count: (id) => slots
                .filter((it) => it.type === id || it.name === id)
                .reduce((n, it) => n + (it.count ?? 1), 0),
            emptySlotCount: () => Math.max(0, 36 - slots.length),
        },
        heldItem: slots[0] ?? null,
        players: {},
        entities: {},
        interrupt_code: false,
        health: 20,
        food: 20,

        blockAt: readBlock,
        blockAtCursor: () => null,
        findBlocks: () => [],
        nearestEntity: () => null,
        getBlock: (x, y, z) => readBlock({ x, y, z }),
        setBlock: (x, y, z, name) => world.set(blockKey(x, y, z), name),

        dig: async (b) => {
            if (!b || !b.position) return;
            const p = b.position;
            bot.__dug.push({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
            world.set(blockKey(p.x, p.y, p.z), 'air');
        },
        stopDigging: async () => { },
        placeBlock: async (ref, face) => {
            const base = ref?.position ?? { x: 0, y: 0, z: 0 };
            const f = face ?? { x: 0, y: 1, z: 0 };
            const x = Math.floor(base.x) + Math.floor(f.x);
            const y = Math.floor(base.y) + Math.floor(f.y);
            const z = Math.floor(base.z) + Math.floor(f.z);
            const name = placeAs ?? bot.heldItem?.name ?? 'stone';
            bot.__placed.push({ x, y, z, name });
            world.set(blockKey(x, y, z), name);
        },
        equip: async (item, dest) => { bot.__equips.push({ item, dest }); bot.heldItem = item; return item; },
        unequip: async () => { bot.heldItem = null; },
        lookAt: async () => { },
        look: async () => { },
        chat: (msg) => { bot.__chats.push(String(msg)); },
        activateBlock: async () => { },
        toss: async () => { },

        setControlState: (k, v) => { if (v) bot.__controls.set(k, true); else bot.__controls.delete(k); },
        getControlState: (k) => bot.__controls.get(k),
        clearControlStates: () => bot.__controls.clear(),
        waitForTicks: async () => { },

        pathfinder: {
            goals: {},
            setMovements: () => { },
            setGoal: () => { },
            stop: () => { },
            isMoving: () => false,
            async goto(goal) {
                bot.__goals.push(goal);
                if (gotoError) throw gotoError;
                bot.__moved = true;
                bot.entity.position = new Vec3(
                    (goal?.x ?? 0) + gotoOffset,
                    feet.y,
                    (goal?.z ?? 0) + gotoOffset,
                );
                return true;
            },
        },

        // ── 记录（断言副作用用）──
        __world: world,
        __dug: [],
        __placed: [],
        __chats: [],
        __equips: [],
        __goals: [],
        __controls: new Map(),
        __moved: false,
    };

    // placeBlock 的别名：有的地方写 bot.place，有的写 bot.placeBlock
    bot.place = bot.placeBlock;

    return Object.assign(bot, stubs);
}
