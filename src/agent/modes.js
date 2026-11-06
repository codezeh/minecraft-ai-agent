import * as skills from './library/skills.js';
import { decideProtect, shouldRelease, PROTECT } from './library/protect_owner.js';
import { attackOnce } from './library/act_attack.js';
import { idleTick } from './library/idle_planner.js';

/** 护主时"放弃过的目标 → 忽略到什么时候"（07 §3.1：30 秒内不再管）。 */
const protectIgnored = new Map();
import * as world from './library/world.js';
import * as mc from '../utils/mcdata.js';
import settings from './settings.js'
import convoManager from './conversation.js';
// 控制层（M2，07 §4）：停的原因 + 被打断的是任务单时不叫模型
import { STOP_REASONS, isJobLabel, noteJobInterrupted } from './library/control.js';
// 输入原子（M2 残项，01 §2）：按键只有这一条路 —— 按下去必有人松
import { holdKey } from './library/atom_input_move.js';

/**
 * 水里"按住跳跃"的保持上限（毫秒）。
 *
 * 为什么要上限：`update()` 每 tick（300ms）看一次，到点后下一 tick 会自己续；
 * 不设上限就是"按下去没人松"——那正是 01 §2 要消灭的残留按键。
 */
const SWIM_JUMP_HOLD_MS = 3000;

/**
 * bot → 正在进行的"保持跳跃"。
 *
 * 存模块作用域而不是挂到 mode 对象 / ModeController 上：
 * 后者对 LLM 生成的代码可达（见本文件 ModeController 的 SECURITY WARNING），
 * 而 Promise 的闭包里握着 `bot` —— 不该让那条路摸到。
 */
const swimHolds = new WeakMap();

/** 头顶那格是不是水（读不到就当作不是）。 */
function waterAbove(bot) {
    try {
        return bot.blockAt(bot.entity.position.offset(0, 1, 0))?.name === 'water';
    } catch {
        return false;
    }
}

/**
 * 在水里按住跳跃（自保：浮上去）。
 *
 * ★ 2026-11-01（M2 残项）：原来这里是裸的 `bot.setControlState('jump', true)` ——
 * 全系统唯一绕开 `atom_input_move` 的按键，而且**按下去没人松**（只在别的分支
 * `clearControlStates()` 时才顺带清掉）。现在走 `holdKey`：
 *   - `until`：出水即松（出事最早收敛）
 *   - `timeout`：SWIM_JUMP_HOLD_MS 到点原子自己松，下一 tick 再续（等价于"一直按着"）
 *   - `interrupt_code`：被中断时原子自己松（A3/A7），不会喊停还在跳
 * **不 await**：`update()` 是每 tick 调一次的热路径，不许在这里阻塞（见文件头注释）。
 * 同一个 bot 同时只允许一个保持（WeakMap 去重），否则每 tick 都会叠一层按下/松开。
 */
export function holdSwimJump(bot) {
    if (!bot || swimHolds.has(bot)) return;
    const p = holdKey(bot, 'jump', {
        until: () => !waterAbove(bot),
        timeout: SWIM_JUMP_HOLD_MS,
    })
        .catch(() => null)   // 原子不抛；保险起见不把异常冒到 tick 循环
        .finally(() => { swimHolds.delete(bot); });
    swimHolds.set(bot, p);
}


/**
 * 行为播报（只是在日志/聊天里说一句）。
 *
 * ★ T32：**不写 `async`** —— 它体内没有 `await`，写成 async 只会让**每个调用点**
 *   都产生一个没人管的 promise（`no-floating-promise` 一次报 12 条就是这个）。
 *   但"不 async"不等于"不管"：`agent.openChat()` 本身是 async 的，
 *   它的 rejection 必须在这里**显式接住**（否则就是 unhandled rejection，Node 会直接崩）。
 */
function say(agent, message) {
    agent.bot.modes.behavior_log += message + '\n';
    if (agent.shut_up || !settings.narrate_behavior) return;
    agent.openChat(message)?.catch?.((e) => {
        console.warn(`[mode] 播报失败（不影响行为本身）：${String(e?.message ?? e)}`);
    });
}

// a mode is a function that is called every tick to respond immediately to the world
// it has the following fields:
// on: whether 'update' is called every tick
// active: whether an action has been triggered by the mode and hasn't yet finished
// paused: whether the mode is paused by another action that overrides the behavior (eg followplayer implements its own self defense)
// update: the function that is called every tick (if on is true)
// when a mode is active, it will trigger an action to be performed but won't wait for it to return output

