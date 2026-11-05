# manifest · D2 密钥与配置部（patch-smith · t7）

> 分工（沿用 captain 裁决 A）：我改**文件内容**；**git 提交 / 删除 / 跑 gate** 由 captain 执行。
> 铁律自查：**没有修改任何真实密钥、token、密码的值**（`rcon.password` / `keys.json` / API key 全部未动）。
>
> 工作区改动（`git status --porcelain`，已滤掉队列流转产生的 docs 条目）：
> ```
> mindcraft:  M .gitignore            ← F-SEC-206
>             M src/mindcraft/mindserver.js  ← F-SEC-205 + F-SEC-104
>             M tools/server-net.mjs         ← F-SEC-208（纯注释）
> 外层仓:     M .gitignore            ← F-SEC-206
>             M config/network.json    ← F-SEC-208（1 行文案）+ F-SEC-204（_剩余风险）
> 不可见:     server/server.properties ← F-SEC-209（被 .gitignore:74 排除，**进不了 git**，见 §6）
> ```

## 0. 报表

| 结局 | 条目 |
|---|---|
| **落地 5 条**（等提交） | `F-SEC-206`、`F-SEC-208`、`F-SEC-205`、`F-SEC-209`、`F-SEC-104` |
| **blocked 5 条** | `F-SEC-201`（需用户 setx+轮换）、`F-SEC-202`（需管理员防火墙）、`F-SEC-203`（backups 只读+破坏性）、`F-SEC-204`（需用户拍板三选一）、`F-SEC-207`（server/ 只读+需选 A/B） |
| **deferred 3 条** | `F-SEC-102`（19 适配器机械改）、`F-SEC-103`（改面板契约需回归）、`F-SEC-105`（配置契约变更） |
| **superseded 1 条** | `F-SEC-101`（与 202 同一件事，以 202 为准） |

`inbox/` 的 SEC 条目已清空（10 条 mv 到 done/，4 条 mv 到 claimed/）。

---

## 1. `F-SEC-206` — 两仓 .gitignore 通用凭据兜底  [ready-for-commit]

**改动文件**：`mindcraft/.gitignore`（追加 14 行）、`.gitignore`（外层仓，追加 17 行）
**需代为删除**：无

**commit message 草稿**
```
fix(sec): 两仓 .gitignore 增加通用凭据兜底 — F-SEC-206

两个仓的 .gitignore 都只有零散具名条目，实测 .env / .env.local / secrets.json /
credentials.json / id_rsa / config.local.js 全部**不被忽略**。而 F-SEC-201 的修法是
"把密钥搬到环境变量"，标准落地形态就是 .env* ⇒ 按旧规则，搬家当天就会写出一个能被
`git add .` 直接提交的明文密钥文件（修 A 洞时打开 B 洞）。

本段是兜底：.env / .env.* / *.pem / *.key / *.pfx / *.p12 / id_rsa* / id_ed25519* /
*credentials*.json / *secrets*.json / .mindserver-token，并保留 `!.env.example` 例外。
`keys.json` 在 mindcraft 仓已由第 9 行覆盖，未重复添加。

为什么安全：纯追加 ignore 规则，不改任何现有规则；实测两仓**没有**任何已跟踪文件命中新规则。
怎么验证：见 manifest §1 自检。
```
**自检（已做）**
- 外层仓：`.env .env.local .env.production secrets.json credentials.json id_rsa .mindserver-token foo.pem bar.key x.p12` → **10/10 OK**
- mindcraft 仓：`.env .env.local secrets.json credentials.json id_rsa .mindserver-token` → **6/6 OK**
- 例外：两仓 `.env.example` 均 **可入库**（未被忽略）
- 未误伤：`keys.json` 仍被忽略；两仓 `git ls-files` 命中新规则的文件数 **0**
**风险与回滚**：风险=若将来真要提交某个 `.env.example` 之外的 `*.key` 示例文件会被挡（用 `git add -f` 或加 `!` 例外即可）。回滚：revert 两处追加段。

---

## 2. `F-SEC-208` — 删掉"白名单=安全边界"的错误论断  [ready-for-commit]

