import OpenAIApi from 'openai';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

import { failedReply, recordUsage, safeErrText, errMessage, isContextLengthError, markTruncated, LLM_MAX_CALL_MS, LLM_MAX_RETRIES, sdkCallOptions } from './_shared.js';

export class Mercury {
    static prefix = 'mercury';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;
        let config = {};
        if (url)
            config.baseURL = url;
        else
            config.baseURL = "https://api.inceptionlabs.ai/v1";

        config.apiKey = getKey('MERCURY_API_KEY');

        // ★ H3：显式压住 openai SDK 默认值（600s × 3 次 ⇒ 最坏 30 分钟）
        config.timeout = LLM_MAX_CALL_MS;
        config.maxRetries = LLM_MAX_RETRIES;

        this.openai = new OpenAIApi(config);
    }

    async sendRequest(turns, systemMessage, stop_seq='***', opts = {}) {
        if (typeof stop_seq === 'string') {
            stop_seq = [stop_seq];
        } else if (!Array.isArray(stop_seq)) {
            stop_seq = [];
        }
        let messages = [{'role': 'system', 'content': systemMessage}].concat(turns);
        messages = strictFormat(messages);
        const pack = {
            model: this.model_name || "mercury-coder-small",
            messages,
            stop: stop_seq,
            ...(this.params || {})
        };


        let res = null;
        let truncatedByLength = false;   // 输出额度截断 ≠ 上下文超限（MOD-001）

        try {
            console.log('Awaiting mercury api response from model', this.model_name);
            let completion = await this.openai.chat.completions.create(pack, sdkCallOptions(opts));
            recordUsage(completion?.usage, this.model_name);
            // ★ MOD-001：finish_reason==='length' 是**输出额度**用完，不是上下文超限。
            //   原来这里直接 throw 'Context length exceeded' → catch 里裁历史重发：缩短输入对
            //   "输出写不下"毫无作用，还会白删有用上下文，并且每试一次多花一次钱
            //   （T9 实测：turns=4 时一次调用被放大成 4 次请求）。
            //   现在：内容照常返回（她写了一半的话仍然有用），只打 [LLM_TRUNCATED] 标记。
            const finish = completion?.choices?.[0]?.finish_reason;
            if (finish === 'length') {
                console.log('[llm] mercury 输出被 max_tokens 截断（finish_reason=length）：不裁历史、不重试；返回已得内容并打标记');
                truncatedByLength = true;
            }
            console.log('Received.');
            res = completion.choices[0].message.content;
        }
        catch (err) {
            if (isContextLengthError(err) && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq, opts);
            } else if (errMessage(err).includes('image_url')) {
                console.log(safeErrText(err));
                res = 'Vision is only supported by certain models.';
            } else {
                console.log(safeErrText(err));
                res = failedReply(`mercury request failed: ${err?.message ?? err}`);
            }
        }
        if (truncatedByLength) res = markTruncated(res ?? '');

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

    async embed(text) {
        if (text.length > 8191)
            text = text.slice(0, 8191);
        const embedding = await this.openai.embeddings.create({
            model: this.model_name || "text-embedding-3-small",
            input: text,
            encoding_format: "float",
        });
        return embedding.data[0].embedding;
    }

}



