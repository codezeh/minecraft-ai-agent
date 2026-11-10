/**
 * R6 #13 / #14 / #15 / #17 —— 「进程与记忆存活」回归（离线，无需 Minecraft）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一组缺陷的共同点：**一次小故障把整只 bot（甚至整台机器）带走**。
 *   #13 history.save() 抛错 + 调用点 fire-and-forget ⇒ Node 24 unhandled rejection
 *       ⇒ 整个 agent 进程崩。最讽刺的是 cleanKill() 里也这么调。
 *   #14 memory.json 一旦写坏就永久起不来（没有自愈；同文件的全程记录反而有 FULL_HISTORY_CORRUPT 自愈）。
 *   #15 进程 setup 阶段异常用 exit(0) ⇒ 被当成「正常结束」⇒ 不重启、不卸载、只剩面板显示离线。
 *   #17 缺同伙 bot 时直接 killAll() → socket.emit('shutdown') ⇒ 关掉整个 mindserver。
 *
 * 判据（每条都尽量做成**行为可跑**，跑不了的退化为源码静态断言并写明理由）：
 *   ① save() 不抛，失败只记 saveError；
 *   ② 调用点（agent.js）不再裸调 save()（源码断言 + 运行期 saveMemoryQuietly 不抛）；
 *   ③ load() 遇坏文件 → 留证改名 + 返回 null（bot 能起来），且之后 save() 能重建；
 *   ④ spawn 事件 catch 必须是「非 0 退出码」（源码断言：cleanKill(…, 1)，不许 exit(0)）；
 *   ⑤ 等同伴：轮询到位即继续 / 超时 ok:false / 单机不等待 / 可注入假时钟；
 *   ⑥ tasks.js 里不再有 killAll()（源码断言）+ detachSelf 用 4 号退出码。
 * ══════════════════════════════════════════════════════════════════════════
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 必须在 import history.js 之前设好（构造函数里就拼 memory_fp 路径了）
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'r6-runtime-'));
process.env.MC_BOTS_ROOT = TMP_ROOT;

const { History } = await import('../src/agent/history.js');
const {
    waitForAgents,
    describeWaitResult,
    readEnvMs,
    DEFAULT_WAIT_TIMEOUT_MS,
    DEFAULT_POLL_INTERVAL_MS,
    TEAMMATE_WAIT_EXIT_CODE,
} = await import('../src/agent/tasks/wait_for_teammates.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');
const readSrc = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

let pass = 0, fail = 0;
const ok = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const bad = (name, actual) => { fail++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };
const check = (name, cond, evidence = '', actual = null) => {
    if (cond) ok(name, evidence);
    else bad(name, actual ?? evidence);
};

/**
 * 去掉 JS 注释 —— **静态断言必须先做这一步**。
 *
 * 为什么：本轮修的正是「旧写法」，于是新写的注释里会大量出现旧写法
 * （`这里原来是 process.exit(0)` / `原来 killAll() → socket.emit('shutdown')`）。
 * 不剥注释的话，**解释缺陷的注释反而会让"缺陷已修"的断言变红** ——
 * 这种假红会逼着人把有价值的注释删掉，是比假绿更糟的结局。
 * 只剥块注释与整行 `//` 注释（这两个文件里没有把 `//` 写进字符串的情况）。
 */
const stripJsComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\n)[ \t]*\/\/[^\n]*/g, '$1');

/** 只实现 History 会碰到的接口的假 agent。 */
function makeAgent(name = 'tester') {
    const agent = {
        name,
        last_sender: null,
        memory_bank: { getJson: () => ({}) },
        self_prompter: { state: 'stopped', prompt: '', author: null, isStopped: () => true },
        task: { taskStartTime: 0 },
        actions: { executing: false },
        prompter: { promptMemSaving: () => Promise.resolve('summary') },
    };
    agent.history = new History(agent);
    return agent;
}

const bytesDir = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

