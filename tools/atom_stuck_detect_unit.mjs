/**
 * atom_stuck_detect 单元测试 —— 不需要服务器。
 *
 * 锁的是实测结论，不是"我觉得"：
 *   - 水平位移 1:1，垂直权重 1.5
 *   - 垂直位移**必须**进判据：实测旧代码只算 hypot(dx,dz)，
 *     于是"挖上去 1 格"被判成没动，连续 3 次误判 NO_REACH，
 *     而她明明在往上爬（y 55→70 全靠这个）
 *   - 汇报"走了多少"用真实位移，不做加权（否则日志虚高）
 *   - 坐标是 NaN 时不许算出 NaN（返回 moved:false，让上层保守处理）
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import { movedEnough, weightedMove, realMove, DEFAULT_MIN_MOVE } from '../src/agent/library/atom_stuck_detect.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${actual}`); };

// ── 1. 纯垂直上升 1 格必须算"动了" ────────────────────────────────────
// 加权 1*1.5=1.5 < 2 → 按默认阈值**不算**动……
// 但实测要求是"垂直要进判据"，不是"1 格垂直就够"。
// 真实场景：挖上去时每轮 y 涨 1~3 格，配合水平位移就会过阈值。
// 所以这里锁的是：1 格垂直单独不够（1.5<2），2 格垂直就够（3>=2）。
{
    const one = movedEnough({ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 });
    const two = movedEnough({ x: 0, y: 64, z: 0 }, { x: 0, y: 66, z: 0 });
    if (one.data.moved === false && one.data.gap === 1.5 && two.data.moved === true) {
        okCase('垂直位移进判据（1 格 1.5 / 2 格 3.0）', `gap1=${one.data.gap} gap2=${two.data.gap}`);
    } else {
        badCase('垂直位移进判据（1 格 1.5 / 2 格 3.0）', JSON.stringify({ one: one.data, two: two.data }));
    }
}

// ── 2. 只算水平的话"上 1 格 + 水平 0.6"会被判没动；加权后应判动 ───────
{
    const r = movedEnough({ x: 0, y: 64, z: 0 }, { x: 0.6, y: 65, z: 0 });
    // 水平 0.6 + 垂直 1*1.5 = 2.1 >= 2
    if (r.data.moved === true && Math.abs(r.data.gap - 2.1) < 1e-9) {
        okCase('水平+垂直组合过阈值', `gap=${r.data.gap}`);
    } else {
        badCase('水平+垂直组合过阈值', JSON.stringify(r.data));
    }
}

// ── 3. 原地不动 → 没动 ────────────────────────────────────────────────
{
    const r = movedEnough({ x: 5, y: 64, z: 5 }, { x: 5, y: 64, z: 5 });
    if (r.data.moved === false && r.data.gap === 0) okCase('原地不动判没动', 'gap=0');
    else badCase('原地不动判没动', JSON.stringify(r.data));
}

// ── 4. 阈值可覆盖：把 minMove 调到 0.5，1 格垂直就算动 ────────────────
{
    const r = movedEnough({ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 }, { minMove: 0.5 });
    if (r.data.moved === true) okCase('阈值可覆盖', `minMove=0.5 gap=${r.data.gap}`);
    else badCase('阈值可覆盖', JSON.stringify(r.data));
}

// ── 5. 真实位移不加权（防止日志虚高）──────────────────────────────────
{
    const w = weightedMove({ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 });   // 1.5
    const real = realMove({ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 });    // 1.0
    if (Math.abs(w - 1.5) < 1e-9 && Math.abs(real - 1) < 1e-9) {
        okCase('加权位移 vs 真实位移分开', `weighted=${w} real=${real}`);
    } else {
        badCase('加权位移 vs 真实位移分开', `weighted=${w} real=${real}`);
    }
}

// ── 6. NaN 坐标不许算出 NaN ───────────────────────────────────────────
{
    const r = movedEnough({ x: NaN, y: 64, z: 0 }, { x: 0, y: 64, z: 0 });
    const notNaN = Number.isFinite(r.data.gap) && r.data.moved === false;
    if (notNaN) okCase('NaN 坐标不污染判据', `gap=${r.data.gap} why=${r.data.why}`);
    else badCase('NaN 坐标不污染判据', JSON.stringify(r.data));
}

// ── 7. 默认阈值常量有出处（2）────────────────────────────────────────
{
    const r = movedEnough({ x: 0, y: 64, z: 0 }, { x: DEFAULT_MIN_MOVE, y: 64, z: 0 });
    if (r.data.moved === true && r.data.minMove === DEFAULT_MIN_MOVE) {
        okCase('默认阈值边界（gap 恰好=minMove 算动）', `minMove=${DEFAULT_MIN_MOVE}`);
    } else {
        badCase('默认阈值边界（gap 恰好=minMove 算动）', JSON.stringify(r.data));
    }
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
