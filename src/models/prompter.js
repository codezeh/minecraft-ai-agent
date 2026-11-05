import { readFileSync, mkdirSync, writeFileSync} from 'fs';
import { Examples } from '../utils/examples.js';
import { getCommandDocs } from '../agent/commands/index.js';
import { SkillLibrary } from "../agent/library/skill_library.js";
import { stringifyTurns } from '../utils/text.js';
import { getCommand } from '../agent/commands/index.js';
import settings from '../agent/settings.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { selectAPI, createModel } from './_model_map.js';
// 第31条：模型层失败会以 `[LLM_ERROR] …` 回来，prompter 必须把它当"失败"而不是"回答"
import { isFailedReply } from './_shared.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 把 agent 名字解析成 `bots/` 下的目录，**并断言没跑出 botsRoot**（第一轮审查 第2条）。
 *
 * 为什么这条不能省：名字来自客户端。虽然 mindserver 的 create-agent 与 agent.js:205
 * 现在都会先用 validateNameFormat 拒掉 `../../pwn`，但直到这次修复之前，
 * `new Prompter()`（agent.js:147）比那句校验早 58 行就已经 mkdir + writeFile 了 ——
 * 名字一旦漏过去，写入就已经发生，事后校验撤销不了已经写出去的文件。
 * 所以这里做最后一道事实校验：解析后的路径必须以 `bots/` 开头。
 *
 * @param {string} name agent 名
 * @param {string} [sub] `bots/<name>/` 之下的相对子路径（如 'logs'）
 * @param {string} [botsRoot] `bots/` 根目录（默认 `process.cwd()/bots`；日志那处原本以模块位置为基准，
 *        保留原基准以免改变运行期的日志落点）
 * @returns {string} 绝对路径
 */
export function botDirOf(name, sub = '', botsRoot = path.resolve(process.cwd(), 'bots')) {
    // 空白名与空名同等对待（`path.resolve(root,'   ')` 会得到一个"看起来合法"的目录名）
    if (!String(name ?? '').trim()) {
        throw new Error(`非法 agent 名（为空）: ${JSON.stringify(String(name ?? ''))}`);
    }
    const dir = path.resolve(botsRoot, String(name), sub);
    if (dir !== botsRoot && !dir.startsWith(botsRoot + path.sep)) {
        throw new Error(`非法 agent 名（路径逃逸已拦截）: ${JSON.stringify(String(name))}`);
    }
    if (dir === botsRoot) {
        throw new Error(`非法 agent 名（为空）: ${JSON.stringify(String(name))}`);
    }
    return dir;
}

// Build the object selectAPI() needs from a profile, carrying over the
// optional api/url/params overrides so relays can be configured in profiles.
function pickModelConfig(src) {
    const cfg = { model: src.model };
    if (src.api) cfg.api = src.api;
    if (src.url) cfg.url = src.url;
    if (src.params) cfg.params = src.params;
    return cfg;
}

export class Prompter {
    constructor(agent, profile) {
        this.agent = agent;
        this.profile = profile;
        const defaults_dir = path.join(__dirname, '../../profiles/defaults');
        let default_profile = JSON.parse(readFileSync(path.join(defaults_dir, '_default.json'), 'utf8'));
        let base_fp = '';
        if (settings.base_profile.includes('survival')) {
            base_fp = path.join(defaults_dir, 'survival.json');
        } else if (settings.base_profile.includes('assistant')) {
            base_fp = path.join(defaults_dir, 'assistant.json');
        } else if (settings.base_profile.includes('creative')) {
            base_fp = path.join(defaults_dir, 'creative.json');
        } else if (settings.base_profile.includes('god_mode')) {
            base_fp = path.join(defaults_dir, 'god_mode.json');
        }
        let base_profile = JSON.parse(readFileSync(base_fp, 'utf8'));

        // first use defaults to fill in missing values in the base profile
        for (let key in default_profile) {
            if (base_profile[key] === undefined)
                base_profile[key] = default_profile[key];
        }
        // then use base profile to fill in missing values in the individual profile
        for (let key in base_profile) {
            if (this.profile[key] === undefined)
                this.profile[key] = base_profile[key];
        }
        // base overrides default, individual overrides base

        this.convo_examples = null;
        this.coding_examples = null;
        
        let name = this.profile.name;
        this.cooldown = this.profile.cooldown ? this.profile.cooldown : 0;
        this.last_prompt_time = 0;
        this.awaiting_coding = false;

        // for backwards compatibility, move max_tokens to params
        let max_tokens = null;
        if (this.profile.max_tokens)
            max_tokens = this.profile.max_tokens;

        // Pass the whole model config (not just the model name) so that a
        // profile can pin `api` and `url` for OpenAI-compatible relays.
        // selectAPI() still accepts a bare string for backwards compatibility.
        let chat_model_profile = selectAPI(pickModelConfig(this.profile));
        this.chat_model = createModel(chat_model_profile);

        if (this.profile.code_model) {
            let code_model_profile = selectAPI(pickModelConfig({ model: this.profile.code_model, api: this.profile.code_api, url: this.profile.code_url }));
            this.code_model = createModel(code_model_profile);
        }
        else {
            this.code_model = this.chat_model;
        }

        if (this.profile.vision_model) {
            let vision_model_profile = selectAPI(pickModelConfig({ model: this.profile.vision_model, api: this.profile.vision_api, url: this.profile.vision_url }));
            this.vision_model = createModel(vision_model_profile);
        }
        else {
            this.vision_model = this.chat_model;
        }

        
        let embedding_model_profile = null;
        if (this.profile.embedding) {
            try {
                embedding_model_profile = selectAPI(this.profile.embedding);
            } catch (e) {
                embedding_model_profile = null;
            }
        }
        if (embedding_model_profile) {
            this.embedding_model = createModel(embedding_model_profile);
        }
        else {
            // No embedding configured: leave it null so Examples/SkillLibrary
            // fall back to word-overlap instead of probing an unsupported endpoint.
            this.embedding_model = null;
        }

        this.skill_libary = new SkillLibrary(agent, this.embedding_model);
        // 第2条：路径先解析再断言（botDirOf），不写 `./bots/${name}` 裸拼
        const botDir = botDirOf(name);
        mkdirSync(botDir, { recursive: true });
        writeFileSync(path.join(botDir, 'last_profile.json'), JSON.stringify(this.profile, null, 4), (err) => {
            if (err) {
                throw new Error('Failed to save profile:', err);
            }
            console.log("Copy profile saved.");
        });
    }

