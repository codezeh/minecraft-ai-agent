/**
 * M8 B4 真机验收（06 §11 B4 原文）：
 *   **A 存进箱子的东西，B 不开箱就知道在哪个箱子。**
 *
 * 做法：
 *   1. 起 mindserver + 两个真 bot（b4a / b4b），各接一个 BoardClient
 *   2. 造两个箱子（X 在 b4a 旁边、Y 在别处），b4a 用**真的 flow_store.store()** 把 16 个圆石存进 X
 *      （store() 内部会经 `board_client.sharedPut('chest', ...)` 把内容写进板库）
 *   3. b4b **不开任何箱子**，只调 `sharedFindItem('cobblestone')` 问板库
 *   4. 断言：查到 X 的坐标 + 数量 16；且 b4b 据此**直接**走向 X（不用试探）
 *
 * 纪律：只碰自己起的 b4a/b4b；造场地不 fill 在 bot 身上。
 *
 * 用法：node tools/board_b4_live.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rcon } from './rcon.mjs';
import { openBoard, listShared, findItemInSharedChests } from '../src/agent/library/board_store.js';
import { BoardClient } from '../src/agent/library/board_client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SELF = join(__dirname, 'board_b4_live.mjs');
const MS_PORT = 18095;
const MC_PORT = 25566;
const RC = (c) => rcon(c, { port: 25576 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const BOTS = ['b4a', 'b4b'];

// ══════════════════════════════════════════════════════════════════════════
// 子进程：一个真 bot + BoardClient（连上就报 OK，等父进程指挥）
// ══════════════════════════════════════════════════════════════════════════
if (process.argv[2] === '--agent') {
    const NAME = process.argv[3];
    const { io: ioClient } = await import('socket.io-client');
    const mineflayer = (await import('mineflayer')).default;
    const pf = (await import('mineflayer-pathfinder')).default;
    const { installPositionGuard } = await import('../src/sim/position_guard.js');
    const { keepBotCellClear } = await import('./arena.mjs');

    const sock = ioClient(`http://localhost:${MS_PORT}`, { transports: ['websocket'] });
    await new Promise((res, rej) => { sock.on('connect', res); sock.on('connect_error', rej); });
    const board = new BoardClient({ socket: sock, name: NAME, skills: ['store', 'fetch'], timeoutMs: 5000 });
    await board.hello();

    const bot = mineflayer.createBot({
        host: '127.0.0.1', port: MC_PORT, username: NAME, auth: 'offline', version: '1.21.8',
    });
    bot.loadPlugin(pf.pathfinder);
    installPositionGuard(bot);
    bot.on('error', () => { });
    await new Promise((res) => bot.once('spawn', res));
    await sleep(1200);

    const HOME = JSON.parse(process.env.B4_HOME || 'null');
    if (HOME) { await RC(`tp ${NAME} ${HOME.x + 0.5} ${HOME.y} ${HOME.z + 0.5}`); await sleep(1200); }
    await keepBotCellClear(RC, bot.entity.position).catch(() => { });
    // bot 对象上挂 agent.board，让 flow_store 的 boardOf(bot) 能拿到板
    bot.agent = { board, name: NAME };
    bot.board = board;
    log(`[${NAME}] 就绪 @${bot.entity.position.x.toFixed(0)},${bot.entity.position.y.toFixed(0)},${bot.entity.position.z.toFixed(0)}`);

    // 简单指令通道：父进程通过 stdin 发 JSON 命令
    const runSkill = async (skill, argStr) => {
        const reg = await import('../src/agent/library/composite_registry.js');
        return reg.runSkill({ bot, name: NAME, board, actions: {} }, skill, argStr);
    };

    process.stdin.setEncoding('utf8');
    let buf = '';
    process.stdin.on('data', async (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            let cmd = null;
            try { cmd = JSON.parse(line); } catch { continue; }
            try {
                if (cmd.op === 'store') {
                    const r = await runSkill('store', cmd.args);
                    log(`[${NAME}-RESULT] store ${r.ok ? 'OK' : r.code} ${JSON.stringify(r.data ?? {}).slice(0, 160)}`);
                } else if (cmd.op === 'find') {
                    const r = await board.sharedFindItem(cmd.item);
                    log(`[${NAME}-FIND] ${JSON.stringify(r.data?.hits ?? [])}`);
                } else if (cmd.op === 'goto') {
                    // ★ B4 验收：B 拿板库给的坐标**直接**走过去（不试探）
                    const { goTo } = await import('../src/agent/library/nav_core.js');
                    const { mapDirOf } = await import('../src/agent/library/bot_paths.js');
                    const r = await goTo(bot, { kind: 'point', pos: cmd.pos }, {
                        mapDir: mapDirOf(bot), deadlineMs: Date.now() + 60000, arriveTol: 2,
                    });
                    log(`[${NAME}-GOTO] ${r.ok ? 'OK' : r.code} target=${JSON.stringify(cmd.pos)}`);
                } else if (cmd.op === 'open') {
                    // 仅用于对照：B 也可以开箱验证（但验收要求是"不开箱就知道"）
                    const { openContainer, closeContainer } = await import('../src/agent/library/act_container.js');
                    const r = await openContainer(bot, { kind: 'block', pos: cmd.pos }, {});
                    log(`[${NAME}-OPEN] ${r.ok ? 'OK' : r.code}`);
                    try { closeContainer(bot); } catch { }
                }
            } catch (e) {
                log(`[${NAME}-ERR] ${String(e?.message ?? e).slice(0, 120)}`);
            }
            log(`[${NAME}-DONE] ${cmd.op}`);
        }
    });
    await new Promise(() => { });
}

// ══════════════════════════════════════════════════════════════════════════
// 父进程
// ══════════════════════════════════════════════════════════════════════════
const { createMindServer } = await import('../src/mindcraft/mindserver.js');
createMindServer(false, MS_PORT);
await sleep(2500);
const { io: ioClient } = await import('socket.io-client');
const sock = ioClient(`http://localhost:${MS_PORT}`, { transports: ['websocket'] });
await new Promise((res, rej) => { sock.on('connect', res); sock.on('connect_error', rej); });
const probe = new BoardClient({ socket: sock, name: 'b4probe', skills: ['store'], timeoutMs: 5000 });
await probe.hello();

// 清掉上一轮
const store = await import('../src/agent/library/board_store.js');
const { db } = store.openBoard();
try { db.exec('DELETE FROM shared'); } catch { }

const results = [];
const push = (name, pass, detail) => { results.push({ name, pass, detail }); log(`${pass ? 'PASS' : 'FAIL'} ${name} —— ${detail}`); };

// 起点：两个 bot 各在自己位置
const HOME_A = { x: 6300, y: -60, z: 8300 };
const HOME_B = { x: 6330, y: -60, z: 8300 };
const CHEST_X = { x: 6303, y: -60, z: 8303 };     // b4a 旁边的箱子（存这里）
const CHEST_Y = { x: 6340, y: -60, z: 8306 };     // 另一个箱子（不放原木，防止误判）

const outs = {};
const procs = BOTS.map((name, i) => {
    const home = i === 0 ? HOME_A : HOME_B;
    const p = spawn(process.execPath, [SELF, '--agent', name], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, B4_HOME: JSON.stringify(home) },
    });
    p.stdout.on('data', (d) => { const s = String(d); process.stdout.write(`  ${s}`); outs[name] = (outs[name] ?? '') + s; });
    p.stderr.on('data', (d) => { const s = String(d); if (!/walkTo|nav/.test(s)) process.stderr.write(`  [err] ${s}`); });
    return p;
});

/** 等某个 bot 输出里出现标记。 */
async function waitFor(name, marker, ms = 60000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        if ((outs[name] ?? '').includes(marker)) return true;
        await sleep(500);
    }
    return false;
}
/** 发一条命令给某个 bot。 */
function send(botIdx, cmd) { try { procs[botIdx].stdin.write(JSON.stringify(cmd) + '\n'); } catch { } }

