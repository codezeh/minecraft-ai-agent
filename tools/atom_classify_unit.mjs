/**
 * atom_classify 纯函数化 + 地标缓存隔离的回归测试 —— 不需要服务器。
 *
 * 规范化前的问题（REFACTOR_ANALYSIS §5 Phase 2.1「atom_classify → landmarks 读写改为参数传递」）：
 *   - `isProtected(bot, pos)` 自己 `loadLandmarks(bot)`，**原子读盘**
 *   - 用模块级变量 `landmarkCache` / `landmarkCacheAt` 缓存 60 秒 = **读写全局状态**
 *   - 缓存不区分 bot：多 Bot 时后连的那个会读到前一个的地标
 *
 * 现在：加载 + 缓存归数据层 `landmarks.protectedPlaces(bot)`（WeakMap 按 bot 隔离），
 * `atom_classify.isProtected(pos, { spots })` 是纯判断。
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import { rmSync } from 'node:fs';
import { isProtected } from '../src/agent/library/query_classify.js';
import { protectedPlaces, resetProtectedCache } from '../src/agent/library/landmarks.js';
import { writeStore } from '../src/agent/library/memory_store.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${actual}`); };

const BOT_A = { username: '__unit_y_semantics_a' };
const BOT_B = { username: '__unit_y_semantics_b' };

function cleanup() {
    for (const b of [BOT_A, BOT_B]) {
        try { rmSync(`bots/${b.username}`, { recursive: true, force: true }); } catch { }
        resetProtectedCache(b);
    }
}
cleanup();

// ── 1. 纯函数：给了 spots 就能判出受保护 ──────────────────────────────
{
    const r = isProtected({ x: 10, y: 64, z: 10 }, { spots: [{ x: 10, y: 64, z: 10 }], radius: 6 });
    if (r.ok && r.data.protectedBy === 'landmark') {
        okCase('传入地标即判保护', `protectedBy=${r.data.protectedBy}`);
    } else {
        badCase('传入地标即判保护', JSON.stringify(r));
    }
}

// ── 2. 纯函数：不给 spots 就不保护（不再偷偷读盘）──────────────────────
{
    const r = isProtected({ x: 10, y: 64, z: 10 });
    if (r.ok && r.data.protectedBy === null) {
        okCase('不传地标则不读盘、不保护', `protectedBy=${r.data.protectedBy}`);
    } else {
        badCase('不传地标则不读盘、不保护', JSON.stringify(r));
    }
}

// ── 3. 距离边界：命中半径内 vs 半径外 ─────────────────────────────────
{
    const spots = [{ x: 0, y: 64, z: 0 }];
    const inside = isProtected({ x: 5, y: 64, z: 0 }, { spots, radius: 6 });
    const outside = isProtected({ x: 7, y: 64, z: 0 }, { spots, radius: 6 });
    if (inside.data.protectedBy === 'landmark' && outside.data.protectedBy === null) {
        okCase('保护半径边界正确', 'inside=保护 outside=不保护');
    } else {
        badCase('保护半径边界正确', `inside=${inside.data.protectedBy} outside=${outside.data.protectedBy}`);
    }
}

// ── 4. 缓存按 bot 隔离：A 的箱子不能出现在 B 的地标里 ──────────────────
{
    writeStore(BOT_A, 'chests', [{ pos: { x: 100, y: 64, z: 100 }, note: 'A 的箱子' }]);
    writeStore(BOT_B, 'chests', [{ pos: { x: -100, y: 64, z: -100 }, note: 'B 的箱子' }]);

    const a = protectedPlaces(BOT_A);
    const b = protectedPlaces(BOT_B);

    const aHasOwn = a.some((s) => s.x === 100 && s.z === 100);
    const bHasOwn = b.some((s) => s.x === -100 && s.z === -100);
    const aLeaksB = a.some((s) => s.x === -100);
    const bLeaksA = b.some((s) => s.x === 100);

    if (aHasOwn && bHasOwn && !aLeaksB && !bLeaksA) {
        okCase('地标缓存按 bot 隔离', `A=${a.length} B=${b.length}`);
    } else {
        badCase('地标缓存按 bot 隔离', `A=${JSON.stringify(a)} B=${JSON.stringify(b)}`);
    }
}

// ── 5. 缓存命中：同一 bot 连续两次拿到同一份（不重复读盘）──────────────
{
    const first = protectedPlaces(BOT_A);
    const second = protectedPlaces(BOT_A);
    if (first === second) {
        okCase('同 bot 命中缓存（同一数组引用）', 'same ref');
    } else {
        badCase('同 bot 命中缓存（同一数组引用）', 'different refs');
    }
}

cleanup();

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
