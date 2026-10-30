/**
 * A6 载具：上船 / 开船 / 下船。
 *
 * 单一副作用：把"她自己在载具上"这件事改变、或让载具移动。
 * 只负责"上得去、动得了、下得来"，不负责"该不该坐船"（那是复合层）。
 *
 * ★ 2026-10-29 新建。为什么必须单独一个模块：
 *   查过 GitHub，mineflayer 的 `bot.mount` 在 Paper 1.21.8 上**服务端静默忽略**。
 *   实测穷尽了四种包变体（单 interact / 单 interact_at /
 *   [PR #4089](https://github.com/PrismarineJS/mineflayer/pull/4089) 的原版
 *   interact_at+interact 一对 / 原生 bot.mount），服务端全无反应，
 *   而位置同步偏差 0.00 格、包结构正确（查过 1.21.8 的 packet_use_entity schema）、
 *   也没被踢。所以"用协议包挂载"这条路在 1.21.8 上是不通的。
 *
 *   但实测找到能用的做法：
 *     上船：`/ride <玩家> mount <载具>`（服务端命令）→ bot.vehicle 有值
 *     开船：`bot.setControlState('forward', true)`
 *   注意 `bot.moveVehicle(0,1)` **无效**（位移 0.00），别用它。
 *
 * ⚠ 上船依赖 `/ride` 命令，**需要 op**。没有权限就如实报 NO_PERMISSION，
 *   不要假装能坐船。
 *
 * ★★ 2026-10-29 实测边界（**关键：载具不能浮在水里**）★★
 *
 *   对照实验（同一套 `/ride` 命令，逐一改变条件）：
 *     | 载具位置 | 她上船时的状态 | 结果 |
 *     |---|---|---|
 *     | 船在**干地**上 | 站陆地 | ✅ 稳定（服务端持续确认在骑 2.4s+） |
 *     | 矿车在**铁轨**上 | 站陆地 | ✅ 稳定 |
 *     | 船**浮在水面** | 站岸上（inWater=false） | ❌ **秒弹** |
 *     | 船**浮在水面** | 泡在水里（inWater=true） | ❌ **秒弹（29~45ms）** |
 *
 *   **结论：不是"人在水里"的锅，是"载具浮在水面上"时服务端不让她骑。**
 *   站岸上、脚下实心、inWater=false 时，船在水里照样秒弹。
 *
 *   秒弹的表现：服务端先发 `set_passengers {passengers:[她]}`（挂上），
 *   紧接着 `set_passengers {passengers:[]}`（卸下），中间只隔 29~45 毫秒。
 *
 *   这意味着：**用船渡水的路线在 Paper 1.21.8 上走不通。**
 *   能用的是"干地上的载具"（矿车在铁轨上、船搁浅在陆地）。
 *   渡水请用 `executor.walkTo`（她能浮在水面走，实测跨湖 0 次失败）。
 *
 *   `boardVehicle()` 现在会把这个情况单独报成 `RIDE_FAILED` 并说明原因，
 *   不会混成"没权限"。
 *
 * ⚠ 还有一个 mineflayer 的坑（至今未修的 PR #4093）：
 *   `set_passengers` 收到**空乘客列表**时，mineflayer 不会清 `bot.vehicle`
 *   （它只在 `passengers.includes(bot.entity.id)` 时才处理）。
 *   于是"服务端已经把她卸下、客户端还以为在骑"。
 *   所以判断是否真在骑，**要问服务端，不能只信 `bot.vehicle`**。
 */
import { ok, fail } from './atom_contract.js';

/** 载具名。1.19+ 船按木头分（oak_boat / spruce_boat …），另有 raft 变体和矿车。 */
const VEHICLE_RE = /(_boat|_raft|minecart)$/;

/** 找载具的搜索半径（格）。太远就没意义，走近再说。 */
const SEARCH_R = 10;

/** 等服务器把她放上载具的时间。服务器要在下一个 tick 才回 set_passengers。 */
const RIDE_WAIT_MS = 4000;

/** 开船时每个控制周期的长度（毫秒）。 */
const DRIVE_TICK_MS = 400;

/** 判定"卡住"的时间窗与位移阈值。 */
const STALL_MS = 5000;
const STALL_DIST = 0.5;

/** 到目标点的默认容差（格）。 */
const DEFAULT_TOL = 2.5;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 这个名字是不是载具。 */
export function isVehicleName(name) {
    return !!name && VEHICLE_RE.test(String(name));
}

/**
 * 找一个可骑的载具（只读）。
 *
 * ⚠ **必须按位置+距离筛，不能取 `Object.values(bot.entities)[0]`。**
 * 实测教训：`kill @e[type=oak_boat]` 之后，客户端实体列表里**还留着旧船**，
 * 早期测试按下标取到了几条之前测试遗留的实体，`/ride` 和 `use_entity` 打过去
 * 自然毫无反应 —— 这个假象让我误判了好几轮"挂载不通"。
 *
 * @param {object} bot
 * @param {{radius?:number, name?:string}} opts
 * @returns {{ok:true, vehicle:object, dist:number} | {ok:false, code:string, why:string}}
 */
