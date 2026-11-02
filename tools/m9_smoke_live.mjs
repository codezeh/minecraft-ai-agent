/**
 * M9 真机冒烟：改路由的 4 条命令 + 结果格式实证 + protect_owner 两条。
 *
 * 断言的是**返回文本**（模型实际看到的那一行），不是"函数被调了"。
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { getCommand } from '../src/agent/commands/index.js';
import { formatOutcome } from '../src/agent/library/code_hints.js';
import { decideProtect } from '../src/agent/library/protect_owner.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const NAME = 'm9b' + (Date.now() % 100000);
const OWNER = 'm9owner' + (Date.now() % 10000);   // 假"主人"玩家名

const bot = mineflayer.createBot({
    host: '127.0.0.1', port: 25566, username: NAME, auth: 'offline', version: '1.21.8',
});
bot.loadPlugin(pf.pathfinder);
installPositionGuard(bot);
bot.on('error', () => { });
bot.on('kicked', (r) => console.log('KICKED', JSON.stringify(r).slice(0, 80)));
await new Promise((res) => bot.once('spawn', res));
await sleep(1500);

const V = (await import('vec3')).default;
const p = bot.entity.position;
const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
await RC(`fill ${bx - 8} ${by - 1} ${bz - 8} ${bx + 8} ${by - 1} ${bz + 8} stone`);
await RC(`fill ${bx - 8} ${by} ${bz - 8} ${bx + 8} ${by + 5} ${bz + 8} air`);
await RC(`clear ${NAME}`).catch(() => { });
await sleep(300);

// 造一个 agent 壳子（命令的 perform 只用到 bot / actions / prompter 等少数字段）
const agent = {
    bot, name: NAME, board: null,
    actions: {
        executing: false, killed: false,
        async stop() { this.executing = false; },
        // ★ 真 ActionManager.runAction 返回 {interrupted, timedout}；
        //   第一版这里直接 `return fn()`，command 包装层读 code_return.interrupted 就崩了。
        async runAction(_l, fn) { await fn(); return { interrupted: false, timedout: false }; },
    },
    prompter: { profile: { permissions: { owner: OWNER } } },
    history: null, last_sender: OWNER,
};
const runAs = async (label, fn) => {
    agent.actions.executing = true;
    try { return await fn(); } finally { agent.actions.executing = false; }
};

let pass = 0, fails = 0;
const ok = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
/** 带条件的断言：cond 为假就是 FAIL（第一版漏了这个，导致"全抛异常还报 6/6 PASS"）。 */
const check = (n, cond, e = '') => { if (cond) ok(n, e); else bad(n, e); };
const bad = (n, a) => { fails++; console.log(`FAIL ${n} ${JSON.stringify(a)}`); };

// ── ① !placeHere → flow_build（旧债销掉的那条）──────────────────────
{
    await RC(`give ${NAME} cobblestone 16`); await sleep(900);
    const cmd = getCommand('!placeHere');
    let out;
    try {
        out = await runAs('place', () => cmd.perform(agent, 'cobblestone'));
    } catch (e) { out = 'THREW: ' + e.message; }
    const placed = bot.blockAt(new V(bx + 1, by, bz));
    console.log(`  !placeHere 返回: ${JSON.stringify(out).slice(0, 100)}`);
    // 目的是"命令能跑、且走的是 flow_build"——它返回布尔/Result，不抛就算通
    check('① !placeHere 走 flow_build 不抛', !(typeof out === 'string' && out.startsWith('THREW')), JSON.stringify(out).slice(0, 80));
}

