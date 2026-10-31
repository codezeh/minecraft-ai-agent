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
    default: { x: 6000, z: 8000 },
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 把世界坐标换成 chunk 坐标（forceload 用） */
const chunkOf = (v) => Math.floor(v / 16);

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

    // 清空 + 铺地
    await RC(`fill ${x - halfSize} ${y0} ${z - halfSize} ${x + halfSize} ${y1} ${z + halfSize} air`);
    await RC(`fill ${x - halfSize} ${groundY} ${z - halfSize} ${x + halfSize} ${groundY} ${z + halfSize} stone`);
    await sleep(600);

    return {
        x, z, groundY,
        /** 收尾：填回空气（留一层地）并取消 forceload */
        async release() {
            try {
                await RC(`fill ${x - halfSize} ${y0 + 1} ${z - halfSize} ${x + halfSize} ${y1} ${z + halfSize} air`);
                await RC(`fill ${x - halfSize} ${groundY} ${z - halfSize} ${x + halfSize} ${groundY} ${z + halfSize} stone`);
            } catch { /* 清不掉不影响结论 */ }
            for (let cx = c0x; cx <= c1x; cx++) {
                for (let cz = c0z; cz <= c1z; cz++) {
                    try { await RC(`forceload remove ${cx * 16} ${cz * 16}`); } catch { /* ignore */ }
                }
            }
        },
    };
}
