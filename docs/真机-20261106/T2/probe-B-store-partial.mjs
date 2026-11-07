// B · BOT-009 真机部分进度（fail-in-part 必须如实报 stored）
//
// 场景：真 chest 27 格，先填满 24 格（每格 64 石头）→ **只剩 3 格容量**；
//       背包 10 把 iron_sword（不可堆叠 ⇒ 3 个空格只吃得下 3 把）
//       请求 store('iron_sword', 10)
//
// 期望（Lead 标尺）：返回真实 partial，stored=3；不是 stored=0 / INTERNAL；背包 10→7。
//
// 关键仪器修正（上一版 B 的坑）：vanilla `/data get` 会把长 NBT 截断成 `...`，
//   用一次 `Items` 判断"填了几格"会把 24 格误读成 1 格（见 probe-S2）。
//   这里改用 **逐格 Items[i].id/count** + **服务端 `clear <p> <item> 0` 权威计数**。
import {
    Rcon, connectBot, setupPlatform, setChest, give, clearInv,
    blockSlots, serverItemCount, writeResult, log, sleep, nowIso,
} from './lib-probe.mjs';
import { store } from 'file:///E:/我的世界ai/mindcraft/src/agent/library/flow_store.js';

const USER = 'probe2';
const CX = 300, CY = 70, CZ = 300;
const HX = CX + 3, HY = CY + 1, HZ = CZ;

const rcon = new Rcon();
let bot;
const ev = { probe: 'B-store-partial', startedAt: nowIso() };

try {
    await rcon.connect();
    bot = await connectBot(USER);
    await setupPlatform(rcon, USER, CX, CY, CZ);
    await setChest(rcon, HX, HY, HZ);
    await clearInv(rcon, USER);
    await sleep(300);

    // 填满 24 格 → 剩 3 格
    const fillResults = [];
    for (let s = 0; s < 24; s++) {
        fillResults.push(await rcon.cmd(`item replace block ${HX} ${HY} ${HZ} container.${s} with minecraft:dirt 64`));
    }
    ev.fillCommandSample = fillResults.slice(0, 3);

    const before = await blockSlots(rcon, HX, HY, HZ, 27);
    ev.chestBefore = { pos: { x: HX, y: HY, z: HZ }, usedSlots: before.used, freeSlots: before.free, slots: before.slots };

    await give(rcon, USER, 'iron_sword', 10);
    await sleep(900);
    ev.invBefore = {
        mineflayer: (() => { let n = 0; for (const it of bot.inventory.items()) if (it.name === 'iron_sword') n += it.count; return n; })(),
        server: await serverItemCount(rcon, USER, 'iron_sword'),
    };
    log('before:', JSON.stringify({ freeSlots: before.free, inv: ev.invBefore }));

    const t0 = Date.now();
    const res = await store(bot, 'iron_sword', 10, {});
    const wallMs = Date.now() - t0;
    await sleep(900);   // 等窗口/背包计数落定

    const after = await blockSlots(rcon, HX, HY, HZ, 27);
    const swordsInChest = after.slots.filter((s) => s.id === 'iron_sword').reduce((a, b) => a + (b.count ?? 0), 0);

    ev.result = res;
    ev.wallMs = wallMs;
    ev.invAfter = {
        mineflayer: (() => { let n = 0; for (const it of bot.inventory.items()) if (it.name === 'iron_sword') n += it.count; return n; })(),
        server: await serverItemCount(rcon, USER, 'iron_sword'),
    };
    ev.chestAfter = { usedSlots: after.used, freeSlots: after.free, swordsInChest, slotDetail: after.slots.filter((s) => s.id === 'iron_sword') };
    ev.realDelta = {
        serverInvDropped: (ev.invBefore.server.count ?? 0) - (ev.invAfter.server.count ?? 0),
        chestSwords: swordsInChest,
    };
    ev.expected = {
        reportedStored: 3,
        invAfter: 7,
        chestSwords: 3,
        notStoredZero: true,
        notInternal: true,
        why: '3 个空位 × 不可堆叠 = 最多 3 把；老缺陷会报 INTERNAL/stored:0 让上层按零进度重试',
    };
    ev.verdict = {
        code: res.code,
        reportedStored: Number(res.data?.stored),
        reportedStoredIs3: Number(res.data?.stored) === 3,
        serverInv10to7: ev.invAfter.server.count === 7,
        chestReallyGained3: swordsInChest === 3,
        notStoredZero: Number(res.data?.stored) !== 0,
        notInternal: res.code !== 'INTERNAL',
        partialFlagged: res.data?.partial === true || res.code === 'INVENTORY_FULL',
        storedMatchesRealDelta: Number(res.data?.stored) === ev.realDelta.serverInvDropped,
    };
    writeResult('result-B-store-partial.json', ev);
    log('RESULT', JSON.stringify(ev.verdict));
    console.log(JSON.stringify(ev, null, 2));
} catch (e) {
    ev.error = String(e?.stack ?? e);
    writeResult('result-B-store-partial.json', ev);
    console.error('PROBE FAILED:', ev.error);
    process.exitCode = 1;
} finally {
    try { bot?.quit('done'); } catch { }
    rcon.close();
    await sleep(300);
    process.exit(process.exitCode ?? 0);
}
