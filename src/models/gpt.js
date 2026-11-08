import OpenAIApi from 'openai';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

import { failedReply, recordUsage, safeErrText, errMessage, isContextLengthError, markTruncated, LLM_MAX_CALL_MS, LLM_MAX_RETRIES, sdkCallOptions } from './_shared.js';

/**
 * ★ MOD-002/003：给消息追加停止标记 —— **只加在字符串内容上，且返回新对象**。
 *
 * 缺陷原貌：`message.content += stop_seq` 直接改原对象：
 *   · 内容是多模态数组时（视觉请求），数组被强制转成字符串 →
 *     报告实测 `[object Object],[object Object]******`，图片 data URL 消失；
 *   · 同一个 messages 数组被重试/复用时就重复追加（A → A*** → A******）。
 *
 * @param {Array<object>} messages
 * @param {string} stopSeq
 * @returns {Array<object>} 新数组 + 新消息对象（输入不被修改）
 */
function appendStopToTextOnly(messages, stopSeq) {
    if (!Array.isArray(messages)) return messages;
    return messages.map((m) => {
        if (!m || typeof m !== 'object') return m;
        if (typeof m.content === 'string') return { ...m, content: m.content + stopSeq };
        // 数组内容（文本片段/图片）：一个字节都不动
        return { ...m };
    });
}

export class GPT {
    static prefix = 'openai';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;
        this.url = url; // store so that we know whether a custom URL has been set

        let config = {};
        if (url)
            config.baseURL = url;

        if (hasKey('OPENAI_ORG_ID'))
            config.organization = getKey('OPENAI_ORG_ID');

        config.apiKey = getKey('OPENAI_API_KEY');

        // ★★★ H3（第四轮复审，S1「单次模型调用最坏 30 分钟不可取消」）：
        //   openai SDK 默认 `timeout=600000` + `maxRetries=2`，且**超时也重试**
        //   （core.js:325-330 把 AbortError 折成 APIConnectionTimeoutError 后照样重试）
        //   ⇒ 一次调用最坏 3×600s。这期间 `!stop` / 面板停止 / 动作 10 分钟超时全都拦不住。
        //   这里显式写死：单次 ≤120s、重试 ≤1（最坏 2×120s=4 分钟，仍远优于 30 分钟）。
        config.timeout = LLM_MAX_CALL_MS;
        config.maxRetries = LLM_MAX_RETRIES;

        this.openai = new OpenAIApi(config);
    }

    async sendRequest(turns, systemMessage, stop_seq='***', opts = {}) {
        let res = null;

        try {
            console.log('Awaiting openai api response from model', this.model_name || "gpt-5.4-mini");
            const model = this.model_name || "gpt-5.4-mini";
            // if a custom URL is set, use chat.completions
            // because custom "OpenAI-compatible" endpoints likely do not have responses endpoint
            if (this.url) {
                let messages = [{'role': 'system', 'content': systemMessage}].concat(turns);
                messages = strictFormat(messages);
                // ★ MOD-002/003：停止标记**只追加到字符串内容**上，并且**产生新对象** ——
                //   原来 `message.content += stop_seq` 直接改对象：对多模态数组会把
                //   `[{type:'input_image',...}]` 拼成 "[object Object]"（MOD-003 图片直接丢），
                //   也让同一批对象被反复追加（MOD-002 的"重试重复拼接"另一处来源）。
                messages = appendStopToTextOnly(messages, stop_seq);
                const pack = {
                    model: model,
                    messages,
                    stop: stop_seq,
                    ...(this.params || {})
                };
                if (model.includes('o1') || model.includes('o3') || model.includes('5')) {
                    delete pack.stop;
                }
                let completion = await this.openai.chat.completions.create(pack, sdkCallOptions(opts));
                recordUsage(completion?.usage, model);
                // ★ MOD-001：`finish_reason==='length'` 是**输出额度**用完，不是上下文超限。
                //   原来直接 throw 'Context length exceeded' → 裁历史重试（无效且多花钱）。
                const finish = completion?.choices?.[0]?.finish_reason;
                console.log('Received.');
                res = completion.choices[0].message.content;
                if (finish === 'length') {
                    console.log('[llm] openai(chat) 输出被 max_tokens 截断：不裁历史、不重试，返回已得内容并打标记');
                    res = markTruncated(res ?? '');
                }
            } 
            // otherwise, use responses
            else {
                let messages = strictFormat(turns);
                messages = appendStopToTextOnly(messages, stop_seq);
                const response = await this.openai.responses.create({
                    model: model,
                    instructions: systemMessage,
                    input: messages,
                    ...(this.params || {})
                }, sdkCallOptions(opts));   // t19：responses 那条支路同样要接取消/期限
                console.log('Received.');
                recordUsage(response?.usage, model);
                res = response.output_text;
                let stop_seq_index = res.indexOf(stop_seq);
                res = stop_seq_index !== -1 ? res.slice(0, stop_seq_index) : res;
                // ★ MOD-001：Responses 接口把截断表达成 status/ incomplete_details
                const incomplete = response?.status === 'incomplete'
                    || response?.incomplete_details?.reason === 'max_output_tokens';
                if (incomplete) {
                    console.log('[llm] openai(responses) 输出被 max_output_tokens 截断：返回已得内容并打标记');
                    res = markTruncated(res ?? '');
                }
            }
        }
        catch (err) {
            // ★ MOD-001：只有真正的上下文超限才裁历史
            if (isContextLengthError(err) && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq, opts);
            } else if (errMessage(err).includes('image_url')) {
                console.log(safeErrText(err));
                res = 'Vision is only supported by certain models.';
            } else {
                console.log(safeErrText(err));
                res = failedReply(`openai request failed: ${errMessage(err) || err}`);
            }
        }
        return res;
    }

    sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = [...messages];
        imageMessages.push({
            role: "user",
            content: [
                { type: "input_text", text: systemMessage },
                {
                    type: "input_image",
                    image_url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`
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

const sendAudioRequest = async (text, model, voice, url) => {
    const payload = {
        model: model,
        voice: voice,
        input: text
    };

    let config = {};

    if (url)
        config.baseURL = url;

    if (hasKey('OPENAI_ORG_ID'))
        config.organization = getKey('OPENAI_ORG_ID');

    config.apiKey = getKey('OPENAI_API_KEY');

    // ★ H3：同一个 SDK 默认值问题（600s × 3 次）也存在于 TTS 用的这个临时客户端
    config.timeout = LLM_MAX_CALL_MS;
    config.maxRetries = LLM_MAX_RETRIES;

    const openai = new OpenAIApi(config);

    const mp3 = await openai.audio.speech.create(payload);
    const buffer = Buffer.from(await mp3.arrayBuffer());
    const base64 = buffer.toString("base64");
    return base64;
};

export const TTSConfig = {
    sendAudioRequest: sendAudioRequest,
    baseUrl: 'https://api.openai.com/v1',
};