**改动文件**：`mindcraft/tools/server-net.mjs`（**只改注释**，第 10-13 行替换为 9 行更正文案）；`config/network.json`（第 5 行文案更正）
**需代为删除**：无
**commit message 草稿**
```
docs(sec): 纠正"白名单=安全边界"的错误论断 — F-SEC-208

tools/server-net.mjs 头部原写"开了 white-list 之后只有名单里的人能进 —— 冒用名字就没用了"，
并据此得出"绑所有网卡+白名单 是安全且可用的"。这句在**多名字白名单**下成立，在
**单名字白名单**（本机 main.players 只有 HEAVENZEH，且 profile 的 owner 也是这个名字）下**不成立**：
白名单校验的是名字，冒用那唯一一个名字等于直接放行。

只改注释与一句说明文案，**零逻辑改动**（`desiredProps()` / `patchProperties()` 一个字节没动）。
纠正后的文案明确指出：可用 ≠ 安全，真正的边界只有"收回监听"或"加身份校验"。

为什么安全：git diff 里所有增删行都是注释行（已核，非注释改动 0 行）；`server-net.mjs show` 输出与改前逐字一致。
怎么验证：见 manifest §2 自检。
```
**自检（已做）**
- 旧论断 grep：`冒用名字就没用了` → 两文件 **0 命中**
- 新论断在位：`挡不住|不挡` → server-net.mjs 2 命中 / network.json 1 命中
- **只动注释**：`git diff -- tools/server-net.mjs | grep -vE '^[+-]{3}' | grep -vE '^[+-]\s*\*'` → **无输出**
- 工具行为不变：`node tools/server-net.mjs show` → 输出与改前一致（main: bind=all / whiteList=true / 目标=实际 ✓ 已一致）
- JSON 合法
**风险与回滚**：零运行时风险。回滚 revert 两个文件。

---

## 3. `F-SEC-205` — 握手 token 不再落盘到日志  [ready-for-commit · **行为变更**]

**改动文件**：`mindcraft/src/mindcraft/mindserver.js`（import 加 `writeFileSync`；token 生成后写入 `.mindserver-token`；三行 console.log 改为指纹+位置+开关）、`scripts/start-panel.ps1`（第 199 行起：读 token 文件拼出带 token 的面板地址）
**需代为删除**：无
**commit message 草稿**
```
fix(sec): 握手 token 不再无条件打印，改为本地文件 + 显式开关 — F-SEC-205

scripts/start-panel.ps1:189 把 mindcraft 的 stdout 重定向进 logs/mindcraft-console.log，
而 mindserver.js:493-495 无条件打印完整 token 三行 ⇒ 下次启动 token 就**落盘**在日志里，
而日志正是"出问题发给别人看"的东西（拿到它 = 能 send-message 指挥 bot / set-agent-settings / server-stop）。

改法：
① 默认只打印**指纹**（前4+后4+长度）+ token 的取用位置，不再打印完整值；
② 完整值写入 cwd 下 `.mindserver-token`（mode 0600，已由 F-SEC-206 加入 .gitignore），写失败也不阻断启动；
③ 需要肉眼看到完整值时显式 `MINDSERVER_PRINT_TOKEN=1`（调试用，会进日志，文档已标注）；
④ start-panel.ps1 改为从 `.mindserver-token` 读取并打开 `?token=…` 的面板地址。
   ⇒ **顺带修了一个既有缺口**：原来打开的是干净的 /console（无 ?token=），
      socket 握手会被 io.use(makeHandshakeGate) 拒掉，面板其实连不上。

行为变更（captain 要求单列）：见 §7.1。
怎么验证：见 manifest §3 自检（静态 3 条 + 动态 1 条留给 captain）。
```
**自检（已做）**
- `node --check src/mindcraft/mindserver.js` → **SYNTAX_OK**
- 无条件打印已消失：`握手 token: ${handshakeToken}` → **0 命中**（唯一残留的 `?token=${handshakeToken}` 在 `MINDSERVER_PRINT_TOKEN==='1'` 分支内，行 516）
- 新通道在位：`tokenHint` / `TOKEN_FILE` / `MINDSERVER_PRINT_TOKEN` 共 10 处命中
- 写文件失败时降级（try/catch + warn），不会因只读 cwd 起不来
**未做（需 captain，动态）**：真起一次 mindserver，确认
① `logs/mindcraft-console.log` 里 `grep -c "token=[A-Za-z0-9-]\{8,\}"` → 0；② 面板能连上（带 ?token= 打开后 socket 不报 AUTH_REQUIRED）。
**风险与回滚**
- 风险：start-panel 若读不到 `.mindserver-token`（例如用户的 mindserver 是由别的脚本起的、cwd 不同），面板地址就不带 token → 需手动 `?token=`。已加 WARN 提示。
- 回滚：revert 两个文件。**注意**：`.mindserver-token` 是运行期产物，回滚后仍可能残留，删掉即可（已 gitignore）。

