/**
 * 第15条 的**失败反证**（A/B 对拍）：同一张合成单「做出东西 → 中断 → 重试」，
 * **改前库存被扣两次 / 改后只扣一次**。
 *
 * 做法：把 `<OLD_REF>` 版的 `board_store.js`（改前）整份取到 `tmp/ledger_probe_old/`，
 * 与**工作区**版（改后）跑**同一个**世界模型：
 *
 * ★ `OLD_REF` **钉死在"修复前"的那个提交**上（默认 `7350dda`），不是 `HEAD`。
 *   用 `HEAD` 的话，这次修复一提交，A-反证 就会对着"已含修复的代码"跑、自己变绿/变红，
 *   反证就废了。要重跑历史别的对照：`node tools/craft_retry_ledger_ab.mjs --old=<sha>`。
 *
 *   世界模型（和真机同形）：
 *     · 一张 `craft:oak_planks x3` 的单
 *     · 每跑一次流程 = **吃掉 3 个 oak_log、产出 3 块 oak_planks**（料先扣，产物进背包）
 *     · 第 1 次尝试：产出 3 块后**被中断**（`bot.craft` 已 resolve、料已真扣，
 *       然后收到 `!stop` / 抢占 —— 真机里就是这条 `flow_craft` 返回 `INTERRUPTED`）
 *     · 之后只要单子还能被领到，就再跑一次（真机里就是租约过期/回 ready 后被重领）
 *
 *   判定：**总共被扣了几份料**（= 跑了几次流程 × 3 个原木）。
 *
 * 另外附一个 B 场景（**本修复覆盖不到**的那种崩溃，如实说明）：
 *   进程在 finish 之前被 SIGKILL —— 这次产出根本没记账，新旧都只能重做一份。
 *
 * 用法：node tools/craft_retry_ledger_ab.mjs [--old=<git-ref>]
 * 输出：每个场景一行 PASS/FAIL + 明细；有 FAIL 退出码 1。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';

const ROOT = process.cwd();
const LIB = join(ROOT, 'src', 'agent', 'library');
const OLD_DIR = join(ROOT, 'tmp', 'ledger_probe_old');

/** 「改前」的参照提交：**修复前**的那个 commit（钉死，不跟着 HEAD 漂）。可用 `--old=<ref>` 覆盖。 */
const OLD_REF_DEFAULT = '7350dda2a6793541c653085f2e621ffad4b3ef5c';
const OLD_REF = (process.argv.find((a) => a.startsWith('--old=')) ?? '').slice('--old='.length) || OLD_REF_DEFAULT;