// the order of this list matters! first modes will be prioritized
// while update functions are async, they should *not* be awaited longer than ~100ms as it will block the update loop
// to perform longer actions, use the execute function which won't block the update loop
const modes_list = [
    {
        name: 'self_preservation',
        description: 'Respond to drowning, burning, and damage at low health. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        fall_blocks: ['sand', 'gravel', 'concrete_powder'], // includes matching substrings like 'sandstone' and 'red_sand'
        update: async function (agent) {
            const bot = agent.bot;
            let block = bot.blockAt(bot.entity.position);
            let blockAbove = bot.blockAt(bot.entity.position.offset(0, 1, 0));
            if (!block) block = {name: 'air'}; // hacky fix when blocks are not loaded
            if (!blockAbove) blockAbove = {name: 'air'};
            if (blockAbove.name === 'water') {
                // does not call execute so does not interrupt other actions
                if (!bot.pathfinder.goal) {
                    // 走 atom_input_move（01 §2 按键唯一出口）；出水/超时/中断都会自己松
                    holdSwimJump(bot);
                }
            }
            else if (this.fall_blocks.some(name => blockAbove.name.includes(name))) {
                fireModeAction(this, agent, async () => {
                    await skills.moveAway(bot, 2);
                });
            }
            else if (block.name === 'lava' || block.name === 'fire' ||
                blockAbove.name === 'lava' || blockAbove.name === 'fire') {
                say(agent, 'I\'m on fire!');
                // if you have a water bucket, use it
                let waterBucket = bot.inventory.findInventoryItem('water_bucket');
                if (waterBucket) {
                    fireModeAction(this, agent, async () => {
                        const success = await skills.placeBlock(bot, 'water_bucket', block.position.x, block.position.y, block.position.z);
                        // ★ 第11条遗留（T32）：这里原来写的是 `if (placed)` ——
                        //   变量名叫 `success`，`placed` **从未声明** → ReferenceError。
                        //   而它被 execute() 的 try/catch 吞成一行 console.warn，
                        //   ⇒ **身上着火时水桶灭火永久静默失效**（最典型的"报错被吞掉"）。
                        if (success) say(agent, 'Placed some water, ahhhh that\'s better!');
                    });
                }
                else {
                    fireModeAction(this, agent, async () => {
                        let waterBucket = bot.inventory.findInventoryItem('water_bucket');
                        if (waterBucket) {
                            const success = await skills.placeBlock(bot, 'water_bucket', block.position.x, block.position.y, block.position.z);
                            // ★ 同上：`placed` → `success`（第11条遗留）
                            if (success) say(agent, 'Placed some water, ahhhh that\'s better!');
                            return;
                        }
                        let nearestWater = world.getNearestBlock(bot, 'water', 20);
                        if (nearestWater) {
                            const pos = nearestWater.position;
                            const success = await skills.goToPosition(bot, pos.x, pos.y, pos.z, 0.2);
                            // ★ 同上：`walked` → `success`（第11条遗留）
                            if (success) say(agent, 'Found some water, ahhhh that\'s better!');
                            return;
                        }
                        await skills.moveAway(bot, 5);
                    });
                }
            }
            else if (Date.now() - bot.lastDamageTime < 3000 && (bot.health < 5 || bot.lastDamageTaken >= bot.health)) {
                say(agent, 'I\'m dying!');
                fireModeAction(this, agent, async () => {
                    await skills.moveAway(bot, 20);
                });
            }
            else if (agent.isIdle()) {
                bot.clearControlStates(); // clear jump if not in danger or doing anything else
            }
        }
    },
    {
        name: 'unstuck',
        description: 'Attempt to get unstuck when in the same place for a while. Interrupts some actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        prev_location: null,
        distance: 2,
        stuck_time: 0,
        last_time: Date.now(),
        max_stuck_time: 20,
        prev_dig_block: null,
        update: async function (agent) {
            if (agent.isIdle()) { 
                this.prev_location = null;
                this.stuck_time = 0;
                return; // don't get stuck when idle
            }
            const bot = agent.bot;
            const cur_dig_block = bot.targetDigBlock;
            if (cur_dig_block && !this.prev_dig_block) {
                this.prev_dig_block = cur_dig_block;
            }
            if (this.prev_location && this.prev_location.distanceTo(bot.entity.position) < this.distance && cur_dig_block == this.prev_dig_block) {
                this.stuck_time += (Date.now() - this.last_time) / 1000;
            }
            else {
                this.prev_location = bot.entity.position.clone();
                this.stuck_time = 0;
                this.prev_dig_block = null;
            }
            const max_stuck_time = cur_dig_block?.name === 'obsidian' ? this.max_stuck_time * 2 : this.max_stuck_time;
            if (this.stuck_time > max_stuck_time) {
                say(agent, '呜呜，我卡住了，等我一下~');
                this.stuck_time = 0;
                fireModeAction(this, agent, async () => {
                    // 原来这里 10 秒内脱困失败会 cleanKill 直接杀掉 bot 进程（历史日志里出现 17 次）。
                    // 改成软超时：超时就放弃这次脱困、继续玩，绝不退出进程。
                    await Promise.race([
                        skills.moveAway(bot, 5),
                        new Promise(resolve => setTimeout(resolve, 15000))
                    ]);
                    say(agent, '我出来啦~');
                });
            }
            this.last_time = Date.now();
        },
        unpause: function () {
            this.prev_location = null;
            this.stuck_time = 0;
            this.prev_dig_block = null;
        }
    },
    {
        name: 'cowardice',
        description: 'Run away from enemies. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        update: async function (agent) {
            const enemy = world.getNearestEntityWhere(agent.bot, entity => mc.isHostile(entity), 16);
            if (enemy && await world.isClearPath(agent.bot, enemy)) {
                say(agent, `Aaa! A ${enemy.name.replace("_", " ")}!`);
                fireModeAction(this, agent, async () => {
                    await skills.avoidEnemies(agent.bot, 24);
                });
            }
        }
    },
    {
        name: 'self_defense',
        description: 'Attack nearby enemies. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        update: async function (agent) {
            const enemy = world.getNearestEntityWhere(agent.bot, entity => mc.isHostile(entity), 8);
            if (enemy && await world.isClearPath(agent.bot, enemy)) {
                say(agent, `Fighting ${enemy.name}!`);
                fireModeAction(this, agent, async () => {
                    await skills.defendSelf(agent.bot, 8);
                });
            }
        }
    },
    {
        // ★ M9（07 §3.1）：护主。**排在 self_defense 后面**（列表顺序 = 优先级，
        //   modes.js 的 update() 遇到正在跑的就停）。
        name: 'protect_owner',
        description: 'Protect the owner while following them. Interrupts follow.',
        // 只打断跟随（07 §3.1："跟随单还是 claimed，打完接着跟"）
        interrupts: ['action:followPlayer', 'job:follow'],
        on: true,
        active: false,
        update: async function (agent) {
            // 门禁：没在跟随主人 → 什么都不做（self_defense 只保护她自己）
            const following = !!agent.follow_target;
            const owner = agent.prompter?.profile?.permissions?.owner ?? null;
            if (!following || !owner || agent.follow_target !== owner) return;

            const ownerEnt = agent.bot.players?.[owner]?.entity;
            if (!ownerEnt) return;

            const now = Date.now();
            const selfHp = Number(agent.bot.health ?? 20);
            // 收集"敌对且在主人附近"的候选
            const candidates = [];
            for (const e of Object.values(agent.bot.entities ?? {})) {
                if (!e || e === agent.bot.entity) continue;
                if (!mc.isHostile(e)) continue;
                const d = e.position.distanceTo(ownerEnt.position);
                candidates.push({
                    id: e.id, name: e.name,
                    distToOwner: d,
                    dyToOwner: Math.abs((e.position?.y ?? 0) - (ownerEnt.position?.y ?? 0)),
                });
            }

            const verdict = decideProtect({
                following: true,
                ownerHurt: !!agent._ownerHurtAt && (now - agent._ownerHurtAt < 3000),
                selfHp,
                candidates,
                ignored: protectIgnored,
                now,
            });
            if (!verdict.act) return;

            const target = agent.bot.entities?.[verdict.target.id];
            if (!target) return;

            say(agent, `Protecting ${owner}! (${verdict.reason})`);
            fireModeAction(this, agent, async () => {
                const t0 = Date.now();
                try {
                    // 打断跟随（brief：打完接着跟，07 §4）
                    await agent.actions?.stop?.('brief');
                    while (Date.now() - t0 < PROTECT.MAX_FIGHT_MS) {
                        const alive = agent.bot.entities?.[verdict.target.id];
                        const rel = shouldRelease({
                            targetAlive: !!alive,
                            distToOwner: alive ? alive.position.distanceTo(ownerEnt.position) : 0,
                            foughtMs: Date.now() - t0,
                            selfHp: Number(agent.bot.health ?? 20),
                        });
                        if (rel.stop) break;
                        const r = await attackOnce(agent.bot, { kind: 'entity', entity: alive });
                        if (!r.ok && r.code !== 'NOT_READY') break;
                    }
                } finally {
                    // 放弃过的目标 30 秒内不再管
                    protectIgnored.set(verdict.target.id, Date.now() + PROTECT.IGNORE_MS);
                }
            });
        }
    },
    {
        name: 'hunting',
        description: 'Hunt nearby animals when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        update: async function (agent) {
            const huntable = world.getNearestEntityWhere(agent.bot, entity => mc.isHuntable(entity), 8);
            if (huntable && await world.isClearPath(agent.bot, huntable)) {
                fireModeAction(this, agent, async () => {
                    say(agent, `Hunting ${huntable.name}!`);
                    await skills.attackEntity(agent.bot, huntable);
                });
            }
        }
    },
    {
        name: 'item_collecting',
        description: 'Collect nearby items when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,

        wait: 2, // number of seconds to wait after noticing an item to pick it up
        prev_item: null,
        noticed_at: -1,
        update: async function (agent) {
            let item = world.getNearestEntityWhere(agent.bot, entity => entity.name === 'item', 8);
            let empty_inv_slots = agent.bot.inventory.emptySlotCount();
            if (item && item !== this.prev_item && await world.isClearPath(agent.bot, item) && empty_inv_slots > 1) {
                if (this.noticed_at === -1) {
                    this.noticed_at = Date.now();
                }
                if (Date.now() - this.noticed_at > this.wait * 1000) {
                    say(agent, `Picking up item!`);
                    this.prev_item = item;
                    // 必须显式给 timeout：execute 的默认值是 -1（不设超时）。
                    // 一旦 pickupNearbyItems 内部卡住，mode.active 会一直是 true，
                    // 而 update() 里有 `if (mode.active) break;`，
                    // 结果是后面所有 mode（脱困、自保、放火把…）被永久跳过。
                    // 3 分钟是上限，正常捡一轮几秒就结束。
                    fireModeAction(this, agent, async () => {
                        await skills.pickupNearbyItems(agent.bot);
                    }, 3).catch(err => {
                        console.warn(`[item_collecting] pickup failed: ${err}`);
                    });
                    this.noticed_at = -1;
                }
            }
            else {
                this.noticed_at = -1;
            }
        }
    },
    {
        name: 'torch_placing',
        description: 'Place torches when idle and there are no torches nearby.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        cooldown: 5,
        last_place: Date.now(),
        update: function (agent) {
            if (world.shouldPlaceTorch(agent.bot)) {
                if (Date.now() - this.last_place < this.cooldown * 1000) return;
                fireModeAction(this, agent, async () => {
                    const pos = agent.bot.entity.position;
                    await skills.placeBlock(agent.bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
                });
                this.last_place = Date.now();
            }
        }
    },
    {
        name: 'elbow_room',
        description: 'Move away from nearby players when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        distance: 0.5,
        update: async function (agent) {
            const player = world.getNearestEntityWhere(agent.bot, entity => entity.type === 'player', this.distance);
            if (player) {
                fireModeAction(this, agent, async () => {
                    // wait a random amount of time to avoid identical movements with other bots
                    const wait_time = Math.random() * 1000;
                    await new Promise(resolve => setTimeout(resolve, wait_time));
                    if (player.position.distanceTo(agent.bot.entity.position) < this.distance) {
                        await skills.moveAwayFromEntity(agent.bot, player, this.distance);
                    }
                });
            }
        }
    },
    {
        name: 'idle_staring',
        description: 'Animation to look around at entities when idle.',
        interrupts: [],
        on: true,
        active: false,

        staring: false,
        last_entity: null,
        next_change: 0,
        update: function (agent) {
            const entity = agent.bot.nearestEntity();
            let entity_in_view = entity && entity.position.distanceTo(agent.bot.entity.position) < 10 && entity.name !== 'enderman';
            if (entity_in_view && entity !== this.last_entity) {
                this.staring = true;
                this.last_entity = entity;
                this.next_change = Date.now() + Math.random() * 1000 + 4000;
            }
            if (entity_in_view && this.staring) {
                let isbaby = entity.type !== 'player' && entity.metadata[16];
                let height = isbaby ? entity.height/2 : entity.height;
                const target = entity.position.offset(0, height, 0);
                // 有 smoothLook 就走插值转头，更自然；没有则回退到瞬间转头
                if (agent.bot.smoothLook?.lookAt) {
                    try { agent.bot.smoothLook.lookAt(target); }
                    catch (err) { agent.bot.lookAt(target); }
                } else {
                    agent.bot.lookAt(target);
                }
            }
            if (!entity_in_view)
                this.last_entity = null;
            if (Date.now() > this.next_change) {
                // look in random direction
                this.staring = Math.random() < 0.3;
                if (!this.staring) {
                    const yaw = Math.random() * Math.PI * 2;
                    const pitch = (Math.random() * Math.PI/2) - Math.PI/4;
                    if (agent.bot.smoothLook?.look) {
                        try { agent.bot.smoothLook.look(yaw, pitch); }
                        catch (err) { agent.bot.look(yaw, pitch, false); }
                    } else {
                        agent.bot.look(yaw, pitch, false);
                    }
                }
                this.next_change = Date.now() + Math.random() * 10000 + 2000;
            }
        }
    },
    {
        name: 'cheat',
        description: 'Use cheats to instantly place blocks and teleport.',
        interrupts: [],
        on: false,
        active: false,
        update: function (agent) { /* do nothing */ }
    }
];

