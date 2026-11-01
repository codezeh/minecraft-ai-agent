/**
 * S2 主服基线：真实地形砍 8 个橡木 × N 轮。
 *
 * 为什么需要它：
 *   test_real_terrain.mjs 只跑**一次** S2（没法区分 60% 和 80%）；
 *   baseline_s2.mjs 是测试服超平坦自造树（测试服过不了，见交接文档 §7.3）。
 *   「主服 10 次成 8 次」这个唯一标准，之前没有 runner。
 *
 * 设计要点：
 *   1. 不 tp、不造地形：真实森林、真实寻路（tp / spreadplayers 都会触发 invalid_player_movement）
 *   2. 被踢后自动重连继续下一轮 —— agent 的真实行为就是这样，不重连就永远测不满
 *   3. 每轮记录「附近可选原木数」，区分"地形耗尽"和"代码失败"
 *   4. 每轮清背包（保留斧头/垫脚料），判据 = 报数 == 背包实际增量
 *   5. 每轮一条 JSONL，跑完打汇总 + 失败码直方图
 *
 * 用法：
 *   node tools/bench_s2_main.mjs [轮数=10]
 *   环境变量：BENCH_SETTLE_MS（开测前等服务器稳定的毫秒数，默认 45000）
 *   产物：../tmp/bench/<时间戳>-s2-main.jsonl
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { rcon } from './rcon.mjs';
import { inspectPhysics, installPositionGuard } from '../src/sim/position_guard.js';
import { collect } from '../src/agent/library/flow_collect.js';
import { digBlock } from '../src/agent/library/act_dig.js';
import { countItem, findBlocks } from '../src/agent/library/query_perceive.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });

const RUNS = Number(process.argv[2] || 10);
const WANT = 8;
const DEADLINE_MS = 8 * 60 * 1000;
const SETTLE_MS = Number(process.env.BENCH_SETTLE_MS || 45000);

// 真森林中心（`locate biome minecraft:forest` 查得，实测 32 格内 242~300 根原木）。
// 出生点旁有木头建筑：48 格内 66~71 根 oak_log 但基本全被判「不像天然树」（R3-07）。
const FOREST = [-272, -352];

// 每轮用新账号名，避免继承上次的位置状态（交接文档 §7.2 踩过的坑）
let BOT_SEQ = 0;
const nextName = () => `s2b${Date.now() % 100000}${BOT_SEQ++}`;

const OUT_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'tmp', 'bench');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT_FILE = join(OUT_DIR, `${STAMP}-s2-main.jsonl`);

let bot = null;
let botName = null;
let kicked = null;

function makeBot() {
    botName = nextName();
    kicked = null;
    bot = mineflayer.createBot({
        host: '127.0.0.1', port: 25565, username: botName, auth: 'offline', version: '1.21.8',
    });
    bot.loadPlugin(pf.pathfinder);
    installPositionGuard(bot);
    bot.on('error', () => { });
    bot.on('kicked', (r) => {
        const t = JSON.stringify(r);
        kicked = t.includes('invalid_player_movement') ? 'invalid_player_movement'
            : t.includes('Invalid move') ? 'Invalid move'
                : t.slice(0, 60);
    });
    return bot;
}

/** 等 spawn 且坐标有效（spawn 瞬间可能是 NaN） */
async function waitReady(b, ms = 20000) {
    await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('spawn-timeout')), ms);
        b.once('spawn', () => { clearTimeout(t); res(); });
    });
    for (let i = 0; i < 40; i++) {
        const p = b.entity?.position;
        if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) return p;
        await sleep(250);
    }
    return null;
}

/** 走位：pathfinder 自己走。超时必须 stop()，否则下一次 goto 报 "Path was stopped" */
async function walkTo(x, y, z, label) {
    const p0 = bot?.entity?.position;
    if (!p0 || !Number.isFinite(p0.x) || !Number.isFinite(p0.z)) {
        return { ok: false, dist: null, err: 'position-not-ready' };
    }
    const d = Math.hypot(p0.x - x, p0.z - z);
    if (d < 8) return { ok: true, dist: Math.round(d), skipped: true };
    try {
        const p = bot.pathfinder.goto(new pf.goals.GoalNear(x, y, z, 5));
        await Promise.race([p, sleep(Math.min(240000, 8000 + d * 600)).then(() => { throw new Error(`timeout:${label}`); })]);
        return { ok: true, dist: Math.round(d) };
    } catch (e) {
        try { bot.pathfinder.stop(); } catch { }
        await sleep(500);
        return { ok: false, dist: Math.round(d), err: e.message };
    }
}

function snapshotContext() {
    // 上限必须给足：原来写 200，而附近常年就有 200+，于是 logsNear 永远是 200，
    // "树被砍光了要换方向"的判断从来没触发过（实测 5 轮都在同一片林子耗尽）
    const logs = findBlocks(bot, 'oak_log', 48, 600);
    return { logsNear: logs.length, at: bot.entity.position.floored() };
}

