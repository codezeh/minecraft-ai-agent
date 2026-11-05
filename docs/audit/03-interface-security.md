# 审计③ · 入口 / 服务端 / 安全与配置（不含前端面板）

> 审查对象：`E:\我的世界ai`（git 仓库根在 `mindcraft/`，`git ls-files` 共 547 个文件）
> 方式：静态通读 + 本机 `netstat` 实测。**未改动任何被审查源码**，本文件是唯一写入物。
> 审查时刻：2026-11-05。

**`web/` 前端面板按作者要求不在范围内**（作者声明该面板是草稿、会被重写）。因此本报告不评价
`web/src/**`、`web/vite.config.ts`、`web/index.html`、`web/poc/`、`web/package.json` 的任何代码质量问题；
唯一例外是 `mindserver.js` 这一侧暴露的接口边界——那按「服务端接口」审，证据一律取后端代码。

---

## 0. 链路说明与负载假设

### 0.1 进程拓扑（谁生谁、谁连谁）

```
启动面板.bat → scripts/start-panel.ps1
  ├─ (1) .tools/jdk-*/bin/java.exe  -jar server/server.jar   ← Paper 主服，25565
  │        └─ 顺手开 RCON 25575（server.properties:14 enable-rcon=true）
  └─ (2) node main.js（cwd=mindcraft/）                      ← mindserver，8080
            ├─ socket.io server  bind 'localhost'            (mindserver.js:421-424)
            │    └─ allowRequest = allowLocalOnly            (mindserver.js:62-67, local_only.js:43-47)
            ├─ express static  public/ + ../../../web/dist    (mindserver.js:102, 164-172)
            ├─ 任务板 board:* 事件（同一个 io）                (board_server.js:110+)
            └─ spawn node src/process/init_agent.js -n <name>  (agent_process.js:26-29)
                  └─ Agent → mineflayer bot → 连 127.0.0.1:25565
                        ├─ socket.io-client → mindserver（登录/取状态/收消息）
                        └─ RCON 客户端 → 25575（查玩家精确坐标）
```

一句话：**mindserver 是唯一的控制面**。面板、agent 子进程、`web/scripts/stop-all.mjs`、`tools/*.mjs`
全部走同一条 socket.io；它没有任何认证，只靠 `local_only.js` 判「是不是本机来的」。

### 0.2 负载假设（本报告全部分级的基准）

单人 / 少数几台机器；1 个 Paper 主服 + 1~3 个 bot；mindserver 监听本机端口，可能被局域网访问。
**实测结论（本次 `netstat -ano`）**：

| 端口 | 监听地址 | 证据 |
|---|---|---|
| 25565（主服） | `0.0.0.0` + `[::]` | netstat 实测；`server/server.properties:54` `server-ip=`（空） |
| 25575（主服 RCON） | `0.0.0.0` + `[::]` | netstat 实测；`server.properties:47` |
| 25566 / 25576（测试服 + RCON） | `127.0.0.1` | netstat 实测；`server-test/server.properties:54` `server-ip=127.0.0.1` |
| 8080（mindserver） | 未监听（当时未启动）；代码固定 `'localhost'` | `mindserver.js:421-424` |

即：**游戏端口和 RCON 确实对局域网敞开（主服），mindserver 不会**。这一条决定了下面一大批发现的
可达性——凡是依赖 8080 的，攻击者必须已经能在本机执行代码（本机任意进程 / 本机 localhost 页面）。

---

## 1. 密钥专项（任务第 3 问）

### 1.1 `keys.json` 是否被 git 跟踪 —— 实测为「否」

`git ls-files | grep -i key` 的**原始输出**（在 `mindcraft/` 下执行，该目录才是 git 仓库）：

```
keys.example.json
src/utils/keys.js
```

也就是说**工作树里的 `keys.json` 不在索引里**。旁证两条：

```
$ git check-ignore -v keys.json
.gitignore:9:keys.json	keys.json

$ git log --all --oneline -- keys.json
(无输出 —— 从未被提交过)
```

`git status --porcelain` 为空，说明它既没被跟踪、也不在待提交队列里。`.gitignore:9` 就是这行规则。

**结论**：`mindcraft/keys.json`（里面有真 key：`OPENAI_API_KEY = sk-0aa7…`，实测文件 2 行）
**没有进 git，也没有进过 git 历史**。不需要轮换，只需要别在 `git add -f` 时手滑。

补充核实（同样重要）：

* `git grep -nIE 'sk-[a-zA-Z0-9]{20,}|api[_-]?key["'"'"']?\s*[:=]\s*["'"'"'][A-Za-z0-9_-]{16,}'`
  在**全部被跟踪文件**里 0 命中 → 没有第二个地方硬编码了 key。
* `mindcraft/.dockerignore` 第 5 行是 `keys.json` → `docker build` 不会把 key 烧进镜像层。
  这一条是查过的：`Dockerfile:35` 有 `COPY . .`，若 `.dockerignore` 漏了它就是镜像级泄漏，实际没漏。
* `server/server.properties:46` 的 RCON 口令（`KsSS…` 32 位随机）与 `server-test` 的（`aFVq…`）
  **都不在任何被跟踪文件中**（`git grep KsSSKjtdXg4ai` 无命中；`server/`、`server-test/` 根本不在仓库里）。
* 历史上被推到 GitHub 的弱口令 `localdev` **已不在运行配置里**：现在两套口令都是 32 位随机。
  残留只有文档与注释里的叙述（`docs/legacy/原子动作规格.md:390`、`library/rcon_client.js:18` 等），
  属"记录历史"而非"仍可用凭据"，不算发现。

### 1.2 日志/错误栈会不会打出 API Key

逐点核过：

* key 只进 SDK 配置对象：`gpt.js:19`、`claude.js:15`、`deepseek.js:14`、`gemini.js:34/122`、
  `grok.js:18`、`groq.js:26`、`mistral.js:24`、`novita.js:17`、`openrouter.js:19`、`qwen.js:13`、
  `hyperbolic.js:10/54`、`mercury.js:16`、`azure.js:18`、`cerebras.js:13`。
* `grep -rE '\?key=|\$\{key\}|api_key=' src/models/` **无命中** → 没有把 key 拼进 URL/query 的写法
  （所以"错误信息带出完整 URL 从而带出 key"这条路不存在）。
