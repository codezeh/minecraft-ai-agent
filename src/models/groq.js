import Groq from 'groq-sdk';
import { getKey } from '../utils/keys.js';

import { failedReply, recordUsage, safeErrText, errMessage, LLM_MAX_RETRIES, normalizeUsage, sdkCallOptions } from './_shared.js';
// ★ A) 结果类型化：返回 ModelResult，截断由 finishReason 承载（原来这个适配器**完全没有**截断检测）
import { toModelResult } from './result.js';

/** H5：Groq 属于「60s」这一档（SDK 默认就是 60s），这里显式写死，避免将来 SDK 改默认值时静默漂移。 */
const GROQ_CALL_TIMEOUT_MS = 60000;

// THIS API IS NOT TO BE CONFUSED WITH GROK!
// Go to grok.js for that. :)

// Umbrella class for everything under the sun... That GroqCloud provides, that is.
export class GroqCloudAPI {
    static prefix = 'groq';

    constructor(model_name, url, params) {

        this.model_name = model_name;
        this.url = url;
        this.params = params || {};

        // Remove any mention of "tools" from params:
        if (this.params.tools)
            delete this.params.tools;
        // This is just a bit of future-proofing in case we drag Mindcraft in that direction.

        // I'm going to do a sneaky ReplicateAPI theft for a lot of this, aren't I?
        if (this.url)
            console.warn("Groq Cloud has no implementation for custom URLs. Ignoring provided URL.");

        // ★ H3：SDK 默认 maxRetries=2 且超时也重试 ⇒ 60s 的期限实际可放大到 3 倍。
        //   显式写死：单次 60s、重试 ≤1。
        this.groq = new Groq({
            apiKey: getKey('GROQCLOUD_API_KEY'),
            timeout: GROQ_CALL_TIMEOUT_MS,
            maxRetries: LLM_MAX_RETRIES,
        });


    }

    async sendRequest(turns, systemMessage, stop_seq = null, opts = {}) {
        // Construct messages array
        let messages = [{"role": "system", "content": systemMessage}].concat(turns);

        let res = null;
        // ★ A) 观测字段：截断/用量都由结构化字段承载，不再往字符串拼标记
        let finishReason = null;
        let usageShape = null;
        const started = Date.now();

        try {
            console.log("Awaiting Groq response...");

            // Handle deprecated max_tokens parameter
            if (this.params.max_tokens) {
                console.warn("GROQCLOUD WARNING: A profile is using `max_tokens`. This is deprecated. Please move to `max_completion_tokens`.");
                this.params.max_completion_tokens = this.params.max_tokens;
                delete this.params.max_tokens;
            }

            if (!this.params.max_completion_tokens) {
                this.params.max_completion_tokens = 4000;
            }

            let completion = await this.groq.chat.completions.create({
                "messages": messages,
                "model": this.model_name || "qwen/qwen3-32b",
                "stream": false,
                "stop": stop_seq,
                ...(this.params || {})
            }, sdkCallOptions(opts));

            recordUsage(completion?.usage, this.model_name);
            usageShape = normalizeUsage(completion?.usage);
            // `finish_reason === 'length'` = 输出额度用完 —— 信息一直在手里，原来被扔了
            finishReason = completion?.choices?.[0]?.finish_reason ?? null;
            res = completion.choices[0].message.content;

            res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        }
        catch(err) {
            if (errMessage(err).includes("content must be a string")) {
                res = "Vision is only supported by certain models.";
            } else {
                res = failedReply(`groq request failed: ${err?.message ?? err}`);
            }
            console.log(safeErrText(err));
        }
        return toModelResult(res, {
            finishReason, usage: usageShape, elapsedMs: Date.now() - started,
        });
    }

    sendVisionRequest(messages, systemMessage, imageBuffer, opts = {}) {
        const imageMessages = messages.filter(message => message.role !== 'system');
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
        
        return this.sendRequest(imageMessages, undefined, undefined, opts);
    }

    embed(_text) {
        // 保持「返回被拒绝的 Promise」的语义（原来 async+throw 就是这个效果）：
        // examples.js:32 用 .then() 接，同步 throw 会逃出 map，那是行为变化。
        return Promise.reject(new Error('Embeddings are not supported by Groq.'));
    }
}
