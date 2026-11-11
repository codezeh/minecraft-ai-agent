/**
 * 流程：天黑前搭一个能过夜的小屋（M10，04 §6.1/§6.3 的 `flow_shelter`）。
 *
 * 04 §6.1 对它的全部描述只有一句：「`flow_shelter` | 天黑前搭一个能过夜的小屋 | P1 | 🆕」。
 * 所以本文件按"能过夜"这个唯一硬需求定义行为：
 *   **一个 3×3 的封闭壳**（墙 + 顶 + 地板），中间留 1 格空气给她站着。
 *   3×3 是能塞下一个人、又只用 20 来块材料的最小尺寸。
 *
 * ★ 为什么**不自己放方块**，而是交给 `flow_build`：
 *   `flow_build` 已经做过这几件事且都有用例：先算材料（不够一块都不建）、
 *   自下而上排序、`findStandSpot` 找站位、**`query_safe.fallRisk` 防踩空**、逐格读回校验。
 *   在 `flow_shelter` 里重写一遍就是第二套真相（本项目反复踩的坑）。
 *   所以这里只干"**把屋子算成一份蓝图**"这一件事。
 *
 * ★ 一定要能被打断：`flow_build` 每格都查 `bot.interrupt_code`，所以天黑搭一半被玩家叫停
 *   会如实返回 INTERRUPTED（而不是硬撑着搭完）。
 */
import { ok, fail } from './contract.js';
import { build } from './flow_build.js';
import { blockAt } from './query_perceive.js';
import { countItem } from './query_perceive.js';
import { findStandSpot } from './query_stand.js';

/** 复合技能 manifest（04 §4.1）。 */
export const manifest = {
    name: 'shelter',
    level: 'flow',
    summary: '天黑前搭一个能过夜的小屋（默认 3×3、1 层墙 + 顶 ≈17 格，够挡视线和怪）',
    params: {
        block: 'string?',        // 用什么材料，默认 cobblestone（拿不到会自动挑）
        size: 'int 3..7 = 3',    // 边长：3 → 3×3（内空 1 格）。想要更大的显式传
        floor: 'string?',        // 'auto'（默认）= 脚下不是实心才补地板；'always' / 'never'
    },
    needs: { items: ['建筑材料 ≥20'], near: [] },
    // t9：不声明 claims —— 区域要真实坐标，运行时才知道（'area:<自己周围>' 不是合法 key）。
    // t36：加 NO_DATA —— 脚下没加载时如实报 NO_DATA（原来错报 NO_TARGET）
    codes: ['NO_ITEM', 'NO_TARGET', 'NO_DATA', 'NO_SUPPORT', 'UNSAFE', 'OUT_OF_REACH', 'TIMEOUT', 'INTERRUPTED', 'INTERNAL'],
    resumable: true,
    timeoutMs: 5 * 60 * 1000,
};

/** 挑一种她手上有的建筑材料（优先结实、再退到任何方块）。 */
const PREFERRED = ['cobblestone', 'stone', 'oak_planks', 'birch_planks', 'dirt', 'oak_log', 'birch_log'];
function pickMaterial(bot, want) {
    if (want && countItem(bot, want) > 0) return want;
    for (const m of PREFERRED) if (countItem(bot, m) > 0) return m;
    // 退一步：背包里任何"看起来能当方块"的（排除工具/食物这类明显不是方块的）
    const items = bot?.inventory?.items?.() ?? [];
    const bad = /(_pickaxe|_axe|_sword|_shovel|_hoe|_helmet|_chestplate|_leggings|_boots|_seeds?$|apple|bread|_ingot$|_nugget$|coal|stick|torch|bone_meal|string|feather|leather|_dye$)/;
    const hit = items.find((i) => i?.name && !bad.test(i.name) && (i.count ?? 0) > 0);
    return hit?.name ?? null;
}

