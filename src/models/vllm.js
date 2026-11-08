// This code uses Dashscope and HTTP to ensure the latest support for the Qwen model.
// Qwen is also compatible with the OpenAI API format;

import OpenAIApi from 'openai';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';
// 第31条 第6点：`saveToFile()` 用了 path / fs / __dirname 却没 import ——
// npx eslint 的 no-undef 实测点名（vllm.js:67/69/72/74/75）。T90 的硬指标是
// `eslint src main.js` 的 no-undef = 0，所以这里补齐（不补就会卡住终局验证）。
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { failedReply, recordUsage, safeErrText, errMessage, isContextLengthError, markTruncated, LLM_MAX_CALL_MS, LLM_MAX_RETRIES, sdkCallOptions } from './_shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class VLLM {
    static prefix = 'vllm';
    constructor(model_name, url) {
        this.model_name = model_name;

        // Currently use self-hosted SGLang API for text generation; use OpenAI text-embedding-3-small model for simple embedding.
        let vllm_config = {};
        if (url)
            vllm_config.baseURL = url;
        else
            vllm_config.baseURL = 'http://0.0.0.0:8000/v1';

        vllm_config.apiKey = "";

        // ★ H3：显式压住 openai SDK 默认值（600s × 3 次 ⇒ 最坏 30 分钟）
        vllm_config.timeout = LLM_MAX_CALL_MS;
        vllm_config.maxRetries = LLM_MAX_RETRIES;

        this.vllm = new OpenAIApi(vllm_config);
    }

    async sendRequest(turns, systemMessage, stop_seq = '***', opts = {}) {
        let messages = [{ 'role': 'system', 'content': systemMessage }].concat(turns);
        let model = this.model_name || "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B";  
        
        if (model.includes('deepseek') || model.includes('qwen')) {
            messages = strictFormat(messages);
        } 

        const pack = {
            model: model,
            messages,
            stop: stop_seq,
        };

        let res = null;
        let truncatedByLength = false;   // 输出额度截断 ≠ 上下文超限（MOD-001）
        try {
            console.log('Awaiting openai api response...');
            // todo set max_tokens, temperature, top_p, etc. in pack
            let completion = await this.vllm.chat.completions.create(pack, sdkCallOptions(opts));
            recordUsage(completion?.usage, model);
            // ★ MOD-001：finish_reason==='length' 是**输出额度**用完，不是上下文超限。
            //   原来这里直接 throw 'Context length exceeded' → catch 里裁历史重发：缩短输入对
            //   "输出写不下"毫无作用，还会白删有用上下文，并且每试一次多花一次钱
            //   （T9 实测：turns=4 时一次调用被放大成 4 次请求）。
            //   现在：内容照常返回（她写了一半的话仍然有用），只打 [LLM_TRUNCATED] 标记。
            const finish = completion?.choices?.[0]?.finish_reason;
            if (finish === 'length') {
                console.log('[llm] vllm 输出被 max_tokens 截断（finish_reason=length）：不裁历史、不重试；返回已得内容并打标记');
                truncatedByLength = true;
            }
            console.log('Received.');
            res = completion.choices[0].message.content;
        }
        catch (err) {
            if (isContextLengthError(err) && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq, opts);
            } else {
                console.log(safeErrText(err));
                res = failedReply(`vllm request failed: ${err?.message ?? err}`);
            }
        }
        if (truncatedByLength) res = markTruncated(res ?? '');

        return res;
    }

    /**
     * ⚠️ 第31条 第6点顺带发现：这个方法**没有任何调用点**（prompter 用的是自己的 `_saveToFile`），
     * 是一份没用的复制品。它上面原本还引用了没导入的 path / fs / __dirname（已补齐，为了 no-undef=0），
     * 另外 `this.task_id` 从来没被赋过值（上一行的局部变量才叫 task_id）⇒ 永远走 else 分支、
     * 且 task_id 为 null 时路径会变成 `.../logs/null`。这里只把判断改成本地变量（与本文件上一行一致的语义），
     * **整个方法该删还是该接出去，留给下一批决定**（删之前先确认没人 plan 用它）。
     */
    async saveToFile(logFile, logEntry) {
        let task_id = this.agent.task.task_id;
        console.log(task_id);
        let logDir;
        if (task_id === null) {
            logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs`);
        } else {
            logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs/${task_id}`);
        }

        await fs.mkdir(logDir, { recursive: true });

        logFile = path.join(logDir, logFile);
        await fs.appendFile(logFile, String(logEntry), 'utf-8');
    }

}