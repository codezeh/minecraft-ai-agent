import * as skills from '../library/skills.js';
import settings from '../settings.js';
import convoManager from '../conversation.js';
import { formatActionResult } from '../library/atom_contract.js';
import { follow as followTask, goToPlayer as goToPlayerTask } from '../library/task_follow.js';
import { collect as collectTask } from '../library/task_collect.js';
import { resolveCollectTarget } from '../library/collect_targets.js';
import { placeBlockAt } from '../library/atom_place.js';
import { placePlatform } from '../library/task_platform.js';

/**
 * 「放在我面前」：取朝向那一格。
 * MC 的 yaw 约定：0 = 南(+Z)，90° = 西(-X)，方向向量 = (-sin(yaw), cos(yaw))。
 */
function frontBlockPos(bot) {
    const yaw = bot.entity.yaw;
    const dx = Math.round(-Math.sin(yaw));
    const dz = Math.round(Math.cos(yaw));
    const p = bot.entity.position.floored();
    return { x: p.x + dx, y: p.y, z: p.z };
}


function runAsAction (actionFn, resume = false, timeout = -1) {
    let actionLabel = null;  // Will be set on first use
    
    const wrappedAction = async function (agent, ...args) {
        // Set actionLabel only once, when the action is first created
        if (!actionLabel) {
            const actionObj = actionsList.find(a => a.perform === wrappedAction);
            actionLabel = actionObj.name.substring(1); // Remove the ! prefix
        }

        // 同一个动作已经在跑：不要再打断重来。
        // 实测后果：玩家说两次「跟着我」，第二条会把第一条打断，
        // 被打断那条把 INTERRUPTED 交给模型，模型就自己乱挑命令（!walkTo(0,0)），越修越乱。
        if (agent.actions?.executing && agent.actions.currentActionLabel === `action:${actionLabel}`) {
            return `${actionLabel}: 已经在做了，不用重来`;
        }

        let result = null;
        const actionFnWithAgent = async () => {
            result = await actionFn(agent, ...args);
        };
        const code_return = await agent.actions.runAction(`action:${actionLabel}`, actionFnWithAgent, { timeout, resume });
        // 被打断（新指令 / mode 抢占）时原来直接 return undefined，
        // 模型只看到空结果，就会说「好嘞」然后什么都没发生。至少给它一行事实。
        if (code_return.interrupted && !code_return.timedout) {
            const partial = formatActionResult(actionLabel, code_return, result);
            return partial || `${actionLabel}: INTERRUPTED — 被打断了，没做完`;
        }
        return formatActionResult(actionLabel, code_return, result);
    }

    return wrappedAction;
}

