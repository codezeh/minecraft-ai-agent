# 01 · 构建/测试门禁实测成绩单（R5 · 第五轮实测型验证）

> 原则：**只记录真跑出来的东西**。每条都有命令原文、退出码、日志落盘路径、失败报错原文。
> 本文件不改任何产品代码（`git status --porcelain` 全程为空，见 §1）。

## 1. 实测环境（一次性锚定，避免"跑的是哪个树"说不清）

| 项 | 值 | 取证方式 |
|---|---|---|
| 日期 | 2026-11-08 14:55–15:12 (+08:00) | 每个日志首尾都有 `date -Is` 时间戳 |
| 工作目录 | `E:\我的世界ai\mindcraft` | — |
| node / npm | v24.16.0 / 11.13.0 | `node -v` / `npm -v` |
| mindcraft HEAD | `33b432703ccf2a4b8c2b47f3cbc44825defed602`（`feat(identity): 允许离线 + 保留正版验证开关 (R4 t27)`） | `git rev-parse HEAD` |
| 父仓 HEAD | `92d405caca6ef74bb3caa5f15d6e16782348f553` | `git rev-parse HEAD`（`E:\我的世界ai`） |
| 工作树状态 | **干净**：`git status --porcelain` 输出为空（两个仓都查了，跑门禁前后都查） | 无产品代码改动 |
| 本机 spawn 能力 | **可用**（本轮关键前提，见 §3 的反证） | `docs/audit-r5/evidence/gates/00-spawn_capability.log` |

## 2. 门禁总表

| # | 项 | 命令（原文） | 退出码 | 绿/红 | 红的原因一句话 | 证据文件 |
|---|---|---|---|---|---|---|
| 1 | 补丁完整性 | `node tools/patch_integrity.mjs` | 0 | 🟢 绿 | —（5 补丁内容与基线一致；5 包版本一一对应；6 哨兵全命中） | `evidence/gates/01-patch_integrity.log` |
| 2 | 凭据文件名 | `node tools/check_secret_filenames.mjs` | 0 | 🟢 绿 | —（已跟踪 645 文件零命中；工作区 `keys.json` 未跟踪，仅提醒） | `evidence/gates/02-check_secret_filenames.log` |
| 3 | settings 键一致性 | `node tools/settings_check.mjs` | 0 | 🟢 绿 | —（零漏声明；2 个"面板有、agent 无"仅供核对，不判失败） | `evidence/gates/03-settings_check.log` |
| 4 | 扫描器正则单测 | `node tools/preflight_regex_unit.mjs` | 0 | 🟢 绿 | —（37 通过 / 0 失败） | `evidence/gates/04-preflight_regex_unit.log` |
| 5 | 启动自检 preflight | `node tools/preflight.mjs` | 0 | 🟢 绿 | —（7 段全绿，含 §6 自测 7/7、A 档 0 处） | `evidence/gates/05-preflight.log` |
| 6 | 硬 lint | `node tools/lint_hard.mjs` | 0 | 🟢 绿 | —（`no-undef = 0`、`no-floating-promise = 0`，扫 175 文件） | `evidence/gates/06-lint_hard.log` |
| 7 | 全量 eslint | `npm run lint` | **1** | 🔴 **红** | **200 errors / 47 文件**：103 `semi` + 77 `require-await` + 20 其它（含 8 条**非风格**、指向真实风险，见 §4） | `evidence/gates/07-npm_lint.log` |
| 8 | 离线单测全量 | `node tools/unit_all.mjs` | 0 | 🟢 绿 | —（**130/130 脚本通过**，4 个按设计跳过；另见 §3） | `evidence/gates/08-unit_all.log` |
| 9a | 门禁串 | `npm run gate` | 0 | 🟢 绿 | —（= 上表 1–6，逐段 ✓） | `evidence/gates/09a-npm_gate.log` |
| 9b | 全量门禁 | `npm run gate:full` | 0 | 🟢 绿 | —（= gate + unit_all，**130/130 通过**；历史红灯已不复现，见 §3） | `evidence/gates/09b-npm_gate_full.log` |
| 10 | 前端 typecheck | `npm run typecheck`（cwd=`E:\我的世界ai\web`） | 0 | 🟢 绿 | —（`vue-tsc --noEmit` 无输出） | `evidence/gates/10a-web_typecheck.log` |
| 10 | 前端 build | `npm run build`（cwd=`E:\我的世界ai\web`） | 0 | 🟢 绿 | —（vite 6.4.5，96 模块，`✓ built in 1.73s`） | `evidence/gates/10b-web_build.log` |

汇总：**12 项命令中 11 绿 1 红**。唯一红灯是 `npm run lint`（200 条 eslint error）。
`gate` / `gate:full` 本身**不包含** `npm run lint`（见 `package.json` 的 `scripts.gate`），所以"门禁绿"与"eslint 红"同时成立，不矛盾——这点必须写清楚，否则会有人拿 gate 绿去盖掉 lint 红。

