import { getBlockId, getItemId } from "../../utils/mcdata.js";
import { actionsList } from './actions.js';
import { queryList } from './queries.js';
// 第四轮审计 ①：身份绑定命令（!claim）
import { identityList } from './identity.js';
import settings from '../settings.js';
// 发言人分级（M1 安全，08 §5）：命令能不能执行由「谁说的」定，不由模型说了什么定
import { resolveLevel, canRunCommand, permissionDeniedReply, LEVEL } from '../permissions.js';
// 第四轮审计 ①：身份绑定表（角色 → 等级）。**身份优先，名字只是回退**
import { identityFileOf, readStore, resolveBinding, sessionFresh } from '../../mindcraft/identity_store.js';

/**
 * 陪玩模式只暴露这几条给模型（方案 §12：60 条 → 7 条）。
 *
 * 为什么收敛：上下文里 66 条命令 + 99 个技能文档，模型反而绕开专用命令
 * 自己写 !newAction 试错（实测铺一个 3×3 平台试了 4 次）。收敛后它只能挑
 * 这 7 条确定性的路。
 *
 * 注意：这只是「不给模型看」。玩家在游戏里手动输其它命令依然可用，回滚也简单
 * （companion_mode=false 即恢复原样）。
 */
export const COMPANION_COMMANDS = [
    '!collectBlocks',   // 采集 N 个方块
    '!followPlayer',    // 跟着某人
    '!goToPlayer',      // 走到某人身边
    '!placeHere',       // 放一个方块
    '!buildPlatform',   // 铺 3×3 平台
    '!map',             // 读区块地图（附近有什么、往哪走、哪没去过）
    '!stay',            // 待机
    '!stop',            // 停
];

/**
 * 该命令是否应该出现在给模型的文档里。
 *
 * ★ F-GATE-001 + F-AI-204（2026-11-06）：**默认方向反转**。
 *
 * 原来是 `if (!settings.companion_mode) return true;` —— 配合"`companion_mode` 从未在
 * `settings_spec.json` 声明"这个事实，后果是：**键恒缺失 ⇒ 恒 falsy ⇒ 恒 `return true`**
 * ⇒ 面板创建的 agent 对模型暴露**全部**命令（实测 70 条），方案 §12 的"只给 8 条"从未生效。
 *
 * 现在改成 **fail-closed**：
 *   · 显式 `companion_mode === false` ⇒ 全开（老行为，供想恢复的人用）
 *   · 其它一切情况（`true` / 键缺失 / 类型不对）⇒ **收敛到白名单 8 条**
 * 判据用 `=== false` 而不是 `!== true`，是为了让"键缺失"落到收敛侧而不是全开侧 ——
 * 键缺失是**配置没写**，不该等价于"用户明确要求全开"。
 *
 * 配套：`settings_spec.json` 已正式声明该键（default `true` = 收敛），
 * 它因此不再挂在 `tools/settings_check.mjs` 的 KNOWN_UNDECLARED 例外里。
 */
export function isVisibleToModel(commandName) {
    if (settings.companion_mode === false) return true;   // 显式关闭收敛 ⇒ 全开
    return COMPANION_COMMANDS.includes(commandName);      // 默认（含键缺失）⇒ 收敛
}

let suppressNoDomainWarning = true;

const commandList = queryList.concat(actionsList, identityList);
const commandMap = {};
for (let command of commandList) {
    commandMap[command.name] = command;
}

export function getCommand(name) {
    return commandMap[name];
}

export function blacklistCommands(commands) {
    const unblockable = ['!stop', '!stats', '!inventory', '!goal'];
    for (let command_name of commands) {
        if (unblockable.includes(command_name)){
            console.warn(`Command ${command_name} is unblockable`);
            continue;
        }
        delete commandMap[command_name];
        delete commandList.find(command => command.name === command_name);
    }
}