/**
 * 算一份 3×3 小屋蓝图（**纯计算，不放方块**）。
 *
 * 形状（y = 脚位层）：
 *   · 地板：y-1 的 3×3（她已经站的那格多半已有）
 *   · 墙：  y、y+1 两层的**外圈 8 格**（中间 (0,0) 留空给她站）
 *   · 顶：  y+2 的 3×3 全覆盖
 * 合计 9 + 8 + 8 + 9 = 34 格，但**已存在的方块会被 build 跳过**（它逐格读回校验），
 * 实际用料通常 20 出头。
 *
 * @param {{x:number,y:number,z:number}} feet 她的脚位
 * @param {string} material
 * @param {number} half 半边长（1 → 3×3）
 * @returns {Array<{x:number,y:number,z:number,name:string}>}
 */
export function shelterBlueprint(feet, material, size = 3, opts = {}) {
    // 兼容旧签名：返回"除了 cap 之外"的所有块（= wall1 + wall2 + roofRing + sealDoor）
    return shelterBuildOrder(feet, material, size, opts)
        .filter((b) => b.phase !== 'cap')
        .map((b) => ({ x: b.x, y: b.y, z: b.z, name: b.name }));
}

/**
 * ★ **小屋的有序建造计划**（2026-11-03 用户定的 B 方案 + 封门）。
 *
 * 输出 **有序** 的 `[{x,y,z,name,phase}]`，phase ∈
 *   `wall1` → `wall2` → `roofRing` → `cap` → `sealDoor`
 *
 * ── 为什么要这个顺序（几何核过的）────────────────────────────────────
 *   · 墙 2 层（cy、cy+1）：她身高 1.8，脚 cy 头 cy+1，所以内空必须 2 格高。
 *     **绝不 1 层** —— 1 层会把顶圈压在她头上（= 活埋，B1 那次同类事故）。
 *   · 墙里**留一个 1×2 门洞**（wall1/wall2 各少 1 块）：她要能走出去。
 *   · 顶圈在 cy+2、±1 环上 —— **不在她身体列**（身体列是正中），所以她**在屋里就能放**。
 *   · `cap` 正中在她身体列 → **在屋里放不了**（act_place 正确拒绝）→ 必须**出去再放**。
 *   · 她走门洞出去 → 封 cap → **走回屋里** → 再从**里面**封门洞那 2 块
 *     （门洞在 ±1 横向，不在她身体列 → 屋里放合法）。
 *
 * ── 结果：封闭壳 + 人在屋里 ==
 *
 * @param {{x:number,y:number,z:number}} feet 她的脚位（圆心 = 她的列）
 * @param {string} material
 * @param {number} size 边长（3 = 3×3，内空 1 格）
 * @param {object} opts { floor:'auto'|'always'|'never', underBlockName, doorSide:'+x'|'-x'|'+z'|'-z' }
 * @returns {Array<{x:number,y:number,z:number,name:string,phase:string}>}
 */
