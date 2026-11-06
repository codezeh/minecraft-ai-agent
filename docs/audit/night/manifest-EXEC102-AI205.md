# manifest · F-EXEC-102（孤儿进程回收）+ F-AI-205（回归测试）

> patch-smith · 2026-11-06 12:2x｜task t21
> **诚实边界先说**：本会话 `spawnSync` = **EPERM**（node 不能创建子进程）⇒
> **三枪真机验收（正常 shutdown / 父被 SIGKILL / Ctrl-C）我跑不了**。
> 下面写清"我证明了什么"与"只能由你在真机验的部分"，不把静态推演写成实测。

---

## 一、`F-EXEC-102` 孤儿进程回收

### 1.1 改前：能复现什么（读码确认，非转述）

| # | 现状（改前） | 后果 |
|---|---|---|
| 1 | `mindserver.js` 的 `shutdown` 事件 = `stopAgent()` 循环（只发 SIGINT）+ `setTimeout(2000) → process.exit(0)` | 2 秒内没退干净的 agent 变**孤儿**：仍持 `board_client` 连接，**继续领单 + 续租**，面板看着"还在干活"，`!stop` 到不了它 |
| 2 | `grep "process.on('SIGINT'|'SIGTERM')"` → **0 处** | Ctrl-C 直接死，子进程全成孤儿（枪3 必挂） |
| 3 | `agent_process.stop()` 只 `this.process.kill('SIGINT')` 就返回 | `kill()` 成功**只代表信号送达**，不代表进程已死；没有等待、没有升级 SIGKILL |
| 4 | 子进程侧无任何"父是否还活着"的检查 | 父被 SIGKILL（枪2）时，**没有任何一层会清理** |

### 1.2 改后：四层（对齐复核席三判据）

**新增 `src/process/proc_lifecycle.js`**（纯函数 + 可注入，为了能单测）：
- `isProcessAlive(pid, killFn)` —— 三态：活着 / ESRCH 不存在 / **EPERM 算活着**（不能误判成死）
- `makeParentWatcher({parentPid, …})` —— 父存活监视；**没有 MINDSERVER_PID 就完全不装**（手动调试仍可跑）
- `stopChildAndWait(child, {graceMs, killGraceMs})` —— SIGINT → 等 → **SIGKILL** → 再等 → 返回
  `{exited, escalated, reason:'exited'|'killed'|'still-alive'|'no-child'}`；**强杀后仍无 exit 就如实报 still-alive**（不假装成功）

**接线（各自解决一枪）**：

| 枪 | 谁负责 | 怎么做的 |
|---|---|---|
| **枪1 正常 shutdown** | `mindcraft.shutdownAndWait()` + `mindserver.shutdownOnce()` | 逐个 `stopAndWait()`（等 exit，超时 SIGKILL），**全部有结果之后**才 `process.exit(0)`；并把 `{exited/escalated/reason}` 逐条打日志，未确认退出的点名告警 |
| **枪2 父被 SIGKILL** | **子进程自杀**：`init_agent.js` + `agent_process.js` | `agent_process` 把 `MINDSERVER_PID` 写进子进程 env；子进程用 `makeParentWatcher` 每 5s `kill(pid,0)`，父没了 → **先停自动领单 + 断开 board 连接（停续租）→ 200ms 后 exit** |
| **枪3 Ctrl-C** | `mindserver.js` | `process.once('SIGINT'/'SIGTERM') → shutdownOnce()`（**原来 0 处**） |

**判据#2（退出前不持 board 租约）**：孤儿路径里**先 `board.socket.disconnect()` + `setAutoClaim(false)`** 再退出 ⇒ 心跳停止 ⇒ 租约自然过期、不再续租。这是"孤儿的危害是继续领单"的正解。

**幂等**：`shutdownOnce` 用 `__shuttingDown` 防腐；重复触发（连点两次停止面板 / Ctrl-C 与 socket 同时来）只跑一次。

**旁路清理**：删掉了 F-RT-003 里 `SIGINT/SIGTERM → process.exit(0)` 的**抢先退出**处理器
（否则它会在优雅关停之前把进程退掉，等于白修）；token 文件清理改由 `process.once('exit')` 承担。

### 1.3 我证明了什么 / 没证明什么（关键，别误读）

**已证明（单测 + 静态接线，`tools/proc_lifecycle_unit.mjs` → 25 passed / 0 failed）**：
- `stopChildAndWait`：SIGINT 即退 → `exited/escalated:false`；无视 SIGINT → **升级 SIGKILL** 且 kill 顺序 `[SIGINT,SIGKILL]`；
  **连 SIGKILL 都不退 → 如实报 `still-alive`（不假装成功）**；已退出的 child 不白等（实测 0ms）
- `makeParentWatcher`：父死 → `onOrphan` 被调用且**幂等**（只一次）；父活 → 不触发；无 `MINDSERVER_PID` → 不装
- `isProcessAlive` 三态（含 EPERM 算活着）
- **接线断言（防"写了没人用"）9 条**：`shutdownOnce` 存在、SIGINT/SIGTERM 已注册、shutdown 事件走 `shutdownOnce`、
  老"wait 2 seconds"已消失、`shutdownAndWait` 调 `stopAndWait`、`agent_process` 调 `stopChildAndWait` +
  传 `MINDSERVER_PID`、`init_agent` 装监视器、孤儿处理里**会断开 board**