const commandRegex = /!(\w+)(?:\(((?:-?\d+(?:\.\d+)?|true|false|"[^"]*")(?:\s*,\s*(?:-?\d+(?:\.\d+)?|true|false|"[^"]*"))*)\))?/
const argRegex = /-?\d+(?:\.\d+)?|true|false|"[^"]*"/g;

export function containsCommand(message, { fromModel = false } = {}) {
    // 玩家聊天：只认「以命令开头」，避免「用 !buildPlatform 命令铺平台」这种句子被误当命令。
    // 模型输出：仍允许「先说一句话，再另起一行给命令」，那是它的正常播报格式。
    const text = String(message ?? '');
    const trimmed = text.trimStart();
    const commandMatch = trimmed.match(commandRegex);
    if (!commandMatch) return null;
    if (fromModel) return "!" + commandMatch[1];
    if (commandMatch.index === 0 && trimmed === text.trimStart()) return "!" + commandMatch[1];
    return null;
}

export function commandExists(commandName) {
    if (!commandName.startsWith("!"))
        commandName = "!" + commandName;
    return commandMap[commandName] !== undefined;
}

/**
 * Converts a string into a boolean.
 * @param {string} input
 * @returns {boolean | null} the boolean or `null` if it could not be parsed.
 * */
function parseBoolean(input) {
    switch(input.toLowerCase()) {
        case 'false': //These are interpreted as flase;
        case 'f':
        case '0':
        case 'off':
            return false;
        case 'true': //These are interpreted as true;
        case 't':
        case '1':
        case 'on':
            return true;
        default:
            return null;
    }
}

/**
 * @param {number} value - the value to check
 * @param {number} lowerBound
 * @param {number} upperBound
 * @param {string} endpointType - The type of the endpoints represented as a two character string. `'[)'` `'()'` 
 */
function checkInInterval(number, lowerBound, upperBound, endpointType) {
    switch (endpointType) {
        case '[)':
            return lowerBound <= number && number < upperBound;
        case '()':
            return lowerBound < number && number < upperBound;
        case '(]':
            return lowerBound < number && number <= upperBound;
        case '[]':
            return lowerBound <= number && number <= upperBound;
        default:
            throw new Error('Unknown endpoint type:', endpointType)
    }
}



// todo: handle arrays?
/**
 * Returns an object containing the command, the command name, and the comand parameters.
 * If parsing unsuccessful, returns an error message as a string.
 * @param {string} message - A message from a player or language model containing a command.
 * @returns {string | Object}
 */
