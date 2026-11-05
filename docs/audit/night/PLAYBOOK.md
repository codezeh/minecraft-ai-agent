# 夜班漏洞猎杀协议 v1（2026-11-06 起）

目标仓库：`E:\我的世界ai`（mindcraft 执行体 / web 面板 / server 配置 / scripts）
唯一分支：`audit/night-20261106`（禁止提交到 main）
并发上限：3 个成员（recon-scout / patch-smith / gate-keeper）

---

## 0. 停止开关（任何成员、任何时刻优先）

- 若 `docs/audit/night/STOP` 存在 → 立即停止新工作，把手上的事收尾成一次提交或一次回退，
  在 `docs/audit/night/log-<你的名字>.md` 写一行收工记录，然后向 captain 报告 "HALTED"。
- 用户直接说停时，captain 会创建该文件。

## 1. 文件队列（无锁，靠 rename 原子性）

```
docs/audit/night/queue/
  inbox/     侦察兵写入的待办 finding（一条一个 .md）
  claimed/   修补工程师已认领（mv 进来 = 拿到锁）
  done/      已修复并提交，等待复核
  verified/  复核通过
  rejected/  复核打回（文件内追加 reason 段后移回 inbox/）
```

认领 = `mv inbox/<id>.md claimed/<id>.md`。mv 已存在的目标会失败，这就是互斥。

## 2. finding 文件格式（侦察兵产出，必须齐字段）

```yaml
id: F-<区域码>-<三位序号>          # 例 F-MC-001 / F-WEB-002 / F-SRV-003
severity: critical|high|medium|low
class: secret|authz|injection|ssrf|path|deps|crypto|llm|race|config
file: <相对路径>:<行号>
evidence: |
  <能让人 5 分钟内独立复现的最小证据：代码片段 / 命中的调用链 / 依赖树>
exploitability: |
  <攻击者要什么前置条件、能拿到什么、影响半径>
suggested_fix: |
  <具体到函数/参数级，不要写"加强校验"这种话>
verify: <修完怎么证明真的好了：命令、断言、或复现步骤>
discovered_by: recon-scout
```

反面教材（会被打回）："使用了 eval，建议避免" —— 没有位置、没有可利用性、没有验证方式。

## 3. 修补工程师硬规则

- 一次只 claim 一个 finding，改完提交后再 claim 下一个。
- 每条修复 = 一个独立 commit，格式：
  `fix(security): <区域> <class> — F-MC-001`
  body 必须写：finding id、改了什么、为什么这样改不会改坏别处、怎么验证的。
- 优先级：critical > high > medium > low；同级按"影响半径大 + 改动小"先做。
- 修不动 / 需要停机 / 需要重建世界 / 需要用户拍板的 → 不硬改。
  在 finding 文件追加 `blocked:` 段说明原因，`mv` 到 `done/`，交给 gate-keeper 判定，让 captain 转告用户。
- **红线**（碰了算事故）：
  - 不动 git 主干 main，不发 `git push`，不改 remote
  - 不修改任何真实密钥/token/证书/密码的值（只做"搬家到环境变量 + 加 .gitignore + 提醒轮换"）
  - 不新增第三方依赖；必须升级依赖时只升已有 lock 内版本，并在 commit body 写 CVE 号
  - 不改 `backups/` `logs/` `tmp/` `.atom-v2-backup/` `server-test/` 下的任何内容
  - 不做大规模重构、不顺手美化代码、不改无关文件（一个 commit 只解决一个 finding）
- 每轮收尾必须跑验证，结果写进 commit body 或 log。

## 4. 验证门（gate-keeper 的判据，也是修补工程师的自检）

```bash
# mindcraft（执行体）—— 这是主门
cd mindcraft && npm run gate:full
# web 面板
cd web && npm run typecheck && npm run build
# 存量记录：node mindcraft/tools/unit_all.mjs 已在 gate:full 内
```

