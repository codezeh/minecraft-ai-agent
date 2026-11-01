/**
 * A11 站立：这一格能不能站人 / 找一个能站的格子。
 *
 * 为什么单独一个原子（见 原子层缺口清单 缺口 1）：
 *   收敛前 task_collect.js 里有 standableAt(10 行) + findStandSpot(35 行) 共 45 行手写。
 *   而"能不能站"不是采集专属：place（不往脚下放）、platform（选落点）、hop（找落脚点）
 *   都需要，各自另写一套 → 判定标准必然漂移。
 *
 * 关键设计：支撑类型要如实标出来（R3-08 的教训）
 *   实测（tools/diag_leaf_stand.mjs）：站在树叶上、叶子消失 → 4 格落差的自由落体
 *   → 服务端判 invalid_player_movement 直接踢人。
 *   但**树叶可以站**（用户确认），问题不在"能不能站"，而在于"这个支撑会不会消失"。
 *   所以这里如实返回 support 类型，让上层决定：
 *     - 平时站树叶没问题
 *     - 但如果要长时间作业（砍树），上层应该知道"脚下是树叶，砍完要撤"
 *   把判断留给上层，原子只提供事实——这是分层该有的样子。
 */
import { ok, fail } from './atom_contract.js';
import { blockAt } from './atom_perceive.js';
import { EYE_HEIGHT, digReach } from '../rules/rules.runtime.js';

/**
 * 脚位/头位必须是真正的可穿过方块。树叶/原木不在这里，所以"站进树叶里"会被判不可站。
 *
 * D27（2026-11-01）：原来这里有 `lava` —— 脚位或头位是岩浆、下方是石头的格子被判成能站，
 * findStandSpot 会选进岩浆里。水留着：站在浅水里是正常的。
 */
const PASSABLE = new Set([
    'air', 'cave_air', 'void_air', 'water',
    'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush',
    'snow', 'vine', 'seagrass', 'tall_seagrass', 'torch', 'wall_torch',
    'rail', 'powered_rail', 'detector_rail', 'activator_rail',
    'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet',
    'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy',
    'cornflower', 'lily_of_the_valley', 'wither_rose', 'sunflower', 'lilac',
    'rose_bush', 'peony', 'sugar_cane', 'kelp', 'kelp_plant',
    'nether_sprouts', 'crimson_roots', 'warped_roots', 'cobweb',
]);

/** 下方是这些就掉下去，不能站。 */
const NO_SUPPORT = new Set(['air', 'cave_air', 'void_air', 'water', 'lava']);

/** 支撑"会消失"的方块：树叶会枯萎、雪会化、冰会化。 */
const EPHEMERAL_SUPPORT = /_leaves$|^snow$|^ice$|^frosted_ice$|^powder_snow$/;

/**
 * 这一格能不能站人。
 *
 * @returns ActionResult
 *   ok  → data: { standable: bool, why: string, support: string|null, supportEphemeral: bool }
 *   INTERNAL（坐标无效）
 *
 * 注意：`standable:false` 也是 ok（"不能站"是正常结论，不是错误）。
 */
export function canStand(bot, pos) {
    const v = normalizePos(pos);
    if (!v) return fail('INTERNAL', '坐标无效');

    const feet = blockAt(bot, v);
    const head = blockAt(bot, { x: v.x, y: v.y + 1, z: v.z });
    const below = blockAt(bot, { x: v.x, y: v.y - 1, z: v.z });

    if (!feet || !head || !below) {
        return ok({ standable: false, why: '读不到方块（区块未加载？）', support: null, supportEphemeral: false });
    }

    const feetOk = PASSABLE.has(feet.name);
    const headOk = PASSABLE.has(head.name);
    const belowOk = !NO_SUPPORT.has(below.name);

    if (!belowOk) {
        return ok({ standable: false, why: `下方是 ${below.name}，会掉下去`, support: null, supportEphemeral: false });
    }
    if (!feetOk) {
        return ok({ standable: false, why: `脚位被 ${feet.name} 占住`, support: below.name, supportEphemeral: false });
    }
    if (!headOk) {
        return ok({ standable: false, why: `头位被 ${head.name} 占住`, support: below.name, supportEphemeral: false });
    }

    const ephemeral = EPHEMERAL_SUPPORT.test(below.name);
    return ok({
        standable: true,
        why: ephemeral
            ? `能站，但支撑是 ${below.name}（会消失，别久留）`
            : `能站，支撑 ${below.name}`,
        support: below.name,
        supportEphemeral: ephemeral,
    });
}