/** 把 `OLD_REF` 版 board_store + 它依赖的两个无依赖小模块取到 OLD_DIR（**改前**的真代码，不是我复述的规则）。 */
function materializeOldStore() {
    rmSync(OLD_DIR, { recursive: true, force: true });
    mkdirSync(OLD_DIR, { recursive: true });
    for (const f of ['board_store.js', 'bot_paths.js', 'board_claims.js']) {
        const src = execFileSync('git', ['show', `${OLD_REF}:src/agent/library/${f}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
        // 老文件的相对 import 是 `./bot_paths.js` / `./board_claims.js` → 同名 .js 落盘最省事
        writeFileSync(join(OLD_DIR, f), src, 'utf8');
    }
    return join(OLD_DIR, 'board_store.js');
}

let pass = 0, fail = 0;
const okCase = (name, ev = '') => { pass++; console.log(`PASS ${name} ${ev}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

/**
 * 跑一遍世界模型。`store` = board_store 模块（老/新同签名）。
 * @returns {{runs:number, logsLeft:number, planksMade:number, states:string[]}}
 */
function runWorld(store, { tag }) {
    const dir = join(os.tmpdir(), `craft-retry-probe-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const { db } = store.openBoard(dir);
    const job = store.addJob(db, {
        title: 'planks', skill: 'craft', state: 'ready', maxAttempts: 3,
        args: { item: 'oak_planks', count: 3 },
        progress: { count: 0, want: 3 },
    });

    let logsLeft = 12;          // 背包里 12 个原木
    let planksMade = 0;
    let runs = 0;
    const states = [];
    let now = 1_000_000;

    for (let round = 0; round < 4; round++) {
        // ── 领单（真机：claimFor 之前还会先做一次 convergeIfSatisfied 清扫）──
        const claimed = store.claimFor(db, 'A', { now });
        if (!claimed) break;                     // 没有可派的单 → 这一轮没有扣料
        runs += 1;

        // ── 跑一次流程：先扣料，再产出（顺序与真机一致）──
        logsLeft -= 3;
        planksMade += 3;

        // ── 第 1 次尝试：产出 3 块之后被中断；之后（如果能重试）就正常做完 ──
        const interrupted = round === 0;
        const result = interrupted
            ? {
                ok: false, code: 'INTERRUPTED', message: '被取消了（模拟中断：!stop / 抢占）',
                progress: { count: 3, want: 3 },
                data: { item: 'oak_planks', produced: 3, producedTotal: 3 },
            }
            : {
                ok: true, code: 'OK', message: '合成完成',
                progress: { count: 3, want: 3 },
                data: { item: 'oak_planks', produced: 3, producedTotal: 3, count: 3, want: 3 },
            };
        const r = store.finish(db, claimed.id, result, { now: now + 1000, bot: 'A' });
        now += 2000;
        const after = store.getJob(db, claimed.id);
        states.push(`${after?.state}${r?.ok === false ? `(${r.code})` : ''}`);
        if (after?.state !== 'ready') break;      // done/failed/blocked → 不会再跑
    }
    // Windows 上 sqlite 的文件句柄可能还没释放 → 删不掉不算错（临时目录留着即可）
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    void job;
    return { runs, logsLeft, planksMade, states };
}

// ══════════════════════════════════════════════════════════════════════════
// A 场景：「做出东西 → 中断 → 重试」（本次修复的目标场景）
// ══════════════════════════════════════════════════════════════════════════
console.log(`══════ A 场景：craft:oak_planks x3 → 产出 3 块后被中断 → 还允许重试 ══════`);
console.log(`  改前的参照提交：${OLD_REF}`);
const oldPath = materializeOldStore();
const oldStore = await import(pathToFileURL(oldPath).href);
const newStore = await import(pathToFileURL(join(LIB, 'board_store.js')).href);

const before = runWorld(oldStore, { tag: 'old' });
const after = runWorld(newStore, { tag: 'new' });

console.log(`  改前（${OLD_REF.slice(0, 8)} 版 board_store）：跑了 ${before.runs} 次 → 扣料 ${before.runs * 3} 个原木，产出 ${before.planksMade} 块板（目标 3）｜状态链 ${before.states.join(' → ')}`);
console.log(`  改后（工作区版 board_store）：跑了 ${after.runs} 次 → 扣料 ${after.runs * 3} 个原木，产出 ${after.planksMade} 块板（目标 3）｜状态链 ${after.states.join(' → ')}`);

if (before.runs === 2 && before.logsLeft === 6) {
    okCase('A-反证：**改前**同一张单被跑了两遍 → 材料被真扣两次（6 个原木）', `runs=${before.runs} logsLeft=${before.logsLeft}`);
} else {
    badCase('A-反证：改前的行为与本报告描述不符（反证失效，不能用来证明修复）', before);
}
if (after.runs === 1 && after.logsLeft === 9) {
    okCase('A-修复：**改后**只跑一遍 → 材料只扣一次（3 个原木），单子直接 done', `runs=${after.runs} logsLeft=${after.logsLeft}`);
} else {
    badCase('A-修复：改后仍然重复扣料', after);
}

// ══════════════════════════════════════════════════════════════════════════
// B 场景（**覆盖不到**，如实记录）：进程在 finish 之前就被 SIGKILL
//   这次尝试的产出没有任何落库时机 → 新旧版都会重做一份。
//   ⇒ 这不是"修好了"，是**已知残余**，要彻底消掉得按 E6 把 ctx/jobId 透传给 flow_craft，
//     在每次 craftOnce 之后写 checkpoint（超出本单边界，已写进文档交给 captain 排期）。
// ══════════════════════════════════════════════════════════════════════════
console.log('');
console.log('══════ B 场景（已知残余）：产出后**进程直接被杀**，从没走到 finish ══════');
{
    const dir = join(os.tmpdir(), `craft-retry-probe-kill-${Date.now()}`);
    const { db } = newStore.openBoard(dir);
    newStore.addJob(db, {
        title: 'planks', skill: 'craft', state: 'ready', maxAttempts: 3,
        args: { item: 'oak_planks', count: 3 }, progress: { count: 0, want: 3 },
    });
    let logsLeft = 12, runs = 0;
    // 第 1 次：领到 → 扣料 → **被杀**（不调 finish）
    const c1 = newStore.claimFor(db, 'A', { now: 1_000_000 });
    if (c1) { runs++; logsLeft -= 3; }
    // 租约过期 → 回 ready
    newStore.expireLeases(db, 1_000_000 + 10 * 60 * 1000);
    // 第 2 次：重领 → 再扣一次料 → 这次正常 finish
    const c2 = newStore.claimFor(db, 'A', { now: 1_000_000 + 11 * 60 * 1000 });
    if (c2) {
        runs++; logsLeft -= 3;
        newStore.finish(db, c2.id, {
            ok: true, code: 'OK', progress: { count: 3, want: 3 },
            data: { item: 'oak_planks', produced: 3, producedTotal: 3, count: 3, want: 3 },
        }, { now: 1_000_000 + 11 * 60 * 1000 + 1000, bot: 'A' });
    }
    const j = newStore.getJob(db, c2?.id ?? c1?.id);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log(`  改后：跑了 ${runs} 次 → 扣料 ${runs * 3} 个原木（第一次的产出没机会记账）｜state=${j?.state} producedTotal=${j?.checkpoint?.producedTotal}`);
    if (runs === 2) {
        okCase('B-如实记录：SIGKILL（没走到 finish）这一类**本修复覆盖不到**，仍有 1 次重复扣料', `runs=${runs} logsLeft=${logsLeft}`);
    } else {
        badCase('B 场景的行为与文档描述不符', { runs, state: j?.state });
    }
}

console.log('');
console.log('============================================');
console.log(`${pass}/${pass + fail} 个断言通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
