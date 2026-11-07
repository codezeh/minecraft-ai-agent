// A2d · 用**服务端权威计数**判定：装料后那 6 份煤到底还在不在这个 bot 身上？
//
// 为什么需要它：A2c 里 mineflayer 侧背包读数在 +0ms 是 coal=6（=只拿走 2 份，符合预期），
// 但 +300ms 之后变成 0，而炉子燃料槽只有 1 份 —— 必须排除"多拿的煤被丢掉"这种真 bug。
// 判定手段不依赖 mineflayer 的窗口视图：`clear <player> <item> 0` 只**报告**数量不删除。
import { Rcon, connectBot, setupPlatform, setFurnace, give, clearInv, writeResult, log, sleep, nowIso } from './lib-probe.mjs';
import { furnaceLoad } from 'file:///E:/我的世界ai/mindcraft/src/agent/library/act_craft.js';
import { blockAt } from 'file:///E:/我的世界ai/mindcraft/src/agent/library/query_perceive.js';

const USER = 'probe2';
const CX = 200, CY = 70, CZ = 200;
const FX = CX + 2, FY = CY + 1, FZ = CZ;

const rcon = new Rcon();
let bot;
const ev = { probe: 'A2d-server-side-coal-truth', startedAt: nowIso(), samples: [] };

/** 服务端权威计数：clear <p> <item> 0 → "Found N matching item(s) on player"（不删除） */
async function serverCount(item) {
    const r = await rcon.cmd(`clear ${USER} minecraft:${item} 0`);
    const m = /[Ff]ound\s+(\d+)/.exec(r);
    return { raw: r, count: m ? Number(m[1]) : null };
}

async function furnaceSlot(idx) {
    const id = await rcon.cmd(`data get block ${FX} ${FY} ${FZ} Items[${idx}].id`);
    const cnt = await rcon.cmd(`data get block ${FX} ${FY} ${FZ} Items[${idx}].count`);
    const mi = /minecraft:[a-z0-9_]+/.exec(id);
    const mc = /block data:\s*(\d+)/.exec(cnt);
    return { id: mi ? mi[0] : null, count: mc ? Number(mc[1]) : null };
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

    ev.before = { serverCoal: await serverCount('coal'), serverRawIron: await serverCount('raw_iron') };
    log('before', JSON.stringify(ev.before));

    const furnace = blockAt(bot, { x: FX, y: FY, z: FZ });
    const loaded = await furnaceLoad(bot, furnace, 'raw_iron', 'coal', { count: 16 });
    ev.furnaceLoadReturn = loaded;

    for (const wait of [0, 500, 2000, 5000]) {
        if (wait) await sleep(wait);
        const s = {
            atMs: wait,
            serverCoal: await serverCount('coal'),
            furnaceInput: await furnaceSlot(0),
            furnaceFuel: await furnaceSlot(1),
            mineflayerCoal: (() => { let n = 0; for (const it of bot.inventory.items()) if (it.name === 'coal') n += it.count; return n; })(),
            mineflayerHeld: bot.heldItem ? { name: bot.heldItem.name, count: bot.heldItem.count } : null,
        };
        ev.samples.push(s);
        log('sample', JSON.stringify(s));
    }

    ev.verdict = {
        productSaidFuelCount2: loaded.data?.fuelCount === 2,
        productSaidInputCount16: loaded.data?.inputCount === 16,
        serverCoalLeftAfterLoad: ev.samples.at(-1).serverCoal.count,
        expectedServerCoalAfterLoad: 6,
        coalNotLost: ev.samples.at(-1).serverCoal.count === 6,
        furnaceFuelSlot: ev.samples.at(-1).furnaceFuel,
        furnaceInputSlot: ev.samples.at(-1).furnaceInput,
        note: '若服务端最终仍是 6 份煤 + 炉内 1-2 份，则"2 份一次投够"成立，mineflayer 中途读到 0 只是窗口/背包视图的暂态',
    };
    writeResult('result-A2d-coal-truth.json', ev);
    log('RESULT', JSON.stringify(ev.verdict));
    console.log(JSON.stringify(ev, null, 2));
} catch (e) {
    ev.error = String(e?.stack ?? e); writeResult('result-A2d-coal-truth.json', ev); console.error(ev.error); process.exitCode = 1;
} finally { try { bot?.quit('d'); } catch { } rcon.close(); await sleep(200); process.exit(process.exitCode ?? 0); }
