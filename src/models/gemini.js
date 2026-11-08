import { GoogleGenAI } from '@google/genai';
import { strictFormat } from '../utils/text.js';
import { getKey } from '../utils/keys.js';


import { failedReply, recordUsage, safeErrText, errMessage, markTruncated, LLM_MAX_CALL_MS } from './_shared.js';

export class Gemini {
    static prefix = 'google';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;
        this.safetySettings = [
            {
                "category": "HARM_CATEGORY_DANGEROUS",
                "threshold": "BLOCK_NONE",
            },
            {
                "category": "HARM_CATEGORY_HARASSMENT",
                "threshold": "BLOCK_NONE",
            },
            {
                "category": "HARM_CATEGORY_HATE_SPEECH",
                "threshold": "BLOCK_NONE",
            },
            {
                "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                "threshold": "BLOCK_NONE",
            },
            {
                "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
                "threshold": "BLOCK_NONE",
            },
        ];

        // ★★★ H5（第四轮复审）：`@google/genai` **只有在你传了 `httpOptions.timeout` 时才设超时**
        //   （`@google/genai/dist/node/index.cjs:13183-13189`：`if (httpOptions.timeout) setTimeout(...)`）
        //   ⇒ 原来这里既没传 timeout、也没传 abortSignal，等于**完全没有期限**：
        //   服务端不响应时 `await` 会一直挂着，`!stop`/动作超时都拦不住。
        //   现在：单次调用上限 120s（单位是毫秒，SDK 内部用 AbortController 实现，连读响应体一起管）。
        this.genAI = new GoogleGenAI({
            apiKey: getKey('GEMINI_API_KEY'),
            httpOptions: { timeout: LLM_MAX_CALL_MS },
        });
    }

    async sendRequest(turns, systemMessage, stop_seq, opts = {}) {
        console.log('Awaiting Google API response...');

        turns = strictFormat(turns);
        let contents = [];
        for (let turn of turns) {
            contents.push({
                role: turn.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: turn.content }]
            });
        }

        try {
            const result = await this.genAI.models.generateContent({
                model: this.model_name || "gemini-2.5-flash",
                contents: contents,
                safetySettings: this.safetySettings,
                config: {
                    systemInstruction: systemMessage,
                    ...(this.params || {}),
                    // t19：取消信号（GenAI 的 abortSignal 属于 GenerateContentConfig，不是顶层参数）
                    ...(opts?.signal ? { abortSignal: opts.signal } : {}),
                }
            });
            recordUsage(result?.usageMetadata, this.model_name);
            const response = await result.text;

            console.log('Received.');

            // ★ 2026-11-07 复审（第3A条）：Gemini 的输出截断信号是 **`finishReason: 'MAX_TOKENS'`**，
            //   原来这里只读 `result.text`，完全不看 finishReason ⇒ 被截断的回答被当成"说完了"，
            //   与 DeepSeek/GPT/Claude 的可识别行为不一致。
            //   注意：Gemini 的 `candidates[0].finishReason` 还可能是 SAFETY / RECITATION 等，
            //   那些不是"输出额度用完"，不在这里打截断标记（避免把安全拦截误标成截断）。
            const finishReason = result?.candidates?.[0]?.finishReason;
            if (finishReason === 'MAX_TOKENS') {
                console.log('[llm] gemini 输出被 max_tokens 截断（finishReason=MAX_TOKENS）：返回已得内容并打标记');
                return markTruncated(response ?? '');
            }

            return response;
        } catch (err) {
            // 第31条：这里原来是**裸的**（没有 try/catch）⇒ 模型层一失败就往上抛。
            // 但 prompter 的 promptCoding / promptMemSaving / promptShouldRespondToBot **都没有**
            // try/catch，抛出去就是真的崩（coder / history / conversation 三个调用方）。
            // 统一契约：sendRequest **永不抛**，失败一律返回 FAILED_REPLY 标记。
            console.log(safeErrText(err));
            return failedReply(`google request failed: ${err?.message ?? err}`);
        }
    }

    async sendVisionRequest(turns, systemMessage, imageBuffer) {
        const imagePart = {
            inlineData: {
                data: imageBuffer.toString('base64'),
                mimeType: 'image/jpeg'
            }
        };
       
        turns = strictFormat(turns);
        let contents = [];
        for (let turn of turns) {
            contents.push({
                role: turn.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: turn.content }]
            });
        }
        contents.push({
            role: 'user',
            parts: [{ text: 'SYSTEM: Vision response' }, imagePart]
        });

        let res = null;
        try {
            console.log('Awaiting Google API vision response...');
            const result = await this.genAI.models.generateContent({
                model: this.model_name,
                contents: contents,
                safetySettings: this.safetySettings,
                generationConfig: {
                    ...(this.params || {})
                },
                systemInstruction: systemMessage
            });
            recordUsage(result?.usageMetadata, this.model_name, 'vision');
            res = await result.text;
            console.log('Received.');
        } catch (err) {
            console.log(safeErrText(err, 'vision'));
            if (errMessage(err).includes("Image input modality is not enabled for models/")) {
                res = "Vision is only supported by certain models.";
            } else {
                res = failedReply(`google vision request failed: ${err?.message ?? err}`);
            }
        }
        return res;
    }

    /**
     * 取嵌入向量。
     *
     * ★★★ MOD-004（2026-11-06 深度检查）：SDK 返回的是**对象数组** `[{values:[...]}]`，
     *   而全仓消费者（`utils/examples.js` → `cosineSimilarity`）要的是 `number[]`。
     *   原来这里 `return result.embeddings;` 把对象原样交出去 ⇒ `a[i] * b[i]`
     *   得到 `undefined * undefined = NaN` ⇒ 余弦相似度 NaN ⇒ 示例/技能排序失效
     *   **而且不报错**（最难查的那类）。
     *
     *   现在在**适配器边界**就把形状收敛：取出单条 `values`，校验成非空有限数值数组。
     *   拿不到合法向量时返回 **null**（而不是抛）：`examples.js` 的 `getRelevant`
     *   没有 try/catch，抛出去会把她整轮对话打崩；调用方按既有语义降级到词重叠。
     *
     * @returns {Promise<number[]|null>}
     */
    async embed(text) {
        const result = await this.genAI.models.embedContent({
            model: this.model_name || "gemini-embedding-001",
            contents: text,
        });

        // 兼容两种形状：`{embeddings:[{values}]}` 与 `{embedding:{values}}`
        const first = result?.embeddings?.[0] ?? result?.embedding ?? null;
        const values = first?.values ?? (Array.isArray(first) ? first : null);
        if (!Array.isArray(values) || values.length === 0) {
            console.warn('[gemini] embed 没有返回可用的数值向量 → 返回 null（调用方降级为词重叠）');
            return null;
        }
        const vec = values.map((v) => Number(v));
        if (vec.some((v) => !Number.isFinite(v))) {
            console.warn('[gemini] embed 向量里含非有限值 → 返回 null（调用方降级为词重叠）');
            return null;
        }
        return vec;
    }
}

