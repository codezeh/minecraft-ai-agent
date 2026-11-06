/**
 * F-AI-205（2026-11-06）：这一轮到底算不算"用过命令"。
 *
 * 背景：`agent.js` 的 handleMessage 里原来是**无条件** `used_command = true`，
 * 于是"命令被权限拒绝"也计作"用了命令"。叠加 fail-closed（没配 owner 时连 `!endGoal` 也被拒）
 * 会形成**无人能停的循环**：
 *   history 让 goal 跨重启存活 → 自提示回合按该 author 定级 → 每轮都被拒
 *   → used_command 仍为 true → no_command_count 归零 → 循环永不自停（每 2 秒一次 LLM 调用，按量计费持续烧钱）。
 *
 * 修法：**被拒等价于没命令**。权限拒绝的回复由 `permissionDeniedReply()` 生成，
 * 固定以 `'[权限] 没执行 '` 开头（见 src/agent/permissions.js）。
 *
 * 为什么抽成函数：原来这段判断内联在 `handleMessage` 的深层流程里，**没法单测**
 * （grep `used_command` 在 tools/ 下零命中 ⇒ 谁删掉那段没人会红）。抽出来后：
 *   ① 行为可单测（被拒 → false；正常 → true）；
 *   ② 接线可断言（agent.js 必须调用它）。
 */

/** 权限拒绝回复的前缀（与 permissions.permissionDeniedReply 保持一致，单测会核对）。 */
export const PERMISSION_DENIED_PREFIX = '[权限] 没执行 ';

/** 这条 executeCommand 的结果是不是"被权限拒绝"。 */
export function isPermissionDeniedResult(res) {
    return typeof res === 'string' && res.startsWith(PERMISSION_DENIED_PREFIX);
}

/**
 * 本轮是否应计为"用过命令"。
 *
 * - 被权限拒绝 ⇒ **false**（关键：否则自提示循环永不自停）
 * - 其它任何返回值（正常执行、失败结果、对象/undefined）⇒ **true**
 *   ⚠️ 这里**故意不**"一刀切不置位"：只有"权限拒绝"这一种才是"什么都没发生"。
 *   普通执行失败（比如没材料）仍然算"她动了"，否则正常目标会被误判成"没命令"而提前停掉。
 */
export function shouldCountAsUsedCommand(res) {
    return !isPermissionDeniedResult(res);
}
