id: F-DEP-101
severity: low
class: deps
file: mindcraft/package.json:30
evidence: |
  依赖声明里有 `"prismarine-schematic": "^1.3.0"`，但全树没有任何 import：
    $ grep -rn "prismarine-schematic" mindcraft/src mindcraft/package.json
    mindcraft/src/agent/library/schematic.js:9: * 为什么不用 prismarine-schematic：
    mindcraft/package.json:30:        "prismarine-schematic": "^1.3.0",
  即：唯一的代码侧命中是一句"为什么不用它"的注释（`schematic.js` 自己解析 litematic NBT）。
  出处：docs/audit/21-review-r2-verdict.md §3 R2-7（原 03 分册 I21）；docs/audit/00-REPORT.md §四 4.1 表 I21「仍存在」。
  本轮已在当前代码复核：仍存在（未修）。
exploitability: |
  不是"能被利用的洞"，是供应链面白增：一个永不被 import 的包仍然进 node_modules、
  仍然进 `npm install` 的解析图，它的传递依赖（prismarine-* 一整套）也一起被拉进来并参与 npm audit 的
  评估面。攻击者需要先能发布/劫持该包，本仓从不调用它 → 实际风险≈0；但它是"依赖清单不可信"的成因之一：
  清单里躺着没人用的东西时，'这个依赖有没有 CVE 要不要紧'这种判断就没法只靠清单做。
suggested_fix: |
  删 `mindcraft/package.json:30` 这一行（`dependencies` 里的 `prismarine-schematic`），
  然后 `npm install` 让 package-lock.json 同步收缩。不要动 `schematic.js`（它的注释解释的是设计选择，保留）。
  红线提醒：本仓禁止新增依赖；本条是"删依赖"，属于允许方向。
verify: |
  cd mindcraft && grep -c "prismarine-schematic" package.json package-lock.json   # 期望 0 / 0
  npm ls prismarine-schematic                                                     # 期望 (empty)
  node -e "import('./src/agent/library/schematic.js').then(()=>console.log('schematic import OK'))"
  npm run gate                                                                    # 与基线一致（无新增失败）
discovered_by: patch-smith(from history)
dept: D1-DEP
