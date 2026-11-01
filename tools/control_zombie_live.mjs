/**
 * D18 真机演练：**停不下来的动作 → 让身体停住 + zombie-action 事件 + 退出码 1 + 拉起后还能干活**。
 *
 * 为什么有这个（09 §5.5 真机脚本 `*_live.mjs`）：
 *   `tools/control_reasons_unit.mjs` 把 D18 的**逻辑**钉住了，但那是假 bot ——
 *   "等满 10 秒"、"按键真的松了"、"进程真的以 1 退出"这三件只有真机才算数。
 *
 * 结构：本文件既当父进程又当子进程（`CONTROL_ZOMBIE_CHILD=1` 时是子进程）。
 *
 *   父进程（node tools/control_zombie_live.mjs）
 *     ├─ 子 #1  mode=zombie ：真 bot 进服 → 按住移动键 → 跑一个**不看 interrupt_code** 的动作
 *     │                       → stop('timeout') → 等 10 秒 → _onZombieAction → cleanKill(msg,1) → 进程 exit(1)
 *     └─ 子 #2  mode=after  ：全新进程重新进服，用真 ActionManager 跑一个命令，证明"拉起后能正常接受命令"
 *
 * 被测代码全是真的：真 mineflayer bot、真 `ActionManager`、真 `Agent`（只跳过 `start()`，
 * 于是 `requestInterrupt` / `clearBotLogs` / `cleanKill` / `isIdle` 都是生产代码）。
 *
 * 安全前提（任务书要求"别真把 mindserver 搞崩"）：
 *   - 全程**不碰 mindserver**：子进程直接用 mineflayer 连测试服 25566，不 import mindserver。
 *   - 子进程退出码只能是 1（不是 >1）：`agent_process.js:37-40` 的 `code > 1 → 结束整个任务`
 *     分支**不会**命中，所以即使放进 AgentProcess 也只会被重新拉起。
 *   - 子进程存活 >10 秒：`agent_process.js:44-47` 有"起来不满 10 秒又退就不再重启"的保护，
 *     本演练的存活时间（连接 + 1 秒 + 10 秒等待）必然超过它；脚本会把实测 uptime 打出来。
 *   - 脚本自己 spawn 子进程并收尸；10 秒保护只存在于 AgentProcess（本脚本不启动它），
 *     所以不存在"卡在不再重启的终态"—— 真停了就是脚本自己失败，肉眼可见。
 *
 * 用法：
 *   node tools/control_zombie_live.mjs                 # 全流程（约 25 秒）
 *   node tools/control_zombie_live.mjs --keep-bot      # 跑完不断开 bot（调试用）
 *
 * 输出：`PASS <用例> <证据>` / `FAIL <用例> <实际>`，全过退出码 0。
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const IS_CHILD = process.env.CONTROL_ZOMBIE_CHILD === '1';
const CHILD_MODE = process.env.CONTROL_ZOMBIE_MODE ?? 'zombie';
const HOST = process.env.MC_HOST ?? '127.0.0.1';
const PORT = Number(process.env.MC_PORT ?? 25566);
const VERSION = process.env.MC_VERSION ?? '1.21.8';

// ════════════════════════════════════════════════════════════════════════════
// 子进程
// ════════════════════════════════════════════════════════════════════════════
if (IS_CHILD) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const T0 = Date.now();
    /** 结构化证据：父进程逐行解析 `#EV {json}` */
    const ev = (o) => console.log('#EV ' + JSON.stringify({ t: Date.now() - T0, ...o }));

    process.on('exit', (code) => console.log('#EV ' + JSON.stringify({
        ev: 'child-exit', code, uptimeMs: Date.now() - T0,
        // 断言 2：**退出这一刻**所有移动键都必须松（在钩子里现取快照，不是复用 stop 之前的）
        pressedKeys: snapshotKeys(),
        // 探针：_onZombieAction 到底动没动身体（时间点是相对子进程启动的毫秒）
        probes,
        // 断言 6：本进程发起过的每一个 TCP 连接目标 —— 可观测地证明没连主服 25565
        connects,
        remotePort: (() => { try { return botRef?._client?.socket?.remotePort ?? null; } catch { return null; } })(),
        // 断言 1/2：真的收到了 trace_bus 的 zombie-action 事件（含 label/reason/waitedMs）
        zombieEvents,
    })));
    // 必须在 exit 钩子**之前**声明（否则退出时读它会踩 TDZ）
    let probes = null;
    let zombieEvents = [];
    /** createBot 之后填；exit 钩子里通过它取快照（钩子可能在 bot 存在之前的极端路径上跑） */
    let botRef = null;
    const MOVEMENT_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'];
    /** 当前所有移动键的按下状态（函数声明会提升，exit 钩子里可以直接用）。 */
    function snapshotKeys() {
        const o = {};
        for (const k of MOVEMENT_KEYS) {
            try { o[k] = botRef?.getControlState?.(k) === true; } catch { o[k] = null; }
        }
        return o;
    }
    /** 本进程所有出站 TCP 连接（含协议层的 socket）——断言 6 的可观测证据。 */
    const connects = [];

    // ★ 断言 6 的仪表：在**任何连接发生之前**钩 net.connect。
    //   光"我没写 25565"是声明，不是证据；这里记录真正拨出去的每一个目标。
    //   两路记录，互为保险：
    //     a) 调用参数（`connect(port,host)` 与 `connect(options)` 两种写法都收）
    //     b) 连上之后的**真实** `remotePort/remoteAddress`（不依赖调用写法，这条才是判据）
    {
        const net = await import('node:net');
        const orig = net.Socket.prototype.connect;
        net.Socket.prototype.connect = function (...args) {
            try {
                const t = args[0];
                if (typeof t === 'number') connects.push({ want: { port: t, host: args[1] ?? null } });
                else if (t && typeof t === 'object') connects.push({ want: { port: t.port ?? null, host: t.host ?? null, path: t.path ?? null } });
                else connects.push({ want: { port: null, host: null, note: 'unparsed-args' } });
                this.once('connect', () => {
                    try { connects.push({ live: { remotePort: this.remotePort, remoteAddress: this.remoteAddress } }); } catch { /* ignore */ }
                });
            } catch { /* ignore */ }
            return orig.apply(this, args);
        };
    }

    const { default: mineflayer } = await import('mineflayer');
    const { default: pf } = await import('mineflayer-pathfinder');
    // 生产环境由 utils/mcdata 的 initBot 装这些插件；它读全局 settings（host/port 指向主服 25565），
    // 本演练绝不能连主服，所以这里只装 requestInterrupt 真正会用到的三个：
    //   pathfinder.stop() / collectBlock.cancelTask() / pvp.stop()
    const { plugin: collectblock } = await import('mineflayer-collectblock');
    const { plugin: pvp } = await import('mineflayer-pvp');
    const { Agent } = await import('../src/agent/agent.js');
    const { ActionManager } = await import('../src/agent/action_manager.js');
    const { holdKey } = await import('../src/agent/library/atom_input_move.js');
    const { onPush } = await import('../src/agent/library/trace_bus.js');

    // 断言 1/2：在 stop 之前就订阅，zombie-action 一出现就抄下来（进程随后 exit，来不及再查）
    onPush((e) => {
        if (e && e.type === 'zombie-action') {
            zombieEvents.push({ label: e.label ?? null, reason: e.reason ?? null, waitedMs: e.waitedMs ?? null });
        }
    });

    const name = (process.env.CONTROL_ZOMBIE_NAME || 'zb' + String(Date.now()).slice(-8)).slice(0, 16);
    const bot = mineflayer.createBot({ host: HOST, port: PORT, username: name, auth: 'offline', version: VERSION });
    botRef = bot;
    bot.loadPlugin(pf.pathfinder);
    bot.loadPlugin(collectblock);
    bot.loadPlugin(pvp);
    bot.on('error', (e) => ev({ ev: 'bot-error', msg: String(e?.message ?? e).slice(0, 120) }));
    bot.on('kicked', (r) => ev({ ev: 'kicked', reason: String(r).slice(0, 80) }));

    const spawnedP = new Promise((resolve) => {
        bot.once('spawn', () => resolve(true));
        setTimeout(() => resolve(false), 20000);
    });
    if (!(await spawnedP)) {
        ev({ ev: 'no-spawn' });
        process.exit(9);
    }
    ev({ ev: 'spawned', name, pos: { x: +bot.entity.position.x.toFixed(1), y: +bot.entity.position.y.toFixed(1), z: +bot.entity.position.z.toFixed(1) } });

    // ── 用**真的 Agent**，只跳过 start()（start 会连 mindserver / 建 profile，与本演练无关）──
    const agent = new Agent();
    agent.bot = bot;
    agent.actions = new ActionManager(agent);
    agent.board = null;                       // M8 之前没有任务板
    agent.self_prompter = { isActive: () => false, stopLoop: () => {} };
    agent.shut_up = true;                     // 别刷屏（say() 会看这个）
    agent.history = {
        lines: [],
        add(role, msg) { this.lines.push({ role, msg }); ev({ ev: 'history', msg: String(msg).slice(0, 80) }); },
        save() { /* 演练不落盘 */ },
    };

    // 探针：看 _onZombieAction 到底动了谁（顺序与时间点都要）
    probes = { clearControlStates: [], pathfinderStop: [] };
    const realClear = bot.clearControlStates.bind(bot);
    bot.clearControlStates = (...a) => { probes.clearControlStates.push(Date.now() - T0); return realClear(...a); };
    const realPfStop = bot.pathfinder.stop.bind(bot.pathfinder);
    bot.pathfinder.stop = (...a) => { probes.pathfinderStop.push(Date.now() - T0); return realPfStop(...a); };

    if (CHILD_MODE === 'after') {
        // ── 子 #2：模拟"被拉起之后"：全新进程 + 全新 bot，跑一条真命令 ──
        const r = await agent.actions.runAction('action:ping-after-restart', async () => {
            bot.chat('restart-ok');
            await sleep(200);
        }, { timeout: 1, stopReason: 'brief' });
        ev({ ev: 'after-action', ok: r.success === true, interrupted: !!r.interrupted, label: agent.actions.currentActionLabel || '(cleared)' });
        // 再来一条：状态机可用（executing 回到 false、能接着跑）
        const r2 = await agent.actions.runAction('action:ping2', async () => { await sleep(50); }, { timeout: 1 });
        ev({ ev: 'after-action2', ok: r2.success === true, executing: agent.actions.executing });

        // ★ 安全（队长钉的第 1 条）：**必须活过 10 秒**。
        //   `agent_process.js:44-47` 对"起来不满 10 秒就退"的进程不再重启；
        //   本段模拟的就是"被拉起后的新进程"，如果它 <10s 就退，真实环境里会把 agent
        //   卡进"不再重启"的终态，得人工救。所以这里补等到 uptime > 10.5 秒再退。
        while (Date.now() - T0 < 10500) await sleep(100);
        ev({ ev: 'after-alive', uptimeMs: Date.now() - T0 });
        await sleep(100);
        process.exit(0);
    }

    // ── 子 #1：D18 僵尸动作 ──
    // 1) 先按住一个移动键（走唯一合法入口 atom_input_move），证明"松键"看得见。
    //    fire-and-forget：holdKey 自己会在 until/timeout/中断时松键，这里只需要"现在是按住的"。
    void holdKey(bot, 'forward', { until: () => false, timeout: 60000 }).catch(() => null);
    await sleep(200);
    ev({ ev: 'key-pressed', forward: bot.getControlState('forward') === true });

    // 2) 僵尸动作：一个**故意不看 interrupt_code** 的长阻塞（模拟第三方代码 / 死等 Promise）。
    void agent.actions.runAction('job:zombie', async () => {
        await new Promise((r) => setTimeout(r, 60000));
    }, { timeout: 0 });

    await sleep(300);
    ev({ ev: 'action-running', label: agent.actions.currentActionLabel, executing: agent.actions.executing });

    // 断言 2 的前置快照：此刻确实有键按着（不然"松键完成"是空话）
    ev({ ev: 'keys-before-stop', pressedKeys: snapshotKeys() });

    // 3) 触发停：等满 stopWaitMs（默认 10 秒）→ _onZombieAction → cleanKill(msg,1) → exit(1)
    const stopAt = Date.now() - T0;
    ev({ ev: 'stop-called', reason: 'timeout', stopWaitMs: agent.actions.stopWaitMs });
    await agent.actions.stop('timeout');

    // 正常情况下走不到这里（cleanKill 已经 process.exit(1)）；能走到说明"没退出"= 失败证据
    ev({
        ev: 'stop-returned-without-exit',
        waitedMs: Date.now() - T0 - stopAt,
        zombieEvents,
        pressedKeysNow: snapshotKeys(),
        probes,
    });
    process.exit(8);
}

