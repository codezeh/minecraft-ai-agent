/**
 * skill_escape 真机验收：把她埋进坑里，看她能不能靠"挖头顶 + 跳垫"爬出来。
 * —— 测试服 25566。
 *
 * 为什么需要：`test_escape.mjs` 只验**规划**（假 bot、离线）。而 2026-11-01 的整改
 * 把执行路径从"手写 跳+换手+放置+重试"换成了原子 `atom_pillar.pillarUpOnce`
 * （重试留在复合层）。这条路径只有真机能验：跳跃顶点、碰撞箱、放置时机都是物理行为。
 *
 * 断言：
 *   1) escapeUp 返回 ok（不是 BLOCKED/NO_ITEM/STUCK）
 *   2) 真的上升了 ≥2 格（不是"报成功但没动"）
 *   3) 返回契约是 ok()/fail() 信封：有 code/message/data，data 里有 doneSteps/fromY/toY
 *
 * 用法：node tools/verify_escape_live.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { escapeUp } from '../src/agent/library/skill_escape.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const NAME = 'es' + (Date.now() % 100000);

let pass = 0, fail_ = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  PASS  ${name}  ${detail}`); }
    else { fail_++; console.log(`  FAIL  ${name}  ${detail}`); }
};

const bot = mineflayer.createBot({
    host: '127.0.0.1', port: 25566, username: NAME, auth: 'offline', version: '1.21.8',
});
bot.loadPlugin(pf.pathfinder);
installPositionGuard(bot);
bot.on('error', () => { });
bot.on('kicked', (r) => console.log('KICKED', JSON.stringify(r).slice(0, 90)));

bot.once('spawn', async () => {
    await sleep(2500);
    await RC(`op ${NAME}`);
    await RC(`gamemode creative ${NAME}`);
    await sleep(1000);

    const base = bot.entity.position.floored();
    // ★ 必须造在**已加载区块**里：远处的 /fill 会静默失败，
    //   第一版放在 +50 格处，坑没造出来，她直接掉到 y=-99。
    const BX = base.x + 5, BZ = base.z + 5;
    // ★ 世界底部在 y≈-64（超平坦 bedrock 层），**不能往下挖坑**：
    //   第一版挖到 -70 属于世界外，/fill 静默失败，她直接掉到 y≈-96。
    //   改成"往上砌石笼"：站在地面，头顶堆石头，四周砌墙 —— 这才是真正的被困。
    const SURF = -60;                  // 脚位（实心方块在 -61）
    const TOP = SURF + 12;             // 石笼顶（她要挖到 SURF+10 以上）

    // 1) 先把她放到地面上的目标位置
    await RC(`tp ${NAME} ${BX + 0.5} ${SURF} ${BZ + 0.5}`);
    await sleep(1200);

    // 2) 砌 5×5 的实心石笼，从她脚下一层一直堆到 TOP
    await RC(`fill ${BX - 2} ${SURF - 1} ${BZ - 2} ${BX + 2} ${TOP} ${BZ + 2} stone`);
    // 3) 把她那一格挖出 1×2 的空腔（脚格 + 头格），其余全是石头
    await RC(`fill ${BX} ${SURF} ${BZ} ${BX} ${SURF + 1} ${BZ} air`);
    await sleep(900);

    // 造完必须验：脚下实心、身上是空、头顶是实心 —— 否则后面全是假失败
    const bFloor = bot.blockAt(new Vec3(BX, SURF - 1, BZ));
    const bFeet = bot.blockAt(new Vec3(BX, SURF, BZ));
    const bHead = bot.blockAt(new Vec3(BX, SURF + 2, BZ));
    check('笼子：脚下实心', !!bFloor && bFloor.name !== 'air', bFloor?.name ?? 'null');
    check('笼子：身上是空', !!bFeet && bFeet.name === 'air', bFeet?.name ?? 'null');
    check('笼子：头顶实心（真的被困）', !!bHead && bHead.name !== 'air', bHead?.name ?? 'null');

    // 给垫脚方块与镐（挖石头）
    await RC(`gamemode creative ${NAME}`);
    await RC(`give ${NAME} cobblestone 64`);
    await RC(`give ${NAME} diamond_pickaxe 1`);
    await RC(`gamemode survival ${NAME}`);
    await sleep(700);

    // 放进笼子（脚位 SURF）
    await RC(`tp ${NAME} ${BX + 0.5} ${SURF} ${BZ + 0.5}`);
    await sleep(1500);
    const y0 = bot.entity.position.y;
    console.log(`  坑底脚位 y=${y0.toFixed(1)}（笼子内）`);

    // 目标：挖到地表以上 2 格
    const targetY = SURF + 10;
    const esc = await escapeUp(bot, {
        targetY,
        maxBlocks: 40,
        onEvent: (e) => {
            if (e.type === 'escape-pillar' && e.attempt > 1) {
                console.log(`    跳垫重试 attempt=${e.attempt} code=${e.code}`);
            }
        },
    });

    const y1 = bot.entity.position.y;
    const climbed = y1 - y0;
    console.log(`  自救结果: ok=${esc.ok} code=${esc.code} y ${y0.toFixed(1)} → ${y1.toFixed(1)}（升 ${climbed.toFixed(1)}）`);

    // ── 断言 ───────────────────────────────────────────────────────────
    check('返回 ok 信封（ok/code/message/data 齐全）',
        typeof esc.ok === 'boolean' && typeof esc.code === 'string' && esc.data !== undefined,
        `code=${esc.code}`);

    check('data 字段在白名单内（doneSteps/fromY/toY/costMs）',
        esc.data && Number.isFinite(esc.data.doneSteps) && Number.isFinite(esc.data.fromY)
        && Number.isFinite(esc.data.toY) && Number.isFinite(esc.data.costMs),
        JSON.stringify({ doneSteps: esc.data?.doneSteps, fromY: esc.data?.fromY, toY: esc.data?.toY }));

    check('真的爬出来了（≥2 格，不是假成功）', climbed >= 2, `升 ${climbed.toFixed(1)} 格`);

    check('escapeUp 报成功', esc.ok === true, `code=${esc.code} msg=${esc.message ?? ''}`);

    // ★ 收尾清场：live 测试共享同一个世界，别把石笼留给后面的测试。
    //   （实测踩过：残留方块让 vine_physics_test 的"爬模式"测出升高 0 格）
    try {
        await RC(`fill ${BX - 3} ${SURF - 2} ${BZ - 3} ${BX + 3} ${TOP + 2} ${BZ + 3} air`);
        await RC(`fill ${BX - 3} ${SURF - 1} ${BZ - 3} ${BX + 3} ${SURF - 1} ${BZ + 3} stone`);
    } catch { /* 清不掉不影响结论 */ }

    console.log('');
    console.log(`skill_escape 真机：${pass} PASS / ${fail_} FAIL`);
    console.log('============================================');
    try { bot.quit(); } catch { }
    process.exit(fail_ === 0 ? 0 : 1);
});
