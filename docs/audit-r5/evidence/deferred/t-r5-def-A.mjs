/**
 * t-r5-def-A —— R4 遗留条 A：gracefulStop「先摘租约、后断连」是否仍只是静态确证？
 *
 * 三段证据：
 *   ① 静态顺序：init_agent.js 里 ④ `board.update(...)` / `release(...)` 的行号
 *      必须都 **小于** ⑤ `board.socket.disconnect()` 的行号（顺序反了就等于"先死再摘"）。
 *   ② 测试盘点：tools/*.mjs 里有没有**真进程级**触发 —— 即 spawn 出真子进程、
 *      发 SIGINT/SIGTERM、然后断言"租约行被清成 ready/lease_owner=NULL"。
 *      （只有正则匹配源码文本、或假 child（EventEmitter）的，都不算。）
 *   ③ 真机尝试：真起一个 mindserver + 真 spawn `node src/process/init_agent.js`，
 *      看能不能把子进程推到"信号处理器已装好"的状态，再发 SIGINT。
 *
 * 退出码：0 = 能真机验证且通过；1 = 仍无法真机验证；2 = CANNOT-RUN。
 */
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.R5_MC || path.resolve(HERE, '../../../../mindcraft'));
const say = (...a) => console.log('[A]', ...a);
const INIT = path.join(ROOT, 'src/process/init_agent.js');

if (!fs.existsSync(INIT)) {
    console.error('[A] CANNOT-RUN：找不到 ' + INIT);
    process.exit(2);
}
const src = fs.readFileSync(INIT, 'utf8').split('\n');
const lineOf = (needle) => src.findIndex((l) => l.includes(needle)) + 1;

// ── ① 静态顺序 ───────────────────────────────────────────────────────────────
const L_update = lineOf('await agent?.board?.update?.(id, {');
const L_release = lineOf('await agent?.board?.release?.(id)');
const L_sig = lineOf("for (const sig of ['SIGINT', 'SIGTERM'])");
// ⚠ 必须在 release 之后找 disconnect：文件前面（孤儿监视器 onOrphan 里）还有**另一处** disconnect，
//   按"第一次出现"抓会抓到那一处，得出"顺序不成立"的假结论（踩过）。
const L_disc = src.findIndex((l, i) => i + 1 > L_release && l.includes("agent?.board?.socket?.disconnect?.();")) + 1;
say('init_agent.js 行号：④ board.update =', L_update, ' ④b board.release =', L_release,
    ' ⑤ socket.disconnect =', L_disc, ' 信号注册 =', L_sig);
const orderOk = L_update > 0 && L_release > 0 && L_disc > 0 && L_update < L_disc && L_release < L_disc;
say('顺序断言（④ 与 release 都在 disconnect 之前）：', orderOk ? 'ok' : '不成立');
if (!orderOk) {
    say('顺序不成立 ⇒ 这条遗留已经变成真缺陷（先死再摘）');
    process.exit(0);
}