/**
 * 反射 mode 的入口：**故意不 await**，但**必须**接住 rejection。
 *
 * ★★ T32：`execute()` 是 async 的，而所有调用点都在 300ms 的 tick 里 ——
 *   **不能 await**（一次挖掘能跑几十秒，await 会把 update 循环整个卡死，
 *   那正是心跳停摆的另一条路）。可"不 await"以前等于"没人管"：
 *   23 条 `execute(...)` 全在浮空，`execute` 内部**没有**兜住的异常（比如
 *   `agent.self_prompter.isActive()` 抛）会变成 unhandled rejection 把进程带走。
 *
 * 所以这里做一件事：**统一接住**，并且让调用点返回 `undefined`（不是 promise）。
 * 注意这**不是**把问题藏起来 —— 是给"fire-and-forget"这个设计一个显式的错误边界。
 */
function fireModeAction(mode, agent, func, timeout) {
    try {
        execute(mode, agent, func, timeout).catch((e) => {
            console.warn(`[mode:${mode?.name ?? '?'}] 动作异常（已隔离，不影响 update 循环）：`
                + `${String(e?.message ?? e)}`);
        });
    } catch (e) {
        console.warn(`[mode:${mode?.name ?? '?'}] 动作启动即失败：${String(e?.message ?? e)}`);
    }
}

