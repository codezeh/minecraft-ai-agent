/**
 * D1 真机场景回归：y 语义（面位 vs 脚位）—— 测试服 25566。
 *
 * 背景：`terrain3d` 存的是**实心方块自己的 y**（面位 S），而 `position.y` 是脚的高度。
 * 站在面 S 上时，脚位 = S + 1（方块 S 的顶面在 S+1，实体就站那儿）。
 * executor 原来两种写法混用：
 *   - 真要上 2 格时 dy 少算 1 → 不进"垫方块"分支 → pathfinder 跳不上 → NO_PATH
 *   - 挖掘循环以 step.y 为终点 → 少挖一格，到不了目标高度
 * 修复后 execStep 统一 `targetFeetY = step.y + 1`。
 *
 * 本脚本在**真服务器**上逐场景验证 [D1] 的核心不变量：
 *
 *   ★ 站在面 S 上时，floor(position.y) === S + 1
 *   ★ execStep 的目标 step.y 是"面"，到达后脚位必须 === step.y + 1
 *
 * ⚠️ 第一版把"面"标成了地板上方那格（GY），实际实心方块在 GY-1，
 *    于是全部错 1 格。这里统一用 SOLID 层的 y 作为"面"。
 *
 * 用法：node tools/verify_d1_live.mjs
 */
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { execStep } from '../src/agent/library/executor.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const NAME = 'd1' + (Date.now() % 100000);

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

async function put(x, y, z) {
    await RC(`tp ${NAME} ${x + 0.5} ${y} ${z + 0.5}`);
    await sleep(1000);
}
const feetY = () => Math.floor(bot.entity.position.y);