export function parseCommandMessage(message) {
    const commandMatch = message.match(commandRegex);
    if (!commandMatch) return `Command is incorrectly formatted`;

    const commandName = "!"+commandMatch[1];

    let args;
    if (commandMatch[2]) args = commandMatch[2].match(argRegex);
    else args = [];

    const command = getCommand(commandName);
    if(!command) return `${commandName} is not a command.`

    const params = commandParams(command);
    const paramNames = commandParamNames(command);
    
    // 支持「省略尾部带 default 的参数」（例如 !survey 的半径可省）。
    // 多传依然报错，避免模型以为可以随便塞参数。
    if (args.length > params.length)
        return `Command ${command.name} was given ${args.length} args, but takes at most ${params.length}.`;

    for (let i = 0; i < params.length; i++) {
        const param = params[i];
        if (i >= args.length) {
            // 只有声明了 default 的参数才允许省略；否则照旧报缺参数
            if (!Object.prototype.hasOwnProperty.call(param, 'default'))
                return `Command ${command.name} is missing param '${paramNames[i]}'.`;
            args.push(param.default);
            continue;
        }
        //Remove any extra characters
        let arg = args[i].trim();
        if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
            arg = arg.substring(1, arg.length-1);
        }
        
        //Convert to the correct type
        switch(param.type) {
            case 'int':
                arg = Number.parseInt(arg); break;
            case 'float':
                arg = Number.parseFloat(arg); break;
            case 'boolean':
                arg = parseBoolean(arg); break;
            case 'BlockName':
            case 'BlockOrItemName':
            case 'ItemName':
                if (arg.endsWith('plank') || arg.endsWith('seed'))
                    arg += 's'; // add 's' to for common mistakes like "oak_plank" or "wheat_seed"
            case 'string':
                break;
            default:
                throw new Error(`Command '${commandName}' parameter '${paramNames[i]}' has an unknown type: ${param.type}`);
        }
        if(arg === null || Number.isNaN(arg))
            return `Error: Param '${paramNames[i]}' must be of type ${param.type}.`

        if(typeof arg === 'number') { //Check the domain of numbers
            const domain = param.domain;
            if(domain) {
                /**
                 * Javascript has a built in object for sets but not intervals.
                 * Currently the interval (lowerbound,upperbound] is represented as an Array: `[lowerbound, upperbound, '(]']`
                 */
                if (!domain[2]) domain[2] = '[)'; //By default, lower bound is included. Upper is not.

                if(!checkInInterval(arg, ...domain)) {
                    return `Error: Param '${paramNames[i]}' must be an element of ${domain[2][0]}${domain[0]}, ${domain[1]}${domain[2][1]}.`;
                    //Alternatively arg could be set to the nearest value in the domain.
                }
            } else if (!suppressNoDomainWarning) {
                console.warn(`Command '${commandName}' parameter '${paramNames[i]}' has no domain set. Expect any value [-Infinity, Infinity].`)
                suppressNoDomainWarning = true; //Don't spam console. Only give the warning once.
            }
        } else if(param.type === 'BlockName') { //Check that there is a block with this name
            if(getBlockId(arg) == null) return  `Invalid block type: ${arg}.`
        } else if(param.type === 'ItemName') { //Check that there is an item with this name
            if(getItemId(arg) == null) return `Invalid item type: ${arg}.`
        } else if(param.type === 'BlockOrItemName') {
            if(getBlockId(arg) == null && getItemId(arg) == null) return  `Invalid block or item type: ${arg}.`
        }
        args[i] = arg;
    }
    
    return { commandName, args };
}

export function truncCommandMessage(message) {
    const commandMatch = message.match(commandRegex);
    if (commandMatch) {
        return message.substring(0, commandMatch.index + commandMatch[0].length);
    }
    return message;
}

export function isAction(name) {
    return actionsList.find(action => action.name === name) !== undefined;
}

/**
 * @param {Object} command
 * @returns {Object[]} The command's parameters.
 */
function commandParams(command) {
    if (!command.params)
        return [];
    return Object.values(command.params);
}

/**
 * @param {Object} command
 * @returns {string[]} The names of the command's parameters.
 */
function commandParamNames(command) {
    if (!command.params)
        return [];
    return Object.keys(command.params);
}

function numParams(command) {
    return commandParams(command).length;
}

/**
 * 参数通道：`{ command, args }` 直接当**数据**用，不再拼命令串（第一轮审查 第1条 ⑤）。
 *
 * 缺陷原貌：`tasks.js:407` 把任务 JSON 里的 `agentGoal` 插进
 * `` `!goal("${agentGoal}")` ``、`:509` 把 `this.data.conversation` 插进
 * `` `!startConversation("${other_name}", "${…}")` ``，两处都带 `internal: true`
 * ——而 `internal: true` 的设计意图正是**跳过发言人权限闸门**。于是「改一个任务 JSON」
 * 就等于「以主人身份执行任意 owner 级命令」：`agentGoal` 里塞一个 `")` 就能闭合字符串，
 * 后面接什么就是什么。不需要 socket、不需要认证、不需要写代码。
 *
 * 修法：命令名 + 参数数组分开传，参数不经过 `parseCommandMessage` 的正则，
 * 插值逃逸这条路径就不存在了（不是靠转义，而是根本没有拼接）。
 * @param {{command: string, args?: Array<string|number|boolean>}} spec
 * @returns {string | {commandName: string, args: Array}}
 */
