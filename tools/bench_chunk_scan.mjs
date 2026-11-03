// 性能基准：按「区块」扫描 vs 按「4 格热力单元」扫描，哪个快、覆盖多大。
// 关键问题：用户假设「扫区块更快」。这里拿真实数字。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
// ★ 2026-11-04（t74）：`bot.blockAt` 需要 **Vec3**（内部调 `pos.floored()`）；
//   原来这里传裸 `{x,y,z}` → 第一次迭代就 `TypeError` →
//   **"对照（逐格 blockAt）耗时"这个基准数字从来没产出过**（fixture 用严格假件盘出来的）。
import { Vec3 } from 'vec3';
import { rcon } from './rcon.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c);

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', (e) => { console.log('ERR', e.message); process.exit(1); });
bot.on('kicked', (r) => { console.log('KICKED', String(r).slice(0, 80)); process.exit(2); });

/** 直接读区块数据：给一个区块坐标，总结它的地表高度 / 水 / 岩浆 / 可走比例。 */
function scanChunk(cx, cz) {
    const column = bot.world.getColumn(cx, cz);
    if (!column) return null;

    let minY = 999, maxY = -999, water = 0, lava = 0, solid = 0, air = 0, samples = 0;
    // 每区块抽 8×8 个柱（不是 16×16），只找地表：精度够粗规划，速度快 4 倍
    for (let dx = 0; dx < 16; dx += 2) {
        for (let dz = 0; dz < 16; dz += 2) {
            const x = cx * 16 + dx;
            const z = cz * 16 + dz;
            // 从 y=120 往下找第一个非空气（跳过树叶）
            for (let y = 120; y >= -60; y--) {
                const b = column.getBlock({ x, y, z });
                if (!b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') { air++; continue; }
                if (b.name === 'water') { water++; continue; }
                if (b.name === 'lava') { lava++; continue; }
                solid++;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                break;
            }
            samples++;
        }
    }
    return { cx, cz, minY, maxY, water, lava, solid, samples };
}

bot.once('spawn', async () => {
    await sleep(2500);
    await RC('op probe');
    await RC('tp probe 0.5 -60 0.5');
    await sleep(2000);

    const center = { cx: Math.floor(bot.entity.position.x / 16), cz: Math.floor(bot.entity.position.z / 16) };
    console.log('中心区块', center, '位置', bot.entity.position.floored());

    // 预热：第一次读区块会触发 world 解析
    scanChunk(center.cx, center.cz);
    await sleep(300);

    // 测 16 个区块（4×4）
    const t0 = Date.now();
    let count = 0, nulls = 0;
    const rows = [];
    for (let dx = -2; dx < 2; dx++) {
        for (let dz = -2; dz < 2; dz++) {
            const r = scanChunk(center.cx + dx, center.cz + dz);
            if (!r) { nulls++; continue; }
            count++;
            rows.push(`(${r.cx},${r.cz}) 地表 y=${r.minY}..${r.maxY} 水=${r.water} 岩浆=${r.lava} 实心=${r.solid}/${r.samples}`);
        }
    }
    const ms = Date.now() - t0;
    console.log(`\n扫 16 个区块耗时 ${ms}ms（成功 ${count}，未加载 ${nulls}）→ ${(ms / Math.max(1, count)).toFixed(1)}ms/区块`);
    console.log(`覆盖范围：${4 * 16} × ${4 * 16} = ${4 * 16 * 4 * 16} 格`);
    console.log(rows.slice(0, 6).join('\n'));

    // 对照：现有热力图（4 格单元，9×9 = 36×36 格）
    const t1 = Date.now();
    let n = 0;
    for (let x = -18; x <= 18; x += 4) {
        for (let z = -18; z <= 18; z += 4) {
            for (let y = 120; y >= -60; y--) {
                // ★ t74：必须传 Vec3，不能传裸对象（真 mineflayer 内部调 pos.floored()）
                const b = bot.blockAt(new Vec3(x, y, z), false);
                if (b && b.name !== 'air') { n++; break; }
            }
        }
    }
    const ms1 = Date.now() - t1;
    console.log(`\n对照（逐格 bot.blockAt，9×9 单元 = 36×36 格）耗时 ${ms1}ms`);
    console.log(`效率对比：区块扫描 ${(ms / Math.max(1, count)).toFixed(1)}ms 覆盖 256 格/区块；逐格扫描 ${ms1}ms 覆盖 1296 格`);

    await RC('clear probe');
    bot.quit();
    process.exit(0);
});
