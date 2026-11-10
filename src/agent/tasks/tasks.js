import { readFileSync , writeFileSync, existsSync} from 'fs';
import { executeCommand } from '../commands/index.js';
import { getPosition } from '../library/world.js';
import { ConstructionTaskValidator, Blueprint } from './construction_tasks.js';
import { CookingTaskInitiator } from './cooking_tasks.js';
// F-EXEC-101：sink 级斜杠闸（包住 bot.chat，新增调用点无法静默绕过）
import { installTaskChatGuard } from './task_chat.js';
// ★ R6 #17：等同伙 bot 到齐 = **轮询等待**，超时只摘自己（不再 killAll 关整机）
import {
    waitForAgents,
    describeWaitResult,
    readEnvMs,
    TEAMMATE_WAIT_EXIT_CODE,
    DEFAULT_WAIT_TIMEOUT_MS,
    DEFAULT_POLL_INTERVAL_MS,
    MIN_WAIT_TIMEOUT_MS,
    MAX_WAIT_TIMEOUT_MS,
    MIN_POLL_INTERVAL_MS,
    MAX_POLL_INTERVAL_MS,
} from './wait_for_teammates.js';

/** 等同伙的超时（可用 `MC_TASK_WAIT_BOTS_MS` 覆盖；默认 60s）。 */
const WAIT_BOTS_TIMEOUT_MS = readEnvMs(
    'MC_TASK_WAIT_BOTS_MS', DEFAULT_WAIT_TIMEOUT_MS, MIN_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS,
);
/** 轮询间隔（可用 `MC_TASK_WAIT_BOTS_INTERVAL_MS` 覆盖；默认 500ms）。 */
const WAIT_BOTS_INTERVAL_MS = readEnvMs(
    'MC_TASK_WAIT_BOTS_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS,
);

const PROGRESS_FILE = './hells_kitchen_progress.json';

const hellsKitchenProgressManager = {
  readProgress: function() {
    try {
      if (existsSync(PROGRESS_FILE)) {
        const data = readFileSync(PROGRESS_FILE, 'utf8');
        return JSON.parse(data);
      }
    } catch (err) {
      console.error('Error reading progress file:', err);
    }
    return { taskId: null, agent0Complete: false, agent1Complete: false };
  },
  
  writeProgress: function(progress) {
    try {
      writeFileSync(PROGRESS_FILE, JSON.stringify(progress), 'utf8');
    } catch (err) {
      console.error('Error writing progress file:', err);
    }
  },
  
  resetTask: function(taskId) {
    const progress = { taskId, agent0Complete: false, agent1Complete: false };
    this.writeProgress(progress);
    return progress;
  },
  
  updateAgentProgress: function(taskId, agentId, isComplete) {
    const progress = this.readProgress();
    
    // If it's a different task, reset first
    if (progress.taskId !== taskId) {
      progress.taskId = taskId;
      progress.agent0Complete = false;
      progress.agent1Complete = false;
    }
    
    // Update the specific agent's status
    if (agentId === 0) progress.agent0Complete = isComplete;
    if (agentId === 1) progress.agent1Complete = isComplete;
    
    this.writeProgress(progress);
    return progress;
  },
  
  isTaskComplete: function(taskId) {
    const progress = this.readProgress();
    if (progress.taskId !== taskId) return false;
    return progress.agent0Complete && progress.agent1Complete;
  }
};


//todo: modify validator code to return an object with valid and score -> do more testing hahah
//todo: figure out how to log these things to the same place as bots/histories
// export class CraftTaskValidator {
//     constructor(data, agent) {
//         this.target = data.target;
//         this.number_of_target = data.number_of_target;
//         this.agent = agent;

/**
 * Validates the presence of required items in an agent's inventory
 * @param {Object} data - Task data containing target and quantity information
 * @param {Object} agent - Agent object with bot inventory
 * @returns {Object} Validation result with success status and missing items
 */