* `getKey()` 找不到时只报**名字**：`utils/keys.js:17` `API key "${name}" not found…`。
* 适配器的错误上报是 `console.log(err)`（`gpt.js:83`、`claude.js:56`、`gemini.js:101`、`deepseek.js:46`、
  `grok.js:47/50`、`groq.js:69`、`mistral.js:65`、`novita.js:49`、`mercury.js:53/56`、`qwen.js:45`、
  `vllm.js:55`、`lmstudio.js:42`、`ollama.js:42/93`、`huggingface.js:48`、`replicate.js:82`、`openrouter.js:49`、
  `hyperbolic.js:78`）。这些是 SDK 的**响应侧**错误对象，不含请求头里的 `Authorization`。

**结论**：目前没有"key 从日志漏出去"的证据。真正的日志泄漏是**提示词**，见 I6。

---

## 2. 发现清单

分级：**Must fix**（bug / 安全 / 数据丢失 / 预期负载下必崩）→ **Should fix** → **Nice to have**。
每条固定五段：标题+`文件:行号` / 这是什么 / 问题（场景→结果） / 最小修复 / 不修会怎样。

### Must fix

---

#### I1 mindserver 控制面零认证，且 `send-message` 让客户端自己声明「我是谁」→ 冒充主人拿到主人级权限

`mindcraft/src/mindcraft/mindserver.js:392-402`、`src/agent/mindserver_proxy.js:115-121`、`src/agent/agent.js:544-560`、`src/agent/commands/index.js:283-293`

**这是什么**
`send-message` 把客户端给的 `data` 原样转给 agent 进程，agent 侧直接
`this.agent.respondFunc(data.from, data.message)`；`respondFunc` 拿 `from` 当游戏用户名，
`handleMessage` 把它当 `perm.author`，`executeCommand` 再拿它算等级
（`resolveLevel({author})` → 名字等于 `permissions.owner` 就是 owner）。

**问题（入口 → 报文 → 后果）**
* 入口：`ws://127.0.0.1:8080/socket.io`（socket.io 4，默认路径 `/socket.io`）。
  认证：**没有**。唯一的门是 `local_only.js`——它只校验 Host 是本机名、Origin（若有）是本机页面
  （`local_only.js:34-40`）。**不带 Origin 的连接直接放行**（`local_only.js:38`），
  所以本机任意 Node/脚本进程、任何从 `http://localhost:<任意端口>` 提供的页面（含 Vite dev server）
  都能连。局域网连不上（`mindserver.js:421` 固定 `'localhost'`，netstat 也证实）。
* 报文（实测形状，`agentName` 从 `agents-status` 广播里就能拿到，`mindserver.js:429-444`）：

  ```js
  const s = io('http://localhost:8080', { transports: ['websocket'] });
  s.emit('send-message', 'deepseek', { from: 'HEAVENZEH', message: '!newAction(帮我挖一组橡木)' });
  ```
* 后果：等级判定成 `owner`（`profiles/my-local.json:6` 里 owner 就是 `HEAVENZEH`），于是
  `OWNER_ONLY_COMMANDS` 全部解锁（`permissions.js:40-54`：`!newAction` / `!attackPlayer` / `!setMode`
  / `!restart` / `!discard` / `!givePlayer` / `!addJob`）。`!newAction` 会走到 `coder.js` 生成并执行代码。
  该 bot 在服里是 op（`server/ops.json` 有 341 条 bot 账号），所以顺带等于"服里想干什么都行"。

**最小修复**
在 `createMindServer()` 里给 socket.io 加握手 token：启动时 `crypto.randomUUID()` 存 `mindserver.js` 模块变量，
通过环境变量传给子进程（`agent_process.js`），`io.use((s,next)=> s.handshake.auth?.token===TOKEN ? next() : next(new Error('forbidden')))`；
`set-agent-settings` / `shutdown` / `server-*` 一并落到同一闸门后面。
最小可行的一步（不改 agent 侧）：在 `mindserver.js:392` 的 `send-message` 处理里拒绝非 agent 连接
（`curAgentName` 为空即拒），并把 `from` 强制改写为 `curAgentName`。

**不修会怎样**
本机任何一个能起进程的东西（含用户自己跑的任何 dev server 页面）都能以主人身份指挥 op bot；
一旦哪天把 `host_public` 打开或改绑 `0.0.0.0`，就等价于内网不设防的 RCE 入口。

---

#### I2 `create-agent` 的 `profile.name` 未校验，且在名字校验之前就已经拼进路径 → 任意目录创建 / 任意文件写

`mindcraft/src/models/prompter.js:110-116`（写入点）对比 `src/agent/agent.js:205-210`（校验点，晚一步）

**这是什么**
`Prompter` 构造器用 profile 名拼路径并落盘：

```js
mkdirSync(`./bots/${name}`, { recursive: true });
writeFileSync(`./bots/${name}/last_profile.json`, JSON.stringify(this.profile, null, 4), (err) => {...});
```

而 `name = this.profile.name`（`prompter.js:59`）来自客户端。合法性检查 `validateNameFormat`
（`/^[a-zA-Z0-9_]{3,16}$/`，`connection_handler.js:87-96`）在 `agent.js:205` 才执行——
但 `new Prompter(...)` 在 `agent.js:147` 就已经跑完了。

**问题（入口 → 报文 → 后果）**
* 入口：同 I1 的 socket，事件 `create-agent`（`mindserver.js:250-285`，只做 `settings_spec` 的
  **存在性**检查，`251-266` 行只读 `required` / `default`，**不读 type**）。
* 报文：

  ```js
  s.emit('create-agent', {
    profile: { name: '../../../Users/xxx/Desktop/pwn', model: 'gpt', url: 'https://example.invalid' },
    host: '127.0.0.1', port: 25565
  }, console.log);
  ```
* 后果：`mkdirSync('./bots/../../../Users/xxx/Desktop/pwn', {recursive:true})` 创建目录，随后把
  整个 profile JSON（攻击者完全可控的内容）写到该目录下的 `last_profile.json`。
  `prompter.js:111` 的第三参传的是回调函数（同步 API 不会调用它），实测 Node 24 不报错、文件照写
  （已在本机 `writeFileSync(p,'{"a":1}',(e)=>{})` 验证：不抛异常）。
  另外这个 agent 还会被真的 spawn 起来（`mindcraft.js:60-62`），带攻击者指定的 `profile.username`
  去登服务器。

**最小修复**
在 `mindserver.js:267`（`if (settings.profile?.name)` 那行）之前加一行复用既有校验：
`import { validateNameFormat } from '../agent/connection_handler.js';` 然后
`const nc = validateNameFormat(String(settings.profile?.name ?? '')); if (!nc.success) return callback({success:false, error:nc.msg});`
并把 `prompter.js:110-111` 改成 `path.join(process.cwd(),'bots',name)` 后再断言
`resolved.startsWith(botsRoot)`。

