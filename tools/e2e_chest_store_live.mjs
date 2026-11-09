/**
 * 箱子「bot 主动存取 + 物品守恒」真机验收（测试服 25566 / RCON 25576）。
 *
 * 为什么有这个（T23 查实的覆盖缺口）：
 *   `scripts/e2e.ps1` 的 restart 场景虽然断言了箱子，但物品是 RCON
 *   `item replace block … container.N` **塞**进去的，bot 只**读回**；
 *   `atom_container.mjs` 只测开/关窗/距离/非容器，**不搬物品**；
 *   `t37_claims_contention_live.mjs` 测的是 `container:<x,y,z>` 预约争用，与箱内物品无关。
 *   ⇒「存 N 个 → 背包 -N / 箱子 +N → 守恒 → 取 M 个 → 守恒」这条**从来没测过**。
 *     物品丢失/复制是玩家直接损失，所以补这一条。
 *
 * 口径与其它 live 工具一致：MC 25566 / RCON 25576、tools/rcon.mjs、
 * `  PASS  <名>  <detail>` 行格式 + 末尾小计、退出码 0=全过。
 *
 * 搬物品**走真实技能**（不是自己写）：
 *   - 存：`flow_store.store(bot, item, n)`  ← `!do store` 的同一条路径
 *   - 取：`flow_store.fetch(bot, item, n)`  ← `!do fetch` 的同一条路径
 *   箱子真值用 `openContainer` + `win.containerItems()`（服务端下发的容器格子），
 *   另外用 RCON `data get block <pos> Items` 做**独立交叉验证**（不依赖 bot 自报）。
 *
 * 用法：
 *   node tools/e2e_chest_store_live.mjs                  # 全量场景（需测试服已起）
 *   node tools/e2e_chest_store_live.mjs --verify-persist # 只校验重启后 chest1 仍有 8 个 oak_log
 */
import fs from 'node:fs';
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import { rcon } from './rcon.mjs';
import { installPositionGuard } from '../src/sim/position_guard.js';
import { openContainer, closeContainer } from '../src/agent/library/act_container.js';
import { store, fetch } from '../src/agent/library/flow_store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RC = (c) => rcon(c, { port: 25576 });
const NAME = 'chs' + (Date.now() % 100000);

const PERSIST_ONLY = process.argv.includes('--verify-persist');

// 固定坐标（重启后还要能找回同一个箱子 —— 随机坐标做不到这件事）
const CHEST1 = { x: -98, y: -60, z: -600 };   // 主箱：守恒 + 重启持久化
const CHEST2 = { x: -98, y: -60, z: -540 };   // 满箱反证专用（离主箱 60 格，互不干扰）
const HOME = { x: -101, y: -60, z: -600 };    // bot 站位：离 chest1 水平 3.0 格（交互距离 4.3 内，实测过 5.0 会 OUT_OF_REACH）

let pass = 0, fail_ = 0;
function check(name, cond, detail = '') {
    if (cond) { pass++; console.log(`  PASS  ${name}  ${detail}`); }
    else { fail_++; console.log(`  FAIL  ${name}  ${detail}`); }
}
const sum = (res, key) => {
    const rows = res.split(/\r?\n/).filter((l) => l.includes(key + '=') || l.includes('"' + key + '"'));
    return rows.length;
};

/**
 * 等"容器窗口真的关掉"。
 *
 * 为什么需要（实测抖动根因）：上一段读箱子刚 `closeContainer`，服务端的 window id 序列还在推进，
 * 紧接着调 store/fetch 时 `openContainer` 可能拿到**刚失效的窗口**，导致搬物品的数量对不上
 * （实测：fetch(8) 搬走 16、还报"只取到 6/8"；同一操作在稳定状态下连跑 8 轮全对）。
 * 所以每次调技能前先等 currentWindow 变 null，再留一小段静默期 —— 这是"等同步"，
 * **不是**放宽断言：断言仍然是"正好 ±16/±8"。
 */
async function settleWindow(bot, maxMs = 3000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline && bot.currentWindow) await sleep(100);
    await sleep(1200);   // 实测：关窗后立刻重开（<1s）会让新窗口拿到失效的 window id，搬物品数量对不上
}

