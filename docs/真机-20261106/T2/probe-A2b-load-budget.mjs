// A2b · "want=16 时炉里到底进了几个煤 / 几件料" —— 直接调产品的 furnaceLoad
//
// 为什么单独一个探针：
//   A2 已经跑完 want=16 全流程（got=16、背包 coal 8→6、wall 186.3s），但它的装料快照
//   是空的 —— 事后定位到是**探针侧 RCON 客户端**把多包响应截断了（长 NBT 结果被腰斩），
//   不是服务端把燃料槽清了。修好客户端后，这里用 A2 同样的装料参数直接量一次：
//     furnaceLoad(bot, furnace, 'raw_iron', 'coal', { count: 16 })
//   期望：data.inputCount = 16、data.fuelCount = 2（fuelNeededFor('coal',16)=2），
//        且服务端 NBT 里燃料槽真的出现 coal。
import {
    Rcon, connectBot, setupPlatform, setFurnace, give, clearInv,
    furnaceState, invCount, writeResult, log, sleep, nowIso,
} from './lib-probe.mjs';
import { furnaceLoad, fuelNeededFor } from 'file:///E:/我的世界ai/mindcraft/src/agent/library/act_craft.js';
import { blockAt } from 'file:///E:/我的世界ai/mindcraft/src/agent/library/query_perceive.js';

const USER = 'probe2';
const CX = 200, CY = 70, CZ = 200;
const FX = CX + 2, FY = CY + 1, FZ = CZ;

const rcon = new Rcon();
let bot;
const ev = { probe: 'A2b-load-budget', startedAt: nowIso() };

try {
    await rcon.connect();
    bot = await connectBot(USER);
    await setupPlatform(rcon, USER, CX, CY, CZ);
    await setFurnace(rcon, FX, FY, FZ);
    await clearInv(rcon, USER);
    await give(rcon, USER, 'raw_iron', 16);
    await give(rcon, USER, 'coal', 8);
    await sleep(900);

    ev.invBefore = { raw_iron: invCount(bot, 'raw_iron'), coal: invCount(bot, 'coal') };
    ev.fuelNeededFor16 = fuelNeededFor('coal', 16);

    const furnace = blockAt(bot, { x: FX, y: FY, z: FZ });
    ev.furnaceBlock = { name: furnace?.name ?? null, pos: furnace?.position ?? null };

    const t0 = Date.now();
    const loaded = await furnaceLoad(bot, furnace, 'raw_iron', 'coal', { count: 16 });
    ev.furnaceLoadReturn = loaded;             // 产品自报：inputCount / fuelCount
    ev.loadCostMs = Date.now() - t0;

    // 立刻读服务端 NBT（已修好多包拼接）
    ev.nbtRightAfterLoad = await furnaceState(rcon, FX, FY, FZ);
    await sleep(400);
    ev.nbtPlus400ms = await furnaceState(rcon, FX, FY, FZ);
    await sleep(1500);
    ev.nbtPlus1900ms = await furnaceState(rcon, FX, FY, FZ);

    ev.invAfterLoad = { raw_iron: invCount(bot, 'raw_iron'), coal: invCount(bot, 'coal') };
    ev.invDelta = {
        raw_ironTaken: ev.invBefore.raw_iron - ev.invAfterLoad.raw_iron,
        coalTaken: ev.invBefore.coal - ev.invAfterLoad.coal,
    };

    const fuelSeen = [ev.nbtRightAfterLoad, ev.nbtPlus400ms, ev.nbtPlus1900ms]
        .map((s) => s.fuel?.count ?? null);
    ev.verdict = {
        loadOk: loaded.ok === true,
        productReportedFuelCount: loaded.data?.fuelCount ?? null,
        productReportedInputCount: loaded.data?.inputCount ?? null,
        fuelCountIs2: loaded.data?.fuelCount === 2,
        inputCountIs16: loaded.data?.inputCount === 16,
        inventoryCoalTaken2: ev.invDelta.coalTaken === 2,
        nbtFuelCountsSeen: fuelSeen,
        nbtShowsCoalInFuelSlot: fuelSeen.some((c) => c !== null),
        note: '服务端在开始燃烧时会立刻消耗第一份燃料，所以 NBT 可能读到 2（未及消耗）或 1（已消耗 1 份）；两者都证明"2 份投进过燃料槽"',
    };
    writeResult('result-A2b-load-budget.json', ev);
    log('RESULT', JSON.stringify(ev.verdict));
    console.log(JSON.stringify(ev, null, 2));
} catch (e) {
    ev.error = String(e?.stack ?? e); writeResult('result-A2b-load-budget.json', ev); console.error(ev.error); process.exitCode = 1;
} finally { try { bot?.quit('d'); } catch { } rcon.close(); await sleep(200); process.exit(process.exitCode ?? 0); }
