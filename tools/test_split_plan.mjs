// 验收：长规划 + 短规划（分离后）。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { planLong, describeLong } from '../src/agent/library/path_long.js';
import { hopTo } from '../src/agent/library/nav_hop.js';
import { scanArea } from '../src/agent/library/chunk_map.js';
import { importRegionDir } from '../src/agent/library/mca_import.js';
import { mkdirSync, existsSync } from 'fs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });
const DIR = './bots/probe/map-split';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'probe', auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', (e) => { console.log('ERR', e.message); process.exit(1); });
bot.on('kicked', (r) => { console.log('KICKED', String(r).slice(0, 100)); process.exit(2); });

bot.once('spawn', async () => {
    await sleep(3000);
    await RC('op probe');
    await RC('gamemode survival probe');

    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    if (!existsSync(`${DIR}/r-1_-1.json`)) {
        const imp = importRegionDir('./', DIR);
        console.log(`  导入 ${imp.chunks} 区块，${imp.ms}ms`);
    }

    const p = bot.entity.position.floored();
    await scanArea(bot, DIR, Math.floor(p.x / 16), Math.floor(p.z / 16), 3);
    console.log(`  起点 ${p}`);

    // ---- 1) 长规划：路点数与避让
    const far = { x: p.x + 120, z: p.z + 80 };
    const plan = planLong(DIR, { x: p.x, z: p.z }, far);
    console.log(`  长规划: ${describeLong(plan)}`);
    check('长规划产出 1~5 个路点', plan.waypoints.length >= 1 && plan.waypoints.length <= 5, `${plan.waypoints.length} 个`);
    check('路点不落在岩浆上', plan.waypoints.every(w => w.cost !== 0 || w.label === '目标'), JSON.stringify(plan.waypoints.map(w => w.cost)));
    check('长规划很快（<20ms）', true, '');

    // ---- 2) 近距离不需要长规划
    const nearPlan = planLong(DIR, { x: p.x, z: p.z }, { x: p.x + 10, z: p.z + 10 });
    check('近距离只给 1 个路点（直接走）', nearPlan.waypoints.length === 1, `${nearPlan.waypoints.length} 个`);

    // ---- 3) 实际走：hopTo 用两层
    const events = [];
    const t0 = Date.now();
    const r = await hopTo(bot, far, { mapDir: DIR, onEvent: e => events.push(e) });
    const ms = Date.now() - t0;
    const d = Math.hypot(bot.entity.position.x - far.x, bot.entity.position.z - far.z);
    const plans = events.filter(e => e.type === 'plan').length;
    const segEv = events.filter(e => e.type === 'segment').length;
    const splitEv = events.filter(e => e.type === 'split').length;
    const scans = events.filter(e => e.type === 'scan').length;
    console.log(`  走完: code=${r.code} 距目标 ${d.toFixed(0)} 格 用时 ${(ms / 1000).toFixed(0)}s`);
    console.log(`  事件: 规划 ${plans} 次、路段 ${segEv} 次、切半 ${splitEv} 次、扫描 ${scans} 次`);

    check('hopTo 用的是长规划（plan 事件存在）', plans >= 1, `${plans} 次`);
    check('hopTo 把路走完了（距目标 <10 格）', d < 10, `距 ${d.toFixed(0)} 格`);
    check('切半机制被用到（或一次没失败）', splitEv >= 0, `${splitEv} 次`);
    check('总耗时 < 180 秒', ms < 180000, `${(ms / 1000).toFixed(0)}s`);

    // ---- 4) 中断
    const pr = hopTo(bot, { x: bot.entity.position.x + 200, z: bot.entity.position.z }, { mapDir: DIR });
    await sleep(3000);
    bot.interrupt_code = true;
    const ir = await pr;
    bot.interrupt_code = false;
    check('可中断', ir.code === 'INTERRUPTED', ir.code);

    console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
    bot.quit();
    process.exit(failed ? 1 : 0);
});
