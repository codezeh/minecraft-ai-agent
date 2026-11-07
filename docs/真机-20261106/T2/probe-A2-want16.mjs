// A2 · want=16 + 煤充足 ⇒ 燃料预算一次投够 2 份、最终 got=16（BOT-003 的主线标尺）
//
// 期望（Lead 给的标尺）：
//   fuelNeededFor('coal',16) = ceil(16/8) = 2
//   ⇒ 炉内燃料槽应进 **2 个煤**（不是 1 个），原料槽 16 件
//   ⇒ 最终 got = 16（老行为只有 8）
//   ⇒ 总 wall-clock ≈ 16 × 10s = 160s（+ 轮询粒度）
// 同时每 30s 抓一次 /tps 说明测量期间的服务器负载。
import {
    Rcon, connectBot, setupPlatform, setFurnace, give, clearInv,
    furnaceState, invCount, writeResult, log, sleep, nowIso,
} from './lib-probe.mjs';
import { smelt } from 'file:///E:/我的世界ai/mindcraft/src/agent/library/flow_smelt.js';
import { fuelNeededFor, fuelBurnOf } from 'file:///E:/我的世界ai/mindcraft/src/agent/library/act_craft.js';

const USER = 'probe2';
const CX = 200, CY = 70, CZ = 200;
const FX = CX + 2, FY = CY + 1, FZ = CZ;
const WANT = 16;

const rcon = new Rcon();
let bot;
const evidence = { probe: 'A2-want16-fuel-budget', startedAt: nowIso(), want: WANT };

try {
    await rcon.connect();
    bot = await connectBot(USER);
    await setupPlatform(rcon, USER, CX, CY, CZ);
    await setFurnace(rcon, FX, FY, FZ);
    await clearInv(rcon, USER);
    await give(rcon, USER, 'raw_iron', WANT);
    await give(rcon, USER, 'coal', 8);      // 充足：预算只需 2，投 2，剩 6
    await sleep(900);

    evidence.fuelMath = { fuelBurnOfCoal: fuelBurnOf('coal'), fuelNeededFor16: fuelNeededFor('coal', WANT) };
    evidence.invBefore = { raw_iron: invCount(bot, 'raw_iron'), coal: invCount(bot, 'coal'), iron_ingot: invCount(bot, 'iron_ingot') };
    evidence.furnaceBefore = await furnaceState(rcon, FX, FY, FZ);
    log('inv before', JSON.stringify(evidence.invBefore));

    const t0 = Date.now();
    const p = smelt(bot, 'raw_iron', WANT, {});

    // ① 装料快照：轮询到燃料槽出现为止（最多 6s）
    let loadSnap = null;
    for (let i = 0; i < 24; i++) {
        await sleep(250);
        const st = await furnaceState(rcon, FX, FY, FZ);
        if (st.fuel && st.input) { loadSnap = st; break; }
    }
    evidence.loadSnapshot = loadSnap;
    log('load snapshot:', JSON.stringify(loadSnap?.all ?? null));

    // ② 期间采样 TPS（每 30s 一次，直到 smelt 结束）
    evidence.tpsDuring = [];
    let finished = false;
    p.finally(() => { finished = true; });
    while (!finished) {
        await sleep(30000);
        if (finished) break;
        try {
            const tps = await rcon.cmd('tps');
            const mid = await furnaceState(rcon, FX, FY, FZ);
            evidence.tpsDuring.push({ at: nowIso(), elapsedMs: Date.now() - t0, tps, furnace: mid.all });
            log('tps during:', tps, 'elapsed=', ((Date.now() - t0) / 1000).toFixed(0) + 's');
        } catch (e) { evidence.tpsDuring.push({ at: nowIso(), error: String(e?.message ?? e) }); }
    }

    const res = await p;
    const wallMs = Date.now() - t0;

    evidence.result = res;
    evidence.wallMs = wallMs;
    evidence.wallSeconds = +(wallMs / 1000).toFixed(3);
    evidence.expectedWallSeconds = WANT * 10;
    evidence.invAfter = { raw_iron: invCount(bot, 'raw_iron'), coal: invCount(bot, 'coal'), iron_ingot: invCount(bot, 'iron_ingot') };
    evidence.furnaceAfter = await furnaceState(rcon, FX, FY, FZ);
    evidence.tpsAfter = await rcon.cmd('tps');

    const ingotDelta = evidence.invAfter.iron_ingot - evidence.invBefore.iron_ingot;
    evidence.verdict = {
        got16: res.data?.got === WANT,
        okTrue: res.ok === true,
        fuelNeededIs2: fuelNeededFor('coal', WANT) === 2,
        fuelPutInFurnaceIs2: (loadSnap?.fuel?.count ?? -1) === 2,
        inputPutInFurnaceIs16: (loadSnap?.input?.count ?? -1) === WANT,
        coalLeftInInv6: evidence.invAfter.coal === 6,
        ingotDelta16: ingotDelta === WANT,
        gotMatchesRealDelta: res.data?.got === ingotDelta,
        wallNear160s: Math.abs(wallMs / 1000 - WANT * 10) <= 25,
        wallSeconds: +(wallMs / 1000).toFixed(3),
        notTheOld8: res.data?.got !== 8,
    };
    writeResult('result-A2-want16.json', evidence);
    log('RESULT', JSON.stringify(evidence.verdict));
    console.log(JSON.stringify(evidence, null, 2));
} catch (e) {
    evidence.error = String(e?.stack ?? e);
    writeResult('result-A2-want16.json', evidence);
    console.error('PROBE FAILED:', evidence.error);
    process.exitCode = 1;
} finally {
    try { bot?.quit('done'); } catch { }
    rcon.close();
    await sleep(300);
    process.exit(process.exitCode ?? 0);
}