**不修会怎样**
本机任意客户端可往任意可写目录投递任意 JSON 文件（覆盖同名文件），且能凭空起一个不受管的 agent 进程。

---

#### I3 同一批无认证事件里包含「关服 / 关服务 / 改运行期设置」——任意本机客户端可关掉整套系统

`mindcraft/src/mindcraft/mindserver.js:234-248`（server-start/stop/log）、`336-343`（set-agent-settings）、`356-390`（stop/destroy/stop-all/shutdown）、`src/mindcraft/proc_control.js:212-235`

**这是什么**
`server-stop` → `procCtrl.stopServer()` → 发 RCON `stop` 关掉 Paper；`shutdown` → 停掉所有 agent 并
`process.exit(0)`（`mindserver.js:379-390`）；`set-agent-settings` 把客户端给的任意对象塞进
`agent.setSettings(settings)` 并触发 `restart-agent`。

**问题（入口 → 报文 → 后果）**
* 入口：`127.0.0.1:8080` socket.io，无认证。
* 报文：`s.emit('server-stop')` / `s.emit('shutdown')` /
  `s.emit('set-agent-settings','deepseek',{...原设置, allow_insecure_coding:true, blocked_actions:[], max_commands:-1})`。
* 后果：
  1. 关服：其他玩家当场掉线；虽走 RCON 优雅关闭（不会坏档），但这是无门槛的 DoS。
  2. **改设置即提权**：`commands/actions.js:6` import 的是 `src/agent/settings.js`（运行期单例，
     由 `mindserver_proxy.js:88-91` 用 `setSettings()` 填充），所以 `allow_insecure_coding`
     这个"代码执行总闸"是可以从 socket 打开/关掉的；`only_chat_with`、`blocked_actions` 同理。
  3. `shutdown` 与"面板退出"用的是同一个事件——外部客户端无法与面板区分。

**最小修复**
与 I1 同一道 token 闸门；在闸门落地前，先在 `mindserver.js:336` 的 `set-agent-settings` 里做字段白名单
（只允许 `profile` / `init_message` / `max_messages` 等 UI 真正会改的键，`allow_insecure_coding`
与 `blocked_actions` 直接丢弃）。

**不修会怎样**
本机任意进程可随时关服、可远程把"沙箱代码执行"开关打开或把安全黑名单清空。

---

#### I4 主服 RCON 对局域网监听（`0.0.0.0:25575`）

`server/server.properties:14`（`enable-rcon=true`）、`:46`（口令）、`:47`（`rcon.port=25575`）、`:54`（`server-ip=` 为空）；netstat 实测 `TCP 0.0.0.0:25575 LISTENING`

**这是什么**
Paper 的 RCON 控制台端口。口令是 32 位随机串（不是弱口令），但**端口是全网卡监听的**，
且没有失败次数限制（服务端没这个机制，`proc_control.js`/`rcon_client.js` 也不做限流）。

**问题（谁能利用 + 从哪进 + 后果）**
* 谁能利用：同一个局域网/同一 Wi-Fi 下的任何人（不需要 Minecraft 账号、不需要白名单）。
* 从哪进：`tcp://<本机局域网 IP>:25575`，标准 RCON 协议（`proc_control.js:101-138` 就是一份可抄的客户端）。
* 后果：口令一旦被嗅探/复用/暴力（本机用户把这串口令复制给朋友、写进某次截图），对方拿到的是
  **服务器控制台**——`op <自己>`、`give`、`setblock`、`stop` 全部可用；本体 341 个 op 账号里随便挑一个
  被 op 的目标也能直接 `deop`。
* 对照：测试服就绑了 `127.0.0.1`（`server-test/server.properties:54`），说明作者知道该怎么收窄，主服漏了。

**最小修复**
在 `server/server.properties` 加 `rcon.bind=127.0.0.1` 后重启（若该 Paper 版本不支持此项，则改
Windows 防火墙入站规则只放行 25565、屏蔽 25575）；两处都是改配置，不动代码。

**不修会怎样**
内网任何设备都能对控制台发起不限次数的口令尝试，且 RCON 明文传输、可被同网段嗅探。

---

#### I5 单个 bot 的退出码 >1 会连带杀掉整个 mindserver

`mindcraft/src/process/agent_process.js:37-40`；触发源 `src/agent/agent.js:496` 与 `:862-864`

**这是什么**

```js
if (code > 1) {
    console.log(`Ending task`);
    process.exit(code);      // ← mindserver 自己退出
}
```

设计意图是"任务模式跑完就整体收工"，但这条路径上挂着**运行期也会发生的**触发点：
`agent.js:496` `checkAllPlayersPresent()` 在缺少必需玩家时 `cleanKill(…, 4)`；
`agent.js:862-864` 任务结束时 `killAll()` → `serverProxy.shutdown()`（整个 mindserver 退）。

**问题（场景 → 结果）**
* 场景：用 `--task_path … --task_id …` 跑一次任务（`main.js:29-38`），`tasks/*.json` 里 `agent_names`
  写的人有一个没进服 → `checkAllPlayersPresent` 判缺人 → 退出码 4 → **mindserver 整体退出**，
  同一台机器上其它 bot、面板一起没。
* 结果：一个 bot 的局部问题升级成全局中断，且日志只有一行 `Ending task`，看不出是谁拖的。

**最小修复**
`agent_process.js:37-40` 改为只清该 agent：`delete agent_connections` 无权限 → 改成
`logoutAgent(this.name)` + 从 `agent_processes` 里删除自己，**不调用 `process.exit`**；
若确实要"任务结束整体收工"，让 `Task.isDone()` 那条路径显式调 `mindcraft.shutdown()`。

**不修会怎样**
任务模式下缺一个人（常见：卡在登录、忘开客户端）就让整套服务退出，且现场看起来像"面板自己崩了"。

---

#### I6 每次模型请求都无条件把完整提示词打到 stdout（含玩家聊天与记忆）

`mindcraft/src/models/hyperbolic.js:45`（`console.log('Messages:', messages);`）

**这是什么**
在 `while (attempt < maxAttempts)` 循环里，每次尝试都打印完整 `messages`（system prompt + 全部对话 +
记忆摘要）。这跟 `settings.log_all_prompts`（`prompter.js:354-356` 会检查它）**不是同一条路**，
不受该开关控制。

**问题（场景 → 结果）**
* 场景：把 profile 换成 `hyperbolic`（`profiles/` 里有该适配器命名空间），或任何一次走
  `src/models/hyperbolic.js` 的调用；每轮对话都会落一份完整上下文。