export function findVehicle(bot, opts = {}) {
    const { radius = SEARCH_R, name = null } = opts;
    const me = bot.entity?.position;
    if (!me) return { ok: false, code: 'NO_TARGET', why: '读不到自己的位置' };

    let best = null, bestD = Infinity;
    for (const e of Object.values(bot.entities ?? {})) {
        if (!e || !e.position) continue;
        if (name ? e.name !== name : !isVehicleName(e.name)) continue;
        // 位置必须是有效数字（残留实体的坐标有时是 undefined）
        if (![e.position.x, e.position.y, e.position.z].every(Number.isFinite)) continue;
        const d = Math.hypot(e.position.x - me.x, e.position.z - me.z);
        if (d > radius) continue;
        if (d < bestD) { bestD = d; best = e; }
    }
    if (!best) {
        return { ok: false, code: 'NO_VEHICLE', why: `${radius} 格内没有可骑的船/矿车` };
    }
    return { ok: true, vehicle: best, dist: bestD };
}

/** 客户端视角：她以为自己在骑。**不可全信**，见下面 isReallyRiding。 */
export function isRiding(bot) {
    return !!bot.vehicle;
}

/**
 * 服务端视角：她是不是真在骑。
 *
 * 为什么要这个：mineflayer 4.39.0 的 `set_passengers` 处理有 bug ——
 * 服务端卸载时发的是 `{ entityId: 船id, passengers: [] }`（空列表），
 * 而 mineflayer 只在 `passengers.includes(bot.entity.id)` 时才更新 `bot.vehicle`
 * （见 node_modules/mineflayer/lib/plugins/entities.js 第 793 行）。
 * 空列表里当然没有她 → 整个 if 被跳过 → `bot.vehicle` 永远留在那儿。
 *
 * 这正是 [PR #4093](https://github.com/PrismarineJS/mineflayer/pull/4093)
 * 「Dismount by holding sneak like vanilla」里写的：
 * 「the bot also now notices a dismount announced as the vehicle's new passenger
 *   list (set_passengers without the bot)」—— 该 PR 至今未合并。
 *
 * 所以：`bot.vehicle` 有值时不能直接当成"在骑"。这个函数做一个**独立判断**：
 * 若 `bot.vehicle` 存在但最近收到过"它没载我"的包，就当没在骑。
 *
 * @param {object} bot
 * @returns {boolean}
 */
export function isReallyRiding(bot) {
    if (!bot.vehicle) return false;
    if (bot.__boatDismounted) return false;
    return true;
}

/**
 * 上载具。
 *
 * 走 `/ride <玩家> mount <载具>` —— 这是实测在 Paper 1.21.8 上**唯一有效**的办法。
 * 协议包（use_entity / bot.mount）在这版服务端被静默忽略，见文件头说明。
 *
 * @param {object} bot
 * @param {{radius?:number, onEvent?:Function}} opts
 * @returns {Promise<ActionResult>} data: { vehicle, name }
 */
