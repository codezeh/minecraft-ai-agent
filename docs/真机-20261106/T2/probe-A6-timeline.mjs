// A6 · 把 A2 的 186.3s 拆开：放料 / 燃烧 / 轮询 / 收尾各占多少
//
// 手段（只包 bot 的 mineflayer API，不动产品代码）：
//   · 包住 bot.openFurnace → 记录每一次开窗的起止时刻与耗时（flow_smelt 的 furnaceLoad
//     和每轮 furnaceCollect 都走它 ⇒ 这就是"轮询时刻表"的真身）
//   · 每 200ms 采一次炉内 input/output 与背包 ingot 计数 → 燃烧曲线的真身
//   · 记 smelt() 返回时刻 → 收尾段 = 返回时刻 − 最后一件产出时刻
import {
    Rcon, connectBot, setupPlatform, setFurnace, give, clearInv, writeResult, log, sleep, nowIso,
} from './lib-probe.mjs';
import { smelt } from 'file:///E:/我的世界ai/mindcraft/src/agent/library/flow_smelt.js';

const USER = 'probe2';
const CX = 200, CY = 70, CZ = 200;
const FX = CX + 2, FY = CY + 1, FZ = CZ;
const WANT = 16;

const rcon = new Rcon();
let bot;
const ev = { probe: 'A6-timeline-decomposition', startedAt: nowIso(), want: WANT, samples: [], windowOps: [] };

async function slotCount(idx) {
    const id = await rcon.cmd(`data get block ${FX} ${FY} ${FZ} Items[${idx}].id`);
    const cnt = await rcon.cmd(`data get block ${FX} ${FY} ${FZ} Items[${idx}].count`);
    const mi = /minecraft:[a-z0-9_]+/.exec(id);
    const mc = /block data:\s*(\d+)/.exec(cnt);
    return mi ? { id: mi[0].replace('minecraft:', ''), count: mc ? Number(mc[1]) : null } : null;
}

try {
    await rcon.connect();
    bot = await connectBot(USER);
    await setupPlatform(rcon, USER, CX, CY, CZ);
    // ★ 必须 air → furnace：/setblock furnace replace 盖在旧熔炉上会**保留方块实体库存**，
    //   上一次探针留下一炉料会让本次的"装料/燃烧"曲线整体失真（实测 A6 首跑读到 input=32）。
    await rcon.cmd(`setblock ${FX} ${FY} ${FZ} minecraft:air replace`);
    await sleep(150);
    await setFurnace(rcon, FX, FY, FZ);
    await clearInv(rcon, USER);
    await give(rcon, USER, 'raw_iron', WANT);
    await give(rcon, USER, 'coal', 8);
    await sleep(1000);

    // ── 包 openFurnace：记录每次开窗（放料 1 次 + 每轮收产物 1 次）──
    const origOpen = bot.openFurnace.bind(bot);
    let t0 = Date.now();
    bot.openFurnace = async (block) => {
        const s = Date.now();
        const w = await origOpen(block);
        ev.windowOps.push({ startMs: s - t0, endMs: Date.now() - t0, durMs: Date.now() - s });
        return w;
    };

    t0 = Date.now();
    const p = smelt(bot, 'raw_iron', WANT, {});

    // ── 每 200ms 采样燃烧曲线，直到 smelt 返回 ──
    let done = false;
    p.finally(() => { done = true; });
    while (!done && Date.now() - t0 < 240000) {
        await sleep(200);
        if (done) break;
        const inp = await slotCount(0);
        const out = await slotCount(2);
        let ingot = 0;
        for (const it of bot.inventory.items()) if (it.name === 'iron_ingot') ingot += it.count;
        const totalProduced = (out ? out.count : 0) + ingot;
        ev.samples.push({
            tMs: Date.now() - t0,
            input: inp ? inp.count : 0,
            output: out ? out.count : 0,
            invIngot: ingot,
            totalProduced,
        });
        if (totalProduced >= WANT) ev.burnDoneAtMs = Date.now() - t0;   // 第一次凑够 WANT 的时刻
    }

    const res = await p;
    const returnMs = Date.now() - t0;
    bot.openFurnace = origOpen;

    ev.result = res;
    ev.returnMs = returnMs;

    // ── 拆解计算 ──
    const firstLoadEnd = ev.windowOps[0]?.endMs ?? null;
    const polls = ev.windowOps.slice(1);
    // 燃烧完成时刻：优先用采样里第一次凑够 WANT 的时刻
    const burnDoneAt = ev.burnDoneAtMs ?? ev.samples.find((s) => s.totalProduced >= WANT)?.tMs ?? null;
    ev.decomposition = {
        loadWindowEndMs: firstLoadEnd,
        burnDoneAtMs: burnDoneAt,
        returnMs,
        loadPhaseMs: firstLoadEnd,
        burnPhaseMs: burnDoneAt != null && firstLoadEnd != null ? burnDoneAt - firstLoadEnd : null,
        tailMs: burnDoneAt != null ? returnMs - burnDoneAt : null,
        collectPollCount: polls.length,
        collectOverheadTotalMs: polls.reduce((a, x) => a + x.durMs, 0),
        collectOverheadAvgMs: polls.length ? +(polls.reduce((a, x) => a + x.durMs, 0) / polls.length).toFixed(1) : null,
        pollStartsMs: polls.map((x) => x.startMs),
        pollIntervalsMs: polls.map((x, i) => (i === 0 ? x.startMs - (firstLoadEnd ?? 0) : x.startMs - polls[i - 1].startMs)),
        theoreticalBurnMs: WANT * 10000,
        wallMs: returnMs,
        firstSamples: ev.samples.slice(0, 6),
        lastSamples: ev.samples.slice(-4),
    };
    ev.verdict = {
        got16: res.data?.got === WANT,
        theoretical160s: WANT * 10,
        measuredWallSeconds: +(returnMs / 1000).toFixed(3),
        overheadSeconds: +((returnMs - WANT * 10000) / 1000).toFixed(3),
        split: {
            loadSeconds: firstLoadEnd != null ? +(firstLoadEnd / 1000).toFixed(3) : null,
            burnSeconds: ev.decomposition.burnPhaseMs != null ? +(ev.decomposition.burnPhaseMs / 1000).toFixed(3) : null,
            tailSeconds: ev.decomposition.tailMs != null ? +(ev.decomposition.tailMs / 1000).toFixed(3) : null,
        },
    };
    writeResult('result-A6-timeline.json', ev);
    log('RESULT', JSON.stringify(ev.verdict));
    log('windowOps', JSON.stringify(ev.windowOps));
    console.log(JSON.stringify(ev.verdict, null, 2));
} catch (e) {
    ev.error = String(e?.stack ?? e);
    writeResult('result-A6-timeline.json', ev);
    console.error('PROBE FAILED:', ev.error);
    process.exitCode = 1;
} finally {
    try { bot?.quit('done'); } catch { }
    rcon.close();
    await sleep(300);
    process.exit(process.exitCode ?? 0);
}
