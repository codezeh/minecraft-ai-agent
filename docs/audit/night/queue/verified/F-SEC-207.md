id: F-SEC-207
severity: medium
class: config
file: server/plugins/BlueMap/webserver.conf:18
evidence: |
  BlueMap 的内置 Web 服务开着、绑在所有网卡、**无任何鉴权**，而且此刻就在跑：

  $ netstat -ano | grep ":8100"
  TCP    0.0.0.0:8100      0.0.0.0:0       LISTENING       29548
  TCP    [::]:8100         [::]:0          LISTENING       29548

  $ grep -nE "^[a-z]+:" server/plugins/BlueMap/webserver.conf
  9:enabled: true        ← 服务开着
  14:webroot: "bluemap/web"
  18:port: 8100
  21:log: { ... }        ← 整个配置里**没有** ip/bind 键 ⇒ 跟 JVM 一样绑所有网卡
  $ grep -nE "^accept-download|^data:|^metrics" server/plugins/BlueMap/core.conf
  12:accept-download: true
  17:data: "bluemap"
  41:metrics: true

  $ ls server/bluemap/
  logs/  minecraft-client-1.21.8.jar  pluginState.json   ← 已实际初始化并渲染过

  即：`http://<本机局域网 IP>:8100` 任何人都能打开已渲染的**世界地图**，无需口令。
  与 F-SEC-202 同源（`config/network.json` main 段 `"bind": "all"` 是有意要局域网可达的），
  但用户在做这个决定时想的是"手机能连服务器"，**大概率没意识到还顺带开了 8100 地图站**。
exploitability: |
  无需任何前置凭据。同局域网（或任何能路由到该机 8100 的网络）即可访问，只发 HTTP GET。
  能拿到什么：
  - 全服地形/建筑/红石布局的俯视图 —— 直接暴露基地位置、箱子房、矿道；
  - BlueMap 的前端会显示**在线玩家标记**（默认开启），等于实时位置跟踪；
  - `metrics: true` + `accept-download: true` 表示插件还会向外取数据/发统计，但那条不是本条重点。
  拿不到什么：不能通过它写世界、不能执行命令（它只读静态渲染数据）。
  影响半径：信息泄露（基地位置/玩家位置）→ 现实成本很低的重建/偷家前置侦察。
  诚实定级：不涉及凭据、不涉及代码执行，是"把自己家地图挂在局域网"级别的暴露，故 medium 而非 high。
suggested_fix: |
  二选一，都是配置改动，不涉及玩法（patch-smith 可做，但要先问用户选哪条）：
  A) 关掉内置 webserver，改由本机/局域网内按需启动：
     `server/plugins/BlueMap/webserver.conf:9` → `enabled: false`
     （地图数据仍会渲染在 `server/bluemap/web`，需要时用任意静态服务器临时起，或直接看文件。）
  B) 保留但不能随便访问：把 BlueMap 前置到只监听回环 —— 该版本 webserver.conf 没有 ip 键，
     所以要用**启动参数**：在启动脚本里给 JVM 加
     `-Dbluemap.webserver.ip=127.0.0.1`（BlueMap 支持系统属性覆盖），
     或退一步在 Windows 防火墙只放行 25565（放行游戏），**不放行 8100**。
  并写进 README 的"暴露面清单"，与 F-SEC-202 的 25575 放在同一节，避免下次又漏一个端口。
verify: |
  # 1) 8100 不再对外监听（关键判据）
  netstat -ano | grep ":8100"
  # A 方案期望：无输出；B 方案期望：只有 127.0.0.1:8100
  # 2) 地图功能本身没被改坏（数据仍在渲染）
  ls -la "E:/我的世界ai/server/bluemap/web" 2>/dev/null | head -3
  # 3) 服务端仍能正常启动、BlueMap 不报错
  grep -nE "BlueMap|Error|Exception" "E:/我的世界ai/server/logs/latest.log" | tail -5
  # 4) 暴露面清单已写进 README（防复发）
  grep -niE "8100|bluemap" "E:/我的世界ai/files/README.md" "E:/我的世界ai/文件/README.md" 2>/dev/null | head -3
discovered_by: recon-scout
dept: D2-SEC

---
resolution: blocked（配置在 server/ 下、本会话只读；且需用户在 A/B 间选；patch-smith · D2 修补）
blocked: |
  `server/plugins/BlueMap/webserver.conf` 位于 `server/`，我的会话对 `server/` 只读（bash/node/git 均被拒）。
  且两条修法都要用户定：
  A) `webserver.conf:9` 改 `enabled: false`（关掉内置 web 服务，地图数据仍渲染在 server/bluemap/web）；
  B) 保留服务但只监听回环：该版本无 ip 键，需启动参数 `-Dbluemap.webserver.ip=127.0.0.1`，
     或用 Windows 防火墙不放行 8100（与 F-SEC-202 的 25575 同一条规则族，可一并做）。
  建议与 F-SEC-202 合并成"暴露面清单"一次性交用户（25575 RCON + 8100 BlueMap 两个端口）。

## review（gate-keeper · t14 · 2026-11-06 02:4x）
**结论：通过（blocked 成立）。** commit：无（server/ 只读，需用户选 A/B）。

核证：
- 8100 目前**仍在监听**（`netstat` 命中 2 条：`0.0.0.0:8100` 与 `[::]:8100`）⇒ **漏洞仍真实存在**，未被掩盖。
- 配置在 `server/plugins/BlueMap/...`，本会话对 `server/` 只读 ⇒ blocked 理由成立。
- 未提供"假修复"（没有把配置改一半或改成无效值）✅
裁定：**通过**（阻塞项如实）。A（关掉 webserver）/B（防火墙拦 8100）需用户选。
