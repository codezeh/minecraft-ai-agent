# manifest · GATE-WEB 批（t25，7 条）

> 执行：gate-keeper ｜ 2026-11-06 12:35–13:0x
> 范围：`src/agent/commands/index.js`、`src/mindcraft/public/settings_spec.json`、`tools/settings_check.mjs`、
> `tools/companion_mode_unit.mjs`(新)、`src/mindcraft/mindserver.js`、`src/agent/library/composite_registry.js`、
> `src/agent/library/flow_craft.js`、`scripts/start-panel.ps1`、两仓 `.gitignore`、`web/tsconfig.json`、
> `web/src/stores/terrain.ts`、`web/src/types/three-shim.d.ts`(新)
> **未碰禁区**：`src/models/`、`src/agent/tasks/`、`skills.js`、`executor.js`、`loop_lag.js`、`unit_all.mjs`、`eslint.config.js`

---

## 0. 验证状态总表（先看这个再往下读）

| # | 条目 | 改动 | 验证状态 |
|---|---|---|---|
| ① | `F-GATE-001` + `F-AI-204` | ✅ 已落盘 | ✅ **已实测**（70→8、单测 7/0、settings_check 例外清空） |
| ② | `F-EXEC-112` | ✅ 已落盘 | ✅ **已实测**（11/11 用例，含拒绝原因文本） |
| ③ | `F-EXEC-111` | ✅ 已落盘 | ✅ **已实测**（语法 + 4 个相关单测全绿） |
| ④ | `F-REG-004` | ✅ 已落盘 | ✅ **已实测**（BOM `ef bb bf` + PowerShell `SYNTAX_OK`） |
| ⑤ | `F-RT-004` | ✅ 已落盘 | ✅ **已实测**（两仓 4 项新规则生效 + 回归 + 例外恢复） |
| ⑥ | `F-WEB-102` | ⚠️ **代码已改，验证未完成** | ❌ **未验证** —— 本会话 `ops_bash` 运行时故障（见 §6） |

> **⑥ 我不声称已验。** 改前/改后的实测数字在 §6，但"改后应为 0 error"这一步**没跑到**。

---

## 1. ① `F-GATE-001` + `F-AI-204`（一声销两账）

### 改了什么
1. **`src/agent/commands/index.js`** —— `isVisibleToModel()` 默认方向反转：
   ```js
   - if (!settings.companion_mode) return true;
   - return COMPANION_COMMANDS.includes(commandName);
   + if (settings.companion_mode === false) return true;   // 显式关闭收敛 ⇒ 全开
   + return COMPANION_COMMANDS.includes(commandName);      // 默认（含键缺失）⇒ 收敛
   ```
   判据用 `=== false` 而非 `!== true`：**键缺失是"配置没写"，不该等价于"用户要求全开"**。
2. **`src/mindcraft/public/settings_spec.json`** —— 正式声明 `companion_mode`（`type: boolean`, `default: true`），
   出现在 `load_memory` 之后。描述里写明了"default true = 收敛到 8 条；只有显式 false 才全开"。
3. **`tools/settings_check.mjs`** —— 从 `KNOWN_UNDECLARED` 删掉 `companion_mode` 那条例外
   （保留空 Map 与机制，注释里写明"本条已解决"）。**不删机制**，否则以后再有漏声明就没地方登记。
4. **`tools/companion_mode_unit.mjs`（新）** —— 7 条断言钉死三种语义 + 一条类型健壮性。

### 怎么验证（实测输出）
```
$ node tools/settings_check.mjs
  扫描 158 个模块…提取 27 个键；spec 声明 29 个。
  §1 代码读了但没声明：✓ 无（零漏声明）
  §2 已登记的例外：（无）          ← companion_mode 已脱离例外 ✅
  ✓ settings 键一致性检查通过      EXIT=0

$ node -e "…统计 isVisibleToModel 通过数…"
  注册命令总数: 70
  白名单条数  : 8
  键缺失时可见: 8 → !map,!stop,!goToPlayer,!followPlayer,!collectBlocks,!placeHere,!buildPlatform,!stay

$ node tools/companion_mode_unit.mjs
  7 PASS / 0 FAIL  EXIT=0
  其中：键缺失⇒8 条 / 显式 true⇒8 条 / 显式 false⇒70 条 / "false"字符串⇒8 条（不误判）
```

