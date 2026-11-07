// A1 · 单件真实熔炼耗时（验证 BOT-003 的"每件 200 tick = 10s"是否在真机成立）
//
// 真机：Paper 1.21.8 + 真 furnace（服务端方块实体），bot 真开窗真放料。
// 调用的是项目真实函数 flow_smelt.smelt()（不是复刻逻辑）。
import {
    T2, Rcon, connectBot, setupPlatform, setFurnace, give, clearInv,
    furnaceState, invCount, writeResult, log, sleep, nowIso,
} from './lib-probe.mjs';
import { smelt } from 'file:///E:/我的世界ai/mindcraft/src/agent/library/flow_smelt.js';

const USER = 'probe2';
const CX = 200, CY = 70, CZ = 200;          // 测试平台中心
const FX = CX + 2, FY = CY + 1, FZ = CZ;    // 熔炉位置（bot 站台面上 2 格处）

const rcon = new Rcon();
let bot;
const evidence = { probe: 'A1-single-item', startedAt: nowIso(), steps: [] };

try {
    await rcon.connect();
    bot = await connectBot(USER);
    log('bot spawned at', bot.entity.position);

    const geo = await setupPlatform(rcon, USER, CX, CY, CZ);
    await setFurnace(rcon, FX, FY, FZ);
    await clearInv(rcon, USER);
    await give(rcon, USER, 'raw_iron', 1);
    await give(rcon, USER, 'coal', 1);
    await sleep(900);                       // 让 /give 的窗口包落地

    evidence.geometry = { ...geo, furnace: { x: FX, y: FY, z: FZ } };
    evidence.invBefore = { raw_iron: invCount(bot, 'raw_iron'), coal: invCount(bot, 'coal'), iron_ingot: invCount(bot, 'iron_ingot') };
    evidence.furnaceBefore = await furnaceState(rcon, FX, FY, FZ);
    log('inv before', JSON.stringify(evidence.invBefore));

    // 同时在跑的时候抓一次炉内状态（验证"1 件原料 + 1 份燃料"真的进了炉）
    const t0 = Date.now();
    const p = smelt(bot, 'raw_iron', 1, {});
    await sleep(700);
    evidence.furnaceAfterLoad = await furnaceState(rcon, FX, FY, FZ);
    log('furnace after load', JSON.stringify(evidence.furnaceAfterLoad.all));

    const res = await p;
    const wallMs = Date.now() - t0;

    evidence.result = res;
    evidence.wallMs = wallMs;
    evidence.wallSeconds = +(wallMs / 1000).toFixed(3);
    evidence.invAfter = { raw_iron: invCount(bot, 'raw_iron'), coal: invCount(bot, 'coal'), iron_ingot: invCount(bot, 'iron_ingot') };
    evidence.furnaceAfter = await furnaceState(rcon, FX, FY, FZ);
    evidence.tps = await rcon.cmd('tps');
    evidence.expected = {
        singleItemSeconds: 10,
        note: '1 件 = 200 tick = 10s；燃料 1 煤 = 80s，够烧 8 件',
    };
    evidence.verdict = {
        ok: res.ok === true,
        gotEquals1: res.data?.got === 1,
        ingotDelta: evidence.invAfter.iron_ingot - evidence.invBefore.iron_ingot,
        gotMatchesRealDelta: res.data?.got === (evidence.invAfter.iron_ingot - evidence.invBefore.iron_ingot),
        wallNear10s: Math.abs(wallMs / 1000 - 10) < 3,
    };
    writeResult('result-A1-single-item.json', evidence);
    log('RESULT', JSON.stringify(evidence.verdict), 'wall=', evidence.wallSeconds, 's');
    console.log(JSON.stringify(evidence, null, 2));
} catch (e) {
    evidence.error = String(e?.stack ?? e);
    writeResult('result-A1-single-item.json', evidence);
    console.error('PROBE FAILED:', evidence.error);
    process.exitCode = 1;
} finally {
    try { bot?.quit('done'); } catch { }
    rcon.close();
    await sleep(300);
    process.exit(process.exitCode ?? 0);
}
