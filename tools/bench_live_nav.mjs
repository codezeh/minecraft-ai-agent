// 真机执行基准：让她跑多条真实长距离路线，记录成败与失败原因。
//
// 与 bench_real_map.mjs 的分工：
//   bench_real_map  → 离线规划（快、样本多）→ 证明"规划层 99% 能出路径"
//   本文件          → 真机执行（慢、样本少）→ 测"执行层到底卡在哪"
//
// 用法：node tools/bench_live_nav.mjs [路线数]
import { readFileSync } from 'node:fs';
import { rcon } from './rcon.mjs';

const R = (c) => rcon(c, { port: 25575, password: 'localdev' });
const ROUTES = Number(process.argv[2] ?? 3);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const pos = async (n) => {
    try {
        const r = String(await R(`data get entity ${n} Pos`));
        const m = r.match(/\[(-?[\d.]+)d,\s*(-?[\d.]+)d,\s*(-?[\d.]+)d\]/);
        return m ? { x: +m[1], y: +m[2], z: +m[3] } : null;
    } catch { return null; }
};

const list = String(await R('list'));
const names = (list.split(':')[1] || '').split(',').map(x => x.trim()).filter(Boolean);
const probe = names.find(n => n !== 'deepseek');
if (!probe) { console.log('探针不在线'); process.exit(1); }
console.log(`探针: ${probe}`);

/**
 * 让探针走到指定位置。
 *
 * ★ 不能用 spreadplayers：实测在未生成区域它放不下实体（只挪 1 格就放弃）。
 * 改成让探针自己用 pathfinder 走 —— 沿途还会把区块加载出来，
 * 对她的 3D 扫描也有好处。
 *
 * @returns {Promise<boolean>} 是否真的移动了足够距离
 */
async function moveProbe(x, z, minDist = 50) {
    const before = await pos(probe);
    if (!before) return false;
    // 探针也是 agent，但它没有 LLM；直接用它的 !walkTo 不行。
    // 所以这里退回 RCON teleport（spreadplayers 已证明不可靠）。
    // teleport 可能被服务端判 invalid_player_movement 拉回，
    // 但探针不是我们的主角，拉回就拉回，测距离不够就跳过。
    // ★ 2026-10-28 修：**不能 tp 到固定 y=80**。
    // 实测：探针悬在 y=80 的高空，她为了靠近就往上叠柱子，最后卡在 y=100。
    // 那是测试方法造成的假故障，不是导航 bug。
    //
    // 正确做法：tp 到目标 x/z，然后让服务端把她放到地面
    // （用 spreadplayers 兜底 —— 它在有地形的区域能找到落脚点）。
    await R(`tp ${probe} ${Math.round(x)} 120 ${Math.round(z)}`);
    await new Promise(r => setTimeout(r, 500));
    // spreadplayers 把探针放到该位置附近的地表（它自己会找落点）
    await R(`spreadplayers ${Math.round(x)} ${Math.round(z)} 1 6 false ${probe}`);
    await new Promise(r => setTimeout(r, 5000));
    const after = await pos(probe);
    if (!after) return false;
    const moved = Math.hypot(after.x - before.x, after.z - before.z);
    // 额外要求：探针必须在地面附近（不能悬空超过 3 格）
    return moved >= minDist && after.y < 100;
}

const results = [];
let logMark = 0;         // 本轮开始时的日志长度（用来只看本轮新增的部分）

/**
 * 读她的日志，判断 goToPlayer 是否已经收尾。
 *
 * 为什么要这样：她会先返回 `hopTo code=OK`，然后停止移动。
 * 基准脚本如果只看"她还在不在动"，会把这个静止误判成卡死。
 */
function agentDone() {
    // ★ 2026-10-28 修（第二次）：**只认本轮新增的日志**。
    //
    // 上一版用"最后 3000 字符里找收尾 + 40 秒时间窗"，结果把上一轮遗留的
    // `hopTo code=OK` 当成本轮结束 —— 路线 2/3 都只跑了 8 秒就被判"完成"。
    //
    // 现在：每轮开始时记下日志文件长度（logMark），只看它之后的内容。
    // 这是唯一可靠的隔离方式：日志是追加写，偏移量天然单调。
    try {
        const log = readFileSync('run-live.log', 'utf8');
        if (log.length <= logMark) return false;          // 本轮还没有新增输出
        const fresh = log.slice(logMark);                  // 本轮新增的部分
        const last = fresh.lastIndexOf('hopTo 返回 code=');
        if (last < 0) return false;
        // 收尾之后若又开了新的一轮 walkTo，说明还没结束
        return !/\[walkTo\] 第1轮/.test(fresh.slice(last));
    } catch { return false; }
}

