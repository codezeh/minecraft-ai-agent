import { History } from './history.js';
import { Coder } from './coder.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import { initBot } from '../utils/mcdata.js';
import { containsCommand, commandExists, executeCommand, truncCommandMessage, isAction, blacklistCommands } from './commands/index.js';
// 聊天输出安检 + 斜杠命令白名单（M1 安全，08 §5 / 09 §4）
import { inspectChatText } from './permissions.js';
// F-AI-205：这一轮是否算"用过命令"（被权限拒绝不算，否则自提示循环永不自停）
import { isPermissionDeniedResult, shouldCountAsUsedCommand } from './used_command.js';
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
// ★ 第32条：心跳循环（一次异常不许停掉它）。抽成独立文件才能离线证明。
import { runHeartbeatLoop, HEARTBEAT_INTERVAL_MS } from './library/heartbeat_loop.js';
// ★ 第31条：模型层失败标记（T11 在 src/models/_shared.js 定义）——
//   约定：sendRequest 返回以 FAILED_REPLY 开头的串 = **这次调用失败了**，不是模型说的话。
import { isFailedReply } from '../models/_shared.js';
// ★ t4（t2 步 1 的消费端）：模型结果现在带 status —— agent.js 必须**读 status**，
// 不能再把"取消/失败/截断"三义同形的串当回答（A5 §6.1）。
import { STATUS } from '../models/result.js';
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
    /**
     * 起任务板调度器（M8 B2，06 §8）。
     *
     * 节奏由这里的定时器决定，`tick()` 本身只跑**一遍**（"空闲时不空转"）。
     * tick 之间能响应"玩家喊停 / 进程退出"，所以中断不会被一次长循环拖住。
     *
     * 没有板 / 起不来 → 静默跳过（板是可选能力，不能拖垮 agent）。
     */
    async _startScheduler() {
        if (this.scheduler || !this.board) return;
        try {
            // 动态 import：与 `_registeredSkills()` 同样的理由 —— 模块加载期若抛错
            // （比如某个 manifest 不合格），不该阻止 agent 启动。
            const { BoardScheduler } = await import('./library/board_scheduler.js');
            this.scheduler = new BoardScheduler({
                agent: this,
                board: this.board,
                actions: this.actions,
            });
            const EVERY = 3000;   // 3 秒一拍：够快响应新单，又不至于空转刷日志
            this._schedulerTimer = setInterval(() => {
                this.scheduler.tick().catch((e) => {
                    console.log(`[调度器] tick 出错：${String(e?.message ?? e).slice(0, 120)}`);
                });
            }, EVERY);
            try { this._schedulerTimer.unref?.(); } catch { /* 不阻止进程退出 */ }
            console.log('[调度器] 已启动（每 3 秒一拍）');
        } catch (e) {
            console.log(`[调度器] 启动失败：${String(e?.message ?? e).slice(0, 140)}`);
        }
    }

    /**
     * B4 一次性迁移：本 bot 的旧 memory 分域文件 → 任务板库（06 §9.3）。
     *
     * 幂等：**按 (kind, key) 逐来源**跳过 —— 板库里已经有这条就不再搬。
     *
     * ★★ BOT-004（2026-11-06 深度检查）：这里原来有两个缺陷。
     *
     *   缺陷原貌①「迁移读错目录」：`_migrateSharedOnce()` 是在 `this.bot` 创建**之前**
     *     调用的（start() 里板一连上就迁移，`initBot()` 还在几百行之后），而这里用
     *     `mem.readStore(this.bot, ns)` → `memoryDir(undefined)` → 用户名回落成 `'agent'`
     *     → **每只机器人都在读 `bots/agent/memory/*`**。
     *     报告验证：夹具里 `deepseek/sites.x=22`、`agent/sites.x=11`，真实迁移只导入了 11。
     *   缺陷原貌②「幂等判据按全局 kind」：原来是 `sharedList(kind)` 有**任意一条**就
     *     `continue` 整个 kind。第一个机器人搬完后，后面启动的机器人**永远不会再迁移自己的**
     *     旧数据（漏迁）；迁移失败也照样算完成（`_sharedMigrated` 在开头就置 true）。
     *
     *   修法（报告的最小修复：显式以确定的登录名读旧目录 + 按机器人/版本标记、成功后写）：
     *     · 读旧目录用**确定的登录名**（`login_name`）而不是还没建出来的 `this.bot`；
     *     · 幂等按 (kind, key) 逐条判，不再一票否决整个 kind；
     *     · 只有**全部搬完**才置 `_sharedMigrated`，中途抛错下次启动还能重试。
     */
    async _migrateSharedOnce(loginName = null) {
        if (!this.board || this._sharedMigrated) return;
        try {
            const [store, mem, botPaths] = await Promise.all([
                import('./library/board_store.js'),
                import('./library/memory_store.js'),
                import('./library/bot_paths.js'),
            ]);
            // 板库由 mindserver 持有；agent 这边只能"请求迁移"——但迁移是一次性的、
            // 小数据量，为了不让 agent 直连库（那会变成第二个写者），
            // 这里只上报"我有旧数据待迁"，实际写库由 board:shared-put 完成。
            const reader = { readStore: (b, ns) => mem.readStore(b, ns) };
            // ★ BOT-004：读旧目录的身份 = **确定的登录名**（与 initBot 用的是同一个表达式），
            //   不再依赖"此刻 this.bot 已经建好了"这个并不成立的假设。
            const storeBot = this.bot ?? { username: loginName || this.name || 'agent' };
            const pull = (ns) => { try { return mem.readStore(storeBot, ns) ?? null; } catch { return null; } };
            // ★ BOT-004：幂等判据改成 (kind, key) 逐条 —— 别再"有任意一条就跳过整个 kind"
            const existing = new Set();
            const rememberExisting = (kind, items) => {
                for (const it of (items ?? [])) {
                    if (it && typeof it.key === 'string') existing.add(`${it.kind ?? kind}\u0000${it.key}`);
                }
            };
            const pending = ['landmark', 'danger', 'chest'];
            for (const kind of pending) {
                const cur = await this.board.sharedList?.(kind);
                if (cur?.ok) rememberExisting(kind, cur.data?.items ?? []);
            }
            const need = (kind, key) => !existing.has(`${kind}\u0000${key}`);
            for (const kind of pending) {
                if (kind === 'landmark') {
                    for (const s of (pull('sites') ?? [])) {
                        if (!Number.isFinite(s?.x)) continue;
                        const key = s.name ?? `site_${s.x}_${s.z}`;
                        if (need('landmark', key)) await this.board.sharedPut('landmark', key, s);
                    }
                    const st = pull('storage');
                    const stKey = 'storage';
                    if (Number.isFinite(st?.x) && need('landmark', stKey)) await this.board.sharedPut('landmark', stKey, st);
                } else if (kind === 'danger') {
                    for (const d of (pull('dangers') ?? [])) {
                        if (!Number.isFinite(d?.x)) continue;
                        const key = `${Math.floor(d.x)},${Math.floor(d.z)}`;
                        if (need('danger', key)) await this.board.sharedPut('danger', key, d);
                    }
                } else if (kind === 'chest') {
                    // 只搬 landmarks 形状（数组）；flow_store 的 map 形状是历史噪音，不搬
                    for (const c of (pull('chests') ?? [])) {
                        if (!Number.isFinite(c?.x)) continue;
                        const key = `${Math.floor(c.x)},${Math.floor(c.y)},${Math.floor(c.z)}`;
                        if (!need('chest', key)) continue;
                        await this.board.sharedPut('chest', key, {
                            pos: { x: c.x, y: c.y, z: c.z }, items: c.contents ?? {}, category: c.category ?? null, note: c.note ?? '',
                        });
                    }
                }
            }
            // ★ BOT-004：**成功之后**才写标记（原来在 try 之前就置 true，一次失败永不重试）
            this._sharedMigrated = true;
        } catch (e) {
            console.log(`[共享数据] 迁移跳过：${String(e?.message ?? e).slice(0, 120)}`);
        }
    }

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
        // ★ t4：当前操作（由 ActionManager._executeAction 创建并挂上来）——
        //   只在动作里非空；纯对话回合是 null，行为与 t3 完全一致。
        this.currentOperation = null;
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
        // ★ BOT-004（2026-11-06 深度检查）：**登录名要在板连上之前就算好。**
        //   迁移读的旧目录是按 bot 名字分目录的（bots/<登录名>/memory/*），
        //   而登录名原来在 `initBot()` 那一段才第一次出现 —— 迁移跑在那之前，
        //   于是 `readStore(this.bot=undefined)` 一路回落到 `bots/agent/memory/`。
        //   提前算出来并显式传给迁移，两条路径就用同一个身份。
        //   （下面 `initBot` 那一段仍用这个变量，保证"迁移读的目录"和"实际登录名"是同一个值。）
        const login_name = settings.profile?.username || this.name;
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
                // ★ M8 B2：板连上就起调度器（否则 B2 就是死代码，跟 B1 的 server 一样）
                await this._startScheduler();
                // ★ B4：把这只 bot 旧的地标/危险/箱子分域文件**一次性**搬进板库。
                //   搬完代码路径就只读板库（旧文件保留作取证，但不再读）。
                //   放在板连上之后、调度器之后：搬不动也不该阻止 agent 干活。
                // ★ BOT-004：显式传登录名 —— 此刻 this.bot 还没创建（见上面的说明）
                try { await this._migrateSharedOnce(login_name); } catch { /* 迁移失败不影响启动 */ }
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
        // ★ BOT-004：`login_name` 已在板接线之前算好（迁移要用同一个身份），这里直接用。
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
        // S43：这里是 **bot 上唯一的一处 `error` 监听**。
        // 原来 `startEvents()` 里还有第二份 `console.error('Error event!', err)`，
        // 两次注册都在同一个 bot 上 ⇒ 同一次错误被处理/打印两遍（一条变成两条日志）。
        // 合并策略：保留这份「能区分致命与否」的逻辑（Duplicate / ECONNREFUSED → 走 onDisconnect），
        // 同时把被删那份的价值（把 err 本体打出来、带堆栈）并进这里的 console.error。
        this.bot.on('error', (err) => {
            const fatal = String(err).includes('Duplicate') || String(err).includes('ECONNREFUSED');
            console.error(`[${this.name}] bot error:`, err);   // 带堆栈，排查用（原来只在第二处打）
            if (fatal) {
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
              
                // S43：**必须 await**。这个方法是真 async（内部有 3 处 await：
                // handleEnglishTranslation / self_prompter.handleLoad / handleMessage），
                // 原来裸调用 = fire-and-forget，两个后果：
                //   ① 它内部一抛就是 unhandled rejection —— 外层这个 try/catch 抓不到，
                //      Node 只打一行 warning，然后进程继续在"事件处理器没装好"的状态下跑；
                //   ② startEvents() / task.initBotTask() 会和它并发跑（顺序不确定）。
                // 现在 await 进外层 try/catch：异常会被下面的 catch 记录下来并干净退出。
                await this._setupEventHandlers(save_data, init_message);
                this.startEvents();
              
                if (!load_mem) {
                    if (settings.task) {
                        // ★ R6 #13/#15 相邻加固：这两个都是 **async 但历史上 fire-and-forget**。
                        //   一旦 reject 就是 unhandled rejection ⇒ Node 24 直接带走进程
                        //   （与 #13 同一条杀伤链，只是触发点从「落盘」换成「任务初始化」）。
                        //   现在接住并**干净退出（非 0）**：父进程能看见「起不来」并退避重试，
                        //   日志里也有明确的哪一步失败 —— 比"进程凭空消失"强一个数量级。
                        this.guardTaskStartup('initBotTask', this.task.initBotTask());
                        this.guardTaskStartup('setAgentGoal', this.task.setAgentGoal());
                    }
                } else {
                    // set the goal without initializing the rest of the task
                    if (settings.task) {
                        this.guardTaskStartup('setAgentGoal', this.task.setAgentGoal());
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 10000));
                this.checkAllPlayersPresent();

            } catch (error) {
                console.error('Error in spawn event:', error);
                // ★ R6 #15（2026-11-10）：**这里原来是 `process.exit(0)`。**
                //
                //   退出码 0 的语义是「正常结束」：`planExit()`（src/process/agent_process.js:58）
                //   见到 code === 0 直接返回 `action:'none'` ⇒ **不重启、也不走 unregister 的告警分支**
                //   ⇒ bot 掉线后再也不回来，日志里只剩一行 `Error in spawn event`。
                //   而同一份代码里「起不来」的其它路径（`init_agent` 的启动失败）用的是 exit(1)（会重启），
                //   两条路径语义相反。
                //
                //   现在改成 `cleanKill(msg, 1)`：与 init_agent 的失败路径对齐 —— 退出码 1
                //   让父进程按「起不足 10 秒就退出」进指数退避重启，真的起不来才由
                //   MAX_QUICK_EXITS 收口。**setup 崩了必须能被认出来，不能伪装成正常退出。**
                //   外层再兜一层：cleanKill 内部要碰 bot.chat / history（setup 中途可能半坏），
                //   它自己再抛就退化成 exit(1) —— 退出码仍然是「异常」，不许回到 0。
                try {
                    this.cleanKill(`Error in spawn event: ${error?.message ?? error}`, 1);
                } catch (e) {
                    console.error('Error while killing agent after spawn failure:', e);
                    process.exit(1);
                }
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
            // BOT-001：代码发起 ⇒ 显式 internal（不能靠 'system' 这个字符串）。
            await this.handleMessage('system', init_message, 2, { internal: true });
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
            ` Previous actions were stopped and you have respawned.`,
            null, { internal: true });
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

    /**
     * 记一次「取消」（A5-1，S1）。**只增不减的序号**，不是一个标志位。
     *
     * 为什么不能只看 `bot.interrupt_code`：`!stop` 的实现是
     * `actions.stop('player')` **紧跟** `agent.clearBotLogs()`
     * （commands/actions.js:140-141），而 clearBotLogs 里就有 `interrupt_code = false`。
     * 等那句"其实已经生成好"的回复从模型返回时，标志位早就被抹掉了 ——
     * 只看标志位，永远判不出"这一轮确实被取消过"（A5-1 的根因就在这）。
     *
     * 语义边界（"清标志只影响新动作，不影响旧动作的收尾判定"）：
     *   · 旧动作的收尾继续读**标志位**（action_manager 的 `interrupted`、
     *     getBotOutputSummary 的 `if (bot.interrupt_code)`）—— 那些地方一行都不用改；
     *   · 新回合 / 新一次模型调用在**开工前**取一份 `cancelEpoch()` 快照，只认
     *     "我开工之后发生的取消"。上一轮遗留的取消因此不会把新回合直接判死。
     *
     * @param {string} [reason] 记录用：谁取消的（interrupt / shut-up / player-stop）
     * @returns {number} 取消后的序号
     */
    noteCancel(reason = 'cancel') {
        this._cancelEpoch = (this._cancelEpoch ?? 0) + 1;
        this._lastCancelReason = reason;
        return this._cancelEpoch;
    }

    /** 当前取消序号（新回合 / 新一次模型调用在开工前取快照）。 */
    cancelEpoch() {
        return this._cancelEpoch ?? 0;
    }

    requestInterrupt() {
        // ★ A5-1：`stop()` 的每一条路径最终都落到这里（action_manager.js:112,130），
        //   在这里记一次取消 —— "身体被打断"这一事实就不随标志位被清掉而消失。
        this.noteCancel('interrupt');
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
        // ★ A5-1：`!stfu` 也算取消。否则"闭嘴"之后，那句已经生成好、只是还没返回的
        //   回复照样会被说出口 —— `routeResponse` 只看**当时**的 `shut_up`，而它会被
        //   下一条消息的 respondFunc / 会话开始清回 false（agent.js:416、conversation.js:353）。
        this.noteCancel('shut-up');
        this.shut_up = true;
        if (this.self_prompter.isActive()) {
            this.self_prompter.stop(false);
        }
        convoManager.endAllConversations();
    }

    /**
     * 收到一条消息（玩家聊天 / 别的 bot / 代码内部触发）。
     *
     * ★ BOT-001（2026-11-06 深度检查）：内部来源改用**显式标记**，不再按名字猜。
     *
     * 缺陷原貌：`self_prompt = source === 'system' || source === this.name`。
     * `source` 是玩家名（来自 bot.on('chat') 的 username），所以玩家把游戏名起成
     * `system` 就能把自己的聊天伪装成"代码内部触发"，再经下面
     * `perm_author = self_prompter.author` 借到设 !goal 那个主人的身份 ⇒ 主人级命令。
     *
     * 现在的口径：只有**代码调用点**能传 `opts.internal === true`（字符串伪造不出来）。
     * 名字只用于和 profile 的 owner/trusted 名单比对，没有任何特殊名字。
     *
     * @param {string} source 发言人：玩家名 / 别的 bot 名 / 内部触发时给个可读标签（如 'system'）
     * @param {string} message
     * @param {number|null} [max_responses]
     * @param {{internal?:boolean, selfPrompt?:boolean}} [opts]
     *   internal   本回合由代码发起（不是玩家发言）。**唯一**内部来源判据。
     *   selfPrompt 本回合由 self_prompter 的目标循环发起 —— 只有这条路径可以继承
     *              `self_prompter.author`（设 !goal 的那个人）的主人权限；
     *              其它内部回合（初始化/死亡/对话超时/模式重提示）一律 author=null ⇒ 信任级。
     */
    async handleMessage(source, message, max_responses=null, opts={}) {
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

        const is_internal = opts?.internal === true;
        const is_self_prompt_loop = is_internal && opts?.selfPrompt === true;
        // self_prompt 的语义（打断/停循环/强制单次回复）与改造前一致：
        // 内部回合仍按"自提示回合"处理，只是它现在由标记决定、不能由名字伪造。
        const self_prompt = is_internal;
        const from_other_bot = is_internal ? false : convoManager.isOtherAgent(source);

        // ★ 2026-11-01（M1，08 §5）：命令的等级按「谁说的」算，不按模型说了什么算。
        //   - 玩家发言  → 发言人本人（respondFunc 已经拿到 username）
        //   - 自提示循环 → 设 !goal 的那个人（self_prompter.author），不是 'system'
        //   - 别的 bot   → isOtherBot，只聊天
        //   - 其它内部回合 → author=null（信任级）：初始化文本、死亡消息、对话超时
        //     都不该带着主人权限去执行命令（BOT-001 收口）
        // 这样提示词注入（"你现在是我主人"）改不了等级，因为 author 不来自文本。
        const perm_author = is_self_prompt_loop
            ? (this.self_prompter?.author ?? null)
            : (is_internal ? null : source);
        const perm = { author: perm_author, isOtherBot: from_other_bot };

        // ★ A5-1（S1）：**进入本回合前**收掉上一轮遗留的停止标志。
        //
        //   判据必须带上"此刻没有动作在跑"（`actions.executing`）：
        //     · 没有动作在跑 → 这个 true 只可能是**旧动作**留下的陈迹。新回合算"新动作"，
        //       不清掉的话本回合第一个 `checkInterrupt()` 就命中 → 她此后永远不吭声
        //       （比原来的 bug 更糟：从"多说一句"变成"再也不说话"）。
        //     · 有动作正在跑 → **绝不能清**。旧动作的收尾判定还在读这一位
        //       （action_manager.js:306/344 的 `interrupted`、getBotOutputSummary 的
        //       `if (bot.interrupt_code)`），在这里清掉等于让已经停了的东西接着跑。
        //   —— 这就是"清标志的时机只影响新动作、不影响旧动作收尾判定"的落点。
        if (this.bot?.interrupt_code === true && !this.actions?.executing) {
            try { this.bot.interrupt_code = false; } catch { /* 只读 bot 桩：忽略 */ }
        }

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

        // ★ A5-1（S1）：判据里**补上停止标志** `bot.interrupt_code`。
        //   原来只有 `shouldInterrupt / shut_up / responseScheduledFor` 三条 ——
        //   "身体已经 stop 了"这件事在对话回合里完全看不见，于是已经决定不作数的一轮
        //   照样接着调模型、照样把回答说出来。
        //   上一轮遗留的标志已在上面按 `actions.executing` 收掉，所以这里读到 true
        //   只可能是**本回合开始之后**才置起的 = 真的被取消。
        const checkInterrupt = () => this.self_prompter.shouldInterrupt(self_prompt)
            || this.shut_up
            || this.bot?.interrupt_code === true
            || convoManager.responseScheduledFor(source);
        
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
        this.saveMemoryQuietly();

        if (!self_prompt && this.self_prompter.isActive()) // message is from user during self-prompting
            max_responses = 1; // force only respond to this message, then let self-prompting take over
        for (let i=0; i<max_responses; i++) {
            if (checkInterrupt()) break;
            let history = this.history.getHistory();
            // ★ A5-1：给**这一次模型调用**取一份取消快照。
            //   取消只能作废"它发生之后才返回的结果"，不能牵连同一回合的下一轮 ——
            //   否则一轮里连着几条命令时，第一条命令的 stop（requestInterrupt）
            //   会把整轮后续都截断。
            const opEpoch = this.cancelEpoch();
            // ★★★ t4（第 2 跳）：把**当前操作**的 signal / deadline / operationId 交给 prompter，
            //   再由它交给适配器 → fetch/SDK。没有操作时三项都缺省 ⇒ 与 t3 逐字一致。
            const op = this.currentOperation ?? null;
            const typed = await this.prompter.promptConvoResult(history, op ? {
                signal: op.ac?.signal ?? null, deadline: op.deadline ?? null, operationId: op.id,
            } : {});
            let res = typed?.content ?? '';
            // ★ t4：读 status（t2 步 1 的消费端）—— 取消/失败都不是"她说了句话"。
            if (typed?.status === STATUS.CANCELLED) {
                console.warn('[取消] 模型结果 status=cancelled（这一轮已被取消/超期），丢弃（不写 history、不说给玩家）');
                break;
            }

            // ★★★ t4 硬要求 2：**operationId 过期 ⇒ 三重不得**。
            //   不写 history、不进聊天、不 finish 租约 —— 旧操作的迟到结果不许影响新任务
            //   （与板侧 attemptSeq 代次判据同构，见 A5 §5.3）。
            //   位置：连"她说了什么"的日志都不打 —— 这句本来就不是这一轮的回答。
            if (op && !this.isOperationCurrent(op.id)) {
                console.warn(`[取消] operationId ${op.id} 已过期，迟到结果丢弃（不写 history、不说给玩家、不 finish 租约）`);
                break;
            }

            console.log(`${this.name} full response to ${source}: ""${res}""`);

            // ★★★ 第31条（T32）：**模型层的失败不是"她说了一句话"。**
            //
            //   T11 把 17 处 `catch { res = 'My brain disconnected, try again.' }` 改成返回
            //   `failedReply(...)` 标记（`src/models/_shared.js` 的 `FAILED_REPLY`）。
            //   但那边只负责"打标记"——**消费端不认它，标记就等于没用**：
            //   这条"回答"会照旧被写进 history、真的 routeResponse 给玩家说出来、
            //   还吃掉一次 response 预算（max_responses）。模型层每一次故障都被记成
            //   "模型说了句话"，history 里于是长出不该有的对话。
            //
            //   约定：认出来就当**空响应**处理 —— 等于这一轮没有产出，直接结束循环，
            //   不写 history、不 routeResponse。（与上面 `res.trim().length === 0` 同一支语义。）
            if (isFailedReply(res)) {
                console.warn(`[llm] 本轮模型调用失败，按空响应处理（不写 history、不回复玩家）：`
                    + `${String(res).slice(0, 120)}`);
                break;
            }

            if (res.trim().length === 0) {
                console.warn('no response')
                break; // empty response ends loop
            }

            // ★★★ A5-1（S1，审计 A5 §4/§5 的 P0-d）：**模型返回之后必须复查取消。**
            //
            //   缺陷原貌：`!stop` 之后那句"她其实已经生成好的回复"照样被说出口 ——
            //   这一分支在 `promptConvo` 返回后没有任何复查，而它既非"新消息取代"、
            //   也不在 `checkInterrupt()` 的判据里（审计 A5 表最后一行）。
            //
            //   为什么用**取消序号**而不是只看标志位：`!stop` 自己就是
            //   `stop('player')` 后紧接 `clearBotLogs()`（commands/actions.js:140-141），
            //   标志位在迟到回复回来之前**已经被清成 false** —— 只看标志位永远抓不到它。
            //
            //   位置很关键：必须在下面 `this.history.add(...)` / `routeResponse(...)` **之前**，
            //   否则"不写 history、不说给玩家"就只是一句注释。
            if (this.cancelEpoch() !== opEpoch || checkInterrupt()) {
                console.warn('[取消] 这一轮在生成期间已被取消，丢弃迟到的模型回复（不写 history、不说给玩家）');
                break;
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
                // ★ F-AI-205（2026-11-06，复核席跨部门巡检发现）：
                // 原来这里**无条件** used_command = true，于是"命令被权限拒绝"也计作"用了命令"。
                // 组合起来会形成一个无人能停的循环：
                //   history 让 goal 跨重启存活 -> 自提示回合按该 author 定级
                //   -> 没配 owner 时 fail-closed（连 !endGoal 也被拒）
                //   -> 每轮都被拒但 used_command 仍为 true -> self_prompter 的 no_command_count 归零
                //   -> 循环永不自停（每 2 秒一次 LLM 调用，按量计费下持续烧钱，玩家叫不停）。
                // 修法：**被拒等价于没命令** —— 权限拒绝的回复以 permissionDeniedReply 的
                // '[权限] 没执行 ' 开头（src/agent/permissions.js:227），据此判。
                // 这样连续 max_no_command 轮后 self_prompter 会自己 STOPPED。
                // 判断逻辑抽到 library/used_command.js（可单测 + 接线可断言，见 tools/ai205_used_command_unit.mjs）
                if (isPermissionDeniedResult(execute_res)) {
                    console.warn('[权限] 本轮命令被拒，不计入"用过命令"（避免自提示循环无法停止）');
                } else if (shouldCountAsUsedCommand(execute_res)) {
                    used_command = true;
                }

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
            
            this.saveMemoryQuietly();
        }

        return used_command;
    }

    /**
     * 这次操作还算数吗（★ t4 消费端唯一判据，转发给 ActionManager）。
     * 没有 actions（离线桩/老测试）时按"操作已不存在"处理 ⇒ 有 op 就一定丢弃。
     */
    isOperationCurrent(opId) {
        if (!opId) return false;
        try {
            return this.actions?.isOperationCurrent?.(opId) === true;
        } catch {
            return false;
        }
    }

    /**
     * **唯一**的"完成这张单"入口（★ t4 硬要求 2 的第三重：不 finish 租约）。
     *
     * 迟到的 finish 直接丢弃：否则旧操作在单子已经被 paused/released 之后
     * 又把它 finish 掉，别人永远拿不到（A5 §5.3 末）。
     *
     * @param {{id?:string}|null} op 结果所属的操作
     * @param {string|null} jobId
     * @returns {boolean} 是否真的交了上去
     */
    finishOperation(op, jobId = null) {
        if (!op || !this.isOperationCurrent(op.id)) {
            console.warn(`[取消] 迟到的 finish 被丢弃（op=${op?.id ?? 'null'}）`);
            return false;
        }
        try { this.board?.finishJob?.({ jobId, opId: op.id }); } catch { /* 板不在就只丢日志 */ }
        return true;
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
        // S43：`bot.on('error')` 的第二份注册已删（唯一注册在 start() 里，见那里的注释）。
        // 同一次错误被两处处理会让日志翻倍，也会让 `fatal` 判定与纯打印互相干扰。
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
        //
        // ★★★ 第32条（T32）：**循环本体搬到 `library/heartbeat_loop.js`，并在里面兜住异常。**
        //   原来这里是 `while (true) { await this.update(...) }`，**整段没有 try/catch**：
        //   update() 抛一次（modes.update 里一个 ReferenceError 就够）就把循环彻底打死，
        //   而**没有任何人会重启它**；偏偏聊天走 handleMessage、**不依赖**这个循环
        //   ⇒ bot 进入"只会聊天、不会做事"的半死状态：进程活着、面板在线、她再也不动。
        setTimeout(() => {
            runHeartbeatLoop({ update: (deltaMs) => this.update(deltaMs) })
                // 只有"update 没传进去"这种编程错误才会走到这里（循环内部已自兜）
                .catch((e) => console.error('[心跳] 循环意外结束（本该不可能）：', e));
        }, HEARTBEAT_INTERVAL_MS);

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
    

    /**
     * ★ R6 #13/#15 相邻加固：接住「任务初始化」这类 fire-and-forget 的 async 调用。
     *
     * 为什么必须接：`initBotTask()` / `setAgentGoal()` 是 async，而历史上是**裸调用**。
     * 它们内部要 `executeCommand`、`bot.chat`、等同伴 bot —— 任何一步 reject 都是
     * unhandled rejection，Node 24 默认 `--unhandled-rejections=throw` ⇒ **整个进程被带走**
     * （与 #13 同一条杀伤链，只是触发点不同）。而且这种死法在日志里通常只剩一行 warning。
     *
     * 现在：记清楚是哪一步失败 → 走 `cleanKill(msg, 1)`（**非 0 退出码**，
     * 与 #15 同口径：父进程据此按「起不足 10 秒」退避重启，而不是当成"正常结束"）。
     *
     * @param {string} label 哪一步（进日志，便于排障）
     * @param {Promise<any>} promise 被保护的异步调用
     */
    guardTaskStartup(label, promise) {
        const onFail = (e) => {
            console.error(`[agent] 任务初始化阶段 ${label} 失败:`, e);
            const msg = `Task startup failed (${label}): ${e?.message ?? e}`;
            try {
                this.cleanKill(msg, 1);
            } catch (e2) {
                // cleanKill 内部要碰 bot.chat / history（初始化阶段可能半坏）——
                // 它自己再抛也只能退化成 exit(1)，**不许**回到 0。
                console.error('[agent] cleanKill 期间再抛（已兜住，直接以退出码 1 结束）:', e2);
                process.exit(1);
            }
        };
        try {
            if (promise && typeof promise.catch === 'function') void promise.catch(onFail);
        } catch (e) {
            // 极端情况：调用本身同步抛（不是 async 函数时会这样）
            onFail(e);
        }
    }

    /**
     * ★ R6 #13（2026-11-10）：记忆落盘的 **fire-and-forget 唯一入口**。
     *
     * 为什么要有这个包装：`history.save()` 的 3 个调用点（handleMessage / 命令循环 /
     * `cleanKill()`）都是「不 await 的顺手一存」。原来 `save()` 内部 catch 后**重新 throw**
     * ⇒ unhandled rejection ⇒ Node 24 默认把它当异常抛出 ⇒ **整个 agent 进程崩**。
     * （`save()` 现在内部已不再抛；这里再兜一层，防的是以后有人把那处 catch 改回去。）
     *
     * 另外同步写盘也在 try 里：`save()` 是 async 函数，但它的写盘是同步的 ——
     * 理论上不会同步抛，可一旦抛了（比如 capSize 里访问了坏字段），这条路径同样不能带走进程。
     */
    saveMemoryQuietly() {
        try {
            void this.history.save().catch((e) => {
                console.error(`[agent] 记忆落盘失败（已兜住，进程继续运行）: ${e?.message ?? e}`);
            });
        } catch (e) {
            console.error(`[agent] 记忆落盘同步异常（已兜住，进程继续运行）: ${e?.message ?? e}`);
        }
    }

    cleanKill(msg='Killing agent process...', code=1) {
        this.history.add('system', msg);
        // ★ 2026-11-01（M2）：文案原来写反了 —— `code > 1 ? 'Restarting.' : 'Exiting.'`。
        // 退出码语义见 src/process/agent_process.js:37-51：**code 1 = 重新拉起 agent 进程，
        // code > 1 = 结束整个任务（mindserver 一起退）**。反着播的后果是直接坑下一次排障：
        // 日志说她"Exiting."，人就去查为什么退出，其实她只是重启了一轮。
        // 现在按实际语义正向播：>1 说结束任务，其余（1）说重启。判定逻辑一字未动。
        this.bot.chat(code > 1 ? 'Ending task.' : 'Restarting.');
        // ★ R6 #13：这里原来是裸 `this.history.save()` —— 一次落盘失败会把「正常重启」
        //   变成「异常崩溃」，退出码也偏离 planExit 的 0/1/>1 三分支。
        this.saveMemoryQuietly();
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
