# D2 密钥部 · 复核记录（t14）

> 复核官：gate-keeper ｜ 2026-11-06 02:3x–02:5x ｜ 对象：D2 全部 14 项（10 张有单 + 4 项无单的落地改动）
> 环境：本会话 bash/node 对 `mindcraft/` 只读、node 不能 spawn ⇒ `gate:full` 无法运行（按 captain 裁决由他跑）。
> **但 `settings_check`、单测、`git`、`grep`、`sha256sum` 我都能跑**，密钥类判据不依赖 spawn。

---

## 0. 一句话结论

**通过 12 / 打回 2。**

| 打回 | 理由 | 修复成本 |
|---|---|---|
| **`F-SEC-209`** | 修复只在磁盘（`server.properties` 被 `.gitignore:74` 排除），而**被跟踪的 `server.properties.example` 仍写着 `true`** —— git 里唯一可见的参照指向危险值 | 改 1 行 + 提交 example |
| **`F-SEC-206`** | 漏了 finding 自己点名的 `config.local.js`（两仓都未忽略）；且验收表写"两仓 16/16"，实测 **8/9 × 2** | 各加 1 行 |

**红线全部干净**（这是本节最重要的三行）：
1. **没有动任何真实密钥值** —— `keys.json` 的 `OPENAI_API_KEY` sha256 前16 = `7396a9cbdd8e0227`，
   **与 finding 记录的指纹逐字符相同**，且文件 mtime 停在 2026-10-18（早于今晚全部工作）。
2. **没有动 RCON 口令** —— 与 11-02 备份**逐字节相同**（值指纹 `281687d797644ed3` 两侧一致）。
3. **没有改写 git 历史** —— `7a5e5d0/4c006bc/7331ba5/119f45f` 的 sha 与 t13 复核时完全一致；
   `refs/original` 不存在（无 `filter-branch`）；reflog 只有 captain 在 01:32 的两次
   `reset: moving to HEAD`（重建 index 那件事，未动提交图）。

---

## 1. 任务点名的五项专项检查

### ① 有没有动真实密钥的值 —— **没有**（红线通过，且有精确对照）

| 对象 | 我的核证方式 | 结果 |
|---|---|---|
| `mindcraft/keys.json` | 用 finding 里给的 sha256 前16 指纹比对 | **完全一致** `7396a9cbdd8e0227`，长度 67、非空键数 1；mtime 2026-10-18 ⇒ 今晚没人写过 ✅ |
| `server/server.properties` 的 `rcon.password` | 与 11-02 备份的该行做 sha256 比对 | **逐字节相同** `281687d797644ed3` ✅ |
| `.env` / 其它凭据文件 | 两仓 `git ls-files` 查是否新增敏感文件 | **0 新增** ✅ |

> 为什么这条我能给出比"我说没改"更强的证明：finding 当初就把 key 的指纹记下来了（`7396a9cbdd8e0227`），
> 这是**可复算的对照基准**。建议以后所有 secret 类 finding 都留指纹，复核就能这样闭环。

### ② 外部化后程序还能不能正常启动 —— **能**

```
node tools/settings_check.mjs                → ✓ settings 键一致性检查通过（exit 0）
node tools/mindserver_gate_unit.mjs          → ALL PASS: 48 passed, 0 failed（exit 0）
node tools/mindserver_local_only_unit.mjs    → 16/16（exit 0）
node tools/permissions_unit.mjs              → 63 passed（exit 0）
node tools/ses_escape_unit.mjs               → 16 passed（exit 0）
node tools/board_payload_unit.mjs            → exit 0
```
D2 的代码改动集中在 `mindserver.js`（token 打印 + 贴图白名单）与 `server-net.mjs`（注释），
上述 5 个与之直接相关的单测**全绿**，`settings_check` 通过 ⇒ 配置键一致性未被破坏。
（`F-SEC-201` 的外部化**尚未落地**——它是 blocked，等用户 `setx`，所以"搬到 env 后能否启动"本轮无法实测，
这一点已在 201 的复核里标明。）

### ③ `.gitignore` 加了但文件早已被跟踪 = 没修好 —— **本轮不存在这个情况**

```
$ git ls-files | grep -icE "\.env$|secrets\.json|credentials\.json|id_rsa|\.pem$|\.p12$|\.pfx$|mindserver-token"
0            ← 根仓
（mindcraft 仓同样 0）
```
⇒ 两仓都**没有被跟踪的敏感文件**，所以新规则一加即生效，**不需要 `git rm --cached`**。
这一项是干净的。

⚠️ 但有一条**反向**的同类问题（同样是"git 里没有 = 没真修"），落到了 `F-SEC-209` 头上：
`server/server.properties` **从未被跟踪**（`.gitignore:74`），所以对它做的修改**永远进不了 git**。
我在 209 的复核里按打回处理。

### ④ 历史泄漏是否被诚实标记为"需用户手动轮换" —— **标了，两处都标了**