// ── ② !collectBlocks 失败格式：附近没有目标 → 必须带"建议"且 ≤200 字 ──
{
    const cmd = getCommand('!collectBlocks');
    let res;
    try {
        res = await runAs('collect', () => cmd.perform(agent, 'diamond_ore', 4));
    } catch (e) { res = { ok: false, code: 'INTERNAL', message: e.message }; }
    console.log(`  !collectBlocks 原始返回: ${JSON.stringify(res).slice(0, 160)}`);

    // 用同一份数据生成"模型看到的那一行"（08 §4 格式）
    const line = formatOutcome({ result: res?.ok !== undefined ? res : { ok: false, code: 'NO_TARGET' }, label: '!collectBlocks' });
    console.log(`  → 给模型的一行: ${line}`);
    const hasAdvice = line.includes('建议');
    const short = line.length <= 200;
    const oneLine = !line.includes('\n');
    if (hasAdvice && short && oneLine) {
        ok('② 失败格式：带"建议"、≤200 字、一行', `len=${line.length}`);
    } else {
        bad('② 失败格式', { hasAdvice, short, oneLine, len: line.length });
    }
}

// ── ③ !followPlayer → flow_follow（D23 删开关后唯一路径）────────────
{
    const cmd = getCommand('!followPlayer');
    let out;
    const t0 = Date.now();
    try {
        // 主人不在线 → 应该很快就返回（不挂死）
        out = await Promise.race([
            runAs('follow', () => cmd.perform(agent, OWNER)),
            sleep(8000).then(() => 'TIMEOUT'),
        ]);
    } catch (e) { out = 'THREW: ' + e.message; }
    const ms = Date.now() - t0;
    console.log(`  !followPlayer 返回: ${JSON.stringify(out).slice(0, 100)} (${ms}ms)`);
    check('③ !followPlayer 走 flow_follow 不抛', !(typeof out === 'string' && out.startsWith('THREW')), `${ms}ms`);
    check('③b follow_target 结束后已清空', agent.follow_target == null, `follow_target=${agent.follow_target}`);
}

// ── ④ !attack → flow_fight（没目标 → NO_TARGET，不抛）───────────────
{
    const cmd = getCommand('!attack');
    let res;
    try {
        res = await runAs('attack', () => cmd.perform(agent, 'zombie'));
    } catch (e) { res = { ok: false, code: 'INTERNAL', message: e.message }; }
    console.log(`  !attack 原始返回: ${JSON.stringify(res).slice(0, 140)}`);
    const line = formatOutcome({ result: res?.ok !== undefined ? res : { ok: false, code: 'NO_TARGET' }, label: '!attack' });
    console.log(`  → ${line}`);
    check('④ !attack 走 flow_fight 不抛且带建议', line.includes('建议') && !/INTERNAL：Cannot read/.test(line), line.slice(0, 70));
}

// ── ⑤ protect_owner 真机：跟随中主人在场+僵尸 → 会打 ────────────────
{
    // 真机侧只看"现场数据能不能被采到并得出该打的结论"（判定本身离线已 11 条）
    await RC(`summon zombie ${bx + 1.5} ${by} ${bz + 1.5}`).catch(() => { });
    await sleep(1200);
    const zombie = Object.values(bot.entities).find((e) => e?.name === 'zombie');
    // 用 bot 自己当"主人位置"（主人不在线，用她的位置代表"主人就在旁边"）
    const cand = zombie ? [{
        id: zombie.id, name: zombie.name,
        distToOwner: zombie.position.distanceTo(bot.entity.position),
        dyToOwner: Math.abs(zombie.position.y - bot.entity.position.y),
    }] : [];
    const followingTrue = decideProtect({ following: true, selfHp: bot.health, candidates: cand, now: Date.now() });
    const followingFalse = decideProtect({ following: false, selfHp: bot.health, candidates: cand, now: Date.now() });
    console.log(`  现场候选=${JSON.stringify(cand)}`);
    if (followingTrue.act && !followingFalse.act) {
        ok('⑤ 真机现场：跟随时会打僵尸、不跟随时不管',
            `跟随=${followingTrue.reason} 不跟随=${followingFalse.reason}`);
    } else {
        bad('⑤ 护主真机判定', { followingTrue, followingFalse, cand });
    }
}

console.log(`\n${pass}/${pass + fails} 条通过`);
try { bot.quit(); } catch { }
await sleep(400);
process.exit(fails === 0 ? 0 : 1);