/**
 * 掉落物探针：挖一个临时方块，确认"挖了真的会掉东西、而且能进背包"。
 *
 * 为什么需要（BUG-003）：主服上出现过"挖成功、服务端方块也变了，
 * 但客户端和服务端都没有 item 实体、背包不涨"——整轮 0/8 白跑。
 * 有了这条，能立刻区分"环境没加载/不掉落"和"我们的代码有问题"。
 *
 * 做法：在旁边放一个 oak_log → 挖 → 看背包 +1 了没 → 把位置恢复。
 */
async function probeDrops(b, name) {
    try {
        const p = b.entity.position.floored();
        const spot = { x: p.x + 2, y: p.y, z: p.z };
        const before = countItem(b, 'oak_log');
        await RC(`setblock ${spot.x} ${spot.y} ${spot.z} oak_log`);
        await sleep(600);
        const r = await digBlock(b, { kind: 'block', pos: spot });
        if (!r.ok) {
            console.log(`        探针：挖不动（${r.code}），该位置可能未加载`);
            return false;
        }
        await sleep(1200);
        const gained = countItem(b, 'oak_log') - before;
        if (gained <= 0) {
            console.log(`        探针：挖成功但没有掉落物（BUG-003 现象）`);
            return false;
        }
        // 清掉探针拿到的那 1 个，避免污染本轮计数
        await RC(`clear ${name} oak_log`);
        await sleep(300);
        return true;
    } catch (e) {
        console.log(`        探针异常：${e.message}`);
        return false;
    }
}

bot = null;   // 延迟创建