---

## 4. `F-SEC-209` — `broadcast-rcon-to-ops` 关掉  [已改 · **但进不了 git**]

**改动**：`server/server.properties:7` `true` → `false`（**手改，没跑 `server-net.mjs apply`**，避免它把整个文件 CRLF 归一成 LF）
**自检**：`grep -nE "^broadcast-rcon-to-ops"` → `7:broadcast-rcon-to-ops=false`；
文件仍是 **CRLF**（64 行 / 64 个 CR 字节），改动只 +1 字节（true→false）；
`enable-rcon` / `rcon.port` / `rcon.password` / `server-ip` **逐条核对未动**。
**⚠️ 不可提交**：`server/server.properties` 被外层 `.gitignore:74` 排除（含明文 RCON 口令，刻意不入库）
⇒ **这条修改没有任何版本历史、不可回滚，换机器重建 server.properties 就会回到 true**。
建议：在暴露面清单（与 F-SEC-202 手册同一节）记一句"broadcast-rcon-to-ops 必须 false"，否则会静默回退。
**生效**：需重启服务器（或服务端重读配置）。

---

## 5. `F-SEC-104` — 贴图代理路径穿越  [ready-for-commit]

**改动文件**：`mindcraft/src/mindcraft/mindserver.js`（贴图路由在 `toLowerCase()` 之后加白名单断言，+9 行）
**commit message 草稿**
```
fix(sec): 贴图代理对资源名做白名单校验，堵路径穿越 — F-SEC-104

/assets/item/:agent/:name.png 的 :name 经 Express decodeURIComponent 后可以是
`..%2f..%2fsettings` ⇒ path.join(base,'items','../../settings.png') 跳出 assets.directory。
该端点是**不需要认证的 HTTP 路由**（io.use 的握手门只管 socket.io，app.use 那层只 Set-Cookie 不拒绝）。

修：itemName 只允许 /^[a-z0-9_]{1,64}$/（物品/方块名的真实字符集），非法直接 400。
为什么安全：资源名本就是 [a-z0-9_]+，白名单不会误伤正常贴图；正则里没有 `.`/`/`，穿越不可能成立。
怎么验证：见 manifest §5 自检。
```
**自检（已做）**：`node --check` → SYNTAX_OK；守卫在位（`invalid texture name`，行 172）；
正则单测：5 个非法名（`..%2f..%2fsettings.part1` / `../settings` / `a/b` / 65 字符 / 空）**全拒**，
4 个合法名（`stone` / `oak_log` / `grass_block` / `iron_pickaxe`）**全放行**。
**未做**：HTTP 实测 `curl ".../..%2f..%2fsettings.png"` → 期望 400（需起服务，归 captain）。
**风险与回滚**：风险=若某些贴图名含大写/连字符会被 400（已 `toLowerCase()`，且实测样本均为小写+下划线）。回滚 revert 该 hunk。

---

## 6. ⚠️ 一条必须进早报的事实：`server.properties` 被 gitignore

与 D1 的 `F-DEP-103`（`mindcraft/package-lock.json` 被忽略）同一类问题：
**`.gitignore:74` 排除了 `server/server.properties`**，所以：