// ── ② 测试盘点：有没有真进程级触发 ──────────────────────────────────────────
const toolsDir = path.join(ROOT, 'tools');
const files = fs.existsSync(toolsDir) ? fs.readdirSync(toolsDir).filter((f) => f.endsWith('.mjs')) : [];
const rows = [];
for (const f of files) {
    const t = fs.readFileSync(path.join(toolsDir, f), 'utf8');
    if (!/SIGINT|SIGTERM/.test(t)) continue;
    const realSpawn = /spawn\(\s*process\.execPath|spawnSync\(\s*process\.execPath/.test(t);
    const fakeChild = /makeFakeChild|new EventEmitter\(\)[\s\S]{0,200}kill\(/.test(t);
    const readsInitAgent = /init_agent\.js/.test(t);
    const leaseAssert = /lease_owner\s*===?\s*null|lease_owner:\s*null/i.test(t) || /state\s*===?\s*'ready'/.test(t);
    rows.push({ f, realSpawn, fakeChild, readsInitAgent, leaseAssert });
}
say('提到 SIGINT/SIGTERM 的 tools 文件数：', rows.length);
const realTrigger = rows.filter((r) => r.realSpawn && r.readsInitAgent && r.leaseAssert);
for (const r of rows) {
    say(`  ${r.f.padEnd(34)} realSpawn=${r.realSpawn ? 'Y' : 'n'} fakeChild=${r.fakeChild ? 'Y' : 'n'}`
        + ` 读init_agent=${r.readsInitAgent ? 'Y' : 'n'} 断言租约=${r.leaseAssert ? 'Y' : 'n'}`);
}
say('真进程级 + 断言租约的测试数：', realTrigger.length, realTrigger.length ? JSON.stringify(realTrigger.map((r) => r.f)) : '');

// ── ③ 真机尝试：真 mindserver + 真 spawn init_agent ─────────────────────────
const PORT = 65123;
const runChild = async (port, label, waitMs = 9000) => {
    const child = spawn(process.execPath, ['src/process/init_agent.js', 'probeA', '-n', 'probeA', '-p', String(port)], {
        cwd: ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const exitP = new Promise((res) => child.on('exit', (code, sig) => res({ code, sig })));
    const exitedEarly = await Promise.race([
        exitP.then((r) => ({ early: true, ...r })),
        new Promise((res) => setTimeout(() => res({ early: false }), waitMs)),
    ]);
    if (!exitedEarly.early) {
        say(`[${label}] 子进程仍活着 ⇒ 发 SIGINT`);
        child.kill('SIGINT');
    }
    const final = exitedEarly.early ? exitedEarly : await exitP;
    const handlerInstalled = /先摘租约\/放预约，再退出/.test(out);
    return { out, final, handlerInstalled, reachedStarting: /Starting agent/.test(out) };
};

// 场景 1：没有 mindserver（子进程应在 connect 阶段就死，处理器根本没装上）
const s1 = await runChild(65001, '无mindserver', 6000);
say('[场景1 无mindserver] exit=', JSON.stringify(s1.final), ' reachedStarting=', s1.reachedStarting,
    ' graceful 行=', s1.handlerInstalled);
say('  └ 关键输出：', (s1.out.split('\n').find((l) => /Connection failed|websocket error/.test(l)) || '(无)').trim().slice(0, 110));

// 场景 2：真 mindserver（子进程能连上，但 agent 未注册 ⇒ 仍走不到信号处理器）
let s2 = null;
try {
    const { createMindServer } = await import(pathToFileURL(path.join(ROOT, 'src/mindcraft/mindserver.js')).href);
    createMindServer(false, PORT);
    await new Promise((r) => setTimeout(r, 900));
    s2 = await runChild(PORT, '真mindserver', 9000);
    say('[场景2 真mindserver] exit=', JSON.stringify(s2.final), ' reachedStarting=', s2.reachedStarting,
        ' graceful 行=', s2.handlerInstalled);
    say('  └ 关键输出：', (s2.out.split('\n').find((l) => /not found|Starting agent|connected to MindServer/.test(l)) || '(无)').trim().slice(0, 110));
} catch (e) {
    say('[场景2] mindserver 起不来：', String(e?.message ?? e).slice(0, 140));
}

// ── 判定 ────────────────────────────────────────────────────────────────────
console.log('');
say('=== 结论 ===');
say('① 静态顺序成立（④/release 行号 < disconnect 行号）：', orderOk);
say('② 真进程级 + 断言租约的测试：', realTrigger.length, '个');
say('③ 真机尝试：场景1 reachedStarting=', s1.reachedStarting, '；场景2 reachedStarting=', s2?.reachedStarting ?? 'n/a');
say('   「先摘租约」这一段被真机触发过吗：',
    (s2?.reachedStarting && s2?.handlerInstalled) ? '是' : '否（离线到不了持租约状态）');

if (realTrigger.length > 0) {
    say('复现/闭合：存在真进程级触发并断言租约的测试 ⇒ 这条遗留已闭合');
    process.exit(0);
}
say('Verdict=1 仍无法真机验证：租约清理段（④/⑤）只有静态顺序 + 源码正则断言；'
    + '要真机验证必须在"子进程持着租约"时发 SIGINT，而那需要可连的 MC 服（agent.start() 之后 scheduler 才会领单）');
process.exit(1);
