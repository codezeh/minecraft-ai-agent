// 实测：服务端真正接受的挖掘交互距离边界。
// mineflayer 客户端认为 ≤5.1 能挖（digging.js:221），但服务端可能更严。
// 方法：在精确构造的距离上放原木，逐个尝试 dig，看哪些成功。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { EYE_HEIGHT } from '../src/agent/rules/rules.runtime.js';   // rule:R2-01

const Vec3 = (await import('vec3')).Vec3;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });

// 用新账号，避免旧位置污染
const NAME = 'reach' + (Date.now() % 10000);

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: NAME, auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', (e) => console.log('ERR', e.message));
bot.on('kicked', (r) => console.log('KICKED', String(r).slice(0, 80)));

bot.once('spawn', async () => {
    await sleep(3000);
    await RC(`op ${NAME}`);
    await RC(`gamemode survival ${NAME}`);
    await RC(`clear ${NAME}`);
    await RC(`give ${NAME} iron_axe 1`);
    await sleep(1200);

    const p = bot.entity.position.floored();
    const Y = p.y;
    console.log(`位置 ${p}，脚 y=${Y}`);

    // 不再铲地造平台（原来 fill 25×25 + bedrock，会破坏主服地形）。
    // 测的是「距离 → dig 是否成功」，与脚下地形无关：直接在站位旁边悬空放原木即可。
    // 而且 R3-02 已证挖方块不需要视线，所以也不依赖遮挡。
    await sleep(500);

    // 重新读位置（fill 之后可能被推）
    // 眼高以运行时为准（mineflayer entities.js:8 PLAYER_EYEHEIGHT），并与规则表交叉核对。
    // 原来这里写死 1.65，比真实值高 0.03，导致距离列系统性偏大 —— 测试里的想象常量也属于 C1 范围。
    const eyeH = bot.entity.eyeHeight ?? EYE_HEIGHT;
    if (Math.abs(eyeH - EYE_HEIGHT) > 1e-6) {
        console.log(`[警告] 运行时眼高 ${eyeH} 与规则表 ${EYE_HEIGHT} 不一致，规则 R2-01 需复核`);
    }
    const eye = bot.entity.position.offset(0, eyeH, 0);
    const base = bot.entity.position.floored();
    console.log(`眼睛 (${eye.x.toFixed(2)}, ${eye.y.toFixed(2)}, ${eye.z.toFixed(2)})\n`);

    // 测试用例：水平 dx + 垂直 dy 组合，覆盖 3.0 ~ 6.0 格
    const cases = [];
    for (const dx of [3, 4, 5, 6]) {
        for (const dy of [0, 1, 2]) {
            cases.push({ dx, dy });
        }
    }

    console.log(`距离计算：方块中心(y+0.5) → 眼睛(y+${eyeH})`);
    console.log('dx  dy | 目标方块坐标            | 实际距离 | dig 结果');
    console.log('-'.repeat(74));

    const results = [];
    for (const { dx, dy } of cases) {
        // 目标方块放在 base.y + dy 那一层（这样方块中心 = base.y+dy+0.5）
        const tx = base.x + dx;
        const ty = base.y + dy;
        const tz = base.z;

        // 先清空再放原木
        await RC(`setblock ${tx} ${ty} ${tz} air`);
        await RC(`setblock ${tx} ${ty} ${tz} oak_log`);
        await sleep(350);

        const block = bot.blockAt(new Vec3(tx, ty, tz));
        if (!block || block.name !== 'oak_log') {
            console.log(`  ${dx}  ${dy} | (${tx},${ty},${tz}) | 放不进去，跳过`);
            continue;
        }

        // 方块中心 → 眼睛的真实距离
        const center = new Vec3(tx + 0.5, ty + 0.5, tz + 0.5);
        const e = bot.entity.position.offset(0, eyeH, 0);
        const dist = center.distanceTo(e);

        // 让 bot 看向方块（dig 需要 lookAt）
        let dug = false, err = '';
        try {
            await bot.lookAt(center, true);
            await Promise.race([
                bot.dig(block),
                sleep(6000).then(() => { throw new Error('dig-timeout'); }),
            ]);
            dug = true;
        } catch (ex) {
            err = String(ex.message).slice(0, 40);
        }
        // 校验真的挖掉了
        await sleep(200);
        const after = bot.blockAt(new Vec3(tx, ty, tz));
        const gone = !after || after.name !== 'oak_log';
        const ok = dug && gone;

        results.push({ dx, dy, dist, ok, err });
        console.log(`  ${String(dx).padEnd(2)} ${String(dy).padEnd(2)} | (${tx},${ty},${tz}) | ${dist.toFixed(2).padStart(6)} 格 | ${ok ? '✅ 成功' : '❌ 失败' + (err ? ' ' + err : '')}`);
        await sleep(200);
    }

    // 分析边界
    console.log('\n=== 边界分析 ===');
    const okList = results.filter(r => r.ok).sort((a, b) => b.dist - a.dist);
    const failList = results.filter(r => !r.ok).sort((a, b) => a.dist - b.dist);
    if (okList.length) console.log(`  最远的成功距离: ${okList[0].dist.toFixed(2)} 格`);
    if (failList.length) console.log(`  最近的失败距离: ${failList[0].dist.toFixed(2)} 格`);
    if (okList.length && failList.length) {
        console.log(`\n  → 服务端实际边界在 ${okList[0].dist.toFixed(2)} ~ ${failList[0].dist.toFixed(2)} 之间`);
        console.log(`  → mineflayer 客户端阈值是 5.1`);
        console.log(`  → 建议原子用 ${Math.min(okList[0].dist, 5.1).toFixed(2)} 作为可达阈值`);
    }

    bot.quit();
    process.exit(0);
});
