import { readFileSync, mkdirSync, writeFileSync} from 'fs';
import { Examples } from '../utils/examples.js';
import { getCommandDocs } from '../agent/commands/index.js';
import { SkillLibrary } from "../agent/library/skill_library.js";
import { stringifyTurns, fenceUntrusted } from '../utils/text.js';
import { getCommand } from '../agent/commands/index.js';
import settings from '../agent/settings.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { selectAPI, createModel } from './_model_map.js';
// 第31条：模型层失败会以 `[LLM_ERROR] …` 回来，prompter 必须把它当"失败"而不是"回答"
import { isFailedReply, noCodeReply, LLM_MAX_CALL_MS } from './_shared.js';
// 架构收敛项(1)：模型结果的类型化（A5 §3）。步 1 = prompter 内部统一成 ModelResult，
// 公开的旧方法名继续返回 string（toString() 兼容），新代码读 *Result()。
import {
    ModelResult, STATUS, ERROR_CODE, toModelResult, coerceModelResult, noteModelResult, formatModelTotals,
} from './result.js';

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
            prompt = prompt.replaceAll('$MEMORY', fenceUntrusted(this.agent.history.memory, 'memory'));
        if (prompt.includes('$TO_SUMMARIZE'))
            prompt = prompt.replaceAll('$TO_SUMMARIZE', stringifyTurns(to_summarize, { fenced: true }));
        if (prompt.includes('$CONVO'))
            prompt = prompt.replaceAll('$CONVO', 'Recent conversation:\n' + stringifyTurns(messages, { fenced: true }));
        if (prompt.includes('$SELF_PROMPT')) {
            // if active or paused, show the current goal
            // ★ F-AI-202（2026-11-06）：goal 文本来自 `!goal(...)`，是**外部可控**的，原来直接
            //   `"${...}"` 塞进系统提示：引号不转义（可以提前闭合、伪造 `（系统更新）…` 段落）、
            //   长度无上限（可以淹没整段系统提示）。这里做两件事：
            //   ① 转义/折叠：去掉换行与制表，`"` → `\"`，`\` → `\\`，使它无法闭合引号或另起一行；
            //   ② 限长 500：超长截断并标注，防止用长文本把系统提示挤掉。
            //   注意：这**不是**主防线（主防线是 `!goal` 已升 OWNER_ONLY，见 permissions.js），
            //   是"万一将来又开了信任级"时的纵深防护。
            const rawGoal = String(this.agent.self_prompter.prompt ?? '');
            const GOAL_MAX = 500;
            let safeGoal = rawGoal
                .replace(/[\r\n\t]+/g, ' ')      // 折叠换行/制表：不能另起一行伪造段落
                .replace(/\\/g, '\\\\')          // 反斜杠先转
                .replace(/"/g, '\\"');           // 再转双引号：不能提前闭合 "…"
            if (safeGoal.length > GOAL_MAX) {
                safeGoal = safeGoal.slice(0, GOAL_MAX) + `…[已截断，原长 ${rawGoal.length}]`;
            }
            let self_prompt = !this.agent.self_prompter.isStopped() ? `YOUR CURRENT ASSIGNED GOAL: "${safeGoal}"\n` : '';
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

    /** 旧契约（string）：给尚未迁移的调用点用。新代码请直接读 promptConvoResult()。 */
    async promptConvo(messages, opts = {}) {
        const r = await this.promptConvoResult(messages, opts);
        // 过渡兼容的**唯一**行为差异点：旧契约把"本轮失败"表示成空串（agent.js 见空串即 break）。
        // 类型化之后失败是 status=error（可判别、可统计），但这里仍还原成空串，
        // 保证字符串派调用点（agent.js:753）在迁移期逐字不变 —— 新代码请读 promptConvoResult()。
        if (r.failed) return '';
        return this._legacyString(r);
    }

    /**
     * ★★★ 第四轮复审 架构收敛项(1) 步 1：带类型的对话生成（A5 §3.3）。
     *
     * 与旧实现逐条对应，只是把"三义同形"的字符串换成 status：
     *   · 失败         → status=error（旧：返回 ''，与"模型没话说"不可区分 ⇒ A5 §6.1）
     *   · 输出被截断   → status=truncated + content 已剥离标记（旧：串末尾挂标记再由调用方剥）
     *   · 被新消息取代 → status=cancelled（旧：返回 ''；toString() 仍返回 ''，行为不变）
     */
    async promptConvoResult(messages, opts = {}) {
        // ★★★ t4（A5 §5 方案 B 第 3 跳）：opts 是**可选**的 `{signal, deadline, operationId}`。
        //   不传 = 与改造前逐字一致（t3 的取消序号仍然负责"同一个回合内"的取消）。
        const callOpts = this._callOptions(opts);
        // 入口就查一次：已经取消/超期就别发请求（省一次最长 30 分钟的等待）
        if (callOpts.signal?.aborted) {
            const cancelled = new ModelResult({
                status: STATUS.CANCELLED, errorCode: ERROR_CODE.CANCELLED,
                errorMessage: '操作在发请求前已被取消',
            });
            cancelled.operationId = callOpts.operationId;   // 诊断字段：t2 的 ModelResult 不认未知构造字段，故后挂
            return this._convoResult(cancelled);
        }
        this.most_recent_msg_time = Date.now();
        let current_msg_time = this.most_recent_msg_time;

        for (let i = 0; i < 3; i++) { // try 3 times to avoid hallucinations
            await this.checkCooldown();
            if (current_msg_time !== this.most_recent_msg_time) {
                return this._convoResult(new ModelResult({
                    status: STATUS.CANCELLED, errorCode: ERROR_CODE.CANCELLED, errorMessage: '已被更新的消息取代',
                }));
            }

            let prompt = this.profile.conversing;
            prompt = await this.replaceStrings(prompt, messages, this.convo_examples);
            let typed = null;
            const started = Date.now();

            try {
                // ★ t4 第 4 跳：opts 作为第 4 个可选参数下传（适配器忽略它就是旧行为）。
                const generation = await this.chat_model.sendRequest(messages, prompt, undefined, callOpts);
                if (typeof generation !== 'string' && !(generation instanceof ModelResult)) {
                    console.error('Error: Generated response is not a string', generation);
                    throw new Error('Generated response is not a string');
                }
                // 第31条：失败**不是模型说的话**。现在由 status 承载（不再靠前缀猜）。
                // 仍不重试：适配器内部已把 429 / 上下文超长重试过了，立刻再打三次只会把
                // 「一次超时」放大成「三次超时」，在游戏里就是几十秒的僵住。
                typed = toModelResult(generation, {
                    elapsedMs: Date.now() - started, attempts: i + 1,
                    operationId: callOpts.operationId,
                });
                // ★ t4：**迟到的结果不算回答** —— 请求期间这次操作被取消/超期了，
                //   即使模型已经返回，也按 cancelled 交上去（调用方据此丢弃）。
                if (callOpts.signal?.aborted) {
                    console.warn(`[取消] ${this.agent?.name ?? 'agent'} 的模型请求在返回前已被取消，结果按 cancelled 丢弃`);
                    await this._saveLog(prompt, messages, String(typed.content ?? ''), 'conversation-cancelled');
                    const cancelled = new ModelResult({
                        status: STATUS.CANCELLED, errorCode: ERROR_CODE.CANCELLED,
                        errorMessage: '操作在请求期间被取消（迟到结果）',
                        elapsedMs: typed.elapsedMs, attempts: typed.attempts,
                    });
                    cancelled.operationId = callOpts.operationId;
                    return this._convoResult(cancelled);
                }
                if (typed.failed) {
                    console.warn(`[llm] ${this.agent.name} 本轮模型调用失败(${typed.errorCode})，按无响应处理（不写 history、不发玩家）: ${typed.errorMessage}`);
                    await this._saveLog(prompt, messages, typed.toString(), 'conversation-failed');
                    return this._convoResult(typed);
                }
                console.log("Generated response:", typed.content);
                await this._saveLog(prompt, messages, typed.content, typed.truncated ? 'conversation-truncated' : 'conversation');
            } catch (error) {
                console.error('Error during message generation or file writing:', error);
                continue;
            }

            // Check for hallucination or invalid output
            if (typed.content.includes('(FROM OTHER BOT)')) {
                console.warn('LLM hallucinated message as another bot. Trying again...');
                continue;
            }

            if (current_msg_time !== this.most_recent_msg_time) {
                console.warn(`${this.agent.name} received new message while generating, discarding old response.`);
                return this._convoResult(new ModelResult({
                    status: STATUS.CANCELLED, errorCode: ERROR_CODE.CANCELLED, errorMessage: '生成期间收到新消息',
                    elapsedMs: typed.elapsedMs, attempts: typed.attempts,
                }));
            }

            // 思考块：只保留标记之后的正文（与旧实现同语义）。标记**拆成两段拼接**，
            // 避免编辑器/传输层把它当作标签处理（本文件里其它地方也踩过这个坑）。
            const thinkClose = '</thi' + 'nk>';
            if (typed.content.includes(thinkClose)) {
                const [, afterThink] = typed.content.split(thinkClose);
                typed.content = afterThink;
            }

            // ★ 第3B条：截断标记是**内部诊断信号**、不是对话内容 —— 现在它在 status 里，
            //   content 天然不含标记，不再需要"剥标记"这种补救（缺口 B 的根治）。
            if (typed.truncated) {
                console.warn(`[llm] ${this.agent.name} 本轮回答被输出额度截断：status=truncated（正文可读、可能不完整）`);
            }

            return this._convoResult(typed);
        }

        // 三次都不合格 ⇒ 明确的失败（旧实现返回 ''，把"重试耗尽"伪装成"没话说"）
        return this._convoResult(new ModelResult({
            status: STATUS.ERROR, errorCode: ERROR_CODE.BAD_RESPONSE, errorMessage: '连续 3 次没有可用回答',
        }));
    }

    /**
     * 把"调用方给的 op"折算成**适配器要的东西**（★ t4 第 3 跳的唯一折算点）。
     *
     * 时间只有一套：`timeoutMs = min(LLM_MAX_CALL_MS, deadline - now)` ——
     * 模型请求的剩余时间永远 ≤ 动作的剩余时间（A5 §5.2 末）。
     * 这样"两套时钟"就合并了：动作还剩 8 秒时，模型调用只有 8 秒，不是 120 秒。
     *
     * @param {{signal?:AbortSignal|null, deadline?:number|null, operationId?:string|null}} opts
     * @returns {{signal:AbortSignal|null, timeoutMs:number, operationId:string|null}}
     */
    _callOptions(opts = {}) {
        const signal = opts?.signal ?? null;
        const operationId = opts?.operationId ?? null;
        const deadline = Number.isFinite(opts?.deadline) ? Number(opts.deadline) : null;
        let timeoutMs = LLM_MAX_CALL_MS;
        if (deadline) timeoutMs = Math.max(1000, Math.min(LLM_MAX_CALL_MS, deadline - Date.now()));
        return { signal, timeoutMs, operationId };
    }

    /**
     * 结果出口（唯一）：断言不变量 + 分布计数 + 观测字段。
     * 这也是 `last_convo_truncated` 死标志的**真实消费者**：值由 status 派生，
     * 并由 logTotals()（记忆落盘时调用）真正读出来打进日志。
     */
    _convoResult(result) {
        const r = coerceModelResult(result, 'promptConvo');
        this.last_convo_status = r.status;
        if (r.truncated) this.last_convo_truncated = true;
        if (r.failed) this.last_convo_error_code = r.errorCode ?? null;
        noteModelResult(r, 'convo');
        return r;
    }

    /**
     * ★ 真实消费者：把"结果分布 + 用量累计"打进日志 —— 成本/质量第一次可读。
     * 调用点：记忆落盘（promptMemSaving 成功后）。低频、天然的对账点。
     * 原来 `usageTotals()` 全仓 0 个生产调用点（A5 §6.2），成本结构上算不出来。
     */
    logTotals() {
        const line = `${formatModelTotals()} lastConvoStatus=${this.last_convo_status ?? '-'}`
            + ` lastConvoTruncated=${this.last_convo_truncated === true}`
            + ` lastConvoErrorCode=${this.last_convo_error_code ?? '-'}`;
        console.log(line);
        return line;
    }

    /**
     * 过渡兼容：把结果还原成"老形状的字符串"。
     * 关键：**正文不带内部标记**（ok/truncated 都返回 content），失败才变回 `[LLM_ERROR] …`。
     * 这样字符串派调用点在迁移期行为逐条不变，同时新代码可以只读 status。
     */
    _legacyString(result) {
        const r = result instanceof ModelResult ? result : toModelResult(result);
        return r.hasContent ? r.content : r.toString();
    }

    /** 旧契约（string）：见 promptCodingResult。 */
    async promptCoding(messages, opts = {}) {
        return this._legacyString(await this.promptCodingResult(messages, opts));
    }

    /**
     * 带类型的代码生成（A5 §3.3 步 1）。
     * 截断 ⇒ status=truncated 且 content 是**无代码信号**（noCodeReply）—— 半截代码绝不进执行路径（H2）。
     */
    async promptCodingResult(messages, opts = {}) {
        // ★ t4：代码生成同样接受可选 {signal, deadline, operationId}（!newAction 路径在动作里跑）。
        const callOpts = this._callOptions(opts);
        if (callOpts.signal?.aborted) {
            const cancelled = new ModelResult({
                status: STATUS.CANCELLED, errorCode: ERROR_CODE.CANCELLED,
                errorMessage: '操作在发请求前已被取消',
            });
            cancelled.operationId = callOpts.operationId;
            return this._codeResult(cancelled);
        }
        if (this.awaiting_coding) {
            console.warn('Already awaiting coding response, returning no response.');
            // ★ H2：所有「没代码」出口统一走不含反引号的 noCodeReply()（coder.js 只认这个信号）。
            return this._codeResult(new ModelResult({
                status: STATUS.OK, content: noCodeReply('already awaiting a coding response'),
            }));
        }
        this.awaiting_coding = true;
        const started = Date.now();
        try {
            await this.checkCooldown();
            let prompt = this.profile.coding;
            prompt = await this.replaceStrings(prompt, messages, this.coding_examples);

            const resp = await this.code_model.sendRequest(messages, prompt, undefined, callOpts);
            const typed = toModelResult(resp, { elapsedMs: Date.now() - started });
            await this._saveLog(prompt, messages, typed.hasContent ? typed.content : typed.toString(),
                typed.failed ? 'coding-failed' : (typed.truncated ? 'coding-truncated' : 'coding'));
            if (typed.truncated) {
                console.warn(`[llm] ${this.agent.name} 代码生成被输出额度截断：拒绝执行半截代码（原文已记日志）`);
                // H2：这里必须给**不含反引号**的无代码信号 —— coder.js 抽码前认它，
                // 另有一道 hasStatements() 判据；绝不会有任何东西被拿去执行。
                return this._codeResult(new ModelResult({
                    status: STATUS.TRUNCATED, content: noCodeReply('coding reply truncated by output limit'),
                    elapsedMs: typed.elapsedMs, attempts: typed.attempts,
                }));
            }
            return this._codeResult(typed);
        } finally {
            this.awaiting_coding = false;
        }
    }

    _codeResult(result) {
        const r = coerceModelResult(result, 'promptCoding');
        this.last_coding_status = r.status;
        noteModelResult(r, 'coding');
        return r;
    }

    /** 旧契约（string）。H4：失败/截断一律返回**旧记忆**（不覆盖 memory.json）。 */
    async promptMemSaving(to_summarize, opts = {}) {
        const r = await this.promptMemSavingResult(to_summarize, opts);
        if (!r.hasContent || r.truncated) return this.agent?.history?.memory ?? '';
        return r.content;
    }

    /**
     * 带类型的记忆摘要（A5 §3.3 步 1 + H4）。
     * 失败 → status=error；截断 → status=truncated（content 仍保留，但 history 的写盘段
     * 会因为 status 拒绝覆盖 memory.json —— 状态在字段里，不再靠"剥不剥标记"决定）。
     */
    async promptMemSavingResult(to_summarize, opts = {}) {
        // ★ t29（R5）：**接取消信号**。原来这里只有 2 个形参 ⇒ 模型层收不到 signal，
        //   玩家 `!stop` / 面板停止 / 动作超时都拦不住一次记忆摘要，只能等适配器自身 120s 上限。
        const callOpts = this._callOptions(opts);
        if (callOpts.signal?.aborted) {
            const cancelled = new ModelResult({
                status: STATUS.CANCELLED, errorCode: ERROR_CODE.CANCELLED,
                errorMessage: '操作在发请求前已被取消',
            });
            cancelled.operationId = callOpts.operationId;
            return this._memResult(cancelled);
        }
        // ★ H4：本轮摘要是否被截断（history.js 的写盘段读这个标志做第二道保险）。
        this.last_memory_summary_truncated = false;
        await this.checkCooldown();
        const started = Date.now();
        let prompt = this.profile.saving_memory;
        prompt = await this.replaceStrings(prompt, null, null, to_summarize);
        // ★ t29：第 4 参把 {signal,timeoutMs,operationId} 交给适配器（与 promptConvo/Coding 同口径）
        const resp = await this.chat_model.sendRequest([], prompt, undefined, callOpts);
        const typed = toModelResult(resp, { elapsedMs: Date.now() - started });
        await this._saveLog(prompt, to_summarize, typed.hasContent ? typed.content : typed.toString(),
            typed.failed ? 'memSaving-failed' : (typed.truncated ? 'memSaving-truncated' : 'memSaving'));
        // ★ t29：生成期间被取消 ⇒ 这段内容不作数（否则"停下来了"却照样把摘要写进 memory）
        if (callOpts.signal?.aborted) {
            console.warn(`[llm] ${this.agent.name} 记忆摘要期间被取消 ⇒ 丢弃本次摘要`);
            return this._memResult(new ModelResult({
                status: STATUS.CANCELLED, errorCode: ERROR_CODE.CANCELLED,
                errorMessage: '记忆摘要期间被取消',
            }));
        }
        // 第31条：失败**绝不能**当成"新记忆摘要"存进去（会覆盖上一轮真实摘要）。
        if (typed.failed) {
            console.warn(`[llm] ${this.agent.name} 记忆摘要失败(${typed.errorCode})，保留原记忆不覆盖: ${typed.errorMessage}`);
            return this._memResult(typed);
        }
        const thinkClose = '</thi' + 'nk>';
        if (typed.content.includes(thinkClose)) typed.content = typed.content.split(thinkClose)[1];
        if (typed.truncated) {
            this.last_memory_summary_truncated = true;
            console.warn(`[llm] ${this.agent.name} 记忆摘要被输出额度截断：**保留旧摘要、不覆盖 memory.json**（原文已记日志）`);
            return this._memResult(typed);
        }
        // ★ 真实消费者：记忆落盘是低频、天然的对账点 ⇒ 把结果分布与用量累计打进日志（A5 §6.2）
        try { this.logTotals(); } catch { /* 日志失败不影响记忆 */ }
        return this._memResult(typed);
    }

    _memResult(result) {
        const r = coerceModelResult(result, 'promptMemSaving');
        this.last_mem_status = r.status;
        noteModelResult(r, 'memsaving');
        return r;
    }

    /** 旧契约（boolean）：见 promptShouldRespondToBotResult。 */
    async promptShouldRespondToBot(new_message, opts = {}) {
        const r = await this.promptShouldRespondToBotResult(new_message, opts);
        if (r.failed) return false;
        return r.content.trim().toLowerCase() === 'respond';
    }

    /** 带类型：只输出一个词的判断改成读 status + content（截断时 content 已是干净的词）。 */
    async promptShouldRespondToBotResult(new_message, opts = {}) {
        // ★ t29：接取消信号（原来 2 个形参 ⇒ "要不要回话"这一问也拦不住）
        const callOpts = this._callOptions(opts);
        if (callOpts.signal?.aborted) {
            const cancelled = new ModelResult({
                status: STATUS.CANCELLED, errorCode: ERROR_CODE.CANCELLED,
                errorMessage: '操作在发请求前已被取消',
            });
            cancelled.operationId = callOpts.operationId;
            return coerceModelResult(cancelled, 'promptShouldRespondToBot');
        }
        await this.checkCooldown();
        const started = Date.now();
        let prompt = this.profile.bot_responder;
        let messages = this.agent.history.getHistory();
        messages.push({ role: 'user', content: new_message });
        prompt = await this.replaceStrings(prompt, null, null, messages);
        const res = await this.chat_model.sendRequest([], prompt, undefined, callOpts);
        const typed = toModelResult(res, { elapsedMs: Date.now() - started });
        // 第31条：失败标记不是 "respond"（旧实现靠字符串比较，现在靠 status）
        if (typed.failed) {
            console.warn(`[llm] ${this.agent.name} bot_responder 调用失败，按「不接话」处理: ${typed.errorMessage}`);
        }
        // ★ t29：生成期间被取消 ⇒ 按"不接话"处理（cancelled 不是 ok，调用方不会因它去回话）
        if (callOpts.signal?.aborted) {
            const cancelled = coerceModelResult(new ModelResult({
                status: STATUS.CANCELLED, errorCode: ERROR_CODE.CANCELLED,
                errorMessage: '决定是否回话期间被取消',
            }), 'promptShouldRespondToBot');
            this.last_bot_responder_status = cancelled.status;
            noteModelResult(cancelled, 'botresponder');
            return cancelled;
        }
        const r = coerceModelResult(typed, 'promptShouldRespondToBot');
        this.last_bot_responder_status = r.status;
        noteModelResult(r, 'botresponder');
        return r;
    }

    /** 旧契约（string）：见 promptVisionResult。 */
    async promptVision(messages, imageBuffer, opts = {}) {
        return this._legacyString(await this.promptVisionResult(messages, imageBuffer, opts));
    }

    /** 带类型：视觉失败从此不再以 `[LLM_ERROR] …` 字符串进"图像分析"上下文（缺口 C 的根治入口）。 */
    async promptVisionResult(messages, imageBuffer, opts = {}) {
        // ★ t29：接取消信号（原来 3 个形参；调用适配器时也只给 3 个实参）
        const callOpts = this._callOptions(opts);
        if (callOpts.signal?.aborted) {
            const cancelled = new ModelResult({
                status: STATUS.CANCELLED, errorCode: ERROR_CODE.CANCELLED,
                errorMessage: '操作在发请求前已被取消',
            });
            cancelled.operationId = callOpts.operationId;
            return coerceModelResult(cancelled, 'promptVision');
        }
        await this.checkCooldown();
        const started = Date.now();
        let prompt = this.profile.image_analysis;
        prompt = await this.replaceStrings(prompt, messages, null, null, null);
        // ★ t29：第 4 参 opts 透传到适配器（11 个实现的签名同步加了 `opts = {}`）
        const raw = await this.vision_model.sendVisionRequest(messages, prompt, imageBuffer, callOpts);
        // ★ t29：生成期间被取消 ⇒ 这张图的描述不作数
        if (callOpts.signal?.aborted) {
            const cancelled = coerceModelResult(new ModelResult({
                status: STATUS.CANCELLED, errorCode: ERROR_CODE.CANCELLED,
                errorMessage: '看图期间被取消',
            }), 'promptVision');
            this.last_vision_status = cancelled.status;
            noteModelResult(cancelled, 'vision');
            return cancelled;
        }
        const r = coerceModelResult(toModelResult(raw, { elapsedMs: Date.now() - started }), 'promptVision');
        this.last_vision_status = r.status;
        noteModelResult(r, 'vision');
        return r;
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
