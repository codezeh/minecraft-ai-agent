import { toSinglePrompt } from '../utils/text.js';
import { getKey } from '../utils/keys.js';
import { HfInference } from "@huggingface/inference";

import { failedReply, recordUsage, safeErrText, callDeadlineSignal, LLM_MAX_CALL_MS, combineSignals } from './_shared.js';
// ★ A) 结果类型化：SSE 的最后一个 chunk 带 finish_reason（'length' = 输出额度用完），
//   原来整条流被读完就丢掉了 —— 于是这个适配器**完全没有**截断检测。
import { toModelResult } from './result.js';

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

  async sendRequest(turns, systemMessage, _stop_seq, opts = {}) {
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
    let finishReason = null;
    const started = Date.now();

    while (attempt < maxAttempts) {
      attempt++;
      console.log(`Awaiting Hugging Face API response... (model: ${model_name}, attempt: ${attempt})`);
      let res = '';
      // ★★★ H5（第四轮复审）：HfInference **没有任何 timeout 选项**（审计矩阵里属"无期限"那 3 个之一）。
      //   它的每次调用都是 `fn(args, {...defaultOptions, ...options})`，而底层
      //   `makeRequestOptions` 才把 `options.signal` 交给 fetch（dist/index.js:883 / :182）。
      //   所以：signal 必须放**第二参**（放 args 里会被 JSON 序列化进请求体），
      //   每次尝试一个显式总期限（覆盖含流式读体），并在 finally 里一定清掉定时器。
      // ★ R6 #38：**遵守调用方给的期限**。原来这里写死 LLM_MAX_CALL_MS（120s），
      //   而其余 17 个适配器都按 prompter._callOptions 算出的 opts.timeoutMs 收口 ——
      //   动作只剩 5 秒时，这个适配器仍能占满 120 秒（玩家按停后长时间无响应）。
      //   口径与 fetchWithDeadline 一致：给了正数就用它，否则回落到单次上限。
      const dlMs = Number(opts?.timeoutMs) > 0 ? Number(opts.timeoutMs) : LLM_MAX_CALL_MS;
      const dl = callDeadlineSignal(dlMs,
        () => console.warn(`[huggingface] 单次调用超过 ${dlMs}ms 期限，已中断`));
      try {
        // Consume the streaming response chunk by chunk
        for await (const chunk of this.huggingface.chatCompletionStream({
          model: model_name,
          messages: [{ role: "user", content: input }],
          ...(this.params || {})
        }, { signal: combineSignals(opts?.signal, dl.signal) })) {
          res += (chunk.choices[0]?.delta?.content || "");
          // 标准 OpenAI 兼容 SSE：最后一个 chunk 才带 finish_reason
          const fr = chunk.choices?.[0]?.finish_reason;
          if (fr) finishReason = fr;
        }
      } catch (err) {
        console.log(safeErrText(err));
        res = failedReply(`huggingface request failed: ${err?.message ?? err}`);
        // Break out immediately; we only retry when handling partial <think> tags.
        break;
      } finally {
        // H5：无论成功/失败/超时都清掉期限定时器（不留挂起的 timer）
        dl.cancel();
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
    return toModelResult(finalRes, { finishReason, elapsedMs: Date.now() - started, attempts: attempt });
  }

  embed(_text) {
    // 保持「返回被拒绝的 Promise」的语义（原来 async+throw 就是这个效果）：
    // examples.js:32 用 .then() 接，同步 throw 会逃出 map，那是行为变化。
    return Promise.reject(new Error('Embeddings are not supported by HuggingFace.'));
  }
}