* 结果：落到 `logs/mindcraft-console.log`（`start-panel.ps1:19,189` 的重定向）与
  `mindcraft/run-live.log`；里面包含玩家私聊原文、`memory.json` 摘要、profile 里的私人人设文本。
  日志按 `.gitignore:35` 不进库，但仍长期留在磁盘上，且"给作者贴日志排障"时会整段外泄。

**最小修复**
删掉 `hyperbolic.js:45` 这一行（其余适配器都没有这个打印）；如需保留，改为
`if (settings.log_all_prompts) console.log('Messages:', messages);`。

**不修会怎样**
提示词（含私聊内容）无开关地持续落盘，与 `log_all_prompts=false` 的语义直接矛盾。

---

### Should fix

---

#### I7 mindserver 退出时不等待/不回收 agent 子进程 → 残留进程 + 重复登录

`mindcraft/src/process/agent_process.js:26-29`、`src/mindcraft/mindserver.js:379-390`、`src/agent/mindserver_proxy.js:39-43`

**这是什么** `spawn` 出来的 agent 只是普通子进程（无 detached、无 job object）；`shutdown` 先
`stopAgent` 发 SIGINT，然后固定 `setTimeout(…, 2000)` 直接 `process.exit(0)`，不等子进程真的退出。

**问题（场景 → 结果）**
* 场景：面板点停止 / mindserver 因 I5 退出 / 进程被任务管理器结束 → 某个 agent 正在等模型 API
  （一次可能几十秒），2 秒内收不到 SIGINT 生效 → 子进程成了孤儿，仍持有 Minecraft 会话
  （它自己的重连是 `reconnectionAttempts: Infinity`，`mindserver_proxy.js:39-43`，只会一直重试连 8080）。
* 结果：再次 `启动面板.bat` 时同名 bot 重新登录 → 服务端回 `duplicate_login` /
  `username is already connected`（`connection_handler.js:5-9` 正是这条错误）→ agent `process.exit(1)`
  → `agent_process.js:42-51` 重启 → 又撞名，形成循环。

**最小修复** `shutdown` 里等每个子进程 `exit` 事件（`Promise.all` + 5s 超时兜底）再 `process.exit`；
`agent_process.js` 的 `spawn` 加 `detached: false` 并在 `process.on('exit')` 里 `kill()` 所有子进程。

**不修会怎样** 偶发的"重启后 bot 一直上不去、必须手动去任务管理器杀 node"——已在本项目里出现过（`mindserver_proxy.js:28-33` 的注释就是这类症状）。

---

#### I8 `settings_spec.json` 声明了 type/options，但服务端只读 required/default → 类型错误静默传播

`mindcraft/src/mindcraft/mindserver.js:251-266`、`src/mindcraft/public/settings_spec.json:44-48`、`src/agent/agent.js:350` 与 `704-707`

**这是什么** `settings_spec.json` 给每个设置写了 `"type": "array"`、`"options": [...]`，但
`create-agent` 的处理循环只用了 `settings_spec[key].required` 和 `.default`，`type`/`options`
**从来没被读过**（全仓只有这一处引用 settings_spec）。

**问题（场景 → 结果）**
* 场景：客户端（或人手改 `settings.js`）把 `only_chat_with` 写成字符串 `"HEAVENZEH"` 而不是数组。
* 结果：两处都错，且都不报错：
  * `agent.js:350` `settings.only_chat_with.includes(username)` 变成**子串匹配** ——
    名字 `HEAVEN` 也能通过这道"只听谁说话"的闸门（`"HEAVENZEH".includes("HEAVEN") === true`）。
  * `agent.js:704-707` `for (let username of settings.only_chat_with)` 会按**字符**迭代，
    于是对 `H`、`E`、`A`… 逐个 `bot.whisper()` → 一串报错/刷屏。
* 同类：`base_profile` 传数字 → `prompter.js:33` `settings.base_profile.includes(...)` 抛 TypeError，
  agent 起不来而报错信息只有 `Failed to start agent process`。

**最小修复** 在 `mindserver.js:251-266` 的循环里补 6 行类型校验（`Array.isArray` / `typeof`），
`options` 用 `includes` 判；校验失败回 `{success:false, error:'Setting x must be array'}`。
（不必引 schema 库。）

**不修会怎样** 一个配置笔误换来"看起来在跑、实际门槛失效/无限报错"，排查成本极高。

---

#### I9 任务板的"来源等级"判据写好了却没人调用 → `board:add` 可以任意派单

`mindcraft/src/agent/permissions.js:162-187`（定义）、`src/agent/library/board_server.js:121-145`（`board:add`）

**这是什么** `permissions.js` 定义了 `maxJobLevel(level)` 与 `levelForJobSource(job, permissions)`，
注释写着"信任级下的单最高 6 级"。实测 `grep -rn "levelForJobSource\|maxJobLevel" src/` **只命中定义处**，
没有任何调用者；`board_server.js` 全文没有 `level` 字样。

**问题（场景 → 结果）**
* 场景：本机任意 socket 客户端直接发
  `s.emit('board:add', { skill:'build', args:{...}, priority:9, source:'system', sourceName:'x' })`。
* 结果：`validateIncomingJob`（`board_server.js:50-74`）只校验 skill 在注册表里、args 合 manifest、
  priority 在 0-9，**不看 source/level** → 单子入库 → 调度器（`board_scheduler.js`，3 秒一拍）照跑。
  也就是说 `!addJob` 那条"只给主人"的闸门（`permissions.js:50-53`）在 socket 层被完全绕开。

**最小修复** 二选一，别留着当摆设：
(a) 在 `board_server.js` 的 `board:add` 里接上判据——`levelForJobSource(job, perms)` 结果与
`job.priority > maxJobLevel(level)` 时拒绝；perms 从 `agent_connections[assignee].settings.profile.permissions` 取；
(b) 如果短时间不打算实现，删掉 `maxJobLevel`/`levelForJobSource` 及其注释（约 26 行），
免得下一个人以为它在生效。

**不修会怎样** 安全模型上写着"信任级派不了重活"，实际任何本机连接都能派 9 级单。

---

#### I10 RCON 协议实现写了两份（38 行 vs 56 行）

`mindcraft/src/mindcraft/proc_control.js:101-138` 与 `src/agent/library/rcon_client.js:62-117`

**这是什么** 两份几乎逐行相同的最小 RCON 客户端：同样的 `Buffer.alloc(4+4+4+len+2)`、
同样的 `writeInt32LE` 三次、同样的 `id === -1` 判认证失败、同样的 `buf.slice(12, 4+len-2)`。

