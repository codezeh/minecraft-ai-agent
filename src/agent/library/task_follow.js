/**
 * 跟随 / 找人。
 *
 * 关于「看不见玩家」（2026-10-24 修正）：
 *   玩家的实体只在客户端跟踪范围（约 48 格）内存在，超出后 `bot.players[name].entity` 是 null。
 *   但**服务端一直知道坐标**，可以用 RCON 查到（`atom_query.queryPlayerExact`）。
 *   所以「看不见」不等于「不知道在哪」——这正是之前只会在原地转圈的原因。
 *
 * 三层策略：
 *   1) RCON 查得到精确位置 → 直接走过去（任意距离可用）
 *   2) RCON 不可用 → 用最后可见位置（带年龄，太旧就如实说）
 *   3) 完全没有线索 → 如实说，并问玩家在哪
 *
 * PlayerTracker / 四态判定已上提到 atom_query.js，本文件只负责"跟"这个动作。
 */
import pf from 'mineflayer-pathfinder';
import { moveTo, stopMove, makeMovements } from './atom_move.js';
import { ok, fail } from './atom_contract.js';
import { pauseGoalModes, restoreGoalModes } from './task_modes.js';
import Vec3 from 'vec3';
import { PlayerTracker, ensureTracking, query, queryPlayerExact } from './atom_query.js';
import { ensureScaffold, countScaffold } from './tool_prep.js';

export { PlayerTracker, ensureTracking };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// mode 互斥统一在 task_modes.js（跟随/采集/放置共用一份，见方案 §9）。

function horizontalDist(bot, pos) {
    const p = bot.entity.position;
    return Math.hypot(p.x - pos.x, p.z - pos.z);
}

/**
 * 解析目标：可见 / 只剩记忆 / 离线 / 完全没有线索。
 *
 * 判定逻辑已移到 atom_query（四态语义只有一份），这里只做形状转换：
 * 原调用方用的是 {kind, ent, pos}，原子返回的是信封 + visibility。
 *
 * @returns {{kind:'visible',ent,pos} | {kind:'recalled',pos} | {kind:'offline'} | {kind:'lost'}}
 */
export function resolveTarget(bot, name, tracker) {
    const r = query(bot, { kind: 'player', name }, { tracker });
    const vis = r.data?.visibility;
    if (vis === 'visible') {
        return { kind: 'visible', ent: bot.players?.[name]?.entity ?? null, pos: r.data.entityPos };
    }
    if (vis === 'recalled') {
        return { kind: 'recalled', pos: r.data.entityPos };
    }
    if (vis === 'offline') return { kind: 'offline' };
    if (vis === 'lost') return { kind: 'lost' };
    // 原子因「自己坐标 NaN」等内部原因失败时，保守当作 lost
    return { kind: 'lost' };
}

/**
 * 持续跟随，直到被打断 / 超时 / 找不到人。
 * @param {object} opts
 *   distance   保持距离，默认 3
 *   timeoutMs  -1 表示一直跟
 *   onEvent    事件回调：following / searching / found_nothing / offline / lost / interrupted
 */
