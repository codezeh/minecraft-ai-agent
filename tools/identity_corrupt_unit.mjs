/**
 * R6 #69 回归：身份表损坏时必须**留证 + 告警**，不能静默返回空表。
 *
 * 病根：`identity_store.readStore` 原来 `catch` 里直接 `return {store: emptyStore(), ok:false}`，
 * 没有日志、没有备份 —— 用户只看到"所有人突然没权限了"，运维找不到任何证据。
 * 与 `memory_store` 的 `.corrupt-<ts>` 做法对齐后，这条用例守住四件事：
 *   ① 损坏 → ok:false + corrupt:true + backup 路径；
 *   ② 原文件被**改名**（内容原样保留，不是删除）；
 *   ③ console.error 有一条可见告警；
 *   ④ 之后 writeStore 写新表**不会**覆盖那份证据。
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { readStore, writeStore } from '../src/mindcraft/identity_store.js';

let pass = 0, fail = 0;
const okCase = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const badCase = (n, a) => { fail++; console.log(`FAIL ${n} ${JSON.stringify(a)}`); };

const DIR = mkdtempSync(join(os.tmpdir(), 'identity-corrupt-'));
const file = (n) => join(DIR, `${n}.json`);

// ① 正常文件：ok:true，不误伤
{
    const f = file('good');
    writeFileSync(f, JSON.stringify({ bindings: [{ uuid: 'u1', name: 'Zeh', level: 'owner' }], codes: [] }));
    const r = readStore(f);
    if (r.ok && r.store.bindings.length === 1 && !r.corrupt && existsSync(f)) okCase('① 正常文件 ok:true（不误伤）', `bindings=${r.store.bindings.length}`);
    else badCase('① 正常文件读失败', r);
}

// ② 损坏：留证 + 告警 + 返回空表（fail-closed）
{
    const f = file('broken');
    const junk = '{ this is not json ';
    writeFileSync(f, junk);
    const logs = [];
    const oldErr = console.error;
    console.error = (...a) => { logs.push(a.join(' ')); };
    const r = readStore(f);
    console.error = oldErr;

    const backedUp = !!r.backup && existsSync(r.backup) && readFileSync(r.backup, 'utf8') === junk;
    const originalGone = !existsSync(f);
    const warned = logs.some((l) => /身份表损坏/.test(l) && /留证/.test(l));
    if (r.ok === false && r.corrupt === true && r.store.bindings.length === 0 && backedUp && originalGone && warned) {
        okCase('★ ② 损坏 → 空表 + corrupt:true + 原文件改名留证 + console.error 告警', `backup=${String(r.backup).split(/[\\/]/).pop()}`);
    } else {
        badCase('② 损坏没留证/没告警', { ok: r.ok, corrupt: r.corrupt, backedUp, originalGone, warned, logs });
    }

    // ④ 写新表不覆盖证据
    const w = writeStore(f, { bindings: [], codes: [] });
    const evidenceStill = !!r.backup && existsSync(r.backup) && readFileSync(r.backup, 'utf8') === junk;
    if (w.ok && evidenceStill && existsSync(f)) okCase('④ 之后 writeStore 写新表，证据文件仍在（不被覆盖）', 'ok');
    else badCase('④ 证据被覆盖', { w, evidenceStill });
}

// ③ 文件不存在：reason='missing'，不产生 .corrupt 文件
{
    const f = file('absent');
    const r = readStore(f);
    if (r.ok === false && r.reason === 'missing' && !r.backup) okCase('③ 文件不存在 → missing（不凭空建 .corrupt）', r.reason);
    else badCase('③ missing 判据', r);
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
