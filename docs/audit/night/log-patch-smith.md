# log — patch-smith

格式照 PLAYBOOK §5：`## R<轮次> <时间> | 做了什么 | 结论 | 阻塞`

## R0 2026-11-06 01:25 | D0 预热：把历史审计欠账转成队列（t12） | 历史欠账转化：**24 条**（DEP 2 / SEC 5 / EXEC 12 / AI 3 / WEB 2），其中**已过期 51 条** | 无阻塞

**输入**：`docs/audit/00-REPORT.md`（v2.1，34 条硬发现 + E1/E2 + S33~S45）、`01~19` 分册、
`20/21` 两份 R2 复核（拿来交叉核对哪些已修）。

**先做的事（否则会把已修的写成待办）**：拿 `17-review-r1-verdict.md`、`21-review-r2-verdict.md`
的判定表当"候选真相"，然后**逐条在当前代码里复核**。结果：R1+R2 修的 33 条硬发现、E1/E2、
S33~S45、I6/I14 全部**真的在位**（复核方式逐条写在 `queue/HISTORY-EXPIRED.md`）。
有 5 条批量 grep 出现"像没修"的假信号，逐条查清后全部为**已修**（记在这里防下一轮重复挖）：

| 假信号 | 真相 |
|---|---|
| `grep -c 'c?.pos' landmarks.js` → 仍 1 命中 | 命中在**注释**里。实现已改 `normalizePos`（`:83-86`），第 8 条 J3 真修 |
| `grep 'toISOString' src/agent/agent.js` → 0 | 第 12 条的时间戳在 `src/infra/log_prefix.js:66`（幂等包 console），不在 agent.js |
| `grep 'Math.min(32' skills.js` → 0 | 第 13 条的硬夹在 `terrain3d.js:273 SCAN_MAX_RADIUS=32`（唯一入口），不在 skills.js |
| `grep 'sharedMerge' board_store.js` → 0 | 第 16 条的合并实现在**客户端** `board_client.js:437` + `flow_store.js:81`，服务端没有同名函数 |
| `grep '心跳内异常' agent.js` → 0 | 第 32 条把循环**搬**到了 `library/heartbeat_loop.js`，agent.js 只留 12 行调用 |

**产出的 24 条待办**（全部在当前代码复核"仍成立"，每条都带 `文件:行号`、可复现证据、最小修法、验证命令）：

- **D1 DEP 2 条**：`F-DEP-101` `prismarine-schematic` 未使用依赖（R2-7）；
  `F-DEP-102` **依赖 CVE 审计从未落账**（`gate`/`gate:full` 不含任何 audit，`docs/audit` 里 "npm audit" 0 命中）——这是 D1 今晚的判据缺口。
- **D2 SEC 5 条**：`F-SEC-101` RCON 开启 + `server-ip=` 空（绑全网卡）+ 口令明文落盘（口令**已脱敏，未抄录真值**）；
  `F-SEC-102` **19 个适配器 `console.log(err)`** 可能把 `Authorization` 打进日志（P11，历史标"未实测"，本轮给了金丝雀验证法）；
  `F-SEC-103` `get-profile`/`get-profiles` 交全文与绝对路径（I19/R2-6）；
  `F-SEC-104` 贴图代理 `itemName` 无字符集校验（I17/R2-4）；
  `F-SEC-105` 提示词两个开关、`LOG_PROMPTS` 绕开 spec/白名单（R2-8）。
- **D3 EXEC 12 条**：`F-EXEC-101` **`src/agent/tasks/**` 约 38 处裸 `bot.chat('/…')`**（含 `/kill @e`、`/fill` 100×100 清空），
  而 preflight 用"不是运行时链路"的豁免把整目录放过 —— 但 `tasks.js` 就是 `!do` 的运行时引擎（第 29 条同族，skills.js 侧已修、这一侧没跟）；
  `F-EXEC-102` 退出不回收 agent 子进程（R2-1/I7，后果落在任务板：孤儿继续领单+续租）；
  `F-EXEC-103` `takeFromChest`/`putInChest` 意图即成功；`F-EXEC-104` `equip` 不校验结果/中断；
  `F-EXEC-105` executor 高度不足仍 `return r`（08 F2）；`F-EXEC-106` `/air/i` 吞真实挖失败（08 F3，**3 处**，08 只记了 2 处）；
  `F-EXEC-107` `loop_lag` 最大值不衰减（R2-3/I15）；`F-EXEC-108` 垫脚清单第五份实现（R2-9）；
  `F-EXEC-109` `checkLevelBlueprint` 解引用崩溃（E3，`!checkBlueprintLevel` 可直达）；
  `F-EXEC-110` `embellishments` 传 `newZ` 当 x（E4）；`F-EXEC-111` `runCraft` 不传 ctx（E6）；
  `F-EXEC-112` `settings_spec.type/options` 从不校验（R2-2/I8）。