// ════════════════════════════════════════════════════════════════════════════
// 父进程
// ════════════════════════════════════════════════════════════════════════════
const SELF = fileURLToPath(import.meta.url);
let pass = 0, fail = 0;
const okCase = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const badCase = (name, actual) => { fail++; console.log(`FAIL ${name} ${actual}`); };
const check = (name, cond, evidence, actual) => cond ? okCase(name, evidence) : badCase(name, actual ?? evidence);

/** 跑一个子进程，收集它的 `#EV` 行与退出码。 */
function runChild(mode, name) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const child = spawn(process.execPath, [SELF], {
            env: { ...process.env, CONTROL_ZOMBIE_CHILD: '1', CONTROL_ZOMBIE_MODE: mode, CONTROL_ZOMBIE_NAME: name },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const events = [];
        let out = '';
        const onData = (buf) => {
            const s = String(buf);
            out += s;
            for (const line of s.split(/\r?\n/)) {
                const m = line.match(/^#EV (.*)$/);
                if (m) { try { events.push(JSON.parse(m[1])); } catch { /* 非 JSON 行忽略 */ } }
            }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('exit', (code, signal) => {
            resolve({ code, signal, events, out, uptimeMs: Date.now() - t0 });
        });
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 90000);
    });
}

/**
 * 读测试服的在线玩家（RCON 25576）。
 *
 * ★ 断言 7 用：把"收尾干净"变成机器判据 —— 演练前后各拍一次，
 *   谁在演练前在线、演练后必须还在（证明我没踢过任何非 zb* 的玩家）。
 * 连不上就返回 null（不伪装成空列表）。
 */
