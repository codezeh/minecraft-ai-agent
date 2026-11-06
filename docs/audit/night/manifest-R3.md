# manifest · 终审 R3 修复项（R3-4 / R3-2 / R3-5 / R3-6 / ⑤ *.token）

> patch-smith · 2026-11-06 10:3x｜依 captain 派工（R3-M1 他已修，R3-3/R3-7 不用我做）
> 改动文件：`mindcraft/src/utils/text.js`、`mindcraft/tools/text_fence_unit.mjs`、
> `mindcraft/src/mindcraft/mindserver.js`、`mindcraft/tools/patch_integrity.mjs`、
> `mindcraft/package.json`、`mindcraft/.gitignore`、`.gitignore`（外层）

---

## ① `R3-4` 围栏转义覆盖缺口（安全，已修 + 单测真跑真绿）

**审查说的两个缺口，都成立，都改了：**

| 缺口 | 修法 |
|---|---|
| 打散正则**大小写敏感 + 逐字精确** ⇒ 小写/混写/零宽插入的变体原样存活 | 加 **`i` 标志**；并在打散前**先剥不可见字符** |
| `sanitizeExternalText` **不剥零宽/BOM/bidi** | 新增 `INVISIBLE_CHARS` 正则，`sanitize` 与 `fenceUntrusted` **两处都剥** |

`INVISIBLE_CHARS` 覆盖：`\u200b-\u200f`（零宽空格/连接符）、`\u202a-\u202e`（bidi 覆盖与控制）、
`\u2060-\u2064`（词连接符/不可见运算符）、`\u2066-\u2069`（bidi 隔离）、`\ufeff`（BOM）。

**单测补齐（审查点名的第三条）**：`text_fence_unit.mjs` 从 22 条 → **31 条**，新增 9 条：
- 6 个变体逐个断言"体内无可识别定界符"：**小写 / 混写 / 零宽插入 / 零宽+小写 / 零宽开标签 / 斜杠变体**
- 3 条 sanitize：剥零宽/BOM/bidi（`a\u200bb\u200dc\u202ed\ufeffe\u2060f` → `abcdef`）、长度缩短、围栏体内无不可见字符

**判据用的是"体内不得出现 `<<` 紧跟标记名"**（大小写不敏感），而不是"旧字符串还在不在" ——
原来那条断言只喂大写精确形态，**证明的性质比它声称的窄**（审查原话），现在把面补齐了。

**实测**：`node tools/text_fence_unit.mjs` → **31 passed / 0 failed**（真跑，非推断）。

---

## ② `R3-2` 限流"硬上界"名不副实（已改成真上限）

**审查说得对**：`if (size > 512) { 删 >60s }` 是**清理触发条件**，不是上限 ——
513 个新鲜 key 时一个都删不掉，之后每条消息全表扫。

**改法**：新增 `RATE_BUCKETS_MAX = 512` / `STALE_MS = 60000`，逻辑改为
`!has(key) && size >= MAX` → 先清陈旧项 → **仍满则淘汰最旧（Map 插入序）**。
只在"要插入新 key"时触发，已有 key 路径零额外开销。

**实测**（等价逻辑跑 900 个新鲜 key）：`size = 512`（≤ 512）→ **PASS**。

---

## ③ `R3-5` 补丁"改了文件"≠"补丁生效"（已修，**当前它把闸打红是正确行为**）

**审查的定性准确**："写了检查，但检查的不是那个东西" —— ①② 都比不到"是否真的套用到 node_modules"。

**改法**：新增 **[3/3] 补丁哨兵**：每个补丁登记 1~2 个"**只有打了补丁才会存在**"的字符串，
逐个到 `node_modules` 实装文件里找；找不到 ⇒ **FAIL**，并明确写"这不是补丁写错了，是没装（跑 `npm ci`）"。

哨兵表（都经实测确认）：
| 补丁 | 哨兵 |
|---|---|
| `mineflayer+4.39.0.patch` | `digging.js` 的 `incorrect_for_wooden_tool`（hunk 1）+ `place_block.js` 的 `timeout: 500,`（hunk 3） |
| `mineflayer-pathfinder+2.4.5.patch` | `movements.js` 的 `updateLavaAvoidance` |
| `mineflayer-pvp+1.3.2.patch` | `PVP.js` 的 `physicsTick` |
| `prismarine-viewer+1.33.0.patch` | `Entity.js` 的 `if (!e) return; //throw new Error` |
| `protodef+1.19.0.patch` | `serializer.js` 的 `// console.log('Chunk size is` |

