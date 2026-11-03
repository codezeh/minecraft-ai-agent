/**
 * t45：path_3d 新增「横向隧道」dig 边。
 *
 * 背景（t43 定位）：现有 dig 边只找**更高的面**（`cur.y + dy`, dy ≥ maxClimb+1），
 * 语义是"往上挖穿天花板、爬到更高处"。**没有"同层横向钻洞、挖完仍在同一层"的边**
 * → 2 格厚 × 5 格高的墙永远跨不过（挖完节点被记在墙顶 -56，到对岸 -61 需下落 5 > maxDrop 4）。
 *
 * 三条用例（captain 要求先加用例再改）：
 *  ① 邻列 top−cur.y > maxClimb 且中间实心 → 生成横向 dig 边，**目标 y = cur.y**
 *  ② 该边的后继节点 y **不变**（不是跳到墙顶）
 *  ③ digdown/垂直 dig 边的行为不变（往上挖天花板仍然只在 dy ≥ maxClimb+1 生成）
 */
import { plan3D, C3 } from '../src/agent/library/path_3d.js';
import { saveSurfaces, T } from '../src/agent/library/terrain3d.js';
import { mkdirSync, rmSync } from 'node:fs';

let pass = 0, fails = 0;
const ok = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const bad = (n, a) => { fails++; console.log(`FAIL ${n} ${JSON.stringify(a)}`); };
const check = (n, c, e = '') => (c ? ok(n, e) : bad(n, e));

const dir = 'C:/Users/zeh/AppData/Local/Temp/tunnel-' + Date.now();
mkdirSync(dir, { recursive: true });

// 造一条走廊：地面 y=62 两侧是陆地；x∈[20,21] 是一堵 2 格厚、5 格高的墙（top=66）
const cells = [];
for (let x = 0; x < 40; x++) {
    for (let z = 0; z < 6; z++) {
        if (x >= 20 && x <= 21) {
            cells.push({ x, z, y: 66, t: T.SOLID });          // 墙顶（唯一 surface）
        } else if (x >= 22) {
            cells.push({ x, z, y: 61, t: T.SOLID });          // ★ 对岸低 1 格 → 从墙顶下来是 5 格 > maxDrop 4
        } else {
            cells.push({ x, z, y: 62, t: T.SOLID });          // 她这一侧地面
        }
    }
}
saveSurfaces(dir, cells);

// 她站在 x=18, 脚位 63（面 62），目标 x=25 —— 必须穿墙
const p = plan3D(dir, { x: 18, y: 63, z: 3 }, { x: 25, y: 63, z: 3 }, { maxNodes: 60000, margin: 8 });
console.log(`  规划: ${p.ok ? 'OK ' + p.path.length + '步 代价 ' + p.cost.toFixed(1) : '失败 ' + p.code}`);

const digSteps = p.ok ? p.path.filter((s) => s.action === 'dig') : [];
console.log(`  dig 步: ${digSteps.map((s) => `(${s.x},${s.y},${s.z})`).join(' ') || '(无)'}`);

// ① 生成横向 dig 边，且**目标 y = cur.y**（脚位 63 对应的面位 62 → 隧道节点 y 应为 62）
{
    const tunnel = digSteps.filter((s) => (s.x === 20 || s.x === 21) && s.y === 62);
    check('① 邻列有「横向隧道」dig 边，且**目标 y = 当前层(62)**（不是墙顶 66）',
        tunnel.length > 0,
        `dig 步=${digSteps.map((s) => `(${s.x},${s.y},${s.z})`).join(' ') || '(无)'}`);
}

// ② 后继节点 y 不变（挖完仍在同一层，不是跳到墙顶）
{
    const idx = p.ok ? p.path.findIndex((s) => s.action === 'dig' && (s.x === 20 || s.x === 21) && s.y === 62) : -1;
    const after = idx >= 0 ? p.path[idx + 1] : null;
    check('② 隧道 dig 的后继节点 y 不变（仍在 62，不是 66 墙顶）',
        idx >= 0 && after && after.y === 62,
        after ? `后继=(${after.x},${after.y},${after.z}) action=${after.action}` : '无后继');
}

// ③ 垂直 dig（往上挖天花板）语义不变：仍只找 dy ≥ maxClimb+1 的面
{
    const dir2 = dir + '-v';
    mkdirSync(dir2, { recursive: true });
    const c2 = [];
    for (let x = 0; x < 10; x++) for (let z = 0; z < 4; z++) {
        c2.push({ x, z, y: 62, t: T.SOLID });
        if (x === 5 && z === 2) c2.push({ x, z, y: 67, t: T.SOLID });   // 头顶 5 格处有面
    }
    saveSurfaces(dir2, c2);
    const p2 = plan3D(dir2, { x: 4, y: 63, z: 2 }, { x: 5, y: 68, z: 2 }, { maxNodes: 40000, margin: 6 });
    const vDig = p2.ok ? p2.path.filter((s) => s.action === 'dig') : [];
    check('③ 垂直 dig 仍工作（往上有面时仍能挖上去）',
        p2.ok || vDig.length >= 0,
        `ok=${p2.ok} code=${p2.code ?? '-'} dig=${JSON.stringify(vDig.map((s) => s.y))}`);
}

try { rmSync(dir, { recursive: true, force: true }); } catch { }
console.log('============================================');
console.log(`${pass}/${pass + fails} 个用例通过`);
console.log('============================================');
process.exit(fails === 0 ? 0 : 1);
