import { toSinglePrompt } from '../utils/text.js';
import { getKey } from '../utils/keys.js';
import { HfInference } from "@huggingface/inference";

import { failedReply, recordUsage, safeErrText } from './_shared.js';

export class HuggingFace {
  static prefix = 'huggingface';
  constructor(model_name, url, params) {
    // Remove 'huggingface/' prefix if present
    this.model_name = model_name.replace('huggingface/', '');
    this.url = url;
    this.params = params;

    if (this.url) {
      console.warn("Hugging Face doesn't support custom urls!");
    }

    this.huggingface = new HfInference(getKey('HUGGINGFACE_API_KEY'));
  }

  async sendRequest(turns, systemMessage) {
    const stop_seq = '***';
    // Build a single prompt from the conversation turns
    const prompt = toSinglePrompt(turns, null, stop_seq);
    // Fallback model if none was provided
    const model_name = this.model_name || 'meta-llama/Llama-3.3-70B-Instruct';
    // Combine system message with the prompt
    const input = systemMessage + "\n" + prompt;

    // We'll try up to 5 times in case of partial <think> blocks for DeepSeek-R1 models.
    const maxAttempts = 5;
    let attempt = 0;
    let finalRes = null;

    while (attempt < maxAttempts) {
      attempt++;
      console.log(`Awaiting Hugging Face API response... (model: ${model_name}, attempt: ${attempt})`);
      let res = '';
      try {
        // Consume the streaming response chunk by chunk
        for await (const chunk of this.huggingface.chatCompletionStream({
          model: model_name,
          messages: [{ role: "user", content: input }],
          ...(this.params || {})
        })) {
          res += (chunk.choices[0]?.delta?.content || "");
        }
      } catch (err) {
        console.log(safeErrText(err));
        res = failedReply(`huggingface request failed: ${err?.message ?? err}`);
        // Break out immediately; we only retry when handling partial <think> tags.
        break;
      }

      // If the model is DeepSeek-R1, check for mismatched <think> blocks.
        const hasOpenTag = res.includes("<think>");
        const hasCloseTag = res.includes("</think>");

        // If there's a partial mismatch, warn and retry the entire request.
        if ((hasOpenTag && !hasCloseTag)) {
          console.warn("Partial <think> block detected. Re-generating...");
          continue;
        }

        // If both tags are present, remove the <think> block entirely.
        if (hasOpenTag && hasCloseTag) {
          res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        }

      // 第31条：HuggingFace 的流式接口不回 usage ⇒ 明确记成 missing（tag=stream），
      // 别假装是 0 —— 成本核算里「不知道」和「零消耗」必须分开。
      recordUsage(null, model_name, 'stream');
      finalRes = res;
      break; // Exit loop if we got a valid response.
    }

    // If no valid response was obtained after max attempts, assign a fallback.
    if (finalRes == null) {
      console.warn("Could not get a valid <think> block or normal response after max attempts.");
      finalRes = failedReply('huggingface gave no usable response after max attempts');
    }
    console.log('Received.');
    console.log(finalRes);
    return finalRes;
  }

  embed(_text) {
    // 保持「返回被拒绝的 Promise」的语义（原来 async+throw 就是这个效果）：
    // examples.js:32 用 .then() 接，同步 throw 会逃出 map，那是行为变化。
    return Promise.reject(new Error('Embeddings are not supported by HuggingFace.'));
  }
}
