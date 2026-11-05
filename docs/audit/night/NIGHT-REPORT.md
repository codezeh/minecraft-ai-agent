# 夜班漏洞猎杀 · 持续报告

用户授权：当前目录 `E:\我的世界ai`，token 不限，**并发上限 3**，跑通宵直到叫停。
范围：依赖供应链 / 密钥配置 / 执行体注入 / AI-Agent 安全 / 面板 API（全要，按风险排序）。
修复政策：独立分支自动改 + 逐条提交，不动主干。停止开关：`docs/audit/night/STOP` 或对 captain 说"停"。

---

## 01:45 阶段小结（开工 45 分钟）

### 团队
固定 3 席，吃满三并发：`recon-scout`（侦察）· `patch-smith`（修补）· `gate-keeper`（复核）。
部门制推进：D1 依赖 → D2 密钥 → D3 执行体 → D4 AI/Agent → D5 面板。17 个任务，14 条依赖。

### 已完成
- **D1 依赖部侦察**：10 条（2 high / 3 medium / 5 low）
- **D2 密钥部侦察**：7 条（2 high / 5 medium）
- **D0 门禁基线**：建立完成，含"哪些检查其实是假的"评估
- **D0 历史欠账转化**：24 条待办 + 51 条"已修复"台账（含 5 个假信号的逐条排除）
- **D3 执行体侦察**：进行中

### 今晚最值钱的五个发现（按可利用性）

| id | 级 | 一句话 |
|---|---|---|
| `F-EXEC-201` | **high** | `speak.js:110` 把模型输出拼进 PowerShell / `say` / `espeak` 命令行再 `exec()` ⇒ **聊天可诱导宿主机 RCE**。Windows 侧只转义单引号、双引号未转义；`speak` 默认 false 但在**运行期白名单**里，持 token 客户端可远程打开 |
| `F-SEC-201` | high | `mindcraft/keys.json:2` 明文真实 API key。已核实非 git 泄漏（gitignore 覆盖、从未提交、历史无该串），但 D1 的 postinstall 一旦执行，第一件事就是读它 |
| `F-SEC-202` | high | RCON 开在 `0.0.0.0:25575`（**运行日志实证**，非读配置推测）。明文协议无速率限制 → 同网段可爆破/嗅探，进去即服务器完全接管 |
| `F-EXEC-101` | high | `src/agent/tasks/**` 约 38 处裸 `bot.chat('/…')`，含 `/kill @e[...,distance=..200]` 与 8 条 `/fill` 清 100×100×10。历史审计被 preflight 用"不是运行时链路"的豁免放过，但 `tasks.js` 就是 `!do` 的运行时引擎——豁免理由不成立 |
| `F-DEP-003` | high | `mineflayer+4.33.0.patch` 与实装 4.39.0 完全不匹配，3 处 hunk **零生效** → 今天任何人 `npm ci` 都会在 postinstall 失败 |
| `F-DEP-004` | high | `postinstall: patch-package` = 完整性校验之后的任意代码注入面，14k 行补丁 diff 零 gate 覆盖 |

**最有价值的排序判断**（`recon-scout`）：`F-SEC-206` 必须排在 `F-SEC-201` 之前——两个仓的 `.gitignore` 都不忽略 `.env*` / `secrets.json` / `id_rsa`，若先把密钥搬进 `.env` 再补规则，会当场造出一个**可被 `git add` 提交的明文密钥文件**。修 A 洞时打开 B 洞，这个陷阱抓得准。

**两条口径修正**（`patch-smith` 复核历史结论得出）：
- 00-REPORT 说 `I17` "已在握手门后" **对 HTTP 端不成立**：`mindserver.js:85-92` 的 `app.use` 只做 `?token=` → `Set-Cookie` 然后无条件 `next()`，从不拒绝；握手门 `:103 io.use` 只管 socket.io ⇒ 贴图代理 / `/console` / `express.static` 三个 HTTP 出口**仍零鉴权**。
- `I15` 的 loop_lag 问题更准确的说法是"最大值**没有窗口概念**"，一次抖动后永久污染那句被当成反证引用的日志。

