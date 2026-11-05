/**
 * 第21条回归：attackNearest / attackEntity **不许打玩家**，而且不许"先装备武器、
 * 先挥一下，然后才说拒绝"——拒绝必须发生在任何副作用之前。
 *
 * 背景（报告 v2.1 第21条，已实测）：skills.js 全文零引用 isAttackable（grep=0），
 * 于是 `attackNearest(bot,'player')` 会找到玩家、`attackEntity` 会直接 pvp.attack。
 * 判据的唯一真相是 act_attack.isAttackable()，这里就是验它真的接上了。
 *
 * 不需要服务器：假 bot + 假实体，只看「有没有挥击 / 有没有装备 / 返回值」。
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import Vec3 from 'vec3';

// 模块路径可用 SKILLS_MODULE 覆盖 —— 只为「反向验证」用：
// 把修复前的 skills.js 副本指进来，本测试必须变红；否则它只是在自证。
const MODULE = process.env.SKILLS_MODULE ?? '../src/agent/library/skills.js';
const { attackNearest, attackEntity } = await import(MODULE);

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${actual}`); };

console.log(`被测模块：${MODULE}`);

/**
 * 给"可能永远不返回"的调用套一个上限。
 *
 * 为什么需要：修复前 `attackEntity(bot, 玩家, kill=true)` 会进 `bot.pvp.attack()` 的
 * `while (实体还在附近) sleep 1s` 死等 —— 假 bot 里那个实体永远不会消失。
 * 反向验证时如果不设上限，本测试就会挂住而不是"变红"，那就等于没有证据。
 */
