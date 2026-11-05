id: F-SEC-105
severity: low
class: secret
file: mindcraft/src/models/hyperbolic.js:50
evidence: |
  提示词落盘有**两个互不知道的开关**，其中一个完全绕开配置体系：
    ① `mindcraft/settings.js:57`  `"log_all_prompts": false`   —— 走设置文件，
       在 `settings_spec.json:94` 有声明、在 `auth_gate.js:140` 的
       `SAFE_RUNTIME_SETTINGS` 白名单里（面板可改），写文件出口是 `prompter.js:419 _saveLog`
    ② `mindcraft/src/models/hyperbolic.js:49-50`
       `// 无条件写进 stdout / logs/mindcraft-console.log。要看提示词请显式开 LOG_PROMPTS=1。`
       `if (process.env.LOG_PROMPTS === '1') console.log('Messages:', messages);`
       —— 走**环境变量**，`settings_spec.json` 里没有这个键，`auth_gate` 白名单里也没有，
       面板上看不到、也改不了；它打的是 **stdout**，不是文件。
  出处：docs/audit/21-review-r2-verdict.md §3 **R2-8**（"只开一个会以为全开"）；
  上游：docs/audit/03-interface-security.md I6 → R1-a（I6 本身已修：默认关、门控做对）。
  本轮在当前代码复核：**仍存在**（两个开关的语义、落点、可见性都不同，且都没互指）。
exploitability: |
  默认两个都关 → 静态不泄漏（R2 的裁决正确）。风险是**运维误判**，以及 `LOG_PROMPTS=1` 这条**旁路**：
  它一旦被打开，`messages` 全文（= 系统提示 + 玩家私聊 + 记忆 + 人设，见 I6 原文）打到 stdout；
  agent 的 stdout 会被 mindserver 的 `bot-output` 原样广播给**所有**面板客户端（见 F-WEB-001），
  并落进 `logs/mindcraft-console.log`。也就是说这条旁路一次性绕开了"设置项 + 白名单 + 文件落点"三层，
  而且不产生任何"我正在导出提示词"的显式痕迹差异（与 `_saveLog` 的 `log_all_prompts` 看不出区别）。
  影响半径：低（需先设环境变量），但它把"能否导出提示词"这个决定从 `settings_spec`（有契约、有单测）
  挪到了环境（无契约、无单测）。
suggested_fix: |
  ① 把 `LOG_PROMPTS` 收进契约：`settings_spec.json` 加一个 `log_prompts_stdout`（默认 false，type boolean），
     `auth_gate.js:140` 的 `SAFE_RUNTIME_SETTINGS` 加同名键，`hyperbolic.js:50` 改成读
     `this.settings?.log_prompts_stdout`（或 `process.env.LOG_PROMPTS === '1' || settings.log_prompts_stdout`），
     两个开关的注释互相点名（"另有 LOG_PROMPTS/stdout 一份，见 …"）。
  ② 在 `_saveLog` 与 stdout 两条路共用一个 `warnOnce('提示词导出已开启：<哪一路>')`，
     让"我打开了导出"永远在日志里显式出现一次。
  ③ **可选**：`settings_check.mjs` 加一条断言 —— `settings_spec.json` 的键集合 ⊇ 代码里读 `process.env` 的
     提示词开关（这条与本仓已有的"settings 键一致性检查" `ac477f3`/`3a41acf` 同族）。
verify: |
  cd mindcraft && node tools/settings_check.mjs                      # 期望通过（含新键）
  grep -n "LOG_PROMPTS" src/models/hyperbolic.js src/mindcraft/public/settings_spec.json src/mindcraft/auth_gate.js
  # 期望：三处都出现（契约 + 白名单 + 消费点）
  LOG_PROMPTS=1 node -e "import('./src/models/hyperbolic.js')" 2>&1 | head -3   # 期望打出「提示词导出已开启」告警
discovered_by: patch-smith(from history)
dept: D2-SEC
