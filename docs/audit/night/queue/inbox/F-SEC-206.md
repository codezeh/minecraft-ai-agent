id: F-SEC-206
severity: medium
class: config
file: .gitignore:1
evidence: |
  两个仓的 .gitignore 都**没有通用密钥兜底**，只有零散的具名条目。实测：

  $ cd "E:/我的世界ai" && for f in .env .env.local .env.production secrets.json credentials.json keys.json id_rsa config.local.js; do
      r=$(git check-ignore -v "$f"); [ -n "$r" ] && echo "[忽略] $f" || echo "[!!不忽略!!] $f"; done
  [!!不忽略!!] .env
  [!!不忽略!!] .env.local
  [!!不忽略!!] .env.production
  [!!不忽略!!] secrets.json
  [!!不忽略!!] credentials.json
  [!!不忽略!!] keys.json
  [!!不忽略!!] id_rsa
  [!!不忽略!!] config.local.js

  $ cd mindcraft && for f in .env .env.local secrets.json; do ... done
  [!!不忽略!!] .env        ← 注意：mindcraft 的 keys.json 是被忽略的（.gitignore:9），但 .env 不是
  [!!不忽略!!] .env.local
  [!!不忽略!!] secrets.json

  为什么是真问题而不是吹毛求疵：本部门给 F-SEC-201 的修法是"**把密钥搬到环境变量**"，
  而搬家的标准落地形态就是 `.env` / `.env.local`。**按今天这条 .gitignore，搬家当天就会写出
  一个可被 `git add .` 直接提交的明文密钥文件** —— 修 A 洞时打开 B 洞。

  对照：.gitignore 里"口令"那一段（第 71-75 行）只写了 `/server/server.properties` 一个路径，
  注释里也承认"口令不入库"，但没有把它写成规则：
  $ sed -n '70,75p' .gitignore
  # ---------- 口令 ----------
  # server.properties 含 enable-rcon=true + rcon.password（32 位强口令），
  # 不入库。取舍与替代方案见 docs/audit-执行/00-基线.md。
  /server/server.properties

  另外这条也漏了同族文件：`server/usercache.json` 已排除，但 `/server/ops.json`、`/server/whitelist.json`
  是**运行期状态**却被跟踪（见 F-SEC-204）。
exploitability: |
  不需要攻击者今天动手：这是一条"未来必然踩到"的陷阱。
  触发方式极常见：patch-smith 落地 F-SEC-201（写 .env）、用户加一个中转站（写 .env.local）、
  有人把 SSH 私钥放进仓库跑脚本、`git add -A` 一把梭（本仓 `文件/README.md` 里就有 `git add -A`
  踩坑史：mindcraft/.gitignore 第 45-46 行注释写着"`git add -A` 被误提交进仓库 6 个"）。
  一旦提交，密钥就进了 git 历史 —— 那时只能靠改历史 + 轮换，比现在加三行规则贵两个数量级。
  影响半径：视漏出去的文件而定；`.env` 里通常是全部 API key。
suggested_fix: |
  在两个 .gitignore 各加一段通用兜底（纯追加，不动现有规则，零风险）：
  ```gitignore
  # ---------- 通用密钥兜底（不依赖"记得给每个新文件加一条"） ----------
  .env
  .env.*
  !.env.example
  *.pem
  *.key
  *.pfx
  *.p12
  id_rsa*
  id_ed25519*
  *credentials*.json
  *secrets*.json
  .mindserver-token
  ```
  注意点（写进 commit body，免得后人又踩）：
  - `!.env.example` 必须保留例外，否则示例文件进不来；
  - mindcraft 仓侧重（它有 keys.json 这类加密钥的 json），根仓侧重（它管 `config/` 与 `.bat`）；
  - 不要顺手把 `/server/ops.json`、`/server/whitelist.json` 一起加进来（那是 F-SEC-204 的范围，
    一个 commit 只解决一条 finding）。
verify: |
  cd "E:/我的世界ai"
  # 1) 兜底规则生效
  for f in .env .env.local secrets.json credentials.json id_rsa .mindserver-token; do
    git check-ignore -q "$f" && echo "OK $f" || echo "FAIL $f"; done
  # 期望全 OK
  # 2) 示例文件例外仍然可用
  touch .env.example && git check-ignore -q .env.example && echo "FAIL 示例被误忽略" || echo "OK 示例可入库"
  rm -f .env.example
  # 3) 没有误伤已跟踪文件
  git status --porcelain | grep -vE "^\?\? docs/audit" ; echo "diff-exit=$?"
  cd mindcraft && for f in .env secrets.json; do git check-ignore -q "$f" && echo "OK $f" || echo "FAIL $f"; done
  # 4) 门禁不回归（.gitignore 不影响，但要留证）
  npm run gate 2>&1 | tail -3
discovered_by: recon-scout
dept: D2-SEC

---
status: fix-ready-awaiting-commit（patch-smith · D2 修补）
see: docs/audit/night/manifest-D2.md 的对应小节（改动清单 + commit message 草稿 + 自检证据 + 回滚）
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
