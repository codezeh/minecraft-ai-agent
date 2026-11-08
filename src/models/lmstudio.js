import OpenAIApi from 'openai';
import { strictFormat } from '../utils/text.js';

import { failedReply, recordUsage, safeErrText, errMessage, isContextLengthError, markTruncated, LLM_MAX_CALL_MS, LLM_MAX_RETRIES, sdkCallOptions } from './_shared.js';

export class LMStudio {
    static prefix = 'lmstudio';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;
        this.openai = new OpenAIApi({
            baseURL: url || 'http://localhost:1234/v1',
            apiKey: 'lm-studio', // LM Studio ignores this but the client requires a non-empty value
            // ★ H3：本地模型也受同一条约束 —— SDK 默认 600s×3 会让"停止"彻底失效
            timeout: LLM_MAX_CALL_MS,
            maxRetries: LLM_MAX_RETRIES,
        });
    }

    async sendRequest(turns, systemMessage, stop_seq='***', opts = {}) {
        let messages = [{ role: 'system', content: systemMessage }].concat(strictFormat(turns));
        let model = this.model_name || 'andy-4.1';
        let res = null;
        let truncatedByLength = false;   // 输出额度截断 ≠ 上下文超限（MOD-001）

        try {
            console.log('Awaiting LM Studio response from model', model);
            const pack = {
                model,
                messages,
                stop: stop_seq,
                ...(this.params || {})
            };
            const completion = await this.openai.chat.completions.create(pack, sdkCallOptions(opts));
            recordUsage(completion?.usage, model);
            // ★ MOD-001：finish_reason==='length' 是**输出额度**用完，不是上下文超限。
            //   原来直接 throw 'Context length exceeded' → catch 裁历史重发（无效且多花钱；
            //   T9 实测 turns=4 时被放大成 4 次请求）。现在：内容照常返回，只打 [LLM_TRUNCATED]。
            const finish = completion?.choices?.[0]?.finish_reason;
            if (finish === 'length') {
                console.log('[llm] lmstudio 输出被 max_tokens 截断（finish_reason=length）：不裁历史、不重试；返回已得内容并打标记');
                truncatedByLength = true;
            }
            console.log('Received.');
            res = completion.choices[0].message.content;
            if (res.includes('</think>')) {
                if (!res.includes('<think>')) res = '<think>' + res;
                res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            }
        } catch (err) {
            if (isContextLengthError(err) && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq, opts);
            } else {
                console.log(safeErrText(err));
                res = failedReply(`lmstudio request failed: ${err?.message ?? err}`);
            }
        }
        // ★ MOD-001：thinking 标签后处理之后再打标记，保证标记在末尾

        if (truncatedByLength) res = markTruncated(res ?? '');

        return res;
    }

    sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = [...messages];
        imageMessages.push({
            role: 'user',
            content: [
                { type: 'text', text: systemMessage },
                {
                    type: 'image_url',
                    image_url: { url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}` }
                }
            ]
        });
        return this.sendRequest(imageMessages, systemMessage);
    }

    async embed(text) {
        if (text.length > 8191)
            text = text.slice(0, 8191);
        const embedding = await this.openai.embeddings.create({
            model: this.model_name || 'text-embedding-nomic-embed-text-v1.5',
            input: text,
            encoding_format: 'float',
        });
        return embedding.data[0].embedding;
    }
}
