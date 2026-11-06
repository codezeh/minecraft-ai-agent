# 复核清单 R3（终审第三轮 · 独立复核 · t33）

对象：`docs/audit/25-review-r3-verdict.md`（终审 R3④ 汇总）+ 分册 `22`/`23`/`24` + 夜班自证 `docs/audit/night/queue/`。
分支：`mindcraft` `audit/night-20261106`（相对 `main` 22 提交；两仓共约 40 提交）。
方法：`node` 直跑探针 / `git show` 取历史字节 / `git check-ignore` 实测 / 取**真实口令**全域搜 / `grep -n` 定位。
**未改 `mindcraft/` 任何文件**（`git status` 为空），只写 `docs/audit/`。

> R2 复核（t28）台账已被本文件取代；R1/R2 结论仍有效，摘要见 §H。

## 结论摘要

| 项 | 结果 |
|---|---|
| **我的最终判定** | **`PASS`** —— 与主编**一致**（代码可合回主支） |
| 抽检 | **12 条**（含全部高危"通过"项）：10 成立 / **1 部分不成立（我纠正 t31）** / 1 采信同事实测 |
| 独立重跑探针 | **4/4**（沙箱 20/0、板库不丢、0x08=0、gate 仅 EPERM） |
| **D 项（明文凭据残留）** | **阴性** —— 真实 32 位 rcon 口令在 `docs/` 与 git 跟踪文件均 **0 命中** |
| **E 项（需用户动作 6 条）** | **6/6 属实**，无"团队偷懒冒充用户动作"；无需升级挡门 |
| 修出新问题 | **0** |
| BLOCK 项 | **0** |
| **放行硬前提** | **`R3-M1`（CRLF 测试）在 HEAD 仍未修** → `gate:full` 仍红 |

## A. 抽检 12 条

| # | 编号 | 判定 | 复核 | 依据 |
|---|---|---|---|---|
| 1 | **F-EXEC-201** 聊天→RCE | 真修好 | **成立** | `speak.js:135` `spawn(file, argv, {stdio:['pipe'…]})`；`txt` 仅进 `:145 child.stdin.end()`；**全仓 `shell:true`=0**；全仓 `exec(` 唯一命中是 `:102` **注释** |
| 2 | **F-WEB-201** HTTP token 门 | 真修好 | **成立** | `mindserver.js:145` 服务端中间件、早于 static；`:731` `tokenHint` 脱敏 |
| 3 | **F-WEB-101** bot-output 鉴权 | 真修好 | **成立** | `:695`/`:706` `socket.handshake?.auth?.token === handshakeToken` |
| 4 | **F-WEB-202** 贴图同 key 合并 | 真修好 | **成立** | `:327` 返回同一个 Promise + `:328` 上限 + `:347 finally delete` |
| 5 | **F-WEB-203** 限流硬上界 | **部分修好** | **成立（缺陷仍在）** | `:87` `size > 512` 只删 >60s —— **触发条件不是上限**：513 个新鲜 key 一个删不掉 |
| 6 | **F-WEB-204** path.basename | 真修好 | **成立** | `grep -c path.basename` = **4**（t31 记 3，已更好） |
| 7 | **F-SEC-205** token 不进 stdout | 真修好 | **成立** | `:732` 只打脱敏 hint；`:733` 打文件路径；`:129` 失败分支不打全文 |
| 8 | **F-SEC-206** 凭据兜底 | t31 判「2/3 漏」 | **部分不成立（纠正 t31）** | **`.env.local` 其实被覆盖**：`.gitignore:79` 的 `.env.*`，`git check-ignore -v .env.local` 命中。真正未覆盖的是 **`*.token`**（`git check-ignore foo.token` 无输出） |
| 9 | **F-AI-201** 提示围栏 | 真修好 | **成立** | `prompter.js:219` `$MEMORY→fenceUntrusted`；`:221`/`:223` `fenced:true`；`history.js:7` import `sanitizeExternalText` |
| 10 | **F-DEP-004** 完整性闸 | 真修好 | **成立**（⚠️我 t30 作者，仅复跑） | t30 §3 五场景 |
| 11 | **F-DEP-103** lock 未入库 | 未修 | **成立**（⚠️我 t30 作者） | `.gitignore:4` + 未追踪 + `npm ci` 实测 EUSAGE |
| 12 | **F-RT-001** 0600 Windows 无效 | 成立 | **采信 t31 实测**（我未重跑 ACL） | t31：磁盘 `-rw-r--r--`、ACL `Authenticated Users: Modify` |

## B. 我独立跑的 4 个探针

| # | 探针 | 真实输出 |
|---|---|---|
| B1 | `t19-ses-escape-review.mjs` | **EXIT=0**，`BLOCKED=20 / ESCAPED=0` |
| B2 | `t20-board-open.mjs schema` | **EXIT=0**，`rebuilt=false`、`行数 1→1` |
| B3 | `grep -c $'\x08' tools/preflight.mjs` | **0** |
| B4 | `npm run gate > f 2>&1; echo $?` | **EXIT=1**，唯一红项 `[6/6] 自测没跑起来 status=null` = **EPERM**（非代码）；`[2/2] 37 通过 0 失败` |