export async function follow(bot, name, opts = {}) {
    const {
        distance = 3, timeoutMs = -1, onEvent = () => {},
        tracker = ensureTracking(bot), lostGraceMs = 3000,
        mapDir = null,     // 传了就用跳格做「远距离接近」
    } = opts;

    if (!bot.players?.[name]) {
        onEvent({ type: 'offline' });
        return fail('NO_TARGET', `你不在服务器里（${name}）`);
    }

    const t0 = Date.now();
    let goalEntity = null;
    let lastVisibleAt = Date.now();

    // 临时诊断（定位「连续两条跟随即 INTERRUPTED」）：进入时立刻记下中断标志与谁在跑。
    if (bot.interrupt_code) {
        console.log(`[follow-diag] 进入时 interrupt_code=true，action=${this?.name ?? '?'}`);
        bot.interrupt_code = false;   // 旧动作遗留的标志不该杀新任务
    }

    bot.pathfinder.setMovements(makeMovements(bot));
    const pausedBefore = pauseGoalModes(bot);

    try {
        // 远距离先「跳格」接近一次：GoalFollow 是持续追踪，几十格外它会一直重设
        // goal 追不上（实测跟丢）。先用长规划 + 短规划把距离压到 24 格内，
        // 之后的贴身跟随才交给 GoalFollow。
        // 只在开头试一次，不放进循环 —— 玩家在动，循环里反复规划会更慢。
        if (mapDir) {
            const ent = bot.players?.[name]?.entity;
            if (ent) {
                const d0 = bot.entity.position.distanceTo(ent.position);
                if (d0 > 40) {
                    onEvent({ type: 'hop_start', dist: Math.round(d0) });
                    try {
                        const { hopTo } = await import('./task_hop.js');
                        const hr = await hopTo(bot, { x: ent.position.x, z: ent.position.z },
                            { mapDir, onEvent: (e) => onEvent({ type: 'hop_' + e.type, ...e }) });
                        onEvent({ type: 'hop_done', code: hr.code, dist: Math.round(bot.entity.position.distanceTo(ent.position)) });
                    } catch (e) {
                        onEvent({ type: 'hop_error', message: String(e?.message ?? e).slice(0, 80) });
                    }
                }
            }
        }

        while (!bot.interrupt_code) {
            if (timeoutMs > 0 && Date.now() - t0 > timeoutMs) {
                return ok({ reason: 'timeout', costMs: Date.now() - t0 });
            }

            const target = resolveTarget(bot, name, tracker);

            if (target.kind === 'visible') {
                lastVisibleAt = Date.now();
                tracker.remember(name, target.pos, bot.game.dimension);

                const otherDim = target.ent.dimension && target.ent.dimension !== bot.game.dimension;
                if (otherDim) {
                    onEvent({ type: 'wrong_dimension', dim: target.ent.dimension });
                    return fail('NO_PATH', `你在另一个世界（${target.ent.dimension}），我过不去`);
                }

                if (goalEntity !== target.ent) {
                    bot.pathfinder.setGoal(new pf.goals.GoalFollow(target.ent, distance), true);
                    goalEntity = target.ent;
                    onEvent({ type: 'following', dist: horizontalDist(bot, target.pos) });
                }
            } else if (target.kind === 'offline') {
                onEvent({ type: 'offline' });
                return fail('NO_TARGET', '你不在服务器里了');
            } else {
                // 看不到人：先别放弃 —— RCON 能拿到任意距离的精确位置（2026-10-24）
                if (Date.now() - lastVisibleAt < lostGraceMs) {
                    await sleep(250);
                    continue;   // 可能是瞬移/区块重载，给几秒缓冲
                }

                try { bot.pathfinder.setGoal(null); bot.pathfinder.stop(); } catch { /* ignore */ }
                goalEntity = null;

                const q = await queryPlayerExact(bot, { kind: 'player', name }, { tracker });
                const vis = q.data?.visibility;

                if (vis === 'offline') {
                    onEvent({ type: 'offline' });
                    return fail('NO_TARGET', '你不在服务器里了');
                }

                if (!q.ok || vis === 'lost') {
                    onEvent({ type: 'lost' });
                    return fail('NO_TARGET', '我找不到你，你在哪？说个方向我去找你');
                }

                // recalled 或 rcon：都有坐标，走过去（可能是你最后在的地方，也可能是服务端给的精确位置）
                onEvent({ type: 'searching', pos: q.data.entityPos, source: q.data.source });
                const r = await moveTo(bot, { kind: 'point', pos: q.data.entityPos }, { tol: 2, timeout: 45000 });
                if (r.code === 'INTERRUPTED') {
                    onEvent({ type: 'interrupted' });
                    return r;
                }
                if (bot.players?.[name]?.entity) continue;   // 路上撞见了
                // 到了还是看不到人，再查一次：可能又走远了
                const q2 = await queryPlayerExact(bot, { kind: 'player', name }, { tracker });
                if (q2.ok && q2.data.visibility === 'visible' && q2.data.source === 'rcon') {
                    continue;   // 服务端还知道位置，继续追
                }
                onEvent({ type: 'found_nothing', pos: q.data.entityPos });
                return fail('NO_TARGET', '我到了你最后在的地方，但没看到你');
            }

            await sleep(250);
        }
        onEvent({ type: 'interrupted' });
        return fail('INTERRUPTED', '不跟了');
    } finally {
        restoreGoalModes(bot, pausedBefore);
        try {
            bot.pathfinder.setGoal(null);
            bot.pathfinder.stop();
        } catch { /* ignore */ }
    }
}

