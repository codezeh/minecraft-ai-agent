// S3 · `loadSnapshot: null` 的**工具归因**实验：同一个熔炉、同一时刻，两种读法对比
//
// 结论要证明的是"我原先的 null 是探针假象，不是服务端行为"。三种读法并排：
//   ① 旧读法A：vanilla `/data get block ... Items` 一次性取整表
//      → 服务端把长结果截断成 `...`（实测正文 111 字符），解析只拿到第 0 格（或多格时拿到前两格）
//   ② 旧读法B：首版 RCON 客户端"读到首包就 resolve"
//      → 多包响应被腰斩（本文件用 probe-S2 的裸包转储为证，见 result-S2）
//   ③ 新读法：逐格 `Items[i].id` / `Items[i].count`（返回值短，不受截断影响）
// 三者对同一个装料后的熔炉做"燃料槽有几份煤"的判断，差异一目了然。
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { Rcon, connectBot, setupPlatform, setFurnace, clearInv, sleep, writeResult, log, nowIso } from './lib-probe.mjs';
import { furnaceLoad } from 'file:///E:/我的世界ai/mindcraft/src/agent/library/act_craft.js';
import { blockAt } from 'file:///E:/我的世界ai/mindcraft/src/agent/library/query_perceive.js';

const USER = 'probe2';
const CX = 200, CY = 70, CZ = 200;
const FX = CX + 2, FY = CY + 1, FZ = CZ;

/** 首版客户端的行为复刻：只把**第一个**响应包当结果就 resolve。 */
function legacyFirstPacketOnly(cmd, waitMs = 1200) {
    const txt = readFileSync('E:/我的世界ai/server/server.properties', 'utf8');
    const props = {};
    for (const l of txt.split(/\r?\n/)) { if (!l || l.startsWith('#')) continue; const i = l.indexOf('='); if (i > 0) props[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
    return new Promise((resolve) => {
        const sock = net.connect(Number(props['rcon.port'] || 25575), '127.0.0.1');
        const pack = (id, type, body) => {
            const b = Buffer.from(body, 'utf8'); const o = Buffer.alloc(14 + b.length);
            o.writeInt32LE(10 + b.length, 0); o.writeInt32LE(id, 4); o.writeInt32LE(type, 8);
            b.copy(o, 12); o.writeInt16LE(0, 12 + b.length); return o;
        };
        let buf = Buffer.alloc(0), stage = 'auth', got = null;
        sock.on('connect', () => sock.write(pack(1, 3, props['rcon.password'])));
        sock.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            while (buf.length >= 12) {
                const size = buf.readInt32LE(0);
                if (size < 10 || buf.length < size + 4) break;
                const id = buf.readInt32LE(4);
                const body = buf.slice(12, size + 4 - 2).toString('utf8');
                buf = buf.slice(size + 4);
                if (stage === 'auth') { stage = 'cmd'; sock.write(pack(7, 2, cmd)); continue; }
                if (id === 7 && got === null) got = body;      // ← 首包就定案（旧版 bug）
            }
        });
        setTimeout(() => { sock.end(); resolve(got); }, waitMs);
    });
}

const rcon = new Rcon();
let bot;
const ev = { probe: 'S3-read-method-diff', startedAt: nowIso() };