/**
 * 跑一个 mode 的动作。
 *
 * 导出是为了能离线单测 07 §4 的那条分叉：打断的是任务单 → 不叫模型，
 * 不是任务单 → 照旧 AUTO MESSAGE。只测 `noteJobInterrupted` 测不到这条分叉。
 */
export async function execute(mode, agent, func, timeout=-1) {
    if (agent.self_prompter.isActive())
        agent.self_prompter.stopLoop();
    let interrupted_action = agent.actions.currentActionLabel;
    mode.active = true;
    let code_return;
    try {
        // ★ 2026-11-01（M2，07 §4）：反射 mode 打断一律是 `brief` ——
        // 打完 / 躲完还要回来接着做（不是抢占，也不是玩家喊停）。
        code_return = await agent.actions.runAction(`mode:${mode.name}`, async () => {
            await func();
        }, { timeout, stopReason: STOP_REASONS.BRIEF });
    }
    catch (err) {
        // runAction 抛异常时也必须复位，否则 mode.active 永远为 true，
        // update() 里的 `if (mode.active) break;` 会让所有后续模式永久失效。
        console.warn(`Mode ${mode.name} threw: ${err}`);
        code_return = { success: false, message: String(err), interrupted: false, timedout: false };
    }
    finally {
        mode.active = false;
    }
    console.log(`Mode ${mode.name} finished executing, code_return: ${code_return.message}`);

    // ★ 2026-11-01（M2，07 §4 第 5 步 / 08 §2）：被打断的是**任务单**时**不发** AUTO MESSAGE。
    // 那条消息会让模型重新下命令，把调度器正要续做的单冲掉；改给模型一行状态就够了。
    // 不是任务单（即时命令 / mode / !newAction）时行为不变，照旧 AUTO MESSAGE。
    const interrupted_job = isJobLabel(interrupted_action);

    let should_reprompt = 
        interrupted_action && // it interrupted a previous action
        !interrupted_job && // 任务单由调度器接手，不叫模型（07 §4）
        !agent.actions.resume_func && // there is no resume function
        !agent.self_prompter.isActive() && // self prompting is not on
        !code_return.interrupted; // this mode action was not interrupted by something else

    if (interrupted_job) {
        noteJobInterrupted(agent, { label: interrupted_action, mode: mode.name });
    }

    if (should_reprompt) {
        // auto prompt to respond to the interruption
        // BOT-001：不在对话里时这条是**代码发起**的自动消息，必须显式 internal；
        // 在对话里则沿用"归到对话对象"的原语义（那是个真实玩家名，不该借内部标记升权）。
        const in_convo = convoManager.inConversation();
        let role = in_convo ? agent.last_sender : 'system';
        let logs = agent.bot.modes.flushBehaviorLog();
        agent.handleMessage(role, `(AUTO MESSAGE)Your previous action '${interrupted_action}' was interrupted by ${mode.name}.
        Your behavior log: ${logs}\nRespond accordingly.`, null, in_convo ? {} : { internal: true });
    }
}