export function normalizeArgsCommand(spec) {
    const rawName = String(spec?.command ?? '');
    const commandName = rawName.startsWith('!') ? rawName : '!' + rawName;
    if (!/^!\w+$/.test(commandName)) return `命令名不合法: ${JSON.stringify(rawName)}`;
    if (!getCommand(commandName)) return `${commandName} is not a command.`;
    const args = Array.isArray(spec.args) ? spec.args.slice() : [];
    for (const v of args) {
        const t = typeof v;
        // 只收标量：对象/数组进来基本就是调用方写错了，放进去只会让 perform 里炸得更远
        if (t !== 'string' && t !== 'number' && t !== 'boolean') {
            return `命令 ${commandName} 的参数只能是 string/number/boolean，收到 ${t}`;
        }
    }
    return { commandName, args };
}

/**
 * 取发言人的 uuid（离线/在线都取服务端给的那个）。
 *
 * 为什么不是"名字"：任务 ① 的要害是**名字可随便改**。`bot.players[name].uuid`
 * 是服务端认的身份；名字只在"还没绑定"时用于显示与兼容回退。
 *
 * @param {object} agent
 * @param {string|null} author
 * @returns {string|null}
 */
export function playerUuidOf(agent, author) {
    const name = typeof author === 'string' ? author.trim() : '';
    if (!name) return null;
    try {
        const p = agent?.bot?.players?.[name];
        return p && typeof p.uuid === 'string' ? p.uuid : null;
    } catch { return null; }
}

/**
 * 组装"身份绑定"上下文，交给 `resolveLevel`。
 *
 * 三档的来源与优先级（都能被 profile 覆盖，profile 优先于全局 settings）：
 *   · `enabled`：绑定模式开不开（默认**开** —— 这正是 ① 要的默认安全姿态）
 *   · `legacy_profile_names`：是否允许退回"按名字给权限"（默认**关**）
 *   · `resolve({uuid, name})`：查绑定表；查不到返回 null
 *
 * 诚实边界：关掉绑定（`enabled:false`）等于回到审计前的行为（名字即权限），
 * 只留给"还没准备好迁移"的部署，且会在启动日志里由 mindserver 提醒。
 *
 * @param {object} agent
 * @returns {{enabled:boolean, legacyNames:boolean, resolve:Function|null}}
 */
export function identityContextOf(agent) {
    const perms = agent?.prompter?.profile?.permissions ?? {};
    const profileCfg = (perms && typeof perms.identity === 'object' && perms.identity) ? perms.identity : {};
    const settingsCfg = (settings && typeof settings.identity_binding === 'object' && settings.identity_binding)
        ? settings.identity_binding : {};

    const enabled = profileCfg.enabled ?? settingsCfg.enabled ?? true;
    const legacyNames = profileCfg.legacy_profile_names ?? settingsCfg.legacy_profile_names ?? false;
    // ★ t20：离线服的处置策略（默认 deny = 弱绑定不授 owner）
    const offlineOwnerMode = String(profileCfg.offline_owner_mode ?? settingsCfg.offline_owner_mode ?? 'deny').toLowerCase();
    const sessionMinutes = Number(profileCfg.offline_session_minutes ?? settingsCfg.offline_session_minutes ?? 60);
    const sessionWindowMs = (Number.isFinite(sessionMinutes) && sessionMinutes > 0 ? sessionMinutes : 60) * 60_000;
    if (!enabled) {
        // 关掉绑定 = 老的按名字判级（permissions.resolveLevel 的第 4~5 步）
        return { enabled: false, legacyNames: true, resolve: null };
    }
    const agentName = agent?.name ?? agent?.bot?.username ?? null;
    const ctx = {
        enabled: true,
        legacyNames: legacyNames === true,
        offlineOwnerMode: offlineOwnerMode === 'session' ? 'session' : 'deny',
        sessionMinutes: Number.isFinite(sessionMinutes) && sessionMinutes > 0 ? sessionMinutes : 60,
        /** 最近一次 resolve 的结果（拒绝话术要用 reason，避免再读一次盘）。 */
        lastResolved: null,
        peek: () => ctx.lastResolved,
        // 每执行一条命令读一次表：绑定/解绑是低频事件，而"读到旧表"会让解绑失效很久。
        resolve: ({ uuid, name }) => {
            if (!agentName) return null;
            const read = readStore(identityFileOf(agentName));
            if (!read.ok && !read.store.bindings.length) return null;
            const hit = resolveBinding(read.store, { uuid, name });
            // ★ 记的是**最终裁决**（可能已被下面的 offline 策略降级），
            //   拒绝话术读它来决定"说真话还是让玩家去 claim"。
            const settle = (result) => { ctx.lastResolved = result; return result; };
            if (!hit || !hit.level) return settle(hit);

            // ★★★ R4 t20：**弱绑定（离线服按名字派生 uuid）不许持久授 owner。**
            //
            // 为什么必须在这里拦：离线服上"同名 ⇒ 同 uuid"，冒名者改个客户端名就能命中
            // 这条绑定。不拦的话 t13 在 online-mode=false 下等于没有保护（见 t20 说明）。
            //
            // 两种处置：
            //   · deny（默认）：离线 + 弱绑定 ⇒ 永远 guest，并明确说"无法证明你是你"；
            //   · session     ：只在"最近 N 分钟内刚 !claim 过"时授 owner（内存态、不落盘），
            //                   其余时间 guest。这是"降低暴露窗口"，**不是**证明身份。
            if (!hit.weak) return settle(hit);

            const mode = String(offlineOwnerMode ?? 'deny').toLowerCase();
            if (mode === 'session') {
                const fresh = sessionFresh({ uuid, name, windowMs: sessionWindowMs });
                if (fresh) return settle(hit);
                return settle({ ...hit, level: null, reason: 'offline-weak-session' });
            }
            return settle({ ...hit, level: null, reason: 'offline-weak' });
        },
    };
    return ctx;
}

