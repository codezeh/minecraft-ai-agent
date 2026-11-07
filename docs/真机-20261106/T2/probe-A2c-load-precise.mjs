// A2c · 精确定量：furnaceLoad(count=16) 到底往燃料槽里放了几份煤？
//
// 背景矛盾：A2 全流程最终背包 coal=6（= 只走了 2 份）；A2b 装料后立刻读到 coal=0（= 走了 8 份）。
// 必须查清，否则"一次投够 2 份"这个结论不成立。
//
// 手段（避开 vanilla `/data get` 的 111 字截断，逐条路径查 NBT）：
//   data get block X Y Z Items[0].id / Items[0].count / Items[1].id / Items[1].count
// 再配合 bot 侧背包在 +0/+300ms/+1s/+2s 的读数。
import { Rcon, connectBot, setupPlatform, setFurnace, give, clearInv, invCount, writeResult, log, sleep, nowIso } from './lib-probe.mjs';
import { furnaceLoad, fuelNeededFor } from 'file:///E:/我的世界ai/mindcraft/src/agent/library/act_craft.js';
import { blockAt } from 'file:///E:/我的世界ai/mindcraft/src/agent/library/query_perceive.js';

const USER = 'probe2';
const CX = 200, CY = 70, CZ = 200;
const FX = CX + 2, FY = CY + 1, FZ = CZ;

const rcon = new Rcon();
let bot;
const ev = { probe: 'A2c-load-precise', startedAt: nowIso(), slots: [] };

async function nbtSlots() {
    const out = [];
    for (const idx of [0, 1, 2]) {
        const id = await rcon.cmd(`data get block ${FX} ${FY} ${FZ} Items[${idx}].id`);
        const cnt = await rcon.cmd(`data get block ${FX} ${FY} ${FZ} Items[${idx}].count`);
        const mId = /minecraft:[a-z0-9_]+/.exec(id);
        const mCnt = /has the following block data:\s*(\d+)/.exec(cnt);
        out.push({ idx, rawId: id, rawCount: cnt, id: mId ? mId[0] : null, count: mCnt ? Number(mCnt[1]) : null });
    }
    return out;
}

try {
    await rcon.connect();
    bot = await connectBot(USER);
    await setupPlatform(rcon, USER, CX, CY, CZ);
    await setFurnace(rcon, FX, FY, FZ);
    await clearInv(rcon, USER);
    await give(rcon, USER, 'raw_iron', 16);
    await give(rcon, USER, 'coal', 8);
    await sleep(1000);

    ev.before = { inv: { raw_iron: invCount(bot, 'raw_iron'), coal: invCount(bot, 'coal') }, nbt: await nbtSlots() };
    ev.fuelNeededFor16 = fuelNeededFor('coal', 16);

    const furnace = blockAt(bot, { x: FX, y: FY, z: FZ });
    const loaded = await furnaceLoad(bot, furnace, 'raw_iron', 'coal', { count: 16 });
    ev.furnaceLoadReturn = loaded;

    ev.after0ms = { inv: { raw_iron: invCount(bot, 'raw_iron'), coal: invCount(bot, 'coal') }, nbt: await nbtSlots() };
    await sleep(300);
    ev.after300ms = { inv: { raw_iron: invCount(bot, 'raw_iron'), coal: invCount(bot, 'coal') }, nbt: await nbtSlots() };
    await sleep(700);
    ev.after1000ms = { inv: { raw_iron: invCount(bot, 'raw_iron'), coal: invCount(bot, 'coal') }, nbt: await nbtSlots() };
    await sleep(1000);
    ev.after2000ms = { inv: { raw_iron: invCount(bot, 'raw_iron'), coal: invCount(bot, 'coal') }, nbt: await nbtSlots() };

    ev.verdict = {
        productSaidFuelCount2: loaded.data?.fuelCount === 2,
        productSaidInputCount16: loaded.data?.inputCount === 16,
        coalGoneFromInv: 8 - ev.after2000ms.inv.coal,
        furnaceFuelSlotCountAt2s: (ev.after2000ms.nbt.find((s) => s.idx === 1) ?? {}).count,
        furnaceInputSlotCountAt2s: (ev.after2000ms.nbt.find((s) => s.idx === 0) ?? {}).count,
        note: 'vanilla /data get 会把长结果截断成 "..."（111 字符），所以这里逐条查 Items[i].id / Items[i].count',
    };
    writeResult('result-A2c-load-precise.json', ev);
    log('RESULT', JSON.stringify(ev.verdict));
    console.log(JSON.stringify(ev, null, 2));
} catch (e) {
    ev.error = String(e?.stack ?? e); writeResult('result-A2c-load-precise.json', ev); console.error(ev.error); process.exitCode = 1;
} finally { try { bot?.quit('d'); } catch { } rcon.close(); await sleep(200); process.exit(process.exitCode ?? 0); }
