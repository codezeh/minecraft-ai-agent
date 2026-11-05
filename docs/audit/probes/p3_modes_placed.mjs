// P3-2（修正版）：触发 modes.js:118 的 `if (placed)`。
// 关键发现：modes.js:466 的 execute() 用 try/catch 包住 func，
// 所以 ReferenceError 不会崩进程，只会被 console.warn 吞成 "Mode X threw: ..."。
// 运行：node docs/audit/probes/p3_modes_placed.mjs
import * as modes from '../../../mindcraft/src/agent/modes.js';

const mkPos = (x, y, z) => ({
    x, y, z,
    offset: (dx = 0, dy = 0, dz = 0) => mkPos(x + dx, y + dy, z + dz),
    distanceTo: () => 1.5, distanceToSquared: () => 2.25,
    floored: () => mkPos(x, y, z), clone: () => mkPos(x, y, z),
    plus: () => mkPos(x, y, z), minus: () => mkPos(x, y, z),
});

const warns = [];
const origWarn = console.warn;
console.warn = (...a) => { warns.push(a.map(String).join(' ')); };

const agent = {
    name: 'probe',
    isIdle: () => true,
    task: null,
    shut_up: false,
    bot: {
        entity: {
            position: Object.assign(
                { x: 0, y: 64, z: 0 },
                {
                    offset: (dx = 0, dy = 0, dz = 0) => mkPos(dx, 64 + dy, dz),
                    distanceTo: () => 1.5, distanceToSquared: () => 2.25,
                    floored: () => mkPos(0, 64, 0), clone: () => mkPos(0, 64, 0),
                    plus: () => mkPos(0, 64, 0), minus: () => mkPos(0, 64, 0),
                }
            ),
            height: 1.6, yaw: 0, pitch: 0, onGround: true,
        },
        // 脚下与头顶都给 fire → 命中 modes.js:115 的"身上着火"分支
        blockAt: () => ({ name: 'fire', position: { x: 0, y: 64, z: 0 } }),
        inventory: {
            findInventoryItem: (n) => (n === 'water_bucket' ? { name: 'water_bucket', type: 1 } : null),
            items: () => [],
        },
        modes: {},
        pathfinder: { goal: null },
        health: 20, food: 20,
        game: { gameMode: 'survival', dimension: 'overworld' },
        heldItem: null,
        registry: {},
        equip: async () => { }, unequip: async () => { },
        lookAt: async () => { }, dig: async () => { },
        placeBlock: async () => { },
        blockAtCursor: () => null,
        activateBlock: async () => { },
        heldItem: null,
        setControlState() { }, clearControlStates() { },
        chat: (m) => origWarn('[stub chat]', m),
        username: 'probe', players: {}, entities: {},
        interrupt_code: false,
        time: { timeOfDay: 0 },
    },
    openChat: (m) => origWarn('[stub openChat]', m),
    // initModes 需要的
    prompter: { getInitModes: () => [], profile: {} },
    // execute() 需要的三件套
    self_prompter: { isActive: () => false, stopLoop() { } },
    actions: {
        currentActionLabel: '',
        resume_func: null,
        running: false,
        async runAction(label, fn) {
            await fn();                       // 直接跑，谁抛就抛给 execute 的 catch
            return { success: true, message: 'ok', interrupted: false, timedout: false };
        },
    },
};

try {
    await modes.initModes(agent);
    // modes.js:586 `async update()` 遍历 modes_list 并逐个 await mode.update(_agent)
    await agent.bot.modes.update();
    await new Promise(r => setTimeout(r, 800));
    console.log('=== 捕获到的 console.warn ===');
    warns.forEach(w => console.log('  ' + w.slice(0, 220)));
    const hit = warns.find(w => w.includes('placed is not defined'));
    const hit2 = warns.find(w => w.includes('walked is not defined'));
    console.log('\n判定：' + (hit ? '✅ 触发到 modes.js:118 `if (placed)` → ReferenceError（被 execute 吞掉）'
        : (hit2 ? '✅ 触发到 modes.js:133 `if (walked)`' : '❌ 没触发（见上面的 warn）')));
} catch (e) {
    console.log('探针本身出错：', e.name, e.message);
} finally {
    console.warn = origWarn;
}
