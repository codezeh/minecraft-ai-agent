/**
 * 复合：采集 N 个某方块。
 *
 * 策略层职责：失败换目标、黑名单、deadline、进度汇报。
 * 原子层只做一次尝试，所以这里的重试才是「重试」。
 */
import { ok, fail } from './contract.js';
import { countItem } from './query_perceive.js';
import { moveTo } from './nav_pathfinder.js';
// 第9条②：直驱 pathfinder 的调用点要进 nav 闸（只包 withNav，不改流程语义）。
import { withNav } from './nav_core.js';
import { digBlock } from './act_dig.js';
import { pauseGoalModes, restoreGoalModes } from './modes.js';
import { ensureAxe, ensureScaffold } from './tool_prep.js';
import { ScaffoldTracker } from './scaffold_cleanup.js';
import { planCollect, makeHandlers } from './flow_collect_plan.js';
import { runSteps } from './step_runner.js';

/**
 * 复合技能 manifest（04 §4.1 / §4.4）。
 * 注册表启动时校验它；给模型看的说明也由它生成（不再从函数体截 JSDoc，D24）。
 */
export const manifest = {
    name: 'collect',
    level: 'flow',
    summary: '采 N 个某种方块（会自己挑最近的目标、走过去、挖掉、捡起来）',
    params: {
        block: 'block',
        count: 'int 1..64 = 1',
        radius: 'int 4..128 = 48',
    },
    needs: { items: [], near: [] },
    claims: [],
    // 只用已在 CODES 注册的码。INVENTORY_FULL 是 02 §4 列的 7 个新码之一，**M6 才加**，
    // 现在写进来会让启动校验直接崩（这是校验器该有的行为：宁可启动失败，也不要运行时才发现）。
    codes: ['NO_TARGET', 'NO_TOOL', 'NO_PATH', 'NO_REACH', 'OUT_OF_REACH', 'STUCK', 'TIMEOUT', 'INTERRUPTED'],
    resumable: false,
    timeoutMs: 8 * 60 * 1000,
};


const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

// classifyLog / isProtected 已上提到 query_classify.js（纯查询判断，能单独跑、能单独测）
// 注意：地标"加载 + 缓存"在数据层 landmarks.protectedPlaces(bot)，
// 原子只接收算好的列表（原子不许读全局状态/读盘，见 ARCHITECTURE_REDESIGN §6.1）

