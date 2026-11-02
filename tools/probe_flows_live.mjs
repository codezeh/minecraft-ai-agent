/**
 * M7 第二批流程的**真机**抽验（`!do` 同路径）—— 挑 mine / farm / fight 三个。
 *
 * 为什么挑这三个：它们最依赖"真机世界状态"（矿在哪、作物熟没熟、实体在不在），
 * 离线假 bot 只能验错误码，验不了"她真的走过去挖到了/收到了/打到了"。
 *
 * 走的是**和 `!do` 完全相同的入口** `composite_registry.runSkill`（不是直接调流程函数），
 * 这样参数校验、ctx 工厂、注册表查找这一整条路径都被覆盖到。
 *
 * 用法：node tools/probe_flows_live.mjs [场景...]
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { runSkill, SKILL_NAMES } from '../src/agent/library/composite_registry.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const NAME = 'm7p' + (Date.now() % 100000);
const WANT = process.argv.slice(2);

const bot = mineflayer.createBot({
    host: '127.0.0.1', port: 25566, username: NAME, auth: 'offline', version: '1.21.8',
});
bot.loadPlugin(pf.pathfinder);
installPositionGuard(bot);
bot.on('error', () => { });
bot.on('kicked', (r) => console.log('KICKED', JSON.stringify(r).slice(0, 90)));

const out = [];
const say = (s) => { console.log(s); out.push(s); };

await new Promise((res) => bot.once('spawn', res));
await sleep(1500);

/** 造一个 agent 形状（runSkill 要 agent.bot；ctx 会自己从 bot 取 mapDir）。 */
const agent = { bot, actions: { runAction: async (_l, fn) => { await fn(); return {}; } } };

say(`=== 真机流程抽验（bot=${NAME}）===`);
say(`注册技能：${SKILL_NAMES.join(', ')}`);

// ── 场景 1：flow_mine —— 挖铁矿 ──────────────────────────────────────
if (!WANT.length || WANT.includes('mine')) {
    say('\n--- [1] mine: 挖 2 个铁矿 ---');
    // 造一个干净场地：清一块区域，放几块铁矿在她旁边
    const p = bot.entity.position;
    const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
    await RC(`fill ${bx - 3} ${by - 1} ${bz - 3} ${bx + 3} ${by - 1} ${bz + 3} stone`);
    await RC(`fill ${bx - 3} ${by} ${bz - 3} ${bx + 3} ${by + 3} ${bz + 3} air`);
    await RC(`setblock ${bx + 2} ${by} ${bz} iron_ore`);
    await RC(`setblock ${bx + 2} ${by + 1} ${bz} iron_ore`);
    await RC(`give ${NAME} iron_pickaxe 1`);
    await sleep(800);
    // ★ 挖 iron_ore 掉的是 raw_iron（方块名 ≠ 物品名）—— 探针本身也要按物品数
    const cnt = () => (bot.inventory?.items?.() ?? []).filter(i => i?.name === 'raw_iron').reduce((n, i) => n + i.count, 0);
    const before = cnt();
    const t0 = Date.now();
    const r = await runSkill(agent, 'mine', 'ore=iron count=2 maxDepth=8');
    const ms = Date.now() - t0;
    const after = cnt();
    say(`  结果: ${r.ok ? 'OK' : r.code}  ${ms}ms  data=${JSON.stringify(r.data ?? {}).slice(0, 160)}`);
    say(`  背包 raw_iron ${before} → ${after}${after > before ? '  ✅ 真的挖到并捡到了' : '  ⚠ 没增加'}`);
}

// ── 场景 2：flow_farm —— 种/收一块地 ────────────────────────────────
if (!WANT.length || WANT.includes('farm')) {
    say('\n--- [2] farm: 收一轮庄稼（先造成熟小麦 + 空耕地）---');
    const p = bot.entity.position;
    const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
    await RC(`fill ${bx - 4} ${by - 1} ${bz - 4} ${bx + 4} ${by - 1} ${bz + 4} dirt`);
    await RC(`fill ${bx - 4} ${by} ${bz - 4} ${bx + 4} ${by + 2} ${bz + 4} air`);
    // 两棵成熟小麦 + 两块空耕地（作物在耕地上面一格）
    await RC(`setblock ${bx + 2} ${by - 1} ${bz} farmland`);
    await RC(`setblock ${bx + 2} ${by} ${bz} wheat[age=7]`);
    await RC(`setblock ${bx + 3} ${by - 1} ${bz} farmland`);
    await RC(`setblock ${bx + 3} ${by} ${bz} wheat[age=7]`);
    await RC(`give ${NAME} wheat_seeds 8`);
    await RC(`give ${NAME} iron_hoe 1`);
    await sleep(800);
    const t0 = Date.now();
    const r = await runSkill(agent, 'farm', `area=${bx},${by},${bz}:4`);
    const ms = Date.now() - t0;
    say(`  结果: ${r.ok ? 'OK' : r.code}  ${ms}ms  data=${JSON.stringify(r.data ?? {}).slice(0, 200)}`);
    // 读回：那两格应该已经空了（收走）
    const a = bot.blockAt(new Vec3(bx + 2, by, bz));
    const b = bot.blockAt(new Vec3(bx + 3, by, bz));
    say(`  读回 (${bx + 2},${by},${bz})=${a?.name}  (${bx + 3},${by},${bz})=${b?.name}`);
}

// ── 场景 3：flow_fight —— 打一只僵尸 ────────────────────────────────
if (!WANT.length || WANT.includes('fight')) {
    say('\n--- [3] fight: 打 1 只僵尸 ---');
    const p = bot.entity.position;
    const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
    await RC(`fill ${bx - 3} ${by - 1} ${bz - 3} ${bx + 3} ${by - 1} ${bz + 3} stone`);
    await RC(`fill ${bx - 3} ${by} ${bz - 3} ${bx + 3} ${by + 3} ${bz + 3} air`);
    await RC(`give ${NAME} iron_sword 1`);
    await RC(`summon zombie ${bx + 2} ${by} ${bz} {NoAI:1b,PersistenceRequired:1b}`);
    await sleep(1000);
    const hpBefore = bot.health;
    const t0 = Date.now();
    const r = await runSkill(agent, 'fight', 'target=zombie maxKills=1 retreatHp=6');
    const ms = Date.now() - t0;
    say(`  结果: ${r.ok ? 'OK' : r.code}  ${ms}ms  data=${JSON.stringify(r.data ?? {}).slice(0, 220)}`);
    say(`  自血量 ${hpBefore} → ${bot.health}`);
}

say('\n=== 完 ===');
try { bot.quit(); } catch { }
await sleep(500);
process.exit(0);
