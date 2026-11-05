id: F-SEC-102
severity: medium
class: secret
file: mindcraft/src/models/gpt.js:84
evidence: |
  19 个模型适配器在 catch 分支里把**整个 error 对象**打进 stdout：
    $ grep -rn "console.log(err)" mindcraft/src/models/*.js | wc -l
    19
    mindcraft/src/models/gpt.js:84        console.log(err);
    mindcraft/src/models/claude.js:59     console.log(err);
    mindcraft/src/models/deepseek.js:49   console.log(err);
    ...（grok:50/53, groq:72, huggingface:50, lmstudio:45, mercury:56/59,
        mistral:68, novita:53, ollama:51, qwen:48, gemini:72/114 …）
  同一行附近已经改好了"标记化"那一半（`res = failedReply(\`... ${err?.message ?? err}\`)`），
  但 `console.log(err)` 这行是**另一个出口**：它打印的是对象本体，不是 message。
  OpenAI/Anthropic SDK 抛出的 `APIError` 上挂着 `headers`（含 `authorization`/`x-api-key`）、`request`、
  `error.response`，Node 的 `console.log` 对 Error 会打印自有可枚举属性 → 可能整段 header 进日志。
  出处：docs/audit/13-models-agent-preflight.md P11（"16 处 console.log(err) 打印整个 error 对象（可能含 Authorization header）"）；
  docs/audit/00-REPORT.md §Not checked 明确写「**P11 的密钥泄露面未实测**：需要触发一次 401 后 grep 日志」。
  本轮在当前代码复核：**仍在**，且计数从 16 涨到 19（第 31 条改 `failedReply` 时没顺手收这行）。
exploitability: |
  两步：① 上游 API 返回 401/403（口令错、余额耗尽、密钥被撤）→ 适配器进 catch → `console.log(err)`；
  ② 日志落盘（`mindcraft/logs/*.log`、`logs/mindcraft-console.log`、agent 子进程 stdout）。
  读的人/进程拿到 `Authorization: Bearer sk-...` 就能直接用量该账号。
  影响半径：日志文件是本机文件，但本仓日志已被多次整份交给别的 agent/审计者看（`tmp-t59-agent.log`、`run-live.log`），
  且面板的 `bot-output` 会把 agent stdout 广播出去（见 F-WEB-001）。这是"密钥经由日志离开本机"的典型路径。
suggested_fix: |
  19 处统一改成只打 message（与相邻的 `failedReply(\`... ${err?.message ?? err}\`)` 同口径）：
    `console.log('[llm] ' + (err?.stack ? String(err.stack).split('\n')[0] : String(err?.message ?? err)));`
  更彻底：在 `src/models/_shared.js` 加 `export function logErrOnce(tag, err)`（内部只取 `err?.status`、`err?.message`，
  绝不 touch `headers`/`request`），19 处改成 `logErrOnce('gpt', err)`。**一行到三行，不动任何业务逻辑。**
verify: |
  cd mindcraft && grep -rn "console.log(err)" src/models/*.js | wc -l        # 期望 0
  node -e "
    const {logErrOnce} = await import('./src/models/_shared.js');
    const e=Object.assign(new Error('401'),{headers:{authorization:'Bearer sk-LEAKCANARY'}});
    logErrOnce('gpt', e);
  " 2>&1 | grep -c "sk-LEAKCANARY"                                           # 期望 0（金丝雀不出现）
  npm run gate                                                              # 与基线一致
discovered_by: patch-smith(from history)
dept: D2-SEC

---
resolution: deferred（下一轮；patch-smith · D2 修补）
为什么本轮没做: 19 个适配器 × 每处 1~3 行的机械改动 + 需要一处共享 `logErrOnce` 工具，
  而本轮窗口内优先做了 captain 指定的 206/205/209/104 与更危险的 speak/!goal 链（t8）。
  它没有变坏，只是排在后面；**风险未消失**：401/403 时 `console.log(err)` 会把 adapters 的
  error 对象（可能含 authorization header）打进 stdout → 落 `logs/mindcraft-console.log`。
修法（已备好，照抄即可）: 在 `src/models/_shared.js` 加
  `export const errMessage=(e)=>String(e?.message??e??'');` 与
  `export function logErrOnce(tag,e){console.warn('['+tag+'] '+errMessage(e));}`，
  19 处 `console.log(err)` → `logErrOnce('<name>', err)`；**绝不**打印 err 对象本体。
verify: `grep -rn "console.log(err)" src/models/*.js | wc -l` → 期望 0；金丝雀见 finding。