- `F-SEC-201` 第 82 行原文："但'清理代码不等于密钥安全'——**请用户轮换这把 key**（新 key 写进环境变量，旧 key 在供应商侧吊销）"
  ⇒ 不只标了"要轮换"，还点明"清理≠安全"，没有用"代码已清理"来冒充"密钥已安全" ✅
- `F-SEC-203` 第 59 行原文："若用户介意，可再轮换一次并**同时**处理所有副本（这是用户动作，patch-smith 不改值）"，
  并写明"轮换的意义在于让旧值作废" ✅
- 两条都明确写了"轮换属用户动作"，没有被藏起来。**这一项 D2 做得好。**

### ⑤ 有没有偷偷 `filter-branch` / 改写 git 历史 —— **没有**（红线通过）

```
$ git log --oneline -6
58d2fb1 fix(security): 补通用凭据兜底规则 — F-SEC-206     ← 新增（D2）
119f45f …                                                 ← 与 t13 复核时的 sha 完全一致
7331ba5 / 4c006bc / 7a5e5d0 / 3a41acf                    ← 全部未变
$ ls mindcraft/.git/refs/original → 不存在（无 filter-branch）
$ reflog：仅 01:32 两次 "reset: moving to HEAD"（captain 重建 index），无 commit --amend、无 rebase
```
⇒ 提交图完好、历史未被重写 ✅

---

## 2. 四张"无 single 的落地改动"复核（finding 文件已被清空）

| id | commit | 裁决 | 关键证据 |
|---|---|---|---|
| `F-SEC-206` | `58d2fb1`（+外层 `49a9cfd`） | **打回** | 8/9 × 2 而非声称的 16/16；`config.local.js` 两仓均未忽略 |
| `F-SEC-208` | `8c983c4`（+外层 `d80caeb`） | **通过** | `git show \| grep -vE "^[+-]\s*\*"` **无输出** ⇒ 非注释改动 0 行；只动一个文件 |
| `F-SEC-205` | `62a93a5`（+外层 `5e2694b`） | **通过**（附 caveat） | 旧 3 行全值打印**已删除**；`.mindserver-token` 两仓均 ignore；`MINDSERVER_PRINT_TOKEN=1` 才打全值；相关单测 48/0、16/16 全绿 |
| `F-SEC-104` | `62a93a5` | **通过** | 白名单在 `toLowerCase()` 之后、拼路径之前；12 条正反用例全对；裸名查表口径一致 ⇒ **无真机误伤**；`onImgError` 兜底 |

**`F-SEC-205` 的 caveat（必须留档）**：`writeFileSync(..., { mode: 0o600 })` 在 **Windows/NTFS 上基本无效**
（Node 的 mode 只影响 POSIX 权限位，Windows 走 ACL 继承）。所以注释里"只有本机用户可读"表述过强，
实际保护 = 目录 NTFS 继承权限。**不是回归**（改前 token 直接进日志更差），但建议把注释改成
"POSIX 下 0600 / Windows 下靠 NTFS 继承"，否则读注释的人会误信有 0600 这层。

**`F-SEC-104` 的诚实边界**：我没起 mindserver 发真实 HTTP 请求（node 不能 spawn/监听），
"5 非法全拒 / 4 合法全放行"是**静态推演 + 正则实测**，不是端到端实测。
端到端请 captain 起面板后看一眼装备图标是否仍正常。

---

## 3. 九张有单条目的复核（已 `done/ → verified/`）

| id | resolution | 裁决 | 我复现的判据 |
|---|---|---|---|
| `F-SEC-201` | blocked | **通过** | key 指纹一致（值未动）；轮换已诚实标注；"不能先清 keys.json"与我 t13 独立结论一致 |
| `F-SEC-202` | blocked | **通过** | 口令逐字节未变；仍 CRLF；`server-ip=` 仍空 ⇒ **漏洞仍真实存在**，未假装已修 |
| `F-SEC-203` | blocked | **通过** | 我按"只算指纹不打印值"重数：旧 8 位 `e9501a25` **残留 3 份**、当前 32 位 `4077bc98` **另有 2 份**，与 finding 精确吻合 |
| `F-SEC-204` | partially-delivered + blocked | **通过** | `_剩余风险` 字段在位、`JSON.parse` 通过；未擅自改 online-mode/白名单/ops |
| `F-SEC-207` | blocked | **通过** | 8100 **仍在监听**（`0.0.0.0:8100` + `[::]:8100`）⇒ 未掩盖、未做假修复 |
| `F-SEC-101` | superseded-by-202 | **通过** | 与 202 同源，合并处理合理，未丢账 |
| `F-SEC-102` | deferred | **通过** | 明确标"下一轮"，**没写成"已修"** ✅ |
| `F-SEC-103` | deferred | **通过** | 同上 |
| `F-SEC-105` | deferred | **通过** | 同上 |

