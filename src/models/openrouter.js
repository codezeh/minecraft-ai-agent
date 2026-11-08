import OpenAIApi from 'openai';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

import { failedReply, recordUsage, markTruncated, LLM_MAX_CALL_MS, LLM_MAX_RETRIES, sdkCallOptions } from './_shared.js';

export class OpenRouter {
    static prefix = 'openrouter';
    constructor(model_name, url) {
        this.model_name = model_name;

        let config = {};
        config.baseURL = url || 'https://openrouter.ai/api/v1';

        const apiKey = getKey('OPENROUTER_API_KEY');
        if (!apiKey) {
            console.error('Error: OPENROUTER_API_KEY not found. Make sure it is set properly.');
        }

        // Pass the API key to OpenAI compatible Api
        config.apiKey = apiKey; 

        // ★ H3：显式压住 openai SDK 默认值（600s × (1+2 次重试) ⇒ 最坏 30 分钟）
        config.timeout = LLM_MAX_CALL_MS;
        config.maxRetries = LLM_MAX_RETRIES;

        this.openai = new OpenAIApi(config);
    }

    async sendRequest(turns, systemMessage, stop_seq='*', opts = {}) {
        let messages = [{ role: 'system', content: systemMessage }, ...turns];
        messages = strictFormat(messages);

        // Choose a valid model from openrouter.ai (for example, "openai/gpt-4o")
        const pack = {
            model: this.model_name,
            messages,
            stop: stop_seq
        };

        let res = null;
        try {
            console.log('Awaiting openrouter api response...');
            let completion = await this.openai.chat.completions.create(pack, sdkCallOptions(opts));
            recordUsage(completion?.usage, this.model_name);
            if (!completion?.choices?.[0]) {
                console.error('No completion or choices returned:', completion);
                return failedReply('openrouter returned no choices');
            }
            // ★ 2026-11-07 复审（第3A条）：`finish_reason==='length'` 是**输出额度**用完，
            //   不是上下文超限。原来这里 `throw 'Context length exceeded'` → catch 里
            //   `failedReply(...)`，等于把「写了一半的有效回答」直接丢成 `[LLM_ERROR]` ——
            //   同一件事在不同 provider 上被判成不同结果（DeepSeek/GPT/Claude 是截断可识别，
            //   OpenRouter 却是失败）。现在统一：内容照常返回 + 打截断标记。
            const finish = completion.choices[0].finish_reason;
            console.log('Received.');
            res = completion.choices[0].message.content;
            if (finish === 'length') {
                console.log('[llm] openrouter 输出被 max_tokens 截断（finish_reason=length）：返回已得内容并打标记');
                res = markTruncated(res ?? '');
            }
        } catch (err) {
            console.error('Error while awaiting response:', err);
            // If the error indicates a context-length problem, we can slice the turns array, etc.
            res = failedReply(`openrouter request failed: ${err?.message ?? err}`);
        }
        return res;
    }

    sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = [...messages];
        imageMessages.push({
            role: "user",
            content: [
                { type: "text", text: systemMessage },
                {
                    type: "image_url",
                    image_url: {
                        url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`
                    }
                }
            ]
        });
        
        return this.sendRequest(imageMessages, systemMessage);
    }

    embed(_text) {
        // 保持「返回被拒绝的 Promise」的语义（原来 async+throw 就是这个效果）：
        // examples.js:32 用 .then() 接，同步 throw 会逃出 map，那是行为变化。
        return Promise.reject(new Error('Embeddings are not supported by Openrouter.'));
    }
}