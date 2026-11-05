id: F-EXEC-112
severity: medium
class: config
file: mindcraft/src/mindcraft/mindserver.js:292-306
evidence: |
  `create-agent` 只读 `settings_spec` 的 `required` 与 `default`，声明的 `type`/`options` 全树零读取：
    :292  for (let key in settings_spec) {
    :294      if (settings_spec[key].required) { … }
    :299      settings[key] = settings_spec[key].default;
  `mindcraft/src/mindcraft/public/settings_spec.json` 对每个键都声明了 type（`log_all_prompts` 在 `:94`，
  同族还有数组型的 `only_chat_with`、数字型的 `max_messages` 等），但**没有任何一处代码校验类型**。
    $ grep -n "settings_spec\[key\]" mindcraft/src/mindcraft/mindserver.js
    （只有 .required / .default 两种用法）
  同族对照：`auth_gate.js:140` 的 `SAFE_RUNTIME_SETTINGS` 只做**键**白名单（挡"能不能改这个键"），
  **不校验值**；两者合起来仍有洞：改对了键、给错类型的值 → 静默生效。
  出处：docs/audit/03-interface-security.md I8；docs/audit/21-review-r2-verdict.md §3 **R2-2（收录待修）**、
  §10 给出最小修法与验证；docs/audit/00-REPORT.md §四 4.1 I8「仍存在」。
  本轮在当前代码复核：**仍存在**（`:292-306` 只碰 required/default）。
exploitability: |
  不是远程提权，是**静默错误配置**：
  ① `only_chat_with` 声明是数组，写成字符串 `"HEAVENZEH"` → 底层按数组语义用，
     逐字符迭代或 `.includes()` 退化成子串匹配 → 该 bot "只跟谁说话"这条**权限面**按完全不同语义生效；
  ② `max_messages` 写成 `"20"` → 字符串比较 `>` 走进奇怪分支，上下文裁剪失效；
  ③ 排障视角最糟：值是错的，但**没有任何一处会拒绝或告警**，现象与"设置生效了"无法区分。
  攻击者视角：能影响 create-agent 载荷的客户端（面板，已在握手门后；本机进程可读启动日志拿 token）
  可以用"类型不对但过白名单"的值把安全相关设置推到边界行为。
  影响半径：单个 agent 的行为/权限面，不是整机。
suggested_fix: |
  `mindserver.js:292-306` 循环里加一个小校验器（≈12 行，无依赖）：
  ```js
  const spec = settings_spec[key];
  const bad = (want) => { console.log(`[create-agent] ${key} 类型应为 ${want}，收到 ${JSON.stringify(val)}`); };
  const v = settings[key];
  if (spec.type === 'boolean' && typeof v !== 'boolean') return callback({ success:false, error:`${key} 应为 boolean` });
  if (spec.type === 'number'  && !Number.isFinite(Number(v))) return callback({ success:false, error:`${key} 应为 number` });
  if (spec.type === 'array'   && !Array.isArray(v))        return callback({ success:false, error:`${key} 应为 array` });
  if (spec.type === 'string'  && typeof v !== 'string')    return callback({ success:false, error:`${key} 应为 string` });
  if (Array.isArray(spec.options) && !spec.options.includes(v)) return callback({ success:false, error:`${key} 不在可选值内` });
  ```
  **不要**非法值回退到 default —— 回退会让人以为设置生效了（那正是本条要消除的"静默"）。
verify: |
  cd mindcraft && node tools/settings_check.mjs                     # 键一致性仍通过（ac477f3 加的那道）
  grep -c "spec.type\|spec.options" src/mindcraft/mindserver.js     # 期望 ≥2
  # 行为：向 create-agent 发 only_chat_with: "HEAVENZEH"（字符串而非数组）
  #   期望 callback { success:false } + 日志「only_chat_with 应为 array」
  # 反证（不该被拒）：only_chat_with: ["HEAVENZEH"] → success:true
discovered_by: patch-smith(from history)
dept: D3-EXEC
