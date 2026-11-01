// 主世界真实地形 S1：跟着走 90 秒，判据「跟丢>8格且>3秒 的次数 ≤ 1」。
// 上一版卡住的原因：pathfinder.goto 用 Promise.race 超时后仍在跑，与 follow 抢 pathfinder。
// 这版给 leader 用自己的 pathfinder（独立 bot 实例），并给整体加硬上限。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { follow, ensureTracking } from '../src/agent/library/flow_follow.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });

const mk = (username) => {
    const b = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username, auth: 'offline', version: '1.21.8' });
    b.loadPlugin(pf.pathfinder);
    b.on('error', () => { });
    b.on('kicked', (r) => console.log(`${username} KICKED`, String(r).slice(0, 80)));
    return b;
};

const leader = mk('leader');
const probe = mk('probe');
const waitSpawn = (b) => new Promise(res => b.once('spawn', res));

(async () => {
    await Promise.all([waitSpawn(leader), waitSpawn(probe)]);
    await sleep(2000);
    await RC('op leader'); await RC('op probe');
    await sleep(400);
    ensureTracking(probe);

    const p0 = leader.entity.position.floored();
    const pts = [[12, 0], [12, 12], [0, 12], [0, 0], [-12, 0], [-12, -12], [0, -12], [0, 0]];

    const lost = [];
    let lostSince = null;
    const sampler = setInterval(() => {
        const ent = probe.players.leader?.entity;
        if (!ent) return;
        const d = probe.entity.position.distanceTo(ent.position);
        if (d > 8) { if (lostSince === null) lostSince = Date.now(); }
        else if (lostSince !== null) { lost.push(Date.now() - lostSince); lostSince = null; }
    }, 250);

    const followPromise = follow(probe, 'leader', { distance: 3 });

    const t0 = Date.now();
    let i = 0;
    while (Date.now() - t0 < 90000 && i < pts.length) {
        const [dx, dz] = pts[i++];
        const goal = new pf.goals.GoalNear(p0.x + dx, p0.y, p0.z + dz, 2);
        await Promise.race([
            leader.pathfinder.goto(goal).catch(() => { }),
            sleep(12000),
        ]);
        leader.pathfinder.setGoal(null);   // 超时后停住，别留着继续抢
    }

    clearInterval(sampler);
    if (lostSince !== null) lost.push(Date.now() - lostSince);
    probe.interrupt_code = true;
    await followPromise.catch(() => { });

    const bad = lost.filter(ms => ms > 3000);
    const dur = ((Date.now() - t0) / 1000).toFixed(0);
    const ok = bad.length <= 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  S1 主世界跟随 90s  路线=${dur}s 跟丢次数=${lost.length} 其中>3秒=${bad.length}` +
        (bad.length ? `（${bad.map(b => (b / 1000).toFixed(1) + 's').join(',')}）` : ''));
    console.log(`\n合计 ${ok ? 1 : 0} PASS / ${ok ? 0 : 1} FAIL`);
    leader.quit(); probe.quit();
    process.exit(ok ? 0 : 1);
})();
