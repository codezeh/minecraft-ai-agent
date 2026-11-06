/**
 * F-AI-205 回归测试（2026-11-06）
 *
 * 守什么：**"命令被权限拒绝"不能算"用过命令"**。
 *
 * 为什么这条必须有测试：修之前是**无条件** `used_command = true`，叠加 fail-closed 会形成
 * **无人能停的循环**（每 2 秒一次 LLM 调用、按量计费持续烧钱、玩家叫不停）。
 * 修好后若有人把这段删掉/改回去，**没有任何测试会红** —— 所以补这条。
 *
 * 断言（正向 + 反向，缺一不可）：
 *   ① 被拒（`[权限] 没执行 …`）→ 不计入 used_command
 *   ② 正常执行成功（普通字符串 / 对象结果）→ **仍**计入（防止"一刀切不置位"把正常目标弄死）
 *   ③ 前缀常量与 permissions.permissionDeniedReply 实际输出**对得上**（防两边漂移）
 *   ④ 接线：agent.js 真的调用了这个判断（防"写了没人用"）
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    PERMISSION_DENIED_PREFIX,
    isPermissionDeniedResult,
    shouldCountAsUsedCommand,
} from '../src/agent/used_command.js';
import { permissionDeniedReply, LEVEL } from '../src/agent/permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

// ── ① 被权限拒绝 ⇒ 不计入（F-AI-205 的核心）────────────────────
const denied = permissionDeniedReply(LEVEL.OTHER, '!goal', 'Stranger');
check('permissionDeniedReply 的输出被判为"权限拒绝"', isPermissionDeniedResult(denied), denied.slice(0, 40));
check('被拒 ⇒ 不计入 used_command（核心断言）', shouldCountAsUsedCommand(denied) === false);
check('另一种拒绝形态（信任级不足）同样不计入',
    shouldCountAsUsedCommand(permissionDeniedReply(LEVEL.TRUSTED, '!newAction', 'FriendA')) === false);

// ── ② 反向断言：正常执行仍计入（防"一刀切"）────────────────────
check('正常执行（字符串结果）⇒ 仍计入', shouldCountAsUsedCommand('已挖 3 个方块') === true);
check('执行失败但没被拒（例如 NO_MATERIAL）⇒ 仍计入（她确实动了）',
    shouldCountAsUsedCommand("没材料：缺 oak_log") === true);
check('对象型结果 ⇒ 仍计入', shouldCountAsUsedCommand({ ok: true, code: 'OK' }) === true);
check('undefined / null ⇒ 仍计入（不因空值改变语义）',
    shouldCountAsUsedCommand(undefined) === true && shouldCountAsUsedCommand(null) === true);
check('只说"[权限] …"但不是拒绝话术的文本 ⇒ 不算拒绝（口径只认精确前缀）',
    shouldCountAsUsedCommand('[权限] 说明：这只是文档') === true);
check('恰好等于前缀（无后续）也算拒绝', isPermissionDeniedResult(PERMISSION_DENIED_PREFIX) === true);

// ── ③ 前缀不漂移：常量必须与 permissions 的实际输出一致 ──────────
check('PERMISSION_DENIED_PREFIX 与 permissionDeniedReply 输出前缀一致',
    denied.startsWith(PERMISSION_DENIED_PREFIX), PERMISSION_DENIED_PREFIX);

// ── ④ 接线：agent.js 必须真的调用（防删掉那段没人红）────────────
{
    const agentSrc = readFileSync(path.join(__dirname, '../src/agent/agent.js'), 'utf8');
    check('agent.js 引入了 used_command 的判断', /from '\.\/used_command\.js'/.test(agentSrc));
    check('agent.js 调用 isPermissionDeniedResult', /isPermissionDeniedResult\(execute_res\)/.test(agentSrc));
    check('agent.js 调用 shouldCountAsUsedCommand', /shouldCountAsUsedCommand\(execute_res\)/.test(agentSrc));
    check('agent.js 里"被拒就置 used_command"的老写法已消失',
        !/const __permDenied = typeof execute_res === 'string'/.test(agentSrc));
    // 关键：used_command 只有在"应计入"的分支里被置为 true
    check('used_command = true 仍存在（不是被删成永不置位）', /used_command = true;/.test(agentSrc));
}

console.log(`\n${fail ? 'FAIL' : 'ALL PASS'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
