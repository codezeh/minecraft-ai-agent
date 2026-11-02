#!/usr/bin/env node
/**
 * 坠落/虚空反射单测（query_safe.fallRisk）。
 *
 * 为什么需要（2026-11-02 用户指出"悬崖等危险区域按理要有条件反射"）：
 *   系统原来只有 executor 里一条"落点是岩浆就别去"，悬崖和虚空**从来没拦过**。
 *   实测两次事故：gap-bridge 掉出世界摔死、digdown 走出盖板边缘掉下去导致无限循环。
 *
 * 本测试用假 terrain3d 库（临时 sqlite 目录），不连服务器。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveSurfaces, closeDb3d, T } from '../src/agent/library/terrain3d.js';
import { fallRisk } from '../src/agent/library/query_safe.js';

let pass = 0, fail = 0;
const okCase = (name, extra = '') => { pass++; console.log(`PASS ${name}${extra ? '  ' + extra : ''}`); };
const badCase = (name, extra = '') => { fail++; console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`); };

const dir = mkdtempSync(join(tmpdir(), 'fallrisk-'));

/** 在某个 (x,z) 列里铺一批面。rows: [{y, t}] */
function putColumn(x, z, rows) {
    saveSurfaces(dir, rows.map((r) => ({ x, z, y: r.y, t: r.t })));
}

try {
    // ── 1. 脚下就是实心：安全，drop=0 ────────────────────────────────
    putColumn(0, 0, [{ y: 63, t: T.SOLID }]);
    {
        const r = fallRisk({}, dir, { x: 0, y: 64, z: 0 });   // 脚位 64，下面 63 实心
        if (r.ok && r.data.safe === true && r.data.drop === 0) okCase('脚下实心 → 安全', `drop=${r.data.drop}`);
        else badCase('脚下实心 → 安全', JSON.stringify(r));
    }

    // ── 2. 落差 3 格（在上限 4 内）：安全 ────────────────────────────
    putColumn(1, 0, [{ y: 60, t: T.SOLID }]);
    {
        const r = fallRisk({}, dir, { x: 1, y: 64, z: 0 });
        if (r.ok && r.data.safe === true && r.data.drop === 3) okCase('落差 3 格（≤上限4）→ 安全', `drop=${r.data.drop}`);
        else badCase('落差 3 格（≤上限4）→ 安全', JSON.stringify(r.data));
    }

    // ── 3. 落差 10 格：不安全（这是悬崖）────────────────────────────
    putColumn(2, 0, [{ y: 54, t: T.SOLID }]);
    {
        const r = fallRisk({}, dir, { x: 2, y: 64, z: 0 });
        if (r.ok && r.data.safe === false && r.data.drop === 9) okCase('落差 9 格（>上限4）→ 拒绝', r.data.reason);
        else badCase('落差 9 格（>上限4）→ 拒绝', JSON.stringify(r.data));
    }

    // ── 4. 有数据但下方没有可落的面：判虚空 → 拒绝 ─────────────────
    //    注意：CLIMBABLE 不是落脚点，必须被排除（T 的注释明写）
    putColumn(3, 0, [{ y: 70, t: T.CLIMBABLE }]);
    {
        const r = fallRisk({}, dir, { x: 3, y: 64, z: 0 });
        if (r.ok && r.data.safe === false && r.data.voidBelow === true) okCase('下方只有可攀爬（不算落脚）→ 判虚空', r.data.reason);
        else badCase('下方只有可攀爬（不算落脚）→ 判虚空', JSON.stringify(r.data));
    }

    // ── 5. **这列没数据**：不拦，但标记 unknown ─────────────────────
    //    这条是关键：区块没加载 ≠ 下面是虚空。把"不知道"当成"确定危险"
    //    会把所有未扫描区域的移动全拦死。
    {
        const r = fallRisk({}, dir, { x: 999, y: 64, z: 999 });
        if (r.ok && r.data.safe === true && r.data.unknown === true) okCase('列无数据 → 不拦且标 unknown', r.data.reason);
        else badCase('列无数据 → 不拦且标 unknown', JSON.stringify(r.data));
    }

    // ── 6. 水面能落（过河场景不能误拦）──────────────────────────────
    putColumn(4, 0, [{ y: 55, t: T.WATER }]);
    {
        const r = fallRisk({}, dir, { x: 4, y: 58, z: 0 });
        if (r.ok && r.data.safe === true && r.data.drop === 2 && r.data.supportType === T.WATER) {
            okCase('落在水面上且落差 2 → 安全（不误拦过河）', `supportType=${r.data.supportType}`);
        } else badCase('落在水面上且落差 2 → 安全（不误拦过河）', JSON.stringify(r.data));
    }

    // ── 7. 没 mapDir：明确报错，不静默放过 ──────────────────────────
    {
        const r = fallRisk({}, null, { x: 0, y: 64, z: 0 });
        if (!r.ok && r.code === 'INTERNAL') okCase('无 mapDir → INTERNAL（不静默）', r.message);
        else badCase('无 mapDir → INTERNAL（不静默）', JSON.stringify(r));
    }

    // ── 8. cell 非法：NO_TARGET ─────────────────────────────────────
    {
        const r = fallRisk({}, dir, { x: NaN, y: 1, z: 2 });
        if (!r.ok && r.code === 'NO_TARGET') okCase('cell 非法 → NO_TARGET', r.message);
        else badCase('cell 非法 → NO_TARGET', JSON.stringify(r));
    }

    // ── 9. maxDrop 可调：同一列，放宽后应变安全 ─────────────────────
    {
        const strict = fallRisk({}, dir, { x: 2, y: 64, z: 0 }, { maxDrop: 4 });
        const loose = fallRisk({}, dir, { x: 2, y: 64, z: 0 }, { maxDrop: 20 });
        if (strict.data.safe === false && loose.data.safe === true) okCase('maxDrop 可调（4 拒 / 20 放）');
        else badCase('maxDrop 可调（4 拒 / 20 放）', JSON.stringify([strict.data.safe, loose.data.safe]));
    }
} finally {
    try { closeDb3d(dir); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('='.repeat(44));
console.log(`${pass}/${pass + fail} 个用例通过`);
process.exit(fail ? 1 : 0);
