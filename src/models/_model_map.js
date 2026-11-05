import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dynamically discover model classes in this directory.
// Each model class must export a static `prefix` string.
const apiMap = await (async () => {
    const map = {};
    const files = (await fs.readdir(__dirname))
        .filter(f => f.endsWith('.js') && f !== '_model_map.js' && f !== 'prompter.js');
    for (const file of files) {
        try {
            const moduleUrl = pathToFileURL(path.join(__dirname, file)).href;
            const mod = await import(moduleUrl);
            for (const exported of Object.values(mod)) {
                if (typeof exported === 'function' && Object.prototype.hasOwnProperty.call(exported, 'prefix')) {
                    const prefix = exported.prefix;
                    if (typeof prefix === 'string' && prefix.length > 0) {
                        map[prefix] = exported;
                    }
                }
            }
        } catch (e) {
            console.warn('Failed to load model module:', file, e?.message || e);
        }
    }
    return map;
})();

export function selectAPI(profile) {
    if (typeof profile === 'string' || profile instanceof String) {
        profile = {model: profile};
    }
    // S44：`profile.model` 可能是缺省/非字符串，而下面到处都是 `profile.model.includes(...)`
    // 和 `profile.model.replace(...)`。两种**合法**写法会直接崩：
    //   - `{"api":"deepseek"}`  ← 用该 api 的默认模型（合法，但原来在 `.replace` 上 TypeError）
    //   - profile 里干脆没写 model ← 原来在 `.includes` 上 TypeError
    // 统一归一成空串：空串让下面的 `startsWith`/`includes` 全部为假、`replace` 原样返回，
    // 最后 `model_name === "" ? null : …` 会把 model 设成 null ⇒ 走供应商默认模型。
    if (typeof profile.model !== 'string') {
        if (profile.model !== undefined && profile.model !== null) {
            console.warn('[model] profile.model 不是字符串，按"用默认模型"处理:', JSON.stringify(profile.model));
        } else {
            console.debug(`[model] profile ${JSON.stringify(profile.api ?? '(no api)')} 未指定 model → 用该 api 的默认模型`);
        }
        profile.model = '';
    }
    // backwards compatibility with local->ollama
    if (profile.api?.includes('local') || profile.model?.includes('local')) {
        profile.api = 'ollama';
        if (profile.model) {
            profile.model = profile.model.replace('local', 'ollama');
        }
    }
    if (!profile.api) {
        const api = Object.keys(apiMap).find(key => profile.model?.startsWith(key));
        if (api) {
            profile.api = api;
        }
        else {
            // check for some common models that do not require prefixes
            if (profile.model.includes('gpt') || profile.model.includes('o1')|| profile.model.includes('o3'))
                profile.api = 'openai';
            else if (profile.model.includes('claude'))
                profile.api = 'anthropic';
            else if (profile.model.includes('gemini'))
                profile.api = "google";
            else if (profile.model.includes('grok'))
                profile.api = 'xai';
            else if (profile.model.includes('mistral'))
                profile.api = 'mistral';
            else if (profile.model.includes('deepseek'))
                profile.api = 'deepseek';
            else if (profile.model.includes('qwen'))
                profile.api = 'qwen';
        }
        if (!profile.api) {
            throw new Error('Unknown model:', profile.model);
        }
    }
    if (!apiMap[profile.api]) {
        throw new Error('Unknown api:', profile.api);
    }
    let model_name = profile.model.replace(profile.api + '/', ''); // remove prefix
    profile.model = model_name === "" ? null : model_name; // if model is empty, set to null
    return profile;
}

export function createModel(profile) {
    if (apiMap[profile.model]) {
        // if the model value is an api (instead of a specific model name)
        // then set model to null so it uses the default model for that api
        profile.model = null;
    }
    if (!apiMap[profile.api]) {
        throw new Error('Unknown api:', profile.api);
    }
    const model = new apiMap[profile.api](profile.model, profile.url, profile.params);
    return model;
}