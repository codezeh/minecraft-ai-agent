import OpenAIApi from 'openai';
import { getKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

import { failedReply, recordUsage, safeErrText, errMessage, isContextLengthError, markTruncated } from './_shared.js';

// llama, mistral
export class Novita {
	static prefix = 'novita';
	constructor(model_name, url, params) {
    this.model_name = model_name;
    this.url = url || 'https://api.novita.ai/v3/openai';
    this.params = params;


    let config = {
      baseURL: this.url
    };
    config.apiKey = getKey('NOVITA_API_KEY');

    this.openai = new OpenAIApi(config);
  }

	async sendRequest(turns, systemMessage, stop_seq='***') {
      let messages = [{'role': 'system', 'content': systemMessage}].concat(turns);

      
      messages = strictFormat(messages);
      
      const pack = {
          model: this.model_name || "meta-llama/llama-4-scout-17b-16e-instruct",
          messages,
          stop: [stop_seq],
          ...(this.params || {})
      };

      let res = null;
      let truncatedByLength = false;   // 输出额度截断 ≠ 上下文超限（MOD-001）
      try {
          console.log('Awaiting novita api response...');
          let completion = await this.openai.chat.completions.create(pack);
          recordUsage(completion?.usage, this.model_name);
          // ★ MOD-001：finish_reason==='length' 是**输出额度**用完，不是上下文超限。
          //   原来这里直接 throw 'Context length exceeded' → catch 里裁历史重发：缩短输入对
          //   "输出写不下"毫无作用，还会白删有用上下文，并且每试一次多花一次钱
          //   （T9 实测：turns=4 时一次调用被放大成 4 次请求）。
          //   现在：内容照常返回（她写了一半的话仍然有用），只打 [LLM_TRUNCATED] 标记。
          const finish = completion?.choices?.[0]?.finish_reason;
          if (finish === 'length') {
              console.log('[llm] novita 输出被 max_tokens 截断（finish_reason=length）：不裁历史、不重试；返回已得内容并打标记');
              truncatedByLength = true;
          }
          console.log('Received.');
          res = completion.choices[0].message.content;
      }
      catch (err) {
          if (isContextLengthError(err) && turns.length > 1) {
              console.log('Context length exceeded, trying again with shorter context.');
              // 第30条：缺 this. → 截断重试分支必抛 ReferenceError（对照 deepseek.js:44 的 this.sendRequest）
              return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
          } else {
            console.log(safeErrText(err));
              res = failedReply(`novita request failed: ${err?.message ?? err}`);
          }
      }
      if (res.includes('<think>')) {
        let start = res.indexOf('<think>');
        let end = res.indexOf('</think>') + 8;
        if (start != -1) {
          if (end != -1) {
            res = res.substring(0, start) + res.substring(end);
          } else {
            res = res.substring(0, start+7);
          }
        }
        res = res.trim();
      }
      // ★ MOD-001：后处理（思考标签/裁剪）之后再打标记，保证标记在末尾

      if (truncatedByLength) res = markTruncated(res ?? '');

      return res;
  }

	embed(_text) {
		// 保持「返回被拒绝的 Promise」的语义（原来 async+throw 就是这个效果）：
		// examples.js:32 用 .then() 接，同步 throw 会逃出 map，那是行为变化。
		return Promise.reject(new Error('Embeddings are not supported by Novita AI.'));
	}
}
