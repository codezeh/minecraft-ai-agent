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
