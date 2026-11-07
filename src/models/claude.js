import Anthropic from '@anthropic-ai/sdk';
import { strictFormat } from '../utils/text.js';
import { getKey } from '../utils/keys.js';

import { failedReply, recordUsage, safeErrText, errMessage, markTruncated } from './_shared.js';

export class Claude {
    static prefix = 'anthropic';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params || {};

        let config = {};
        if (url)
            config.baseURL = url;
        
        config.apiKey = getKey('ANTHROPIC_API_KEY');

        this.anthropic = new Anthropic(config);
    }

    async sendRequest(turns, systemMessage) {
        const messages = strictFormat(turns);
        let res = null;
        try {
            console.log(`Awaiting anthropic response from ${this.model_name}...`);
            if (!this.params.max_tokens) {
                if (this.params.thinking?.budget_tokens) {
                    this.params.max_tokens = this.params.thinking.budget_tokens + 1000;
                    // max_tokens must be greater than thinking.budget_tokens
                } else {
                    this.params.max_tokens = 4096;
                }
            }
            const resp = await this.anthropic.messages.create({
                model: this.model_name || "claude-sonnet-4-6",
                system: systemMessage,
                messages: messages,
                ...(this.params || {})
            });

            console.log('Received.');
            recordUsage(resp?.usage, this.model_name);
            // get first content of type text
            const textContent = resp.content.find(content => content.type === 'text');
            if (textContent) {
                res = textContent.text;
                // ★ MOD-001：`stop_reason === 'max_tokens'` 是**输出额度**用完，不是上下文超限。
                //   原来这里**完全不看 stop_reason** ⇒ 被切一半的回答会被当成"说完了"写进 history、
                //   甚至直接说给玩家（静默截断，上层无法区分"她讲完了"和"她被切断了"）。
                //   Claude 是当前项目实际在用的通路，优先级最高。
                //   现在：内容照常返回（半句话仍有用），但打 [LLM_TRUNCATED] 标记。
                if (resp.stop_reason === 'max_tokens') {
                    console.log('[llm] claude 输出被 max_tokens 截断（stop_reason=max_tokens）：返回已得内容并打标记');
                    res = markTruncated(res ?? '');
                }
            } else {
                console.warn('No text content found in the response.');
                res = failedReply('claude returned no text content');
            }
        }
        catch (err) {
            if (errMessage(err).includes("does not support image input")) {
                res = "Vision is only supported by certain models.";
            } else {
                res = failedReply(`claude request failed: ${err?.message ?? err}`);
            }
            console.log(safeErrText(err));
        }
        return res;
    }

    sendVisionRequest(turns, systemMessage, imageBuffer) {
        const imageMessages = [...turns];
        imageMessages.push({
            role: "user",
            content: [
                {
                    type: "text",
                    text: systemMessage
                },
                {
                    type: "image",
                    source: {
                        type: "base64",
                        media_type: "image/jpeg",
                        data: imageBuffer.toString('base64')
                    }
                }
            ]
        });

        return this.sendRequest(imageMessages, systemMessage);
    }

    embed(_text) {
        // 保持「返回被拒绝的 Promise」的语义（原来 async+throw 就是这个效果）：
        // examples.js:32 用 .then() 接，同步 throw 会逃出 map，那是行为变化。
        return Promise.reject(new Error('Embeddings are not supported by Claude.'));
    }
}