/** 背包里某物的数量（先确保没有开着的窗口，否则 mineflayer 会把容器格子混进来）。 */
function invCount(bot, name) {
    const items = bot.inventory?.items?.() ?? [];
    return items.filter((i) => i?.name === name).reduce((n, i) => n + (i.count ?? 0), 0);
}

/** 读箱子真值：开窗 → containerItems() → 关窗。返回 { total:{name:count}, slots }。 */
async function readChest(bot, pos) {
    await settleWindow(bot);
    const opened = await openContainer(bot, { kind: 'block', pos }, { timeout: 6000 });
    if (!opened.ok) return { ok: false, code: opened.code, message: opened.message, total: {}, slots: 0 };
    try {
        const win = bot.currentWindow;
        const items = typeof win?.containerItems === 'function' ? win.containerItems() : [];
        const total = {};
        for (const it of items) total[it.name] = (total[it.name] ?? 0) + it.count;
        return { ok: true, total, slots: items.length, size: win?.slots?.length ?? null };
    } finally {
        try { closeContainer(bot); } catch { /* ignore */ }
        await sleep(150);
    }
}

/**
 * RCON 侧的独立真值：箱子的 block entity 数据里数某物的总数（不经过 bot）。
 *
 * 1.21.8 的 NBT 文本每个条目形如 {Slot:0b, id:"minecraft:oak_log", count:16}；
 * 字段顺序不保证，所以**逐条目**解析，不依赖 id/count 先后，也不假设没有组件。
 */
async function rconChestCount(pos, itemName) {
    const raw = String(await RC(`data get block ${pos.x} ${pos.y} ${pos.z} Items`));
    let total = 0;
    const entries = raw.match(/\{[^{}]*\}/g) ?? [];
    for (const e of entries) {
        const idm = e.match(/id:\s*"(?:minecraft:)?([a-z0-9_]+)"/);   // 实测格式：id: "minecraft:oak_log"（冒号后有空格）
        const cm = e.match(/count:\s*(\d+)/);
        if (idm && cm && idm[1] === itemName) total += Number(cm[1]);
    }
    return { total, entries: entries.length, raw: raw.slice(0, 240) };
}

const bot = mineflayer.createBot({
    host: '127.0.0.1', port: 25566, username: NAME, auth: 'offline', version: '1.21.8',
});
bot.loadPlugin(pf.pathfinder);
installPositionGuard(bot);

// ── 点击插桩（协议层 window_click）+ 红时现场落盘 ──────────────────
// 目的：把"fetch(8) 却搬空箱子"那一次的**点击序列**和**三方快照**留下来。
// 为什么不挂在 bot.clickWindow 上：它在 plugin inject() 里才赋值，模块顶层拿不到（实测 undefined）。
const CLICKS = [];
let RECORDING = false;
const _origWrite = bot._client.write.bind(bot._client);
bot._client.write = (name, params) => {
    if (name !== 'window_click' || !RECORDING) return _origWrite(name, params);
    const w = bot.currentWindow;
    CLICKS.push({
        t: Date.now() - CLICKS.t0,
        slot: params.slot, btn: params.mouseButton, mode: params.mode,
        cursor: w?.selectedItem?.count ?? 0,
        clicked: params.clickedItem ? `${params.clickedItem.name}x${params.clickedItem.count}` : '-',
        carried: params.item ? `${params.item.name}x${params.item.count}` : '-',
    });
    return _origWrite(name, params);
};
CLICKS.t0 = 0;

/** 只列非空格：窗口前半 = 容器槽，后半 = 背包槽 */
function slotDetail() {
    const w = bot.currentWindow;
    if (!w) return { open: false };
    const chest = w.slots.slice(0, w.inventoryStart);
    const inv = w.slots.slice(w.inventoryStart, w.inventoryEnd ?? w.slots.length);
    return {
        open: true,
        chest: chest.map((x, i) => (x ? { i, name: x.name, count: x.count } : null)).filter(Boolean),
        invOak: inv.map((x, i) => (x && x.name === 'oak_log' ? { i, count: x.count } : null)).filter(Boolean),
        cursor: w.selectedItem ? { name: w.selectedItem.name, count: w.selectedItem.count } : null,
    };
}

