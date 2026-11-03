/**
 * 离线单元测试总入口 —— **不需要 Minecraft 服务器**。
 *
 * 为什么需要：`tools/atom_all.mjs` 要测试服 25566，服务器没开时根本跑不了；
 * 而这轮（Phase 1 + Phase 2）新增的回归脚本都是"假 bot + 纯逻辑"，
 * 本来就能离线跑。没有统一入口的话，要么漏跑，要么各跑各的。
 *
 * 用法：
 *   node tools/unit_all.mjs            # 跑全部（**跳过**要真机数据的，见 NEEDS_REAL_DATA）
 *   node tools/unit_all.mjs terrain    # 只跑文件名含 "terrain" 的
 *   node tools/unit_all.mjs --real     # 连要真机数据的也跑（本机得有 bots/<名字>/map 里的库）
 *
 * 约定：每个脚本自己打印 `PASS/FAIL`，全过退出码 0。
 * 这里额外检查"至少跑出一条用例"，防止脚本中途静默退出被当成通过
 * （同一个坑在 atom_all 上踩过，见 tools/atom_all.mjs 的说明）。
 */
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { join } from 'path';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** 离线回归脚本（新增离线测试后记得加进来） */
const UNITS = [
    'atom_classify_unit',        // 原子纯函数化 + 地标缓存按 bot 隔离
    'atom_input_unit',           // Phase A：输入原子唯一出口 + A3/A7（中断/松键）+ 白名单
    'composite_registry_unit',   // M5：注册表启动校验 / params 解析 / ctx 工厂 / listSkills（D24 正解）
    'act_p0_unit',               // M6 P0：11 个动作的 ActionResult 契约与错误码归类
    'act_p1_unit',               // M6 P1：8 个动作（睡/醒/开关/骨粉/喂/交易/钓鱼/游泳）契约与错误码
    'flow_p0_unit',              // M7 P0：craft/smelt/store/fetch 流程 + 注册表负向用例
    'flow_p1_unit',              // M7 P0 第二批：eat/mine/farm/fight/build 流程
    'board_store_unit',          // M8 B1：任务板状态机 / 领单原子性 / 租约过期（假时钟）/ 重启恢复
    'board_iface_unit',          // M8 B1：client/server 契约（list/get 同步）+ 服务端三道安全校验
    'board_nofallback_unit',     // M8 B1：无板降级回归（board=null 行为与加板前一致）
    'board_cmd_unit',            // M8 B1：!addJob/!jobs/!cancelJob 三条命令 + 权限 + 参数校验
    'flow_mine_notool_unit',     // t21：mine 的 NO_TOOL 假失败 + 三态判据（读不到≠没工具）
    'find_stand_unit',           // t65：findStandNear 四邻站位判据（脚下悬空/水/岩浆不算 + 读炸不崩，含反向验证）
    'board_scheduler_unit',      // M8 B2：调度主循环 / 抢占规则 / autoClaim / requeueStaleBrief
    'board_b3_unit',             // M8 B3：多人单拆单 / 6 种预约 key + TTL / 角色过滤 / dependsOn
    'board_b4_unit',             // M8 B4：共享地标/危险点/箱子内容 + 迁移幂等 + 单一真相
    'container_fix_unit',        // act_container 三个真机 bug 回归（.id 解析 / 窗口校验 / 计数口径）
    'code_hints_unit',           // M9：code_hints 覆盖全部 38 个码 + 一行 ≤200 字格式
    'protect_owner_unit',        // M9：护主判定（跟随才生效/不打苦力怕玩家/6-8格/收手四条）
    'idle_planner_unit',         // M9：空闲三定义 + 08 §6.1 三层顺序
    'strat_obtain_unit',         // M10：strat_obtain 来源顺序 + ★防无限展开 + 不碰身体
    'strat_tool_tier_unit',      // M10：strat_tool_tier 不跳档 / 已够直接 ok / 三件工具
    'strat_first_night_unit',    // M10：first_night 跳过已满足 / dependsOn / 嵌套闸 / 不碰身体
    'job_budget_unit',           // A2：ctx.jobBudget 跨调用共享（无 ctx 行为不变 / 余量生效 / hitCap 上报）
    'exec_dig_horizontal_unit',
    'nav_lock_unit',   // t66：导航「单一驱动者」闸（含反向验证）
    'path3d_tunnel_unit',        // t45：横向隧道 dig 边（目标 y=当前层 / 后继不变 / 垂直 dig 不变）
    'flow_shelter_unit',         // t31：flow_shelter 蓝图形状 + 材料判断 + idle_planner 死分支接线
    'flow_build_support_unit',   // t31：flow_build 支撑判据（A/B/C，含防循环论证反例）
    'idle_fakeclock_unit',       // t31：idle_planner 假时钟（30s 阈值 / 有单不规划 / 5min 节流）
    'board_payload_unit',        // M8 B1（t20 补）：10 个 board:* 事件的 payload 形状（表驱动，防"[object Object]"式恒 null）
    'board_scope_unit',          // M8 B2（t23 补）：refresh({scope}) 语义边界 —— mine/claimable/all + 未知报错 + 共享单抢占端到端
    'board_add_recall_unit',     // t65：board_client.add 超时回查（认得到当成功 / 认不到仍失败 / 非 TIMEOUT 不回查，含反向验证）
    'board_store_converge_unit', // t65：claimFor 的 convergeIfSatisfied 收敛（达标不派发）+ dependsSatisfied 前置不存在/blocked/failed + ★静默阻塞实测
    'board_store_finish_unit',   // t65：finish 活子单/全终结/已达标三分支 + FAILED·BLOCKED 耗尽 + progress 单调（3 条已知 bug 走 XFAIL）
    'atom_stand_unit',           // D27 岩浆格不能站（脚位 / 头位）
    'atom_stuck_detect_unit',    // 卡住判据（垂直权重 / 真实位移 / NaN）
    'control_reasons_unit',      // M2：停的原因 → 任务单去哪 + D17/D18/D19/D10（控制层）
    'detect_trapped_unit',       // 被困判据（面积/封顶/出口/地表）
    'exec_landing_unit',         // D14 落点检查真的执行（岩浆面拦，水面照走）
    'fall_risk_unit',            // 坠落/虚空反射（悬崖与虚空要拒绝；列无数据不算虚空）
    'exec_step_dig_unit',        // D2 挖邻列 / 液体不假成功
    'exec_step_y_unit',          // D1 y 语义（脚位 vs 面位）
    'mindserver_local_only_unit', // socket 只放本机连接（第一轮安全项）
    'nav_core_unit',             // 导航入口的坐标归一与前置
    'permissions_unit',          // M1：按发言人分级 + 斜杠命令白名单（提示词注入改不了等级）
    'scaffold_tracker_unit',     // D7 只清自己放的方块
    'server_props_unit',         // M1：server.properties 读取 + RCON 凭据按端口认领（不写死密码）
    'task_pickup_unit',          // 掉落物回收搬到复合层后语义不变
    'terrain3d_unit',            // 连接复用 / fail 表 TTL / prune
    'test_escape',               // skill_escape 规划（假 bot，纯读世界）
    'test_tunnel',               // 掘进安全检查（含 D15 液体地板）
    'tool_prep_timeout_unit',    // D12 goto/dig/craft 有上限
    'verify_y_semantics',        // 在真机录的地图库上量化 y 语义（needsRealData）
];