    getName() {
        return this.profile.name;
    }

    getInitModes() {
        return this.profile.modes;
    }

    async initExamples() {
        try {
            this.convo_examples = new Examples(this.embedding_model, settings.num_examples);
            this.coding_examples = new Examples(this.embedding_model, settings.num_examples);
            
            // Wait for both examples to load before proceeding
            await Promise.all([
                this.convo_examples.load(this.profile.conversation_examples),
                this.coding_examples.load(this.profile.coding_examples),
                this.skill_libary.initSkillLibrary()
            ]).catch(error => {
                // Preserve error details
                console.error('Failed to initialize examples. Error details:', error);
                console.error('Stack trace:', error.stack);
                throw error;
            });

            console.log('Examples initialized.');
        } catch (error) {
            console.error('Failed to initialize examples:', error);
            console.error('Stack trace:', error.stack);
            throw error; // Re-throw with preserved details
        }
    }

    async replaceStrings(prompt, messages, examples=null, to_summarize=[], last_goals=null) {
        // `name` doubles as the Minecraft login name, so it must stay ASCII.
        // display_name lets the agent call itself something nicer (e.g. 中文名).
        prompt = prompt.replaceAll('$NAME', this.profile.display_name || this.agent.name);

        if (prompt.includes('$STATS')) {
            let stats = await getCommand('!stats').perform(this.agent) + '\n';
            stats += await getCommand('!entities').perform(this.agent) + '\n';
            stats += await getCommand('!nearbyBlocks').perform(this.agent);
            prompt = prompt.replaceAll('$STATS', stats);
        }
        if (prompt.includes('$INVENTORY')) {
            let inventory = await getCommand('!inventory').perform(this.agent);
            prompt = prompt.replaceAll('$INVENTORY', inventory);
        }
        if (prompt.includes('$ACTION')) {
            prompt = prompt.replaceAll('$ACTION', this.agent.actions.currentActionLabel);
        }
        if (prompt.includes('$COMMAND_DOCS'))
            prompt = prompt.replaceAll('$COMMAND_DOCS', getCommandDocs(this.agent));
        if (prompt.includes('$CODE_DOCS')) {
            const code_task_content = messages.slice().reverse().find(msg =>
                msg.role !== 'system' && msg.content.includes('!newAction(')
            )?.content?.match(/!newAction\((.*?)\)/)?.[1] || '';

            prompt = prompt.replaceAll(
                '$CODE_DOCS',
                await this.skill_libary.getRelevantSkillDocs(code_task_content, settings.relevant_docs_count)
            );
        }
        if (prompt.includes('$EXAMPLES') && examples !== null)
            prompt = prompt.replaceAll('$EXAMPLES', await examples.createExampleMessage(messages));
        if (prompt.includes('$MEMORY'))
            prompt = prompt.replaceAll('$MEMORY', this.agent.history.memory);
        if (prompt.includes('$TO_SUMMARIZE'))
            prompt = prompt.replaceAll('$TO_SUMMARIZE', stringifyTurns(to_summarize));
        if (prompt.includes('$CONVO'))
            prompt = prompt.replaceAll('$CONVO', 'Recent conversation:\n' + stringifyTurns(messages));
        if (prompt.includes('$SELF_PROMPT')) {
            // if active or paused, show the current goal
            let self_prompt = !this.agent.self_prompter.isStopped() ? `YOUR CURRENT ASSIGNED GOAL: "${this.agent.self_prompter.prompt}"\n` : '';
            prompt = prompt.replaceAll('$SELF_PROMPT', self_prompt);
        }
        if (prompt.includes('$LAST_GOALS')) {
            let goal_text = '';
            for (let goal in last_goals) {
                if (last_goals[goal])
                    goal_text += `You recently successfully completed the goal ${goal}.\n`;
                else
                    goal_text += `You recently failed to complete the goal ${goal}.\n`;
            }
            prompt = prompt.replaceAll('$LAST_GOALS', goal_text.trim());
        }
        if (prompt.includes('$BLUEPRINTS')) {
            if (this.agent.npc.constructions) {
                let blueprints = '';
                for (let blueprint in this.agent.npc.constructions) {
                    blueprints += blueprint + ', ';
                }
                prompt = prompt.replaceAll('$BLUEPRINTS', blueprints.slice(0, -2));
            }
        }

        // check if there are any remaining placeholders with syntax $<word>
        let remaining = prompt.match(/\$[A-Z_]+/g);
        if (remaining !== null) {
            console.warn('Unknown prompt placeholders:', remaining.join(', '));
        }
        return prompt;
    }

