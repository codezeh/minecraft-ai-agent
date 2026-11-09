#!/usr/bin/env node
/**
 * 取物守恒的**真机**探针：`fetch(n)` 是否真的只搬走 n 个、且账目与物理一致。
 *
 * 为什么是"真机探针"而不是离线单测（重要，别再改回去）：
 *   我（t33）曾把这个文件写成**离线 fake window + 注入**的单测，断言 `taken === 物理搬动`，
 *   在假环境里 10/10 绿 —— 但真机 e2e 依旧 10 跑 0 绿。教训：**单测绿 ≠ 真实链路绿**。
 *   原因：真实链路的抖动来自 mineflayer `transfer()` 内部（拿整摞→分件→放回余数）与
 *   服务端槽位更新的时序，`fake window` 无法忠实表达。所以这里只做**真机**验证。
 *
 * 无测试服时：打印 SKIP 并 exit 0（不阻断 gate；它本来就是真机探针）。
 *
 * 用法：
 *   node tools/chest_withdraw_race_unit.mjs            # 需测试服 25566 / RCON 25576
 *   node tools/chest_withdraw_race_unit.mjs --rounds=20
 *
 * 判定（每一轮）：
 *   期望：箱子减少量 == 请求量 且 == 技能自报 taken；否则记一次 ANOMALY 并落盘现场。
 * 退出码：0 = 全部轮次都守恒；1 = 出现异常；无服 = SKIP + 0。
 */
import net from 'node:net';

const serverUp = await new Promise((resolve) => {
    const sock = net.connect(25566, '127.0.0.1');
    const done = (v) => { try { sock.destroy(); } catch { /* ignore */ } resolve(v); };
    sock.setTimeout(1500);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
});
if (!serverUp) {
    console.log('SKIP chest_withdraw_race_unit：需要跑着的测试服（MC 25566 / RCON 25576）');
    console.log('     起服：node docs/audit-r5/evidence/ingame/run_live_tool.mjs tools/chest_withdraw_race_unit.mjs');
    console.log('     或者直接跑真机场景：powershell -File scripts/e2e.ps1 -Scenario chest');
    process.exit(0);
}

// 有测试服 → 走真机循环（与 t30 的探针同口径）
const { default: mineflayer } = await import('mineflayer');
const { default: pf } = await import('mineflayer-pathfinder');
const { rcon } = await import('./rcon.mjs');
const { installPositionGuard } = await import('../src/sim/position_guard.js');
const { openContainer, closeContainer } = await import('../src/agent/library/act_container.js');
const { store, fetch: fetchItems } = await import('../src/agent/library/flow_store.js');

const argv = process.argv.slice(2);
const argOf = (k, d) => {
    const a = argv.find((x) => x.startsWith('--' + k + '='));
    return a ? a.split('=')[1] : d;
};
const ROUNDS = Number(argOf('rounds', 10));
const CHEST = { x: -98, y: -60, z: -600 };
const HOME = { x: -101, y: -60, z: -600 };
const NAME = 'cwu' + (Date.now() % 100000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });

const bot = mineflayer.createBot({
    host: '127.0.0.1', port: 25566, username: NAME, auth: 'offline', version: '1.21.8',
});
bot.loadPlugin(pf.pathfinder);
installPositionGuard(bot);
bot.on('error', () => { /* ignore */ });

const invOak = () => (bot.inventory?.items?.() ?? [])
    .filter((i) => i?.name === 'oak_log').reduce((n, i) => n + i.count, 0);

async function rconChest() {
    const raw = String(await RC(`data get block ${CHEST.x} ${CHEST.y} ${CHEST.z} Items`));
    let total = 0;
    for (const e of raw.match(/\{[^{}]*\}/g) ?? []) {
        const idm = e.match(/id:\s*"(?:minecraft:)?([a-z0-9_]+)"/);
        const cm = e.match(/count:\s*(\d+)/);
        if (idm && cm && idm[1] === 'oak_log') total += Number(cm[1]);
    }
    return total;
}

bot.once('spawn', async () => {
    let anomalies = 0;
    try {
        await sleep(2000);
        await RC('op ' + NAME);
        await RC(`tp ${NAME} ${HOME.x + 0.5} ${HOME.y} ${HOME.z + 0.5}`);
        await sleep(1200);
        await RC(`setblock ${CHEST.x} ${CHEST.y} ${CHEST.z} chest`);
        await sleep(800);

        for (let round = 1; round <= ROUNDS; round++) {
            await RC(`clear ${NAME}`);
            for (let i = 0; i < 27; i++) {
                await RC(`item replace block ${CHEST.x} ${CHEST.y} ${CHEST.z} container.${i} with air`);
            }
            await sleep(250);
            await RC(`give ${NAME} minecraft:oak_log 32`);
            await sleep(900);

            await store(bot, 'oak_log', 16);
            await sleep(300);
            const chestBefore = await rconChest();
            const invBefore = invOak();

            const r = await fetchItems(bot, 'oak_log', 8);
            await sleep(600);
            const chestAfter = await rconChest();
            const invAfter = invOak();
            const physical = chestBefore - chestAfter;
            const taken = Number(r?.data?.taken ?? 0);
            const conserved = (chestAfter + invAfter) === (chestBefore + invBefore);
            const bad = physical !== 8 || taken !== 8 || !conserved || r?.ok !== true;
            if (bad) anomalies++;
            console.log(`round ${round}: chest ${chestBefore}→${chestAfter} (物理 ${physical}) inv ${invBefore}→${invAfter} | taken=${taken} ok=${r?.ok} code=${r?.code ?? ''} 守恒=${conserved}${bad ? '   <<< ANOMALY' : ''}`);

            // 恢复：把这轮取出来的放回去，保持下一轮起点一致
            if (invAfter > 16) {
                await store(bot, 'oak_log', Math.min(invAfter - 16, 8));
                await sleep(150);
            }
        }
        console.log(`\n=== 结果：${ROUNDS} 轮，异常 ${anomalies} 次 ===`);
    } catch (e) {
        console.log('探针异常: ' + String(e?.stack ?? e).slice(0, 500));
        anomalies++;
    } finally {
        try { await RC('clear ' + NAME); } catch { /* ignore */ }
        try { bot.quit(); } catch { /* ignore */ }
        setTimeout(() => process.exit(anomalies === 0 ? 0 : 1), 500);
    }
});
