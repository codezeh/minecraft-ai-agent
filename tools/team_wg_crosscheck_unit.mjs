/**
 * `team_wg_crosscheck.mjs` 的离线测试（t7 结论 1 的要求：三种输出可区分 + 能被红）。
 *
 * 锁四件事：
 *   ① 占位符没填 ⇒ **SKIP**（绝不当成 OK：那正是"配置没生效却显示全绿"的假绿灯）
 *   ② 坐标都在区域里 ⇒ OK
 *   ③ ★ **负向**：故意放一个区域外的坐标 ⇒ FAIL，且输出里点名那个坐标、退出码 1
 *   ④ 存档对不上（world 不同）⇒ 不算被覆盖 ⇒ FAIL
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseRegionDraft, classifyCoverage } from './team_wg_crosscheck.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, 'team_wg_crosscheck.mjs');

let pass = 0;
let fails = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fails++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

const DIR = mkdtempSync(join(os.tmpdir(), 'team-wg-test-'));

/** 填好的区域草案（一个 cuboid 包住 0..10）。 */
const FILLED = `schema: 1
world: world
regions:
  __global__:
    type: global
    priority: 0
    flags: {}
  team_chest_01:
    type: cuboid
    priority: 100
    min:
      x: 0
      y: 60
      z: 0
    max:
      x: 10
      y: 70
      z: 10
    members:
      players:
        - alpha
    flags:
      pvp: deny
`;

/** 同一份，但 min.x 还是占位符。 */
const PLACEHOLDER = FILLED.replace('      x: 0\n      y: 60', '      x: __FILL_ME__\n      y: 60');

