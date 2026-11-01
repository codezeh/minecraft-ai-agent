import { getBlockId, getItemId } from "../../utils/mcdata.js";
import { actionsList } from './actions.js';
import { queryList } from './queries.js';
import settings from '../settings.js';
// 发言人分级（M1 安全，08 §5）：命令能不能执行由「谁说的」定，不由模型说了什么定
import { resolveLevel, canRunCommand, permissionDeniedReply } from '../permissions.js';

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

/** 该命令是否应该出现在给模型的文档里。 */
export function isVisibleToModel(commandName) {
    if (!settings.companion_mode) return true;
    return COMPANION_COMMANDS.includes(commandName);
}

let suppressNoDomainWarning = true;

const commandList = queryList.concat(actionsList);
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
 * @param {object} agent
 * @param {string} message 形如 `!goToPlayer("Zeh", 3)`
 * @param {{author?:string|null, isOtherBot?:boolean, internal?:boolean}} [perm]
 */
export async function executeCommand(agent, message, perm = {}) {
    const { author = null, isOtherBot = false, internal = false } = perm;
    let parsed = parseCommandMessage(message);
    if (typeof parsed === 'string')
        return parsed; //The command was incorrectly formatted or an invalid input was given.
    else {
        console.log('parsed command:', parsed);
        const command = getCommand(parsed.commandName);

        // —— 权限闸门：按发言人分级（08 §5）——
        const level = resolveLevel({
            author,
            permissions: agent?.prompter?.profile?.permissions,
            isOtherBot,
            internal,
            internalNames: agent?.name ? [agent.name] : [],
        });
        if (!canRunCommand(level, parsed.commandName)) {
            console.warn(`[权限] 拒绝 ${parsed.commandName}：author=${author ?? '(none)'} level=${level}`);
            return permissionDeniedReply(level, parsed.commandName, author);
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