export async function boardVehicle(bot, opts = {}) {
    const { radius = SEARCH_R, onEvent = () => { } } = opts;
    if (bot.interrupt_code) return fail('INTERRUPTED', '被取消了');
    if (isRiding(bot)) {
        return ok({ vehicle: bot.vehicle, name: bot.vehicle?.name ?? '?', already: true });
    }

    const found = findVehicle(bot, { radius });
    if (!found.ok) {
        onEvent({ type: 'board-no-vehicle', code: found.code, why: found.why });
        return fail(found.code, found.why);
    }
    const v = found.vehicle;
    onEvent({ type: 'board-found', name: v.name, dist: +found.dist.toFixed(1) });

    // 先走近一点：`/ride` 的 selector 带 distance 上限，太远选不中
    const me = bot.entity.position;
    const d = Math.hypot(v.position.x - me.x, v.position.z - me.z);
    if (d > 4) {
        // 直接朝船挪过去（水里她本来就能浮着走）
        const yaw = Math.atan2(-(v.position.x - me.x), -(v.position.z - me.z));
        try { await bot.look(yaw, 0, true); } catch { /* ignore */ }
        try { bot.setControlState('forward', true); } catch { /* ignore */ }
        const t0 = Date.now();
        while (Date.now() - t0 < 6000) {
            await sleep(200);
            const p = bot.entity.position;
            if (Math.hypot(v.position.x - p.x, v.position.z - p.z) <= 3) break;
        }
        try { bot.setControlState('forward', false); } catch { /* ignore */ }
        await sleep(150);
    }

    // 发 /ride。用一个短窗口抓服务端的报错信息（无权限时会给提示）。
    let serverMsg = '';
    const grab = (msg) => { serverMsg += String(msg ?? '') + ' '; };
    try { bot.on('messagestr', grab); } catch { /* ignore */ }

    // 装一个"服务端把我卸下了"的监听。
    // mineflayer 自己不会处理空乘客列表（见 isReallyRiding 的说明），
    // 我们自己补：收到 `{entityId: <我骑的船>, passengers: []}` 就认定已下船。
    bot.__boatDismounted = false;
    if (bot.__boatWatch) { try { bot._client.off('set_passengers', bot.__boatWatch); } catch { /* ignore */ } }
    bot.__boatWatch = ({ entityId, passengers }) => {
        const myId = bot.entity?.id;
        if (!bot.vehicle) return;
        if (entityId === bot.vehicle.id && !passengers.includes(myId)) {
            bot.__boatDismounted = true;
            bot.vehicle = null;          // 补上 mineflayer 漏掉的那步
        }
    };
    try { bot._client.on('set_passengers', bot.__boatWatch); } catch { /* ignore */ }

    const sel = `@e[type=minecraft:${String(v.name).replace(/^minecraft:/, '')},limit=1,sort=nearest,distance=..8]`;
    bot.chat(`/ride ${bot.username} mount ${sel}`);

    const t0 = Date.now();
    while (Date.now() - t0 < RIDE_WAIT_MS) {
        await sleep(150);
        if (isReallyRiding(bot)) break;
    }
    try { bot.off('messagestr', grab); } catch { /* ignore */ }

    if (isReallyRiding(bot)) {
        onEvent({ type: 'board-ok', name: bot.vehicle?.name ?? v.name });
        return ok({ vehicle: bot.vehicle, name: bot.vehicle?.name ?? v.name });
    }

    // 挂上又被秒弹（典型：她在水里/船上没位置）—— 单独报，别混成"没权限"
    if (bot.__boatDismounted) {
        return fail('RIDE_FAILED',
            '服务器把我放上去又立刻卸下来了（常见原因：人不在实心地面上，或载具卡住）');
    }

    // 没上去：区分"没权限"和"命令生效了但服务器没让她坐"
    const m = serverMsg.toLowerCase();
    if (/unknown command|no permission|not allowed|没有权限|未知的命令|权限/.test(m)) {
        return fail('NO_PERMISSION',
            `/ride 被拒绝了（需要 op 权限）：${serverMsg.trim().slice(0, 80)}`);
    }
    return fail('RIDE_FAILED',
        `发了 /ride 但服务器没让她上船${serverMsg.trim() ? `（服务端：${serverMsg.trim().slice(0, 60)}）` : ''}`);
}

/**
 * 设载具的操控状态。
 *
 * 实测：骑上之后 **`setControlState('forward')` 有效**（前进 5.65 格），
 * 而 `bot.moveVehicle(0,1)` **无效**（位移 0.00）。所以用前者。
 *
 * @param {object} bot
 * @param {{forward?:number, left?:number, back?:boolean}} ctrl
 */
export function setDrive(bot, ctrl = {}) {
    const { forward = 0, left = 0 } = ctrl;
    try { bot.setControlState('forward', forward > 0); } catch { /* ignore */ }
    try { bot.setControlState('back', forward < 0); } catch { /* ignore */ }
    try { bot.setControlState('left', left > 0); } catch { /* ignore */ }
    try { bot.setControlState('right', left < 0); } catch { /* ignore */ }
}

/** 松开所有驾驶键。 */
export function stopDrive(bot) {
    for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sneak']) {
        try { bot.setControlState(k, false); } catch { /* ignore */ }
    }
}

/**
 * 开着船到她指定的水平位置。
 *
 * 转向靠 `bot.look(yaw)`（骑乘时载具朝向跟随乘客视线），
 * 推进靠 `setControlState('forward')`。
 *
 * @param {object} bot
 * @param {{x:number, z:number}} dest
 * @param {{tol?:number, deadlineMs?:number, onEvent?:Function}} opts
 * @returns {Promise<ActionResult>} data: { from, to, dist }
 */