判定 rule：
- PASS：目标 finding 的 `verify` 通过 **且** `gate:full` 与 web 检查与基线一致（无新增失败）。
- FAIL：新增任何 lint/unit/typecheck 失败，或 finding 的 verify 没过，或改动越界。
- FAIL 的处置：finding 文件追加 `reason:` + 期望修法，移回 `inbox/`，并在 log 里点名叫 captain 知道。

## 5. 报告与日志

- 每个成员维护自己的 `docs/audit/night/log-<名字>.md`，一轮一条，格式：
  `## R<轮次> <时间> | 做了什么 | 结论 | 阻塞`
- gate-keeper 维护 `docs/audit/night/baseline.md`：仓库在未改动状态下的门禁真实结果（第一次跑出来的就是基线）。
- captain 汇总成 `docs/audit/night/NIGHT-REPORT.md`，逐小时追加，用户早上直接看这一份。

## 6. 部门制（本队组织方式）

三个席位固定：**1 侦察 + 1 修补 + 1 复核**，一起做完一个部门再一起进下一个部门。
任何席位提前完工，可以立刻去下一部门领对应席位（不必等另两人）。

| 部门 | 区域码 | 范围与判据 |
|---|---|---|
| D1 依赖与供应链部 | DEP | `package.json` / lock / 传递依赖的实际 CVE；npm audit 结果要与 lock 版本对得上，不许凭印象报；含 `mindcraft`、`web` 两处 |
| D2 密钥与配置部 | SEC | `.env*`、`config/**`、`server/**`、根目录 `*.mjs` 探针、启动 bat、`logs/**` 里落的敏感信息、前端 bundle 里的硬编码；**只做外部化+忽略+提醒轮换，绝不改真值** |
| D3 执行体与注入部 | EXEC | `mindcraft/src/**`、`main.js`、`tools/**` —— 命令拼接、路径穿越、eval/vm、fs 边界、外部输入进执行链 |
| D4 AI/Agent 部 | AI | LLM 输出驱动工具调用的路径、提示注入能否改行为、系统提示与外部内容是否混同、限流与配额、沙箱逃逸面 |
| D5 面板与API部 | WEB | `web/**`、`scripts/**` —— 面板接口鉴权/越权、注入面、构建脚本被污染的风险、CSP 与静态资源 |

部门顺序按"今晚最容易出结果 + 修起来最不伤筋动骨"排：D1→D2→D3→D4→D5。

## 7. 并发安全（三人同时干活时必须遵守，出事就是全队返工）

- **修补：按文件分区。** 认领前先看 `claimed/` 里有没有人正在改同一文件；有就退让，先做别的。
  同一文件同一时间只能有一个修补者。`git add` 必须逐文件显式列出，禁止 `-A` / `.`。
- **提交前先 `git pull --rebase` 自己的分支无意义（单人本地分支），改为：先 `git status` 确认无他人未提交改动，再提交。**
  发现 index 里有不属于自己的文件 → 停下来，不要提交，向 captain 报冲突。
- **复核：gate 必须隔离跑。** 三人共享 `node_modules` / vite 缓存，同时跑会互相污染。
  复核只用 `git worktree add` 建独立工作树跑 gate，或在 `log-gate-keeper.md` 登记"我独占 gate 中"，跑完注销。
  两个复核/修补任务不得同时跑 `npm run gate:full`。
- **绝不为过门而放宽规则**：改 eslint 配置、`--no-verify`、删测试、注释掉检查、catch 空异常 —— 一律视为事故，复核官直接 reject 并上报。

---

# §8 作战裁决（2026-11-06 01:40 起生效，覆盖前文冲突之处）

## 8.1 权限真相：成员会话 ≠ captain 会话

| | sandbox | 能写文件 | 能 spawn 子进程 | 能 git commit | 能删文件 |
|---|---|---|---|---|---|
| **captain** | danger-full-access | ✅ | ✅ | ✅ | ✅ |
| recon-scout / patch-smith / gate-keeper | workspace-write（派生时固定，不可热改） | ✅ 内容可写（DSH write/edit 工具） | ❌ EPERM | ❌ index.lock 被拒 | ❌ |