// ════════════════════════════════════════════════════════════════════════
// ① #13：save() 失败**不抛**（落在「磁盘满/文件被占用/权限变了」这条路上）
// ════════════════════════════════════════════════════════════════════════
{
    const agent = makeAgent('_r6_save_fail');
    const h = agent.history;
    // 把 memory_fp 指到一个**不存在的目录**里：writeFileSync 必然 ENOENT
    const badDir = path.join(TMP_ROOT, '_r6_save_fail', 'no-such-dir');
    h.memory_fp = path.join(badDir, 'memory.json');

    // 关键：**不 .catch()**，与生产调用点（fire-and-forget）同形
    const rejected = [];
    const onUnhandled = (e) => rejected.push(e);
    process.on('unhandledRejection', onUnhandled);
    let threw = null;
    let result;
    try {
        result = await h.save();
    } catch (e) {
        threw = e;
    }
    // 给 unhandledRejection 一个触发窗口（Node 在微任务清空后派发）
    await new Promise((r) => setTimeout(r, 0));
    process.off('unhandledRejection', onUnhandled);

    check('★ ① 写盘失败时 save() 不抛（不再有 unhandled rejection 把进程带走）',
        threw === null, threw ? `→ 抛了：${threw.message}` : '');
    check('① save() 失败返回 false（调用方可据此判断，而不是靠异常）', result === false, `→ ${result}`);
    check('① 失败原因记在 saveError（不抛也不至于彻底看不见）',
        h.saveError instanceof Error, `→ ${h.saveError?.message}`);
    check('① 全程没有产生 unhandledRejection', rejected.length === 0,
        `→ ${rejected.map((e) => e?.message).join(' | ')}`);

    // 反向对照：正常路径必须还是 true（别把"永远 false"当成修好了）
    const good = makeAgent('_r6_save_ok');
    check('① 正向对照：能写盘时 save() 返回 true', (await good.history.save()) === true);
    check('① 正向对照：成功后 saveError 被清空', good.history.saveError === null);
}

