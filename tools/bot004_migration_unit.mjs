/**
 * BOT-004（2026-11-06 深度检查）—— 旧记忆迁移在 bot 初始化前运行，错读 agent 默认目录。
 *
 * 缺陷原貌（`Agent._migrateSharedOnce`）：
 *   ① `start()` 里板一连上就调 `_migrateSharedOnce()`，而 `this.bot = initBot(...)` 在
 *      几百行之后 → `mem.readStore(this.bot=undefined, ns)` → `memoryDir()` 回落成
 *      用户名 `'agent'` → **每只机器人都在读 `bots/agent/memory/*`**。
 *      报告验证：夹具 `deepseek/sites.x=22`、`agent/sites.x=11`，真实迁移只导入了 11。
 *   ② 幂等判据是"板库里该 kind 有**任意**一条就 `continue` 整个 kind"，且
 *      `_sharedMigrated` 在 try **之前**就置 true → 第一个机器人搬完后，后面启动的
 *      机器人永远不迁自己的旧数据；一次失败也永不重试。
 *
 * 修法：显式以**确定的登录名**读旧目录；幂等改成 (kind, key) 逐条判；成功后才写标记。
 *
 * 全部离线：bots 根指到系统临时目录（MC_BOTS_ROOT），不碰真实 bots/。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bot004-'));
process.env.MC_BOTS_ROOT = TMP_ROOT;

// ★ 必须在设置 MC_BOTS_ROOT 之后再 import（memory_store 经 bot_paths 读它）
const { Agent } = await import('../src/agent/agent.js');

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS ${name} ${detail}`); }
    else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

/** 在临时 bots 根下造一份旧分域文件（= 报告夹具的形状）。 */
function seedLegacy(username, { sites = [], dangers = [], chests = [] } = {}) {
    const dir = path.join(TMP_ROOT, username, 'memory');
    fs.mkdirSync(dir, { recursive: true });
    if (sites.length) fs.writeFileSync(path.join(dir, 'sites.json'), JSON.stringify({ _v: 1, data: sites }), 'utf8');
    if (dangers.length) fs.writeFileSync(path.join(dir, 'dangers.json'), JSON.stringify({ _v: 1, data: dangers }), 'utf8');
    if (chests.length) fs.writeFileSync(path.join(dir, 'chests.json'), JSON.stringify({ _v: 1, data: chests }), 'utf8');
}

/** 假任务板：只实现迁移会用到的三个接口，并把写入记账。 */
function makeBoard({ failPut = false, seeded = [] } = {}) {
    const puts = [];
    const rows = [...seeded];          // 板上已有的共享数据（{kind,key,value}）
    return {
        puts,
        board: {
            async sharedList(kind) {
                return { ok: true, data: { items: rows.filter((r) => r.kind === kind) } };
            },
            async sharedPut(kind, key, value) {
                if (failPut) throw new Error('板写失败（模拟断线）');
                puts.push({ kind, key, value });
                rows.push({ kind, key, value });
                return { ok: true };
            },
        },
    };
}

/** 造一个只缺 bot 的假 agent（正是"迁移跑在 initBot 之前"那一刻的形状）。 */
const makeAgent = (name) => ({ name });

// ══════════════════════════════════════════════════════════════════════
// 夹具：deepseek 有 (22,64,22)，agent 有 (11,64,11) —— 与报告一致
// ══════════════════════════════════════════════════════════════════════
seedLegacy('deepseek', {
    sites: [{ x: 22, y: 64, z: 22, name: 'deepseek-place' }],
    dangers: [{ x: 22, y: 64, z: 22, reason: 'lava' }],
    chests: [{ x: 22, y: 64, z: 22, note: 'deepseek chest', contents: { coal: 5 } }],
});
seedLegacy('agent', {
    sites: [{ x: 11, y: 64, z: 11, name: 'test-agent-place' }],
});

// ══════════════════════════════════════════════════════════════════════
// ① 报告复现：deepseek 必须迁自己的（x=22），不许读到 agent 的（x=11）
// ══════════════════════════════════════════════════════════════════════
{
    const { board, puts } = makeBoard();
    const a = { ...makeAgent('deepseek'), board };
    // this.bot **还没建**（报告里的真实时序）——修法要求显式传登录名
    await Agent.prototype._migrateSharedOnce.call(a, 'deepseek');

    const siteXs = puts.filter((p) => p.kind === 'landmark').map((p) => p.value?.x);
    check('① 迁移的是 deepseek 自己的地点 x=22（修复前读到 agent 的 x=11）',
        siteXs.includes(22), `landmarkX=${JSON.stringify(siteXs)}`);
    check('① 没有把 agent 的地点当成自己的（不许出现 x=11）',
        !siteXs.includes(11), `landmarkX=${JSON.stringify(siteXs)}`);
    check('① 危险点也来自自己的目录',
        puts.some((p) => p.kind === 'danger' && p.value?.x === 22),
        `kinds=${JSON.stringify(puts.map((p) => p.kind))}`);
    check('① 箱子也来自自己的目录（带 contents）',
        puts.some((p) => p.kind === 'chest' && p.value?.pos?.x === 22 && p.value?.items?.coal === 5));
}

