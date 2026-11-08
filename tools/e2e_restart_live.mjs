/**
 * E2E 场景「重启恢复」—— 两阶段真机脚本（由 scripts/e2e.ps1 在停/起服之间驱动）。
 *
 *   阶段 view：起服后 → 建场地（箱子 + 熔炉 + 材料）→ 写 bot 记忆 → save-all
 *   阶段 verify：**重启后** → 断言箱子内容、熔炉产物（进度）、bot 记忆都还在
 *
 * 为什么必须拆两段：断言的对象是"进程重启后磁盘上剩下的东西"。
 * 同进程里先写后读**证明不了**任何持久化（内存里也在），所以停服/起服必须由外层脚本做，
 * 本脚本两个阶段各自独立起进程、独立连 RCON。
 *
 * 用法：
 *     node tools/e2e_restart_live.mjs stage  --state <runDir>/restart-expect.json
 *     node tools/e2e_restart_live.mjs verify --state <runDir>/restart-expect.json
 *
 * 依赖：测试服已在 25566 跑起来（RCON 25576），凭据走 RCON_PORT/RCON_PASSWORD 环境变量。
 * 退出码：0 = 本阶段所有断言通过；1 = 有失败（逐条打印 PASS/FAIL）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { rcon } from './rcon.mjs';
import { History } from '../src/agent/history.js';

// ── 场地坐标：与 t37（6200,-60,8800）错开，便于两个场景的日志互相识别 ──
const BX = 6000, BY = -58, BZ = 8600;
const CHEST = { x: BX, y: BY, z: BZ };
const FURNACE = { x: BX + 2, y: BY, z: BZ };

const BOT = 'e2eRestart';
const MEMORY_MARKER = 'E2E-MEMORY-KEEP-' + (process.env.E2E_RUN_ID || 'reserved');

// 箱子里放的标记物：数量固定，重启后逐项比对
const CHEST_ITEMS = [
    { slot: 0, id: 'minecraft:diamond', count: 7 },
    { slot: 5, id: 'minecraft:oak_log', count: 33 },
    { slot: 12, id: 'minecraft:iron_ingot', count: 4 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const phase = argv[0];
const getArg = (name, dflt = null) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const statePath = getArg('--state');
if (!phase || !['stage', 'verify'].includes(phase)) {
    console.error('用法: node e2e_restart_live.mjs <stage|verify> --state <expect.json>');
    process.exit(2);
}
if (!statePath) {
    console.error('缺少 --state（两阶段约定的期望值文件）');
    process.exit(2);
}

const results = [];
const push = (name, pass, detail) => {
    results.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name} —— ${detail}`);
};

/** 造一个"够 save()/load() 用"的 agent 桩：历史/记忆的读写只依赖这些字段。 */
function makeStubAgent() {
    const memoryBank = {
        marker: 'e2e-memory-bank',
        chests: { e2e: { x: CHEST.x, y: CHEST.y, z: CHEST.z } },
    };
    return {
        name: BOT,
        self_prompter: { state: 'stopped', isStopped: () => true, prompt: null, author: null },
        task: { taskStartTime: 0 },
        memory_bank: { getJson: () => memoryBank },
        last_sender: null,
    };
}

/**
 * 连一个真 bot 去读容器。
 *
 * 为什么不用 `data get block`：聊天栏里 NBT 会被**截断**（实测 `Items: [{Slot: 0b...`），
 * 数量读不全；而且 1.21 的 SNBT 字段名/类型（Slot 是 byte、count 是 int）逐个版本都在动。
 * mineflayer 读的是服务端真实容器窗口，拿到的就是 agent 自己会看到的那份数据。
 */
async function withBot(fn) {
    const mineflayer = (await import('mineflayer')).default;
    const bot = mineflayer.createBot({
        host: '127.0.0.1',
        port: Number(process.env.MC_PORT || 25566),
        username: BOT + (Date.now() % 10000),
        auth: 'offline',
        version: '1.21.8',
    });
    bot.on('error', () => { });
    try {
        await new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('bot 30s 内没 spawn')), 30000);
            bot.once('spawn', () => { clearTimeout(t); res(); });
        });
        return await fn(bot);
    }
    finally {
        try { bot.quit(); } catch { /* 故意忽略：bot 可能已断开，quit 抛错不影响断言 */ }
    }
}

