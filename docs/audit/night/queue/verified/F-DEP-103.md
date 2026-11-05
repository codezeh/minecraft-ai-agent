id: F-DEP-103
severity: medium
class: deps
file: mindcraft/.gitignore:4
evidence: |
  `mindcraft` 的依赖图**根本没有版本控制**，而 `web` 的有一一 两个仓、两个 lock、两种命运：

    $ cd mindcraft && git check-ignore -v package-lock.json
    .gitignore:4:package-lock.json	package-lock.json
    $ git ls-files --error-unmatch package-lock.json
    error: pathspec 'package-lock.json' did not match any file(s) known to git

    $ cd .. && git ls-files --error-unmatch web/package-lock.json
    web/package-lock.json                     ← 外层仓**有**追踪

  也就是说：**真正跑生产的那一侧（mindcraft，547 条 lock 条目、13 个 high CVE 都在这里）** 的 lock
  从来不在任何 git 历史里；而只是给人看的面板（web，3 条 moderate）的 lock 反倒入库了。
  旁证：`docs/audit/00-REPORT.md` 第 14/24 条、`F-DEP-005/006` 全都以"lock 里的这一条"为对象做修复，
  但这些修复**改完也进不了历史**（本轮实测：我改好 `gl` 的 `integrity` 后 `git status` 里 package-lock.json 根本不出现）。

  后果链（与 D1 其它条目叠加）：
  ① **不可复现**：`npm ci` 的语义是"按 lock 装出逐字节相同的树"，lock 不入库 ⇒ 换机器/回滚都做不到，
     只能靠"某台机器上那份 286KB 的文件还在"；
  ② **不可审计历史**：`git log -p package-lock.json` 为空 ⇒ "谁在什么时候引入了哪个版本"永远无法回答（供应链取证的根）；
  ③ **修复无处落地**：`F-DEP-005`（镜像源）、`F-DEP-006`（gl 缺 integrity）、`F-DEP-010`（body-parser 1.20.9）
     三条修的都是 lock，**全部只能停在磁盘上**，下次 `npm install` 一跑就可能被覆盖/重写；
  ④ 与 `F-DEP-004`（补丁无闸）合起来：本仓最需要"可复现 + 可审计"的两样东西（补丁集、依赖树）
     一个没人看、一个不入库。

  出处（历史脉络）：`06-docs-lean.md` §0.1 / §6.2 记录过"外层整棵树没有版本控制"，但**没有指出 mindcraft 的 lock
  被 .gitignore 排除**；`21-review-r2-verdict.md` §4 的"≈68 条不可追溯"里也没这条。本条为 patch-smith 在 D1 修补轮
  落地 `F-DEP-006` 时实测发现（改 lock → `git status` 无变化 → 反查到 `.gitignore:4`）。
exploitability: |
  不是"能被远程利用"的洞，是**供应链可复现性/可取证性的根缺失**：
  - 攻击者只要在任何一次安装里让浮动解析落进一个带 install 脚本的版本（`F-DEP-005` 的删 lock 重装路径），
    事后**没有任何历史可以比对"到底换了什么"** —— 因为没有上一份 lock 在库里。
  - 对被投毒的维护者/PR 同样：改 package.json 的 `^` 范围 + 重装 = 全新依赖树，且无 diff 可审。
  - 影响半径：本机全部密钥（安装期脚本以当前用户身份执行，见 `F-DEP-004/012`）+ 全世界范围的 bug 不可复现。
  - 与 integrity 缺失的叠加：`gl` 那条本来就无摘要（`F-DEP-006`），而没有入库的 lock 意味着连"基线摘要该是多少"
    都没有公共参照。
suggested_fix: |
  ① 从 `mindcraft/.gitignore` 删掉第 4 行 `package-lock.json`（**别动 `node_modules/`**），
     然后 `git add -f mindcraft/package-lock.json` 首次入库（6409 行 / 286KB，这是 app 仓的正常体量，不是负担）。
  ② 首次入库必须**与"当前实际安装结果"一致**：先在有安装权限的环境跑一次
     `cd mindcraft && npm ci`（必须在 `F-DEP-003` 补丁换血之后），确认 `npm ls --all` 无 invalid，再提交这份 lock。
  ③ 提交信息里写明：这是**首次**入库，内容 = 某次真实安装的产物，不是手改的。
  ④ 入库后，`F-DEP-005/006/010` 的修复才有落脚点；届时把 `deps-baseline.md` §1 的审计计数一起更新。
  ⑤ 顺带在 `web/.gitignore`/外层仓确认 `web/package-lock.json` 继续被追踪（现状正确，别误加 ignore）。
  **不要**用 `.gitignore` 排除 + `git add -f` 的混合做法（下次会被 ignore 弹回来）；要入库就干净地取消 ignore。
verify: |
  cd "E:/我的世界ai" && git -C mindcraft check-ignore -v package-lock.json ; echo "ignore_exit=$?"   # 期望非 0（不再被忽略）
  git -C mindcraft ls-files --error-unmatch package-lock.json                                        # 期望打印路径
  git -C mindcraft log --oneline -1 -- package-lock.json                                              # 期望有首次入库提交
  cd mindcraft && npm ls --all > /dev/null 2>&1 ; echo "npm_ls_exit=$?"                              # 期望 0（树与实际安装一致）
discovered_by: patch-smith
dept: D1-DEP

---
resolution: blocked（patch-smith · D1 修补轮发现，需用户/captain 决策）
blocked: |
  取消 ignore + 首次入库 lock 是**用户级决策**（会让 mindcraft 仓多一个 286KB 文件，且必须以"一次真实安装的产物"入库，
  不能手改）。本会话无安装权限、也不能 git add ⇒ 只能停在建议 + 已把影响写清。
  **它同时卡住 F-DEP-005/006/010 三条**：那三条改的都是 lock，未入库前改完也不算修好（下次 npm install 可能重写）。
  建议处置顺序：F-DEP-003 补丁换血 → npm ci → 取消 .gitignore:4 并首次入库 lock → 再落 F-DEP-005/006/010。

## review（gate-keeper · t13 · 2026-11-06 02:2x）
**结论：通过（blocked 成立，且这是 D1 最关键的一条）。** commit：无（需用户决策）。

实际执行（全部独立复现）：
```
cd mindcraft && git check-ignore -v package-lock.json
  .gitignore:4:package-lock.json	package-lock.json        ← 确认被忽略
git ls-files package-lock.json → 空（未跟踪）
cd /e/我的世界ai && git ls-files web/package-lock.json
  web/package-lock.json                                       ← 面板的 lock 反而被跟踪
ls -la mindcraft/package-lock.json → 286159 B（存在但无历史）
```
- **两个仓、两个 lock、两种命运**：真正跑生产的一侧（13 个 high + 1 critical 都在这里）没有版本控制，
  给人看的面板反而有。这条判断**完全成立**。
- 它确实卡住 F-DEP-005/006/010：我复核 F-DEP-006 时确认"gl 的 integrity 已补好但 `git status` 里
  package-lock.json 根本不出现"——修复只存在于磁盘，换机即丢。
裁定：**blocked 正确**，属用户级决策（多一个 286KB 文件入库）。**通过**，并建议 captain 把它排到
D1 收口前的第一位——否则 D1 有 3 条"修了但不算修好"。
