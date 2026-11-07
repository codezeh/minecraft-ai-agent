import OpenAIApi from 'openai';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

import { failedReply, recordUsage, safeErrText, errMessage, isContextLengthError, markTruncated } from './_shared.js';

export class Qwen {
    static prefix = 'qwen';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;
        let config = {};

        config.baseURL = url || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
        config.apiKey = getKey('QWEN_API_KEY');

        this.openai = new OpenAIApi(config);
    }

    async sendRequest(turns, systemMessage, stop_seq='***') {
        let messages = [{'role': 'system', 'content': systemMessage}].concat(turns);

        messages = strictFormat(messages);

        const pack = {
            model: this.model_name || "qwen-plus",
            messages,
            stop: stop_seq,
            ...(this.params || {})
        };

        let res = null;
        let truncatedByLength = false;   // 输出额度截断 ≠ 上下文超限（MOD-001）
        try {
            console.log('Awaiting Qwen api response...');
            let completion = await this.openai.chat.completions.create(pack);
            recordUsage(completion?.usage, this.model_name);
            // ★ MOD-001：finish_reason==='length' 是**输出额度**用完，不是上下文超限。
            //   原来这里直接 throw 'Context length exceeded' → catch 里裁历史重发：缩短输入对
            //   "输出写不下"毫无作用，还会白删有用上下文，并且每试一次多花一次钱
            //   （T9 实测：turns=4 时一次调用被放大成 4 次请求）。
            //   现在：内容照常返回（她写了一半的话仍然有用），只打 [LLM_TRUNCATED] 标记。
            const finish = completion?.choices?.[0]?.finish_reason;
            if (finish === 'length') {
                console.log('[llm] qwen 输出被 max_tokens 截断（finish_reason=length）：不裁历史、不重试；返回已得内容并打标记');
                truncatedByLength = true;
            }
            console.log('Received.');
            res = completion.choices[0].message.content;
        }
        catch (err) {
            if (isContextLengthError(err) && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
            } else {
                console.log(safeErrText(err));
                res = failedReply(`qwen request failed: ${err?.message ?? err}`);
            }
        }
        if (truncatedByLength) res = markTruncated(res ?? '');

        return res;
    }

    // Why random backoff?
    // With a 30 requests/second limit on Alibaba Qwen's embedding service,
    // random backoff helps maximize bandwidth utilization.
    async embed(text) {
        const maxRetries = 5; // Maximum number of retries
        for (let retries = 0; retries < maxRetries; retries++) {
            try {
                const { data } = await this.openai.embeddings.create({
                    model: this.model_name || "text-embedding-v3",
                    input: text,
                    encoding_format: "float",
                });
                return data[0].embedding;
            } catch (err) {
                if (err.status === 429) {
                    // If a rate limit error occurs, calculate the exponential backoff with a random delay (1-5 seconds)
                    const delay = Math.pow(2, retries) * 1000 + Math.floor(Math.random() * 2000);
                    // console.log(`Rate limit hit, retrying in ${delay} ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay)); // Wait for the delay before retrying
                } else {
                    throw err;
                }
            }
        }
        // If maximum retries are reached and the request still fails, throw an error
        throw new Error('Max retries reached, request failed.');
    }

}