export async function driveTo(bot, dest, opts = {}) {
    const { tol = DEFAULT_TOL, deadlineMs = 60000, onEvent = () => { } } = opts;
    if (!Number.isFinite(dest?.x) || !Number.isFinite(dest?.z)) {
        return fail('NO_TARGET', '目标水平位置无效');
    }
    if (!isReallyRiding(bot)) return fail('NOT_MOUNTED', '我还没上船，开不了');
    if (bot.interrupt_code) return fail('INTERRUPTED', '被取消了');

    const start = bot.entity.position.clone();
    const t0 = Date.now();
    let stallAt = start.clone();
    let stallT = Date.now();
    let lastDist = Infinity;

    onEvent({ type: 'drive-start', dest, from: { x: +start.x.toFixed(1), z: +start.z.toFixed(1) } });

    while (Date.now() - t0 < deadlineMs) {
        if (bot.interrupt_code) { stopDrive(bot); return fail('INTERRUPTED', '被取消了'); }
        if (!isReallyRiding(bot)) { stopDrive(bot); return fail('NOT_MOUNTED', '中途掉下船了'); }

        const p = bot.entity.position;
        const dist = Math.hypot(dest.x - p.x, dest.z - p.z);
        if (dist <= tol) {
            stopDrive(bot);
            onEvent({ type: 'drive-arrived', dist: +dist.toFixed(1) });
            return ok({
                from: { x: +start.x.toFixed(1), z: +start.z.toFixed(1) },
                to: { x: +p.x.toFixed(1), z: +p.z.toFixed(1) },
                dist: +dist.toFixed(1),
                costMs: Date.now() - t0,
            });
        }

        // 卡住检测：一段时间内几乎没动 → 如实报（可能是搁浅/在陆地上）
        if (Date.now() - stallT > STALL_MS) {
            const moved = Math.hypot(p.x - stallAt.x, p.z - stallAt.z);
            if (moved < STALL_DIST) {
                stopDrive(bot);
                return fail('DRIVE_FAILED',
                    `船动不了（${Math.round(STALL_MS / 1000)} 秒只挪了 ${moved.toFixed(1)} 格，还差 ${dist.toFixed(0)} 格）`,
                    { moved: +moved.toFixed(2), distRemaining: +dist.toFixed(1) });
            }
            stallAt = p.clone();
            stallT = Date.now();
        }

        // 转向 + 推进
        const yaw = Math.atan2(-(dest.x - p.x), -(dest.z - p.z));
        try { await bot.look(yaw, 0, true); } catch { /* ignore */ }
        setDrive(bot, { forward: 1 });
        lastDist = dist;
        await sleep(DRIVE_TICK_MS);
    }

    stopDrive(bot);
    return fail('TIMEOUT', `时间到，还差 ${lastDist.toFixed(0)} 格`, { distRemaining: +lastDist.toFixed(1) });
}

/**
 * 下载具。
 *
 * 先试原生的 `bot.dismount()`；不成就走 `/ride <玩家> dismount`。
 * （实测原生 dismount 在 1.21.8 上不一定生效 —— PR #4093 就是在修这个。）
 *
 * @param {object} bot
 * @param {{onEvent?:Function}} opts
 * @returns {Promise<ActionResult>} data: { at }
 */
export async function leaveVehicle(bot, opts = {}) {
    const { onEvent = () => { } } = opts;
    if (!isReallyRiding(bot)) return ok({ at: bot.entity.position.clone(), already: true });

    stopDrive(bot);

    // ★ 2026-10-29 实测：**按住 sneak 才是原版的下载具方式，bot.dismount() 无效**。
    //
    // 查 mineflayer 4.39.0 的 `dismount()`：它发的是 `player_input { jump: true }`。
    // 但服务端的 `Player.rideTick` → `wantsToStopRiding` 看的是**潜行键**，
    // jump 位在这里根本不读 —— 这正是
    // [PR #4093](https://github.com/PrismarineJS/mineflayer/pull/4093)
    // 「Dismount by holding sneak like vanilla」要修的东西（至今仍 open）。
    //
    // 实测：上船后调用 bot.dismount() 静默无效，bot.vehicle 一直是那艘船。
    try { bot.setControlState('sneak', true); } catch { /* ignore */ }
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) {
        await sleep(150);
        if (!isRiding(bot)) break;
    }
    try { bot.setControlState('sneak', false); } catch { /* ignore */ }
    if (!isRiding(bot)) {
        onEvent({ type: 'leave-ok', by: 'sneak' });
        return ok({ at: bot.entity.position.clone() });
    }

    // 再试原生（对某些版本/载具有效）
    try { bot.dismount(); } catch { /* ignore */ }
    const t1 = Date.now();
    while (Date.now() - t1 < 1500) {
        await sleep(150);
        if (!isRiding(bot)) {
            onEvent({ type: 'leave-ok', by: 'dismount' });
            return ok({ at: bot.entity.position.clone() });
        }
    }

    // 最后兜底：服务端命令
    bot.chat(`/ride ${bot.username} dismount`);
    const t2 = Date.now();
    while (Date.now() - t2 < 2500) {
        await sleep(150);
        if (!isRiding(bot)) {
            onEvent({ type: 'leave-ok', by: 'ride-dismount' });
            return ok({ at: bot.entity.position.clone() });
        }
    }

    return fail('NOT_MOUNTED', '下不来（dismount 和 /ride dismount 都没生效）');
}