export const actionsList = [
    {
        name: '!newAction',
        description: 'Perform new and unknown custom behaviors that are not available as a command.', 
        params: {
            'prompt': { type: 'string', description: 'A natural language prompt to guide code generation. Make a detailed step-by-step plan.' }
        },
        perform: async function(agent, prompt) {
            // just ignore prompt - it is now in context in chat history
            if (!settings.allow_insecure_coding) { 
                agent.openChat('newAction is disabled. Enable with allow_insecure_coding=true in settings.js');
                return "newAction not allowed! Code writing is disabled in settings. Notify the user.";
            }
            let result = "";
            const actionFn = async () => {
                try {
                    result = await agent.coder.generateCode(agent.history);
                } catch (e) {
                    result = 'Error generating code: ' + e.toString();
                }
            };
            await agent.actions.runAction('action:newAction', actionFn, {timeout: settings.code_timeout_mins});
            return result;
        }
    },
    {
        name: '!stop',
        description: 'Force stop all actions and commands that are currently executing.',
        perform: async function (agent) {
            await agent.actions.stop();
            agent.clearBotLogs();
            agent.actions.cancelResume();
            agent.bot.emit('idle');
            let msg = 'Agent stopped.';
            if (agent.self_prompter.isActive())
                msg += ' Self-prompting still active.';
            return msg;
        }
    },
    {
        name: '!stfu',
        description: 'Stop all chatting and self prompting, but continue current action.',
        perform: async function (agent) {
            agent.openChat('Shutting up.');
            agent.shutUp();
            return;
        }
    },
    {
        name: '!restart',
        description: 'Restart the agent process.',
        perform: async function (agent) {
            agent.cleanKill();
        }
    },
    {
        name: '!clearChat',
        description: 'Clear the chat history.',
        perform: async function (agent) {
            agent.history.clear();
            return agent.name + "'s chat history was cleared, starting new conversation from scratch.";
        }
    },
    {
        name: '!followEntity',
        description: 'Follow a non-player entity by name (e.g. oak_boat, cow). Useful for following a boat across water, since riding boats is unsupported on this mineflayer/version.',
        params: {
            'entity_name': {type: 'string', description: 'Entity name, e.g. oak_boat or cow.'},
            'distance': {type: 'float', description: 'How close to stay.', domain: [1, 32], default: 3},
        },
        perform: runAsAction(async (agent, entity_name, distance = 3) => {
            // ★ 2026-10-28 新增（用户提议：「加一个跟随的动作，但跟随对象是船」）。
            //
            // 背景：船的「骑乘」在 1.21.8 + mineflayer 4.39 上走不通 ——
            //   实测 bot.mount() 发出的 use_entity 服务端不认，
            //   RootVehicle 始终为空；手写 interact 包会被服务端踢。
            //   但**跟着船走**不需要骑乘：船稳定浮在水面（实测 y 不漂），
            //   可以直接把它当成"浮在水上的路标"接近。
            //
            // 与 !goToPlayer 的分工：那个跟玩家（可能要问 RCON），这个跟实体（纯客户端）。
            const mapDir = `./bots/${agent.bot.username || agent.bot.entity?.name || 'agent'}/map`;
            console.log(`[!followEntity] 跟随 ${entity_name}（距离 ${distance}），mapDir=${mapDir}`);
            // 路径注意：本文件在 src/agent/commands/，库在 src/agent/library/
            const { followEntity } = await import('../library/task_follow.js');
            const r = await followEntity(agent.bot, entity_name, {
                distance: Math.max(1, Number(distance) || 3),
                mapDir,
                timeoutMs: 180000,
                onEvent: (e) => { if (e.type === 'stuck' || e.type === 'lost_entity' || e.type === 'arrived') console.log('[!followEntity]', JSON.stringify(e)); },
            });
            return r.ok
                ? `跟到 ${entity_name} 了（差 ${Math.round(r.data?.dist ?? 0)} 格）`
                : `跟不到 ${entity_name}：${r.code} ${r.message ?? ''}`;
        }),
    },
    {
        name: '!goToPlayer',
        description: 'Go to the given player.',
        params: {
            'player_name': {type: 'string', description: 'The name of the player to go to.'},
            'closeness': {type: 'float', description: 'How close to get to the player.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, closeness) => {
            // ★ 2026-10-27：去掉 companion_mode 开关，!goToPlayer **无条件**走 goToPlayerTask。
            //
            // 为什么（今晚最大的坑）：`settings.companion_mode` 在整个代码库里
            // **只有引用、没有定义**，永远是 undefined → 这个 if 从未成立 →
            // 实际一直走下面的 skills.goToPlayer（原项目那套）。
            // 后果：task_follow 里所有改进（RCON 查坐标、hopTo 滚动窗口、
            // 两档挖+搭、ensureScaffold 备料）**一次都没被执行过**。
            // 实测：她困在 y=42 的洞里，调 !goToPlayer 报 NO_REACH，
            // 日志里连一个 hop-round 事件都没有 —— 因为压根没进这条分支。
            //
            // 只接 !goToPlayer 一个命令（不动 !followPlayer / !collectBlocks 等），
            // 把行为变化控制在"走过来"这一件事上。
            const mapDir = `./bots/${agent.bot.username || agent.bot.entity?.name || 'agent'}/map`;
            console.log(`[!goToPlayer] 走 goToPlayerTask（mapDir=${mapDir}）`);
            return await goToPlayerTask(agent.bot, player_name, {
                distance: closeness ?? 3,
                mapDir,
            });
        })
    },
    {
        name: '!followPlayer',
        description: 'Endlessly follow the given player.',
        params: {
            'player_name': {type: 'string', description: 'name of the player to follow.'},
            'follow_dist': {type: 'float', description: 'The distance to follow from.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, follow_dist) => {
            if (settings.companion_mode) {
                return await followTask(agent.bot, player_name, {
                    distance: follow_dist ?? 3,
                    mapDir: `./bots/${agent.bot.username || agent.bot.entity?.name || 'agent'}/map`,
                });
            }
            await skills.followPlayer(agent.bot, player_name, follow_dist);
        }, true)
    },
    {
        name: '!goToCoordinates',
        description: 'Go to the given x, y, z location.',
        params: {
            'x': {type: 'float', description: 'The x coordinate.', domain: [-Infinity, Infinity]},
            'y': {type: 'float', description: 'The y coordinate.', domain: [-64, 320]},
            'z': {type: 'float', description: 'The z coordinate.', domain: [-Infinity, Infinity]},
            'closeness': {type: 'float', description: 'How close to get to the location.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, x, y, z, closeness) => {
            await skills.goToPosition(agent.bot, x, y, z, closeness);
        })
    },
    {
        // 规划器驱动的行走：先用地形热力图避危险，再逐段走，失败会重规划。
        // 和 !goToCoordinates 差别很大 —— 那个走的是老 pathfinder，完全绕过热力图，
        // 也就是说 !plan 辛苦算出来的安全路线，以前根本没法照着走。
        name: '!walkTo',
        description: 'Walk to (x, z) using the terrain heatmap planner: it avoids lava/fire outlines and remembered dangers, walks leg by leg, and re-plans if a leg fails. Prefer this over !goToCoordinates for long trips. Use !plan first to see the route before committing.',
        params: {
            'x': { type: 'int', description: 'Target x coordinate.' },
            'z': { type: 'int', description: 'Target z coordinate.' },
        },
        perform: runAsAction(async (agent, x, z) => {
            // ★ 2026-10-27：!walkTo 改走 hopTo（跟 !goToPlayer 同一套）。
            //
            // 原来它调 skills.goToPositionPlanned（原项目热力图那套），
            // 于是项目里有两套长距离规划，行为不一致、改一套另一套不变。
            // 现在统一到 hopTo：滚动窗口 + 失败惩罚 + 被困自救 + 1 格精度预判。
            //
            // 顺带解决了测试难题：探针没法可靠传到远处（/tp 会被服务端拉回、
            // spreadplayers 在未生成区放不下去），而 !walkTo 给坐标就能测长距离。
            const mapDir = `./bots/${agent.bot.username || agent.bot.entity?.name || 'agent'}/map`;
            console.log(`[!walkTo] 走 hopTo 到 (${x}, ${z})，mapDir=${mapDir}`);
            const { hopTo } = await import('../library/task_hop.js');
            const r = await hopTo(agent.bot, { x: Number(x), z: Number(z) }, { mapDir, deadlineMs: 420000 });

            const p = agent.bot.entity.position;
            const here = `(${Math.floor(p.x)},${Math.floor(p.z)})`;
            const left = Math.hypot(Number(x) - p.x, Number(z) - p.z);
            if (r.ok) {
                skills.log(agent.bot, `走到 (${x},${z}) 了。现在在 ${here}，面朝${skills.facingName(agent.bot)}。`);
            } else {
                skills.log(agent.bot, `没能走到 (${x},${z})：${r.code} ${r.message ?? ''}（还差 ${left.toFixed(0)} 格）。现在在 ${here}。`);
            }
        })
    },
    {
        name: '!searchForBlock',
        description: 'Find and go to the nearest block of a given type in a given range.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the block. Minimum 32.', domain: [10, 512] }
        },
        perform: runAsAction(async (agent, block_type, range) => {
            if (range < 32) {
                skills.log(agent.bot, `Minimum search range is 32.`);
                range = 32;
            }
            await skills.goToNearestBlock(agent.bot, block_type, 4, range);
        })
    },
    {
        name: '!searchForEntity',
        description: 'Find and go to the nearest entity of a given type in a given range.',
        params: {
            'type': { type: 'string', description: 'The type of entity to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the entity.', domain: [32, 512] }
        },
        perform: runAsAction(async (agent, entity_type, range) => {
            await skills.goToNearestEntity(agent.bot, entity_type, 4, range);
        })
    },
    {
        name: '!moveAway',
        description: 'Move away from the current location in any direction by a given distance.',
        params: {'distance': { type: 'float', description: 'The distance to move away.', domain: [0, Infinity] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.moveAway(agent.bot, distance);
        })
    },
    {
        name: '!rememberHere',
        description: 'Save the current location with a given name.',
        params: {'name': { type: 'string', description: 'The name to remember the location as.' }},
        perform: async function (agent, name) {
            const pos = agent.bot.entity.position;
            agent.memory_bank.rememberPlace(name, pos.x, pos.y, pos.z);
            return `Location saved as "${name}".`;
        }
    },
    {
        name: '!goToRememberedPlace',
        description: 'Go to a saved location.',
        params: {'name': { type: 'string', description: 'The name of the location to go to.' }},
        perform: runAsAction(async (agent, name) => {
            const pos = agent.memory_bank.recallPlace(name);
            if (!pos) {
            skills.log(agent.bot, `No location named "${name}" saved.`);
            return;
            }
            await skills.goToPosition(agent.bot, pos[0], pos[1], pos[2], 1);
        })
    },
    {
        name: '!givePlayer',
        description: 'Give items to a player. ALWAYS use this when a player asks for items - it walks to them, faces them, throws the items toward them, and confirms they picked them up. Do not use !discard for this.',
        params: { 
            'player_name': { type: 'string', description: 'The name of the player to give the item to.' }, 
            'item_name': { type: 'ItemName', description: 'The name of the item to give.' },
            'num': { type: 'int', description: 'The number of items to give.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, player_name, item_name, num) => {
            await skills.giveToPlayer(agent.bot, item_name, player_name, num);
        })
    },
    {
        name: '!consume',
        description: 'Eat/drink the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to consume.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.consume(agent.bot, item_name);
        })
    },
    {
        name: '!equip',
        description: 'Equip the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to equip.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.equip(agent.bot, item_name);
        })
    },
    {
        name: '!putInChest',
        description: 'Put the given item in the nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to put in the chest.' },
            'num': { type: 'int', description: 'The number of items to put in the chest.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.putInChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!takeFromChest',
        description: 'Take the given items from the nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to take.' },
            'num': { type: 'int', description: 'The number of items to take.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.takeFromChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!viewChest',
        description: 'View the items/counts of the nearest chest.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.viewChest(agent.bot);
        })
    },
    {
        name: '!discard',
        description: 'Throw items away like trash. NOT for giving items to a player - use !givePlayer for that.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to discard.' },
            'num': { type: 'int', description: 'The number of items to discard.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            // 注意：这是"扔掉"垃圾用的。想交给玩家请用 !givePlayer，
            // 它会走到玩家身边、转向玩家再丢，并确认对方真的收到。
            // 这里的走开+回来是为了防止她把自己刚丢的东西又自动捡回去
            // （原地丢实测会立刻被 item_collecting 捡回，背包数量不变）。
            const start_loc = agent.bot.entity.position;
            await skills.moveAway(agent.bot, 5);
            await skills.discard(agent.bot, item_name, num);
            await skills.goToPosition(agent.bot, start_loc.x, start_loc.y, start_loc.z, 0);
        })
    },
    {
        name: '!collectBlocks',
        description: 'Collect the nearest blocks of a given type. The type can be a category like "wood"/木头 (all logs), "leaves", or a specific block like oak_log / 橡木 / 丛林木. If the player says "near me / 我旁边 / 这里", pass near=<player name> so I chop the trees next to THE PLAYER instead of next to me.',
        params: {
            // 用 string 而不是 BlockName：类别名（木头/wood）不是方块 ID，
            // BlockName 的校验会直接拒绝，于是「砍点木头」在参数解析阶段就失败了。
            'type': { type: 'string', description: 'Block name or category: wood/木头 (all logs), leaves, or oak_log/橡木/丛林木/白桦…' },
            'num': { type: 'int', description: 'The number of blocks to collect.', domain: [1, Number.MAX_SAFE_INTEGER], default: 1 },
            'near': { type: 'string', description: 'Optional player name. Pass this when the player says "near me / 我旁边 / 这里" — I will pick trees next to that player, not next to me.', default: '' }
        },
        perform: runAsAction(async (agent, type, num, near) => {
            // ★ 2026-10-29 修：**类别名解析必须无条件执行**。
            //
            // 原来 `resolveCollectTarget` 只在 `if (settings.companion_mode)` 里调用，
            // 而这个变量在整个项目里**从未定义**（永远 undefined），
            // 所以永远走 else 分支 `skills.collectBlock(bot, type, num)`，
            // 把 "木头" 这种中文类别名直接当成方块名传进去 → 找不到方块 → 静默失败。
            // 实测：`!collectBlocks("木头", 4)` 执行后背包一个木头都没有，
            // 日志里连一条结果都没有。
            //
            // 现在先把类别名解析成具体方块名，两条分支都用解析后的结果。
            const resolved = resolveCollectTarget(type, agent.bot.registry);
            if (settings.companion_mode) {
                const t = resolved;
                if (!t) {
                    return { ok: false, code: 'NO_TARGET', message: `我不认识「${type}」，说具体点？比如 橡木/丛林木/石头` };
                }
                // 「砍我旁边的树」：以那个玩家的位置为参照排序，而不是以自己为参照。
                let anchor = null;
                if (near && String(near).trim()) {
                    const name = String(near).trim();
                    const ent = agent.bot.players?.[name]?.entity;
                    if (ent) {
                        anchor = { x: ent.position.x, y: ent.position.y, z: ent.position.z };
                    } else {
                        // 玩家不在线/看不见：如实说，别默默按自己位置砍
                        return { ok: false, code: 'NO_TARGET', message: `我看不到 ${name}，没法按他的位置找树` };
                    }
                }
                // ★ 2026-10-29：补 mapDir —— 没有它，collect 内部的接近动作会退回
                // 原生 pathfinder，而目标常在树上（高差 9~10 格），爬不上去 → 卡死。
                // 实测：不传 mapDir 时她站在原地一动不动；传了之后能爬树砍到木头。
                const mapDir = `./bots/${agent.bot.username || agent.bot.entity?.name || 'agent'}/map`;
                return await collectTask(agent.bot, t.names, num ?? 1,
                    {
                        label: t.echo, near: anchor, mapDir,
                        onEvent: (e) => console.log('[collect-ev]', JSON.stringify(e).slice(0, 160)),
                    });
            }
            // 类别名（木头/wood/石头…）要展开成具体方块名，否则 collectBlock 找不到目标。
            // 解析不出就如实说，别静默失败。
            if (!resolved) {
                return { ok: false, code: 'NO_TARGET', message: `我不认识「${type}」，说具体点？比如 橡木/丛林木/石头` };
            }
            // ★ 2026-10-29 修：统一走 collectTask（L2 规划 + L3 执行的分层链路）。
            //
            // 原来这里走旧的 skills.collectBlock，它内部用原生 pathfinder 接近目标，
            // 而 target 常在树上（高差 9~10 格），pathfinder 爬不上去 →
            // `!collectBlocks("木头",4)` 卡死不动。
            // collectTask 能接收 mapDir，从而让接近动作走 3D 链路（见 skill_collect.makeHandlers）。
            const mapDir = `./bots/${agent.bot.username || agent.bot.entity?.name || 'agent'}/map`;
            return await collectTask(agent.bot, resolved.names, num ?? 1,
                {
                    label: resolved.echo, near: null, mapDir,
                    // 诊断：采集链路很长，没有事件输出时完全看不出卡在哪一步
                    onEvent: (e) => console.log('[collect-ev]', JSON.stringify(e).slice(0, 160)),
                });
        }, false, 10) // 10 minute timeout
    },
    {
        name: '!craftRecipe',
        description: 'Craft the given recipe a given number of times.',
        params: {
            'recipe_name': { type: 'ItemName', description: 'The name of the output item to craft.' },
            'num': { type: 'int', description: 'The number of times to craft the recipe. This is NOT the number of output items, as it may craft many more items depending on the recipe.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, recipe_name, num) => {
            await skills.craftRecipe(agent.bot, recipe_name, num);
        })
    },
    {
        name: '!smeltItem',
        description: 'Smelt the given item the given number of times.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the input item to smelt.' },
            'num': { type: 'int', description: 'The number of times to smelt the item.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            let success = await skills.smeltItem(agent.bot, item_name, num);
            if (success) {
                setTimeout(() => {
                    agent.cleanKill('Safely restarting to update inventory.');
                }, 500);
            }
        })
    },
    {
        name: '!clearFurnace',
        description: 'Take all items out of the nearest furnace.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.clearNearestFurnace(agent.bot);
        })
    },
        {
        name: '!placeHere',
        description: 'Place a given block at your feet, in front of you, or at the given coordinates.',
        params: {
            'type': { type: 'BlockOrItemName', description: 'The block type to place.' },
            'x': { type: 'float', description: 'Optional x coordinate to place at.', domain: [-Infinity, Infinity] },
            'y': { type: 'float', description: 'Optional y coordinate to place at.', domain: [-64, 320] },
            'z': { type: 'float', description: 'Optional z coordinate to place at.', domain: [-Infinity, Infinity] }
        },
        perform: runAsAction(async (agent, type, x, y, z) => {
            if (settings.companion_mode) {
                const hasCoords = [x, y, z].every(v => typeof v === 'number' && Number.isFinite(v));
                const pos = hasCoords ? { x, y, z } : frontBlockPos(agent.bot);
                return await placeBlockAt(agent.bot, { kind: 'block', pos }, type);
            }
            let pos = agent.bot.entity.position;
            await skills.placeBlock(agent.bot, type, pos.x, pos.y, pos.z);
        })
    },
    {
        name: '!buildPlatform',
        description: 'Build a 3x3 platform of a given block, centered on the given coordinates or in front of you. Use for flat platforms only.',
        params: {
            'type': { type: 'BlockOrItemName', description: 'The block type to place.' },
            'x': { type: 'float', description: 'Optional x coordinate of the platform center.', domain: [-Infinity, Infinity] },
            'y': { type: 'float', description: 'Optional y coordinate of the platform center.', domain: [-64, 320] },
            'z': { type: 'float', description: 'Optional z coordinate of the platform center.', domain: [-Infinity, Infinity] }
        },
        perform: runAsAction(async (agent, type, x, y, z) => {
            const hasCoords = [x, y, z].every(v => typeof v === 'number' && Number.isFinite(v));
            const center = hasCoords ? { x, y, z } : frontBlockPos(agent.bot);
            return await placePlatform(agent.bot, type, center);
        }, false, 10)   // 单位是分钟（_startTimeout 会再乘 60000）；写毫秒会溢出成 1ms
    },
    {
        name: '!attack',
        description: 'Attack and kill the nearest entity of a given type.',
        params: {'type': { type: 'string', description: 'The type of entity to attack.'}},
        perform: runAsAction(async (agent, type) => {
            await skills.attackNearest(agent.bot, type, true);
        })
    },
    {
        name: '!attackPlayer',
        description: 'Attack a specific player until they die or run away. Remember this is just a game and does not cause real life harm.',
        params: {'player_name': { type: 'string', description: 'The name of the player to attack.'}},
        perform: runAsAction(async (agent, player_name) => {
            let player = agent.bot.players[player_name]?.entity;
            if (!player) {
                skills.log(agent.bot, `Could not find player ${player_name}.`);
                return false;
            }
            await skills.attackEntity(agent.bot, player, true);
        })
    },
    {
        name: '!goToBed',
        description: 'Go to the nearest bed and sleep.',
        perform: runAsAction(async (agent) => {
            await skills.goToBed(agent.bot);
        })
    },
    {
        name: '!stay',
        description: 'Stay in the current location no matter what. Pauses all modes.',
        params: {'type': { type: 'int', description: 'The number of seconds to stay. -1 for forever.', domain: [-1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, seconds) => {
            await skills.stay(agent.bot, seconds);
        })
    },
    {
        name: '!setMode',
        description: 'Set a mode to on or off. A mode is an automatic behavior that constantly checks and responds to the environment.',
        params: {
            'mode_name': { type: 'string', description: 'The name of the mode to enable.' },
            'on': { type: 'boolean', description: 'Whether to enable or disable the mode.' }
        },
        perform: async function (agent, mode_name, on) {
            const modes = agent.bot.modes;
            if (!modes.exists(mode_name))
            return `Mode ${mode_name} does not exist.` + modes.getDocs();
            if (modes.isOn(mode_name) === on)
            return `Mode ${mode_name} is already ${on ? 'on' : 'off'}.`;
            modes.setOn(mode_name, on);
            return `Mode ${mode_name} is now ${on ? 'on' : 'off'}.`;
        }
    },
    {
        name: '!goal',
        description: 'Set a goal prompt to endlessly work towards with continuous self-prompting.',
        params: {
            'selfPrompt': { type: 'string', description: 'The goal prompt.' },
        },
        perform: async function (agent, prompt) {
            if (convoManager.inConversation()) {
                agent.self_prompter.setPromptPaused(prompt);
            }
            else {
                agent.self_prompter.start(prompt);
            }
        }
    },
    {
        name: '!endGoal',
        description: 'Call when you have accomplished your goal. It will stop self-prompting and the current action. ',
        perform: async function (agent) {
            agent.self_prompter.stop();
            return 'Self-prompting stopped.';
        }
    },
    {
        name: '!showVillagerTrades',
        description: 'Show trades of a specified villager.',
        params: {'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' }},
        perform: runAsAction(async (agent, id) => {
            await skills.showVillagerTrades(agent.bot, id);
        })
    },
    {
        name: '!tradeWithVillager',
        description: 'Trade with a specified villager.',
        params: {
            'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' },
            'index': { type: 'int', description: 'The index of the trade you want executed (1-indexed).', domain: [1, Number.MAX_SAFE_INTEGER] },
            'count': { type: 'int', description: 'How many times that trade should be executed.', domain: [1, Number.MAX_SAFE_INTEGER] },
        },
        perform: runAsAction(async (agent, id, index, count) => {
            await skills.tradeWithVillager(agent.bot, id, index, count);
        })
    },
    {
        name: '!startConversation',
        description: 'Start a conversation with a bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to send the message to.' },
            'message': { type: 'string', description: 'The message to send.' },
        },
        perform: async function (agent, player_name, message) {
            if (!convoManager.isOtherAgent(player_name))
                return player_name + ' is not a bot, cannot start conversation.';
            if (convoManager.inConversation() && !convoManager.inConversation(player_name)) 
                convoManager.forceEndCurrentConversation();
            else if (convoManager.inConversation(player_name))
                agent.history.add('system', 'You are already in conversation with ' + player_name + '. Don\'t use this command to talk to them.');
            convoManager.startConversation(player_name, message);
        }
    },
    {
        name: '!endConversation',
        description: 'End the conversation with the given bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to end the conversation with.' }
        },
        perform: async function (agent, player_name) {
            if (!convoManager.inConversation(player_name))
                return `Not in conversation with ${player_name}.`;
            convoManager.endConversation(player_name);
            return `Converstaion with ${player_name} ended.`;
        }
    },
    {
        name: '!lookAtPlayer',
        description: 'Look at a player or look in the same direction as the player.',
        params: {
            'player_name': { type: 'string', description: 'Name of the target player' },
            'direction': {
                type: 'string',
                description: 'How to look ("at": look at the player, "with": look in the same direction as the player)',
            }
        },
        perform: async function(agent, player_name, direction) {
            if (direction !== 'at' && direction !== 'with') {
                return "Invalid direction. Use 'at' or 'with'.";
            }
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPlayer(player_name, direction);
            };
            await agent.actions.runAction('action:lookAtPlayer', actionFn);
            return result;
        }
    },
    {
        name: '!lookAtPosition',
        description: 'Look at specified coordinates.',
        params: {
            'x': { type: 'int', description: 'x coordinate' },
            'y': { type: 'int', description: 'y coordinate' },
            'z': { type: 'int', description: 'z coordinate' }
        },
        perform: async function(agent, x, y, z) {
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPosition(x, y, z);
            };
            await agent.actions.runAction('action:lookAtPosition', actionFn);
            return result;
        }
    },
    {
        name: '!digDown',
        description: 'Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.',
        params: {'distance': { type: 'int', description: 'Distance to dig down', domain: [1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.digDown(agent.bot, distance)
        })
    },
    {
        name: '!goToSurface',
        description: 'Moves the bot to the highest block above it (usually the surface).',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.goToSurface(agent.bot);
        })
    },
    {
        name: '!useOn',
        description: 'Use (right click) the given tool on the nearest target of the given type.',
        params: {
            'tool_name': { type: 'string', description: 'Name of the tool to use, or "hand" for no tool.' },
            'target': { type: 'string', description: 'The target as an entity type, block type, or "nothing" for no target.' }
        },
        perform: runAsAction(async (agent, tool_name, target) => {
            await skills.useToolOn(agent.bot, tool_name, target);
        })
    },
];
