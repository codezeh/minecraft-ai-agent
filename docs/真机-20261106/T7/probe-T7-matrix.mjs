// T7 · BOT-009 修复的真机验收（存物 + 取物，各两种结局）
//
// 改前/改后对照的四个场景（全部真机：Paper + 真 chest + 真 mineflayer bot）：
//   ① 存物 partial：箱只剩 3 空位 × 存 10 把铁剑  → 期望 stored=3、code=INVENTORY_FULL、partial=true
//   ② 存物 full   ：空箱 × 存 10 把铁剑          → 期望 stored=10、ok（不许少报）
//   ③ 取物 partial：箱有 10 把 × 背包只剩 3 空位 × 取 10 → 期望 taken=3、INVENTORY_FULL、partial=true
//   ④ 取物 full   ：箱有 10 把 × 空背包 × 取 10   → 期望 taken=10、ok
//
// 每个场景都同时记录：返回的账 / 服务端 `clear <p> <item> 0` 权威计数 / 箱子逐格 NBT，
// 用"真实账单"给返回值定罪（不靠返回值自证）。
//
// 复用 T2 的探针工具箱（lib-probe.mjs），但**结果写 T7 自己的文件**，不覆盖 T2 的改前证据。
import { writeFileSync } from 'node:fs';
import {
    Rcon, connectBot, setupPlatform, setChest, give, clearInv,
    blockSlots, serverItemCount, sleep, nowIso,
} from 'file:///E:/我的世界ai/docs/真机-20261106/T2/lib-probe.mjs';
import { openContainer, closeContainer, deposit, withdraw } from 'file:///E:/我的世界ai/mindcraft/src/agent/library/act_container.js';
import { store, fetch } from 'file:///E:/我的世界ai/mindcraft/src/agent/library/flow_store.js';

const T7 = 'E:/我的世界ai/docs/真机-20261106/T7';
const USER = 'probe2';
const CX = 300, CY = 70, CZ = 300;
const HX = CX + 3, HY = CY + 1, HZ = CZ;
const POS = { x: HX, y: HY, z: HZ };

const rcon = new Rcon();
let bot;
const ev = { probe: 'T7-deposit-withdraw-matrix', startedAt: nowIso(), scenarios: [] };

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

/**
 * 服务端权威计数（`clear <p> <item> 0` 只报告不删除）。
 *
 * ★ 探针坑（T7 首跑踩到）：数量为 0 时 vanilla 不回 "Found 0 matching item(s)"，
 *   而是回 "No items were found on player …"。T2 的 `serverItemCount` 只匹配 Found → 返回 null，
 *   于是本探针把 `0 - null` 算成 3、`invBefore` 记成 null，真假不分。
 *   这里在 T7 内做一次本地兜底（不去改 T2 的共用工具箱，避免动别人的证据目录）。
 */
async function serverCount(item) {
    const raw = await rcon.cmd(`clear ${USER} minecraft:${item} 0`);
    const m = /[Ff]ound\s+(\d+)/.exec(raw);
    if (m) return { raw, count: Number(m[1]) };
    if (/[Nn]o items were found/.test(raw)) return { raw, count: 0 };
    return { raw, count: null };   // 解析不出来就保持 null，让断言失败而不是假装 0
}

async function chestSwords() {
    const b = await blockSlots(rcon, HX, HY, HZ, 27);
    return {
        swords: b.slots.filter((s) => s.id === 'iron_sword').reduce((a, s) => a + (s.count ?? 0), 0),
        slots: b.slots.filter((s) => s.id === 'iron_sword'),
        free: b.free, used: b.used,
    };
}

/** 全新箱子：先 air 再放，避免 `/setblock chest replace` 保留旧方块实体库存。 */
async function freshChest(fillDirtSlots = 0) {
    await rcon.cmd(`setblock ${HX} ${HY} ${HZ} minecraft:air replace`);
    await sleep(120);
    await setChest(rcon, HX, HY, HZ);
    await sleep(120);
    for (let s = 0; s < fillDirtSlots; s++) {
        await rcon.cmd(`item replace block ${HX} ${HY} ${HZ} container.${s} with minecraft:dirt 64`);
    }
}

/** 把箱子填成只剩 freeSlots 个空位。 */
async function chestWithFreeSlots(freeSlots) {
    await freshChest(27 - freeSlots);
}

function push(name, data) { ev.scenarios.push({ name, ...data }); log(`${name}:`, JSON.stringify(data.verdict)); }

