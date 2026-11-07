# T9 · 模型层截断处理修复 —— 9 适配器验证（2026-11-07）

> 成员 `web-probe` 在收尾时**被 400 INVALID_REQUEST 中断**（执行环境问题，非改动问题）。
> 改动与探针已落盘，本文结论由 **Lead 亲自重跑探针**得出。

## 1. 修的是什么

两类问题，本质同一个：「**输出被 `max_tokens` 截断**」被误当「**上下文超限**」。

| 适配器 | 修复前 | 后果 |
|---|---|---|
| `claude.js` | 完全不看 `stop_reason` | **静默截断**：半句回答当"说完了"写进 history / 说给玩家 |
| `qwen/vllm/grok/mercury/novita/lmstudio` | `finish_reason==='length'` → `throw 'Context length exceeded'` → catch 里 `turns.slice(1)` **递归重发** | 一次调用放大成 turns 次（turns=4 → **4 次请求**），费用翻倍且白删上下文 |
| `deepseek.js` / `gpt.js` | 已修（基线样板） | — |
| `hyperbolic.js` | 顺带补上 | — |

## 2. 改后口径

- `finish_reason === 'length'` / `stop_reason === 'max_tokens'` ⇒ **正常返回内容 + `markTruncated()` 标记**，不抛错、不重试；
- 只有真正的 `isContextLengthError(err)` / `err.code === 'context_length_exceeded'` 才裁历史重试。

## 3. Lead 重跑探针结果（`evidence-adapters-after.json`）

```
summary:
  truncationTargetsOk: [claude, qwen, vllm, grok, mercury, novita, lmstudio]   ← 7/7
  truncationTargetsBad: []                                                    ← 空
  regressionOk: [deepseek.js, gpt.js]                                         ← 无回归
  regressionBad: []
  reverseControlOk: 16 项（8 适配器 × code/msg 两种真超限形态）                 ← 全部仍重试
  reverseControlBad: []                                                       ← 空
```

**场景 A（输出截断）**：9 个适配器日志一致 —— `输出被 max_tokens 截断（finish_reason=length）：不裁历史、不重试`，各 **1 次请求**。

**场景 B（真上下文超限，反向对照）**：仍打印 `Context length exceeded, trying again with shorter context`
⇒ **没有修过头**，真超限的重试逻辑完好。

**`claude.js` 的反向对照**：`AS-BEFORE（1 次请求 + 失败回复）` —— claude 本来就没有裁历史逻辑，
保持原状是正确行为，不是漏修。

## 4. Lead 复核

| 项 | 结果 |
|---|---|
| `npm run gate` | **exit 0** |
| `node tools/unit_all.mjs` | **119/119** |
| 覆盖完整性 | 全仓库仍有 `finish_reason` 的 10 个适配器里，9 个已修 |

## 5. 同类但**未修**（性质不同，已记录）

| 文件 | 情况 | 为什么不修 |
|---|---|---|
| `openrouter.js:47` | 截断时 `throw 'Context length exceeded'` → `failedReply` | **无递归重发**，不放大费用；只是把截断当失败、丢掉已得内容。属另一类缺陷，需单独立项 |
| `ollama.js` | 重试条件是**错误消息**含 `context length`（非 `finish_reason`），且 ollama 用 `done_reason` | 本来就没这个缺陷 |