/**
 * 走过去找人（一次性）。可见时校验水平/高度，不可见时用最后位置。
 */
export async function goToPlayer(bot, name, opts = {}) {
    const { distance = 3, tracker = ensureTracking(bot), onEvent = () => {}, mapDir = null, hopThreshold = 40 } = opts;

    if (bot.username === name) return ok({ distFeetToEntity: 0 });

    // ---- 先用 RCON 查一次真实坐标，再决定用哪套走法 ----
    //
    // 之前这里用 `bot.players[name].entity` 判距离，但那是**客户端实体**：
    // 超出跟踪范围（约 48 格）就被 entity_destroy 掉，`ent0` 变成 null。
    // 后果（2026-10-26 真机实测）：
    //   - 你和她相距 115 格 → ent0 为 null → **hopTo 压根不触发**，长规划白写
    //   - 然后退到下面那个 45 秒的 moveTo，必然走不完 → 报「我找不到你」（文案还是错的）
    // 所以必须先查坐标（RCON 任意距离都准），拿真实距离决定走法。
    const q0 = await queryPlayerExact(bot, { kind: 'player', name }, { tracker });
    if (!q0.ok) {
        if (q0.data?.visibility === 'offline') {
            onEvent({ type: 'offline' });
            return fail('NO_TARGET', `你不在服务器里（${name}）`);
        }
        onEvent({ type: 'lost' });
        return fail('NO_TARGET', `我找不到你，你在哪？（${q0.message || q0.code}）`);
    }

    const known = q0.data.entityPos;
    const d0 = Math.hypot(bot.entity.position.x - known.x, bot.entity.position.z - known.z);

    // 长距离先走 hopTo（长规划 + 短规划：能游泳、能挖穿）。
    console.log(`[goToPlayer] 距 ${d0.toFixed(0)} 格（阈值 ${hopThreshold}），mapDir=${mapDir ? '有' : '无'}`);
    if (mapDir && d0 > hopThreshold) {
        onEvent({ type: 'hop_start', dist: Math.round(d0) });
        console.log(`[goToPlayer] 进入 hopTo，目标 (${known.x.toFixed(0)},${known.z.toFixed(0)})`);
        try {
            const { hopTo } = await import('./task_hop.js');
            const hr = await hopTo(bot, { x: known.x, z: known.z },
                { mapDir, onEvent: (e) => onEvent({ type: 'hop_' + e.type, ...e }) });
            console.log(`[goToPlayer] hopTo 返回 code=${hr.code} message=${hr.message ?? ''}`);
            onEvent({
                type: 'hop_done', code: hr.code,
                dist: Math.round(Math.hypot(bot.entity.position.x - known.x, bot.entity.position.z - known.z)),
            });
            if (bot.interrupt_code) return fail('INTERRUPTED', '停了');
        } catch (e) {
            // 这行必须有：之前只发 onEvent，异常被静默吞掉，
            // 日志里连一个 hop-* 事件都看不到，导致排了半天以为没进这条分支。
            console.log(`[goToPlayer] hopTo 抛异常: ${e?.stack ?? e?.message ?? e}`);
            onEvent({ type: 'hop_error', message: String(e?.message ?? e).slice(0, 80) });
        }
    }

    let lastGap = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        // 用 queryPlayerExact：RCON 优先，任意距离都能定位（不再局限于 48 格）
        const q = await queryPlayerExact(bot, { kind: 'player', name }, { tracker });
        const vis = q.data?.visibility;

        if (vis === 'offline') {
            onEvent({ type: 'offline' });
            return fail('NO_TARGET', `你不在服务器里（${name}）`);
        }
        if (!q.ok || vis === 'lost') {
            onEvent({ type: 'lost' });
            return fail('NO_TARGET', '我找不到你，你在哪？');
        }

        const targetPos = q.data.entityPos;
        // 分两档走：
        //   第 1 档：不许挖、不许搭（不破坏地形，绝大多数场景够用）
        //   第 2 档：允许挖 + 搭方块（2026-10-26 加）
        //
        // 为什么必须加第 2 档：真机实测她**被困在地下 y=63**，
        // 而她周围 9×9 的地表在 y=79~83（比她高 16~20 格）。
        // 只靠"找现成的路"，洞里的 pathfinder 一步也走不出去 →
        // 一轮又一轮报 NO_REACH「我走到离你 120 格就过不去了」，而她其实在原地没动。
        // 用户早就说过「到不了目标高度的可以试试搭方块上去，这是最后的规划」。
        // 第 2 档开始前，先保证**有方块可搭**。
        //
        // 死结（2026-10-26 真机实测）：她背包只有一把铁镐、一块可放方块都没有，
        // 于是 allow1by1towers 被正确关掉 → 第二档的"搭"完全失效 → 永远出不来。
        // 而她掉进 y=63 的地下、四周地表 y=79~83，只靠挖开不出向上的通道。
        // 所以"搭方块"必须先配"没方块就去挖"（用户说的最后一道规划）。
        // 下面这些 console.log 是**诊断用**的（2026-10-26）：
        // 她的日志只打印 "Agent executed: ..."，onEvent 发出去的事件看不到，
        // 于是"到底有没有执行自救"只能靠猜 —— 实测为此浪费了两轮。
        // 事件本身保留（给上层/面板用），日志只多一行。
        if (attempt > 1) {
            try {
                console.log(`[goToPlayer] 第 ${attempt} 档：先备垫脚方块（当前背包 ${countScaffold(bot)} 个）`);
                const sc = await ensureScaffold(bot, { need: 8, onEvent });
                console.log(`[goToPlayer] 备料结果：ok=${sc.ok} 现有=${sc.have} 新挖=${sc.got} —— ${sc.why}`);
                onEvent({ type: 'scaffold-prep', ok: sc.ok, have: sc.have, count: sc.got, why: sc.why });
                if (!sc.ok) {
                    onEvent({ type: 'scaffold-short', why: sc.why });
                }
            } catch (e) {
                console.log(`[goToPlayer] 备料异常：${String(e?.message ?? e).slice(0, 120)}`);
                onEvent({ type: 'scaffold-error', message: String(e?.message ?? e).slice(0, 80) });
            }
            console.log(`[goToPlayer] 第 ${attempt} 档：允许挖+搭，目标 (${targetPos.x.toFixed(0)},${targetPos.y.toFixed(0)},${targetPos.z.toFixed(0)})，我在 y=${bot.entity.position.y.toFixed(0)}`);
        }

        const r = await moveTo(bot, { kind: 'point', pos: targetPos },
            { tol: Math.max(distance, 1), canDig: attempt > 1, scaffold: attempt > 1 });
        if (r.code === 'INTERRUPTED') return r;
        onEvent({ type: 'moved', attempt, code: r.code ?? 'OK', tier: attempt > 1 ? 'dig+scaffold' : 'walk' });

        // ---- 被困住时的复合层自救（2026-10-27，用户指出的正确做法）----
        //
        // 用户原话：「我不是设的原子技能吗，直接困住就调用复合层能力不就好了？」
        // 我之前一直调 pathfinder 参数，指望它自己挖上去 —— 那是自造轮子。
        // 现在：走不动（STUCK / NO_PATH / NO_REACH）就先调 skill_escape 挖上去，
        // 上去之后再正常走。它完全由 digBlock / placeBlockAt / moveTo / equipItem 组合而成。
        const stuck = !r.ok && ['STUCK', 'NO_PATH', 'NO_REACH', 'TIMEOUT'].includes(r.code);
        if (stuck && attempt >= 1) {
            try {
                const yBefore = bot.entity.position.y;
                // ★ 2026-10-27 第九次修：判据从「头顶有没有遮挡」换成「洪泛能走多远」。
                //
                // 前两次判据都错在"看单点"：
                //   第七次：从 yBefore+64 往下扫第一个实心当"地表" → 扫到的是她头顶的天花板
                //   第八次：头顶 24 格有实心才算被困 → **大溶洞里头顶也是无遮挡的**
                //          实测日志：「我在 y=50，头顶 24 格无遮挡 —— 没被困，跳过自救」
                //          但她其实在一个走不出去的洞穴里，5 轮 0 位移。
                //
                // 真正的判据只有一个：**从这个位置出发，水平方向能到达多远？**
                // 用有限步数的洪泛（4 方向 + 上下 1 格），看最远能离起点多少格。
                // 走不出 20 格 = 被围住了，该往上挖。
                // 代价：最多扩 1500 格位，实测几毫秒，只在"已经走不动"时才跑。
                const walkable = (x, y, z) => {
                    try {
                        const feet = bot.blockAt(new Vec3(x, y, z));
                        const head = bot.blockAt(new Vec3(x, y + 1, z));
                        const below = bot.blockAt(new Vec3(x, y - 1, z));
                        if (!feet || !head || !below) return false;
                        const airOk = (b) => ['air', 'cave_air', 'void_air'].includes(b.name);
                        if (!airOk(feet) || !airOk(head)) return false;
                        // 脚下要有支撑（水/岩浆不算）
                        if (airOk(below) || below.name === 'water' || below.name === 'lava') return false;
                        return true;
                    } catch { return false; }
                };

                const px = Math.floor(bot.entity.position.x);
                const pz = Math.floor(bot.entity.position.z);
                const py = Math.floor(yBefore);

                let reach = 0;
                const seen = new Set([`${px},${py},${pz}`]);
                {
                    const queue = [{ x: px, y: py, z: pz }];
                    let steps = 0;
                    while (queue.length && seen.size < 1500 && steps < 6000) {
                        const c = queue.shift();
                        steps++;
                        const d = Math.hypot(c.x - px, c.z - pz);
                        if (d > reach) reach = d;
                        for (const [dx, dz, dy] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
                            const nx = c.x + dx, ny = c.y + dy, nz = c.z + dz;
                            const k = `${nx},${ny},${nz}`;
                            if (seen.has(k)) continue;
                            if (!walkable(nx, ny, nz)) continue;
                            seen.add(k);
                            queue.push({ x: nx, y: ny, z: nz });
                        }
                    }
                }

                // ★ 2026-10-27 第十五次修：找的是**地表**，不是"头顶第一格实心"。
                //
                // 实测：她在 y=58，头顶 59 空、60~67 是 stone、68~70 是土/草、71 草、72+ 天空。
                // 旧代码把"头顶第一个实心"= y=60 当成天花板，于是 goalY = 62，
                // 挖 2 层就"到目标高度"停下 —— 她永远只挖 4 格就停，然后重新判困，死循环。
                //
                // 正确：从她往上找**第一段连续 3 格以上的空气**（= 真正的地表/天空），
                // 那才是该挖到的高度。
                let ceilingAt = null;      // 头顶第一个实心（用来判"有没有被盖住"）
                let surfaceY = null;       // 真正的地表高度（连续 3 格空气的第一个）
                try {
                    let airRun = 0;
                    for (let dy = 1; dy <= 96; dy++) {
                        const b = bot.blockAt(new Vec3(px, py + dy, pz));
                        if (!b) break;
                        const isAir = ['air', 'cave_air', 'void_air'].includes(b.name);
                        if (!isAir) {
                            if (ceilingAt == null) ceilingAt = py + dy;
                            airRun = 0;
                        } else {
                            airRun++;
                            if (airRun >= 3 && surfaceY == null) {
                                surfaceY = py + dy - airRun + 1;   // 这段空气的起点
                                break;
                            }
                        }
                    }
                } catch { /* ignore */ }

                // ★ 2026-10-27 第十二次修：判"被困"不能用"水平能走多远"。
                //
                // 实测（她真实处境）：她在一个约 5×7 的封闭小房间里，
                //   洪泛可达 25 格、最远水平距离约 5 格、头顶 y=50~53 是 diorite。
                // 旧判据 `reach < 20` 判的是**最远水平距离**，25 格 > 20 → 判"能走开，不挖"
                // → 她永远不挖 → 永远出不来。
                //
                // 正确判据：**可达面积小 且 头顶有遮挡 = 被困**。
                //   面积小（< 300 格）说明"能去的地方就这么点"
                //   头顶有遮挡说明"上面是封的"
                // 两个条件都满足才是真被困 —— 站在开阔草原上即使面积很大也不会误判。
                // ★ 2026-10-27 第十六次修：判被困**只看可达面积**，不看头顶有没有遮挡。
                //
                // 实测：她挖到 y=68，头顶已经"开阔"了（挖穿了石层），
                // 但可达面积仍然只有 2 格 —— 她还困在 1×1 的竖井里，离地表还差 2 格。
                // 旧判据 `isCapped && area < 300` 因为 isCapped=false 直接返回 false
                // → 判"能走开，不挖" → 她停在离地表 2 格的地方再也不动。
                //
                // 面积才是唯一可靠的判据：能站的地方就这么几格，那就一定是被困，
                // 不管头顶是石头还是天空。
                // ★ 2026-10-27 第十七次修：判被困 = **面积小 且 四周被封**。
                //
                // 只看面积会误判：站在地表一块 3×3 的平台上（面积 9），
                // 上方开阔、四周能跳下去 —— 那不算被困，判成被困就会让她原地往上挖空气。
                // 只看头顶遮挡也会误判：挖穿石层后头顶"开阔"了，但人还在 1×1 竖井里（实测）。
                //
                // 两个都要看：
                //   area 小（< 300）         = 能站的地方就这么点
                //   walled（水平 8 格全堵）  = 没有水平出口
                const area = seen.size;
                const isCapped = ceilingAt != null;
                // 水平方向探一圈：8 格内有没有"能站且比现在不高"的位置（= 有出口）
                let openDirs = 0;
                try {
                    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1],
                                            [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
                        for (let r = 1; r <= 8; r++) {
                            const nx = px + dx * r, nz = pz + dz * r;
                            if (walkable(nx, py, nz) || walkable(nx, py - 1, nz) || walkable(nx, py - 2, nz)) {
                                openDirs++;
                                break;
                            }
                        }
                    }
                } catch { /* 读不到就当封闭 */ }
                const walled = openDirs === 0;
                const trapped = area < 300 && (walled || isCapped);
                // 目标高度：地表之上 2 格；找不到地表就至少往上 12 格
                const goalY = surfaceY != null ? surfaceY + 2 : py + 12;

                console.log(`[goToPlayer] 走不动了（${r.code}）：可达 ${area} 格（最远 ${reach.toFixed(0)} 格）、`
                    + `头顶${isCapped ? 'y=' + ceilingAt + ' 有遮挡' : '开阔'}、地表y=${surfaceY ?? '?'}、出口方向${openDirs}/8 → ${trapped ? '判定被困，往上挖' : '能走开，不挖'}`);
                onEvent({ type: 'stuck_diag', code: r.code, reach: Math.round(reach), ceiling: ceilingAt, trapped });

                if (!trapped) {
                    onEvent({ type: 'escape_skipped', why: 'can_roam', reach: Math.round(reach) });
                } else {
                    console.log(`[goToPlayer] 往上挖到 y=${goalY}`);
                    const { escapeUp } = await import('./skill_escape.js');
                    const esc = await escapeUp(bot, {
                        targetY: goalY,
                        maxBlocks: 40,
                        onEvent: (e) => onEvent({ type: 'escape_' + (e.type ?? ''), ...e }),
                    });
                    const yAfter = bot.entity.position.y;
                    console.log(`[goToPlayer] 自救结果：${esc.ok ? '成功' : esc.code} ${esc.message ?? ''}（y ${yBefore.toFixed(0)} → ${yAfter.toFixed(0)}）`);
                    onEvent({
                        type: 'escape', ok: esc.ok, code: esc.code ?? 'OK',
                        fromY: Math.round(yBefore), toY: Math.round(yAfter),
                        message: esc.message,
                    });
                    if (esc.ok && yAfter > yBefore + 1) {
                        const r2 = await moveTo(bot, { kind: 'point', pos: targetPos },
                            { tol: Math.max(distance, 1), canDig: true, scaffold: true });
                        onEvent({ type: 'moved-after-escape', code: r2.code ?? 'OK' });
                        console.log(`[goToPlayer] 自救后再走：${r2.code ?? 'OK'}`);
                    }
                }
            } catch (e) {
                console.log(`[goToPlayer] 自救异常: ${e?.stack ?? e?.message ?? e}`);
                onEvent({ type: 'escape_error', message: String(e?.message ?? e).slice(0, 100) });
            }
        }

        // 到了之后重新查一次（人可能在动），用最新位置判断"够不够近"
        const q2 = await queryPlayerExact(bot, { kind: 'player', name }, { tracker });
        if (!q2.ok) {
            if (vis === 'recalled') {
                onEvent({ type: 'found_nothing', pos: targetPos });
                return fail('NO_TARGET', '我到了你最后在的地方，但没看到你');
            }
            continue;   // 路上信息断了，重来一次
        }

        const p = bot.entity.position;
        const now = q2.data.entityPos;
        const dxz = Math.hypot(p.x - now.x, p.z - now.z);
        const dy = Math.abs(p.y - now.y);
        if (dxz <= distance + 1.5 && dy <= 1.5) {
            try {
                const ent = bot.players?.[name]?.entity;
                const head = ent?.height ? ent.height * 0.9 : 1.6;
                await bot.lookAt(new Vec3(now.x, now.y + head, now.z), true);
            } catch { /* 看向失败不影响结果 */ }
            return ok({ distFeetToEntity: dxz, dy, source: q2.data.source });
        }

        // 关键区分（2026-10-26）：走到了但还差一段 ≠ 找不到人。
        // 以前这里两轮都失败后统一报「我找不到你」，把「走不过去」说成「不知道你在哪」，
        // 于是她会反复问你要坐标 —— 而坐标一直是查得到的。
        lastGap = { dxz, dy, tried: attempt };
        onEvent({ type: 'retry', dxz, dy, attempt, source: q2.data.source });
    }

    if (lastGap) {
        return fail('NO_REACH',
            `我走到离你 ${lastGap.dxz.toFixed(0)} 格的地方就过不去了（试了 ${lastGap.tried} 次）`,
            { distFeetToTarget: lastGap.dxz, dy: lastGap.dy });
    }
    return fail('NO_TARGET', '我找不到你，你在哪？');
}