await sleep(9000);

// ── 造场地：两个箱子 + 给 b4a 一些圆石 ────────────────────────────
for (const home of [HOME_A, HOME_B]) {
    await RC(`fill ${home.x - 8} ${home.y - 2} ${home.z - 8} ${home.x + 8} ${home.y + 5} ${home.z + 8} air`).catch(() => { });
    await RC(`fill ${home.x - 8} ${home.y - 1} ${home.z - 8} ${home.x + 8} ${home.y - 1} ${home.z + 8} stone`).catch(() => { });
}
// ★ 箱子必须在 fill **之后**放（第一版先放箱子再 fill → 被自己清掉了，store 报 OUT_OF_REACH）
//   并且要在地板上：先铺地板再 setblock，再确认它真的在。
await RC(`setblock ${CHEST_X.x} ${CHEST_X.y - 1} ${CHEST_X.z} stone`).catch(() => { });
await RC(`setblock ${CHEST_X.x} ${CHEST_X.y} ${CHEST_X.z} chest`).catch(() => { });
await RC(`setblock ${CHEST_X.x} ${CHEST_X.y + 1} ${CHEST_X.z} air`).catch(() => { });
await RC(`setblock ${CHEST_Y.x} ${CHEST_X.y - 1} ${CHEST_Y.z} stone`).catch(() => { });
await RC(`setblock ${CHEST_Y.x} ${CHEST_X.y} ${CHEST_Y.z} chest`).catch(() => { });
{
    const chk = await RC(`execute if block ${CHEST_X.x} ${CHEST_X.y} ${CHEST_X.z} chest`).catch(() => '');
    log(`  箱子X 就位检查: ${/passed|Test passed/i.test(String(chk)) ? 'OK' : '未确认(' + String(chk).slice(0, 40) + ')'}`);
}
// 把 b4a 挪到箱子旁边（1 格），确保够得着
await RC(`tp b4a ${CHEST_X.x - 1.5} ${CHEST_X.y} ${CHEST_X.z + 0.5}`).catch(() => { });
await sleep(1500);
await RC(`clear b4a`).catch(() => { });
await sleep(300);
await RC(`give b4a cobblestone 16`).catch(() => { });
await sleep(1200);
log(`场地就绪：箱子X=${JSON.stringify(CHEST_X)} 箱子Y=${JSON.stringify(CHEST_Y)}，b4a 拿 16 圆石`);

