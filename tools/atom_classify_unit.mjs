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

// 数据层路径可用 LANDMARKS_MODULE 覆盖 —— 只为「反向验证」用：
// 把修复前（读 c?.pos）的 landmarks.js 副本指进来，本测试必须变红；否则它只是在自证。
const LM = process.env.LANDMARKS_MODULE ?? '../src/agent/library/landmarks.js';
const { protectedPlaces, resetProtectedCache, rememberChest } = await import(LM);

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${actual}`); };

const BOT_A = { username: '__unit_y_semantics_a' };
const BOT_B = { username: '__unit_y_semantics_b' };
const BOT_C = { username: '__unit_y_semantics_c' };

function cleanup() {
    for (const b of [BOT_A, BOT_B, BOT_C]) {
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
//
// ★ 第8条 J3：夹具必须走**真的写入函数** rememberChest()。
//   旧夹具是 `writeStore(A,'chests',[{ pos:{x:100,…} }])` —— 那是**读端**（`c?.pos`）
//   才有的形状，真正的写入端 rememberChest / rememberSite / rememberStorageArea
//   存的是**扁平** {x,y,z,note,lastUsed}。用读端形状当夹具，等于自己把要测的
//   "读端取错路径"这个 bug 抹平了：生产里 protectedPlaces 恒返回 []，测试却全绿。
{
    const wroteA = rememberChest(BOT_A, { x: 100, y: 64, z: 100 }, 'A 的箱子');
    const wroteB = rememberChest(BOT_B, { x: -100, y: 64, z: -100 }, 'B 的箱子');
    resetProtectedCache(BOT_A);
    resetProtectedCache(BOT_B);

    const a = protectedPlaces(BOT_A);
    const b = protectedPlaces(BOT_B);

    const aHasOwn = a.some((s) => s.x === 100 && s.z === 100);
    const bHasOwn = b.some((s) => s.x === -100 && s.z === -100);
    const aLeaksB = a.some((s) => s.x === -100);
    const bLeaksA = b.some((s) => s.x === 100);

    if (wroteA && wroteB && aHasOwn && bHasOwn && !aLeaksB && !bLeaksA) {
        okCase('地标缓存按 bot 隔离', `A=${a.length} B=${b.length}`);
    } else {
        badCase('地标缓存按 bot 隔离',
            `写入=${wroteA}/${wroteB} A=${JSON.stringify(a)} B=${JSON.stringify(b)}`);
    }
}

// ── 5. 写读同形状：rememberChest 之后 protectedPlaces 必须非空，且真能判出保护 ──
//
// 这就是 J3 的直接断言：修之前 spots 恒为 []（读 c?.pos 而写的是扁平 x/y/z），
// 这道"别挖到玩家的箱子"的闸从写出来那天起没拦过任何东西。
{
    const wrote = rememberChest(BOT_C, { x: 7, y: 70, z: 9 }, 'C 的箱子');
    resetProtectedCache(BOT_C);
    const spots = protectedPlaces(BOT_C);
    const guard = isProtected({ x: 7, y: 70, z: 9 }, { spots });
    const judged = guard.ok && guard.data.protectedBy === 'landmark';
    if (wrote && spots.length > 0 && judged) {
        okCase('rememberChest 之后 protectedPlaces 非空且判得出保护',
            `spots=${spots.length} protectedBy=${guard.data.protectedBy} 形状=${JSON.stringify(spots[0])}`);
    } else {
        badCase('rememberChest 之后 protectedPlaces 非空且判得出保护',
            `写入=${wrote} spots=${JSON.stringify(spots)} protectedBy=${guard?.data?.protectedBy}`);
    }
}

// ── 6. 缓存命中：同一 bot 连续两次拿到同一份（不重复读盘）──────────────
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
