// 诊断：熔炉 NBT 里燃料槽在"正在燃烧"时到底长什么样？
// 目的：A2 的 loadSnapshot 里始终没看到 slot 1（coal），需要判断是
//   (a) 服务端在开始燃烧时就把燃料格清掉了（NBT 看不到），还是
//   (b) 我的解析/读取有问题。
// 做法：手动用 /item replace 放 2 煤 + 4 原料，然后在 1s/5s/20s/85s 各读一次 NBT。
import { Rcon, connectBot, setupPlatform, setFurnace, clearInv, furnaceState, writeResult, log, sleep, nowIso } from './lib-probe.mjs';

const USER = 'probe2';
const CX = 200, CY = 70, CZ = 200;
const FX = CX + 2, FY = CY + 1, FZ = CZ;

const rcon = new Rcon();
let bot;
const ev = { probe: 'S1-nbt-fuel-while-burning', startedAt: nowIso(), samples: [] };
try {
    await rcon.connect();
    bot = await connectBot(USER);
    await setupPlatform(rcon, USER, CX, CY, CZ);
    await setFurnace(rcon, FX, FY, FZ);
    await clearInv(rcon, USER);
    await sleep(500);

    await rcon.cmd(`item replace block ${FX} ${FY} ${FZ} container.0 with minecraft:raw_iron 4`);
    await rcon.cmd(`item replace block ${FX} ${FY} ${FZ} container.1 with minecraft:coal 2`);
    const t0 = Date.now();
    for (const wait of [1000, 4000, 15000, 70000, 20000]) {
        await sleep(wait);
        const st = await furnaceState(rcon, FX, FY, FZ);
        ev.samples.push({ atMs: Date.now() - t0, all: st.all, raw: st.raw });
        log(`t=${((Date.now() - t0) / 1000).toFixed(1)}s`, JSON.stringify(st.all));
    }
    ev.verdict = {
        fuelSeenAtAnySample: ev.samples.some((s) => s.all.some((i) => i.slot === 1)),
        note: '若燃料槽在燃烧期看不到煤 → A2 的 loadSnapshot 缺失 slot1 属于服务端行为，不是解析问题',
    };
    writeResult('result-S1-nbt-fuel.json', ev);
    console.log(JSON.stringify(ev, null, 2));
} catch (e) {
    ev.error = String(e?.stack ?? e); writeResult('result-S1-nbt-fuel.json', ev); console.error(ev.error); process.exitCode = 1;
} finally { try { bot?.quit('d'); } catch { } rcon.close(); await sleep(200); process.exit(process.exitCode ?? 0); }