// ══════════════════════════════════════════════════════════════════════════
// 1. 占位符 ⇒ SKIP（不是 OK）
// ══════════════════════════════════════════════════════════════════════════
{
    const parsed = parseRegionDraft(PLACEHOLDER);
    const r = classifyCoverage({ chests: [{ world_id: 'world', team_id: 't', x: 1, y: 64, z: 1 }], parsed });
    if (r.status === 'SKIP' && parsed.placeholders.length > 0) {
        okCase('① 有占位符 ⇒ SKIP（配置未生效，不冒充校验过）', `占位符=${parsed.placeholders.length}`);
    } else {
        badCase('① 占位符没有变成 SKIP', { status: r.status, placeholders: parsed.placeholders });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 2. 坐标在区域里 ⇒ OK
// ══════════════════════════════════════════════════════════════════════════
{
    const parsed = parseRegionDraft(FILLED);
    const r = classifyCoverage({ chests: [
        { world_id: 'world', team_id: 't1', x: 0, y: 60, z: 0 },
        { world_id: 'world', team_id: 't1', x: 10, y: 70, z: 10 },
        { world_id: 'world', team_id: 't2', x: 5, y: 65, z: 5 },
    ], parsed });
    if (r.status === 'OK' && r.covered === 3 && parsed.errors.length === 0) {
        okCase('② 三个坐标都在区域里（含边界）⇒ OK', `covered=${r.covered}`);
    } else {
        badCase('② 覆盖判定不对', { status: r.status, covered: r.covered, errors: parsed.errors });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 3. ★ 负向：一个区域外的坐标 ⇒ FAIL 且点名
// ══════════════════════════════════════════════════════════════════════════
{
    const parsed = parseRegionDraft(FILLED);
    const r = classifyCoverage({ chests: [
        { world_id: 'world', team_id: 't1', x: 3, y: 64, z: 3 },
        { world_id: 'world', team_id: 't1', x: 99, y: 64, z: 3 },
    ], parsed });
    const named = r.uncovered.length === 1 && r.uncovered[0].x === 99;
    if (r.status === 'FAIL' && named) {
        okCase('③ 区域外坐标 ⇒ FAIL，且只点名那一个（(99,64,3)）', `uncovered=${r.uncovered.length}`);
    } else {
        badCase('③ 区域外坐标没有被判红', { status: r.status, uncovered: r.uncovered });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 4. 存档对不上 ⇒ 不算被覆盖（最危险的一种"看起来对"）
// ══════════════════════════════════════════════════════════════════════════
{
    const parsed = parseRegionDraft(FILLED);
    const r = classifyCoverage({ chests: [{ world_id: 'other_world', team_id: 't1', x: 5, y: 65, z: 5 }], parsed });
    if (r.status === 'FAIL' && r.uncovered.length === 1) {
        okCase('④ 存档不同 ⇒ 不算被覆盖（FAIL）', `world=${parsed.world}`);
    } else {
        badCase('④ 跨存档坐标被误判成覆盖了', { status: r.status, uncovered: r.uncovered });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 5. 端到端：真的跑一次脚本 —— SKIP / OK / FAIL 的退出码与输出
// ══════════════════════════════════════════════════════════════════════════
const writeFixture = (name, text) => { const p = join(DIR, name); writeFileSync(p, text, 'utf8'); return p; };

// 造两个库：一个只有"区域内"的坐标，一个含区域外坐标
function makeDb(name, rows) {
    const dir = join(DIR, name);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'board.sqlite');
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE team_chest (
        world_id TEXT NOT NULL, team_id TEXT NOT NULL,
        x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL,
        added_by TEXT, added_at INTEGER NOT NULL,
        PRIMARY KEY (world_id, team_id, x, y, z))`);
    const ins = db.prepare('INSERT INTO team_chest (world_id, team_id, x, y, z, added_by, added_at) VALUES (?,?,?,?,?,?,?)');
    for (const r of rows) ins.run(r.world_id, r.team_id, r.x, r.y, r.z, r.added_by ?? null, r.added_at ?? 1);
    db.close();
    return file;
}

const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

{
    const cfg = writeFixture('placeholder.yml', PLACEHOLDER);
    const db = makeDb('db-skip', [{ world_id: 'world', team_id: 't1', x: 99, y: 64, z: 9 }]);
    const out = run(['--config', cfg, '--db', db]);
    const text = `${out.stdout}${out.stderr}`;
    if (out.status === 0 && text.includes('SKIP')) {
        okCase('⑤-e2e 占位符配置 ⇒ SKIP 且 exit 0（哪怕库里有区域外坐标）', `exit=${out.status}`);
    } else {
        badCase('⑤-e2e 占位符配置没有输出 SKIP/exit0', { status: out.status, text });
    }
}

{
    const cfg = writeFixture('filled.yml', FILLED);
    const db = makeDb('db-ok', [{ world_id: 'world', team_id: 't1', x: 5, y: 65, z: 5 }]);
    const out = run(['--config', cfg, '--db', db]);
    if (out.status === 0 && String(out.stdout).includes('OK')) {
        okCase('⑤-e2e 全部覆盖 ⇒ OK 且 exit 0', `exit=${out.status}`);
    } else {
        badCase('⑤-e2e 全覆盖没有 OK', { status: out.status, out: out.stdout, err: out.stderr });
    }
}

{
    const cfg = writeFixture('filled2.yml', FILLED);
    const db = makeDb('db-fail', [
        { world_id: 'world', team_id: 't1', x: 5, y: 65, z: 5 },
        { world_id: 'world', team_id: 't1', x: 99, y: 65, z: 5 },
    ]);
    const out = run(['--config', cfg, '--db', db]);
    const text = `${out.stdout}${out.stderr}`;
    if (out.status === 1 && text.includes('FAIL') && text.includes('(99,65,5)')) {
        okCase('⑤-e2e ★ 区域外坐标 ⇒ FAIL、exit 1、输出点名 (99,65,5)（这条必须能红）', `exit=${out.status}`);
    } else {
        badCase('⑤-e2e 负向用例没红', { status: out.status, text });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 6. 老库（没有 team_chest 表）⇒ SKIP，不是 OK 也不是 FAIL
// ══════════════════════════════════════════════════════════════════════════
{
    const dir = join(DIR, 'db-old');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'board.sqlite');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE jobs (id TEXT PRIMARY KEY)');
    db.close();
    const cfg = writeFixture('filled3.yml', FILLED);
    const out = run(['--config', cfg, '--db', file]);
    const text = `${out.stdout}${out.stderr}`;
    if (out.status === 0 && text.includes('SKIP')) {
        okCase('⑥ 板库没迁移到队伍版本 ⇒ SKIP（没数据可校验，不冒充全绿）', `exit=${out.status}`);
    } else {
        badCase('⑥ 老库没有如实 SKIP', { status: out.status, text });
    }
}

try { rmSync(DIR, { recursive: true, force: true }); } catch { /* 临时目录删不掉也不影响结论 */ }
console.log(`\n${pass} pass / ${fails} fail`);
process.exit(fails === 0 ? 0 : 1);