**问题（场景 → 结果）** `rcon_client.js` 已经做了 M1 安全改造（密码不写死、来源可追溯、
`describeRconConfig` 脱敏），而 `proc_control.js` 只抄了协议没抄策略：它自己读
`loadRconConfig()`，password 走 `state.rconPassword`。两份实现迟早分叉——**改一处漏一处就是"面板能停服、
bot 查不到坐标"**，而这正是项目反复踩的同一类坑（`bot_paths.js:4-15` 的注释就在讲同一个教训）。

**最小修复** `proc_control.js` 删掉自己的 `rcon()`（`101-138`），改成
`import { rcon } from '../agent/library/rcon_client.js'`，调用处 `rcon('stop')` 不变（签名兼容：
`rcon(command, {port, password})`）。

**不修会怎样** 下次改 RCON 认证（比如加超时/加 TLS/换口令来源）只改一处，另一处静默保留旧行为。

---

#### I11 agent 崩溃后无限自动重启，没有退避也没有上限

`mindcraft/src/process/agent_process.js:42-51`

**这是什么** 只要 `code !== 0 && signal !== 'SIGINT'` 且"存活 > 10 秒"，就无条件重启，
`last_restart` 只用于判"活够 10 秒没有"，没有次数计数、没有指数退避。

**问题（场景 → 结果）**
* 场景：模型 API key 失效 / 上游 402 / 网络断 —— agent 能活过 10 秒（登录成功后才开始请求模型），
  然后在第一次对话时抛错退出。
* 结果：每次退出都重启 → 每轮都重新登录 Minecraft、重新拉 `initExamples`（可能又打一次 API）、
  重新扫描地形。`bot.chat('Restarting.')`（`agent.js:846`）还会在服里刷屏。
  这就是"崩溃 → 重连风暴"的形态。

**最小修复** 加计数与退避：`this.restarts = (this.restarts||0)+1`，超过 5 次就停手并
`console.error('Agent 连续失败 5 次，停止重启')`；退避 `Math.min(30000, 1000 * 2**this.restarts)`。

**不修会怎样** 上游一次性故障会变成持续登录/登出，玩家侧看到 bot 反复上线下线，服务端日志被刷爆。

---

#### I12 21 个模型适配器是复制粘贴出来的：同一段重试/降级写 11~17 遍

`mindcraft/src/models/*.js`（共 21 个文件、2223 行；其中 18 个定义了 `async sendRequest`）

**这是什么** 实测重复量：

| 重复片段 | 命中文件数 | 证据 |
|---|---|---|
| 上下文超长 → 砍掉第一条再重试（`throw new Error('Context length exceeded')` + `err.code == 'context_length_exceeded'` + `turns.slice(1)` 递归） | **11** | `grep -rl "Context length exceeded" src/models/` = deepseek/gpt/grok/hyperbolic/lmstudio/mercury/novita/ollama/openrouter/qwen/vllm，每个文件命中 3 次（throw + 判据 + 日志） |
| 兜底文案 `'My brain disconnected, try again.'` | **17** | `grep -rc "My brain disconnected" src/models/` 命中 17 个文件各 1 次 |
| 构造器样板（`config.baseURL = url`、`config.apiKey = getKey(...)`、存 `this.model_name/this.params`） | **14** | `gpt.js:7-21`、`deepseek.js:7-16`、`claude.js:8-17`、`grok.js:13-18`、`qwen.js:9-13`、`novita.js:12-17`、`mercury.js:11-16`、`mistral.js:20-24`、`openrouter.js:7-21`、`groq.js:22-26`、`cerebras.js`、`azure.js:15-18`、`hyperbolic.js:5-13`、`lmstudio.js` |

**问题（场景 → 结果）** 已知的具体分叉：`openrouter.js:48-52` 的 catch **完全没有** context-overflow 重试
（只有一句"失败就换个说法"），而 `gpt.js:76-78`、`deepseek.js:42-44` 有。同一个"上下文太长"故障，
换成 openrouter 就表现为"模型失联"，换 gpt 就自动截断继续 —— 同一个 bug 两种症状，
排查时会被引到错误方向。`gpt.js:79` 还有个更直接的问题：`err.message.includes('image_url')`
在 `err.message` 为 undefined 时会在 catch 里再抛一次。

**最小修复（可落地的最小方案，不动 21 个文件的对外接口）**
新增 `src/models/_compat.js`，导出两件东西：

1. `runWithContextRetry(fn, turns, {resend})` —— 约 15 行，把 11 处重试逻辑收成一处；
2. `openAIClient(prefix, envKey, defaultUrl)` —— 约 12 行，把 14 处构造器样板收成一处。

然后 11 个适配器的 catch 段各删 ~12 行、14 个适配器的构造段各删 ~5 行。
**预计净减 150~180 行**（2223 → 约 2050），且 `openrouter` 的缺行为顺手补齐。
（不做基类继承——`_model_map.js:18-25` 是按导出对象的 `prefix` 发现适配器的，
基类会破坏这个约定。）

**不修会怎样** 下次要改"重试几次/退避多久/要不要记 cost"，得改 11 个地方；已知已经漏了 1 个。

---

#### I13 `speak.js` 把模型文本拼进 shell 命令，只转义了单引号

`mindcraft/src/agent/speak.js:85-99`

**这是什么**

```js
const cmd = isWin
  ? `powershell -NoProfile -Command "Add-Type ...; $s.Speak('${txt.replace(/'/g,"''")}'); $s.Dispose()"`
  : ...
exec(cmd, err => {...});
```

`txt` 是模型回复文本（`agent.js:710-712` 在 `settings.speak` 为真时传进来）。

**问题（场景 → 结果）**
* 入口：`settings.speak = true`（`settings.js:26` 默认 `false`，但见 I3：socket 可改）。
* 报文/触发：让模型复述一段含双引号的文本，例如
  `'" & calc & "'`。`'` 被转义了，`"` 没有 → `cmd.exe` 在双引号闭合处把 `& calc &` 当分隔符执行。
* 后果：以当前用户身份执行任意命令（不比 I1 更严重——I1 已经能进沙箱代码——但它绕过了 SES 沙箱，
  是真正的系统命令执行）。

**最小修复** 不用 `exec` 拼串：Windows 走
`execFile('powershell.exe', ['-NoProfile','-Command', script], …)`，把 `txt` 作为
**参数**传入（或用 `System.Speech` 读 stdin）；非 Windows 同理改 `spawn('say', [txt])`。

**不修会怎样** 开了语音播报之后，模型输出到系统命令之间只有一层单引号转义，等于把 shell 交给模型。

---

#### I14 提示词日志目录用未校验的 `task_id` 拼路径

`mindcraft/src/models/prompter.js:369-381`

