// 单元验证：goToPlayer 在距离 > 40 格时是否调用 hopTo（不需要真联机）。
// 用假的 bot 对象 + 假的地图，检查调用链。
import { goToPlayer } from '../src/agent/library/flow_follow.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

// 假 bot：position 在原点，玩家在 100 格外
const calls = [];
const fakeBot = {
    username: 'probe',
    entity: { position: { x: 0, y: 64, z: 0, distanceTo: (p) => Math.hypot(p.x, p.z) } },
    players: { leader: { entity: { position: { x: 100, y: 64, z: 0 } } } },
    interrupt_code: false,
    mode: 'survival',
    game: { dimension: 'overworld' },
    registry: { blocksByName: {} },
    pathfinder: {
        setMovements: () => { },
        setGoal: () => { },
        goto: async () => { throw new Error('no path'); },
        stop: () => { },
    },
    entity_ok: true,
};

// 让 distanceTo 正常工作
fakeBot.entity.position.distanceTo = (p) => Math.hypot(p.x - 0, p.z - 0);

const events = [];
try {
    await goToPlayer(fakeBot, 'leader', { distance: 3, mapDir: './bots/probe/map-goto', onEvent: e => events.push(e) });
} catch (e) {
    // 假 bot 会在 hopTo 内部失败，这没关系——我们只验证「有没有尝试 hop」
}

const hopStart = events.find(e => e.type === 'hop_start');
console.log('  事件:', events.map(e => e.type).join(', ') || '(无)');
check('长距离（100 格）触发了 hop_start', !!hopStart, hopStart ? `${hopStart.dist} 格` : '没触发');

// 近距离（10 格）不应触发
const calls2 = [];
const nearBot = {
    ...fakeBot,
    players: { leader: { entity: { position: { x: 10, y: 64, z: 0 } } } },
    entity: { position: { x: 0, y: 64, z: 0, distanceTo: (p) => Math.hypot(p.x, p.z) } },
};
const events2 = [];
try {
    await goToPlayer(nearBot, 'leader', { distance: 3, mapDir: './bots/probe/map-goto', onEvent: e => events2.push(e) });
} catch { /* ignore */ }
check('近距离（10 格）不触发 hop_start', !events2.find(e => e.type === 'hop_start'),
    events2.map(e => e.type).join(',') || '(无)');

// 没传 mapDir 时完全不该走 hop
const events3 = [];
try {
    await goToPlayer(fakeBot, 'leader', { distance: 3, onEvent: e => events3.push(e) });
} catch { /* ignore */ }
check('未传 mapDir 时不走 hop（回退到原逻辑）', !events3.find(e => e.type === 'hop_start'),
    events3.map(e => e.type).join(',') || '(无)');

console.log(`\n合计 ${passed} PASS / ${failed} FAIL`);
process.exit(failed ? 1 : 0);
