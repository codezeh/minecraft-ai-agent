/**
 * `History.load()`：**真损坏的 memory.json 必须能捞回、且必须留证**（R6 #14）—— 离线单测。
 *
 * 为什么单独立一条：`memory.json` 存的是这只 bot 的**人物记忆**（长期经验结论 + `!rememberHere`
 * 记下的地点/箱子）。坏掉之后如果走"当没存过" → 下次 save 用空记忆整份覆盖，
 * 用户攒了几个月的记忆就没了，而面板上看不出任何异常（比"起不来"更难发现）。
 *
 * 这里用**真文件**（不是 mock fs）喂四种真实坏法，验证 `load()` 的三层降级：
 *   ① 写盘中断（尾部截断在某个 `}` 之后）→ 结构修复，整份对象回来
 *   ② 尾部被手改坏、前段仍完整       → 部分抢救（memory / memory_bank）
 *   ③ 完全不是 JSON（如整份乱码）     → 抢救失败，但**坏文件必须留证**且日志点名路径
 *   ④ 顶层是数组 / 字符串（合法 JSON 但不是对象）→ 与解析失败同等处理
 *
 * 共同硬要求：**无论抢救成败，坏文件都要改名成 `<path>.corrupt-<ts>`**，
 * 且 `corruptBackup` 字段指向它 —— 证据永远在，人工修好后能改名回去。
 *
 * 输出：PASS / FAIL，全过退出码 0。
 * 隔离：`MC_BOTS_ROOT` 指到临时目录（本仓唯一覆盖点），跑完整体删除，不碰真实记忆。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';

let pass = 0, fail = 0;
const ok = (name, evidence = '') => { pass++; console.log(`PASS ${name} ${evidence}`); };
const bad = (name, actual) => { fail++; console.log(`FAIL ${name} ${JSON.stringify(actual)}`); };

// 必须在 import history 之前设置：history 的构造函数里就会用 botsRootOf()
process.env.MC_BOTS_ROOT = mkdtempSync(join(os.tmpdir(), 'hist-corrupt-'));
const BOTS_ROOT = process.env.MC_BOTS_ROOT;

const { History } = await import('../src/agent/history.js');

// 版本戳常量没导出：从源码解析，避免写字面量 5（写死的话，代码升版本这里就会假红/假绿，
// 与 fix-team 提醒的"别把 BOARD_SCHEMA_VERSION 硬编码"是同一类问题）。
const historySrc = readFileSync(resolve(import.meta.dirname, '../src/agent/history.js'), 'utf8');
const vMatch = historySrc.match(/const MEMORY_CODE_VERSION\s*=\s*(\d+)/);
const MEMORY_VERSION = vMatch ? Number(vMatch[1]) : null;
if (MEMORY_VERSION === null) {
    console.log('FAIL 无法从 history.js 解析 MEMORY_CODE_VERSION（常量改名了就要同步更新本测试）');
    process.exit(1);
}

const BOT = 'hxm_probe';
const DIR = resolve(BOTS_ROOT, BOT);
const FP = join(DIR, 'memory.json');

/** 造一个 History 实例（只依赖 agent.name；构造函数会 mkdir histories/） */
function makeHistory() {
    mkdirSync(DIR, { recursive: true });
    return new History({ name: BOT });
}

function writeMemory(text) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(FP, text, 'utf8');
}

/** 目录里留证文件的数量（`memory.json.corrupt-<ts>`） */
function backups() {
    if (!existsSync(DIR)) return [];
    return readdirSync(DIR).filter((f) => f.startsWith('memory.json.corrupt-'));
}

/** 每次用例前清干净：memory.json 与所有留证文件都删掉，避免互相污染 */
function reset() {
    if (!existsSync(DIR)) return;
    for (const f of readdirSync(DIR)) {
        if (f === 'memory.json' || f.startsWith('memory.json.corrupt-')) {
            rmSync(join(DIR, f), { force: true });
        }
    }
}

