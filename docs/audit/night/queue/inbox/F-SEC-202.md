id: F-SEC-202
severity: high
class: config
file: server/server.properties:44
evidence: |
  RCON 开着，而且**监听所有网卡**：

  $ cd "E:/我的世界ai/server" && grep -nE "enable-rcon|rcon\.port|rcon\.password|server-ip" server.properties
  44:enable-rcon=true
  46:rcon.password=<32 位随机串，本文不抄录>
  47:rcon.port=25575
  54:server-ip=                      ← 空 = 绑所有网卡

  运行时实证（Paper 启动日志，不是推断）：
  $ grep -nE "RCON" ../logs/server-console.log
  151:[19:23:18 INFO]: Thread RCON Listener started
  152:[19:23:18 INFO]: RCON running on **0.0.0.0:25575**
  178:[01:40:50 INFO]: Thread RCON Client /127.0.0.1 started

  并且这是**有意的**配置，不是遗留：`config/network.json`（入库）主服段写死了
  `"bind": "all"`；本该"绑 all 但只让本机 console 用"的假设并不成立 —— RCON 跟 server-ip 走，
  server-ip 空 ⇒ RCON 也在 0.0.0.0。
  $ grep -n '"bind"' config/network.json
  main → "bind": "all"    test → "bind": "localhost"
  另：`broadcast-rcon-to-ops=true`（第 7 行）会把 RCON 命令回显到 op 玩家聊天里。
exploitability: |
  RCON 协议 **明文、无 TLS、无速率限制**（Minecraft 官方协议固有）。前置条件只有一条：
  能连到 25575。当前 server 绑 0.0.0.0，所以同局域网（Wi-Fi 咖啡厅、宿舍、公司内网）即可连。
  能拿到什么：
  - 口令被嗅探/暴力破解（32 位强口令本身够强，但**离线模式的服务器通常没有其它防线**，
    而这条口令以明文存在 5 份文件里 —— 见 F-SEC-203，任何拿到备份的人直接通关）；
  - 一旦进 RCON：`op <我>`、`deop HEAVENZEH`、`stop`、`setblock`/`fill`（拆服）、
    `whitelist off`（配合离线模式 = 任何人可进）、读取/篡改世界 —— 即**服务器完全接管**，
    且不进玩家列表、不留 join 记录，只留 RCON 连接行（本仓日志里就是 `/127.0.0.1` 那种行）。
  影响半径：整个 MC 服务器 + 所有 bot（341 个 op 账号，见 F-SEC-204）。
  与 F-SEC-204 叠加：白名单只挡游戏端口，挡不住 25575。
suggested_fix: |
  按"最小改动、不动玩法"的顺序（patch-smith 只改配置，不改口令值）：
  1. `server/server.properties` 第 54 行：`server-ip=127.0.0.1`。
     —— 这一行同时把游戏端口和 RCON 收到本机。若用户要局域网/手机连游戏，
     那就在 `config/network.json` 里把 main 的 bind 保持 all 的同时**单独**把 RCON 关掉或改端口策略
     （见第 3 条），不要用"server-ip 空"这种一刀切。
  2. 若必须保留局域网玩：`enable-rcon=false`（本仓唯一的 RCON 消费者是
     `mindcraft/src/agent/library/rcon_client.js`，读的是同一台本机 server，
     `resolveRconCreds` 走 127.0.0.1；关掉对外绑定后它照样能用 loopback）。
     实现方式：把 `server-ip=127.0.0.1` 写进 `config/network.json` 的 apply 逻辑
     （`node tools/server-net.mjs apply`），让配置有单一真相源，别手工改两份。
  3. 兜底（若用户坚持 RCON 对外）：把 rcon.port 换成非默认值 + 在 Windows 防火墙
     只放行 25565/tcp，不放行 25575/tcp。写进 README 的部署段。
  4. **不要改 rcon.password 的值**（红线）；只在 finding 里提醒用户那串已在多处副本留存（F-SEC-203）。
verify: |
  # 1) RCON 不再对外监听（关键判据）
  netstat -ano | findstr ":25575"
  # 期望：只出现 127.0.0.1:25575（LISTENING），不出现 0.0.0.0:25575
  # 2) 启动日志不再出现 0.0.0.0
  #    重启服务器后： grep -n "RCON running on" logs/server-console.log | tail -1
  #    期望 "RCON running on 127.0.0.1:25575"
  # 3) bot 的 RCON 功能没被改坏（本机 loopback 仍可用）
  cd mindcraft && node -e "
    import('./src/agent/library/rcon_client.js').then(async m=>{
      const c=m.rcon; try{ console.log(await c('list')) }catch(e){ console.log('ERR', e.message) } })"
  # 期望能返回玩家列表（说明 loopback 通路还在）
  # 4) 配置单一真相源没被绕过
  cd "E:/我的世界ai" && node -e "const n=require('./config/network.json'); console.log(n.servers.main.bind)"
discovered_by: recon-scout
dept: D2-SEC
