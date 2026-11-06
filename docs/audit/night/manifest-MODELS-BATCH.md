# manifest — MODELS-BATCH（t24：src/models 的 err 处理 / 日志泄漏 + 两个门禁配置）

- **执行**：recon-scout
- **时间**：2026-11-06 12:36–12:52
- **改动范围**：`mindcraft/src/models/**`（17 个文件）+ `mindcraft/tools/unit_all.mjs`。**未触碰** `src/agent/`、`src/mindcraft/`、`web/`、`scripts/start-panel.ps1`、`eslint.config.js`（见 §5 为什么没改它）。
- **写盘方式**：全程 `write`/`edit` 宿主文件工具（不用 bash sed / node writeFileSync）——按 captain 指示。
- **`node --check`**：20 个 src/models 文件 + tools/unit_all.mjs **全部通过**（逐文件跑过，见 §6）。

---

## ① F-AI-101 — `err.message` 裸用（medium）

### 改了什么
新增 `errMessage(err)` helper（`src/models/_shared.js`），永远返回字符串：

```js
export function errMessage(err) {
    if (err === null || err === undefined) return '';
    if (typeof err === 'string') return err;
    if (typeof err.message === 'string') return err.message;
    if (typeof err.error?.message === 'string') return err.error.message;
    return String(err);
}
```

把**全部**裸用替换掉（不是只改任务点名的 5 处）：

| 文件:行 | 原写法 | 新写法 |
|---|---|---|
| claude.js:54 | `err.message.includes("does not support image input")` | `errMessage(err).includes(…)` |
| gemini.js:115 | `err.message.includes("Image input modality…")` | `errMessage(err).includes(…)` |
| gpt.js:80 | `err.message == 'Context length exceeded'` | `errMessage(err) === '…'` |
| gpt.js:83 | `err.message.includes('image_url')` | `errMessage(err).includes(…)` |
| grok.js:46/49 | `err.message == …` / `.includes(…)` | `errMessage(err)` |
| groq.js:67 | `err.message.includes("content must be a string")` | `errMessage(err).includes(…)` |
| mercury.js:52/55 | 同上两处 | `errMessage(err)` |
| mistral.js:63 | `.includes("A request containing images…")` | `errMessage(err).includes(…)` |
| ollama.js:42 | `err.message.toLowerCase().includes('context length')` | `errMessage(err).toLowerCase().includes(…)` |
| deepseek.js / lmstudio.js / novita.js / qwen.js / vllm.js / hyperbolic.js | `err.message == 'Context length exceeded' \|\| err.code == …` | `errMessage(err) === … \|\| err?.code == …` |

**改了几处 / 还剩几处**：
- 改前：`err.message` 裸用 **15 处**（8 处 `.includes` 类 + 7 处 `== 'Context length exceeded'` 类，分布在 13 个文件）。
- 改后：**0 处**（把 helper 自身内部的两处安全用法排除后）。
- 断言命令（结果 0）：
  ```
  node -e '…扫 src/models/*.js（排除 _shared.js 自身），regex /\berr\.message\s*(\.|==)/，跳过注释…'
  → 0
  ```

### 怎么验证
```bash
# 1) 语义：非 Error 的 err 不再 TypeError
node -e 'import("./src/models/_shared.js").then(({errMessage})=>{
  console.log(JSON.stringify([errMessage(null), errMessage("str"), errMessage({}), errMessage({error:{message:"m"}}), errMessage(new Error("e"))]));
})'
# → ["","str","[object Object]","m","e"]   ← 全部是字符串，不抛

# 2) grep 断言：0 处裸用（见上）
```
**回滚**：`git checkout -- src/models/*.js`（本批未改其它目录）。

---

## ② F-SEC-102 — 19 处 `console.log(err)` 打整个 error 对象（medium）

### 改了什么
新增 `safeErrText(err, tag?)`（`src/models/_shared.js`）：**只输出标量**，绝不输出对象、绝不 `JSON.stringify(error)`。