bot.once('spawn', async () => {
    await sleep(2500);
    await RC(`op ${NAME}`);
    await RC(`gamemode creative ${NAME}`);
    await sleep(1000);

    const base = bot.entity.position.floored();
    const BX = base.x + 30;
    const BZ = base.z + 30;

    // ★ 统一的"面"定义：地板那层**实心方块**的 y
    const FLOOR = -61;                 // 实心石头在 -61，其顶面在 -60 → 站上去脚位 -60
    const FEET_ON_FLOOR = FLOOR + 1;   // = -60

    // 清场地：FLOOR 以上全空，FLOOR 那层铺石头
    await RC(`fill ${BX - 3} ${FLOOR + 1} ${BZ - 3} ${BX + 16} ${FLOOR + 14} ${BZ + 16} air`);
    await RC(`fill ${BX - 3} ${FLOOR} ${BZ - 3} ${BX + 16} ${FLOOR} ${BZ + 16} stone`);
    await sleep(900);

    // 工具与垫脚材料（挖石头要镐；上 2 格要垫脚方块）
    await RC(`gamemode creative ${NAME}`);
    await RC(`give ${NAME} diamond_pickaxe 1`);
    await RC(`give ${NAME} dirt 64`);
    await RC(`gamemode survival ${NAME}`);
    await sleep(800);

    // ── 场景 1：站在地板面上 → 脚位 = 面 + 1 ─────────────────────────────
    await put(BX, FEET_ON_FLOOR, BZ);
    check('[1] 平地站立：脚位 = 面 + 1', feetY() === FLOOR + 1, `feet=${feetY()} 面=${FLOOR} 期望=${FLOOR + 1}`);

    // ── 场景 2：上 1 格。台阶实心方块在 FLOOR+1 → 面=FLOOR+1 → 脚位应 FLOOR+2 ──
    await RC(`setblock ${BX + 3} ${FLOOR + 1} ${BZ} stone`);
    await sleep(400);
    await put(BX, FEET_ON_FLOOR, BZ);
    const r2 = await execStep(bot, { action: 'jump', x: BX + 3, y: FLOOR + 1, z: BZ }, { onEvent: () => { } });
    check('[2] 上 1 格：脚位 = 目标面 + 1',
        feetY() === FLOOR + 2, `ok=${r2.ok} code=${r2.code} feet=${feetY()} 期望=${FLOOR + 2}`);

    // ── 场景 3：上 2 格。台阶实心在 FLOOR+1..FLOOR+2 → 面=FLOOR+2 → 脚位 FLOOR+3 ──
    await RC(`fill ${BX + 6} ${FLOOR + 1} ${BZ} ${BX + 6} ${FLOOR + 2} ${BZ} stone`);
    await sleep(400);
    await put(BX, FEET_ON_FLOOR, BZ);
    const r3 = await execStep(bot, { action: 'jump', x: BX + 6, y: FLOOR + 2, z: BZ }, { onEvent: () => { } });
    check('[3] 上 2 格（要垫方块）：脚位 = 目标面 + 1',
        feetY() === FLOOR + 3, `ok=${r3.ok} code=${r3.code} feet=${feetY()} 期望=${FLOOR + 3}`);

    // ── 场景 4：同列挖上去 1 格。头顶(脚格)放实心，挖掉后脚位应到 面+1 ──────
    // 她站脚位 FEET_ON_FLOOR=-60；目标面 = FLOOR+1=-60 ？不对。
    // 构造：目标面 = FLOOR（原地），dig 不该让她变高，也不该假成功。
    await put(BX, FEET_ON_FLOOR, BZ);
    const r4 = await execStep(bot, { action: 'dig', x: BX, y: FLOOR, z: BZ }, { onEvent: () => { } });
    check('[4] dig 目标面=脚下：脚位不变（不 false-success）',
        feetY() === FLOOR + 1, `ok=${r4.ok} code=${r4.code} feet=${feetY()} 期望=${FLOOR + 1}`);

    // ── 场景 5：邻列 dig。目标列比当前面高 2 → 只挖通，不许把自己垫上去 ─────
    await RC(`fill ${BX + 9} ${FLOOR + 1} ${BZ} ${BX + 9} ${FLOOR + 3} ${BZ} stone`);
    await sleep(400);
    await put(BX, FEET_ON_FLOOR, BZ);
    const r5 = await execStep(bot, { action: 'dig', x: BX + 9, y: FLOOR + 3, z: BZ }, { onEvent: () => { } });
    check('[5] 邻列 dig：脚位不上浮（站位交给后续 walk）',
        feetY() === FLOOR + 1, `ok=${r5.ok} code=${r5.code} feet=${feetY()} 期望=${FLOOR + 1}`);

    // ── 场景 6：头顶是液体 → 不许假成功 ──────────────────────────────────
    await RC(`setblock ${BX} ${FLOOR + 1} ${BZ} water`);
    await sleep(400);
    await put(BX, FEET_ON_FLOOR, BZ);
    const r6 = await execStep(bot, { action: 'dig', x: BX, y: FLOOR + 3, z: BZ }, { onEvent: () => { } });
    check('[6] 头顶液体不假成功', !r6.ok, `ok=${r6.ok} code=${r6.code}`);
    await RC(`setblock ${BX} ${FLOOR + 1} ${BZ} air`);
    await sleep(400);

    // ── 场景 7：从 2 格高台下来，脚位必须回到 面+1 ────────────────────────
    await RC(`fill ${BX + 12} ${FLOOR + 1} ${BZ} ${BX + 12} ${FLOOR + 2} ${BZ} stone`);
    await sleep(400);
    await put(BX + 12, FLOOR + 3, BZ);                       // 站在高台顶（面=FLOOR+2）
    const r7 = await execStep(bot, { action: 'down', x: BX + 12, y: FLOOR, z: BZ }, { onEvent: () => { } });
    check('[7] 下来后脚位 = 目标面 + 1',
        feetY() === FLOOR + 1, `ok=${r7.ok} code=${r7.code} feet=${feetY()} 期望=${FLOOR + 1}`);

    // ── 场景 8：连续两个 dig step（同列向上），脚位逐格抬升到位 ─────────────
    await put(BX + 14, FEET_ON_FLOOR, BZ);
    // 头顶两格实心；目标面 = FLOOR+2（要爬 2 格）
    await RC(`fill ${BX + 14} ${FLOOR + 1} ${BZ} ${BX + 14} ${FLOOR + 2} ${BZ} stone`);
    await sleep(500);
    await put(BX + 14, FEET_ON_FLOOR, BZ);
    const r8 = await execStep(bot, { action: 'dig', x: BX + 14, y: FLOOR + 2, z: BZ }, { onEvent: () => { } });
    check('[8] 同列挖上 2 格：脚位 = 目标面 + 1',
        feetY() === FLOOR + 3, `ok=${r8.ok} code=${r8.code} feet=${feetY()} 期望=${FLOOR + 3}`);

    console.log('');
    console.log(`D1 真机场景：${pass} PASS / ${fail_} FAIL`);
    console.log('============================================');
    try { bot.quit(); } catch { }
    process.exit(fail_ === 0 ? 0 : 1);
});