export function shelterBuildOrder(feet, material, size = 3, opts = {}) {
    const cx = Math.floor(feet.x), cy = Math.floor(feet.y), cz = Math.floor(feet.z);
    const n = Math.max(3, Math.min(7, Math.floor(Number(size) || 3)));
    const half = Math.floor(n / 2);
    const out = [];
    const push = (x, y, z, phase) => out.push({ x, y, z, name: material, phase });

    // ── 地板（可选）：默认不铺（省块数只能从这里省，不能从她身高里省）──
    const floorMode = String(opts.floor ?? 'auto');
    if (floorMode === 'always') {
        for (let dx = -half; dx <= half; dx++) {
            for (let dz = -half; dz <= half; dz++) push(cx + dx, cy - 1, cz + dz, 'floor');
        }
    } else if (floorMode === 'auto') {
        const under = opts.underBlockName ?? null;
        const solid = under && !['air', 'cave_air', 'void_air', 'water', 'lava'].includes(under);
        if (!solid) push(cx, cy - 1, cz, 'floor');
    }

    // ── 门洞位置：沿某个方向的外圈那一列（1×2：wall1 和 wall2 各一块）──
    const doorSide = String(opts.doorSide ?? '+x');
    const doorAt = {
        '+x': { x: cx + half, z: cz },
        '-x': { x: cx - half, z: cz },
        '+z': { x: cx, z: cz + half },
        '-z': { x: cx, z: cz - half },
    }[doorSide] ?? { x: cx + half, z: cz };

    // ── 外圈坐标（按层）──
    const ring = [];
    for (let dx = -half; dx <= half; dx++) {
        for (let dz = -half; dz <= half; dz++) {
            if (Math.abs(dx) === half || Math.abs(dz) === half) ring.push([cx + dx, cz + dz]);
        }
    }
    const isDoor = ([x, z]) => x === doorAt.x && z === doorAt.z;

    // ── wall1（cy）：留门洞 ──
    for (const [x, z] of ring) {
        if (isDoor([x, z])) continue;
        push(x, cy, z, 'wall1');
    }
    // ── wall2（cy+1）：同一位置也留门洞（1×2 门）──
    for (const [x, z] of ring) {
        if (isDoor([x, z])) continue;
        push(x, cy + 1, z, 'wall2');
    }
    // ── roofRing（cy+2）：四边 + 除正中外的内部 ──
    const roof = [];
    for (let dx = -half; dx <= half; dx++) {
        for (let dz = -half; dz <= half; dz++) roof.push([cx + dx, cz + dz]);
    }
    for (const [x, z] of roof) {
        if (x === cx && z === cz) continue;          // 正中 = cap，单独最后放
        push(x, cy + 2, z, 'roofRing');
    }
    // ── cap：顶的正中（她身体列）→ 必须人在屋外才放 ──
    push(cx, cy + 2, cz, 'cap');
    // ── sealDoor：最后从屋里把门洞补上（在 ±1 横向，不在她身体列）──
    push(doorAt.x, cy, doorAt.z, 'sealDoor');
    push(doorAt.x, cy + 1, doorAt.z, 'sealDoor');

    return out;
}

/**
 * "她是否已经走到屋外"——**判定必须用 OR，不是 AND**。
 *
 * ★ 2026-11-03 真机抓到我自己的逻辑 bug：
 *   原来写 `Math.abs(dx) > 1 && Math.abs(dz) > 1`（两轴都要出格）。
 *   但她是从屋里**朝一个方向**走出去的（比如纯 +x），`dz` 恒为 0 →
 *   谓词**永远不可能为真** → 一直等到超时，报 `still-inside`。
 *   真机证据：`reason=still-inside outsLength=4`（四方向都有空气格，场地没问题）。
 *
 *   墙在 ±1，所以"出格"的正确条件是**任一轴超过 1**。
 */
export function isOutsideShelter(px, pz, cx, cz) {
    const dx = Math.abs(Math.floor(px) - cx);
    const dz = Math.abs(Math.floor(pz) - cz);
    return dx > 1 || dz > 1;
}

export function capCell(feet, size = 3) {
    const cy = Math.floor(feet.y), cx = Math.floor(feet.x), cz = Math.floor(feet.z);
    return { x: cx, y: cy + 2, z: cz };      // 墙 2 层之上才是顶（原来写 cy+1 是漏算了身高）
}

/**
 * 搭一个能过夜的小屋。
 *
 * @param {object} opts { block, radius, ctx }
 * @returns ActionResult
 *   ok          → data: { material, placed, want }
 *   NO_ITEM     没有建筑材料（abort：先 strat_obtain 砖石/木头）
 *   NO_TARGET   脚下读不到方块（没加载）
 *   NO_SUPPORT / UNSAFE / OUT_OF_REACH  由 flow_build 透传
 */
