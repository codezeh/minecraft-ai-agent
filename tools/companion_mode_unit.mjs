#!/usr/bin/env node
/**
 * 命令可见面单测 —— F-GATE-001 + F-AI-204（2026-11-06）
 *
 * 背景：`commands/index.js` 的 `isVisibleToModel()` 原来是
 *     if (!settings.companion_mode) return true;
 * 而 `companion_mode` **从未在 settings_spec.json 声明** ⇒ 面板创建的 agent 键恒缺失
 * ⇒ 恒 falsy ⇒ 恒 `return true` ⇒ 模型能看到**全部 70 条**命令，
 * 方案 §12 的"只给 8 条"从未生效（实测 8.75 倍）。
 *
 * 本文件钉住三条语义，防止有人把默认方向改回去：
 *   ① 键缺失          ⇒ **收敛**（只 8 条白名单）      ← 这是本次行为变更的核心
 *   ② 显式 true       ⇒ 收敛
 *   ③ 显式 false      ⇒ **全开**（老行为，留作恢复手段）
 *
 * 为什么用 `settings.companion_mode = …` 直接改：`settings` 是 settings.js 的 default
 * 导出对象，`isVisibleToModel` 每次调用都读它 ⇒ 运行期改值即可覆盖三种情形，无需重启进程。
 *
 * 退出码：0 = 全过；1 = 有 FAIL。
 */
import settings from '../src/agent/settings.js';
import { isVisibleToModel, COMPANION_COMMANDS } from '../src/agent/commands/index.js';
import { queryList } from '../src/agent/commands/queries.js';
import { actionsList } from '../src/agent/commands/actions.js';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  ${detail}` : ''}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`); }
};

const ALL = queryList.concat(actionsList).map((c) => c.name);
const visibleCount = () => ALL.filter((n) => isVisibleToModel(n)).length;

console.log('命令可见面（F-GATE-001 / F-AI-204）');
console.log(`  注册命令 ${ALL.length} 条；白名单 ${COMPANION_COMMANDS.length} 条\n`);

// ── ① 键缺失 ⇒ 收敛 ────────────────────────────────────────
{
    delete settings.companion_mode;
    check('键缺失（undefined）⇒ 收敛到白名单', visibleCount() === COMPANION_COMMANDS.length,
        `可见 ${visibleCount()} / 白名单 ${COMPANION_COMMANDS.length}`);
    check('键缺失 ⇒ 白名单外的命令不可见（抽样 !newAction）',
        isVisibleToModel('!newAction') === false);
    check('键缺失 ⇒ 白名单内的命令仍可见（抽样 !stop）',
        isVisibleToModel('!stop') === true);
}

// ── ② 显式 true ⇒ 收敛 ────────────────────────────────────
{
    settings.companion_mode = true;
    check('显式 true ⇒ 收敛到白名单', visibleCount() === COMPANION_COMMANDS.length,
        `可见 ${visibleCount()}`);
}

// ── ③ 显式 false ⇒ 全开（恢复老行为的唯一开关）──────────────
{
    settings.companion_mode = false;
    check('显式 false ⇒ 全开（老行为 / 恢复手段）', visibleCount() === ALL.length,
        `可见 ${visibleCount()} / 全部 ${ALL.length}`);
    check('显式 false ⇒ 白名单外的命令也可见（抽样 !newAction）',
        isVisibleToModel('!newAction') === true);
}

// ── ④ 类型不对（不是布尔）⇒ 按收敛处理（fail-closed）────────
{
    settings.companion_mode = 'false';       // 字符串，不是布尔 false
    check('非布尔值（"false" 字符串）⇒ 按收敛处理，不误判成全开',
        visibleCount() === COMPANION_COMMANDS.length, `可见 ${visibleCount()}`);
}

// 收尾：还原成"键缺失"，避免影响同进程其它测试
delete settings.companion_mode;

console.log(`\n============ 合计 ${pass} PASS / ${fail} FAIL ============`);
process.exit(fail === 0 ? 0 : 1);