const itemKey = (it) => `${it?.name ?? '?'}|${it?.count ?? 0}`;

/** 从 RCON 输出里抠某个字段（`data get block` 的返回是纯文本，形如 ...Items: [...], CookTime: 100s） */
function pickNumber(text, key) {
    const m = String(text).match(new RegExp(`${key}\\s*:\\s*(-?\\d+)`));
    return m ? Number(m[1]) : null;
}

async function rc(cmd, { quiet = true } = {}) {
    const out = await rcon(cmd);
    if (!quiet) console.log(`  RCON> ${cmd}\n        ${String(out).trim().slice(0, 200)}`);
    return out;
}

// ────────────────────────────────────────────────────────────────
// 阶段 stage：建场地、塞材料、写记忆、落盘
// ────────────────────────────────────────────────────────────────
async function stage() {
    console.log('=== stage：建场地 + 塞材料 + 写 bot 记忆 ===');

    await rc(`forceload add ${BX - 16} ${BZ - 16} ${BX + 16} ${BZ + 16}`);
    await sleep(500);
    // 平台（flat 世界里 BY-1 以下已经是实心，这里只保证脚下可站）
    await rc(`fill ${BX - 8} ${BY - 1} ${BZ - 8} ${BX + 8} ${BY - 1} ${BZ + 8} stone`);
    await rc(`fill ${BX - 8} ${BY} ${BZ - 8} ${BX + 8} ${BY} ${BZ + 8} air`);

    await rc(`setblock ${CHEST.x} ${CHEST.y} ${CHEST.z} chest`);
    await rc(`setblock ${FURNACE.x} ${FURNACE.y} ${FURNACE.z} furnace`);
    await sleep(300);

    // 箱子：用 item replace 而不是 NBT —— 少一层版本方言风险
    for (const it of CHEST_ITEMS) {
        const r = await rc(`item replace block ${CHEST.x} ${CHEST.y} ${CHEST.z} container.${it.slot} with ${it.id} ${it.count}`);
        if (!String(r).toLowerCase().includes('replaced')) {
            push(`放置 ${it.id} 到箱子`, false, `RCON 返回：${String(r).slice(0, 120)}`);
        }
    }

    // 熔炉：1 个铁矿 + 8 个煤。熔炼 200 tick ≈ 10s，8 煤够烧很久 —— 重启后应能继续/已完成
    await rc(`item replace block ${FURNACE.x} ${FURNACE.y} ${FURNACE.z} container.0 with minecraft:iron_ore 1`);
    await rc(`item replace block ${FURNACE.x} ${FURNACE.y} ${FURNACE.z} container.1 with minecraft:coal 8`);
    await sleep(1500);

    // 写 bot 记忆：走**真实**的 History.save()，而不是自己拼 JSON，
    // 这样 verify 阶段用真实 History.load() 读回来才有意义。
    const history = new History(makeStubAgent());
    history.memory = MEMORY_MARKER + ' | 箱子在 ' + `${CHEST.x},${CHEST.y},${CHEST.z}`;
    await history.save();
    const memoryFp = history.memory_fp;
    if (!fs.existsSync(memoryFp)) {
        push('bot 记忆已落盘', false, `save() 之后找不到 ${memoryFp}`);
    } else {
        push('bot 记忆已落盘（真实 History.save()）', true, memoryFp);
    }

    // 停服前先用真 bot 确认"场地真的就位"—— 否则 verify 失败时分不清是
    // "没写进去"还是"没读回来"。
    try {
        const staged = await withBot(async (bot) => {
            await rc(`tp ${bot.username} ${CHEST.x + 1} ${CHEST.y} ${CHEST.z + 1}`);
            await sleep(1500);
            const block = bot.blockAt(new (await import('vec3')).Vec3(CHEST.x, CHEST.y, CHEST.z));
            const container = await bot.openContainer(block);
            try { return container.containerItems().map(itemKey).sort(); }
            finally { try { container.close(); } catch { /* 故意忽略：容器可能已被关掉，关闭失败不该盖住真实结果 */ } }
        });
        const wanted = CHEST_ITEMS.map((it) => `${it.id.replace('minecraft:', '')}|${it.count}`).sort();
        const same = staged.length === wanted.length && wanted.every((w, i) => w === staged[i]);
        push('停服前：箱子内容已就位（真 bot 复核）', same,
            same ? `${wanted.length} 种物品` : `期望 [${wanted.join(', ')}] 实际 [${staged.join(', ')}]`);
    } catch (e) {
        push('停服前：箱子内容已就位（真 bot 复核）', false, 'bot 读取失败: ' + String(e?.message ?? e).slice(0, 160));
    }

    const furnaceBefore = await rc(`data get block ${FURNACE.x} ${FURNACE.y} ${FURNACE.z}`);
    const cookBefore = pickNumber(furnaceBefore, 'CookTime');
    const totalBefore = pickNumber(furnaceBefore, 'CookTimeTotal');

    await rc('save-all flush');
    await sleep(1200);

    const expect = {
        scenario: 'restart',
        createdAt: new Date().toISOString(),
        chest: CHEST,
        furnace: FURNACE,
        chestItems: CHEST_ITEMS,
        memoryFp: path.resolve(memoryFp),
        memoryMarker: MEMORY_MARKER,
        cookBefore,
        totalBefore,
    };
    fs.writeFileSync(statePath, JSON.stringify(expect, null, 2));
    console.log(`已写入期望值：${statePath}`);
    return finish();
}

