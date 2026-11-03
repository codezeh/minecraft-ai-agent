/**
 * tool_prep 超时回归测试（D12）—— 不需要服务器。
 *
 * 场景：`ensureScaffold` 挖完方块后要去捡掉落物，走的是 `bot.pathfinder.goto()`。
 * 修复前这个 goto **没有上限**：目标被挡住/区块卸载/服务端不回包时会永远挂着，
 * 于是整条砍树链路卡死——外层 deadline 在循环里检查，进不到循环就没人管。
 *
 * 本测试用一个「goto 永不 resolve」的假 bot，断言：
 *   1) ensureScaffold 仍在限时内返回（不挂死）；
 *   2) 超时后调用了 pathfinder.stop()（不复位的话下次 goto 会报 "Path was stopped"）；
 *   3) 返回的是「没凑够」这个诚实结论，而不是假装成功。
 *
 * 输出格式沿用原子测试约定：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import { ensureScaffold } from '../src/agent/library/tool_prep.js';
import { assertPointLike } from './fixtures/fake_bot.mjs';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${actual}`); };

/**
 * 假 bot：
 * - 背包永远是空的（countScaffold 一直是 0）
 * - blockAt 返回可挖的 dirt（除了脚下那格）
 * - dig 立刻成功，但**掉落物不会被吸进来**（模拟"挖了但捡不到"）
 * - nearestEntity 返回一个掉落物，于是代码会走 pathfinder.goto
 * - pathfinder.goto 永不 resolve（这就是被修复的 bug）
 */
function makeBot() {
    let stopCalls = 0;
    const never = new Promise(() => { });        // 永不 resolve
    return {
        entity: { position: { x: 0, y: 64, z: 0 } },
        inventory: { items: () => [] },
        dig: async () => { },
        blockAt: (v) => {
            // ★ t68：严格守卫（与共享夹具同一条判据）—— 裸坐标要像真 mineflayer 一样被拒
            assertPointLike(v);
            const p = v;
            // 脚下那格给实心（防掉落判定），其余给 dirt
            if (p.x === 0 && p.y === 63 && p.z === 0) return { name: 'stone', position: p };
            return { name: 'dirt', position: p };
        },
        nearestEntity: () => ({ name: 'item', position: { x: 1, y: 64, z: 0 } }),
        pathfinder: {
            goals: {},
            goto: () => never,
            stop: () => { stopCalls++; },
        },
        get __stopCalls() { return stopCalls; },
    };
}

const t0 = Date.now();
const bot = makeBot();
const r = await ensureScaffold(bot, { need: 2, maxMs: 12000 });
const elapsed = Date.now() - t0;

// ── 1. 不挂死：必须在 maxMs 附近返回（留 6s 余量给 dig/craft 上限）────────
if (elapsed < 20000) {
    okCase('goto 永不返回时仍能收尾', `elapsed=${elapsed}ms`);
} else {
    badCase('goto 永不返回时仍能收尾', `elapsed=${elapsed}ms（疑似挂死）`);
}

// ── 2. 超时后必须 stop pathfinder ────────────────────────────────────
if (bot.__stopCalls >= 1) {
    okCase('超时后调用了 pathfinder.stop', `calls=${bot.__stopCalls}`);
} else {
    badCase('超时后调用了 pathfinder.stop', `calls=${bot.__stopCalls}（下次 goto 会报 Path was stopped）`);
}

// ── 3. 诚实结论：没凑够就说没凑够 ─────────────────────────────────────
if (r && r.ok === false && typeof r.why === 'string') {
    okCase('返回诚实失败而不是假装成功', `ok=${r.ok} have=${r.have} why=${r.why}`);
} else {
    badCase('返回诚实失败而不是假装成功', JSON.stringify(r));
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