function checkItemPresence(data, agent) {

    try {
        // Special handling for hells_kitchen tasks
        if (data.task_id && data.task_id.endsWith('hells_kitchen') && Array.isArray(data.target) && data.target.length === 2) {
            
            // Get agent ID and target for this agent
            const agentId = agent.count_id;
            
            if (agentId === 0 || agentId === 1) {
                // Use only the corresponding element from the target list
                const targetForThisAgent = data.target[agentId];
                const modifiedData = {
                    ...data,
                    target: targetForThisAgent
                };
                
                // Check if this agent has their required item
                const agentResult = checkItemForSingleAgent(modifiedData, agent);
                
                // Update the file-based progress tracker
                const progress = hellsKitchenProgressManager.updateAgentProgress(
                    data.task_id, 
                    agentId, 
                    agentResult.success
                );
                
                // // Log the current state
                // console.log(`Agent ${agentId} has item: ${agentResult.success}`);
                // console.log(`Task state: Agent0=${progress.agent0Complete}, Agent1=${progress.agent1Complete}`);
                
                // Return combined result - success only if both agents have their items
                return {
                    success: progress.agent0Complete && progress.agent1Complete,
                    missingItems: agentResult.missingItems,
                    agentComplete: agentResult.success  // Individual agent status for debugging
                };
            }
        }
        
        // Non-hells_kitchen tasks use the standard check
        return checkItemForSingleAgent(data, agent);
        
    } catch (error) {
        console.error('Error checking item presence:', error);
        return {
            success: false,
            missingItems: [],
            error: error.message
        };
    }
}


/**
 * Helper function to check a single agent's inventory
 * Extracted from the original checkItemPresence logic
 */
function checkItemForSingleAgent(data, agent) {
    function isTargetDictionaryWithQuantities(target) {
        return typeof target === 'object' && 
               !Array.isArray(target) && 
               target !== null &&
               Object.values(target).every(value => typeof value === 'number');
    }
    
    function normalizeTargets(target) {
        if (typeof target === 'string') {
            return { [target]: 1 };
        } else if (Array.isArray(target)) {
            return target.reduce((acc, item) => {
                acc[item] = 1;
                return acc;
            }, {});
        } else if (typeof target === 'object' && target !== null) {
            return target;
        }
        throw new Error('Invalid target format');
    }
    
    function normalizeQuantities(targets, quantities) {
        if (quantities === undefined) {
            return Object.keys(targets).reduce((acc, key) => {
                acc[key] = 1;
                return acc;
            }, {});
        } else if (typeof quantities === 'number') {
            return Object.keys(targets).reduce((acc, key) => {
                acc[key] = quantities;
                return acc;
            }, {});
        } else if (typeof quantities === 'object' && quantities !== null) {
            return quantities;
        }
        throw new Error('Invalid number_of_target format');
    }
    
    // First normalize targets to always have a consistent format
    const targets = normalizeTargets(data.target);
    
    // Determine the required quantities
    const requiredQuantities = isTargetDictionaryWithQuantities(data.target) 
        ? data.target 
        : normalizeQuantities(targets, data.number_of_target);

    // Count items in inventory
    const inventoryCount = {};
    agent.bot.inventory.slots.forEach((slot) => {
        if (slot) {
            const itemName = slot.name.toLowerCase();
            inventoryCount[itemName] = (inventoryCount[itemName] || 0) + slot.count;
        }
    });

    // Check if all required items are present in sufficient quantities
    const missingItems = [];
    let allTargetsMet = true;

    for (const [item, requiredCount] of Object.entries(requiredQuantities)) {
        const itemName = item.toLowerCase();
        const currentCount = inventoryCount[itemName] || 0;
        if (currentCount < requiredCount) {
            allTargetsMet = false;
            missingItems.push({
                item: itemName,
                required: requiredCount,
                current: currentCount,
                missing: requiredCount - currentCount
            });
        }
    }

    return {
        success: allTargetsMet,
        missingItems: missingItems
    };
}



class CookingCraftingTaskValidator {
    constructor(data, agent) {
        this.data = data;
        this.agent = agent;
    } 
    validate() {
        const result = checkItemPresence(this.data, this.agent);
        let score = 0;
        if (result.success) {
            score = 1;
        }
        return {
            "valid": result.success, 
            "score": score,
        };
    }
}