新输出形状（一行）：
```
[llm-error] status=401 code=invalid_api_key tag=vision 401 Unauthorized: invalid api key
```
- `status` 取 `err.status ?? err.statusCode`；`code` 仅当是 string/number；
- `message` 依次退化：`err` 是字符串 → `err.message` → `err.error?.message` → `String(err)`（对象变 `[object Object]`，**不泄漏字段**）；
- **截断 300 字**（`MAX_ERR_MSG`）；
- **绝不碰** `err.request` / `err.response` / `err.config` / `err.body` / headers。

19 处全部替换为 `console.log(safeErrText(err))`（gemini 的 vision 分支带 `tag='vision'`）。文件清单：
`claude:59, deepseek:49, gemini:72,114, gpt:84,87, grok:50,53, groq:72, huggingface:50, lmstudio:45, mercury:56,59, mistral:68, novita:53, ollama:51, qwen:48, replicate:94, vllm:65`

### 怎么验证（证明"不再打敏感字段"）
```bash
# 1) grep 断言：真代码里 console.log(err) = 0
node -e '…扫 src/models，regex /console\.log\(\s*err\s*\)/，跳过注释…'   → 0

# 2) 行为断言（关键）：塞 canary 到 error 的敏感挂载点，输出里必须一个都不出现
node -e 'import("./src/models/_shared.js").then(({safeErrText})=>{
  const e=new Error("401 Unauthorized: invalid api key");
  e.status=401; e.code="invalid_api_key";
  e.config={headers:{Authorization:"Bearer sk-LEAK-CANARY-1234"}, data:{prompt:"SECRET-PROMPT"}};
  e.request={body:"SECRET-BODY"};
  e.response={body:{key:"sk-LEAK-CANARY-1234"}};
  const out=safeErrText(e,"vision"); console.log(out);
  const bad=["sk-LEAK-CANARY","SECRET-PROMPT","SECRET-BODY","Authorization"].filter(s=>out.includes(s));
  console.log(bad.length?"✗ 泄漏":"✓ 未泄漏");
})'
```
**实测输出**（我跑过）：
```
[llm-error] status=401 code=invalid_api_key tag=vision 401 Unauthorized: invalid api key
✓ 未泄漏任何敏感字段
包含 status/code?  true
退化形状： null → [llm-error] <null> ； "boom" → [llm-error] boom ； {status:500} → [llm-error] status=500 [object Object] ； 超长 → 313 字符（截断生效）
```

**回滚**：`git checkout -- src/models/*.js`。

---

## ③ F-SEC-105 — 提示词打印"6 个里只改好 1 个"（low）→ **实测：其实已经全改好了，只有 1 处真的打印**

### 先说结论（这条要更正台账口径）
我逐行读回来核实：**真正会打印提示词的只有 1 处，而且带门**——
```
hyperbolic.js:50   if (process.env.LOG_PROMPTS === '1') console.log('Messages:', messages);
```
任务里点名的另外 5 处**全都是被注释掉的死代码**：
```
deepseek.js:36    // console.log('Messages:', messages);
grok.js:37        ///console.log('Messages:', messages);      ← 注意是三个斜杠
mercury.js:43     // console.log('Messages:', messages);
qwen.js:35        // console.log('Messages:', messages);
vllm.js:51        // console.log('Messages:', messages);
```
⇒ **F-SEC-105 没有"5 处仍在泄漏"这回事**（我在 t20 台账里写的"5 处无条件打印"是**统计错误**：当时的脚本用 `/console\.log\(\s*['"]Messages:/` 匹配，**注释里的也命中了**。已在该台账 §五 更正过，这里再确认一次）。

### 改了什么（仍然做了，为了让"6 套写法"真的只剩 1 套）
删掉那 5 行**注释掉的死调试代码**（含那个奇怪的 `///console.log`）。行为零变化（本来就是注释），但此后"谁在打印提示词"只需看一处。

### 怎么验证
```bash
grep -rn "Messages:" src/models/*.js
# → 只剩 1 行：hyperbolic.js:50  if (process.env.LOG_PROMPTS === '1') console.log('Messages:', messages);
```
**回滚**：`git checkout -- src/models/deepseek.js src/models/grok.js src/models/mercury.js src/models/qwen.js src/models/vllm.js`。

---

## ④ F-GATE-002 — `unit_all` 藏了两个死测试（low）→ **部分完成：删除被沙箱拦住，已改为"看得见的待删"**