## 3. 核实历史结论：「gate:full 因 [6/6] 自测没跑起来 status=null（EPERM）而红」

**结论：该历史结论在当前 HEAD / 当前本机不再成立；当时那次红是"本机环境限制"，不是代码缺陷。**

历史出处（原文引用）：`docs/audit/04-tests-gates.md:111`

> 「§6 失败同样是本环境 EPERM（`preflight.mjs:882` `spawnSync` 跑 `deps_injection_audit.mjs --selftest`，`status=null`）。**这一段的降级设计是正确的**……」

同文件 `:52` 有当时的报错原文：`ERR code= EPERM status= null msg= spawnSync D:\\Node\\node.exe EPERM`。

### 3.1 本轮实测（四条互相独立的证据）

1. `node tools/preflight.mjs` → **`[6/6]` 全绿**，退出码 0：
   ```
   [6/6] 依赖注入审计（A 档 = 单测能测到、生产走不到的死分支）
     ✓ 扫描器自测 7/7 通过（6 种代码形态都能看见，才开始信任审计）
     ✓ A 档 0 处（没有"单测能测到、生产走不到"的死分支）
   ```
   证据：`evidence/gates/05-preflight.log:46-48`；`npm run gate` 里同样一行 `evidence/gates/09a-npm_gate.log:137-139`。
2. 把 §6 内部那条子进程命令**单独直跑**，证明 `deps_injection_audit.mjs --selftest` 自己就能跑：
   ```
   PASS  ① … ⑥ fallback 只取到表达式边界
   扫描器自测：7 passed, 0 failed
   ```
   证据：`evidence/gates/00b-deps_selftest_direct.log`（exit 0）。
3. 直接探测 `spawnSync` 能力（历史上就是它 EPERM）：
   ```
   spawnSync status = 0 | error = null
   child stdout = "child ok"
   ```
   证据：`evidence/gates/00-spawn_capability.log`。
4. 旁证：`unit_all.mjs` 用 `execFileSync` 派生了 **130 个子进程**并全部跑完（`130/130 个脚本通过`）——若本机禁止派生进程，这一条根本不可能绿。

### 3.2 定性

| 维度 | 判定 | 理由 |
|---|---|---|
| 历史红灯"是否仍在" | **不复现** | `gate:full` 退出码 0；`[6/6]` 打印 `7/7 通过` |
| 历史红灯"是不是代码缺陷" | **不是** | 失败点是 `spawnSync` 返回 `status=null`（EPERM），代码路径本身正常；且当时项目文档自己就把它归为环境 |
| 当时的门禁行为是否正确 | **正确（fail-closed）** | 跑不起来时它没有给绿灯，而是明确判失败并打印 `status=` 与输出片段——这是全仓最好的一处门禁设计，**不应作为缺陷上报** |
| 本轮为何转绿 | **环境差异**，非代码修复 | 当前 shell 允许派生进程（§3.1 证据 1–4）；本轮未改任何代码（工作树干净） |

> 反面提醒：`preflight.mjs` §6 的"跑不起来即红"会让**在受限沙箱里做的审计**误以为代码坏了。**引用历史结论的文档必须连同"该结论附带了环境前提"一起引用**，否则会长期误导。

## 4. 唯一红灯：`npm run lint`（200 errors）

命令原文：`npm run lint` → 实际执行 `eslint src main.js`，退出码 **1**。
原始报错尾部：`✖ 200 problems (200 errors, 0 warnings)` / `103 errors and 0 warnings potentially fixable with the '--fix' option.`
证据：`evidence/gates/07-npm_lint.log`（18 KB，逐条 file:line:col + 规则名）。

按规则分解（统计自日志）：

| 规则 | 条数 | 性质 |
|---|---|---|
| `semi` | 103 | 风格（缺分号） |
| `require-await` | 77 | 风格/设计债（`async` 无 `await`） |
| `no-empty` | 8 | 低（空块，可能是吞异常） |
| `no-irregular-whitespace` | 4 | 低（不可见字符，可能造成"看起来正常其实不同"的字符串比较） |
| `no-useless-escape` | 2 | 低 |
| `no-prototype-builtins` | 2 | **中**（`obj.hasOwnProperty()` 对 `Object.create(null)` 会抛） |
| `no-fallthrough` | 1 | **中**（`switch` 漏 `break`，会串到下一 case） |
| `no-ex-assign` | 1 | **中**（改写 `catch (e)` 参数，丢失原始错误） |
| `no-dupe-keys` | 1 | **中**（对象字面量重复键，后者静默覆盖前者） |
| `no-control-regex` | 1 | **中**（正则含 `\x00 \x08 \x0b \x0c \x0e \x1f` 控制字符） |

**去掉风格项后仍有 8 条值得单独进缺陷清单**（文件:行 已从日志中还原）：