**这是什么** `logDir = path.join(__dirname, '../../bots/${this.agent.name}/logs/${task_id}')`，
`task_id` 来自 `this.agent.task.task_id`，源头是 `main.js:31-33`（`--task_id`）或 `create-agent`
传进来的 `settings.task`——客户端可控，未做字符过滤。

**问题（场景 → 结果）** `log_all_prompts=true`（`settings.js:54` 默认 false）时，
`task_id = '../../../../tmp/x'` 就能让 `fs.appendFile` 写到 bots 目录之外。
关闭状态下是死代码，所以只算 Should。

**最小修复** `prompter.js:375` 用 `String(task_id).replace(/[^A-Za-z0-9_.-]/g,'_')`，
或 `path.basename(String(task_id))`。

**不修会怎样** 一开 `log_all_prompts` 就多一个任意路径追加写（内容为完整提示词）。

---

#### I15 `utils/` 里有平台已提供的能力被重造（`loop_lag.js`）

`mindcraft/src/utils/loop_lag.js:1-60`

**这是什么** 60 行手写的事件循环延迟探针：`setInterval(500ms)` + `Date.now()` 差值 + 自己记
`maxLagMs/maxLagAt/samples`。

**问题（场景 → 结果）** Node 自带 `perf_hooks.monitorEventLoopDelay()`（直方图，含
min/max/mean/percentile，精度 µs 级，且不需要自己维护 timer）。现在的实现只能给"最大值"，
遇到一次偶发尖峰就把 `maxLagMs` 永久顶住（`loop_lag.js:33-36` 从不衰减），
`describeLoopLag()` 从此永远报"主线程被占住"——**诊断工具自己会骗人**，而它存在的唯一目的就是诊断。

**最小修复** 换成 `monitorEventLoopDelay`：保留 `startLoopLagWatch/describeLoopLag/loopLagStats`
三个导出（调用方 `mindserver_proxy.js:7,59,65` 不用改），内部实现缩到约 12 行，并输出 p99 而非历史最大值。

**不修会怎样** 掉线排障时这条线索会把方向带偏（本项目恰恰为此写过一段注释，见 `loop_lag.js:4-12`）。

---

### Nice to have

---

#### I16 `andy.json` 是死配置，且里面的模型名不存在

`mindcraft/andy.json:1-6`

**这是什么** 仓库根（`mindcraft/`）下的上游遗留 profile：`{"name":"andy","model":"gpt-5.4-mini"}`。
`grep -rn "andy.json" --include=*.js --include=*.json .` 除 `docs/legacy/readme-upstream.md` 三处叙述外
**没有任何代码引用**；实际入口是 `settings.js:18-20` 的 `profiles: ["./profiles/my-local.json"]`。

**问题** 它看起来像一个"正在用的配置"，而且 `gpt-5.4-mini` 不是任何提供商的模型名
（`_model_map.js:51-52` 会把含 `gpt` 的串认成 openai，然后请求一个不存在的模型 → 400）。

**最小修复** 删除 `mindcraft/andy.json`（6 行）。

**不修会怎样** 下次换模型时有人改这里、发现不生效，或者照抄这个模型名去用。

---

#### I17 `/assets/item/:agent/:name.png` 的 `name` 未过滤，可穿越读任意 `.png`

`mindcraft/src/mindcraft/mindserver.js:105-161`（关键在 `142-151` 的 `path.join(base,'items',`${itemName}.png`)` + `readFileSync`）

**这是什么** 贴图代理：把 URL 参数直接拼进包内路径。`itemName` 只做了 `toLowerCase()`（`:109`）。

**问题** `GET /assets/item/x/..%2f..%2f..%2fUsers%2fme%2fsecret.png` → Express 解码 `%2f` 后
`path.join` 归一化 → 读到 bots/ 之外任意 `.png`。**限制**：只能读 `.png`，且这三个 HTTP 端点绑在
`localhost`（`mindserver.js:421`），跨源页面拿不到响应体（无 CORS 头）→ 实际只能被本机进程利用，
危害低于 I1 两条数量级。

**最小修复** `:109` 加一行 `if (!/^[a-z0-9_]+$/.test(itemName)) return res.status(404).end();`

**不修会怎样** 本机任意进程可把它当"任意 .png 读取器"用（配合 I1 已能做的事，危害不增；但它是免费修的一行）。

---

#### I18 `bot-output` / `agent-event` 是原样转发，任何客户端都能伪造面板内容

`mindcraft/src/mindcraft/mindserver.js:404-411`

**这是什么** `socket.on('bot-output', (agentName, message) => io.emit('bot-output', agentName, message))`，
不校验发送方是不是那台 agent、不校验 `agentName` 是否已注册。

**问题** 任何本机客户端 `s.emit('bot-output','deepseek','我已经把箱子清空了')`，面板上就显示成
bot 说的话。排障时会对着伪造日志查错。

**最小修复** 与 I1 同一条思路：只有 `curAgentName === agentName` 的连接能发（`curAgentName` 已在
`mindserver.js:176` 维护）。

**不修会怎样** 面板的"bot 输出"这一栏不可信。

---

#### I19 `get-profiles` / `get-profile` 把绝对路径与私有 profile 全文交出去

`mindcraft/src/mindcraft/mindserver.js:184-226`

**这是什么** `get-profiles` 返回每个 profile 的**绝对路径**（`:196` `path: full`）；
`get-profile` 返回任意 profile 文件全文（`:221-222`，`path.basename` 只挡穿越、不挡越权）。

**问题** `profiles/my-local.json` 里有中转站地址（`"url": "https://api.llmgo.net/v1"`）与私人人设 prompt。
任何本机客户端可一次拉全（该文件已在 `.gitignore:55` 里被刻意排除出仓库，说明作者认为它敏感）。

**最小修复** 返回值里去掉 `path` 字段（面板只用 `file`）；`get-profile` 对 `*-private.json` / `*-local.json`
不返回 `raw`、只返回字段清单。

**不修会怎样** 本机任意进程可枚举用户的私有模型端点与人设文本。

---

#### I20 `mcserver.js` 的 `findServers` 全局改写 `console.log`，异常时不还原

`mindcraft/src/mindcraft/mcserver.js:83-99`

**这是什么** 为了让 minecraft-protocol 别刷屏，把 `console.log` 换成空函数，扫完再还原。

**问题** 循环里任何一次 `serverInfo` 抛错（DNS 解析失败、`ip` 非法）都会跳过 `:99` 的还原，
此后**整个进程的 console.log 静默**——包括 agent 的所有日志。触发条件写死在 `getServer(host, -1)` 分支
（`mcserver.js:117-128`），即 `settings.port = -1` 自动找 LAN 服时。