/**
 * 找一个能站、且站上去够得着 target 的格子。
 *
 * 两轮搜索：
 *   1) 紧邻的 10 个方向（最常见：树旁边那格）
 *   2) 半径 2~4 的环（树冠密集时，可站点常在下方 5 格的地面）
 *
 * @param {object} bot
 * @param {{x,y,z}} target 要够得着的方块
 * @param {object} opts { maxReach, allowEphemeral }
 * @returns ActionResult
 *   ok  → data: { pos, distEyeToBlock, support, supportEphemeral }
 *   NO_SUPPORT → 周围没有能站的格子
 */
export function findStandSpot(bot, target, opts = {}) {
    const {
        maxReach = digReach(),
        allowEphemeral = true,   // 默认允许站树叶（用户确认可以站），只是标出来
    } = opts;

    const t = normalizePos(target);
    if (!t) return fail('INTERNAL', '目标坐标无效');

    const eyeH = bot.entity?.eyeHeight ?? EYE_HEIGHT;
    const center = { x: t.x + 0.5, y: t.y + 0.5, z: t.z + 0.5 };
    let best = null;

    const consider = (p) => {
        const r = canStand(bot, p);
        if (!r.ok || !r.data.standable) return;
        if (!allowEphemeral && r.data.supportEphemeral) return;

        const eye = { x: p.x + 0.5, y: p.y + eyeH, z: p.z + 0.5 };
        const d = Math.hypot(center.x - eye.x, center.y - eye.y, center.z - eye.z);
        if (d > maxReach) return;

        // 打分 = 眼到方块距离 + 支撑易失惩罚 + **相对当前高度的高差惩罚**
        //
        // 为什么加高差惩罚（2026-10-25 实测根因）：
        //   原来只按"眼到方块最近"选，于是对大 jungle 树选出
        //   「树干上方 5 格、踩在树叶上」的站位 —— 眼到方块确实近（2.3 格），
        //   但她从地面走不上去，moveTo 直接 "Took to long to decide path"，
        //   接着站在原地挖 6.9 格外的方块，全部 OUT_OF_REACH。
        //   这就是"能识别树却不清障/不砍"的真正原因：站位不可达。
        //
        //   高差每多 1 格，代价 +0.8：宁可多走两步平地，也不要爬 5 格到树叶上。
        const botY = bot.entity?.position?.y ?? p.y;
        const dyCost = Math.max(0, Math.abs(p.y - botY) - 1) * 0.8;
        const score = d + (r.data.supportEphemeral ? 0.5 : 0) + dyCost;
        if (!best || score < best.score) {
            best = {
                pos: p,
                distEyeToBlock: d,
                support: r.data.support,
                supportEphemeral: r.data.supportEphemeral,
                dyFromBot: p.y - botY,
                score,
            };
        }
    };

    // 第一轮：紧邻 10 个方向
    for (const [dx, dy, dz] of [
        [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
        [0, 1, 0], [0, -1, 0],
        [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1],
    ]) {
        consider({ x: t.x + dx, y: t.y + dy, z: t.z + dz });
    }
    if (best) {
        const { score, ...data } = best;
        return ok(data);
    }

    // 第二轮：半径 2~4 的环，dy 到 -6（实测丛林大树的可站点在下方 5 格）
    for (let r = 2; r <= 4; r++) {
        for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;   // 只扫这一圈
                for (let dy = -6; dy <= 2; dy++) {
                    consider({ x: t.x + dx, y: t.y + dy, z: t.z + dz });
                }
            }
        }
        if (best) break;
    }

    if (!best) {
        return fail('NO_SUPPORT', '周围没有能站的格子（或都够不着）', { pos: { x: t.x, y: t.y, z: t.z } });
    }
    const { score, ...data } = best;
    return ok(data);
}

// ---------------------------------------------------------------------------

function normalizePos(p) {
    if (!p || typeof p !== 'object') return null;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
    return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}