try {
    // ── ① 写盘中断：尾部截断在某个 } 之后 ────────────────────────────────
    {
        reset();
        const good = {
            memory: '她学会了先造木镐再挖石头。',
            memory_bank: { home: { x: 12, y: 64, z: -3 }, chests: [{ x: 5, y: 63, z: 8 }] },
            turns: [{ role: 'user', content: 'hi' }],
            version: 5,
        };
        const full = JSON.stringify(good, null, 2);
        // 截掉最后一段（模拟写到一半断电）：保留到倒数第二个 } 之后
        const cut = full.lastIndexOf('}', full.lastIndexOf('}') - 1);
        writeMemory(full.slice(0, cut + 1));

        const h = makeHistory();
        const data = h.load();

        if (data && data.memory === good.memory) ok('① 尾部截断 → 结构修复，记忆摘要完整回来');
        else bad('① 尾部截断 → 结构修复', data);
        if (data && data.memory_bank && data.memory_bank.home && data.memory_bank.home.x === 12) {
            ok('① 地点/箱子也回来了', JSON.stringify(data.memory_bank.home));
        } else bad('① 地点/箱子也回来了', data?.memory_bank);
        if (h.recoveredFromCorrupt === true) ok('① 标记 recoveredFromCorrupt');
        else bad('① 标记 recoveredFromCorrupt', h.recoveredFromCorrupt);
        if (h.corruptBackup && existsSync(h.corruptBackup)) ok('① 坏文件已留证', h.corruptBackup);
        else bad('① 坏文件已留证', h.corruptBackup);
    }

    // ── ② 尾部被手改坏、前段完整：部分抢救 ───────────────────────────────
    {
        reset();
        const memoryText = '她记得箱子里有 3 个铁锭。';
        const bank = { chests: [{ x: 1, y: 2, z: 3 }] };
        // 前半段是一个合法对象，后面再接一段垃圾 → 从最后一个 } 截断解析不出来，
        // 只能靠 ②字段抢救 / ③结构块配平抢救。
        // 注意：部分抢救走的是"版本戳无法确认"分支，memory 文本可能被保留也可能为空，
        // 但 **memory_bank 必须回来**（地点/箱子是事实，与代码版本无关）。
        const raw = `{"memory":${JSON.stringify(memoryText)},"memory_bank":${JSON.stringify(bank)}} THIS IS NOT JSON {{{ ]]]`;
        writeMemory(raw);

        const h = makeHistory();
        const data = h.load();

        const gotBank = data && data.memory_bank && Array.isArray(data.memory_bank.chests)
            && data.memory_bank.chests[0]?.x === 1;
        if (gotBank) ok('② 前段完整 → 地点/箱子抢救回来', JSON.stringify(data.memory_bank));
        else bad('② 前段完整 → 地点/箱子抢救回来', data);
        if (h.recoveredFromCorrupt === true) ok('② 标记 recoveredFromCorrupt（面板能看出"记忆来自抢救"）');
        else bad('② 标记 recoveredFromCorrupt', h.recoveredFromCorrupt);
        if (h.corruptBackup && existsSync(h.corruptBackup)) ok('② 坏文件已留证', h.corruptBackup);
        else bad('② 坏文件已留证', h.corruptBackup);
    }

    // ── ③ 完全不是 JSON：抢救失败，但必须留证 + 不能抛 ────────────────────
    {
        reset();
        writeMemory('%%% 这不是 JSON，只是一堆乱码 %%%');

        const h = makeHistory();
        let threw = null;
        let data = undefined;
        try { data = h.load(); } catch (e) { threw = e; }

        if (!threw) ok('③ 抢救失败也不抛异常（按没有记忆继续启动）');
        else bad('③ 抢救失败也不抛异常', String(threw));
        if (data === null) ok('③ 返回 null（等价新号），由下次 save 重建');
        else bad('③ 返回 null', data);
        if (h.corruptBackup && existsSync(h.corruptBackup)) {
            ok('③ 坏文件已留证（关键：不能被下次 save 覆盖）', h.corruptBackup);
            // 留证内容必须就是原坏文本 —— 否则"证据"是假的
            const kept = readFileSync(h.corruptBackup, 'utf8');
            if (kept === '%%% 这不是 JSON，只是一堆乱码 %%%') ok('③ 留证内容与原文件一致');
            else bad('③ 留证内容与原文件一致', kept.slice(0, 60));
        } else bad('③ 坏文件已留证', h.corruptBackup);
        if (h.loadError) ok('③ loadError 记录失败原因', String(h.loadError.message).slice(0, 40));
        else bad('③ loadError 记录失败原因', h.loadError);
    }

    // ── ④ 合法 JSON 但顶层不是对象 ────────────────────────────────────────
    for (const [label, text] of [['数组', '[1,2,3]'], ['字符串', '"just a string"'], ['null', 'null']]) {
        reset();
        writeMemory(text);
        const h = makeHistory();
        let data = undefined;
        let threw = null;
        try { data = h.load(); } catch (e) { threw = e; }
        const marked = h.loadError && h.loadError.code === 'MEMORY_CORRUPT';
        if (!threw && data === null && marked) ok(`④ 顶层是${label} → 按损坏处理并返回 null`);
        else bad(`④ 顶层是${label} → 按损坏处理并返回 null`, { threw: String(threw), data, code: h.loadError?.code });
        if (h.corruptBackup && existsSync(h.corruptBackup)) ok(`④ 顶层是${label} 也留证`);
        else bad(`④ 顶层是${label} 也留证`, h.corruptBackup);
    }

    // ── ⑤ 健康文件（版本戳匹配）不该被当成损坏，也不该丢记忆 ──────────────
    {
        reset();
        const good = {
            memory: '正常记忆',
            memory_bank: { home: { x: 1, y: 2, z: 3 } },
            turns: [],
            codeVersion: MEMORY_VERSION,
        };
        writeMemory(JSON.stringify(good, null, 2));
        const h = makeHistory();
        const data = h.load();
        if (data && data.memory === '正常记忆') ok('⑤ 健康文件正常读回，不触发抢救', `codeVersion=${MEMORY_VERSION}`);
        else bad('⑤ 健康文件正常读回', data);
        if (h.corruptBackup === null && backups().length === 0) ok('⑤ 健康文件不产生留证文件（没有假报警）');
        else bad('⑤ 健康文件不产生留证文件', backups());
        if (h.loadError === null) ok('⑤ 健康文件不记 loadError');
        else bad('⑤ 健康文件不记 loadError', String(h.loadError));
    }

    // ── ⑤b 版本戳不匹配：丢弃「经验结论」但**保留地点/箱子**（这是设计，不是 bug）──
    {
        reset();
        const old = {
            memory: '基于旧逻辑的结论：附近橡木多为建筑不可砍',
            memory_bank: { home: { x: 9, y: 64, z: 9 } },
            turns: [],
            codeVersion: MEMORY_VERSION - 1,
        };
        writeMemory(JSON.stringify(old, null, 2));
        const h = makeHistory();
        const data = h.load();
        if (data && data.memory === '') ok('⑤b 版本戳过期 → 丢弃旧经验结论');
        else bad('⑤b 版本戳过期 → 丢弃旧经验结论', data?.memory);
        if (data && data.memory_bank?.home?.x === 9) ok('⑤b 但地点/箱子保留（事实不受代码版本影响）');
        else bad('⑤b 但地点/箱子保留', data?.memory_bank);
        if (h.corruptBackup === null) ok('⑤b 版本过期不算文件损坏，不产生留证');
        else bad('⑤b 版本过期不该留证', h.corruptBackup);
    }

    // ── ⑥ 文件不存在：不该报损坏、也不该造留证 ────────────────────────────
    {
        reset();
        const h = makeHistory();
        const data = h.load();
        if (data === null && h.corruptBackup === null && !h.loadError) ok('⑥ 文件不存在 → 返回 null，不算损坏');
        else bad('⑥ 文件不存在 → 返回 null，不算损坏', { data, backup: h.corruptBackup, err: String(h.loadError) });
    }
}
finally {
    rmSync(BOTS_ROOT, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