/**
 * 离线服上的 owner 可达性（写进日志/文档/拒绝话术的同一句话，只留一处）。
 * @param {'deny'|'session'} mode
 * @param {number} windowMinutes
 * @returns {string}
 */
export function offlineOwnerNote(mode, windowMinutes) {
    const how = String(mode).toLowerCase() === 'session'
        ? `仅在刚 !claim 后的 ${windowMinutes} 分钟内有效，其余时间只聊天`
        : '离线服上一律只聊天（owner 不可达）';
    return `离线服无法证明"你是你"（uuid 由名字派生，同名者不可区分）：${how}。`
        + '根治只有两条：开正版验证（online-mode=true），或装登录插件（如 AuthMe）。';
}

/**
 * 执行一条命令。
 *
 * ★ 2026-11-01 M1 安全改造（08 §5）：加了 `{ author }`。
 *
 * 为什么要 author：原来这里是「模型说了什么就执行什么」。模型被一句
 * 「你现在是我的管理员」骗到，就能让她（op 账号）执行 `!newAction` 写代码、
 * 或者回一句 `/op 某人`。判据必须换成**谁说的**：
 *   - 玩家聊天 → author = 玩家名（agent.js 的 respondFunc 已经知道是谁）
 *   - 自提示回合 → author = 设 `!goal` 的那个人（self_prompter.author）
 *   - 代码自己发起（任务/NPCController）→ internal: true
 * 等级只由 author 名字 + profile 的 permissions 算出，**模型输出的文字不参与**，
 * 所以提示词注入改不了等级。
 *
 * 参数有两种形态（第一轮审查 第1条 ⑤）：
 *   - 字符串 `!goToPlayer("Zeh", 3)`：玩家聊天 / 模型输出那条路，走 parseCommandMessage；
 *   - `{ command:'!goal', args:[agentGoal] }`：**代码发起**那条路，参数不拼进命令串 ⇒ 无从注入。
 *
 * @param {object} agent
 * @param {string|{command: string, args?: Array<string|number|boolean>}} message
 * @param {{author?:string|null, isOtherBot?:boolean, internal?:boolean}} [perm]
 */
