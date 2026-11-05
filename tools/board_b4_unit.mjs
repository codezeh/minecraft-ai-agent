/**
 * M8 B4 离线测试（共享地标 / 危险点 / 箱子内容），06 §9.3。
 *
 * 锁五件事：
 *   ① 三样数据都能**写进板库再读出来**（各 bot 共享：A 写、B 读）
 *   ② **B4 验收核心**：A 存进箱子 → B **不开箱**就能查到"在哪个箱子、多少"
 *   ③ **单一真相**：`flow_store` 不再读写 `chests.json`（源码级断言：没有 fs 写箱子）
 *   ④ **迁移**：旧的 per-bot 文件一次性搬进板库；板库已有数据时**跳过**（幂等）
 *   ⑤ `terrain3d` **不共享**（注释原文在位 + 板库里没有 terrain 这类 kind）
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import {
    openBoard, putShared, getShared, listShared, delShared,
    findItemInSharedChests, migrateLocalToBoard, SHARED_KINDS,
} from '../src/agent/library/board_store.js';

let pass = 0;
let fails = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fails++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

// ★ T15（并发加固）：**每个进程一个独立目录**。
//   原来用固定的 `tmp/<name>` 且开跑第一件事就是 rmSync 掉它 ——
//   同机两路 unit_all（或两路并发跑测试）会互删对方的 fixture，
//   表现为「整跑随机变红、单跑全绿」。mkdtempSync 让两路各拿各的目录。
const DIR = mkdtempSync(join(os.tmpdir(), 'board-b4-test-'));
let seq = 0;
const freshDb = () => {
    const dir = join(DIR, `db${++seq}`);
    rmSync(dir, { recursive: true, force: true });
    return openBoard(dir).db;
};

// 1. 三种 kind 都能存能读（共享 = A 写 B 读，同一份库）
{
    const db = freshDb();
    const w1 = putShared(db, 'landmark', 'home', { x: 10, y: 64, z: -5, note: '家' }, { owner: 'botA' });
    const w2 = putShared(db, 'danger', '10,-5', { x: 10, z: -5, radius: 6, reason: 'lava' }, { owner: 'botA' });
    const w3 = putShared(db, 'chest', '3,64,7', { pos: { x: 3, y: 64, z: 7 }, items: { oak_log: 32 } }, { owner: 'botA' });

    const r1 = getShared(db, 'landmark', 'home');
    const r2 = getShared(db, 'danger', '10,-5');
    const r3 = getShared(db, 'chest', '3,64,7');
    const good = w1.ok && w2.ok && w3.ok
        && r1?.value?.note === '家'
        && r2?.value?.reason === 'lava'
        && r3?.value?.items?.oak_log === 32;
    if (good) okCase('三种共享数据（landmark/danger/chest）都能写进板库再读出来', `${SHARED_KINDS.length} 种`);
    else badCase('三种共享数据', { w1: w1.ok, r1: r1?.value, r2: r2?.value, r3: r3?.value });
}

// 2. ★ B4 验收核心：A 存进箱子 → B（另一个 client/进程视角）**不开箱**就知道在哪个箱子
{
    const db = freshDb();
    // A 存了 32 个原木进 (3,64,7)
    putShared(db, 'chest', '3,64,7', {
        pos: { x: 3, y: 64, z: 7 }, items: { oak_log: 32, cobblestone: 5 },
    }, { owner: 'botA' });
    // 另一个箱子里也有原木，但少
    putShared(db, 'chest', '20,64,20', {
        pos: { x: 20, y: 64, z: 20 }, items: { oak_log: 4 },
    }, { owner: 'botB' });

    const hits = findItemInSharedChests(db, 'oak_log');
    const best = hits[0];
    const good = hits.length === 2
        && best.key === '3,64,7'
        && best.count === 32
        && best.pos?.x === 3 && best.pos?.y === 64 && best.pos?.z === 7;
    if (good) {
        okCase('★ B4 验收核心：不开箱就能查到"原木在 3,64,7 共 32 个"（多的排前）',
            `hits=${JSON.stringify(hits.map((h) => [h.key, h.count]))}`);
    } else {
        badCase('★ 不开箱查物品', { hits });
    }
}

// 3. 查不到就返回空（不瞎报）
{
    const db = freshDb();
    putShared(db, 'chest', '1,1,1', { pos: { x: 1, y: 1, z: 1 }, items: { dirt: 1 } });
    const none = findItemInSharedChests(db, 'diamond');
    const below = findItemInSharedChests(db, 'dirt', { minCount: 5 });
    if (none.length === 0 && below.length === 0) okCase('查不到 / 不够量 → 返回空（不瞎报）', 'ok');
    else badCase('查不到应为空', { none, below });
}

// 4. upsert 语义：同 kind+key 覆盖，不产生两行
{
    const db = freshDb();
    putShared(db, 'chest', '3,64,7', { pos: { x: 3, y: 64, z: 7 }, items: { oak_log: 10 } });
    putShared(db, 'chest', '3,64,7', { pos: { x: 3, y: 64, z: 7 }, items: { oak_log: 25 } });
    const all = listShared(db, 'chest');
    const v = getShared(db, 'chest', '3,64,7');
    if (all.length === 1 && v?.value?.items?.oak_log === 25) okCase('同 kind+key 是 upsert（只有一行、取最新值）', `rows=${all.length}`);
    else badCase('upsert', { rows: all.length, v: v?.value });
}

// 5. del 生效
{
    const db = freshDb();
    putShared(db, 'landmark', 'x', { x: 1 });
    const d = delShared(db, 'landmark', 'x');
    if (d.deleted === 1 && getShared(db, 'landmark', 'x') === null) okCase('delShared 生效', 'ok');
    else badCase('delShared', d);
}

// 6. 未知 kind 拒绝
{
    const db = freshDb();
    const r = putShared(db, 'terrain', 'k', { a: 1 });
    const emptyKey = putShared(db, 'landmark', '', { a: 1 });
    if (!r.ok && !emptyKey.ok) okCase('未知 kind / 空 key 一律拒绝', `${r.code}/${emptyKey.code}`);
    else badCase('非法 kind/key', { r, emptyKey });
}

// 7. 清单按 kind 过滤
{
    const db = freshDb();
    putShared(db, 'landmark', 'a', { x: 1 });
    putShared(db, 'danger', 'b', { x: 2 });
    putShared(db, 'chest', 'c', { x: 3 });
    const lm = listShared(db, 'landmark');
    const all = listShared(db);
    if (lm.length === 1 && all.length === 3) okCase('listShared 按 kind 过滤', `landmark=${lm.length} all=${all.length}`);
    else badCase('listShared 过滤', { lm: lm.length, all: all.length });
}

// ══════════════════════════════════════════════════════════════════════════
// 8. ★ 迁移：旧 per-bot 文件 → 板库；搬完不再读旧文件；幂等
// ══════════════════════════════════════════════════════════════════════════
{
    const db = freshDb();
    // 假 reader：模拟旧的 memory_store（三种 namespace）
    const localData = {
        sites: [{ x: 5, y: 64, z: 5, name: 'mine_entrance', note: '矿洞' }],
        storage: { x: 8, y: 64, z: 8, note: 'main_storage' },
        dangers: [{ x: 12, z: -3, radius: 6, reason: 'lava' }],
        chests: [{ x: 3, y: 64, z: 7, contents: { oak_log: 32 }, category: 'wood' }],
    };
    const reader = { readStore: (_bot, ns) => localData[ns] ?? null };
    const bot = { username: 'oldBot' };

    const first = migrateLocalToBoard(db, bot, reader);
    const second = migrateLocalToBoard(db, bot, reader);          // 再搬一次：应全部 skip
    const landmarks = listShared(db, 'landmark');
    const dangers = listShared(db, 'danger');
    const chests = listShared(db, 'chest');
    const hit = findItemInSharedChests(db, 'oak_log');

    const good = first.moved.landmark === 2 && first.moved.danger === 1 && first.moved.chest === 1
        && landmarks.length === 2 && dangers.length === 1 && chests.length === 1
        && hit[0]?.key === '3,64,7' && hit[0].count === 32
        && second.skipped.length === 3;          // 幂等：第二次全跳过
    if (good) {
        okCase('★ 迁移：旧文件一次搬进板库、幂等（第二次全跳过）、搬完能按新路径查到',
            `moved=${JSON.stringify(first.moved)} 第二次 skipped=${JSON.stringify(second.skipped)}`);
    } else {
        badCase('★ 迁移', { first, second, landmarks: landmarks.length, dangers: dangers.length, chests: chests.length, hit });
    }
}

// 9. ★ 单一真相（源码级）：flow_store 不再自己读写 chests.json
{
    const src = readFileSync('src/agent/library/flow_store.js', 'utf8');
    // 只检查**代码**（去掉注释行）里还有没有 fs 写文件 / 拼 chests.json 路径
    const code = src.split('\n')
        .filter((l) => !/^\s*(\*|\/\/)/.test(l))       // 去掉注释行
        .join('\n');
    const writes = /writeFileSync|readFileSync|mkdirSync/.test(code);
    const buildsPath = /chests\.json/.test(code);
    // ★ T31 第16条：箱子内容改成走 `sharedMerge`（服务端原子合并），
    //   所以「走板」的指纹必须把它算进来 —— 否则「改用更好的接口」会被这条守卫
    //   判成「不再走板」（守卫盯的是**行为**，不是某个具体方法名）。
    const usesBoard = /sharedPut|sharedGet|sharedMerge/.test(code);
    if (!writes && !buildsPath && usesBoard) {
        okCase('★ 单一真相：flow_store 代码里没有 fs 读写 / 没有 chests.json 路径，且确实走板', 'ok');
    } else {
        badCase('★ flow_store 仍有本地文件路径', { writes, buildsPath, usesBoard });
    }
}

// 10. ★ terrain3d 明确不共享（注释原文在位 + 它是独立 sqlite，不在共享表里）
{
    const storeSrc = readFileSync('src/agent/library/board_store.js', 'utf8');
    const hasWhy = /terrain3d/.test(storeSrc) && /暂不共享|不共享/.test(storeSrc);
    const terrainSrc = readFileSync('src/agent/library/terrain3d.js', 'utf8');
    const ownDb = /terrain3d\.db/.test(terrainSrc);
    const db = freshDb();
    const terrainKind = putShared(db, 'terrain', 'x', {});
    if (hasWhy && ownDb && !terrainKind.ok) {
        okCase('★ terrain3d 明确不共享（注释说明在位、仍是各自独立 sqlite、板库无此类 kind）', 'ok');
    } else {
        badCase('★ terrain3d 不共享', { hasWhy, ownDb, terrainKind: terrainKind.ok });
    }
}

// 11. 端到端：经 client → server → store（和 B3 同样的做法）
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
    attachBoardServer({ io, db, registry: new Map(), validateArgs: () => ({ ok: true, args: {} }) });

    const A = new BoardClient({ socket: mkSocket(), name: 'botA', timeoutMs: 800 });
    const B = new BoardClient({ socket: mkSocket(), name: 'botB', timeoutMs: 800 });
    await A.hello(); await B.hello();

    // A 存
    await A.sharedPut('chest', '3,64,7', { pos: { x: 3, y: 64, z: 7 }, items: { oak_log: 32 } });
    // B 不开箱直接查
    const found = await B.sharedFindItem('oak_log');
    const hits = found.ok ? (found.data?.hits ?? []) : [];
    const good = found.ok && hits.length === 1 && hits[0].key === '3,64,7' && hits[0].count === 32;
    if (good) {
        okCase('★ 端到端：A(sharedPut) 存 → **B 不开箱**就查到 3,64,7 有 32 个原木', `hits=${JSON.stringify(hits.map((h) => [h.key, h.count]))}`);
    } else {
        badCase('★ 端到端 A 存 B 查', { ok: found.ok, hits });
    }
}

console.log('============================================');
console.log(`${pass}/${pass + fails} 个用例通过`);
console.log('============================================');
// T15：并发安全后也**不留垃圾**；清理失败不许让测试变红
try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fails === 0 ? 0 : 1);
