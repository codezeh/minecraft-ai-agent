import Replicate from 'replicate';
import { toSinglePrompt } from '../utils/text.js';
import { getKey } from '../utils/keys.js';

import { failedReply, recordUsage, isRateLimit, rateLimitDelayMs, safeErrText, callDeadlineSignal, LLM_MAX_CALL_MS, combineSignals } from './_shared.js';
// ★ A) 结果类型化。**老实说明**：Replicate 的 run()/stream() **不提供 finish_reason**
//   （见 replicate/index.d.ts 的返回类型），所以这里 finishReason 只能是 null，
//   也就是「无法检测输出截断」——不假装检测得到，也不另编一个字符串标记。
import { toModelResult } from './result.js';

// llama, mistral, gemini
export class ReplicateAPI {
	static prefix = 'replicate';
	constructor(model_name, url, params) {
		this.model_name = model_name;
		this.url = url;
		this.params = params;

		if (this.url) {
			console.warn('Replicate API does not support custom URLs. Ignoring provided URL.');
		}

		this.replicate = new Replicate({
			auth: getKey('REPLICATE_API_KEY'),
		});
	}

	async sendRequest(turns, systemMessage, _stop_seq, opts = {}) {
		const stop_seq = '***';
		const prompt = toSinglePrompt(turns, null, stop_seq);
		let model_name = this.model_name || 'meta/meta-llama-3-70b-instruct';

		// Detect model type to use correct input format
		const isGemini = model_name.includes('gemini');

		let input;
		if (isGemini) {
			// Gemini models on Replicate ignore system_prompt field
			// Combine system message into the main prompt instead
			const fullPrompt = systemMessage + '\n\n' + prompt;
			input = { 
				prompt: fullPrompt,
				...(this.params || {})
			};
		} else {
			// Llama and other models use system_prompt
			input = { 
				prompt, 
				system_prompt: systemMessage,
				...(this.params || {})
			};
		}

		let res = null;
		const started = Date.now();		const maxAttempts = 4;
		for (let attempt = 1; ; attempt++) {
		// ★★★ H5（第四轮复审）：`replicate` SDK **没有 timeout 选项**（审计矩阵里属"无期限"那 3 个之一），
		//   但 `run()/stream()` 都接受 `options.signal`（replicate/index.d.ts:126-149）。
		//   这里每次尝试一个显式总期限（覆盖流式读体），finally 里一定清掉定时器。
		// ★ R6 #38：**遵守调用方给的期限**（原来写死 LLM_MAX_CALL_MS = 120s，
		//   与其余适配器"模型请求 ≤ 动作剩余时间"的约定不一致）。
		const dlMs = Number(opts?.timeoutMs) > 0 ? Number(opts.timeoutMs) : LLM_MAX_CALL_MS;
		const dl = callDeadlineSignal(dlMs,
			() => console.warn(`[replicate] 单次调用超过 ${dlMs}ms 期限，已中断`));
		try {
			console.log('Awaiting Replicate API response...');

			if (isGemini) {
				// Gemini doesn't stream well on Replicate, use run() instead
				const output = await this.replicate.run(model_name, { input, signal: combineSignals(opts?.signal, dl.signal) });
				// Output might be a string or an array
				if (Array.isArray(output)) {
					res = output.join('');
				} else if (typeof output === 'string') {
					res = output;
				} else {
					res = String(output);
				}
			} else {
				// Use streaming for other models
				let result = '';
				for await (const event of this.replicate.stream(model_name, { input, signal: combineSignals(opts?.signal, dl.signal) })) {
					result += event;
					if (result === '') break;
					if (result.includes(stop_seq)) {
						result = result.slice(0, result.indexOf(stop_seq));
						break;
					}
				}
				res = result;
			}

			// Trim stop sequence if present
			if (res && res.includes(stop_seq)) {
				res = res.slice(0, res.indexOf(stop_seq));
			}
		} catch (err) {
			// Replicate 没有 OpenAI 那种 SDK 默认重试：429 必须自己退避重试，
			// 否则限流会被当成「模型说了句话」返回（第31条 第3点）
			if (isRateLimit(err) && attempt < maxAttempts) {
				const wait = rateLimitDelayMs(attempt);
				console.warn(`Replicate 被限流（429），${wait}ms 后重试（第 ${attempt}/${maxAttempts} 次）`);
				await new Promise((r) => setTimeout(r, wait));
				continue;
			}
			console.log(safeErrText(err));
			res = failedReply(`replicate request failed: ${err?.message ?? err}`);
		} finally {
			// H5：成功/失败/429 重试都要清掉期限定时器
			dl.cancel();
		}
			break;
		}
		// Replicate 的 run()/stream() 不带 usage 形状 → 明确记成 missing，别假装是 0
		recordUsage(null, model_name, 'replicate');
		console.log('Received.');
		return toModelResult(res, { finishReason: null, elapsedMs: Date.now() - started });
	}

	async embed(text) {
		// Always use a dedicated embedding model, not the chat model
		const DEFAULT_EMBEDDING_MODEL = "mark3labs/embeddings-gte-base:d619cff29338b9a37c3d06605042e1ff0594a8c3eff0175fd6967f5643fc4d47";

		// Validate text input
		if (!text || typeof text !== 'string') {
			throw new Error('Text is required for embedding');
		}

		// Check if model_name is an embedding model or a chat model
		// Chat models (like meta/meta-llama-3-70b-instruct) won't work for embeddings
		const isEmbeddingModel = this.model_name && (
			this.model_name.includes('embed') || 
			this.model_name.includes('gte') ||
			this.model_name.includes('e5-')
		);
		const embeddingModel = isEmbeddingModel ? this.model_name : DEFAULT_EMBEDDING_MODEL;

		// Helper to extract embedding from various output formats
		const extractEmbedding = (output) => {
			if (output.vectors) {
				return output.vectors;
			} else if (Array.isArray(output)) {
				return output;
			} else if (output.embedding) {
				return output.embedding;
			} else if (output.embeddings) {
				return Array.isArray(output.embeddings[0]) ? output.embeddings[0] : output.embeddings;
			}
			return null;
		};

		try {
			const output = await this.replicate.run(
				embeddingModel,
				{ input: { text } }
			);
			const embedding = extractEmbedding(output);
			if (embedding) {
				return embedding;
			}
			throw new Error('Unknown embedding output format');
		} catch (err) {
			console.error('Replicate embed error:', err.message || err);
			throw err;
		}
	}
}