import OpenAIApi from 'openai';
import { getKey } from '../utils/keys.js';

import { failedReply, recordUsage } from './_shared.js';

// xAI doesn't supply a SDK for their models, but fully supports OpenAI and Anthropic SDKs
export class Grok {
    static prefix = 'xai';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.url = url;
        this.params = params;

        let config = {};
        if (url)
            config.baseURL = url;
        else
            config.baseURL = "https://api.x.ai/v1";

        config.apiKey = getKey('XAI_API_KEY');

        this.openai = new OpenAIApi(config);
    }

    async sendRequest(turns, systemMessage) {
        let messages = [{'role': 'system', 'content': systemMessage}].concat(turns);

        const pack = {
            model: this.model_name || "grok-4.1-fast-non-reasoning",
            messages,
            ...(this.params || {})
        };

        let res = null;
        try {
            console.log('Awaiting xai api response...');
            ///console.log('Messages:', messages);
            let completion = await this.openai.chat.completions.create(pack);
            recordUsage(completion?.usage, this.model_name);
            if (completion.choices[0].finish_reason == 'length')
                throw new Error('Context length exceeded'); 
            console.log('Received.');
            res = completion.choices[0].message.content;
        }
        catch (err) {
            if ((err.message == 'Context length exceeded' || err.code == 'context_length_exceeded') && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage);
            } else if (err.message.includes('The model expects a single `text` element per message.')) {
                console.log(err);
                res = 'Vision is only supported by certain models.';
            } else {
                console.log(err);
                res = failedReply(`xai request failed: ${err?.message ?? err}`);
            }
        }
        // sometimes outputs special token <|separator|>, just replace it
        return res.replace(/<\|separator\|>/g, '*no response*');
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
    
    embed(_text) {
        // 保持「返回被拒绝的 Promise」的语义（原来 async+throw 就是这个效果）：
        // examples.js:32 用 .then() 接，同步 throw 会逃出 map，那是行为变化。
        return Promise.reject(new Error('Embeddings are not supported by Grok.'));
    }
}



