import OpenAIApi from 'openai';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

import { failedReply, recordUsage, safeErrText, errMessage, isContextLengthError, markTruncated } from './_shared.js';

export class DeepSeek {
    static prefix = 'deepseek';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;

        let config = {};

        config.baseURL = url || 'https://api.deepseek.com';
        config.apiKey = getKey('DEEPSEEK_API_KEY');

        this.openai = new OpenAIApi(config);
    }

    async sendRequest(turns, systemMessage, stop_seq='***') {
        let messages = [{'role': 'system', 'content': systemMessage}].concat(turns);

        messages = strictFormat(messages);

        const pack = {
            model: this.model_name || "deepseek-chat",
            messages,
            stop: stop_seq,
            ...(this.params || {})
        };

        let res = null;
        try {
            console.log('Awaiting deepseek api response...');
            let completion = await this.openai.chat.completions.create(pack);
            recordUsage(completion?.usage, this.model_name);
            // ★★★ MOD-001：`finish_reason === 'length'` 是**输出额度用完**，不是上下文超限。
            //   原来这里直接 `throw 'Context length exceeded'` → catch 里裁历史重试 ⇒
            //   缩短输入对"输出写不下"毫无作用，还会白删有用上下文，并且每试一次多花一次钱
            //   （报告实测：6 条历史连续 6 次请求后仍然失败）。
            //   现在：内容照常返回（她写到一半的话仍然有用），但打上 `[LLM_TRUNCATED]` 标记，
            //   让上层知道"这不是完整回答"（要不要续写由上层按用途决定）。
            const finish = completion?.choices?.[0]?.finish_reason;
            console.log('Received.');
            res = completion.choices[0].message.content;
            if (finish === 'length') {
                console.log('[llm] deepseek 输出被 max_tokens 截断（finish_reason=length）：'
                    + '不裁历史、不重试；返回已得内容并打标记');
                res = markTruncated(res ?? '');
            }
        }
        catch (err) {
            // ★ MOD-001：只有**真正**的上下文超限才裁历史重试。
            if (isContextLengthError(err) && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
            } else {
                console.log(safeErrText(err));
                res = failedReply(`deepseek request failed: ${errMessage(err) || err}`);
            }
        }
        return res;
    }

    embed(_text) {
        // 保持「返回被拒绝的 Promise」的语义（原来 async+throw 就是这个效果）：
        // examples.js:32 用 .then() 接，同步 throw 会逃出 map，那是行为变化。
        return Promise.reject(new Error('Embeddings are not supported by Deepseek.'));
    }
}