    async checkCooldown() {
        let elapsed = Date.now() - this.last_prompt_time;
        if (elapsed < this.cooldown && this.cooldown > 0) {
            await new Promise(r => setTimeout(r, this.cooldown - elapsed));
        }
        this.last_prompt_time = Date.now();
    }

    async promptConvo(messages) {
        this.most_recent_msg_time = Date.now();
        let current_msg_time = this.most_recent_msg_time;

        for (let i = 0; i < 3; i++) { // try 3 times to avoid hallucinations
            await this.checkCooldown();
            if (current_msg_time !== this.most_recent_msg_time) {
                return '';
            }

            let prompt = this.profile.conversing;
            prompt = await this.replaceStrings(prompt, messages, this.convo_examples);
            let generation;

            try {
                generation = await this.chat_model.sendRequest(messages, prompt);
                if (typeof generation !== 'string') {
                    console.error('Error: Generated response is not a string', generation);
                    throw new Error('Generated response is not a string');
                }
                // 第31条：模型层失败会以 `[LLM_ERROR] …` 回来。**它不是模型说的话** ——
                // 当正常回答处理会：写进 history、真的对玩家说出来、白消费一次 response 预算。
                // 这里保留日志（便于统计失败率），但不把它当回答。
                if (isFailedReply(generation)) {
                    console.warn(`[llm] ${this.agent.name} 本轮模型调用失败，按无响应处理（不写 history、不发玩家）: ${generation}`);
                    await this._saveLog(prompt, messages, generation, 'conversation-failed');
                    // **直接返回空串、不再重试**：适配器内部已经把 429 / 上下文超长重试过了，
                    // 走到这里的失败说明供应商这一轮就是不行；立刻再打三次只会把
                    // 「一次请求超时」放大成「三次超时」，在游戏里就是几十秒的僵住。
                    return '';
                }
                console.log("Generated response:", generation);
                await this._saveLog(prompt, messages, generation, 'conversation');

            } catch (error) {
                console.error('Error during message generation or file writing:', error);
                continue;
            }

            // Check for hallucination or invalid output
            if (generation?.includes('(FROM OTHER BOT)')) {
                console.warn('LLM hallucinated message as another bot. Trying again...');
                continue;
            }

            if (current_msg_time !== this.most_recent_msg_time) {
                console.warn(`${this.agent.name} received new message while generating, discarding old response.`);
                return '';
            }

            if (generation?.includes('</think>')) {
                const [_, afterThink] = generation.split('</think>');
                generation = afterThink;
            }

            return generation;
        }

        return '';
    }

    async promptCoding(messages) {
        if (this.awaiting_coding) {
            console.warn('Already awaiting coding response, returning no response.');
            return '```//no response```';
        }
        this.awaiting_coding = true;
        await this.checkCooldown();
        let prompt = this.profile.coding;
        prompt = await this.replaceStrings(prompt, messages, this.coding_examples);

        let resp = await this.code_model.sendRequest(messages, prompt);
        this.awaiting_coding = false;
        await this._saveLog(prompt, messages, resp, isFailedReply(resp) ? 'coding-failed' : 'coding');
        // 第31条：失败标记原样往上传（带 `[LLM_ERROR]` 前缀 ⇒ 不会被误当代码）。
        // coder.js 那边 `res.indexOf('```') === -1` 会走既有的「没写代码→重试」分支，不会把它执行。
        return resp;
    }