export async function shelter(bot, opts = {}) {
    const ctx = opts.ctx ?? { deadline: Date.now() + manifest.timeoutMs };
    if (bot?.interrupt_code) return fail('INTERRUPTED', '被取消了');
    const t0 = Date.now();

    const feet = bot?.entity?.position;
    if (!feet || !Number.isFinite(feet.x)) return fail('NO_TARGET', '读不到自己的位置');
    const below = blockAt(bot, { x: Math.floor(feet.x), y: Math.floor(feet.y) - 1, z: Math.floor(feet.z) });
    // ★ t36（2026-11-03）这里原来是**两条不同的事被一个码盖住**，现在分开报：
    //   ① `blockAt` 返回 null = 那格**还没加载** → NO_DATA（走近/等加载再试，可重试）
    //   ② 那格读得到、但站不住（空气/虚空/液体）= **不该在这儿搭** → NO_TARGET（换地方）
    // 原来只有 `if (!below)`，只挡 ①。②的真相是"脚下是 air 对象、不是 null"，
    // 于是会**一路往下走，在虚空/水面上搭屋子**（悬崖边、水边就是真实触发场景）。
    if (!below) return fail('NO_DATA', '脚下那格读不到（区块没加载？）');
    if (/^(air|cave_air|void_air)$/.test(below.name)
        || /^(water|lava)$/.test(below.name)
        || /_water$|_lava$/.test(below.name)) {
        return fail('NO_TARGET', `脚下是 ${below.name}，不能在这儿搭屋子（换个实地再搭）`, { below: below.name });
    }

    const material = pickMaterial(bot, opts.block ?? null);
    if (!material) {
        return fail('NO_ITEM', '没有能当墙的材料（先弄点圆石/木头）', { missing: { cobblestone: 20 } });
    }
    if (countItem(bot, material) <= 0) {
        return fail('NO_ITEM', `没有 ${material} 了`, { missing: { [material]: 25 } });
    }

    const size = Math.max(3, Math.min(7, Math.floor(Number(opts.size) || 3)));
    const order = shelterBuildOrder(feet, material, size, {
        floor: opts.floor ?? 'auto',
        underBlockName: below?.name ?? null,
        doorSide: opts.doorSide ?? '+x',
    });
    const need = order.length;
    // ★ 每步计时（2026-11-03 用户要求）：不稳定时能一眼看出卡在哪一步。
    const stepLog = (name, t0s, extra = '') => {
        console.log(`[step] ${name}  costMs=${Date.now() - t0s}  ${extra}`);
    };
    // ★ 缺块的 pos（不要只报总数：缺 wall2 两块 = 她还没走出去就被墙挡了）
    const missingPos = (blueprint) => blueprint.filter((b) => {
        const cur = blockAt(bot, { x: b.x, y: b.y, z: b.z });
        return !cur || ['air', 'cave_air', 'void_air'].includes(cur.name);
    }).map((b) => ({ x: b.x, y: b.y, z: b.z, phase: b.phase }));

    // 按 phase 分组，**严格按 1–7 的顺序执行**
    const byPhase = (ph) => order.filter((b) => b.phase === ph);
    const fail2 = (code, msg, extra = {}) => fail(code, msg, {
        material, want: need, total: need, costMs: Date.now() - t0, ...extra,
    });

    // ── 步骤 1–3：墙1 → 墙2 → 顶圈（都在屋里能放；cap 与 sealDoor 除外）──
    const indoor = [...byPhase('wall1'), ...byPhase('wall2'), ...byPhase('roofRing'),
        ...byPhase('floor')];
    if (indoor.length) {
        const t1 = Date.now();
        const r1 = await build(bot, indoor.map((b) => ({ x: b.x, y: b.y, z: b.z, name: b.name })), { ctx });
        const done1 = Number(r1?.data?.placed ?? 0);
        stepLog('1-3 wall1+wall2+roof', t1,
            `placed=${done1}/${indoor.length} ok=${r1.ok} code=${r1.code ?? 'OK'}`
            + (r1.ok ? '' : ` 缺=${JSON.stringify(missingPos(indoor))}`));
        if (!r1.ok) {
            return fail2(r1.code ?? 'BLOCKED', `墙/顶圈没搭完：${r1.message ?? ''}`, {
                placed: done1, remaining: Math.max(0, need - done1),
                failed: r1.data?.failed ?? [], reason: r1.data?.reason ?? 'indoor-build',
            });
        }
    }

    // ── 步骤 4–6：出门洞 → 封 cap → 走回屋里 → 封门洞 ──
    const cap = byPhase('cap')[0];
    const door = byPhase('sealDoor');

    // 4) 从门洞走出去（门洞是 1×2 空，直接走/跳；不调 goTo）
    const t4 = Date.now();
    const walkOut = await leaveThroughDoor(bot, feet, size, opts.doorSide ?? '+x', ctx, cap);
    stepLog('4-exit', t4, `out=${walkOut.ok} tries=${walkOut.tries ?? 1}`
        + (walkOut.ok ? '' : ` reason=${walkOut.reason}`));
    if (!walkOut.ok) {
        return fail2(walkOut.code, `没能从门洞走出去：${walkOut.message ?? ''}`, {
            placed: need - 3, remaining: 3, reason: walkOut.reason ?? null,
            outsLength: walkOut.outsLength ?? null,
        });
    }

    // 5) 从屋外封 cap 正中
    if (cap) {
        const { placeBlockAt } = await import('./act_place.js');
        // ★ 2026-11-03 真机 + 三数诊断定位：原来这里传的是**裸 {x,y,z}**，
        //   而 `act_place.placeBlockAt` 第一行就 `normalizeTarget(pos)` ——
        //   裸对象归一化返回 **null** → 直接 `NO_TARGET「目标位置无效」`。
        //   所谓"那格读不到"从头到尾是我传参形状错了，**不是加载问题**
        //   （诊断实测：blockAt(false)=air、blockAt(true)=air、getColumnAt=有 → 全都在）。
        //   全仓库的调用约定是 `{ kind:'block', pos:{x,y,z} }`，这里补齐。
        const t5 = Date.now();
        const put = await placeBlockAt(bot, { kind: 'block', pos: { x: cap.x, y: cap.y, z: cap.z } }, material, {});
        const cur = blockAt(bot, { x: cap.x, y: cap.y, z: cap.z });
        const sealed = !!cur && !['air', 'cave_air', 'void_air'].includes(cur.name);
        stepLog('5-cap', t5, `ok=${put.ok && sealed} code=${put.code ?? 'OK'}`
            + (put.ok ? '' : ` reason=${put.data?.reason ?? ''}`));
        if (!put.ok || !sealed) {
            return fail2(put.code ?? 'BLOCKED', `屋顶正中封不上：${put.message ?? '读回不是目标方块'}`, {
                placed: need - 3, remaining: 3 + (sealed ? 0 : 0),
                reason: put.data?.reason ?? 'cap-failed',
            });
        }
    }

    // 6) 走回屋里 → 从里面封门洞（门洞在 ±1 横向，不在她身体列 → 合法）
    const t6 = Date.now();
    const back = await reenterThroughDoor(bot, feet, size, opts.doorSide ?? '+x', ctx);
    stepLog('6-reenter', t6, `inside=${back.ok} tries=${back.tries ?? 1}`
        + (back.ok ? '' : ` reason=${back.reason}`));
    if (!back.ok) {
        return fail2(back.code, `没能走回屋里：${back.message ?? ''}`, {
            placed: need - 2, remaining: 2, reason: back.reason ?? null,
        });
    }
    if (door.length) {
        // ★ 2026-11-03 真机（reason=own-body-column）抓到：她刚穿过门洞进来，
        //   **人还站在门洞那一列**，直接封门就会被"不往自己身体列放"正确拒绝。
        //   所以先让她**走到屋里正中**，再封门（门洞在 ±1 横向，那时就不在她身体列了）。
        const t7 = Date.now();
        await stepToCenter(bot, feet, ctx);
        // ★ 打 own-body-column 的判定输入（用户要求：确认不是靠运气）
        {
            const f = bot.entity.position;
            const fx = Math.floor(f.x), fy = Math.floor(f.y), fz = Math.floor(f.z);
            for (const d of door) {
                const inOwnCol = (d.x === fx && d.z === fz && (d.y === fy || d.y === fy + 1));
                console.log(`[step] 7-seal-check feet=(${fx},${fy},${fz}) door=(${d.x},${d.y},${d.z}) own-body-column=${inOwnCol}`);
            }
        }

        const r2 = await build(bot, door.map((b) => ({ x: b.x, y: b.y, z: b.z, name: b.name })), { ctx });
        const done2 = Number(r2?.data?.placed ?? 0);
        stepLog('7-seal', t7, `ok=${r2.ok} placed=${done2}/${door.length} code=${r2.code ?? 'OK'}`);
        if (!r2.ok || done2 < door.length) {
            return fail2(r2.code ?? 'BLOCKED', `门洞没封上：${r2.message ?? ''}`, {
                placed: need - door.length + done2, remaining: door.length - done2,
                failed: r2.data?.failed ?? [], reason: r2.data?.reason ?? 'seal-door',
            });
        }
    }

    // 完工：封闭壳 + 人在屋里
    return ok({
        material, placed: need, want: need, total: need,
        sealed: true, insideAfter: true,
        note: '小屋搭好了：墙2层 + 顶 + 门洞已从里面封上（人在屋里）',
        costMs: Date.now() - t0,
    });
}

