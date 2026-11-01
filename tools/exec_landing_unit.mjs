/**
 * executor 落点检查回归（D14）—— 不需要服务器。
 *
 * 缺陷原貌：execStep 的"落点安全检查"调 `columnSurfaces(mapDir, …)`，但 execStep 里没有 mapDir
 * （opts 只解构了 onEvent，调用处也只传 { onEvent }）→ 每次都抛 ReferenceError，
 * 被空 catch 吞掉。这段 10-28 加的检查从加上那天起一次都没执行过。
 *
 * 修复：walkTo 把 mapDir 传进来；不传（单测、直接调用）就跳过检查，和原来一样；
 *       查询出错发 landing-check-error 事件，不再静默；判据收窄为"落点那一格是危险面（T.LAVA）"。
 *       为什么不照原判据（"附近没有非水实地就拒"）启用：10-29 起规划器有意让她从水面过河
 *       （test_tunnel 用例 13），原判据会把这些步全拦掉。
 *
 * 判定方法：假 bot 的 pathfinder.goto 被调到 = 真的去走了（__moved）。
 *
 * 输出：PASS <用例> / FAIL <用例> <实际>，全过退出码 0。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execStep } from '../src/agent/library/executor.js';
import { saveSurfaces, closeDb3d, T } from '../src/agent/library/terrain3d.js';
import { makeFakeBot, worldOf, realRegistry } from './fixtures/fake_bot.mjs';

const REG = realRegistry();

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

/** 假 bot：脚在 (0,64,0)，脚下是石头；goto 直接把她挪到目标列（公共夹具，同 exec_step_y_unit）。 */
function makeBot() {
    return makeFakeBot({
        world: worldOf([['0,63,0', 'stone'], ['1,63,0', 'stone']]),
        feet: { x: 0, y: 64, z: 0 },
        posOffset: 0.5,        // 格中心
        gotoOffset: 0.5,
        unloaded: 'air',
        registry: REG,
        diggable: (name) => name !== 'bedrock',
    });
}

/** 按 cells 建一个临时 3D 库（cells 为 null 就不建），走一步 walk→(1,63,0)。 */
async function walkOnto(cells, { mapDir } = {}) {
    let dir = mapDir;
    let tmp = null;
    if (cells) {
        tmp = mkdtempSync(join(tmpdir(), 'landing-'));
        saveSurfaces(tmp, cells);
        dir = tmp;
    }
    const bot = makeBot();
    const events = [];
    const opts = { onEvent: (e) => events.push(e) };
    if (dir !== undefined) opts.mapDir = dir;
    try {
        const r = await execStep(bot, { action: 'walk', x: 1, y: 63, z: 0 }, opts);
        return { r, events, moved: bot.__moved };
    } finally {
        if (tmp) {
            closeDb3d(tmp);
            try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    }
}

const types = (ev) => ev.map((e) => e.type).join(',');

// 1. 落点是岩浆面 → UNSAFE，不走（修之前：检查没跑，照走）
{
    const { r, events, moved } = await walkOnto([{ x: 1, z: 0, y: 63, t: T.LAVA }]);
    check('落点是岩浆 → UNSAFE 且不走', r.code === 'UNSAFE' && !moved && events.some((e) => e.type === 'unsafe-landing'),
        `code=${r.code} moved=${moved} events=${types(events)}`);
}

// 2. 正常实地 → 照走
{
    const { r, moved } = await walkOnto([{ x: 1, z: 0, y: 63, t: T.SOLID }]);
    check('落点是实地 → 照走', moved && r.code !== 'UNSAFE', `code=${r.code} moved=${moved}`);
}

// 3. 水面（底下 13 格才是水底）→ 照走：规划器有意走水面过河，这里不拦
{
    const { r, moved } = await walkOnto([{ x: 1, z: 0, y: 63, t: T.WATER }, { x: 1, z: 0, y: 50, t: T.SUBMERGED }]);
    check('落点是水面 → 照走（不拦过河）', moved && r.code !== 'UNSAFE', `code=${r.code} moved=${moved}`);
}

// 4. 这一列库里没数据 → 不拦
{
    const { r, moved } = await walkOnto([{ x: 9, z: 9, y: 63, t: T.SOLID }]);
    check('这列没数据 → 不拦', moved && r.code !== 'UNSAFE', `code=${r.code} moved=${moved}`);
}

// 5. 不传 mapDir（单测 / 直接调用）→ 跳过检查，和原来一样，也不报错
{
    const { r, events, moved } = await walkOnto(null);
    check('不传 mapDir → 跳过检查', moved && !events.some((e) => e.type === 'landing-check-error'),
        `code=${r.code} moved=${moved} events=${types(events)}`);
}

// 6. mapDir 打不开 → 发 landing-check-error，不再静默；仍然照走（查不到就不拦）
{
    const bad = join(tmpdir(), `landing-missing-${Date.now()}`, 'no', 'such', 'dir');
    const { r, events, moved } = await walkOnto(null, { mapDir: bad });
    check('库打不开 → 发 landing-check-error 且照走', moved && events.some((e) => e.type === 'landing-check-error'),
        `code=${r.code} moved=${moved} events=${types(events)}`);
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