**没证明（必须你来，我环境不能 spawn → EPERM）**：真进程的三枪。复现步骤：
```bash
# 枪1 正常 shutdown
cd mindcraft && node main.js            # 起 mindserver + 1 agent
# 另一个终端：node ../web/scripts/stop-all.mjs   （或面板点"停止面板"）
# 期望：日志逐条 [shutdown] <name>: 自己退了/强杀后退了；tasklist 里无残留 node
# 判据#2：sqlite 里 SELECT id,state,lease_owner FROM jobs WHERE lease_owner IS NOT NULL → 应为空/已过期

# 枪2 父被强杀（照妖镜）
node main.js &  然后 taskkill /F /PID <mindserver pid>
# 期望：5 秒内 agent 子进程自己打印"检测到父进程已消失 ⇒ 孤儿自杀"并退出；tasklist 无残留

# 枪3 Ctrl-C
node main.js   然后按 Ctrl-C
# 期望：走 shutdownOnce（日志"开始关停（触发源：signal:SIGINT）"）→ 子进程确认退出 → 才 Exiting
```
**若枪2 不过**：第一嫌疑是 `MINDSERVER_PID` 没传进父子链（检查 `agent_process.js` 的 env 合并是否被子进程再 spawn 断掉）。

---

## 二、`F-AI-205` 回归测试

### 2.1 为什么要把它抽出来
原来那段判断**内联**在 `agent.js` 的 `handleMessage` 深处，**没法单测**（`grep used_command tools/*.mjs` 零命中）
⇒ 谁删掉它没人会红。现在抽成 `src/agent/library/used_command.js`：
- `PERMISSION_DENIED_PREFIX = '[权限] 没执行 '`
- `isPermissionDeniedResult(res)`
- `shouldCountAsUsedCommand(res)` —— 被拒 ⇒ `false`；**其它一律 `true`**（故意不一刀切，否则正常目标会被误判成"没命令"提前停掉）

`agent.js` 改为调用它（行为等价，可读性更好）。

### 2.2 测试（`tools/ai205_used_command_unit.mjs` → 15 passed / 0 failed）
- **正向**：`permissionDeniedReply(...)` 的输出 → `isPermissionDeniedResult` 真、`shouldCountAsUsedCommand` **false**（核心）
- **反向**（防一刀切）：正常字符串 / 失败但没被拒的字符串 / 对象 / `undefined` / `null` → **全部 true**
- **口径**：只说 `[权限] …` 但不是精确前缀的文本 → 仍算"用过"（只有精确拒绝前缀才算拒）
- **前缀不漂移**：常量与 `permissions.permissionDeniedReply` 实际输出前缀一致
- **接线 5 条**：agent.js 引入了它、调用了两个函数、老写法 `__permDenied` 已消失、`used_command = true;` 仍存在（防"删成永不置位"）

> 第③条（连续 3 轮被拒 → `self_prompter` STOPPED）**没做**：要驱动 agent 的完整消息循环（LLM/历史/定时器），
> 属集成测试范畴，本会话无法真跑；前两条（含反向断言）已覆盖 F-AI-205 的**语义本身**。

---

## 三、改动文件
```
A  mindcraft/src/process/proc_lifecycle.js        （新增：存活判定 / 父监视 / 停并等待）
A  mindcraft/src/agent/library/used_command.js    （新增：F-AI-205 判断，可单测）
M  mindcraft/src/process/agent_process.js         （env 传 MINDSERVER_PID；+ stopAndWait）
M  mindcraft/src/process/init_agent.js            （孤儿自杀：装父监视 + 断 board + exit）
M  mindcraft/src/mindcraft/mindcraft.js           （shutdownAndWait：等确认 + 强杀；shutdown 转调）
M  mindcraft/src/mindcraft/mindserver.js          （shutdownOnce 唯一入口 + SIGINT/SIGTERM；去掉抢先 exit）
M  mindcraft/src/agent/agent.js                   （改用 used_command 的判定）
A  mindcraft/tools/proc_lifecycle_unit.mjs        （25 条）
A  mindcraft/tools/ai205_used_command_unit.mjs    （15 条）
```
**没动**：`board_client.js`、`board_store.js`、`board_scheduler.js`（租约实现不在本单范围，孤儿侧只是"停止续租"）。

## 四、自检
| 命令 | 结果 |
|---|---|
| `node tools/proc_lifecycle_unit.mjs` | **25 passed / 0 failed** |
| `node tools/ai205_used_command_unit.mjs` | **15 passed / 0 failed** |
| `permissions_unit` / `mindserver_gate_unit` / `agent_process_backoff_unit` / `text_fence_unit` | 全 exit 0（无回归） |
| `node --check`（7 个改动文件） | 全 OK |
| `npm run gate:full` | **本会话跑不了**（`spawnSync` = EPERM；preflight §6 / lint_hard / unit_all 都要起子进程）⇒ 归 captain |

## 五、回滚
- 全部改动是**新增模块 + 转调**，无外部状态、无数据迁移。
- 回滚 = revert 这 9 个文件；`proc_lifecycle.js` / `used_command.js` 是新增文件，删掉即可（旧 `shutdown()` 与 agent.js 的内联判断都在 revert 里恢复）。
- 单独回滚某一枪：只 revert 对应接线（例如只想撤枪2：删 `init_agent.js` 的 watcher + `agent_process.js` 的 env，其余不动）。

## 六、一个我自己踩到并修掉的坑（如实记录）
`stopChildAndWait` 里最初给内部等待定时器加了 `unref()` —— 单测立刻暴露 `unsettled top-level await`：
调用方在 `await` 这个 Promise，而 unref 的定时器在事件循环空时**不会触发** ⇒ 进程提前退出。
已去掉该 `unref`（保留 `makeParentWatcher` 里**长期** interval 的 unref）。这条若留在生产代码里，
表现会是"关停时偶发卡住/提前退出"，很难查。