### 事实
- `tools/test_mca_import.mjs` 与 `tools/test_tile_map.mjs` 都 import 已删除的模块，实跑必红：
  ```
  Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…\src\agent\library\chunk_map.js'
  imported from …\tools\test_mca_import.mjs   (同样适用于 test_tile_map.mjs)
  ```
- 两个模块确认已废弃（`src/agent/library/` 下无 chunk_map.js / tile_map.js；`path_3d.js:4` 写明"取代 tile_map 的 16 格战棋格 A*"；`preflight.mjs:337` 也写"chunk_map.js / heatmap.js 早已删除"）。

### 改了什么
**`rm` 被沙箱拒绝**（`rm: cannot remove …: Permission denied`，成员会话不允许删文件），所以我做了能在权限内做到的最实的一件事——**把"静默排除"改成"每次都看得见的待删"**：

`tools/unit_all.mjs`：
1. 把两个死测试从 `EXCLUDE` 拆出来，新建 `PENDING_DELETE`，并在注释里写清**两者语义不同**：
   - `EXCLUDE` = 还活着、但不该进默认集（如需要在线 bot 的）；
   - `PENDING_DELETE` = 已经没有意义（依赖模块已删），**待 git rm**。
2. 发现逻辑同时过滤两者（`!EXCLUDE.has(n) && !PENDING_DELETE.has(n)`）。
3. **每次运行都打印可见告警 + 待执行命令**（文件若已被删则自动静默，不留永久噪音）。
4. `--list` 增 `pendingDelete` 字段，给 preflight/工具消费。

### 怎么验证
```bash
node tools/unit_all.mjs 2>&1 | head -5
#  ⚠ 2 个**已废弃**的脚本仍未删除（它们依赖的模块已被删，跑必红，故不进默认集）：
#      · tools/test_mca_import.mjs —— import 的 chunk_map.js + tile_map.js 均已删除（实测 ERR_MODULE_NOT_FOUND）
#      · tools/test_tile_map.mjs —— 同上
#    收掉方式：git rm tools/test_mca_import.mjs tools/test_tile_map.mjs

node tools/unit_all.mjs --list | grep -A3 pendingDelete    # → 两条
```
### ⚠ 需要 captain 执行的一步（我做不到）
```
git rm tools/test_mca_import.mjs tools/test_tile_map.mjs
```
删完之后：告警自动消失（`existsSync` 判断），`PENDING_DELETE` 两条会成为无害的历史注记。

### 顺带发现（不在我的文件范围，未改）
**同一根因还有第三个受害者**：`tools/measure_corridors.mjs:3-4` 也 import `chunk_map.js` / `tile_map.js`，实测同样 `ERR_MODULE_NOT_FOUND`。它不在 `unit_all` 名单里，所以不影响 gate，但它是一个**已经跑不动的工具**。建议单开一条 low 处理（删或重写）。

**回滚**：`git checkout -- tools/unit_all.mjs`。

---

## ⑤ F-GATE-003 — eslint 三条自始为 off（low）→ **BLOCKED，给数据**

### 先评估代价（实跑，不是估算）
```bash
# 基线（三条 off）：
npx eslint src main.js -f json          → error = 202
# 开启三条后：
npx eslint src main.js -f json --rule '{"curly":"error","no-unused-vars":"error","no-unreachable":"error"}'
                                        → error = 2198   （+1996）
```
逐条拆开：

| 规则 | 新增 error | 性质 |
|---|---|---|
| `curly` | **1833** | 纯格式（单行 if 不加花括号），占 92%；可 `--fix` 但 diff 巨大 |
| `no-unused-vars` | **161** | 涉 70 个文件（skills.js 43、flow_shelter 8、agent.js 6…），多数是真问题但噪音大 |
| `no-unreachable` | **2** | 少且**都是真 bug** —— 但都在**别人负责的目录** |

`no-unreachable` 的两处：
```
src/agent/commands/actions.js:495  Unreachable code.
src/agent/tasks/tasks.js:502       Unreachable code.
```
（两者都在 `src/agent/` ⇒ **不在我的可改范围**，我不能顺手修。）

