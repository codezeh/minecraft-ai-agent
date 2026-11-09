/**
 * 诊断（不是断言）：S1 的 B 段 `collect` 返回 NO_TARGET / 跳过 8 处，到底是
 *   「探针摆的场地不可站」还是「产品选目标有缺陷」。
 * 直接 dump planCollect 的 skipped 原因 + canStand 逐格结论 + bot 读到的方块。
 */
import { createHarness, makeBot, sleep, posStr } from './harness.mjs';
import { src, dep } from './harness.mjs';

const SCENARIO = 's1b-diag';
const NAME = 'r5d' + (Date.now() % 100000);
const h = await createHarness({ scenario: SCENARIO, levelType: 'flat' });
try {
    await h.boot();
    const bot = await makeBot({ name: NAME });
    const { canStand } = await src('src/agent/library/query_stand.js');
    const { planCollect } = await src('src/agent/library/flow_collect_plan.js');
    const Vec3 = dep('vec3');

    const p = bot.entity.position.floored();
    console.log(`bot 位置 ${posStr([p.x, p.y, p.z])}`);
    await h.rc(`fill ${p.x - 2} ${p.y - 1} ${p.z - 2} ${p.x + 12} ${p.y - 1} ${p.z + 2} grass_block`);
    await h.rc(`fill ${p.x - 2} ${p.y} ${p.z - 2} ${p.x + 12} ${p.y + 4} ${p.z + 2} air`);
    for (let i = 0; i < 8; i++) {
        const r = String(await h.rc(`setblock ${p.x + 2 + i} ${p.y} ${p.z} oak_log`));
        if (i < 2) console.log(`setblock 原木 #${i} → ${r.trim()}`);
    }
    await sleep(1500);

    const lx = p.x + 2, ly = p.y, lz = p.z;
    const at = (x, y, z) => {
        const b = bot.blockAt(new Vec3(x, y, z));
        return b ? b.name : 'null';
    };
    console.log(`\n[读数] 原木 (${lx},${ly},${lz}) = ${at(lx, ly, lz)}`);
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]]) {
        console.log(`  邻格 (${dx},${dy},${dz}) → 方块=${at(lx + dx, ly + dy, lz + dz)}  canStand=${JSON.stringify(canStand(bot, { x: lx + dx, y: ly + dy, z: lz + dz }).data ?? canStand(bot, { x: lx + dx, y: ly + dy, z: lz + dz }))}`);
    }
    console.log(`[读数] bot 脚下支撑 (${Math.floor(bot.entity.position.x)},${ly - 1},${Math.floor(bot.entity.position.z)}) = ${at(Math.floor(bot.entity.position.x), ly - 1, Math.floor(bot.entity.position.z))}`);

    const plan = planCollect(bot, { blockNames: ['oak_log'], want: 8, maxTargets: 8, skip: new Set(), onEvent: () => {} });
    console.log(`\n[planCollect] ok=${plan.ok} code=${plan.code ?? ''} msg=${plan.message ?? ''}`);
    if (plan.data) {
        console.log(`  planned=${plan.data.planned} steps=${plan.data.steps?.length} skipped=${JSON.stringify(plan.data.skipped).slice(0, 1200)}`);
    }
    const plan2 = planCollect(bot, { blockNames: ['oak_log'], want: 8, maxTargets: 8, skip: new Set(), mapDir: null, onEvent: () => {} });
    console.log(`[planCollect 二次] ok=${plan2.ok} msg=${plan2.message ?? ''}`);
    void canStand; void plan2;
} catch (e) {
    console.log('DIAG 异常：', String(e?.stack ?? e).slice(0, 1500));
} finally {
    await h.stop();
    console.log(`server.log: ${h.logPath}`);
    process.exit(0);
}