**最小修复** 用 `try { … } finally { console.log = originalConsoleLog; }` 包住 `:86-96` 的循环。

**不修会怎样** 用 `port: -1` 且扫描失败时，后续所有日志消失，现场表现为"进程在跑但什么都不打印"。

---

#### I21 `prismarine-schematic` 是未使用依赖

`mindcraft/package.json:46`（`"prismarine-schematic": "^1.3.0"`）、`src/agent/library/schematic.js:9`

**这是什么** `schematic.js` 开头的注释就写着"为什么不用 prismarine-schematic"（自己实现了 NBT 解析），
`grep -rn "prismarine-schematic" src/` 只命中那行注释。

**最小修复** 从 `package.json` 删这一行，`npm install` 一次。

**不修会怎样** 多拉一个包及其传递依赖，且给人"蓝图走 prismarine-schematic"的错误印象。

---

## 3. 任务十问 · 逐条答复（指向上面的编号）

1. **socket.io/HTTP 有无认证？局域网谁能连？连上能做什么？**
   **没有认证**。唯一的门是 `local_only.js:34-40`：Host 必须是 `localhost/127.0.0.1/[::1]`，
   且"若带 Origin 必须是本机页面"，**不带 Origin 一律放行**。局域网连不上（`mindserver.js:421`
   固定 bind `'localhost'`，netstat 未监听外网）。能连的人＝本机任意进程 + 任何从
   `http://localhost:<port>` 提供的页面。连上能做：发指令/改设置 → **I1 / I3**；派任务单 → **I9**；
   关服关服务 → **I3**；读聊天与记忆（`get-memory` `mindserver.js` 侧 relay + `mindserver_proxy.js:317-338`）、
   读全部 profile 与绝对路径 → **I19**；伪造面板输出 → **I18**。
2. **命令通道能否被用来执行任意代码/命令？把"客户端字符串 → 危险汇聚点"画出来。**
   两条链，均**不含** `eval`/`new Function`（`grep -rE '\beval\(|new Function\(' src/` 0 命中）：
   * `send-message.data.message` → `respondFunc` → `handleMessage` →（以 `data.from` 判级为 owner）→
     `executeCommand('!newAction')` → `coder.generateCode` → `compartment.evaluate(src)`（`coder.js:195`）。
     执行在 SES 沙箱里，endowment 只有 `skills/world/Vec3/log`（`coder.js:189-194`），
     **但 `skills` 本身带 fs 能力**：`skills.listBlueprints(bot, dir)` → `readdirSync(path.resolve(dir))`
     （`schematic.js:164-167`，**只返回** `*.litematic|schem|schematic` 结尾的文件名）、
     `buildFromSchematic/describeSchematic(path)` → `readFileSync(path.resolve(path))`
     （`schematic.js:51-56`，内容要过 NBT 解析，解析失败会把**绝对路径**回显进聊天/日志）。
     所以沙箱"没有 fs"的说法在**任意目录的蓝图文件名枚举 + 任意路径存在性探测**这一层不成立。
   * `send-message.data.message` → `history.add(source, message)`（`agent.js:587`）→ 下一轮 prompt →
     提示词注入；这是 M1 已经承认并靠"按发言人定级"缓解的路径，但 I1 让"发言人"本身可伪造。
   * 另外 `send-message` 还能配合 `speak`：`agent.js:711` → `speak()` → `exec()` 拼串（**I13**）。
3. **密钥** → 见第 1 节（`git ls-files` 原文已附）。结论：`keys.json` 未被跟踪、从未提交；
   无 URL/query 带 key 的写法；错误日志不带请求头；唯一真实的泄漏是提示词（**I6**）。
4. **路径穿越** — 逐个位置核过：
   * `prompter.js:110-111`（agent 名，**可穿越且在校验之前**）→ **I2**；
   * `prompter.js:375`（`task_id`，`log_all_prompts` 才生效）→ **I14**；
   * `mindserver.js:142-143`（贴图名，仅 `.png`）→ **I17**；
   * `coder.js:16`、`vision_interpreter.js:11`（都用 agent 名，但此时校验已过，`agent.js:205`）→ 安全；
   * `mindserver.js:218`（`path.basename` 已挡）→ 安全；
   * `bot_paths.js:41-53`（bot 名来自 `bot.username`，服务端限定 `[A-Za-z0-9_]{3,16}`）→ 安全；
   * `schematic.js:51-56`（路径来自模型代码，无白名单）→ 已并入第 2 问答的沙箱问题。
5. **CORS / 监听地址 / 默认端口密码 token**
   * 监听：mindserver `'localhost'`（`mindserver.js:421`）；主服 `0.0.0.0`；主服 RCON `0.0.0.0`（**I4**）。
   * CORS：express 没挂任何 CORS 中间件（`grep -rn cors src/` 0 命中）；
     socket.io 没设 `cors`，靠 `allowRequest`（`mindserver.js:66`）在握手层挡 —— 比 CORS 更硬。
   * 默认端口：mindserver 8080（`settings.js:8`）、MC 25565、RCON 25575、viewer 3000+index（`mindcraft.js:41`）。
   * **没有任何默认口令/默认 token**——因为根本没有认证。这是 I1 的另一面。
6. **进程管理** — start/stop 脚本只碰自己的东西：`start-panel.ps1:41-44` 只按 `CommandLine -match 'server\.jar'`
   **查**进程（不杀），`:153-179` 先探端口再决定是否启动；`stop-panel.ps1:17` → `web/scripts/stop-all.mjs`
   → `server-stop`（RCON 优雅关）+ `shutdown`。没有 blanket kill（这点是对的）。
   残留/双开 → **I7**；端口占用已有明确处理（`proc_control.js:165-172` 拒绝双开、`start-panel.ps1:183-193` 跳过）；
   崩溃重连风暴 → **I11**。
7. **输入校验到路径/SQL/RCON**
   * 到路径：**I2 / I14 / I17**（其余见第 4 问）。
   * 到 SQL：**已核实为否**。`board_store.js` 全部走 `prepare(...).run/get/all(...params)`；
     唯一的动态拼接是列名，而列名来自白名单 `PATCHABLE`（`board_store.js:709-720`）
     与 `JSON_COLS`（`:208`）——`if (!PATCHABLE.has(k)) continue;`（`:729`）在拼接前就挡了。
   * 到 RCON：**已核实为否**。唯一带变量的命令是 ``rcon(`data get entity ${name} Pos`)``
     （`rcon_client.js:153`），而 `name` 在调用前已校验"必须在 `bot.players` 里"
     （`query_target.js:150-155`，不在线直接 `NO_TARGET`），名字来自服务端，字符集受限；
     RCON 单包单命令，没有分隔符可注入。
   * RCON 口令怎么存：`server/server.properties:46` 明文（Paper 的机制，无法避免），
     **代码侧不写死**：`server_props.js:111-118` 唯一读法、`rcon_client.js:38-53` 按端口认领、
     `describeRconConfig()`（`server_props.js:156-164`）保证面板只看到 `hasPassword`。