export async function collect(bot, name, want, opts = {}) {
    const {
        deadlineMs = 8 * 60 * 1000,
        radius = 48,
        near = null,
        onEvent = () => {},
        // 3D 库目录：给了就让接近动作走 executor.walkTo（能爬台阶/绕岩浆），
        // 不给则退回旧 moveTo（原生 pathfinder，爬不上高差）。
        mapDir = null,
    } = opts;

    // 兼容两种输入：字符串（原来的行为）或一组方块名（「木头」类别）。
    const names = Array.isArray(name) ? name.filter(Boolean) : [name];
    if (!names.length) return fail('NO_TARGET', '没说要采集什么');
    const label = names.length === 1 ? names[0] : (opts.label || '目标方块');
    const countAll = () => names.reduce((sum, n) => sum + countItem(bot, n), 0);

    if (!Number.isFinite(want) || want < 1) {
        return fail('NO_TARGET', `要采集的数量不对（${want}）`);
    }

    const start = Date.now();
    const startCount = countAll();
    const blacklist = new Set();     // L3 职责：记下失败过的目标，别再选它
    let noMoreTargets = null;

    // 采集期间暂停会抢 goal 的 mode（item_collecting 会跟采集抢掉落物，unstuck 会中途挪走）
    const pausedBefore = pauseGoalModes(bot);

    // 垫脚方块追踪：pathfinder 为了够树顶/跨沟会临时放方块，任务结束要清掉
    const scaffolder = new ScaffoldTracker(bot);
    scaffolder.start();

    // ★ D6（2026-10-31）：try 从**这里**开始，不是从主循环开始。
    //
    // 原来 try 在主循环前（旧 :104），而"走到你旁边"里的 `return fail('INTERRUPTED')`
    // 在 try 之前 → 那条路径上 `restoreGoalModes` 和 `scaffolder.stop()` **都不会执行**：
    // item_collecting/unstuck 的 goal 一直暂停着（后续所有任务都不捡东西、不脱困），
    // blockUpdate 监听器也一直挂着。中断恰恰是最容易走到的那条路。
    // 现在凡是"已经改了全局状态"之后的任何退出，都要经过 finally。
    try {

    // 砍树前先准备工具（没有斧头就造一把）
    const isWood = names.some(n => /_log$|_stem$/.test(n));
    if (isWood) {
        try {
            const tool = await ensureAxe(bot);
            console.log(`[collect] 工具：${tool.why}`);
            onEvent({ type: 'tool', ok: tool.ok, axe: tool.axe, made: tool.made, why: tool.why });
        } catch (e) {
            console.log('[collect] 工具准备失败:', e.message);
        }
    }

    // 备垫脚方块。
    //
    // ★ 2026-10-29：3D 寻路为了够到高处（树顶/崖上）会 `dig` 往上挖，
    // 而挖上去必须手里有方块能垫。实测她只有斧头时：
    //   `[walkTo] 步1 dig(-94,67,-204) 失败: NO_ITEM 没有可垫脚的方块`
    // 然后原地卡住、一个木头都拿不到。
    //
    // ensureScaffold 会就地挖附近的土/石来补（不需要事先给），
    // 所以这里先备 8 个，够爬几格就行；失败也不阻断（可能本来就够）。
    if (mapDir) {
        try {
            const sc = await ensureScaffold(bot, { need: 8, maxMs: 15000, onEvent });
            console.log(`[collect] 垫脚方块：${sc.why}`);
            onEvent({ type: 'scaffold', ok: sc.ok, have: sc.have, count: sc.got, why: sc.why });
        } catch (e) {
            console.log('[collect] 备垫脚方块失败:', String(e?.message ?? e).slice(0, 60));
        }
    }

    // 给了 near（「砍我旁边的树」）就先走过去。
    // 实测两人相距 25 格时，光按 near 排序不够 —— 她站在原地砍自己周围那些。
    if (near && Number.isFinite(near.x) && Number.isFinite(near.z)) {
        const d = Math.hypot(near.x - bot.entity.position.x, near.z - bot.entity.position.z);
        if (d > 8) {
            console.log(`[collect] 先走到你旁边（现在 ${d.toFixed(0)} 格）`);
            onEvent({ type: 'approach-anchor', dist: Math.round(d) });
            const mv = (await withNav(bot, () => moveTo(bot,
                { kind: 'point', pos: { x: near.x, y: near.y ?? bot.entity.position.y, z: near.z } },
                { tol: 4, timeout: 45000 })))
                ?? fail('BLOCKED', '导航被别的任务占用（先走到你旁边这一步没做成）', { count: 0, retryable: true });
            if (mv.code === 'INTERRUPTED') {
                return fail('INTERRUPTED', '停了', { count: 0 });
            }
            const after = Math.hypot(near.x - bot.entity.position.x, near.z - bot.entity.position.z);
            onEvent({ type: mv.ok ? 'anchor-reached' : 'anchor-failed', dist: Math.round(after), code: mv.code });
        }
    }

    // ---- L3 主循环：只管"还差多少、还剩多少时间"，不碰具体动作 ----
        let rounds = 0;
        const MAX_ROUNDS = 40;      // 防止 plan 一直产出同一批目标导致死循环

        while (countAll() - startCount < want) {
            if (bot.interrupt_code) {
                const got = countAll() - startCount;
                return fail('INTERRUPTED', `停了，已经拿到 ${got}/${want}`, { count: got });
            }
            if (Date.now() - start > deadlineMs) {
                const got = countAll() - startCount;
                return fail('TIMEOUT', `时间到了，只拿到 ${got}/${want}`, { count: got, costMs: Date.now() - start });
            }
            if (++rounds > MAX_ROUNDS) {
                noMoreTargets = `找不到更多 ${label} 了`;
                break;
            }

            const need = want - (countAll() - startCount);

            // ---- L2：规划一段序列（只读世界） ----
            const plan = planCollect(bot, {
                blockNames: names,
                want: need,
                near,
                maxTargets: Math.min(8, Math.max(2, need)),
                skip: blacklist,
                onEvent,     // 树体判断/砍伐规划的事件透给上层
            });

            if (!plan.ok) {
                noMoreTargets = plan.message;
                onEvent({ type: 'no-target', code: plan.code, message: plan.message });
                break;
            }

            onEvent({
                type: 'plan',
                steps: plan.data.steps.length,
                planned: plan.data.planned,
                skipped: plan.data.skipped.length,
                round: rounds,
            });

            // ---- L2：执行这段序列 ----
            const before = countAll();
            const handlers = makeHandlers({
                countFn: countAll,
                // 不传 baseCount：让 collectDrops 每次调用自己快照，
                // 否则"任务开始时"的基准会让第 2 次以后的捡拾永远判成功（实测 bug）
                onEvent,
                // 传了 mapDir，接近动作才会走 3D 链路（见 makeHandlers 里的说明）
                mapDir,
            });

            const run = await runSteps(bot, plan.data.steps, {
                handlers,
                deadlineMs: Math.max(2000, deadlineMs - (Date.now() - start)),
                onStep: (e) => { if (e.type === 'step-failed') onEvent({ type: 'skip', ...e }); },
            });

            const got = countAll() - startCount;
            onEvent({ type: 'progress', count: got, want });

            // 本轮一个都没拿到 → 把失败的目标拉黑，避免下一轮又选同一批
            if (countAll() - before <= 0) {
                for (const f of (run.data?.failed ?? [])) {
                    if (f.pos) blacklist.add(`${Math.floor(f.pos.x)},${Math.floor(f.pos.y)},${Math.floor(f.pos.z)}`);
                }
                // 什么都没拿到且没记到失败目标 → 真的没了
                if (!(run.data?.failed ?? []).length) {
                    noMoreTargets = `附近没有能砍的 ${label} 了`;
                    break;
                }
            }

            if (run.code === 'INTERRUPTED') {
                return fail('INTERRUPTED', `停了，已经拿到 ${got}/${want}`, { count: got });
            }
        }

        // 收尾：再捡一遍最后位置（最后一格的掉落物可能还在飞）
        if (countAll() - startCount < want) {
            await sleep(300);
        }

        const collected = countAll() - startCount;
        if (collected >= want) {
            return ok({ count: collected, costMs: Date.now() - start, rounds });
        }
        const reason = noMoreTargets
            ? `${String(noMoreTargets).replace(/（已拿 \d+\/\d+）/, '')}，实际拿到 ${collected}/${want}`
            : `只拿到 ${collected}/${want}`;
        return fail('NO_TARGET', reason, { count: collected, costMs: Date.now() - start, rounds });

    } finally {
        restoreGoalModes(bot, pausedBefore);

        // 清掉垫脚方块（用户要求：砍完树要把垫脚的方块清掉）。
        // 只清「任务期间记录到的、现在还是那个方块」的，不碰别人的放置。
        scaffolder.stop();
        if (scaffolder.size > 0) {
            try {
                const r = await scaffolder.cleanup(digBlock, { maxMs: 20000 });
                if (r.removed || r.skipped) {
                    console.log(`[collect] 清理垫脚：清掉 ${r.removed} 个，跳过 ${r.skipped} 个`);
                    onEvent({ type: 'scaffold-cleanup', ...r });
                }
            } catch (e) {
                console.log('[collect] 清理垫脚失败:', e.message);
            }
        }
    }
}
