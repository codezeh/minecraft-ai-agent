import { strictFormat } from '../utils/text.js';

import { failedReply, recordUsage, isRateLimit, rateLimitDelayMs, safeErrText, errMessage, fetchWithDeadline } from './_shared.js';

export class Ollama {
    static prefix = 'ollama';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;
        this.url = url || 'http://127.0.0.1:11434';
        this.chat_endpoint = '/api/chat';
        this.embedding_endpoint = '/api/embeddings';
        // ★ MOD-006：一次模型请求的应用级总期限（可被 params.timeoutMs 覆盖）。
        //   注意这里是"整个请求"的期限，不是 TCP 层超时 —— 响应体卡住也能被打断。
        this.timeoutMs = Number(params?.timeoutMs) > 0 ? Number(params.timeoutMs) : undefined;
    }

    async sendRequest(turns, systemMessage) {
        let model = this.model_name || 'sweaterdog/andy-4:micro-q8_0';
        let messages = strictFormat(turns);
        messages.unshift({ role: 'system', content: systemMessage });
        const maxAttempts = 5;
        let attempt = 0;
        let finalRes = null;

        while (attempt < maxAttempts) {
            attempt++;
            console.log(`Awaiting local response... (model: ${model}, attempt: ${attempt})`);
            let res = null;
            try {
                let apiResponse = await this.send(this.chat_endpoint, {
                    model: model,
                    messages: messages,
                    stream: false,
                    ...(this.params || {})
                });
                // Ollama 把用量放在 prompt_eval_count / eval_count（_shared.recordUsage 认得）
                recordUsage(apiResponse, model);
                if (apiResponse?.['message']?.content !== undefined) {
                    res = apiResponse['message']['content'];
                } else {
                    res = failedReply('ollama returned no message content');
                }
            } catch (err) {
                if (errMessage(err).toLowerCase().includes('context length') && turns.length > 1) {
                    console.log('Context length exceeded, trying again with shorter context.');
                    return await this.sendRequest(turns.slice(1), systemMessage);
                } else if (isRateLimit(err) && attempt < maxAttempts) {
                    const wait = rateLimitDelayMs(attempt);
                    console.warn(`Ollama 被限流（429），${wait}ms 后重试（第 ${attempt}/${maxAttempts} 次）`);
                    await new Promise((r) => setTimeout(r, wait));
                    continue;
                } else {
                    console.log(safeErrText(err));
                    res = failedReply(`ollama request failed: ${err?.message ?? err}`);
                }
            }

            const hasOpenTag = res.includes("<think>");
            const hasCloseTag = res.includes("</think>");

            if ((hasOpenTag && !hasCloseTag)) {
                console.warn("Partial <think> block detected. Re-generating...");
                if (attempt < maxAttempts) continue;
            }
            if (hasCloseTag && !hasOpenTag) {
                res = '<think>' + res;
            }
            if (hasOpenTag && hasCloseTag) {
                res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            }
            finalRes = res;
            break;
        }

        if (finalRes == null) {
            console.warn("Could not get a valid response after max attempts.");
            finalRes = failedReply('ollama gave no usable response after max attempts');
        }
        return finalRes;
    }

    async embed(text) {
        let model = this.model_name || 'embeddinggemma';
        let body = { model: model, input: text };
        let res = await this.send(this.embedding_endpoint, body);
        return res['embedding'];
    }

    async send(endpoint, body) {
        const url = new URL(endpoint, this.url);
        let method = 'POST';
        let headers = new Headers();
        const request = new Request(url, { method, headers, body: JSON.stringify(body) });
        let data = null;
        try {
            // ★ MOD-006：走带**总期限 + 取消信号**的 fetch（原来裸 fetch 会一直挂住）
            const res = await fetchWithDeadline(request, {}, {
                timeoutMs: this.timeoutMs,
                onAbort: (why) => console.warn(`[ollama] 请求被终止：${why}`),
            });
            if (res.ok) {
                data = await res.json();
            } else {
                throw new Error(`Ollama Status: ${res.status}`);
            }
        } catch (err) {
            // 第31条 第3点：**不许吞成 null**。吞掉之后上层只看到"没有数据"，永远不知道发生过网络错误，
            // 也永远不会重试。这里原样抛出，让 sendRequest 的 catch 去判 429 / 记失败标记。
            console.error('Failed to send Ollama request.');
            // ★ F-SEC-102：错误对象上可能挂着 request/headers，只打安全的标量形状
            console.error(safeErrText(err, 'ollama'));
            throw err;
        }
        return data;
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
}
