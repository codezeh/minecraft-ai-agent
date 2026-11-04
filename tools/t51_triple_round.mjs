// 3 轮测量驱动（第 37 跑版）
// 每轮：检查窗口 → 验树(≥3 沿用，不重建) → 清板到0 → 数真实 oak_log → 跑 harness → 采集指标
import { rcon } from './rcon.mjs';
import { openBoard } from '../src/agent/library/board_store.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const ROUNDS = 3;
const LOG = 'tmp-t59-agent.log';
const SPOTS = [[0, 0], [6, 0], [12, 0], [0, 6], [6, 6], [12, 6], [0, 12], [6, 12], [12, 12], [3, 3], [-3, 4], [9, 3], [-6, -3], [-6, 6], [3, 9], [9, 9]];
const CHECK = [[6200, 8800], [6206, 8800], [6200, 8806], [6206, 8806], [6203, 8803], [6197, 8804]];
const results = [];

const rc = async (cmd) => { try { return String(await rcon(cmd, { port: 25576 })); } catch { return ''; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function countRealLogs() {
    let n = 0;
    for (const [dx, dz] of SPOTS) {
        for (let dy = -60; dy <= -45; dy++) {
            if (/passed/i.test(await rc(`execute if block ${6200 + dx} ${dy} ${8800 + dz} minecraft:oak_log`))) n++;
        }
    }
    return n;
}

for (let r = 1; r <= ROUNDS; r++) {
    console.log(`\n========== 第 ${r}/${ROUNDS} 轮 ==========`);

    const list = await rc('list');
    if (!/There are 0 of/.test(list)) { console.log('  🔴 有玩家在线，作废本轮'); results.push({ round: r, voided: 'player-online' }); continue; }

    // ★ 第 39 跑：树判据从"6 个固定抽样点"改成"**真实 oak_log 方块总数**"
    //   （抽样点只命中 2/6 但实际有 109 个方块 —— 抽样点法太脆）
    const treeBlocks = await countRealLogs();
    let treeHits = treeBlocks;
    console.log(`  真实 oak_log 方块总数 = ${treeBlocks}（判据 ≥10）`);
    if (treeBlocks < 10) {
        console.log(`  🔴 只有 ${treeBlocks} 个方块（<10）→ 跳过本轮，不重建（避免污染场地）`);
        results.push({ round: r, voided: 'treeBlocks<10' });
        continue;
    }

    const db = openBoard().db;
    db.exec('DELETE FROM jobs');
    try { db.exec('DELETE FROM claims'); } catch { }
    const n0 = db.prepare('SELECT COUNT(*) c FROM jobs').get().c;
    console.log(`  ★ 清板后 COUNT(*) = ${n0}`);
    if (n0 !== 0) { console.log('  🔴 清板失败，作废本轮'); results.push({ round: r, voided: 'not-clear' }); continue; }

    try { fs.writeFileSync(LOG, ''); } catch { }

    const logsBefore = await countRealLogs();
    console.log(`  真实 oak_log 方块数（跑前）= ${logsBefore}`);

    console.log('  起 agent 跑…');
    await new Promise((res) => {
        const p = spawn(process.execPath, ['tools/t51_firstnight_realagent.mjs'], { stdio: 'ignore' });
        const t = setTimeout(() => { try { p.kill('SIGTERM'); } catch { } }, 1250 * 1000);
        p.on('exit', () => { clearTimeout(t); res(); });
    });

    const log = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
    const cnt = (re) => (log.match(re) ?? []).length;

    const met = {
        round: r,
        tree: treeHits,
        logsBefore,
        goToFalse: cnt(/\[MINE\] goTo false/g),
        goToTrue: cnt(/\[MINE\] goTo true/g),
        digOk: cnt(/\[MINE\] dig true/g),
        digAbort: cnt(/Digging aborted/g),
        pickup: cnt(/\[MINE\] pickup/g),
        staleBlk: cnt(/stale-block/g),
        noTarget: cnt(/\[MINE\] dig false NO_TARGET/g),
    };
    const cands = [...log.matchAll(/candidates= (\d+)/g)].map((m) => Number(m[1]));
    met.candMax = cands.length ? Math.max(...cands) : null;
    met.logsAfter = await countRealLogs();

    const db2 = openBoard().db;
    const fnRow = db2.prepare("SELECT id,state FROM jobs WHERE skill='first_night' ORDER BY createdAt LIMIT 1").get();
    const pid = fnRow?.id ?? null;
    met.parentState = fnRow?.state ?? 'none';
    met.parentCount = db2.prepare("SELECT COUNT(*) c FROM jobs WHERE skill='first_night'").get().c;

    const stOf = (item) => {
        if (!pid) return 'none';
        const row = db2.prepare("SELECT state FROM jobs WHERE parentId=? AND skill='obtain' AND args LIKE ? ORDER BY createdAt LIMIT 1").get(pid, `%${item}%`);
        return row?.state ?? 'none';
    };
    met.oakLog = stOf('oak_log');
    met.table = stOf('crafting_table');
    met.woodPick = stOf('wooden_pickaxe');
    met.stonePick = stOf('stone_pickaxe');

    // 两级：mine / craft 是 obtain 的孙子
    if (pid) {
        const mine = db2.prepare(`SELECT state,progress FROM jobs WHERE skill='mine' AND args LIKE '%oak_log%'
            AND parentId IN (SELECT id FROM jobs WHERE parentId=?) ORDER BY createdAt LIMIT 1`).get(pid);
        met.mineState = mine?.state ?? 'none';
        met.mineProg = mine?.progress ?? '';
        const cp = db2.prepare(`SELECT state,result FROM jobs WHERE skill='craft' AND args LIKE '%oak_planks%'
            AND parentId IN (SELECT id FROM jobs WHERE parentId=?) ORDER BY createdAt LIMIT 1`).get(pid);
        met.planksState = cp?.state ?? 'none';
        if (cp?.result) { try { const rr = JSON.parse(cp.result); if (!rr.ok) met.planksData = JSON.stringify(rr.data ?? {}).slice(0, 300); } catch { } }
    } else {
        met.mineState = 'none'; met.mineProg = ''; met.planksState = 'none';
    }

    // ★ 第 41 跑：抓 wooden_pickaxe 的**全部子单 + 各自 count**（验证 t97 料账）
    // ★ 第 42 跑：查 wooden_pickaxe 的**全部**子单（不限 state、不 LIMIT），并带 createdAt
    if (pid) {
        const wpObs = db2.prepare("SELECT id,createdAt FROM jobs WHERE parentId=? AND skill='obtain' AND args LIKE '%wooden_pickaxe%' ORDER BY createdAt").all(pid);
        if (wpObs.length) {
            const all = [];
            for (const ob of wpObs) {
                const kids = db2.prepare("SELECT skill,args,state,createdAt,result FROM jobs WHERE parentId=? ORDER BY createdAt").all(ob.id);
                met.wpDispatchCount = (met.wpDispatchCount ?? 0) + 1;
                for (const k of kids) {
                    const a = JSON.parse(k.args || '{}');
                    all.push(`${k.skill}:${a.item ?? a.ore ?? ''}${a.count != null ? 'x' + a.count : ''}=${k.state}@${k.createdAt % 100000}`);
                    // craft 失败的 data（t105 证据）
                    if (!met.craftData && k.state === 'blocked' && k.result) {
                        try {
                            const rr = JSON.parse(k.result);
                            if (!rr.ok && rr.data && Object.keys(rr.data).length) met.craftData = JSON.stringify(rr.data).slice(0, 350);
                        } catch { }
                    }
                }
            }
            met.wpKids = all.join(' | ');
            met.wpKidCount = all.length;
        }
    }
    // craft wooden_pickaxe 失败诊断（t90/t91 直接证据）
    const wp = db2.prepare("SELECT state,result FROM jobs WHERE skill='craft' AND args LIKE '%wooden_pickaxe%' ORDER BY createdAt DESC LIMIT 1").get();
    if (wp?.result) {
        try {
            const rr = JSON.parse(wp.result);
            if (!rr.ok) { met.wpFail = String(rr.message ?? '').slice(0, 90); met.wpData = JSON.stringify(rr.data ?? {}).slice(0, 400); }
        } catch { }
    }

    results.push(met);
    console.log('  指标: ' + JSON.stringify(met));
}

const valid = results.filter((x) => !x.voided);
const med = (arr) => { const a = [...arr].sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2); };

console.log('\n========== 汇总 ==========');
console.log('  有效轮数: ' + valid.length + ' / ' + results.length);
for (const k of ['goToFalse', 'goToTrue', 'digOk', 'digAbort', 'pickup', 'staleBlk', 'noTarget']) {
    const v = valid.map((x) => x[k] ?? 0);
    if (!v.length) continue;
    console.log(`  ${k}: 中位 ${med(v)}（范围 ${Math.min(...v)}~${Math.max(...v)}）  各轮=[${v.join(', ')}]`);
}

console.log('');
console.log('  | 轮 | abort | digOK | goToF | goToT | stale | NO_TGT | oak_log | table | wood_pick | stone_pick | parent |');
console.log('  |---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of valid) {
    console.log(`  | ${r.round} | ${r.digAbort} | ${r.digOk} | ${r.goToFalse} | ${r.goToTrue} | ${r.staleBlk} | ${r.noTarget} | ${r.oakLog} | ${r.table} | ${r.woodPick} | ${r.stonePick} | ${r.parentState} |`);
}

console.log('');
console.log('  | 轮 | 真实logs(前→后) | candidates最大值 |');
for (const r of valid) console.log(`  | ${r.round} | ${r.logsBefore} → ${r.logsAfter} | ${r.candMax ?? '-'} |`);

const tableDone = valid.filter((x) => x.table === 'done').length;
const woodDone = valid.filter((x) => x.woodPick === 'done').length;
const parentDone = valid.filter((x) => x.parentState === 'done').length;
const oakDone = valid.filter((x) => x.oakLog === 'done').length;
console.log('');
console.log(`  obtain:oak_log done        : ${oakDone}/${valid.length}`);
console.log(`  obtain:crafting_table done : ${tableDone}/${valid.length}`);
console.log(`  obtain:wooden_pickaxe done : ${woodDone}/${valid.length}`);
console.log(`  parent done                : ${parentDone}/${valid.length}`);

for (const r of valid) if (r.wpKids) console.log(`  轮${r.round} wood_pick 共 ${r.wpKidCount} 张子单（${r.wpDispatchCount} 次 dispatch）:
    ${r.wpKids}`);
for (const r of valid) if (r.craftData) console.log(`  轮${r.round} ★ craft 失败 data = ${r.craftData}`);
else if (valid.length) console.log('  ★ 注意：本轮所有轮次都没抓到带 data 的 craft 失败（可能没失败，或 t105 没生效）');
for (const r of valid) if (r.wpFail) console.log(`  轮${r.round} wood_pick 失败: ${r.wpFail}  data=${r.wpData}`);
for (const r of valid) if (r.planksData) console.log(`  轮${r.round} planks(${r.planksState}) data=${r.planksData}`);

fs.writeFileSync('tmp/t51-triple.json', JSON.stringify(results, null, 1));
console.log('  明细已存 tmp/t51-triple.json');
