/**
 * M8 B3 离线测试（多人单 + 预约 + 角色），06 §9 / §12。
 *
 * 重点锁五件事：
 *   ① **预约冲突**：两个客户端抢同一个 `block:` key → 只有一个成功，另一个拿到 `CLAIM_CONFLICT`
 *   ② **预约 TTL 过期自动释放**（假时钟，不 sleep）
 *   ③ ★ **单 bot 时 `reserve` 恒成功** —— 且证明**没有第二条路径**（同一份代码）
 *   ④ **角色过滤**：`requires.roles:['miner']` + 没 miner 的 bot → 领不到；**不配 roles 时谁都能领**
 *   ⑤ **拆单**：4 张子单全 done 才父单 done；一张 failed 且无人能接 → 父单 blocked；`dependsOn` 门控
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import {
    openBoard, addJob, getJob, listJobs, claimFor, setState, finish,
    reserve, release, expireClaims, renewClaims, listClaims,
    meetsRequires, dependsSatisfied, rollupParent, splitByCount, splitByArea,
    JOB_STATE, CLAIM_TTL_MS,
} from '../src/agent/library/board_store.js';
import {
    parseClaimKey, claimsConflict, normalizeClaimKeys, deriveClaims, CLAIM_KINDS,
} from '../src/agent/library/board_claims.js';

let pass = 0;
let fails = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fails++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

// ★ T15（并发加固）：**每个进程一个独立目录**。
//   原来用固定的 `tmp/<name>` 且开跑第一件事就是 rmSync 掉它 ——
//   同机两路 unit_all（或两路并发跑测试）会互删对方的 fixture，
//   表现为「整跑随机变红、单跑全绿」。mkdtempSync 让两路各拿各的目录。
const DIR = mkdtempSync(join(os.tmpdir(), 'board-b3-test-'));
let seq = 0;
const freshDb = () => {
    const dir = join(DIR, `db${++seq}`);
    rmSync(dir, { recursive: true, force: true });
    return openBoard(dir).db;
};

// ══════════════════════════════════════════════════════════════════════════
// 1. 六种 key 的解析
// ══════════════════════════════════════════════════════════════════════════
{
    const cases = [
        ['block:10,64,-5', 'block'],
        ['area:0,64,0:16', 'area'],
        ['container:3,64,7', 'container'],
        ['station:furnace@1,2,3', 'station'],
        ['entity:abc-123', 'entity'],
        ['item:oak_log', 'item'],
    ];
    const bad = cases.filter(([k, kind]) => { const p = parseClaimKey(k); return !p.ok || p.kind !== kind; });
    const badOnes = ['nope', 'weird:1,2,3', 'block:1,2', 'area:1,2,3', 'block:1,2,3'].filter((k) => parseClaimKey(k).ok && k !== 'block:1,2,3');
    if (bad.length === 0 && badOnes.length === 0) {
        okCase('六种预约 key 全部能解析（block/area/container/station/entity/item）', `${CLAIM_KINDS.length} 种`);
    } else {
        badCase('key 解析', { bad, badOnes });
    }
}

// 2. 非法 key 要拒
{
    const illegal = ['', 'block', 'unknown:x', 'block:1,2', 'area:1,2,3', 'area:1,2,3:-4'];
    const wronglyOk = illegal.filter((k) => parseClaimKey(k).ok);
    if (wronglyOk.length === 0) okCase('非法 key 一律拒绝', `${illegal.length} 个样例`);
    else badCase('非法 key 未被拒', wronglyOk);
}

// 3. 冲突判定（含**跨类型**：点 vs 区域）
{
    const cases = [
        // [a, b, 期望冲突, 说明]
        ['block:1,2,3', 'block:1,2,3', true, '同一块方块'],
        ['block:1,2,3', 'block:1,2,4', false, '相邻方块'],
        ['area:0,64,0:16', 'area:0,64,0:16', true, '同一区域'],
        ['area:0,64,0:10', 'area:0,64,0:10', true, '完全重叠的两圈'],
        ['area:0,64,0:4', 'area:100,64,100:4', false, '离得很远'],
        ['area:0,64,0:16', 'block:3,64,3', true, '★ 方块在区域里（跨类型）'],
        ['area:0,64,0:16', 'block:100,64,100', false, '方块在区域外'],
        ['container:1,2,3', 'container:1,2,3', true, '同一个箱子'],
        ['station:furnace@1,2,3', 'station:furnace@1,2,3', true, '同一台熔炉'],
        ['station:furnace@1,2,3', 'station:furnace@9,9,9', false, '不同熔炉'],
        ['entity:abc', 'entity:abc', true, '同一只怪'],
        ['entity:abc', 'entity:xyz', false, '不同怪'],
        ['item:oak_log', 'item:oak_log', true, '同一份材料'],
        ['item:oak_log', 'item:stone', false, '不同材料'],
        ['entity:abc', 'block:1,2,3', false, '语义无关不冲突'],
    ];
    const bad = cases.filter(([a, b, exp]) => claimsConflict(a, b) !== exp);
    if (bad.length === 0) okCase('冲突判定（含跨类型的"方块 vs 区域"）', `${cases.length} 组`);
    else badCase('冲突判定', bad.map(([a, b, e]) => `${a} × ${b} 期望${e} 实际${claimsConflict(a, b)}`));
}

// 4. normalizeClaimKeys：去重 + 拒非法
{
    const a = normalizeClaimKeys(['block:1,2,3', 'block:1,2,3', 'area:0,0,0:4']);
    const b = normalizeClaimKeys(['badkey']);
    if (a.ok && a.keys.length === 2 && !b.ok) okCase('normalizeClaimKeys 去重 + 拒非法', JSON.stringify(a.keys));
    else badCase('normalizeClaimKeys', { a, b });
}

// ══════════════════════════════════════════════════════════════════════════
// 5. ★ 预约冲突：两个客户端抢同一个 block key → 只有一个成功
// ══════════════════════════════════════════════════════════════════════════
{
    const db = freshDb();
    const t0 = 1_000_000;
    const key = 'block:10,64,-5';
    const r1 = reserve(db, 'jobA', 'alpha', [key], { now: t0 });
    const r2 = reserve(db, 'jobB', 'beta', [key], { now: t0 + 10 });
    const good = r1.ok === true && r2.ok === false && r2.code === 'CLAIM_CONFLICT' && r2.conflicts.includes(key);
    if (good) {
        okCase('★ 预约冲突：alpha 拿到、beta 拿到 CLAIM_CONFLICT', `alpha=ok beta=${r2.code}`);
    } else {
        badCase('★ 预约冲突', { r1, r2 });
    }
}

// 6. 冲突是"全有或全无"：多 key 里有一个撞了 → 一个都不占
{
    const db = freshDb();
    const t0 = 2_000_000;
    reserve(db, 'jobA', 'alpha', ['block:1,2,3'], { now: t0 });
    const r = reserve(db, 'jobB', 'beta', ['block:50,2,3', 'block:1,2,3'], { now: t0 + 1 });
    const betaHolds = listClaims(db, 'jobB');
    const good = !r.ok && r.code === 'CLAIM_CONFLICT' && betaHolds.length === 0;
    if (good) okCase('预约"全有或全无"：有一个撞了就一个都不占', `beta 持有 ${betaHolds.length} 条`);
    else badCase('全有或全无', { r, betaHolds });
}

// 7. 自己的 key 不跟自己冲突（同一单/同一 bot 重复预约）
{
    const db = freshDb();
    const t0 = 3_000_000;
    const r1 = reserve(db, 'jobA', 'alpha', ['block:1,2,3'], { now: t0 });
    const r2 = reserve(db, 'jobA', 'alpha', ['block:1,2,3'], { now: t0 + 5 });   // 同单同 key
    if (r1.ok && r2.ok) okCase('同一张单重复预约同一个 key 不算冲突（幂等续期）', 'ok');
    else badCase('自我预约', { r1, r2 });
}

// ══════════════════════════════════════════════════════════════════════════
// 8. ★ TTL 过期自动释放（假时钟，不 sleep）
// ══════════════════════════════════════════════════════════════════════════
{
    const db = freshDb();
    const t0 = 4_000_000;
    const key = 'container:1,64,1';
    reserve(db, 'jobA', 'alpha', [key], { now: t0, ttlMs: CLAIM_TTL_MS });

    // TTL 未到：beta 抢不到
    const before = reserve(db, 'jobB', 'beta', [key], { now: t0 + CLAIM_TTL_MS - 1 });
    // TTL 到期：beta 能抢到（过期预约被自动清掉）
    const after = reserve(db, 'jobB', 'beta', [key], { now: t0 + CLAIM_TTL_MS + 1 });
    const holder = listClaims(db).find((c) => c.key === key);

    const good = before.ok === false && before.code === 'CLAIM_CONFLICT'
        && after.ok === true && holder?.owner === 'beta';
    if (good) {
        okCase('★ TTL 过期自动释放（假时钟，无 sleep）', `到期前=${before.code} 到期后=ok holder=${holder?.owner}`);
    } else {
        badCase('★ TTL 过期', { before, after, holder });
    }
}

// 9. renewClaims 续期（heartbeat 时用）
{
    const db = freshDb();
    const t0 = 5_000_000;
    reserve(db, 'jobA', 'alpha', ['block:7,7,7'], { now: t0, ttlMs: CLAIM_TTL_MS });
    renewClaims(db, 'jobA', { now: t0 + CLAIM_TTL_MS - 100, ttlMs: CLAIM_TTL_MS });
    // 原 TTL 已过，但续过 → beta 仍抢不到
    const r = reserve(db, 'jobB', 'beta', ['block:7,7,7'], { now: t0 + CLAIM_TTL_MS + 10 });
    if (!r.ok && r.code === 'CLAIM_CONFLICT') okCase('renewClaims 续期生效（续过之后别人仍抢不到）', 'ok');
    else badCase('renewClaims', r);
}

// 10. release 释放后别人能拿到
{
    const db = freshDb();
    const t0 = 6_000_000;
    reserve(db, 'jobA', 'alpha', ['block:8,8,8'], { now: t0 });
    const blocked = reserve(db, 'jobB', 'beta', ['block:8,8,8'], { now: t0 + 1 });
    release(db, 'jobA', 'alpha');
    const allowed = reserve(db, 'jobB', 'beta', ['block:8,8,8'], { now: t0 + 2 });
    if (!blocked.ok && allowed.ok) okCase('release 释放后别人能拿到', 'ok');
    else badCase('release', { blocked, allowed });
}

// ══════════════════════════════════════════════════════════════════════════
// 11. ★★ 单 bot 时 reserve 恒成功（且**没有第二条路径**）
//     证明方式：库里所有预约 owner 都是自己 → 同一份代码自然成功。
//     用**同一个 reserve 函数**、同样的 key，只改"有没有别的 owner"。
// ══════════════════════════════════════════════════════════════════════════
{
    const db = freshDb();
    const t0 = 7_000_000;
    // 单 bot 场景：只有 alpha 在预约，反复预约各种 key 都成功
    const keys = ['block:1,1,1', 'area:0,64,0:16', 'container:2,2,2', 'station:furnace@3,3,3', 'entity:e1', 'item:oak_log'];
    const results = keys.map((k, i) => reserve(db, `job${i}`, 'alpha', [k], { now: t0 + i }));
    const allOk = results.every((r) => r.ok === true);

    // 对照：**同一个函数**，换成 beta 抢 alpha 已占的 key → 必须冲突
    //   （若实现里有 `if (singleBot) return ok` 的分支，这里就测不出冲突）
    const cross = reserve(db, 'jobX', 'beta', ['block:1,1,1'], { now: t0 + 100 });

    if (allOk && !cross.ok && cross.code === 'CLAIM_CONFLICT') {
        okCase('★★ 单 bot 恒成功（同一函数、无 if 分支）；有别人时立刻冲突', `单 bot ${results.length}/${results.length} 成功，跨 bot 冲突`);
    } else {
        badCase('★★ 单 bot 恒成功/无第二条路径', { allOk, results: results.map((r) => r.ok), cross });
    }
}

// 12. 单 bot 反复预约**大量** key 也不会自己跟自己冲突（真实场景：一个 bot 同时占区域+方块）
{
    const db = freshDb();
    const t0 = 8_000_000;
    const keys = [];
    for (let i = 0; i < 20; i++) keys.push(`block:${i},64,0`);
    keys.push('area:10,64,0:8');
    const r = reserve(db, 'jobBig', 'alpha', keys, { now: t0 });
    if (r.ok && r.reserved.length === keys.length) {
        okCase('单个 bot 一次预约 21 个 key（含互相重叠的方块与区域）全部成功',
            `${r.reserved.length} 条`);
    } else {
        badCase('单 bot 大量预约', r);
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 13. ★ 角色过滤：requires.roles:['miner'] + 无 miner → 领不到
// ══════════════════════════════════════════════════════════════════════════
{
    const db = freshDb();
    addJob(db, {
        kind: 'shared', title: '挖矿活', skill: 'mine',
        args: { ore: 'iron', count: 8 }, priority: 5,
        requires: { roles: ['miner'] }, state: JOB_STATE.READY,
    });
    // 没有 miner 角色 → 领不到
    const noRole = claimFor(db, 'builderBot', { roles: ['builder'] });
    // 有 miner → 领得到
    const hasRole = claimFor(db, 'minerBot', { roles: ['miner'] });
    if (noRole === null && hasRole !== null) {
        okCase('★ 角色过滤：无 miner 的角色领不到，有 miner 的领得到', `builder=null miner=${hasRole.id}`);
    } else {
        badCase('★ 角色过滤', { noRole: noRole?.id, hasRole: hasRole?.id });
    }
}

// 14. ★ 角色缺省：单里没写 requires → **谁都能领**（别让缺省变成"都领不到"）
{
    const db = freshDb();
    addJob(db, {
        kind: 'shared', title: '通用活', skill: 'collect',
        args: { block: 'oak_log', count: 4 }, priority: 5, state: JOB_STATE.READY,
    });
    const noRolesAtAll = claimFor(db, 'plainBot', {});                  // bot 完全没配 roles
    if (noRolesAtAll !== null) {
        okCase('★ 缺省行为：单无 requires + bot 无 roles → 仍能领（不会变成"都领不到"）', noRolesAtAll.id);
    } else {
        badCase('★ 缺省能领', noRolesAtAll);
    }
}

// 15. ★ meetsRequires —— requires.roles × who.roles **完整判定矩阵**（表驱动）
//
// 为什么要求全矩阵（2026-11-02 t25，captain 要求）：
//   原来这里只有一行 `[{roles:['miner']}, {}, false, 'bot 无角色']`，
//   而**文件头第 8 行注释写的是"不配 roles 时谁都能领"** —— 注释与测试互相矛盾，
//   实现跟着测试走 → **没配角色的 bot 什么单都领不到**（06 §9.4 要求"不配就什么都能领"）。
//   这是今晚第 3 个「两处各叫一个名字」家族成员，而且最危险：**测试自己把错的行为锁住了**，
//   于是它被当成"已验证"的证据。→ 改成全矩阵，让每一条语义边界都有断言钉着。
//
// 三条语义（也写进实现注释，防"顺手"改坏）：
//   1) requires.roles 空/未配 → 不受限
//   2) who.roles 空/未配     → 不受限（本次修的）
//   3) 两边都配 → **任一命中即可（some，不是 every）**
{
    const MATRIX = [
        // [requires.roles,        who.roles,            期望可领, 说明]
        [undefined,               undefined,            true,  '两边都没配 → 可领'],
        [[],                      [],                   true,  '两边都是空数组 → 可领'],
        [undefined,               ['miner'],            true,  '单没要求、bot 有角色 → 可领'],
        [[],                      ['miner'],            true,  '单要求空、bot 有角色 → 可领'],
        [['miner'],               undefined,            true,  '★ 单要 miner、bot 没配 → 可领（本次修的）'],
        [['miner'],               [],                   true,  '★ 单要 miner、bot 空数组 → 可领（本次修的）'],
        [['miner'],               ['miner'],            true,  '对得上'],
        [['miner'],               ['builder'],          false, '配了角色但对不上 → 拒'],
        [['miner', 'farmer'],     ['farmer'],           true,  '★ 任一命中即可（不是全都要）'],
        [['miner'],               ['builder', 'miner'], true,  '多角色里含一个 → 可领'],
        [['miner', 'farmer'],     ['builder'],          false, '配了角色但一个都不对 → 拒'],
    ];
    const bad = [];
    for (const [reqRoles, whoRoles, exp, why] of MATRIX) {
        const job = reqRoles === undefined ? {} : { requires: { roles: reqRoles } };
        const who = whoRoles === undefined ? {} : { roles: whoRoles };
        const got = meetsRequires(job, who);
        if (got !== exp) bad.push({ req: reqRoles, who: whoRoles, exp, got, why });
    }
    if (bad.length === 0) {
        okCase('★ meetsRequires 角色全矩阵（11 组，含"任一命中"与"缺省放开"）', `${MATRIX.length} 组`);
    } else {
        badCase('meetsRequires 角色矩阵', bad);
    }

    // 道具条件（与原用例一致，保留）
    const itemCases = [
        [{ requires: { items: ['iron_pickaxe'] } }, { items: ['iron_pickaxe'] }, true, '有道具'],
        [{ requires: { items: ['iron_pickaxe'] } }, { items: [] }, false, '缺道具'],
    ];
    const bad2 = itemCases.filter(([job, who, exp]) => meetsRequires(job, who) !== exp);
    if (bad2.length === 0) okCase('meetsRequires 道具条件（2 组）', `${itemCases.length} 组`);
    else badCase('meetsRequires 道具', bad2);
}

// ══════════════════════════════════════════════════════════════════════════
// 16. ★ 拆单（按数量）：4 张子单全 done 才父单 done
// ══════════════════════════════════════════════════════════════════════════
{
    const db = freshDb();
    const { parent, children } = splitByCount(db, {
        title: '采 64 原木', skill: 'collect', args: { block: 'oak_log' },
        countKey: 'count', total: 64, parts: 4, priority: 6,
    });
    const totalCount = children.reduce((n, c) => n + Number(c.args.count), 0);
    const splitRight = children.length === 4 && totalCount === 64 && children.every((c) => c.args.count === 16);

    // 3 张 done，1 张还没 → 父单不该 done
    //   ★ 注意：这里**只能**用 claim→finish 把子单做成 done；
    //     第一版我先把它们 setState(CANCELLED) 再 finish，结果子单成了终态 cancelled，
    //     既不是 done 也不是 failed → 父单卡在 in-progress（那是我的测试写错，不是逻辑错）。
    for (let i = 0; i < 3; i++) {
        claimFor(db, `bot${i}`, {});
        // ★ T31 补充A：领单者必须报名字（漏传 bot + 活租约 = LEASE_STALE，fail closed）
        finish(db, children[i].id, { ok: true, code: 'OK', progress: { count: 16, want: 16 } }, { bot: `bot${i}` });
    }
    const partial = rollupParent(db, parent.id);
    const parentAfter3 = getJob(db, parent.id);

    // 最后一张 done → 父单 done
    const last = children[3];
    claimFor(db, 'bot9', {});
    finish(db, last.id, { ok: true, code: 'OK', progress: { count: 16, want: 16 } }, { bot: 'bot9' });
    const full = rollupParent(db, parent.id);
    const parentAfter4 = getJob(db, parent.id);

    const good = splitRight
        && parentAfter3.state !== JOB_STATE.DONE
        && parentAfter4.state === JOB_STATE.DONE;
    if (good) {
        okCase('★ 拆单按数量 64→4×16；3 张 done 时父单未 done，4 张全 done 才父单 done',
            `3张后=${parentAfter3.state} 4张后=${parentAfter4.state}`);
    } else {
        badCase('★ 拆单/父子收敛', { splitRight, totalCount, after3: parentAfter3.state, after4: parentAfter4.state, partial, full });
    }
}

// 17. 拆单：一张 failed 且无人能接 → 父单 blocked
{
    const db = freshDb();
    const { parent, children } = splitByCount(db, {
        title: '挖 4 份', skill: 'mine', args: {}, countKey: 'count', total: 4, parts: 2,
    });
    // children[0] 做成功
    claimFor(db, 'b1', {});
    finish(db, children[0].id, { ok: true, code: 'OK', progress: { count: 2, want: 2 } }, { bot: 'b1' });
    // children[1] 直接置 failed（模拟重试用尽）
    claimFor(db, 'b2', {});
    for (let i = 0; i < 5; i++) {
        finish(db, children[1].id, { ok: false, code: 'TIMEOUT', progress: { count: 0, want: 2 } }, { bot: 'b2' });
        if (getJob(db, children[1].id).state === JOB_STATE.FAILED) break;
        claimFor(db, 'b2', {});
    }
    const st = getJob(db, children[1].id).state;
    const r = rollupParent(db, parent.id);
    const parentState = getJob(db, parent.id).state;
    if (st === JOB_STATE.FAILED && parentState === JOB_STATE.BLOCKED) {
        okCase('★ 子单 failed 且无人能接 → 父单 blocked', `child=${st} parent=${parentState}`);
    } else {
        badCase('★ 子单 failed → 父单 blocked', { child: st, parent: parentState, rollup: r });
    }
}

// 17b. ★ 子单 blocked 也要顶起父单（真机验收补的缺口）
//   原来 rollupParent 只处理 failed；blocked 的子单会让父单**永远停在 running**（静默卡死）。
{
    const db = freshDb();
    const { parent, children } = splitByCount(db, {
        title: '两半', skill: 'mine', args: {}, countKey: 'count', total: 2, parts: 2,
    });
    claimFor(db, 'b1', {});
    finish(db, children[0].id, { ok: true, code: 'OK', progress: { count: 1, want: 1 } }, { bot: 'b1' });
    // 另一个直接 blocked（NO_TOOL 就是这类）
    claimFor(db, 'b2', {});
    finish(db, children[1].id, { ok: false, code: 'NO_TOOL', progress: { count: 0, want: 1 } }, { bot: 'b2' });
    const childState = getJob(db, children[1].id).state;
    rollupParent(db, parent.id);
    const parentState = getJob(db, parent.id).state;
    if (childState === JOB_STATE.BLOCKED && parentState === JOB_STATE.BLOCKED) {
        okCase('★ 子单 blocked → 父单 blocked（不会永远停在 running）', `child=${childState} parent=${parentState}`);
    } else {
        badCase('★ 子单 blocked 顶起父单', { childState, parentState });
    }
}

// 18. ★ dependsOn：前置未 done 时子单不可领
{
    const db = freshDb();
    const a = addJob(db, { kind: 'shared', title: '挖铁', skill: 'mine', args: {}, state: JOB_STATE.READY });
    const b = addJob(db, {
        kind: 'shared', title: '熔炼', skill: 'smelt', args: {},
        state: JOB_STATE.READY, dependsOn: [a.id],
    });
    // a 还没 done → b 领不到（只会领到 a）
    const first = claimFor(db, 'bot1', {});
    const got = first?.id;

    // a 做完之后 → b 可领
    finish(db, a.id, { ok: true, code: 'OK', progress: { count: 1, want: 1 } }, { bot: 'bot1' });
    const second = claimFor(db, 'bot1', {});

    if (got === a.id && second?.id === b.id) {
        okCase('★ dependsOn：前置未 done 时只领到前置；前置完成后才领到后继',
            `先=${got === a.id ? 'a' : got} 后=${second?.id === b.id ? 'b' : second?.id}`);
    } else {
        badCase('★ dependsOn 门控', { first: got, second: second?.id });
    }
}

// 19. 拆单按区域：每块带自己的 area 预约，且互不冲突（网格不重叠）
{
    const db = freshDb();
    const { children } = splitByArea(db, {
        title: '清 32×32', skill: 'clear', args: {}, center: { x: 0, y: 64, z: 0 }, size: 32, cell: 16,
    });
    const allHaveArea = children.every((c) => Array.isArray(c.claims) && c.claims[0]?.startsWith('area:'));
    // 任意两块之间不应冲突
    let overlaps = 0;
    for (let i = 0; i < children.length; i++) {
        for (let j = i + 1; j < children.length; j++) {
            if (claimsConflict(children[i].claims[0], children[j].claims[0])) overlaps++;
        }
    }
    if (children.length === 4 && allHaveArea && overlaps === 0) {
        okCase('★ 拆区 32×32 → 4 块，每块自带 area 预约且**互不重叠**', `${children.length} 块`);
    } else {
        badCase('★ 拆区', { n: children.length, allHaveArea, overlaps });
    }
}

// 20. deriveClaims：能推导就推、推不出就不猜
{
    const c1 = deriveClaims({ skill: 'collect', args: { target: { x: 1, y: 64, z: 2 } } });
    const c2 = deriveClaims({ skill: 'mine', args: {} });
    const c3 = deriveClaims({ skill: 'collect', args: {}, claims: ['block:9,9,9'] });
    if (c1[0] === 'block:1,64,2' && c2.length === 0 && c3[0] === 'block:9,9,9') {
        okCase('deriveClaims：能推导则推导、无信息不瞎猜、显式 claims 优先', JSON.stringify(c1));
    } else {
        badCase('deriveClaims', { c1, c2, c3 });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 21. ★ CLAIM_CONFLICT 的**端到端产生路径**（client → server → store）
//     离线那几条直接调 store；这条走完整的 socket 事件链，证明码真的会传到流程手里。
// ══════════════════════════════════════════════════════════════════════════
{
    const { attachBoardServer } = await import('../src/agent/library/board_server.js');
    const { BoardClient } = await import('../src/agent/library/board_client.js');
    const dir = join(DIR, 'e2e');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const { db } = openBoard(dir);

    const handlers = new Map();
    const srvSocket = { on: (e, f) => handlers.set(e, f) };
    const mkSocket = () => ({ on() { }, emit(e, p, ack) { const h = handlers.get(e); if (!h) return ack?.({ ok: false }); h(p, ack); } });
    const io = { on: (e, f) => { if (e === 'connection') f(srvSocket); }, emit() { } };
    attachBoardServer({ io, db, registry: new Map([['mine', {}]]), validateArgs: () => ({ ok: true, args: {} }) });

    const A = new BoardClient({ socket: mkSocket(), name: 'alpha', timeoutMs: 800 });
    const B = new BoardClient({ socket: mkSocket(), name: 'beta', timeoutMs: 800 });
    await A.hello(); await B.hello();

    const r1 = await A.reserve('jobA', ['block:5,64,5']);
    const r2 = await B.reserve('jobB', ['block:5,64,5']);

    const good = r1.ok === true
        && r2.ok === false && r2.code === 'CLAIM_CONFLICT'
        && Array.isArray(r2.data?.conflicts) && r2.data.conflicts.includes('block:5,64,5');
    if (good) {
        okCase('★ CLAIM_CONFLICT 端到端（client→server→store）且带 conflicts 明细',
            `alpha=OK beta=${r2.code} conflicts=${JSON.stringify(r2.data.conflicts)}`);
    } else {
        badCase('★ CLAIM_CONFLICT 端到端', { r1ok: r1.ok, r2ok: r2.ok, code: r2.code, data: r2.data });
    }
}

console.log('============================================');
console.log(`${pass}/${pass + fails} 个用例通过`);
console.log('============================================');
// T15：并发安全后也**不留垃圾**；清理失败不许让测试变红
try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fails === 0 ? 0 : 1);
