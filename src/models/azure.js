import { AzureOpenAI } from "openai";
import { getKey, hasKey } from '../utils/keys.js';
import { GPT } from './gpt.js';
// H3：AzureOpenAI 与 OpenAIApi 共享同一套默认值（600s × 3 次重试），必须显式压住
import { LLM_MAX_CALL_MS, LLM_MAX_RETRIES } from './_shared.js';

export class AzureGPT extends GPT {
    static prefix = 'azure';
    constructor(model_name, url, params) {
        super(model_name, url);

        this.model_name = model_name;
        this.params = params || {};

        const config = {};

        if (url)
            config.endpoint = url;

        config.apiKey = hasKey('AZURE_OPENAI_API_KEY') ? getKey('AZURE_OPENAI_API_KEY') : getKey('OPENAI_API_KEY');

        config.deployment = model_name;

        // ★ H3：显式单次上限 + 重试上限（AzureOpenAI 继承 openai SDK 的 600s/2 默认值）
        config.timeout = LLM_MAX_CALL_MS;
        config.maxRetries = LLM_MAX_RETRIES;

        if (this.params.apiVersion) {
            config.apiVersion = this.params.apiVersion;
            delete this.params.apiVersion; // remove from params for later use in requests
        }
        else {
            throw new Error('apiVersion is required in params for azure!');
        }

        this.openai = new AzureOpenAI(config);
    }
}