// ────────────────────────────────────────────────────────────────
// 阶段 verify：重启后断言
// ────────────────────────────────────────────────────────────────
async function verify() {
    console.log('=== verify：重启后断言箱子 / 熔炉 / bot 记忆 ===');
    if (!fs.existsSync(statePath)) {
        console.error(`找不到期望值文件 ${statePath}（stage 阶段没跑成？）`);
        process.exit(1);
    }
    const expect = JSON.parse(fs.readFileSync(statePath, 'utf8'));

    // 1) 箱子内容 —— 用真 bot 打开箱子读（`data get block` 的 Items 会被聊天栏截断）
    let chestOk = false, chestDetail = '';
    try {
        chestOk = await withBot(async (bot) => {
            const pos = bot.entity.position.offset(0, 0, 0);
            // 传送到箱子边上：容器窗口要求距离 < 4~5 格
            await rc(`tp ${bot.username} ${expect.chest.x + 1} ${expect.chest.y} ${expect.chest.z + 1}`);
            await sleep(1500);
            const block = bot.blockAt(new (await import('vec3')).Vec3(expect.chest.x, expect.chest.y, expect.chest.z));
            if (!block) { chestDetail = '读不到箱子方块（区块没加载？）'; return false; }
            const container = await bot.openContainer(block);
            try {
                const actual = container.containerItems().map(itemKey).sort();
                const wanted = expect.chestItems
                    .map((it) => `${it.id.replace('minecraft:', '')}|${it.count}`).sort();
                const same = actual.length === wanted.length && wanted.every((w, i) => w === actual[i]);
                chestDetail = same
                    ? `${wanted.length} 种物品逐项一致`
                    : `期望 [${wanted.join(', ')}] 实际 [${actual.join(', ') || '空'}]`;
                return same;
            }
            finally { try { container.close(); } catch { /* 故意忽略：容器可能已被关掉，关闭失败不该盖住真实结果 */ } }
        });
    } catch (e) {
        chestDetail = 'bot 读箱子失败: ' + String(e?.message ?? e).slice(0, 160);
    }
    push('箱子内容在重启后完好（真 bot 打开箱子逐项比对 id + 数量）', chestOk, chestDetail);

    // 2) 熔炉：用真 bot 打开熔炉读产物槽 / 燃料槽 / 进度
    let furnaceOk = false, furnaceDetail = '', progressOk = false, progressDetail = '';
    try {
        const fr = await withBot(async (bot) => {
            await rc(`tp ${bot.username} ${expect.furnace.x + 1} ${expect.furnace.y} ${expect.furnace.z - 1}`);
            await sleep(1500);
            const block = bot.blockAt(new (await import('vec3')).Vec3(expect.furnace.x, expect.furnace.y, expect.furnace.z));
            if (!block) return { err: '读不到熔炉方块（区块没加载？）' };
            const furnace = await bot.openFurnace(block);
            try {
                return {
                    input: itemKey(furnace.inputItem()),
                    fuel: itemKey(furnace.fuelItem()),
                    output: itemKey(furnace.outputItem()),
                    progress: furnace.progress,
                    fuelSeconds: furnace.fuelSeconds,
                };
            }
            finally { try { furnace.close(); } catch { /* 故意忽略：熔炉可能已被关掉，关闭失败不该盖住真实结果 */ } }
        });
        if (fr.err) { furnaceDetail = fr.err; }
        else {
            // 产物槽里有铁锭 = 熔炼确实跑过且结果跨重启还在
            furnaceOk = String(fr.output).startsWith('iron_ingot|') && !String(fr.output).endsWith('|0');
            furnaceDetail = `input=${fr.input} fuel=${fr.fuel} output=${fr.output} progress=${fr.progress}s fuelSeconds=${fr.fuelSeconds}s`;

            // 进度断言不能要求 progress 有数值：**烧完之后**熔炉是空闲的，
            // mineflayer 这时给的 progress 就是 null（实测）。真正要证明的是
            // "熔炉状态跨重启保留且确实在工作过"：
            //   · 煤从 8 变少（燃烧消耗过）
            //   · 产物槽出现了铁锭（熔炼完成）
            //   · 若 progress 有值，必须落在单件 0~10 秒的合理区间
            const fuelNow = Number(String(fr.fuel).split('|')[1] ?? 0);
            const fuelBurned = String(fr.fuel).startsWith('coal|') && fuelNow < 8;
            const progressInRange = fr.progress === null || fr.progress === undefined
                || (Number(fr.progress) >= 0 && Number(fr.progress) <= 10);
            progressOk = fuelBurned && furnaceOk && progressInRange;
            progressDetail = `煤 ${8}→${fuelNow}（燃烧过）、产物=${fr.output}、progress=${fr.progress}`;
        }
    } catch (e) {
        furnaceDetail = 'bot 读熔炉失败: ' + String(e?.message ?? e).slice(0, 160);
        progressDetail = furnaceDetail;
    }
    push('熔炉产物在重启后仍在（真 bot 读产物槽）', furnaceOk, furnaceDetail);
    push('熔炉确实工作过且状态跨重启保留（煤被消耗 + 产出铁锭 + 进度区间自洽）', progressOk, progressDetail);

    // 3) bot 记忆：用真实 History.load() 读回（含 codeVersion 版本闸）
    const history = new History(makeStubAgent());
    const loaded = history.load();
    const memoryOk = !!loaded && String(loaded.memory || history.memory || '').includes(expect.memoryMarker);
    push('bot 记忆在重启后可读回（真实 History.load()）', memoryOk,
        memoryOk ? `命中标记 ${expect.memoryMarker}` : `memory=${JSON.stringify(String((loaded && loaded.memory) || history.memory || '').slice(0, 160))}`);

    const bankOk = !!loaded && JSON.stringify(loaded.memory_bank || {}).includes('e2e-memory-bank');
    push('bot 记忆里的地点库（memory_bank）也还在', bankOk,
        bankOk ? 'memory_bank 命中' : `memory_bank=${JSON.stringify((loaded && loaded.memory_bank) || {}).slice(0, 160)}`);

    return finish();
}

function finish() {
    const ok = results.filter((r) => r.pass).length;
    console.log(`\n──────── ${ok}/${results.length} 条通过 ────────`);
    process.exit(ok === results.length && results.length > 0 ? 0 : 1);
}

(phase === 'stage' ? stage() : verify()).catch((e) => {
    console.error('场景执行异常: ' + String(e?.message ?? e).slice(0, 300));
    process.exit(1);
});
