// 验证剩下两项改动的通用性（不是只看单张地图）：
//   A) 失败记忆：走过失败的格子被加价后，是否真的绕开
//   B) tie-breaker：重复调用同一查询，是否给出相同路径（消除振荡）
//
// 做法：7 种地形 × 多组随机起终点，测：
//   1) 确定性：同一 from/to 调用 3 次，路径签名是否完全一致
//   2) 失败记忆有效性：给路径中间某点记失败，路径是否改道且代价上升

import { mkdirSync, rmSync } from 'node:fs';
import { plan3D } from '../src/agent/library/path_3d.js';
import { saveSurfaces, recordFail, clearFail, T } from '../src/agent/library/terrain3d.js';

const SIZE = 64, BASE_Y = 64, TRIALS = 12;

function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function makeWorld(kind) {
    const cells = [], N = SIZE;
    const push = (x, z, y, t = T.SOLID) => cells.push({ x, z, y, t });
    if (kind === 'flat') {
        for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) push(x, z, BASE_Y);
    } else if (kind === 'hills') {
        for (let x = 0; x < N; x++) for (let z = 0; z < N; z++)
            push(x, z, BASE_Y + Math.round(2 * Math.sin(x / 6) + 2 * Math.cos(z / 8)));
    } else if (kind === 'cliffs') {
        for (let x = 0; x < N; x++) for (let z = 0; z < N; z++)
            push(x, z, BASE_Y + Math.floor(x / 10) * 3);
    } else if (kind === 'maze') {
        for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) {
            const wallX = x % 8 === 0, wallZ = z % 8 === 0;
            const doorX = (z % 8) === 4, doorZ = (x % 8) === 4;
            if ((wallX && !doorX) || (wallZ && !doorZ)) continue;
            push(x, z, BASE_Y);
        }
    } else if (kind === 'water') {
        for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) {
            const d = Math.hypot(x - N / 2, z - N / 2);
            if (d < 16) { push(x, z, 59); push(x, z, 63, T.WATER); }
            else push(x, z, BASE_Y);
        }
    } else if (kind === 'cave') {
        for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) {
            push(x, z, 44);
            const shaft = (x % 8 === 3) && (z % 8 === 3);
            push(x, z, shaft ? 70 : 58);
        }
    } else if (kind === 'mixed') {
        for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) {
            if (x < N / 2) push(x, z, BASE_Y + Math.round(2 * Math.sin(x / 6) + 2 * Math.cos(z / 8)));
            else {
                if (x % 8 === 0 && (z % 8) !== 4) continue;
                push(x, z, BASE_Y + 1);
            }
        }
        for (let x = 30; x <= 33; x++) for (let z = 0; z < N; z++) {
            for (let i = cells.length - 1; i >= 0; i--) if (cells[i].x === x && cells[i].z === z) cells.splice(i, 1);
            push(x, z, BASE_Y - 3); push(x, z, BASE_Y, T.WATER);
        }
    }
    return cells;
}

const sig = (plan) => plan.ok ? plan.path.map(p => `${p.x},${p.y},${p.z}`).join('|') : 'FAIL';

const KINDS = ['flat', 'hills', 'cliffs', 'maze', 'water', 'cave', 'mixed'];
console.log(`基准：${KINDS.length} 种地形 × ${TRIALS} 组\n`);

let detTotal = 0, detSame = 0;      // 确定性
let failTotal = 0, failDetour = 0;  // 失败记忆是否真的改道
let costUp = 0;                     // 代价是否上升

console.log('地形      确定性  失败记忆改道  代价上升');
for (const kind of KINDS) {
    const dir = `C:/Users/zeh/AppData/Local/Temp/fm-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    mkdirSync(dir, { recursive: true });
    const cells = makeWorld(kind);
    saveSurfaces(dir, cells);
    const r = rng(kind.length * 3571 + 11);

    let dSame = 0, dTot = 0, fDetour = 0, fTot = 0, cUp = 0;

    for (let t = 0; t < TRIALS; t++) {
        let a = null;
        for (let k = 0; k < 200; k++) {
            const x = 3 + Math.floor(r() * (SIZE - 6));
            const z = 3 + Math.floor(r() * (SIZE - 6));
            const hit = cells.find(c => c.x === x && c.z === z);
            if (hit) { a = { x, y: hit.y + 1, z }; break; }
        }
        if (!a) continue;
        const ang = r() * Math.PI * 2, dist = 20 + r() * 20;
        const tx = Math.round(a.x + Math.cos(ang) * dist);
        const tz = Math.round(a.z + Math.sin(ang) * dist);
        if (tx < 2 || tx >= SIZE - 2 || tz < 2 || tz >= SIZE - 2) continue;
        const hit = cells.find(c => c.x === tx && c.z === tz);
        if (!hit) continue;
        const b = { x: tx, y: hit.y + 1, z: tz };

        // ---- 确定性：连调 3 次，签名应完全一致 ----
        const s1 = sig(plan3D(dir, a, b, { maxNodes: 120000, margin: 8 }));
        const s2 = sig(plan3D(dir, a, b, { maxNodes: 120000, margin: 8 }));
        const s3 = sig(plan3D(dir, a, b, { maxNodes: 120000, margin: 8 }));
        dTot++;
        if (s1 === s2 && s2 === s3) dSame++;

        // ---- 失败记忆：给路径中点记失败，看是否改道 ----
        const base = plan3D(dir, a, b, { maxNodes: 120000, margin: 8 });
        if (!base.ok || base.path.length < 6) continue;
        const mid = base.path[Math.floor(base.path.length / 2)];
        recordFail(dir, mid.x, mid.y, mid.z);
        recordFail(dir, mid.x, mid.y, mid.z);
        recordFail(dir, mid.x, mid.y, mid.z);
        const after = plan3D(dir, a, b, { maxNodes: 120000, margin: 8 });
        fTot++;
        if (after.ok) {
            const stillThrough = after.path.some(p => p.x === mid.x && p.y === mid.y && p.z === mid.z);
            if (!stillThrough) fDetour++;
            if (after.cost > base.cost + 0.01) cUp++;
        }
        clearFail(dir, mid.x, mid.y, mid.z);
    }

    detTotal += dTot; detSame += dSame;
    failTotal += fTot; failDetour += fDetour; costUp += cUp;
    console.log(`${kind.padEnd(9)} ${dSame}/${dTot}`.padEnd(19) +
        `${fDetour}/${fTot}`.padEnd(15) + `${cUp}/${fTot}`);
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
}

console.log('\n=== 总体 ===');
console.log(`确定性（3 次调用路径完全一致）：${detSame}/${detTotal} = ${(detSame / detTotal * 100).toFixed(0)}%`);
console.log(`失败记忆导致改道：${failDetour}/${failTotal} = ${(failDetour / failTotal * 100).toFixed(0)}%`);
console.log(`失败记忆导致代价上升：${costUp}/${failTotal} = ${(costUp / failTotal * 100).toFixed(0)}%`);
console.log(`\n结论：`);
console.log(`  tie-breaker 有效：${detSame === detTotal ? '是（100% 确定）' : '否，仍有 ' + (detTotal - detSame) + ' 组不一致'}`);
console.log(`  失败记忆有效：${failDetour >= failTotal * 0.9 ? '是（≥90% 改道）' : '看具体比例'}`);