try {
    await rcon.connect();
    bot = await connectBot(USER);
    await setupPlatform(rcon, USER, CX, CY, CZ);
    // ★ air → furnace：`/setblock furnace replace` 盖在旧熔炉上不会清空方块实体库存
    await rcon.cmd(`setblock ${FX} ${FY} ${FZ} minecraft:air replace`);
    await sleep(150);
    await setFurnace(rcon, FX, FY, FZ);
    await clearInv(rcon, USER);
    await sleep(400);
    await rcon.cmd(`item replace block ${FX} ${FY} ${FZ} container.0 with minecraft:raw_iron 16`);
    await rcon.cmd(`item replace block ${FX} ${FY} ${FZ} container.1 with minecraft:coal 2`);
    await sleep(300);

    // ① 旧读法：一次性 Items
    const oneShot = await rcon.cmd(`data get block ${FX} ${FY} ${FZ} Items`);
    ev.oneShotItems = {
        bodyLen: oneShot.length,
        endsWithEllipsis: oneShot.trimEnd().endsWith('...'),
        body: oneShot,
        parsedByOldRegex: (() => {
            const re = /Slot:\s*(-?\d+)b?[^}]*?id:\s*"minecraft:([a-z0-9_]+)"[^}]*?count:\s*(\d+)/g;
            const out = []; let m; while ((m = re.exec(oneShot))) out.push({ slot: Number(m[1]), id: m[2], count: Number(m[3]) });
            return out;
        })(),
    };

    // ② 首版客户端行为（首包定案）
    const legacy = await legacyFirstPacketOnly(`data get block ${FX} ${FY} ${FZ} Items`);
    ev.legacyFirstPacketResult = { bodyLen: legacy ? legacy.length : null, body: legacy };

    // ③ 新读法：逐格
    const perSlot = [];
    for (const idx of [0, 1, 2]) {
        const id = await rcon.cmd(`data get block ${FX} ${FY} ${FZ} Items[${idx}].id`);
        const cnt = await rcon.cmd(`data get block ${FX} ${FY} ${FZ} Items[${idx}].count`);
        const mi = /minecraft:[a-z0-9_]+/.exec(id);
        const mc = /block data:\s*(\d+)/.exec(cnt);
        perSlot.push({ idx, id: mi ? mi[0].replace('minecraft:', '') : null, count: mc ? Number(mc[1]) : null, rawId: id, rawCount: cnt });
    }
    ev.perSlot = perSlot;

    // ④ 产品真实装料后，用新读法看燃料槽（直接观测，不是推断）
    await clearInv(rcon, USER);
    await rcon.cmd(`setblock ${FX} ${FY} ${FZ} minecraft:air replace`);
    await sleep(200);
    await rcon.cmd(`setblock ${FX} ${FY} ${FZ} minecraft:furnace replace`);
    await sleep(200);
    await rcon.cmd(`give ${USER} minecraft:raw_iron 16`);
    await rcon.cmd(`give ${USER} minecraft:coal 8`);
    await sleep(800);
    const furnace = blockAt(bot, { x: FX, y: FY, z: FZ });
    const t0 = Date.now();
    const loaded = await furnaceLoad(bot, furnace, 'raw_iron', 'coal', { count: 16 });
    const after = [];
    for (const idx of [0, 1, 2]) {
        const id = await rcon.cmd(`data get block ${FX} ${FY} ${FZ} Items[${idx}].id`);
        const cnt = await rcon.cmd(`data get block ${FX} ${FY} ${FZ} Items[${idx}].count`);
        const mi = /minecraft:[a-z0-9_]+/.exec(id);
        const mc = /block data:\s*(\d+)/.exec(cnt);
        after.push({ idx, id: mi ? mi[0].replace('minecraft:', '') : null, count: mc ? Number(mc[1]) : null });
    }
    ev.productLoad = {
        returned: loaded,
        loadCostMs: Date.now() - t0,
        furnaceSlotsDirectObservation: after,
        serverCoal: (await rcon.cmd(`clear ${USER} minecraft:coal 0`)),
    };
    ev.verdict = {
        oneShotTruncated: ev.oneShotItems.endsWithEllipsis,
        oneShotSawOnlySlots: ev.oneShotItems.parsedByOldRegex.map((s) => s.slot),
        legacyFirstPacketAlsoTruncated: ev.legacyFirstPacketResult.bodyLen === ev.oneShotItems.bodyLen,
        perSlotSawFuelCount: (perSlot.find((s) => s.idx === 1) ?? {}).count,
        perSlotSawInputCount: (perSlot.find((s) => s.idx === 0) ?? {}).count,
        afterLoadInputDirect: (after.find((s) => s.idx === 0) ?? {}).count,
        afterLoadFuelDirect: (after.find((s) => s.idx === 1) ?? {}).count,
        note: '① 一次性 Items 因服务端截断只看到前两格；③ 逐格读法给出直接读数 ⇒ 原先的 loadSnapshot=null 是探针假象',
    };
    writeResult('result-S3-read-method-diff.json', ev);
    log('RESULT', JSON.stringify(ev.verdict));
    console.log(JSON.stringify(ev.verdict, null, 2));
} catch (e) {
    ev.error = String(e?.stack ?? e);
    writeResult('result-S3-read-method-diff.json', ev);
    console.error('PROBE FAILED', ev.error);
    process.exitCode = 1;
} finally { try { bot?.quit('d'); } catch { } rcon.close(); await sleep(200); process.exit(process.exitCode ?? 0); }
