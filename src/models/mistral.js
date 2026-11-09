import { Mistral as MistralClient } from '@mistralai/mistralai';
import { getKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

import { failedReply, recordUsage, safeErrText, errMessage, LLM_MAX_CALL_MS, normalizeUsage, sdkCallOptions } from './_shared.js';
// ★ A) 结果类型化：Mistral 的 finishReason（'length'/'model_length'）由 result.js 收敛
import { toModelResult } from './result.js';

export class Mistral {
    static prefix = 'mistral';
    #client;

    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;

        if (typeof url === "string") {
            console.warn("Mistral does not support custom URL's, ignoring!");

        }

        if (!getKey("MISTRAL_API_KEY")) {
            throw new Error("Mistral API Key missing, make sure to set MISTRAL_API_KEY in settings.json");
        }

        // ★★★ H5（第四轮复审）：Mistral 的期限原来**完全没有确证**（审计标注"未见默认值"），
        //   而它的 SDK（speakeasy 生成）自带 retry 循环。这里显式给定：
        //   · timeoutMs = 120s（与其它适配器同档）；
        //   · retryConfig strategy='none' ⇒ 重试 0 次（满足「重试 ≤1」，且避免
        //     "超时也重试"把 120s 放大成几分钟 —— speakeasy 的重试默认对连接错误也生效）。
        this.#client = new MistralClient(
            {
                apiKey: getKey("MISTRAL_API_KEY"),
                timeoutMs: LLM_MAX_CALL_MS,
                retryConfig: { strategy: "none" },
            }
        );

        
        // Prevents the following code from running when model not specified
        if (typeof this.model_name === "undefined") return;

        // get the model name without the "mistral" or "mistralai" prefix
        // e.g "mistral/mistral-large-latest" -> "mistral-large-latest"
        if (typeof model_name.split("/")[1] !== "undefined") {
            this.model_name = model_name.split("/")[1];
        }
    }

    async sendRequest(turns, systemMessage, stop_seq, opts = {}) {

        let result;
        let finishReason = null;
        let usageShape = null;
        const started = Date.now();

        try {
            const model = this.model_name || "mistral-large-latest";

            const messages = [
                { role: "system", content: systemMessage }
            ];
            messages.push(...strictFormat(turns));

            console.log('Awaiting mistral api response...');
            const response  = await this.#client.chat.complete({
                model,
                messages,
                ...(this.params || {})
            }, sdkCallOptions(opts));

            recordUsage(response?.usage, model);
            usageShape = normalizeUsage(response?.usage);
            finishReason = response?.choices?.[0]?.finishReason ?? null;
            result = response.choices[0].message.content;
        } catch (err) {
            if (errMessage(err).includes("A request containing images has been given to a model which does not have the 'vision' capability.")) {
                result = "Vision is only supported by certain models.";
            } else {
                result = failedReply(`mistral request failed: ${err?.message ?? err}`);
            }
            console.log(safeErrText(err));
        }

        return toModelResult(result, {
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
                    imageUrl: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`
                }
            ]
        });
        
        return this.sendRequest(imageMessages, systemMessage, undefined, opts);
    }

    async embed(text) {
        const embedding = await this.#client.embeddings.create({
            model: "mistral-embed",
            inputs: text
        });
        return embedding.data[0].embedding;
    }
}