- **D4 AI 3 条**：`F-AI-101` 5 个适配器 catch 内 `err.message.includes` 二次抛（P3，00-REPORT 零落点）；
  `F-AI-102` `FAILED_REPLY` 仍是字符串契约（R2 记的"次生风险"，防下一次漏调）；`F-AI-103` 模型可见技能目录仍含 3 处未对齐旧实现。
- **D5 WEB 2 条**：`F-WEB-101` `bot-output`/`agent-event` 不校验发送方（I18/R2-5）；
  `F-WEB-102` `web/tsconfig` `strict:false` 且 web typecheck **不在 `gate:full`**（T11）。

**两条口径修正（比历史文档更准，请复核采纳）**：
1. **I17 的"已部分缓解"对 HTTP 端不成立**（`F-SEC-104`）：`mindserver.js:85-92` 的 `app.use` 只做
   `?token=` → `Set-Cookie`，然后**无条件 `next()`**，从不拒绝请求；握手门 `:103 io.use(...)` 只管 socket.io。
   ⇒ 贴图代理、`/console`、`express.static` 三个 HTTP 出口**仍然零鉴权**。
2. **I15 的"永久误报"要看窗口**（`F-EXEC-107`）：`describeLoopLag()` 输出的"最大值"没有窗口概念，
   一次抖动后会永久说"主线程确实被占用"，直接污染 `run-live.log:39` 那句被 00-REPORT 当作反证引用的话。

**未转化、留给下一轮侦察的（诚实边界，别当已清）**：08 的 F4/F6、13 的 P4（流式半截，未实跑）、
04 的 T12/T13/T14、06 的文档漂移与瘦身、以及 00-REPORT §4.3 说的"≈68 条分册发现不可追溯"里
本轮没复核到的部分。已写进 `queue/HISTORY-EXPIRED.md` §六。

**并发处置（今晚三人同时在写 inbox）**：`recon-scout` 已在用 `F-DEP-001…008` 段。`mv` 只保证认领互斥，
**写入不互斥**（`cat >` 会覆盖同名文件），所以本任务的单**一律用 1xx 段**（`F-SEC-101`、`F-EXEC-101`…），
与侦察兵的 0xx 段天然不重叠。约定写在 `queue/HISTORY-EXPIRED.md` §五。

**红线自查**：未改 `mindcraft/` 任何文件（`git status` 我只在 `docs/audit/night/` 下写）；
未抄录任何真实密钥值（`F-SEC-101` 里 RCON 口令写"已脱敏"）；未创建/修改任何 `claimed|done|verified|rejected` 里的文件；
未碰 `backups/ logs/ tmp/ server-test/`。

**我打算下一轮自己认领的顺序**（供 captain 排程；不影响任何人从 inbox 领单）：
1. `F-SEC-102`（19 处 `console.log(err)` → 一处 `logErrOnce`，改动小、泄密面直接关）
2. `F-EXEC-110`（E4 两个标识符，但要先读 `addWindows*` 签名）
3. `F-AI-101`（5 处 `err.message.includes`）
4. `F-EXEC-106`（3 处 `/air/i` → 结构化判据）
5. `F-SEC-105` / `F-EXEC-112`（配置契约两条，可一起跑 `settings_check` 验证）

**风险提示给 captain**：`F-EXEC-101` 是**唯一一条会立刻把门禁打红**的（加了判据后 preflight 会报 10+ 条
`tasks.js` 违规）。这是"门禁恢复视力"，不是回归 —— 但它会让 pre-commit 拦住所有提交，
所以必须排在一个专门的窗口里做（先改 `tasks.js` 的 10 处再收紧判据，或反之，二选一，别半截）。