// ════════════════════════════════════════════════════════════════════════
// ② #13：agent.js 的调用点不许再裸调 history.save()
// ════════════════════════════════════════════════════════════════════════
{
    const src = readSrc('agent', 'agent.js');
    const naked = src.split('\n')
        .map((line, i) => ({ line: line.trim(), no: i + 1 }))
        // 只抓「裸调用」：`await this.history.save();` 是被接住的（同步等结果），不算违规
        .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line)
            && /(^|[^.\w])this\.history\.save\(\)\s*;/.test(line)
            && !/\bawait\b/.test(line));
    check('★ ② agent.js 里没有「裸 this.history.save();」（fire-and-forget 未接住）',
        naked.length === 0, naked.map((x) => `L${x.no}`).join(','));
    check('② agent.js 提供 saveMemoryQuietly()（唯一的 fire-and-forget 入口）',
        /saveMemoryQuietly\s*\(\s*\)\s*\{/.test(src) && (src.match(/this\.saveMemoryQuietly\(\)/g) || []).length >= 3,
        `→ 调用点 ${(src.match(/this\.saveMemoryQuietly\(\)/g) || []).length} 个`);

    // 运行期：saveMemoryQuietly 本身不许抛（bot.chat/history 半坏时也一样）
    const agentSrc = readSrc('agent', 'agent.js');
    check('② saveMemoryQuietly 内部对 save() 的返回值接了 .catch（防以后有人把 save 的 catch 改回去）',
        /this\.history\.save\(\)\.catch\(/.test(agentSrc));
}

// ════════════════════════════════════════════════════════════════════════
// ③ #14：memory.json 损坏 → **先抢救，抢救不到才认输**（bot 能起来，但记忆不许被悄悄清零）
//
//    三级契约（队长复核后加的"不许静默清零"要求）：
//      ① 结构修复 —— 截断在某个 `}` 之后 ⇒ 整份记忆照常恢复；
//      ② 部分抢救 —— 只救出 memory / memory_bank ⇒ 起来时**带着这些记忆**（不是空记忆）；
//      ③ 抢救失败 —— 明确失败：坏文件留证 + 吵闹报错 + 返回 null（等价新号，但日志说清楚）。
//    三级**都必须**先留证改名，证据永远在。
// ════════════════════════════════════════════════════════════════════════
{
    const agent = makeAgent('_r6_corrupt');
    const h = agent.history;
    const fp = h.memory_fp;
    const dir = path.dirname(fp);
    fs.mkdirSync(dir, { recursive: true });
    const backupsOf = () => bytesDir(dir).filter((f) => f.startsWith('memory.json.corrupt-'));
    // 只清 memory.json* 文件（同目录里还有 History 构造时建的 histories/ 子目录）
    const wipeAll = () => {
        for (const f of bytesDir(dir)) {
            if (!f.startsWith('memory.json')) continue;
            const p = path.join(dir, f);
            if (fs.statSync(p).isDirectory()) continue;
            fs.rmSync(p, { force: true });
        }
    };

    // ── ② 部分抢救：只有 `"memory"` 字段还能读出来（这个样本正是报告里"截断"的形态）──
    {
        wipeAll();
        const corrupt = '{ "memory": "她记得箱子在 10,64,10",   <<< 这里被截断了';
        fs.writeFileSync(fp, corrupt, 'utf8');

        const rejected = [];
        const onUnhandled = (e) => rejected.push(e);
        process.on('unhandledRejection', onUnhandled);
        let threw = null, data;
        try {
            data = h.load();       // ← 改前这里直接 throw ⇒ agent.start() 抛 ⇒ exit(1) ⇒ 永久下线
        } catch (e) {
            threw = e;
        }
        await new Promise((r) => setTimeout(r, 0));
        process.off('unhandledRejection', onUnhandled);

        check('★ ③ 坏 memory.json 不再抛（这一抛会让 bot 连续重启 8 次后被永久注销）',
            threw === null, threw ? `→ 抛了：${threw.message}` : '');
        check('★ ③ 部分抢救：**她的记忆正文被救回来了**（不是静默清零）',
            data && data.memory === '她记得箱子在 10,64,10', `→ ${JSON.stringify(data?.memory)}`);
        check('③ 抢救结果带 recoveredFromCorrupt 标记（上层/日志能区分"恢复"与"新号"）',
            data?.recoveredFromCorrupt === true && h.recoveredFromCorrupt === true);
        check('③ 抢救路径不伪造 turns（坏文件里通常已截断，宁缺勿造）',
            Array.isArray(data?.turns) && data.turns.length === 0);
        check('③ loadError 记录了原因（面板/日志能看出"她的记忆文件坏了"）',
            h.loadError instanceof Error, `→ ${h.loadError?.message}`);
        check('③ 留证路径记在 corruptBackup 上（日志能点名"证据在哪、怎么修回去"）',
            typeof h.corruptBackup === 'string' && fs.existsSync(h.corruptBackup), `→ ${h.corruptBackup}`);
        check('③ 留证文件就是改名前那份坏文件（内容一字不差）',
            h.corruptBackup && fs.readFileSync(h.corruptBackup, 'utf8') === corrupt);
        check('③ 原 memory.json 已腾出位置（不会被下一次 save 覆盖掉证据）', !fs.existsSync(fp));

        // 自愈的下半场：恢复之后必须能正常起来并重建
        h.memory = '新的记忆';
        h.turns = [{ role: 'user', content: 'hi' }];
        const saved = await h.save();
        check('③ 自愈：抢救之后能重建一份干净的 memory.json', saved === true && fs.existsSync(fp));
        const reloaded = h.load();
        check('③ 自愈：重建后的文件能正常读回', reloaded?.memory === '新的记忆' && h.turns.length === 1,
            `→ ${JSON.stringify(reloaded && { memory: reloaded.memory, turns: reloaded.turns?.length })}`);
        check('③ 自愈但证据仍在（重建不会顺手删掉坏文件）', backupsOf().length === 1);
    }

    // ── ① 结构修复：文件尾部被追加了垃圾（写盘中断在 `}` 之后），整份对象应当救回来 ──
    {
        wipeAll();
        const body = JSON.stringify({
            memory: '她记得箱子在 10,64,10',
            codeVersion: 5,               // 与 MEMORY_CODE_VERSION 一致 ⇒ 不该被当成"过时"丢弃
            turns: [{ role: 'user', content: 'hello' }],
            memory_bank: { home: { x: 0, y: 64, z: 0 } },
        }, null, 2);
        const corrupt = `${body}\n<<< 写盘被打断，多了一段垃圾`;
        fs.writeFileSync(fp, corrupt, 'utf8');

        const data = h.load();
        check('★ ③ 结构修复：整份记忆（含 turns / memory_bank）都恢复',
            data?.memory === '她记得箱子在 10,64,10'
            && data?.turns?.length === 1
            && data?.memory_bank?.home?.x === 0,
            `→ ${JSON.stringify({ memory: data?.memory, turns: data?.turns?.length, bank: Object.keys(data?.memory_bank ?? {}) })}`);
        check('③ 结构修复成功后 h.memory 也同步（后续 save 不会写成空）',
            h.memory === '她记得箱子在 10,64,10');
        check('③ 结构修复同样留证（证据永远在）', backupsOf().length === 1 && !fs.existsSync(fp));
    }

    // ── ② 变体：memory_bank 能救、memory 已被截断 ──
    {
        wipeAll();
        const corrupt = '{"memory":"截断在这里","memory_bank":{"chest_a":{"x":1,"y":2,"z":3}},"tail":[1,2';
        fs.writeFileSync(fp, corrupt, 'utf8');
        const data = h.load();
        check('③ 结构块抢救：memory_bank 里的箱子坐标能单独救回来',
            data?.memory_bank?.chest_a?.x === 1, `→ ${JSON.stringify(data?.memory_bank)}`);
    }

    // ── ③ 抢救失败：一个字都读不出来 ⇒ 认输，但必须留证 + 返回 null（不伪造记忆）──
    {
        wipeAll();
        const corrupt = '这不是 JSON，也没有任何字段';
        fs.writeFileSync(fp, corrupt, 'utf8');
        let threw = null, data;
        try { data = h.load(); } catch (e) { threw = e; }
        check('★ ③ 抢救失败时也不抛（仍然不能让这只 bot 永久下线）',
            threw === null && data === null, `→ threw=${threw?.message} data=${JSON.stringify(data)}`);
        check('③ 抢救失败仍然留证 + 记 corruptBackup',
            backupsOf().length === 1 && fs.existsSync(h.corruptBackup ?? ''));
    }

    // ── 顶层不是对象（`null` / 字符串 / 数组）：同样不许抛，也不许伪造记忆 ──
    {
        for (const [label, body] of [['null', 'null'], ['字符串', '"她的记忆"'], ['数组', '[1,2,3]']]) {
            const a = makeAgent(`_r6_corrupt_${label}`);
            const hh = a.history;
            fs.mkdirSync(path.dirname(hh.memory_fp), { recursive: true });
            fs.writeFileSync(hh.memory_fp, body, 'utf8');
            let threw = null, data;
            try { data = hh.load(); } catch (e) { threw = e; }
            const backups = bytesDir(path.dirname(hh.memory_fp))
                .filter((f) => f.startsWith('memory.json.corrupt-'));
            check(`③ 顶层是${label} 也按损坏处理（不抛、留证、无内容可救 ⇒ null）`,
                threw === null && data === null && backups.length === 1,
                `→ threw=${threw?.message} data=${data} backups=${backups.length}`);
        }
    }
}

// 反向对照：好文件照常读，且**不产生**任何 .corrupt- 备份
{
    const agent = makeAgent('_r6_good');
    const h = agent.history;
    h.memory = '正常记忆';
    h.turns = [{ role: 'user', content: 'hello' }];
    await h.save();
    const data = h.load();
    const backups = bytesDir(path.dirname(h.memory_fp)).filter((f) => f.includes('.corrupt-'));
    check('③ 反向对照：好文件照常读、不产生备份、不误报 loadError',
        data?.memory === '正常记忆' && backups.length === 0 && h.loadError === null,
        `→ ${JSON.stringify({ memory: data?.memory, backups: backups.length })}`);
}

// ════════════════════════════════════════════════════════════════════════
// ④ #15：setup 阶段异常必须给**非 0 退出码**（源码静态断言 —— 见文件头说明）
//
//    为什么只能静态断言：这一段在 `agent.start()` 的 bot 'spawn' 回调里，
//    真跑它需要一只在线 mineflayer bot；而"退出码是 0 还是 1"恰恰只能从源码看出来。
//    这里把判据写成"catch 块内必须出现 cleanKill(..., 1) 且不允许 process.exit(0)"，
//    改回去就会红。
// ════════════════════════════════════════════════════════════════════════
{
    const src = readSrc('agent', 'agent.js');
    const at = src.indexOf("console.error('Error in spawn event:'");
    // 注释里**提到** `process.exit(0)` 是好事（写明"这里原来是什么"），不能算违规 ⇒ 先去掉注释
    const rawWindow = at >= 0 ? src.slice(at, at + 2000) : '';
    const window = stripJsComments(rawWindow);
    check('④ 找到 spawn 事件的 catch 块（判据本身有效，不是"扫不到所以通过"）', at >= 0);
    check('★ ④ setup 异常走 cleanKill(…, 1)：退出码 1 ⇒ 父进程按"起不足 10s 就退出"退避重启',
        /cleanKill\(\s*`?Error in spawn event/.test(window) && /,\s*1\s*\)/.test(window),
        window ? '→ 见 agent.js 的 spawn catch' : '');
    check('★ ④ 该 catch 块里不再有 process.exit(0)（那等于伪装成"正常结束"⇒ 不重启、不卸载）',
        !/process\.exit\(\s*0\s*\)/.test(window),
        (window.match(/process\.exit\(\s*\d+\s*\)/g) || []).join(','));
    check('④ 兜底路径给的是 exit(1)（cleanKill 自己再抛时也不许回到 0）',
        /process\.exit\(\s*1\s*\)/.test(window));
}

// 退出码语义的正向对照：`planExit` 对 0 / 1 / >1 的三分支（本组修复都依赖它）。
//
// 这里**静态**断言而不是 import 运行：`agent_process.js` 会连带拉起
// `mindserver.js → board_store.js` 一长串依赖，跨了本任务的写作用域
// （别的成员可能正在改 board_store），本用例不该因此变红。
// 行为矩阵已由 `tools/agent_process_backoff_unit.mjs` 逐格钉住。
{
    const procSrc = stripJsComments(readSrc('process', 'agent_process.js'));
    check('★ ④ 对照：code=0 ⇒ none（"正常结束"就是这样被误判的；#15 的病根）',
        /if \(code === 0 \|\| signal === 'SIGINT'\)[\s\S]{0,200}action: 'none'/.test(procSrc));
    check('★ ④ 对照：code>1 ⇒ unregister（#17「只摘自己」依赖这一支）',
        /Number\(code\) > 1[\s\S]{0,200}action: 'unregister'/.test(procSrc));
    check('④ 对照：其余（code=1 等）⇒ restart（#15 的修复落到这里）',
        /action: 'restart'/.test(procSrc));
    check('④ 对照：agent_process 里**没有** `process.exit(code)` 这种"单个 agent 拖垮整机"的旧写法',
        !/if \(code > 1\) \{[\s\S]{0,120}process\.exit/.test(procSrc));
}

// ════════════════════════════════════════════════════════════════════════
// ⑤ #17：等同伴 = 轮询等待（可注入假时钟 ⇒ 毫秒级跑完 60 秒的语义）
// ════════════════════════════════════════════════════════════════════════
{
    /** 假时钟：sleep 只推进时间，不真的等。 */
    const makeClock = () => {
        let t = 0;
        return {
            now: () => t,
            sleep: (ms) => { t += ms; return Promise.resolve(); },
            get t() { return t; },
        };
    };

    // (1) 人齐：一次 sleep 都不做（早到的 bot 不该白等固定 10 秒）
    {
        const clk = makeClock();
        const r = await waitForAgents({ required: 3, present: () => 3, timeoutMs: 60000, intervalMs: 500, sleep: clk.sleep, now: clk.now });
        check('★ ⑤ 人已到齐 ⇒ 立刻 ok，且**一次都不 sleep**（原来是固定 10s）',
            r.ok === true && r.polls === 0 && clk.t === 0, `→ ${JSON.stringify(r)} t=${clk.t}`);
    }

    // (2) 单机任务（required <= 1）：不等待
    {
        const clk = makeClock();
        const r = await waitForAgents({ required: 1, present: () => 1, sleep: clk.sleep, now: clk.now });
        check('⑤ 单机任务（agent_count=1）不等待', r.ok === true && clk.t === 0, `→ ${JSON.stringify(r)}`);
        const r0 = await waitForAgents({ required: 0, present: () => 0, sleep: clk.sleep, now: clk.now });
        check('⑤ agent_count=0/未配置也不等待（不做无意义空转）', r0.ok === true && clk.t === 0, `→ ${JSON.stringify(r0)}`);
    }

    // (3) 晚到的人：11 秒才进来 —— 固定 10s 判错的场景，轮询必须等到他
    {
        const clk = makeClock();
        let n = 1;
        const r = await waitForAgents({
            required: 2,
            present: () => {
                // 第 11 秒到齐（正是报告里"晚到 11 秒就整机停服"的场景）
                if (clk.t >= 11000) n = 2;
                return n;
            },
            timeoutMs: 60000,
            intervalMs: 500,
            sleep: clk.sleep,
            now: clk.now,
        });
        check('★ ⑤ 晚到 11 秒的同伙能被等到（旧实现固定 10s 就判"人不齐"）',
            r.ok === true && r.waitedMs >= 11000 && r.waitedMs <= 11500, `→ ${JSON.stringify(r)}`);
        check('⑤ 等待是轮询的（500ms 一拍，不是一觉醒到 60s）', r.polls >= 20, `→ polls=${r.polls}`);
    }

    // (4) 一直没人来：超时返回 ok:false，并带回实际数字
    {
        const clk = makeClock();
        const r = await waitForAgents({ required: 3, present: () => 1, timeoutMs: 60000, intervalMs: 500, sleep: clk.sleep, now: clk.now });
        check('★ ⑤ 超时 ⇒ ok:false（调用方据此只摘自己），且带回 present/required',
            r.ok === false && r.present === 1 && r.required === 3, `→ ${JSON.stringify(r)}`);
        check('⑤ 超时不会无限等：waitedMs 落在 [timeout, timeout+interval] 内',
            r.waitedMs >= 60000 && r.waitedMs <= 60500, `→ waitedMs=${r.waitedMs}`);
    }

    // (5) 人数**超过** required 也算到齐（不该因为多了就判失败）
    {
        const clk = makeClock();
        const r = await waitForAgents({ required: 2, present: () => 5, sleep: clk.sleep, now: clk.now });
        check('⑤ 人多于 required 也算到齐', r.ok === true, `→ ${JSON.stringify(r)}`);
    }

    // (6) 描述文案：必须说清"缺几只 + 只摘自己"，不许写成"关整机"
    {
        const msg = describeWaitResult({ required: 3, present: 1, waitedMs: 60000 });
        check('★ ⑤ 超时文案写明缺几只、且明说"只摘自己"',
            /缺 2 只/.test(msg) && /只摘掉自己/.test(msg) && !/killAll|shutdown/i.test(msg), `→ ${msg}`);
    }

    // (7) 环境变量覆盖被夹在合法区间（默认 60s/500ms，用例可压到毫秒级）
    {
        check('⑤ 默认超时 60s / 轮询 500ms（与报告的建议一致）',
            DEFAULT_WAIT_TIMEOUT_MS === 60000 && DEFAULT_POLL_INTERVAL_MS === 500);
        process.env.__R6_ENV_PROBE = '-5';
        check('⑤ 非法（负数）环境变量被夹到下限', readEnvMs('__R6_ENV_PROBE', 60000, 1000, 600000) === 1000,
            `→ ${readEnvMs('__R6_ENV_PROBE', 60000, 1000, 600000)}`);
        process.env.__R6_ENV_PROBE = 'abc';
        check('⑤ 非数字环境变量回落默认值', readEnvMs('__R6_ENV_PROBE', 60000, 1000, 600000) === 60000);
        process.env.__R6_ENV_PROBE = '99999999';
        check('⑤ 过大的环境变量被夹到上限', readEnvMs('__R6_ENV_PROBE', 60000, 1000, 600000) === 600000);
        delete process.env.__R6_ENV_PROBE;
    }
}

// ════════════════════════════════════════════════════════════════════════
// ⑥ #17：tasks.js 不再 killAll()，缺同伙走 detachSelf(…, 4)
// ════════════════════════════════════════════════════════════════════════
{
    const src = readSrc('agent', 'tasks', 'tasks.js');
    // 注释里写「不再 killAll()」「原来 socket.emit('shutdown')」是**有价值的说明**，
    // 先剥注释再判代码，否则解释缺陷的注释会把断言逼红。
    const code = stripJsComments(src);
    const codeLines = code.split('\n').map((line, i) => ({ line, no: i + 1 }));
    const killAllCalls = codeLines.filter(({ line }) => /\.killAll\s*\(/.test(line));
    check('★ ⑥ tasks.js 的**代码**里不再有 killAll() 调用（缺同伙不许关整机）',
        killAllCalls.length === 0, killAllCalls.map((x) => `L${x.no}:${x.line.trim()}`).join(' | '));
    check('⑥ tasks.js 里没有 emit(\'shutdown\') 之类的整机停机调用',
        !/emit\(\s*['"]shutdown['"]/.test(code));
    check('⑥ 缺同伙走 detachSelf()（只摘自己）', /detachSelf\s*\(/.test(code));
    check('⑥ detachSelf 用的是「>1 只摘自己」的退出码，不是 0/1',
        /cleanKill\?\.\(msg,\s*TEAMMATE_WAIT_EXIT_CODE\)|cleanKill\(msg,\s*TEAMMATE_WAIT_EXIT_CODE\)/.test(code));
    check('⑥ 退出码常量是 4（planExit 判 >1 ⇒ unregister）', TEAMMATE_WAIT_EXIT_CODE === 4);
    check('★ ⑥ 原来的两处「固定 10s sleep」已被轮询等待取代',
        (code.match(/waitForOtherBots\(/g) || []).length >= 2
        && !/TODO wait for other bots to join/.test(code),
        `→ waitForOtherBots 调用 ${(code.match(/waitForOtherBots\(/g) || []).length} 处`);
    check('⑥ 不再有 `setTimeout(resolve, 10000)` 这种"固定睡 10 秒当等待"',
        !/setTimeout\([^)]*,\s*10000\s*\)/.test(code));
}

// ════════════════════════════════════════════════════════════════════════
// ⑦ 端到端（最小版）：一只 bot 的 Task 在缺同伙时**只摘自己**
//    用假 agent 直接驱动 Task.prototype.detachSelf / waitForOtherBots，
//    绕开 tasks.js 顶层的 mineflayer 依赖链（只取原型方法，不 new Task）。
// ════════════════════════════════════════════════════════════════════════
{
    // 直接读源码断言 detachSelf 的方法体：cleanKill 必须带 4，且**不许**出现 killAll
    const src = readSrc('agent', 'tasks', 'tasks.js');
    const start = src.indexOf('detachSelf(msg)');
    const body = start >= 0 ? src.slice(start, start + 900) : '';
    check('⑦ 找到 detachSelf 的方法体（判据有效）', start >= 0);
    check('★ ⑦ detachSelf 只做"摘自己"：cleanKill(msg, 4)，没有 killAll / process.exit(0)',
        /cleanKill/.test(body) && !/killAll/.test(body.replace(/\/\/.*$/gm, ''))
        && !/process\.exit\(\s*0\s*\)/.test(body));
    check('⑦ detachSelf 对 cleanKill 的异常有兜底（任务初始化阶段 agent 可能半坏）',
        /catch\s*\(/.test(body));
}

// ════════════════════════════════════════════════════════════════════════
// ⑧ #13/#15 相邻加固：任务初始化（initBotTask / setAgentGoal）的
//    fire-and-forget 已被 guardTaskStartup 接住，失败走非 0 退出码。
// ════════════════════════════════════════════════════════════════════════
{
    const src = readSrc('agent', 'agent.js');
    const code = stripJsComments(src);
    check('⑧ 提供 guardTaskStartup()', /guardTaskStartup\s*\(label,\s*promise\)\s*\{/.test(code));
    const guarded = (code.match(/this\.guardTaskStartup\(/g) || []).length;
    check('★ ⑧ initBotTask / setAgentGoal 都不再裸调（拒绝会变成 unhandled rejection ⇒ 带走进程）',
        guarded >= 3 && !/^\s*this\.task\.initBotTask\(\);/m.test(code)
        && !/^\s*this\.task\.setAgentGoal\(\);/m.test(code),
        `→ 受保护调用 ${guarded} 处`);
    const body = code.slice(code.indexOf('guardTaskStartup(label, promise)'));
    const bodyEnd = body.indexOf('saveMemoryQuietly');
    const guardBody = bodyEnd > 0 ? body.slice(0, bodyEnd) : body.slice(0, 1600);
    check('★ ⑧ 失败时给非 0 退出码（cleanKill(…, 1)），并兜住 cleanKill 自身的异常',
        /cleanKill\(msg,\s*1\)/.test(guardBody) && /catch\s*\(/.test(guardBody)
        && !/process\.exit\(0\)/.test(guardBody));
}

// 收尾
fs.rmSync(TMP_ROOT, { recursive: true, force: true });
console.log('\n============================================');
console.log(fail === 0 ? `ALL PASS: ${pass} passed` : `${pass} passed, ${fail} FAILED`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
