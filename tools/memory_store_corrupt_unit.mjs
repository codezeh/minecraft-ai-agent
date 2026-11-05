/**
 * `memory_store.readStore`：**损坏必须留证**（报告第25条）—— 离线，真文件。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 病根：`readStore()` 的 catch 只 warn 一句就返回默认值，**且不备份**。
 *   于是 `updateStore()` 的"读 → 改 → 整份重写"会把**原文件里还剩的数据永久覆盖**
 *   （`writeStore` 是 `rename` 整份替换），而日志只有一行 warn。
 *
 *   现在：读不出来 → 先把原文件改名成 `<name>.json.corrupt-<时间戳>`（留证）
 *   → 再告警（点名备份路径）→ 返回默认值。做法与 `board_store` 的 `.corrupt-` 对齐。
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 输出：PASS / FAIL，全过退出码 0。
 * 注意：`memory_store` 的目录是 `process.cwd()/bots/<username>/memory`（写死），
 *       所以这里用一个独有的 bot 名 + 跑完整体删除，避免碰到真实记忆。
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readStore, writeStore, updateStore } from '../src/agent/library/memory_store.js';

let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

const BOT = { username: '_t30_mem_probe' };
const DIR = resolve(process.cwd(), 'bots', BOT.username, 'memory');
rmSync(resolve(process.cwd(), 'bots', BOT.username), { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
const fileOf = (ns) => join(DIR, `${ns}.json`);
const backupsOf = (ns) => readdirSync(DIR).filter((f) => f.startsWith(`${ns}.json.corrupt-`));
const wipe = (ns) => {
    for (const f of readdirSync(DIR)) if (f.startsWith(`${ns}.json`)) rmSync(join(DIR, f), { force: true });
};

// ══════════════════════════════════════════════════════════════════════════
// ① 坏 JSON → 返回默认值 + 备份留证（★ 本次修复的核心）
// ══════════════════════════════════════════════════════════════════════════
{
    wipe('chests');
    const bad = '{ "data": [ { "x": 1,  <<< 这不是 JSON';
    writeFileSync(fileOf('chests'), bad, 'utf8');
    const got = readStore(BOT, 'chests');
    const backups = backupsOf('chests');
    const backupPath = backups.length ? join(DIR, backups[0]) : null;
    const backupContent = backupPath && existsSync(backupPath) ? readFileSync(backupPath, 'utf8') : '';
    const good = Array.isArray(got) && got.length === 0
        && backups.length === 1 && backupContent === bad
        && !existsSync(fileOf('chests'));                      // 原文件已改名（腾出位置，不会被覆盖）
    if (good) {
        okCase('★ ① 坏 JSON → 返回默认值 + 原文件改名留证（内容一字不差）',
            `backup=${backups[0]} 长度=${backupContent.length}`);
    } else {
        badCase('① 损坏没有留证（第25条回归）', { got, backups, backupContent: backupContent.slice(0, 40), 原文件还在: existsSync(fileOf('chests')) });
    }
}

// ② 留证之后再写 → 备份仍在、新文件独立（★ 这正是"永久覆盖"被堵住的地方）
{
    const okWrite = writeStore(BOT, 'chests', [{ x: 7, y: 64, z: 7, note: '新的' }]);
    const backups = backupsOf('chests');
    const fresh = JSON.parse(readFileSync(fileOf('chests'), 'utf8'));
    const good = okWrite === true && backups.length === 1
        && fresh.data?.length === 1 && fresh.data[0].x === 7;
    if (good) okCase('② 损坏后写入：新数据独立成文、坏文件仍在留证位（没被覆盖）',
        `backup=${backups[0]} 新条目=${fresh.data.length}`);
    else badCase('② 写入把留证文件覆盖了 / 新数据不对', { okWrite, backups, fresh });
}

// ③ 反向对照：正常文件 → **不产生** .corrupt- 备份，读到的就是原数据
{
    wipe('sites');
    writeStore(BOT, 'sites', [{ x: 1, y: 2, z: 3, note: '工地' }]);
    const got = readStore(BOT, 'sites');
    const backups = backupsOf('sites');
    const good = got?.length === 1 && got[0].note === '工地' && backups.length === 0;
    if (good) okCase('③ 正向对照：好文件照常读，不产生任何 .corrupt- 备份', `backups=${backups.length}`);
    else badCase('③ 好文件也被当成坏文件', { got, backups });
}

// ④ 文件不存在 → 默认值 + **不**产生备份（没有文件可留证，别造垃圾）
{
    wipe('dangers');
    const got = readStore(BOT, 'dangers');
    const backups = backupsOf('dangers');
    const good = Array.isArray(got) && got.length === 0 && backups.length === 0;
    if (good) okCase('④ 文件不存在 → 默认值且不留空备份', `backups=${backups.length}`);
    else badCase('④ 文件不存在时行为不对', { got, backups });
}

// ⑤ 空文件（0 字节）→ 默认值；**当前不备份**（空文件没有可抢救的内容）
//    ★ 这条是"照实记录"：空文件走的是 `if (!raw.trim())` 早返回，不进 catch。
//      写出来是为了让下一个人知道这不是漏测，是有意的边界。
{
    wipe('tasks');
    writeFileSync(fileOf('tasks'), '   \n  ', 'utf8');
    const got = readStore(BOT, 'tasks');
    const backups = backupsOf('tasks');
    const good = got && typeof got === 'object' && backups.length === 0;
    if (good) okCase('⑤ 空白文件 → 默认值、不备份（没有可抢救的内容，有意为之）', `backups=${backups.length}`);
    else badCase('⑤ 空白文件行为变了（须重判）', { got, backups });
}

// ⑥ 端到端：`updateStore` 在损坏之后不会把数据写丢（读默认值 → 加一条 → 落盘）
{
    wipe('chests');
    writeFileSync(fileOf('chests'), 'not json at all', 'utf8');
    const backupsBefore = backupsOf('chests').length;
    const added = updateStore(BOT, 'chests', (list) => { list.push({ x: 9, y: 70, z: 9 }); return list.length; });
    const backupsAfter = backupsOf('chests').length;
    const fresh = JSON.parse(readFileSync(fileOf('chests'), 'utf8'));
    const good = added === 1 && backupsAfter === backupsBefore + 1
        && fresh.data?.length === 1 && fresh.data[0].x === 9;
    if (good) okCase('★ ⑥ 端到端：损坏后 updateStore 仍留证再落盘（数据不再被静默吞掉）',
        `backups=${backupsAfter} 落盘条目=${fresh.data.length}`);
    else badCase('⑥ 端到端 updateStore 行为不对', { added, backupsBefore, backupsAfter, fresh });
}

try { rmSync(resolve(process.cwd(), 'bots', BOT.username), { recursive: true, force: true }); } catch { /* ignore */ }

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
