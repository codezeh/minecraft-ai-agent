id: F-GATE-003
severity: low
class: config
file: eslint.config.js:40
evidence: |
  三条规定是 `"off"`，且**从初始提交起就是 off**（不是后来为了过门关掉的）：

  eslint.config.js:40-42
    "curly": "off",                 // Do not enforce the use of curly braces around blocks of code.
    "no-unused-vars": "off",        // Disable warnings for unused variables.
    "no-unreachable": "off",        // Disable warnings for unreachable code.

  历史比对（`git log -- eslint.config.js` 只有 3 次提交：2f7185e 初始 / c0c98e3 / 9fe2fad）：
    $ git show 2f7185e:eslint.config.js | grep -E 'curly|no-unused-vars|no-unreachable'
    → 三条同样是 "off"
  两次后续改动逐条比对：`no-undef` error→error、`semi` error→error、`require-await` error→error、
  `no-floating-promise` error→error，**无一放宽**；实际只改了
  `globals.browser → globals.node` 与 `ecmaVersion 2021 → latest`（都是**收紧**）。

  ⇒ 结论有两半，缺一不可：
  (1) **不存在"为过门放宽规则"的先例**（这点是好消息，已写进 baseline.md）。
  (2) **但这三条自始关闭**，所以 lint 的"0 error"从来不等于"代码干净"：
      - `no-unreachable: off` ⇒ **死代码/永远走不到的分支不会被任何门禁发现**；
      - `no-unused-vars: off` ⇒ 未使用变量/函数（含"删了调用方但导出还在"的残留）不报；
      - `curly: off` ⇒ 单行 if 缺大括号，改动时容易插错作用域（历史上 typo 类事故的温床）。

  当前实际 lint 状况（供对照，证明 lint 确实在工作、只是有洞）：
    $ cd mindcraft && npm run lint   → 197 errors（semi 101 / require-await 78 / no-empty 8 …）
      no-undef = 0，no-floating-promise = 0   ← 这两项真的干净
    `curly`/`no-unused-vars`/`no-unreachable` 三条计数**恒为 0**，因为它们没开。

exploitability: |
  不是可直接利用的漏洞，是**审计可见性缺口**：

  1. 死代码盲区：`no-unreachable` off 意味着"改完留下一条走不到的分支"这种典型重构残留
     不会被 lint 抓到。而本仓库历史上多次出现"导出还在、调用方已删"的残留
     （HISTORY-EXPIRED.md 第 20/22 条即为同一族问题的记录），这类残留是审计里最容易
     被误判为"活代码"的东西。
  2. 未使用符号盲区：`no-unused-vars` off ⇒ 一次误删调用链不会被发现，测试也不会红
     （只要没有测试覆盖它）。它让"死分支"在 D3/D4 的漏洞猎杀里**看起来仍然活着**，
     反过来也让人把活分支当成死的去删。
  3. 影响半径：仅影响静态审查的置信度，不影响运行时行为。

suggested_fix: |
  **不要一次性全开**（立刻会炸出几百条，然后必然被人用 `// eslint-disable` 或"先关回去"解决，
  那就是又一次为过门放宽）。用已有的棘轮机制分期：

  1. `tools/lint_ratchet.mjs` 已经是棘轮（历史上有"从 301 压回 278"的记录），复用它：
     - 第一步只把 **`no-unused-vars`** 设为 `"warn"`（不是 error），跑一次记录总数进棘轮基线
       （`tools/lint_ratchet.mjs` 的基线数字），此后**只许下降不许上升**。
     - 第二步在棘轮数字趋零后改 `"error"`。
  2. `no-unreachable` 同理，但优先级更高（死分支是审计误判的根源）：
     先 `"warn"` 入棘轮 → 清到 0 → 改 `"error"`。
  3. `curly` **建议保持 off**：这是代码风格而非安全判据，开它只会制造无意义的巨型 diff，
     与 PLAYBOOK §3 红线"不做大规模重构、不顺手美化"冲突。把"保持 off"的理由写进注释，
     免得下一个人以为是漏配。
  4. 若 captain 认为今晚不动 eslint 配置更安全（避免与修补组的 commit 打架），
     **至少把这三条写进审计规则文档**为"已知盲区"，让复核时人工检查死代码与未使用符号。
     ——`curly`/`no-unused-vars`/`no-unreachable` 当前是"沉默的 0"，最危险的是有人把
     这个 0 读成"没有问题"。

verify: |
  1. `cd mindcraft && npm run lint:tools`（棘轮）→ 跑得起来且基线数字被记录；
     改动后数字**只减不增**（这就是棘轮的定义）。
  2. 反向验证（必须）：临时在 `src/` 某文件加一个未使用的变量 + 一段 `return` 之后的无用语句，
     确认 lint 输出里 `no-unused-vars` / `no-unreachable` **确实各 +1**；
     删除后数字回落。若加了不报，说明规则没真开（又成假绿）。
  3. `git log -p -- eslint.config.js` → 本次改动只允许"off → warn"这类**收紧**方向；
     出现任何 "error → off" 即视为事故（PLAYBOOK §7）。
  4. 若选择"只写进文档不动配置"：`grep -n "no-unreachable\|no-unused-vars" docs/audit/night/*.md`
     能命中"已知盲区"记录，且 baseline.md §3.2 已载明（已载明）。

discovered_by: gate-keeper
note: |
  严重度故意定为 low：**没有放宽先例**这一点已核实，所以它不是"门禁被做假"，
  而是"门禁的覆盖面被默认留白"。它的价值在于防止复核席把 lint 的 0 error 误读为干净。
  id 段 `F-GATE-*` 为 gate-keeper 自查新段位，如 captain 要并入 0xx/1xx 请指示改号。
