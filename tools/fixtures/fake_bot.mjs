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
 * 本进程内"覆盖了 blockAt 严格默认实现"的次数（t68）。
 *
 * 为什么要有这个计数：`strictPoints` 只在**没被 stubs 覆盖**时生效。
 * 计数就是"这个测试文件有多少个用例走偏门绕过了保护"。
 * `tools/unit_all.mjs` 会把各子进程的数字汇总起来 —— **那就是单测盲区宽度的下限**。
 */
export let fakeBotStrictBypassCount = 0;

/** 读当前计数（给 unit_all 汇总用；没 import 夹具的测试文件自然报 0）。 */
export function getStrictBypassCount() {
    return fakeBotStrictBypassCount;
}

/**
 * 「坐标必须是 Vec3 形状」的唯一实现（t68）。
 *
 * 真链路：`bot.blockAt(p)` → `world.getBlock(p)` → `p.floored()`
 * （`prismarine-world/src/world.js:229`）→ 裸 `{x,y,z}` 直接 TypeError。
 *
 * 共享夹具内部用它；**自己手写 bot 的测试也应当调用它**，而不是各自抄一遍
 * —— 抄出来的每一份都可能慢慢长歪（本项目的老毛病：同一件事两个名字）。
 *
 * @throws {TypeError} 传入的不是 Vec3 形状
 */
export function assertPointLike(p) {
    if (typeof p?.floored !== 'function') {
        throw new TypeError('point.floored is not a function（mineflayer 要 Vec3，裸对象会被拒）');
    }
}

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
 * 接受这些写法，省得每个测试自己拼字符串：
 *   - Map（复制一份，不改调用方的）
 *   - `[[x, y, z, name], ...]`
 *   - **`[[x, y, z, name, props], ...]`** ← t68 新增：方块**属性**（门开合 / 作物 age …）
 *   - `[{ x, y, z, name }, ...]`（atom_* 里那种位置对象）
 *   - `{ '0,63,0': 'stone' }`
 *
 * ★ 为什么属性挂在**这个函数的第 5 个元素**上，而不是再加一个 `blockProps` 选项：
 *   `worldOf` 已经是"描述世界"的**唯一入口**，而"这格是什么方块、它的状态是什么"
 *   本来就属于同一件事。**不新增第二个描述世界的入口**（今晚已经因为"两个名字指同一件事"
 *   栽过好几次）。现有所有 `worldOf([[x,y,z,name]])` 调用**一字不用改**（props 缺省空）。
 *
 * ★ 用法（属性只影响**假件造出来的方块对象**，不动 `blockAt` 的严格性）：
 *     worldOf([[0, 64, 0, 'oak_door', { open: true, facing: 'north' }]])
 *     worldOf([[0, 64, 0, 'wheat', { age: 7 }]])
 *   方块对象会带上 `properties` 与 `getProperties()`（真 mineflayer 也有这个方法）。
 *   **不要**为了属性回去写 `stubs.blockAt` —— 那就又绕过了 strictPoints。
 */
