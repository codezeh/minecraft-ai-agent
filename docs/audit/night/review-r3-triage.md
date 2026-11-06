# R3-7 台账收口 + ② 5 项修复交付状态核实

> 复核官：gate-keeper ｜ 2026-11-06 10:3x–11:1x
> 背景：终审 R3 判 PASS，但指出夜班自证体系的结构性问题（`R3-7` / `R3-M1`）。
> 本文三件事：① 队列收口结果；② **5 项修复的交付状态核实（结论：全部未交付）**；③ `a8fd019` 复核。

---

## 一、① 队列收口（R3-7）—— 已完成

| 动作 | 结果 |
|---|---|
| `F-SEC-101/102/103/105` 无 `## review` | **核实属实**：4 份全是纯 YAML front-matter、**零 markdown 标题** ⇒ 按 `COMMIT-MAP.md:60` 口径从未通过 |
| `F-SEC-103` | **≡ `F-WEB-204`（我逐字比对确认）** → 补 `## review` 后**留在 `verified/`** |
| `F-SEC-101` | → `inbox/`（`superseded-by-202` **≠ 已解决**：202 本身仍 `blocked`，RCON 仍监听 `0.0.0.0:25575`） |
| `F-SEC-102` / `F-SEC-105` | → `inbox/`（`deferred ≠ 已修`） |
| `F-AI-205` | → `verified/`，**补 `## review`**（我自己验的，不只引 t29，见 §3） |
| `done/` | **保留为空目录**（"修补完待复核"的中间态；当前确实无待复核项） |

**收口后**：`inbox/` 29 ｜ `claimed/` 10 ｜ `done/` 0 ｜ `verified/` **31**
**合规自检**：`for f in verified/*.md; do grep -qiE '^#+ *review' "$f" || echo "无review: $f"; done` → **零命中**（31/31 全部有 review 段）

**三组别名已写入（成对，双向可查）**：
| 别名 | 主号 | 状态 |
|---|---|---|
| `F-SEC-104 ≡ F-EXEC-203` | SEC-104 | 已修（贴图路径白名单） |
| `F-WEB-204 ≡ F-SEC-103` | WEB-204 | 已修（`path.basename`） |
| `F-DEP-103 ≡ F-REG-002` | DEP-103 | **blocked（需用户拍板）** |

---

## 二、② 5 项修复：**全部未交付**（我逐项读了代码，不是看转述）

`git log --oneline -8` 里**没有**对应 commit；`git status` 两仓**干净**（无在途改动）。
逐项核实当前代码状态：

| 项 | 要求 | **当前实际（我读到的）** | 判定 |
|---|---|---|---|
| **`R3-4`** 围栏转义覆盖 | 正则加 `i` + 先剥零宽 `[\u200b-\u200d\ufeff]`；单测补 3 个变体 | `text.js:18-19` 仍是 `.replace(/<<END_UNTRUSTED_EXTERNAL_DATA>>/g, …)` 与 `.replace(/<<UNTRUSTED_EXTERNAL_DATA/g, …)`——**无 `i` 标志、无零宽剥离**；`sanitizeExternalText` 的控制字符类仍不含 `\u200b-\u200d\ufeff` | ❌ **未修** |
| **`R3-2`** 限流硬上界 | `size>=512 && !has(key) → 删最旧`（硬上界） | `mindserver.js:87-89` 仍是 `if (size > 512) { 删 >60s }` ——**触发条件当上限，一个新鲜 key 都删不掉** | ❌ **未修** |
| **`R3-5`** 补丁生效哨兵 | `patch_integrity` 增一条"补丁哨兵是否存在于 `node_modules`" | `tools/patch_integrity.mjs` 只有 ①内容哈希 ②版本漂移两部分；`grep -nE "哨兵\|sentinel\|incorrect_for_wooden_tool"` → **零命中** | ❌ **未修** |
| **`R3-6`** 完整性闸进 `gate` | `gate` 链加 `patch_integrity` | `package.json` 的 `gate` 仍为 `settings_check && preflight_regex_unit && preflight && lint_hard`（4 步） | ❌ **未修** |
| **`F-SEC-206`** `*.token` 通配 | 两仓 `.gitignore` 加 `*.token` | mindcraft `.gitignore:90` 与根 `.gitignore:126` 都只有字面量 `.mindserver-token` | ❌ **未修** |

