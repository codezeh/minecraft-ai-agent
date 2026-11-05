id: F-SEC-208
severity: low
class: config
file: tools/server-net.mjs:12
evidence: |
  项目里有一句**写进代码注释的错误安全论断**，它会让每一个读到它的人（包括未来修漏洞的人）
  得出"这条风险已经被白名单堵住了"的错误结论，从而长期不去修真正该修的东西。

  `tools/server-net.mjs` 头部注释原文（第 9-14 行）：
  ```
   *   ★ 关键认知：**真正的安全边界是白名单，不是绑定地址。**
   *     离线模式（online-mode=false）下客户端不做 Mojang 验证，任何人可以用任意名字连；
   *     但开了 white-list 之后只有名单里的人能进 —— 冒用名字就没用了。
   *     所以「绑所有网卡 + 白名单」是安全且可用的组合，不必为了安全牺牲局域网。
  ```
  `config/network.json` 的 `_主服与测试服配置不同` 段有同一论断的简版（"开白名单（只有你能进）"）。

  **这句话在"多名字白名单"下成立，在"白名单只有一个名字"下不成立。**
  实测当前配置（我逐条核证）：
  ```
  server/server.properties: online-mode=false / white-list=true / enforce-whitelist=true / server-ip=(空)
  server/whitelist.json: 仅 1 条 = HEAVENZEH
  config/network.json: servers.main.players = ["HEAVENZEH"]      ← 名单本身入库
  profiles/my-local.json:6 "owner": "HEAVENZEH"                  ← bot 的主人就是这个名字
  mindcraft/settings.js:19 激活的正是 ./profiles/my-local.json
  ```

  推理链（每一跳都有证据，不是推测）：
  1. 白名单校验的是**名字**，不是身份。它挡的是"**不在名单上的名字**"。
  2. 攻击者要做的恰恰是**冒用名单上那唯一一个名字**（HEAVENZEH）。
  3. ⇒ 白名单在这一步**完全不起作用**，它只会把 "HEAVENZEH" 正常放进来。
  4. 离线模式（online-mode=false）**没有第二道校验**（无密码、无正版校验，服务端只认客户端自报的名字）。
  5. 串起来：**"绑所有网卡 + 单名字白名单" 并不等于"安全且可用"，它等于"任何知道这个名字的人
     都能以主人身份进服"。**

  为什么这句错误论断有实际杀伤力（而不是文字洁癖）：
  - 它出现在**唯一的网络配置工具**的头部注释里，是后来人理解这套配置的第一入口；
  - 它同时给出了一个"所以不必为了安全牺牲局域网"的结论 —— 而正是这个结论让
    `bind: all` 这个选择看起来是安全的；
  - `F-SEC-204`（冒名登录，severity 已升 high）之所以能长期存在，部分原因就是
    这句注释提供了"已经防住了"的心理担保。

exploitability: |
  本身不可利用（是注释，不影响运行时行为）。它的危害是**认知层面**的：

  1. 让维护者相信"白名单 = 安全边界"，从而不去考虑"单名字白名单挡不住冒用"这个漏洞；
  2. 让后续审计者读到就跳过这块（"人家已经论证过冒用没用了"）；
  3. 直接支撑了一个反向结论："绑所有网卡是安全且可用的" ⇒ 促成 `bind: all` 长期保留。
  影响半径：间接放大 `F-SEC-204`。

suggested_fix: |
  **纯注释改动，零行为风险，不改任何一行逻辑。** 三处：

  1. `tools/server-net.mjs` 第 9-14 行的 `★ 关键认知` 段改写为（建议文案）：
  ```
   *   ★ 关键认知（2026-11-06 审计更正）：**白名单不是万能的，它挡"别人"，不挡"伪装成你"。**
   *     离线模式（online-mode=false）下客户端不做 Mojang 验证，服务端只认客户端自报的名字。
   *     白名单校验的是**名字**：它能挡住名单外的人，但**挡不住有人冒用名单上那唯一一个名字**
   *     （本机主服名单只有 HEAVENZEH ⇒ 把游戏名改成 HEAVENZEH 即可冒充主人进服，
   *      且会拿到 bot 的 OWNER 级权限，含 !newAction 代码执行 —— 见 F-SEC-204 / F-GATE-* 族）。
   *     ⇒ 「绑所有网卡 + 白名单」是**可用**的，但**不是安全**的；真正的边界只有两条：
   *       收回监听地址（牺牲局域网）或加身份校验（登录插件 / 正版校验）。
  ```
  2. `config/network.json` 的 `_主服与测试服配置不同` 段里"开白名单（只有你能进）"
     改为"开白名单（只挡名单外的人；**挡不住冒用 HEAVENZEH 这个名字**，见 F-SEC-204）"。
  3. **保留**该文件原有的"由你按需要切"的定位说明 —— 本单不改产品行为，只纠正一处事实错误。

  **不要**在本单里顺手改 `online-mode`、`bind`、白名单或 `ops.json` —— 那些是 `F-SEC-204`
  的范围，且需要用户拍板。一个 commit 只解决一条 finding。

verify: |
  1. **确认只动了注释/纯文本，没有动逻辑**：
     ```bash
     cd mindcraft && git diff --stat -- tools/server-net.mjs
     git diff -- tools/server-net.mjs | grep -E "^[+-]" | grep -vE "^[+-]{3}" | grep -vE "^[+-]\s*\*"
     ```
     期望：第二条命令**无输出**（所有增删行都是注释行 `*` 开头）。
  2. **工具行为完全不变**：
     ```bash
     node tools/server-net.mjs show            # 输出与改动前逐字一致
     node tools/server-net.mjs apply --dry     # 仍是 dry-run，不写盘
     ```
     期望：两者的 `bind/目标/实际` 三行与改动前相同（注释不参与求值）。
  3. **错误论断已消失**：
     ```bash
     grep -n "冒用名字就没用了" mindcraft/tools/server-net.mjs config/network.json
     ```
     期望：**无输出**（旧的错误句子已不存在）。
  4. **新论断已就位**：
     ```bash
     grep -n "挡不住\|不挡" mindcraft/tools/server-net.mjs
     ```
     期望：命中更正后的文案。
  5. 门禁不回归：`npm run gate` 通过（注释改动理论上零影响，但要留证）。

discovered_by: gate-keeper
note: |
  本条是 `F-SEC-204` 的**配套**：204 处理"这个风险要不要修/怎么修"（需用户拍板），
  208 只处理"别再用一句错话安慰自己"（零风险，今晚就能合）。
  **建议 208 先于 204 落地** —— 顺序与 `F-SEC-206` 先于 `F-SEC-201` 同理：
  先把错误认知清掉，再谈怎么改行为，避免改动被旧论断抵消。

  与 captain 裁决的一致性：captain 2026-11-06 已裁定 204 severity medium→high，
  并把本条（注释纠错）单独立为 low 单，本条即该裁决的落地单。

---
status: fix-ready-awaiting-commit（patch-smith · D2 修补）
see: docs/audit/night/manifest-D2.md 的对应小节（改动清单 + commit message 草稿 + 自检证据 + 回滚）
