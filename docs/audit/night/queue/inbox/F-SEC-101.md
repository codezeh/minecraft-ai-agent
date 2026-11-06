id: F-SEC-101
severity: high
class: config
file: server/server.properties:14,46,54
evidence: |
  主服配置（`server/server.properties`，已被 `.gitignore:74` 忽略、不入库，但**在磁盘上明文**）：
    :14  enable-rcon=true
    :46  rcon.password=<已脱敏：32 字符随机串，本文不抄录>
    :47  rcon.port=25575
    :54  server-ip=                      ← 空 = 绑所有网卡
  而 `config/network.json` 明确写着主服故意绑所有网卡（局域网/手机要连）：
    "main": { "bind": "all", ... "onlineMode": false, "players": ["HEAVENZEH"] }
  于是 RCON 的暴露面 = **整个局域网**，凭据是一个躺在本机明文文件里的固定口令。
  `server/server.properties.example:46` 是 `rcon.password=CHANGE_ME`（模板没问题）。
  出处：docs/audit/00-REPORT.md §十二 第 4 项 "RCON 仍 `0.0.0.0` + `[::]` → S1（沿用）"（v2.1 明确写"沿用"，即未修）；
  docs/audit/03-interface-security.md I1 一族（S1）。
  本轮在当前代码复核：仍存在（`enable-rcon=true` + `server-ip=` 为空未变）。
exploitability: |
  攻击者前置条件：与主机同一局域网（同一 WiFi / 同宿舍网 / 同一内网段），且知道口令。
  能拿到什么：`enable-rcon=true` + `broadcast-rcon-to-ops=true` → RCON 指令面 = **完整服务端控制台**，
  可以 `/op` 任意玩家、`/fill` 拆图、`/kick`、`stop`。因为 `onlineMode=false` + `ops.json` 里有 341 条 bot 账号，
  "谁能说上话谁就是 op"这条链在服务端侧是开着的；RCON 是绕过它、直接到控制台的那条更短的路。
  口令虽然不是 git 泄漏（文件已忽略），但明文落盘 + 与 `config/network.json` 的 bind=all 组合起来 =
  "局域网内任何人只要能读到那个文件/猜到口令就能接管服务端"。
suggested_fix: |
  **不碰真值**（PLAYBOOK §3 红线）。三件事分开做：
  ① 让 RCON 只绑本机：`server.properties` 里没有单独的 rcon 绑定项，正确做法是
     `server-ip=127.0.0.1` **但**那会同时把 25565 也绑本机 → 与"局域网要连"冲突。
     所以推荐做法是：在 `tools/server-net.mjs apply` 里加一条 —— `bind: all` 时同时写
     `enable-rcon=false`（RCON 只在 `bind: localhost` 的测试服开）；这样"开 RCON"与"开局域网"不再同时成立。
  ② `config/network.json` 里给 `main` 加显式字段 `"rcon": false`，让"要开就显式开"成为默认。
  ③ 口令轮换提醒写进 `docs/audit/night/NIGHT-REPORT.md` 给用户看：本文件曾以明文存在，
     若这台机器曾把 `server/` 目录整份拷给别人（`backups/preinstall-*` 有 49MB 快照），应按"已泄漏"处理并轮换。
  **不要**把真口令改成占位符后提交（会造成"看起来已修"的假象，且违反红线）。
verify: |
  grep -nE "^(enable-rcon|rcon.port|server-ip)=" server/server.properties
  # 期望（改后）：bind=all 的场景下 enable-rcon=false；或 rcon 绑定仅本机
  node -e "const fs=require('fs');const p='server/server.properties';const s=fs.readFileSync(p,'utf8');const m=/enable-rcon=(\w+)/.exec(s);console.log('enable-rcon=',m&&m[1]);"
  # 冒烟：从另一台机器 `nc -vz <ip> 25575` 期望 connection refused
discovered_by: patch-smith(from history)
dept: D2-SEC

---
resolution: superseded-by-F-SEC-202（patch-smith · D2 修补）
说明: 本条（RCON 开启 + 绑全网卡 + 口令明文）与 recon 的 `F-SEC-202` 是同一件事，202 的证据更强
  （有运行期实证 `RCON running on 0.0.0.0:25575`）。处置以 202 为准：**不动 server.properties，
  由用户在管理员权限下加防火墙入站规则拦 25575**（见 docs/audit/night/manual-F-SEC-202-rcon-firewall.md）。
本条的增量已单独落地: `broadcast-rcon-to-ops` 改为 false（见 `F-SEC-209`）。

---

## 台账更正（gate-keeper · R3-7 · 2026-11-06 10:4x）—— **本条从 `verified/` 移回 `inbox/`**

### 为什么移回
本文件是 YAML front-matter 格式、**没有 `## review` 段**。按 `COMMIT-MAP.md:60` 自己的口径，
"有 `## review` 才算复核通过" ⇒ **本条从未复核通过，不应留在 `verified/`**。
终审 R3 §2/§3-① 指出这一点，我核对属实。**这是我整晚台账的一处失实，不是本条的结论有问题。**

### 本条的实际状态
- `resolution: superseded-by-F-SEC-202`（RCON 明文 + `bind all` 的同一缺陷）
- **但 `F-SEC-202` 本身是 `blocked`**（需管理员执行防火墙规则 / 或用户选择收回监听，属用户动作）
  ⇒ "被 202 取代" **不等于"已解决"**。RCON 现在**仍然监在 `0.0.0.0:25575`**（我 D2 复核时实测过，
  且 `server-ip` 仍为空）。
- ⇒ **本条应回到 `inbox/` 作为待办**（真正关闭要等 202 的用户动作完成）。

### 别名注记
`F-SEC-101`（RCON 明文+bind all）与 `F-SEC-202` 同源；`F-SEC-202` 在 `verified/` 里是 `blocked` 状态，
其关闭条件写在 `manual-F-SEC-202-rcon-firewall.md`（需跨机验证 25575 不可达 + 本机 loopback 仍通）。
