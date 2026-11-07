// A3 · 燃料不足必须"立刻"失败（BOT-003 的核心修复点）
//
// 场景：背包 16 raw_iron + **只有 1 煤**，请求 smelt(..., 16)。
//   燃料预算 fuelNeededFor('coal', 16) = ceil(16/8) = 2 > 1
//   ⇒ 期望：立刻 NO_ITEM + data.missing.fuel = 1，且**一份原料都没进炉**
//   ⇒ 绝不能：把 16 份料塞进炉、烧 8 个、然后空转到 600s deadline 才报 8/16
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
const evidence = { probe: 'A3-fuel-short-early-fail', startedAt: nowIso() };

try {
    await rcon.connect();
    bot = await connectBot(USER);
    await setupPlatform(rcon, USER, CX, CY, CZ);
    await setFurnace(rcon, FX, FY, FZ);
    await clearInv(rcon, USER);
    await give(rcon, USER, 'raw_iron', 16);
    await give(rcon, USER, 'coal', 1);
    await sleep(900);

    evidence.invBefore = { raw_iron: invCount(bot, 'raw_iron'), coal: invCount(bot, 'coal') };
    evidence.furnaceBefore = await furnaceState(rcon, FX, FY, FZ);
    log('inv before', JSON.stringify(evidence.invBefore));

    const t0 = Date.now();
    const res = await smelt(bot, 'raw_iron', 16, {});
    const wallMs = Date.now() - t0;

    evidence.result = res;
    evidence.wallMs = wallMs;
    evidence.wallSeconds = +(wallMs / 1000).toFixed(4);
    evidence.furnaceAfter = await furnaceState(rcon, FX, FY, FZ);
    evidence.invAfter = { raw_iron: invCount(bot, 'raw_iron'), coal: invCount(bot, 'coal'), iron_ingot: invCount(bot, 'iron_ingot') };

    evidence.expected = {
        code: 'NO_ITEM',
        missing: { fuel: 1 },
        fuelNeeded: 2,
        furnaceInputCount: 0,
        wallBudgetMs: '< 2000（"立刻"），绝不允许接近 600000',
    };
    evidence.verdict = {
        returnedNotOk: res.ok === false,
        codeIsNoItem: res.code === 'NO_ITEM',
        missingFuelIs1: res.data?.missing?.fuel === 1,
        furnaceInputEmpty: evidence.furnaceAfter.all.length === 0,
        noMaterialEntered: (evidence.furnaceAfter.all.find(i => i.slot === 0) ?? null) === null,
        fast: wallMs < 2000,
        farFrom600s: wallMs < 600000 / 10,
    };
    writeResult('result-A3-fuel-short.json', evidence);
    log('RESULT', JSON.stringify(evidence.verdict));
    console.log(JSON.stringify(evidence, null, 2));
} catch (e) {
    evidence.error = String(e?.stack ?? e);
    writeResult('result-A3-fuel-short.json', evidence);
    console.error('PROBE FAILED:', evidence.error);
    process.exitCode = 1;
} finally {
    try { bot?.quit('done'); } catch { }
    rcon.close();
    await sleep(300);
    process.exit(process.exitCode ?? 0);
}
