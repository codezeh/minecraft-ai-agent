/**
 * 场景 S1（超平坦隔离服，一次起服跑完）：
 *   A  BUG-001 回归：RCON tp 20/60 格 + 连续 tp 5 次 → 坐标非 NaN、tp 后能走（≥1.0 格/秒）、
 *      服务端日志无 invalid_player_movement 踢人。
 *   B  BUG-002 回归：一次 collect 任务砍 2 棵真树（8 个原木）→ 背包**持续**增长
 *      （采样：至少出现 2 次以上增量，不是捡到第 1 个就判成功停手）。
 *   C①②③ BUG-003 探因：超平坦挖方块 / setblock 放原木后挖 / forceload 远区块挖，
 *      每处都「服务端 @e[type=item] 计数 + bot 背包增量」双证据。
 *
 * 注：B 段必须摆**带树冠的真树** —— 第一版摆的是光杆原木，planCollect 按设计拒绝
 *     （`not-tree: 没有树冠（0 片叶），像玩家搭的或已剥光的树干`，见 s1b_diag_collect.mjs 的真实 dump）。
 */
import { createHarness, makeBot, sleep, parsePos, serverItemCount, itemCount, waitFor, src, dep, TEMPLATE_DIR, worldFingerprint } from './harness.mjs';
import path from 'node:path';
import fs from 'node:fs';

const SCENARIO = 's1-flat';
const NAME = 'r5a' + (Date.now() % 100000);
const log = (s) => console.log(s);

const h = await createHarness({ scenario: SCENARIO, levelType: 'flat' });