/**
 * 需要真机数据的脚本 —— 默认**跳过**，加 `--real` 才跑（见 docs/architecture/09_crosscut.md §5.2）。
 *
 * 为什么按名字单独标：这类脚本读 `bots/<名字>/map/` 里真机录的库，
 * 换台机器 / 清过 bots 目录就跑不动。混在默认集合里，
 * 要么每次都得手动摘掉，要么一红就以为是代码坏了。
 */
const NEEDS_REAL_DATA = new Set([
    'verify_y_semantics',        // 读真机地形库 terrain3d.db（没有那个库无法量化 y 语义）
]);

const argv = process.argv.slice(2);
const withReal = argv.includes('--real');
const filter = argv.filter((a) => !a.startsWith('--'));
const picked = filter.length ? UNITS.filter((n) => filter.some((f) => n.includes(f))) : UNITS;
const list = picked.filter((n) => withReal || !NEEDS_REAL_DATA.has(n));
const skipped = picked.filter((n) => !withReal && NEEDS_REAL_DATA.has(n));

if (skipped.length) {
    console.log(`跳过 ${skipped.length} 个需要真机数据的脚本（加 --real 才跑）：${skipped.join(', ')}`);
}

let failed = 0;
const results = [];

for (const name of list) {
    const script = join(HERE, `${name}.mjs`);
    process.stdout.write(`\n===== ${name} =====\n`);
    try {
        const out = execFileSync(process.execPath, [script], {
            encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const printed = String(out);
        process.stdout.write(printed);
        // ★ 2026-11-01 修：只数**行首**的 PASS（同 atom_all）。汇总行里也含 "PASS" 字样，
        // 用词边界匹配会把汇总行算成一条用例，显示数系统性虚高。
        const passCount = (printed.match(/^\s*PASS\s/mg) || []).length;
        if (passCount === 0) {
            console.log(`  ✗ ${name} 一条 PASS 都没有 —— 视为失败`);
            results.push({ name, ok: false, code: 'NO_CASES_RAN' });
            failed++;
        } else {
            results.push({ name, ok: true, cases: passCount });
        }
    } catch (e) {
        const printed = `${e.stdout ?? ''}`;
        if (printed.trim()) process.stdout.write(printed);
        results.push({ name, ok: false, code: e.status ?? 'error' });
        failed++;
    }
}

console.log('\n================ 离线单测总览 ================');
for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? `  (${r.cases} 个用例)` : `  (exit ${r.code})`}`);
}
for (const name of skipped) {
    console.log(`  ⏭ ${name}  (需要真机数据，加 --real 跑)`);
}
console.log(`  ${results.length - failed}/${results.length} 个脚本通过${skipped.length ? `，${skipped.length} 个跳过` : ''}`);
console.log('  （这些都不需要服务器；需要真机的另有 tools/atom_all.mjs）');
console.log('============================================');
process.exit(failed === 0 ? 0 : 1);
