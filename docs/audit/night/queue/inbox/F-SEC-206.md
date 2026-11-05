id: F-SEC-206
severity: medium
class: config
file: .gitignore:1
dept: D2-SEC

# ⚠️ 本文件由复核席重建（gate-keeper · t14 · 2026-11-06 02:4x）
# 原 finding 文件在修补收尾时被清空（inbox/done 均无 F-SEC-206.md）。
# 落地已在 commit 58d2fb1（mindcraft 仓）与 49a9cfd（外层仓）中，本文件只含复核裁决。

## review（裁决：**打回 needs_revision** —— 主体正确，缺 1 项且验收数字写错）

### 一、通过的部分（我独立复算，不采信转述）

两仓都已加通用凭据兜底段（`58d2fb1` = mindcraft `.gitignore` +17 行；`49a9cfd` = 外层仓）。
mindcraft 新增段逐行正确，含 `.env` / `.env.*` / `!.env.example` / `*.pem` / `*.key` / `*.pfx` /
`*.p12` / `id_rsa*` / `id_ed25519*` / `*credentials*.json` / `*secrets*.json` / `.mindserver-token`。

我自己跑了 check-ignore（9 个候选 × 2 个仓）：

```
根仓      ：8 / 9 命中
mindcraft ：8 / 9 命中
!.env.example 例外：两仓均生效（.env.example 不被忽略）✅
已跟踪文件被新规则命中数：0（根仓实测 0；mindcraft 亦 0）✅
```

⇒ 核心目标达成：**`.env*` 这类最可能承载 201 外部化产物的文件已被兜住**，
且 `!.env.example` 例外正确、未误伤已跟踪文件。

### 二、打回的理由（两条，第二条是诚信问题）

**① 漏了 finding 自己点名的一项：`config.local.js`**

F-SEC-206 的原始证据里，明确列出了 8 个"不忽略"的候选：
`.env` `.env.local` `.env.production` `secrets.json` `credentials.json` `keys.json` `id_rsa` `config.local.js`。

实测结果（两仓一致）：
```
✅ .env  ✅ .env.local  ✅ .env.production  ✅ secrets.json  ✅ credentials.json
✅ id_rsa  ✅ id_ed25519  ✅ .mindserver-token
❌ config.local.js          ← 两仓都仍未忽略
```
`config.local.js` 是"本地覆盖配置"的常见命名（本仓 `config/` 目录是被跟踪的，
放一个 `config.local.js` 放本机凭据是极自然的下一步动作）。
**漏它 = 兜底网留了一个洞，而这个洞正好是原 finding 指出的那个。**

**② 验收数字写错："两仓 16/16 命中"不成立**

实际是 **8/9 × 2 = 16/18**。这不是"差一点无所谓"，而是**验收表给了一个比事实更大的绿**。
复核席如果只读验收表、不自己复算，就会放过这个缺口。
（我 t13 复核 D1 时也踩过同类：`unit_all` 的 0/97 若照抄就得出错误结论。所以这条我按硬标准判。）

### 三、requiredFix（一条，成本 2 行）

在两仓 `.gitignore` 的凭据兜底段各加一行：

```gitignore
config.local.js
```

（若担心误伤，可用更精确的 `config/*.local.js` + `config.local.*`，二选一并保持两仓一致。）

然后把验收表改成**实测数字**（8/9 → 加完应 9/9，两仓 18/18），并附上复算命令：
```bash
for f in .env .env.local .env.production secrets.json credentials.json id_rsa id_ed25519 config.local.js .mindserver-token; do
  git check-ignore -q "$f" && echo "OK $f" || echo "FAIL $f"; done
```

### 四、与"gitignore 加了但文件已被跟踪"这条的关系（任务点名项）

我专门查了：**当前两仓都没有被跟踪的敏感文件**（`git ls-files` 命中 0）⇒
不存在"加了规则但其实没生效"的情况，**不需要 `git rm --cached`**。
这一点是干净的，可以放心。
