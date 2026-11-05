// P3：逐个尝试"真的跑到那一行"，而不是靠读代码断言。
// 运行：node docs/audit/probes/p3_reference_errors.mjs
// 每个 case 都用 try/catch 捕获，打印真实的错误 name + message + 栈首行。
import * as modes from '../../../mindcraft/src/agent/modes.js';
import * as skills from '../../../mindcraft/src/agent/library/skills.js';

const R = [];
function rec(id, target, ran, err) {
    R.push({ id, target, ran, err: err ? `${err.name}: ${err.message}` : '(没有异常)' });
}

// ─────────── case 1: skills.js:5750 `return ok({steps,to})` ───────────
// 静态事实先钉住：ok 在 skills.js 里只作为"调用"出现一次，既没有 import 也没有模块级定义。
// 运行时：要走到 5750 必须 digTunnel 内 runSteps 返回 run.ok=true。
// 用 stub bot 让每一步都成功 → 看是否抛出 "ok is not defined"。
try {
    const stubBot = {
        entity: { position: { x: 0, y: 64, z: 0, offset: () => ({ x: 0, y: 65, z: 0 }) } },
        interrupt_code: false,
        blockAt: () => ({ name: 'air', boundingBox: 'empty', position: { x: 0, y: 64, z: 0 } }),
        blockAtCursor: () => null,
        inventory: { items: () => [] },
        pathfinder: { goal: null, stop() { }, setGoal() { }, goto: async () => { } },
        stopDigging() { }, dig: async () => { },
        setControlState() { }, clearControlStates() { },
        chat() { console.log('[stub] chat:', arguments[0]); },
        emit() { }, on() { }, once() { },
        game: { dimension: 'overworld' },
        time: { timeOfDay: 0 },
        health: 20, food: 20,
        players: {},
        entities: {},
        username: 'probe',
        _client: { socket: null },
        collectBlock: { cancelTask() { } },
        pvp: { stop() { } },
        blockUpdate: () => { },
        waitForChunksToLoad: async () => { },
        lookAt: async () => { }, look: async () => { },
    };
    try {
        const r = await skills.digTunnel(stubBot, 1, 0, 1);
        rec('P3-1', 'skills.js:5750 return ok(...)', 'digTunnel 返回了', null);
        console.log('[P3-1] digTunnel 正常返回：', JSON.stringify(r).slice(0, 200));
    } catch (e) {
        rec('P3-1', 'skills.js:5750 return ok(...)', 'digTunnel 抛异常', e);
    }
} catch (e) {
    rec('P3-1', 'skills.js:5750 return ok(...)', 'import/构造失败', e);
}

// ─────────── case 2: modes.js:118 `if (placed)`（身上着火→水桶） ───────────
// 造一个 agent stub，让 blockAt 返回 fire，inventory 里有 water_bucket。
// initModes 会把 mode 表挂到 agent.bot.modes 上；然后直接调 self_preservation 的 update。
try {
    const stub = {
        bot: {
            entity: { position: { x: 0, y: 64, z: 0, offset: (dx, dy, dz) => ({ x: dx, y: 64 + dy, z: dz }) } },
            blockAt: (p) => ({ name: 'fire', position: { x: 0, y: 64, z: 0 } }),
            inventory: { findInventoryItem: () => ({ name: 'water_bucket', type: 0 }), items: () => [] },
            modes: {},
            pathfinder: { goal: null },
            health: 20, food: 20,
            chat: (m) => console.log('[stub chat]', m),
            username: 'probe', players: {}, entities: {},
            interrupt_code: false,
            time: { timeOfDay: 0 },
            setControlState() { }, clearControlStates() { },
        },
        openChat: (m) => console.log('[stub openChat]', m),
        name: 'probe',
    };
    // 让 skills.placeBlock 变成可控 stub（否则会去操作真 block）
    const origPlace = skills.placeBlock;
    try {
        await modes.initModes(stub);
        const list = stub.bot.modes.modes || stub.bot.modes.list || [];
        const arr = Array.isArray(list) ? list : Object.values(list);
        const sp = arr.find(m => m && m.name === 'self_preservation');
        if (!sp) {
            rec('P3-2', 'modes.js:118 if (placed)', 'initModes 后没找到 self_preservation', new Error(`keys=${Object.keys(stub.bot.modes)}`));
        } else {
            try {
                await sp.update(stub);
                // execute() 是异步排队，等一拍看它有没有在回调里炸
                await new Promise(r => setTimeout(r, 300));
                rec('P3-2', 'modes.js:118 if (placed)', 'update 调用完成', null);
            } catch (e) {
                rec('P3-2', 'modes.js:118 if (placed)', 'update 抛异常', e);
            }
        }
    } finally {
        skills.placeBlock = origPlace;
    }
} catch (e) {
    rec('P3-2', 'modes.js:118 if (placed)', 'initModes 失败', e);
}

console.log('\n=== P3 结果 ===');
for (const r of R) console.log(`${r.id.padEnd(6)} ${r.ran.padEnd(28)} ${r.err}`);
