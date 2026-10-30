// 接线验收：确认 !followPlayer / !goToPlayer 在 companion_mode 下走新实现，
// 并且返回值经 formatActionResult 变成一行。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import settings from '../settings.js';
import { setSettings } from '../src/agent/settings.js';
import { getCommand } from '../src/agent/commands/index.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

const mk = (username) => {
    const b = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username, auth: 'offline', version: '1.21.8' });
    b.loadPlugin(pf.pathfinder);
    b.on('error', (e) => console.log(`${username} ERR`, e.message));
    return b;
};

const leader = mk('leader');
const probe = mk('probe');

function waitSpawn(bot) { return new Promise((res) => bot.once('spawn', res)); }

function fakeAgent(bot) {
    return {
        bot,
        actions: {
            async runAction(label, fn) {
                const value = await fn();
                return { success: true, message: '', interrupted: false, timedout: false, value };
            },
        },
    };
}

(async () => {
    // 真机上 agent 初始化时会 setSettings(全局 settings)，这里模拟同样的顺序
    setSettings(settings);
    await Promise.all([waitSpawn(leader), waitSpawn(probe)]);
    await sleep(1200);
    await rcon('op leader');
    await rcon('op probe');
    await rcon('tp leader 6 -60 6');
    await rcon('tp probe 0 -60 0');
    await sleep(600);

    check('companion_mode 已开启', settings.companion_mode === true, String(settings.companion_mode));

    const followAct = getCommand('!followPlayer');
    const goAct = getCommand('!goToPlayer');
    check('两个命令都存在', !!followAct && !!goAct);

    // followPlayer：跑 4 秒后打断
    const agent = fakeAgent(probe);
    const p = followAct.perform(agent, 'leader', 3);
    await sleep(4000);
    const d1 = probe.players.leader?.entity ? probe.entity.position.distanceTo(probe.players.leader.entity.position) : -1;
    probe.interrupt_code = true;
    const out = await p;
    probe.interrupt_code = false;
    check('followPlayer 走新实现（返回一行结果）', typeof out === 'string' && out.startsWith('followPlayer:'), `out=${out}`);
    check('followPlayer 期间确实靠近了', d1 >= 0 && d1 < 8, `dist=${d1.toFixed(1)}`);

    // goToPlayer：目标就在旁边，应返回 OK
    const out2 = await goAct.perform(agent, 'leader', 3);
    check('goToPlayer 走新实现', typeof out2 === 'string' && out2.startsWith('goToPlayer:'), `out=${out2}`);
    check('goToPlayer 返回 OK', /goToPlayer: OK/.test(out2), out2);

    console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
    leader.quit(); probe.quit();
    process.exit(failed ? 1 : 0);
})();
