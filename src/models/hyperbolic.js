import { getKey } from '../utils/keys.js';

import { failedReply, recordUsage, isRateLimit, rateLimitDelayMs, errMessage, isContextLengthError, markTruncated, fetchWithDeadline } from './_shared.js';

export class Hyperbolic {
    static prefix = 'hyperbolic';
    constructor(modelName, apiUrl) {
        this.modelName = modelName || "deepseek-ai/DeepSeek-V3";
        this.apiUrl = apiUrl || "https://api.hyperbolic.xyz/v1/chat/completions";

        // ★ MOD-006：一次模型请求的应用级总期限（未设置则用 _shared 的默认值）
        this.timeoutMs = undefined;

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
                // ★ MOD-006：带总期限 + 取消信号的 fetch（原来裸 fetch 会一直挂住）
                // ★ 2026-11-07 复审（第2条）：status 检查与 `response.json()` 都放进 `parse`，
                //   这样**读响应体也在总期限里** —— 否则发完头不发 body 时总期限形同虚设。
                const data = await fetchWithDeadline(this.apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.apiKey}`
                    },
                    body: JSON.stringify(payload)
                }, {
                    timeoutMs: this.timeoutMs,
                    onAbort: (why) => console.warn(`[hyperbolic] 请求被终止：${why}`),
                    parse: async (response) => {
                        if (!response.ok) {
                            // 429 要重试而不是把失败当回答（第31条 第3点：三个裸 fetch 适配器都缺这条）
                            if (response.status === 429) {
                                throw Object.assign(new Error('HTTP 429 rate limited'), { status: 429 });
                            }
                            throw new Error(`HTTP error! status: ${response.status}`);
                        }
                        return await response.json();
                    },
                });
                recordUsage(data?.usage, this.modelName);
                // ★ MOD-001：`finish_reason === 'length'` 是**输出额度**用完，不是上下文超限。
                //   原来这里 throw 'Context length exceeded' → 裁历史重试（无效且多花钱）。
                if (data?.choices?.[0]?.finish_reason === 'length') {
                    completionContent = markTruncated(data?.choices?.[0]?.message?.content || '');
                    console.log('[llm] hyperbolic 输出被 max_tokens 截断：返回已得内容并打标记');
                    console.log('Received response from Hyperbolic.');
                    return completionContent;
                }

                completionContent = data?.choices?.[0]?.message?.content || '';
                console.log('Received response from Hyperbolic.');
            } catch (err) {
                if (isContextLengthError(err) && turns.length > 1) {
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