/**
 * 步骤 4：从门洞走出去。
 *
 * ★ 不调 `goTo`（2 格穿门洞是原子层的活，3D 规划对它既慢又依赖地形数据）。
 *   做法：朝门的方向看 → holdKey(forward)（门洞 1×2 空，直接走；必要时带 jump）
 *   → **轮询确认真的出格**。
 */
async function leaveThroughDoor(bot, feet, size, doorSide, ctx, capCellRef) {
    const cx = Math.floor(feet.x), cy = Math.floor(feet.y), cz = Math.floor(feet.z);
    const dir = { '+x': [1, 0], '-x': [-1, 0], '+z': [0, 1], '-z': [0, -1] }[doorSide] ?? [1, 0];
    const { lookAtPoint } = await import('./atom_input_mouse.js');
    const { holdKey } = await import('./atom_input_move.js');

    try {
        await lookAtPoint(bot, {
            x: bot.entity.position.x + dir[0] * 2,
            y: bot.entity.position.y + 1.2,
            z: bot.entity.position.z + dir[1] * 2,
        }, { force: true });
    } catch { /* 看不过去照走 */ }

    const outside = () => isOutsideShelter(bot.entity.position.x, bot.entity.position.z, cx, cz);
    // 门洞在地面层，直接走即可；带上 jump 以防 1 格台阶
    const walk = await holdKey(bot, ['forward', 'jump'], {
        until: () => outside(),
        timeout: Math.max(2000, Math.min((ctx?.deadline ?? Date.now() + 8000) - Date.now(), 8000)),
    });
    const outFeet = bot.entity.position;
    const tries = Number(walk?.data?.tries ?? walk?.data?.polls ?? 1);
    if (!outside()) {
        return {
            ok: false, code: 'OUT_OF_REACH', reason: 'still-inside', tries,
            message: `从门洞没走出去（holdKey=${walk.ok ? 'ok' : walk.code}，脚位 `
                + `${Math.floor(outFeet.x)},${Math.floor(outFeet.z)}；门槛 |dx|>1 或 |dz|>1）`,
            outsLength: null,
        };
    }
    return { ok: true, tries };
}