/** 红时把现场写文件（不刷屏） */
function dumpRedCase(tag, payload) {
    try {
        const dir = 'E:/我的世界ai/docs/audit-r5/evidence/fix';
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = `${dir}/chest-withdraw-redcase-${stamp}-${tag}.txt`;
        fs.writeFileSync(file, payload, 'utf8');
        console.log(`  → 红时现场已落盘: ${file}`);
        return file;
    } catch (e) {
        console.log('  (red-case 落盘失败: ' + String(e?.message ?? e).slice(0, 100) + ')');
        return null;
    }
}
bot.on('error', () => { });
bot.on('kicked', (r) => console.log('KICKED', JSON.stringify(r).slice(0, 120)));

bot.once('spawn', async () => {
    try {
        await sleep(2000);
        await RC(`op ${NAME}`);          // 读 block entity / item replace 需要权限
        await RC(`gamemode survival ${NAME}`);

        // ── 0) 只校验重启后持久化（不重造场地）──
        if (PERSIST_ONLY) {
            await RC(`tp ${NAME} ${HOME.x + 0.5} ${HOME.y} ${HOME.z + 0.5}`);
            await sleep(1500);
            const c = await readChest(bot, CHEST1);
            const viaRcon = await rconChestCount(CHEST1, 'oak_log');
            check('重启后：箱子里仍有 8 个 oak_log（bot 读）', c.ok && (c.total['oak_log'] ?? 0) === 8,
                `containerItems → ${JSON.stringify(c.total)}`);
            check('重启后：箱子里仍有 8 个 oak_log（RCON 独立读）', viaRcon.total === 8,
                `data get block Items → ${viaRcon.total}`);
            finish();
            return;
        }

        // ── 1) 前置：清背包 + 造场地 + 给 32 个原木 ──
        await RC(`tp ${NAME} ${HOME.x + 0.5} ${HOME.y} ${HOME.z + 0.5}`);
        await sleep(1200);
        await RC(`clear ${NAME}`);
        await RC(`setblock ${CHEST1.x} ${CHEST1.y} ${CHEST1.z} chest`);
        await RC(`setblock ${CHEST2.x} ${CHEST2.y} ${CHEST2.z} chest`);
        await RC(`give ${NAME} minecraft:oak_log 32`);
        await sleep(1200);

        const inv0 = invCount(bot, 'oak_log');
        const chest0 = await readChest(bot, CHEST1);
        console.log(`  [前置] 背包 oak_log=${inv0}；chest1 内容=${JSON.stringify(chest0.total)}（ok=${chest0.ok}）`);
        check('前置：背包拿到 32 个 oak_log', inv0 === 32, `实际 ${inv0}`);
        check('前置：chest1 是空的', chest0.ok && Object.keys(chest0.total).length === 0, JSON.stringify(chest0.total));

        // ── 2) 存 16 个（真实技能 flow_store.store）──
        console.log('\n  --- 存：flow_store.store(bot, "oak_log", 16) ---');
        await settleWindow(bot);
        const r1 = await store(bot, 'oak_log', 16);
        await sleep(600);
        const inv1 = invCount(bot, 'oak_log');
        const chest1 = await readChest(bot, CHEST1);
        const rcon1 = await rconChestCount(CHEST1, 'oak_log');
        console.log(`  [存后] 技能返回 ${JSON.stringify(r1).slice(0, 200)}`);
        console.log(`  [存后] 背包 ${inv0} → ${inv1}；chest1 ${JSON.stringify(chest0.total)} → ${JSON.stringify(chest1.total)}；RCON ${rcon1.total}`);

        check('存：技能返回 ok', r1?.ok === true, `code=${r1?.code ?? 'null'} msg=${r1?.message ?? ''}`);
        check('断言A 存后背包 -16', inv0 - inv1 === 16, `${inv0} → ${inv1}`);
        check('断言B 存后箱子 +16（bot 读 containerItems）', (chest1.total['oak_log'] ?? 0) - (chest0.total['oak_log'] ?? 0) === 16,
            `箱子 ${(chest0.total['oak_log'] ?? 0)} → ${(chest1.total['oak_log'] ?? 0)}`);
        console.log(`  [RCON 原文] ${rcon1.raw}`);
        check('断言B2 存后箱子 +16（RCON 独立读，不信 bot 自报）', rcon1.total === 16, `data get block Items → ${rcon1.total}（条目 ${rcon1.entries}）`);
        check('断言C 存后总数守恒（背包+箱子 不变，且确实搬动了）',
            inv1 + (chest1.total['oak_log'] ?? 0) === inv0 + (chest0.total['oak_log'] ?? 0) && (inv0 - inv1) === 16,
            `${inv0}+${(chest0.total['oak_log'] ?? 0)} → ${inv1}+${(chest1.total['oak_log'] ?? 0)}`);

        // ── 2b) ★ T36 插桩：store 结束后，窗口/光标是否干净？──
        //   背景：verifier 复现到「取 8 结果 +11 / -11」（多搬 3）——怀疑 store 留下光标件，
        //   在 fetch 开窗/关窗时被倒进背包，与本次搬运叠加。这里把 store 刚结束、
        //   以及 fetch 开窗前的那一刻都录下来（含窗口是否还开着、光标上有什么）。
        {
            const w = bot.currentWindow;
            const snap = () => {
                const ww = bot.currentWindow;
                return {
                    windowOpen: !!ww,
                    cursor: ww?.selectedItem ? { name: ww.selectedItem.name, count: ww.selectedItem.count } : null,
                    chestOak: (chest1.total['oak_log'] ?? 0),   // 存后已读到的箱子真值（别引用后面才定义的 chest2r）
                    invOak: invCount(bot, 'oak_log'),
                };
            };
            const atStoreEnd = snap();
            console.log(`  [插桩] store 结束: 窗口开着=${atStoreEnd.windowOpen} 光标=${JSON.stringify(atStoreEnd.cursor)} 箱子oak=${atStoreEnd.chestOak} 背包oak=${atStoreEnd.invOak}`);
            if (atStoreEnd.cursor && atStoreEnd.cursor.count > 0) {
                console.log('  [插桩] ⚠ store 留下了光标件 —— 这正是"残留 + 本次搬运叠加"的候选来源');
            }
            void w;

            // 主动关掉任何残留窗口（记录它当时的状态），让 fetch 从干净状态开始
            if (atStoreEnd.windowOpen) {
                console.log('  [插桩] ⚠ store 结束时窗口仍开着（预期应已关闭）—— 记录后关闭');
                try { closeContainer(bot); } catch { /* ignore */ }
                await sleep(400);
            }
            console.log(`  [插桩] fetch 开窗前: 窗口开着=${!!bot.currentWindow} 光标=${JSON.stringify(bot.currentWindow?.selectedItem ?? null)}`);
        }

        // ── 3) 取回 8 个（真实技能 flow_store.fetch）──
        console.log('\n  --- 取：flow_store.fetch(bot, "oak_log", 8) ---');
        await settleWindow(bot);
        const detailPreFetch = await (async () => {
            const o = await openContainer(bot, { kind: 'block', pos: CHEST1 }, { timeout: 6000 });
            const d = o.ok ? slotDetail() : { open: false, err: o.code };
            try { closeContainer(bot); } catch { /* ignore */ }
            await sleep(300);
            return d;
        })();
        CLICKS.length = 0; CLICKS.t0 = Date.now(); RECORDING = true;
        const r2 = await fetch(bot, 'oak_log', 8);
        RECORDING = false;
        await sleep(600);
        const inv2 = invCount(bot, 'oak_log');
        const chest2r = await readChest(bot, CHEST1);
        const rcon2 = await rconChestCount(CHEST1, 'oak_log');
        console.log(`  [取后] 技能返回 ${JSON.stringify(r2).slice(0, 200)}`);
        console.log(`  [取后] 背包 ${inv1} → ${inv2}；chest1 ${JSON.stringify(chest1.total)} → ${JSON.stringify(chest2r.total)}；RCON ${rcon2.total}`);

        check('取：技能返回 ok', r2?.ok === true, `code=${r2?.code ?? 'null'} msg=${r2?.message ?? ''}`);
        check('断言D 取后背包 +8', inv2 - inv1 === 8, `${inv1} → ${inv2}`);
        check('断言D2 取后箱子 -8', (chest1.total['oak_log'] ?? 0) - (chest2r.total['oak_log'] ?? 0) === 8,
            `${(chest1.total['oak_log'] ?? 0)} → ${(chest2r.total['oak_log'] ?? 0)}`);
        check('断言D3 取后总数守恒（且确实搬动了）', inv2 + (chest2r.total['oak_log'] ?? 0) === inv1 + (chest1.total['oak_log'] ?? 0) && (inv2 - inv1) === 8,
            `${inv1}+${(chest1.total['oak_log'] ?? 0)} → ${inv2}+${(chest2r.total['oak_log'] ?? 0)}`);
        check('取后 RCON 独立读箱子 = 8', rcon2.total === 8, `data get block Items → ${rcon2.total}`);

        // ── 红时现场：物理搬动与技能自报不一致（本缺陷的特征）──
        {
            const physical = (chest1.total['oak_log'] ?? 0) - (chest2r.total['oak_log'] ?? 0);
            const accounted = Number(r2?.data?.taken ?? 0);
            if (!r2?.ok || physical !== 8 || accounted !== physical) {
                const L = [];
                L.push('# fetch(8) 现场：点击序列 + 三方快照');
                L.push('');
                L.push(`fetch 返回: ${JSON.stringify(r2)}`);
                L.push(`物理搬动(箱子差): ${physical}；技能自报 taken: ${accounted}；请求: 8`);
                L.push('');
                L.push('## 服务端真值（RCON data get block Items）');
                L.push(`取前=${rcon1.total}  取后=${rcon2.total}`);
                L.push(`  取前原文: ${rcon1.raw}`);
                L.push(`  取后原文: ${rcon2.raw}`);
                L.push('');
                L.push('## bot 读箱子 containerItems：' + JSON.stringify(chest1.total) + ' → ' + JSON.stringify(chest2r.total));
                L.push('## 背包 oak_log：' + inv1 + ' → ' + inv2);
                L.push('');
                L.push('## fetch 前 开窗槽位明细');
                L.push(JSON.stringify(detailPreFetch));
                L.push('');
                L.push(`## 点击序列（window_click，共 ${CLICKS.length} 次）`);
                L.push('idx | Δms | slot | btn | mode | 发送时光标 | 点击槽内容 | 手里拿着');
                CLICKS.forEach((c, i) => L.push(`${i} | ${c.t} | ${c.slot} | ${c.btn} | ${c.mode} | ${c.cursor} | ${c.clicked} | ${c.carried}`));
                L.push('');
                L.push('## 判读');
                L.push('- slot<27 表示点的是**箱子槽**，slot>=27 表示**背包槽**（箱子 27 格 + 背包 36 格）');
                L.push('- btn=0 左键 = 整摞/合并；btn=1 右键 = 单个/取半');
                L.push('- 若看到 btn=0 点箱子槽（一次搬整摞 16）后没有把多余的放回去 ⇒ 假设① 整摞搬走');
                L.push('- 若点击都是 btn=1 且次数对得上 8，只是 taken 算成别的 ⇒ 假设② 计数/账目问题');
                dumpRedCase('fetch', L.join('\n'));
            }
        }

        // ── 4) 反证一：目标物品不在箱子里 → 必须失败且背包不变 ──
        console.log('\n  --- 反证1：取箱子里没有的东西（diamond）---');
        await RC(`give ${NAME} minecraft:diamond 4`);
        await sleep(900);
        const dBefore = invCount(bot, 'diamond');
        await settleWindow(bot);
        const r3 = await fetch(bot, 'diamond', 4);
        await sleep(500);
        const dAfter = invCount(bot, 'diamond');
        const chest3 = await readChest(bot, CHEST1);
        console.log(`  [反证1] 返回 ${JSON.stringify(r3).slice(0, 200)}；diamond ${dBefore} → ${dAfter}；chest1=${JSON.stringify(chest3.total)}`);
        check('反证1：取不存在的物品 → 技能失败（不是假成功）', r3?.ok === false, `code=${r3?.code} msg=${r3?.message}`);
        check('反证1：背包 diamond 数量不变（没有凭空变化）', dAfter === dBefore, `${dBefore} → ${dAfter}`);
        check('反证1：箱子内容未被破坏（仍只有 8 个 oak_log）',
            (chest3.total['oak_log'] ?? 0) === 8 && !chest3.total['diamond'],
            JSON.stringify(chest3.total));

        // ── 5) 反证二：箱子已满 → 必须失败且背包不变 ──
        console.log('\n  --- 反证2：把 chest2 塞满 27 格，再存 oak_log ---');
        for (let i = 0; i < 27; i++) {
            await RC(`item replace block ${CHEST2.x} ${CHEST2.y} ${CHEST2.z} container.${i} with minecraft:dirt 64`);
        }
        await RC(`tp ${NAME} ${CHEST2.x + 2.5} ${CHEST2.y} ${CHEST2.z + 0.5}`);
        await sleep(1500);
        const invFull0 = invCount(bot, 'oak_log');
        await settleWindow(bot);
        const r4 = await store(bot, 'oak_log', 8);
        await sleep(600);
        const invFull1 = invCount(bot, 'oak_log');
        console.log(`  [反证2] 返回 ${JSON.stringify(r4).slice(0, 240)}；oak_log ${invFull0} → ${invFull1}`);
        check('反证2：满箱子存 → 技能失败（INVENTORY_FULL/NO_TARGET 等，不是假成功）', r4?.ok === false,
            `code=${r4?.code} msg=${r4?.message}`);
        check('反证2：背包 oak_log 数量不变', invFull1 === invFull0, `${invFull0} → ${invFull1}`);

        // ── 6) 反证三：距离过远（>4 格）→ 必须失败且背包不变 ──
        console.log('\n  --- 反证3：站到 20 格外再存（近战/交互距离外）---');
        await RC(`clear ${NAME}`);
        await RC(`give ${NAME} minecraft:oak_log 4`);
        await sleep(900);
        await RC(`tp ${NAME} ${HOME.x - 20}.5 ${HOME.y} ${HOME.z + 0.5}`);
        await sleep(1500);
        const far0 = invCount(bot, 'oak_log');
        await settleWindow(bot);
        const r5 = await store(bot, 'oak_log', 4);
        await sleep(600);
        const far1 = invCount(bot, 'oak_log');
        console.log(`  [反证3] 返回 ${JSON.stringify(r5).slice(0, 240)}；oak_log ${far0} → ${far1}`);
        check('反证3：距离过远 → 技能失败', r5?.ok === false, `code=${r5?.code} msg=${r5?.message}`);
        check('反证3：背包 oak_log 数量不变', far1 === far0, `${far0} → ${far1}`);

        // ── 7) 收尾：回到主箱旁，确认主箱状态可供重启校验 ──
        await RC(`tp ${NAME} ${HOME.x + 0.5} ${HOME.y} ${HOME.z + 0.5}`);
        await sleep(1200);
        const finalChest = await readChest(bot, CHEST1);
        const finalRcon = await rconChestCount(CHEST1, 'oak_log');
        console.log(`\n  [收尾] chest1 = ${JSON.stringify(finalChest.total)}；RCON = ${finalRcon.total}（供重启后校验）`);
        check('收尾：chest1 保留 8 个 oak_log（供重启持久化校验）',
            (finalChest.total['oak_log'] ?? 0) === 8 && finalRcon.total === 8,
            `bot=${(finalChest.total['oak_log'] ?? 0)} rcon=${finalRcon.total}`);

        finish();
    } catch (e) {
        console.log('  FAIL  场景执行未抛异常  ' + String(e?.stack ?? e).slice(0, 600));
        fail_++;
        finish();
    }
});

function finish() {
    console.log(`\n=== 小计：PASS ${pass} / ${pass + fail_}，FAIL ${fail_} ===`);
    try { bot.quit(); } catch { /* ignore */ }
    setTimeout(() => process.exit(fail_ === 0 ? 0 : 1), 800);
}
