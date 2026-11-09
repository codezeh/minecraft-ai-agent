/**
 * 场景 S2（超平坦隔离服）：D 游戏内原子能力 smoke + E 寻路。
 *
 * D：dig / place / craft / chest 存+取 / eat / attack / pickup 各 1 条，
 *    每条都走**产品代码**（src/agent/library/act_*.js），并给客观断言
 *    （方块变 air / 背包物品与数量 / 箱子内容 / 实体死亡 / 饱食度）。
 * E：走到 25 格外的目标点，断言到达（误差 ≤2）且未 stuck（位置持续推进）。
 */
import { createHarness, makeBot, sleep, itemCount, waitFor, src, dep, serverItemCount, serverEntityCount, posStr } from './harness.mjs';
import path from 'node:path';
import fs from 'node:fs';

const SCENARIO = 's2-atoms-nav';
const NAME = 'r5b' + (Date.now() % 100000);
const log = (s) => console.log(s);

const h = await createHarness({ scenario: SCENARIO, levelType: 'flat' });

try {
    await h.boot();
    h.check('S2 起服：Done ( + RCON 就绪', true, h.logPath);

    process.env.MC_BOTS_ROOT = path.join(h.runDir, 'bots');
    fs.mkdirSync(path.join(h.runDir, 'bots', NAME, 'map'), { recursive: true });
    const bot = await makeBot({ name: NAME });
    h.check('S2 真 bot 已连上隔离服', !!bot.entity, `bot=${NAME} 出生点 ${bot.entity.position.toString()}`);

    const Vec3 = dep('vec3');
    const pf = dep('mineflayer-pathfinder');
    const isBlock = async (pos, name) => /Test passed/i.test(String(await h.rc(`execute if block ${pos[0]} ${pos[1]} ${pos[2]} ${name}`)));
    const give = async (spec) => { await h.rc(`give ${NAME} ${spec}`); };
    const tpNear = async (x, y, z) => {
        bot.pathfinder.setGoal(new pf.goals.GoalNear(x, y, z, 1), true);
        await waitFor(() => bot.entity.position.distanceTo(new Vec3(x, y, z)) < 3.2, { timeoutMs: 10000 });
        bot.pathfinder.setGoal(null);
        await sleep(400);
    };

    const p = bot.entity.position.floored();
    await h.rc(`fill ${p.x - 6} ${p.y - 1} ${p.z - 6} ${p.x + 14} ${p.y - 1} ${p.z + 14} grass_block`);
    await h.rc(`fill ${p.x - 6} ${p.y} ${p.z - 6} ${p.x + 14} ${p.y + 6} ${p.z + 14} air`);
    await sleep(800);
    for (const g of ['iron_pickaxe 1', 'iron_axe 1', 'stone 24', 'oak_log 8', 'chest 2', 'cooked_beef 8', 'dirt 16', 'diamond_sword 1']) await give(g);
    await sleep(1200);

    const { digBlock } = await src('src/agent/library/act_dig.js');
    const { placeBlockAt } = await src('src/agent/library/act_place.js');
    const { craftOnce } = await src('src/agent/library/act_craft.js');
    const { openContainer, closeContainer, deposit, withdraw } = await src('src/agent/library/act_container.js');
    const { eat } = await src('src/agent/library/act_items.js');
    const { attackEntity } = await src('src/agent/library/act_attack.js');

    // ── D-1 dig ────────────────────────────────────────────────
    {
        const bx = p.x + 3, by = p.y, bz = p.z;
        await h.rc(`setblock ${bx} ${by} ${bz} stone`);
        await sleep(600);
        await tpNear(bx, by, bz);
        const before = itemCount(bot, 'cobblestone');
        const block = bot.blockAt(new Vec3(bx, by, bz));
        let r = null, err = null;
        try { r = await digBlock(bot, { kind: 'block', pos: { x: bx, y: by, z: bz } }, {}); } catch (e) { err = String(e?.message ?? e); }
        const dropped = await waitFor(() => itemCount(bot, 'cobblestone') > before, { timeoutMs: 4000, intervalMs: 300 });
        const srvItems = await serverItemCount(h.rc, [bx, by, bz], 6);
        const air = await isBlock([bx, by, bz], 'minecraft:air');
        const after = itemCount(bot, 'cobblestone');
        h.check('D-1 dig：目标方块变成 air', air, `execute if block ${bx} ${by} ${bz} minecraft:air → ${air}；before=${block?.name} dig=${JSON.stringify(r)?.slice(0, 120)}${err ? ' err=' + err : ''}`);
        // 掉落物「生成」的判据看服务端实体（捡起来属于另一个能力，见 D-7 pickup）
        h.check('D-1 dig：服务端生成了掉落物（@e[type=item] ≥1）', srvItems >= 1,
            `服务端该处 item 实体 = ${srvItems}；背包 cobblestone ${before} → ${after}（bot 未走过去，故未捡）`);
    }

    // ── D-2 place ──────────────────────────────────────────────
    {
        const bx = p.x + 3, by = p.y, bz = p.z + 2;
        await tpNear(bx, by, bz);
        const r = await placeBlockAt(bot, { kind: 'block', pos: { x: bx, y: by, z: bz } }, 'stone', {});
        await sleep(900);
        const placed = await isBlock([bx, by, bz], 'minecraft:stone');
        h.check('D-2 place：方块真的出现在世界里（stone）', placed, `execute if block → ${placed}；placeBlockAt=${JSON.stringify(r)?.slice(0, 200)}`);
    }

    // ── D-3 craft ──────────────────────────────────────────────
    {
        const before = itemCount(bot, 'oak_planks');
        const r = await craftOnce(bot, 'oak_planks', 1, null);
        await sleep(800);
        const after = itemCount(bot, 'oak_planks');
        h.check('D-3 craft：合成出 4 个 oak_planks', after - before >= 4, `planks ${before} → ${after}；craftOnce=${JSON.stringify(r)?.slice(0, 160)}`);
    }

    // ── D-4 chest 存 + 取 ──────────────────────────────────────
    {
        const bx = p.x + 6, by = p.y, bz = p.z + 3;
        await h.rc(`setblock ${bx} ${by} ${bz} chest`);
        await sleep(600);
        await tpNear(bx, by, bz);
        const chestPos = { x: bx, y: by, z: bz };
        const dirtBefore = itemCount(bot, 'dirt');
        const open = await openContainer(bot, { kind: 'block', pos: chestPos }, {});
        let dep = null, wd = null, chestDirt = 0, dirtMid = 0;
        if (open?.ok === false) {
            h.fail('D-4 chest：能打开箱子', JSON.stringify(open).slice(0, 200));
        } else {
            dep = await deposit(bot, 'dirt', 5);
            await sleep(600);
            chestDirt = (bot.currentWindow?.slots ?? []).filter((s) => s && s.name === 'dirt').reduce((n, s) => n + s.count, 0);
            dirtMid = itemCount(bot, 'dirt');
            wd = await withdraw(bot, 'dirt', 5);
            await sleep(600);
            try { await closeContainer(bot, {}); } catch { /* 关窗失败不影响断言 */ }
            const dirtAfter = itemCount(bot, 'dirt');
            h.check('D-4 chest 存：箱子内容里有 5 个 dirt', chestDirt >= 5, `箱子 dirt=${chestDirt}；deposit=${JSON.stringify(dep)?.slice(0, 160)}；背包 dirt ${dirtBefore}→${dirtMid}`);
            h.check('D-4 chest 取：取回后背包 dirt 复原', dirtAfter >= dirtBefore, `背包 dirt ${dirtMid}→${dirtAfter}；withdraw=${JSON.stringify(wd)?.slice(0, 160)}`);
        }
    }

    // ── D-5 eat ────────────────────────────────────────────────
    {
        await h.rc(`effect give ${NAME} minecraft:hunger 40 12`);
        const hungry = await waitFor(() => bot.food < 18, { timeoutMs: 30000, intervalMs: 500 });
        const foodBefore = bot.food;
        h.check('D-5 eat：前置——饱食度已降到 18 以下', hungry, `food=${foodBefore}`);
        const r = await eat(bot, 'cooked_beef');
        await sleep(1200);
        const foodAfter = bot.food;
        h.check('D-5 eat：吃了一块熟牛肉后饱食度上升', foodAfter > foodBefore, `food ${foodBefore} → ${foodAfter}；eat=${JSON.stringify(r)?.slice(0, 160)}`);
    }

    // ── D-6 attack ─────────────────────────────────────────────
    {
        const bx = p.x + 3, by = p.y, bz = p.z + 3;  // 近战 3 格内，别摆到 4 格外
        await h.rc('kill @e[type=zombie]').catch(() => {});
        await sleep(300);
        await h.rc(`summon zombie ${bx} ${by} ${bz} {NoAI:1b,PersistenceRequired:1b}`);
        await sleep(1200);
        const before = await serverEntityCount(h.rc, 'zombie', [bx, by, bz], 12);
        h.check('D-6 attack：僵尸已生成（前置）', before >= 1, `服务端 zombie 数量=${before}`);
        // 先走到近战距离内（atom 的 maxReach=3，站太远会（正确地）报 OUT_OF_REACH）
        await tpNear(bx - 1, by, bz - 1);
        const zombie = bot.entities ? Object.values(bot.entities).find((e) => e.name === 'zombie') : null;
        await bot.equip(bot.inventory.items().find((i) => i.name === 'diamond_sword'), 'hand').catch(() => {});
        let r = null;
        if (!zombie) {
            h.fail('D-6 attack：客户端能看到僵尸实体', 'bot.entities 里找不到 zombie（视野/加载问题）');
        } else {
            try { r = await attackEntity(bot, { kind: 'entity', entity: zombie }, { timeout: 20000 }); } catch (e) { r = { err: String(e?.message ?? e) }; }
            await sleep(1500);
            const after = await serverEntityCount(h.rc, 'zombie', [bx, by, bz], 12);
            h.check('D-6 attack：僵尸被打死（服务端实体消失）', after === 0, `zombie ${before} → ${after}；attackEntity=${JSON.stringify(r)?.slice(0, 200)}`);
        }
    }

    // ── D-7 pickup ─────────────────────────────────────────────
    {
        const bx = p.x + 4, by = p.y, bz = p.z + 7;
        await h.rc(`summon item ${bx} ${by} ${bz} {Item:{id:"minecraft:diamond",count:1}}`);
        await sleep(1000);
        const before = itemCount(bot, 'diamond');
        const srvBefore = await serverItemCount(h.rc, [bx, by, bz], 8);
        bot.pathfinder.setGoal(new pf.goals.GoalNear(bx, by, bz, 1), true);
        const picked = await waitFor(() => itemCount(bot, 'diamond') > before, { timeoutMs: 15000, intervalMs: 400 });
        bot.pathfinder.setGoal(null);
        const after = itemCount(bot, 'diamond');
        h.check('D-7 pickup：走过去把掉落物捡进背包（diamond +1）', picked && after > before,
            `服务端该处 item 实体 ${srvBefore}；背包 diamond ${before} → ${after}`);
    }

    // ── E 寻路 ─────────────────────────────────────────────────
    {
        const start = bot.entity.position.clone();
        const tgt = new Vec3(Math.floor(start.x) + 25, Math.floor(start.y), Math.floor(start.z) + 12);
        // 铺一条平坦走廊，避免地形干扰（超平坦本来也是平的）
        await h.rc(`fill ${Math.floor(start.x) - 1} ${Math.floor(start.y) - 1} ${Math.floor(start.z) - 1} ${tgt.x + 1} ${Math.floor(start.y) - 1} ${tgt.z + 1} grass_block`);
        await h.rc(`fill ${Math.floor(start.x) - 1} ${Math.floor(start.y)} ${Math.floor(start.z) - 1} ${tgt.x + 1} ${Math.floor(start.y) + 3} ${tgt.z + 1} air`);
        await sleep(600);

        const samples = [];
        const sampler = setInterval(() => samples.push(bot.entity.position.clone()), 500);
        const t0 = Date.now();
        bot.pathfinder.setGoal(new pf.goals.GoalNear(tgt.x, tgt.y, tgt.z, 1), true);
        const arrived = await waitFor(() => bot.entity.position.distanceTo(tgt) <= 2.0, { timeoutMs: 90000, intervalMs: 400 });
        const ms = Date.now() - t0;
        clearInterval(sampler);
        bot.pathfinder.setGoal(null);
        const end = bot.entity.position.clone();
        const err = Math.hypot(end.x - tgt.x, end.y - tgt.y, end.z - tgt.z);
        const uniq = [];
        for (const s of samples) {
            const k = `${s.x.toFixed(1)},${s.z.toFixed(1)}`;
            if (uniq[uniq.length - 1] !== k) uniq.push(k);
        }
        log(`[E] 目标 ${tgt.toString()}；路径采样 ${samples.length} 点（不同位置 ${uniq.length} 个）；用时 ${(ms / 1000).toFixed(1)}s`);
        h.check('E-1 寻路到达 25 格外的目标点（误差 ≤2 格）', arrived && err <= 2.0, `终点 ${end.toString()}，误差 ${err.toFixed(2)} 格，用时 ${(ms / 1000).toFixed(1)}s`);
        h.check('E-2 全程有位置推进（未 stuck）', uniq.length >= 5, `采样到 ${uniq.length} 个不同位置：${uniq.slice(0, 6).join(' → ')} …`);
        h.check('E-3 起点到终点确实移动了（水平位移 ≥20）', Math.hypot(end.x - start.x, end.z - start.z) >= 20,
            `位移 ${Math.hypot(end.x - start.x, end.z - start.z).toFixed(1)} 格`);
    }

} catch (e) {
    h.fail('S2 场景执行未抛异常', String(e?.stack ?? e).slice(0, 1500));
} finally {
    const stopped = await h.stop();
    h.check('S2 停服：RCON stop → java 进程退出', stopped === true, `java pid ${h.childPid}`);
    const s = h.summary();
    console.log(`\n[证据] server.log: ${h.logPath}`);
    process.exit(s.bad.length ? 1 : 0);
}