/** 步骤 6：从门洞走回屋里（同样不调 goTo）。 */
async function reenterThroughDoor(bot, feet, size, doorSide, ctx) {
    const cx = Math.floor(feet.x), cy = Math.floor(feet.y), cz = Math.floor(feet.z);
    const dir = { '+x': [-1, 0], '-x': [1, 0], '+z': [0, -1], '-z': [0, 1] }[doorSide] ?? [-1, 0];
    const { lookAtPoint } = await import('./atom_input_mouse.js');
    const { holdKey } = await import('./atom_input_move.js');

    try {
        await lookAtPoint(bot, {
            x: bot.entity.position.x + dir[0] * 2,
            y: bot.entity.position.y + 1.2,
            z: bot.entity.position.z + dir[1] * 2,
        }, { force: true });
    } catch { /* ignore */ }

    const inside = () => !isOutsideShelter(bot.entity.position.x, bot.entity.position.z, cx, cz);
    const walk = await holdKey(bot, ['forward', 'jump'], {
        until: () => inside(),
        timeout: Math.max(2000, Math.min((ctx?.deadline ?? Date.now() + 8000) - Date.now(), 8000)),
    });
    if (!inside()) {
        return { ok: false, code: 'OUT_OF_REACH', reason: 'still-outside', tries: Number(walk?.data?.tries ?? 1), message: `没能走回屋里（holdKey=${walk.ok ? 'ok' : walk.code}）` };
    }
    return { ok: true, tries: Number(walk?.data?.tries ?? 1) };
}