| 文件:行 | 规则 | 一句话风险 |
|---|---|---|
| `mindcraft\src\agent\library\flow_craft.js:415:9` | `no-dupe-keys`（`Duplicate key 'count'`） | 对象字面量里 `count` 写了两遍，前一个静默失效——若两处语义不同则是真算错 |
| `mindcraft\src\agent\commands\index.js:204:13` | `no-fallthrough` | `case` 漏 `break`，会落进下一个分支 |
| `mindcraft\src\agent\action_manager.js:422:13` | `no-ex-assign` | 覆盖 `catch` 参数，原始异常信息丢失（排障时看不到真因） |
| `mindcraft\src\agent\npc\controller.js:202:37` | `no-prototype-builtins` | 无原型对象上 `hasOwnProperty` 会抛 TypeError |
| `mindcraft\src\agent\tasks\construction_tasks.js:149:53` | `no-prototype-builtins` | 同上 |
| `mindcraft\src\utils\text.js:49:18` | `no-control-regex` | 正则里裸控制字符（历史报告 §[6] 那处 0x08 就在这一带，见 `docs/audit/00-REPORT.md` 第 26 条） |
| `mindcraft\src\agent\commands\queries.js:59:21` | `no-useless-escape` | 多余转义，语义可能与本意不同 |
| `mindcraft\mindserver.js:491:46` | `no-useless-escape` | 同上 |

**定性：这是代码侧真实状态，不是环境限制。** 依据：`eslint` 能正常解析全部文件（失败项都是**规则命中**，不是 `Parsing error`，也不是 spawn 失败）；同一台机器上 `lint_hard`（同引擎、更窄规则集）能绿，说明工具链本身健康。
**但严重度不等于"阻断"**：`npm run lint` 不在 `scripts.gate`/`gate:full` 的链上，且 `tools/lint_hard.mjs` 的输出明确写着「semi / require-await 等历史欠账**不在本门禁范围**」——即团队是**知情的**，属于显式记账的债务（103+77=180 条），而不是新引入的回归。真正需要单独立项的是上表那 8 条非风格项。

## 5. 日志清单（`docs/audit-r5/evidence/gates/`）

| 文件 | 内容 | 大小 |
|---|---|---|
| `00-spawn_capability.log` | `spawnSync` 能力探测（§3 反证） | 小 |
| `00b-deps_selftest_direct.log` | `deps_injection_audit.mjs --selftest` 直跑（§3 反证） | 小 |
| `01-patch_integrity.log` | 补丁完整性 | 890 B |
| `02-check_secret_filenames.log` | 凭据文件名扫描 | 563 B |
| `03-settings_check.log` | settings 键一致性 | 641 B |
| `04-preflight_regex_unit.log` | 扫描器正则单测 37 条 | 3.5 KB |
| `05-preflight.log` | preflight 全 7 段 | 3.4 KB |
| `06-lint_hard.log` | lint:hard | 300 B |
| `07-npm_lint.log` | **eslint 200 条**（红灯原始输出） | 18 KB |
| `08-unit_all.log` | 离线单测全量（含逐脚本 PASS/FAIL 与总览） | 264 KB |
| `09a-npm_gate.log` | `npm run gate` | 9 KB |
| `09b-npm_gate_full.log` | `npm run gate:full` | 134 KB |
| `10a-web_typecheck.log` | 前端 `vue-tsc --noEmit` | 163 B |
| `10b-web_build.log` | 前端 `vite build` | 906 B |

每个日志首行是 `$ 命令原文`，末行是 `--- exit: N at <ISO 时间> ---`，可单独复算。

## 6. 复现命令（拷贝即用）

```bash
# 全部，按顺序；每个都会把输出写进 docs/audit-r5/evidence/gates/
cd /e/我的世界ai/mindcraft
node tools/patch_integrity.mjs
node tools/check_secret_filenames.mjs
node tools/settings_check.mjs
node tools/preflight_regex_unit.mjs
node tools/preflight.mjs
node tools/lint_hard.mjs
npm run lint            # ← 唯一红，退出码 1
node tools/unit_all.mjs # 最慢，约 5 分钟
npm run gate
npm run gate:full
cd /e/我的世界ai/web && npm run typecheck && npm run build
```

## 7. 给下游的结论（一句话版）

- **门禁链（gate / gate:full）在当前 HEAD 是绿的**；历史那次 "`[6/6]` status=null (EPERM)" 红**是环境限制，不是缺陷，已被本轮 4 条独立证据推翻**（工作树干净，无代码修复）。
- **真正的红只有 `npm run lint`：200 条**，其中 180 条是**已被书面承认的风格欠账**（`semi`/`require-await`），另外 **8 条非风格项**（`no-dupe-keys`/`no-fallthrough`/`no-ex-assign`/`no-prototype-builtins`×2/`no-control-regex`/`no-useless-escape`×2）建议逐条进缺陷清单核验真伪。
