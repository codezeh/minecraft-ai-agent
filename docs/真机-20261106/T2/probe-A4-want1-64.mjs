// A4 · want=1 但背包 64 件：炉内只该进 1 件（不能把 64 件全塞）
//
// 期望：furnaceLoad 的 putCount = min(64, want=1, 64) = 1
//   ⇒ 炉子输入槽 1 件、背包剩 63 件、产物 1 件
import {
    Rcon, connectBot, setupPlatform, setFurnace, give, clearInv,
    furnaceState, invCount, writeResult, log, sleep, nowIso,
} from './lib-probe.mjs';
import { smelt } from 'file:///E:/我的世界ai/mindcraft/src/agent/library/flow_smelt.js';

const USER = 'probe2';
const CX = 200, CY = 70, CZ = 200;
const FX = CX + 2, FY = CY + 1, FZ = CZ;

const rcon = new Rcon();
let bot;
const evidence = { probe: 'A4-want1-with-64', startedAt: nowIso() };

try {
    await rcon.connect();
    bot = await connectBot(USER);
    await setupPlatform(rcon, USER, CX, CY, CZ);
    await setFurnace(rcon, FX, FY, FZ);
    await clearInv(rcon, USER);
    await give(rcon, USER, 'raw_iron', 64);
    await give(rcon, USER, 'coal', 8);
    await sleep(900);

    evidence.invBefore = { raw_iron: invCount(bot, 'raw_iron'), coal: invCount(bot, 'coal') };
    evidence.furnaceBefore = await furnaceState(rcon, FX, FY, FZ);

    const t0 = Date.now();
    const p = smelt(bot, 'raw_iron', 1, {});
    // 装料后抓炉内状态（轮询到燃料槽出现为止，最多 4s）
    let loadSnap = null;
    for (let i = 0; i < 16; i++) {
        await sleep(250);
        const st = await furnaceState(rcon, FX, FY, FZ);
        if (st.input || st.fuel) { loadSnap = st; break; }
    }
    const res = await p;
    const wallMs = Date.now() - t0;

    evidence.loadSnapshot = loadSnap;
    evidence.result = res;
    evidence.wallSeconds = +(wallMs / 1000).toFixed(3);
    evidence.invAfter = { raw_iron: invCount(bot, 'raw_iron'), coal: invCount(bot, 'coal'), iron_ingot: invCount(bot, 'iron_ingot') };
    evidence.furnaceAfter = await furnaceState(rcon, FX, FY, FZ);

    evidence.expected = {
        furnaceInputCountAtLoad: 1,
        rawIronLeftAfter: 63,
        got: 1,
        note: '老行为是 Math.min(have,64) → 会把 64 件全塞进炉子',
    };
    evidence.verdict = {
        loadedOnly1: (loadSnap?.input?.count ?? -1) === 1,
        inputNotMoreThan2: (loadSnap?.input?.count ?? 99) <= 2,
        rawLeft63: evidence.invAfter.raw_iron === 63,
        got1: res.data?.got === 1,
        okOrAtLeastReported1: res.ok === true,
    };
    writeResult('result-A4-want1-64.json', evidence);
    log('RESULT', JSON.stringify(evidence.verdict), 'load=', JSON.stringify(loadSnap?.all ?? null));
    console.log(JSON.stringify(evidence, null, 2));
} catch (e) {
    evidence.error = String(e?.stack ?? e);
    writeResult('result-A4-want1-64.json', evidence);
    console.error('PROBE FAILED:', evidence.error);
    process.exitCode = 1;
} finally {
    try { bot?.quit('done'); } catch { }
    rcon.close();
    await sleep(300);
    process.exit(process.exitCode ?? 0);
}