export class Task {
    constructor(agent, task_data, taskStartTime = null) {
        this.agent = agent;
        this.data = null;
        if (taskStartTime !== null)
            this.taskStartTime = taskStartTime;
        else
            this.taskStartTime = Date.now();
        this.validator = null;
        this.reset_function = null;
        this.blocked_actions = [];
        this.task_data = task_data;
        if (task_data) {
            console.log('Starting task', task_data.task_id);
            console.log("Task start time set to", this.taskStartTime);
            if (task_data.task_id.endsWith('hells_kitchen')) {
                // Reset hells_kitchen progress when a new task starts
                hellsKitchenProgressManager.resetTask(task_data.task_id);
                console.log('Reset Hells Kitchen progress for new task');
            }
            this.data = task_data;
            this.task_type = this.data.type;
            if (this.task_type === 'construction' && this.data.blueprint) {
                this.blueprint = new Blueprint(this.data.blueprint);
                this.goal = this.data.goal + ' \n' + this.blueprint.explain() + " \n" + "make sure to place the lower levels of the blueprint first";
                this.conversation = this.data.conversation + ' \n' + this.blueprint.explain();
            } else {
                this.goal = this.data.goal;
                this.conversation = this.data.conversation;
            }
            this.taskTimeout = this.data.timeout || 300;
            // Set validator based on task_type

            // do goal initialization here

            // let agentGoal = this.getAgentGoal();
            // if (agentGoal) {
            //     agentGoal += "You have to collaborate with other agents/bots, namely " + this.available_agents.filter(n => n !== this.name).join(', ') + " to complete the task as soon as possible by dividing the work among yourselves.";
            //     console.log(`Setting goal for agent ${this.agent.count_id}: ${agentGoal}`);
            //     await executeCommand(this.agent, `!goal("${agentGoal}")`);
            // }

            if (this.task_type === 'construction') {
                this.validator = new ConstructionTaskValidator(this.data, this.agent);
            } else if (this.task_type === 'cooking' || this.task_type === 'techtree') {
                this.validator = new CookingCraftingTaskValidator(this.data, this.agent);

            } else {
                this.validator = null;
            }

            if (this.data.blocked_actions) {
                this.blocked_actions = this.data.blocked_actions[this.agent.count_id.toString()] || [];
            } else {
                this.blocked_actions = [];
            }
            this.restrict_to_inventory = !!this.data.restrict_to_inventory;
            if (this.data.goal)
                this.blocked_actions.push('!endGoal');
            if (this.conversation)
                this.blocked_actions.push('!endConversation');
        }
        else {
            console.log('No task.');
        }

        this.name = this.agent.name;
        this.available_agents = []
    }

    updateAvailableAgents(agents) {
        this.available_agents = agents
    }

    /**
     * 等其它 bot 到齐（★ R6 #17）。
     *
     * 缺陷原貌：`// TODO wait for other bots to join` 的全部实现就是
     * `await sleep(10000)` 然后判人数 —— 早到/晚到都判错（Paper 重启要 20~60 秒，
     * 晚 11 秒进来的 bot 在早到者眼里就是「人不齐」）。
     *
     * 现在：轮询等待（默认每 500ms 查一次、最多 60s），人齐立刻继续。
     *
     * @param {object} [opts] 透传给 waitForAgents 的覆盖项（用例用 timeoutMs/intervalMs/sleep）
     * @returns {Promise<{ok:boolean, required:number, present:number, waitedMs:number, polls:number, skipped?:boolean}>}
     */
    async waitForOtherBots(opts = {}) {
        const required = Number(this.data?.agent_count) || 0;
        // 单机任务（agent_count <= 1 或压根没配）根本不用等
        if (required <= 1) {
            return {
                ok: true,
                skipped: true,
                required,
                present: this.available_agents?.length ?? 0,
                waitedMs: 0,
                polls: 0,
            };
        }
        const r = await waitForAgents({
            required,
            present: () => (Array.isArray(this.available_agents) ? this.available_agents.length : 0),
            timeoutMs: WAIT_BOTS_TIMEOUT_MS,
            intervalMs: WAIT_BOTS_INTERVAL_MS,
            ...opts,
        });
        if (!r.ok) console.error(`[task] ${describeWaitResult(r)}`);
        else if (!r.skipped) console.log(`[task] ${r.required} 只 bot 已到齐（等了 ${r.waitedMs}ms，轮询 ${r.polls} 次）`);
        return r;
    }