### 回滚
```bash
git checkout -- src/agent/commands/index.js src/mindcraft/public/settings_spec.json tools/settings_check.mjs
rm -f tools/companion_mode_unit.mjs
```

---

## 2. ⚠️ 行为变更（单列，必读）

**这是本批唯一会改变用户可感知行为的改动。**

| | 改前 | 改后 |
|---|---|---|
| 面板创建的 agent，**模型可见命令** | **70 条**（键缺失 ⇒ 恒 true） | **8 条**（键缺失 ⇒ 收敛） |
| `main.js` 直启的 agent | 8 条（若 settings.js 显式写了 true） | 8 条（不变） |
| 玩家在游戏里**手输**其它命令 | 照常可用 | **照常可用**（本改动只影响"给模型看的文档"） |

**用户会感觉到什么**：如果她之前"什么都会做"，改后会明显**变笨**——只能挑
`!collectBlocks / !followPlayer / !goToPlayer / !placeHere / !buildPlatform / !map / !stay / !stop` 这 8 条，
不再自己挑别的命令试。**这是方案 §12 的原本设计意图，不是退化。**

**恢复办法（唯一开关）**：在该 agent 的 settings 里**显式**设
```json
"companion_mode": false
```
⇒ 立即恢复"模型可见全部 70 条"。注意 `"false"`（字符串）**不算**——按类型校验它是 truthy，
必须传 JSON 布尔 `false`（② 的 schema 校验会拦住字符串，并给出可读原因）。

**为什么必须在 manifest 里单列**：这条改动**没有任何报错、没有日志**，只是"她突然只会 8 件事"。
不提前说明，第二天一定被当成 bug 排查。

---

## 3. ② `F-EXEC-112` create-agent 按 spec 校验 type/options

### 改了什么
**`src/mindcraft/mindserver.js`**
1. 新增模块级 `schemaViolation(settings, spec)`：按 `settings_spec` 的 `type` / `options` 校验，
   返回**可读拒绝原因**（合法返回 `null`）。
2. 在 create-agent 的"填默认值 + 删未知键"**之后**插入校验；不合法 ⇒ `callback({success:false,error})` 并 `return`。

**宽容规则（都有日志，不静默）**：
- `number`：接受"有限数字的字符串"（面板输入框天然产字符串）⇒ **就地转 number + `console.warn`**；
- `boolean`：**只接受真布尔**。`"false"` 是 truthy，静默转 true 会埋雷 ⇒ 明确拒绝并提示"请传 JSON 布尔"；
- `string` / `array` / `object`：按 `typeof` / `Array.isArray` 判，`null` 对 object 视为非法；
- spec 里没写 `type` 的键 ⇒ 不做类型判断（向后兼容）。

### 怎么验证（实测，用**真实 spec** 跑 11 个用例）
```
✅ 合法: host 字符串            ✅ 合法: port 数字          ✅ 合法: port 数字串 → 转正
✅ 非法: port 非数字          → Setting "port" 必须是数字，收到的是 "abc"（string）
✅ 非法: boolean 收到 "false"  → Setting "load_memory" 必须是布尔值（true / false）…请传 JSON 布尔
✅ 非法: auth 不在 options    → 只能是 "offline" / "microsoft"
✅ 非法: only_chat_with 非数组 → 必须是数组
✅ 非法: profile 为 null      → 必须是对象
✅ 合法: companion_mode 布尔（与 ① 配套）
全部符合预期（11/11）；数字串转正时确有 warn 输出
$ node --check src/mindcraft/mindserver.js → OK
```