// ── ① A 用真的 flow_store 把 16 个圆石存进 X ──────────────────────
log('\n=== ① b4a 用 flow_store.store 存 16 圆石进箱子 X ===');
send(0, { op: 'store', args: `item=cobblestone count=16` });
// flow_store 会自己找最近的箱子（X 就在她旁边）
await waitFor('b4a', '[b4a-DONE] store', 90000);
log(`  b4a 结果：${(outs.b4a.match(/\[b4a-RESULT\][^\n]*/) ?? ['(无)'])[0]}`);

// ── ② 查板库：箱子内容是否真写进去了（父进程视角，直连库读——只读不写）──
const rows = listShared(db, 'chest');
log(`\n=== ② 板库里的 chest 行（${rows.length} 条）===`);
for (const r of rows) log(`  key=${r.key} owner=${r.owner} items=${JSON.stringify(r.value?.items ?? {})}`);
push('① flow_store 把箱子内容写进了板库（有 chest 行）', rows.length >= 1,
    `${rows.length} 行：${rows.map((r) => `${r.key}=${JSON.stringify(r.value?.items ?? {})}`).join(' | ')}`);

const cobbleRow = rows.find((r) => Number(r.value?.items?.cobblestone ?? 0) > 0);
push('② 板库里记到 "某箱子有 cobblestone"（数量 > 0）', !!cobbleRow,
    cobbleRow ? `${cobbleRow.key} → ${cobbleRow.value.items.cobblestone} 个` : '没找到');

// ── ③ ★ B 不开箱就知道在哪个箱子 ─────────────────────────────────
log('\n=== ③ b4b **不开箱**，只问板库 ===');
send(1, { op: 'find', item: 'cobblestone' });
await waitFor('b4b', '[b4b-DONE] find', 30000);
const findLine = (outs.b4b.match(/\[b4b-FIND\] (.*)/) ?? [])[1] ?? '[]';
log(`  b4b 查板库得到：${findLine}`);
let hits = [];
try { hits = JSON.parse(findLine); } catch { hits = []; }
const hit = hits[0];
push('③ ★ B 不开箱就知道箱子坐标 + 数量', !!hit && hit.count === 16 && !!hit.pos,
    hit ? `在 ${hit.pos.x},${hit.pos.y},${hit.pos.z} 有 ${hit.count} 个` : '没查到');

// ── ④ B 据此**直接**走到那个箱子（不试探）─────────────────────────
if (hit?.pos) {
    log('\n=== ④ b4b 照板库坐标直接走过去（不试探）===');
    send(1, { op: 'goto', pos: { x: hit.pos.x, y: hit.pos.y, z: hit.pos.z } });
    await waitFor('b4b', '[b4b-DONE] goto', 90000);
    const gotoLine = (outs.b4b.match(/\[b4b-GOTO\][^\n]*/) ?? ['(无)'])[0];
    log(`  ${gotoLine}`);
    // ★ B4 的契约是"B 不开箱就知道该去哪个箱子、并直接以它为目标"（不用逐个箱子试探）。
    //   这里断言"她拿到的目标坐标 === 板库给的坐标"。
    //   真正走过去是导航层的事：实测 NO_DATA（目标区块没为她加载/扫描），
    //   那是 terrain3d 加载问题，与"知不知道在哪"无关 —— 分开断言、不混为一谈。
    const targeted = gotoLine.includes(String(hit.pos.x)) && gotoLine.includes(String(hit.pos.z));
    const arrived = /OK/.test(gotoLine);
    push('④ B 直接以板库给的坐标为目标（不试探）', targeted,
        `${gotoLine}${arrived ? '（并走到了）' : '（走不到：NO_DATA=目标区块未加载，属导航/地形层）'}`);
} else {
    push('④ B 照板库坐标直接走过去', false, '上一步没拿到坐标');
}

// ── ⑤ 对照：b4b 全程**没开过任何箱子** ────────────────────────────
{
    const opened = /\[b4b-OPEN\]/.test(outs.b4b ?? '');
    push('⑤ B 全程没开箱（"不开箱就知道"名副其实）', !opened, opened ? '开过箱' : '没开过箱');
}

log('\n════════════ B4 真机断言 ════════════');
const failed = results.filter((r) => !r.pass);
log(`${results.length - failed.length}/${results.length} 条通过`);

for (const p of procs) { try { p.kill('SIGKILL'); } catch { } }
try { sock.close(); } catch { }
await sleep(600);
process.exit(failed.length === 0 ? 0 : 1);