**因此确立铁律：captain 是唯一执行者，成员是判断者。**

- **只有 captain 跑 `gate:full`、`git commit`、`rm`。**
- 成员不得再尝试 git / 删除 / spawn，也不需要为此道歉或证明——**这是会话限制，不是能力问题**。
- 这顺带消除了 §7 的"两人同时跑 gate 互相污染"风险：全队只有一个 gate runner。

## 8.2 双仓提交（原计划的最大硬伤，已补）

`mindcraft/` 是独立 git 仓（有自己的 `.git`），外层 `.gitignore:13` 把它整个排除，外层仓 `git ls-files mindcraft` = **0**。
⇒ 只在"外层审计仓"提交 = **修复根本没有进任何审计历史**。

| 改动位置 | 提交到哪 |
|---|---|
| `mindcraft/**` | mindcraft 仓的 `audit/night-20261106` 分支 |
| `web/**` `scripts/**` `config/**` `docs/**` 根 `*.mjs` | 外层仓的 `audit/night-20261106` 分支 |

两个分支均已建好。**每张 finding 的 `## review` 段必须写明实际改动的那个仓的 sha。**

## 8.3 门禁真基线（captain 实测，2026-11-06 01:35）

```
cd mindcraft && npm run gate:full   → exit 0
  settings_check        ✅
  preflight_regex_unit  ✅ 37 通过 0 失败
  preflight             ✅（含 §6 依赖注入审计，能起子进程）
  lint_hard             ✅ no-undef=0 · no-floating-promise=0（扫 167 文件）
  unit_all              ✅ 96/97 通过 · 4 个真实跳过（--real 需真机）
cd web && npm run typecheck          → exit 0
npm run lint                         → 197 errors（存量基线，不可新增）
```

**判据**：`gate:full` 绿 + `web typecheck` 绿 + `npm run lint` 不超 197 且目标文件不新增。
gate-keeper 早期提出的"89/97 等价基线"**作废**（其前提已不成立）。

**此前的 CRLF 事故已修复**：根因是本地 `core.autocrlf=true` 把纯 LF 的仓库检出成 CRLF（与 01:05 那次 fast-forward 重新检出叠加）。已设 `core.autocrlf=false`+`core.eol=lf` 并按 LF 重新落盘，**零内容变更、未产生任何提交**。`preflight.mjs` 的 CR 计数 1332 → 0。

**版本库注意**：`git status` 在 Windows 上会出现 stat 缓存假脏（曾误报 421 个 `M`，但 `git diff` 为空、两侧 blob sha 相同）。已用重建索引清除。**判断是否有改动，一律以 `git diff` 为准，不看 `git status` 的行数。**

## 8.4 依赖审计口径（recon-scout 实测，全队遵守）

`npm audit` 必须显式指定官方源，默认的 `registry.npmmirror.com` **不支持 audit 端点**（404 NOT_IMPLEMENTED），会得到假失败：
```
npm audit --json --registry=https://registry.npmjs.org
```

## 8.5 finding 编号分段（互不撞号）

| 段位 | 来源 |
|---|---|
| `0xx` | recon-scout 现场侦察（F-DEP-0xx / F-SEC-0xx / F-EXEC-0xx …） |
| `1xx` | patch-smith 从历史审计转化的欠账 |
| `2xx` | 侦察第二部门起的新段 |
| `GATE-` | 门禁与流程类（gate-keeper 产出） |

`mv` 只保证"认领"互斥，**不保证写入互斥**（`cat >` 会覆盖同名文件）——所以分段是硬约束，不是风格。

## 8.6 成员交付格式：manifest 制

成员能写文件但不能提交，所以每完成一批改动必须在 `docs/audit/night/manifest-<部门>.md` 追加：
```
## <finding id>  [ready-for-commit | blocked]
改动文件: <逐文件，标明新增/修改>
需 captain 代为删除: <路径 或 无>
commit message 草稿: <subject + body>
自检: <跑了什么 + 输出摘要>
风险与回滚: <一句话>
```
captain 据此逐条提交，并把 sha 回填给复核席。