    /**
     * 「这只 bot 自己退场」——★ R6 #17：**绝不再用 `killAll()`**。
     *
     * 病根：`killAll()` → `mindserver_proxy.shutdown()` → `socket.emit('shutdown')`
     * ⇒ **整套服务退出**（其它 bot、面板、任务板数据库一起没）。这与
     * `agent_process.js:47-55`「单个 agent 退出不许拖垮整个 mindserver」直接冲突：
     * 一次启动顺序抖动（某只 bot 晚 11 秒）就能把整机停服。
     *
     * 现在走 `cleanKill(msg, 4)`：退出码 4 > 1 ⇒ `planExit()` 走 `unregister` ——
     * **只注销、摘掉这一个 agent**，其它进程照常。
     *
     * @param {string} msg 为什么要退（会进日志与 bot 的聊天）
     */
    detachSelf(msg) {
        console.error(`[task] ${msg}`);
        try {
            // 退出码 4 = 只摘自己（见 wait_for_teammates.js 的 TEAMMATE_WAIT_EXIT_CODE）
            this.agent.cleanKill?.(msg, TEAMMATE_WAIT_EXIT_CODE);
        } catch (e) {
            // cleanKill 内部要碰 bot.chat / history（任务初始化阶段可能半坏），
            // 它自己抛出来同样不能带走别的进程 —— 记下来，交给上层流程。
            console.error(`[task] 摘除自身时异常（已兜住）: ${e?.message ?? e}`);
        }
    }

    // Add this method if you want to manually reset the hells_kitchen progress
    resetHellsKitchenProgress() {
        if (this.task_id && this.task_id.endsWith('hells_kitchen')) {
            hellsKitchenProgressManager.resetTask(this.task_id);
            console.log('Hells Kitchen progress reset manually');
        }
    }

    getAgentGoal() {
        if (!this.data || !this.data.goal) {
            return null;
        }

        let add_string = '';

        if (this.task_type === 'cooking') {


            if (this.data.agent_count > 2) {

                if (this.name.toLowerCase().startsWith('andy')) {
                    add_string = '\nIn the end, all the food items should be given to you by other bots. Make sure to talk to all the agents using startConversation command to coordinate the task instead of talking to just one agent. You can even end current conversation with any agent using endConversation command and then talk to a new agent using startConversation command.';
                } 
                else {
                    add_string = '\nIn the end, all the food items should be given to one single bot whose name starts with andy or Andy. Make sure to talk to all the agents using startConversation command to coordinate the task instead of talking to just one agent. You can even end current conversation with any agent using endConversation command and then talk to a new agent using startConversation command.';
                }   
            } 
            else {
                if (this.data.task_id && this.data.task_id.endsWith('hells_kitchen')) {
                    add_string = '';
                } 
                else {
                add_string = '\nIn the end, all the food items should be given to one single bot.';
                }
            }
        }

        if (this.task_type === 'techtree') {
            if (this.data.agent_count > 2) {
                add_string = '\nMake sure to share resources among all agents and to talk to all the agents using startConversation command to coordinate the task instead of talking to just one agent. You can even end current conversation with any agent using endConversation command and then talk to a new agent using startConversation command.'
            }
        }

        // If goal is a string, all agents share the same goal
        if (typeof this.data.goal === 'string') {
            return this.data.goal + add_string;
        }

        // If goal is an object, get the goal for this agent's count_id
        if (typeof this.data.goal === 'object' && this.data.goal !== null) {
            const agentId = this.agent.count_id.toString();
            return (this.data.goal[agentId] || '') + add_string;
        }

        return null;
    }

    isDone() {
        let res = null;
        if (this.validator)
            res = this.validator.validate();
        if (res && res.valid) {
            // Find all the agents and clear their inventories
            for (let agent of this.available_agents) {
                this.agent.bot.chat(`/clear ${agent}`);
            }
            // this.agent.bot.chat(`/clear @a`);
            return {"message": 'Task successful', "score": res.score};
        }
        let other_names = this.available_agents.filter(n => n !== this.name);
        const elapsedTime = (Date.now() - this.taskStartTime) / 1000;

        if (elapsedTime >= 30 && this.available_agents.length !== this.data.agent_count) {
            console.log('No other agents found. Task unsuccessful.');
            return {"message": 'No other agents found', "score": 0};
        }
        
        if (this.taskTimeout) {
            if (elapsedTime >= this.taskTimeout) {
                console.log('Task timeout reached. Task unsuccessful.');
                if (res) {
                    return {"message": 'Task timeout reached', "score": res.score};
                } else {
                    return {"message": 'Task timeout reached', "score": 0};
                }
                
            }
        }
        return false;
    }

