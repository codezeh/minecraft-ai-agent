id: F-GATE-001
severity: medium
class: config
file: src/agent/commands/index.js:31
evidence: |
  `isVisibleToModel()` 的唯一活代码是 index.js:31 的 `if (!settings.companion_mode) return true;`。

  但 `settings.companion_mode` **从未在 settings_spec.json 里声明**：
    $ find mindcraft -name settings_spec.json        → src/mindcraft/public/settings_spec.json
    $ grep -o companion_mode src/mindcraft/public/settings_spec.json   → 无输出（未声明）
  ⇒ `settings.companion_mode` 恒为 `undefined` ⇒ `!undefined === true` ⇒ **恒 `return true`**。

  白名单本身是死的：
    COMPANION_COMMANDS 条目数 = 8（index.js:19-28，注释自称"60 条 → 7 条"，方案 §12 说 8 条）
    实际注册命令数 = 64（queries.js 16 + actions.js 48）
  ⇒ 模型看到的是 **64 条**，不是 8 条。

  交叉印证（不是我一个人看出来的）：
  - `tools/settings_check.mjs` §2 每次运行都打印该例外，原文："该开关从未在 spec 声明 → 恒 falsy →
    全部命令对模型可见 → 方案 §12 的'只给 8 条'从未生效"。
  - 同一文件的注释史显示这个开关被**删过多次但唯独这一处没删**：
    `src/agent/commands/actions.js:216 / 242 / 456 / 465 / 560` 均写着"D23：删掉 companion_mode 开关"，
    说明当时的清理动作漏掉了 `commands/index.js:31`（以及 `COMPANION_COMMANDS` 整块变成了死数据）。
  - `tools/settings_check.mjs:9` 甚至把这一行当作示例字符串引用过，却没有人把它接到 spec 上。

exploitability: |
  前置条件：攻击者能让模型读到不可信内容（玩家聊天 / 任务描述 / 网页抓取文本 → 提示注入），
  或仅仅是正常使用时长上下文膨胀。

  影响半径：
  1. **模型可见面 8 → 64**。方案 §12 收敛命令列表的初衷是"模型只能挑这 8 条确定性的路，
     不许自己写 `!newAction` 试错"。现在 56 条额外命令（含 `!newAction` 这类自由执行入口）
     全部对模型可见 —— 提示注入可选择性明显变大。
  2. 上下文里多 56 条命令文档，模型更容易绕开专用命令自行试错（方案 §12 记录过实测：
     铺 3×3 平台试了 4 次）。
  3. **不是权限漏洞**：真正能不能执行由 `src/agent/permissions.js`
     （`resolveLevel`/`canRunCommand`，按"谁说的"定级）把关，玩家手输命令也不受影响。
     ⇒ 本项只降低"模型可自主选择的面"，不直接给出越权执行。

suggested_fix: |
  二选一，**不要**再留"挂着不动"的第三态（settings_check 已把它挂在 §2 例外里，会一直被容忍）：

  (A) 承认现状、删掉死分支（改动最小、零行为变化）：
      - 删 `src/agent/commands/index.js:29-33` 的 `isVisibleToModel()` 整个函数；
      - 删同文件 `COMPANION_COMMANDS` 常量块（8 条，已是死数据）；
      - 改所有调用点（`grep -rn isVisibleToModel src/`）直接不再过滤；
      - 在 `tools/settings_check.mjs` §2 删除该例外条目。

  (B) 正式接通（会真的隐藏 56 条命令，**必须真机回归**）：
      - 在 `src/mindcraft/public/settings_spec.json` 声明键
        `companion_mode`（type=boolean，default=false，并写清"true 时只暴露 8 条"的语义）；
      - 由 captain 决定默认值：default=false 等价现状，default=true 才是方案 §12 的原意；
      - 若选 default=true，必须真机跑一轮确认模型仍能完成基本任务（收敛后可能明显变差）。

  建议：**今晚先做 (A)**（纯删除、可验证、零风险）；(B) 属于产品决策，留给用户拍板。

verify: |
  1. `cd mindcraft && node tools/settings_check.mjs` → §2 例外列表里**不再出现** `settings.companion_mode`
     （要么零漏声明且零例外，要么该键已进 spec）。
  2. `grep -rn "companion_mode" src/` → 仅在 (B) 方案下命中 spec 读取点；在 (A) 方案下应**零命中**。
  3. 若走 (B) 且 default=true，需一条新单测：造一个非白名单命令，断言 `isVisibleToModel('!newAction') === false`；
     再断言白名单内命令为 true。现有 `tools/composite_registry_unit.mjs` 不是这块，需新建。
  4. 若走 (A)：`grep -rn "COMPANION_COMMANDS\|isVisibleToModel" src/ tools/` → 零命中；
     且 `npm run lint` 的 error 数**不增加**（删除死代码通常还会减少）。

discovered_by: gate-keeper
note: |
  id 段 `F-GATE-*` 是 gate-keeper 自查门禁可信度时产生的新段位，不在 captain 批准的
  0xx(recon-scout) / 1xx(patch-smith) 两个段内。如 captain 要求并入既有段位，请指示改号，
  内容不变。