export { stopMove };

// ---------------------------------------------------------------------------
// 跟随实体（船 / 动物 / 任何非玩家实体）
// ---------------------------------------------------------------------------

/**
 * 跟随一个**实体**（不是玩家）。
 *
 * 为什么需要（2026-10-28，用户提议：「加一个跟随的动作，但跟随对象是船」）：
 *   船的「骑乘」走不通 —— 实测 mineflayer 4.39 在 1.21.8 下发 use_entity
 *   上不了船（服务端 RootVehicle 始终为空），手写包会被踢。
 *   但**跟着船走**不需要骑乘：船的 y 稳定浮在水面（实测 y=62.0 不动），
 *   她可以直接把船当成一个「浮在水上的路标」接近。
 *
 * 与 follow() 的分工：
 *   follow(bot, name)  → 玩家，位置可能要问 RCON，玩家会动
 *   本函数              → 任意实体，位置直接来自 bot.entities，不走网络
 *
 * @param {object} bot
 * @param {string} entityName 实体名，如 'oak_boat' / 'boat' / 'cow'
 * @param {{distance?:number, timeoutMs?:number, mapDir?:string, onEvent?:Function}} opts
 * @returns {Promise<ActionResult>} code: OK / NO_TARGET / NO_PATH / INTERRUPTED
 */