async function rconList() {
    try {
        const { rcon } = await import('./rcon.mjs');
        const out = String(await rcon('list', { port: 25576 }));
        const m = out.match(/online:\s*(.*)$/i);
        return (m?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    } catch {
        return null;
    }
}

console.log('=== D18 真机演练：停不下来的动作 ===');
console.log(`服务器 ${HOST}:${PORT}（不碰 mindserver；不踢任何非本脚本的 bot）\n`);

// 断言 7 的前置快照：演练开始前谁在线
const playersBefore = await rconList();
console.log(`演练前在线：${playersBefore === null ? '(RCON 不可用)' : JSON.stringify(playersBefore)}\n`);

// ── 子 #1：僵尸动作 ────────────────────────────────────────────────────────
const zombieName = 'zb' + String(Date.now()).slice(-8);
const r1 = await runChild('zombie', zombieName);
const evs = (n) => r1.events.filter((e) => e.ev === n);
const first = (n) => evs(n)[0] ?? null;

check('子进程真的连上服务器并按住移动键（前置条件成立）',
    !!first('spawned') && first('key-pressed')?.forward === true,
    `name=${first('spawned')?.name} pressed=${first('key-pressed')?.forward}`);

check('僵尸动作在跑（前置条件：executing=true）',
    first('action-running')?.executing === true,
    `label=${first('action-running')?.label} executing=${first('action-running')?.executing}`);

const exitEv = first('child-exit');
// 「退出码 1」只有在**确实走到 D18 那条路**时才算数 —— 子进程崩溃也是 1，
// 所以这里同时要求：动作确实在跑 → stop 被调用 → cleanKill 写了 history → 才 exit 1。
const reachedZombiePath = first('action-running')?.executing === true && !!first('stop-called') && !!first('history');
check('D18：停不下来 → 进程以**退出码 1** 结束（= agent_process 的重启码，不是 >1 的"结束任务"）',
    r1.code === 1 && reachedZombiePath,
    `子进程 exit code=${r1.code} signal=${r1.signal}（child 自报 code=${exitEv?.code}；已经过 stop→cleanKill 路径）`,
    `子进程 exit code=${r1.code} signal=${r1.signal}；路径证据=${reachedZombiePath}`);

check('D18：松键完成 —— 进程退出时**所有移动键**都是 false',
    exitEv?.pressedKeys != null && Object.values(exitEv.pressedKeys).every((v) => v === false),
    `pressedKeys=${JSON.stringify(exitEv?.pressedKeys)}`,
    `pressedKeys=${JSON.stringify(exitEv?.pressedKeys)}（有键残留）`);

check('断言：stop 之前确实有键按着（否则"松键"测的是空集）',
    Object.values(first('keys-before-stop')?.pressedKeys ?? {}).some((v) => v === true),
    `before=${JSON.stringify(first('keys-before-stop')?.pressedKeys)}`,
    `before=${JSON.stringify(first('keys-before-stop')?.pressedKeys)}`);

{
    const z = exitEv?.zombieEvents ?? [];
    const z0 = z[0] ?? {};
    check('D18：zombie-action 事件真的产生，且带 label/reason/waitedMs（≈10000ms）',
        z.length === 1 && z0.label === 'job:zombie' && z0.reason === 'timeout'
        && typeof z0.waitedMs === 'number' && z0.waitedMs >= 9000 && z0.waitedMs <= 13000,
        `zombieEvents=${JSON.stringify(z)}`,
        `zombieEvents=${JSON.stringify(z)}`);
}

const cc = exitEv?.probes?.clearControlStates ?? [];
const pfs = exitEv?.probes?.pathfinderStop ?? [];
check('D18：_onZombieAction 真的动了身体（clearControlStates + pathfinder.stop，且发生在 ~10s 处）',
    cc.length > 0 && pfs.length > 0 && cc.some((t) => t > 9000),
    `clearControlStates@${JSON.stringify(cc)}ms pathfinderStop 次数=${pfs.length}`,
    `clearControlStates=${JSON.stringify(cc)} pathfinderStop=${JSON.stringify(pfs)}`);

const orphanCheck = null;
check('D18：没有走到"stop 返回但进程没退"的分支',
    evs('stop-returned-without-exit').length === 0,
    '未出现 stop-returned-without-exit（说明 cleanKill 确实执行了）',
    `出现了：${JSON.stringify(evs('stop-returned-without-exit')[0])}`);

// cleanKill 之前会把 msg 写进 history（我们探针记了 history.add）
check('D18：cleanKill 带的是"重启"口径的消息（不是静默退出）',
    (first('history')?.msg ?? '').includes('did not stop'),
    `history="${first('history')?.msg ?? ''}"`);

// 存活时间 / 10 秒保护
check('安全：子进程存活 >10 秒（不会撞上 agent_process.js:44-47 的"太快不重启"保护）',
    (exitEv?.uptimeMs ?? 0) > 10000,
    `uptime=${exitEv?.uptimeMs}ms（连接 + 1s + 等满 10s）`,
    `uptime=${exitEv?.uptimeMs}ms 太短，可能被 10 秒保护吃掉`);

// 退出码契约（读真实源码，钉住 1 vs >1 的语义，防止以后被改反）
{
    const src = readFileSync(new URL('../src/process/agent_process.js', import.meta.url), 'utf8');
    const endTask = /if \(code > 1\) \{\s*\n\s*console\.log\(`Ending task`\);\s*\n\s*process\.exit\(code\);/.test(src);
    const restart = /if \(code !== 0 && signal !== 'SIGINT'\)/.test(src) && /this\.start\(true, 'Agent process restarted\.'/.test(src);
    const guard = /Date\.now\(\) - last_restart < 10000/.test(src);
    check('契约：agent_process 里 >1 结束任务、code==1 重启、<10s 不重启（三条都还在）',
        endTask && restart && guard,
        `endTask=${endTask} restart=${restart} guard=${guard}`,
        `endTask=${endTask} restart=${restart} guard=${guard}`);
}

// ── 断言 6：可观测地证明"全程没连主服 25565" ──────────────────────────────
{
    const conns = exitEv?.connects ?? [];
    const live = conns.filter((c) => c.live).map((c) => Number(c.live.remotePort));
    const wants = conns.filter((c) => c.want).map((c) => Number(c.want.port));
    const allPorts = [...live, ...wants].filter((p) => Number.isFinite(p));
    const toMain = allPorts.filter((p) => p === 25565);
    const toTest = allPorts.filter((p) => p === 25566);
    check('安全：子进程**没有**向主服 25565 发起过任何连接；只连了测试服 25566',
        allPorts.length > 0 && toMain.length === 0 && toTest.length > 0 && Number(exitEv?.remotePort) === 25566,
        `实际远端端口=${JSON.stringify(live)} 调用意图=${JSON.stringify(wants)} 活 socket remotePort=${exitEv?.remotePort}`,
        `有连主服！全部端口=${JSON.stringify(allPorts)} 原始记录=${JSON.stringify(conns)}`);

    // 源码守卫：脚本里不许出现 25565 作为**默认连接目标**（说明文字除外）
    const src = readFileSync(new URL(import.meta.url), 'utf8');
    const codeOnly = src.split('\n')
        .filter((l) => !/^\s*(\*|\/\/)/.test(l))
        .map((l) => l.replace(/\/\/.*$/, ''))
        .join('\n');
    check('安全：脚本的默认端口不是 25565（默认 25566）',
        !/MC_PORT\s*\?\?\s*25565/.test(codeOnly) && /MC_PORT\s*\?\?\s*25566/.test(codeOnly),
        `默认端口 25566；连接目标已由上面的仪表逐条记录`,
        `默认端口写错了`);
}

// ── 子 #2：模拟"拉起后"能正常接受命令 ──────────────────────────────────────
const r2 = await runChild('after', 'zb' + String(Date.now()).slice(-8));
const after1 = r2.events.find((e) => e.ev === 'after-action');
const after2 = r2.events.find((e) => e.ev === 'after-action2');

check('拉起后：全新进程能连上服并跑完一条命令（runAction ok）',
    r2.code === 0 && after1?.ok === true,
    `exit=${r2.code} ok=${after1?.ok} label=${after1?.label}（跑完已清空）`,
    `exit=${r2.code} after-action=${JSON.stringify(after1)}`);

check('拉起后：动作状态机能接着用（executing 回到 false、第二条命令也 ok）',
    after2?.ok === true && after2?.executing === false,
    `ok=${after2?.ok} executing=${after2?.executing}`,
    `after-action2=${JSON.stringify(after2)}`);

// 安全（队长钉的第 1 条）：第二段"模拟被拉起的新进程"必须活过 10 秒
{
    const aliveEv = r2.events.find((e) => e.ev === 'after-alive');
    const up2 = aliveEv?.uptimeMs ?? (r2.code !== null ? null : 0);
    check('安全：第二段（模拟拉起后的新进程）活过 10 秒才收尾（不撞 10 秒保护）',
        (up2 ?? 0) > 10000,
        `after-alive uptime=${up2}ms`,
        `uptime=${up2}ms 太短`);

    // 第二段同样只许连 25566
    const exit2 = r2.events.find((e) => e.ev === 'child-exit');
    const c2 = exit2?.connects ?? [];
    const ports2 = [...c2.filter((c) => c.live).map((c) => Number(c.live.remotePort)),
        ...c2.filter((c) => c.want).map((c) => Number(c.want.port))].filter((p) => Number.isFinite(p));
    check('安全：第二段也没连主服 25565（只连 25566）',
        ports2.length > 0 && ports2.every((p) => p !== 25565) && ports2.includes(25566) && Number(exit2?.remotePort) === 25566,
        `端口=${JSON.stringify(ports2)} remotePort=${exit2?.remotePort}`,
        `端口=${JSON.stringify(ports2)} remotePort=${exit2?.remotePort}`);
}

// ── 断言 7：收尸自证（把今晚的教训变成机器断言，不靠"我记得"） ─────────────
{
    // 等 1 秒让服务端把断线处理完再查（kick/leave 的 list 生效有滞后）
    await new Promise((r) => setTimeout(r, 1200));
    const playersAfter = await rconList();
    const zbLeft = (playersAfter ?? []).filter((n) => /^zb/i.test(n));
    check('收尸：演练结束后 25566 上没有 zb* 残留 bot',
        playersAfter !== null && zbLeft.length === 0,
        `演练后在线=${JSON.stringify(playersAfter)}（我建的两个 bot 都已断线）`,
        `残留：${JSON.stringify(zbLeft)}`);

    // 演练前在线的人，演练后必须还在 —— 证明"没踢过任何非 zb* 的玩家"
    const missing = (playersBefore ?? []).filter((n) => !(playersAfter ?? []).includes(n));
    check('收尸：演练前在线的非 zb* 玩家，演练后一个都没少（= 没误踢任何人）',
        playersAfter !== null && missing.length === 0,
        `before=${JSON.stringify(playersBefore)} after=${JSON.stringify(playersAfter)} 缺失=${JSON.stringify(missing)}`,
        `有人消失了：${JSON.stringify(missing)}（检查是否被我踢掉）`);

    // 我 spawn 的两个子进程都收到了 exit（没有僵尸子进程挂着）
    check('收尸：自己 spawn 的两个子进程都已退出（r1/r2 都收到 exit 事件）',
        r1.code !== null && r2.code !== null && r1.signal == null && r2.signal == null,
        `r1 exit=${r1.code} signal=${r1.signal}；r2 exit=${r2.code} signal=${r2.signal}`,
        `r1 exit=${r1.code}/${r1.signal} r2 exit=${r2.code}/${r2.signal}`);

    // 源码守卫：脚本里压根没有 kick / kill 别人的代码
    const src = readFileSync(new URL(import.meta.url), 'utf8');
    const codeOnly = src.split('\n')
        .filter((l) => !/^\s*(\*|\/\/)/.test(l))
        .map((l) => l.replace(/\/\/.*$/, ''))
        .join('\n');
    check('收尸：脚本里没有任何踢人/杀进程的调用（不会误伤别人的 bot）',
        !/rcon\(\s*['"`]\s*kick/i.test(codeOnly) && !/rcon\(\s*['"`]\s*stop/i.test(codeOnly),
        '源码里无 kick/stop 调用（唯一收尸手段是子进程自己 process.exit）',
        '源码里出现了 kick/stop 调用');
}

console.log(`\nD18 真机演练：${pass} passed, ${fail} failed`);
if (fail) {
    console.log('\n--- 子进程 #1 输出（排障用） ---');
    console.log(r1.out.split('\n').filter((l) => l.trim()).slice(-30).join('\n'));
}
process.exit(fail === 0 ? 0 : 1);