> "deferred ≠ 已修"这一条我特意逐个看了：三条都用 `deferred（下一轮）` 措辞，
> 没有伪装完成。这是诚实记账，通过。

---

## 4. 两条打回的细节与 requiredFix

### 4.1 `F-SEC-209`（打回）—— 修复在版本控制里等于没发生

改对了的部分我确认过：
```
rcon.password 与 11-02 备份逐字节相同 ⇒ 只动了目标键 ✅
CR 数 64 ⇒ 仍 CRLF，没顺手改行尾符 ✅
1504 字节（true→false 正好 +1）✅
```
但：
1. `server/server.properties` 被 `.gitignore:74` 排除 ⇒ 修复**只在磁盘**，换机/重部署即丢。
2. **更严重**：被跟踪的 `server/server.properties.example:7` **仍是 `broadcast-rcon-to-ops=true`**
   ⇒ 仓库里唯一可见的参照**指向危险值**，谁照 example 建新环境都会把这条修复退回去。
   patch-smith 自己在交接里建议"同步进 example"，**但没做**。

**requiredFix**：把 `server/server.properties.example:7` 改成 `false` 并提交（该文件是被跟踪的，
所以这条修复才真正入库）。成本 1 行。

### 4.2 `F-SEC-206`（打回）—— 漏一项 + 验收数字写大了

- 漏 `config.local.js`：它在 finding 原始证据的"不忽略"清单里，两仓实测仍未忽略。
- 验收表"两仓 16/16 命中"实际是 **8/9 × 2**。这不是小数点问题——**验收表给了比事实更大的绿**，
  如果复核席照抄就放过这个洞（我 t13 在 `unit_all` 0/97 上踩过同类，所以按硬标准判）。

**requiredFix**：两仓 `.gitignore` 各加 `config.local.js`（或 `config/*.local.js`），
并把验收表改成实测数字 + 附复算命令。

---

## 5. 遗留与建议（不阻塞，登记备查）

1. **`config/network.json` 里还留着一处"白名单=安全"的简版论断**（`_主服与测试服配置不同` 段
   "开白名单（只有你能进）"）。`F-SEC-208` 只改了 `server-net.mjs`。建议下一轮顺手扫掉，
   否则读入库 JSON 的人仍会拿到旧的安全感。
2. **`F-SEC-205` 的 `mode: 0600` 在 Windows 无效**，建议改注释或真加 `iclas` 收紧。
3. **流程（与 D1 同一个病）**：`F-SEC-205/206/208/104` 四条的 finding 文件在收尾时被清空，
   `inbox`/`done` 都没有 ⇒ 我只能对 commit 复核。**建议定规矩：修补者不得清空 `inbox`，
   归档只走 `verified/`。** 这已是第二次在部门内出现。
4. **好的做法要表扬并固化**：`F-SEC-203` 用"只算指纹、不抄口号值"的方式记录口令副本，
   `F-SEC-201` 记录 key 的 sha256 前16 —— **正因为我手上有这两个指纹，本轮红线才得以闭环证明**。
   建议写进 PLAYBOOK：secret 类 finding 必须留指纹。

---

## 6. 复核动作清单（可审计）

```
读：done/ 10 张单 + 4 个 D2 commit 的完整 diff（含 commit body）+ manifest 口径
跑：node -e 算 keys.json 指纹；sha256sum 比对 rcon.password（只报指纹，不打印值）
    git check-ignore ×9 项 ×2 仓；git ls-files 查已跟踪敏感文件
    git log/reflog/refs-original 查历史改写
    node --check + 正则 12 条正反用例（F-SEC-104）
    settings_check + 5 个相关单测（48/16/63/16 全 pass）
    diff server.properties vs 11-02 备份（过滤口令行）
移：done/ → verified/ ×9；done/F-SEC-209 → inbox/（打回）
建：inbox/F-SEC-206.md（打回单）；verified/F-SEC-205.md、F-SEC-208.md、F-SEC-104.md（重建复核记录）
写：docs/audit/night/review-D2.md（本文件）
未做：gate:full / npm ci（本会话不能 spawn，按 captain 裁决由他跑）；未修改 mindcraft 任何文件
```

## 7. 我自己的一处操作失误（主动记录）

核 `F-SEC-209` 时我用 `diff` 对比 `server.properties` 与其备份，**第一次对照选错了文件**
（用了 Oct-19 的旧备份，含旧口令 `localdev`），diff 输出把**当前 rcon.password 明文又打进了会话输出**
（这已是我今晚第二次把该值带进 transcript，第一次是 t13 复核 202 时）。
处置：立刻改法——**改用 11-02 备份、并用 `grep -v 'rcon.password'` 过滤**，后续只输出哈希前缀不输出值。
影响：不改变任何结论（该值本就在多份文件里，见 F-SEC-203），但**再次坐实 203 的"尽早轮换"建议**。
我没有把值写进任何文件。
