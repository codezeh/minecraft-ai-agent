import { getKey } from '../utils/keys.js';

import { failedReply, recordUsage, isRateLimit, rateLimitDelayMs, errMessage } from './_shared.js';

export class Hyperbolic {
    static prefix = 'hyperbolic';
    constructor(modelName, apiUrl) {
        this.modelName = modelName || "deepseek-ai/DeepSeek-V3";
        this.apiUrl = apiUrl || "https://api.hyperbolic.xyz/v1/chat/completions";

        // Retrieve the Hyperbolic API key from keys.js
        this.apiKey = getKey('HYPERBOLIC_API_KEY');
        if (!this.apiKey) {
            throw new Error('HYPERBOLIC_API_KEY not found. Check your keys.js file.');
        }
    }

    /**
     * Sends a chat completion request to the Hyperbolic endpoint.
     *
     * @param {Array} turns - An array of message objects, e.g. [{role: 'user', content: 'Hi'}].
     * @param {string} systemMessage - The system prompt or instruction.
     * @param {string} stopSeq - A stopping sequence, default '***'.
     * @returns {Promise<string>} - The model's reply.
     */
    async sendRequest(turns, systemMessage, stopSeq = '***') {
        // Prepare the messages with a system prompt at the beginning
        const messages = [{ role: 'system', content: systemMessage }, ...turns];

        // Build the request payload
        const payload = {
            model: this.modelName,
            messages: messages,
            max_tokens: 8192,
            temperature: 0.7,
            top_p: 0.9,
            stream: false
        };

        const maxAttempts = 5;
        let attempt = 0;
        let finalRes = null;

        while (attempt < maxAttempts) {
            attempt++;
            console.log(`Awaiting Hyperbolic API response... (attempt: ${attempt})`);
            // 终审 R1-a：这行原来没有注释（同目录 deepseek/grok/mercury/qwen/vllm 五处都已注释）。
            // 后果：选 hyperbolic 时每轮对话把完整 messages（含玩家私聊原文、memory、人设）
            // 无条件写进 stdout / logs/mindcraft-console.log。要看提示词请显式开 LOG_PROMPTS=1。
            if (process.env.LOG_PROMPTS === '1') console.log('Messages:', messages);

            let completionContent = null;

            try {
                const response = await fetch(this.apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.apiKey}`
                    },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    // 429 要重试而不是把失败当回答（第31条 第3点：三个裸 fetch 适配器都缺这条）
                    if (response.status === 429) {
                        throw Object.assign(new Error('HTTP 429 rate limited'), { status: 429 });
                    }
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                const data = await response.json();
                recordUsage(data?.usage, this.modelName);
                if (data?.choices?.[0]?.finish_reason === 'length') {
                    throw new Error('Context length exceeded');
                }

                completionContent = data?.choices?.[0]?.message?.content || '';
                console.log('Received response from Hyperbolic.');
            } catch (err) {
                if (
                    (errMessage(err) === 'Context length exceeded' || err?.code === 'context_length_exceeded') &&
                    turns.length > 1
                ) {
                    console.log('Context length exceeded, trying again with a shorter context...');
                    return await this.sendRequest(turns.slice(1), systemMessage, stopSeq);
                } else if (isRateLimit(err) && attempt < maxAttempts) {
                    const wait = rateLimitDelayMs(attempt);
                    console.warn(`Hyperbolic 被限流（429），${wait}ms 后重试（第 ${attempt}/${maxAttempts} 次）`);
                    await new Promise((r) => setTimeout(r, wait));
                    continue;
                } else {
                    console.error(err);
                    completionContent = failedReply(`hyperbolic request failed: ${err?.message ?? err}`);
                }
            }

            // Check for <think> blocks
            const hasOpenTag = completionContent.includes("<think>");
            const hasCloseTag = completionContent.includes("</think>");

            if ((hasOpenTag && !hasCloseTag)) {
                console.warn("Partial <think> block detected. Re-generating...");
                continue; // Retry the request
            }

            if (hasCloseTag && !hasOpenTag) {
                completionContent = '<think>' + completionContent;
            }

            if (hasOpenTag && hasCloseTag) {
                completionContent = completionContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            }

            finalRes = completionContent.replace(/<\|separator\|>/g, '*no response*');
            break; // Valid response obtained—exit loop
        }

        if (finalRes == null) {
            console.warn("Could not get a valid <think> block or normal response after max attempts.");
            finalRes = failedReply('hyperbolic gave no usable response after max attempts');
        }
        return finalRes;
    }

    embed(_text) {
        // 保持「返回被拒绝的 Promise」的语义（原来 async+throw 就是这个效果）：
        // examples.js:32 用 .then() 接，同步 throw 会逃出 map，那是行为变化。
        return Promise.reject(new Error('Embeddings are not supported by Hyperbolic.'));
    }
}
