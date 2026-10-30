/**
 * 规则运行时：所有「游戏规则」只能从这里取，不许在业务代码里写字面量。
 *
 * 三层来源（见 game_rules.json meta.source_levels）：
 *   R1 注册表 —— 运行时从 bot.registry 派生，能算就别抄
 *   R2 库源码 —— 带 文件:行号
 *   R3 实测   —— 唯一能推翻 R1/R2 的级别
 *
 * 关键约束：**status 不是 verified 的规则，不允许被代码使用**。
 * 想用 R1-05（重力方块白名单）？先去验证它，把 status 改成 verified。
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const DATA_PATH = fileURLToPath(new URL('./game_rules.json', import.meta.url));

let _data = null;
function data() {
    if (!_data) _data = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
    return _data;
}

/** 全部规则 id（审计用）。 */
export function ruleIds() {
    return data().rules.map(r => r.id);
}

/** 取一条规则；不存在直接抛，避免"引用了不存在的规则"。 */
export function getRule(id) {
    const r = data().rules.find(x => x.id === id);
    if (!r) throw new Error(`规则不存在: ${id}（先写进 game_rules.json）`);
    return r;
}

/** 取一条**已验证**的规则。未验证的规则禁止进入决策路径。 */
export function requireVerified(id) {
    const r = getRule(id);
    if (r.status !== 'verified') {
        throw new Error(
            `规则 ${id} 状态是 ${r.status}，不能用于决策：${r.claim}` +
            (r.note ? `（${r.note}）` : '')
        );
    }
    return r;
}

/** derived 数值必须挂在一条已验证规则上，否则也抛。 */
export function derived(name) {
    const d = data().derived?.[name];
    if (!d) throw new Error(`derived 里没有 ${name}`);
    requireVerified(d.rule);
    return d.value;
}

// ---------------------------------------------------------------------------
// 常用派生值（都有出处，见 game_rules.json）
// ---------------------------------------------------------------------------

/**
 * 可用的挖掘距离（R3-01 实测 6.11 仍成功，取保守 5.1）。
 *
 * 刻意做成函数而不是常量：模块加载时不应因为某条规则还没验证就整包炸掉，
 * 只有真正要用这个值的代码路径才承担校验失败。
 */
export function digReach() {
    return derived('dig_reach_usable');
}

/** 眼高（R2-01）。 */
export const EYE_HEIGHT = derived('eye_height');

/** pathfinder / GoalLookAtBlock 的默认 reach（R2-02）。 */
export const GOAL_LOOK_AT_DEFAULT_REACH = derived('goal_look_at_block_default_reach');

// ---------------------------------------------------------------------------
// R1：从注册表派生，永远不抄数字
// ---------------------------------------------------------------------------

function blockOf(bot, name) {
    return bot?.registry?.blocksByName?.[name] ?? null;
}

/** 该方块是否需要特定工具（harvestTools 存在即为需要）。 */
export function requiresTool(bot, name) {
    const b = blockOf(bot, name);
    if (!b) return null;
    return b.harvestTools !== undefined && b.harvestTools !== null;
}

/** 手持某物品能否采集该方块。与 mineflayer 的 block.canHarvest 同义，但出处明确。 */
export function canHarvestWith(bot, name, heldItemId) {
    const b = blockOf(bot, name);
    if (!b) return null;
    if (b.harvestTools === undefined || b.harvestTools === null) return true;
    if (heldItemId == null) return false;
    return b.harvestTools[heldItemId] === true;
}

/** 方块硬度（用于估算挖掘耗时，别抄 2.0 这种数字）。 */
export function hardnessOf(bot, name) {
    const b = blockOf(bot, name);
    return b ? b.hardness : null;
}

/** 叶子 distance 状态的上限（默认 7），用于判断枯萎范围。 */
export function leavesDistanceMax(bot, name = 'oak_leaves') {
    const b = blockOf(bot, name);
    const st = (b?.states || []).find(s => s.name === 'distance');
    return st?.num_values ?? null;
}

/** 玩家实体尺寸（R1-04），从注册表来，不写 1.8/0.6。 */
export function playerBox(bot) {
    const e = bot?.registry?.entitiesByName?.player;
    return { width: e?.width ?? null, height: e?.height ?? null };
}

/**
 * 重力方块判定。
 *
 * 注意：minecraft-data 的 block 定义里**没有** gravity 字段（只有 boundingBox/material/
 * hardness 等），所以这条不能从 R1 派生，必须靠 R3 探针或读源码。规则 R1-05 目前
 * 状态是 unverified，因此这里直接抛错——不允许"我记得沙子会掉"就下判断。
 */
export function isGravityBlock() {
    requireVerified('R1-05');
    throw new Error('unreachable');
}

/** 启动自检：规则表自身是否自洽。 */
export function assertRulesIntact() {
    const ids = new Set();
    const problems = [];
    for (const r of data().rules) {
        if (ids.has(r.id)) problems.push(`重复 id: ${r.id}`);
        ids.add(r.id);
        for (const k of ['id', 'claim', 'source', 'ref', 'status']) {
            if (!r[k]) problems.push(`${r.id} 缺字段 ${k}`);
        }
        if (!['R1', 'R2', 'R3'].includes(r.source)) problems.push(`${r.id} source 非法: ${r.source}`);
        if (!['verified', 'unverified', 'defective'].includes(r.status)) problems.push(`${r.id} status 非法: ${r.status}`);
        if (r.status === 'verified' && !r.evidence) problems.push(`${r.id} 标了 verified 却没有 evidence`);
    }
    for (const [name, d] of Object.entries(data().derived || {})) {
        if (!ids.has(d.rule)) problems.push(`derived.${name} 指向不存在的规则 ${d.rule}`);
    }
    return problems;
}
