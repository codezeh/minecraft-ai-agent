id: F-WEB-102
severity: medium
class: config
file: web/tsconfig.json:6
evidence: |
  面板（`web/`，Vue + TS）的门禁实际上是空的，两件事叠加：
  ① **类型检查被关掉**：`web/tsconfig.json:6-7`
       "strict": false,
       "noImplicitAny": false,
     再加 `"skipLibCheck": true` —— `vue-tsc --noEmit` 能通过的代码，`any` 可以到处流、
     `undefined` 可以随便解引用。门禁只在"语法/明显类型不匹配"这一层起作用。
  ② **它根本不在任何自动门禁里**：`mindcraft/package.json` 的 `gate` / `gate:full` 只跑
     `settings_check + preflight_regex_unit + preflight + lint_hard (+ unit_all)`，
     **没有 `cd ../web && npm run typecheck && npm run build`**；
     `.githooks/pre-commit` 走的就是 `npm run gate`（单一真相源）。
     面板也没有自己的 test/lint 脚本（`web/package.json:scripts` = dev/build/preview/typecheck）。
  于是：改了 `web/src/**` 之后，**没有任何一道门会拦**；pre-commit 绿 ≠ 面板能构建。
  PLAYBOOK §4 把 web 检查写成并列的一道门（`cd web && npm run typecheck && npm run build`），
  但没有任何**触发点**把它接上 —— 这正是第 11 条"配好了等于没配"在面板侧的复现。
  出处：docs/audit/04-tests-gates.md **T11**（"web typecheck 通过但门禁极弱（strict 全关）"）；
  docs/audit/00-REPORT.md 第 11 条（"三道门禁没有任何一个被自动执行"—— 当时只解决 mindcraft 侧）；
  T11 **从未进 00-REPORT 34 条编号**（docs/audit/21-review-r2-verdict.md §4.3"≈68 条不可追溯"之一）。
  本轮在当前代码复核：**仍存在**（tsconfig 与 scripts 逐字未变；gate:full 里没有 web）。
exploitability: |
  无攻击面，是**交付风险**：面板是唯一给人看的控制面（`/console`），
  而它的类型/构建错误只在"手动跑一次 build"时才暴露。今晚任何改动 `web/src/**` 的修复
  （包括本队若有人动面板）都不会被 pre-commit 拦住 → 可能出现"代码已合并、面板打不开"。
  另一层：`strict:false` + `noImplicitAny:false` 让"字段名拼错/接口不匹配"这类**前后端契约漂移**
  （本仓 `web/src/api/types.ts` 是手抄后端的，注释原话"手抄，不把后端 TS 化"）完全检查不出来 ——
  后端改了 `board:list` 的返回形状，面板会在运行期显示 `undefined` 且不报错。
  影响半径：面板可用性 + 前后端契约的可信度。
suggested_fix: |
  两件事分开（第二件是今晚的合理范围，第一件别在今晚做）：
  ① **接门禁（今晚做，≈1 行）**：`mindcraft/package.json` 的 `gate:full` 后面追加
     `&& cd ../web && npm run typecheck`（`build` 太慢，放 `pre-push`）；
     或在 `.githooks/pre-commit` 里对"改动命中 `web/**`"的情况才跑 typecheck（条件执行，避免每次提交等构建）。
  ② **把 strict 打开（第二批）**：`strict: true` 会一口气冒出大量错误 → 必须单独立单、分批收敛，
     **禁止**用 `// @ts-nocheck` 或 `as any` 批量压（PLAYBOOK §7：为过门而放宽规则 = 事故）。
  ③ `web/src/api/types.ts` 的"手抄契约"建议加一条注释指向生成规则或明确"以后端 `board_server.js` 为准"，
     并在 `preflight` 加一条轻量断言（可选，Nice）。
verify: |
  cd mindcraft && node -e "console.log(require('./package.json').scripts['gate:full'])"
  # 改后期望字符串里含 "web" / "typecheck"
  cd ../web && npm run typecheck     # 现状必须绿（作为基线）
  cd ../web && npm run build         # 现状必须绿（作为基线）
  # 反向验证：在 web/src 里故意写 `const x: number = "s";` → pre-commit 必须红（改前是绿的）
discovered_by: patch-smith(from history)
dept: D5-WEB