⇒ **② 无法复核**（没有对象）。下面给出**每项的机器可判验收命令**，落地后一条命令即可判定，不必再靠读码。

### 2.1 落地后的验收命令（建议直接抄进各自 finding 的 `verify:`）

**`R3-4`（最该盯，安全相关）**
```bash
cd mindcraft
# 静态：正则必须带 i，且必须剥零宽
grep -n "END_UNTRUSTED_EXTERNAL_DATA" src/utils/text.js    # 期望行尾出现 /gi 或 /ig
grep -n "200b" src/utils/text.js                          # 期望命中（零宽剥离）
# 动态（决定性）：四个变体都必须**不存活**在围栏体内
node -e '
import("./src/utils/text.js").then(m=>{
  const variants = [
    "<<end_untrusted_external_data>>",           // 小写
    "<<End_Untrusted_External_Data>>",           // 大小写混
    "<<END_UNTRUSTED_EXTERNAL_DATA>>",           // 原形（基线，必须也被打散）
    "<<END_UNTRUSTED\u200b_EXTERNAL_DATA>>",     // 零宽插入
  ];
  let bad = 0;
  for (const v of variants) {
    const out = m.fenceUntrusted("X" + v + "Y", "u");
    // 围栏体 = 去掉首尾那对真定界符之后的部分；里面不允许再出现完整闭合串
    const body = out.slice(out.indexOf("\n") + 1, out.lastIndexOf("\n"));
    const alive = /<<\s*end_untrusted_external_data\s*>>/i.test(body);
    console.log((alive ? "FAIL 存活: " : "OK 已打散: ") + JSON.stringify(v));
    if (alive) bad++;
  }
  process.exit(bad ? 1 : 0);
});'
# 单测：应新增 3 例（变体）
grep -cE "变体|variant|小写|零宽" tools/text_fence_unit.mjs   # 期望 >= 3
```
> ⚠️ 注意我会在复验时**故意用 `\u200b` 和大小写混**去喂，别只补"小写"这一种。

**`R3-2`**
```bash
# 决定性：造 600 个不同来源，表大小必须稳定 ≤512（而不是持续增长）
grep -n "size >= 512\|size > 512" src/mindcraft/mindserver.js   # 期望见 >= 且伴随 delete(最旧)
```

**`R3-5`（"变体病"重灾区，请用最严标准）**
```bash
cd mindcraft
# 关键：必须在**未重装**的机器上报红（现在它报绿，这就是问题本身）
node tools/patch_integrity.mjs; echo "exit=$?"
# 期望：exit=1 且输出明确指出「补丁声明的改动不在 node_modules 里」
# 反例保护：重装后（npm ci）应转 exit=0 —— 否则就成了"恒红闸"，同样没用
grep -c "incorrect_for_wooden_tool" node_modules/mineflayer/lib/plugins/digging.js   # 重装后应 =1
```
> **这条的本质**：现在闸比的是"补丁文件的哈希"和"包版本号"，**都不是"补丁是否已作用于 node_modules"**。
> 加哨兵时请确认**哨兵来自补丁内容本身**（例如从 patch 里解析出 `+` 行的一个特征串去 node_modules 里找），
> **不要**写死一个字符串——否则补丁一改，哨兵就失真，又变成"检查的不是那件事"。

**`R3-6`**
```bash
node -p "require('./package.json').scripts.gate" | grep -c patch_integrity   # 期望 1
# 反向验证：改 1 字节补丁 → npm run gate 必须 EXIT=1（不是只有 start.bat 才查）
```