- `F-SEC-209` 的修复**进不了 git**（`git diff` 里看不到，captain 提交时也不会包含）；
- 该文件的任何配置修复都**没有版本历史、不可回滚**；
- 重建服务器时它会重新生成，`broadcast-rcon-to-ops` 会回到 `true`、`server-ip` 回到空。

**建议（不擅自做）**：`server.properties` 含明文 RCON 口令，不入库是**合理的**；但应当：
① 入库一份 `server.properties.example`（本仓已有！`server/server.properties.example`，其 `rcon.password=CHANGE_ME`）——
   **把本轮的安全相关取值（`broadcast-rcon-to-ops=false`）写进 example**，这样重建时有正确模板；
② 在 README/暴露面清单里写明"实际 server.properties 需覆盖哪些键"。
⇒ 我建议把 `broadcast-rcon-to-ops=false` 同步进 `server.properties.example`（**这是可入库的**）。
**本轮未做**：等 captain 决定是否要我改 example（一行，改了我可以顺手做）。

---

## 7. 行为变更登记（captain 要求单列）

### 7.1 `F-SEC-205`：握手 token 的获取方式变了
- **谁还能看到完整 token**：只有本机用户 —— 读 `mindcraft/.mindserver-token`（0600），
  或自己设 `MINDSERVER_TOKEN`，或显式 `MINDSERVER_PRINT_TOKEN=1`（会把完整值打进日志，调试完请关）。
- **谁的日常操作受影响**：
  - 用 `启动面板.bat` 的人：**体验不变更好**（脚本自动带 token 打开面板；以前打开的是无 token 的 /console，其实连不上）。
  - 用 `start.bat`（新开控制台窗口）的人：以前在本窗口直接看到 token 复制，现在要打开 `.mindserver-token`
    或看日志里的"完整 token 位置"提示 —— **多一步**，这是有意的安全收紧。
  - 本机脚本/探针：不受影响（仍走 `MINDSERVER_TOKEN` 环境变量）。
- **有没有测试依赖旧行为**：`tools/mindserver_gate_unit.mjs` 有断言依赖 `MINDSERVER_TOKEN` 字样
  （我核到 probes 目录里的历史副本有 `at('MINDSERVER_TOKEN') > 0` 断言，**但断言的是源码里存在该 token 字符串**，
   我保留了三处 `MINDSERVER_TOKEN` 字样 ⇒ 该断言仍成立）。**未跑**该单测（本会话 spawn EPERM），
  请 captain 在 gate:full 里确认；若它红，改断言而不是改行为。

### 7.2 `F-SEC-209`：RCON 命令不再广播给 op
- 影响：op 聊天里**不再回显** RCON 执行的命令。若你依赖"在游戏里看运维动作"，这条要回调成 true（并接受 F-SEC-209 的信息面风险）。

### 7.3 `F-SEC-104`：贴图名非法直接 400
- 影响：任何非 `[a-z0-9_]` 的资源名从"回落到默认 svg/500"变为"400"。正常物品/方块名不受影响。

---

## 8. 给 gate-keeper 的对接点

1. **`F-SEC-205` 的动态验证归 captain**（起服务看日志无 token）；静态侧我给了 4 条可复跑断言。
2. `F-SEC-102/103/105` 是**本轮顺延**，不是"已修"——请不要在复核时把它们算作遗漏，理由已写进各单的 `resolution: deferred`。
3. `F-SEC-201/202/203/204/207` 全部需要**用户动作**（setx / 管理员防火墙 / 备份处置 / 三选一 / A-B 选择）。
   两份手册已就位：`manual-F-SEC-201-keys-rotation.md`（我写，含三步不可颠倒的论证与"轮换提醒"）、
   `manual-F-SEC-202-rcon-firewall.md`（你起草，我未重写）。
4. **本轮我犯过一次错并已纠正**，如实记录：改 `config/network.json` 时把英文双引号直接写进 JSON 字符串导致文件非法，
   `node -e JSON.parse` 立刻报错，我用全角引号修正并复验 `JSON_OK`。教训：**改 JSON 文案必须用全角引号或转义**。
   建议你在复核时对 `config/network.json` 再跑一次 `node -e "JSON.parse(...)"`（我已跑过，绿）。