export function worldOf(entries = []) {
    const w = new Map();
    /** 键 → 属性对象（不塞进 Map 的 value，保持 `world.get(k)` 仍是方块名字符串）。 */
    const props = new Map();
    const put = (key, name, pr) => { w.set(key, name); if (pr && typeof pr === 'object') props.set(key, pr); };

    if (entries instanceof Map) {
        for (const [k, v] of entries) w.set(k, v);
        const p = entries.__props;                       // 让"复制一份"也带上属性
        if (p instanceof Map) for (const [k, v] of p) props.set(k, v);
    } else if (Array.isArray(entries)) {
        for (const e of entries) {
            if (Array.isArray(e)) put(blockKey(e[0], e[1], e[2]), e[3], e[4]);
            else if (e && typeof e === 'object') put(blockKey(e.x, e.y, e.z), e.name, e.props);
        }
    } else {
        for (const [k, v] of Object.entries(entries ?? {})) w.set(k, v);
    }

    // 非枚举属性：不干扰 Map 的遍历/序列化，只有本夹具（和想读它的测试）看得见。
    Object.defineProperty(w, '__props', { value: props, enumerable: false, configurable: true });
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
 * @param {boolean} [opts.strictPoints] **默认 true**：`blockAt` 必须收到 Vec3 形状的点
 *   （真 mineflayer 会 `pos.floored()`，裸对象直接 TypeError）。
 *   只在**明确知道自己要测什么**时才传 false，并在用例里写清为什么。
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
        strictPoints = true,
        gotoError = null,
        placeAs = null,
        username = 'fixture',
        // ★ 2026-11-03（t46）：**可选**的"走一格"模拟。
        //
        // 默认 `false` —— 保持本文件原有的"只记录不移动"语义，不影响任何既有用例。
        // 打开后：`lookAt(point)` 记住目标格 → 随后 `setControlState('forward', true)`
        // 就把 entity.position **挪进那一格**（并记 `bot.__walked`）。
        //
        // 为什么需要它：`act_step.stepInto` 的机制是 lookAt 格心 → holdKey('forward')
        // 轮询 `insideCell(p, target)`。真实 bot 靠物理走过去；假件原来两处都是空桩，
        // 于是 stepInto **必然 TIMEOUT**。凡是"挖开通道后要走进去"的用例（t46 隧道）
        // 在假件里都只能得到假红 —— 那是"假件不真"，不是产品错。
        //
        // 只模拟**水平相邻一格**（stepInto 的全部需求），不做物理/重力/跳跃。
        walkOnForward = false,
        stubs = {},
    } = opts;

    // ══════════════════════════════════════════════════════════════════════
    // ★★ 2026-11-04（t68）：**覆盖 `blockAt` = 放弃忠实度保护**，让它可见。
    //
    //   为什么需要这条警告：`strictPoints`（默认 true）只保护**默认**的 blockAt 实现；
    //   测试只要传 `stubs: { blockAt }`，就把那份严格实现**整个换掉**了 ——
    //   裸坐标检查随之失效。全仓盘点：60 处自定义 blockAt 桩里 **39 处**是这么覆盖进来的。
    //   **门是装了，但所有人都能从旁边绕过去** —— 而绕过去这件事以前**完全不可见**。
    //
    //   为什么不直接禁止：有些桩是**故意的**（例如只测"脚下是水"这一条分支，
    //   固定返回值反而更清晰）。所以这里不拦，只**报告**：一个用例跑起来就看见这行，
    //   作者就知道自己放弃了保护。
    //
    //   输出通道：默认 `console.warn`（stderr）。当 `unit_all` 跑批量时它设
    //   `FAKE_BOT_NOTICE_STDOUT=1`，本文件改走 stdout 并带机器可读标记，
    //   好让 `unit_all` 统计"有多少用例绕过了严格假件"——**那就是单测盲区宽度的下限**。
    // ══════════════════════════════════════════════════════════════════════
    const BYPASS_MARKER = '[fake_bot][STRICT-BYPASS]';
    if (stubs && Object.prototype.hasOwnProperty.call(stubs, 'blockAt')) {
        fakeBotStrictBypassCount++;
        if (process.env.FAKE_BOT_NOTICE !== '0') {
            const msg = `${BYPASS_MARKER} 覆盖了 blockAt 的严格默认实现：裸坐标检查失效（strictPoints 不再保护本用例）`;
            if (process.env.FAKE_BOT_NOTICE_STDOUT === '1') console.log(msg);
            else console.warn(`[fake_bot] ⚠ 你覆盖了 blockAt 的严格默认实现：裸坐标检查失效（strictPoints 不再保护这个用例）`);
        }
    }

    const world = worldOf(rawWorld);
    /** 键 → 方块属性（`worldOf` 第 5 个元素带进来的；没有就是空）。 */
    const worldProps = rawWorld?.__props instanceof Map ? rawWorld.__props : new Map();

    /** world 里的名字 → null（未加载）；`unloaded: 'air'` 时当空气。 */
    function readName(x, y, z) {
        const name = world.get(blockKey(x, y, z));
        if (name !== undefined) return name;
        return unloaded === 'air' ? 'air' : null;
    }

    function readBlock(v, dflt) {
        // ★★ 2026-11-04（t68）：**像真 mineflayer 一样挑剔**。
        //   真链路：`bot.blockAt(p)` → `world.getBlock(p)` → `p.floored()`
        //   （prismarine-world `world.js:229` `block.position = pos.floored()`）。
        //   裸对象没有 `.floored()` → 真机直接 TypeError。
        //
        //   为什么假件必须跟着挑剔：t70 那个真机 bug（`stand=null ×130`）就是
        //   `findStandNear` 传裸对象、抛错被 `catch` 吞成 null —— 而假件**收裸对象**，
        //   于是单测全绿、真机全 null。**假件太松 = 假绿**，这条现在是可执行断言。
        if (strictPoints) assertPointLike(v);
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
        // ★ t68：方块属性（门 open / 作物 age …）。真 mineflayer 的 block 也有 `getProperties()`。
        //   属性通过 `worldOf([[x,y,z,name,props]])` 带进来 —— **不需要也不允许**
        //   为此回去写 `stubs.blockAt`（那会绕过 strictPoints，把刚装的门又绕开）。
        const props = worldProps.get(blockKey(fx, fy, fz));
        if (props && typeof props === 'object') {
            block.properties = props;
            block.getProperties = () => props;
        }
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
        // 夹具自己的便捷读写：**包成 Vec3**，免得被自己的 strictPoints 拒掉
        getBlock: (x, y, z) => readBlock(new Vec3(x, y, z)),
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
        // ★ walkOnForward 打开时：记住"在看哪一格"，供 setControlState('forward') 走过去用。
        lookAt: async (point) => { if (walkOnForward && point) bot.__lookTarget = { x: point.x, y: point.y, z: point.z }; },
        look: async () => { },
        chat: (msg) => { bot.__chats.push(String(msg)); },
        activateBlock: async () => { },
        toss: async () => { },

        // ★ walkOnForward：按下 forward 就把她挪进"正在看的那一格"（模拟走一格）。
        //   只处理**水平相邻一格**（stepInto 的全部需求），不做重力/跳跃/多格行走。
        setControlState: (k, v) => {
            if (v) bot.__controls.set(k, true); else bot.__controls.delete(k);
            if (walkOnForward && v && k === 'forward') {
                const t = bot.__lookTarget;
                const cur = bot.entity.position;
                if (t && cur) {
                    const tx = Math.floor(t.x), ty = Math.floor(t.y) - 1, tz = Math.floor(t.z);
                    const d = Math.hypot(tx + 0.5 - cur.x, tz + 0.5 - cur.z);
                    if (d > 0 && d <= 1.6) {           // 只走一格，远了不动（不是无限瞬移）
                        bot.entity.position = new Vec3(tx + 0.5, ty, tz + 0.5);
                        bot.__walked.push({ x: tx, y: ty, z: tz });
                    }
                }
            }
        },
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
        // walkOnForward 的观测点：走过哪几格 / 当前在看哪一格
        __walked: [],
        __lookTarget: null,
    };

    // placeBlock 的别名：有的地方写 bot.place，有的写 bot.placeBlock
    bot.place = bot.placeBlock;

    return Object.assign(bot, stubs);
}