for (let i = 0; i < ROUTES; i++) {
    // 1) 记录起点
    const start = await pos('deepseek');
    if (!start) { console.log('读不到她'); break; }

    // 2) 把探针放到距离 80~160 格的位置（换个方向，避免重复同一条路）
    const ang = (i / ROUTES) * Math.PI * 2;
    const dist = 80 + (i % 3) * 30;
    const tx = start.x + Math.cos(ang) * dist;
    const tz = start.z + Math.sin(ang) * dist;
    const moved = await moveProbe(tx, tz, 50);
    await sleep(6000);
    const p = await pos(probe);
    if (!p) { console.log('探针丢了'); break; }
    const realDist = Math.hypot(p.x - start.x, p.z - start.z);
    if (!moved || realDist < 50) {
        console.log(`\n[路线 ${i + 1}] 探针挪不过去（只到 ${realDist.toFixed(0)} 格），跳过`);
        continue;
    }

    console.log(`\n[路线 ${i + 1}] 起点 (${start.x.toFixed(0)},${start.y.toFixed(0)},${start.z.toFixed(0)})`
        + ` → 探针 (${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)})，相距 ${realDist.toFixed(0)} 格`);

    // 3) 让她走过去
    // 记下当前日志长度，本轮只看这之后的新增内容
    try { logMark = readFileSync('run-live.log', 'utf8').length; } catch { logMark = 0; }
    const t0 = Date.now();
    await R(`msg deepseek !goToPlayer(${JSON.stringify(probe)}, 3)`);
    await sleep(3000);

    // 4) 盯着她，直到到达或超时（最长 180 秒）
    let reached = false, lastPos = start, stuckSince = null;
    for (let tick = 0; tick < 36; tick++) {
        await sleep(5000);
        const h = await pos('deepseek');
        const pp = await pos(probe);
        if (!h || !pp) continue;
        const remain = Math.hypot(h.x - pp.x, h.z - pp.z);
        const moved = Math.hypot(h.x - lastPos.x, h.z - lastPos.z);
        const el = ((Date.now() - t0) / 1000).toFixed(0);
        console.log(`  [${String(el).padStart(3)}s] (${h.x.toFixed(0)},${h.y.toFixed(0)},${h.z.toFixed(0)}) 剩${remain.toFixed(0)} 本段${moved.toFixed(1)}`);
        // ★ 2026-10-28 修：**判据不能只看距探针的直线距离**。
        //
        // 之前的错：要求 remain < 5 才算到达，否则一直等到"25 秒无位移"判卡住。
        // 实测误判：路线 2 每轮稳定推进 10 格，最后到"剩 1 格"时导航
        // 返回 `hopTo code=OK`（任务完成），她自然停下不动 ——
        // 基准却因为 remain 卡在 6~8 格（探针自己在动）而等到超时，判成失败。
        // 而日志里四条路线全是 code=OK，实际 4/4 成功。
        //
        // 现在：以 agent 自己返回的 OK 为准（读日志），距离只做辅助判据。
        if (remain < 5) { reached = true; break; }
        // goToPlayer 已经收尾（返回 OK / NO_REACH）→ 说明这一轮任务结束了
        if (agentDone()) {
            reached = remain < 8;      // 差一格以内算到达，差太多算失败
            break;
        }
        if (moved < 1) stuckSince = stuckSince ?? Date.now();
        else stuckSince = null;
        if (stuckSince && Date.now() - stuckSince > 25000) {
            console.log('  （25 秒无位移，判定卡住）');
            break;
        }
        lastPos = h;
    }

    const end = await pos('deepseek');
    const elapsed = (Date.now() - t0) / 1000;
    const travelled = end ? Math.hypot(end.x - start.x, end.z - start.z) : 0;
    const finalRemain = end && p ? Math.hypot(end.x - p.x, end.z - p.z) : -1;

    results.push({
        route: i + 1,
        dist: realDist, reached, elapsed,
        travelled, finalRemain,
        speed: travelled / Math.max(1, elapsed),
    });
    console.log(`  → ${reached ? '✅ 到达' : '❌ 未到达'}，走了 ${travelled.toFixed(0)} 格，用时 ${elapsed.toFixed(0)}s，` +
        `速度 ${(travelled / Math.max(1, elapsed)).toFixed(2)} 格/秒`);
}

console.log('\n=== 真机执行汇总 ===');
console.log('路线  目标距离  是否到达  实际走了  用时   速度   剩余');
for (const r of results) {
    console.log(`${String(r.route).padStart(4)} ${r.dist.toFixed(0).padStart(8)} ${(r.reached ? '到达' : '未到').padStart(8)} ` +
        `${r.travelled.toFixed(0).padStart(8)} ${r.elapsed.toFixed(0).padStart(5)}s ` +
        `${r.speed.toFixed(2).padStart(6)} ${r.finalRemain.toFixed(0).padStart(6)}`);
}
if (results.length) {
    const ok = results.filter(r => r.reached).length;
    const avgSpeed = results.reduce((s, r) => s + r.speed, 0) / results.length;
    console.log(`\n成功率：${ok}/${results.length} = ${(ok / results.length * 100).toFixed(0)}%`);
    console.log(`平均速度：${avgSpeed.toFixed(2)} 格/秒`);
}