const sendAudioRequest = async (text, model, voice, url) => {
    const ai = new GoogleGenAI({
        apiKey: getKey('GEMINI_API_KEY'),
        // ★ H5：TTS 这个临时客户端同样不能没有期限（原来只有 apiKey）
        httpOptions: { timeout: LLM_MAX_CALL_MS },
    });

    const response = await ai.models.generateContent({
        model: model,
        contents: [{ parts: [{text: text}] }],
        config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: voice },
                },
            },
        },
    });

    const pcmBase64 = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!pcmBase64) {
        console.warn('Gemini TTS: no audio data returned');
        return null;
    }

    // Wrap PCM in a minimal WAV container so ffplay can decode it.
    const pcmBuffer = Buffer.from(pcmBase64, 'base64');
    const wavHeader = createWavHeader(pcmBuffer.length, 24000, 1, 16);
    const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);

    const wavBase64 = wavBuffer.toString('base64');
    return wavBase64;
};

// helper: create PCM WAV header
function createWavHeader(dataLength, sampleRate, channels, bitsPerSample) {
    const header = Buffer.alloc(44);
    const byteRate = sampleRate * channels * bitsPerSample / 8;
    const blockAlign = channels * bitsPerSample / 8;

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // PCM
    header.writeUInt16LE(1, 20); // Audio format = PCM
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataLength, 40);
    return header;
}

export const TTSConfig = {
    sendAudioRequest: sendAudioRequest,
};