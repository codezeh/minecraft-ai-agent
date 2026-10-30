// 实测：射线被方块挡住时，bot.dig 能不能挖到后面的方块？
// 这决定 digBlock 的射线检查该是硬性拒绝还是软化处理。
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';

const Vec3 = (await import('vec3')).Vec3;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25575 });
const NAME = 'ray' + (Date.now() % 10000);

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: NAME, auth: 'offline', version: '1.21.8' });
bot.loadPlugin(pf.pathfinder);
bot.on('error', () => { });
bot.on('kicked', (r) => console.log('KICKED', String(r).slice(0, 60)));

bot.once('spawn', async () => {
    await sleep(3000);
    await RC(`op ${NAME}`);
    await RC(`gamemode survival ${NAME}`);
    await RC(`clear ${NAME}`);
    await RC(`give ${NAME} iron_axe 1`);
    await sleep(1200);

    const p = bot.entity.position.floored();
    const Y = p.y;
    // 清出平台
    await RC(`fill ${p.x - 10} ${Y - 1} ${p.z - 10} ${p.x + 10} ${Y - 1} ${p.z + 10} stone`);
    await RC(`fill ${p.x - 10} ${Y} ${p.z - 10} ${p.x + 10} ${Y + 4} ${p.z + 10} air`);
    await sleep(1800);

    const base = bot.entity.position.floored();
    console.log(`位置 ${base}\n`);

    // 场景：目标原木在 3 格外，中间 1 格放树叶挡住视线
    const TX = base.x + 3, TY = base.y + 1, TZ = base.z;
    const BLOCK_X = base.x + 2;   // 挡在中间

    console.log('=== 场景 A：视线无遮挡 ===');
    await RC(`setblock ${BLOCK_X} ${TY} ${TZ} air`);
    await RC(`setblock ${TX} ${TY} ${TZ} oak_log`);
    await sleep(500);
    let blk = bot.blockAt(new Vec3(TX, TY, TZ));
    console.log(`  目标 = ${blk?.name}`);
    // 用 mineflayer 的 raycast 看能不能看到
    const eye = bot.entity.position.offset(0, bot.entity.eyeHeight, 0);
    const targetCenter = new Vec3(TX + 0.5, TY + 0.5, TZ + 0.5);
    let hit = bot.world.raycast(eye, targetCenter.minus(eye).normalize(), 5.1);
    console.log(`  raycast 命中: ${hit?.name ?? '未命中'} @ ${hit?.position?.toString() ?? '-'}`);
    let dug = false, err = '';
    try {
        await bot.lookAt(targetCenter, true);
        await Promise.race([bot.dig(blk), sleep(6000).then(() => { throw new Error('timeout'); })]);
        dug = true;
    } catch (e) { err = e.message.slice(0, 40); }
    await sleep(300);
    const afterA = bot.blockAt(new Vec3(TX, TY, TZ));
    console.log(`  dig: ${dug ? 'OK' : 'FAIL ' + err}，挖后 = ${afterA?.name} → ${!afterA || afterA.name !== 'oak_log' ? '✅ 挖到了' : '❌ 没挖到'}`);

    console.log('\n=== 场景 B：中间放树叶挡住视线 ===');
    await RC(`setblock ${TX} ${TY} ${TZ} air`);
    await RC(`setblock ${BLOCK_X} ${TY} ${TZ} oak_leaves`);
    await RC(`setblock ${TX} ${TY} ${TZ} oak_log`);
    await sleep(600);
    blk = bot.blockAt(new Vec3(TX, TY, TZ));
    hit = bot.world.raycast(eye, targetCenter.minus(eye).normalize(), 5.1);
    console.log(`  目标 = ${blk?.name}，中间 = ${bot.blockAt(new Vec3(BLOCK_X, TY, TZ))?.name}`);
    console.log(`  raycast 命中: ${hit?.name ?? '未命中'} @ ${hit?.position?.toString() ?? '-'}  ← 应该是 oak_leaves`);
    dug = false; err = '';
    try {
        await bot.lookAt(targetCenter, true);
        await Promise.race([bot.dig(blk), sleep(6000).then(() => { throw new Error('timeout'); })]);
        dug = true;
    } catch (e) { err = e.message.slice(0, 40); }
    await sleep(300);
    const afterB = bot.blockAt(new Vec3(TX, TY, TZ));
    const gotB = !afterB || afterB.name !== 'oak_log';
    console.log(`  dig: ${dug ? 'OK' : 'FAIL ' + err}，挖后 = ${afterB?.name} → ${gotB ? '✅ 挖到了（射线被挡也能挖！）' : '❌ 没挖到（射线挡住就挖不了）'}`);

    bot.quit();
    process.exit(0);
});
