// B5 验收：follow + 找人。需要两个账号：leader（被跟）和 probe（跟）。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { follow, goToPlayer, ensureTracking } from '../src/agent/library/task_follow.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}
const RC = (c) => rcon(c);
const mk = (username) => {
    const b = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username, auth: 'offline', version: '1.21.8' });
    b.loadPlugin(pf.pathfinder);
    b.on('error', (e) => console.log(`${username} ERR`, e.message));
    b.on('kicked', (r) => console.log(`${username} KICKED`, r));
    return b;
};

const leader = mk('leader');
const probe = mk('probe');

function waitSpawn(bot) {
    return new Promise((res) => bot.once('spawn', res));
}

async function leaderWalkSquare() {
    const pts = [[15, 0], [15, 15], [0, 15], [0, 0]];
    for (const [x, z] of pts) {
        await leader.pathfinder.goto(new pf.goals.GoalNear(x, -60, z, 1)).catch(() => {});
    }
}

async function waitForEntity(bot, name, want = true, ms = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const has = !!bot.players?.[name]?.entity;
        if (has === want) return true;
        await sleep(200);
    }
    return false;
}

(async () => {
    await Promise.all([waitSpawn(leader), waitSpawn(probe)]);
    await sleep(1500);
    await RC('op leader');
    await RC('op probe');
    // 场景自洽：跟随要跑方阵，别让上一个套件留下的木板/坑挡路
    await RC('fill -6 -60 -6 20 -58 20 air');
    await RC('fill -6 -61 -6 20 -61 20 grass_block');
    await RC('tp leader 5 -60 5');
    await RC('tp probe 0 -60 0');
    await sleep(1200);
    ensureTracking(probe);

    // ---- 1) 边走边跟
    const events1 = [];
    const p1 = follow(probe, 'leader', { distance: 3, onEvent: e => events1.push(e) });
    const samples = [];
    const sampler = setInterval(() => {
        const ent = probe.players.leader?.entity;
        if (ent) samples.push(probe.entity.position.distanceTo(ent.position));
    }, 250);
    await leaderWalkSquare();
    clearInterval(sampler);
    probe.interrupt_code = true;
    await sleep(600);
    const r1 = await p1;
    probe.interrupt_code = false;

    const maxD = Math.max(...samples);
    const avgD = samples.reduce((a, b) => a + b, 0) / samples.length;
    check('1) 跟随：最大距离 ≤ 12', maxD <= 12, `max=${maxD.toFixed(1)} 样本=${samples.length}`);
    check('1b) 跟随：平均距离 ≤ 7', avgD <= 7, `avg=${avgD.toFixed(1)}`);
    check('1c) 中断后返回 INTERRUPTED', r1.code === 'INTERRUPTED', `code=${r1.code}`);

    // ---- 2) 瞬移 40 格，能追上
    const events2 = [];
    const p2 = follow(probe, 'leader', { distance: 3, onEvent: e => events2.push(e) });
    await sleep(400);
    await RC('tp leader 45 -60 5');
    await sleep(300);
    let catchUpMs = null;
    const t2 = Date.now();
    while (Date.now() - t2 < 20000) {
        const ent = probe.players.leader?.entity;
        if (ent && probe.entity.position.distanceTo(ent.position) < 5) { catchUpMs = Date.now() - t2; break; }
        await sleep(250);
    }
    probe.interrupt_code = true;
    await p2;
    probe.interrupt_code = false;
    check('2) 传送 40 格后追上（<5 格）', catchUpMs !== null, catchUpMs === null ? '20s 内未追上' : `${catchUpMs}ms`);

    // ---- 3) 立即打断
    probe.interrupt_code = false;
    const events3 = [];
    const p3 = follow(probe, 'leader', { distance: 3, onEvent: e => events3.push(e) });
    await sleep(1500);
    probe.interrupt_code = true;
    const r3 = await p3;
    check('3) 打断返回 INTERRUPTED', r3.code === 'INTERRUPTED', `code=${r3.code}`);
    check('3b) 触发 interrupted 事件', events3.some(e => e.type === 'interrupted'), JSON.stringify(events3.map(e => e.type)));
    probe.interrupt_code = false;

    // ---- 4) 跑到 190 格（实体消失）→ 走到最后位置 → 如实报告
    const events4 = [];
    const lastSeenAt = ensureTracking(probe).recall('leader');
    await RC('tp leader 190 -60 5');
    await waitForEntity(probe, 'leader', false, 8000);
    const p4 = follow(probe, 'leader', { distance: 3, onEvent: e => events4.push(e) });
    const r4 = await Promise.race([p4, sleep(40000).then(() => ({ code: 'HARNESS_TIMEOUT' }))]);
    check('4) 找不到人时返回 NO_TARGET', r4.code === 'NO_TARGET', `code=${r4.code} msg=${r4.message ?? ''}`);
    check('4b) 先 searching 再 found_nothing', events4.some(e => e.type === 'searching') && events4.some(e => e.type === 'found_nothing'),
        JSON.stringify(events4.map(e => e.type)));
    console.log(`        最后见到位置: ${lastSeenAt ? `(${lastSeenAt.x.toFixed(0)},${lastSeenAt.y.toFixed(0)},${lastSeenAt.z.toFixed(0)})` : 'null'}`);

    // ---- 5) 玩家下线
    leader.quit();
    await sleep(1500);
    const events5 = [];
    const r5 = await follow(probe, 'leader', { distance: 3, onEvent: e => events5.push(e) });
    check('5) 玩家下线返回 NO_TARGET', r5.code === 'NO_TARGET', `code=${r5.code} msg=${r5.message ?? ''}`);
    check('5b) 触发 offline 事件', events5.some(e => e.type === 'offline'), JSON.stringify(events5.map(e => e.type)));

    console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
    probe.quit();
    process.exit(failed ? 1 : 0);
})();