    async setAgentGoal() {
        let agentGoal = this.getAgentGoal();
        if (agentGoal && this.data.agent_count + this.data.human_count > 1) {
            agentGoal += "You have to collaborate with other agents/bots, namely " + this.available_agents.filter(n => n !== this.name).join(', ') + " to complete the task as soon as possible by dividing the work among yourselves.";
            console.log(`Setting goal for agent ${this.agent.count_id}: ${agentGoal}`);
        }
        if (!agentGoal) return;
        // internal: 代码自己设的目标（不是玩家发言）—— 按 M1 的发言人分级（08 §5）走主人级，
        // 否则「!goal 是主人级命令、这里没有 author」会被自己的权限闸门拦掉。
        // 第1条 ⑤：agentGoal 是**任务 JSON 里的数据**，走参数通道而不是拼进命令串 ——
        // 原来 `` `!goal("${agentGoal}")` `` + internal:true 等于「改 JSON 就能以主人身份执行任意命令」。
        await executeCommand(this.agent, { command: '!goal', args: [String(agentGoal)] }, { internal: true });
    }

    async initBotTask() {
        // ★ F-EXEC-202（2026-11-06）：任务脚本里的 cheat 指令闸，**默认关闭（fail-closed）**。
        //
        // 背景：cooking_tasks.js / 本文件共有 38 处裸 `bot.chat('/…')`，绕过 atom_input_misc.command()
        // 的白名单与等级判定。最重的几条：cooking 的 8 条 `/fill`（合并 100×100×10，不可撤销）、
        // `/kill @e[type=…,distance=..200]`（200 格内该类实体全清）、以及 `/clear`（清背包）。
        //
        // 【为什么是"逐段跳过"而不是"整段 return"】（复核席打回后的修法）
        //   上一版在函数开头直接 return，会连带跳过：等待、initiator 赋值、human 清包、
        //   **teleportBots()（bot 不传送，会在原地乱走）**、agent_count 检查、缺同伙时摘自己、startConversation。
        //   而日志只写"拒绝执行 cheat" ⇒ 照日志排障会得出"只有 cheat 被挡、其它正常"的**错误结论**。
        //   现在：只跳过 cheat 那几段，其余照常；日志**逐条列出"拦了什么、什么照常执行"**。
        //
        // 【已知边界，别读成"彻底修好"】闸在**调用方**不在 sink：CookingTaskInitiator.*、
        //   Task.teleportBots() 等公开方法自身没有判据。今天没有第二调用点，但将来任何新调用
        //   都会静默绕过。彻底修法是 guardedChat 下沉到 sink —— 已单独立单，标"待真机环境"。
        const cheatsAllowed = process.env.ALLOW_TASK_CHEATS === '1';
        // ★ F-EXEC-101（2026-11-06）：**把校验下沉到 sink**。
        // 上面那段 `if (!cheatsAllowed)` 只是"跳过已知的几段"，绕过 whitelist 的本质没变
        // （新增一处 `bot.chat('/op x')` 照样静默生效）。这里在 bot 上装 sink 级闸：
        // 之后**任何**以 `/` 开头的 bot.chat 都要过 permissions 的同一张白名单，
        // 作弊类还要 ALLOW_TASK_CHEATS=1。装一次即幂等，不重复套层。
        installTaskChatGuard(this.agent.bot, {
            onBlocked: (v, msg) => console.error(`[F-EXEC-101] 任务脚本斜杠命令被拦：${v.reason} | ${String(msg).slice(0, 80)}`),
        });
        if (!cheatsAllowed) {
            console.error('[F-EXEC-202] ALLOW_TASK_CHEATS 未设为 1 ⇒ 跳过 cheat 段，其余流程照常。');
            console.error('  ✗ 跳过：`/clear <bot名>`（清空 bot 背包）');
            console.error('  ✗ 跳过：cooking 任务的场景搭建（内含 8 条 /fill = 100×100×10 不可撤销，');
            console.error('          以及 /kill @e[type=…,distance=..200] 清 200 格内实体）');
            console.error('  ✗ 跳过：`/clear <玩家名>`（清人类背包）');
            // ★ R6 #17：这一句原来写的是「killAll()」。缺同伙现在已经**不再关整机**
            //   （只摘自己），日志必须跟着改 —— 否则照日志排障会以为"整机是被任务关的"。
            console.error('  ✓ 照常：等待、teleportBots()、agent_count 检查、缺同伙时只摘自己（不关整机）、startConversation');
            console.error('  ⇒ 结果：**场景没有搭起来**（这是"部分解决"，不是"cheat 被拦、其它全好"）。');
            console.error('  确实需要跑（只在造场景/测试时）请设 ALLOW_TASK_CHEATS=1 后重启。');
        } else {
            await this.agent.bot.chat(`/clear ${this.name}`);
            console.log(`Cleared ${this.name}'s inventory.`);
        }

        //wait for a bit so inventory is cleared
        await new Promise((resolve) => setTimeout(resolve, 500));

        if (this.data === null)
            return;

        if (this.task_type === 'cooking') {
            if (cheatsAllowed) {
                this.initiator = new CookingTaskInitiator(this.data, this.agent.bot);
            } else {
                // 场景搭建本身就是 cheat（/fill + /kill），不允许时**不建场景**；
                // 但保留 initiator 为 null 让后续流程照常走（不整段 return）。
                console.error('[F-EXEC-202] cooking 场景未搭建：initiator=null，后续流程继续执行。');
                this.initiator = null;
            }
        } else {
            this.initiator = null;
        }

        //wait for a bit so bots are teleported
        await new Promise((resolve) => setTimeout(resolve, 3000));

        if (this.agent.count_id === 0 && this.data.human_count > 0) {
            if (!cheatsAllowed) {
                console.error('[F-EXEC-202] 跳过 `/clear <玩家名>`（cheat 段未允许）；玩家背包保持原样。');
            } else {
                console.log('Clearing human player inventories');
                for (let i = 0; i < this.data.human_count; i++) {
                    const username = this.data.usernames[i];
                    await this.agent.bot.chat(`/clear ${username}`);
                }
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
        }

        if (this.data.initial_inventory) {
            console.log("Setting inventory...");
            let initialInventory = {};
            
            initialInventory = this.data.initial_inventory[this.agent.count_id.toString()] || {};
            console.log("Initial inventory for agent", this.agent.count_id, ":", initialInventory);
            console.log("")

            if (this.data.human_count > 0 && this.agent.count_id === 0) {
                // this.num_humans = num_keys - this.data.num_agents;
                if (this.data.human_count !== this.data.usernames.length) {
                    console.log(`Number of human players ${this.human_count} does not match the number of usernames provided. ${this.data.usernames.length}`);
                    throw new Error(`Number of human players ${this.human_count} does not match the number of usernames provided. ${this.data.usernames.length}`);
                    return;
                }
                
                const starting_idx = this.data.agent_count;
                for (let i = 0; i < this.data.human_count; i++) {
                    const username = this.data.usernames[i];
                    const inventory = this.data.initial_inventory[starting_idx + i];
                    console.log(Object.keys(inventory));
                    for (let key of Object.keys(inventory)) {
                        const itemName = key.toLowerCase();
                        const quantity = inventory[key];
                        console.log(`Give ${username} ${quantity} ${itemName}`);
                        await this.agent.bot.chat(`/give ${username} ${itemName} ${quantity}`);
                    }
                }
            }
            console.log(this.data.initial_inventory);

            // Assign inventory items
            for (let key of Object.keys(initialInventory)) {
                const itemName = key.toLowerCase();
                const quantity = initialInventory[key];
                await this.agent.bot.chat(`/give ${this.name} ${itemName} ${quantity}`);
                console.log(`Gave ${this.name} ${quantity} ${itemName}`);
            }

            // Wait briefly for inventory commands to complete
            await new Promise((resolve) => setTimeout(resolve, 500));
        }

        if (this.initiator && this.agent.count_id === 0) {
            await this.initiator.init();
        }

        await this.teleportBots();

        if (this.data.agent_count && this.data.agent_count > 1) {
            // ★ R6 #17：轮询等待其它 bot 到齐（原来这里是固定 10s sleep + killAll()）。
            //   人齐就立刻继续（不再白等 10 秒）；超时只摘自己，**绝不关整机**。
            const ready = await this.waitForOtherBots();
            if (!ready.ok) {
                this.detachSelf(`${describeWaitResult(ready)} —— 任务未开始。`);
                return;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (this.data.conversation && this.agent.count_id === 0) {
            let other_name = this.available_agents.filter(n => n !== this.name)[0];
            let waitCount = 0;
            while (other_name === undefined && waitCount < 20) {
                other_name = this.available_agents.filter(n => n !== this.name)[0];
                await new Promise((resolve) => setTimeout(resolve, 1000));
                waitCount++;
            }
            if (other_name === undefined && this.data.agent_count > 1) {
                // ★ R6 #17：这里原来也是 `killAll()`（关整机）。
                //   「缺同伙」= 这只 bot 自己的任务做不成，不是全队该停 —— 只摘自己。
                //   另外必须先 return：再往下会用空名字发 !startConversation，等于让一只
                //   做不成任务的 bot 继续瞎跑。
                this.detachSelf('No other agents found. Task unsuccessful. —— 只摘掉自己，不关整机。');
                return;
            }
            // internal: 同上 —— 由代码发起，不是玩家发言（08 §5）
            // 第1条 ⑤：conversation 是任务 JSON 里的数据，走参数通道（原来拼进命令串 = 注入面）
            await executeCommand(
                this.agent,
                { command: '!startConversation', args: [String(other_name ?? ''), String(this.data.conversation ?? '')] },
                { internal: true },
            );
        }
        await this.setAgentGoal();
    }
    
    async teleportBots() {
        console.log('\n\nTeleporting bots');
        function getRandomOffset(range) {
            return Math.floor(Math.random() * (range * 2 + 1)) - range;
        }

        let human_player_name = null;
        let bot = this.agent.bot;

        // Finding if there is a human player on the server
        for (const playerName in bot.players) {
            const player = bot.players[playerName];
            if (!this.available_agents.some((n) => n === playerName)) {
                console.log('Found human player:', player.username);
                human_player_name = player.username
                break;
            }
        }

        // go the human if there is one and not required for the task
        if (human_player_name && this.data.human_count === 0) {
            console.log(`Teleporting ${this.name} to human ${human_player_name}`)
            bot.chat(`/tp ${this.name} ${human_player_name}`)
        }
        else {
            console.log(`Teleporting ${this.name} to ${this.available_agents[0]}`)
            bot.chat(`/tp ${this.name} ${this.available_agents[0]}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 200));

        // now all bots are teleport on top of each other (which kinda looks ugly)
        // Thus, we need to teleport them to random distances to make it look better

        /*
        Note : We don't want randomness for construction task as the reference point matters a lot.
        Another reason for no randomness for construction task is because, often times the user would fly in the air,
        then set a random block to dirt and teleport the bot to stand on that block for starting the construction,
        */


        if (this.data.type !== 'construction') {
            const pos = getPosition(bot);
            const xOffset = getRandomOffset(5);
            const zOffset = getRandomOffset(5);
            bot.chat(`/tp ${this.name} ${Math.floor(pos.x + xOffset)} ${pos.y + 3} ${Math.floor(pos.z + zOffset)}`);
            await new Promise((resolve) => setTimeout(resolve, 200));
        }

        if (this.data.agent_count && this.data.agent_count > 1) {
            // ★ R6 #17：原来这里是第二份「固定 10s sleep + killAll()」（与 initBotTask 里那份
            //   一字不差地重复出现 ⇒ 启动时白等 20 秒）。现在与那边共用同一个轮询等待：
            //   调用方已经等过一轮时这里立刻返回（`waitForOtherBots` 一数就够，不 sleep）。
            const ready = await this.waitForOtherBots();
            if (!ready.ok) {
                this.detachSelf(`${describeWaitResult(ready)} —— 传送后仍未凑齐同伙，任务未开始。`);
                return;
            }
        }

        if (this.data.type === 'construction'){
            //Ensures construction is cleaned out first. -> relies on cheats which are turned off?
            if (this.blueprint){
                console.log('Cleaning out construction blueprint');
                const result = this.blueprint.autoDelete();
                const commands = result.commands;
                const nearbyPosition = result.nearbyPosition;
                console.log("nearby position", nearbyPosition);
                const first_coord = this.data.blueprint.levels[0].coordinates;
                bot.chat(`/tp @a ${first_coord[0]} ${first_coord[1]} ${first_coord[2]}`);
                if (this.agent.agent_id === 0 && this.data.human_count > 0) {
                    for (let i = 0; i < this.data.human_count; i++) {
                        const username = this.data.usernames[i];
                        await bot.chat(`/tp ${username} ${nearbyPosition.x} ${nearbyPosition.y} ${nearbyPosition.z}`);
                    }
                }
                for (const command of commands) {
                    bot.chat(command);
                }
            }
            else{
                console.log('no construction blueprint?')
            }
        }
    }
}