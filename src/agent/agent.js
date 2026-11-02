import { History } from './history.js';
import { Coder } from './coder.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import { initBot } from '../utils/mcdata.js';
import { containsCommand, commandExists, executeCommand, truncCommandMessage, isAction, blacklistCommands } from './commands/index.js';
// 聊天输出安检 + 斜杠命令白名单（M1 安全，08 §5 / 09 §4）
import { inspectChatText } from './permissions.js';
import { ActionManager } from './action_manager.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank } from './memory_bank.js';
import * as landmarks from './library/landmarks.js';
import * as skills from './library/skills.js';
import { SelfPrompter } from './self_prompter.js';
import convoManager from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
import { addBrowserViewer } from './vision/browser_viewer.js';
import { serverProxy, sendOutputToServer } from './mindserver_proxy.js';
// M8 B1：任务板客户端（agent 侧薄封装）。连不上就保持 this.board = null，
// 与控制层已有的"没有单要动"降级完全一致（06 §9.2 末：单 bot 和多机走同一套）。
import { BoardClient } from './library/board_client.js';
import settings from './settings.js';
import { Task } from './tasks/tasks.js';
import { speak } from './speak.js';
import { log, validateNameFormat, handleDisconnection } from './connection_handler.js';
// 控制层（M2，07 §4 / §7）：死亡对任务单的处理
import { onDeath } from './library/control.js';

export class Agent {
    /**
     * 上报给任务板的技能名（= composite_registry 的注册名）。
     *
     * 单独一个方法而不是内联：服务端用这份清单做安全①校验（只能派这些技能），
     * 以后加技能时"这里忘了同步"会直接表现成"新技能派不了单"，一眼能看出来。
     */
    async _registeredSkills() {
        try {
            // 动态 import（不是顶层静态 import）：
            //   composite_registry 加载时会校验所有 manifest，**不合格会 throw**。
            //   那个校验是对的（启动即失败），但它不该阻止 **agent 启动** ——
            //   任务板只是可选能力，没有板她照样能聊天/走/挖。
            //   所以这里 catch 住，退化成"没有可派单的技能"（= 服务端只允许 add 时全部拒绝）。
            const reg = await import('./library/composite_registry.js');
            return reg?.SKILL_NAMES ?? [];
        } catch (e) {
            console.log(`[任务板] 注册表加载失败，本次不上报任何技能：${String(e?.message ?? e).slice(0, 120)}`);
            return [];
        }
    }