### 回滚
`git checkout -- src/mindcraft/mindserver.js`

---

## 4. ③ `F-EXEC-111` ctx 未传

### 改了什么
1. **`composite_registry.js`**：`run: (bot,args,ctx) => runCraft(bot, args.item, args.count, { ctx })`（原来把 ctx 丢了）。
2. **`flow_craft.js`** `craft(bot, itemName, count = 1, opts = {})` 新增 `opts.ctx`，并**真正使用**它：
   - `ctx.deadline` → 开头与**每一轮循环**都判；超时 `fail('TIMEOUT', …)`（不再空转到 `MAX_ROUNDS`）；
   - `ctx.jobId` → 随 `ok({jobId})` 回传（回应 `act_craft.js:441-445` 记录的"拿不到 jobId ⇒ 没有'哪张单'的概念"）。

### 关于"下游到底用不用得上"——如实回答（这是 captain 特别要求的）
- 我查了 `flow_craft.craft()` 的签名：**原来根本没有 ctx 参数**，全文 `grep ctx` **零命中**。
  所以"直接传进去"就是**假装传了**（下游不看）。
- 因此我**没有**只加参数了事：我给了 ctx 两个**当下真实需要**的用途（超时中断 + jobId 归属）。
- **一处必须说清**：`craft` 内部调用的是 `craftOnce(bot, itemName, n, knownTable)`
  （`act_craft.js:34`），它**仍不接受 ctx**；跨尝试的 `producedTotal` **累计仍不在本函数做**
  （由 `board_store.finish` 按增量收敛）。本改动只把 **jobId 带到结果里**，让上层能归属 ——
  **没有**在 bot 上攒计数器（那会把别单的产出算到这张单，`act_craft.js` 的注释明确警告过）。

### 怎么验证（实测）
```
$ node --check src/agent/library/flow_craft.js      → OK
$ node --check src/agent/library/composite_registry.js → OK
$ node tools/craft_diagnostic_reachability_unit.mjs → 15 PASS / 0 FAIL  EXIT=0   ← 我改了 craft() 签名，它没红
$ node tools/strat_cycles_unit.mjs                  → 11 passed  EXIT=0
$ node tools/composite_registry_unit.mjs            → EXIT=0
$ node tools/companion_mode_unit.mjs                → 7 PASS  EXIT=0
```

### 回滚
`git checkout -- src/agent/library/flow_craft.js src/agent/library/composite_registry.js`

---

## 5. ④ `F-REG-004` 面板链缺依赖无兜底

### 改了什么
**`scripts/start-panel.ps1`**（2/4 段，启 mindserver 之前）：
- 新增 `mindcraft\node_modules` 预检；
- 缺失且**有 `package-lock.json`** ⇒ 走 `npm ci`（与 `start.bat` 同口径），失败即 `exit 1` 并给出
  "不要用 `--ignore-scripts`（会静默丢掉 patches/）"的提示；
- 缺失且**无 lock** ⇒ 不硬装，明确告知"请手动 `npm install` 并确认 patches/ 已套用"后 `exit 1`；
- 目的：把原来"`node main.js` 立刻死 → `Wait-Port 8080` **空耗 90 秒** → 日志误导"的行为，
  换成**启动前就失败并说明原因**。

### 怎么验证（实测）
```
$ head -c 3 scripts/start-panel.ps1 | od -An -tx1
  ef bb bf              ← BOM 在（改前就有，我中途被编辑工具弄丢过一次，已补回并复查）
$ powershell -File docs/audit/night/parse-ps1.ps1
  SYNTAX_OK
```
> ⚠️ **踩到的坑（值得记）**：`edit` 工具写回后**把 UTF-8 BOM 弄丢了**（`head -c 3` 变成 `23 20 4d`）。
> 我用 bash 重新 `printf '\xef\xbb\xbf'` 前缀 + 原文追加补回，并复查行数一致（284 行未变）。
> **凡是改 `.ps1`，改完必须 `head -c 3 | od -An -tx1` 复查 `ef bb bf`。**

