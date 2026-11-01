/**
 * 输入原子单测 —— atom_input_move / atom_input_mouse / atom_input_misc / atom_read。
 *
 * 锁的是 docs/architecture/01_primitives.md §2 的四条规矩，不是"我觉得"：
 *   A1 只有一个出口（别的文件不许直接 `bot.setControlState` / `bot.chat('/…')`）
 *   A3 入口与等待中都查 `interrupt_code`，中断返回 INTERRUPTED（D16 / D21 / D22）
 *   A7 按下的键在**所有**退出路径上松开（失败、超时、中断都要松）
 *
 * 为什么这些用例必须离线：假 bot 能直接看到"到底按了哪个键、松没松、发了什么字符串"，
 * 真机只看得到"她没爬上去"，分不清是被打断没松键，还是压根没按。
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import { makeFakeBot, worldOf } from './fixtures/fake_bot.mjs';
import { holdKey, pressKey, releaseAll, setSneak } from '../src/agent/library/atom_input_move.js';
import { holdDig, useOnBlock, placeAgainst, attackOnce } from '../src/agent/library/atom_input_mouse.js';
import { command, say, checkCommand } from '../src/agent/library/atom_input_misc.js';
import { selectSlot, clickSlot, dropSlot, closeWindow, HOTBAR_SLOTS } from '../src/agent/library/atom_input_inventory.js';
import { blockAt, pose, inventory, isEmptyName } from '../src/agent/library/atom_read.js';
import { climbUp } from '../src/agent/library/atom_climb.js';
import { pillarUpOnce } from '../src/agent/library/atom_pillar.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${actual}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── 1. holdKey：判据成立就松键（A7）────────────────────────────────────
{
    const bot = makeFakeBot({ feet: { x: 0, y: 64, z: 0 } });
    let seenPressed = false;
    const r = await holdKey(bot, 'jump', {
        until: () => { seenPressed = bot.__controls.get('jump') === true; return true; },
        timeout: 2000,
        intervalMs: 20,
    });
    const released = bot.__controls.get('jump') !== true;
    if (r.ok && r.data.reason === 'until' && seenPressed && released) {
        okCase('holdKey 按住→判据成立→松开', `heldMs=${r.data.heldMs} keys=${JSON.stringify(r.data.keys)}`);
    } else {
        badCase('holdKey 按住→判据成立→松开', JSON.stringify({ ok: r.ok, seenPressed, released, controls: [...bot.__controls.keys()] }));
    }
}

// ── 2. holdKey：到时也松键，且报 TIMEOUT（不是静默成功）────────────────
{
    const bot = makeFakeBot({});
    const r = await holdKey(bot, ['forward', 'jump'], { until: () => false, timeout: 120, intervalMs: 20 });
    const released = !bot.__controls.get('forward') && !bot.__controls.get('jump');
    if (!r.ok && r.code === 'TIMEOUT' && released) {
        okCase('holdKey 超时松键并报 TIMEOUT', `heldMs=${r.data.heldMs}`);
    } else {
        badCase('holdKey 超时松键并报 TIMEOUT', JSON.stringify({ code: r.code, controls: [...bot.__controls.keys()] }));
    }
}

// ── 3. holdKey：中断 → INTERRUPTED，150ms 内返回且松键（A3 / D16）──────
{
    const bot = makeFakeBot({});
    const t0 = Date.now();
    const p = holdKey(bot, 'jump', { until: () => false, timeout: 5000, intervalMs: 20 });
    await sleep(60);
    bot.interrupt_code = true;
    const r = await p;
    const ms = Date.now() - t0;
    const released = bot.__controls.get('jump') !== true;
    if (!r.ok && r.code === 'INTERRUPTED' && ms < 150 + 60 && released) {
        okCase('holdKey 中断即返回（不等超时）', `${ms}ms code=${r.code}`);
    } else {
        badCase('holdKey 中断即返回（不等超时）', JSON.stringify({ ms, code: r.code, controls: [...bot.__controls.keys()] }));
    }
}

// ── 4. holdKey：入口就是中断态 → 一个键都不许按 ────────────────────────
{
    const bot = makeFakeBot({});
    bot.interrupt_code = 'stop';
    const r = await holdKey(bot, 'forward', { until: () => true, timeout: 1000 });
    const pressed = bot.__controls.size;
    if (!r.ok && r.code === 'INTERRUPTED' && pressed === 0) {
        okCase('holdKey 入口查中断，不按键', `controls=${pressed}`);
    } else {
        badCase('holdKey 入口查中断，不按键', JSON.stringify({ code: r.code, controls: pressed }));
    }
}

// ── 5. pressKey：固定时长算正常结束（不是 TIMEOUT）─────────────────────
{
    const bot = makeFakeBot({});
    const r = await pressKey(bot, 'forward', 80);
    const released = bot.__controls.get('forward') !== true;
    if (r.ok && released) okCase('pressKey 到时松开且算成功', `heldMs=${r.data.heldMs}`);
    else badCase('pressKey 到时松开且算成功', JSON.stringify({ ok: r.ok, code: r.code, controls: [...bot.__controls.keys()] }));
}

// ── 6. releaseAll：定向松 / 全松 ────────────────────────────────────────
{
    const bot = makeFakeBot({});
    bot.setControlState('forward', true);
    bot.setControlState('jump', true);
    await releaseAll(bot, ['forward']);
    const onlyForwardReleased = !bot.__controls.get('forward') && bot.__controls.get('jump') === true;
    await releaseAll(bot);
    const allReleased = bot.__controls.size === 0;
    if (onlyForwardReleased && allReleased) okCase('releaseAll 定向松 / 全松', 'forward 单松后 jump 仍在，全松后 0 键');
    else badCase('releaseAll 定向松 / 全松', JSON.stringify({ onlyForwardReleased, allReleased, left: [...bot.__controls.keys()] }));
}

// ── 7. setSneak：直接置位 ──────────────────────────────────────────────
{
    const bot = makeFakeBot({});
    await setSneak(bot, true);
    const on = bot.__controls.get('sneak') === true;
    await setSneak(bot, false);
    const off = bot.__controls.get('sneak') !== true;
    if (on && off) okCase('setSneak 开/关', 'on=true off=true');
    else badCase('setSneak 开/关', JSON.stringify({ on, off }));
}

// ── 8. command()：白名单（ride 放行 / op 拒绝 / tp 要 cheat 标记）───────
{
    const bot = makeFakeBot({});
    const ride = await command(bot, 'ride', [bot.username, 'mount', 7]);
    const op = await command(bot, 'op', ['someone']);
    const tpNoCheat = await command(bot, 'tp', ['@s', 1, 2, 3]);
    const tpCheat = await command(bot, 'tp', ['@s', 1, 2, 3], { cheat: true });
    const chats = bot.__chats.join(' | ');
    const rideOk = ride.ok && chats.includes(`/ride ${bot.username} mount 7`);
    const opBlocked = !op.ok && op.code === 'NO_PERMISSION';
    const tpGated = !tpNoCheat.ok && tpNoCheat.code === 'NO_PERMISSION';
    const tpOk = tpCheat.ok && chats.includes('/tp @s 1 2 3');
    if (rideOk && opBlocked && tpGated && tpOk) {
        okCase('command 白名单（ride 放行 / op 拒绝 / tp 需 cheat）', `chats=${chats}`);
    } else {
        badCase('command 白名单', JSON.stringify({ rideOk, opBlocked, tpGated, tpOk, chats }));
    }
}

// ── 8b. 等级判定（表在 permissions.js，唯一的真相）─────────────────────
//   主人能跑作弊命令；信任级跑作弊命令被拒；/ride 信任级可用；/skin 按表判（owner）。
{
    const botOwner = makeFakeBot({});
    const botTrusted = makeFakeBot({});
    const ownerTp = await command(botOwner, 'tp', ['@s', 1, 2, 3], { cheat: true, level: 'owner' });
    const trustedTp = await command(botTrusted, 'tp', ['@s', 1, 2, 3], { cheat: true, level: 'trusted' });
    const trustedRide = await command(botTrusted, 'ride', [botTrusted.username, 'dismount'], { level: 'trusted' });
    const trustedSkin = await command(botTrusted, 'skin', ['clear'], { level: 'trusted' });
    const ownerSkin = await command(botOwner, 'skin', ['clear'], { level: 'owner' });
    const trustedCheatNoFlag = await command(botTrusted, 'fill', ['0', '0', '0', '1', '1', '1', 'stone'], { level: 'trusted' });
    const ok_ = ownerTp.ok
        && !trustedTp.ok && trustedTp.code === 'NO_PERMISSION'
        && trustedRide.ok
        && !trustedSkin.ok && trustedSkin.code === 'NO_PERMISSION'
        && ownerSkin.ok
        && !trustedCheatNoFlag.ok;
    if (ok_) {
        okCase('等级：owner 可 /tp，trusted 被拒；/ride 信任级可用；/skin 只给 owner',
            `ownerTp=${ownerTp.ok} trustedTp=${trustedTp.code} ride=${trustedRide.ok} trustedSkin=${trustedSkin.code}`);
    } else {
        badCase('等级：owner 可 /tp，trusted 被拒；/ride 信任级可用；/skin 只给 owner',
            JSON.stringify({ ownerTp: ownerTp.ok, trustedTp: trustedTp.code, ride: trustedRide.ok, tSkin: trustedSkin.code, oSkin: ownerSkin.ok, noFlag: trustedCheatNoFlag.code }));
    }
}

// ── 9. checkCommand 与 command 用同一套判据（不会一边松一边严）───────────
{
    const a = checkCommand('fill', { cheat: true });
    const b = checkCommand('fill', {});
    const c = checkCommand('nonsense_command', { cheat: true });
    if (a.allowed && !b.allowed && !c.allowed) {
        okCase('checkCommand 与 command 同判据', `fill(cheat)=${a.why} fill(no)=${b.why}`);
    } else {
        badCase('checkCommand 与 command 同判据', JSON.stringify({ a, b, c }));
    }
}

// ── 10. say()：拒绝以 / 开头的文本（M1 那条"回复变命令"）───────────────
{
    const bot = makeFakeBot({});
    const bad = await say(bot, '/op someone');
    const badMultiline = await say(bot, '你好\n/op someone');
    const good = await say(bot, '你好呀');
    if (!bad.ok && bad.code === 'NO_PERMISSION' && !badMultiline.ok && good.ok && bot.__chats.length === 1) {
        okCase('say 拦截以 / 开头（含多行藏一条）', `chats=${JSON.stringify(bot.__chats)}`);
    } else {
        badCase('say 拦截以 / 开头（含多行藏一条）', JSON.stringify({ bad: bad.code, multi: badMultiline.code, good: good.ok, chats: bot.__chats }));
    }
}

// ── 11. holdDig：正常挖完 → ok + dugBlock；且键/动作不残留 ─────────────
{
    const bot = makeFakeBot({
        world: worldOf([[1, 64, 0, 'stone']]),
        feet: { x: 0, y: 64, z: 0 },
    });
    const block = bot.blockAt({ x: 1, y: 64, z: 0 });
    const r = await holdDig(bot, block, { digTimeMs: 1000 });
    const dug = bot.__dug.length === 1;
    if (r.ok && r.data.dugBlock === 'stone' && dug) okCase('holdDig 挖完报 dugBlock', `costMs=${r.data.costMs}`);
    else badCase('holdDig 挖完报 dugBlock', JSON.stringify({ ok: r.ok, code: r.code, data: r.data, dug: bot.__dug }));
}

// ── 12. holdDig：挖不动 → TIMEOUT 且调了 stopDigging（不许一直举着手）──
{
    let stopped = 0;
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        world: worldOf([[1, 64, 0, 'stone']]),
        stubs: {
            dig: () => new Promise(() => { }),          // 永不 resolve：模拟"卡住"
            stopDigging: () => { stopped++; },
        },
    });
    const block = bot.blockAt({ x: 1, y: 64, z: 0 });
    const t0 = Date.now();
    const r = await holdDig(bot, block, { digTimeMs: 150 });
    const ms = Date.now() - t0;
    if (!r.ok && r.code === 'TIMEOUT' && stopped === 1 && ms < 400) {
        okCase('holdDig 超时收尾（stopDigging 一次）', `${ms}ms`);
    } else {
        badCase('holdDig 超时收尾（stopDigging 一次）', JSON.stringify({ code: r.code, ms, stopped }));
    }
}

// ── 13. holdDig：挖的中途被取消 → INTERRUPTED（D21）────────────────────
{
    let stopped = 0;
    const bot = makeFakeBot({
        feet: { x: 0, y: 64, z: 0 },
        world: worldOf([[1, 64, 0, 'stone']]),
        stubs: { dig: () => new Promise(() => { }), stopDigging: () => { stopped++; } },
    });
    const block = bot.blockAt({ x: 1, y: 64, z: 0 });
    const p = holdDig(bot, block, { digTimeMs: 5000 });
    await sleep(60);
    bot.interrupt_code = true;
    const r = await p;
    if (!r.ok && r.code === 'INTERRUPTED' && stopped === 1) {
        okCase('holdDig 中断即返回 INTERRUPTED', `stopped=${stopped}`);
    } else {
        badCase('holdDig 中断即返回 INTERRUPTED', JSON.stringify({ code: r.code, stopped }));
    }
}

// ── 14. placeAgainst：保留 blockUpdate 的超时语义（区分"丢包"和"被挡"）──
{
    const errBot = makeFakeBot({
        stubs: { placeBlock: async () => { throw new Error('blockUpdate did not fire within timeout of 5s'); } },
    });
    const ref = { name: 'stone', position: { x: 0, y: 63, z: 0 } };
    const r1 = await placeAgainst(errBot, ref, { x: 0, y: 1, z: 0 });
    const blockedBot = makeFakeBot({
        stubs: { placeBlock: async () => { throw new Error('entity is in the way, occupied'); } },
    });
    const r2 = await placeAgainst(blockedBot, ref, { x: 0, y: 1, z: 0 });
    if (!r1.ok && r1.code === 'TIMEOUT' && r1.data.blockUpdateMissed === true
        && !r2.ok && r2.code === 'INTERNAL' && /occupied/.test(r2.message)) {
        okCase('placeAgainst 保留 blockUpdate 语义', `r1=${r1.code} r2=${r2.code}`);
    } else {
        badCase('placeAgainst 保留 blockUpdate 语义', JSON.stringify({ r1: { c: r1.code, d: r1.data }, r2: { c: r2.code, m: r2.message } }));
    }
}

// ── 15. useOnBlock / attackOnce：真的调了那个 bot 接口 ──────────────────
{
    let activated = 0, attacked = 0;
    const bot = makeFakeBot({
        stubs: {
            activateBlock: async () => { activated++; },
            attack: () => { attacked++; },
        },
    });
    const block = { name: 'oak_door', position: { x: 0, y: 64, z: 0 } };
    const u = await useOnBlock(bot, block, { timeout: 500 });
    const a = await attackOnce(bot, { name: 'zombie', id: 1 });
    if (u.ok && u.data.activatedBlock === 'oak_door' && a.ok && activated === 1 && attacked === 1) {
        okCase('useOnBlock / attackOnce 只发一次输入', `activated=${activated} attacked=${attacked}`);
    } else {
        badCase('useOnBlock / attackOnce 只发一次输入', JSON.stringify({ u: u.data, a: a.ok, activated, attacked }));
    }
}

// ── 16. atom_read：未加载返回 null（不是 air），且读函数不抛 ────────────
{
    const bot = makeFakeBot({ world: worldOf([[0, 63, 0, 'stone']]), feet: { x: 0, y: 64, z: 0 } });
    const loaded = blockAt(bot, { x: 0, y: 63, z: 0 });
    const unloaded = blockAt(bot, { x: 5, y: 63, z: 5 });
    const p = pose(bot);
    const inv = inventory(bot);
    let threw = false;
    try { blockAt(bot, null); } catch { threw = true; }
    if (loaded?.name === 'stone' && unloaded === null && p && Array.isArray(inv) && !threw && !isEmptyName('stone')) {
        okCase('atom_read 未加载返回 null 且不抛', `loaded=${loaded.name} unloaded=${unloaded}`);
    } else {
        badCase('atom_read 未加载返回 null 且不抛', JSON.stringify({ loaded: loaded?.name, unloaded, p, threw }));
    }
}

// ── 17. atom_climb.climbUp：中断不到超时就返回，且 jump 已松开（D16 本体）──
{
    const bot = makeFakeBot({
        world: worldOf([[0, 64, 0, 'ladder'], [0, 65, 0, 'ladder'], [0, 66, 0, 'air']]),
        feet: { x: 0, y: 64, z: 0 },
    });
    const t0 = Date.now();
    const p = climbUp(bot, { steps: 1, timeout: 3000 });
    await sleep(120);
    bot.interrupt_code = 'stop';
    const r = await p;
    const ms = Date.now() - t0;
    const released = bot.__controls.get('jump') !== true;
    if (!r.ok && r.code === 'INTERRUPTED' && released && ms < 600) {
        okCase('climbUp 中断即返回（D16：不再按住跳到超时）', `${ms}ms`);
    } else {
        badCase('climbUp 中断即返回（D16：不再按住跳到超时）', JSON.stringify({ code: r.code, ms, released, message: r.message }));
    }
}

// ── 18. atom_pillar：跳不上去时 jump 也要松开（失败路径同样 A7）────────
{
    const bot = makeFakeBot({
        world: worldOf([[0, 63, 0, 'stone']]),
        feet: { x: 0, y: 64, z: 0 },
        items: [{ name: 'cobblestone', type: 1, count: 5, slot: 0 }],
    });
    const r = await pillarUpOnce(bot, { item: 'cobblestone', settleMs: 30 });
    const released = bot.__controls.get('jump') !== true;
    if (!r.ok && r.code === 'STUCK' && released) {
        okCase('pillarUpOnce 失败路径松键', `code=${r.code}`);
    } else {
        badCase('pillarUpOnce 失败路径松键', JSON.stringify({ code: r.code, released, controls: [...bot.__controls.keys()] }));
    }
}

// ── 19. atom_input_inventory：切格越界拒绝 / 正常切格 ────────────────────
{
    let setTo = null;
    const bot = makeFakeBot({ stubs: { setQuickBarSlot: (i) => { setTo = i; } } });
    const bad = await selectSlot(bot, HOTBAR_SLOTS);      // 越界
    const neg = await selectSlot(bot, -1);
    const good = await selectSlot(bot, 3);
    if (!bad.ok && bad.code === 'NO_TARGET' && !neg.ok && good.ok && setTo === 3) {
        okCase('selectSlot 越界拒绝 / 正常切格', `slot=${good.data.slot}`);
    } else {
        badCase('selectSlot 越界拒绝 / 正常切格', JSON.stringify({ bad: bad.code, neg: neg.code, good: good.ok, setTo }));
    }
}

// ── 20. atom_input_inventory：没窗口时报 WINDOW_CLOSED；有窗口按参数点击 ──
{
    const bot = makeFakeBot({});
    bot.currentWindow = null;
    const r = await clickSlot(bot, 5);
    const calls = [];
    const bot2 = makeFakeBot({ stubs: { clickWindow: async (slot, button, mode) => { calls.push([slot, button, mode]); } } });
    bot2.currentWindow = { slots: [] };
    const ok2 = await clickSlot(bot2, 5, { button: 1, mode: 2 });
    if (!r.ok && r.code === 'WINDOW_CLOSED' && ok2.ok && calls.length === 1
        && calls[0][0] === 5 && calls[0][1] === 1 && calls[0][2] === 2) {
        okCase('clickSlot 无窗口报 WINDOW_CLOSED、有窗口按参数点击', `calls=${JSON.stringify(calls)}`);
    } else {
        badCase('clickSlot 无窗口报 WINDOW_CLOSED、有窗口按参数点击', JSON.stringify({ code: r.code, ok2: ok2.ok, calls }));
    }
}

// ── 21. atom_input_inventory：dropSlot = clickWindow(slot, all?1:0, 4) ──
{
    const calls = [];
    const bot = makeFakeBot({ stubs: { clickWindow: async (slot, button, mode) => { calls.push([slot, button, mode]); } } });
    bot.currentWindow = { slots: [] };
    await dropSlot(bot, 7, false);
    await dropSlot(bot, 7, true);
    const okShape = calls.length === 2 && calls[0].join(',') === '7,0,4' && calls[1].join(',') === '7,1,4';
    if (okShape) okCase('dropSlot 的 button/mode 组合（Q 键语义）', JSON.stringify(calls));
    else badCase('dropSlot 的 button/mode 组合（Q 键语义）', JSON.stringify(calls));
}

// ── 22. atom_input_inventory：closeWindow 幂等且转出 closeContainer ──
{
    let closed = 0;
    const bot = makeFakeBot({ stubs: { closeWindow: () => { closed++; } } });
    const none = await closeWindow(bot);
    bot.currentWindow = { slots: [] };
    const some = await closeWindow(bot);
    if (none.ok && none.data.closed === false && some.ok && some.data.closed === true && closed === 1) {
        okCase('closeWindow 幂等且转出 closeContainer', `closed调用=${closed}`);
    } else {
        badCase('closeWindow 幂等且转出 closeContainer', JSON.stringify({ none: none.data, some: some.data, closed }));
    }
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