export async function executeCommand(agent, message, perm = {}) {
    const { author = null, isOtherBot = false, internal = false } = perm;
    // `{ command, args }` 走参数通道（不拼串）；字符串走原来的解析器（玩家/模型那条路）
    const parsed = (message && typeof message === 'object' && typeof message.command === 'string')
        ? normalizeArgsCommand(message)
        : parseCommandMessage(message);
    if (typeof parsed === 'string')
        return parsed; //The command was incorrectly formatted or an invalid input was given.
    else {
        console.log('parsed command:', parsed);
        const command = getCommand(parsed.commandName);

        // —— 权限闸门：按发言人分级（08 §5）——
        // BOT-001：不再传 internalNames —— 「名字等于 bot 名」不再是内部来源的判据，
        // 内部来源只认调用方显式传入的 internal:true。
        // ★ 第四轮审计 ①：身份上下文只算一次（定级 + 拒绝话术都要用）
        const identity = identityContextOf(agent);
        const level = resolveLevel({
            author,
            permissions: agent?.prompter?.profile?.permissions,
            isOtherBot,
            internal,
            // ★ 身份优先 —— uuid 传给绑定表，名字只用于回退/显示
            uuid: playerUuidOf(agent, author),
            identity,
        });
        if (!canRunCommand(level, parsed.commandName)) {
            console.warn(`[权限] 拒绝 ${parsed.commandName}：author=${author ?? '(none)'} level=${level}`);
            // 拒绝话术要**可照做**：绑定模式开着时直接告诉玩家去面板取码 !claim，
            // 而不是只丢一句"你是 other"（升级后老用户会以为 bot 坏了）。
            const hit = typeof identity.peek === 'function' ? identity.peek() : null;
            return permissionDeniedReply(level, parsed.commandName, author, {
                bindingRequired: identity.enabled === true && identity.legacyNames !== true,
                isOtherBot,
                // t20：弱绑定被拒时话术要换成"离线服证明不了你是你"，而不是"去 claim 一次"
                offlineWeak: hit?.weak === true && /^offline-weak/.test(String(hit?.reason ?? '')),
                offlineMode: identity.offlineOwnerMode,
                sessionMinutes: identity.sessionMinutes,
            });
        }

        let numArgs = 0;
        if (parsed.args) {
            numArgs = parsed.args.length;
        }
        if (numArgs !== numParams(command))
            return `Command ${command.name} was given ${numArgs} args, but requires ${numParams(command)} args.`;
        else {
            // 记下「这条命令是谁下的」，给 !goal 之类需要留存发言人的命令用（self_prompter 按它判等级）
            const prev_author = agent.command_author;
            agent.command_author = author;
            try {
                const result = await command.perform(agent, ...parsed.args);
                return result;
            } finally {
                agent.command_author = prev_author;
            }
        }
    }
}

export function getCommandDocs(agent) {
    const typeTranslations = {
        //This was added to keep the prompt the same as before type checks were implemented.
        //If the language model is giving invalid inputs changing this might help.
        'float':             'number',
        'int':               'number',
        'BlockName':         'string',
        'ItemName':          'string',
        'BlockOrItemName':   'string',
        'boolean':           'bool'
    }
    let docs = `\n*COMMAND DOCS\n You can use the following commands to perform actions and get information about the world. 
    Use the commands with the syntax: !commandName or !commandName("arg1", 1.2, ...) if the command takes arguments.\n
    Do not use codeblocks. Use double quotes for strings. Only use one command in each response, trailing commands and comments will be ignored.\n`;
    for (let command of commandList) {
        if (agent.blocked_actions.includes(command.name)) {
            continue;
        }
        // 陪玩模式：只把 7 条命令写进提示词（方案 §12）。
        if (!isVisibleToModel(command.name)) {
            continue;
        }
        docs += command.name + ': ' + command.description + '\n';
        if (command.params) {
            docs += 'Params:\n';
            for (let param in command.params) {
                docs += `${param}: (${typeTranslations[command.params[param].type]??command.params[param].type}) ${command.params[param].description}\n`;
            }
        }
    }
    return docs + '*\n';
}