## §8.7 复核可追溯性（2026-11-06 02:10 立规，因实际违规而立）

**修补者不得删除或清空 finding 文件。**

起因：D1 收尾时，`F-DEP-003/004/005/006/012` 五条的 finding 文件被清空，`inbox/` 和 `done/` 里都不存在
⇒ 复核席只能对着 commit 和修补者的摘要做复核，**无法按"读原始单"的规程独立判断**。
这削弱了整个复核环节的意义：复核的前提是"单子还在，我能自己读需求"。

正确做法：
- 修补者：只 `mv`，不覆盖、不删除。认领 → `claimed/`，改完 → `done/`（文件内容保留并在末尾追加 `## patch`）。
- 复核席：判完 → `verified/` 或打回重建单放回 `inbox/`。
- 队列里的文件是**审计证据**，不是中间垃圾。谁清空它们，谁就在销毁复核依据。

## §8.8 编辑含中文的 .ps1 / .bat 后必须验 BOM

`scripts/start-panel.ps1` 的 UTF-8 BOM 在编辑过程中被工具吞掉（HEAD 首字节 `ef bb bf` → 改后 `23 20 4d`）。
该文件头注释写明"所有中文都在这里（UTF-8+BOM）"，而 **PowerShell 5.1 无 BOM 会把中文读成 ANSI 乱码**。

规矩：改完任何含中文的 `.ps1` / `.bat`，立刻验
```
head -c 3 <file> | od -An -tx1    # 必须是 ef bb bf
```
captain 提交前也必须验一遍（本次由 captain 发现并恢复）。

## §8.9 修复的连带后果检查（本次新增，因踩到）

**修完 A 面后，必须问一句：还有谁在消费 B 面？**

实测案例：`F-SEC-205` 把 token 从"无条件打印"改成"只印指纹 + 写文件"，
但 `web/scripts/stop-all.mjs` 从来就没带过 token ⇒ 改完后"停止面板"彻底没救
（以前还能手抄日志里的 token 救一下），失效提示还是"超时（mindserver 可能没开）"——**把人往错方向带**，
用户的实际反应是直接关窗口 ⇒ 非优雅关停 ⇒ 世界存档未刷盘风险。

同类前科：`F-SEC-206` 必须先于 `F-SEC-201`（否则修 A 洞打开 B 洞）。
⇒ **每条修复的 manifest 里必须有一行"连带后果检查"**：这个改动影响了哪些消费方？逐个点名。

## §8.10 secret 类 finding 必须留指纹（复核不依赖任何人自述）

起因：复核席要证明"修补过程没碰真实密钥"，但它手上没有任何可信凭据——
除非 finding 当初就把指纹留下来。

规则：**记录任何密钥/口令/令牌时，只允许写以下四种形式，永不抄明文**
1. 前缀 4-6 位（如 `sk-0aa7…`）
2. 尾 4 位
3. 总长度（如 `len=67`）
4. **sha256 前 16 位**（如 `7396a9cbdd8e0227`）

并且同时记录 **mtime**（如"停在 2026-10-18，早于今晚全部工作"）。

效果（本轮实证）：复核席靠 `7396a9cbdd8e0227` 逐字符比对 + mtime 未变，
在不接触明文的前提下闭环证明了"key 未被修改"。**这比任何人的"我没改"都硬。**

## §8.11 含 secret 的文件禁止直接 diff

复核官本轮**两次**在同一类动作上把 `rcon.password` 明文打进会话输出：
拿 `server.properties` 与备份做对比。**这不是偶然——diff 一个含 secret 的文件，
默认行为就是把 secret 打出来。**

规矩：对含 secret 的文件做任何比对前，先过滤：
```
diff <(grep -v '^rcon.password' A) <(grep -v '^rcon.password' B)
# 或只输出哈希前缀：
grep '^rcon.password' A | sha256sum
```
违规后果：会话记录本身就是泄漏面，且无法撤回 ⇒ 直接抬升"必须轮换"的优先级。