    async start(load_mem=false, init_message=null, count_id=0) {
        this.last_sender = null;
        this.count_id = count_id;
        this._disconnectHandled = false;

        // Initialize components
        this.actions = new ActionManager(this);
        // ★ 2026-11-01（M2，07 §4 / §7）：任务板客户端，M8 接上（board_client）。
        // 现在是 null = 没有任务板，控制层的一切转移都退化成"没有单要动"，
        // 行为与加控制层之前一致，但 `stop(reason)` 已经开始记录原因了。
        this.board = null;
        this.prompter = new Prompter(this, settings.profile);
        this.name = (this.prompter.getName() || '').trim();
        console.log(`Initializing agent ${this.name}...`);

        // ★ M8 B1（2026-11-02）：接任务板。
        //
        // 顺序很关键：`this.name` 必须在上面那行**之后**才可用（它来自 profile），
        // 而 board 的个人单是按 name 过滤的 —— 所以接线放在这里，不能放构造里。
        //
        // **连不上就保持 null**（下面 catch / !ok 分支）：控制层对 `board === null`
        // 已经写好了完整降级（`applyStop()` 空操作、`reserve/release` 恒成功），
        // 行为与加板之前**逐行一致**。不维护"有板/无板"两条业务路径（06 §9.2）。
        this.board = null;
        try {
            const skills = await this._registeredSkills();
            const client = new BoardClient({
                socket: serverProxy?.socket ?? null,
                name: this.name,
                skills,
                roles: settings.profile?.roles ?? [],
            });
            const hello = await client.hello();
            if (hello.ok) {
                this.board = client;
                console.log(`[任务板] 已连接（${skills.length} 个技能可派单）`);
            } else {
                console.log(`[任务板] 未连接（${hello.code} ${hello.message ?? ''}），控制层降级为"没有单要动"`);
            }
        } catch (e) {
            // 板出错**绝不许拖垮 agent 启动**
            console.log(`[任务板] 连接失败：${String(e?.message ?? e).slice(0, 120)}，按"没有板"继续`);
            this.board = null;
        }

        // 启动自检：permissions.owner 没配时明确提示，别让"危险命令静默不可用"变成谜。
        // 默认状态（不配 owner）按 08 §5 是"人人信任级"：聊天/走/跟/采集/制作/建造/存取都能用，
        // 但 !newAction、斜杠命令、!attackPlayer、!setMode、!restart 这些会被拒。
        try {
            const perms = settings.profile?.permissions;
            const owner = typeof perms?.owner === 'string' ? perms.owner.trim() : '';
            if (!owner) {
                console.log('[权限] 未配置 permissions.owner —— 当前人人「信任级」。');
                console.log('        可用：聊天 / 走 / 跟 / 采集 / 制作 / 建造 / 存取');
                console.log('        不可用：!newAction、斜杠命令、!attackPlayer、!setMode、!restart、!discard、!givePlayer');
                console.log('        要解锁：在 profile 里加 "permissions": { "owner": "你的游戏名" }，然后重启这只 bot（区分大小写）');
            } else {
                console.log(`[权限] 主人 = ${owner}（名单外的人只能聊天）`);
            }
        } catch { /* 提示失败不影响启动 */ }
        
        // Validate Name Format
        // connection_handler now ensures the message has [LoginGuard] prefix
        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            process.exit(1);
            return;
        }
        
        this.history = new History(this);
        this.coder = new Coder(this);
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank();
        this.self_prompter = new SelfPrompter(this);
        convoManager.initAgent(this);
        await this.prompter.initExamples();