### 今晚修掉的两个真问题（不是漏洞，是让"验证"这个前提成立）

**1. 仓库边界：修复差点全部落进空白** ⚠️ 我排计划时漏掉的硬伤
`mindcraft/` 是**独立 git 仓**，外层 `.gitignore:13` 把它整个排除（外层 `git ls-files mindcraft` = 0）。
只在外层审计仓提交，等于**修复从来没进过任何审计历史**。
已补建 mindcraft 仓内的 `audit/night-20261106` 分支，并确立双仓提交规则。

**2. 门禁整夜恒红：根因不是代码，是检出配置**
`gate:full` 卡在 `preflight_regex_unit`（2 FAIL）。根因排查：仓库 blob 一直是**纯 LF**，是本地 `core.autocrlf=true` 每次检出时把磁盘转成 CRLF（叠加 01:05 那次 fast-forward 重新检出）。
处置：`core.autocrlf=false` + `core.eol=lf`，按 LF 重新落盘 —— **零内容变更、未产生任何提交**。`preflight.mjs` 的 CR 计数 1332 → 0。
意义：如果没修，`.githooks` 会恒红 → 全队只能 `SKIP_GATE=1` 绕过 → 今晚所有"已验证"都是假的。

顺便清掉了 Windows 上的 stat 缓存假脏（曾误报 421 个 `M`，实际 `git diff` 为空、两侧 blob sha 相同）。**教训：判断改动一律以 `git diff` 为准，不看 `git status` 行数。**

### 门禁真基线（captain 实测）

```
cd mindcraft && npm run gate:full  → exit 0
  settings_check ✅ ｜ preflight_regex_unit ✅ 37/0 ｜ preflight ✅ ｜ lint_hard ✅ ｜ unit_all ✅ 96/97（4 个真实跳过）
cd web && npm run typecheck        → exit 0
npm run lint                       → 197 errors（存量基线，不可新增）
```

### 一个必须交代的作业模式变化

成员会话是 `workspace-write` 派生的，**不能 spawn 子进程、不能 `git commit`、不能删文件**；captain 会话是 `danger-full-access`，全部可以。这是会话策略差异，热改不了。
于是改成：**成员判断，captain 执行**。成员只写文件 + 写 manifest，captain 逐条提交并回填 sha。
副作用是好的：全队只有一个 gate runner，消除了"两人同时跑 gate 互相污染"的风险。
副作用是坏的：**提交权与判决权分离后，captain 同时是执行者和最终复核人，独立性与理想状态有差距**——已要求 gate-keeper 对每条改动做独立代码级推演，不依赖我的 gate 输出下结论。

---

## 待用户决定（promise：攒着一次性说，不半夜弹）

1. **`F-SEC-204` 冒名登录风险**：离线模式 + 白名单只有 `HEAVENZEH` + `bind: all` ⇒ 把客户端用户名改成 `HEAVENZEH` 就能以主人身份进服。另外 `ops.json` 有 **341 个 lvl4 op bot**（测试刷的）且被 git 跟踪，一旦关白名单就是 341 个可用 op 账号。
   **这是你自己在 `config/network.json` 里权衡过的取舍**（文件里有写）。三条真修法——加登录插件 / `online-mode=true` / 收窄 bind——**都会影响"手机能不能连"**，所以没替你决定。
2. **`F-SEC-202` RCON 收 bind 到 `127.0.0.1`**：会连带收窄游戏端口可达性。若手机是走局域网直连，这条要你确认。
3. **`F-DEP-007` zod 3.x → 4.x**：修复需要跨主版本，今晚只做缓解（响应体尺寸上限 + 超时），不升级。
4. **需要你手动轮换的密钥**：`keys.json` 里那把（修代码不等于密钥安全）；RCON 口令的旧 8 位弱口令残留 3 份备份（已清成 `CHANGE_ME`，不删文件）。

---

## 停止方式
- 对 captain 说"停"
- 或创建空文件 `docs/audit/night/STOP`

两个都生效，成员会在下一个检查点收工。