try {
    const tplFp = worldFingerprint(path.join(TEMPLATE_DIR, 'world'));
    const runFp = worldFingerprint(path.join(h.runDir, 'world'));
    h.check('S1 起服前世界 = 模板世界（干净起点）', tplFp === runFp, '逐文件 sha256 比对');

    const t0 = Date.now();
    await h.boot();
    h.check('S1 起服：日志出现 Done ( 且 RCON list 可用', true, `耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，日志 ${h.logPath}`);

    // ★ 3D 导航库目录必须先存在（否则 walkTo 会打 'unable to open database file' 并降级）
    process.env.MC_BOTS_ROOT = path.join(h.runDir, 'bots');
    fs.mkdirSync(path.join(h.runDir, 'bots', NAME, 'map'), { recursive: true });

    const bot = await makeBot({ name: NAME });
    h.check('S1 真 bot 已连上隔离服', !!bot.entity, `bot=${NAME} 出生点 ${bot.entity.position.toString()}`);

    // ── 方块读数工具（1.21.8 的 `data get block` 只认 block entity，不能用来读普通方块）──
    const isBlock = async (pos, name) => {
        const r = String(await h.rc(`execute if block ${pos[0]} ${pos[1]} ${pos[2]} ${name}`));
        return /Test passed/i.test(r);
    };

    log(`[env] ${String(await h.rc('gamerule doTileDrops')).trim()}`);

    for (const g of [
        'iron_axe 1', 'iron_shovel 1', 'iron_pickaxe 1', 'diamond_sword 1',
        'stone 16', 'oak_log 4', 'chest 1', 'cooked_beef 8', 'dirt 8', 'cobblestone 64',
    ]) await h.rc(`give ${NAME} ${g}`);
    await sleep(1200);

    // ══════════════════════════════════════════════════════════
    // A：BUG-001 回归（tp 物理崩溃）
    // ══════════════════════════════════════════════════════════
    log('\n--- A：BUG-001 回归（外部 tp 后物理是否崩溃）---');
    const readPos = async () => parsePos(String(await h.rc(`data get entity ${NAME} Pos`)));
    const base = await readPos();
    log(`[A] 起始坐标 ${base ? base.join(', ') : 'null'}`);

    const isFinitePos = (p) => Array.isArray(p) && p.length === 3 && p.every((n) => Number.isFinite(n));
    const near = (p, t) => p && Math.hypot(p[0] - t[0], p[2] - t[2]) <= 3;

    {
        const tgt = [Math.floor(base[0]) + 20, Math.floor(base[1]), Math.floor(base[2])];
        await h.rc(`tp ${NAME} ${tgt[0]} ${tgt[1]} ${tgt[2]}`);
        await sleep(2000);
        const p = await readPos();
        h.check('A-1 tp 20 格后坐标非 NaN（服务端读回）', isFinitePos(p), `服务端 ${p ? p.join(', ') : 'null'}；客户端 ${bot.entity.position.toString()}`);
        h.check('A-1 tp 20 格后到达目标（水平误差 ≤3）', near(p, tgt), `目标 ${tgt.join(', ')}`);
        h.check('A-1 客户端坐标也非 NaN', isFinitePos([bot.entity.position.x, bot.entity.position.y, bot.entity.position.z]), `mineflayer ${bot.entity.position.toString()}`);
    }
    {
        const p0 = await readPos();
        const tgt = [Math.floor(p0[0]), Math.floor(p0[1]), Math.floor(p0[2]) + 60];
        await h.rc(`tp ${NAME} ${tgt[0]} ${tgt[1]} ${tgt[2]}`);
        await sleep(2000);
        const p = await readPos();
        h.check('A-2 tp 60 格后坐标非 NaN', isFinitePos(p), `服务端 ${p ? p.join(', ') : 'null'}；客户端 ${bot.entity.position.toString()}`);
        h.check('A-2 tp 60 格后到达目标（水平误差 ≤3）', near(p, tgt), `目标 ${tgt.join(', ')}`);
    }
    {
        let bad = 0;
        const seen = [];
        for (let i = 0; i < 5; i++) {
            const cur = await readPos();
            const tgt = [Math.floor(cur[0]) + 5, Math.floor(cur[1]), Math.floor(cur[2]) + 5];
            await h.rc(`tp ${NAME} ${tgt[0]} ${tgt[1]} ${tgt[2]}`);
            await sleep(1200);
            const p = await readPos();
            seen.push(p ? p[0].toFixed(1) : 'null');
            if (!isFinitePos(p) || !near(p, tgt)) bad++;
        }
        h.check('A-3 连续 tp 5 次坐标全部正常', bad === 0, `异常 ${bad}/5；逐次 X=${seen.join(' → ')}`);
    }
    {
        await bot.look(0, 0, true);
        await sleep(300);
        const p0 = bot.entity.position.clone();
        const t0w = Date.now();
        bot.setControlState('forward', true);
        await sleep(3000);
        bot.setControlState('forward', false);
        const dt = (Date.now() - t0w) / 1000;
        const p1 = bot.entity.position.clone();
        const dist = Math.hypot(p1.x - p0.x, p1.z - p0.z);
        const speed = dist / dt;
        h.check('A-4 tp 后正常走路（实测速度 ≥1.0 格/秒）', speed >= 1.0,
            `${dt.toFixed(1)}s 位移 ${dist.toFixed(2)} 格 = ${speed.toFixed(2)} 格/秒（${p0.toString()} → ${p1.toString()}）`);
        h.check('A-4 走完坐标仍非 NaN', Number.isFinite(p1.x) && Number.isFinite(p1.z), p1.toString());
    }
    {
        const kickLogs = (h.log.match(/invalid_player_movement|moved too quickly|moved wrongly|Ignoring .* from/g) ?? []);
        h.check('A-5 服务端日志无 invalid_player_movement / moved-too-quickly 记录', kickLogs.length === 0,
            kickLogs.length ? `命中 ${kickLogs.length} 条：${kickLogs.slice(0, 3).join(' | ')}` : '日志 0 命中');
        h.check('A-5 客户端整个 A 段没被踢（mineflayer kicked 事件 0 次）', (bot.__kicks ?? []).length === 0,
            (bot.__kicks ?? []).length ? bot.__kicks.join(' | ') : 'kicked 事件 0 次');
    }

    // ══════════════════════════════════════════════════════════
    // B：BUG-002 回归（判据基准错位 → 捡到第 1 个就停）
    // ══════════════════════════════════════════════════════════
    log('\n--- B：BUG-002 回归（一次任务砍 2 棵树 8 个原木，背包是否持续增长）---');
    const agent = { bot, board: null, boardClient: null };
    const { runSkill } = await src('src/agent/library/composite_registry.js');

    {
        const p = bot.entity.position.floored();
        const gy = p.y - 1;
        // 清场地
        await h.rc(`fill ${p.x - 3} ${gy} ${p.z - 3} ${p.x + 20} ${gy} ${p.z + 10} grass_block`);
        await h.rc(`fill ${p.x - 3} ${p.y} ${p.z - 3} ${p.x + 20} ${p.y + 9} ${p.z + 10} air`);

        /** 摆一棵真树：4 格树干 + 5×3×5 树冠（先铺叶子，再把树干写回去）。 */
        // 真树形状：叶子从 y+2 起铺到 y+5（半径 2），树干 4 格。
        // 第一版叶子只铺在 y+3..y+5，树底两格原木离叶子 >2 格 → 砍掉上层后剩下的底木
        // 被判 "not-tree"（无树冠），于是 8 个只拿到 6 个。这是**场地摆法**问题，不是 BUG-002。
        const plantTree = async (tx, tz) => {
            await h.rc(`fill ${tx - 2} ${p.y + 2} ${tz - 2} ${tx + 2} ${p.y + 5} ${tz + 2} oak_leaves`);
            for (let i = 0; i < 4; i++) await h.rc(`setblock ${tx} ${p.y + i} ${tz} oak_log`);
        };
        const trees = [[p.x + 5, p.z + 2], [p.x + 13, p.z + 7], [p.x + 6, p.z + 11]];
        for (const [tx, tz] of trees) await plantTree(tx, tz);
        const t1 = trees[0], t2 = trees[1];
        await sleep(1500);
        h.check('B-0 树已摆好（树干存在且带树冠）', await isBlock([t1[0], p.y, t1[1]], 'oak_log'), `树干 (${t1.join(',')})，(第二棵在 (${t2.join(',')}))`);

        const before = itemCount(bot, 'oak_log');
        const samples = [];
        const sampler = setInterval(() => { samples.push(itemCount(bot, 'oak_log')); }, 400);
        const t0c = Date.now();
        const r = await runSkill(agent, 'collect', 'block=oak_log count=8 radius=32');
        const ms = Date.now() - t0c;
        clearInterval(sampler);
        const after = itemCount(bot, 'oak_log');
        const uniq = [...new Set(samples)];
        const gains = uniq.filter((v) => v > before);
        log(`[B] runSkill → ok=${r?.ok} code=${r?.code ?? ''} msg=${(r?.message ?? '').slice(0, 160)}  ${ms}ms`);
        log(`[B] 背包采样序列（去重）：${uniq.join(' → ')}`);
        h.check('B-1 collect 技能返回 ok', r?.ok === true, `code=${r?.code ?? 'null'} msg=${r?.message ?? ''}`);
        h.check('B-2 背包 oak_log 增量 ≥8（不是捡到第 1 个就停）', after - before >= 8,
            `任务前 ${before} → 任务后 ${after}，增量 ${after - before}（BUG-002 复发时会停在 1）`);
        h.check('B-3 增量是"持续"发生的（采样里出现 ≥2 个不同的增长台阶）', gains.length >= 2,
            `采样到 ${gains.length} 个增长台阶：${gains.join(' → ')}`);
    }

    // ══════════════════════════════════════════════════════════
    // C①②③：BUG-003 探因（掉落物到底生成没有）
    // ══════════════════════════════════════════════════════════
    log('\n--- C：BUG-003（远处区块不掉落）三个隔离条件 ---');

    async function digAndCount(label, pos, expectItem) {
        const target = [pos.x, pos.y, pos.z];
        await h.rc('kill @e[type=item,distance=..40]').catch(() => {});
        await sleep(400);
        const beforeItem = itemCount(bot, expectItem);
        const beforeServer = await serverItemCount(h.rc, target, 8);

        const block = bot.blockAt(dep('vec3')(target[0], target[1], target[2]));
        if (!block || block.name === 'air') {
            h.fail(`${label} 目标方块存在`, `(${target.join(', ')}) 读到 ${block ? block.name : 'null'}`);
            return null;
        }
        let digErr = null;
        try { await bot.dig(block, true); } catch (e) { digErr = String(e?.message ?? e).slice(0, 200); }

        await waitFor(async () => (await serverItemCount(h.rc, target, 8)) > beforeServer, { timeoutMs: 4000, intervalMs: 300 });
        await sleep(800);
        const afterServer = await serverItemCount(h.rc, target, 8);
        const afterItem = itemCount(bot, expectItem);
        const becameAir = await isBlock(target, 'minecraft:air');

        log(`  [${label}] 目标=${target.join(',')} 挖前=${block.name} 挖后是 air? ${becameAir}`);
        log(`  [${label}] 服务端 @e[type=item] ${beforeServer} → ${afterServer}；bot ${expectItem} ${beforeItem} → ${afterItem}${digErr ? ' digErr=' + digErr : ''}`);
        h.check(`${label} 方块确实变成 air`, becameAir, `execute if block ${target.join(' ')} minecraft:air → ${becameAir}`);
        const gotDrop = (afterServer > beforeServer) || (afterItem > beforeItem);
        h.check(`${label} 掉落物证据（服务端 item 实体 或 背包增量）`, gotDrop,
            `服务端 item ${beforeServer}→${afterServer}，背包 ${beforeItem}→${afterItem}${digErr ? '，dig 异常：' + digErr : ''}`);
        return { beforeServer, afterServer, beforeItem, afterItem, digErr };
    }

    {
        const p = bot.entity.position.floored();
        const bx = p.x + 3, by = p.y, bz = p.z;
        await h.rc(`setblock ${bx} ${by} ${bz} dirt`);
        await sleep(600);
        const pf = dep('mineflayer-pathfinder');
        bot.pathfinder.setGoal(new pf.goals.GoalNear(bx, by, bz, 1), true);
        await waitFor(() => bot.entity.position.distanceTo(dep('vec3')(bx, by, bz)) < 3.2, { timeoutMs: 8000 });
        bot.pathfinder.setGoal(null);
        await sleep(400);
        await digAndCount('C-① 超平坦区挖 setblock 的 dirt', { x: bx, y: by, z: bz }, 'dirt');
    }
    {
        const p = bot.entity.position.floored();
        const bx = p.x + 3, by = p.y, bz = p.z + 2;
        await h.rc(`setblock ${bx} ${by} ${bz} oak_log`);
        await sleep(600);
        const pf = dep('mineflayer-pathfinder');
        bot.pathfinder.setGoal(new pf.goals.GoalNear(bx, by, bz, 1), true);
        await waitFor(() => bot.entity.position.distanceTo(dep('vec3')(bx, by, bz)) < 3.2, { timeoutMs: 8000 });
        bot.pathfinder.setGoal(null);
        await sleep(400);
        await digAndCount('C-② setblock 放 oak_log 后挖', { x: bx, y: by, z: bz }, 'oak_log');
    }
    {
        const p = bot.entity.position.floored();
        const fx = p.x + 400, fz = p.z + 400;
        const pre = String(await h.rc(`data get block ${fx} -60 ${fz}`));
        h.check('C-③ 未 forceload 的远区块确实未加载（原始现象前提）', /not loaded|Cannot|error/i.test(pre),
            `RCON data get block ${fx} -60 ${fz} → ${pre.trim().slice(0, 120)}`);

        await h.rc(`forceload add ${fx} ${fz}`);
        await sleep(1500);
        await h.rc(`setblock ${fx} -60 ${fz} oak_log`);
        await sleep(800);
        h.check('C-③ forceload 后 setblock 成功（区块可写）', await isBlock([fx, -60, fz], 'oak_log'),
            `execute if block ${fx} -60 ${fz} oak_log → true`);

        await h.rc(`tp ${NAME} ${fx + 1} -60 ${fz}`);
        await sleep(2000);
        await digAndCount('C-③ forceload 远区块挖 oak_log', { x: fx, y: -60, z: fz }, 'oak_log');
        await h.rc(`forceload remove ${fx} ${fz}`).catch(() => {});
    }

} catch (e) {
    h.fail('S1 场景执行未抛异常', String(e?.stack ?? e).slice(0, 1200));
} finally {
    const stopped = await h.stop();
    h.check('S1 停服：RCON stop → java 进程退出', stopped === true, `java pid ${h.childPid}`);
    const s = h.summary();
    console.log(`\n[证据] server.log: ${h.logPath}`);
    console.log(`[证据] assertions: ${path.join(h.runDir, 'assertions.json')}`);
    process.exit(s.bad.length ? 1 : 0);
}
