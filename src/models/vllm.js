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
import { failedReply, recordUsage } from './_shared.js';

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

        this.vllm = new OpenAIApi(vllm_config);
    }

    async sendRequest(turns, systemMessage, stop_seq = '***') {
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
        try {
            console.log('Awaiting openai api response...');
            // console.log('Messages:', messages);
            // todo set max_tokens, temperature, top_p, etc. in pack
            let completion = await this.vllm.chat.completions.create(pack);
            recordUsage(completion?.usage, model);
            if (completion.choices[0].finish_reason == 'length')
                throw new Error('Context length exceeded');
            console.log('Received.');
            res = completion.choices[0].message.content;
        }
        catch (err) {
            if ((err.message == 'Context length exceeded' || err.code == 'context_length_exceeded') && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
            } else {
                console.log(err);
                res = failedReply(`vllm request failed: ${err?.message ?? err}`);
            }
        }
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