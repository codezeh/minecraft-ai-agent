/**
 * R6 #21 回归：绑定码核销在**跨进程**并发下恰好一个成功。
 *
 * 病根：码文件是"读 → 改 → 写"，面板签发与游戏内核销各读写一次；
 *   两个核销者（或面板签发与核销）交错时，后写的会把先写的静默覆盖 ——
 *   可能同一个码被用两次，也可能新码被抹掉。
 * 修法：`identity_store.mutateStore/consumeCodeAtomic` —— 文件锁 + 重读 + 原子 rename，
 *   `writeStore` 再用 `rev` 乐观锁把"基于旧快照的写"变成明确的 conflict（fail-closed）。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import {
    readStore, writeStore, addCode, consumeCodeAtomic, mutateStore, emptyStore,
} from '../src/mindcraft/identity_store.js';

let pass = 0, fail = 0;
const okCase = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const badCase = (n, a) => { fail++; console.log(`FAIL ${n} ${JSON.stringify(a)}`); };

const DIR = mkdtempSync(join(os.tmpdir(), 'identity-race-'));
const MOD = pathToFileURL(join(process.cwd(), 'src/mindcraft/identity_store.js')).href;
const CODE = 'ABCD-EFGH';

/** 起一个子进程：在里面核销同一个码，回 JSON。 */
function racer(file, code) {
    const script = join(DIR, `racer-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(script, `
        import { consumeCodeAtomic } from ${JSON.stringify(MOD)};
        const r = consumeCodeAtomic(${JSON.stringify(file)}, ${JSON.stringify(code)});
        process.stdout.write(JSON.stringify({ ok: r.ok, reason: r.reason, code: r.record?.code ?? null }));
    `.trim(), 'utf8');
    return new Promise((resolve) => {
        const p = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { err += d; });
        p.on('close', (status) => {
            let parsed = null;
            try { parsed = JSON.parse(out); } catch { parsed = null; }
            resolve({ status, parsed, out: out.slice(0, 200), err: err.slice(0, 200) });
        });
    });
}

// ① ★ 4 个进程同时核销同一个码 → 恰好 1 个成功
{
    const file = join(DIR, 'race1.json');
    const seeded = addCode(emptyStore(), { code: CODE, sessionId: 's1' });
    writeStore(file, seeded.store);

    const results = await Promise.all([1, 2, 3, 4].map(() => racer(file, CODE.replace('-', ''))));
    const wins = results.filter((r) => r.parsed?.ok === true);
    const after = readStore(file);
    const gone = after.store.codes.length === 0;
    if (wins.length === 1 && gone && results.every((r) => r.status === 0)) {
        okCase('★ ① 4 个进程并发核销同一个码 → 恰好 1 个成功，码已从表里消失',
            `wins=${wins.length} reasons=${results.map((r) => r.parsed?.reason).join(',')}`);
    } else {
        badCase('① 并发核销不是"恰好一个"', { wins: wins.length, results, gone });
    }
}

// ② 同一个进程里连核销两次：第二次明确失败（单次使用，不是幂等成功）
{
    const file = join(DIR, 'twice.json');
    writeStore(file, addCode(emptyStore(), { code: CODE }).store);
    const a = consumeCodeAtomic(file, CODE);
    const b = consumeCodeAtomic(file, CODE);
    if (a.ok && !b.ok && b.reason !== 'ok') okCase('② 同进程重复核销：第一次 ok、第二次明确失败', `second=${b.reason}`);
    else badCase('② 重复核销语义不对', { a, b });
}

// ③ 基于旧快照的写被拒（rev 乐观锁）—— 这正是原来"读旧写新抹掉新码"的路径
{
    const file = join(DIR, 'stale.json');
    writeStore(file, addCode(emptyStore(), { code: 'AAAA-AAAA' }).store);
    const snapshot = readStore(file).store;                    // 进程 A 读
    const fresh = readStore(file).store;                       // 进程 B 也读
    const issued = addCode(fresh, { code: 'BBBB-BBBB' });      // B 签发新码
    const wB = writeStore(file, issued.store);
    const stale = { ...snapshot, codes: [] };                  // A 拿旧快照写回（"核销掉"）
    const wA = writeStore(file, stale);
    const after = readStore(file);
    const keptB = after.store.codes.some((c) => c.code === 'BBBB-BBBB');
    if (wB.ok && wA.ok === false && wA.reason === 'conflict' && keptB) {
        okCase('★ ③ 旧快照的写被 rev 拒掉 → B 刚签的码不会被 A 抹掉', `reason=${wA.reason}`);
    } else {
        badCase('③ 旧快照覆盖没有被拦住', { wB, wA, keptB, codes: after.store.codes });
    }
}

// ④ mutateStore 在锁内重读：mutator 看到的是最新表（不是调用前的那份）
{
    const file = join(DIR, 'rmw.json');
    writeStore(file, addCode(emptyStore(), { code: 'CCCC-CCCC' }).store);
    let seen = null;
    const r = mutateStore(file, (store, ctx) => {
        seen = { codes: store.codes.map((c) => c.code), clean: ctx.clean, rev: store.rev };
        const out = addCode(store, { code: 'DDDD-DDDD', now: ctx.now });
        return { store: out.store, result: 'issued' };
    });
    const after = readStore(file);
    if (r.ok && r.result === 'issued' && seen?.clean === true && after.store.codes.length === 2) {
        okCase('④ mutateStore 在锁内重读到最新表（CCCC 还在）再追加 DDDD', `codes=${after.store.codes.map((c) => c.code).join(',')}`);
    } else {
        badCase('④ mutateStore 读改写不对', { r, seen, codes: after.store.codes });
    }
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
