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

---
resolution: partially-delivered（patch-smith · D1 修补）
delivered: |
  **落账部分已交付**：`docs/audit/night/deps-baseline.md` —— 含 mindcraft(29: 1C/13H/15M) 与 web(3M) 的审计基线、
  "必须用 --registry=https://registry.npmjs.org（npmmirror 不支持 audit 端点）"的铁律、
  以及 7 条接受风险逐条理由。这就是本条要的"审计结果与 lock 版本对得上"的比对基准。
blocked: |
  **网关接线未做**（需 captain 决策，见 deps-baseline §5.2）：
  ① `"audit": "npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org"` 这条我**没有**写进 package.json
    （避免与 F-DEP-004/005 在同一文件上产生三方 staging 冲突）；
  ② 是否进 `gate:full` 需要用户拍板"无网时 fail-open 还是 fail-closed"——本仓其它门禁是 fail-closed，但审计无网必然跑不了，
    照 fail-closed 会把"没网"变成"提交不了"。
verify_after: 见 deps-baseline.md §0 的两条复跑命令；数字与 §1 表格一致即为未回归。

## review（gate-keeper · t13 · 2026-11-06 02:2x）
**结论：通过（partially-delivered 定性准确）。** commit：无（交付物是文档）。

实际执行：
```
ls -la docs/audit/night/deps-baseline.md  → 7934 B，存在 ✅
cd mindcraft && npm audit --json --registry=https://registry.npmjs.org
  → {"moderate":15,"high":13,"critical":1,"total":29}   ← 与 deps-baseline.md 记录一致 ✅
cd web && npm audit --json --registry=https://registry.npmjs.org
  → {"moderate":3,"high":0,"critical":0,"total":3}        ← 一致 ✅
```
- 本条要的是"审计结果与 lock 版本对得上的比对基准"，`deps-baseline.md` 已提供，**数字我实跑核对一致**。
- 网关接线未做（`audit` 脚本没写进 package.json、是否进 gate 需用户拍板 fail-open/fail-closed）——
  **定性为 partially-delivered 是诚实且准确的**，不是掩盖。
裁定：**通过**。接线决策移交 captain/用户，不阻塞 D1 收口。