async function withTimeout(p, ms = 3000) {
    let timer = null;
    try {
        return await Promise.race([
            // 抛错也当成"有结论"收下（超时之后旧代码残留的异步还可能抛，别让它在后台炸掉进程）
            Promise.resolve(p).then(
                (v) => ({ done: true, value: v }),
                (e) => ({ done: true, value: `抛错: ${e?.message ?? e}` })),
            new Promise((res) => { timer = setTimeout(() => res({ done: false, value: undefined }), ms); }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** 假 bot：把「会被观察到的副作用」全部换成计数器。 */
function makeBot(nearby = []) {
    const side = { swings: [], pvp: [], equips: 0 };
    const entities = {};
    nearby.forEach((e, i) => { entities[String(i + 1)] = e; });
    const bot = {
        username: 'unit_skills_attack_guard',
        entity: { position: new Vec3(0, 64, 0) },
        entities,
        inventory: { items: () => [], slots: [] },
        modes: { isOn: () => false, pause: () => {}, unpause: () => {} },
        attack: (e) => { side.swings.push(e); },
        // 真 bot.equip() 返回 Promise（skills.equip 里是 `await bot.equip(...)`）。
        // 这里照样返回 Promise，但不写成 async —— 假实现里没有要 await 的东西，
        // 写成 async 会踩本仓 require-await（lint 棘轮 278→279）。
        equip: () => { side.equips++; return Promise.resolve(true); },
        pvp: { attack: (e) => { side.pvp.push(e); }, stop: () => {} },
        output: '',
    };
    return { bot, side };
}

/** 玩家实体：mineflayer 里 type 是 'player'（见 act_attack.js 顶部注释）。 */
const playerEntity = (x = 2) => ({
    name: 'player', type: 'player', isValid: true,
    position: new Vec3(x, 64, 0), username: 'Steve',
});
/** 敌对生物：type='hostile'（不是 'mob'，别写错）。 */
const zombieEntity = (x = 2) => ({
    name: 'zombie', type: 'hostile', isValid: true, health: 20,
    position: new Vec3(x, 64, 0),
});
/** 掉落物/盔甲架这类"非活体"，同样不该打。 */
const itemEntity = (x = 2) => ({
    name: 'item', type: 'item', isValid: true,
    position: new Vec3(x, 64, 0),
});

// ── 1. attackNearest('player')：先过滤再 find ⇒ 找不到目标，返回 false 且零副作用 ──
{
    const { bot, side } = makeBot([playerEntity()]);
    const r = await withTimeout(attackNearest(bot, 'player'));
    const clean = r.done && r.value === false && side.swings.length === 0 && side.pvp.length === 0 && side.equips === 0;
    if (clean) okCase('attackNearest 不攻击玩家', '返回 false、挥击 0、pvp 0、装备 0');
    else badCase('attackNearest 不攻击玩家',
        `返回=${r.done ? r.value : '超时（旧版会在 pvp 死等循环里挂住）'} swings=${side.swings.length} pvp=${side.pvp.length} equips=${side.equips}`);
}

// ── 2. attackNearest('armor_stand')：非活体类别同样被过滤 ─────────────────
{
    const armorStand = { name: 'armor_stand', type: 'armor_stand', isValid: true, position: new Vec3(3, 64, 0) };
    const { bot, side } = makeBot([armorStand]);
    const r = await withTimeout(attackNearest(bot, 'armor_stand'));
    if (r.done && r.value === false && side.swings.length === 0) okCase('attackNearest 不攻击盔甲架', '返回 false、挥击 0');
    else badCase('attackNearest 不攻击盔甲架', `返回=${r.done ? r.value : '超时'} swings=${side.swings.length}`);
}

// ── 3. attackEntity(玩家)：拒绝发生在 pvp/装备/挥击之前 ──────────────────
{
    const { bot, side } = makeBot([playerEntity()]);
    const r = await withTimeout(attackEntity(bot, playerEntity(), true));
    const logged = /Refusing to attack/.test(bot.output);
    if (r.done && r.value === false && side.swings.length === 0 && side.pvp.length === 0 && side.equips === 0 && logged) {
        okCase('attackEntity 不攻击玩家', '返回 false、零副作用、日志含 Refusing');
    } else {
        badCase('attackEntity 不攻击玩家',
            `返回=${r.done ? r.value : '超时（旧版进了 pvp 死等循环）'} swings=${side.swings.length} pvp=${side.pvp.length} equips=${side.equips} logged=${logged}`);
    }
}

// ── 4. attackEntity(掉落物)：非活体也拒绝 ────────────────────────────────
{
    const { bot, side } = makeBot([itemEntity()]);
    const r = await attackEntity(bot, itemEntity(), false);
    if (r === false && side.swings.length === 0) okCase('attackEntity 不攻击掉落物', '返回 false、挥击 0');
    else badCase('attackEntity 不攻击掉落物', `r=${r} swings=${side.swings.length}`);
}

// ── 5. 反向对照：僵尸照打（闸不能宽到把该打的也拦了）─────────────────────
{
    // kill=false ⇒ 只挥一次，不会进 pvp 循环（那循环会等实体消失，假 bot 里会挂住）
    const { bot, side } = makeBot([zombieEntity()]);
    await attackEntity(bot, zombieEntity(), false);
    if (side.swings.length === 1) okCase('对照组：attackEntity 仍然打僵尸', '挥击 1 次');
    else badCase('对照组：attackEntity 仍然打僵尸', `swings=${side.swings.length}`);
}

// ── 6. 反向对照：attackNearest('zombie') 仍然能找到并攻击 ────────────────
{
    const { bot, side } = makeBot([zombieEntity()]);
    await attackNearest(bot, 'zombie', false);
    if (side.swings.length === 1) okCase('对照组：attackNearest 仍然打僵尸', '挥击 1 次');
    else badCase('对照组：attackNearest 仍然打僵尸', `swings=${side.swings.length}`);
}

// ── 7. 同一个视野里既有玩家又有僵尸：只打僵尸 ────────────────────────────
{
    const { bot, side } = makeBot([playerEntity(1), zombieEntity(2)]);
    await attackNearest(bot, 'player', false);   // 按名字找玩家：必须拒绝
    const playerSwings = side.swings.filter((e) => e?.type === 'player').length;
    if (playerSwings === 0) okCase('玩家与僵尸同屏时按名字找玩家也不打', `挥击目标数=${side.swings.length}`);
    else badCase('玩家与僵尸同屏时按名字找玩家也不打', `playerSwings=${playerSwings}`);
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