// ---- 主流程 ----
(async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    console.log(`S2 主服基线：${RUNS} 轮 × ${WANT} 个橡木，输出 ${OUT_FILE}`);

    const rows = [];
    let pass = 0, sumMs = 0, sumGained = 0;
    const codeHist = {};
    let reconnects = 0;
    const kickedRuns = [];

    for (let i = 1; i <= RUNS; i++) {
        // 1) 确保在线（被踢则换新账号重连）
        if (!bot || kicked) {
            if (kicked) {
                reconnects++;
                console.log(`  第${i}轮 前一次被踢（${kicked}），重连...`);
                try { bot?.quit(); } catch { }
                await sleep(1500);
            }
            makeBot();
            try {
                await waitReady(bot);
            } catch (e) {
                console.log(`  第${i}轮 连不上：${e.message}，跳过`);
                rows.push({ run: i, skipped: true, reason: e.message });
                continue;
            }
            await sleep(1500);
            await RC(`op ${botName}`);
            await RC(`gamemode survival ${botName}`);
            if (i === 1) {
                console.log(`  等服务器负载稳定 ${Math.round(SETTLE_MS / 1000)}s...`);
                await sleep(SETTLE_MS);
            }
        }

        // 2) 定位到森林。
        //    原来用「走过去」（180 格，经常超时）；升级 mineflayer 4.39 后 tp 不再破坏物理
        //    （见 bugs/BUG-001），所以改用 tp 更可靠、更省时间。
        //
        //    两个必须做的准备（都来自实测，见 bugs/）：
        //      a) forceload：tp 到从未加载过的区块时，"That position is not loaded"，
        //         挖方块不产生掉落物（BUG-003）。先强制加载目标区域。
        //      b) 物理健康检查：4.33 时代 tp 会让坐标变 NaN 且走不动（BUG-001，4.39 已修）。
        if (i === 1 || rows.length < i) {
            // a) 强制加载森林周边区块（半径 ~80 格 ≈ 5 区块）
            const cx = Math.floor(FOREST[0] / 16), cz = Math.floor(FOREST[1] / 16);
            try {
                await RC(`forceload add ${cx - 5} ${cz - 5} ${cx + 5} ${cz + 5}`);
                await sleep(800);
            } catch (e) {
                console.log(`  第${i}轮 forceload 失败（不影响流程）：${e.message}`);
            }

            let placed = false;
            for (let attempt = 0; attempt < 3 && !placed; attempt++) {
                await RC(`tp ${botName} ${FOREST[0]} 72 ${FOREST[1]}`);
                await sleep(2200);
                const ph = inspectPhysics(bot);
                const okPos = ph.healthy && Number.isFinite(ph.pos?.y);
                // 再试着走一小步，确认物理真的活着（原地不动 = 物理死了）
                let moved = 0;
                if (okPos) {
                    const a = bot.entity.position.clone();
                    bot.setControlState('forward', true);
                    await sleep(700);
                    bot.setControlState('forward', false);
                    await sleep(250);
                    moved = Math.hypot(bot.entity.position.x - a.x, bot.entity.position.z - a.z);
                }
                // 阈值 0.1：只要动了一点就说明物理活着。
                // 原来 0.3 太严：实测第 4 轮走了 0.27 格被判"物理未就绪"，
                // 但那一轮实际 PASS 8/8 —— 是误判。
                placed = okPos && moved > 0.1;
                if (!placed) console.log(`  第${i}轮 定位后物理未就绪（pos ok=${okPos} 走了${moved.toFixed(2)}格），重试`);
            }
            if (!placed) console.log(`  第${i}轮 警告：定位后物理仍异常，继续按现状跑`);

            // b) 掉落物探针：确认这个位置"挖了会掉东西"。
            //    主服上曾出现"挖成功但背包不涨、服务端也没有 item 实体"（BUG-003）。
            //    这条能把"环境问题"和"代码问题"分开，避免白跑一整轮。
            if (process.env.BENCH_PROBE !== '0') {
                const dropOk = await probeDrops(bot, botName);
                if (!dropOk) console.log(`  第${i}轮 警告：掉落物探针失败（挖了不掉东西），本轮数据可能不可信`);
            }
            await sleep(500);
        }

        // 3) 清背包 + 发工具
        await RC(`clear ${botName}`);
        await RC(`give ${botName} iron_axe 1`);
        await RC(`give ${botName} dirt 64`);
        await sleep(700);

        const ctx = snapshotContext();
        const before = countItem(bot, 'oak_log');
        kicked = null;

        // 4) 采集
        const t0 = Date.now();
        let r;
        const events = {};
        try {
            r = await collect(bot, 'oak_log', WANT, {
                deadlineMs: DEADLINE_MS,
                onEvent: (e) => { events[e.type] = (events[e.type] || 0) + 1; },
            });
        } catch (e) {
            r = { ok: false, code: 'THROWN', message: e.message, data: {} };
        }
        const ms = Date.now() - t0;
        const wasKicked = kicked;

        let gained = 0;
        try { gained = countItem(bot, 'oak_log') - before; } catch { gained = -1; }
        const honest = r.ok && r.data?.count === gained;
        const okRun = honest && gained >= WANT && !wasKicked;

        if (okRun) pass++;
        if (wasKicked) kickedRuns.push(i);
        sumMs += ms; sumGained += Math.max(gained, 0);
        codeHist[r.code] = (codeHist[r.code] || 0) + 1;

        const row = {
            run: i, at: ctx.at, logsNear: ctx.logsNear,
            ok: okRun, code: r.code, kicked: wasKicked || null,
            reported: r.data?.count ?? null, gained, honest,
            costMs: ms, events, message: r.message || '',
        };
        rows.push(row);
        appendFileSync(OUT_FILE, JSON.stringify(row) + '\n');

        console.log(`  ${String(i).padStart(2)}. ${okRun ? 'PASS' : 'FAIL'}`
            + ` 拿到=${gained}/${WANT} 报数=${row.reported}`
            + ` ${(ms / 1000).toFixed(0)}s 码=${r.code}`
            + (wasKicked ? ` 被踢=${wasKicked}` : '')
            + ` 附近树=${ctx.logsNear}`);

        // 5) 换一片树：附近砍得差不多就走 30 格换方向
        if (i < RUNS && !kicked) {
            const after = snapshotContext().logsNear;
            if (after < WANT * 3) {
                const dirs = [[30, 0], [0, 30], [-30, 0], [0, -30]];
                const [dx, dz] = dirs[(i - 1) % dirs.length];
                const p = bot.entity.position;
                await walkTo(p.x + dx, p.y, p.z + dz, `jog${i}`);
            }
        }
    }

    // ---- 汇总 ----
    const n = rows.filter(r => !r.skipped).length;
    const rate = n ? pass / n : 0;
    console.log('\n================ S2 主服基线 ================');
    console.log(`  完成轮数 ${n}（${RUNS} 轮制）  通过 ${pass}/${n}（${(rate * 100).toFixed(0)}%）`);
    console.log(`  平均 ${(sumMs / Math.max(n, 1) / 1000).toFixed(0)}s/轮，平均拿到 ${(sumGained / Math.max(n, 1)).toFixed(1)}/${WANT}`);
    console.log(`  判据：报数=背包增量 且 拿到≥${WANT} 且 未被踢`);
    console.log(`  失败码：${Object.entries(codeHist).map(([k, v]) => `${k}×${v}`).join('  ') || '无'}`);
    if (kickedRuns.length) console.log(`  被踢轮次：${kickedRuns.join(', ')}（共 ${kickedRuns.length} 次，重连 ${reconnects} 次）`);
    const depleted = rows.filter(r => r.logsNear != null && r.logsNear < WANT * 3).length;
    if (depleted) console.log(`  注意：${depleted} 轮开始时附近树 <${WANT * 3}，属地形耗尽`);
    console.log(`  JSONL：${OUT_FILE}`);
    console.log(`  结论：${rate >= 0.8 ? '达到 80% 及格线' : `未达 80%（当前 ${(rate * 100).toFixed(0)}%）`}`);
    console.log('==============================================');

    try { await RC(`clear ${botName}`); } catch { }
    try { bot.quit(); } catch { }
    process.exit(rate >= 0.8 ? 0 : 1);
})();
