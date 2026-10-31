/**
 * live 测试的"场地租借"助手。
 *
 * 为什么需要（2026-11-01 踩了两次）：
 *   live 测试原来都在**世界出生点附近**造地形（每个 bot 的 spawn 点基本是同一个）。
 *   后果一：彼此的场地会重叠，一个测试造的方块把另一个测试搞挂
 *           （实测：verify_escape_live 的石笼让 vine_physics_test 的"爬模式"升高 0 格）。
 *   后果二：想挪远去造地形也不行 —— 远处区块没加载，`/fill` **静默失败**，
 *           第一版把场地放到 +50 格，坑没造出来，她从 y=-60 直接掉到 y=-96。
 *
 * 正确做法：用 `/forceload add` 把远处区块强制加载，然后随便造；
 *   结束时填回空气并 `/forceload remove`，不留痕迹、不碰出生点。
 *
 * 用法：
 *   const arena = await rentArena(RC, 'escape');       // 拿一块远处的空地
 *   ... 用 arena.x / arena.z 造东西 ...
 *   await arena.release();                              // 收尾（清方块 + 取消 forceload）
 */

/** 每个测试用一个不同的基点，横向间隔 64 格，互不重叠。 */
const ARENA_SLOTS = {
    escape: { x: 6000, z: 6000 },
    trapped: { x: 6000, z: 7000 },
    move: { x: 8000, z: 6000 },
    actions: { x: 10000, z: 6000 },
    default: { x: 6000, z: 8000 },
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 把世界坐标换成 chunk 坐标（forceload 用） */
const chunkOf = (v) => Math.floor(v / 16);

/**
 * 安全 fill：把大范围切成小块再发。
 *
 * ★ 踩过的坑（2026-11-01）：Minecraft 的 /fill 单次上限是 **32768 格**，
 *   超过就直接失败（我们这里还是静默的）。arena halfSize=28 的清空是 57×57×129
 *   ≈ 419,000 格 → 命令全部失败 → 场地从没被清过 → 上一次测试的残留石头还在，
 *   人 tp 进去站在实心方块里，plan3D 一律 NO_START，看起来像"导航坏了"。
 *
 * 切块后每块 ≤ 16×16×16 = 4096 格，远低于上限。
 */
const FILL_MAX = 16;

export async function fillSafe(RC, x0, y0, z0, x1, y1, z1, block) {
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
    const ay = Math.min(y0, y1), by = Math.max(y0, y1);
    const az = Math.min(z0, z1), bz = Math.max(z0, z1);
    for (let x = ax; x <= bx; x += FILL_MAX) {
        for (let y = ay; y <= by; y += FILL_MAX) {
            for (let z = az; z <= bz; z += FILL_MAX) {
                const ex = Math.min(x + FILL_MAX - 1, bx);
                const ey = Math.min(y + FILL_MAX - 1, by);
                const ez = Math.min(z + FILL_MAX - 1, bz);
                try { await RC(`fill ${x} ${y} ${z} ${ex} ${ey} ${ez} ${block}`); } catch { /* 跳过失败块 */ }
            }
        }
    }
}

/**
 * 租一块远处的场地。
 *
 * @param {(cmd:string)=>Promise<any>} RC rcon 调用函数
 * @param {string} slot 场地名（见 ARENA_SLOTS）
 * @param {object} opts  { halfSize=16, y0=-64, y1=64, groundY=-61 }
 * @returns {Promise<{x:number, z:number, groundY:number, release:Function}>}
 */
export async function rentArena(RC, slot = 'default', opts = {}) {
    const { halfSize = 16, y0 = -64, y1 = 64, groundY = -61 } = opts;
    const base = ARENA_SLOTS[slot] ?? ARENA_SLOTS.default;

    const x = base.x, z = base.z;
    // 覆盖 ±halfSize 需要 forceload 多个 chunk：按 16 一格铺满
    const c0x = chunkOf(x - halfSize), c1x = chunkOf(x + halfSize);
    const c0z = chunkOf(z - halfSize), c1z = chunkOf(z + halfSize);
    for (let cx = c0x; cx <= c1x; cx++) {
        for (let cz = c0z; cz <= c1z; cz++) {
            try { await RC(`forceload add ${cx * 16} ${cz * 16}`); } catch { /* 已加载也行 */ }
        }
    }
    await sleep(600);   // 等区块真的加载

    // 清空 + 铺地（必须切块，否则超过 /fill 的 32768 上限会静默失败）
    await fillSafe(RC, x - halfSize, y0, z - halfSize, x + halfSize, y1, z + halfSize, 'air');
    await fillSafe(RC, x - halfSize, groundY, z - halfSize, x + halfSize, groundY, z + halfSize, 'stone');
    await sleep(600);

    return {
        x, z, groundY,
        /** 收尾：填回空气（留一层地）并取消 forceload */
        async release() {
            try {
                await fillSafe(RC, x - halfSize, y0 + 1, z - halfSize, x + halfSize, y1, z + halfSize, 'air');
                await fillSafe(RC, x - halfSize, groundY, z - halfSize, x + halfSize, groundY, z + halfSize, 'stone');
            } catch { /* 清不掉不影响结论 */ }
            for (let cx = c0x; cx <= c1x; cx++) {
                for (let cz = c0z; cz <= c1z; cz++) {
                    try { await RC(`forceload remove ${cx * 16} ${cz * 16}`); } catch { /* ignore */ }
                }
            }
        },
    };
}