        // load mem first before doing task
        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
        }
        // 恢复 !rememberHere 存过的坐标（否则重启后这些地点全部丢失）
        if (save_data && save_data.memory_bank && typeof save_data.memory_bank === 'object') {
            try {
                this.memory_bank.loadJson(save_data.memory_bank);
                const keys = this.memory_bank.getKeys();
                if (keys) console.log('Restored saved places:', keys);
            } catch (err) {
                console.warn('Failed to restore memory_bank:', err);
            }
        }
        let taskStart = null;
        if (save_data) {
            taskStart = save_data.taskStart;
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, settings.task, taskStart);
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions || []);
        blacklistCommands(this.blocked_actions);

        // Minecraft only allows ASCII usernames ([a-zA-Z0-9_], 3-16 chars), so the
        // agent name (used in the UI and the prompt) can differ from the login name.
        const login_name = settings.profile?.username || this.name;
        console.log(this.name, 'logging into minecraft as', login_name, '...');
        this.bot = initBot(login_name);

        // 把 memory_bank 也挂到 bot 上：模型在沙箱里只能拿到 `bot`，拿不到 `agent`。
        // 不挂的话 skills.listKnownSites 里读 bot.memory_bank 永远 undefined，
        // 表现就是"用 !rememberHere 存过的地点查不到"。
        this.bot.memory_bank = this.memory_bank;
        
        // Connection Handler
        const onDisconnect = (event, reason) => {
            if (this._disconnectHandled) return;
            this._disconnectHandled = true;

            // Log and Analyze
            // handleDisconnection handles logging to console and server
            const { type } = handleDisconnection(this.name, reason);
     
            process.exit(1);
        };
        
        // Bind events
        this.bot.once('kicked', (reason) => onDisconnect('Kicked', reason));
        this.bot.once('end', (reason) => onDisconnect('Disconnected', reason));
        this.bot.on('error', (err) => {
            if (String(err).includes('Duplicate') || String(err).includes('ECONNREFUSED')) {
                 onDisconnect('Error', err);
            } else {
                 log(this.name, `[LoginGuard] Connection Error: ${String(err)}`);
            }
        });

        initModes(this);

        this.bot.on('login', () => {
            console.log(this.name, 'logged in!');
            serverProxy.login();
            
            // Set skin for profile, requires Fabric Tailor. (https://modrinth.com/mod/fabrictailor)
            // ★ 2026-11-01（M1，08 §5）：斜杠命令只走白名单，`/skin` 就是白名单里的这一条。
            // 统一走 sendSlashCommand() 而不是直接 bot.chat，白名单将来只改一处。
            if (this.prompter.profile.skin)
                this.sendSlashCommand(`/skin set URL ${this.prompter.profile.skin.model} ${this.prompter.profile.skin.path}`);
            else
                this.sendSlashCommand(`/skin clear`);
        });
		const spawnTimeoutDuration = settings.spawn_timeout;
        const spawnTimeout = setTimeout(() => {
            const msg = `Bot has not spawned after ${spawnTimeoutDuration} seconds. Exiting.`;
            log(this.name, msg);
            process.exit(1);
        }, spawnTimeoutDuration * 1000);
        this.bot.once('spawn', async () => {
            try {
                clearTimeout(spawnTimeout);
                addBrowserViewer(this.bot, count_id);
                console.log('Initializing vision intepreter...');
                this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);

                // wait for a bit so stats are not undefined
                await new Promise((resolve) => setTimeout(resolve, 1000));
                
                console.log(`${this.name} spawned.`);
                this.clearBotLogs();
              
                this._setupEventHandlers(save_data, init_message);
                this.startEvents();
              
                if (!load_mem) {
                    if (settings.task) {
                        this.task.initBotTask();
                        this.task.setAgentGoal();
                    }
                } else {
                    // set the goal without initializing the rest of the task
                    if (settings.task) {
                        this.task.setAgentGoal();
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 10000));
                this.checkAllPlayersPresent();

            } catch (error) {
                console.error('Error in spawn event:', error);
                process.exit(0);
            }
        });
    }

    async _setupEventHandlers(save_data, init_message) {
        const ignore_messages = [
            "Set own game mode to",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];
        
        const respondFunc = async (username, message) => {
            if (message === "") return;
            if (username === this.name) return;
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
            try {
                if (ignore_messages.some((m) => message.startsWith(m))) return;

                this.shut_up = false;

                console.log(this.name, 'received message from', username, ':', message);

                if (convoManager.isOtherAgent(username)) {
                    console.warn('received whisper from other bot??')
                }
                else {
                    let translation = await handleEnglishTranslation(message);
                    this.handleMessage(username, translation);
                }
            } catch (error) {
                console.error('Error handling message:', error);
            }
        }

		this.respondFunc = respondFunc;

        this.bot.on('whisper', respondFunc);
        
        this.bot.on('chat', (username, message) => {
            if (serverProxy.getNumOtherAgents() > 0) return;
            // only respond to open chat messages when there are no other agents
            respondFunc(username, message);
        });

        // Set up auto-eat
        // mineflayer-auto-eat 5.x：配置入口由 options 改为 opts，startAt 改为 minHunger，
        // 且默认不会自动进食，必须显式 enableAuto()，否则饥饿时不会吃东西。
        // 用官方 setOpts()（而不是直接赋值 opts），它是 5.x 文档提供的接口。
        if (this.bot.autoEat) {
            if (typeof this.bot.autoEat.setOpts === 'function') {
                this.bot.autoEat.setOpts({
                    priority: 'foodPoints',
                    minHunger: 14,
                    bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]
                });
            } else {
                // 兜底：老版本或接口变动时直接赋值
                this.bot.autoEat.opts = {
                    priority: 'foodPoints',
                    minHunger: 14,
                    bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]
                };
            }
            this.bot.autoEat.enableAuto();
        }

        if (save_data?.self_prompt) {
            if (init_message) {
                this.history.add('system', init_message);
            }
            await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state, save_data.self_prompt_author ?? null);
        }
        if (save_data?.last_sender) {
            this.last_sender = save_data.last_sender;
            if (convoManager.otherAgentInGame(this.last_sender)) {
                const msg_package = {
                    message: `You have restarted and this message is auto-generated. Continue the conversation with me.`,
                    start: true
                };
                convoManager.receiveFromBot(this.last_sender, msg_package);
            }
        }
        else if (init_message) {
            await this.handleMessage('system', init_message, 2);
        }
        else {
            this.openChat("Hello world! I am "+this.name);
        }
    }

    /**
     * 统一处理死亡：记录位置、持久化、通知模型。
     * 两个触发源（playerDeath 插件事件 / messagestr 兜底）可能同时到达，
     * 用 _deathHandledAt 做 5 秒去重，避免她收到两条重复的"你死了"。
     */
    _handleDeath(source, message) {
        const now = Date.now();
        if (now - this._deathHandledAt < 5000) return;   // 去重
        this._deathHandledAt = now;

        const death_pos = this.bot.entity.position;
        const dimension = this.bot.game?.dimension || 'unknown';
        console.log(`Agent died (${source}): ${message || '(no message)'} at ${dimension}`);

        if (death_pos) {
            this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
        }
        // 死亡位置同时写进 landmarks，这样重启后还在（memory_bank 本身不持久化）
        try {
            if (death_pos) {
                landmarks.rememberSite(this.bot, death_pos, 'death_position');
                // 记录这次死亡，让 recoverDeathItems 能判断"同一地方反复死"
                // （必须在这里记，不能只在尝试回去时记，否则保护永远不触发）
                skills.recordDeath(this.bot, death_pos);
            }
        } catch (err) { /* 写失败不影响主流程 */ }

        const posText = death_pos
            ? `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.z.toFixed(2)}`
            : 'unknown';
        const dist = death_pos
            ? Math.round(this.bot.entity.position.distanceTo(death_pos))
            : null;
        // 距离近就直接建议去捡，并告诉她可以调用哪个函数；太远则明确说不要自己去。
        const recoverHint = dist === null ? ''
            : (dist <= 128
                ? ` The spot is ${dist} blocks away - you can call skills.recoverDeathItems(bot) to walk back and pick your items up.`
                : ` The spot is ${dist} blocks away, which is too far to walk automatically - ask the player whether to go.`);

        // ★ 2026-11-01（M2，07 §7）：死亡对**任务单**的处理，交给控制层：
        //   正在跑的单 → paused（result 记 died，不算 attempts）；
        //   另开一张 8 级"回去捡"的单（goto 死亡点 → pickup，deadline 4 分钟）。
        //   死因是岩浆 / 掉出世界就不开 —— 东西已经没了，那里也危险。
        let death_info = { cause: null, paused: [], pickup: null };
        try {
            death_info = onDeath(this, { message, pos: death_pos });
        } catch (err) { /* 任务板没接上（M8 之前）时不该影响"告诉模型她死了" */ }

        const pickupHint = death_info?.pickup
            ? ` A level-${death_info.pickup.priority} job has been queued to walk back and pick them up.`
            : (death_info?.cause && death_info.cause !== 'other'
                ? ` Nothing to go back for (${death_info.cause}).`
                : '');

        this.handleMessage('system',
            `You died at position ${posText} in the ${dimension} dimension` +
            (message ? ` with the final message: '${message}'` : '') +
            `. Your items are still there. The place is saved as 'last_death_position' if you want to go back.` +
            recoverHint + pickupHint +
            ` Previous actions were stopped and you have respawned.`);
    }

    checkAllPlayersPresent() {
        if (!this.task || !this.task.agent_names) {
          return;
        }

        const missingPlayers = this.task.agent_names.filter(name => !this.bot.players[name]);
        if (missingPlayers.length > 0) {
            console.log(`Missing players/bots: ${missingPlayers.join(', ')}`);
            this.cleanKill('Not all required players/bots are present in the world. Exiting.', 4);
        }
    }

    requestInterrupt() {
        this.bot.interrupt_code = true;
        this.bot.stopDigging();
        this.bot.collectBlock.cancelTask();
        this.bot.pathfinder.stop();
        this.bot.pvp.stop();
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    shutUp() {
        this.shut_up = true;
        if (this.self_prompter.isActive()) {
            this.self_prompter.stop(false);
        }
        convoManager.endAllConversations();
    }

    async handleMessage(source, message, max_responses=null) {
        await this.checkTaskDone();
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }

        let used_command = false;
        if (max_responses === null) {
            max_responses = settings.max_commands === -1 ? Infinity : settings.max_commands;
        }
        if (max_responses === -1) {
            max_responses = Infinity;
        }

        const self_prompt = source === 'system' || source === this.name;
        const from_other_bot = convoManager.isOtherAgent(source);

        // ★ 2026-11-01（M1，08 §5）：命令的等级按「谁说的」算，不按模型说了什么算。
        //   - 玩家发言  → 发言人本人（respondFunc 已经拿到 username）
        //   - 自提示回合 → 设 !goal 的那个人（self_prompter.author），不是 'system'
        //   - 别的 bot   → isOtherBot，只聊天
        // 这样提示词注入（"你现在是我主人"）改不了等级，因为 author 不来自文本。
        const perm_author = self_prompt ? (this.self_prompter?.author ?? source) : source;
        const perm = { author: perm_author, isOtherBot: from_other_bot };

        if (!self_prompt && !from_other_bot) { // from user, check for forced commands
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                if (!commandExists(user_command_name)) {
                    this.routeResponse(source, `Command '${user_command_name}' does not exist.`);
                    return false;
                }
                this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
                if (user_command_name === '!newAction') {
                    // all user-initiated commands are ignored by the bot except for this one
                    // add the preceding message to the history to give context for newAction
                    this.history.add(source, message);
                }
                let execute_res = await executeCommand(this, message, perm);
                if (execute_res) 
                    this.routeResponse(source, execute_res);
                return true;
            }
        }

        if (from_other_bot)
            this.last_sender = source;

        // Now translate the message
        message = await handleEnglishTranslation(message);
        console.log('received message from', source, ':', message);

        const checkInterrupt = () => this.self_prompter.shouldInterrupt(self_prompt) || this.shut_up || convoManager.responseScheduledFor(source);
        
        let behavior_log = this.bot.modes.flushBehaviorLog().trim();
        if (behavior_log.length > 0) {
            const MAX_LOG = 500;
            if (behavior_log.length > MAX_LOG) {
                behavior_log = '...' + behavior_log.substring(behavior_log.length - MAX_LOG);
            }
            behavior_log = 'Recent behaviors log: \n' + behavior_log;
            await this.history.add('system', behavior_log);
        }

        // Handle other user messages
        await this.history.add(source, message);
        this.history.save();

        if (!self_prompt && this.self_prompter.isActive()) // message is from user during self-prompting
            max_responses = 1; // force only respond to this message, then let self-prompting take over
        for (let i=0; i<max_responses; i++) {
            if (checkInterrupt()) break;
            let history = this.history.getHistory();
            let res = await this.prompter.promptConvo(history);

            console.log(`${this.name} full response to ${source}: ""${res}""`);

            if (res.trim().length === 0) {
                console.warn('no response')
                break; // empty response ends loop
            }

            let command_name = containsCommand(res, { fromModel: true });

            if (command_name) { // contains query or command
                res = truncCommandMessage(res); // everything after the command is ignored
                this.history.add(this.name, res);
                
                if (!commandExists(command_name)) {
                    this.history.add('system', `Command ${command_name} does not exist.`);
                    console.warn('Agent hallucinated command:', command_name)
                    continue;
                }

                if (checkInterrupt()) break;
                this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(command_name));

                if (settings.show_command_syntax === "full") {
                    this.routeResponse(source, res);
                }
                else if (settings.show_command_syntax === "shortened") {
                    // show only "used !commandname"
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    let chat_message = `*used ${command_name.substring(1)}*`;
                    if (pre_message.length > 0)
                        chat_message = `${pre_message}  ${chat_message}`;
                    this.routeResponse(source, chat_message);
                }
                else {
                    // no command at all
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    if (pre_message.trim().length > 0)
                        this.routeResponse(source, pre_message);
                }

                let execute_res = await executeCommand(this, res, perm);

                console.log('Agent executed:', command_name, 'and got:', execute_res);
                used_command = true;

                if (execute_res)
                    this.history.add('system', execute_res);
                else
                    break;
            }
            else { // conversation response
                this.history.add(this.name, res);
                this.routeResponse(source, res);
                break;
            }
            
            this.history.save();
        }

        return used_command;
    }

    async routeResponse(to_player, message) {
        if (this.shut_up) return;
        let self_prompt = to_player === 'system' || to_player === this.name;
        if (self_prompt && this.last_sender) {
            // this is for when the agent is prompted by system while still in conversation
            // so it can respond to events like death but be routed back to the last sender
            to_player = this.last_sender;
        }

        if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
            // if we're in an ongoing conversation with the other bot, send the response to it
            convoManager.sendToBot(to_player, message);
        }
        else {
            // otherwise, use open chat
            this.openChat(message);
            // note that to_player could be another bot, but if we get here the conversation has ended
        }
    }

    async openChat(message) {
        let to_translate = message;
        let remaining = '';
        let command_name = containsCommand(message);
        let translate_up_to = command_name ? message.indexOf(command_name) : -1;
        if (translate_up_to != -1) { // don't translate the command
            to_translate = to_translate.substring(0, translate_up_to);
            remaining = message.substring(translate_up_to);
        }
        message = (await handleTranslation(to_translate)).trim() + " " + remaining;

        // ★ 2026-11-01（M1，08 §5 / 09 §4）：模型回复以 `/` 开头会被服务端当命令执行，
        // 而她是 op —— 一句诱导出来的「/op 某人」就等于把 op 交出去。
        // 检查必须放在「换行变空格」**之前**：bot.chat 里的换行等于连发多条，`/op` 可以另起一行。
        // 斜杠命令只走 sendSlashCommand() 的白名单（现在是 /skin）。
        const chat_verdict = inspectChatText(message);
        if (!chat_verdict.allowed) {
            console.warn(`[安全] ${this.name} 的回复以 / 开头，已拦截（${chat_verdict.reason}）：${message.slice(0, 80)}`);
            sendOutputToServer(this.name, '[已拦截：回复以 / 开头] ' + message);
            return;
        }

        // newlines are interpreted as separate chats, which triggers spam filters. replace them with spaces
        message = message.replaceAll('\n', ' ');

        if (settings.only_chat_with.length > 0) {
            for (let username of settings.only_chat_with) {
                this.bot.whisper(username, message);
            }
        }
        else {
            if (settings.speak) {
                speak(to_translate, this.prompter.profile.speak_model);
            }
            if (settings.chat_ingame) {this.bot.chat(message);}
            sendOutputToServer(this.name, message);
        }
    }

    /**
     * 发一条斜杠命令 —— 唯一允许直接给服务端发 `/` 命令的入口。
     *
     * ★ 2026-11-01（M1，08 §5）：「斜杠命令只走白名单」。现在白名单里只有 `/skin`
     * （profile 的 skin 字段，需要服务端装 Fabric Tailor）。模型回复里的 `/`
     * 一律被 openChat 拦掉，不会走到这里。
     *
     * @param {string} text 形如 `/skin clear`
     * @returns {boolean} 是否真的发出去了
     */
    sendSlashCommand(text) {
        const verdict = inspectChatText(text);
        if (!verdict.allowed) {
            console.warn(`[安全] 拒绝发送不在白名单里的斜杠命令（${verdict.reason}）：${String(text).slice(0, 80)}`);
            return false;
        }
        this.bot.chat(text);
        return true;
    }

    startEvents() {
        // Custom events
        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0)
            this.bot.emit('sunrise');
            else if (this.bot.time.timeOfDay == 6000)
            this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000)
            this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000)
            this.bot.emit('midnight');
        });

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
            }
            prev_health = this.bot.health;
        });
        // Logging callbacks
        this.bot.on('error' , (err) => {
            console.error('Error event!', err);
        });
        // Use connection handler for runtime disconnects
        this.bot.on('end', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('death', () => {
            this.actions.cancelResume();
            // 07 §7：死亡不是"谁打断的"，但同样要停 —— 原因记 `death`，
            // 被打断的单 `paused` + 不算 attempts（_handleDeath 里再补"回去捡"的单）。
            this.actions.stop('death');
        });
        this.bot.on('kicked', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        // 死亡处理：优先用 mineflayer-death-event 插件（按协议解析，可靠），
        // 原来的 messagestr 解析保留作为兜底（某些自定义死亡消息插件会让 translate 不匹配）。
        this._deathHandledAt = 0;
        this.bot.on('playerDeath', (deathEvent) => {
            this._handleDeath('playerDeath event', deathEvent?.getDeathMessage?.() || null);
        });
        this.bot.on('messagestr', async (message, _, jsonMsg) => {
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                this._handleDeath('messagestr fallback', message);
            }
        });
        this.bot.on('idle', () => {
            this.bot.clearControlStates();
            this.bot.pathfinder.stop(); // clear any lingering pathfinder
            this.bot.modes.unPauseAll();
            setTimeout(() => {
                if (this.isIdle()) {
                    this.actions.resumeAction();
                }
            }, 1000);
        });

        // Init NPC controller
        this.npc.init();

        // This update loop ensures that each update() is called one at a time, even if it takes longer than the interval
        const INTERVAL = 300;
        let last = Date.now();
        setTimeout(async () => {
            while (true) {
                let start = Date.now();
                await this.update(start - last);
                let remaining = INTERVAL - (Date.now() - start);
                if (remaining > 0) {
                    await new Promise((resolve) => setTimeout(resolve, remaining));
                }
                last = start;
            }
        }, INTERVAL);

        this.bot.emit('idle');
    }

    async update(delta) {
        await this.bot.modes.update();
        this.self_prompter.update(delta);
        await this.checkTaskDone();
    }

    isIdle() {
        return !this.actions.executing;
    }
    

    cleanKill(msg='Killing agent process...', code=1) {
        this.history.add('system', msg);
        // ★ 2026-11-01（M2）：文案原来写反了 —— `code > 1 ? 'Restarting.' : 'Exiting.'`。
        // 退出码语义见 src/process/agent_process.js:37-51：**code 1 = 重新拉起 agent 进程，
        // code > 1 = 结束整个任务（mindserver 一起退）**。反着播的后果是直接坑下一次排障：
        // 日志说她"Exiting."，人就去查为什么退出，其实她只是重启了一轮。
        // 现在按实际语义正向播：>1 说结束任务，其余（1）说重启。判定逻辑一字未动。
        this.bot.chat(code > 1 ? 'Ending task.' : 'Restarting.');
        this.history.save();
        process.exit(code);
    }
    async checkTaskDone() {
        if (this.task.data) {
            let res = this.task.isDone();
            if (res) {
                await this.history.add('system', `Task ended with score : ${res.score}`);
                await this.history.save();
                // await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 second for save to complete
                console.log('Task finished:', res.message);
                this.killAll();
            }
        }
    }

    killAll() {
        serverProxy.shutdown();
    }
}
