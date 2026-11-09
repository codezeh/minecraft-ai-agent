import CerebrasSDK from '@cerebras/cerebras_cloud_sdk';
import { strictFormat } from '../utils/text.js';
import { getKey } from '../utils/keys.js';

import { failedReply, recordUsage, LLM_MAX_RETRIES, normalizeUsage, sdkCallOptions } from './_shared.js';
// ★ A) 结果类型化：截断由 finishReason 承载（原来这个适配器**完全没有**截断检测）
import { toModelResult } from './result.js';

/** H5：Cerebras 属于「60s」这一档（SDK 默认 60s），显式写死防漂移。 */
const CEREBRAS_CALL_TIMEOUT_MS = 60000;

export class Cerebras {
    static prefix = 'cerebras';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.url = url;
        this.params = params;

        // Initialize client with API key
        // ★ H3：SDK 默认 maxRetries=2 且超时也重试 ⇒ 60s 的期限实际可放大到 3 倍。
        //   显式写死：单次 60s、重试 ≤1。
        this.client = new CerebrasSDK({
            apiKey: getKey('CEREBRAS_API_KEY'),
            timeout: CEREBRAS_CALL_TIMEOUT_MS,
            maxRetries: LLM_MAX_RETRIES,
        });
    }

    async sendRequest(turns, systemMessage, stop_seq = '***', opts = {}) {
        // Format messages array
        const messages = strictFormat(turns);
        messages.unshift({ role: 'system', content: systemMessage });

        const pack = {
            model: this.model_name || 'gpt-oss-120b',
            messages,
            stream: false,
            ...(this.params || {}),
        };

        let res;
        let finishReason = null;
        let usageShape = null;
        const started = Date.now();
        try {
            const completion = await this.client.chat.completions.create(pack, sdkCallOptions(opts));
            recordUsage(completion?.usage, this.model_name);
            usageShape = normalizeUsage(completion?.usage);
            finishReason = completion?.choices?.[0]?.finish_reason ?? null;
            // OpenAI-compatible shape
            res = completion.choices?.[0]?.message?.content || '';
        } catch (err) {
            console.error('Cerebras API error:', err);
            res = failedReply(`cerebras request failed: ${err?.message ?? err}`);
        }
        return toModelResult(res, {
            finishReason, usage: usageShape, elapsedMs: Date.now() - started,
        });
    }

    sendVisionRequest(messages, systemMessage, imageBuffer, opts = {}) {
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
        
        return this.sendRequest(imageMessages, systemMessage, undefined, opts);
    }
    
    embed(_text) {
        // 保持「返回被拒绝的 Promise」的语义（原来 async+throw 就是这个效果）：
        // examples.js:32 用 .then() 接，同步 throw 会逃出 map，那是行为变化。
        return Promise.reject(new Error('Embeddings are not supported by Cerebras.'));
    }
}