/** 从 build 的返回里数"放上了几块"（ok 或失败都可能带）。 */
function placedCount0(r) {
    return Number(r?.data?.placed ?? 0);
}

/**
 * 走到屋外相邻一格 → 封屋顶正中 → 读回校验 → 走回屋里。
 *
 * 只做这一格，不碰别的。走出去会**确认真的出格了**（不是"看起来走开了"）。
 */
async function sealRoofCenter(bot, cap, material, ctx) {
    const feet = bot.entity.position;
    const cx = Math.floor(feet.x), cy = Math.floor(feet.y), cz = Math.floor(feet.z);

    // ① 选一个"屋外相邻"的落脚点：墙外一格（3×3 的墙在 ±1，所以外面是 ±2）
    const outs = [
        { x: cx + 2, y: cy, z: cz }, { x: cx - 2, y: cy, z: cz },
        { x: cx, y: cy, z: cz + 2 }, { x: cx, y: cy, z: cz - 2 },
    ].filter((p) => {
        const b = blockAt(bot, p);
        return b && ['air', 'cave_air', 'void_air'].includes(b.name);   // 站得下
    });
    if (!outs.length) return { ok: false, code: 'OUT_OF_REACH', reason: 'no-outside-spot', message: '找不到能站的屋外格子（屋外那片没有空气格）', outsLength: 0 };

    const spot = outs[0];

    // ★★ 第②步：**直接跳出去，不调 goTo**（2026-11-03 用户定的修法）
    //
    // 为什么不能用 goTo：墙在 ±1、1 格高，屋外格在 ±2 —— 她出去**必须跳过那 1 格墙**。
    // 而 `goTo` 走 `walkTo`（3D 规划 + pathfinder，`arriveTol` 要精确、还依赖 terrain3d 数据），
    // 对"跨 1 格矮墙、只 2 格距离"这种移动是**误用**：pathfinder 算不出路 / 直接判"已经很近"就返回，
    // 真机就是这样卡在 `still-inside` 的。
    //
    // 这本来就是"一次玩家输入"级别的事（走一步 + 跳一下），属原子层：
    //   lookAtPoint(朝屋外方向) → holdKey(['forward','jump'], until 真的出格)
    // 而且**不需要地形数据**。
    //
    // 注意：**不改 `nav_core.goTo`** —— 它"长距离走 3D、短距离走 pathfinder"是对的，
    // 不该为这个特例加隐藏路径（那会变成 stepInto 那种"多一条路径就多一个不一致"）。
    const { lookAtPoint } = await import('./atom_input_mouse.js');
    const { holdKey } = await import('./atom_input_move.js');

    // 朝屋外那个方向看（水平方向足够，1 格墙跳一下就过）
    const dir = { x: spot.x - cx, z: spot.z - cz };
    try {
        await lookAtPoint(bot, {
            x: bot.entity.position.x + dir.x,
            y: bot.entity.position.y + 1.2,          // 平视稍上，便于迈上 1 格
            z: bot.entity.position.z + dir.z,
        }, { force: true });
    } catch { /* 看不过去也照跳 */ }

    const feetNow = () => bot.entity.position;
    const outside = () => {
        const f = feetNow();
        return isOutsideShelter(f.x, f.z, cx, cz);        // ★ OR，不是 AND
    };

    // 按住前进 + 跳，直到**真的出格**（不是"按了就算"）
    const hop = await holdKey(bot, ['forward', 'jump'], {
        until: () => outside(),
        timeout: Math.max(2000, Math.min((ctx?.deadline ?? Date.now() + 8000) - Date.now(), 8000)),
    });

    // **确认真的出格了**（不能只看 holdKey 说 ok）
    const outsideNow = outside();
    const outFeet = feetNow();
    if (!outsideNow) {
        return {
            ok: false, code: 'OUT_OF_REACH', reason: 'still-inside',
            message: `跳出去没成功（holdKey=${hop.ok ? 'ok' : hop.code}，脚位仍在 `
                + `${Math.floor(outFeet.x)},${Math.floor(outFeet.z)}；门槛是 |dx|>1 或 |dz|>1）`,
            outsLength: outs.length,
        };
    }

    // ③ 封正中
    const { placeBlockAt } = await import('./act_place.js');
    const put = await placeBlockAt(bot, cap, material, {});

    // ④ 读回校验
    const cur = blockAt(bot, cap);
    const sealed = !!cur && cur.name !== 'air' && !['cave_air', 'void_air'].includes(cur.name);

    // ⑤ 跳回屋里（同样用原子输入，不调 goTo；1 格墙一跳就回）
    try {
        await lookAtPoint(bot, {
            x: cx + 0.5, y: bot.entity.position.y + 1.2, z: cz + 0.5,
        }, { force: true });
        await holdKey(bot, ['forward', 'jump'], {
            until: () => {
                const f = bot.entity.position;
                return !isOutsideShelter(f.x, f.z, cx, cz);   // 回到屋里
            },
            timeout: Math.max(1500, Math.min((ctx?.deadline ?? Date.now() + 6000) - Date.now(), 6000)),
        });
    } catch { /* 回不去也不影响"封上了"这个事实 */ }

    return {
        ok: put.ok && sealed,
        code: put.ok ? 'BLOCKED' : (put.code ?? 'BLOCKED'),
        reason: put.ok ? 'readback-failed' : (put.data?.reason ?? null),
        message: put.ok ? '放下去了但读回不是目标方块' : (put.message ?? ''),
        placed: sealed ? 1 : 0,
    };
}

