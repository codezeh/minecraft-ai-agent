import * as world from '../library/world.js';
import * as mc from '../../utils/mcdata.js';
import { getCommandDocs } from './index.js';
import * as skills from '../library/skills.js';
import * as store from '../library/memory_store.js';

import convoManager from '../conversation.js';
import { checkLevelBlueprint, checkBlueprint } from '../tasks/construction_tasks.js';
import { mapSummary } from '../library/map_query.js';
import { load } from 'cheerio';

const pad = (str) => {
    return '\n' + str + '\n';
}

// queries are commands that just return strings and don't affect anything in the world
export const queryList = [
    {
        name: "!stats",
        description: "Get your bot's location, health, hunger, and time of day.", 
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'STATS';
            let pos = bot.entity.position;
            // display position to 2 decimal places
            res += `\n- Position: x: ${pos.x.toFixed(2)}, y: ${pos.y.toFixed(2)}, z: ${pos.z.toFixed(2)}`;
            // Gameplay
            res += `\n- Gamemode: ${bot.game.gameMode}`;
            res += `\n- Health: ${Math.round(bot.health)} / 20`;
            res += `\n- Hunger: ${Math.round(bot.food)} / 20`;
            res += `\n- Biome: ${world.getBiomeName(bot)}`;
            let weather = "Clear";
            if (bot.rainState > 0)
                weather = "Rain";
            if (bot.thunderState > 0)
                weather = "Thunderstorm";
            res += `\n- Weather: ${weather}`;
            // let block = bot.blockAt(pos);
            // res += `\n- Artficial light: ${block.skyLight}`;
            // res += `\n- Sky light: ${block.light}`;
            // light properties are bugged, they are not accurate


            if (bot.time.timeOfDay < 6000) {
                res += '\n- Time: Morning';
            } else if (bot.time.timeOfDay < 12000) {
                res += '\n- Time: Afternoon';
            } else {
                res += '\n- Time: Night';
            }

            // get the bot's current action
            let action = agent.actions.currentActionLabel;
            if (agent.isIdle())
                action = 'Idle';
            res += `\- Current Action: ${action}`;


            let players = world.getNearbyPlayerNames(bot);
            let bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
            players = players.filter(p => !bots.includes(p));

            res += '\n- Nearby Human Players: ' + (players.length > 0 ? players.join(', ') : 'None.');
            res += '\n- Nearby Bot Players: ' + (bots.length > 0 ? bots.join(', ') : 'None.');

            res += '\n' + agent.bot.modes.getMiniDocs() + '\n';
            return pad(res);
        }
    },
    {
        name: "!inventory",
        description: "Get your bot's inventory.",
        perform: function (agent) {
            let bot = agent.bot;
            let inventory = world.getInventoryCounts(bot);
            let res = 'INVENTORY';
            for (const item in inventory) {
                if (inventory[item] && inventory[item] > 0)
                    res += `\n- ${item}: ${inventory[item]}`;
            }
            if (res === 'INVENTORY') {
                res += ': Nothing';
            }
            else if (agent.bot.game.gameMode === 'creative') {
                res += '\n(You have infinite items in creative mode. You do not need to gather resources!!)';
            }

            let helmet = bot.inventory.slots[5];
            let chestplate = bot.inventory.slots[6];
            let leggings = bot.inventory.slots[7];
            let boots = bot.inventory.slots[8];
            res += '\nWEARING: ';
            if (helmet)
                res += `\nHead: ${helmet.name}`;
            if (chestplate)
                res += `\nTorso: ${chestplate.name}`;
            if (leggings)
                res += `\nLegs: ${leggings.name}`;
            if (boots)
                res += `\nFeet: ${boots.name}`;
            if (!helmet && !chestplate && !leggings && !boots)
                res += 'Nothing';

            return pad(res);
        }
    },
    {
        name: "!nearbyBlocks",
        description: "Get the blocks near the bot.",
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'NEARBY_BLOCKS';
            let blocks = world.getNearestBlocks(bot);
            let block_details = new Set();
            
            for (let block of blocks) {
                let details = block.name;
                if (block.name === 'water' || block.name === 'lava') {
                    details += block.metadata === 0 ? ' (source)' : ' (flowing)';
                }
                block_details.add(details);
            }
            for (let details of block_details) {
                res += `\n- ${details}`;
            }
            if (block_details.size === 0) {
                res += ': none';
            } 
            else {
                res += '\n- ' + world.getSurroundingBlocks(bot).join('\n- ');
                res += `\n- First Solid Block Above Head: ${world.getFirstBlockAboveHead(bot, null, 32)}`;
            }
            return pad(res);
        }
    },
    {
        name: "!craftable",
        description: "Get the craftable items with the bot's inventory.",
        perform: function (agent) {
            let craftable = world.getCraftableItems(agent.bot);
            let res = 'CRAFTABLE_ITEMS';
            for (const item of craftable) {
                res += `\n- ${item}`;
            }
            if (res == 'CRAFTABLE_ITEMS') {
                res += ': none';
            }
            return pad(res);
        }
    },
    {
        name: "!entities",
        description: "Get the nearby players and entities.",
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'NEARBY_ENTITIES';
            let players = world.getNearbyPlayerNames(bot);
            let bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
            players = players.filter(p => !bots.includes(p));

            for (const player of players) {
                res += `\n- Human player: ${player}`;
            }
            for (const bot of bots) {
                res += `\n- Bot player: ${bot}`;
            }

            let nearbyEntities = world.getNearbyEntities(bot);
            let entityCounts = {};
            let villagerIds = [];
            let babyVillagerIds = [];
            let villagerDetails = []; // Store detailed villager info including profession
            
            for (const entity of nearbyEntities) {
                if (entity.type === 'player' || entity.name === 'item')
                    continue;
                    
                if (!entityCounts[entity.name]) {
                    entityCounts[entity.name] = 0;
                }
                entityCounts[entity.name]++;
                
                if (entity.name === 'villager') {
                    if (entity.metadata && entity.metadata[16] === 1) {
                        babyVillagerIds.push(entity.id);
                    } else {
                        const profession = world.getVillagerProfession(entity);
                        villagerIds.push(entity.id);
                        villagerDetails.push({
                            id: entity.id,
                            profession: profession
                        });
                    }
                }
            }
            
            for (const [entityType, count] of Object.entries(entityCounts)) {
                if (entityType === 'villager') {
                    let villagerInfo = `${count} ${entityType}(s)`;
                    if (villagerDetails.length > 0) {
                        const detailStrings = villagerDetails.map(v => `(${v.id}:${v.profession})`);
                        villagerInfo += ` - Adults: ${detailStrings.join(', ')}`;
                    }
                    if (babyVillagerIds.length > 0) {
                        villagerInfo += ` - Baby IDs: ${babyVillagerIds.join(', ')} (babies cannot trade)`;
                    }
                    res += `\n- entities: ${villagerInfo}`;
                } else {
                    res += `\n- entities: ${count} ${entityType}(s)`;
                }
            }
            
            if (res == 'NEARBY_ENTITIES') {
                res += ': none';
            }
            return pad(res);
        }
    },
    {
        name: "!modes",
        description: "Get all available modes and their docs and see which are on/off.",
        perform: function (agent) {
            return agent.bot.modes.getDocs();
        }
    },
    {
        name: '!savedPlaces',
        description: 'List all saved locations.',
        perform: async function (agent) {
            return "Saved place names: " + agent.memory_bank.getKeys();
        }
    }, 
    {
        name: '!checkBlueprintLevel',
        description: 'Check if the level is complete and what blocks still need to be placed for the blueprint',
        params: {
            'levelNum': { type: 'int', description: 'The level number to check.', domain: [0, Number.MAX_SAFE_INTEGER] }
        },
        perform: function (agent, levelNum) {
            let res = checkLevelBlueprint(agent, levelNum);
            console.log(res);
            return pad(res);
        }
    }, 
    {
        name: '!checkBlueprint',
        description: 'Check what blocks still need to be placed for the blueprint',
        perform: function (agent) {
            let res = checkBlueprint(agent);
            return pad(res);
        }
    }, 
    {
        name: '!getBlueprint',
        description: 'Get the blueprint for the building',
        perform: function (agent) {
            let res = agent.task.blueprint.explain();
            return pad(res);
        }
    }, 
    {
        name: '!getBlueprintLevel',
        description: 'Get the blueprint for the building',
        params: {
            'levelNum': { type: 'int', description: 'The level number to check.', domain: [0, Number.MAX_SAFE_INTEGER] }
        },
        perform: function (agent, levelNum) {
            let res = agent.task.blueprint.explainLevel(levelNum);
            console.log(res);
            return pad(res);
        }
    },
    {
        name: '!getCraftingPlan',
        description: "Provides a comprehensive crafting plan for a specified item. This includes a breakdown of required ingredients, the exact quantities needed, and an analysis of missing ingredients or extra items needed based on the bot's current inventory.",
        params: {
            targetItem: { 
                type: 'string', 
                description: 'The item that we are trying to craft' 
            },
            quantity: { 
                type: 'int',
                description: 'The quantity of the item that we are trying to craft',
                optional: true,
                domain: [1, Infinity, '[)'], // Quantity must be at least 1,
                default: 1
            }
        },
        perform: function (agent, targetItem, quantity = 1) {
            let bot = agent.bot;

            // Fetch the bot's inventory
            const curr_inventory = world.getInventoryCounts(bot); 
            const target_item = targetItem;
            let existingCount = curr_inventory[target_item] || 0;
            let prefixMessage = '';
            if (existingCount > 0) {
                curr_inventory[target_item] -= existingCount;
                prefixMessage = `You already have ${existingCount} ${target_item} in your inventory. If you need to craft more,\n`;
            }

            // Generate crafting plan
            try {
                let craftingPlan = mc.getDetailedCraftingPlan(target_item, quantity, curr_inventory);
                craftingPlan = prefixMessage + craftingPlan;
                return pad(craftingPlan);
            } catch (error) {
                console.error("Error generating crafting plan:", error);
                return `An error occurred while generating the crafting plan: ${error.message}`;
            }
            
            
        },
    },
    {
        name: '!searchWiki',
        description: 'Search the Minecraft Wiki for the given query.',
        params: {
            'query': { type: 'string', description: 'The query to search for.' }
        },
        perform: async function (agent, query) {
            const url = `https://minecraft.wiki/w/${query}`
            try {
                const response = await fetch(url);
                if (response.status === 404) {
                  return `${query} was not found on the Minecraft Wiki. Try adjusting your search term.`;
                }
                const html = await response.text();
                const $ = load(html);
            
                const parserOutput = $("div.mw-parser-output");
                
                parserOutput.find("table.navbox").remove();

                const divContent = parserOutput.text();
            
                return divContent.trim();
              } catch (error) {
                console.error("Error fetching or parsing HTML:", error);
                return `The following error occurred: ${error}`
              }
        }
    },
    {
        name: '!skillDoc',
        description: 'Show the full documentation (parameters, returns, examples) for one skill function used in !newAction. Use it when you are not sure about a signature instead of guessing.',
        params: {
            'name': { type: 'string', description: 'The exact function name from the skill catalog, e.g. "skills.buildHouse".' }
        },
        perform: function (agent, name) {
            const lib = agent.prompter?.skill_libary;
            if (!lib) return 'Skill library not ready yet.';
            const doc = lib.getSkillDoc(name);
            return pad(doc || `没有找到 ${name}。`);
        }
    },
    {
        // 判定任务是否真的完成。证据项照抄 Voyager(Voyager, NVIDIA) 的 critic 输入：
        // Biome/Time/Nearby blocks/Health/Hunger/Position/Inventory/Chests/Task。
        // 来源：https://github.com/MineDojo/Voyager/blob/main/voyager/prompts/critic.txt
        // 作用：她以前会「谎报成功」（README E3），根因是成功与否全靠她自己写在 log 里，
        // 没有一次「拿事实对一遍」的动作。这个命令只负责摆出事实，判断仍由模型做。
        name: '!checkTask',
        description: 'Check honestly whether a task is really finished, using ground truth (inventory, nearby blocks, position, chests). Call this BEFORE telling the player a task is done; never claim success without it.',
        params: {
            'task': { type: 'string', description: 'What the task was supposed to achieve, e.g. "build a 9x9 storage room".' }
        },
        perform: async function (agent, task) {
            const bot = agent.bot;
            // 这里必须用动态 import：queries.js 与 commands/index.js 本身是循环依赖，
            // 顶层 import getCommand 会在「先加载 queries.js」的场景下踩 TDZ
            // （Cannot access 'queryList' before initialization）。
            const { getCommand } = await import('./index.js');
            let evidence = `TASK: ${task}\n`;

            // 事实优先：这些都是回读世界状态，不是模型自己的记忆
            try {
                evidence += '\n' + await getCommand('!stats').perform(agent);
            } catch (e) { evidence += `\n(stats 读取失败: ${e.message})`; }
            try {
                evidence += '\n' + await getCommand('!inventory').perform(agent);
            } catch (e) { evidence += `\n(inventory 读取失败: ${e.message})`; }
            try {
                evidence += '\n' + await getCommand('!nearbyBlocks').perform(agent);
            } catch (e) { evidence += `\n(nearbyBlocks 读取失败: ${e.message})`; }
            try {
                const status = await skills.reportStatus(bot);
                evidence += `\n威胁: ${status.threat} | 空格子: ${status.freeSlots} | 记住的箱子: ${status.knownChest}\n`;
            } catch (e) { evidence += `\n(reportStatus 读取失败: ${e.message})`; }

            evidence += `
怎么判（照 Voyager critic 的规则）：
- 挖/采类：只看背包里对应物品数量是否够。
- 合成/冶炼类：只看背包里成品是否出现。
- 放置/建造类：只看 nearbyBlocks 或已记录工地里的方块是否真的在那儿；探索过不等于建好。
- 存入箱子类：只看箱子里的内容，不看背包。
- 交付给玩家类：要对方确认收到，不能只看自己背包少了东西。
- 吃东西类：饥饿值到 20 才算成功。

要求：先对着上面的数字判真伪，再决定怎么说。
- 证据不足或没达成 → 绝不要说"建好了/放完了/完成了"，直接说还差什么、下一步做什么。
- 只有证据明确支持时，才用一句话说完成，并带上依据（例如"箱子 12/12 个都放好了"）。`;
            return pad(evidence);
        }
    },
    {
        // 直接命令版的地形探查：不用写 !newAction 代码就能看地形。
        // 半径可省（默认 64 = 实测安全值：危险枚举 183ms；128 格要 1 秒会掉心跳）。
        name: '!survey',
        description: 'Scan the terrain around you and report dangers plus a small map. Read-only. Use it before deciding where to go or build.',
        params: {
            'radius': {
                type: 'int',
                description: 'How far to scan in blocks. Optional, defaults to 64 (128 takes ~1s).',
                domain: [16, 128],
                default: 64,
            }
        },
        perform: function (agent, radius = 64) {
            const r = Math.max(16, Math.min(128, radius ?? 64));
            const s = skills.surveyArea(agent.bot, r);
            // 高度要分开说清楚，否则"y=51~85"这种数字会误导：
            // 那里面混着水下海床和她自己盖的建筑，不是她要走的地面高度。
            let hz = '';
            const g = s.groundStats;
            if (g && g.groundMedian != null) {
                const myY = Math.floor(agent.bot.entity.position.y);
                hz = `\n地面高度：多半在 y=${g.displayMin}~${g.displayMax}（中位 ${g.groundMedian}），` +
                    `你脚下 y=${myY}`;
                if (g.allMin !== g.groundMin || g.allMax !== g.groundMax) {
                    hz += `；全程极值 y=${g.allMin}~${g.allMax}（含水下/建筑，别当路面看）`;
                }
                hz += `。图里数字是这 10 档的相对高度，不是精确 y`;
            }
            // 位置 + 朝向 + 坐标轴：三样缺一件，这张图她都用不上
            const posLine = s.position
                ? `你在 (${s.position.x}, ${s.position.z})，脚下地表 y=${s.position.y}` +
                  (s.facing ? `，${s.facing.text}` : '') + '。地图形：上=北(z小)，右=东(x大)。'
                : '';
            const extLine = s.extent
                ? `图覆盖 x ${s.extent.xFrom}..${s.extent.xTo} / z ${s.extent.zFrom}..${s.extent.zTo}，每格 ${s.blockSize} 格。`
                : `覆盖 ${s.covers}。`;
            return pad(`${posLine}${extLine}${hz}
${s.summary}
${s.legend}
${s.ascii}`);
        }
    },
    {
        // 列出记着的危险团块（带编号），方便指定删掉其中某一条。
        name: '!hazards',
        description: 'List the remembered terrain hazards with their index, position, size and age. Use it to find which one to drop with !forgetHazards(index). Read-only.',
        perform: function (agent) {
            const list = store.readStore(agent.bot, 'hazards') || [];
            if (!list.length) return pad('现在没有记着任何地形危险。');
            const now = Date.now();
            const lines = list.map((b, i) => {
                const ageMin = b.seenAt ? Math.round((now - b.seenAt) / 60000) : null;
                const n = b.count || ((b.x1 - b.x0 + 1) * (b.z1 - b.z0 + 1));
                return `${i + 1}. (${b.x0}~${b.x1}, ${b.z0}~${b.z1}) ${n} 格` +
                    (ageMin !== null ? `，${ageMin} 分钟前确认` : '') +
                    (b.hits ? `，确认过 ${b.hits} 次` : '');
            });
            return pad(`记着 ${list.length} 处地形危险：\n${lines.join('\n')}\n` +
                `删掉某一条用 !forgetHazards(编号)；不带编号则全部清空。`);
        }
    },
    {
        // 清掉地形危险记忆。不带编号 = 全清；带编号 = 只删那一条。
        name: '!forgetHazards',
        description: 'Forget remembered terrain hazards (lava/fire/cactus outlines) when they are wrong or a lava pool has been filled in. No argument clears all; pass an index from !hazards to drop just that one. Memory only - does not change the world.',
        params: {
            'index': {
                type: 'int',
                description: 'Optional 1-based index from !hazards. Omit to clear everything.',
                domain: [1, Number.MAX_SAFE_INTEGER],
                default: 0,
            }
        },
        perform: function (agent, index = 0) {
            const prev = store.readStore(agent.bot, 'hazards') || [];
            // 无论删几条，都要让内存缓存失效 —— 否则下一次调用会拿到已删掉的旧结果
            skills.resetHazardCache();

            if (!index) {
                store.writeStore(agent.bot, 'hazards', []);
                return pad(`已清空地形危险记忆，删掉 ${prev.length} 处。下次探查会重新探测。`);
            }
            if (index < 1 || index > prev.length) {
                return pad(`编号 ${index} 不存在（现有 ${prev.length} 处）。先用 !hazards 看编号。`);
            }
            const removed = prev[index - 1];
            const rest = prev.filter((_, i) => i !== index - 1);
            store.writeStore(agent.bot, 'hazards', rest);
            return pad(`已删掉第 ${index} 处：(${removed.x0}~${removed.x1}, ${removed.z0}~${removed.z1})。` +
                `还剩 ${rest.length} 处。\n注意：下次走到那儿会重新探测，如果岩浆还在就会被重新记住。`);
        }
    },
    {
        // 直接命令版的规划：只算不动身，符合"先规划后行动"。
        name: '!plan',
        description: 'Plan a route to (x, z) WITHOUT moving: shows waypoints, what each leg needs (walk/swim/pillar_up), and the risk. Read-only.',
        params: {
            'x': { type: 'int', description: 'Target x coordinate.' },
            'z': { type: 'int', description: 'Target z coordinate.' },
        },
        perform: function (agent, x, z) {
            const p = skills.planRoute(agent.bot, x, z);
            if (p.alreadyThere) return pad(`已经在 (${x},${z}) 附近了，不用走。`);
            if (!p.ok) return pad(`去 (${x},${z}) 没有可行路线：${p.reason}`);
            const acts = Object.entries(p.actions || {}).map(([k, v]) => `${k}x${v}`).join(', ') || '无';
            // 先把「从哪、面朝哪、目标在我哪一边」交代清楚，再给路点。
            // 只给绝对方位的话，她还得自己拿朝向换算一遍 —— 那个环节以前出过错。
            const org = p.origin
                ? `从 (${p.origin.x},${p.origin.z})` +
                  (p.facing ? `，${p.facing.text}` : '') +
                  (p.relativeDirection ? `，目标在你的${p.relativeDirection}` : '') +
                  '。'
                : '';
            // 把终点高度写出来：只给 (x,z) 的话，她没法判断是要挖下去还是垫上去
            const tgtY = (typeof p.targetY === 'number') ? ` y=${p.targetY}` : '';
            let head = `${org}去 (${x},${z})${tgtY} 可行：目标在${p.direction}方`;
            // 起手方向 != 目标方向 = 要绕。说清楚"先往哪"和"为什么"，别让她自己从坐标推
            if (p.startDirection && p.startDirection !== p.direction) {
                head += `，但第一步先往${p.startDirection}`;
            }
            head += `。${p.waypoints.length} 个途经点，动作 ${acts}，直线约 ${p.stats?.dist ?? '?'} 格`;
            if (p.why) head += `\n为什么这么走：${p.why}`;
            const pts = p.waypoints.slice(0, 12)
                .map((w, i) => `${i + 1}.(${w.x},${w.z})${w.action && w.action !== 'walk' ? ' ' + w.action : ''}`)
                .join(' ');
            return pad(`${head}\n途经点：${pts}${p.waypoints.length > 12 ? ' …' : ''}`);
        }
    },
    {
        name: '!help',
        description: 'Lists all available commands and their descriptions.',
        perform: async function (agent) {
            return getCommandDocs(agent);
        }
    },
    {
        name: '!map',
        description: 'Read my chunk map: what is around me, which direction landmarks/water/flat ground are, and which directions are still unexplored. Read-only. Use "refresh" to rescan.',
        params: {
            'refresh': {
                type: 'boolean',
                description: 'Rescan the surrounding area first (8x8 chunks, ~50ms). Optional, defaults to false.',
                default: false,
            },
            'x': { type: 'float', description: 'Optional: plan a coarse route to this x. Omit if not planning a route.', domain: [-Infinity, Infinity], default: null },
            'z': { type: 'float', description: 'Optional: plan a coarse route to this z.', domain: [-Infinity, Infinity], default: null },
        },
        perform: function (agent, refresh, x, z) {
            const goal = (Number.isFinite(x) && Number.isFinite(z)) ? { x, z } : null;
            return mapSummary(agent.bot, { refresh: !!refresh, goal });
        }
    },
];
