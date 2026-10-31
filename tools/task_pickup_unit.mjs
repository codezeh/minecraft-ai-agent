/**
 * task_pickup.collectDrops 的搬迁回归测试 —— 不需要服务器。
 *
 * 背景：这个函数原来在 atom_drops.js（原子层），Phase 2.1 把它整体搬到复合层
 * （循环/重试/多步决策属于复合层职责）。行为应当**零变化**，
 * 所以这里只锁"搬迁没把基本语义改坏"：
 *   - 无坐标 → NO_TARGET
 *   - 已中断 → INTERRUPTED
 *   - 背包立刻涨了 → ok（走 wait-short，不需要寻路）
 *   - countFn 一直抛错 → INTERNAL（判据不可用比"没捡到"更该上报）
 *
 * 需要真机的部分（走过去捡、逐层下探）仍由 tools/atom_drops.mjs 覆盖，
 * 那个脚本要求测试服 25566。
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import { collectDrops } from '../src/agent/library/task_pickup.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${actual}`); };

/** 最小假 bot：够让 collectDrops 走完提前返回的分支。 */
function makeBot({ interrupted = false } = {}) {
    return {
        entity: {
            position: { x: 0, y: 64, z: 0 },
            // 收尾那段会读"离 origin 多远"，用带 hypot 的普通对象即可
        },
        interrupt_code: interrupted ? 'USER_STOP' : null,
        clearControlStates: () => { },
        // findStandSpot / canStand 会读方块；读不到(null) → 找不到站位 → 直接收尾
        blockAt: () => null,
        // findDrops 会遍历实体；给空列表
        entities: {},
    };
}

// ── 1. 无坐标 → NO_TARGET ─────────────────────────────────────────────
{
    const r = await collectDrops(makeBot(), null, {});
    if (!r.ok && r.code === 'NO_TARGET') okCase('无坐标 → NO_TARGET', r.code);
    else badCase('无坐标 → NO_TARGET', JSON.stringify(r));
}

// ── 2. 已中断 → INTERRUPTED ──────────────────────────────────────────
{
    const r = await collectDrops(makeBot({ interrupted: true }), { x: 0, y: 64, z: 0 }, {});
    if (!r.ok && r.code === 'INTERRUPTED') okCase('已中断 → INTERRUPTED', r.code);
    else badCase('已中断 → INTERRUPTED', JSON.stringify(r));
}

// ── 3. 背包立刻涨了 → ok（第一个等待窗口内就算成功）──────────────────
{
    let n = 0;
    const r = await collectDrops(makeBot(), { x: 0, y: 64, z: 0 }, {
        countFn: () => (n += 1),      // 每次调用都 +1，第一次快照后就满足"有增量"
        deadlineMs: 3000,
    });
    const hasStep = Array.isArray(r.data?.steps) && r.data.steps.length > 0;
    if (r.ok && r.data.gained >= 1 && hasStep) {
        okCase('背包立刻涨 → ok', `gained=${r.data.gained} steps=${r.data.steps.length}`);
    } else {
        badCase('背包立刻涨 → ok', JSON.stringify(r));
    }
}

// ── 4. countFn 一直抛错 → INTERNAL（判据不可用要上报）────────────────
{
    const r = await collectDrops(makeBot(), { x: 0, y: 64, z: 0 }, {
        countFn: () => { throw new Error('背包未就绪'); },
        deadlineMs: 1200,
        radius: 0,                     // 别去找实体，尽快走到收尾
    });
    if (!r.ok && r.code === 'INTERNAL' && /countFn/.test(String(r.message ?? ''))) {
        okCase('countFn 抛错 → INTERNAL', r.code);
    } else {
        badCase('countFn 抛错 → INTERNAL', JSON.stringify(r));
    }
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