### 回滚
`git checkout -- scripts/start-panel.ps1`

---

## 6. ⑤ `F-RT-004` gitignore 三条缺口

### 改了什么
两仓 `.gitignore` 各补 **4 条**（放在凭据兜底段、`*.p12` 之后）：
```gitignore
*.crt
*.jks
config.local.ts
config.local.json
```
**前置核证**（避免误伤合法公开证书）：两仓 `git ls-files` 均**无**任何已跟踪 `.crt` / `.jks` / `config.local.ts`，
工作区也没有这类文件 ⇒ 宽规则安全。

### 🔴 顺带修掉一个**别人改出来的真回归**（必须记一笔）
验证时发现 `.env.example` **被误忽略了**。定位：
```
$ git check-ignore -v .env.example
  .gitignore:155:.Env.*   .env.example
```
原因：另一位在修我 t22 报的"`.ENV` 平台假绿"时，加了一组大小写变体规则（`.ENV` / `.ENV.*` / `.Env` / `.Env.*`），
它们的位置在第 117 行 `!.env.example` **之后** —— **gitignore 后规则覆盖前规则**，而 Windows
`core.ignorecase=true` 让 `.Env.*` 也匹配 `.env.example` ⇒ **示例文件再也进不了库**。
（Linux 大小写敏感时不触发，又一处"Windows 才现形"的坑。）

修法：在**文件末尾**补例外（例外必须最后才生效）：
```gitignore
!.env.example
!.env.example.*
!.Env.example
!.ENV.example
```
**两仓都补了**（mindcraft 仓 `.gitignore:111` 有同一问题、同一修法）。

### 怎么验证（实测，两仓）
```
外层仓：OK server.crt / keystore.jks / config.local.ts / config.local.json
        OK .env / .ENV / .Env / .env.local / .ENV.production（仍被忽略）
        OK .env.example 可入库          ← 回归已修
mindcraft：OK 上面全部 4 项 + .mindserver-token
        OK .env / .ENV / .Env / .env.local
        OK .env.example 可入库          ← 回归已修
```

### 回滚
`git checkout -- .gitignore` / `git -C mindcraft checkout -- .gitignore`
（注意：回滚会把别人那条 `.Env.*` 一并带回，但 `.env.example` 的误忽略也会随之回来）

---

## 7. ⑥ `F-WEB-102` tsconfig —— **代码已改，验证未完成**

### 先给实测代价（这是 captain 要核心数据）
| 配置 | error 数 |
|---|---|
| **改前基线**（`strict:false` / `noImplicitAny:false` / `skipLibCheck:true`） | **0** |
| `strict: true` | **1** —— `src/stores/terrain.ts(85,24) TS2345: 'TerrainResult \| null' 不能赋给 'TerrainResult'` |
| `noImplicitAny: true` | **2** —— `TerrainCanvas.vue(3,24)/(4,31) TS7016`：`three` 与 `three/addons/*` 无类型声明 |
| `skipLibCheck: false` | **41** —— 全部是 `node_modules/vite/**.d.ts` 里 `Buffer` 未定义（需 `@types/node`） |

### 改了什么
1. **`web/src/stores/terrain.ts`**：`decodeTerrain(res: TerrainResult | null)` —— 纯类型修正。
   依据：`refreshTerrain()` 声明返回 `Promise<TerrainResult | null>`（`agents.ts:135`，无 agent 时 `return null`），
   而 `decodeTerrain` **第 37 行本来就在用 `!res?.ok` 处理 null** ⇒ 运行时语义早就容许 null，只是签名写窄了。**零行为变更。**