    async promptMemSaving(to_summarize) {
        await this.checkCooldown();
        let prompt = this.profile.saving_memory;
        prompt = await this.replaceStrings(prompt, null, null, to_summarize);
        let resp = await this.chat_model.sendRequest([], prompt);
        await this._saveLog(prompt, to_summarize, resp, isFailedReply(resp) ? 'memSaving-failed' : 'memSaving');
        // 第31条：失败**绝不能**当成"新记忆摘要"存进去 —— 那会把这条假台词写进 memory.json，
        // 而且会覆盖掉上一轮真实摘要。失败时保留原记忆（history.js 会 `this.memory = 返回值`）。
        if (isFailedReply(resp)) {
            console.warn(`[llm] ${this.agent.name} 记忆摘要失败，保留原记忆不覆盖: ${resp}`);
            return this.agent?.history?.memory ?? '';
        }
        if (resp?.includes('</think>')) {
            const [_, afterThink] = resp.split('</think>');
            resp = afterThink;
        }
        return resp;
    }

    async promptShouldRespondToBot(new_message) {
        await this.checkCooldown();
        let prompt = this.profile.bot_responder;
        let messages = this.agent.history.getHistory();
        messages.push({role: 'user', content: new_message});
        prompt = await this.replaceStrings(prompt, null, null, messages);
        let res = await this.chat_model.sendRequest([], prompt);
        // 第31条：失败标记不是 "respond" —— 显式判掉，别指望字符串比较碰巧为 false
        if (isFailedReply(res)) {
            console.warn(`[llm] ${this.agent.name} bot_responder 调用失败，按「不接话」处理: ${res}`);
            return false;
        }
        return res.trim().toLowerCase() === 'respond';
    }

    async promptVision(messages, imageBuffer) {
        await this.checkCooldown();
        let prompt = this.profile.image_analysis;
        prompt = await this.replaceStrings(prompt, messages, null, null, null);
        return await this.vision_model.sendVisionRequest(messages, prompt, imageBuffer);
    }

    async promptGoalSetting(messages, last_goals) {
        // deprecated
        let system_message = this.profile.goal_setting;
        system_message = await this.replaceStrings(system_message, messages);

        let user_message = 'Use the below info to determine what goal to target next\n\n';
        user_message += '$LAST_GOALS\n$STATS\n$INVENTORY\n$CONVO';
        user_message = await this.replaceStrings(user_message, messages, null, null, last_goals);
        let user_messages = [{role: 'user', content: user_message}];

        let res = await this.chat_model.sendRequest(user_messages, system_message);

        // 第31条：失败标记不可能解析出 goal，直接返回 null（别在下面按 `res.split` 崩）
        if (isFailedReply(res)) {
            console.log(`[llm] ${this.agent.name} goal_setting 调用失败: ${res}`);
            return null;
        }

        let goal = null;
        try {
            let data = res.split('```')[1].replace('json', '').trim();
            goal = JSON.parse(data);
        } catch (err) {
            console.log('Failed to parse goal:', res, err);
        }
        if (!goal || !goal.name || !goal.quantity || isNaN(parseInt(goal.quantity))) {
            console.log('Failed to set goal:', res);
            return null;
        }
        goal.quantity = parseInt(goal.quantity);
        return goal;
    }

    async _saveLog(prompt, messages, generation, tag) {
        if (!settings.log_all_prompts)
            return;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        let logEntry;
        let task_id = this.agent.task.task_id;
        if (task_id == null) {
            logEntry = `[${timestamp}] \nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
        } else {
            logEntry = `[${timestamp}] Task ID: ${task_id}\nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
        }
        const logFile = `${tag}_${timestamp}.txt`;
        await this._saveToFile(logFile, logEntry);
    }

    async _saveToFile(logFile, logEntry) {
        let task_id = this.agent.task.task_id;
        // 同一根因的第二个写入点（原来是 `path.join(__dirname, '../../bots/${name}/logs')`）：
        // 走 botDirOf 断言，越界的名字在这里同样拦下。
        const logDir = task_id == null
            ? botDirOf(this.agent.name, 'logs', path.resolve(__dirname, '../../bots'))
            : botDirOf(this.agent.name, path.join('logs', String(task_id)), path.resolve(__dirname, '../../bots'));

        await fs.mkdir(logDir, { recursive: true });

        logFile = path.join(logDir, logFile);
        await fs.appendFile(logFile, String(logEntry), 'utf-8');
    }
}