**`F-SEC-206`**
```bash
for repo in . mindcraft; do (cd $repo && for f in foo.token bar.token .mindserver-token; do
  git check-ignore -q "$f" && echo "OK $f" || echo "FAIL $f"; done); done
```

---

## 三、③ `a8fd019`（R3-M1）复核 —— **通过**

### 3.1 修法本体（读 diff）
```js
- const NL = String.fromCharCode(13, 10);                       // 硬编码 CRLF
+ const NL = FLOW_SRC.includes('\r\n') ? '\r\n' : '\n';         // 从源文件自身推断
```
方向正确：**不写死，从被变异的那份源文件推断**。这比"改成硬编码 LF"更好——换个文件/换台机器也不会再错。

### 3.2 根因核实（我自己验的，不只是引审查结论）
```
$ node -e "数 src/agent/library/flow_craft.js 的字节"
   LF=382  CR=0  ⇒ **纯 LF**
```
⇒ 原注释"`src/` 是 CRLF"**方向写反了**：用 CRLF 拼的锚点在这份纯 LF 文件里**永远匹配不到** ⇒
`replace` 不生效 ⇒ 变异没插进去 ⇒ 守卫仍 `false` ⇒ **本用例恒红** ⇒ `gate:full` 永久 `EXIT=1`。
而永久红的门禁会把人逼成 `SKIP_GATE=1` ⇒ **整道门实质失效**。这条因果链成立，且正是今晚反复讲的形态。

### 3.3 修复是否真的生效（实跑，不看自述）
```
$ node tools/craft_diagnostic_reachability_unit.mjs
  15 PASS / 0 FAIL / 0 XFAIL / 0 XPASS
  EXIT=0        ✅
```

### 3.4 独立确认"还有没有别处硬编码换行符"（审查说仅此一处，我另验）
```bash
$ grep -rnE "fromCharCode\(13|'\\r\\n'|\"\\r\\n\"" tools/*.mjs
  （空）
$ grep -rlnE "0x0d|\\u000d|\\x0d|charCodeAt.*13" tools/*.mjs
  （空）
```
⇒ **确认只有那一处**，审查的说法我独立复核成立 ✅

**结论：`a8fd019` 通过。** 建议在 commit body 或 PLAYBOOK 记一句：
**"测试若依赖源文件的行尾符，必须从该文件自身推断，禁止硬编码"** —— 这是今晚第 3 次栽在换行上。

---

## 四、给 captain 的三句话

1. **① 已完成**：`verified/` 31 份**全部**有 `## review`（自检命令零命中）；`F-AI-205` 已补 review 入 `verified/`；`F-SEC-101/102/105` 已回 `inbox/`（并写明"`superseded` ≠ 已解决""`deferred` ≠ 已修"）；三组别名成对写入；`done/` 保留。
2. **② 5 项全部未交付**（我逐项读码核实，非看转述）：`R3-4` 正则仍无 `i`/无剥零宽、`R3-2` 仍 `>512` 清理、`R3-5` 无哨兵、`R3-6` `gate` 仍 4 步、`F-SEC-206` 仍只有字面量 token。**请派下去后我再来验；验收命令我已写好（见 §2.1），落地即一条命令可判。**
3. **③ `a8fd019` 通过**：修法方向对（从源文件推断行尾）、根因成立（`flow_craft.js` 实测 382 LF/0 CR）、实跑 `15 PASS/0 FAIL`、且我独立确认 `tools/` 里**没有第二处**硬编码换行符。

**关于"台账失真"这件事**：R3 那 4 份无 review 的单子，是我整晚台账里**唯一一处自己违反自己口径**的地方。
我不打算用"历史遗留格式问题"来解释掉它 —— 我扫的是 `## review`，却没扫"有没有 markdown 标题"，这是**判据选窄了**。
已把自检命令固定成 `for f in verified/*.md; do grep -qiE '^#+ *review' "$f" || echo 无review; done`，以后每次收口都跑。
