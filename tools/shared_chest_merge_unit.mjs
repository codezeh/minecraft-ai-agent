/**
 * T31 第16条：共享箱内容**并发写入不丢件** —— 离线，真 sqlite。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 病根（`flow_store.rememberChest:74-88`）：箱子内容是「`sharedGet` → 本地叠加 →
 *   `sharedPut`」，跨**两次 socket 往返**。两个 bot 同时往同一个箱子存东西时：
 *
 *       A 读 {oak_log:5} ─┐              ┌→ A 写 {oak_log:5, stone:0...}
 *       B 读 {oak_log:5} ─┴─(同一时刻)───┴→ B 写 {oak_log:5}      ← **A 那次被整份覆盖**
 *
 *   丢件、且**没有任何错误**（两边都返回 ok）。现场表现：箱子里的东西"越存越少"。
 *
 * 修法：`board_store.mergeSharedChest(db,key,delta,owner)` —— 读-改-写收进
 *   **唯一写库进程**的一个 `BEGIN IMMEDIATE` 事务里；客户端只发**增量**。
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 输出：PASS / FAIL，全过退出码 0。临时库在 tmp/，跑完删除。
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import {
    openBoard, mergeSharedChest, getShared, putShared, findItemInSharedChests,
} from '../src/agent/library/board_store.js';
import { makeNullBoard } from '../src/agent/library/board_client.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

// ★ T15（并发加固）：**每个进程一个独立目录**。
//   原来用固定的 `tmp/<name>` 且开跑第一件事就是 rmSync 掉它 ——
//   同机两路 unit_all（或两路并发跑测试）会互删对方的 fixture，
//   表现为「整跑随机变红、单跑全绿」。mkdtempSync 让两路各拿各的目录。
const DIR = mkdtempSync(join(os.tmpdir(), 'shared-chest-test-'));
let seq = 0;
const freshDb = () => { const d = join(DIR, `db${++seq}`); rmSync(d, { recursive: true, force: true }); return openBoard(d).db; };
const KEY = '10,64,-3';
const itemsOf = (db) => (getShared(db, 'chest', KEY)?.value?.items ?? null);

// ══════════════════════════════════════════════════════════════════════════
// ① ★ 验收要的那条：A 写 oak_log:5、B 写 stone:3 → **两条都在**
// ══════════════════════════════════════════════════════════════════════════
{
    const db = freshDb();
    const a = mergeSharedChest(db, KEY, { oak_log: 5 }, 'A', { now: 1000, pos: { x: 10, y: 64, z: -3 } });
    const b = mergeSharedChest(db, KEY, { stone: 3 }, 'B', { now: 2000 });
    const items = itemsOf(db);
    if (a.ok && b.ok && items?.oak_log === 5 && items?.stone === 3) {
        okCase('★ ① A 写 oak_log:5、B 写 stone:3 → 两条都在（合并，不是覆盖）',
            `items=${JSON.stringify(items)}`);
    } else {
        badCase('① 合并丢件了', { a, b, items });
    }
}

// ② 同一物品累加：A +5、B +3 → 8（不是 5 也不是 3）
{
    const db = freshDb();
    mergeSharedChest(db, KEY, { oak_log: 5 }, 'A');
    mergeSharedChest(db, KEY, { oak_log: 3 }, 'B');
    const items = itemsOf(db);
    if (items?.oak_log === 8) okCase('② 同一物品累加：+5 再 +3 → 8', `oak_log=${items.oak_log}`);
    else badCase('② 同物品累加不对', { items });
}

// ③ 取货：-N 减到 0 就把条目删掉（不留 0 条垃圾）；减成负数也归零删除
{
    const db = freshDb();
    mergeSharedChest(db, KEY, { oak_log: 5, stone: 3 }, 'A');
    mergeSharedChest(db, KEY, { oak_log: -5 }, 'A');
    const items1 = itemsOf(db);
    mergeSharedChest(db, KEY, { stone: -99 }, 'A');
    const items2 = itemsOf(db);
    const ok1 = !('oak_log' in (items1 ?? {})) && items1?.stone === 3;
    const ok2 = !('stone' in (items2 ?? {}));
    if (ok1 && ok2) okCase('③ 取货：减到 0 即删条目（不留 0），减超也不留负数', `after=${JSON.stringify(items2)}`);
    else badCase('③ 取货的边界不对', { items1, items2 });
}

// ④ ★★ 真并发：两次合并**同时**发起（模拟两个 bot 同时存）→ 两条都在
//    ★ 单进程单写者（06 §3）下这是同一个连接上的两次同步事务，天然串行；
//      这条用例证明的是"合并本身不依赖调用顺序"，与谁先谁后无关。
{
    const db = freshDb();
    const [a, b] = await Promise.all([
        Promise.resolve().then(() => mergeSharedChest(db, KEY, { oak_log: 5 }, 'A', { now: 100 })),
        Promise.resolve().then(() => mergeSharedChest(db, KEY, { stone: 3 }, 'B', { now: 200 })),
    ]);
    const items = itemsOf(db);
    if (a.ok && b.ok && items?.oak_log === 5 && items?.stone === 3) {
        okCase('★ ④ 两次合并同时发起 → 两条都在', `items=${JSON.stringify(items)}`);
    } else {
        badCase('④ 并发合并丢件', { a, b, items });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ⑤ ★★ 失败反证：**老做法**（读 → 本地叠加 → 整份写）在同一交错下**必丢**
//    这是"改之前会怎样"的证明 —— 也说明这条用例真的在守东西。
// ══════════════════════════════════════════════════════════════════════════
{
    const db = freshDb();
    // 老路径逐步复刻（flow_store 原来的实现，两次往返之间别人也能写）
    const readA = getShared(db, 'chest', KEY)?.value ?? null;      // A 读
    const readB = getShared(db, 'chest', KEY)?.value ?? null;      // B 读（同一时刻，都读到空）
    const overlap = { oak_log: 5, stone: 3 };
    // A 本地叠加后整份写
    const itemsA = { ...(readA?.items ?? {}) };
    itemsA.oak_log = (itemsA.oak_log ?? 0) + 5;
    putShared(db, 'chest', KEY, { pos: { x: 10, y: 64, z: -3 }, items: itemsA, owner: 'A', at: 100 });
    // B 基于**自己那份过期快照**本地叠加后整份写 → 把 A 的 oak_log 抹掉
    const itemsB = { ...(readB?.items ?? {}) };
    itemsB.stone = (itemsB.stone ?? 0) + 3;
    putShared(db, 'chest', KEY, { pos: { x: 10, y: 64, z: -3 }, items: itemsB, owner: 'B', at: 200 });

    const items = itemsOf(db);
    const lost = !('oak_log' in (items ?? {}));
    if (lost && items?.stone === 3) {
        okCase('★ ⑤ 失败反证：老做法（读-改-写）同一交错下 **A 的 oak_log 被整份覆盖** → 丢件',
            `老做法结果=${JSON.stringify(items)}（oak_log 没了，这正是本条要消灭的 bug）`);
    } else {
        badCase('⑤ 复刻不出"老做法丢件"（说明场景没构造对，反证不成立）', { items });
    }

    // 同一个交错，用**合并**再走一遍 → 两条都在（对照）
    const db2 = freshDb();
    mergeSharedChest(db2, KEY, { oak_log: 5 }, 'A', { now: 100, pos: { x: 10, y: 64, z: -3 } });
    mergeSharedChest(db2, KEY, { stone: 3 }, 'B', { now: 200 });
    const items2 = itemsOf(db2);
    if (items2?.oak_log === 5 && items2?.stone === 3) {
        okCase('⑤-b 同一交错的对照：合并版两条都在（差别就是"读改写在服务端一次做完"）',
            `items=${JSON.stringify(items2)}`);
    } else {
        badCase('⑤-b 对照也丢了', { items2 });
    }
}

// ⑥ 附带字段：pos 保留（后续合并不再传 pos 也不丢）、owner/at 跟着最后一次写
{
    const db = freshDb();
    mergeSharedChest(db, KEY, { oak_log: 1 }, 'A', { now: 100, pos: { x: 10, y: 64, z: -3 } });
    mergeSharedChest(db, KEY, { stone: 1 }, 'B', { now: 999 });
    const v = getShared(db, 'chest', KEY)?.value;
    if (v?.pos?.x === 10 && v?.owner === 'B' && v?.at === 999) {
        okCase('⑥ pos 不丢、owner/at 取最后一次（不会把箱子坐标抹掉）', `pos=${JSON.stringify(v.pos)} owner=${v.owner}`);
    } else {
        badCase('⑥ 附带字段被合并弄丢了', v);
    }
}

// ⑦ 错误路径：没有 key → NO_TARGET（不静默写一条空 key 的记录）
{
    const db = freshDb();
    const r = mergeSharedChest(db, '', { oak_log: 1 }, 'A');
    const r2 = mergeSharedChest(db, null, { oak_log: 1 }, 'A');
    if (r.ok === false && r.code === 'NO_TARGET' && r2.ok === false) {
        okCase('⑦ 无 key → NO_TARGET，不静默写一条空 key 记录', `code=${r.code}`);
    } else {
        badCase('⑦ 空 key 没被拦住', { r, r2 });
    }
}

// ⑧ 合并后的箱子能被 `findItemInSharedChests` 找到（合并写的是同一份数据，没写歪）
{
    const db = freshDb();
    mergeSharedChest(db, KEY, { oak_log: 5 }, 'A', { pos: { x: 10, y: 64, z: -3 } });
    const hits = findItemInSharedChests(db, 'oak_log', { minCount: 1 });
    if (Array.isArray(hits) && hits.length >= 1) {
        okCase('⑧ 合并结果对 B4 的"不开箱找物品"可见（写的是同一份共享数据）', `hits=${hits.length}`);
    } else {
        badCase('⑧ 合并后的数据查不到', { hits });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ⑩ ADR §10.2-1 回归（新用例）：merge 只覆盖自己负责的字段，category/note 不许被抹掉
//    场景取"重启视角"：写档案 → 增量 merge → 关连接重开 → 档案字段仍在
// ══════════════════════════════════════════════════════════════════════════
{
    const dir = join(DIR, 'cat-restart');
    const r1 = openBoard(dir);
    putShared(r1.db, 'chest', KEY, {
        pos: { x: 10, y: 64, z: -3 }, items: { oak_log: 5 }, category: '木料', note: '第一夜仓库', lastUsed: 777,
    }, { now: 100 });
    const m = mergeSharedChest(r1.db, KEY, { stone: 2 }, 'B', { now: 200 });
    r1.db.close();
    const r2 = openBoard(dir);
    const v = getShared(r2.db, 'chest', KEY)?.value;
    r2.db.close();
    const kept = v?.category === '木料' && v?.note === '第一夜仓库' && v?.lastUsed === 777;
    const merged = v?.items?.oak_log === 5 && v?.items?.stone === 2;
    if (m.ok && kept && merged) {
        okCase('★ ⑩ merge 后档案字段仍在（重启视角）：category/note/lastUsed 保留、items 已合并',
            `category=${v.category} items=${JSON.stringify(v.items)}`);
    } else {
        badCase('⑩ merge 抹掉了档案字段（ADR §10.2-1 复发）', { m, v });
    }
}

// ⑩-b 反证：老实现（只写 pos/items/owner/at）在同一场景下 category 必丢 —— 证明这条用例真的在守东西
{
    const db = freshDb();
    putShared(db, 'chest', KEY, {
        pos: { x: 10, y: 64, z: -3 }, items: { oak_log: 5 }, category: '木料', note: '第一夜仓库',
    }, { now: 100 });
    putShared(db, 'chest', KEY, { pos: { x: 10, y: 64, z: -3 }, items: { oak_log: 5, stone: 2 }, owner: 'B', at: 200 }, { now: 200 });
    const old = getShared(db, 'chest', KEY)?.value;
    if (old?.category === undefined) {
        okCase('⑩-b 反证：老实现只写四个字段 → category 丢失（这正是 §10.2-1 的现场）', JSON.stringify(old));
    } else {
        badCase('⑩-b 反证不成立（场景没构造对）', old);
    }
}

// ══════════════════════════════════════════════════════════════════════════
// ⑨ 接线守卫：三处必须真的改过（否则"服务端有函数、没人调用"）
// ══════════════════════════════════════════════════════════════════════════
{
    const srv = readFileSync('src/agent/library/board_server.js', 'utf8');
    const cli = readFileSync('src/agent/library/board_client.js', 'utf8');
    const flow = readFileSync('src/agent/library/flow_store.js', 'utf8');

    const serverWired = srv.includes("socket.on('board:shared-merge'") && srv.includes('mergeSharedChest(');
    const clientWired = cli.includes('async sharedMerge(') && cli.includes("'board:shared-merge'");
    // ★ 关键：flow_store **不许**再出现"读+整份写"那条老路
    const flowUsesMerge = flow.includes('board.sharedMerge(');
    const flowOldPathGone = !flow.includes('board.sharedPut(') && !flow.includes('board.sharedGet(');
    if (serverWired && clientWired && flowUsesMerge && flowOldPathGone) {
        okCase('⑨ 接线：server 事件 + client 方法 + flow_store 只走合并（老读改写的痕迹已删净）',
            'server=1 client=1 flow=merge');
    } else {
        badCase('⑨ 接线不完整（函数写了没人用 = 没修）', { serverWired, clientWired, flowUsesMerge, flowOldPathGone });
    }

    // 无板降级也要有 sharedMerge，否则无板时 rememberChest 会 TypeError
    const nb = makeNullBoard();
    if (typeof nb.sharedMerge === 'function') {
        okCase('⑨-b 无板降级：makeNullBoard 也实现了 sharedMerge（不抛 TypeError）', 'ok');
    } else {
        badCase('⑨-b 空板缺 sharedMerge', { keys: Object.keys(nb) });
    }
}

try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