let _agent = null;
const modes_map = {};
for (let mode of modes_list) {
    modes_map[mode.name] = mode;
}

class ModeController {
    /*
    SECURITY WARNING:
    ModesController must be reference isolated. Do not store references to external objects like `agent`.
    This object is accessible by LLM generated code, so any stored references are also accessible.
    This can be used to expose sensitive information by malicious prompters.
    */
    constructor() {
        this.behavior_log = '';
    }

    exists(mode_name) {
        return modes_map[mode_name] != null;
    }

    setOn(mode_name, on) {
        modes_map[mode_name].on = on;
    }

    isOn(mode_name) {
        return modes_map[mode_name].on;
    }

    isPaused(mode_name) {
        return !!modes_map[mode_name]?.paused;
    }

    pause(mode_name) {
        modes_map[mode_name].paused = true;
    }

    unpause(mode_name) {
        const mode = modes_map[mode_name];
        //if  unpause func is defined and mode is currently paused
        if (mode.unpause && mode.paused) {
            mode.unpause();
        }
        mode.paused = false;
    }

    unPauseAll() {
        for (let mode of modes_list) {
            if (mode.paused) console.log(`Unpausing mode ${mode.name}`);
            this.unpause(mode.name);
        }
    }

    getMiniDocs() { // no descriptions
        let res = 'Agent Modes:';
        for (let mode of modes_list) {
            let on = mode.on ? 'ON' : 'OFF';
            res += `\n- ${mode.name}(${on})`;
        }
        return res;
    }

