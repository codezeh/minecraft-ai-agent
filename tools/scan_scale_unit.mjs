/**
 * 第13条回归：扫球的规模必须**被硬夹住**，不能由调用方随便放大。
 *
 * 背景（报告 v2.1 第13条，已实测）：
 *   `surveyArea` 默认 radius=64 → 一次 `scanSphere` 约 **110 万次 blockAt**
 *   + **12868 次 DELETE**，同步阻塞主线程好几秒（心跳一超时就断线）。
 *
 * 本测试不看"跑得快不快"（那受机器影响），只看**可数的调用次数**：
 * 用一个计数假 bot 包住 `bot.blockAt`，直接数 scanSphere 到底摸了几格。
 * 次数是确定性的（只取决于 r），所以断言能对**修复前的实现**变红。
 *
 * 反向验证（命令在交付文档里）：
 *   把 terrain3d.js 换回未夹紧的副本 → r=64 那一档的 blockAt 次数会爆到 10 万+，
 *   本测试必须 FAIL。
 *
 * 输出格式：PASS <用例> <证据> / FAIL <用例> <实际>，全过退出码 0。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Vec3 from 'vec3';
import mcDataLoader from 'minecraft-data';

// 只为「反向验证」用：把修复前的 terrain3d.js 副本指进来，r 上限用例必须变红。
const MODULE = process.env.TERRAIN3D_MODULE ?? '../src/agent/library/terrain3d.js';
const { scanSphere } = await import(MODULE);

let pass = 0, fail = 0;
const okCase = (n, e = '') => { pass++; console.log(`PASS ${n} ${e}`); };
const badCase = (n, actual) => { fail++; console.log(`FAIL ${n} ${actual}`); };

console.log(`被测 terrain3d 模块：${MODULE}`);

/** 计数假 bot：blockAt 只累加计数，永远返回"实心石头"（扫球只关心有没有面）。 */
function makeCountingBot() {
    const counter = { blockAt: 0 };
    const registry = mcDataLoader('1.21.8');
    const stone = () => ({
        name: 'stone',
        boundingBox: 'block',
        position: new Vec3(0, 0, 0),
        // terrain3d 的分类函数只需要 name/boundingBox；给足常见字段以防未来改动
        type: 1, metadata: 0, light: 15, skyLight: 15, biome: { id: 1 }, hardness: 1.5,
    });
    const bot = {
        username: 'unit_scan_scale',
        registry,
        entity: { position: new Vec3(0, 64, 0) },
        game: { dimension: 'overworld' },
        blockAt: () => { counter.blockAt++; return stone(); },
        blockAt2: () => null,
    };
    return { bot, counter };
}

/** 跑一次扫球，返回 {blockAt 次数, 返回的 cells/columns}。 */
function runScan(radius) {
    const dir = mkdtempSync(join(tmpdir(), 't21_scan_'));
    const { bot, counter } = makeCountingBot();
    let out = null, err = null;
    try {
        out = scanSphere(bot, dir, { x: 0, y: 64, z: 0 }, radius);
    } catch (e) {
        err = e;
    } finally {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    return { count: counter.blockAt, out, err };
}

// 球的 blockAt 上界：按"水平列 × 每列上下探测高度"算，再乘 1.5 倍容差。
// 实测基线（本机，r 夹紧后）：r=24 → 57777 次、r=32 → 137065 次。
// 上限取实测 ×1.5，既能吸收实现微调，又能在**不夹 r** 时（r=64 约 4 倍起）当场变红。
const OBSERVED = { 24: 57777, 32: 137065 };
const limitFor = (r) => Math.round((OBSERVED[r] ?? 0) * 1.5);

// ── ① r=24：默认值必须能跑，且 blockAt 次数在量级内 ──────────────────────
{
    const { count, out, err } = runScan(24);
    const limit = limitFor(24);
    if (!err && out && count > 0 && count <= limit) {
        okCase('① r=24（surveyArea 新默认）blockAt 次数在上限内',
            `blockAt=${count} ≤ ${Math.round(limit)}，cells=${out.cells}`);
    } else {
        badCase('① r=24 应在上限内', `err=${err?.message} count=${count} limit=${Math.round(limit)}`);
    }
}

// ── ② r=32：允许的最大半径，仍在上限内 ──────────────────────────────────
{
    const { count, out, err } = runScan(32);
    const limit = limitFor(32);
    if (!err && out && count > 0 && count <= limit) {
        okCase('② r=32（硬上限）blockAt 次数在上限内', `blockAt=${count} ≤ ${Math.round(limit)}`);
    } else {
        badCase('② r=32 应在上限内', `err=${err?.message} count=${count} limit=${Math.round(limit)}`);
    }
}

// ── ③ ★ 核心：r=64 必须被**夹到 32**，所以次数应与 r=32 基本一致 ────────
//
// 这条是真正对"未夹紧实现"变红的那一条：不夹的话 r=64 的次数是 r=32 的 ~4 倍以上
// （体积 ~ r^3，水平列 ~ r^2，实测报告里是 110 万量级）。
{
    const a = runScan(32);
    const b = runScan(64);
    const ratio = a.count ? b.count / a.count : Infinity;
    // 夹紧后两次应该做同样的活（比值 ≈1）；给 1.2 的容差吸收实现细节差异
    if (!b.err && b.count > 0 && ratio <= 1.2) {
        okCase('③ ★ r=64 被硬夹到 32（与 r=32 的工作量一致）',
            `r=32 时 ${a.count} 次，r=64 时 ${b.count} 次，比值 ${ratio.toFixed(2)}`);
    } else {
        badCase('③ r=64 应被夹到 32（工作量与 r=32 一致）',
            `r=32=${a.count} r=64=${b.count} 比值=${ratio.toFixed(2)} err=${b.err?.message}`);
    }
}

// ── ④ 单调性：次数必须随 r 增长（防止"夹成常数"这种反向修坏）──────────
{
    const s = runScan(8);
    const m = runScan(16);
    const l = runScan(24);
    if (s.count > 0 && s.count < m.count && m.count < l.count) {
        okCase('④ 半径越大扫得越多（没有被夹成常数）', `r8=${s.count} < r16=${m.count} < r24=${l.count}`);
    } else {
        badCase('④ 次数应随 r 单调增长', `r8=${s.count} r16=${m.count} r24=${l.count}`);
    }
}

// ── ⑤ surveyArea 的默认半径必须是 24（源码级，防止有人改回 64）──────────
{
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
    const m = src.match(/export function surveyArea\(bot, radius = (\d+)/);
    const def = m ? Number(m[1]) : null;
    if (def === 24) okCase('⑤ surveyArea 默认半径 = 24', `radius = ${def}`);
    else badCase('⑤ surveyArea 默认半径应为 24', `radius = ${def}`);
}

console.log('============================================');
console.log(`${pass}/${pass + fail} 个用例通过`);
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
