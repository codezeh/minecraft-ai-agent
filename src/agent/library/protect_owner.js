/**
 * `protect_owner` 反射的**纯判定逻辑**（M9，07 §3.1）。
 *
 * 为什么把判定抽成纯函数：07 §3.1 给了 6 个数字（6/8/16 格、20/30 秒、血量 8）
 * 和 3 条"不打"规则（玩家 / 苦力怕 / 末影人只在主人刚掉血时打）。
 * 这些东西的正确性**必须能离线逐条数**，不能靠在真机上肉眼看
 * （"看起来它冲上去了"不算证据）。
 *
 * mode 本体在 `modes.js`，只负责：取现场数据 → 调这里 → 照结论执行。
 */

/** 07 §3.1 的起步值，全部具名（原文要求"写成 mode 里的命名常量"）。 */
export const PROTECT = Object.freeze({
    NEAR_OWNER: 6,        // 敌对生物离主人多少格内算"威胁"
    VERTICAL_SLACK: 3,    // 高差上限
    HURT_RANGE: 8,        // 主人刚掉血时，多少格内的敌对生物要打
    RELEASE_DIST: 16,     // 目标离主人超过这个距离就收手
    MAX_FIGHT_MS: 20000,  // 单次护主最多打 20 秒
    SELF_HP_MIN: 8,       // 自己血量低于这个数就收手（交给 cowardice）
    IGNORE_MS: 30000,     // 放弃过的那只，30 秒内不再管
});

/** 不打的东西（07 §3.1）。 */
const NEVER_ATTACK = new Set(['creeper']);
/** 只在"主人刚掉血"时才打（平时去惹会被反打）。 */
const ONLY_IF_HURT = new Set(['enderman']);

/**
 * 该不该护主？**纯函数**，把 07 §3.1 的每一条都写成可数的分支。
 *
 * @param {object} s 现场快照
 *   following      是否正在跟随主人（这是总开关：07 §3.1 "只在跟随主人时生效"）
 *   ownerHurt      主人是否刚掉血（entityHurt）
 *   selfHp         自己的血量
 *   candidates     敌对生物列表 [{ id, name, distToOwner, dyToOwner, isPlayer? }]
 *   ignored        Map/Set：id -> 忽略到什么时候（时间戳）
 *   now            当前时间
 * @returns {{act:boolean, reason:string, target?:object}}
 */
export function decideProtect(s = {}) {
    const now = Number(s.now ?? 0);

    // ① 总开关：不在跟随主人 → 不管（self_defense 只保护她自己）
    if (!s.following) return { act: false, reason: 'not-following' };

    // ② 自己快不行了 → 先保命（交给 cowardice / self_preservation）
    if (Number(s.selfHp ?? 20) < PROTECT.SELF_HP_MIN) return { act: false, reason: 'self-hp-low' };

    const ownerHurt = !!s.ownerHurt;
    const range = ownerHurt ? PROTECT.HURT_RANGE : PROTECT.NEAR_OWNER;

    const eligible = [];
    for (const e of (s.candidates ?? [])) {
        if (!e) continue;
        if (e.isPlayer) continue;                              // ③ 不打玩家
        const name = String(e.name ?? '').replace('minecraft:', '');
        if (NEVER_ATTACK.has(name)) continue;                   // ③ 不打苦力怕（会在主人身边炸）
        if (ONLY_IF_HURT.has(name) && !ownerHurt) continue;     // ③ 末影人只在主人刚掉血时打

        const d = Number(e.distToOwner);
        const dy = Math.abs(Number(e.dyToOwner ?? 0));
        if (!Number.isFinite(d) || d > range) continue;
        if (dy > PROTECT.VERTICAL_SLACK) continue;

        // 放弃过的那只，30 秒内不再管
        const until = s.ignored?.get?.(e.id) ?? s.ignored?.[e.id] ?? 0;
        if (Number(until) > now) continue;

        eligible.push(e);
    }

    if (!eligible.length) return { act: false, reason: 'no-threat' };

    // 打**离主人最近**的那只（07 §3.1 原文）
    eligible.sort((a, b) => Number(a.distToOwner) - Number(b.distToOwner));
    return { act: true, reason: ownerHurt ? 'owner-hurt' : 'threat-near-owner', target: eligible[0] };
}

/**
 * 打的过程中该不该收手？同样纯函数。
 *
 * @param {object} s { targetAlive, distToOwner, foughtMs, selfHp }
 * @returns {{stop:boolean, reason:string}}
 */
export function shouldRelease(s = {}) {
    if (!s.targetAlive) return { stop: true, reason: 'target-dead' };
    if (Number(s.distToOwner) > PROTECT.RELEASE_DIST) return { stop: true, reason: 'too-far' };
    if (Number(s.foughtMs ?? 0) >= PROTECT.MAX_FIGHT_MS) return { stop: true, reason: 'time-limit' };
    if (Number(s.selfHp ?? 20) < PROTECT.SELF_HP_MIN) return { stop: true, reason: 'self-hp-low' };
    return { stop: false, reason: '' };
}