export async function followEntity(bot, entityName, opts = {}) {
    const {
        distance = 3, timeoutMs = 120000, mapDir = null,
        onEvent = () => {},
    } = opts;

    if (!entityName || typeof entityName !== 'string') {
        return fail('NO_TARGET', '要跟随的实体名不能为空');
    }

    /** 找最近的同名实体。 */
    const findNearest = () => {
        let best = null, bestD = Infinity;
        for (const e of Object.values(bot.entities || {})) {
            if (!e || e === bot.entity) continue;
            if (e.name !== entityName) continue;
            const p = e.position;
            if (!p || !Number.isFinite(p.x)) continue;
            const d = bot.entity.position.distanceTo(p);
            if (d < bestD) { bestD = d; best = e; }
        }
        return best;
    };

    if (bot.interrupt_code) return fail('INTERRUPTED', '被取消了');

    const first = findNearest();
    if (!first) {
        onEvent({ type: 'no_entity', name: entityName });
        return fail('NO_TARGET', `附近没有 ${entityName}`);
    }

    const t0 = Date.now();
    onEvent({ type: 'follow_entity_start', name: entityName, distFeetToEntity: Math.round(bot.entity.position.distanceTo(first.position)) });

    let lastPos = bot.entity.position.clone();

    while (timeoutMs < 0 || Date.now() - t0 < timeoutMs) {
        if (bot.interrupt_code) return fail('INTERRUPTED', '被取消了');

        const ent = findNearest();
        if (!ent) {
            onEvent({ type: 'lost_entity', name: entityName });
            return fail('NO_TARGET', `跟丢了 ${entityName}`, { survivedMs: Date.now() - t0 });
        }

        const d = bot.entity.position.distanceTo(ent.position);
        if (d <= distance + 0.5) {
            onEvent({ type: 'arrived', distFeetToEntity: Math.round(d) });
            // 按项目字段标准：距离必须带参照点（audit_rules 会拦 ok({dist:...})）
            return ok({ distFeetToEntity: d, entityName, elapsedMs: Date.now() - t0 });
        }

        // 用现有的 3D 行走链路接近它（船在水面上，所以是"走到水边/水面"）
        const { walkTo } = await import('./executor.js');
        const r = await walkTo(bot, { x: ent.position.x, z: ent.position.z }, {
            mapDir,
            arriveTol: distance,
            deadlineMs: 45000,
            onEvent: (e) => onEvent({ type: 'walk_' + e.type, ...e }),
        });

        if (r.code === 'INTERRUPTED') return r;

        // 走了一段就重新评估（船可能在漂，也可能已经够近了）
        const after = bot.entity.position;
        const moved = after.distanceTo(lastPos);
        lastPos = after.clone();

        if (r.code === 'OK') continue;                 // 正常，继续贴近
        if (moved < 1.5) {
            // 一步都没靠近：如实失败，不空转
            onEvent({ type: 'stuck', code: r.code, distFeetToEntity: Math.round(d) });
            return fail(r.code === 'NO_PATH' ? 'NO_PATH' : 'NO_REACH',
                `走不到 ${entityName}（还差 ${Math.round(d)} 格）`, { survivedMs: Date.now() - t0 });
        }
    }

    return fail('TIMEOUT', `跟随 ${entityName} 超时`, { survivedMs: Date.now() - t0 });
}
