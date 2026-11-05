id: F-DEP-102
severity: medium
class: deps
file: mindcraft/package.json:48-56
evidence: |
  D1 部门要的"npm audit 结果与 lock 版本对得上"这件事，本仓**从来没有过一次**：
    $ node -e "console.log(require('./mindcraft/package.json').scripts)"
    { test, test:units, gate, gate:full, lint, lint:hard, lint:tools, ... }
    （无 `audit` / 无 `npm audit` / 无 lock 对账脚本）
    $ grep -rn "npm audit" docs/audit/*.md | wc -l
    0
  即：`gate` = settings_check + preflight_regex_unit + preflight + lint_hard；`gate:full` = gate + unit_all。
  两条门都不碰依赖树。docs/audit 01~19 十二份分册、00-REPORT 34 条硬发现里 **CVE 结论 0 条**。
  出处：docs/audit/night/PLAYBOOK.md §6 D1 判据（"npm audit 结果要与 lock 版本对得上，不许凭印象报"）；
  反证：docs/audit/00-REPORT.md 全 34 条无一条 deps/CVE 类（第 8 条只提 `PRAGMA`、无 CVE）。
  这是**结构性缺口**，不是"已知 bug 未修"：历史审计只做过一次依赖"可删清单"（06 分册 §5），没做过漏洞面。
exploitability: |
  风险不是"现在有洞"，是"有洞也不会有人知道"：lock 里任何一个传递依赖被披露 CVE 后，
  本仓没有任何一处会报出来 —— 不跑 audit、不比对 lock、没有 CI。攻击者只需要等上游披露
  一个利用条件匹配本机（单机、`localhost` 服务、bot 是 op）的 CVE。
  与第 26 条（preflight 0x08 假绿）同类："没有检查"和"检查了没问题"在这里长得一样。
suggested_fix: |
  ① 加脚本（不改依赖）：`"audit": "npm audit --omit=dev --audit-level=high"`；
  ② 接进 `gate`（本地门，无网时应 fail-open 打印"未联网，跳过"而不是假绿）；
  ③ 落一份 `docs/audit/night/deps-baseline.md`：记录 `package-lock.json` 的 lockfileVersion、
  依赖总数、当前 `npm audit --json` 的 vulnerabilities 计数（按 severity），作为"与基线一致"的判据。
  ④ 把 `web/package-lock.json` 同样纳入（面板有独立 lock，从未被审过）。
  **不要**顺手升级依赖 —— PLAYBOOK §3 红线只允许"升已有 lock 内版本 + commit body 写 CVE 号"。
verify: |
  cd mindcraft && npm audit --omit=dev --audit-level=high; echo "exit=$?"   # 基线应与 deps-baseline.md 一致
  cd web && npm audit --omit=dev --audit-level=high; echo "exit=$?"
  node -e "console.log(require('./mindcraft/package.json').scripts.audit)"   # 期望非 undefined
  npm run gate                                                              # 仍与基线一致
discovered_by: patch-smith(from history)
dept: D1-DEP