## C. 反向检验（五面）

| 面 | 结果 |
|---|---|
| 聊天→RCE | **堵死**（argv 数组/无 shell/txt 只进 stdin）。t29 因 EPERM 无法实弹，我复核同一结构结论，**不冒充实测** |
| HTTP token 门 | **服务端且先于 static** ✓ |
| token 进日志 | **不进**；唯一完整值通道是显式 `MINDSERVER_PRINT_TOKEN=1` |
| 提示注入 | `$MEMORY`/`$TO_SUMMARIZE`/`$CONVO` 三处都包；`examples.js` 故意不包（自有数据） |
| 40 提交逻辑错误 | 发现 F-WEB-203 "上限"实为触发条件 —— **但夜班复核席自己已点出且主编照实写"部分修好"，不是新漏** |

**未发现"该 BLOCK 却被放过"的项。**

## D. 明文凭据残留（拿真口令搜，不搜模式）

```
$ PW=$(grep -E "^rcon.password=" server/server.properties | cut -d= -f2- | tr -d '\r'); 长度=32
$ grep -rlF "$PW" docs/                       → 空
$ cd mindcraft && git grep -lF "$PW"          → 空
```
**阴性：真实 32 位口令在 docs/ 与 git 跟踪文件均 0 命中。** 夜班那次"把 rcon 密码 grep 进输出"**只污染会话、无文件残留**。
辅助：docs 里 `rcon.password` 全是叙事/占位（`CHANGE_ME`/`got=abc`/grep 命令）；32+ 位高熵串抽检 10 条全是文件路径/技能名。
**但口令已进过会话 ⇒ ①轮换仍必要**（会话可能被记录）。主编把它列①最高优先是对的，且**没有因为"错误已记录"就不再查后果**——这点做对了。

## E. 需用户动作 6 条：逐条判定

| # | 事项 | 判定 | 理由 |
|---|---|---|---|
| ① | RCON 口令轮换 | **真需要用户** | 选新口令 + **重启服务端**，团队不能启停 |
| ② | `git rm --cached ops.json/whitelist.json` | **真需要用户（但最接近边界）** | 我核实：两文件确被**根仓**跟踪（`ops.json` **341 条全 lvl4**）。命令零风险，**但根仓操作超团队写入范围（仅 docs/audit/）** ⇒ 合法 |
| ③ | F-SEC-204 冒名登录取舍 | **真需要用户** | 三选一含"牺牲手机联机"= 产品决策 |
| ④ | RCON 收 bind `127.0.0.1` | **真需要用户** | 会收窄游戏端口，取决于手机联机 |
| ⑤ | 换 `keys.json` 的 key | **真需要用户** | 新 key 只能从 provider 取 |
| ⑥ | F-DEP-103 部署取舍 | **真需要用户** | lock 入库 vs 降级 npm install = 部署策略 |

**6/6 属实，无团队偷懒 ⇒ 不升级挡门。** 建议（非挡门）：② 可写成一键脚本放 `docs/audit/` 降低门槛，但**执行仍须用户**（根仓权限）。

## F. 与主编的分歧 / 更正

1. **`F-SEC-206` 判定要改**：不是"2/3 漏"，而是 **1 处未覆盖（`*.token` 通配缺失）**；`.env.local` 已被 `.gitignore:79` 的 `.env.*` 覆盖。**不改变"兜底不完整"的结论，但按错清单去补会漏。**
2. **`R3-M1` 在 HEAD 仍未修**：`node tools/craft_diagnostic_reachability_unit.mjs` → **EXIT=1 / 14 PASS / 1 FAIL**。主编 §7 写"必须立刻修"，但它没被修 ⇒ **`gate:full` 仍永久红**。我不改 PASS（基线即红、非本轮引入、commit 门 `npm run gate` 是绿的），但**放行须附一句：`R3-M1` 未修前不得宣称"gate:full 通过"**。
3. **给主编的肯定**：§2 主动点出"4 份无 review 的单子躺在 `verified/`"（自证体系的结构性缺陷），我核对属实（`verified/` 33 份、`done/` **空目录 0 份**）。主编没有护短。

## G. 做不到的

- **聊天→RCE 实弹**：`spawn` EPERM，只能结构确证（与 t29 同）。
- **`npm ci` 全量重装**：会动 `node_modules`，规程禁止。
- **F-RT-001 的 ACL 实测**：采信 t31（我未重跑）。
- **F-DEP-003/004/005/012/103、F-REG-001~004**：因我是 t30 作者，**只复跑不独立判定**。

## H. R1/R2 复核摘要 —— 仍有效

- R1（t23）：改判 5（"队长亲验"降为静态确证）/ 状态拆分 1 / 修正内容 1 / 未登记 4；编号稳定。
- R2（t28）：抽检 12/12 成立、九条遗漏处置全合格、4 探针独立通过；提出两条方法学（`$?` 管道陷阱、`npx` 不可用时直跑 `node node_modules/eslint/bin/eslint.js`）。
- 本 R3 沿用了这两条方法学：**全文所有 exit code 均用 `> f 2>&1; echo $?` 取得，无管道**。
