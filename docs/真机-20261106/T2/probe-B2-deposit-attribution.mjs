// B2 · 归因 `stored` 多报 1 件：直接调 deposit()，把它自己的账 + 窗口光标 + 服务端权威计数一起抓下来
//
// 假设（要在真机上证实或推翻）：
//   deposit() 用 `stored = invBefore - invAfter` 作为"存进去几件"，
//   而 catch/成功分支前后的 `waitCountsSettled(() => invCount < invBefore || winCount > winBefore)`
//   只要求"**第一件**动了"就返回（act_container.js:447/463），不等两边计数一致。
//   于是第 4 把剑"已离开背包、还没落进箱子"（在容器光标上）时，就被算成已存 ⇒ stored 多报 1。
// 证据要求：
//   ① deposit 自己返回的 data（invBefore/invAfter/winBefore/winAfter/stored）
//   ② 同一瞬间 服务端背包计数 + 箱子逐格内容 + 窗口 selectedItem(光标)
//   ③ 守恒检验：inv + chest 是否 = 10；关窗后是否回到 inv=7 / chest=3
//   ④ flow_store.store() 连跑 2 次，确认最终 stored 是否稳定为 4
import {
    Rcon, connectBot, setupPlatform, setChest, give, clearInv,
    blockSlots, serverItemCount, writeResult, log, sleep, nowIso,
} from './lib-probe.mjs';
import { openContainer, closeContainer, deposit } from 'file:///E:/我的世界ai/mindcraft/src/agent/library/act_container.js';
import { store } from 'file:///E:/我的世界ai/mindcraft/src/agent/library/flow_store.js';

const USER = 'probe2';
const CX = 300, CY = 70, CZ = 300;
const HX = CX + 3, HY = CY + 1, HZ = CZ;
const POS = { x: HX, y: HY, z: HZ };

const rcon = new Rcon();
let bot;
const ev = { probe: 'B2-deposit-attribution', startedAt: nowIso(), storeRuns: [] };

async function chestSwords() {
    const b = await blockSlots(rcon, HX, HY, HZ, 27);
    return {
        swords: b.slots.filter((s) => s.id === 'iron_sword').reduce((a, s) => a + (s.count ?? 0), 0),
        swordSlots: b.slots.filter((s) => s.id === 'iron_sword'),
        free: b.free, used: b.used,
    };
}

async function setupChest3Free() {
    await rcon.cmd(`setblock ${HX} ${HY} ${HZ} minecraft:air replace`);
    await sleep(150);
    await setChest(rcon, HX, HY, HZ);
    await sleep(150);
    for (let s = 0; s < 24; s++) {
        await rcon.cmd(`item replace block ${HX} ${HY} ${HZ} container.${s} with minecraft:dirt 64`);
    }
}

try {
    await rcon.connect();
    bot = await connectBot(USER);
    await setupPlatform(rcon, USER, CX, CY, CZ);
    await clearInv(rcon, USER);
    await setupChest3Free();

    const before = await chestSwords();
    ev.chestBefore = { freeSlots: before.free, usedSlots: before.used };

    // ─────── ① 直接调 deposit()，抓它自己的账 ───────
    await give(rcon, USER, 'iron_sword', 10);
    await sleep(900);
    const invBefore = await serverItemCount(rcon, USER, 'iron_sword');
    const opened = await openContainer(bot, { kind: 'block', pos: POS }, {});
    ev.openResult = { ok: opened.ok, code: opened.code, costMs: opened.data?.costMs };

    const d = await deposit(bot, 'iron_sword', 10);
    // 立刻抓"同一瞬间"的三方视图
    const instant = {
        depositReturn: d,
        serverInv: await serverItemCount(rcon, USER, 'iron_sword'),
        chest: await chestSwords(),
        cursor: (() => {
            const w = bot.currentWindow;
            const sel = w?.selectedItem;
            return sel ? { name: sel.name, count: sel.count, slot: sel.slot } : null;
        })(),
        windowType: bot.currentWindow?.type ?? null,
    };
    instant.conservation = {
        invPlusChest: (instant.serverInv.count ?? 0) + instant.chest.swords,
        expected10: 10,
        lostOrInTransit: 10 - ((instant.serverInv.count ?? 0) + instant.chest.swords),
    };
    ev.invBeforeDeposit = invBefore;
    ev.depositInstant = instant;

    // ─────── ③ 关窗后守恒是否回来 ───────
    closeContainer(bot);
    await sleep(900);
    ev.afterClose = {
        serverInv: await serverItemCount(rcon, USER, 'iron_sword'),
        chest: await chestSwords(),
        cursor: bot.currentWindow ? 'window still open' : null,
    };
    ev.afterClose.conservation = (ev.afterClose.serverInv.count ?? 0) + ev.afterClose.chest.swords;

    // ─────── ④ flow_store.store() 连跑 2 次，看最终报数是否稳定 ───────
    for (let run = 1; run <= 2; run++) {
        await clearInv(rcon, USER);
        await setupChest3Free();
        await sleep(300);
        await give(rcon, USER, 'iron_sword', 10);
        await sleep(900);
        const invB = await serverItemCount(rcon, USER, 'iron_sword');
        const chestB = await chestSwords();
        const t0 = Date.now();
        const res = await store(bot, 'iron_sword', 10, {});
        const wallMs = Date.now() - t0;
        await sleep(900);
        const invA = await serverItemCount(rcon, USER, 'iron_sword');
        const chestA = await chestSwords();
        ev.storeRuns.push({
            run,
            invBefore: invB.count,
            chestFreeBefore: chestB.free,
            code: res.code,
            reportedStored: Number(res.data?.stored ?? NaN),
            message: res.message,
            realInvDropped: (invB.count ?? 0) - (invA.count ?? 0),
            realChestGained: chestA.swords - chestB.swords,
            wallMs,
            overreportBy: Number(res.data?.stored ?? NaN) - ((invB.count ?? 0) - (invA.count ?? 0)),
        });
        log(`store run ${run}: reported=${res.data?.stored} realChest=${chestA.swords - chestB.swords} realInvDrop=${(invB.count ?? 0) - (invA.count ?? 0)}`);
    }

    ev.verdict = {
        depositCode: d.code,
        depositReportedStored: Number(d.data?.stored ?? NaN),
        depositOwnInvoice: {
            invBefore: d.data?.invBefore, invAfter: d.data?.invAfter,
            winBefore: d.data?.winBefore, winAfter: d.data?.winAfter,
        },
        cursorHeldTheMissingItem: instant.cursor ? instant.cursor : null,
        conservationAtDecision: instant.conservation,
        conservationAfterClose: ev.afterClose.conservation,
        storeReportedStored: ev.storeRuns.map((r) => r.reportedStored),
        storeRealChestGained: ev.storeRuns.map((r) => r.realChestGained),
        storeRealInvDropped: ev.storeRuns.map((r) => r.realInvDropped),
        deterministicOverreport: ev.storeRuns.every((r) => r.overreportBy === 1),
    };
    writeResult('result-B2-deposit-attribution.json', ev);
    log('RESULT', JSON.stringify(ev.verdict));
    console.log(JSON.stringify(ev, null, 2));
} catch (e) {
    ev.error = String(e?.stack ?? e);
    writeResult('result-B2-deposit-attribution.json', ev);
    console.error('PROBE FAILED:', ev.error);
    process.exitCode = 1;
} finally {
    try { bot?.quit('done'); } catch { }
    rcon.close();
    await sleep(300);
    process.exit(process.exitCode ?? 0);
}