8. **21 个 models 适配器的重复实现** → **I12**（11 处 context 重试 / 17 处同一句兜底 / 14 处构造样板；
   预计净减 150~180 行）。
9. **`utils/` 里重复造平台轮子** → **I15**（`loop_lag.js` vs `perf_hooks.monitorEventLoopDelay`）。
   其余 7 个：`keys.js`(24)/`math.js`(12)/`text.js`(77)/`translator.js`(30)/`examples.js`(82)/
   `skill_doc_check.js`(124)/`mcdata.js`(614) 都是必要的薄封装或数据表，没有值得替换的标准库能力。
   `schematic.js:51-65` 手写 NBT/gzip 解析是**有意的**（注释写明不用 prismarine-schematic），且
   `node:zlib` 已在用，不算重复造轮子。
10. **`settings.js` / `andy.json` 的读取校验** → **I8**（`settings_spec` 声明了 type/options 但代码从不读）。
    `andy.json` 见 **I16**（死配置，无校验也无所谓——它根本没被读）。

---

## 4. 未读部分（诚实清单）

以下是我**没有**逐行读过的，本报告不对其下任何结论：

* `src/agent/library/` 共 30 917 行，我读到的只有：`bot_paths.js`(全)、`rcon_client.js`(全)、
  `server_props.js`(全)、`board_server.js`(前 200/426)、`board_store.js`(SQL 相关约 120 行)、
  `schematic.js`(40-99, 162-174)、`skills.js`(3895-4104)、`lockdown.js`(全)、`query_target.js`(140-166)。
  **未读**：`skills.js` 其余 5 600+ 行、`executor.js`、`board_scheduler.js`、`terrain3d.js`、
  所有 `atom_*` / `act_*` / `flow_*` / `memory_store.js` / `trace_bus.js` / `composite_registry.js`(除 SKILL_NAMES)。
* `src/agent/`：`agent.js` 只读了 1-200 / 200-319 / 330-529 / 528-717 / 838-865（约 60%），
  未读 `conversation.js`、`history.js`、`memory_bank.js`、`self_prompter.js`、`modes.js`、`action_manager.js`、
  `npc/`(898 行)、`tasks/`(2 056 行)、`rules/rules.runtime.js`。
* `src/models/`：全读了 `gpt/claude/deepseek/gemini/hyperbolic/openrouter/_model_map/prompter`，
  **未读** `azure/cerebras/grok/groq/huggingface/lmstudio/mercury/mistral/novita/ollama/qwen/replicate/vllm`
  全文（只按 grep 命中读了片段）。
* `src/utils/`：`mcdata.js` 读了约 200/614 行；`skill_doc_check.js` 未读。
* 前端 `web/**`：**按作者要求不审**（见开头范围声明）。
* `tools/**`、`docs/**`、`tasks/**`、`bugs/**`、`.atom-v2-backup/**`：不在本任务范围，未读。

---

## 5. Lean 统计

### 5.1 覆盖规模

| 区域 | 行数 | 本次读完 | 备注 |
|---|---:|---:|---|
| `src/agent/library` | 30 917 | ~900 | 只覆盖路径/RCON/任务板/锁沙箱 |
| `src/agent`（不含 library） | 9 113 | ~1 900 | agent.js 约 60% |
| `src/agent/commands` | 1 867 | 346（index 全）+ actions 片段 | |
| `src/models` | 2 223 | ~1 200 | 8/21 全文 |
| `src/utils` | 1 023 | ~700 | |
| `src/mindcraft` | 1 131 | 1 131（**全**） | mindserver/local_only/proc_control/mindcraft/mcserver |
| `src/process` | 137 | 137（**全**） | |
| 入口/配置 | main.js 80、settings.js 57、settings_spec 140、Dockerfile 37、compose 27、network.json 27 | 全 | |
| 脚本 | start-panel.ps1 211、stop-panel.ps1 24、两个 .bat、start.bat 约 90 | 全 | |

### 5.2 可直接落地的瘦身项（不含风格意见）

| 动作 | 位置 | 预计 |
|---|---|---:|
| 删死代码 | `andy.json` 全文件 | −6 行 |
| 删死依赖 | `package.json` 的 `prismarine-schematic` | −1 行（+ 一个包的安装体积） |
| 删无条件日志 | `hyperbolic.js:45` | −1 行 |
| 合并 RCON 两份实现 | `proc_control.js:101-138` 改 import | −38 行 |
| 合并模型适配器重试/构造样板 | 新增 `_compat.js`，改 11+14 个文件 | −150~180 行（模型层 2223 → ~2050） |
| 平台已提供的能力 | `loop_lag.js` → `perf_hooks` | −48 行（60 → ~12） |
| **死判据二选一** | `permissions.js:162-187`（要么接上、要么删） | 删则 −26 行 |
| 运行期垃圾 | `mindcraft/bots/` 共 **77 个目录 / 34 MB**，其中大量探针残留（`blk2`、`blk3`、`hprobe`、`hprobe4`、`dirprobe`、`cmdprobe`、`fixture`、`__nonexistent_map__` …）；顶层 `bots/` 另有 15 个目录（只有 `memory`） | 可清 ~70 个目录；实际 bot 只有 `deepseek` 一个在用 |

合计可减：**约 270 行代码 + 70 个残留目录（34 MB）**。

### 5.3 本次"核实为否"的项（也算产出，避免下一个人重复排查）

* SQL 注入：`board_store.js` 全参数化 + 列名白名单 → **没有**。
* RCON 命令注入：调用前已校验玩家在线 → **没有**。
* `eval` / `new Function`：`src/` 0 命中；`require()` 只出现在 `vision/camera.js`（有 `createRequire`，正确）。
* `keys.json` 进过 git：**没有**（含历史）。
* 镜像里烧进 key：**没有**（`.dockerignore:5`）。
* socket.io 跨源可连：**不能**（`allowRequest` 比 CORS 更硬，`Origin: null` 也挡）。
* mindserver 对局域网可用：**不能**（bind `localhost`）。

---

*报告完。未修改任何被审查源码；本文件为唯一写入物。*