// ══════════════════════════════════════════════════════════════════════
// ② 逐来源幂等：板上已有别的 bot 的地标，不许因此跳过自己的
// ══════════════════════════════════════════════════════════════════════
{
    // 板上已经有 deepseek 写过的一条 landmark（第一个 bot 迁完了）
    const seeded = [{ kind: 'landmark', key: 'deepseek-place', value: { x: 22, y: 64, z: 22 } }];
    const { board, puts } = makeBoard({ seeded });
    const a = { ...makeAgent('agent'), board };
    await Agent.prototype._migrateSharedOnce.call(a, 'agent');

    check('② 第二个 bot 仍然迁移了自己的地点 x=11（修复前一票否决整个 kind）',
        puts.some((p) => p.kind === 'landmark' && p.value?.x === 11),
        `putX=${JSON.stringify(puts.filter((p) => p.kind === 'landmark').map((p) => p.value?.x))}`);
    check('② 已有那条 key 不被重复写（幂等按 key 判）',
        !puts.some((p) => p.kind === 'landmark' && p.key === 'deepseek-place'),
        `keys=${JSON.stringify(puts.filter((p) => p.kind === 'landmark').map((p) => p.key))}`);
}

// ══════════════════════════════════════════════════════════════════════
// ③ 同一来源重复迁移：不重复写（幂等）
// ══════════════════════════════════════════════════════════════════════
{
    const { board, puts } = makeBoard();
    const a = { ...makeAgent('deepseek'), board };
    await Agent.prototype._migrateSharedOnce.call(a, 'deepseek');
    const first = puts.length;
    // 同一只 agent 再跑一次（模拟 restart 后重新迁移）
    const a2 = { ...makeAgent('deepseek'), board };
    await Agent.prototype._migrateSharedOnce.call(a2, 'deepseek');
    check('③ 同一来源再跑一次不会重复写（第二次 0 条新增）',
        puts.length === first, `first=${first} total=${puts.length}`);
}

// ══════════════════════════════════════════════════════════════════════
// ④ 失败必须在**成功后**才写标记：写失败 → 下次还能重试
// ══════════════════════════════════════════════════════════════════════
{
    const failing = makeBoard({ failPut: true });
    const a = { ...makeAgent('deepseek'), board: failing.board };
    await Agent.prototype._migrateSharedOnce.call(a, 'deepseek');
    check('④ 写失败时不置"已迁移"标记（修复前 try 之前就置 true）',
        !a._sharedMigrated, `_sharedMigrated=${a._sharedMigrated}`);

    // 板恢复后同一只 agent 再迁一次，必须真的迁成功
    const ok = makeBoard();
    a.board = ok.board;
    await Agent.prototype._migrateSharedOnce.call(a, 'deepseek');
    check('④ 板恢复后重试能成功（失败不是终态）',
        a._sharedMigrated === true && ok.puts.some((p) => p.kind === 'landmark'),
        `migrated=${a._sharedMigrated} puts=${ok.puts.length}`);
}

// ══════════════════════════════════════════════════════════════════════
// ⑤ 已有 this.bot 时优先用它（迁移后挪到 initBot 之后也照样正确）
// ══════════════════════════════════════════════════════════════════════
{
    const { board, puts } = makeBoard();
    const a = { ...makeAgent('deepseek'), board, bot: { username: 'deepseek' } };
    await Agent.prototype._migrateSharedOnce.call(a, 'deepseek');
    check('⑤ 有 this.bot 时按它的用户名读目录（仍是 x=22）',
        puts.some((p) => p.kind === 'landmark' && p.value?.x === 22),
        `x=${JSON.stringify(puts.filter((p) => p.kind === 'landmark').map((p) => p.value?.x))}`);
}

// ══════════════════════════════════════════════════════════════════════
// ⑥ 没有板 → 什么都不做（不抛、不读文件）
// ══════════════════════════════════════════════════════════════════════
{
    const a = { ...makeAgent('deepseek'), board: null };
    let threw = null;
    try { await Agent.prototype._migrateSharedOnce.call(a, 'deepseek'); } catch (e) { threw = e; }
    check('⑥ 没有任务板时迁移静默跳过', threw === null && !a._sharedMigrated, `threw=${threw}`);
}

fs.rmSync(TMP_ROOT, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