未登记哨兵的新补丁会打印 `~ 未登记哨兵…（这道检查对它是空的）`，避免"以为查了其实没查"。

**实测（重要）**：现在跑 `node tools/patch_integrity.mjs` → **exit 1**，报 2 条：
```
✗ mineflayer+4.39.0.patch 的哨兵不在 node_modules/.../digging.js 里（缺 `incorrect_for_wooden_tool`）
✗ … 不在 node_modules/.../place_block.js 里（缺 `timeout: 500,`）
```
**这正是审查要的行为**：本机 `node_modules` 时间戳仍是 10-24、从未重装，而旧版工具**报绿**。
现在它报红，并指明"跑一次 `npm ci` 才会生效"。

### ⚠️ 由此产生的依赖（请 captain 注意）
**`npm ci` 之前，`npm run gate` 会是红的**（且这是**正确的**红）。你上一条说"旧补丁已删、实测 exit 0，可以接了"——
那是在**我加哨兵之前**。加了哨兵后，`node_modules` 没重装就先红。**建议顺序：先 `npm ci`，再跑 gate。**

---

## ④ `R3-6` 完整性闸接进 `npm run gate`（已接）

```json
"gate": "node tools/patch_integrity.mjs && node tools/settings_check.mjs && node tools/preflight_regex_unit.mjs && node tools/preflight.mjs && node tools/lint_hard.mjs"
```
放在**第一步**（最快、最能早失败）。
**注意**：如 §③ 所说，接上之后 gate 的第一关就是哨兵 —— `npm ci` 之前必红。

**本会话各步实测**（说明哪些红是环境的）：
| 步骤 | exit | 说明 |
|---|---|---|
| `patch_integrity.mjs` | **1** | **哨兵**（node_modules 未重装）→ 代码层面的真红，`npm ci` 后转绿 |
| `settings_check.mjs` | 0 | 绿 |
| `preflight_regex_unit.mjs` | 0 | 绿 |
| `preflight.mjs` | 1 | **环境**：§6 自测要 `spawnSync` → 本会话 EPERM（非我的改动） |
| `lint_hard.mjs` | 1 | **环境**：`✗ lint:hard 起不来：EPERM`（非我的改动） |

我已确认 `spawnSync(process.execPath,…)` 在本会话返回 `status=null, err=EPERM` ⇒ 后两条与代码无关，
在你那边（能 spawn）应当是绿的。

---

## ⑤ `F-SEC-206` 补 `*.token`（两仓各一行）

采纳审查的精确纠正：**`.env.local` 其实已被 `.env.*` 覆盖**（`git check-ignore -v` 命中 `.gitignore:79`），
真正未覆盖的只有**通配的 token 文件**（原来只有 `.mindserver-token` 精确项）。

- `mindcraft/.gitignore` 与 外层 `.gitignore` 各加 `*.token`
- **实测**：两仓 `git check-ignore` 对 `foo.token` / `bar.token` / `.mindserver-token` **6/6 OK**

---

## 自检汇总
| 命令 | 结果 |
|---|---|
| `node tools/text_fence_unit.mjs` | **31 passed / 0 failed**（+9 条 R3-4 断言） |
| `node tools/permissions_unit.mjs` | 68 passed / 0 failed（未受影响） |
| `node tools/mindserver_gate_unit.mjs` | 49 passed / 0 failed（未受影响） |
| `node --check`（text.js / mindserver.js / patch_integrity.mjs） | 全 OK |
| 限流真上界（900 key 等价实测） | size = 512 → PASS |
| `patch_integrity.mjs` | **exit 1**（哨兵，正确）→ `npm ci` 后应转 0 |
| `npm run gate` | 本会话跑不了完整链（preflight/lint_hard 环境 EPERM）；归 captain |

## 文件组（依 ⑤ 通知）
```
 M mindcraft/src/utils/text.js              ← R3-4
 M mindcraft/tools/text_fence_unit.mjs       ← R3-4 单测（+9）
 M mindcraft/src/mindcraft/mindserver.js     ← R3-2
 M mindcraft/tools/patch_integrity.mjs       ← R3-5 + [1/3][2/3] 重新编号
 M mindcraft/package.json                    ← R3-6 gate 接线
 M mindcraft/.gitignore                      ← ⑤ *.token
 M .gitignore（外层）                        ← ⑤ *.token
```
**建议提交顺序**：先 `npm ci` → 再 `npm run gate` 确认绿 → 再提交。若想先提交代码也可以，
但请知道 gate 会因为 §③ 的哨兵而红（**那是真红，不是假红**）。