try {
    await rcon.connect();
    bot = await connectBot(USER);
    await setupPlatform(rcon, USER, CX, CY, CZ);

    // ───────────── ① 存物 partial：箱只剩 3 空位，存 10 把剑 ─────────────
    {
        await chestWithFreeSlots(3);
        await clearInv(rcon, USER);
        await sleep(200);
        await give(rcon, USER, 'iron_sword', 10);
        await sleep(900);
        const invB = await serverCount('iron_sword');
        const chestB = await chestSwords();
        const opened = await openContainer(bot, { kind: 'block', pos: POS }, {});
        const t0 = Date.now();
        const res = await deposit(bot, 'iron_sword', 10);
        const wallMs = Date.now() - t0;
        await sleep(700);
        const invA = await serverCount('iron_sword');
        const chestA = await chestSwords();
        const cursor = bot.currentWindow?.selectedItem ? { name: bot.currentWindow.selectedItem.name, count: bot.currentWindow.selectedItem.count } : null;
        closeContainer(bot);
        await sleep(700);
        const invClosed = await serverCount('iron_sword');
        const chestClosed = await chestSwords();

        push('① deposit partial', {
            open: { ok: opened.ok, code: opened.code },
            returned: res,
            wallMs,
            real: {
                invBefore: invB.count, invAfter: invA.count, invAfterClose: invClosed.count,
                chestBefore: chestB.swords, chestAfter: chestA.swords, chestAfterClose: chestClosed.swords,
            },
            cursorAtReturn: cursor,
            verdict: {
                codeIsInventoryFull: res.code === 'INVENTORY_FULL',
                partialTrue: res.data?.partial === true,
                storedIs3: Number(res.data?.stored) === 3,
                realChestGained3: chestA.swords - chestB.swords === 3,
                realInvDropped3: invB.count - invA.count === 3,
                storedMatchesRealChest: Number(res.data?.stored) === (chestA.swords - chestB.swords),
                conservationAfterClose: invClosed.count + chestClosed.swords,
            },
        });
    }

    // ───────────── ② 存物 full：空箱，存 10 把剑 ─────────────
    {
        await chestWithFreeSlots(27);
        await clearInv(rcon, USER);
        await sleep(200);
        await give(rcon, USER, 'iron_sword', 10);
        await sleep(900);
        const invB = await serverCount('iron_sword');
        const chestB = await chestSwords();
        await openContainer(bot, { kind: 'block', pos: POS }, {});
        const t0 = Date.now();
        const res = await deposit(bot, 'iron_sword', 10);
        const wallMs = Date.now() - t0;
        await sleep(700);
        const invA = await serverCount('iron_sword');
        const chestA = await chestSwords();
        closeContainer(bot);
        await sleep(500);
        const invClosed = await serverCount('iron_sword');
        const chestClosed = await chestSwords();
        push('② deposit full', {
            returned: res,
            wallMs,
            real: {
                invBefore: invB.count, invAfter: invA.count, invAfterClose: invClosed.count,
                chestBefore: chestB.swords, chestAfter: chestA.swords, chestAfterClose: chestClosed.swords,
            },
            verdict: {
                okTrue: res.ok === true,
                storedIs10: Number(res.data?.stored) === 10,
                noUnderReport: Number(res.data?.stored) === 10,
                realChestGained10: chestA.swords - chestB.swords === 10,
                realInvDropped10: invB.count - invA.count === 10,
                conservationAfterClose: invClosed.count + chestClosed.swords,
            },
        });
    }

    // ───────────── ③ 取物 partial：箱 10 把，背包只剩 3 空位，取 10 ─────────────
    {
        await chestWithFreeSlots(27);
        await clearInv(rcon, USER);
        await sleep(200);
        // 箱里放 10 把剑
        for (let i = 0; i < 10; i++) {
            await rcon.cmd(`item replace block ${HX} ${HY} ${HZ} container.${i} with minecraft:iron_sword 1`);
        }
        // 背包用 33 格泥土占住 → 只剩 3 格空位（36 格：9 快捷 + 27 主背包）
        await give(rcon, USER, 'dirt', 33 * 64);
        await sleep(1200);
        const invSwordB = await serverCount('iron_sword');
        const chestB = await chestSwords();
        const freeSlots = bot.inventory.emptySlotCount();
        await openContainer(bot, { kind: 'block', pos: POS }, {});
        const t0 = Date.now();
        const res = await withdraw(bot, 'iron_sword', 10);
        const wallMs = Date.now() - t0;
        await sleep(700);
        const invSwordA = await serverCount('iron_sword');
        const chestA = await chestSwords();
        const cursor = bot.currentWindow?.selectedItem ? { name: bot.currentWindow.selectedItem.name, count: bot.currentWindow.selectedItem.count } : null;
        closeContainer(bot);
        await sleep(700);
        const invSwordClosed = await serverCount('iron_sword');
        const chestClosed = await chestSwords();
        push('③ withdraw partial', {
            returned: res,
            wallMs,
            botFreeSlotsBefore: freeSlots,
            real: {
                invBefore: invSwordB.count, invAfter: invSwordA.count, invAfterClose: invSwordClosed.count,
                chestBefore: chestB.swords, chestAfter: chestA.swords, chestAfterClose: chestClosed.swords,
            },
            cursorAtReturn: cursor,
            verdict: {
                codeIsInventoryFull: res.code === 'INVENTORY_FULL',
                partialTrue: res.data?.partial === true,
                takenIs3: Number(res.data?.taken) === 3,
                realInvGained3: invSwordA.count - invSwordB.count === 3,
                realChestLost3: chestB.swords - chestA.swords === 3,
                takenMatchesRealInv: Number(res.data?.taken) === (invSwordA.count - invSwordB.count),
                conservationAfterClose: invSwordClosed.count + chestClosed.swords,
            },
        });
    }

    // ───────────── ④ 取物 full：箱 10 把，空背包，取 10 ─────────────
    {
        await chestWithFreeSlots(27);
        await clearInv(rcon, USER);
        await sleep(200);
        for (let i = 0; i < 10; i++) {
            await rcon.cmd(`item replace block ${HX} ${HY} ${HZ} container.${i} with minecraft:iron_sword 1`);
        }
        await sleep(600);
        const invSwordB = await serverCount('iron_sword');
        const chestB = await chestSwords();
        await openContainer(bot, { kind: 'block', pos: POS }, {});
        const t0 = Date.now();
        const res = await withdraw(bot, 'iron_sword', 10);
        const wallMs = Date.now() - t0;
        await sleep(700);
        const invSwordA = await serverCount('iron_sword');
        const chestA = await chestSwords();
        closeContainer(bot);
        await sleep(500);
        const invSwordClosed = await serverCount('iron_sword');
        const chestClosed = await chestSwords();
        push('④ withdraw full', {
            returned: res,
            wallMs,
            real: {
                invBefore: invSwordB.count, invAfter: invSwordA.count, invAfterClose: invSwordClosed.count,
                chestBefore: chestB.swords, chestAfter: chestA.swords, chestAfterClose: chestClosed.swords,
            },
            verdict: {
                okTrue: res.ok === true,
                takenIs10: Number(res.data?.taken) === 10,
                noUnderReport: Number(res.data?.taken) === 10,
                realInvGained10: invSwordA.count - invSwordB.count === 10,
                realChestLost10: chestB.swords - chestA.swords === 10,
                conservationAfterClose: invSwordClosed.count + chestClosed.swords,
            },
        });
    }

    // ───────────── ⑤ 流程层：store() 走完整 flow（T2 原用例等价复跑）─────────────
    {
        await chestWithFreeSlots(3);
        await clearInv(rcon, USER);
        await sleep(200);
        await give(rcon, USER, 'iron_sword', 10);
        await sleep(900);
        const invB = await serverCount('iron_sword');
        const chestB = await chestSwords();
        const t0 = Date.now();
        const res = await store(bot, 'iron_sword', 10, {});
        const wallMs = Date.now() - t0;
        await sleep(800);
        const invA = await serverCount('iron_sword');
        const chestA = await chestSwords();
        push('⑤ flow store partial (T2 等价复跑)', {
            returned: res, wallMs,
            real: { invBefore: invB.count, invAfter: invA.count, chestBefore: chestB.swords, chestAfter: chestA.swords },
            verdict: {
                codeIsInventoryFull: res.code === 'INVENTORY_FULL',
                partialTrue: res.data?.partial === true,
                storedIs3: Number(res.data?.stored) === 3,
                realChestGained3: chestA.swords - chestB.swords === 3,
                realInvDropped3: invB.count - invA.count === 3,
                storedMatchesReal: Number(res.data?.stored) === (chestA.swords - chestB.swords),
            },
        });
    }

    // ───────────── ⑥ 流程层：fetch() 取物 partial（跨箱累计路径）─────────────
    {
        await chestWithFreeSlots(27);
        await clearInv(rcon, USER);
        await sleep(200);
        for (let i = 0; i < 10; i++) {
            await rcon.cmd(`item replace block ${HX} ${HY} ${HZ} container.${i} with minecraft:iron_sword 1`);
        }
        await give(rcon, USER, 'dirt', 33 * 64);   // 只剩 3 格
        await sleep(1200);
        const invSwordB = await serverCount('iron_sword');
        const chestB = await chestSwords();
        const t0 = Date.now();
        const res = await fetch(bot, 'iron_sword', 10, {});
        const wallMs = Date.now() - t0;
        await sleep(800);
        const invSwordA = await serverCount('iron_sword');
        const chestA = await chestSwords();
        push('⑥ flow fetch partial (跨箱累计路径)', {
            returned: res, wallMs,
            real: { invBefore: invSwordB.count, invAfter: invSwordA.count, chestBefore: chestB.swords, chestAfter: chestA.swords },
            verdict: {
                code: res.code,
                takenReported: Number(res.data?.taken),
                realInvGained: invSwordA.count - invSwordB.count,
                realChestLost: chestB.swords - chestA.swords,
                takenMatchesReal: Number(res.data?.taken) === (invSwordA.count - invSwordB.count),
            },
        });
    }

    ev.summary = {
        scenarios: ev.scenarios.length,
        allVerdicts: ev.scenarios.map((s) => ({ name: s.name, ...s.verdict })),
    };
    writeFileSync(`${T7}/result-matrix.json`, JSON.stringify(ev, null, 2));
    log('WROTE result-matrix.json');
} catch (e) {
    ev.error = String(e?.stack ?? e);
    writeFileSync(`${T7}/result-matrix.json`, JSON.stringify(ev, null, 2));
    console.error('PROBE FAILED:', ev.error);
    process.exitCode = 1;
} finally {
    try { bot?.quit('done'); } catch { }
    rcon.close();
    await sleep(300);
    process.exit(process.exitCode ?? 0);
}