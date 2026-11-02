/**
 * M9 protect_owner 单测（07 §3.1）—— **计数断言**，不靠"看起来对"。
 *
 * 07 §3.1 的真机验收三条：
 *   跟随中刷僵尸 → 打；刷苦力怕 → 不动手；不在跟随时刷僵尸 → 不管。
 * 外加它列的每一条规则都单独数一遍。
 */
import { decideProtect, shouldRelease, PROTECT } from '../src/agent/library/protect_owner.js';

let pass = 0, fails = 0;
const ok = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const bad = (n, a) => { fails++; console.log(`FAIL ${n} ${JSON.stringify(a)}`); };

const hostile = (name, distToOwner, dy = 0, id = 1, extra = {}) =>
    ({ id, name, distToOwner, dyToOwner: dy, ...extra });

// ① 跟随时刷僵尸 → 打
{
    const r = decideProtect({ following: true, selfHp: 20, now: 100, candidates: [hostile('zombie', 3)] });
    if (r.act && r.target?.name === 'zombie') ok('① 跟随中 + 僵尸 6 格内 → 打', `reason=${r.reason}`);
    else bad('① 跟随时打僵尸', r);
}

// ② 不在跟随时刷僵尸 → **不管**（self_defense 只保护她自己）
{
    const r = decideProtect({ following: false, selfHp: 20, now: 100, candidates: [hostile('zombie', 2)] });
    if (!r.act && r.reason === 'not-following') ok('② 不在跟随 → 不管（not-following）', r.reason);
    else bad('② 不跟随时不该动手', r);
}

// ③ 苦力怕 → **不动手**（近战会在主人身边引爆）
{
    const r = decideProtect({ following: true, selfHp: 20, now: 100, candidates: [hostile('creeper', 2)] });
    if (!r.act) ok('③ 苦力怕 → 不动手（避免在主人身边引爆）', r.reason);
    else bad('③ 苦力怕不该打', r);
}

// ④ 玩家 → 不动手
{
    const r = decideProtect({ following: true, selfHp: 20, now: 100, candidates: [hostile('Steve', 2, 0, 9, { isPlayer: true })] });
    if (!r.act) ok('④ 玩家 → 不动手', r.reason);
    else bad('④ 玩家不该打', r);
}

// ⑤ 末影人：平时不打；主人刚掉血才打
{
    const normal = decideProtect({ following: true, selfHp: 20, now: 100, candidates: [hostile('enderman', 3)] });
    const hurt = decideProtect({ following: true, ownerHurt: true, selfHp: 20, now: 100, candidates: [hostile('enderman', 3)] });
    if (!normal.act && hurt.act) ok('⑤ 末影人：平时不打、主人刚掉血才打', `${normal.reason} → ${hurt.reason}`);
    else bad('⑤ 末影人规则', { normal, hurt });
}

// ⑥ 距离阈值：6 格内打、6 格外不打；主人掉血时放宽到 8
{
    const at5 = decideProtect({ following: true, selfHp: 20, now: 1, candidates: [hostile('zombie', 5)] });
    const at7 = decideProtect({ following: true, selfHp: 20, now: 1, candidates: [hostile('zombie', 7)] });
    const hurt7 = decideProtect({ following: true, ownerHurt: true, selfHp: 20, now: 1, candidates: [hostile('zombie', 7)] });
    if (at5.act && !at7.act && hurt7.act) {
        ok('⑥ 距离：6 内打 / 6 外不打 / 主人掉血时 8 内也打', `${PROTECT.NEAR_OWNER}/${PROTECT.HURT_RANGE}`);
    } else bad('⑥ 距离阈值', { at5: at5.act, at7: at7.act, hurt7: hurt7.act });
}

// ⑦ 高差 > 3 → 不打（够不着/不在同一层）
{
    const r = decideProtect({ following: true, selfHp: 20, now: 1, candidates: [hostile('zombie', 2, 5)] });
    if (!r.act) ok('⑦ 高差 5 > 3 → 不打', `slack=${PROTECT.VERTICAL_SLACK}`);
    else bad('⑦ 高差', r);
}

// ⑧ 自己血量 < 8 → 收手（交给 cowardice）
{
    const r = decideProtect({ following: true, selfHp: 5, now: 1, candidates: [hostile('zombie', 2)] });
    if (!r.act && r.reason === 'self-hp-low') ok('⑧ 自己血量 5 < 8 → 不打（先保命）', r.reason);
    else bad('⑧ 自己血量低', r);
}

// ⑨ 打**离主人最近**的那只（多个候选）
{
    const r = decideProtect({
        following: true, selfHp: 20, now: 1,
        candidates: [hostile('zombie', 5, 0, 1), hostile('skeleton', 2, 0, 2), hostile('spider', 4, 0, 3)],
    });
    if (r.act && r.target?.id === 2) ok('⑨ 多个威胁时打离主人最近的那只', `target=id${r.target?.id} dist=${r.target?.distToOwner}`);
    else bad('⑨ 选最近', r);
}

// ⑩ 放弃过的那只 30 秒内不再管
{
    const ignored = new Map([[1, 50_000]]);
    const inWindow = decideProtect({ following: true, selfHp: 20, now: 40_000, ignored, candidates: [hostile('zombie', 2, 0, 1)] });
    const afterWindow = decideProtect({ following: true, selfHp: 20, now: 51_000, ignored, candidates: [hostile('zombie', 2, 0, 1)] });
    if (!inWindow.act && afterWindow.act) ok('⑩ 放弃过的目标 30 秒内不管、之后重新考虑', `ignore=${PROTECT.IGNORE_MS}ms`);
    else bad('⑩ 忽略窗口', { inWindow, afterWindow });
}

// ⑪ 收手条件逐条（计数断言）
{
    const cases = [
        [{ targetAlive: false }, true, 'target-dead'],
        [{ targetAlive: true, distToOwner: 20 }, true, 'too-far'],
        [{ targetAlive: true, distToOwner: 2, foughtMs: PROTECT.MAX_FIGHT_MS }, true, 'time-limit'],
        [{ targetAlive: true, distToOwner: 2, foughtMs: 100, selfHp: 5 }, true, 'self-hp-low'],
        [{ targetAlive: true, distToOwner: 2, foughtMs: 100, selfHp: 20 }, false, ''],
    ];
    const wrong = cases.filter(([s, exp, why]) => {
        const r = shouldRelease(s);
        return r.stop !== exp || (why && r.reason !== why);
    });
    if (wrong.length === 0) ok('⑪ 收手四条：死了/太远/超时/自己血低 全对', `${cases.length} 组`);
    else bad('⑪ 收手条件', wrong.map(([s, e]) => ({ s, e })));
}

console.log('============================================');
console.log(`${pass}/${pass + fails} 个用例通过`);
console.log('============================================');
process.exit(fails === 0 ? 0 : 1);