2. **`web/src/types/three-shim.d.ts`（新）**：`three@0.170.0` 的 package.json **没有 `types` 字段**、
   `exports` 也无 `types` 条件（我读了它的 package.json 确认）⇒ three 不自带 `.d.ts`。
   红线禁新增依赖 ⇒ 用**裸声明**垫片（`declare module 'three';` / `declare module 'three/addons/*';`），
   把隐式 any 变成**显式 any**，从而保住 `noImplicitAny` 对**我们自己源码**的检查。
   代价（文件里已写明）：three 相关在本仓是 any，three API 误用不会被类型系统挡住。
3. **`web/tsconfig.json`**：`strict: true` + `noImplicitAny: true`；**`skipLibCheck` 保持 `true`**，
   并在注释里写清"41 error / 需 @types/node / 属新增依赖故不开"——避免后人以为忘了开。

### ⚠️ 验证为什么没完成
本会话 `ops_bash` 在执行到这一条时**运行时故障**：
```
windows-acl-run: --temp is not an existing directory: C:\Users\zeh\AppData\Local\Temp\dsh-iwMtgT
[EXECUTOR_UNAVAILABLE] the sandbox runtime failed before the command ran
```
这是**环境故障，不是授权拒绝**，我无法在会话内修复，也不应绕过。
⇒ **"改后应为 0 error"这一步我没有跑到，因此不声称 ⑥ 已验。**

**请 captain 跑这一条完成验收（一条命令）**：
```bash
cd web && npx vue-tsc --noEmit        # 期望：0 error（改前 0，strict 引入的 1 条已修，three 的 2 条已垫片）
```

### 遗留：我留下的 3 个探针文件需要删（bash 挂了删不掉）
```
web/tsconfig.probe-strict.json
web/tsconfig.probe-noimplicit.json
web/tsconfig.probe-skiplib.json
```
它们是测量代价用的临时 tsconfig，**不应入库**。请 captain 提交前 `rm` 掉（或我下次 bash 恢复后自己删）。

### 回滚 ⑥
```bash
git checkout -- web/tsconfig.json web/src/stores/terrain.ts
rm -f web/src/types/three-shim.d.ts
```

---

## 8. 文件组（commit message 可直接引用）

**mindcraft 仓**
```
src/agent/commands/index.js                     ① 默认方向反转
src/mindcraft/public/settings_spec.json         ① 声明 companion_mode
tools/settings_check.mjs                        ① 移除已解决的例外
tools/companion_mode_unit.mjs                   ① 新单测（7 断言）
src/mindcraft/mindserver.js                     ② schemaViolation
src/agent/library/composite_registry.js         ③ 传 ctx
src/agent/library/flow_craft.js                 ③ 接 ctx + deadline/jobId
.gitignore                                      ⑤ *.crt/*.jks/config.local.ts|json + .env.example 回归
```
**外层仓**
```
scripts/start-panel.ps1                         ④ mindcraft/node_modules 预检 + npm ci 兜底
.gitignore                                      ⑤ 同上
web/tsconfig.json                               ⑥ strict/noImplicitAny 开，skipLibCheck 留（有注释）
web/src/stores/terrain.ts                       ⑥ null 安全类型修正
web/src/types/three-shim.d.ts                   ⑥ 新：three 垫片（零新依赖）
```

---

## 9. 三句提醒 captain
1. **① 有行为变更**：面板 agent 可见命令 **70→8**，用户会觉得"她变笨了"。恢复开关是**显式** `companion_mode: false`（字符串 `"false"` 会被 ② 的校验拦下）。
2. **⑥ 未验证**（bash 运行时故障），**请跑 `cd web && npx vue-tsc --noEmit` 收口**；另有 3 个 `web/tsconfig.probe-*.json` 需要删。
3. **⑤ 里我修掉了别人引入的一个真回归**：大小写变体规则 `.Env.*` 把 `.env.example` 一并吞掉（Windows 才现形），两仓都已补末尾例外。**这条如果没查，示例文件会永远进不了库。**