    getDocs() {
        let res = 'Agent Modes:';
        for (let mode of modes_list) {
            let on = mode.on ? 'ON' : 'OFF';
            res += `\n- ${mode.name}(${on}): ${mode.description}`;
        }
        return res;
    }

    async update() {
        if (_agent.isIdle()) {
            this.unPauseAll();
        }
        for (let mode of modes_list) {
            let interruptible = mode.interrupts.some(i => i === 'all') || mode.interrupts.some(i => i === _agent.actions.currentActionLabel);
            if (mode.on && !mode.paused && !mode.active && (_agent.isIdle() || interruptible)) {
                await mode.update(_agent);
            }
            if (mode.active) break;
        }
    }

    flushBehaviorLog() {
        const log = this.behavior_log;
        this.behavior_log = '';
        return log;
    }

    getJson() {
        let res = {};
        for (let mode of modes_list) {
            res[mode.name] = mode.on;
        }
        return res;
    }

    loadJson(json) {
        for (let mode of modes_list) {
            if (json[mode.name] != undefined) {
                mode.on = json[mode.name];
            }
        }
    }
}

export function initModes(agent) {
    _agent = agent;
    // the mode controller is added to the bot object so it is accessible from anywhere the bot is used
    agent.bot.modes = new ModeController();
    if (agent.task) {
        agent.bot.restrict_to_inventory = agent.task.restrict_to_inventory;
    }
    let modes_json = agent.prompter.getInitModes();
    if (modes_json) {
        agent.bot.modes.loadJson(modes_json);
    }
}