/**
 * 让站到屋里正中去（封门前必须做）。
 *
 * 为什么：她是从门洞走进来的，人还**站在门洞那一列**；
 * 而 `act_place` 正确地拒绝往"自己身体列"放方块 —— 不先挪开，封门必然
 * 报 `BLOCKED + reason='own-body-column'`（真机实测过）。
 */
async function stepToCenter(bot, feet, ctx) {
    const cx = Math.floor(feet.x), cy = Math.floor(feet.y), cz = Math.floor(feet.z);
    const f = bot.entity.position;
    if (Math.floor(f.x) === cx && Math.floor(f.z) === cz) return true;   // 已经在正中

    const { lookAtPoint } = await import('./atom_input_mouse.js');
    const { holdKey } = await import('./atom_input_move.js');
    try {
        await lookAtPoint(bot, { x: cx + 0.5, y: f.y + 1.2, z: cz + 0.5 }, { force: true });
    } catch { /* ignore */ }
    await holdKey(bot, ['forward'], {
        until: () => {
            const p = bot.entity.position;
            return Math.floor(p.x) === cx && Math.floor(p.z) === cz;
        },
        timeout: Math.max(1500, Math.min((ctx?.deadline ?? Date.now() + 5000) - Date.now(), 5000)),
    });
    const p = bot.entity.position;
    return Math.floor(p.x) === cx && Math.floor(p.z) === cz;
}
