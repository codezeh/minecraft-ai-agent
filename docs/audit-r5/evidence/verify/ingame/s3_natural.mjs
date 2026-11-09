/**
 * 场景 S3：C-④ 自然地形（另一个 level-type=normal 的世界）挖树 —— BUG-003 的最后一条。
 *
 * 做法：另起一个普通世界（不是超平坦模板），用 /locate biome 找到真正的森林，
 *       tp 过去，`execute if biome` 确认到的是 forest，再让 bot 真的挖一棵自然树，
 *       仍然用「服务端 @e[type=item] 计数 + 背包增量」双证据。
 */
import { createHarness, makeBot, sleep, itemCount, waitFor, dep, serverItemCount, worldFingerprint } from './harness.mjs';
import path from 'node:path';
import fs from 'node:fs';

const SCENARIO = 's3-natural';
const NAME = 'r5c' + (Date.now() % 100000);
const log = (s) => console.log(s);

const h = await createHarness({ scenario: SCENARIO, levelType: 'normal', seed: '20261108', copyWorld: false, bootTimeoutMs: 420000 });

try {
    const t0 = Date.now();
    await h.boot();
    h.check('S3 普通世界起服：Done ( + RCON 就绪', true, `耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，日志 ${h.logPath}`);

    process.env.MC_BOTS_ROOT = path.join(h.runDir, 'bots');
    fs.mkdirSync(path.join(h.runDir, 'bots', NAME, 'map'), { recursive: true });
    const bot = await makeBot({ name: NAME });
    h.check('S3 真 bot 已连上普通世界', !!bot.entity, `bot=${NAME} 出生点 ${bot.entity.position.toString()}`);

    const Vec3 = dep('vec3');
    const pf = dep('mineflayer-pathfinder');

    // 找最近的森林
    const loc = String(await h.rc('locate biome minecraft:forest'));
    const nums = (loc.match(/-?\d+/g) ?? []).map(Number);
    log(`[S3] locate biome → ${loc.trim().slice(0, 160)}`);
    h.check('S3 找到森林生物群系坐标', nums.length >= 2, loc.trim().slice(0, 160));
    const fx = nums[0], fz = nums[2];   // locate 返回的是 [x, y, z]，别把 y 当 z

    // tp 过去（先到高空再落地，避免卡在树里）
    await h.rc(`forceload add ${fx} ${fz}`).catch(() => {});
    await h.rc(`tp ${NAME} ${fx + 0.5} 120 ${fz + 0.5}`);
    await waitFor(() => bot.entity.position.y < 110, { timeoutMs: 60000, intervalMs: 500 });
    await sleep(4000);

    // ★ biome 判据：拿三个确定已加载的点各查一次，任一命中 #minecraft:is_forest 即算森林。
    //   （第一次用 /locate 返回的 y=101 那个点查，服务端判 Test failed —— 那个点不一定在已加载区块里；
    //     挖到的原木位置一定已加载，是更可靠的点。）
    const biomeAt = async (x, y, z) => {
        const exact = String(await h.rc(`execute if biome ${x} ${y} ${z} #minecraft:is_forest`)).trim();
        return { x, y, z, ok: /Test passed/i.test(exact), raw: exact };
    };
    const bp = bot.entity.position.floored();
    const probes = [await biomeAt(bp.x, bp.y, bp.z), await biomeAt(fx, 64, fz)];
    log(`[S3] biome 探针：${probes.map((b) => '`(${b.x},${b.y},${b.z})=${b.raw}`').join(' | ')}`);
    var biomeProbes = probes;
    var biomeHit = probes.some((b) => b.ok);
    log(`[S3] bot 落点 ${bot.entity.position.toString()}`);

    // 在周围找自然原木
    const logsFound = bot.findBlocks({ matching: (b) => /_log$/.test(b.name), maxDistance: 48, count: 24 });
    log(`[S3] 48 格内找到自然原木 ${logsFound.length} 处：${logsFound.slice(0, 5).map((v) => `${v.x},${v.y},${v.z}`).join(' | ')}`);
    h.check('S3 自然森林里确实有原木（前置）', logsFound.length > 0, `找到 ${logsFound.length} 处`);

    if (logsFound.length === 0) {
        h.fail('S3 C-④ 自然地形挖树（掉落物双证据）', '周围 48 格内找不到自然原木，无法执行 —— 记 NOT-REPRODUCED（无目标）');
    } else {
        // 选最近的一处
        const target = logsFound
            .map((v) => ({ v, d: v.distanceTo(bot.entity.position) }))
            .sort((a, b) => a.d - b.d)[0].v;
        const tp = [target.x, target.y, target.z];
        log(`[S3] 选中自然原木 ${tp.join(',')}（距 bot ${bot.entity.position.distanceTo(target).toFixed(1)} 格）`);

        bot.pathfinder.setGoal(new pf.goals.GoalNear(tp[0], tp[1], tp[2], 2), true);
        const reached = await waitFor(() => bot.entity.position.distanceTo(target) < 4.5, { timeoutMs: 30000, intervalMs: 400 });
        bot.pathfinder.setGoal(null);
        await sleep(400);
        h.check('S3 走到自然树旁边（前置）', reached, `实际距离 ${bot.entity.position.distanceTo(target).toFixed(2)} 格`);

        await h.rc('kill @e[type=item,distance=..32]').catch(() => {});
        await sleep(400);
        // 先取到方块名（挖完就变 air，名字只能挖之前取）
        const block = bot.blockAt(target);
        const targetName = block ? block.name : 'unknown';
        const beforeItem = itemCount(bot, targetName);
        const beforeServer = await serverItemCount(h.rc, tp, 10);
        let digErr = null;
        try { await bot.dig(block, true); } catch (e) { digErr = String(e?.message ?? e).slice(0, 200); }
        await waitFor(async () => (await serverItemCount(h.rc, tp, 10)) > beforeServer, { timeoutMs: 5000, intervalMs: 300 });
        await sleep(1000);
        const afterServer = await serverItemCount(h.rc, tp, 10);
        const afterItem = itemCount(bot, targetName);
        const becameAir = /Test passed/i.test(String(await h.rc(`execute if block ${tp[0]} ${tp[1]} ${tp[2]} minecraft:air`)));
        log(`[S3] 挖 ${targetName} @ ${tp.join(',')}：变 air=${becameAir}；服务端 item ${beforeServer}→${afterServer}；背包 ${targetName} ${beforeItem}→${afterItem}${digErr ? ' digErr=' + digErr : ''}`);
        const logBiome = await h.rc(`execute if biome ${tp[0]} ${tp[1]} ${tp[2]} #minecraft:is_forest`);
        h.check('S3 落点属于森林类生物群系（#minecraft:is_forest）', biomeHit || /Test passed/i.test(String(logBiome)),
            `探针：${biomeProbes.map((b) => `(${b.x},${b.y},${b.z})=${b.raw}`).join(' | ')}；原木位置 (${tp.join(',')}) → ${String(logBiome).trim()}`);
        h.check('S3 C-④ 自然森林：方块变 air', becameAir, `execute if block → ${becameAir}`);
        h.check('S3 C-④ 自然森林：掉落物双证据（服务端 item 或 背包增量）',
            (afterServer > beforeServer) || (afterItem > beforeItem),
            `服务端 item ${beforeServer}→${afterServer}，背包 ${beforeItem}→${afterItem}${digErr ? '，dig 异常：' + digErr : ''}`);
    }

} catch (e) {
    h.fail('S3 场景执行未抛异常', String(e?.stack ?? e).slice(0, 1500));
} finally {
    const stopped = await h.stop(120000);
    h.check('S3 停服：RCON stop → java 进程退出', stopped === true, `java pid ${h.childPid}`);
    const s = h.summary();
    console.log(`\n[证据] server.log: ${h.logPath}`);
    process.exit(s.bad.length ? 1 : 0);
}