### 结论：**BLOCKED**（按任务约定：炸出上千条就标 blocked 给数据，不为过门假装开启）
- 三条一起开 = **2198 errors**，远超"<30 且都是真问题"的可控阈值 ⇒ **开启需单独一轮清理**（curly 可 `eslint --fix` 一次性铺；no-unused-vars 需人工甄别 161 处）。
- **建议的中间路径（下一轮做）**：先只开 **`no-unreachable`**（+2 条，且是 2 个真 bug），
  由 `src/agent/` 的负责人修掉那两处后立即开启；`curly` / `no-unused-vars` 另行排期。

**我没有改 `eslint.config.js`** —— 保持三条 off 的原状，未做任何"假装开启"。

---

## 6. 验证汇总（我实跑过的）

| 检查 | 命令 | 结果 |
|---|---|---|
| 语法（全部适配器） | `for f in src/models/*.js; do node --check "$f"; done` | ✓ **20/20 通过** |
| 语法（unit_all） | `node --check tools/unit_all.mjs` | ✓ 通过 |
| 未使用导入（我新增的） | `npx eslint src/models --rule '{"no-unused-vars":["error",{"args":"none"}]}'` | ✓ 我新增的 `safeErrText`/`errMessage` **无未使用**（曾误加 hyperbolic，已移除） |
| 改过的 18 个文件 lint | `npx eslint <17 个 models + unit_all>` | ✓ **0 error**（干净） |
| models 层单测 | `node tools/llm_usage_unit.mjs` | ✓ **123 passed, 0 failed**（含"19 个适配器全都调用 recordUsage"） |
| `console.log(err)` 剩余 | 见 §② | **0** |
| `err.message` 裸用剩余 | 见 §① | **0** |
| 提示词打印位置 | 见 §③ | **1 处，且带 `LOG_PROMPTS` 门** |
| `unit_all --list` | `node tools/unit_all.mjs --list` | ✓ 正常，`excluded`=2（活的）、`pendingDelete`=2（死的） |

### ⚠ gate 无法在成员会话跑完（**不是我的改动造成**）
`npm run gate` 现在会在第 2 步死掉：
```
✓ patch_integrity 通过（5 个补丁内容一致、6 个哨兵全命中）
[check_secret_filenames] git ls-files 失败：spawnSync git EPERM      ← 这里
```
原因：`tools/check_secret_filenames.mjs`（**别人在 `03422d7` 新加的 gate 步骤**）用
`execFileSync('git', ['ls-files','-z'])`，而**成员会话的 shell 沙箱禁止 spawn 子进程**（EPERM）。
⇒ 这不是回归，是**新 gate 步骤与成员会话权限模型冲突**：任何 member 都跑不了 `npm run gate` 了。
**请 captain 在能 spawn 的会话里跑 gate/gate:full**，或让该脚本改成"读 `.git/index` / 用 git 以外的办法列文件"。
我能独立证明的部分（lint 我改的文件、node --check、models 单测、patch_integrity）都已全绿并附在上表。

---

## 7. 文件组（本次改动的完整清单）

**`mindcraft/src/models/`（17 个）**
```
_shared.js        ← 新增 errMessage() + safeErrText()（+注释说明为什么不能打整个 error）
claude.js  gpt.js  grok.js  groq.js  mercury.js  mistral.js  gemini.js
ollama.js  deepseek.js  huggingface.js  lmstudio.js  novita.js  qwen.js
replicate.js  vllm.js  hyperbolic.js
```
**`mindcraft/tools/`（1 个）**
```
unit_all.mjs      ← EXCLUDE 拆出 PENDING_DELETE + 可见告警 + --list.pendingDelete
```
**未改**：`eslint.config.js`（⑤ blocked）、`src/agent/**`、`src/mindcraft/**`、`web/**`、`scripts/start-panel.ps1`。

## 8. 需要 captain 的三件事
1. **`git rm tools/test_mca_import.mjs tools/test_tile_map.mjs`**（沙箱不让我删）——之后④的告警自动消失。
2. **在能 spawn 的会话跑 `npm run gate` / `gate:full`** 并回填结果（我这边被 `check_secret_filenames` 的 EPERM 卡住）。
3. **⑤ 决策**：是否按建议"下一轮先只开 `no-unreachable`（+2）"，那两处需 `src/agent/` 的人修；`curly`(+1833)/`no-unused-vars`(+161) 另行排期。
