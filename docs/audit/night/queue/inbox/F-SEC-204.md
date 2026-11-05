id: F-SEC-204
severity: medium
class: authz
file: config/network.json:12
evidence: |
  主服是"离线模式 + 只绑名字白名单"的组合，而白名单只有 1 个名字、op 名单里有 341 个 bot。

  $ cd "E:/我的世界ai" && node -e "
      const n=require('./config/network.json');
      console.log(JSON.stringify(n.servers.main,null,1));"
  { "bind": "all", "whiteList": true, "enforceWhiteList": true,
    "onlineMode": false, "players": ["HEAVENZEH"] }

  $ grep -nE "online-mode|white-list|enforce-whitelist|server-ip" server/server.properties
  38:online-mode=false
  54:server-ip=                     ← 绑所有网卡
  64:white-list=true
  17:enforce-whitelist=true

  $ node -e "const ops=require('./server/ops.json'); const wl=require('./server/whitelist.json');
      console.log('ops:',ops.length,'| whitelist:',wl.length,'| 真实玩家是 op?',ops.some(o=>o.name==='HEAVENZEH'));"
  ops: 341 | whitelist: 1 | 真实玩家是 op? false
  ops 前 3 条: v57665(lvl4), tgt2207(lvl4), s2bench914(lvl4)   ← 全是测试脚本刷出来的 bot

  两个文件都被 git 跟踪（公开仓会看到清单）：
  $ git ls-files server/ | grep -E "ops.json|whitelist.json"
  server/ops.json
  server/whitelist.json
exploitability: |
  离线模式（online-mode=false）下 Minecraft **不做正版校验**，服务端只认客户端自己报的名字
  ⇒ 任何人把客户端用户名改成 `HEAVENZEH` 就能以主人身份进服（白名单只校验名字，不校验密码）。
  能拿到什么：主人身份 ⇒ 私聊/指令权限/位置信息/能指挥 bot（权限模型里 owner 级 = 最高）；
  以及"主人"看到的、bot 记得的一切。
  另一条更远的：`ops.json` 里 341 个 lvl4 op 账号存在但**没进白名单**，所以现在登不进来；
  一旦 `whiteList` 被关（`config/network.json` 的 test 段默认就是 `whiteList:false`，
  切换 main→test 的配置只要改一个字），这 341 个名字全部变成可登录的 **op 账号** —— 等于后门池。
  且 `ops.json` 入库意味着任何能看仓库的人拿到全部 bot 名清单（用户名即凭据，离线模式下尤其致命）。
  影响半径：主人身份 / 服务器管理权。前置条件是能连到 25565（bind=all 时同网段即可）。
  诚实说明：这是用户在 `config/network.json` 里**明确权衡过的**设置（文件里写着理由：
  "绑所有网卡方便，离线模式下任何人都能冒用 op 名字进服"）。所以本条不是"配置写错了"，
  而是"风险被写下来了但仍没有任何缓解手段"——需要用户拍板。
suggested_fix: |
  先明确：**这需要用户拍板**（改 online-mode 会影响"手机/局域网随便连"的便利性）。
  patch-smith 能做、且不改变玩法的部分：
  1. 在 `config/network.json` 的 main 段加显式告警字段（纯注释式，不改变行为）：
     `"_剩余风险": "离线模式 + 白名单按名字 ⇒ 冒用 HEAVENZEH 即可接管主人身份。缓解见 docs/audit/night/..."`，
     让下一次改配置的人看得见。
  2. `ops.json` 收敛：把 341 个测试 bot 的 op 清成 0 级或移出 ops.json（**这是运行时状态文件、
     不在本夜红线里但没有测试基准，建议只做备份 + 提醒用户**，不要擅自改）；
     同时把 `server/ops.json`、`server/whitelist.json` 从 git 跟踪里移除（`git rm --cached`），
     改成 `server/*.json.example` + .gitignore —— 它们是运行期状态，不是配置源码。
  3. 真正的修法（需用户同意，且属"改身份体系"）：
     a. 想保持便利 → 用 **AuthMe/类似登录插件**（离线模式 + 密码登录）—— 新增插件，本夜红线不允许；
     b. 或 `online-mode=true`（正版校验）—— 但 bot 全部要真账号，不现实；
     c. 或维持现状但把 bind 收回 `127.0.0.1`，只在需要局域网联机时临时切（`tools/server-net.mjs`）。
  4. `mindcraft/settings.js` 里 `"auth": "offline"` 与服务器一致，无需改。
verify: |
  cd "E:/我的世界ai"
  # 1) 运行期状态文件不再被 git 跟踪
  git ls-files server/ | grep -E "ops.json|whitelist.json"; echo "exit=$?"
  # 期望：无输出（已被 .gitignore + git rm --cached 移出）
  # 2) 冒用名字仍然会被挡（这是"白名单仍生效"的正向对照，不是要求改行为）
  #    人工：用非白名单名字连服 → 应被踢；用 HEAVENZEH 连 → 能进（说明风险仍在，需用户决策）
  # 3) 配置里留下了显式告警
  node -e "const n=require('./config/network.json');
    const ok = JSON.stringify(n.servers.main).includes('冒用');
    console.log(ok?'OK 已标注剩余风险':'FAIL 未标注'); process.exit(ok?0:1)"
discovered_by: recon-scout
dept: D2-SEC
