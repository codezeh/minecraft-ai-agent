id: F-SEC-208
severity: low
class: config
file: tools/server-net.mjs:9
dept: D2-SEC

# ⚠️ 本文件由复核席重建（gate-keeper · t14 · 2026-11-06 02:4x）
# 原 finding 由我（gate-keeper）在预审阶段开出，修补后文件被清空。
# 落地见 commit 8c983c4（mindcraft 仓）与 d80caeb（外层仓）。

## review（裁决：**通过**）

### 一、"纯注释、非注释改动 0 行"这个断言 —— 我用可机械复现的方式验了

```bash
$ git show 8c983c4 -- tools/server-net.mjs | grep -E "^[+-]" | grep -vE "^[+-]{3}" | grep -vE "^[+-]\s*\*"
（无输出）
```
⇒ **所有增删行都以 `*`（注释）开头，非注释改动行 = 0** ✅
这正是我在 finding 里要求的"防假改"判据（当时我提的标准是
`git diff | grep -vE "^[+-]\s*\*"` 期望无输出），patch-smith 满足了。

### 二、提交范围干净

```bash
$ git show --name-only --format="" 8c983c4
tools/server-net.mjs          ← 只动一个文件
```
⇒ 没有顺手改 `config/network.json` 之外的东西，也没夹带别的 finding。

### 三、被纠正的错误论断现在长什么样

原文（危险的那句）："真正的安全边界是白名单……开了 white-list 之后只有名单里的人能进 —— **冒用名字就没用了**"。
该论断在**单名字白名单**（本机 `whitelist.json` 只有 HEAVENZEH 一个）下**不成立**：白名单只拦"不在名单上的名字"，
而攻击者冒用的正是名单上那唯一一个。现已按 finding 建议改写为"白名单挡别人、不挡伪装成你"。

### 四、未做但需要知会的一点
`config/network.json` 的 `_主服与测试服配置不同` 段里那句简版论断（"开白名单（只有你能进）"）
在本次两仓提交里**没有一起改**（8c983c4 只动 `tools/server-net.mjs`）。
不阻塞（主论断已纠正），但**同一句错误在这份入库 JSON 里还留着一处简版**，
建议下一轮顺手改掉 —— 否则读 `config/network.json` 的人仍会拿到旧的安全感。
（我已在 `review-D2.md` 的"遗留"里登记，不重复开单。）

**结论：通过。**
